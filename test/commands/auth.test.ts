import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Website } from '../../src/api/types.js';
import type { ResolvedProfile, StoredProfile } from '../../src/core/index.js';

const state = vi.hoisted(() => ({
  globals: {} as Record<string, unknown>,
  profile: {} as ResolvedProfile,
  stored: {} as Record<string, StoredProfile>,
  websites: [] as Website[],
  rateLimit: undefined as { limit?: number; remaining?: number; reset?: number } | undefined,
  confirmed: true,
  typed: '',
  opened: [] as string[],
  httpConfigured: [] as unknown[],
  saved: [] as Array<{ name: string; input: Record<string, unknown> }>,
  deleted: [] as string[],
  deletedAll: 0,
  defaults: {} as Record<string, unknown>,
}));

vi.mock('../../src/api/client.js', () => ({
  listWebsites: async () => ({ status: 'success', data: state.websites }),
}));

vi.mock('../../src/core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/index.js')>();
  return {
    ...actual,
    configureHttp: (options: unknown) => {
      state.httpConfigured.push(options);
    },
    getGlobalOptions: () => state.globals,
    getLastRateLimit: () => state.rateLimit,
    getProfile: (name: string) => state.stored[name],
    isDebugEnabled: () => false,
    listProfiles: () =>
      Object.keys(state.stored).map((name) => ({ name, current: name === 'default' })),
    openUrl: (url: string) => {
      state.opened.push(url);
      return true;
    },
    profileDefaults: () => state.defaults,
    promptConfirm: async (_message: string, options: { assumeYes?: boolean } = {}) =>
      options.assumeYes === true ? true : state.confirmed,
    promptHidden: async () => state.typed,
    resolveApiUrl: () => ({
      url: 'https://analytics.flowsery.com/analytics/api/v1',
      source: 'default',
    }),
    resolveLanguage: () => undefined,
    resolveProfile: () => state.profile,
    resolveProfileName: () => state.profile.name,
    saveProfile: (name: string, input: Record<string, unknown>) => {
      state.saved.push({ name, input });
      return { type: 'token', ...input } as StoredProfile;
    },
    deleteProfile: (name: string) => {
      state.deleted.push(name);
      return true;
    },
    deleteAllProfiles: () => {
      state.deletedAll = Object.keys(state.stored).length;
      return state.deletedAll;
    },
  };
});

const { initOutput, setInteractive } = await import('../../src/core/index.js');
const { registerAuthCommands, assertTokenShape, describeTokenKind, tokenKindOf } = await import(
  '../../src/commands/auth.js'
);

let stdout = '';
let stderr = '';

function run(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerAuthCommands(program);
  return program.parseAsync(args, { from: 'user' });
}

const website = (id: string, domain: string): Website => ({
  id,
  domain,
  timezone: 'Europe/Berlin',
  currency: 'USD',
  logo: null,
  kpiColorScheme: null,
  kpi: null,
  trackingId: `flid_${id}`,
  apiKeyPrefix: 'flow_abcd',
});

beforeEach(() => {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });

  state.globals = {};
  state.profile = {
    name: 'default',
    token: 'flow_ws_stored9999',
    tokenSource: 'credentials',
    apiUrl: 'https://analytics.flowsery.com/analytics/api/v1',
    defaults: {},
  };
  state.stored = {};
  state.websites = [];
  state.rateLimit = undefined;
  state.confirmed = true;
  state.typed = '';
  state.opened = [];
  state.httpConfigured = [];
  state.saved = [];
  state.deleted = [];
  state.deletedAll = 0;
  state.defaults = {};

  initOutput({ isTTY: true, command: 'test' });
  setInteractive(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tokenKindOf', () => {
  it('reads flow_ws_ as a workspace token and flow_ as a website key', () => {
    expect(tokenKindOf('flow_ws_abc')).toBe('workspace');
    expect(tokenKindOf('flow_abc')).toBe('website');
    expect(describeTokenKind('workspace')).toContain('all websites');
    expect(describeTokenKind('website')).toContain('one website');
  });
});

describe('assertTokenShape', () => {
  it('accepts both Flowsery token kinds', () => {
    expect(() => assertTokenShape('flow_ws_abcdef')).not.toThrow();
    expect(() => assertTokenShape('flow_abcdef')).not.toThrow();
  });

  it('names the product a foreign token belongs to', () => {
    expect(() => assertTokenShape('adaptly_abc123')).toThrowError(/starts with adaptly_/);
    try {
      assertTokenShape('adaptly_abc123');
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(3);
      expect((error as { code: string }).code).toBe('wrong_token_prefix');
      expect((error as Error).message).toContain('flow_ws_');
    }
  });

  it('rejects an OAuth JWT with its own message', () => {
    try {
      assertTokenShape('header.payload.signature');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: string }).code).toBe('unsupported_token');
      expect((error as { exitCode: number }).exitCode).toBe(3);
    }
  });
});

describe('login', () => {
  it('refuses a foreign token before touching the network', async () => {
    state.globals = { token: 'redreplier_abc123' };
    await expect(run(['login'])).rejects.toMatchObject({ exitCode: 3 });
    expect(state.saved).toHaveLength(0);
    expect(state.httpConfigured).toHaveLength(0);
  });

  it('stores the profile and reports the websites the token can see', async () => {
    state.globals = { token: 'flow_ws_ab12cd34ef' };
    state.websites = [website('w_1', 'acme.com'), website('w_2', 'blog.acme.com')];

    await run(['login', '--name', 'personal']);

    expect(state.saved).toEqual([
      {
        name: 'default',
        input: {
          token: 'flow_ws_ab12cd34ef',
          apiUrl: 'https://analytics.flowsery.com/analytics/api/v1',
          label: 'personal',
        },
      },
    ]);
    expect(stdout).toContain('Token valid');
    expect(stdout).toContain('workspace token, all websites');
    expect(stdout).toContain('acme.com, blog.acme.com');
    expect(stdout).not.toContain('flow_ws_ab12cd34ef');
  });

  it('warns that a website key ignores the site selector', async () => {
    state.globals = { token: 'flow_ab12cd34ef' };
    state.websites = [website('w_1', 'acme.com')];

    await run(['login']);

    expect(stdout).toContain('website key, one website');
    expect(stderr).toContain('scoped to one website');
  });

  it('reads the token from a hidden prompt and opens the token page', async () => {
    state.typed = '  flow_ws_typed12345  ';

    await run(['login']);

    expect(state.opened).toEqual(['https://flowsery.com/api-tokens']);
    expect(state.saved[0]?.input.token).toBe('flow_ws_typed12345');
  });

  it('configures the client with the pasted token before verifying it', async () => {
    state.globals = { token: 'flow_ws_ab12cd34ef' };

    await run(['login']);

    expect(state.httpConfigured).toHaveLength(1);
    expect(state.httpConfigured[0]).toMatchObject({
      profile: { name: 'default', token: 'flow_ws_ab12cd34ef', tokenSource: 'flag' },
    });
  });

  it('emits the machine envelope under --json', async () => {
    initOutput({ json: true, command: 'login' });
    state.globals = { token: 'flow_ws_ab12cd34ef' };
    state.websites = [website('w_1', 'acme.com')];

    await run(['login']);

    const payload = JSON.parse(stdout) as {
      ok: boolean;
      command: string;
      data: Record<string, unknown>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe('login');
    expect(payload.data).toMatchObject({
      profile: 'default',
      websites: 1,
      domains: ['acme.com'],
      tokenKind: 'workspace',
    });
    expect(stdout).not.toContain('flow_ws_ab12cd34ef');
  });
});

describe('whoami', () => {
  it('prints the token kind, the websites and the default website', async () => {
    state.profile = { ...state.profile, defaults: { defaultWebsite: 'acme.com' } };
    state.websites = [website('w_1', 'acme.com'), website('w_2', 'blog.acme.com')];
    state.rateLimit = { limit: 600, remaining: 598, reset: 41 };

    await run(['whoami']);

    expect(stdout).toContain('flow_ws_stor…');
    expect(stdout).toContain('workspace token, all websites');
    expect(stdout).toContain('credentials file');
    expect(stdout).toContain('https://analytics.flowsery.com/analytics/api/v1');
    expect(stdout).toContain('acme.com, blog.acme.com');
    expect(stdout).toContain('acme.com  (from config.json)');
    expect(stdout).toContain('598 of 600 requests left this minute');
    expect(stdout).not.toContain('flow_ws_stored9999');
  });

  it('tells a workspace token with no default website what to do', async () => {
    state.websites = [website('w_1', 'acme.com')];

    await run(['whoami']);

    expect(stdout).toContain('unset');
    expect(stdout).toContain('config set defaultWebsite');
  });

  it('leaves the default line out for a website key', async () => {
    state.profile = { ...state.profile, token: 'flow_abcd1234' };
    state.websites = [website('w_1', 'acme.com')];

    await run(['whoami']);

    expect(stdout).toContain('website key, one website');
    expect(stdout).not.toContain('config set defaultWebsite');
  });

  it('carries the rate limit in meta under --json', async () => {
    initOutput({ json: true, command: 'whoami' });
    state.websites = [website('w_1', 'acme.com'), website('w_2', 'blog.acme.com')];
    state.rateLimit = { limit: 600, remaining: 598, reset: 41 };

    await run(['whoami']);

    const payload = JSON.parse(stdout) as {
      data: Record<string, unknown>;
      meta: Record<string, unknown>;
    };
    expect(payload.data).toMatchObject({ websites: 2, domains: ['acme.com', 'blog.acme.com'] });
    expect(payload.meta).toEqual({ rateLimit: { limit: 600, remaining: 598, resetSeconds: 41 } });
  });
});

describe('logout', () => {
  beforeEach(() => {
    state.stored = {
      default: { type: 'token', token: 'flow_ws_a', tokenPrefix: 'flow_ws_a' },
      acme: { type: 'token', token: 'flow_ws_b', tokenPrefix: 'flow_ws_b' },
    };
  });

  it('removes the resolved profile once confirmed', async () => {
    state.confirmed = true;

    await run(['logout']);

    expect(state.deleted).toEqual(['default']);
    expect(stdout).toContain('Removed profile "default"');
    expect(stdout).toContain('revoke it at https://flowsery.com/api-tokens');
  });

  it('removes every profile with --all', async () => {
    state.globals = { yes: true };

    await run(['logout', '--all']);

    expect(state.deletedAll).toBe(2);
    expect(state.deleted).toEqual([]);
  });

  it('keeps everything when the confirmation is declined', async () => {
    state.confirmed = false;

    await run(['logout']);

    expect(state.deleted).toEqual([]);
    expect(stdout).toContain('Nothing removed.');
  });

  it('fails with exit 4 when the profile is unknown', async () => {
    state.profile = { ...state.profile, name: 'ghost' };
    await expect(run(['logout'])).rejects.toMatchObject({ exitCode: 4, code: 'unknown_profile' });
    expect(state.deleted).toEqual([]);
  });

  it('fails with exit 4 when nothing is stored', async () => {
    state.stored = {};
    await expect(run(['logout'])).rejects.toMatchObject({ exitCode: 4, code: 'no_profiles' });
  });
});
