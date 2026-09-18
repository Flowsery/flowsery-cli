import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_KEYS,
  productConfigKeys,
  PRODUCT,
  configDir,
  configPath,
  getConfigValue,
  listConfigValues,
  readConfig,
  resolveApiUrl,
  resolveProfile,
  resolveProfileName,
  setConfigValue,
  unsetConfigValue,
} from '../../src/core/config.js';
import { saveProfile } from '../../src/core/credentials.js';

let home: string;
const envKeys = [
  'XDG_CONFIG_HOME',
  'FLOWSERY_API_TOKEN',
  'FLOWSERY_API_KEY',
  'FLOWSERY_API_URL',
  'FLOWSERY_PROFILE',
  'FLOWSERY_WORKSPACE_ID',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), 'fsy-config-'));
  process.env.XDG_CONFIG_HOME = home;
});

afterEach(() => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(home, { recursive: true, force: true });
});

describe('paths', () => {
  it('honours XDG_CONFIG_HOME', () => {
    expect(configDir()).toBe(join(home, PRODUCT.id));
    expect(configPath()).toBe(join(home, PRODUCT.id, 'config.json'));
  });
});

describe('profile name resolution', () => {
  it('prefers the flag, then the env var, then the stored current profile', () => {
    saveProfile('acme', { token: 'flow_ws_2222bbbb' });
    expect(resolveProfileName()).toBe('acme');

    process.env.FLOWSERY_PROFILE = 'from-env';
    expect(resolveProfileName()).toBe('from-env');
    expect(resolveProfileName({ profile: 'from-flag' })).toBe('from-flag');
  });

  it('falls back to default with no credentials file', () => {
    expect(resolveProfileName()).toBe('default');
  });
});

describe('resolveProfile', () => {
  it('applies the token precedence from --token down to the file', () => {
    saveProfile('default', { token: 'flow_ws_file0000' });

    expect(resolveProfile().tokenSource).toBe('credentials');
    expect(resolveProfile().token).toBe('flow_ws_file0000');

    process.env.FLOWSERY_API_KEY = 'flow_ws_key00000';
    expect(resolveProfile()).toMatchObject({ token: 'flow_ws_key00000', tokenSource: 'env-key' });

    process.env.FLOWSERY_API_TOKEN = 'flow_ws_tok00000';
    expect(resolveProfile()).toMatchObject({ token: 'flow_ws_tok00000', tokenSource: 'env-token' });

    expect(resolveProfile({ token: 'flow_ws_flag0000' })).toMatchObject({
      token: 'flow_ws_flag0000',
      tokenSource: 'flag',
    });
  });

  it('returns only the documented fields', () => {
    saveProfile('default', { token: 'flow_ws_file0000' });
    expect(Object.keys(resolveProfile()).sort()).toEqual(['apiUrl', 'defaults', 'name', 'token', 'tokenSource']);
  });

  it('fails with exit 3 when no token can be found', () => {
    try {
      resolveProfile();
      expect.unreachable('resolveProfile should have thrown');
    } catch (error) {
      const failure = error as Error & { exitCode?: number; hint?: string };
      expect(failure.exitCode).toBe(3);
      expect(failure.hint).toContain('login');
    }
  });

  it('applies the base URL precedence and carries per-profile defaults', () => {
    saveProfile('default', { token: 'flow_ws_file0000', apiUrl: 'https://stored.test/api/v1' });
    setConfigValue('defaultWebsite', 'acme.com');

    expect(resolveProfile().apiUrl).toBe('https://stored.test/api/v1');
    expect(resolveProfile().defaults.defaultWebsite).toBe('acme.com');

    process.env.FLOWSERY_API_URL = 'https://env.test/api/v1/';
    expect(resolveProfile().apiUrl).toBe('https://env.test/api/v1');
    expect(resolveProfile({ apiUrl: 'https://flag.test/api/v1' }).apiUrl).toBe('https://flag.test/api/v1');
  });

  it('falls back to the compiled-in default base URL', () => {
    expect(resolveApiUrl()).toEqual({ url: PRODUCT.defaultApiUrl, source: 'default' });
  });

  it('rejects a base URL that is not http', () => {
    expect(() => resolveApiUrl({ apiUrl: 'ftp://example.test' })).toThrowError(/http/);
  });

  it('picks up a workspace id from the environment', () => {
    saveProfile('default', { token: 'flow_ws_file0000' });
    process.env.FLOWSERY_WORKSPACE_ID = 'ws_4f21';
    expect(resolveProfile().workspaceId).toBe('ws_4f21');
  });
});

describe('config values', () => {
  it('stores global keys globally and profile keys per profile', () => {
    setConfigValue('updateCheck', 'false');
    setConfigValue('language', 'fr');
    setConfigValue('defaultWebsite', 'acme.com', 'acme');

    const config = readConfig();
    expect(config.updateCheck).toBe(false);
    expect(config.language).toBe('fr');
    expect(config.profiles.acme.defaultWebsite).toBe('acme.com');
    expect(getConfigValue('defaultWebsite', 'acme')).toBe('acme.com');
  });

  it('writes config.json 0644', () => {
    setConfigValue('language', 'en');
    expect(statSync(configPath()).mode & 0o777).toBe(0o644);
  });

  it('rejects unknown keys and bad values with exit 2', () => {
    for (const call of [
      () => setConfigValue('nope', 'x'),
      () => setConfigValue('language', 'klingon'),
      () => setConfigValue('updateCheck', 'maybe'),
      () => setConfigValue('defaultWebsite', '   '),
    ]) {
      try {
        call();
        expect.unreachable('setConfigValue should have thrown');
      } catch (error) {
        expect((error as { exitCode?: number }).exitCode).toBe(2);
      }
    }
  });

  it('unsets a key and reports whether it existed', () => {
    setConfigValue('defaultWebsite', 'acme.com', 'default');
    expect(unsetConfigValue('defaultWebsite', 'default')).toBe(true);
    expect(unsetConfigValue('defaultWebsite', 'default')).toBe(false);
    expect(getConfigValue('defaultWebsite', 'default')).toBeUndefined();
  });

  it('lists every key this product uses for a profile', () => {
    setConfigValue('defaultWebsite', 'acme.com', 'default');
    const listing = listConfigValues('default');
    expect(listing.profile).toBe('default');
    expect(listing.entries).toHaveLength(productConfigKeys().length);
    expect(listing.entries.find((entry) => entry.key === 'defaultWebsite')?.value).toBe('acme.com');
  });

  it('hides keys that belong to a sibling product', () => {
    const listed = listConfigValues('default').entries.map((entry) => entry.key);
    expect(listed).toContain('defaultWebsite');
    expect(listed).not.toContain('defaultSite');
    expect(listed).not.toContain('defaultPlatforms');
    expect(listed).not.toContain('timezone');
    expect(Object.keys(CONFIG_KEYS)).toContain('defaultSite');
  });

  it('rejects a sibling product key as unknown', () => {
    expect(() => getConfigValue('defaultPlatforms', 'default')).toThrow(/Unknown config key/);
    expect(() => setConfigValue('defaultSite', 'ws_4f21', 'default')).toThrow(/Unknown config key/);
    expect(() => setConfigValue('timezone', 'Europe/Berlin', 'default')).toThrow(/Unknown config key/);
  });
});
