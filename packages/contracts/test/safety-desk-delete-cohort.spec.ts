import { describe, expect, it } from 'vitest';
import {
  safetyDeskDeleteCohortResponseSchema as schema,
  safetyDeskDeleteCohortStatusSchema,
  type SafetyDeskDeleteCohortResponse,
} from '../src/safety-desk.js';

function snapshot(): SafetyDeskDeleteCohortResponse {
  return {
    schemaVersion: 1,
    basis: 'delete_intent_created_at',
    includesObservedOnly: true,
    windowSeconds: 900,
    graceSeconds: 30,
    windowStartedAt: '2026-10-17T00:00:00.000Z',
    windowEndedAt: '2026-10-17T00:15:00.000Z',
    observedAt: '2026-10-17T00:15:30.000Z',
    sampleLimitPerStatus: 512,
    sampleComplete: true,
    totalCountLowerBound: 0,
    rows: safetyDeskDeleteCohortStatusSchema.options.map((status) => ({
      status,
      countLowerBound: 0,
      truncated: false,
      outcomeCounts: {
        confirmed: 0,
        acknowledged: 0,
        already_absent: 0,
        unknown: 0,
        stopped: 0,
        observed: 0,
        pending: 0,
      },
      deadlineCounts: { notElapsed: 0, elapsed: 0, invalid: 0 },
      waitCounts: {
        notDue: 0,
        retryDue: 0,
        leaseActive: 0,
        leaseStale: 0,
        capability: 0,
        receiptSettlement: 0,
        effectUnknown: 0,
      },
      waitCountsOverlap: true,
      finalizedLatency: { sampleCount: 0, invalidClockCount: 0, p95Ms: null, p99Ms: null },
    })),
  };
}

describe('recorded deletion intent cohort contract', () => {
  it('retains observation-only denominator semantics and all ten statuses', () => {
    expect(schema.parse(snapshot())).toEqual(snapshot());
    expect(schema.safeParse({ ...snapshot(), includesObservedOnly: false }).success).toBe(false);
    const duplicate = snapshot();
    duplicate.rows[0] = duplicate.rows[1]!;
    expect(schema.safeParse(duplicate).success).toBe(false);
    expect(schema.safeParse({ ...snapshot(), rows: snapshot().rows.slice(1) }).success).toBe(false);
  });

  it('requires closed clocks, exact partitions, sample caps and truthful completeness', () => {
    const value = snapshot(),
      row = value.rows[5]!;
    row.countLowerBound = 512;
    row.truncated = true;
    row.outcomeCounts.unknown = 512;
    row.deadlineCounts.elapsed = 512;
    value.totalCountLowerBound = 512;
    expect(schema.safeParse(value).success).toBe(false);
    value.sampleComplete = false;
    expect(schema.parse(value).sampleComplete).toBe(false);
    expect(schema.safeParse({ ...value, observedAt: value.windowEndedAt }).success).toBe(false);
    row.outcomeCounts.unknown = 511;
    expect(schema.safeParse(value).success).toBe(false);
    row.outcomeCounts.unknown = 512;
    row.deadlineCounts.elapsed = 511;
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('allows overlapping waits without treating them as a partition or success', () => {
    const value = snapshot(),
      row = value.rows[5]!;
    value.totalCountLowerBound = row.countLowerBound = 1;
    row.outcomeCounts.unknown = row.deadlineCounts.elapsed = 1;
    row.waitCounts.effectUnknown = row.waitCounts.notDue = row.waitCounts.leaseActive = 1;
    expect(schema.parse(value).rows[5]!.outcomeCounts.unknown).toBe(1);
    row.waitCounts.notDue = 2;
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('requires finalized evidence for latency and keeps invalid clocks outside the sample', () => {
    const value = snapshot(),
      row = value.rows[6]!;
    value.totalCountLowerBound = row.countLowerBound = 2;
    row.outcomeCounts.confirmed = row.outcomeCounts.acknowledged = 1;
    row.deadlineCounts.elapsed = 2;
    row.finalizedLatency = { sampleCount: 1, invalidClockCount: 1, p95Ms: 50, p99Ms: 60 };
    expect(schema.parse(value).rows[6]!.finalizedLatency.invalidClockCount).toBe(1);
    row.finalizedLatency.sampleCount = 2;
    expect(schema.safeParse(value).success).toBe(false);
    row.finalizedLatency.sampleCount = 1;
    row.finalizedLatency.p95Ms = 61;
    expect(schema.safeParse(value).success).toBe(false);
    row.finalizedLatency.p95Ms = null;
    expect(schema.safeParse(value).success).toBe(false);
    row.finalizedLatency = { sampleCount: 0, invalidClockCount: 1, p95Ms: null, p99Ms: null };
    expect(schema.parse(value).rows[6]!.finalizedLatency.sampleCount).toBe(0);
    row.finalizedLatency.p99Ms = 0;
    expect(schema.safeParse(value).success).toBe(false);
  });
});
