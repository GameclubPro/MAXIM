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
export const safetyDeskPublicationDeliveryContextSchema = z
  .object({
    scheduleBinding: z.enum(['exact', 'revision_changed', 'not_recorded', 'invalid_evidence']),
    scheduleMode: z.enum(['NOW', 'ONCE', 'SLOTS', 'RECURRENCE', 'UNKNOWN']),
    scheduledAt: timestamp,
    deliveryDeadlineAt: timestamp,
    retryAuthorizedAt: timestamp,
    retryExpiresAt: timestamp,
    occurrenceScheduleRevision: z.number().int().positive().nullable(),
    currentScheduleRevision: z.number().int().positive().nullable(),
    broadcastStatus: z.enum(['ACTIVE', 'PARTIAL', 'FAILED', 'COMPLETED', 'CANCELED']).nullable(),
    occurrenceStatus: z
      .enum(['SCHEDULED', 'IN_PROGRESS', 'SENT', 'PARTIAL', 'FAILED', 'AMBIGUOUS', 'CANCELED'])
      .nullable(),
    publicationLifecycle: z
      .enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELED', 'ERROR'])
      .nullable(),
    scheduleStatus: z
      .enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELED', 'ERROR'])
      .nullable(),
    broadcastLease: z.object({
      state: z.enum(['none', 'active', 'stale', 'invalid_evidence']),
      lockedAt: timestamp,
    }),
  })
  .superRefine((value, ctx) => {
    // FLAG: Current schedule metadata proves the original mode only at its saved revision.
    if ((value.scheduleBinding === 'exact') !== (value.scheduleMode !== 'UNKNOWN'))
      ctx.addIssue({ code: 'custom', path: ['scheduleMode'], message: 'Unproven schedule mode' });
    if (
      value.scheduleBinding === 'exact' &&
      (value.occurrenceScheduleRevision === null ||
        value.occurrenceScheduleRevision !== value.currentScheduleRevision)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['scheduleBinding'],
        message: 'Schedule revision differs',
      });
  });
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
  context: safetyDeskPublicationDeliveryContextSchema.optional(),
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
