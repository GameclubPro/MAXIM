/** Design artifact. Portable wire source; mirror byte-for-byte after the r6 gate. */
export const STATS_CONTRACT_VERSION = 1 as const;
export const STATS_SELECTOR_VERSION = 1 as const;
export const STATISTICS_AUTHORITY_LIFECYCLE_VERSION = 2 as const;
export const STATS_CONTROLLER_PREFIX = 'v1/internal/statistics' as const;
export const STATS_HTTP_PREFIX = '/api/v1/internal/statistics' as const;
export const STATS_PRODUCTION_BASE_URL =
  'https://major-maksimov.ru/api/v1/internal/statistics' as const;
export const STATS_LIMITS = {
  retentionDays: 90,
  membershipLateDays: 30,
  receiptDays: 90,
  ingestOperations: 32,
  ingestBytes: 65_536,
  eventsPerOperation: 256,
  authorityOperations: 250,
  authorityBytes: 131_072,
  summaryContexts: 100,
  historyContexts: 32,
  historyRows: 256,
  readRequestBytes: 65_536,
  readResponseBytes: 524_288,
  changes: 250,
  changesBytes: 131_072,
  peerLeaseSeconds: 300,
  rightsTargetSeconds: 60,
  horizonToleranceSeconds: 900,
} as const;
export const STATS_ROUTES = {
  status: '/status',
  authorities: '/authorities:batch',
  authorityResolve: '/authorities:resolve',
  ingest: '/ingest',
  summaries: '/summaries:batch',
  history: '/history:batch',
  changes: '/changes',
} as const;

/** Decimal string, regex ^(0|[1-9][0-9]*)$, <= signed int64 max. */
export type StatsBig = string;
/** Unsigned aggregate decimal, <=30digits; permits 90 valid int64 day sums. */
export type StatsTotal = string;
/** Daily counts <=2_147_483_647; summary counts <=Number.MAX_SAFE_INTEGER. */
export type StatsCount = number;
/** UUID; validated at runtime. */
export type StatsUuid = string;
/** UTC RFC3339 timestamp; retained without Date precision truncation. */
export type StatsTime = string;
/** YYYY-MM-DD; axis/calendar is determined by the method. */
export type StatsDay = string;
/** Issuer's exact opaque SQL access fence, e.g. timestamptz::text. */
export type StatsLocalAccessFence = string;
export type StatsProducer = 'MAXIM' | 'EXCHANGE';
export type StatsPurpose = 'OWNER_ANALYTICS' | 'PUBLISHED_AGGREGATE';
export type StatsMetric = 'AUDIENCE' | 'MEMBERSHIP' | 'REACH' | 'PUBLICATION_HOUR';
export type StatsHorizon = 0 | 24 | 48;
export type StatsPeriod = 7 | 30 | 90;
export type StatsEntity = { kind: 'CHANNEL' | 'CHAT'; maxId: string };
export type StatsMethodId =
  | 'AUDIENCE_SNAPSHOT'
  | 'POST_PUBLICATION_DAY'
  | 'TIMED_POST_PUBLICATION_DAY'
  | 'RECENT_POST_SAMPLE_20'
  | 'PUBLICATION_DAY_HOURS'
  | 'OBSERVED_MEMBER_EVENTS'
  | 'MAXFRAME_EXTERNAL_CALENDAR';
export type StatsMethod<I extends StatsMethodId = StatsMethodId> = { id: I; version: 1 };
export type StatsAuthorityRef = { id: StatsUuid; epoch: StatsBig };
export type StatsCoverage = {
  state: 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';
  intervals: Array<{ from: StatsTime; to: StatsTime }>;
  populationComplete: boolean;
};
export type StatsScope<M extends StatsMetric, H extends StatsHorizon, I extends StatsMethodId> = {
  metric: M;
  horizon: H;
  method: StatsMethod<I>;
  day: StatsDay;
};
export type StatsAudienceScope = StatsScope<'AUDIENCE', 0, 'AUDIENCE_SNAPSHOT'>;
export type StatsExternalAudienceScope = StatsScope<'AUDIENCE', 0, 'MAXFRAME_EXTERNAL_CALENDAR'>;
export type StatsCurrentReachScope = StatsScope<'REACH', 0, 'POST_PUBLICATION_DAY'>;
export type StatsTimedReachScope = StatsScope<'REACH', 24 | 48, 'TIMED_POST_PUBLICATION_DAY'>;
export type StatsRecentReachScope = StatsScope<'REACH', 0, 'RECENT_POST_SAMPLE_20'>;
export type StatsPublicationScope = StatsScope<'PUBLICATION_HOUR', 0, 'PUBLICATION_DAY_HOURS'>;
export type StatsMembershipScope = StatsScope<'MEMBERSHIP', 0, 'OBSERVED_MEMBER_EVENTS'>;
export type StatsDayKey =
  | StatsAudienceScope
  | StatsExternalAudienceScope
  | StatsCurrentReachScope
  | StatsTimedReachScope
  | StatsRecentReachScope
  | StatsPublicationScope
  | StatsMembershipScope;
export type StatsAudienceValue = { value: number | null; observedAt: StatsTime | null };
export type StatsExternalAudienceValue = {
  value: number | null;
  observedAt: null;
  fetchedAt: StatsTime;
  calendarZone: 'UNSPECIFIED';
  lineage: 'MAXFRAME_EXTERNAL';
};
export type StatsReachValue = {
  views: StatsBig | null;
  samples: StatsCount;
  posts: StatsCount | null;
  observedFrom: StatsTime | null;
  observedTo: StatsTime | null;
  maxDelaySeconds: number | null;
};
export type StatsRecentReachValue = StatsReachValue & {
  publicationFrom: StatsTime | null;
  publicationTo: StatsTime | null;
};
export type StatsPublicationValue = {
  hours: Array<number | null>; // exactly24; native UTC hour bins
  observedFrom: StatsTime | null;
  observedTo: StatsTime | null;
};
export type StatsMembershipValue = {
  joined: number | null;
  left: number | null;
  observedFrom: StatsTime | null;
  observedTo: StatsTime | null;
};
type StatsReplace<K extends StatsDayKey, V> = K & {
  operation: 'REPLACE_DAY';
  sourceRevision: StatsBig;
  authority: StatsAuthorityRef;
  value: V;
  coverage: StatsCoverage;
};
/** Membership counters use ADD_EVENTS; no EXCHANGE absolute overwrite. */
export type StatsReplaceDay =
  | StatsReplace<StatsAudienceScope, StatsAudienceValue>
  | StatsReplace<StatsExternalAudienceScope, StatsExternalAudienceValue>
  | StatsReplace<StatsCurrentReachScope, StatsReachValue>
  | StatsReplace<StatsTimedReachScope, StatsReachValue>
  | StatsReplace<StatsRecentReachScope, StatsRecentReachValue>
  | StatsReplace<StatsPublicationScope, StatsPublicationValue>;
export type StatsDeleteDay = StatsDayKey & {
  operation: 'DELETE_DAY';
  sourceRevision: StatsBig;
  authority: StatsAuthorityRef;
};
export type StatsMembershipEvent = {
  eventId: StatsUuid;
  capturedRevision: StatsBig;
  eventType: 'JOIN' | 'LEAVE';
  eventAt: StatsTime;
  observedAt: StatsTime;
};
export type StatsAddEvents = {
  operation: 'ADD_EVENTS';
  metric: 'MEMBERSHIP';
  horizon: 0;
  method: StatsMethod<'OBSERVED_MEMBER_EVENTS'>;
  authority: StatsAuthorityRef;
  events: StatsMembershipEvent[];
};
export type StatsHealthError =
  | 'SOURCE_UNAVAILABLE'
  | 'ACCESS_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INCOMPLETE_SCAN'
  | 'MISSED_HORIZON';
export type StatsHealth = {
  state: 'UNKNOWN' | 'OK' | 'ERROR';
  lastAttemptAt: StatsTime | null;
  lastSuccessAt: StatsTime | null;
  nextExpectedAt: StatsTime | null;
  errorCode: StatsHealthError | null;
};
export type StatsMetricKey =
  | Omit<StatsAudienceScope, 'day'>
  | Omit<StatsExternalAudienceScope, 'day'>
  | Omit<StatsCurrentReachScope, 'day'>
  | Omit<StatsTimedReachScope, 'day'>
  | Omit<StatsRecentReachScope, 'day'>
  | Omit<StatsPublicationScope, 'day'>
  | Omit<StatsMembershipScope, 'day'>;
export type StatsReportHealth = StatsMetricKey & {
  operation: 'REPORT_HEALTH';
  sourceRevision: StatsBig;
  authority: StatsAuthorityRef;
  health: StatsHealth;
};
export type StatsIngestRequest = {
  contractVersion: 1;
  requestId: StatsUuid;
  producerEpoch: StatsUuid;
  entity: StatsEntity;
  operations: Array<StatsReplaceDay | StatsDeleteDay | StatsAddEvents | StatsReportHealth>;
};
export type StatsIngestStatus = 'APPLIED' | 'DUPLICATE' | 'SUPERSEDED' | 'SKIPPED_INCOMPLETE';
export type StatsIngestResult = {
  contractVersion: 1;
  requestId: StatsUuid;
  entityRevision: StatsBig;
  results: Array<{
    index: number;
    status: StatsIngestStatus;
    seenRevision: StatsBig | null;
    valueRevision: StatsBig | null;
    acceptedEvents: number | null;
  }>;
};

export type StatsAuthorityOperation = {
  id: StatsUuid;
  revision: StatsBig; // issuer grant/policy revision, stable during pure lease renewal
  operation: 'ATTEST' | 'REVOKE';
  entity: StatsEntity;
  role: 'SOURCE' | 'CONSUMER';
  actorMaxUserId: string;
  botRef: string;
  consumer: StatsProducer;
  purpose: StatsPurpose;
  scopes: StatsMetricKey[];
  checkedAt: StatsTime; // this current-proof attestation, not old native observation time
  producerEpoch: StatsUuid;
  localAccessFence: StatsLocalAccessFence;
  supersedes?: { id: StatsUuid; revision: StatsBig; epoch: StatsBig };
};
/** Exact issuer scope only; resolving an identity does not grant access. */
export type StatsAuthorityResolveRequest = {
  contractVersion: 1;
  producerEpoch: StatsUuid;
  entity: StatsEntity;
  role: 'SOURCE' | 'CONSUMER';
  actorMaxUserId: string;
  botRef: string;
  consumer: StatsProducer;
  purpose: StatsPurpose;
};
export type StatsAuthorityResolveResult = {
  contractVersion: 1;
  head: {
    id: StatsUuid;
    revision: StatsBig;
    epoch: StatsBig;
    state: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  } | null;
};
export type StatsAuthorityRequest = {
  contractVersion: 1;
  requestId: StatsUuid;
  operations: StatsAuthorityOperation[];
};
export type StatsAuthorityState = 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'UNAVAILABLE';
export type StatsAuthorityResult = {
  contractVersion: 1;
  requestId: StatsUuid;
  results: Array<{
    index: number;
    id: StatsUuid;
    epoch: StatsBig;
    state: StatsAuthorityState;
    status: 'APPLIED' | 'RENEWED' | 'DUPLICATE' | 'SUPERSEDED' | 'DENIED';
    peerValidUntil: StatsTime | null;
    errorCode: 'FORBIDDEN' | 'STALE_LOCAL_FENCE' | 'RETIRED_PRODUCER_EPOCH' | null;
  }>;
};
/** Stable registry SOURCE id wraps exact native SQL authority; it is not a binding FK. */
export type StatsSourceDependency = {
  producer: StatsProducer;
  purpose: StatsPurpose;
  scope: StatsMetricKey;
  sourceAuthorityId: StatsUuid;
  sourceAuthorityEpoch: StatsBig;
  consumerAuthorityId: StatsUuid;
  consumerAuthorityEpoch: StatsBig;
  peerValidUntil: StatsTime;
};
export type StatsReadContext = {
  contextId: StatsUuid;
  entity: StatsEntity;
  actorMaxUserId: string;
  purpose: StatsPurpose;
  consumerAuthority: StatsAuthorityRef;
};
export type StatsReadRevision = {
  canonicalRevision: StatsBig;
  entityRevision: StatsBig;
  selectorVersion: 1;
};
export type StatsReadAccess = {
  viewId: StatsUuid;
  sourceAuthorityDependencies: StatsSourceDependency[];
  validUntil: StatsTime;
};
export type StatsUnavailableReason =
  | 'NO_DATA'
  | 'UNSUPPORTED'
  | 'SOURCE_UNAVAILABLE'
  | 'EXPIRED_AUTHORITY'
  | 'NOT_REQUESTED'
  | 'NUMERIC_LIMIT'
  | 'INCOMPATIBLE_METHOD';
export type StatsProvenance = {
  producer: StatsProducer;
  method: StatsMethod;
  lineage: 'NATIVE' | 'MAXFRAME_EXTERNAL';
};
/** Computed centrally; clients never infer compatible growth from equal labels. */
export type StatsComparability = {
  key: string;
  segmentId: string;
  axis: 'OBSERVATION_DAY' | 'PUBLICATION_DAY' | 'EVENT_DAY' | 'EXTERNAL_CALENDAR_DAY';
  calendarZone: 'UTC' | 'UNSPECIFIED';
  previousComparableDay: StatsDay | null;
  sourceTransition: boolean;
};
export type StatsAudienceGrowth = {
  comparabilityKey: string;
  fromDay: StatsDay;
  toDay: StatsDay;
  fromObservedAt: StatsTime;
  toObservedAt: StatsTime;
  delta: number;
  sourceTransition: boolean;
  completePeriod: boolean;
};
export type StatsSummaryCoverage = {
  state: 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';
  requestedDays: StatsPeriod;
  knownDays: number;
  completeDays: number;
  populationComplete: boolean;
};
export type StatsMetricResult<T> =
  | {
      state: 'AVAILABLE';
      value: T;
      coverage: StatsSummaryCoverage;
      provenance: StatsProvenance[];
      comparability: StatsComparability;
      sourceAuthorityDependencies: StatsSourceDependency[];
      health: StatsHealth;
    }
  | {
      state: 'UNAVAILABLE';
      reason: StatsUnavailableReason;
      health: StatsHealth;
    };
export type StatsAudienceSummary =
  | {
      metric: 'AUDIENCE';
      horizon: 0;
      method: StatsMethod<'AUDIENCE_SNAPSHOT'>;
      value: number;
      observedAt: StatsTime;
      growth: StatsAudienceGrowth | null;
    }
  | {
      metric: 'AUDIENCE';
      horizon: 0;
      method: StatsMethod<'MAXFRAME_EXTERNAL_CALENDAR'>;
      value: number;
      day: StatsDay;
      observedAt: null;
      fetchedAt: StatsTime;
      calendarZone: 'UNSPECIFIED';
      growth: null;
    };
export type StatsReachTotal = Omit<StatsReachValue, 'views'> & { views: StatsTotal | null };
export type StatsReachSummary =
  | (Omit<StatsCurrentReachScope, 'day'> & StatsReachTotal)
  | (Omit<StatsTimedReachScope, 'day'> & StatsReachTotal);
export type StatsRecentReachSummary = {
  metric: 'REACH';
  horizon: 0;
  method: StatsMethod<'RECENT_POST_SAMPLE_20'>;
} & StatsRecentReachValue;
export type StatsMembershipSummary = StatsMembershipValue & {
  metric: 'MEMBERSHIP';
  horizon: 0;
  method: StatsMethod<'OBSERVED_MEMBER_EVENTS'>;
};
export type StatsPublicationSummary = {
  metric: 'PUBLICATION_HOUR';
  horizon: 0;
  method: StatsMethod<'PUBLICATION_DAY_HOURS'>;
  count: number | null;
  hours: Array<number | null>; // exactly24 aggregated comparable UTC bins
  observedFrom: StatsTime | null;
  observedTo: StatsTime | null;
};
export type StatsSummary = {
  audience: StatsMetricResult<StatsAudienceSummary>;
  recentPostSample: StatsMetricResult<StatsRecentReachSummary>;
  reach: {
    current: StatsMetricResult<StatsReachSummary & { horizon: 0 }>;
    at24h: StatsMetricResult<StatsReachSummary & { horizon: 24 }>;
    at48h: StatsMetricResult<StatsReachSummary & { horizon: 48 }>;
  };
  membership: StatsMetricResult<StatsMembershipSummary>;
  publications: StatsMetricResult<StatsPublicationSummary>;
};
export type StatsSummaryRequest = {
  contractVersion: 1;
  contexts: StatsReadContext[];
  periods: StatsPeriod[];
  metrics: StatsMetric[];
  horizons: StatsHorizon[];
  cursor: string | null;
};
export type StatsSummaryItem =
  | {
      contextId: StatsUuid;
      entity: StatsEntity;
      periodDays: StatsPeriod;
      status: 'READY';
      revision: StatsReadRevision;
      access: StatsReadAccess;
      summary: StatsSummary;
    }
  | {
      contextId: StatsUuid;
      entity: StatsEntity;
      periodDays: StatsPeriod;
      status: 'UNAVAILABLE' | 'FORBIDDEN';
      reason: StatsUnavailableReason | 'FORBIDDEN';
    };
export type StatsSummaryResult = {
  contractVersion: 1;
  asOf: StatsTime; // calculation time, never observation freshness
  results: StatsSummaryItem[];
  nextCursor: string | null;
};
type StatsHistoryValue<K extends StatsDayKey, V> = K & {
  state: 'VALUE';
  value: V;
  coverage: StatsCoverage;
  provenance: StatsProvenance;
  comparability: StatsComparability;
  sourceAuthorityDependencies: StatsSourceDependency[];
  health: StatsHealth;
};
export type StatsHistoryRow =
  | (StatsHistoryValue<StatsAudienceScope, StatsAudienceValue> & {
      growthFromPrevious: StatsAudienceGrowth | null;
    })
  | StatsHistoryValue<StatsExternalAudienceScope, StatsExternalAudienceValue>
  | StatsHistoryValue<StatsCurrentReachScope, StatsReachValue>
  | StatsHistoryValue<StatsTimedReachScope, StatsReachValue>
  | StatsHistoryValue<StatsRecentReachScope, StatsRecentReachValue>
  | StatsHistoryValue<StatsPublicationScope, StatsPublicationValue>
  | StatsHistoryValue<StatsMembershipScope, StatsMembershipValue>
  | (StatsDayKey & {
      state: 'UNKNOWN';
      reason: StatsUnavailableReason;
      health: StatsHealth;
    });
export type StatsHistoryRequest = {
  contractVersion: 1;
  contexts: StatsReadContext[];
  periodDays: StatsPeriod;
  metrics: StatsMetric[];
  horizons: StatsHorizon[];
  methods: StatsMethodId[];
  rowLimit: number;
  cursor: string | null;
};
export type StatsHistoryItem =
  | {
      contextId: StatsUuid;
      entity: StatsEntity;
      status: 'READY';
      revision: StatsReadRevision;
      access: StatsReadAccess;
      rows: StatsHistoryRow[];
    }
  | {
      contextId: StatsUuid;
      entity: StatsEntity;
      status: 'UNAVAILABLE' | 'FORBIDDEN';
      reason: StatsUnavailableReason | 'FORBIDDEN';
    };
export type StatsHistoryResult = {
  contractVersion: 1;
  asOf: StatsTime;
  results: StatsHistoryItem[];
  nextCursor: string | null;
};
export type StatsChange =
  | {
      action: 'REFRESH';
      viewId: StatsUuid;
      entity: StatsEntity;
      entityRevision: StatsBig;
    }
  | {
      action: 'REVOKE';
      viewId: StatsUuid;
      authorityId: StatsUuid;
      authorityEpoch: StatsBig;
    };
export type StatsChangesResult = {
  contractVersion: 1;
  asOf: StatsTime;
  items: StatsChange[];
  nextCursor: string;
  hasMore: boolean;
};
export type StatsStatusResult = {
  contractVersion: 1;
  selectorVersion: 1;
  enabled: boolean;
  centralReady: boolean;
  producerEpoch: StatsUuid | null;
  storeMode: 'LEGACY' | 'CENTRAL';
  legacyHistory: { imports: 'ACTIVE' | 'RETIRED'; exports: 'ACTIVE' | 'RETIRED' };
  capabilities: Array<'AUTHORITIES' | 'INGEST' | 'SUMMARIES' | 'HISTORY' | 'CHANGES'>;
};
export type StatsErrorCode =
  | 'INVALID_REQUEST'
  | 'BODY_TOO_LARGE'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RETIRED_PRODUCER_EPOCH'
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EVENT_CONFLICT'
  | 'READ_RESTART'
  | 'CURSOR_EXPIRED'
  | 'STALE_LOCAL_FENCE'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE';
export type StatsErrorResult = {
  contractVersion: 1;
  error: {
    code: StatsErrorCode;
    requestId: string;
    retryable: boolean;
    retryAfterSeconds: number | null;
  };
};
