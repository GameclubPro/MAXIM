import { describe, expect, it } from 'vitest';
import {
  safetyDeskPublicationCohortResponseSchema as schema,
  safetyDeskPublicationCohortStatusSchema,
  type SafetyDeskPublicationCohortResponse,
} from '../src/safety-desk.js';

function snapshot(): SafetyDeskPublicationCohortResponse {
  return {
    schemaVersion: 1,
    basis: 'occurrence_created_at',
    dispatchProfile: 'PUBLIK_V1',
    windowSeconds: 900,
    graceSeconds: 30,
    windowStartedAt: '2026-10-16T18:00:00.000Z',
    windowEndedAt: '2026-10-16T18:15:00.000Z',
    observedAt: '2026-10-16T18:15:30.000Z',
    sampleLimitPerStatus: 512,
    sampleComplete: true,
    totalCountLowerBound: 0,
    completionTimingEvidence: 'not_recorded',
    effectsEvidence: 'occurrence_status_only',
    rows: safetyDeskPublicationCohortStatusSchema.options.map((status) => ({
      status,
      countLowerBound: 0,
      truncated: false,
      pendingNotDue: 0,
      pendingDue: 0,
      pendingExpired: 0,
      pendingTimingUnknown: 0,
      blockedPending: 0,
      retryAuthorizedCount: 0,
      oldestDueAgeSec: null,
      modeCounts: { NOW: 0, ONCE: 0, SLOTS: 0, RECURRENCE: 0, UNKNOWN: 0 },
      mediaCounts: { TEXT: 0, IMAGE: 0, VIDEO: 0, UNKNOWN: 0 },
    })),
  };
}
describe('accepted publication occurrence cohort', () => {
  it('preserves empty observations without claiming effect proof', () => {
    expect(schema.parse(snapshot())).toEqual(snapshot());
    expect(schema.safeParse({ ...snapshot(), effectsEvidence: 'confirmed' }).success).toBe(false);
  });
  it('rejects missing statuses, an open window and fabricated completion timing', () => {
    const repeated = snapshot();
    repeated.rows[6] = repeated.rows[0]!;
    expect(schema.safeParse(repeated).success).toBe(false);
    expect(
      schema.safeParse({ ...snapshot(), observedAt: '2026-10-16T18:15:00.000Z' }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...snapshot(), completionTimingEvidence: 'updated_at' }).success,
    ).toBe(false);
  });
  it('requires saturation and all denominator partitions to agree', () => {
    const value = snapshot(),
      row = value.rows[0]!;
    row.countLowerBound = 512;
    row.truncated = true;
    row.pendingTimingUnknown = 512;
    row.modeCounts.UNKNOWN = 512;
    row.mediaCounts.UNKNOWN = 512;
    value.totalCountLowerBound = 512;
    expect(schema.safeParse(value).success).toBe(false);
    value.sampleComplete = false;
    expect(schema.parse(value).totalCountLowerBound).toBe(512);
    row.mediaCounts.UNKNOWN = 511;
    expect(schema.safeParse(value).success).toBe(false);
  });
  it('separates uncertain terminal outcomes from pending timing and retry authority', () => {
    const value = snapshot(),
      row = value.rows[5]!;
    row.countLowerBound = 1;
    row.modeCounts.NOW = 1;
    row.mediaCounts.UNKNOWN = 1;
    value.totalCountLowerBound = 1;
    expect(schema.parse(value).rows[5]!.status).toBe('AMBIGUOUS');
    row.pendingDue = 1;
    row.oldestDueAgeSec = 1;
    expect(schema.safeParse(value).success).toBe(false);
    row.pendingDue = 0;
    row.oldestDueAgeSec = null;
    row.retryAuthorizedCount = 2;
    expect(schema.safeParse(value).success).toBe(false);
  });
  it('refuses due counts without a measured age or blockers outside pending work', () => {
    const value = snapshot(),
      row = value.rows[1]!;
    row.countLowerBound = 1;
    row.pendingDue = 1;
    row.modeCounts.NOW = 1;
    row.mediaCounts.TEXT = 1;
    value.totalCountLowerBound = 1;
    expect(schema.safeParse(value).success).toBe(false);
    row.oldestDueAgeSec = 0;
    expect(schema.parse(value).rows[1]!.oldestDueAgeSec).toBe(0);
    row.blockedPending = 2;
    expect(schema.safeParse(value).success).toBe(false);
  });
});
