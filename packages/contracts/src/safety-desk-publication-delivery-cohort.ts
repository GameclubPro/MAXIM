import { z } from 'zod';
import {
  safetyDeskPublicationDeliveryStatusSchema,
  safetyDeskPublicationDeliveryReceiptSchema,
  safetyDeskPublicationDeliveryWaitReasonSchema,
} from './safety-desk-publication-delivery-evidence.js';
const count = z.number().int().min(0).max(512);
export const safetyDeskPublicationDeliveryCohortRowSchema = z.object({
  status: safetyDeskPublicationDeliveryStatusSchema,
  countLowerBound: count,
  truncated: z.boolean(),
  effectiveStatusCounts: z.object({
    PENDING: count,
    SENDING: count,
    SENT: count,
    FAILED: count,
    AMBIGUOUS: count,
    CANCELED: count,
  }),
  receiptEvidenceCounts: z.object({
    saved: count,
    missing: count,
    legacy_unproven: count,
    invalid_evidence: count,
  }),
  verificationCounts: z.object({
    automated_stable: count,
    operator_confirmed: count,
    legacy_unproven: count,
    pending: count,
    not_recorded: count,
    invalid_evidence: count,
  }),
  deadlineCounts: z.object({ future: count, due: count, expired: count, unknown: count }),
  waitingReasonCounts: z.record(safetyDeskPublicationDeliveryWaitReasonSchema, count),
  waitingReasonCountsOverlap: z.literal(true),
});
export const safetyDeskPublicationDeliveryCohortResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    basis: z.literal('recipient_created_at'),
    dispatchProfile: z.literal('PUBLIK_V1'),
    retryMembership: z.literal('same_delivery'),
    windowSeconds: z.literal(900),
    graceSeconds: z.literal(30),
    windowStartedAt: z.string().datetime(),
    windowEndedAt: z.string().datetime(),
    observedAt: z.string().datetime(),
    sampleLimitPerStatus: z.literal(512),
    sampleComplete: z.boolean(),
    totalCountLowerBound: z.number().int().min(0).max(3072),
    completionTimingEvidence: z.literal('not_recorded'),
    ledgerEvidence: z.literal('not_joined'),
    rows: z.array(safetyDeskPublicationDeliveryCohortRowSchema).length(6),
    examples: z
      .array(
        z.object({
          deliveryId: z.string().min(1).max(128),
          acceptedAt: z.string().datetime(),
          storedStatus: safetyDeskPublicationDeliveryStatusSchema,
          effectiveStatus: safetyDeskPublicationDeliveryStatusSchema,
          receipt: safetyDeskPublicationDeliveryReceiptSchema,
        }),
      )
      .max(8),
  })
  .superRefine((value, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (new Set(value.rows.map((row) => row.status)).size !== 6)
      issue(['rows'], 'Every stored status is required');
    if (
      value.rows.reduce((sum, row) => sum + row.countLowerBound, 0) !== value.totalCountLowerBound
    )
      issue(['totalCountLowerBound'], 'Invalid denominator');
    if (value.sampleComplete !== value.rows.every((row) => !row.truncated))
      issue(['sampleComplete'], 'Capped sample is incomplete');
    if (
      Date.parse(value.windowEndedAt) - Date.parse(value.windowStartedAt) !== 900000 ||
      Date.parse(value.observedAt) - Date.parse(value.windowEndedAt) !== 30000
    )
      issue(['windowStartedAt'], 'Invalid closed clocks');
    for (const [index, row] of value.rows.entries()) {
      if (row.truncated && row.countLowerBound !== 512) issue(['rows', index], 'Invalid cap');
      for (const field of [
        'effectiveStatusCounts',
        'receiptEvidenceCounts',
        'verificationCounts',
        'deadlineCounts',
      ] as const)
        if (Object.values(row[field]).reduce((sum, n) => sum + n, 0) !== row.countLowerBound)
          issue(['rows', index, field], 'Partition differs from denominator');
      if (
        safetyDeskPublicationDeliveryWaitReasonSchema.options.some(
          (reason) => row.waitingReasonCounts[reason] === undefined,
        ) ||
        Object.values(row.waitingReasonCounts).some((n) => n > row.countLowerBound)
      )
        issue(['rows', index, 'waitingReasonCounts'], 'Invalid overlapping counts');
    }
    if (
      new Set(value.examples.map((item) => item.deliveryId)).size !== value.examples.length ||
      value.examples.length > value.totalCountLowerBound
    )
      issue(['examples'], 'Invalid sampled examples');
  });
export type SafetyDeskPublicationDeliveryCohortResponse = z.infer<
  typeof safetyDeskPublicationDeliveryCohortResponseSchema
>;
