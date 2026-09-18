import type { Command } from 'commander';

import { listWebsites } from '../api/client.js';
import type { Website } from '../api/types.js';
import {
  CliError,
  ExitCode,
  PRODUCT,
  configureHttp,
  credentialsPath,
  deleteAllProfiles,
  deleteProfile,
  describeTokenSource,
  getGlobalOptions,
  getLastRateLimit,
  getProfile,
  hint,
  isDebugEnabled,
  listProfiles,
  openUrl,
  print,
  printKeyValues,
  printResult,
  profileDefaults,
  promptConfirm,
  promptHidden,
  redactToken,
  resolveApiUrl,
  resolveLanguage,
  resolveProfile,
  resolveProfileName,
  saveProfile,
  success,
  warn,
  type GlobalOptions,
} from '../core/index.js';

const WORKSPACE_PREFIX = PRODUCT.tokenPrefixes[0];
const WEBSITE_PREFIX = PRODUCT.tokenPrefixes[1];
const DOMAIN_PREVIEW = 4;

export type TokenKind = 'workspace' | 'website';

export function tokenKindOf(token: string): TokenKind {
  return token.startsWith(WORKSPACE_PREFIX) ? 'workspace' : 'website';
}

export function describeTokenKind(kind: TokenKind): string {
  return kind === 'workspace' ? 'workspace token, all websites' : 'website key, one website';
}

function domainsOf(websites: readonly Website[]): string[] {
  return websites.map((website) => website.domain);
}

function domainPreview(websites: readonly Website[]): string {
  const domains = domainsOf(websites);
  if (domains.length === 0) return '';
  const shown = domains.slice(0, DOMAIN_PREVIEW);
  const rest = domains.length - shown.length;
  return rest > 0 ? `${shown.join(', ')}, +${rest} more` : shown.join(', ');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function assertTokenShape(token: string): void {
  if (PRODUCT.tokenPrefixes.some((prefix) => token.startsWith(prefix))) return;
  if (token.split('.').length === 3) {
    throw new CliError('That looks like an OAuth JWT, not an API token.', {
      exitCode: ExitCode.AUTH,
      code: 'unsupported_token',
      hint: `OAuth login is not supported yet. Create an API token at ${PRODUCT.tokensUrl}`,
    });
  }
  const underscore = token.indexOf('_');
  const seen = underscore > 0 ? token.slice(0, underscore + 1) : '';
  throw new CliError(
    seen
      ? `That token starts with ${seen}. ${PRODUCT.binName} expects ${WORKSPACE_PREFIX} or ${WEBSITE_PREFIX}.`
      : `That does not look like a ${PRODUCT.displayName} token, which starts with ${WORKSPACE_PREFIX} or ${WEBSITE_PREFIX}.`,
    {
      exitCode: ExitCode.AUTH,
      code: 'wrong_token_prefix',
      hint: `Create one at ${PRODUCT.tokensUrl}`,
    },
  );
}

async function collectToken(useStdin: boolean, globals: GlobalOptions): Promise<string> {
  if (useStdin) {
    const piped = (await readStdin()).trim();
    if (piped === '') {
      throw new CliError('Nothing arrived on stdin.', {
        exitCode: ExitCode.USAGE,
        code: 'empty_stdin',
        hint: `echo "$${PRODUCT.envPrefix}_API_TOKEN" | ${PRODUCT.binName} login --token-stdin`,
      });
    }
    return piped;
  }
  if (globals.token && globals.token.trim() !== '') return globals.token.trim();
  return (
    await promptHidden(`Token (starts with ${WORKSPACE_PREFIX})`, {
      hint: `Pass --token-stdin and pipe the token in, or set ${PRODUCT.envPrefix}_API_TOKEN`,
    })
  ).trim();
}

export function registerAuthCommands(program: Command): void {
  program
    .command('login')
    .description(`store a ${PRODUCT.displayName} API token on this machine`)
    .option('--token-stdin', 'read the token from stdin instead of prompting')
    .option('--name <label>', 'human label stored with the profile')
    .action(async (options: { tokenStdin?: boolean; name?: string }) => {
      const globals = getGlobalOptions();
      const name = resolveProfileName();
      const stored = getProfile(name);
      const apiUrl = resolveApiUrl(globals, stored?.apiUrl).url;

      if (!options.tokenStdin && !globals.token) {
        hint(`Opening ${PRODUCT.tokensUrl} in your browser.`);
        hint('Create a token, then paste it here.');
        openUrl(PRODUCT.tokensUrl);
      }

      const token = await collectToken(Boolean(options.tokenStdin), globals);
      assertTokenShape(token);

      const kind = tokenKindOf(token);

      configureHttp({
        profile: { name, token, tokenSource: 'flag', apiUrl, defaults: profileDefaults(name) },
        debug: isDebugEnabled(),
        language: resolveLanguage(),
        quiet: globals.quiet === true,
      });

      const websites = (await listWebsites()).data;

      saveProfile(name, { token, apiUrl, label: options.name }, { makeCurrent: true });

      printResult('login', {
        profile: name,
        apiUrl,
        tokenPrefix: redactToken(token),
        tokenKind: kind,
        label: options.name ?? null,
        websites: websites.length,
        domains: domainsOf(websites),
        credentialsPath: credentialsPath(),
      });

      success('Token valid');
      printKeyValues([
        ['profile', name],
        ...(options.name ? [['label', options.name] as [string, string]] : []),
        ['token', `${redactToken(token)} (${describeTokenKind(kind)})`],
        ['api', apiUrl],
        ['websites', `${websites.length}${websites.length > 0 ? `  (${domainPreview(websites)})` : ''}`],
        ['stored in', `${credentialsPath()} (0600)`],
      ]);

      if (kind === 'website') {
        warn(
          `${WEBSITE_PREFIX} keys are scoped to one website, so --site and defaultWebsite are ignored for this profile.`,
        );
      }
      if (kind === 'workspace' && websites.length > 1) {
        hint(`pick a default: ${PRODUCT.binName} config set defaultWebsite ${websites[0].domain}`);
      }
    });

  program
    .command('logout')
    .description('remove a stored token')
    .option('--all', 'remove every profile')
    .action(async (options: { all?: boolean }) => {
      const globals = getGlobalOptions();
      const profiles = listProfiles();

      if (profiles.length === 0) {
        throw new CliError('There are no stored profiles to remove.', {
          exitCode: ExitCode.NOT_FOUND,
          code: 'no_profiles',
          hint: `${PRODUCT.binName} login`,
        });
      }

      const name = resolveProfileName();
      const targets = options.all ? profiles.map((entry) => entry.name) : [name];

      if (!options.all && !profiles.some((entry) => entry.name === name)) {
        throw new CliError(`No profile named "${name}".`, {
          exitCode: ExitCode.NOT_FOUND,
          code: 'unknown_profile',
          hint: `Stored profiles: ${profiles.map((entry) => entry.name).join(', ')}`,
        });
      }

      const confirmed = await promptConfirm(
        options.all ? `Remove all ${targets.length} profiles?` : `Remove profile "${name}"?`,
        { assumeYes: globals.yes === true, initialValue: false },
      );
      if (!confirmed) {
        print('Nothing removed.');
        return;
      }

      if (options.all) deleteAllProfiles();
      else deleteProfile(name);

      printResult('logout', { removed: targets });
      print(options.all ? `Removed all ${targets.length} profiles.` : `Removed profile "${name}".`);
      print(`The token is still valid, revoke it at ${PRODUCT.tokensUrl}`);
    });

  program
    .command('whoami')
    .description('show which token is in use and what it can see')
    .action(async () => {
      const profile = resolveProfile();
      const kind = tokenKindOf(profile.token);
      const websites = (await listWebsites()).data;
      const rateLimit = getLastRateLimit();
      const preferred =
        typeof profile.defaults.defaultWebsite === 'string' ? profile.defaults.defaultWebsite : undefined;

      printResult(
        'whoami',
        {
          profile: profile.name,
          tokenPrefix: redactToken(profile.token),
          tokenSource: profile.tokenSource,
          tokenKind: kind,
          apiUrl: profile.apiUrl,
          websites: websites.length,
          domains: domainsOf(websites),
          defaultWebsite: preferred ?? null,
        },
        rateLimit?.limit !== undefined && rateLimit.remaining !== undefined
          ? {
              rateLimit: {
                limit: rateLimit.limit,
                remaining: rateLimit.remaining,
                resetSeconds: rateLimit.reset ?? 0,
              },
            }
          : undefined,
      );

      printKeyValues([
        ['profile', profile.name],
        [
          'token',
          `${redactToken(profile.token)} (${describeTokenKind(kind)}, from ${describeTokenSource(profile.tokenSource)})`,
        ],
        ['api', profile.apiUrl],
        [
          'websites',
          `${websites.length}${websites.length > 0 ? `  (${domainPreview(websites)})` : ''}`,
        ],
        ...(kind === 'website'
          ? []
          : [
              [
                'default',
                preferred === undefined
                  ? `unset  (pass --site, or ${PRODUCT.binName} config set defaultWebsite <domain>)`
                  : `${preferred}  (from config.json)`,
              ] as [string, string],
            ]),
        ...(rateLimit?.remaining !== undefined && rateLimit.limit !== undefined
          ? [
              [
                'limits',
                `${rateLimit.remaining} of ${rateLimit.limit} requests left this minute`,
              ] as [string, string],
            ]
          : []),
      ]);
      hint('There is no /me endpoint, so this is read back from the websites the token can see.');
    });
}
