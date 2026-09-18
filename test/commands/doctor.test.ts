import { Command } from 'commander';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedProfile } from '../../src/core/index.js';

const state = vi.hoisted(() => ({
  dir: '',
  profile: undefined as ResolvedProfile | undefined,
  credentialsMode: 0o600,
  credentialsExist: true,
  latest: undefined as string | undefined,
  registryThrows: false,
}));

vi.mock('../../src/core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/index.js')>();
  return {
    ...actual,
    configDir: () => state.dir,
    configPath: () => join(state.dir, 'config.json'),
    credentialsPath: () => join(state.dir, 'credentials.json'),
    credentialsExist: () => state.credentialsExist,
    credentialsMode: () => state.credentialsMode,
    fetchLatestVersion: async () => {
      if (state.registryThrows) throw new Error('offline');
      return state.latest;
    },
    getGlobalOptions: () => ({}),
    resolveApiUrl: () => ({
      url: 'https://analytics.flowsery.com/analytics/api/v1',
      source: 'default',
    }),
    resolveProfile: () => {
      if (!state.profile) {
        throw new actual.CliError('No API token for profile "default"', {
          exitCode: actual.ExitCode.AUTH,
        });
      }
      return state.profile;
    },
  };
});

const { VERSION, initOutput } = await import('../../src/core/index.js');
const { registerDoctorCommand, checkWebsite, websitesFromPayload } = await import(
  '../../src/commands/doctor.js'
);

interface Answers {
  ping?: () => Response;
  openapi?: () => Response;
}

let stdout = '';

const websitePayload = {
  status: 'success',
  data: [
    {
      id: 'w_1',
      domain: 'acme.com',
      timezone: 'Europe/Berlin',
      currency: 'USD',
      logo: null,
      kpiColorScheme: null,
      kpi: null,
      trackingId: 'flid_1',
      apiKeyPrefix: null,
    },
  ],
};

function okPing(headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(websitePayload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'ratelimit-limit': '600',
      'ratelimit-remaining': '599',
      'ratelimit-reset': '41',
      date: new Date().toUTCString(),
      ...headers,
    },
  });
}

function stubFetch(answers: Answers = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/openapi.json')) {
        return answers.openapi
          ? answers.openapi()
          : new Response(JSON.stringify({ info: { version: '1.0.0' } }), { status: 200 });
      }
      return answers.ping ? answers.ping() : okPing();
    }),
  );
}

function run(args: string[] = []): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerDoctorCommand(program);
  return program.parseAsync(['doctor', ...args], { from: 'user' });
}

interface Check {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  fix: string | null;
}

function checks(): Check[] {
  return (JSON.parse(stdout) as { data: { checks: Check[] } }).data.checks;
}

function checkFor(id: string): Check {
  const found = checks().find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`no check called "${id}" in ${checks().map((entry) => entry.id).join(', ')}`);
  }
  return found;
}

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'flowsery-doctor-'));
  chmodSync(state.dir, 0o700);
  writeFileSync(join(state.dir, 'config.json'), '{"version":1}\n', { mode: 0o644 });
  writeFileSync(join(state.dir, 'credentials.json'), '{"version":1}\n', { mode: 0o600 });
  state.profile = {
    name: 'default',
    token: 'flow_ws_ab12cd34',
    tokenSource: 'credentials',
    apiUrl: 'https://analytics.flowsery.com/analytics/api/v1',
    defaults: { defaultWebsite: 'acme.com' },
  };
  state.credentialsMode = 0o600;
  state.credentialsExist = true;
  state.latest = VERSION;
  state.registryThrows = false;

  stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  initOutput({ json: true, command: 'doctor' });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('websitesFromPayload', () => {
  it('reads the enveloped websites array', () => {
    expect(websitesFromPayload(websitePayload)).toHaveLength(1);
  });

  it('returns undefined for anything else', () => {
    expect(websitesFromPayload({ status: 'success' })).toBeUndefined();
    expect(websitesFromPayload('nope')).toBeUndefined();
    expect(websitesFromPayload(null)).toBeUndefined();
  });

  it('drops entries with no domain', () => {
    expect(websitesFromPayload({ data: [{ id: 'w_1' }, websitePayload.data[0]] })).toHaveLength(1);
  });
});

describe('checkWebsite', () => {
  const websites = websitePayload.data;

  it('passes when the default website is in the workspace', () => {
    expect(checkWebsite('acme.com', 'workspace', websites)).toMatchObject({
      status: 'pass',
      detail: 'acme.com (Europe/Berlin, USD)',
    });
  });

  it('fails with a fix when the default website is not in the workspace', () => {
    const result = checkWebsite('old.example.com', 'workspace', websites);
    expect(result).toMatchObject({ status: 'fail' });
    expect(result?.detail).toContain('"old.example.com" is not in this workspace');
    expect(result?.fix).toBe('flowsery config set defaultWebsite acme.com');
  });

  it('accepts a default website written as a URL', () => {
    expect(checkWebsite('https://acme.com/', 'workspace', websites)?.status).toBe('pass');
  });

  it('warns a workspace token with no default website', () => {
    const result = checkWebsite(undefined, 'workspace', websites);
    expect(result).toMatchObject({ status: 'warn' });
    expect(result?.detail).toContain('no default website set');
  });

  it('warns that a website key ignores a default website', () => {
    const result = checkWebsite('acme.com', 'website', websites);
    expect(result).toMatchObject({ status: 'warn', fix: 'flowsery config unset defaultWebsite' });
  });

  it('passes a website key with no default website', () => {
    expect(checkWebsite(undefined, 'website', undefined)?.status).toBe('pass');
  });
});

describe('doctor', () => {
  it('passes every check on a healthy machine and leaves the exit code alone', async () => {
    stubFetch();

    await run();

    expect(checks().some((entry) => entry.status === 'fail')).toBe(false);
    expect(process.exitCode).toBeUndefined();
    expect(checkFor('node').status).toBe('pass');
    expect(checkFor('cli').detail).toContain('latest');
    expect(checkFor('config dir').detail).toContain('0700');
    expect(checkFor('credentials').detail).toContain('0600');
    expect(checkFor('api').detail).toContain('https://analytics.flowsery.com/analytics/api/v1');
    expect(checkFor('rate limit')).toMatchObject({
      status: 'pass',
      detail: '599 of 600 left, resets in 41s',
    });
    expect(checkFor('clock').status).toBe('pass');
    expect(checkFor('openapi').detail).toBe('reachable, version 1.0.0');
    expect(checkFor('websites').detail).toBe('1 visible to this token');
    expect(checkFor('website').status).toBe('pass');
  });

  it('reports the token kind and redacts the token', async () => {
    stubFetch();

    await run();

    expect(stdout).not.toContain('flow_ws_ab12cd34');
    expect(checkFor('token').detail).toContain('flow_ws_ab12…');
    expect(checkFor('token').detail).toContain('workspace token, all websites');
    expect(checkFor('token').detail).toContain('credentials file');
  });

  it('fails when the default website is missing from the workspace', async () => {
    state.profile = { ...state.profile!, defaults: { defaultWebsite: 'old.example.com' } };
    stubFetch();

    await run();

    expect(checkFor('website')).toMatchObject({
      status: 'fail',
      fix: 'flowsery config set defaultWebsite acme.com',
    });
    expect(process.exitCode).toBe(1);
  });

  it('fails and sets exit 1 when the API cannot be reached', async () => {
    stubFetch({
      ping: () => {
        throw new Error('getaddrinfo ENOTFOUND analytics.flowsery.com');
      },
    });

    await run();

    expect(checkFor('api').status).toBe('fail');
    expect(checkFor('api').detail).toContain('ENOTFOUND');
    expect(process.exitCode).toBe(1);
  });

  it('fails when the API rejects the token', async () => {
    stubFetch({ ping: () => new Response('{}', { status: 401 }) });

    await run();

    expect(checkFor('api')).toMatchObject({ status: 'fail', fix: 'flowsery login' });
    expect(process.exitCode).toBe(1);
  });

  it('fails when the credentials file is readable by other users', async () => {
    state.credentialsMode = 0o644;
    stubFetch();

    await run();

    expect(checkFor('credentials').status).toBe('fail');
    expect(checkFor('credentials').fix).toContain('chmod 600');
    expect(process.exitCode).toBe(1);
  });

  it('fails when the machine clock has drifted from the server', async () => {
    stubFetch({ ping: () => okPing({ date: new Date(Date.now() - 15 * 60 * 1000).toUTCString() }) });

    await run();

    expect(checkFor('clock').status).toBe('fail');
    expect(checkFor('clock').detail).toContain('ahead of');
    expect(process.exitCode).toBe(1);
  });

  it('warns without failing when a newer release is published', async () => {
    state.latest = '99.0.0';
    stubFetch();

    await run();

    expect(checkFor('cli')).toMatchObject({ status: 'warn', fix: 'npm i -g @flowsery/cli' });
    expect(checkFor('cli').detail).toContain('99.0.0');
    expect(process.exitCode).toBeUndefined();
  });

  it('warns when the registry cannot be reached', async () => {
    state.registryThrows = true;
    stubFetch();

    await run();

    expect(checkFor('cli')).toMatchObject({ status: 'warn' });
    expect(checkFor('cli').detail).toContain('npm registry');
  });

  it('fails when no token resolves and skips the authenticated ping', async () => {
    state.profile = undefined;
    stubFetch();

    await run();

    expect(checkFor('token')).toMatchObject({ status: 'fail', fix: 'flowsery login' });
    expect(checkFor('api')).toMatchObject({ status: 'warn' });
    expect(checkFor('api').detail).toContain('no token');
    expect(checks().some((entry) => entry.id === 'website')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('warns about a proxy without failing', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://corp:3128');
    stubFetch();

    await run();

    expect(checkFor('proxy')).toMatchObject({ status: 'warn' });
    expect(checkFor('proxy').detail).toContain('http://corp:3128');
    expect(process.exitCode).toBeUndefined();
  });

  it('renders one glyph per check in human mode', async () => {
    initOutput({ isTTY: true, command: 'doctor' });
    stubFetch();

    await run();

    expect(stdout).toContain('✓ node');
    expect(stdout).toContain('No problems found.');
  });
});
