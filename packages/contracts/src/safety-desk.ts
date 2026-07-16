import { z } from 'zod';

export const safetyDeskDeleteIntentStatusSchema = z.enum([
  'OBSERVED',
  'PENDING',
  'IN_PROGRESS',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
  'SUCCEEDED',
  'ALREADY_ABSENT',
  'EXPIRED',
  'FAILED_TERMINAL',
]);
export type SafetyDeskDeleteIntentStatus = z.infer<typeof safetyDeskDeleteIntentStatusSchema>;

export const safetyDeskDeleteIntentStatusCountsSchema = z.object({
  OBSERVED: z.number().int().nonnegative(),
  PENDING: z.number().int().nonnegative(),
  IN_PROGRESS: z.number().int().nonnegative(),
  RETRYABLE: z.number().int().nonnegative(),
  WAITING_CAPABILITY: z.number().int().nonnegative(),
  AMBIGUOUS: z.number().int().nonnegative(),
  SUCCEEDED: z.number().int().nonnegative(),
  ALREADY_ABSENT: z.number().int().nonnegative(),
  EXPIRED: z.number().int().nonnegative(),
  FAILED_TERMINAL: z.number().int().nonnegative(),
});
export type SafetyDeskDeleteIntentStatusCounts = z.infer<
  typeof safetyDeskDeleteIntentStatusCountsSchema
>;

export const safetyDeskDeleteCapabilityStateSchema = z.enum([
  'confirmed_capable',
  'stale_or_unknown',
  'explicitly_incapable',
]);
export type SafetyDeskDeleteCapabilityState = z.infer<typeof safetyDeskDeleteCapabilityStateSchema>;

export const safetyDeskDeleteCapabilityReasonSchema = z.enum([
  'confirmed',
  'snapshot_missing',
  'snapshot_stale',
  'access_denied',
  'access_state_unconfirmed',
  'bot_not_actionable',
  'not_admin_or_owner',
  'missing_chat_delete_permission',
  'missing_channel_delete_permission',
]);
export type SafetyDeskDeleteCapabilityReason = z.infer<
  typeof safetyDeskDeleteCapabilityReasonSchema
>;

export const safetyDeskDeleteMembershipCapabilitySchema = z.object({
  botId: z.string(),
  role: z.enum(['PRIMARY', 'STANDBY']),
  accessState: z.enum([
    'UNKNOWN',
    'CONFIRMED_OWNER',
    'CONFIRMED_ADMIN',
    'CONFIRMED_MEMBER',
    'DENIED',
    'LOST',
    'STALE',
  ]),
  botRuntimeState: z.enum(['active', 'draining', 'dormant', 'disabled', 'unconfigured']),
  state: safetyDeskDeleteCapabilityStateSchema,
  reason: safetyDeskDeleteCapabilityReasonSchema,
  checkedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  snapshotCheckedAt: z.string().datetime().nullable(),
  isAdmin: z.boolean(),
  isOwner: z.boolean(),
  permissions: z.array(z.string()).default([]),
});
export type SafetyDeskDeleteMembershipCapability = z.infer<
  typeof safetyDeskDeleteMembershipCapabilitySchema
>;

export const safetyDeskDeleteIntentReasonSchema = z.object({
  reasonKey: z.string(),
  ruleCode: z.string(),
  userId: z.string().nullable(),
  score: z.number(),
  createdAt: z.string().datetime(),
});
export type SafetyDeskDeleteIntentReason = z.infer<typeof safetyDeskDeleteIntentReasonSchema>;

export const safetyDeskDeleteIntentItemSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  chatTitle: z.string(),
  messageId: z.string(),
  subjectUserId: z.string().nullable(),
  entityType: z.enum(['CHAT', 'CHANNEL']).nullable(),
  originBotId: z.string().nullable(),
  routingPolicy: z.enum(['delete_capable', 'origin_first', 'origin_only']),
  effectiveRoutingPolicy: z.enum(['delete_capable', 'origin_first', 'origin_only']),
  crossBotEnabled: z.boolean(),
  routingState: z.enum(['READY', 'NO_ELIGIBLE_BOT']),
  rollout: z.enum(['off', 'observed', 'execute']),
  status: safetyDeskDeleteIntentStatusSchema,
  ageMs: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative(),
  executeAt: z.string().datetime(),
  nextAttemptAt: z.string().datetime(),
  retryUntilAt: z.string().datetime(),
  firstAttemptAt: z.string().datetime().nullable(),
  lastAttemptAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  leaseExpiresAt: z.string().datetime().nullable(),
  deleteDispatchStartedAt: z.string().datetime().nullable(),
  deleteDispatchStartedBotId: z.string().nullable(),
  remoteDeleteSucceededAt: z.string().datetime().nullable(),
  remoteDeleteSucceededBotId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastBotId: z.string().nullable(),
  succeededBotId: z.string().nullable(),
  lastStatusCode: z.number().int().nullable(),
  lastErrorCode: z.string().nullable(),
  lastError: z.string().nullable(),
  capability: z.object({
    confirmed: z.boolean(),
    activeMembershipCount: z.number().int().nonnegative(),
    confirmedBotIds: z.array(z.string()).default([]),
    memberships: z.array(safetyDeskDeleteMembershipCapabilitySchema).default([]),
  }),
  reasons: z.array(safetyDeskDeleteIntentReasonSchema).default([]),
});
export type SafetyDeskDeleteIntentItem = z.infer<typeof safetyDeskDeleteIntentItemSchema>;

export const safetyDeskAmbiguousSendItemSchema = z.object({
  id: z.string(),
  source: z.enum(['channel_auto_post', 'chat_auto_comment', 'chat_rules']),
  chatId: z.string(),
  chatTitle: z.string(),
  messageId: z.string().nullable(),
  botId: z.string().nullable(),
  startedAt: z.string().datetime(),
  detectedAt: z.string().datetime(),
  lastError: z.string(),
});
export type SafetyDeskAmbiguousSendItem = z.infer<typeof safetyDeskAmbiguousSendItemSchema>;

const safetyDeskDeleteRuntimeWindowSchema = z.object({
  count: z.number().int().nonnegative(),
  oldestAt: z.string().datetime().nullable(),
});

export const safetyDeskDeleteRuntimeResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  rolloutMode: z.enum(['off', 'shadow', 'canary', 'on']),
  summary: z.object({
    total: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    statusCounts: safetyDeskDeleteIntentStatusCountsSchema,
    due: safetyDeskDeleteRuntimeWindowSchema,
    staleLeases: safetyDeskDeleteRuntimeWindowSchema,
    ambiguousSends: safetyDeskDeleteRuntimeWindowSchema,
    oldestOpen: z.object({
      createdAt: z.string().datetime().nullable(),
      ageMs: z.number().int().nonnegative().nullable(),
    }),
  }),
  items: z.array(safetyDeskDeleteIntentItemSchema).default([]),
  ambiguousSends: z.array(safetyDeskAmbiguousSendItemSchema).default([]),
});
export type SafetyDeskDeleteRuntimeResponse = z.infer<typeof safetyDeskDeleteRuntimeResponseSchema>;

export const safetyDeskAllowAmbiguousSendRetryRequestSchema = z
  .object({
    expectedOperationId: z.string().trim().min(1),
    expectedStartedAt: z.string().datetime(),
  })
  .strict();
export type SafetyDeskAllowAmbiguousSendRetryRequest = z.infer<
  typeof safetyDeskAllowAmbiguousSendRetryRequestSchema
>;

export const safetyDeskRetryDeleteIntentRequestSchema = z
  .object({
    expectedStatus: z.enum(['EXPIRED', 'FAILED_TERMINAL']),
    expectedUpdatedAt: z.string().datetime(),
    expectedAttemptCount: z.number().int().nonnegative(),
  })
  .strict();
export type SafetyDeskRetryDeleteIntentRequest = z.infer<
  typeof safetyDeskRetryDeleteIntentRequestSchema
>;
