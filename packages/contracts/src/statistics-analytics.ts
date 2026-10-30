import type {
  StatsAudienceGrowth,
  StatsAudienceSummary,
  StatsAudienceValue,
  StatsComparability,
  StatsCoverage,
  StatsDay,
  StatsEntity,
  StatsErrorResult,
  StatsExternalAudienceValue,
  StatsHealth,
  StatsHorizon,
  StatsMembershipSummary,
  StatsMembershipValue,
  StatsMetric,
  StatsMethod,
  StatsPeriod,
  StatsProvenance,
  StatsPublicationValue,
  StatsPurpose,
  StatsReadAccess,
  StatsReadContext,
  StatsReadRevision,
  StatsReachSummary,
  StatsReachValue,
  StatsSummaryCoverage,
  StatsTime,
  StatsTotal,
  StatsUnavailableReason,
} from './statistics-central.js';

export const STATS_ANALYTICS_VERSION = 1 as const;
export const STATS_ANALYTICS_ROUTE = '/analytics:read' as const;
export const STATS_ANALYTICS_LIMITS = {
  requestBytes: 65_536,
  responseBytes: 524_288,
  rows: 256,
} as const;
export type StatsAnalyticsSelection =
  | { metric: Exclude<StatsMetric, 'REACH'>; horizon: 0 }
  | { metric: 'REACH'; horizon: StatsHorizon };
export type StatsAnalyticsCalendar = 'UTC' | 'Europe/Moscow' | 'UNSPECIFIED';
export type StatsAnalyticsComparability = Omit<StatsComparability, 'calendarZone'> & {
  calendarZone: StatsAnalyticsCalendar;
};
export type StatsAnalyticsWindow = {
  calendarZone: StatsAnalyticsCalendar;
  fromDay: StatsDay;
  toDayExclusive: StatsDay;
  from: StatsTime | null;
  to: StatsTime | null;
  availableFrom: StatsTime | null;
  observedUntil: StatsTime | null;
};
export type StatsAnalyticsFreshness = {
  state: 'FRESH' | 'STALE' | 'UNKNOWN';
  staleAt: StatsTime | null;
};
export type StatsAnalyticsQuality = {
  coverage: StatsSummaryCoverage;
  comparability: StatsAnalyticsComparability | null;
  provenance: StatsProvenance[];
  health: StatsHealth;
  freshness: StatsAnalyticsFreshness;
};
export type StatsAnalyticsWindowValue<T> = {
  window: StatsAnalyticsWindow;
  quality: StatsAnalyticsQuality;
} & ({ state: 'AVAILABLE'; value: T } | { state: 'UNAVAILABLE'; reason: StatsUnavailableReason });
export type StatsAnalyticsSectionError = { state: 'ERROR'; code: 'TIMEOUT' | 'SOURCE_UNAVAILABLE' };
/** Exact signed integer, at most 30 magnitude digits, no negative zero. */
export type StatsAnalyticsSignedTotal = string;
/** Exact signed decimal with two fractional digits, at most 50 integer digits. */
export type StatsAnalyticsPercent = string;
export type StatsAnalyticsPercentage =
  | { state: 'AVAILABLE'; value: StatsAnalyticsPercent }
  | { state: 'UNAVAILABLE'; reason: 'ZERO_BASELINE' };
export type StatsAnalyticsRequest = {
  contractVersion: 1;
  analyticsVersion: 1;
  context: StatsReadContext;
  periodDays: StatsPeriod;
  metrics: StatsMetric[];
  horizons: StatsHorizon[];
  includeComparison: boolean;
  includeHistory: boolean;
  cursor: string | null;
};
export type StatsAnalyticsCursor = {
  type: 'analytics';
  analyticsVersion: 1;
  filterHash: string;
  revisionDigest: string;
  asOf: StatsTime;
  retentionFloor: StatsDay;
  after: { day: StatsDay; selection: StatsAnalyticsSelection };
  expiresAt: StatsTime;
};
export type StatsAnalyticsCursorBody = StatsAnalyticsCursor;
export type StatsAnalyticsAudienceValue =
  | Omit<Extract<StatsAudienceSummary, { method: StatsMethod<'AUDIENCE_SNAPSHOT'> }>, 'growth'>
  | Omit<
      Extract<StatsAudienceSummary, { method: StatsMethod<'MAXFRAME_EXTERNAL_CALENDAR'> }>,
      'growth'
    >;
export type StatsAnalyticsReachValue = StatsReachSummary & { averageViews: StatsTotal | null };
export type StatsAnalyticsPublicationFrequency = {
  postsOnCompleteDates: number;
  completeDates: number;
  /** Exact unsigned decimal with one fractional digit. */
  averagePostsPerCompleteDate: string | null;
};
export type StatsAnalyticsPublicationValue = {
  metric: 'PUBLICATION_HOUR';
  horizon: 0;
  method: StatsMethod<'PUBLICATION_DAY_HOURS'>;
  count: number | null;
  hours: Array<number | null>;
  observedFrom: StatsTime | null;
  observedTo: StatsTime | null;
  frequency: StatsAnalyticsPublicationFrequency;
};
export type StatsAnalyticsAudienceGrowth =
  | {
      state: 'AVAILABLE';
      value: StatsAudienceGrowth & { fromValue: number; toValue: number; observationCount: number };
      percent: StatsAnalyticsPercentage;
    }
  | {
      state: 'UNAVAILABLE';
      reason: 'NO_DATA' | 'INSUFFICIENT_OBSERVATIONS' | 'INCOMPATIBLE_METHOD';
    };
export type StatsAnalyticsChange =
  | {
      field: 'AVERAGE_VIEWS';
      absolute: StatsAnalyticsSignedTotal;
      percent: StatsAnalyticsPercentage;
    }
  | {
      field: 'PUBLICATIONS' | 'JOINED' | 'LEFT';
      absolute: number;
      percent: StatsAnalyticsPercentage;
    };
export type StatsAnalyticsComparisonReason =
  | 'OUTSIDE_RETENTION'
  | 'VARIABLE_POST_AGE'
  | 'AUDIENCE_USES_GROWTH'
  | 'INSUFFICIENT_SAMPLES'
  | 'INCOMPLETE_COVERAGE'
  | 'IMMATURE_WINDOW'
  | 'NO_DATA'
  | 'UNSUPPORTED'
  | 'INCOMPATIBLE_METHOD'
  | 'NUMERIC_LIMIT';
export type StatsAnalyticsComparison<T> =
  | { state: 'NOT_REQUESTED' }
  | {
      state: 'UNAVAILABLE';
      reason: StatsAnalyticsComparisonReason;
      windows: { current: StatsAnalyticsWindow; previous: StatsAnalyticsWindow } | null;
    }
  | StatsAnalyticsSectionError
  | {
      state: 'AVAILABLE';
      current: { window: StatsAnalyticsWindow; value: T; quality: StatsAnalyticsQuality };
      previous: { window: StatsAnalyticsWindow; value: T; quality: StatsAnalyticsQuality };
      changes: StatsAnalyticsChange[];
    };
export type StatsAnalyticsMetricBase<T extends { metric: StatsMetric; horizon: StatsHorizon }> = {
  metric: T['metric'];
  horizon: T['horizon'];
  unit: 'PEOPLE' | 'VIEWS_PER_POST' | 'POSTS' | 'EVENTS';
  capability: 'SUPPORTED' | 'UNSUPPORTED';
  current: StatsAnalyticsWindowValue<T>;
  comparison: StatsAnalyticsComparison<T>;
};
export type StatsAnalyticsMetric =
  | (StatsAnalyticsMetricBase<StatsAnalyticsAudienceValue> & {
      growth: StatsAnalyticsAudienceGrowth;
    })
  | StatsAnalyticsMetricBase<StatsAnalyticsReachValue>
  | StatsAnalyticsMetricBase<StatsAnalyticsPublicationValue>
  | StatsAnalyticsMetricBase<StatsMembershipSummary>;
export type StatsAnalyticsAudienceChangeInterval = Pick<
  StatsAudienceGrowth,
  'fromDay' | 'toDay' | 'fromObservedAt' | 'toObservedAt'
>;
export type StatsAnalyticsAudienceDayChange =
  | { value: number; reason: null; interval: StatsAnalyticsAudienceChangeInterval }
  | {
      value: null;
      reason:
        | 'NO_CURRENT_OBSERVATION'
        | 'NO_PREVIOUS_OBSERVATION'
        | 'GAP_IN_OBSERVATIONS'
        | 'INCOMPATIBLE_METHOD';
      interval: StatsAnalyticsAudienceChangeInterval | null;
    };
type RowBase = {
  day: StatsDay;
  window: StatsAnalyticsWindow;
  freshness: StatsAnalyticsFreshness;
  health: StatsHealth;
};
type RowValue<T> =
  | {
      state: 'VALUE';
      value: T;
      coverage: StatsCoverage;
      provenance: StatsProvenance[];
      comparability: StatsAnalyticsComparability;
    }
  | { state: 'UNKNOWN'; reason: StatsUnavailableReason };
export type StatsAnalyticsHistoryRow = RowBase &
  (
    | ({
        metric: 'AUDIENCE';
        horizon: 0;
        method: StatsMethod<'AUDIENCE_SNAPSHOT'>;
        changeFromPrevious: StatsAnalyticsAudienceDayChange;
      } & RowValue<StatsAudienceValue>)
    | ({
        metric: 'AUDIENCE';
        horizon: 0;
        method: StatsMethod<'MAXFRAME_EXTERNAL_CALENDAR'>;
        changeFromPrevious: StatsAnalyticsAudienceDayChange;
      } & RowValue<StatsExternalAudienceValue>)
    | ({ metric: 'REACH'; horizon: 0; method: StatsMethod<'POST_PUBLICATION_DAY'> } & RowValue<
        StatsReachValue & { averageViews: StatsTotal | null }
      >)
    | ({
        metric: 'REACH';
        horizon: 24 | 48;
        method: StatsMethod<'TIMED_POST_PUBLICATION_DAY'>;
      } & RowValue<StatsReachValue & { averageViews: StatsTotal | null }>)
    | ({
        metric: 'MEMBERSHIP';
        horizon: 0;
        method: StatsMethod<'OBSERVED_MEMBER_EVENTS'>;
      } & RowValue<StatsMembershipValue>)
    | ({
        metric: 'PUBLICATION_HOUR';
        horizon: 0;
        method: StatsMethod<'PUBLICATION_DAY_HOURS'>;
      } & RowValue<StatsPublicationValue & { count: number | null }>)
  );
export type StatsAnalyticsOwnerPublicationBreakdown = {
  weekdays: Array<{ weekday: number } & StatsAnalyticsPublicationFrequency>;
  heatmap: Array<number | null>;
  activeDays: number | null;
  peakHour: number | null;
};
export type StatsAnalyticsHistory =
  | { state: 'NOT_REQUESTED' }
  | StatsAnalyticsSectionError
  | {
      state: 'READY';
      rows: StatsAnalyticsHistoryRow[];
      nextCursor: string | null;
      publicationBreakdown: StatsAnalyticsOwnerPublicationBreakdown | null;
    };
export type StatsAnalyticsPayload =
  | { page: 'INITIAL'; metrics: StatsAnalyticsMetric[]; history: StatsAnalyticsHistory }
  | { page: 'HISTORY'; history: Exclude<StatsAnalyticsHistory, { state: 'NOT_REQUESTED' }> };
export type StatsAnalyticsHeader = {
  contractVersion: 1;
  analyticsVersion: 1;
  asOf: StatsTime;
  revision: StatsReadRevision;
  contextId: string;
  entity: StatsEntity;
  purpose: StatsPurpose;
  periodDays: StatsPeriod;
  access: StatsReadAccess;
  historyAllowed: boolean;
};
export type StatsAnalyticsResult =
  | (StatsAnalyticsHeader & StatsAnalyticsPayload & { status: 'READY' })
  | (StatsErrorResult & { analyticsVersion: 1 });
export type StatsBrowserAnalyticsResult = Pick<
  StatsAnalyticsHeader,
  'analyticsVersion' | 'asOf' | 'revision' | 'purpose' | 'periodDays' | 'historyAllowed'
> & {
  entityKind: StatsEntity['kind'];
  validUntil: StatsTime;
} & StatsAnalyticsPayload;
