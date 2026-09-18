import { Option, type Command } from 'commander';
import { spawn } from 'node:child_process';

import { getIssue, listIssues, updateIssueStatus } from '../api/client.js';
import {
  ISSUE_SEARCH_MAX_LENGTH,
  ISSUE_SEVERITIES,
  ISSUE_SORT_KEYS,
  ISSUE_STATUSES,
  MAX_QUERY_LIMIT,
  type Issue,
  type IssueListQuery,
  type IssueSeverity,
  type IssueSortKey,
  type IssueStatus,
} from '../api/types.js';
import {
  ApiError,
  MAX_PAGES,
  PRODUCT,
  cyan,
  dim,
  formatAbsolute,
  formatDuration,
  formatId,
  formatRelative,
  green,
  hint,
  isMachine,
  paginateAll,
  poll,
  print,
  printKeyValues,
  printResult,
  printTable,
  quotaError,
  red,
  success,
  usageError,
  yellow,
  type Column,
  type Cursor,
} from '../core/index.js';
import {
  count,
  pagingFooter,
  resolvePaging,
  resolveSite,
  withProgress,
  withSite,
  type PageOption,
  type ResolvedSite,
  type SiteOption,
} from './site.js';

const LOCKED = 'Upgrade to view this issue';
const TAIL_INTERVAL_SECONDS = 120;
const TAIL_PAGE_LIMIT = 100;
const BILLING_URL = `${PRODUCT.appUrl}/billing`;

const SEVERITY_ORDER: Record<IssueSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface IssueListOptions extends SiteOption, PageOption {
  status: IssueStatus[];
  severity: IssueSeverity[];
  search?: string;
  sort: IssueSortKey;
  from?: string;
  to?: string;
  filter?: string;
}

export interface IssueTailOptions extends SiteOption {
  severity: IssueSeverity[];
  interval: string;
  exec?: string;
  newOnly?: boolean;
}

export function normalizeStatus(value: string): IssueStatus {
  const status = value.trim().toLowerCase().replace(/-/g, '_');
  if (!(ISSUE_STATUSES as readonly string[]).includes(status)) {
    throw usageError(`Unknown issue status "${value}".`, `valid statuses: ${ISSUE_STATUSES.join(', ')}`);
  }
  return status as IssueStatus;
}

export function normalizeSeverity(value: string): IssueSeverity {
  const severity = value.trim().toLowerCase();
  if (!(ISSUE_SEVERITIES as readonly string[]).includes(severity)) {
    throw usageError(
      `Unknown issue severity "${value}".`,
      `valid severities: ${ISSUE_SEVERITIES.join(', ')}`,
    );
  }
  return severity as IssueSeverity;
}

export function normalizeSort(value: string): IssueSortKey {
  const sort = value.trim().toLowerCase();
  if (!(ISSUE_SORT_KEYS as readonly string[]).includes(sort)) {
    throw usageError(`Unknown sort "${value}".`, `valid keys: ${ISSUE_SORT_KEYS.join(', ')}`);
  }
  return sort as IssueSortKey;
}

export const collectStatus = (value: string, previous: IssueStatus[] = []): IssueStatus[] => [
  ...previous,
  normalizeStatus(value),
];

export const collectSeverity = (value: string, previous: IssueSeverity[] = []): IssueSeverity[] => [
  ...previous,
  normalizeSeverity(value),
];

export function assertSearch(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const search = value.trim();
  if (search === '') return undefined;
  if (search.length > ISSUE_SEARCH_MAX_LENGTH) {
    throw usageError(
      `--search may be at most ${ISSUE_SEARCH_MAX_LENGTH} characters, this one is ${search.length}.`,
    );
  }
  return search;
}

export function assertNoReportingFlags(options: IssueListOptions): void {
  const rejected = [
    options.from === undefined ? undefined : '--from',
    options.to === undefined ? undefined : '--to',
    options.filter === undefined ? undefined : '--filter',
  ].filter((flag): flag is string => flag !== undefined);

  if (rejected.length > 0) {
    throw usageError(
      `issue list does not accept ${rejected.join(', ')}.`,
      'The API declares these params and then ignores them, so a window here would return unfiltered data.',
    );
  }
}

export function buildIssueListQuery(
  options: IssueListOptions,
  site: ResolvedSite,
  page: { limit: number; offset: number },
): IssueListQuery {
  const search = assertSearch(options.search);
  return {
    ...site.selector,
    limit: page.limit,
    offset: page.offset,
    ...(options.status.length === 1 ? { status: options.status[0] } : {}),
    ...(options.severity.length === 1 ? { severity: options.severity[0] } : {}),
    ...(search === undefined ? {} : { search }),
    sort: options.sort,
  };
}

export function matchesLocalFilters(
  issue: Issue,
  statuses: readonly IssueStatus[],
  severities: readonly IssueSeverity[],
): boolean {
  if (statuses.length > 1 && !statuses.includes(issue.status)) return false;
  if (severities.length > 1 && !severities.includes(issue.severity)) return false;
  return true;
}

export function paintSeverity(severity: IssueSeverity): string {
  if (severity === 'critical') return red(severity);
  if (severity === 'high') return yellow(severity);
  return severity;
}

export function severityAtLeast(severities: readonly IssueSeverity[]): string {
  if (severities.length === 0) return 'every severity';
  const lowest = [...severities].sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b]).at(-1);
  return severities.length === 1 ? `severity ${severities[0]}` : `severity ≥ ${lowest}`;
}

export function issueUrl(id: string): string {
  return `${PRODUCT.appUrl}/issues/${id}`;
}

function isLocked(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status !== 402 && error.status !== 403) return false;
  return error.message.includes(LOCKED) || error.message.includes('issueLocked');
}

function relative(iso: string | undefined): string {
  if (iso === undefined) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : formatRelative(date);
}

const LIST_COLUMNS: Column<Issue>[] = [
  { header: 'ID', value: (issue) => formatId(issue.id) },
  { header: 'SEV', value: (issue) => paintSeverity(issue.severity) },
  { header: 'STATUS', value: (issue) => issue.status },
  { header: 'SESSIONS', align: 'right', value: (issue) => count(issue.sessionsCount) },
  { header: 'LAST SEEN', value: (issue) => relative(issue.lastSeenAt) },
  { header: 'TITLE', value: (issue) => issue.title },
];

const runList = async (options: IssueListOptions): Promise<void> => {
  assertNoReportingFlags(options);

  const site = await resolveSite(options);
  const paging = resolvePaging(options);

  let total = 0;
  let counts = { open: 0, inProgress: 0, resolved: 0 };
  let issues: Issue[];

  if (paging.all) {
    const paged = await paginateAll<Issue>({
      pageSize: paging.limit,
      offset: paging.offset,
      maxPages: MAX_PAGES,
      fetchPage: async (page) => {
        const response = await withProgress('Loading issues…', () =>
          listIssues(buildIssueListQuery(options, site, page)),
        );
        total = response.pagination.total;
        counts = response.counts;
        return { items: response.data, total: response.pagination.total };
      },
    });
    issues = paged.items;
  } else {
    const response = await withProgress('Loading issues…', () =>
      listIssues(buildIssueListQuery(options, site, paging)),
    );
    total = response.pagination.total;
    counts = response.counts;
    issues = response.data;
  }

  const matched = issues.filter((issue) =>
    matchesLocalFilters(issue, options.status, options.severity),
  );

  if (isMachine()) {
    printResult('issue.list', matched, {
      counts,
      total,
      limit: paging.limit,
      offset: paging.offset,
      hasMore: paging.offset + issues.length < total,
    });
    return;
  }

  if (matched.length === 0) {
    print('No issues match.');
    hint('suspended issues appear only with --status suspended');
    return;
  }

  printTable(matched, LIST_COLUMNS);
  print();
  print(
    `open ${count(counts.open)} · in progress ${count(counts.inProgress)} · resolved ${count(counts.resolved)}`,
  );
  pagingFooter(matched.length, total, paging, 'issues', `${PRODUCT.binName} issue list`);

  if (matched.length < issues.length) {
    hint('several --status or --severity values are matched on this machine, not by the API.');
  }
  if (!options.status.includes('suspended')) {
    hint('suspended issues appear only with --status suspended');
  }
};

const runGet = async (id: string, options: SiteOption): Promise<void> => {
  const site = await resolveSite(options);

  let issue: Issue;
  try {
    const response = await withProgress('Loading the issue…', () => getIssue(id, site.selector));
    issue = response.data;
  } catch (error) {
    if (isLocked(error)) {
      throw quotaError(LOCKED, `This plan caps how many issues you can open. Upgrade at ${BILLING_URL}`);
    }
    throw error;
  }

  if (issue.title === LOCKED || issue.description === LOCKED) {
    throw quotaError(LOCKED, `This plan caps how many issues you can open. Upgrade at ${BILLING_URL}`);
  }

  if (isMachine()) {
    printResult('issue.get', issue);
    return;
  }

  print(
    `${issue.id} · ${paintSeverity(issue.severity)} · ${issue.status} · ${count(issue.sessionsCount)} sessions`,
  );
  print(issue.title);
  print(
    dim(
      `first seen ${formatAbsolute(new Date(issue.firstSeenAt), { withZone: false })} · last seen ${relative(issue.lastSeenAt)}`,
    ),
  );

  if (issue.externalTicketKey !== undefined) {
    printKeyValues(
      [['ticket', `${issue.externalTicketKey}  ${issue.externalTicketUrl ?? ''}`.trim()]],
      '',
    );
  }

  if (issue.description.trim() !== '') {
    print();
    print(issue.description);
  }

  if (issue.stepsToReplicate.length > 0) {
    print();
    print('steps to replicate');
    issue.stepsToReplicate.forEach((step, index) => {
      print(`  ${index + 1}. ${step}`);
    });
  }

  if (issue.occurrences.length > 0) {
    print();
    print('occurrences');
    for (const occurrence of [...issue.occurrences].sort((a, b) => a.atSeconds - b.atSeconds)) {
      print(
        `  +${occurrence.atSeconds.toFixed(1)}s  ${paintSeverity(occurrence.severity).padEnd(8)}  ${occurrence.description}`,
      );
    }
  }

  if (issue.sessions.length > 0) {
    print();
    print('sessions');
    for (const session of issue.sessions) {
      const recording = session.recording;
      const at = session.atSeconds === undefined ? '' : `+${session.atSeconds.toFixed(1)}s`;
      const duration = recording === undefined ? '' : formatDuration(recording.durationMs);
      const viewport =
        recording?.viewportWidth === undefined || recording.viewportHeight === undefined
          ? ''
          : `${recording.viewportWidth}×${recording.viewportHeight}`;
      print(
        `  ${formatId(session.recordingId).padEnd(14)}${at.padStart(8)}  ${duration.padStart(8)}  ${viewport}`,
      );
    }
    hint('this endpoint sends no browser or OS for a session; open the recording to see them.');
  }

  if (issue.comments.length > 0) {
    print();
    print('comments');
    for (const comment of issue.comments) {
      print(`  ${comment.authorName} · ${relative(comment.createdAt)}`);
      print(`    ${comment.body}`);
    }
  }

  print();
  print(dim(`watch: ${PRODUCT.binName} open issue ${issue.id}`));
};

const runStatus = async (id: string, status: string, options: SiteOption): Promise<void> => {
  const next = normalizeStatus(status);
  const site = await resolveSite(options);
  const response = await withProgress('Updating the issue…', () =>
    updateIssueStatus(id, { status: next }, site.selector),
  );

  if (isMachine()) {
    printResult('issue.status', response.data);
    return;
  }

  success(`${formatId(response.data.id)} is now ${response.data.status}.`);
  hint('there is no delete for an issue; every status change is reversible.');
};

export interface TailEvent {
  issue: Issue;
  kind: 'new' | 'recurred';
  delta: number;
}

export interface TailState {
  lastSeen: Map<string, string>;
  sessions: Map<string, number>;
}

export function newTailState(): TailState {
  return { lastSeen: new Map(), sessions: new Map() };
}

export function tailEvents(
  issues: readonly Issue[],
  state: TailState,
  options: { severities: readonly IssueSeverity[]; newOnly: boolean },
): TailEvent[] {
  const events: TailEvent[] = [];
  for (const issue of issues) {
    if (options.severities.length > 1 && !options.severities.includes(issue.severity)) continue;
    const previous = state.lastSeen.get(issue.id);
    const known = previous !== undefined;
    if (known && options.newOnly) continue;
    if (known && previous === issue.lastSeenAt) continue;

    const delta = issue.sessionsCount - (state.sessions.get(issue.id) ?? issue.sessionsCount);
    state.lastSeen.set(issue.id, issue.lastSeenAt);
    state.sessions.set(issue.id, issue.sessionsCount);
    events.push({ issue, kind: known ? 'recurred' : 'new', delta });
  }
  return events;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function runExec(command: string, event: TailEvent): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        FS_ID: event.issue.id,
        FS_SEVERITY: event.issue.severity,
        FS_STATUS: event.issue.status,
        FS_TITLE: event.issue.title,
        FS_SESSIONS: String(event.issue.sessionsCount),
        FS_URL: issueUrl(event.issue.id),
      },
    });
    child.on('error', (error) => {
      process.stderr.write(`${red('✗')} --exec failed: ${error.message}\n`);
      resolve();
    });
    child.on('close', () => {
      resolve();
    });
  });
}

const runTail = async (options: IssueTailOptions): Promise<void> => {
  const site = await resolveSite(options);
  const intervalSeconds = Number(options.interval);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 5) {
    throw usageError(
      `--interval must be a number of seconds, at least 5, got "${options.interval}".`,
      `Every poll spends from the rate limit; the default is ${TAIL_INTERVAL_SECONDS}s.`,
    );
  }

  const state = newTailState();
  const newOnly = options.newOnly === true;

  if (!isMachine()) {
    print(
      `Tailing ${site.label} issues, ${severityAtLeast(options.severity)}, every ${intervalSeconds}s. Ctrl-C to stop.`,
    );
  }

  await poll<TailEvent>({
    intervalMs: intervalSeconds * 1000,
    maxIntervalMs: Math.max(intervalSeconds * 1000, 5 * 60_000),
    label: 'issue reports',
    sleep,
    key: (event) => (newOnly ? event.issue.id : `${event.issue.id}:${event.issue.lastSeenAt}`),
    fetchPage: async (cursor: Cursor) => {
      const response = await listIssues({
        ...site.selector,
        sort: 'recency',
        limit: TAIL_PAGE_LIMIT,
        ...(options.severity.length === 1 ? { severity: options.severity[0] } : {}),
      });

      const items = tailEvents(response.data, state, { severities: options.severity, newOnly });

      return { items, cursor };
    },
    onItem: async (event) => {
      if (isMachine()) {
        printResult('issue.tail', event.issue, { kind: event.kind, delta: event.delta });
      } else {
        const clock = formatAbsolute(new Date(), { withZone: false }).slice(11);
        const label = event.kind === 'new' ? cyan('NEW     ') : green('RECURRED');
        const sessions =
          event.kind === 'new'
            ? `(${count(event.issue.sessionsCount)} sessions)`
            : `(+${count(event.delta)} sessions)`;
        print(
          `${clock}  ${label}  ${paintSeverity(event.issue.severity).padEnd(8)}  ${formatId(event.issue.id).padEnd(14)}  ${event.issue.title}  ${dim(sessions)}`,
        );
      }
      if (options.exec !== undefined) await runExec(options.exec, event);
    },
  });
};

export function registerIssueCommands(program: Command): void {
  const issue = program
    .command('issue')
    .alias('issues')
    .description('AI-detected session issues');

  withSite(issue.command('list').alias('ls').description('issues for one website'))
    .option('--status <status>', `filter by status, repeatable: ${ISSUE_STATUSES.join(', ')}`, collectStatus, [] as IssueStatus[])
    .option('--severity <severity>', `filter by severity, repeatable: ${ISSUE_SEVERITIES.join(', ')}`, collectSeverity, [] as IssueSeverity[])
    .option('--search <text>', `match the title or description, at most ${ISSUE_SEARCH_MAX_LENGTH} characters`)
    .option('--sort <key>', `order by ${ISSUE_SORT_KEYS.join(' or ')}`, normalizeSort, 'severity' as IssueSortKey)
    .option('--limit <n>', `rows per page, 1..${MAX_QUERY_LIMIT}`)
    .option('--offset <n>', 'rows to skip')
    .option('--all', `page through every issue, up to ${MAX_PAGES} requests`)
    .addOption(new Option('--from <date>', 'not accepted here').hideHelp())
    .addOption(new Option('--to <date>', 'not accepted here').hideHelp())
    .addOption(new Option('-F, --filter <expr>', 'not accepted here').hideHelp())
    .action(async (options: IssueListOptions) => {
      await runList(options);
    });

  withSite(
    issue
      .command('get')
      .alias('view')
      .argument('<id>', 'issue id')
      .description('one issue with its occurrences, sessions, ticket and comments'),
  ).action(async (id: string, options: SiteOption) => {
    await runGet(id, options);
  });

  withSite(
    issue
      .command('status')
      .argument('<id>', 'issue id')
      .argument('<status>', ISSUE_STATUSES.join(' | '))
      .description('move one issue to another status'),
  ).action(async (id: string, status: string, options: SiteOption) => {
    await runStatus(id, status, options);
  });

  withSite(
    issue
      .command('tail')
      .description('follow issues that are new or happening again, and pipe them into a command'),
  )
    .option('--severity <severity>', `report only these severities, repeatable: ${ISSUE_SEVERITIES.join(', ')}`, collectSeverity, [] as IssueSeverity[])
    .option('--interval <seconds>', 'seconds between polls', String(TAIL_INTERVAL_SECONDS))
    .option('--exec <command>', 'run this command per report, with FS_ID, FS_SEVERITY, FS_STATUS, FS_TITLE, FS_SESSIONS and FS_URL set')
    .option('--new-only', 'report only issues seen for the first time in this run')
    .action(async (options: IssueTailOptions) => {
      await runTail(options);
    });
}
