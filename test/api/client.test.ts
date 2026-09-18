import { beforeEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('../../src/core/http.js', () => ({ request }));

import * as client from '../../src/api/client.js';
import { BREAKDOWN_DIMENSIONS, FILTER_NAMES } from '../../src/api/types.js';

const lastCall = () => request.mock.calls.at(-1)?.[0] as Record<string, unknown>;

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({ status: 'success', data: [] });
});

describe('endpoint mapping', () => {
  const cases: [string, () => Promise<unknown>, Record<string, unknown>][] = [
    [
      'listWebsites',
      () => client.listWebsites(),
      { method: 'GET', path: '/websites' },
    ],
    [
      'getWebsiteMetadata',
      () => client.getWebsiteMetadata({ domain: 'acme.com' }),
      { method: 'GET', path: '/metadata', query: { domain: 'acme.com' } },
    ],
    [
      'getOverview',
      () =>
        client.getOverview({
          websiteId: 'w_8f21',
          startAt: '2026-08-19',
          endAt: '2026-09-18',
          filter_country: 'DE|AT|CH',
        }),
      {
        method: 'GET',
        path: '/overview',
        query: {
          websiteId: 'w_8f21',
          startAt: '2026-08-19',
          endAt: '2026-09-18',
          filter_country: 'DE|AT|CH',
        },
      },
    ],
    [
      'getTimeseries',
      () => client.getTimeseries({ domain: 'acme.com', interval: 'week' }),
      {
        method: 'GET',
        path: '/timeseries',
        query: { domain: 'acme.com', interval: 'week' },
      },
    ],
    [
      'getRealtime',
      () => client.getRealtime({ domain: 'acme.com' }),
      { method: 'GET', path: '/realtime', query: { domain: 'acme.com' } },
    ],
    [
      'getRealtime without arguments',
      () => client.getRealtime(),
      { method: 'GET', path: '/realtime', query: {} },
    ],
    [
      'getRealtimeMap',
      () => client.getRealtimeMap({ domain: 'acme.com' }),
      { method: 'GET', path: '/realtime/map', query: { domain: 'acme.com' } },
    ],
    [
      'getBreakdown',
      () => client.getBreakdown({ dimension: 'via', limit: 5 }),
      {
        method: 'GET',
        path: '/breakdown',
        query: { dimension: 'via', limit: 5 },
      },
    ],
    [
      'listPages',
      () => client.listPages({ limit: 5, offset: 10 }),
      { method: 'GET', path: '/pages', query: { limit: 5, offset: 10 } },
    ],
    [
      'listReferrers',
      () => client.listReferrers({}),
      { method: 'GET', path: '/referrers', query: {} },
    ],
    [
      'listChannels',
      () => client.listChannels({}),
      { method: 'GET', path: '/channels', query: {} },
    ],
    [
      'listCampaigns',
      () => client.listCampaigns({}),
      { method: 'GET', path: '/campaigns', query: {} },
    ],
    [
      'listHostnames',
      () => client.listHostnames({}),
      { method: 'GET', path: '/hostnames', query: {} },
    ],
    [
      'listCountries',
      () => client.listCountries({}),
      { method: 'GET', path: '/countries', query: {} },
    ],
    [
      'listRegions',
      () => client.listRegions({}),
      { method: 'GET', path: '/regions', query: {} },
    ],
    [
      'listCities',
      () => client.listCities({}),
      { method: 'GET', path: '/cities', query: {} },
    ],
    [
      'listDevices',
      () => client.listDevices({}),
      { method: 'GET', path: '/devices', query: {} },
    ],
    [
      'listBrowsers',
      () => client.listBrowsers({}),
      { method: 'GET', path: '/browsers', query: {} },
    ],
    [
      'listOperatingSystems',
      () => client.listOperatingSystems({}),
      { method: 'GET', path: '/operating-systems', query: {} },
    ],
    [
      'listGoals',
      () => client.listGoals({ domain: 'acme.com' }),
      { method: 'GET', path: '/goals', query: { domain: 'acme.com' } },
    ],
    [
      'trackGoal',
      () =>
        client.trackGoal({
          name: 'signup_clicked',
          domain: 'acme.com',
          metadata: { plan: 'pro' },
        }),
      {
        method: 'POST',
        path: '/goals',
        body: {
          name: 'signup_clicked',
          domain: 'acme.com',
          metadata: { plan: 'pro' },
        },
      },
    ],
    [
      'deleteGoals',
      () =>
        client.deleteGoals({
          domain: 'acme.com',
          name: 'signup_clicked',
          startAt: '2026-09-01',
        }),
      {
        method: 'DELETE',
        path: '/goals',
        query: {
          domain: 'acme.com',
          name: 'signup_clicked',
          startAt: '2026-09-01',
        },
      },
    ],
    [
      'trackPayment',
      () =>
        client.trackPayment({
          amount: 49,
          currency: 'USD',
          transactionId: 'txn_7f2a',
          isRenewal: true,
        }),
      {
        method: 'POST',
        path: '/payments',
        body: {
          amount: 49,
          currency: 'USD',
          transactionId: 'txn_7f2a',
          isRenewal: true,
        },
      },
    ],
    [
      'deletePayments',
      () => client.deletePayments({ transactionId: 'txn_7f2a' }),
      {
        method: 'DELETE',
        path: '/payments',
        query: { transactionId: 'txn_7f2a' },
      },
    ],
    [
      'listIssues',
      () =>
        client.listIssues({
          domain: 'acme.com',
          severity: 'critical',
          sort: 'recency',
          limit: 100,
        }),
      {
        method: 'GET',
        path: '/issues',
        query: {
          domain: 'acme.com',
          severity: 'critical',
          sort: 'recency',
          limit: 100,
        },
      },
    ],
    [
      'listIssues without arguments',
      () => client.listIssues(),
      { method: 'GET', path: '/issues', query: {} },
    ],
    [
      'getIssue',
      () => client.getIssue('iss_4f2', { domain: 'acme.com' }),
      {
        method: 'GET',
        path: '/issues/iss_4f2',
        query: { domain: 'acme.com' },
      },
    ],
    [
      'getIssue without a selector',
      () => client.getIssue('iss_4f2'),
      { method: 'GET', path: '/issues/iss_4f2', query: {} },
    ],
    [
      'updateIssueStatus',
      () =>
        client.updateIssueStatus(
          'iss_4f2',
          { status: 'resolved' },
          { websiteId: 'w_8f21' },
        ),
      {
        method: 'PATCH',
        path: '/issues/iss_4f2',
        query: { websiteId: 'w_8f21' },
        body: { status: 'resolved' },
      },
    ],
    [
      'getVisitorProfile',
      () => client.getVisitorProfile('v_77de', { domain: 'acme.com' }),
      {
        method: 'GET',
        path: '/visitors/v_77de',
        query: { domain: 'acme.com' },
      },
    ],
  ];

  it.each(cases)('%s', async (_name, call, expected) => {
    await call();

    expect(request).toHaveBeenCalledTimes(1);
    expect(lastCall()).toEqual(expected);
  });
});

describe('path building', () => {
  it('encodes ids into a single path segment', async () => {
    await client.getIssue('iss 4f2/e');

    expect(lastCall().path).toBe('/issues/iss%204f2%2Fe');
  });

  it('encodes visitor ids into a single path segment', async () => {
    await client.getVisitorProfile('v 77de/e');

    expect(lastCall().path).toBe('/visitors/v%2077de%2Fe');
  });

  it('never sends an absolute url as the path', async () => {
    await client.listWebsites();
    await client.listIssues();
    await client.getRealtime();

    for (const [options] of request.mock.calls) {
      expect(options.path).toMatch(/^\//);
    }
  });
});

describe('write calls', () => {
  it('never marks a tracking write idempotent, because it double-counts on retry', async () => {
    await client.trackGoal({ name: 'signup_clicked' });
    await client.trackPayment({ transactionId: 'txn_7f2a' });

    for (const [options] of request.mock.calls) {
      expect(options.idempotent).toBeUndefined();
    }
  });
});

describe('enums', () => {
  it('carries all 25 breakdown dimensions including via', () => {
    expect(BREAKDOWN_DIMENSIONS).toHaveLength(25);
    expect(BREAKDOWN_DIMENSIONS).toContain('via');
  });

  it('carries all 20 filter names', () => {
    expect(FILTER_NAMES).toHaveLength(20);
    expect(new Set(FILTER_NAMES).size).toBe(20);
  });
});

describe('return value', () => {
  it('passes the parsed response through untouched', async () => {
    const websites = { status: 'success', data: [{ id: 'w_8f21' }] };
    request.mockResolvedValueOnce(websites);

    await expect(client.listWebsites()).resolves.toBe(websites);
  });
});
