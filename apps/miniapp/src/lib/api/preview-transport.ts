import {
  addVkParsingSourceRequestSchema,
  bulkUpdateVkParsingSourcesRequestSchema,
  applySectionTargetPreviewResponseSchema,
  applySectionToAllResponseSchema,
  applySettingsTargetSchema,
  broadcastHandoffStateSchema,
  chatParticipantImmunitySchema,
  chatParticipantImmunityUpdateRequestSchema,
  chatParticipantImmunityUpdateResultSchema,
  chatParticipantsPageSchema,
  chatUnavailableParticipantsCleanupRequestSchema,
  chatUnavailableParticipantsCleanupResultSchema,
  channelDialogMessageSchema,
  channelDialogResponseSchema,
  channelSuggestionRedirectResponseSchema,
  channelDialogTypeSchema,
  channelSettingsSchema,
  channelSettingsScreenResponseSchema,
  chatRulesSchema,
  chatSettingsSchema,
  chatSettingsScreenResponseSchema,
  createManagedAutopostHubRuleRequestSchema,
  createChannelDialogMessageRequestSchema,
  createChannelDialogMessageResponseSchema,
  deleteChannelDialogMessageRequestSchema,
  deleteChannelDialogMessageResponseSchema,
  domainAllowlistEntrySchema,
  globalSpammerReviewMetricsSchema,
  globalSpammerReviewQueueSchema,
  globalSpammerReviewRequestSchema,
  globalSpammerReviewResultSchema,
  globalSpammerUserDiagnosticsSchema,
  logsDashboardResponseSchema,
  managedAutopostHubRuleDetailsSchema,
  managedAutopostPayloadSchema,
  managedBroadcastDetailsSchema,
  managedEntityFavoritesResponseSchema,
  managedEntityBotExecutionPlanSchema,
  managedEntitiesListResponseSchema,
  managedGiveawayDetailsSchema,
  managedGiveawayParticipantStateSchema,
  managedGiveawayPublicSchema,
  manualModerationActionRequestSchema,
  manualModerationActionResultSchema,
  moderationFeedPageSchema,
  membershipActivityPageSchema,
  publishChannelEngagementResultSchema,
  publishChatRulesResultSchema,
  publishVkParsingPostRequestSchema,
  publishVkParsingPostResultSchema,
  rollbackVkParsingRequestSchema,
  rollbackVkParsingResultSchema,
  retryVkParsingPostResultSchema,
  scheduleVkParsingPostRequestSchema,
  resolveRequiredSubscriptionChannelRequestSchema,
  resolveRequiredSubscriptionChannelResponseSchema,
  sendBroadcastTestResultSchema,
  systemDashboardResponseSchema,
  systemModeSnapshotSchema,
  toggleChannelDialogReactionRequestSchema,
  toggleChannelDialogReactionResponseSchema,
  updateChannelDialogNotificationsRequestSchema,
  updateChannelDialogNotificationsResponseSchema,
  updateChannelDialogMessageRequestSchema,
  updateChannelDialogMessageResponseSchema,
  updateManagedAutopostRuleRequestSchema,
  updateManagedEntityFavoritesRequestSchema,
  updateManagedEntityPartnerAssistRequestSchema,
  updateManagedEntityPrimaryBotRequestSchema,
  updateVkParsingSettingsRequestSchema,
  updateVkParsingSourceRequestSchema,
  vkParsingCapabilitySchema,
  vkParsingFeedQuerySchema,
  vkParsingFeedSchema,
  vkParsingHealthSummarySchema,
  vkParsingRefreshResultSchema,
  type ApplySettingsTarget,
  type BroadcastHandoffResponse,
  type BroadcastHandoffState,
  type ChatParticipantImmunityUpdateRequest,
  type ChatParticipantItem,
  type ChatParticipantsPage,
  type ChatUnavailableParticipantsCleanupRequest,
  type ChannelDialogMessage,
  type ChannelDialogNotificationMode,
  type ChannelDialogNotificationScope,
  type ChannelDialogResponse,
  type ChannelDialogType,
  type ChannelSettings,
  type ChannelSettingsScreenResponse,
  type ChatRules,
  type ChatSettings,
  type ChatSettingsScreenResponse,
  type ChatSummary,
  type DomainAllowlistEntry,
  type GlobalSpammerReviewCandidate,
  type GlobalSpammerReviewRequest,
  type GlobalSpammerUserDiagnostics,
  type LogsDashboardRange,
  type LogsDashboardResponse,
  type BotSpeechPersona,
  type ManagedBroadcastDetails,
  type ManagedAutopostHubRuleDetails,
  type ManagedAutopostPayload,
  type ManagedEntityAssignedBot,
  type ManagedEntityBotExecutionPlan,
  type ManagedEntityBotCapability,
  type ManagedEntityType,
  type ManagedEntitiesListResponse,
  type ManagedGiveawayDetails,
  type ManagedGiveawayParticipantState,
  type ManagedGiveawayPublic,
  type ManagedGiveawaySummary,
  type ManualModerationActionRequest,
  type ManualModerationActionResult,
  type Me,
  type ModerationFeedFilter,
  type ModerationFeedPage,
  type MembershipActivityFilter,
  type MembershipActivityItem,
  type MembershipActivityPage,
  type MembershipActivityRange,
  type PublishChannelEngagementResult,
  type PublishChatRulesResult,
  type SystemDashboardResponse,
  type SystemModeSnapshot,
  type VkParsingFeed,
  type VkParsingPost,
  type VkParsingSettings,
  type VkParsingSource,
} from '@maxim/contracts';
import {
  channelStatsResponseSchema,
  type ChannelStatsBucket,
  type ChannelStatsMode,
  type ChannelStatsRange,
  type ChannelStatsResponse,
} from '@maxim/contracts/channel-stats';
import {
  systemBotRoutePreviewResponseSchema,
  systemBotsSnapshotSchema,
  type SystemBotsSnapshot,
} from '@maxim/contracts/system';
import {
  createManagedPollRequestSchema,
  managedPollDetailsSchema,
  managedPollListQuerySchema,
  managedPollListResponseSchema,
  managedPollVotersQuerySchema,
  managedPollVotersResponseSchema,
  updateManagedPollRequestSchema,
  type ManagedPollDetails,
  type ManagedPollVoter,
} from '@maxim/contracts/poll';
import {
  createPublicationRequestSchema,
  decodePublicationListCursor,
  encodePublicationListCursor,
  listPublicationDeliveriesQuerySchema,
  listPublicationDeliveriesResponseSchema,
  listPublicationsQuerySchema,
  listPublicationsResponseSchema,
  publicationActionRequestSchema,
  publicationDetailsSchema,
  resolvePublicationAmbiguousDeliveryRequestSchema,
  retryPublicationOccurrenceRequestSchema,
  testPublicationRequestSchema,
  updatePublicationRequestSchema,
  type CreatePublicationRequest,
  type PublicationAsset,
  type PublicationContentInput,
  type PublicationDelivery,
  type PublicationDeliveryStats,
  type PublicationDetails,
  type PublicationScheduleInput,
  type PublicationTarget,
} from '@maxim/contracts/publication';
import {
  PREVIEW_CHANNEL_ID,
  PREVIEW_CHANNEL_TITLE,
  PREVIEW_CHAT_ID,
  PREVIEW_CHAT_TITLE,
} from '../design-preview';
import type { ApiTransport } from './transport';

type PreviewState = {
  me: Me;
  systemModeSelection: 'auto' | 'normal' | 'degrade';
  chats: ChatSummary[];
  channels: ChatSummary[];
  chatDialogs: Record<ChannelDialogType, PreviewDialogBucket>;
  channelDialogs: Record<ChannelDialogType, PreviewDialogBucket>;
  chatDialogThreads: PreviewDialogThreadBuckets;
  channelDialogThreads: PreviewDialogThreadBuckets;
  chatHeaderParticipantsCount: number;
  chatSettings: ChatSettings;
  chatRules: ChatRules;
  chatDomains: DomainAllowlistEntry[];
  chatBroadcasts: ManagedBroadcastDetails[];
  channelBroadcasts: ManagedBroadcastDetails[];
  autopostRules: ManagedAutopostHubRuleDetails[];
  publications: PublicationDetails[];
  publicationDeliveries: PublicationDelivery[];
  chatGiveaways: ManagedGiveawayDetails[];
  chatParticipants: ChatParticipantItem[];
  chatActivity: MembershipActivityItem[];
  chatViolations: LogsDashboardResponse['violations'];
  spammerReviewCandidates: GlobalSpammerReviewCandidate[];
  channelHeaderParticipantsCount: number;
  channelSettings: ChannelSettings;
  channelPolls: ManagedPollDetails[];
  channelPollVoters: ManagedPollVoter[];
  channelGiveaways: ManagedGiveawayDetails[];
  channelActivity: MembershipActivityItem[];
  chatVkParsing: VkParsingFeed;
  channelVkParsing: VkParsingFeed;
  chatPrimaryBotId: string | null;
  channelPrimaryBotId: string | null;
  chatPartnerAssistEnabled: boolean;
  channelPartnerAssistEnabled: boolean;
};

type PreviewDialogBucket = {
  introText: string;
  messages: ChannelDialogMessage[];
  notificationMode?: ChannelDialogNotificationMode;
  notificationScope?: ChannelDialogNotificationScope;
  threadNotificationMode?: ChannelDialogNotificationMode;
  threadNotificationExplicit?: boolean;
  channelNotificationMode?: ChannelDialogNotificationMode;
  channelNotificationExplicit?: boolean;
  allChannelsNotificationMode?: ChannelDialogNotificationMode;
  allChannelsNotificationExplicit?: boolean;
};

type PreviewDialogThreadBuckets = Partial<
  Record<ChannelDialogType, Record<string, PreviewDialogBucket>>
>;

const PREVIEW_PUBLIC_GIVEAWAY_ID = 'preview-giveaway';
const PREVIEW_GIVEAWAY_RUNTIME_STATE_KEY = 'maxim.preview.giveaway.runtime';
const PREVIEW_PRIMARY_BOT_ID = '777000_bot';
const PREVIEW_PRIMARY_BOT_LABEL = 'Майор Максимов';
const PREVIEW_STANDBY_BOT_ID = '777001_bot';
const PREVIEW_STANDBY_BOT_LABEL = 'Майор Максимова';
const PREVIEW_REX_BOT_ID = '777002_bot';
const PREVIEW_REX_BOT_LABEL = 'Рэкс';
const PREVIEW_EDITOR_BOT_ID = '777003_bot';
const PREVIEW_EDITOR_BOT_LABEL = 'Редактор Майя';
const PREVIEW_SCOUT_BOT_ID = '777004_bot';
const PREVIEW_SCOUT_BOT_LABEL = 'Скаут Илья';
const PREVIEW_BACKUP_BOT_ID = '777005_bot';
const PREVIEW_BACKUP_BOT_LABEL = 'Резервный Максим';

type PreviewBotFixture = {
  botId: string;
  label: string;
  speechPersona: BotSpeechPersona;
  characterName: string;
  avatarColors: readonly [string, string];
  assistCapabilities: ManagedEntityBotCapability[];
  standbyPermissions: string[];
};

const PREVIEW_BOT_FIXTURES = [
  {
    botId: PREVIEW_PRIMARY_BOT_ID,
    label: PREVIEW_PRIMARY_BOT_LABEL,
    speechPersona: 'male',
    characterName: 'Майор Максимов',
    avatarColors: ['#22b6b7', '#1484a0'],
    assistCapabilities: [],
    standbyPermissions: ['read', 'write'],
  },
  {
    botId: PREVIEW_STANDBY_BOT_ID,
    label: PREVIEW_STANDBY_BOT_LABEL,
    speechPersona: 'female',
    characterName: 'Майор Максимова',
    avatarColors: ['#ff89b8', '#de5a82'],
    assistCapabilities: ['access_prewarm', 'membership_prewarm'],
    standbyPermissions: ['read', 'write', 'manage'],
  },
  {
    botId: PREVIEW_REX_BOT_ID,
    label: PREVIEW_REX_BOT_LABEL,
    speechPersona: 'male',
    characterName: 'Рэкс',
    avatarColors: ['#39c58f', '#178a68'],
    assistCapabilities: ['access_prewarm'],
    standbyPermissions: ['read', 'write'],
  },
  {
    botId: PREVIEW_EDITOR_BOT_ID,
    label: PREVIEW_EDITOR_BOT_LABEL,
    speechPersona: 'female',
    characterName: 'Редактор Майя',
    avatarColors: ['#f6b453', '#d36a35'],
    assistCapabilities: ['suggestion_delivery', 'channel_stats'],
    standbyPermissions: ['read', 'write', 'manage'],
  },
  {
    botId: PREVIEW_SCOUT_BOT_ID,
    label: PREVIEW_SCOUT_BOT_LABEL,
    speechPersona: 'neutral',
    characterName: 'Скаут Илья',
    avatarColors: ['#7c9dff', '#3f5bd7'],
    assistCapabilities: ['background_scans', 'membership_prewarm'],
    standbyPermissions: ['read'],
  },
  {
    botId: PREVIEW_BACKUP_BOT_ID,
    label: PREVIEW_BACKUP_BOT_LABEL,
    speechPersona: 'male',
    characterName: 'Резервный Максим',
    avatarColors: ['#b17cff', '#7042c8'],
    assistCapabilities: ['background_scans', 'access_prewarm'],
    standbyPermissions: ['read', 'write'],
  },
] satisfies PreviewBotFixture[];

type PreviewGiveawayVariant = 'blocked' | 'joined' | 'winner' | 'completed';
type PreviewGiveawayParticipantVariant =
  | PreviewGiveawayVariant
  | 'blocked-entered'
  | 'winner-claimed';

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildPreviewAssignedBots(
  options: {
    primaryBotId?: string | null;
    assistEnabled?: boolean;
  } = {},
): ChatSummary['assignedBots'] {
  const primaryBotId = options.primaryBotId ?? PREVIEW_PRIMARY_BOT_ID;
  const assistEnabled = options.assistEnabled === true;

  return PREVIEW_BOT_FIXTURES.map((fixture): ManagedEntityAssignedBot => {
    const isPrimary = primaryBotId === fixture.botId;
    const [avatarStart, avatarEnd] = fixture.avatarColors;

    return {
      botId: fixture.botId,
      label: fixture.label,
      role: isPrimary ? 'primary' : 'standby',
      membershipStatus: 'active',
      lifecycleState: 'active',
      speechPersona: fixture.speechPersona,
      characterName: fixture.characterName,
      avatarUrl: buildPreviewAvatarDataUrl(fixture.characterName, avatarStart, avatarEnd),
      capabilities: assistEnabled && !isPrimary ? fixture.assistCapabilities : [],
      permissionsSummary: {
        checkedAt: new Date().toISOString(),
        isAdmin: true,
        isOwner: isPrimary,
        permissions: isPrimary ? ['all'] : fixture.standbyPermissions,
      },
    };
  });
}

function createPreviewChatSummary(
  params: Omit<ChatSummary, 'primaryBotId' | 'assignedBots' | 'sharedMode'>,
): ChatSummary {
  const assignedBots = buildPreviewAssignedBots();

  return {
    ...params,
    primaryBotId: PREVIEW_PRIMARY_BOT_ID,
    assignedBots,
    sharedMode: 'shared-standby',
    botCount: params.botCount ?? assignedBots.length,
    hasSharedAutomation: params.hasSharedAutomation ?? assignedBots.length > 1,
  };
}

function buildPreviewSystemMode(state: PreviewState): SystemModeSnapshot {
  const now = new Date().toISOString();
  const manualMode = state.systemModeSelection === 'auto' ? null : state.systemModeSelection;
  const mode = manualMode ?? 'normal';
  const action =
    mode === 'degrade'
      ? {
          windowSec: 60,
          total: 182,
          success: 162,
          failure: 20,
          critical: 9,
          errorRate: 0.109,
          criticalRate: 0.049,
        }
      : {
          windowSec: 60,
          total: 94,
          success: 93,
          failure: 1,
          critical: 0,
          errorRate: 0.011,
          criticalRate: 0,
        };

  return {
    mode,
    source: manualMode ? 'manual' : 'auto',
    reason: manualMode ? 'manual override' : 'system healthy',
    updatedAt: now,
    manualMode,
    queueLagSec: manualMode === 'degrade' ? 11.4 : 0,
    action,
  };
}

function buildPreviewSharedMode(assistEnabled: boolean): 'shared-assist' | 'shared-standby' {
  return assistEnabled ? 'shared-assist' : 'shared-standby';
}

function buildPreviewPartnerBotIds(assignedBots: ChatSummary['assignedBots']): string[] {
  const activePartners = assignedBots.filter(
    (bot) =>
      bot.role !== 'primary' &&
      bot.membershipStatus === 'active' &&
      bot.lifecycleState === 'active',
  );
  const assistPartners = activePartners.filter((bot) => bot.capabilities.length > 0);
  return (assistPartners.length > 0 ? assistPartners : activePartners).map((bot) => bot.botId);
}

function buildPreviewBotExecutionPlan(
  state: PreviewState,
  entityType: 'chat' | 'channel',
  chatId: string,
): ManagedEntityBotExecutionPlan {
  const primaryBotId = entityType === 'chat' ? state.chatPrimaryBotId : state.channelPrimaryBotId;
  const assistEnabled =
    entityType === 'chat' ? state.chatPartnerAssistEnabled : state.channelPartnerAssistEnabled;
  const assignedBots = buildPreviewAssignedBots({ primaryBotId, assistEnabled });
  const partnerBotIds = buildPreviewPartnerBotIds(assignedBots);
  const partnerBotId = partnerBotIds[0] ?? null;

  return managedEntityBotExecutionPlanSchema.parse({
    chatId,
    entityType,
    primaryBotId,
    speakerBotId: primaryBotId,
    workerBotId: primaryBotId,
    linkBotId: primaryBotId,
    partnerBotId,
    partnerBotIds,
    sharedMode: buildPreviewSharedMode(assistEnabled),
    userFacingPolicy: 'owner-only',
    reasons: [
      'Preview transport uses owner-only routing for user-facing actions.',
      assistEnabled
        ? 'Partner bot is enabled only for safe assist lanes.'
        : 'Partner bot stays in standby until assist is enabled.',
    ],
    warnings: assistEnabled
      ? []
      : ['Assist lanes are disabled in preview. Owner bot handles all user-facing work.'],
    assignedBots,
  });
}

function buildPreviewSystemDashboard(state: PreviewState): SystemDashboardResponse {
  const mode = buildPreviewSystemMode(state);
  const generatedAt = new Date().toISOString();
  const inDegrade = mode.mode === 'degrade';
  const queues = {
    moderation: {
      waiting: inDegrade ? 7 : 1,
      active: inDegrade ? 3 : 0,
      delayed: 0,
      failed: 0,
      completed: 2480,
    },
    webhookCritical: {
      waiting: 0,
      active: 1,
      delayed: 0,
      failed: 0,
      completed: 960,
    },
    webhookJoin: {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    },
    webhookJoinShards: {},
    webhookDefault: {
      waiting: inDegrade ? 5 : 1,
      active: inDegrade ? 2 : 0,
      delayed: 0,
      failed: 0,
      completed: 1224,
    },
    webhookDefaultShards: {
      'moderation-default-0': {
        waiting: inDegrade ? 5 : 1,
        active: inDegrade ? 2 : 0,
        delayed: 0,
        failed: 0,
        completed: 1224,
      },
    },
    webhookDefaultWorkerGroups: {
      'api-moderation-realtime-b': {
        queues: ['moderation-default-0'],
        counters: {
          waiting: inDegrade ? 5 : 1,
          active: inDegrade ? 2 : 0,
          delayed: 0,
          failed: 0,
          completed: 1224,
        },
      },
    },
    webhookBackground: {
      waiting: inDegrade ? 2 : 0,
      active: inDegrade ? 1 : 0,
      delayed: 0,
      failed: 0,
      completed: 296,
    },
    webhookLegacy: {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    },
    actions: {
      waiting: inDegrade ? 2 : 0,
      active: inDegrade ? 1 : 0,
      delayed: 0,
      failed: 0,
      completed: 480,
    },
    globalSpammerDenorm: {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    },
    auxiliaryQueues: {
      'admin-managed-entities-refresh': {
        waiting: 0,
        active: inDegrade ? 1 : 0,
        delayed: inDegrade ? 24 : 8,
        failed: 0,
        completed: 640,
      },
      'vk-parsing-publish': {
        waiting: inDegrade ? 2 : 0,
        active: 0,
        delayed: inDegrade ? 12 : 4,
        failed: inDegrade ? 1 : 0,
        completed: 320,
      },
      'max-chat-admin-roster-sync': {
        waiting: 0,
        active: 0,
        delayed: 3,
        failed: 0,
        completed: 180,
      },
    },
    webhookEvents: {
      received: {
        count: inDegrade ? 3 : 0,
        oldestEventId: inDegrade ? 'preview-received-1' : null,
        oldestCreatedAt: inDegrade ? generatedAt : null,
        oldestLagSec: inDegrade ? 6.1 : 0,
      },
      queued: {
        count: inDegrade ? 4 : 0,
        oldestEventId: inDegrade ? 'preview-queued-1' : null,
        oldestCreatedAt: inDegrade ? generatedAt : null,
        oldestLagSec: inDegrade ? 11.4 : 0,
      },
      failed: {
        count: inDegrade ? 12 : 0,
        oldestEventId: inDegrade ? 'preview-failed-1' : null,
        oldestCreatedAt: inDegrade ? generatedAt : null,
        oldestLagSec: inDegrade ? 41 : 0,
      },
    },
    userFacingWebhookEvents: {
      received: {
        count: inDegrade ? 2 : 0,
        oldestEventId: inDegrade ? 'preview-user-facing-received-1' : null,
        oldestCreatedAt: inDegrade ? generatedAt : null,
        oldestLagSec: inDegrade ? 3.2 : 0,
      },
      queued: {
        count: inDegrade ? 2 : 0,
        oldestEventId: inDegrade ? 'preview-user-facing-queued-1' : null,
        oldestCreatedAt: inDegrade ? generatedAt : null,
        oldestLagSec: inDegrade ? 5.4 : 0,
      },
      failed: {
        count: inDegrade ? 1 : 0,
        oldestEventId: inDegrade ? 'preview-user-facing-failed-1' : null,
        oldestCreatedAt: inDegrade ? generatedAt : null,
        oldestLagSec: inDegrade ? 12 : 0,
      },
    },
    actionHealth: mode.action,
    webhookDynamicLeases: null,
    bots: {
      [PREVIEW_PRIMARY_BOT_ID]: {
        webhookEvents: {
          received: {
            count: inDegrade ? 3 : 0,
            oldestEventId: inDegrade ? 'preview-received-1' : null,
            oldestCreatedAt: inDegrade ? generatedAt : null,
            oldestLagSec: inDegrade ? 6.1 : 0,
          },
          queued: {
            count: inDegrade ? 4 : 0,
            oldestEventId: inDegrade ? 'preview-queued-1' : null,
            oldestCreatedAt: inDegrade ? generatedAt : null,
            oldestLagSec: inDegrade ? 11.4 : 0,
          },
          failed: {
            count: inDegrade ? 12 : 0,
            oldestEventId: inDegrade ? 'preview-failed-1' : null,
            oldestCreatedAt: inDegrade ? generatedAt : null,
            oldestLagSec: inDegrade ? 41 : 0,
          },
        },
        userFacingWebhookEvents: {
          received: {
            count: inDegrade ? 2 : 0,
            oldestEventId: inDegrade ? 'preview-user-facing-received-1' : null,
            oldestCreatedAt: inDegrade ? generatedAt : null,
            oldestLagSec: inDegrade ? 3.2 : 0,
          },
          queued: {
            count: inDegrade ? 2 : 0,
            oldestEventId: inDegrade ? 'preview-user-facing-queued-1' : null,
            oldestCreatedAt: inDegrade ? generatedAt : null,
            oldestLagSec: inDegrade ? 5.4 : 0,
          },
          failed: {
            count: inDegrade ? 1 : 0,
            oldestEventId: inDegrade ? 'preview-user-facing-failed-1' : null,
            oldestCreatedAt: inDegrade ? generatedAt : null,
            oldestLagSec: inDegrade ? 12 : 0,
          },
        },
        queuedByQueue: {
          'webhook-critical': 0,
          'webhook-default': inDegrade ? 4 : 0,
          'webhook-background': inDegrade ? 2 : 0,
        },
        actionHealth: mode.action,
        oldestQueuedEventId: inDegrade ? 'preview-queued-1' : null,
        oldestQueuedCreatedAt: inDegrade ? generatedAt : null,
        oldestQueuedLagSec: inDegrade ? 11.4 : 0,
        oldestReceivedEventId: inDegrade ? 'preview-received-1' : null,
        oldestReceivedCreatedAt: inDegrade ? generatedAt : null,
        oldestReceivedLagSec: inDegrade ? 6.1 : 0,
        effectiveLagSec: inDegrade ? 11.4 : 0,
        userFacingOldestQueuedEventId: inDegrade ? 'preview-user-facing-queued-1' : null,
        userFacingOldestQueuedCreatedAt: inDegrade ? generatedAt : null,
        userFacingOldestQueuedLagSec: inDegrade ? 5.4 : 0,
        userFacingOldestReceivedEventId: inDegrade ? 'preview-user-facing-received-1' : null,
        userFacingOldestReceivedCreatedAt: inDegrade ? generatedAt : null,
        userFacingOldestReceivedLagSec: inDegrade ? 3.2 : 0,
        userFacingEffectiveLagSec: inDegrade ? 5.4 : 0,
      },
    },
    oldestQueuedEventId: inDegrade ? 'preview-queued-1' : null,
    oldestQueuedCreatedAt: inDegrade ? generatedAt : null,
    oldestQueuedLagSec: inDegrade ? 11.4 : 0,
    oldestReceivedEventId: inDegrade ? 'preview-received-1' : null,
    oldestReceivedCreatedAt: inDegrade ? generatedAt : null,
    oldestReceivedLagSec: inDegrade ? 6.1 : 0,
    effectiveLagSec: inDegrade ? 11.4 : 0,
    userFacingOldestQueuedEventId: inDegrade ? 'preview-user-facing-queued-1' : null,
    userFacingOldestQueuedCreatedAt: inDegrade ? generatedAt : null,
    userFacingOldestQueuedLagSec: inDegrade ? 5.4 : 0,
    userFacingOldestReceivedEventId: inDegrade ? 'preview-user-facing-received-1' : null,
    userFacingOldestReceivedCreatedAt: inDegrade ? generatedAt : null,
    userFacingOldestReceivedLagSec: inDegrade ? 3.2 : 0,
    userFacingEffectiveLagSec: inDegrade ? 5.4 : 0,
    generatedAt,
  };
  const alerts = inDegrade
    ? [
        {
          code: 'queue-lag',
          level: 'critical' as const,
          title: 'Очередь отстаёт',
          detail: 'Preview показывает backlog и ручной degrade режим.',
          recommendedAction: 'Проверьте split-runtime и снизьте background traffic.',
        },
      ]
    : [
        {
          code: 'healthy',
          level: 'info' as const,
          title: 'Все контуры зелёные',
          detail: 'Webhook-path чистый, lag не копится.',
          recommendedAction: 'Наблюдайте и держите auto-mode активным.',
        },
      ];

  return {
    summary: {
      status: inDegrade ? 'critical' : 'healthy',
      title: inDegrade ? 'Нужна реакция оператора' : 'Бот работает ровно',
      detail: inDegrade
        ? 'Preview-инцидент: часть событий специально задержана для проверки интерфейса.'
        : 'Preview-режим показывает штатное состояние без накопления очередей.',
      generatedAt,
      stabilizing: false,
    },
    alerts,
    queues,
    mode,
    webhookSubscription: {
      status: inDegrade ? 'warning' : 'healthy',
      configured: true,
      url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
      checkedAt: generatedAt,
      reconciledAt: inDegrade ? null : generatedAt,
      requiredUpdateTypes: [
        'message_created',
        'message_callback',
        'user_added',
        'user_removed',
        'bot_added',
        'bot_removed',
        'bot_started',
      ],
      actualUpdateTypes: inDegrade
        ? [
            'message_created',
            'message_callback',
            'user_added',
            'user_removed',
            'bot_added',
            'bot_started',
          ]
        : [
            'message_created',
            'message_callback',
            'user_added',
            'user_removed',
            'bot_added',
            'bot_removed',
            'bot_started',
          ],
      missingUpdateTypes: inDegrade ? ['bot_removed'] : [],
      extraUpdateTypes: [],
      otherSubscriptionsCount: 0,
      lastError: inDegrade ? 'Preview reconcile error' : null,
      note: inDegrade
        ? 'Preview показывает drift webhook coverage.'
        : 'Preview показывает актуальную webhook coverage.',
      botCount: 1,
      bots: {
        [PREVIEW_PRIMARY_BOT_ID]: {
          botId: PREVIEW_PRIMARY_BOT_ID,
          status: inDegrade ? 'warning' : 'healthy',
          configured: true,
          url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
          checkedAt: generatedAt,
          reconciledAt: inDegrade ? null : generatedAt,
          requiredUpdateTypes: [
            'message_created',
            'message_callback',
            'user_added',
            'user_removed',
            'bot_added',
            'bot_removed',
            'bot_started',
          ],
          actualUpdateTypes: inDegrade
            ? [
                'message_created',
                'message_callback',
                'user_added',
                'user_removed',
                'bot_added',
                'bot_started',
              ]
            : [
                'message_created',
                'message_callback',
                'user_added',
                'user_removed',
                'bot_added',
                'bot_removed',
                'bot_started',
              ],
          missingUpdateTypes: inDegrade ? ['bot_removed'] : [],
          extraUpdateTypes: [],
          otherSubscriptionsCount: 0,
          lastError: inDegrade ? 'Preview reconcile error' : null,
          note: inDegrade
            ? 'Preview показывает drift webhook coverage.'
            : 'Preview показывает актуальную webhook coverage.',
        },
      },
    },
    ownership: {
      generatedAt,
      bots: {
        configured: 3,
        adminVisible: 3,
        active: 3,
        dormant: 0,
        draining: 0,
        disabled: 0,
      },
      entities: {
        total: {
          total: 48,
          withPrimary: 37,
          withoutPrimary: 11,
          coverageRatio: 37 / 48,
        },
        chats: {
          total: 42,
          withPrimary: 33,
          withoutPrimary: 9,
          coverageRatio: 33 / 42,
        },
        channels: {
          total: 6,
          withPrimary: 4,
          withoutPrimary: 2,
          coverageRatio: 4 / 6,
        },
      },
      anomalies: {
        noPrimary: 9,
        recoverableLegacyOnly: 2,
        recoverableFromMemberships: 1,
        unbound: 6,
        primaryBotUnknown: 0,
        legacyBotUnknown: 1,
        activeMembershipBotUnknown: 0,
        primaryWithoutActiveMembership: 0,
        primaryWithoutAdminAccess: 0,
        sharedChats: 0,
      },
      repair: {
        enabled: true,
        activeOnThisRole: true,
        intervalMs: 300_000,
        lastRunAt: generatedAt,
        lastSuccessAt: generatedAt,
        lastError: null,
        lastAppliedChanges: 3,
        totalAppliedChanges: 12,
      },
    },
    runtimeProfile: {
      appRole: 'all',
      serviceName: 'api-all',
      serviceTitle: 'All-in-one API runtime',
      queueProfile: 'all-in-one',
      queuePriority: 'all',
      topologySource: 'fallback',
      httpEnabled: true,
      ingressEnabled: true,
      adminEnabled: true,
      enqueueEnabled: true,
      moderationEnabled: true,
      actionEnabled: true,
      enabledQueues: ['critical', 'default', 'join', 'background'],
      dynamicLeasesMode: inDegrade ? 'canary' : 'on',
      dynamicLeasesWorkerGroup: 'api-moderation-realtime-c',
      canaryShardIds: ['moderation-default-2', 'moderation-default-11'],
      targetWebhookP95Ms: 1_000,
      generatedAt,
    },
    canaryState: {
      enabled: true,
      mode: inDegrade ? 'canary' : 'on',
      status: inDegrade ? 'degraded' : 'active',
      recommendation: inDegrade ? 'rollback' : 'observe',
      workerGroup: 'api-moderation-realtime-c',
      canaryShardIds: ['moderation-default-2', 'moderation-default-11'],
      liveWorkerGroups: ['api-moderation', 'api-moderation-realtime-c'],
      handoffPendingQueues: inDegrade ? ['moderation-default-11'] : [],
      unhealthyQueues: inDegrade ? ['moderation-default-11'] : [],
      reason: inDegrade
        ? 'Preview canary is degraded, so rollback is recommended.'
        : 'Preview canary is stable and SLO is inside the target.',
    },
    rollbackReadiness: {
      status: inDegrade ? 'rollback-recommended' : 'ready',
      canRollbackRuntime: true,
      liveOk: true,
      readyOk: !inDegrade,
      webhookSloOk: !inDegrade,
      queueLagOk: !inDegrade,
      failedWebhookOk: !inDegrade,
      reasons: inDegrade ? ['Webhook SLO is outside the target window.'] : [],
      command:
        './infra/scripts/vps-connect.sh rollback-runtime <git-ref> api-enqueue api-moderation api-action api-ingress api-admin',
    },
    queueGroupHealth: {
      status: inDegrade ? 'critical' : 'healthy',
      generatedAt,
      groups: [
        {
          name: 'api-moderation',
          queues: ['moderation-default-0', 'moderation-default-4'],
          waiting: inDegrade ? 2 : 0,
          active: inDegrade ? 1 : 0,
          delayed: 0,
          failed: 0,
          completed: 820,
          pressure: inDegrade ? 3 : 0,
          status: inDegrade ? 'warning' : 'healthy',
        },
        {
          name: 'api-moderation-realtime-c',
          queues: ['moderation-default-2', 'moderation-default-11'],
          waiting: inDegrade ? 52 : 0,
          active: inDegrade ? 2 : 0,
          delayed: 0,
          failed: inDegrade ? 1 : 0,
          completed: 760,
          pressure: inDegrade ? 54 : 0,
          status: inDegrade ? 'critical' : 'healthy',
        },
      ],
    },
    webhookSlo: {
      status: inDegrade ? 'critical' : 'healthy',
      windowSec: 900,
      targetProcessingMs: 1_000,
      totalEvents: inDegrade ? 1240 : 860,
      processedEvents: inDegrade ? 1170 : 859,
      failedEvents: inDegrade ? 12 : 0,
      sampledProcessedEvents: inDegrade ? 500 : 500,
      p95ProcessingMs: inDegrade ? 1840 : 420,
      p99ProcessingMs: inDegrade ? 2600 : 610,
      underTargetRatio: inDegrade ? 0.82 : 0.992,
      oldestUnprocessedLagSec: inDegrade ? 11.4 : 0,
      oldestUnprocessedEventId: inDegrade ? 'preview-queued-1' : null,
      lastProcessedAt: generatedAt,
      generatedAt,
    },
    slo: {
      status: inDegrade ? 'critical' : 'healthy',
      windowSec: 900,
      targetProcessingMs: 1_000,
      totalEvents: inDegrade ? 1240 : 860,
      processedEvents: inDegrade ? 1170 : 859,
      failedEvents: inDegrade ? 12 : 0,
      sampledProcessedEvents: inDegrade ? 500 : 500,
      p95ProcessingMs: inDegrade ? 1840 : 420,
      p99ProcessingMs: inDegrade ? 2600 : 610,
      underTargetRatio: inDegrade ? 0.82 : 0.992,
      oldestUnprocessedLagSec: inDegrade ? 11.4 : 0,
      oldestUnprocessedEventId: inDegrade ? 'preview-queued-1' : null,
      lastProcessedAt: generatedAt,
      generatedAt,
    },
  };
}

function buildPreviewSystemBots(state: PreviewState): SystemBotsSnapshot {
  const dashboard = buildPreviewSystemDashboard(state);
  const generatedAt = dashboard.summary.generatedAt;
  const inDegrade = dashboard.mode.mode === 'degrade';
  const primaryQueue = dashboard.queues.bots[PREVIEW_PRIMARY_BOT_ID] ?? null;
  const primaryWebhook = dashboard.webhookSubscription.bots[PREVIEW_PRIMARY_BOT_ID] ?? null;
  const standbyBotId = '777001_bot';
  const dormantBotId = '777002_bot';
  const assistTotal =
    (state.chatPartnerAssistEnabled ? 3 : 0) + (state.channelPartnerAssistEnabled ? 1 : 0);
  const problemSamples = inDegrade
    ? [
        {
          chatId: PREVIEW_CHANNEL_ID,
          title: PREVIEW_CHANNEL_TITLE,
          entityType: 'channel' as const,
          kind: 'stale-access' as const,
          botRole: 'standby' as const,
          membershipStatus: 'active' as const,
          botAccessState: 'stale' as const,
          primaryBotId: PREVIEW_PRIMARY_BOT_ID,
          checkedAt: generatedAt,
          lastSeenAt: generatedAt,
          lastWebhookAt: generatedAt,
          updatedAt: generatedAt,
        },
      ]
    : [];

  return systemBotsSnapshotSchema.parse({
    generatedAt,
    summary: {
      total: 3,
      adminVisible: 3,
      active: 2,
      draining: 0,
      dormant: 1,
      disabled: 0,
      webhookWarningBotCount: inDegrade ? 1 : 0,
      problemBotCount: inDegrade ? 1 : 0,
      primaryEntities: {
        total: 37,
        chats: 33,
        channels: 4,
      },
      standbyEntities: {
        total: 12,
        chats: 10,
        channels: 2,
      },
      assistEntities: {
        total: assistTotal,
        chats: state.chatPartnerAssistEnabled ? 3 : 0,
        channels: state.channelPartnerAssistEnabled ? 1 : 0,
      },
      lostAccess: 0,
      staleAccess: inDegrade ? 1 : 0,
      deniedAccess: 0,
    },
    bots: [
      {
        botId: PREVIEW_PRIMARY_BOT_ID,
        label: 'Майор Максимов',
        characterName: 'Майор Максимов',
        lifecycleState: 'active',
        adminVisible: true,
        isDefault: true,
        contactId: '777000',
        webhook: primaryWebhook,
        operationalDiagnostics: primaryWebhook?.operationalDiagnostics ?? null,
        queue: primaryQueue,
        maxApiLoad: {
          windowSec: 60,
          totalRequests: inDegrade ? 18 : 4,
          avgRps: inDegrade ? 0.3 : 0.067,
          peakRps: inDegrade ? 4 : 1,
          avgLoad: inDegrade ? 0.18 : 0.04,
          peakLoad: inDegrade ? 0.42 : 0.08,
          smoothedLoad: inDegrade ? 0.24 : 0.05,
          background: {
            totalRequests: inDegrade ? 6 : 1,
            avgRps: inDegrade ? 0.1 : 0.017,
            peakRps: inDegrade ? 2 : 1,
          },
        },
        entities: {
          primary: {
            total: 37,
            chats: 33,
            channels: 4,
          },
          standby: {
            total: 0,
            chats: 0,
            channels: 0,
          },
          assist: {
            total: 0,
            chats: 0,
            channels: 0,
          },
        },
        access: {
          lost: 0,
          stale: 0,
          denied: 0,
          unknown: 0,
          removedAfterLoss: 0,
        },
        problemSamples: [],
      },
      {
        botId: standbyBotId,
        label: 'Максимов-2',
        characterName: 'Максимов-2',
        lifecycleState: 'active',
        adminVisible: true,
        isDefault: false,
        contactId: '777001',
        webhook: null,
        operationalDiagnostics: null,
        queue: null,
        maxApiLoad: {
          windowSec: 60,
          totalRequests: inDegrade ? 9 : 2,
          avgRps: inDegrade ? 0.15 : 0.033,
          peakRps: inDegrade ? 2 : 1,
          avgLoad: inDegrade ? 0.11 : 0.02,
          peakLoad: inDegrade ? 0.24 : 0.04,
          smoothedLoad: inDegrade ? 0.14 : 0.03,
          background: {
            totalRequests: inDegrade ? 7 : 2,
            avgRps: inDegrade ? 0.117 : 0.033,
            peakRps: inDegrade ? 2 : 1,
          },
        },
        entities: {
          primary: {
            total: 0,
            chats: 0,
            channels: 0,
          },
          standby: {
            total: 12,
            chats: 10,
            channels: 2,
          },
          assist: {
            total: assistTotal,
            chats: state.chatPartnerAssistEnabled ? 3 : 0,
            channels: state.channelPartnerAssistEnabled ? 1 : 0,
          },
        },
        access: {
          lost: 0,
          stale: inDegrade ? 1 : 0,
          denied: 0,
          unknown: 1,
          removedAfterLoss: 0,
        },
        problemSamples,
      },
      {
        botId: dormantBotId,
        label: 'Максимов-3',
        characterName: 'Максимов-3',
        lifecycleState: 'dormant',
        adminVisible: true,
        isDefault: false,
        contactId: '777002',
        webhook: null,
        operationalDiagnostics: null,
        queue: null,
        maxApiLoad: {
          windowSec: 60,
          totalRequests: 0,
          avgRps: 0,
          peakRps: 0,
          avgLoad: 0,
          peakLoad: 0,
          smoothedLoad: 0,
          background: {
            totalRequests: 0,
            avgRps: 0,
            peakRps: 0,
          },
        },
        entities: {
          primary: {
            total: 0,
            chats: 0,
            channels: 0,
          },
          standby: {
            total: 0,
            chats: 0,
            channels: 0,
          },
          assist: {
            total: 0,
            chats: 0,
            channels: 0,
          },
        },
        access: {
          lost: 0,
          stale: 0,
          denied: 0,
          unknown: 0,
          removedAfterLoss: 0,
        },
        problemSamples: [],
      },
    ],
  });
}

function buildPreviewSystemBotRoutePreview(state: PreviewState, url: URL) {
  const dashboard = buildPreviewSystemDashboard(state);
  const generatedAt = dashboard.summary.generatedAt;
  const chatId = url.searchParams.get('chatId')?.trim() || PREVIEW_CHAT_ID;
  const purpose = url.searchParams.get('purpose')?.trim() || 'all';
  const action = url.searchParams.get('action')?.trim() || null;
  const capability = url.searchParams.get('capability')?.trim() || null;
  const fallbackToPrimary = url.searchParams.get('fallbackToPrimary') !== 'false';
  const botId = url.searchParams.get('botId')?.trim() || null;
  const chatExists = chatId === PREVIEW_CHAT_ID || chatId === PREVIEW_CHANNEL_ID;
  const chatTitle =
    chatId === PREVIEW_CHANNEL_ID
      ? PREVIEW_CHANNEL_TITLE
      : chatId === PREVIEW_CHAT_ID
        ? PREVIEW_CHAT_TITLE
        : null;
  const entityType = chatId === PREVIEW_CHANNEL_ID ? 'channel' : chatExists ? 'chat' : null;
  const botById = new Map(PREVIEW_BOT_FIXTURES.map((fixture) => [fixture.botId, fixture]));
  const selectedBot =
    botById.get(botId ?? PREVIEW_STANDBY_BOT_ID) ?? botById.get(PREVIEW_STANDBY_BOT_ID)!;
  const routeBot = (fixture: PreviewBotFixture) => ({
    botId: fixture.botId,
    label: fixture.label,
    lifecycleState: fixture.botId === PREVIEW_REX_BOT_ID ? 'dormant' : 'active',
    adminVisible: true,
    isDefault: fixture.botId === PREVIEW_PRIMARY_BOT_ID,
  });
  const routeCandidates = [selectedBot, botById.get(PREVIEW_PRIMARY_BOT_ID)!].filter(
    (fixture, index, fixtures) =>
      fixtures.findIndex((candidate) => candidate.botId === fixture.botId) === index,
  );
  const allRoutes = [
    {
      purpose: 'send_message',
      action: null,
      capability: null,
      chatId,
      primaryBotId: PREVIEW_PRIMARY_BOT_ID,
      botId: selectedBot.botId,
      candidateBotIds: routeCandidates.map((fixture) => fixture.botId),
      reason:
        selectedBot.botId === PREVIEW_PRIMARY_BOT_ID ? 'primary_confirmed' : 'alternate_confirmed',
      selectedBot: routeBot(selectedBot),
      candidateBots: routeCandidates.map(routeBot),
    },
    {
      purpose: 'moderation_action',
      action: 'delete_message',
      capability: null,
      chatId,
      primaryBotId: PREVIEW_PRIMARY_BOT_ID,
      botId: PREVIEW_EDITOR_BOT_ID,
      candidateBotIds: [PREVIEW_EDITOR_BOT_ID, PREVIEW_STANDBY_BOT_ID],
      reason: 'alternate_confirmed',
      selectedBot: routeBot(botById.get(PREVIEW_EDITOR_BOT_ID)!),
      candidateBots: [PREVIEW_EDITOR_BOT_ID, PREVIEW_STANDBY_BOT_ID].map((id) =>
        routeBot(botById.get(id)!),
      ),
    },
    {
      purpose: 'capability',
      action: null,
      capability: 'membership_prewarm',
      chatId,
      primaryBotId: PREVIEW_PRIMARY_BOT_ID,
      botId: PREVIEW_STANDBY_BOT_ID,
      candidateBotIds: [PREVIEW_STANDBY_BOT_ID, PREVIEW_SCOUT_BOT_ID],
      reason: 'alternate_confirmed',
      selectedBot: routeBot(botById.get(PREVIEW_STANDBY_BOT_ID)!),
      candidateBots: [PREVIEW_STANDBY_BOT_ID, PREVIEW_SCOUT_BOT_ID].map((id) =>
        routeBot(botById.get(id)!),
      ),
    },
  ];
  const routes = allRoutes.filter((route) => {
    if (purpose !== 'all' && route.purpose !== purpose) {
      return false;
    }
    if (action && route.action !== action) {
      return false;
    }
    if (capability && route.capability !== capability) {
      return false;
    }
    return true;
  });
  const memberships = PREVIEW_BOT_FIXTURES.map((fixture) => {
    const isPrimary = fixture.botId === PREVIEW_PRIMARY_BOT_ID;
    const isDormant = fixture.botId === PREVIEW_REX_BOT_ID;
    return {
      botId: fixture.botId,
      label: fixture.label,
      configured: true,
      lifecycleState: isDormant ? 'dormant' : 'active',
      operational: !isDormant,
      discoverable: !isDormant,
      executable: !isDormant,
      role: isPrimary ? 'primary' : 'standby',
      status: 'active',
      botAccessState: isPrimary ? 'confirmed_owner' : isDormant ? 'stale' : 'confirmed_admin',
      capabilities: fixture.assistCapabilities,
      permissionsSummary: {
        checkedAt: generatedAt,
        isAdmin: true,
        isOwner: isPrimary,
        permissions: isPrimary ? ['all'] : fixture.standbyPermissions,
      },
      botAccessCheckedAt: generatedAt,
      botAccessExpiresAt: null,
      botAccessSource: 'preview',
      botAccessLastErrorCode: isDormant ? 'preview.stale' : null,
      lastSeenAt: generatedAt,
      lastWebhookAt: isDormant ? null : generatedAt,
      issues: isDormant ? ['stale-access', 'not-executable'] : [],
    };
  });

  return systemBotRoutePreviewResponseSchema.parse({
    generatedAt,
    query: {
      chatId,
      purpose,
      action,
      capability,
      fallbackToPrimary,
      botId,
    },
    chat: {
      exists: chatExists,
      chatId,
      title: chatTitle,
      entityType,
      catalogKind: chatExists ? 'MANAGED' : null,
      storedPrimaryBotId: chatExists ? PREVIEW_PRIMARY_BOT_ID : null,
      legacyBotId: null,
    },
    routes,
    memberships,
    warnings: chatExists ? [] : ['chat-not-found-in-preview-catalog'],
  });
}

function buildAuthorBadge(value: string | null | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    return 'MX';
  }

  const words = normalized
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);

  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
  }

  return normalized.slice(0, 2).toUpperCase();
}

function addHours(value: Date, hours: number): Date {
  return new Date(value.getTime() + hours * 60 * 60 * 1_000);
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60 * 1_000);
}

function addDays(value: Date, days: number): Date {
  return addHours(value, days * 24);
}

function formatMoscowDateKey(value: Date): string {
  return new Date(value.getTime() + 3 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

function floorPreviewMoscowDay(value: Date): Date {
  const moscowDate = new Date(value.getTime() + 3 * 60 * 60 * 1_000);
  moscowDate.setUTCHours(0, 0, 0, 0);
  return new Date(moscowDate.getTime() - 3 * 60 * 60 * 1_000);
}

function floorPreviewStatsBucket(value: Date, bucket: ChannelStatsBucket): Date {
  if (bucket === 'day') {
    return floorPreviewMoscowDay(value);
  }

  const result = new Date(value);
  result.setUTCMinutes(0, 0, 0);
  return result;
}

function shiftPreviewStatsBucket(value: Date, bucket: ChannelStatsBucket, amount: number): Date {
  const result = new Date(value);
  if (bucket === 'hour') {
    result.setUTCHours(result.getUTCHours() + amount);
    return result;
  }

  result.setUTCDate(result.getUTCDate() + amount);
  return result;
}

function buildPreviewStatsBucketStarts(from: Date, to: Date, bucket: ChannelStatsBucket): Date[] {
  const starts: Date[] = [];
  let cursor = floorPreviewStatsBucket(from, bucket);
  const end = floorPreviewStatsBucket(to, bucket);

  while (cursor.getTime() <= end.getTime()) {
    starts.push(cursor);
    cursor = shiftPreviewStatsBucket(cursor, bucket, 1);
  }

  return starts;
}

function createPreviewVkParsingFeed(chatId: string, now: Date): VkParsingFeed {
  const createdAt = addDays(now, -18).toISOString();
  const syncedAt = addHours(now, -1.2).toISOString();
  const sourceOne: VkParsingSource = {
    id: 'preview-vk-source-yuzhnoe',
    chatId,
    ownerId: 200501,
    wallOwnerId: -200501,
    screenName: 'yuzhnoe_media',
    title: 'Южное медиа',
    url: 'https://vk.com/yuzhnoe_media',
    status: 'ACTIVE',
    importEnabled: true,
    autoPublishEnabled: true,
    autoPublishEnabledAt: addHours(now, -2).toISOString(),
    autoPublishPausedAt: null,
    autoPublishPausedReason: null,
    publishIntervalMinutes: 30,
    dailyLimit: 6,
    minPublishIntervalMinutes: 20,
    publishMode: 'QUEUE',
    priority: 'HIGH',
    quietHoursStart: null,
    quietHoursEnd: null,
    lastAutoPublishedAt: addHours(now, -6.8).toISOString(),
    newPostCount: 2,
    queuedPostCount: 1,
    publishedPostCount: 1,
    skippedPostCount: 1,
    failedPostCount: 1,
    syncStatus: 'IDLE',
    nextSyncAt: null,
    nextRetryAt: null,
    lastSyncAt: syncedAt,
    lastSuccessAt: syncedAt,
    syncStartedAt: null,
    consecutiveFailures: 0,
    terminalFailureCount: 0,
    circuitOpenedAt: null,
    circuitReasonCode: null,
    circuitReason: null,
    circuitRetryAt: null,
    lastErrorCode: null,
    lastImportedCount: 4,
    lastFetchedCount: 9,
    lastFetchedPages: 3,
    lastFetchedOffsets: [0, 50, 100],
    lastVkNewestPostId: 4281,
    lastVkNewestPublishedAt: addHours(now, -2.4).toISOString(),
    adaptiveIntervalMs: 600_000,
    lastSyncDurationMs: 1240,
    lastError: null,
    createdAt,
    updatedAt: syncedAt,
  };
  const sourceTwo: VkParsingSource = {
    id: 'preview-vk-source-afisha',
    chatId,
    ownerId: 200812,
    wallOwnerId: -200812,
    screenName: 'afisha_yuga',
    title: 'Афиша Юга',
    url: 'https://vk.com/afisha_yuga',
    status: 'ACTIVE',
    importEnabled: true,
    autoPublishEnabled: false,
    autoPublishEnabledAt: null,
    autoPublishPausedAt: addHours(now, -1).toISOString(),
    autoPublishPausedReason: 'manual',
    publishIntervalMinutes: 180,
    dailyLimit: 3,
    minPublishIntervalMinutes: 60,
    publishMode: 'REVIEW',
    priority: 'NORMAL',
    quietHoursStart: '23:00',
    quietHoursEnd: '08:00',
    lastAutoPublishedAt: null,
    newPostCount: 1,
    queuedPostCount: 0,
    publishedPostCount: 0,
    skippedPostCount: 0,
    failedPostCount: 0,
    syncStatus: 'BACKOFF',
    nextSyncAt: addHours(now, 1.4).toISOString(),
    nextRetryAt: addHours(now, 1.4).toISOString(),
    lastSyncAt: addHours(now, -4.5).toISOString(),
    lastSuccessAt: addHours(now, -8).toISOString(),
    syncStartedAt: null,
    consecutiveFailures: 1,
    terminalFailureCount: 0,
    circuitOpenedAt: null,
    circuitReasonCode: null,
    circuitReason: null,
    circuitRetryAt: null,
    lastErrorCode: 'RATE_LIMIT',
    lastImportedCount: 1,
    lastFetchedCount: 5,
    lastFetchedPages: 2,
    lastFetchedOffsets: [0, 50],
    lastVkNewestPostId: 119,
    lastVkNewestPublishedAt: addHours(now, -10).toISOString(),
    adaptiveIntervalMs: 1_800_000,
    lastSyncDurationMs: 1890,
    lastError: 'VK временно ограничил запросы к источнику.',
    createdAt: addDays(now, -9).toISOString(),
    updatedAt: addHours(now, -4.5).toISOString(),
  };
  const settings: VkParsingSettings = {
    chatId,
    autoPublishEnabled: true,
    autoPublishEnabledAt: addHours(now, -2).toISOString(),
    autoPublishKillSwitchEnabled: false,
    stripLinksEnabled: true,
    skipAdsEnabled: true,
    schedulerTimezone: 'Europe/Moscow',
    quietHoursStart: '23:00',
    quietHoursEnd: '08:00',
    workHoursStart: '09:00',
    workHoursEnd: '22:00',
    distributeEvenlyEnabled: true,
    roundRobinEnabled: true,
    circuitBreakerEnabled: true,
    circuitBreakerWindowMinutes: 10,
    circuitBreakerPostLimit: 10,
    updatedAt: addHours(now, -2).toISOString(),
  };

  const feed = vkParsingFeedSchema.parse({
    capabilities: { enabled: true, canUse: true, reasonCode: null, reason: null },
    settings,
    sources: [sourceOne, sourceTwo],
    posts: [
      {
        id: 'preview-vk-post-4281',
        sourceId: sourceOne.id,
        chatId,
        sourceTitle: sourceOne.title,
        sourceUrl: sourceOne.url,
        sourcePublishMode: sourceOne.publishMode,
        vkOwnerId: sourceOne.wallOwnerId,
        vkPostId: 4281,
        vkPublishedAt: addHours(now, -2.4).toISOString(),
        text: 'На Южной площади открыли вечернюю навигацию: новые указатели, подсветка у перехода и карта маршрутов на выходные.',
        url: `${sourceOne.url}?w=wall${sourceOne.wallOwnerId}_4281`,
        photoUrls: [
          buildPreviewAvatarDataUrl('Парк', '#4d94ff', '#2b64dd'),
          buildPreviewAvatarDataUrl('Маршрут', '#3cc58b', '#0f9f70'),
        ],
        linkUrls: ['https://example.com/south-map'],
        status: 'NEW',
        contentHash: 'preview-vk-4281',
        publishedContentHash: null,
        publishedMessageId: null,
        publishedUrl: null,
        publishedAtMax: null,
        autoPublishedAt: null,
        autoPublishError: null,
        skippedAt: null,
        skipReason: null,
        lastSeenAt: addHours(now, -1.8).toISOString(),
        missingSinceAt: null,
        unavailableAt: null,
        publishQueuedAt: addHours(now, -0.3).toISOString(),
        publishScheduledAt: addHours(now, 0.8).toISOString(),
        lastError: null,
        createdAt: addHours(now, -2.4).toISOString(),
        updatedAt: addHours(now, -1.8).toISOString(),
      },
      {
        id: 'preview-vk-post-4276',
        sourceId: sourceOne.id,
        chatId,
        sourceTitle: sourceOne.title,
        sourceUrl: sourceOne.url,
        sourcePublishMode: sourceOne.publishMode,
        vkOwnerId: sourceOne.wallOwnerId,
        vkPostId: 4276,
        vkPublishedAt: addHours(now, -7).toISOString(),
        text: 'Расписание городского катка на неделю обновлено. Утренние слоты оставили для школ, вечерние доступны по живой очереди.',
        url: `${sourceOne.url}?w=wall${sourceOne.wallOwnerId}_4276`,
        photoUrls: [],
        videoUrls: ['https://vk.com/video-100200_4276'],
        linkUrls: [],
        status: 'PUBLISHED',
        contentHash: 'preview-vk-4276',
        publishedContentHash: 'preview-vk-4276',
        publishedMessageId: 'preview-max-vk-4276',
        publishedUrl: 'https://max.ru/channels/yuzhnoe-news/message/preview-vk-4276',
        publishedAtMax: addHours(now, -6.8).toISOString(),
        autoPublishedAt: addHours(now, -6.8).toISOString(),
        autoPublishError: null,
        skippedAt: null,
        skipReason: null,
        lastSeenAt: addHours(now, -6.5).toISOString(),
        missingSinceAt: null,
        unavailableAt: null,
        lastError: null,
        createdAt: addHours(now, -7).toISOString(),
        updatedAt: addHours(now, -6.8).toISOString(),
      },
      {
        id: 'preview-vk-post-119',
        sourceId: sourceTwo.id,
        chatId,
        sourceTitle: sourceTwo.title,
        sourceUrl: sourceTwo.url,
        sourcePublishMode: sourceTwo.publishMode,
        vkOwnerId: sourceTwo.wallOwnerId,
        vkPostId: 119,
        vkPublishedAt: addHours(now, -10).toISOString(),
        text: 'Промопост партнёра с маркировкой и внешним переходом.',
        url: `${sourceTwo.url}?w=wall${sourceTwo.wallOwnerId}_119`,
        photoUrls: [],
        linkUrls: ['https://example.com/promo'],
        status: 'NEW',
        contentHash: 'preview-vk-119',
        publishedContentHash: null,
        publishedMessageId: null,
        publishedUrl: null,
        publishedAtMax: null,
        autoPublishedAt: null,
        autoPublishError: null,
        skippedAt: null,
        skipReason: null,
        lastSeenAt: addHours(now, -9.8).toISOString(),
        missingSinceAt: null,
        unavailableAt: null,
        lastError: null,
        createdAt: addHours(now, -10).toISOString(),
        updatedAt: addHours(now, -9.9).toISOString(),
      },
      {
        id: 'preview-vk-post-4259',
        sourceId: sourceOne.id,
        chatId,
        sourceTitle: sourceOne.title,
        sourceUrl: sourceOne.url,
        sourcePublishMode: sourceOne.publishMode,
        vkOwnerId: sourceOne.wallOwnerId,
        vkPostId: 4259,
        vkPublishedAt: addHours(now, -19).toISOString(),
        text: 'Автор обновил исходный пост после публикации: добавил перенос площадки и новый тайминг вечерней программы.',
        url: `${sourceOne.url}?w=wall${sourceOne.wallOwnerId}_4259`,
        photoUrls: [buildPreviewAvatarDataUrl('UPD', '#f1a44b', '#ea7b4b')],
        linkUrls: [],
        status: 'CHANGED_AFTER_PUBLISH',
        contentHash: 'preview-vk-4259-v2',
        publishedContentHash: 'preview-vk-4259-v1',
        publishedMessageId: 'preview-max-vk-4259',
        publishedUrl: 'https://max.ru/channels/yuzhnoe-news/message/preview-vk-4259',
        publishedAtMax: addHours(now, -18.6).toISOString(),
        autoPublishedAt: null,
        autoPublishError: null,
        skippedAt: null,
        skipReason: null,
        lastSeenAt: addHours(now, -1.5).toISOString(),
        missingSinceAt: null,
        unavailableAt: null,
        lastError: null,
        createdAt: addHours(now, -19).toISOString(),
        updatedAt: addHours(now, -1.5).toISOString(),
      },
      {
        id: 'preview-vk-post-4244',
        sourceId: sourceTwo.id,
        chatId,
        sourceTitle: sourceTwo.title,
        sourceUrl: sourceTwo.url,
        sourcePublishMode: sourceTwo.publishMode,
        vkOwnerId: sourceTwo.wallOwnerId,
        vkPostId: 4244,
        vkPublishedAt: addDays(now, -1).toISOString(),
        text: 'Фотоподборка с фестиваля загружена, но часть медиа временно не принял MAX.',
        url: `${sourceTwo.url}?w=wall${sourceTwo.wallOwnerId}_4244`,
        photoUrls: [
          buildPreviewAvatarDataUrl('Фест', '#ff82a8', '#eb577f'),
          buildPreviewAvatarDataUrl('Сцена', '#5ab7b5', '#1b7f8a'),
        ],
        linkUrls: [],
        status: 'FAILED',
        contentHash: 'preview-vk-4244',
        publishedContentHash: null,
        publishedMessageId: null,
        publishedUrl: null,
        publishedAtMax: null,
        autoPublishedAt: null,
        autoPublishError: 'MAX временно не принял одно из вложений.',
        skippedAt: null,
        skipReason: null,
        lastSeenAt: addHours(now, -20).toISOString(),
        missingSinceAt: null,
        unavailableAt: null,
        lastError: 'MAX временно не принял одно из вложений.',
        createdAt: addDays(now, -1).toISOString(),
        updatedAt: addHours(now, -20).toISOString(),
      },
    ],
    pagination: {
      limit: 50,
      offset: 0,
      total: 5,
      hasMore: false,
      nextOffset: null,
    },
    summary: {
      chatId,
      generatedAt: now.toISOString(),
      vkApiRps: 2.1,
      vkApiErrorRate: 0.08,
      sourceCount: 2,
      staleSourceCount: 1,
      importLagSeconds: 90 * 60,
      publishLagSeconds: 12 * 60,
      publishBacklogAgeSeconds: 12 * 60,
      publishBacklog: 1,
      staleSyncLockCount: 0,
      circuitOpenSourceCount: 0,
      importSuccessRate: 0.5,
      p95SyncDurationMs: 1_890,
      mediaFailureRatio: 0.14,
      recentErrors: [{ code: 'vk_6', count: 3 }],
    },
  });
  return vkParsingFeedSchema.parse({
    ...feed,
    queue: feed.posts.filter((post) => post.publishQueuedAt),
  });
}

function buildPreviewVkParsingPage(
  feed: VkParsingFeed,
  searchParams: URLSearchParams,
): VkParsingFeed {
  const query = vkParsingFeedQuerySchema.parse(Object.fromEntries(searchParams.entries()));
  const filteredPosts = feed.posts.filter((post) => {
    if (query.status === 'QUEUED') {
      if (!post.publishQueuedAt) {
        return false;
      }
    } else if (query.status !== 'ALL' && post.status !== query.status) {
      return false;
    }
    if (query.sourceId && post.sourceId !== query.sourceId) {
      return false;
    }

    return true;
  });
  const posts = filteredPosts.slice(query.offset, query.offset + query.limit);
  const nextOffset = query.offset + query.limit;

  return vkParsingFeedSchema.parse({
    ...feed,
    posts,
    queue: feed.posts.filter((post) => post.publishQueuedAt),
    pagination: {
      limit: query.limit,
      offset: query.offset,
      total: filteredPosts.length,
      hasMore: nextOffset < filteredPosts.length,
      nextOffset: nextOffset < filteredPosts.length ? nextOffset : null,
    },
  });
}

type PreviewVkParsingRouteResult = { handled: false } | { handled: true; value: unknown };

function handleVkParsingPreviewRequest(
  state: PreviewState,
  entityType: 'chat' | 'channel',
  chatId: string,
  tail: string[],
  url: URL,
  method: string,
  init?: RequestInit,
): PreviewVkParsingRouteResult {
  if (tail[0] !== 'vk-parsing') {
    return { handled: false };
  }

  const readFeed = () => (entityType === 'channel' ? state.channelVkParsing : state.chatVkParsing);
  const writeFeed = (feed: VkParsingFeed) => {
    const normalizedFeed = vkParsingFeedSchema.parse({
      ...feed,
      queue: feed.posts.filter((post) => post.publishQueuedAt),
    });
    if (entityType === 'channel') {
      state.channelVkParsing = normalizedFeed;
    } else {
      state.chatVkParsing = normalizedFeed;
    }
  };

  if (tail[1] === 'capability' && method === 'GET') {
    return {
      handled: true,
      value: vkParsingCapabilitySchema.parse({
        enabled: true,
        canUse: true,
        reasonCode: null,
        reason: null,
      }),
    };
  }

  if (tail.length === 1 && method === 'GET') {
    return {
      handled: true,
      value: cloneJson(buildPreviewVkParsingPage(readFeed(), url.searchParams)),
    };
  }

  if (tail[1] === 'summary' && method === 'GET') {
    return {
      handled: true,
      value: vkParsingHealthSummarySchema.parse(readFeed().summary),
    };
  }

  if (tail[1] === 'settings' && method === 'PATCH') {
    const payload = updateVkParsingSettingsRequestSchema.parse(parseJsonBody(init));
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      settings: {
        ...readFeed().settings,
        ...payload,
        chatId,
        updatedAt: new Date().toISOString(),
      },
    });
    writeFeed(feed);
    return { handled: true, value: cloneJson(feed) };
  }

  if (tail[1] === 'autopublish' && tail[2] === 'dry-run' && method === 'GET') {
    const sourceId = url.searchParams.get('sourceId');
    const feed = readFeed();
    const sources = sourceId
      ? feed.sources.filter((source) => source.id === sourceId)
      : feed.sources;
    return {
      handled: true,
      value: {
        chatId,
        sourceId: sourceId ?? null,
        generatedAt: new Date().toISOString(),
        globalEnabled: feed.settings.autoPublishEnabled,
        killSwitchEnabled: feed.settings.autoPublishKillSwitchEnabled,
        baselineAt: feed.settings.autoPublishEnabledAt,
        eligibleNow: 0,
        latestImportedVkPublishedAt:
          feed.posts
            .filter((post) => !sourceId || post.sourceId === sourceId)
            .map((post) => post.vkPublishedAt)
            .filter(Boolean)
            .sort()
            .at(-1) ?? null,
        sourcesWithoutSuccessfulSync: sources.filter((source) => !source.lastSuccessAt).length,
      },
    };
  }

  if (tail[1] === 'rollback' && method === 'POST') {
    const payload = rollbackVkParsingRequestSchema.parse(parseJsonBody(init));
    const posts = readFeed().posts.filter((post) => {
      if (!post.autoPublishedAt) {
        return false;
      }
      if (payload.sourceId && post.sourceId !== payload.sourceId) {
        return false;
      }
      return post.autoPublishedAt >= payload.since && post.autoPublishedAt <= payload.until;
    });
    return {
      handled: true,
      value: rollbackVkParsingResultSchema.parse({
        matched: posts.length,
        deleted: payload.deleteMessages ? posts.length : 0,
        failed: 0,
        posts,
      }),
    };
  }

  if (tail[1] === 'sources' && tail[2] === 'bulk' && method === 'POST') {
    const payload = bulkUpdateVkParsingSourcesRequestSchema.parse(parseJsonBody(init));
    const nowIso = new Date().toISOString();
    const currentFeed = readFeed();
    const feed = vkParsingFeedSchema.parse({
      ...currentFeed,
      settings:
        payload.preset === 'CLEAN'
          ? {
              ...currentFeed.settings,
              stripLinksEnabled: true,
              skipAdsEnabled: true,
              updatedAt: nowIso,
            }
          : currentFeed.settings,
      sources: currentFeed.sources.map((source) =>
        payload.sourceIds.includes(source.id)
          ? {
              ...source,
              importEnabled: true,
              autoPublishEnabled: payload.preset !== 'REVIEW',
              autoPublishEnabledAt: payload.preset !== 'REVIEW' ? nowIso : null,
              publishMode: payload.preset === 'REVIEW' ? 'REVIEW' : 'QUEUE',
              priority: payload.preset === 'NEWS' ? 'HIGH' : 'NORMAL',
              publishIntervalMinutes:
                payload.preset === 'NEWS' ? 20 : payload.preset === 'SLOW' ? 180 : 60,
              dailyLimit: payload.preset === 'NEWS' ? 12 : 3,
              updatedAt: nowIso,
            }
          : source,
      ),
    });
    writeFeed(feed);
    return { handled: true, value: cloneJson(feed) };
  }

  if (tail[1] === 'sources' && tail.length === 2 && method === 'POST') {
    const payload = addVkParsingSourceRequestSchema.parse(parseJsonBody(init));
    const now = new Date();
    const parsedUrl = new URL(payload.url);
    const screenName = parsedUrl.pathname.split('/').filter(Boolean)[0] ?? 'vk_source';
    const source: VkParsingSource = {
      id: `preview-vk-source-${Date.now()}`,
      chatId,
      ownerId: 200900,
      wallOwnerId: -200900,
      screenName,
      title: screenName.replace(/[_-]+/gu, ' ') || 'VK источник',
      url: parsedUrl.toString(),
      status: 'ACTIVE',
      importEnabled: true,
      autoPublishEnabled: false,
      autoPublishEnabledAt: null,
      autoPublishPausedAt: null,
      autoPublishPausedReason: null,
      publishIntervalMinutes: 60,
      dailyLimit: 3,
      minPublishIntervalMinutes: 30,
      publishMode: 'QUEUE',
      priority: 'NORMAL',
      quietHoursStart: null,
      quietHoursEnd: null,
      lastAutoPublishedAt: null,
      newPostCount: 0,
      queuedPostCount: 0,
      publishedPostCount: 0,
      skippedPostCount: 0,
      failedPostCount: 0,
      syncStatus: 'QUEUED',
      nextSyncAt: null,
      nextRetryAt: null,
      lastSyncAt: null,
      lastSuccessAt: null,
      syncStartedAt: null,
      consecutiveFailures: 0,
      terminalFailureCount: 0,
      circuitOpenedAt: null,
      circuitReasonCode: null,
      circuitReason: null,
      circuitRetryAt: null,
      lastErrorCode: null,
      lastImportedCount: 0,
      lastFetchedCount: 0,
      lastFetchedPages: 0,
      lastFetchedOffsets: [],
      lastVkNewestPostId: null,
      lastVkNewestPublishedAt: null,
      adaptiveIntervalMs: null,
      lastSyncDurationMs: null,
      lastError: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      sources: [source, ...readFeed().sources],
    });
    writeFeed(feed);
    return {
      handled: true,
      value: vkParsingRefreshResultSchema.parse({
        ...feed,
        imported: 0,
        queued: 1,
      }),
    };
  }

  if (tail[1] === 'sources' && tail[2] && tail.length === 3 && method === 'PATCH') {
    const sourceId = decodeURIComponent(tail[2]);
    const payload = updateVkParsingSourceRequestSchema.parse(parseJsonBody(init));
    const nowIso = new Date().toISOString();
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      sources: readFeed().sources.map((source) =>
        source.id === sourceId
          ? {
              ...source,
              ...payload,
              autoPublishEnabledAt:
                payload.autoPublishEnabled === true
                  ? (source.autoPublishEnabledAt ?? nowIso)
                  : payload.autoPublishEnabled === false
                    ? null
                    : source.autoPublishEnabledAt,
              updatedAt: nowIso,
            }
          : source,
      ),
    });
    writeFeed(feed);
    return { handled: true, value: cloneJson(feed) };
  }

  if (tail[1] === 'sources' && tail[2] && tail[3] === 'refresh' && method === 'POST') {
    const sourceId = decodeURIComponent(tail[2]);
    const nowIso = new Date().toISOString();
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      sources: readFeed().sources.map((source) =>
        source.id === sourceId
          ? {
              ...source,
              syncStatus: 'IDLE',
              lastSyncAt: nowIso,
              lastSuccessAt: nowIso,
              lastImportedCount: source.lastImportedCount + 1,
              updatedAt: nowIso,
            }
          : source,
      ),
    });
    writeFeed(feed);
    return {
      handled: true,
      value: vkParsingRefreshResultSchema.parse({ ...feed, imported: 1, queued: 1 }),
    };
  }

  if (tail[1] === 'sources' && tail[2] && method === 'DELETE') {
    const sourceId = decodeURIComponent(tail[2]);
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      sources: readFeed().sources.filter((source) => source.id !== sourceId),
      posts: readFeed().posts.filter((post) => post.sourceId !== sourceId),
    });
    writeFeed(feed);
    return { handled: true, value: cloneJson(feed) };
  }

  if (tail[1] === 'refresh' && method === 'POST') {
    const nowIso = new Date().toISOString();
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      sources: readFeed().sources.map((source) => ({
        ...source,
        syncStatus: 'IDLE',
        lastSyncAt: nowIso,
        lastSuccessAt: nowIso,
        syncStartedAt: null,
        consecutiveFailures: 0,
        lastErrorCode: null,
        lastError: null,
        updatedAt: nowIso,
      })),
    });
    writeFeed(feed);
    return {
      handled: true,
      value: vkParsingRefreshResultSchema.parse({
        ...feed,
        imported: 2,
        queued: feed.sources.length,
      }),
    };
  }

  if (tail[1] === 'posts' && tail[2] && tail[3] === 'retry' && method === 'POST') {
    const postId = decodeURIComponent(tail[2]);
    const post = readFeed().posts.find((item) => item.id === postId);
    if (!post) {
      throw new Error(`Preview VK post not found: ${postId}`);
    }

    const nowIso = new Date().toISOString();
    const updatedPost: VkParsingPost = {
      ...post,
      status: 'NEW',
      publishQueuedAt: nowIso,
      publishScheduledAt: addHours(new Date(), 1).toISOString(),
      publishLockedAt: null,
      publishAttemptCount: post.publishAttemptCount + 1,
      autoPublishError: null,
      lastError: null,
      updatedAt: nowIso,
    };
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      posts: readFeed().posts.map((item) => (item.id === updatedPost.id ? updatedPost : item)),
    });
    writeFeed(feed);
    return {
      handled: true,
      value: retryVkParsingPostResultSchema.parse({
        post: updatedPost,
        queued: 1,
      }),
    };
  }

  if (tail[1] === 'posts' && tail[2] && tail[3] === 'schedule' && method === 'PATCH') {
    const payload = scheduleVkParsingPostRequestSchema.parse(parseJsonBody(init));
    const postId = decodeURIComponent(tail[2]);
    const post = readFeed().posts.find((item) => item.id === postId);
    if (!post) {
      throw new Error(`Preview VK post not found: ${postId}`);
    }

    const nowIso = new Date().toISOString();
    const updatedPost: VkParsingPost = {
      ...post,
      status: 'NEW',
      publishQueuedAt: post.publishQueuedAt ?? nowIso,
      publishScheduledAt: payload.scheduledAt,
      publishLockedAt: null,
      publishAttemptCount: post.publishAttemptCount,
      updatedAt: nowIso,
    };
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      posts: readFeed().posts.map((item) => (item.id === updatedPost.id ? updatedPost : item)),
    });
    writeFeed(feed);
    return {
      handled: true,
      value: retryVkParsingPostResultSchema.parse({ post: updatedPost, queued: 1 }),
    };
  }

  if (tail[1] === 'posts' && tail[2] && tail[3] === 'cancel' && method === 'POST') {
    const postId = decodeURIComponent(tail[2]);
    const post = readFeed().posts.find((item) => item.id === postId);
    if (!post) {
      throw new Error(`Preview VK post not found: ${postId}`);
    }
    const nowIso = new Date().toISOString();
    const updatedPost: VkParsingPost = {
      ...post,
      publishQueuedAt: null,
      publishScheduledAt: null,
      publishLockedAt: null,
      publishCancelledAt: nowIso,
      publishCancelledByUserId: 'preview-user',
      updatedAt: nowIso,
    };
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      posts: readFeed().posts.map((item) => (item.id === updatedPost.id ? updatedPost : item)),
    });
    writeFeed(feed);
    return {
      handled: true,
      value: retryVkParsingPostResultSchema.parse({ post: updatedPost, queued: 0 }),
    };
  }

  if (tail[1] === 'posts' && tail[2] && tail[3] === 'publish-now' && method === 'POST') {
    const postId = decodeURIComponent(tail[2]);
    const post = readFeed().posts.find((item) => item.id === postId);
    if (!post) {
      throw new Error(`Preview VK post not found: ${postId}`);
    }
    const nowIso = new Date().toISOString();
    const updatedPost: VkParsingPost = {
      ...post,
      status: 'NEW',
      publishQueuedAt: nowIso,
      publishScheduledAt: nowIso,
      publishLockedAt: null,
      publishCancelledAt: null,
      publishCancelledByUserId: null,
      updatedAt: nowIso,
    };
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      posts: readFeed().posts.map((item) => (item.id === updatedPost.id ? updatedPost : item)),
    });
    writeFeed(feed);
    return {
      handled: true,
      value: retryVkParsingPostResultSchema.parse({ post: updatedPost, queued: 1 }),
    };
  }

  if (tail[1] === 'posts' && tail[2] && tail[3] === 'review-draft' && method === 'PATCH') {
    const payload = publishVkParsingPostRequestSchema.parse(parseJsonBody(init));
    const postId = decodeURIComponent(tail[2]);
    const post = readFeed().posts.find((item) => item.id === postId);
    if (!post) {
      throw new Error(`Preview VK post not found: ${postId}`);
    }

    const nowIso = new Date().toISOString();
    const updatedPost: VkParsingPost = {
      ...post,
      text: payload.text,
      photoUrls: payload.photoUrls,
      videoUrls: payload.videoUrls,
      linkUrls: payload.linkUrls,
      status: 'NEW',
      autoPublishError: null,
      publishQueuedAt: null,
      publishScheduledAt: null,
      publishLockedAt: null,
      publishCancelledAt: null,
      publishCancelledByUserId: null,
      lastError: null,
      updatedAt: nowIso,
    };
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      posts: readFeed().posts.map((item) => (item.id === updatedPost.id ? updatedPost : item)),
    });
    writeFeed(feed);
    return {
      handled: true,
      value: feed,
    };
  }

  if (tail[1] === 'posts' && tail[2] && tail[3] === 'publish' && method === 'POST') {
    const payload = publishVkParsingPostRequestSchema.parse(parseJsonBody(init));
    const postId = decodeURIComponent(tail[2]);
    const post = readFeed().posts.find((item) => item.id === postId);
    if (!post) {
      throw new Error(`Preview VK post not found: ${postId}`);
    }

    const nowIso = new Date().toISOString();
    const messageId = `preview-vk-published-${Date.now()}`;
    const urlPrefix = entityType === 'channel' ? 'channels/yuzhnoe-news' : 'chats/preview-chat';
    const url = `https://max.ru/${urlPrefix}/message/${messageId}`;
    const updatedPost: VkParsingPost = {
      ...post,
      text: payload.text,
      photoUrls: payload.photoUrls,
      videoUrls: payload.videoUrls,
      linkUrls: payload.linkUrls,
      status: 'PUBLISHED',
      publishedContentHash: `preview-${messageId}`,
      publishedMessageId: messageId,
      publishedUrl: url,
      publishedAtMax: nowIso,
      autoPublishedAt: null,
      autoPublishError: null,
      publishQueuedAt: null,
      publishScheduledAt: null,
      publishLockedAt: null,
      lastError: null,
      updatedAt: nowIso,
    };
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      posts: readFeed().posts.map((item) => (item.id === updatedPost.id ? updatedPost : item)),
    });
    writeFeed(feed);
    return {
      handled: true,
      value: publishVkParsingPostResultSchema.parse({
        post: updatedPost,
        messageId,
        url,
      }),
    };
  }

  throw new Error(
    `Preview transport does not implement ${method} /vk-parsing/${tail.slice(1).join('/')}`,
  );
}

function createPreviewImmunity(durationHours: number, dailyViolationLimit: number, used = 0) {
  return chatParticipantImmunitySchema.parse({
    mode: 'limited',
    expiresAt: addHours(new Date(), durationHours).toISOString(),
    dailyViolationLimit,
    usedViolatingMessagesToday: used,
    remainingViolatingMessagesToday: Math.max(0, dailyViolationLimit - used),
  });
}

function createPreviewAlwaysImmunity() {
  return chatParticipantImmunitySchema.parse({
    mode: 'always',
    expiresAt: null,
    dailyViolationLimit: null,
    usedViolatingMessagesToday: 0,
    remainingViolatingMessagesToday: null,
  });
}

function resolveRangeWindow(range: MembershipActivityRange, now: Date) {
  const to = new Date(now);
  const from = new Date(now);

  if (range === '24h') {
    from.setHours(from.getHours() - 24);
  } else if (range === '7d') {
    from.setDate(from.getDate() - 7);
  } else {
    from.setDate(from.getDate() - 30);
  }

  return { from, to };
}

function isWithinRange(createdAt: string, range: MembershipActivityRange, now: Date): boolean {
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const { from, to } = resolveRangeWindow(range, now);
  return timestamp >= from.getTime() && timestamp <= to.getTime();
}

function filterActivityItems(
  items: MembershipActivityItem[],
  range: MembershipActivityRange,
  filter: MembershipActivityFilter,
  now: Date,
): MembershipActivityItem[] {
  return items.filter((item) => {
    if (!isWithinRange(item.createdAt, range, now)) {
      return false;
    }

    if (filter !== 'all' && item.type !== filter) {
      return false;
    }

    return true;
  });
}

function matchesModerationFeedFilter(
  item: LogsDashboardResponse['violations'][number],
  filter: ModerationFeedFilter,
): boolean {
  if (filter === 'ALL') {
    return true;
  }

  if (filter === 'UNBAN') {
    return item.ruleCode === 'MANUAL_UNBAN';
  }

  return item.action === filter;
}

function buildModerationFeedPage(
  items: LogsDashboardResponse['violations'],
  {
    range,
    filter = 'ALL',
    limit = 50,
    cursor,
  }: {
    range: LogsDashboardRange;
    filter?: ModerationFeedFilter;
    limit?: number;
    cursor?: string | null;
  },
  now: Date,
): ModerationFeedPage {
  const filtered = items.filter(
    (item) =>
      isWithinRange(item.createdAt, range, now) && matchesModerationFeedFilter(item, filter),
  );
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const pageItems = filtered.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + pageItems.length;

  return moderationFeedPageSchema.parse({
    items: pageItems,
    hasMore: nextOffset < filtered.length,
    nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
  });
}

function buildActivityPage(
  items: MembershipActivityItem[],
  {
    range,
    filter = 'all',
    limit = 50,
    cursor,
  }: {
    range: MembershipActivityRange;
    filter?: MembershipActivityFilter;
    limit?: number;
    cursor?: string | null;
  },
  now: Date,
): MembershipActivityPage {
  const filtered = filterActivityItems(items, range, filter, now);
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const pageItems = filtered.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + pageItems.length;

  return membershipActivityPageSchema.parse({
    items: pageItems,
    hasMore: nextOffset < filtered.length,
    nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
  });
}

function isViolationCounterEvent(item: LogsDashboardResponse['violations'][number]): boolean {
  return (
    item.action === 'WARN' ||
    item.action === 'DELETE_MESSAGE' ||
    item.action === 'MUTE' ||
    item.action === 'KICK' ||
    item.action === 'BAN'
  );
}

function buildParticipantsPage(
  items: ChatParticipantItem[],
  {
    range = '7d',
    limit = 100,
    cursor,
    search,
  }: {
    range?: LogsDashboardRange;
    limit?: number;
    cursor?: string | null;
    search?: string | null;
  },
  totalCount: number,
  violations: LogsDashboardResponse['violations'],
  now: Date,
): ChatParticipantsPage {
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const normalizedSearch = normalizeParticipantSearchText(search ?? '');
  const filteredItems = normalizedSearch
    ? items.filter((item) => participantMatchesSearch(item, normalizedSearch))
    : items;
  const violationCountByUserId = new Map<string, number>();

  for (const violation of violations) {
    if (!isWithinRange(violation.createdAt, range, now) || !isViolationCounterEvent(violation)) {
      continue;
    }

    violationCountByUserId.set(
      violation.userId,
      (violationCountByUserId.get(violation.userId) ?? 0) + 1,
    );
  }

  const pageItems = filteredItems.slice(safeOffset, safeOffset + limit).map((item) => ({
    ...item,
    violationCount: violationCountByUserId.get(item.userId) ?? 0,
  }));
  const nextOffset = safeOffset + pageItems.length;

  return chatParticipantsPageSchema.parse({
    items: pageItems,
    totalCount,
    hasMore: nextOffset < filteredItems.length,
    nextCursor: nextOffset < filteredItems.length ? String(nextOffset) : null,
  });
}

function normalizeParticipantSearchText(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('ru-RU');
  const withoutMentionPrefix = normalized.replace(/^@+/u, '');
  return withoutMentionPrefix || normalized;
}

function participantMatchesSearch(item: ChatParticipantItem, search: string): boolean {
  const username = item.username?.replace(/^@+/u, '').trim() ?? '';
  const candidates = [item.userDisplayName, username, username ? `@${username}` : '', item.userId];

  return candidates.some((candidate) => normalizeParticipantSearchText(candidate).includes(search));
}

function buildBroadcastSummary(details: ManagedBroadcastDetails) {
  const imageCount = details.images.length || (details.imageEnabled ? 1 : 0);
  return {
    id: details.id,
    status: details.status,
    textPreview:
      details.text.trim().slice(0, 120) ||
      (imageCount > 0 ? 'Фото без текста' : 'Пустой автопостинг'),
    textLength: details.text.length,
    targetMode: details.targetMode,
    applyToAllChats: details.applyToAllChats,
    targetChats: details.targetChatIds.length || 1,
    hasImage: imageCount > 0,
    imageCount,
    hasVideo: details.mediaType === 'video',
    buttons: details.buttons,
    buttonEnabled: details.buttonEnabled,
    scheduleMode: details.scheduleMode,
    scheduleTimezone: details.scheduleTimezone,
    scheduledSlots: details.scheduledSlots,
    nextSendAt: details.nextSendAt,
    cycleEnabled: details.cycleEnabled,
    cycleEveryHours: details.cycleEveryHours,
    cycleCount: details.cycleCount,
    sentCount: details.sentCount,
    currentOccurrence: details.currentOccurrence,
    deliveredChats: details.deliveredChats,
    failedChats: details.failedChats,
    pendingChats: details.pendingChats,
    blockedChats: details.blockedChats,
    failureBreakdown: details.failureBreakdown,
    canRetry: details.canRetry,
    remainingCount: details.remainingCount,
    createdAt: details.createdAt,
    updatedAt: details.updatedAt,
    lastError: details.lastError,
  };
}

function buildPreviewManagedEntitiesResponse(items: ChatSummary[]): ManagedEntitiesListResponse {
  return managedEntitiesListResponseSchema.parse({
    items,
    refresh: {
      complete: true,
      cursor: -1,
      backoffActive: false,
      userVisibleComplete: true,
      nextPollAfterMs: 0,
      processedCandidates: items.length,
      totalCandidates: items.length,
      progressPercent: 100,
      lastSyncedAt: new Date().toISOString(),
    },
    snapshot: {
      version: 'preview-snapshot-v1',
      builtAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
      source: 'published_snapshot',
      stale: false,
    },
  });
}

function resolvePreviewApplyTargetChats(
  state: PreviewState,
  sourceChatId: string,
  target: ApplySettingsTarget,
): ChatSummary[] {
  if (target.mode === 'current') {
    return state.chats.filter((item) => item.id === sourceChatId);
  }

  if (target.mode === 'selectedChats') {
    const selectedIds = new Set(target.chatIds);
    return state.chats.filter((item) => selectedIds.has(item.id));
  }

  if (target.mode === 'allFavorites') {
    return state.chats.filter((item) => (item.favoriteTypes ?? []).length > 0);
  }

  if (target.mode === 'favoriteTypes') {
    const favoriteTypes = new Set(target.favoriteTypes);
    return state.chats.filter((item) =>
      (item.favoriteTypes ?? []).some((favoriteType) => favoriteTypes.has(favoriteType)),
    );
  }

  return state.chats;
}

function updatePreviewManagedEntityFavorites(
  state: PreviewState,
  entityType: ManagedEntityType,
  entityId: string,
  favoriteTypes: ApplySettingsTarget['favoriteTypes'],
): void {
  const items = entityType === 'channel' ? state.channels : state.chats;
  const index = items.findIndex((item) => item.id === entityId);
  if (index < 0) {
    throw new Error(`Preview managed entity not found: ${entityType}/${entityId}`);
  }

  const next = { ...items[index] };
  if (favoriteTypes.length > 0) {
    next.favoriteTypes = favoriteTypes;
  } else {
    delete next.favoriteTypes;
  }
  items[index] = next;
}

function buildBroadcastHandoffState(details: ManagedBroadcastDetails): BroadcastHandoffState {
  return broadcastHandoffStateSchema.parse({
    targetMode: details.targetMode,
    targetChatIds: details.targetChatIds,
    applyToAllChats: details.applyToAllChats,
    buttons: details.buttons,
    buttonEnabled: details.buttonEnabled,
    buttonUrl: details.buttonUrl,
    buttonText: details.buttonText,
    scheduleMode: details.scheduleMode,
    scheduleTimezone: details.scheduleTimezone,
    scheduledSlots: details.scheduledSlots,
    sendAt: details.nextSendAt,
    cycleEnabled: details.cycleEnabled,
    cycleEveryHours: details.cycleEveryHours,
    cycleCount: details.cycleCount,
    hasContent: Boolean(
      details.text.trim() || details.imageEnabled || details.mediaType === 'video',
    ),
  });
}

function buildGiveawaySummary(details: ManagedGiveawayDetails): ManagedGiveawaySummary {
  return {
    id: details.id,
    title: details.title,
    status: details.status,
    hasImage: details.hasImage,
    entriesCount: details.entriesCount,
    verifiedEntriesCount: details.verifiedEntriesCount,
    pendingEntriesCount: details.pendingEntriesCount,
    winnersCount: details.winnersCount,
    startsAt: details.startsAt,
    endsAt: details.endsAt,
    publishedAt: details.publishedAt,
    completedAt: details.completedAt,
    publicationUrl: details.publicationUrl,
    resultsUrl: details.resultsUrl,
    createdAt: details.createdAt,
    updatedAt: details.updatedAt,
  };
}

function readPreviewGiveawayVariant(): PreviewGiveawayVariant {
  const params = new URLSearchParams(window.location.search);
  const value = params.get('giveaway_state');

  if (value === 'joined' || value === 'winner' || value === 'completed') {
    return value;
  }

  return 'blocked';
}

function readPreviewGiveawayEnterResult(): PreviewGiveawayParticipantVariant | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get('giveaway_enter_result');
  if (
    value === 'blocked-entered' ||
    value === 'joined' ||
    value === 'winner' ||
    value === 'completed' ||
    value === 'winner-claimed'
  ) {
    return value;
  }

  return null;
}

function buildPreviewGiveawayRuntimeStateKey(): string {
  const queryVariant = readPreviewGiveawayVariant();
  const enterResult = readPreviewGiveawayEnterResult() ?? 'default';
  return `${PREVIEW_GIVEAWAY_RUNTIME_STATE_KEY}:${queryVariant}:${enterResult}`;
}

function readPreviewGiveawayParticipantVariant(): PreviewGiveawayParticipantVariant {
  const queryVariant = readPreviewGiveawayVariant();
  if (typeof window === 'undefined') {
    return queryVariant;
  }

  const override = window.sessionStorage.getItem(buildPreviewGiveawayRuntimeStateKey());
  if (
    override === 'blocked' ||
    override === 'joined' ||
    override === 'winner' ||
    override === 'completed' ||
    override === 'blocked-entered' ||
    override === 'winner-claimed'
  ) {
    return override;
  }

  return queryVariant;
}

function writePreviewGiveawayParticipantVariant(variant: PreviewGiveawayParticipantVariant): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.sessionStorage.setItem(buildPreviewGiveawayRuntimeStateKey(), variant);
}

function buildPreviewPublicGiveaway(
  state: PreviewState,
  giveawayId: string,
  variant: PreviewGiveawayVariant,
): ManagedGiveawayPublic {
  const now = new Date();
  const sourceChannel = state.channels.find((item) => item.id === PREVIEW_CHANNEL_ID);
  const extraChannel = state.channels.find((item) => item.id === 'preview-channel-2');
  const baitPrizes = Array.from({ length: 10 }, (_, index) => ({
    id: `public-prize-${index + 1}`,
    position: index + 1,
    title: `Прикормка ${index + 1}`,
    displayTitle: 'Прикормка',
  }));

  return managedGiveawayPublicSchema.parse({
    id: giveawayId,
    sourceChatId: PREVIEW_CHANNEL_ID,
    sourceTitle: sourceChannel?.title ?? PREVIEW_CHANNEL_TITLE,
    sourceLink: sourceChannel?.link ?? null,
    entityType: 'channel',
    title: variant === 'completed' ? 'Итоги розыгрыша прикормок' : 'Прикормка',
    description:
      'Подпишитесь на канал, отметьте участие и дождитесь итогов. Победителей определим автоматически, а подтверждение приза пройдёт прямо внутри MAX.',
    status: variant === 'completed' ? 'COMPLETED' : 'ACTIVE',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    startsAt: addHours(now, -20).toISOString(),
    endsAt:
      variant === 'completed' ? addHours(now, -2).toISOString() : addHours(now, 28).toISOString(),
    claimHours: 48,
    requiredChannelIds: extraChannel ? [extraChannel.id] : [],
    requiredChannels: extraChannel
      ? [
          {
            id: extraChannel.id,
            title: extraChannel.title,
            link: extraChannel.link ?? null,
          },
        ]
      : [],
    entriesCount: variant === 'completed' ? 912 : 684,
    winnersCount: 10,
    publishedAt: addHours(now, -19.5).toISOString(),
    completedAt: variant === 'completed' ? addHours(now, -1.5).toISOString() : null,
    publicationUrl: 'https://max.ru/giveaway/public-preview',
    resultsUrl: variant === 'completed' ? 'https://max.ru/giveaway/public-preview/results' : null,
    prizes: baitPrizes,
    winners:
      variant === 'completed'
        ? baitPrizes.map((prize, index) => ({
            prizePosition: prize.position,
            prizeTitle: prize.title,
            prizeDisplayTitle: prize.displayTitle,
            displayName:
              [
                'Марина Орлова',
                'Дмитрий Ковалёв',
                'Анна Соколова',
                'Илья Романов',
                'Елена Миронова',
                'Павел Андреев',
                'Ольга Белова',
                'Артём Волков',
                'Наталья Ким',
                'Сергей Морозов',
              ][index] ?? 'Победитель',
            status: index % 3 === 0 ? 'CLAIMED' : 'DELIVERED',
          }))
        : [],
  });
}

function buildPreviewGiveawayParticipantState(
  variant: PreviewGiveawayParticipantVariant,
): ManagedGiveawayParticipantState {
  const now = new Date();

  if (variant === 'winner' || variant === 'winner-claimed') {
    const isClaimed = variant === 'winner-claimed';
    const claimDeadlineAt = addHours(now, 36).toISOString();
    return managedGiveawayParticipantStateSchema.parse({
      joined: true,
      entryId: 'preview-entry-winner',
      eligibilityState: 'VERIFIED',
      eligibilityReason: null,
      missingChannelIds: [],
      joinedAt: addHours(now, -12).toISOString(),
      isWinner: true,
      winnerId: 'preview-winner-1',
      winnerStatus: isClaimed ? 'CLAIMED' : 'SELECTED',
      claimDeadlineAt: isClaimed ? null : claimDeadlineAt,
      prizePosition: 1,
      prizeTitle: 'Прикормка 1',
      prizeDisplayTitle: 'Прикормка',
      canClaim: !isClaimed,
      claimBotUrl: isClaimed ? null : 'https://max.ru/777000_bot?start=preview-claim',
    });
  }

  if (variant === 'joined') {
    return managedGiveawayParticipantStateSchema.parse({
      joined: true,
      entryId: 'preview-entry-joined',
      eligibilityState: 'VERIFIED',
      eligibilityReason: null,
      missingChannelIds: [],
      joinedAt: addHours(now, -4).toISOString(),
      isWinner: false,
      winnerId: null,
      winnerStatus: null,
      claimDeadlineAt: null,
      prizePosition: null,
      prizeTitle: null,
      prizeDisplayTitle: null,
      canClaim: false,
      claimBotUrl: null,
    });
  }

  if (variant === 'completed') {
    return managedGiveawayParticipantStateSchema.parse({
      joined: true,
      entryId: 'preview-entry-completed',
      eligibilityState: 'VERIFIED',
      eligibilityReason: null,
      missingChannelIds: [],
      joinedAt: addHours(now, -18).toISOString(),
      isWinner: false,
      winnerId: null,
      winnerStatus: null,
      claimDeadlineAt: null,
      prizePosition: null,
      prizeTitle: null,
      prizeDisplayTitle: null,
      canClaim: false,
      claimBotUrl: null,
    });
  }

  if (variant === 'blocked-entered') {
    return managedGiveawayParticipantStateSchema.parse({
      joined: true,
      entryId: 'preview-entry-blocked',
      eligibilityState: 'REJECTED',
      eligibilityReason: 'Подписка на обязательный чат/канал не подтверждена.',
      missingChannelIds: ['preview-channel-2'],
      joinedAt: addHours(now, -0.2).toISOString(),
      isWinner: false,
      winnerId: null,
      winnerStatus: null,
      claimDeadlineAt: null,
      prizePosition: null,
      prizeTitle: null,
      prizeDisplayTitle: null,
      canClaim: false,
      claimBotUrl: null,
    });
  }

  return managedGiveawayParticipantStateSchema.parse({
    joined: false,
    entryId: null,
    eligibilityState: null,
    eligibilityReason: null,
    missingChannelIds: [],
    joinedAt: null,
    isWinner: false,
    winnerId: null,
    winnerStatus: null,
    claimDeadlineAt: null,
    prizePosition: null,
    prizeTitle: null,
    prizeDisplayTitle: null,
    canClaim: false,
    claimBotUrl: null,
  });
}

function resolveChatTitle(chatId: string, state: PreviewState): string {
  return state.chats.find((item) => item.id === chatId)?.title ?? PREVIEW_CHAT_TITLE;
}

function resolveChatAvatarUrl(chatId: string, state: PreviewState): string | null {
  return state.chats.find((item) => item.id === chatId)?.avatarUrl ?? null;
}

function resolveChannelTitle(channelId: string, state: PreviewState): string {
  return state.channels.find((item) => item.id === channelId)?.title ?? PREVIEW_CHANNEL_TITLE;
}

function resolveChannelAvatarUrl(channelId: string, state: PreviewState): string | null {
  return state.channels.find((item) => item.id === channelId)?.avatarUrl ?? null;
}

function buildPreviewDialogAttachments(
  attachments: Array<{
    type: 'image' | 'file';
    base64: string;
    mimeType: string;
    fileName: string;
  }> = [],
): ChannelDialogMessage['attachments'] {
  return attachments.map((attachment) => ({
    kind: attachment.type,
    url: `data:${attachment.mimeType};base64,${attachment.base64}`,
    previewUrl: `data:${attachment.mimeType};base64,${attachment.base64}`,
    fileName: attachment.fileName || null,
    mimeType: attachment.mimeType || null,
    size: Math.max(0, Math.floor((attachment.base64.length * 3) / 4)),
    ...(attachment.type === 'image'
      ? {
          width: 120,
          height: 120,
        }
      : {}),
  }));
}

function buildPreviewDialogMessage(payload: {
  id: string;
  type: ChannelDialogType;
  text: string;
  textFormat?: ChannelDialogMessage['textFormat'];
  authorUserId: string;
  authorDisplayName: string | null;
  isAdmin?: boolean;
  avatarUrl?: string | null;
  createdAt: string;
  replyToMessageId?: string | null;
  replyTo?: ChannelDialogMessage['replyTo'];
  attachments?: ChannelDialogMessage['attachments'];
  reactionGroups?: ChannelDialogMessage['reactionGroups'];
  delivered?: boolean;
  deliveredToUserId?: string | null;
  reviewStatus?: ChannelDialogMessage['reviewStatus'];
  publishedUrl?: string | null;
  hasImage?: boolean;
  imageCount?: number;
  imageFileName?: string | null;
  imageFileNames?: string[];
}): ChannelDialogMessage {
  return channelDialogMessageSchema.parse({
    id: payload.id,
    type: payload.type,
    text: payload.text,
    ...(payload.textFormat !== undefined ? { textFormat: payload.textFormat } : {}),
    authorUserId: payload.authorUserId,
    authorDisplayName: payload.authorDisplayName,
    isAdmin: payload.isAdmin ?? payload.authorUserId.startsWith('preview-admin'),
    avatarUrl: payload.avatarUrl ?? null,
    createdAt: payload.createdAt,
    ...(payload.replyToMessageId !== undefined
      ? { replyToMessageId: payload.replyToMessageId }
      : {}),
    ...(payload.replyTo !== undefined ? { replyTo: payload.replyTo } : {}),
    ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
    ...(payload.reactionGroups !== undefined ? { reactionGroups: payload.reactionGroups } : {}),
    ...(payload.delivered !== undefined ? { delivered: payload.delivered } : {}),
    ...(payload.deliveredToUserId !== undefined
      ? { deliveredToUserId: payload.deliveredToUserId }
      : {}),
    ...(payload.reviewStatus !== undefined ? { reviewStatus: payload.reviewStatus } : {}),
    ...(payload.publishedUrl !== undefined ? { publishedUrl: payload.publishedUrl } : {}),
    ...(payload.hasImage !== undefined ? { hasImage: payload.hasImage } : {}),
    ...(payload.imageCount !== undefined ? { imageCount: payload.imageCount } : {}),
    ...(payload.imageFileName !== undefined ? { imageFileName: payload.imageFileName } : {}),
    ...(payload.imageFileNames !== undefined ? { imageFileNames: payload.imageFileNames } : {}),
  });
}

function decoratePreviewDialogMessageAccess(
  message: ChannelDialogMessage,
  viewerUserId: string,
): ChannelDialogMessage {
  const isOwnMessage = message.authorUserId === viewerUserId;
  const viewerIsAdmin = viewerUserId.startsWith('preview-admin');

  return channelDialogMessageSchema.parse({
    ...message,
    canEdit: message.type === 'comments' && isOwnMessage,
    canDelete: message.type === 'comments' && isOwnMessage,
    canDeleteAsAdmin: message.type === 'comments' && !isOwnMessage && viewerIsAdmin,
  });
}

function findPreviewDialogMessage(
  bucket: PreviewDialogBucket,
  messageId: string | null | undefined,
): ChannelDialogMessage | null {
  const normalizedMessageId = messageId?.trim() ?? '';
  if (!normalizedMessageId) {
    return null;
  }

  return bucket.messages.find((message) => message.id === normalizedMessageId) ?? null;
}

function getPreviewDialogBucket(
  state: PreviewState,
  entityType: 'chat' | 'channel',
  dialogType: ChannelDialogType,
  token: string | null | undefined,
): PreviewDialogBucket {
  const normalizedToken = token?.trim() ?? '';
  const baseBuckets = entityType === 'channel' ? state.channelDialogs : state.chatDialogs;

  if (!normalizedToken) {
    return baseBuckets[dialogType];
  }

  const threadBuckets =
    entityType === 'channel' ? state.channelDialogThreads : state.chatDialogThreads;
  const bucketsForType =
    threadBuckets[dialogType] ??
    ((threadBuckets[dialogType] = {}) as Record<string, PreviewDialogBucket>);
  const existingBucket = bucketsForType[normalizedToken];
  if (existingBucket) {
    return existingBucket;
  }

  const nextBucket = cloneJson(baseBuckets[dialogType]);
  bucketsForType[normalizedToken] = nextBucket;
  return nextBucket;
}

function togglePreviewDialogReaction(
  bucket: PreviewDialogBucket,
  messageId: string,
  emoji: string,
): ChannelDialogMessage {
  const nextMessages = bucket.messages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }

    const existingGroups = message.reactionGroups ?? [];
    const reactedEmoji = existingGroups.find((group) => group.reactedByMe)?.emoji ?? null;
    const nextGroups = existingGroups
      .map((group) => {
        if (group.reactedByMe) {
          const nextCount = group.count - 1;
          return nextCount > 0 ? { ...group, count: nextCount, reactedByMe: false } : null;
        }

        if (reactedEmoji === emoji || group.emoji !== emoji) {
          return group;
        }

        return {
          ...group,
          count: group.count + 1,
          reactedByMe: true,
        };
      })
      .filter((group): group is NonNullable<typeof group> => group !== null);

    if (reactedEmoji !== emoji && !nextGroups.some((group) => group.emoji === emoji)) {
      nextGroups.push({
        emoji,
        count: 1,
        reactedByMe: true,
      });
    }

    const normalizedGroups = nextGroups.sort(
      (left, right) => right.count - left.count || left.emoji.localeCompare(right.emoji),
    );

    return channelDialogMessageSchema.parse({
      ...message,
      reactionGroups: normalizedGroups,
    });
  });

  bucket.messages = nextMessages;
  return bucket.messages.find((message) => message.id === messageId) ?? bucket.messages.at(-1)!;
}

function updatePreviewDialogMessage(
  bucket: PreviewDialogBucket,
  messageId: string,
  text: string,
): ChannelDialogMessage {
  const editedAt = new Date().toISOString();
  const nextMessages = bucket.messages.map((message) =>
    message.id === messageId
      ? channelDialogMessageSchema.parse({
          ...message,
          text,
          editedAt,
        })
      : message,
  );

  bucket.messages = nextMessages;
  return bucket.messages.find((message) => message.id === messageId) ?? bucket.messages.at(-1)!;
}

function deletePreviewDialogMessage(bucket: PreviewDialogBucket, messageId: string): boolean {
  const previousLength = bucket.messages.length;
  bucket.messages = bucket.messages.filter((message) => message.id !== messageId);
  return bucket.messages.length < previousLength;
}

function buildPreviewNotificationSettings(bucket: PreviewDialogBucket) {
  const threadMode = bucket.threadNotificationMode ?? bucket.notificationMode ?? 'off';
  const channelMode = bucket.channelNotificationMode ?? 'off';
  const allChannelsMode = bucket.allChannelsNotificationMode ?? 'off';
  const threadExplicit =
    bucket.threadNotificationExplicit ??
    (bucket.threadNotificationMode !== undefined || bucket.notificationMode !== undefined);
  const channelExplicit = bucket.channelNotificationExplicit ?? false;
  const allChannelsExplicit = bucket.allChannelsNotificationExplicit ?? false;
  const scope = bucket.notificationScope ?? 'thread';
  const mode =
    scope === 'all_channels' ? allChannelsMode : scope === 'channel' ? channelMode : threadMode;

  return {
    mode,
    canUseAll: true,
    scope,
    thread: {
      mode: threadMode,
      explicit: threadExplicit,
    },
    channel: {
      mode: channelMode,
      explicit: channelExplicit,
    },
    allChannels: {
      mode: allChannelsMode,
      explicit: allChannelsExplicit,
    },
    availableChannelCount: 3,
  } as const;
}

function buildPreviewDialogResponse(
  chatId: string,
  dialogType: ChannelDialogType,
  bucket: PreviewDialogBucket,
  viewerUserId: string,
): ChannelDialogResponse {
  const previewThreadVariant =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('thread')?.trim().toLowerCase()
      : null;
  const normalizedBucket =
    dialogType === 'comments' && previewThreadVariant === 'empty'
      ? {
          ...bucket,
          messages: [],
        }
      : dialogType === 'comments' && previewThreadVariant === 'short'
        ? {
            ...bucket,
            messages: bucket.messages.slice(-2),
          }
        : bucket;

  return channelDialogResponseSchema.parse({
    chatId,
    type: dialogType,
    introText: normalizedBucket.introText,
    messages: normalizedBucket.messages.map((message) =>
      decoratePreviewDialogMessageAccess(message, viewerUserId),
    ),
    notificationSettings: buildPreviewNotificationSettings(normalizedBucket),
  });
}

function buildPreviewAvatarDataUrl(label: string, startColor: string, endColor: string): string {
  const initials = buildAuthorBadge(label);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
      <defs>
        <linearGradient id="avatar-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${startColor}" />
          <stop offset="100%" stop-color="${endColor}" />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="28" fill="url(#avatar-gradient)" />
      <text
        x="50%"
        y="52%"
        dominant-baseline="middle"
        text-anchor="middle"
        font-family="Manrope, Arial, sans-serif"
        font-size="34"
        font-weight="700"
        fill="#ffffff"
      >${initials}</text>
    </svg>
  `.trim();

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function buildPreviewProfileUrl(handle: string): string {
  return `https://max.ru/${encodeURIComponent(handle)}`;
}

function buildPreviewProfileHandoffUrl(seed: string): string {
  return `https://max.ru/id613002203036_bot?start=${encodeURIComponent(`preview-profile-${seed}`)}`;
}

function createActivityItems(
  prefix: string,
  names: string[],
  now: Date,
  offsetsHours: number[],
): MembershipActivityItem[] {
  const avatarPalette = [
    ['#4d94ff', '#2b64dd'],
    ['#3cc58b', '#0f9f70'],
    ['#f1a44b', '#ea7b4b'],
    ['#7f7dff', '#5350da'],
  ] as const;

  return offsetsHours
    .map((offsetHours, index) => {
      const displayName = names[index % names.length] ?? `Участник ${index + 1}`;
      const [startColor, endColor] = avatarPalette[index % avatarPalette.length] ?? [
        '#4d94ff',
        '#2b64dd',
      ];

      return {
        id: `${prefix}-${index + 1}`,
        type: (index % 3 === 1 ? 'left' : 'joined') as MembershipActivityItem['type'],
        userId: `${prefix}-user-${index + 1}`,
        userDisplayName: displayName,
        avatarUrl: buildPreviewAvatarDataUrl(displayName, startColor, endColor),
        profileUrl: buildPreviewProfileUrl(`${prefix}-profile-${index + 1}`),
        profileHandoffUrl: buildPreviewProfileHandoffUrl(`${prefix}-${index + 1}`),
        createdAt: addHours(now, -offsetHours).toISOString(),
      };
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function createParticipantsItems(prefix: string, count: number): ChatParticipantItem[] {
  const avatarPalette = [
    ['#4d94ff', '#2b64dd'],
    ['#3cc58b', '#0f9f70'],
    ['#f1a44b', '#ea7b4b'],
    ['#7f7dff', '#5350da'],
    ['#ff82a8', '#eb577f'],
  ] as const;
  const names = [
    'Александра',
    'Марина Орлова',
    'Павел',
    'Ольга',
    'Наталья',
    'Илья',
    'Екатерина',
    'Артём',
    'Диана',
    'Юрий',
  ];
  const featuredParticipants = [
    null,
    null,
    null,
    null,
    {
      userId: 'preview-spammer-1',
      userDisplayName: 'Сергей Маркет',
      username: 'sergey-market',
    },
    {
      userId: 'preview-spammer-2',
      userDisplayName: 'Мария Ссылкина',
      username: 'maria-links',
    },
    {
      userId: 'preview-user-3',
      userDisplayName: 'Антон',
      username: 'anton-preview',
    },
    {
      userId: 'preview-user-4',
      userDisplayName: 'Инфо Буст',
      username: 'info-boost',
    },
    {
      userId: 'preview-user-5',
      userDisplayName: 'Юлия',
      username: 'yulia-preview',
    },
    {
      userId: 'preview-user-6',
      userDisplayName: 'Олег Повтор',
      username: 'oleg-repeat',
    },
  ] as const;

  return Array.from({ length: count }, (_, index) => {
    const featuredParticipant = featuredParticipants[index] ?? null;
    const displayName =
      featuredParticipant?.userDisplayName ??
      names[index % names.length] ??
      `Участник ${index + 1}`;
    const [startColor, endColor] = avatarPalette[index % avatarPalette.length] ?? [
      '#4d94ff',
      '#2b64dd',
    ];
    const role =
      index === 0 ? 'owner' : index < 4 ? 'admin' : ('member' as ChatParticipantItem['role']);
    const isBot = index === count - 1 || index === count - 2;
    const username = isBot
      ? `helper_${index + 1}_bot`
      : (featuredParticipant?.username ?? `preview_member_${index + 1}`);
    const label = isBot ? (index === count - 1 ? 'Рэкс' : 'Майор Максимова') : displayName;
    const immunity =
      !isBot && index === 4
        ? createPreviewImmunity(72, 5, 1)
        : !isBot && index === 7
          ? createPreviewAlwaysImmunity()
          : null;

    return {
      userId: isBot
        ? `${prefix}-member-${index + 1}_bot`
        : (featuredParticipant?.userId ?? `${prefix}-member-${index + 1}`),
      userDisplayName: label,
      username,
      avatarUrl: buildPreviewAvatarDataUrl(label, startColor, endColor),
      profileUrl: buildPreviewProfileUrl(username),
      profileHandoffUrl: buildPreviewProfileHandoffUrl(`${prefix}-member-${index + 1}`),
      violationCount: 0,
      immunity,
      role: isBot ? 'admin' : role,
      isBot,
    };
  });
}

function createChatViolations(now: Date): LogsDashboardResponse['violations'] {
  const base = [
    {
      id: 'violation-1',
      action: 'MUTE' as const,
      ruleCode: 'COMMERCIAL_AD',
      userId: 'preview-spammer-1',
      userDisplayName: 'Сергей Маркет',
      avatarUrl: buildPreviewAvatarDataUrl('Сергей Маркет', '#4d94ff', '#2b64dd'),
      profileUrl: buildPreviewProfileUrl('sergey-market'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('sergey-market'),
      createdAt: addHours(now, -1.5).toISOString(),
      maskedExcerpt: 'Переходите по ссылке и получайте скидку ***',
      metadata: { muteDurationHours: 24, muteExpiresAt: addHours(now, 22.5).toISOString() },
    },
    {
      id: 'violation-2',
      action: 'DELETE_MESSAGE' as const,
      ruleCode: 'LINK_BLOCKED',
      userId: 'preview-spammer-2',
      userDisplayName: 'Мария Ссылкина',
      avatarUrl: buildPreviewAvatarDataUrl('Мария Ссылкина', '#3cc58b', '#0f9f70'),
      profileUrl: buildPreviewProfileUrl('maria-links'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('maria-links'),
      createdAt: addHours(now, -3.2).toISOString(),
      maskedExcerpt: 'Подписывайтесь на мой канал ***',
      metadata: null,
    },
    {
      id: 'violation-3',
      action: 'WARN' as const,
      ruleCode: 'PROFANITY',
      userId: 'preview-user-3',
      userDisplayName: 'Антон',
      avatarUrl: buildPreviewAvatarDataUrl('Антон', '#7f7dff', '#5350da'),
      profileUrl: buildPreviewProfileUrl('anton-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('anton-preview'),
      createdAt: addHours(now, -6.8).toISOString(),
      maskedExcerpt: 'Это было очень ***',
      metadata: null,
    },
    {
      id: 'violation-4',
      action: 'BAN' as const,
      ruleCode: 'GLOBAL_CROSS_CHAT_SPAM',
      userId: 'preview-user-4',
      userDisplayName: 'Инфо Буст',
      avatarUrl: buildPreviewAvatarDataUrl('Инфо Буст', '#f1a44b', '#ea7b4b'),
      profileUrl: buildPreviewProfileUrl('info-boost'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('info-boost'),
      createdAt: addHours(now, -14.1).toISOString(),
      maskedExcerpt: 'Повторный оффер с внешней ссылкой ***',
      metadata: null,
    },
    {
      id: 'violation-5',
      action: 'DELETE_MESSAGE' as const,
      ruleCode: 'MESSAGE_TOO_LONG',
      userId: 'preview-user-5',
      userDisplayName: 'Юлия',
      avatarUrl: buildPreviewAvatarDataUrl('Юлия', '#ff82a8', '#eb577f'),
      profileUrl: buildPreviewProfileUrl('yulia-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('yulia-preview'),
      createdAt: addHours(now, -27).toISOString(),
      maskedExcerpt: 'Очень длинное сообщение ***',
      metadata: null,
    },
    {
      id: 'violation-6',
      action: 'MUTE' as const,
      ruleCode: 'DUPLICATE_BAN',
      userId: 'preview-user-6',
      userDisplayName: 'Олег Повтор',
      avatarUrl: buildPreviewAvatarDataUrl('Олег Повтор', '#7db8ff', '#4d89ff'),
      profileUrl: buildPreviewProfileUrl('oleg-repeat'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('oleg-repeat'),
      createdAt: addHours(now, -42).toISOString(),
      maskedExcerpt: 'Одинаковый текст ***',
      metadata: { muteDurationHours: 12, muteExpiresAt: addHours(now, -30).toISOString() },
    },
    {
      id: 'violation-7',
      action: 'DELETE_MESSAGE' as const,
      ruleCode: 'NIGHT_MODE_DELETE',
      userId: 'preview-user-7',
      userDisplayName: 'Ночной гость',
      avatarUrl: buildPreviewAvatarDataUrl('Ночной гость', '#485a7b', '#22344f'),
      profileUrl: buildPreviewProfileUrl('night-guest'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('night-guest'),
      createdAt: addHours(now, -73).toISOString(),
      maskedExcerpt: 'Сообщение ночью ***',
      metadata: null,
    },
    {
      id: 'violation-8',
      action: 'WARN' as const,
      ruleCode: 'THEMATIC_FILTER',
      userId: 'preview-user-8',
      userDisplayName: 'Павел',
      avatarUrl: buildPreviewAvatarDataUrl('Павел', '#5ab7b5', '#1b7f8a'),
      profileUrl: buildPreviewProfileUrl('pavel-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('pavel-preview'),
      createdAt: addHours(now, -110).toISOString(),
      maskedExcerpt: 'Не по теме ***',
      metadata: null,
    },
    {
      id: 'violation-9',
      action: 'NONE' as const,
      ruleCode: 'MANUAL_UNBAN',
      userId: 'preview-user-9',
      userDisplayName: 'Ольга',
      avatarUrl: buildPreviewAvatarDataUrl('Ольга', '#f1a44b', '#ea7b4b'),
      profileUrl: buildPreviewProfileUrl('olga-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('olga-preview'),
      createdAt: addHours(now, -180).toISOString(),
      maskedExcerpt: null,
      metadata: null,
    },
    {
      id: 'violation-10',
      action: 'MUTE' as const,
      ruleCode: 'MANUAL_MUTE',
      userId: 'preview-user-10',
      userDisplayName: 'Андрей',
      avatarUrl: buildPreviewAvatarDataUrl('Андрей', '#4d94ff', '#2b64dd'),
      profileUrl: buildPreviewProfileUrl('andrey-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('andrey-preview'),
      createdAt: addHours(now, -220).toISOString(),
      maskedExcerpt: null,
      metadata: null,
    },
  ];

  return base.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function createEmptyPublicationDeliveryStats(): PublicationDeliveryStats {
  return {
    total: 0,
    pending: 0,
    sent: 0,
    failed: 0,
    ambiguous: 0,
    canceled: 0,
  };
}

function buildPreviewPublicationDeliveryStats(
  deliveries: readonly PublicationDelivery[],
): PublicationDeliveryStats {
  return deliveries.reduce<PublicationDeliveryStats>((stats, delivery) => {
    stats.total += 1;
    if (delivery.status === 'PENDING' || delivery.status === 'SENDING') {
      stats.pending += 1;
    } else if (delivery.status === 'SENT') {
      stats.sent += 1;
    } else if (delivery.status === 'FAILED') {
      stats.failed += 1;
    } else if (delivery.status === 'AMBIGUOUS') {
      stats.ambiguous += 1;
    } else if (delivery.status === 'CANCELED') {
      stats.canceled += 1;
    }
    return stats;
  }, createEmptyPublicationDeliveryStats());
}

function resolvePreviewPublicationTarget(
  state: PreviewState,
  target: { chatId: string; entityType: 'chat' | 'channel' },
): PublicationTarget {
  const source =
    target.entityType === 'channel'
      ? state.channels.find((item) => item.id === target.chatId)
      : state.chats.find((item) => item.id === target.chatId);
  return {
    chatId: target.chatId,
    entityType: target.entityType,
    title:
      source?.title ??
      (target.entityType === 'channel'
        ? resolveChannelTitle(target.chatId, state)
        : resolveChatTitle(target.chatId, state)),
    avatarUrl: source?.avatarUrl ?? null,
    link: source?.link ?? null,
  };
}

function buildPreviewPublicationAssets(
  publicationId: string,
  content: PublicationContentInput,
  retainedAssets: readonly PublicationAsset[] = [],
): PublicationAsset[] {
  const retainedById = new Map(retainedAssets.map((asset) => [asset.id, asset]));
  return content.media.map((media, index) => {
    if (media.type === 'image-ref' || media.type === 'video-ref') {
      const retained = retainedById.get(media.assetId);
      if (retained) {
        return retained;
      }
      return {
        id: media.assetId,
        type: media.type === 'video-ref' ? 'video' : 'image',
        mimeType: media.type === 'video-ref' ? 'video/mp4' : 'image/jpeg',
        fileName: '',
        sizeBytes: 0,
      };
    }

    return {
      id: `${publicationId}-asset-${index + 1}`,
      type: media.type,
      mimeType: media.mimeType,
      fileName: media.fileName,
      sizeBytes:
        media.type === 'image' || (media.type === 'video' && media.base64)
          ? Math.max(1, Math.floor((media.base64.replace(/=+$/u, '').length * 3) / 4))
          : 0,
    };
  });
}

function readPreviewScheduleInput(
  schedule: PublicationDetails['schedule'],
): PublicationScheduleInput | null {
  if (!schedule) {
    return null;
  }
  if (schedule.mode === 'now') {
    return { mode: 'now', timezone: schedule.timezone };
  }
  if (schedule.mode === 'once') {
    return {
      mode: 'once',
      timezone: schedule.timezone,
      at: schedule.at,
      replaceConflicts: schedule.replaceConflicts,
    };
  }
  if (schedule.mode === 'slots') {
    return {
      mode: 'slots',
      timezone: schedule.timezone,
      slots: schedule.slots,
      replaceConflicts: schedule.replaceConflicts,
    };
  }
  return {
    mode: 'recurrence',
    timezone: schedule.timezone,
    frequency: schedule.frequency,
    interval: schedule.interval,
    weekdays: schedule.weekdays,
    times: schedule.times,
    startsAt: schedule.startsAt,
    endsAt: schedule.endsAt,
    maxOccurrences: schedule.maxOccurrences,
    replaceConflicts: schedule.replaceConflicts,
  };
}

function buildPreviewRecurrenceSlots(
  schedule: Extract<PublicationScheduleInput, { mode: 'recurrence' }>,
  now: Date,
): string[] {
  const count = Math.min(4, schedule.maxOccurrences ?? 4);
  const [hours = 10, minutes = 0] = (schedule.times[0] ?? '10:00')
    .split(':')
    .map((value) => Number.parseInt(value, 10));
  const start = schedule.startsAt ? new Date(schedule.startsAt) : addDays(now, 1);
  const safeStart =
    Number.isFinite(start.getTime()) && start.getTime() > now.getTime() ? start : addDays(now, 1);
  safeStart.setUTCHours((hours + 21) % 24, minutes, 0, 0);

  return Array.from({ length: count }, (_, index) => {
    const stepDays = schedule.frequency === 'weekly' ? 7 * schedule.interval : schedule.interval;
    return addDays(safeStart, index * stepDays).toISOString();
  }).filter((slot) => !schedule.endsAt || Date.parse(slot) <= Date.parse(schedule.endsAt));
}

function buildPreviewPublicationSlots(
  schedule: PublicationScheduleInput | null,
  now: Date,
): string[] {
  if (!schedule) {
    return [];
  }
  if (schedule.mode === 'now') {
    return [now.toISOString()];
  }
  if (schedule.mode === 'once') {
    return [schedule.at];
  }
  if (schedule.mode === 'slots') {
    return schedule.slots;
  }
  return buildPreviewRecurrenceSlots(schedule, now);
}

function buildPreviewPublicationDetails(
  state: PreviewState,
  request: Omit<CreatePublicationRequest, 'requestId'>,
  options: {
    id: string;
    now?: Date;
    createdAt?: string;
    updatedAt?: string;
    version?: number;
    retainedAssets?: readonly PublicationAsset[];
  },
): { publication: PublicationDetails; deliveries: PublicationDelivery[] } {
  const now = options.now ?? new Date();
  const targets = request.audience.targets.map((target) =>
    resolvePreviewPublicationTarget(state, target),
  );
  const assets = buildPreviewPublicationAssets(options.id, request.content, options.retainedAssets);
  const slots =
    request.intent === 'publish' ? buildPreviewPublicationSlots(request.schedule, now) : [];
  const occurrences = slots.map((scheduledAt, occurrenceIndex) => ({
    id: `${options.id}-occurrence-${occurrenceIndex + 1}`,
    scheduledAt,
    status: 'SCHEDULED' as const,
    delivery: createEmptyPublicationDeliveryStats(),
    canRetry: false,
  }));
  const deliveries = occurrences.flatMap((occurrence) =>
    targets.map(
      (target, targetIndex): PublicationDelivery => ({
        id: `${occurrence.id}-delivery-${targetIndex + 1}`,
        occurrenceId: occurrence.id,
        target,
        status: 'PENDING',
        attemptCount: 0,
        remoteMessageId: null,
        lastError: null,
        sentAt: null,
      }),
    ),
  );
  const delivery = buildPreviewPublicationDeliveryStats(deliveries);
  const createdAt = options.createdAt ?? now.toISOString();
  const updatedAt = options.updatedAt ?? createdAt;
  const lifecycle = request.intent === 'draft' ? 'DRAFT' : 'ACTIVE';
  const schedule = request.schedule
    ? {
        ...request.schedule,
        status: request.intent === 'draft' ? ('DRAFT' as const) : ('ACTIVE' as const),
        revision: 1,
        nextOccurrenceAt: occurrences[0]?.scheduledAt ?? null,
        lastError: null,
      }
    : null;

  const publication = publicationDetailsSchema.parse({
    id: options.id,
    title: request.title,
    lifecycle,
    version: options.version ?? 1,
    contentPreview: request.content.text.trim().slice(0, 160),
    targetCount: targets.length,
    targetPreviews: targets.slice(0, 6),
    targetOverflowCount: Math.max(0, targets.length - 6),
    audienceSelection: request.audience.selection,
    audienceMode: request.audience.mode,
    mediaCount: assets.length,
    hasVideo: assets.some((asset) => asset.type === 'video'),
    schedule,
    delivery,
    createdAt,
    updatedAt,
    content: {
      revision: options.version ?? 1,
      text: request.content.text,
      textFormat: request.content.textFormat,
      buttons: request.content.buttons,
      media: assets,
    },
    targets,
    occurrences,
  });
  return { publication, deliveries };
}

function syncPreviewPublication(state: PreviewState, publicationId: string): PublicationDetails {
  const current = state.publications.find((publication) => publication.id === publicationId);
  if (!current) {
    throw new Error(`Preview publication not found: ${publicationId}`);
  }

  const occurrenceIds = new Set(current.occurrences.map((occurrence) => occurrence.id));
  const publicationDeliveries = state.publicationDeliveries.filter((delivery) =>
    occurrenceIds.has(delivery.occurrenceId),
  );
  const occurrences = current.occurrences.map((occurrence) => {
    const deliveries = publicationDeliveries.filter(
      (delivery) => delivery.occurrenceId === occurrence.id,
    );
    const delivery = buildPreviewPublicationDeliveryStats(deliveries);
    const status =
      delivery.ambiguous > 0
        ? ('AMBIGUOUS' as const)
        : delivery.failed > 0 && delivery.sent > 0
          ? ('PARTIAL' as const)
          : delivery.failed > 0
            ? ('FAILED' as const)
            : delivery.pending > 0
              ? occurrence.status === 'IN_PROGRESS'
                ? ('IN_PROGRESS' as const)
                : ('SCHEDULED' as const)
              : delivery.sent > 0
                ? ('SENT' as const)
                : occurrence.status;
    return {
      ...occurrence,
      status,
      delivery,
      canRetry: delivery.failed > 0,
    };
  });
  const nextOccurrenceAt =
    occurrences
      .filter(
        (occurrence) => occurrence.status === 'SCHEDULED' || occurrence.status === 'IN_PROGRESS',
      )
      .sort((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt))[0]
      ?.scheduledAt ?? null;
  const publication = publicationDetailsSchema.parse({
    ...current,
    schedule: current.schedule
      ? {
          ...current.schedule,
          nextOccurrenceAt,
        }
      : null,
    delivery: buildPreviewPublicationDeliveryStats(publicationDeliveries),
    occurrences,
  });
  state.publications = state.publications.map((item) =>
    item.id === publicationId ? publication : item,
  );
  return publication;
}

function createPreviewPublications(
  state: PreviewState,
  now: Date,
): { publications: PublicationDetails[]; deliveries: PublicationDelivery[] } {
  const fixtures: Array<{
    request: Omit<CreatePublicationRequest, 'requestId'>;
    id: string;
    createdAt: string;
  }> = [
    {
      id: 'publication-neighborhood-digest',
      createdAt: addDays(now, -6).toISOString(),
      request: {
        title: 'Утренний дайджест',
        content: {
          text: '**Доброе утро!** Собрали главные новости района и полезные объявления.',
          textFormat: 'markdown',
          buttons: [{ text: 'Открыть дайджест', url: 'https://max.ru/', row: 0 }],
          media: [],
        },
        audience: {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: [
            { chatId: PREVIEW_CHAT_ID, entityType: 'chat' },
            { chatId: PREVIEW_CHANNEL_ID, entityType: 'channel' },
          ],
        },
        schedule: {
          mode: 'recurrence',
          timezone: 'Europe/Moscow',
          frequency: 'weekly',
          interval: 1,
          weekdays: [1, 3, 5],
          times: ['09:00'],
          startsAt: addHours(now, 3).toISOString(),
          endsAt: null,
          maxOccurrences: 30,
          replaceConflicts: false,
        },
        intent: 'publish',
      },
    },
    {
      id: 'publication-weekend-events',
      createdAt: addDays(now, -3).toISOString(),
      request: {
        title: 'Афиша выходных',
        content: {
          text: 'В субботу встречаемся на набережной. Начало в 12:00.',
          textFormat: 'markdown',
          buttons: [],
          media: [],
        },
        audience: {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: [{ chatId: 'preview-channel-2', entityType: 'channel' }],
        },
        schedule: {
          mode: 'slots',
          timezone: 'Europe/Moscow',
          slots: [addDays(now, 2).toISOString(), addDays(now, 9).toISOString()],
          replaceConflicts: false,
        },
        intent: 'publish',
      },
    },
    {
      id: 'publication-delivery-review',
      createdAt: addDays(now, -2).toISOString(),
      request: {
        title: 'Важное объявление',
        content: {
          text: 'Проверьте новый порядок въезда во двор с понедельника.',
          textFormat: 'markdown',
          buttons: [],
          media: [],
        },
        audience: {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: [{ chatId: 'preview-chat-2', entityType: 'chat' }],
        },
        schedule: {
          mode: 'once',
          timezone: 'Europe/Moscow',
          at: addHours(now, -2).toISOString(),
          replaceConflicts: false,
        },
        intent: 'publish',
      },
    },
    {
      id: 'publication-completed',
      createdAt: addDays(now, -8).toISOString(),
      request: {
        title: 'Итоги недели',
        content: {
          text: 'Спасибо всем, кто участвовал в субботнике. Фото уже в канале.',
          textFormat: 'markdown',
          buttons: [],
          media: [],
        },
        audience: {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: [{ chatId: PREVIEW_CHANNEL_ID, entityType: 'channel' }],
        },
        schedule: { mode: 'now', timezone: 'Europe/Moscow' },
        intent: 'publish',
      },
    },
  ];

  const built = fixtures.map((fixture) =>
    buildPreviewPublicationDetails(state, fixture.request, {
      id: fixture.id,
      now,
      createdAt: fixture.createdAt,
      updatedAt: fixture.createdAt,
    }),
  );
  const publications = built.map((item) => item.publication);
  const deliveries = built.flatMap((item) => item.deliveries);

  const paused = publications.find(
    (publication) => publication.id === 'publication-weekend-events',
  );
  if (paused?.schedule) {
    paused.lifecycle = 'PAUSED';
    paused.schedule.status = 'PAUSED';
  }
  const ambiguous = deliveries.find((delivery) =>
    delivery.occurrenceId.startsWith('publication-delivery-review-'),
  );
  if (ambiguous) {
    ambiguous.status = 'AMBIGUOUS';
    ambiguous.attemptCount = 1;
    ambiguous.lastError = 'MAX принял запрос, но ответ не получен.';
  }
  const review = publications.find(
    (publication) => publication.id === 'publication-delivery-review',
  );
  if (review) {
    review.lifecycle = 'ERROR';
  }
  const completed = publications.find((publication) => publication.id === 'publication-completed');
  if (completed) {
    completed.lifecycle = 'COMPLETED';
    if (completed.schedule) {
      completed.schedule.status = 'COMPLETED';
      completed.schedule.nextOccurrenceAt = null;
    }
    for (const delivery of deliveries.filter((item) =>
      item.occurrenceId.startsWith('publication-completed-'),
    )) {
      delivery.status = 'SENT';
      delivery.attemptCount = 1;
      delivery.remoteMessageId = 'preview-message-completed';
      delivery.sentAt = addDays(now, -8).toISOString();
    }
  }

  const previousPublications = state.publications;
  const previousDeliveries = state.publicationDeliveries;
  state.publications = publications;
  state.publicationDeliveries = deliveries;
  for (const publication of publications) {
    syncPreviewPublication(state, publication.id);
  }
  const result = {
    publications: state.publications,
    deliveries: state.publicationDeliveries,
  };
  state.publications = previousPublications;
  state.publicationDeliveries = previousDeliveries;
  return result;
}

function createInitialState(): PreviewState {
  const now = new Date();
  const chatSettings = chatSettingsSchema.parse({
    greetingEnabled: false,
    greetingBotMessageEnabled: false,
    greetingDeleteBotMessageEnabled: false,
    greetingDeleteBotMessageDelayMinutes: 2,
    greetingBotMessageText: 'Добро пожаловать в чат. Ознакомьтесь с правилами и пишите по делу.',
    greetingRulesButtonEnabled: false,
    linkPolicy: 'ALLOWLIST_ONLY',
    antiSpamEnabled: true,
    deleteSpammersEnabled: true,
    russianProfanityFilterEnabled: true,
    commercialAdsFilterEnabled: true,
    commercialAdsSensitivity: 'BALANCED',
    profanityWarnEnabled: true,
    textFiltersWarnEnabled: true,
    duplicateWarnEnabled: true,
    duplicateMuteEnabled: true,
    duplicateBanEnabled: true,
    antiDuplicateEnabled: true,
    nightModeEnabled: true,
    nightModeOpenMessageEnabled: true,
    nightModeOpenMessageText: 'Ночью чат закрыт. Напишите утром.',
    messageLimitsBlockedWords: ['казино', 'ставки', 'скидка'],
    messageLimitsBlockedDomains: ['casino.example', 'promo.example'],
    requiredSubscriptionEnabled: true,
    requiredSubscriptionChannelIds: [PREVIEW_CHANNEL_ID, 'preview-channel-2'],
    requiredSubscriptionBotMessageEnabled: true,
    requiredSubscriptionBotMessageText:
      'Для сообщений в этом чате нужна подписка на {channels}. Подпишитесь и отправьте сообщение ещё раз. Статус: {message_status}.',
    requiredSubscriptionWarnEnabled: true,
    requiredSubscriptionBanEnabled: true,
    requiredSubscriptionMuteEnabled: true,
    duplicateMuteDurationHours: 24,
    linkMuteDurationHours: 24,
    messageLimitsMuteDurationHours: 12,
    profanityMuteDurationHours: 6,
    requiredSubscriptionMuteDurationHours: 24,
    textFiltersMuteDurationHours: 24,
    thematicFiltersMuteDurationHours: 12,
    commentsEnabled: true,
    commentsAdminsEnabled: true,
    commentsAllEnabled: false,
    commentsChatBroadcastsEnabled: true,
    muteDurationHours: 12,
    warnThreshold: 2,
  });
  const chatRules = chatRulesSchema.parse({
    text: '1. Без рекламы.\n2. Без токсичности.\n3. Без повторов.\n4. Уважайте соседей.',
    autoTextEnabled: true,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    publishedMessageId: 'rules-preview-1',
    publishedUrl: 'https://max.ru/community/rules-preview',
    publishedAt: addHours(now, -26).toISOString(),
  });
  const chatDomains = [
    domainAllowlistEntrySchema.parse({
      domain: 'https://maxim.play-team.ru',
      normalizedValue: 'https://maxim.play-team.ru',
      matchType: 'EXACT',
      removeAfterAt: null,
    }),
    domainAllowlistEntrySchema.parse({
      domain: 'docs.max.ru',
      normalizedValue: 'domain:docs.max.ru',
      matchType: 'DOMAIN',
      removeAfterAt: addDays(now, 2).toISOString(),
    }),
  ];
  const chatBroadcasts = [
    managedBroadcastDetailsSchema.parse({
      id: 'broadcast-preview-1',
      status: 'ACTIVE',
      text: 'Напоминаем: в субботу уборка двора в 11:00. Приходите с перчатками.',
      textFormat: 'plain',
      targetMode: 'current',
      applyToAllChats: false,
      targetChatIds: [PREVIEW_CHAT_ID],
      buttons: [
        {
          text: 'Подробности',
          url: 'https://maxim.play-team.ru/help',
        },
      ],
      buttonEnabled: true,
      buttonUrl: 'https://maxim.play-team.ru/help',
      buttonText: 'Подробности',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      scheduledSlots: [
        addHours(now, 18).toISOString(),
        addDays(now, 1).toISOString(),
        addDays(now, 2).toISOString(),
      ],
      nextSendAt: addHours(now, 18).toISOString(),
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 3,
      sentCount: 1,
      currentOccurrence: 2,
      deliveredChats: 1,
      failedChats: 0,
      pendingChats: 0,
      blockedChats: 0,
      failureBreakdown: {
        transient: 0,
        permanentTarget: 0,
        quarantined: 0,
        unknown: 0,
      },
      canRetry: false,
      remainingCount: 2,
      createdAt: addHours(now, -36).toISOString(),
      updatedAt: addHours(now, -3).toISOString(),
      lastError: null,
    }),
  ];
  const chatGiveaways = [
    managedGiveawayDetailsSchema.parse({
      id: 'giveaway-chat-1',
      title: 'Субботний розыгрыш двора',
      status: 'DRAFT',
      hasImage: false,
      entriesCount: 0,
      verifiedEntriesCount: 0,
      pendingEntriesCount: 0,
      winnersCount: 10,
      startsAt: null,
      endsAt: addHours(now, 30).toISOString(),
      publishedAt: null,
      completedAt: null,
      publicationUrl: null,
      resultsUrl: null,
      createdAt: addDays(now, -4).toISOString(),
      updatedAt: addHours(now, -1).toISOString(),
      sourceChatId: PREVIEW_CHAT_ID,
      entityType: 'chat',
      description:
        'Полностью пользовательский текст публикации из чат-бота. Без шаблонных дописок.',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      claimHours: 48,
      requiredChannelIds: [PREVIEW_CHANNEL_ID],
      publicationMessageId: null,
      resultsMessageId: null,
      prizes: Array.from({ length: 10 }, (_, index) => ({
        id: `prize-chat-${index + 1}`,
        position: index + 1,
        title: `Прикормка ${index + 1}`,
        displayTitle: 'Прикормка',
      })),
      winners: [],
    }),
  ];
  const channelSettings = channelSettingsSchema.parse({
    commentsEnabled: true,
    commentsModerationEnabled: true,
    commentsBlockLinksEnabled: true,
    commentsAntiSpamEnabled: true,
    commentsLimitTwoInRowEnabled: true,
    postSuggestionsEnabled: true,
    postSuggestionsText: 'Пришлите идею поста или важную новость для соседей.',
    postSuggestionsDailyLimit: 4,
    postSuggestionsEntryMode: 'MINIAPP',
    postSuggestionsButtonEnabled: true,
    postSuggestionsButtonText: 'Предложить пост',
    postSuggestionsButtonUrl: 'https://maxim.play-team.ru/suggest',
    engagementMessageText: 'Есть идея или обратная связь? Выберите действие ниже.',
    autoPostButtonsMode: 'BOTH',
  });
  const channelPolls = [
    managedPollDetailsSchema.parse({
      id: 'poll-channel-active',
      channelId: PREVIEW_CHANNEL_ID,
      question: '**Какой формат встреч** добавить в августе?',
      questionFormat: 'markdown',
      images: [],
      imageCount: 0,
      status: 'ACTIVE',
      visibility: 'OPEN',
      totalVotes: 24,
      options: [
        { id: 'poll-active-option-1', position: 0, text: 'Лекции', votes: 10, percent: 42 },
        { id: 'poll-active-option-2', position: 1, text: 'Практикумы', votes: 8, percent: 33 },
        { id: 'poll-active-option-3', position: 2, text: 'Экскурсии', votes: 6, percent: 25 },
      ],
      publicationPending: false,
      publicationNeedsReview: false,
      renderRepairNeeded: false,
      publicationUrl: 'https://max.ru/channels/yuzhnoe-news',
      publicationMessageId: 'poll-preview-message-active',
      publishedAt: addHours(now, -8).toISOString(),
      closedAt: null,
      createdAt: addHours(now, -10).toISOString(),
      updatedAt: addHours(now, -1).toISOString(),
      lastError: null,
      lastRenderError: null,
    }),
    managedPollDetailsSchema.parse({
      id: 'poll-channel-closed',
      channelId: PREVIEW_CHANNEL_ID,
      question: 'Какая тема для подборки полезнее?',
      questionFormat: 'plain',
      images: [],
      imageCount: 0,
      status: 'CLOSED',
      visibility: 'ANONYMOUS',
      totalVotes: 61,
      options: [
        { id: 'poll-closed-option-1', position: 0, text: 'События района', votes: 31, percent: 51 },
        {
          id: 'poll-closed-option-2',
          position: 1,
          text: 'Городские сервисы',
          votes: 18,
          percent: 29,
        },
        {
          id: 'poll-closed-option-3',
          position: 2,
          text: 'Истории соседей',
          votes: 12,
          percent: 20,
        },
      ],
      publicationPending: false,
      publicationNeedsReview: false,
      renderRepairNeeded: true,
      publicationUrl: 'https://max.ru/channels/yuzhnoe-news',
      publicationMessageId: 'poll-preview-message-closed',
      publishedAt: addDays(now, -7).toISOString(),
      closedAt: addDays(now, -5).toISOString(),
      createdAt: addDays(now, -8).toISOString(),
      updatedAt: addDays(now, -5).toISOString(),
      lastError: null,
      lastRenderError: 'Preview render repair required',
    }),
  ];
  const channelPollVoters = [
    ['poll-voter-1', 'poll-active-option-1', 'Анна Петрова', 'anna_pet'],
    ['poll-voter-2', 'poll-active-option-1', 'Максим Орлов', 'max_orlov'],
    ['poll-voter-3', 'poll-active-option-2', 'Елена', 'elena_city'],
    ['poll-voter-4', 'poll-active-option-2', 'Илья Соколов', 'ilya_s'],
    ['poll-voter-5', 'poll-active-option-3', 'Марина Волкова', 'marina_v'],
  ].map(([id, optionId, displayName, username], index) => ({
    id: id ?? `poll-voter-${index + 1}`,
    pollId: 'poll-channel-active',
    optionId: optionId ?? 'poll-active-option-1',
    userId: `preview-poll-user-${index + 1}`,
    displayName: displayName ?? null,
    username: username ?? null,
    votedAt: addHours(now, -(index + 1)).toISOString(),
    updatedAt: addHours(now, -(index + 1)).toISOString(),
  })) satisfies ManagedPollVoter[];
  const channelGiveaways = [
    managedGiveawayDetailsSchema.parse({
      id: 'giveaway-channel-1',
      title: 'Розыгрыш мерча',
      status: 'SCHEDULED',
      hasImage: false,
      entriesCount: 0,
      verifiedEntriesCount: 0,
      pendingEntriesCount: 0,
      winnersCount: 1,
      startsAt: addHours(now, 12).toISOString(),
      endsAt: addDays(now, 4).toISOString(),
      publishedAt: null,
      completedAt: null,
      publicationUrl: null,
      resultsUrl: null,
      createdAt: addDays(now, -2).toISOString(),
      updatedAt: addHours(now, -4).toISOString(),
      sourceChatId: PREVIEW_CHANNEL_ID,
      entityType: 'channel',
      description: 'Тестовый розыгрыш среди подписчиков канала.',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      claimHours: 24,
      requiredChannelIds: [PREVIEW_CHANNEL_ID],
      publicationMessageId: null,
      resultsMessageId: null,
      prizes: [
        {
          id: 'prize-channel-1',
          position: 1,
          title: 'Фирменная кружка',
          displayTitle: 'Фирменная кружка',
        },
      ],
      winners: [],
    }),
  ];
  const channelBroadcasts = [
    managedBroadcastDetailsSchema.parse({
      id: 'broadcast-channel-1',
      status: 'ACTIVE',
      text: 'Сегодня публикуем подборку событий района. Проверьте расписание и переходите в канал.',
      textFormat: 'markdown',
      targetMode: 'current',
      applyToAllChats: false,
      targetChatIds: [PREVIEW_CHANNEL_ID],
      buttons: [
        {
          text: 'Открыть канал',
          url: 'https://max.ru/channels/yuzhnoe-news',
        },
      ],
      buttonEnabled: true,
      buttonUrl: 'https://max.ru/channels/yuzhnoe-news',
      buttonText: 'Открыть канал',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      scheduledSlots: [
        addHours(now, 10).toISOString(),
        addHours(now, 14).toISOString(),
        addHours(now, 19).toISOString(),
        addDays(now, 1).toISOString(),
      ],
      nextSendAt: addHours(now, 10).toISOString(),
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 4,
      sentCount: 0,
      currentOccurrence: 1,
      deliveredChats: 0,
      failedChats: 0,
      pendingChats: 1,
      blockedChats: 0,
      failureBreakdown: {
        transient: 0,
        permanentTarget: 0,
        quarantined: 0,
        unknown: 0,
      },
      canRetry: false,
      remainingCount: 4,
      createdAt: addHours(now, -20).toISOString(),
      updatedAt: addHours(now, -1).toISOString(),
      lastError: null,
    }),
  ];
  const chatVkParsing = createPreviewVkParsingFeed(PREVIEW_CHAT_ID, now);
  const channelVkParsing = createPreviewVkParsingFeed(PREVIEW_CHANNEL_ID, now);
  const chatDialogs: Record<ChannelDialogType, PreviewDialogBucket> = {
    comments: {
      introText: '',
      messages: [
        buildPreviewDialogMessage({
          id: 'chat-comments-1',
          type: 'comments',
          text: 'Сделал компактную парковку для самокатов у 3-го подъезда. Проверьте, не мешает ли проходу.',
          authorUserId: 'preview-admin-2',
          authorDisplayName: 'Александр',
          avatarUrl: buildPreviewAvatarDataUrl('Александр', '#4d94ff', '#2b64dd'),
          createdAt: addHours(now, -5.2).toISOString(),
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-2',
          type: 'comments',
          text: 'Смотрится аккуратно. Если добавить отражатель со стороны дорожки, вечером будет безопаснее.',
          authorUserId: 'preview-user-8',
          authorDisplayName: 'Марина Орлова',
          avatarUrl: buildPreviewAvatarDataUrl('Марина Орлова', '#3cc58b', '#0f9f70'),
          createdAt: addHours(now, -4.8).toISOString(),
          reactionGroups: [
            { emoji: '👍', count: 3, reactedByMe: false },
            { emoji: '🔥', count: 1, reactedByMe: false },
          ],
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-3',
          type: 'comments',
          text: 'Поддерживаю. Утром с коляской стало свободнее, раньше самокаты лежали прямо у перил.',
          authorUserId: 'preview-user-4',
          authorDisplayName: 'Наталья',
          avatarUrl: buildPreviewAvatarDataUrl('Наталья', '#6aa8ff', '#3b7ef0'),
          createdAt: addHours(now, -4.5).toISOString(),
          reactionGroups: [{ emoji: '👀', count: 2, reactedByMe: true }],
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-attachment-1',
          type: 'comments',
          text: '',
          authorUserId: 'preview-user-7',
          authorDisplayName: 'Ольга',
          avatarUrl: buildPreviewAvatarDataUrl('Ольга', '#f1a44b', '#ea7b4b'),
          createdAt: addHours(now, -4.2).toISOString(),
          attachments: [
            {
              kind: 'file',
              url: 'https://example.test/protokol-sobraniya.pdf',
              previewUrl: 'https://example.test/protokol-sobraniya.pdf',
              fileName: 'protokol-sobraniya.pdf',
              mimeType: 'application/pdf',
              size: 184_000,
            },
          ],
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-4',
          type: 'comments',
          text: 'Добавлю светоотражающую ленту и перенесу стойку на полметра ближе к клумбе.',
          authorUserId: 'preview-admin-2',
          authorDisplayName: 'Александр',
          avatarUrl: buildPreviewAvatarDataUrl('Александр', '#4d94ff', '#2b64dd'),
          createdAt: addHours(now, -4.1).toISOString(),
          replyToMessageId: 'chat-comments-2',
          replyTo: {
            messageId: 'chat-comments-2',
            authorDisplayName: 'Марина Орлова',
            text: 'Смотрится аккуратно. Если добавить отражатель со стороны дорожки, вечером будет безопаснее.',
          },
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-5',
          type: 'comments',
          text: 'Отлично. Тогда оставим тестом на неделю и посмотрим, как поведёт себя поток вечером.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -3.9).toISOString(),
          reactionGroups: [{ emoji: '❤️', count: 4, reactedByMe: false }],
        }),
      ],
    },
    suggest: {
      introText:
        'Идеи для постов приходят тихо: участник отправляет карточку, редактор видит её в своей очереди.\n\nДобавьте короткий контекст, фото или видео, чтобы редактору было проще быстро принять решение.',
      messages: [
        buildPreviewDialogMessage({
          id: 'chat-suggest-1',
          type: 'suggest',
          text: 'Можно сделать короткий пост про новые контейнеры для батареек у офиса управляющей компании.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -7.2).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
          reviewStatus: 'pending',
        }),
        buildPreviewDialogMessage({
          id: 'chat-suggest-2',
          type: 'suggest',
          text: '',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -2.9).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
          reviewStatus: 'published',
          publishedUrl: 'https://max.ru/chats/preview-chat/message/220',
          hasImage: true,
          imageFileName: 'containers.webp',
        }),
      ],
    },
  };
  const channelDialogs: Record<ChannelDialogType, PreviewDialogBucket> = {
    comments: {
      introText: '',
      messages: [
        buildPreviewDialogMessage({
          id: 'channel-comments-1',
          type: 'comments',
          text: 'Спасибо за карту отключений. Наконец-то видно точный интервал по улице Сиреневой.',
          authorUserId: 'preview-user-11',
          authorDisplayName: 'Татьяна',
          avatarUrl: buildPreviewAvatarDataUrl('Татьяна', '#f1a44b', '#ea7b4b'),
          createdAt: addHours(now, -10.5).toISOString(),
        }),
        buildPreviewDialogMessage({
          id: 'channel-comments-2',
          type: 'comments',
          text: 'Если добавите следующий апдейт про развоз воды, закрепите его в начале треда.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -9.8).toISOString(),
          reactionGroups: [{ emoji: '👍', count: 6, reactedByMe: true }],
        }),
        buildPreviewDialogMessage({
          id: 'channel-comments-3',
          type: 'comments',
          text: 'Прикладываю кадр с перекрёстка, чтобы было понятнее, где образуется пробка.',
          authorUserId: 'preview-user-12',
          authorDisplayName: 'Ирина',
          avatarUrl: buildPreviewAvatarDataUrl('Ирина', '#6aa8ff', '#3b7ef0'),
          createdAt: addHours(now, -9.2).toISOString(),
          attachments: [
            {
              kind: 'image',
              url: buildPreviewAvatarDataUrl('Фото', '#dbe9ff', '#aacbff'),
              previewUrl: buildPreviewAvatarDataUrl('Фото', '#dbe9ff', '#aacbff'),
              fileName: 'traffic-photo.webp',
              mimeType: 'image/webp',
              size: 248_000,
              width: 1200,
              height: 900,
            },
          ],
        }),
      ],
    },
    suggest: {
      introText:
        'Предложение поста сразу уходит редактору канала.\n\nМожно приложить фото или видео и потом отследить статус прямо здесь.',
      messages: [
        buildPreviewDialogMessage({
          id: 'channel-suggest-1',
          type: 'suggest',
          text: 'Подборка ярмарок выходного дня отлично зайдёт на воскресенье утром.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -6.4).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
          reviewStatus: 'pending',
        }),
        buildPreviewDialogMessage({
          id: 'channel-suggest-2',
          type: 'suggest',
          text: 'Сделайте пост про вечерний маркет у набережной, люди всё ещё спрашивают время работы.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -3.1).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
          reviewStatus: 'published',
          publishedUrl: 'https://max.ru/chats/preview-channel/message/318',
        }),
        buildPreviewDialogMessage({
          id: 'channel-suggest-3',
          type: 'suggest',
          text: '',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -1.4).toISOString(),
          delivered: false,
          deliveredToUserId: null,
          reviewStatus: 'pending',
          hasImage: true,
          imageFileName: 'market-evening.webp',
        }),
        buildPreviewDialogMessage({
          id: 'channel-suggest-4',
          type: 'suggest',
          text: 'Можно собрать подборку новых кофеен у метро, но без цен это сейчас сыровато.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -0.8).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
          reviewStatus: 'cancelled',
        }),
      ],
    },
  };

  const state: PreviewState = {
    me: {
      userId: 'preview-admin',
      username: 'designer',
      displayName: 'Алексей',
      avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
      profileUrl: buildPreviewProfileUrl('designer'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('preview-admin'),
      canAccessSystem: true,
    },
    systemModeSelection: 'auto',
    chats: [
      createPreviewChatSummary({
        id: PREVIEW_CHAT_ID,
        title: PREVIEW_CHAT_TITLE,
        createdAt: addDays(now, -280).toISOString(),
        entityType: 'chat',
        link: null,
        avatarUrl: buildPreviewAvatarDataUrl(PREVIEW_CHAT_TITLE, '#20b7aa', '#117e87'),
        channelOverview: null,
        favoriteTypes: ['important'],
      }),
      createPreviewChatSummary({
        id: 'preview-chat-2',
        title: 'Клуб соседей',
        createdAt: addDays(now, -120).toISOString(),
        entityType: 'chat',
        link: null,
        avatarUrl: buildPreviewAvatarDataUrl('Клуб соседей', '#6a8cff', '#4b55dd'),
        channelOverview: null,
        favoriteTypes: ['broadcast'],
      }),
    ],
    channels: [
      createPreviewChatSummary({
        id: PREVIEW_CHANNEL_ID,
        title: PREVIEW_CHANNEL_TITLE,
        createdAt: addDays(now, -250).toISOString(),
        entityType: 'channel',
        link: 'https://max.ru/channels/yuzhnoe-news',
        avatarUrl: buildPreviewAvatarDataUrl(PREVIEW_CHANNEL_TITLE, '#4f69ff', '#2d3fd5'),
        channelOverview: {
          enabledScenariosCount: 2,
          commentsEnabled: true,
          postSuggestionsEnabled: true,
          commentsModerationEnabled: true,
        },
        favoriteTypes: ['service'],
      }),
      createPreviewChatSummary({
        id: 'preview-channel-2',
        title: 'Афиша района',
        createdAt: addDays(now, -90).toISOString(),
        entityType: 'channel',
        link: 'https://max.ru/channels/afisha',
        avatarUrl: buildPreviewAvatarDataUrl('Афиша района', '#7d56f6', '#5c2fd6'),
        channelOverview: {
          enabledScenariosCount: 1,
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
    ],
    chatHeaderParticipantsCount: 1_584,
    chatDialogs,
    chatDialogThreads: {},
    chatSettings,
    chatRules,
    chatDomains,
    chatBroadcasts,
    autopostRules: [],
    publications: [],
    publicationDeliveries: [],
    chatGiveaways,
    chatParticipants: createParticipantsItems('chat-roster', 48),
    chatActivity: createActivityItems(
      'chat-activity',
      ['Ольга Бойко', 'Юлия', 'Андрей Фёдоров', 'Марина', 'Александр', 'Наталья'],
      now,
      [
        0.3, 1.2, 2.8, 4.1, 6.7, 8.9, 10.5, 12.4, 14.3, 18.8, 23.5, 26.2, 31.7, 36.1, 44.2, 55.6,
        63.4, 78.5, 92.1, 110.4, 136.2, 158.7, 175.9, 212.8, 250.3, 310.1, 420.6, 560.8,
      ],
    ),
    chatViolations: createChatViolations(now),
    spammerReviewCandidates: createPreviewSpammerReviewCandidates(now),
    chatVkParsing,
    channelHeaderParticipantsCount: 9_240,
    channelDialogs,
    channelDialogThreads: {},
    channelSettings,
    channelPolls,
    channelPollVoters,
    channelBroadcasts,
    channelGiveaways,
    channelActivity: createActivityItems(
      'channel-activity',
      ['Владимир', 'Татьяна', 'Ирина', 'Дмитрий', 'Елена', 'Максим'],
      addHours(now, -1),
      [
        0.6, 1.4, 2.2, 3.8, 5.6, 7.3, 9.1, 11.8, 13.4, 17.7, 21.2, 26.5, 33.9, 40.2, 47.8, 58.1,
        70.3, 88.4, 112.6, 138.8, 166.2, 199.1, 240.5, 296.2, 352.7, 490.4,
      ],
    ),
    channelVkParsing,
    chatPrimaryBotId: PREVIEW_PRIMARY_BOT_ID,
    channelPrimaryBotId: PREVIEW_PRIMARY_BOT_ID,
    chatPartnerAssistEnabled: false,
    channelPartnerAssistEnabled: false,
  };

  state.autopostRules = [
    buildPreviewAutopostRule(state, {
      id: 'autopost-preview-soil',
      sourceChatId: PREVIEW_CHAT_ID,
      entityType: 'chat',
      title: 'Грунты',
      payload: managedAutopostPayloadSchema.parse({
        text: 'Проверенные грунты из садового чата: лёгкий универсальный и смесь для рассады.',
        textFormat: 'markdown',
        targetMode: 'current',
        targetChatIds: [PREVIEW_CHAT_ID],
        applyToAllChats: false,
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: [addHours(now, 18).toISOString(), addDays(now, 2).toISOString()],
      }),
      createdAt: addDays(now, -3).toISOString(),
      updatedAt: addHours(now, -3).toISOString(),
    }),
    buildPreviewAutopostRule(state, {
      id: 'autopost-preview-products',
      sourceChatId: PREVIEW_CHANNEL_ID,
      entityType: 'channel',
      title: 'Продукты',
      payload: managedAutopostPayloadSchema.parse({
        text: 'Продукты, которые беру домой сама: список на неделю и короткие заметки по качеству.',
        textFormat: 'markdown',
        targetMode: 'current',
        targetChatIds: [PREVIEW_CHANNEL_ID],
        applyToAllChats: false,
        buttons: [{ text: 'Список', url: 'https://maxim.play-team.ru/products' }],
        buttonEnabled: true,
        buttonUrl: 'https://maxim.play-team.ru/products',
        buttonText: 'Список',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: [addHours(now, 9).toISOString(), addDays(now, 1).toISOString()],
      }),
      createdAt: addDays(now, -4).toISOString(),
      updatedAt: addHours(now, -2).toISOString(),
    }),
  ];

  const publicationFixtures = createPreviewPublications(state, now);
  state.publications = publicationFixtures.publications;
  state.publicationDeliveries = publicationFixtures.deliveries;

  return state;
}

function buildChatSettingsScreen(state: PreviewState, chatId: string): ChatSettingsScreenResponse {
  const assignedBots = buildPreviewAssignedBots({
    primaryBotId: state.chatPrimaryBotId,
    assistEnabled: state.chatPartnerAssistEnabled,
  });
  return chatSettingsScreenResponseSchema.parse({
    settings: state.chatSettings,
    rules: state.chatRules,
    header: {
      id: chatId,
      title: resolveChatTitle(chatId, state),
      entityType: 'chat',
      link: null,
      participantsCount: state.chatHeaderParticipantsCount,
      avatarUrl: resolveChatAvatarUrl(chatId, state),
      primaryBotId: state.chatPrimaryBotId,
      assignedBots,
      sharedMode: buildPreviewSharedMode(state.chatPartnerAssistEnabled),
      botCount: assignedBots.length,
      hasSharedAutomation: assignedBots.length > 1,
    },
    requiredSubscriptionChannels: (state.chatSettings.requiredSubscriptionChannelIds ?? []).map(
      (channelId) => {
        const channel =
          state.channels.find((item) => item.id === channelId) ??
          state.chats.find((item) => item.id === channelId);
        return {
          id: channelId,
          title:
            channel?.title ??
            (channel?.entityType === 'chat'
              ? resolveChatTitle(channelId, state)
              : resolveChannelTitle(channelId, state)),
          entityType: channel?.entityType ?? 'channel',
          link: channel?.link ?? null,
          participantsCount: null,
          avatarUrl:
            channel?.avatarUrl ??
            (channel?.entityType === 'chat'
              ? resolveChatAvatarUrl(channelId, state)
              : resolveChannelAvatarUrl(channelId, state)),
          primaryBotId: channel?.primaryBotId ?? null,
          assignedBots: channel?.assignedBots ?? [],
          sharedMode: channel?.sharedMode ?? 'owned',
          botCount: channel?.botCount,
          hasSharedAutomation: channel?.hasSharedAutomation,
        };
      },
    ),
    domains: state.chatDomains,
    managedBroadcasts: state.chatBroadcasts.map(buildBroadcastSummary),
  });
}

function buildChannelSettingsScreen(
  state: PreviewState,
  channelId: string,
): ChannelSettingsScreenResponse {
  const assignedBots = buildPreviewAssignedBots({
    primaryBotId: state.channelPrimaryBotId,
    assistEnabled: state.channelPartnerAssistEnabled,
  });
  return channelSettingsScreenResponseSchema.parse({
    settings: state.channelSettings,
    header: {
      id: channelId,
      title: resolveChannelTitle(channelId, state),
      entityType: 'channel',
      link: 'https://max.ru/channels/yuzhnoe-news',
      participantsCount: state.channelHeaderParticipantsCount,
      avatarUrl: resolveChannelAvatarUrl(channelId, state),
      primaryBotId: state.channelPrimaryBotId,
      assignedBots,
      sharedMode: buildPreviewSharedMode(state.channelPartnerAssistEnabled),
      botCount: assignedBots.length,
      hasSharedAutomation: assignedBots.length > 1,
    },
    managedBroadcasts: state.channelBroadcasts.map(buildBroadcastSummary),
  });
}

function buildLogsDashboard(
  state: PreviewState,
  chatId: string,
  range: LogsDashboardRange,
  options: {
    includeActivityPreview?: boolean;
    includeModerationPreview?: boolean;
  } = {},
): LogsDashboardResponse {
  const now = new Date();
  const violations = state.chatViolations.filter((item) =>
    isWithinRange(item.createdAt, range, now),
  );
  const membershipItems = filterActivityItems(state.chatActivity, range, 'all', now);
  const joinedUsers = membershipItems.filter((item) => item.type === 'joined').length;
  const leftUsers = membershipItems.filter((item) => item.type === 'left').length;
  const summary = violations.reduce(
    (accumulator, item) => {
      if (item.ruleCode === 'MANUAL_UNMUTE') {
        accumulator.unmute += 1;
      } else if (item.ruleCode === 'MANUAL_UNBAN') {
        accumulator.unban += 1;
      } else if (item.action === 'WARN') {
        accumulator.warn += 1;
      } else if (item.action === 'DELETE_MESSAGE') {
        accumulator.deleteMessage += 1;
      } else if (item.action === 'MUTE') {
        accumulator.mute += 1;
      } else if (item.action === 'KICK' || item.action === 'BAN') {
        accumulator.ban += 1;
      }

      accumulator.users.add(item.userId);
      return accumulator;
    },
    {
      warn: 0,
      deleteMessage: 0,
      mute: 0,
      ban: 0,
      unmute: 0,
      unban: 0,
      users: new Set<string>(),
    },
  );
  const { from, to } = resolveRangeWindow(range, now);
  const includeActivityPreview = options.includeActivityPreview !== false;
  const includeModerationPreview = options.includeModerationPreview !== false;
  const moderationFeed = includeModerationPreview
    ? buildModerationFeedPage(
        state.chatViolations,
        {
          range,
          filter: 'ALL',
          limit: 50,
        },
        now,
      )
    : {
        items: [],
        hasMore: false,
        nextCursor: null,
      };
  const activityFeed = includeActivityPreview
    ? buildActivityPage(state.chatActivity, { range, limit: 50 }, now)
    : {
        items: [],
        hasMore: false,
        nextCursor: null,
      };

  return logsDashboardResponseSchema.parse({
    chat: {
      id: chatId,
      title: resolveChatTitle(chatId, state),
      participantsCount: state.chatHeaderParticipantsCount,
      avatarUrl: resolveChatAvatarUrl(chatId, state),
    },
    period: {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
    },
    membership: {
      joinedUsers,
      leftUsers,
      netUsers: joinedUsers - leftUsers,
    },
    violationsSummary: {
      warn: summary.warn,
      deleteMessage: summary.deleteMessage,
      mute: summary.mute,
      ban: summary.ban,
      unmute: summary.unmute,
      unban: summary.unban,
      affectedUsers: summary.users.size,
      total: violations.length,
    },
    violations: moderationFeed.items,
    moderationFeed,
    activityFeed,
  });
}

function buildChannelStats(
  state: PreviewState,
  channelId: string,
  range: ChannelStatsRange,
  options: Partial<{
    includeActivityPreview: boolean;
    mode: ChannelStatsMode;
  }> = {},
) {
  const now = new Date();
  const isOverviewMode = options.mode === 'overview';
  const activityItems = filterActivityItems(state.channelActivity, range, 'all', now);
  const joined = activityItems.filter((item) => item.type === 'joined').length;
  const left = activityItems.filter((item) => item.type === 'left').length;
  const { from, to } = resolveRangeWindow(range, now);
  const bucket: ChannelStatsBucket = range === '24h' ? 'hour' : 'day';
  const bucketStarts = buildPreviewStatsBucketStarts(from, to, bucket);
  const points = bucketStarts.length;

  function distributeTotal(total: number, weights: number[]): number[] {
    if (total <= 0) {
      return Array.from({ length: weights.length }, () => 0);
    }

    const safeWeights = weights.map((weight) => Math.max(0, weight));
    const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);
    if (totalWeight <= 0) {
      const fallback = Array.from({ length: weights.length }, () => 0);
      for (let index = 0; index < total; index += 1) {
        fallback[index % fallback.length] += 1;
      }
      return fallback;
    }

    const raw = safeWeights.map((weight) => (weight / totalWeight) * total);
    const distributed = raw.map((value) => Math.floor(value));
    let remainder = total - distributed.reduce((sum, value) => sum + value, 0);
    const fractions = raw
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((leftItem, rightItem) => rightItem.fraction - leftItem.fraction);

    for (let index = 0; index < fractions.length && remainder > 0; index += 1) {
      distributed[fractions[index]!.index] += 1;
      remainder -= 1;
    }

    return distributed;
  }

  const joinedWeights = Array.from({ length: points }, (_, index) => {
    const progress = points > 1 ? index / (points - 1) : 0;
    return 1 + progress * (range === '24h' ? 0.45 : 0.9);
  });
  const leftWeights = Array.from({ length: points }, (_, index) => {
    if (index % 4 === 0) {
      return range === '24h' ? 0.2 : 0.25;
    }

    const progress = points > 1 ? index / (points - 1) : 0;
    return 0.75 + (1 - progress) * 0.45;
  });
  const joinedDistribution = distributeTotal(joined, joinedWeights);
  const leftDistribution = distributeTotal(left, leftWeights);
  const baseParticipants =
    state.channelHeaderParticipantsCount -
    joinedDistribution.reduce((sum, value) => sum + value, 0) +
    leftDistribution.reduce((sum, value) => sum + value, 0);

  let runningParticipants = baseParticipants;
  const membershipSeries = Array.from({ length: points }, (_, index) => {
    const at = bucketStarts[index] ?? to;
    const joinedValue = joinedDistribution[index] ?? 0;
    const leftValue = leftDistribution[index] ?? 0;
    return {
      at: at.toISOString(),
      joined: joinedValue,
      left: leftValue,
    };
  });
  const participantsSeries = membershipSeries.map((item) => {
    runningParticipants = Math.max(0, runningParticipants + item.joined - item.left);
    return {
      at: item.at,
      participantsCount: runningParticipants,
      source: 'flow' as const,
      confidence: 'medium' as const,
    };
  });
  const viewWeights = Array.from({ length: points }, (_, index) => {
    const progress = points > 1 ? index / (points - 1) : 0;
    const campaignLift = index === Math.floor(points * 0.62) ? 2.2 : 0;
    const latePulse = index >= points - 2 ? 0.9 : 0;
    return 1 + progress * 0.9 + campaignLift + latePulse;
  });
  const posts = range === '24h' ? 3 : range === '7d' ? 14 : 42;
  const postDistribution = distributeTotal(posts, viewWeights);
  const targetViews = range === '24h' ? 38_400 : range === '7d' ? 78_000 : 248_000;
  const viewsDistribution = distributeTotal(
    targetViews,
    postDistribution.map((postCount, index) =>
      postCount > 0 ? viewWeights[index]! * postCount : 0,
    ),
  );
  const viewsSeries = Array.from({ length: points }, (_, index) => {
    const at = bucketStarts[index] ?? to;
    const postCount = postDistribution[index] ?? 0;
    const viewCount = viewsDistribution[index] ?? 0;
    return {
      at: at.toISOString(),
      posts: postCount,
      views: postCount > 0 ? Math.round(viewCount / postCount) : 0,
    };
  });
  const views = viewsDistribution.reduce((sum, item) => sum + item, 0);
  const reactions = Math.round(views * 0.06);
  const previousFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));
  const previousTo = new Date(from.getTime() - 1);
  const previousViews = Math.round(views * 0.84);
  const previousPosts = Math.max(1, Math.round(posts * 0.88));
  const previousReactions = Math.round(reactions * 0.76);
  const previousBucketStarts = buildPreviewStatsBucketStarts(previousFrom, previousTo, bucket);
  const previousNet = Math.round((joined - left) * 0.62);
  const previousJoined = Math.round(joined * 0.78);
  const previousLeft = Math.round(left * 1.18);
  const previousJoinedDistribution = distributeTotal(previousJoined, joinedWeights);
  const previousLeftDistribution = distributeTotal(previousLeft, leftWeights);
  const previousPostDistribution = distributeTotal(previousPosts, viewWeights);
  const previousViewsDistribution = distributeTotal(
    previousViews,
    previousPostDistribution.map((postCount, index) =>
      postCount > 0 ? viewWeights[index]! * postCount : 0,
    ),
  );
  const previousMembershipSeries = Array.from(
    { length: previousBucketStarts.length },
    (_, index) => {
      const at = previousBucketStarts[index] ?? previousTo;
      return {
        at: at.toISOString(),
        joined: previousJoinedDistribution[index] ?? 0,
        left: previousLeftDistribution[index] ?? 0,
      };
    },
  );
  let previousRunningParticipants =
    baseParticipants - Math.max(0, previousNet) + Math.max(0, joined - left - previousNet);
  const previousParticipantsSeries = previousMembershipSeries.map((item) => {
    previousRunningParticipants = Math.max(
      0,
      previousRunningParticipants + item.joined - item.left,
    );
    return {
      at: item.at,
      participantsCount: previousRunningParticipants,
      source: 'flow' as const,
      confidence: 'medium' as const,
    };
  });
  const previousViewsSeries = Array.from({ length: previousBucketStarts.length }, (_, index) => {
    const at = previousBucketStarts[index] ?? previousTo;
    const postCount = previousPostDistribution[index] ?? 0;
    const value = previousViewsDistribution[index] ?? 0;
    return {
      at: at.toISOString(),
      posts: postCount,
      views: postCount > 0 ? Math.round(value / postCount) : 0,
    };
  });
  const previousAverageViewsPerPost = Math.round(previousViews / previousPosts);
  const dailySummary = Array.from({ length: 16 }, (_, index) => {
    const dayOffset = 15 - index;
    const date = formatMoscowDateKey(addDays(now, -dayOffset));
    const delta = Math.round((joined - left) / 16 + Math.sin(index / 2) * 2);
    const churn = range === '24h' ? 1 : 2 + (index % 3);
    const joinedValue = Math.max(0, delta) + churn;
    const leftValue = Math.max(0, -delta) + Math.max(0, churn - 1);
    return {
      date,
      subscribers: Math.max(0, state.channelHeaderParticipantsCount - dayOffset * 3 + delta),
      delta,
      joined: joinedValue,
      left: leftValue,
      source: 'flow' as const,
      confidence: 'medium' as const,
    };
  });
  const summaryLast24h = range === '24h' ? views : Math.round(views * 0.28);
  const summaryLast48h = range === '24h' ? views : Math.round(views * 0.44);
  const summaryLast24hPerPost = Math.round(summaryLast24h / Math.max(1, posts));
  const summaryLast48hPerPost = Math.round(summaryLast48h / Math.max(1, posts));
  const selectedPeriodAverageViewsPerPost = Math.round(views / Math.max(1, posts));
  const summaryEr24 =
    summaryLast24h > 0 ? Math.round((reactions / summaryLast24h) * 10_000) / 100 : null;
  const todayFrom = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  todayFrom.setUTCHours(0, 0, 0, 0);
  todayFrom.setUTCHours(todayFrom.getUTCHours() - 3);
  const todayActivityItems = state.channelActivity.filter(
    (item) => new Date(item.createdAt).getTime() >= todayFrom.getTime(),
  );
  const todayJoined = todayActivityItems.filter((item) => item.type === 'joined').length;
  const todayLeft = todayActivityItems.filter((item) => item.type === 'left').length;
  const todayDelta = todayJoined - todayLeft;
  const todaySummary = dailySummary.at(-1);
  if (todaySummary) {
    todaySummary.subscribers = state.channelHeaderParticipantsCount;
    todaySummary.delta = todayDelta;
    todaySummary.joined = todayJoined;
    todaySummary.left = todayLeft;
  }
  const topPosts = Array.from({ length: Math.min(5, posts) }, (_, index) => {
    const postViews = Math.round(4_800 - index * 520 + (range === '30d' ? 1_400 : 0));
    const previewUrls = [
      'https://major-maksimov.ru/app/favicon.png',
      'https://major-maksimov.ru/app/apple-touch-icon.png',
    ];
    return {
      messageId: `preview-channel-post-${index + 1}`,
      publishedAt: addHours(now, -4 - index * 11).toISOString(),
      url: `https://max.ru/channels/yuzhnoe-news/${index + 1}`,
      previewUrl: previewUrls[index] ?? null,
      viewsDelta: Math.round(postViews * (0.62 - index * 0.05)),
    };
  });
  const buildDelta = (current: number, previous: number) => ({
    current,
    previous,
    absolute: current - previous,
    percent:
      previous === 0
        ? current === 0
          ? 0
          : null
        : Math.round(((current - previous) / previous) * 1000) / 10,
  });
  const topReactions = [
    { emoji: '🔥', count: 182 },
    { emoji: '👍', count: 133 },
    { emoji: '❤️', count: 97 },
  ];
  const bestWindows = [
    {
      dayOfWeek: 4,
      hour: 18,
      score: 6200,
      posts: 3,
      averageViews: 5800,
      averageReactions: 310,
    },
    {
      dayOfWeek: 2,
      hour: 12,
      score: 5200,
      posts: 2,
      averageViews: 4900,
      averageReactions: 250,
    },
    {
      dayOfWeek: 6,
      hour: 11,
      score: 4700,
      posts: 2,
      averageViews: 4400,
      averageReactions: 220,
    },
  ];
  const response: ChannelStatsResponse = {
    channel: {
      id: channelId,
      title: resolveChannelTitle(channelId, state),
      participantsCount: state.channelHeaderParticipantsCount,
      status: 'Публичный канал',
      isPublic: true,
      link: 'https://max.ru/channels/yuzhnoe-news',
      lastEventAt: state.channelActivity[0]?.createdAt ?? null,
      avatarUrl: resolveChannelAvatarUrl(channelId, state),
    },
    period: {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      bucket,
    },
    official: {
      audience: {
        joined,
        left,
        net: joined - left,
      },
      content: {
        posts,
        views,
        reactions,
        topReactions: isOverviewMode ? [] : topReactions,
        topPosts: isOverviewMode ? [] : topPosts,
        lastPublishedAt: addHours(now, -3).toISOString(),
      },
      series: {
        participants: participantsSeries,
        membership: membershipSeries,
        views: viewsSeries,
      },
    },
    summary: {
      subscribers: {
        current: state.channelHeaderParticipantsCount,
        todayDelta,
        todayJoined,
        todayLeft,
        weekDelta: dailySummary.slice(-7).reduce((sum, item) => sum + (item.delta ?? 0), 0),
        sixteenDaysDelta: dailySummary.reduce((sum, item) => sum + (item.delta ?? 0), 0),
      },
      views: {
        perPost: summaryLast24hPerPost,
        last24h: summaryLast24hPerPost,
        last48h: summaryLast48hPerPost,
        er24: summaryEr24,
      },
      daily: dailySummary,
    },
    secondary: {
      postsWithButtons: range === '24h' ? 1 : range === '7d' ? 5 : 12,
      comments: range === '24h' ? 46 : range === '7d' ? 281 : 970,
      suggestions: range === '24h' ? 5 : range === '7d' ? 17 : 63,
      commentAuthors: range === '24h' ? 31 : range === '7d' ? 118 : 366,
      suggestionAuthors: range === '24h' ? 4 : range === '7d' ? 13 : 44,
      suggestionsDelivered: range === '24h' ? 5 : range === '7d' ? 16 : 61,
      suggestionsFailed: range === '24h' ? 0 : range === '7d' ? 1 : 2,
      lastBotActivityAt: addHours(now, -1.8).toISOString(),
    },
    meta: {
      maxSnapshotAvailable: true,
      viewsAvailable: true,
      churnAvailable: true,
      officialCoverageFrom: addDays(now, -30).toISOString(),
      refreshQueued: false,
    },
    comparison: {
      period: {
        from: previousFrom.toISOString(),
        to: previousTo.toISOString(),
      },
      deltas: {
        audienceNet: buildDelta(joined - left, previousNet),
        joined: buildDelta(joined, previousJoined),
        left: buildDelta(left, previousLeft),
        posts: buildDelta(posts, previousPosts),
        views: buildDelta(views, previousViews),
        averageViewsPerPost: buildDelta(
          selectedPeriodAverageViewsPerPost,
          isOverviewMode ? 0 : previousAverageViewsPerPost,
        ),
        reactions: buildDelta(reactions, previousReactions),
      },
      ...(isOverviewMode
        ? {}
        : {
            series: {
              participants: previousParticipantsSeries,
              membership: previousMembershipSeries,
              views: previousViewsSeries,
            },
          }),
    },
    signals: {
      markers: [
        ...(isOverviewMode
          ? []
          : [
              {
                code: 'top-post' as const,
                type: 'post' as const,
                label: '#1',
                value: '4 800',
                tone: 'accent' as const,
                at: topPosts[0]?.publishedAt ?? addHours(now, -4).toISOString(),
              },
            ]),
        {
          code: 'views-peak',
          type: 'peak',
          label: 'Пик',
          value: '18 000',
          tone: 'success',
          at: viewsSeries[Math.floor(viewsSeries.length * 0.62)]?.at ?? now.toISOString(),
        },
      ],
      bestWindows: isOverviewMode ? [] : bestWindows,
    },
    activityFeed:
      options.includeActivityPreview === false
        ? { items: [], hasMore: false, nextCursor: null }
        : buildActivityPage(state.channelActivity, { range, limit: 50 }, now),
  };

  return channelStatsResponseSchema.parse(response);
}

function parseJsonBody(init?: RequestInit): unknown {
  if (!init?.body || typeof init.body !== 'string') {
    return null;
  }

  return JSON.parse(init.body);
}

function createBroadcastHandoffResponse(): BroadcastHandoffResponse {
  return {
    botUrl: 'https://max.ru/maxim-bot',
  };
}

function createPublishRulesResult(chatId: string): PublishChatRulesResult {
  return publishChatRulesResultSchema.parse({
    chatId,
    messageId: `rules-${Date.now()}`,
    url: 'https://max.ru/community/rules-preview',
    publishedAt: new Date().toISOString(),
  });
}

function createPublishEngagementResult(chatId: string): PublishChannelEngagementResult {
  return publishChannelEngagementResultSchema.parse({
    chatId,
    sent: true,
    messageId: `engagement-${Date.now()}`,
    updatedExisting: true,
    publishedAt: new Date().toISOString(),
  });
}

function findBroadcast(
  broadcasts: ManagedBroadcastDetails[],
  broadcastId: string,
): ManagedBroadcastDetails | null {
  return broadcasts.find((item) => item.id === broadcastId) ?? null;
}

function findAutopostRule(
  rules: ManagedAutopostHubRuleDetails[],
  ruleId: string,
): ManagedAutopostHubRuleDetails | null {
  return rules.find((item) => item.id === ruleId && item.status !== 'DISABLED') ?? null;
}

function resolvePreviewSource(
  state: PreviewState,
  entityType: ManagedEntityType,
  sourceChatId: string,
): ChatSummary | null {
  const sources = entityType === 'channel' ? state.channels : state.chats;
  return sources.find((item) => item.id === sourceChatId) ?? null;
}

function resolvePreviewAutopostTargetPreviews(
  state: PreviewState,
  entityType: ManagedEntityType,
  sourceChatId: string,
  payload: ManagedAutopostPayload,
) {
  const source = resolvePreviewSource(state, entityType, sourceChatId);
  const sourcePreview = {
    id: sourceChatId,
    title: source?.title ?? (entityType === 'channel' ? PREVIEW_CHANNEL_TITLE : PREVIEW_CHAT_TITLE),
    entityType,
    link: source?.link ?? null,
    avatarUrl: source?.avatarUrl ?? null,
  };

  if (entityType === 'channel' || payload.targetMode === 'current') {
    return {
      sourcePreview,
      targetPreviews: [sourcePreview],
      targetOverflowCount: 0,
      targetChats: 1,
    };
  }

  if (payload.targetMode === 'all') {
    const previews = state.chats.slice(0, 3).map((chat) => ({
      id: chat.id,
      title: chat.title,
      entityType: 'chat' as const,
      link: chat.link ?? null,
      avatarUrl: chat.avatarUrl ?? null,
    }));
    return {
      sourcePreview,
      targetPreviews: previews,
      targetOverflowCount: Math.max(0, state.chats.length - previews.length),
      targetChats: Math.max(1, state.chats.length),
    };
  }

  const targetIds = payload.targetChatIds.length > 0 ? payload.targetChatIds : [sourceChatId];
  const previews = targetIds.slice(0, 3).map((targetId) => {
    const chat = state.chats.find((item) => item.id === targetId);
    return {
      id: targetId,
      title: chat?.title ?? `Чат ${targetId}`,
      entityType: 'chat' as const,
      link: chat?.link ?? null,
      avatarUrl: chat?.avatarUrl ?? null,
    };
  });
  return {
    sourcePreview,
    targetPreviews: previews,
    targetOverflowCount: Math.max(0, targetIds.length - previews.length),
    targetChats: Math.max(1, targetIds.length),
  };
}

function buildPreviewAutopostRule(
  state: PreviewState,
  input: {
    id: string;
    sourceChatId: string;
    entityType: ManagedEntityType;
    title: string;
    payload: ManagedAutopostPayload;
    status?: ManagedAutopostHubRuleDetails['status'];
    revision?: number;
    createdAt?: string;
    updatedAt?: string;
  },
): ManagedAutopostHubRuleDetails {
  const nowIso = new Date().toISOString();
  const textPreview = input.payload.text.replace(/\s+/gu, ' ').trim().slice(0, 160);
  const nextSendAt =
    input.payload.scheduledSlots
      .map((slot) => new Date(slot))
      .filter((slot) => Number.isFinite(slot.getTime()) && slot.getTime() > Date.now())
      .sort((left, right) => left.getTime() - right.getTime())[0]
      ?.toISOString() ?? null;
  const targetBundle = resolvePreviewAutopostTargetPreviews(
    state,
    input.entityType,
    input.sourceChatId,
    input.payload,
  );

  return managedAutopostHubRuleDetailsSchema.parse({
    id: input.id,
    sourceChatId: input.sourceChatId,
    entityType: input.entityType,
    status: input.status ?? 'ACTIVE',
    title: input.title,
    textPreview:
      textPreview ||
      (input.payload.images.length > 0 || input.payload.imageEnabled ? 'Фото без текста' : 'Пусто'),
    textLength: input.payload.text.length,
    targetMode: input.payload.targetMode,
    applyToAllChats: input.payload.applyToAllChats,
    targetChatIds: input.payload.targetChatIds,
    targetChats: targetBundle.targetChats,
    hasImage: input.payload.images.length > 0 || input.payload.imageEnabled,
    imageCount: input.payload.images.length || (input.payload.imageEnabled ? 1 : 0),
    hasVideo: input.payload.mediaType === 'video',
    buttons: input.payload.buttons,
    scheduleTimezone: input.payload.scheduleTimezone,
    scheduledSlots: input.payload.scheduledSlots,
    nextSendAt,
    materializedCount: 0,
    revision: input.revision ?? 1,
    createdAt: input.createdAt ?? nowIso,
    updatedAt: input.updatedAt ?? nowIso,
    lastError: null,
    sourcePreview: targetBundle.sourcePreview,
    targetPreviews: targetBundle.targetPreviews,
    targetOverflowCount: targetBundle.targetOverflowCount,
    payload: input.payload,
  });
}

function findGiveaway(
  giveaways: ManagedGiveawayDetails[],
  giveawayId: string,
): ManagedGiveawayDetails | null {
  return giveaways.find((item) => item.id === giveawayId) ?? null;
}

function upsertGiveaway(
  giveaways: ManagedGiveawayDetails[],
  giveaway: ManagedGiveawayDetails,
): ManagedGiveawayDetails[] {
  const index = giveaways.findIndex((item) => item.id === giveaway.id);
  if (index === -1) {
    return [giveaway, ...giveaways];
  }

  const next = giveaways.slice();
  next[index] = giveaway;
  return next;
}

function createDraftGiveaway(
  entityType: 'chat' | 'channel',
  entityId: string,
): ManagedGiveawayDetails {
  const now = new Date();

  return managedGiveawayDetailsSchema.parse({
    id: `giveaway-${entityType}-${Date.now()}`,
    title: entityType === 'chat' ? 'Новый розыгрыш в чате' : 'Новый розыгрыш в канале',
    status: 'DRAFT',
    hasImage: false,
    entriesCount: 0,
    verifiedEntriesCount: 0,
    pendingEntriesCount: 0,
    winnersCount: 1,
    startsAt: null,
    endsAt: addDays(now, 2).toISOString(),
    publishedAt: null,
    completedAt: null,
    publicationUrl: null,
    resultsUrl: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    sourceChatId: entityId,
    entityType,
    description: '',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    claimHours: 24,
    requiredChannelIds: entityType === 'chat' ? [PREVIEW_CHANNEL_ID] : [entityId],
    publicationMessageId: null,
    resultsMessageId: null,
    prizes: [
      {
        id: `prize-${Date.now()}`,
        position: 1,
        title: 'Приз 1',
        displayTitle: 'Приз 1',
      },
    ],
    winners: [],
  });
}

function normalizePreviewGiveawayPrizes(value: unknown): ManagedGiveawayDetails['prizes'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item, index) => {
    const prize = item as {
      id?: unknown;
      position?: unknown;
      title?: unknown;
      displayTitle?: unknown;
    };
    const position = typeof prize.position === 'number' ? prize.position : index + 1;
    const title =
      typeof prize.title === 'string' && prize.title.trim()
        ? prize.title.trim()
        : `Приз ${position}`;
    const displayTitle =
      typeof prize.displayTitle === 'string' && prize.displayTitle.trim()
        ? prize.displayTitle.trim()
        : title;

    return {
      id: typeof prize.id === 'string' && prize.id.trim() ? prize.id : `prize-${position}`,
      position,
      title,
      displayTitle,
    };
  });
}

function buildModerationMessage(payload: ManualModerationActionRequest): string {
  const scopeLabel = payload.scope === 'all_chats' ? 'во всех чатах' : 'в этом чате';
  if (payload.action === 'MUTE') {
    return `Участник замьючен на ${payload.muteDurationHours ?? 24}ч ${scopeLabel} в preview-режиме.`;
  }
  if (payload.action === 'UNMUTE') {
    return 'Мут снят в preview-режиме.';
  }
  if (payload.action === 'UNBAN') {
    return 'Участник разбанен в preview-режиме.';
  }
  return `Участник забанен ${scopeLabel} в preview-режиме.`;
}

function createModerationResult(
  userId: string,
  payload: ManualModerationActionRequest,
): ManualModerationActionResult {
  const now = new Date();
  return manualModerationActionResultSchema.parse({
    ok: true,
    action: payload.action,
    userId,
    muteDurationHours: payload.action === 'MUTE' ? (payload.muteDurationHours ?? 24) : null,
    muteExpiresAt:
      payload.action === 'MUTE'
        ? addHours(now, payload.muteDurationHours ?? 24).toISOString()
        : null,
    message: buildModerationMessage(payload),
  });
}

function createPreviewSpammerReviewCandidates(now: Date): GlobalSpammerReviewCandidate[] {
  return globalSpammerReviewQueueSchema.parse({
    limit: 6,
    items: [
      {
        userId: 'preview-spam-1',
        displayName: 'Promo Mix',
        avatarUrl: buildPreviewAvatarDataUrl('Promo Mix', '#f1a44b', '#ea7b4b'),
        profileUrl: buildPreviewProfileUrl('promo-mix-preview'),
        profileHandoffUrl: buildPreviewProfileHandoffUrl('promo-mix-preview'),
        status: 'PENDING',
        confidenceScore: 0.74,
        sourceBreakdown: {
          COMMERCIAL_CAMPAIGN: {
            score: 0.58,
            rawScore: 0.74,
            count: 2,
            latestAt: addHours(now, -1).toISOString(),
            reasons: ['COMMERCIAL_AD_DETECTED'],
          },
          REPEATED_LINK: {
            score: 0.62,
            rawScore: 0.58,
            count: 1,
            latestAt: addHours(now, -1.2).toISOString(),
            reasons: ['REPEATED_LINK_CROSS_CHAT'],
          },
          MANUAL_BAN: {
            score: 0.34,
            rawScore: 1,
            count: 2,
            latestAt: addHours(now, -2.4).toISOString(),
            reasons: ['MANUAL_BAN'],
            effect: 'risk',
            mitigating: false,
          },
        },
        lastReason: 'COMMERCIAL_AD_DETECTED',
        lastChatId: PREVIEW_CHAT_ID,
        lastEvidence: {
          excerpt: 'Прайс от 990, доставка сегодня, подробности в профиле',
        },
        lastUserLabel: 'Promo Mix',
        suppressedUntil: null,
        reviewedAt: null,
        reviewedByUserId: null,
        reviewReason: null,
        falsePositive: false,
        chats: [
          {
            chatId: PREVIEW_CHAT_ID,
            detectionsCount: 2,
            lastMessageId: 'preview-spam-message-1',
            lastExcerpt: 'Прайс от 990, доставка сегодня, подробности в профиле',
            lastUserLabel: 'Promo Mix',
            lastDetectedAt: addHours(now, -1).toISOString(),
          },
        ],
        observations: [
          {
            id: 'preview-observation-1',
            source: 'COMMERCIAL_CAMPAIGN',
            score: 0.74,
            confidenceLevel: 'MEDIUM',
            reason: 'COMMERCIAL_AD_DETECTED',
            chatId: PREVIEW_CHAT_ID,
            messageId: 'preview-spam-message-1',
            evidenceHash: 'preview-hash-1',
            evidence: {
              excerpt: 'Прайс от 990, доставка сегодня, подробности в профиле',
            },
            observedAt: addHours(now, -1).toISOString(),
            expiresAt: addDays(now, 14).toISOString(),
            suppressedAt: null,
            suppressionReason: null,
          },
          {
            id: 'preview-observation-2',
            source: 'REPEATED_LINK',
            score: 0.58,
            confidenceLevel: 'MEDIUM',
            reason: 'REPEATED_LINK_CROSS_CHAT',
            chatId: PREVIEW_CHAT_ID,
            messageId: 'preview-spam-message-1',
            evidenceHash: 'preview-hash-2',
            evidence: {
              repeatedLinkDistinctChatCount: 2,
            },
            observedAt: addHours(now, -1.2).toISOString(),
            expiresAt: addDays(now, 10).toISOString(),
            suppressedAt: null,
            suppressionReason: null,
          },
          {
            id: 'preview-observation-3',
            source: 'MANUAL_BAN',
            score: 0.34,
            confidenceLevel: 'LOW',
            reason: 'MANUAL_BAN',
            chatId: 'preview-other-chat-1',
            messageId: null,
            evidenceHash: 'preview-hash-3',
            evidence: {
              actorUserId: 'preview-other-admin',
              sourceCause: 'MANUAL_BAN',
            },
            observedAt: addHours(now, -2.4).toISOString(),
            expiresAt: addDays(now, 21).toISOString(),
            suppressedAt: null,
            suppressionReason: null,
          },
        ],
      },
    ],
  }).items;
}

function buildPreviewSpammerReviewMetrics(candidates: readonly GlobalSpammerReviewCandidate[]) {
  const now = new Date();
  const pending = candidates.filter((item) => item.status === 'PENDING').length;
  const approved = candidates.filter(
    (item) => item.status === 'APPROVED' || item.status === 'AUTO_APPROVED',
  ).length;
  const suppressed = candidates.filter((item) => item.status === 'SUPPRESSED').length;
  const reviewed = candidates.filter(
    (item) => item.status === 'APPROVED' || item.status === 'SUPPRESSED',
  ).length;
  const falsePositiveCount = candidates.filter((item) => item.falsePositive).length;
  const sourceCounts = new Map<string, number>();
  const suppressedCounts = new Map<string, number>();
  for (const candidate of candidates) {
    for (const observation of candidate.observations) {
      sourceCounts.set(observation.source, (sourceCounts.get(observation.source) ?? 0) + 1);
      if (observation.suppressedAt) {
        suppressedCounts.set(
          observation.source,
          (suppressedCounts.get(observation.source) ?? 0) + 1,
        );
      }
    }
  }

  return globalSpammerReviewMetricsSchema.parse({
    pending,
    approved,
    suppressed,
    reviewed,
    activeRegistry: approved,
    expiredRegistry: 0,
    archivedExpired: 4,
    newCandidates24h: Math.max(pending, 2),
    autoApproved24h: Math.max(approved, 1),
    suppressed24h: suppressed,
    shadowWouldEnforceCount: 3,
    topCampaigns: createPreviewSpammerCampaigns(now).slice(0, 3),
    enforcementMode: 'enforce',
    falsePositiveCount,
    falsePositiveRate: reviewed > 0 ? falsePositiveCount / reviewed : 0,
    recentObservations: [...sourceCounts.entries()].map(([source, count]) => ({ source, count })),
    suppressedObservations: [...suppressedCounts.entries()].map(([source, count]) => ({
      source,
      count,
    })),
    sourceAlerts: [],
  });
}

function createPreviewSpammerCampaigns(now: Date, options: { userScoped?: boolean } = {}) {
  return [
    {
      clusterId: 'preview-campaign-domain',
      signalType: 'DOMAIN',
      status: 'CONFIRMED',
      confidenceScore: 0.91,
      distinctUsersCount: 7,
      distinctChatsCount: 5,
      observationsCount: 18,
      userObservationsCount: options.userScoped ? 3 : null,
      lastSeenAt: addHours(now, -0.8).toISOString(),
      preview: 'promo-bad.example',
    },
    {
      clusterId: 'preview-campaign-text',
      signalType: 'TEXT_SIGNATURE',
      status: 'ACTIVE',
      confidenceScore: 0.78,
      distinctUsersCount: 4,
      distinctChatsCount: 3,
      observationsCount: 9,
      userObservationsCount: options.userScoped ? 2 : null,
      lastSeenAt: addHours(now, -2.4).toISOString(),
      preview: null,
    },
  ];
}

function buildPreviewSpammerDiagnostics(
  candidates: readonly GlobalSpammerReviewCandidate[],
  chatId: string,
  userId: string,
  includeProfile = true,
): GlobalSpammerUserDiagnostics {
  const now = new Date();
  if (userId === 'preview-spammer-1') {
    const expiresAt = addDays(now, 30).toISOString();
    const observedAt = addHours(now, -1).toISOString();
    const displayName = 'Олег Повтор';
    const duplicateSignals = [
      {
        id: 'preview-registry-observation-1',
        source: 'FANOUT_HIGH',
        score: 0.94,
        confidenceLevel: 'HIGH',
        reason: 'FANOUT_EPISODE_CONFIRMED',
        chatId,
        observedAt,
        expiresAt,
        suppressedAt: null,
      },
      {
        id: 'preview-registry-observation-2',
        source: 'FANOUT_HIGH',
        score: 0.91,
        confidenceLevel: 'HIGH',
        reason: 'FANOUT_EPISODE_CONFIRMED',
        chatId,
        observedAt: addHours(now, -1.4).toISOString(),
        expiresAt,
        suppressedAt: null,
      },
      {
        id: 'preview-registry-observation-3',
        source: 'GRAPH_FANOUT_PATTERN',
        score: 0.7,
        confidenceLevel: 'MEDIUM',
        reason: 'GRAPH_FANOUT_PATTERN',
        chatId,
        observedAt: addHours(now, -2).toISOString(),
        expiresAt,
        suppressedAt: null,
      },
    ];

    return globalSpammerUserDiagnosticsSchema.parse({
      userId,
      chatId,
      displayName: includeProfile ? displayName : null,
      avatarUrl: includeProfile
        ? buildPreviewAvatarDataUrl(displayName, '#7db8ff', '#4d89ff')
        : null,
      profileUrl: includeProfile ? buildPreviewProfileUrl('oleg-repeat') : null,
      profileHandoffUrl: includeProfile ? buildPreviewProfileHandoffUrl('oleg-repeat') : null,
      policy: {
        userId,
        chatId,
        trigger: 'diagnostics',
        registryStatus: 'ACTIVE_CONFIRMED',
        action: 'NONE',
        enforcementMode: 'enforce',
        deleteSpammersEnabled: false,
        adminExempt: false,
        shadow: false,
        wouldEnforce: true,
        enforced: false,
        confidenceScore: 0.94,
        policyBand: 'VERY_HIGH',
        shadowScore: 0.98,
        reason: 'FANOUT_EPISODE_CONFIRMED',
        expiresAt,
        sourceBreakdown: {
          FANOUT_HIGH: { score: 0.94, count: 2 },
          GRAPH_FANOUT_PATTERN: { score: 0.7, count: 2 },
          GRAPH_TEXT: { score: 0.56, count: 1 },
        },
        campaignBreakdown: {
          'preview-campaign-domain': {
            confidenceScore: 0.91,
            distinctUsersCount: 7,
            distinctChatsCount: 5,
          },
        },
      },
      registry: {
        active: true,
        expired: false,
        confidenceScore: 0.94,
        confirmedAt: addHours(now, -2).toISOString(),
        confirmedByUserId: null,
        reason: 'FANOUT_EPISODE_CONFIRMED',
        expiresAt,
        sourceBreakdown: {
          FANOUT_HIGH: { score: 0.94, count: 2 },
          GRAPH_FANOUT_PATTERN: { score: 0.7, count: 2 },
          GRAPH_TEXT: { score: 0.56, count: 1 },
        },
      },
      candidate: null,
      activeSuppression: null,
      observations: duplicateSignals,
      graphSignals: [
        {
          signalType: 'FANOUT_PATTERN',
          source: 'GRAPH_FANOUT_PATTERN',
          score: 0.68,
          chatId,
          observedAt: addHours(now, -1.7).toISOString(),
          expiresAt,
        },
        {
          signalType: 'TEXT',
          source: 'GRAPH_TEXT',
          score: 0.56,
          chatId,
          observedAt: addHours(now, -2.2).toISOString(),
          expiresAt,
        },
      ],
      sourceReputation: [
        {
          source: 'FANOUT_HIGH',
          weight: 0.94,
          falsePositiveRate: 0.03,
          observations: 58,
          suppressed: 2,
        },
        {
          source: 'GRAPH_FANOUT_PATTERN',
          weight: 0.7,
          falsePositiveRate: 0.08,
          observations: 23,
          suppressed: 2,
        },
      ],
      campaigns: createPreviewSpammerCampaigns(now, { userScoped: true }),
      localAdminDecision: null,
      reputationSummary: {
        naturalBanSignals: 0,
        localBlockSignals: 0,
        localAllowSignals: 0,
        onlyReputationSignals: false,
        note: 'Репутационные сигналы учитываются как фон, а не как приговор.',
      },
      latestShadowScore: {
        currentScore: 0.94,
        v2Score: 0.98,
        scoreDelta: 0.04,
        currentBand: 'VERY_HIGH',
        v2Band: 'CONFIRMED',
        wouldPromote: false,
        wouldSuppress: false,
        createdAt: addMinutes(now, -25).toISOString(),
      },
    });
  }

  const candidate = candidates.find((item) => item.userId === userId) ?? null;
  const displayName = candidate?.displayName ?? candidate?.lastUserLabel ?? null;
  const isApproved = candidate?.status === 'APPROVED' || candidate?.status === 'AUTO_APPROVED';
  const isSuppressed = candidate?.status === 'SUPPRESSED';
  const localAdminDecision = isApproved
    ? {
        decision: 'BLOCK',
        reason: candidate?.reviewReason ?? 'LOCAL_ADMIN_BLOCK',
        sourceChatId: chatId,
        decidedByUserIds: [candidate?.reviewedByUserId ?? 'preview-admin'],
        updatedAt: candidate?.reviewedAt ?? now.toISOString(),
      }
    : isSuppressed
      ? {
          decision: 'ALLOW',
          reason: candidate?.reviewReason ?? 'LOCAL_ADMIN_ALLOW',
          sourceChatId: chatId,
          decidedByUserIds: [candidate?.reviewedByUserId ?? 'preview-admin'],
          updatedAt: candidate?.reviewedAt ?? now.toISOString(),
        }
      : null;
  const observations = candidate?.observations ?? [];
  const naturalBanSignals = observations.filter(
    (observation) => observation.source === 'SANCTION_BAN' || observation.source === 'MANUAL_BAN',
  ).length;
  const localBlockSignals =
    observations.filter((observation) => observation.source === 'LOCAL_ADMIN_BLOCK').length +
    (isApproved ? 1 : 0);
  const localAllowSignals =
    observations.filter((observation) => observation.source === 'LOCAL_ADMIN_ALLOW').length +
    (isSuppressed ? 1 : 0);
  const onlyReputationSignals =
    observations.length > 0 &&
    observations.every((observation) =>
      ['SANCTION_BAN', 'MANUAL_BAN', 'LOCAL_ADMIN_BLOCK', 'LOCAL_ADMIN_ALLOW'].includes(
        observation.source,
      ),
    );
  const policyStatus = isApproved
    ? 'LOCAL_BLOCKED'
    : isSuppressed
      ? 'ADMIN_EXEMPT'
      : candidate?.status === 'PENDING'
        ? 'MEDIUM_REVIEW'
        : 'NONE';
  const confidenceScore = candidate?.confidenceScore ?? null;
  const expiresAt = null;

  return globalSpammerUserDiagnosticsSchema.parse({
    userId,
    chatId,
    displayName: includeProfile ? displayName : null,
    avatarUrl: includeProfile ? (candidate?.avatarUrl ?? null) : null,
    profileUrl: includeProfile ? (candidate?.profileUrl ?? null) : null,
    profileHandoffUrl: includeProfile ? (candidate?.profileHandoffUrl ?? null) : null,
    policy: {
      userId,
      chatId,
      trigger: 'diagnostics',
      registryStatus: policyStatus,
      action: isApproved ? 'DELETE_AND_KICK' : 'NONE',
      enforcementMode: 'enforce',
      deleteSpammersEnabled: true,
      adminExempt: isSuppressed,
      shadow: false,
      wouldEnforce: false,
      enforced: false,
      confidenceScore,
      policyBand: isApproved ? 'HIGH' : isSuppressed ? 'LOW' : 'MEDIUM',
      shadowScore: candidate ? Math.min(1, candidate.confidenceScore + 0.08) : null,
      reason: localAdminDecision?.reason ?? candidate?.lastReason ?? 'NO_ACTIVE_REGISTRY_ENTRY',
      expiresAt,
      sourceBreakdown: candidate?.sourceBreakdown ?? null,
      campaignBreakdown: candidate
        ? {
            'preview-campaign-domain': {
              confidenceScore: 0.78,
              distinctUsersCount: 3,
              distinctChatsCount: 2,
            },
          }
        : null,
    },
    registry: {
      active: false,
      expired: false,
      confidenceScore: null,
      confirmedAt: null,
      confirmedByUserId: null,
      reason: null,
      expiresAt: null,
      sourceBreakdown: null,
    },
    candidate: candidate
      ? {
          status: candidate.status,
          confidenceScore: candidate.confidenceScore,
          lastReason: candidate.lastReason,
          reviewedAt: candidate.reviewedAt,
          reviewedByUserId: candidate.reviewedByUserId,
          reviewReason: candidate.reviewReason,
          falsePositive: candidate.falsePositive,
        }
      : null,
    activeSuppression: null,
    observations: observations.map((observation) => ({
      id: observation.id,
      source: observation.source,
      score: observation.score,
      confidenceLevel: observation.confidenceLevel,
      reason: observation.reason,
      chatId: observation.chatId,
      observedAt: observation.observedAt,
      expiresAt: observation.expiresAt,
      suppressedAt: observation.suppressedAt,
    })),
    graphSignals: [
      {
        signalType: 'DOMAIN',
        source: 'GRAPH_DOMAIN',
        score: 0.62,
        chatId,
        observedAt: addHours(now, -1).toISOString(),
        expiresAt: addDays(now, 14).toISOString(),
      },
    ],
    sourceReputation: [
      {
        source: 'COMMERCIAL_CAMPAIGN',
        weight: 0.9,
        falsePositiveRate: 0.04,
        observations: 42,
        suppressed: 2,
      },
      {
        source: 'MANUAL_BAN',
        weight: 0.36,
        falsePositiveRate: 0.12,
        observations: 18,
        suppressed: 2,
      },
    ],
    campaigns: candidate
      ? createPreviewSpammerCampaigns(now, { userScoped: true }).slice(0, 1)
      : [],
    localAdminDecision,
    reputationSummary: {
      naturalBanSignals,
      localBlockSignals,
      localAllowSignals,
      onlyReputationSignals:
        onlyReputationSignals ||
        (naturalBanSignals + localBlockSignals + localAllowSignals > 0 &&
          !candidate?.observations.some((observation) =>
            ['FANOUT_HIGH', 'FANOUT_REPEAT', 'COMMERCIAL_AD', 'COMMERCIAL_CAMPAIGN'].includes(
              observation.source,
            ),
          )),
      note:
        naturalBanSignals + localBlockSignals + localAllowSignals > 0
          ? 'Есть репутационные сигналы, но сами по себе они не отправляют пользователя в глобальную базу.'
          : 'Репутационные сигналы учитываются как фон, а не как приговор.',
    },
    latestShadowScore: candidate
      ? {
          currentScore: candidate.confidenceScore,
          v2Score: Math.min(1, candidate.confidenceScore + 0.08),
          scoreDelta: 0.08,
          currentBand: isApproved ? 'CONFIRMED' : 'MEDIUM',
          v2Band: isApproved ? 'CONFIRMED' : 'HIGH',
          wouldPromote: !isApproved && !isSuppressed,
          wouldSuppress: isSuppressed,
          createdAt: addMinutes(now, -12).toISOString(),
        }
      : null,
  });
}

function createPreviewSpammerReviewResult(
  candidates: GlobalSpammerReviewCandidate[],
  userId: string,
  payload: GlobalSpammerReviewRequest,
) {
  const now = new Date().toISOString();
  const status = payload.action === 'SUPPRESS' ? 'SUPPRESSED' : 'APPROVED';
  const index = candidates.findIndex((candidate) => candidate.userId === userId);
  if (index >= 0) {
    candidates[index] = {
      ...candidates[index]!,
      status,
      reviewedAt: now,
      reviewedByUserId: 'preview-admin',
      reviewReason: payload.reason ?? null,
      falsePositive: payload.action === 'SUPPRESS',
      observations:
        payload.action === 'SUPPRESS'
          ? candidates[index]!.observations.map((observation) => ({
              ...observation,
              suppressedAt: now,
              suppressionReason: payload.reason ?? 'REVIEW_SUPPRESSION',
            }))
          : candidates[index]!.observations,
    };
  }

  return globalSpammerReviewResultSchema.parse({
    ok: true,
    userId,
    status,
  });
}

function createManualViolation(
  userId: string,
  user: {
    displayName: string;
    avatarUrl: string | null;
    profileUrl: string | null;
    profileHandoffUrl: string | null;
  },
  payload: ManualModerationActionRequest,
): LogsDashboardResponse['violations'][number] {
  const now = new Date();

  if (payload.action === 'UNMUTE') {
    return {
      id: `manual-unmute-${Date.now()}`,
      action: 'NONE',
      ruleCode: 'MANUAL_UNMUTE',
      userId,
      userDisplayName: user.displayName,
      avatarUrl: user.avatarUrl,
      profileUrl: user.profileUrl,
      profileHandoffUrl: user.profileHandoffUrl,
      createdAt: now.toISOString(),
      maskedExcerpt: null,
      metadata: null,
    };
  }

  if (payload.action === 'UNBAN') {
    return {
      id: `manual-unban-${Date.now()}`,
      action: 'NONE',
      ruleCode: 'MANUAL_UNBAN',
      userId,
      userDisplayName: user.displayName,
      avatarUrl: user.avatarUrl,
      profileUrl: user.profileUrl,
      profileHandoffUrl: user.profileHandoffUrl,
      createdAt: now.toISOString(),
      maskedExcerpt: null,
      metadata: null,
    };
  }

  if (payload.action === 'MUTE') {
    return {
      id: `manual-mute-${Date.now()}`,
      action: 'MUTE',
      ruleCode: 'MANUAL_MUTE',
      userId,
      userDisplayName: user.displayName,
      avatarUrl: user.avatarUrl,
      profileUrl: user.profileUrl,
      profileHandoffUrl: user.profileHandoffUrl,
      createdAt: now.toISOString(),
      maskedExcerpt: null,
      metadata: {
        scope: payload.scope ?? 'current_chat',
        muteDurationHours: payload.muteDurationHours ?? 24,
        muteExpiresAt: addHours(now, payload.muteDurationHours ?? 24).toISOString(),
      },
    };
  }

  return {
    id: `manual-ban-${Date.now()}`,
    action: 'BAN',
    ruleCode: 'MANUAL_BAN',
    userId,
    userDisplayName: user.displayName,
    avatarUrl: user.avatarUrl,
    profileUrl: user.profileUrl,
    profileHandoffUrl: user.profileHandoffUrl,
    createdAt: now.toISOString(),
    maskedExcerpt: null,
    metadata: {
      scope: payload.scope ?? 'current_chat',
    },
  };
}

function resolvePreviewUser(
  state: PreviewState,
  userId: string,
): {
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string | null;
  profileHandoffUrl: string | null;
} {
  const fromParticipants = state.chatParticipants.find((item) => item.userId === userId) ?? null;
  const fromActivity = state.chatActivity.find((item) => item.userId === userId) ?? null;
  const fromViolation = state.chatViolations.find((item) => item.userId === userId) ?? null;
  const snapshot = fromParticipants ?? fromActivity ?? fromViolation;

  return {
    displayName: snapshot?.userDisplayName?.trim() || 'Участник',
    avatarUrl: snapshot?.avatarUrl ?? null,
    profileUrl: snapshot?.profileUrl ?? null,
    profileHandoffUrl: snapshot?.profileHandoffUrl ?? null,
  };
}

async function handleChatRequest(
  state: PreviewState,
  chatId: string,
  tail: string[],
  url: URL,
  method: string,
  init?: RequestInit,
): Promise<unknown> {
  if (tail[0] === 'header' && method === 'GET') {
    const assignedBots = buildPreviewAssignedBots({
      primaryBotId: state.chatPrimaryBotId,
      assistEnabled: state.chatPartnerAssistEnabled,
    });

    return {
      id: chatId,
      title: resolveChatTitle(chatId, state),
      entityType: 'chat',
      link: null,
      participantsCount: state.chatHeaderParticipantsCount,
      avatarUrl: resolveChatAvatarUrl(chatId, state),
      primaryBotId: state.chatPrimaryBotId,
      assignedBots,
      sharedMode: buildPreviewSharedMode(state.chatPartnerAssistEnabled),
      botCount: assignedBots.length,
      hasSharedAutomation: assignedBots.length > 1,
    };
  }

  if (tail[0] === 'settings-screen' && method === 'GET') {
    return cloneJson(buildChatSettingsScreen(state, chatId));
  }

  if (tail[0] === 'bots' && tail[1] === 'plan' && method === 'GET') {
    return cloneJson(buildPreviewBotExecutionPlan(state, 'chat', chatId));
  }

  if (tail[0] === 'bots' && tail[1] === 'primary' && method === 'POST') {
    const payload = updateManagedEntityPrimaryBotRequestSchema.parse(parseJsonBody(init));
    state.chatPrimaryBotId = payload.botId;
    return cloneJson(buildPreviewBotExecutionPlan(state, 'chat', chatId));
  }

  if (tail[0] === 'bots' && tail[1] === 'partner-assist' && method === 'POST') {
    const payload = updateManagedEntityPartnerAssistRequestSchema.parse(parseJsonBody(init));
    state.chatPartnerAssistEnabled =
      payload.enabled && payload.botId.trim() === PREVIEW_STANDBY_BOT_ID;
    return cloneJson(buildPreviewBotExecutionPlan(state, 'chat', chatId));
  }

  if (
    tail[0] === 'required-subscription' &&
    tail[1] === 'channels' &&
    tail[2] === 'resolve' &&
    method === 'POST'
  ) {
    const payload = resolveRequiredSubscriptionChannelRequestSchema.parse(parseJsonBody(init));
    const normalizedValue = payload.value.trim().toLowerCase();
    const normalizedLink = normalizedValue.startsWith('http')
      ? normalizedValue
      : normalizedValue.startsWith('max.ru/')
        ? `https://${normalizedValue}`
        : normalizedValue;
    const channel = [...state.chats, ...state.channels].find(
      (item) =>
        item.id === payload.value.trim() ||
        item.link?.trim().toLowerCase() === normalizedLink ||
        item.link?.trim().toLowerCase() === payload.value.trim().toLowerCase(),
    );

    if (!channel) {
      throw new Error('Чат или канал по этой ссылке не найден.');
    }

    return resolveRequiredSubscriptionChannelResponseSchema.parse({
      channel: {
        id: channel.id,
        title: channel.title,
        entityType: channel.entityType,
        link: channel.link ?? null,
        participantsCount: null,
        avatarUrl:
          channel.avatarUrl ??
          (channel.entityType === 'chat'
            ? resolveChatAvatarUrl(channel.id, state)
            : resolveChannelAvatarUrl(channel.id, state)),
      },
    });
  }

  if (tail[0] === 'dialog' && tail[1]) {
    const dialogType = channelDialogTypeSchema.parse(tail[1]);

    if (tail.length === 2 && method === 'GET') {
      const bucket = getPreviewDialogBucket(
        state,
        'chat',
        dialogType,
        url.searchParams.get('token'),
      );
      return cloneJson(buildPreviewDialogResponse(chatId, dialogType, bucket, state.me.userId));
    }

    if (tail[2] === 'messages' && method === 'POST') {
      const payload = createChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'chat', dialogType, payload.token);
      const replyTarget = findPreviewDialogMessage(bucket, payload.replyToMessageId);
      const message = buildPreviewDialogMessage({
        id: `chat-${dialogType}-${Date.now()}`,
        type: dialogType,
        text: payload.text,
        authorUserId: state.me.userId,
        authorDisplayName: state.me.displayName ?? state.me.username ?? null,
        avatarUrl: state.me.avatarUrl ?? null,
        createdAt: new Date().toISOString(),
        replyToMessageId: replyTarget?.id ?? null,
        replyTo: replyTarget
          ? {
              messageId: replyTarget.id,
              authorDisplayName: replyTarget.authorDisplayName,
              text: replyTarget.text,
            }
          : null,
        attachments:
          dialogType === 'comments' ? buildPreviewDialogAttachments(payload.attachments) : [],
        reactionGroups: [],
        ...(dialogType === 'suggest'
          ? {
              delivered: true,
              deliveredToUserId: 'preview-admin-2',
              reviewStatus: 'pending',
              textFormat: payload.textFormat,
              hasImage: payload.images.length > 0 || Boolean(payload.imageBase64),
              imageCount: payload.images.length || (payload.imageBase64 ? 1 : 0),
              imageFileName: payload.images[0]?.fileName || payload.imageFileName || null,
              imageFileNames:
                payload.images.length > 0
                  ? payload.images.map((image) => image.fileName)
                  : payload.imageFileName
                    ? [payload.imageFileName]
                    : [],
            }
          : {}),
      });
      bucket.messages.push(message);
      return createChannelDialogMessageResponseSchema.parse({
        ok: true,
        message: decoratePreviewDialogMessageAccess(message, state.me.userId),
      });
    }

    if (tail[2] === 'notifications' && method === 'PUT') {
      const payload = updateChannelDialogNotificationsRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'chat', dialogType, payload.token);
      bucket.notificationScope = payload.scope;
      if (payload.scope === 'all_channels') {
        bucket.allChannelsNotificationMode = payload.mode;
        bucket.allChannelsNotificationExplicit = true;
      } else if (payload.scope === 'channel') {
        bucket.channelNotificationMode = payload.mode;
        bucket.channelNotificationExplicit = true;
      } else {
        bucket.threadNotificationMode = payload.mode;
        bucket.threadNotificationExplicit = true;
        bucket.notificationMode = payload.mode;
      }
      return updateChannelDialogNotificationsResponseSchema.parse({
        ok: true,
        notificationSettings: buildPreviewNotificationSettings(bucket),
      });
    }

    if (tail[2] === 'messages' && tail[3] && method === 'PATCH') {
      const payload = updateChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'chat', dialogType, payload.token);
      const message = updatePreviewDialogMessage(bucket, tail[3], payload.text);
      return updateChannelDialogMessageResponseSchema.parse({
        ok: true,
        message: decoratePreviewDialogMessageAccess(message, state.me.userId),
      });
    }

    if (tail[2] === 'messages' && tail[3] && method === 'DELETE') {
      const payload = deleteChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'chat', dialogType, payload.token);
      deletePreviewDialogMessage(bucket, tail[3]);
      return deleteChannelDialogMessageResponseSchema.parse({
        ok: true,
        deletedMessageId: tail[3],
      });
    }

    if (tail[2] === 'messages' && tail[3] && tail[4] === 'reactions' && method === 'POST') {
      const payload = toggleChannelDialogReactionRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'chat', dialogType, payload.token);
      const message = togglePreviewDialogReaction(bucket, tail[3], payload.emoji);
      return toggleChannelDialogReactionResponseSchema.parse({
        ok: true,
        message: decoratePreviewDialogMessageAccess(message, state.me.userId),
      });
    }
  }

  const vkParsingResponse = handleVkParsingPreviewRequest(
    state,
    'chat',
    chatId,
    tail,
    url,
    method,
    init,
  );
  if (vkParsingResponse.handled) {
    return vkParsingResponse.value;
  }

  if (tail[0] === 'settings' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.chatSettings);
    }

    if (method === 'PUT') {
      state.chatSettings = chatSettingsSchema.parse(parseJsonBody(init));
      return cloneJson(state.chatSettings);
    }
  }

  if (tail[0] === 'settings' && tail[1] === 'apply-section-to-all' && method === 'POST') {
    const payload = parseJsonBody(init) as { section?: string; target?: unknown } | null;
    const target = applySettingsTargetSchema.parse(payload?.target ?? { mode: 'current' });
    const targetChats = resolvePreviewApplyTargetChats(state, chatId, target);
    return applySectionToAllResponseSchema.parse({
      section: payload?.section ?? 'links',
      sourceChatId: chatId,
      updatedChats: targetChats.length,
      appliedChatIds: targetChats.map((item) => item.id),
      targetMode: target.mode,
      favoriteTypes: target.favoriteTypes,
    });
  }

  if (tail[0] === 'settings' && tail[1] === 'apply-section-preview' && method === 'POST') {
    const payload = parseJsonBody(init) as { target?: unknown } | null;
    const target = applySettingsTargetSchema.parse(payload?.target ?? { mode: 'current' });
    const targetChats = resolvePreviewApplyTargetChats(state, chatId, target);
    return applySectionTargetPreviewResponseSchema.parse({
      sourceChatId: chatId,
      targetMode: target.mode,
      favoriteTypes: target.favoriteTypes,
      updatedChats: targetChats.length,
      appliedChatIds: targetChats.map((item) => item.id),
      sampleChats: targetChats.slice(0, 8),
    });
  }

  if (tail[0] === 'rules' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.chatRules);
    }

    if (method === 'PUT') {
      state.chatRules = chatRulesSchema.parse({
        ...state.chatRules,
        ...(parseJsonBody(init) as Record<string, unknown> | null),
      });
      return cloneJson(state.chatRules);
    }
  }

  if (tail[0] === 'rules' && tail[1] === 'publish') {
    if (method === 'POST') {
      const published = createPublishRulesResult(chatId);
      state.chatRules = chatRulesSchema.parse({
        ...state.chatRules,
        publishedMessageId: published.messageId,
        publishedUrl: published.url,
        publishedAt: published.publishedAt,
      });
      return published;
    }

    if (method === 'DELETE') {
      state.chatRules = chatRulesSchema.parse({
        ...state.chatRules,
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
      });
      return cloneJson(state.chatRules);
    }
  }

  if (tail[0] === 'rules' && tail[1] === 'handoff' && method === 'POST') {
    return createBroadcastHandoffResponse();
  }

  if (tail[0] === 'members' && tail[1] && tail[2] === 'profile' && tail[3] === 'handoff') {
    if (method === 'POST') {
      return createBroadcastHandoffResponse();
    }
  }

  if (tail[0] === 'broadcast' && tail[1] === 'handoff') {
    if (method === 'GET') {
      return buildBroadcastHandoffState(state.chatBroadcasts[0] ?? state.channelBroadcasts[0]);
    }

    if (method === 'POST') {
      return createBroadcastHandoffResponse();
    }
  }

  if (tail[0] === 'broadcast' && tail[1] === 'test' && method === 'POST') {
    return sendBroadcastTestResultSchema.parse({
      delivered: true,
      messageId: `preview-broadcast-test-${Date.now()}`,
      chatId: 'preview-private-chat',
      url: null,
    });
  }

  if (tail[0] === 'broadcasts' && tail.length === 1 && method === 'GET') {
    return cloneJson(state.chatBroadcasts.map(buildBroadcastSummary));
  }

  if (tail[0] === 'broadcasts' && tail[1] && tail.length === 2) {
    const details = findBroadcast(state.chatBroadcasts, tail[1]);
    if (!details) {
      throw new Error(`Preview broadcast not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return cloneJson(details);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const updated = managedBroadcastDetailsSchema.parse({
        ...details,
        ...(payload ?? {}),
        updatedAt: new Date().toISOString(),
      });
      state.chatBroadcasts = state.chatBroadcasts.map((item) =>
        item.id === details.id ? updated : item,
      );
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      const canceled = managedBroadcastDetailsSchema.parse({
        ...details,
        status: 'CANCELED',
        cycleEnabled: false,
        canRetry: false,
        updatedAt: new Date().toISOString(),
      });
      state.chatBroadcasts = state.chatBroadcasts.map((item) =>
        item.id === details.id ? canceled : item,
      );
      return cloneJson(canceled);
    }
  }

  if (tail[0] === 'broadcasts' && tail[1] && tail[2] === 'retry' && method === 'POST') {
    const details = findBroadcast(state.chatBroadcasts, tail[1]);
    if (!details) {
      throw new Error(`Preview broadcast not found: ${tail[1]}`);
    }

    const retried = managedBroadcastDetailsSchema.parse({
      ...details,
      status: 'ACTIVE',
      failedChats: 0,
      pendingChats: 0,
      canRetry: false,
      lastError: null,
      updatedAt: new Date().toISOString(),
    });
    state.chatBroadcasts = state.chatBroadcasts.map((item) =>
      item.id === details.id ? retried : item,
    );
    return cloneJson(retried);
  }

  if (tail[0] === 'domain-allowlist' && tail[1] === 'details' && method === 'GET') {
    return cloneJson(state.chatDomains);
  }

  if (tail[0] === 'domain-allowlist' && tail.length === 1 && method === 'POST') {
    const payload = parseJsonBody(init) as {
      domain?: string;
      matchType?: 'EXACT' | 'DOMAIN';
    } | null;
    const domain = payload?.domain?.trim();
    const matchType = payload?.matchType === 'DOMAIN' ? 'DOMAIN' : 'EXACT';
    if (!domain) {
      throw new Error('Preview domain is required');
    }

    const normalizedValue = matchType === 'DOMAIN' ? `domain:${domain}` : domain;
    if (!state.chatDomains.some((item) => item.normalizedValue === normalizedValue)) {
      state.chatDomains = [
        domainAllowlistEntrySchema.parse({
          domain,
          normalizedValue,
          matchType,
          removeAfterAt: null,
        }),
        ...state.chatDomains,
      ];
    }
    return null;
  }

  if (tail[0] === 'domain-allowlist' && tail.length === 1 && method === 'DELETE') {
    const domain = url.searchParams.get('domain')?.trim();
    if (!domain) {
      throw new Error('Preview domain is required');
    }
    state.chatDomains = state.chatDomains.filter((item) => item.normalizedValue !== domain);
    return null;
  }

  if (tail[0] === 'domain-allowlist' && tail[1] && tail.length === 2 && method === 'DELETE') {
    const domain = decodeURIComponent(tail[1]);
    state.chatDomains = state.chatDomains.filter((item) => item.normalizedValue !== domain);
    return null;
  }

  if (
    tail[0] === 'domain-allowlist' &&
    tail[1] === 'removal-schedule' &&
    tail.length === 2 &&
    method === 'PUT'
  ) {
    const domain = url.searchParams.get('domain')?.trim();
    if (!domain) {
      throw new Error('Preview domain is required');
    }
    const payload = parseJsonBody(init) as { removeAfterAt?: string | null } | null;
    state.chatDomains = state.chatDomains.map((item) =>
      item.normalizedValue === domain
        ? domainAllowlistEntrySchema.parse({
            ...item,
            removeAfterAt: payload?.removeAfterAt ?? null,
          })
        : item,
    );
    return null;
  }

  if (
    tail[0] === 'domain-allowlist' &&
    tail[1] &&
    tail[2] === 'removal-schedule' &&
    method === 'PUT'
  ) {
    const domain = decodeURIComponent(tail[1]);
    const payload = parseJsonBody(init) as { removeAfterAt?: string | null } | null;
    state.chatDomains = state.chatDomains.map((item) =>
      item.normalizedValue === domain
        ? domainAllowlistEntrySchema.parse({
            ...item,
            removeAfterAt: payload?.removeAfterAt ?? null,
          })
        : item,
    );
    return null;
  }

  if (tail[0] === 'giveaways' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.chatGiveaways.map(buildGiveawaySummary));
    }

    if (method === 'POST') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const draft = createDraftGiveaway('chat', chatId);
      const created = managedGiveawayDetailsSchema.parse({
        ...draft,
        ...(payload ?? {}),
        prizes: normalizePreviewGiveawayPrizes((payload ?? draft).prizes),
        sourceChatId: chatId,
        updatedAt: new Date().toISOString(),
      });
      state.chatGiveaways = upsertGiveaway(state.chatGiveaways, created);
      return cloneJson(created);
    }
  }

  if (
    tail[0] === 'giveaways' &&
    tail[1] === 'required-channels' &&
    tail[2] === 'resolve' &&
    method === 'POST'
  ) {
    const payload = resolveRequiredSubscriptionChannelRequestSchema.parse(parseJsonBody(init));
    const normalizedValue = payload.value.trim().toLowerCase();
    const normalizedLink = normalizedValue.startsWith('http')
      ? normalizedValue
      : normalizedValue.startsWith('max.ru/')
        ? `https://${normalizedValue}`
        : normalizedValue;
    const channel = state.channels.find(
      (item) =>
        item.id === payload.value.trim() ||
        item.link?.trim().toLowerCase() === normalizedLink ||
        item.link?.trim().toLowerCase() === payload.value.trim().toLowerCase(),
    );

    if (!channel) {
      throw new Error('Канал по этой ссылке не найден.');
    }

    return resolveRequiredSubscriptionChannelResponseSchema.parse({
      channel: {
        id: channel.id,
        title: channel.title,
        entityType: 'channel',
        link: channel.link ?? null,
        participantsCount: null,
      },
    });
  }

  if (tail[0] === 'giveaways' && tail[1] && tail.length === 2) {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return cloneJson(details);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const updated = managedGiveawayDetailsSchema.parse({
        ...details,
        ...(payload ?? {}),
        prizes: normalizePreviewGiveawayPrizes((payload ?? details).prizes),
        sourceChatId: chatId,
        updatedAt: new Date().toISOString(),
      });
      state.chatGiveaways = upsertGiveaway(state.chatGiveaways, updated);
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      state.chatGiveaways = state.chatGiveaways.filter((item) => item.id !== details.id);
      return null;
    }
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'publish' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const published = managedGiveawayDetailsSchema.parse({
      ...details,
      status: details.startsAt ? 'SCHEDULED' : 'ACTIVE',
      publishedAt: new Date().toISOString(),
      publicationMessageId: `giveaway-${Date.now()}`,
      publicationUrl: 'https://max.ru/giveaway/published-preview',
      updatedAt: new Date().toISOString(),
    });
    state.chatGiveaways = upsertGiveaway(state.chatGiveaways, published);
    return cloneJson(published);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'close' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const completed = managedGiveawayDetailsSchema.parse({
      ...details,
      status: 'COMPLETED',
      completedAt: new Date().toISOString(),
      winnersCount: details.prizes.length,
      resultsMessageId: `giveaway-results-${Date.now()}`,
      resultsUrl: 'https://max.ru/giveaway/results-preview',
      updatedAt: new Date().toISOString(),
    });
    state.chatGiveaways = upsertGiveaway(state.chatGiveaways, completed);
    return cloneJson(completed);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'cancel' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const canceled = managedGiveawayDetailsSchema.parse({
      ...details,
      status: 'CANCELED',
      updatedAt: new Date().toISOString(),
    });
    state.chatGiveaways = upsertGiveaway(state.chatGiveaways, canceled);
    return cloneJson(canceled);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'reroll' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'deliver' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaway' && tail[1] === 'handoff' && method === 'POST') {
    return createBroadcastHandoffResponse();
  }

  if (tail[0] === 'logs-dashboard' && method === 'GET') {
    const range = (url.searchParams.get('range') as LogsDashboardRange | null) ?? '7d';
    return cloneJson(
      buildLogsDashboard(state, chatId, range, {
        includeActivityPreview: url.searchParams.get('includeActivityPreview') !== 'false',
        includeModerationPreview: url.searchParams.get('includeModerationPreview') !== 'false',
      }),
    );
  }

  if (tail[0] === 'moderation-dashboard' && method === 'GET') {
    const range = (url.searchParams.get('range') as LogsDashboardRange | null) ?? '7d';
    return cloneJson(
      buildLogsDashboard(state, chatId, range, {
        includeActivityPreview: false,
        includeModerationPreview: true,
      }),
    );
  }

  if (tail[0] === 'activity-dashboard' && method === 'GET') {
    const range = (url.searchParams.get('range') as LogsDashboardRange | null) ?? '7d';
    return cloneJson(
      buildLogsDashboard(state, chatId, range, {
        includeActivityPreview: true,
        includeModerationPreview: false,
      }),
    );
  }

  if (tail[0] === 'moderation-feed' && method === 'GET') {
    return cloneJson(
      buildModerationFeedPage(
        state.chatViolations,
        {
          range: (url.searchParams.get('range') as LogsDashboardRange | null) ?? '7d',
          filter: (url.searchParams.get('filter') as ModerationFeedFilter | null) ?? 'ALL',
          limit: Number.parseInt(url.searchParams.get('limit') ?? '50', 10),
          cursor: url.searchParams.get('cursor'),
        },
        new Date(),
      ),
    );
  }

  if (tail[0] === 'activity-feed' && method === 'GET') {
    return cloneJson(
      buildActivityPage(
        state.chatActivity,
        {
          range: (url.searchParams.get('range') as MembershipActivityRange | null) ?? '7d',
          filter: (url.searchParams.get('filter') as MembershipActivityFilter | null) ?? 'all',
          limit: Number.parseInt(url.searchParams.get('limit') ?? '50', 10),
          cursor: url.searchParams.get('cursor'),
        },
        new Date(),
      ),
    );
  }

  if (tail[0] === 'spammer-review' && tail[1] === 'metrics' && method === 'GET') {
    return cloneJson(buildPreviewSpammerReviewMetrics(state.spammerReviewCandidates));
  }

  if (tail[0] === 'spammer-diagnostics' && tail[1] && method === 'GET') {
    const includeProfile =
      url.searchParams.get('includeProfile') !== 'false' &&
      url.searchParams.get('includeProfiles') !== 'false';
    return cloneJson(
      buildPreviewSpammerDiagnostics(
        state.spammerReviewCandidates,
        chatId,
        decodeURIComponent(tail[1]),
        includeProfile,
      ),
    );
  }

  if (tail[0] === 'spammer-review' && tail.length === 1 && method === 'GET') {
    const status = url.searchParams.get('status') ?? 'PENDING';
    const limit = Math.max(
      1,
      Math.min(Number.parseInt(url.searchParams.get('limit') ?? '50', 10), 100),
    );
    const items = state.spammerReviewCandidates
      .filter((candidate) => status === 'ALL' || candidate.status === status)
      .slice(0, limit);
    return cloneJson(
      globalSpammerReviewQueueSchema.parse({
        items,
        limit,
      }),
    );
  }

  if (tail[0] === 'spammer-review' && tail[1] && method === 'POST') {
    const userId = decodeURIComponent(tail[1]);
    const payload = globalSpammerReviewRequestSchema.parse(
      parseJsonBody(init) as GlobalSpammerReviewRequest,
    );
    return cloneJson(
      createPreviewSpammerReviewResult(state.spammerReviewCandidates, userId, payload),
    );
  }

  if (tail[0] === 'members' && method === 'GET') {
    const now = new Date();
    return cloneJson(
      buildParticipantsPage(
        state.chatParticipants,
        {
          range: (url.searchParams.get('range') as LogsDashboardRange | null) ?? '7d',
          limit: Number.parseInt(url.searchParams.get('limit') ?? '100', 10),
          cursor: url.searchParams.get('cursor'),
          search: url.searchParams.get('search'),
        },
        state.chatParticipants.length,
        state.chatViolations,
        now,
      ),
    );
  }

  if (tail[0] === 'members' && tail[1] === 'unavailable-cleanup' && method === 'POST') {
    const payload = chatUnavailableParticipantsCleanupRequestSchema.parse(
      parseJsonBody(init) as ChatUnavailableParticipantsCleanupRequest,
    );
    return cloneJson(
      chatUnavailableParticipantsCleanupResultSchema.parse({
        ok: true,
        dryRun: payload.dryRun,
        scannedCount: state.chatParticipants.length,
        matchedCount: 0,
        removedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        scanLimitReached: false,
        items: [],
        message: 'Безопасных кандидатов не найдено.',
      }),
    );
  }

  if (tail[0] === 'members' && tail[1] && tail[2] === 'moderation-action' && method === 'POST') {
    const userId = decodeURIComponent(tail[1]);
    const payload = manualModerationActionRequestSchema.parse(parseJsonBody(init));
    const user = resolvePreviewUser(state, userId);
    state.chatViolations = [createManualViolation(userId, user, payload), ...state.chatViolations];
    return createModerationResult(userId, payload);
  }

  if (tail[0] === 'members' && tail[1] && tail[2] === 'immunity' && method === 'PUT') {
    const userId = decodeURIComponent(tail[1]);
    const payload = chatParticipantImmunityUpdateRequestSchema.parse(
      parseJsonBody(init) as ChatParticipantImmunityUpdateRequest,
    );
    const immunity = payload.enabled
      ? payload.mode === 'always'
        ? createPreviewAlwaysImmunity()
        : createPreviewImmunity(payload.durationHours!, payload.dailyViolationLimit!)
      : null;

    state.chatParticipants = state.chatParticipants.map((item) =>
      item.userId === userId
        ? {
            ...item,
            immunity,
          }
        : item,
    );

    return chatParticipantImmunityUpdateResultSchema.parse({
      immunity,
      message: payload.enabled ? 'Иммунитет обновлён.' : 'Иммунитет снят.',
    });
  }

  throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
}

async function handleChannelRequest(
  state: PreviewState,
  channelId: string,
  tail: string[],
  url: URL,
  method: string,
  init?: RequestInit,
): Promise<unknown> {
  if (tail[0] === 'header' && method === 'GET') {
    const assignedBots = buildPreviewAssignedBots({
      primaryBotId: state.channelPrimaryBotId,
      assistEnabled: state.channelPartnerAssistEnabled,
    });

    return {
      id: channelId,
      title: resolveChannelTitle(channelId, state),
      entityType: 'channel',
      link: 'https://max.ru/channels/yuzhnoe-news',
      participantsCount: state.channelHeaderParticipantsCount,
      avatarUrl: resolveChannelAvatarUrl(channelId, state),
      primaryBotId: state.channelPrimaryBotId,
      assignedBots,
      sharedMode: buildPreviewSharedMode(state.channelPartnerAssistEnabled),
      botCount: assignedBots.length,
      hasSharedAutomation: assignedBots.length > 1,
    };
  }

  if (tail[0] === 'settings-screen' && method === 'GET') {
    return cloneJson(buildChannelSettingsScreen(state, channelId));
  }

  if (tail[0] === 'bots' && tail[1] === 'plan' && method === 'GET') {
    return cloneJson(buildPreviewBotExecutionPlan(state, 'channel', channelId));
  }

  if (tail[0] === 'bots' && tail[1] === 'primary' && method === 'POST') {
    const payload = updateManagedEntityPrimaryBotRequestSchema.parse(parseJsonBody(init));
    state.channelPrimaryBotId = payload.botId;
    return cloneJson(buildPreviewBotExecutionPlan(state, 'channel', channelId));
  }

  if (tail[0] === 'bots' && tail[1] === 'partner-assist' && method === 'POST') {
    const payload = updateManagedEntityPartnerAssistRequestSchema.parse(parseJsonBody(init));
    state.channelPartnerAssistEnabled =
      payload.enabled && payload.botId.trim() === PREVIEW_STANDBY_BOT_ID;
    return cloneJson(buildPreviewBotExecutionPlan(state, 'channel', channelId));
  }

  const vkParsingResponse = handleVkParsingPreviewRequest(
    state,
    'channel',
    channelId,
    tail,
    url,
    method,
    init,
  );
  if (vkParsingResponse.handled) {
    return vkParsingResponse.value;
  }

  if (tail[0] === 'dialog' && tail[1]) {
    if (tail[1] === 'suggest' && tail[2] === 'redirect' && method === 'GET') {
      const token = url.searchParams.get('token')?.trim() ?? '';
      return channelSuggestionRedirectResponseSchema.parse({
        url: `https://max.ru/id613002203036_bot?start=${encodeURIComponent(
          token ? `preview-suggest-${channelId}-${token}` : `preview-suggest-${channelId}`,
        )}`,
        title: resolveChannelTitle(channelId, state),
      });
    }

    const dialogType = channelDialogTypeSchema.parse(tail[1]);

    if (tail.length === 2 && method === 'GET') {
      const bucket = getPreviewDialogBucket(
        state,
        'channel',
        dialogType,
        url.searchParams.get('token'),
      );
      return cloneJson(buildPreviewDialogResponse(channelId, dialogType, bucket, state.me.userId));
    }

    if (tail[2] === 'messages' && method === 'POST') {
      const payload = createChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'channel', dialogType, payload.token);
      const replyTarget = findPreviewDialogMessage(bucket, payload.replyToMessageId);
      const message = buildPreviewDialogMessage({
        id: `channel-${dialogType}-${Date.now()}`,
        type: dialogType,
        text: payload.text,
        authorUserId: state.me.userId,
        authorDisplayName: state.me.displayName ?? state.me.username ?? null,
        avatarUrl: state.me.avatarUrl ?? null,
        createdAt: new Date().toISOString(),
        replyToMessageId: replyTarget?.id ?? null,
        replyTo: replyTarget
          ? {
              messageId: replyTarget.id,
              authorDisplayName: replyTarget.authorDisplayName,
              text: replyTarget.text,
            }
          : null,
        attachments:
          dialogType === 'comments' ? buildPreviewDialogAttachments(payload.attachments) : [],
        reactionGroups: [],
        ...(dialogType === 'suggest'
          ? {
              delivered: true,
              deliveredToUserId: 'preview-admin-2',
              reviewStatus: 'pending',
              textFormat: payload.textFormat,
              hasImage: payload.images.length > 0 || Boolean(payload.imageBase64),
              imageCount: payload.images.length || (payload.imageBase64 ? 1 : 0),
              imageFileName: payload.images[0]?.fileName || payload.imageFileName || null,
              imageFileNames:
                payload.images.length > 0
                  ? payload.images.map((image) => image.fileName)
                  : payload.imageFileName
                    ? [payload.imageFileName]
                    : [],
            }
          : {}),
      });
      bucket.messages.push(message);
      return createChannelDialogMessageResponseSchema.parse({
        ok: true,
        message: decoratePreviewDialogMessageAccess(message, state.me.userId),
      });
    }

    if (tail[2] === 'notifications' && method === 'PUT') {
      const payload = updateChannelDialogNotificationsRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'channel', dialogType, payload.token);
      bucket.notificationScope = payload.scope;
      if (payload.scope === 'all_channels') {
        bucket.allChannelsNotificationMode = payload.mode;
        bucket.allChannelsNotificationExplicit = true;
      } else if (payload.scope === 'channel') {
        bucket.channelNotificationMode = payload.mode;
        bucket.channelNotificationExplicit = true;
      } else {
        bucket.threadNotificationMode = payload.mode;
        bucket.threadNotificationExplicit = true;
        bucket.notificationMode = payload.mode;
      }
      return updateChannelDialogNotificationsResponseSchema.parse({
        ok: true,
        notificationSettings: buildPreviewNotificationSettings(bucket),
      });
    }

    if (tail[2] === 'messages' && tail[3] && method === 'PATCH') {
      const payload = updateChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'channel', dialogType, payload.token);
      const message = updatePreviewDialogMessage(bucket, tail[3], payload.text);
      return updateChannelDialogMessageResponseSchema.parse({
        ok: true,
        message: decoratePreviewDialogMessageAccess(message, state.me.userId),
      });
    }

    if (tail[2] === 'messages' && tail[3] && method === 'DELETE') {
      const payload = deleteChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'channel', dialogType, payload.token);
      deletePreviewDialogMessage(bucket, tail[3]);
      return deleteChannelDialogMessageResponseSchema.parse({
        ok: true,
        deletedMessageId: tail[3],
      });
    }

    if (tail[2] === 'messages' && tail[3] && tail[4] === 'reactions' && method === 'POST') {
      const payload = toggleChannelDialogReactionRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'channel', dialogType, payload.token);
      const message = togglePreviewDialogReaction(bucket, tail[3], payload.emoji);
      return toggleChannelDialogReactionResponseSchema.parse({
        ok: true,
        message: decoratePreviewDialogMessageAccess(message, state.me.userId),
      });
    }
  }

  if (tail[0] === 'settings' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.channelSettings);
    }

    if (method === 'PUT') {
      state.channelSettings = channelSettingsSchema.parse(parseJsonBody(init));
      return cloneJson(state.channelSettings);
    }
  }

  if (tail[0] === 'broadcast' && tail[1] === 'handoff') {
    if (method === 'GET') {
      return buildBroadcastHandoffState(state.channelBroadcasts[0] ?? state.chatBroadcasts[0]);
    }

    if (method === 'POST') {
      return createBroadcastHandoffResponse();
    }
  }

  if (tail[0] === 'broadcast' && tail[1] === 'test' && method === 'POST') {
    return sendBroadcastTestResultSchema.parse({
      delivered: true,
      messageId: `preview-channel-broadcast-test-${Date.now()}`,
      chatId: 'preview-private-chat',
      url: null,
    });
  }

  if (tail[0] === 'members' && tail[1] && tail[2] === 'profile' && tail[3] === 'handoff') {
    if (method === 'POST') {
      return createBroadcastHandoffResponse();
    }
  }

  if (tail[0] === 'broadcasts' && tail.length === 1 && method === 'GET') {
    return cloneJson(state.channelBroadcasts.map(buildBroadcastSummary));
  }

  if (tail[0] === 'broadcasts' && tail[1] && tail.length === 2) {
    const details = findBroadcast(state.channelBroadcasts, tail[1]);
    if (!details) {
      throw new Error(`Preview broadcast not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return cloneJson(details);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const updated = managedBroadcastDetailsSchema.parse({
        ...details,
        ...(payload ?? {}),
        updatedAt: new Date().toISOString(),
      });
      state.channelBroadcasts = state.channelBroadcasts.map((item) =>
        item.id === details.id ? updated : item,
      );
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      const canceled = managedBroadcastDetailsSchema.parse({
        ...details,
        status: 'CANCELED',
        cycleEnabled: false,
        canRetry: false,
        updatedAt: new Date().toISOString(),
      });
      state.channelBroadcasts = state.channelBroadcasts.map((item) =>
        item.id === details.id ? canceled : item,
      );
      return cloneJson(canceled);
    }
  }

  if (tail[0] === 'broadcasts' && tail[1] && tail[2] === 'retry' && method === 'POST') {
    const details = findBroadcast(state.channelBroadcasts, tail[1]);
    if (!details) {
      throw new Error(`Preview broadcast not found: ${tail[1]}`);
    }

    const retried = managedBroadcastDetailsSchema.parse({
      ...details,
      status: 'ACTIVE',
      failedChats: 0,
      pendingChats: 0,
      canRetry: false,
      lastError: null,
      updatedAt: new Date().toISOString(),
    });
    state.channelBroadcasts = state.channelBroadcasts.map((item) =>
      item.id === details.id ? retried : item,
    );
    return cloneJson(retried);
  }

  if (tail[0] === 'engagement-publish' && method === 'POST') {
    return createPublishEngagementResult(channelId);
  }

  if (tail[0] === 'polls' && tail.length === 1) {
    if (method === 'GET') {
      const query = managedPollListQuerySchema.parse({
        cursor: url.searchParams.get('cursor') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
      });
      const polls = [...state.channelPolls].sort(
        (left, right) =>
          new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime() ||
          right.id.localeCompare(left.id),
      );
      const cursorIndex = query.cursor ? polls.findIndex((poll) => poll.id === query.cursor) : -1;
      const page = polls.slice(cursorIndex + 1, cursorIndex + 1 + query.limit);
      const lastPoll = page.at(-1);
      const lastIndex = lastPoll ? polls.findIndex((poll) => poll.id === lastPoll.id) : -1;
      return cloneJson(
        managedPollListResponseSchema.parse({
          items: page,
          nextCursor: lastPoll && lastIndex < polls.length - 1 ? lastPoll.id : null,
        }),
      );
    }

    if (method === 'POST') {
      if (state.channelPolls.some((poll) => poll.status !== 'CLOSED')) {
        throw new Error('Сначала завершите текущий опрос.');
      }
      const payload = createManagedPollRequestSchema.parse(parseJsonBody(init));
      const nowIso = new Date().toISOString();
      const pollId = `poll-preview-${Date.now()}`;
      const created = managedPollDetailsSchema.parse({
        id: pollId,
        channelId,
        question: payload.question,
        questionFormat: payload.questionFormat,
        images: payload.images,
        imageCount: payload.images.length,
        status: 'DRAFT',
        visibility: payload.visibility,
        totalVotes: 0,
        options: payload.options.map((option, index) => ({
          id: `${pollId}-option-${index + 1}`,
          position: index,
          text: option.text,
          votes: 0,
          percent: 0,
        })),
        publicationPending: false,
        publicationNeedsReview: false,
        renderRepairNeeded: false,
        publicationUrl: null,
        publicationMessageId: null,
        publishedAt: null,
        closedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        lastError: null,
        lastRenderError: null,
      });
      state.channelPolls = [created, ...state.channelPolls];
      return cloneJson(created);
    }
  }

  if (tail[0] === 'polls' && tail[1] && tail[2] === 'voters' && method === 'GET') {
    const poll = state.channelPolls.find((item) => item.id === tail[1]);
    if (!poll) {
      throw new Error(`Preview poll not found: ${tail[1]}`);
    }
    if (poll.visibility !== 'OPEN') {
      throw new Error('Анонимный опрос не раскрывает участников.');
    }

    const query = managedPollVotersQuerySchema.parse({
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });
    const items = state.channelPollVoters.filter((voter) => voter.pollId === poll.id);
    const cursorIndex = query.cursor ? items.findIndex((voter) => voter.id === query.cursor) : -1;
    const page = items.slice(cursorIndex + 1, cursorIndex + 1 + query.limit);
    const lastItem = page.at(-1);
    const lastIndex = lastItem ? items.findIndex((voter) => voter.id === lastItem.id) : -1;
    return managedPollVotersResponseSchema.parse({
      items: page,
      nextCursor: lastItem && lastIndex < items.length - 1 ? lastItem.id : null,
    });
  }

  if (tail[0] === 'polls' && tail[1] && tail[2] === 'publish' && method === 'POST') {
    const poll = state.channelPolls.find((item) => item.id === tail[1]);
    if (!poll) {
      throw new Error(`Preview poll not found: ${tail[1]}`);
    }
    if (poll.status !== 'DRAFT' || poll.publicationPending) {
      throw new Error('Опубликовать можно только свободный черновик.');
    }
    const published = managedPollDetailsSchema.parse({
      ...poll,
      status: 'ACTIVE',
      publicationPending: false,
      publicationNeedsReview: false,
      renderRepairNeeded: false,
      publicationUrl: 'https://max.ru/channels/yuzhnoe-news',
      publicationMessageId: `poll-preview-message-${Date.now()}`,
      publishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    state.channelPolls = state.channelPolls.map((item) =>
      item.id === published.id ? published : item,
    );
    return cloneJson(published);
  }

  if (tail[0] === 'polls' && tail[1] && tail[2] === 'close' && method === 'POST') {
    const poll = state.channelPolls.find((item) => item.id === tail[1]);
    if (!poll) {
      throw new Error(`Preview poll not found: ${tail[1]}`);
    }
    if (poll.status === 'DRAFT') {
      throw new Error('Черновик ещё не опубликован.');
    }
    const closed = managedPollDetailsSchema.parse({
      ...poll,
      status: 'CLOSED',
      renderRepairNeeded: false,
      lastRenderError: null,
      closedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    state.channelPolls = state.channelPolls.map((item) => (item.id === closed.id ? closed : item));
    return cloneJson(closed);
  }

  if (tail[0] === 'polls' && tail[1] && tail[2] === 'refresh' && method === 'POST') {
    const poll = state.channelPolls.find((item) => item.id === tail[1]);
    if (!poll) {
      throw new Error(`Preview poll not found: ${tail[1]}`);
    }
    if (poll.status === 'DRAFT') {
      throw new Error('Черновик ещё не опубликован.');
    }
    const refreshed = managedPollDetailsSchema.parse({
      ...poll,
      renderRepairNeeded: false,
      lastRenderError: null,
      updatedAt: new Date().toISOString(),
    });
    state.channelPolls = state.channelPolls.map((item) =>
      item.id === refreshed.id ? refreshed : item,
    );
    return cloneJson(refreshed);
  }

  if (tail[0] === 'polls' && tail[1] && tail[2] === 'reset-publication' && method === 'POST') {
    const poll = state.channelPolls.find((item) => item.id === tail[1]);
    if (!poll) {
      throw new Error(`Preview poll not found: ${tail[1]}`);
    }
    if (!poll.publicationNeedsReview) {
      throw new Error('Публикация не требует сброса.');
    }
    const reset = managedPollDetailsSchema.parse({
      ...poll,
      publicationPending: false,
      publicationNeedsReview: false,
      lastError: null,
      updatedAt: new Date().toISOString(),
    });
    state.channelPolls = state.channelPolls.map((item) => (item.id === reset.id ? reset : item));
    return cloneJson(reset);
  }

  if (tail[0] === 'polls' && tail[1] && tail.length === 2) {
    const poll = state.channelPolls.find((item) => item.id === tail[1]);
    if (!poll) {
      throw new Error(`Preview poll not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return cloneJson(poll);
    }

    if (method === 'PUT') {
      if (poll.status !== 'DRAFT' || poll.publicationPending) {
        throw new Error('Опубликованный опрос нельзя изменить.');
      }
      const payload = updateManagedPollRequestSchema.parse(parseJsonBody(init));
      const questionFormat = payload.questionFormat ?? poll.questionFormat;
      const images = payload.images ?? poll.images;
      const optionIds = new Set(poll.options.map((option) => option.id));
      if (payload.options.some((option) => option.id && !optionIds.has(option.id))) {
        throw new Error('Вариант ответа больше не существует.');
      }
      const updated = managedPollDetailsSchema.parse({
        ...poll,
        question: payload.question,
        questionFormat,
        images,
        imageCount: images.length,
        visibility: payload.visibility,
        options: payload.options.map((option, index) => ({
          id: option.id ?? `${poll.id}-option-${index + 1}`,
          position: index,
          text: option.text,
          votes: 0,
          percent: 0,
        })),
        totalVotes: 0,
        updatedAt: new Date().toISOString(),
      });
      state.channelPolls = state.channelPolls.map((item) =>
        item.id === updated.id ? updated : item,
      );
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      if (poll.status !== 'DRAFT') {
        throw new Error('Удалить можно только черновик.');
      }
      state.channelPolls = state.channelPolls.filter((item) => item.id !== poll.id);
      return null;
    }
  }

  if (tail[0] === 'giveaways' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.channelGiveaways.map(buildGiveawaySummary));
    }

    if (method === 'POST') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const draft = createDraftGiveaway('channel', channelId);
      const created = managedGiveawayDetailsSchema.parse({
        ...draft,
        ...(payload ?? {}),
        prizes: normalizePreviewGiveawayPrizes((payload ?? draft).prizes),
        sourceChatId: channelId,
        entityType: 'channel',
        updatedAt: new Date().toISOString(),
      });
      state.channelGiveaways = upsertGiveaway(state.channelGiveaways, created);
      return cloneJson(created);
    }
  }

  if (
    tail[0] === 'giveaways' &&
    tail[1] === 'required-channels' &&
    tail[2] === 'resolve' &&
    method === 'POST'
  ) {
    const payload = resolveRequiredSubscriptionChannelRequestSchema.parse(parseJsonBody(init));
    const normalizedValue = payload.value.trim().toLowerCase();
    const normalizedLink = normalizedValue.startsWith('http')
      ? normalizedValue
      : normalizedValue.startsWith('max.ru/')
        ? `https://${normalizedValue}`
        : normalizedValue;
    const channel = state.channels.find(
      (item) =>
        item.id === payload.value.trim() ||
        item.link?.trim().toLowerCase() === normalizedLink ||
        item.link?.trim().toLowerCase() === payload.value.trim().toLowerCase(),
    );

    if (!channel) {
      throw new Error('Канал по этой ссылке не найден.');
    }

    return resolveRequiredSubscriptionChannelResponseSchema.parse({
      channel: {
        id: channel.id,
        title: channel.title,
        entityType: 'channel',
        link: channel.link ?? null,
        participantsCount: null,
      },
    });
  }

  if (tail[0] === 'giveaways' && tail[1] && tail.length === 2) {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return cloneJson(details);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const updated = managedGiveawayDetailsSchema.parse({
        ...details,
        ...(payload ?? {}),
        prizes: normalizePreviewGiveawayPrizes((payload ?? details).prizes),
        sourceChatId: channelId,
        entityType: 'channel',
        updatedAt: new Date().toISOString(),
      });
      state.channelGiveaways = upsertGiveaway(state.channelGiveaways, updated);
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      state.channelGiveaways = state.channelGiveaways.filter((item) => item.id !== details.id);
      return null;
    }
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'publish' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const published = managedGiveawayDetailsSchema.parse({
      ...details,
      status: details.startsAt ? 'SCHEDULED' : 'ACTIVE',
      publishedAt: new Date().toISOString(),
      publicationMessageId: `giveaway-channel-${Date.now()}`,
      publicationUrl: 'https://max.ru/giveaway/channel-preview',
      updatedAt: new Date().toISOString(),
    });
    state.channelGiveaways = upsertGiveaway(state.channelGiveaways, published);
    return cloneJson(published);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'close' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const completed = managedGiveawayDetailsSchema.parse({
      ...details,
      status: 'COMPLETED',
      completedAt: new Date().toISOString(),
      winnersCount: details.prizes.length,
      resultsMessageId: `giveaway-channel-results-${Date.now()}`,
      resultsUrl: 'https://max.ru/giveaway/channel-results-preview',
      updatedAt: new Date().toISOString(),
    });
    state.channelGiveaways = upsertGiveaway(state.channelGiveaways, completed);
    return cloneJson(completed);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'cancel' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const canceled = managedGiveawayDetailsSchema.parse({
      ...details,
      status: 'CANCELED',
      updatedAt: new Date().toISOString(),
    });
    state.channelGiveaways = upsertGiveaway(state.channelGiveaways, canceled);
    return cloneJson(canceled);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'reroll' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'deliver' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaway' && tail[1] === 'handoff' && method === 'POST') {
    return createBroadcastHandoffResponse();
  }

  if (tail[0] === 'stats' && method === 'GET') {
    const range = (url.searchParams.get('range') as ChannelStatsRange | null) ?? '7d';
    const mode = (url.searchParams.get('mode') as ChannelStatsMode | null) ?? undefined;
    return cloneJson(
      buildChannelStats(state, channelId, range, {
        includeActivityPreview: url.searchParams.get('includeActivityPreview') !== 'false',
        mode,
      }),
    );
  }

  if (tail[0] === 'activity-feed' && method === 'GET') {
    return cloneJson(
      buildActivityPage(
        state.channelActivity,
        {
          range: (url.searchParams.get('range') as MembershipActivityRange | null) ?? '7d',
          filter: (url.searchParams.get('filter') as MembershipActivityFilter | null) ?? 'all',
          limit: Number.parseInt(url.searchParams.get('limit') ?? '50', 10),
          cursor: url.searchParams.get('cursor'),
        },
        new Date(),
      ),
    );
  }

  throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
}

function throwPreviewPublicationError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function assertPreviewPublicationRevision(
  publication: PublicationDetails,
  expectedRevision: number,
): void {
  if (publication.version !== expectedRevision) {
    throwPreviewPublicationError(
      'PUBLICATION_REVISION_CONFLICT',
      'Публикация уже изменилась. Обновите экран и повторите.',
    );
  }
}

function hasPreviewPublicationScheduleConflict(
  state: PreviewState,
  request: Pick<CreatePublicationRequest, 'audience' | 'schedule' | 'intent'>,
  excludedPublicationId: string | null = null,
): boolean {
  if (request.intent !== 'publish' || !request.schedule || request.schedule.mode === 'now') {
    return false;
  }
  const incomingSlots = new Set(
    buildPreviewPublicationSlots(request.schedule, new Date()).map((slot) => Date.parse(slot)),
  );
  const incomingTargets = new Set(
    request.audience.targets.map((target) => `${target.entityType}:${target.chatId}`),
  );
  return state.publications.some((publication) => {
    if (
      publication.id === excludedPublicationId ||
      publication.lifecycle === 'COMPLETED' ||
      publication.lifecycle === 'CANCELED'
    ) {
      return false;
    }
    const sharesTarget = publication.targets.some((target) =>
      incomingTargets.has(`${target.entityType}:${target.chatId}`),
    );
    return (
      sharesTarget &&
      publication.occurrences.some(
        (occurrence) =>
          (occurrence.status === 'SCHEDULED' || occurrence.status === 'IN_PROGRESS') &&
          incomingSlots.has(Date.parse(occurrence.scheduledAt)),
      )
    );
  });
}

function assertPreviewPublicationScheduleAvailability(
  state: PreviewState,
  request: Pick<CreatePublicationRequest, 'audience' | 'schedule' | 'intent'>,
  excludedPublicationId: string | null = null,
): void {
  const replaceConflicts =
    request.schedule &&
    request.schedule.mode !== 'now' &&
    request.schedule.replaceConflicts === true;
  if (
    !replaceConflicts &&
    hasPreviewPublicationScheduleConflict(state, request, excludedPublicationId)
  ) {
    throwPreviewPublicationError(
      'PUBLICATION_SCHEDULE_CONFLICT',
      'Это время уже занято другой публикацией.',
    );
  }
}

function buildPreviewPublicationContentInput(
  publication: PublicationDetails,
): PublicationContentInput {
  return {
    text: publication.content.text,
    textFormat: publication.content.textFormat,
    buttons: publication.content.buttons,
    media: publication.content.media.map((asset) => ({
      type: asset.type === 'video' ? ('video-ref' as const) : ('image-ref' as const),
      assetId: asset.id,
    })),
  };
}

function replacePreviewPublication(
  state: PreviewState,
  current: PublicationDetails | null,
  request: Omit<CreatePublicationRequest, 'requestId'>,
): PublicationDetails {
  const id = current?.id ?? `publication-preview-${Date.now()}-${state.publications.length + 1}`;
  const built = buildPreviewPublicationDetails(state, request, {
    id,
    version: current ? current.version + 1 : 1,
    createdAt: current?.createdAt,
    updatedAt: new Date().toISOString(),
    retainedAssets: current?.content.media,
  });
  if (current) {
    const oldOccurrenceIds = new Set(current.occurrences.map((occurrence) => occurrence.id));
    state.publicationDeliveries = state.publicationDeliveries.filter(
      (delivery) => !oldOccurrenceIds.has(delivery.occurrenceId),
    );
    state.publications = state.publications.map((publication) =>
      publication.id === current.id ? built.publication : publication,
    );
  } else {
    state.publications = [built.publication, ...state.publications];
  }
  state.publicationDeliveries.push(...built.deliveries);
  return syncPreviewPublication(state, id);
}

function handlePublicationsRequest(
  state: PreviewState,
  segments: string[],
  url: URL,
  method: string,
  init: RequestInit,
) {
  if (segments.length === 1) {
    if (method === 'GET') {
      const query = listPublicationsQuerySchema.parse(Object.fromEntries(url.searchParams));
      const cursor = query.cursor ? decodePublicationListCursor(query.cursor) : null;
      if (
        query.cursor &&
        (!cursor ||
          cursor.view !== query.view ||
          cursor.query !== query.query ||
          cursor.entityType !== query.entityType ||
          cursor.status !== query.status)
      ) {
        throw new Error('Preview publication cursor is invalid.');
      }
      const lifecycleMatches = (publication: PublicationDetails) =>
        query.view === 'drafts'
          ? publication.lifecycle === 'DRAFT'
          : query.view === 'history'
            ? publication.lifecycle === 'COMPLETED' || publication.lifecycle === 'CANCELED'
            : publication.lifecycle === 'ACTIVE' ||
              publication.lifecycle === 'PAUSED' ||
              publication.lifecycle === 'ERROR';
      const scheduleMatches = (publication: PublicationDetails) =>
        query.view !== 'schedules' ||
        publication.schedule?.mode === 'slots' ||
        publication.schedule?.mode === 'recurrence';
      const entityMatches = (publication: PublicationDetails) => {
        if (!query.entityType || publication.audienceSelection === 'ALL_MANAGED') {
          return true;
        }
        if (query.entityType === 'chat' && publication.audienceSelection === 'ALL_CHATS') {
          return true;
        }
        if (query.entityType === 'channel' && publication.audienceSelection === 'ALL_CHANNELS') {
          return true;
        }
        return publication.targets.some((target) => target.entityType === query.entityType);
      };
      const statusMatches = (publication: PublicationDetails) => {
        if (!query.status) {
          return true;
        }
        if (query.status === 'active') {
          return publication.lifecycle === 'ACTIVE';
        }
        if (query.status === 'paused') {
          return publication.lifecycle === 'PAUSED';
        }
        if (query.status === 'completed') {
          return publication.lifecycle === 'COMPLETED' || publication.lifecycle === 'CANCELED';
        }
        return (
          publication.lifecycle === 'ERROR' ||
          publication.delivery.failed > 0 ||
          publication.delivery.ambiguous > 0
        );
      };
      const normalizedQuery = query.query.toLocaleLowerCase('ru-RU');
      const filtered = state.publications
        .filter(lifecycleMatches)
        .filter(scheduleMatches)
        .filter(entityMatches)
        .filter(statusMatches)
        .filter((publication) => {
          if (!normalizedQuery) {
            return true;
          }
          return [
            publication.title,
            publication.content.text,
            ...publication.targets.map((target) => target.title),
          ].some((value) => value.toLocaleLowerCase('ru-RU').includes(normalizedQuery));
        })
        .sort((left, right) => {
          const updatedAtDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
          if (updatedAtDifference !== 0) {
            return updatedAtDifference;
          }
          if (left.id === right.id) {
            return 0;
          }
          return left.id < right.id ? 1 : -1;
        })
        .filter((publication) => {
          if (!cursor) {
            return true;
          }
          const updatedAt = Date.parse(publication.updatedAt);
          const cursorUpdatedAt = Date.parse(cursor.updatedAt);
          return (
            updatedAt < cursorUpdatedAt ||
            (updatedAt === cursorUpdatedAt && publication.id < cursor.id)
          );
        });
      const page = filtered.slice(0, query.limit);
      const last = page.at(-1);
      return listPublicationsResponseSchema.parse({
        items: page,
        nextCursor:
          page.length < filtered.length && last
            ? encodePublicationListCursor({
                v: 1,
                updatedAt: last.updatedAt,
                id: last.id,
                view: query.view,
                query: query.query,
                entityType: query.entityType,
                status: query.status,
              })
            : null,
      });
    }

    if (method === 'POST') {
      const payload = createPublicationRequestSchema.parse(parseJsonBody(init));
      assertPreviewPublicationScheduleAvailability(state, payload);
      return cloneJson(replacePreviewPublication(state, null, payload));
    }
  }

  if (segments.length === 2 && segments[1] === 'test' && method === 'POST') {
    testPublicationRequestSchema.parse(parseJsonBody(init));
    return null;
  }

  const publicationId = segments[1] ? decodeURIComponent(segments[1]) : '';
  const publication = state.publications.find((item) => item.id === publicationId);
  if (!publication) {
    throw new Error(`Preview publication not found: ${publicationId}`);
  }

  if (segments.length === 2 && method === 'GET') {
    return cloneJson(syncPreviewPublication(state, publicationId));
  }

  if (segments.length === 2 && method === 'PUT') {
    const payload = updatePublicationRequestSchema.parse(parseJsonBody(init));
    assertPreviewPublicationRevision(publication, payload.expectedRevision);
    const audience = payload.audience ?? {
      selection: publication.audienceSelection,
      mode: publication.audienceMode,
      targets: publication.targets.map((target) => ({
        chatId: target.chatId,
        entityType: target.entityType,
      })),
    };
    const request: Omit<CreatePublicationRequest, 'requestId'> = {
      title: payload.title ?? publication.title,
      content: payload.content ?? buildPreviewPublicationContentInput(publication),
      audience,
      schedule:
        payload.schedule === undefined
          ? readPreviewScheduleInput(publication.schedule)
          : payload.schedule,
      intent: payload.intent ?? (publication.lifecycle === 'DRAFT' ? 'draft' : 'publish'),
    };
    assertPreviewPublicationScheduleAvailability(state, request, publication.id);
    return cloneJson(replacePreviewPublication(state, publication, request));
  }

  if (segments.length === 2 && method === 'DELETE') {
    const payload = publicationActionRequestSchema.parse(parseJsonBody(init));
    assertPreviewPublicationRevision(publication, payload.expectedRevision);
    publication.lifecycle = 'CANCELED';
    publication.version += 1;
    publication.updatedAt = new Date().toISOString();
    if (publication.schedule) {
      publication.schedule.status = 'CANCELED';
      publication.schedule.nextOccurrenceAt = null;
      publication.schedule.revision += 1;
    }
    const occurrenceIds = new Set(publication.occurrences.map((occurrence) => occurrence.id));
    for (const delivery of state.publicationDeliveries) {
      if (
        occurrenceIds.has(delivery.occurrenceId) &&
        (delivery.status === 'PENDING' || delivery.status === 'SENDING')
      ) {
        delivery.status = 'CANCELED';
      }
    }
    for (const occurrence of publication.occurrences) {
      if (occurrence.status === 'SCHEDULED' || occurrence.status === 'IN_PROGRESS') {
        occurrence.status = 'CANCELED';
      }
    }
    return cloneJson(syncPreviewPublication(state, publicationId));
  }

  if (segments[2] === 'deliveries' && segments.length === 3 && method === 'GET') {
    const query = listPublicationDeliveriesQuerySchema.parse(Object.fromEntries(url.searchParams));
    const occurrenceIds = new Set(publication.occurrences.map((occurrence) => occurrence.id));
    const filtered = state.publicationDeliveries.filter(
      (delivery) =>
        occurrenceIds.has(delivery.occurrenceId) &&
        (!query.occurrenceId || delivery.occurrenceId === query.occurrenceId) &&
        (!query.status || delivery.status === query.status) &&
        (!query.excludeStatus || delivery.status !== query.excludeStatus),
    );
    const cursorIndex = query.cursor
      ? filtered.findIndex((delivery) => delivery.id === query.cursor)
      : -1;
    const pageStart = cursorIndex >= 0 ? cursorIndex + 1 : 0;
    const page = filtered.slice(pageStart, pageStart + query.limit);
    return listPublicationDeliveriesResponseSchema.parse({
      items: page,
      nextCursor: pageStart + page.length < filtered.length ? (page.at(-1)?.id ?? null) : null,
    });
  }

  if (
    segments.length === 3 &&
    (segments[2] === 'pause' || segments[2] === 'resume' || segments[2] === 'cancel') &&
    method === 'POST'
  ) {
    const payload = publicationActionRequestSchema.parse(parseJsonBody(init));
    assertPreviewPublicationRevision(publication, payload.expectedRevision);
    publication.version += 1;
    publication.updatedAt = new Date().toISOString();
    if (segments[2] === 'pause') {
      publication.lifecycle = 'PAUSED';
      if (publication.schedule) {
        publication.schedule.status = 'PAUSED';
        publication.schedule.revision += 1;
      }
    } else if (segments[2] === 'resume') {
      publication.lifecycle = 'ACTIVE';
      if (publication.schedule) {
        publication.schedule.status = 'ACTIVE';
        publication.schedule.revision += 1;
      }
    } else {
      publication.lifecycle = 'CANCELED';
      if (publication.schedule) {
        publication.schedule.status = 'CANCELED';
        publication.schedule.nextOccurrenceAt = null;
        publication.schedule.revision += 1;
      }
      const occurrenceIds = new Set(publication.occurrences.map((occurrence) => occurrence.id));
      for (const delivery of state.publicationDeliveries) {
        if (
          occurrenceIds.has(delivery.occurrenceId) &&
          (delivery.status === 'PENDING' || delivery.status === 'SENDING')
        ) {
          delivery.status = 'CANCELED';
        }
      }
      for (const occurrence of publication.occurrences) {
        if (occurrence.status === 'SCHEDULED' || occurrence.status === 'IN_PROGRESS') {
          occurrence.status = 'CANCELED';
        }
      }
    }
    return cloneJson(syncPreviewPublication(state, publicationId));
  }

  if (
    segments.length === 5 &&
    segments[2] === 'occurrences' &&
    segments[4] === 'retry' &&
    method === 'POST'
  ) {
    retryPublicationOccurrenceRequestSchema.parse(parseJsonBody(init));
    const occurrenceId = decodeURIComponent(segments[3] ?? '');
    const occurrence = publication.occurrences.find((item) => item.id === occurrenceId);
    if (!occurrence) {
      throw new Error(`Preview publication occurrence not found: ${occurrenceId}`);
    }
    for (const delivery of state.publicationDeliveries) {
      if (delivery.occurrenceId === occurrenceId && delivery.status === 'FAILED') {
        delivery.status = 'SENT';
        delivery.attemptCount += 1;
        delivery.remoteMessageId = `preview-retry-${Date.now()}`;
        delivery.lastError = null;
        delivery.sentAt = new Date().toISOString();
      }
    }
    publication.updatedAt = new Date().toISOString();
    return cloneJson(syncPreviewPublication(state, publicationId));
  }

  if (
    segments.length === 5 &&
    segments[2] === 'occurrences' &&
    segments[4] === 'resolve-ambiguous' &&
    method === 'POST'
  ) {
    const payload = resolvePublicationAmbiguousDeliveryRequestSchema.parse(parseJsonBody(init));
    const occurrenceId = decodeURIComponent(segments[3] ?? '');
    const delivery = state.publicationDeliveries.find(
      (item) =>
        item.id === payload.deliveryId &&
        item.occurrenceId === occurrenceId &&
        item.status === 'AMBIGUOUS',
    );
    if (!delivery) {
      throw new Error(`Preview ambiguous delivery not found: ${payload.deliveryId}`);
    }
    if (payload.resolution === 'mark_sent') {
      delivery.status = 'SENT';
      delivery.remoteMessageId = delivery.remoteMessageId ?? `preview-resolved-${Date.now()}`;
      delivery.sentAt = delivery.sentAt ?? new Date().toISOString();
      delivery.lastError = null;
    } else {
      delivery.status = 'FAILED';
      delivery.lastError = 'Отмечено как неотправленное.';
    }
    publication.updatedAt = new Date().toISOString();
    return cloneJson(syncPreviewPublication(state, publicationId));
  }

  throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
}

function handleAutopostRulesRequest(
  state: PreviewState,
  segments: string[],
  url: URL,
  method: string,
  init: RequestInit,
) {
  if (segments.length === 1) {
    if (method === 'GET') {
      const entityType = url.searchParams.get('entityType');
      const status = url.searchParams.get('status');
      const sourceChatId = url.searchParams.get('sourceChatId');
      return cloneJson(
        state.autopostRules.filter((rule) => {
          if (rule.status === 'DISABLED') {
            return false;
          }
          if (
            (entityType === 'chat' || entityType === 'channel') &&
            rule.entityType !== entityType
          ) {
            return false;
          }
          if (status && rule.status !== status) {
            return false;
          }
          if (sourceChatId && rule.sourceChatId !== sourceChatId) {
            return false;
          }
          return true;
        }),
      );
    }

    if (method === 'POST') {
      const payload = createManagedAutopostHubRuleRequestSchema.parse(parseJsonBody(init));
      const created = buildPreviewAutopostRule(state, {
        id: `autopost-preview-${Date.now()}`,
        sourceChatId: payload.sourceChatId,
        entityType: payload.entityType,
        title: payload.title,
        payload: payload.payload,
      });
      state.autopostRules = [created, ...state.autopostRules];
      return cloneJson(created);
    }
  }

  const ruleId = segments[1] ? decodeURIComponent(segments[1]) : '';
  const existing = ruleId ? findAutopostRule(state.autopostRules, ruleId) : null;
  if (!existing) {
    throw new Error(`Preview autopost rule not found: ${ruleId}`);
  }

  if (segments.length === 2 && method === 'GET') {
    return cloneJson(existing);
  }

  if (segments.length === 2 && method === 'PUT') {
    const payload = updateManagedAutopostRuleRequestSchema.parse(parseJsonBody(init));
    const updated = buildPreviewAutopostRule(state, {
      id: existing.id,
      sourceChatId: existing.sourceChatId,
      entityType: existing.entityType,
      title: payload.title ?? existing.title,
      payload: payload.payload ?? existing.payload,
      status: payload.status ?? existing.status,
      revision: existing.revision + (payload.payload ? 1 : 0),
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    });
    state.autopostRules = state.autopostRules.map((rule) =>
      rule.id === existing.id ? updated : rule,
    );
    return cloneJson(updated);
  }

  if (segments.length === 2 && method === 'DELETE') {
    const disabled = managedAutopostHubRuleDetailsSchema.parse({
      ...existing,
      status: 'DISABLED',
      updatedAt: new Date().toISOString(),
    });
    state.autopostRules = state.autopostRules.map((rule) =>
      rule.id === existing.id ? disabled : rule,
    );
    return cloneJson(disabled);
  }

  throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
}

export function createPreviewApiTransport(): ApiTransport {
  const state = createInitialState();

  return {
    async request(path: string, init: RequestInit = {}) {
      const url = new URL(path, 'https://preview.local');
      const method = (init.method ?? 'GET').toUpperCase();

      if (url.pathname === '/me' && method === 'GET') {
        return cloneJson(state.me);
      }

      if (url.pathname === '/system/dashboard' && method === 'GET') {
        return systemDashboardResponseSchema.parse(buildPreviewSystemDashboard(state));
      }

      if (url.pathname === '/system/bots' && method === 'GET') {
        return systemBotsSnapshotSchema.parse(buildPreviewSystemBots(state));
      }

      if (url.pathname === '/system/bots/routes/preview' && method === 'GET') {
        return buildPreviewSystemBotRoutePreview(state, url);
      }

      if (url.pathname === '/system/mode' && method === 'POST') {
        const parsedBody = JSON.parse(String(init.body ?? '{}')) as { mode?: unknown };
        const mode = parsedBody.mode;
        if (mode !== 'auto' && mode !== 'normal' && mode !== 'degrade') {
          throw new Error('Preview transport received invalid system mode payload');
        }
        state.systemModeSelection = mode;
        return systemModeSnapshotSchema.parse(buildPreviewSystemMode(state));
      }

      if (url.pathname === '/chats' && method === 'GET') {
        if (url.searchParams.get('includeRefreshState') === '1') {
          return cloneJson(buildPreviewManagedEntitiesResponse(state.chats));
        }
        return cloneJson(state.chats);
      }

      if (url.pathname === '/channels' && method === 'GET') {
        if (url.searchParams.get('includeRefreshState') === '1') {
          return cloneJson(buildPreviewManagedEntitiesResponse(state.channels));
        }
        return cloneJson(state.channels);
      }

      const segments = url.pathname.split('/').filter(Boolean);
      if (segments[0] === 'publications') {
        return handlePublicationsRequest(state, segments, url, method, init);
      }

      if (segments[0] === 'autopost-rules') {
        return handleAutopostRulesRequest(state, segments, url, method, init);
      }

      if (
        segments[0] === 'managed-entities' &&
        segments[1] &&
        segments[2] &&
        segments[3] === 'favorites' &&
        method === 'PUT'
      ) {
        const entityType = segments[1] === 'channel' ? 'channel' : 'chat';
        const entityId = decodeURIComponent(segments[2]);
        const payload = updateManagedEntityFavoritesRequestSchema.parse(parseJsonBody(init));
        updatePreviewManagedEntityFavorites(state, entityType, entityId, payload.favoriteTypes);
        return managedEntityFavoritesResponseSchema.parse({
          entityType,
          entityId,
          favoriteTypes: payload.favoriteTypes,
        });
      }

      if (segments[0] === 'giveaways' && segments[1]) {
        const giveawayId = decodeURIComponent(segments[1]);
        if (giveawayId !== PREVIEW_PUBLIC_GIVEAWAY_ID) {
          throw new Error(`Preview public giveaway not found: ${giveawayId}`);
        }

        const variant = readPreviewGiveawayVariant();
        if (segments.length === 2 && method === 'GET') {
          return cloneJson(buildPreviewPublicGiveaway(state, giveawayId, variant));
        }

        if (segments[2] === 'me' && method === 'GET') {
          return cloneJson(
            buildPreviewGiveawayParticipantState(readPreviewGiveawayParticipantVariant()),
          );
        }

        if (segments[2] === 'enter' && method === 'POST') {
          const nextVariant =
            readPreviewGiveawayEnterResult() ??
            (variant === 'blocked' ? 'blocked-entered' : variant);
          writePreviewGiveawayParticipantVariant(nextVariant);
          return cloneJson(buildPreviewGiveawayParticipantState(nextVariant));
        }

        if (segments[2] === 'claim' && method === 'POST') {
          writePreviewGiveawayParticipantVariant('winner-claimed');
          return null;
        }
      }

      if (segments[0] === 'chats' && segments[1]) {
        return handleChatRequest(state, segments[1], segments.slice(2), url, method, init);
      }

      if (segments[0] === 'channels' && segments[1]) {
        return handleChannelRequest(state, segments[1], segments.slice(2), url, method, init);
      }

      throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
    },
    requestKeepalive(path: string, init: RequestInit = {}) {
      void this.request(path, init);
    },
  };
}
