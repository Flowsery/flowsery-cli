import type { Command } from 'commander';

import {
  getBreakdown,
  getOverview,
  getRealtime,
  getRealtimeMap,
  getTimeseries,
  listBrowsers,
  listCampaigns,
  listChannels,
  listCities,
  listCountries,
  listDevices,
  listHostnames,
  listOperatingSystems,
  listPages,
  listReferrers,
  listRegions,
} from '../api/client.js';
import {
  ANALYTICS_INTERVALS,
  BREAKDOWN_ALIASES,
  BREAKDOWN_DIMENSIONS,
  type AnalyticsInterval,
  type BreakdownAlias,
  type BreakdownDimension,
  type BreakdownResponse,
  type BreakdownRow,
  type RealtimeMapVisitor,
  type ReportQuery,
  type TimeseriesPoint,
} from '../api/types.js';
import {
  MAX_PAGES,
  PRODUCT,
  dim,
  formatDuration,
  hint,
  isMachine,
  paginateAll,
  print,
  printKeyValues,
  printResult,
  printTable,
  usageError,
  warn,
  yellow,
  type Column,
} from '../core/index.js';
import {
  buildReportQuery,
  count,
  money,
  pagePath,
  pagingFooter,
  percent,
  reportHeader,
  resolvePaging,
  resolveRange,
  resolveSite,
  seconds,
  siteCurrency,
  withProgress,
  withQueryFlags,
  withReportFlags,
  withSite,
  type PageOption,
  type ReportOptions,
  type SiteOption,
} from './site.js';

const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;
const BAR_WIDTH = 8;
const MAP_LIMIT = 1000;
const DEFAULT_MAP_ROWS = 20;

type BreakdownFetch = (reportQuery: ReportQuery) => Promise<BreakdownResponse>;

const ALIAS_ROUTES: Record<BreakdownAlias, { fetch: BreakdownFetch; header: string }> = {
  pages: { fetch: listPages, header: 'PAGE' },
  referrers: { fetch: listReferrers, header: 'REFERRER' },
  channels: { fetch: listChannels, header: 'CHANNEL' },
  campaigns: { fetch: listCampaigns, header: 'CAMPAIGN' },
  hostnames: { fetch: listHostnames, header: 'HOSTNAME' },
  countries: { fetch: listCountries, header: 'COUNTRY' },
  regions: { fetch: listRegions, header: 'REGION' },
  cities: { fetch: listCities, header: 'CITY' },
  devices: { fetch: listDevices, header: 'DEVICE' },
  browsers: { fetch: listBrowsers, header: 'BROWSER' },
  os: { fetch: listOperatingSystems, header: 'OS' },
};

export interface TimeseriesOptions extends ReportOptions {
  interval: AnalyticsInterval;
}

export interface MapOptions extends SiteOption, PageOption {}

export function normalizeInterval(value: string): AnalyticsInterval {
  const interval = value.trim().toLowerCase();
  if (!(ANALYTICS_INTERVALS as readonly string[]).includes(interval)) {
    throw usageError(
      `Unknown interval "${value}".`,
      `valid intervals: ${ANALYTICS_INTERVALS.join(', ')}`,
    );
  }
  return interval as AnalyticsInterval;
}

export interface BreakdownTarget {
  kind: 'alias' | 'dimension';
  name: string;
  header: string;
  fetch: BreakdownFetch;
}

export function resolveBreakdownTarget(value: string): BreakdownTarget {
  const name = value.trim().toLowerCase().replace(/-/g, '_');
  const alias = name.replace(/_/g, '-');

  if ((BREAKDOWN_ALIASES as readonly string[]).includes(alias)) {
    const route = ALIAS_ROUTES[alias as BreakdownAlias];
    return { kind: 'alias', name: alias, header: route.header, fetch: route.fetch };
  }

  if ((BREAKDOWN_DIMENSIONS as readonly string[]).includes(name)) {
    const dimension = name as BreakdownDimension;
    return {
      kind: 'dimension',
      name: dimension,
      header: dimension.replace(/_/g, ' ').toUpperCase(),
      fetch: (reportQuery: ReportQuery) => getBreakdown({ ...reportQuery, dimension }),
    };
  }

  throw usageError(
    `Unknown breakdown "${value}".`,
    `named routes: ${BREAKDOWN_ALIASES.join(', ')}\ndimensions: ${BREAKDOWN_DIMENSIONS.join(', ')}`,
  );
}

export function bar(value: number, max: number, width = BAR_WIDTH): string {
  if (!Number.isFinite(value) || value <= 0 || max <= 0) return '';
  const ratio = Math.min(1, value / max);
  const block = BARS[Math.min(BARS.length - 1, Math.max(0, Math.round(ratio * (BARS.length - 1))))];
  return block.repeat(Math.max(1, Math.round(ratio * width)));
}

export function shareOf(row: BreakdownRow, total: number): number | null {
  if (row.percentage !== undefined && Number.isFinite(row.percentage)) return row.percentage;
  if (total <= 0) return null;
  return Math.round((row.visitors / total) * 10000) / 100;
}

const hasRevenue = (rows: readonly BreakdownRow[]): boolean =>
  rows.some((row) => row.revenue !== undefined && row.revenue !== 0);

const runOverview = async (options: ReportOptions): Promise<void> => {
  const site = await resolveSite(options);
  const range = resolveRange(options);
  const query = buildReportQuery(options, site);
  const response = await withProgress('Loading overview…', () => getOverview(query));
  const overview = response.data[0];

  if (overview === undefined) {
    throw usageError(`The API returned no overview row for "${site.label}".`);
  }

  if (isMachine()) {
    printResult('stats.overview', overview, { ...range });
    return;
  }

  const currency = overview.currency;
  const newRevenue = overview.revenue - overview.renewalRevenue;

  print(reportHeader(site, range));
  print();
  printKeyValues([
    ['Visitors', count(overview.visitors)],
    ['Sessions', count(overview.sessions)],
    ['Bounce rate', percent(overview.bounceRate)],
    ['Avg session', seconds(overview.avgSessionDuration)],
    ['Avg engaged time', seconds(overview.avgEngagedTime)],
  ]);
  print();
  printKeyValues([
    ['Revenue', money(overview.revenue, currency)],
    ['  new', money(newRevenue, currency)],
    ['  renewal', money(overview.renewalRevenue, currency)],
    ['  refunded', money(overview.refundedRevenue, currency)],
    ['Revenue / visitor', money(overview.revenuePerVisitor, currency)],
    ['Conversion rate', percent(overview.conversionRate)],
  ]);

  if (overview.kpiValue !== 0) {
    print();
    print(
      `  KPI  ${count(overview.kpiValue, 2)}  ${dim(
        `(${money(overview.kpiPerVisitor, currency)} / visitor, ${percent(overview.kpiConversionRate)})`,
      )}`,
    );
  }

  hint('new revenue is revenue minus renewal revenue; the API does not send it.');
};

const TIMESERIES_COLUMNS = (currency: string, maxVisitors: number): Column<TimeseriesPoint>[] => [
  { header: 'DATE', value: (point) => point.name },
  { header: 'VISITORS', align: 'right', value: (point) => count(point.visitors) },
  { header: 'SESSIONS', align: 'right', value: (point) => count(point.sessions) },
  { header: 'REVENUE', align: 'right', value: (point) => money(point.revenue, currency) },
  { header: 'CONV', align: 'right', value: (point) => percent(point.conversionRate, 1) },
  { header: '', value: (point) => bar(point.visitors, maxVisitors) },
];

const runTimeseries = async (options: TimeseriesOptions): Promise<void> => {
  if (options.all === true) {
    throw usageError(
      '--all does not apply to stats timeseries.',
      'The API ignores paging here and returns every bucket in the window.',
    );
  }
  if (options.limit !== undefined || options.offset !== undefined) {
    warn('stats timeseries ignores --limit and --offset, and so does the API.');
  }

  const site = await resolveSite(options);
  const range = resolveRange(options);
  const query = buildReportQuery(options, site);
  const response = await withProgress('Loading timeseries…', () =>
    getTimeseries({ ...query, interval: options.interval }),
  );

  if (isMachine()) {
    printResult('stats.timeseries', response.data, {
      interval: response.interval,
      timezone: response.timezone,
      currency: response.currency,
      totals: response.totals,
      total: response.pagination.total,
      limit: response.pagination.limit,
      offset: response.pagination.offset,
      hasMore: false,
    });
    return;
  }

  print(`${reportHeader(site, { ...range, timezone: response.timezone })} · ${response.interval}`);
  print();

  if (response.data.length === 0) {
    print('No data in this window.');
    return;
  }

  const maxVisitors = Math.max(...response.data.map((point) => point.visitors));
  printTable(response.data, TIMESERIES_COLUMNS(response.currency, maxVisitors));
  print();
  printKeyValues([
    ['totals', `${count(response.totals.visitors)} visitors`],
    ['', `${count(response.totals.sessions)} sessions`],
    ['', money(response.totals.revenue, response.currency)],
  ]);
  print();
  print(dim(`${response.data.length} ${response.interval} buckets`));
};

const runRealtime = async (options: SiteOption): Promise<void> => {
  const site = await resolveSite(options);
  const response = await withProgress('Loading realtime…', () => getRealtime(site.selector));
  const visitors = response.data[0]?.visitors ?? 0;

  if (isMachine()) {
    printResult('stats.realtime', response.data[0] ?? { visitors: 0 });
    return;
  }

  print(`${count(visitors)} ${visitors === 1 ? 'visitor' : 'visitors'} on ${site.label} right now`);
  hint('the realtime window is the last five minutes.');
};

const visitorWhere = (visitor: RealtimeMapVisitor): string => {
  const parts = [visitor.city, visitor.countryCode ?? visitor.country].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return parts.length === 0 ? 'Unknown' : parts.join(', ');
};

const visitorSeen = (visitor: RealtimeMapVisitor, now: number): string => {
  if (visitor.sessionStartTime === undefined) return '—';
  const started = new Date(visitor.sessionStartTime).getTime();
  return Number.isNaN(started) ? '—' : formatDuration(Math.max(0, now - started));
};

const MAP_COLUMNS = (currency: string, now: number): Column<RealtimeMapVisitor>[] => [
  { header: 'WHERE', value: (visitor) => visitorWhere(visitor) },
  { header: 'PAGE', value: (visitor) => pagePath(visitor.currentUrl) ?? '—' },
  { header: 'SOURCE', value: (visitor) => visitor.referrerSource ?? visitor.referrer ?? 'Direct' },
  { header: 'SEEN', align: 'right', value: (visitor) => visitorSeen(visitor, now) },
  { header: 'VIEWS', align: 'right', value: (visitor) => count(visitor.pageviews) },
  { header: 'REVENUE', align: 'right', value: (visitor) => money(visitor.totalRevenue, currency) },
  { header: '', value: (visitor) => (visitor.isCustomer ? yellow('★ customer') : '') },
];

const runMap = async (options: MapOptions): Promise<void> => {
  const site = await resolveSite(options);
  const paging = resolvePaging(options, MAP_LIMIT, DEFAULT_MAP_ROWS);
  const response = await withProgress('Loading the realtime map…', () => getRealtimeMap(site.selector));
  const all = response.data;
  const shown = paging.all ? all : all.slice(paging.offset, paging.offset + paging.limit);

  if (isMachine()) {
    printResult('stats.map', shown, {
      total: all.length,
      limit: paging.limit,
      offset: paging.offset,
      hasMore: paging.offset + shown.length < all.length,
    });
    return;
  }

  if (all.length === 0) {
    print(`No visitors on ${site.label} right now.`);
    return;
  }

  const currency = await siteCurrency(site);
  printTable(shown, MAP_COLUMNS(currency, Date.now()));
  print();
  pagingFooter(shown.length, all.length, paging, 'visitors', `${PRODUCT.binName} stats map`);
  hint(`the API caps this endpoint at ${MAP_LIMIT} visitors, most recent first.`);
};

const BREAKDOWN_COLUMNS = (
  header: string,
  total: number,
  currency: string,
  revenue: boolean,
): Column<BreakdownRow>[] => [
  { header, value: (row) => row.value },
  { header: 'VISITORS', align: 'right', value: (row) => count(row.visitors) },
  { header: 'SHARE', align: 'right', value: (row) => percent(shareOf(row, total), 1) },
  ...(revenue
    ? [
        {
          header: 'REVENUE',
          align: 'right' as const,
          value: (row: BreakdownRow) => money(row.revenue ?? 0, currency),
        },
      ]
    : []),
];

const runBreakdown = async (dimension: string, options: ReportOptions): Promise<void> => {
  const target = resolveBreakdownTarget(dimension);
  const site = await resolveSite(options);
  const range = resolveRange(options);
  const base = buildReportQuery(options, site);
  const paging = resolvePaging(options);

  let total = 0;
  let rows: BreakdownRow[];

  if (paging.all) {
    const paged = await paginateAll<BreakdownRow>({
      pageSize: paging.limit,
      offset: paging.offset,
      maxPages: MAX_PAGES,
      fetchPage: async (page) => {
        const response = await withProgress(`Loading ${target.name}…`, () =>
          target.fetch({ ...base, limit: page.limit, offset: page.offset }),
        );
        total = response.pagination.total;
        return { items: response.data, total: response.pagination.total };
      },
    });
    rows = paged.items;
  } else {
    const response = await withProgress(`Loading ${target.name}…`, () =>
      target.fetch({ ...base, limit: paging.limit, offset: paging.offset }),
    );
    total = response.pagination.total;
    rows = response.data;
  }

  if (isMachine()) {
    printResult('breakdown', rows, {
      ...range,
      dimension: target.name,
      total,
      limit: paging.limit,
      offset: paging.offset,
      hasMore: paging.offset + rows.length < total,
    });
    return;
  }

  print(`${reportHeader(site, range)} · ${target.name}`);
  print();

  if (rows.length === 0) {
    print('No rows in this window.');
    return;
  }

  const revenue = hasRevenue(rows);
  const visitorTotal = rows.reduce((sum, row) => sum + row.visitors, 0);
  printTable(
    rows,
    BREAKDOWN_COLUMNS(target.header, visitorTotal, revenue ? await siteCurrency(site) : 'USD', revenue),
  );
  print();
  pagingFooter(rows.length, total, paging, 'rows', `${PRODUCT.binName} breakdown ${target.name}`);
  hint('"Unknown" and "Direct/None" are returned for NULL or empty columns, and work as filter values.');
};

export function registerStatsCommands(program: Command): void {
  const stats = program.command('stats').description('traffic, revenue and realtime figures');

  withQueryFlags(
    stats.command('overview').description('one row of totals for the window'),
  ).action(async (options: ReportOptions) => {
    await runOverview(options);
  });

  withReportFlags(
    stats
      .command('timeseries')
      .alias('series')
      .description('one row per bucket, with a bar per row; --limit and --offset are ignored'),
  )
    .option(
      '--interval <interval>',
      `bucket size: ${ANALYTICS_INTERVALS.join(', ')}`,
      normalizeInterval,
      'day' as AnalyticsInterval,
    )
    .action(async (options: TimeseriesOptions) => {
      await runTimeseries(options);
    });

  withSite(stats.command('realtime').alias('now').description('visitors in the last five minutes')).action(
    async (options: SiteOption) => {
      await runRealtime(options);
    },
  );

  withSite(
    stats
      .command('map')
      .description(`the visitors on the site right now, most recent first, capped at ${MAP_LIMIT}`),
  )
    .option('--limit <n>', `rows to print, 1..${MAP_LIMIT}`)
    .option('--offset <n>', 'rows to skip')
    .option('--all', 'print every visitor the endpoint returned')
    .action(async (options: MapOptions) => {
      await runMap(options);
    });

  withReportFlags(
    program
      .command('breakdown')
      .argument('<dimension>', `one of ${BREAKDOWN_ALIASES.join(', ')} or a dimension name`)
      .description('visitors and revenue grouped by one dimension'),
  ).action(async (dimension: string, options: ReportOptions) => {
    await runBreakdown(dimension, options);
  });
}
