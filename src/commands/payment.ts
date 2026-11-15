import { isIP } from 'node:net';

import type { Command } from 'commander';

import { deletePayments, trackPayment } from '../api/client.js';
import {
  CUSTOMER_USER_AGENT_MAX_LENGTH,
  type DeletePaymentsQuery,
  type TrackPaymentRequest,
} from '../api/types.js';
import {
  assertTimeZone,
  getGlobalOptions,
  hint,
  isMachine,
  parseWhen,
  print,
  printKeyValues,
  printResult,
  promptConfirm,
  success,
  usageError,
  warn,
} from '../core/index.js';
import {
  count,
  money,
  resolveRange,
  resolveSite,
  withProgress,
  withSite,
  type SiteOption,
} from './site.js';

const CURRENCY = /^[A-Za-z]{3}$/;

export interface PaymentTrackOptions extends SiteOption {
  amount?: string;
  currency?: string;
  transactionId?: string;
  email?: string;
  name?: string;
  customerId?: string;
  renewal?: boolean;
  refund?: boolean;
  at?: string;
  visitorUid?: string;
  sessionUid?: string;
  timezone?: string;
  customerIp?: string;
  customerUserAgent?: string;
  force?: boolean;
}

export interface PaymentDeleteOptions extends SiteOption {
  transactionId?: string;
  visitor?: string;
  from?: string;
  to?: string;
}

export function parseAmount(raw: string): number {
  const amount = Number(raw.trim());
  if (!Number.isFinite(amount)) {
    throw usageError(`--amount must be a number in major units, got "${raw}".`);
  }
  if (amount < 0) {
    throw usageError('--amount cannot be negative.', 'Record a refund with --refund instead.');
  }
  return amount;
}

export function assertCurrency(raw: string): string {
  const value = raw.trim().toUpperCase();
  if (!CURRENCY.test(value)) {
    throw usageError(`--currency must be a three-letter ISO 4217 code, got "${raw}".`);
  }
  return value;
}

export function assertCustomerIp(raw: string): string {
  const value = raw.trim();
  if (isIP(value) === 0) {
    throw usageError(`--customer-ip must be an IPv4 or IPv6 address, got "${raw}".`);
  }
  return value;
}

export function assertCustomerUserAgent(raw: string): string {
  const value = raw.trim();
  if (value.length > CUSTOMER_USER_AGENT_MAX_LENGTH) {
    throw usageError(`--customer-user-agent can be at most ${CUSTOMER_USER_AGENT_MAX_LENGTH} characters.`);
  }
  return value;
}

export async function buildTrackPaymentRequest(options: PaymentTrackOptions): Promise<TrackPaymentRequest> {
  const site = await resolveSite(options);
  const force = options.force === true;

  if (options.amount === undefined) {
    throw usageError('payment track needs --amount.', 'The API rejects a payment without an amount, even with --force.');
  }

  if (!force) {
    const missing = [
      options.currency === undefined ? '--currency' : undefined,
      options.transactionId === undefined ? '--transaction-id' : undefined,
    ].filter((flag): flag is string => flag !== undefined);

    if (missing.length > 0) {
      throw usageError(
        `payment track needs ${missing.join(', ')}.`,
        'A payment with no transaction id can never be deleted. Pass --force to record one anyway.',
      );
    }
  }

  if (options.renewal === true && options.refund === true) {
    throw usageError('--renewal and --refund cannot both be set.');
  }

  const amount = parseAmount(options.amount);
  const currency = options.currency === undefined ? undefined : assertCurrency(options.currency);
  const timestamp = options.at === undefined ? undefined : parseWhen(options.at).toISOString();
  const timezone = options.timezone === undefined ? undefined : assertTimeZone(options.timezone.trim());
  const customerIp = options.customerIp === undefined ? undefined : assertCustomerIp(options.customerIp);
  const customerUserAgent =
    options.customerUserAgent === undefined ? undefined : assertCustomerUserAgent(options.customerUserAgent);

  return {
    ...site.selector,
    amount,
    ...(currency === undefined ? {} : { currency }),
    ...(options.transactionId ? { transactionId: options.transactionId.trim() } : {}),
    ...(options.email ? { email: options.email.trim() } : {}),
    ...(options.name ? { name: options.name.trim() } : {}),
    ...(options.customerId ? { customerId: options.customerId.trim() } : {}),
    ...(options.renewal === true ? { isRenewal: true } : {}),
    ...(options.refund === true ? { isRefund: true } : {}),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(options.visitorUid ? { visitorUid: options.visitorUid.trim() } : {}),
    ...(options.sessionUid ? { sessionUid: options.sessionUid.trim() } : {}),
    ...(timezone === undefined ? {} : { timezone }),
    ...(customerIp === undefined ? {} : { customerIp }),
    ...(customerUserAgent ? { customerUserAgent } : {}),
  };
}

export async function buildDeletePaymentsQuery(options: PaymentDeleteOptions): Promise<DeletePaymentsQuery> {
  const site = await resolveSite(options);
  const range = resolveRange({ from: options.from, to: options.to });
  const transactionId = options.transactionId?.trim();
  const visitorId = options.visitor?.trim();

  const query: DeletePaymentsQuery = {
    ...site.selector,
    ...(transactionId ? { transactionId } : {}),
    ...(visitorId ? { visitorId } : {}),
    ...(range.startAt === undefined ? {} : { startAt: range.startAt }),
    ...(range.endAt === undefined ? {} : { endAt: range.endAt }),
  };

  if (
    query.transactionId === undefined &&
    query.visitorId === undefined &&
    query.startAt === undefined &&
    query.endAt === undefined
  ) {
    throw usageError(
      'payment delete needs at least one of --transaction-id, --visitor, --from or --to.',
      'Without a filter the API would delete every payment this website ever recorded.',
    );
  }

  return query;
}

export function describeDeleteFilters(query: DeletePaymentsQuery): string {
  const parts: string[] = [];
  if (query.transactionId !== undefined) parts.push(`transactionId=${query.transactionId}`);
  if (query.visitorId !== undefined) parts.push(`visitorId=${query.visitorId}`);
  if (query.startAt !== undefined) parts.push(`startAt=${query.startAt}`);
  if (query.endAt !== undefined) parts.push(`endAt=${query.endAt}`);
  return parts.join(', ');
}

const runTrack = async (options: PaymentTrackOptions): Promise<void> => {
  const body = await buildTrackPaymentRequest(options);
  const response = await withProgress('Recording the payment…', () => trackPayment(body));

  if (isMachine()) {
    printResult('payment.track', response.data[0] ?? { message: 'accepted' }, {
      transactionId: body.transactionId ?? null,
      amount: body.amount,
    });
    return;
  }

  const amount = body.amount;
  const currency = body.currency ?? 'USD';

  success(
    amount === 0
      ? 'Recorded a payment of 0. The API books this as a free_trial goal, not a payment goal.'
      : `Recorded ${money(amount, currency)}${body.isRefund === true ? ' as a refund' : body.isRenewal === true ? ' as a renewal' : ''}.`,
  );

  printKeyValues([
    ['transaction', body.transactionId ?? '—'],
    ['customer', body.email ?? body.customerId ?? body.name ?? '—'],
    ['at', body.timestamp ?? 'now'],
  ]);

  if (body.transactionId === undefined) {
    warn('This payment has no transaction id, so payment delete can never target it on its own.');
  }
  hint('The write is async; it appears in stats overview shortly.');
};

const runDelete = async (options: PaymentDeleteOptions): Promise<void> => {
  const query = await buildDeletePaymentsQuery(options);
  const filters = describeDeleteFilters(query);

  print(`Delete payments matching: ${filters}.`);
  print('This cannot be undone.');

  const confirmed = await promptConfirm('Delete them?', {
    assumeYes: getGlobalOptions().yes === true,
    initialValue: false,
  });
  if (!confirmed) {
    print('Nothing deleted.');
    return;
  }

  const response = await withProgress('Deleting payments…', () => deletePayments(query));
  const result = response.data[0] ?? { deleted: 0, message: 'nothing matched' };

  if (isMachine()) {
    printResult('payment.delete', result, { filters });
    return;
  }

  success(`Deleted ${count(result.deleted)} payments.`);
  printKeyValues([['api said', result.message]]);
};

export function registerPaymentCommands(program: Command): void {
  const payment = program
    .command('payment')
    .alias('payments')
    .description('revenue writes');

  withSite(
    payment
      .command('track')
      .description('record one payment; a repeated transaction id is rejected with a 409, not deduplicated'),
  )
    .option('--amount <n>', 'amount in major units, for example 49.00')
    .option('--currency <code>', 'ISO 4217 code (default: USD)')
    .option('--transaction-id <id>', 'your identifier for this payment, needed to delete it later')
    .option('--email <email>', 'customer email')
    .option('--name <name>', 'customer name')
    .option('--customer-id <id>', 'your identifier for the customer')
    .option('--renewal', 'book this as renewal revenue')
    .option('--refund', 'book this as a refund')
    .option('--at <date>', 'when the payment happened, ISO 8601 (default: now)')
    .option('--visitor-uid <uid>', 'value of the visitor cookie the payment belongs to')
    .option('--session-uid <uid>', 'value of the session cookie the payment belongs to')
    .option('--timezone <tz>', 'IANA timezone of the buyer, used to place them in a country')
    .option('--customer-ip <ip>', 'buyer IP at checkout, for a server-side call with no visitor; only the country is kept')
    .option(
      '--customer-user-agent <ua>',
      `buyer User-Agent at checkout (at most ${CUSTOMER_USER_AGENT_MAX_LENGTH} characters); only browser, OS and device are kept`,
    )
    .option('--force', 'record the payment without --currency and --transaction-id; --amount is still required')
    .action(async (options: PaymentTrackOptions) => {
      await runTrack(options);
    });

  withSite(
    payment
      .command('delete')
      .alias('rm')
      .description('delete payments; at least one filter is required'),
  )
    .option('--transaction-id <id>', 'delete only the payment with this transaction id')
    .option('--visitor <id>', 'delete only this visitor\'s payments')
    .option('--from <date>', 'delete only payments at or after this time')
    .option('--to <date>', 'delete only payments at or before this time')
    .action(async (options: PaymentDeleteOptions) => {
      await runDelete(options);
    });
}
