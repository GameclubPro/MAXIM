import { z } from 'zod';
import { botSpeechPersonaSchema } from './bot-speech.js';

export const managedEntityTypeSchema = z.enum(['chat', 'channel']);
export const managedEntityBotRoleSchema = z.enum(['primary', 'standby']);
export const managedEntityBotMembershipStatusSchema = z.enum(['active', 'removed']);
export const managedEntityBotLifecycleStateSchema = z.enum([
  'active',
  'dormant',
  'draining',
  'disabled',
]);
export const managedEntityBotCapabilitySchema = z.enum([
  'background_scans',
  'channel_stats',
  'suggestion_delivery',
  'membership_prewarm',
  'access_prewarm',
]);
export const managedEntitySharedModeSchema = z.enum([
  'owned',
  'shared-standby',
  'shared-assist',
  'shared-failover',
]);
export const managedEntityFavoriteTypeSchema = z.enum([
  'important',
  'watch',
  'broadcast',
  'test',
  'partner',
  'service',
]);
export type ManagedEntityType = z.infer<typeof managedEntityTypeSchema>;
export type ManagedEntityBotRole = z.infer<typeof managedEntityBotRoleSchema>;
export type ManagedEntityBotMembershipStatus = z.infer<
  typeof managedEntityBotMembershipStatusSchema
>;
export type ManagedEntityBotLifecycleState = z.infer<typeof managedEntityBotLifecycleStateSchema>;
export type ManagedEntityBotCapability = z.infer<typeof managedEntityBotCapabilitySchema>;
export type ManagedEntitySharedMode = z.infer<typeof managedEntitySharedModeSchema>;
export type ManagedEntityFavoriteType = z.infer<typeof managedEntityFavoriteTypeSchema>;

export const channelOverviewSchema = z.object({
  enabledScenariosCount: z.number().int().min(0).max(2),
  commentsEnabled: z.boolean(),
  postSuggestionsEnabled: z.boolean(),
  commentsModerationEnabled: z.boolean(),
});
export type ChannelOverview = z.infer<typeof channelOverviewSchema>;

export const managedEntityAssignedBotSchema = z.object({
  botId: z.string(),
  label: z.string(),
  role: managedEntityBotRoleSchema,
  membershipStatus: managedEntityBotMembershipStatusSchema,
  lifecycleState: managedEntityBotLifecycleStateSchema,
  speechPersona: botSpeechPersonaSchema.default('male'),
  characterName: z.string().nullable().optional().default(null),
  avatarUrl: z.string().trim().url().nullable().optional().default(null),
  capabilities: z.array(managedEntityBotCapabilitySchema).optional().default([]),
  permissionsSummary: z
    .object({
      checkedAt: z.string().datetime().nullable().default(null),
      isAdmin: z.boolean().default(false),
      isOwner: z.boolean().default(false),
      permissions: z.array(z.string()).default([]),
    })
    .nullable()
    .optional()
    .default(null),
});
export type ManagedEntityAssignedBot = z.infer<typeof managedEntityAssignedBotSchema>;

export const managedEntityBotExecutionPlanSchema = z.object({
  chatId: z.string(),
  entityType: managedEntityTypeSchema,
  primaryBotId: z.string().nullable(),
  speakerBotId: z.string().nullable(),
  workerBotId: z.string().nullable(),
  linkBotId: z.string().nullable(),
  partnerBotId: z.string().nullable(),
  partnerBotIds: z.array(z.string()).optional().default([]),
  sharedMode: managedEntitySharedModeSchema,
  userFacingPolicy: z.literal('owner-only'),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
  assignedBots: z.array(managedEntityAssignedBotSchema),
});
export type ManagedEntityBotExecutionPlan = z.infer<typeof managedEntityBotExecutionPlanSchema>;

export const updateManagedEntityPrimaryBotRequestSchema = z.object({
  botId: z.string().trim().min(1),
});
export type UpdateManagedEntityPrimaryBotRequest = z.infer<
  typeof updateManagedEntityPrimaryBotRequestSchema
>;

export const updateManagedEntityPartnerAssistRequestSchema = z.object({
  botId: z.string().trim().min(1),
  enabled: z.boolean(),
});
export type UpdateManagedEntityPartnerAssistRequest = z.infer<
  typeof updateManagedEntityPartnerAssistRequestSchema
>;

export const promoteManagedEntityStandbyRequestSchema = z.object({
  botId: z.string().trim().min(1).optional(),
});
export type PromoteManagedEntityStandbyRequest = z.infer<
  typeof promoteManagedEntityStandbyRequestSchema
>;

export const chatSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string().datetime(),
  entityType: managedEntityTypeSchema.default('chat'),
  link: z.string().trim().max(2048).nullable().optional().default(null),
  avatarUrl: z.string().trim().url().nullable().optional(),
  channelOverview: channelOverviewSchema.nullable().optional().default(null),
  primaryBotId: z.string().nullable().optional().default(null),
  assignedBots: z.array(managedEntityAssignedBotSchema).optional().default([]),
  sharedMode: managedEntitySharedModeSchema.optional().default('owned'),
  botCount: z.number().int().min(0).optional(),
  hasSharedAutomation: z.boolean().optional(),
  favoriteTypes: z.array(managedEntityFavoriteTypeSchema).optional(),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const managedEntitiesRefreshStateSchema = z.object({
  complete: z.boolean(),
  cursor: z.number().int().nullable(),
  backoffActive: z.boolean(),
  userVisibleComplete: z.boolean().optional(),
  nextPollAfterMs: z.number().int().min(0).default(1500),
  processedCandidates: z.number().int().min(0).nullable().optional().default(null),
  totalCandidates: z.number().int().min(0).nullable().optional().default(null),
  progressPercent: z.number().int().min(0).max(100).nullable().optional().default(null),
  lastSyncedAt: z.string().datetime().nullable().optional().default(null),
  manualRefreshBlockedReason: z
    .enum(['in_progress', 'recent_sync', 'backoff'])
    .nullable()
    .optional()
    .default(null),
  manualRefreshRetryAfterMs: z.number().int().min(0).nullable().optional().default(null),
});
export type ManagedEntitiesRefreshState = z.infer<typeof managedEntitiesRefreshStateSchema>;

export const managedEntitiesResponseSnapshotSchema = z.object({
  version: z.string().trim().min(1),
  builtAt: z.string().datetime(),
  lastSyncedAt: z.string().datetime().nullable().optional().default(null),
  source: z
    .enum(['published_snapshot', 'live_discovery', 'allowlist_cache', 'last_success_fallback'])
    .optional()
    .default('published_snapshot'),
  stale: z.boolean().optional().default(false),
});
export type ManagedEntitiesResponseSnapshot = z.infer<typeof managedEntitiesResponseSnapshotSchema>;

export const managedEntitiesResponseDiffNoopSchema = z.object({
  mode: z.literal('noop'),
  baseVersion: z.string().trim().min(1),
  nextVersion: z.string().trim().min(1),
});
export const managedEntitiesResponseDiffPatchSchema = z.object({
  mode: z.literal('patch'),
  baseVersion: z.string().trim().min(1),
  nextVersion: z.string().trim().min(1),
  added: z.array(chatSummarySchema).optional().default([]),
  updated: z.array(chatSummarySchema).optional().default([]),
  removedIds: z.array(z.string().trim().min(1)).optional().default([]),
  orderedIds: z.array(z.string().trim().min(1)).optional().default([]),
});
export const managedEntitiesResponseDiffSchema = z.discriminatedUnion('mode', [
  managedEntitiesResponseDiffNoopSchema,
  managedEntitiesResponseDiffPatchSchema,
]);
export type ManagedEntitiesResponseDiff = z.infer<typeof managedEntitiesResponseDiffSchema>;

export const managedEntitiesListResponseSchema = z.object({
  items: z.array(chatSummarySchema),
  refresh: managedEntitiesRefreshStateSchema,
  snapshot: managedEntitiesResponseSnapshotSchema.nullable().optional(),
  diff: managedEntitiesResponseDiffSchema.nullable().optional(),
});
export type ManagedEntitiesListResponse = z.infer<typeof managedEntitiesListResponseSchema>;

export const managedEntityHandshakeOutcomeStatusSchema = z.enum([
  'connected',
  'already_connected',
  'bootstrapped_without_user',
  'bot_denied',
  'user_denied',
  'rate_limited',
  'failed',
]);
export type ManagedEntityHandshakeOutcomeStatus = z.infer<
  typeof managedEntityHandshakeOutcomeStatusSchema
>;

export const managedEntityOnboardingDiagnosticSignalSchema = z.object({
  type: z.enum(['recent_activity', 'access_edge', 'handshake']),
  chatId: z.string().trim().min(1),
  title: z.string().trim().nullable().optional().default(null),
  status: z.string().trim().min(1),
  at: z.string().datetime().nullable().optional().default(null),
});
export type ManagedEntityOnboardingDiagnosticSignal = z.infer<
  typeof managedEntityOnboardingDiagnosticSignalSchema
>;

export const managedEntityOnboardingDiagnosticsSchema = z.object({
  entityType: managedEntityTypeSchema,
  hasVisibleEntities: z.boolean(),
  recentSignals: z.array(managedEntityOnboardingDiagnosticSignalSchema).default([]),
  lastHandshake: z
    .object({
      chatId: z.string().trim().min(1),
      title: z.string().trim().nullable().optional().default(null),
      status: managedEntityHandshakeOutcomeStatusSchema,
      reason: z.string().trim().nullable().optional().default(null),
      happenedAt: z.string().datetime(),
    })
    .nullable()
    .default(null),
});
export type ManagedEntityOnboardingDiagnostics = z.infer<
  typeof managedEntityOnboardingDiagnosticsSchema
>;

export const managedEntityAccessLossReasonSchema = z.enum([
  'chat_not_found',
  'bot_denied',
  'bot_removed',
  'chat_inaccessible',
]);
export type ManagedEntityAccessLossReason = z.infer<typeof managedEntityAccessLossReasonSchema>;

export const managedEntityAccessLossDiagnosticItemSchema = z.object({
  reason: managedEntityAccessLossReasonSchema,
  detectedAt: z.string().datetime(),
  botId: z.string().trim().min(1).nullable().optional().default(null),
  botLabel: z.string().trim().max(120).nullable().optional().default(null),
});
export type ManagedEntityAccessLossDiagnosticItem = z.infer<
  typeof managedEntityAccessLossDiagnosticItemSchema
>;

export const managedEntityPrivateAccessLossDiagnosticItemSchema =
  managedEntityAccessLossDiagnosticItemSchema.extend({
    botId: z.string().trim().min(1),
    botLabel: z.string().trim().max(120).nullable().optional().default(null),
    source: z.string().trim().min(1),
    lastMaxErrorCode: z.string().trim().min(1).nullable().optional().default(null),
    lastMaxErrorMessage: z.string().trim().min(1).nullable().optional().default(null),
    lastMaxStatusCode: z.number().int().nullable().optional().default(null),
  });
export type ManagedEntityPrivateAccessLossDiagnosticItem = z.infer<
  typeof managedEntityPrivateAccessLossDiagnosticItemSchema
>;

export const managedEntityAccessDiagnosticsSchema = z.object({
  state: z.enum(['ok', 'checking', 'stale', 'bot_access_lost']),
  lastDetectedAt: z.string().datetime().nullable().optional().default(null),
  lastCheckedAt: z.string().datetime().nullable().optional().default(null),
  freshUntil: z.string().datetime().nullable().optional().default(null),
  source: z
    .enum(['live', 'access_edge', 'membership_snapshot', 'cache', 'unknown'])
    .optional()
    .default('unknown'),
  activeBotCount: z.number().int().min(0).optional().default(0),
  lostBots: z.array(managedEntityAccessLossDiagnosticItemSchema).optional().default([]),
});
export type ManagedEntityAccessDiagnostics = z.infer<
  typeof managedEntityAccessDiagnosticsSchema
>;

export const managedEntityViewerAccessSchema = z.object({
  state: z.enum(['granted', 'denied', 'stale', 'checking']),
  reason: z
    .enum(['user_not_admin', 'bot_not_admin', 'bot_access_lost', 'unknown'])
    .nullable()
    .optional()
    .default(null),
  checkedAt: z.string().datetime().nullable().optional().default(null),
  canEdit: z.boolean().default(false),
});
export type ManagedEntityViewerAccess = z.infer<typeof managedEntityViewerAccessSchema>;

export const managedEntityHeaderSchema = z.object({
  id: z.string(),
  title: z.string(),
  entityType: managedEntityTypeSchema,
  link: z.string().trim().max(2048).nullable(),
  participantsCount: z.number().int().min(0).nullable(),
  avatarUrl: z.string().trim().url().nullable().optional(),
  primaryBotId: z.string().nullable().optional().default(null),
  assignedBots: z.array(managedEntityAssignedBotSchema).optional().default([]),
  sharedMode: managedEntitySharedModeSchema.optional().default('owned'),
  botCount: z.number().int().min(0).optional(),
  hasSharedAutomation: z.boolean().optional(),
  accessDiagnostics: managedEntityAccessDiagnosticsSchema
    .optional()
    .default({
      state: 'ok',
      lastDetectedAt: null,
      lastCheckedAt: null,
      freshUntil: null,
      source: 'unknown',
      activeBotCount: 0,
      lostBots: [],
    }),
  viewerAccess: managedEntityViewerAccessSchema
    .optional()
    .default({ state: 'checking', reason: null, checkedAt: null, canEdit: false }),
});
export type ManagedEntityHeader = z.infer<typeof managedEntityHeaderSchema>;

export const managedEntityAccessRecheckResponseSchema = z.object({
  entityType: managedEntityTypeSchema,
  entityId: z.string().trim().min(1),
  scheduled: z.boolean(),
  diagnostics: managedEntityAccessDiagnosticsSchema,
});
export type ManagedEntityAccessRecheckResponse = z.infer<
  typeof managedEntityAccessRecheckResponseSchema
>;

export const updateManagedEntityFavoritesRequestSchema = z
  .object({
    favoriteTypes: z.array(managedEntityFavoriteTypeSchema).max(6).default([]),
  })
  .transform((value) => ({
    favoriteTypes: Array.from(new Set(value.favoriteTypes)),
  }));
export type UpdateManagedEntityFavoritesRequest = z.infer<
  typeof updateManagedEntityFavoritesRequestSchema
>;

export const managedEntityFavoritesResponseSchema = z.object({
  entityType: managedEntityTypeSchema,
  entityId: z.string().trim().min(1),
  favoriteTypes: z.array(managedEntityFavoriteTypeSchema),
});
export type ManagedEntityFavoritesResponse = z.infer<typeof managedEntityFavoritesResponseSchema>;
