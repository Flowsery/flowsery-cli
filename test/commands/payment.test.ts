import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/commands/site.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/commands/site.js')>();
  return {
    ...actual,
    resolveSite: async () => ({
      kind: 'website',
      selector: {},
      label: 'this website',
      source: 'token',
    }),
  };
});

const { buildTrackPaymentRequest } = await import('../../src/commands/payment.js');

describe('buildTrackPaymentRequest', () => {
  it('refuses a payment without --amount even with --force', async () => {
    await expect(buildTrackPaymentRequest({ force: true })).rejects.toThrow(/--amount/);
    await expect(
      buildTrackPaymentRequest({ force: true, currency: 'EUR', transactionId: 'txn_1' }),
    ).rejects.toThrow(/--amount/);
  });

  it('lets --force skip --currency and --transaction-id but still sends the amount', async () => {
    await expect(buildTrackPaymentRequest({ force: true, amount: '12.5' })).resolves.toEqual({ amount: 12.5 });
  });

  it('asks for --currency and --transaction-id without --force', async () => {
    await expect(buildTrackPaymentRequest({ amount: '10' })).rejects.toThrow(/--currency, --transaction-id/);
  });

  it('builds the full body when every required flag is given', async () => {
    await expect(
      buildTrackPaymentRequest({ amount: '49', currency: 'eur', transactionId: ' txn_2 ' }),
    ).resolves.toEqual({ amount: 49, currency: 'EUR', transactionId: 'txn_2' });
  });

  it('sends the timezone and the buyer IP and User-Agent', async () => {
    await expect(
      buildTrackPaymentRequest({
        amount: '20',
        currency: 'USD',
        transactionId: 'txn_3',
        timezone: 'Europe/Berlin',
        customerIp: ' 203.0.113.7 ',
        customerUserAgent: 'Mozilla/5.0 (Macintosh)',
      }),
    ).resolves.toEqual({
      amount: 20,
      currency: 'USD',
      transactionId: 'txn_3',
      timezone: 'Europe/Berlin',
      customerIp: '203.0.113.7',
      customerUserAgent: 'Mozilla/5.0 (Macintosh)',
    });
  });

  it('refuses a customer IP that is not an address', async () => {
    await expect(
      buildTrackPaymentRequest({ amount: '20', currency: 'USD', transactionId: 'txn_4', customerIp: 'example.com' }),
    ).rejects.toThrow(/--customer-ip/);
  });

  it('refuses a User-Agent longer than the API allows', async () => {
    await expect(
      buildTrackPaymentRequest({
        amount: '20',
        currency: 'USD',
        transactionId: 'txn_5',
        customerUserAgent: 'a'.repeat(1025),
      }),
    ).rejects.toThrow(/--customer-user-agent/);
  });

  it('refuses an unknown timezone', async () => {
    await expect(
      buildTrackPaymentRequest({ amount: '20', currency: 'USD', transactionId: 'txn_6', timezone: 'Mars/Base' }),
    ).rejects.toThrow();
  });
});
