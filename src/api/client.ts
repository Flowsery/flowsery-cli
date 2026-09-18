import { request } from '../core/index.js';
import type {
  BreakdownQuery,
  BreakdownResponse,
  DeleteGoalsQuery,
  DeletePaymentsQuery,
  DeleteResponse,
  GoalsResponse,
  IssueListQuery,
  IssueListResponse,
  IssueResponse,
  MessageResponse,
  MetadataResponse,
  OverviewResponse,
  RealtimeMapResponse,
  RealtimeResponse,
  ReportQuery,
  TimeseriesQuery,
  TimeseriesResponse,
  TrackGoalRequest,
  TrackPaymentRequest,
  UpdateIssueStatusRequest,
  VisitorProfileResponse,
  WebsiteSelector,
  WebsitesResponse,
} from './types.js';

const segment = (value: string): string => encodeURIComponent(value);

export const listWebsites = (): Promise<WebsitesResponse> =>
  request<WebsitesResponse>({ method: 'GET', path: '/websites' });

export const getWebsiteMetadata = (
  websiteSelector: WebsiteSelector,
): Promise<MetadataResponse> =>
  request<MetadataResponse>({
    method: 'GET',
    path: '/metadata',
    query: websiteSelector,
  });

export const getOverview = (
  reportQuery: ReportQuery,
): Promise<OverviewResponse> =>
  request<OverviewResponse>({
    method: 'GET',
    path: '/overview',
    query: reportQuery,
  });

export const getTimeseries = (
  timeseriesQuery: TimeseriesQuery,
): Promise<TimeseriesResponse> =>
  request<TimeseriesResponse>({
    method: 'GET',
    path: '/timeseries',
    query: timeseriesQuery,
  });

export const getRealtime = (
  websiteSelector: WebsiteSelector = {},
): Promise<RealtimeResponse> =>
  request<RealtimeResponse>({
    method: 'GET',
    path: '/realtime',
    query: websiteSelector,
  });

export const getRealtimeMap = (
  websiteSelector: WebsiteSelector = {},
): Promise<RealtimeMapResponse> =>
  request<RealtimeMapResponse>({
    method: 'GET',
    path: '/realtime/map',
    query: websiteSelector,
  });

export const getBreakdown = (
  breakdownQuery: BreakdownQuery,
): Promise<BreakdownResponse> =>
  request<BreakdownResponse>({
    method: 'GET',
    path: '/breakdown',
    query: breakdownQuery,
  });

export const listPages = (
  reportQuery: ReportQuery,
): Promise<BreakdownResponse> =>
  request<BreakdownResponse>({
    method: 'GET',
    path: '/pages',
    query: reportQuery,
  });

export const listReferrers = (
  reportQuery: ReportQuery,
): Promise<BreakdownResponse> =>
  request<BreakdownResponse>({
    method: 'GET',
    path: '/referrers',
    query: reportQuery,
  });

export const listChannels = (
  reportQuery: ReportQuery,
): Promise<BreakdownResponse> =>
  request<BreakdownResponse>({
    method: 'GET',
    path: '/channels',
    query: reportQuery,
  });

export const listCampaigns = (
  reportQuery: ReportQuery,
): Promise<BreakdownResponse> =>
  request<BreakdownResponse>({
    method: 'GET',
    path: '/campaigns',
    query: reportQuery,
  });

export const listHostnames = (
  reportQuery: ReportQuery,
): Promise<BreakdownResponse> =>
  request<BreakdownResponse>({
    method: 'GET',
    path: '/hostnames',
    query: reportQuery,
  });

export const listCountries = (
  reportQuery: ReportQuery,
): Promise<BreakdownResponse> =>
  request<BreakdownResponse>({
    method: 'GET',
    path: '/countries',
    query: reportQuery,
  });

export const listRegions = (
  reportQuery: ReportQuery,
): Promise<BreakdownResponse> =>
  request<BreakdownResponse>({
    method: 'GET',
    path: '/regions',
    query: reportQuery,
  });

export const listCities = (
  reportQuery: ReportQuery,
): Promise<BreakdownResponse> =>
  request<BreakdownResponse>({
    method: 'GET',
    path: '/cities',
    query: reportQuery,
  });

export const listDevices = (
  reportQuery: ReportQuery,
): Promise<BreakdownResponse> =>
  request<BreakdownResponse>({
    method: 'GET',
    path: '/devices',
    query: reportQuery,
  });

export const listBrowsers = (
  reportQuery: ReportQuery,
): Promise<BreakdownResponse> =>
  request<BreakdownResponse>({
    method: 'GET',
    path: '/browsers',
    query: reportQuery,
  });

export const listOperatingSystems = (
  reportQuery: ReportQuery,
): Promise<BreakdownResponse> =>
  request<BreakdownResponse>({
    method: 'GET',
    path: '/operating-systems',
    query: reportQuery,
  });

export const listGoals = (reportQuery: ReportQuery): Promise<GoalsResponse> =>
  request<GoalsResponse>({
    method: 'GET',
    path: '/goals',
    query: reportQuery,
  });

export const trackGoal = (
  trackGoalRequest: TrackGoalRequest,
): Promise<MessageResponse> =>
  request<MessageResponse>({
    method: 'POST',
    path: '/goals',
    body: trackGoalRequest,
  });

export const deleteGoals = (
  deleteGoalsQuery: DeleteGoalsQuery,
): Promise<DeleteResponse> =>
  request<DeleteResponse>({
    method: 'DELETE',
    path: '/goals',
    query: deleteGoalsQuery,
  });

export const trackPayment = (
  trackPaymentRequest: TrackPaymentRequest,
): Promise<MessageResponse> =>
  request<MessageResponse>({
    method: 'POST',
    path: '/payments',
    body: trackPaymentRequest,
  });

export const deletePayments = (
  deletePaymentsQuery: DeletePaymentsQuery,
): Promise<DeleteResponse> =>
  request<DeleteResponse>({
    method: 'DELETE',
    path: '/payments',
    query: deletePaymentsQuery,
  });

export const listIssues = (
  issueListQuery: IssueListQuery = {},
): Promise<IssueListResponse> =>
  request<IssueListResponse>({
    method: 'GET',
    path: '/issues',
    query: issueListQuery,
  });

export const getIssue = (
  issueId: string,
  websiteSelector: WebsiteSelector = {},
): Promise<IssueResponse> =>
  request<IssueResponse>({
    method: 'GET',
    path: `/issues/${segment(issueId)}`,
    query: websiteSelector,
  });

export const updateIssueStatus = (
  issueId: string,
  updateIssueStatusRequest: UpdateIssueStatusRequest,
  websiteSelector: WebsiteSelector = {},
): Promise<IssueResponse> =>
  request<IssueResponse>({
    method: 'PATCH',
    path: `/issues/${segment(issueId)}`,
    query: websiteSelector,
    body: updateIssueStatusRequest,
  });

export const getVisitorProfile = (
  visitorId: string,
  websiteSelector: WebsiteSelector = {},
): Promise<VisitorProfileResponse> =>
  request<VisitorProfileResponse>({
    method: 'GET',
    path: `/visitors/${segment(visitorId)}`,
    query: websiteSelector,
  });
