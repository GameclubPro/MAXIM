import { describe, expect, it } from 'vitest';
import {
  safetyDeskWebhookCohortResponseSchema,
  safetyDeskWebhookStatusSchema,
  type SafetyDeskWebhookCohortResponse,
} from '../src/safety-desk.js';

function snapshot(): SafetyDeskWebhookCohortResponse {
  return {
    schemaVersion: 1,
    basis: 'receipt_created_at',
    windowSeconds: 30,
    graceSeconds: 30,
    windowStartedAt: '2026-10-16T18:00:00.000Z',
    windowEndedAt: '2026-10-16T18:00:30.000Z',
    observedAt: '2026-10-16T18:01:00.000Z',
    sampleLimitPerStatus: 512,
    sampleComplete: true,
    totalCountLowerBound: 0,
    effectsEvidence: 'not_linked',
    rows: safetyDeskWebhookStatusSchema.options.map((status) => ({
      status,
      countLowerBound: 0,
      truncated: false,
      oldestPendingAgeSec: null,
      expiredAtObservation: 0,
      quarantineTimestampPresent: 0,
      invalidProcessedClocks: 0,
      invalidQueuedClocks: 0,
      processedLatency: { sampleCount: 0, p95Ms: null, p99Ms: null },
      enqueueLatency: { sampleCount: 0, p95Ms: null, p99Ms: null },
    })),
  };
}

describe('closed receipt cohort contract', () => {
  it('retains empty coverage without inventing an effect or latency', () => {
    expect(safetyDeskWebhookCohortResponseSchema.parse(snapshot())).toEqual(snapshot());
    expect(
      safetyDeskWebhookCohortResponseSchema.safeParse({
        ...snapshot(),
        effectsEvidence: 'confirmed',
      }).success,
    ).toBe(false);
  });
  it('refuses a complete denominator with a missing or repeated status', () => {
    const value = snapshot();
    value.rows[7] = value.rows[0]!;
    expect(safetyDeskWebhookCohortResponseSchema.safeParse(value).success).toBe(false);
    expect(
      safetyDeskWebhookCohortResponseSchema.safeParse({
        ...snapshot(),
        rows: snapshot().rows.slice(0, 7),
      }).success,
    ).toBe(false);
  });
  it('keeps saturation explicit and rejects unrelated totals', () => {
    const value = snapshot();
    value.rows[0]!.countLowerBound = 512;
    value.rows[0]!.truncated = true;
    value.totalCountLowerBound = 512;
    expect(safetyDeskWebhookCohortResponseSchema.safeParse(value).success).toBe(false);
    value.sampleComplete = false;
    expect(safetyDeskWebhookCohortResponseSchema.parse(value).sampleComplete).toBe(false);
    value.totalCountLowerBound = 511;
    expect(safetyDeskWebhookCohortResponseSchema.safeParse(value).success).toBe(false);
  });
  it('rejects latency without samples and counters larger than coverage', () => {
    const value = snapshot();
    value.rows[0]!.enqueueLatency.p95Ms = 0;
    expect(safetyDeskWebhookCohortResponseSchema.safeParse(value).success).toBe(false);
    value.rows[0]!.enqueueLatency.p95Ms = null;
    value.rows[0]!.expiredAtObservation = 1;
    expect(safetyDeskWebhookCohortResponseSchema.safeParse(value).success).toBe(false);
  });
});
