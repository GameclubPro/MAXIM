import { z } from 'zod';
import type {
  StatsAnalyticsCursorBody,
  StatsAnalyticsHistoryRow,
  StatsAnalyticsMetric,
  StatsAnalyticsPayload,
  StatsAnalyticsRequest,
  StatsAnalyticsResult,
  StatsBrowserAnalyticsResult,
} from './statistics-analytics.js';
import { statsMetricKeySchema } from './statistics-central-validation.js';

const typed = <T>(schema: z.ZodType<unknown>): z.ZodType<T> => schema as z.ZodType<T>;
const issue = (ctx: z.RefinementCtx, message: string) => ctx.addIssue({ code: 'custom', message });
const timeKey = (v: string) =>
  `${v.slice(0, 19)}.${(v.split('.')[1]?.slice(0, -1) ?? '').padEnd(6, '0')}`;
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
  .refine(
    (v) =>
      Number.isFinite(Date.parse(`${v}T00:00:00Z`)) &&
      new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v,
  );
const safe = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const count = safe.max(2_147_483_647);
const signed = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const total = z.string().regex(/^(0|[1-9]\d{0,29})$/u);
const signedTotal = z.string().regex(/^(0|-?[1-9]\d{0,29})$/u);
const percent = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,49})\.\d{2}$/u)
  .refine((v) => v !== '-0.00');
const big = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/u)
  .refine((v) => /^(0|[1-9]\d{0,18})$/u.test(v) && BigInt(v) <= 9_223_372_036_854_775_807n);
const positive = big.refine((v) => v !== '0');
const uuid = z.string().uuid();
const text = z.string().min(1).max(512);
const metric = z.enum(['AUDIENCE', 'MEMBERSHIP', 'REACH', 'PUBLICATION_HOUR']);
const horizon = z.union([z.literal(0), z.literal(24), z.literal(48)]);
const period = z.union([z.literal(7), z.literal(30), z.literal(90)]);
const purpose = z.enum(['OWNER_ANALYTICS', 'PUBLISHED_AGGREGATE']);
const calendar = z.enum(['UTC', 'Europe/Moscow', 'UNSPECIFIED']);
const entity = z
  .object({ kind: z.enum(['CHANNEL', 'CHAT']), maxId: z.string().regex(/^-[1-9]\d{0,19}$/u) })
  .strict();
const method = z
  .object({
    id: z.enum([
      'AUDIENCE_SNAPSHOT',
      'POST_PUBLICATION_DAY',
      'TIMED_POST_PUBLICATION_DAY',
      'PUBLICATION_DAY_HOURS',
      'OBSERVED_MEMBER_EVENTS',
      'MAXFRAME_EXTERNAL_CALENDAR',
    ]),
    version: z.literal(1),
  })
  .strict();
const selection = z.union([
  z
    .object({
      metric: z.enum(['AUDIENCE', 'MEMBERSHIP', 'PUBLICATION_HOUR']),
      horizon: z.literal(0),
    })
    .strict(),
  z.object({ metric: z.literal('REACH'), horizon }).strict(),
]);
const context = z
  .object({
    contextId: uuid,
    entity,
    actorMaxUserId: z.string().regex(/^[1-9]\d{0,19}$/u),
    purpose,
    consumerAuthority: z.object({ id: uuid, epoch: positive }).strict(),
  })
  .strict();
const revision = z
  .object({ canonicalRevision: big, entityRevision: big, selectorVersion: z.literal(1) })
  .strict();
const dependency = z
  .object({
    producer: z.enum(['MAXIM', 'EXCHANGE']),
    purpose,
    scope: statsMetricKeySchema,
    sourceAuthorityId: uuid,
    sourceAuthorityEpoch: positive,
    consumerAuthorityId: uuid,
    consumerAuthorityEpoch: positive,
    peerValidUntil: time,
  })
  .strict();
const access = z
  .object({
    viewId: uuid,
    sourceAuthorityDependencies: z.array(dependency).max(64),
    validUntil: time,
  })
  .strict();
const cursor = z.string().min(1).max(8192).nullable();
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
  .refine((v) => (v.state === 'ERROR') === (v.errorCode !== null), 'Health error mismatch');
const freshness = z
  .object({ state: z.enum(['FRESH', 'STALE', 'UNKNOWN']), staleAt: time.nullable() })
  .strict()
  .refine(
    (v) => (v.state === 'UNKNOWN') === (v.staleAt === null),
    'Freshness requires actual observation time',
  );
const intervals = z
  .array(z.object({ from: time, to: time }).strict())
  .max(512)
  .superRefine((v, ctx) => {
    let end = '';
    for (const i of v) {
      if (timeKey(i.from) >= timeKey(i.to) || timeKey(i.from) < end)
        issue(ctx, 'Invalid or overlapping coverage');
      end = timeKey(i.to);
    }
  });
const coverage = z
  .object({
    state: z.enum(['UNKNOWN', 'PARTIAL', 'COMPLETE']),
    intervals,
    populationComplete: z.boolean(),
  })
  .strict();
const summaryCoverage = z
  .object({
    state: z.enum(['UNKNOWN', 'PARTIAL', 'COMPLETE']),
    requestedDays: period,
    knownDays: safe.max(90),
    completeDays: safe.max(90),
    populationComplete: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.completeDays > v.knownDays || v.knownDays > v.requestedDays)
      issue(ctx, 'Invalid coverage counts');
    if (v.state === 'COMPLETE' && v.completeDays !== v.requestedDays)
      issue(ctx, 'Complete coverage requires all dates');
    if (v.populationComplete && v.state !== 'COMPLETE')
      issue(ctx, 'Complete population requires complete coverage');
  });
const provenance = z
  .object({
    producer: z.enum(['MAXIM', 'EXCHANGE']),
    method,
    lineage: z.enum(['NATIVE', 'MAXFRAME_EXTERNAL']),
  })
  .strict()
  .refine(
    (v) => (v.method.id === 'MAXFRAME_EXTERNAL_CALENDAR') === (v.lineage === 'MAXFRAME_EXTERNAL'),
  );
const comparability = z
  .object({
    key: text,
    segmentId: text,
    axis: z.enum(['OBSERVATION_DAY', 'PUBLICATION_DAY', 'EVENT_DAY', 'EXTERNAL_CALENDAR_DAY']),
    calendarZone: calendar,
    previousComparableDay: day.nullable(),
    sourceTransition: z.boolean(),
  })
  .strict();
const window = z
  .object({
    calendarZone: calendar,
    fromDay: day,
    toDayExclusive: day,
    from: time.nullable(),
    to: time.nullable(),
    availableFrom: time.nullable(),
    observedUntil: time.nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.fromDay >= v.toDayExclusive) issue(ctx, 'Empty nominal window');
    if (v.calendarZone === 'UNSPECIFIED') {
      if ([v.from, v.to, v.availableFrom, v.observedUntil].some((n) => n !== null))
        issue(ctx, 'External calendar has no absolute observation window');
      return;
    }
    if (!v.from || !v.to || !v.availableFrom || !v.observedUntil) {
      issue(ctx, 'Known calendar requires absolute bounds');
      return;
    }
    if (
      timeKey(v.from) >= timeKey(v.to) ||
      timeKey(v.availableFrom) < timeKey(v.from) ||
      timeKey(v.observedUntil) > timeKey(v.to) ||
      timeKey(v.availableFrom) > timeKey(v.observedUntil)
    )
      issue(ctx, 'Invalid effective window');
    if (
      ![v.from, v.to, v.availableFrom, v.observedUntil].every((n) => Number.isFinite(Date.parse(n)))
    ) {
      issue(ctx, 'Invalid timestamp');
      return;
    }
    const offset = v.calendarZone === 'Europe/Moscow' ? 10_800_000 : 0;
    if (
      new Date(Date.parse(v.from) + offset).toISOString() !== `${v.fromDay}T00:00:00.000Z` ||
      new Date(Date.parse(v.to) + offset).toISOString() !== `${v.toDayExclusive}T00:00:00.000Z`
    )
      issue(ctx, 'Window does not match calendar dates');
  });
const quality = z
  .object({
    coverage: summaryCoverage,
    comparability: comparability.nullable(),
    provenance: z.array(provenance).max(16),
    health,
    freshness,
  })
  .strict();
const unavailable = z.enum([
  'NO_DATA',
  'UNSUPPORTED',
  'SOURCE_UNAVAILABLE',
  'EXPIRED_AUTHORITY',
  'NOT_REQUESTED',
  'NUMERIC_LIMIT',
  'INCOMPATIBLE_METHOD',
]);
const sectionError = z
  .object({ state: z.literal('ERROR'), code: z.enum(['TIMEOUT', 'SOURCE_UNAVAILABLE']) })
  .strict();
const percentage = z.union([
  z.object({ state: z.literal('AVAILABLE'), value: percent }).strict(),
  z.object({ state: z.literal('UNAVAILABLE'), reason: z.literal('ZERO_BASELINE') }).strict(),
]);
const frequency = z
  .object({
    postsOnCompleteDates: safe,
    completeDates: safe.max(90),
    averagePostsPerCompleteDate: z
      .string()
      .regex(/^(0|[1-9]\d{0,15})\.\d$/u)
      .nullable(),
  })
  .strict()
  .refine(
    (v) =>
      (v.completeDates === 0) === (v.averagePostsPerCompleteDate === null) &&
      (v.completeDates !== 0 || v.postsOnCompleteDates === 0),
  );
const observationBounds = { observedFrom: time.nullable(), observedTo: time.nullable() };
const audiencePoint = z.object({ value: count.nullable(), observedAt: time.nullable() }).strict();
const externalPoint = z
  .object({
    value: count.nullable(),
    observedAt: z.null(),
    fetchedAt: time,
    calendarZone: z.literal('UNSPECIFIED'),
    lineage: z.literal('MAXFRAME_EXTERNAL'),
  })
  .strict();
const reachShape = {
  views: total.nullable(),
  samples: safe,
  posts: safe.nullable(),
  ...observationBounds,
  maxDelaySeconds: count.max(900).nullable(),
  averageViews: total.nullable(),
};
function validateReach(v: z.infer<typeof reachPoint>, ctx: z.RefinementCtx) {
  if (v.posts !== null && v.samples > v.posts) issue(ctx, 'Samples exceed population');
  if (v.samples > 0 && (v.views === null || !v.observedFrom || !v.observedTo))
    issue(ctx, 'Samples require sums and actual observations');
  if (v.observedFrom && v.observedTo && timeKey(v.observedFrom) > timeKey(v.observedTo))
    issue(ctx, 'Invalid observation bounds');
  if ((v.samples === 0 || v.views === null) && v.averageViews !== null)
    issue(ctx, 'Empty sample has no mean');
  if (v.views !== null && /^(0|[1-9]\d{0,29})$/u.test(v.views)) {
    if (BigInt(v.views) > BigInt(v.samples) * 2_147_483_647n)
      issue(ctx, 'Views exceed native counter bounds');
    if (
      v.samples > 0 &&
      v.averageViews !==
        ((BigInt(v.views) * 2n + BigInt(v.samples)) / (2n * BigInt(v.samples))).toString()
    )
      issue(ctx, 'Incorrect exact mean');
  }
}
const reachPoint = z.object(reachShape).strict();
const publicationShape = {
  hours: z.array(safe.nullable()).length(24),
  count: safe.nullable(),
  ...observationBounds,
};
const validatePublication = (
  v: { count: number | null; hours: Array<number | null> },
  ctx: z.RefinementCtx,
) => {
  const known = v.hours.some((h) => h !== null);
  if (
    (v.count !== null) !== known ||
    v.count !== (known ? v.hours.reduce<number>((sum, h) => sum + (h ?? 0), 0) : null)
  )
    issue(ctx, 'Publication total must preserve the known hours');
};
const publicationPoint = z.object(publicationShape).strict().superRefine(validatePublication);
const membershipShape = { joined: safe.nullable(), left: safe.nullable(), ...observationBounds };
const membershipPoint = z.object(membershipShape).strict();
const methodSchema = <I extends string>(id: I) =>
  z.object({ id: z.literal(id), version: z.literal(1) }).strict();
const audienceScope = {
  metric: z.literal('AUDIENCE'),
  horizon: z.literal(0),
  method: methodSchema('AUDIENCE_SNAPSHOT'),
};
const externalScope = {
  metric: z.literal('AUDIENCE'),
  horizon: z.literal(0),
  method: methodSchema('MAXFRAME_EXTERNAL_CALENDAR'),
};
const currentScope = {
  metric: z.literal('REACH'),
  horizon: z.literal(0),
  method: methodSchema('POST_PUBLICATION_DAY'),
};
const timedScope = {
  metric: z.literal('REACH'),
  horizon: z.union([z.literal(24), z.literal(48)]),
  method: methodSchema('TIMED_POST_PUBLICATION_DAY'),
};
const publicationScope = {
  metric: z.literal('PUBLICATION_HOUR'),
  horizon: z.literal(0),
  method: methodSchema('PUBLICATION_DAY_HOURS'),
};
const membershipScope = {
  metric: z.literal('MEMBERSHIP'),
  horizon: z.literal(0),
  method: methodSchema('OBSERVED_MEMBER_EVENTS'),
};
const audienceValue = z.union([
  z.object({ ...audienceScope, value: count, observedAt: time }).strict(),
  z
    .object({
      ...externalScope,
      value: count,
      day,
      observedAt: z.null(),
      fetchedAt: time,
      calendarZone: z.literal('UNSPECIFIED'),
    })
    .strict(),
]);
const reachValue = z.union([
  z
    .object({ ...currentScope, ...reachShape })
    .strict()
    .superRefine(validateReach),
  z
    .object({ ...timedScope, ...reachShape })
    .strict()
    .superRefine(validateReach),
]);
const publicationValue = z
  .object({ ...publicationScope, ...publicationShape, frequency })
  .strict()
  .superRefine(validatePublication);
const membershipValue = z.object({ ...membershipScope, ...membershipShape }).strict();
const change = z.union([
  z
    .object({ field: z.literal('AVERAGE_VIEWS'), absolute: signedTotal, percent: percentage })
    .strict(),
  z
    .object({
      field: z.enum(['PUBLICATIONS', 'JOINED', 'LEFT']),
      absolute: signed,
      percent: percentage,
    })
    .strict(),
]);
const comparisonReason = z.enum([
  'OUTSIDE_RETENTION',
  'VARIABLE_POST_AGE',
  'AUDIENCE_USES_GROWTH',
  'INSUFFICIENT_SAMPLES',
  'INCOMPLETE_COVERAGE',
  'IMMATURE_WINDOW',
  'NO_DATA',
  'UNSUPPORTED',
  'INCOMPATIBLE_METHOD',
  'NUMERIC_LIMIT',
]);
const comparison = <T>(value: z.ZodType<T>) =>
  z.union([
    z.object({ state: z.literal('NOT_REQUESTED') }).strict(),
    sectionError,
    z
      .object({
        state: z.literal('UNAVAILABLE'),
        reason: comparisonReason,
        windows: z.object({ current: window, previous: window }).strict().nullable(),
      })
      .strict(),
    z
      .object({
        state: z.literal('AVAILABLE'),
        current: z.object({ window, quality, value }).strict(),
        previous: z.object({ window, quality, value }).strict(),
        changes: z.array(change).min(1).max(2),
      })
      .strict(),
  ]);
const windowValue = <T>(value: z.ZodType<T>) =>
  z.union([
    z.object({ state: z.literal('AVAILABLE'), window, quality, value }).strict(),
    z.object({ state: z.literal('UNAVAILABLE'), window, quality, reason: unavailable }).strict(),
  ]);
const growthInterval = { fromDay: day, toDay: day, fromObservedAt: time, toObservedAt: time };
const growthValue = z
  .object({
    ...growthInterval,
    comparabilityKey: text,
    delta: signed,
    sourceTransition: z.boolean(),
    completePeriod: z.boolean(),
    fromValue: count,
    toValue: count,
    observationCount: safe.min(2).max(90),
  })
  .strict()
  .refine(
    (v) =>
      v.fromDay < v.toDay &&
      timeKey(v.fromObservedAt) < timeKey(v.toObservedAt) &&
      v.delta === v.toValue - v.fromValue,
  );
const growth = z.union([
  z.object({ state: z.literal('AVAILABLE'), value: growthValue, percent: percentage }).strict(),
  z
    .object({
      state: z.literal('UNAVAILABLE'),
      reason: z.enum(['NO_DATA', 'INSUFFICIENT_OBSERVATIONS', 'INCOMPATIBLE_METHOD']),
    })
    .strict(),
]);
const audienceChange = z.union([
  z
    .object({ value: signed, reason: z.null(), interval: z.object(growthInterval).strict() })
    .strict(),
  z
    .object({
      value: z.null(),
      reason: z.enum([
        'NO_CURRENT_OBSERVATION',
        'NO_PREVIOUS_OBSERVATION',
        'GAP_IN_OBSERVATIONS',
        'INCOMPATIBLE_METHOD',
      ]),
      interval: z.object(growthInterval).strict().nullable(),
    })
    .strict(),
]);
const capability = z.enum(['SUPPORTED', 'UNSUPPORTED']);
const metricSchemas = z
  .union([
    z
      .object({
        metric: z.literal('AUDIENCE'),
        horizon: z.literal(0),
        unit: z.literal('PEOPLE'),
        capability,
        current: windowValue(audienceValue),
        comparison: comparison(audienceValue),
        growth,
      })
      .strict(),
    z
      .object({
        metric: z.literal('REACH'),
        horizon,
        unit: z.literal('VIEWS_PER_POST'),
        capability,
        current: windowValue(reachValue),
        comparison: comparison(reachValue),
      })
      .strict(),
    z
      .object({
        metric: z.literal('PUBLICATION_HOUR'),
        horizon: z.literal(0),
        unit: z.literal('POSTS'),
        capability,
        current: windowValue(publicationValue),
        comparison: comparison(publicationValue),
      })
      .strict(),
    z
      .object({
        metric: z.literal('MEMBERSHIP'),
        horizon: z.literal(0),
        unit: z.literal('EVENTS'),
        capability,
        current: windowValue(membershipValue),
        comparison: comparison(membershipValue),
      })
      .strict(),
  ])
  .superRefine((v, ctx) => {
    if (
      v.current.state === 'AVAILABLE' &&
      (v.current.value.horizon !== v.horizon || v.capability !== 'SUPPORTED')
    )
      issue(ctx, 'Inconsistent capability or horizon');
    if (v.current.state === 'AVAILABLE') {
      const expectedCalendar =
        v.current.value.method.id === 'MAXFRAME_EXTERNAL_CALENDAR'
          ? 'UNSPECIFIED'
          : v.metric === 'PUBLICATION_HOUR'
            ? 'Europe/Moscow'
            : 'UTC';
      if (
        v.current.window.calendarZone !== expectedCalendar ||
        (v.current.quality.comparability &&
          v.current.quality.comparability.calendarZone !== expectedCalendar)
      )
        issue(ctx, 'Metric calendar mismatch');
    }
    if (
      v.capability === 'UNSUPPORTED' &&
      !(v.current.state === 'UNAVAILABLE' && v.current.reason === 'UNSUPPORTED')
    )
      issue(ctx, 'Unsupported metric cannot contain measurements');
    if (v.comparison.state === 'AVAILABLE') {
      const c = v.comparison;
      if (v.metric === 'AUDIENCE' || (v.metric === 'REACH' && v.horizon === 0))
        issue(ctx, 'Metric cannot compare periods');
      if (c.current.value.horizon !== v.horizon || c.previous.value.horizon !== v.horizon)
        issue(ctx, 'Comparison horizon mismatch');
      if (
        c.current.window.fromDay !== c.previous.window.toDayExclusive ||
        c.current.window.calendarZone !== c.previous.window.calendarZone
      )
        issue(ctx, 'Comparison windows must be adjacent');
      if (
        c.current.quality.coverage.state !== 'COMPLETE' ||
        c.previous.quality.coverage.state !== 'COMPLETE' ||
        !c.current.quality.coverage.populationComplete ||
        !c.previous.quality.coverage.populationComplete
      )
        issue(ctx, 'Comparison requires complete coverage');
      const expected =
        v.metric === 'REACH'
          ? ['AVERAGE_VIEWS']
          : v.metric === 'PUBLICATION_HOUR'
            ? ['PUBLICATIONS']
            : ['JOINED', 'LEFT'];
      if (
        c.changes.length !== expected.length ||
        c.changes.some((x, index) => x.field !== expected[index])
      )
        issue(ctx, 'Change field mismatch');
    }
  });
export const statsAnalyticsMetricSchema = typed<StatsAnalyticsMetric>(metricSchemas);
const rowBase = { day, window, health, freshness };
const row = <S extends z.core.$ZodShape, T>(scope: S, value: z.ZodType<T>) =>
  z.union([
    z
      .object({
        ...rowBase,
        ...scope,
        state: z.literal('VALUE'),
        value,
        coverage,
        provenance: z.array(provenance).min(1).max(16),
        comparability,
      })
      .strict(),
    z.object({ ...rowBase, ...scope, state: z.literal('UNKNOWN'), reason: unavailable }).strict(),
  ]);
export const statsAnalyticsHistoryRowSchema = typed<StatsAnalyticsHistoryRow>(
  z
    .union([
      row({ ...audienceScope, changeFromPrevious: audienceChange }, audiencePoint),
      row({ ...externalScope, changeFromPrevious: audienceChange }, externalPoint),
      row(currentScope, reachPoint.superRefine(validateReach)),
      row(timedScope, reachPoint.superRefine(validateReach)),
      row(publicationScope, publicationPoint),
      row(membershipScope, membershipPoint),
    ])
    .superRefine((v, ctx) => {
      if (v.day !== v.window.fromDay) issue(ctx, 'History date/window mismatch');
    }),
);
const breakdown = z
  .object({
    weekdays: z.array(frequency.safeExtend({ weekday: safe.max(6) }).strict()).length(7),
    heatmap: z.array(safe.nullable()).length(168),
    activeDays: safe.max(90).nullable(),
    peakHour: safe.max(23).nullable(),
  })
  .strict()
  .refine(
    (v) => v.weekdays.every((d, i) => d.weekday === i),
    'Weekdays must be ordered Monday first',
  );
const readyHistory = z
  .object({
    state: z.literal('READY'),
    rows: z.array(statsAnalyticsHistoryRowSchema).max(256),
    nextCursor: cursor,
    publicationBreakdown: breakdown.nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.rows.map((r) => `${r.day}:${r.metric}:${r.horizon}`)).size !== v.rows.length)
      issue(ctx, 'Duplicate row slot');
  });
const history = z.union([
  z.object({ state: z.literal('NOT_REQUESTED') }).strict(),
  sectionError,
  readyHistory,
]);
const continuationHistory = z.union([
  sectionError,
  readyHistory.refine((v) => v.publicationBreakdown === null, 'Breakdown is initial-page only'),
]);
const initial = {
  page: z.literal('INITIAL'),
  metrics: z.array(statsAnalyticsMetricSchema).min(1).max(6),
  history,
};
const continuation = { page: z.literal('HISTORY'), history: continuationHistory };
export const statsAnalyticsPayloadSchema = typed<StatsAnalyticsPayload>(
  z.union([z.object(initial).strict(), z.object(continuation).strict()]),
);
export const statsAnalyticsRequestSchema = typed<StatsAnalyticsRequest>(
  z
    .object({
      contractVersion: z.literal(1),
      analyticsVersion: z.literal(1),
      context,
      periodDays: period,
      metrics: z.array(metric).min(1).max(4),
      horizons: z.array(horizon).max(3),
      includeComparison: z.boolean(),
      includeHistory: z.boolean(),
      cursor,
    })
    .strict()
    .superRefine((v, ctx) => {
      if (
        new Set(v.metrics).size !== v.metrics.length ||
        new Set(v.horizons).size !== v.horizons.length
      )
        issue(ctx, 'Selections must be unique');
      if (v.metrics.includes('REACH') !== v.horizons.length > 0)
        issue(ctx, 'Horizons apply only to selected reach');
      if (v.cursor !== null && !v.includeHistory) issue(ctx, 'Cursor requires history');
    }),
);
export const statsAnalyticsCursorSchema = typed<StatsAnalyticsCursorBody>(
  z
    .object({
      type: z.literal('analytics'),
      analyticsVersion: z.literal(1),
      filterHash: z.string().regex(/^[a-f0-9]{64}$/u),
      revisionDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      asOf: time,
      retentionFloor: day,
      after: z.object({ day, selection }).strict(),
      expiresAt: time,
    })
    .strict()
    .superRefine((v, ctx) => {
      const at = Date.parse(v.asOf),
        expiry = Date.parse(v.expiresAt),
        midnight = Math.floor(at / 86_400_000) * 86_400_000;
      if (!Number.isFinite(at) || !Number.isFinite(expiry)) {
        issue(ctx, 'Invalid cursor timestamp');
        return;
      }
      if (
        v.retentionFloor !== new Date(midnight - 89 * 86_400_000).toISOString().slice(0, 10) ||
        expiry <= at ||
        expiry > Math.min(at + 300_000, midnight + 86_400_000)
      )
        issue(ctx, 'Invalid cursor generation or expiry');
    }),
);
export const statsAnalyticsCursorBodySchema = statsAnalyticsCursorSchema;
const header = {
  contractVersion: z.literal(1),
  analyticsVersion: z.literal(1),
  status: z.literal('READY'),
  asOf: time,
  revision,
  contextId: uuid,
  entity,
  purpose,
  periodDays: period,
  access,
  historyAllowed: z.boolean(),
};
const error = z
  .object({
    contractVersion: z.literal(1),
    analyticsVersion: z.literal(1),
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
        retryAfterSeconds: safe.nullable(),
      })
      .strict(),
  })
  .strict();
function validatePrivacy(
  v: {
    purpose: 'OWNER_ANALYTICS' | 'PUBLISHED_AGGREGATE';
    historyAllowed: boolean;
    history: z.infer<typeof history>;
  },
  ctx: z.RefinementCtx,
) {
  if (
    v.purpose === 'PUBLISHED_AGGREGATE' &&
    (v.historyAllowed || v.history.state !== 'NOT_REQUESTED')
  )
    issue(ctx, 'Public projection cannot expose history');
  if (!v.historyAllowed && v.history.state === 'READY')
    issue(ctx, 'History requires owner permission');
}
function validateMetrics(v: { metrics: StatsAnalyticsMetric[] }, ctx: z.RefinementCtx) {
  if (new Set(v.metrics.map((m) => `${m.metric}:${m.horizon}`)).size !== v.metrics.length)
    issue(ctx, 'Duplicate metric selection');
}
export const statsAnalyticsResultSchema = typed<StatsAnalyticsResult>(
  z.union([
    z
      .object({ ...header, ...initial })
      .strict()
      .superRefine(validatePrivacy)
      .superRefine(validateMetrics),
    z
      .object({ ...header, ...continuation })
      .strict()
      .superRefine(validatePrivacy),
    error,
  ]),
);
const browserHistory = z.union([
  z.object({ state: z.literal('NOT_REQUESTED') }).strict(),
  sectionError,
  readyHistory.safeExtend({ rows: z.array(statsAnalyticsHistoryRowSchema).max(540) }),
]);
const browserInitial = { ...initial, history: browserHistory };
const browserHeader = {
  analyticsVersion: z.literal(1),
  asOf: time,
  revision,
  purpose,
  periodDays: period,
  historyAllowed: z.boolean(),
  entityKind: z.enum(['CHANNEL', 'CHAT']),
  validUntil: time,
};
export const statsBrowserAnalyticsResultSchema = typed<StatsBrowserAnalyticsResult>(
  z.union([
    z
      .object({ ...browserHeader, ...browserInitial })
      .strict()
      .superRefine(validatePrivacy)
      .superRefine(validateMetrics),
    z
      .object({ ...browserHeader, ...continuation })
      .strict()
      .superRefine(validatePrivacy),
  ]),
);
