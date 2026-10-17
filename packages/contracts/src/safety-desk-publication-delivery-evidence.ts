import { z } from 'zod';

export const safetyDeskPublicationDeliveryStatusSchema = z.enum([
  'PENDING',
  'SENDING',
  'SENT',
  'FAILED',
  'AMBIGUOUS',
  'CANCELED',
]);
export const safetyDeskPublicationDeliveryReceiptSchema = z.enum([
  'saved',
  'missing',
  'legacy_unproven',
  'invalid_evidence',
]);
export const safetyDeskPublicationDeliveryVerificationSchema = z.enum([
  'automated_stable',
  'operator_confirmed',
  'legacy_unproven',
  'pending',
  'not_recorded',
  'invalid_evidence',
]);
export const safetyDeskPublicationDeliveryWaitReasonSchema = z.enum([
  'scheduled_not_due',
  'deadline_elapsed',
  'deadline_unknown',
  'local_capacity',
  'max_rate_limit',
  'circuit_open',
  'other_capacity_reason',
  'retry_not_due',
  'retry_due',
  'actor_access_required',
  'target_setup_required',
  'publisher_unavailable',
  'other_blocker',
  'lease_active',
  'lease_stale',
  'lease_invalid',
  'receipt_verification_wait',
  'receipt_verification_due',
  'verification_not_enrolled',
  'post_action_wait',
  'post_action_due',
  'post_action_unknown',
  'effect_unknown',
  'unspecified_pending',
]);
const timestamp = z.string().datetime().nullable();
export const safetyDeskPublicationDeliveryWaitingSchema = z.object({
  reasons: z.array(safetyDeskPublicationDeliveryWaitReasonSchema).max(24),
  reasonsOverlap: z.literal(true),
  deadline: z.enum(['future', 'due', 'expired', 'unknown']),
  nextAttemptAt: timestamp,
  firstDeferredAt: timestamp,
  lastDeferredAt: timestamp,
  ageSinceFirstDeferralMs: z.number().finite().nonnegative().nullable(),
  recipientBlocker: z
    .enum([
      'actor_access_required',
      'target_setup_required',
      'publisher_unavailable',
      'other_blocker',
    ])
    .nullable(),
  parentBlocker: z
    .enum([
      'actor_access_required',
      'target_setup_required',
      'publisher_unavailable',
      'other_blocker',
    ])
    .nullable(),
  postActions: z.object({
    pin: z.enum(['NONE', 'PENDING', 'RUNNING', 'DONE', 'FAILED', 'AMBIGUOUS', 'SKIPPED']),
    deletion: z.enum(['NONE', 'PENDING', 'RUNNING', 'DONE', 'FAILED', 'AMBIGUOUS', 'SKIPPED']),
    nextAt: timestamp,
  }),
});
export const safetyDeskPublicationDeliveryEvidenceResponseSchema = z.object({
  schemaVersion: z.literal(1),
  observedAt: z.string().datetime(),
  deliveryId: z.string().min(1).max(128),
  storedStatus: safetyDeskPublicationDeliveryStatusSchema,
  effectiveStatus: safetyDeskPublicationDeliveryStatusSchema,
  acceptedAt: z.string().datetime(),
  completionTimingEvidence: z.literal('not_recorded'),
  binding: z.enum(['exact', 'not_recorded', 'invalid_evidence']),
  action: z.object({
    keyBasis: z.enum(['current', 'legacy', 'unavailable']),
    state: z.enum([
      'confirmed',
      'acknowledged',
      'unknown',
      'pending',
      'stopped',
      'not_recorded',
      'invalid_evidence',
    ]),
    dispatchStartedAt: timestamp,
    journalCompletedAt: timestamp,
  }),
  recipient: z.object({
    state: safetyDeskPublicationDeliveryReceiptSchema,
    savedSendAt: timestamp,
    agreesWithAction: z.boolean().nullable(),
  }),
  verification: z.object({
    state: safetyDeskPublicationDeliveryVerificationSchema,
    observedAt: timestamp,
  }),
  waiting: safetyDeskPublicationDeliveryWaitingSchema,
  clientVisibility: z.literal('not_observed'),
  automaticRetryAllowed: z.literal(false),
});
export type SafetyDeskPublicationDeliveryEvidenceResponse = z.infer<
  typeof safetyDeskPublicationDeliveryEvidenceResponseSchema
>;
export type SafetyDeskPublicationDeliveryWaiting = z.infer<
  typeof safetyDeskPublicationDeliveryWaitingSchema
>;
export type SafetyDeskPublicationDeliveryWaitReason = z.infer<
  typeof safetyDeskPublicationDeliveryWaitReasonSchema
>;
