import type { Command } from 'commander';

import {
  getOverview,
  getRealtime,
  getRealtimeMap,
  getVisitorProfile,
  listIssues,
  listReferrers,
} from '../api/client.js';
import type {
  BreakdownRow,
  Issue,
  Overview,
  RealtimeMapVisitor,
  TimelineEntry,
  VisitorProfile,
} from '../api/types.js';
import {
  ExitCode,
  PRODUCT,
  bold,
  dim,
  displayWidth,
  formatAbsolute,
  formatRelative,
  green,
  hint,
  isMachine,
  openUrl,
  parseWhen,
  print,
  printKeyValues,
  printResult,
  printTable,
  red,
  terminalWidth,
  truncate,
  usageError,
  yellow,
  type Column,
} from '../core/index.js';
import {
  count,
  money,
  pagePath,
  percent,
  resolveSite,
  seconds,
  siteMetadata,
  withProgress,
  withSite,
  type ResolvedSite,
  type SiteOption,
} from './site.js';

const REALTIME_TICK_SECONDS = 10;
const TOTALS_TICK_MS = 60_000;
const ISSUES_TICK_MS = 120_000;
const MAP_LIMIT = 1000;
const PANEL_ROWS = 4;
const MIN_INTERVAL_SECONDS = 5;
const MIN_SCREEN_WIDTH = 76;

const ALTERNATE_ON = '\u001b[?1049h';
const ALTERNATE_OFF = '\u001b[?1049l';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const HOME = '\u001b[H';
const CLEAR = '\u001b[2J';

export interface LiveOptions extends SiteOption {
  interval: string;
  compact?: boolean;
}

interface Panel<T> {
  value: T | undefined;
  stale: boolean;
}

interface Dashboard {
  visitors: Panel<number>;
  map: Panel<RealtimeMapVisitor[]>;
  overview: Panel<Overview>;
  referrers: Panel<BreakdownRow[]>;
  issues: Panel<Issue[]>;
}

type PanelName = keyof Dashboard;

const PANEL_NAMES: PanelName[] = ['visitors', 'map', 'overview', 'referrers', 'issues'];

const emptyPanel = <T>(): Panel<T> => ({ value: undefined, stale: false });

export function fit(value: string, width: number): string {
  const text = truncate(value, width);
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

export function groupBy(
  visitors: readonly RealtimeMapVisitor[],
  pick: (visitor: RealtimeMapVisitor) => string | undefined,
): Array<{ label: string; visitors: number }> {
  const tally = new Map<string, number>();
  for (const visitor of visitors) {
    const label = pick(visitor);
    if (label === undefined || label === '') continue;
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([label, total]) => ({ label, visitors: total }))
    .sort((a, b) => b.visitors - a.visitors || a.label.localeCompare(b.label));
}

export function whereOf(visitor: RealtimeMapVisitor): string | undefined {
  const parts = [visitor.city, visitor.countryCode ?? visitor.country].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return parts.length === 0 ? undefined : parts.join(', ');
}

export function paintSeverity(severity: Issue['severity']): string {
  if (severity === 'critical') return red(severity);
  if (severity === 'high') return yellow(severity);
  return severity;
}

async function refresh<T>(panel: Panel<T>, load: () => Promise<T>): Promise<void> {
  try {
    panel.value = await load();
    panel.stale = false;
  } catch {
    panel.stale = true;
  }
}

function leftColumn(board: Dashboard, width: number): string[] {
  const visitors = board.visitors.value ?? 0;
  const map = board.map.value ?? [];
  const rows = ['RIGHT NOW', `  ${count(visitors)} visitors`, '', 'TOP PAGES NOW'];

  const pages = groupBy(map, (visitor) => pagePath(visitor.currentUrl)).slice(0, PANEL_ROWS);
  if (pages.length === 0) rows.push(dim('  no pages'));
  for (const page of pages) rows.push(`  ${fit(page.label, width - 8)}${String(page.visitors).padStart(4)}`);

  rows.push('', 'WHERE');
  const places = groupBy(map, whereOf).slice(0, PANEL_ROWS);
  if (places.length === 0) rows.push(dim('  nowhere yet'));
  for (const place of places) rows.push(`  ${fit(place.label, width - 8)}${String(place.visitors).padStart(4)}`);

  return rows;
}

function rightColumn(board: Dashboard, width: number, currency: string): string[] {
  const overview = board.overview.value;
  const rows = ['TODAY'];

  if (overview === undefined) {
    rows.push(dim('  waiting for /overview'));
  } else {
    rows.push(`  ${fit('Visitors', 12)}${count(overview.visitors).padStart(12)}`);
    rows.push(`  ${fit('Sessions', 12)}${count(overview.sessions).padStart(12)}`);
    rows.push(`  ${fit('Revenue', 12)}${money(overview.revenue, currency).padStart(12)}`);
    rows.push(`  ${fit('Conv rate', 12)}${percent(overview.conversionRate, 1).padStart(12)}`);
  }

  rows.push('', 'TOP REFERRERS TODAY');
  const referrers = (board.referrers.value ?? []).slice(0, PANEL_ROWS);
  if (referrers.length === 0) rows.push(dim('  no referrers'));
  for (const referrer of referrers) {
    rows.push(`  ${fit(referrer.value, width - 12)}${count(referrer.visitors).padStart(8)}`);
  }

  rows.push('', 'OPEN ISSUES');
  const issues = (board.issues.value ?? []).slice(0, PANEL_ROWS);
  if (issues.length === 0) rows.push(dim('  none open'));
  for (const issue of issues) {
    rows.push(
      `  ${fit(paintSeverity(issue.severity), 10)}${fit(issue.title, Math.max(8, width - 22))}${count(issue.sessionsCount).padStart(6)}`,
    );
  }

  return rows;
}

export function renderScreen(site: ResolvedSite, board: Dashboard, currency: string): string[] {
  const width = Math.max(MIN_SCREEN_WIDTH, terminalWidth());
  const half = Math.floor((width - 6) / 2);
  const clock = formatAbsolute(new Date(), { seconds: true, withZone: false }).slice(11);
  const status = `live · ${count(board.visitors.value ?? 0)} visitors · ${clock}`;

  const left = leftColumn(board, half);
  const right = rightColumn(board, half, currency);
  const height = Math.max(left.length, right.length);

  const lines = [`  ${fit(bold(site.label), width - displayWidth(status) - 4)}${dim(status)}`, ''];
  for (let index = 0; index < height; index += 1) {
    lines.push(`  ${fit(left[index] ?? '', half)}  ${right[index] ?? ''}`.replace(/\s+$/, ''));
  }

  const stale = PANEL_NAMES.filter((name) => board[name].stale);
  lines.push('');
  if (stale.length > 0) lines.push(`  ${dim(`stale: ${stale.join(', ')}`)}`);
  lines.push(`  ${dim('q quit · r refresh · o open dashboard')}`);
  return lines;
}

export function renderCompact(site: ResolvedSite, board: Dashboard, currency: string): string {
  const overview = board.overview.value;
  const open = (board.issues.value ?? []).length;
  return [
    site.label,
    `${count(board.visitors.value ?? 0)} now`,
    overview === undefined ? '— today' : `${count(overview.visitors)} today`,
    overview === undefined ? '—' : money(overview.revenue, currency),
    overview === undefined ? '—' : percent(overview.conversionRate, 1),
    `${count(open)} open ${open === 1 ? 'issue' : 'issues'}`,
  ].join(' · ');
}

const runLive = async (options: LiveOptions): Promise<void> => {
  const site = await resolveSite(options);
  const intervalSeconds = Number(options.interval);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS) {
    throw usageError(
      `--interval must be a number of seconds, at least ${MIN_INTERVAL_SECONDS}, got "${options.interval}".`,
      'Every tick spends from the 600 per 60s budget.',
    );
  }

  const metadata = await siteMetadata(site);
  const currency = metadata.currency;
  const timezone = metadata.timezone;

  const board: Dashboard = {
    visitors: emptyPanel<number>(),
    map: emptyPanel<RealtimeMapVisitor[]>(),
    overview: emptyPanel<Overview>(),
    referrers: emptyPanel<BreakdownRow[]>(),
    issues: emptyPanel<Issue[]>(),
  };

  const loadRealtime = async (): Promise<void> => {
    await Promise.all([
      refresh(board.visitors, async () => (await getRealtime(site.selector)).data[0]?.visitors ?? 0),
      refresh(board.map, async () => (await getRealtimeMap(site.selector)).data.slice(0, MAP_LIMIT)),
    ]);
  };

  const loadTotals = async (): Promise<void> => {
    const startAt = parseWhen('today', { timezone }).toISOString();
    const endAt = new Date().toISOString();
    await Promise.all([
      refresh(board.overview, async () => {
        const row = (await getOverview({ ...site.selector, startAt, endAt, timezone })).data[0];
        if (row === undefined) throw new Error('the API sent no overview row');
        return row;
      }),
      refresh(
        board.referrers,
        async () =>
          (await listReferrers({ ...site.selector, startAt, endAt, timezone, limit: 5 })).data,
      ),
    ]);
  };

  const loadIssues = async (): Promise<void> => {
    await refresh(
      board.issues,
      async () =>
        (await listIssues({ ...site.selector, status: 'open', sort: 'severity', limit: 5 })).data,
    );
  };

  await withProgress('Loading the dashboard…', async () => {
    await Promise.all([loadRealtime(), loadTotals(), loadIssues()]);
  });

  if (isMachine()) {
    printResult(
      'live',
      {
        visitors: board.visitors.value ?? 0,
        map: board.map.value ?? [],
        overview: board.overview.value ?? null,
        referrers: board.referrers.value ?? [],
        issues: board.issues.value ?? [],
      },
      { site: site.label, currency, timezone },
    );
    return;
  }

  const compact = options.compact === true;
  const interactive = Boolean(process.stdout.isTTY);
  let running = true;
  let lastTotals = Date.now();
  let lastIssues = Date.now();
  let wake: (() => void) | undefined;

  const draw = (): void => {
    if (compact) {
      process.stdout.write(`\r\u001b[2K${renderCompact(site, board, currency)}`);
      return;
    }
    process.stdout.write(`${HOME}${CLEAR}${renderScreen(site, board, currency).join('\n')}\n`);
  };

  const stop = (): void => {
    running = false;
    wake?.();
  };

  const previousSigint = process.listeners('SIGINT');
  process.removeAllListeners('SIGINT');
  process.on('SIGINT', stop);

  const onResize = (): void => {
    if (running && !compact) draw();
  };
  process.stdout.on('resize', onResize);

  const rawCapable = interactive && process.stdin.isTTY === true;
  const onKey = (chunk: Buffer): void => {
    const key = chunk.toString('utf8');
    if (key === 'q' || key === '') {
      stop();
      return;
    }
    if (key === 'r') {
      void loadRealtime().then(draw);
      return;
    }
    if (key === 'o') openUrl(`${PRODUCT.appUrl}/dashboard`);
  };

  if (!compact && interactive) process.stdout.write(`${ALTERNATE_ON}${HIDE_CURSOR}`);
  if (rawCapable) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKey);
  }

  draw();

  try {
    while (running) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalSeconds * 1000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
      if (!running) break;

      await loadRealtime();
      if (Date.now() - lastTotals >= TOTALS_TICK_MS) {
        await loadTotals();
        lastTotals = Date.now();
      }
      if (Date.now() - lastIssues >= ISSUES_TICK_MS) {
        await loadIssues();
        lastIssues = Date.now();
      }
      if (running) draw();
    }
  } finally {
    process.stdout.removeListener('resize', onResize);
    process.removeListener('SIGINT', stop);
    for (const listener of previousSigint) process.on('SIGINT', listener as () => void);
    if (rawCapable) {
      process.stdin.removeListener('data', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    if (compact) process.stdout.write('\n');
    else if (interactive) process.stdout.write(`${SHOW_CURSOR}${ALTERNATE_OFF}`);
  }

  process.exitCode = ExitCode.OK;
};

const TIMELINE_COLUMNS = (currency: string): Column<TimelineEntry>[] => [
  { header: 'WHEN', value: (entry) => formatRelative(new Date(entry.timestamp)) },
  { header: 'WHAT', value: (entry) => entry.type },
  {
    header: 'DETAIL',
    value: (entry) =>
      entry.type === 'payment' ? money(entry.amount, currency) : (entry.eventName ?? entry.url ?? '—'),
  },
];

const runVisitorGet = async (id: string, options: SiteOption): Promise<void> => {
  const site = await resolveSite(options);
  const response = await withProgress('Loading the visitor…', () =>
    getVisitorProfile(id, site.selector),
  );
  const visitor: VisitorProfile = response.data;

  if (isMachine()) {
    printResult('visitor.get', visitor);
    return;
  }

  const currency = (await siteMetadata(site)).currency;
  const identity = visitor.identity;
  const activity = visitor.activity;

  const place = [identity.city, identity.countryCode ?? identity.country].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  const browser = [identity.browser.name, identity.browser.version].filter(
    (part): part is string => part !== null,
  );
  const os = [identity.os.name, identity.os.version].filter((part): part is string => part !== null);
  const viewport =
    identity.viewport.width === null || identity.viewport.height === null
      ? undefined
      : `${identity.viewport.width}×${identity.viewport.height}`;

  print(
    [
      visitor.visitorId,
      place.length === 0 ? 'Unknown location' : place.join(', '),
      browser.length === 0 ? 'Unknown browser' : browser.join(' '),
      os.length === 0 ? 'Unknown OS' : os.join(' '),
      identity.device.type ?? 'Unknown device',
      viewport,
    ]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join(' · '),
  );
  print();

  const entries: Array<[string, string]> = [
    ['source', visitor.source ?? 'Direct'],
    ['first seen', activity.firstVisitAt === null ? '—' : formatAbsolute(new Date(activity.firstVisitAt))],
    ['last seen', activity.lastVisitAt === null ? '—' : formatRelative(new Date(activity.lastVisitAt))],
    ['sessions', count(activity.visitCount)],
    ['page views', count(activity.pageViewCount)],
    ['current page', activity.currentUrl ?? '—'],
    [
      'revenue',
      `${money(visitor.revenue.totalRevenue, currency)}${visitor.revenue.isCustomer ? green('  customer') : ''}`,
    ],
  ];

  if (visitor.revenue.timeToFirstConversion !== null) {
    entries.push([
      'converted',
      `${seconds(visitor.revenue.timeToFirstConversion)} after the first visit`,
    ]);
  }

  if (visitor.profile !== null) {
    const name = visitor.profile.name ?? visitor.profile.userId ?? '';
    const email = visitor.profile.email;
    const label = email === null ? name : name === '' ? email : `${name} <${email}>`;
    if (label !== '') entries.push(['profile', label]);
  }

  printKeyValues(entries);

  if (visitor.activityTimeline.length > 0) {
    print();
    print('TIMELINE (newest first)');
    printTable(visitor.activityTimeline, TIMELINE_COLUMNS(currency));
  }

  print();
  hint('every sub-list on this endpoint is capped at the 100 most recent events.');
};

export function registerRealtimeCommands(program: Command): void {
  const visitor = program
    .command('visitor')
    .alias('visitors')
    .description('one visitor, their identity, revenue and timeline');

  withSite(
    visitor
      .command('get')
      .alias('view')
      .argument('<id>', 'visitor id')
      .description('the full profile for one visitor'),
  ).action(async (id: string, options: SiteOption) => {
    await runVisitorGet(id, options);
  });

  withSite(program.command('live').description('a refreshing dashboard for one website'))
    .option('--interval <seconds>', 'seconds between realtime ticks', String(REALTIME_TICK_SECONDS))
    .option('--compact', 'print one refreshing line instead of the full screen')
    .action(async (options: LiveOptions) => {
      await runLive(options);
    });
}
