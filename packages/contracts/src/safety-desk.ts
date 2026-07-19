import { z } from 'zod';
import { broadcastTextFormatSchema } from './broadcast-common.js';
import { VK_PARSING_MAX_VIDEOS } from './vk-parsing-common.js';

export const safetyDeskReviewStatusSchema = z.enum(['REVIEW', 'APPROVED', 'REJECTED', 'BLOCKED']);
export type SafetyDeskReviewStatus = z.infer<typeof safetyDeskReviewStatusSchema>;

export const safetyDeskRiskLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'BLOCKED']);
export type SafetyDeskRiskLevel = z.infer<typeof safetyDeskRiskLevelSchema>;

export const safetyDeskQueueSourceSchema = z.enum(['VK_REVIEW']);
export type SafetyDeskQueueSource = z.infer<typeof safetyDeskQueueSourceSchema>;

export const safetyDeskCheckSchema = z.object({
  label: z.string(),
  state: z.enum(['PASSED', 'WARNING', 'BLOCKED']),
});
export type SafetyDeskCheck = z.infer<typeof safetyDeskCheckSchema>;

export const safetyDeskQueueItemSchema = z.object({
  id: z.string(),
  source: safetyDeskQueueSourceSchema,
  sourceId: z.string(),
  chatId: z.string(),
  entityTitle: z.string(),
  sourceTitle: z.string(),
  author: z.string(),
  status: safetyDeskReviewStatusSchema,
  risk: safetyDeskRiskLevelSchema,
  title: z.string(),
  text: z.string(),
  textFormat: broadcastTextFormatSchema.default('plain'),
  previewHtml: z.string().default(''),
  domains: z.array(z.string()).default([]),
  photoUrls: z.array(z.string().url()).default([]),
  videoUrls: z.array(z.string().url()).max(VK_PARSING_MAX_VIDEOS).default([]),
  linkUrls: z.array(z.string().url()).default([]),
  originalUrl: z.string().url().nullable().default(null),
  scheduledAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  reasons: z.array(z.string()).default([]),
  checks: z.array(safetyDeskCheckSchema).default([]),
});
export type SafetyDeskQueueItem = z.infer<typeof safetyDeskQueueItemSchema>;

export const safetyDeskAuditEntrySchema = z.object({
  id: z.string(),
  itemId: z.string().nullable().default(null),
  action: z.string(),
  title: z.string(),
  createdAt: z.string().datetime(),
});
export type SafetyDeskAuditEntry = z.infer<typeof safetyDeskAuditEntrySchema>;

export const safetyDeskSummarySchema = z.object({
  review: z.number().int().min(0).default(0),
  approved: z.number().int().min(0).default(0),
  rejected: z.number().int().min(0).default(0),
  blocked: z.number().int().min(0).default(0),
  servicePosts: z.number().int().min(0).default(0),
});
export type SafetyDeskSummary = z.infer<typeof safetyDeskSummarySchema>;

export const safetyDeskQueueResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  items: z.array(safetyDeskQueueItemSchema).default([]),
  summary: safetyDeskSummarySchema,
  audit: z.array(safetyDeskAuditEntrySchema).default([]),
});
export type SafetyDeskQueueResponse = z.infer<typeof safetyDeskQueueResponseSchema>;

export const safetyDeskDecisionRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type SafetyDeskDecisionRequest = z.infer<typeof safetyDeskDecisionRequestSchema>;

export const safetyDeskApproveAllRequestSchema = z.object({
  itemIds: z.array(z.string().trim().min(1)).min(1).max(100),
  reason: z.string().trim().max(500).optional(),
});
export type SafetyDeskApproveAllRequest = z.infer<typeof safetyDeskApproveAllRequestSchema>;

export const safetyDeskDecisionResponseSchema = z.object({
  item: safetyDeskQueueItemSchema.nullable().default(null),
  queue: safetyDeskQueueResponseSchema,
  message: z.string(),
});
export type SafetyDeskDecisionResponse = z.infer<typeof safetyDeskDecisionResponseSchema>;

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

export const safetyDeskGiveawayWinnerNotificationDeadEndStatusSchema = z.enum([
  'AMBIGUOUS',
  'FAILED_TERMINAL',
]);
export type SafetyDeskGiveawayWinnerNotificationDeadEndStatus = z.infer<
  typeof safetyDeskGiveawayWinnerNotificationDeadEndStatusSchema
>;

export const safetyDeskGiveawayWinnerNotificationDeadEndItemSchema = z.object({
  notificationId: z.string(),
  giveawayId: z.string(),
  giveawayTitle: z.string(),
  sourceChatId: z.string(),
  winnerId: z.string(),
  userId: z.string(),
  botId: z.string().nullable(),
  status: safetyDeskGiveawayWinnerNotificationDeadEndStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  lastError: z.string().max(1_000).nullable(),
  nextAttemptAt: z.string().datetime(),
  lockedAt: z.string().datetime().nullable(),
  dispatchedAt: z.string().datetime().nullable(),
  ambiguousAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SafetyDeskGiveawayWinnerNotificationDeadEndItem = z.infer<
  typeof safetyDeskGiveawayWinnerNotificationDeadEndItemSchema
>;

const safetyDeskDeleteRuntimeWindowSchema = z.object({
  count: z.number().int().nonnegative(),
  oldestAt: z.string().datetime().nullable(),
});

export const safetyDeskDeleteRuntimeResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  rolloutMode: z.enum(['off', 'shadow', 'canary', 'on']),
  replacementCleanupEnabled: z.boolean().default(false),
  summary: z.object({
    total: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    statusCounts: safetyDeskDeleteIntentStatusCountsSchema,
    due: safetyDeskDeleteRuntimeWindowSchema,
    staleLeases: safetyDeskDeleteRuntimeWindowSchema,
    ambiguousSends: safetyDeskDeleteRuntimeWindowSchema,
    giveawayWinnerNotificationDeadEnds: z.object({
      count: z.number().int().nonnegative(),
      ambiguous: z.number().int().nonnegative(),
      failedTerminal: z.number().int().nonnegative(),
      oldestAt: z.string().datetime().nullable(),
    }),
    oldestOpen: z.object({
      createdAt: z.string().datetime().nullable(),
      ageMs: z.number().int().nonnegative().nullable(),
    }),
  }),
  items: z.array(safetyDeskDeleteIntentItemSchema).default([]),
  ambiguousSends: z.array(safetyDeskAmbiguousSendItemSchema).default([]),
  giveawayWinnerNotificationDeadEnds: z
    .array(safetyDeskGiveawayWinnerNotificationDeadEndItemSchema)
    .max(50)
    .default([]),
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
