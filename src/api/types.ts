export const BREAKDOWN_DIMENSIONS = [
  'device',
  'page',
  'entry_page',
  'exit_link',
  'hostname',
  'referrer',
  'channel',
  'campaign',
  'goal',
  'country',
  'region',
  'city',
  'browser',
  'browser_version',
  'os',
  'os_version',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'source',
  'via',
  'all_params',
] as const;
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

export const BREAKDOWN_ALIASES = [
  'pages',
  'referrers',
  'channels',
  'campaigns',
  'hostnames',
  'countries',
  'regions',
  'cities',
  'devices',
  'browsers',
  'os',
] as const;
export type BreakdownAlias = (typeof BREAKDOWN_ALIASES)[number];

export const ANALYTICS_INTERVALS = ['hour', 'day', 'week', 'month'] as const;
export type AnalyticsInterval = (typeof ANALYTICS_INTERVALS)[number];

export const ISSUE_STATUSES = [
  'open',
  'in_progress',
  'resolved',
  'suspended',
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export const ISSUE_SORT_KEYS = ['severity', 'recency'] as const;
export type IssueSortKey = (typeof ISSUE_SORT_KEYS)[number];

export const TICKET_PROVIDERS = ['linear', 'jira'] as const;
export type TicketProvider = (typeof TICKET_PROVIDERS)[number];

export const DEVICE_TYPES = ['Desktop', 'Mobile', 'Tablet', 'Unknown'] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export const TIMELINE_ENTRY_TYPES = ['pageview', 'goal', 'payment'] as const;
export type TimelineEntryType = (typeof TIMELINE_ENTRY_TYPES)[number];

export const FILTER_NAMES = [
  'country',
  'region',
  'city',
  'device',
  'browser',
  'os',
  'referrer',
  'ref',
  'source',
  'via',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'page',
  'hostname',
  'entry_page',
  'channel',
  'goal',
] as const;
export type FilterName = (typeof FILTER_NAMES)[number];

export const DEFAULT_QUERY_LIMIT = 100;
export const MAX_QUERY_LIMIT = 1000;
export const MAX_GOAL_METADATA_PROPS = 10;
export const GOAL_NAME_MAX_LENGTH = 64;
export const GOAL_NAME_PATTERN = /^[a-z0-9_-]+$/;
export const ISSUE_SEARCH_MAX_LENGTH = 200;

export type WebsiteSelector = {
  websiteId?: string;
  domain?: string;
};

export type TimeRangeQuery = {
  startAt?: string;
  endAt?: string;
  timezone?: string;
};

export type PageQuery = {
  limit?: number;
  offset?: number;
};

export type FilterQuery = {
  [Name in `filter_${FilterName}`]?: string;
};

export type ReportQuery = WebsiteSelector &
  TimeRangeQuery &
  PageQuery &
  FilterQuery;

export type TimeseriesQuery = ReportQuery & {
  interval?: AnalyticsInterval;
};

export type BreakdownQuery = ReportQuery & {
  dimension: BreakdownDimension;
};

export type IssueListQuery = WebsiteSelector &
  PageQuery & {
    status?: IssueStatus;
    severity?: IssueSeverity;
    search?: string;
    sort?: IssueSortKey;
  };

export type DeleteGoalsQuery = WebsiteSelector & {
  visitorId?: string;
  name?: string;
  startAt?: string;
  endAt?: string;
};

export type DeletePaymentsQuery = WebsiteSelector & {
  transactionId?: string;
  visitorId?: string;
  startAt?: string;
  endAt?: string;
};

export interface TrackingTarget {
  websiteId?: string;
  domain?: string;
  visitorUid?: string;
  sessionUid?: string;
  timezone?: string;
}

export interface TrackGoalRequest extends TrackingTarget {
  name: string;
  metadata?: Record<string, string>;
}

export interface TrackPaymentRequest extends TrackingTarget {
  amount?: number;
  currency?: string;
  transactionId?: string;
  email?: string;
  name?: string;
  customerId?: string;
  isRenewal?: boolean;
  isRefund?: boolean;
  timestamp?: string;
}

export interface UpdateIssueStatusRequest {
  status: IssueStatus;
}

export interface Pagination {
  limit: number;
  offset: number;
  total: number;
}

export interface Website {
  id: string;
  domain: string;
  timezone: string;
  currency: string;
  logo: string | null;
  kpiColorScheme: string | null;
  kpi: string | null;
  trackingId: string;
  apiKeyPrefix: string | null;
}

export interface WebsitesResponse {
  status: 'success';
  data: Website[];
}

export interface WebsiteMetadata {
  domain: string;
  timezone: string;
  logo: string | null;
  kpiColorScheme: string | null;
  kpi: string | null;
  currency: string;
}

export interface MetadataResponse {
  status: 'success';
  data: WebsiteMetadata[];
}

export interface Overview {
  visitors: number;
  sessions: number;
  bounceRate: number;
  avgSessionDuration: number;
  avgEngagedTime: number;
  revenue: number;
  renewalRevenue: number;
  refundedRevenue: number;
  revenuePerVisitor: number;
  conversionRate: number;
  kpiValue: number;
  kpiPerVisitor: number;
  kpiConversionRate: number;
  currency: string;
}

export interface OverviewResponse {
  status: 'success';
  data: Overview[];
}

export interface TimeseriesPoint {
  timestamp: string;
  name: string;
  visitors: number;
  sessions: number;
  revenue: number;
  newRevenue: number;
  renewalRevenue: number;
  refundedRevenue: number;
  conversionRate: number;
  kpiValue: number;
}

export interface TimeseriesTotals {
  visitors: number;
  sessions: number;
  revenue: number;
}

export interface TimeseriesResponse {
  status: 'success';
  interval: AnalyticsInterval;
  timezone: string;
  currency: string;
  data: TimeseriesPoint[];
  totals: TimeseriesTotals;
  pagination: Pagination;
}

export interface BreakdownRow {
  value: string;
  visitors: number;
  revenue?: number;
  newRevenue?: number;
  renewalRevenue?: number;
  percentage?: number;
  countryCode?: string;
}

export interface BreakdownResponse {
  status: 'success';
  data: BreakdownRow[];
  pagination: Pagination;
}

export interface Goal {
  id: string;
  name: string;
  completions: number;
  visitors: number;
}

export interface GoalsResponse {
  status: 'success';
  data: Goal[];
  pagination: Pagination;
}

export interface RealtimeVisitorCount {
  visitors: number;
}

export interface RealtimeResponse {
  status: 'success';
  data: RealtimeVisitorCount[];
}

export interface RealtimeMapVisitor {
  visitorId: string;
  visitorUid?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  browser?: string;
  os?: string;
  deviceType?: DeviceType;
  currentUrl?: string;
  referrer?: string;
  referrerSource?: string;
  referrerIconUrl?: string;
  sessionStartTime?: string;
  pageviews: number;
  totalRevenue: number;
  isCustomer: boolean;
  name?: string;
  email?: string;
}

export interface RealtimeMapResponse {
  status: 'success';
  data: RealtimeMapVisitor[];
}

export interface IssueOccurrence {
  description: string;
  atSeconds: number;
  severity: IssueSeverity;
}

export interface IssueComment {
  id: string;
  incidentId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export interface IssueRecording {
  id: string;
  recordingUid: string;
  websiteId: string;
  visitorUid: string;
  status: string;
  schemaVersion: number;
  startUrl?: string;
  startTitle?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  eventCount: number;
  chunkCount: number;
  totalBytes: number;
  errorCount: number;
  hasClicks: boolean;
  hasInputs: boolean;
  hasErrors: boolean;
  hasRageClicks: boolean;
}

export interface IssueSession {
  recordingId: string;
  atSeconds?: number;
  recording?: IssueRecording;
}

export interface Issue {
  id: string;
  websiteId: string;
  title: string;
  description: string;
  severity: IssueSeverity;
  status: IssueStatus;
  sessionsCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  stepsToReplicate: string[];
  occurrences: IssueOccurrence[];
  atSeconds?: number;
  sampleRecordingId?: string;
  sampleRecording?: IssueRecording;
  sessions: IssueSession[];
  comments: IssueComment[];
  externalTicketProvider?: TicketProvider;
  externalTicketKey?: string;
  externalTicketUrl?: string;
}

export interface IssueCounts {
  open: number;
  inProgress: number;
  resolved: number;
}

export interface IssueListResponse {
  status: 'success';
  data: Issue[];
  counts: IssueCounts;
  pagination: Pagination;
}

export interface IssueResponse {
  status: 'success';
  data: Issue;
}

export interface VisitorAgent {
  name: string | null;
  version: string | null;
}

export interface VisitorDevice {
  type: string | null;
}

export interface VisitorViewport {
  width: number | null;
  height: number | null;
}

export interface VisitorIdentity {
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  browser: VisitorAgent;
  os: VisitorAgent;
  device: VisitorDevice;
  viewport: VisitorViewport;
}

export interface VisitorPageView {
  url: string;
  timestamp: string;
}

export interface VisitorGoalCompletion {
  name: string;
  timestamp: string;
}

export interface VisitorActivity {
  visitCount: number;
  pageViewCount: number;
  firstVisitAt: string | null;
  lastVisitAt: string | null;
  currentUrl: string | null;
  visitedPages: VisitorPageView[];
  completedCustomGoals: VisitorGoalCompletion[];
}

export interface VisitorRevenue {
  totalRevenue: number;
  isCustomer: boolean;
  timeToFirstConversion: number | null;
}

export interface VisitorIdentifiedProfile {
  userId: string | null;
  name: string | null;
  email: string | null;
}

export interface TimelineEntry {
  type: TimelineEntryType;
  timestamp: string;
  url: string | null;
  eventName: string | null;
  amount: number | null;
}

export interface VisitorProfile {
  visitorId: string;
  identity: VisitorIdentity;
  source: string | null;
  sourceIconUrl: string | null;
  activity: VisitorActivity;
  revenue: VisitorRevenue;
  profile: VisitorIdentifiedProfile | null;
  activityTimeline: TimelineEntry[];
}

export interface VisitorProfileResponse {
  status: 'success';
  data: VisitorProfile;
}

export interface TrackedMessage {
  message: string;
}

export interface MessageResponse {
  status: 'success';
  data: TrackedMessage[];
}

export interface DeleteResult {
  deleted: number;
  message: string;
}

export interface DeleteResponse {
  status: 'success';
  data: DeleteResult[];
}
