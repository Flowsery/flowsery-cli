import type { Command } from 'commander';

import { deleteGoals, listGoals, trackGoal } from '../api/client.js';
import {
  GOAL_NAME_MAX_LENGTH,
  GOAL_NAME_PATTERN,
  MAX_GOAL_METADATA_PROPS,
  type DeleteGoalsQuery,
  type Goal,
  type TrackGoalRequest,
} from '../api/types.js';
import {
  MAX_PAGES,
  PRODUCT,
  assertTimeZone,
  getGlobalOptions,
  hint,
  isMachine,
  paginateAll,
  print,
  printKeyValues,
  printResult,
  printTable,
  promptConfirm,
  success,
  usageError,
  warn,
  type Column,
} from '../core/index.js';
import {
  buildReportQuery,
  count,
  pagingFooter,
  reportHeader,
  resolvePaging,
  resolveRange,
  resolveSite,
  withProgress,
  withReportFlags,
  withSite,
  type ReportOptions,
  type SiteOption,
} from './site.js';

export interface GoalTrackOptions extends SiteOption {
  meta: string[];
  visitorUid?: string;
  sessionUid?: string;
  timezone?: string;
}

export interface GoalDeleteOptions extends SiteOption {
  visitor?: string;
  name?: string;
  from?: string;
  to?: string;
}

export function assertGoalName(name: string): string {
  const value = name.trim();
  if (value === '') throw usageError('A goal name is required.');
  if (value.length > GOAL_NAME_MAX_LENGTH) {
    throw usageError(
      `A goal name may be at most ${GOAL_NAME_MAX_LENGTH} characters, "${value}" is ${value.length}.`,
    );
  }
  if (!GOAL_NAME_PATTERN.test(value)) {
    throw usageError(
      `"${value}" is not a valid goal name.`,
      'Use lower-case letters, digits, hyphens and underscores only.',
    );
  }
  return value;
}

export function collectMeta(value: string, previous: string[] = []): string[] {
  const index = value.indexOf('=');
  if (index <= 0) {
    throw usageError(`--meta expects key=value, got "${value}".`, 'Example: --meta plan=pro');
  }
  if (previous.length >= MAX_GOAL_METADATA_PROPS) {
    throw usageError(`--meta takes at most ${MAX_GOAL_METADATA_PROPS} properties.`);
  }
  return [...previous, value];
}

export function buildGoalMetadata(pairs: readonly string[] = []): Record<string, string> | undefined {
  if (pairs.length === 0) return undefined;
  const metadata: Record<string, string> = {};
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    const key = pair.slice(0, index).trim();
    if (key === '') throw usageError(`--meta expects key=value, got "${pair}".`);
    if (metadata[key] !== undefined) throw usageError(`--meta ${key} was given twice.`);
    metadata[key] = pair.slice(index + 1);
  }
  if (Object.keys(metadata).length > MAX_GOAL_METADATA_PROPS) {
    throw usageError(`--meta takes at most ${MAX_GOAL_METADATA_PROPS} properties.`);
  }
  return metadata;
}

export async function buildDeleteGoalsQuery(options: GoalDeleteOptions): Promise<DeleteGoalsQuery> {
  const site = await resolveSite(options);
  const range = resolveRange({ from: options.from, to: options.to });
  const name = options.name === undefined ? undefined : assertGoalName(options.name);
  const visitorId = options.visitor?.trim();

  const query: DeleteGoalsQuery = {
    ...site.selector,
    ...(visitorId ? { visitorId } : {}),
    ...(name === undefined ? {} : { name }),
    ...(range.startAt === undefined ? {} : { startAt: range.startAt }),
    ...(range.endAt === undefined ? {} : { endAt: range.endAt }),
  };

  if (
    query.visitorId === undefined &&
    query.name === undefined &&
    query.startAt === undefined &&
    query.endAt === undefined
  ) {
    throw usageError(
      'goal delete needs at least one of --visitor, --name, --from or --to.',
      'Without a filter the API would delete every goal completion this website ever recorded.',
    );
  }

  return query;
}

export function describeDeleteFilters(query: DeleteGoalsQuery): string {
  const parts: string[] = [];
  if (query.name !== undefined) parts.push(`name=${query.name}`);
  if (query.visitorId !== undefined) parts.push(`visitorId=${query.visitorId}`);
  if (query.startAt !== undefined) parts.push(`startAt=${query.startAt}`);
  if (query.endAt !== undefined) parts.push(`endAt=${query.endAt}`);
  return parts.join(', ');
}

const LIST_COLUMNS: Column<Goal>[] = [
  { header: 'NAME', value: (goal) => goal.name },
  { header: 'COMPLETIONS', align: 'right', value: (goal) => count(goal.completions) },
  { header: 'VISITORS', align: 'right', value: (goal) => count(goal.visitors) },
];

const runList = async (options: ReportOptions): Promise<void> => {
  const site = await resolveSite(options);
  const range = resolveRange(options);
  const base = buildReportQuery(options, site);
  const paging = resolvePaging(options);

  let total = 0;
  let goals: Goal[];

  if (paging.all) {
    const paged = await paginateAll<Goal>({
      pageSize: paging.limit,
      offset: paging.offset,
      maxPages: MAX_PAGES,
      fetchPage: async (page) => {
        const response = await withProgress('Loading goals…', () =>
          listGoals({ ...base, limit: page.limit, offset: page.offset }),
        );
        total = response.pagination.total;
        return { items: response.data, total: response.pagination.total };
      },
    });
    goals = paged.items;
  } else {
    const response = await withProgress('Loading goals…', () =>
      listGoals({ ...base, limit: paging.limit, offset: paging.offset }),
    );
    total = response.pagination.total;
    goals = response.data;
  }

  if (isMachine()) {
    printResult('goal.list', goals, {
      ...range,
      total,
      limit: paging.limit,
      offset: paging.offset,
      hasMore: paging.offset + goals.length < total,
    });
    return;
  }

  print(reportHeader(site, range));
  print();

  if (goals.length === 0) {
    print('No goal completions in this window.');
    hint(`record one: ${PRODUCT.binName} goal track signup_clicked`);
    return;
  }

  printTable(goals, LIST_COLUMNS);
  print();
  pagingFooter(goals.length, total, paging, 'goals', `${PRODUCT.binName} goal list`);
};

const runTrack = async (name: string, options: GoalTrackOptions): Promise<void> => {
  const goalName = assertGoalName(name);
  const site = await resolveSite(options);
  const metadata = buildGoalMetadata(options.meta);
  const timezone = options.timezone === undefined ? undefined : assertTimeZone(options.timezone.trim());

  const body: TrackGoalRequest = {
    ...site.selector,
    name: goalName,
    ...(metadata === undefined ? {} : { metadata }),
    ...(options.visitorUid ? { visitorUid: options.visitorUid.trim() } : {}),
    ...(options.sessionUid ? { sessionUid: options.sessionUid.trim() } : {}),
    ...(timezone === undefined ? {} : { timezone }),
  };

  const response = await withProgress('Recording the goal…', () => trackGoal(body));

  if (isMachine()) {
    printResult('goal.track', response.data[0] ?? { message: 'accepted' }, { name: goalName });
    return;
  }

  success(`Recorded goal "${goalName}". The write is async; it appears in goal list shortly.`);
  warn('Every call counts once. Running this twice records two completions.');
};

const runDelete = async (options: GoalDeleteOptions): Promise<void> => {
  const query = await buildDeleteGoalsQuery(options);
  const filters = describeDeleteFilters(query);

  print(`Delete goal completions matching: ${filters}.`);
  print('This cannot be undone.');

  const confirmed = await promptConfirm('Delete them?', {
    assumeYes: getGlobalOptions().yes === true,
    initialValue: false,
  });
  if (!confirmed) {
    print('Nothing deleted.');
    return;
  }

  const response = await withProgress('Deleting goal completions…', () => deleteGoals(query));
  const result = response.data[0] ?? { deleted: 0, message: 'nothing matched' };

  if (isMachine()) {
    printResult('goal.delete', result, { filters });
    return;
  }

  success(`Deleted ${count(result.deleted)} completions. The goal definition still exists.`);
  printKeyValues([['api said', result.message]]);
};

export function registerGoalCommands(program: Command): void {
  const goal = program
    .command('goal')
    .alias('goals')
    .description('goal completions, and the writes that record them');

  withReportFlags(
    goal.command('list').alias('ls').description('every goal with its completion count'),
  ).action(async (options: ReportOptions) => {
    await runList(options);
  });

  withSite(
    goal
      .command('track')
      .argument('<name>', `goal name, ${GOAL_NAME_PATTERN.source}, at most ${GOAL_NAME_MAX_LENGTH} characters`)
      .description('record one goal completion'),
  )
    .option('--meta <key=value>', `metadata property, repeatable up to ${MAX_GOAL_METADATA_PROPS}`, collectMeta, [] as string[])
    .option('--visitor-uid <uid>', 'value of the visitor cookie the completion belongs to')
    .option('--session-uid <uid>', 'value of the session cookie the completion belongs to')
    .option('--timezone <tz>', 'IANA timezone the completion happened in')
    .action(async (name: string, options: GoalTrackOptions) => {
      await runTrack(name, options);
    });

  withSite(
    goal
      .command('delete')
      .alias('rm')
      .description('delete goal completions; at least one filter is required'),
  )
    .option('--visitor <id>', 'delete only this visitor\'s completions')
    .option('--name <name>', 'delete only completions of this goal')
    .option('--from <date>', 'delete only completions at or after this time')
    .option('--to <date>', 'delete only completions at or before this time')
    .action(async (options: GoalDeleteOptions) => {
      await runDelete(options);
    });
}
