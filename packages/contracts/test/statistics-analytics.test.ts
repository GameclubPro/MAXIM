import { describe, expect, it } from 'vitest';
import {
  statsAnalyticsCursorBodySchema,
  statsAnalyticsMetricSchema,
  statsAnalyticsRequestSchema,
  statsAnalyticsResultSchema,
  statsBrowserAnalyticsResultSchema,
} from '../src/statistics-analytics-validation.js';
import type { StatsAnalyticsMetric, StatsAnalyticsRequest } from '../src/statistics-analytics.js';

const request: StatsAnalyticsRequest = {
  contractVersion: 1,
  analyticsVersion: 1,
  context: {
    contextId: '00000000-0000-4000-8000-000000000001',
    entity: { kind: 'CHANNEL', maxId: '-123' },
    actorMaxUserId: '123',
    purpose: 'OWNER_ANALYTICS',
    consumerAuthority: { id: '00000000-0000-4000-8000-000000000002', epoch: '1' },
  },
  periodDays: 7,
  metrics: ['AUDIENCE', 'REACH'],
  horizons: [48],
  includeComparison: true,
  includeHistory: true,
  cursor: null,
};
const unknownHealth = {
  state: 'UNKNOWN' as const,
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextExpectedAt: null,
  errorCode: null,
};
const window = {
  calendarZone: 'UTC' as const,
  fromDay: '2026-10-24',
  toDayExclusive: '2026-10-31',
  from: '2026-10-24T00:00:00Z',
  to: '2026-10-31T00:00:00Z',
  availableFrom: '2026-10-24T00:00:00Z',
  observedUntil: '2026-10-30T12:00:00Z',
};
const reach: StatsAnalyticsMetric = {
  metric: 'REACH',
  horizon: 48,
  unit: 'VIEWS_PER_POST',
  capability: 'SUPPORTED',
  current: {
    state: 'AVAILABLE',
    window,
    quality: {
      coverage: {
        state: 'PARTIAL',
        requestedDays: 7,
        knownDays: 1,
        completeDays: 0,
        populationComplete: false,
      },
      comparability: null,
      provenance: [],
      health: unknownHealth,
      freshness: { state: 'FRESH', staleAt: '2026-10-30T13:00:00Z' },
    },
    value: {
      metric: 'REACH',
      horizon: 48,
      method: { id: 'TIMED_POST_PUBLICATION_DAY', version: 1 },
      views: '7',
      samples: 5,
      posts: 5,
      observedFrom: '2026-10-30T11:00:00Z',
      observedTo: '2026-10-30T12:00:00Z',
      maxDelaySeconds: 60,
      averageViews: '1',
    },
  },
  comparison: { state: 'NOT_REQUESTED' },
};
const browser = {
  analyticsVersion: 1,
  asOf: '2026-10-30T12:00:00Z',
  revision: { canonicalRevision: '1', entityRevision: '1', selectorVersion: 1 },
  purpose: 'PUBLISHED_AGGREGATE',
  periodDays: 7,
  historyAllowed: false,
  entityKind: 'CHANNEL',
  validUntil: '2026-10-30T12:04:00Z',
  page: 'INITIAL',
  metrics: [reach],
  history: { state: 'NOT_REQUESTED' },
};

describe('analytics wire boundary', () => {
  it('accepts exact mixed selections and rejects duplicate, implicit or foreign filters', () => {
    expect(statsAnalyticsRequestSchema.safeParse(request).success).toBe(true);
    for (const extra of [
      { metrics: ['AUDIENCE', 'AUDIENCE'] },
      { horizons: [48, 48] },
      { metrics: ['AUDIENCE'], horizons: [48] },
      { horizons: [] },
      { asOf: '2026-10-30T12:00:00Z' },
      { fromDay: '2026-10-01' },
      { periodDays: 180 },
      { context: { ...request.context, owner: true } },
    ])
      expect(statsAnalyticsRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    expect(
      statsAnalyticsRequestSchema.safeParse({ ...request, metrics: ['AUDIENCE'], horizons: [] })
        .success,
    ).toBe(true);
    // Public history is syntactically valid so the ACL boundary returns explicit FORBIDDEN.
    expect(
      statsAnalyticsRequestSchema.safeParse({
        ...request,
        context: { ...request.context, purpose: 'PUBLISHED_AGGREGATE' },
      }).success,
    ).toBe(true);
  });
  it('validates canonical means and metric/horizon/unit correlation deeply', () => {
    expect(statsAnalyticsMetricSchema.safeParse(reach).success).toBe(true);
    if (reach.current.state !== 'AVAILABLE') throw new Error('fixture');
    for (const changed of [
      { unit: 'PEOPLE' },
      { horizon: 24 },
      { capability: 'UNSUPPORTED' },
      { current: { ...reach.current, value: { ...reach.current.value, averageViews: '2' } } },
      { current: { ...reach.current, value: { ...reach.current.value, samples: 0 } } },
      {
        current: { ...reach.current, quality: { ...reach.current.quality, debugToken: 'invalid' } },
      },
    ])
      expect(statsAnalyticsMetricSchema.safeParse({ ...reach, ...changed }).success).toBe(false);
  });
  it('refuses owner history, private identifiers, and duplicate metrics in a public response', () => {
    expect(statsBrowserAnalyticsResultSchema.safeParse(browser).success).toBe(true);
    expect(
      statsBrowserAnalyticsResultSchema.safeParse({ ...browser, sourceAuthorityDependencies: [] })
        .success,
    ).toBe(false);
    expect(
      statsBrowserAnalyticsResultSchema.safeParse({ ...browser, historyAllowed: true }).success,
    ).toBe(false);
    expect(
      statsBrowserAnalyticsResultSchema.safeParse({
        ...browser,
        history: { state: 'READY', rows: [], nextCursor: null, publicationBreakdown: null },
      }).success,
    ).toBe(false);
    expect(
      statsBrowserAnalyticsResultSchema.safeParse({ ...browser, metrics: [reach, reach] }).success,
    ).toBe(false);
    expect(
      statsBrowserAnalyticsResultSchema.safeParse({
        ...browser,
        page: 'HISTORY',
        history: { state: 'ERROR', code: 'TIMEOUT' },
      }).success,
    ).toBe(false);
  });
  it('requires real calendar bounds, valid dates and null absolute external windows', () => {
    if (reach.current.state !== 'AVAILABLE') throw new Error('fixture');
    for (const w of [
      { ...window, fromDay: '2026-02-30' },
      { ...window, calendarZone: 'Europe/Moscow' },
      { ...window, calendarZone: 'UNSPECIFIED' },
      { ...window, observedUntil: '2026-11-01T00:00:00Z' },
      { ...window, availableFrom: '2026-10-31T00:00:00Z' },
    ])
      expect(
        statsAnalyticsMetricSchema.safeParse({ ...reach, current: { ...reach.current, window: w } })
          .success,
      ).toBe(false);
  });
  it('bounds cursor lifetime to retention midnight and validates its opaque generation body', () => {
    const cursor = {
      type: 'analytics',
      analyticsVersion: 1,
      filterHash: 'a'.repeat(64),
      revisionDigest: 'b'.repeat(64),
      asOf: '2026-10-30T23:58:00Z',
      retentionFloor: '2026-08-02',
      after: { day: '2026-10-29', selection: { metric: 'AUDIENCE', horizon: 0 } },
      expiresAt: '2026-10-31T00:00:00Z',
    };
    expect(statsAnalyticsCursorBodySchema.safeParse(cursor).success).toBe(true);
    for (const patch of [
      { expiresAt: '2026-10-31T00:00:00.001Z' },
      { retentionFloor: '2026-08-01' },
      { filterHash: 'not-a-digest' },
      { after: { day: '2026-10-29', selection: { metric: 'AUDIENCE', horizon: 48 } } },
      { actorMaxUserId: '123' },
    ])
      expect(statsAnalyticsCursorBodySchema.safeParse({ ...cursor, ...patch }).success).toBe(false);
  });
  it('requires distinct analytics version for errors and rejects old central output', () => {
    const error = {
      contractVersion: 1,
      analyticsVersion: 1,
      error: {
        code: 'FORBIDDEN',
        requestId: 'analytics',
        retryable: false,
        retryAfterSeconds: null,
      },
    };
    expect(statsAnalyticsResultSchema.safeParse(error).success).toBe(true);
    expect(
      statsAnalyticsResultSchema.safeParse({ ...error, analyticsVersion: undefined }).success,
    ).toBe(false);
  });
});
