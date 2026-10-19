import { describe, expect, it } from 'vitest';
import { safetyDeskPublicationDeliveryCohortResponseSchema } from '../src/safety-desk-publication-delivery-cohort.js';
import {
  safetyDeskPublicationDeliveryStatusSchema,
  safetyDeskPublicationDeliveryWaitReasonSchema,
  safetyDeskPublicationDeliveryEvidenceResponseSchema,
  safetyDeskPublicationDeliveryContextSchema,
} from '../src/safety-desk-publication-delivery-evidence.js';
function cohort() {
  return {
    schemaVersion: 1,
    basis: 'recipient_created_at',
    dispatchProfile: 'PUBLIK_V1',
    retryMembership: 'same_delivery',
    windowSeconds: 900,
    graceSeconds: 30,
    windowStartedAt: '2026-10-17T00:00:00.000Z',
    windowEndedAt: '2026-10-17T00:15:00.000Z',
    observedAt: '2026-10-17T00:15:30.000Z',
    sampleLimitPerStatus: 512,
    sampleComplete: true,
    totalCountLowerBound: 0,
    completionTimingEvidence: 'not_recorded',
    ledgerEvidence: 'not_joined',
    examples: [],
    rows: safetyDeskPublicationDeliveryStatusSchema.options.map((status) => ({
      status,
      countLowerBound: 0,
      truncated: false,
      effectiveStatusCounts: {
        PENDING: 0,
        SENDING: 0,
        SENT: 0,
        FAILED: 0,
        AMBIGUOUS: 0,
        CANCELED: 0,
      },
      receiptEvidenceCounts: { saved: 0, missing: 0, legacy_unproven: 0, invalid_evidence: 0 },
      verificationCounts: {
        automated_stable: 0,
        operator_confirmed: 0,
        legacy_unproven: 0,
        pending: 0,
        not_recorded: 0,
        invalid_evidence: 0,
      },
      deadlineCounts: { future: 0, due: 0, expired: 0, unknown: 0 },
      waitingReasonCounts: Object.fromEntries(
        safetyDeskPublicationDeliveryWaitReasonSchema.options.map((reason) => [reason, 0]),
      ),
      waitingReasonCountsOverlap: true,
    })),
  };
}
describe('Closed materialized recipient evidence contracts', () => {
  it('requires every stored status, fixed clocks and exact partition sums', () => {
    expect(safetyDeskPublicationDeliveryCohortResponseSchema.safeParse(cohort()).success).toBe(
      true,
    );
    const missing = cohort();
    missing.rows.pop();
    expect(safetyDeskPublicationDeliveryCohortResponseSchema.safeParse(missing).success).toBe(
      false,
    );
    const clock = cohort();
    clock.windowEndedAt = clock.observedAt;
    expect(safetyDeskPublicationDeliveryCohortResponseSchema.safeParse(clock).success).toBe(false);
    const count = cohort();
    count.rows[0]!.receiptEvidenceCounts.saved = 1;
    expect(safetyDeskPublicationDeliveryCohortResponseSchema.safeParse(count).success).toBe(false);
  });
  it('rejects partial waiting taxonomy and incomplete caps labelled complete', () => {
    const partial = cohort();
    delete partial.rows[0]!.waitingReasonCounts.lease_invalid;
    expect(safetyDeskPublicationDeliveryCohortResponseSchema.safeParse(partial).success).toBe(
      false,
    );
    const cap = cohort();
    cap.rows[0]!.truncated = true;
    expect(safetyDeskPublicationDeliveryCohortResponseSchema.safeParse(cap).success).toBe(false);
  });
  it('never accepts automatic retry authority in diagnostic evidence', () => {
    expect(
      safetyDeskPublicationDeliveryEvidenceResponseSchema.shape.automaticRetryAllowed.safeParse(
        true,
      ).success,
    ).toBe(false);
    expect(
      safetyDeskPublicationDeliveryEvidenceResponseSchema.shape.completionTimingEvidence.safeParse(
        'sentAt',
      ).success,
    ).toBe(false);
  });
  it('keeps parent context optional and refuses unproven original schedule modes', () => {
    expect(
      safetyDeskPublicationDeliveryEvidenceResponseSchema.shape.context.safeParse(undefined)
        .success,
    ).toBe(true);
    const context = {
      scheduleBinding: 'exact',
      scheduleMode: 'ONCE',
      scheduledAt: '2026-10-17T00:00:00.000Z',
      deliveryDeadlineAt: '2026-10-18T00:00:00.000Z',
      retryAuthorizedAt: null,
      retryExpiresAt: null,
      occurrenceScheduleRevision: 1,
      currentScheduleRevision: 1,
      broadcastStatus: 'CANCELED',
      occurrenceStatus: 'CANCELED',
      publicationLifecycle: 'CANCELED',
      scheduleStatus: 'CANCELED',
      broadcastLease: { state: 'none', lockedAt: null },
    };
    expect(safetyDeskPublicationDeliveryContextSchema.safeParse(context).success).toBe(true);
    expect(
      safetyDeskPublicationDeliveryContextSchema.safeParse({
        ...context,
        scheduleBinding: 'revision_changed',
      }).success,
    ).toBe(false);
    expect(
      safetyDeskPublicationDeliveryContextSchema.safeParse({
        ...context,
        currentScheduleRevision: 2,
      }).success,
    ).toBe(false);
    expect(
      safetyDeskPublicationDeliveryContextSchema.safeParse({
        ...context,
        scheduleBinding: 'revision_changed',
        scheduleMode: 'UNKNOWN',
        currentScheduleRevision: 2,
      }).success,
    ).toBe(true);
  });
});
