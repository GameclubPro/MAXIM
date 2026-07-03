import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  type Type,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
  ADMIN_BAN_COMMAND_NAME_DEFAULT,
  ADMIN_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_RULES_COMMAND_NAME_DEFAULT,
  DEFAULT_BROADCAST_BUTTON_TEXT,
  INVITATION_ACCESS_REQUIRED_COUNT_MAX,
  INVITATION_ACCESS_REQUIRED_COUNT_MIN,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
  normalizeDeleteBotMessagesDelayMinutes,
  type MaxUpdate,
} from '@maxim/contracts';
import {
  getBotSpeechEditableTemplate,
  getBotSpeechSystemTemplate,
  type BotSpeechEditableFieldKey,
  type BotSpeechMediaFieldKey,
  type BotSpeechStyle,
  type BotSpeechSystemTemplateKey,
} from '@maxim/contracts/bot-speech';
import {
  ChatBotMembershipStatus,
  ChatCatalogKind,
  ChatEntityType,
  EventType,
  Operator,
  Prisma,
  SanctionAction,
  WebhookStatus,
  type ChannelAutoPostAttachStatus,
  type ChannelSettings as PersistedChannelSettings,
  type ChatSettings,
} from '../prisma/prisma-client';
import type { Job } from 'bullmq';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxActionDispatchOptions,
  type MaxChatMemberAccess,
  type MaxLinkButton,
  type MaxMessageButton,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { MaxBotContextService } from '../max/max-bot-context.service';
import { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import {
  isValidMaxBotStartPayload,
  isValidMaxMiniappStartPayload,
} from '../max/max-deep-link.util';
import {
  MaxBotLinkService,
  type ChatBotExecutionBinding,
  type MaxBotRoute,
  type MaxBotRouteRequest,
} from '../max/max-bot-link.service';
import {
  ManagedEntityAccessLossService,
} from '../max/managed-entity-access-loss.service';
import { MaxMembershipLookupService } from '../max/max-membership-lookup.service';
import { AdminDialogLinkService } from '../admin/admin-dialog-link.service';
import { ManualModerationService } from '../admin/manual-moderation.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  appendAdminContactMarkdownLink as appendAdminContactMarkdownLinkText,
  resolveAdminContactMentionTarget,
} from '../common/admin-contact-link.util';
import { renderSupportedMarkdownAsHtml } from '../common/max-markdown.util';
import {
  BOT_PRIVATE_MENU_APP_LINE,
  buildBotStartQuickActionText,
} from '../common/bot-start-greeting';
import { raceWithTimeout } from '../common/promise-timeout.util';
import { buildUserAgreementShortNotice } from '../common/user-agreement-notice';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { moderationBackgroundTasksEnabled } from '../runtime/moderation-runtime';
import { QueueMetricsService } from '../system/queue-metrics.service';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import {
  SystemModeService,
  isSystemModeRecoveryWindow,
  type SystemModeSnapshot,
} from '../system/system-mode.service';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { ModerationExecutionService } from './moderation-execution.service';
import { PrivateControlService } from './private-control.service';
import { ModerationAccessService } from './moderation-access.service';
import {
  ACTIVE_MUTE_CACHE_SLACK_SEC,
  ACTIVE_MUTE_NEGATIVE_CACHE_TTL_SEC,
  PERMANENT_ACTIVE_MUTE_CACHE_TTL_SEC,
  buildActiveMuteStateKey,
  type CachedActiveMuteState,
} from './moderation-state.util';
import {
  DEVELOPER_FORCED_GLOBAL_SPAMMER_CACHE_TTL_SEC,
  DEVELOPER_FORCED_GLOBAL_SPAMMER_MEMORY_CACHE_TTL_MS,
  DEVELOPER_FORCED_GLOBAL_SPAMMER_WARM_MARKER_TTL_SEC,
  buildDeveloperForcedGlobalSpammerCacheKey,
  buildDeveloperForcedGlobalSpammerWarmMarkerKey,
} from './developer-forced-global-spammer-cache';
import { buildModerationEscalationCounterKey } from './moderation-escalation-state.util';
import {
  buildMessageLimitsBlockedReason,
  extractMessageLimitsBlockedToken,
  isMessageLimitsBlockedListRuleCode,
} from './message-limits-blocked-reason.util';
import { RedisCounterService } from './redis-counter.service';
import type {
  DuplicateAction,
  DuplicateDecision,
  DuplicateHit,
  RuleViolation,
} from './rule-engine.contract';
import { RuleEngineService } from './rule-engine.service';
import { createAllowlistLinkMatcher, detectBlockedLink } from './rule-engine-link-detector';
import { MessageLimitsBlockedDomainDetector } from './rule-engine-blocked-domains.detector';
import {
  ANTI_SPAM_BURST_LIMIT,
  ANTI_SPAM_BURST_WINDOW_SEC,
} from './rule-engine-message-limits.detector';
import { SanctionService } from './sanction.service';
import { maskText } from './text-mask.util';
import {
  calculateEffectiveMessageLength,
  collectForwardedNodes,
  detectMediaFlags,
  extractRawMessageNode,
  shouldSkipAntiSpamBurstForForward,
} from './moderation-update-extractors';
import {
  dedupeForwardedModerationTargets,
  dedupeForwardedRulesSources,
  extractDirectIncomingMessageText,
  extractForwardedModerationTargets,
  extractForwardedRulesSources,
  getAdminCommandName,
  parseAdminForwardedModerationCommand,
} from './admin-forwarded-command.util';
import {
  readExecutionOwnerBotId as readExecutionOwnerBotIdFromUpdate,
  resolveAutoAttachBotId as resolveAutoAttachBotIdForModeration,
  resolveChatReadBotId as resolveChatReadBotIdForModeration,
  resolveModerationActionBotIds as resolveModerationActionBotIdsForModeration,
  resolveNightModeTransitionBotId as resolveNightModeTransitionBotIdForModeration,
  resolveUnifiedBotRoute as resolveUnifiedBotRouteForModeration,
} from './moderation-bot-routing.util';
import {
  COMMERCIAL_CAMPAIGN_WINDOW_SEC,
  COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC,
  buildCommercialCampaignFingerprint,
  buildCommercialCampaignDomainChatsKey,
  buildCommercialCampaignHandleChatsKey,
  buildCommercialCampaignLinkChatsKey,
  buildCommercialCampaignPhoneChatsKey,
  buildCommercialCampaignSenderChatsKey,
  buildCommercialCampaignSenderNearTextChatsKey,
  buildCommercialCampaignSenderTextChatsKey,
  buildCommercialCampaignSenderVelocityChatsKey,
  hasCommercialCampaignEvidence,
  normalizeCommercialCampaignSenderId,
  type CommercialCampaignContext,
} from './commercial-campaign.util';
import {
  GlobalSpammerIntelligenceService,
  type GlobalSpammerObservationSource,
} from './global-spammer-intelligence.service';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import { renderMaxTextMarkupAsHtml, type MaxTextMarkup } from '../common/max-text-markup.util';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  JOIN_WEBHOOK_QUEUE_NAMES,
  LEGACY_WEBHOOK_QUEUE,
  type AnyWebhookQueueName,
  type ProcessWebhookJob,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
} from '../webhook/webhook-queues';

import {
  CALLBACK_TERMINAL_FAILURE_METRIC_STATUSES,
  PRIVATE_DIALOG_TERMINAL_FAILURE_METRIC_STATUSES,
  CHAT_DELETE_MESSAGE_PERMISSION_ALIASES,
  DEFAULT_MUTE_DURATION_HOURS,
  MAX_ACTIVE_MUTE_DURATION_HOURS,
  DELETE_MESSAGE_PERMISSION_ALIASES,
  MODERATE_MEMBER_PERMISSION_ALIASES,
  DEFAULT_BOT_BUTTON_TEXT,
  RULES_BOT_BUTTON_TEXT,
  RULES_CALLBACK_PAYLOAD,
  DEFAULT_NIGHT_MODE_TIMEZONE,
  LINK_ESCALATION_WINDOW_HOURS,
  TEXT_FILTER_ESCALATION_WINDOW_HOURS,
  TOPIC_FILTER_ESCALATION_WINDOW_HOURS,
  MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS,
  REQUIRED_SUBSCRIPTION_ESCALATION_WINDOW_HOURS,
  REQUIRED_SUBSCRIPTION_MEMBER_PRESENT_TTL_SEC,
  REQUIRED_SUBSCRIPTION_MEMBER_MISSING_TTL_SEC,
  REQUIRED_SUBSCRIPTION_LOOKUP_BACKOFF_MS,
  REQUIRED_SUBSCRIPTION_NOTICE_COOLDOWN_SEC,
  REQUIRED_SUBSCRIPTION_CHANNEL_METADATA_CACHE_TTL_MS,
  REQUIRED_SUBSCRIPTION_RULE_CODE,
  INVITATION_ACCESS_ESCALATION_WINDOW_HOURS,
  INVITATION_ACCESS_NOTICE_COOLDOWN_SEC,
  INVITATION_ACCESS_RULE_CODE,
  MODERATION_ACTION_PERMISSION_SKIP_LOG_INTERVAL_MS,
  MODERATION_ACTION_PERMISSION_BACKOFF_MS,
  MODERATION_ACTION_PERMISSION_REFRESH_TIMEOUT_MS,
  MODERATION_ACTION_PERMISSION_REFRESH_MIN_INTERVAL_MS,
  REQUIRED_SUBSCRIPTION_UNRESOLVED_LOG_INTERVAL_MS,
  WEBHOOK_HOT_CHAT_BACKOFF_MS,
  WEBHOOK_HOT_CHAT_SKIP_LOG_INTERVAL_MS,
  WEBHOOK_HOT_TIMEOUT_BACKOFF_SUPPRESSED_STAGES,
  REQUIRED_SUBSCRIPTION_PRESSURE_SKIP_QUEUE_LAG_SEC,
  BOT_NOTICE_TOKEN_BUCKET_TTL_SEC,
  DEFAULT_BOT_NOTICE_TOKEN_BUCKET_LIMIT,
  ADMIN_CONTACT_DISPLAY_NAME_CACHE_TTL_MS,
  ADMIN_CONTACT_DISPLAY_NAME_LOOKUP_TIMEOUT_MS,
  CHAT_ADMIN_NONCRITICAL_LOOKUP_SOFT_TIMEOUT_MS,
  DESTRUCTIVE_ADMIN_ROSTER_REFRESH_THROTTLE_MS,
  BACKGROUND_WORK_PAUSE_LOG_INTERVAL_MS,
  LEGACY_MODERATION_CONCURRENCY,
  CRITICAL_MODERATION_CONCURRENCY,
  JOIN_MODERATION_SHARD_CONCURRENCIES,
  DEFAULT_MODERATION_SHARD_CONCURRENCIES,
  BACKGROUND_MODERATION_CONCURRENCY,
  SUPPORT_CHAT_URL,
  MINIAPP_ROUTE_START_PARAM_PREFIX,
  PRIVATE_MENU_CALLBACK_MENU,
  PRIVATE_MENU_CALLBACK_CHATS,
  PRIVATE_MENU_CALLBACK_CHANNELS,
  PRIVATE_MENU_CALLBACK_HELP,
  PRIVATE_BOT_CHATS_PREVIEW_LIMIT,
  MAX_FORWARD_SCAN_DEPTH,
  DEFAULT_CHANNEL_AUTO_POST_SCAN_INTERVAL_MS,
  DEFAULT_CHANNEL_AUTO_POST_SCAN_MAX_CHANNELS,
  DEFAULT_CHANNEL_AUTO_POST_INTER_CHANNEL_DELAY_MS,
  DEFAULT_CHANNEL_AUTO_POST_IDLE_BACKOFF_MAX_MS,
  DEFAULT_CHANNEL_AUTO_POST_STARTUP_DELAY_MS,
  DEFAULT_CHANNEL_AUTO_POST_STARTUP_JITTER_MS,
  DEFAULT_CHANNEL_AUTO_POST_MAX_NEW_MESSAGES_PER_SCAN,
  DEFAULT_CHANNEL_AUTO_POST_REPAIR_SWEEP_MS,
  CHANNEL_AUTO_POST_SLOW_BATCH_DIVISOR,
  CHANNEL_AUTO_POST_SLOW_INTER_CHANNEL_DELAY_MS,
  CHANNEL_AUTO_POST_SLOW_MAX_NEW_MESSAGES_PER_SCAN,
  CHANNEL_AUTO_POST_RATE_LIMIT_BACKOFF_MS,
  DEFAULT_CHANNEL_AUTO_POST_THROTTLE_BACKOFF_MAX_MS,
  DEFAULT_BACKGROUND_WORK_SOFT_PAUSE_QUEUE_LAG_SEC,
  DEFAULT_BACKGROUND_WORK_SOFT_PAUSE_WORKER_SHARE,
  DEFAULT_BACKGROUND_WORK_SOFT_PAUSE_WORKER_PRESSURE,
  CHANNEL_DIALOG_START_PARAM_PREFIX,
  CHANNEL_DIALOG_TOKEN_PREFIX,
  SHARED_CHAT_EXECUTION_LOCK_TTL_MS,
  DEFAULT_SHARED_CHAT_EXECUTION_LOOKUP_TIMEOUT_MS,
  DEFAULT_SHARED_CHAT_EXECUTION_LOCK_TIMEOUT_MS,
  DEFAULT_WEBHOOK_USER_FACING_TIMEOUT_MS,
  WEBHOOK_USER_FACING_SLOW_LOG_THRESHOLD_MS,
  WEBHOOK_OPTIONAL_STAGE_MIN_REMAINING_MS,
  REQUIRED_SUBSCRIPTION_NOTICE_MIN_REMAINING_MS,
  REQUIRED_SUBSCRIPTION_MEMBERSHIP_HOT_PATH_TIMEOUT_MS,
  REQUIRED_SUBSCRIPTION_MEMBERSHIP_MIN_REMAINING_MS,
  REQUIRED_SUBSCRIPTION_FOLLOW_UP_DETACH_MIN_REMAINING_MS,
  REQUIRED_SUBSCRIPTION_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
  VIOLATION_ADMIN_RECHECK_RESERVE_MS,
  VIOLATION_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
  DUPLICATE_FOLLOW_UP_DETACH_MIN_REMAINING_MS,
  DUPLICATE_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
  CHANNEL_DIALOG_AUTO_ATTACH_ACTION,
  CHANNEL_DIALOG_AUTO_ATTACH_SKIP_ACTION,
  CHAT_DIALOG_AUTO_ATTACH_ACTION,
  CHAT_COMMENTS_REPLY_TEXT,
  GLOBAL_SPAMMER_WINDOW_SEC,
  GLOBAL_SPAMMER_REDIS_TTL_SEC,
  GLOBAL_SPAMMER_LOCAL_CHAT_OBSERVATION_TTL_MS,
  GLOBAL_SPAMMER_EXEMPTION_CACHE_TTL_MS,
  GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_TIMEOUT_MS,
  GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_MAX_ADMIN_IDS,
  GLOBAL_SPAMMER_TRACK_HOT_PATH_TIMEOUT_MS,
  DEVELOPER_FORCED_GLOBAL_SPAMMER_HOT_PATH_TIMEOUT_MS,
  MODERATION_ACTION_ACCESS_LOSS_HOT_PATH_TIMEOUT_MS,
  GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS,
  GLOBAL_SPAMMER_EPISODE_LOCK_TTL_SEC,
  GLOBAL_SPAMMER_FANOUT_EPISODE_WINDOW_SEC,
  GLOBAL_SPAMMER_MEDIUM_FANOUT_EPISODE_THRESHOLD,
  GLOBAL_SPAMMER_STRONG_FANOUT_EPISODE_THRESHOLD,
  GLOBAL_SPAMMER_CONFIRMED_FANOUT_EPISODE_THRESHOLD,
  GLOBAL_SPAMMER_CRITICAL_FANOUT_MIN_CHATS,
  CROSS_CHAT_SPAM_ALWAYS_IGNORED_KEYS,
  NON_SANCTION_RULE_CODES,
  MESSAGE_LIMITS_RULE_CODES,
  TEXT_FILTER_RULE_CODES,
  TOPIC_FILTER_RULE_CODES,
  isRequiredSubscriptionCurrentlyActive,
  isInvitationAccessCurrentlyActive,
  type ActiveMute,
  type ActiveMuteCacheReadResult,
  type ChatAdminCheckSource,
  type ChatAdminCheckResult,
  type RequiredSubscriptionChannelMetadata,
  type SharedChatExecutionGuard,
  type RemoteChatAdminAccessState,
  type ManagedChannelContext,
  type ChannelAutoPostMessageText,
  type ChannelAutoPostScanState,
  type ChannelAutoPostExecutionPlan,
  type LocalGlobalSpammerAdminDecision,
  type PendingGlobalSpammerExemptionLookupBatch,
  type WebhookHotPathProfile,
  type RulesButtonReference,
  type RequiredSubscriptionMembershipLookupOptions,
  type InvitationAccessProgressSnapshot,
  type InvitationAccessProgressUpdateResult,
  type InvitationAccessProgressDelegate,
  type ChannelDialogType,
  type ModerationActionAttemptResult,
  type AdminForwardedModerationCommand,
  type GlobalSpammerTrackingResult,
  type PrivateControlCommand,
  type ActiveBotSpeechProfile,
} from './moderation.service.support';
import type {
  NightModeTransitionJob,
  NightModeTransitionProcessResult,
} from './night-mode-transition.queue';
import type { NightModeTransitionSnapshot } from './night-mode-transition-time.util';
import {
  NightModeTransitionRuntimeService,
} from './night-mode-transition-runtime.service';
import { NightModeTransitionDeliveryService } from './night-mode-transition-delivery.service';
import {
  buildNightModeClosedNotice as buildNightModeClosedNoticeText,
  buildNightModeOpenedNotice as buildNightModeOpenedNoticeText,
  formatNightModeMinutesAsTime,
  isNightModeNoticeMessage as isNightModeNoticeTextMessage,
  normalizeNightModeDayMinutes,
} from './night-mode-transition-notice.util';
import {
  buildNightModeClosedNoticeOptions as composeNightModeClosedNoticeOptions,
  buildNightModeCommentsButton,
} from './night-mode-transition-closed-notice-options.util';
import {
  BotSpeechMediaService,
  type BotSpeechMediaUploadOptions,
  type BotSpeechResolvedMedia,
} from './bot-speech-media.service';
import { NightModeTransitionEventService } from './night-mode-transition-event.service';
import { KaravanStorefrontRelayService } from '../integrations/karavan-storefront/karavan-storefront-relay.service';

type ManualModerationCommandBridge = Pick<
  ManualModerationService,
  | 'adoptChatRulesFromMessage'
  | 'applyManualChatSilenceCommand'
  | 'applyManualOpenChatCommand'
  | 'enqueueDeveloperSuperBanCommand'
  | 'enqueueManualGroupModerationCommand'
  | 'isSuperBanDeveloperUserId'
>;

type RequiredSubscriptionMembershipResolution = {
  membership: boolean | null;
  fresh: boolean;
  terminal: boolean;
};

type RequiredSubscriptionMembershipLookupResult = {
  membership: boolean | null;
  terminal: boolean;
};

type RequiredSubscriptionMembershipResult = {
  missingChannelIds: string[];
  unresolvedChannelIds: string[];
  terminalChannelIds: string[];
};

type ChannelAutoPostAttachOutcome = 'attached' | 'skipped' | 'noop' | 'in_progress';

type ChannelAutoPostAttachClaim =
  | {
      status: 'claimed';
      lockToken: string;
    }
  | {
      status: 'done' | 'in_progress';
    };

const CHANNEL_AUTO_POST_ATTACH_STATUS = {
  IN_PROGRESS: 'IN_PROGRESS',
  SUCCEEDED: 'SUCCEEDED',
  SKIPPED: 'SKIPPED',
} as const satisfies Record<string, ChannelAutoPostAttachStatus>;

const CHANNEL_AUTO_POST_ATTACH_LOCK_TTL_MS = 2 * 60_000;

@Injectable()
export class ModerationService implements OnModuleInit, OnModuleDestroy {
  private readonly blockedDomainDetector = new MessageLimitsBlockedDomainDetector();
  private readonly logger = new Logger(ModerationService.name);
  private readonly destructiveAdminRosterRefreshScheduledAtMs = new Map<string, number>();
  private readonly requiredSubscriptionMembershipCache = new Map<
    string,
    {
      expiresAt: number;
      fresh: boolean;
      isMember: boolean;
    }
  >();
  private readonly requiredSubscriptionMembershipInFlight = new Map<
    string,
    Promise<RequiredSubscriptionMembershipLookupResult>
  >();
  private readonly requiredSubscriptionMembershipBackoffUntilMs = new Map<string, number>();
  private readonly requiredSubscriptionUnresolvedLogAtMs = new Map<string, number>();
  private readonly requiredSubscriptionChannelMetadataCache = new Map<
    string,
    {
      expiresAt: number;
      metadata: RequiredSubscriptionChannelMetadata;
    }
  >();
  private readonly moderationActionPermissionSkipLogAtMs = new Map<string, number>();
  private readonly moderationActionBotBackoffUntilMs = new Map<string, number>();
  private readonly moderationActionSnapshotRefreshUntilMs = new Map<string, number>();
  private readonly moderationActionSnapshotRefreshInFlight = new Map<
    string,
    Promise<Set<string>>
  >();
  private readonly globalSpammerLocalChatObservations = new Map<string, number>();
  private readonly developerForcedGlobalSpammerMemoryCache = new Map<string, number>();
  private developerForcedGlobalSpammerWarmUntilMs = 0;
  private developerForcedGlobalSpammerWarmInFlight: Promise<void> | null = null;
  private readonly globalSpammerRegistryTtlMs = 30 * 24 * 60 * 60 * 1000;
  private readonly globalSpammerExemptionCache = new Map<
    string,
    {
      expiresAtMs: number;
      decision: LocalGlobalSpammerAdminDecision | null;
    }
  >();
  private readonly globalSpammerExemptionLookupInFlight = new Map<
    string,
    Promise<LocalGlobalSpammerAdminDecision | null>
  >();
  private readonly pendingGlobalSpammerExemptionLookupBatches = new Map<
    string,
    PendingGlobalSpammerExemptionLookupBatch
  >();
  private readonly webhookHotTimeoutChatBackoffUntilMs = new Map<string, number>();
  private webhookHotChatSkipLogAtMs = 0;
  private readonly ownBotUserId: string | null;
  private readonly ownBotUserIdVariants: Set<string>;
  private readonly adminContactDisplayNameCache = new Map<
    string,
    { value: string | null; expiresAtMs: number }
  >();
  private channelAutoPostTimer: NodeJS.Timeout | null = null;
  private channelAutoPostStartupTimer: NodeJS.Timeout | null = null;
  private readonly channelAutoPostScanState = new Map<string, ChannelAutoPostScanState>();
  private channelAutoPostInFlight = false;
  private channelAutoPostBackoffUntilMs = 0;
  private channelAutoPostThrottleStreak = 0;
  private channelAutoPostPausedLogAtMs = 0;
  private channelAutoPostCursor = 0;
  private readonly appBaseUrl: string | null;
  private readonly blockedJoinChatIds: Set<string>;
  private readonly explicitBotContactId: string | null;
  private readonly maxBotToken: string | null;
  private readonly channelAutoPostScanIntervalMs: number;
  private readonly channelAutoPostScanMaxChannels: number;
  private readonly channelAutoPostInterChannelDelayMs: number;
  private readonly channelAutoPostIdleBackoffMaxMs: number;
  private readonly channelAutoPostStartupDelayMs: number;
  private readonly channelAutoPostStartupJitterMs: number;
  private readonly channelAutoPostMaxNewMessagesPerScan: number;
  private readonly channelAutoPostRepairSweepMs: number;
  private readonly channelAutoPostThrottleBackoffMaxMs: number;
  private readonly requiredSubscriptionLookupConcurrency: number;
  private readonly botNoticeTokenBucketLimit: number;
  private readonly sharedChatExecutionLookupTimeoutMs: number;
  private readonly sharedChatExecutionLockTimeoutMs: number;
  private readonly webhookUserFacingTimeoutMs: number;
  private readonly backgroundTasksEnabled: boolean;
  private readonly backgroundWorkSoftPauseQueueLagSec: number;
  private readonly backgroundWorkSoftPauseWorkerShare: number;
  private readonly backgroundWorkSoftPauseWorkerPressure: number;
  private readonly sharedChatExecutionMemoryLocks = new Map<string, string>();
  private moderationAccessServiceInstance: ModerationAccessService | null = null;
  private nightModeTransitionRuntimeInstance: NightModeTransitionRuntimeService | null = null;
  private nightModeTransitionDeliveryInstance: NightModeTransitionDeliveryService | null = null;
  private botSpeechMediaServiceInstance: BotSpeechMediaService | null = null;
  private nightModeTransitionEventServiceInstance: NightModeTransitionEventService | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ruleEngine: RuleEngineService,
    private readonly sanctionService: SanctionService,
    private readonly maxClient: MaxClientService,
    @Optional() private readonly chatContextCache?: ChatContextCacheService,
    @Optional() private readonly systemModeService?: SystemModeService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly redisCounter?: RedisCounterService,
    @Optional() private readonly privateControlService?: PrivateControlService,
    @Optional() private readonly adminDialogLinkService?: AdminDialogLinkService,
    @Optional() private readonly membershipLookupService?: MaxMembershipLookupService,
    @Optional() private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional() private readonly maxBotContextService?: MaxBotContextService,
    @Optional() private readonly queueMetricsService?: QueueMetricsService,
    @Optional()
    private readonly backgroundRuntimeGovernorService?: BackgroundRuntimeGovernorService,
    @Optional()
    private readonly runtimeDiagnosticsService?: RuntimeDiagnosticsService,
    @Optional()
    private readonly maxChatAdminRosterSyncService?: MaxChatAdminRosterSyncService,
    @Optional()
    private readonly globalSpammerIntelligence?: GlobalSpammerIntelligenceService,
    @Optional()
    private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
    @Optional()
    private readonly injectedModerationAccessService?: ModerationAccessService,
    @Optional()
    private readonly injectedNightModeTransitionRuntime?: NightModeTransitionRuntimeService,
    @Optional()
    private readonly injectedManualModerationService?: ManualModerationService,
    @Optional()
    private readonly injectedNightModeTransitionDelivery?: NightModeTransitionDeliveryService,
    @Optional()
    private readonly injectedBotSpeechMediaService?: BotSpeechMediaService,
    @Optional()
    private readonly injectedNightModeTransitionEventService?: NightModeTransitionEventService,
    @Optional()
    private readonly karavanStorefrontRelayService?: KaravanStorefrontRelayService,
  ) {
    this.maxBotToken = this.normalizeSecret(configService?.get<string>('MAX_BOT_TOKEN'));
    this.ownBotUserId = this.normalizeOwnBotUserId(configService?.get<string>('MAX_BOT_ID'));
    this.ownBotUserIdVariants = this.buildBotIdVariants(this.ownBotUserId);
    this.appBaseUrl = this.normalizeAppBaseUrl(configService?.get<string>('APP_BASE_URL'));
    this.blockedJoinChatIds = this.parseChatIdSet(
      configService?.get<string>('MAX_JOIN_DENY_CHAT_IDS'),
    );
    this.explicitBotContactId = this.normalizeBotContactId(
      configService?.get<string>('MAX_BOT_CONTACT_ID'),
    );
    this.channelAutoPostScanIntervalMs = this.readPositiveConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_SCAN_INTERVAL_MS'),
      DEFAULT_CHANNEL_AUTO_POST_SCAN_INTERVAL_MS,
      1_000,
    );
    this.channelAutoPostScanMaxChannels = this.readNonNegativeConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_SCAN_MAX_CHANNELS'),
      DEFAULT_CHANNEL_AUTO_POST_SCAN_MAX_CHANNELS,
    );
    this.channelAutoPostInterChannelDelayMs = this.readNonNegativeConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_INTER_CHANNEL_DELAY_MS'),
      DEFAULT_CHANNEL_AUTO_POST_INTER_CHANNEL_DELAY_MS,
    );
    this.channelAutoPostIdleBackoffMaxMs = this.readPositiveConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_IDLE_BACKOFF_MAX_MS'),
      DEFAULT_CHANNEL_AUTO_POST_IDLE_BACKOFF_MAX_MS,
      this.channelAutoPostScanIntervalMs,
    );
    this.channelAutoPostStartupDelayMs = this.readNonNegativeConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_STARTUP_DELAY_MS'),
      DEFAULT_CHANNEL_AUTO_POST_STARTUP_DELAY_MS,
    );
    this.channelAutoPostStartupJitterMs = this.readNonNegativeConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_STARTUP_JITTER_MS'),
      DEFAULT_CHANNEL_AUTO_POST_STARTUP_JITTER_MS,
    );
    this.channelAutoPostMaxNewMessagesPerScan = this.readPositiveConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_MAX_NEW_MESSAGES_PER_SCAN'),
      DEFAULT_CHANNEL_AUTO_POST_MAX_NEW_MESSAGES_PER_SCAN,
    );
    this.channelAutoPostRepairSweepMs = this.readPositiveConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_REPAIR_SWEEP_MS'),
      DEFAULT_CHANNEL_AUTO_POST_REPAIR_SWEEP_MS,
      this.channelAutoPostScanIntervalMs,
    );
    this.channelAutoPostThrottleBackoffMaxMs = this.readPositiveConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_THROTTLE_BACKOFF_MAX_MS'),
      DEFAULT_CHANNEL_AUTO_POST_THROTTLE_BACKOFF_MAX_MS,
      CHANNEL_AUTO_POST_RATE_LIMIT_BACKOFF_MS,
    );
    this.requiredSubscriptionLookupConcurrency = this.readPositiveConfigInt(
      configService?.get<number>('REQUIRED_SUBSCRIPTION_LOOKUP_CONCURRENCY'),
      2,
    );
    this.botNoticeTokenBucketLimit = this.readPositiveConfigInt(
      configService?.get<number>('BOT_NOTICE_TOKEN_BUCKET_LIMIT'),
      DEFAULT_BOT_NOTICE_TOKEN_BUCKET_LIMIT,
      1,
    );
    this.sharedChatExecutionLookupTimeoutMs = this.readPositiveConfigInt(
      configService?.get<number>('SHARED_CHAT_EXECUTION_LOOKUP_TIMEOUT_MS'),
      DEFAULT_SHARED_CHAT_EXECUTION_LOOKUP_TIMEOUT_MS,
      100,
    );
    this.sharedChatExecutionLockTimeoutMs = this.readPositiveConfigInt(
      configService?.get<number>('SHARED_CHAT_EXECUTION_LOCK_TIMEOUT_MS'),
      DEFAULT_SHARED_CHAT_EXECUTION_LOCK_TIMEOUT_MS,
      100,
    );
    this.webhookUserFacingTimeoutMs = this.readPositiveConfigInt(
      configService?.get<number>('WEBHOOK_USER_FACING_TIMEOUT_MS'),
      DEFAULT_WEBHOOK_USER_FACING_TIMEOUT_MS,
      1_000,
    );
    this.backgroundTasksEnabled = moderationBackgroundTasksEnabled(
      configService?.get<boolean | string>('MODERATION_BACKGROUND_TASKS_ENABLED'),
    );
    this.backgroundWorkSoftPauseQueueLagSec = this.readPositiveConfigInt(
      configService?.get<number>('BACKGROUND_WORK_SOFT_PAUSE_QUEUE_LAG_SEC'),
      DEFAULT_BACKGROUND_WORK_SOFT_PAUSE_QUEUE_LAG_SEC,
      1,
    );
    this.backgroundWorkSoftPauseWorkerPressure = this.readPositiveConfigInt(
      configService?.get<number>('BACKGROUND_WORK_SOFT_PAUSE_WORKER_PRESSURE'),
      DEFAULT_BACKGROUND_WORK_SOFT_PAUSE_WORKER_PRESSURE,
      1,
    );
    this.backgroundWorkSoftPauseWorkerShare = this.readFractionConfig(
      configService?.get<number>('BACKGROUND_WORK_SOFT_PAUSE_WORKER_SHARE'),
      DEFAULT_BACKGROUND_WORK_SOFT_PAUSE_WORKER_SHARE,
    );
  }

  private get moderationAccessService(): ModerationAccessService {
    if (this.injectedModerationAccessService) {
      return this.injectedModerationAccessService;
    }
    if (!this.moderationAccessServiceInstance) {
      this.moderationAccessServiceInstance = new ModerationAccessService(
        this.prisma,
        this.maxClient,
        this.chatContextCache,
        this.configService,
        this.maxBotLinkService,
        this.runtimeDiagnosticsService,
      );
    }
    return this.moderationAccessServiceInstance;
  }

  private get nightModeTransitionRuntime(): NightModeTransitionRuntimeService {
    if (this.injectedNightModeTransitionRuntime) {
      return this.injectedNightModeTransitionRuntime;
    }
    if (!this.nightModeTransitionRuntimeInstance) {
      this.nightModeTransitionRuntimeInstance = new NightModeTransitionRuntimeService(
        this.prisma,
        this.redisCounter,
      );
    }
    return this.nightModeTransitionRuntimeInstance;
  }

  private get nightModeTransitionDelivery(): NightModeTransitionDeliveryService {
    if (this.injectedNightModeTransitionDelivery) {
      return this.injectedNightModeTransitionDelivery;
    }
    if (!this.nightModeTransitionDeliveryInstance) {
      this.nightModeTransitionDeliveryInstance = new NightModeTransitionDeliveryService(
        this.maxClient,
        this.botSpeechMediaService,
        this.nightModeTransitionEventService,
        this.managedEntityAccessLossService,
      );
    }
    return this.nightModeTransitionDeliveryInstance;
  }

  private get nightModeTransitionEventService(): NightModeTransitionEventService {
    if (this.injectedNightModeTransitionEventService) {
      return this.injectedNightModeTransitionEventService;
    }
    if (!this.nightModeTransitionEventServiceInstance) {
      this.nightModeTransitionEventServiceInstance = new NightModeTransitionEventService(
        this.prisma,
        this.configService,
        this.maxBotContextService,
      );
    }
    return this.nightModeTransitionEventServiceInstance;
  }

  private get botSpeechMediaService(): BotSpeechMediaService {
    if (this.injectedBotSpeechMediaService) {
      return this.injectedBotSpeechMediaService;
    }
    if (!this.botSpeechMediaServiceInstance) {
      this.botSpeechMediaServiceInstance = new BotSpeechMediaService(this.maxClient);
    }
    return this.botSpeechMediaServiceInstance;
  }

  private get manualModerationCommandBridge(): ManualModerationCommandBridge | null {
    return this.injectedManualModerationService ?? null;
  }

  private isSuperBanDeveloperUserId(userId: string | null | undefined): boolean {
    const bridge = this.manualModerationCommandBridge;
    return (
      typeof bridge?.isSuperBanDeveloperUserId === 'function' &&
      bridge.isSuperBanDeveloperUserId(userId) === true
    );
  }

  private createNightModeTransitionHooks() {
    return this.nightModeTransitionDelivery.createHooks({
      getActiveBotSpeechProfile: () => this.resolveActiveBotSpeechProfile(),
      buildClosedNoticeOptions: (settings) =>
        this.buildNightModeClosedNoticeOptions({
          chatId: settings.chatId,
          commentsEnabled: settings.commentsEnabled,
          nightModeCommentsEnabled: settings.nightModeCommentsEnabled,
          nightModeBotButtons: settings.nightModeBotButtons,
          nightModeBotButtonEnabled: settings.nightModeBotButtonEnabled,
          nightModeBotButtonUrl: settings.nightModeBotButtonUrl,
          nightModeBotButtonText: settings.nightModeBotButtonText,
          nightModeRulesButtonEnabled: settings.nightModeRulesButtonEnabled,
          rulesPublishedUrl: settings.chat?.rules?.publishedUrl ?? null,
          rulesPublishedMessageId: settings.chat?.rules?.publishedMessageId ?? null,
        }),
      resolveBotId: (chatId) => this.resolveNightModeTransitionBotId(chatId),
    });
  }

  private withBotModerationEventData(
    data: Prisma.ModerationEventUncheckedCreateInput,
  ): Prisma.ModerationEventUncheckedCreateInput {
    if (data.operator !== Operator.BOT) {
      return data;
    }

    const activeBotId = this.maxBotContextService?.getActiveBotId() ?? null;
    if (!activeBotId || typeof data.botId === 'string') {
      return data;
    }

    return {
      ...data,
      botId: activeBotId,
    };
  }

  private createBotModerationEvent(params: { data: Prisma.ModerationEventUncheckedCreateInput }) {
    return this.prisma.moderationEvent.create({
      data: this.withBotModerationEventData(params.data),
    });
  }

  onModuleInit() {
    if (!roleRunsModeration(getAppRole())) {
      return;
    }
    if (!this.backgroundTasksEnabled) {
      return;
    }

    this.logger.log(
      {
        channelAutoPostScanIntervalMs: this.channelAutoPostScanIntervalMs,
        channelAutoPostScanMaxChannels: this.channelAutoPostScanMaxChannels,
        channelAutoPostIdleBackoffMaxMs: this.channelAutoPostIdleBackoffMaxMs,
        channelAutoPostStartupDelayMs: this.channelAutoPostStartupDelayMs,
        channelAutoPostStartupJitterMs: this.channelAutoPostStartupJitterMs,
        channelAutoPostMaxNewMessagesPerScan: this.channelAutoPostMaxNewMessagesPerScan,
        channelAutoPostRepairSweepMs: this.channelAutoPostRepairSweepMs,
      },
      'Moderation background polling is enabled',
    );

    if (this.channelAutoPostScanMaxChannels > 0) {
      this.channelAutoPostTimer = setInterval(() => {
        void this.processChannelAutoPostButtons();
      }, this.channelAutoPostScanIntervalMs);
      this.channelAutoPostTimer.unref();
      this.scheduleChannelAutoPostStartupScan();
    }
  }

  onModuleDestroy() {
    if (this.channelAutoPostTimer) {
      clearInterval(this.channelAutoPostTimer);
      this.channelAutoPostTimer = null;
    }
    if (this.channelAutoPostStartupTimer) {
      clearTimeout(this.channelAutoPostStartupTimer);
      this.channelAutoPostStartupTimer = null;
    }
  }

  async processWebhookEvent(webhookEventId: string) {
    const webhookEvent = await this.prisma.webhookEvent.findUnique({
      where: { id: webhookEventId },
    });

    if (!webhookEvent) {
      return;
    }

    const update = webhookEvent.normalizedPayload as MaxUpdate;
    const activeBotId =
      (typeof webhookEvent.botId === 'string' && webhookEvent.botId.trim().length > 0
        ? webhookEvent.botId.trim()
        : null) ??
      (typeof update.botId === 'string' && update.botId.trim().length > 0
        ? update.botId.trim()
        : null) ??
      this.maxBotLinkService?.getDefaultBotId?.() ??
      null;
    const normalizedUpdateType = this.readLowerString(update.type);
    if (
      (normalizedUpdateType === 'message_created' || normalizedUpdateType === 'message_edited') &&
      update.message?.chatId
    ) {
      void this.runtimeDiagnosticsService?.recordHotChatMessage({
        chatId: update.message.chatId,
        botId: activeBotId,
      });
    }

    try {
      let hotPathProfile: WebhookHotPathProfile | null = null;
      await this.executeWebhookUpdateWithGuard(
        webhookEvent.id,
        update,
        activeBotId,
        async () => {
          hotPathProfile = this.createWebhookHotPathProfile();
          if (activeBotId && this.maxBotContextService) {
            await this.maxBotContextService.runWithBot(activeBotId, () =>
              this.handleUpdate(update, hotPathProfile!),
            );
          } else {
            await this.handleUpdate(update, hotPathProfile);
          }
        },
        () => this.readWebhookHotPathProfileSnapshot(hotPathProfile),
      );
      await this.prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          status: WebhookStatus.PROCESSED,
          processedAt: new Date(),
          errorMessage: null,
          nextEnqueueAt: null,
        },
      });
    } catch (error: unknown) {
      const recoveredRawPayload =
        update.raw && typeof update.raw === 'object' && !Array.isArray(update.raw)
          ? (update.raw as Record<string, unknown>)
          : null;
      const terminalProcessingError = this.isTerminalWebhookProcessingError(error);

      await this.prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          status: WebhookStatus.FAILED,
          errorMessage: this.formatWebhookProcessingErrorMessage(error),
          nextEnqueueAt: terminalProcessingError ? null : new Date(Date.now() + 15_000),
          ...(recoveredRawPayload
            ? { rawPayload: recoveredRawPayload as Prisma.InputJsonValue }
            : {}),
        },
      });
      throw error;
    }
  }

  async handleUpdate(update: MaxUpdate, hotPathProfile?: WebhookHotPathProfile) {
    if (!update.message) {
      const callbackId = this.extractCallbackId(update);
      if (callbackId) {
        await this.answerCallbackSafe(callbackId, 'Команда принята');
      }
      return;
    }

    const serviceAuthored = this.isServiceAuthoredMessage(update);
    const serviceMembersEvent = this.extractServiceMemberUserIds(update).length > 0;

    const { chatId, chatTitle, senderId, senderName, text, createdAt, messageId } = update.message;
    const sharedChatExecutionGuard = await this.resolveSharedChatExecutionGuard(update, chatId);
    if (sharedChatExecutionGuard.mode === 'blocked-join-check-only') {
      if (await this.handleBlockedBotJoin(update, chatId)) {
        return;
      }

      this.logSharedChatExecutionSkip(update, chatId, sharedChatExecutionGuard);
      return;
    }
    if (sharedChatExecutionGuard.mode === 'skip') {
      this.logSharedChatExecutionSkip(update, chatId, sharedChatExecutionGuard);
      return;
    }

    const sharedChatExecutionAllowGuard =
      sharedChatExecutionGuard.mode === 'allow' ? sharedChatExecutionGuard : null;
    const sharedChatExecutionLock = sharedChatExecutionAllowGuard?.requiresExecutionLock
      ? await this.acquireSharedChatExecutionLock(update, chatId, sharedChatExecutionAllowGuard)
      : null;
    if (sharedChatExecutionAllowGuard?.requiresExecutionLock && !sharedChatExecutionLock) {
      this.logger.debug(
        {
          chatId,
          updateId: update.updateId,
          updateType: this.readLowerString(update.type),
          activeBotId: sharedChatExecutionAllowGuard.activeBotId,
          primaryBotId: sharedChatExecutionAllowGuard.primaryBotId,
        },
        'Skipped duplicate shared chat execution because another bot runtime already owns the update',
      );
      return;
    }

    try {
      if (this.isBotStartedUpdate(update)) {
        await this.handleBotStartedInstruction(update, chatId);
        return;
      }

      if (await this.handleBlockedBotJoin(update, chatId)) {
        return;
      }

      if (this.isBotAddedUpdate(update)) {
        if (!serviceAuthored && !serviceMembersEvent) {
          return;
        }
      }

      if (this.isMembershipLeaveUpdate(update)) {
        return;
      }

      if (this.isPrivateDirectChat(chatId)) {
        if (this.privateControlService) {
          await this.privateControlService.handleUpdate(update);
          return;
        }
        await this.handlePrivateChatControl(update);
        return;
      }

      const callbackId = this.extractCallbackId(update);
      const callbackPayload = this.extractCallbackPayload(update);
      const suggestionPayload =
        callbackPayload && this.adminDialogLinkService
          ? this.adminDialogLinkService.parseChannelSuggestionStartPayload(callbackPayload)
          : null;
      if (callbackId && suggestionPayload && this.privateControlService) {
        const callbackUserId = this.extractCallbackUserId(update) ?? senderId;
        const delivered = await this.privateControlService.openChannelSuggestionFromCallback({
          userId: callbackUserId,
          chatId: suggestionPayload.chatId,
          token: suggestionPayload.token,
        });
        await this.answerCallbackSafe(
          callbackId,
          delivered ? 'Бот написал в личку' : 'Не удалось открыть личку бота',
        );
        return;
      }
      const channelMessage = this.isChannelMessage(update);
      const managedChannel = channelMessage
        ? await this.loadManagedChannelContext(chatId, chatTitle)
        : null;
      if (channelMessage || managedChannel) {
        await this.handleChannelUpdate(update, managedChannel);
        return;
      }

      if (callbackPayload === RULES_CALLBACK_PAYLOAD) {
        await this.handleRulesCallback(chatId, callbackId, update.message?.messageId ?? null);
        return;
      }

      if (serviceAuthored || serviceMembersEvent) {
        const chat = await this.loadChatContext(chatId, chatTitle);
        this.markWebhookHotPathStage(hotPathProfile, 'chat-context');
        const updateType = this.readLowerString(update.type);
        const senderIsOwnBotInMessage =
          updateType === 'message_created' && senderId
            ? this.isCurrentBotSender(senderId, update)
            : false;
        if (senderIsOwnBotInMessage) {
          await this.handleOwnBotMessageAutoDelete({
            chatId,
            userId: senderId,
            messageId,
            text,
            settings: chat.settings,
          });
          return;
        }

        await this.handleServiceMembershipUpdate({
          chatId,
          messageId,
          text,
          update,
          settings: chat.settings,
          adminUserIds: chat.adminUserIds,
          rulesPublishedUrl: chat.rulesPublishedUrl,
          rulesPublishedMessageId: chat.rulesPublishedMessageId,
        });
        return;
      }

      const userLabel = this.formatUserLabel(senderName, senderId);
      const mode = await this.resolveSystemModeSnapshot();
      this.markWebhookHotPathStage(hotPathProfile, 'system-mode');
      const degradeMode = mode.mode === 'degrade';
      const hotChatBackoffActive = this.isWebhookHotTimeoutChatBackoffActive(chatId);
      const chat = await this.loadChatContext(chatId, chatTitle);
      this.markWebhookHotPathStage(hotPathProfile, 'chat-context');
      const settings = this.applyDegradeSettings(chat.settings, degradeMode);
      const manualGroupCloseActiveNow = this.isNightModeForceCloseActiveNow(settings);
      const nightModeActiveNow = !manualGroupCloseActiveNow && this.isNightModeActiveNow(settings);
      const destructiveAccessGateActive = manualGroupCloseActiveNow || nightModeActiveNow;
      const forceSynchronousRemoteAdminLookup = this.shouldForceSynchronousRemoteAdminLookup(
        update,
        settings,
      );
      const keepDestructiveAdminCheckOnHotPath =
        destructiveAccessGateActive && !forceSynchronousRemoteAdminLookup;
      const rulesPublishedUrl = chat.rulesPublishedUrl;
      const rulesPublishedMessageId = chat.rulesPublishedMessageId;

      const updateType = this.readLowerString(update.type);
      const senderIsOwnBotInMessage =
        updateType === 'message_created' && senderId
          ? this.isCurrentBotSender(senderId, update)
          : false;
      if (senderIsOwnBotInMessage) {
        await this.handleOwnBotMessageAutoDelete({
          chatId,
          userId: senderId,
          messageId,
          text,
          settings,
        });
        return;
      }

      if (!senderId) {
        return;
      }

      const senderIsCurrentBot = this.isCurrentBotSender(senderId, update);
      if (this.isKnownRuntimeBotUserId(senderId) && !senderIsCurrentBot) {
        this.logger.debug(
          {
            chatId,
            senderId,
            updateId: update.updateId,
          },
          'Skipped moderation for configured MAX bot user',
        );
        return;
      }

      const senderIsOwnBot = this.isOwnBotSender(senderId);
      const senderIsBot = senderIsOwnBot || senderIsCurrentBot || this.isBotAuthoredMessage(update);
      if (senderIsBot) {
        const senderUsesOwnBotCleanup = senderIsOwnBot || senderIsCurrentBot;
        const mayModerateOtherBotContent =
          (!senderUsesOwnBotCleanup && settings.removeBotsFromGroupEnabled) ||
          (senderUsesOwnBotCleanup && !senderIsCurrentBot && settings.deleteBotMessagesEnabled);
        if (
          !senderIsCurrentBot &&
          mayModerateOtherBotContent &&
          (await this.isOtherBotAdminModerationBypass({
            chatId,
            localAdminUserIds: chat.adminUserIds,
            senderId,
            degradeMode,
            hotChatBackoffActive,
          }))
        ) {
          return;
        }

        if (settings.removeBotsFromGroupEnabled && !senderUsesOwnBotCleanup) {
          await this.handleBotMessage({
            chatId,
            userId: senderId,
            messageId,
            text,
          });
        } else if (senderUsesOwnBotCleanup) {
          await this.handleOwnBotMessageAutoDelete({
            chatId,
            userId: senderId,
            messageId,
            text,
            settings,
          });
        }
        return;
      }

      if (
        messageId &&
        this.isSuperBanDeveloperUserId(senderId) &&
        (await this.handleAdminForwardedModerationCommand({
          update,
          chatId,
          senderId,
          messageId,
          settings,
          superBanOnly: true,
          ...(chatTitle !== undefined ? { chatTitle } : {}),
          ...(senderName !== undefined ? { senderName } : {}),
        }))
      ) {
        return;
      }

      this.markWebhookHotPathStage(hotPathProfile, 'developer-forced-global-spammer');
      if (
        settings.deleteSpammersEnabled &&
        (await this.isDeveloperForcedGlobalSpammerCachedWithHotPathBudget(senderId, {
          chatId,
          messageId,
        }))
      ) {
        await this.deleteAndKickDetectedGlobalSpammer({
          chatId,
          userId: senderId,
          messageId,
          text,
          reason: 'Developer-forced global blacklist',
        });
        return;
      }

      this.markWebhookHotPathStage(hotPathProfile, 'admin-check');
      const senderChatAdminCheck = await this.resolveSenderChatAdminCheck(
        chatId,
        chat.adminUserIds,
        senderId,
        {
          allowRemoteLookup:
            !degradeMode && !hotChatBackoffActive && !keepDestructiveAdminCheckOnHotPath,
          skipRemoteLookupWhenLocalAdminsKnown:
            hotChatBackoffActive ||
            degradeMode ||
            keepDestructiveAdminCheckOnHotPath ||
            (!destructiveAccessGateActive && !forceSynchronousRemoteAdminLookup),
          remoteLookupSoftTimeoutMs:
            !hotChatBackoffActive &&
            !degradeMode &&
            !keepDestructiveAdminCheckOnHotPath &&
            !forceSynchronousRemoteAdminLookup
              ? CHAT_ADMIN_NONCRITICAL_LOOKUP_SOFT_TIMEOUT_MS
              : undefined,
          prefetchRemoteLookupWhenLocalAdminsKnown:
            !hotChatBackoffActive &&
            !degradeMode &&
            !destructiveAccessGateActive &&
            !this.moderationAccessService.syncRemoteLookupWhenLocalAdminsKnown,
        },
      );
      if (senderChatAdminCheck.isAdmin) {
        if (
          await this.tryHandleKaravanStorefrontRelay({
            update,
            updateType,
            chatId,
            messageId,
            senderId,
            senderName,
            text,
          })
        ) {
          return;
        }

        this.markWebhookHotPathStage(hotPathProfile, 'admin-command');
        await this.handleChatAdminModerationBypass({
          update,
          chatId,
          chatTitle,
          senderId,
          senderName,
          messageId,
          text,
          settings,
          source: senderChatAdminCheck.source,
        });
        return;
      }

      const latestSenderChatAdminCheck = senderChatAdminCheck;
      const ensureDestructiveModerationAllowed = async (stage: string): Promise<boolean> => {
        if (latestSenderChatAdminCheck.source === 'local_fallback') {
          this.scheduleDestructiveAdminRosterRefresh({
            chatId,
            chatTitle,
            botId: update.botId ?? null,
            entityType: update.message?.entityType ?? null,
            stage,
          });
        }

        if (latestSenderChatAdminCheck.isAdmin) {
          if (
            await this.tryHandleKaravanStorefrontRelay({
              update,
              updateType,
              chatId,
              messageId,
              senderId,
              senderName,
              text,
            })
          ) {
            return false;
          }

          this.markWebhookHotPathStage(hotPathProfile, 'admin-command');
          await this.handleChatAdminModerationBypass({
            update,
            chatId,
            chatTitle,
            senderId,
            senderName,
            messageId,
            text,
            settings,
            source: latestSenderChatAdminCheck.source,
          });
          return false;
        }

        return true;
      };

      this.markWebhookHotPathStage(hotPathProfile, 'active-mute');
      const activeMute = await this.getActiveMute(chatId, senderId, settings.muteDurationHours);
      if (activeMute) {
        if (!(await ensureDestructiveModerationAllowed('active-mute'))) {
          return;
        }
        await this.handleActiveMuteMessage({
          chatId,
          userId: senderId,
          messageId,
          text,
          createdAt,
          mute: activeMute,
        });
        return;
      }

      if (manualGroupCloseActiveNow) {
        if (!(await ensureDestructiveModerationAllowed('manual-group-close'))) {
          return;
        }
        await this.handleNightModeForceCloseMessage({
          chatId,
          userId: senderId,
          messageId,
          text,
          createdAt,
          nightModeForceCloseForever: settings.nightModeForceCloseForever,
          nightModeForceCloseUntil: settings.nightModeForceCloseUntil,
        });
        return;
      }

      if (nightModeActiveNow) {
        if (!(await ensureDestructiveModerationAllowed('night-mode'))) {
          return;
        }
        await this.handleNightModeMessage({
          chatId,
          userId: senderId,
          messageId,
          text,
          createdAt,
          nightModeStartTimeMinutes: settings.nightModeStartTimeMinutes,
          nightModeEndTimeMinutes: settings.nightModeEndTimeMinutes,
          nightModeTimezone: settings.nightModeTimezone,
        });
        return;
      }

      const deferHotChatModerationSkipUntilAfterAccessGates =
        hotChatBackoffActive &&
        (isRequiredSubscriptionCurrentlyActive(settings) ||
          isInvitationAccessCurrentlyActive(settings));
      if (
        this.shouldSkipHotChatModeration(mode, hotChatBackoffActive) &&
        !deferHotChatModerationSkipUntilAfterAccessGates
      ) {
        this.logHotChatModerationSkip(chatId, senderId, mode);
        this.markWebhookHotPathStage(hotPathProfile, 'hot-chat-skip');
        void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
          stage: 'hot-chat-skip',
          outcome: 'skip',
          failOpen: true,
        });
        return;
      }

      const mediaFlags = detectMediaFlags(update);
      const skipAntiSpamBurstLimit = shouldSkipAntiSpamBurstForForward(update);
      if (!deferHotChatModerationSkipUntilAfterAccessGates) {
        this.markWebhookHotPathStage(hotPathProfile, 'global-spammer-exempt');
        const globalSpammerAdminDecisions = settings.deleteSpammersEnabled
          ? await this.resolveGlobalSpammerAdminDecisionsWithHotPathBudget(
              [senderId],
              chat.adminUserIds,
              {
                chatId,
                userId: senderId,
                messageId,
              },
            )
          : new Map<string, LocalGlobalSpammerAdminDecision>();
        const globalSpammerAdminDecision = globalSpammerAdminDecisions.get(senderId) ?? null;
        if (globalSpammerAdminDecision === 'BLOCK') {
          const handled = await this.handleLocalAdminBlockedSenderMessage({
            chatId,
            userId: senderId,
            messageId,
            text,
          });
          if (handled) {
            return;
          }
        }
        const isGlobalSpammerExempt = globalSpammerAdminDecision === 'ALLOW';
        this.markWebhookHotPathStage(hotPathProfile, 'global-spammer-track');
        const globalSpammerTracking = await this.trackAndRegisterGlobalSpammerWithHotPathBudget({
          chatId,
          userId: senderId,
          messageId,
          text,
          deleteSpammersEnabled: settings.deleteSpammersEnabled,
          exemptFromEnforcement: isGlobalSpammerExempt,
        });
        if (globalSpammerTracking.handled) {
          return;
        }

        if (
          settings.deleteSpammersEnabled &&
          !globalSpammerTracking.skipKnownSpammerCheck &&
          !isGlobalSpammerExempt
        ) {
          const knownSpammerSkipReason = this.resolveOptionalWebhookStageSkipReason({
            stage: 'known-spammer-check',
            hotPathProfile,
            systemMode: mode,
            hotChatBackoffActive,
          });
          if (knownSpammerSkipReason) {
            this.recordOptionalWebhookStageSkip({
              stage: 'known-spammer-check',
              reason: knownSpammerSkipReason,
              failOpen: true,
            });
          } else {
            const handled = await this.handleKnownSpammerSenderMessage({
              chatId,
              userId: senderId,
              messageId,
              text,
            });
            this.markWebhookHotPathStage(hotPathProfile, 'known-spammer-check');
            if (handled) {
              return;
            }
          }
        }
      }

      this.markWebhookHotPathStage(hotPathProfile, 'required-subscription');
      const requiredSubscriptionHandled = await this.handleRequiredSubscriptionMessage({
        chatId,
        userId: senderId,
        userLabel,
        messageId,
        text,
        createdAt,
        degradeMode,
        hotChatBackoffActive,
        systemMode: mode,
        settings,
        rulesPublishedUrl,
        rulesPublishedMessageId,
        hotPathProfile,
      });
      if (requiredSubscriptionHandled) {
        return;
      }

      this.markWebhookHotPathStage(hotPathProfile, 'invitation-access');
      const invitationAccessHandled = await this.handleInvitationAccessMessage({
        chatId,
        userId: senderId,
        userLabel,
        messageId,
        text,
        createdAt,
        systemMode: mode,
        hotChatBackoffActive,
        settings,
        rulesPublishedUrl,
        rulesPublishedMessageId,
        hotPathProfile,
      });
      if (invitationAccessHandled) {
        return;
      }

      if (deferHotChatModerationSkipUntilAfterAccessGates) {
        this.logHotChatModerationSkip(chatId, senderId, mode);
        this.markWebhookHotPathStage(hotPathProfile, 'hot-chat-skip');
        void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
          stage: 'hot-chat-skip',
          outcome: 'skip',
          failOpen: true,
        });
        return;
      }

      const effectiveMessageLength = calculateEffectiveMessageLength(update);
      const duplicateStateSkipReason = this.resolveOptionalWebhookStageSkipReason({
        stage: 'rule-engine.duplicate-state',
        hotPathProfile,
        systemMode: mode,
        hotChatBackoffActive,
      });
      if (duplicateStateSkipReason) {
        this.recordOptionalWebhookStageSkip({
          stage: 'rule-engine.duplicate-state',
          reason: duplicateStateSkipReason,
        });
      }
      const commercialCampaignSkipReason = settings.commercialAdsFilterEnabled
        ? this.resolveOptionalWebhookStageSkipReason({
            stage: 'rule-engine.commercial-campaign',
            hotPathProfile,
            systemMode: mode,
            hotChatBackoffActive,
          })
        : null;
      if (commercialCampaignSkipReason) {
        this.recordOptionalWebhookStageSkip({
          stage: 'rule-engine.commercial-campaign',
          reason: commercialCampaignSkipReason,
          failOpen: true,
        });
      }
      const commercialCampaignContext =
        settings.commercialAdsFilterEnabled && !commercialCampaignSkipReason
          ? await this.collectCommercialCampaignContext({
              chatId,
              senderId,
              text,
            })
          : null;
      if (settings.commercialAdsFilterEnabled) {
        this.markWebhookHotPathStage(hotPathProfile, 'rule-engine.commercial-campaign');
      }
      const detection = await this.ruleEngine.detect({
        chatId,
        userId: senderId,
        messageId,
        text,
        settings,
        domainAllowlist: chat.domainAllowlist,
        effectiveLength: effectiveMessageLength,
        hasPhotoAttachment: mediaFlags.hasPhotoAttachment,
        hasStickerAttachment: mediaFlags.hasStickerAttachment,
        hasVideoAttachment: mediaFlags.hasVideoAttachment,
        hasFileAttachment: mediaFlags.hasFileAttachment,
        hasVoiceAttachment: mediaFlags.hasVoiceAttachment,
        hasMediaBatch: mediaFlags.hasMediaBatch,
        skipAntiSpamBurstLimit,
        skipDuplicateState: Boolean(duplicateStateSkipReason),
        skipStatefulMessageLimits: updateType === 'message_edited',
        commercialCampaignContext,
      });
      this.markWebhookHotPathStage(hotPathProfile, 'rule-engine');

      const violations = await this.reconcileLinkAllowlistViolations({
        chatId,
        text,
        settings,
        cachedDomainAllowlist: chat.domainAllowlist,
        violations: detection.violations,
      });
      const hasCompetingViolation = violations.length > 0;
      const latestManualReleaseAt =
        detection.duplicateDecision || detection.duplicateHit
          ? await this.resolveLatestManualReleaseCreatedAt(chatId, senderId)
          : null;
      const duplicateDecisionSuppressed =
        detection.duplicateDecision && latestManualReleaseAt
          ? this.isWithinWindowFromDate(
              latestManualReleaseAt,
              detection.duplicateDecision.windowSec,
            )
          : false;
      if (!hasCompetingViolation && detection.duplicateDecision && !duplicateDecisionSuppressed) {
        await this.handleDuplicateDecision({
          chatId,
          userId: senderId,
          messageId,
          text,
          createdAt,
          decision: detection.duplicateDecision,
          userLabel,
          muteDurationHours: settings.duplicateMuteDurationHours,
          botSpeechStyle: settings.botSpeechStyle,
          botSpeechMedia: settings.botSpeechMedia,
          duplicateBotMessageEnabled: settings.duplicateBotMessageEnabled,
          duplicateBotMessageText: settings.duplicateBotMessageText,
          duplicateBotButtons: settings.duplicateBotButtons,
          duplicateBotButtonEnabled: settings.duplicateBotButtonEnabled,
          duplicateBotButtonUrl: settings.duplicateBotButtonUrl,
          duplicateBotButtonText: settings.duplicateBotButtonText,
          duplicateAdminContactButtonEnabled: settings.duplicateAdminContactButtonEnabled,
          duplicateAdminContactButtonUrl: settings.duplicateAdminContactButtonUrl,
          rulesAttachViolationsEnabled: settings.rulesAttachViolationsEnabled,
          rulesPublishedUrl,
          rulesPublishedMessageId,
          deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
          deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
          suppressNonEssentialMessages: hotChatBackoffActive,
          hotPathProfile,
        });
        return;
      }

      const duplicateHitSuppressed =
        detection.duplicateHit && latestManualReleaseAt
          ? this.isWithinWindowFromDate(latestManualReleaseAt, detection.duplicateHit.windowSec)
          : false;
      if (!hasCompetingViolation && detection.duplicateHit && !duplicateHitSuppressed) {
        await this.handleDuplicateHit({
          chatId,
          userId: senderId,
          messageId,
          text,
          createdAt,
          hit: detection.duplicateHit,
          userLabel,
          botSpeechStyle: settings.botSpeechStyle,
          botSpeechMedia: settings.botSpeechMedia,
          duplicateBotMessageEnabled: settings.duplicateBotMessageEnabled,
          duplicateBotMessageText: settings.duplicateBotMessageText,
          duplicateBotButtons: settings.duplicateBotButtons,
          duplicateBotButtonEnabled: settings.duplicateBotButtonEnabled,
          duplicateBotButtonUrl: settings.duplicateBotButtonUrl,
          duplicateBotButtonText: settings.duplicateBotButtonText,
          duplicateAdminContactButtonEnabled: settings.duplicateAdminContactButtonEnabled,
          duplicateAdminContactButtonUrl: settings.duplicateAdminContactButtonUrl,
          rulesAttachViolationsEnabled: settings.rulesAttachViolationsEnabled,
          rulesPublishedUrl,
          rulesPublishedMessageId,
          deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
          deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
          suppressNonEssentialMessages: hotChatBackoffActive,
          hotPathProfile,
        });
        return;
      }

      if (violations.length === 0) {
        if (
          await this.tryHandleKaravanStorefrontRelay({
            update,
            updateType,
            chatId,
            messageId,
            senderId,
            senderName,
            text,
          })
        ) {
          return;
        }

        if (messageId && this.shouldAutoAttachChatCommentsButton(settings, false)) {
          await this.tryAutoAttachChatMessageComments({
            chatId,
            messageId,
            text: typeof text === 'string' && text.trim() ? text : null,
            senderId,
            senderIsAdmin: false,
            update,
          });
        }

        return;
      }

      this.markWebhookHotPathStage(hotPathProfile, 'violation-admin-recheck');
      const violationAdminRecheckMaxWaitMs = this.resolveWebhookHotPathStageWaitBudgetMs({
        hotPathProfile,
        systemMode: mode,
        hotChatBackoffActive,
        defaultWaitMs: CHAT_ADMIN_NONCRITICAL_LOOKUP_SOFT_TIMEOUT_MS,
        reserveMs: VIOLATION_ADMIN_RECHECK_RESERVE_MS,
      });
      let violationSenderAdminCheck = latestSenderChatAdminCheck;
      if (violationAdminRecheckMaxWaitMs > 0) {
        violationSenderAdminCheck = await this.recheckSenderChatAdminBeforeModeration(
          chatId,
          chat.adminUserIds,
          senderId,
          senderChatAdminCheck,
          {
            maxWaitMs: violationAdminRecheckMaxWaitMs,
          },
        );
      } else {
        const skipReason = this.resolveOptionalWebhookStageSkipReason({
          stage: 'admin-check.violation-recheck',
          hotPathProfile,
          systemMode: mode,
          hotChatBackoffActive,
          minRemainingMs: VIOLATION_ADMIN_RECHECK_RESERVE_MS,
        });
        if (skipReason) {
          this.recordOptionalWebhookStageSkip({
            stage: 'admin-check.violation-recheck',
            reason: skipReason,
          });
        }
      }
      if (violationSenderAdminCheck.isAdmin) {
        this.markWebhookHotPathStage(hotPathProfile, 'admin-command');
        await this.handleChatAdminModerationBypass({
          update,
          chatId,
          chatTitle,
          senderId,
          senderName,
          messageId,
          text,
          settings,
          source: violationSenderAdminCheck.source,
        });
        return;
      }

      const immunityConsumed = await this.consumeChatParticipantModerationImmunity({
        chatId,
        userId: senderId,
        nightModeTimezone: settings.nightModeTimezone,
      });
      if (immunityConsumed) {
        this.logger.debug(
          {
            chatId,
            userId: senderId,
          },
          'Moderation bypassed for participant immunity',
        );

        if (messageId && this.shouldAutoAttachChatCommentsButton(settings, false)) {
          await this.tryAutoAttachChatMessageComments({
            chatId,
            messageId,
            text: typeof text === 'string' && text.trim() ? text : null,
            senderId,
            senderIsAdmin: false,
            update,
          });
        }

        return;
      }

      const topViolation =
        violations.find((item) => item.ruleCode === 'LINK_BLOCKED') ??
        violations.find((item) => item.ruleCode === 'COMMERCIAL_AD') ??
        violations.find((item) => item.ruleCode === 'PROFANITY') ??
        violations.find((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH') ??
        violations.find((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD') ??
        violations.find((item) => item.ruleCode === 'MESSAGE_BLOCKED_DOMAIN') ??
        violations.find((item) => item.ruleCode === 'PHONE_NUMBER_BLOCKED') ??
        violations.find((item) => item.ruleCode === 'MESSAGE_TOO_LONG') ??
        violations.find((item) => item.ruleCode === 'MESSAGE_RATE_LIMIT') ??
        violations.find((item) => item.ruleCode === 'MESSAGE_COUNT_LIMIT') ??
        violations.find((item) => item.ruleCode === 'PHOTO_BLOCKED') ??
        violations.find((item) => item.ruleCode === 'VIDEO_BLOCKED') ??
        violations.find((item) => item.ruleCode === 'FILE_BLOCKED') ??
        violations.find((item) => item.ruleCode === 'VOICE_BLOCKED') ??
        violations.find((item) => item.ruleCode === 'PHOTO_RATE_LIMIT') ??
        violations.find((item) => item.ruleCode === 'STICKER_RATE_LIMIT') ??
        violations[0];
      const commercialActionBand =
        topViolation.ruleCode === 'COMMERCIAL_AD'
          ? this.readString(this.asRecord(topViolation.metadata)?.actionBand)
          : null;
      const commercialMetadata =
        topViolation.ruleCode === 'COMMERCIAL_AD'
          ? this.asRecord(topViolation.metadata)
          : null;
      const commercialRecordable =
        topViolation.ruleCode === 'COMMERCIAL_AD'
          ? this.readBoolean(commercialMetadata?.recordable) ??
            (commercialActionBand !== null &&
              commercialActionBand !== 'ALLOW' &&
              commercialActionBand !== 'REVIEW_ONLY')
          : true;
      const commercialActionable =
        topViolation.ruleCode === 'COMMERCIAL_AD'
          ? this.readBoolean(commercialMetadata?.actionable) ??
            (commercialActionBand !== null &&
              commercialActionBand !== 'ALLOW' &&
              commercialActionBand !== 'REVIEW_ONLY')
          : true;
      const isCommercialReviewOnly =
        topViolation.ruleCode === 'COMMERCIAL_AD' && !commercialRecordable;

      if (!isCommercialReviewOnly) {
        this.markWebhookHotPathStage(hotPathProfile, 'violation-record');
        await this.prisma.violation.create({
          data: {
            chatId,
            userId: senderId,
            ruleCode: topViolation.ruleCode,
            score: topViolation.score,
          },
        });
      }
      if (this.globalSpammerIntelligence && !isCommercialReviewOnly) {
        this.runGlobalSpammerSideEffect(
          { chatId, userId: senderId, messageId, action: 'record-commercial-spammer-observations' },
          async () => {
            await this.globalSpammerIntelligence!.recordCommercialObservations({
              chatId,
              userId: senderId,
              messageId,
              text,
              userLabel,
              topViolation,
              commercialCampaignContext,
            });
          },
        );
      }

      const messageAgeMs = Date.now() - new Date(createdAt).getTime();
      const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;
      const shouldDeleteByCommercialPolicy =
        topViolation.ruleCode !== 'COMMERCIAL_AD' ||
        (commercialActionable &&
          (commercialActionBand === 'WARN' ||
            commercialActionBand === 'DELETE' ||
            commercialActionBand === 'DELETE_AND_ESCALATE'));
      const shouldDeleteViolationMessage = canDeleteMessage && shouldDeleteByCommercialPolicy;
      let messageDeleted = false;

      if (shouldDeleteViolationMessage) {
        this.markWebhookHotPathStage(hotPathProfile, 'violation-delete');
        messageDeleted = await this.deleteMessageImmediately(chatId, messageId);
        if (messageDeleted) {
          await this.createBotModerationEvent({
            data: {
              chatId,
              userId: senderId,
              messageId,
              eventType: EventType.MESSAGE,
              ruleCode: `${topViolation.ruleCode}_DELETE`,
              action: SanctionAction.DELETE_MESSAGE,
              maskedExcerpt: maskText(text),
              score: topViolation.score,
              operator: Operator.BOT,
              metadata: {
                reason: topViolation.reason,
                ...(topViolation.metadata && typeof topViolation.metadata === 'object'
                  ? topViolation.metadata
                  : {}),
              },
            },
          });
          this.markWebhookHotPathSuccessBoundary(hotPathProfile, 'violation-delete');
        }
      } else if (!canDeleteMessage && shouldDeleteByCommercialPolicy) {
        await this.maxClient.notifyModerators(
          chatId,
          `Нарушение ${topViolation.ruleCode} от ${senderId}, но сообщение старше 24 часов и не может быть удалено`,
        );
      }

      this.markWebhookHotPathStage(hotPathProfile, 'violation-follow-up');
      const runViolationFollowUp = async () => {
        const linkMessageOptions =
          topViolation.ruleCode === 'LINK_BLOCKED'
            ? this.buildBotMessageOptions(
                chatId,
                settings.linkBotButtons,
                settings.linkBotButtonEnabled,
                settings.linkBotButtonUrl,
                settings.linkBotButtonText,
                settings.rulesAttachViolationsEnabled,
                rulesPublishedUrl,
                rulesPublishedMessageId,
              )
            : null;
        const linkViolationCount24h =
          topViolation.ruleCode === 'LINK_BLOCKED'
            ? await this.countRecentLinkViolations(
                chatId,
                senderId,
                settings.linkEscalationWindowHours,
              )
            : null;
        const isPhoneNumberHit = topViolation.ruleCode === 'PHONE_NUMBER_BLOCKED';
        const isTextFilterHit =
          this.isTextFilterViolation(topViolation.ruleCode) && !isCommercialReviewOnly;
        const isTopicFilterHit = this.isTopicFilterViolation(topViolation.ruleCode);
        const isMessageLimitsHit =
          this.isMessageLimitsViolation(topViolation.ruleCode) && !isPhoneNumberHit;
        const messageLimitsBlockedWord = extractMessageLimitsBlockedToken(topViolation.metadata);
        const textFilterEscalationSettings = isTextFilterHit
          ? this.resolveTextFilterEscalationSettings(topViolation.ruleCode, settings)
          : null;
        const textFilterMessageOptions = isTextFilterHit
          ? this.buildBotMessageOptions(
              chatId,
              settings.textFiltersBotButtons,
              settings.textFiltersBotButtonEnabled,
              settings.textFiltersBotButtonUrl,
              settings.textFiltersBotButtonText,
              settings.rulesAttachViolationsEnabled,
              rulesPublishedUrl,
              rulesPublishedMessageId,
            )
          : null;
        const limitsMessageOptions = isMessageLimitsHit
          ? this.buildBotMessageOptions(
              chatId,
              settings.messageLimitsBotButtons,
              settings.messageLimitsBotButtonEnabled,
              settings.messageLimitsBotButtonUrl,
              settings.messageLimitsBotButtonText,
              settings.rulesAttachViolationsEnabled,
              rulesPublishedUrl,
              rulesPublishedMessageId,
            )
          : null;
        const phoneNumbersMessageOptions = isPhoneNumberHit
          ? this.buildBotMessageOptions(
              chatId,
              [],
              false,
              '',
              '',
              settings.rulesAttachViolationsEnabled,
              rulesPublishedUrl,
              rulesPublishedMessageId,
            )
          : null;
        const topicMessageOptions = isTopicFilterHit
          ? this.buildBotMessageOptions(
              chatId,
              settings.thematicFiltersBotButtons,
              settings.thematicFiltersBotButtonEnabled,
              settings.thematicFiltersBotButtonUrl,
              settings.thematicFiltersBotButtonText,
              settings.rulesAttachViolationsEnabled,
              rulesPublishedUrl,
              rulesPublishedMessageId,
            )
          : null;
        const textFilterViolationCount24h = isTextFilterHit
          ? await this.countRecentTextFilterViolations(chatId, senderId, topViolation.ruleCode)
          : null;
        const topicFilterViolationCount24h = isTopicFilterHit
          ? await this.countRecentTopicFilterViolations(chatId, senderId, topViolation.ruleCode)
          : null;
        const messageLimitsViolationCount12h = isMessageLimitsHit
          ? await this.countRecentMessageLimitsViolations(chatId, senderId, topViolation.ruleCode)
          : null;
        const phoneNumbersViolationCount = isPhoneNumberHit
          ? await this.countRecentPhoneNumberViolations(
              chatId,
              senderId,
              settings.phoneNumbersEscalationWindowHours,
            )
          : null;
        const sendChatBotMessage = async (
          textValue: string,
          messageOptions?: MaxSendMessageOptions,
          mediaFieldKey?: BotSpeechMediaFieldKey,
        ) =>
          this.sendBotMessageWithOptionalAutoDelete({
            chatId,
            text: textValue,
            media: this.resolveBotSpeechMedia(settings, mediaFieldKey),
            messageOptions,
            deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
            deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
          });

        let action: SanctionAction = SanctionAction.NONE;
        const actionMuteDurationHours = this.resolveAutomaticMuteDurationHours(
          topViolation.ruleCode,
          settings,
        );

        if (topViolation.ruleCode === 'LINK_BLOCKED') {
          action = this.resolveLinkEscalationAction(linkViolationCount24h ?? 1, {
            warnEnabled: settings.linkWarnEnabled,
            banEnabled: settings.linkBanEnabled,
            muteEnabled: settings.linkMuteEnabled,
            warnMaxCount: settings.linkWarnMaxCount,
            muteMaxCount: settings.linkMuteMaxCount,
            banMaxCount: settings.linkBanMaxCount,
          });
        } else if (isPhoneNumberHit) {
          action = this.resolveConfiguredEscalationAction(phoneNumbersViolationCount ?? 1, {
            warnEnabled: settings.phoneNumbersWarnEnabled,
            banEnabled: settings.phoneNumbersBanEnabled,
            muteEnabled: settings.phoneNumbersMuteEnabled,
            warnMaxCount: settings.phoneNumbersWarnMaxCount,
            muteMaxCount: settings.phoneNumbersMuteMaxCount,
            banMaxCount: settings.phoneNumbersBanMaxCount,
          });
        } else if (isTextFilterHit) {
          action = this.resolveTextFilterEscalationAction(textFilterViolationCount24h ?? 1, {
            warnEnabled: Boolean(textFilterEscalationSettings?.warnEnabled),
            banEnabled: Boolean(textFilterEscalationSettings?.banEnabled),
            muteEnabled: Boolean(textFilterEscalationSettings?.muteEnabled),
          });
        } else if (isTopicFilterHit) {
          action = this.resolveTextFilterEscalationAction(topicFilterViolationCount24h ?? 1, {
            warnEnabled: settings.thematicFiltersWarnEnabled,
            banEnabled: settings.thematicFiltersBanEnabled,
            muteEnabled: settings.thematicFiltersMuteEnabled,
          });
        } else if (topViolation.ruleCode === 'MESSAGE_RATE_LIMIT') {
          // Burst flooding can starve moderation workers, so this guard is enforced as a hard ban.
          action = SanctionAction.BAN;
        } else if (isMessageLimitsHit) {
          action = this.resolveMessageLimitsEscalationAction(messageLimitsViolationCount12h ?? 1, {
            warnEnabled: settings.messageLimitsWarnEnabled,
            banEnabled: settings.messageLimitsBanEnabled,
            muteEnabled: settings.messageLimitsMuteEnabled,
          });
        } else if (this.shouldResolveSanction(topViolation.ruleCode)) {
          action = await this.sanctionService.resolveAction({
            chatId,
            userId: senderId,
            warnThreshold: settings.warnThreshold,
          });
        }

        const isFirstLinkViolation =
          topViolation.ruleCode === 'LINK_BLOCKED' && linkViolationCount24h === 1;
        const isFirstTextFilterViolation = isTextFilterHit && textFilterViolationCount24h === 1;
        const isFirstTopicFilterViolation = isTopicFilterHit && topicFilterViolationCount24h === 1;
        const isFirstMessageLimitsViolation =
          isMessageLimitsHit && messageLimitsViolationCount12h === 1;
        const isFirstPhoneNumberViolation = isPhoneNumberHit && phoneNumbersViolationCount === 1;

        if (topViolation.ruleCode === 'LINK_BLOCKED') {
          if (
            action === SanctionAction.NONE &&
            isFirstLinkViolation &&
            settings.linkBotMessageEnabled
          ) {
            try {
              await sendChatBotMessage(
                await this.appendAdminContactMarkdownLink(
                  chatId,
                  this.buildLinkExplanation(
                    userLabel,
                    messageDeleted,
                    settings.linkBotMessageText,
                    settings.botSpeechStyle,
                    updateType === 'message_edited',
                  ),
                  settings.linkAdminContactButtonEnabled,
                  settings.linkAdminContactButtonUrl,
                ),
                linkMessageOptions ?? undefined,
                'linkBotMessageText',
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId,
                  userId: senderId,
                  messageId,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send link explanation message',
              );
            }
          } else if (action === SanctionAction.WARN) {
            try {
              await sendChatBotMessage(
                await this.appendAdminContactMarkdownLink(
                  chatId,
                  this.buildLinkWarnExplanation(
                    userLabel,
                    settings.linkWarnMessageText,
                    settings.botSpeechStyle,
                    updateType === 'message_edited',
                  ),
                  settings.linkAdminContactButtonEnabled,
                  settings.linkAdminContactButtonUrl,
                ),
                linkMessageOptions ?? undefined,
                'linkWarnMessageText',
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId,
                  userId: senderId,
                  messageId,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send link warning message',
              );
            }
          }
        }

        if (isPhoneNumberHit) {
          if (
            action === SanctionAction.NONE &&
            isFirstPhoneNumberViolation &&
            settings.phoneNumbersBotMessageEnabled
          ) {
            try {
              await sendChatBotMessage(
                await this.appendAdminContactMarkdownLink(
                  chatId,
                  this.buildPhoneNumbersExplanation(
                    userLabel,
                    messageDeleted,
                    settings.phoneNumbersBotMessageText,
                    settings.botSpeechStyle,
                  ),
                  settings.phoneNumbersAdminContactButtonEnabled,
                  settings.phoneNumbersAdminContactButtonUrl,
                ),
                phoneNumbersMessageOptions ?? undefined,
                'phoneNumbersBotMessageText',
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId,
                  userId: senderId,
                  messageId,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send phone number explanation message',
              );
            }
          } else if (action === SanctionAction.WARN) {
            try {
              await sendChatBotMessage(
                await this.appendAdminContactMarkdownLink(
                  chatId,
                  this.buildMessageLimitsWarnExplanation(
                    userLabel,
                    topViolation.ruleCode,
                    null,
                    settings.botSpeechStyle,
                  ),
                  settings.phoneNumbersAdminContactButtonEnabled,
                  settings.phoneNumbersAdminContactButtonUrl,
                ),
                phoneNumbersMessageOptions ?? undefined,
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId,
                  userId: senderId,
                  messageId,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send phone number warning message',
              );
            }
          }
        }

        if (isMessageLimitsHit) {
          if (
            action === SanctionAction.NONE &&
            isFirstMessageLimitsViolation &&
            settings.messageLimitsBotMessageEnabled
          ) {
            try {
              await sendChatBotMessage(
                await this.appendAdminContactMarkdownLink(
                  chatId,
                  this.buildMessageLimitsExplanation(
                    userLabel,
                    topViolation.ruleCode,
                    messageDeleted,
                    settings.messageCountLimitMessages,
                    settings.messageCountLimitWindowHours,
                    settings.photoMessageCooldownHours,
                    settings.stickerMessageCooldownMinutes,
                    effectiveMessageLength,
                    settings.maxMessageLength,
                    messageLimitsBlockedWord,
                    settings.messageLimitsBotMessageText,
                    settings.botSpeechStyle,
                  ),
                  settings.messageLimitsAdminContactButtonEnabled,
                  settings.messageLimitsAdminContactButtonUrl,
                ),
                limitsMessageOptions ?? undefined,
                'messageLimitsBotMessageText',
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId,
                  userId: senderId,
                  messageId,
                  ruleCode: topViolation.ruleCode,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send message limits explanation message',
              );
            }
          } else if (action === SanctionAction.WARN) {
            try {
              await sendChatBotMessage(
                await this.appendAdminContactMarkdownLink(
                  chatId,
                  this.buildMessageLimitsWarnExplanation(
                    userLabel,
                    topViolation.ruleCode,
                    messageLimitsBlockedWord,
                    settings.botSpeechStyle,
                    settings.messageLimitsWarnMessageText,
                  ),
                  settings.messageLimitsAdminContactButtonEnabled,
                  settings.messageLimitsAdminContactButtonUrl,
                ),
                limitsMessageOptions ?? undefined,
                'messageLimitsWarnMessageText',
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId,
                  userId: senderId,
                  messageId,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send message limits warning message',
              );
            }
          }
        }

        if (isTextFilterHit) {
          if (
            action === SanctionAction.NONE &&
            isFirstTextFilterViolation &&
            textFilterEscalationSettings?.botMessageEnabled
          ) {
            try {
              await sendChatBotMessage(
                await this.appendAdminContactMarkdownLink(
                  chatId,
                  this.buildTextFilterExplanation(
                    userLabel,
                    topViolation.ruleCode,
                    messageDeleted,
                    textFilterEscalationSettings.botMessageText,
                    settings.botSpeechStyle,
                  ),
                  textFilterEscalationSettings.adminContactButtonEnabled,
                  textFilterEscalationSettings.adminContactButtonUrl,
                ),
                textFilterMessageOptions ?? undefined,
                'textFiltersBotMessageText',
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId,
                  userId: senderId,
                  messageId,
                  ruleCode: topViolation.ruleCode,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send text filter explanation message',
              );
            }
          } else if (action === SanctionAction.WARN) {
            try {
              await sendChatBotMessage(
                await this.appendAdminContactMarkdownLink(
                  chatId,
                  this.buildTextFilterWarnExplanation(
                    userLabel,
                    topViolation.ruleCode,
                    textFilterEscalationSettings?.warnMessageText ??
                      settings.textFiltersWarnMessageText,
                    settings.botSpeechStyle,
                  ),
                  textFilterEscalationSettings?.adminContactButtonEnabled ?? false,
                  textFilterEscalationSettings?.adminContactButtonUrl ?? '',
                ),
                textFilterMessageOptions ?? undefined,
                'textFiltersWarnMessageText',
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId,
                  userId: senderId,
                  messageId,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send text filter warning message',
              );
            }
          }
        }

        if (isTopicFilterHit) {
          if (
            action === SanctionAction.NONE &&
            isFirstTopicFilterViolation &&
            settings.thematicFiltersBotMessageEnabled
          ) {
            try {
              await sendChatBotMessage(
                await this.appendAdminContactMarkdownLink(
                  chatId,
                  this.buildTopicFilterExplanation(
                    userLabel,
                    messageDeleted,
                    this.extractTopicFilterRequiredCodeword(topViolation.metadata),
                    settings.botSpeechStyle,
                  ),
                  settings.thematicFiltersAdminContactButtonEnabled,
                  settings.thematicFiltersAdminContactButtonUrl,
                ),
                topicMessageOptions ?? undefined,
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId,
                  userId: senderId,
                  messageId,
                  ruleCode: topViolation.ruleCode,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send thematic filter explanation message',
              );
            }
          } else if (action === SanctionAction.WARN) {
            try {
              await sendChatBotMessage(
                await this.appendAdminContactMarkdownLink(
                  chatId,
                  this.buildTopicFilterWarnExplanation(
                    userLabel,
                    this.extractTopicFilterRequiredCodeword(topViolation.metadata),
                    settings.botSpeechStyle,
                  ),
                  settings.thematicFiltersAdminContactButtonEnabled,
                  settings.thematicFiltersAdminContactButtonUrl,
                ),
                topicMessageOptions ?? undefined,
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId,
                  userId: senderId,
                  messageId,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send thematic filter warning message',
              );
            }
          }
        }

        if (action !== SanctionAction.NONE) {
          await this.applySanctionAction({
            chatId,
            userId: senderId,
            action,
            userLabel,
            messageId,
            muteDurationHours: actionMuteDurationHours,
            deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
            deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
            botMessageOptions:
              topViolation.ruleCode === 'LINK_BLOCKED'
                ? (linkMessageOptions ?? undefined)
                : isTopicFilterHit
                  ? (topicMessageOptions ?? undefined)
                  : isPhoneNumberHit
                    ? (phoneNumbersMessageOptions ?? undefined)
                    : isMessageLimitsHit
                      ? (limitsMessageOptions ?? undefined)
                      : isTextFilterHit
                        ? (textFilterMessageOptions ?? undefined)
                        : undefined,
            sanctionNoticeText:
              isPhoneNumberHit && action === SanctionAction.BAN
                ? this.buildMessageLimitsBanExplanation(
                    userLabel,
                    topViolation.ruleCode,
                    actionMuteDurationHours,
                    null,
                    settings.botSpeechStyle,
                  )
                : isMessageLimitsHit && action === SanctionAction.BAN
                  ? this.buildMessageLimitsBanExplanation(
                      userLabel,
                      topViolation.ruleCode,
                      actionMuteDurationHours,
                      messageLimitsBlockedWord,
                      settings.botSpeechStyle,
                    )
                  : isTopicFilterHit && action === SanctionAction.BAN
                    ? this.buildTopicFilterBanExplanation(
                        userLabel,
                        this.extractTopicFilterRequiredCodeword(topViolation.metadata),
                        actionMuteDurationHours,
                        settings.botSpeechStyle,
                      )
                    : undefined,
            botSpeechStyle: settings.botSpeechStyle,
          });

          if (topViolation.ruleCode === 'LINK_BLOCKED' && action === SanctionAction.MUTE) {
            try {
              await sendChatBotMessage(
                this.buildLinkMuteExplanation(userLabel, settings.botSpeechStyle),
                linkMessageOptions ?? undefined,
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId,
                  userId: senderId,
                  messageId,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send link mute message',
              );
            }
          }

          if (isTextFilterHit && action === SanctionAction.MUTE) {
            try {
              await sendChatBotMessage(
                this.buildTextFilterMuteExplanation(
                  userLabel,
                  topViolation.ruleCode,
                  settings.botSpeechStyle,
                ),
                textFilterMessageOptions ?? undefined,
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId,
                  userId: senderId,
                  messageId,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send text filter mute message',
              );
            }
          }

          if (isTopicFilterHit && action === SanctionAction.MUTE) {
            try {
              await sendChatBotMessage(
                this.buildTopicFilterMuteExplanation(
                  userLabel,
                  this.extractTopicFilterRequiredCodeword(topViolation.metadata),
                  settings.botSpeechStyle,
                ),
                topicMessageOptions ?? undefined,
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId,
                  userId: senderId,
                  messageId,
                  ruleCode: topViolation.ruleCode,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send thematic filter mute message',
              );
            }
          }

          if (isMessageLimitsHit && action === SanctionAction.MUTE) {
            try {
              await sendChatBotMessage(
                this.buildMessageLimitsMuteExplanation(
                  userLabel,
                  topViolation.ruleCode,
                  messageLimitsBlockedWord,
                  settings.botSpeechStyle,
                ),
                limitsMessageOptions ?? undefined,
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId,
                  userId: senderId,
                  messageId,
                  ruleCode: topViolation.ruleCode,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send message limits mute message',
              );
            }
          }

          if (isPhoneNumberHit && action === SanctionAction.MUTE) {
            try {
              await sendChatBotMessage(
                this.buildMessageLimitsMuteExplanation(
                  userLabel,
                  topViolation.ruleCode,
                  null,
                  settings.botSpeechStyle,
                ),
                phoneNumbersMessageOptions ?? undefined,
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId,
                  userId: senderId,
                  messageId,
                  ruleCode: topViolation.ruleCode,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send phone number mute message',
              );
            }
          }
        }

        await this.createBotModerationEvent({
          data: {
            chatId,
            userId: senderId,
            messageId,
            eventType: EventType.MESSAGE,
            ruleCode: topViolation.ruleCode,
            action,
            maskedExcerpt: maskText(text),
            score: topViolation.score,
            operator: Operator.BOT,
            metadata: {
              reason: topViolation.reason,
              action,
              ...(topViolation.metadata && typeof topViolation.metadata === 'object'
                ? topViolation.metadata
                : {}),
              ...(topViolation.ruleCode === 'LINK_BLOCKED' && linkViolationCount24h !== null
                ? {
                    linkViolationCount24h,
                    linkEscalationWindowHours: settings.linkEscalationWindowHours,
                  }
                : {}),
              ...(isPhoneNumberHit && phoneNumbersViolationCount !== null
                ? {
                    phoneNumbersViolationCount,
                    phoneNumbersEscalationWindowHours: settings.phoneNumbersEscalationWindowHours,
                  }
                : {}),
              ...(isTextFilterHit && textFilterViolationCount24h !== null
                ? {
                    textFilterViolationCount24h,
                    textFilterEscalationWindowHours: TEXT_FILTER_ESCALATION_WINDOW_HOURS,
                  }
                : {}),
              ...(isTopicFilterHit && topicFilterViolationCount24h !== null
                ? {
                    topicFilterViolationCount24h,
                    topicFilterEscalationWindowHours: TOPIC_FILTER_ESCALATION_WINDOW_HOURS,
                  }
                : {}),
              ...(isMessageLimitsHit && messageLimitsViolationCount12h !== null
                ? {
                    messageLimitsViolationCount12h,
                    messageLimitsEscalationWindowHours: MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS,
                  }
                : {}),
            },
          },
        });
      };
      await this.runWebhookFollowUpWithBudget({
        stage: 'violation-follow-up',
        hotPathProfile,
        chatId,
        userId: senderId,
        messageId,
        maxWaitMs: VIOLATION_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
        task: runViolationFollowUp,
      });
    } finally {
      if (sharedChatExecutionLock) {
        await this.releaseSharedChatExecutionLock(sharedChatExecutionLock);
      }
    }
  }

  private async runWebhookFollowUpWithBudget(params: {
    stage: string;
    hotPathProfile?: WebhookHotPathProfile | null;
    chatId: string;
    userId?: string | null;
    messageId?: string | null;
    maxWaitMs: number;
    minRemainingMs?: number;
    task: () => Promise<void>;
  }): Promise<void> {
    if (
      this.shouldDetachFollowUpForBudget(
        params.hotPathProfile,
        params.stage,
        params.minRemainingMs,
      )
    ) {
      this.scheduleDetachedWebhookFollowUp({
        stage: params.stage,
        chatId: params.chatId,
        userId: params.userId,
        messageId: params.messageId,
        task: params.task,
      });
      return;
    }

    const waitMs = this.resolveWebhookFollowUpWaitBudgetMs({
      hotPathProfile: params.hotPathProfile,
      maxWaitMs: params.maxWaitMs,
      minRemainingMs: params.minRemainingMs,
    });
    if (waitMs <= 0) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: `${params.stage}.deferred`,
        outcome: 'skip',
        failOpen: true,
      });
      this.scheduleDetachedWebhookFollowUp({
        stage: params.stage,
        chatId: params.chatId,
        userId: params.userId,
        messageId: params.messageId,
        task: params.task,
      });
      return;
    }

    let detached = false;
    const operation = Promise.resolve().then(params.task);
    operation.catch((error: unknown) => {
      if (!detached) {
        return;
      }
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'follow_up_failed',
        outcome: 'timeout',
        failOpen: true,
      });
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: `${params.stage}.failed`,
        outcome: 'timeout',
        failOpen: true,
      });
      this.logger.warn(
        {
          stage: params.stage,
          chatId: params.chatId,
          userId: params.userId ?? null,
          messageId: params.messageId ?? null,
          err: error instanceof Error ? error.message : String(error),
        },
        'Deferred webhook follow-up failed after the user-facing budget window',
      );
    });

    let timedOut = false;
    await raceWithTimeout({
      operation,
      timeoutMs: waitMs,
      onTimeout: () => {
        timedOut = true;
        detached = true;
      },
    });
    if (!timedOut) {
      return;
    }

    void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
      stage: `${params.stage}.deferred`,
      outcome: 'skip',
      failOpen: true,
    });
    void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
      stage: 'follow_up_deferred',
      outcome: 'skip',
      failOpen: true,
    });
    this.logger.debug(
      {
        stage: params.stage,
        chatId: params.chatId,
        userId: params.userId ?? null,
        messageId: params.messageId ?? null,
        timeoutMs: waitMs,
      },
      'Detached webhook follow-up after hot-path budget window',
    );
  }

  private resolveWebhookFollowUpWaitBudgetMs(params: {
    hotPathProfile?: WebhookHotPathProfile | null;
    maxWaitMs: number;
    minRemainingMs?: number;
  }): number {
    const maxWaitMs = Math.max(1, Math.ceil(params.maxWaitMs));
    const snapshot = this.readWebhookHotPathProfileSnapshot(params.hotPathProfile);
    const elapsedMs =
      typeof snapshot?.elapsedMs === 'number' && Number.isFinite(snapshot.elapsedMs)
        ? snapshot.elapsedMs
        : null;
    if (elapsedMs === null) {
      return maxWaitMs;
    }

    const minRemainingMs = Math.max(1, Math.ceil(params.minRemainingMs ?? 500));
    const remainingMs = Math.max(0, this.webhookUserFacingTimeoutMs - elapsedMs);
    if (remainingMs <= minRemainingMs) {
      return 0;
    }

    return Math.min(maxWaitMs, Math.max(0, remainingMs - minRemainingMs));
  }

  private async handleDuplicateDecision(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    decision: DuplicateDecision;
    userLabel: string;
    muteDurationHours: number;
    botSpeechStyle: BotSpeechStyle | null;
    botSpeechMedia: ChatSettings['botSpeechMedia'];
    duplicateBotMessageEnabled: boolean;
    duplicateBotMessageText: string;
    duplicateBotButtons: unknown;
    duplicateBotButtonEnabled: boolean;
    duplicateBotButtonUrl: string;
    duplicateBotButtonText: string;
    duplicateAdminContactButtonEnabled: boolean;
    duplicateAdminContactButtonUrl: string;
    rulesAttachViolationsEnabled: boolean;
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    suppressNonEssentialMessages: boolean;
    hotPathProfile?: WebhookHotPathProfile | null;
  }) {
    const {
      chatId,
      userId,
      messageId,
      text,
      createdAt,
      decision,
      userLabel,
      muteDurationHours,
      botSpeechStyle,
      botSpeechMedia,
      duplicateBotMessageEnabled,
      duplicateBotMessageText,
      duplicateBotButtons,
      duplicateBotButtonEnabled,
      duplicateBotButtonUrl,
      duplicateBotButtonText,
      duplicateAdminContactButtonEnabled,
      duplicateAdminContactButtonUrl,
      rulesAttachViolationsEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      suppressNonEssentialMessages,
      hotPathProfile,
    } = params;
    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;
    let messageDeleted = false;

    if (canDeleteMessage) {
      try {
        this.markWebhookHotPathStage(hotPathProfile, 'duplicate-delete');
        messageDeleted = await this.deleteMessageImmediately(chatId, messageId);
        if (messageDeleted) {
          await this.createBotModerationEvent({
            data: {
              chatId,
              userId,
              messageId,
              eventType: EventType.MESSAGE,
              ruleCode: 'DUPLICATE_DELETE',
              action: SanctionAction.DELETE_MESSAGE,
              maskedExcerpt: maskText(text),
              score: 0.8,
              operator: Operator.BOT,
              metadata: {
                windowSec: decision.windowSec,
                count: decision.count,
                threshold: decision.threshold,
                reason: 'Duplicate message removed',
              },
            },
          });
          this.markWebhookHotPathSuccessBoundary(hotPathProfile, 'duplicate-delete');
        }
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to delete duplicate message',
        );
      }
    } else {
      await this.maxClient.notifyModerators(
        chatId,
        `Нарушение DUPLICATE от ${userId}, но сообщение старше 24 часов и не может быть удалено`,
      );
    }

    this.markWebhookHotPathStage(hotPathProfile, 'duplicate-follow-up');
    const runDuplicateFollowUp = async () => {
      const duplicateMessageOptions = this.buildBotMessageOptions(
        chatId,
        duplicateBotButtons,
        duplicateBotButtonEnabled,
        duplicateBotButtonUrl,
        duplicateBotButtonText,
        rulesAttachViolationsEnabled,
        rulesPublishedUrl,
        rulesPublishedMessageId,
      );

      const action = this.toSanctionAction(decision.action);
      await this.applySanctionAction({
        chatId,
        userId,
        action,
        userLabel,
        messageId,
        muteDurationHours,
        deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes,
        botMessageOptions: duplicateMessageOptions ?? undefined,
        botSpeechStyle,
      });

      await this.createBotModerationEvent({
        data: {
          chatId,
          userId,
          messageId,
          eventType: EventType.MESSAGE,
          ruleCode: `DUPLICATE_${decision.action}`,
          action,
          maskedExcerpt: maskText(text),
          score: 0.8,
          operator: Operator.BOT,
          metadata: {
            windowSec: decision.windowSec,
            count: decision.count,
            threshold: decision.threshold,
            nextStep: decision.nextAction,
          },
        },
      });

      if (!suppressNonEssentialMessages && duplicateBotMessageEnabled && decision.action !== 'BAN') {
        try {
          const explanationText = this.buildDuplicateExplanation(
            userLabel,
            decision,
            muteDurationHours,
            messageDeleted,
            duplicateBotMessageText,
            botSpeechStyle,
          );
          await this.sendBotMessageWithOptionalAutoDelete({
            chatId,
            text:
              decision.action === 'WARN'
                ? await this.appendAdminContactMarkdownLink(
                    chatId,
                    explanationText,
                    duplicateAdminContactButtonEnabled,
                    duplicateAdminContactButtonUrl,
                  )
                : explanationText,
            messageOptions: duplicateMessageOptions ?? undefined,
            media: this.resolveBotSpeechMedia({ botSpeechMedia }, 'duplicateBotMessageText'),
            deleteBotMessagesEnabled,
            deleteBotMessagesDelayMinutes,
          });
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId,
              userId,
              messageId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed to send duplicate explanation message',
          );
        }
      }
    };

    await this.runWebhookFollowUpWithBudget({
      stage: 'duplicate-follow-up',
      hotPathProfile,
      chatId,
      userId,
      messageId,
      maxWaitMs: DUPLICATE_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
      minRemainingMs: DUPLICATE_FOLLOW_UP_DETACH_MIN_REMAINING_MS,
      task: runDuplicateFollowUp,
    });
  }

  private async handleDuplicateHit(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    hit: DuplicateHit;
    userLabel: string;
    botSpeechStyle: BotSpeechStyle | null;
    botSpeechMedia: ChatSettings['botSpeechMedia'];
    duplicateBotMessageEnabled: boolean;
    duplicateBotMessageText: string;
    duplicateBotButtons: unknown;
    duplicateBotButtonEnabled: boolean;
    duplicateBotButtonUrl: string;
    duplicateBotButtonText: string;
    duplicateAdminContactButtonEnabled: boolean;
    duplicateAdminContactButtonUrl: string;
    rulesAttachViolationsEnabled: boolean;
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    suppressNonEssentialMessages: boolean;
    hotPathProfile?: WebhookHotPathProfile | null;
  }) {
    const {
      chatId,
      userId,
      messageId,
      text,
      createdAt,
      hit,
      userLabel,
      botSpeechStyle,
      botSpeechMedia,
      duplicateBotMessageEnabled,
      duplicateBotMessageText,
      duplicateBotButtons,
      duplicateBotButtonEnabled,
      duplicateBotButtonUrl,
      duplicateBotButtonText,
      duplicateAdminContactButtonEnabled,
      duplicateAdminContactButtonUrl,
      rulesAttachViolationsEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      suppressNonEssentialMessages,
      hotPathProfile,
    } = params;
    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;
    let messageDeleted = false;

    if (canDeleteMessage) {
      try {
        this.markWebhookHotPathStage(hotPathProfile, 'duplicate-delete');
        messageDeleted = await this.deleteMessageImmediately(chatId, messageId);
        if (messageDeleted) {
          await this.createBotModerationEvent({
            data: {
              chatId,
              userId,
              messageId,
              eventType: EventType.MESSAGE,
              ruleCode: 'DUPLICATE_DELETE',
              action: SanctionAction.DELETE_MESSAGE,
              maskedExcerpt: maskText(text),
              score: 0.8,
              operator: Operator.BOT,
              metadata: {
                windowSec: hit.windowSec,
                count: hit.count,
                reason: 'Duplicate message removed',
              },
            },
          });
          this.markWebhookHotPathSuccessBoundary(hotPathProfile, 'duplicate-delete');
        }
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to delete duplicate message',
        );
      }
    } else {
      await this.maxClient.notifyModerators(
        chatId,
        `Нарушение DUPLICATE от ${userId}, но сообщение старше 24 часов и не может быть удалено`,
      );
    }

    this.markWebhookHotPathStage(hotPathProfile, 'duplicate-follow-up');
    const runDuplicateFollowUp = async () => {
      const duplicateMessageOptions = this.buildBotMessageOptions(
        chatId,
        duplicateBotButtons,
        duplicateBotButtonEnabled,
        duplicateBotButtonUrl,
        duplicateBotButtonText,
        rulesAttachViolationsEnabled,
        rulesPublishedUrl,
        rulesPublishedMessageId,
      );

      if (!suppressNonEssentialMessages && duplicateBotMessageEnabled) {
        try {
          await this.sendBotMessageWithOptionalAutoDelete({
            chatId,
            text: await this.appendAdminContactMarkdownLink(
              chatId,
              this.buildDuplicateHitExplanation(
                userLabel,
                messageDeleted,
                duplicateBotMessageText,
                botSpeechStyle,
              ),
              duplicateAdminContactButtonEnabled,
              duplicateAdminContactButtonUrl,
            ),
            messageOptions: duplicateMessageOptions ?? undefined,
            media: this.resolveBotSpeechMedia({ botSpeechMedia }, 'duplicateBotMessageText'),
            deleteBotMessagesEnabled,
            deleteBotMessagesDelayMinutes,
          });
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId,
              userId,
              messageId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed to send duplicate explanation message',
          );
        }
      }
    };

    await this.runWebhookFollowUpWithBudget({
      stage: 'duplicate-follow-up',
      hotPathProfile,
      chatId,
      userId,
      messageId,
      maxWaitMs: DUPLICATE_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
      minRemainingMs: DUPLICATE_FOLLOW_UP_DETACH_MIN_REMAINING_MS,
      task: runDuplicateFollowUp,
    });
  }

  private toSanctionAction(action: DuplicateAction): SanctionAction {
    if (action === 'WARN') {
      return SanctionAction.WARN;
    }
    if (action === 'MUTE') {
      return SanctionAction.MUTE;
    }
    return SanctionAction.BAN;
  }

  private async tryHandleKaravanStorefrontRelay(params: {
    update: MaxUpdate;
    updateType: string | null;
    chatId: string;
    messageId?: string | null;
    senderId: string;
    senderName?: string | null;
    text?: string | null;
  }): Promise<boolean> {
    if (!params.messageId || !this.karavanStorefrontRelayService) {
      return false;
    }

    const result = await this.karavanStorefrontRelayService.handleMessageCreated({
      updateType: params.updateType,
      chatId: params.chatId,
      messageId: params.messageId,
      senderId: params.senderId,
      senderName: params.senderName,
      text: params.text,
      raw: params.update.raw,
      botId: params.update.botId ?? null,
    });

    return result === 'handled' || result === 'duplicate';
  }

  private buildLinkExplanation(
    userLabel: string,
    canDeleteMessage: boolean,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
    editedMessage = false,
  ): string {
    const reason = editedMessage
      ? 'ссылка появилась после тихой правки; в этом чате ссылки не проходят'
      : 'в этом чате ссылки не проходят, без ссылок';
    const messageStatus = this.buildMessageStatusLabel(canDeleteMessage);
    const hasTemplateOverride = typeof templateText === 'string' && templateText.trim().length > 0;
    if (editedMessage && !hasTemplateOverride) {
      const editedFallback =
        '{user}, ссылку убрал. Расчёт на тихую правку был элегантный, но протокол внимательный: ссылки здесь не проходят.';
      return this.renderBotMessageTemplate(editedFallback, editedFallback, {
        user: userLabel,
        message_status: messageStatus,
        reason,
      });
    }

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'linkBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        message_status: messageStatus,
        reason,
      },
    });
  }

  private buildRequiredSubscriptionExplanation(
    userLabel: string,
    canDeleteMessage: boolean,
    channelTitles: readonly string[],
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const channelsLabel = this.formatRequiredSubscriptionChannels(channelTitles);

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'requiredSubscriptionBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        channels: channelsLabel,
        message_status: this.buildMessageStatusLabel(canDeleteMessage),
      },
    });
  }

  private buildRequiredSubscriptionWarnExplanation(
    userLabel: string,
    channelTitles: readonly string[],
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const channelsLabel = this.formatRequiredSubscriptionChannels(channelTitles);
    const reason = 'для сообщений нужна подписка на обязательные чаты или каналы';
    const warning = 'вынесено предупреждение за отсутствие обязательной подписки';

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'requiredSubscriptionWarnMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        channels: channelsLabel,
        reason,
        warning,
      },
    });
  }

  private buildInvitationAccessExplanation(
    userLabel: string,
    canDeleteMessage: boolean,
    requiredCount: number,
    invitedCount: number,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'invitationAccessBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        message_status: this.buildMessageStatusLabel(canDeleteMessage),
        ...this.buildInvitationAccessTemplateReplacements(requiredCount, invitedCount),
      },
    });
  }

  private buildInvitationAccessWarnExplanation(
    userLabel: string,
    requiredCount: number,
    invitedCount: number,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const reason = 'для сообщений нужно пригласить друзей в чат';
    const warning = 'вынесено предупреждение за доступ без приглашений';

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'invitationAccessWarnMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        reason,
        warning,
        ...this.buildInvitationAccessTemplateReplacements(requiredCount, invitedCount),
      },
    });
  }

  private buildLinkWarnExplanation(
    userLabel: string,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
    editedMessage = false,
  ): string {
    const reason = editedMessage
      ? 'ссылка появилась после тихой правки; в этом чате ссылки всё ещё нельзя'
      : 'в этом чате ссылки не проходят, без ссылок';
    const warning = editedMessage
      ? 'вынесено предупреждение за ссылку после редактирования'
      : 'вынесено предупреждение за ссылку';
    const hasTemplateOverride = typeof templateText === 'string' && templateText.trim().length > 0;
    if (editedMessage && !hasTemplateOverride) {
      const editedFallback =
        '{user}, предупреждение за ссылку. Расчёт на тихую правку был элегантный, но протокол внимательный: ссылки здесь всё ещё нельзя.';
      return this.renderBotMessageTemplate(editedFallback, editedFallback, {
        user: userLabel,
        reason,
        warning,
      });
    }

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'linkWarnMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        reason,
        warning,
      },
    });
  }

  private formatRequiredSubscriptionChannels(channelTitles: readonly string[]): string {
    const normalizedTitles = channelTitles
      .map((item) => item.replace(/\s+/g, ' ').trim())
      .filter((item) => item.length > 0)
      .map((item) => this.escapeMaxMarkdownText(item));

    if (normalizedTitles.length === 0) {
      return 'обязательные чаты или каналы';
    }

    return normalizedTitles.join(', ');
  }

  private buildInvitationAccessTemplateReplacements(
    requiredCount: number,
    invitedCount: number,
  ): Record<string, string> {
    const normalizedRequiredCount = this.normalizeInvitationAccessRequiredCount(requiredCount);
    const normalizedInvitedCount = Math.max(0, Math.trunc(invitedCount));
    const visibleInvitedCount = Math.min(normalizedRequiredCount, normalizedInvitedCount);
    const remainingCount = Math.max(0, normalizedRequiredCount - normalizedInvitedCount);

    return {
      required_invites: this.formatInvitationAccessInviteCount(normalizedRequiredCount),
      required_invites_count: String(normalizedRequiredCount),
      invited_count: String(visibleInvitedCount),
      remaining_invites: this.formatInvitationAccessInviteCount(remainingCount),
    };
  }

  private formatInvitationAccessInviteCount(count: number): string {
    const normalizedCount = Math.max(0, Math.trunc(count));
    if (normalizedCount === 1) {
      return '1 друга';
    }

    return `${normalizedCount} друзей`;
  }

  private buildInvitationAccessMuteExplanation(
    userLabel: string,
    requiredCount: number,
    invitedCount: number,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'invitationAccessMute',
      replacements: {
        user: userLabel,
        ...this.buildInvitationAccessTemplateReplacements(requiredCount, invitedCount),
      },
    });
  }

  private buildInvitationAccessBanExplanation(
    userLabel: string,
    requiredCount: number,
    invitedCount: number,
    _muteDurationHours: number,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'invitationAccessBan',
      replacements: {
        user: userLabel,
        ...this.buildInvitationAccessTemplateReplacements(requiredCount, invitedCount),
      },
    });
  }

  private buildRequiredSubscriptionMuteExplanation(
    userLabel: string,
    channelTitles: readonly string[],
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'requiredSubscriptionMute',
      replacements: {
        user: userLabel,
        channels: this.formatRequiredSubscriptionChannels(channelTitles),
      },
    });
  }

  private buildRequiredSubscriptionBanExplanation(
    userLabel: string,
    channelTitles: readonly string[],
    _muteDurationHours: number,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'requiredSubscriptionBan',
      replacements: {
        user: userLabel,
        channels: this.formatRequiredSubscriptionChannels(channelTitles),
      },
    });
  }

  private buildLinkMuteExplanation(
    userLabel: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'linkMute',
      replacements: {
        user: userLabel,
      },
    });
  }

  private buildTextFilterWarnExplanation(
    userLabel: string,
    ruleCode: string,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const reason =
      ruleCode === 'COMMERCIAL_AD'
        ? 'коммерческую рекламу'
        : ruleCode === 'PROFANITY'
          ? 'грубую лексику'
          : 'нарушение текстовых правил';
    const warning = `вынесено предупреждение за ${reason}`;

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'textFiltersWarnMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        reason,
        warning,
      },
    });
  }

  private buildTextFilterMuteExplanation(
    userLabel: string,
    ruleCode: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const templateKey =
      ruleCode === 'COMMERCIAL_AD'
        ? 'textFiltersMuteCommercial'
        : ruleCode === 'PROFANITY'
          ? 'textFiltersMuteProfanity'
          : 'textFiltersMuteGeneric';

    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey,
      replacements: {
        user: userLabel,
      },
    });
  }

  private buildTopicFilterExplanation(
    userLabel: string,
    canDeleteMessage: boolean,
    requiredCodeword: string | null,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const messageStatus = this.buildMessageStatusLabel(canDeleteMessage);
    const reason = this.resolveTopicFilterRequirementLabel(requiredCodeword);
    const templateKey = requiredCodeword ? 'topicExplainAnnouncement' : 'topicExplainMessage';

    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey,
      replacements: {
        user: userLabel,
        message_status: messageStatus,
        reason,
      },
    });
  }

  private buildTopicFilterWarnExplanation(
    userLabel: string,
    requiredCodeword: string | null,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const reason = this.resolveTopicFilterRequirementLabel(requiredCodeword);

    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'topicWarn',
      replacements: {
        user: userLabel,
        reason,
      },
    });
  }

  private buildTopicFilterMuteExplanation(
    userLabel: string,
    requiredCodeword: string | null,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: requiredCodeword ? 'topicMuteAnnouncement' : 'topicMuteMessage',
      replacements: {
        user: userLabel,
      },
    });
  }

  private buildTopicFilterBanExplanation(
    userLabel: string,
    requiredCodeword: string | null,
    _muteDurationHours: number,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const reason = this.resolveTopicFilterRequirementLabel(requiredCodeword);

    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'topicBan',
      replacements: {
        user: userLabel,
        reason,
      },
    });
  }

  private buildDuplicateExplanation(
    userLabel: string,
    decision: DuplicateDecision,
    muteDurationHours: number,
    messageDeleted: boolean,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const banDurationLabel = this.formatMuteDurationLabel(muteDurationHours);
    const baseContext = this.buildDuplicateContextLabel(messageDeleted);
    const sanction = this.buildDuplicateSanctionLabel(
      botSpeechStyle,
      decision.action,
      banDurationLabel,
    );

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'duplicateBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        message_status: this.buildMessageStatusLabel(messageDeleted),
        reason: 'в этом чате серийные повторы не проходят',
        duplicate_context: baseContext,
        sanction,
        mute_duration: banDurationLabel,
        ban_duration: banDurationLabel,
      },
    });
  }

  private buildDuplicateHitExplanation(
    userLabel: string,
    messageDeleted: boolean,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const duplicateContext = this.buildDuplicateContextLabel(messageDeleted);
    const messageStatus = this.buildMessageStatusLabel(messageDeleted);

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'duplicateBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        message_status: messageStatus,
        reason: 'в этом чате серийные повторы не проходят',
        duplicate_context: duplicateContext,
        sanction: this.buildDuplicatePassiveSanctionLabel(botSpeechStyle, messageDeleted),
      },
    });
  }

  private resolveEditableBotSpeechText(
    style: BotSpeechStyle | null,
    fieldKey: BotSpeechEditableFieldKey,
    overrideText: string,
  ): string {
    const normalizedOverride =
      typeof overrideText === 'string' && overrideText.trim().length > 0 ? overrideText.trim() : '';

    return normalizedOverride.length > 0
      ? normalizedOverride
      : getBotSpeechEditableTemplate(style, fieldKey, this.resolveActiveBotSpeechProfile().persona);
  }

  private renderEditableBotSpeechTemplate(params: {
    style: BotSpeechStyle | null;
    fieldKey: BotSpeechEditableFieldKey;
    overrideText: string;
    replacements: Record<string, string>;
  }): string {
    const activeBotSpeechProfile = this.resolveActiveBotSpeechProfile();
    const fallback = getBotSpeechEditableTemplate(
      params.style,
      params.fieldKey,
      activeBotSpeechProfile.persona,
    );

    return this.renderBotMessageTemplate(
      this.resolveEditableBotSpeechText(params.style, params.fieldKey, params.overrideText),
      fallback,
      {
        ...this.buildBotSpeechTemplateReplacements(activeBotSpeechProfile),
        ...params.replacements,
      },
    );
  }

  private renderSystemBotSpeechTemplate(params: {
    style: BotSpeechStyle | null;
    templateKey: BotSpeechSystemTemplateKey;
    replacements: Record<string, string>;
  }): string {
    const activeBotSpeechProfile = this.resolveActiveBotSpeechProfile();
    const template = getBotSpeechSystemTemplate(
      params.style,
      params.templateKey,
      activeBotSpeechProfile.persona,
    );

    return this.renderBotMessageTemplate(template, template, {
      ...this.buildBotSpeechTemplateReplacements(activeBotSpeechProfile),
      ...params.replacements,
    });
  }

  private buildBotSpeechTemplateReplacements(
    activeBotSpeechProfile: ActiveBotSpeechProfile,
  ): Record<string, string> {
    return {
      bot_character_name: activeBotSpeechProfile.characterName,
    };
  }

  private renderBotMessageTemplate(
    templateText: string,
    fallbackText: string,
    replacements: Record<string, string>,
  ): string {
    const normalizedTemplate =
      typeof templateText === 'string' && templateText.trim().length > 0 ? templateText.trim() : '';
    if (!normalizedTemplate) {
      return fallbackText;
    }

    let rendered = normalizedTemplate;
    for (const [key, value] of Object.entries(replacements)) {
      rendered = rendered.split(`{${key}}`).join(value);
    }

    const normalizedRendered = rendered.trim();
    return normalizedRendered.length > 0 ? normalizedRendered : fallbackText;
  }

  private buildMajorExplanationFallback(
    userLabel: string,
    subject: 'Сообщение' | 'Объявление',
    messageStatus: string,
    reason: string,
  ): string {
    const activeBotSpeechProfile = this.resolveActiveBotSpeechProfile();
    const badge = activeBotSpeechProfile.persona === 'female' ? '👮‍♀️' : '👮‍♂️';
    return `Товарищ ${userLabel}, ${activeBotSpeechProfile.characterName} на линии ${badge} ${subject} ${messageStatus}: ${reason}. Подправьте по форме и снова в эфир.`;
  }

  private resolveTopicFilterRequirementLabel(requiredCodeword: string | null): string {
    if (requiredCodeword) {
      return `объявление должно начинаться с кодового слова "${this.escapeMaxMarkdownText(requiredCodeword)}"`;
    }

    return 'сообщение не проходит тематический фильтр';
  }

  private extractTopicFilterRequiredCodeword(metadata?: Record<string, unknown>): string | null {
    const rawCodeword = metadata?.requiredCodeword;
    return typeof rawCodeword === 'string' && rawCodeword.trim().length > 0
      ? rawCodeword.trim()
      : null;
  }

  private buildMessageStatusLabel(canDeleteMessage: boolean): string {
    return canDeleteMessage ? 'снято с линии' : 'не по форме';
  }

  private buildDuplicateContextLabel(canDeleteMessage: boolean): string {
    return canDeleteMessage ? 'снято с линии как дубль' : 'идёт повтором';
  }

  private buildDuplicateSanctionLabel(
    style: BotSpeechStyle | null,
    action: SanctionAction,
    muteDurationLabel: string,
  ): string {
    if (style === 'POLICE' || style === null) {
      const activeBotPersona = this.resolveActiveBotSpeechProfile().persona;
      if (action === 'WARN') {
        return activeBotPersona === 'female' ? 'Взяла на карандаш 📝.' : 'Взял на карандаш 📝.';
      }
      if (action === 'MUTE') {
        return `Включаю тихий режим на ${muteDurationLabel} 🔒.`;
      }
      return 'Тут уже шлагбаум ⛔ До ручного разбана.';
    }

    if (style === 'ROBOT') {
      if (action === 'WARN') {
        return '⚠️ Предупреждение записано.';
      }
      if (action === 'MUTE') {
        return `🔒 Включен мут на ${muteDurationLabel}.`;
      }
      return '⛔ Включен бан до ручного снятия.';
    }

    if (style === 'FRIENDLY') {
      if (action === 'WARN') {
        return '⚠️ Это уже предупреждение.';
      }
      if (action === 'MUTE') {
        return `🔒 Включил мут на ${muteDurationLabel}.`;
      }
      return '⛔ Пришлось выдать бан до ручного разбана.';
    }

    if (style === 'IRONIC') {
      if (action === 'WARN') {
        return '⚠️ Это уже предупреждение. Повтор не сделал мысль сильнее.';
      }
      if (action === 'MUTE') {
        return `🔒 Мут на ${muteDurationLabel}. Со второго дубля лучше не стало.`;
      }
      return '⛔ Дальше уже только ручной разбан.';
    }

    if (action === 'WARN') {
      return 'Фиксирую предупреждение.';
    }
    if (action === 'MUTE') {
      return `Оформляю мут на ${muteDurationLabel}.`;
    }
    return 'Оформляю бан до ручного снятия.';
  }

  private buildDuplicatePassiveSanctionLabel(
    style: BotSpeechStyle | null,
    messageDeleted: boolean,
  ): string {
    if (style === 'POLICE' || style === null) {
      if (!messageDeleted) {
        return this.resolveActiveBotSpeechProfile().persona === 'female'
          ? 'Повтор взяла на карандаш, пока без санкций.'
          : 'Повтор взял на карандаш, пока без санкций.';
      }

      return this.resolveActiveBotSpeechProfile().persona === 'female'
        ? 'Этот экземпляр прикрыла.'
        : 'Этот экземпляр прикрыл.';
    }

    if (style === 'ROBOT') {
      return messageDeleted ? '🧹 Дубль убран.' : '🧾 Дубль отмечен без санкции.';
    }

    if (style === 'FRIENDLY') {
      return messageDeleted ? '🧹 Повтор убрал.' : '👀 Повтор заметил, пока без санкций.';
    }

    if (style === 'IRONIC') {
      return messageDeleted
        ? '♻️ Повтор убрал. Второй дубль тут был лишним.'
        : '👀 Повтор заметил. Пока без санкций, но мысль уже учтена.';
    }

    return 'Пока без взыскания.';
  }

  private escapeMaxMarkdownText(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/([*_`[\]()~+])/g, '\\$1');
  }

  private async appendAdminContactMarkdownLink(
    chatId: string,
    text: string,
    enabled: boolean,
    url: string | null | undefined,
  ): Promise<string> {
    const fallbackDisplayName = enabled
      ? await this.resolveAdminContactFallbackDisplayName(chatId, url)
      : null;
    return appendAdminContactMarkdownLinkText(text, {
      enabled,
      url,
      botTokens: this.getAdminContactValidationTokens(),
      fallbackDisplayName,
    });
  }

  private async resolveAdminContactFallbackDisplayName(
    chatId: string,
    url: string | null | undefined,
  ): Promise<string | null> {
    const target = resolveAdminContactMentionTarget(url, this.getAdminContactValidationTokens());
    if (!target?.userId || target.displayName) {
      return null;
    }

    const cacheKey = `${chatId}:${target.userId}`;
    const cached = this.adminContactDisplayNameCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.value;
    }

    const resolved =
      (await this.resolveLocalAdminContactDisplayName(chatId, target.userId)) ??
      (await this.resolveRemoteAdminContactDisplayName(chatId, target.userId));
    this.adminContactDisplayNameCache.set(cacheKey, {
      value: resolved,
      expiresAtMs: Date.now() + ADMIN_CONTACT_DISPLAY_NAME_CACHE_TTL_MS,
    });
    return resolved;
  }

  private async resolveLocalAdminContactDisplayName(
    chatId: string,
    userId: string,
  ): Promise<string | null> {
    if (typeof this.prisma.$queryRaw !== 'function') {
      return null;
    }

    try {
      const rows = await this.prisma.$queryRaw<Array<{ sender_name: string | null }>>`
        SELECT sender_name
        FROM (
          SELECT
            sender_name,
            event_at
          FROM chat_membership_activity_events
          WHERE chat_id = ${chatId}
            AND user_id = ${userId}
            AND sender_name IS NOT NULL

          UNION ALL

          SELECT
            NULLIF(BTRIM(normalized_payload->'message'->>'senderName'), '') AS sender_name,
            created_at AS event_at
          FROM webhook_events
          WHERE NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') = ${chatId}
            AND NULLIF(BTRIM(normalized_payload->'message'->>'senderId'), '') = ${userId}
            AND NULLIF(BTRIM(normalized_payload->'message'->>'senderName'), '') IS NOT NULL
        ) local_name_events
        ORDER BY event_at DESC
        LIMIT 1
      `;
      const senderName = Array.isArray(rows) ? rows[0]?.sender_name?.trim() : '';
      return senderName || null;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve local admin contact display name',
      );
      return null;
    }
  }

  private async resolveRemoteAdminContactDisplayName(
    chatId: string,
    userId: string,
  ): Promise<string | null> {
    const loadProfiles = this.maxClient.getChatMemberProfiles?.bind(this.maxClient);
    if (!loadProfiles) {
      return null;
    }

    try {
      const profiles = await raceWithTimeout({
        operation: loadProfiles(chatId, [userId], {
          trafficClass: 'interactive',
          actionHealthLane: 'background',
        }),
        timeoutMs: ADMIN_CONTACT_DISPLAY_NAME_LOOKUP_TIMEOUT_MS,
        onTimeout: () => new Map(),
      });
      const displayName = profiles.get(userId)?.displayName?.trim() ?? '';
      return displayName || null;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve remote admin contact display name',
      );
      return null;
    }
  }

  private getAdminContactValidationTokens(): readonly string[] {
    const tokens = this.maxBotLinkService?.getValidationTokens?.() ?? [this.getCurrentBotToken()];
    return tokens
      .map((token) => (typeof token === 'string' ? token.trim() : ''))
      .filter((token) => token.length > 0);
  }

  private formatUserLabel(senderName?: string, userId?: string): string {
    const normalized = typeof senderName === 'string' ? senderName.replace(/\s+/g, ' ').trim() : '';
    const safe = normalized.length > 0 ? this.escapeMaxMarkdownText(normalized) : 'Пользователь';
    if (typeof userId === 'string' && userId.trim().length > 0) {
      return `[${safe}](max://user/${encodeURIComponent(userId)})`;
    }
    return `**${safe}**`;
  }

  private async applySanctionAction(params: {
    chatId: string;
    userId: string;
    action: SanctionAction;
    userLabel: string;
    messageId: string;
    muteDurationHours: number;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    botMessageOptions?: MaxSendMessageOptions;
    sanctionNoticeText?: string;
    botSpeechStyle: BotSpeechStyle | null;
    trackAsGlobalSpammer?: boolean;
  }) {
    const {
      chatId,
      userId,
      action,
      userLabel,
      messageId,
      muteDurationHours,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      botMessageOptions,
      sanctionNoticeText,
      botSpeechStyle,
      trackAsGlobalSpammer = true,
    } = params;
    if (this.isKnownRuntimeBotUserId(userId)) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          action,
        },
        'Skipped sanction for configured MAX bot user',
      );
      return;
    }

    if (action === SanctionAction.MUTE) {
      await this.rememberActiveMuteState(chatId, userId, {
        eventId: `runtime:${chatId}:${userId}:${Date.now()}`,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + muteDurationHours * 60 * 60 * 1000),
        durationHours: muteDurationHours,
        permanent: false,
      });
      await this.sendMuteNotice({
        chatId,
        userId,
        messageId,
        userLabel,
        muteDurationHours,
        deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes,
        botMessageOptions,
        sanctionNoticeText,
        botSpeechStyle,
      });
      return;
    }

    if (action !== SanctionAction.BAN) {
      return;
    }

    await this.rememberInactiveActiveMuteState(chatId, userId);

    if (trackAsGlobalSpammer) {
      await this.upsertGlobalSpammerEntry({
        userId,
        sourceChatId: chatId,
        reason: 'SANCTION_BAN',
        evidence: {
          action: 'BAN',
          source: 'sanction',
        },
      });
    }

    let memberBanned = false;
    try {
      memberBanned = await this.banMemberImmediately(chatId, userId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to ban member',
      );
    }

    if (!memberBanned) {
      return;
    }

    await this.sendBanNoticeMessage({
      chatId,
      userId,
      messageId,
      userLabel,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      botMessageOptions,
      sanctionNoticeText,
      botSpeechStyle,
    });
  }

  private async deleteMessageImmediately(
    chatId: string,
    messageId: string,
    options?: Omit<MaxActionDispatchOptions, 'immediate'>,
  ): Promise<boolean> {
    return this.executeModerationActionWithFallback({
      chatId,
      action: 'delete_message',
      messageId,
      explicitBotId: options?.botId,
      operation: async (botId) => {
        await this.maxClient.deleteMessage(chatId, messageId, {
          trafficClass: 'critical',
          actionHealthLane: 'critical',
          sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
          ...(options ?? {}),
          ...(botId ? { botId } : {}),
          immediate: true,
        });
      },
    });
  }

  private async kickMemberImmediately(
    chatId: string,
    userId: string,
    options?: Omit<MaxActionDispatchOptions, 'immediate'>,
  ): Promise<boolean> {
    if (this.isKnownRuntimeBotUserId(userId)) {
      this.logger.warn(
        {
          chatId,
          userId,
        },
        'Skipped kick for configured MAX bot user',
      );
      return false;
    }

    return this.executeModerationActionWithFallback({
      chatId,
      action: 'moderate_member',
      userId,
      explicitBotId: options?.botId,
      operation: async (botId) => {
        await this.maxClient.kickMember(chatId, userId, {
          trafficClass: 'critical',
          actionHealthLane: 'critical',
          sourceTag: MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
          ...(options ?? {}),
          ...(botId ? { botId } : {}),
          immediate: true,
        });
      },
    });
  }

  private async banMemberImmediately(
    chatId: string,
    userId: string,
    options?: Omit<MaxActionDispatchOptions, 'immediate'>,
  ): Promise<boolean> {
    if (this.isKnownRuntimeBotUserId(userId)) {
      this.logger.warn(
        {
          chatId,
          userId,
        },
        'Skipped ban for configured MAX bot user',
      );
      return false;
    }

    return this.executeModerationActionWithFallback({
      chatId,
      action: 'moderate_member',
      userId,
      explicitBotId: options?.botId,
      operation: async (botId) => {
        await this.maxClient.banMember(chatId, userId, {
          trafficClass: 'critical',
          actionHealthLane: 'critical',
          sourceTag: MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
          ...(options ?? {}),
          ...(botId ? { botId } : {}),
          immediate: true,
        });
      },
    });
  }

  private async sendMuteNotice(params: {
    chatId: string;
    userId: string;
    messageId: string;
    userLabel: string;
    muteDurationHours: number;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    botMessageOptions?: MaxSendMessageOptions;
    sanctionNoticeText?: string;
    botSpeechStyle: BotSpeechStyle | null;
  }) {
    const {
      chatId,
      userId,
      messageId,
      userLabel,
      muteDurationHours,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      botMessageOptions,
      sanctionNoticeText,
      botSpeechStyle,
    } = params;
    const noticeText =
      sanctionNoticeText ?? this.buildMuteNotice(userLabel, muteDurationHours, botSpeechStyle);
    try {
      await this.sendBotMessageWithOptionalAutoDelete({
        chatId,
        text: noticeText,
        messageOptions: botMessageOptions,
        deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to send mute notice message',
      );
    }
  }

  private async sendBanNoticeMessage(params: {
    chatId: string;
    userId: string;
    messageId: string;
    userLabel: string;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    botMessageOptions?: MaxSendMessageOptions;
    sanctionNoticeText?: string;
    botSpeechStyle: BotSpeechStyle | null;
  }) {
    const {
      chatId,
      userId,
      messageId,
      userLabel,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      botMessageOptions,
      sanctionNoticeText,
      botSpeechStyle,
    } = params;

    const noticeText =
      sanctionNoticeText ?? this.buildPermanentBanNotice(userLabel, botSpeechStyle);
    try {
      await this.sendBotMessageWithOptionalAutoDelete({
        chatId,
        text: noticeText,
        messageOptions: botMessageOptions,
        deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to send permanent ban notice message',
      );
    }
  }

  private buildMuteNotice(
    userLabel: string,
    muteDurationHours: number,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'muteNotice',
      replacements: {
        user: userLabel,
        mute_duration: this.formatMuteDurationLabel(muteDurationHours),
        ban_duration: this.formatMuteDurationLabel(muteDurationHours),
      },
    });
  }

  private buildPermanentBanNotice(
    userLabel: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    if (botSpeechStyle === 'ROBOT') {
      return `⛔ ${userLabel}, включен бан до ручного снятия.`;
    }

    if (botSpeechStyle === 'FRIENDLY') {
      return `⛔ ${userLabel}, пришлось выдать бан до ручного разбана.`;
    }

    if (botSpeechStyle === 'IRONIC') {
      return `${userLabel}, дальше уже только ручной разбан ⛔.`;
    }

    return `Товарищ ${userLabel}, тут уже шлагбаум ⛔ До ручного разбана.`;
  }

  private resolveActiveBotSpeechProfile(): ActiveBotSpeechProfile {
    const activeBotId = this.maxBotContextService?.getActiveBotId() ?? null;
    const bot = this.maxBotLinkService?.getResolvedBotSync?.(activeBotId);
    const characterName = bot?.characterName?.trim() || bot?.label?.trim() || 'Майор Максимов';

    return {
      persona: bot?.speechPersona ?? 'male',
      characterName,
    };
  }

  private buildPrivateMenuPromptText(): string {
    const profile = this.resolveActiveBotSpeechProfile();
    return [
      profile.characterName,
      BOT_PRIVATE_MENU_APP_LINE,
      buildUserAgreementShortNotice(this.appBaseUrl),
      buildBotStartQuickActionText(profile),
    ].join('\n');
  }

  private shouldResolveSanction(ruleCode: string): boolean {
    return !NON_SANCTION_RULE_CODES.has(ruleCode);
  }

  private resolveLinkEscalationAction(
    linkViolationCount24h: number,
    settings: {
      warnEnabled: boolean;
      banEnabled: boolean;
      muteEnabled: boolean;
      warnMaxCount?: number;
      muteMaxCount?: number;
      banMaxCount?: number;
    },
  ): SanctionAction {
    const warnMaxCount = settings.warnMaxCount ?? 2;
    const muteMaxCount = settings.muteMaxCount ?? (settings.warnEnabled ? warnMaxCount + 1 : 2);
    const banMaxCount =
      settings.banMaxCount ??
      (settings.muteEnabled ? muteMaxCount + 1 : settings.warnEnabled ? warnMaxCount + 1 : 2);

    return this.resolveConfiguredEscalationAction(linkViolationCount24h, {
      ...settings,
      warnMaxCount,
      muteMaxCount,
      banMaxCount,
    });
  }

  private resolveRequiredSubscriptionEscalationAction(
    requiredSubscriptionViolationCount24h: number,
    settings: { warnEnabled: boolean; banEnabled: boolean; muteEnabled: boolean },
  ): SanctionAction {
    return this.resolveLinkEscalationAction(requiredSubscriptionViolationCount24h, settings);
  }

  private resolveTextFilterEscalationAction(
    textFilterViolationCount24h: number,
    settings: { warnEnabled: boolean; banEnabled: boolean; muteEnabled: boolean },
  ): SanctionAction {
    const count = Number.isInteger(textFilterViolationCount24h)
      ? Math.max(1, textFilterViolationCount24h)
      : 1;

    if (count >= 4) {
      if (settings.banEnabled) {
        return SanctionAction.BAN;
      }
      if (settings.muteEnabled) {
        return SanctionAction.MUTE;
      }
      if (settings.warnEnabled) {
        return SanctionAction.WARN;
      }
      return SanctionAction.NONE;
    }

    if (count === 3) {
      if (settings.muteEnabled) {
        return SanctionAction.MUTE;
      }
      if (settings.banEnabled) {
        return SanctionAction.BAN;
      }
      if (settings.warnEnabled) {
        return SanctionAction.WARN;
      }
      return SanctionAction.NONE;
    }

    if (count === 2 && settings.warnEnabled) {
      return SanctionAction.WARN;
    }

    return SanctionAction.NONE;
  }

  private resolveConfiguredEscalationAction(
    violationCount: number,
    settings: {
      warnEnabled: boolean;
      banEnabled: boolean;
      muteEnabled: boolean;
      warnMaxCount: number;
      muteMaxCount: number;
      banMaxCount: number;
    },
  ): SanctionAction {
    const count = Number.isInteger(violationCount) ? Math.max(1, violationCount) : 1;
    const thresholds = [
      {
        action: SanctionAction.BAN,
        enabled: settings.banEnabled,
        count: this.normalizeEscalationThreshold(settings.banMaxCount, 4),
      },
      {
        action: SanctionAction.MUTE,
        enabled: settings.muteEnabled,
        count: this.normalizeEscalationThreshold(settings.muteMaxCount, 3),
      },
      {
        action: SanctionAction.WARN,
        enabled: settings.warnEnabled,
        count: this.normalizeEscalationThreshold(settings.warnMaxCount, 2),
      },
    ];

    for (const threshold of thresholds) {
      if (threshold.enabled && count >= threshold.count) {
        return threshold.action;
      }
    }

    return SanctionAction.NONE;
  }

  private normalizeEscalationThreshold(value: number, fallback: number): number {
    return Number.isInteger(value) ? Math.min(20, Math.max(1, value)) : fallback;
  }

  private resolveMessageLimitsEscalationAction(
    violationCount12h: number,
    settings: { warnEnabled: boolean; banEnabled: boolean; muteEnabled: boolean },
  ): SanctionAction {
    const count = Number.isInteger(violationCount12h) ? Math.max(1, violationCount12h) : 1;

    if (count >= 4) {
      if (settings.banEnabled) {
        return SanctionAction.BAN;
      }
      if (settings.muteEnabled) {
        return SanctionAction.MUTE;
      }
      if (settings.warnEnabled) {
        return SanctionAction.WARN;
      }
      return SanctionAction.NONE;
    }

    if (count === 3) {
      if (settings.muteEnabled) {
        return SanctionAction.MUTE;
      }
      if (settings.banEnabled) {
        return SanctionAction.BAN;
      }
      if (settings.warnEnabled) {
        return SanctionAction.WARN;
      }
      return SanctionAction.NONE;
    }

    if (count === 2 && settings.warnEnabled) {
      return SanctionAction.WARN;
    }

    return SanctionAction.NONE;
  }

  private resolveTextFilterEscalationSettings(
    ruleCode: string,
    settings: ChatSettings,
  ): {
    botMessageEnabled: boolean;
    botMessageText: string;
    warnEnabled: boolean;
    warnMessageText: string;
    banEnabled: boolean;
    muteEnabled: boolean;
    adminContactButtonEnabled: boolean;
    adminContactButtonUrl: string;
  } {
    if (ruleCode === 'PROFANITY') {
      return {
        botMessageEnabled: settings.profanityBotMessageEnabled,
        botMessageText: settings.textFiltersBotMessageText,
        warnEnabled: settings.profanityWarnEnabled,
        warnMessageText: settings.textFiltersWarnMessageText,
        banEnabled: settings.profanityBanEnabled,
        muteEnabled: settings.profanityMuteEnabled,
        adminContactButtonEnabled: settings.profanityAdminContactButtonEnabled,
        adminContactButtonUrl: settings.profanityAdminContactButtonUrl,
      };
    }

    return {
      botMessageEnabled: settings.textFiltersBotMessageEnabled,
      botMessageText: settings.textFiltersBotMessageText,
      warnEnabled: settings.textFiltersWarnEnabled,
      warnMessageText: settings.textFiltersWarnMessageText,
      banEnabled: settings.textFiltersBanEnabled,
      muteEnabled: settings.textFiltersMuteEnabled,
      adminContactButtonEnabled: settings.textFiltersAdminContactButtonEnabled,
      adminContactButtonUrl: settings.textFiltersAdminContactButtonUrl,
    };
  }

  private resolveAutomaticMuteDurationHours(ruleCode: string, settings: ChatSettings): number {
    if (ruleCode === 'LINK_BLOCKED') {
      return settings.linkMuteDurationHours;
    }

    if (ruleCode === 'PHONE_NUMBER_BLOCKED') {
      return settings.phoneNumbersMuteDurationHours;
    }

    if (ruleCode === REQUIRED_SUBSCRIPTION_RULE_CODE) {
      return settings.requiredSubscriptionMuteDurationHours;
    }

    if (ruleCode === INVITATION_ACCESS_RULE_CODE) {
      return settings.invitationAccessMuteDurationHours;
    }

    if (ruleCode === 'PROFANITY') {
      return settings.profanityMuteDurationHours;
    }

    if (this.isTextFilterViolation(ruleCode)) {
      return settings.textFiltersMuteDurationHours;
    }

    if (this.isTopicFilterViolation(ruleCode)) {
      return settings.thematicFiltersMuteDurationHours;
    }

    if (this.isMessageLimitsViolation(ruleCode)) {
      return settings.messageLimitsMuteDurationHours;
    }

    return settings.duplicateMuteDurationHours;
  }

  private isMessageLimitsViolation(ruleCode: string): boolean {
    return MESSAGE_LIMITS_RULE_CODES.has(ruleCode);
  }

  private isTextFilterViolation(ruleCode: string): boolean {
    return TEXT_FILTER_RULE_CODES.has(ruleCode);
  }

  private isTopicFilterViolation(ruleCode: string): boolean {
    return TOPIC_FILTER_RULE_CODES.has(ruleCode);
  }

  private buildTextFilterExplanation(
    userLabel: string,
    ruleCode: string,
    canDeleteMessage: boolean,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const messageStatus = this.buildMessageStatusLabel(canDeleteMessage);
    const reason =
      ruleCode === 'PROFANITY'
        ? 'грубая лексика запрещена правилами чата'
        : 'коммерческая реклама в этом чате запрещена';

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'textFiltersBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        message_status: messageStatus,
        reason,
      },
    });
  }

  private buildMessageLimitsExplanation(
    userLabel: string,
    ruleCode: string,
    canDeleteMessage: boolean,
    messageCountLimitMessages: number,
    messageCountLimitWindowHours: number,
    photoCooldownHours: number,
    stickerCooldownMinutes: number,
    messageLength?: number,
    maxMessageLength?: number,
    blockedWord?: string | null,
    templateText?: string,
    botSpeechStyle?: BotSpeechStyle | null,
  ): string {
    const messageStatus = this.buildMessageStatusLabel(canDeleteMessage);

    if (isMessageLimitsBlockedListRuleCode(ruleCode)) {
      const reason = buildMessageLimitsBlockedReason(ruleCode, blockedWord);
      return this.renderEditableBotSpeechTemplate({
        style: botSpeechStyle ?? null,
        fieldKey: 'messageLimitsBotMessageText',
        overrideText: templateText ?? '',
        replacements: {
          user: userLabel,
          message_status: messageStatus,
          reason,
        },
      });
    }

    if (ruleCode === 'PHONE_NUMBER_BLOCKED') {
      const reason = 'телефонные номера в этом чате запрещены';
      return this.renderEditableBotSpeechTemplate({
        style: botSpeechStyle ?? null,
        fieldKey: 'messageLimitsBotMessageText',
        overrideText: templateText ?? '',
        replacements: {
          user: userLabel,
          message_status: messageStatus,
          reason,
        },
      });
    }

    if (ruleCode === 'MESSAGE_TOO_LONG') {
      const actualLength =
        typeof messageLength === 'number' && Number.isFinite(messageLength) && messageLength > 0
          ? Math.round(messageLength)
          : null;
      const maxLength =
        typeof maxMessageLength === 'number' &&
        Number.isFinite(maxMessageLength) &&
        maxMessageLength > 0
          ? Math.round(maxMessageLength)
          : null;
      const reason =
        actualLength !== null && maxLength !== null
          ? `слишком длинное сообщение: ${actualLength} символов при лимите ${maxLength}`
          : 'слишком длинное сообщение';
      return this.renderEditableBotSpeechTemplate({
        style: botSpeechStyle ?? null,
        fieldKey: 'messageLimitsBotMessageText',
        overrideText: templateText ?? '',
        replacements: {
          user: userLabel,
          message_status: messageStatus,
          reason,
          actual_length: actualLength !== null ? String(actualLength) : '',
          max_length: maxLength !== null ? String(maxLength) : '',
        },
      });
    }

    if (ruleCode === 'MESSAGE_RATE_LIMIT') {
      const reason = `слишком частая отправка сообщений или стикеров: не более ${ANTI_SPAM_BURST_LIMIT} за ${ANTI_SPAM_BURST_WINDOW_SEC}с`;
      return this.renderEditableBotSpeechTemplate({
        style: botSpeechStyle ?? null,
        fieldKey: 'messageLimitsBotMessageText',
        overrideText: templateText ?? '',
        replacements: {
          user: userLabel,
          message_status: messageStatus,
          reason,
          message_limit_count: String(ANTI_SPAM_BURST_LIMIT),
          message_limit_window_seconds: String(ANTI_SPAM_BURST_WINDOW_SEC),
        },
      });
    }

    if (ruleCode === 'MESSAGE_COUNT_LIMIT') {
      const maxMessages =
        Number.isInteger(messageCountLimitMessages) &&
        messageCountLimitMessages >= 1 &&
        messageCountLimitMessages <= 10
          ? messageCountLimitMessages
          : 5;
      const windowHours =
        Number.isInteger(messageCountLimitWindowHours) &&
        messageCountLimitWindowHours >= 1 &&
        messageCountLimitWindowHours <= 24
          ? messageCountLimitWindowHours
          : 1;
      const reason = `слишком частая отправка сообщений: не более ${maxMessages} за ${windowHours}ч`;
      return this.renderEditableBotSpeechTemplate({
        style: botSpeechStyle ?? null,
        fieldKey: 'messageLimitsBotMessageText',
        overrideText: templateText ?? '',
        replacements: {
          user: userLabel,
          message_status: messageStatus,
          reason,
          message_limit_count: String(maxMessages),
          message_limit_window_hours: String(windowHours),
        },
      });
    }

    if (ruleCode === 'PHOTO_BLOCKED') {
      const reason = 'фото в этом чате отключены';
      return this.renderEditableBotSpeechTemplate({
        style: botSpeechStyle ?? null,
        fieldKey: 'messageLimitsBotMessageText',
        overrideText: templateText ?? '',
        replacements: {
          user: userLabel,
          message_status: messageStatus,
          reason,
        },
      });
    }

    if (ruleCode === 'VIDEO_BLOCKED') {
      const reason = 'видео в этом чате отключены';
      return this.renderEditableBotSpeechTemplate({
        style: botSpeechStyle ?? null,
        fieldKey: 'messageLimitsBotMessageText',
        overrideText: templateText ?? '',
        replacements: {
          user: userLabel,
          message_status: messageStatus,
          reason,
        },
      });
    }

    if (ruleCode === 'FILE_BLOCKED') {
      const reason = 'файлы в этом чате отключены';
      return this.renderEditableBotSpeechTemplate({
        style: botSpeechStyle ?? null,
        fieldKey: 'messageLimitsBotMessageText',
        overrideText: templateText ?? '',
        replacements: {
          user: userLabel,
          message_status: messageStatus,
          reason,
        },
      });
    }

    if (ruleCode === 'VOICE_BLOCKED') {
      const reason = 'голосовые сообщения в этом чате отключены';
      return this.renderEditableBotSpeechTemplate({
        style: botSpeechStyle ?? null,
        fieldKey: 'messageLimitsBotMessageText',
        overrideText: templateText ?? '',
        replacements: {
          user: userLabel,
          message_status: messageStatus,
          reason,
        },
      });
    }

    if (ruleCode === 'STICKER_RATE_LIMIT') {
      const minutes =
        Number.isInteger(stickerCooldownMinutes) &&
        stickerCooldownMinutes >= 1 &&
        stickerCooldownMinutes <= 60
          ? stickerCooldownMinutes
          : 5;
      const reason = `слишком частая отправка стикеров: не чаще одного раза в ${minutes} мин`;
      return this.renderEditableBotSpeechTemplate({
        style: botSpeechStyle ?? null,
        fieldKey: 'messageLimitsBotMessageText',
        overrideText: templateText ?? '',
        replacements: {
          user: userLabel,
          message_status: messageStatus,
          reason,
        },
      });
    }

    const hours =
      Number.isInteger(photoCooldownHours) && photoCooldownHours >= 1 && photoCooldownHours <= 24
        ? photoCooldownHours
        : 1;
    const reason = `слишком частая отправка фото: не чаще одного раза в ${hours}ч. Если фото несколько, лучше собрать их в альбом или коллаж`;
    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle ?? null,
      fieldKey: 'messageLimitsBotMessageText',
      overrideText: templateText ?? '',
      replacements: {
        user: userLabel,
        message_status: messageStatus,
        reason,
        photo_cooldown_hours: String(hours),
      },
    });
  }

  private buildPhoneNumbersExplanation(
    userLabel: string,
    canDeleteMessage: boolean,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const messageStatus = this.buildMessageStatusLabel(canDeleteMessage);
    const reason = 'телефонные номера в этом чате запрещены';
    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle ?? null,
      fieldKey: 'phoneNumbersBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        message_status: messageStatus,
        reason,
      },
    });
  }

  private buildMessageLimitsMuteExplanation(
    userLabel: string,
    ruleCode: string,
    blockedWord: string | null | undefined,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'messageLimitsMute',
      replacements: {
        user: userLabel,
        reason: this.resolveMessageLimitsSanctionReasonLabel(ruleCode, blockedWord),
      },
    });
  }

  private buildMessageLimitsWarnExplanation(
    userLabel: string,
    ruleCode: string,
    blockedWord: string | null | undefined,
    botSpeechStyle: BotSpeechStyle | null,
    templateText = '',
  ): string {
    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'messageLimitsWarnMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        reason: this.resolveMessageLimitsSanctionReasonLabel(ruleCode, blockedWord),
      },
    });
  }

  private buildMessageLimitsBanExplanation(
    userLabel: string,
    ruleCode: string,
    _muteDurationHours: number,
    blockedWord: string | null | undefined,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'messageLimitsBan',
      replacements: {
        user: userLabel,
        reason: this.resolveMessageLimitsSanctionReasonLabel(ruleCode, blockedWord),
      },
    });
  }

  private resolveMessageLimitsSanctionReasonLabel(
    ruleCode: string,
    blockedWord?: string | null,
  ): string {
    if (ruleCode === 'PHOTO_RATE_LIMIT') {
      return 'слишком частая отправка фото';
    }

    if (ruleCode === 'PHOTO_BLOCKED') {
      return 'фото в этом чате отключены';
    }

    if (ruleCode === 'STICKER_RATE_LIMIT') {
      return 'слишком частая отправка стикеров';
    }

    if (ruleCode === 'MESSAGE_RATE_LIMIT') {
      return 'слишком частая отправка сообщений или стикеров';
    }

    if (ruleCode === 'MESSAGE_COUNT_LIMIT') {
      return 'слишком частая отправка сообщений';
    }

    if (ruleCode === 'MESSAGE_TOO_LONG') {
      return 'слишком длинное сообщение';
    }

    if (isMessageLimitsBlockedListRuleCode(ruleCode)) {
      return buildMessageLimitsBlockedReason(ruleCode, blockedWord);
    }

    if (ruleCode === 'PHONE_NUMBER_BLOCKED') {
      return 'телефонные номера запрещены';
    }

    if (ruleCode === 'VIDEO_BLOCKED') {
      return 'видео в этом чате отключены';
    }

    if (ruleCode === 'FILE_BLOCKED') {
      return 'файлы в этом чате отключены';
    }

    if (ruleCode === 'VOICE_BLOCKED') {
      return 'голосовые сообщения в этом чате отключены';
    }

    return 'нарушение ограничений сообщений';
  }

  private buildBotMessageOptions(
    chatId: string,
    rawButtons: unknown,
    buttonEnabled: boolean,
    buttonUrl: string,
    buttonText: string,
    rulesButtonEnabled = false,
    rulesPublishedUrl: string | null = null,
    rulesPublishedMessageId: string | null = null,
  ): MaxSendMessageOptions | null {
    const buttons: MaxMessageButton[] = [];
    const rulesMessageLink = this.buildRulesMessageLink(
      rulesButtonEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
    );

    if (buttonEnabled) {
      buttons.push(
        ...this.normalizeConfiguredLinkButtons(rawButtons, {
          buttonUrl,
          buttonText,
        }),
      );
    }

    const rulesButton = this.buildRulesButton(
      chatId,
      rulesButtonEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
    );
    if (rulesButton) {
      buttons.push(rulesButton);
    }

    if (buttons.length === 0 && !rulesMessageLink) {
      return null;
    }

    const buttonRows = this.buildMessageButtonRows(buttons);
    if (
      buttonRows.length === 1 &&
      buttonRows[0].length === 1 &&
      this.isLinkButton(buttonRows[0][0])
    ) {
      return {
        button: buttonRows[0][0],
        ...(rulesMessageLink ? { messageLink: rulesMessageLink } : {}),
      };
    }

    return buttonRows.length > 0
      ? {
          buttons: buttonRows,
          ...(rulesMessageLink ? { messageLink: rulesMessageLink } : {}),
        }
      : {
          messageLink: rulesMessageLink,
        };
  }

  private normalizeConfiguredLinkButtons(
    rawButtons: unknown,
    legacy?: {
      buttonUrl?: string | null;
      buttonText?: string | null;
    },
  ): MaxLinkButton[] {
    const buttons: MaxLinkButton[] = [];

    if (Array.isArray(rawButtons)) {
      for (const item of rawButtons) {
        if (!item || typeof item !== 'object') {
          continue;
        }

        const row = item as { text?: unknown; url?: unknown };
        const button = this.buildLinkButton(
          true,
          typeof row.url === 'string' ? row.url : '',
          typeof row.text === 'string' ? row.text : DEFAULT_BROADCAST_BUTTON_TEXT,
        );
        if (!button) {
          continue;
        }

        buttons.push(button);
      }
    }

    if (buttons.length > 0) {
      return buttons;
    }

    const legacyButton = this.buildLinkButton(
      true,
      legacy?.buttonUrl ?? '',
      legacy?.buttonText ?? DEFAULT_BROADCAST_BUTTON_TEXT,
    );
    return legacyButton ? [legacyButton] : [];
  }

  private buildMessageButtonRows(buttons: readonly MaxMessageButton[]): MaxMessageButton[][] {
    const rows: MaxMessageButton[][] = [];

    for (let index = 0; index < buttons.length; index += MAX_BROADCAST_LINK_BUTTONS_PER_ROW) {
      rows.push(buttons.slice(index, index + MAX_BROADCAST_LINK_BUTTONS_PER_ROW));
    }

    return rows;
  }

  private buildRequiredSubscriptionMessageOptions(
    channels: ReadonlyArray<{ id: string; title: string; link: string | null }>,
    buttonText: string | null | undefined,
    rulesButtonEnabled: boolean,
    rulesPublishedUrl: string | null,
    rulesPublishedMessageId: string | null,
  ): MaxSendMessageOptions | null {
    const normalizedButtonText =
      typeof buttonText === 'string' && buttonText.trim().length > 0 ? buttonText.trim() : null;
    const buttons = channels
      .map((channel) => {
        const normalizedUrl = this.normalizeBotButtonUrl(channel.link ?? '');
        if (!normalizedUrl) {
          return null;
        }

        return {
          text: this.normalizeBotButtonText(normalizedButtonText ?? channel.title),
          url: normalizedUrl,
        } satisfies MaxLinkButton;
      })
      .filter((button): button is MaxLinkButton => button !== null);
    const rulesMessageLink = this.buildRulesMessageLink(
      rulesButtonEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
    );

    if (buttons.length === 0 && !rulesMessageLink) {
      return null;
    }

    return buttons.length > 0
      ? {
          buttons: buttons.map((button) => [button]),
          ...(rulesMessageLink ? { messageLink: rulesMessageLink } : {}),
          debugContext: {
            screen: 'moderation',
            action: 'required-subscription-notice',
          },
        }
      : {
          messageLink: rulesMessageLink,
          debugContext: {
            screen: 'moderation',
            action: 'required-subscription-notice',
          },
        };
  }

  private buildLinkButton(
    buttonEnabled: boolean,
    buttonUrl: string,
    buttonText: string,
  ): MaxLinkButton | null {
    if (!buttonEnabled) {
      return null;
    }

    const normalizedUrl = this.normalizeBotButtonUrl(buttonUrl);
    if (!normalizedUrl) {
      return null;
    }

    return {
      text: this.normalizeBotButtonText(buttonText),
      url: normalizedUrl,
    };
  }

  private buildRulesButton(
    chatId: string,
    buttonEnabled: boolean,
    publishedUrl: string | null,
    publishedMessageId: string | null,
  ): MaxMessageButton | null {
    if (!buttonEnabled) {
      return null;
    }

    const directLinkButton = this.buildLinkButton(
      Boolean(publishedUrl),
      publishedUrl ?? '',
      RULES_BOT_BUTTON_TEXT,
    );
    if (directLinkButton) {
      return directLinkButton;
    }

    if (!chatId.trim() || !publishedMessageId?.trim()) {
      return null;
    }

    return null;
  }

  private buildRulesMessageLink(
    buttonEnabled: boolean,
    publishedUrl: string | null,
    publishedMessageId: string | null,
  ): { type: 'reply'; mid: string } | null {
    if (!buttonEnabled || this.normalizeBotButtonUrl(publishedUrl ?? '')) {
      return null;
    }

    const normalizedMessageId = publishedMessageId?.trim() ?? '';
    if (!normalizedMessageId) {
      return null;
    }

    return {
      type: 'reply',
      mid: normalizedMessageId,
    };
  }

  private isLinkButton(button: MaxMessageButton): button is MaxLinkButton {
    return !('type' in button) || button.type === 'link';
  }

  private normalizeBotButtonUrl(value: string): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return null;
    }

    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }

      return parsed.toString();
    } catch {
      return null;
    }
  }

  private normalizeBotButtonText(value: string): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return DEFAULT_BOT_BUTTON_TEXT;
    }

    return normalized.slice(0, 32);
  }

  private async countRecentViolationsWithEscalationCounter(params: {
    chatId: string;
    userId: string;
    ruleKey: string;
    windowMs: number;
    loadCount: () => Promise<number>;
  }): Promise<number> {
    const windowSec = Math.max(1, Math.ceil(params.windowMs / 1_000));
    const ttlSec = windowSec + 60;
    const redisCounter = this.redisCounter as Partial<RedisCounterService> | undefined;
    const getString = redisCounter?.getString;
    const incrementWithTtl = redisCounter?.incrementWithTtl;
    const setStringWithTtl = redisCounter?.setStringWithTtl;
    if (!this.redisCounter || !getString || !incrementWithTtl || !setStringWithTtl) {
      return this.normalizeRecentViolationCount(await params.loadCount());
    }

    const counterKey = buildModerationEscalationCounterKey({
      chatId: params.chatId,
      userId: params.userId,
      ruleKey: params.ruleKey,
      windowSec,
    });

    try {
      const cachedValue = await getString.call(this.redisCounter, counterKey);
      if (cachedValue !== null) {
        return this.normalizeRecentViolationCount(
          await incrementWithTtl.call(this.redisCounter, counterKey, ttlSec),
        );
      }
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: params.chatId,
          userId: params.userId,
          ruleKey: params.ruleKey,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read moderation escalation counter; falling back to persisted violations',
      );
      return this.normalizeRecentViolationCount(await params.loadCount());
    }

    const persistedCount = this.normalizeRecentViolationCount(await params.loadCount());
    try {
      await setStringWithTtl.call(this.redisCounter, counterKey, String(persistedCount), ttlSec);
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: params.chatId,
          userId: params.userId,
          ruleKey: params.ruleKey,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to warm moderation escalation counter',
      );
    }

    return persistedCount;
  }

  private normalizeRecentViolationCount(value: number): number {
    return Number.isInteger(value) && value > 0 ? value : 1;
  }

  private async countRecentLinkViolations(
    chatId: string,
    userId: string,
    windowHours: number,
  ): Promise<number> {
    const windowMs =
      this.normalizeEscalationWindowHours(windowHours, LINK_ESCALATION_WINDOW_HOURS) *
      60 *
      60 *
      1000;
    return this.countRecentViolationsWithEscalationCounter({
      chatId,
      userId,
      ruleKey: 'LINK_BLOCKED',
      windowMs,
      loadCount: async () => {
        const violationModel = this.prisma.violation as unknown as {
          count?: (args: {
            where: {
              chatId: string;
              userId: string;
              ruleCode: string;
              createdAt: { gte: Date };
            };
          }) => Promise<number>;
        };

        if (typeof violationModel.count !== 'function') {
          return 1;
        }

        const since = await this.resolveViolationResetSince(chatId, userId, windowMs);
        const count = await violationModel.count({
          where: {
            chatId,
            userId,
            ruleCode: 'LINK_BLOCKED',
            createdAt: { gte: since },
          },
        });

        return Number.isInteger(count) && count > 0 ? count : 1;
      },
    });
  }

  private async countRecentPhoneNumberViolations(
    chatId: string,
    userId: string,
    windowHours: number,
  ): Promise<number> {
    const windowMs =
      this.normalizeEscalationWindowHours(windowHours, MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS) *
      60 *
      60 *
      1000;
    return this.countRecentViolationsWithEscalationCounter({
      chatId,
      userId,
      ruleKey: 'PHONE_NUMBER_BLOCKED',
      windowMs,
      loadCount: async () => {
        const violationModel = this.prisma.violation as unknown as {
          count?: (args: {
            where: {
              chatId: string;
              userId: string;
              ruleCode: string;
              createdAt: { gte: Date };
            };
          }) => Promise<number>;
        };

        if (typeof violationModel.count !== 'function') {
          return 1;
        }

        const since = await this.resolveViolationResetSince(chatId, userId, windowMs);
        const count = await violationModel.count({
          where: {
            chatId,
            userId,
            ruleCode: 'PHONE_NUMBER_BLOCKED',
            createdAt: { gte: since },
          },
        });

        return Number.isInteger(count) && count > 0 ? count : 1;
      },
    });
  }

  private normalizeEscalationWindowHours(value: number, fallback: number): number {
    return Number.isInteger(value) ? Math.min(168, Math.max(1, value)) : fallback;
  }

  private async countRecentRequiredSubscriptionViolations(
    chatId: string,
    userId: string,
  ): Promise<number> {
    const windowMs = REQUIRED_SUBSCRIPTION_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000;
    return this.countRecentViolationsWithEscalationCounter({
      chatId,
      userId,
      ruleKey: REQUIRED_SUBSCRIPTION_RULE_CODE,
      windowMs,
      loadCount: async () => {
        const violationModel = this.prisma.violation as unknown as {
          count?: (args: {
            where: {
              chatId: string;
              userId: string;
              ruleCode: string;
              createdAt: { gte: Date };
            };
          }) => Promise<number>;
        };

        if (typeof violationModel.count !== 'function') {
          return 1;
        }

        const since = await this.resolveViolationResetSince(chatId, userId, windowMs);
        const count = await violationModel.count({
          where: {
            chatId,
            userId,
            ruleCode: REQUIRED_SUBSCRIPTION_RULE_CODE,
            createdAt: { gte: since },
          },
        });

        return Number.isInteger(count) && count > 0 ? count : 1;
      },
    });
  }

  private async countRecentInvitationAccessViolations(
    chatId: string,
    userId: string,
  ): Promise<number> {
    const windowMs = INVITATION_ACCESS_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000;
    return this.countRecentViolationsWithEscalationCounter({
      chatId,
      userId,
      ruleKey: INVITATION_ACCESS_RULE_CODE,
      windowMs,
      loadCount: async () => {
        const violationModel = this.prisma.violation as unknown as {
          count?: (args: {
            where: {
              chatId: string;
              userId: string;
              ruleCode: string;
              createdAt: { gte: Date };
            };
          }) => Promise<number>;
        };

        if (typeof violationModel.count !== 'function') {
          return 1;
        }

        const since = await this.resolveViolationResetSince(chatId, userId, windowMs);
        const count = await violationModel.count({
          where: {
            chatId,
            userId,
            ruleCode: INVITATION_ACCESS_RULE_CODE,
            createdAt: { gte: since },
          },
        });

        return Number.isInteger(count) && count > 0 ? count : 1;
      },
    });
  }

  private async countRecentTextFilterViolations(
    chatId: string,
    userId: string,
    ruleCode: string,
  ): Promise<number> {
    const windowMs = TEXT_FILTER_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000;
    const ruleCodeFilter =
      ruleCode === 'PROFANITY' || ruleCode === 'COMMERCIAL_AD'
        ? ruleCode
        : { in: ['PROFANITY', 'COMMERCIAL_AD'] };
    const ruleKey =
      typeof ruleCodeFilter === 'string' ? ruleCodeFilter : ruleCodeFilter.in.join('|');
    return this.countRecentViolationsWithEscalationCounter({
      chatId,
      userId,
      ruleKey,
      windowMs,
      loadCount: async () => {
        const violationModel = this.prisma.violation as unknown as {
          count?: (args: {
            where: {
              chatId: string;
              userId: string;
              ruleCode: string | { in: string[] };
              createdAt: { gte: Date };
            };
          }) => Promise<number>;
        };

        if (typeof violationModel.count !== 'function') {
          return 1;
        }

        const since = await this.resolveViolationResetSince(chatId, userId, windowMs);
        const count = await violationModel.count({
          where: {
            chatId,
            userId,
            ruleCode: ruleCodeFilter,
            createdAt: { gte: since },
          },
        });

        return Number.isInteger(count) && count > 0 ? count : 1;
      },
    });
  }

  private async countRecentTopicFilterViolations(
    chatId: string,
    userId: string,
    ruleCode: string,
  ): Promise<number> {
    const windowMs = TOPIC_FILTER_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000;
    return this.countRecentViolationsWithEscalationCounter({
      chatId,
      userId,
      ruleKey: ruleCode,
      windowMs,
      loadCount: async () => {
        const violationModel = this.prisma.violation as unknown as {
          count?: (args: {
            where: {
              chatId: string;
              userId: string;
              ruleCode: string;
              createdAt: { gte: Date };
            };
          }) => Promise<number>;
        };

        if (typeof violationModel.count !== 'function') {
          return 1;
        }

        const since = await this.resolveViolationResetSince(chatId, userId, windowMs);
        const count = await violationModel.count({
          where: {
            chatId,
            userId,
            ruleCode,
            createdAt: { gte: since },
          },
        });

        return Number.isInteger(count) && count > 0 ? count : 1;
      },
    });
  }

  private async countRecentMessageLimitsViolations(
    chatId: string,
    userId: string,
    ruleCode: string,
  ): Promise<number> {
    const windowMs = MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000;
    return this.countRecentViolationsWithEscalationCounter({
      chatId,
      userId,
      ruleKey: ruleCode,
      windowMs,
      loadCount: async () => {
        const violationModel = this.prisma.violation as unknown as {
          count?: (args: {
            where: {
              chatId: string;
              userId: string;
              ruleCode: string;
              createdAt: { gte: Date };
            };
          }) => Promise<number>;
        };

        if (typeof violationModel.count !== 'function') {
          return 1;
        }

        const since = await this.resolveViolationResetSince(chatId, userId, windowMs);
        const count = await violationModel.count({
          where: {
            chatId,
            userId,
            ruleCode,
            createdAt: { gte: since },
          },
        });

        return Number.isInteger(count) && count > 0 ? count : 1;
      },
    });
  }

  private async resolveViolationResetSince(
    chatId: string,
    userId: string,
    windowMs: number,
  ): Promise<Date> {
    const baseSince = new Date(Date.now() - windowMs);
    const latestManualRelease = await this.resolveLatestManualReleaseCreatedAt(chatId, userId);

    if (latestManualRelease && latestManualRelease.getTime() > baseSince.getTime()) {
      return latestManualRelease;
    }

    return baseSince;
  }

  private async resolveLatestManualReleaseCreatedAt(
    chatId: string,
    userId: string,
  ): Promise<Date | null> {
    const latestManualRelease = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId,
        ruleCode: {
          in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'],
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        createdAt: true,
      },
    });

    return latestManualRelease?.createdAt ?? null;
  }

  private isWithinWindowFromDate(createdAt: Date, windowSec: number): boolean {
    if (!Number.isFinite(windowSec) || windowSec <= 0) {
      return false;
    }

    return createdAt.getTime() + windowSec * 1000 > Date.now();
  }

  private async getActiveMute(
    chatId: string,
    userId: string,
    fallbackMuteDurationHours: number,
  ): Promise<ActiveMute | null> {
    const cachedState = await this.readCachedActiveMute(chatId, userId);
    if (cachedState.status === 'active') {
      return cachedState.mute;
    }
    if (cachedState.status === 'inactive') {
      return null;
    }

    const [latestSanctionEvent, latestManualLiftEvent] = await Promise.all([
      this.prisma.moderationEvent.findFirst({
        where: {
          chatId,
          userId,
          action: {
            in: [SanctionAction.MUTE, SanctionAction.BAN],
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        select: {
          id: true,
          createdAt: true,
          metadata: true,
          action: true,
          ruleCode: true,
        },
      }),
      this.prisma.moderationEvent.findFirst({
        where: {
          chatId,
          userId,
          ruleCode: {
            in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'],
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        select: {
          createdAt: true,
        },
      }),
    ]);

    if (!latestSanctionEvent) {
      await this.rememberInactiveActiveMuteState(chatId, userId);
      return null;
    }

    if (
      latestManualLiftEvent &&
      latestManualLiftEvent.createdAt.getTime() > latestSanctionEvent.createdAt.getTime()
    ) {
      await this.rememberInactiveActiveMuteState(chatId, userId);
      return null;
    }

    const latestAction = latestSanctionEvent.action ?? SanctionAction.BAN;
    const isPermanentMute = this.readPermanentMuteFromMetadata(latestSanctionEvent.metadata);
    const storedDurationHours = this.readStoredMuteDurationHoursFromMetadata(
      latestSanctionEvent.metadata,
    );
    if (latestAction === SanctionAction.MUTE && isPermanentMute) {
      const activeMute = {
        eventId: latestSanctionEvent.id,
        issuedAt: latestSanctionEvent.createdAt,
        expiresAt: null,
        durationHours: null,
        permanent: true,
      };
      await this.rememberActiveMuteState(chatId, userId, activeMute);
      return activeMute;
    }

    const isTimedMute =
      latestAction === SanctionAction.MUTE ||
      (latestAction === SanctionAction.BAN && storedDurationHours !== null);

    if (!isTimedMute) {
      await this.rememberInactiveActiveMuteState(chatId, userId);
      return null;
    }

    const durationHours = storedDurationHours ?? fallbackMuteDurationHours;
    const expiresAt = new Date(
      latestSanctionEvent.createdAt.getTime() + durationHours * 60 * 60 * 1000,
    );
    if (expiresAt.getTime() <= Date.now()) {
      await this.rememberInactiveActiveMuteState(chatId, userId);
      return null;
    }

    const activeMute = {
      eventId: latestSanctionEvent.id,
      issuedAt: latestSanctionEvent.createdAt,
      expiresAt,
      durationHours,
      permanent: false,
    };
    await this.rememberActiveMuteState(chatId, userId, activeMute);
    return activeMute;
  }

  private async handleAdminForwardedModerationCommand(params: {
    update: MaxUpdate;
    chatId: string;
    chatTitle?: string;
    senderId: string;
    senderName?: string;
    messageId: string;
    settings: ChatSettings;
    superBanOnly?: boolean;
  }): Promise<boolean> {
    const { update, chatId, chatTitle, senderId, senderName, messageId, settings, superBanOnly } =
      params;
    const directText = extractDirectIncomingMessageText(update);
    let command: AdminForwardedModerationCommand | null;
    try {
      command = parseAdminForwardedModerationCommand(directText, settings);
    } catch (error: unknown) {
      await this.sendGroupAdminCommandNotice({
        chatId,
        settings,
        text: this.extractGroupAdminCommandErrorMessage(error),
      });
      return true;
    }
    if (!command) {
      return false;
    }
    if (superBanOnly === true && command.action !== 'SUPER_BAN') {
      return false;
    }

    const actor: AuthUser = {
      userId: senderId,
      username: null,
      displayName: senderName?.trim() || null,
      chatId,
      chatTitle: chatTitle?.trim() || null,
    };
    const manualBridge = this.manualModerationCommandBridge;
    if (!manualBridge) {
      this.logger.warn(
        {
          chatId,
          actorUserId: senderId,
          action: command.action,
        },
        'Admin forwarded command ignored: manual moderation service is unavailable',
      );
      return false;
    }

    if (command.action === 'SUPER_BAN' && !manualBridge.isSuperBanDeveloperUserId(senderId)) {
      await this.sendGroupAdminCommandNotice({
        chatId,
        settings,
        text: 'Команда `супер бан` доступна только разработчику бота.',
      });
      return true;
    }

    if (command.action === 'RULES') {
      const rulesCommandHelpText = `\`${getAdminCommandName(
        settings.adminRulesCommandName,
        ADMIN_RULES_COMMAND_NAME_DEFAULT,
      )}\``;
      const sources = extractForwardedRulesSources(update);
      if (sources.length === 0) {
        return false;
      }

      const uniqueSources = dedupeForwardedRulesSources(sources);
      if (uniqueSources.length !== 1) {
        await this.sendGroupAdminCommandNotice({
          chatId,
          settings,
          text: `Перешлите или ответьте на одно сообщение из этого чата и добавьте команду ${rulesCommandHelpText}.`,
        });
        return true;
      }

      const sourceMessage = uniqueSources[0];
      if (sourceMessage.chatId !== chatId) {
        await this.sendGroupAdminCommandNotice({
          chatId,
          settings,
          text: `Команда ${rulesCommandHelpText} работает только для сообщений из этого чата.`,
        });
        return true;
      }

      try {
        await manualBridge.adoptChatRulesFromMessage(
          chatId,
          actor,
          {
            sourceMessageId: sourceMessage.messageId,
            sourceMessageUrl: sourceMessage.url,
            text: sourceMessage.text,
          },
          'group_command',
        );

        await this.deleteAdminCommandMessage(chatId, messageId);
        await this.sendGroupAdminCommandNotice({
          chatId,
          settings,
          text: 'Правила привязаны к этому сообщению. Кнопка «Правила» в нарушениях включена.',
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            actorUserId: senderId,
            sourceMessageId: sourceMessage.messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to adopt forwarded chat rules message',
        );

        await this.sendGroupAdminCommandNotice({
          chatId,
          settings,
          text: `Не удалось сохранить правила: ${this.escapeMaxMarkdownText(
            this.extractGroupAdminCommandErrorMessage(error),
          )}`,
        });
      }

      return true;
    }

    if (command.action === 'SILENCE' || command.action === 'OPEN_CHAT') {
      try {
        const result =
          command.action === 'SILENCE'
            ? await manualBridge.applyManualChatSilenceCommand(
                chatId,
                actor,
                {
                  durationHours: command.silenceDurationHours,
                },
                'group_command',
              )
            : await manualBridge.applyManualOpenChatCommand(chatId, actor, 'group_command');

        await this.deleteAdminCommandMessage(chatId, messageId);
        await this.sendGroupAdminCommandNotice({
          chatId,
          settings,
          text: result.message,
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            actorUserId: senderId,
            action: command.action,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to apply manual chat silence command',
        );

        await this.sendGroupAdminCommandNotice({
          chatId,
          settings,
          text: `Не удалось выполнить команду: ${this.escapeMaxMarkdownText(
            this.extractGroupAdminCommandErrorMessage(error),
          )}`,
        });
      }

      return true;
    }

    const targets = extractForwardedModerationTargets(update, chatId);
    const commandHelpText =
      command.action === 'SUPER_BAN'
        ? '`супер бан`'
        : command.action === 'MUTE'
          ? `\`${getAdminCommandName(
              command.mutePermanent
                ? settings.adminPermanentMuteCommandName
                : settings.adminMuteCommandName,
              command.mutePermanent
                ? ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT
                : ADMIN_MUTE_COMMAND_NAME_DEFAULT,
            )}\``
          : `\`${getAdminCommandName(
              command.fanoutAllChats
                ? settings.adminBanAllCommandName
                : settings.adminBanCommandName,
              command.fanoutAllChats
                ? ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT
                : ADMIN_BAN_COMMAND_NAME_DEFAULT,
            )}\``;
    if (targets.length === 0) {
      await this.sendGroupAdminCommandNotice({
        chatId,
        settings,
        text: `Ответьте на сообщение из этого чата или перешлите его и добавьте команду ${commandHelpText}.`,
      });
      return true;
    }

    const uniqueTargets = dedupeForwardedModerationTargets(targets);
    if (uniqueTargets.length !== 1) {
      await this.sendGroupAdminCommandNotice({
        chatId,
        settings,
        text: `Перешлите или ответьте на одно сообщение из этого чата и добавьте команду ${commandHelpText}.`,
      });
      return true;
    }

    const target = uniqueTargets[0];
    if (target.chatId !== chatId) {
      await this.sendGroupAdminCommandNotice({
        chatId,
        settings,
        text: `Команда ${commandHelpText} работает только для сообщений из этого чата.`,
      });
      return true;
    }

    let commandBotId: string | null = null;
    try {
      commandBotId = this.readExecutionOwnerBotId(update);
      const queued =
        command.action === 'SUPER_BAN'
          ? await manualBridge.enqueueDeveloperSuperBanCommand({
              sourceChatId: chatId,
              commandBotId,
              targetUserId: target.userId,
              targetSenderName: target.senderName ?? null,
              targetMessageId: target.messageId ?? null,
              commandMessageId: messageId,
              actor,
              deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
              deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
            })
          : await manualBridge.enqueueManualGroupModerationCommand({
              sourceChatId: chatId,
              commandBotId,
              targetUserId: target.userId,
              targetSenderName: target.senderName ?? null,
              targetMessageId: target.messageId ?? null,
              commandMessageId: messageId,
              actor,
              action: command.action,
              ...(command.action === 'BAN'
                ? { fanoutAllChats: command.fanoutAllChats === true }
                : {}),
              ...(command.action === 'MUTE'
                ? command.mutePermanent
                  ? { mutePermanent: true }
                  : { muteDurationHours: command.muteDurationHours }
                : {}),
              deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
              deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
            });
      if (!queued) {
        this.logger.warn(
          {
            chatId,
            actorUserId: senderId,
            targetUserId: target.userId,
            action: command.action,
          },
          'Failed to enqueue forwarded admin moderation command',
        );
        if (command.action === 'SUPER_BAN') {
          await this.sendGroupAdminCommandNotice({
            chatId,
            botId: commandBotId,
            settings,
            text: 'Не удалось запустить супер бан. Повторите команду через несколько секунд.',
          });
        }
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          actorUserId: senderId,
          targetUserId: target.userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to enqueue forwarded admin moderation command',
      );

      if (command.action === 'SUPER_BAN') {
        await this.sendGroupAdminCommandNotice({
          chatId,
          botId: commandBotId,
          settings,
          text: `Не удалось запустить супер бан: ${this.escapeMaxMarkdownText(
            this.extractGroupAdminCommandErrorMessage(error),
          )}`,
        });
      }

      return true;
    }

    return true;
  }

  private async deleteAdminCommandMessage(chatId: string, messageId: string): Promise<void> {
    try {
      await this.maxClient.deleteMessage(chatId, messageId, { immediate: true });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to delete handled admin command message',
      );
    }
  }

  private async sendGroupAdminCommandNotice(params: {
    chatId: string;
    botId?: string | null;
    settings: ChatSettings;
    text: string;
  }): Promise<void> {
    try {
      await this.sendBotMessageWithOptionalAutoDelete({
        chatId: params.chatId,
        botId: params.botId ?? undefined,
        text: params.text,
        deleteBotMessagesEnabled: params.settings.deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes: params.settings.deleteBotMessagesDelayMinutes,
        immediate: true,
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: params.chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to send group admin command notice',
      );
    }
  }

  private extractGroupAdminCommandErrorMessage(error: unknown): string {
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      if (typeof response === 'string' && response.trim().length > 0) {
        return response.trim();
      }

      if (response && typeof response === 'object') {
        const message = (response as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim().length > 0) {
          return message.trim();
        }
      }
    }

    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim();
    }

    return 'Попробуйте ещё раз через несколько секунд.';
  }

  private async handleActiveMuteMessage(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    mute: ActiveMute;
  }) {
    const { chatId, userId, messageId, text, createdAt, mute } = params;
    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;

    if (!canDeleteMessage) {
      await this.maxClient.notifyModerators(
        chatId,
        `Сообщение от ${userId} попало под активный мут, но старше 24 часов и не может быть удалено`,
      );
      return;
    }

    try {
      if (await this.deleteMessageImmediately(chatId, messageId)) {
        await this.createBotModerationEvent({
          data: {
            chatId,
            userId,
            messageId,
            eventType: EventType.MESSAGE,
            ruleCode: 'MUTE_ACTIVE_DELETE',
            action: SanctionAction.DELETE_MESSAGE,
            maskedExcerpt: maskText(text),
            score: 1,
            operator: Operator.BOT,
            metadata: {
              reason: 'Message removed during active mute window',
              muteEventId: mute.eventId,
              muteIssuedAt: mute.issuedAt.toISOString(),
              mutePermanent: mute.permanent,
              ...(mute.expiresAt ? { muteExpiresAt: mute.expiresAt.toISOString() } : {}),
              ...(mute.durationHours !== null ? { muteDurationHours: mute.durationHours } : {}),
            },
          },
        });
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to delete message during active mute',
      );
    }
  }

  private async handleBotMessage(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
  }) {
    const { chatId, userId, messageId, text } = params;
    if (this.isKnownRuntimeBotUserId(userId)) {
      this.logger.debug(
        {
          chatId,
          userId,
          messageId,
        },
        'Skipped bot-account moderation for configured MAX bot user',
      );
      return;
    }

    try {
      await this.deleteMessageImmediately(chatId, messageId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to delete bot-authored message before kick',
      );
    }

    try {
      if (await this.kickMemberImmediately(chatId, userId)) {
        await this.createBotModerationEvent({
          data: {
            chatId,
            userId,
            messageId,
            eventType: EventType.MEMBER_ACTION,
            ruleCode: 'BOT_ACCOUNT_KICK',
            action: SanctionAction.KICK,
            maskedExcerpt: maskText(text),
            score: 0.7,
            operator: Operator.BOT,
            metadata: {
              reason: 'Bot account removed because bot accounts are disallowed by chat settings',
            },
          },
        });
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to kick bot-authored account',
      );
    }
  }

  private async handleBotMessageAutoDelete(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    delayMinutes: number;
  }) {
    const { chatId, userId, messageId, text, delayMinutes } = params;
    const safeDelayMinutes = normalizeDeleteBotMessagesDelayMinutes(delayMinutes);

    try {
      await this.maxClient.deleteMessage(chatId, messageId, {
        delayMs: safeDelayMinutes * 60 * 1000,
      });
      await this.createBotModerationEvent({
        data: {
          chatId,
          userId,
          messageId,
          eventType: EventType.MESSAGE,
          ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
          action: SanctionAction.DELETE_MESSAGE,
          maskedExcerpt: maskText(text),
          score: 0.5,
          operator: Operator.BOT,
          metadata: {
            reason: 'Bot-authored message scheduled for delayed auto-delete',
            delayMinutes: safeDelayMinutes,
          },
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          delayMinutes: safeDelayMinutes,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to schedule bot-authored message auto-delete',
      );
    }
  }

  private async handleOwnBotMessageAutoDelete(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    settings: ChatSettings;
  }) {
    const { chatId, userId, messageId, text, settings } = params;

    if (!settings.deleteBotMessagesEnabled) {
      return;
    }

    const skipReason = await this.resolveOwnBotAutoDeleteSkipReason({
      chatId,
      messageId,
      text,
      settings,
    });
    if (skipReason) {
      this.logger.debug(
        {
          chatId,
          messageId,
          skipReason,
        },
        'Skipped auto-delete for own bot message',
      );
      return;
    }

    await this.handleBotMessageAutoDelete({
      chatId,
      userId,
      messageId,
      text,
      delayMinutes: settings.deleteBotMessagesDelayMinutes,
    });
  }

  private async resolveOwnBotAutoDeleteSkipReason(params: {
    chatId: string;
    messageId: string;
    text: string;
    settings: ChatSettings;
  }): Promise<'night_mode_notice' | 'greeting_message' | 'managed_broadcast' | null> {
    if (
      this.isNightModeNoticeMessage({
        text: params.text,
        settings: params.settings,
      })
    ) {
      return 'night_mode_notice';
    }

    const greetingEvent = await this.prisma.moderationEvent?.findFirst?.({
      where: {
        chatId: params.chatId,
        ruleCode: 'GREETING_MESSAGE',
        metadata: {
          path: ['sentMessageId'],
          equals: params.messageId,
        },
      },
      select: {
        id: true,
      },
    });
    if (greetingEvent) {
      return 'greeting_message';
    }

    const managedBroadcastDelivery = await this.prisma.managedBroadcastDelivery?.findFirst?.({
      where: {
        targetChatId: params.chatId,
        remoteMessageId: params.messageId,
      },
      select: {
        id: true,
      },
    });
    if (managedBroadcastDelivery) {
      return 'managed_broadcast';
    }

    return null;
  }

  private async handleServiceBotEvent(params: {
    chatId: string;
    messageId: string;
    text: string;
    update: MaxUpdate;
  }): Promise<string[]> {
    const { chatId, messageId, text, update } = params;
    const botUserIds = this.extractBotUserIdsFromServiceEvent(update);
    const kickedUserIds = new Set<string>();

    for (const userId of botUserIds) {
      if (this.isKnownRuntimeBotUserId(userId)) {
        continue;
      }

      try {
        if (await this.kickMemberImmediately(chatId, userId)) {
          kickedUserIds.add(userId);
          await this.createBotModerationEvent({
            data: {
              chatId,
              userId,
              messageId,
              eventType: EventType.MEMBER_ACTION,
              ruleCode: 'BOT_ACCOUNT_KICK',
              action: SanctionAction.KICK,
              maskedExcerpt: maskText(text),
              score: 0.7,
              operator: Operator.BOT,
              metadata: {
                reason:
                  'Bot account removed from service event because bot accounts are disallowed by chat settings',
              },
            },
          });
        }
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to kick bot account detected in service message',
        );
      }
    }

    return [...kickedUserIds];
  }

  private async handleServiceGreetingEvent(params: {
    chatId: string;
    messageId: string;
    update: MaxUpdate;
    greetingBotMessageEnabled: boolean;
    greetingDeleteBotMessageEnabled: boolean;
    greetingDeleteBotMessageDelayMinutes: number;
    greetingBotMessageText: string;
    botSpeechStyle: BotSpeechStyle | null;
    botSpeechMedia: ChatSettings['botSpeechMedia'];
    greetingBotButtons: unknown;
    greetingBotButtonEnabled: boolean;
    greetingBotButtonUrl: string;
    greetingBotButtonText: string;
    greetingRulesButtonEnabled: boolean;
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    excludedUserIds: ReadonlySet<string>;
  }) {
    const {
      chatId,
      messageId,
      update,
      greetingBotMessageEnabled,
      greetingDeleteBotMessageEnabled,
      greetingDeleteBotMessageDelayMinutes,
      greetingBotMessageText,
      botSpeechStyle,
      botSpeechMedia,
      greetingBotButtons,
      greetingBotButtonEnabled,
      greetingBotButtonUrl,
      greetingBotButtonText,
      greetingRulesButtonEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      excludedUserIds,
    } = params;

    if (!greetingBotMessageEnabled) {
      return;
    }

    const joinedMembers = this.extractHumanServiceMembers(update).filter(
      (member) => !excludedUserIds.has(member.userId),
    );
    if (joinedMembers.length === 0) {
      return;
    }

    const greetingMessageOptions = this.buildBotMessageOptions(
      chatId,
      greetingBotButtons,
      greetingBotButtonEnabled,
      greetingBotButtonUrl,
      greetingBotButtonText,
      greetingRulesButtonEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
    );

    for (const member of joinedMembers) {
      const greetingMessage = this.buildGreetingMessage(
        member.userLabel,
        greetingBotMessageText,
        botSpeechStyle,
      );
      const shouldDeleteGreetingMessage =
        greetingDeleteBotMessageEnabled || deleteBotMessagesEnabled;
      const greetingDeleteDelayMinutes = greetingDeleteBotMessageEnabled
        ? greetingDeleteBotMessageDelayMinutes
        : deleteBotMessagesDelayMinutes;
      try {
        await this.sendBotMessageWithOptionalAutoDelete({
          chatId,
          text: greetingMessage,
          messageOptions: greetingMessageOptions ?? undefined,
          media: this.resolveBotSpeechMedia({ botSpeechMedia }, 'greetingBotMessageText'),
          deleteBotMessagesEnabled: shouldDeleteGreetingMessage,
          deleteBotMessagesDelayMinutes: greetingDeleteDelayMinutes,
        });

        await this.createBotModerationEvent({
          data: {
            chatId,
            userId: member.userId,
            messageId,
            eventType: EventType.SYSTEM,
            ruleCode: 'GREETING_MESSAGE',
            action: SanctionAction.NONE,
            maskedExcerpt: null,
            score: 0.2,
            operator: Operator.BOT,
            metadata: {
              reason: 'Greeting message sent for joined member',
            },
          },
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId: member.userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send greeting message',
        );
      }
    }
  }

  private async handleServiceMembershipUpdate(params: {
    chatId: string;
    messageId: string;
    text: string;
    update: MaxUpdate;
    settings: ChatSettings;
    adminUserIds: string[];
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
  }): Promise<void> {
    const {
      chatId,
      messageId,
      text,
      update,
      settings,
      adminUserIds,
      rulesPublishedUrl,
      rulesPublishedMessageId,
    } = params;

    const excludedGreetingUserIds = new Set<string>();

    if (settings.deleteSpammersEnabled) {
      const kickedUserIds = await this.handleServiceKnownSpammerMembersEvent({
        chatId,
        adminUserIds,
        messageId,
        text,
        update,
      });
      for (const userId of kickedUserIds) {
        excludedGreetingUserIds.add(userId);
      }
    }

    if (settings.removeBotsFromGroupEnabled) {
      const kickedUserIds = await this.handleServiceBotEvent({
        chatId,
        messageId,
        text,
        update,
      });
      for (const userId of kickedUserIds) {
        excludedGreetingUserIds.add(userId);
      }
    }

    await this.handleInvitationAccessMembershipUpdate({
      chatId,
      messageId,
      update,
      settings,
    });

    if (this.isNightModeForceCloseActiveNow(settings) || this.isNightModeActiveNow(settings)) {
      return;
    }

    if (!settings.greetingEnabled) {
      return;
    }

    await this.handleServiceGreetingEvent({
      chatId,
      messageId,
      update,
      greetingBotMessageEnabled: settings.greetingBotMessageEnabled,
      greetingDeleteBotMessageEnabled: settings.greetingDeleteBotMessageEnabled,
      greetingDeleteBotMessageDelayMinutes: settings.greetingDeleteBotMessageDelayMinutes,
      greetingBotMessageText: settings.greetingBotMessageText,
      botSpeechStyle: settings.botSpeechStyle,
      botSpeechMedia: settings.botSpeechMedia,
      greetingBotButtons: settings.greetingBotButtons,
      greetingBotButtonEnabled: settings.greetingBotButtonEnabled,
      greetingBotButtonUrl: settings.greetingBotButtonUrl,
      greetingBotButtonText: settings.greetingBotButtonText,
      greetingRulesButtonEnabled: settings.greetingRulesButtonEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
      deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
      excludedUserIds: excludedGreetingUserIds,
    });
  }

  private extractHumanServiceMembers(
    update: MaxUpdate,
  ): Array<{ userId: string; userLabel: string }> {
    const memberRows = this.extractServiceMemberRows(update);
    const members = new Map<string, { userId: string; userLabel: string }>();

    for (const row of memberRows) {
      const userId = this.readUserIdFromEntity(row);
      if (!userId || this.isBotEntity(row) || members.has(userId)) {
        continue;
      }

      const userLabel = this.formatUserLabel(
        this.readDisplayNameFromEntity(row) ?? undefined,
        userId,
      );
      members.set(userId, { userId, userLabel });
    }

    return [...members.values()];
  }

  private readDisplayNameFromEntity(node: Record<string, unknown>): string | null {
    const directCandidates = [
      node.display_name,
      node.displayName,
      node.full_name,
      node.fullName,
      node.name,
      node.nickname,
    ];

    for (const candidate of directCandidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    const firstName = this.readString(
      node.first_name ?? node.firstName ?? node.given_name ?? node.givenName,
    );
    const lastName = this.readString(
      node.last_name ?? node.lastName ?? node.family_name ?? node.familyName,
    );
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
    if (fullName.length > 0) {
      return fullName;
    }

    const username = this.readString(node.username);
    if (username) {
      return username;
    }

    return null;
  }

  private buildGreetingMessage(
    userLabel: string,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'greetingBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        greeting: 'добро пожаловать в чат',
      },
    });
  }

  private async handleKnownSpammerSenderMessage(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
  }): Promise<boolean> {
    const { chatId, userId, messageId, text } = params;
    if (this.isKnownRuntimeBotUserId(userId)) {
      return false;
    }

    const isKnownSpammer = await this.isUserKnownGlobalSpammer(userId, {
      chatId,
      messageId,
      trigger: 'message',
    });
    if (!isKnownSpammer) {
      return false;
    }

    try {
      await this.deleteMessageImmediately(chatId, messageId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to delete message from known global spammer',
      );
    }

    await this.kickAndLogKnownSpammerEvent({
      chatId,
      userId,
      messageId,
      text,
      reason: 'Sender exists in global spammer registry',
    });
    return true;
  }

  private async handleLocalAdminBlockedSenderMessage(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
  }): Promise<boolean> {
    const { chatId, userId, messageId, text } = params;
    if (this.isKnownRuntimeBotUserId(userId)) {
      return false;
    }

    try {
      await this.deleteMessageImmediately(chatId, messageId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to delete message from locally blocked spammer',
      );
    }

    return this.kickAndLogKnownSpammerEvent({
      chatId,
      userId,
      messageId,
      text,
      reason: 'Local admin block for this admin scope',
      ruleCode: 'LOCAL_ADMIN_BLOCK',
    });
  }

  private async handleServiceKnownSpammerMembersEvent(params: {
    chatId: string;
    adminUserIds: string[];
    messageId: string;
    text: string;
    update: MaxUpdate;
  }): Promise<string[]> {
    const { chatId, adminUserIds, messageId, text, update } = params;
    const serviceMemberUserIds = this.extractServiceMemberUserIds(update);
    if (serviceMemberUserIds.length === 0) {
      return [];
    }

    const localAdminDecisions = await this.resolveGlobalSpammerAdminDecisions(
      serviceMemberUserIds,
      adminUserIds,
      {
        chatId,
      },
    );
    const kickedUserIds: string[] = [];
    for (const userId of serviceMemberUserIds) {
      if (this.isKnownRuntimeBotUserId(userId)) {
        continue;
      }
      if (localAdminDecisions.get(userId) !== 'BLOCK') {
        continue;
      }
      const enforced = await this.kickAndLogKnownSpammerEvent({
        chatId,
        userId,
        messageId,
        text,
        reason: 'Member joined via service event and has a local admin block',
        ruleCode: 'LOCAL_ADMIN_BLOCK',
      });
      if (enforced) {
        kickedUserIds.push(userId);
      }
    }

    const rows = await this.prisma.globalSpammer.findMany({
      where: {
        userId: {
          in: serviceMemberUserIds,
        },
        expiresAt: {
          gt: new Date(),
        },
      },
      select: {
        userId: true,
      },
    });
    if (rows.length === 0) {
      return kickedUserIds;
    }

    for (const row of rows) {
      if (this.isKnownRuntimeBotUserId(row.userId)) {
        continue;
      }
      if (kickedUserIds.includes(row.userId)) {
        continue;
      }
      const adminExempt = localAdminDecisions.get(row.userId) === 'ALLOW';
      if (this.globalSpammerIntelligence) {
        const decision = await this.globalSpammerIntelligence.evaluatePolicy({
          chatId,
          userId: row.userId,
          messageId,
          trigger: 'member_join',
          deleteSpammersEnabled: true,
          adminExempt,
          recordDecision: true,
        });
        if (decision.action !== 'DELETE_AND_KICK') {
          continue;
        }
      } else if (adminExempt) {
        continue;
      }
      const enforced = await this.kickAndLogKnownSpammerEvent({
        chatId,
        userId: row.userId,
        messageId,
        text,
        reason: 'Member joined via service event and exists in global spammer registry',
        ruleCode: 'GLOBAL_SPAMMER_KICK',
      });
      if (enforced) {
        kickedUserIds.push(row.userId);
      }
    }

    return kickedUserIds;
  }

  private async kickAndLogKnownSpammerEvent(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    reason: string;
    ruleCode?: string;
  }): Promise<boolean> {
    const { chatId, userId, messageId, text, reason, ruleCode = 'GLOBAL_SPAMMER_KICK' } = params;
    if (this.isKnownRuntimeBotUserId(userId)) {
      return false;
    }

    try {
      if (await this.kickMemberImmediately(chatId, userId)) {
        await this.createBotModerationEvent({
          data: {
            chatId,
            userId,
            messageId,
            eventType: EventType.MEMBER_ACTION,
            ruleCode,
            action: SanctionAction.KICK,
            maskedExcerpt: maskText(text),
            score: 0.95,
            operator: Operator.BOT,
            metadata: {
              reason,
            },
          },
        });
        return true;
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to kick known global spammer',
      );
    }
    return false;
  }

  private async trackAndRegisterGlobalSpammer(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    deleteSpammersEnabled: boolean;
    exemptFromEnforcement: boolean;
    allowDestructiveSideEffects?: () => boolean;
  }): Promise<GlobalSpammerTrackingResult> {
    const baseResult: GlobalSpammerTrackingResult = {
      handled: false,
      skipKnownSpammerCheck: false,
    };
    if (!this.redisCounter) {
      return baseResult;
    }

    const {
      chatId,
      userId,
      messageId,
      text,
      deleteSpammersEnabled,
      exemptFromEnforcement,
      allowDestructiveSideEffects,
    } = params;
    if (this.isKnownRuntimeBotUserId(userId)) {
      return baseResult;
    }

    if (this.hasRecentLocalGlobalSpammerChatObservation(chatId, userId)) {
      return baseResult;
    }

    try {
      const uniqueChatsState = await this.redisCounter.addToSetWithTtl(
        this.buildGlobalSpammerAnyRedisKey(userId),
        chatId,
        GLOBAL_SPAMMER_REDIS_TTL_SEC,
      );
      this.markLocalGlobalSpammerChatObservation(chatId, userId);

      if (!uniqueChatsState.added) {
        return baseResult;
      }

      if (uniqueChatsState.size >= GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS) {
        const episodeLockKey = this.buildGlobalSpammerFanoutEpisodeLockRedisKey(userId);
        const lockState = await this.redisCounter.addToSetWithTtl(
          episodeLockKey,
          'active',
          GLOBAL_SPAMMER_EPISODE_LOCK_TTL_SEC,
        );
        if (!lockState.added && uniqueChatsState.size < GLOBAL_SPAMMER_CRITICAL_FANOUT_MIN_CHATS) {
          return baseResult;
        }

        const episodeCounterKey = this.buildGlobalSpammerFanoutEpisodeRedisKey(userId);
        const fanoutEpisodeCount = lockState.added
          ? await this.redisCounter.incrementWithTtl(
              episodeCounterKey,
              GLOBAL_SPAMMER_FANOUT_EPISODE_WINDOW_SEC,
            )
          : await this.readGlobalSpammerFanoutEpisodeCount(episodeCounterKey);
        const fanoutReason = this.resolveGlobalSpammerFanoutEpisodeReason({
          uniqueChats: uniqueChatsState.size,
          fanoutEpisodeCount,
        });
        await this.upsertGlobalSpammerEntry({
          userId,
          sourceChatId: chatId,
          reason: fanoutReason,
          evidence: {
            uniqueChats: uniqueChatsState.size,
            windowSec: GLOBAL_SPAMMER_WINDOW_SEC,
            fanoutEpisodeCount,
            fanoutEpisodeWindowSec: GLOBAL_SPAMMER_FANOUT_EPISODE_WINDOW_SEC,
          },
        });
        const shouldCheckKnownSpammer =
          fanoutReason === 'FANOUT_EPISODE_CONFIRMED' || fanoutReason === 'FANOUT_EPISODE_CRITICAL';
        if (
          deleteSpammersEnabled &&
          !exemptFromEnforcement &&
          shouldCheckKnownSpammer &&
          (!this.globalSpammerIntelligence ||
            (await this.isUserKnownGlobalSpammer(userId, { chatId, messageId, trigger: 'fanout' })))
        ) {
          if (allowDestructiveSideEffects && !allowDestructiveSideEffects()) {
            void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
              stage: 'global-spammer-track.side-effect.skipped-after-timeout',
              outcome: 'skip',
              failOpen: true,
            });
            this.logger.debug(
              {
                chatId,
                userId,
                messageId,
              },
              'Skipped detected global spammer destructive side effect after hot-path budget expired',
            );
            return {
              handled: false,
              skipKnownSpammerCheck: true,
            };
          }

          this.runGlobalSpammerSideEffect(
            { chatId, userId, messageId, action: 'delete-and-kick-detected' },
            async () =>
              this.deleteAndKickDetectedGlobalSpammer({
                chatId,
                userId,
                messageId,
                text,
                reason: 'Detected in 6 unique chats within 2 minutes',
              }),
          );
          return {
            handled: true,
            skipKnownSpammerCheck: true,
          };
        }

        return {
          handled: false,
          skipKnownSpammerCheck: deleteSpammersEnabled && shouldCheckKnownSpammer,
        };
      }

      return {
        handled: false,
        skipKnownSpammerCheck: false,
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to track global spammer state',
      );
      return baseResult;
    }
  }

  private async trackAndRegisterGlobalSpammerWithHotPathBudget(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    deleteSpammersEnabled: boolean;
    exemptFromEnforcement: boolean;
  }): Promise<GlobalSpammerTrackingResult> {
    let timedOut = false;
    const result = await raceWithTimeout({
      operation: () =>
        this.trackAndRegisterGlobalSpammer({
          ...params,
          allowDestructiveSideEffects: () => !timedOut,
        }),
      timeoutMs: GLOBAL_SPAMMER_TRACK_HOT_PATH_TIMEOUT_MS,
      onTimeout: () => {
        timedOut = true;
        return {
          handled: false,
          skipKnownSpammerCheck: false,
        };
      },
    });
    if (timedOut) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'global-spammer-track.budget',
        outcome: 'timeout',
        failOpen: true,
      });
      this.logger.debug(
        {
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
          timeoutMs: GLOBAL_SPAMMER_TRACK_HOT_PATH_TIMEOUT_MS,
        },
        'Global spammer tracking exceeded hot-path budget; continuing fail-open',
      );
    }

    return result;
  }

  private async resolveGlobalSpammerAdminDecisionsWithHotPathBudget(
    userIds: readonly string[],
    adminUserIds: readonly string[] | undefined,
    options: {
      chatId?: string;
      userId?: string | null;
      messageId?: string | null;
    } = {},
  ): Promise<Map<string, LocalGlobalSpammerAdminDecision>> {
    if (
      Array.isArray(adminUserIds) &&
      adminUserIds.length > GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_MAX_ADMIN_IDS
    ) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'global-spammer-exempt.budget',
        outcome: 'skip',
        failOpen: true,
      });
      this.logger.debug(
        {
          chatId: options.chatId ?? null,
          userId: options.userId ?? null,
          messageId: options.messageId ?? null,
          adminCount: adminUserIds.length,
          maxAdminCount: GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_MAX_ADMIN_IDS,
        },
        'Skipped global spammer admin exemption lookup because the admin roster is too large for the hot path',
      );
      return new Map();
    }

    let timedOut = false;
    const result = await raceWithTimeout({
      operation: () =>
        this.resolveGlobalSpammerAdminDecisions(userIds, adminUserIds, {
          chatId: options.chatId,
        }),
      timeoutMs: GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_TIMEOUT_MS,
      onTimeout: () => {
        timedOut = true;
        return new Map<string, LocalGlobalSpammerAdminDecision>();
      },
    });
    if (timedOut) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'global-spammer-exempt.budget',
        outcome: 'timeout',
        failOpen: true,
      });
      this.logger.debug(
        {
          chatId: options.chatId ?? null,
          userId: options.userId ?? null,
          messageId: options.messageId ?? null,
          timeoutMs: GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_TIMEOUT_MS,
        },
        'Global spammer admin exemption lookup exceeded hot-path budget; continuing fail-open',
      );
    }

    return result;
  }

  private runGlobalSpammerSideEffect(
    context: Record<string, unknown>,
    operation: () => Promise<void>,
  ): void {
    void operation().catch((error: unknown) => {
      this.logger.warn(
        {
          ...context,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Global spammer background side effect failed',
      );
    });
  }

  private async deleteAndKickDetectedGlobalSpammer(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    reason: string;
  }): Promise<void> {
    const { chatId, userId, messageId, text, reason } = params;
    if (this.isKnownRuntimeBotUserId(userId)) {
      return;
    }

    try {
      await this.deleteMessageImmediately(chatId, messageId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to delete message from detected global spammer',
      );
    }

    await this.kickAndLogKnownSpammerEvent({
      chatId,
      userId,
      messageId,
      text,
      reason,
    });
  }

  private buildGlobalSpammerSignature(params: {
    text: string;
    update: MaxUpdate;
    mediaFlags: {
      hasPhotoAttachment: boolean;
      hasVideoAttachment: boolean;
      hasFileAttachment: boolean;
      hasVoiceAttachment: boolean;
    };
  }): { kind: 'text' | 'photo' | 'forwarded'; hash: string } | null {
    const { text, update, mediaFlags } = params;
    const normalizedText = this.normalizeSpamText(text);
    const rawRecord = this.asRecord(update.raw);
    const messageNode = rawRecord ? (extractRawMessageNode(rawRecord) ?? rawRecord) : null;
    const forwardedNodes = messageNode ? collectForwardedNodes(messageNode) : [];

    if (forwardedNodes.length > 0) {
      const forwardedTokens = new Set<string>();
      for (const node of forwardedNodes) {
        this.collectSignatureTokens(node, forwardedTokens, {
          mediaOnly: false,
        });
      }
      if (normalizedText.length > 0) {
        forwardedTokens.add(`message_text:${normalizedText}`);
      }
      const hash = this.hashSpamSignature(forwardedTokens);
      if (hash) {
        return { kind: 'forwarded', hash };
      }
    }

    if (mediaFlags.hasPhotoAttachment && messageNode) {
      const photoTokens = new Set<string>();
      this.collectSignatureTokens(messageNode, photoTokens, {
        mediaOnly: true,
      });
      if (normalizedText.length > 0) {
        photoTokens.add(`caption:${normalizedText}`);
      }
      const hash = this.hashSpamSignature(photoTokens);
      if (hash) {
        return { kind: 'photo', hash };
      }
    }

    if (normalizedText.length === 0) {
      return null;
    }

    return {
      kind: 'text',
      hash: createHash('sha256').update(normalizedText).digest('hex').slice(0, 24),
    };
  }

  private hashSpamSignature(tokens: Set<string>): string | null {
    if (tokens.size === 0) {
      return null;
    }

    const normalized = [...tokens]
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .sort();
    if (normalized.length === 0) {
      return null;
    }

    return createHash('sha256').update(normalized.join('\n')).digest('hex').slice(0, 24);
  }

  private normalizeSpamText(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private collectSignatureTokens(
    node: unknown,
    tokens: Set<string>,
    options: {
      mediaOnly: boolean;
    },
    depth = 0,
    mediaContext = false,
  ) {
    if (
      depth > MAX_FORWARD_SCAN_DEPTH ||
      node === null ||
      node === undefined ||
      tokens.size >= 120
    ) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectSignatureTokens(item, tokens, options, depth + 1, mediaContext);
        if (tokens.size >= 120) {
          return;
        }
      }
      return;
    }

    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      if (options.mediaOnly && !mediaContext) {
        return;
      }
      const normalizedValue = this.normalizeSignatureValue(String(node));
      if (!normalizedValue) {
        return;
      }
      tokens.add(`value:${normalizedValue}`);
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    const row = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(row)) {
      const keyLower = key.toLowerCase();
      const nextMediaContext = mediaContext || this.isStableMediaSignatureKey(keyLower);

      if (value && (typeof value === 'object' || Array.isArray(value))) {
        this.collectSignatureTokens(value, tokens, options, depth + 1, nextMediaContext);
        if (tokens.size >= 120) {
          return;
        }
        continue;
      }

      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        continue;
      }

      if (this.shouldSkipSignatureKey(keyLower, nextMediaContext)) {
        continue;
      }

      if (options.mediaOnly && !nextMediaContext) {
        continue;
      }

      const normalizedValue = this.normalizeSignatureValue(String(value));
      if (!normalizedValue) {
        continue;
      }

      tokens.add(`${keyLower}:${normalizedValue}`);
      if (tokens.size >= 120) {
        return;
      }
    }
  }

  private normalizeSignatureValue(value: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalized) {
      return '';
    }

    if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
      try {
        const parsed = new URL(normalized);
        parsed.search = '';
        parsed.hash = '';
        const safeUrl = parsed.toString();
        return safeUrl.slice(0, 512);
      } catch {
        return normalized.slice(0, 512);
      }
    }

    return normalized.slice(0, 512);
  }

  private shouldSkipSignatureKey(key: string, mediaContext: boolean): boolean {
    if (CROSS_CHAT_SPAM_ALWAYS_IGNORED_KEYS.has(key)) {
      return true;
    }

    if ((key === 'id' || key.endsWith('_id')) && !mediaContext) {
      return true;
    }

    return false;
  }

  private isStableMediaSignatureKey(key: string): boolean {
    return (
      key.includes('photo') ||
      key.includes('image') ||
      key.includes('picture') ||
      key.includes('sticker') ||
      key.includes('attachment') ||
      key.includes('media') ||
      key.includes('file') ||
      key.includes('video') ||
      key.includes('voice') ||
      key.includes('audio') ||
      key.includes('url') ||
      key.includes('uri') ||
      key.includes('token') ||
      key.includes('hash') ||
      key.includes('checksum') ||
      key.includes('mime') ||
      key.includes('payload')
    );
  }

  private buildGlobalSpammerSignatureRedisKey(
    userId: string,
    signature: { kind: 'text' | 'photo' | 'forwarded'; hash: string },
  ): string {
    return `global-spammer:sig:v1:${userId}:${signature.kind}:${signature.hash}`;
  }

  private buildGlobalSpammerAnyRedisKey(userId: string): string {
    return `global-spammer:any:v1:${userId}`;
  }

  private buildGlobalSpammerFanoutEpisodeRedisKey(userId: string): string {
    return `global-spammer:fanout-episodes:v2:${userId}`;
  }

  private buildGlobalSpammerFanoutEpisodeLockRedisKey(userId: string): string {
    return `global-spammer:fanout-episode-lock:v2:${userId}`;
  }

  private async readGlobalSpammerFanoutEpisodeCount(key: string): Promise<number> {
    const getString = (this.redisCounter as Partial<RedisCounterService> | undefined)?.getString;
    if (!getString || !this.redisCounter) {
      return 1;
    }
    const raw = await getString.call(this.redisCounter, key);
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  private resolveGlobalSpammerFanoutEpisodeReason(params: {
    uniqueChats: number;
    fanoutEpisodeCount: number;
  }): string {
    if (params.uniqueChats >= GLOBAL_SPAMMER_CRITICAL_FANOUT_MIN_CHATS) {
      return 'FANOUT_EPISODE_CRITICAL';
    }
    if (params.fanoutEpisodeCount >= GLOBAL_SPAMMER_CONFIRMED_FANOUT_EPISODE_THRESHOLD) {
      return 'FANOUT_EPISODE_CONFIRMED';
    }
    if (params.fanoutEpisodeCount >= GLOBAL_SPAMMER_STRONG_FANOUT_EPISODE_THRESHOLD) {
      return 'FANOUT_EPISODE_STRONG';
    }
    if (params.fanoutEpisodeCount >= GLOBAL_SPAMMER_MEDIUM_FANOUT_EPISODE_THRESHOLD) {
      return 'FANOUT_EPISODE_MEDIUM';
    }
    return 'FANOUT_EPISODE_OBSERVED';
  }

  private buildLocalGlobalSpammerChatObservationKey(chatId: string, userId: string): string {
    return `${userId}:${chatId}`;
  }

  private hasRecentLocalGlobalSpammerChatObservation(chatId: string, userId: string): boolean {
    const cacheKey = this.buildLocalGlobalSpammerChatObservationKey(chatId, userId);
    const expiresAtMs = this.globalSpammerLocalChatObservations.get(cacheKey) ?? 0;
    if (expiresAtMs <= Date.now()) {
      this.globalSpammerLocalChatObservations.delete(cacheKey);
      return false;
    }

    return true;
  }

  private markLocalGlobalSpammerChatObservation(chatId: string, userId: string): void {
    this.globalSpammerLocalChatObservations.set(
      this.buildLocalGlobalSpammerChatObservationKey(chatId, userId),
      Date.now() + GLOBAL_SPAMMER_LOCAL_CHAT_OBSERVATION_TTL_MS,
    );
  }

  private async resolveGlobalSpammerExemptUserIds(
    userIds: readonly string[],
    adminUserIds: readonly string[] | undefined,
    options: {
      chatId?: string;
    } = {},
  ): Promise<Set<string>> {
    const decisions = await this.resolveGlobalSpammerAdminDecisions(userIds, adminUserIds, options);
    const exemptUserIds = new Set<string>();
    for (const [userId, decision] of decisions.entries()) {
      if (decision === 'ALLOW') {
        exemptUserIds.add(userId);
      }
    }
    return exemptUserIds;
  }

  private async resolveGlobalSpammerAdminDecisions(
    userIds: readonly string[],
    adminUserIds: readonly string[] | undefined,
    options: {
      chatId?: string;
    } = {},
  ): Promise<Map<string, LocalGlobalSpammerAdminDecision>> {
    if (!Array.isArray(adminUserIds) || adminUserIds.length === 0 || userIds.length === 0) {
      return new Map();
    }

    const normalizedAdminUserIds = [
      ...new Set(adminUserIds.map((item) => item.trim()).filter(Boolean)),
    ].sort();
    const cacheScopeKey = this.buildGlobalSpammerExemptionCacheScopeKey(
      options.chatId ?? null,
      normalizedAdminUserIds,
    );
    const cachedDecisions = new Map<string, LocalGlobalSpammerAdminDecision>();
    const unresolvedUserIds: string[] = [];
    for (const rawUserId of userIds) {
      const normalizedUserId = rawUserId.trim();
      if (!normalizedUserId) {
        continue;
      }

      const cached = this.readGlobalSpammerExemptionCache(cacheScopeKey, normalizedUserId);
      if (cached === null) {
        unresolvedUserIds.push(normalizedUserId);
        continue;
      }
      cachedDecisions.set(normalizedUserId, cached);
    }

    if (unresolvedUserIds.length === 0) {
      return cachedDecisions;
    }

    const decisions = new Map(cachedDecisions);
    const unresolvedLookups = await Promise.all(
      [...new Set(unresolvedUserIds)].map(async (normalizedUserId) => ({
        userId: normalizedUserId,
        decision: await this.enqueueGlobalSpammerExemptionLookupBatch(
          cacheScopeKey,
          normalizedAdminUserIds,
          normalizedUserId,
        ),
      })),
    );

    for (const lookup of unresolvedLookups) {
      if (lookup.decision) {
        decisions.set(lookup.userId, lookup.decision);
      }
    }

    return decisions;
  }

  private enqueueGlobalSpammerExemptionLookupBatch(
    scopeKey: string,
    adminUserIds: readonly string[],
    userId: string,
  ): Promise<LocalGlobalSpammerAdminDecision | null> {
    const cacheKey = `${scopeKey}|${userId}`;
    const inFlight = this.globalSpammerExemptionLookupInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    let batch = this.pendingGlobalSpammerExemptionLookupBatches.get(scopeKey);
    if (!batch) {
      batch = {
        scopeKey,
        adminUserIds: [...adminUserIds],
        lookups: new Map(),
        scheduled: false,
      };
      this.pendingGlobalSpammerExemptionLookupBatches.set(scopeKey, batch);
    }

    const lookupPromise = new Promise<LocalGlobalSpammerAdminDecision | null>((resolve, reject) => {
      batch!.lookups.set(cacheKey, {
        userId,
        resolve,
        reject,
      });
    });

    const trackedLookupPromise = lookupPromise.finally(() => {
      if (this.globalSpammerExemptionLookupInFlight.get(cacheKey) === trackedLookupPromise) {
        this.globalSpammerExemptionLookupInFlight.delete(cacheKey);
      }
    });

    this.globalSpammerExemptionLookupInFlight.set(cacheKey, trackedLookupPromise);

    if (!batch.scheduled) {
      batch.scheduled = true;
      void Promise.resolve().then(() =>
        this.flushPendingGlobalSpammerExemptionLookupBatch(scopeKey),
      );
    }

    return trackedLookupPromise;
  }

  private async flushPendingGlobalSpammerExemptionLookupBatch(scopeKey: string): Promise<void> {
    const batch = this.pendingGlobalSpammerExemptionLookupBatches.get(scopeKey);
    if (!batch) {
      return;
    }

    this.pendingGlobalSpammerExemptionLookupBatches.delete(scopeKey);
    const lookups = [...batch.lookups.values()];
    if (lookups.length === 0) {
      return;
    }

    try {
      const decisions = await this.loadGlobalSpammerExemptionBatch(
        batch.adminUserIds,
        lookups.map((lookup) => lookup.userId),
      );

      for (const lookup of lookups) {
        const decision = decisions.get(lookup.userId) ?? null;
        this.writeGlobalSpammerExemptionCache(scopeKey, lookup.userId, decision);
        lookup.resolve(decision);
      }
    } catch (error: unknown) {
      for (const lookup of lookups) {
        lookup.reject(error);
      }
    }
  }

  private async loadGlobalSpammerExemptionBatch(
    adminUserIds: readonly string[],
    userIds: readonly string[],
  ): Promise<Map<string, LocalGlobalSpammerAdminDecision>> {
    const normalizedAdminUserIds = [
      ...new Set(adminUserIds.map((item) => item.trim()).filter(Boolean)),
    ].sort();
    const normalizedUserIds = [...new Set(userIds.map((item) => item.trim()).filter(Boolean))];
    const decisions = new Map<string, LocalGlobalSpammerAdminDecision>();
    if (normalizedAdminUserIds.length === 0 || normalizedUserIds.length === 0) {
      return decisions;
    }

    const adminUserVariants = new Set<string>();
    for (const adminUserId of normalizedAdminUserIds) {
      for (const variant of this.buildUserIdVariants(adminUserId)) {
        adminUserVariants.add(variant);
      }
    }
    if (adminUserVariants.size === 0) {
      return decisions;
    }

    const userIdVariants = new Set<string>();
    const variantToUserIds = new Map<string, Set<string>>();
    for (const normalizedUserId of normalizedUserIds) {
      for (const variant of this.buildUserIdVariants(normalizedUserId)) {
        userIdVariants.add(variant);
        const matchingUserIds = variantToUserIds.get(variant) ?? new Set<string>();
        matchingUserIds.add(normalizedUserId);
        variantToUserIds.set(variant, matchingUserIds);
      }
    }
    if (userIdVariants.size === 0) {
      return decisions;
    }

    const prismaWithAdminGlobalSpammerExemption = this.prisma as unknown as {
      adminGlobalSpammerExemption?: {
        findMany?: (args: {
          where: {
            adminUserId: { in: string[] };
            userId: { in: string[] };
          };
          select: { userId: true; decision: true; updatedAt: true };
        }) => Promise<Array<{ userId: string; decision?: string | null; updatedAt?: Date }>>;
      };
    };
    const adminGlobalSpammerExemptionModel =
      prismaWithAdminGlobalSpammerExemption.adminGlobalSpammerExemption ?? {};
    if (typeof adminGlobalSpammerExemptionModel.findMany !== 'function') {
      return decisions;
    }

    const rows = await adminGlobalSpammerExemptionModel.findMany({
      where: {
        adminUserId: {
          in: [...adminUserVariants],
        },
        userId: {
          in: [...userIdVariants],
        },
      },
      select: {
        userId: true,
        decision: true,
        updatedAt: true,
      },
    });

    for (const row of rows) {
      const matchingUserIds = variantToUserIds.get(row.userId);
      if (!matchingUserIds) {
        continue;
      }

      const decision = this.normalizeLocalGlobalSpammerAdminDecision(row.decision) ?? 'ALLOW';
      for (const matchingUserId of matchingUserIds) {
        const currentDecision = decisions.get(matchingUserId);
        decisions.set(
          matchingUserId,
          this.resolveLocalGlobalSpammerAdminDecisionPrecedence(currentDecision, decision),
        );
      }
    }

    return decisions;
  }

  private buildGlobalSpammerExemptionCacheScopeKey(
    chatId: string | null,
    adminUserIds: readonly string[],
  ): string {
    return `${chatId?.trim() || 'global'}|${adminUserIds.join(',')}`;
  }

  private readGlobalSpammerExemptionCache(
    scopeKey: string,
    userId: string,
  ): LocalGlobalSpammerAdminDecision | null {
    const cacheKey = `${scopeKey}|${userId}`;
    const cached = this.globalSpammerExemptionCache.get(cacheKey);
    if (!cached) {
      return null;
    }
    if (cached.expiresAtMs <= Date.now()) {
      this.globalSpammerExemptionCache.delete(cacheKey);
      return null;
    }

    return cached.decision;
  }

  private writeGlobalSpammerExemptionCache(
    scopeKey: string,
    userId: string,
    decision: LocalGlobalSpammerAdminDecision | null,
  ): void {
    this.globalSpammerExemptionCache.set(`${scopeKey}|${userId}`, {
      expiresAtMs: Date.now() + GLOBAL_SPAMMER_EXEMPTION_CACHE_TTL_MS,
      decision,
    });
  }

  private normalizeLocalGlobalSpammerAdminDecision(
    value: string | null | undefined,
  ): LocalGlobalSpammerAdminDecision | null {
    const normalized = value?.trim().toUpperCase();
    if (normalized === 'ALLOW' || normalized === 'BLOCK' || normalized === 'REVIEW') {
      return normalized;
    }
    return null;
  }

  private resolveLocalGlobalSpammerAdminDecisionPrecedence(
    current: LocalGlobalSpammerAdminDecision | undefined,
    next: LocalGlobalSpammerAdminDecision,
  ): LocalGlobalSpammerAdminDecision {
    if (!current || current === 'REVIEW') {
      return next;
    }
    if (current === 'ALLOW' || next === 'ALLOW') {
      return 'ALLOW';
    }
    return 'BLOCK';
  }

  private async isUserKnownGlobalSpammer(
    userId: string,
    context?: { chatId?: string; messageId?: string; trigger?: string },
  ): Promise<boolean> {
    if (this.isKnownRuntimeBotUserId(userId)) {
      return false;
    }

    if (this.globalSpammerIntelligence) {
      const decision = await this.globalSpammerIntelligence.evaluatePolicy({
        chatId: context?.chatId,
        userId,
        messageId: context?.messageId,
        trigger: context?.trigger ?? 'message',
        deleteSpammersEnabled: true,
        recordDecision: Boolean(context),
      });
      return decision.action === 'DELETE_AND_KICK';
    }

    const globalSpammerModel = this.prisma.globalSpammer as unknown as {
      findFirst?: (args: unknown) => Promise<{ userId: string; expiresAt?: Date | null } | null>;
      findUnique?: (args: unknown) => Promise<{ userId: string; expiresAt?: Date | null } | null>;
    };
    const now = new Date();
    const row =
      typeof globalSpammerModel.findFirst === 'function'
        ? await globalSpammerModel.findFirst({
            where: {
              userId,
              expiresAt: {
                gt: now,
              },
            },
            select: {
              userId: true,
            },
          })
        : await globalSpammerModel.findUnique?.({
            where: {
              userId,
            },
            select: {
              userId: true,
              expiresAt: true,
            },
          });
    if (!row) {
      return false;
    }
    if ('expiresAt' in row) {
      return row.expiresAt instanceof Date && row.expiresAt.getTime() > now.getTime();
    }
    return true;
  }

  private async isDeveloperForcedGlobalSpammerCached(userId: string): Promise<boolean> {
    if (this.isKnownRuntimeBotUserId(userId)) {
      return false;
    }
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return false;
    }

    const getString = (this.redisCounter as Partial<RedisCounterService> | undefined)?.getString;
    if (typeof getString === 'function') {
      try {
        if (
          (await getString.call(
            this.redisCounter,
            buildDeveloperForcedGlobalSpammerCacheKey(normalizedUserId),
          )) === '1'
        ) {
          return true;
        }
      } catch (error: unknown) {
        this.logger.debug(
          {
            userId: normalizedUserId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to read developer-forced global spammer cache',
        );
      }
    }

    if (this.hasDeveloperForcedGlobalSpammerMemoryCache(normalizedUserId)) {
      return true;
    }

    if (this.developerForcedGlobalSpammerWarmUntilMs > Date.now()) {
      return false;
    }

    if (typeof getString === 'function') {
      try {
        if (
          (await getString.call(
            this.redisCounter,
            buildDeveloperForcedGlobalSpammerWarmMarkerKey(),
          )) === '1'
        ) {
          this.developerForcedGlobalSpammerWarmUntilMs =
            Date.now() + DEVELOPER_FORCED_GLOBAL_SPAMMER_MEMORY_CACHE_TTL_MS;
          return false;
        }
      } catch (error: unknown) {
        this.logger.debug(
          {
            userId: normalizedUserId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to read developer-forced global spammer warm marker',
        );
      }
    }

    await this.warmDeveloperForcedGlobalSpammerCache();
    return this.hasDeveloperForcedGlobalSpammerMemoryCache(normalizedUserId);
  }

  private async isDeveloperForcedGlobalSpammerCachedWithHotPathBudget(
    userId: string,
    context: {
      chatId?: string | null;
      messageId?: string | null;
    } = {},
  ): Promise<boolean> {
    let timedOut = false;
    const result = await raceWithTimeout({
      operation: () => this.isDeveloperForcedGlobalSpammerCached(userId),
      timeoutMs: DEVELOPER_FORCED_GLOBAL_SPAMMER_HOT_PATH_TIMEOUT_MS,
      onTimeout: () => {
        timedOut = true;
        return false;
      },
    });
    if (timedOut) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'developer-forced-global-spammer.budget',
        outcome: 'timeout',
        failOpen: true,
      });
      this.logger.debug(
        {
          chatId: context.chatId ?? null,
          userId,
          messageId: context.messageId ?? null,
          timeoutMs: DEVELOPER_FORCED_GLOBAL_SPAMMER_HOT_PATH_TIMEOUT_MS,
        },
        'Developer-forced global spammer lookup exceeded hot-path budget; continuing fail-open',
      );
    }

    return result;
  }

  private hasDeveloperForcedGlobalSpammerMemoryCache(userId: string): boolean {
    const expiresAtMs = this.developerForcedGlobalSpammerMemoryCache.get(userId);
    if (!expiresAtMs) {
      return false;
    }
    if (expiresAtMs <= Date.now()) {
      this.developerForcedGlobalSpammerMemoryCache.delete(userId);
      return false;
    }
    return true;
  }

  private async warmDeveloperForcedGlobalSpammerCache(): Promise<void> {
    if (this.developerForcedGlobalSpammerWarmUntilMs > Date.now()) {
      return;
    }
    if (this.developerForcedGlobalSpammerWarmInFlight) {
      await this.developerForcedGlobalSpammerWarmInFlight;
      return;
    }

    const warm = this.loadDeveloperForcedGlobalSpammerCacheFromRegistry();
    this.developerForcedGlobalSpammerWarmInFlight = warm;
    try {
      await warm;
    } finally {
      this.developerForcedGlobalSpammerWarmInFlight = null;
    }
  }

  private async loadDeveloperForcedGlobalSpammerCacheFromRegistry(): Promise<void> {
    const globalSpammerModel = this.prisma.globalSpammer as unknown as {
      findMany?: (args: unknown) => Promise<
        Array<{
          userId: string;
          expiresAt?: Date | null;
          sourceBreakdown?: Prisma.JsonValue | null;
        }>
      >;
    } | null;
    const now = new Date();
    if (typeof globalSpammerModel?.findMany !== 'function') {
      this.developerForcedGlobalSpammerWarmUntilMs =
        Date.now() + DEVELOPER_FORCED_GLOBAL_SPAMMER_MEMORY_CACHE_TTL_MS;
      return;
    }

    try {
      const rows = await globalSpammerModel.findMany({
        where: {
          expiresAt: {
            gt: now,
          },
          sourceBreakdown: {
            path: ['DEVELOPER_FORCED'],
            not: Prisma.JsonNull,
          },
        },
        select: {
          userId: true,
          expiresAt: true,
          sourceBreakdown: true,
        },
      });

      const restoreTasks: Array<Promise<void>> = [];
      for (const row of rows) {
        const normalizedUserId = row.userId.trim();
        if (
          !normalizedUserId ||
          this.isKnownRuntimeBotUserId(normalizedUserId) ||
          !(row.expiresAt instanceof Date) ||
          row.expiresAt.getTime() <= now.getTime() ||
          !this.hasDeveloperForcedGlobalSpammerSource(row.sourceBreakdown)
        ) {
          continue;
        }

        this.developerForcedGlobalSpammerMemoryCache.set(
          normalizedUserId,
          Math.min(
            row.expiresAt.getTime(),
            Date.now() + DEVELOPER_FORCED_GLOBAL_SPAMMER_MEMORY_CACHE_TTL_MS,
          ),
        );
        restoreTasks.push(
          this.rememberDeveloperForcedGlobalSpammer(normalizedUserId, row.expiresAt),
        );
      }

      restoreTasks.push(this.rememberDeveloperForcedGlobalSpammerWarmMarker());
      await Promise.all(restoreTasks);
      this.developerForcedGlobalSpammerWarmUntilMs =
        Date.now() + DEVELOPER_FORCED_GLOBAL_SPAMMER_MEMORY_CACHE_TTL_MS;
    } catch (error: unknown) {
      this.logger.debug(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to warm developer-forced global spammer cache',
      );
      this.developerForcedGlobalSpammerWarmUntilMs =
        Date.now() + Math.min(30_000, DEVELOPER_FORCED_GLOBAL_SPAMMER_MEMORY_CACHE_TTL_MS);
    }
  }

  private async rememberDeveloperForcedGlobalSpammer(
    userId: string,
    expiresAt?: Date | null,
  ): Promise<void> {
    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (typeof setStringWithTtl !== 'function') {
      return;
    }

    const ttlSec =
      expiresAt instanceof Date
        ? Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1_000))
        : DEVELOPER_FORCED_GLOBAL_SPAMMER_CACHE_TTL_SEC;
    try {
      await setStringWithTtl.call(
        this.redisCounter,
        buildDeveloperForcedGlobalSpammerCacheKey(userId),
        '1',
        Math.min(DEVELOPER_FORCED_GLOBAL_SPAMMER_CACHE_TTL_SEC, ttlSec),
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to restore developer-forced global spammer cache',
      );
    }
  }

  private async rememberDeveloperForcedGlobalSpammerWarmMarker(): Promise<void> {
    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (typeof setStringWithTtl !== 'function') {
      return;
    }

    try {
      await setStringWithTtl.call(
        this.redisCounter,
        buildDeveloperForcedGlobalSpammerWarmMarkerKey(),
        '1',
        DEVELOPER_FORCED_GLOBAL_SPAMMER_WARM_MARKER_TTL_SEC,
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to write developer-forced global spammer warm marker',
      );
    }
  }

  private hasDeveloperForcedGlobalSpammerSource(
    sourceBreakdown: Prisma.JsonValue | null | undefined,
  ): boolean {
    return (
      typeof sourceBreakdown === 'object' &&
      sourceBreakdown !== null &&
      !Array.isArray(sourceBreakdown) &&
      Boolean((sourceBreakdown as Prisma.JsonObject).DEVELOPER_FORCED)
    );
  }

  private async upsertGlobalSpammerEntry(params: {
    userId: string;
    sourceChatId: string;
    reason: string;
    evidence?: Prisma.InputJsonValue;
  }) {
    const { userId, sourceChatId, reason, evidence } = params;
    if (this.isKnownRuntimeBotUserId(userId)) {
      return;
    }

    try {
      if (this.globalSpammerIntelligence) {
        const observation = this.resolveGlobalSpammerObservation(params);
        await this.globalSpammerIntelligence.recordObservation(observation);
        return;
      }

      if (
        reason === 'HIGH_FANOUT_5_CHATS_REPEAT' ||
        reason === 'HIGH_FANOUT_6_CHATS_2M' ||
        reason === 'FANOUT_EPISODE_OBSERVED' ||
        reason === 'FANOUT_EPISODE_MEDIUM' ||
        reason === 'FANOUT_EPISODE_STRONG'
      ) {
        return;
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.globalSpammerRegistryTtlMs);
      const sourceBreakdown: Prisma.InputJsonObject = {
        LEGACY_FALLBACK: {
          score: 1,
          rawScore: 1,
          count: 1,
          latestAt: now.toISOString(),
          reasons: [reason],
        },
      };

      await this.prisma.globalSpammer.upsert({
        where: {
          userId,
        },
        create: {
          userId,
          lastReason: reason,
          lastChatId: sourceChatId,
          lastEvidence: evidence ?? Prisma.JsonNull,
          confidenceScore: 1,
          confirmedAt: now,
          expiresAt,
          sourceBreakdown,
        },
        update: {
          detectionsCount: {
            increment: 1,
          },
          lastReason: reason,
          lastChatId: sourceChatId,
          lastEvidence: evidence ?? Prisma.JsonNull,
          confidenceScore: 1,
          confirmedAt: now,
          expiresAt,
          sourceBreakdown,
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId,
          sourceChatId,
          reason,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to upsert global spammer entry',
      );
    }
  }

  private resolveGlobalSpammerObservation(params: {
    userId: string;
    sourceChatId: string;
    reason: string;
    evidence?: Prisma.InputJsonValue;
  }) {
    const sourceAndScore = this.resolveGlobalSpammerObservationSource(params.reason);
    return {
      userId: params.userId,
      source: sourceAndScore.source,
      score: sourceAndScore.score,
      reason: params.reason,
      chatId: params.sourceChatId,
      evidence: params.evidence,
      forceRegistry: sourceAndScore.forceRegistry,
      ttlDays: sourceAndScore.ttlDays,
    };
  }

  private resolveGlobalSpammerObservationSource(reason: string): {
    source: GlobalSpammerObservationSource;
    score: number;
    forceRegistry: boolean;
    ttlDays?: number;
  } {
    if (reason === 'FANOUT_EPISODE_CRITICAL') {
      return { source: 'FANOUT_HIGH', score: 0.97, forceRegistry: true, ttlDays: 21 };
    }
    if (reason === 'FANOUT_EPISODE_CONFIRMED') {
      return { source: 'FANOUT_HIGH', score: 0.94, forceRegistry: true, ttlDays: 21 };
    }
    if (reason === 'FANOUT_EPISODE_STRONG') {
      return { source: 'FANOUT_HIGH', score: 0.82, forceRegistry: false, ttlDays: 21 };
    }
    if (reason === 'FANOUT_EPISODE_MEDIUM') {
      return { source: 'FANOUT_REPEAT', score: 0.68, forceRegistry: false, ttlDays: 14 };
    }
    if (reason === 'FANOUT_EPISODE_OBSERVED' || reason === 'HIGH_FANOUT_6_CHATS_2M') {
      return { source: 'FANOUT_HIGH', score: 0.48, forceRegistry: false, ttlDays: 7 };
    }
    if (reason === 'HIGH_FANOUT_5_CHATS_REPEAT') {
      return { source: 'FANOUT_REPEAT', score: 0.68, forceRegistry: false, ttlDays: 14 };
    }
    if (reason === 'SANCTION_BAN' || reason === 'SANCTION_KICK') {
      return { source: 'SANCTION_BAN', score: 0.74, forceRegistry: false, ttlDays: 21 };
    }
    return { source: 'SANCTION_BAN', score: 0.62, forceRegistry: false, ttlDays: 14 };
  }

  private async handleNightModeMessage(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    nightModeStartTimeMinutes: number;
    nightModeEndTimeMinutes: number;
    nightModeTimezone: string;
  }) {
    const {
      chatId,
      userId,
      messageId,
      text,
      createdAt,
      nightModeStartTimeMinutes,
      nightModeEndTimeMinutes,
      nightModeTimezone,
    } = params;
    const startMinutes = this.normalizeDayMinutes(nightModeStartTimeMinutes, 23 * 60);
    const endMinutes = this.normalizeDayMinutes(nightModeEndTimeMinutes, 8 * 60);
    const timezone = this.normalizeNightModeTimezone(nightModeTimezone);
    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;

    if (canDeleteMessage) {
      try {
        const messageDeleted = await this.deleteMessageImmediately(chatId, messageId);
        if (!messageDeleted) {
          return;
        }
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to delete message during night mode',
        );
        return;
      }

      try {
        await this.createBotModerationEvent({
          data: {
            chatId,
            userId,
            messageId,
            eventType: EventType.MESSAGE,
            ruleCode: 'NIGHT_MODE_DELETE',
            action: SanctionAction.DELETE_MESSAGE,
            maskedExcerpt: maskText(text),
            score: 0.6,
            operator: Operator.BOT,
            metadata: {
              reason: 'Message removed while chat is closed for the night',
              nightModeTimezone: timezone,
              nightModeStartTime: this.formatMinutesAsTime(startMinutes),
              nightModeEndTime: this.formatMinutesAsTime(endMinutes),
            },
          },
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to persist night mode deletion event',
        );
      }
    } else {
      this.logger.debug(
        {
          chatId,
          userId,
          messageId,
        },
        'Skipped night mode deletion for message older than 24 hours',
      );
    }
  }

  private async handleNightModeForceCloseMessage(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    nightModeForceCloseForever: boolean;
    nightModeForceCloseUntil: string;
  }) {
    const { chatId, userId, messageId, text, createdAt } = params;
    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;

    if (canDeleteMessage) {
      try {
        if (await this.deleteMessageImmediately(chatId, messageId)) {
          await this.createBotModerationEvent({
            data: {
              chatId,
              userId,
              messageId,
              eventType: EventType.MESSAGE,
              ruleCode: 'MANUAL_GROUP_CLOSE_DELETE',
              action: SanctionAction.DELETE_MESSAGE,
              maskedExcerpt: maskText(text),
              score: 0.6,
              operator: Operator.BOT,
              metadata: {
                reason: 'Message removed while group is manually closed',
                closeMode: params.nightModeForceCloseForever ? 'forever' : 'timed',
                closeUntil: params.nightModeForceCloseForever
                  ? null
                  : params.nightModeForceCloseUntil,
              },
            },
          });
        }
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to delete message during manual group close',
        );
      }
    } else {
      this.logger.debug(
        {
          chatId,
          userId,
          messageId,
        },
        'Skipped manual group close deletion for message older than 24 hours',
      );
    }
  }

  private async handleRequiredSubscriptionMessage(params: {
    chatId: string;
    userId: string;
    userLabel: string;
    messageId: string;
    text: string;
    createdAt: string;
    degradeMode: boolean;
    hotChatBackoffActive: boolean;
    systemMode: SystemModeSnapshot;
    settings: Pick<
      ChatSettings,
      | 'requiredSubscriptionEnabled'
      | 'requiredSubscriptionChannelIds'
      | 'requiredSubscriptionBotMessageEnabled'
      | 'requiredSubscriptionBotMessageText'
      | 'requiredSubscriptionButtonText'
      | 'requiredSubscriptionAdminContactButtonEnabled'
      | 'requiredSubscriptionAdminContactButtonUrl'
      | 'requiredSubscriptionWarnEnabled'
      | 'requiredSubscriptionWarnMessageText'
      | 'requiredSubscriptionBanEnabled'
      | 'requiredSubscriptionMuteEnabled'
      | 'requiredSubscriptionMuteDurationHours'
      | 'botSpeechStyle'
      | 'botSpeechMedia'
      | 'rulesAttachViolationsEnabled'
      | 'deleteBotMessagesEnabled'
      | 'deleteBotMessagesDelayMinutes'
      | 'muteDurationHours'
    >;
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
    hotPathProfile?: WebhookHotPathProfile | null;
  }): Promise<boolean> {
    if (!isRequiredSubscriptionCurrentlyActive(params.settings)) {
      return false;
    }

    const requiredChannelIds = this.readRequiredSubscriptionChannelIds(
      params.settings.requiredSubscriptionChannelIds,
    );
    if (requiredChannelIds.length === 0) {
      return false;
    }

    const allowInitialRequiredSubscriptionMetadataFetch = !this.chatContextCache;
    const resolvedRequiredChannels = await this.resolveRequiredSubscriptionChannels(
      requiredChannelIds,
      { allowRemoteFetch: allowInitialRequiredSubscriptionMetadataFetch },
    );
    const requiredMembershipChannelIds = resolvedRequiredChannels
      .filter((channel) => channel.checkMembership)
      .map((channel) => channel.id);
    if (requiredMembershipChannelIds.length === 0) {
      return false;
    }

    const resolvedRequiredChannelsById = new Map(
      resolvedRequiredChannels.map((channel) => [channel.id, channel] as const),
    );

    this.markWebhookHotPathStage(params.hotPathProfile, 'required-subscription.membership');
    const membership = await this.resolveRequiredSubscriptionMembershipWithHotPathBudget({
      chatId: params.chatId,
      userId: params.userId,
      requiredChannelIds: requiredMembershipChannelIds,
      hotPathProfile: params.hotPathProfile,
    });
    if (!membership) {
      return false;
    }
    if (membership.missingChannelIds.length === 0) {
      return false;
    }

    const messageAgeMs = Date.now() - new Date(params.createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1_000;
    if (!canDeleteMessage) {
      this.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
        },
        'Required subscription violation arrived too late to delete message',
      );
      return false;
    }

    const messageDeleted = await this.deleteMessageImmediately(params.chatId, params.messageId);
    this.markWebhookHotPathStage(params.hotPathProfile, 'required-subscription.delete');
    if (messageDeleted) {
      this.markWebhookHotPathSuccessBoundary(params.hotPathProfile, 'required-subscription.delete');
    }

    const missingChannelIdsNeedingRefresh = allowInitialRequiredSubscriptionMetadataFetch
      ? []
      : membership.missingChannelIds.filter((channelId) => {
          const metadata = resolvedRequiredChannelsById.get(channelId) ?? null;
          return !metadata || !metadata.usable;
        });
    const conservativeRequiredSubscriptionEnforcement =
      membership.unresolvedChannelIds.length > 0;
    const requiredSubscriptionChannelMetadata = {
      channelIds: requiredChannelIds,
      requiredChannelIds,
      missingChannelIds: membership.missingChannelIds,
      unresolvedChannelIds: membership.unresolvedChannelIds,
      terminalChannelIds: membership.terminalChannelIds,
      requiredSubscriptionConservativeEnforcement:
        conservativeRequiredSubscriptionEnforcement,
    };
    const missingChannels = membership.missingChannelIds
      .map((channelId) => resolvedRequiredChannelsById.get(channelId) ?? null)
      .filter((channel): channel is RequiredSubscriptionChannelMetadata => channel !== null);
    const missingChannelTitles = missingChannels
      .map((channel) => this.readRequiredSubscriptionChannelTitle(channel.id, channel.title))
      .filter((title) => title.length > 0);

    this.markWebhookHotPathStage(params.hotPathProfile, 'required-subscription.follow-up');
    const runRequiredSubscriptionFollowUp = async () => {
      await this.prisma.violation.create({
        data: {
          chatId: params.chatId,
          userId: params.userId,
          ruleCode: REQUIRED_SUBSCRIPTION_RULE_CODE,
          score: 1,
        },
      });

      const requiredSubscriptionViolationCount24h =
        await this.countRecentRequiredSubscriptionViolations(params.chatId, params.userId);
      const action = this.resolveRequiredSubscriptionEscalationAction(
        requiredSubscriptionViolationCount24h,
        {
          warnEnabled: params.settings.requiredSubscriptionWarnEnabled,
          banEnabled: params.settings.requiredSubscriptionBanEnabled,
          muteEnabled: params.settings.requiredSubscriptionMuteEnabled,
        },
      );
      if (messageDeleted) {
        await this.createBotModerationEvent({
          data: {
            chatId: params.chatId,
            userId: params.userId,
            messageId: params.messageId,
            eventType: EventType.MESSAGE,
            ruleCode: `${REQUIRED_SUBSCRIPTION_RULE_CODE}_DELETE`,
            action: SanctionAction.DELETE_MESSAGE,
            maskedExcerpt: maskText(params.text),
            score: 1,
            operator: Operator.BOT,
            metadata: {
              action: SanctionAction.DELETE_MESSAGE,
              ...requiredSubscriptionChannelMetadata,
              missingChannelTitles,
            },
          },
        });
      }

      let noticeContextPrepared = false;
      let followUpMissingChannelTitles = missingChannelTitles;
      let requiredSubscriptionMessageOptions: MaxSendMessageOptions | undefined;
      const prepareRequiredSubscriptionNoticeContext = async () => {
        if (noticeContextPrepared) {
          return;
        }

        noticeContextPrepared = true;
        const followUpMissingChannels = await this.resolveRequiredSubscriptionNoticeChannels({
          channels: missingChannels,
          channelIdsNeedingRefresh: missingChannelIdsNeedingRefresh,
        });
        followUpMissingChannelTitles = followUpMissingChannels
          .map((channel) => this.readRequiredSubscriptionChannelTitle(channel.id, channel.title))
          .filter((title) => title.length > 0);
        requiredSubscriptionMessageOptions =
          this.buildRequiredSubscriptionMessageOptions(
            followUpMissingChannels,
            params.settings.requiredSubscriptionButtonText,
            params.settings.rulesAttachViolationsEnabled,
            params.rulesPublishedUrl,
            params.rulesPublishedMessageId,
          ) ?? undefined;
      };

      const sendRequiredSubscriptionBotMessage = async (
        textValue: string,
        mediaFieldKey?: BotSpeechMediaFieldKey,
      ) => {
        await prepareRequiredSubscriptionNoticeContext();
        return this.sendBotMessageWithOptionalAutoDelete({
          chatId: params.chatId,
          text: this.renderRequiredSubscriptionNoticeHtml(textValue),
          messageOptions: this.withHtmlMessageOptions(requiredSubscriptionMessageOptions),
          media: this.resolveBotSpeechMedia(params.settings, mediaFieldKey),
          deleteBotMessagesEnabled: params.settings.deleteBotMessagesEnabled,
          deleteBotMessagesDelayMinutes: params.settings.deleteBotMessagesDelayMinutes,
          bypassNoticeBucket: true,
        });
      };
      const requiredSubscriptionNoticeSkipReason = this.resolveOptionalWebhookStageSkipReason({
        stage: 'required-subscription.notice',
        hotPathProfile: params.hotPathProfile,
        systemMode: params.systemMode,
        hotChatBackoffActive: params.hotChatBackoffActive,
        minRemainingMs: REQUIRED_SUBSCRIPTION_NOTICE_MIN_REMAINING_MS,
      });
      const canSendRequiredSubscriptionNotice = !requiredSubscriptionNoticeSkipReason;
      if (requiredSubscriptionNoticeSkipReason) {
        this.recordOptionalWebhookStageSkip({
          stage: 'required-subscription.notice',
          reason: requiredSubscriptionNoticeSkipReason,
        });
      }

      if (action === SanctionAction.NONE) {
        if (
          params.settings.requiredSubscriptionBotMessageEnabled &&
          canSendRequiredSubscriptionNotice
        ) {
          const noticeOnCooldown = await this.hasRequiredSubscriptionNoticeCooldown(
            params.chatId,
            params.userId,
          );
          if (!noticeOnCooldown) {
            try {
              await prepareRequiredSubscriptionNoticeContext();
              const noticeSent = await sendRequiredSubscriptionBotMessage(
                await this.appendAdminContactMarkdownLink(
                  params.chatId,
                  this.buildRequiredSubscriptionExplanation(
                    params.userLabel,
                    messageDeleted,
                    followUpMissingChannelTitles,
                    params.settings.requiredSubscriptionBotMessageText,
                    params.settings.botSpeechStyle,
                  ),
                  params.settings.requiredSubscriptionAdminContactButtonEnabled,
                  params.settings.requiredSubscriptionAdminContactButtonUrl,
                ),
                'requiredSubscriptionBotMessageText',
              );
              if (noticeSent) {
                await this.markRequiredSubscriptionNoticeSent(params.chatId, params.userId);
              }
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId: params.chatId,
                  userId: params.userId,
                  messageId: params.messageId,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to send required subscription explanation message',
              );
            }
          }
        }
      } else if (action === SanctionAction.WARN && canSendRequiredSubscriptionNotice) {
        try {
          await sendRequiredSubscriptionBotMessage(
            await this.appendAdminContactMarkdownLink(
              params.chatId,
              this.buildRequiredSubscriptionWarnExplanation(
                params.userLabel,
                followUpMissingChannelTitles,
                params.settings.requiredSubscriptionWarnMessageText,
                params.settings.botSpeechStyle,
              ),
              params.settings.requiredSubscriptionAdminContactButtonEnabled,
              params.settings.requiredSubscriptionAdminContactButtonUrl,
            ),
            'requiredSubscriptionWarnMessageText',
          );
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId: params.chatId,
              userId: params.userId,
              messageId: params.messageId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed to send required subscription warning message',
          );
        }
      }

      if (action === SanctionAction.MUTE || action === SanctionAction.BAN) {
        await prepareRequiredSubscriptionNoticeContext();
      }

      if (action !== SanctionAction.NONE) {
        const requiredSubscriptionBanNoticeText =
          action === SanctionAction.BAN
            ? this.buildRequiredSubscriptionBanExplanation(
                params.userLabel,
                followUpMissingChannelTitles,
                params.settings.requiredSubscriptionMuteDurationHours,
                params.settings.botSpeechStyle,
              )
            : null;
        await this.applySanctionAction({
          chatId: params.chatId,
          userId: params.userId,
          action,
          userLabel: params.userLabel,
          messageId: params.messageId,
          muteDurationHours: params.settings.requiredSubscriptionMuteDurationHours,
          deleteBotMessagesEnabled: params.settings.deleteBotMessagesEnabled,
          deleteBotMessagesDelayMinutes: params.settings.deleteBotMessagesDelayMinutes,
          botMessageOptions:
            requiredSubscriptionBanNoticeText !== null
              ? this.withHtmlMessageOptions(requiredSubscriptionMessageOptions)
              : requiredSubscriptionMessageOptions,
          sanctionNoticeText:
            requiredSubscriptionBanNoticeText !== null
              ? this.renderRequiredSubscriptionNoticeHtml(requiredSubscriptionBanNoticeText)
              : undefined,
          botSpeechStyle: params.settings.botSpeechStyle,
          trackAsGlobalSpammer: false,
        });

        if (action === SanctionAction.MUTE && canSendRequiredSubscriptionNotice) {
          try {
            await sendRequiredSubscriptionBotMessage(
              this.buildRequiredSubscriptionMuteExplanation(
                params.userLabel,
                followUpMissingChannelTitles,
                params.settings.botSpeechStyle,
              ),
            );
          } catch (error: unknown) {
            this.logger.warn(
              {
                chatId: params.chatId,
                userId: params.userId,
                messageId: params.messageId,
                error: error instanceof Error ? error.message : 'Unknown error',
              },
              'Failed to send required subscription mute message',
            );
          }
        }
      }

      await this.createBotModerationEvent({
        data: {
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
          eventType: EventType.MESSAGE,
          ruleCode: REQUIRED_SUBSCRIPTION_RULE_CODE,
          action,
          maskedExcerpt: maskText(params.text),
          score: 1,
          operator: Operator.BOT,
          metadata: {
            action,
            ...requiredSubscriptionChannelMetadata,
            missingChannelTitles: followUpMissingChannelTitles,
            requiredSubscriptionViolationCount24h,
            requiredSubscriptionEscalationWindowHours:
              REQUIRED_SUBSCRIPTION_ESCALATION_WINDOW_HOURS,
          },
        },
      });
    };

    await this.runWebhookFollowUpWithBudget({
      stage: 'required-subscription.follow-up',
      hotPathProfile: params.hotPathProfile,
      chatId: params.chatId,
      userId: params.userId,
      messageId: params.messageId,
      maxWaitMs: REQUIRED_SUBSCRIPTION_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
      minRemainingMs: REQUIRED_SUBSCRIPTION_FOLLOW_UP_DETACH_MIN_REMAINING_MS,
      task: runRequiredSubscriptionFollowUp,
    });

    return true;
  }

  private async handleInvitationAccessMembershipUpdate(params: {
    chatId: string;
    messageId: string;
    update: MaxUpdate;
    settings: Pick<ChatSettings, 'invitationAccessEnabled' | 'invitationAccessRequiredCount'>;
  }): Promise<void> {
    if (!isInvitationAccessCurrentlyActive(params.settings)) {
      return;
    }

    if (params.update.membership?.action !== 'added') {
      return;
    }

    const inviterId = this.extractInvitationAccessInviterId(params.update);
    if (!inviterId) {
      return;
    }

    const invitedUserIds = this.extractInvitationAccessJoinedUserIds(params.update, inviterId);
    if (invitedUserIds.length === 0) {
      return;
    }

    const requiredCount = this.normalizeInvitationAccessRequiredCount(
      params.settings.invitationAccessRequiredCount,
    );
    const progress = await this.addInvitationAccessInvites({
      chatId: params.chatId,
      userId: inviterId,
      invitedUserIds,
      requiredCount,
    });

    if (progress.addedInviteeUserIds.length === 0) {
      return;
    }

    await this.createBotModerationEvent({
      data: {
        chatId: params.chatId,
        userId: inviterId,
        messageId: params.messageId,
        eventType: EventType.SYSTEM,
        ruleCode: `${INVITATION_ACCESS_RULE_CODE}_PROGRESS`,
        action: SanctionAction.NONE,
        maskedExcerpt: null,
        score: progress.completed ? 0 : 0.1,
        operator: Operator.BOT,
        metadata: {
          reason: 'Invitation access progress updated',
          addedInviteeUserIds: progress.addedInviteeUserIds,
          invitedUserIds: progress.invitedUserIds,
          invitedCount: progress.invitedCount,
          requiredCount,
          completed: progress.completed,
          completedAt: progress.completedAt?.toISOString() ?? null,
        },
      },
    });
  }

  private async handleInvitationAccessMessage(params: {
    chatId: string;
    userId: string;
    userLabel: string;
    messageId: string;
    text: string;
    createdAt: string;
    hotChatBackoffActive: boolean;
    systemMode: SystemModeSnapshot;
    settings: Pick<
      ChatSettings,
      | 'invitationAccessEnabled'
      | 'invitationAccessRequiredCount'
      | 'invitationAccessBotMessageEnabled'
      | 'invitationAccessBotMessageText'
      | 'invitationAccessAdminContactButtonEnabled'
      | 'invitationAccessAdminContactButtonUrl'
      | 'invitationAccessWarnEnabled'
      | 'invitationAccessWarnMessageText'
      | 'invitationAccessBanEnabled'
      | 'invitationAccessMuteEnabled'
      | 'invitationAccessMuteDurationHours'
      | 'botSpeechStyle'
      | 'botSpeechMedia'
      | 'rulesAttachViolationsEnabled'
      | 'deleteBotMessagesEnabled'
      | 'deleteBotMessagesDelayMinutes'
    >;
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
    hotPathProfile?: WebhookHotPathProfile | null;
  }): Promise<boolean> {
    if (!isInvitationAccessCurrentlyActive(params.settings)) {
      return false;
    }

    const requiredCount = this.normalizeInvitationAccessRequiredCount(
      params.settings.invitationAccessRequiredCount,
    );
    const progress = await this.getInvitationAccessProgress(params.chatId, params.userId);
    if (progress.invitedCount >= requiredCount) {
      return false;
    }

    const messageAgeMs = Date.now() - new Date(params.createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1_000;
    if (!canDeleteMessage) {
      this.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
        },
        'Invitation access violation arrived too late to delete message',
      );
      return false;
    }

    const messageDeleted = await this.deleteMessageImmediately(params.chatId, params.messageId);
    this.markWebhookHotPathStage(params.hotPathProfile, 'invitation-access.delete');

    await this.prisma.violation.create({
      data: {
        chatId: params.chatId,
        userId: params.userId,
        ruleCode: INVITATION_ACCESS_RULE_CODE,
        score: 1,
      },
    });

    const invitationAccessViolationCount24h = await this.countRecentInvitationAccessViolations(
      params.chatId,
      params.userId,
    );
    const action = this.resolveRequiredSubscriptionEscalationAction(
      invitationAccessViolationCount24h,
      {
        warnEnabled: params.settings.invitationAccessWarnEnabled,
        banEnabled: params.settings.invitationAccessBanEnabled,
        muteEnabled: params.settings.invitationAccessMuteEnabled,
      },
    );
    const isFirstInvitationAccessViolation = invitationAccessViolationCount24h === 1;

    if (messageDeleted) {
      await this.createBotModerationEvent({
        data: {
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
          eventType: EventType.MESSAGE,
          ruleCode: `${INVITATION_ACCESS_RULE_CODE}_DELETE`,
          action: SanctionAction.DELETE_MESSAGE,
          maskedExcerpt: maskText(params.text),
          score: 1,
          operator: Operator.BOT,
          metadata: {
            action: SanctionAction.DELETE_MESSAGE,
            invitedCount: progress.invitedCount,
            requiredCount,
            remainingInvites: Math.max(0, requiredCount - progress.invitedCount),
          },
        },
      });
    }

    const invitationAccessMessageOptions =
      this.buildBotMessageOptions(
        params.chatId,
        [],
        false,
        '',
        DEFAULT_BOT_BUTTON_TEXT,
        params.settings.rulesAttachViolationsEnabled,
        params.rulesPublishedUrl,
        params.rulesPublishedMessageId,
      ) ?? undefined;

    const sendInvitationAccessBotMessage = async (
      textValue: string,
      mediaFieldKey?: BotSpeechMediaFieldKey,
    ) =>
      this.sendBotMessageWithOptionalAutoDelete({
        chatId: params.chatId,
        text: textValue,
        messageOptions: invitationAccessMessageOptions,
        media: this.resolveBotSpeechMedia(params.settings, mediaFieldKey),
        deleteBotMessagesEnabled: params.settings.deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes: params.settings.deleteBotMessagesDelayMinutes,
      });
    const invitationAccessNoticeSkipReason = this.resolveOptionalWebhookStageSkipReason({
      stage: 'invitation-access.notice',
      hotPathProfile: params.hotPathProfile,
      systemMode: params.systemMode,
      hotChatBackoffActive: params.hotChatBackoffActive,
      minRemainingMs: REQUIRED_SUBSCRIPTION_NOTICE_MIN_REMAINING_MS,
    });
    const canSendInvitationAccessNotice = !invitationAccessNoticeSkipReason;
    if (invitationAccessNoticeSkipReason) {
      this.recordOptionalWebhookStageSkip({
        stage: 'invitation-access.notice',
        reason: invitationAccessNoticeSkipReason,
      });
    }

    if (action === SanctionAction.NONE) {
      if (
        isFirstInvitationAccessViolation &&
        params.settings.invitationAccessBotMessageEnabled &&
        canSendInvitationAccessNotice
      ) {
        const noticeOnCooldown = await this.hasInvitationAccessNoticeCooldown(
          params.chatId,
          params.userId,
        );
        if (!noticeOnCooldown) {
          try {
            const sent = await sendInvitationAccessBotMessage(
              await this.appendAdminContactMarkdownLink(
                params.chatId,
                this.buildInvitationAccessExplanation(
                  params.userLabel,
                  messageDeleted,
                  requiredCount,
                  progress.invitedCount,
                  params.settings.invitationAccessBotMessageText,
                  params.settings.botSpeechStyle,
                ),
                params.settings.invitationAccessAdminContactButtonEnabled,
                params.settings.invitationAccessAdminContactButtonUrl,
              ),
              'invitationAccessBotMessageText',
            );
            if (sent) {
              await this.markInvitationAccessNoticeSent(params.chatId, params.userId);
            }
          } catch (error: unknown) {
            this.logger.warn(
              {
                chatId: params.chatId,
                userId: params.userId,
                messageId: params.messageId,
                error: error instanceof Error ? error.message : 'Unknown error',
              },
              'Failed to send invitation access explanation message',
            );
          }
        }
      }
    } else if (action === SanctionAction.WARN && canSendInvitationAccessNotice) {
      try {
        await sendInvitationAccessBotMessage(
          await this.appendAdminContactMarkdownLink(
            params.chatId,
            this.buildInvitationAccessWarnExplanation(
              params.userLabel,
              requiredCount,
              progress.invitedCount,
              params.settings.invitationAccessWarnMessageText,
              params.settings.botSpeechStyle,
            ),
            params.settings.invitationAccessAdminContactButtonEnabled,
            params.settings.invitationAccessAdminContactButtonUrl,
          ),
          'invitationAccessWarnMessageText',
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: params.chatId,
            userId: params.userId,
            messageId: params.messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send invitation access warning message',
        );
      }
    }

    if (action !== SanctionAction.NONE) {
      await this.applySanctionAction({
        chatId: params.chatId,
        userId: params.userId,
        action,
        userLabel: params.userLabel,
        messageId: params.messageId,
        muteDurationHours: params.settings.invitationAccessMuteDurationHours,
        deleteBotMessagesEnabled: params.settings.deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes: params.settings.deleteBotMessagesDelayMinutes,
        botMessageOptions: invitationAccessMessageOptions,
        sanctionNoticeText:
          action === SanctionAction.BAN
            ? this.buildInvitationAccessBanExplanation(
                params.userLabel,
                requiredCount,
                progress.invitedCount,
                params.settings.invitationAccessMuteDurationHours,
                params.settings.botSpeechStyle,
              )
            : undefined,
        botSpeechStyle: params.settings.botSpeechStyle,
        trackAsGlobalSpammer: false,
      });

      if (action === SanctionAction.MUTE && canSendInvitationAccessNotice) {
        try {
          await sendInvitationAccessBotMessage(
            this.buildInvitationAccessMuteExplanation(
              params.userLabel,
              requiredCount,
              progress.invitedCount,
              params.settings.botSpeechStyle,
            ),
          );
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId: params.chatId,
              userId: params.userId,
              messageId: params.messageId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed to send invitation access mute message',
          );
        }
      }
    }

    await this.createBotModerationEvent({
      data: {
        chatId: params.chatId,
        userId: params.userId,
        messageId: params.messageId,
        eventType: EventType.MESSAGE,
        ruleCode: INVITATION_ACCESS_RULE_CODE,
        action,
        maskedExcerpt: maskText(params.text),
        score: 1,
        operator: Operator.BOT,
        metadata: {
          action,
          invitedCount: progress.invitedCount,
          requiredCount,
          remainingInvites: Math.max(0, requiredCount - progress.invitedCount),
          invitationAccessViolationCount24h,
          invitationAccessEscalationWindowHours: INVITATION_ACCESS_ESCALATION_WINDOW_HOURS,
        },
      },
    });

    return true;
  }

  private extractInvitationAccessInviterId(update: MaxUpdate): string {
    const membershipInviterId =
      typeof update.membership?.inviterId === 'string' ? update.membership.inviterId.trim() : '';
    if (membershipInviterId) {
      return membershipInviterId;
    }

    const raw = this.asRecord(update.raw);
    if (!raw) {
      return '';
    }

    const data = this.asRecord(raw.data);
    const event = this.asRecord(raw.event);
    const typePayload = typeof update.type === 'string' ? this.asRecord(raw[update.type]) : null;
    const candidates = [
      raw,
      typePayload,
      data,
      data ? this.asRecord(data[update.type]) : null,
      event,
      event ? this.asRecord(event[update.type]) : null,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const actor =
        this.asRecord(candidate.inviter) ??
        this.asRecord(candidate.invited_by) ??
        this.asRecord(candidate.actor) ??
        this.asRecord(candidate.initiator);
      const values = [
        candidate.inviter_id,
        candidate.inviterId,
        candidate.invited_by_id,
        candidate.invitedById,
        candidate.actor_id,
        candidate.actorId,
        candidate.initiator_id,
        candidate.initiatorId,
        actor?.id,
        actor?.user_id,
        actor?.userId,
      ];

      for (const value of values) {
        const userId = this.readScalarId(value);
        if (userId) {
          return userId;
        }
      }
    }

    return '';
  }

  private extractInvitationAccessJoinedUserIds(update: MaxUpdate, inviterId: string): string[] {
    const humanUserIds = this.extractHumanServiceMembers(update).map((member) => member.userId);
    const fallbackUserIds =
      update.membership?.action === 'added' ? (update.membership.memberUserIds ?? []) : [];

    return this.normalizeInvitationAccessInviteeUserIds(
      humanUserIds.length > 0 ? humanUserIds : fallbackUserIds,
      inviterId,
    );
  }

  private normalizeInvitationAccessInviteeUserIds(
    userIds: readonly string[],
    inviterId: string,
  ): string[] {
    const normalizedInviterId = inviterId.trim();
    const uniqueUserIds = new Set<string>();

    for (const value of userIds) {
      const userId = typeof value === 'string' ? value.trim() : '';
      if (!userId || userId === normalizedInviterId) {
        continue;
      }
      uniqueUserIds.add(userId);
    }

    return [...uniqueUserIds];
  }

  private readScalarId(value: unknown): string {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return '';
    }

    return String(value).trim();
  }

  private normalizeInvitationAccessRequiredCount(value: number): number {
    const numericValue = Number.isFinite(value)
      ? Math.trunc(value)
      : INVITATION_ACCESS_REQUIRED_COUNT_MIN;
    return Math.min(
      INVITATION_ACCESS_REQUIRED_COUNT_MAX,
      Math.max(INVITATION_ACCESS_REQUIRED_COUNT_MIN, numericValue),
    );
  }

  private async getInvitationAccessProgress(
    chatId: string,
    userId: string,
  ): Promise<InvitationAccessProgressSnapshot> {
    const delegate = this.getInvitationAccessProgressDelegate(this.prisma);
    if (!delegate?.findUnique) {
      return {
        invitedUserIds: [],
        invitedCount: 0,
        completedAt: null,
      };
    }

    const row = await delegate.findUnique({
      where: { chatId_userId: { chatId, userId } },
      select: { invitedUserIds: true, completedAt: true },
    });

    return this.normalizeInvitationAccessProgressSnapshot(row);
  }

  private async addInvitationAccessInvites(params: {
    chatId: string;
    userId: string;
    invitedUserIds: readonly string[];
    requiredCount: number;
  }): Promise<InvitationAccessProgressUpdateResult> {
    const normalizedInviteeUserIds = this.normalizeInvitationAccessInviteeUserIds(
      params.invitedUserIds,
      params.userId,
    );

    if (normalizedInviteeUserIds.length === 0) {
      const current = await this.getInvitationAccessProgress(params.chatId, params.userId);
      return {
        ...current,
        addedInviteeUserIds: [],
        completed: current.invitedCount >= params.requiredCount,
      };
    }

    return this.runInvitationAccessProgressTransaction(async (client) => {
      const delegate = this.getInvitationAccessProgressDelegate(client);
      if (!delegate?.findUnique || !delegate.create || !delegate.update) {
        return {
          invitedUserIds: [],
          invitedCount: 0,
          completedAt: null,
          addedInviteeUserIds: [],
          completed: false,
        };
      }

      const existing = await delegate.findUnique({
        where: { chatId_userId: { chatId: params.chatId, userId: params.userId } },
        select: { invitedUserIds: true, completedAt: true },
      });
      const existingSnapshot = this.normalizeInvitationAccessProgressSnapshot(existing);
      const existingInviteeUserIds = new Set(existingSnapshot.invitedUserIds);
      const addedInviteeUserIds = normalizedInviteeUserIds.filter(
        (inviteeUserId) => !existingInviteeUserIds.has(inviteeUserId),
      );
      const nextInvitedUserIds = Array.from(
        new Set([...existingSnapshot.invitedUserIds, ...normalizedInviteeUserIds]),
      );
      const completed = nextInvitedUserIds.length >= params.requiredCount;
      const shouldMarkCompleted = completed && !existingSnapshot.completedAt;
      const completedAt = shouldMarkCompleted ? new Date() : existingSnapshot.completedAt;

      const select = { invitedUserIds: true, completedAt: true } as const;
      const row = existing
        ? await delegate.update({
            where: { chatId_userId: { chatId: params.chatId, userId: params.userId } },
            data: {
              invitedUserIds: { set: nextInvitedUserIds },
              ...(shouldMarkCompleted ? { completedAt: completedAt ?? new Date() } : {}),
            },
            select,
          })
        : await delegate.create({
            data: {
              chatId: params.chatId,
              userId: params.userId,
              invitedUserIds: nextInvitedUserIds,
              ...(completedAt ? { completedAt } : {}),
            },
            select,
          });
      const snapshot = this.normalizeInvitationAccessProgressSnapshot(row);

      return {
        ...snapshot,
        addedInviteeUserIds,
        completed: snapshot.invitedCount >= params.requiredCount,
      };
    });
  }

  private async runInvitationAccessProgressTransaction<T>(
    operation: (client: unknown) => Promise<T>,
  ): Promise<T> {
    const prisma = this.prisma as unknown as {
      $transaction?: <R>(
        callback: (client: unknown) => Promise<R>,
        options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
      ) => Promise<R>;
    };

    if (typeof prisma.$transaction !== 'function') {
      return operation(this.prisma);
    }

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error: unknown) {
        if (attempt >= maxAttempts || !this.isPrismaSerializationFailure(error)) {
          throw error;
        }
      }
    }

    return operation(this.prisma);
  }

  private isPrismaSerializationFailure(error: unknown): boolean {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (code === 'P2034') {
      return true;
    }

    const message = error instanceof Error ? error.message : '';
    return message.toLowerCase().includes('could not serialize access');
  }

  private getInvitationAccessProgressDelegate(
    client: unknown,
  ): InvitationAccessProgressDelegate | null {
    const delegate =
      client && typeof client === 'object'
        ? (client as { chatInvitationAccessProgress?: unknown }).chatInvitationAccessProgress
        : null;
    if (!delegate || typeof delegate !== 'object') {
      return null;
    }

    return delegate as InvitationAccessProgressDelegate;
  }

  private normalizeInvitationAccessProgressSnapshot(
    row: { invitedUserIds: string[]; completedAt: Date | null } | null,
  ): InvitationAccessProgressSnapshot {
    const invitedUserIds = Array.from(
      new Set(
        (Array.isArray(row?.invitedUserIds) ? row.invitedUserIds : [])
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter((item) => item.length > 0),
      ),
    );

    return {
      invitedUserIds,
      invitedCount: invitedUserIds.length,
      completedAt: row?.completedAt ?? null,
    };
  }

  private readRequiredSubscriptionChannelIds(value: Prisma.JsonValue): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return Array.from(
      new Set(
        value
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter((item) => item.length > 0),
      ),
    );
  }

  private async resolveRequiredSubscriptionMembershipWithHotPathBudget(params: {
    chatId: string;
    userId: string;
    requiredChannelIds: readonly string[];
    hotPathProfile?: WebhookHotPathProfile | null;
  }): Promise<RequiredSubscriptionMembershipResult | null> {
    const waitMs = this.resolveWebhookFollowUpWaitBudgetMs({
      hotPathProfile: params.hotPathProfile,
      maxWaitMs: REQUIRED_SUBSCRIPTION_MEMBERSHIP_HOT_PATH_TIMEOUT_MS,
      minRemainingMs: REQUIRED_SUBSCRIPTION_MEMBERSHIP_MIN_REMAINING_MS,
    });
    if (waitMs <= 0) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'required-subscription.membership.deferred',
        outcome: 'skip',
        failOpen: true,
      });
      return null;
    }

    let timedOut = false;
    const result = await raceWithTimeout({
      operation: () =>
        this.resolveRequiredSubscriptionMembership(
          params.chatId,
          params.userId,
          params.requiredChannelIds,
        ),
      timeoutMs: waitMs,
      onTimeout: () => {
        timedOut = true;
        return null;
      },
    });
    if (timedOut) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'required-subscription.membership.deferred',
        outcome: 'skip',
        failOpen: true,
      });
      this.logger.debug(
        {
          chatId: params.chatId,
          userId: params.userId,
          channelCount: params.requiredChannelIds.length,
          timeoutMs: waitMs,
        },
        'Required subscription membership checks exceeded hot-path budget; continuing fail-open',
      );
    }

    return result;
  }

  private async resolveRequiredSubscriptionMembership(
    chatId: string,
    userId: string,
    requiredChannelIds: readonly string[],
  ): Promise<RequiredSubscriptionMembershipResult> {
    const membershipChecks = await this.mapWithConcurrency(
      requiredChannelIds,
      this.requiredSubscriptionLookupConcurrency,
      async (channelId) => ({
        channelId,
        resolution: await this.getRequiredSubscriptionMembershipResolution(channelId, userId),
      }),
    );
    const membershipsByChannelId = new Map(
      membershipChecks.map((item) => [item.channelId, item.resolution.membership] as const),
    );
    const terminalChannelIds = new Set(
      membershipChecks
        .filter((item) => item.resolution.terminal)
        .map((item) => item.channelId),
    );
    const unconfirmedChannelIds = membershipChecks
      .filter((item) => item.resolution.membership !== true && !item.resolution.fresh)
      .map((item) => item.channelId);
    if (unconfirmedChannelIds.length > 0) {
      const retriedChecks = await this.mapWithConcurrency(
        unconfirmedChannelIds,
        this.requiredSubscriptionLookupConcurrency,
        async (channelId) => ({
          channelId,
          resolution: await this.getRequiredSubscriptionMembershipResolution(channelId, userId, {
            forceFresh: true,
            allowStaleOnError: false,
          }),
        }),
      );
      for (const retriedCheck of retriedChecks) {
        membershipsByChannelId.set(retriedCheck.channelId, retriedCheck.resolution.membership);
        if (retriedCheck.resolution.terminal) {
          terminalChannelIds.add(retriedCheck.channelId);
        } else {
          terminalChannelIds.delete(retriedCheck.channelId);
        }
      }
    }

    const unresolvedChannelIds = requiredChannelIds.filter(
      (channelId) => membershipsByChannelId.get(channelId) === null,
    );
    for (const channelId of this.resolveRequiredSubscriptionTerminalChannelIds(
      unresolvedChannelIds,
    )) {
      terminalChannelIds.add(channelId);
    }
    const unresolvedNonTerminalChannelIds = unresolvedChannelIds.filter(
      (channelId) => !terminalChannelIds.has(channelId),
    );
    if (unresolvedNonTerminalChannelIds.length > 0) {
      this.logRequiredSubscriptionUnresolved({
        chatId,
        userId,
        unresolvedChannelIds: unresolvedNonTerminalChannelIds,
        terminalChannelIds: [...terminalChannelIds],
        checkedChannelCount: requiredChannelIds.length,
        enforcement: 'conservative',
      });
    }
    const unresolvedTerminalChannelIds = unresolvedChannelIds.filter((channelId) =>
      terminalChannelIds.has(channelId),
    );
    if (unresolvedTerminalChannelIds.length > 0) {
      this.logRequiredSubscriptionUnresolved({
        chatId,
        userId,
        unresolvedChannelIds: unresolvedTerminalChannelIds,
        terminalChannelIds: [...terminalChannelIds],
        checkedChannelCount: requiredChannelIds.length,
        enforcement: 'fail_open',
      });
    }

    const missingChannelIds = requiredChannelIds.filter(
      (channelId) =>
        membershipsByChannelId.get(channelId) !== true && !terminalChannelIds.has(channelId),
    );

    return {
      missingChannelIds,
      unresolvedChannelIds,
      terminalChannelIds: [...terminalChannelIds],
    };
  }

  private resolveRequiredSubscriptionTerminalChannelIds(
    channelIds: readonly string[],
  ): string[] {
    if (!this.membershipLookupService || channelIds.length === 0) {
      return [];
    }

    const lookupService = this.membershipLookupService as Partial<
      Pick<MaxMembershipLookupService, 'getLookupIssue'>
    >;
    if (typeof lookupService.getLookupIssue !== 'function') {
      return [];
    }

    return channelIds.filter(
      (channelId) =>
        lookupService.getLookupIssue?.(channelId, 'moderation_required_subscription')?.kind ===
        'terminal',
    );
  }

  private async resolveRequiredSubscriptionNoticeChannels(params: {
    channels: readonly RequiredSubscriptionChannelMetadata[];
    channelIdsNeedingRefresh: readonly string[];
  }): Promise<RequiredSubscriptionChannelMetadata[]> {
    const channelIdsNeedingRefresh = Array.from(
      new Set(params.channelIdsNeedingRefresh.map((channelId) => channelId.trim()).filter(Boolean)),
    );
    if (channelIdsNeedingRefresh.length === 0) {
      return [...params.channels];
    }

    const refreshedChannels = await this.resolveRequiredSubscriptionChannels(
      channelIdsNeedingRefresh,
      { allowRemoteFetch: true },
    );
    const refreshedChannelsById = new Map(
      refreshedChannels.map((channel) => [channel.id, channel] as const),
    );

    return params.channels.map((channel) => refreshedChannelsById.get(channel.id) ?? channel);
  }

  private logRequiredSubscriptionUnresolved(params: {
    chatId: string;
    userId: string;
    unresolvedChannelIds: string[];
    terminalChannelIds: string[];
    checkedChannelCount: number;
    enforcement: 'conservative' | 'fail_open';
  }): void {
    const cacheKey = [
      params.chatId,
      params.userId,
      ...params.unresolvedChannelIds.slice().sort(),
    ].join(':');
    const now = Date.now();
    const lastLoggedAtMs = this.requiredSubscriptionUnresolvedLogAtMs.get(cacheKey) ?? 0;
    if (now - lastLoggedAtMs < REQUIRED_SUBSCRIPTION_UNRESOLVED_LOG_INTERVAL_MS) {
      return;
    }

    this.requiredSubscriptionUnresolvedLogAtMs.set(cacheKey, now);
    this.logger.warn(
      {
        chatId: params.chatId,
        userId: params.userId,
        unresolvedChannelIds: params.unresolvedChannelIds,
        terminalChannelIds: params.terminalChannelIds,
        checkedChannelCount: params.checkedChannelCount,
      },
      params.enforcement === 'conservative'
        ? 'Required subscription checks remained unresolved after strict retry; enforcing conservatively'
        : 'Required subscription checks hit terminal target access errors after strict retry; failing open',
    );
  }

  private async getRequiredSubscriptionMembership(
    channelId: string,
    userId: string,
    options: RequiredSubscriptionMembershipLookupOptions = {},
  ): Promise<boolean | null> {
    const resolution = await this.getRequiredSubscriptionMembershipResolution(
      channelId,
      userId,
      options,
    );
    return resolution.membership;
  }

  private async getRequiredSubscriptionMembershipResolution(
    channelId: string,
    userId: string,
    options: RequiredSubscriptionMembershipLookupOptions = {},
  ): Promise<RequiredSubscriptionMembershipResolution> {
    if (this.membershipLookupService) {
      const lookupOptions = {
        ...(options.forceFresh ? { forceRefresh: true } : {}),
        ...(options.allowStaleOnError !== undefined
          ? { allowStaleOnError: options.allowStaleOnError }
          : {}),
      };
      const lookupService = this.membershipLookupService as Partial<
        Pick<MaxMembershipLookupService, 'getMembership' | 'getMembershipResolution'>
      >;
      if (typeof lookupService.getMembershipResolution === 'function') {
        const resolution = await lookupService.getMembershipResolution(
          channelId,
          userId,
          'moderation_required_subscription',
          lookupOptions,
        );
        return {
          membership: resolution.membership,
          fresh: resolution.fresh,
          terminal:
            resolution.membership === null &&
            this.isRequiredSubscriptionTerminalLookupIssue(channelId),
        };
      }

      let membership: boolean | null;
      if (options.forceFresh || options.allowStaleOnError !== undefined) {
        membership = await this.membershipLookupService.getMembership(
          channelId,
          userId,
          'moderation_required_subscription',
          lookupOptions,
        );
      } else {
        membership = await this.membershipLookupService.getMembership(
          channelId,
          userId,
          'moderation_required_subscription',
        );
      }
      return {
        membership,
        fresh: options.forceFresh === true && membership !== null,
        terminal:
          membership === null &&
          this.isRequiredSubscriptionTerminalLookupIssue(channelId),
      };
    }

    const allowStaleOnError = options.allowStaleOnError === true;
    const cacheKey = this.buildRequiredSubscriptionMembershipCacheKey(channelId, userId);
    const now = Date.now();
    const memoryCached = this.requiredSubscriptionMembershipCache.get(cacheKey);
    if (options.forceFresh) {
      const lookup = await this.performRequiredSubscriptionMembershipLookup(channelId, userId, {
        allowStaleOnError,
        cachedMembership: memoryCached?.isMember ?? null,
      });
      return {
        membership: lookup.membership,
        fresh: lookup.membership !== null,
        terminal: lookup.terminal,
      };
    }
    if (memoryCached && memoryCached.expiresAt > now) {
      return {
        membership: memoryCached.isMember,
        fresh: memoryCached.fresh,
        terminal: false,
      };
    }

    const cached = await this.redisCounter?.getString(cacheKey);
    if (cached === '1') {
      this.requiredSubscriptionMembershipCache.set(cacheKey, {
        isMember: true,
        fresh: false,
        expiresAt: now + REQUIRED_SUBSCRIPTION_MEMBER_PRESENT_TTL_SEC * 1_000,
      });
      return {
        membership: true,
        fresh: false,
        terminal: false,
      };
    }
    if (cached === '0') {
      this.requiredSubscriptionMembershipCache.set(cacheKey, {
        isMember: false,
        fresh: false,
        expiresAt: now + REQUIRED_SUBSCRIPTION_MEMBER_MISSING_TTL_SEC * 1_000,
      });
      return {
        membership: false,
        fresh: false,
        terminal: false,
      };
    }

    const backoffUntilMs = this.requiredSubscriptionMembershipBackoffUntilMs.get(cacheKey) ?? 0;
    if (backoffUntilMs > now) {
      return {
        membership: allowStaleOnError ? (memoryCached?.isMember ?? null) : null,
        fresh: false,
        terminal: false,
      };
    }

    const inFlight = this.requiredSubscriptionMembershipInFlight.get(cacheKey);
    if (inFlight) {
      const lookup = await inFlight;
      return {
        membership: lookup.membership,
        fresh: lookup.membership !== null,
        terminal: lookup.terminal,
      };
    }

    const lookupPromise = (async () => {
      try {
        const isMember = await this.maxClient.hasChatMember(channelId, userId, {
          trafficClass: 'critical',
          timeoutMs: 2_000,
          sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_MEMBERSHIP,
        });
        const ttlSec = isMember
          ? REQUIRED_SUBSCRIPTION_MEMBER_PRESENT_TTL_SEC
          : REQUIRED_SUBSCRIPTION_MEMBER_MISSING_TTL_SEC;
        this.requiredSubscriptionMembershipCache.set(cacheKey, {
          isMember,
          fresh: true,
          expiresAt: Date.now() + ttlSec * 1_000,
        });
        this.requiredSubscriptionMembershipBackoffUntilMs.delete(cacheKey);
        await this.redisCounter?.setStringWithTtl(cacheKey, isMember ? '1' : '0', ttlSec);
        return {
          membership: isMember,
          terminal: false,
        };
      } catch (error: unknown) {
        const transient = this.isTransientMaxApiLookupError(error);
        if (transient) {
          this.requiredSubscriptionMembershipBackoffUntilMs.set(
            cacheKey,
            Date.now() + REQUIRED_SUBSCRIPTION_LOOKUP_BACKOFF_MS,
          );
        }
        this.logger.warn(
          {
            channelId,
            userId,
            backoffMs: transient ? REQUIRED_SUBSCRIPTION_LOOKUP_BACKOFF_MS : 0,
            statusCode: this.extractStatusCode(error),
            code: this.extractMaxErrorCode(error),
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to resolve required subscription membership',
        );
        return {
          membership: allowStaleOnError ? (memoryCached?.isMember ?? null) : null,
          terminal: !transient && this.isTerminalRequiredSubscriptionLookupError(error),
        };
      }
    })();
    const trackedLookupPromise = lookupPromise.finally(() => {
      if (this.requiredSubscriptionMembershipInFlight.get(cacheKey) === trackedLookupPromise) {
        this.requiredSubscriptionMembershipInFlight.delete(cacheKey);
      }
    });

    this.requiredSubscriptionMembershipInFlight.set(cacheKey, trackedLookupPromise);
    const lookup = await trackedLookupPromise;
    return {
      membership: lookup.membership,
      fresh: lookup.membership !== null,
      terminal: lookup.terminal,
    };
  }

  private async performRequiredSubscriptionMembershipLookup(
    channelId: string,
    userId: string,
    options: {
      allowStaleOnError?: boolean;
      cachedMembership?: boolean | null;
    } = {},
  ): Promise<RequiredSubscriptionMembershipLookupResult> {
    const normalizedChannelId = channelId.trim();
    const normalizedUserId = userId.trim();
    if (!normalizedChannelId || !normalizedUserId) {
      return { membership: null, terminal: false };
    }

    const cacheKey = this.buildRequiredSubscriptionMembershipCacheKey(
      normalizedChannelId,
      normalizedUserId,
    );
    const cachedMembership =
      typeof options.cachedMembership === 'boolean' ? options.cachedMembership : null;
    try {
      const memberAccessRoute = await this.resolveUnifiedBotRoute({
        purpose: 'member_access',
        chatId: normalizedChannelId,
      });
      const botId =
        memberAccessRoute?.botId ??
        (typeof this.maxBotLinkService?.resolveBotIdForMemberAccess === 'function'
          ? await this.maxBotLinkService.resolveBotIdForMemberAccess({
              chatId: normalizedChannelId,
            })
          : await this.resolveChatReadBotId(normalizedChannelId)) ??
        null;
      const lookupOptions = {
        trafficClass: 'critical' as const,
        timeoutMs: 2_000,
        sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_MEMBERSHIP,
        ...(botId ? { botId } : {}),
      };
      const isMember = await this.maxClient.hasChatMember(
        normalizedChannelId,
        normalizedUserId,
        lookupOptions,
      );
      const ttlSec = isMember
        ? REQUIRED_SUBSCRIPTION_MEMBER_PRESENT_TTL_SEC
        : REQUIRED_SUBSCRIPTION_MEMBER_MISSING_TTL_SEC;
      this.requiredSubscriptionMembershipCache.set(cacheKey, {
        isMember,
        fresh: true,
        expiresAt: Date.now() + ttlSec * 1_000,
      });
      this.requiredSubscriptionMembershipBackoffUntilMs.delete(cacheKey);
      await this.redisCounter?.setStringWithTtl(cacheKey, isMember ? '1' : '0', ttlSec);
      return {
        membership: isMember,
        terminal: false,
      };
    } catch (error: unknown) {
      const transient = this.isTransientMaxApiLookupError(error);
      if (transient) {
        this.requiredSubscriptionMembershipBackoffUntilMs.set(
          cacheKey,
          Date.now() + REQUIRED_SUBSCRIPTION_LOOKUP_BACKOFF_MS,
        );
      }
      this.logger.warn(
        {
          channelId: normalizedChannelId,
          userId: normalizedUserId,
          backoffMs: transient ? REQUIRED_SUBSCRIPTION_LOOKUP_BACKOFF_MS : 0,
          statusCode: this.extractStatusCode(error),
          code: this.extractMaxErrorCode(error),
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to resolve required subscription membership',
      );
      return {
        membership: options.allowStaleOnError === true ? cachedMembership : null,
        terminal: !transient && this.isTerminalRequiredSubscriptionLookupError(error),
      };
    }
  }

  private isRequiredSubscriptionTerminalLookupIssue(channelId: string): boolean {
    if (!this.membershipLookupService) {
      return false;
    }

    const lookupService = this.membershipLookupService as Partial<
      Pick<MaxMembershipLookupService, 'getLookupIssue'>
    >;
    if (typeof lookupService.getLookupIssue !== 'function') {
      return false;
    }

    return (
      lookupService.getLookupIssue(channelId, 'moderation_required_subscription')?.kind ===
      'terminal'
    );
  }

  private isTerminalRequiredSubscriptionLookupError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 403 || status === 404) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found') {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return message.includes('bot is not a chat member') || message.includes('chat not found');
  }

  private async resolveRequiredSubscriptionChannels(
    channelIds: readonly string[],
    options: {
      allowRemoteFetch?: boolean;
    } = {},
  ): Promise<RequiredSubscriptionChannelMetadata[]> {
    const allowRemoteFetch = options.allowRemoteFetch === true;
    const resolvedMetadataById = new Map<string, RequiredSubscriptionChannelMetadata>();
    const unresolvedChannelIds: string[] = [];
    for (const channelId of channelIds) {
      const cachedMetadata = this.readCachedRequiredSubscriptionChannelMetadata(
        channelId,
        allowRemoteFetch,
      );
      if (cachedMetadata) {
        resolvedMetadataById.set(channelId, cachedMetadata);
        continue;
      }

      unresolvedChannelIds.push(channelId);
    }

    const persistedChats =
      unresolvedChannelIds.length > 0 && typeof this.prisma.chat.findMany === 'function'
        ? await this.prisma.chat.findMany({
            where: {
              id: {
                in: unresolvedChannelIds,
              },
            },
            select: {
              id: true,
              title: true,
              entityType: true,
            },
          })
        : [];
    const persistedChatsById = new Map(persistedChats.map((chat) => [chat.id, chat] as const));
    const resolvedFreshMetadata = await this.mapWithConcurrency(
      unresolvedChannelIds,
      2,
      async (channelId) => {
        const persistedChat = persistedChatsById.get(channelId) ?? null;
        const cachedChannelHeader = await this.chatContextCache?.getManagedEntityHeader(
          channelId,
          'channel',
        );
        const cachedChatHeader =
          cachedChannelHeader ??
          (await this.chatContextCache?.getManagedEntityHeader(channelId, 'chat'));
        const cached = cachedChannelHeader ?? cachedChatHeader;
        const cachedEntityType = this.readLowerString(cached?.entityType ?? '');
        const cachedTitle = this.readRequiredSubscriptionChannelTitle(
          channelId,
          cached?.title ?? '',
        );
        const cachedLink = this.normalizeBotButtonUrl(cached?.link ?? '');
        const persistedChatLooksLikeChat = persistedChat?.entityType === ChatEntityType.CHAT;
        const cachedLooksLikeChat = cachedEntityType === 'chat';
        const cachedLooksLikeChannel = cachedEntityType === 'channel';
        const fallbackLooksLikeChat =
          cachedLooksLikeChat || (!cachedLooksLikeChannel && persistedChatLooksLikeChat);
        const fallbackTitle =
          cachedTitle ||
          persistedChat?.title?.trim() ||
          (fallbackLooksLikeChat ? `Чат ${channelId}` : `Канал ${channelId}`);
        if (this.isUsableRequiredSubscriptionChannelMetadata(channelId, cachedTitle, cachedLink)) {
          return this.rememberRequiredSubscriptionChannelMetadata({
            id: channelId,
            title: cachedTitle,
            link: cachedLink,
            usable: true,
            checkMembership: true,
          });
        }

        if (!allowRemoteFetch) {
          return this.rememberRequiredSubscriptionChannelMetadata({
            id: channelId,
            title: fallbackTitle,
            link: cachedLink,
            usable: false,
            checkMembership: true,
          });
        }

        try {
          const metadataBotId =
            (typeof cached?.primaryBotId === 'string' && cached.primaryBotId.trim().length > 0
              ? cached.primaryBotId.trim()
              : await this.resolveChatReadBotId(channelId)) ?? null;
          const snapshot = metadataBotId
            ? await this.maxClient.getChatSnapshot(channelId, {
                trafficClass: 'background',
                timeoutMs: 2_500,
                sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
                botId: metadataBotId,
              })
            : await this.maxClient.getChatSnapshot(channelId, {
                trafficClass: 'background',
                timeoutMs: 2_500,
                sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
              });
          const title =
            this.readRequiredSubscriptionChannelTitle(channelId, snapshot.title ?? '') ||
            fallbackTitle;
          const link = this.normalizeBotButtonUrl(snapshot.link ?? '');
          await this.chatContextCache?.setManagedEntityHeader({
            id: channelId,
            title,
            entityType: snapshot.entityType,
            link,
            participantsCount: snapshot.participantsCount,
            primaryBotId: metadataBotId,
            assignedBots: [],
            sharedMode: 'owned',
            accessDiagnostics: {
              state: 'ok',
              lastDetectedAt: null,
              lastCheckedAt: null,
              freshUntil: null,
              source: 'unknown',
              activeBotCount: 0,
              lostBots: [],
            },
            viewerAccess: {
              state: 'checking',
              reason: null,
              checkedAt: null,
              canEdit: false,
            },
          });
          return this.rememberRequiredSubscriptionChannelMetadata({
            id: channelId,
            title,
            link,
            usable: this.isUsableRequiredSubscriptionChannelMetadata(channelId, title, link),
            checkMembership: true,
          });
        } catch (error: unknown) {
          this.logger.warn(
            {
              channelId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed to resolve required subscription channel metadata',
          );
          return this.rememberRequiredSubscriptionChannelMetadata({
            id: channelId,
            title: fallbackTitle,
            link: cachedLink,
            usable: false,
            checkMembership: true,
          });
        }
      },
    );
    for (const metadata of resolvedFreshMetadata) {
      resolvedMetadataById.set(metadata.id, metadata);
    }

    return channelIds
      .map((channelId) => resolvedMetadataById.get(channelId))
      .filter((channel): channel is RequiredSubscriptionChannelMetadata => channel !== undefined);
  }

  private readCachedRequiredSubscriptionChannelMetadata(
    channelId: string,
    allowRemoteFetch: boolean,
  ): RequiredSubscriptionChannelMetadata | null {
    const cached = this.requiredSubscriptionChannelMetadataCache.get(channelId);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.requiredSubscriptionChannelMetadataCache.delete(channelId);
      return null;
    }

    if (allowRemoteFetch && !cached.metadata.usable && cached.metadata.checkMembership) {
      return null;
    }

    return cached.metadata;
  }

  private rememberRequiredSubscriptionChannelMetadata(
    metadata: RequiredSubscriptionChannelMetadata,
  ): RequiredSubscriptionChannelMetadata {
    this.requiredSubscriptionChannelMetadataCache.set(metadata.id, {
      expiresAt: Date.now() + REQUIRED_SUBSCRIPTION_CHANNEL_METADATA_CACHE_TTL_MS,
      metadata,
    });
    return metadata;
  }

  private readRequiredSubscriptionChannelTitle(channelId: string, value: string): string {
    const normalized = value.trim();
    if (!normalized || this.isRequiredSubscriptionFallbackTitle(channelId, normalized)) {
      return '';
    }

    return normalized;
  }

  private isRequiredSubscriptionFallbackTitle(channelId: string, title: string): boolean {
    return (
      title === channelId ||
      title === `Канал ${channelId}` ||
      title === `Чат ${channelId}` ||
      title === `Channel ${channelId}` ||
      title === `Chat ${channelId}`
    );
  }

  private isUsableRequiredSubscriptionChannelMetadata(
    channelId: string,
    title: string,
    link: string | null,
  ): boolean {
    return (
      title.trim().length > 0 &&
      !this.isRequiredSubscriptionFallbackTitle(channelId, title.trim()) &&
      typeof link === 'string' &&
      link.trim().length > 0
    );
  }

  private async hasRequiredSubscriptionNoticeCooldown(
    chatId: string,
    userId: string,
  ): Promise<boolean> {
    const cacheKey = this.buildRequiredSubscriptionNoticeCooldownKey(chatId, userId);
    const cached = await this.redisCounter?.getString(cacheKey);
    return cached === '1';
  }

  private async markRequiredSubscriptionNoticeSent(chatId: string, userId: string): Promise<void> {
    const cacheKey = this.buildRequiredSubscriptionNoticeCooldownKey(chatId, userId);
    await this.redisCounter?.setStringWithTtl(
      cacheKey,
      '1',
      REQUIRED_SUBSCRIPTION_NOTICE_COOLDOWN_SEC,
    );
  }

  private async hasInvitationAccessNoticeCooldown(
    chatId: string,
    userId: string,
  ): Promise<boolean> {
    const cacheKey = this.buildInvitationAccessNoticeCooldownKey(chatId, userId);
    const cached = await this.redisCounter?.getString(cacheKey);
    return cached === '1';
  }

  private async markInvitationAccessNoticeSent(chatId: string, userId: string): Promise<void> {
    const cacheKey = this.buildInvitationAccessNoticeCooldownKey(chatId, userId);
    await this.redisCounter?.setStringWithTtl(cacheKey, '1', INVITATION_ACCESS_NOTICE_COOLDOWN_SEC);
  }

  private buildRequiredSubscriptionMembershipCacheKey(channelId: string, userId: string): string {
    return `required-subscription:member:v1:${channelId}:${userId}`;
  }

  private buildRequiredSubscriptionNoticeCooldownKey(chatId: string, userId: string): string {
    return `required-subscription:notice:v1:${chatId}:${userId}`;
  }

  private buildInvitationAccessNoticeCooldownKey(chatId: string, userId: string): string {
    return `invitation-access:notice:v1:${chatId}:${userId}`;
  }

  private isNightModeActiveNow(settings: {
    nightModeEnabled: boolean;
    nightModeStartTimeMinutes: number;
    nightModeEndTimeMinutes: number;
    nightModeTimezone: string;
  }): boolean {
    if (!settings.nightModeEnabled) {
      return false;
    }

    const startMinutes = this.normalizeDayMinutes(settings.nightModeStartTimeMinutes, 23 * 60);
    const endMinutes = this.normalizeDayMinutes(settings.nightModeEndTimeMinutes, 8 * 60);
    const timezone = this.normalizeNightModeTimezone(settings.nightModeTimezone);
    const currentMinutes = this.getCurrentMinutesInTimeZone(timezone);

    if (currentMinutes === null) {
      return false;
    }

    if (startMinutes === endMinutes) {
      return true;
    }

    if (startMinutes < endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }

    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  private isNightModeForceCloseActiveNow(settings: {
    nightModeForceCloseEnabled: boolean;
    nightModeForceCloseForever: boolean;
    nightModeForceCloseUntil: string;
  }): boolean {
    if (!settings.nightModeForceCloseEnabled) {
      return false;
    }

    if (settings.nightModeForceCloseForever) {
      return true;
    }

    const closeUntilTimestamp = Date.parse(settings.nightModeForceCloseUntil);
    return Number.isFinite(closeUntilTimestamp) && closeUntilTimestamp > Date.now();
  }

  private isBotStartedUpdate(update: MaxUpdate): boolean {
    return this.readLowerString(update.type) === 'bot_started';
  }

  private isMembershipLeaveUpdate(update: MaxUpdate): boolean {
    const normalizedType = this.readLowerString(update.type);
    return normalizedType === 'user_removed' || normalizedType === 'bot_removed';
  }

  private isBotAddedUpdate(update: MaxUpdate): boolean {
    return this.readLowerString(update.type) === 'bot_added';
  }

  private async handleBlockedBotJoin(update: MaxUpdate, chatId: string): Promise<boolean> {
    if (!this.isBotAddedUpdate(update) || !this.blockedJoinChatIds.has(chatId)) {
      return false;
    }

    await this.maxClient.leaveCurrentChat(chatId, { botId: update.botId });
    await this.prisma.chatAdminAllowlist.deleteMany({
      where: {
        chatId,
      },
    });
    await this.chatContextCache?.invalidate(chatId);

    this.logger.warn(
      {
        chatId,
        updateId: update.updateId,
      },
      'Bot left chat from join denylist after bot_added event',
    );
    return true;
  }

  private async handleBotStartedInstruction(update: MaxUpdate, chatId: string) {
    if (!this.shouldSendBotStartedInstruction(update, chatId)) {
      return;
    }

    try {
      if (this.privateControlService) {
        await this.privateControlService.handleBotStarted(update);
      } else {
        await this.sendPrivateMenu(chatId, this.buildPrivateMenuPromptText());
      }
    } catch (error: unknown) {
      const payload = {
        chatId,
        updateId: update.updateId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      if (this.isTerminalWebhookProcessingError(error)) {
        this.logger.debug(
          payload,
          'Skipped bot_started instruction after terminal private dialog error',
        );
        return;
      }

      this.logger.warn(
        {
          ...payload,
        },
        'Failed to send bot_started instruction',
      );
    }
  }

  private shouldSendBotStartedInstruction(update: MaxUpdate, chatId: string): boolean {
    const chatType = this.extractBotStartedChatType(update);
    if (chatType === 'chat') {
      return false;
    }

    const numericChatId = this.parseChatIdAsBigInt(chatId);
    if (numericChatId === null) {
      return false;
    }

    return numericChatId > 0n;
  }

  private extractBotStartedChatType(update: MaxUpdate): string | null {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return null;
    }

    const data = this.asRecord(raw.data);
    const event = this.asRecord(raw.event);
    const candidates = [
      raw,
      this.asRecord(raw.bot_started),
      data,
      data ? this.asRecord(data.bot_started) : null,
      event,
      event ? this.asRecord(event.bot_started) : null,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const chat = this.asRecord(candidate.chat);
      const type = this.readLowerString(
        candidate.chat_type ??
          candidate.chatType ??
          chat?.type ??
          chat?.chat_type ??
          chat?.chatType,
      );
      if (type) {
        return type;
      }
    }

    return null;
  }

  private extractBotStartedStartPayload(update: MaxUpdate): string | null {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return null;
    }

    const data = this.asRecord(raw.data);
    const event = this.asRecord(raw.event);
    const candidates = [
      raw,
      this.asRecord(raw.bot_started),
      data,
      data ? this.asRecord(data.bot_started) : null,
      event,
      event ? this.asRecord(event.bot_started) : null,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const value =
        candidate.start_payload ?? candidate.startPayload ?? candidate.payload ?? candidate.start;

      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }

    return null;
  }

  private parseChatIdAsBigInt(chatId: string): bigint | null {
    if (typeof chatId !== 'string') {
      return null;
    }

    const normalized = chatId.trim();
    if (!/^-?\d+$/.test(normalized)) {
      return null;
    }

    try {
      return BigInt(normalized);
    } catch {
      return null;
    }
  }

  private isPrivateDirectChat(chatId: string): boolean {
    const numericChatId = this.parseChatIdAsBigInt(chatId);
    return numericChatId !== null && numericChatId > 0n;
  }

  private async resolveSharedChatExecutionGuard(
    update: MaxUpdate,
    chatId: string,
  ): Promise<SharedChatExecutionGuard> {
    if (!chatId.trim() || this.isPrivateDirectChat(chatId)) {
      return {
        mode: 'allow',
        activeBotId: this.maxBotContextService?.getActiveBotId() ?? null,
        primaryBotId: null,
        assignedBotIds: [],
        requiresExecutionLock: false,
        lockScope: 'owner',
      };
    }

    const activeBotId = this.maxBotContextService?.getActiveBotId() ?? null;
    if (!activeBotId || !this.maxBotLinkService) {
      return {
        mode: 'allow',
        activeBotId,
        primaryBotId: null,
        assignedBotIds: [],
        requiresExecutionLock: false,
        lockScope: 'owner',
      };
    }

    const executionOwnerBotId = this.readExecutionOwnerBotId(update);
    if (executionOwnerBotId) {
      if (executionOwnerBotId === activeBotId) {
        return {
          mode: 'allow',
          activeBotId,
          primaryBotId: executionOwnerBotId,
          assignedBotIds: [executionOwnerBotId],
          requiresExecutionLock: false,
          lockScope: 'owner',
        };
      }

      const updateType = this.readLowerString(update.type);
      if (updateType === 'bot_added' && this.blockedJoinChatIds.has(chatId)) {
        return {
          mode: 'blocked-join-check-only',
          activeBotId,
          primaryBotId: executionOwnerBotId,
          assignedBotIds: [executionOwnerBotId],
          reason: 'non-primary-bot',
        };
      }

      return {
        mode: 'skip',
        activeBotId,
        primaryBotId: executionOwnerBotId,
        assignedBotIds: [executionOwnerBotId],
        reason: 'non-primary-bot',
      };
    }

    let executionBinding: ChatBotExecutionBinding;
    try {
      executionBinding = await this.executeSharedChatOperationWithGuard(
        () =>
          this.maxBotLinkService!.getChatExecutionBinding({
            chatId,
            activeBotId,
          }),
        this.sharedChatExecutionLookupTimeoutMs,
        {
          operation: 'binding',
          chatId,
          activeBotId,
          updateId: update.updateId,
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          activeBotId,
          updateId: update.updateId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Shared chat execution binding lookup stalled; falling back to a conservative chat-scoped execution lock',
      );
      return {
        mode: 'allow',
        activeBotId,
        primaryBotId: null,
        assignedBotIds: activeBotId ? [activeBotId] : [],
        requiresExecutionLock: true,
        lockScope: 'chat',
      };
    }
    if (executionBinding.shouldHandleGroupUpdate) {
      return {
        mode: 'allow',
        activeBotId: executionBinding.activeBotId,
        primaryBotId: executionBinding.primaryBotId,
        assignedBotIds: executionBinding.assignedBotIds,
        requiresExecutionLock: executionBinding.assignedBotIds.length > 1,
        lockScope: 'owner',
      };
    }

    const updateType = this.readLowerString(update.type);
    const reason =
      executionBinding.activeMembershipStatus === ChatBotMembershipStatus.REMOVED
        ? 'removed-membership'
        : 'non-primary-bot';
    if (updateType === 'bot_added' && this.blockedJoinChatIds.has(chatId)) {
      return {
        mode: 'blocked-join-check-only',
        activeBotId: executionBinding.activeBotId,
        primaryBotId: executionBinding.primaryBotId,
        assignedBotIds: executionBinding.assignedBotIds,
        reason,
      };
    }

    return {
      mode: 'skip',
      activeBotId: executionBinding.activeBotId,
      primaryBotId: executionBinding.primaryBotId,
      assignedBotIds: executionBinding.assignedBotIds,
      reason,
    };
  }

  private logSharedChatExecutionSkip(
    update: MaxUpdate,
    chatId: string,
    guard: Extract<SharedChatExecutionGuard, { mode: 'skip' | 'blocked-join-check-only' }>,
  ): void {
    this.logger.debug(
      {
        chatId,
        updateId: update.updateId,
        updateType: this.readLowerString(update.type),
        activeBotId: guard.activeBotId,
        primaryBotId: guard.primaryBotId,
        assignedBotIds: guard.assignedBotIds,
        reason: guard.reason,
      },
      'Skipped shared chat update for non-primary bot runtime',
    );
  }

  private buildSharedChatExecutionLockKey(
    update: MaxUpdate,
    chatId: string,
    guard: Extract<SharedChatExecutionGuard, { mode: 'allow' }>,
  ): string {
    const updateId =
      typeof update.updateId === 'string' && update.updateId.trim().length > 0
        ? update.updateId.trim()
        : String(update.updateId ?? '').trim();
    const messageId = update.message?.messageId?.trim() ?? '';
    const callbackId = this.extractCallbackId(update)?.trim() ?? '';
    const updateType = this.readLowerString(update.type);
    const discriminator = updateId || callbackId || messageId || `${updateType}:${chatId}`;
    if (guard.lockScope === 'chat') {
      return `shared-chat-execution:v2:chat:${chatId}:${discriminator}`;
    }

    const ownerBotId = guard.primaryBotId ?? guard.activeBotId ?? 'unknown';
    return `shared-chat-execution:v1:${ownerBotId}:${chatId}:${discriminator}`;
  }

  private async acquireSharedChatExecutionLock(
    update: MaxUpdate,
    chatId: string,
    guard: Extract<SharedChatExecutionGuard, { mode: 'allow' }>,
  ): Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null> {
    const key = this.buildSharedChatExecutionLockKey(update, chatId, guard);
    const acquireLock = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.acquireLock;

    if (acquireLock && this.redisCounter) {
      try {
        const token = await this.executeSharedChatOperationWithGuard(
          () => acquireLock.call(this.redisCounter, key, SHARED_CHAT_EXECUTION_LOCK_TTL_MS),
          this.sharedChatExecutionLockTimeoutMs,
          {
            operation: 'lock',
            chatId,
            activeBotId: guard.activeBotId,
            updateId: update.updateId,
            lockKey: key,
          },
        );
        if (!token) {
          return null;
        }

        return {
          key,
          token,
          mode: 'redis',
        };
      } catch (error: unknown) {
        this.logger.warn(
          {
            key,
            chatId,
            updateId: update.updateId,
            activeBotId: guard.activeBotId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to acquire redis shared chat execution lock in time; falling back to memory lock',
        );
      }
    }

    if (this.sharedChatExecutionMemoryLocks.has(key)) {
      return null;
    }

    const token = randomUUID();
    this.sharedChatExecutionMemoryLocks.set(key, token);
    return {
      key,
      token,
      mode: 'memory',
    };
  }

  private async executeSharedChatOperationWithGuard<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    context: {
      operation: 'binding' | 'lock';
      chatId: string;
      activeBotId?: string | null;
      updateId?: string | null;
      lockKey?: string;
    },
  ): Promise<T> {
    const operationPromise = operation();
    operationPromise.catch(() => undefined);

    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeout = setTimeout(() => {
        reject(this.createSharedChatExecutionTimeoutError(context, timeoutMs));
      }, timeoutMs);
      timeout.unref?.();
    });

    try {
      return await Promise.race([operationPromise, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private createSharedChatExecutionTimeoutError(
    context: {
      operation: 'binding' | 'lock';
      chatId: string;
      activeBotId?: string | null;
      updateId?: string | null;
      lockKey?: string;
    },
    timeoutMs: number,
  ): Error {
    const details =
      context.operation === 'lock'
        ? `lock ${context.lockKey ?? 'unknown'}`
        : `binding ${context.chatId}`;
    const error = new Error(
      `Shared chat execution ${details} timed out after ${timeoutMs}ms`,
    ) as Error & { code?: string };
    error.code = 'ECONNABORTED';
    return error;
  }

  private async releaseSharedChatExecutionLock(lock: {
    key: string;
    token: string;
    mode: 'redis' | 'memory';
  }): Promise<void> {
    if (lock.mode === 'memory') {
      if (this.sharedChatExecutionMemoryLocks.get(lock.key) === lock.token) {
        this.sharedChatExecutionMemoryLocks.delete(lock.key);
      }
      return;
    }

    const releaseLock = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.releaseLock;
    if (!releaseLock || !this.redisCounter) {
      return;
    }

    try {
      const releasePromise = Promise.resolve(
        releaseLock.call(this.redisCounter, lock.key, lock.token),
      );
      releasePromise.catch(() => undefined);

      let timeout: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `Shared chat execution release ${lock.key} timed out after ${this.sharedChatExecutionLockTimeoutMs}ms`,
            ),
          );
        }, this.sharedChatExecutionLockTimeoutMs);
        timeout.unref?.();
      });

      try {
        await Promise.race([releasePromise, timeoutPromise]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          key: lock.key,
          timeoutMs: this.sharedChatExecutionLockTimeoutMs,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to release redis shared chat execution lock',
      );
    }
  }

  private readExecutionOwnerBotId(update: MaxUpdate): string | null {
    return readExecutionOwnerBotIdFromUpdate(update);
  }

  private async handlePrivateChatControl(update: MaxUpdate): Promise<void> {
    if (!update.message) {
      return;
    }

    const callbackId = this.extractCallbackId(update);
    const callbackCommand = this.resolvePrivateCallbackCommand(this.extractCallbackPayload(update));
    if (callbackId) {
      await this.answerCallbackSafe(
        callbackId,
        this.buildPrivateCallbackNotification(callbackCommand),
      );
    }

    const { chatId, text, senderId } = update.message;

    if (callbackCommand) {
      await this.executePrivateCommand(chatId, callbackCommand);
      return;
    }

    if (senderId && this.isOwnBotSender(senderId)) {
      return;
    }

    const textCommand = this.resolvePrivateTextCommand(text);
    if (textCommand) {
      await this.executePrivateCommand(chatId, textCommand);
      return;
    }

    if (this.looksLikeSlashCommand(text)) {
      await this.sendPrivateMenu(chatId, 'Управление через кнопки ниже.');
      return;
    }

    await this.sendPrivateMenu(chatId, this.buildPrivateMenuPromptText());
  }

  private buildPrivateCallbackNotification(command: PrivateControlCommand | null): string {
    if (command === 'chats') {
      return 'Собираю список чатов';
    }
    if (command === 'channels') {
      return 'Собираю список каналов';
    }
    if (command === 'help') {
      return 'Открываю меню';
    }
    return 'Открываю меню';
  }

  private async answerCallbackSafe(callbackId: string, notification: string): Promise<void> {
    try {
      await this.maxClient.answerCallback(callbackId, notification, undefined, {
        ignoreFailureMetricStatuses: CALLBACK_TERMINAL_FAILURE_METRIC_STATUSES,
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          callbackId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to answer callback',
      );
    }
  }

  private async handleRulesCallback(
    chatId: string,
    callbackId: string | null,
    sourceMessageId: string | null,
  ): Promise<void> {
    const publishedRules = await this.prisma.chatRules?.findUnique?.({
      where: { chatId },
      select: {
        publishedUrl: true,
        publishedMessageId: true,
      },
    });

    const resolvedUrl = await this.resolveRulesPublishedUrl(
      chatId,
      publishedRules?.publishedUrl ?? null,
      publishedRules?.publishedMessageId ?? null,
    );
    if (!resolvedUrl) {
      if (callbackId) {
        await this.answerCallbackSafe(callbackId, 'Ссылка на правила пока недоступна');
      }
      return;
    }

    try {
      if (sourceMessageId?.trim()) {
        await this.maxClient.editMessageInlineKeyboard(chatId, sourceMessageId, null, {
          button: {
            text: RULES_BOT_BUTTON_TEXT,
            url: resolvedUrl,
          },
        });
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          sourceMessageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to convert legacy rules callback button into direct link',
      );
    }

    if (callbackId) {
      await this.answerCallbackSafe(callbackId, 'Кнопка обновлена. Нажмите ещё раз');
    }
  }

  private extractCallbackNode(update: MaxUpdate): Record<string, unknown> | null {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return null;
    }

    const data = this.asRecord(raw.data);
    const event = this.asRecord(raw.event);
    const candidates = [
      this.asRecord(raw.callback),
      this.asRecord(raw.message_callback),
      data ? this.asRecord(data.callback) : null,
      data ? this.asRecord(data.message_callback) : null,
      event ? this.asRecord(event.callback) : null,
      event ? this.asRecord(event.message_callback) : null,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const nested = this.asRecord(candidate.callback);
      if (nested) {
        return nested;
      }

      if (
        candidate.callback_id !== undefined ||
        candidate.callbackId !== undefined ||
        candidate.payload !== undefined
      ) {
        return candidate;
      }
    }

    return null;
  }

  private extractCallbackId(update: MaxUpdate): string | null {
    const callback = this.extractCallbackNode(update);
    if (!callback) {
      return null;
    }

    const value = callback.callback_id ?? callback.callbackId ?? callback.id;
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }

    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  private extractCallbackPayload(update: MaxUpdate): string | null {
    const callback = this.extractCallbackNode(update);
    if (!callback) {
      return null;
    }

    const value = callback.payload ?? callback.data;
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  private extractCallbackUserId(update: MaxUpdate): string | null {
    const callback = this.extractCallbackNode(update);
    if (!callback) {
      return null;
    }

    const user = this.asRecord(callback.user);
    const value = user?.user_id ?? user?.userId ?? user?.id;
    if (typeof value === 'string' || typeof value === 'number') {
      const normalized = String(value).trim();
      return normalized.length > 0 ? normalized : null;
    }

    return null;
  }

  private resolvePrivateCallbackCommand(payload: string | null): PrivateControlCommand | null {
    if (!payload) {
      return null;
    }

    if (payload === PRIVATE_MENU_CALLBACK_CHATS) {
      return 'chats';
    }
    if (payload === PRIVATE_MENU_CALLBACK_CHANNELS) {
      return 'channels';
    }
    if (payload === PRIVATE_MENU_CALLBACK_HELP) {
      return 'help';
    }
    if (payload === PRIVATE_MENU_CALLBACK_MENU) {
      return 'menu';
    }

    return null;
  }

  private resolvePrivateTextCommand(text: string): PrivateControlCommand | null {
    const normalized = this.readLowerString(text);
    if (!normalized) {
      return null;
    }

    if (
      normalized === '/start' ||
      normalized === '/menu' ||
      normalized === 'menu' ||
      normalized === 'меню' ||
      normalized === 'кнопки'
    ) {
      return 'menu';
    }

    if (
      normalized === '/chats' ||
      normalized === '/chat' ||
      normalized === 'чаты' ||
      normalized === 'мои чаты'
    ) {
      return 'chats';
    }

    if (
      normalized === '/channels' ||
      normalized === '/channel' ||
      normalized === 'каналы' ||
      normalized === 'мои каналы'
    ) {
      return 'channels';
    }

    if (
      normalized === '/help' ||
      normalized === 'help' ||
      normalized === 'помощь' ||
      normalized === 'что умеешь'
    ) {
      return 'help';
    }

    return null;
  }

  private looksLikeSlashCommand(text: string): boolean {
    return typeof text === 'string' && text.trim().startsWith('/');
  }

  private async executePrivateCommand(
    chatId: string,
    command: PrivateControlCommand,
  ): Promise<void> {
    if (command === 'help') {
      await this.sendPrivateMenu(chatId, this.buildPrivateMenuPromptText());
      return;
    }

    if (command === 'chats') {
      await this.sendPrivateEntityList(chatId, 'chat');
      return;
    }

    if (command === 'channels') {
      await this.sendPrivateEntityList(chatId, 'channel');
      return;
    }

    await this.sendPrivateMenu(chatId, this.buildPrivateMenuPromptText());
  }

  private async sendPrivateEntityList(
    chatId: string,
    entityType: 'chat' | 'channel',
  ): Promise<void> {
    try {
      const entities = await this.loadPrivateMenuManagedEntities(entityType);

      if (entities.length === 0) {
        await this.sendPrivateMenu(
          chatId,
          entityType === 'channel'
            ? 'Пока нет каналов с ботом. Добавьте бота в канал и выдайте ему права администратора.'
            : 'Пока нет групповых чатов с ботом. Добавьте бота в чат и выдайте права администратора.',
        );
        return;
      }

      const preview = entities.slice(0, PRIVATE_BOT_CHATS_PREVIEW_LIMIT);
      const lines = preview.map((chat, index) => {
        const title = (chat.title ?? `Чат ${chat.id}`).replace(/\s+/g, ' ').trim();
        return `${index + 1}. ${title}`;
      });

      const moreCount = entities.length - preview.length;
      const message = [
        entityType === 'channel'
          ? `Каналы с ботом: ${entities.length}`
          : `Чаты с ботом: ${entities.length}`,
        '',
        ...lines,
        ...(moreCount > 0
          ? [
              '',
              entityType === 'channel'
                ? `... и ещё ${moreCount} каналов.`
                : `... и ещё ${moreCount} чатов.`,
            ]
          : []),
        '',
        'Для настройки откройте приложение.',
      ].join('\n');

      await this.sendPrivateMenu(chatId, message);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to load private chats list',
      );
      await this.sendPrivateMenu(
        chatId,
        'Не удалось получить список чатов. Повторите запрос через несколько секунд.',
      );
    }
  }

  private async loadPrivateMenuManagedEntities(
    entityType: 'chat' | 'channel',
  ): Promise<Array<{ id: string; title: string | null }>> {
    if (typeof this.prisma.chat?.findMany !== 'function') {
      return [];
    }

    const chats = await this.prisma.chat.findMany({
      where: {
        catalogKind: ChatCatalogKind.MANAGED,
        entityType: entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT,
        ...(entityType === 'chat' ? { id: { startsWith: '-' } } : {}),
        botMemberships: {
          some: {
            status: ChatBotMembershipStatus.ACTIVE,
          },
        },
      },
      select: {
        id: true,
        title: true,
      },
      orderBy: [{ updatedAt: 'desc' }, { title: 'asc' }],
      take: PRIVATE_BOT_CHATS_PREVIEW_LIMIT + 1,
    });

    return chats.filter((chat) => {
      if (entityType === 'channel') {
        return true;
      }

      const numericChatId = this.parseChatIdAsBigInt(chat.id);
      return numericChatId !== null && numericChatId < 0n;
    });
  }

  private async sendPrivateMenu(chatId: string, text: string): Promise<void> {
    try {
      await this.maxClient.sendMessage(chatId, text, this.buildPrivateMenuOptions(), {
        ignoreFailureMetricStatuses: PRIVATE_DIALOG_TERMINAL_FAILURE_METRIC_STATUSES,
      });
    } catch (error: unknown) {
      if (this.isTerminalPrivateDialogDeliveryError(error)) {
        this.logger.debug(
          {
            chatId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Skipped private menu delivery after terminal private dialog error',
        );
        return;
      }

      throw error;
    }
  }

  private buildPrivateMenuOptions(): MaxSendMessageOptions {
    const miniappUrl = this.resolveMiniappUrl();
    const miniappButton = this.buildMiniappLaunchButton('Открыть приложение', '/', miniappUrl);

    const buttons: MaxSendMessageOptions['buttons'] = [
      [
        {
          type: 'callback',
          text: 'Чаты',
          payload: PRIVATE_MENU_CALLBACK_CHATS,
        },
        {
          type: 'callback',
          text: 'Каналы',
          payload: PRIVATE_MENU_CALLBACK_CHANNELS,
        },
      ],
      [
        miniappButton,
        {
          type: 'link',
          text: 'Поддержка',
          url: SUPPORT_CHAT_URL,
        },
      ],
    ];

    return {
      buttons,
      textFormat: 'markdown',
    };
  }

  private normalizeAppBaseUrl(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().replace(/\/+$/, '');
    if (!normalized) {
      return null;
    }

    if (!/^https?:\/\//i.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private resolveMiniappUrl(): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    return `${this.appBaseUrl}/app/`;
  }

  private buildMiniappLaunchButton(
    text: string,
    route: string,
    fallbackWebAppUrl: string | null,
  ): MaxMessageButton {
    const launchUrl = this.buildMiniappRouteLaunchUrl(route);
    if (launchUrl) {
      return {
        type: 'link',
        text,
        url: launchUrl,
      };
    }

    const botContactId = this.resolveBotContactId();
    if (fallbackWebAppUrl && botContactId) {
      return {
        type: 'open_app',
        text,
        webApp: fallbackWebAppUrl,
        contactId: botContactId,
      };
    }

    return {
      type: 'link',
      text,
      url: fallbackWebAppUrl ?? 'https://major-maksimov.ru/app/',
    };
  }

  private buildMiniappRouteLaunchUrl(route: string, _botId?: string | null): string | null {
    return this.buildEntryMiniappStartUrl(this.buildMiniappRouteStartParam(route));
  }

  private buildMiniappRouteStartParam(route: string): string {
    const payload = JSON.stringify({
      v: 1,
      k: 'route',
      r: route,
    });
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${MINIAPP_ROUTE_START_PARAM_PREFIX}${encoded}`;
  }

  private async resolveUnifiedBotRoute(request: MaxBotRouteRequest): Promise<MaxBotRoute | null> {
    return resolveUnifiedBotRouteForModeration(
      {
        maxBotLinkService: this.maxBotLinkService,
      },
      request,
    );
  }

  private async resolveChatReadBotId(chatId: string): Promise<string | null> {
    return resolveChatReadBotIdForModeration(
      {
        maxBotLinkService: this.maxBotLinkService,
      },
      chatId,
    );
  }

  private async resolveAutoAttachBotId(
    chatId: string,
    source: 'webhook' | 'poll',
  ): Promise<string | null> {
    return resolveAutoAttachBotIdForModeration(
      {
        maxBotLinkService: this.maxBotLinkService,
        maxBotContextService: this.maxBotContextService,
      },
      chatId,
      source,
    );
  }

  private async recordChannelAutoPostAccessLossIfTerminal(params: {
    chatId: string;
    botId: string | null;
    source: string;
    operation: 'send' | 'edit' | 'read';
    error: unknown;
  }): Promise<boolean> {
    try {
      const result = await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost?.({
        chatId: params.chatId,
        botId: params.botId,
        entityType: ChatEntityType.CHANNEL,
        source: params.source,
        operation: params.operation,
        error: params.error,
      });
      if (!result?.recorded) {
        return false;
      }

      this.logger.warn(
        {
          chatId: params.chatId,
          botId: params.botId,
          source: params.source,
          operation: params.operation,
          reason: result.reason,
        },
        'Channel auto-post background work stopped after managed channel lost MAX access',
      );
      return true;
    } catch (accessLossError: unknown) {
      this.logger.debug(
        {
          chatId: params.chatId,
          source: params.source,
          err: accessLossError instanceof Error ? accessLossError.message : String(accessLossError),
        },
        'Failed to record channel auto-post MAX access loss',
      );
      return false;
    }
  }

  private async executeModerationActionWithFallback(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    explicitBotId?: string | null;
    messageId?: string;
    userId?: string;
    operation: (botId?: string) => Promise<void>;
  }): Promise<boolean> {
    let attempt = await this.attemptModerationActionWithCandidateBots(
      params,
      await this.resolveModerationActionBotIds(params),
    );
    if (attempt.status === 'success') {
      return true;
    }

    if (!params.explicitBotId && attempt.status === 'no_candidates') {
      const refreshedCandidateBotIds = await this.refreshModerationActionCandidateBotIds({
        chatId: params.chatId,
        action: params.action,
      });
      if (refreshedCandidateBotIds.length > 0) {
        attempt = await this.attemptModerationActionWithCandidateBots(
          params,
          refreshedCandidateBotIds,
        );
        if (attempt.status === 'success') {
          return true;
        }
      }
    }

    if (attempt.status === 'terminal_error') {
      this.scheduleModerationActionAccessRecheck(params.chatId, params.action);
      this.logSkippedModerationActionAfterTerminalError({
        chatId: params.chatId,
        action: params.action,
        messageId: params.messageId,
        userId: params.userId,
        attemptedBotIds: attempt.attemptedBotIds,
        error: attempt.error,
      });
      return false;
    }

    if (attempt.status === 'backoff_blocked') {
      this.scheduleModerationActionAccessRecheck(params.chatId, params.action);
    }

    this.logSkippedModerationActionDueToPermissions({
      chatId: params.chatId,
      action: params.action,
      messageId: params.messageId,
      userId: params.userId,
    });
    return false;
  }

  private async attemptModerationActionWithCandidateBots(
    params: {
      chatId: string;
      action: 'delete_message' | 'moderate_member';
      explicitBotId?: string | null;
      messageId?: string;
      userId?: string;
      operation: (botId?: string) => Promise<void>;
    },
    candidateBotIds: Array<string | null>,
  ): Promise<ModerationActionAttemptResult> {
    if (candidateBotIds.length === 0) {
      return { status: 'no_candidates' };
    }

    let terminalError: unknown = null;
    let skippedDueToBackoff = false;
    const attemptedBotIds: string[] = [];

    for (const candidateBotId of candidateBotIds) {
      if (
        candidateBotId &&
        (await this.isModerationActionBotBackoffActive(
          params.chatId,
          params.action,
          candidateBotId,
        ))
      ) {
        skippedDueToBackoff = true;
        continue;
      }

      if (candidateBotId) {
        attemptedBotIds.push(candidateBotId);
      }

      try {
        await params.operation(candidateBotId ?? undefined);
        if (candidateBotId) {
          await this.clearModerationActionBotBackoff(params.chatId, params.action, candidateBotId);
        }
        return { status: 'success' };
      } catch (error: unknown) {
        if (!this.isTerminalModerationActionPermissionError(error)) {
          throw error;
        }

        terminalError = error;
        if (candidateBotId) {
          if (this.isTerminalModerationActionAccessError(error)) {
            await this.rememberModerationActionBotBackoff(
              params.chatId,
              params.action,
              candidateBotId,
            );
            await this.recordModerationActionAccessLossIfTerminal({
              chatId: params.chatId,
              action: params.action,
              botId: candidateBotId,
              error,
            });
            await this.persistModerationActionBotAccessSnapshot(
              params.chatId,
              candidateBotId,
              null,
              {
                action: params.action,
                error,
              },
            );
          }
          await this.recordModerationActionProblemChat({
            chatId: params.chatId,
            action: params.action,
            botId: candidateBotId,
            error,
          });
        }
      }
    }

    if (terminalError) {
      return {
        status: 'terminal_error',
        attemptedBotIds,
        error: terminalError,
      };
    }

    return skippedDueToBackoff ? { status: 'backoff_blocked' } : { status: 'no_candidates' };
  }

  private async recordModerationActionAccessLossIfTerminal(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    botId: string;
    error: unknown;
  }): Promise<void> {
    let detached = false;
    const operation = Promise.resolve().then(async () => {
      await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost?.({
        chatId: params.chatId,
        botId: params.botId,
        entityType: null,
        source: `moderation_action:${params.action}`,
        operation: params.action === 'delete_message' ? 'delete' : 'lookup',
        error: params.error,
      });
    });
    operation.catch((error: unknown) => {
      if (!detached) {
        return;
      }
      this.logger.debug(
        {
          chatId: params.chatId,
          botId: params.botId,
          action: params.action,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record moderation action MAX access loss after hot-path budget',
      );
    });

    try {
      await raceWithTimeout({
        operation,
        timeoutMs: MODERATION_ACTION_ACCESS_LOSS_HOT_PATH_TIMEOUT_MS,
        onTimeout: () => {
          detached = true;
        },
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: params.chatId,
          botId: params.botId,
          action: params.action,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record moderation action MAX access loss',
      );
      return;
    }

    if (detached) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'moderation-action-access-loss.deferred',
        outcome: 'skip',
        failOpen: true,
      });
      this.logger.debug(
        {
          chatId: params.chatId,
          botId: params.botId,
          action: params.action,
          timeoutMs: MODERATION_ACTION_ACCESS_LOSS_HOT_PATH_TIMEOUT_MS,
        },
        'Moderation action access-loss recording exceeded hot-path budget; continuing detached',
      );
    }
  }

  private async resolveModerationActionBotIds(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    explicitBotId?: string | null;
  }): Promise<Array<string | null>> {
    return resolveModerationActionBotIdsForModeration(
      {
        maxBotLinkService: this.maxBotLinkService,
      },
      params,
    );
  }

  private async refreshModerationActionCandidateBotIds(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    force?: boolean;
    skipBackoffClearBotIds?: readonly string[];
  }): Promise<string[]> {
    const confirmedBotIds = await this.refreshModerationActionBotSnapshots(params);
    const candidateBotIds = (
      await this.resolveModerationActionBotIds({
        chatId: params.chatId,
        action: params.action,
      })
    ).filter((botId): botId is string => typeof botId === 'string' && botId.trim().length > 0);
    const skippedBackoffClearBotIds = new Set(
      (params.skipBackoffClearBotIds ?? [])
        .map((botId) => botId.trim())
        .filter((botId) => botId.length > 0),
    );
    for (const botId of candidateBotIds) {
      if (skippedBackoffClearBotIds.has(botId)) {
        continue;
      }
      if (!confirmedBotIds.has(botId)) {
        continue;
      }
      await this.clearModerationActionBotBackoff(params.chatId, params.action, botId);
    }
    return candidateBotIds;
  }

  private async refreshModerationActionBotSnapshots(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    force?: boolean;
  }): Promise<Set<string>> {
    const refreshKey = this.buildModerationActionSnapshotRefreshKey(params.chatId, params.action);
    const inFlightRefresh = this.moderationActionSnapshotRefreshInFlight.get(refreshKey);
    if (inFlightRefresh) {
      return await inFlightRefresh;
    }

    const refreshAllowedAtMs = this.moderationActionSnapshotRefreshUntilMs.get(refreshKey) ?? 0;
    if (!params.force && refreshAllowedAtMs > Date.now()) {
      return new Set();
    }

    const refreshPromise = this.refreshModerationActionBotSnapshotsInternal(
      params.chatId,
      params.action,
    ).finally(() => {
      this.moderationActionSnapshotRefreshInFlight.delete(refreshKey);
      this.moderationActionSnapshotRefreshUntilMs.set(
        refreshKey,
        Date.now() + MODERATION_ACTION_PERMISSION_REFRESH_MIN_INTERVAL_MS,
      );
    });
    this.moderationActionSnapshotRefreshInFlight.set(refreshKey, refreshPromise);
    return await refreshPromise;
  }

  private async refreshModerationActionBotSnapshotsInternal(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
  ): Promise<Set<string>> {
    const { botIds, entityType } = await this.loadModerationActionSnapshotRefreshState(chatId);
    const confirmedBotIds = new Set<string>();
    if (botIds.length === 0) {
      return confirmedBotIds;
    }

    await Promise.all(
      botIds.map(async (botId) => {
        try {
          const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
            botId,
            trafficClass: 'background',
            actionHealthLane: 'background',
            timeoutMs: MODERATION_ACTION_PERMISSION_REFRESH_TIMEOUT_MS,
          });
          if (
            this.hasModerationActionAccess(access, action, {
              requireExplicitPermission: true,
              entityType,
            })
          ) {
            confirmedBotIds.add(botId);
          }
          await this.persistModerationActionBotAccessSnapshot(chatId, botId, access, {
            action,
            entityType,
          });
        } catch (error: unknown) {
          if (this.isTerminalModerationActionPermissionError(error)) {
            await this.persistModerationActionBotAccessSnapshot(chatId, botId, null, {
              action,
              error,
              entityType,
            });
            await this.recordModerationActionProblemChat({
              chatId,
              action,
              botId,
              error,
            });
            return;
          }

          this.logger.debug(
            {
              chatId,
              botId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to refresh bot self access snapshot for moderation action fallback',
          );
        }
      }),
    );
    return confirmedBotIds;
  }

  private async loadModerationActionSnapshotRefreshState(chatId: string): Promise<{
    botIds: string[];
    entityType: ChatEntityType | null;
  }> {
    if (typeof this.prisma.chat?.findUnique !== 'function') {
      return { botIds: [], entityType: null };
    }

    try {
      const chat = await this.prisma.chat.findUnique({
        where: { id: chatId },
        select: {
          entityType: true,
          primaryBotId: true,
          botId: true,
          botMemberships: {
            select: {
              botId: true,
              status: true,
            },
            orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }],
          },
        },
      });
      const candidateBotIds: string[] = [];
      const getResolvedBotSync = this.maxBotLinkService?.getResolvedBotSync;
      const trackedBotIds = new Set<string>();
      for (const rawBotId of [
        typeof chat?.primaryBotId === 'string' ? chat.primaryBotId : null,
        typeof chat?.botId === 'string' ? chat.botId : null,
        ...((chat?.botMemberships ?? [])
          .filter((membership) => membership.status === ChatBotMembershipStatus.ACTIVE)
          .map((membership) => membership.botId) as string[]),
      ]) {
        const normalizedBotId = typeof rawBotId === 'string' ? rawBotId.trim() : '';
        if (!normalizedBotId || trackedBotIds.has(normalizedBotId)) {
          continue;
        }
        trackedBotIds.add(normalizedBotId);
        if (candidateBotIds.includes(normalizedBotId)) {
          continue;
        }

        if (typeof getResolvedBotSync === 'function') {
          const resolvedBotId =
            getResolvedBotSync.call(this.maxBotLinkService, normalizedBotId)?.id ?? null;
          if (resolvedBotId !== normalizedBotId) {
            continue;
          }
        }

        candidateBotIds.push(normalizedBotId);
      }
      return {
        botIds: candidateBotIds,
        entityType: chat?.entityType ?? null,
      };
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to load bot memberships for moderation action snapshot refresh',
      );
      return { botIds: [], entityType: null };
    }
  }

  private async persistModerationActionBotAccessSnapshot(
    chatId: string,
    botId: string,
    access: Pick<MaxChatMemberAccess, 'isAdmin' | 'isOwner' | 'permissions'> | null,
    issue?: {
      action?: 'delete_message' | 'moderate_member';
      error?: unknown;
      entityType?: ChatEntityType | null;
    },
  ): Promise<void> {
    if (typeof this.prisma.chatBotMembership?.updateMany !== 'function') {
      return;
    }

    try {
      await this.prisma.chatBotMembership.updateMany({
        where: {
          chatId,
          botId,
        },
        data: {
          ...(access ? { lastSeenAt: new Date() } : {}),
          permissionsSnapshot: this.buildModerationActionAccessSnapshot(access, issue),
        },
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist bot self access snapshot for moderation action fallback',
      );
    }
  }

  private hasModerationActionAccess(
    access: Pick<MaxChatMemberAccess, 'isAdmin' | 'isOwner' | 'permissions'> | null,
    action: 'delete_message' | 'moderate_member',
    options?: { requireExplicitPermission?: boolean; entityType?: ChatEntityType | null },
  ): boolean {
    if (!access) {
      return false;
    }

    if (access.isOwner === true) {
      return true;
    }

    const permissions = this.normalizeModerationActionPermissions(access.permissions);
    if (permissions.length > 0) {
      return permissions.some((permission) =>
        this.isModerationActionPermission(permission, action, options?.entityType ?? null),
      );
    }

    if (options?.requireExplicitPermission) {
      return false;
    }

    return access.isAdmin === true;
  }

  private normalizeModerationActionPermissions(
    value: readonly string[] | null | undefined,
  ): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return Array.from(
      new Set(
        value
          .map((permission) => this.normalizeModerationActionPermissionName(permission))
          .filter((permission): permission is string => permission.length > 0),
      ),
    );
  }

  private normalizeModerationActionPermissionName(permission: unknown): string {
    if (typeof permission !== 'string') {
      return '';
    }

    return permission
      .trim()
      .toLowerCase()
      .replace(/[-\s]+/gu, '_');
  }

  private isModerationActionPermission(
    permission: string,
    action: 'delete_message' | 'moderate_member',
    entityType?: ChatEntityType | null,
  ): boolean {
    if (action === 'delete_message') {
      const aliases =
        entityType === ChatEntityType.CHAT
          ? CHAT_DELETE_MESSAGE_PERMISSION_ALIASES
          : DELETE_MESSAGE_PERMISSION_ALIASES;
      return aliases.has(permission);
    }

    return MODERATE_MEMBER_PERMISSION_ALIASES.has(permission);
  }

  private buildModerationActionBotBackoffKey(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
    botId: string,
  ): string {
    return `${chatId}:${action}:${botId}`;
  }

  private buildModerationActionBotSharedBackoffKey(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
    botId: string,
  ): string {
    return `moderation-action-terminal-backoff:v1:${chatId}:${action}:${botId}`;
  }

  private buildModerationActionSnapshotRefreshKey(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
  ): string {
    return `${chatId}:${action}`;
  }

  private async isModerationActionBotBackoffActive(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
    botId: string,
  ): Promise<boolean> {
    const cacheKey = this.buildModerationActionBotBackoffKey(chatId, action, botId);
    const backoffUntilMs = this.moderationActionBotBackoffUntilMs.get(cacheKey) ?? 0;
    if (backoffUntilMs > Date.now()) {
      return true;
    }

    if (backoffUntilMs > 0) {
      this.moderationActionBotBackoffUntilMs.delete(cacheKey);
    }

    const getString = (this.redisCounter as Partial<RedisCounterService> | undefined)?.getString;
    if (!getString || !this.redisCounter) {
      return false;
    }

    try {
      const sharedMarker = await getString.call(
        this.redisCounter,
        this.buildModerationActionBotSharedBackoffKey(chatId, action, botId),
      );
      if (sharedMarker === '1') {
        this.moderationActionBotBackoffUntilMs.set(
          cacheKey,
          Date.now() + MODERATION_ACTION_PERMISSION_BACKOFF_MS,
        );
        return true;
      }
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          action,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read shared moderation action terminal backoff marker',
      );
    }

    return false;
  }

  private async rememberModerationActionBotBackoff(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
    botId: string,
  ): Promise<void> {
    const localKey = this.buildModerationActionBotBackoffKey(chatId, action, botId);
    this.moderationActionBotBackoffUntilMs.set(
      localKey,
      Date.now() + MODERATION_ACTION_PERMISSION_BACKOFF_MS,
    );

    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (!setStringWithTtl || !this.redisCounter) {
      return;
    }

    try {
      await setStringWithTtl.call(
        this.redisCounter,
        this.buildModerationActionBotSharedBackoffKey(chatId, action, botId),
        '1',
        Math.ceil(MODERATION_ACTION_PERMISSION_BACKOFF_MS / 1_000),
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          action,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to write shared moderation action terminal backoff marker',
      );
    }
  }

  private async clearModerationActionBotBackoff(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
    botId: string,
  ): Promise<void> {
    this.moderationActionBotBackoffUntilMs.delete(
      this.buildModerationActionBotBackoffKey(chatId, action, botId),
    );

    const deleteKey = (this.redisCounter as Partial<RedisCounterService> | undefined)?.deleteKey;
    if (!deleteKey || !this.redisCounter) {
      return;
    }

    try {
      await deleteKey.call(
        this.redisCounter,
        this.buildModerationActionBotSharedBackoffKey(chatId, action, botId),
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          action,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to clear shared moderation action terminal backoff marker',
      );
    }
  }

  private buildModerationActionAccessSnapshot(
    access: Pick<MaxChatMemberAccess, 'isAdmin' | 'isOwner' | 'permissions'> | null,
    issue?: {
      action?: 'delete_message' | 'moderate_member';
      error?: unknown;
      entityType?: ChatEntityType | null;
    },
  ): Prisma.InputJsonValue {
    const statusCode = issue?.error ? this.extractStatusCode(issue.error) : null;
    const code = issue?.error ? this.extractMaxErrorCode(issue.error) : null;
    const message = issue?.error ? this.extractMaxErrorMessage(issue.error) : null;
    const permissions = this.normalizeModerationActionPermissions(access?.permissions);
    const actionLimited =
      Boolean(access && issue?.action) &&
      !this.hasModerationActionAccess(access, issue?.action ?? 'delete_message', {
        requireExplicitPermission: true,
        entityType: issue?.entityType ?? null,
      });

    return {
      checkedAt: new Date().toISOString(),
      isAdmin: access?.isAdmin === true,
      isOwner: access?.isOwner === true,
      permissions,
      health: access ? (actionLimited ? 'action_limited' : 'ok') : 'access_limited',
      ...(actionLimited && issue?.action ? { missingActions: [issue.action] } : {}),
      ...(issue?.error
        ? {
            lastIssue: {
              kind: 'terminal_moderation_action',
              observedAt: new Date().toISOString(),
              action: issue.action ?? null,
              statusCode,
              code,
              message,
            },
          }
        : {}),
    } satisfies Prisma.InputJsonValue;
  }

  private async recordModerationActionProblemChat(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    botId: string;
    error: unknown;
  }): Promise<void> {
    await this.runtimeDiagnosticsService?.recordProblemChat({
      chatId: params.chatId,
      botId: params.botId,
      category: 'moderation_action_terminal',
      severity: this.extractStatusCode(params.error) === 404 ? 'warning' : 'critical',
      action: params.action,
      statusCode: this.extractStatusCode(params.error),
      reason: this.extractMaxErrorMessage(params.error) || 'terminal moderation action error',
    });
  }

  /*
   * Legacy sync wrappers are intentionally not kept here: all moderation action
   * permission backoff now goes through Redis when available, so every worker
   * sees the same short suppression window.
   */

  private isTerminalModerationActionPermissionError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 403 || status === 404) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (
      code === 'chat.denied' ||
      code === 'chat.not.found' ||
      code === 'message.not.found' ||
      code === 'member.not.found'
    ) {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('bot is not a chat member') ||
      message.includes('not accessible') ||
      message.includes('chat not found') ||
      message.includes('message not found') ||
      message.includes('sufficient rights') ||
      message.includes('already been deleted') ||
      message.includes('already deleted')
    );
  }

  private isTerminalModerationActionAccessError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 403) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found') {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('bot is not a chat member') ||
      message.includes('not accessible') ||
      message.includes('chat not found') ||
      message.includes('sufficient rights')
    );
  }

  private logSkippedModerationActionAfterTerminalError(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    messageId?: string;
    userId?: string;
    attemptedBotIds: string[];
    error: unknown;
  }): void {
    const cacheKey = `${params.chatId}:${params.action}`;
    const now = Date.now();
    const lastLoggedAtMs = this.moderationActionPermissionSkipLogAtMs.get(cacheKey) ?? 0;
    if (now - lastLoggedAtMs < MODERATION_ACTION_PERMISSION_SKIP_LOG_INTERVAL_MS) {
      return;
    }

    this.moderationActionPermissionSkipLogAtMs.set(cacheKey, now);
    this.logger.warn(
      {
        chatId: params.chatId,
        action: params.action,
        messageId: params.messageId,
        userId: params.userId,
        attemptedBotIds: params.attemptedBotIds,
        status: this.extractStatusCode(params.error),
        code: this.extractMaxErrorCode(params.error),
        error: params.error instanceof Error ? params.error.message : 'Unknown error',
      },
      'Skipped moderation action after terminal MAX API error',
    );
  }

  private logSkippedModerationActionDueToPermissions(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    messageId?: string;
    userId?: string;
  }): void {
    const cacheKey = `${params.chatId}:${params.action}`;
    const now = Date.now();
    const lastLoggedAtMs = this.moderationActionPermissionSkipLogAtMs.get(cacheKey) ?? 0;
    if (now - lastLoggedAtMs < MODERATION_ACTION_PERMISSION_SKIP_LOG_INTERVAL_MS) {
      return;
    }

    this.moderationActionPermissionSkipLogAtMs.set(cacheKey, now);
    this.logger.warn(
      {
        chatId: params.chatId,
        action: params.action,
        messageId: params.messageId,
        userId: params.userId,
      },
      'Skipped moderation action because no active bot has the required MAX permissions in this chat',
    );
  }

  private resolveBotContactId(botId?: string | null): string | null {
    const contextAwareContactId = this.maxBotLinkService?.resolveContactIdSync?.(botId);
    if (contextAwareContactId) {
      return contextAwareContactId;
    }

    if (this.explicitBotContactId) {
      return this.explicitBotContactId;
    }

    if (!this.ownBotUserId) {
      return null;
    }

    const normalized = this.ownBotUserId.trim().replace(/^id/i, '').replace(/_bot$/i, '');
    const [primary] = normalized.split('_');
    return /^\d+$/.test(primary) ? primary : null;
  }

  private normalizeBotContactId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim();
    if (!normalized || !/^\d+$/.test(normalized)) {
      return null;
    }
    return normalized;
  }

  private async resolveSenderChatAdminCheck(
    chatId: string,
    localAdminUserIds: string[] | undefined,
    userId: string,
    options?: {
      allowRemoteLookup?: boolean;
      skipRemoteLookupWhenLocalAdminsKnown?: boolean;
      remoteLookupSoftTimeoutMs?: number;
      prefetchRemoteLookupWhenLocalAdminsKnown?: boolean;
    },
  ): Promise<ChatAdminCheckResult> {
    return this.moderationAccessService.resolveSenderChatAdminCheck(
      chatId,
      localAdminUserIds,
      userId,
      options,
    );
  }

  private async recheckSenderChatAdminBeforeModeration(
    chatId: string,
    localAdminUserIds: string[] | undefined,
    userId: string,
    initialResult: ChatAdminCheckResult,
    options?: {
      maxWaitMs?: number;
    },
  ): Promise<ChatAdminCheckResult> {
    return this.moderationAccessService.recheckSenderChatAdminBeforeModeration(
      chatId,
      localAdminUserIds,
      userId,
      initialResult,
      options,
    );
  }

  private async handleChatAdminModerationBypass(params: {
    update: MaxUpdate;
    chatId: string;
    chatTitle: string | undefined;
    senderId: string;
    senderName: string | undefined;
    messageId: string | undefined;
    text: string | undefined;
    settings: ChatSettings;
    source: ChatAdminCheckSource;
  }): Promise<void> {
    const { update, chatId, chatTitle, senderId, senderName, messageId, text, settings, source } =
      params;

    if (messageId) {
      const handledAdminCommand = await this.handleAdminForwardedModerationCommand({
        update,
        chatId,
        senderId,
        messageId,
        settings,
        ...(chatTitle !== undefined ? { chatTitle } : {}),
        ...(senderName !== undefined ? { senderName } : {}),
      });
      if (handledAdminCommand) {
        return;
      }
    }

    if (messageId && this.shouldAutoAttachChatCommentsButton(settings, true)) {
      await this.tryAutoAttachChatMessageComments({
        chatId,
        messageId,
        text: typeof text === 'string' && text.trim() ? text : null,
        senderId,
        senderIsAdmin: true,
        update,
      });
    }

    this.logger.debug(
      {
        chatId,
        userId: senderId,
        source,
      },
      'Moderation bypassed for chat admin',
    );
  }

  private scheduleDestructiveAdminRosterRefresh(params: {
    chatId: string;
    chatTitle: string | undefined;
    botId: string | null;
    entityType: string | null;
    stage: string;
  }): void {
    if (typeof this.maxChatAdminRosterSyncService?.scheduleChatAdminRosterSync !== 'function') {
      return;
    }

    const chatId = params.chatId.trim();
    if (!chatId) {
      return;
    }

    const now = Date.now();
    const lastScheduledAt = this.destructiveAdminRosterRefreshScheduledAtMs.get(chatId) ?? 0;
    if (now - lastScheduledAt < DESTRUCTIVE_ADMIN_ROSTER_REFRESH_THROTTLE_MS) {
      return;
    }
    this.destructiveAdminRosterRefreshScheduledAtMs.set(chatId, now);

    void this.maxChatAdminRosterSyncService
      .scheduleChatAdminRosterSync({
        chatId,
        botIds: params.botId ? [params.botId] : [],
        title: params.chatTitle ?? null,
        entityType: params.entityType === 'channel' ? 'channel' : 'chat',
        source: 'moderation_destructive_path',
        retryUntilMs: null,
      })
      .catch((error: unknown) => {
        this.destructiveAdminRosterRefreshScheduledAtMs.delete(chatId);
        this.logger.warn(
          {
            chatId,
            stage: params.stage,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to schedule destructive moderation admin roster refresh',
        );
      });
  }

  private scheduleModerationActionAccessRecheck(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
  ): void {
    if (typeof this.maxChatAdminRosterSyncService?.scheduleChatAdminRosterSync !== 'function') {
      return;
    }

    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }

    const cacheKey = `${normalizedChatId}:${action}`;
    const now = Date.now();
    const lastScheduledAt = this.destructiveAdminRosterRefreshScheduledAtMs.get(cacheKey) ?? 0;
    if (now - lastScheduledAt < DESTRUCTIVE_ADMIN_ROSTER_REFRESH_THROTTLE_MS) {
      return;
    }
    this.destructiveAdminRosterRefreshScheduledAtMs.set(cacheKey, now);

    void this.maxChatAdminRosterSyncService
      .scheduleChatAdminRosterSync({
        chatId: normalizedChatId,
        botIds: [],
        title: null,
        entityType: null,
        source: 'moderation_destructive_path',
        retryUntilMs: null,
      })
      .catch((error: unknown) => {
        this.destructiveAdminRosterRefreshScheduledAtMs.delete(cacheKey);
        this.logger.warn(
          {
            chatId: normalizedChatId,
            action,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to schedule moderation action access recheck',
        );
      });
  }

  private async isOtherBotAdminModerationBypass(params: {
    chatId: string;
    localAdminUserIds: string[] | undefined;
    senderId: string;
    degradeMode: boolean;
    hotChatBackoffActive: boolean;
  }): Promise<boolean> {
    return this.moderationAccessService.isOtherBotAdminModerationBypass(params);
  }

  private isSenderChatAdmin(adminUserIds: string[] | undefined, userId: string): boolean {
    return this.moderationAccessService.isSenderChatAdmin(adminUserIds, userId);
  }

  private buildChatAdminAccessLookupKey(chatId: string, userId: string): string {
    return this.moderationAccessService.buildChatAdminAccessLookupKey(chatId, userId);
  }

  private async getRemoteChatAdminAccess(
    chatId: string,
    userId: string,
    options: {
      allowLookup?: boolean;
    } = {},
  ): Promise<RemoteChatAdminAccessState | null> {
    return this.moderationAccessService.getRemoteChatAdminAccess(chatId, userId, options);
  }

  private async getRemoteChatAdminAccessWithin(
    chatId: string,
    userId: string,
    options: {
      maxWaitMs: number;
    },
  ): Promise<RemoteChatAdminAccessState | null> {
    return this.moderationAccessService.getRemoteChatAdminAccessWithin(chatId, userId, options);
  }

  private async loadRemoteChatAdminAccessBatch(
    chatId: string,
    userIds: readonly string[],
    options: {
      trafficClass?: 'interactive' | 'background';
      sourceTag?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<Map<string, RemoteChatAdminAccessState>> {
    return this.moderationAccessService.loadRemoteChatAdminAccessBatch(chatId, userIds, options);
  }

  private shouldForceSynchronousRemoteAdminLookup(
    update: MaxUpdate,
    settings?: Pick<
      ChatSettings,
      | 'adminBanCommandName'
      | 'adminBanAllCommandName'
      | 'adminMuteCommandName'
      | 'adminPermanentMuteCommandName'
      | 'adminRulesCommandName'
      | 'adminSilenceCommandName'
      | 'adminOpenChatCommandName'
    >,
  ): boolean {
    return this.moderationAccessService.shouldForceSynchronousRemoteAdminLookup(update, settings);
  }

  private prefetchRemoteChatAdminAccess(chatId: string, userId: string): void {
    this.moderationAccessService.prefetchRemoteChatAdminAccess(chatId, userId);
  }

  private async executeRemoteChatAdminLookupWithGuard<T>(
    operation: () => Promise<T>,
    context: {
      chatId: string;
      userIds: readonly string[];
      botId?: string | null;
    },
  ): Promise<T> {
    return this.moderationAccessService.executeRemoteChatAdminLookupWithGuard(operation, context);
  }

  private async persistRemoteAdminGrant(chatId: string, userId: string): Promise<void> {
    return this.moderationAccessService.persistRemoteAdminGrant(chatId, userId);
  }

  private normalizeNightModeTimezone(value: string): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return DEFAULT_NIGHT_MODE_TIMEZONE;
    }

    try {
      Intl.DateTimeFormat('ru-RU', { timeZone: normalized }).format(new Date());
      return normalized;
    } catch {
      return DEFAULT_NIGHT_MODE_TIMEZONE;
    }
  }

  private async consumeChatParticipantModerationImmunity(params: {
    chatId: string;
    userId: string;
    nightModeTimezone: string | null;
  }): Promise<boolean> {
    if (typeof this.prisma.$queryRaw !== 'function') {
      return false;
    }

    const now = new Date();
    const timezone = this.normalizeNightModeTimezone(params.nightModeTimezone ?? '');
    const dateKey = this.formatDateKeyInTimeZone(now, timezone);
    const rows = await this.prisma.$queryRaw<
      Array<{
        expires_at: Date | string;
      }>
    >(Prisma.sql`
      UPDATE "chat_participant_moderation_immunities"
      SET
        "usage_date_key" = ${dateKey},
        "daily_violation_usage" = CASE
          WHEN "usage_date_key" = ${dateKey} THEN "daily_violation_usage" + 1
          ELSE 1
        END,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "chat_id" = ${params.chatId}
        AND "user_id" = ${params.userId}
        AND "expires_at" > ${now}
        AND CASE
          WHEN "usage_date_key" = ${dateKey} THEN "daily_violation_usage" < "daily_violation_limit"
          ELSE TRUE
        END
      RETURNING "expires_at"
    `);

    return rows.length > 0;
  }

  private getCurrentMinutesInTimeZone(timeZone: string, date = new Date()): number | null {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(date);

      const hour = Number(parts.find((item) => item.type === 'hour')?.value ?? '');
      const minute = Number(parts.find((item) => item.type === 'minute')?.value ?? '');

      if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
        return null;
      }

      return hour * 60 + minute;
    } catch {
      return null;
    }
  }

  private formatDateKeyInTimeZone(date: Date, timeZone: string): string {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date);
      const year = parts.find((item) => item.type === 'year')?.value;
      const month = parts.find((item) => item.type === 'month')?.value;
      const day = parts.find((item) => item.type === 'day')?.value;
      if (!year || !month || !day) {
        return date.toISOString().slice(0, 10);
      }

      return `${year}-${month}-${day}`;
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }

  private normalizeDayMinutes(value: number, fallback: number): number {
    return normalizeNightModeDayMinutes(value, fallback);
  }

  private formatMinutesAsTime(value: number): string {
    return formatNightModeMinutesAsTime(value);
  }

  private buildNightModeClosedNotice(
    startMinutes: number,
    endMinutes: number,
    timezone: string,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return buildNightModeClosedNoticeText({
      startMinutes,
      endMinutes,
      timezone,
      templateText,
      botSpeechStyle,
      activeBotSpeechProfile: this.resolveActiveBotSpeechProfile(),
    });
  }

  private buildNightModeOpenedNotice(
    startMinutes: number,
    endMinutes: number,
    timezone: string,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return buildNightModeOpenedNoticeText({
      startMinutes,
      endMinutes,
      timezone,
      templateText,
      botSpeechStyle,
      activeBotSpeechProfile: this.resolveActiveBotSpeechProfile(),
    });
  }

  private isServiceAuthoredMessage(update: MaxUpdate): boolean {
    for (const sender of this.extractSenderEntities(update)) {
      const type = this.readLowerString(sender.type) ?? this.readLowerString(sender.kind);
      if (type === 'service') {
        return true;
      }

      if (sender.is_service === true || sender.isService === true) {
        return true;
      }
    }

    return false;
  }

  private isBotAuthoredMessage(update: MaxUpdate): boolean {
    for (const sender of this.extractSenderEntities(update)) {
      if (this.isBotEntity(sender)) {
        return true;
      }
    }

    return false;
  }

  private extractSenderEntities(update: MaxUpdate): Array<Record<string, unknown>> {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return [];
    }

    const messageNode = extractRawMessageNode(raw);
    return [
      this.asRecord(messageNode?.sender),
      this.asRecord(messageNode?.from),
      this.asRecord(raw.sender),
      this.asRecord(raw.from),
    ].filter((item): item is Record<string, unknown> => item !== null);
  }

  private extractBotUserIdsFromServiceEvent(update: MaxUpdate): string[] {
    const memberRows = this.extractServiceMemberRows(update);
    const botUserIds = new Set<string>();

    for (const row of memberRows) {
      if (!this.isBotEntity(row)) {
        continue;
      }

      const userId = this.readUserIdFromEntity(row);
      if (userId) {
        botUserIds.add(userId);
      }
    }

    return [...botUserIds];
  }

  private extractServiceMemberUserIds(update: MaxUpdate): string[] {
    const memberRows = this.extractServiceMemberRows(update);
    const userIds = new Set<string>();

    for (const row of memberRows) {
      const userId = this.readUserIdFromEntity(row);
      if (userId) {
        userIds.add(userId);
      }
    }

    return [...userIds];
  }

  private extractServiceMemberRows(update: MaxUpdate): Array<Record<string, unknown>> {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return [];
    }

    const rows: Array<Record<string, unknown>> = [];
    const directMembershipEntity = this.extractDirectMembershipEntity(raw);
    if (directMembershipEntity) {
      rows.push(directMembershipEntity);
    }

    const messageNode = extractRawMessageNode(raw) ?? raw;
    this.collectServiceMemberRows(messageNode, rows);
    return rows;
  }

  private collectServiceMemberRows(node: unknown, acc: Array<Record<string, unknown>>, depth = 0) {
    if (depth > MAX_FORWARD_SCAN_DEPTH || node === null || node === undefined) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectServiceMemberRows(item, acc, depth + 1);
      }
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    const row = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(row)) {
      const keyLower = key.toLowerCase();
      if (this.isServiceMembersCollectionKey(keyLower)) {
        this.collectMemberEntities(value, acc, depth + 1);
        continue;
      }

      if (value && (typeof value === 'object' || Array.isArray(value))) {
        this.collectServiceMemberRows(value, acc, depth + 1);
      }
    }
  }

  private isServiceMembersCollectionKey(key: string): boolean {
    return (
      key === 'new_members' ||
      key === 'new_member' ||
      key === 'members_added' ||
      key === 'member_added' ||
      key === 'added_members' ||
      key === 'added_member' ||
      key === 'joined_members' ||
      key === 'joined_member' ||
      key === 'invited_members' ||
      key === 'invited_member' ||
      key === 'new_users' ||
      key === 'new_user'
    );
  }

  private extractDirectMembershipEntity(
    raw: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const updateType = this.readLowerString(raw.update_type) ?? this.readLowerString(raw.type);
    if (updateType !== 'user_added' && updateType !== 'bot_added') {
      return null;
    }

    const data = this.asRecord(raw.data);
    const event = this.asRecord(raw.event);
    const candidates = [
      raw,
      this.asRecord(raw[updateType]),
      data,
      data ? this.asRecord(data[updateType]) : null,
      event,
      event ? this.asRecord(event[updateType]) : null,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const userEntity = this.asRecord(candidate.user) ?? this.asRecord(candidate.member);
      if (userEntity && this.readUserIdFromEntity(userEntity)) {
        return userEntity;
      }
    }

    return null;
  }

  private collectMemberEntities(node: unknown, acc: Array<Record<string, unknown>>, depth = 0) {
    if (depth > MAX_FORWARD_SCAN_DEPTH || node === null || node === undefined) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectMemberEntities(item, acc, depth + 1);
      }
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    const row = node as Record<string, unknown>;
    if (this.readUserIdFromEntity(row)) {
      acc.push(row);
    }

    for (const value of Object.values(row)) {
      if (value && (typeof value === 'object' || Array.isArray(value))) {
        this.collectMemberEntities(value, acc, depth + 1);
      }
    }
  }

  private readUserIdFromEntity(node: Record<string, unknown>): string | null {
    const explicitCandidates = [node.user_id, node.userId, node.member_id, node.memberId];
    for (const value of explicitCandidates) {
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
      }
    }

    const idCandidate = node.id;
    if (
      (typeof idCandidate === 'string' || typeof idCandidate === 'number') &&
      this.looksLikeUserEntity(node)
    ) {
      return String(idCandidate);
    }

    return null;
  }

  private looksLikeUserEntity(node: Record<string, unknown>): boolean {
    return (
      node.type !== undefined ||
      node.kind !== undefined ||
      node.username !== undefined ||
      node.display_name !== undefined ||
      node.displayName !== undefined ||
      node.name !== undefined ||
      node.is_bot !== undefined ||
      node.isBot !== undefined ||
      node.bot !== undefined
    );
  }

  private isBotEntity(node: Record<string, unknown>): boolean {
    const type = this.readLowerString(node.type) ?? this.readLowerString(node.kind);
    if (type === 'bot') {
      return true;
    }

    return node.is_bot === true || node.isBot === true || node.bot === true;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private async handleChannelUpdate(
    update: MaxUpdate,
    managedChannel: ManagedChannelContext | null,
  ): Promise<void> {
    if (!managedChannel || update.type !== 'message_created' || !update.message) {
      return;
    }

    const { chatId, senderId, messageId, text } = update.message;
    if (!messageId) {
      return;
    }

    if (
      (senderId ? this.isOwnBotSender(senderId) : false) ||
      this.isBotAuthoredMessage(update) ||
      this.isServiceAuthoredMessage(update)
    ) {
      return;
    }

    const eventTimestampMs = this.resolveChannelAutoPostEventTimestampMs(update);

    if (senderId) {
      const mode = await this.resolveSystemModeSnapshot();
      const senderAdminCheck = await this.resolveSenderChatAdminCheck(
        chatId,
        managedChannel.adminUserIds,
        senderId,
        {
          allowRemoteLookup: mode.mode !== 'degrade',
          skipRemoteLookupWhenLocalAdminsKnown: true,
          remoteLookupSoftTimeoutMs: CHAT_ADMIN_NONCRITICAL_LOOKUP_SOFT_TIMEOUT_MS,
        },
      );
      if (!senderAdminCheck.isAdmin) {
        this.markChannelAutoPostWebhookSeen(chatId, messageId, eventTimestampMs);
        return;
      }
    }

    const raw = this.asRecord(update.raw);
    const rawMessage = raw ? (extractRawMessageNode(raw) ?? raw) : null;
    const messageText = this.resolveChannelAutoPostMessageText(
      rawMessage,
      typeof text === 'string' ? text : null,
    );

    const outcome = await this.tryAutoAttachChannelMessageButtons({
      chatId,
      messageId,
      text: messageText.text,
      textFormat: messageText.textFormat,
      linkType: this.extractChannelMessageLinkType(update),
      managedChannel,
      source: 'webhook',
      senderId,
    });
    if (outcome !== 'in_progress') {
      this.markChannelAutoPostWebhookSeen(chatId, messageId, eventTimestampMs);
    }
  }

  private async processChannelAutoPostButtons(): Promise<void> {
    if (this.channelAutoPostInFlight || !this.backgroundTasksEnabled) {
      return;
    }
    if (Date.now() < this.channelAutoPostBackoffUntilMs) {
      return;
    }
    if (this.channelAutoPostScanMaxChannels === 0) {
      return;
    }
    if (typeof this.prisma.channelSettings?.findMany !== 'function') {
      return;
    }

    const executionPlan = await this.resolveChannelAutoPostExecutionPlan();
    if (!executionPlan) {
      return;
    }

    this.channelAutoPostInFlight = true;
    try {
      let encounteredTransientThrottle = false;
      const channelCandidates = await this.prisma.channelSettings.findMany({
        where: {
          OR: [
            {
              autoPostButtonsMode: {
                in: ['COMMENTS', 'BOTH'],
              },
              commentsEnabled: true,
            },
            {
              autoPostButtonsMode: {
                in: ['SUGGEST', 'BOTH'],
              },
              postSuggestionsEnabled: true,
            },
          ],
        },
        select: {
          chatId: true,
        },
        orderBy: {
          updatedAt: 'desc',
        },
      });
      const scanBatchRefs = this.selectChannelAutoPostScanBatch(
        channelCandidates,
        executionPlan.batchSize,
      );
      if (scanBatchRefs.length === 0) {
        this.channelAutoPostThrottleStreak = 0;
        return;
      }

      const scanBatch = await this.loadChannelAutoPostScanContexts(
        scanBatchRefs.map((item) => item.chatId),
      );

      for (const [index, managedChannel] of scanBatch.entries()) {
        if (index > 0) {
          await this.sleep(executionPlan.interChannelDelayMs);
        }

        try {
          await this.processManagedChannelAutoPostButtons(managedChannel, {
            maxNewMessagesPerScan: executionPlan.maxNewMessagesPerScan,
          });
        } catch (error: unknown) {
          const accessLossHandled = await this.recordChannelAutoPostAccessLossIfTerminal({
            chatId: managedChannel.channelSettings.chatId,
            botId: null,
            source: 'channel_auto_post:scan',
            operation: 'read',
            error,
          });
          if (accessLossHandled) {
            break;
          }

          this.logger.warn(
            {
              chatId: managedChannel.channelSettings.chatId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed channel auto post buttons scan',
          );
          if (this.isTransientMaxApiLookupError(error)) {
            encounteredTransientThrottle = true;
            this.channelAutoPostThrottleStreak += 1;
            const backoffMs = this.resolveChannelAutoPostThrottleBackoffMs();
            this.channelAutoPostBackoffUntilMs = Date.now() + backoffMs;
            this.deferChannelAutoPostScan(managedChannel.channelSettings.chatId, backoffMs);
            break;
          }
        }
      }

      if (!encounteredTransientThrottle) {
        this.channelAutoPostThrottleStreak = 0;
      }
    } finally {
      this.channelAutoPostInFlight = false;
    }
  }

  private async loadChannelAutoPostScanContexts(
    chatIds: readonly string[],
  ): Promise<ManagedChannelContext[]> {
    const normalizedChatIds = Array.from(
      new Set(chatIds.map((chatId) => chatId.trim()).filter((chatId) => chatId.length > 0)),
    );
    if (normalizedChatIds.length === 0) {
      return [];
    }

    const channelSettings = await this.prisma.channelSettings.findMany({
      where: {
        chatId: {
          in: normalizedChatIds,
        },
      },
      include: {
        chat: {
          select: {
            admins: {
              select: {
                userId: true,
              },
            },
          },
        },
      },
    });
    const contextsByChatId = new Map(
      channelSettings.map((settings) => [
        settings.chatId,
        {
          channelSettings: settings,
          adminUserIds: settings.chat.admins.map((item) => item.userId),
        } satisfies ManagedChannelContext,
      ]),
    );

    return normalizedChatIds.flatMap((chatId) => {
      const context = contextsByChatId.get(chatId);
      return context ? [context] : [];
    });
  }

  private async processManagedChannelAutoPostButtons(
    managedChannel: ManagedChannelContext,
    options: {
      maxNewMessagesPerScan?: number;
    } = {},
  ): Promise<void> {
    const maxNewMessagesPerScan = Math.max(
      1,
      options.maxNewMessagesPerScan ?? this.channelAutoPostMaxNewMessagesPerScan,
    );
    const chatId = managedChannel.channelSettings.chatId;
    const existingScanState = this.channelAutoPostScanState.get(chatId) ?? null;
    if (existingScanState && Date.now() < existingScanState.nextScanAtMs) {
      return;
    }

    const scanBotId =
      (
        await this.resolveUnifiedBotRoute({
          purpose: 'capability',
          chatId,
          capability: 'background_scans',
          fallbackToPrimary: true,
        })
      )?.botId ??
      (await this.maxBotLinkService?.resolveBotIdForCapability?.({
        chatId,
        capability: 'background_scans',
      })) ??
      undefined;
    let messages: Awaited<ReturnType<MaxClientService['listMessages']>>;
    try {
      messages = await this.maxClient.listMessages(chatId, {
        count: 10,
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
        ...(scanBotId ? { botId: scanBotId } : {}),
      });
    } catch (error: unknown) {
      if (
        await this.recordChannelAutoPostAccessLossIfTerminal({
          chatId,
          botId: scanBotId ?? null,
          source: 'channel_auto_post:scan',
          operation: 'read',
          error,
        })
      ) {
        return;
      }
      throw error;
    }
    const normalizedMessages = messages
      .map((message) => this.parseChannelListedMessage(message))
      .filter(
        (item): item is NonNullable<ReturnType<typeof this.parseChannelListedMessage>> =>
          item !== null,
      )
      .sort(
        (left, right) =>
          left.timestampMs - right.timestampMs || left.messageId.localeCompare(right.messageId),
      );
    let scanState = existingScanState;
    let sawNewMessages = false;
    let autoAttachAttempts = 0;

    for (const normalized of normalizedMessages) {
      if (!this.isChannelAutoPostScanMessageNew(scanState, normalized)) {
        continue;
      }
      sawNewMessages = true;
      if (normalized.senderId && !managedChannel.adminUserIds.includes(normalized.senderId)) {
        scanState = this.advanceChannelAutoPostScanState(scanState, normalized);
        this.channelAutoPostScanState.set(chatId, scanState);
        continue;
      }
      if (normalized.timestampMs < managedChannel.channelSettings.updatedAt.getTime()) {
        scanState = this.advanceChannelAutoPostScanState(scanState, normalized);
        this.channelAutoPostScanState.set(chatId, scanState);
        continue;
      }
      if (normalized.hasInlineKeyboard) {
        scanState = this.advanceChannelAutoPostScanState(scanState, normalized);
        this.channelAutoPostScanState.set(chatId, scanState);
        continue;
      }
      if (autoAttachAttempts >= maxNewMessagesPerScan) {
        break;
      }

      const outcome = await this.tryAutoAttachChannelMessageButtons({
        chatId,
        messageId: normalized.messageId,
        text: normalized.text,
        textFormat: normalized.textFormat,
        linkType: normalized.linkType,
        managedChannel,
        source: 'poll',
        senderId: null,
      });
      autoAttachAttempts += 1;
      if (outcome === 'in_progress') {
        break;
      }
      scanState = this.advanceChannelAutoPostScanState(scanState, normalized);
      this.channelAutoPostScanState.set(chatId, scanState);
    }

    this.channelAutoPostScanState.set(
      chatId,
      this.scheduleChannelAutoPostScanState(scanState, sawNewMessages),
    );
  }

  private async resolveChannelAutoPostExecutionPlan(): Promise<ChannelAutoPostExecutionPlan | null> {
    const basePlan: ChannelAutoPostExecutionPlan = {
      batchSize: this.resolveChannelAutoPostScanBatchSize(),
      interChannelDelayMs: this.channelAutoPostInterChannelDelayMs,
      maxNewMessagesPerScan: this.channelAutoPostMaxNewMessagesPerScan,
    };

    if (this.backgroundRuntimeGovernorService) {
      const decision = await this.backgroundRuntimeGovernorService.decide({
        component: 'moderation',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
        allowQueueLagSlowPathBelowSec: this.backgroundWorkSoftPauseQueueLagSec,
      });
      if (decision.action === 'run') {
        return basePlan;
      }

      const now = Date.now();
      if (decision.action === 'slow') {
        if (now - this.channelAutoPostPausedLogAtMs >= BACKGROUND_WORK_PAUSE_LOG_INTERVAL_MS) {
          this.channelAutoPostPausedLogAtMs = now;
          this.logger.log(
            {
              task: 'channel-auto-post-buttons',
              action: decision.action,
              reason: decision.reason,
              retryAfterMs: decision.retryAfterMs,
              batchSize: Math.max(
                1,
                Math.ceil(basePlan.batchSize / CHANNEL_AUTO_POST_SLOW_BATCH_DIVISOR),
              ),
              maxNewMessagesPerScan: Math.max(
                1,
                Math.min(
                  basePlan.maxNewMessagesPerScan,
                  CHANNEL_AUTO_POST_SLOW_MAX_NEW_MESSAGES_PER_SCAN,
                ),
              ),
            },
            'Throttled moderation background work because the runtime governor detected pressure',
          );
        }

        return {
          batchSize: Math.max(
            1,
            Math.ceil(basePlan.batchSize / CHANNEL_AUTO_POST_SLOW_BATCH_DIVISOR),
          ),
          interChannelDelayMs: Math.max(
            basePlan.interChannelDelayMs,
            CHANNEL_AUTO_POST_SLOW_INTER_CHANNEL_DELAY_MS,
          ),
          maxNewMessagesPerScan: Math.max(
            1,
            Math.min(
              basePlan.maxNewMessagesPerScan,
              CHANNEL_AUTO_POST_SLOW_MAX_NEW_MESSAGES_PER_SCAN,
            ),
          ),
        };
      }

      if (now - this.channelAutoPostPausedLogAtMs >= BACKGROUND_WORK_PAUSE_LOG_INTERVAL_MS) {
        this.channelAutoPostPausedLogAtMs = now;
        this.logger.log(
          {
            task: 'channel-auto-post-buttons',
            action: decision.action,
            reason: decision.reason,
            retryAfterMs: decision.retryAfterMs,
          },
          'Paused moderation background work because the runtime governor detected pressure',
        );
      }
      this.channelAutoPostBackoffUntilMs = Math.max(
        this.channelAutoPostBackoffUntilMs,
        now + decision.retryAfterMs,
      );
      return null;
    }

    const mode = await this.resolveSystemModeSnapshot();
    let pauseReason: string | null = null;
    if (mode.mode !== 'degrade' || isSystemModeRecoveryWindow(mode)) {
      pauseReason = await this.resolveBackgroundPressurePauseReason();
      if (!pauseReason) {
        return basePlan;
      }
    } else {
      pauseReason = mode.reason;
    }

    const now = Date.now();
    if (now - this.channelAutoPostPausedLogAtMs >= BACKGROUND_WORK_PAUSE_LOG_INTERVAL_MS) {
      this.channelAutoPostPausedLogAtMs = now;
      this.logger.log(
        {
          task: 'channel-auto-post-buttons',
          mode: mode.mode,
          source: mode.source,
          reason: pauseReason,
        },
        'Paused moderation background work because the system is under pressure',
      );
    }

    return null;
  }

  private parseChannelListedMessage(message: Record<string, unknown>): {
    messageId: string;
    text: string | null;
    textFormat: MaxSendMessageOptions['textFormat'] | null;
    linkType: string | null;
    timestampMs: number;
    hasInlineKeyboard: boolean;
    senderId: string | null;
  } | null {
    const body = this.asRecord(message.body);
    const link = this.asRecord(message.link);
    const messageIdCandidate =
      body?.mid ??
      body?.seq ??
      message.message_id ??
      message.messageId ??
      message.mid ??
      message.seq ??
      message.id;
    const timestampCandidate = message.timestamp ?? message.created_at ?? message.createdAt;
    if (
      (typeof messageIdCandidate !== 'string' && typeof messageIdCandidate !== 'number') ||
      (typeof timestampCandidate !== 'number' && typeof timestampCandidate !== 'string')
    ) {
      return null;
    }

    const timestampMs =
      typeof timestampCandidate === 'number' ? timestampCandidate : Number(timestampCandidate);
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
      return null;
    }

    const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
    const hasInlineKeyboard = attachments.some((attachment) => {
      const row = this.asRecord(attachment);
      return this.readLowerString(row?.type) === 'inline_keyboard';
    });
    const messageText = this.resolveChannelAutoPostMessageText(message, null);

    return {
      messageId: String(messageIdCandidate),
      text: messageText.text,
      textFormat: messageText.textFormat,
      linkType: this.readLowerString(link?.type),
      timestampMs,
      hasInlineKeyboard,
      senderId: (() => {
        const senderId = this.asRecord(message.sender)?.user_id ?? message.sender_id;
        return typeof senderId === 'string' && senderId.trim() ? senderId.trim() : null;
      })(),
    };
  }

  private resolveChannelAutoPostMessageText(
    message: Record<string, unknown> | null,
    fallbackText: string | null,
  ): ChannelAutoPostMessageText {
    const source = this.resolveChannelAutoPostMessageTextSource(message, fallbackText);
    if (typeof source.text !== 'string' || source.text.trim().length === 0) {
      return {
        text: null,
        textFormat: null,
      };
    }

    if (source.markup.length > 0) {
      const html = renderMaxTextMarkupAsHtml(source.text, source.markup);
      if (html && html !== source.text) {
        return {
          text: html,
          textFormat: 'html',
        };
      }
    }

    return {
      text: source.text,
      textFormat: source.textFormat,
    };
  }

  private resolveChannelAutoPostMessageTextSource(
    message: Record<string, unknown> | null,
    fallbackText: string | null,
  ): {
    text: string | null;
    markup: MaxTextMarkup[];
    textFormat: MaxSendMessageOptions['textFormat'] | null;
  } {
    const direct = this.extractChannelAutoPostMessageTextSource(message);
    if (typeof direct.text === 'string' && direct.text.trim().length > 0) {
      return direct;
    }

    const linked = this.extractForwardedChannelAutoPostMessageTextSource(message);
    if (typeof linked.text === 'string' && linked.text.trim().length > 0) {
      return linked;
    }

    return {
      text:
        typeof fallbackText === 'string' && fallbackText.trim().length > 0 ? fallbackText : null,
      markup: [],
      textFormat: null,
    };
  }

  private extractForwardedChannelAutoPostMessageTextSource(
    message: Record<string, unknown> | null,
  ): {
    text: string | null;
    markup: MaxTextMarkup[];
    textFormat: MaxSendMessageOptions['textFormat'] | null;
  } {
    const link = this.asRecord(message?.link);
    if (this.readLowerString(link?.type) !== 'forward') {
      return {
        text: null,
        markup: [],
        textFormat: null,
      };
    }

    return this.extractChannelAutoPostMessageTextSource(this.asRecord(link?.message));
  }

  private extractChannelAutoPostMessageTextSource(message: Record<string, unknown> | null): {
    text: string | null;
    markup: MaxTextMarkup[];
    textFormat: MaxSendMessageOptions['textFormat'] | null;
  } {
    const body = this.asRecord(message?.body);
    const textCandidates = [body?.text, message?.text, message?.caption];
    const text =
      textCandidates.find(
        (candidate): candidate is string =>
          typeof candidate === 'string' && candidate.trim().length > 0,
      ) ?? null;

    return {
      text,
      markup: this.extractChannelAutoPostMessageMarkup(message),
      textFormat: this.extractChannelAutoPostMessageTextFormat(message),
    };
  }

  private extractChannelAutoPostMessageTextFormat(
    message: Record<string, unknown> | null,
  ): MaxSendMessageOptions['textFormat'] | null {
    const body = this.asRecord(message?.body);
    const format = this.readLowerString(body?.format ?? message?.format);
    return format === 'markdown' || format === 'html' ? format : null;
  }

  private extractChannelAutoPostMessageMarkup(
    message: Record<string, unknown> | null,
  ): MaxTextMarkup[] {
    const body = this.asRecord(message?.body);
    const candidates = [
      body?.markup,
      body?.text_markup,
      body?.textMarkup,
      body?.caption_markup,
      body?.captionMarkup,
      message?.markup,
      message?.text_markup,
      message?.textMarkup,
      message?.caption_markup,
      message?.captionMarkup,
    ];

    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) {
        continue;
      }

      const markup = candidate
        .map((item) => this.normalizeChannelAutoPostMessageMarkup(item))
        .filter((item): item is MaxTextMarkup => item !== null);
      if (markup.length > 0) {
        return markup;
      }
    }

    return [];
  }

  private normalizeChannelAutoPostMessageMarkup(value: unknown): MaxTextMarkup | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const type = this.readLowerString(row.type);
    const from = this.readInteger(row.from);
    const length = this.readInteger(row.length);

    if (
      !type ||
      from === null ||
      length === null ||
      from < 0 ||
      length <= 0 ||
      ![
        'emphasized',
        'heading',
        'link',
        'monospaced',
        'strikethrough',
        'strong',
        'underline',
        'user_mention',
      ].includes(type)
    ) {
      return null;
    }

    return {
      from,
      length,
      type: type as MaxTextMarkup['type'],
      url: this.readString(row.url),
      userLink: this.readString(row.user_link ?? row.userLink),
    };
  }

  private readInteger(value: unknown): number | null {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    return Number.isInteger(parsed) ? parsed : null;
  }

  private resolveChannelAutoPostEventTimestampMs(update: MaxUpdate): number {
    const raw = this.asRecord(update.raw);
    const rawMessage = this.asRecord(raw?.message);
    const candidates: unknown[] = [
      update.message?.createdAt,
      rawMessage?.timestamp,
      rawMessage?.created_at,
      rawMessage?.createdAt,
      raw?.timestamp,
      raw?.created_at,
      raw?.createdAt,
    ];

    for (const candidate of candidates) {
      const timestampMs =
        typeof candidate === 'number'
          ? candidate
          : typeof candidate === 'string' && candidate.trim().length > 0
            ? Date.parse(candidate)
            : Number.NaN;
      if (Number.isFinite(timestampMs) && timestampMs > 0) {
        return Math.trunc(timestampMs);
      }
    }

    return Date.now();
  }

  private markChannelAutoPostWebhookSeen(
    chatId: string,
    messageId: string,
    timestampMs: number,
  ): void {
    const current =
      this.channelAutoPostScanState.get(chatId) ?? this.createChannelAutoPostScanState();
    const nextState =
      Number.isFinite(timestampMs) && timestampMs > 0
        ? this.advanceChannelAutoPostScanState(current, { messageId, timestampMs })
        : current;

    this.channelAutoPostScanState.set(chatId, {
      ...nextState,
      idleStreak: 0,
      nextScanAtMs: Math.max(
        nextState.nextScanAtMs,
        Date.now() + this.channelAutoPostRepairSweepMs,
      ),
    });
  }

  private async tryAutoAttachChannelMessageButtons(params: {
    chatId: string;
    messageId: string;
    text: string | null;
    textFormat?: MaxSendMessageOptions['textFormat'] | null;
    linkType: string | null;
    managedChannel: ManagedChannelContext;
    source: 'webhook' | 'poll';
    senderId: string | null;
  }): Promise<ChannelAutoPostAttachOutcome> {
    const { chatId, messageId, text, textFormat, linkType, managedChannel, source, senderId } =
      params;
    const autoAttachBotId = await this.resolveAutoAttachBotId(chatId, source);
    const mutationRequestOptions =
      source === 'poll'
        ? ({
            trafficClass: 'background',
            actionHealthLane: 'background',
            sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
            ...(autoAttachBotId ? { botId: autoAttachBotId } : {}),
          } as const)
        : autoAttachBotId
          ? ({ botId: autoAttachBotId } as const)
          : undefined;
    const { includeCommentsButton, includeSuggestButton } = this.resolveChannelAutoPostButtons(
      managedChannel.channelSettings,
    );
    if (!includeCommentsButton && !includeSuggestButton) {
      return 'noop';
    }

    const claim = await this.claimChannelAutoPostAttachMarker({
      chatId,
      messageId,
      source,
      botId: autoAttachBotId,
      linkType,
    });
    if (claim.status === 'done') {
      return 'skipped';
    }
    if (claim.status === 'in_progress') {
      return 'in_progress';
    }
    if (claim.status !== 'claimed') {
      return 'skipped';
    }

    const threadId = randomUUID();
    const buttons = this.buildChannelAutoPostButtons(
      chatId,
      threadId,
      managedChannel.channelSettings,
      includeCommentsButton,
      includeSuggestButton,
      autoAttachBotId,
    );
    if (buttons.length === 0) {
      await this.completeChannelAutoPostAttachMarker({
        chatId,
        messageId,
        lockToken: claim.lockToken,
        status: CHANNEL_AUTO_POST_ATTACH_STATUS.SKIPPED,
        source,
        botId: autoAttachBotId,
        linkType,
        deliveryMode: null,
        lastError: 'No channel auto-post buttons to attach.',
        lastStatusCode: null,
      });
      return 'noop';
    }

    let deliveryMode: 'edit_message' | 'reply_message' | 'replace_with_bot_message' =
      'edit_message';
    let replacementMessageId: string | null = null;
    const replyMessageId: string | null = null;
    let publishedUrl: string | null =
      linkType === 'forward' ? null : this.buildMaxMessageFallbackUrl(chatId, messageId);
    let originalDeleted = false;

    try {
      if (linkType === 'forward') {
        const sent = await this.maxClient.sendMessageCopyWithInlineKeyboard(
          chatId,
          messageId,
          text,
          {
            buttons,
            ...(textFormat ? { textFormat } : {}),
            debugContext: {
              screen: 'channel-auto-post',
              action:
                source === 'poll'
                  ? 'scan-replace-forward-with-bot-copy'
                  : 'replace-forward-with-bot-copy',
            },
          },
          mutationRequestOptions,
        );
        replacementMessageId = sent.messageId;
        publishedUrl = sent.url ?? this.buildMaxMessageFallbackUrl(chatId, sent.messageId);
        deliveryMode = 'replace_with_bot_message';

        try {
          await this.maxClient.deleteMessage(chatId, messageId, {
            immediate: true,
            ...(mutationRequestOptions ?? {}),
          });
          originalDeleted = true;
        } catch (deleteError: unknown) {
          this.logger.warn(
            {
              chatId,
              messageId,
              status: this.extractStatusCode(deleteError),
              error: deleteError instanceof Error ? deleteError.message : 'Unknown error',
              replacementMessageId,
            },
            'Failed to delete original forwarded channel post after bot copy publish',
          );
        }
      } else {
        await this.maxClient.editMessageInlineKeyboard(
          chatId,
          messageId,
          text,
          {
            buttons,
            ...(textFormat ? { textFormat } : {}),
            debugContext: {
              screen: 'channel-auto-post',
              action: source === 'poll' ? 'scan-attach-buttons' : 'attach-buttons',
            },
          },
          mutationRequestOptions,
        );
      }
    } catch (error: unknown) {
      const status = this.extractStatusCode(error);
      if (
        source === 'poll' &&
        (await this.recordChannelAutoPostAccessLossIfTerminal({
          chatId,
          botId: autoAttachBotId,
          source: 'channel_auto_post:poll_attach',
          operation: linkType === 'forward' ? 'send' : 'edit',
          error,
        }))
      ) {
        await this.completeChannelAutoPostAttachMarker({
          chatId,
          messageId,
          lockToken: claim.lockToken,
          status: CHANNEL_AUTO_POST_ATTACH_STATUS.SKIPPED,
          source,
          botId: autoAttachBotId,
          linkType,
          deliveryMode: linkType === 'forward' ? 'replace_with_bot_message' : 'edit_message',
          lastError: this.extractErrorSummary(error),
          lastStatusCode: status,
        });
        return 'skipped';
      }
      if (status && status < 500 && status !== 429) {
        this.logger.warn(
          {
            chatId,
            messageId,
            status,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          linkType === 'forward'
            ? 'Failed to replace forwarded channel post with bot copy; skipping reply fallback'
            : 'Failed to auto-attach channel post buttons; skipping retry',
        );
        if (linkType !== 'forward') {
          await this.recordChannelAutoPostTerminalSkip({
            chatId,
            messageId,
            senderId,
            botId: autoAttachBotId,
            linkType,
            source,
            deliveryMode: 'edit_message',
            status,
            error,
          });
          await this.completeChannelAutoPostAttachMarker({
            chatId,
            messageId,
            lockToken: claim.lockToken,
            status: CHANNEL_AUTO_POST_ATTACH_STATUS.SKIPPED,
            source,
            botId: autoAttachBotId,
            linkType,
            deliveryMode: 'edit_message',
            lastError: this.extractErrorSummary(error),
            lastStatusCode: status,
          });
          return 'skipped';
        }

        await this.recordChannelAutoPostTerminalSkip({
          chatId,
          messageId,
          senderId,
          botId: autoAttachBotId,
          linkType,
          source,
          deliveryMode: 'replace_with_bot_message',
          status,
          error,
        });
        await this.completeChannelAutoPostAttachMarker({
          chatId,
          messageId,
          lockToken: claim.lockToken,
          status: CHANNEL_AUTO_POST_ATTACH_STATUS.SKIPPED,
          source,
          botId: autoAttachBotId,
          linkType,
          deliveryMode: 'replace_with_bot_message',
          lastError: this.extractErrorSummary(error),
          lastStatusCode: status,
        });
        return 'skipped';
      }
      await this.releaseChannelAutoPostAttachMarker({
        chatId,
        messageId,
        lockToken: claim.lockToken,
        source,
        botId: autoAttachBotId,
        linkType,
        lastError: this.extractErrorSummary(error),
        lastStatusCode: status,
      });
      throw error;
    }

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: senderId ?? 'system',
        action: CHANNEL_DIALOG_AUTO_ATTACH_ACTION,
        payload: {
          messageId,
          threadId,
          includeCommentsButton,
          includeSuggestButton,
          autoPostButtonsMode: this.deriveChannelAutoPostButtonsMode(
            managedChannel.channelSettings,
          ),
          suggestionEntryMode: managedChannel.channelSettings.postSuggestionsEntryMode,
          deliveryMode,
          linkType,
          replacementMessageId,
          ...(publishedUrl ? { publishedUrl } : {}),
          ...(replyMessageId ? { replyMessageId } : {}),
          ...(text?.trim() ? { text } : {}),
          originalDeleted,
          source,
          ...(autoAttachBotId ? { botId: autoAttachBotId } : {}),
        },
      },
    });
    await this.completeChannelAutoPostAttachMarker({
      chatId,
      messageId,
      lockToken: claim.lockToken,
      status: CHANNEL_AUTO_POST_ATTACH_STATUS.SUCCEEDED,
      source,
      botId: autoAttachBotId,
      linkType,
      deliveryMode,
      replacementMessageId,
      publishedUrl,
      lastError: null,
      lastStatusCode: null,
    });
    return 'attached';
  }

  private buildMaxMessageFallbackUrl(chatId: string, messageId: string | null): string | null {
    const normalizedChatId = chatId.trim();
    const normalizedMessageId = messageId?.trim() ?? '';
    if (!normalizedChatId || !normalizedMessageId) {
      return null;
    }

    return `https://max.ru/chats/${encodeURIComponent(normalizedChatId)}/message/${encodeURIComponent(
      normalizedMessageId,
    )}`;
  }

  private getChannelAutoPostAttachMarkerDelegate(): {
    findUnique?: (args: unknown) => Promise<{
      status: ChannelAutoPostAttachStatus;
      lockedAt: Date | null;
    } | null>;
    create?: (args: unknown) => Promise<unknown>;
    update?: (args: unknown) => Promise<unknown>;
    updateMany?: (args: unknown) => Promise<{ count: number }>;
  } | null {
    return (
      (this.prisma as unknown as {
        channelAutoPostAttachMarker?: {
          findUnique?: (args: unknown) => Promise<{
            status: ChannelAutoPostAttachStatus;
            lockedAt: Date | null;
          } | null>;
          create?: (args: unknown) => Promise<unknown>;
          update?: (args: unknown) => Promise<unknown>;
          updateMany?: (args: unknown) => Promise<{ count: number }>;
        };
      }).channelAutoPostAttachMarker ?? null
    );
  }

  private async claimChannelAutoPostAttachMarker(params: {
    chatId: string;
    messageId: string;
    source: 'webhook' | 'poll';
    botId: string | null;
    linkType: string | null;
  }): Promise<ChannelAutoPostAttachClaim> {
    if (await this.hasCompletedChannelAutoPostAttachMarker(params.chatId, params.messageId)) {
      return { status: 'done' };
    }

    const delegate = this.getChannelAutoPostAttachMarkerDelegate();
    const lockToken = randomUUID();
    const now = new Date();
    if (!delegate?.findUnique || !delegate.create || !delegate.updateMany) {
      return { status: 'claimed', lockToken };
    }

    const existing = await delegate.findUnique({
      where: {
        chatId_messageId: {
          chatId: params.chatId,
          messageId: params.messageId,
        },
      },
      select: {
        status: true,
        lockedAt: true,
      },
    });

    if (
      existing?.status === CHANNEL_AUTO_POST_ATTACH_STATUS.SUCCEEDED ||
      existing?.status === CHANNEL_AUTO_POST_ATTACH_STATUS.SKIPPED
    ) {
      return { status: 'done' };
    }

    if (!existing) {
      try {
        await delegate.create({
          data: {
            chatId: params.chatId,
            messageId: params.messageId,
            status: CHANNEL_AUTO_POST_ATTACH_STATUS.IN_PROGRESS,
            lockToken,
            lockedAt: now,
            source: params.source,
            botId: params.botId,
            linkType: params.linkType,
          },
        });
        return { status: 'claimed', lockToken };
      } catch (error: unknown) {
        if (!this.isPrismaKnownError(error, 'P2002')) {
          throw error;
        }
      }
    }

    const staleLockedBefore = new Date(Date.now() - CHANNEL_AUTO_POST_ATTACH_LOCK_TTL_MS);
    const claimed = await delegate.updateMany({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        status: CHANNEL_AUTO_POST_ATTACH_STATUS.IN_PROGRESS,
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockedBefore } }],
      },
      data: {
        lockToken,
        lockedAt: now,
        source: params.source,
        botId: params.botId,
        linkType: params.linkType,
      },
    });

    return claimed.count > 0 ? { status: 'claimed', lockToken } : { status: 'in_progress' };
  }

  private async hasCompletedChannelAutoPostAttachMarker(
    chatId: string,
    messageId: string,
  ): Promise<boolean> {
    const delegate = this.getChannelAutoPostAttachMarkerDelegate();
    if (delegate?.findUnique) {
      const marker = await delegate.findUnique({
        where: {
          chatId_messageId: {
            chatId,
            messageId,
          },
        },
        select: {
          status: true,
          lockedAt: true,
        },
      });
      if (
        marker?.status === CHANNEL_AUTO_POST_ATTACH_STATUS.SUCCEEDED ||
        marker?.status === CHANNEL_AUTO_POST_ATTACH_STATUS.SKIPPED
      ) {
        return true;
      }
    }

    const alreadyAttached = await this.prisma.auditLog.findFirst({
      where: {
        chatId,
        action: {
          in: [CHANNEL_DIALOG_AUTO_ATTACH_ACTION, CHANNEL_DIALOG_AUTO_ATTACH_SKIP_ACTION],
        },
        payload: {
          path: ['messageId'],
          equals: messageId,
        },
      },
      select: {
        id: true,
      },
    });
    return Boolean(alreadyAttached);
  }

  private async completeChannelAutoPostAttachMarker(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    status:
      | typeof CHANNEL_AUTO_POST_ATTACH_STATUS.SUCCEEDED
      | typeof CHANNEL_AUTO_POST_ATTACH_STATUS.SKIPPED;
    source: 'webhook' | 'poll';
    botId: string | null;
    linkType: string | null;
    deliveryMode: string | null;
    replacementMessageId?: string | null;
    publishedUrl?: string | null;
    lastError: string | null;
    lastStatusCode: number | null;
  }): Promise<void> {
    const delegate = this.getChannelAutoPostAttachMarkerDelegate();
    if (!delegate?.updateMany) {
      return;
    }

    await delegate.updateMany({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        lockToken: params.lockToken,
        status: CHANNEL_AUTO_POST_ATTACH_STATUS.IN_PROGRESS,
      },
      data: {
        status: params.status,
        lockToken: null,
        lockedAt: null,
        source: params.source,
        botId: params.botId,
        linkType: params.linkType,
        deliveryMode: params.deliveryMode,
        replacementMessageId: params.replacementMessageId ?? null,
        publishedUrl: params.publishedUrl ?? null,
        lastError: params.lastError,
        lastStatusCode: params.lastStatusCode,
      },
    });
  }

  private async releaseChannelAutoPostAttachMarker(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    source: 'webhook' | 'poll';
    botId: string | null;
    linkType: string | null;
    lastError: string | null;
    lastStatusCode: number | null;
  }): Promise<void> {
    const delegate = this.getChannelAutoPostAttachMarkerDelegate();
    if (!delegate?.updateMany) {
      return;
    }

    await delegate.updateMany({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        lockToken: params.lockToken,
        status: CHANNEL_AUTO_POST_ATTACH_STATUS.IN_PROGRESS,
      },
      data: {
        lockToken: null,
        lockedAt: null,
        source: params.source,
        botId: params.botId,
        linkType: params.linkType,
        lastError: params.lastError,
        lastStatusCode: params.lastStatusCode,
      },
    });
  }

  private async recordChannelAutoPostTerminalSkip(params: {
    chatId: string;
    messageId: string;
    senderId: string | null;
    botId: string | null;
    linkType: string | null;
    source: 'webhook' | 'poll';
    deliveryMode: 'edit_message' | 'reply_message' | 'replace_with_bot_message';
    status: number | null;
    error: unknown;
  }): Promise<void> {
    try {
      const errorRecord = this.asRecord(params.error);
      const errorMessage =
        typeof errorRecord?.message === 'string' && errorRecord.message.trim().length > 0
          ? errorRecord.message.trim()
          : params.error instanceof Error
            ? params.error.message
            : String(params.error ?? '');
      await this.prisma.auditLog.create({
        data: {
          chatId: params.chatId,
          actorUserId: params.senderId ?? 'system',
          action: CHANNEL_DIALOG_AUTO_ATTACH_SKIP_ACTION,
          payload: {
            messageId: params.messageId,
            reason: 'terminal_delivery_failure',
            linkType: params.linkType,
            source: params.source,
            deliveryMode: params.deliveryMode,
            ...(params.botId ? { botId: params.botId } : {}),
            status: params.status,
            error: errorMessage,
          },
        },
      });
    } catch (skipError: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          messageId: params.messageId,
          error: skipError instanceof Error ? skipError.message : 'Unknown error',
        },
        'Failed to persist channel auto-post terminal skip marker',
      );
    }
  }

  private async loadManagedChannelContext(
    chatId: string,
    chatTitle?: string,
  ): Promise<ManagedChannelContext | null> {
    if (typeof this.prisma.chat.findUnique !== 'function') {
      return null;
    }

    let channel = await this.prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        channelSettings: true,
        admins: {
          select: {
            userId: true,
          },
        },
      },
    });

    if (!channel || channel.entityType !== ChatEntityType.CHANNEL) {
      return null;
    }

    if (!channel.channelSettings || (chatTitle?.trim() && channel.title !== chatTitle.trim())) {
      if (typeof this.prisma.chat.update !== 'function') {
        return channel.channelSettings
          ? {
              channelSettings: channel.channelSettings,
              adminUserIds: channel.admins.map((item) => item.userId),
            }
          : null;
      }

      channel = await this.prisma.chat.update({
        where: { id: chatId },
        data: {
          ...(chatTitle?.trim()
            ? {
                title: chatTitle.trim(),
              }
            : {}),
          channelSettings: {
            upsert: {
              update: {},
              create: {
                commentsEnabled: false,
              },
            },
          },
        },
        include: {
          channelSettings: true,
          admins: {
            select: {
              userId: true,
            },
          },
        },
      });
    }

    if (!channel.channelSettings) {
      return null;
    }

    return {
      channelSettings: channel.channelSettings,
      adminUserIds: channel.admins.map((item) => item.userId),
    };
  }

  private isChannelMessage(update: MaxUpdate): boolean {
    if (update.message?.entityType === 'channel') {
      return true;
    }

    const raw = this.asRecord(update.raw);
    const message = this.asRecord(raw?.message);
    const recipient = this.asRecord(message?.recipient);
    const chat = this.asRecord(message?.chat);

    const candidates = [
      recipient?.chat_type,
      recipient?.chatType,
      chat?.chat_type,
      chat?.chatType,
      raw?.chat_type,
      raw?.chatType,
    ];

    return candidates.some((candidate) => this.readLowerString(candidate) === 'channel');
  }

  private extractChannelMessageLinkType(update: MaxUpdate): string | null {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return null;
    }

    const message = extractRawMessageNode(raw) ?? raw;
    const link = this.asRecord(message.link);
    return this.readLowerString(link?.type);
  }

  private resolveChannelAutoPostButtons(
    settings: Pick<
      PersistedChannelSettings,
      'autoPostButtonsMode' | 'postSuggestionsEnabled' | 'commentsEnabled'
    >,
  ) {
    const mode = settings.autoPostButtonsMode ?? 'OFF';
    const includeComments = (mode === 'COMMENTS' || mode === 'BOTH') && settings.commentsEnabled;
    const includeSuggest =
      (mode === 'SUGGEST' || mode === 'BOTH') && settings.postSuggestionsEnabled;

    return {
      includeCommentsButton: includeComments,
      includeSuggestButton: includeSuggest,
    };
  }

  private deriveChannelAutoPostButtonsMode(
    settings: Pick<PersistedChannelSettings, 'commentsEnabled' | 'postSuggestionsEnabled'>,
  ): PersistedChannelSettings['autoPostButtonsMode'] {
    if (settings.commentsEnabled && settings.postSuggestionsEnabled) {
      return 'BOTH';
    }
    if (settings.commentsEnabled) {
      return 'COMMENTS';
    }
    if (settings.postSuggestionsEnabled) {
      return 'SUGGEST';
    }
    return 'OFF';
  }

  private buildChannelAutoPostButtons(
    chatId: string,
    threadId: string,
    settings: PersistedChannelSettings,
    includeCommentsButton: boolean,
    includeSuggestButton: boolean,
    botId?: string | null,
  ): MaxMessageButton[][] {
    const rows: MaxMessageButton[][] = [];

    if (includeCommentsButton) {
      rows.push([
        this.buildChannelDialogButton(
          chatId,
          'comments',
          threadId,
          formatCommentsButtonText('💬 Комментарии', 0),
          botId,
        ),
      ]);
    }

    if (includeSuggestButton) {
      rows.push([
        this.buildChannelDialogButton(
          chatId,
          'suggest',
          threadId,
          settings.postSuggestionsButtonText.trim() || '📰 Предложить пост',
          botId,
          settings.postSuggestionsEntryMode,
        ),
      ]);
    }

    return rows;
  }

  private shouldAutoAttachChatCommentsButton(
    settings: Pick<ChatSettings, 'commentsEnabled' | 'commentsAdminsEnabled'>,
    isSenderAdmin: boolean,
  ): boolean {
    if (!settings.commentsEnabled) {
      return false;
    }

    return isSenderAdmin && settings.commentsAdminsEnabled;
  }

  private async tryAutoAttachChatMessageComments(params: {
    chatId: string;
    messageId: string;
    text: string | null;
    senderId: string;
    senderIsAdmin: boolean;
    update: MaxUpdate;
  }): Promise<void> {
    const { chatId, messageId, text, senderId, senderIsAdmin, update } = params;
    const autoAttachBotId = await this.resolveAutoAttachBotId(chatId, 'webhook');
    const mutationRequestOptions = autoAttachBotId ? { botId: autoAttachBotId } : undefined;

    if (this.messageHasInlineKeyboard(update)) {
      return;
    }

    const alreadyAttached = await this.prisma.auditLog.findFirst({
      where: {
        chatId,
        action: CHAT_DIALOG_AUTO_ATTACH_ACTION,
        payload: {
          path: ['messageId'],
          equals: messageId,
        },
      },
      select: {
        id: true,
      },
    });
    if (alreadyAttached) {
      return;
    }

    const threadId = randomUUID();
    const buttons = [
      [
        this.buildChatDialogButton(
          chatId,
          'comments',
          threadId,
          formatCommentsButtonText('💬 Комментарии', 0),
          autoAttachBotId,
        ),
      ],
    ];
    let deliveryMode: 'edit_message' | 'reply_message' | 'replace_with_bot_message' =
      'edit_message';
    let replacementMessageId: string | null = null;
    let replyMessageId: string | null = null;
    let publishedUrl: string | null = null;
    let originalDeleted = false;

    if (senderIsAdmin) {
      try {
        const sent = await this.maxClient.sendMessageCopyWithInlineKeyboard(
          chatId,
          messageId,
          text,
          {
            buttons,
            debugContext: {
              screen: 'chat-auto-comments',
              action: 'replace-admin-message-with-bot-copy',
            },
          },
          mutationRequestOptions,
        );
        replacementMessageId = sent.messageId;
        publishedUrl = sent.url ?? null;
        deliveryMode = 'replace_with_bot_message';
      } catch (error: unknown) {
        const status = this.extractStatusCode(error);
        if (status && status < 500 && status !== 429) {
          this.logger.warn(
            {
              chatId,
              messageId,
              status,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed to publish bot copy for admin chat message; skipping retry',
          );
          return;
        }
        throw error;
      }

      try {
        await this.maxClient.deleteMessage(chatId, messageId, {
          immediate: true,
          ...(mutationRequestOptions ?? {}),
        });
        originalDeleted = true;
      } catch (deleteError: unknown) {
        this.logger.warn(
          {
            chatId,
            messageId,
            status: this.extractStatusCode(deleteError),
            error: deleteError instanceof Error ? deleteError.message : 'Unknown error',
            replacementMessageId,
          },
          'Failed to delete original admin chat message after bot copy publish',
        );
      }

      await this.prisma.auditLog.create({
        data: {
          chatId,
          actorUserId: senderId,
          action: CHAT_DIALOG_AUTO_ATTACH_ACTION,
          payload: {
            messageId,
            threadId,
            source: 'webhook',
            deliveryMode,
            replacementMessageId,
            ...(publishedUrl ? { publishedUrl } : {}),
            originalDeleted,
            ...(autoAttachBotId ? { botId: autoAttachBotId } : {}),
          },
        },
      });
      return;
    }

    try {
      await this.maxClient.editMessageInlineKeyboard(
        chatId,
        messageId,
        text,
        {
          buttons,
          debugContext: {
            screen: 'chat-auto-comments',
            action: 'attach-comments',
          },
        },
        mutationRequestOptions,
      );
    } catch (error: unknown) {
      const status = this.extractStatusCode(error);
      if (status && status < 500 && status !== 429) {
        this.logger.warn(
          {
            chatId,
            messageId,
            status,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to edit chat message inline keyboard; falling back to bot reply',
        );
        try {
          const sent = await this.maxClient.sendMessageImmediateWithResolvedLink(
            chatId,
            CHAT_COMMENTS_REPLY_TEXT,
            {
              buttons,
              messageLink: {
                type: 'reply',
                mid: messageId,
              },
            },
            mutationRequestOptions,
          );
          deliveryMode = 'reply_message';
          replyMessageId = sent.messageId;
        } catch (fallbackError: unknown) {
          const fallbackStatus = this.extractStatusCode(fallbackError);
          if (fallbackStatus && fallbackStatus < 500 && fallbackStatus !== 429) {
            this.logger.warn(
              {
                chatId,
                messageId,
                status: fallbackStatus,
                error: fallbackError instanceof Error ? fallbackError.message : 'Unknown error',
              },
              'Failed to send fallback chat comments reply; skipping retry',
            );
            return;
          }
          throw fallbackError;
        }
      } else {
        throw error;
      }
    }

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: senderId,
        action: CHAT_DIALOG_AUTO_ATTACH_ACTION,
        payload: {
          messageId,
          threadId,
          source: 'webhook',
          deliveryMode,
          ...(replacementMessageId ? { replacementMessageId } : {}),
          ...(publishedUrl ? { publishedUrl } : {}),
          ...(replyMessageId ? { replyMessageId } : {}),
          originalDeleted,
          ...(autoAttachBotId ? { botId: autoAttachBotId } : {}),
        },
      },
    });
  }

  private messageHasInlineKeyboard(update: MaxUpdate): boolean {
    const raw = this.asRecord(update.raw);
    const message = this.asRecord(raw?.message);
    const body = this.asRecord(message?.body);
    const attachmentGroups = [
      Array.isArray(body?.attachments) ? body.attachments : null,
      Array.isArray(message?.attachments) ? message.attachments : null,
    ];

    return attachmentGroups.some((attachments) =>
      Array.isArray(attachments)
        ? attachments.some((attachment) => {
            const row = this.asRecord(attachment);
            return this.readLowerString(row?.type) === 'inline_keyboard';
          })
        : false,
    );
  }

  private buildChannelDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
    botId?: string | null,
    suggestionEntryMode: PersistedChannelSettings['postSuggestionsEntryMode'] = 'BOT',
  ): MaxMessageButton {
    if (type === 'suggest' && suggestionEntryMode !== 'MINIAPP') {
      const startPayload =
        this.adminDialogLinkService?.buildChannelSuggestionStartPayload(chatId, threadId) ??
        this.buildChannelDialogStartParam(chatId, 'suggest', threadId);
      const botStartUrl = this.buildBotStartUrl(startPayload, botId);
      if (botStartUrl) {
        return {
          type: 'link',
          text,
          url: botStartUrl,
        };
      }
    }

    const launchUrl = this.buildChannelDialogLaunchUrl(chatId, type, threadId, botId);
    const webAppUrl = this.buildChannelDialogDirectWebAppUrl(chatId, type, threadId);
    const botContactId = this.resolveBotContactId(botId);

    if (launchUrl) {
      return {
        type: 'link',
        text,
        url: launchUrl,
      };
    }

    if (webAppUrl && botContactId) {
      return {
        type: 'open_app',
        text,
        webApp: webAppUrl,
        contactId: botContactId,
      };
    }

    return {
      type: 'link',
      text,
      url: webAppUrl ?? `${this.appBaseUrl ?? 'https://major-maksimov.ru'}/app/`,
    };
  }

  private buildChatDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
    botId?: string | null,
  ): MaxMessageButton {
    const launchUrl = this.buildChatDialogLaunchUrl(chatId, type, threadId, botId);
    const webAppUrl = this.buildChatDialogDirectWebAppUrl(chatId, type, threadId);
    const botContactId = this.resolveBotContactId(botId);

    if (launchUrl) {
      return {
        type: 'link',
        text,
        url: launchUrl,
      };
    }

    if (webAppUrl && botContactId) {
      return {
        type: 'open_app',
        text,
        webApp: webAppUrl,
        contactId: botContactId,
      };
    }

    return {
      type: 'link',
      text,
      url: webAppUrl ?? `${this.appBaseUrl ?? 'https://major-maksimov.ru'}/app/`,
    };
  }

  private buildChannelDialogLaunchUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    _botId?: string | null,
  ): string | null {
    const startParam = this.buildChannelDialogStartParam(chatId, type, threadId);
    return this.buildEntryMiniappStartUrl(startParam);
  }

  private buildChatDialogLaunchUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    _botId?: string | null,
  ): string | null {
    const startParam = this.buildChatDialogStartParam(chatId, type, threadId);
    return this.buildEntryMiniappStartUrl(startParam);
  }

  private buildChannelDialogDirectWebAppUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    const token = this.buildChannelDialogToken(chatId, type, threadId);
    return `${this.appBaseUrl}/app/channel/${encodeURIComponent(chatId)}/dialog/${type}?token=${token}`;
  }

  private buildChatDialogDirectWebAppUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    const token = this.buildChatDialogToken(chatId, type, threadId);
    return `${this.appBaseUrl}/app/chat/${encodeURIComponent(chatId)}/dialog/${type}?token=${token}`;
  }

  private buildChannelDialogStartParam(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string {
    const token = this.buildChannelDialogToken(chatId, type, threadId);
    const payload = JSON.stringify({
      v: 1,
      k: 'channel-dialog',
      c: chatId,
      m: type,
      t: token,
    });
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${CHANNEL_DIALOG_START_PARAM_PREFIX}${encoded}`;
  }

  private buildChatDialogStartParam(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string {
    const token = this.buildChatDialogToken(chatId, type, threadId);
    const payload = JSON.stringify({
      v: 1,
      k: 'chat-dialog',
      c: chatId,
      m: type,
      t: token,
    });
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${CHANNEL_DIALOG_START_PARAM_PREFIX}${encoded}`;
  }

  private buildEntryMiniappStartUrl(startParam: string): string | null {
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    return (
      this.maxBotLinkService?.buildEntryMiniappStartUrlSync?.(startParam) ??
      this.maxBotLinkService?.buildMiniappStartUrlSync?.(startParam) ??
      (this.ownBotUserId
        ? `https://max.ru/${encodeURIComponent(this.ownBotUserId)}?startapp=${encodeURIComponent(startParam)}`
        : null)
    );
  }

  private buildBotStartUrl(startPayload: string, botId?: string | null): string | null {
    if (!isValidMaxBotStartPayload(startPayload)) {
      return null;
    }

    return (
      this.maxBotLinkService?.buildBotStartUrlSync?.(startPayload, botId) ??
      (this.ownBotUserId
        ? `https://max.ru/${encodeURIComponent(this.ownBotUserId)}?start=${encodeURIComponent(startPayload)}`
        : null)
    );
  }

  private buildChannelDialogToken(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string {
    const payload = JSON.stringify({
      v: 1,
      d: threadId,
      s: this.buildChannelDialogTokenSignature(chatId, type, threadId),
    });
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${CHANNEL_DIALOG_TOKEN_PREFIX}${encoded}`;
  }

  private buildChatDialogToken(chatId: string, type: ChannelDialogType, threadId: string): string {
    const payload = JSON.stringify({
      v: 1,
      d: threadId,
      s: this.buildChatDialogTokenSignature(chatId, type, threadId),
    });
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${CHANNEL_DIALOG_TOKEN_PREFIX}${encoded}`;
  }

  private buildChannelDialogTokenSignature(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string {
    const scope = `dialog:${chatId}:${type}:${threadId}`;
    return createHmac('sha256', this.getCurrentBotToken()).update(scope).digest('hex');
  }

  private buildChatDialogTokenSignature(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string {
    const scope = `dialog:chat:${chatId}:${type}:${threadId}`;
    return createHmac('sha256', this.getCurrentBotToken()).update(scope).digest('hex');
  }

  private getCurrentBotToken(): string {
    return this.maxBotLinkService?.getBotTokenSync?.() ?? this.maxBotToken ?? '';
  }

  private async reconcileLinkAllowlistViolations(params: {
    chatId: string;
    text: string;
    settings: ChatSettings;
    cachedDomainAllowlist: string[];
    violations: RuleViolation[];
  }): Promise<RuleViolation[]> {
    const hasLinkBlockedViolation = params.violations.some(
      (violation) => violation.ruleCode === 'LINK_BLOCKED',
    );
    const hasBlockedDomainViolation = params.violations.some(
      (violation) => violation.ruleCode === 'MESSAGE_BLOCKED_DOMAIN',
    );
    if (
      (!hasLinkBlockedViolation && !hasBlockedDomainViolation) ||
      (params.settings.linkPolicy !== 'ALLOWLIST_ONLY' && !hasBlockedDomainViolation)
    ) {
      return params.violations;
    }

    let freshDomainAllowlist: string[] | null = null;
    try {
      freshDomainAllowlist = await this.loadFreshDomainAllowlistForLinkRecheck(params.chatId);
    } catch (error) {
      this.logger.warn(
        {
          chatId: params.chatId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Fresh allowlist link recheck failed',
      );
      return params.violations;
    }

    if (!freshDomainAllowlist || freshDomainAllowlist.length === 0) {
      return params.violations;
    }

    const freshAllowlistMatcher = createAllowlistLinkMatcher(freshDomainAllowlist);
    const linkViolation = detectBlockedLink(
      params.text,
      params.settings.linkPolicy,
      freshDomainAllowlist,
      freshAllowlistMatcher,
    );
    const blockedDomain = this.blockedDomainDetector.detect(
      params.text,
      params.settings.messageLimitsBlockedDomains,
      {
        isLinkAllowlisted: freshAllowlistMatcher,
      },
    );
    const recalculatedViolations = params.violations.flatMap((violation) => {
      if (violation.ruleCode === 'LINK_BLOCKED') {
        return linkViolation ? [{ ...violation, reason: linkViolation }] : [];
      }

      if (violation.ruleCode === 'MESSAGE_BLOCKED_DOMAIN') {
        return blockedDomain
          ? [
              {
                ...violation,
                reason: `Blocked domain detected: ${blockedDomain.blockedDomain}`,
                metadata: {
                  ...(violation.metadata ?? {}),
                  blockedDomain: blockedDomain.blockedDomain,
                  matchedDomain: blockedDomain.matchedDomain,
                  matchedLink: blockedDomain.matchedLink,
                },
              },
            ]
          : [];
      }

      return [violation];
    });

    if (
      recalculatedViolations.some(
        (violation) =>
          violation.ruleCode === 'LINK_BLOCKED' ||
          violation.ruleCode === 'MESSAGE_BLOCKED_DOMAIN',
      )
    ) {
      return recalculatedViolations;
    }

    this.logger.debug(
      {
        chatId: params.chatId,
        cachedAllowlistSize: params.cachedDomainAllowlist.length,
        freshAllowlistSize: freshDomainAllowlist.length,
      },
      'Suppressed link-family violations after fresh allowlist recheck',
    );
    void this.chatContextCache?.invalidate(params.chatId).catch((error: unknown) => {
      this.logger.debug(
        {
          chatId: params.chatId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to invalidate chat context after fresh allowlist recheck',
      );
    });

    return recalculatedViolations;
  }

  private async loadFreshDomainAllowlistForLinkRecheck(chatId: string): Promise<string[] | null> {
    const domainAllowlistDelegate = (
      this.prisma as unknown as {
        domainAllowlist?: {
          findMany?: (args: {
            where: {
              chatId: string;
              OR: Array<{ removeAfterAt: null } | { removeAfterAt: { gt: Date } }>;
            };
            select: { domain: true };
          }) => Promise<Array<{ domain: string }>>;
        };
      }
    ).domainAllowlist;

    if (typeof domainAllowlistDelegate?.findMany !== 'function') {
      return null;
    }

    const rows = await domainAllowlistDelegate.findMany({
      where: {
        chatId,
        OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: new Date() } }],
      },
      select: {
        domain: true,
      },
    });

    return rows.map((row) => row.domain);
  }

  private async loadChatContext(
    chatId: string,
    chatTitle?: string,
  ): Promise<{
    settings: ChatSettings;
    domainAllowlist: string[];
    adminUserIds: string[];
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
  }> {
    const startedAtMs = Date.now();
    if (this.chatContextCache) {
      const cached = await this.chatContextCache.getChatContext(chatId, chatTitle);
      this.recordRuntimeStageObservation('chat-context.cache', Date.now() - startedAtMs);
      return {
        settings: cached.settings,
        domainAllowlist: cached.domainAllowlist,
        adminUserIds: cached.adminUserIds,
        rulesPublishedUrl: cached.rulesPublishedUrl ?? null,
        rulesPublishedMessageId: cached.rulesPublishedMessageId ?? null,
      };
    }

    const fallbackTitle = `Chat ${chatId}`;
    const resolvedTitle = chatTitle?.trim() || fallbackTitle;
    const chat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: resolvedTitle,
        settings: {
          create: {},
        },
      },
      update: {
        ...(chatTitle?.trim()
          ? {
              title: chatTitle.trim(),
            }
          : {}),
      },
      include: {
        settings: true,
        rules: {
          select: {
            publishedUrl: true,
            publishedMessageId: true,
          },
        },
        domains: {
          where: {
            OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: new Date() } }],
          },
          select: {
            domain: true,
          },
        },
        admins: {
          select: {
            userId: true,
          },
        },
      },
    });

    if (!chat.settings) {
      throw new Error(`Chat settings missing for chat ${chatId}`);
    }

    this.recordRuntimeStageObservation('chat-context.db', Date.now() - startedAtMs);

    return {
      settings: chat.settings,
      domainAllowlist: (chat.domains ?? []).map((item) => item.domain),
      adminUserIds: (chat.admins ?? []).map((item) => item.userId),
      rulesPublishedUrl: chat.rules?.publishedUrl ?? null,
      rulesPublishedMessageId: chat.rules?.publishedMessageId ?? null,
    };
  }

  private async loadRulesButtonReferenceMap(
    chatIds: readonly string[],
  ): Promise<Map<string, RulesButtonReference>> {
    const normalizedChatIds = Array.from(
      new Set(chatIds.map((item) => item.trim()).filter(Boolean)),
    );
    if (normalizedChatIds.length === 0 || !this.prisma.chatRules?.findMany) {
      return new Map();
    }

    const rows = await this.prisma.chatRules.findMany({
      where: {
        chatId: {
          in: normalizedChatIds,
        },
        OR: [{ publishedUrl: { not: null } }, { publishedMessageId: { not: null } }],
      },
      select: {
        chatId: true,
        publishedUrl: true,
        publishedMessageId: true,
      },
    });

    const hydratedRows = await Promise.all(
      rows.map(async (row) => {
        const resolvedUrl = await this.resolveRulesPublishedUrl(
          row.chatId,
          row.publishedUrl ?? null,
          row.publishedMessageId ?? null,
        );
        const publishedMessageId = row.publishedMessageId ?? null;
        if (!resolvedUrl && !publishedMessageId) {
          return null;
        }

        return [
          row.chatId,
          {
            publishedUrl: resolvedUrl,
            publishedMessageId,
          },
        ] as const;
      }),
    );
    const entries: Array<[string, RulesButtonReference]> = [];
    for (const row of hydratedRows) {
      if (!row) {
        continue;
      }
      entries.push([row[0], row[1]]);
    }

    return new Map(entries);
  }

  private async resolveRulesPublishedUrl(
    chatId: string,
    publishedUrl: string | null,
    publishedMessageId: string | null,
  ): Promise<string | null> {
    const normalizedPublishedUrl = this.normalizeBotButtonUrl(publishedUrl ?? '');
    if (normalizedPublishedUrl) {
      return normalizedPublishedUrl;
    }

    const normalizedMessageId = publishedMessageId?.trim() ?? '';
    if (!normalizedMessageId) {
      return null;
    }

    let resolvedUrl: string | null = null;
    try {
      resolvedUrl = this.normalizeBotButtonUrl(
        (await this.maxClient.resolveMessageLink(normalizedMessageId)) ?? '',
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          messageId: normalizedMessageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to recover published rules url',
      );
      return null;
    }

    if (!resolvedUrl) {
      return null;
    }

    try {
      if (this.prisma.chatRules?.update) {
        await this.prisma.chatRules.update({
          where: { chatId },
          data: {
            publishedUrl: resolvedUrl,
          },
        });
      }
      await this.chatContextCache?.invalidate(chatId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          messageId: normalizedMessageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to persist recovered published rules url',
      );
    }

    return resolvedUrl;
  }

  private applyDegradeSettings(settings: ChatSettings, degradeMode: boolean): ChatSettings {
    if (!degradeMode) {
      return settings;
    }

    return {
      ...settings,
      commercialAdsFilterEnabled: false,
      russianProfanityFilterEnabled: false,
      thematicCodewordEnabled: false,
    };
  }

  private readLowerString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private readBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
  }

  private extractStatusCode(error: unknown): number | null {
    const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
    return typeof maybeStatus === 'number' ? maybeStatus : null;
  }

  private extractErrorSummary(error: unknown): string {
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message.trim()
        : typeof (error as { message?: unknown } | null)?.message === 'string'
          ? ((error as { message: string }).message.trim() || 'Unknown error')
          : String(error ?? 'Unknown error');
    return message.slice(0, 500);
  }

  private isPrismaKnownError(error: unknown, code: string): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return error.code === code;
    }

    return (error as { code?: string } | null)?.code === code;
  }

  private extractMaxErrorCode(error: unknown): string | null {
    const maybeCode = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof maybeCode === 'string' && maybeCode.trim().length > 0
      ? maybeCode.trim().toLowerCase()
      : null;
  }

  private extractMaxErrorMessage(error: unknown): string {
    const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response
      ?.data?.message;
    if (typeof responseMessage === 'string' && responseMessage.trim().length > 0) {
      return responseMessage.trim().toLowerCase();
    }

    return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  }

  private isTerminalPrivateDialogDeliveryError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 403 || status === 404) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found' || code === 'message.not.found') {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('bot is not a chat member') ||
      message.includes('not accessible') ||
      message.includes('chat not found')
    );
  }

  private isTerminalCallbackError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 400 || status === 404) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'callback.not.found' || code === 'message_callback.not_found') {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('callback') &&
      (message.includes('expired') || message.includes('not found') || message.includes('invalid'))
    );
  }

  private isTerminalWebhookProcessingError(error: unknown): boolean {
    const timeoutMarker = (error as { webhookHotPathTimeout?: unknown })?.webhookHotPathTimeout;
    if (timeoutMarker === true) {
      return true;
    }

    const status = this.extractStatusCode(error);
    if (status === 403 || status === 404) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found' || code === 'message.not.found') {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('bot is not a chat member') ||
      message.includes('not accessible') ||
      message.includes('chat not found') ||
      message.includes('webhook user-facing hot path timed out')
    );
  }

  private async executeWebhookUpdateWithGuard(
    webhookEventId: string,
    update: MaxUpdate,
    activeBotId: string | null,
    task: () => Promise<void>,
    getTimeoutContext?: () => Record<string, unknown> | null,
  ): Promise<void> {
    const timeoutMs = this.resolveWebhookHotPathTimeoutMs(update);
    if (timeoutMs === null) {
      await task();
      return;
    }

    const startedAtMs = Date.now();
    const taskPromise = Promise.resolve().then(task);
    taskPromise.catch(() => undefined);

    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const timeoutContext = getTimeoutContext?.() ?? null;
        reject(
          this.createWebhookHotPathTimeoutError({
            webhookEventId,
            update,
            activeBotId,
            timeoutMs,
            timeoutContext,
          }),
        );
      }, timeoutMs);
      timeout.unref?.();
    });

    try {
      await Promise.race([taskPromise, timeoutPromise]);
      const durationMs = Date.now() - startedAtMs;
      const timeoutContext = getTimeoutContext?.() ?? null;
      if (timeoutContext) {
        void this.runtimeDiagnosticsService?.recordHotPathProfile({
          snapshot: timeoutContext,
        });
      }
      if (durationMs >= WEBHOOK_USER_FACING_SLOW_LOG_THRESHOLD_MS) {
        this.logger.warn(
          {
            webhookEventId,
            updateType: this.readLowerString(update.type),
            chatId: this.extractWebhookHotPathChatId(update),
            activeBotId,
            durationMs,
            timeoutMs,
            ...(timeoutContext ?? {}),
          },
          'Slow webhook user-facing hot path completed close to the watchdog deadline',
        );
      }
    } catch (error: unknown) {
      if ((error as { code?: unknown })?.code === 'WEBHOOK_USER_FACING_TIMEOUT') {
        const timeoutContext = getTimeoutContext?.() ?? null;
        const latestStage =
          timeoutContext && typeof timeoutContext.latestStage === 'string'
            ? timeoutContext.latestStage
            : 'unknown';
        if (timeoutContext) {
          void this.runtimeDiagnosticsService?.recordHotPathProfile({
            snapshot: timeoutContext,
          });
        }
        void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
          stage: latestStage,
          outcome: 'timeout',
          failOpen: true,
        });
        const successBoundaryReached = timeoutContext?.successBoundaryReached === true;
        if (
          successBoundaryReached &&
          WEBHOOK_HOT_TIMEOUT_BACKOFF_SUPPRESSED_STAGES.has(latestStage)
        ) {
          void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
            stage: `${latestStage}.deferred`,
            outcome: 'skip',
            failOpen: true,
          });
          void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
            stage: 'follow_up_deferred',
            outcome: 'skip',
            failOpen: true,
          });
          taskPromise.catch((followUpError: unknown) => {
            void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
              stage: 'follow_up_failed',
              outcome: 'timeout',
              failOpen: true,
            });
            this.logger.warn(
              {
                webhookEventId,
                updateType: this.readLowerString(update.type),
                chatId: this.extractWebhookHotPathChatId(update),
                activeBotId,
                latestStage,
                successBoundaryStage: timeoutContext?.successBoundaryStage,
                err: followUpError instanceof Error ? followUpError.message : String(followUpError),
              },
              'Deferred webhook follow-up failed after the user-facing success boundary',
            );
          });
          this.logger.warn(
            {
              webhookEventId,
              updateType: this.readLowerString(update.type),
              chatId: this.extractWebhookHotPathChatId(update),
              activeBotId,
              latestStage,
              successBoundaryStage: timeoutContext?.successBoundaryStage,
              timeoutMs,
            },
            'Detached webhook follow-up after the user-facing success boundary timed out',
          );
          return;
        }
      }
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private resolveWebhookHotPathTimeoutMs(update: MaxUpdate): number | null {
    const updateType = this.readLowerString(update.type);
    if (updateType === 'message_callback') {
      return this.webhookUserFacingTimeoutMs;
    }

    const chatId = this.extractWebhookHotPathChatId(update);
    if (
      (updateType === 'message_created' || updateType === 'message_edited') &&
      chatId &&
      chatId.startsWith('-')
    ) {
      return this.webhookUserFacingTimeoutMs;
    }

    return null;
  }

  private isWebhookHotTimeoutChatBackoffActive(chatId: string): boolean {
    const backoffUntilMs = this.webhookHotTimeoutChatBackoffUntilMs.get(chatId) ?? 0;
    if (backoffUntilMs <= Date.now()) {
      if (backoffUntilMs > 0) {
        this.webhookHotTimeoutChatBackoffUntilMs.delete(chatId);
      }
      return false;
    }

    return true;
  }

  private rememberWebhookHotTimeoutChat(chatId: string | null): void {
    if (!chatId || !chatId.startsWith('-')) {
      return;
    }

    this.webhookHotTimeoutChatBackoffUntilMs.set(chatId, Date.now() + WEBHOOK_HOT_CHAT_BACKOFF_MS);
  }

  private shouldRememberWebhookHotTimeoutChat(
    timeoutContext?: Record<string, unknown> | null,
  ): boolean {
    const latestStage = timeoutContext ? this.readString(timeoutContext.latestStage) : null;
    return !latestStage || !WEBHOOK_HOT_TIMEOUT_BACKOFF_SUPPRESSED_STAGES.has(latestStage);
  }

  private shouldSkipHotChatModeration(
    mode: SystemModeSnapshot,
    hotChatBackoffActive: boolean,
  ): boolean {
    if (!hotChatBackoffActive) {
      return false;
    }

    if (mode.mode === 'degrade' && !isSystemModeRecoveryWindow(mode)) {
      return true;
    }

    return mode.queueLagSec >= REQUIRED_SUBSCRIPTION_PRESSURE_SKIP_QUEUE_LAG_SEC;
  }

  private logHotChatModerationSkip(chatId: string, userId: string, mode: SystemModeSnapshot): void {
    const now = Date.now();
    if (now - this.webhookHotChatSkipLogAtMs < WEBHOOK_HOT_CHAT_SKIP_LOG_INTERVAL_MS) {
      return;
    }

    this.webhookHotChatSkipLogAtMs = now;
    this.logger.warn(
      {
        chatId,
        userId,
        queueLagSec: mode.queueLagSec,
        mode: mode.mode,
        reason: mode.reason || 'system pressure',
      },
      'Skipped ordinary chat moderation because the chat is in hot-timeout backoff',
    );
  }

  private extractWebhookHotPathChatId(update: MaxUpdate): string | null {
    return typeof update.message?.chatId === 'string' && update.message.chatId.trim().length > 0
      ? update.message.chatId.trim()
      : null;
  }

  private createWebhookHotPathTimeoutError(params: {
    webhookEventId: string;
    update: MaxUpdate;
    activeBotId: string | null;
    timeoutMs: number;
    timeoutContext?: Record<string, unknown> | null;
  }): Error {
    const error = new Error(
      `Webhook user-facing hot path timed out after ${params.timeoutMs}ms for ${
        this.readLowerString(params.update.type) ?? 'unknown'
      }`,
    ) as Error & {
      code?: string;
      webhookHotPathTimeout?: boolean;
      webhookEventId?: string;
      chatId?: string | null;
      activeBotId?: string | null;
      webhookHotPathContext?: Record<string, unknown> | null;
    };
    error.code = 'WEBHOOK_USER_FACING_TIMEOUT';
    error.webhookHotPathTimeout = true;
    error.webhookEventId = params.webhookEventId;
    error.chatId = this.extractWebhookHotPathChatId(params.update);
    error.activeBotId = params.activeBotId;
    error.webhookHotPathContext = params.timeoutContext ?? null;
    const hotChatBackoffSuppressed = !this.shouldRememberWebhookHotTimeoutChat(
      params.timeoutContext,
    );
    if (!hotChatBackoffSuppressed) {
      this.rememberWebhookHotTimeoutChat(error.chatId);
    }
    this.logger.warn(
      {
        webhookEventId: params.webhookEventId,
        updateType: this.readLowerString(params.update.type),
        chatId: error.chatId,
        activeBotId: params.activeBotId,
        timeoutMs: params.timeoutMs,
        hotChatBackoffSuppressed,
        ...(params.timeoutContext ?? {}),
      },
      'Webhook user-facing hot path timed out; failing this event open to keep the shard responsive',
    );
    return error;
  }

  private formatWebhookProcessingErrorMessage(error: unknown): string {
    const baseMessage = error instanceof Error ? error.message : 'Unknown error';
    if (!(error instanceof Error)) {
      return baseMessage;
    }

    const timeoutError = error as Error & {
      code?: string;
      chatId?: string | null;
      activeBotId?: string | null;
      webhookHotPathContext?: Record<string, unknown> | null;
    };
    if (
      timeoutError.code !== 'WEBHOOK_USER_FACING_TIMEOUT' ||
      !timeoutError.webhookHotPathContext
    ) {
      return baseMessage;
    }

    const details: string[] = [];
    const latestStage = this.readString(timeoutError.webhookHotPathContext.latestStage);
    if (latestStage) {
      details.push(`latestStage=${latestStage}`);
    }

    const elapsedMs = timeoutError.webhookHotPathContext.elapsedMs;
    if (typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0) {
      details.push(`elapsedMs=${Math.trunc(elapsedMs)}`);
    }

    const chatId =
      this.readString(timeoutError.chatId) ??
      this.readString(timeoutError.webhookHotPathContext.chatId);
    if (chatId) {
      details.push(`chatId=${chatId}`);
    }

    const activeBotId =
      this.readString(timeoutError.activeBotId) ??
      this.readString(timeoutError.webhookHotPathContext.activeBotId);
    if (activeBotId) {
      details.push(`activeBotId=${activeBotId}`);
    }

    if (details.length === 0) {
      return baseMessage;
    }

    return `${baseMessage} [${details.join(', ')}]`;
  }

  private resolveOptionalWebhookStageSkipReason(params: {
    stage: string;
    hotPathProfile?: WebhookHotPathProfile | null;
    systemMode: SystemModeSnapshot;
    hotChatBackoffActive?: boolean;
    minRemainingMs?: number;
  }): string | null {
    const snapshot = this.readWebhookHotPathProfileSnapshot(params.hotPathProfile);
    const elapsedMs =
      typeof snapshot?.elapsedMs === 'number' && Number.isFinite(snapshot.elapsedMs)
        ? snapshot.elapsedMs
        : null;
    if (elapsedMs === null) {
      return null;
    }

    const remainingMs = Math.max(0, this.webhookUserFacingTimeoutMs - elapsedMs);
    const pressureActive = this.isWebhookHotPathPressureActive(
      params.systemMode,
      params.hotChatBackoffActive,
    );
    if (!pressureActive) {
      return null;
    }

    const minRemainingMs = Math.max(
      1,
      Math.ceil(params.minRemainingMs ?? WEBHOOK_OPTIONAL_STAGE_MIN_REMAINING_MS),
    );
    if (remainingMs > minRemainingMs) {
      return null;
    }

    if (params.hotChatBackoffActive) {
      return `${params.stage} skipped with ${remainingMs}ms remaining in hot-chat backoff`;
    }
    if (params.systemMode.mode === 'degrade') {
      return `${params.stage} skipped with ${remainingMs}ms remaining during ${params.systemMode.reason || 'degrade'}`;
    }
    return `${params.stage} skipped with ${remainingMs}ms remaining at queue lag ${params.systemMode.queueLagSec.toFixed(1)}s`;
  }

  private isWebhookHotPathPressureActive(
    systemMode: SystemModeSnapshot,
    hotChatBackoffActive = false,
  ): boolean {
    return (
      hotChatBackoffActive ||
      systemMode.mode === 'degrade' ||
      systemMode.queueLagSec >= REQUIRED_SUBSCRIPTION_PRESSURE_SKIP_QUEUE_LAG_SEC / 2
    );
  }

  private resolveWebhookHotPathStageWaitBudgetMs(params: {
    hotPathProfile?: WebhookHotPathProfile | null;
    systemMode: SystemModeSnapshot;
    hotChatBackoffActive?: boolean;
    defaultWaitMs: number;
    reserveMs?: number;
  }): number {
    const defaultWaitMs = Math.max(1, Math.ceil(params.defaultWaitMs));
    const snapshot = this.readWebhookHotPathProfileSnapshot(params.hotPathProfile);
    const elapsedMs =
      typeof snapshot?.elapsedMs === 'number' && Number.isFinite(snapshot.elapsedMs)
        ? snapshot.elapsedMs
        : null;
    if (elapsedMs === null) {
      return defaultWaitMs;
    }

    if (!this.isWebhookHotPathPressureActive(params.systemMode, params.hotChatBackoffActive)) {
      return defaultWaitMs;
    }

    const reserveMs = Math.max(0, Math.ceil(params.reserveMs ?? 0));
    const remainingMs = Math.max(0, this.webhookUserFacingTimeoutMs - elapsedMs - reserveMs);
    return Math.min(defaultWaitMs, remainingMs);
  }

  private recordOptionalWebhookStageSkip(params: {
    stage: string;
    reason: string;
    failOpen?: boolean;
  }): void {
    this.logger.warn(
      {
        stage: params.stage,
        reason: params.reason,
      },
      'Skipped optional moderation stage because the hot-path budget is almost exhausted',
    );
    void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
      stage: params.stage,
      outcome: 'skip',
      failOpen: params.failOpen,
    });
  }

  private shouldDetachFollowUpForBudget(
    hotPathProfile: WebhookHotPathProfile | null | undefined,
    stage: string,
    minRemainingMs = 2_000,
  ): boolean {
    const snapshot = this.readWebhookHotPathProfileSnapshot(hotPathProfile);
    if (snapshot?.successBoundaryReached !== true) {
      return false;
    }

    const elapsedMs =
      typeof snapshot.elapsedMs === 'number' && Number.isFinite(snapshot.elapsedMs)
        ? snapshot.elapsedMs
        : null;
    if (elapsedMs === null) {
      return false;
    }

    const remainingMs = Math.max(0, this.webhookUserFacingTimeoutMs - elapsedMs);
    if (remainingMs >= Math.max(1, Math.ceil(minRemainingMs))) {
      return false;
    }

    this.recordOptionalWebhookStageSkip({
      stage: `${stage}.deferred`,
      reason: `${stage} detached with ${remainingMs}ms remaining after the destructive action boundary`,
      failOpen: true,
    });
    return true;
  }

  private scheduleDetachedWebhookFollowUp(params: {
    stage: string;
    chatId: string;
    userId?: string | null;
    messageId?: string | null;
    task: () => Promise<void>;
  }): void {
    const stage = params.stage.trim() || 'follow-up';
    void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
      stage: 'follow_up_deferred',
      outcome: 'skip',
      failOpen: true,
    });

    const immediate = setImmediate(() => {
      void Promise.resolve()
        .then(params.task)
        .catch((error: unknown) => {
          void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
            stage: 'follow_up_failed',
            outcome: 'timeout',
            failOpen: true,
          });
          void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
            stage: `${stage}.failed`,
            outcome: 'timeout',
            failOpen: true,
          });
          this.logger.warn(
            {
              stage,
              chatId: params.chatId,
              userId: params.userId ?? null,
              messageId: params.messageId ?? null,
              err: error instanceof Error ? error.message : String(error),
            },
            'Deferred webhook follow-up failed after the user-facing success boundary',
          );
        });
    });
    immediate.unref?.();
  }

  private recordRuntimeStageObservation(stage: string, elapsedMs: number): void {
    if (!stage.trim()) {
      return;
    }

    void this.runtimeDiagnosticsService?.recordHotPathProfile({
      snapshot: {
        stageDurations: {
          [stage]: Math.max(0, Math.trunc(elapsedMs)),
        },
      },
    });
  }

  private createWebhookHotPathProfile(): WebhookHotPathProfile {
    const now = Date.now();
    return {
      startedAtMs: now,
      lastMarkedAtMs: now,
      latestStage: 'start',
      stages: new Map(),
      stageTimelineMs: new Map(),
      successBoundaryReached: false,
      successBoundaryStage: null,
    };
  }

  private markWebhookHotPathStage(
    profile: WebhookHotPathProfile | null | undefined,
    stage: string,
  ): void {
    if (!profile) {
      return;
    }

    const now = Date.now();
    profile.latestStage = stage;
    profile.stages.set(stage, Math.max(0, now - profile.lastMarkedAtMs));
    profile.stageTimelineMs.set(stage, Math.max(0, now - profile.startedAtMs));
    profile.lastMarkedAtMs = now;
  }

  private markWebhookHotPathSuccessBoundary(
    profile: WebhookHotPathProfile | null | undefined,
    stage: string,
  ): void {
    if (!profile) {
      return;
    }

    profile.successBoundaryReached = true;
    profile.successBoundaryStage = stage;
  }

  private readWebhookHotPathProfileSnapshot(
    profile: WebhookHotPathProfile | null | undefined,
  ): Record<string, unknown> | null {
    if (!profile) {
      return null;
    }

    const stageDurations = Object.fromEntries(profile.stages.entries());
    const stageTimelineMs = Object.fromEntries(profile.stageTimelineMs.entries());
    return {
      latestStage: profile.latestStage,
      successBoundaryReached: profile.successBoundaryReached,
      successBoundaryStage: profile.successBoundaryStage,
      elapsedMs: Date.now() - profile.startedAtMs,
      stageDurations,
      stageTimelineMs,
    };
  }

  private isNightModeTerminalDeleteError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 403) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found') {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return message.includes('bot is not a chat member') || message.includes('not accessible');
  }

  private isMaxApiThrottleError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 429) {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('rate limit exceeded') ||
      message.includes('source limit exceeded') ||
      message.includes('circuit breaker')
    );
  }

  private isMaxApiTimeoutError(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && code.trim().toUpperCase() === 'ECONNABORTED') {
      return true;
    }

    return this.extractMaxErrorMessage(error).includes('timeout');
  }

  private isTransientMaxApiLookupError(error: unknown): boolean {
    return this.isMaxApiThrottleError(error) || this.isMaxApiTimeoutError(error);
  }

  private normalizeSecret(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeOwnBotUserId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private parseChatIdSet(value: string | undefined): Set<string> {
    if (typeof value !== 'string') {
      return new Set();
    }

    return new Set(
      value
        .split(/[,\s;]+/u)
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    );
  }

  private isOwnBotSender(userId: string): boolean {
    if (this.maxBotLinkService?.isKnownBotUserId?.(userId)) {
      return true;
    }

    if (this.ownBotUserIdVariants.size === 0) {
      return false;
    }

    for (const variant of this.buildBotIdVariants(userId)) {
      if (this.ownBotUserIdVariants.has(variant)) {
        return true;
      }
    }

    return false;
  }

  private isKnownRuntimeBotUserId(userId: string | null | undefined): boolean {
    if (typeof userId !== 'string' || userId.trim().length === 0) {
      return false;
    }

    if (this.maxBotLinkService?.isKnownBotUserId?.(userId)) {
      return true;
    }

    if (this.ownBotUserIdVariants.size === 0) {
      return false;
    }

    for (const variant of this.buildBotIdVariants(userId)) {
      if (this.ownBotUserIdVariants.has(variant)) {
        return true;
      }
    }

    return false;
  }

  private isCurrentBotSender(userId: string, update: MaxUpdate): boolean {
    const senderVariants = this.buildStrictBotIdVariants(userId);
    if (senderVariants.size === 0) {
      return false;
    }

    const explicitCurrentBotIds = [
      this.maxBotContextService?.getActiveBotId?.(),
      this.readString(update.botId),
    ]
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);

    if (explicitCurrentBotIds.length > 0) {
      const currentBotIdentities = new Set(
        explicitCurrentBotIds
          .flatMap((botId) => [
            botId,
            this.readString(this.maxBotLinkService?.resolveContactIdSync?.(botId)),
          ])
          .filter((botId): botId is string => typeof botId === 'string' && botId.length > 0),
      );
      return [...currentBotIdentities].some((botId) =>
        this.hasBotIdVariantOverlap(senderVariants, this.buildStrictBotIdVariants(botId)),
      );
    }

    return this.hasBotIdVariantOverlap(this.buildBotIdVariants(userId), this.ownBotUserIdVariants);
  }

  private hasBotIdVariantOverlap(left: Set<string>, right: Set<string>): boolean {
    if (left.size === 0 || right.size === 0) {
      return false;
    }

    for (const variant of left) {
      if (right.has(variant)) {
        return true;
      }
    }

    return false;
  }

  private buildStrictBotIdVariants(value: string | null | undefined): Set<string> {
    if (typeof value !== 'string') {
      return new Set<string>();
    }

    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      return new Set<string>();
    }

    const variants = new Set<string>([normalized]);
    if (normalized.startsWith('id') && normalized.length > 2) {
      variants.add(normalized.slice(2));
    }
    if (normalized.endsWith('_bot') && normalized.length > 4) {
      variants.add(normalized.slice(0, -4));
    }
    if (normalized.startsWith('id') && normalized.endsWith('_bot') && normalized.length > 6) {
      variants.add(normalized.slice(2, -4));
    }

    return variants;
  }

  private buildBotIdVariants(value: string | null | undefined): Set<string> {
    if (typeof value !== 'string') {
      return new Set<string>();
    }

    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      return new Set<string>();
    }

    const variants = new Set<string>([normalized]);

    if (normalized.startsWith('id') && normalized.length > 2) {
      variants.add(normalized.slice(2));
    }

    if (normalized.endsWith('_bot') && normalized.length > 4) {
      variants.add(normalized.slice(0, -4));
    }

    if (normalized.startsWith('id') && normalized.endsWith('_bot') && normalized.length > 6) {
      variants.add(normalized.slice(2, -4));
    }

    for (const variant of [...variants]) {
      const primary = variant.split('_')[0];
      if (/^\d+$/.test(primary)) {
        variants.add(primary);
      }
    }

    return variants;
  }

  private buildUserIdVariants(value: string | null | undefined): Set<string> {
    if (typeof value !== 'string') {
      return new Set<string>();
    }

    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      return new Set<string>();
    }

    const variants = new Set<string>([normalized]);

    if (normalized.startsWith('id') && normalized.length > 2) {
      variants.add(normalized.slice(2));
    } else {
      variants.add(`id${normalized}`);
    }

    return variants;
  }

  private async collectCommercialCampaignContext(params: {
    chatId: string;
    senderId: string;
    text: string;
  }): Promise<CommercialCampaignContext | null> {
    const redisCounter = this.redisCounter;
    if (!redisCounter) {
      return null;
    }

    const normalizedSenderId = normalizeCommercialCampaignSenderId(params.senderId);
    if (!normalizedSenderId) {
      return null;
    }

    const fingerprint = buildCommercialCampaignFingerprint(params.text);

    try {
      const [
        senderDistinctChatCount,
        senderDistinctChatCount5m,
        senderDistinctChatCount30m,
        senderDistinctChatCount120m,
        sameTextDistinctChatCount,
        nearTextDistinctChatCount,
        phoneChatCounts,
        linkChatCounts,
        domainChatCounts,
        handleChatCounts,
      ] = await Promise.all([
        redisCounter
          .addToSetWithTtl(
            buildCommercialCampaignSenderChatsKey(normalizedSenderId),
            params.chatId,
            COMMERCIAL_CAMPAIGN_WINDOW_SEC,
          )
          .then((result) => result.size),
        redisCounter
          .addToSetWithTtl(
            buildCommercialCampaignSenderVelocityChatsKey(
              normalizedSenderId,
              COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[0],
            ),
            params.chatId,
            COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[0],
          )
          .then((result) => result.size),
        redisCounter
          .addToSetWithTtl(
            buildCommercialCampaignSenderVelocityChatsKey(
              normalizedSenderId,
              COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[1],
            ),
            params.chatId,
            COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[1],
          )
          .then((result) => result.size),
        redisCounter
          .addToSetWithTtl(
            buildCommercialCampaignSenderVelocityChatsKey(
              normalizedSenderId,
              COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[2],
            ),
            params.chatId,
            COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[2],
          )
          .then((result) => result.size),
        fingerprint.textHash
          ? redisCounter
              .addToSetWithTtl(
                buildCommercialCampaignSenderTextChatsKey(normalizedSenderId, fingerprint.textHash),
                params.chatId,
                COMMERCIAL_CAMPAIGN_WINDOW_SEC,
              )
              .then((result) => result.size)
          : Promise.resolve(0),
        fingerprint.nearTextHash
          ? redisCounter
              .addToSetWithTtl(
                buildCommercialCampaignSenderNearTextChatsKey(
                  normalizedSenderId,
                  fingerprint.nearTextHash,
                ),
                params.chatId,
                COMMERCIAL_CAMPAIGN_WINDOW_SEC,
              )
              .then((result) => result.size)
          : Promise.resolve(0),
        Promise.all(
          fingerprint.phones.map((phone) =>
            redisCounter
              .addToSetWithTtl(
                buildCommercialCampaignPhoneChatsKey(phone),
                params.chatId,
                COMMERCIAL_CAMPAIGN_WINDOW_SEC,
              )
              .then((result) => result.size),
          ),
        ),
        Promise.all(
          fingerprint.links.map((link) =>
            redisCounter
              .addToSetWithTtl(
                buildCommercialCampaignLinkChatsKey(link),
                params.chatId,
                COMMERCIAL_CAMPAIGN_WINDOW_SEC,
              )
              .then((result) => result.size),
          ),
        ),
        Promise.all(
          fingerprint.domains.map((domain) =>
            redisCounter
              .addToSetWithTtl(
                buildCommercialCampaignDomainChatsKey(domain),
                params.chatId,
                COMMERCIAL_CAMPAIGN_WINDOW_SEC,
              )
              .then((result) => result.size),
          ),
        ),
        Promise.all(
          fingerprint.handles.map((handle) =>
            redisCounter
              .addToSetWithTtl(
                buildCommercialCampaignHandleChatsKey(handle),
                params.chatId,
                COMMERCIAL_CAMPAIGN_WINDOW_SEC,
              )
              .then((result) => result.size),
          ),
        ),
      ]);

      const context: CommercialCampaignContext = {
        senderDistinctChatCount,
        sameTextDistinctChatCount,
        repeatedPhoneDistinctChatCount: Math.max(0, ...phoneChatCounts),
        repeatedLinkDistinctChatCount: Math.max(0, ...linkChatCounts),
        nearTextDistinctChatCount,
        repeatedDomainDistinctChatCount: Math.max(0, ...domainChatCounts),
        repeatedHandleDistinctChatCount: Math.max(0, ...handleChatCounts),
        senderDistinctChatCount5m,
        senderDistinctChatCount30m,
        senderDistinctChatCount120m,
      };

      return hasCommercialCampaignEvidence(context) ? context : null;
    } catch (error) {
      this.logger.warn(
        {
          chatId: params.chatId,
          userId: params.senderId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Commercial campaign lookup failed; continuing without cross-chat signals',
      );
      return null;
    }
  }

  private isNightModeNoticeMessage(params: {
    text: string;
    settings: Pick<
      ChatSettings,
      | 'nightModeEnabled'
      | 'nightModeBotMessageEnabled'
      | 'nightModeOpenMessageEnabled'
      | 'nightModeStartTimeMinutes'
      | 'nightModeEndTimeMinutes'
      | 'nightModeTimezone'
      | 'nightModeBotMessageText'
      | 'nightModeOpenMessageText'
      | 'botSpeechStyle'
    >;
  }): boolean {
    return isNightModeNoticeTextMessage({
      text: params.text,
      settings: params.settings,
      activeBotSpeechProfile: this.resolveActiveBotSpeechProfile(),
    });
  }

  private buildBotMessageDispatchOptions(params: {
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    immediate?: boolean;
    botId?: string;
  }): MaxActionDispatchOptions | undefined {
    const dispatchOptions: MaxActionDispatchOptions = {
      trafficClass: params.immediate === true ? 'interactive' : 'background',
      actionHealthLane: params.immediate === true ? 'interactive' : 'background',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
    };
    if (params.botId) {
      dispatchOptions.botId = params.botId;
    }
    if (params.immediate === true) {
      dispatchOptions.immediate = true;
    }

    if (params.deleteBotMessagesEnabled) {
      dispatchOptions.autoDeleteDelayMs =
        normalizeDeleteBotMessagesDelayMinutes(params.deleteBotMessagesDelayMinutes) * 60 * 1000;
    }

    return Object.keys(dispatchOptions).length > 0 ? dispatchOptions : undefined;
  }

  private async sendBotMessageWithOptionalAutoDelete(params: {
    chatId: string;
    botId?: string;
    text: string;
    messageOptions?: MaxSendMessageOptions;
    media?: BotSpeechResolvedMedia | null;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    immediate?: boolean;
    bypassNoticeBucket?: boolean;
  }): Promise<boolean> {
    const {
      chatId,
      botId,
      text,
      messageOptions,
      media,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      immediate,
      bypassNoticeBucket,
    } = params;

    if (
      immediate !== true &&
      bypassNoticeBucket !== true &&
      !(await this.shouldSendBotNotice(chatId))
    ) {
      return false;
    }

    const resolvedMessageOptions = await this.withBotSpeechMediaOptions(messageOptions, media, {
      trafficClass: immediate === true ? 'interactive' : 'background',
      actionHealthLane: immediate === true ? 'interactive' : 'background',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
      ...(botId ? { botId } : {}),
    });
    await this.maxClient.sendMessage(
      chatId,
      text,
      {
        ...(resolvedMessageOptions ?? {}),
        textFormat: resolvedMessageOptions?.textFormat ?? 'markdown',
      },
      this.buildBotMessageDispatchOptions({
        deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes,
        immediate,
        botId,
      }),
    );
    return true;
  }

  private renderRequiredSubscriptionNoticeHtml(text: string): string {
    return this.stripLooseMarkdownMarkers(
      renderSupportedMarkdownAsHtml(text, { blockMode: 'raw' }),
    );
  }

  private stripLooseMarkdownMarkers(text: string): string {
    return text.replace(/(?:\*\*\*|\*\*)/g, '');
  }

  private withHtmlMessageOptions(options?: MaxSendMessageOptions): MaxSendMessageOptions {
    return {
      ...(options ?? {}),
      textFormat: 'html',
    };
  }

  private resolveBotSpeechMedia(
    settings: { botSpeechMedia?: unknown },
    fieldKey?: BotSpeechMediaFieldKey,
  ): BotSpeechResolvedMedia | null {
    return this.botSpeechMediaService.resolveMedia(settings, fieldKey);
  }

  private async withBotSpeechMediaOptions(
    options: MaxSendMessageOptions | undefined,
    media?: BotSpeechResolvedMedia | null,
    uploadOptions: BotSpeechMediaUploadOptions = {},
  ): Promise<MaxSendMessageOptions | undefined> {
    return this.botSpeechMediaService.withMediaOptions(options, media, uploadOptions);
  }

  private async uploadBotSpeechImage(
    media: BotSpeechResolvedMedia,
    options: BotSpeechMediaUploadOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.botSpeechMediaService.uploadImage(media, options);
  }

  private async shouldSendBotNotice(chatId: string): Promise<boolean> {
    const normalizedChatId = chatId.trim();
    const incrementWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.incrementWithTtl;
    if (!normalizedChatId || !this.redisCounter || typeof incrementWithTtl !== 'function') {
      return true;
    }

    try {
      const count = await incrementWithTtl.call(
        this.redisCounter,
        `moderation:bot-notice-bucket:v1:${normalizedChatId}`,
        BOT_NOTICE_TOKEN_BUCKET_TTL_SEC,
      );
      if (count <= this.botNoticeTokenBucketLimit) {
        return true;
      }

      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'bot-notice-token-bucket',
        outcome: 'skip',
        failOpen: false,
      });
      return false;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: normalizedChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to apply bot notice token bucket',
      );
      return true;
    }
  }

  private selectChannelAutoPostScanBatch<T extends { chatId: string }>(
    channels: T[],
    maxChannels = this.channelAutoPostScanMaxChannels,
  ): T[] {
    const normalizedMaxChannels = Math.max(
      1,
      Math.min(maxChannels, this.channelAutoPostScanMaxChannels),
    );
    const dueChannels = channels.filter((channel) => this.isChannelAutoPostScanDue(channel.chatId));
    if (dueChannels.length === 0) {
      return [];
    }
    if (dueChannels.length <= normalizedMaxChannels) {
      this.channelAutoPostCursor = 0;
      return dueChannels;
    }

    const startIndex = this.channelAutoPostCursor % dueChannels.length;
    const batch: T[] = [];

    for (let index = 0; index < normalizedMaxChannels; index += 1) {
      batch.push(dueChannels[(startIndex + index) % dueChannels.length]!);
    }

    this.channelAutoPostCursor = (startIndex + batch.length) % dueChannels.length;
    return batch;
  }

  private isChannelAutoPostScanDue(chatId: string): boolean {
    const current = this.channelAutoPostScanState.get(chatId) ?? null;
    return !current || Date.now() >= current.nextScanAtMs;
  }

  private isChannelAutoPostScanMessageNew(
    scanState: ChannelAutoPostScanState | null,
    message: {
      messageId: string;
      timestampMs: number;
    },
  ): boolean {
    if (!scanState || scanState.latestTimestampMs <= 0) {
      return true;
    }
    if (message.timestampMs > scanState.latestTimestampMs) {
      return true;
    }
    if (message.timestampMs < scanState.latestTimestampMs) {
      return false;
    }

    return !scanState.latestMessageIdsAtTimestamp.includes(message.messageId);
  }

  private advanceChannelAutoPostScanState(
    scanState: ChannelAutoPostScanState | null,
    message: {
      messageId: string;
      timestampMs: number;
    },
  ): ChannelAutoPostScanState {
    const current = scanState ?? this.createChannelAutoPostScanState();
    if (message.timestampMs > current.latestTimestampMs) {
      return {
        ...current,
        latestTimestampMs: message.timestampMs,
        latestMessageIdsAtTimestamp: [message.messageId],
      };
    }
    if (message.timestampMs < current.latestTimestampMs) {
      return current;
    }
    if (current.latestMessageIdsAtTimestamp.includes(message.messageId)) {
      return current;
    }

    return {
      ...current,
      latestMessageIdsAtTimestamp: [
        ...current.latestMessageIdsAtTimestamp,
        message.messageId,
      ].slice(-10),
    };
  }

  private scheduleChannelAutoPostScanState(
    scanState: ChannelAutoPostScanState | null,
    sawNewMessages: boolean,
  ): ChannelAutoPostScanState {
    const current = scanState ?? this.createChannelAutoPostScanState();
    const idleStreak = sawNewMessages ? 0 : current.idleStreak + 1;
    const nextDelayMs = sawNewMessages
      ? this.channelAutoPostScanIntervalMs
      : Math.max(
          this.channelAutoPostScanIntervalMs,
          Math.min(
            this.channelAutoPostIdleBackoffMaxMs,
            this.channelAutoPostScanIntervalMs * 2 ** Math.min(idleStreak, 8),
          ),
        );

    return {
      ...current,
      idleStreak,
      nextScanAtMs: Date.now() + nextDelayMs,
    };
  }

  private createChannelAutoPostScanState(): ChannelAutoPostScanState {
    return {
      latestTimestampMs: 0,
      latestMessageIdsAtTimestamp: [],
      idleStreak: 0,
      nextScanAtMs: 0,
    };
  }

  private resolveChannelAutoPostScanBatchSize(): number {
    if (this.channelAutoPostThrottleStreak <= 0) {
      return this.channelAutoPostScanMaxChannels;
    }

    const divisor = 2 ** Math.min(this.channelAutoPostThrottleStreak, 3);
    return Math.max(1, Math.ceil(this.channelAutoPostScanMaxChannels / divisor));
  }

  private resolveChannelAutoPostThrottleBackoffMs(): number {
    return Math.min(
      this.channelAutoPostThrottleBackoffMaxMs,
      CHANNEL_AUTO_POST_RATE_LIMIT_BACKOFF_MS *
        2 ** Math.min(Math.max(0, this.channelAutoPostThrottleStreak - 1), 3),
    );
  }

  private deferChannelAutoPostScan(chatId: string, backoffMs: number): void {
    const current =
      this.channelAutoPostScanState.get(chatId) ?? this.createChannelAutoPostScanState();
    this.channelAutoPostScanState.set(chatId, {
      ...current,
      idleStreak: Math.min(current.idleStreak + 1, 8),
      nextScanAtMs: Math.max(current.nextScanAtMs, Date.now() + backoffMs),
    });
  }

  async processNightModeTransitionJob(
    job: NightModeTransitionJob,
  ): Promise<NightModeTransitionProcessResult> {
    return this.nightModeTransitionRuntime.processNightModeTransitionJob(
      job,
      this.createNightModeTransitionHooks(),
    );
  }

  private async processNightModeTransitionForChat(
    settings: Pick<
      ChatSettings,
      | 'chatId'
      | 'nightModeEnabled'
      | 'nightModeStartTimeMinutes'
      | 'nightModeEndTimeMinutes'
      | 'nightModeTimezone'
      | 'nightModeBotMessageEnabled'
      | 'nightModeBotMessageText'
      | 'nightModeCommentsEnabled'
      | 'nightModeOpenMessageEnabled'
      | 'nightModeOpenMessageText'
      | 'nightModeBotButtons'
      | 'nightModeBotButtonEnabled'
      | 'nightModeBotButtonUrl'
      | 'nightModeBotButtonText'
      | 'nightModeRulesButtonEnabled'
      | 'commentsEnabled'
      | 'botSpeechStyle'
      | 'botSpeechMedia'
    > & {
      chat?: {
        entityType?: ChatEntityType | null;
        rules?: {
          publishedUrl: string | null;
          publishedMessageId: string | null;
        } | null;
      } | null;
    },
    providedSnapshot?: NightModeTransitionSnapshot,
  ): Promise<NightModeTransitionProcessResult> {
    return this.nightModeTransitionRuntime.processNightModeTransitionForChat(
      settings,
      this.createNightModeTransitionHooks(),
      providedSnapshot,
    );
  }

  private resolveNightModeTransitionSnapshot(
    settings: Pick<
      ChatSettings,
      | 'nightModeEnabled'
      | 'nightModeStartTimeMinutes'
      | 'nightModeEndTimeMinutes'
      | 'nightModeTimezone'
    >,
    now = new Date(),
  ): NightModeTransitionSnapshot | null {
    return this.nightModeTransitionRuntime.resolveNightModeTransitionSnapshot(settings, now);
  }

  private buildNightModeClosedNoticeOptions(params: {
    chatId: string;
    commentsEnabled: boolean;
    nightModeCommentsEnabled: boolean;
    nightModeBotButtons: unknown;
    nightModeBotButtonEnabled: boolean;
    nightModeBotButtonUrl: string;
    nightModeBotButtonText: string;
    nightModeRulesButtonEnabled?: boolean;
    rulesPublishedUrl?: string | null;
    rulesPublishedMessageId?: string | null;
  }): MaxSendMessageOptions | null {
    const baseOptions = this.buildBotMessageOptions(
      params.chatId,
      params.nightModeBotButtons,
      params.nightModeBotButtonEnabled,
      params.nightModeBotButtonUrl,
      params.nightModeBotButtonText,
      params.nightModeRulesButtonEnabled ?? false,
      params.rulesPublishedUrl ?? null,
      params.rulesPublishedMessageId ?? null,
    );
    const commentsButton = buildNightModeCommentsButton({
      chatId: params.chatId,
      commentsEnabled: params.commentsEnabled,
      nightModeCommentsEnabled: params.nightModeCommentsEnabled,
      buildButton: ({ chatId, threadId, text }) =>
        this.buildChatDialogButton(chatId, 'comments', threadId, text),
    });

    return composeNightModeClosedNoticeOptions({
      baseOptions,
      commentsButton,
    });
  }

  private async resolveNightModeTransitionBotId(chatId: string): Promise<string | null> {
    return resolveNightModeTransitionBotIdForModeration(
      {
        maxBotLinkService: this.maxBotLinkService,
      },
      chatId,
    );
  }

  private scheduleChannelAutoPostStartupScan() {
    const startupDelayMs =
      this.channelAutoPostStartupDelayMs +
      (this.channelAutoPostStartupJitterMs > 0
        ? Math.floor(Math.random() * (this.channelAutoPostStartupJitterMs + 1))
        : 0);
    this.channelAutoPostStartupTimer = setTimeout(() => {
      this.channelAutoPostStartupTimer = null;
      void this.processChannelAutoPostButtons();
    }, startupDelayMs);
    this.channelAutoPostStartupTimer.unref();
  }

  private readPositiveConfigInt(value: unknown, fallback: number, min = 1): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= min) {
      return Math.trunc(numericValue);
    }

    return fallback;
  }

  private readNonNegativeConfigInt(value: unknown, fallback: number): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= 0) {
      return Math.trunc(numericValue);
    }

    return fallback;
  }

  private readFractionConfig(value: unknown, fallback: number): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue > 0 && numericValue <= 1) {
      return numericValue;
    }

    return fallback;
  }

  private readBooleanConfig(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (
        normalized === 'true' ||
        normalized === '1' ||
        normalized === 'yes' ||
        normalized === 'on'
      ) {
        return true;
      }
      if (
        normalized === 'false' ||
        normalized === '0' ||
        normalized === 'no' ||
        normalized === 'off'
      ) {
        return false;
      }
    }

    return fallback;
  }

  private async mapWithConcurrency<T, R>(
    items: readonly T[],
    requestedConcurrency: number,
    mapper: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }

    const results = new Array<R>(items.length);
    const concurrency = Math.min(items.length, Math.max(1, Math.trunc(requestedConcurrency)));
    let nextIndex = 0;

    const workers = Array.from({ length: concurrency }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex]!, currentIndex);
      }
    });

    await Promise.all(workers);
    return results;
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private readStoredMuteDurationHoursFromMetadata(metadata: unknown): number | null {
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const normalizedMetadata = metadata as Record<string, unknown>;
      const value =
        typeof normalizedMetadata.muteDurationHours === 'number'
          ? normalizedMetadata.muteDurationHours
          : normalizedMetadata.banDurationHours;
      if (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= MAX_ACTIVE_MUTE_DURATION_HOURS
      ) {
        return value;
      }
    }

    return null;
  }

  private readPermanentMuteFromMetadata(metadata: unknown): boolean {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return false;
    }

    return (metadata as Record<string, unknown>).mutePermanent === true;
  }

  private readMuteDurationHoursFromMetadata(metadata: unknown, fallback: number): number {
    const storedValue = this.readStoredMuteDurationHoursFromMetadata(metadata);
    if (storedValue !== null) {
      return storedValue;
    }

    if (Number.isInteger(fallback) && fallback >= 1 && fallback <= MAX_ACTIVE_MUTE_DURATION_HOURS) {
      return fallback;
    }

    return DEFAULT_MUTE_DURATION_HOURS;
  }

  private formatMuteDurationLabel(hours: number): string {
    const safeHours =
      Number.isInteger(hours) && hours >= 1 && hours <= 36 ? hours : DEFAULT_MUTE_DURATION_HOURS;
    return `${safeHours}ч`;
  }

  private async readCachedActiveMute(
    chatId: string,
    userId: string,
  ): Promise<ActiveMuteCacheReadResult> {
    const getString = (this.redisCounter as Partial<RedisCounterService> | undefined)?.getString;
    if (typeof getString !== 'function') {
      return { status: 'miss' };
    }

    try {
      const raw = await getString.call(this.redisCounter, buildActiveMuteStateKey(chatId, userId));
      if (raw === null) {
        return { status: 'miss' };
      }
      if (raw === '0') {
        return { status: 'inactive' };
      }

      const parsed = JSON.parse(raw) as Partial<CachedActiveMuteState>;
      const eventId = typeof parsed.eventId === 'string' ? parsed.eventId.trim() : '';
      const permanent = parsed.permanent === true;
      const durationHours =
        typeof parsed.durationHours === 'number' && Number.isFinite(parsed.durationHours)
          ? Math.trunc(parsed.durationHours)
          : Number.NaN;
      const issuedAtMs =
        typeof parsed.issuedAt === 'string' ? Date.parse(parsed.issuedAt) : Number.NaN;
      const expiresAtMs =
        typeof parsed.expiresAt === 'string' ? Date.parse(parsed.expiresAt) : Number.NaN;
      if (!eventId || !Number.isFinite(issuedAtMs)) {
        return { status: 'miss' };
      }

      if (permanent) {
        return {
          status: 'active',
          mute: {
            eventId,
            issuedAt: new Date(issuedAtMs),
            expiresAt: null,
            durationHours: null,
            permanent: true,
          },
        };
      }

      if (
        !Number.isInteger(durationHours) ||
        durationHours < 1 ||
        durationHours > MAX_ACTIVE_MUTE_DURATION_HOURS ||
        !Number.isFinite(expiresAtMs)
      ) {
        return { status: 'miss' };
      }

      const mute: ActiveMute = {
        eventId,
        issuedAt: new Date(issuedAtMs),
        expiresAt: new Date(expiresAtMs),
        durationHours,
        permanent: false,
      };
      if (expiresAtMs <= Date.now()) {
        await this.rememberInactiveActiveMuteState(chatId, userId);
        return { status: 'miss' };
      }

      return {
        status: 'active',
        mute,
      };
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read cached active mute state',
      );
      return { status: 'miss' };
    }
  }

  private async rememberActiveMuteState(
    chatId: string,
    userId: string,
    mute: ActiveMute,
  ): Promise<void> {
    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (typeof setStringWithTtl !== 'function') {
      return;
    }

    const ttlSec = mute.permanent
      ? PERMANENT_ACTIVE_MUTE_CACHE_TTL_SEC
      : mute.expiresAt
        ? Math.ceil((mute.expiresAt.getTime() - Date.now()) / 1_000) + ACTIVE_MUTE_CACHE_SLACK_SEC
        : 0;
    if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
      return;
    }

    try {
      await setStringWithTtl.call(
        this.redisCounter,
        buildActiveMuteStateKey(chatId, userId),
        JSON.stringify({
          eventId: mute.eventId,
          issuedAt: mute.issuedAt.toISOString(),
          expiresAt: mute.expiresAt ? mute.expiresAt.toISOString() : null,
          durationHours: mute.durationHours,
          permanent: mute.permanent,
        } satisfies CachedActiveMuteState),
        ttlSec,
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to cache active mute state',
      );
    }
  }

  private async rememberInactiveActiveMuteState(chatId: string, userId: string): Promise<void> {
    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (typeof setStringWithTtl !== 'function') {
      return;
    }

    try {
      await setStringWithTtl.call(
        this.redisCounter,
        buildActiveMuteStateKey(chatId, userId),
        '0',
        ACTIVE_MUTE_NEGATIVE_CACHE_TTL_SEC,
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to cache inactive active mute state',
      );
    }
  }

  private async resolveSystemModeSnapshot(): Promise<SystemModeSnapshot> {
    if (!this.systemModeService) {
      return this.createFallbackSystemModeSnapshot();
    }

    const systemModeService = this.systemModeService as SystemModeService & {
      peekCachedSnapshot?: (maxAgeMs?: number) => SystemModeSnapshot | null;
      getEffectiveSnapshot?: () => Promise<SystemModeSnapshot>;
      getSnapshot?: () => SystemModeSnapshot;
    };
    if (typeof systemModeService.peekCachedSnapshot === 'function') {
      const cachedSnapshot = systemModeService.peekCachedSnapshot(30_000);
      if (cachedSnapshot) {
        return cachedSnapshot;
      }
    }
    if (typeof systemModeService.getEffectiveSnapshot === 'function') {
      return systemModeService.getEffectiveSnapshot();
    }
    if (typeof systemModeService.getSnapshot === 'function') {
      return systemModeService.getSnapshot();
    }

    return this.createFallbackSystemModeSnapshot();
  }

  private createFallbackSystemModeSnapshot(): SystemModeSnapshot {
    return {
      mode: 'normal',
      source: 'auto',
      reason: 'fallback',
      updatedAt: new Date().toISOString(),
      manualMode: null,
      queueLagSec: 0,
      action: {
        windowSec: 60,
        total: 0,
        success: 0,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
    };
  }

  private async resolveBackgroundPressurePauseReason(): Promise<string | null> {
    if (!this.queueMetricsService) {
      return null;
    }

    try {
      const snapshot = await this.queueMetricsService.getSnapshot({ maxAgeMs: 1_500 });
      if (snapshot.effectiveLagSec >= this.backgroundWorkSoftPauseQueueLagSec) {
        return `queue lag ${snapshot.effectiveLagSec.toFixed(1)}s`;
      }

      const workerGroups = Object.entries(snapshot.webhookDefaultWorkerGroups).map(
        ([groupName, metrics]) => ({
          groupName,
          pressure: metrics.counters.waiting + metrics.counters.active * 3,
        }),
      );
      const totalPressure = workerGroups.reduce((sum, item) => sum + item.pressure, 0);
      const primary = workerGroups.reduce(
        (best, current) => (current.pressure > best.pressure ? current : best),
        { groupName: 'n/a', pressure: 0 },
      );
      const share = totalPressure > 0 ? primary.pressure / totalPressure : 0;
      if (
        totalPressure >= this.backgroundWorkSoftPauseWorkerPressure &&
        share >= this.backgroundWorkSoftPauseWorkerShare
      ) {
        return `default worker skew ${primary.groupName} ${primary.pressure}/${totalPressure}`;
      }
    } catch (error: unknown) {
      this.logger.debug(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to read background pressure snapshot',
      );
    }

    return null;
  }
}

function createWebhookProcessor(
  queueName: AnyWebhookQueueName,
  concurrency: number,
  className: string,
): Type<WorkerHost> {
  @Processor(queueName, {
    concurrency,
  })
  class QueueWebhookProcessor extends WorkerHost {
    constructor(private readonly moderationExecutionService: ModerationExecutionService) {
      super();
    }

    async process(job: Job<ProcessWebhookJob>) {
      if (!roleRunsModeration(getAppRole())) {
        return;
      }
      await this.moderationExecutionService.processWebhookEvent(job.data.webhookEventId);
    }
  }
  Object.defineProperty(QueueWebhookProcessor, 'name', {
    value: className,
  });

  return QueueWebhookProcessor as Type<WorkerHost>;
}

export const LegacyModerationProcessor = createWebhookProcessor(
  LEGACY_WEBHOOK_QUEUE,
  LEGACY_MODERATION_CONCURRENCY,
  'LegacyModerationProcessor',
);

export const CriticalWebhookProcessor = createWebhookProcessor(
  WEBHOOK_QUEUE_CRITICAL,
  CRITICAL_MODERATION_CONCURRENCY,
  'CriticalWebhookProcessor',
);

export const JOIN_WEBHOOK_SHARD_PROCESSORS = JOIN_WEBHOOK_QUEUE_NAMES.map((queueName, index) =>
  createWebhookProcessor(
    queueName,
    JOIN_MODERATION_SHARD_CONCURRENCIES[index] ?? 1,
    `JoinWebhookShard${index}Processor`,
  ),
);

export const DEFAULT_WEBHOOK_SHARD_PROCESSORS = DEFAULT_WEBHOOK_QUEUE_NAMES.map(
  (queueName, index) =>
    createWebhookProcessor(
      queueName,
      DEFAULT_MODERATION_SHARD_CONCURRENCIES[index] ?? 1,
      `DefaultWebhookShard${index}Processor`,
    ),
);

export const BackgroundWebhookProcessor = createWebhookProcessor(
  WEBHOOK_QUEUE_BACKGROUND,
  BACKGROUND_MODERATION_CONCURRENCY,
  'BackgroundWebhookProcessor',
);
