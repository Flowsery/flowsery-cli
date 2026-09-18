import type { Command } from 'commander';
import { statSync } from 'node:fs';

import type { Website } from '../api/types.js';
import {
  ExitCode,
  PRODUCT,
  VERSION,
  compareSemver,
  configDir,
  configPath,
  credentialsExist,
  credentialsMode,
  credentialsPath,
  describeApiUrlSource,
  describeTokenSource,
  dim,
  fetchLatestVersion,
  getGlobalOptions,
  green,
  isMachine,
  print,
  printJson,
  red,
  redactToken,
  resolveApiUrl,
  resolveProfile,
  userAgent,
  yellow,
} from '../core/index.js';
import { describeTokenKind, tokenKindOf } from './auth.js';
import { normalizeSiteValue } from './site.js';

const NODE_FLOOR = '22.12.0';
const MAX_CLOCK_SKEW_SECONDS = 60;
const PING_TIMEOUT_MS = 15_000;
const OPENAPI_TIMEOUT_MS = 10_000;
const DOMAIN_PREVIEW = 4;

type Status = 'pass' | 'warn' | 'fail';

interface Check {
  id: string;
  status: Status;
  detail: string;
  fix: string | null;
}

interface PingResult {
  checks: Check[];
  websites: Website[] | undefined;
}

const check = (id: string, status: Status, detail: string, fix: string | null = null): Check => ({
  id,
  status,
  detail,
  fix,
});

function checkNode(): Check {
  const current = process.versions.node;
  return compareSemver(current, NODE_FLOOR) >= 0
    ? check('node', 'pass', `v${current} (>= ${NODE_FLOOR})`)
    : check(
        'node',
        'fail',
        `v${current} is below ${NODE_FLOOR}`,
        'Install Node 22.12 or newer from https://nodejs.org',
      );
}

async function checkRelease(): Promise<Check> {
  let latest: string | undefined;
  try {
    latest = await fetchLatestVersion();
  } catch {
    return check('cli', 'warn', `${VERSION} (could not reach the npm registry)`);
  }
  if (!latest) return check('cli', 'warn', `${VERSION} (no published release to compare against)`);
  return compareSemver(latest, VERSION) > 0
    ? check('cli', 'warn', `${VERSION} (${latest} is published)`, `npm i -g ${PRODUCT.npmPackage}`)
    : check('cli', 'pass', `${VERSION} (latest)`);
}

function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

function checkConfigDir(): Check {
  const path = configDir();
  const mode = modeOf(path);
  if (mode === undefined) {
    return check('config dir', 'warn', `${path} does not exist yet`, `${PRODUCT.binName} login`);
  }
  const printable = mode.toString(8).padStart(4, '0');
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    return check('config dir', 'warn', `${path} is mode ${printable}`, `chmod 700 ${path}`);
  }
  return check('config dir', 'pass', `${path} (${printable})`);
}

function checkConfigFile(): Check {
  const path = configPath();
  const mode = modeOf(path);
  return mode === undefined
    ? check('config file', 'warn', `${path} does not exist yet`)
    : check('config file', 'pass', `${path} (${mode.toString(8).padStart(4, '0')})`);
}

function checkCredentials(): Check {
  const path = credentialsPath();
  if (!credentialsExist()) {
    return check('credentials', 'warn', `${path} does not exist yet`, `${PRODUCT.binName} login`);
  }
  const mode = credentialsMode() ?? 0;
  const printable = mode.toString(8).padStart(4, '0');
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    return check(
      'credentials',
      'fail',
      `${path} is mode ${printable}, other users can read your token`,
      `chmod 600 ${path}`,
    );
  }
  return check('credentials', 'pass', `${path} (${printable})`);
}

function checkProxy(): Check | null {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = process.env[name];
    if (value) return check('proxy', 'warn', `${name} is set to ${value}`);
  }
  return null;
}

export function websitesFromPayload(body: unknown): Website[] | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  return data.filter(
    (entry): entry is Website =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { domain?: unknown }).domain === 'string',
  );
}

export function checkWebsite(
  preferred: string | undefined,
  kind: 'workspace' | 'website',
  websites: Website[] | undefined,
): Check | null {
  if (kind === 'website') {
    return preferred === undefined
      ? check('website', 'pass', 'the website key selects the website; no default needed')
      : check(
          'website',
          'warn',
          `config defaultWebsite "${preferred}" is ignored, this is a ${PRODUCT.tokenPrefixes[1]} key`,
          `${PRODUCT.binName} config unset defaultWebsite`,
        );
  }

  if (websites === undefined) {
    return preferred === undefined
      ? check('website', 'warn', 'no default website set, and the list could not be read', `${PRODUCT.binName} site list`)
      : check('website', 'warn', `config defaultWebsite "${preferred}" could not be checked`);
  }

  if (preferred === undefined) {
    const preview = websites
      .slice(0, DOMAIN_PREVIEW)
      .map((website) => website.domain)
      .join(', ');
    return check(
      'website',
      'warn',
      `no default website set (${websites.length} available${preview === '' ? '' : `: ${preview}`})`,
      websites.length > 0
        ? `${PRODUCT.binName} config set defaultWebsite ${websites[0].domain}`
        : `${PRODUCT.binName} open dashboard`,
    );
  }

  const needle = normalizeSiteValue(preferred).toLowerCase();
  const found = websites.find(
    (website) => website.domain.toLowerCase() === needle || website.id.toLowerCase() === needle,
  );

  return found === undefined
    ? check(
        'website',
        'fail',
        `config defaultWebsite "${preferred}" is not in this workspace`,
        websites.length > 0
          ? `${PRODUCT.binName} config set defaultWebsite ${websites[0].domain}`
          : `${PRODUCT.binName} site list`,
      )
    : check('website', 'pass', `${found.domain} (${found.timezone}, ${found.currency})`);
}

async function pingApi(apiUrl: string, token: string | undefined): Promise<PingResult> {
  if (!token) {
    return {
      checks: [check('api', 'warn', 'skipped, no token to authenticate with', `${PRODUCT.binName} login`)],
      websites: undefined,
    };
  }

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${PRODUCT.verifyPath}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': userAgent(PRODUCT.id),
      },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      checks: [
        check('api', 'fail', `${apiUrl} unreachable: ${reason}`, 'Check your network, a proxy, or --api-url'),
      ],
      websites: undefined,
    };
  }

  const elapsed = Date.now() - started;
  const checks: Check[] = [];

  if (response.status === 401 || response.status === 403) {
    checks.push(
      check(
        'api',
        'fail',
        `${apiUrl} answered ${response.status}, the token was rejected`,
        `${PRODUCT.binName} login`,
      ),
    );
  } else if (!response.ok) {
    checks.push(check('api', 'fail', `${apiUrl} answered ${response.status}`));
  } else {
    checks.push(check('api', 'pass', `${apiUrl}  ${elapsed} ms`));
  }

  const limit = Number(response.headers.get('ratelimit-limit'));
  const remaining = Number(response.headers.get('ratelimit-remaining'));
  const reset = Number(response.headers.get('ratelimit-reset'));
  if (response.headers.has('ratelimit-limit') && Number.isFinite(limit) && Number.isFinite(remaining)) {
    const resets = Number.isFinite(reset) ? `, resets in ${reset}s` : '';
    checks.push(check('rate limit', remaining <= 20 ? 'warn' : 'pass', `${remaining} of ${limit} left${resets}`));
  } else {
    checks.push(check('rate limit', 'warn', 'the API sent no RateLimit headers'));
  }

  const serverDate = response.headers.get('date');
  if (serverDate) {
    const skew = Math.round((Date.now() - Date.parse(serverDate)) / 1000);
    const size = Math.abs(skew);
    checks.push(
      size > MAX_CLOCK_SKEW_SECONDS
        ? check(
            'clock',
            'fail',
            `this machine is ${size}s ${skew > 0 ? 'ahead of' : 'behind'} the server`,
            'Turn on network time sync on this machine',
          )
        : check('clock', 'pass', `${size}s from the server clock`),
    );
  } else {
    checks.push(check('clock', 'warn', 'the API sent no Date header'));
  }

  let websites: Website[] | undefined;
  if (response.ok) {
    try {
      websites = websitesFromPayload(await response.json());
    } catch {
      websites = undefined;
    }
  } else {
    await response.arrayBuffer().catch(() => undefined);
  }

  if (websites !== undefined) {
    checks.push(
      check('websites', websites.length === 0 ? 'warn' : 'pass', `${websites.length} visible to this token`),
    );
  }

  return { checks, websites };
}

async function checkOpenApi(apiUrl: string): Promise<Check> {
  try {
    const response = await fetch(`${apiUrl}/openapi.json`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(OPENAPI_TIMEOUT_MS),
    });
    if (!response.ok) return check('openapi', 'warn', `answered ${response.status}`);
    const body = (await response.json()) as { info?: { version?: string } };
    return check('openapi', 'pass', `reachable, version ${body.info?.version ?? 'unknown'}`);
  } catch {
    return check('openapi', 'warn', 'not reachable');
  }
}

const GLYPH: Record<Status, string> = { pass: '✓', warn: '⚠', fail: '✗' };

function paint(status: Status, text: string): string {
  if (status === 'pass') return green(text);
  if (status === 'warn') return yellow(text);
  return red(text);
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('check this machine, the config files, the API and the default website')
    .action(async () => {
      const globals = getGlobalOptions();
      const checks: Check[] = [
        checkNode(),
        await checkRelease(),
        checkConfigDir(),
        checkConfigFile(),
        checkCredentials(),
      ];

      let token: string | undefined;
      let apiUrl = resolveApiUrl().url;
      let profileName = 'default';
      let kind: 'workspace' | 'website' = 'workspace';
      let preferred: string | undefined;

      try {
        const profile = resolveProfile();
        token = profile.token;
        apiUrl = profile.apiUrl;
        profileName = profile.name;
        kind = tokenKindOf(profile.token);
        preferred =
          typeof profile.defaults.defaultWebsite === 'string' ? profile.defaults.defaultWebsite : undefined;
        checks.push(
          check(
            'token',
            'pass',
            `${redactToken(profile.token)} ${describeTokenKind(kind)}, from ${describeTokenSource(profile.tokenSource)}`,
          ),
        );
      } catch (error) {
        profileName = globals.profile ?? profileName;
        checks.push(
          check(
            'token',
            'fail',
            error instanceof Error ? error.message : String(error),
            `${PRODUCT.binName} login`,
          ),
        );
      }

      checks.push(check('api url', 'pass', `${apiUrl} (from ${describeApiUrlSource(resolveApiUrl().source)})`));

      const ping = await pingApi(apiUrl, token);
      checks.push(...ping.checks);
      checks.push(await checkOpenApi(apiUrl));

      const proxy = checkProxy();
      if (proxy) checks.push(proxy);

      if (token !== undefined) {
        const website = checkWebsite(preferred, kind, ping.websites);
        if (website) checks.push(website);
      }

      const failures = checks.filter((entry) => entry.status === 'fail');

      if (isMachine()) {
        printJson({
          ok: failures.length === 0,
          command: 'doctor',
          data: { profile: profileName, checks },
        });
        if (failures.length > 0) process.exitCode = ExitCode.GENERIC;
        return;
      }

      const width = Math.max(...checks.map((entry) => entry.id.length));
      for (const entry of checks) {
        print(`  ${paint(entry.status, GLYPH[entry.status])} ${entry.id.padEnd(width)}  ${entry.detail}`);
        if (entry.fix) print(`    ${' '.repeat(width)}  ${dim(`fix: ${entry.fix}`)}`);
      }
      print('');
      print(
        failures.length === 0
          ? 'No problems found.'
          : `${failures.length} ${failures.length === 1 ? 'problem' : 'problems'} found.`,
      );

      if (failures.length > 0) process.exitCode = ExitCode.GENERIC;
    });
}
