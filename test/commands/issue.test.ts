import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Issue, IssueListQuery, IssueSeverity, IssueStatus } from '../../src/api/types.js';
import type { ResolvedProfile } from '../../src/core/index.js';

const state = vi.hoisted(() => ({
  profile: {} as ResolvedProfile,
  issues: [] as Issue[],
  counts: { open: 0, inProgress: 0, resolved: 0 },
  total: 0,
  listQueries: [] as IssueListQuery[],
  getThrows: undefined as unknown,
  patched: [] as Array<{ id: string; body: unknown; selector: unknown }>,
}));

vi.mock('../../src/api/client.js', () => ({
  listIssues: async (query: IssueListQuery = {}) => {
    state.listQueries.push(query);
    return {
      status: 'success',
      data: state.issues,
      counts: state.counts,
      pagination: { limit: query.limit ?? 100, offset: query.offset ?? 0, total: state.total },
    };
  },
  getIssue: async (id: string) => {
    if (state.getThrows !== undefined) throw state.getThrows;
    const found = state.issues.find((issue) => issue.id === id);
    if (found === undefined) throw new Error(`no issue ${id}`);
    return { status: 'success', data: found };
  },
  updateIssueStatus: async (id: string, body: unknown, selector: unknown) => {
    state.patched.push({ id, body, selector });
    const found = state.issues.find((issue) => issue.id === id) as Issue;
    return { status: 'success', data: { ...found, status: (body as { status: IssueStatus }).status } };
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

const { ApiError, initOutput } = await import('../../src/core/index.js');
const {
  assertNoReportingFlags,
  assertSearch,
  buildIssueListQuery,
  collectSeverity,
  collectStatus,
  issueUrl,
  matchesLocalFilters,
  newTailState,
  normalizeSeverity,
  normalizeSort,
  normalizeStatus,
  registerIssueCommands,
  severityAtLeast,
  tailEvents,
} = await import('../../src/commands/issue.js');
const { resolveSite } = await import('../../src/commands/site.js');

let stdout = '';
let stderr = '';

const issue = (id: string, overrides: Partial<Issue> = {}): Issue => ({
  id,
  websiteId: 'w_1',
  title: `Something broke in ${id}`,
  description: 'It broke.',
  severity: 'high',
  status: 'open',
  sessionsCount: 12,
  firstSeenAt: '2026-09-11T09:02:00.000Z',
  lastSeenAt: '2026-09-18T08:50:00.000Z',
  stepsToReplicate: [],
  occurrences: [],
  sessions: [],
  comments: [],
  ...overrides,
});

const listOptions = (overrides: Record<string, unknown> = {}) =>
  ({
    status: [] as IssueStatus[],
    severity: [] as IssueSeverity[],
    sort: 'severity' as const,
    ...overrides,
  }) as Parameters<typeof buildIssueListQuery>[0];

function run(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerIssueCommands(program);
  return program.parseAsync(args, { from: 'user' });
}

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

  state.profile = {
    name: 'default',
    token: 'flow_ws_abc123',
    tokenSource: 'credentials',
    apiUrl: 'https://analytics.flowsery.com/analytics/api/v1',
    defaults: { defaultWebsite: 'acme.com' },
  };
  state.issues = [];
  state.counts = { open: 0, inProgress: 0, resolved: 0 };
  state.total = 0;
  state.listQueries = [];
  state.getThrows = undefined;
  state.patched = [];

  initOutput({ isTTY: true, command: 'test' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enum normalisation', () => {
  it('accepts every documented value, hyphens included', async () => {
    expect(normalizeStatus('IN-PROGRESS')).toBe('in_progress');
    expect(normalizeStatus('suspended')).toBe('suspended');
    expect(normalizeSeverity('Critical')).toBe('critical');
    expect(normalizeSort('recency')).toBe('recency');
  });

  it('rejects an unknown value with exit 2 and the full list', () => {
    try {
      normalizeStatus('closed');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(2);
      expect((error as { hint?: string }).hint).toBe(
        'valid statuses: open, in_progress, resolved, suspended',
      );
    }
    expect(() => normalizeSeverity('urgent')).toThrowError(/Unknown issue severity/);
    expect(() => normalizeSort('title')).toThrowError(/Unknown sort/);
  });

  it('collects repeated values', () => {
    expect(collectSeverity('critical', collectSeverity('high', []))).toEqual(['high', 'critical']);
    expect(collectStatus('open', [])).toEqual(['open']);
  });
});

describe('assertSearch', () => {
  it('trims, drops an empty search and caps at 200 characters', () => {
    expect(assertSearch('  checkout ')).toBe('checkout');
    expect(assertSearch('   ')).toBeUndefined();
    expect(assertSearch(undefined)).toBeUndefined();
    expect(() => assertSearch('x'.repeat(201))).toThrowError(/at most 200 characters/);
  });
});

describe('assertNoReportingFlags', () => {
  it('rejects the window and filter flags the service silently ignores', () => {
    expect(() => assertNoReportingFlags(listOptions({ from: '2026-09-01' }))).toThrowError(
      /does not accept --from/,
    );
    expect(() => assertNoReportingFlags(listOptions({ filter: 'country=DE' }))).toThrowError(
      /does not accept --filter/,
    );
    try {
      assertNoReportingFlags(listOptions({ from: '2026-09-01', to: 'now' }));
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(2);
      expect((error as Error).message).toContain('--from, --to');
    }
  });

  it('accepts a call with none of them', () => {
    expect(() => assertNoReportingFlags(listOptions())).not.toThrow();
  });
});

describe('buildIssueListQuery', () => {
  it('sends one status and one severity through to the API', async () => {
    const site = await resolveSite({ site: 'acme.com' });

    expect(
      buildIssueListQuery(
        listOptions({ status: ['open'], severity: ['high'], search: 'checkout' }),
        site,
        { limit: 50, offset: 10 },
      ),
    ).toEqual({
      domain: 'acme.com',
      limit: 50,
      offset: 10,
      status: 'open',
      severity: 'high',
      search: 'checkout',
      sort: 'severity',
    });
  });

  it('sends neither when several were given, because the API takes only one', async () => {
    const site = await resolveSite({ site: 'acme.com' });
    const query = buildIssueListQuery(
      listOptions({ severity: ['high', 'critical'], status: ['open', 'in_progress'] }),
      site,
      { limit: 100, offset: 0 },
    );

    expect(query.severity).toBeUndefined();
    expect(query.status).toBeUndefined();
  });

  it('never sends a selector for a website key', async () => {
    state.profile.token = 'flow_abc123';
    const site = await resolveSite({});

    expect(buildIssueListQuery(listOptions(), site, { limit: 100, offset: 0 })).toEqual({
      limit: 100,
      offset: 0,
      sort: 'severity',
    });
  });
});

describe('matchesLocalFilters', () => {
  it('filters on this machine only when several values were given', () => {
    const high = issue('iss_1', { severity: 'high', status: 'open' });

    expect(matchesLocalFilters(high, [], [])).toBe(true);
    expect(matchesLocalFilters(high, [], ['low'])).toBe(true);
    expect(matchesLocalFilters(high, [], ['low', 'medium'])).toBe(false);
    expect(matchesLocalFilters(high, [], ['high', 'critical'])).toBe(true);
    expect(matchesLocalFilters(high, ['resolved', 'suspended'], [])).toBe(false);
  });
});

describe('severityAtLeast', () => {
  it('names one severity exactly and several as a floor', () => {
    expect(severityAtLeast([])).toBe('every severity');
    expect(severityAtLeast(['critical'])).toBe('severity critical');
    expect(severityAtLeast(['critical', 'high'])).toBe('severity ≥ high');
    expect(severityAtLeast(['high', 'critical'])).toBe('severity ≥ high');
  });
});

describe('issueUrl', () => {
  it('points at the dashboard issue page, which --exec hands to FS_URL', () => {
    expect(issueUrl('iss_4f2')).toBe('https://flowsery.com/issues/iss_4f2');
  });
});

describe('issue list', () => {
  it('prints the table, the counts and the sessions column', async () => {
    state.issues = [
      issue('iss_4f2', { severity: 'critical', sessionsCount: 412, title: 'Checkout button does nothing' }),
      issue('iss_91b', { status: 'in_progress', sessionsCount: 88 }),
    ];
    state.counts = { open: 4, inProgress: 1, resolved: 9 };
    state.total = 14;

    await run(['issue', 'list']);

    expect(stdout).toContain('SESSIONS');
    expect(stdout).toContain('412');
    expect(stdout).toContain('Checkout button does nothing');
    expect(stdout).toContain('open 4 · in progress 1 · resolved 9');
    expect(stdout).toContain('2 of 14 issues');
    expect(stderr).toContain('--offset 2');
  });

  it('matches several severities on this machine and says so', async () => {
    state.issues = [
      issue('iss_1', { severity: 'critical' }),
      issue('iss_2', { severity: 'low' }),
      issue('iss_3', { severity: 'high' }),
    ];
    state.total = 3;

    await run(['issue', 'list', '--severity', 'high', '--severity', 'critical']);

    expect(state.listQueries[0].severity).toBeUndefined();
    expect(stdout).toContain('iss_1');
    expect(stdout).toContain('iss_3');
    expect(stdout).not.toContain('iss_2');
    expect(stderr).toContain('matched on this machine');
  });

  it('rejects --from with exit 2 before any request', async () => {
    await expect(run(['issue', 'list', '--from', '2026-09-01'])).rejects.toMatchObject({
      exitCode: 2,
    });
    expect(state.listQueries).toEqual([]);
  });

  it('carries the counts in meta under --json', async () => {
    initOutput({ json: true, command: 'issue.list' });
    state.issues = [issue('iss_1')];
    state.counts = { open: 1, inProgress: 0, resolved: 0 };
    state.total = 1;

    await run(['issue', 'list']);

    const payload = JSON.parse(stdout) as { data: Issue[]; meta: Record<string, unknown> };
    expect(payload.data).toHaveLength(1);
    expect(payload.meta).toMatchObject({
      counts: { open: 1, inProgress: 0, resolved: 0 },
      total: 1,
      hasMore: false,
    });
  });

  it('tells the user where suspended issues went when none matched', async () => {
    state.issues = [];
    await run(['issue', 'list']);

    expect(stdout).toContain('No issues match.');
    expect(stderr).toContain('--status suspended');
  });
});

describe('issue get', () => {
  it('prints the occurrences in order, the sessions and the ticket', async () => {
    state.issues = [
      issue('iss_4f2', {
        severity: 'critical',
        sessionsCount: 412,
        stepsToReplicate: ['Open /checkout', 'Apply a coupon'],
        occurrences: [
          { description: 'No network request follows', atSeconds: 12.9, severity: 'high' },
          { description: 'Click handler throws TypeError', atSeconds: 12.4, severity: 'critical' },
        ],
        sessions: [
          {
            recordingId: 'rec_8a1bbbbbbbbb',
            atSeconds: 12.4,
            recording: {
              id: 'rec_8a1bbbbbbbbb',
              recordingUid: 'uid',
              websiteId: 'w_1',
              visitorUid: 'v_1',
              status: 'ready',
              schemaVersion: 1,
              viewportWidth: 1512,
              viewportHeight: 982,
              startedAt: '2026-09-18T08:00:00.000Z',
              durationMs: 161_000,
              eventCount: 10,
              chunkCount: 1,
              totalBytes: 100,
              errorCount: 1,
              hasClicks: true,
              hasInputs: false,
              hasErrors: true,
              hasRageClicks: false,
            },
          },
        ],
        externalTicketProvider: 'linear',
        externalTicketKey: 'LIN-1204',
        externalTicketUrl: 'https://linear.app/acme/issue/LIN-1204',
        comments: [
          {
            id: 'c_1',
            incidentId: 'iss_4f2',
            authorId: 'u_1',
            authorName: 'Ana',
            body: 'Reproduced on Safari.',
            createdAt: '2026-09-18T08:40:00.000Z',
          },
        ],
      }),
    ];

    await run(['issue', 'get', 'iss_4f2']);

    const clickIndex = stdout.indexOf('Click handler throws TypeError');
    const networkIndex = stdout.indexOf('No network request follows');
    expect(clickIndex).toBeGreaterThan(-1);
    expect(clickIndex).toBeLessThan(networkIndex);
    expect(stdout).toContain('412 sessions');
    expect(stdout).toContain('LIN-1204');
    expect(stdout).toContain('https://linear.app/acme/issue/LIN-1204');
    expect(stdout).toContain('1. Open /checkout');
    expect(stdout).toContain('1512×982');
    expect(stdout).toContain('Reproduced on Safari.');
    expect(stderr).toContain('no browser or OS for a session');
  });

  it('turns a locked issue into exit 9 with the billing URL', async () => {
    state.getThrows = new ApiError({
      status: 403,
      body: { message: 'Upgrade to view this issue' },
    });

    try {
      await run(['issue', 'get', 'iss_4f2']);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(9);
      expect((error as Error).message).toBe('Upgrade to view this issue');
      expect((error as { hint?: string }).hint).toContain('https://flowsery.com/billing');
    }
  });

  it('turns the untranslated key into exit 9 too', async () => {
    state.getThrows = new ApiError({
      status: 403,
      body: { message: 'analytics.errors.issueLocked' },
    });

    await expect(run(['issue', 'get', 'iss_4f2'])).rejects.toMatchObject({ exitCode: 9 });
  });

  it('leaves an ordinary 404 alone', async () => {
    state.getThrows = new ApiError({ status: 404, body: { message: 'Issue not found' } });

    await expect(run(['issue', 'get', 'iss_nope'])).rejects.toMatchObject({ exitCode: 4 });
  });
});

describe('issue status', () => {
  it('puts the selector in the query and the status in the body', async () => {
    state.issues = [issue('iss_4f2')];

    await run(['issue', 'status', 'iss_4f2', 'in-progress']);

    expect(state.patched).toEqual([
      { id: 'iss_4f2', body: { status: 'in_progress' }, selector: { domain: 'acme.com' } },
    ]);
    expect(stdout).toContain('is now in_progress');
  });

  it('refuses an unknown status before the request', async () => {
    await expect(run(['issue', 'status', 'iss_4f2', 'closed'])).rejects.toMatchObject({
      exitCode: 2,
    });
    expect(state.patched).toEqual([]);
  });
});

describe('tailEvents', () => {
  const first = issue('iss_1', { sessionsCount: 400, lastSeenAt: '2026-09-18T09:41:00.000Z' });

  it('reports every issue as new on the first poll', () => {
    const state = newTailState();

    expect(
      tailEvents([first], state, { severities: [], newOnly: false }).map((event) => [
        event.kind,
        event.delta,
      ]),
    ).toEqual([['new', 0]]);
  });

  it('stays quiet while lastSeenAt has not moved', () => {
    const state = newTailState();
    tailEvents([first], state, { severities: [], newOnly: false });

    expect(tailEvents([first], state, { severities: [], newOnly: false })).toEqual([]);
  });

  it('reports a recurrence with the session delta when lastSeenAt moves', () => {
    const state = newTailState();
    tailEvents([first], state, { severities: [], newOnly: false });

    const again = { ...first, sessionsCount: 412, lastSeenAt: '2026-09-18T09:43:00.000Z' };
    expect(
      tailEvents([again], state, { severities: [], newOnly: false }).map((event) => [
        event.kind,
        event.delta,
      ]),
    ).toEqual([['recurred', 12]]);
  });

  it('skips recurrences under --new-only but still reports a fresh id', () => {
    const state = newTailState();
    tailEvents([first], state, { severities: [], newOnly: true });

    const again = { ...first, lastSeenAt: '2026-09-18T09:43:00.000Z' };
    const fresh = issue('iss_2');

    expect(
      tailEvents([again, fresh], state, { severities: [], newOnly: true }).map(
        (event) => event.issue.id,
      ),
    ).toEqual(['iss_2']);
  });

  it('drops severities outside the requested set only when several were given', () => {
    const low = issue('iss_low', { severity: 'low' });
    const critical = issue('iss_crit', { severity: 'critical' });

    expect(
      tailEvents([low, critical], newTailState(), {
        severities: ['high', 'critical'],
        newOnly: false,
      }).map((event) => event.issue.id),
    ).toEqual(['iss_crit']);

    expect(
      tailEvents([low, critical], newTailState(), { severities: ['critical'], newOnly: false }),
    ).toHaveLength(2);
  });
});

describe('issue tail', () => {
  it('refuses an interval below the poll floor', async () => {
    await expect(run(['issue', 'tail', '--interval', '1'])).rejects.toMatchObject({ exitCode: 2 });
    expect(state.listQueries).toEqual([]);
  });

  it('registers the flags section E.7 specifies', () => {
    const program = new Command();
    registerIssueCommands(program);
    const issues = program.commands.find((command) => command.name() === 'issue') as Command;
    const tail = issues.commands.find((command) => command.name() === 'tail') as Command;

    expect(tail.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--site', '--severity', '--interval', '--exec', '--new-only']),
    );
    expect(tail.opts().interval).toBe('120');
  });
});
