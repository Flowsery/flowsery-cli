import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Website } from '../../src/api/types.js';
import type { ResolvedProfile } from '../../src/core/index.js';

const state = vi.hoisted(() => ({
  profile: {} as ResolvedProfile,
  websites: [] as Website[],
  metadata: [] as Array<Record<string, unknown>>,
  metadataQueries: [] as unknown[],
  metadataThrows: false,
}));

vi.mock('../../src/api/client.js', () => ({
  listWebsites: async () => ({ status: 'success', data: state.websites }),
  getWebsiteMetadata: async (selector: unknown) => {
    state.metadataQueries.push(selector);
    if (state.metadataThrows) throw new Error('offline');
    return { status: 'success', data: state.metadata };
  },
}));

vi.mock('../../src/core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/index.js')>();
  return {
    ...actual,
    resolveProfile: () => state.profile,
    resolveProfileName: () => state.profile.name,
  };
});

const { initOutput } = await import('../../src/core/index.js');
const {
  buildFilterQuery,
  buildReportQuery,
  collectFilter,
  count,
  detectTokenKind,
  findWebsite,
  looksLikeDomain,
  money,
  normalizeSiteValue,
  parseFilterExpression,
  percent,
  rangeLabel,
  registerSiteCommands,
  reportHeader,
  resetSiteMetadata,
  resolvePaging,
  resolveRange,
  resolveSite,
  seconds,
  selectorFor,
  siteCurrency,
  siteMetadata,
} = await import('../../src/commands/site.js');

let stdout = '';

const website = (id: string, domain: string, timezone = 'Europe/Berlin'): Website => ({
  id,
  domain,
  timezone,
  currency: 'USD',
  logo: null,
  kpiColorScheme: null,
  kpi: null,
  trackingId: `flid_${id}`,
  apiKeyPrefix: 'flow_abcd',
});

function run(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSiteCommands(program);
  return program.parseAsync(args, { from: 'user' });
}

beforeEach(() => {
  stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  state.profile = {
    name: 'default',
    token: 'flow_ws_abc123',
    tokenSource: 'credentials',
    apiUrl: 'https://analytics.flowsery.com/analytics/api/v1',
    defaults: {},
  };
  state.websites = [];
  state.metadata = [];
  state.metadataQueries = [];
  state.metadataThrows = false;
  resetSiteMetadata();
  initOutput({ isTTY: true, env: {}, command: 'test' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('detectTokenKind', () => {
  it('splits flow_ws_ from flow_', async () => {
    expect(detectTokenKind('flow_ws_abc')).toBe('workspace');
    expect(detectTokenKind('flow_abc')).toBe('website');
  });

  it('treats an unrecognised token as a workspace token so the selector is still sent', () => {
    expect(detectTokenKind('something_else')).toBe('workspace');
  });
});

describe('normalizeSiteValue', () => {
  it('keeps a bare domain and an id untouched', () => {
    expect(normalizeSiteValue('  acme.com ')).toBe('acme.com');
    expect(normalizeSiteValue('w_8f21')).toBe('w_8f21');
  });

  it('reduces a pasted URL to its hostname', () => {
    expect(normalizeSiteValue('https://acme.com/pricing?a=1')).toBe('acme.com');
  });

  it('strips a trailing slash', () => {
    expect(normalizeSiteValue('acme.com/')).toBe('acme.com');
  });
});

describe('selectorFor', () => {
  it('sends a domain as domain= and an id as websiteId=', () => {
    expect(selectorFor('acme.com')).toEqual({ domain: 'acme.com' });
    expect(selectorFor('blog.acme.com')).toEqual({ domain: 'blog.acme.com' });
    expect(selectorFor('w_8f21aa')).toEqual({ websiteId: 'w_8f21aa' });
    expect(selectorFor('3f1a2b4c-0000-4000-8000-0123456789ab')).toEqual({
      websiteId: '3f1a2b4c-0000-4000-8000-0123456789ab',
    });
  });

  it('does not read a uuid as a domain', () => {
    expect(looksLikeDomain('3f1a2b4c-0000-4000-8000-0123456789ab')).toBe(false);
  });
});

describe('resolveSite', () => {
  it('prefers --site over the configured default', async () => {
    state.profile.defaults = { defaultWebsite: 'blog.acme.com' };

    expect(await resolveSite({ site: 'acme.com' })).toMatchObject({
      kind: 'workspace',
      selector: { domain: 'acme.com' },
      label: 'acme.com',
      source: 'flag',
    });
  });

  it('falls back to config.defaultWebsite', async () => {
    state.profile.defaults = { defaultWebsite: 'blog.acme.com' };

    expect(await resolveSite({})).toMatchObject({
      selector: { domain: 'blog.acme.com' },
      source: 'config',
    });
  });

  it('picks the only website a workspace token can see', async () => {
    state.websites = [website('w_solo', 'solo.com')];

    expect(await resolveSite({})).toMatchObject({
      kind: 'workspace',
      selector: { websiteId: 'w_solo' },
      label: 'solo.com',
      source: 'token',
    });
  });

  it('fails with exit 2 and lists the candidates when several websites exist', async () => {
    state.websites = [website('w_a', 'acme.com'), website('w_b', 'blog.acme.com')];

    try {
      await resolveSite({});
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(2);
      expect((error as Error).message).toBe('No website selected, and this token can see 2.');
      expect((error as { hint?: string }).hint).toContain('config set defaultWebsite acme.com');
      expect((error as { hint?: string }).hint).toContain('acme.com, blog.acme.com');
    }
  });

  it('fails with exit 2 when a workspace token can see no websites', async () => {
    state.websites = [];

    try {
      await resolveSite({});
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(2);
      expect((error as Error).message).toBe('This token can see no websites.');
    }
  });

  it('sends no selector at all for a website key', async () => {
    state.profile.token = 'flow_abc123';
    state.profile.defaults = { defaultWebsite: 'blog.acme.com' };

    expect(await resolveSite({ site: 'acme.com' })).toEqual({
      kind: 'website',
      selector: {},
      label: 'acme.com',
      source: 'flag',
      requested: 'acme.com',
    });
  });

  it('needs no website at all for a website key', async () => {
    state.profile.token = 'flow_abc123';

    expect(await resolveSite({})).toMatchObject({ kind: 'website', selector: {}, source: 'token' });
  });
});

describe('resolveRange', () => {
  it('sends nothing when neither end is given, so the server defaults win', async () => {
    expect(resolveRange({})).toEqual({});
  });

  it('maps --from and --to onto startAt and endAt', () => {
    expect(resolveRange({ from: '2026-08-19', to: '2026-09-18' })).toEqual({
      startAt: '2026-08-19T00:00:00.000Z',
      endAt: '2026-09-18T00:00:00.000Z',
    });
  });

  it('reads a window in the requested timezone', () => {
    expect(resolveRange({ from: '2026-08-19', timezone: 'Europe/Berlin' })).toEqual({
      startAt: '2026-08-18T22:00:00.000Z',
      timezone: 'Europe/Berlin',
    });
  });

  it('rejects a reversed window', () => {
    expect(() => resolveRange({ from: '2026-09-18', to: '2026-08-19' })).toThrowError(
      /--to must not be earlier than --from/,
    );
  });

  it('rejects a timezone that is not IANA', () => {
    expect(() => resolveRange({ timezone: 'Mars/Olympus' })).toThrowError(/not a valid IANA/);
  });
});

describe('resolvePaging', () => {
  it('defaults to 100 rows from offset 0', () => {
    expect(resolvePaging({})).toEqual({ limit: 100, offset: 0, all: false });
  });

  it('raises the page size to the maximum under --all', () => {
    expect(resolvePaging({ all: true })).toEqual({ limit: 1000, offset: 0, all: true });
  });

  it('rejects a limit outside the endpoint bounds', () => {
    expect(() => resolvePaging({ limit: '1001' })).toThrowError(/between 1 and 1000/);
    expect(() => resolvePaging({ limit: '0' })).toThrowError(/between 1 and 1000/);
    expect(() => resolvePaging({ offset: '-1' })).toThrowError(/0 or more/);
  });
});

describe('parseFilterExpression', () => {
  it('maps each operator onto the wire prefix the API parses', () => {
    expect(parseFilterExpression('country=DE')).toEqual({
      name: 'country',
      param: 'filter_country',
      value: 'DE',
    });
    expect(parseFilterExpression('device!=Mobile').value).toBe('!Mobile');
    expect(parseFilterExpression('page~/blog').value).toBe('~/blog');
    expect(parseFilterExpression('page!~/admin').value).toBe('!~/admin');
    expect(parseFilterExpression('country=DE|AT|CH').value).toBe('DE|AT|CH');
  });

  it('rejects an unknown filter name with exit 2 rather than letting the server strip it', () => {
    try {
      parseFilterExpression('countryy=DE');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(2);
      expect((error as Error).message).toBe('Unknown filter "countryy".');
      expect((error as { hint?: string }).hint).toContain('utm_campaign');
    }
  });

  it('rejects an expression with no operator and one with no value', () => {
    expect(() => parseFilterExpression('country')).toThrowError(/expects name=value/);
    expect(() => parseFilterExpression('country=')).toThrowError(/needs a value/);
  });

  it('accepts a value that contains the operator characters', () => {
    expect(parseFilterExpression('page=/a=b').value).toBe('/a=b');
  });
});

describe('buildFilterQuery', () => {
  it('collects every expression into its filter_ param', () => {
    expect(buildFilterQuery(['country=DE|AT', 'page~/blog', 'device!=Mobile'])).toEqual({
      filter_country: 'DE|AT',
      filter_page: '~/blog',
      filter_device: '!Mobile',
    });
  });

  it('refuses the same filter twice, because the API would keep only one', () => {
    expect(() => buildFilterQuery(['country=DE', 'country=AT'])).toThrowError(
      /--filter country was given twice/,
    );
  });

  it('validates eagerly as commander collects', () => {
    expect(collectFilter('country=DE', [])).toEqual(['country=DE']);
    expect(() => collectFilter('nope=DE', [])).toThrowError(/Unknown filter/);
  });
});

describe('buildReportQuery', () => {
  it('merges the selector, the window and the filters', async () => {
    const site = await resolveSite({ site: 'acme.com' });

    expect(
      buildReportQuery({ from: '2026-08-19', timezone: 'UTC', filter: ['country=DE'] }, site),
    ).toEqual({
      domain: 'acme.com',
      startAt: '2026-08-19T00:00:00.000Z',
      timezone: 'UTC',
      filter_country: 'DE',
    });
  });

  it('leaves the selector out for a website key', async () => {
    state.profile.token = 'flow_abc123';
    const site = await resolveSite({});

    expect(buildReportQuery({}, site)).toEqual({});
  });
});

describe('formatting', () => {
  it('groups counts and rounds to the requested digits', async () => {
    expect(count(48210)).toBe('48,210');
    expect(count(1204.004, 2)).toBe('1,204');
    expect(count(null)).toBe('—');
  });

  it('prints money in major units with the returned currency', () => {
    expect(money(18402, 'USD')).toBe('$18,402.00');
    expect(money(310.5, 'EUR')).toBe('€310.50');
    expect(money(1, 'NOTACURRENCY')).toBe('NOTACURRENCY 1.00');
    expect(money(undefined, 'USD')).toBe('—');
  });

  it('prints rates as the API sends them, already out of 100', () => {
    expect(percent(42.1)).toBe('42.10%');
    expect(percent(1.5, 1)).toBe('1.5%');
    expect(percent(null)).toBe('—');
  });

  it('prints a duration in seconds as minutes and seconds', () => {
    expect(seconds(134)).toBe('2m 14s');
    expect(seconds(62)).toBe('1m 2s');
    expect(seconds(120)).toBe('2m');
    expect(seconds(41)).toBe('41s');
    expect(seconds(0)).toBe('0s');
    expect(seconds(3720)).toBe('1h 2m');
  });
});

describe('rangeLabel and reportHeader', () => {
  it('names the server default when no window was asked for', () => {
    expect(rangeLabel({})).toBe('last 30 days');
  });

  it('prints both ends in the resolved timezone', () => {
    expect(
      rangeLabel({
        startAt: '2026-08-19T00:00:00.000Z',
        endAt: '2026-09-18T00:00:00.000Z',
        timezone: 'UTC',
      }),
    ).toBe('2026-08-19 → 2026-09-18');
  });

  it('says now when only the start is pinned', () => {
    expect(rangeLabel({ startAt: '2026-08-19T00:00:00.000Z' })).toBe('2026-08-19 → now');
  });

  it('puts the site, the window and the timezone in the header', async () => {
    const site = await resolveSite({ site: 'acme.com' });
    expect(reportHeader(site, { startAt: '2026-08-19T00:00:00.000Z', timezone: 'Europe/Berlin' })).toBe(
      'acme.com · 2026-08-19 → now · Europe/Berlin',
    );
  });
});

describe('siteMetadata', () => {
  it('asks the API once and caches the answer', async () => {
    state.metadata = [{ domain: 'acme.com', timezone: 'Europe/Berlin', currency: 'EUR', logo: null, kpi: null, kpiColorScheme: null }];
    const site = await resolveSite({ site: 'acme.com' });

    expect(await siteCurrency(site)).toBe('EUR');
    expect((await siteMetadata(site)).timezone).toBe('Europe/Berlin');
    expect(state.metadataQueries).toEqual([{ domain: 'acme.com' }]);
  });

  it('falls back to UTC and USD when the call fails', async () => {
    state.metadataThrows = true;
    const site = await resolveSite({ site: 'acme.com' });

    expect(await siteMetadata(site)).toMatchObject({ timezone: 'UTC', currency: 'USD' });
  });
});

describe('findWebsite', () => {
  it('matches on domain or id, ignoring case and a pasted URL', () => {
    const websites = [website('w_1', 'acme.com'), website('w_2', 'blog.acme.com')];

    expect(findWebsite(websites, 'ACME.COM')?.id).toBe('w_1');
    expect(findWebsite(websites, 'https://blog.acme.com/')?.id).toBe('w_2');
    expect(findWebsite(websites, 'w_2')?.domain).toBe('blog.acme.com');
    expect(findWebsite(websites, 'nope.com')).toBeUndefined();
  });
});

describe('site list', () => {
  it('prints every website with a default line', async () => {
    state.profile.defaults = { defaultWebsite: 'acme.com' };
    state.websites = [website('w_1', 'acme.com'), website('w_2', 'docs.acme.com', 'UTC')];

    await run(['site', 'list']);

    expect(stdout).toContain('DOMAIN');
    expect(stdout).toContain('acme.com');
    expect(stdout).toContain('docs.acme.com');
    expect(stdout).toContain('2 websites · default: acme.com');
  });

  it('points out a default website that is not in the list', async () => {
    state.profile.defaults = { defaultWebsite: 'old.example.com' };
    state.websites = [website('w_1', 'acme.com')];

    await run(['site', 'ls']);

    expect(stdout).toContain('is not in this list');
  });

  it('emits the machine envelope under --json', async () => {
    initOutput({ json: true, command: 'site.list' });
    state.websites = [website('w_1', 'acme.com')];

    await run(['site', 'list']);

    const payload = JSON.parse(stdout) as { data: Website[]; meta: Record<string, unknown> };
    expect(payload.data).toHaveLength(1);
    expect(payload.meta).toMatchObject({ total: 1, hasMore: false });
  });
});

describe('site metadata', () => {
  it('always sends a resolved selector', async () => {
    state.metadata = [
      { domain: 'acme.com', timezone: 'Europe/Berlin', currency: 'USD', logo: null, kpi: 'revenue', kpiColorScheme: null },
    ];

    await run(['site', 'metadata', '--site', 'acme.com']);

    expect(state.metadataQueries).toEqual([{ domain: 'acme.com' }]);
    expect(stdout).toContain('Europe/Berlin');
    expect(stdout).toContain('revenue');
  });

  it('fails before the request when no website resolves', async () => {
    await expect(run(['site', 'metadata'])).rejects.toMatchObject({ exitCode: 2 });
    expect(state.metadataQueries).toEqual([]);
  });
});
