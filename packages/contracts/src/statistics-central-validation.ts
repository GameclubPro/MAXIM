import { z } from 'zod';
import {
  STATS_LIMITS,
  type StatsAuthorityRequest,
  type StatsAuthorityResult,
  type StatsIngestRequest,
  type StatsIngestResult,
  type StatsSummaryRequest,
  type StatsSummaryResult,
  type StatsHistoryRequest,
  type StatsHistoryResult,
  type StatsChangesResult,
  type StatsStatusResult,
  type StatsErrorResult,
} from './statistics-central.js';

const typed = <T>(schema: z.ZodTypeAny): z.ZodType<T> => schema as z.ZodType<T>;
const timeKey = (value: string) =>
  `${value.slice(0, 19)}.${(value.split('.')[1]?.slice(0, -1) ?? '').padEnd(6, '0')}`;
const issue = (ctx: z.RefinementCtx, message: string) => ctx.addIssue({ code: 'custom', message });
const int64 = 9_223_372_036_854_775_807n;
const int32 = 2_147_483_647;
const big = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/u)
  .max(19)
  .refine((v) => /^(0|[1-9][0-9]*)$/u.test(v) && v.length <= 19 && BigInt(v) <= int64);
const positive = big.refine((v) => v !== '0');
const total = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/u)
  .max(30);
const uuid = z.string().uuid();
const text = z.string().min(1).max(512);
const time = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u)
  .refine(
    (v) =>
      Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19),
  );
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });
const count = z.number().int().min(0).max(int32);
const safeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const metric = z.enum(['AUDIENCE', 'MEMBERSHIP', 'REACH', 'PUBLICATION_HOUR']);
const purpose = z.enum(['OWNER_ANALYTICS', 'PUBLISHED_AGGREGATE']);
const producer = z.enum(['MAXIM', 'EXCHANGE']);
const horizon = z.union([z.literal(0), z.literal(24), z.literal(48)]);
const period = z.union([z.literal(7), z.literal(30), z.literal(90)]);
const methodId = z.enum([
  'AUDIENCE_SNAPSHOT',
  'POST_PUBLICATION_DAY',
  'TIMED_POST_PUBLICATION_DAY',
  'RECENT_POST_SAMPLE_20',
  'PUBLICATION_DAY_HOURS',
  'OBSERVED_MEMBER_EVENTS',
  'MAXFRAME_EXTERNAL_CALENDAR',
]);
const entity = z
  .object({ kind: z.enum(['CHANNEL', 'CHAT']), maxId: z.string().regex(/^-[1-9]\d{0,19}$/u) })
  .strict();
const actor = z.string().regex(/^[1-9]\d{0,19}$/u);
const method = z.object({ id: methodId, version: z.literal(1) }).strict();
const authority = z.object({ id: uuid, epoch: positive }).strict();
const intervals = z
  .array(z.object({ from: time, to: time }).strict())
  .max(512)
  .superRefine((rows, ctx) => {
    let end = '';
    for (const row of rows) {
      if (timeKey(row.from) >= timeKey(row.to) || timeKey(row.from) < end)
        issue(ctx, 'Invalid or overlapping coverage');
      end = timeKey(row.to);
    }
  });
const coverage = z
  .object({
    state: z.enum(['COMPLETE', 'PARTIAL', 'UNKNOWN']),
    intervals,
    populationComplete: z.boolean(),
  })
  .strict();
const scope = <M extends string, H extends z.ZodTypeAny, I extends string>(m: M, h: H, id: I) =>
  z
    .object({
      metric: z.literal(m),
      horizon: h,
      method: z.object({ id: z.literal(id), version: z.literal(1) }).strict(),
    })
    .strict();
const audienceScope = scope('AUDIENCE', z.literal(0), 'AUDIENCE_SNAPSHOT');
const externalScope = scope('AUDIENCE', z.literal(0), 'MAXFRAME_EXTERNAL_CALENDAR');
const currentScope = scope('REACH', z.literal(0), 'POST_PUBLICATION_DAY');
const timedScope = scope(
  'REACH',
  z.union([z.literal(24), z.literal(48)]),
  'TIMED_POST_PUBLICATION_DAY',
);
const recentScope = scope('REACH', z.literal(0), 'RECENT_POST_SAMPLE_20');
const publicationScope = scope('PUBLICATION_HOUR', z.literal(0), 'PUBLICATION_DAY_HOURS');
const membershipScope = scope('MEMBERSHIP', z.literal(0), 'OBSERVED_MEMBER_EVENTS');
const scopes = [
  audienceScope,
  externalScope,
  currentScope,
  timedScope,
  recentScope,
  publicationScope,
  membershipScope,
] as const;
export const statsMetricKeySchema = z.union(scopes);
export const statsDayKeySchema = z.union(
  scopes.map((s) => s.extend({ day })) as unknown as unknown as [
    z.ZodTypeAny,
    z.ZodTypeAny,
    ...z.ZodTypeAny[],
  ],
);
const audienceValue = z.object({ value: count.nullable(), observedAt: time.nullable() }).strict();
const externalValue = z
  .object({
    value: count.nullable(),
    observedAt: z.null(),
    fetchedAt: time,
    calendarZone: z.literal('UNSPECIFIED'),
    lineage: z.literal('MAXFRAME_EXTERNAL'),
  })
  .strict();
function validateReach(
  v: {
    views: string | null;
    samples: number;
    posts: number | null;
    observedFrom: string | null;
    observedTo: string | null;
  },
  ctx: z.RefinementCtx,
) {
  if (v.posts !== null && v.samples > v.posts) issue(ctx, 'Samples exceed population');
  if (v.views === null && v.samples > 0) issue(ctx, 'Measured samples require an exact sum');
  if (
    v.views !== null &&
    /^(0|[1-9][0-9]*)$/u.test(v.views) &&
    v.views.length <= 30 &&
    BigInt(v.views) > BigInt(v.samples) * BigInt(int32)
  )
    issue(ctx, 'Views exceed native post counter bounds');
  if (v.samples > 0 && (!v.observedFrom || !v.observedTo))
    issue(ctx, 'Samples require actual observation timestamps');
  if (v.observedFrom && v.observedTo && timeKey(v.observedFrom) > timeKey(v.observedTo))
    issue(ctx, 'Invalid observation range');
}
const reachShape = {
  views: big.nullable(),
  samples: count,
  posts: count.nullable(),
  observedFrom: time.nullable(),
  observedTo: time.nullable(),
  maxDelaySeconds: z.number().int().min(0).max(900).nullable(),
};
const reachValue = z.object(reachShape).strict().superRefine(validateReach);
const recentValue = z
  .object({
    ...reachShape,
    samples: count.max(20),
    posts: count.max(20).nullable(),
    publicationFrom: time.nullable(),
    publicationTo: time.nullable(),
  })
  .strict()
  .superRefine(validateReach);
const publicationValue = z
  .object({
    hours: z.array(count.nullable()).length(24),
    observedFrom: time.nullable(),
    observedTo: time.nullable(),
  })
  .strict()
  .refine(
    (v) => v.hours.reduce<number>((n, value) => n + (value ?? 0), 0) <= int32,
    'Daily count exceeds storage range',
  );
const membershipValue = z
  .object({
    joined: count.nullable(),
    left: count.nullable(),
    observedFrom: time.nullable(),
    observedTo: time.nullable(),
  })
  .strict();
const replace = <S extends z.core.$ZodShape>(s: z.ZodObject<S>, value: z.ZodTypeAny) =>
  s
    .extend({
      day,
      operation: z.literal('REPLACE_DAY'),
      sourceRevision: positive,
      authority,
      value,
      coverage,
    })
    .strict();
const replacements = [
  replace(audienceScope, audienceValue),
  replace(externalScope, externalValue),
  replace(currentScope, reachValue),
  replace(timedScope, reachValue),
  replace(recentScope, recentValue),
  replace(publicationScope, publicationValue),
];
const deletes = scopes.map((s) =>
  s
    .extend({ day, operation: z.literal('DELETE_DAY'), sourceRevision: positive, authority })
    .strict(),
);
const event = z
  .object({
    eventId: uuid,
    capturedRevision: positive,
    eventType: z.enum(['JOIN', 'LEAVE']),
    eventAt: time,
    observedAt: time,
  })
  .strict()
  .refine(
    (v) => Date.parse(v.eventAt) <= Date.parse(v.observedAt) + 60_000,
    'Event clock lead exceeds 60 seconds',
  );
const events = membershipScope
  .extend({
    operation: z.literal('ADD_EVENTS'),
    authority,
    events: z.array(event).min(1).max(STATS_LIMITS.eventsPerOperation),
  })
  .strict();
const health = z
  .object({
    state: z.enum(['UNKNOWN', 'OK', 'ERROR']),
    lastAttemptAt: time.nullable(),
    lastSuccessAt: time.nullable(),
    nextExpectedAt: time.nullable(),
    errorCode: z
      .enum([
        'SOURCE_UNAVAILABLE',
        'ACCESS_UNAVAILABLE',
        'RATE_LIMITED',
        'INCOMPLETE_SCAN',
        'MISSED_HORIZON',
      ])
      .nullable(),
  })
  .strict()
  .refine(
    (v) => (v.state === 'ERROR' ? v.errorCode !== null : v.errorCode === null),
    'Health error mismatch',
  );
const reports = scopes.map((s) =>
  s
    .extend({ operation: z.literal('REPORT_HEALTH'), sourceRevision: positive, authority, health })
    .strict(),
);
const operation = z.union([...replacements, ...deletes, events, ...reports] as unknown as [
  z.ZodTypeAny,
  z.ZodTypeAny,
  ...z.ZodTypeAny[],
]);
export const statsIngestRequestSchema = typed<StatsIngestRequest>(
  z
    .object({
      contractVersion: z.literal(1),
      requestId: uuid,
      producerEpoch: uuid,
      entity,
      operations: z.array(operation).min(1).max(STATS_LIMITS.ingestOperations),
    })
    .strict()
    .superRefine((v, ctx) => {
      const keys = new Set<string>();
      for (const raw of v.operations) {
        const op = raw as Record<string, unknown> & {
          metric: string;
          horizon: number;
          method: { id: string };
          operation: string;
          day?: string;
          value?: { samples?: number; maxDelaySeconds?: number | null };
          coverage?: { state: string; populationComplete: boolean };
        };
        if (v.entity.kind === 'CHAT' && (op.metric === 'REACH' || op.metric === 'PUBLICATION_HOUR'))
          issue(ctx, 'Unsupported chat metric');
        const key = `${op.operation === 'REPORT_HEALTH' ? 'health' : 'data'}:${op.metric}:${op.horizon}:${op.method.id}:${op.day ?? ''}`;
        if (op.operation !== 'ADD_EVENTS' && keys.has(key)) issue(ctx, 'Duplicate scope');
        keys.add(key);
        if (
          op.metric === 'REACH' &&
          op.horizon > 0 &&
          op.value &&
          (op.value.samples ?? 0) > 0 &&
          op.value.maxDelaySeconds === null
        )
          issue(ctx, 'Timed samples require valid age delay');
        if (op.coverage?.state === 'COMPLETE' && !op.coverage.populationComplete)
          issue(ctx, 'Incomplete population cannot be complete');
      }
    }),
);
export const statsIngestResultSchema = typed<StatsIngestResult>(
  z
    .object({
      contractVersion: z.literal(1),
      requestId: uuid,
      entityRevision: big,
      results: z
        .array(
          z
            .object({
              index: count.max(31),
              status: z.enum(['APPLIED', 'DUPLICATE', 'SUPERSEDED', 'SKIPPED_INCOMPLETE']),
              seenRevision: big.nullable(),
              valueRevision: big.nullable(),
              acceptedEvents: count.nullable(),
            })
            .strict(),
        )
        .max(32),
    })
    .strict(),
);

const authorityOperation = z
  .object({
    id: uuid,
    revision: positive,
    operation: z.enum(['ATTEST', 'REVOKE']),
    entity,
    role: z.enum(['SOURCE', 'CONSUMER']),
    actorMaxUserId: actor,
    botRef: text,
    consumer: producer,
    purpose,
    scopes: z.array(statsMetricKeySchema).min(1).max(32),
    checkedAt: time,
    producerEpoch: uuid,
    localAccessFence: z.string().min(1).max(512),
  })
  .strict();
export const statsAuthorityRequestSchema = typed<StatsAuthorityRequest>(
  z
    .object({
      contractVersion: z.literal(1),
      requestId: uuid,
      operations: z.array(authorityOperation).min(1).max(STATS_LIMITS.authorityOperations),
    })
    .strict(),
);
export const statsAuthorityResultSchema = typed<StatsAuthorityResult>(
  z
    .object({
      contractVersion: z.literal(1),
      requestId: uuid,
      results: z
        .array(
          z
            .object({
              index: count.max(249),
              id: uuid,
              epoch: big,
              state: z.enum(['ACTIVE', 'REVOKED', 'EXPIRED', 'UNAVAILABLE']),
              status: z.enum(['APPLIED', 'RENEWED', 'DUPLICATE', 'SUPERSEDED', 'DENIED']),
              peerValidUntil: time.nullable(),
              errorCode: z
                .enum(['FORBIDDEN', 'STALE_LOCAL_FENCE', 'RETIRED_PRODUCER_EPOCH'])
                .nullable(),
            })
            .strict(),
        )
        .max(250),
    })
    .strict(),
);
const dependency = z
  .object({
    producer,
    purpose,
    scope: statsMetricKeySchema,
    sourceAuthorityId: uuid,
    sourceAuthorityEpoch: positive,
    consumerAuthorityId: uuid,
    consumerAuthorityEpoch: positive,
    peerValidUntil: time,
  })
  .strict();
const context = z
  .object({ contextId: uuid, entity, actorMaxUserId: actor, purpose, consumerAuthority: authority })
  .strict();
const revision = z
  .object({ canonicalRevision: big, entityRevision: big, selectorVersion: z.literal(1) })
  .strict();
const access = z
  .object({
    viewId: uuid,
    sourceAuthorityDependencies: z.array(dependency).max(64),
    validUntil: time,
  })
  .strict();
const unavailableReason = z.enum([
  'NO_DATA',
  'UNSUPPORTED',
  'SOURCE_UNAVAILABLE',
  'EXPIRED_AUTHORITY',
  'NOT_REQUESTED',
  'NUMERIC_LIMIT',
  'INCOMPATIBLE_METHOD',
]);
const provenance = z
  .object({ producer, method, lineage: z.enum(['NATIVE', 'MAXFRAME_EXTERNAL']) })
  .strict();
const comparability = z
  .object({
    key: text,
    segmentId: text,
    axis: z.enum(['OBSERVATION_DAY', 'PUBLICATION_DAY', 'EVENT_DAY', 'EXTERNAL_CALENDAR_DAY']),
    calendarZone: z.enum(['UTC', 'UNSPECIFIED']),
    previousComparableDay: day.nullable(),
    sourceTransition: z.boolean(),
  })
  .strict();
const growth = z
  .object({
    comparabilityKey: text,
    fromDay: day,
    toDay: day,
    fromObservedAt: time,
    toObservedAt: time,
    delta: z.number().int().min(-int32).max(int32),
    sourceTransition: z.boolean(),
    completePeriod: z.boolean(),
  })
  .strict();
const summaryCoverage = z
  .object({
    state: z.enum(['COMPLETE', 'PARTIAL', 'UNKNOWN']),
    requestedDays: period,
    knownDays: safeCount.max(90),
    completeDays: safeCount.max(90),
    populationComplete: z.boolean(),
  })
  .strict()
  .refine((v) => v.completeDays <= v.knownDays && v.knownDays <= v.requestedDays);
const metricResult = (value: z.ZodTypeAny) =>
  z.union([
    z
      .object({
        state: z.literal('AVAILABLE'),
        value,
        coverage: summaryCoverage,
        provenance: z.array(provenance).min(1).max(16),
        comparability,
        sourceAuthorityDependencies: z.array(dependency).min(1).max(64),
        health,
      })
      .strict(),
    z.object({ state: z.literal('UNAVAILABLE'), reason: unavailableReason, health }).strict(),
  ]);
const audienceSummary = z.union([
  audienceScope.extend({ value: count, observedAt: time, growth: growth.nullable() }).strict(),
  externalScope
    .extend({
      value: count,
      day,
      observedAt: z.null(),
      fetchedAt: time,
      calendarZone: z.literal('UNSPECIFIED'),
      growth: z.null(),
    })
    .strict(),
]);
const summaryReachShape = {
  ...reachShape,
  views: total.nullable(),
  samples: safeCount,
  posts: safeCount.nullable(),
};
const reachSummary = <S extends z.core.$ZodShape>(s: z.ZodObject<S>) =>
  s
    .extend(summaryReachShape)
    .strict()
    .superRefine((v, ctx) => validateReach(v as Parameters<typeof validateReach>[0], ctx));
const currentSummary = reachSummary(currentScope);
const at24Summary = reachSummary(scope('REACH', z.literal(24), 'TIMED_POST_PUBLICATION_DAY'));
const at48Summary = reachSummary(scope('REACH', z.literal(48), 'TIMED_POST_PUBLICATION_DAY'));
const recentSummary = recentScope
  .extend({
    ...reachShape,
    samples: count.max(20),
    posts: count.max(20).nullable(),
    publicationFrom: time.nullable(),
    publicationTo: time.nullable(),
  })
  .strict()
  .superRefine(validateReach);
const membershipSummary = membershipScope
  .extend({
    joined: safeCount.nullable(),
    left: safeCount.nullable(),
    observedFrom: time.nullable(),
    observedTo: time.nullable(),
  })
  .strict();
const publicationSummary = publicationScope
  .extend({
    count: safeCount.nullable(),
    hours: z.array(safeCount.nullable()).length(24),
    observedFrom: time.nullable(),
    observedTo: time.nullable(),
  })
  .strict();
const summary = z
  .object({
    audience: metricResult(audienceSummary),
    recentPostSample: metricResult(recentSummary),
    reach: z
      .object({
        current: metricResult(currentSummary),
        at24h: metricResult(at24Summary),
        at48h: metricResult(at48Summary),
      })
      .strict(),
    membership: metricResult(membershipSummary),
    publications: metricResult(publicationSummary),
  })
  .strict();
const cursor = z.string().min(1).max(8192).nullable();
const readFilters = {
  contractVersion: z.literal(1),
  contexts: z.array(context).min(1),
  metrics: z.array(metric).min(1).max(4),
  horizons: z.array(horizon).min(1).max(3),
  cursor,
};
export const statsSummaryRequestSchema = typed<StatsSummaryRequest>(
  z
    .object({
      ...readFilters,
      contexts: z.array(context).min(1).max(STATS_LIMITS.summaryContexts),
      periods: z.array(period).min(1).max(3),
    })
    .strict(),
);
const deniedSummary = z
  .object({
    contextId: uuid,
    entity,
    periodDays: period,
    status: z.enum(['UNAVAILABLE', 'FORBIDDEN']),
    reason: z.union([unavailableReason, z.literal('FORBIDDEN')]),
  })
  .strict();
export const statsSummaryResultSchema = typed<StatsSummaryResult>(
  z
    .object({
      contractVersion: z.literal(1),
      asOf: time,
      results: z
        .array(
          z.union([
            z
              .object({
                contextId: uuid,
                entity,
                periodDays: period,
                status: z.literal('READY'),
                revision,
                access,
                summary,
              })
              .strict(),
            deniedSummary,
          ]),
        )
        .max(300),
      nextCursor: cursor,
    })
    .strict(),
);
const history = <S extends z.core.$ZodShape>(s: z.ZodObject<S>, value: z.ZodTypeAny, extra = {}) =>
  s
    .extend({
      day,
      state: z.literal('VALUE'),
      value,
      coverage,
      provenance,
      comparability,
      sourceAuthorityDependencies: z.array(dependency).min(1).max(64),
      health,
      ...extra,
    })
    .strict();
const historyVariants = [
  history(audienceScope, audienceValue, { growthFromPrevious: growth.nullable() }),
  history(externalScope, externalValue),
  history(currentScope, reachValue),
  history(timedScope, reachValue),
  history(recentScope, recentValue),
  history(publicationScope, publicationValue),
  history(membershipScope, membershipValue),
  ...scopes.map((s) =>
    s.extend({ day, state: z.literal('UNKNOWN'), reason: unavailableReason, health }).strict(),
  ),
];
export const statsHistoryRowSchema = z.union(
  historyVariants as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
);
export const statsHistoryRequestSchema = typed<StatsHistoryRequest>(
  z
    .object({
      ...readFilters,
      contexts: z.array(context).min(1).max(STATS_LIMITS.historyContexts),
      periodDays: period,
      methods: z.array(methodId).min(1).max(7),
      rowLimit: z.number().int().min(1).max(STATS_LIMITS.historyRows),
    })
    .strict(),
);
export const statsHistoryResultSchema = typed<StatsHistoryResult>(
  z
    .object({
      contractVersion: z.literal(1),
      asOf: time,
      results: z
        .array(
          z.union([
            z
              .object({
                contextId: uuid,
                entity,
                status: z.literal('READY'),
                revision,
                access,
                rows: z.array(statsHistoryRowSchema).max(256),
              })
              .strict(),
            z
              .object({
                contextId: uuid,
                entity,
                status: z.enum(['UNAVAILABLE', 'FORBIDDEN']),
                reason: z.union([unavailableReason, z.literal('FORBIDDEN')]),
              })
              .strict(),
          ]),
        )
        .max(32),
      nextCursor: cursor,
    })
    .strict()
    .refine(
      (v) => v.results.reduce((n, item) => n + ('rows' in item ? item.rows.length : 0), 0) <= 256,
      'History row budget exceeded',
    ),
);
export const statsChangesResultSchema = typed<StatsChangesResult>(
  z
    .object({
      contractVersion: z.literal(1),
      asOf: time,
      items: z
        .array(
          z.union([
            z
              .object({ action: z.literal('REFRESH'), viewId: uuid, entity, entityRevision: big })
              .strict(),
            z
              .object({
                action: z.literal('REVOKE'),
                viewId: uuid,
                authorityId: uuid,
                authorityEpoch: positive,
              })
              .strict(),
          ]),
        )
        .max(250),
      nextCursor: z.string().min(1).max(8192),
      hasMore: z.boolean(),
    })
    .strict(),
);
export const statsStatusResultSchema = typed<StatsStatusResult>(
  z
    .object({
      contractVersion: z.literal(1),
      selectorVersion: z.literal(1),
      enabled: z.boolean(),
      centralReady: z.boolean(),
      producerEpoch: uuid.nullable(),
      storeMode: z.enum(['LEGACY', 'CENTRAL']),
      legacyHistory: z
        .object({ imports: z.enum(['ACTIVE', 'RETIRED']), exports: z.enum(['ACTIVE', 'RETIRED']) })
        .strict(),
      capabilities: z
        .array(z.enum(['AUTHORITIES', 'INGEST', 'SUMMARIES', 'HISTORY', 'CHANGES']))
        .max(5),
    })
    .strict(),
);
export const statsErrorResultSchema = typed<StatsErrorResult>(
  z
    .object({
      contractVersion: z.literal(1),
      error: z
        .object({
          code: z.enum([
            'INVALID_REQUEST',
            'BODY_TOO_LARGE',
            'UNAUTHENTICATED',
            'FORBIDDEN',
            'RETIRED_PRODUCER_EPOCH',
            'REVISION_CONFLICT',
            'IDEMPOTENCY_CONFLICT',
            'EVENT_CONFLICT',
            'READ_RESTART',
            'CURSOR_EXPIRED',
            'STALE_LOCAL_FENCE',
            'RATE_LIMITED',
            'UNAVAILABLE',
          ]),
          requestId: text,
          retryable: z.boolean(),
          retryAfterSeconds: safeCount.nullable(),
        })
        .strict(),
    })
    .strict(),
);
