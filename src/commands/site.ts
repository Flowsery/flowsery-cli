import type { Command } from 'commander';

import { getWebsiteMetadata, listWebsites } from '../api/client.js';
import {
  DEFAULT_QUERY_LIMIT,
  FILTER_NAMES,
  MAX_QUERY_LIMIT,
  type FilterName,
  type FilterQuery,
  type ReportQuery,
  type TimeRangeQuery,
  type Website,
  type WebsiteMetadata,
  type WebsiteSelector,
} from '../api/types.js';
import {
  MAX_PAGES,
  PRODUCT,
  assertTimeZone,
  dim,
  formatDate,
  formatId,
  hint,
  isMachine,
  isQuiet,
  parseWhen,
  print,
  printKeyValues,
  printResult,
  printTable,
  resolveProfile,
  spinner,
  usageError,
  validateLimit,
  validateOffset,
  type Column,
} from '../core/index.js';

export type TokenKind = 'workspace' | 'website';

export type SiteSource = 'flag' | 'config' | 'token';

export interface ResolvedSite {
  kind: TokenKind;
  selector: WebsiteSelector;
  label: string;
  source: SiteSource;
  requested?: string;
}

export interface SiteOption {
  site?: string;
}

export interface RangeOption {
  from?: string;
  to?: string;
  timezone?: string;
}

export interface PageOption {
  limit?: string;
  offset?: string;
  all?: boolean;
}

export interface FilterOption {
  filter?: string[];
}

export interface ReportOptions extends SiteOption, RangeOption, PageOption, FilterOption {}

export interface ResolvedPaging {
  limit: number;
  offset: number;
  all: boolean;
}

export interface ParsedFilter {
  name: FilterName;
  param: `filter_${FilterName}`;
  value: string;
}

const DOMAIN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const FILTER_EXPRESSION = /^([a-z][a-z0-9_]*)(!~|!=|~|=)([\s\S]*)$/;
const WORKSPACE_PREFIX = 'flow_ws_';

const counts = new Intl.NumberFormat('en-US');

export function detectTokenKind(token: string): TokenKind {
  if (token.startsWith(WORKSPACE_PREFIX)) return 'workspace';
  return token.startsWith('flow_') ? 'website' : 'workspace';
}

export function normalizeSiteValue(raw: string): string {
  const text = raw.trim();
  if (!SCHEME.test(text)) return text.replace(/\/+$/, '');
  try {
    return new URL(text).hostname;
  } catch {
    return text;
  }
}

export function looksLikeDomain(value: string): boolean {
  return DOMAIN.test(value);
}

export function selectorFor(value: string): WebsiteSelector {
  return looksLikeDomain(value) ? { domain: value } : { websiteId: value };
}

async function soleWebsite(): Promise<Website | undefined> {
  const websites = (await listWebsites()).data;
  if (websites.length === 1) return websites[0];
  if (websites.length === 0) {
    throw usageError(
      'This token can see no websites.',
      `Add one at ${PRODUCT.appUrl}, then run: ${PRODUCT.binName} site list`,
    );
  }
  throw usageError(
    `No website selected, and this token can see ${websites.length}.`,
    `Pass --site <domain>, or run: ${PRODUCT.binName} config set defaultWebsite ${websites[0].domain}` +
      `\nAvailable: ${websites.map((website) => website.domain).join(', ')}`,
  );
}

export async function resolveSite(options: SiteOption = {}): Promise<ResolvedSite> {
  const profile = resolveProfile();
  const kind = detectTokenKind(profile.token);
  const flag = options.site === undefined ? undefined : normalizeSiteValue(options.site);
  const stored =
    typeof profile.defaults.defaultWebsite === 'string'
      ? normalizeSiteValue(profile.defaults.defaultWebsite)
      : undefined;
  const requested = flag !== undefined && flag !== '' ? flag : stored !== '' ? stored : undefined;
  const source: SiteSource = flag !== undefined && flag !== '' ? 'flag' : requested ? 'config' : 'token';

  if (kind === 'website') {
    return {
      kind,
      selector: {},
      label: requested ?? 'this website',
      source: requested ? source : 'token',
      ...(requested ? { requested } : {}),
    };
  }

  if (requested === undefined) {
    const only = await soleWebsite();
    return {
      kind,
      selector: { websiteId: only!.id },
      label: only!.domain,
      source: 'token',
      requested: only!.domain,
    };
  }

  return { kind, selector: selectorFor(requested), label: requested, source, requested };
}

export function resolveRange(options: RangeOption = {}): TimeRangeQuery {
  const timezone = options.timezone === undefined ? undefined : assertTimeZone(options.timezone.trim());
  const now = new Date();
  const zone = timezone ?? 'UTC';
  const startAt = options.from === undefined ? undefined : parseWhen(options.from, { now, timezone: zone });
  const endAt = options.to === undefined ? undefined : parseWhen(options.to, { now, timezone: zone });

  if (startAt !== undefined && endAt !== undefined && startAt.getTime() > endAt.getTime()) {
    throw usageError('--to must not be earlier than --from');
  }

  return {
    ...(startAt === undefined ? {} : { startAt: startAt.toISOString() }),
    ...(endAt === undefined ? {} : { endAt: endAt.toISOString() }),
    ...(timezone === undefined ? {} : { timezone }),
  };
}

export function resolvePaging(
  options: PageOption = {},
  maxLimit = MAX_QUERY_LIMIT,
  defaultLimit = DEFAULT_QUERY_LIMIT,
): ResolvedPaging {
  const all = options.all === true;
  const limit = all
    ? maxLimit
    : options.limit === undefined
      ? Math.min(defaultLimit, maxLimit)
      : validateLimit(options.limit, 1, maxLimit);
  return { limit, offset: validateOffset(options.offset), all };
}

export function parseFilterExpression(expression: string): ParsedFilter {
  const match = FILTER_EXPRESSION.exec(expression.trim());
  if (match === null) {
    throw usageError(
      `--filter expects name=value, got "${expression}".`,
      'Operators: name=value, name!=value, name~value, name!~value, name=a|b|c',
    );
  }

  const [, rawName, operator, rawValue] = match;
  const name = rawName.toLowerCase();
  if (!(FILTER_NAMES as readonly string[]).includes(name)) {
    throw usageError(
      `Unknown filter "${name}".`,
      `Known filters: ${FILTER_NAMES.join(', ')}`,
    );
  }
  if (rawValue.trim() === '') {
    throw usageError(`--filter ${name} needs a value.`, `Example: --filter ${name}=acme`);
  }

  const prefix = operator === '!=' ? '!' : operator === '~' ? '~' : operator === '!~' ? '!~' : '';
  return {
    name: name as FilterName,
    param: `filter_${name as FilterName}`,
    value: `${prefix}${rawValue}`,
  };
}

export function collectFilter(value: string, previous: string[] = []): string[] {
  parseFilterExpression(value);
  return [...previous, value];
}

export function buildFilterQuery(expressions: readonly string[] = []): FilterQuery {
  const query: Record<string, string> = {};
  for (const expression of expressions) {
    const parsed = parseFilterExpression(expression);
    if (query[parsed.param] !== undefined) {
      throw usageError(
        `--filter ${parsed.name} was given twice.`,
        `The API takes one value per filter. Combine them: --filter ${parsed.name}=a|b`,
      );
    }
    query[parsed.param] = parsed.value;
  }
  return query as FilterQuery;
}

export function buildReportQuery(options: ReportOptions, site: ResolvedSite): ReportQuery {
  return {
    ...site.selector,
    ...resolveRange(options),
    ...buildFilterQuery(options.filter),
  };
}

export function rangeLabel(range: TimeRangeQuery): string {
  const zone = range.timezone ?? 'UTC';
  if (range.startAt === undefined) return 'last 30 days';
  const to = range.endAt === undefined ? 'now' : formatDate(new Date(range.endAt), zone);
  return `${formatDate(new Date(range.startAt), zone)} → ${to}`;
}

export function reportHeader(site: ResolvedSite, range: TimeRangeQuery): string {
  const parts = [site.label, rangeLabel(range)];
  if (range.timezone !== undefined) parts.push(range.timezone);
  return parts.join(' · ');
}

export function pagePath(url: string | undefined | null): string | undefined {
  if (url === undefined || url === null || url === '') return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export function count(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return counts.format(Number(value.toFixed(digits)));
}

export function money(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function percent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function seconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value <= 0) return '0s';
  const total = Math.round(value);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export async function withProgress<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const progress = isQuiet() || isMachine() ? null : spinner(label);
  try {
    return await operation();
  } finally {
    progress?.stop();
  }
}

export function pagingFooter(
  shown: number,
  total: number,
  paging: ResolvedPaging,
  noun: string,
  nextCommand: string,
): void {
  const seen = paging.offset + shown;
  print(
    paging.offset === 0 && shown >= total
      ? `${count(total)} ${noun}`
      : `${count(shown)} of ${count(total)} ${noun}`,
  );
  if (!paging.all && seen < total) {
    hint(`next: ${nextCommand} --offset ${seen} --limit ${paging.limit}`);
  }
}

export const withSite = (command: Command): Command =>
  command.option('--site <id|domain>', 'website to report on, a domain or an id');

export const withRange = (command: Command): Command =>
  command
    .option('--from <date>', 'start of the window, ISO 8601 or an offset like -7d (default: 30 days ago)')
    .option('--to <date>', 'end of the window, ISO 8601 or an offset (default: now)')
    .option('--timezone <tz>', 'IANA timezone for the window (default: the website timezone)');

export const withPaging = (command: Command, maxLimit = MAX_QUERY_LIMIT): Command =>
  command
    .option('--limit <n>', `rows per page, 1..${maxLimit}`)
    .option('--offset <n>', 'rows to skip')
    .option('--all', `page through every row, up to ${MAX_PAGES} requests`);

export const withFilters = (command: Command): Command =>
  command.option(
    '-F, --filter <expr>',
    `filter as name=value, name!=value, name~value, name!~value or name=a|b|c (names: ${FILTER_NAMES.join(' ')})`,
    collectFilter,
    [] as string[],
  );

export const withQueryFlags = (command: Command): Command =>
  withFilters(withRange(withSite(command)));

export const withReportFlags = (command: Command, maxLimit = MAX_QUERY_LIMIT): Command =>
  withPaging(withQueryFlags(command), maxLimit);

const LIST_COLUMNS: Column<Website>[] = [
  { header: 'ID', value: (website) => formatId(website.id) },
  { header: 'DOMAIN', value: (website) => website.domain },
  { header: 'TZ', value: (website) => website.timezone },
  { header: 'CUR', value: (website) => website.currency },
  { header: 'TRACKING ID', value: (website) => formatId(website.trackingId) },
  { header: 'API KEY', value: (website) => website.apiKeyPrefix ?? '—' },
  { header: 'KPI', value: (website) => website.kpi ?? '—' },
];

const FALLBACK_METADATA: WebsiteMetadata = {
  domain: '',
  timezone: 'UTC',
  logo: null,
  kpiColorScheme: null,
  kpi: null,
  currency: 'USD',
};

let metadataCache: WebsiteMetadata | undefined;

export async function siteMetadata(site: ResolvedSite): Promise<WebsiteMetadata> {
  if (metadataCache !== undefined) return metadataCache;
  try {
    const response = await getWebsiteMetadata(site.selector);
    metadataCache = response.data[0] ?? { ...FALLBACK_METADATA, domain: site.label };
  } catch {
    metadataCache = { ...FALLBACK_METADATA, domain: site.label };
  }
  return metadataCache;
}

export async function siteCurrency(site: ResolvedSite): Promise<string> {
  return (await siteMetadata(site)).currency;
}

export function resetSiteMetadata(): void {
  metadataCache = undefined;
}

export async function fetchWebsites(label = 'Loading websites…'): Promise<Website[]> {
  const response = await withProgress(label, listWebsites);
  return response.data;
}

export function findWebsite(websites: readonly Website[], value: string): Website | undefined {
  const needle = normalizeSiteValue(value).toLowerCase();
  return websites.find(
    (website) => website.id.toLowerCase() === needle || website.domain.toLowerCase() === needle,
  );
}

const runList = async (): Promise<void> => {
  const websites = await fetchWebsites();
  const profile = resolveProfile();
  const preferred =
    typeof profile.defaults.defaultWebsite === 'string' ? profile.defaults.defaultWebsite : undefined;

  if (isMachine()) {
    printResult('site.list', websites, { total: websites.length, hasMore: false });
    return;
  }

  if (websites.length === 0) {
    print('This token can see no websites.');
    hint(`add one: ${PRODUCT.binName} open dashboard`);
    return;
  }

  printTable(websites, LIST_COLUMNS);
  print();

  const noun = websites.length === 1 ? 'website' : 'websites';
  print(
    preferred === undefined
      ? `${websites.length} ${noun}`
      : `${websites.length} ${noun} · default: ${preferred}`,
  );

  if (preferred !== undefined && findWebsite(websites, preferred) === undefined) {
    print();
    print(dim(`config defaultWebsite "${preferred}" is not in this list.`));
    hint(`fix: ${PRODUCT.binName} config set defaultWebsite ${websites[0].domain}`);
  }
};

const runMetadata = async (options: SiteOption): Promise<void> => {
  const site = await resolveSite(options);
  const response = await withProgress('Loading metadata…', () => getWebsiteMetadata(site.selector));
  const metadata = response.data[0];

  if (metadata === undefined) {
    throw usageError(
      `The API returned no metadata for "${site.label}".`,
      `list the websites this token can see: ${PRODUCT.binName} site list`,
    );
  }

  if (isMachine()) {
    printResult('site.metadata', metadata);
    return;
  }

  printKeyValues([
    ['domain', metadata.domain],
    ['timezone', metadata.timezone],
    ['currency', metadata.currency],
    ['kpi', metadata.kpi ?? '—'],
    ['kpi colors', metadata.kpiColorScheme ?? '—'],
    ['logo', metadata.logo ?? '—'],
  ]);
};

export function registerSiteCommands(program: Command): void {
  const site = program
    .command('site')
    .alias('sites')
    .description('the websites this token can report on');

  site
    .command('list')
    .alias('ls')
    .description('list every website, with its timezone, currency and tracking id')
    .action(async () => {
      await runList();
    });

  withSite(
    site
      .command('metadata')
      .alias('meta')
      .description('timezone, currency and KPI for one resolved website'),
  ).action(async (options: SiteOption) => {
    await runMetadata(options);
  });
}
