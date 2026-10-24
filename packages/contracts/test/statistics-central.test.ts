import { describe, expect, it } from 'vitest';
import {
  statsIngestRequestSchema,
  statsAuthorityRequestSchema,
  statsHistoryRowSchema,
} from '../src/statistics-central-validation.js';

const ref = { id: '00000000-0000-4000-8000-000000000001', epoch: '1' };
const base = {
  contractVersion: 1,
  requestId: ref.id,
  producerEpoch: ref.id,
  entity: { kind: 'CHANNEL', maxId: '-78271171091799' },
};
const coverage = { state: 'PARTIAL', intervals: [], populationComplete: false };
const scope = {
  metric: 'REACH',
  horizon: 0,
  method: { id: 'POST_PUBLICATION_DAY', version: 1 },
  day: '2026-10-24',
};
const reach = {
  ...scope,
  operation: 'REPLACE_DAY',
  sourceRevision: '1',
  authority: ref,
  coverage,
  value: {
    views: '20',
    samples: 2,
    posts: 3,
    observedFrom: '2026-10-24T12:00:00.123456Z',
    observedTo: '2026-10-24T12:01:00Z',
    maxDelaySeconds: null,
  },
};

describe('central statistics portable boundary', () => {
  it('retains exact decimal sum and microseconds without converting either', () => {
    const result = statsIngestRequestSchema.parse({ ...base, operations: [reach] });
    expect(result).toEqual({ ...base, operations: [reach] });
  });
  it('rejects hostile valid int64 sums for one int32 post and never throws on invalid decimals', () => {
    expect(
      statsIngestRequestSchema.safeParse({
        ...base,
        operations: [
          { ...reach, value: { ...reach.value, views: '9223372036854775807', samples: 1 } },
        ],
      }).success,
    ).toBe(false);
    expect(() =>
      statsIngestRequestSchema.safeParse({
        ...base,
        operations: [{ ...reach, sourceRevision: 'x' }],
      }),
    ).not.toThrow();
    expect(() =>
      statsIngestRequestSchema.safeParse({
        ...base,
        operations: [{ ...reach, value: { ...reach.value, views: 'x' } }],
      }),
    ).not.toThrow();
  });
  it('rejects unsupported chat post metrics and producer injection', () => {
    expect(
      statsIngestRequestSchema.safeParse({
        ...base,
        entity: { ...base.entity, kind: 'CHAT' },
        operations: [reach],
      }).success,
    ).toBe(false);
    expect(
      statsIngestRequestSchema.safeParse({ ...base, producer: 'MAXIM', operations: [reach] })
        .success,
    ).toBe(false);
  });
  it('keeps source purpose scalar, scopes exact and local fences opaque', () => {
    const op = {
      id: ref.id,
      revision: '1',
      operation: 'ATTEST',
      entity: base.entity,
      role: 'SOURCE',
      actorMaxUserId: '323459159',
      botRef: 'bot',
      consumer: 'EXCHANGE',
      purpose: 'OWNER_ANALYTICS',
      scopes: [
        { metric: 'REACH', horizon: 24, method: { id: 'TIMED_POST_PUBLICATION_DAY', version: 1 } },
      ],
      checkedAt: '2026-10-24T12:00:00Z',
      producerEpoch: ref.id,
      localAccessFence: '2026-10-24 12:00:00.123456+00',
    };
    expect(
      statsAuthorityRequestSchema.parse({ contractVersion: 1, requestId: ref.id, operations: [op] })
        .operations[0],
    ).toEqual(op);
    expect(
      statsAuthorityRequestSchema.safeParse({
        contractVersion: 1,
        requestId: ref.id,
        operations: [{ ...op, purpose: ['OWNER_ANALYTICS', 'PUBLISHED_AGGREGATE'] }],
      }).success,
    ).toBe(false);
  });
  it('permits real event clock lead up to 60 seconds, preserving actual observation', () => {
    const events = [
      {
        eventId: ref.id,
        capturedRevision: '1',
        eventType: 'JOIN',
        eventAt: '2026-10-24T12:01:00Z',
        observedAt: '2026-10-24T12:00:00Z',
      },
    ];
    const op = {
      operation: 'ADD_EVENTS',
      metric: 'MEMBERSHIP',
      horizon: 0,
      method: { id: 'OBSERVED_MEMBER_EVENTS', version: 1 },
      authority: ref,
      events,
    };
    expect(statsIngestRequestSchema.safeParse({ ...base, operations: [op] }).success).toBe(true);
    expect(
      statsIngestRequestSchema.safeParse({
        ...base,
        operations: [{ ...op, events: [{ ...events[0], eventAt: '2026-10-24T12:01:01Z' }] }],
      }).success,
    ).toBe(false);
  });
  it('retains unknown rather than converting a missing day into measured zero', () => {
    expect(
      statsHistoryRowSchema.parse({
        ...scope,
        state: 'UNKNOWN',
        reason: 'NO_DATA',
        health: {
          state: 'UNKNOWN',
          lastAttemptAt: null,
          lastSuccessAt: null,
          nextExpectedAt: null,
          errorCode: null,
        },
      }),
    ).toHaveProperty('state', 'UNKNOWN');
  });
  it('preserves real submillisecond intervals and rejects inversions at microsecond precision', () => {
    const interval = { from: '2026-10-24T12:00:00.000001Z', to: '2026-10-24T12:00:00.000002Z' };
    const op = { ...reach, coverage: { ...coverage, intervals: [interval] } };
    expect(statsIngestRequestSchema.safeParse({ ...base, operations: [op] }).success).toBe(true);
    expect(
      statsIngestRequestSchema.safeParse({
        ...base,
        operations: [
          {
            ...op,
            coverage: { ...op.coverage, intervals: [{ from: interval.to, to: interval.from }] },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
