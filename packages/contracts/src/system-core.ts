import { z } from 'zod';
import { managedEntityBotCapabilitySchema } from './managed-entities.js';

export const queueCountersSchema = z.object({
  waiting: z.number().int().min(0),
  prioritized: z.number().int().min(0).optional(),
  active: z.number().int().min(0),
  delayed: z.number().int().min(0),
  failed: z.number().int().min(0),
  completed: z.number().int().min(0),
});
export type QueueCounters = z.infer<typeof queueCountersSchema>;

export const webhookStatusMetricsSchema = z.object({
  count: z.number().int().min(0),
  oldestEventId: z.string().nullable(),
  oldestCreatedAt: z.string().datetime().nullable(),
  oldestLagSec: z.number().min(0),
});
export type WebhookStatusMetrics = z.infer<typeof webhookStatusMetricsSchema>;

export const actionHealthSnapshotSchema = z.object({
  windowSec: z.number().int().min(1),
  total: z.number().int().min(0),
  success: z.number().int().min(0),
  failure: z.number().int().min(0),
  critical: z.number().int().min(0),
  errorRate: z.number().min(0),
  criticalRate: z.number().min(0),
});
export type ActionHealthSnapshot = z.infer<typeof actionHealthSnapshotSchema>;

const emptyWebhookStatusMetrics = {
  count: 0,
  oldestEventId: null,
  oldestCreatedAt: null,
  oldestLagSec: 0,
};

export const botQueueMetricsSnapshotSchema = z.object({
  webhookEvents: z.object({
    received: webhookStatusMetricsSchema,
    queued: webhookStatusMetricsSchema,
    failed: webhookStatusMetricsSchema,
  }),
  userFacingWebhookEvents: z
    .object({
      received: webhookStatusMetricsSchema,
      queued: webhookStatusMetricsSchema,
      failed: webhookStatusMetricsSchema,
    })
    .optional()
    .default({
      received: emptyWebhookStatusMetrics,
      queued: emptyWebhookStatusMetrics,
      failed: emptyWebhookStatusMetrics,
    }),
  queuedByQueue: z.record(z.string(), z.number().int().min(0)),
  actionHealth: actionHealthSnapshotSchema,
  oldestQueuedEventId: z.string().nullable(),
  oldestQueuedCreatedAt: z.string().datetime().nullable(),
  oldestQueuedLagSec: z.number().min(0),
  oldestReceivedEventId: z.string().nullable(),
  oldestReceivedCreatedAt: z.string().datetime().nullable(),
  oldestReceivedLagSec: z.number().min(0),
  effectiveLagSec: z.number().min(0),
  userFacingOldestQueuedEventId: z.string().nullable().optional().default(null),
  userFacingOldestQueuedCreatedAt: z.string().datetime().nullable().optional().default(null),
  userFacingOldestQueuedLagSec: z.number().min(0).optional().default(0),
  userFacingOldestReceivedEventId: z.string().nullable().optional().default(null),
  userFacingOldestReceivedCreatedAt: z.string().datetime().nullable().optional().default(null),
  userFacingOldestReceivedLagSec: z.number().min(0).optional().default(0),
  userFacingEffectiveLagSec: z.number().min(0).optional().default(0),
});
export type BotQueueMetricsSnapshot = z.infer<typeof botQueueMetricsSnapshotSchema>;

export const systemModeSchema = z.enum(['normal', 'degrade']);
export type SystemMode = z.infer<typeof systemModeSchema>;

export const systemModeSourceSchema = z.enum(['auto', 'manual']);
export type SystemModeSource = z.infer<typeof systemModeSourceSchema>;

export const systemModeSnapshotSchema = z.object({
  mode: systemModeSchema,
  source: systemModeSourceSchema,
  reason: z.string(),
  updatedAt: z.string().datetime(),
  manualMode: systemModeSchema.nullable(),
  queueLagSec: z.number().min(0),
  action: actionHealthSnapshotSchema,
});
export type SystemModeSnapshot = z.infer<typeof systemModeSnapshotSchema>;

export const queueMetricsSnapshotSchema = z.object({
  moderation: queueCountersSchema,
  webhookCritical: queueCountersSchema,
  webhookJoin: queueCountersSchema.optional().default({
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
  }),
  webhookJoinShards: z.record(z.string(), queueCountersSchema).optional().default({}),
  webhookDefault: queueCountersSchema,
  webhookDefaultShards: z.record(z.string(), queueCountersSchema).optional().default({}),
  webhookDefaultWorkerGroups: z
    .record(
      z.string(),
      z.object({
        queues: z.array(z.string()),
        counters: queueCountersSchema,
      }),
    )
    .optional()
    .default({}),
  webhookBackground: queueCountersSchema,
  webhookLegacy: queueCountersSchema,
  actions: queueCountersSchema,
  globalSpammerDenorm: queueCountersSchema.optional().default({
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
  }),
  auxiliaryQueues: z.record(z.string(), queueCountersSchema).optional().default({}),
  webhookEvents: z.object({
    received: webhookStatusMetricsSchema,
    queued: webhookStatusMetricsSchema,
    failed: webhookStatusMetricsSchema,
  }),
  userFacingWebhookEvents: z
    .object({
      received: webhookStatusMetricsSchema,
      queued: webhookStatusMetricsSchema,
      failed: webhookStatusMetricsSchema,
    })
    .optional()
    .default({
      received: emptyWebhookStatusMetrics,
      queued: emptyWebhookStatusMetrics,
      failed: emptyWebhookStatusMetrics,
    }),
  actionHealth: actionHealthSnapshotSchema,
  webhookDynamicLeases: z.unknown().nullable().optional().default(null),
  bots: z.record(z.string(), botQueueMetricsSnapshotSchema),
  oldestQueuedEventId: z.string().nullable(),
  oldestQueuedCreatedAt: z.string().datetime().nullable(),
  oldestQueuedLagSec: z.number().min(0),
  oldestReceivedEventId: z.string().nullable(),
  oldestReceivedCreatedAt: z.string().datetime().nullable(),
  oldestReceivedLagSec: z.number().min(0),
  effectiveLagSec: z.number().min(0),
  userFacingOldestQueuedEventId: z.string().nullable().optional().default(null),
  userFacingOldestQueuedCreatedAt: z.string().datetime().nullable().optional().default(null),
  userFacingOldestQueuedLagSec: z.number().min(0).optional().default(0),
  userFacingOldestReceivedEventId: z.string().nullable().optional().default(null),
  userFacingOldestReceivedCreatedAt: z.string().datetime().nullable().optional().default(null),
  userFacingOldestReceivedLagSec: z.number().min(0).optional().default(0),
  userFacingEffectiveLagSec: z.number().min(0).optional().default(0),
  generatedAt: z.string().datetime(),
});
export type QueueMetricsSnapshot = z.infer<typeof queueMetricsSnapshotSchema>;

export const systemDashboardStatusSchema = z.enum(['healthy', 'warning', 'critical']);
export type SystemDashboardStatus = z.infer<typeof systemDashboardStatusSchema>;

export const systemDashboardAlertLevelSchema = z.enum(['info', 'warning', 'critical']);
export type SystemDashboardAlertLevel = z.infer<typeof systemDashboardAlertLevelSchema>;

export const systemDashboardAlertSchema = z.object({
  code: z.string(),
  level: systemDashboardAlertLevelSchema,
  title: z.string(),
  detail: z.string(),
  recommendedAction: z.string(),
});
export type SystemDashboardAlert = z.infer<typeof systemDashboardAlertSchema>;

export const webhookSubscriptionSnapshotStatusSchema = z.enum([
  'healthy',
  'warning',
  'critical',
  'disabled',
]);
export type WebhookSubscriptionSnapshotStatus = z.infer<
  typeof webhookSubscriptionSnapshotStatusSchema
>;

export const botWebhookOperationalIssueSchema = z.enum([
  'no-active-memberships',
  'no-incoming-webhooks',
]);
export type BotWebhookOperationalIssue = z.infer<typeof botWebhookOperationalIssueSchema>;

export const botWebhookOperationalDiagnosticsSchema = z.object({
  lifecycleState: z.string(),
  activeMemberships: z.number().int().min(0),
  hasCurrentSubscription: z.boolean(),
  lastIncomingWebhookAt: z.string().datetime().nullable(),
  lastMembershipWebhookAt: z.string().datetime().nullable(),
  issueCodes: z.array(botWebhookOperationalIssueSchema),
});
export type BotWebhookOperationalDiagnostics = z.infer<
  typeof botWebhookOperationalDiagnosticsSchema
>;

export const botWebhookSubscriptionSnapshotSchema = z.object({
  botId: z.string(),
  status: webhookSubscriptionSnapshotStatusSchema,
  configured: z.boolean(),
  url: z.string().nullable(),
  checkedAt: z.string().datetime().nullable(),
  reconciledAt: z.string().datetime().nullable(),
  requiredUpdateTypes: z.array(z.string()),
  actualUpdateTypes: z.array(z.string()),
  missingUpdateTypes: z.array(z.string()),
  extraUpdateTypes: z.array(z.string()),
  otherSubscriptionsCount: z.number().int().min(0),
  lastError: z.string().nullable(),
  note: z.string().nullable(),
  operationalDiagnostics: botWebhookOperationalDiagnosticsSchema.optional(),
});
export type BotWebhookSubscriptionSnapshot = z.infer<typeof botWebhookSubscriptionSnapshotSchema>;

export const webhookSubscriptionOperationalDiagnosticsSchema = z.object({
  warningBotCount: z.number().int().min(0),
  warningBotIds: z.array(z.string()),
  noActiveMembershipBotIds: z.array(z.string()),
  noIncomingWebhookBotIds: z.array(z.string()),
});
export type WebhookSubscriptionOperationalDiagnostics = z.infer<
  typeof webhookSubscriptionOperationalDiagnosticsSchema
>;

export const webhookSubscriptionSnapshotSchema = z.object({
  status: webhookSubscriptionSnapshotStatusSchema,
  configured: z.boolean(),
  url: z.string().nullable(),
  checkedAt: z.string().datetime().nullable(),
  reconciledAt: z.string().datetime().nullable(),
  requiredUpdateTypes: z.array(z.string()),
  actualUpdateTypes: z.array(z.string()),
  missingUpdateTypes: z.array(z.string()),
  extraUpdateTypes: z.array(z.string()),
  otherSubscriptionsCount: z.number().int().min(0),
  lastError: z.string().nullable(),
  note: z.string().nullable(),
  botCount: z.number().int().min(0),
  bots: z.record(z.string(), botWebhookSubscriptionSnapshotSchema),
  operationalDiagnostics: webhookSubscriptionOperationalDiagnosticsSchema.optional(),
});
export type WebhookSubscriptionSnapshot = z.infer<typeof webhookSubscriptionSnapshotSchema>;

export const systemBotLifecycleStateSchema = z.enum(['active', 'draining', 'dormant', 'disabled']);
export type SystemBotLifecycleState = z.infer<typeof systemBotLifecycleStateSchema>;

export const systemBotEntityTypeSchema = z.enum(['chat', 'channel']);
export type SystemBotEntityType = z.infer<typeof systemBotEntityTypeSchema>;

export const systemBotMembershipRoleSchema = z.enum(['primary', 'standby']);
export type SystemBotMembershipRole = z.infer<typeof systemBotMembershipRoleSchema>;

export const systemBotMembershipStatusSchema = z.enum(['active', 'removed']);
export type SystemBotMembershipStatus = z.infer<typeof systemBotMembershipStatusSchema>;

export const systemBotAccessStateSchema = z.enum([
  'unknown',
  'confirmed_owner',
  'confirmed_admin',
  'confirmed_member',
  'denied',
  'lost',
  'stale',
]);
export type SystemBotAccessState = z.infer<typeof systemBotAccessStateSchema>;

export const systemBotEntityCountSchema = z.object({
  total: z.number().int().min(0),
  chats: z.number().int().min(0),
  channels: z.number().int().min(0),
});
export type SystemBotEntityCount = z.infer<typeof systemBotEntityCountSchema>;

export const systemBotManagedEntityStatsSchema = z.object({
  primary: systemBotEntityCountSchema,
  standby: systemBotEntityCountSchema,
  assist: systemBotEntityCountSchema,
});
export type SystemBotManagedEntityStats = z.infer<typeof systemBotManagedEntityStatsSchema>;

export const systemBotAccessStatsSchema = z.object({
  lost: z.number().int().min(0),
  stale: z.number().int().min(0),
  denied: z.number().int().min(0),
  unknown: z.number().int().min(0),
  removedAfterLoss: z.number().int().min(0),
});
export type SystemBotAccessStats = z.infer<typeof systemBotAccessStatsSchema>;

export const systemBotMaxApiLoadSchema = z.object({
  windowSec: z.number().int().min(1),
  totalRequests: z.number().int().min(0),
  avgRps: z.number().min(0),
  peakRps: z.number().int().min(0),
  avgLoad: z.number().min(0).max(1),
  peakLoad: z.number().min(0).max(1),
  smoothedLoad: z.number().min(0).max(1),
  background: z.object({
    totalRequests: z.number().int().min(0),
    avgRps: z.number().min(0),
    peakRps: z.number().int().min(0),
  }),
});
export type SystemBotMaxApiLoad = z.infer<typeof systemBotMaxApiLoadSchema>;

export const systemBotProblemKindSchema = z.enum([
  'lost-access',
  'stale-access',
  'denied-access',
  'removed-after-loss',
]);
export type SystemBotProblemKind = z.infer<typeof systemBotProblemKindSchema>;

export const systemBotProblemSampleSchema = z.object({
  chatId: z.string(),
  title: z.string(),
  entityType: systemBotEntityTypeSchema,
  kind: systemBotProblemKindSchema,
  botRole: systemBotMembershipRoleSchema,
  membershipStatus: systemBotMembershipStatusSchema,
  botAccessState: systemBotAccessStateSchema,
  primaryBotId: z.string().nullable(),
  checkedAt: z.string().datetime().nullable(),
  lastSeenAt: z.string().datetime().nullable(),
  lastWebhookAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});
export type SystemBotProblemSample = z.infer<typeof systemBotProblemSampleSchema>;

export const systemBotSummarySchema = z.object({
  botId: z.string(),
  label: z.string(),
  characterName: z.string(),
  lifecycleState: systemBotLifecycleStateSchema,
  adminVisible: z.boolean(),
  isDefault: z.boolean(),
  contactId: z.string().nullable(),
  webhook: botWebhookSubscriptionSnapshotSchema.nullable(),
  operationalDiagnostics: botWebhookOperationalDiagnosticsSchema.nullable(),
  queue: botQueueMetricsSnapshotSchema.nullable(),
  maxApiLoad: systemBotMaxApiLoadSchema,
  entities: systemBotManagedEntityStatsSchema,
  access: systemBotAccessStatsSchema,
  problemSamples: z.array(systemBotProblemSampleSchema),
});
export type SystemBotSummary = z.infer<typeof systemBotSummarySchema>;

export const systemBotFleetSummarySchema = z.object({
  total: z.number().int().min(0),
  adminVisible: z.number().int().min(0),
  active: z.number().int().min(0),
  draining: z.number().int().min(0),
  dormant: z.number().int().min(0),
  disabled: z.number().int().min(0),
  webhookWarningBotCount: z.number().int().min(0),
  problemBotCount: z.number().int().min(0),
  primaryEntities: systemBotEntityCountSchema,
  standbyEntities: systemBotEntityCountSchema,
  assistEntities: systemBotEntityCountSchema,
  lostAccess: z.number().int().min(0),
  staleAccess: z.number().int().min(0),
  deniedAccess: z.number().int().min(0),
});
export type SystemBotFleetSummary = z.infer<typeof systemBotFleetSummarySchema>;

export const systemBotsSnapshotSchema = z.object({
  generatedAt: z.string().datetime(),
  summary: systemBotFleetSummarySchema,
  bots: z.array(systemBotSummarySchema),
});
export type SystemBotsSnapshot = z.infer<typeof systemBotsSnapshotSchema>;

export const systemBotRoutePurposeSchema = z.enum([
  'default',
  'read',
  'send_message',
  'member_access',
  'moderation_action',
  'capability',
]);
export type SystemBotRoutePurpose = z.infer<typeof systemBotRoutePurposeSchema>;

export const systemBotRouteModerationActionSchema = z.enum(['delete_message', 'moderate_member']);
export type SystemBotRouteModerationAction = z.infer<typeof systemBotRouteModerationActionSchema>;

export const systemBotRouteReasonSchema = z.enum([
  'explicit',
  'chat_cache',
  'chat_primary',
  'context',
  'default',
  'primary_confirmed',
  'alternate_confirmed',
  'primary_soft',
  'alternate_soft',
  'primary_fallback',
  'alternate_fallback',
]);
export type SystemBotRouteReason = z.infer<typeof systemBotRouteReasonSchema>;

export const systemBotRouteBotSchema = z.object({
  botId: z.string(),
  label: z.string(),
  lifecycleState: systemBotLifecycleStateSchema,
  adminVisible: z.boolean(),
  isDefault: z.boolean(),
});
export type SystemBotRouteBot = z.infer<typeof systemBotRouteBotSchema>;

export const systemBotPermissionsSummarySchema = z.object({
  checkedAt: z.string().datetime().nullable(),
  isAdmin: z.boolean(),
  isOwner: z.boolean(),
  permissions: z.array(z.string()),
});
export type SystemBotPermissionsSummary = z.infer<typeof systemBotPermissionsSummarySchema>;

export const systemBotRouteMembershipSchema = z.object({
  botId: z.string(),
  label: z.string().nullable(),
  configured: z.boolean(),
  lifecycleState: systemBotLifecycleStateSchema.nullable(),
  operational: z.boolean(),
  discoverable: z.boolean(),
  executable: z.boolean(),
  role: systemBotMembershipRoleSchema,
  status: systemBotMembershipStatusSchema,
  botAccessState: systemBotAccessStateSchema,
  capabilities: z.array(managedEntityBotCapabilitySchema),
  permissionsSummary: systemBotPermissionsSummarySchema.nullable(),
  botAccessCheckedAt: z.string().datetime().nullable(),
  botAccessExpiresAt: z.string().datetime().nullable(),
  botAccessSource: z.string().nullable(),
  botAccessLastErrorCode: z.string().nullable(),
  lastSeenAt: z.string().datetime().nullable(),
  lastWebhookAt: z.string().datetime().nullable(),
  issues: z.array(z.string()),
});
export type SystemBotRouteMembership = z.infer<typeof systemBotRouteMembershipSchema>;

export const systemBotRoutePreviewRouteSchema = z.object({
  purpose: systemBotRoutePurposeSchema,
  action: systemBotRouteModerationActionSchema.nullable(),
  capability: managedEntityBotCapabilitySchema.nullable(),
  chatId: z.string().nullable(),
  primaryBotId: z.string().nullable(),
  botId: z.string().nullable(),
  candidateBotIds: z.array(z.string()),
  reason: systemBotRouteReasonSchema.nullable(),
  selectedBot: systemBotRouteBotSchema.nullable(),
  candidateBots: z.array(systemBotRouteBotSchema),
});
export type SystemBotRoutePreviewRoute = z.infer<typeof systemBotRoutePreviewRouteSchema>;

export const systemBotRoutePreviewResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  query: z.object({
    chatId: z.string(),
    purpose: z.union([z.literal('all'), systemBotRoutePurposeSchema]),
    action: systemBotRouteModerationActionSchema.nullable(),
    capability: managedEntityBotCapabilitySchema.nullable(),
    fallbackToPrimary: z.boolean(),
    botId: z.string().nullable(),
  }),
  chat: z.object({
    exists: z.boolean(),
    chatId: z.string(),
    title: z.string().nullable(),
    entityType: systemBotEntityTypeSchema.nullable(),
    catalogKind: z.string().nullable(),
    storedPrimaryBotId: z.string().nullable(),
    legacyBotId: z.string().nullable(),
  }),
  routes: z.array(systemBotRoutePreviewRouteSchema),
  memberships: z.array(systemBotRouteMembershipSchema),
  warnings: z.array(z.string()),
});
export type SystemBotRoutePreviewResponse = z.infer<typeof systemBotRoutePreviewResponseSchema>;

export const systemBotMembershipAuditKindSchema = z.enum([
  'denied-active-primary',
  'stored-primary-denied-alternate-eligible',
  'stale-permissions-snapshot',
  'capabilities-on-denied-bot',
  'type-mismatch',
  'suspicious-row',
]);
export type SystemBotMembershipAuditKind = z.infer<typeof systemBotMembershipAuditKindSchema>;

export const systemBotMembershipAuditSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type SystemBotMembershipAuditSeverity = z.infer<
  typeof systemBotMembershipAuditSeveritySchema
>;

export const systemBotMembershipAuditSummarySchema = z.object({
  auditedEntities: z.number().int().min(0),
  activeMemberships: z.number().int().min(0),
  deniedActivePrimary: z.number().int().min(0),
  storedPrimaryDeniedAlternateEligible: z.number().int().min(0),
  stalePermissionsSnapshot: z.number().int().min(0),
  capabilitiesOnDeniedBot: z.number().int().min(0),
  typeMismatch: z.number().int().min(0),
  suspiciousRows: z.number().int().min(0),
  warningCount: z.number().int().min(0),
  criticalCount: z.number().int().min(0),
});
export type SystemBotMembershipAuditSummary = z.infer<typeof systemBotMembershipAuditSummarySchema>;

export const systemBotMembershipAuditBotSummarySchema = z.object({
  botId: z.string(),
  label: z.string().nullable(),
  deniedPrimary: z.number().int().min(0),
  staleSnapshots: z.number().int().min(0),
  deniedCapabilities: z.number().int().min(0),
  alternateEligibleFor: z.number().int().min(0),
});
export type SystemBotMembershipAuditBotSummary = z.infer<
  typeof systemBotMembershipAuditBotSummarySchema
>;

export const systemBotMembershipAuditSampleSchema = z.object({
  kind: systemBotMembershipAuditKindSchema,
  severity: systemBotMembershipAuditSeveritySchema,
  chatId: z.string(),
  title: z.string(),
  entityType: systemBotEntityTypeSchema,
  catalogKind: z.string(),
  botId: z.string().nullable(),
  botLabel: z.string().nullable(),
  primaryBotId: z.string().nullable(),
  suggestedPrimaryBotId: z.string().nullable(),
  alternateBotIds: z.array(z.string()),
  membershipRole: systemBotMembershipRoleSchema.nullable(),
  membershipStatus: systemBotMembershipStatusSchema.nullable(),
  botAccessState: systemBotAccessStateSchema.nullable(),
  permissionsState: z.enum(['missing', 'fresh', 'stale', 'denied']),
  permissionsCheckedAt: z.string().datetime().nullable(),
  botAccessCheckedAt: z.string().datetime().nullable(),
  botAccessExpiresAt: z.string().datetime().nullable(),
  botAccessSource: z.string().nullable(),
  botAccessLastErrorCode: z.string().nullable(),
  capabilities: z.array(managedEntityBotCapabilitySchema),
  evidenceFresh: z.boolean(),
  reason: z.string(),
});
export type SystemBotMembershipAuditSample = z.infer<typeof systemBotMembershipAuditSampleSchema>;

export const systemBotMembershipAuditSchema = z.object({
  generatedAt: z.string().datetime(),
  config: z.object({
    snapshotFreshMs: z.number().int().min(0),
    sampleLimit: z.number().int().min(1),
  }),
  summary: systemBotMembershipAuditSummarySchema,
  byBot: z.array(systemBotMembershipAuditBotSummarySchema),
  samples: z.array(systemBotMembershipAuditSampleSchema),
});
export type SystemBotMembershipAudit = z.infer<typeof systemBotMembershipAuditSchema>;

export const systemDashboardSummarySchema = z.object({
  status: systemDashboardStatusSchema,
  title: z.string(),
  detail: z.string(),
  generatedAt: z.string().datetime(),
  stabilizing: z.boolean(),
});
export type SystemDashboardSummary = z.infer<typeof systemDashboardSummarySchema>;

export const botOwnershipCoverageSchema = z.object({
  total: z.number().int().min(0),
  withPrimary: z.number().int().min(0),
  withoutPrimary: z.number().int().min(0),
  coverageRatio: z.number().min(0).max(1),
});
export type BotOwnershipCoverage = z.infer<typeof botOwnershipCoverageSchema>;

export const botOwnershipLifecycleStatsSchema = z.object({
  configured: z.number().int().min(0),
  adminVisible: z.number().int().min(0),
  active: z.number().int().min(0),
  dormant: z.number().int().min(0),
  draining: z.number().int().min(0),
  disabled: z.number().int().min(0),
});
export type BotOwnershipLifecycleStats = z.infer<typeof botOwnershipLifecycleStatsSchema>;

export const botOwnershipAnomaliesSchema = z.object({
  noPrimary: z.number().int().min(0),
  recoverableLegacyOnly: z.number().int().min(0),
  recoverableFromMemberships: z.number().int().min(0),
  unbound: z.number().int().min(0),
  primaryBotUnknown: z.number().int().min(0),
  legacyBotUnknown: z.number().int().min(0),
  activeMembershipBotUnknown: z.number().int().min(0),
  primaryWithoutActiveMembership: z.number().int().min(0),
  primaryWithoutAdminAccess: z.number().int().min(0),
  sharedChats: z.number().int().min(0),
});
export type BotOwnershipAnomalies = z.infer<typeof botOwnershipAnomaliesSchema>;

export const botOwnershipRepairSnapshotSchema = z.object({
  enabled: z.boolean(),
  activeOnThisRole: z.boolean(),
  intervalMs: z.number().int().positive(),
  lastRunAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  lastAppliedChanges: z.number().int().min(0),
  totalAppliedChanges: z.number().int().min(0),
});
export type BotOwnershipRepairSnapshot = z.infer<typeof botOwnershipRepairSnapshotSchema>;

export const botOwnershipFoundationSnapshotSchema = z.object({
  generatedAt: z.string().datetime(),
  bots: botOwnershipLifecycleStatsSchema,
  entities: z.object({
    total: botOwnershipCoverageSchema,
    chats: botOwnershipCoverageSchema,
    channels: botOwnershipCoverageSchema,
  }),
  anomalies: botOwnershipAnomaliesSchema,
  repair: botOwnershipRepairSnapshotSchema,
});
export type BotOwnershipFoundationSnapshot = z.infer<typeof botOwnershipFoundationSnapshotSchema>;

export const systemDashboardBurstSchema = z.object({
  active: z.boolean(),
  peakLagSec: z.number().min(0),
  peakBotId: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  lastRecoveredAt: z.string().datetime().nullable(),
  sampleAgeMs: z.number().int().min(0),
});
export type SystemDashboardBurst = z.infer<typeof systemDashboardBurstSchema>;

export const systemDashboardHotPathStageSchema = z.object({
  stage: z.string(),
  count: z.number().int().min(0),
  slowCount: z.number().int().min(0),
  timeoutCount: z.number().int().min(0),
  skipCount: z.number().int().min(0),
  failOpenCount: z.number().int().min(0),
  avgElapsedMs: z.number().min(0),
  maxElapsedMs: z.number().int().min(0),
  lastObservedAt: z.string().datetime().nullable(),
});
export type SystemDashboardHotPathStage = z.infer<typeof systemDashboardHotPathStageSchema>;

export const systemDashboardHotPathSchema = z.object({
  windowSec: z.number().int().positive(),
  failOpenCount: z.number().int().min(0),
  stages: z.array(systemDashboardHotPathStageSchema),
});
export type SystemDashboardHotPath = z.infer<typeof systemDashboardHotPathSchema>;

export const systemDashboardHotChatSchema = z.object({
  chatId: z.string(),
  messageCreatedCount: z.number().int().min(0),
  botsSeen: z.number().int().min(0),
  lastSeenAt: z.string().datetime(),
});
export type SystemDashboardHotChat = z.infer<typeof systemDashboardHotChatSchema>;

export const systemDashboardHotChatsSchema = z.object({
  windowSec: z.number().int().positive(),
  items: z.array(systemDashboardHotChatSchema),
});
export type SystemDashboardHotChats = z.infer<typeof systemDashboardHotChatsSchema>;

export const systemDashboardBackgroundBudgetSourceSchema = z.object({
  sourceTag: z.string(),
  totalRequests: z.number().int().min(0),
  avgRps: z.number().min(0),
  peakRps: z.number().int().min(0),
});
export type SystemDashboardBackgroundBudgetSource = z.infer<
  typeof systemDashboardBackgroundBudgetSourceSchema
>;

export const systemDashboardBackgroundBudgetPauseReasonSchema = z.object({
  component: z.string(),
  sourceTag: z.string(),
  action: z.enum(['run', 'slow', 'pause']),
  reason: z.string(),
  count: z.number().int().min(0),
  lastObservedAt: z.string().datetime().nullable(),
});
export type SystemDashboardBackgroundBudgetPauseReason = z.infer<
  typeof systemDashboardBackgroundBudgetPauseReasonSchema
>;

export const systemDashboardBackgroundBudgetBotLoadSchema = z.object({
  maxSmoothedLoad: z.number().min(0),
  maxPeakLoad: z.number().min(0),
  slowThreshold: z.number().min(0).max(1),
  pauseThreshold: z.number().min(0).max(1),
  topBots: z.array(
    z.object({
      botId: z.string(),
      smoothedLoad: z.number().min(0),
      peakLoad: z.number().min(0),
      avgLoad: z.number().min(0),
    }),
  ),
});
export type SystemDashboardBackgroundBudgetBotLoad = z.infer<
  typeof systemDashboardBackgroundBudgetBotLoadSchema
>;

export const systemDashboardBackgroundBudgetStackLoadSchema = z.object({
  windowSec: z.number().int().positive(),
  smoothedLoad: z.number().min(0),
  peakLoad: z.number().min(0),
  avgLoad: z.number().min(0),
  slowThreshold: z.number().min(0).max(1),
  pauseThreshold: z.number().min(0).max(1),
});
export type SystemDashboardBackgroundBudgetStackLoad = z.infer<
  typeof systemDashboardBackgroundBudgetStackLoadSchema
>;

export const systemDashboardBackgroundBudgetSchema = z.object({
  windowSec: z.number().int().positive(),
  backgroundShare: z.number().min(0).max(1),
  topSources: z.array(systemDashboardBackgroundBudgetSourceSchema),
  pauseReasons: z.array(systemDashboardBackgroundBudgetPauseReasonSchema),
  stackLoad: systemDashboardBackgroundBudgetStackLoadSchema.optional(),
  botLoad: systemDashboardBackgroundBudgetBotLoadSchema.optional(),
});
export type SystemDashboardBackgroundBudget = z.infer<typeof systemDashboardBackgroundBudgetSchema>;

export const systemDashboardMembershipLookupSampleSchema = z.object({
  chatId: z.string(),
  policyName: z.string(),
  lastObservedAt: z.string().datetime(),
  retryAfterMs: z.number().int().min(0).nullable(),
});
export type SystemDashboardMembershipLookupSample = z.infer<
  typeof systemDashboardMembershipLookupSampleSchema
>;

export const systemDashboardMembershipLookupIssueSampleSchema =
  systemDashboardMembershipLookupSampleSchema.extend({
    kind: z.enum(['transient', 'terminal']),
  });
export type SystemDashboardMembershipLookupIssueSample = z.infer<
  typeof systemDashboardMembershipLookupIssueSampleSchema
>;

export const systemDashboardMembershipLookupSchema = z.object({
  windowSec: z.number().int().positive(),
  hotChannels: z.number().int().min(0),
  backoffActiveChats: z.number().int().min(0),
  transientIssues: z.number().int().min(0),
  terminalIssues: z.number().int().min(0),
  hotChannelsSample: z.array(systemDashboardMembershipLookupSampleSchema),
  backoffSample: z.array(systemDashboardMembershipLookupSampleSchema),
  issueSample: z.array(systemDashboardMembershipLookupIssueSampleSchema),
});
export type SystemDashboardMembershipLookup = z.infer<typeof systemDashboardMembershipLookupSchema>;

export const systemDashboardProblemChatSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type SystemDashboardProblemChatSeverity = z.infer<
  typeof systemDashboardProblemChatSeveritySchema
>;

export const systemDashboardProblemChatSchema = z.object({
  chatId: z.string(),
  botId: z.string().nullable(),
  category: z.string(),
  severity: systemDashboardProblemChatSeveritySchema,
  action: z.string().nullable(),
  statusCode: z.number().int().positive().nullable(),
  reason: z.string(),
  count: z.number().int().min(0),
  lastObservedAt: z.string().datetime(),
});
export type SystemDashboardProblemChat = z.infer<typeof systemDashboardProblemChatSchema>;

export const systemDashboardProblemChatsSchema = z.object({
  windowSec: z.number().int().positive(),
  items: z.array(systemDashboardProblemChatSchema),
});
export type SystemDashboardProblemChats = z.infer<typeof systemDashboardProblemChatsSchema>;

export const systemDashboardSpammerSurfaceTimingSchema = z.object({
  surface: z.string(),
  stage: z.string(),
  count: z.number().int().min(0),
  avgMs: z.number().min(0),
  p95Ms: z.number().min(0),
  p99Ms: z.number().min(0),
  maxMs: z.number().int().min(0),
  lastObservedAt: z.string().datetime().nullable(),
});
export type SystemDashboardSpammerSurfaceTiming = z.infer<
  typeof systemDashboardSpammerSurfaceTimingSchema
>;

export const systemDashboardSpammerSurfacesSchema = z.object({
  windowSec: z.number().int().positive(),
  timings: z.array(systemDashboardSpammerSurfaceTimingSchema),
});
export type SystemDashboardSpammerSurfaces = z.infer<typeof systemDashboardSpammerSurfacesSchema>;

export const systemDashboardSpammerReadModelSchema = z.object({
  windowSec: z.number().int().positive(),
  profileReads: z.object({
    hits: z.number().int().min(0),
    misses: z.number().int().min(0),
    stale: z.number().int().min(0),
    fallbacks: z.number().int().min(0),
    hitRate: z.number().min(0).max(1),
  }),
  shadow: z.object({
    compared: z.number().int().min(0),
    matched: z.number().int().min(0),
    mismatched: z.number().int().min(0),
    scoreDrift: z.number().int().min(0),
    scoreDriftRate: z.number().min(0).max(1),
    mismatchRate: z.number().min(0).max(1),
  }),
  profileWrites: z.object({
    success: z.number().int().min(0),
    failure: z.number().int().min(0),
  }),
  denormJobs: z.object({
    enqueued: z.number().int().min(0),
    enqueueFailed: z.number().int().min(0),
    fastPathEnqueued: z.number().int().min(0),
    fastPathFallbacks: z.number().int().min(0),
    fastPathReplayed: z.number().int().min(0),
    fastPathReplayMissing: z.number().int().min(0),
    processed: z.number().int().min(0),
    failed: z.number().int().min(0),
    avgAgeMs: z.number().min(0),
    maxAgeMs: z.number().int().min(0),
    lastSuccessAt: z.string().datetime().nullable(),
    lastFailureAt: z.string().datetime().nullable(),
  }),
});
export type SystemDashboardSpammerReadModel = z.infer<typeof systemDashboardSpammerReadModelSchema>;

export const systemDashboardWebhookSloStatusSchema = z.enum(['healthy', 'warning', 'critical']);
export type SystemDashboardWebhookSloStatus = z.infer<typeof systemDashboardWebhookSloStatusSchema>;

export const systemDashboardWebhookEnqueueSloSchema = z.object({
  targetMs: z.number().int().positive(),
  sampledEvents: z.number().int().min(0),
  p95LatencyMs: z.number().min(0).nullable(),
  p99LatencyMs: z.number().min(0).nullable(),
  underTargetRatio: z.number().min(0).max(1).nullable(),
  oldestPendingLagSec: z.number().min(0),
  oldestPendingEventId: z.string().nullable(),
  lastQueuedAt: z.string().datetime().nullable(),
});
export type SystemDashboardWebhookEnqueueSlo = z.infer<
  typeof systemDashboardWebhookEnqueueSloSchema
>;

export const systemDashboardWebhookSloSchema = z.object({
  status: systemDashboardWebhookSloStatusSchema,
  windowSec: z.number().int().positive(),
  targetProcessingMs: z.number().int().positive(),
  totalEvents: z.number().int().min(0),
  processedEvents: z.number().int().min(0),
  failedEvents: z.number().int().min(0),
  sampledProcessedEvents: z.number().int().min(0),
  p95ProcessingMs: z.number().min(0).nullable(),
  p99ProcessingMs: z.number().min(0).nullable(),
  underTargetRatio: z.number().min(0).max(1).nullable(),
  oldestUnprocessedLagSec: z.number().min(0),
  oldestUnprocessedEventId: z.string().nullable(),
  lastProcessedAt: z.string().datetime().nullable(),
  enqueue: systemDashboardWebhookEnqueueSloSchema.optional(),
  generatedAt: z.string().datetime(),
});
export type SystemDashboardWebhookSlo = z.infer<typeof systemDashboardWebhookSloSchema>;

export const systemRuntimeRoleSchema = z.enum([
  'all',
  'ingress',
  'admin',
  'enqueue',
  'moderation',
  'action',
]);
export type SystemRuntimeRole = z.infer<typeof systemRuntimeRoleSchema>;

export const systemRuntimeTopologySourceSchema = z.enum([
  'declared-service',
  'role-inference',
  'queue-inference',
  'fallback',
]);
export type SystemRuntimeTopologySource = z.infer<typeof systemRuntimeTopologySourceSchema>;

export const systemRuntimeQueuePrioritySchema = z.enum([
  'all',
  'http-ingress',
  'admin-heavy-read',
  'webhook-enqueue',
  'user-facing-critical',
  'user-facing-realtime',
  'background',
  'action-dispatch',
]);
export type SystemRuntimeQueuePriority = z.infer<typeof systemRuntimeQueuePrioritySchema>;

export const systemDynamicLeasesModeSchema = z.enum(['off', 'shadow', 'canary', 'on']);
export type SystemDynamicLeasesMode = z.infer<typeof systemDynamicLeasesModeSchema>;

export const systemRuntimeProfileSchema = z.object({
  appRole: systemRuntimeRoleSchema,
  serviceName: z.string().optional(),
  serviceTitle: z.string().optional(),
  queueProfile: z.string().optional(),
  queuePriority: systemRuntimeQueuePrioritySchema.optional(),
  topologySource: systemRuntimeTopologySourceSchema.optional(),
  httpEnabled: z.boolean(),
  ingressEnabled: z.boolean(),
  adminEnabled: z.boolean(),
  enqueueEnabled: z.boolean(),
  moderationEnabled: z.boolean(),
  actionEnabled: z.boolean(),
  enabledQueues: z.array(z.string()),
  dynamicLeasesMode: systemDynamicLeasesModeSchema,
  dynamicLeasesWorkerGroup: z.string().nullable(),
  canaryShardIds: z.array(z.string()),
  targetWebhookP95Ms: z.number().int().positive(),
  generatedAt: z.string().datetime(),
});
export type SystemRuntimeProfile = z.infer<typeof systemRuntimeProfileSchema>;

export const systemCanaryStateStatusSchema = z.enum([
  'disabled',
  'shadow',
  'canary',
  'active',
  'degraded',
]);
export type SystemCanaryStateStatus = z.infer<typeof systemCanaryStateStatusSchema>;

export const systemCanaryRecommendationSchema = z.enum(['observe', 'expand', 'hold', 'rollback']);
export type SystemCanaryRecommendation = z.infer<typeof systemCanaryRecommendationSchema>;

export const systemCanaryStateSchema = z.object({
  enabled: z.boolean(),
  mode: systemDynamicLeasesModeSchema,
  status: systemCanaryStateStatusSchema,
  recommendation: systemCanaryRecommendationSchema,
  workerGroup: z.string().nullable(),
  canaryShardIds: z.array(z.string()),
  liveWorkerGroups: z.array(z.string()),
  handoffPendingQueues: z.array(z.string()),
  unhealthyQueues: z.array(z.string()),
  reason: z.string(),
});
export type SystemCanaryState = z.infer<typeof systemCanaryStateSchema>;

export const systemRollbackReadinessStatusSchema = z.enum([
  'ready',
  'blocked',
  'rollback-recommended',
]);
export type SystemRollbackReadinessStatus = z.infer<typeof systemRollbackReadinessStatusSchema>;

export const systemRollbackReadinessSchema = z.object({
  status: systemRollbackReadinessStatusSchema,
  canRollbackRuntime: z.boolean(),
  liveOk: z.boolean(),
  readyOk: z.boolean(),
  webhookSloOk: z.boolean(),
  queueLagOk: z.boolean(),
  failedWebhookOk: z.boolean(),
  reasons: z.array(z.string()),
  command: z.string(),
});
export type SystemRollbackReadiness = z.infer<typeof systemRollbackReadinessSchema>;

export const systemQueueGroupStatusSchema = z.enum(['healthy', 'warning', 'critical']);
export type SystemQueueGroupStatus = z.infer<typeof systemQueueGroupStatusSchema>;

export const systemQueueGroupSchema = z.object({
  name: z.string(),
  queues: z.array(z.string()),
  waiting: z.number().int().min(0),
  active: z.number().int().min(0),
  delayed: z.number().int().min(0),
  failed: z.number().int().min(0),
  completed: z.number().int().min(0),
  pressure: z.number().int().min(0),
  status: systemQueueGroupStatusSchema,
});
export type SystemQueueGroup = z.infer<typeof systemQueueGroupSchema>;

export const systemQueueGroupHealthSchema = z.object({
  status: systemQueueGroupStatusSchema,
  groups: z.array(systemQueueGroupSchema),
  generatedAt: z.string().datetime(),
});
export type SystemQueueGroupHealth = z.infer<typeof systemQueueGroupHealthSchema>;

export const systemDashboardResponseSchema = z.object({
  summary: systemDashboardSummarySchema,
  alerts: z.array(systemDashboardAlertSchema),
  queues: queueMetricsSnapshotSchema,
  mode: systemModeSnapshotSchema,
  webhookSubscription: webhookSubscriptionSnapshotSchema,
  ownership: botOwnershipFoundationSnapshotSchema,
  burst: systemDashboardBurstSchema.optional(),
  hotPath: systemDashboardHotPathSchema.optional(),
  hotChats: systemDashboardHotChatsSchema.optional(),
  backgroundBudget: systemDashboardBackgroundBudgetSchema.optional(),
  membershipLookup: systemDashboardMembershipLookupSchema.optional(),
  problemChats: systemDashboardProblemChatsSchema.optional(),
  spammerSurfaces: systemDashboardSpammerSurfacesSchema.optional(),
  spammerReadModel: systemDashboardSpammerReadModelSchema.optional(),
  webhookSlo: systemDashboardWebhookSloSchema.optional(),
  slo: systemDashboardWebhookSloSchema.optional(),
  runtimeProfile: systemRuntimeProfileSchema.optional(),
  canaryState: systemCanaryStateSchema.optional(),
  rollbackReadiness: systemRollbackReadinessSchema.optional(),
  queueGroupHealth: systemQueueGroupHealthSchema.optional(),
});
export type SystemDashboardResponse = z.infer<typeof systemDashboardResponseSchema>;
