import {
  addDomainRequestSchema,
  chatParticipantImmunitySchema,
  chatParticipantImmunityUpdateRequestSchema,
  chatParticipantImmunityUpdateResultSchema,
  addAdminRequestSchema,
  chatParticipantsPageSchema,
  chatParticipantsQuerySchema,
  chatSettingsScreenResponseSchema,
  channelSettingsScreenResponseSchema,
  channelStatsQuerySchema,
  channelStatsResponseSchema,
  channelDialogResponseSchema,
  type ChannelDialogNotificationMode,
  type ChannelDialogNotificationSettings,
  channelDialogTypeSchema,
  channelSettingsSchema,
  createChannelDialogMessageRequestSchema,
  createChannelDialogMessageResponseSchema,
  deleteChannelDialogMessageRequestSchema,
  deleteChannelDialogMessageResponseSchema,
  dateRangeQuerySchema,
  logsDashboardQuerySchema,
  logsDashboardResponseSchema,
  manualModerationActionRequestSchema,
  manualModerationActionResultSchema,
  moderationFeedPageSchema,
  moderationFeedQuerySchema,
  membershipActivityPageSchema,
  membershipActivityQuerySchema,
  managedEntityBotCapabilitySchema,
  resolveRequiredSubscriptionChannelRequestSchema,
  resolveRequiredSubscriptionChannelResponseSchema,
  type ChannelDialogMessage,
  type ChannelDialogAttachment,
  type ChannelDialogReactionGroup,
  type ChannelDialogReplyPreview,
  type ChannelDialogSuggestionReviewStatus,
  type ToggleChannelDialogReactionResponse,
  type ChatParticipantImmunity,
  type ChatParticipantItem,
  type ChatParticipantImmunityUpdateResult,
  type ChatParticipantsPage,
  type ChatParticipantsQuery,
  type ChannelDialogType,
  type ChannelStatsBucket,
  type ChannelStatsQuery,
  type ChannelStatsRange,
  type ChannelStatsResponse,
  type ChannelOverview,
  type ApplySectionToAllResponse,
  type ApplySettingsTarget,
  type ApplySectionTargetPreviewResponse,
  type ManagedBroadcastDetails,
  type ManagedBroadcastCalendarResponse,
  type ManagedEntityFavoriteType,
  type MembershipActivityPage,
  type MembershipActivityQuery,
  type ManagedBroadcastSummary,
  type ManagedEntityBotCapability,
  type ChannelSettings,
  type ChatSettingsScreenResponse,
  type ChatRules,
  type ChatSettings,
  chatSettingsSchema,
  type ChannelSettingsScreenResponse,
  type DomainAllowlistEntry,
  type LogsDashboardViolation,
  type LogsDashboardRange,
  type LogsDashboardResponse,
  type ManagedEntityType,
  type ManualModerationActionResult,
  type ModerationFeedPage,
  type ModerationFeedQuery,
  type ModerationEvent,
  type PublishChatRulesResult,
  type BroadcastTextFormat,
  type BroadcastLinkButton,
  type ManagedEntityAssignedBot,
  type ManagedEntitiesListResponse,
  type ManagedEntitiesResponseDiff,
  type ManagedEntitiesResponseSnapshot,
  type ManagedEntitiesRefreshState,
  type SendBroadcastResult,
  type SendBroadcastTestResult,
  type ChatSummary,
  type ManagedEntityHeader,
  type ResolveRequiredSubscriptionChannelResponse,
  MAX_CHANNEL_DIALOG_ATTACHMENTS,
  MAX_CHANNEL_DIALOG_SUGGEST_IMAGES,
  inferAllowlistMatchType,
  normalizeMessageLimitsBlockedDomainCandidate,
  normalizeMessageLimitsBlockedWordCandidate,
  normalizeStoredAllowlistEntry,
  parseStoredAllowlistEntry,
  type ManagedPoll,
  scheduleDomainRemovalRequestSchema,
  toggleChannelDialogReactionResponseSchema,
  updateChannelDialogNotificationsRequestSchema,
  updateChannelDialogNotificationsResponseSchema,
  updateChannelDialogMessageRequestSchema,
  updateChannelDialogMessageResponseSchema,
  type AllowlistMatchType,
  DEFAULT_BROADCAST_BUTTON_TEXT,
  MAX_BROADCAST_LINK_BUTTONS,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
  INVITATION_ACCESS_REQUIRED_COUNT_MAX,
  INVITATION_ACCESS_REQUIRED_COUNT_MIN,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN,
  normalizeDeleteBotMessagesDelayMinutes,
} from '@maxim/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import {
  ChatBotMembershipStatus,
  ChatEntityType,
  DialogNotificationMode as PrismaDialogNotificationMode,
  EventType,
  Operator,
  Prisma,
  PrismaClient,
  SanctionAction,
  createPrismaClient,
} from '../prisma/prisma-client';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import {
  ChatContextCacheService,
  type ManagedEntitiesPublishedDiff,
  type ManagedEntitiesPublishedSnapshot,
} from '../chat-context/chat-context-cache.service';
import { collectBotTokenSecrets } from '../common/bot-token.util';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { buildChannelStatsIntelligence } from './channel-stats-intelligence';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxActionDispatchOptions,
  type MaxAttachmentPayload,
  type MaxBotChat,
  type MaxChatMemberAccess,
  type MaxChatMemberRole,
  type MaxChatRosterMember,
  type MaxMessageButton,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import {
  MaxBotLinkService,
  type MaxBotRoute,
  type MaxBotRouteRequest,
} from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MaxBotExecutionPlannerService } from '../max/max-bot-execution-planner.service';
import { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import { ManagedEntityAccessLossService } from '../max/managed-entity-access-loss.service';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import { renderSupportedMarkdownAsHtml } from '../common/max-markdown.util';
import {
  escapeHtml,
  escapeHtmlAttribute,
  escapeHtmlPreservingWhitespace,
  renderMaxTextMarkupAsHtml,
} from '../common/max-text-markup.util';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelStatsCollectorService } from './channel-stats-collector.service';
import { buildDuplicateUserPattern } from '../moderation/duplicate-state';
import { GlobalSpammerIntelligenceService } from '../moderation/global-spammer-intelligence.service';
import { buildModerationEscalationCounterPattern } from '../moderation/moderation-escalation-state.util';
import {
  ACTIVE_MUTE_CACHE_SLACK_SEC,
  ACTIVE_MUTE_NEGATIVE_CACHE_TTL_SEC,
  PERMANENT_ACTIVE_MUTE_CACHE_TTL_SEC,
  buildActiveMuteStateKey,
  type CachedActiveMuteState,
} from '../moderation/moderation-state.util';
import { RedisCounterService } from '../moderation/redis-counter.service';
import {
  SystemModeService,
  isSystemModeRecoveryWindow,
  type SystemModeSnapshot,
} from '../system/system-mode.service';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import {
  ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE,
  type AdminManagedEntitiesRefreshJob,
} from './admin-managed-entities-refresh.queue';
import {
  ADMIN_MANUAL_FANOUT_QUEUE,
  type AdminManualFanoutJob,
  type AdminManualBanFanoutJob,
  type AdminManualGroupModerationCommandJob,
  type AdminManualMuteFanoutJob,
} from './admin-manual-fanout.queue';
import {
  ADMIN_SUGGESTION_DELIVERY_QUEUE,
  type AdminSuggestionDeliveryJob,
} from './admin-suggestion-delivery.queue';
import { AdminDialogLinkHelper } from './admin-dialog-link-helper';
import { toggleDialogReactionValue } from './admin-channel-dialog-reaction';
import { getChannelSuggestionRedirectValue } from './admin-channel-dialog-redirect';
import {
  buildStoredLinkButtonState as buildStoredLinkButtonStateValue,
  decodeRulesImageBase64 as decodeRulesImageBase64Value,
  extractMaxApiErrorMessage as extractMaxApiErrorMessageValue,
  isMaxMessageMissingError as isMaxMessageMissingErrorValue,
  normalizeStoredLinkButtons as normalizeStoredLinkButtonsValue,
  publishChatRules,
  resetPublishedChatRules,
  resolveRulesImageFileName as resolveRulesImageFileNameValue,
  saveChatRulesDraft,
} from './admin-chat-rules';
import { AdminChatRulesTextRuntime } from './admin-chat-rules-text-runtime';
import {
  publishChannelEngagementMessage as publishChannelEngagementMessageValue,
  type BuildChannelEngagementDialogArtifactsParams,
  type ChannelEngagementDialogArtifacts,
} from './admin-channel-engagement';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';
import {
  applySettingsSectionToAllChats as applySettingsSectionToAllChatsValue,
  applySettingsToAllChats as applySettingsToAllChatsValue,
  previewApplySettingsSectionTarget as previewApplySettingsSectionTargetValue,
} from './admin-settings-apply';
import {
  readChannelSettings as readChannelSettingsValue,
  saveChannelSettings as saveChannelSettingsValue,
} from './admin-channel-settings';
import {
  readChatSettings as readChatSettingsValue,
  saveChatSettings as saveChatSettingsValue,
  type ResolvedBotAssignmentData,
} from './admin-chat-settings';
import {
  closeManagedPoll as closeManagedPollValue,
  publishManagedPoll as publishManagedPollValue,
  readManagedPoll as readManagedPollValue,
  saveManagedPollDraft as saveManagedPollDraftValue,
} from './admin-managed-poll';
import { getManagedEntityHeaderValue } from './admin-managed-entity-header';
import {
  listManagedEntitiesValue,
  listManagedEntitiesWithRefreshStateValue,
} from './admin-managed-entities-list';
import {
  buildProfileMentionHandoffUrl,
  buildUserProfileUrl,
  normalizeLegacyProfileButtonUrl,
  normalizeMaxProfileUrl,
} from './admin-profile-links';
import { resolveRequiredSubscriptionChannelByKnownLink } from './admin-required-subscription-catalog';
import {
  buildChannelOverview,
  buildChatParticipantsPageCacheKey,
  buildLogsDashboardResponseCacheKey,
  buildMembershipActivityFeedPageCacheKey,
  buildModerationFeedPageCacheKey,
  buildResolvedUserProfileCacheKey,
  fromPrismaEntityType,
  isBotAdminLookupDeniedError,
  isFallbackTitle,
  isMaxApiThrottleError,
  isMaxApiTimeoutError,
  isPrivateDialogChatUnavailableError,
  isPrivateDirectChat,
  isPrismaKnownError,
  isUnsupportedManagedChat,
  mapWithConcurrencyLimit,
  normalizeAppBaseUrl,
  normalizeBotContactId,
  normalizeOwnBotUserId,
  resolvePresentableManagedEntityTitle,
  toPrismaEntityType,
} from './admin-legacy-utils';
import {
  selectLogsDashboardMembershipSummary,
  selectLogsDashboardModerationSummary,
} from './logs-dashboard-rollups';
import {
  selectChannelStatsContentBucketRows,
  selectChannelStatsMembershipBucketRows,
  selectModerationFeedReadModelRows,
  type ChannelStatsContentBucketRow,
  type ChannelStatsMembershipBucketRow,
} from './stats-read-model-selectors';

import {
  DEFAULT_GROUP_COMMAND_MUTE_DURATION_HOURS,
  ADMIN_ACCESS_VALIDATION_ROSTER_SYNC_THROTTLE_MS,
  BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS,
  BROADCAST_THROTTLE_RETRY_DELAYS_MS,
  BROADCAST_TIMEOUT_RETRY_DELAYS_MS,
  LOGS_DASHBOARD_VIOLATIONS_LIMIT,
  MEMBERSHIP_ACTIVITY_PAGE_LIMIT,
  LOGS_DASHBOARD_RESPONSE_CACHE_TTL_MS,
  SLOW_LOGS_DASHBOARD_THRESHOLD_MS,
  EVENTS_FEED_PAGE_CACHE_TTL_MS,
  CHANNEL_STATS_RESPONSE_CACHE_TTL_MS,
  CHANNEL_STATS_REFRESHING_RESPONSE_CACHE_TTL_MS,
  SLOW_CHANNEL_STATS_THRESHOLD_MS,
  RESOLVED_USER_PROFILE_CACHE_TTL_MS,
  CHAT_PARTICIPANTS_SEARCH_REMOTE_PAGES_PER_RESPONSE,
  CHAT_PARTICIPANTS_SEARCH_MAX_API_WAIT_MS,
  ONE_HOUR_MS,
  TWENTY_FOUR_HOURS_MS,
  DEFAULT_PARTICIPANT_IMMUNITY_TIMEZONE,
  MANUAL_BAN_RECENT_MESSAGE_DELETE_LIMIT,
  LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
  MANAGED_ENTITIES_DELTA_ADMIN_CHECK_SPACING_MS,
  MANAGED_ENTITIES_FULL_SCAN_ADMIN_CHECK_SPACING_MS,
  MANAGED_ENTITIES_DELTA_DISCOVERY_WINDOW_SIZE,
  MANAGED_ENTITIES_REFRESH_UNCACHED_LIMIT,
  MANAGED_ENTITIES_REFRESH_SCAN_WINDOW_SIZE,
  MANAGED_ENTITIES_BACKGROUND_CATALOG_SYNC_WINDOW_SIZE,
  MANAGED_ENTITIES_LOCAL_REFRESH_SCAN_WINDOW_SIZE,
  MANAGED_ENTITIES_ALLOWLIST_CACHE_TTL_MS,
  MANAGED_ENTITIES_ALLOWLIST_RESPONSE_BUDGET_MS,
  MANAGED_ENTITIES_ALLOWLIST_EDGE_REPAIR_BATCH_SIZE,
  MANAGED_ENTITIES_SUSPICIOUS_ALLOWLIST_REVALIDATION_LIMIT,
  MANAGED_ENTITIES_SUSPICIOUS_ALLOWLIST_ADMIN_TIMEOUT_MS,
  MANAGED_ENTITIES_LAST_SUCCESS_SNAPSHOT_TTL_MS,
  MANAGED_ENTITIES_LIGHTWEIGHT_RECENT_BOOTSTRAP_RESPONSE_BUDGET_MS,
  MANAGED_ENTITIES_RESPONSE_WARMUP_BUDGET_MS,
  MANAGED_ENTITIES_LOCAL_DISCOVERY_ADMIN_TIMEOUT_MS,
  MANAGED_ENTITIES_REMOTE_DELTA_ADMIN_TIMEOUT_MS,
  MANAGED_ENTITIES_REMOTE_FULL_SCAN_ADMIN_TIMEOUT_MS,
  MANAGED_ENTITIES_REMOTE_DELTA_SNAPSHOT_TIMEOUT_MS,
  MANAGED_ENTITIES_REMOTE_FULL_SCAN_SNAPSHOT_TIMEOUT_MS,
  MANAGED_ENTITIES_PRIORITY_ALLOWLIST_WARMUP_LIMIT,
  MANAGED_ENTITIES_REFRESH_CURSOR_DONE,
  MANAGED_ENTITIES_REFRESH_CURSOR_TTL_SEC,
  MANAGED_ENTITIES_REFRESH_CURSOR_DONE_TTL_SEC,
  MANAGED_ENTITIES_REFRESH_SNAPSHOT_TTL_SEC,
  MANAGED_ENTITIES_REFRESH_LAST_SYNCED_TTL_SEC,
  MANAGED_ENTITIES_PUBLISHED_DIFF_MAX_CHANGE_RATIO,
  MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC,
  MANAGED_ENTITIES_REFRESH_SUCCESS_COOLDOWN_MS,
  MANAGED_ENTITIES_MANUAL_REFRESH_RECENT_SYNC_WINDOW_MS,
  MANAGED_ENTITIES_REFRESH_BACKOFF_MS,
  MANAGED_ENTITIES_REFRESH_FRESHNESS_WINDOW_MS,
  MANAGED_ENTITIES_REFRESH_NEXT_POLL_AFTER_MS,
  MANAGED_ENTITIES_REFRESH_IDLE_NEXT_POLL_AFTER_MS,
  MANAGED_ENTITIES_REFRESH_DEGRADE_PAUSE_RETRY_MS,
  MANAGED_ENTITIES_REFRESH_QUEUE_LAG_SLOW_PATH_MAX_SEC,
  MANAGED_ENTITIES_DEGRADE_PAUSE_LOG_INTERVAL_MS,
  MANAGED_ENTITIES_DISCOVERY_HEADER_PRIME_COOLDOWN_MS,
  MANAGED_ENTITIES_DISCOVERY_HEADER_PRIME_CONCURRENCY,
  MANAGED_BOT_CHAT_CATALOG_WRITE_CONCURRENCY,
  MANAGED_BOT_CHAT_CATALOG_FALLBACK_LIMIT,
  MANAGED_BOT_CHAT_CATALOG_MARK_MISSING_MAX_SEEN,
  MANAGED_ENTITIES_MASS_ACTION_FULL_SCAN_MAX_PASSES,
  MANAGED_ENTITY_HEADER_HYDRATION_BATCH_SIZE,
  MANAGED_ENTITY_HEADER_HYDRATION_CONCURRENCY,
  ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
  ADMIN_ACTION_HEALTH_LANE,
  ADMIN_MANUAL_GROUP_COMMAND_QUEUE_PRIORITY,
  ADMIN_MANUAL_FANOUT_QUEUE_PRIORITY,
  APPLY_SETTINGS_TO_ALL_READINESS_REFRESH_CONCURRENCY,
  APPLY_SETTINGS_TO_ALL_READINESS_REFRESH_SPACING_MS,
  APPLY_SETTINGS_TO_ALL_DOMAIN_SYNC_CONCURRENCY,
  REQUIRED_SUBSCRIPTION_CHANNEL_CHECK_CONCURRENCY,
  CHANNEL_DIALOG_MESSAGES_LIMIT,
  COMMENT_NOTIFICATION_DELIVERY_CONCURRENCY,
  COMMENT_NOTIFICATION_PREVIEW_MAX_LENGTH,
  CHANNEL_DIALOG_ACTION_COMMENT,
  CHANNEL_DIALOG_ACTION_SUGGEST,
  CHANNEL_DIALOG_ACTION_PUBLISH,
  CHANNEL_DIALOG_ACTION_AUTO_ATTACH,
  CHAT_DIALOG_ACTION_AUTO_ATTACH,
  PRIVATE_CONTROL_CALLBACK_PREFIX,
  CHANNEL_DIALOG_START_PARAM_PREFIX,
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_CHANNEL_SETTINGS,
  CHAT_SETTINGS_BUTTON_GROUPS,
  CHANNEL_SETTINGS_BUTTON_URL_KEYS,
  CHANNEL_SETTINGS_BUTTON_ENABLED_BY_URL_KEY,
  MANAGED_ENTITY_FAVORITE_TYPE_ORDER,
  PRISMA_FAVORITE_TYPE_BY_CONTRACT,
  CONTRACT_FAVORITE_TYPE_BY_PRISMA,
  REQUIRED_SUBSCRIPTION_DURATION_DAY_MS,
  CHANNEL_STATS_POST_ACTIONS,
  CHANNEL_STATS_ACTIVITY_ACTIONS,
  CHANNEL_STATS_MISSING_METRICS,
  CHANNEL_STATS_REFRESH_STALE_MS,
  CHANNEL_COMMENT_DUPLICATE_WINDOW_MS,
  CHANNEL_COMMENT_MAX_CONSECUTIVE,
  CHANNEL_COMMENT_LINK_PATTERN,
  RECENT_BOT_ADDED_BOOTSTRAP_LIMIT,
  RECENT_BOT_ADDED_USER_SCOPED_WEBHOOK_SCAN_LIMIT,
  RECENT_BOT_ADDED_WEBHOOK_SCAN_LIMIT,
  RECENT_BOT_ADDED_BOOTSTRAP_MAX_ELAPSED_MS,
  RECENT_BOT_ADDED_BOOTSTRAP_MAX_ADMIN_CHECKS,
  RECENT_BOT_ADDED_BOOTSTRAP_ADMIN_TIMEOUT_MS,
  RECENT_BOT_ADDED_BOOTSTRAP_HEADER_RESPONSE_BUDGET_MS,
  RECENT_BOT_ADDED_BOOTSTRAP_HEADER_TIMEOUT_MS,
  RECENT_BOT_ADDED_FAST_LANE_RETRY_WINDOW_MS,
  SETTINGS_SCREEN_ADMIN_CHECK_TIMEOUT_MS,
  MANAGED_ENTITIES_LOCAL_CANDIDATE_LIMIT,
  MANAGED_ENTITIES_LOCAL_ACTIVITY_LOOKBACK_MS,
  MANAGED_ENTITY_ACCESS_EDGE_GRANTED_TTL_MS,
  MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS,
  MANAGED_ENTITIES_LOCAL_ACTIVITY_EVENT_TYPES,
  LOCAL_USER_DISPLAY_NAME_EVENT_TYPES,
  ManagedEntitiesRefreshThrottledError,
  mapManagedEntityTypeToChatEntityType,
  readBooleanConfigFlag,
  readNonNegativeConfigInt,
  sleep,
  sleepIfNeeded,
  type ApplySettingsToAllChatsResult,
  type ManagedEntityTypeFilter,
  type ManagedEntitiesListResult,
  type ManagedEntitiesRefreshPresentation,
  type ManagedEntitiesRefreshJobOutcome,
  type ManagedEntitiesManualRefreshBlockReason,
  type ManagedEntitiesPublishedSnapshotReadResult,
  type ManagedEntitiesPublishedDiffReadResult,
  type ChannelPublicationEngagementContext,
  type ManagedEntitiesListOptions,
  type ManagedEntitiesDiscoverySnapshot,
  type ManagedBotChatCatalogSnapshotRow,
  type ManagedBotChatMembershipSnapshotRow,
  type ManagedEntityBotProfileSnapshot,
  type AssertChatAdminOptions,
  type AdminReadBypassOptions,
  type TimedPromiseCacheEntry,
  type TimedValueCacheEntry,
  type ManagedEntityBotAssignmentsRow,
  type AdminAccessResolution,
  type ManagedEntityAccessRoleValue,
  type ManagedEntityAccessStateValue,
  type ManagedEntityAccessEdgeClient,
  type AdminActionSource,
  type ManualBanFollowUpSource,
  type AdoptChatRulesFromMessageInput,
  type ManualMemberModerationAction,
  type ManualMemberManageMembersAction,
  type ManualModerationBotAction,
  type ManualBanExecutionMode,
  type ManualUnbanExecutionMode,
  type ManualModerationExecutionOptions,
  type ResolveManualModerationActionBotAssignmentOptions,
  type ResolvedUserProfile,
  type ResolveUserProfilesOptions,
  type ModerationFeedCursor,
  type ChatParticipantsSearchCursor,
  type ChannelSuggestionActor,
  type ChannelSuggestionImageAsset,
  type ChannelDialogAttachmentAsset,
  type ChannelSuggestionTextMarkup,
  type ChannelSuggestionDeliveryInput,
  type ModerationViolationRow,
  type MembershipEventRow,
  type ChannelStatsViewMode,
  type ChannelStatsPostRow,
  type ChannelStatsViewSnapshotRow,
  type ChannelStatsPostViewMetric,
  type ChannelStatsContentBucketPoint,
  type ChannelStatsPeriodTotals,
  type ChannelStatsComparisonSeries,
  type ChannelStatsPreviousPeriodSnapshot,
  type ChannelStatsDeltaMetric,
  type ChannelStatsSignalTone,
  type ChannelStatsSignal,
  type ChannelStatsGraphMarker,
  type ChannelStatsBestWindow,
  type ChannelDialogMessageSource,
  type DialogMessageEntityType,
  type CommentDialogNotificationKind,
  type ChannelSuggestionFromBotPayload,
  type ChannelSuggestionReviewAction,
  type ChannelSuggestionAdminDelivery,
} from './admin.service.support';
export type {
  AdminActionSource,
  ChannelPublicationEngagementContext,
} from './admin.service.support';

@Injectable()
export class AdminService implements OnModuleDestroy {
  private readonly logger = new Logger(AdminService.name);
  private readonly managedBroadcastRuntime = new AdminManagedBroadcastRuntime(this);
  private readonly chatRulesTextRuntime = new AdminChatRulesTextRuntime(this);
  private readonly appBaseUrl: string | null;
  private readonly explicitBotContactId: string | null;
  private readonly ownBotUserId: string | null;
  private readonly managedEntitiesRuntimeBotIds: ReadonlySet<string>;
  private readonly maxBotToken: string;
  private readonly maxBotTokenValidationSecrets: readonly string[];
  private readonly dialogLinkHelper: AdminDialogLinkHelper;
  private readonly manualFanoutLookupSpacingMs: number;
  private readonly manualFanoutActionSpacingMs: number;
  private readonly managedEntitiesPublishedSnapshotReadEnabled: boolean;
  private readonly managedEntitiesPublishedSnapshotWriteEnabled: boolean;
  private readonly managedEntitiesPublishedDiffReadEnabled: boolean;
  private readonly managedEntitiesPublishedDiffWriteEnabled: boolean;
  private readonly adminAccessChecks = new Map<string, Promise<AdminAccessResolution>>();
  private readonly managedEntitiesDiscoveryChecks = new Map<
    string,
    Promise<ManagedEntitiesListResult>
  >();
  private readonly managedEntitiesRefreshCooldownUntilMs = new Map<string, number>();
  private readonly managedEntitiesRefreshBackoffUntilMs = new Map<string, number>();
  private readonly managedEntityHeaderHydrationRuns = new Map<string, Promise<void>>();
  private readonly recentBotAddedImmediateHeaderHydrationRuns = new Map<
    string,
    Promise<ChatSummary>
  >();
  private readonly managedEntitiesBackgroundRefreshRuns = new Map<string, Promise<void>>();
  private readonly managedEntitiesAllowlistCache = new Map<
    string,
    TimedPromiseCacheEntry<ChatSummary[]>
  >();
  private readonly managedEntitiesLastSuccessCache = new Map<
    string,
    TimedValueCacheEntry<ChatSummary[]>
  >();
  private readonly managedEntitiesReadPrisma: PrismaClient | null;
  private readonly managedEntitiesResponseWarmupRuns = new Map<
    string,
    Promise<ManagedEntitiesListResult>
  >();
  private readonly managedEntitiesAllowlistWarmupRuns = new Map<string, Promise<void>>();
  private readonly managedEntitiesColdStartRefreshScheduleRuns = new Map<string, Promise<void>>();
  private readonly managedEntitiesPublishedSnapshotRuns = new Map<string, Promise<void>>();
  private readonly managedEntitiesDiscoveryHeaderPrimeRuns = new Map<string, Promise<void>>();
  private readonly managedEntitiesDiscoveryHeaderPrimeCooldownUntilMs = new Map<string, number>();
  private readonly managedEntitiesCatalogSyncCursorByScope = new Map<string, number>();
  private readonly pendingPersistedChatAccessPrunes = new Set<string>();
  private persistedChatAccessPruneChain: Promise<void> = Promise.resolve();
  private managedEntitiesDegradePauseLogAtMs = 0;
  private readonly logsDashboardResponseCache = new Map<
    string,
    TimedPromiseCacheEntry<LogsDashboardResponse>
  >();
  private readonly channelStatsResponseCache = new Map<
    string,
    TimedPromiseCacheEntry<ChannelStatsResponse>
  >();
  private readonly channelStatsRefreshRuns = new Map<string, Promise<void>>();
  private readonly moderationFeedPageCache = new Map<
    string,
    TimedPromiseCacheEntry<ModerationFeedPage>
  >();
  private readonly adminAccessValidationRosterSyncScheduledAtMs = new Map<string, number>();
  private readonly membershipActivityFeedPageCache = new Map<
    string,
    TimedPromiseCacheEntry<MembershipActivityPage>
  >();
  private readonly chatParticipantsPageCache = new Map<
    string,
    TimedPromiseCacheEntry<ChatParticipantsPage>
  >();
  private readonly resolvedUserProfileCache = new Map<
    string,
    TimedPromiseCacheEntry<ResolvedUserProfile>
  >();
  private managedBroadcastDegradePauseLogAtMs = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly chatContextCache: ChatContextCacheService,
    configService: ConfigService,
    @Optional()
    private readonly channelStatsCollector?: ChannelStatsCollectorService,
    @Optional() private readonly redisCounter?: RedisCounterService,
    @Optional()
    @InjectQueue(ADMIN_MANUAL_FANOUT_QUEUE)
    private readonly adminManualFanoutQueue?: Queue<AdminManualFanoutJob>,
    @Optional()
    @InjectQueue(ADMIN_SUGGESTION_DELIVERY_QUEUE)
    private readonly adminSuggestionDeliveryQueue?: Queue<AdminSuggestionDeliveryJob>,
    @Optional() private readonly maxBotLinkService?: MaxBotLinkService,
    private readonly maxBotRegistry?: MaxBotRegistryService,
    @Optional() private readonly maxBotExecutionPlanner?: MaxBotExecutionPlannerService,
    @Optional()
    @InjectQueue(ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE)
    private readonly adminManagedEntitiesRefreshQueue?: Queue<AdminManagedEntitiesRefreshJob>,
    @Optional() private readonly systemModeService?: SystemModeService,
    @Optional()
    private readonly backgroundRuntimeGovernorService?: BackgroundRuntimeGovernorService,
    @Optional()
    private readonly maxChatAdminRosterSyncService?: MaxChatAdminRosterSyncService,
    @Optional()
    private readonly globalSpammerIntelligence?: GlobalSpammerIntelligenceService,
    @Optional()
    private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
  ) {
    const configuredBotTokens = collectBotTokenSecrets(
      configService.getOrThrow<string>('MAX_BOT_TOKEN'),
      configService.get<string>('MAX_BOT_TOKEN_PREVIOUS'),
    );
    this.maxBotToken =
      this.maxBotLinkService?.getBotTokenSync?.() ??
      configuredBotTokens[0] ??
      configService.getOrThrow<string>('MAX_BOT_TOKEN');
    this.maxBotTokenValidationSecrets =
      this.maxBotLinkService?.getValidationTokens?.() ??
      (configuredBotTokens.length > 0 ? configuredBotTokens : [this.maxBotToken]);
    this.appBaseUrl = normalizeAppBaseUrl(configService.get<string>('APP_BASE_URL'));
    this.explicitBotContactId = normalizeBotContactId(
      configService.get<string>('MAX_BOT_CONTACT_ID'),
    );
    this.ownBotUserId = normalizeOwnBotUserId(configService.get<string>('MAX_BOT_ID'));
    this.dialogLinkHelper = new AdminDialogLinkHelper({
      appBaseUrl: this.appBaseUrl,
      explicitBotContactId: this.explicitBotContactId,
      ownBotUserId: this.ownBotUserId,
      maxBotToken: this.maxBotToken,
      maxBotTokenValidationSecrets: this.maxBotTokenValidationSecrets,
      maxBotLinkService: this.maxBotLinkService,
      maxBotRegistry: this.maxBotRegistry,
    });
    const registryBotIds =
      typeof this.maxBotRegistry?.getAllBots === 'function'
        ? this.maxBotRegistry.getAllBots().map((bot) => bot.id)
        : [];
    this.managedEntitiesRuntimeBotIds = new Set(
      [...registryBotIds, this.readTrimmedString(configService.get<string>('MAX_BOT_ID'))].filter(
        (botId): botId is string => Boolean(botId),
      ),
    );
    this.manualFanoutLookupSpacingMs = readNonNegativeConfigInt(
      configService.get<number>('MANUAL_FANOUT_LOOKUP_SPACING_MS'),
      process.env.NODE_ENV === 'test' ? 0 : 180,
    );
    this.manualFanoutActionSpacingMs = readNonNegativeConfigInt(
      configService.get<number>('MANUAL_FANOUT_ACTION_SPACING_MS'),
      process.env.NODE_ENV === 'test' ? 0 : 120,
    );
    this.managedEntitiesPublishedSnapshotReadEnabled = readBooleanConfigFlag(
      configService.get<string>('MANAGED_ENTITIES_SNAPSHOT_READ_ENABLED'),
      true,
    );
    this.managedEntitiesPublishedSnapshotWriteEnabled = readBooleanConfigFlag(
      configService.get<string>('MANAGED_ENTITIES_SNAPSHOT_WRITE_ENABLED'),
      true,
    );
    this.managedEntitiesPublishedDiffReadEnabled = readBooleanConfigFlag(
      configService.get<string>('MANAGED_ENTITIES_DIFF_READ_ENABLED'),
      true,
    );
    this.managedEntitiesPublishedDiffWriteEnabled = readBooleanConfigFlag(
      configService.get<string>('MANAGED_ENTITIES_DIFF_WRITE_ENABLED'),
      true,
    );
    this.managedEntitiesReadPrisma = this.createManagedEntitiesReadPrisma(
      configService.get<string>('DATABASE_URL'),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.managedEntitiesReadPrisma?.$disconnect();
  }

  private createManagedEntitiesReadPrisma(databaseUrl?: string | null): PrismaClient | null {
    const dedicatedUrl = this.buildManagedEntitiesReadDatabaseUrl(databaseUrl);
    if (!dedicatedUrl) {
      return null;
    }

    return createPrismaClient(dedicatedUrl);
  }

  private buildManagedEntitiesReadDatabaseUrl(databaseUrl?: string | null): string | null {
    const normalized = databaseUrl?.trim();
    if (!normalized) {
      return null;
    }

    try {
      const url = new URL(normalized);
      url.searchParams.set('connection_limit', '2');
      url.searchParams.set('pool_timeout', '2');
      return url.toString();
    } catch {
      return null;
    }
  }

  private getManagedEntitiesReadPrisma():
    | PrismaClient
    | Pick<PrismaService, 'chatAdminAllowlist' | '$queryRaw' | 'chat'> {
    return this.managedEntitiesReadPrisma ?? this.prisma;
  }

  async listChats(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ChatSummary[]> {
    return this.listManagedEntities(user, 'chat', options);
  }

  async listChatsForMassBroadcast(
    user: AuthUser,
    options: {
      discoveryMode?: 'full' | 'cached-first';
    } = {},
  ): Promise<ChatSummary[]> {
    return this.collectManagedEntitiesForMassAction(user, 'chat', {
      discoveryMode: options.discoveryMode ?? 'full',
    });
  }

  async listChannels(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ChatSummary[]> {
    return this.listManagedEntities(user, 'channel', options);
  }

  async listChatsWithRefreshState(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResponse> {
    return this.listManagedEntitiesWithRefreshStateForType(user, 'chat', options);
  }

  async listChannelsWithRefreshState(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResponse> {
    return this.listManagedEntitiesWithRefreshStateForType(user, 'channel', options);
  }

  private listManagedEntitiesWithRefreshStateForType(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResponse> {
    return listManagedEntitiesWithRefreshStateValue({
      user,
      entityType,
      options,
      listDetailed: (listUser, entityType, listOptions) =>
        this.listManagedEntitiesDetailed(listUser, entityType, listOptions),
      attachFavoriteTypes: (userId, items) => this.attachManagedEntityFavoriteTypes(userId, items),
      attachFavoriteTypesToDiff: (userId, diff) =>
        this.attachManagedEntityFavoriteTypesToDiff(userId, diff),
      createIdleRefreshState: () => this.createManagedEntitiesRefreshState(null, false),
    });
  }

  async listManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter = 'all',
    options: ManagedEntitiesListOptions = {},
  ): Promise<ChatSummary[]> {
    return listManagedEntitiesValue({
      user,
      entityType,
      options,
      listDetailed: (listUser, listEntityType, listOptions) =>
        this.listManagedEntitiesDetailed(listUser, listEntityType, listOptions),
      attachFavoriteTypes: (userId, items) => this.attachManagedEntityFavoriteTypes(userId, items),
    });
  }

  listManagedEntitiesDetailedForManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter = 'all',
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResult> {
    return this.listManagedEntitiesDetailed(user, entityType, options);
  }

  createIdleManagedEntitiesRefreshStateForManagedEntities(): ManagedEntitiesRefreshState {
    return this.createManagedEntitiesRefreshState(null, false);
  }

  async previewApplySettingsSectionTarget(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ApplySectionTargetPreviewResponse> {
    await this.assertManagedEntityAdminAccess(sourceChatId, user.userId, 'chat');
    return previewApplySettingsSectionTargetValue({
      sourceChatId,
      body,
      resolveTargetChats: (target) =>
        this.resolveSettingsApplyTargetChatsForSettings(sourceChatId, user, target),
    });
  }

  async getChatHeader(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedEntityHeader> {
    return this.getManagedEntityHeader(chatId, user, 'chat', options);
  }

  async getChannelHeader(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedEntityHeader> {
    return this.getManagedEntityHeader(chatId, user, 'channel', options);
  }

  private async listManagedEntitiesDetailed(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter = 'all',
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResult> {
    let lightweightBootstrapPromise: Promise<{
      recentBotAdded: ChatSummary[];
    }> | null = null;
    const loadLightweightBootstrap = async () => {
      if (lightweightBootstrapPromise === null) {
        lightweightBootstrapPromise = this.loadManagedEntitiesLightweightBootstrap(
          user,
          entityType,
        );
      }

      return lightweightBootstrapPromise;
    };
    const mergeWithLightweightBootstrap = async (
      items: readonly ChatSummary[],
    ): Promise<ChatSummary[]> => {
      return this.mergeManagedEntitiesWithLightweightBootstrap(
        items,
        await loadLightweightBootstrap(),
      );
    };
    const mergePublishedSnapshotWithLightweightBootstrap = async (
      items: readonly ChatSummary[],
    ): Promise<ChatSummary[]> => {
      return this.mergeManagedEntitiesPublishedSnapshotWithLightweightBootstrap(
        items,
        await loadLightweightBootstrap(),
      );
    };

    if (options.refresh !== true) {
      if (options.fresh === true) {
        try {
          const fresh = await this.discoverManagedEntities(user, entityType, {
            respectCooldown: false,
            fullScan: false,
            includeRefreshState: options.includeRefreshState === true,
            bypassRemoteCache: true,
            revalidateCachedChats: true,
            resetRefreshCursor: options.resetRefreshCursor === true,
            throwOnFailure: true,
          });
          const mergedFresh = await mergeWithLightweightBootstrap(fresh.items);
          const items = await this.attachManagedEntityBotAssignments(mergedFresh);
          this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items, {
            deferStart: true,
          });
          this.scheduleManagedEntitiesPublishedSnapshotRebuild(user.userId, entityType);
          return {
            items,
            refresh: fresh.refresh,
          };
        } catch {
          // Fall back to the persisted allowlist only when the live refresh itself fails.
        }
      }

      const publishedSnapshot = await this.readManagedEntitiesPublishedSnapshotForResponse(
        user.userId,
        entityType,
      );
      if (publishedSnapshot) {
        const items = await mergePublishedSnapshotWithLightweightBootstrap(publishedSnapshot.items);
        this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items, {
          deferStart: true,
        });
        const refreshState =
          options.includeRefreshState === true
            ? await this.readLocalManagedEntitiesRefreshState(user.userId, entityType)
            : null;
        return {
          items,
          refresh: refreshState,
          snapshot: this.createManagedEntitiesResponseSnapshotMetadata(
            publishedSnapshot,
            refreshState,
          ),
        };
      }

      const cached = await this.revalidateCachedManagedEntities(
        user,
        await this.listChatsFromAllowlistWithinResponseBudget(user.userId, entityType, {
          source: 'default',
        }),
      );
      const initial = await mergeWithLightweightBootstrap(cached);
      if (cached.length === 0) {
        this.scheduleManagedEntitiesPriorityAllowlistWarmup(user, entityType, {
          seededChats: initial,
        });
        this.scheduleManagedEntitiesColdStartRemoteFullRefresh(user, entityType);
      }
      if (initial.length > 0) {
        const items = await this.attachManagedEntityBotAssignments(
          await this.hydrateManagedEntities(initial),
        );
        this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items, {
          deferStart: true,
        });
        return {
          items,
          refresh:
            options.includeRefreshState === true
              ? await this.readLocalManagedEntitiesRefreshState(user.userId, entityType)
              : null,
        };
      }

      const warmupPromise = this.shouldRunManagedEntitiesRemoteResponseWarmup()
        ? this.startManagedEntitiesResponseWarmup(user, entityType, {
            bypassRemoteCache: options.bypassRemoteCache === true,
            resetRefreshCursor: options.resetRefreshCursor === true,
            includeRefreshState: options.includeRefreshState === true,
          })
        : null;
      const discovered = warmupPromise
        ? await this.awaitManagedEntitiesResponseValueWithinBudget(warmupPromise, {
            fallback: {
              items: [],
              refresh: null,
            },
            budgetMs: MANAGED_ENTITIES_RESPONSE_WARMUP_BUDGET_MS,
            timeoutMessage:
              'Detached managed entities discovery warmup from default response after response budget exceeded',
            failureMessage: 'Managed entities discovery warmup failed during default response',
            logData: {
              entityType,
              source: 'default',
              userId: user.userId,
            },
          })
        : {
            items: [],
            refresh: null,
          };
      const discoveredItems = this.mergeManagedEntityGroups(initial, discovered.items);
      const items =
        discoveredItems.length > 0
          ? await this.attachManagedEntityBotAssignments(
              await this.hydrateManagedEntities(discoveredItems),
            )
          : [];
      this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items, {
        deferStart: true,
      });

      return {
        items,
        refresh: discovered.refresh,
      };
    }

    const eagerWarmupPromise =
      this.shouldRunManagedEntitiesRemoteResponseWarmup() &&
      (options.bypassRemoteCache === true || options.resetRefreshCursor === true)
        ? this.startManagedEntitiesResponseWarmup(user, entityType, {
            bypassRemoteCache: options.bypassRemoteCache === true,
            resetRefreshCursor: options.resetRefreshCursor === true,
            includeRefreshState: false,
          })
        : null;
    const refresh = await this.scheduleManagedEntitiesRemoteFullRefresh(user, entityType, {
      bypassRemoteCache: options.bypassRemoteCache === true,
      resetRefreshCursor: options.resetRefreshCursor === true,
    });
    const publishedSnapshot = await this.readManagedEntitiesPublishedSnapshotForResponse(
      user.userId,
      entityType,
    );
    if (publishedSnapshot) {
      const bootstrap =
        options.sinceVersion !== undefined ? await loadLightweightBootstrap() : null;
      const snapshotIds =
        bootstrap !== null ? new Set(publishedSnapshot.items.map((item) => item.id)) : null;
      const hasBootstrapOutsideSnapshot =
        bootstrap !== null && bootstrap.recentBotAdded.some((item) => !snapshotIds?.has(item.id));
      if (!hasBootstrapOutsideSnapshot) {
        const diffResponse = await this.readManagedEntitiesPublishedDiffResponseForRefresh(
          user.userId,
          entityType,
          options.sinceVersion,
          publishedSnapshot,
          refresh,
          {
            bypassRemoteCache: options.bypassRemoteCache === true,
            resetRefreshCursor: options.resetRefreshCursor === true,
          },
        );
        if (diffResponse) {
          return diffResponse;
        }
      }

      const snapshotItems =
        options.bypassRemoteCache === true ||
        options.resetRefreshCursor === true ||
        hasBootstrapOutsideSnapshot
          ? await mergePublishedSnapshotWithLightweightBootstrap(publishedSnapshot.items)
          : publishedSnapshot.items;
      this.scheduleManagedEntityHeaderHydration(user.userId, entityType, snapshotItems);
      return {
        items: snapshotItems,
        refresh,
        snapshot: this.createManagedEntitiesResponseSnapshotMetadata(publishedSnapshot, refresh),
      };
    }
    const cached = await this.revalidateCachedManagedEntities(
      user,
      await this.listChatsFromAllowlistWithinResponseBudget(user.userId, entityType, {
        source: 'refresh',
      }),
    );
    const responseWarmupPromise =
      eagerWarmupPromise ??
      (cached.length === 0 && this.shouldRunManagedEntitiesRemoteResponseWarmup()
        ? this.startManagedEntitiesResponseWarmup(user, entityType, {
            bypassRemoteCache: options.bypassRemoteCache === true,
            resetRefreshCursor: options.resetRefreshCursor === true,
            includeRefreshState: false,
          })
        : null);
    const responseWarmup = responseWarmupPromise
      ? await this.awaitManagedEntitiesResponseValueWithinBudget(responseWarmupPromise, {
          fallback: {
            items: [],
            refresh: null,
          },
          budgetMs: MANAGED_ENTITIES_RESPONSE_WARMUP_BUDGET_MS,
          timeoutMessage:
            'Detached managed entities discovery warmup from refresh response after response budget exceeded',
          failureMessage: 'Managed entities discovery warmup failed during refresh response',
          logData: {
            entityType,
            source: 'refresh',
            userId: user.userId,
          },
        })
      : null;
    // If no published snapshot exists yet, prefer showing lightweight bootstrap candidates
    // over returning a temporarily empty refresh response.
    const shouldMergeLightweightBootstrap = true;
    const responseBaseItems =
      responseWarmup && responseWarmup.items.length > 0
        ? this.mergeManagedEntityGroups(responseWarmup.items, cached)
        : cached;
    const mergedCached = shouldMergeLightweightBootstrap
      ? await mergeWithLightweightBootstrap(responseBaseItems)
      : responseBaseItems;
    const items =
      mergedCached.length > 0
        ? await this.attachManagedEntityBotAssignments(
            await this.hydrateManagedEntities(mergedCached),
          )
        : [];
    this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items);
    this.scheduleManagedEntitiesPublishedSnapshotRebuild(user.userId, entityType);
    return {
      items,
      refresh,
    };
  }

  private supportsManagedEntitiesPublishedSnapshot(
    entityType: ManagedEntityTypeFilter,
  ): entityType is ManagedEntityType {
    return entityType === 'chat' || entityType === 'channel';
  }

  private buildManagedEntitiesPublishedSnapshotRunKey(
    userId: string,
    entityType: ManagedEntityType,
  ): string {
    return `${userId}:${entityType}:published-snapshot`;
  }

  private async readManagedEntitiesPublishedSnapshotForResponse(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ManagedEntitiesPublishedSnapshotReadResult | null> {
    if (
      !this.managedEntitiesPublishedSnapshotReadEnabled ||
      !this.supportsManagedEntitiesPublishedSnapshot(entityType) ||
      typeof this.chatContextCache.getManagedEntitiesPublishedSnapshot !== 'function'
    ) {
      return null;
    }

    try {
      const snapshot = await this.chatContextCache.getManagedEntitiesPublishedSnapshot(
        userId,
        entityType,
      );
      if (!snapshot) {
        return null;
      }

      const runtimeScopedItems = this.filterManagedEntitiesToRuntimeScope(
        snapshot.items.map((item) => this.cloneManagedEntitySummary(item)),
        { requireKnownBot: true },
      );
      if (runtimeScopedItems.length !== snapshot.items.length) {
        this.scheduleManagedEntitiesPublishedSnapshotRebuild(userId, entityType);
      }
      const strictVisibleItems = await this.filterManagedEntitiesByStrictAccessEdges(
        userId,
        runtimeScopedItems,
      );
      const repairedItems = await this.repairManagedEntityAccessEdgesFromAllowlist(
        userId,
        runtimeScopedItems,
        strictVisibleItems,
      );
      const edgeVisibleItems = this.filterManagedEntitiesByVisibleIdsInSourceOrder(
        runtimeScopedItems,
        strictVisibleItems,
        repairedItems,
      );
      const filteredItems = await this.filterManagedEntitiesByCachedDeniedAccess(
        userId,
        edgeVisibleItems,
      );
      const responseItems = await this.mergeManagedEntitiesPublishedSnapshotWithAllowlistItems(
        userId,
        entityType,
        filteredItems,
      );
      let responseSnapshot = snapshot;
      if (!this.haveSameManagedEntityIds(responseItems, runtimeScopedItems)) {
        try {
          responseSnapshot = await this.writeManagedEntitiesPublishedSnapshotPatched(
            userId,
            entityType,
            snapshot,
            responseItems,
          );
        } catch (error: unknown) {
          this.logger.warn(
            {
              entityType,
              userId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to patch filtered managed entities into published snapshot',
          );
          this.scheduleManagedEntitiesPublishedSnapshotRebuild(userId, entityType);
        }
      }

      return {
        items: responseItems,
        version: responseSnapshot.version,
        builtAt: responseSnapshot.builtAt,
        lastSyncedAt: responseSnapshot.lastSyncedAt,
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityType,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read managed entities published snapshot',
      );
      return null;
    }
  }

  private createManagedEntitiesResponseSnapshotMetadata(
    snapshot: ManagedEntitiesPublishedSnapshotReadResult,
    refresh: ManagedEntitiesRefreshState | null,
  ): ManagedEntitiesResponseSnapshot {
    const stale =
      !refresh ||
      refresh.complete !== true ||
      refresh.backoffActive === true ||
      (typeof refresh.cursor === 'number' && refresh.cursor >= 0);

    return {
      version: snapshot.version,
      builtAt: snapshot.builtAt,
      lastSyncedAt: snapshot.lastSyncedAt,
      source: 'published_snapshot',
      stale,
    };
  }

  private async filterManagedEntitiesPublishedSnapshotDeniedItems(
    userId: string,
    items: readonly ChatSummary[],
  ): Promise<ChatSummary[]> {
    const strictVisibleItems = await this.filterManagedEntitiesByStrictAccessEdges(userId, items);
    return this.filterManagedEntitiesByCachedDeniedAccess(userId, strictVisibleItems);
  }

  private async filterManagedEntitiesByCachedDeniedAccess(
    userId: string,
    items: readonly ChatSummary[],
  ): Promise<ChatSummary[]> {
    if (items.length === 0 || typeof this.chatContextCache.getAdminAccess !== 'function') {
      return items.map((item) => this.cloneManagedEntitySummary(item));
    }

    const accessStates = await Promise.all(
      items.map(async (item) => {
        try {
          return {
            item,
            access: await this.chatContextCache.getAdminAccess(item.id, userId),
          };
        } catch {
          return {
            item,
            access: null,
          };
        }
      }),
    );

    return accessStates
      .filter(({ access }) => access !== 'user_denied' && access !== 'bot_denied')
      .map(({ item }) => this.cloneManagedEntitySummary(item));
  }

  private filterManagedEntitiesByVisibleIdsInSourceOrder(
    sourceItems: readonly ChatSummary[],
    ...visibleGroups: readonly ChatSummary[][]
  ): ChatSummary[] {
    const visibleIds = new Set<string>();
    for (const group of visibleGroups) {
      for (const item of group) {
        visibleIds.add(item.id);
      }
    }

    return sourceItems
      .filter((item) => visibleIds.has(item.id))
      .map((item) => this.cloneManagedEntitySummary(item));
  }

  private haveSameManagedEntityIds(
    leftItems: readonly ChatSummary[],
    rightItems: readonly ChatSummary[],
  ): boolean {
    return (
      leftItems.length === rightItems.length &&
      leftItems.every((item, index) => item.id === rightItems[index]?.id)
    );
  }

  private async mergeManagedEntitiesPublishedSnapshotWithAllowlistItems(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    items: readonly ChatSummary[],
  ): Promise<ChatSummary[]> {
    const snapshotItems = items.map((item) => this.cloneManagedEntitySummary(item));
    if (entityType !== 'channel') {
      return snapshotItems;
    }

    try {
      const allowlistItems = await this.listChatsFromAllowlist(userId, entityType);
      const snapshotIds = new Set(snapshotItems.map((item) => item.id));
      if (allowlistItems.every((item) => snapshotIds.has(item.id))) {
        return snapshotItems;
      }

      this.scheduleManagedEntitiesPublishedSnapshotRebuild(userId, entityType);
      return this.filterManagedEntitiesByCachedDeniedAccess(
        userId,
        this.mergeManagedEntityGroups(snapshotItems, allowlistItems),
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityType,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to merge allowlisted managed entities into published snapshot response',
      );
      return snapshotItems;
    }
  }

  private async filterManagedEntitiesByStrictAccessEdges(
    userId: string,
    items: readonly ChatSummary[],
  ): Promise<ChatSummary[]> {
    if (items.length === 0) {
      return [];
    }

    const client = this.getManagedEntityAccessEdgeClient();
    if (!client) {
      return [...items];
    }

    const chatIds = Array.from(
      new Set(items.map((item) => item.id.trim()).filter((chatId) => chatId.length > 0)),
    );
    if (chatIds.length === 0) {
      return [];
    }

    try {
      const rows = await client.findMany({
        where: {
          userId,
          state: 'GRANTED',
          chatId: {
            in: chatIds,
          },
          OR: [
            { expiresAt: { gt: new Date() } },
            {
              expiresAt: null,
              checkedAt: { gt: new Date(Date.now() - MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS) },
            },
          ],
        },
        select: {
          chatId: true,
          botId: true,
        },
      });
      const visibleChatIds = new Set(
        rows
          .filter((row) => this.isManagedEntityAccessBotInRuntimeScope(row.botId))
          .map((row) => row.chatId),
      );

      return items
        .filter((item) => visibleChatIds.has(item.id))
        .map((item) => this.cloneManagedEntitySummary(item));
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId,
          requestedItems: items.length,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to filter managed entities by strict access edges',
      );
      return [];
    }
  }

  private normalizeManagedEntitiesSnapshotVersion(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private async readManagedEntitiesPublishedDiffResponseForRefresh(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    sinceVersion: string | undefined,
    publishedSnapshot: ManagedEntitiesPublishedSnapshotReadResult,
    refresh: ManagedEntitiesRefreshState,
    options: {
      bypassRemoteCache: boolean;
      resetRefreshCursor: boolean;
    },
  ): Promise<ManagedEntitiesListResult | null> {
    if (
      !this.managedEntitiesPublishedDiffReadEnabled ||
      !this.supportsManagedEntitiesPublishedSnapshot(entityType) ||
      options.bypassRemoteCache ||
      options.resetRefreshCursor
    ) {
      return null;
    }

    const normalizedSinceVersion = this.normalizeManagedEntitiesSnapshotVersion(sinceVersion);
    if (!normalizedSinceVersion) {
      return null;
    }

    const snapshot = this.createManagedEntitiesResponseSnapshotMetadata(publishedSnapshot, refresh);
    if (normalizedSinceVersion === publishedSnapshot.version) {
      return {
        items: [],
        refresh,
        snapshot,
        diff: {
          mode: 'noop',
          baseVersion: normalizedSinceVersion,
          nextVersion: publishedSnapshot.version,
        },
      };
    }

    const publishedDiff = await this.readManagedEntitiesPublishedDiffForResponse(
      userId,
      entityType,
      normalizedSinceVersion,
      publishedSnapshot.version,
    );
    if (!publishedDiff) {
      return null;
    }

    const nextRuntimeIds = new Set(publishedSnapshot.items.map((item) => item.id));

    return {
      items: [],
      refresh,
      snapshot,
      diff: {
        mode: 'patch',
        baseVersion: publishedDiff.baseVersion,
        nextVersion: publishedDiff.nextVersion,
        added: publishedDiff.added.filter((item) => nextRuntimeIds.has(item.id)),
        updated: publishedDiff.updated.filter((item) => nextRuntimeIds.has(item.id)),
        removedIds: publishedDiff.removedIds,
        orderedIds: publishedDiff.orderedIds.filter((item) => nextRuntimeIds.has(item)),
      },
    };
  }

  private async readManagedEntitiesPublishedDiffForResponse(
    userId: string,
    entityType: ManagedEntityType,
    baseVersion: string,
    expectedNextVersion: string,
  ): Promise<ManagedEntitiesPublishedDiffReadResult | null> {
    if (
      !this.managedEntitiesPublishedDiffReadEnabled ||
      typeof this.chatContextCache.getManagedEntitiesPublishedDiff !== 'function'
    ) {
      return null;
    }

    try {
      const diff = await this.chatContextCache.getManagedEntitiesPublishedDiff(
        userId,
        entityType,
        baseVersion,
      );
      if (!diff || diff.nextVersion !== expectedNextVersion) {
        return null;
      }

      return {
        baseVersion: diff.baseVersion,
        nextVersion: diff.nextVersion,
        added: this.filterManagedEntitiesToRuntimeScope(
          diff.added.map((item) => this.cloneManagedEntitySummary(item)),
          { requireKnownBot: true },
        ),
        updated: this.filterManagedEntitiesToRuntimeScope(
          diff.updated.map((item) => this.cloneManagedEntitySummary(item)),
          { requireKnownBot: true },
        ),
        removedIds: [...diff.removedIds],
        orderedIds: [...diff.orderedIds],
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityType,
          userId,
          baseVersion,
          expectedNextVersion,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read managed entities published diff',
      );
      return null;
    }
  }

  private scheduleManagedEntitiesPublishedSnapshotRebuild(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): void {
    if (
      !this.managedEntitiesPublishedSnapshotWriteEnabled ||
      !this.supportsManagedEntitiesPublishedSnapshot(entityType) ||
      typeof this.chatContextCache.setManagedEntitiesPublishedSnapshot !== 'function'
    ) {
      return;
    }

    const key = this.buildManagedEntitiesPublishedSnapshotRunKey(userId, entityType);
    if (this.managedEntitiesPublishedSnapshotRuns.has(key)) {
      return;
    }

    const pending = this.rebuildManagedEntitiesPublishedSnapshot(userId, entityType)
      .catch((error: unknown) => {
        this.logger.warn(
          {
            entityType,
            userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Managed entities published snapshot rebuild failed',
        );
      })
      .finally(() => {
        if (this.managedEntitiesPublishedSnapshotRuns.get(key) === pending) {
          this.managedEntitiesPublishedSnapshotRuns.delete(key);
        }
      });

    this.managedEntitiesPublishedSnapshotRuns.set(key, pending);
  }

  private async upsertManagedEntitiesPublishedSnapshotItem(
    userId: string,
    summary: ChatSummary,
  ): Promise<void> {
    if (
      !this.supportsManagedEntitiesPublishedSnapshot(summary.entityType) ||
      typeof this.chatContextCache.getManagedEntitiesPublishedSnapshot !== 'function' ||
      typeof this.chatContextCache.setManagedEntitiesPublishedSnapshot !== 'function'
    ) {
      return;
    }

    const currentSnapshot = await this.chatContextCache.getManagedEntitiesPublishedSnapshot(
      userId,
      summary.entityType,
    );
    if (!currentSnapshot) {
      return;
    }

    const nextItems = currentSnapshot.items.map((item) => this.cloneManagedEntitySummary(item));
    const existingIndex = nextItems.findIndex((item) => item.id === summary.id);
    let changed = false;

    if (existingIndex < 0) {
      nextItems.unshift(this.cloneManagedEntitySummary(summary));
      changed = true;
    } else {
      const existing = nextItems[existingIndex];
      const mergedTitle =
        isFallbackTitle(summary.id, existing.title) && !isFallbackTitle(summary.id, summary.title)
          ? summary.title
          : existing.title;
      const mergedLink = existing.link ?? summary.link ?? null;
      const mergedAvatarUrl = existing.avatarUrl ?? summary.avatarUrl;
      const mergedPrimaryBotId = existing.primaryBotId ?? summary.primaryBotId ?? null;

      if (
        mergedTitle !== existing.title ||
        mergedLink !== (existing.link ?? null) ||
        mergedAvatarUrl !== existing.avatarUrl ||
        mergedPrimaryBotId !== (existing.primaryBotId ?? null)
      ) {
        nextItems[existingIndex] = {
          ...existing,
          title: mergedTitle,
          link: mergedLink,
          ...(mergedAvatarUrl ? { avatarUrl: mergedAvatarUrl } : {}),
          primaryBotId: mergedPrimaryBotId,
        };
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    await this.writeManagedEntitiesPublishedSnapshotPatched(
      userId,
      summary.entityType,
      currentSnapshot,
      nextItems,
    );
  }

  private async removeManagedEntitiesPublishedSnapshotItem(
    userId: string,
    entityType: ManagedEntityType,
    chatId: string,
  ): Promise<void> {
    if (
      typeof this.chatContextCache.getManagedEntitiesPublishedSnapshot !== 'function' ||
      typeof this.chatContextCache.setManagedEntitiesPublishedSnapshot !== 'function'
    ) {
      return;
    }

    const currentSnapshot = await this.chatContextCache.getManagedEntitiesPublishedSnapshot(
      userId,
      entityType,
    );
    if (!currentSnapshot) {
      return;
    }

    const nextItems = currentSnapshot.items.filter((item) => item.id !== chatId);
    if (nextItems.length === currentSnapshot.items.length) {
      return;
    }

    await this.writeManagedEntitiesPublishedSnapshotPatched(
      userId,
      entityType,
      currentSnapshot,
      nextItems,
    );
  }

  private async removeManagedEntitiesPublishedSnapshotItemForChat(
    userId: string,
    chatId: string,
  ): Promise<void> {
    await Promise.all([
      this.removeManagedEntitiesPublishedSnapshotItem(userId, 'chat', chatId),
      this.removeManagedEntitiesPublishedSnapshotItem(userId, 'channel', chatId),
    ]);
  }

  private async writeManagedEntitiesPublishedSnapshotPatched(
    userId: string,
    entityType: ManagedEntityType,
    currentSnapshot: ManagedEntitiesPublishedSnapshot,
    items: readonly ChatSummary[],
  ): Promise<ManagedEntitiesPublishedSnapshot> {
    if (typeof this.chatContextCache.setManagedEntitiesPublishedSnapshot !== 'function') {
      return currentSnapshot;
    }

    const nextSnapshot: ManagedEntitiesPublishedSnapshot = {
      version: randomUUID(),
      builtAt: new Date().toISOString(),
      lastSyncedAt: currentSnapshot.lastSyncedAt,
      itemCount: items.length,
      itemsHash: this.buildManagedEntitiesPublishedSnapshotHash(
        items,
        currentSnapshot.lastSyncedAt,
      ),
      items: items.map((item) => this.cloneManagedEntitySummary(item)),
    };

    await this.chatContextCache.setManagedEntitiesPublishedSnapshot(
      userId,
      entityType,
      nextSnapshot,
      MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC,
    );

    const nextDiff = this.buildManagedEntitiesPublishedSnapshotDiff(currentSnapshot, nextSnapshot);
    if (
      nextDiff &&
      this.managedEntitiesPublishedDiffWriteEnabled &&
      typeof this.chatContextCache.setManagedEntitiesPublishedDiff === 'function'
    ) {
      await this.chatContextCache.setManagedEntitiesPublishedDiff(
        userId,
        entityType,
        nextDiff.baseVersion,
        nextDiff,
        MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC,
      );
    }

    return nextSnapshot;
  }

  private scheduleManagedEntitiesPublishedSnapshotRebuildForBootstrapChats(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    chats: readonly ChatSummary[],
  ): void {
    if (
      !this.managedEntitiesPublishedSnapshotWriteEnabled ||
      typeof this.chatContextCache.getManagedEntitiesPublishedSnapshot !== 'function' ||
      chats.length === 0
    ) {
      return;
    }

    if (entityType === 'all') {
      const chatItems = chats.filter((chat) => chat.entityType === 'chat');
      if (chatItems.length > 0) {
        this.scheduleManagedEntitiesPublishedSnapshotRebuildForBootstrapChats(
          userId,
          'chat',
          chatItems,
        );
      }

      const channelItems = chats.filter((chat) => chat.entityType === 'channel');
      if (channelItems.length > 0) {
        this.scheduleManagedEntitiesPublishedSnapshotRebuildForBootstrapChats(
          userId,
          'channel',
          channelItems,
        );
      }

      return;
    }

    const bootstrapChatIds = Array.from(
      new Set(
        chats
          .filter((chat) => chat.entityType === entityType)
          .map((chat) => chat.id)
          .filter((chatId) => chatId.trim().length > 0),
      ),
    );
    if (bootstrapChatIds.length === 0) {
      return;
    }

    void this.chatContextCache
      .getManagedEntitiesPublishedSnapshot(userId, entityType)
      .then((snapshot) => {
        const snapshotIds = new Set(snapshot?.items.map((item) => item.id) ?? []);
        if (bootstrapChatIds.every((chatId) => snapshotIds.has(chatId))) {
          return;
        }

        this.scheduleManagedEntitiesPublishedSnapshotRebuild(userId, entityType);
      })
      .catch((error: unknown) => {
        this.logger.warn(
          {
            entityType,
            userId,
            chatIds: bootstrapChatIds,
            err: error instanceof Error ? error.message : String(error),
          },
          'Managed entities published snapshot bootstrap coverage check failed',
        );
      });
  }

  private async loadRecentBotAddedBootstrapRows(userId: string): Promise<
    Array<{
      chat_id: string | null;
      chat_title: string | null;
      is_channel: string | null;
      user_scoped: boolean;
      last_event_at: Date | string | null;
      source: 'activity';
    }>
  > {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return [];
    }

    const managedEntitiesReadPrisma = this.getManagedEntitiesReadPrisma();
    const lookbackFrom = new Date(Date.now() - MANAGED_ENTITIES_LOCAL_ACTIVITY_LOOKBACK_MS);
    const userScopedRows = await managedEntitiesReadPrisma.$queryRaw<
      Array<{
        chat_id: string | null;
        chat_title: string | null;
        is_channel: string | null;
        last_event_at: Date | string | null;
      }>
    >`
      SELECT
        chat_id,
        chat_title,
        CASE entity_type
          WHEN 'CHANNEL' THEN 'true'
          ELSE 'false'
        END AS is_channel,
        last_event_at
      FROM managed_entity_local_activities
      WHERE user_id = ${normalizedUserId}
        AND source_event_type = 'bot_added'
        AND last_event_at >= ${lookbackFrom}
      ORDER BY last_event_at DESC
      LIMIT ${RECENT_BOT_ADDED_USER_SCOPED_WEBHOOK_SCAN_LIMIT}
    `;
    const globalRows = await managedEntitiesReadPrisma.$queryRaw<
      Array<{
        chat_id: string | null;
        chat_title: string | null;
        is_channel: string | null;
        last_event_at: Date | string | null;
      }>
    >`
      SELECT
        recent_rows.chat_id,
        recent_rows.chat_title,
        recent_rows.is_channel,
        recent_rows.last_event_at
      FROM (
        SELECT DISTINCT ON (chat_id)
          chat_id,
          chat_title,
          CASE entity_type
            WHEN 'CHANNEL' THEN 'true'
            ELSE 'false'
          END AS is_channel,
          last_event_at
        FROM managed_entity_local_activities
        WHERE source_event_type = 'bot_added'
        ORDER BY chat_id, last_event_at DESC
      ) AS recent_rows
      ORDER BY recent_rows.last_event_at DESC
      LIMIT ${RECENT_BOT_ADDED_WEBHOOK_SCAN_LIMIT}
    `;

    const mergedRows: Array<{
      chat_id: string | null;
      chat_title: string | null;
      is_channel: string | null;
      user_scoped: boolean;
      last_event_at: Date | string | null;
      source: 'activity';
    }> = [];
    const seen = new Set<string>();

    for (const row of [
      ...(Array.isArray(userScopedRows) ? userScopedRows : []).map((item) => ({
        ...item,
        user_scoped: true,
        source: 'activity' as const,
      })),
      ...(Array.isArray(globalRows) ? globalRows : []).map((item) => ({
        ...item,
        user_scoped: false,
        source: 'activity' as const,
      })),
    ]) {
      const chatId = this.readTrimmedString(row.chat_id);
      if (!chatId || seen.has(chatId)) {
        continue;
      }

      seen.add(chatId);
      mergedRows.push(row);
    }

    return mergedRows;
  }

  private async rebuildManagedEntitiesPublishedSnapshot(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<void> {
    if (
      !this.managedEntitiesPublishedSnapshotWriteEnabled ||
      !this.supportsManagedEntitiesPublishedSnapshot(entityType) ||
      typeof this.chatContextCache.setManagedEntitiesPublishedSnapshot !== 'function'
    ) {
      return;
    }

    const currentSnapshot =
      typeof this.chatContextCache.getManagedEntitiesPublishedSnapshot === 'function'
        ? await this.chatContextCache.getManagedEntitiesPublishedSnapshot(userId, entityType)
        : null;
    const allowlist = await this.listChatsFromAllowlistUncached(userId, entityType, {
      allowLastSuccessFallback: false,
    });
    const user: AuthUser = {
      userId,
      username: null,
      displayName: null,
      chatTitle: null,
    };
    const revalidated = await this.revalidateCachedManagedEntities(user, allowlist);
    const items = await this.attachManagedEntityBotAssignments(
      await this.hydrateManagedEntities(revalidated),
    );
    const lastSyncedAt =
      (await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(userId, entityType)) ?? null;
    const itemsHash = this.buildManagedEntitiesPublishedSnapshotHash(items, lastSyncedAt);
    const nextSnapshot: ManagedEntitiesPublishedSnapshot =
      currentSnapshot &&
      currentSnapshot.itemsHash === itemsHash &&
      currentSnapshot.itemCount === items.length &&
      currentSnapshot.lastSyncedAt === lastSyncedAt
        ? {
            ...currentSnapshot,
            items: items.map((item) => this.cloneManagedEntitySummary(item)),
          }
        : {
            version: randomUUID(),
            builtAt: new Date().toISOString(),
            lastSyncedAt,
            itemCount: items.length,
            itemsHash,
            items: items.map((item) => this.cloneManagedEntitySummary(item)),
          };

    await this.chatContextCache.setManagedEntitiesPublishedSnapshot(
      userId,
      entityType,
      nextSnapshot,
      MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC,
    );

    const nextDiff = this.buildManagedEntitiesPublishedSnapshotDiff(currentSnapshot, nextSnapshot);
    if (
      nextDiff &&
      this.managedEntitiesPublishedDiffWriteEnabled &&
      typeof this.chatContextCache.setManagedEntitiesPublishedDiff === 'function'
    ) {
      try {
        await this.chatContextCache.setManagedEntitiesPublishedDiff(
          userId,
          entityType,
          nextDiff.baseVersion,
          nextDiff,
          MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC,
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            entityType,
            userId,
            baseVersion: nextDiff.baseVersion,
            nextVersion: nextDiff.nextVersion,
            err: error instanceof Error ? error.message : String(error),
          },
          'Managed entities published diff write failed',
        );
      }
    }
  }

  private buildManagedEntitiesPublishedSnapshotHash(
    items: readonly ChatSummary[],
    lastSyncedAt: string | null,
  ): string {
    const normalizedItems = items.map((item) =>
      this.serializeManagedEntitySummaryForSnapshot(item),
    );

    return createHash('sha256')
      .update(
        JSON.stringify({
          lastSyncedAt,
          items: normalizedItems,
        }),
      )
      .digest('hex');
  }

  private buildManagedEntitiesPublishedSnapshotDiff(
    currentSnapshot: ManagedEntitiesPublishedSnapshot | null,
    nextSnapshot: ManagedEntitiesPublishedSnapshot,
  ): ManagedEntitiesPublishedDiff | null {
    if (!currentSnapshot || currentSnapshot.version === nextSnapshot.version) {
      return null;
    }

    const currentById = new Map(currentSnapshot.items.map((item) => [item.id, item]));
    const nextById = new Map(nextSnapshot.items.map((item) => [item.id, item]));
    const added: ChatSummary[] = [];
    const updated: ChatSummary[] = [];
    const removedIds: string[] = [];

    for (const item of nextSnapshot.items) {
      const currentItem = currentById.get(item.id);
      if (!currentItem) {
        added.push(this.cloneManagedEntitySummary(item));
        continue;
      }

      if (!this.areManagedEntitySummariesEquivalent(currentItem, item)) {
        updated.push(this.cloneManagedEntitySummary(item));
      }
    }

    for (const item of currentSnapshot.items) {
      if (!nextById.has(item.id)) {
        removedIds.push(item.id);
      }
    }

    const changeCount = added.length + updated.length + removedIds.length;
    if (changeCount === 0) {
      return null;
    }

    const comparisonSize = Math.max(currentSnapshot.itemCount, nextSnapshot.itemCount);
    const maxPatchChanges = Math.max(
      1,
      Math.floor(comparisonSize * MANAGED_ENTITIES_PUBLISHED_DIFF_MAX_CHANGE_RATIO),
    );
    if (changeCount > maxPatchChanges) {
      return null;
    }

    return {
      baseVersion: currentSnapshot.version,
      nextVersion: nextSnapshot.version,
      added,
      updated,
      removedIds,
      orderedIds: nextSnapshot.items.map((item) => item.id),
      changeCount,
    };
  }

  private serializeManagedEntitySummaryForSnapshot(item: ChatSummary): Record<string, unknown> {
    return {
      id: item.id,
      title: item.title,
      createdAt: item.createdAt,
      entityType: item.entityType,
      link: item.link ?? null,
      avatarUrl: this.readTrimmedString(item.avatarUrl) ?? null,
      channelOverview: item.channelOverview
        ? {
            enabledScenariosCount: item.channelOverview.enabledScenariosCount,
            commentsEnabled: item.channelOverview.commentsEnabled,
            postSuggestionsEnabled: item.channelOverview.postSuggestionsEnabled,
            commentsModerationEnabled: item.channelOverview.commentsModerationEnabled,
          }
        : null,
      primaryBotId: item.primaryBotId ?? null,
      assignedBots: (item.assignedBots ?? []).map((bot) => ({
        botId: bot.botId,
        label: bot.label,
        role: bot.role,
        membershipStatus: bot.membershipStatus,
        lifecycleState: bot.lifecycleState,
        speechPersona: bot.speechPersona,
        characterName: bot.characterName ?? null,
        avatarUrl: bot.avatarUrl ?? null,
        capabilities: [...bot.capabilities],
        permissionsSummary: bot.permissionsSummary
          ? {
              checkedAt: bot.permissionsSummary.checkedAt ?? null,
              isAdmin: bot.permissionsSummary.isAdmin,
              isOwner: bot.permissionsSummary.isOwner,
              permissions: [...bot.permissionsSummary.permissions],
            }
          : null,
      })),
      sharedMode: item.sharedMode,
    };
  }

  private areManagedEntitySummariesEquivalent(left: ChatSummary, right: ChatSummary): boolean {
    return (
      JSON.stringify(this.serializeManagedEntitySummaryForSnapshot(left)) ===
      JSON.stringify(this.serializeManagedEntitySummaryForSnapshot(right))
    );
  }

  private async mergeManagedEntitiesPublishedSnapshotWithLightweightBootstrap(
    items: readonly ChatSummary[],
    bootstrap: {
      recentBotAdded: ChatSummary[];
    },
  ): Promise<ChatSummary[]> {
    const snapshotItems = await this.hydrateManagedEntities(
      items.map((item) => this.cloneManagedEntitySummary(item)),
    );
    const snapshotIds = new Set(items.map((item) => item.id));
    const recentBotAdded = bootstrap.recentBotAdded.filter((chat) => !snapshotIds.has(chat.id));
    const bootstrapCandidates = this.mergeManagedEntityGroups(recentBotAdded);
    if (bootstrapCandidates.length === 0) {
      return snapshotItems;
    }

    const hydratedBootstrap = await this.attachManagedEntityBotAssignments(
      await this.hydrateManagedEntities(bootstrapCandidates),
    );
    const hydratedById = new Map(hydratedBootstrap.map((item) => [item.id, item]));

    return this.mergeManagedEntitiesWithLightweightBootstrap(snapshotItems, {
      recentBotAdded: recentBotAdded.map((chat) => hydratedById.get(chat.id) ?? chat),
    });
  }

  private async scheduleManagedEntitiesRemoteFullRefresh(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
      allowRecoveryWindowRun?: boolean;
    } = {},
  ): Promise<ManagedEntitiesRefreshState> {
    const refreshKey = [user.userId, entityType, 'remote', 'full', 'background'].join(':');
    const refreshState = await this.prepareManagedEntitiesRemoteFullRefreshState(
      user.userId,
      entityType,
      options,
    );
    if (refreshState.backoffActive || refreshState.complete) {
      return refreshState;
    }

    const existing = this.managedEntitiesBackgroundRefreshRuns.get(refreshKey);

    if (!existing) {
      if (!(await this.enqueueManagedEntitiesRemoteFullRefresh(user.userId, entityType, options))) {
        const pending = this.runManagedEntitiesRemoteFullRefreshUntilSettled(
          user,
          entityType,
          options,
        )
          .catch((error: unknown) => {
            this.logger.warn(
              {
                entityType,
                userId: user.userId,
                err: error instanceof Error ? error.message : String(error),
              },
              'Managed entities background refresh failed',
            );
          })
          .finally(() => {
            if (this.managedEntitiesBackgroundRefreshRuns.get(refreshKey) === pending) {
              this.managedEntitiesBackgroundRefreshRuns.delete(refreshKey);
            }
          });
        this.managedEntitiesBackgroundRefreshRuns.set(refreshKey, pending);
      }
    }

    return refreshState;
  }

  private async runManagedEntitiesRemoteFullRefreshUntilSettled(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
      allowRecoveryWindowRun?: boolean;
    } = {},
  ): Promise<void> {
    const allowRecoveryWindowRun = this.shouldAllowManagedEntitiesRecoveryWindowRun(options);
    let nextOptions = {
      ...options,
      allowRecoveryWindowRun,
    };

    while (true) {
      const outcome = await this.runManagedEntitiesRemoteFullRefresh(user, entityType, nextOptions);
      if (!outcome) {
        return;
      }

      nextOptions = {
        bypassRemoteCache: false,
        resetRefreshCursor: false,
        allowRecoveryWindowRun,
      };
      await this.sleep(Math.max(0, outcome.continueAfterMs));
    }
  }

  async processManagedEntitiesRefreshJob(
    job: AdminManagedEntitiesRefreshJob,
  ): Promise<ManagedEntitiesRefreshJobOutcome> {
    const user: AuthUser = {
      userId: job.userId,
      username: null,
      displayName: null,
      chatTitle: null,
    };

    return this.runManagedEntitiesRemoteFullRefreshForManagedEntities(user, job.entityType, {
      bypassRemoteCache: job.bypassRemoteCache,
      resetRefreshCursor: job.resetRefreshCursor,
    });
  }

  runManagedEntitiesRemoteFullRefreshForManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
    } = {},
  ): Promise<ManagedEntitiesRefreshJobOutcome> {
    return this.runManagedEntitiesRemoteFullRefresh(user, entityType, {
      bypassRemoteCache: options.bypassRemoteCache,
      resetRefreshCursor: options.resetRefreshCursor,
    });
  }

  private buildManagedEntitiesRefreshJobId(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): string {
    return `managed-entities-refresh__${entityType}__${userId}`;
  }

  private buildManagedEntitiesRefreshJobData(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
    },
    existingData?: Partial<AdminManagedEntitiesRefreshJob> | null,
  ): AdminManagedEntitiesRefreshJob {
    return {
      userId,
      entityType,
      bypassRemoteCache:
        existingData?.bypassRemoteCache === true || options.bypassRemoteCache === true,
      resetRefreshCursor:
        existingData?.resetRefreshCursor === true || options.resetRefreshCursor === true,
    };
  }

  private buildManagedEntitiesRefreshJobPriority(
    entityType: ManagedEntityTypeFilter,
    jobData: AdminManagedEntitiesRefreshJob,
  ): number {
    if (jobData.bypassRemoteCache) {
      return 1;
    }

    if (jobData.resetRefreshCursor) {
      return entityType === 'chat' ? 2 : 3;
    }

    return entityType === 'chat' ? 10 : 20;
  }

  private async enqueueManagedEntitiesRemoteFullRefresh(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
    } = {},
  ): Promise<boolean> {
    if (!this.adminManagedEntitiesRefreshQueue) {
      return false;
    }

    const jobId = this.buildManagedEntitiesRefreshJobId(userId, entityType);

    try {
      const existing = await this.adminManagedEntitiesRefreshQueue.getJob(jobId);
      const desiredJobData = this.buildManagedEntitiesRefreshJobData(
        userId,
        entityType,
        options,
        (existing?.data as Partial<AdminManagedEntitiesRefreshJob> | undefined) ?? null,
      );
      const desiredPriority = this.buildManagedEntitiesRefreshJobPriority(
        entityType,
        desiredJobData,
      );
      if (existing) {
        const state = await existing.getState();
        const existingPriority =
          typeof existing.opts.priority === 'number'
            ? existing.opts.priority
            : Number.MAX_SAFE_INTEGER;
        const shouldPromoteWaitingJob =
          (state === 'waiting' || state === 'delayed') &&
          (desiredPriority < existingPriority ||
            existing.data?.bypassRemoteCache !== desiredJobData.bypassRemoteCache ||
            existing.data?.resetRefreshCursor !== desiredJobData.resetRefreshCursor);
        if (state !== 'failed' && state !== 'completed' && !shouldPromoteWaitingJob) {
          return true;
        }

        await existing.remove();
      }

      await this.adminManagedEntitiesRefreshQueue.add('refresh-managed-entities', desiredJobData, {
        jobId,
        priority: desiredPriority,
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 1_000,
        },
      });
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('job') && message.toLowerCase().includes('exists')) {
        return true;
      }

      this.logger.warn(
        {
          userId,
          entityType,
          err: message,
        },
        'Failed to enqueue managed entities background refresh',
      );
      return false;
    }
  }

  private async prepareManagedEntitiesRemoteFullRefreshState(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
      allowRecoveryWindowRun?: boolean;
    } = {},
  ): Promise<ManagedEntitiesRefreshState> {
    let cursor: number | null = null;
    try {
      cursor =
        (await this.chatContextCache.getManagedEntitiesRefreshCursor?.(userId, entityType)) ?? null;
    } catch {
      cursor = null;
    }

    const backgroundPauseDecision = this.peekManagedEntitiesBackgroundRefreshPauseDecision(
      'schedule',
      this.buildManagedEntitiesBackgroundGovernorOptions(options),
    );
    if (backgroundPauseDecision) {
      const pausedCursor = cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE ? null : cursor;
      const presentation = await this.loadManagedEntitiesRefreshPresentationData(
        userId,
        entityType,
      );
      return this.createManagedEntitiesRefreshState(
        pausedCursor,
        true,
        backgroundPauseDecision.retryAfterMs,
        presentation,
      );
    }

    const refreshCooldownKey = this.buildManagedEntitiesRefreshCooldownKey(userId, entityType);
    const backoffActive = await this.isManagedEntitiesRefreshBackoffActive(
      userId,
      entityType,
      refreshCooldownKey,
    );
    if (backoffActive) {
      return this.readManagedEntitiesRefreshState(userId, entityType, {
        backoffActiveOverride: true,
      });
    }

    if (
      options.resetRefreshCursor !== true &&
      options.bypassRemoteCache === true &&
      (cursor === null || cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE)
    ) {
      const freshness = await this.readManagedEntitiesLastSyncFreshness(userId, entityType);
      if (
        typeof freshness.ageMs === 'number' &&
        freshness.ageMs >= 0 &&
        freshness.ageMs < MANAGED_ENTITIES_MANUAL_REFRESH_RECENT_SYNC_WINDOW_MS
      ) {
        const presentation = await this.loadManagedEntitiesRefreshPresentationData(
          userId,
          entityType,
        );
        return this.createManagedEntitiesRefreshState(
          MANAGED_ENTITIES_REFRESH_CURSOR_DONE,
          false,
          0,
          {
            totalCandidates: presentation.totalCandidates,
            lastSyncedAt: freshness.lastSyncedAt ?? presentation.lastSyncedAt,
          },
        );
      }
    }

    if (
      options.resetRefreshCursor !== true &&
      options.bypassRemoteCache !== true &&
      (cursor === null || cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE)
    ) {
      const freshness = await this.readManagedEntitiesLastSyncFreshness(userId, entityType);
      if (freshness.fresh) {
        const presentation = await this.loadManagedEntitiesRefreshPresentationData(
          userId,
          entityType,
        );
        return this.createManagedEntitiesRefreshState(
          MANAGED_ENTITIES_REFRESH_CURSOR_DONE,
          false,
          0,
          {
            totalCandidates: presentation.totalCandidates,
            lastSyncedAt: freshness.lastSyncedAt ?? presentation.lastSyncedAt,
          },
        );
      }
    }

    if (
      options.resetRefreshCursor === true ||
      cursor === null ||
      cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE
    ) {
      cursor = 0;
      await this.chatContextCache.setManagedEntitiesRefreshCursor?.(
        userId,
        entityType,
        cursor,
        MANAGED_ENTITIES_REFRESH_CURSOR_TTL_SEC,
      );
    }

    return this.createManagedEntitiesRefreshState(cursor, false);
  }

  private async runManagedEntitiesRemoteFullRefresh(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
      allowRecoveryWindowRun?: boolean;
    } = {},
  ): Promise<ManagedEntitiesRefreshJobOutcome> {
    const backgroundPauseDecision = await this.resolveManagedEntitiesBackgroundRefreshPauseDecision(
      'job',
      this.buildManagedEntitiesBackgroundGovernorOptions(options),
    );
    if (backgroundPauseDecision) {
      return {
        continueAfterMs: backgroundPauseDecision.retryAfterMs,
      };
    }

    const result = await this.discoverManagedEntities(user, entityType, {
      respectCooldown: false,
      fullScan: true,
      includeRefreshState: true,
      bypassRemoteCache: options.bypassRemoteCache === true,
      resetRefreshCursor: options.resetRefreshCursor === true,
    });
    const refresh = result.refresh;
    if (!refresh || refresh.backoffActive) {
      return null;
    }

    if (refresh.complete) {
      await this.repairManagedEntitiesAllowlistAfterFullRefresh(
        user.userId,
        entityType,
        result.items,
        result.fullScanCandidateIds,
      );
      await this.rebuildManagedEntitiesPublishedSnapshot(user.userId, entityType);
      return null;
    }

    this.scheduleManagedEntitiesPublishedSnapshotRebuild(user.userId, entityType);
    return {
      continueAfterMs: Math.max(
        0,
        refresh.nextPollAfterMs ?? MANAGED_ENTITIES_REFRESH_NEXT_POLL_AFTER_MS,
      ),
    };
  }

  private mergeManagedEntityGroups(...groups: readonly ChatSummary[][]): ChatSummary[] {
    const merged: ChatSummary[] = [];
    const seen = new Set<string>();

    for (const group of groups) {
      for (const chat of group) {
        if (seen.has(chat.id)) {
          continue;
        }

        seen.add(chat.id);
        merged.push(chat);
      }
    }

    return merged;
  }

  private mergeManagedEntitiesWithLightweightBootstrap(
    items: readonly ChatSummary[],
    bootstrap: {
      recentBotAdded: ChatSummary[];
    },
  ): ChatSummary[] {
    return this.mergeManagedEntityGroups(bootstrap.recentBotAdded, [...items]);
  }

  private async loadManagedEntitiesLightweightBootstrap(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
  ): Promise<{
    recentBotAdded: ChatSummary[];
  }> {
    const recentBotAddedPromise = this.bootstrapRecentBotAddedEntities(user, entityType);

    const [recentBotAdded] = await Promise.all([
      this.awaitManagedEntitiesResponseValueWithinBudget(recentBotAddedPromise, {
        fallback: [],
        budgetMs: MANAGED_ENTITIES_LIGHTWEIGHT_RECENT_BOOTSTRAP_RESPONSE_BUDGET_MS,
        timeoutMessage:
          'Detached recent bot_added bootstrap from lightweight managed entities response after response budget exceeded',
        failureMessage:
          'Recent bot_added bootstrap failed during lightweight managed entities response',
        logData: {
          entityType,
          userId: user.userId,
        },
      }),
    ]);

    return {
      recentBotAdded,
    };
  }

  private awaitManagedEntitiesResponseValueWithinBudget<T>(
    promise: Promise<T>,
    options: {
      fallback: T;
      budgetMs: number;
      timeoutMessage: string;
      failureMessage: string;
      logData: Record<string, unknown>;
    },
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false;
      const finish = (value: T) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        this.logger.debug(
          {
            ...options.logData,
            budgetMs: options.budgetMs,
          },
          options.timeoutMessage,
        );
        finish(options.fallback);
      }, options.budgetMs);

      void promise.then(
        (value) => {
          finish(value);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }

          this.logger.warn(
            {
              ...options.logData,
              err: error instanceof Error ? error.message : String(error),
            },
            options.failureMessage,
          );
          finish(options.fallback);
        },
      );
    });
  }

  private buildManagedEntitiesResponseWarmupKey(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): string {
    return `${userId}:${entityType}:response-warmup`;
  }

  private buildManagedEntitiesAllowlistWarmupKey(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): string {
    return `${userId}:${entityType}:allowlist-warmup`;
  }

  private buildManagedEntitiesColdStartRefreshKey(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): string {
    return `${userId}:${entityType}:cold-start-refresh`;
  }

  private buildManagedEntitiesAllowlistCacheKey(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): string {
    return `${userId}:${entityType}:allowlist`;
  }

  private buildManagedEntitiesLastSuccessCacheKey(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): string {
    return `${userId}:${entityType}:last-success`;
  }

  private shouldRunManagedEntitiesRemoteResponseWarmup(): boolean {
    return !this.adminManagedEntitiesRefreshQueue;
  }

  private buildManagedEntitiesRuntimeChatScopeFilter(): Prisma.ChatWhereInput | null {
    const runtimeBotIds = [...this.managedEntitiesRuntimeBotIds];
    if (runtimeBotIds.length === 0) {
      return null;
    }

    const inRuntimeScope = { in: runtimeBotIds };
    return {
      OR: [
        { primaryBotId: inRuntimeScope },
        { botId: inRuntimeScope },
        { botMemberships: { some: { botId: inRuntimeScope } } },
        {
          primaryBotId: null,
          botId: null,
          botMemberships: { none: {} },
        },
      ],
    };
  }

  private filterManagedEntitiesToRuntimeScope(
    chats: readonly ChatSummary[],
    options: {
      requireKnownBot?: boolean;
    } = {},
  ): ChatSummary[] {
    if (this.managedEntitiesRuntimeBotIds.size === 0) {
      return [...chats];
    }

    return chats.filter((chat) => this.isManagedEntityInRuntimeScope(chat, options));
  }

  private isManagedEntityInRuntimeScope(
    chat: Pick<ChatSummary, 'primaryBotId' | 'assignedBots'>,
    options: {
      requireKnownBot?: boolean;
    } = {},
  ): boolean {
    if (this.managedEntitiesRuntimeBotIds.size === 0) {
      return true;
    }

    const primaryBotId = this.normalizeRuntimeManagedEntityBotId(chat.primaryBotId);
    if (primaryBotId) {
      return this.managedEntitiesRuntimeBotIds.has(primaryBotId);
    }

    const assignedBotIds = (chat.assignedBots ?? [])
      .map((bot) => this.normalizeRuntimeManagedEntityBotId(bot.botId))
      .filter((botId): botId is string => Boolean(botId));
    if (assignedBotIds.length > 0) {
      return assignedBotIds.some((botId) => this.managedEntitiesRuntimeBotIds.has(botId));
    }

    return options.requireKnownBot === true ? false : true;
  }

  private normalizeRuntimeManagedEntityBotId(botId: string | null | undefined): string | null {
    return this.maxBotRegistry?.getBotById(botId)?.id ?? this.readTrimmedString(botId) ?? null;
  }

  private normalizeRuntimeManagedEntityBotIds(
    botIds: ReadonlyArray<string | null | undefined>,
  ): string[] {
    return Array.from(
      new Set(
        botIds
          .map((botId) => this.normalizeRuntimeManagedEntityBotId(botId))
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
  }

  private resolveManagedEntityDiscoveryBotIds(
    candidate: Pick<MaxBotChat, 'botId' | 'botIds'>,
  ): string[] {
    return this.normalizeRuntimeManagedEntityBotIds([candidate.botId, ...(candidate.botIds ?? [])]);
  }

  private resolveManagedEntityAccessRepairBotIds(chat: ChatSummary): string[] {
    const explicitBotIds = Array.from(
      new Set(
        [
          this.normalizeRuntimeManagedEntityBotId(chat.primaryBotId),
          ...(chat.assignedBots ?? []).map((bot) =>
            this.normalizeRuntimeManagedEntityBotId(bot.botId),
          ),
        ].filter((botId): botId is string => Boolean(botId)),
      ),
    );
    if (explicitBotIds.length > 0) {
      return explicitBotIds;
    }

    return Array.from(
      new Set(
        [
          this.normalizeManagedEntityAccessBotId(null),
          ...[...this.managedEntitiesRuntimeBotIds].map((botId) =>
            this.normalizeRuntimeManagedEntityBotId(botId),
          ),
        ].filter((botId): botId is string => Boolean(botId)),
      ),
    );
  }

  private cloneManagedEntitySummary(chat: ChatSummary): ChatSummary {
    const favoriteTypes = Array.isArray(chat.favoriteTypes)
      ? this.sortManagedEntityFavoriteTypes(chat.favoriteTypes)
      : [];
    const clone: ChatSummary = {
      ...chat,
      channelOverview: chat.channelOverview ? { ...chat.channelOverview } : null,
      assignedBots: Array.isArray(chat.assignedBots)
        ? chat.assignedBots.map((bot) => ({ ...bot }))
        : [],
    };
    if (favoriteTypes.length > 0) {
      clone.favoriteTypes = favoriteTypes;
    } else {
      delete clone.favoriteTypes;
    }
    return clone;
  }

  private async attachManagedEntityFavoriteTypes(
    userId: string,
    items: readonly ChatSummary[],
  ): Promise<ChatSummary[]> {
    if (items.length === 0) {
      return [];
    }

    const rows = await this.prisma.managedEntityFavorite.findMany({
      where: {
        userId,
        chatId: {
          in: Array.from(new Set(items.map((item) => item.id))),
        },
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: {
        chatId: true,
        entityType: true,
        favoriteType: true,
      },
    });
    const favoriteTypesByKey = new Map<string, ManagedEntityFavoriteType[]>();
    for (const row of rows) {
      const favoriteType = CONTRACT_FAVORITE_TYPE_BY_PRISMA[row.favoriteType];
      const key = `${fromPrismaEntityType(row.entityType)}:${row.chatId}`;
      const current = favoriteTypesByKey.get(key) ?? [];
      if (!current.includes(favoriteType)) {
        current.push(favoriteType);
      }
      favoriteTypesByKey.set(key, current);
    }

    return items.map((item) => {
      const favoriteTypes = favoriteTypesByKey.get(`${item.entityType}:${item.id}`) ?? [];
      const next: ChatSummary = { ...item };
      if (favoriteTypes.length > 0) {
        next.favoriteTypes = this.sortManagedEntityFavoriteTypes(favoriteTypes);
      } else {
        delete next.favoriteTypes;
      }
      return next;
    });
  }

  private async attachManagedEntityFavoriteTypesToDiff(
    userId: string,
    diff: ManagedEntitiesResponseDiff | null | undefined,
  ): Promise<ManagedEntitiesResponseDiff | null | undefined> {
    if (!diff || diff.mode !== 'patch') {
      return diff;
    }

    const [added, updated] = await Promise.all([
      this.attachManagedEntityFavoriteTypes(userId, diff.added),
      this.attachManagedEntityFavoriteTypes(userId, diff.updated),
    ]);

    return {
      ...diff,
      added,
      updated,
    };
  }

  private sortManagedEntityFavoriteTypes(
    favoriteTypes: readonly ManagedEntityFavoriteType[],
  ): ManagedEntityFavoriteType[] {
    const selected = new Set(favoriteTypes);
    return MANAGED_ENTITY_FAVORITE_TYPE_ORDER.filter((favoriteType) => selected.has(favoriteType));
  }

  private getManagedEntityAccessEdgeClient(): ManagedEntityAccessEdgeClient | null {
    const client = (this.prisma as unknown as { managedEntityAccessEdge?: unknown })
      .managedEntityAccessEdge;
    if (!client || typeof client !== 'object') {
      return null;
    }

    const candidate = client as Partial<ManagedEntityAccessEdgeClient>;
    return typeof candidate.findMany === 'function'
      ? (candidate as ManagedEntityAccessEdgeClient)
      : null;
  }

  private resolveManagedEntityAccessRole(
    access: Pick<MaxChatMemberAccess, 'isAdmin' | 'isOwner'> | null | undefined,
  ): ManagedEntityAccessRoleValue {
    if (access?.isOwner === true) {
      return 'OWNER';
    }
    if (access?.isAdmin === true) {
      return 'ADMIN';
    }
    if (access) {
      return 'MEMBER';
    }
    return 'UNKNOWN';
  }

  private normalizeManagedEntityAccessBotId(botId: string | null | undefined): string | null {
    return (
      this.normalizeRuntimeManagedEntityBotId(botId) ??
      this.maxBotRegistry?.getDefaultBot?.()?.id ??
      this.readTrimmedString(botId)
    );
  }

  private isManagedEntityAccessBotInRuntimeScope(botId: string | null | undefined): boolean {
    const normalizedBotId = this.normalizeManagedEntityAccessBotId(botId);
    if (!normalizedBotId) {
      return false;
    }
    return this.managedEntitiesRuntimeBotIds.size === 0
      ? true
      : this.managedEntitiesRuntimeBotIds.has(normalizedBotId);
  }

  private async upsertManagedEntityAccessEdge(params: {
    chatId: string;
    userId: string;
    botId: string | null | undefined;
    entityType: ManagedEntityType;
    state: ManagedEntityAccessStateValue;
    userRole?: ManagedEntityAccessRoleValue;
    botRole?: ManagedEntityAccessRoleValue;
    deniedReason?: string | null;
    source: string;
    expiresAt?: Date | null;
  }): Promise<void> {
    const client = this.getManagedEntityAccessEdgeClient();
    if (!client?.upsert) {
      return;
    }

    const chatId = this.readTrimmedString(params.chatId);
    const userId = this.readTrimmedString(params.userId);
    const botId = this.normalizeManagedEntityAccessBotId(params.botId);
    if (!chatId || !userId || !botId) {
      return;
    }

    const now = new Date();
    const expiresAt =
      params.expiresAt === undefined && params.state === 'GRANTED'
        ? new Date(now.getTime() + MANAGED_ENTITY_ACCESS_EDGE_GRANTED_TTL_MS)
        : (params.expiresAt ?? null);
    const data = {
      entityType: toPrismaEntityType(params.entityType),
      state: params.state,
      userRole: params.userRole ?? 'UNKNOWN',
      botRole: params.botRole ?? 'UNKNOWN',
      checkedAt: now,
      expiresAt,
      deniedReason: params.deniedReason ?? null,
      source: params.source,
    };

    try {
      await client.upsert({
        where: {
          chatId_userId_botId: {
            chatId,
            userId,
            botId,
          },
        },
        create: {
          chatId,
          userId,
          botId,
          ...data,
        },
        update: data,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          botId,
          state: params.state,
          source: params.source,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to upsert managed entity access edge',
      );
    }
  }

  private async markManagedEntityAccessEdgesDeniedForUser(params: {
    chatId: string;
    userId: string;
    state: Exclude<ManagedEntityAccessStateValue, 'GRANTED'>;
    deniedReason: string;
    source: string;
  }): Promise<void> {
    const client = this.getManagedEntityAccessEdgeClient();
    if (!client?.updateMany) {
      return;
    }

    const chatId = this.readTrimmedString(params.chatId);
    const userId = this.readTrimmedString(params.userId);
    if (!chatId || !userId) {
      return;
    }

    try {
      await client.updateMany({
        where: {
          chatId,
          userId,
        },
        data: {
          state: params.state,
          userRole: params.state === 'USER_DENIED' ? 'MEMBER' : 'UNKNOWN',
          botRole: params.state === 'BOT_DENIED' ? 'MEMBER' : 'UNKNOWN',
          checkedAt: new Date(),
          expiresAt: null,
          deniedReason: params.deniedReason,
          source: params.source,
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          state: params.state,
          source: params.source,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to mark managed entity access edges denied',
      );
    }
  }

  private readManagedEntitiesLastSuccessSnapshotExact(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): ChatSummary[] {
    const key = this.buildManagedEntitiesLastSuccessCacheKey(userId, entityType);
    const entry = this.managedEntitiesLastSuccessCache.get(key);
    if (!entry) {
      return [];
    }
    if (entry.expiresAtMs <= Date.now()) {
      this.managedEntitiesLastSuccessCache.delete(key);
      return [];
    }

    return entry.value.map((chat) => this.cloneManagedEntitySummary(chat));
  }

  private readManagedEntitiesLastSuccessSnapshot(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): ChatSummary[] {
    const direct = this.filterManagedEntitiesToRuntimeScope(
      this.readManagedEntitiesLastSuccessSnapshotExact(userId, entityType),
    );
    if (direct.length > 0 || entityType === 'all') {
      return direct;
    }

    return this.filterManagedEntitiesToRuntimeScope(
      this.readManagedEntitiesLastSuccessSnapshotExact(userId, 'all'),
    ).filter((chat) => chat.entityType === entityType);
  }

  private rememberManagedEntitiesLastSuccessSnapshot(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    chats: readonly ChatSummary[],
  ): void {
    if (chats.length === 0) {
      return;
    }

    const key = this.buildManagedEntitiesLastSuccessCacheKey(userId, entityType);
    this.managedEntitiesLastSuccessCache.set(key, {
      expiresAtMs: Date.now() + MANAGED_ENTITIES_LAST_SUCCESS_SNAPSHOT_TTL_MS,
      value: chats.map((chat) => this.cloneManagedEntitySummary(chat)),
    });
  }

  private mergeManagedEntitiesLastSuccessSnapshot(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    chats: readonly ChatSummary[],
  ): void {
    if (chats.length === 0) {
      return;
    }

    const merged = this.mergeManagedEntityGroups(
      chats.map((chat) => this.cloneManagedEntitySummary(chat)),
      this.readManagedEntitiesLastSuccessSnapshotExact(userId, entityType),
    );
    this.rememberManagedEntitiesLastSuccessSnapshot(userId, entityType, merged);
  }

  private rememberManagedEntitiesLastSuccessChats(
    userId: string,
    chats: readonly ChatSummary[],
  ): void {
    if (chats.length === 0) {
      return;
    }

    this.mergeManagedEntitiesLastSuccessSnapshot(userId, 'all', chats);

    const chatsOnly = chats.filter((chat) => chat.entityType === 'chat');
    if (chatsOnly.length > 0) {
      this.mergeManagedEntitiesLastSuccessSnapshot(userId, 'chat', chatsOnly);
    }

    const channelsOnly = chats.filter((chat) => chat.entityType === 'channel');
    if (channelsOnly.length > 0) {
      this.mergeManagedEntitiesLastSuccessSnapshot(userId, 'channel', channelsOnly);
    }
  }

  private forgetManagedEntitiesLastSuccessChat(userId: string, chatId: string): void {
    const prefix = `${userId}:`;
    for (const [key, entry] of this.managedEntitiesLastSuccessCache.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      const remaining = entry.value.filter((chat) => chat.id !== chatId);
      if (remaining.length === 0) {
        this.managedEntitiesLastSuccessCache.delete(key);
        continue;
      }

      this.managedEntitiesLastSuccessCache.set(key, {
        expiresAtMs: entry.expiresAtMs,
        value: remaining.map((chat) => this.cloneManagedEntitySummary(chat)),
      });
    }
  }

  private invalidateManagedEntitiesAllowlistCache(userId: string): void {
    const prefix = `${userId}:`;
    for (const key of this.managedEntitiesAllowlistCache.keys()) {
      if (key.startsWith(prefix)) {
        this.managedEntitiesAllowlistCache.delete(key);
      }
    }
  }

  private listChatsFromAllowlistWithinResponseBudget(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    options: {
      source: 'default' | 'refresh';
    },
  ): Promise<ChatSummary[]> {
    const fallbackSnapshot = this.readManagedEntitiesLastSuccessSnapshot(userId, entityType);
    return this.awaitManagedEntitiesResponseValueWithinBudget(
      this.listChatsFromAllowlist(userId, entityType),
      {
        fallback: fallbackSnapshot,
        budgetMs: MANAGED_ENTITIES_ALLOWLIST_RESPONSE_BUDGET_MS,
        timeoutMessage:
          fallbackSnapshot.length > 0
            ? 'Used last successful managed entities snapshot after allowlist read exceeded response budget'
            : 'Detached managed entities allowlist read from response after response budget exceeded',
        failureMessage:
          'Managed entities allowlist read failed during user-facing managed entities response',
        logData: {
          entityType,
          fallbackItems: fallbackSnapshot.length,
          source: options.source,
          userId,
        },
      },
    );
  }

  private startManagedEntitiesResponseWarmup(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
      includeRefreshState?: boolean;
    } = {},
  ): Promise<ManagedEntitiesListResult> {
    const key = this.buildManagedEntitiesResponseWarmupKey(user.userId, entityType);
    const existing = this.managedEntitiesResponseWarmupRuns.get(key);
    if (existing) {
      return existing;
    }

    const pending = this.discoverManagedEntities(user, entityType, {
      respectCooldown: false,
      fullScan: false,
      includeRefreshState: options.includeRefreshState === true,
      bypassRemoteCache: options.bypassRemoteCache === true,
      resetRefreshCursor: options.resetRefreshCursor === true,
    }).finally(() => {
      if (this.managedEntitiesResponseWarmupRuns.get(key) === pending) {
        this.managedEntitiesResponseWarmupRuns.delete(key);
      }
    });

    this.managedEntitiesResponseWarmupRuns.set(key, pending);
    return pending;
  }

  private scheduleManagedEntitiesPriorityAllowlistWarmup(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      seededChats?: readonly ChatSummary[];
    } = {},
  ): void {
    if (!this.maxChatAdminRosterSyncService) {
      return;
    }

    const key = this.buildManagedEntitiesAllowlistWarmupKey(user.userId, entityType);
    if (this.managedEntitiesAllowlistWarmupRuns.has(key)) {
      return;
    }

    const pending = this.runManagedEntitiesPriorityAllowlistWarmup(user, entityType, options)
      .catch((error: unknown) => {
        this.logger.warn(
          {
            entityType,
            userId: user.userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Managed entities priority allowlist warmup failed',
        );
      })
      .finally(() => {
        if (this.managedEntitiesAllowlistWarmupRuns.get(key) === pending) {
          this.managedEntitiesAllowlistWarmupRuns.delete(key);
        }
      });

    this.managedEntitiesAllowlistWarmupRuns.set(key, pending);
  }

  private async runManagedEntitiesPriorityAllowlistWarmup(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      seededChats?: readonly ChatSummary[];
    } = {},
  ): Promise<void> {
    if (!this.maxChatAdminRosterSyncService) {
      return;
    }

    const seededCandidates = (options.seededChats ?? []).map((chat) =>
      this.toManagedEntitiesDiscoveryCandidate(chat),
    );
    const priorityCandidates = this.mergeManagedEntitiesDiscoverySnapshots(
      seededCandidates,
      await this.loadManagedEntitiesDeltaPrioritySnapshot(user, entityType),
    ).slice(0, MANAGED_ENTITIES_PRIORITY_ALLOWLIST_WARMUP_LIMIT);

    if (priorityCandidates.length === 0) {
      return;
    }

    await this.maxChatAdminRosterSyncService.scheduleDiscoverySnapshotSync(priorityCandidates);
  }

  private scheduleManagedEntitiesColdStartRemoteFullRefresh(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
  ): void {
    if (!this.adminManagedEntitiesRefreshQueue) {
      return;
    }

    const key = this.buildManagedEntitiesColdStartRefreshKey(user.userId, entityType);
    if (this.managedEntitiesColdStartRefreshScheduleRuns.has(key)) {
      return;
    }

    const pending = this.runManagedEntitiesColdStartRemoteFullRefresh(user, entityType)
      .catch((error: unknown) => {
        this.logger.warn(
          {
            entityType,
            userId: user.userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Managed entities cold-start background refresh scheduling failed',
        );
      })
      .finally(() => {
        if (this.managedEntitiesColdStartRefreshScheduleRuns.get(key) === pending) {
          this.managedEntitiesColdStartRefreshScheduleRuns.delete(key);
        }
      });

    this.managedEntitiesColdStartRefreshScheduleRuns.set(key, pending);
  }

  private async runManagedEntitiesColdStartRemoteFullRefresh(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
  ): Promise<void> {
    if (!this.adminManagedEntitiesRefreshQueue) {
      return;
    }

    let previousCursor: number | null = null;
    try {
      previousCursor =
        (await this.chatContextCache.getManagedEntitiesRefreshCursor?.(user.userId, entityType)) ??
        null;
    } catch {
      previousCursor = null;
    }

    const refreshState = await this.prepareManagedEntitiesRemoteFullRefreshState(
      user.userId,
      entityType,
    );
    if (refreshState.backoffActive || refreshState.complete) {
      return;
    }

    const enqueued = await this.enqueueManagedEntitiesRemoteFullRefresh(user.userId, entityType);
    if (
      enqueued ||
      !(previousCursor === null || previousCursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE)
    ) {
      return;
    }

    try {
      await this.chatContextCache.clearManagedEntitiesRefreshCursor?.(user.userId, entityType);
    } catch {
      // Preserve best-effort behavior for passive cold-start scheduling.
    }
  }

  private createManagedEntitySummary(params: {
    id: string;
    title: string;
    createdAt: string;
    entityType: ManagedEntityType;
    link?: string | null;
    avatarUrl?: string | null;
    channelOverview?: ChannelOverview | null;
    primaryBotId?: string | null;
    assignedBots?: ManagedEntityAssignedBot[];
    sharedMode?: ChatSummary['sharedMode'];
    favoriteTypes?: ManagedEntityFavoriteType[];
  }): ChatSummary {
    const assignedBots = [...(params.assignedBots ?? [])];
    return {
      id: params.id,
      title: params.title,
      createdAt: params.createdAt,
      entityType: params.entityType,
      link: params.link ?? null,
      ...(this.readTrimmedString(params.avatarUrl) ? { avatarUrl: params.avatarUrl } : {}),
      channelOverview: params.channelOverview ?? null,
      primaryBotId: this.readTrimmedString(params.primaryBotId) ?? null,
      assignedBots,
      sharedMode: params.sharedMode ?? (assignedBots.length > 1 ? 'shared-standby' : 'owned'),
      ...(params.favoriteTypes && params.favoriteTypes.length > 0
        ? { favoriteTypes: this.sortManagedEntityFavoriteTypes(params.favoriteTypes) }
        : {}),
    };
  }

  private createManagedEntityHeader(params: {
    id: string;
    title: string;
    entityType: ManagedEntityType;
    link?: string | null;
    participantsCount?: number | null;
    avatarUrl?: string | null;
    primaryBotId?: string | null;
    assignedBots?: ManagedEntityAssignedBot[];
    sharedMode?: ManagedEntityHeader['sharedMode'];
  }): ManagedEntityHeader {
    const assignedBots = [...(params.assignedBots ?? [])];
    return {
      id: params.id,
      title: params.title,
      entityType: params.entityType,
      link: params.link ?? null,
      participantsCount: params.participantsCount ?? null,
      ...(this.readTrimmedString(params.avatarUrl) ? { avatarUrl: params.avatarUrl } : {}),
      primaryBotId: this.readTrimmedString(params.primaryBotId) ?? null,
      assignedBots,
      sharedMode: params.sharedMode ?? (assignedBots.length > 1 ? 'shared-standby' : 'owned'),
    };
  }

  private async attachManagedEntityBotAssignments(chats: ChatSummary[]): Promise<ChatSummary[]> {
    if (chats.length === 0) {
      return chats;
    }

    const assignmentsByChatId = await this.readManagedEntityBotAssignments(
      chats.map((chat) => chat.id),
    );

    return chats.map((chat) => this.applyManagedEntityBotAssignments(chat, assignmentsByChatId));
  }

  private async attachManagedEntityHeaderBotAssignments(
    header: ManagedEntityHeader,
  ): Promise<ManagedEntityHeader> {
    const assignmentsByChatId = await this.readManagedEntityBotAssignments([header.id]);
    const enrichedHeader = this.applyManagedEntityBotAssignments(header, assignmentsByChatId);
    return this.attachManagedEntityBotProfiles(enrichedHeader);
  }

  private async readManagedEntityBotAssignments(
    chatIds: readonly string[],
  ): Promise<Map<string, ManagedEntityBotAssignmentsRow>> {
    if (typeof this.prisma.chat.findMany !== 'function') {
      return new Map();
    }

    const normalizedChatIds = Array.from(
      new Set(chatIds.map((chatId) => chatId.trim()).filter((chatId) => chatId.length > 0)),
    );
    if (normalizedChatIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.chat.findMany({
      where: {
        id: {
          in: normalizedChatIds,
        },
      },
      select: {
        id: true,
        botId: true,
        primaryBotId: true,
        botMemberships: {
          select: {
            botId: true,
            role: true,
            status: true,
            capabilities: true,
            permissionsSnapshot: true,
          },
        },
      },
    });

    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          botId: row.botId,
          primaryBotId: row.primaryBotId,
          botMemberships: row.botMemberships.map((membership) => ({
            botId: membership.botId,
            role: membership.role,
            status: membership.status,
            capabilities: membership.capabilities,
            permissionsSnapshot: membership.permissionsSnapshot,
          })),
        } satisfies ManagedEntityBotAssignmentsRow,
      ]),
    );
  }

  private applyManagedEntityBotAssignments<T extends ChatSummary | ManagedEntityHeader>(
    entity: T,
    assignmentsByChatId: Map<string, ManagedEntityBotAssignmentsRow>,
  ): T {
    const persisted = assignmentsByChatId.get(entity.id) ?? null;
    const primaryBotId =
      this.readTrimmedString(persisted?.primaryBotId) ??
      this.readTrimmedString(persisted?.botId) ??
      null;
    const botMetaById = new Map(
      (this.maxBotRegistry?.getAllBots() ?? []).map((bot) => [bot.id, bot] as const),
    );
    const existingBotProfilesById = new Map(
      (Array.isArray(entity.assignedBots) ? entity.assignedBots : [])
        .map((bot) => {
          const normalizedBotId = this.readTrimmedString(bot.botId);
          if (!normalizedBotId) {
            return null;
          }

          return [
            normalizedBotId,
            {
              avatarUrl: this.readTrimmedString(bot.avatarUrl) ?? null,
            } satisfies ManagedEntityBotProfileSnapshot,
          ] as const;
        })
        .filter(
          (entry): entry is readonly [string, ManagedEntityBotProfileSnapshot] => entry !== null,
        ),
    );
    const seenBotIds = new Set<string>();
    const assignedBots: ManagedEntityAssignedBot[] = [];

    for (const membership of persisted?.botMemberships ?? []) {
      const normalizedBotId = this.readTrimmedString(membership.botId);
      if (!normalizedBotId || seenBotIds.has(normalizedBotId)) {
        continue;
      }

      seenBotIds.add(normalizedBotId);
      const botMeta = botMetaById.get(normalizedBotId);
      const existingProfile = existingBotProfilesById.get(normalizedBotId);
      assignedBots.push({
        botId: normalizedBotId,
        label: botMeta?.label ?? normalizedBotId,
        role: membership.role === 'PRIMARY' ? 'primary' : 'standby',
        membershipStatus: membership.status === 'REMOVED' ? 'removed' : 'active',
        lifecycleState: botMeta?.state ?? 'disabled',
        speechPersona: botMeta?.speechPersona ?? 'male',
        characterName: botMeta?.characterName ?? null,
        avatarUrl: existingProfile?.avatarUrl ?? null,
        capabilities: this.normalizeManagedEntityBotCapabilities(membership.capabilities),
        permissionsSummary: this.readManagedEntityPermissionsSummary(
          membership.permissionsSnapshot,
        ),
      });
    }

    if (primaryBotId && !seenBotIds.has(primaryBotId)) {
      const botMeta = botMetaById.get(primaryBotId);
      const existingProfile = existingBotProfilesById.get(primaryBotId);
      assignedBots.unshift({
        botId: primaryBotId,
        label: botMeta?.label ?? primaryBotId,
        role: 'primary',
        membershipStatus: 'active',
        lifecycleState: botMeta?.state ?? 'disabled',
        speechPersona: botMeta?.speechPersona ?? 'male',
        characterName: botMeta?.characterName ?? null,
        avatarUrl: existingProfile?.avatarUrl ?? null,
        capabilities: [],
        permissionsSummary: null,
      });
    }

    assignedBots.sort((left, right) => {
      if (left.role !== right.role) {
        return left.role === 'primary' ? -1 : 1;
      }
      return left.label.localeCompare(right.label, 'ru');
    });

    const sharedMode = this.resolveManagedEntitySharedMode(assignedBots);

    return {
      ...entity,
      primaryBotId,
      assignedBots,
      sharedMode,
    };
  }

  private normalizeManagedEntityBotCapabilities(value: unknown): ManagedEntityBotCapability[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return Array.from(
      new Set(
        value
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .flatMap((item) => {
            const parsed = managedEntityBotCapabilitySchema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
          }),
      ),
    );
  }

  private async attachManagedEntityBotProfiles(
    header: ManagedEntityHeader,
  ): Promise<ManagedEntityHeader> {
    if (
      !Array.isArray(header.assignedBots) ||
      header.assignedBots.length === 0 ||
      typeof this.maxClient.getOwnProfile !== 'function'
    ) {
      return header;
    }

    const cachedProfilesByBotId = new Map<string, ManagedEntityBotProfileSnapshot>();
    const missingBotIds: string[] = [];

    for (const bot of header.assignedBots) {
      const normalizedBotId = this.readTrimmedString(bot.botId);
      if (!normalizedBotId) {
        continue;
      }

      const existingAvatarUrl = this.readTrimmedString(bot.avatarUrl) ?? null;
      if (existingAvatarUrl) {
        cachedProfilesByBotId.set(normalizedBotId, {
          avatarUrl: existingAvatarUrl,
        });
        continue;
      }

      const cachedProfile =
        await this.chatContextCache.getManagedEntityBotProfile?.(normalizedBotId);
      if (cachedProfile) {
        cachedProfilesByBotId.set(normalizedBotId, {
          avatarUrl: this.readTrimmedString(cachedProfile.avatarUrl) ?? null,
        });
        continue;
      }

      missingBotIds.push(normalizedBotId);
    }

    if (missingBotIds.length > 0 && typeof this.maxClient.getOwnProfile === 'function') {
      const results = await Promise.allSettled(
        missingBotIds.map(async (botId) => {
          const profile = await this.maxClient.getOwnProfile({
            botId,
            trafficClass: 'interactive',
            timeoutMs: 2_500,
            sourceTag: MAX_API_SOURCE_TAGS.SETTINGS_BOT_PROFILE,
          });
          const snapshot = {
            avatarUrl: this.readTrimmedString(profile.avatarUrl) ?? null,
          } satisfies ManagedEntityBotProfileSnapshot;
          cachedProfilesByBotId.set(botId, snapshot);
          await this.chatContextCache.setManagedEntityBotProfile?.(botId, snapshot);
        }),
      );

      const rejectedProfiles = results
        .map((result, index) =>
          result.status === 'rejected'
            ? {
                botId: missingBotIds[index] ?? 'unknown',
                err: result.reason instanceof Error ? result.reason.message : String(result.reason),
              }
            : null,
        )
        .filter((entry): entry is { botId: string; err: string } => entry !== null);
      if (rejectedProfiles.length > 0) {
        this.logger.warn(
          {
            chatId: header.id,
            botIds: rejectedProfiles.map((entry) => entry.botId),
            errors: rejectedProfiles.map((entry) => entry.err),
          },
          'Failed to resolve some managed entity bot avatars from MAX',
        );
      }
    }

    return {
      ...header,
      assignedBots: header.assignedBots.map((bot) => {
        const normalizedBotId = this.readTrimmedString(bot.botId);
        if (!normalizedBotId) {
          return bot;
        }

        const cachedProfile = cachedProfilesByBotId.get(normalizedBotId);
        return {
          ...bot,
          avatarUrl: cachedProfile?.avatarUrl ?? this.readTrimmedString(bot.avatarUrl) ?? null,
        };
      }),
    };
  }

  private readManagedEntityPermissionsSummary(
    value: unknown,
  ): ManagedEntityAssignedBot['permissionsSummary'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const checkedAt =
      typeof row.checkedAt === 'string' && row.checkedAt.trim().length > 0 ? row.checkedAt : null;
    const permissions = Array.isArray(row.permissions)
      ? Array.from(
          new Set(
            row.permissions
              .map((item) => (typeof item === 'string' ? item.trim() : ''))
              .filter((item): item is string => item.length > 0),
          ),
        )
      : [];

    return {
      checkedAt,
      isAdmin: row.isAdmin === true,
      isOwner: row.isOwner === true,
      permissions,
    };
  }

  private resolveManagedEntitySharedMode(
    assignedBots: readonly ManagedEntityAssignedBot[],
  ): ChatSummary['sharedMode'] {
    const activeBots = assignedBots.filter((bot) => bot.membershipStatus === 'active');
    if (activeBots.length <= 1) {
      return 'owned';
    }

    const primaryBot = activeBots.find((bot) => bot.role === 'primary') ?? activeBots[0];
    if (activeBots.some((bot) => bot.role === 'standby' && bot.capabilities.length > 0)) {
      return 'shared-assist';
    }

    if (primaryBot?.lifecycleState === 'draining') {
      return 'shared-failover';
    }

    return 'shared-standby';
  }

  private mergeManagedEntitiesDiscoverySnapshots(
    ...groups: readonly ManagedEntitiesDiscoverySnapshot[]
  ): ManagedEntitiesDiscoverySnapshot {
    const mergedByChatId = new Map<string, MaxBotChat>();

    for (const group of groups) {
      for (const chat of group) {
        if (!chat.chatId) {
          continue;
        }

        const existing = mergedByChatId.get(chat.chatId);
        const mergedBotIds = Array.from(
          new Set([
            ...(existing?.botIds ?? []),
            ...(chat.botIds ?? []),
            ...(chat.botId ? [chat.botId] : []),
          ]),
        );

        if (!existing) {
          mergedByChatId.set(chat.chatId, {
            ...chat,
            botIds: mergedBotIds,
            botId: this.readTrimmedString(chat.botId) ?? mergedBotIds[0] ?? null,
          });
          continue;
        }

        mergedByChatId.set(chat.chatId, {
          ...existing,
          title: this.readTrimmedString(existing.title) ?? this.readTrimmedString(chat.title),
          lastEventTime: Math.max(existing.lastEventTime ?? 0, chat.lastEventTime ?? 0),
          entityType: existing.entityType,
          link: this.readTrimmedString(existing.link) ?? this.readTrimmedString(chat.link),
          avatarUrl:
            this.readTrimmedString(existing.avatarUrl) ?? this.readTrimmedString(chat.avatarUrl),
          botId: this.readTrimmedString(existing.botId) ?? this.readTrimmedString(chat.botId),
          botIds: mergedBotIds,
        });
      }
    }

    return [...mergedByChatId.values()];
  }

  private toManagedEntitiesDiscoveryCandidate(chat: ChatSummary): MaxBotChat {
    return {
      chatId: chat.id,
      title: chat.title,
      lastEventTime: Date.parse(chat.createdAt) || 0,
      entityType: chat.entityType,
      link: chat.link ?? null,
      avatarUrl: chat.avatarUrl ?? null,
      botId: chat.primaryBotId ?? null,
      botIds: chat.assignedBots.map((bot) => bot.botId),
    };
  }

  private async readLocalManagedEntitiesRefreshState(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    options: { backoffActiveOverride?: boolean } = {},
  ): Promise<ManagedEntitiesRefreshState> {
    const refreshCooldownKey = this.buildManagedEntitiesRefreshCooldownKey(userId, entityType);
    const backoffActive =
      options.backoffActiveOverride ??
      (await this.isManagedEntitiesRefreshBackoffActive(userId, entityType, refreshCooldownKey));
    const nextPollAfterMs = backoffActive
      ? await this.getManagedEntitiesRefreshBackoffRemainingMs(
          userId,
          entityType,
          refreshCooldownKey,
        )
      : 0;
    const lastSyncedAt =
      (await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(userId, entityType)) ?? null;

    return this.createManagedEntitiesRefreshState(
      backoffActive ? null : MANAGED_ENTITIES_REFRESH_CURSOR_DONE,
      backoffActive,
      nextPollAfterMs,
      {
        totalCandidates: null,
        lastSyncedAt,
      },
    );
  }

  private async loadManagedEntitiesLocalDiscoverySnapshot(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: { limit: number },
  ): Promise<ManagedEntitiesDiscoverySnapshot> {
    const normalizedUserId = user.userId.trim();
    if (!normalizedUserId) {
      return [];
    }

    const lookbackFrom = new Date(Date.now() - MANAGED_ENTITIES_LOCAL_ACTIVITY_LOOKBACK_MS);
    const managedEntitiesReadPrisma = this.getManagedEntitiesReadPrisma();
    const limit = Math.max(1, options.limit);
    const rows = await managedEntitiesReadPrisma.$queryRaw<
      Array<{
        chat_id: string | null;
        chat_title: string | null;
        chat_type: string | null;
        created_at: Date;
      }>
    >`
      SELECT
        activities.chat_id,
        COALESCE(NULLIF(BTRIM(activities.chat_title), ''), chats.title) AS chat_title,
        COALESCE(
          CASE activities.entity_type
            WHEN 'CHANNEL' THEN 'channel'
            ELSE 'chat'
          END,
          CASE chats.entity_type
            WHEN 'CHANNEL' THEN 'channel'
            ELSE 'chat'
          END
        ) AS chat_type,
        activities.last_event_at AS created_at
      FROM managed_entity_local_activities AS activities
      LEFT JOIN chats ON chats.id = activities.chat_id
      WHERE activities.user_id = ${normalizedUserId}
        AND activities.last_event_at >= ${lookbackFrom}
      ORDER BY activities.last_event_at DESC
      LIMIT ${limit}
    `;

    const sourceRows =
      rows.length > 0
        ? rows
        : await this.loadManagedEntitiesLocalDiscoverySnapshotFromWebhookEvents(
            managedEntitiesReadPrisma,
            normalizedUserId,
            lookbackFrom,
            limit,
          );

    const snapshot: ManagedEntitiesDiscoverySnapshot = [];
    for (const row of Array.isArray(sourceRows) ? sourceRows : []) {
      const chatId = this.readTrimmedString(row.chat_id);
      if (!chatId) {
        continue;
      }

      const hintedEntityType = this.normalizeManagedEntityTypeHint(row.chat_type) ?? 'chat';
      if (hintedEntityType === 'chat' && isPrivateDirectChat(chatId)) {
        continue;
      }
      if (entityType !== 'all' && hintedEntityType !== entityType) {
        continue;
      }

      snapshot.push({
        chatId,
        title: this.readTrimmedString(row.chat_title) ?? chatId,
        lastEventTime: row.created_at instanceof Date ? row.created_at.getTime() : 0,
        entityType: hintedEntityType,
        link: null,
        avatarUrl: null,
      });
    }

    return snapshot;
  }

  private async loadManagedEntitiesLocalDiscoverySnapshotFromWebhookEvents(
    prisma: PrismaClient | Pick<PrismaService, 'chatAdminAllowlist' | '$queryRaw' | 'chat'>,
    normalizedUserId: string,
    lookbackFrom: Date,
    limit: number,
  ): Promise<
    Array<{
      chat_id: string | null;
      chat_title: string | null;
      chat_type: string | null;
      created_at: Date;
    }>
  > {
    const trimmedUserId = normalizedUserId.trim();
    if (!trimmedUserId) {
      return [];
    }

    return prisma.$queryRaw<
      Array<{
        chat_id: string | null;
        chat_title: string | null;
        chat_type: string | null;
        created_at: Date;
      }>
    >`
      WITH local_candidates AS (
        SELECT DISTINCT ON (chat_id)
          chat_id,
          chat_title,
          chat_type,
          created_at
        FROM (
          SELECT
            NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') AS chat_id,
            NULLIF(BTRIM(normalized_payload->'message'->>'chatTitle'), '') AS chat_title,
            LOWER(
              COALESCE(
                NULLIF(BTRIM(normalized_payload->'raw'->>'chat_type'), ''),
                NULLIF(BTRIM(normalized_payload->'raw'->>'chatType'), ''),
                NULLIF(BTRIM(normalized_payload->'raw'->'chat'->>'chat_type'), ''),
                NULLIF(BTRIM(normalized_payload->'raw'->'chat'->>'chatType'), ''),
                CASE
                  WHEN NULLIF(BTRIM(normalized_payload->'raw'->>'is_channel'), '') = 'true'
                    THEN 'channel'
                  WHEN NULLIF(BTRIM(normalized_payload->'raw'->>'is_channel'), '') = 'false'
                    THEN 'chat'
                  ELSE NULL
                END
              )
            ) AS chat_type,
            created_at
          FROM webhook_events
          WHERE normalized_payload->'message'->>'senderId' = ${trimmedUserId}
            AND NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') IS NOT NULL
            AND normalized_payload->>'type' IN (${Prisma.join(
              MANAGED_ENTITIES_LOCAL_ACTIVITY_EVENT_TYPES,
            )})
            AND created_at >= ${lookbackFrom}
        ) ranked
        WHERE chat_id IS NOT NULL
        ORDER BY chat_id, created_at DESC
      )
      SELECT
        local_candidates.chat_id,
        COALESCE(local_candidates.chat_title, chats.title) AS chat_title,
        COALESCE(
          local_candidates.chat_type,
          CASE chats.entity_type
            WHEN 'CHANNEL' THEN 'channel'
            ELSE 'chat'
          END
        ) AS chat_type,
        local_candidates.created_at
      FROM local_candidates
      LEFT JOIN chats ON chats.id = local_candidates.chat_id
      ORDER BY local_candidates.created_at DESC
      LIMIT ${limit}
    `;
  }

  private async loadManagedEntitiesDeltaPrioritySnapshot(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ManagedEntitiesDiscoverySnapshot> {
    let localCandidates: ManagedEntitiesDiscoverySnapshot = [];

    try {
      localCandidates = await this.loadManagedEntitiesLocalDiscoverySnapshot(user, entityType, {
        limit: MANAGED_ENTITIES_REFRESH_UNCACHED_LIMIT,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityType,
          userId: user.userId,
          code:
            error instanceof Prisma.PrismaClientKnownRequestError
              ? error.code
              : ((error as { code?: string } | null)?.code ?? null),
          err: error instanceof Error ? error.message : String(error),
        },
        isPrismaKnownError(error, 'P2024')
          ? 'Skipped managed entities local priority snapshot because the Prisma pool is saturated'
          : 'Failed to load managed entities local priority snapshot',
      );
    }

    return localCandidates;
  }

  private async persistManagedEntityAccessBestEffort(params: {
    chatId: string;
    userId: string;
    title: string | null;
    entityType: ManagedEntityType;
    link?: string | null;
    avatarUrl?: string | null;
    createdAtFallback?: string | null;
    preferredBotId?: string | null;
    observedBotIds?: readonly string[] | null;
    source: 'remote_discovery' | 'local_discovery' | 'recent_bot_added_bootstrap';
  }): Promise<ChatSummary> {
    try {
      const persistedChat = await this.upsertUserChatAccess(
        params.chatId,
        params.userId,
        params.title,
        params.entityType,
        {
          updateEntityType: true,
          preferredBotId: params.preferredBotId ?? null,
          observedBotIds: params.observedBotIds ?? [],
          titleUpdateMode:
            params.source === 'recent_bot_added_bootstrap' ? 'fallback_only' : 'always',
        },
      );

      const summary = this.createManagedEntitySummary({
        id: persistedChat.id,
        title: persistedChat.title,
        createdAt: persistedChat.createdAt.toISOString(),
        entityType: fromPrismaEntityType(persistedChat.entityType),
        link: params.link ?? null,
        avatarUrl: params.avatarUrl ?? null,
        primaryBotId:
          this.readTrimmedString(persistedChat.primaryBotId ?? persistedChat.botId) ?? null,
      });
      const accessEdgeBotIds = Array.from(
        new Set(
          [
            persistedChat.primaryBotId,
            persistedChat.botId,
            params.preferredBotId,
            ...(params.observedBotIds ?? []),
          ]
            .map((botId) => this.normalizeManagedEntityAccessBotId(botId))
            .filter((botId): botId is string => Boolean(botId)),
        ),
      );
      await Promise.all(
        accessEdgeBotIds.map((botId) =>
          this.upsertManagedEntityAccessEdge({
            chatId: summary.id,
            userId: params.userId,
            botId,
            entityType: summary.entityType,
            state: 'GRANTED',
            userRole: 'ADMIN',
            botRole: 'ADMIN',
            source: params.source,
          }),
        ),
      );
      this.rememberManagedEntitiesLastSuccessChats(params.userId, [summary]);
      try {
        await this.upsertManagedEntitiesPublishedSnapshotItem(params.userId, summary);
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: summary.id,
            entityType: summary.entityType,
            userId: params.userId,
            source: params.source,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to patch managed entities published snapshot after access discovery',
        );
      }

      return summary;
    } catch (error: unknown) {
      if (!isPrismaKnownError(error, 'P2024')) {
        throw error;
      }

      const resolvedBotId =
        this.maxBotRegistry?.getBotById(params.preferredBotId)?.id ??
        (params.observedBotIds ?? [])
          .map((botId) => this.maxBotRegistry?.getBotById(botId)?.id ?? null)
          .find((botId): botId is string => Boolean(botId)) ??
        null;
      if (resolvedBotId) {
        this.maxBotLinkService?.rememberChatBotBinding?.(params.chatId, resolvedBotId);
      }

      this.logger.warn(
        {
          chatId: params.chatId,
          entityType: params.entityType,
          userId: params.userId,
          source: params.source,
          code:
            error instanceof Prisma.PrismaClientKnownRequestError
              ? error.code
              : ((error as { code?: string } | null)?.code ?? null),
          err: error instanceof Error ? error.message : String(error),
        },
        'Using transient managed entity summary because the Prisma pool is saturated',
      );

      const summary = this.createManagedEntitySummary({
        id: params.chatId,
        title:
          resolvePresentableManagedEntityTitle(params.chatId, params.title, null, null) ??
          params.chatId,
        createdAt: this.readTrimmedString(params.createdAtFallback) ?? new Date().toISOString(),
        entityType: params.entityType,
        link: params.link ?? null,
        avatarUrl: params.avatarUrl ?? null,
        primaryBotId: resolvedBotId,
      });
      this.rememberManagedEntitiesLastSuccessChats(params.userId, [summary]);

      return summary;
    }
  }

  private normalizeManagedEntityTypeHint(value: unknown): ManagedEntityType | null {
    const normalized = this.readLowerString(value);
    if (normalized === 'channel') {
      return 'channel';
    }
    if (normalized === 'chat') {
      return 'chat';
    }

    return null;
  }

  private async collectManagedEntitiesForMassAction(
    user: AuthUser,
    entityType: ManagedEntityType,
    options: {
      discoveryMode?: 'full' | 'cached-first';
    } = {},
  ): Promise<ChatSummary[]> {
    if (options.discoveryMode === 'cached-first') {
      return this.collectManagedEntitiesForCachedMassAction(user, entityType);
    }

    try {
      await this.chatContextCache.clearManagedEntitiesRefreshCursor?.(user.userId, entityType);
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityType,
          userId: user.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to reset managed entities refresh cursor before mass action scan',
      );
    }

    const collected = new Map<string, ChatSummary>();
    const cached = await this.revalidateCachedManagedEntities(
      user,
      await this.listChatsFromAllowlist(user.userId, entityType),
    );
    for (const item of cached) {
      collected.set(item.id, item);
    }
    let refreshState: ManagedEntitiesRefreshState | null = null;
    let previousCursor: number | null | undefined = undefined;
    let attemptedPasses = 0;
    const bypassRemoteCacheOnInitialPass = collected.size === 0;

    for (let pass = 0; pass < MANAGED_ENTITIES_MASS_ACTION_FULL_SCAN_MAX_PASSES; pass += 1) {
      attemptedPasses = pass + 1;
      let result: ManagedEntitiesListResult;
      try {
        result = await this.discoverManagedEntities(user, entityType, {
          respectCooldown: false,
          fullScan: true,
          includeRefreshState: true,
          bypassRemoteCache: pass === 0 && bypassRemoteCacheOnInitialPass,
        });
      } catch (error: unknown) {
        if (collected.size > 0 && isMaxApiThrottleError(error)) {
          this.logger.warn(
            {
              entityType,
              userId: user.userId,
              cachedItems: collected.size,
              err: error instanceof Error ? error.message : String(error),
            },
            'Managed entities mass action scan hit MAX API throttle; using cached allowlist fallback',
          );
          break;
        }
        throw error;
      }
      for (const item of result.items) {
        collected.set(item.id, item);
      }

      refreshState = result.refresh;
      if (!refreshState || refreshState.complete || refreshState.backoffActive) {
        break;
      }
      if (refreshState.cursor === null || refreshState.cursor === previousCursor) {
        break;
      }

      previousCursor = refreshState.cursor;
    }

    if (refreshState && !refreshState.complete && !refreshState.backoffActive) {
      this.logger.warn(
        {
          entityType,
          userId: user.userId,
          cursor: refreshState.cursor,
          passes: attemptedPasses,
        },
        'Managed entities mass action scan stopped before completion',
      );
    }

    return [...collected.values()];
  }

  private async collectManagedEntitiesForCachedMassAction(
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ChatSummary[]> {
    const collected = new Map<string, ChatSummary>();

    const publishedSnapshot = await this.readManagedEntitiesPublishedSnapshotForResponse(
      user.userId,
      entityType,
    );
    for (const item of publishedSnapshot?.items ?? []) {
      collected.set(item.id, item);
    }

    const cached = await this.revalidateCachedManagedEntities(
      user,
      await this.listChatsFromAllowlistWithinResponseBudget(user.userId, entityType, {
        source: 'refresh',
      }),
    );
    for (const item of cached) {
      collected.set(item.id, item);
    }

    if (collected.size === 0) {
      for (const item of this.readManagedEntitiesLastSuccessSnapshot(user.userId, entityType)) {
        collected.set(item.id, item);
      }
    }

    if (this.adminManagedEntitiesRefreshQueue) {
      void this.scheduleManagedEntitiesRemoteFullRefresh(user, entityType).catch(
        (error: unknown) => {
          this.logger.warn(
            {
              entityType,
              userId: user.userId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to schedule managed entities background refresh after cached mass action lookup',
          );
        },
      );
    }

    return [...collected.values()];
  }

  private async bootstrapRecentBotAddedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ChatSummary[]> {
    const normalizedUserId = user.userId.trim();
    if (!normalizedUserId) {
      return [];
    }

    const managedEntitiesReadPrisma = this.getManagedEntitiesReadPrisma();
    const [rows, cachedRows] = await Promise.all([
      this.loadRecentBotAddedBootstrapRows(normalizedUserId),
      this.loadRecentBotAddedBootstrapCacheRows(normalizedUserId, entityType),
    ]);
    const safeRows = this.mergeRecentBotAddedBootstrapRows(
      cachedRows,
      Array.isArray(rows) ? rows : [],
    );

    const bootstrapped: ChatSummary[] = [];
    const seen = new Set<string>();
    let attemptedAdminChecks = 0;
    const startedAtMs = Date.now();

    for (const row of safeRows) {
      const chatId = this.readTrimmedString(row.chat_id);
      if (!chatId || seen.has(chatId)) {
        continue;
      }
      seen.add(chatId);

      const hintedEntityType: ManagedEntityType = row.is_channel === 'true' ? 'channel' : 'chat';
      if (entityType !== 'all' && hintedEntityType !== entityType) {
        continue;
      }
      if (isUnsupportedManagedChat(chatId, hintedEntityType)) {
        this.schedulePersistedChatAccessPrune(
          chatId,
          normalizedUserId,
          'bootstrap_recent_bot_added',
        );
        continue;
      }

      const elapsedMs = Date.now() - startedAtMs;
      if (elapsedMs >= RECENT_BOT_ADDED_BOOTSTRAP_MAX_ELAPSED_MS) {
        this.logger.debug(
          {
            entityType,
            userId: normalizedUserId,
            attemptedAdminChecks,
            elapsedMs,
            scannedCandidates: seen.size,
          },
          'Stopped recent bot_added bootstrap before completion to keep lightweight chat discovery responsive',
        );
        break;
      }

      if (attemptedAdminChecks >= RECENT_BOT_ADDED_BOOTSTRAP_MAX_ADMIN_CHECKS) {
        this.logger.debug(
          {
            entityType,
            userId: normalizedUserId,
            attemptedAdminChecks,
            scannedCandidates: seen.size,
          },
          'Stopped recent bot_added bootstrap before completion to keep lightweight chat discovery responsive',
        );
        break;
      }

      attemptedAdminChecks += 1;
      const access = await this.resolveUserAndBotAdminAccess(chatId, normalizedUserId, {
        bypassNegativeCache: true,
        allowPersistedFallback: false,
        entityType: hintedEntityType,
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        timeoutMs: RECENT_BOT_ADDED_BOOTSTRAP_ADMIN_TIMEOUT_MS,
      });
      if (access.status === 'unknown' || access.status === 'throttled') {
        if (row.user_scoped) {
          this.scheduleUserScopedRecentBotAddedFastLane({
            chatId,
            entityType: hintedEntityType,
            title: this.readTrimmedString(row.chat_title),
            userId: normalizedUserId,
            reason: access.status,
          });
        }
        this.logger.debug(
          {
            chatId,
            entityType,
            userId: normalizedUserId,
            attemptedAdminChecks,
            accessStatus: access.status,
          },
          'Stopped recent bot_added bootstrap after a slow admin access lookup',
        );
        break;
      }
      if (access.status !== 'granted') {
        if (row.user_scoped && access.reason === 'bot_not_admin') {
          this.scheduleUserScopedRecentBotAddedFastLane({
            chatId,
            entityType: hintedEntityType,
            title: this.readTrimmedString(row.chat_title),
            userId: normalizedUserId,
            reason: access.reason,
          });
        }
        continue;
      }

      const existing = await managedEntitiesReadPrisma.chat.findUnique({
        where: { id: chatId },
        select: {
          title: true,
        },
      });
      const cachedHeader = await this.chatContextCache.getManagedEntityHeader?.(
        chatId,
        hintedEntityType,
      );
      const resolvedTitle =
        resolvePresentableManagedEntityTitle(
          chatId,
          this.readTrimmedString(row.chat_title),
          this.readTrimmedString(cachedHeader?.title),
          this.readTrimmedString(existing?.title),
        ) ??
        (row.user_scoped
          ? hintedEntityType === 'channel'
            ? `Channel ${chatId}`
            : `Chat ${chatId}`
          : null);
      if (!resolvedTitle) {
        continue;
      }
      const chat = await this.persistManagedEntityAccessBestEffort({
        chatId,
        userId: normalizedUserId,
        title: resolvedTitle,
        entityType: hintedEntityType,
        source: 'recent_bot_added_bootstrap',
      });

      bootstrapped.push(
        row.user_scoped
          ? await this.maybeHydrateRecentBotAddedBootstrapChat(normalizedUserId, entityType, chat)
          : chat,
      );
      if (bootstrapped.length >= RECENT_BOT_ADDED_BOOTSTRAP_LIMIT) {
        break;
      }
    }

    this.scheduleManagedEntitiesPublishedSnapshotRebuildForBootstrapChats(
      normalizedUserId,
      entityType,
      bootstrapped,
    );

    return bootstrapped;
  }

  private async loadRecentBotAddedBootstrapCacheRows(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<
    Array<{
      chat_id: string | null;
      chat_title: string | null;
      is_channel: string | null;
      user_scoped: boolean;
      last_event_at: Date | string | null;
      source: 'cache' | 'activity';
    }>
  > {
    if (typeof this.chatContextCache.getManagedEntitiesRecentBootstrap !== 'function') {
      return [];
    }

    const normalizedUserId = userId.trim();
    const entityTypes: ManagedEntityType[] =
      entityType === 'all' ? ['chat', 'channel'] : [entityType];
    const groups = await Promise.all(
      entityTypes.map(
        (currentEntityType) =>
          this.chatContextCache.getManagedEntitiesRecentBootstrap?.(
            currentEntityType,
            normalizedUserId,
          ) ?? Promise.resolve([]),
      ),
    );

    return this.mergeRecentBotAddedBootstrapRows(
      ...groups.map((group) =>
        group
          .filter((chat) => !isUnsupportedManagedChat(chat.id, chat.entityType))
          .map((chat) => ({
            chat_id: chat.id,
            chat_title: chat.title,
            is_channel: chat.entityType === 'channel' ? 'true' : 'false',
            user_scoped:
              normalizedUserId.length > 0 &&
              Array.isArray(chat.bootstrapUserIds) &&
              chat.bootstrapUserIds.some((candidateUserId) => candidateUserId === normalizedUserId),
            last_event_at: this.readTrimmedString(chat.createdAt),
            source: 'cache' as const,
          })),
      ),
    );
  }

  private mergeRecentBotAddedBootstrapRows(
    ...groups: Array<
      Array<{
        chat_id: string | null;
        chat_title: string | null;
        is_channel: string | null;
        user_scoped: boolean;
        last_event_at: Date | string | null;
        source: 'activity' | 'cache';
      }>
    >
  ): Array<{
    chat_id: string | null;
    chat_title: string | null;
    is_channel: string | null;
    user_scoped: boolean;
    last_event_at: Date | string | null;
    source: 'activity' | 'cache';
  }> {
    const merged = new Map<
      string,
      {
        chat_id: string | null;
        chat_title: string | null;
        is_channel: string | null;
        user_scoped: boolean;
        last_event_at: Date | string | null;
        source: 'activity' | 'cache';
      }
    >();

    for (const group of groups) {
      for (const row of group) {
        const chatId = this.readTrimmedString(row.chat_id);
        if (!chatId) {
          continue;
        }

        const existing = merged.get(chatId);
        if (!existing) {
          merged.set(chatId, row);
          continue;
        }

        if (row.user_scoped && !existing.user_scoped) {
          merged.set(chatId, row);
          continue;
        }
        if (!row.user_scoped && existing.user_scoped) {
          continue;
        }
        if (
          existing.source === 'cache' &&
          row.source !== 'cache' &&
          existing.user_scoped === row.user_scoped
        ) {
          continue;
        }

        const existingEventAtMs = this.readRecentBotAddedEventTimestampMs(existing.last_event_at);
        const nextEventAtMs = this.readRecentBotAddedEventTimestampMs(row.last_event_at);
        if (
          nextEventAtMs !== null &&
          (existingEventAtMs === null || nextEventAtMs > existingEventAtMs)
        ) {
          merged.set(chatId, row);
          continue;
        }

        if (
          nextEventAtMs === existingEventAtMs &&
          this.readTrimmedString(row.chat_title) &&
          !this.readTrimmedString(existing.chat_title)
        ) {
          merged.set(chatId, row);
        }
      }
    }

    return [...merged.values()];
  }

  private async buildRecentBotAddedProvisionalChat(params: {
    row: {
      chat_id: string | null;
      chat_title: string | null;
      is_channel: string | null;
      user_scoped: boolean;
      last_event_at: Date | string | null;
      source: 'activity' | 'cache';
    };
    userId: string;
    entityType: ManagedEntityTypeFilter;
    hintedEntityType: ManagedEntityType;
    prisma: ReturnType<AdminService['getManagedEntitiesReadPrisma']>;
  }): Promise<ChatSummary | null> {
    if (!params.row.user_scoped) {
      return null;
    }

    const chatId = this.readTrimmedString(params.row.chat_id);
    if (!chatId) {
      return null;
    }

    const [existing, cachedHeader] = await Promise.all([
      params.prisma.chat.findUnique({
        where: { id: chatId },
        select: {
          title: true,
          createdAt: true,
          primaryBotId: true,
          botId: true,
        },
      }),
      this.chatContextCache.getManagedEntityHeader?.(chatId, params.hintedEntityType) ?? null,
    ]);
    const eventAtMs = this.readRecentBotAddedEventTimestampMs(params.row.last_event_at);
    const hasPersistedBootstrapContext =
      existing !== null || this.readTrimmedString(cachedHeader?.title) !== null;
    if (
      eventAtMs === null ||
      (!hasPersistedBootstrapContext &&
        params.row.source !== 'cache' &&
        Date.now() - eventAtMs > RECENT_BOT_ADDED_FAST_LANE_RETRY_WINDOW_MS)
    ) {
      return null;
    }

    const resolvedTitle =
      resolvePresentableManagedEntityTitle(
        chatId,
        this.readTrimmedString(params.row.chat_title),
        this.readTrimmedString(cachedHeader?.title),
        this.readTrimmedString(existing?.title),
      ) ?? (params.hintedEntityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`);

    const createdAtIso =
      existing?.createdAt instanceof Date
        ? existing.createdAt.toISOString()
        : new Date(eventAtMs).toISOString();
    const provisional = this.createManagedEntitySummary({
      id: chatId,
      title: resolvedTitle,
      createdAt: createdAtIso,
      entityType: params.hintedEntityType,
      primaryBotId:
        this.normalizeRuntimeManagedEntityBotId(
          this.readTrimmedString(existing?.primaryBotId) ??
            this.readTrimmedString(existing?.botId) ??
            null,
        ) ?? null,
    });
    const hydrated = await this.maybeHydrateRecentBotAddedBootstrapChat(
      params.userId,
      params.entityType,
      provisional,
    );
    this.rememberManagedEntitiesLastSuccessChats(params.userId, [hydrated]);
    return hydrated;
  }

  private readRecentBotAddedEventTimestampMs(value: Date | string | null): number | null {
    if (value instanceof Date) {
      const timestampMs = value.getTime();
      return Number.isFinite(timestampMs) ? timestampMs : null;
    }

    const normalized = this.readTrimmedString(value);
    if (!normalized) {
      return null;
    }

    const timestampMs = Date.parse(normalized);
    return Number.isFinite(timestampMs) ? timestampMs : null;
  }

  private scheduleUserScopedRecentBotAddedFastLane(params: {
    chatId: string;
    entityType: ManagedEntityType;
    title: string | null;
    userId: string;
    reason: 'unknown' | 'throttled' | 'bot_not_admin';
  }): void {
    if (!this.maxChatAdminRosterSyncService) {
      return;
    }

    void this.maxChatAdminRosterSyncService
      .scheduleChatAdminRosterSync({
        chatId: params.chatId,
        title: params.title,
        entityType: params.entityType,
        source: 'webhook_bot_added',
        retryUntilMs: Date.now() + RECENT_BOT_ADDED_FAST_LANE_RETRY_WINDOW_MS,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          {
            chatId: params.chatId,
            entityType: params.entityType,
            userId: params.userId,
            reason: params.reason,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to schedule user-scoped recent bot_added fast lane retry',
        );
      });
  }

  private async maybeHydrateRecentBotAddedBootstrapChat(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    chat: ChatSummary,
  ): Promise<ChatSummary> {
    if (!isFallbackTitle(chat.id, chat.title)) {
      return chat;
    }

    const key = [userId, entityType, chat.entityType, chat.id].join(':');
    const existing = this.recentBotAddedImmediateHeaderHydrationRuns.get(key);
    const pending =
      existing ??
      this.runRecentBotAddedImmediateHeaderHydration(userId, entityType, chat)
        .catch((error: unknown) => {
          this.logger.debug(
            {
              chatId: chat.id,
              entityType: chat.entityType,
              userId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Immediate recent bot_added header hydration fell back to provisional title',
          );
          return this.cloneManagedEntitySummary(chat);
        })
        .finally(() => {
          if (this.recentBotAddedImmediateHeaderHydrationRuns.get(key) === pending) {
            this.recentBotAddedImmediateHeaderHydrationRuns.delete(key);
          }
        });

    if (!existing) {
      this.recentBotAddedImmediateHeaderHydrationRuns.set(key, pending);
    }

    return this.awaitManagedEntitiesResponseValueWithinBudget(pending, {
      fallback: this.cloneManagedEntitySummary(chat),
      budgetMs: RECENT_BOT_ADDED_BOOTSTRAP_HEADER_RESPONSE_BUDGET_MS,
      timeoutMessage:
        'Detached immediate recent bot_added header hydration after response budget exceeded',
      failureMessage: 'Immediate recent bot_added header hydration failed',
      logData: {
        chatId: chat.id,
        entityType: chat.entityType,
        userId,
      },
    });
  }

  private async runRecentBotAddedImmediateHeaderHydration(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    chat: ChatSummary,
  ): Promise<ChatSummary> {
    if (typeof this.maxClient.getChatSnapshot !== 'function') {
      return this.cloneManagedEntitySummary(chat);
    }

    const candidateBotIds = new Set<string>();
    const preferredBotId = this.maxBotRegistry?.getBotById(chat.primaryBotId)?.id ?? null;
    if (preferredBotId) {
      candidateBotIds.add(preferredBotId);
    }
    for (const botId of await this.resolveCandidateBotIdsForChat(chat.id, {
      includeDiscoveryFallback: true,
    })) {
      candidateBotIds.add(botId);
    }

    const botIds = [...candidateBotIds];
    const lookupOrder = botIds.length > 0 ? botIds : [null];

    for (const botId of lookupOrder) {
      try {
        const snapshot = await this.maxClient.getChatSnapshot(chat.id, {
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
          ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
          timeoutMs: RECENT_BOT_ADDED_BOOTSTRAP_HEADER_TIMEOUT_MS,
          bypassCache: true,
          ...(botId ? { botId } : {}),
        });

        const resolvedTitle =
          resolvePresentableManagedEntityTitle(chat.id, snapshot.title, chat.title) ?? chat.title;
        const resolvedLink = this.readTrimmedString(snapshot.link) ?? chat.link ?? null;
        const resolvedAvatarUrl =
          this.readTrimmedString(snapshot.avatarUrl) ?? this.readTrimmedString(chat.avatarUrl);
        const hydratedSnapshot = {
          title: resolvedTitle,
          link: resolvedLink,
          participantsCount: snapshot.participantsCount,
          avatarUrl: resolvedAvatarUrl ?? null,
        };

        await this.persistManagedEntityHeaderSnapshot(chat, hydratedSnapshot);
        const hydrated = this.cloneManagedEntitySummary({
          ...chat,
          title: resolvedTitle,
          link: resolvedLink,
          ...(resolvedAvatarUrl ? { avatarUrl: resolvedAvatarUrl } : {}),
        });
        await this.upsertManagedEntitiesPublishedSnapshotItem(userId, hydrated);
        this.scheduleManagedEntitiesPublishedSnapshotRebuild(userId, entityType);

        this.rememberManagedEntitiesLastSuccessChats(userId, [hydrated]);
        return hydrated;
      } catch (error: unknown) {
        if (isBotAdminLookupDeniedError(error)) {
          continue;
        }

        if (isMaxApiThrottleError(error) || isMaxApiTimeoutError(error)) {
          break;
        }

        this.logger.debug(
          {
            chatId: chat.id,
            entityType: chat.entityType,
            botId: botId ?? 'default',
            err: error instanceof Error ? error.message : String(error),
          },
          'Immediate recent bot_added header hydration failed for candidate bot',
        );
      }
    }

    return this.cloneManagedEntitySummary(chat);
  }

  private async revalidateCachedManagedEntities(
    user: AuthUser,
    chats: ChatSummary[],
  ): Promise<ChatSummary[]> {
    if (chats.length === 0) {
      return chats;
    }

    const cachedAccessStates = await Promise.all(
      chats.map(async (chat) => ({
        chat,
        cachedAccess: (await this.chatContextCache.getAdminAccess?.(chat.id, user.userId)) ?? null,
      })),
    );
    const filtered: Array<ChatSummary | null> = new Array<ChatSummary | null>(chats.length).fill(
      null,
    );
    const staleDeniedChats: Array<{ chat: ChatSummary; index: number }> = [];
    const suspiciousChats: Array<{ chat: ChatSummary; index: number }> = [];

    for (const [index, entry] of cachedAccessStates.entries()) {
      if (entry.cachedAccess === 'user_denied' || entry.cachedAccess === 'bot_denied') {
        staleDeniedChats.push({
          chat: entry.chat,
          index,
        });
        continue;
      }

      if (
        entry.cachedAccess !== 'granted' &&
        this.isSuspiciousManagedEntitiesAllowlistChat(entry.chat)
      ) {
        suspiciousChats.push({
          chat: entry.chat,
          index,
        });
        continue;
      }

      filtered[index] = entry.chat;
    }

    const suspiciousChatsToRevalidate = suspiciousChats.slice(
      0,
      MANAGED_ENTITIES_SUSPICIOUS_ALLOWLIST_REVALIDATION_LIMIT,
    );
    for (const candidate of suspiciousChats.slice(suspiciousChatsToRevalidate.length)) {
      filtered[candidate.index] = candidate.chat;
    }

    const revalidationCandidates: Array<{
      chat: ChatSummary;
      index: number;
      strict: boolean;
      options: {
        bypassNegativeCache: true;
        allowPersistedFallback?: false;
        entityType?: ManagedEntityType;
        trafficClass?: 'background';
        sourceTag?: string;
        timeoutMs?: number;
      };
    }> = [
      ...staleDeniedChats.map((candidate) => ({
        ...candidate,
        strict: true,
        options: {
          bypassNegativeCache: true as const,
          allowPersistedFallback: false as const,
          entityType: candidate.chat.entityType,
        },
      })),
      ...suspiciousChatsToRevalidate.map((candidate) => ({
        ...candidate,
        strict: false,
        options: {
          bypassNegativeCache: true as const,
          allowPersistedFallback: false as const,
          entityType: candidate.chat.entityType,
          trafficClass: 'background' as const,
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
          timeoutMs: MANAGED_ENTITIES_SUSPICIOUS_ALLOWLIST_ADMIN_TIMEOUT_MS,
        },
      })),
    ];

    if (revalidationCandidates.length > 0) {
      const revalidatedChats = await mapWithConcurrencyLimit(
        revalidationCandidates,
        LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
        async ({ chat, strict, options }) => {
          const access = await this.resolveUserAndBotAdminAccess(chat.id, user.userId, options);

          if (strict) {
            return access.status === 'granted' ? chat : null;
          }

          return access.status === 'denied' ? null : chat;
        },
      );

      for (const [index, chat] of revalidatedChats.entries()) {
        if (!chat) {
          continue;
        }

        filtered[revalidationCandidates[index].index] = chat;
      }
    }

    return filtered.filter((chat): chat is ChatSummary => chat !== null);
  }

  private isSuspiciousManagedEntitiesAllowlistChat(chat: ChatSummary): boolean {
    return resolvePresentableManagedEntityTitle(chat.id, chat.title) === null;
  }

  private async discoverManagedEntitiesFromLocalCatalog(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      respectCooldown: boolean;
      fullScan: boolean;
      includeRefreshState?: boolean;
    },
  ): Promise<ManagedEntitiesListResult> {
    const refreshCooldownKey = this.buildManagedEntitiesRefreshCooldownKey(user.userId, entityType);
    const backoffActive = await this.isManagedEntitiesRefreshBackoffActive(
      user.userId,
      entityType,
      refreshCooldownKey,
    );
    const cooldownActive =
      options.respectCooldown &&
      (await this.isManagedEntitiesRefreshCooldownActive(
        user.userId,
        entityType,
        refreshCooldownKey,
      ));

    if (backoffActive || cooldownActive) {
      return {
        items: [],
        refresh:
          options.includeRefreshState === true
            ? await this.readLocalManagedEntitiesRefreshState(user.userId, entityType, {
                backoffActiveOverride: backoffActive,
              })
            : null,
      };
    }

    const discoveryKey = [
      user.userId,
      entityType,
      'local',
      options.fullScan ? 'full' : 'delta',
    ].join(':');
    const inFlight = this.managedEntitiesDiscoveryChecks.get(discoveryKey);
    const pending =
      inFlight ??
      this.runManagedEntitiesLocalDiscovery(user, entityType, refreshCooldownKey, options);

    if (!inFlight) {
      this.managedEntitiesDiscoveryChecks.set(discoveryKey, pending);
    }

    try {
      return await pending;
    } finally {
      if (!inFlight) {
        this.managedEntitiesDiscoveryChecks.delete(discoveryKey);
      }
    }
  }

  private async repairManagedEntitiesAllowlistAfterFullRefresh(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    verifiedItems: readonly ChatSummary[],
    candidateIds: readonly string[] | null | undefined,
  ): Promise<void> {
    const allowlist = await this.listChatsFromAllowlist(userId, entityType);
    if (allowlist.length === 0) {
      return;
    }

    const verifiedChatIds = new Set(verifiedItems.map((item) => item.id));
    const candidateChatIds = new Set(candidateIds ?? verifiedItems.map((item) => item.id));
    await mapWithConcurrencyLimit(allowlist, 8, async (chat) => {
      const cachedAccess = (await this.chatContextCache.getAdminAccess?.(chat.id, userId)) ?? null;
      if (cachedAccess === 'user_denied' || cachedAccess === 'bot_denied') {
        await this.prunePersistedChatAccess(chat.id, userId);
        return null;
      }

      if (!candidateChatIds.has(chat.id)) {
        await this.prunePersistedChatAccess(chat.id, userId);
        return null;
      }

      if (!verifiedChatIds.has(chat.id)) {
        return null;
      }

      if (!isFallbackTitle(chat.id, chat.title)) {
        return null;
      }

      const cachedHeader = await this.chatContextCache.getManagedEntityHeader?.(
        chat.id,
        chat.entityType,
      );
      const presentableTitle = resolvePresentableManagedEntityTitle(
        chat.id,
        this.readTrimmedString(cachedHeader?.title),
      );
      if (presentableTitle) {
        await this.prisma.chat.update({
          where: { id: chat.id },
          data: { title: presentableTitle },
        });
        return null;
      }

      await this.prunePersistedChatAccess(chat.id, userId);
      return null;
    });
  }

  private withManagedEntitiesFullScanCandidateIds(
    result: ManagedEntitiesListResult,
    candidateIds: readonly string[],
  ): ManagedEntitiesListResult {
    Object.defineProperty(result, 'fullScanCandidateIds', {
      value: [...candidateIds],
      enumerable: false,
      configurable: true,
    });
    return result;
  }

  private async runManagedEntitiesLocalDiscovery(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    refreshCooldownKey: string,
    options: {
      respectCooldown: boolean;
      fullScan: boolean;
      includeRefreshState?: boolean;
    },
  ): Promise<ManagedEntitiesListResult> {
    const cachedChats = await this.listChatsFromAllowlist(user.userId, entityType);
    const cachedIds = new Set(cachedChats.map((chat) => chat.id));
    let storedCursor =
      options.fullScan === true
        ? ((await this.chatContextCache.getManagedEntitiesRefreshCursor?.(
            user.userId,
            entityType,
          )) ?? 0)
        : null;
    if (options.fullScan === true && storedCursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE) {
      storedCursor = 0;
      await this.chatContextCache.clearManagedEntitiesRefreshCursor?.(user.userId, entityType);
    }
    const cachedAccessStates = await Promise.all(
      cachedChats.map(async (chat) => ({
        chat,
        cachedAccess: (await this.chatContextCache.getAdminAccess?.(chat.id, user.userId)) ?? null,
      })),
    );
    const staleDeniedCachedCandidates = cachedAccessStates
      .filter(
        (entry) => entry.cachedAccess === 'user_denied' || entry.cachedAccess === 'bot_denied',
      )
      .map((entry) => this.toManagedEntitiesDiscoveryCandidate(entry.chat));
    const prioritizedCandidateIds = new Set(staleDeniedCachedCandidates.map((chat) => chat.chatId));
    const candidateChats = this.mergeManagedEntitiesDiscoverySnapshots(
      staleDeniedCachedCandidates,
      await this.loadManagedEntitiesLocalDiscoverySnapshot(user, entityType, {
        limit: options.fullScan
          ? MANAGED_ENTITIES_LOCAL_CANDIDATE_LIMIT
          : MANAGED_ENTITIES_REFRESH_UNCACHED_LIMIT,
      }),
    );

    const fullScanStartIndex =
      options.fullScan === true
        ? Math.max(0, Math.min(storedCursor ?? 0, candidateChats.length))
        : 0;
    const fullScanEndIndex =
      options.fullScan === true
        ? Math.min(
            candidateChats.length,
            fullScanStartIndex + MANAGED_ENTITIES_LOCAL_REFRESH_SCAN_WINDOW_SIZE,
          )
        : 0;
    const candidateSlice = options.fullScan
      ? candidateChats.slice(fullScanStartIndex, fullScanEndIndex)
      : candidateChats.filter(
          (chat) => !cachedIds.has(chat.chatId) || prioritizedCandidateIds.has(chat.chatId),
        );

    try {
      const resolvedChats = await mapWithConcurrencyLimit(
        candidateSlice,
        LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
        async (candidate) => {
          const access = await this.resolveUserAndBotAdminAccess(candidate.chatId, user.userId, {
            bypassNegativeCache: true,
            allowPersistedFallback: false,
            entityType: candidate.entityType,
            candidateBotIds: this.resolveManagedEntityDiscoveryBotIds(candidate),
            trafficClass: 'background',
            sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
            timeoutMs: MANAGED_ENTITIES_LOCAL_DISCOVERY_ADMIN_TIMEOUT_MS,
          });
          if (access.status === 'throttled') {
            throw new ManagedEntitiesRefreshThrottledError(access.error);
          }
          if (access.status === 'unknown') {
            return null;
          }
          if (access.status !== 'granted') {
            return {
              kind: 'remove' as const,
              chatId: candidate.chatId,
            };
          }

          const chat = await this.persistManagedEntityAccessBestEffort({
            chatId: candidate.chatId,
            userId: user.userId,
            title: candidate.title,
            entityType: candidate.entityType,
            link: candidate.link,
            avatarUrl: candidate.avatarUrl?.trim() ?? null,
            preferredBotId: candidate.botId ?? null,
            observedBotIds: candidate.botIds ?? [],
            source: 'local_discovery',
          });

          return {
            kind: 'include' as const,
            chat,
            lastEventTime: candidate.lastEventTime ?? 0,
          };
        },
      );

      await this.activateManagedEntitiesRefreshCooldown(
        user.userId,
        entityType,
        refreshCooldownKey,
      );

      const removedChatIds = new Set(
        resolvedChats
          .filter(
            (
              item,
            ): item is {
              kind: 'remove';
              chatId: string;
            } => item !== null && item.kind === 'remove',
          )
          .map((item) => item.chatId),
      );
      const grantedById = new Map(
        resolvedChats
          .filter(
            (
              item,
            ): item is {
              kind: 'include';
              chat: ChatSummary;
              lastEventTime: number;
            } => item !== null && item.kind === 'include',
          )
          .map((item) => [item.chat.id, item]),
      );
      const verifiedCached = cachedChats.filter((chat) => {
        if (grantedById.has(chat.id)) {
          return false;
        }
        if (removedChatIds.has(chat.id)) {
          return false;
        }

        return true;
      });
      const mergedChats = [
        ...grantedById.values(),
        ...verifiedCached.map((chat) => ({
          chat,
          lastEventTime: 0,
        })),
      ]
        .sort((left, right) => right.lastEventTime - left.lastEventTime)
        .map((item) => item.chat);
      const hydratedItems = await this.attachChannelOverview(
        await this.attachManagedEntityAvatars(mergedChats),
      );
      this.scheduleManagedEntityHeaderHydration(user.userId, entityType, hydratedItems);
      if (!options.fullScan) {
        this.scheduleManagedEntitiesPublishedSnapshotRebuildForBootstrapChats(
          user.userId,
          entityType,
          Array.from(grantedById.values()).map((item) => item.chat),
        );
      }

      let nextCursor: number | null = null;
      let completedAt: string | null = null;
      if (options.fullScan === true) {
        if (fullScanEndIndex >= candidateChats.length) {
          nextCursor = MANAGED_ENTITIES_REFRESH_CURSOR_DONE;
          await this.chatContextCache.clearManagedEntitiesRefreshCursor?.(user.userId, entityType);
          completedAt = new Date().toISOString();
          await this.chatContextCache.setManagedEntitiesLastSyncedAt?.(
            user.userId,
            entityType,
            completedAt,
            MANAGED_ENTITIES_REFRESH_LAST_SYNCED_TTL_SEC,
          );
        } else {
          nextCursor = fullScanEndIndex;
          await this.chatContextCache.setManagedEntitiesRefreshCursor?.(
            user.userId,
            entityType,
            fullScanEndIndex,
            MANAGED_ENTITIES_REFRESH_CURSOR_TTL_SEC,
          );
        }
      }

      const result: ManagedEntitiesListResult = {
        items: hydratedItems,
        refresh:
          options.includeRefreshState === true
            ? options.fullScan === true
              ? this.createManagedEntitiesRefreshState(nextCursor, false, undefined, {
                  totalCandidates: candidateChats.length,
                  lastSyncedAt:
                    completedAt ??
                    (await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(
                      user.userId,
                      entityType,
                    )) ??
                    null,
                })
              : this.createManagedEntitiesRefreshState(
                  MANAGED_ENTITIES_REFRESH_CURSOR_DONE,
                  false,
                  0,
                  {
                    totalCandidates: null,
                    lastSyncedAt:
                      (await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(
                        user.userId,
                        entityType,
                      )) ?? null,
                  },
                )
            : null,
      };
      return options.fullScan === true
        ? this.withManagedEntitiesFullScanCandidateIds(
            result,
            candidateChats.map((chat) => chat.chatId),
          )
        : result;
    } catch (error: unknown) {
      if (
        this.isManagedEntitiesRefreshThrottledError(error) ||
        isMaxApiThrottleError(error) ||
        isMaxApiTimeoutError(error)
      ) {
        const rootError =
          error instanceof ManagedEntitiesRefreshThrottledError ? error.cause : error;
        const backoffMs = await this.activateManagedEntitiesRefreshBackoff(
          user.userId,
          entityType,
          refreshCooldownKey,
        );
        this.logger.log(
          {
            entityType,
            userId: user.userId,
            backoffMs,
            err: rootError instanceof Error ? rootError.message : String(rootError),
          },
          'Paused local managed entity discovery after MAX API throttling',
        );
      } else {
        this.logger.warn(
          {
            entityType,
            userId: user.userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to discover managed entities from local catalog',
        );
      }

      return {
        items: [],
        refresh:
          options.includeRefreshState === true
            ? await this.readLocalManagedEntitiesRefreshState(user.userId, entityType, {
                backoffActiveOverride:
                  this.isManagedEntitiesRefreshThrottledError(error) ||
                  isMaxApiThrottleError(error) ||
                  isMaxApiTimeoutError(error),
              })
            : null,
      };
    }
  }

  private async discoverManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      respectCooldown: boolean;
      fullScan: boolean;
      includeRefreshState?: boolean;
      bypassRemoteCache?: boolean;
      revalidateCachedChats?: boolean;
      resetRefreshCursor?: boolean;
      throwOnFailure?: boolean;
    },
  ): Promise<ManagedEntitiesListResult> {
    const refreshCooldownKey = this.buildManagedEntitiesRefreshCooldownKey(user.userId, entityType);
    const backoffActive = await this.isManagedEntitiesRefreshBackoffActive(
      user.userId,
      entityType,
      refreshCooldownKey,
    );
    const cooldownActive =
      options.respectCooldown &&
      (await this.isManagedEntitiesRefreshCooldownActive(
        user.userId,
        entityType,
        refreshCooldownKey,
      ));

    if (!backoffActive && !cooldownActive) {
      const discoveryKey = [
        user.userId,
        entityType,
        options.fullScan ? 'full' : 'delta',
        options.bypassRemoteCache === true ? 'bypass' : 'cache',
        options.resetRefreshCursor === true ? 'reset' : 'resume',
      ].join(':');
      const inFlight = this.managedEntitiesDiscoveryChecks.get(discoveryKey);
      const pending =
        inFlight ??
        this.runManagedEntitiesDiscovery(user, entityType, refreshCooldownKey, {
          fullScan: options.fullScan,
          includeRefreshState: options.includeRefreshState === true,
          bypassRemoteCache: options.bypassRemoteCache === true,
          revalidateCachedChats: options.revalidateCachedChats === true,
          resetRefreshCursor: options.resetRefreshCursor === true,
          throwOnFailure: options.throwOnFailure === true,
        });

      if (!inFlight) {
        this.managedEntitiesDiscoveryChecks.set(discoveryKey, pending);
      }

      try {
        return await pending;
      } finally {
        if (!inFlight) {
          this.managedEntitiesDiscoveryChecks.delete(discoveryKey);
        }
      }
    }

    return {
      items: [],
      refresh:
        options.includeRefreshState === true
          ? await this.readManagedEntitiesRefreshState(user.userId, entityType, {
              backoffActiveOverride: backoffActive,
            })
          : null,
    };
  }

  private async runManagedEntitiesDiscovery(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    refreshCooldownKey: string,
    options: {
      fullScan: boolean;
      includeRefreshState?: boolean;
      bypassRemoteCache?: boolean;
      revalidateCachedChats?: boolean;
      resetRefreshCursor?: boolean;
      throwOnFailure?: boolean;
    },
  ): Promise<ManagedEntitiesListResult> {
    try {
      const discoveryTrafficClass = 'background';
      const adminCheckSpacingMs = options.fullScan
        ? MANAGED_ENTITIES_FULL_SCAN_ADMIN_CHECK_SPACING_MS
        : MANAGED_ENTITIES_DELTA_ADMIN_CHECK_SPACING_MS;
      const adminCheckTimeoutMs = options.fullScan
        ? MANAGED_ENTITIES_REMOTE_FULL_SCAN_ADMIN_TIMEOUT_MS
        : MANAGED_ENTITIES_REMOTE_DELTA_ADMIN_TIMEOUT_MS;
      const snapshotTimeoutMs = options.fullScan
        ? MANAGED_ENTITIES_REMOTE_FULL_SCAN_SNAPSHOT_TIMEOUT_MS
        : MANAGED_ENTITIES_REMOTE_DELTA_SNAPSHOT_TIMEOUT_MS;
      const cachedChats = await this.listChatsFromAllowlist(user.userId, entityType);
      const cachedIds = new Set(cachedChats.map((chat) => chat.id));
      const cachedById = new Map(cachedChats.map((chat) => [chat.id, chat]));
      let storedCursor =
        options.fullScan === true
          ? ((await this.chatContextCache.getManagedEntitiesRefreshCursor?.(
              user.userId,
              entityType,
            )) ?? 0)
          : null;
      let supportedCandidateChats: ManagedEntitiesDiscoverySnapshot;

      if (options.fullScan === true) {
        if (options.resetRefreshCursor === true) {
          storedCursor = 0;
          await this.chatContextCache.clearManagedEntitiesRefreshCursor?.(user.userId, entityType);
          await this.chatContextCache.clearManagedEntitiesDiscoverySnapshot?.(
            user.userId,
            entityType,
          );
        }

        const startNewFullScan =
          options.resetRefreshCursor === true ||
          storedCursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE;
        const cachedSnapshot =
          startNewFullScan !== true
            ? ((await this.chatContextCache.getManagedEntitiesDiscoverySnapshot?.(
                user.userId,
                entityType,
              )) ?? null)
            : null;

        if (cachedSnapshot) {
          supportedCandidateChats = cachedSnapshot;
        } else {
          supportedCandidateChats = await this.loadManagedEntitiesDiscoverySnapshot(entityType, {
            trafficClass: discoveryTrafficClass,
            bypassCache: options.bypassRemoteCache === true,
            timeoutMs: snapshotTimeoutMs,
          });
          const priorityCandidates = await this.loadManagedEntitiesDeltaPrioritySnapshot(
            user,
            entityType,
          );
          if (priorityCandidates.length > 0) {
            supportedCandidateChats = this.mergeManagedEntitiesDiscoverySnapshots(
              priorityCandidates,
              supportedCandidateChats,
            );
          }
          storedCursor = 0;
          await this.chatContextCache.setManagedEntitiesDiscoverySnapshot?.(
            user.userId,
            entityType,
            supportedCandidateChats,
            MANAGED_ENTITIES_REFRESH_SNAPSHOT_TTL_SEC,
          );
        }
      } else {
        supportedCandidateChats = await this.loadManagedEntitiesDiscoverySnapshot(entityType, {
          trafficClass: discoveryTrafficClass,
          bypassCache: options.bypassRemoteCache === true,
          timeoutMs: snapshotTimeoutMs,
        });
        const priorityCandidates = await this.loadManagedEntitiesDeltaPrioritySnapshot(
          user,
          entityType,
        );
        if (priorityCandidates.length > 0) {
          supportedCandidateChats = this.mergeManagedEntitiesDiscoverySnapshots(
            priorityCandidates,
            supportedCandidateChats,
          );
        }
      }

      const remoteIndexByChatId = new Map(
        supportedCandidateChats.map((chat, index) => [chat.chatId, index]),
      );
      const fullScanStartIndex =
        options.fullScan === true
          ? Math.max(0, Math.min(storedCursor ?? 0, supportedCandidateChats.length))
          : 0;
      const fullScanEndIndex =
        options.fullScan === true
          ? Math.min(
              supportedCandidateChats.length,
              fullScanStartIndex + MANAGED_ENTITIES_REFRESH_SCAN_WINDOW_SIZE,
            )
          : 0;
      const mergedKnownChats = supportedCandidateChats.flatMap((remoteChat, remoteIndex) => {
        const cachedChat = cachedById.get(remoteChat.chatId);
        if (!cachedChat) {
          return [];
        }

        if (options.revalidateCachedChats === true) {
          return [];
        }

        const deferCachedChatToCurrentScanWindow =
          options.fullScan === true &&
          remoteIndex >= fullScanStartIndex &&
          remoteIndex < fullScanEndIndex;
        if (deferCachedChatToCurrentScanWindow) {
          return [];
        }

        cachedById.delete(remoteChat.chatId);
        return [
          {
            chat: {
              ...cachedChat,
              title: remoteChat.title?.trim() ? remoteChat.title : cachedChat.title,
              link: remoteChat.link,
              ...(remoteChat.avatarUrl?.trim() ? { avatarUrl: remoteChat.avatarUrl.trim() } : {}),
            },
            lastEventTime: remoteChat.lastEventTime ?? 0,
            remoteIndex,
          },
        ];
      });
      const uncachedCandidates = supportedCandidateChats.filter(
        (remoteChat) => !cachedIds.has(remoteChat.chatId),
      );
      const candidateSlice =
        options.fullScan === true
          ? supportedCandidateChats.slice(fullScanStartIndex, fullScanEndIndex)
          : options.revalidateCachedChats === true
            ? supportedCandidateChats
            : uncachedCandidates.slice(0, MANAGED_ENTITIES_DELTA_DISCOVERY_WINDOW_SIZE);
      if (options.fullScan === true && candidateSlice.length > 0) {
        this.scheduleManagedEntitiesCatalogSync(candidateSlice, discoveryTrafficClass, {
          exhaustiveWindow: true,
          scopeKey: `${entityType}:full-window`,
        });
      }
      const resolvedChats = await mapWithConcurrencyLimit(
        candidateSlice,
        LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
        async (remoteChat) => {
          const cachedChat = cachedById.get(remoteChat.chatId) ?? null;
          const shouldRevalidateCachedChat =
            cachedChat !== null &&
            (options.fullScan === true || options.revalidateCachedChats === true);
          if (!shouldRevalidateCachedChat && cachedIds.has(remoteChat.chatId)) {
            return null;
          }
          if (adminCheckSpacingMs > 0) {
            await this.sleep(adminCheckSpacingMs);
          }
          const access = await this.resolveUserAndBotAdminAccess(remoteChat.chatId, user.userId, {
            bypassNegativeCache: true,
            allowPersistedFallback: false,
            entityType: remoteChat.entityType,
            candidateBotIds: this.resolveManagedEntityDiscoveryBotIds(remoteChat),
            trafficClass: discoveryTrafficClass,
            sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
            timeoutMs: adminCheckTimeoutMs,
          });
          if (access.status === 'throttled') {
            throw new ManagedEntitiesRefreshThrottledError(access.error);
          }
          if (access.status === 'unknown') {
            return null;
          }

          if (access.status !== 'granted') {
            if (shouldRevalidateCachedChat) {
              cachedById.delete(remoteChat.chatId);
            }
            return {
              kind: 'remove' as const,
              chatId: remoteChat.chatId,
            };
          }

          if (shouldRevalidateCachedChat) {
            cachedById.delete(remoteChat.chatId);
          }

          const chat = await this.persistManagedEntityAccessBestEffort({
            chatId: remoteChat.chatId,
            userId: user.userId,
            title: remoteChat.title,
            entityType: remoteChat.entityType,
            link: remoteChat.link,
            avatarUrl: remoteChat.avatarUrl?.trim() ?? null,
            createdAtFallback: cachedChat?.createdAt ?? null,
            preferredBotId: remoteChat.botId ?? null,
            observedBotIds: remoteChat.botIds ?? [],
            source: 'remote_discovery',
          });

          return {
            kind: 'include' as const,
            chat,
            lastEventTime: remoteChat.lastEventTime ?? 0,
            remoteIndex: remoteIndexByChatId.get(remoteChat.chatId) ?? Number.MAX_SAFE_INTEGER,
          };
        },
      );

      if (options.revalidateCachedChats === true) {
        const cachedChatIdsMissingFromRemoteSnapshot = [...cachedById.keys()].filter(
          (chatId) => !remoteIndexByChatId.has(chatId),
        );
        if (cachedChatIdsMissingFromRemoteSnapshot.length > 0) {
          await mapWithConcurrencyLimit(
            cachedChatIdsMissingFromRemoteSnapshot,
            LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
            async (chatId) => {
              await this.prunePersistedChatAccessBestEffort(
                chatId,
                user.userId,
                'fresh_remote_discovery_missing_chat',
              );
            },
          );
        }
      }

      const removedChatIds = new Set(
        resolvedChats
          .filter(
            (
              item,
            ): item is {
              kind: 'remove';
              chatId: string;
            } => item !== null && item.kind === 'remove',
          )
          .map((item) => item.chatId),
      );
      if (options.revalidateCachedChats === true && removedChatIds.size > 0) {
        await mapWithConcurrencyLimit(
          [...removedChatIds],
          LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
          async (chatId) => {
            await this.prunePersistedChatAccessBestEffort(
              chatId,
              user.userId,
              'fresh_remote_discovery_denied_chat',
            );
          },
        );
      }
      const filtered = resolvedChats.filter(
        (
          item,
        ): item is {
          kind: 'include';
          chat: ChatSummary;
          lastEventTime: number;
          remoteIndex: number;
        } => item !== null && item.kind === 'include',
      );
      const remainingCachedChats =
        options.fullScan === true || options.revalidateCachedChats === true
          ? []
          : [...cachedById.values()].map((chat) => ({
              chat,
              lastEventTime: 0,
              remoteIndex: Number.MAX_SAFE_INTEGER,
            }));
      const mergedChats = [
        ...mergedKnownChats.filter((item) => !removedChatIds.has(item.chat.id)),
        ...filtered,
        ...remainingCachedChats,
      ];
      let nextCursor: number | null = null;
      let completedAt: string | null = null;

      if (options.fullScan === true) {
        if (fullScanEndIndex >= supportedCandidateChats.length) {
          nextCursor = MANAGED_ENTITIES_REFRESH_CURSOR_DONE;
          await this.chatContextCache.setManagedEntitiesRefreshCursor?.(
            user.userId,
            entityType,
            MANAGED_ENTITIES_REFRESH_CURSOR_DONE,
            MANAGED_ENTITIES_REFRESH_CURSOR_DONE_TTL_SEC,
          );
          await this.chatContextCache.clearManagedEntitiesDiscoverySnapshot?.(
            user.userId,
            entityType,
          );
          completedAt = new Date().toISOString();
          await this.chatContextCache.setManagedEntitiesLastSyncedAt?.(
            user.userId,
            entityType,
            completedAt,
            MANAGED_ENTITIES_REFRESH_LAST_SYNCED_TTL_SEC,
          );
        } else {
          nextCursor = fullScanEndIndex;
          await this.chatContextCache.setManagedEntitiesRefreshCursor?.(
            user.userId,
            entityType,
            fullScanEndIndex,
            MANAGED_ENTITIES_REFRESH_CURSOR_TTL_SEC,
          );
        }
      }

      await this.activateManagedEntitiesRefreshCooldown(
        user.userId,
        entityType,
        refreshCooldownKey,
      );

      mergedChats.sort((a, b) => {
        if (a.remoteIndex !== b.remoteIndex) {
          return a.remoteIndex - b.remoteIndex;
        }

        return b.lastEventTime - a.lastEventTime;
      });
      const items = await this.hydrateManagedEntities(
        mergedChats.map((item) => item.chat),
        {
          remoteChats: supportedCandidateChats,
        },
      );
      this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items, {
        remoteChats: supportedCandidateChats,
      });
      if (!options.fullScan) {
        this.scheduleManagedEntitiesPublishedSnapshotRebuildForBootstrapChats(
          user.userId,
          entityType,
          filtered.map((item) => item.chat),
        );
      }
      const result: ManagedEntitiesListResult = {
        items,
        refresh:
          options.includeRefreshState === true
            ? options.fullScan === true
              ? this.createManagedEntitiesRefreshState(nextCursor, false, undefined, {
                  totalCandidates: supportedCandidateChats.length,
                  lastSyncedAt:
                    completedAt ??
                    (await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(
                      user.userId,
                      entityType,
                    )) ??
                    null,
                })
              : await this.readManagedEntitiesRefreshState(user.userId, entityType)
            : null,
      };
      return options.fullScan === true
        ? this.withManagedEntitiesFullScanCandidateIds(
            result,
            supportedCandidateChats.map((chat) => chat.chatId),
          )
        : result;
    } catch (error: unknown) {
      if (
        this.isManagedEntitiesRefreshThrottledError(error) ||
        isMaxApiThrottleError(error) ||
        isMaxApiTimeoutError(error)
      ) {
        const rootError =
          error instanceof ManagedEntitiesRefreshThrottledError ? error.cause : error;
        const backoffMs = await this.activateManagedEntitiesRefreshBackoff(
          user.userId,
          entityType,
          refreshCooldownKey,
        );
        this.logger.warn(
          {
            entityType,
            userId: user.userId,
            backoffMs,
            err: rootError instanceof Error ? rootError.message : String(rootError),
          },
          'Paused remote chat discovery after MAX API throttling',
        );
      } else {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'Failed to auto-discover chats via MAX API',
        );
      }

      if (options.throwOnFailure === true) {
        throw error;
      }

      return {
        items: [],
        refresh:
          options.includeRefreshState === true
            ? await this.readManagedEntitiesRefreshState(user.userId, entityType, {
                backoffActiveOverride:
                  this.isManagedEntitiesRefreshThrottledError(error) ||
                  isMaxApiThrottleError(error) ||
                  isMaxApiTimeoutError(error),
              })
            : null,
      };
    }
  }

  private async loadManagedEntitiesDiscoverySnapshot(
    entityType: ManagedEntityTypeFilter,
    options: {
      trafficClass: 'critical' | 'interactive' | 'background';
      bypassCache?: boolean;
      timeoutMs?: number;
    },
  ): Promise<ManagedEntitiesDiscoverySnapshot> {
    if (typeof this.maxClient.listBotChats !== 'function') {
      return [];
    }

    const discoveryBots = this.maxBotRegistry?.getDiscoveryBots() ?? [];
    if (discoveryBots.length === 0) {
      const legacyChats = await this.loadManagedBotChatsForDiscovery(null, options);
      const candidateChats =
        entityType === 'all'
          ? legacyChats
          : legacyChats.filter((chat) => chat.entityType === entityType);
      const supportedChats = candidateChats.filter(
        (chat) => !isUnsupportedManagedChat(chat.chatId, chat.entityType),
      );
      this.scheduleManagedEntitiesDiscoveryHeaderPrime(supportedChats, `legacy:${entityType}`);
      this.scheduleManagedEntitiesCatalogSync(supportedChats, options.trafficClass);

      return supportedChats;
    }

    const discoveryResults = await Promise.all(
      discoveryBots.map(async (bot) => {
        try {
          return {
            botId: bot.id,
            chats: await this.loadManagedBotChatsForDiscovery(bot.id, options),
            error: null,
          };
        } catch (error: unknown) {
          return {
            botId: bot.id,
            chats: [],
            error,
          };
        }
      }),
    );
    const failedResults = discoveryResults.filter((result) => result.error !== null);
    if (failedResults.length > 0) {
      this.logger.warn(
        {
          entityType,
          failedBots: failedResults.length,
          discoveryBots: discoveryBots.length,
          errors: failedResults.map((result) => ({
            botId: result.botId,
            err: result.error instanceof Error ? result.error.message : String(result.error),
          })),
        },
        'Continuing managed entities discovery with partial bot results',
      );
    }
    if (failedResults.length === discoveryResults.length && failedResults[0]?.error) {
      throw failedResults[0].error;
    }

    const remoteChats = this.mergeManagedEntitiesDiscoverySnapshots(
      ...discoveryResults.map((result) => result.chats),
    );
    const candidateChats =
      entityType === 'all'
        ? remoteChats
        : remoteChats.filter((chat) => chat.entityType === entityType);
    const supportedChats = candidateChats.filter(
      (chat) => !isUnsupportedManagedChat(chat.chatId, chat.entityType),
    );
    this.scheduleManagedEntitiesDiscoveryHeaderPrime(supportedChats, `multi:${entityType}`);
    this.scheduleManagedEntitiesCatalogSync(supportedChats, options.trafficClass);
    return supportedChats;
  }

  private async loadManagedBotChatsForDiscovery(
    botId: string | null,
    options: {
      trafficClass: 'critical' | 'interactive' | 'background';
      bypassCache?: boolean;
      timeoutMs?: number;
    },
  ): Promise<ManagedEntitiesDiscoverySnapshot> {
    const normalizedBotId = this.normalizeRuntimeManagedEntityBotId(botId);
    try {
      const chats = await this.maxClient.listBotChats({
        trafficClass: options.trafficClass,
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        ...(options.bypassCache === true ? { bypassCache: true } : {}),
        ...(typeof options.timeoutMs === 'number' ? { timeoutMs: options.timeoutMs } : {}),
        ...(normalizedBotId ? { botId: normalizedBotId } : {}),
      });
      const normalizedChats = chats.map((chat) =>
        this.normalizeManagedBotChatDiscoverySnapshot(chat, normalizedBotId),
      );
      await this.replaceManagedBotChatCatalogSnapshot(normalizedChats, normalizedBotId).catch(
        (catalogError: unknown) => {
          this.logger.warn(
            {
              botId: normalizedBotId,
              candidateChats: normalizedChats.length,
              err: catalogError instanceof Error ? catalogError.message : String(catalogError),
            },
            'Failed to persist managed bot chat catalog snapshot',
          );
        },
      );
      const membershipChats = await this.loadManagedBotChatMembershipCatalogSnapshot(
        normalizedBotId,
      ).catch((membershipError: unknown) => {
        this.logger.warn(
          {
            botId: normalizedBotId,
            err:
              membershipError instanceof Error ? membershipError.message : String(membershipError),
          },
          'Failed to load managed bot chat membership discovery supplement',
        );
        return [];
      });
      return this.mergeManagedEntitiesDiscoverySnapshots(normalizedChats, membershipChats);
    } catch (error: unknown) {
      const fallbackChats = await this.loadManagedBotChatCatalogSnapshot(normalizedBotId).catch(
        (fallbackError: unknown) => {
          this.logger.warn(
            {
              botId: normalizedBotId,
              err: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            },
            'Failed to load managed bot chat catalog fallback',
          );
          return [];
        },
      );

      if (fallbackChats.length > 0) {
        this.logger.warn(
          {
            botId: normalizedBotId,
            fallbackChats: fallbackChats.length,
            err: error instanceof Error ? error.message : String(error),
          },
          'Using managed bot chat catalog fallback after MAX chat discovery failure',
        );
        return fallbackChats;
      }

      throw error;
    }
  }

  private normalizeManagedBotChatDiscoverySnapshot(
    chat: MaxBotChat,
    preferredBotId: string | null,
  ): MaxBotChat {
    const normalizedChatId = this.readTrimmedString(chat.chatId) ?? chat.chatId;
    const botIds = this.collectManagedBotChatCatalogBotIds(chat, preferredBotId);
    return {
      ...chat,
      chatId: normalizedChatId,
      botId:
        this.normalizeRuntimeManagedEntityBotId(chat.botId) ?? preferredBotId ?? botIds[0] ?? null,
      botIds,
    };
  }

  private async replaceManagedBotChatCatalogSnapshot(
    chats: readonly MaxBotChat[],
    pinnedBotId: string | null,
  ): Promise<void> {
    const catalog = this.prisma.managedBotChatCatalog;
    if (!catalog) {
      return;
    }

    const entriesByKey = new Map<
      string,
      {
        botId: string;
        chatId: string;
        entityType: ChatEntityType;
        title: string | null;
        link: string | null;
        avatarUrl: string | null;
        lastEventTime: string | null;
      }
    >();
    const seenChatIdsForPinnedBot = new Set<string>();

    for (const chat of chats) {
      const chatId = this.readTrimmedString(chat.chatId);
      if (!chatId) {
        continue;
      }
      const botIds = this.collectManagedBotChatCatalogBotIds(chat, pinnedBotId);
      if (pinnedBotId) {
        seenChatIdsForPinnedBot.add(chatId);
      }

      for (const botId of botIds) {
        entriesByKey.set(`${botId}\u0000${chatId}`, {
          botId,
          chatId,
          entityType: toPrismaEntityType(chat.entityType),
          title: this.readTrimmedString(chat.title),
          link: this.readTrimmedString(chat.link),
          avatarUrl: this.readTrimmedString(chat.avatarUrl),
          lastEventTime:
            typeof chat.lastEventTime === 'number' && Number.isFinite(chat.lastEventTime)
              ? String(Math.trunc(chat.lastEventTime))
              : null,
        });
      }
    }

    const entries = [...entriesByKey.values()];
    if (entries.length === 0) {
      return;
    }

    const now = new Date();
    await mapWithConcurrencyLimit(
      entries,
      MANAGED_BOT_CHAT_CATALOG_WRITE_CONCURRENCY,
      async (entry) => {
        const update: Prisma.ManagedBotChatCatalogUpdateInput = {
          entityType: entry.entityType,
          status: 'ACTIVE',
          source: 'max_chats',
          lastEventTime: entry.lastEventTime,
          lastSeenAt: now,
        };
        if (entry.title !== null) {
          update.title = entry.title;
        }
        if (entry.link !== null) {
          update.link = entry.link;
        }
        if (entry.avatarUrl !== null) {
          update.avatarUrl = entry.avatarUrl;
        }

        await catalog.upsert({
          where: {
            botId_chatId: {
              botId: entry.botId,
              chatId: entry.chatId,
            },
          },
          create: {
            botId: entry.botId,
            chatId: entry.chatId,
            entityType: entry.entityType,
            title: entry.title,
            link: entry.link,
            avatarUrl: entry.avatarUrl,
            lastEventTime: entry.lastEventTime,
            status: 'ACTIVE',
            source: 'max_chats',
            lastSeenAt: now,
          },
          update,
        });
        return null;
      },
    );

    if (
      pinnedBotId &&
      seenChatIdsForPinnedBot.size > 0 &&
      seenChatIdsForPinnedBot.size <= MANAGED_BOT_CHAT_CATALOG_MARK_MISSING_MAX_SEEN
    ) {
      await catalog.updateMany({
        where: {
          botId: pinnedBotId,
          status: 'ACTIVE',
          chatId: { notIn: [...seenChatIdsForPinnedBot] },
        },
        data: {
          status: 'MISSING',
        },
      });
    }
  }

  private async loadManagedBotChatCatalogSnapshot(
    botId: string | null,
  ): Promise<ManagedEntitiesDiscoverySnapshot> {
    const catalog = this.prisma.managedBotChatCatalog;
    if (!catalog) {
      return [];
    }

    const runtimeBotIds = [...this.managedEntitiesRuntimeBotIds];
    const where: Prisma.ManagedBotChatCatalogWhereInput = {
      status: 'ACTIVE',
      ...(botId ? { botId } : runtimeBotIds.length > 0 ? { botId: { in: runtimeBotIds } } : {}),
    };
    const rows = await catalog.findMany({
      where,
      orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
      take: MANAGED_BOT_CHAT_CATALOG_FALLBACK_LIMIT,
    });

    const catalogChats = this.mergeManagedBotChatCatalogRows(rows);
    const membershipChats = await this.loadManagedBotChatMembershipCatalogSnapshot(botId);
    return this.mergeManagedEntitiesDiscoverySnapshots(catalogChats, membershipChats);
  }

  private mergeManagedBotChatCatalogRows(
    rows: readonly ManagedBotChatCatalogSnapshotRow[],
  ): ManagedEntitiesDiscoverySnapshot {
    const byChatId = new Map<string, MaxBotChat>();
    for (const row of rows) {
      const chatId = this.readTrimmedString(row.chatId);
      const botId = this.normalizeRuntimeManagedEntityBotId(row.botId);
      if (!chatId || !botId) {
        continue;
      }

      const lastEventTimeNumber =
        row.lastEventTime !== null ? Number.parseInt(row.lastEventTime, 10) : Number.NaN;
      const existing = byChatId.get(chatId);
      if (existing) {
        existing.botIds = Array.from(new Set([...(existing.botIds ?? []), botId]));
        if (!existing.botId) {
          existing.botId = botId;
        }
        continue;
      }

      byChatId.set(chatId, {
        chatId,
        title: this.readTrimmedString(row.title),
        link: this.readTrimmedString(row.link),
        avatarUrl: this.readTrimmedString(row.avatarUrl),
        entityType: fromPrismaEntityType(row.entityType),
        lastEventTime: Number.isFinite(lastEventTimeNumber) ? lastEventTimeNumber : null,
        botId,
        botIds: [botId],
      });
    }

    return [...byChatId.values()];
  }

  private async loadManagedBotChatMembershipCatalogSnapshot(
    botId: string | null,
  ): Promise<ManagedEntitiesDiscoverySnapshot> {
    const memberships = this.prisma.chatBotMembership;
    if (!memberships) {
      return [];
    }

    const runtimeBotIds = [...this.managedEntitiesRuntimeBotIds];
    const where: Prisma.ChatBotMembershipWhereInput = {
      status: ChatBotMembershipStatus.ACTIVE,
      ...(botId ? { botId } : runtimeBotIds.length > 0 ? { botId: { in: runtimeBotIds } } : {}),
    };
    const rows = (await memberships.findMany({
      where,
      select: {
        botId: true,
        lastSeenAt: true,
        lastWebhookAt: true,
        chat: {
          select: {
            id: true,
            title: true,
            entityType: true,
            botId: true,
            primaryBotId: true,
          },
        },
      },
      orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
      take: MANAGED_BOT_CHAT_CATALOG_FALLBACK_LIMIT,
    })) as ManagedBotChatMembershipSnapshotRow[];

    return this.mergeManagedBotChatMembershipRows(rows);
  }

  private mergeManagedBotChatMembershipRows(
    rows: readonly ManagedBotChatMembershipSnapshotRow[],
  ): ManagedEntitiesDiscoverySnapshot {
    const byChatId = new Map<string, MaxBotChat>();
    for (const row of rows) {
      const chatId = this.readTrimmedString(row.chat.id);
      const botId = this.normalizeRuntimeManagedEntityBotId(row.botId);
      if (!chatId || !botId) {
        continue;
      }

      const botIds = Array.from(
        new Set(
          [botId, row.chat.primaryBotId, row.chat.botId]
            .map((candidate) => this.normalizeRuntimeManagedEntityBotId(candidate))
            .filter((candidate): candidate is string => Boolean(candidate)),
        ),
      );
      const lastEventTime = row.lastWebhookAt?.getTime() ?? row.lastSeenAt?.getTime() ?? null;
      const existing = byChatId.get(chatId);
      if (existing) {
        existing.botIds = Array.from(new Set([...(existing.botIds ?? []), ...botIds]));
        existing.lastEventTime = Math.max(existing.lastEventTime ?? 0, lastEventTime ?? 0);
        continue;
      }

      byChatId.set(chatId, {
        chatId,
        title: this.readTrimmedString(row.chat.title),
        link: null,
        avatarUrl: null,
        entityType: fromPrismaEntityType(row.chat.entityType),
        lastEventTime,
        botId,
        botIds,
      });
    }

    return [...byChatId.values()];
  }

  private collectManagedBotChatCatalogBotIds(
    chat: MaxBotChat,
    preferredBotId: string | null,
  ): string[] {
    return Array.from(
      new Set(
        [preferredBotId, chat.botId, ...(chat.botIds ?? [])]
          .map((candidate) => this.normalizeRuntimeManagedEntityBotId(candidate))
          .filter((candidate): candidate is string => Boolean(candidate)),
      ),
    );
  }

  private scheduleManagedEntitiesDiscoveryHeaderPrime(
    chats: readonly MaxBotChat[],
    scopeKey: string,
  ): void {
    if (chats.length === 0 || typeof this.chatContextCache.setManagedEntityHeader !== 'function') {
      return;
    }

    const candidates = chats.filter((chat) => {
      return (
        this.readTrimmedString(chat.chatId) !== null &&
        (this.readTrimmedString(chat.title) !== null ||
          this.readTrimmedString(chat.link) !== null ||
          this.readTrimmedString(chat.avatarUrl) !== null)
      );
    });
    if (candidates.length === 0) {
      return;
    }

    const now = Date.now();
    const cooldownUntilMs =
      this.managedEntitiesDiscoveryHeaderPrimeCooldownUntilMs.get(scopeKey) ?? 0;
    if (cooldownUntilMs > now || this.managedEntitiesDiscoveryHeaderPrimeRuns.has(scopeKey)) {
      return;
    }

    this.managedEntitiesDiscoveryHeaderPrimeCooldownUntilMs.set(
      scopeKey,
      now + MANAGED_ENTITIES_DISCOVERY_HEADER_PRIME_COOLDOWN_MS,
    );

    const snapshot = candidates.map((chat) => ({ ...chat }));
    const pending = this.runManagedEntitiesDiscoveryHeaderPrime(snapshot)
      .catch((error: unknown) => {
        this.logger.warn(
          {
            scopeKey,
            candidateChats: snapshot.length,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to prime managed entity headers from discovery snapshot',
        );
      })
      .finally(() => {
        if (this.managedEntitiesDiscoveryHeaderPrimeRuns.get(scopeKey) === pending) {
          this.managedEntitiesDiscoveryHeaderPrimeRuns.delete(scopeKey);
        }
      });

    this.managedEntitiesDiscoveryHeaderPrimeRuns.set(scopeKey, pending);
  }

  private async runManagedEntitiesDiscoveryHeaderPrime(
    chats: readonly MaxBotChat[],
  ): Promise<void> {
    await mapWithConcurrencyLimit(
      [...chats],
      MANAGED_ENTITIES_DISCOVERY_HEADER_PRIME_CONCURRENCY,
      async (chat) => {
        const chatId = this.readTrimmedString(chat.chatId);
        if (!chatId) {
          return null;
        }

        const existingHeader =
          (await this.chatContextCache.getManagedEntityHeader?.(chatId, chat.entityType)) ?? null;
        const title =
          resolvePresentableManagedEntityTitle(chatId, chat.title, existingHeader?.title) ??
          (chat.entityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`);
        const link =
          this.readTrimmedString(chat.link) ?? this.readTrimmedString(existingHeader?.link) ?? null;
        const avatarUrl =
          this.readTrimmedString(chat.avatarUrl) ??
          this.readTrimmedString(existingHeader?.avatarUrl);
        const primaryBotId =
          this.normalizeRuntimeManagedEntityBotId(chat.botId) ??
          this.normalizeRuntimeManagedEntityBotId(existingHeader?.primaryBotId);
        await this.chatContextCache.setManagedEntityHeader?.(
          this.createManagedEntityHeader({
            id: chatId,
            title,
            entityType: chat.entityType,
            link,
            participantsCount: existingHeader?.participantsCount ?? null,
            avatarUrl,
            primaryBotId,
            assignedBots: existingHeader?.assignedBots,
            sharedMode: existingHeader?.sharedMode,
          }),
        );

        return null;
      },
    );
  }

  private scheduleManagedEntitiesCatalogSync(
    chats: readonly MaxBotChat[],
    trafficClass: 'critical' | 'interactive' | 'background',
    options: {
      exhaustiveWindow?: boolean;
      scopeKey?: string;
    } = {},
  ): void {
    if (!this.maxChatAdminRosterSyncService || chats.length === 0) {
      return;
    }

    const syncWindowSize =
      trafficClass === 'background'
        ? MANAGED_ENTITIES_BACKGROUND_CATALOG_SYNC_WINDOW_SIZE
        : MANAGED_ENTITIES_DELTA_DISCOVERY_WINDOW_SIZE;
    const syncCandidates =
      options.exhaustiveWindow === true
        ? chats
        : this.selectManagedEntitiesCatalogSyncWindow(
            chats,
            syncWindowSize,
            options.scopeKey ?? trafficClass,
          );
    if (syncCandidates.length === 0) {
      return;
    }

    const snapshot = syncCandidates.map((chat) => ({
      ...chat,
      botIds: Array.from(new Set([...(chat.botIds ?? []), ...(chat.botId ? [chat.botId] : [])])),
    }));

    void this.maxChatAdminRosterSyncService
      .scheduleDiscoverySnapshotSync(snapshot)
      .catch((error) => {
        this.logger.warn(
          {
            candidateChats: snapshot.length,
            trafficClass,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to enqueue managed entities catalog sync after discovery snapshot',
        );
      });
  }

  private selectManagedEntitiesCatalogSyncWindow<T>(
    items: readonly T[],
    windowSize: number,
    scopeKey: string,
  ): T[] {
    if (items.length === 0) {
      return [];
    }

    const boundedWindowSize = Math.max(1, Math.min(items.length, Math.trunc(windowSize)));
    const cursorKey = `managed-entities-catalog:${scopeKey}:${items.length}`;
    const startIndex =
      (this.managedEntitiesCatalogSyncCursorByScope.get(cursorKey) ?? 0) % items.length;
    const selected: T[] = [];
    for (let offset = 0; offset < boundedWindowSize; offset += 1) {
      selected.push(items[(startIndex + offset) % items.length]);
    }

    this.managedEntitiesCatalogSyncCursorByScope.set(
      cursorKey,
      (startIndex + boundedWindowSize) % items.length,
    );
    return selected;
  }

  async getChannelStats(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ChannelStatsResponse> {
    await this.assertChatAdmin(chatId, user.userId, 'channel', {
      syncPersistedAccess: false,
    });
    await this.ensureEntityType(chatId, user.userId, 'channel');

    const parsed = channelStatsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const cacheKey = this.buildChannelStatsResponseCacheKey(chatId, user.userId, parsed.data);
    const cached = this.channelStatsResponseCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.promise;
    }

    const entry: TimedPromiseCacheEntry<ChannelStatsResponse> = {
      expiresAtMs: Date.now() + CHANNEL_STATS_RESPONSE_CACHE_TTL_MS,
      promise: Promise.resolve(null as never),
    };
    const pending = this.buildChannelStatsResponse(chatId, parsed.data)
      .then((response) => {
        entry.expiresAtMs =
          Date.now() +
          (response.meta.refreshQueued
            ? CHANNEL_STATS_REFRESHING_RESPONSE_CACHE_TTL_MS
            : CHANNEL_STATS_RESPONSE_CACHE_TTL_MS);
        return response;
      })
      .catch((error: unknown) => {
        const current = this.channelStatsResponseCache.get(cacheKey);
        if (current?.promise === pending) {
          this.channelStatsResponseCache.delete(cacheKey);
        }
        throw error;
      });
    entry.promise = pending;
    this.channelStatsResponseCache.set(cacheKey, entry);

    const startedAtMs = Date.now();
    const response = await pending;
    const totalMs = Date.now() - startedAtMs;
    if (totalMs >= SLOW_CHANNEL_STATS_THRESHOLD_MS) {
      this.logger.warn(
        {
          chatId,
          userId: user.userId,
          totalMs,
          range: parsed.data.range,
          includeActivityPreview: parsed.data.includeActivityPreview,
          includeIntelligence: parsed.data.includeIntelligence,
          cacheHit: false,
          refreshQueued: response.meta.refreshQueued,
        },
        'Slow channel stats request completed',
      );
    }

    return response;
  }

  private async buildChannelStatsResponse(
    chatId: string,
    statsQuery: ChannelStatsQuery,
  ): Promise<ChannelStatsResponse> {
    const now = new Date();
    const from = this.resolveChannelStatsFrom(statsQuery.range, now);
    const bucket = this.resolveChannelStatsBucket(statsQuery.range);
    const previousFrom = new Date(from.getTime() - (now.getTime() - from.getTime()));
    const previousTo = new Date(Math.max(previousFrom.getTime(), from.getTime() - 1));

    const [
      chat,
      header,
      secondaryRows,
      latestAudienceSnapshot,
      earliestAudienceSnapshot,
      previousAudienceSnapshot,
      audienceSnapshots,
      syncState,
      periodPosts,
      anyPost,
      membershipBucketRows,
      contentBucketRows,
      membershipRows,
    ] = await Promise.all([
      this.prisma.chat.findUnique({
        where: { id: chatId },
        select: { id: true, title: true },
      }),
      this.chatContextCache.getManagedEntityHeader?.(chatId, 'channel') ?? Promise.resolve(null),
      this.prisma.$queryRaw<
        Array<{
          posts_with_buttons: unknown;
          comments: unknown;
          suggestions: unknown;
          comment_authors: unknown;
          suggestion_authors: unknown;
          suggestions_delivered: unknown;
          suggestions_failed: unknown;
          last_bot_activity_at: Date | string | null;
        }>
      >`
        SELECT
          COUNT(DISTINCT CASE
            WHEN action IN (${Prisma.join(CHANNEL_STATS_POST_ACTIONS)})
            THEN NULLIF(BTRIM(payload->>'threadId'), '')
            ELSE NULL
          END) AS posts_with_buttons,
          COUNT(*) FILTER (WHERE action = ${CHANNEL_DIALOG_ACTION_COMMENT}) AS comments,
          COUNT(*) FILTER (WHERE action = ${CHANNEL_DIALOG_ACTION_SUGGEST}) AS suggestions,
          COUNT(DISTINCT CASE
            WHEN action = ${CHANNEL_DIALOG_ACTION_COMMENT}
            THEN actor_user_id
            ELSE NULL
          END) AS comment_authors,
          COUNT(DISTINCT CASE
            WHEN action = ${CHANNEL_DIALOG_ACTION_SUGGEST}
            THEN actor_user_id
            ELSE NULL
          END) AS suggestion_authors,
          COUNT(*) FILTER (
            WHERE action = ${CHANNEL_DIALOG_ACTION_SUGGEST}
              AND payload->>'delivered' = 'true'
          ) AS suggestions_delivered,
          COUNT(*) FILTER (
            WHERE action = ${CHANNEL_DIALOG_ACTION_SUGGEST}
              AND payload->>'delivered' = 'false'
          ) AS suggestions_failed,
          MAX(created_at) FILTER (
            WHERE action IN (${Prisma.join(CHANNEL_STATS_ACTIVITY_ACTIONS)})
          ) AS last_bot_activity_at
        FROM audit_logs
        WHERE chat_id = ${chatId}
          AND created_at >= ${from}
          AND created_at <= ${now}
      `,
      this.prisma.channelAudienceSnapshot.findFirst({
        where: { chatId },
        orderBy: { capturedAt: 'desc' },
      }),
      this.prisma.channelAudienceSnapshot.findFirst({
        where: { chatId },
        orderBy: { capturedAt: 'asc' },
        select: {
          capturedAt: true,
        },
      }),
      this.prisma.channelAudienceSnapshot.findFirst({
        where: {
          chatId,
          capturedAt: { lt: from },
        },
        orderBy: { capturedAt: 'desc' },
        select: {
          participantsCount: true,
        },
      }),
      this.prisma.channelAudienceSnapshot.findMany({
        where: {
          chatId,
          capturedAt: { gte: from, lte: now },
        },
        orderBy: { capturedAt: 'asc' },
        select: {
          capturedAt: true,
          participantsCount: true,
        },
      }),
      this.prisma.channelStatsSyncState.findUnique({
        where: { chatId },
      }),
      this.prisma.channelPost.findMany({
        where: {
          chatId,
          publishedAt: { gte: from, lte: now },
        },
        orderBy: { publishedAt: 'asc' },
        select: {
          id: true,
          messageId: true,
          publishedAt: true,
          url: true,
          latestViews: true,
          latestReactions: true,
          latestReactionsTotal: true,
          latestSnapshotAt: true,
        },
      }),
      this.prisma.channelPost.findFirst({
        where: { chatId },
        select: { id: true },
      }),
      selectChannelStatsMembershipBucketRows(this.prisma, { chatId, from, to: now, bucket }),
      selectChannelStatsContentBucketRows(this.prisma, { chatId, from, to: now, bucket }),
      statsQuery.includeIntelligence
        ? this.getMembershipEventRows(chatId, from, now, ['user_added', 'user_removed'], {
            order: 'asc',
          })
        : Promise.resolve([]),
    ]);

    const refreshQueued = this.shouldRefreshChannelStats(latestAudienceSnapshot, syncState)
      ? this.scheduleChannelStatsRefresh(chatId)
      : false;

    const viewSnapshots =
      periodPosts.length > 0
        ? await this.prisma.channelPostViewSnapshot.findMany({
            where: {
              channelPostId: {
                in: periodPosts.map((post) => post.id),
              },
              capturedAt: { gte: from, lte: now },
            },
            orderBy: [{ channelPostId: 'asc' }, { capturedAt: 'asc' }],
            select: {
              channelPostId: true,
              views: true,
              capturedAt: true,
            },
          })
        : [];

    const localTitle = chat?.title?.trim() || `Канал ${chatId}`;
    let maxSnapshotAvailable = latestAudienceSnapshot !== null;
    let title = localTitle;
    let participantsCount = latestAudienceSnapshot?.participantsCount ?? null;
    let status = latestAudienceSnapshot?.status ?? null;
    let isPublic = latestAudienceSnapshot?.isPublic ?? null;
    let link = latestAudienceSnapshot?.link ?? null;
    let lastEventAt = latestAudienceSnapshot?.lastEventAt?.toISOString() ?? null;
    let avatarUrl = header?.avatarUrl?.trim() || null;

    if (latestAudienceSnapshot) {
      title = chat?.title?.trim() || localTitle;
    } else {
      try {
        const snapshot = await this.maxClient.getChatSnapshot(chatId, {
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        });
        title = snapshot.title?.trim() || localTitle;
        participantsCount = snapshot.participantsCount;
        status = snapshot.status;
        isPublic = snapshot.isPublic;
        link = snapshot.link;
        lastEventAt = snapshot.lastEventAt;
        avatarUrl = snapshot.avatarUrl?.trim() || avatarUrl;
        maxSnapshotAvailable = true;
      } catch (error: unknown) {
        maxSnapshotAvailable = false;
        this.logger.warn(
          {
            chatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to fetch MAX fallback snapshot for channel stats',
        );
      }
    }

    const secondary = secondaryRows[0] ?? {
      posts_with_buttons: 0,
      comments: 0,
      suggestions: 0,
      comment_authors: 0,
      suggestion_authors: 0,
      suggestions_delivered: 0,
      suggestions_failed: 0,
      last_bot_activity_at: null,
    };

    const churnAvailable = Boolean(
      syncState?.membershipCoverageFrom &&
      syncState.membershipCoverageFrom.getTime() <= from.getTime(),
    );
    const bucketStarts = this.buildChannelStatsBucketStarts(from, now, bucket);
    const membershipSeries = this.buildMembershipSeriesFromBucketRows(
      bucketStarts,
      membershipBucketRows,
    );
    const joined = membershipSeries.reduce((total, item) => total + item.joined, 0);
    const left = membershipSeries.reduce((total, item) => total + item.left, 0);
    const contentSeries = this.buildContentSeriesFromBucketRows(bucketStarts, contentBucketRows);
    const contentTotals = this.buildContentTotals(contentSeries);
    const postViewMetrics = this.buildPostViewMetrics(periodPosts, viewSnapshots, from);
    const viewsMode = this.resolveChannelStatsViewsMode(contentTotals);
    const viewsSeries = this.buildViewsSeriesFromContentSeries(contentSeries, viewsMode);
    const periodViews = viewsSeries.reduce((total, item) => total + item.views, 0);
    const periodViewsTotal = contentTotals.viewsTotal;
    const topReactions = this.buildTopReactions(periodPosts);
    const topPosts = this.buildTopPosts(postViewMetrics);
    const participantSeries = this.buildParticipantSeries(
      bucketStarts,
      bucket,
      previousAudienceSnapshot?.participantsCount ?? participantsCount,
      audienceSnapshots,
    );
    const activityFeed = statsQuery.includeActivityPreview
      ? await this.getMembershipActivityFeedPage(
          chatId,
          from,
          now,
          {
            range: statsQuery.range,
            filter: 'all',
            limit: MEMBERSHIP_ACTIVITY_PAGE_LIMIT,
          },
          'channel',
        )
      : this.buildEmptyMembershipActivityPage();
    const previousPeriod = await this.buildPreviousChannelStatsPeriodSnapshot(
      chatId,
      previousFrom,
      previousTo,
      bucket,
    );
    const previousTotals = previousPeriod.totals;
    const currentTotals: ChannelStatsPeriodTotals = {
      joined,
      left,
      net: joined - left,
      posts: contentTotals.posts,
      views: periodViews,
      viewsTotal: periodViewsTotal,
      averageViewsPerPost:
        contentTotals.posts > 0 ? Math.round(periodViewsTotal / contentTotals.posts) : 0,
      reactions: contentTotals.reactions,
    };
    const comparison = this.buildChannelStatsComparison(
      currentTotals,
      previousTotals,
      {
        from: previousFrom,
        to: previousTo,
      },
      previousPeriod.series,
    );
    const health = this.buildChannelStatsHealth({
      totals: currentTotals,
      comparison,
      maxSnapshotAvailable,
      viewsAvailable: Boolean(anyPost),
      churnAvailable,
      suggestionsDelivered: this.toSafeInteger(secondary.suggestions_delivered),
      suggestionsFailed: this.toSafeInteger(secondary.suggestions_failed),
    });
    const signals = this.buildChannelStatsSignals({
      totals: currentTotals,
      comparison,
      topPosts,
      membershipSeries,
      viewsSeries,
      postViewMetrics,
      range: statsQuery.range,
      maxSnapshotAvailable,
      suggestionsDelivered: this.toSafeInteger(secondary.suggestions_delivered),
      suggestionsFailed: this.toSafeInteger(secondary.suggestions_failed),
    });
    const response: ChannelStatsResponse = {
      channel: {
        id: chatId,
        title,
        participantsCount,
        status,
        isPublic,
        link,
        lastEventAt,
        avatarUrl,
      },
      period: {
        range: statsQuery.range,
        from: from.toISOString(),
        to: now.toISOString(),
        bucket,
      },
      official: {
        audience: {
          joined,
          left,
          net: joined - left,
        },
        content: {
          posts: contentTotals.posts,
          views: periodViews,
          viewsTotal: periodViewsTotal,
          viewsMode,
          reactions: contentTotals.reactions,
          topReactions,
          topPosts,
          lastPublishedAt:
            periodPosts.length > 0
              ? periodPosts[periodPosts.length - 1].publishedAt.toISOString()
              : null,
        },
        series: {
          participants: participantSeries,
          membership: membershipSeries,
          views: viewsSeries,
        },
      },
      secondary: {
        postsWithButtons: this.toSafeInteger(secondary.posts_with_buttons),
        comments: this.toSafeInteger(secondary.comments),
        suggestions: this.toSafeInteger(secondary.suggestions),
        commentAuthors: this.toSafeInteger(secondary.comment_authors),
        suggestionAuthors: this.toSafeInteger(secondary.suggestion_authors),
        suggestionsDelivered: this.toSafeInteger(secondary.suggestions_delivered),
        suggestionsFailed: this.toSafeInteger(secondary.suggestions_failed),
        lastBotActivityAt: this.toIsoString(secondary.last_bot_activity_at),
      },
      meta: {
        maxSnapshotAvailable,
        viewsAvailable: Boolean(anyPost),
        churnAvailable,
        officialCoverageFrom: this.resolveOfficialCoverageFrom(
          syncState,
          earliestAudienceSnapshot?.capturedAt ?? null,
        ),
        missingOfficialMetrics: [...CHANNEL_STATS_MISSING_METRICS],
        refreshQueued,
      },
      comparison,
      health,
      signals,
      activityFeed,
    };
    if (statsQuery.includeIntelligence) {
      response.intelligence = buildChannelStatsIntelligence({
        totals: currentTotals,
        previousTotals,
        comparison,
        signals,
        membershipRows,
        participantSeries,
        postViewMetrics,
        secondary: {
          commentAuthors: this.toSafeInteger(secondary.comment_authors),
          suggestionAuthors: this.toSafeInteger(secondary.suggestion_authors),
          comments: this.toSafeInteger(secondary.comments),
          suggestions: this.toSafeInteger(secondary.suggestions),
          postsWithButtons: this.toSafeInteger(secondary.posts_with_buttons),
        },
        maxSnapshotAvailable,
        range: statsQuery.range,
      });
    }

    return channelStatsResponseSchema.parse(response);
  }

  private buildChannelStatsResponseCacheKey(
    chatId: string,
    userId: string,
    query: ChannelStatsQuery,
  ): string {
    return [
      chatId,
      userId,
      query.range,
      `activity=${query.includeActivityPreview ? 1 : 0}`,
      `intelligence=${query.includeIntelligence ? 1 : 0}`,
    ].join(':');
  }

  private shouldRefreshChannelStats(
    latestAudienceSnapshot: { capturedAt: Date } | null,
    syncState: { lastAudienceSyncAt: Date | null; lastViewsSyncAt: Date | null } | null,
  ): boolean {
    const nowMs = Date.now();
    const audienceStale =
      !latestAudienceSnapshot ||
      nowMs - latestAudienceSnapshot.capturedAt.getTime() > CHANNEL_STATS_REFRESH_STALE_MS ||
      !syncState?.lastAudienceSyncAt ||
      nowMs - syncState.lastAudienceSyncAt.getTime() > CHANNEL_STATS_REFRESH_STALE_MS;
    const viewsStale =
      !syncState?.lastViewsSyncAt ||
      nowMs - syncState.lastViewsSyncAt.getTime() > CHANNEL_STATS_REFRESH_STALE_MS;

    return audienceStale || viewsStale;
  }

  private scheduleChannelStatsRefresh(chatId: string): boolean {
    const collector = this.channelStatsCollector;
    if (!collector) {
      return false;
    }

    const existing = this.channelStatsRefreshRuns.get(chatId);
    if (existing) {
      return true;
    }

    const pending = Promise.resolve()
      .then(() =>
        collector.syncChannelIfStale(chatId, {
          staleMs: CHANNEL_STATS_REFRESH_STALE_MS,
          reason: 'stats_endpoint',
        }),
      )
      .catch((error: unknown) => {
        this.logger.warn(
          {
            chatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to refresh channel stats in background',
        );
      })
      .finally(() => {
        this.channelStatsRefreshRuns.delete(chatId);
        this.invalidateChannelStatsResponseCache(chatId);
      });
    this.channelStatsRefreshRuns.set(chatId, pending);
    return true;
  }

  async getChannelActivityFeed(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<MembershipActivityPage> {
    await this.assertChatAdmin(chatId, user.userId, 'channel', {
      syncPersistedAccess: false,
    });
    await this.ensureEntityType(chatId, user.userId, 'channel');

    const parsed = membershipActivityQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const now = new Date();
    const from = this.resolveChannelStatsFrom(parsed.data.range, now);
    return this.getCachedMembershipActivityFeedPage(
      chatId,
      user.userId,
      from,
      now,
      parsed.data,
      'channel',
    );
  }

  async getSettings(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChatSettings> {
    await this.assertManagedEntityReadAccess(chatId, user.userId, 'chat', options);
    return readChatSettingsValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      logger: this.logger,
      chatId,
      botAssignmentData: await this.resolveChatSettingsReadBotAssignmentData(chatId),
    });
  }

  async getChatSettingsScreen(
    chatId: string,
    user: AuthUser,
    options: { liveAdminCheck?: boolean } = {},
  ): Promise<ChatSettingsScreenResponse> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'chat', {
      forceRemote: options.liveAdminCheck !== false,
      timeoutMs:
        options.liveAdminCheck === false ? undefined : SETTINGS_SCREEN_ADMIN_CHECK_TIMEOUT_MS,
    });
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const [settings, rules, header, domains, managedBroadcasts] = await Promise.all([
      this.getSettings(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
      this.getRules(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
      this.getChatHeader(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
      this.getDomainAllowlistDetails(chatId, user, { skipAdminCheck: true }),
      this.listManagedBroadcasts(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
    ]);
    const requiredSubscriptionChannels = await this.resolveRequiredSubscriptionChannelHeaders(
      settings.requiredSubscriptionChannelIds,
    );

    return chatSettingsScreenResponseSchema.parse({
      settings,
      rules,
      header,
      requiredSubscriptionChannels,
      domains,
      managedBroadcasts,
    });
  }

  async resolveRequiredSubscriptionChannel(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ResolveRequiredSubscriptionChannelResponse> {
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const parsed = resolveRequiredSubscriptionChannelRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const channel = await this.resolveRequiredSubscriptionChannelReference(parsed.data.value);
    return resolveRequiredSubscriptionChannelResponseSchema.parse({ channel });
  }

  async resolveRequiredSubscriptionChannelReferenceValue(
    value: string,
  ): Promise<ManagedEntityHeader> {
    return this.resolveRequiredSubscriptionChannelReference(value);
  }

  async updateSettings(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChatSettings> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return saveChatSettingsValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      chatId,
      actorUserId: user.userId,
      body,
      source,
      resolveBotAssignmentData: () => this.resolveChatSettingsWriteBotAssignmentData(chatId),
      assertRequiredSubscriptionSettings: (settings) =>
        this.assertRequiredSubscriptionSettings(settings),
      refreshExecutionReadiness: (settings) =>
        this.refreshExecutionReadinessAfterChatSettingsUpdate(chatId, settings),
    });
  }

  async getRules(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChatRules> {
    await this.assertManagedEntityReadAccess(chatId, user.userId, 'chat', options);

    const rules = await this.upsertChatRules(chatId);
    const hydratedRules = await this.hydratePublishedRulesUrl(chatId, rules);
    return this.mapChatRules(hydratedRules);
  }

  async updateRules(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChatRules> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return saveChatRulesDraft({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      chatId,
      actorUserId: user.userId,
      body,
      source,
    });
  }

  async adoptChatRulesFromMessage(
    chatId: string,
    user: AuthUser,
    input: AdoptChatRulesFromMessageInput,
    source: AdminActionSource = 'group_command',
  ): Promise<ChatRules> {
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const currentRules = await this.upsertChatRules(chatId);
    const sourceMessageId = this.readTrimmedString(input.sourceMessageId);
    let sourceMessageUrl = this.normalizePublishedRulesUrl(input.sourceMessageUrl);
    if (!sourceMessageId && !sourceMessageUrl) {
      throw new BadRequestException('Не удалось определить сообщение с правилами.');
    }

    if (!sourceMessageUrl && sourceMessageId) {
      try {
        sourceMessageUrl = this.normalizePublishedRulesUrl(
          await this.maxClient.resolveMessageLink(sourceMessageId),
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            actorUserId: user.userId,
            messageId: sourceMessageId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to resolve chat rules message link from forwarded command',
        );
      }
    }

    let normalizedSourceText = this.normalizeImportedRulesText(input.text);
    const maxClientWithMessageMarkdown = this.maxClient as MaxClientService & {
      getMessageTextAsMarkdown?: MaxClientService['getMessageTextAsMarkdown'];
    };
    if (
      sourceMessageId &&
      typeof maxClientWithMessageMarkdown.getMessageTextAsMarkdown === 'function'
    ) {
      try {
        const formattedSourceText =
          await maxClientWithMessageMarkdown.getMessageTextAsMarkdown(sourceMessageId);
        const normalizedFormattedSourceText = this.normalizeImportedRulesText(formattedSourceText);
        if (normalizedFormattedSourceText) {
          normalizedSourceText = normalizedFormattedSourceText;
        }
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            actorUserId: user.userId,
            messageId: sourceMessageId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to recover formatted chat rules text from source message',
        );
      }
    }

    const publishedAt = new Date();
    const updatedRules = await this.prisma.chatRules.update({
      where: { chatId },
      data: {
        ...(normalizedSourceText !== null
          ? {
              text: normalizedSourceText,
              autoTextEnabled: false,
            }
          : {}),
        publishedMessageId: sourceMessageId ?? null,
        publishedUrl: sourceMessageUrl,
        publishedAt,
      },
    });

    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);
    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Chat ${chatId}`,
        entityType: ChatEntityType.CHAT,
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        settings: {
          create: {
            rulesAttachViolationsEnabled: true,
          },
        },
      },
      update: {
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        settings: {
          upsert: {
            update: {
              rulesAttachViolationsEnabled: true,
            },
            create: {
              rulesAttachViolationsEnabled: true,
            },
          },
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'ADOPT_CHAT_RULES_MESSAGE',
        payload: {
          previousPublishedMessageId: currentRules.publishedMessageId ?? null,
          previousPublishedUrl: currentRules.publishedUrl ?? null,
          messageId: sourceMessageId ?? null,
          url: sourceMessageUrl,
          copiedText: normalizedSourceText !== null,
          textLength: normalizedSourceText?.length ?? 0,
          rulesAttachViolationsEnabled: true,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return this.mapChatRules(updatedRules);
  }

  async publishRules(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<PublishChatRulesResult> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return publishChatRules({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      logger: this.logger,
      chatId,
      actorUserId: user.userId,
      source,
      resolveBotId: () => this.resolveChatRulesActionBotId(chatId),
      buildAutofilledText: () => this.buildAutofilledChatRulesTextFromCurrentSettings(chatId, user),
      buildFormattedText: (sourceText, options) =>
        this.buildFormattedChatRulesPublicationText(chatId, sourceText, options),
      sendPrivateConfirmation: (publishedUrl) =>
        this.sendPublishedChatRulesPrivateConfirmation(user, publishedUrl),
    });
  }

  async resetPublishedRules(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChatRules> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return resetPublishedChatRules({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      chatId,
      actorUserId: user.userId,
      source,
      resolveBotId: () => this.resolveChatRulesActionBotId(chatId),
    });
  }

  async getChatPoll(chatId: string, user: AuthUser): Promise<ManagedPoll> {
    await this.assertManagedEntityReadAccess(chatId, user.userId, 'chat');
    return readManagedPollValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      logger: this.logger,
      chatId,
      resolveReadBotId: () => this.resolveManagedPollReadBotId(chatId),
    });
  }

  async updateChatPoll(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return saveManagedPollDraftValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      chatId,
      actorUserId: user.userId,
      entityType: 'chat',
      body,
      source,
    });
  }

  async publishChatPoll(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return publishManagedPollValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      chatId,
      actorUserId: user.userId,
      entityType: 'chat',
      source,
      resolveBotId: () => this.resolveManagedPollActionBotId(chatId),
    });
  }

  async closeChatPoll(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return closeManagedPollValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      chatId,
      actorUserId: user.userId,
      entityType: 'chat',
      source,
      resolveBotId: () => this.resolveManagedPollActionBotId(chatId),
    });
  }

  async getChannelPoll(chatId: string, user: AuthUser): Promise<ManagedPoll> {
    await this.assertManagedEntityReadAccess(chatId, user.userId, 'channel');
    return readManagedPollValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      logger: this.logger,
      chatId,
      resolveReadBotId: () => this.resolveManagedPollReadBotId(chatId),
    });
  }

  async updateChannelPoll(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    return saveManagedPollDraftValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      chatId,
      actorUserId: user.userId,
      entityType: 'channel',
      body,
      source,
    });
  }

  async publishChannelPoll(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    return publishManagedPollValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      chatId,
      actorUserId: user.userId,
      entityType: 'channel',
      source,
      resolveBotId: () => this.resolveManagedPollActionBotId(chatId),
    });
  }

  async closeChannelPoll(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    return closeManagedPollValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      chatId,
      actorUserId: user.userId,
      entityType: 'channel',
      source,
      resolveBotId: () => this.resolveManagedPollActionBotId(chatId),
    });
  }

  async getChannelSettings(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChannelSettings> {
    await this.assertManagedEntityReadAccess(chatId, user.userId, 'channel', options);
    const botAssignmentData = await this.resolveChannelSettingsReadBotAssignmentData(chatId);
    return readChannelSettingsValue({
      prisma: this.prisma,
      logger: this.logger,
      chatId,
      botAssignmentData,
    });
  }

  async getChannelSettingsScreen(
    chatId: string,
    user: AuthUser,
    options: { liveAdminCheck?: boolean } = {},
  ): Promise<ChannelSettingsScreenResponse> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'channel', {
      forceRemote: options.liveAdminCheck !== false,
      timeoutMs:
        options.liveAdminCheck === false ? undefined : SETTINGS_SCREEN_ADMIN_CHECK_TIMEOUT_MS,
    });
    await this.ensureEntityType(chatId, user.userId, 'channel');

    const [settings, header, managedBroadcasts] = await Promise.all([
      this.getChannelSettings(chatId, user, {
        skipAdminCheck: true,
        skipEntityCheck: true,
      }),
      this.getChannelHeader(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
      this.listChannelManagedBroadcasts(chatId, user, {
        skipAdminCheck: true,
        skipEntityCheck: true,
      }),
    ]);

    return channelSettingsScreenResponseSchema.parse({
      settings,
      header,
      managedBroadcasts,
    });
  }

  async updateChannelSettings(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChannelSettings> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    return saveChannelSettingsValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      chatId,
      actorUserId: user.userId,
      body,
      source,
      resolveBotAssignmentData: () => this.resolveChannelSettingsWriteBotAssignmentData(chatId),
      refreshExecutionReadiness: () => this.refreshChannelSettingsExecutionReadiness(chatId),
    });
  }

  async publishChannelEngagementMessage(chatId: string, user: AuthUser, body: unknown) {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    return publishChannelEngagementMessageValue({
      prisma: this.prisma,
      maxClient: this.maxClient,
      chatId,
      actorUserId: user.userId,
      body,
      resolveBotId: () => this.resolveChannelEngagementActionBotId(chatId),
      buildDialogArtifacts: (params) => this.buildChannelEngagementDialogArtifacts(params),
    });
  }

  async getChannelDialog(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    token: string | null,
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const threadId = this.dialogLinkHelper.resolveChannelDialogThreadId(chatId, dialogType, token);
    const action =
      dialogType === 'comments' ? CHANNEL_DIALOG_ACTION_COMMENT : CHANNEL_DIALOG_ACTION_SUGGEST;
    const [channelSettings, rows, adminUserIds, notificationSettings] = await Promise.all([
      this.getPublicChannelSettings(chatId),
      this.prisma.auditLog.findMany({
        where: {
          chatId,
          action,
          ...(threadId
            ? {
                payload: {
                  path: ['threadId'],
                  equals: threadId,
                },
              }
            : {}),
          ...(dialogType === 'suggest' ? { actorUserId: user.userId } : {}),
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: CHANNEL_DIALOG_MESSAGES_LIMIT,
      }),
      dialogType === 'comments'
        ? this.readPersistedDialogAdminUserIds(chatId, 'channel')
        : Promise.resolve(new Set<string>()),
      dialogType === 'comments'
        ? this.readEntityDialogNotificationSettings({
            entityType: 'channel',
            chatId,
            threadId,
            userId: user.userId,
          })
        : Promise.resolve(this.defaultDialogNotificationSettings()),
    ]);

    const messages = rows
      .slice()
      .reverse()
      .map((row) => this.mapChannelDialogAuditLog(row, dialogType, user.userId, adminUserIds));

    return channelDialogResponseSchema.parse({
      chatId,
      type: dialogType,
      introText: this.resolveChannelDialogIntroText(channelSettings, dialogType),
      messages,
      notificationSettings,
    });
  }

  async getChannelSuggestionRedirect(chatId: string, token: string | null) {
    return getChannelSuggestionRedirectValue({
      chatId,
      token,
      dialogLinkHelper: this.dialogLinkHelper,
      loadChannelSettings: (channelId) => this.getPublicChannelSettings(channelId),
    });
  }

  async createChannelDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    return this.createChannelDialogMessageInternal(
      chatId,
      user,
      dialogType,
      body,
      'miniapp_dialog',
    );
  }

  async createChannelSuggestionFromBot(chatId: string, user: AuthUser, body: unknown) {
    const parsed = this.parseChannelSuggestionFromBotPayload(body);
    const threadId = this.dialogLinkHelper.resolveChannelDialogThreadId(
      chatId,
      'suggest',
      parsed.token,
    );
    const channelSettings = await this.getPublicChannelSettings(chatId);

    if (!channelSettings.postSuggestionsEnabled && !threadId) {
      throw new BadRequestException('Предложить пост для этого канала сейчас нельзя.');
    }

    await this.assertChannelSuggestionDailyLimit(chatId, user.userId, channelSettings);

    const created = await this.createChannelSuggestionAuditLog({
      chatId,
      user,
      threadId,
      source: 'private_bot',
      text: parsed.text,
      textFormat: parsed.textFormat,
      textMarkup: parsed.textMarkup,
      images: parsed.images,
      imageBase64: parsed.imageBase64,
      imageMimeType: parsed.imageMimeType,
      imageFileName: parsed.imageFileName,
      mediaType: parsed.mediaType,
      mediaPayload: parsed.mediaPayload,
      mediaMimeType: parsed.mediaMimeType,
      mediaFileName: parsed.mediaFileName,
    });

    return {
      ok: true,
      delivered: created.delivered,
      deliveredToUserId: created.deliveredToUserId,
      queued: created.queued,
    } as const;
  }

  async getPublicChannelSuggestionIntroText(chatId: string): Promise<string | null> {
    const channelSettings = await this.getPublicChannelSettings(chatId);
    return this.resolveChannelDialogIntroText(channelSettings, 'suggest');
  }

  getPublicChannelSettingsForDialog(chatId: string): Promise<ChannelSettings> {
    return this.getPublicChannelSettings(chatId);
  }

  getPublicChatCommentSettingsForDialog(
    chatId: string,
  ): Promise<Pick<ChatSettings, 'commentsEnabled'>> {
    return this.getPublicChatCommentSettings(chatId);
  }

  toggleEntityDialogReactionForDialog(params: {
    chatId: string;
    entityType: ManagedEntityType;
    userId: string;
    dialogType: ChannelDialogType;
    messageId: string;
    token: string;
    emoji: string;
  }): Promise<ToggleChannelDialogReactionResponse> {
    return this.toggleEntityDialogReaction(params);
  }

  async getPublicChannelSuggestionTarget(
    chatId: string,
  ): Promise<{ title: string; link: string | null }> {
    await this.getPublicChannelSettings(chatId);

    const persistedChat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        title: true,
      },
    });

    try {
      const snapshot = await this.maxClient.getChatSnapshot(chatId, {
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      });
      return {
        title: snapshot.title?.trim() || persistedChat?.title?.trim() || chatId,
        link: this.readTrimmedString(snapshot.link),
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve public channel suggestion target',
      );
      return {
        title: persistedChat?.title?.trim() || chatId,
        link: null,
      };
    }
  }

  async reviewChannelSuggestionByAdmin(
    suggestionId: string,
    user: AuthUser,
    action: ChannelSuggestionReviewAction,
  ): Promise<{
    status: 'reviewed' | 'already_reviewed';
    reviewStatus: 'published' | 'cancelled';
    publishedUrl: string | null;
  }> {
    const normalizedSuggestionId = suggestionId.trim();
    if (!normalizedSuggestionId) {
      throw new BadRequestException('Предложка не найдена.');
    }

    const row = await this.prisma.auditLog.findFirst({
      where: {
        id: normalizedSuggestionId,
        action: CHANNEL_DIALOG_ACTION_SUGGEST,
      },
      select: {
        id: true,
        chatId: true,
        actorUserId: true,
        payload: true,
      },
    });

    if (!row) {
      throw new BadRequestException('Предложка не найдена.');
    }

    await this.assertChatAdmin(row.chatId, user.userId, 'channel');
    await this.ensureEntityType(row.chatId, user.userId, 'channel');

    const payload = this.readObjectPayload(row.payload);
    if (this.readLowerString(payload.type) !== 'suggest') {
      throw new BadRequestException('Предложка не найдена.');
    }
    const currentReviewStatus = this.readLowerString(payload.reviewStatus);
    if (currentReviewStatus === 'published' || currentReviewStatus === 'cancelled') {
      return {
        status: 'already_reviewed',
        reviewStatus: currentReviewStatus,
        publishedUrl: this.readTrimmedString(payload.publishedUrl),
      };
    }

    const published =
      action === 'publish'
        ? await this.publishStoredChannelSuggestion(row.chatId, payload)
        : {
            messageId: null,
            url: null,
            threadId: null,
            includeCommentsButton: false,
            includeSuggestButton: false,
            suggestButtonText: null,
            autoPostButtonsMode: 'OFF' as ChannelSettings['autoPostButtonsMode'],
            suggestionEntryMode: 'BOT' as ChannelSettings['postSuggestionsEntryMode'],
          };
    const reviewerLabel = user.displayName?.trim() || user.username?.trim() || user.userId;
    const reviewStatus = action === 'publish' ? 'published' : 'cancelled';
    const updatedPayload = {
      ...payload,
      reviewStatus,
      reviewedAt: new Date().toISOString(),
      reviewedByUserId: user.userId,
      reviewedByDisplayName: reviewerLabel,
      publishedMessageId: published.messageId,
      publishedUrl: published.url,
    } as Prisma.InputJsonValue;

    await this.prisma.auditLog.update({
      where: {
        id: row.id,
      },
      data: {
        payload: updatedPayload,
      },
    });

    if (
      action === 'publish' &&
      published.messageId &&
      published.threadId &&
      (published.includeCommentsButton || published.includeSuggestButton)
    ) {
      await this.prisma.auditLog.create({
        data: {
          chatId: row.chatId,
          actorUserId: user.userId,
          action: CHANNEL_DIALOG_ACTION_AUTO_ATTACH,
          payload: {
            messageId: published.messageId,
            threadId: published.threadId,
            includeCommentsButton: published.includeCommentsButton,
            includeSuggestButton: published.includeSuggestButton,
            autoPostButtonsMode: published.autoPostButtonsMode,
            suggestionEntryMode: published.suggestionEntryMode,
            source: 'suggestion_review',
            ...(published.url ? { publishedUrl: published.url } : {}),
            ...(published.botId ? { botId: published.botId } : {}),
            ...(published.suggestButtonText
              ? { suggestButtonText: published.suggestButtonText }
              : {}),
          },
        },
      });
    }

    await this.syncChannelSuggestionAdminReviewMessages(
      row.chatId,
      updatedPayload as Record<string, unknown>,
    );

    return {
      status: 'reviewed',
      reviewStatus,
      publishedUrl: published.url,
    };
  }

  parseChannelSuggestionStartPayload(
    startPayload: string | null,
  ): { chatId: string; token: string } | null {
    const compactPayload =
      this.dialogLinkHelper.parseCompactChannelSuggestionStartPayload(startPayload);
    if (compactPayload) {
      return compactPayload;
    }

    if (!startPayload || !startPayload.startsWith(CHANNEL_DIALOG_START_PARAM_PREFIX)) {
      return null;
    }

    const encodedPayload = startPayload.slice(CHANNEL_DIALOG_START_PARAM_PREFIX.length);
    if (!encodedPayload) {
      return null;
    }

    try {
      const parsed = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as Partial<{
        v: number;
        k: string;
        c: string;
        m: string;
        t: string;
      }>;
      const chatId = typeof parsed.c === 'string' ? parsed.c.trim() : '';
      const token = typeof parsed.t === 'string' ? parsed.t.trim() : '';

      if (
        parsed.v !== 1 ||
        parsed.k !== 'channel-dialog' ||
        parsed.m !== 'suggest' ||
        !chatId ||
        !token
      ) {
        return null;
      }

      return {
        chatId,
        token,
      };
    } catch {
      return null;
    }
  }

  private async createChannelDialogMessageInternal(
    chatId: string,
    user: AuthUser,
    dialogType: ChannelDialogType,
    body: unknown,
    source: ChannelDialogMessageSource,
  ) {
    const parsed = createChannelDialogMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const threadId = this.dialogLinkHelper.resolveChannelDialogThreadId(
      chatId,
      dialogType,
      parsed.data.token,
    );
    const text = parsed.data.text.trim();
    const normalizedAttachments = this.normalizeChannelDialogCommentInputAttachments(
      parsed.data.attachments,
    );
    const parsedImages = parsed.data.images.map((image) => ({
      base64: image.base64?.trim() ?? '',
      mimeType: image.mimeType?.trim() ?? '',
      fileName: image.fileName?.trim() ?? '',
    }));
    const attachmentImages = normalizedAttachments
      .filter((attachment) => attachment.kind === 'image')
      .map((image) => ({
        base64: image.base64?.trim() ?? '',
        mimeType: image.mimeType?.trim() ?? '',
        fileName: image.fileName?.trim() ?? '',
      }));
    const images =
      dialogType === 'suggest' && parsedImages.length > 0 ? parsedImages : attachmentImages;
    const fileAttachments = normalizedAttachments.filter(
      (attachment) => attachment.kind === 'file',
    );
    const authorDisplayName = user.displayName?.trim() ? user.displayName.trim() : user.username;
    const authorAvatarUrl = this.readTrimmedString(user.avatarUrl);
    const replyTo = await this.resolveDialogReplyPreview({
      chatId,
      entityType: 'channel',
      dialogType,
      threadId,
      replyToMessageId: parsed.data.replyToMessageId ?? null,
    });
    const channelSettings = await this.getPublicChannelSettings(chatId);

    if (dialogType === 'comments' && !channelSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого канала сейчас закрыты.');
    }

    if (dialogType === 'comments' && !text && normalizedAttachments.length === 0) {
      throw new BadRequestException('Введите текст комментария или добавьте вложение.');
    }

    if (dialogType === 'suggest' && !channelSettings.postSuggestionsEnabled && !threadId) {
      throw new BadRequestException('Предложить пост для этого канала сейчас нельзя.');
    }

    if (dialogType === 'suggest' && fileAttachments.length > 0) {
      throw new BadRequestException('В предложке пока поддерживаются только фото.');
    }

    if (dialogType === 'suggest' && !text && images.length === 0) {
      throw new BadRequestException('Введите текст или добавьте фото.');
    }

    if (dialogType === 'suggest') {
      await this.assertChannelSuggestionDailyLimit(chatId, user.userId, channelSettings);
    }

    if (dialogType === 'comments' && channelSettings.commentsModerationEnabled) {
      await this.assertChannelCommentAllowed({
        chatId,
        threadId,
        authorUserId: user.userId,
        text,
        settings: channelSettings,
      });
    }

    if (dialogType === 'suggest') {
      const created = await this.createChannelSuggestionAuditLog({
        chatId,
        user,
        threadId,
        source,
        text,
        textFormat: parsed.data.textFormat,
        images,
      });
      return createChannelDialogMessageResponseSchema.parse({
        ok: true,
        message: this.mapChannelDialogAuditLog(created.row, 'suggest', user.userId),
      });
    }
    return this.createEntityCommentDialogMessageInternal({
      entityType: 'channel',
      chatId,
      user,
      dialogType,
      threadId,
      text,
      normalizedAttachments,
      replyTo,
      source,
      authorDisplayName,
      authorAvatarUrl,
    });
  }

  async getChatDialog(chatId: string, user: AuthUser, dialogTypeRaw: string, token: string | null) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    if (dialogType !== 'comments') {
      throw new BadRequestException('Для чатов доступен только сценарий комментариев.');
    }

    const threadId = this.dialogLinkHelper.resolveChatDialogThreadId(chatId, dialogType, token);
    const [chatSettings, rows, adminUserIds, notificationSettings] = await Promise.all([
      this.getPublicChatCommentSettings(chatId),
      this.prisma.auditLog.findMany({
        where: {
          chatId,
          action: CHANNEL_DIALOG_ACTION_COMMENT,
          ...(threadId
            ? {
                payload: {
                  path: ['threadId'],
                  equals: threadId,
                },
              }
            : {}),
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: CHANNEL_DIALOG_MESSAGES_LIMIT,
      }),
      this.readPersistedDialogAdminUserIds(chatId, 'chat'),
      this.readEntityDialogNotificationSettings({
        entityType: 'chat',
        chatId,
        threadId,
        userId: user.userId,
      }),
    ]);

    if (!chatSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого чата сейчас закрыты.');
    }

    const messages = rows
      .slice()
      .reverse()
      .map((row) => this.mapChannelDialogAuditLog(row, dialogType, user.userId, adminUserIds));

    return channelDialogResponseSchema.parse({
      chatId,
      type: dialogType,
      introText: null,
      messages,
      notificationSettings,
    });
  }

  async createChatDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
  ) {
    return this.createChatDialogMessageInternal(
      chatId,
      user,
      dialogTypeRaw,
      body,
      'miniapp_dialog',
    );
  }

  async updateChannelDialogNotifications(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const channelSettings = await this.getPublicChannelSettings(chatId);
    if (dialogType !== 'comments') {
      throw new BadRequestException('Уведомления доступны только в комментариях.');
    }
    if (!channelSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого канала сейчас закрыты.');
    }

    return this.updateEntityDialogNotifications({
      entityType: 'channel',
      chatId,
      userId: user.userId,
      dialogType,
      body,
    });
  }

  async updateChatDialogNotifications(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const chatSettings = await this.getPublicChatCommentSettings(chatId);
    if (dialogType !== 'comments') {
      throw new BadRequestException('Для чатов доступен только сценарий комментариев.');
    }
    if (!chatSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого чата сейчас закрыты.');
    }

    return this.updateEntityDialogNotifications({
      entityType: 'chat',
      chatId,
      userId: user.userId,
      dialogType,
      body,
    });
  }

  private async createChatDialogMessageInternal(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
    source: ChannelDialogMessageSource,
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    if (dialogType !== 'comments') {
      throw new BadRequestException('Для чатов доступен только сценарий комментариев.');
    }

    const parsed = createChannelDialogMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const threadId = this.dialogLinkHelper.resolveChatDialogThreadId(
      chatId,
      dialogType,
      parsed.data.token,
    );
    const text = parsed.data.text.trim();
    const normalizedAttachments = this.normalizeChannelDialogCommentInputAttachments(
      parsed.data.attachments,
    );
    const authorDisplayName = user.displayName?.trim() ? user.displayName.trim() : user.username;
    const authorAvatarUrl = this.readTrimmedString(user.avatarUrl);
    const replyTo = await this.resolveDialogReplyPreview({
      chatId,
      entityType: 'chat',
      dialogType,
      threadId,
      replyToMessageId: parsed.data.replyToMessageId ?? null,
    });
    const chatSettings = await this.getPublicChatCommentSettings(chatId);

    if (!chatSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого чата сейчас закрыты.');
    }

    if (!text && normalizedAttachments.length === 0) {
      throw new BadRequestException('Введите текст комментария или добавьте вложение.');
    }

    return this.createEntityCommentDialogMessageInternal({
      entityType: 'chat',
      chatId,
      user,
      dialogType,
      threadId,
      text,
      normalizedAttachments,
      replyTo,
      source,
      authorDisplayName,
      authorAvatarUrl,
    });
  }

  private async createEntityCommentDialogMessageInternal(params: {
    entityType: DialogMessageEntityType;
    chatId: string;
    user: AuthUser;
    dialogType: 'comments';
    threadId: string | null;
    text: string;
    normalizedAttachments: ChannelDialogAttachmentAsset[];
    replyTo: ChannelDialogReplyPreview | null;
    source: ChannelDialogMessageSource;
    authorDisplayName: string | null;
    authorAvatarUrl: string | null;
  }) {
    const uploadedAttachments = await this.uploadChannelDialogCommentAttachments(
      params.chatId,
      params.normalizedAttachments,
    );

    const created = await this.prisma.auditLog.create({
      data: {
        chatId: params.chatId,
        actorUserId: params.user.userId,
        action: CHANNEL_DIALOG_ACTION_COMMENT,
        payload: {
          type: params.dialogType,
          threadId: params.threadId,
          text: params.text,
          authorDisplayName: params.authorDisplayName ?? null,
          authorAvatarUrl: params.authorAvatarUrl ?? null,
          ...(params.replyTo
            ? {
                replyTo: {
                  messageId: params.replyTo.messageId,
                  authorDisplayName: params.replyTo.authorDisplayName,
                  text: params.replyTo.text,
                },
              }
            : {}),
          ...(uploadedAttachments.length > 0
            ? { attachments: uploadedAttachments as Prisma.InputJsonValue }
            : {}),
          ...(params.entityType === 'chat'
            ? {
                delivered: true,
                deliveredToUserId: null,
              }
            : {}),
          source: params.source,
        },
      },
    });

    const message = {
      id: created.id,
      type: params.dialogType,
      text: params.text,
      authorUserId: params.user.userId,
      authorDisplayName: params.authorDisplayName ?? null,
      isAdmin: (await this.readDialogAdminUserIds(params.chatId)).has(params.user.userId),
      avatarUrl: params.authorAvatarUrl ?? null,
      createdAt: created.createdAt.toISOString(),
      editedAt: null,
      replyToMessageId: params.replyTo?.messageId ?? null,
      replyTo: params.replyTo ?? null,
      attachments: this.buildChannelDialogCommentAttachments(uploadedAttachments),
      reactionGroups: [],
      canEdit: true,
      canDelete: true,
      canDeleteAsAdmin: false,
    };

    if (params.threadId) {
      await this.syncCommentsButtonCount({
        chatId: params.chatId,
        entityType: params.entityType,
        threadId: params.threadId,
      });
    }

    await this.ensureEntityDialogReplySubscription({
      entityType: params.entityType,
      chatId: params.chatId,
      threadId: params.threadId,
      userId: params.user.userId,
    });
    void this.deliverEntityDialogCommentNotifications({
      entityType: params.entityType,
      chatId: params.chatId,
      threadId: params.threadId,
      messageId: created.id,
      authorUserId: params.user.userId,
      authorDisplayName: params.authorDisplayName,
      text: params.text,
      attachmentCount: uploadedAttachments.length,
      replyToMessageId: params.replyTo?.messageId ?? null,
    }).catch((error: unknown) => {
      this.logger.warn(
        {
          chatId: params.chatId,
          entityType: params.entityType,
          messageId: created.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to schedule comment dialog notifications',
      );
    });

    return createChannelDialogMessageResponseSchema.parse({
      ok: true,
      message,
    });
  }

  private async updateEntityDialogNotifications(params: {
    entityType: ManagedEntityType;
    chatId: string;
    userId: string;
    dialogType: ChannelDialogType;
    body: unknown;
  }) {
    if (params.dialogType !== 'comments') {
      throw new BadRequestException('Уведомления доступны только в комментариях.');
    }

    const parsed = updateChannelDialogNotificationsRequestSchema.safeParse(params.body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const threadId =
      params.entityType === 'channel'
        ? this.dialogLinkHelper.resolveChannelDialogThreadId(
            params.chatId,
            params.dialogType,
            parsed.data.token,
          )
        : this.dialogLinkHelper.resolveChatDialogThreadId(
            params.chatId,
            params.dialogType,
            parsed.data.token,
          );
    const notificationSettings = await this.upsertEntityDialogNotificationSubscription({
      entityType: params.entityType,
      chatId: params.chatId,
      threadId,
      userId: params.userId,
      mode: parsed.data.mode,
    });

    return updateChannelDialogNotificationsResponseSchema.parse({
      ok: true,
      notificationSettings,
    });
  }

  async updateChannelDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const parsed = updateChannelDialogMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const channelSettings = await this.getPublicChannelSettings(chatId);
    if (!channelSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого канала сейчас закрыты.');
    }

    return this.updateEntityDialogMessage({
      chatId,
      entityType: 'channel',
      userId: user.userId,
      dialogType,
      messageId,
      token: parsed.data.token,
      text: parsed.data.text,
    });
  }

  async deleteChannelDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const parsed = deleteChannelDialogMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const channelSettings = await this.getPublicChannelSettings(chatId);
    if (!channelSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого канала сейчас закрыты.');
    }

    return this.deleteEntityDialogMessage({
      chatId,
      entityType: 'channel',
      userId: user.userId,
      dialogType,
      messageId,
      token: parsed.data.token,
    });
  }

  async updateChatDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const parsed = updateChannelDialogMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const chatSettings = await this.getPublicChatCommentSettings(chatId);
    if (!chatSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого чата сейчас закрыты.');
    }

    return this.updateEntityDialogMessage({
      chatId,
      entityType: 'chat',
      userId: user.userId,
      dialogType,
      messageId,
      token: parsed.data.token,
      text: parsed.data.text,
    });
  }

  async deleteChatDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const parsed = deleteChannelDialogMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const chatSettings = await this.getPublicChatCommentSettings(chatId);
    if (!chatSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого чата сейчас закрыты.');
    }

    return this.deleteEntityDialogMessage({
      chatId,
      entityType: 'chat',
      userId: user.userId,
      dialogType,
      messageId,
      token: parsed.data.token,
    });
  }

  async toggleChannelDialogReaction(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
  ) {
    return toggleDialogReactionValue({
      chatId,
      entityType: 'channel',
      messageId,
      user,
      dialogTypeRaw,
      body,
      loadCommentSettings: (channelId) => this.getPublicChannelSettings(channelId),
      toggleReaction: (options) => this.toggleEntityDialogReaction(options),
    });
  }

  async toggleChatDialogReaction(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
  ) {
    return toggleDialogReactionValue({
      chatId,
      entityType: 'chat',
      messageId,
      user,
      dialogTypeRaw,
      body,
      loadCommentSettings: (chatId) => this.getPublicChatCommentSettings(chatId),
      toggleReaction: (options) => this.toggleEntityDialogReaction(options),
    });
  }

  async applySettingsToAllChats(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
    targetOrSettingKeys: ApplySettingsTarget | readonly (keyof ChatSettings)[] = {
      mode: 'all',
      favoriteTypes: [],
      chatIds: [],
    },
    settingKeys?: readonly (keyof ChatSettings)[],
  ): Promise<ApplySettingsToAllChatsResult> {
    await this.assertManagedEntityAdminAccess(sourceChatId, user.userId, 'chat');
    return applySettingsToAllChatsValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      sourceChatId,
      actorUserId: user.userId,
      body,
      source,
      targetOrSettingKeys,
      settingKeys,
      normalizeSettings: (settings) => this.normalizeChatSettingsForApply(sourceChatId, settings),
      resolveTargetChats: (target) =>
        this.resolveSettingsApplyTargetChatsForSettings(sourceChatId, user, target),
      resolveBotAssignmentData: (chatId) => this.resolveSettingsApplyBotAssignmentData(chatId),
      assertRequiredSubscriptionSettings: (settings) =>
        this.assertRequiredSubscriptionSettingsForChatSettings(settings),
      isRequiredSubscriptionCurrentlyActive: (settings) =>
        this.isRequiredSubscriptionCurrentlyActiveForSettings(settings),
      scheduleReadinessRefresh: (params) =>
        this.scheduleApplySettingsToAllReadinessRefreshForSettings(params),
    });
  }

  async applySettingsSectionToAllChats(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ApplySectionToAllResponse> {
    return applySettingsSectionToAllChatsValue({
      sourceChatId,
      body,
      source,
      getSourceSettings: () => this.getSettings(sourceChatId, user),
      applySettings: (settings, target, settingKeys) =>
        this.applySettingsToAllChats(sourceChatId, user, settings, source, target, settingKeys),
      syncDomainAllowlistToChats: (targetChatIds) =>
        this.syncDomainAllowlistToChatsForSettings(sourceChatId, targetChatIds),
    });
  }

  private async resolveSettingsApplyTargetChats(
    sourceChatId: string,
    user: AuthUser,
    target: ApplySettingsTarget,
  ): Promise<ChatSummary[]> {
    const availableChats = await this.listChatsForMassBroadcast(user, {
      discoveryMode: 'cached-first',
    });
    const sourceChat =
      availableChats.find((chat) => chat.id === sourceChatId) ??
      this.createManagedEntitySummary({
        id: sourceChatId,
        title: `Chat ${sourceChatId}`,
        createdAt: new Date().toISOString(),
        entityType: 'chat',
      });
    const selectableChats = this.mergeManagedEntityGroups([sourceChat], availableChats);
    const selectableById = new Map(selectableChats.map((chat) => [chat.id, chat]));

    if (target.mode === 'current') {
      return [sourceChat];
    }

    if (target.mode === 'all') {
      return selectableChats;
    }

    if (target.mode === 'selectedChats') {
      return this.resolveOrderedTargetChats(target.chatIds, selectableById);
    }

    const favoriteTypes =
      target.mode === 'allFavorites' ? MANAGED_ENTITY_FAVORITE_TYPE_ORDER : target.favoriteTypes;
    const favoriteChatIds = await this.listFavoriteChatIdsForSettingsTarget(
      user.userId,
      favoriteTypes,
    );
    return this.resolveOrderedTargetChats(favoriteChatIds, selectableById);
  }

  private resolveOrderedTargetChats(
    chatIds: readonly string[],
    selectableById: ReadonlyMap<string, ChatSummary>,
  ): ChatSummary[] {
    const seen = new Set<string>();
    const targetChats: ChatSummary[] = [];

    for (const chatId of chatIds) {
      const normalizedChatId = this.readTrimmedString(chatId);
      if (!normalizedChatId || seen.has(normalizedChatId)) {
        continue;
      }

      const chat = selectableById.get(normalizedChatId);
      if (!chat) {
        continue;
      }

      seen.add(normalizedChatId);
      targetChats.push(chat);
    }

    return targetChats;
  }

  private async listFavoriteChatIdsForSettingsTarget(
    userId: string,
    favoriteTypes: readonly ManagedEntityFavoriteType[],
  ): Promise<string[]> {
    if (favoriteTypes.length === 0) {
      return [];
    }

    const rows = await this.prisma.managedEntityFavorite.findMany({
      where: {
        userId,
        entityType: ChatEntityType.CHAT,
        favoriteType: {
          in: favoriteTypes.map((favoriteType) => PRISMA_FAVORITE_TYPE_BY_CONTRACT[favoriteType]),
        },
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: {
        chatId: true,
      },
    });

    return Array.from(new Set(rows.map((row) => row.chatId)));
  }

  private normalizeChatSettings(
    settings: ChatSettings,
    currentState?: Pick<
      ChatSettings,
      | 'nightModeForceCloseEnabled'
      | 'nightModeForceCloseForever'
      | 'nightModeForceCloseHours'
      | 'nightModeForceCloseDays'
      | 'nightModeForceCloseUntil'
      | 'requiredSubscriptionEnabled'
      | 'requiredSubscriptionChannelIds'
      | 'requiredSubscriptionDurationDays'
      | 'requiredSubscriptionExpiresAt'
    > | null,
    chatId?: string,
    options?: {
      resetRequiredSubscriptionExpiration?: boolean;
    },
  ): ChatSettings {
    const normalized = this.normalizeNightModeSettings(
      this.normalizeInvitationAccessSettings(
        this.normalizeMessageLimitsBlockedLists(
          this.normalizeRequiredSubscriptionSettings(settings, currentState, options),
        ),
      ),
      currentState,
    );

    return chatId ? this.normalizeChatSettingsButtonUrls(chatId, normalized) : normalized;
  }

  private normalizeRequiredSubscriptionSettings(
    settings: ChatSettings,
    currentState?: Pick<
      ChatSettings,
      | 'requiredSubscriptionEnabled'
      | 'requiredSubscriptionChannelIds'
      | 'requiredSubscriptionDurationDays'
      | 'requiredSubscriptionExpiresAt'
    > | null,
    options?: {
      resetRequiredSubscriptionExpiration?: boolean;
    },
  ): ChatSettings {
    const requiredSubscriptionChannelIds = Array.from(
      new Set(
        settings.requiredSubscriptionChannelIds
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    );
    const requiredSubscriptionDurationDays = Math.min(
      REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX,
      Math.max(
        REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN,
        Math.round(Number(settings.requiredSubscriptionDurationDays)),
      ),
    );
    const requiredSubscriptionEnabled =
      settings.requiredSubscriptionEnabled && requiredSubscriptionChannelIds.length > 0;
    const requiredSubscriptionExpiresAt = requiredSubscriptionEnabled
      ? this.resolveRequiredSubscriptionExpiresAt(
          {
            ...settings,
            requiredSubscriptionEnabled,
            requiredSubscriptionChannelIds,
            requiredSubscriptionDurationDays,
            requiredSubscriptionExpiresAt: settings.requiredSubscriptionExpiresAt,
          },
          currentState,
          options,
        )
      : '';

    return {
      ...settings,
      requiredSubscriptionEnabled,
      requiredSubscriptionChannelIds,
      requiredSubscriptionDurationDays,
      requiredSubscriptionExpiresAt,
    };
  }

  private normalizeInvitationAccessSettings(settings: ChatSettings): ChatSettings {
    const invitationAccessRequiredCount = Math.min(
      INVITATION_ACCESS_REQUIRED_COUNT_MAX,
      Math.max(
        INVITATION_ACCESS_REQUIRED_COUNT_MIN,
        Math.round(Number(settings.invitationAccessRequiredCount)),
      ),
    );

    return { ...settings, invitationAccessEnabled: false, invitationAccessRequiredCount };
  }

  private normalizeRequiredSubscriptionExpiresAt(value: unknown): string {
    if (typeof value !== 'string') {
      return '';
    }

    const normalized = value.trim();
    if (!normalized) {
      return '';
    }

    const timestampMs = Date.parse(normalized);
    if (!Number.isFinite(timestampMs)) {
      return '';
    }

    return new Date(timestampMs).toISOString();
  }

  private hasRequiredSubscriptionExpired(
    settings: Pick<ChatSettings, 'requiredSubscriptionExpiresAt'>,
  ): boolean {
    const expiresAt = this.normalizeRequiredSubscriptionExpiresAt(
      settings.requiredSubscriptionExpiresAt,
    );
    if (!expiresAt) {
      return false;
    }

    return Date.parse(expiresAt) <= Date.now();
  }

  private isRequiredSubscriptionCurrentlyActive(
    settings: Pick<
      ChatSettings,
      | 'requiredSubscriptionEnabled'
      | 'requiredSubscriptionChannelIds'
      | 'requiredSubscriptionExpiresAt'
    >,
  ): boolean {
    return (
      settings.requiredSubscriptionEnabled &&
      settings.requiredSubscriptionChannelIds.length > 0 &&
      !this.hasRequiredSubscriptionExpired(settings)
    );
  }

  private buildRequiredSubscriptionExpiresAt(durationDays: number): string {
    return new Date(
      Date.now() + durationDays * REQUIRED_SUBSCRIPTION_DURATION_DAY_MS,
    ).toISOString();
  }

  private resolveRequiredSubscriptionExpiresAt(
    settings: Pick<
      ChatSettings,
      | 'requiredSubscriptionEnabled'
      | 'requiredSubscriptionChannelIds'
      | 'requiredSubscriptionDurationDays'
      | 'requiredSubscriptionExpiresAt'
    >,
    currentState?: Pick<
      ChatSettings,
      | 'requiredSubscriptionEnabled'
      | 'requiredSubscriptionChannelIds'
      | 'requiredSubscriptionDurationDays'
      | 'requiredSubscriptionExpiresAt'
    > | null,
    options?: {
      resetRequiredSubscriptionExpiration?: boolean;
    },
  ): string {
    if (
      !settings.requiredSubscriptionEnabled ||
      settings.requiredSubscriptionChannelIds.length === 0
    ) {
      return '';
    }

    if (options?.resetRequiredSubscriptionExpiration) {
      return this.buildRequiredSubscriptionExpiresAt(settings.requiredSubscriptionDurationDays);
    }

    if (currentState === undefined) {
      return this.normalizeRequiredSubscriptionExpiresAt(settings.requiredSubscriptionExpiresAt);
    }

    if (!currentState?.requiredSubscriptionEnabled) {
      return this.buildRequiredSubscriptionExpiresAt(settings.requiredSubscriptionDurationDays);
    }

    const currentExpiresAt = this.normalizeRequiredSubscriptionExpiresAt(
      currentState.requiredSubscriptionExpiresAt,
    );
    if (!currentExpiresAt || this.hasRequiredSubscriptionExpired(currentState)) {
      return this.buildRequiredSubscriptionExpiresAt(settings.requiredSubscriptionDurationDays);
    }

    if (
      currentState.requiredSubscriptionDurationDays !== settings.requiredSubscriptionDurationDays
    ) {
      return this.buildRequiredSubscriptionExpiresAt(settings.requiredSubscriptionDurationDays);
    }

    if (
      currentState.requiredSubscriptionChannelIds.length !==
      settings.requiredSubscriptionChannelIds.length
    ) {
      return this.buildRequiredSubscriptionExpiresAt(settings.requiredSubscriptionDurationDays);
    }

    for (const [index, channelId] of settings.requiredSubscriptionChannelIds.entries()) {
      if (currentState.requiredSubscriptionChannelIds[index] !== channelId) {
        return this.buildRequiredSubscriptionExpiresAt(settings.requiredSubscriptionDurationDays);
      }
    }

    return currentExpiresAt;
  }

  private normalizeMessageLimitsBlockedLists(settings: ChatSettings): ChatSettings {
    const messageLimitsBlockedWords = Array.from(
      new Set(
        settings.messageLimitsBlockedWords.flatMap(
          (item) => normalizeMessageLimitsBlockedWordCandidate(item) ?? [],
        ),
      ),
    );
    const messageLimitsBlockedDomains = Array.from(
      new Set(
        settings.messageLimitsBlockedDomains.flatMap(
          (item) => normalizeMessageLimitsBlockedDomainCandidate(item) ?? [],
        ),
      ),
    );
    return {
      ...settings,
      messageLimitsBlockedWords,
      messageLimitsBlockedDomains,
    };
  }

  private normalizeStoredLinkButtons(
    rawButtons: unknown,
    legacy?: {
      buttonUrl?: string | null;
      buttonText?: string | null;
    },
  ): BroadcastLinkButton[] {
    return normalizeStoredLinkButtonsValue(rawButtons, legacy);
  }

  private buildStoredLinkButtonState(
    rawButtons: unknown,
    legacy?: {
      buttonUrl?: string | null;
      buttonText?: string | null;
    },
  ): {
    buttons: BroadcastLinkButton[];
    buttonUrl: string;
    buttonText: string;
  } {
    return buildStoredLinkButtonStateValue(rawButtons, legacy);
  }

  private areBroadcastButtonsEqual(left: readonly BroadcastLinkButton[], right: unknown): boolean {
    if (!Array.isArray(right)) {
      return left.length === 0;
    }

    if (left.length !== right.length) {
      return false;
    }

    return left.every((button, index) => {
      const candidate = right[index];
      if (!candidate || typeof candidate !== 'object') {
        return false;
      }

      const row = candidate as { text?: unknown; url?: unknown };
      return row.text === button.text && row.url === button.url;
    });
  }

  private sanitizeStoredChatSettings(settings: unknown): unknown {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return settings;
    }

    let normalizedSettings = settings as Record<string, unknown>;

    for (const group of CHAT_SETTINGS_BUTTON_GROUPS) {
      const buttonState = this.buildStoredLinkButtonState(normalizedSettings[group.buttons], {
        buttonUrl: normalizedSettings[group.url] as string | null | undefined,
        buttonText: normalizedSettings[group.text] as string | null | undefined,
      });
      const enabled = normalizedSettings[group.enabled] === true;
      const shouldDisableButton = enabled && buttonState.buttons.length === 0;
      const currentUrl = normalizedSettings[group.url];
      const currentText = normalizedSettings[group.text];
      const currentButtons = normalizedSettings[group.buttons];

      if (
        !this.areBroadcastButtonsEqual(buttonState.buttons, currentButtons) ||
        currentUrl !== buttonState.buttonUrl ||
        currentText !== buttonState.buttonText ||
        shouldDisableButton
      ) {
        normalizedSettings = {
          ...normalizedSettings,
          [group.buttons]: buttonState.buttons,
          [group.url]: buttonState.buttonUrl,
          [group.text]: buttonState.buttonText,
          ...(shouldDisableButton ? { [group.enabled]: false } : {}),
        };
      }
    }

    return normalizedSettings;
  }

  private sanitizeStoredChannelSettings(settings: unknown): unknown {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return settings;
    }

    let normalizedSettings = settings as Record<string, unknown>;

    for (const key of CHANNEL_SETTINGS_BUTTON_URL_KEYS) {
      const normalizedUrl = this.normalizeLegacyProfileButtonUrl(
        normalizedSettings[key] as string | null | undefined,
      );
      const enabledKey = CHANNEL_SETTINGS_BUTTON_ENABLED_BY_URL_KEY[key];
      const shouldDisableButton =
        normalizedUrl.length === 0 && normalizedSettings[enabledKey] === true;
      if (normalizedUrl !== normalizedSettings[key] || shouldDisableButton) {
        normalizedSettings = {
          ...normalizedSettings,
          [key]: normalizedUrl,
          ...(shouldDisableButton ? { [enabledKey]: false } : {}),
        };
      }
    }

    return normalizedSettings;
  }

  private normalizeChatSettingsButtonUrls(chatId: string, settings: ChatSettings): ChatSettings {
    let normalizedSettings = settings;

    for (const group of CHAT_SETTINGS_BUTTON_GROUPS) {
      const buttonState = this.buildStoredLinkButtonState(normalizedSettings[group.buttons], {
        buttonUrl: normalizedSettings[group.url],
        buttonText: normalizedSettings[group.text],
      });
      const shouldDisableButton =
        buttonState.buttons.length === 0 && normalizedSettings[group.enabled];
      if (
        !this.areBroadcastButtonsEqual(buttonState.buttons, normalizedSettings[group.buttons]) ||
        buttonState.buttonUrl !== normalizedSettings[group.url] ||
        buttonState.buttonText !== normalizedSettings[group.text] ||
        shouldDisableButton
      ) {
        normalizedSettings = {
          ...normalizedSettings,
          [group.buttons]: buttonState.buttons,
          [group.url]: buttonState.buttonUrl,
          [group.text]: buttonState.buttonText,
          ...(shouldDisableButton ? { [group.enabled]: false } : {}),
        };
      }
    }

    return normalizedSettings;
  }

  private normalizeChannelSettingsButtonUrls(
    chatId: string,
    settings: ChannelSettings,
  ): ChannelSettings {
    let normalizedSettings = settings;

    for (const key of CHANNEL_SETTINGS_BUTTON_URL_KEYS) {
      const normalizedUrl = this.normalizeLegacyProfileButtonUrl(settings[key]);
      const enabledKey = CHANNEL_SETTINGS_BUTTON_ENABLED_BY_URL_KEY[key];
      const shouldDisableButton = normalizedUrl.length === 0 && normalizedSettings[enabledKey];
      if (normalizedUrl !== normalizedSettings[key] || shouldDisableButton) {
        normalizedSettings = {
          ...normalizedSettings,
          [key]: normalizedUrl,
          ...(shouldDisableButton ? { [enabledKey]: false } : {}),
        };
      }
    }

    return normalizedSettings;
  }

  private async resolveRequiredSubscriptionChannelHeaders(
    channelIds: readonly string[],
  ): Promise<ManagedEntityHeader[]> {
    const normalizedChannelIds = Array.from(
      new Set(
        channelIds
          .map((value) => value.trim())
          .filter((value): value is string => value.length > 0),
      ),
    );
    const channels = await mapWithConcurrencyLimit(
      normalizedChannelIds,
      REQUIRED_SUBSCRIPTION_CHANNEL_CHECK_CONCURRENCY,
      async (channelId) => {
        try {
          return await this.resolveRequiredSubscriptionChannelById(channelId);
        } catch (error: unknown) {
          this.logger.warn(
            {
              channelId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to resolve required subscription entity for settings screen',
          );
          return null;
        }
      },
    );

    return channels.filter((channel): channel is ManagedEntityHeader => channel !== null);
  }

  private async resolveRequiredSubscriptionChannelReference(
    value: string,
  ): Promise<ManagedEntityHeader> {
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      throw new BadRequestException(
        'Укажите публичную ссылку, ссылку на чат/пост MAX или ID чата/канала.',
      );
    }

    const extractedChatId = this.extractRequiredSubscriptionChannelIdFromValue(normalizedValue);
    if (extractedChatId) {
      return this.resolveRequiredSubscriptionChannelById(extractedChatId);
    }

    const normalizedLink = this.normalizeRequiredSubscriptionChannelLink(normalizedValue);
    if (normalizedLink) {
      const channel = await this.resolveRequiredSubscriptionChannelByLink(normalizedLink);
      return this.resolveRequiredSubscriptionChannelById(channel.chatId, {
        preferredBotId: channel.botId ?? null,
        observedBotIds: channel.botIds ?? [],
      });
    }

    return this.resolveRequiredSubscriptionChannelById(normalizedValue);
  }

  private buildRequiredSubscriptionChannelUrlCandidates(
    value: string | null | undefined,
  ): string[] {
    if (typeof value !== 'string') {
      return [];
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    const candidates = [trimmed];
    if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
      if (trimmed.startsWith('/')) {
        candidates.unshift(`https://max.ru${trimmed}`);
      } else if (trimmed.startsWith('max.ru/') || trimmed.startsWith('www.max.ru/')) {
        candidates.unshift(`https://${trimmed}`);
      } else if (trimmed.includes('/') && !/\s/u.test(trimmed)) {
        candidates.unshift(`https://max.ru/${trimmed.replace(/^\/+/u, '')}`);
      }
    }

    return Array.from(new Set(candidates));
  }

  private extractRequiredSubscriptionChannelIdFromValue(
    value: string | null | undefined,
  ): string | null {
    for (const candidate of this.buildRequiredSubscriptionChannelUrlCandidates(value)) {
      try {
        const parsed = new URL(candidate);
        const hostname = parsed.hostname.trim().toLowerCase();
        if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
          continue;
        }

        const pathSegments = parsed.pathname
          .split('/')
          .map((segment) => segment.trim())
          .filter(Boolean);
        const rootSegment = pathSegments[0]?.toLowerCase();
        if (rootSegment !== 'chats' && rootSegment !== 'c' && rootSegment !== 'chat') {
          continue;
        }

        const chatId = decodeURIComponent(pathSegments[1] ?? '').trim();
        if (chatId) {
          return chatId;
        }
      } catch {
        // Ignore invalid candidate and try the next one.
      }
    }

    return null;
  }

  private async resolveRequiredSubscriptionChannelByLink(link: string): Promise<MaxBotChat> {
    const normalizedLink = this.normalizeRequiredSubscriptionChannelLink(link);
    if (!normalizedLink) {
      throw new BadRequestException('Укажите корректную ссылку чата или канала MAX.');
    }

    try {
      const discoveryAttempts: Array<{ bypassCache?: boolean }> = [{}, { bypassCache: true }];
      for (const attempt of discoveryAttempts) {
        const chats = await this.loadManagedEntitiesDiscoverySnapshot('all', {
          trafficClass: 'interactive',
          ...(attempt.bypassCache === true ? { bypassCache: true } : {}),
        });
        const matched = chats.find(
          (chat) => this.normalizeRequiredSubscriptionChannelLink(chat.link) === normalizedLink,
        );

        if (matched?.chatId) {
          return matched;
        }
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          link: normalizedLink,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve required subscription entity by public link',
      );
      throw new ServiceUnavailableException(
        'Не удалось проверить публичную ссылку чата или канала в MAX. Повторите попытку.',
      );
    }

    let locallyKnownChannel: MaxBotChat | null = null;
    try {
      locallyKnownChannel = await resolveRequiredSubscriptionChannelByKnownLink({
        normalizedLink,
        catalog: this.prisma.managedBotChatCatalog,
        normalizeLink: (value) => this.normalizeRequiredSubscriptionChannelLink(value),
        mergeCatalogRows: (rows) => this.mergeManagedBotChatCatalogRows(rows),
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          link: normalizedLink,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve required subscription entity by local catalog link',
      );
      throw new ServiceUnavailableException(
        'Не удалось проверить сохраненную ссылку чата или канала. Повторите попытку.',
      );
    }

    if (locallyKnownChannel) {
      return locallyKnownChannel;
    }

    throw new BadRequestException(
      'Чат или канал по этой ссылке не найден. Проверьте ссылку и убедитесь, что бот состоит там администратором.',
    );
  }

  private async resolveRequiredSubscriptionChannelById(
    chatId: string,
    options: {
      preferredBotId?: string | null;
      observedBotIds?: readonly string[] | null;
    } = {},
  ): Promise<ManagedEntityHeader> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      throw new BadRequestException('Укажите корректный ID чата или канала.');
    }

    const resolvedBotId =
      this.maxBotRegistry?.getBotById(options.preferredBotId)?.id ??
      (await this.resolveBotAssignment(normalizedChatId)) ??
      null;
    const verifiedBotId =
      (await this.assertBotCanInspectRequiredSubscriptionChannel(normalizedChatId, {
        preferredBotId: resolvedBotId,
        observedBotIds: options.observedBotIds ?? [],
      })) ?? resolvedBotId;
    let snapshot: Awaited<ReturnType<MaxClientService['getChatSnapshot']>>;
    try {
      snapshot = verifiedBotId
        ? await this.maxClient.getChatSnapshot(normalizedChatId, {
            botId: verifiedBotId,
            actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
            sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
          })
        : await this.maxClient.getChatSnapshot(normalizedChatId, {
            actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
            sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
          });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: normalizedChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to load required subscription entity snapshot',
      );
      throw new BadRequestException(
        'Чат или канал не найден в MAX или бот не имеет к нему доступа.',
      );
    }

    const link = snapshot.link?.trim() || null;
    const entityType = snapshot.entityType;
    const prismaEntityType = mapManagedEntityTypeToChatEntityType(entityType);

    const header = this.createManagedEntityHeader({
      id: normalizedChatId,
      title: snapshot.title?.trim() || normalizedChatId,
      entityType,
      link,
      participantsCount: snapshot.participantsCount,
      avatarUrl: snapshot.avatarUrl,
      primaryBotId: verifiedBotId,
    });

    try {
      await this.prisma.chat.upsert({
        where: { id: normalizedChatId },
        create: {
          id: normalizedChatId,
          title: header.title,
          entityType: prismaEntityType,
          ...(verifiedBotId ? { botId: verifiedBotId, primaryBotId: verifiedBotId } : {}),
        },
        update: {
          title: header.title,
          entityType: prismaEntityType,
          ...(verifiedBotId ? { botId: verifiedBotId, primaryBotId: verifiedBotId } : {}),
        },
      });
      await this.maxBotLinkService?.bindDiscoveredChatBots?.({
        chatId: normalizedChatId,
        primaryBotId: verifiedBotId,
        botIds:
          verifiedBotId || (options.observedBotIds?.length ?? 0) > 0
            ? [verifiedBotId, ...(options.observedBotIds ?? [])].filter(
                (botId): botId is string => typeof botId === 'string' && botId.trim().length > 0,
              )
            : [],
        title: header.title,
        entityType: prismaEntityType,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: normalizedChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist resolved required subscription entity title',
      );
    }

    await this.chatContextCache.setManagedEntityHeader?.(header);
    return header;
  }

  private async assertBotCanInspectRequiredSubscriptionChannel(
    chatId: string,
    options: {
      preferredBotId?: string | null;
      observedBotIds?: readonly string[] | null;
    } = {},
  ): Promise<string | null> {
    const candidateBotIds = Array.from(
      new Set(
        [
          this.maxBotRegistry?.getBotById(options.preferredBotId)?.id ?? null,
          ...((options.observedBotIds ?? []).map(
            (botId) => this.maxBotRegistry?.getBotById(botId)?.id ?? null,
          ) as Array<string | null>),
          ...(await this.resolveCandidateBotIdsForChat(chatId, {
            includeDiscoveryFallback: true,
          })),
        ].filter((botId): botId is string => Boolean(botId)),
      ),
    );

    let serviceFailure: unknown = null;
    for (const botId of candidateBotIds) {
      try {
        const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
          trafficClass: 'interactive',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
          botId,
        });
        if (access.isAdmin || access.isOwner) {
          return botId;
        }
      } catch (error: unknown) {
        if (isBotAdminLookupDeniedError(error)) {
          continue;
        }
        serviceFailure = serviceFailure ?? error;
      }
    }

    if (candidateBotIds.length === 0) {
      try {
        const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
          trafficClass: 'interactive',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
        });
        if (access.isAdmin || access.isOwner) {
          return this.maxBotRegistry?.getBotById(options.preferredBotId)?.id ?? null;
        }
      } catch (error: unknown) {
        if (!isBotAdminLookupDeniedError(error)) {
          serviceFailure = serviceFailure ?? error;
        }
      }
    }

    if (!serviceFailure) {
      throw new BadRequestException(
        'Бот должен быть администратором этого чата или канала, чтобы проверять подписку.',
      );
    }

    this.logger.warn(
      {
        chatId,
        err: serviceFailure instanceof Error ? serviceFailure.message : String(serviceFailure),
      },
      'Failed to verify bot admin access for required subscription entity',
    );
    throw new ServiceUnavailableException(
      'Не удалось проверить права бота в чате или канале MAX. Повторите попытку.',
    );
  }

  private normalizeRequiredSubscriptionChannelLink(
    value: string | null | undefined,
  ): string | null {
    for (const candidate of this.buildRequiredSubscriptionChannelUrlCandidates(value)) {
      try {
        const parsed = new URL(candidate);
        const hostname = parsed.hostname.trim().toLowerCase();
        if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
          continue;
        }

        let pathname = parsed.pathname.replace(/\/+$/u, '');
        if (!pathname) {
          continue;
        }

        const pathSegments = pathname
          .split('/')
          .map((segment) => segment.trim())
          .filter(Boolean);
        const rootSegment = pathSegments[0]?.toLowerCase();
        if ((rootSegment === 'channel' || rootSegment === 'channels') && pathSegments[1]) {
          pathname = `/${pathSegments[1]}`;
        } else if (
          pathSegments.length === 1 &&
          rootSegment !== 'chat' &&
          rootSegment !== 'chats' &&
          rootSegment !== 'c' &&
          rootSegment !== 'join'
        ) {
          pathname = `/${pathSegments[0]}`;
        }

        parsed.search = '';
        parsed.hash = '';

        return `https://max.ru${pathname}`;
      } catch {
        // Ignore invalid candidate and try the next one.
      }
    }

    return null;
  }

  private async assertRequiredSubscriptionSettings(settings: ChatSettings): Promise<void> {
    if (!settings.requiredSubscriptionEnabled) {
      return;
    }

    const selectedChannelIds = settings.requiredSubscriptionChannelIds;
    if (selectedChannelIds.length === 0) {
      throw new BadRequestException({
        requiredSubscriptionChannelIds: {
          _errors: ['Выберите хотя бы один чат или канал для обязательной подписки.'],
        },
      });
    }

    const invalidChannelIds = (
      await mapWithConcurrencyLimit(
        selectedChannelIds,
        REQUIRED_SUBSCRIPTION_CHANNEL_CHECK_CONCURRENCY,
        async (channelId) => {
          try {
            await this.resolveRequiredSubscriptionChannelById(channelId);
            return null;
          } catch {
            return channelId;
          }
        },
      )
    ).filter((channelId): channelId is string => channelId !== null);

    if (invalidChannelIds.length > 0) {
      throw new BadRequestException({
        requiredSubscriptionChannelIds: {
          _errors: [
            'Для обязательной подписки нужны чаты или каналы MAX, где бот состоит администратором и может проверить подписку.',
          ],
        },
      });
    }
  }

  private async resolveRequiredSubscriptionEntityType(chatId: string): Promise<ManagedEntityType> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return 'channel';
    }

    const cachedChannelHeader = await this.chatContextCache.getManagedEntityHeader?.(
      normalizedChatId,
      'channel',
    );
    if (cachedChannelHeader) {
      return 'channel';
    }

    const cachedChatHeader = await this.chatContextCache.getManagedEntityHeader?.(
      normalizedChatId,
      'chat',
    );
    if (cachedChatHeader) {
      return 'chat';
    }

    try {
      const resolved = await this.resolveRequiredSubscriptionChannelById(normalizedChatId);
      return resolved.entityType;
    } catch {
      const persisted = await this.prisma.chat.findUnique({
        where: { id: normalizedChatId },
        select: {
          entityType: true,
        },
      });
      if (persisted?.entityType) {
        return fromPrismaEntityType(persisted.entityType);
      }
    }

    return 'channel';
  }

  private async refreshRequiredSubscriptionAccessSnapshots(
    entityIds: readonly string[],
    reason: string,
  ): Promise<void> {
    const normalizedEntityIds = Array.from(
      new Set(
        entityIds.map((entityId) => entityId.trim()).filter((entityId) => entityId.length > 0),
      ),
    );
    await mapWithConcurrencyLimit(
      normalizedEntityIds,
      REQUIRED_SUBSCRIPTION_CHANNEL_CHECK_CONCURRENCY,
      async (entityId) => {
        await this.refreshManagedEntityBotAccessSnapshots(
          entityId,
          await this.resolveRequiredSubscriptionEntityType(entityId),
          reason,
        );
      },
    );
  }

  private normalizeNightModeSettings(
    settings: ChatSettings,
    currentState?: Pick<
      ChatSettings,
      | 'nightModeForceCloseEnabled'
      | 'nightModeForceCloseForever'
      | 'nightModeForceCloseHours'
      | 'nightModeForceCloseDays'
      | 'nightModeForceCloseUntil'
    > | null,
  ): ChatSettings {
    let normalized = settings;

    if (!normalized.nightModeEnabled) {
      normalized = {
        ...normalized,
        nightModeBotMessageEnabled: false,
        nightModeCommentsEnabled: false,
        nightModeBotButtonEnabled: false,
        nightModeRulesButtonEnabled: false,
      };
    } else if (!normalized.nightModeBotMessageEnabled) {
      normalized = {
        ...normalized,
        nightModeCommentsEnabled: false,
        nightModeBotButtonEnabled: false,
        nightModeRulesButtonEnabled: false,
      };
    }

    return this.normalizeNightModeForceCloseSettings(normalized, currentState);
  }

  private normalizeNightModeForceCloseSettings(
    settings: ChatSettings,
    currentState?: Pick<
      ChatSettings,
      | 'nightModeForceCloseEnabled'
      | 'nightModeForceCloseForever'
      | 'nightModeForceCloseHours'
      | 'nightModeForceCloseDays'
      | 'nightModeForceCloseUntil'
    > | null,
  ): ChatSettings {
    if (!settings.nightModeForceCloseEnabled) {
      return settings.nightModeForceCloseUntil
        ? {
            ...settings,
            nightModeForceCloseUntil: '',
          }
        : settings;
    }

    if (settings.nightModeForceCloseForever) {
      return settings.nightModeForceCloseUntil
        ? {
            ...settings,
            nightModeForceCloseUntil: '',
          }
        : settings;
    }

    const totalHours = settings.nightModeForceCloseDays * 24 + settings.nightModeForceCloseHours;
    if (totalHours <= 0) {
      return {
        ...settings,
        nightModeForceCloseEnabled: false,
        nightModeForceCloseUntil: '',
      };
    }

    if (!currentState) {
      return this.isFutureIsoTimestamp(settings.nightModeForceCloseUntil)
        ? settings
        : {
            ...settings,
            nightModeForceCloseEnabled: false,
            nightModeForceCloseUntil: '',
          };
    }

    const currentUntil = currentState?.nightModeForceCloseUntil ?? '';
    const shouldRefreshUntil =
      !currentState?.nightModeForceCloseEnabled ||
      currentState.nightModeForceCloseForever ||
      currentState.nightModeForceCloseHours !== settings.nightModeForceCloseHours ||
      currentState.nightModeForceCloseDays !== settings.nightModeForceCloseDays ||
      !this.isFutureIsoTimestamp(currentUntil);

    const nextUntil = shouldRefreshUntil
      ? new Date(Date.now() + totalHours * 60 * 60 * 1_000).toISOString()
      : currentUntil;

    return {
      ...settings,
      nightModeForceCloseUntil: nextUntil,
    };
  }

  private isFutureIsoTimestamp(value: string): boolean {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp > Date.now();
  }

  private getChatSettingsNormalizationChanges(
    current: ChatSettings,
    normalized: ChatSettings,
  ): Partial<ChatSettings> {
    const changes: Partial<ChatSettings> = {};

    for (const group of CHAT_SETTINGS_BUTTON_GROUPS) {
      if (!this.areBroadcastButtonsEqual(normalized[group.buttons], current[group.buttons])) {
        changes[group.buttons] = normalized[group.buttons];
      }
      if (current[group.url] !== normalized[group.url]) {
        changes[group.url] = normalized[group.url];
      }
      if (current[group.text] !== normalized[group.text]) {
        changes[group.text] = normalized[group.text];
      }
      if (current[group.enabled] !== normalized[group.enabled]) {
        changes[group.enabled] = normalized[group.enabled];
      }
    }

    if (current.nightModeBotMessageEnabled !== normalized.nightModeBotMessageEnabled) {
      changes.nightModeBotMessageEnabled = normalized.nightModeBotMessageEnabled;
    }
    if (current.nightModeCommentsEnabled !== normalized.nightModeCommentsEnabled) {
      changes.nightModeCommentsEnabled = normalized.nightModeCommentsEnabled;
    }
    if (current.nightModeBotButtonEnabled !== normalized.nightModeBotButtonEnabled) {
      changes.nightModeBotButtonEnabled = normalized.nightModeBotButtonEnabled;
    }
    if (current.nightModeRulesButtonEnabled !== normalized.nightModeRulesButtonEnabled) {
      changes.nightModeRulesButtonEnabled = normalized.nightModeRulesButtonEnabled;
    }
    if (current.nightModeForceCloseEnabled !== normalized.nightModeForceCloseEnabled) {
      changes.nightModeForceCloseEnabled = normalized.nightModeForceCloseEnabled;
    }
    if (current.nightModeForceCloseUntil !== normalized.nightModeForceCloseUntil) {
      changes.nightModeForceCloseUntil = normalized.nightModeForceCloseUntil;
    }

    return changes;
  }

  private getStoredChatSettingsSanitizationChanges(
    current: unknown,
    sanitized: ChatSettings,
  ): Partial<ChatSettings> {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return {};
    }

    const currentSettings = current as Record<string, unknown>;
    const changes: Partial<ChatSettings> = {};

    for (const group of CHAT_SETTINGS_BUTTON_GROUPS) {
      if (
        !this.areBroadcastButtonsEqual(sanitized[group.buttons], currentSettings[group.buttons])
      ) {
        changes[group.buttons] = sanitized[group.buttons];
      }

      const currentUrl = this.readTrimmedString(currentSettings[group.url]) ?? '';
      if (currentUrl !== sanitized[group.url]) {
        changes[group.url] = sanitized[group.url];
      }

      const currentText = this.readTrimmedString(currentSettings[group.text]) ?? '';
      if (currentText !== sanitized[group.text]) {
        changes[group.text] = sanitized[group.text];
      }

      const currentEnabled = currentSettings[group.enabled] === true;
      if (currentEnabled !== sanitized[group.enabled]) {
        changes[group.enabled] = sanitized[group.enabled];
      }
    }

    return changes;
  }

  sendBroadcast(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<SendBroadcastResult> {
    return this.managedBroadcastRuntime.sendBroadcast(sourceChatId, user, body, source);
  }

  sendChannelBroadcast(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<SendBroadcastResult> {
    return this.managedBroadcastRuntime.sendChannelBroadcast(sourceChatId, user, body, source);
  }

  sendBroadcastTest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<SendBroadcastTestResult> {
    return this.managedBroadcastRuntime.sendBroadcastTest(sourceChatId, user, body);
  }

  sendChannelBroadcastTest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<SendBroadcastTestResult> {
    return this.managedBroadcastRuntime.sendChannelBroadcastTest(sourceChatId, user, body);
  }

  listManagedBroadcasts(
    sourceChatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedBroadcastSummary[]> {
    return this.managedBroadcastRuntime.listManagedBroadcasts(sourceChatId, user, options);
  }

  listChannelManagedBroadcasts(
    sourceChatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedBroadcastSummary[]> {
    return this.managedBroadcastRuntime.listChannelManagedBroadcasts(sourceChatId, user, options);
  }

  getManagedBroadcastCalendar(
    sourceChatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ManagedBroadcastCalendarResponse> {
    return this.managedBroadcastRuntime.getManagedBroadcastCalendar(sourceChatId, user, query);
  }

  getChannelManagedBroadcastCalendar(
    sourceChatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ManagedBroadcastCalendarResponse> {
    return this.managedBroadcastRuntime.getChannelManagedBroadcastCalendar(
      sourceChatId,
      user,
      query,
    );
  }

  getManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.managedBroadcastRuntime.getManagedBroadcast(sourceChatId, broadcastId, user);
  }

  getChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.managedBroadcastRuntime.getChannelManagedBroadcast(sourceChatId, broadcastId, user);
  }

  updateManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedBroadcastDetails> {
    return this.managedBroadcastRuntime.updateManagedBroadcast(
      sourceChatId,
      broadcastId,
      user,
      body,
    );
  }

  updateChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedBroadcastDetails> {
    return this.managedBroadcastRuntime.updateChannelManagedBroadcast(
      sourceChatId,
      broadcastId,
      user,
      body,
    );
  }

  cancelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.managedBroadcastRuntime.cancelManagedBroadcast(sourceChatId, broadcastId, user);
  }

  cancelChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.managedBroadcastRuntime.cancelChannelManagedBroadcast(
      sourceChatId,
      broadcastId,
      user,
    );
  }

  retryManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.managedBroadcastRuntime.retryManagedBroadcast(sourceChatId, broadcastId, user);
  }

  retryChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.managedBroadcastRuntime.retryChannelManagedBroadcast(
      sourceChatId,
      broadcastId,
      user,
    );
  }

  processDueManagedBroadcasts(reason: 'startup' | 'scheduled'): Promise<void> {
    return this.managedBroadcastRuntime.processDueManagedBroadcasts(reason);
  }

  getManagedBroadcastRuntimeForBroadcastService(): AdminManagedBroadcastRuntime {
    return this.managedBroadcastRuntime;
  }

  private processManagedBroadcastOccurrence(...args: any[]) {
    return (this.managedBroadcastRuntime as any).processManagedBroadcastOccurrence(...args);
  }

  private createManagedBroadcastDeliverySnapshot(...args: any[]) {
    return (this.managedBroadcastRuntime as any).createManagedBroadcastDeliverySnapshot(...args);
  }

  private mapManagedBroadcastSummary(...args: any[]) {
    return (this.managedBroadcastRuntime as any).mapManagedBroadcastSummary(...args);
  }

  private mapManagedBroadcastDetails(...args: any[]) {
    return (this.managedBroadcastRuntime as any).mapManagedBroadcastDetails(...args);
  }

  private normalizeBroadcastTextFormat(...args: any[]) {
    return (this.managedBroadcastRuntime as any).normalizeBroadcastTextFormat(...args);
  }

  private resolveManagedBroadcastSendRetryDelayMs(
    error: unknown,
    attempt: number,
    options:
      | Pick<
          MaxSendMessageOptions,
          'button' | 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'
        >
      | undefined,
  ): number | null {
    if (this.hasRetriableMaxAttachment(options) && this.isAttachmentNotReadyError(error)) {
      return BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS[attempt - 1] ?? null;
    }

    if (isMaxApiThrottleError(error)) {
      return BROADCAST_THROTTLE_RETRY_DELAYS_MS[attempt - 1] ?? null;
    }

    if (isMaxApiTimeoutError(error)) {
      return BROADCAST_TIMEOUT_RETRY_DELAYS_MS[attempt - 1] ?? null;
    }

    return null;
  }

  private hasRetriableMaxAttachment(
    options:
      | Pick<
          MaxSendMessageOptions,
          'button' | 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'
        >
      | undefined,
  ): boolean {
    return Boolean(options?.imagePayload) || Boolean(options?.attachments?.length);
  }

  private isAttachmentNotReadyError(error: unknown): boolean {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status !== 400) {
      return false;
    }

    const responseData = (error as { response?: { data?: unknown } })?.response?.data;
    const normalized = JSON.stringify(responseData ?? '').toLowerCase();
    return normalized.includes('attachment.not.ready') || normalized.includes('not ready');
  }

  private sleep(ms: number): Promise<void> {
    return sleep(ms);
  }

  private async safeDeleteManagedBroadcast(broadcastId: string): Promise<void> {
    try {
      await this.prisma.managedBroadcast.delete({
        where: { id: broadcastId },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          broadcastId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to clean up managed broadcast after transaction error',
      );
    }
  }

  private isManagedBroadcastSlotConflictError(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    if (code !== 'P2002') {
      return false;
    }

    const metaTarget = (error as { meta?: { target?: unknown } })?.meta?.target;
    const targetValue = Array.isArray(metaTarget)
      ? metaTarget.map((item) => String(item).toLowerCase()).join(',')
      : typeof metaTarget === 'string'
        ? metaTarget.toLowerCase()
        : '';
    const message = error instanceof Error ? error.message.toLowerCase() : '';

    return (
      targetValue.includes('managed_broadcast_occurrences_slot_key') ||
      targetValue.includes('source_chat_id') ||
      targetValue.includes('sourcechatid') ||
      message.includes('managed_broadcast_occurrences_slot_key')
    );
  }

  private extractMaxApiErrorMessage(error: unknown): string {
    return extractMaxApiErrorMessageValue(error);
  }

  private decodeBroadcastImageBase64(value: string): Buffer {
    const normalized = value.trim().replace(/^data:[^;]+;base64,/, '');
    if (!normalized) {
      throw new BadRequestException('Добавьте фото для автопостинга.');
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = Buffer.from(normalized, 'base64');
    } catch {
      throw new BadRequestException('Не удалось прочитать фото.');
    }

    if (imageBuffer.length === 0) {
      throw new BadRequestException('Не удалось прочитать фото.');
    }

    return imageBuffer;
  }

  private decodeRulesImageBase64(value: string): Buffer {
    return decodeRulesImageBase64Value(value);
  }

  private resolveBroadcastImageFileName(fileName: string, mimeType: string): string {
    const trimmed = fileName.trim();
    if (trimmed) {
      return trimmed;
    }

    if (mimeType === 'image/png') {
      return 'broadcast-image.png';
    }
    if (mimeType === 'image/webp') {
      return 'broadcast-image.webp';
    }
    if (mimeType === 'image/gif') {
      return 'broadcast-image.gif';
    }

    return 'broadcast-image.jpg';
  }

  private normalizeManagedBroadcastButtons(
    rawButtons: unknown,
    legacy?: {
      buttonEnabled?: boolean;
      buttonUrl?: string | null;
      buttonText?: string | null;
    },
  ): BroadcastLinkButton[] {
    const normalizedButtons: BroadcastLinkButton[] = [];

    if (Array.isArray(rawButtons)) {
      for (const item of rawButtons) {
        if (!item || typeof item !== 'object') {
          continue;
        }

        const row = item as { text?: unknown; url?: unknown };
        const url = this.normalizeLegacyProfileButtonUrl(
          typeof row.url === 'string' ? row.url : '',
        );

        if (!url) {
          continue;
        }

        normalizedButtons.push({
          text:
            typeof row.text === 'string' && row.text.trim().length > 0
              ? row.text.trim()
              : DEFAULT_BROADCAST_BUTTON_TEXT,
          url,
        });

        if (normalizedButtons.length >= MAX_BROADCAST_LINK_BUTTONS) {
          break;
        }
      }
    }

    if (normalizedButtons.length > 0) {
      return normalizedButtons;
    }

    if (legacy?.buttonEnabled !== true) {
      return [];
    }

    const legacyUrl = this.normalizeLegacyProfileButtonUrl(legacy.buttonUrl ?? '');
    if (!legacyUrl) {
      return [];
    }

    return [
      {
        text: legacy.buttonText?.trim() || DEFAULT_BROADCAST_BUTTON_TEXT,
        url: legacyUrl,
      },
    ];
  }

  private buildManagedBroadcastButtonState(
    rawButtons: unknown,
    legacy?: {
      buttonEnabled?: boolean;
      buttonUrl?: string | null;
      buttonText?: string | null;
    },
  ): {
    buttons: BroadcastLinkButton[];
    buttonEnabled: boolean;
    buttonUrl: string;
    buttonText: string;
  } {
    const buttons = this.normalizeManagedBroadcastButtons(rawButtons, legacy);
    const primaryButton = buttons[0];

    return {
      buttons,
      buttonEnabled: buttons.length > 0,
      buttonUrl: primaryButton?.url ?? '',
      buttonText: primaryButton?.text ?? DEFAULT_BROADCAST_BUTTON_TEXT,
    };
  }

  private buildBroadcastLinkButtonRows(buttons: BroadcastLinkButton[]): MaxMessageButton[][] {
    const rows: MaxMessageButton[][] = [];

    for (let index = 0; index < buttons.length; index += MAX_BROADCAST_LINK_BUTTONS_PER_ROW) {
      rows.push(
        buttons.slice(index, index + MAX_BROADCAST_LINK_BUTTONS_PER_ROW).map((button) => ({
          type: 'link',
          text: button.text,
          url: button.url,
        })),
      );
    }

    return rows;
  }

  async buildChannelPublicationEngagementContext(
    chatId: string,
    botId?: string | null,
  ): Promise<ChannelPublicationEngagementContext> {
    const settings = await this.getPublicChannelSettings(chatId);
    const includeCommentsButton = settings.commentsEnabled;
    const includeSuggestButton = settings.postSuggestionsEnabled;
    const autoPostButtonsMode = this.normalizeChannelAutoPostButtonsMode(settings);

    if (!includeCommentsButton && !includeSuggestButton) {
      return {
        buttons: [],
        threadId: null,
        includeCommentsButton,
        includeSuggestButton,
        suggestButtonText: null,
        autoPostButtonsMode,
        suggestionEntryMode: settings.postSuggestionsEntryMode,
      };
    }

    const threadId = randomUUID();
    const suggestButtonText = settings.postSuggestionsButtonText.trim() || '📰 Предложить пост';
    const buttons: MaxMessageButton[][] = [];

    if (includeCommentsButton) {
      buttons.push([
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
      buttons.push([
        this.buildChannelDialogButton(
          chatId,
          'suggest',
          threadId,
          suggestButtonText,
          botId,
          settings.postSuggestionsEntryMode,
        ),
      ]);
    }

    return {
      buttons,
      threadId,
      includeCommentsButton,
      includeSuggestButton,
      suggestButtonText: includeSuggestButton ? suggestButtonText : null,
      autoPostButtonsMode,
      suggestionEntryMode: settings.postSuggestionsEntryMode,
    };
  }

  async recordChannelPublicationEngagement(params: {
    chatId: string;
    actorUserId: string;
    messageId: string;
    text?: string | null;
    publishedUrl?: string | null;
    context: ChannelPublicationEngagementContext;
    source: string;
    botId?: string | null;
  }): Promise<void> {
    const { chatId, actorUserId, messageId, text, publishedUrl, context, source, botId } = params;
    if (
      !messageId.trim() ||
      !context.threadId ||
      (!context.includeCommentsButton && !context.includeSuggestButton)
    ) {
      return;
    }

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId,
        action: CHANNEL_DIALOG_ACTION_AUTO_ATTACH,
        payload: {
          messageId,
          threadId: context.threadId,
          includeCommentsButton: context.includeCommentsButton,
          includeSuggestButton: context.includeSuggestButton,
          autoPostButtonsMode: context.autoPostButtonsMode,
          suggestionEntryMode: context.suggestionEntryMode,
          source,
          ...(this.readRawString(text)?.trim() ? { text } : {}),
          ...(publishedUrl ? { publishedUrl } : {}),
          ...(botId ? { botId } : {}),
          ...(context.suggestButtonText ? { suggestButtonText: context.suggestButtonText } : {}),
        },
      },
    });
  }

  private async resolveBroadcastButtons(
    chatId: string,
    entityType: ManagedEntityType,
    options: {
      customButtons?: BroadcastLinkButton[];
      buttonEnabled?: boolean;
      buttonUrl?: string;
      buttonText?: string;
      includeCustomButton: boolean;
      customButtonText: string;
      customButtonUrl: string;
    },
    botId?: string,
  ): Promise<MaxMessageButton[][]> {
    return (
      await this.resolveBroadcastButtonContext(chatId, entityType, options, botId)
    ).buttons;
  }

  private async resolveBroadcastButtonContext(
    chatId: string,
    entityType: ManagedEntityType,
    options: {
      customButtons?: BroadcastLinkButton[];
      buttonEnabled?: boolean;
      buttonUrl?: string;
      buttonText?: string;
      includeCustomButton: boolean;
      customButtonText: string;
      customButtonUrl: string;
    },
    botId?: string,
  ): Promise<{
    buttons: MaxMessageButton[][];
    commentDialogReference: {
      entityType: ManagedEntityType;
      threadId: string;
      includeCommentsButton: boolean;
      includeSuggestButton: boolean;
      suggestButtonText: string | null;
      autoPostButtonsMode: ChannelSettings['autoPostButtonsMode'] | null;
      suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'] | null;
      botId: string | null;
    } | null;
  }> {
    const rows = this.buildBroadcastLinkButtonRows(
      this.normalizeManagedBroadcastButtons(options.customButtons, {
        buttonEnabled: options.includeCustomButton,
        buttonUrl: options.customButtonUrl,
        buttonText: options.customButtonText,
      }),
    );

    if (entityType === 'chat') {
      const chatSettings = await this.prisma.chatSettings.upsert({
        where: { chatId },
        create: { chatId },
        update: {},
        select: {
          commentsEnabled: true,
          commentsAdminsEnabled: true,
          commentsAllEnabled: true,
          commentsChatBroadcastsEnabled: true,
        },
      });
      const threadId = randomUUID();
      let commentDialogReference: {
        entityType: ManagedEntityType;
        threadId: string;
        includeCommentsButton: boolean;
        includeSuggestButton: boolean;
        suggestButtonText: string | null;
        autoPostButtonsMode: ChannelSettings['autoPostButtonsMode'] | null;
        suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'] | null;
        botId: string | null;
      } | null = null;

      if (this.shouldIncludeChatCommentsButton(chatSettings)) {
        rows.push([
          this.dialogLinkHelper.buildChatDialogButton(
            chatId,
            'comments',
            threadId,
            formatCommentsButtonText('💬 Комментарии', 0),
            botId,
          ),
        ]);
        commentDialogReference = {
          entityType: 'chat',
          threadId,
          includeCommentsButton: true,
          includeSuggestButton: false,
          suggestButtonText: null,
          autoPostButtonsMode: null,
          suggestionEntryMode: null,
          botId: botId ?? null,
        };
      }

      return {
        buttons: rows,
        commentDialogReference,
      };
    }

    if (entityType !== 'channel') {
      return {
        buttons: rows,
        commentDialogReference: null,
      };
    }

    const channelSettings = await this.prisma.channelSettings.upsert({
      where: { chatId },
      create: {
        chatId,
        commentsEnabled: false,
      },
      update: {},
      select: {
        autoPostButtonsMode: true,
        postSuggestionsEnabled: true,
        postSuggestionsEntryMode: true,
        postSuggestionsButtonText: true,
        commentsEnabled: true,
      },
    });
    const threadId = randomUUID();
    const includeCommentsButton = channelSettings.commentsEnabled;
    const includeSuggestButton = channelSettings.postSuggestionsEnabled;
    const suggestButtonText =
      channelSettings.postSuggestionsButtonText.trim() || '📰 Предложить пост';

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
          suggestButtonText,
          botId,
          channelSettings.postSuggestionsEntryMode,
        ),
      ]);
    }

    return {
      buttons: rows,
      commentDialogReference: includeCommentsButton
        ? {
            entityType: 'channel',
            threadId,
            includeCommentsButton,
            includeSuggestButton,
            suggestButtonText: includeSuggestButton ? suggestButtonText : null,
            autoPostButtonsMode: channelSettings.autoPostButtonsMode,
            suggestionEntryMode: channelSettings.postSuggestionsEntryMode,
            botId: botId ?? null,
          }
        : null,
    };
  }

  private buildChannelDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
    botId?: string | null,
    suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'] = 'BOT',
  ): MaxMessageButton {
    if (type === 'suggest' && suggestionEntryMode !== 'MINIAPP') {
      const startPayload = this.dialogLinkHelper.buildChannelSuggestionStartPayload(
        chatId,
        threadId,
      );
      const botStartUrl = this.dialogLinkHelper.buildBotStartUrl(startPayload, botId);
      if (botStartUrl) {
        return {
          type: 'link',
          text,
          url: botStartUrl,
        };
      }
    }

    const launchUrl = this.dialogLinkHelper.buildChannelDialogLaunchUrl(
      chatId,
      type,
      threadId,
      botId,
    );
    const webAppUrl = this.dialogLinkHelper.buildChannelDialogDirectWebAppUrl(
      chatId,
      type,
      threadId,
    );
    const botContactId = this.dialogLinkHelper.resolveBotContactId(botId);

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
      url: webAppUrl ?? `${this.appBaseUrl ?? 'https://maxim.play-team.ru'}/app/`,
    };
  }

  private readChannelSuggestionEntryMode(
    value: unknown,
  ): ChannelSettings['postSuggestionsEntryMode'] {
    return this.readTrimmedString(value)?.toUpperCase() === 'MINIAPP' ? 'MINIAPP' : 'BOT';
  }

  private resolveRulesImageFileName(fileName: string, mimeType: string): string {
    return resolveRulesImageFileNameValue(fileName, mimeType);
  }

  private async publishMessageWithRetry(
    chatId: string,
    text: string,
    options:
      | Pick<MaxSendMessageOptions, 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'>
      | undefined,
    botId?: string,
  ): Promise<{ messageId: string; url: string | null }> {
    let lastError: unknown = null;
    const attempts = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return botId
          ? await this.maxClient.sendMessageImmediateWithResolvedLink(chatId, text, options, {
              botId,
            })
          : await this.maxClient.sendMessageImmediateWithResolvedLink(chatId, text, options);
      } catch (error: unknown) {
        lastError = error;
        if (
          !this.hasRetriableMaxAttachment(options) ||
          !this.isAttachmentNotReadyError(error) ||
          attempt >= attempts
        ) {
          throw error;
        }
        const delayMs = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS[attempt - 1] ?? 1_500;
        await this.sleep(delayMs);
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('Message publish failed without error details');
  }

  private normalizeChatRulesDraft(...args: any[]) {
    return (this.chatRulesTextRuntime as any).normalizeChatRulesDraft(...args);
  }

  private normalizeImportedRulesText(...args: any[]) {
    return (this.chatRulesTextRuntime as any).normalizeImportedRulesText(...args);
  }

  private upsertChatRules(...args: any[]) {
    return (this.chatRulesTextRuntime as any).upsertChatRules(...args);
  }

  private mapChatRules(...args: any[]) {
    return (this.chatRulesTextRuntime as any).mapChatRules(...args);
  }

  private hydratePublishedRulesUrl(...args: any[]) {
    return (this.chatRulesTextRuntime as any).hydratePublishedRulesUrl(...args);
  }

  private normalizePublishedRulesUrl(...args: any[]) {
    return (this.chatRulesTextRuntime as any).normalizePublishedRulesUrl(...args);
  }

  private buildChatRulesButtonRows(...args: any[]) {
    return (this.chatRulesTextRuntime as any).buildChatRulesButtonRows(...args);
  }

  private buildFormattedRulesPublicationText(...args: any[]) {
    return (this.chatRulesTextRuntime as any).buildFormattedRulesPublicationText(...args);
  }

  private resolveAdminContactFallbackDisplayName(...args: any[]) {
    return (this.chatRulesTextRuntime as any).resolveAdminContactFallbackDisplayName(...args);
  }

  private buildAutofilledRulesTextFromCurrentSettings(...args: any[]) {
    return (this.chatRulesTextRuntime as any).buildAutofilledRulesTextFromCurrentSettings(...args);
  }

  private buildRulesTextFromSettings(...args: any[]) {
    return (this.chatRulesTextRuntime as any).buildRulesTextFromSettings(...args);
  }

  private buildRulesTextItemsFromSettings(...args: any[]) {
    return (this.chatRulesTextRuntime as any).buildRulesTextItemsFromSettings(...args);
  }

  private buildRulesSanctionsSummary(...args: any[]) {
    return (this.chatRulesTextRuntime as any).buildRulesSanctionsSummary(...args);
  }

  private resolveRulesDuplicateAllowedCount(...args: any[]) {
    return (this.chatRulesTextRuntime as any).resolveRulesDuplicateAllowedCount(...args);
  }

  private formatRulesDuplicateAllowanceLabel(...args: any[]) {
    return (this.chatRulesTextRuntime as any).formatRulesDuplicateAllowanceLabel(...args);
  }

  private formatRulesPreviewList(...args: any[]) {
    return (this.chatRulesTextRuntime as any).formatRulesPreviewList(...args);
  }

  private formatRulesConjunctionList(...args: any[]) {
    return (this.chatRulesTextRuntime as any).formatRulesConjunctionList(...args);
  }

  private formatRulesHoursLabel(...args: any[]) {
    return (this.chatRulesTextRuntime as any).formatRulesHoursLabel(...args);
  }

  private formatRulesMinutesLabel(...args: any[]) {
    return (this.chatRulesTextRuntime as any).formatRulesMinutesLabel(...args);
  }

  private formatRulesTime(...args: any[]) {
    return (this.chatRulesTextRuntime as any).formatRulesTime(...args);
  }
  private resolveChannelDialogIntroText(
    settings: ChannelSettings,
    dialogType: ChannelDialogType,
  ): string | null {
    const value =
      dialogType === 'suggest' ? settings.postSuggestionsText : settings.commentsMessageText;
    const normalized = value.trim();
    return normalized || null;
  }

  private isMaxMessageMissingError(error: unknown): boolean {
    return isMaxMessageMissingErrorValue(error);
  }

  async getLogsDashboard(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<LogsDashboardResponse> {
    const startedAtMs = Date.now();
    await this.assertReadOnlyChatAdmin(chatId, user.userId, null);
    const adminCheckedAtMs = Date.now();
    const parsed = logsDashboardQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const cacheKey = buildLogsDashboardResponseCacheKey(
      chatId,
      user.userId,
      parsed.data.range,
      parsed.data.includeActivityPreview,
      parsed.data.includeModerationPreview,
    );
    const cached = this.logsDashboardResponseCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      const response = await cached.promise;
      const finishedAtMs = Date.now();
      const totalMs = finishedAtMs - startedAtMs;
      if (totalMs >= SLOW_LOGS_DASHBOARD_THRESHOLD_MS) {
        this.logger.warn(
          {
            chatId,
            userId: user.userId,
            totalMs,
            adminCheckMs: adminCheckedAtMs - startedAtMs,
            responseMs: finishedAtMs - adminCheckedAtMs,
            cacheHit: true,
            range: parsed.data.range,
            includeActivityPreview: parsed.data.includeActivityPreview,
            includeModerationPreview: parsed.data.includeModerationPreview,
          },
          'Slow logs dashboard request completed',
        );
      }
      return response;
    }

    const pending = this.buildLogsDashboardResponse(
      chatId,
      parsed.data.range,
      parsed.data.includeActivityPreview,
      parsed.data.includeModerationPreview,
    ).catch((error: unknown) => {
      const current = this.logsDashboardResponseCache.get(cacheKey);
      if (current?.promise === pending) {
        this.logsDashboardResponseCache.delete(cacheKey);
      }
      throw error;
    });

    this.logsDashboardResponseCache.set(cacheKey, {
      expiresAtMs: Date.now() + LOGS_DASHBOARD_RESPONSE_CACHE_TTL_MS,
      promise: pending,
    });

    const response = await pending;
    const finishedAtMs = Date.now();
    const totalMs = finishedAtMs - startedAtMs;
    if (totalMs >= SLOW_LOGS_DASHBOARD_THRESHOLD_MS) {
      this.logger.warn(
        {
          chatId,
          userId: user.userId,
          totalMs,
          adminCheckMs: adminCheckedAtMs - startedAtMs,
          responseMs: finishedAtMs - adminCheckedAtMs,
          cacheHit: false,
          range: parsed.data.range,
          includeActivityPreview: parsed.data.includeActivityPreview,
          includeModerationPreview: parsed.data.includeModerationPreview,
        },
        'Slow logs dashboard request completed',
      );
    }

    return response;
  }

  private async buildLogsDashboardResponse(
    chatId: string,
    range: LogsDashboardRange,
    includeActivityPreview = true,
    includeModerationPreview = true,
  ): Promise<LogsDashboardResponse> {
    const startedAtMs = Date.now();
    const now = new Date();
    const from = this.resolveLogsDashboardFrom(range, now);
    const headerPromise =
      this.chatContextCache.getManagedEntityHeader?.(chatId, 'chat') ?? Promise.resolve(null);

    const baseQueriesStartedAtMs = Date.now();
    const [chat, membershipSummary, chatHeader, moderationSummary, moderationFeed] =
      await Promise.all([
        this.prisma.chat.findUnique({
          where: { id: chatId },
          select: { id: true, title: true },
        }),
        includeActivityPreview
          ? selectLogsDashboardMembershipSummary(
              this.prisma,
              chatId,
              from,
              now,
              (edgeChatId, edgeFrom, edgeTo, eventTypes) =>
                this.getMembershipEventRows(edgeChatId, edgeFrom, edgeTo, eventTypes),
            )
          : Promise.resolve({ joinedUsers: 0, leftUsers: 0 }),
        headerPromise,
        includeModerationPreview
          ? selectLogsDashboardModerationSummary(this.prisma, chatId, from, now)
          : Promise.resolve({
              warn: 0,
              deleteMessage: 0,
              mute: 0,
              ban: 0,
              unmute: 0,
              unban: 0,
              affectedUsers: 0,
            }),
        includeModerationPreview
          ? this.getModerationFeedPage(
              chatId,
              from,
              now,
              {
                range,
                filter: 'ALL',
                limit: LOGS_DASHBOARD_VIOLATIONS_LIMIT,
              },
              'chat',
              { allowRemoteLookup: false },
            )
          : this.buildEmptyModerationFeedPage(),
      ]);
    const baseQueriesFinishedAtMs = Date.now();

    const joinedUsers = membershipSummary.joinedUsers;
    const leftUsers = membershipSummary.leftUsers;
    const activityFeedStartedAtMs = Date.now();
    const activityFeed = includeActivityPreview
      ? await this.getMembershipActivityFeedPage(
          chatId,
          from,
          now,
          {
            range,
            filter: 'all',
            limit: MEMBERSHIP_ACTIVITY_PAGE_LIMIT,
          },
          'chat',
          { allowRemoteLookup: false },
        )
      : this.buildEmptyMembershipActivityPage();
    const activityFeedFinishedAtMs = Date.now();
    const response: LogsDashboardResponse = {
      chat: {
        id: chatId,
        title: chat?.title?.trim() || 'Чат без названия',
        participantsCount:
          typeof chatHeader?.participantsCount === 'number' &&
          Number.isFinite(chatHeader.participantsCount)
            ? Math.max(0, Math.trunc(chatHeader.participantsCount))
            : null,
        avatarUrl: chatHeader?.avatarUrl?.trim() || null,
      },
      period: {
        range,
        from: from.toISOString(),
        to: now.toISOString(),
      },
      membership: {
        joinedUsers,
        leftUsers,
        netUsers: joinedUsers - leftUsers,
      },
      violationsSummary: {
        warn: moderationSummary.warn,
        deleteMessage: moderationSummary.deleteMessage,
        mute: moderationSummary.mute,
        ban: moderationSummary.ban,
        unmute: moderationSummary.unmute,
        unban: moderationSummary.unban,
        affectedUsers: moderationSummary.affectedUsers,
        total:
          moderationSummary.warn +
          moderationSummary.deleteMessage +
          moderationSummary.mute +
          moderationSummary.ban +
          moderationSummary.unmute +
          moderationSummary.unban,
      },
      violations: moderationFeed.items,
      moderationFeed,
      activityFeed,
    };

    const finishedAtMs = Date.now();
    const totalMs = finishedAtMs - startedAtMs;
    if (totalMs >= SLOW_LOGS_DASHBOARD_THRESHOLD_MS) {
      this.logger.warn(
        {
          chatId,
          totalMs,
          range,
          includeActivityPreview,
          includeModerationPreview,
          baseQueriesMs: baseQueriesFinishedAtMs - baseQueriesStartedAtMs,
          activityFeedMs: activityFeedFinishedAtMs - activityFeedStartedAtMs,
          moderationPreviewCount: moderationFeed.items.length,
          activityPreviewCount: activityFeed.items.length,
        },
        'Slow logs dashboard build completed',
      );
    }

    return logsDashboardResponseSchema.parse(response);
  }

  async getChatActivityFeed(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<MembershipActivityPage> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const parsed = membershipActivityQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const now = new Date();
    const from = this.resolveLogsDashboardFrom(parsed.data.range, now);
    return this.getCachedMembershipActivityFeedPage(
      chatId,
      user.userId,
      from,
      now,
      parsed.data,
      'chat',
      { allowRemoteLookup: false },
    );
  }

  async getChatModerationFeed(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ModerationFeedPage> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const parsed = moderationFeedQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const now = new Date();
    const from = this.resolveLogsDashboardFrom(parsed.data.range, now);
    return this.getCachedModerationFeedPage(chatId, user.userId, from, now, parsed.data, 'chat', {
      allowRemoteLookup: false,
    });
  }

  async getChatParticipantsPage(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ChatParticipantsPage> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const parsed = chatParticipantsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    return this.getCachedChatParticipantsPage(chatId, user.userId, parsed.data, 'chat');
  }

  async updateChatParticipantImmunity(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ChatParticipantImmunityUpdateResult> {
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const targetUserId = await this.prepareManualModerationTarget(chatId, targetUserIdRaw, user);
    const parsed = chatParticipantImmunityUpdateRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    if (!parsed.data.enabled) {
      await this.prisma.chatParticipantModerationImmunity.deleteMany({
        where: {
          chatId,
          userId: targetUserId,
        },
      });

      this.invalidateChatParticipantsPageCache(chatId);
      return chatParticipantImmunityUpdateResultSchema.parse({
        immunity: null,
        message: 'Иммунитет снят.',
      });
    }

    const participantLookupBotId = await this.resolveBackgroundReadBotAssignment(chatId);
    await this.assertTargetUserCanReceiveParticipantImmunity(
      chatId,
      targetUserId,
      participantLookupBotId,
    );

    const [settings, now] = await Promise.all([
      this.prisma.chatSettings.findUnique({
        where: { chatId },
        select: { nightModeTimezone: true },
      }),
      Promise.resolve(new Date()),
    ]);
    const timeZone = this.normalizeParticipantImmunityTimezone(settings?.nightModeTimezone ?? null);
    const usageDateKey = this.formatParticipantImmunityDateKey(now, timeZone);
    const expiresAt = new Date(now.getTime() + parsed.data.durationHours! * ONE_HOUR_MS);
    const immunity = await this.prisma.chatParticipantModerationImmunity.upsert({
      where: {
        chatId_userId: {
          chatId,
          userId: targetUserId,
        },
      },
      create: {
        chatId,
        userId: targetUserId,
        expiresAt,
        dailyViolationLimit: parsed.data.dailyViolationLimit!,
        dailyViolationUsage: 0,
        usageDateKey,
        createdByUserId: user.userId,
        updatedByUserId: user.userId,
      },
      update: {
        expiresAt,
        dailyViolationLimit: parsed.data.dailyViolationLimit!,
        dailyViolationUsage: 0,
        usageDateKey,
        updatedByUserId: user.userId,
      },
    });

    this.invalidateChatParticipantsPageCache(chatId);
    return chatParticipantImmunityUpdateResultSchema.parse({
      immunity: this.buildChatParticipantImmunitySummary(immunity, now, timeZone),
      message: 'Иммунитет обновлён.',
    });
  }

  async applyManualModerationAction(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
    options: ManualModerationExecutionOptions = {},
  ): Promise<ManualModerationActionResult> {
    const targetUserId = await this.prepareManualModerationTarget(chatId, targetUserIdRaw, user, {
      skipActorAdminCheck: options.actorAlreadyVerified === true,
    });

    const parsed = manualModerationActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const resolvedBotId = await this.resolveManualModerationActionBotAssignment(
      chatId,
      this.resolveManualModerationBotAction(parsed.data.action),
      {
        preferredBotId: options.preferredBotId,
      },
    );
    const targetDisplayName =
      this.readTrimmedString(options.targetDisplayNameHint) ??
      (await this.resolveManualModerationTargetDisplayName(chatId, targetUserId, {
        botId: resolvedBotId,
        allowRemoteLookup:
          options.allowTargetDisplayNameRemoteLookup ?? parsed.data.action !== 'UNBAN',
      }));

    const metadataBase = {
      source,
      initiatedByUserId: user.userId,
    } as const;
    const shouldFanoutCommandMute = source === 'group_command' || source === 'private_command';

    if (parsed.data.action === 'MUTE') {
      const mutePermanent = parsed.data.mutePermanent === true;
      const muteDurationHours = parsed.data.muteDurationHours ?? null;
      if (!mutePermanent && !muteDurationHours) {
        throw new BadRequestException('Укажите длительность мута в часах.');
      }

      await this.assertManualMemberModerationPreconditions(
        chatId,
        targetUserId,
        'MUTE',
        resolvedBotId,
      );
      const muteExpiresAt = mutePermanent
        ? null
        : new Date(Date.now() + muteDurationHours! * ONE_HOUR_MS);
      const { sourceMessageCleanup, crossChatMuteFanout } = shouldFanoutCommandMute
        ? await this.resolveManualMuteCommandFollowUpSummaries({
            sourceChatId: chatId,
            targetUserId,
            actor: user,
            muteDurationHours,
            muteExpiresAt,
            mutePermanent,
            source,
          })
        : {
            sourceMessageCleanup: this.summarizeManualModerationCleanup({
              candidateMessageIds: [],
              deletedMessageIds: [],
              failedMessageIds: [],
            }),
            crossChatMuteFanout: this.summarizeManualMuteFanout({
              mutedChatIds: [],
              skippedChatIds: [],
              failedChatIds: [],
            }),
          };

      await this.recordManualModerationAction({
        chatId,
        targetUserId,
        targetDisplayName,
        actorUserId: user.userId,
        ruleCode: 'MANUAL_MUTE',
        sanctionAction: SanctionAction.MUTE,
        auditAction: 'MANUAL_MUTE_MEMBER',
        metadata: {
          ...metadataBase,
          reason: `Ручной мут участника ${this.describeManualModerationActionSource(source)}`,
          ...this.buildManualMuteMetadataFields({
            muteDurationHours,
            muteExpiresAt,
            mutePermanent,
          }),
          ...(shouldFanoutCommandMute
            ? {
                sourceMessageCleanup,
                crossChatMuteFanout,
              }
            : {}),
        },
        auditPayload: {
          userId: targetUserId,
          source,
          ...this.buildManualMuteMetadataFields({
            muteDurationHours,
            muteExpiresAt,
            mutePermanent,
          }),
          ...(shouldFanoutCommandMute
            ? {
                sourceMessageCleanup,
                crossChatMuteFanout,
              }
            : {}),
        },
      });

      return manualModerationActionResultSchema.parse({
        ok: true,
        action: 'MUTE',
        userId: targetUserId,
        muteDurationHours,
        muteExpiresAt: muteExpiresAt ? muteExpiresAt.toISOString() : null,
        message: mutePermanent ? 'Мут бессрочно.' : `Мут на ${muteDurationHours}ч.`,
      });
    }

    if (parsed.data.action === 'BAN') {
      let executionMode: ManualBanExecutionMode;
      try {
        await this.assertManualMemberModerationPreconditions(
          chatId,
          targetUserId,
          'BAN',
          resolvedBotId,
        );
        executionMode = await this.resolveManualBanExecutionMode(chatId, resolvedBotId);
      } catch (error: unknown) {
        this.throwManualModerationTransientMaxError(error);
        throw error;
      }

      try {
        try {
          if (resolvedBotId) {
            await this.maxClient.cancelScheduledUnban(chatId, targetUserId, {
              botId: resolvedBotId,
            });
          } else {
            await this.maxClient.cancelScheduledUnban(chatId, targetUserId);
          }
        } catch (cancelError: unknown) {
          this.logger.warn(
            {
              chatId,
              userId: targetUserId,
              err: cancelError instanceof Error ? cancelError.message : String(cancelError),
            },
            'Failed to cancel scheduled auto-unban before manual ban',
          );
        }

        if (executionMode === 'MAX_REMOVE_ONLY') {
          await this.maxClient.kickMember(chatId, targetUserId, {
            immediate: true,
            ...(resolvedBotId ? { botId: resolvedBotId } : {}),
          });
        } else {
          await this.maxClient.banMember(chatId, targetUserId, {
            immediate: true,
            ...(resolvedBotId ? { botId: resolvedBotId } : {}),
          });
        }
      } catch (error: unknown) {
        this.throwManualModerationTransientMaxError(error);
        const resolvedMessage = await this.resolveManualMemberModerationErrorMessage(
          chatId,
          targetUserId,
          'BAN',
          error,
          resolvedBotId,
        );
        throw new BadRequestException(resolvedMessage || 'Не удалось применить бан.');
      }

      await this.deleteAdminGlobalSpammerExemption(user.userId, targetUserId);
      await this.globalSpammerIntelligence?.recordManualBanObservation({
        chatId,
        targetUserId,
        actorUserId: user.userId,
        source,
        executionMode,
      });
      const shouldFanoutMiniappBan = source === 'miniapp';
      const { sourceMessageCleanup, crossChatFanout } = shouldFanoutMiniappBan
        ? await this.resolveManualBanFollowUpSummaries({
            sourceChatId: chatId,
            targetUserId,
            actor: user,
            source,
          })
        : {
            sourceMessageCleanup: this.summarizeManualModerationCleanup({
              candidateMessageIds: [],
              deletedMessageIds: [],
              failedMessageIds: [],
            }),
            crossChatFanout: this.summarizeManualBanFanout({
              removedChatIds: [],
              skippedChatIds: [],
              failedChatIds: [],
              deletedMessageCount: 0,
              failedMessageDeleteCount: 0,
            }),
          };

      await this.recordManualModerationAction({
        chatId,
        targetUserId,
        targetDisplayName,
        actorUserId: user.userId,
        ruleCode: 'MANUAL_BAN',
        sanctionAction: SanctionAction.BAN,
        auditAction: 'MANUAL_BAN_MEMBER',
        metadata: {
          ...metadataBase,
          reason: `Ручной бан участника ${this.describeManualModerationActionSource(source)}`,
          mode: executionMode,
          permanent: true,
          ...(shouldFanoutMiniappBan
            ? {
                sourceMessageCleanup,
                crossChatFanout,
              }
            : {}),
        },
        auditPayload: {
          userId: targetUserId,
          source,
          mode: executionMode,
          permanent: true,
          ...(shouldFanoutMiniappBan
            ? {
                sourceMessageCleanup,
                crossChatFanout,
              }
            : {}),
        },
      });
      await this.sendManualBanChatNotice({
        chatId,
        targetUserId,
        source,
        removedOnly: executionMode === 'MAX_REMOVE_ONLY',
        botId: resolvedBotId,
      });

      return manualModerationActionResultSchema.parse({
        ok: true,
        action: 'BAN',
        userId: targetUserId,
        muteDurationHours: null,
        muteExpiresAt: null,
        message:
          executionMode === 'MAX_REMOVE_ONLY' ? 'Пользователь удалён.' : 'Пользователь забанен.',
      });
    }

    if (parsed.data.action === 'UNMUTE') {
      await this.resetDuplicateModerationState(chatId, targetUserId);

      await this.recordManualModerationAction({
        chatId,
        targetUserId,
        targetDisplayName,
        actorUserId: user.userId,
        ruleCode: 'MANUAL_UNMUTE',
        sanctionAction: SanctionAction.NONE,
        auditAction: 'MANUAL_UNMUTE_MEMBER',
        metadata: {
          ...metadataBase,
          reason: `Ручное снятие мута участника ${this.describeManualModerationActionSource(source)}`,
        },
        auditPayload: {
          userId: targetUserId,
          source,
        },
      });

      return manualModerationActionResultSchema.parse({
        ok: true,
        action: 'UNMUTE',
        userId: targetUserId,
        muteDurationHours: null,
        muteExpiresAt: null,
        message: 'Мут снят. Новые сообщения больше не будут удаляться автоматически.',
      });
    }

    if (resolvedBotId) {
      await this.maxClient.cancelScheduledUnban(chatId, targetUserId, {
        botId: resolvedBotId,
      });
    } else {
      await this.maxClient.cancelScheduledUnban(chatId, targetUserId);
    }

    let unbanMode = await this.resolveManualUnbanExecutionMode(chatId, targetUserId, resolvedBotId);
    if (unbanMode !== 'ALREADY_PRESENT') {
      try {
        await this.assertBotCanManageMembers(chatId, 'UNBAN', resolvedBotId);
      } catch (error: unknown) {
        this.throwManualModerationTransientMaxError(error);
        throw error;
      }
      try {
        await this.maxClient.unbanMember(chatId, targetUserId, {
          immediate: true,
          ...(resolvedBotId ? { botId: resolvedBotId } : {}),
        });
      } catch (error: unknown) {
        this.throwManualModerationTransientMaxError(error);
        const maxApiMessage = this.extractMaxApiErrorMessage(error);
        if (this.isAlreadyPresentMemberAddError(maxApiMessage)) {
          unbanMode = 'ALREADY_PRESENT';
        } else {
          const resolvedMessage = await this.resolveManualMemberUnbanErrorMessage(
            chatId,
            targetUserId,
            error,
            resolvedBotId,
          );
          throw new BadRequestException(
            resolvedMessage ||
              'MAX отклонил возврат участника в чат. Проверьте тип чата, статус цели и права бота.',
          );
        }
      }
    }

    await this.upsertAdminGlobalSpammerExemption(user.userId, targetUserId, chatId);
    await this.resetDuplicateModerationState(chatId, targetUserId);

    await this.recordManualModerationAction({
      chatId,
      targetUserId,
      targetDisplayName,
      actorUserId: user.userId,
      ruleCode: 'MANUAL_UNBAN',
      sanctionAction: SanctionAction.NONE,
      auditAction: 'MANUAL_UNBAN_MEMBER',
      metadata: {
        ...metadataBase,
        reason: `Ручной разбан участника ${this.describeManualModerationActionSource(source)}`,
        mode: unbanMode,
      },
      auditPayload: {
        userId: targetUserId,
        source,
        mode: unbanMode,
      },
    });

    return manualModerationActionResultSchema.parse({
      ok: true,
      action: 'UNBAN',
      userId: targetUserId,
      muteDurationHours: null,
      muteExpiresAt: null,
      message:
        unbanMode === 'ALREADY_PRESENT'
          ? 'Блокировка снята. Участник уже состоит в чате, повторное добавление не потребовалось.'
          : 'Участник возвращён в чат и разблокирован.',
    });
  }

  private describeManualModerationActionSource(source: AdminActionSource): string {
    switch (source) {
      case 'private_command':
        return 'через команду в личке';
      case 'group_command':
        return 'через команду в чате';
      case 'private_bot':
        return 'через личный бот';
      default:
        return 'через miniapp';
    }
  }

  private buildManualMuteMetadataFields(params: {
    muteDurationHours: number | null;
    muteExpiresAt: Date | null;
    mutePermanent: boolean;
  }): {
    muteDurationHours: number | null;
    muteExpiresAt: string | null;
    mutePermanent: boolean;
  } {
    return {
      muteDurationHours: params.mutePermanent ? null : params.muteDurationHours,
      muteExpiresAt: params.muteExpiresAt ? params.muteExpiresAt.toISOString() : null,
      mutePermanent: params.mutePermanent,
    };
  }

  async applyManualSystemBan(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    source: Extract<AdminActionSource, 'group_command' | 'private_command'> = 'group_command',
    options: ManualModerationExecutionOptions = {},
  ): Promise<ManualModerationActionResult> {
    const targetUserId = await this.prepareManualModerationTarget(chatId, targetUserIdRaw, user, {
      skipActorAdminCheck: options.actorAlreadyVerified === true,
    });
    const resolvedBotId = await this.resolveManualModerationActionBotAssignment(
      chatId,
      'moderate_member',
      {
        preferredBotId: options.preferredBotId,
      },
    );
    const targetDisplayName =
      this.readTrimmedString(options.targetDisplayNameHint) ??
      (await this.resolveManualModerationTargetDisplayName(chatId, targetUserId, {
        botId: resolvedBotId,
        allowRemoteLookup: options.allowTargetDisplayNameRemoteLookup,
      }));
    let executionMode: ManualBanExecutionMode = 'MAX_BLOCK';
    try {
      await this.assertManualMemberModerationPreconditions(
        chatId,
        targetUserId,
        'BAN',
        resolvedBotId,
      );
      executionMode = await this.resolveManualBanExecutionMode(chatId, resolvedBotId);
    } catch (error: unknown) {
      this.throwManualModerationTransientMaxError(error);
      throw error;
    }

    try {
      if (resolvedBotId) {
        await this.maxClient.cancelScheduledUnban(chatId, targetUserId, {
          botId: resolvedBotId,
        });
      } else {
        await this.maxClient.cancelScheduledUnban(chatId, targetUserId);
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId: targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to cancel scheduled auto-unban before permanent manual ban',
      );
    }

    try {
      if (executionMode === 'MAX_REMOVE_ONLY') {
        await this.maxClient.kickMember(chatId, targetUserId, {
          immediate: true,
          ...(resolvedBotId ? { botId: resolvedBotId } : {}),
        });
      } else {
        await this.maxClient.banMember(chatId, targetUserId, {
          immediate: true,
          ...(resolvedBotId ? { botId: resolvedBotId } : {}),
        });
      }
    } catch (error: unknown) {
      this.throwManualModerationTransientMaxError(error);
      const resolvedMessage = await this.resolveManualMemberModerationErrorMessage(
        chatId,
        targetUserId,
        'BAN',
        error,
        resolvedBotId,
      );
      throw new BadRequestException(resolvedMessage || 'Не удалось применить системный бан.');
    }

    await this.deleteAdminGlobalSpammerExemption(user.userId, targetUserId);
    await this.globalSpammerIntelligence?.recordManualBanObservation({
      chatId,
      targetUserId,
      actorUserId: user.userId,
      source,
      executionMode,
    });

    let recentMessageCleanup = this.summarizeManualModerationCleanup({
      candidateMessageIds: [],
      deletedMessageIds: [],
      failedMessageIds: [],
    });
    let crossChatFanout = this.summarizeManualBanFanout({
      removedChatIds: [],
      skippedChatIds: [],
      failedChatIds: [],
      deletedMessageCount: 0,
      failedMessageDeleteCount: 0,
    });

    if (source === 'group_command' || source === 'private_command') {
      const followUp = await this.resolveManualBanFollowUpSummaries({
        sourceChatId: chatId,
        targetUserId,
        actor: user,
        source,
      });
      recentMessageCleanup = followUp.sourceMessageCleanup;
      crossChatFanout = followUp.crossChatFanout;
    }

    await this.recordManualModerationAction({
      chatId,
      targetUserId,
      targetDisplayName,
      actorUserId: user.userId,
      ruleCode: 'MANUAL_BAN',
      sanctionAction: SanctionAction.BAN,
      auditAction: 'MANUAL_BAN_MEMBER',
      metadata: {
        source,
        initiatedByUserId: user.userId,
        reason:
          source === 'group_command'
            ? 'Постоянный ручной бан участника через команду в чате'
            : 'Постоянный ручной бан участника через команду в личке',
        mode: executionMode,
        recentMessageCleanup,
        crossChatFanout,
      },
      auditPayload: {
        userId: targetUserId,
        source,
        permanent: true,
        mode: executionMode,
        recentMessageCleanup,
        crossChatFanout,
      },
    });
    await this.sendManualBanChatNotice({
      chatId,
      targetUserId,
      source,
      removedOnly: executionMode === 'MAX_REMOVE_ONLY',
      botId: resolvedBotId,
    });

    return manualModerationActionResultSchema.parse({
      ok: true,
      action: 'BAN',
      userId: targetUserId,
      muteDurationHours: null,
      muteExpiresAt: null,
      message:
        executionMode === 'MAX_REMOVE_ONLY' ? 'Пользователь удалён.' : 'Пользователь забанен.',
    });
  }

  async enqueueManualGroupModerationCommand(params: {
    sourceChatId: string;
    commandBotId?: string | null;
    targetUserId: string;
    targetSenderName?: string | null;
    targetMessageId?: string | null;
    commandMessageId: string;
    actor: AuthUser;
    action: 'BAN' | 'MUTE';
    muteDurationHours?: number | null;
    mutePermanent?: boolean;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
  }): Promise<boolean> {
    const job = this.buildManualGroupModerationCommandJob(params);
    return this.enqueueManualModerationFanout(job);
  }

  private async sendManualBanChatNotice(params: {
    chatId: string;
    targetUserId: string;
    source: AdminActionSource;
    removedOnly: boolean;
    botId?: string;
  }): Promise<void> {
    if (params.source === 'group_command') {
      return;
    }

    const maxClientWithSendMessage = this.maxClient as MaxClientService & {
      sendMessage?: MaxClientService['sendMessage'];
    };
    if (typeof maxClientWithSendMessage.sendMessage !== 'function') {
      return;
    }

    const userMention = this.buildManualModerationUserMention(params.targetUserId);
    const text = params.removedOnly
      ? `Пользователь ${userMention} удалён из чата.`
      : `Пользователь ${userMention} забанен.`;

    try {
      await maxClientWithSendMessage.sendMessage(
        params.chatId,
        text,
        { textFormat: 'markdown' },
        {
          immediate: true,
          ...(params.botId ? { botId: params.botId } : {}),
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          userId: params.targetUserId,
          source: params.source,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to send manual ban notice message',
      );
    }
  }

  async processManualModerationFanoutJob(job: AdminManualFanoutJob): Promise<void> {
    if (job.kind === 'manual_group_moderation_command') {
      await this.processManualGroupModerationCommandJob(job);
      return;
    }

    if (job.kind === 'manual_mute_fanout') {
      if (job.cleanupSourceChatMessages) {
        await this.runDeferredManualModerationSourceCleanup(
          job.sourceChatId,
          job.targetUserId,
          job.actor.userId,
          'Failed to run deferred recent message cleanup after manual mute',
        );
      }
      await this.applyManualMuteFanout({
        sourceChatId: job.sourceChatId,
        targetUserId: job.targetUserId,
        actor: {
          userId: job.actor.userId,
          username: job.actor.username,
          displayName: job.actor.displayName,
          chatId: job.actor.chatId ?? undefined,
          chatTitle: job.actor.chatTitle ?? undefined,
        },
        muteDurationHours: job.muteDurationHours,
        muteExpiresAt: job.muteExpiresAt ? new Date(job.muteExpiresAt) : null,
        mutePermanent: job.mutePermanent === true,
        source: job.source,
      });
      return;
    }

    await this.runManualBanSourceCleanup(job.sourceChatId, job.targetUserId, job.actor.userId, {
      logMessage: 'Failed to run deferred recent message cleanup after manual system ban',
    });

    await this.applyManualSystemBanFanout({
      sourceChatId: job.sourceChatId,
      targetUserId: job.targetUserId,
      actor: {
        userId: job.actor.userId,
        username: job.actor.username,
        displayName: job.actor.displayName,
        chatId: job.actor.chatId ?? undefined,
        chatTitle: job.actor.chatTitle ?? undefined,
      },
    });
  }

  private async processManualGroupModerationCommandJob(
    job: AdminManualGroupModerationCommandJob,
  ): Promise<void> {
    const actor = this.buildManualFanoutActor(job.actor);
    const commandOptions: ManualModerationExecutionOptions = {
      actorAlreadyVerified: true,
      preferredBotId: job.commandBotId ?? null,
      targetDisplayNameHint: job.targetSenderName ?? null,
      allowTargetDisplayNameRemoteLookup: false,
    };
    let result: ManualModerationActionResult;
    try {
      result =
        job.action === 'BAN'
          ? await this.applyManualSystemBan(
              job.sourceChatId,
              job.targetUserId,
              actor,
              'group_command',
              commandOptions,
            )
          : await this.applyManualModerationAction(
              job.sourceChatId,
              job.targetUserId,
              actor,
              {
                action: 'MUTE',
                ...(job.mutePermanent === true
                  ? { mutePermanent: true }
                  : {
                      muteDurationHours:
                        job.muteDurationHours ?? DEFAULT_GROUP_COMMAND_MUTE_DURATION_HOURS,
                    }),
              },
              'group_command',
              commandOptions,
            );
    } catch (error: unknown) {
      this.logger.warn(
        {
          jobId: job.jobId,
          chatId: job.sourceChatId,
          actorUserId: job.actor.userId,
          targetUserId: job.targetUserId,
          err: this.extractManualGroupCommandErrorMessage(error),
        },
        'Failed to apply queued group admin moderation command',
      );

      if (this.shouldRetryManualGroupCommandSilently(error)) {
        throw error;
      }

      await this.sendManualGroupCommandNotice({
        chatId: job.sourceChatId,
        botId: job.commandBotId ?? undefined,
        text: `Не удалось применить ${job.action === 'BAN' ? 'бан' : 'мут'}: ${this.escapeMarkdownPlainText(
          this.extractManualGroupCommandErrorMessage(error),
        )}`,
        deleteBotMessagesEnabled: job.deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes: job.deleteBotMessagesDelayMinutes,
      });
      return;
    }

    await this.deleteManualGroupCommandTargetMessage(job);
    await this.deleteManualGroupCommandMessage(job.sourceChatId, job.commandMessageId, {
      botId: job.commandBotId ?? undefined,
    });

    const targetLabel = this.formatManualGroupCommandUserLabel(
      job.targetSenderName,
      job.targetUserId,
    );
    await this.sendManualGroupCommandNotice({
      chatId: job.sourceChatId,
      botId: job.commandBotId ?? undefined,
      text:
        job.action === 'BAN'
          ? `Пользователь ${targetLabel} ${
              result.message.toLowerCase().includes('удал') ? 'удалён' : 'забанен'
            }.`
          : `${result.message}\nПользователь: ${targetLabel}`,
      deleteBotMessagesEnabled: job.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: job.deleteBotMessagesDelayMinutes,
    });
  }

  private buildManualFanoutActor(actor: {
    userId: string;
    username: string | null;
    displayName: string | null;
    chatId?: string | null;
    chatTitle?: string | null;
  }): AuthUser {
    return {
      userId: actor.userId,
      username: actor.username,
      displayName: actor.displayName,
      chatId: actor.chatId ?? undefined,
      chatTitle: actor.chatTitle ?? undefined,
    };
  }

  private async deleteManualGroupCommandMessage(
    chatId: string,
    messageId: string,
    options: { botId?: string } = {},
  ): Promise<void> {
    try {
      await this.maxClient.deleteMessage(chatId, messageId, {
        immediate: true,
        trafficClass: 'interactive',
        ...(options.botId ? { botId: options.botId } : {}),
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          messageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to delete handled queued group admin command message',
      );
    }
  }

  private async deleteManualGroupCommandTargetMessage(
    job: AdminManualGroupModerationCommandJob,
  ): Promise<void> {
    if (!job.targetMessageId) {
      return;
    }

    try {
      await this.maxClient.deleteMessage(job.sourceChatId, job.targetMessageId, {
        immediate: true,
        trafficClass: 'interactive',
        ...(job.commandBotId ? { botId: job.commandBotId } : {}),
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: job.sourceChatId,
          targetUserId: job.targetUserId,
          targetMessageId: job.targetMessageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to delete handled queued group admin command target message',
      );
    }
  }

  private async sendManualGroupCommandNotice(params: {
    chatId: string;
    botId?: string;
    text: string;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
  }): Promise<void> {
    const dispatchOptions = this.buildManualGroupCommandNoticeDispatchOptions({
      deleteBotMessagesEnabled: params.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: params.deleteBotMessagesDelayMinutes,
      botId: params.botId,
    });

    try {
      await this.maxClient.sendMessage(
        params.chatId,
        params.text,
        { textFormat: 'markdown' },
        dispatchOptions,
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: params.chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to send manual group command notice',
      );
    }
  }

  private buildManualGroupCommandNoticeDispatchOptions(params: {
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    botId?: string;
  }): MaxActionDispatchOptions {
    const options: MaxActionDispatchOptions = {
      immediate: true,
      trafficClass: 'interactive',
    };
    if (params.botId) {
      options.botId = params.botId;
    }
    if (params.deleteBotMessagesEnabled) {
      options.autoDeleteDelayMs =
        normalizeDeleteBotMessagesDelayMinutes(params.deleteBotMessagesDelayMinutes) * 60 * 1_000;
    }
    return options;
  }

  private formatManualGroupCommandUserLabel(
    senderName: string | null | undefined,
    userId: string,
  ): string {
    const normalizedName =
      typeof senderName === 'string' ? senderName.replace(/\s+/g, ' ').trim() : '';
    const safeName = normalizedName ? this.escapeMarkdownPlainText(normalizedName) : 'Пользователь';
    const normalizedUserId = userId.trim();
    if (normalizedUserId) {
      return `[${safeName}](max://user/${encodeURIComponent(normalizedUserId)})`;
    }
    return `**${safeName}**`;
  }

  private extractManualGroupCommandErrorMessage(error: unknown): string {
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      if (typeof response === 'string' && response.trim()) {
        return response.trim();
      }
      if (response && typeof response === 'object') {
        const message = (response as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) {
          return message.trim();
        }
      }
    }

    return (
      this.extractMaxApiErrorMessage(error) ||
      this.extractHttpErrorMessage(error) ||
      (error instanceof Error ? error.message : 'Unknown error')
    );
  }

  private shouldRetryManualGroupCommandSilently(error: unknown): boolean {
    if (this.isManualModerationTransientMaxError(error)) {
      return true;
    }

    const message = this.extractManualGroupCommandErrorMessage(error).toLowerCase();
    return (
      message.includes('rate limit exceeded') ||
      message.includes('circuit breaker') ||
      message.includes('timeout') ||
      message.includes('временно огранич') ||
      message.includes('повторите попытку')
    );
  }

  private async resolveManualMuteCommandFollowUpSummaries(params: {
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    muteDurationHours: number | null;
    muteExpiresAt: Date | null;
    mutePermanent: boolean;
    source: Extract<AdminActionSource, 'group_command' | 'private_command'>;
  }): Promise<{
    sourceMessageCleanup: ReturnType<AdminService['summarizeManualModerationCleanup']>;
    crossChatMuteFanout: ReturnType<AdminService['summarizeManualMuteFanout']>;
  }> {
    const queuedJob = this.buildManualMuteFanoutJob({
      ...params,
      cleanupSourceChatMessages: true,
    });
    if (await this.enqueueManualModerationFanout(queuedJob)) {
      return {
        sourceMessageCleanup: this.buildQueuedManualModerationCleanupSummary(queuedJob.jobId),
        crossChatMuteFanout: this.buildQueuedManualMuteFanoutSummary(queuedJob.jobId),
      };
    }

    let sourceCleanup = {
      candidateMessageIds: [] as string[],
      deletedMessageIds: [] as string[],
      failedMessageIds: [] as string[],
    };
    try {
      sourceCleanup = await this.deleteRecentTrackedMessagesForManualAction(
        params.sourceChatId,
        params.targetUserId,
        {
          botId: await this.resolveManualModerationActionBotAssignment(
            params.sourceChatId,
            'delete_message',
          ),
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.sourceChatId,
          targetUserId: params.targetUserId,
          actorUserId: params.actor.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to run recent message cleanup after manual mute',
      );
    }

    try {
      const fanout = await this.applyManualMuteFanout(params);
      return {
        sourceMessageCleanup: this.summarizeManualModerationCleanup(sourceCleanup),
        crossChatMuteFanout: this.summarizeManualMuteFanout(fanout),
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.sourceChatId,
          targetUserId: params.targetUserId,
          actorUserId: params.actor.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to run manual mute fanout after source chat mute',
      );
      return {
        sourceMessageCleanup: this.summarizeManualModerationCleanup(sourceCleanup),
        crossChatMuteFanout: this.summarizeManualMuteFanout({
          mutedChatIds: [],
          skippedChatIds: [],
          failedChatIds: [],
        }),
      };
    }
  }

  private async resolveManualBanFollowUpSummaries(params: {
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    source: ManualBanFollowUpSource;
  }): Promise<{
    sourceMessageCleanup: ReturnType<AdminService['summarizeManualModerationCleanup']>;
    crossChatFanout: ReturnType<AdminService['summarizeManualBanFanout']>;
  }> {
    const queuedJob = this.buildManualBanFanoutJob({
      sourceChatId: params.sourceChatId,
      targetUserId: params.targetUserId,
      actor: params.actor,
      source: params.source,
    });
    if (await this.enqueueManualModerationFanout(queuedJob)) {
      return {
        sourceMessageCleanup: this.buildQueuedManualModerationCleanupSummary(queuedJob.jobId),
        crossChatFanout: this.buildQueuedManualBanFanoutSummary(queuedJob.jobId),
      };
    }

    const sourceCleanup = await this.runManualBanSourceCleanup(
      params.sourceChatId,
      params.targetUserId,
      params.actor.userId,
    );

    return {
      sourceMessageCleanup: this.summarizeManualModerationCleanup(sourceCleanup),
      crossChatFanout: await this.runManualBanFanoutInlineSummary(params),
    };
  }

  private async resolveManualBanFanoutSummary(params: {
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    source: Extract<AdminActionSource, 'group_command' | 'private_command'>;
  }) {
    const queuedJob = this.buildManualBanFanoutJob(params);
    if (await this.enqueueManualModerationFanout(queuedJob)) {
      return this.buildQueuedManualBanFanoutSummary(queuedJob.jobId);
    }

    try {
      const fanout = await this.applyManualSystemBanFanout(params);
      return this.summarizeManualBanFanout(fanout);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.sourceChatId,
          targetUserId: params.targetUserId,
          actorUserId: params.actor.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to run manual system ban fanout after source chat ban',
      );
      return this.summarizeManualBanFanout({
        removedChatIds: [],
        skippedChatIds: [],
        failedChatIds: [],
        deletedMessageCount: 0,
        failedMessageDeleteCount: 0,
      });
    }
  }

  private buildManualGroupModerationCommandJob(params: {
    sourceChatId: string;
    commandBotId?: string | null;
    targetUserId: string;
    targetSenderName?: string | null;
    targetMessageId?: string | null;
    commandMessageId: string;
    actor: AuthUser;
    action: 'BAN' | 'MUTE';
    muteDurationHours?: number | null;
    mutePermanent?: boolean;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
  }): AdminManualGroupModerationCommandJob {
    return {
      kind: 'manual_group_moderation_command',
      jobId: this.buildManualGroupModerationCommandJobId(
        params.sourceChatId,
        params.commandMessageId,
        params.targetUserId,
        params.action,
      ),
      sourceChatId: params.sourceChatId,
      commandBotId: this.readTrimmedString(params.commandBotId),
      targetUserId: params.targetUserId,
      targetSenderName: params.targetSenderName ?? null,
      targetMessageId: params.targetMessageId ?? null,
      commandMessageId: params.commandMessageId,
      actor: {
        userId: params.actor.userId,
        username: params.actor.username ?? null,
        displayName: params.actor.displayName ?? null,
        chatId: params.actor.chatId ?? null,
        chatTitle: params.actor.chatTitle ?? null,
      },
      action: params.action,
      muteDurationHours: params.muteDurationHours ?? null,
      mutePermanent: params.mutePermanent === true,
      deleteBotMessagesEnabled: params.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: params.deleteBotMessagesDelayMinutes,
    };
  }

  private buildManualMuteFanoutJob(params: {
    sourceChatId: string;
    targetUserId: string;
    cleanupSourceChatMessages?: boolean;
    actor: AuthUser;
    muteDurationHours: number | null;
    muteExpiresAt: Date | null;
    mutePermanent: boolean;
    source: Extract<AdminActionSource, 'group_command' | 'private_command'>;
  }): AdminManualMuteFanoutJob {
    return {
      kind: 'manual_mute_fanout',
      jobId: this.buildManualModerationFanoutJobId(
        'manual_mute_fanout',
        params.sourceChatId,
        params.targetUserId,
        params.source,
      ),
      sourceChatId: params.sourceChatId,
      targetUserId: params.targetUserId,
      cleanupSourceChatMessages: params.cleanupSourceChatMessages,
      actor: {
        userId: params.actor.userId,
        username: params.actor.username ?? null,
        displayName: params.actor.displayName ?? null,
        chatId: params.actor.chatId ?? null,
        chatTitle: params.actor.chatTitle ?? null,
      },
      muteDurationHours: params.muteDurationHours,
      muteExpiresAt: params.muteExpiresAt ? params.muteExpiresAt.toISOString() : null,
      mutePermanent: params.mutePermanent,
      source: params.source,
    };
  }

  private buildManualGroupModerationCommandJobId(
    sourceChatId: string,
    commandMessageId: string,
    targetUserId: string,
    action: 'BAN' | 'MUTE',
  ): string {
    const digest = createHash('sha256')
      .update(`${sourceChatId}\n${commandMessageId}\n${targetUserId}\n${action}`)
      .digest('hex')
      .slice(0, 32);
    return `manual_group_moderation_command__${digest}`;
  }

  private buildQueuedManualModerationCleanupSummary(jobId: string) {
    return {
      mode: 'queued',
      jobId,
      candidateCount: 0,
      deletedCount: 0,
      failedCount: 0,
    };
  }

  private buildManualBanFanoutJob(params: {
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    source: ManualBanFollowUpSource;
  }): AdminManualBanFanoutJob {
    return {
      kind: 'manual_ban_fanout',
      jobId: this.buildManualModerationFanoutJobId(
        'manual_ban_fanout',
        params.sourceChatId,
        params.targetUserId,
        params.source,
      ),
      sourceChatId: params.sourceChatId,
      targetUserId: params.targetUserId,
      actor: {
        userId: params.actor.userId,
        username: params.actor.username ?? null,
        displayName: params.actor.displayName ?? null,
        chatId: params.actor.chatId ?? null,
        chatTitle: params.actor.chatTitle ?? null,
      },
      source: params.source,
    };
  }

  private buildManualModerationFanoutJobId(
    kind: AdminManualFanoutJob['kind'],
    sourceChatId: string,
    targetUserId: string,
    source: Extract<AdminActionSource, 'miniapp' | 'group_command' | 'private_command'>,
  ): string {
    return `${kind}__${source}__${sourceChatId}__${targetUserId}__${randomUUID()}`;
  }

  private async enqueueManualModerationFanout(job: AdminManualFanoutJob): Promise<boolean> {
    if (!this.adminManualFanoutQueue) {
      return false;
    }

    try {
      await this.adminManualFanoutQueue.add('execute-admin-manual-fanout', job, {
        jobId: job.jobId,
        priority: this.resolveManualModerationFanoutQueuePriority(job),
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 1_000,
        },
      });
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          jobId: job.jobId,
          kind: job.kind,
          sourceChatId: job.sourceChatId,
          targetUserId: job.targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to enqueue manual moderation fanout',
      );
      return false;
    }
  }

  private resolveManualModerationFanoutQueuePriority(job: AdminManualFanoutJob): number {
    return job.kind === 'manual_group_moderation_command'
      ? ADMIN_MANUAL_GROUP_COMMAND_QUEUE_PRIORITY
      : ADMIN_MANUAL_FANOUT_QUEUE_PRIORITY;
  }

  private buildQueuedManualMuteFanoutSummary(jobId: string) {
    return {
      mode: 'queued',
      jobId,
      mutedChatsCount: 0,
      mutedChatIds: [] as string[],
      skippedChatsCount: 0,
      skippedChatIds: [] as string[],
      failedChatsCount: 0,
      failedChatIds: [] as string[],
    };
  }

  private buildQueuedManualBanFanoutSummary(jobId: string) {
    return {
      mode: 'queued',
      jobId,
      removedChatsCount: 0,
      removedChatIds: [] as string[],
      skippedChatsCount: 0,
      skippedChatIds: [] as string[],
      failedChatsCount: 0,
      failedChatIds: [] as string[],
      deletedMessageCount: 0,
      failedMessageDeleteCount: 0,
    };
  }

  private buildManualModerationUserMention(userId: string): string {
    const normalizedUserId = userId.trim();
    const label = this.escapeMarkdown(normalizedUserId || 'Пользователь');
    return `[${label}](max://user/${encodeURIComponent(normalizedUserId)})`;
  }

  private async runManualBanSourceCleanup(
    chatId: string,
    targetUserId: string,
    actorUserId: string,
    options: { logMessage?: string; botId?: string } = {},
  ): Promise<{
    candidateMessageIds: string[];
    deletedMessageIds: string[];
    failedMessageIds: string[];
  }> {
    return this.runDeferredManualModerationSourceCleanup(
      chatId,
      targetUserId,
      actorUserId,
      options.logMessage ?? 'Failed to run recent message cleanup after manual system ban',
      options.botId,
    );
  }

  private async runDeferredManualModerationSourceCleanup(
    chatId: string,
    targetUserId: string,
    actorUserId: string,
    logMessage: string,
    botId?: string,
  ): Promise<{
    candidateMessageIds: string[];
    deletedMessageIds: string[];
    failedMessageIds: string[];
  }> {
    try {
      return await this.deleteRecentTrackedMessagesForManualAction(chatId, targetUserId, {
        botId:
          botId ??
          (await this.resolveManualModerationActionBotAssignment(chatId, 'delete_message')),
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          targetUserId,
          actorUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        logMessage,
      );
      return {
        candidateMessageIds: [],
        deletedMessageIds: [],
        failedMessageIds: [],
      };
    }
  }

  private async runManualBanFanoutInlineSummary(params: {
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    source: ManualBanFollowUpSource;
  }) {
    try {
      const fanout = await this.applyManualSystemBanFanout(params);
      return this.summarizeManualBanFanout(fanout);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.sourceChatId,
          targetUserId: params.targetUserId,
          actorUserId: params.actor.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to run manual system ban fanout after source chat ban',
      );
      return this.summarizeManualBanFanout({
        removedChatIds: [],
        skippedChatIds: [],
        failedChatIds: [],
        deletedMessageCount: 0,
        failedMessageDeleteCount: 0,
      });
    }
  }

  private async applyManualMuteFanout(params: {
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    muteDurationHours: number | null;
    muteExpiresAt: Date | null;
    mutePermanent: boolean;
    source: Extract<AdminActionSource, 'group_command' | 'private_command'>;
  }): Promise<{
    mutedChatIds: string[];
    skippedChatIds: string[];
    failedChatIds: string[];
  }> {
    const {
      sourceChatId,
      targetUserId,
      actor,
      muteDurationHours,
      muteExpiresAt,
      mutePermanent,
      source,
    } = params;
    const targetDisplayName = await this.resolveManualModerationTargetDisplayName(
      sourceChatId,
      targetUserId,
      {
        allowRemoteLookup: false,
      },
    );
    const result = {
      mutedChatIds: [] as string[],
      skippedChatIds: [] as string[],
      failedChatIds: [] as string[],
    };
    const chats = await this.resolveManualCommandFanoutChats(actor, sourceChatId);

    for (const [index, chat] of chats.entries()) {
      if (index > 0) {
        await sleepIfNeeded(this.manualFanoutLookupSpacingMs);
      }

      const resolvedBotId = await this.resolveManualModerationActionBotAssignment(
        chat.id,
        'delete_message',
      );
      try {
        await this.assertBotCanDeleteMessages(chat.id, resolvedBotId);
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: chat.id,
            targetUserId,
            actorUserId: actor.userId,
            err: this.extractHttpErrorMessage(error) || String(error),
          },
          'Skipped manual mute fanout because the bot cannot delete messages in chat',
        );
        result.failedChatIds.push(chat.id);
        continue;
      }

      const targetState = await this.resolveManualFanoutTargetState(chat.id, targetUserId, {
        trafficClass: 'background',
        ...(resolvedBotId ? { botId: resolvedBotId } : {}),
      });
      if (targetState !== 'present') {
        result.skippedChatIds.push(chat.id);
        continue;
      }

      try {
        await this.recordManualModerationAction({
          chatId: chat.id,
          targetUserId,
          targetDisplayName,
          actorUserId: actor.userId,
          ruleCode: 'MANUAL_MUTE',
          sanctionAction: SanctionAction.MUTE,
          auditAction: 'MANUAL_MUTE_MEMBER',
          metadata: {
            source,
            initiatedByUserId: actor.userId,
            reason: `Ручной мут участника ${this.describeManualModerationActionSource(source)}`,
            ...this.buildManualMuteMetadataFields({
              muteDurationHours,
              muteExpiresAt,
              mutePermanent,
            }),
            sourceChatId,
            fanout: true,
          },
          auditPayload: {
            userId: targetUserId,
            source,
            ...this.buildManualMuteMetadataFields({
              muteDurationHours,
              muteExpiresAt,
              mutePermanent,
            }),
            sourceChatId,
            fanout: true,
          },
        });
        result.mutedChatIds.push(chat.id);
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: chat.id,
            targetUserId,
            actorUserId: actor.userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to apply manual mute fanout in managed chat',
        );
        result.failedChatIds.push(chat.id);
      }
    }

    return result;
  }

  private async applyManualSystemBanFanout(params: {
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
  }): Promise<{
    removedChatIds: string[];
    skippedChatIds: string[];
    failedChatIds: string[];
    deletedMessageCount: number;
    failedMessageDeleteCount: number;
  }> {
    const { sourceChatId, targetUserId, actor } = params;
    const result = {
      removedChatIds: [] as string[],
      skippedChatIds: [] as string[],
      failedChatIds: [] as string[],
      deletedMessageCount: 0,
      failedMessageDeleteCount: 0,
    };
    const chats = await this.resolveManualCommandFanoutChats(actor, sourceChatId);

    for (const [index, chat] of chats.entries()) {
      if (index > 0) {
        await sleepIfNeeded(this.manualFanoutLookupSpacingMs);
      }

      const resolvedBotId = await this.resolveManualModerationActionBotAssignment(
        chat.id,
        'moderate_member',
      );

      try {
        await this.assertBotCanManageMembers(chat.id, 'BAN', resolvedBotId);
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: chat.id,
            targetUserId,
            actorUserId: actor.userId,
            err: this.extractHttpErrorMessage(error) || String(error),
          },
          'Skipped manual ban fanout because the bot cannot manage members in chat',
        );
        result.failedChatIds.push(chat.id);
        continue;
      }

      const targetState = await this.resolveManualFanoutTargetState(chat.id, targetUserId, {
        trafficClass: 'background',
        ...(resolvedBotId ? { botId: resolvedBotId } : {}),
      });
      if (targetState !== 'present') {
        result.skippedChatIds.push(chat.id);
        continue;
      }

      try {
        if (resolvedBotId) {
          await this.maxClient.cancelScheduledUnban(chat.id, targetUserId, {
            botId: resolvedBotId,
          });
        } else {
          await this.maxClient.cancelScheduledUnban(chat.id, targetUserId);
        }
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: chat.id,
            targetUserId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to cancel scheduled auto-unban before manual ban fanout',
        );
      }

      try {
        await sleepIfNeeded(this.manualFanoutActionSpacingMs);
        const executionMode = await this.resolveManualBanExecutionMode(chat.id, resolvedBotId);
        if (executionMode === 'MAX_REMOVE_ONLY') {
          await this.maxClient.kickMember(chat.id, targetUserId, {
            immediate: true,
            ...(resolvedBotId ? { botId: resolvedBotId } : {}),
          });
        } else {
          await this.maxClient.banMember(chat.id, targetUserId, {
            immediate: true,
            ...(resolvedBotId ? { botId: resolvedBotId } : {}),
          });
        }
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: chat.id,
            targetUserId,
            actorUserId: actor.userId,
            err:
              this.extractMaxApiErrorMessage(error) ||
              this.extractHttpErrorMessage(error) ||
              String(error),
          },
          'Failed to apply manual ban fanout in managed chat',
        );
        result.failedChatIds.push(chat.id);
        continue;
      }

      const cleanup = await this.deleteRecentTrackedMessagesForManualAction(chat.id, targetUserId, {
        spacingMs: this.manualFanoutActionSpacingMs,
        botId: resolvedBotId,
      });
      result.removedChatIds.push(chat.id);
      result.deletedMessageCount += cleanup.deletedMessageIds.length;
      result.failedMessageDeleteCount += cleanup.failedMessageIds.length;
    }

    return result;
  }

  private async resolveManualCommandFanoutChats(
    actor: AuthUser,
    sourceChatId: string,
  ): Promise<ChatSummary[]> {
    const maxClientWithChatListing = this.maxClient as MaxClientService & {
      listBotChats?: MaxClientService['listBotChats'];
    };

    try {
      const chats =
        typeof maxClientWithChatListing.listBotChats === 'function'
          ? await this.listChatsForMassBroadcast(actor)
          : await this.listChatsFromAllowlist(actor.userId, 'chat');
      return chats.filter((chat) => chat.entityType === 'chat' && chat.id !== sourceChatId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          actorUserId: actor.userId,
          sourceChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve manual command fanout chats; falling back to allowlist cache',
      );
      const cached = await this.listChatsFromAllowlist(actor.userId, 'chat');
      return cached.filter((chat) => chat.id !== sourceChatId);
    }
  }

  private async resolveManualFanoutTargetState(
    chatId: string,
    targetUserId: string,
    requestOptions: {
      trafficClass?: 'critical' | 'interactive' | 'background';
      botId?: string;
    } = {},
  ): Promise<'present' | 'absent' | 'protected'> {
    const maxClientWithMemberAccess = this.maxClient as MaxClientService & {
      getChatMemberAccess?: (
        chatId: string,
        userId: string,
        options?: {
          trafficClass?: 'critical' | 'interactive' | 'background';
          botId?: string;
        },
      ) => Promise<MaxChatMemberAccess | null>;
    };
    if (typeof maxClientWithMemberAccess.getChatMemberAccess !== 'function') {
      return 'present';
    }

    try {
      const targetAccess = await maxClientWithMemberAccess.getChatMemberAccess(
        chatId,
        targetUserId,
        requestOptions,
      );
      if (!targetAccess) {
        return 'absent';
      }
      if (targetAccess.isOwner || targetAccess.isAdmin) {
        return 'protected';
      }
      return 'present';
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve target state for manual command fanout; will attempt action anyway',
      );
      return 'present';
    }
  }

  private async deleteRecentTrackedMessagesForManualAction(
    chatId: string,
    targetUserId: string,
    options: { spacingMs?: number; botId?: string } = {},
  ): Promise<{
    candidateMessageIds: string[];
    deletedMessageIds: string[];
    failedMessageIds: string[];
  }> {
    const candidateMessageIds = await this.findRecentTrackedMessageIdsForUser(chatId, targetUserId);
    const deletedMessageIds: string[] = [];
    const failedMessageIds: string[] = [];

    for (const [index, messageId] of candidateMessageIds.entries()) {
      if (index > 0) {
        await sleepIfNeeded(options.spacingMs ?? 0);
      }

      try {
        if (options.botId) {
          await this.maxClient.deleteMessage(chatId, messageId, {
            immediate: true,
            botId: options.botId,
          });
        } else {
          await this.maxClient.deleteMessage(chatId, messageId, { immediate: true });
        }
        deletedMessageIds.push(messageId);
      } catch (error: unknown) {
        if (this.isMaxMessageMissingError(error)) {
          deletedMessageIds.push(messageId);
          continue;
        }

        failedMessageIds.push(messageId);
        this.logger.warn(
          {
            chatId,
            targetUserId,
            messageId,
            err:
              this.extractMaxApiErrorMessage(error) ||
              this.extractHttpErrorMessage(error) ||
              String(error),
          },
          'Failed to delete tracked recent message during manual moderation cleanup',
        );
      }
    }

    return {
      candidateMessageIds,
      deletedMessageIds,
      failedMessageIds,
    };
  }

  private async findRecentTrackedMessageIdsForUser(
    chatId: string,
    targetUserId: string,
  ): Promise<string[]> {
    const normalizedChatId = chatId.trim();
    const normalizedTargetUserId = targetUserId.trim();
    if (!normalizedChatId || !normalizedTargetUserId) {
      return [];
    }

    const since = new Date(Date.now() - TWENTY_FOUR_HOURS_MS);
    const rows = await this.prisma.$queryRaw<Array<{ message_id: string | null }>>`
      SELECT message_id
      FROM (
        SELECT DISTINCT ON (message_id)
          message_id,
          message_created_at
        FROM (
          SELECT
            NULLIF(BTRIM(normalized_payload->'message'->>'messageId'), '') AS message_id,
            COALESCE(
              NULLIF(BTRIM(normalized_payload->'message'->>'createdAt'), '')::timestamptz,
              created_at
            ) AS message_created_at
          FROM webhook_events
          WHERE normalized_payload->>'type' = 'message_created'
            AND normalized_payload->'message'->>'senderId' = ${normalizedTargetUserId}
            AND normalized_payload->'message'->>'chatId' = ${normalizedChatId}
            AND created_at >= ${since}
        ) AS source_rows
        WHERE message_id IS NOT NULL
          AND message_created_at >= ${since}
        ORDER BY message_id, message_created_at DESC
      ) AS deduped_rows
      ORDER BY message_created_at DESC
      LIMIT ${MANUAL_BAN_RECENT_MESSAGE_DELETE_LIMIT}
    `;

    return Array.from(
      new Set(
        (Array.isArray(rows) ? rows : [])
          .map((row) => (typeof row.message_id === 'string' ? row.message_id.trim() : ''))
          .filter(Boolean),
      ),
    );
  }

  private summarizeManualModerationCleanup(result: {
    candidateMessageIds: string[];
    deletedMessageIds: string[];
    failedMessageIds: string[];
  }) {
    return {
      candidateCount: result.candidateMessageIds.length,
      deletedCount: result.deletedMessageIds.length,
      failedCount: result.failedMessageIds.length,
    };
  }

  private summarizeManualBanFanout(result: {
    removedChatIds: string[];
    skippedChatIds: string[];
    failedChatIds: string[];
    deletedMessageCount: number;
    failedMessageDeleteCount: number;
  }) {
    return {
      removedChatsCount: result.removedChatIds.length,
      removedChatIds: result.removedChatIds,
      skippedChatsCount: result.skippedChatIds.length,
      skippedChatIds: result.skippedChatIds,
      failedChatsCount: result.failedChatIds.length,
      failedChatIds: result.failedChatIds,
      deletedMessageCount: result.deletedMessageCount,
      failedMessageDeleteCount: result.failedMessageDeleteCount,
    };
  }

  private summarizeManualMuteFanout(result: {
    mutedChatIds: string[];
    skippedChatIds: string[];
    failedChatIds: string[];
  }) {
    return {
      mutedChatsCount: result.mutedChatIds.length,
      mutedChatIds: result.mutedChatIds,
      skippedChatsCount: result.skippedChatIds.length,
      skippedChatIds: result.skippedChatIds,
      failedChatsCount: result.failedChatIds.length,
      failedChatIds: result.failedChatIds,
    };
  }

  private async prepareManualModerationTarget(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    options: { skipActorAdminCheck?: boolean } = {},
  ): Promise<string> {
    if (options.skipActorAdminCheck !== true) {
      await this.assertChatAdmin(chatId, user.userId, null, {
        trafficClass: 'critical',
      });
    }
    const targetUserId = targetUserIdRaw.trim();
    if (!targetUserId) {
      throw new BadRequestException('User ID is required');
    }
    if (targetUserId === user.userId) {
      throw new BadRequestException('Нельзя применять это действие к своему аккаунту.');
    }

    return targetUserId;
  }

  private async assertManualMemberModerationPreconditions(
    chatId: string,
    targetUserId: string,
    action: ManualMemberModerationAction,
    botId?: string,
  ): Promise<void> {
    if (action === 'BAN') {
      await this.assertBotCanManageMembers(chatId, action, botId);
    } else {
      await this.assertBotCanDeleteMessages(chatId, botId);
    }
    await this.assertTargetUserCanBeModerated(chatId, targetUserId, action, botId);
  }

  private async assertBotCanManageMembers(
    chatId: string,
    action: ManualMemberManageMembersAction,
    botId?: string,
  ): Promise<void> {
    const maxClientWithAccess = this.maxClient as MaxClientService & {
      getCurrentChatMemberAccess?: (chatId: string) => Promise<MaxChatMemberAccess>;
    };
    if (typeof maxClientWithAccess.getCurrentChatMemberAccess !== 'function') {
      return;
    }

    let botAccess: MaxChatMemberAccess;
    try {
      botAccess = await maxClientWithAccess.getCurrentChatMemberAccess(chatId, {
        trafficClass: 'critical',
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        ...(botId ? { botId } : {}),
      } as never);
    } catch (error: unknown) {
      if (isBotAdminLookupDeniedError(error)) {
        throw new ForbiddenException(
          'Бот больше не состоит в этом чате MAX или не является его администратором.',
        );
      }
      throw error;
    }

    if (botAccess.isOwner) {
      return;
    }

    if (!botAccess.isAdmin) {
      throw new ForbiddenException(
        action === 'BAN'
          ? 'Бот должен быть администратором этого чата MAX, чтобы банить участников.'
          : action === 'UNBAN'
            ? 'Бот должен быть администратором этого чата MAX, чтобы возвращать участников.'
            : 'Бот должен быть администратором этого чата MAX, чтобы модерировать участников.',
      );
    }

    if (
      botAccess.permissions.length > 0 &&
      !botAccess.permissions.some((permission) => this.isAddRemoveMembersPermission(permission))
    ) {
      throw new ForbiddenException(
        action === 'BAN'
          ? 'У бота нет права MAX add_remove_members, поэтому он не может банить участников.'
          : action === 'UNBAN'
            ? 'У бота нет права MAX add_remove_members, поэтому он не может возвращать участников.'
            : 'У бота нет права MAX add_remove_members, поэтому он не может модерировать участников.',
      );
    }
  }

  private async assertBotCanDeleteMessages(chatId: string, botId?: string): Promise<void> {
    const maxClientWithAccess = this.maxClient as MaxClientService & {
      getCurrentChatMemberAccess?: MaxClientService['getCurrentChatMemberAccess'];
    };
    if (typeof maxClientWithAccess.getCurrentChatMemberAccess !== 'function') {
      return;
    }

    let botAccess: MaxChatMemberAccess;
    try {
      botAccess = await maxClientWithAccess.getCurrentChatMemberAccess(chatId, {
        trafficClass: 'critical',
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        ...(botId ? { botId } : {}),
      });
    } catch (error: unknown) {
      if (isBotAdminLookupDeniedError(error)) {
        throw new ForbiddenException(
          'Бот больше не состоит в этом чате MAX или не является его администратором.',
        );
      }
      throw error;
    }

    if (botAccess.isOwner) {
      return;
    }

    if (!botAccess.isAdmin) {
      throw new ForbiddenException(
        'Бот должен быть администратором этого чата MAX, чтобы удалять сообщения во время мута.',
      );
    }

    /*
     * MAX can omit delete_message from members/me for admins that are still able to
     * delete chat messages. Do not block manual mute on the incomplete granular
     * snapshot; active mute will exercise the real delete endpoint on new messages.
     */
  }

  private async assertTargetUserCanBeModerated(
    chatId: string,
    targetUserId: string,
    action: ManualMemberModerationAction,
    botId?: string,
  ): Promise<void> {
    const maxClientWithMemberAccess = this.maxClient as MaxClientService & {
      getChatMemberAccess?: (chatId: string, userId: string) => Promise<MaxChatMemberAccess | null>;
    };
    if (typeof maxClientWithMemberAccess.getChatMemberAccess !== 'function') {
      return;
    }

    const targetAccess = await maxClientWithMemberAccess.getChatMemberAccess(chatId, targetUserId, {
      trafficClass: 'critical',
      actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      ...(botId ? { botId } : {}),
    } as never);
    if (!targetAccess) {
      throw new BadRequestException('Пользователь уже не состоит в этом чате.');
    }

    if (targetAccess.isOwner || targetAccess.isAdmin) {
      throw new BadRequestException(
        action === 'BAN'
          ? 'Через бота нельзя забанить владельца или администратора чата.'
          : 'Через бота нельзя замьютить владельца или администратора чата.',
      );
    }
  }

  private async assertTargetUserCanReceiveParticipantImmunity(
    chatId: string,
    targetUserId: string,
    botId?: string,
  ): Promise<void> {
    const maxClientWithMemberAccess = this.maxClient as MaxClientService & {
      getChatMemberAccess?: (
        chatId: string,
        userId: string,
        options?: {
          actionHealthLane?: string;
          botId?: string;
          trafficClass?: 'critical' | 'interactive' | 'background';
          timeoutMs?: number;
        },
      ) => Promise<MaxChatMemberAccess | null>;
    };
    if (typeof maxClientWithMemberAccess.getChatMemberAccess !== 'function') {
      return;
    }

    const targetAccess = await maxClientWithMemberAccess.getChatMemberAccess(chatId, targetUserId, {
      actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      ...(botId ? { botId } : {}),
    });
    if (!targetAccess) {
      throw new BadRequestException('Пользователь уже не состоит в этом чате.');
    }

    if (targetAccess.isOwner || targetAccess.isAdmin) {
      throw new BadRequestException('Иммунитет можно выдать только обычному участнику.');
    }
  }

  private async resolveManualBanExecutionMode(
    chatId: string,
    botId?: string,
  ): Promise<ManualBanExecutionMode> {
    const maxClientWithSnapshot = this.maxClient as MaxClientService & {
      getChatSnapshot?: (
        chatId: string,
      ) => Promise<{ isPublic: boolean | null; link: string | null }>;
    };
    if (typeof maxClientWithSnapshot.getChatSnapshot !== 'function') {
      return 'MAX_BLOCK';
    }

    try {
      const snapshot = await maxClientWithSnapshot.getChatSnapshot(chatId, {
        trafficClass: 'critical',
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        ...(botId ? { botId } : {}),
      } as never);
      if (snapshot.isPublic === false && !snapshot.link) {
        return 'MAX_REMOVE_ONLY';
      }
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve chat visibility before manual ban',
      );
    }

    return 'MAX_BLOCK';
  }

  private async resolveManualUnbanExecutionMode(
    chatId: string,
    targetUserId: string,
    botId?: string,
  ): Promise<ManualUnbanExecutionMode> {
    const maxClientWithMemberAccess = this.maxClient as MaxClientService & {
      getChatMemberAccess?: (chatId: string, userId: string) => Promise<MaxChatMemberAccess | null>;
    };
    if (typeof maxClientWithMemberAccess.getChatMemberAccess !== 'function') {
      return 'MAX_UNBLOCK';
    }

    try {
      const targetAccess = await maxClientWithMemberAccess.getChatMemberAccess(
        chatId,
        targetUserId,
        {
          trafficClass: 'critical',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          ...(botId ? { botId } : {}),
        } as never,
      );
      return targetAccess ? 'ALREADY_PRESENT' : 'MAX_UNBLOCK';
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          userId: targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve target member state before manual unban',
      );
      return 'MAX_UNBLOCK';
    }
  }

  private isAlreadyPresentMemberAddError(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    return (
      (normalized.includes('already') &&
        (normalized.includes('member') || normalized.includes('participant'))) ||
      normalized.includes('уже состоит')
    );
  }

  private async resolveManualMemberModerationErrorMessage(
    chatId: string,
    targetUserId: string,
    action: ManualMemberModerationAction,
    error: unknown,
    botId?: string,
  ): Promise<string> {
    const maxApiMessage = this.extractMaxApiErrorMessage(error);
    if (!this.isAmbiguousMaxMemberModerationError(maxApiMessage)) {
      return maxApiMessage;
    }

    try {
      await this.assertBotCanManageMembers(chatId, action, botId);
    } catch (diagnosticError: unknown) {
      return this.extractHttpErrorMessage(diagnosticError) || maxApiMessage;
    }

    try {
      await this.assertTargetUserCanBeModerated(chatId, targetUserId, action, botId);
    } catch (diagnosticError: unknown) {
      return this.extractHttpErrorMessage(diagnosticError) || maxApiMessage;
    }

    return action === 'BAN'
      ? 'MAX отклонил бан участника. Проверьте тип чата, статус цели и права бота.'
      : 'MAX отклонил модерацию участника. Проверьте статус цели.';
  }

  private async resolveManualMemberUnbanErrorMessage(
    chatId: string,
    targetUserId: string,
    error: unknown,
    botId?: string,
  ): Promise<string> {
    const maxApiMessage = this.extractMaxApiErrorMessage(error);
    if (maxApiMessage && !this.isAmbiguousMaxMemberModerationError(maxApiMessage)) {
      return maxApiMessage;
    }

    try {
      await this.assertBotCanManageMembers(chatId, 'UNBAN', botId);
    } catch (diagnosticError: unknown) {
      return this.extractHttpErrorMessage(diagnosticError) || maxApiMessage;
    }

    if (maxApiMessage) {
      return maxApiMessage;
    }

    return 'MAX отклонил возврат участника в чат. Проверьте тип чата, статус цели и права бота.';
  }

  private throwManualModerationTransientMaxError(error: unknown): void {
    if (!this.isManualModerationTransientMaxError(error)) {
      return;
    }

    throw new ServiceUnavailableException(
      'MAX API временно занят. Действие не выполнено, повторите через несколько секунд.',
    );
  }

  private isManualModerationTransientMaxError(error: unknown): boolean {
    if (isMaxApiThrottleError(error) || isMaxApiTimeoutError(error)) {
      return true;
    }

    const message = (
      this.extractMaxApiErrorMessage(error) ||
      this.extractHttpErrorMessage(error) ||
      (error instanceof Error ? error.message : String(error))
    )
      .trim()
      .toLowerCase();

    return (
      message.includes('rate limit exceeded') ||
      message.includes('circuit breaker') ||
      message.includes('timeout') ||
      message.includes('временно огранич') ||
      (message.includes('max') && message.includes('повторите'))
    );
  }

  private isAmbiguousMaxMemberModerationError(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    return (
      normalized.includes('already been deleted') ||
      normalized.includes('do not have sufficient rights')
    );
  }

  private extractHttpErrorMessage(error: unknown): string {
    const response = (error as { response?: unknown })?.response;
    if (typeof response === 'string' && response.trim()) {
      return response.trim();
    }

    const responseMessage = (error as { response?: { message?: unknown } })?.response?.message;
    if (typeof responseMessage === 'string' && responseMessage.trim()) {
      return responseMessage.trim();
    }

    if (error instanceof Error && error.message.trim()) {
      return error.message.trim();
    }

    return '';
  }

  private isAddRemoveMembersPermission(permission: string): boolean {
    const normalized = permission
      .trim()
      .toLowerCase()
      .replace(/[-\s]+/gu, '_');
    return (
      normalized === 'add_remove_members' ||
      normalized === 'can_add_remove_members' ||
      normalized === 'remove_members' ||
      normalized === 'can_remove_members' ||
      normalized === 'manage_members' ||
      normalized === 'can_manage_members' ||
      normalized === 'kick_members' ||
      normalized === 'can_kick_members' ||
      normalized === 'ban_members' ||
      normalized === 'can_ban_members' ||
      normalized === 'ban_users' ||
      normalized === 'can_ban_users' ||
      normalized === 'delete_members' ||
      normalized === 'can_delete_members'
    );
  }

  private isDeleteMessagesPermission(permission: string): boolean {
    const normalized = permission
      .trim()
      .toLowerCase()
      .replace(/[-\s]+/gu, '_');
    return (
      normalized === 'delete_message' ||
      normalized === 'delete_messages' ||
      normalized === 'can_delete_message' ||
      normalized === 'can_delete_messages' ||
      normalized === 'message_delete' ||
      normalized === 'message_delete_any' ||
      normalized === 'messages_delete' ||
      normalized === 'post_delete' ||
      normalized === 'post_edit_delete_message' ||
      normalized === 'edit_delete_message' ||
      normalized === 'moderate_messages' ||
      normalized === 'can_moderate_messages'
    );
  }

  private normalizeStoredModerationUserId(value: string): string | null {
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  private async upsertAdminGlobalSpammerExemption(
    adminUserId: string,
    targetUserId: string,
    sourceChatId: string,
  ): Promise<void> {
    const normalizedAdminUserId = this.normalizeStoredModerationUserId(adminUserId);
    const normalizedTargetUserId = this.normalizeStoredModerationUserId(targetUserId);
    if (!normalizedAdminUserId || !normalizedTargetUserId) {
      return;
    }

    await this.prisma.adminGlobalSpammerExemption.upsert({
      where: {
        adminUserId_userId: {
          adminUserId: normalizedAdminUserId,
          userId: normalizedTargetUserId,
        },
      },
      create: {
        adminUserId: normalizedAdminUserId,
        userId: normalizedTargetUserId,
        sourceChatId,
        decision: 'ALLOW',
        reason: 'MANUAL_UNBAN',
      },
      update: {
        sourceChatId,
        decision: 'ALLOW',
        reason: 'MANUAL_UNBAN',
      },
    });

    await this.globalSpammerIntelligence?.recordLocalAdminDecision({
      chatId: sourceChatId,
      userId: normalizedTargetUserId,
      reviewerUserId: normalizedAdminUserId,
      decision: 'ALLOW',
      reason: 'MANUAL_UNBAN',
    });
  }

  private async deleteAdminGlobalSpammerExemption(
    adminUserId: string,
    targetUserId: string,
  ): Promise<void> {
    const normalizedAdminUserId = this.normalizeStoredModerationUserId(adminUserId);
    const normalizedTargetUserId = this.normalizeStoredModerationUserId(targetUserId);
    if (!normalizedAdminUserId || !normalizedTargetUserId) {
      return;
    }

    await this.prisma.adminGlobalSpammerExemption.deleteMany({
      where: {
        adminUserId: normalizedAdminUserId,
        userId: normalizedTargetUserId,
      },
    });
  }

  private async resetDuplicateModerationState(chatId: string, targetUserId: string): Promise<void> {
    const deleteKeysByPattern = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.deleteKeysByPattern;
    if (typeof deleteKeysByPattern !== 'function') {
      return;
    }

    try {
      await Promise.all([
        deleteKeysByPattern.call(
          this.redisCounter,
          buildDuplicateUserPattern(chatId, targetUserId),
        ),
        deleteKeysByPattern.call(
          this.redisCounter,
          buildModerationEscalationCounterPattern(chatId, targetUserId),
        ),
      ]);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId: targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to reset cached moderation state after manual release',
      );
    }
  }

  private async syncManualActiveMuteRuntimeState(params: {
    chatId: string;
    targetUserId: string;
    ruleCode: 'MANUAL_MUTE' | 'MANUAL_UNMUTE' | 'MANUAL_BAN' | 'MANUAL_UNBAN';
    metadata: Record<string, unknown>;
  }): Promise<void> {
    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (typeof setStringWithTtl !== 'function') {
      return;
    }

    const cacheKey = buildActiveMuteStateKey(params.chatId, params.targetUserId);
    if (params.ruleCode === 'MANUAL_MUTE') {
      const mutePermanent = params.metadata.mutePermanent === true;
      const muteDurationHours = params.metadata.muteDurationHours;
      const muteExpiresAt = params.metadata.muteExpiresAt;
      if (mutePermanent) {
        try {
          await setStringWithTtl.call(
            this.redisCounter,
            cacheKey,
            JSON.stringify({
              eventId: `manual:${params.chatId}:${params.targetUserId}:permanent:${Date.now()}`,
              issuedAt: new Date().toISOString(),
              expiresAt: null,
              durationHours: null,
              permanent: true,
            } satisfies CachedActiveMuteState),
            PERMANENT_ACTIVE_MUTE_CACHE_TTL_SEC,
          );
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId: params.chatId,
              userId: params.targetUserId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to cache permanent manual active mute runtime state',
          );
        }
        return;
      }

      const expiresAtMs =
        typeof muteExpiresAt === 'string' ? Date.parse(muteExpiresAt) : Number.NaN;
      if (
        typeof muteDurationHours !== 'number' ||
        !Number.isInteger(muteDurationHours) ||
        muteDurationHours < 1 ||
        !Number.isFinite(expiresAtMs)
      ) {
        return;
      }

      const ttlSec = Math.ceil((expiresAtMs - Date.now()) / 1_000) + ACTIVE_MUTE_CACHE_SLACK_SEC;
      if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
        return;
      }

      try {
        await setStringWithTtl.call(
          this.redisCounter,
          cacheKey,
          JSON.stringify({
            eventId: `manual:${params.chatId}:${params.targetUserId}:${expiresAtMs}`,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(expiresAtMs).toISOString(),
            durationHours: muteDurationHours,
            permanent: false,
          } satisfies CachedActiveMuteState),
          ttlSec,
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: params.chatId,
            userId: params.targetUserId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to cache manual active mute runtime state',
        );
      }
      return;
    }

    try {
      await setStringWithTtl.call(
        this.redisCounter,
        cacheKey,
        '0',
        ACTIVE_MUTE_NEGATIVE_CACHE_TTL_SEC,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          userId: params.targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to clear manual active mute runtime state',
      );
    }
  }

  private async recordManualModerationAction(params: {
    chatId: string;
    targetUserId: string;
    targetDisplayName?: string | null;
    actorUserId: string;
    ruleCode: 'MANUAL_MUTE' | 'MANUAL_UNMUTE' | 'MANUAL_BAN' | 'MANUAL_UNBAN';
    sanctionAction: SanctionAction;
    auditAction:
      | 'MANUAL_MUTE_MEMBER'
      | 'MANUAL_UNMUTE_MEMBER'
      | 'MANUAL_BAN_MEMBER'
      | 'MANUAL_UNBAN_MEMBER';
    metadata: Record<string, unknown>;
    auditPayload: Record<string, unknown>;
  }) {
    const {
      chatId,
      targetUserId,
      targetDisplayName,
      actorUserId,
      ruleCode,
      sanctionAction,
      auditAction,
      metadata,
      auditPayload,
    } = params;
    const eventMetadata = {
      ...metadata,
      ...(this.readTrimmedString(targetDisplayName)
        ? { targetDisplayName: this.readTrimmedString(targetDisplayName) }
        : {}),
    };

    await this.prisma.$transaction([
      this.prisma.moderationEvent.create({
        data: {
          chatId,
          userId: targetUserId,
          eventType: EventType.MEMBER_ACTION,
          ruleCode,
          action: sanctionAction,
          operator: Operator.ADMIN,
          metadata: eventMetadata as Prisma.InputJsonValue,
        },
      }),
      this.prisma.auditLog.create({
        data: {
          chatId,
          actorUserId,
          action: auditAction,
          payload: auditPayload as Prisma.InputJsonValue,
        },
      }),
    ]);
    await this.syncManualActiveMuteRuntimeState({
      chatId,
      targetUserId,
      ruleCode,
      metadata: eventMetadata,
    });
    this.invalidateLogsDashboardResponseCache(chatId);
    this.invalidateModerationFeedPageCache(chatId);
    this.invalidateChatParticipantsPageCache(chatId);
  }

  async getEvents(chatId: string, user: AuthUser, query: unknown): Promise<ModerationEvent[]> {
    const startedAtMs = Date.now();
    await this.assertChatAdmin(chatId, user.userId, null, {
      syncPersistedAccess: false,
    });
    const adminCheckedAtMs = Date.now();
    const parsed = dateRangeQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const from = parsed.data.from ? new Date(parsed.data.from) : undefined;
    const to = parsed.data.to ? new Date(parsed.data.to) : undefined;

    const rows = await this.prisma.moderationEvent.findMany({
      where: {
        chatId,
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      skip: (parsed.data.page - 1) * parsed.data.limit,
      take: parsed.data.limit,
    });
    const finishedAtMs = Date.now();
    const totalMs = finishedAtMs - startedAtMs;
    if (totalMs >= 1_500) {
      this.logger.warn(
        {
          chatId,
          userId: user.userId,
          totalMs,
          adminCheckMs: adminCheckedAtMs - startedAtMs,
          queryMs: finishedAtMs - adminCheckedAtMs,
          page: parsed.data.page,
          limit: parsed.data.limit,
        },
        'Slow moderation events query completed',
      );
    }

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chatId,
      userId: row.userId,
      eventType: row.eventType,
      ruleCode: row.ruleCode,
      action: row.action,
      maskedExcerpt: row.maskedExcerpt,
      score: row.score,
      metadata:
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : null,
      createdAt: row.createdAt.toISOString(),
      operator: row.operator,
    }));
  }

  async addAdmin(chatId: string, user: AuthUser, body: unknown) {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = addAdminRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const resolvedBotId = await this.resolveBotAssignment(chatId);

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Chat ${chatId}`,
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
      },
      update: this.buildResolvedBotAssignmentData(resolvedBotId),
    });

    await this.prisma.chatAdminAllowlist.upsert({
      where: {
        chatId_userId: {
          chatId,
          userId: parsed.data.userId,
        },
      },
      create: {
        chatId,
        userId: parsed.data.userId,
      },
      update: {},
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'ADD_ADMIN',
        payload: {
          userId: parsed.data.userId,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async removeAdmin(chatId: string, user: AuthUser, targetUserId: string) {
    await this.assertChatAdmin(chatId, user.userId);

    await this.prisma.chatAdminAllowlist.delete({
      where: {
        chatId_userId: {
          chatId,
          userId: targetUserId,
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'REMOVE_ADMIN',
        payload: {
          userId: targetUserId,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async getDomainAllowlist(chatId: string, user: AuthUser): Promise<string[]> {
    await this.assertChatAdmin(chatId, user.userId);

    const rows = await this.prisma.domainAllowlist.findMany({
      where: this.activeDomainWhere(chatId),
      orderBy: { domain: 'asc' },
      select: {
        domain: true,
        removeAfterAt: true,
      },
    });

    const normalizedRows = await this.canonicalizeActiveAllowlistRows(chatId, rows);

    return normalizedRows.map((row) => row.domain);
  }

  async getDomainAllowlistDetails(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<DomainAllowlistEntry[]> {
    if (!options.skipAdminCheck) {
      await this.assertChatAdmin(chatId, user.userId);
    }

    const rows = await this.prisma.domainAllowlist.findMany({
      where: this.activeDomainWhere(chatId),
      orderBy: [{ removeAfterAt: 'asc' }, { domain: 'asc' }],
      select: {
        domain: true,
        removeAfterAt: true,
      },
    });

    return this.canonicalizeActiveAllowlistRows(chatId, rows);
  }

  async addDomain(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ) {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = addDomainRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const matchType =
      parsed.data.matchType ??
      (source === 'private_bot' ? inferAllowlistMatchType(parsed.data.domain) : null) ??
      'EXACT';
    const normalized = normalizeStoredAllowlistEntry(parsed.data.domain, matchType);
    if (!normalized) {
      throw new BadRequestException('Invalid allowlist link');
    }
    const normalizedEntry = parseStoredAllowlistEntry(normalized);
    if (!normalizedEntry) {
      throw new BadRequestException('Invalid allowlist link');
    }

    await this.upsertNormalizedAllowlistDomain(chatId, normalizedEntry.normalizedValue);

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'ADD_DOMAIN',
        payload: {
          domain: normalizedEntry.domain,
          matchType,
          normalizedValue: normalizedEntry.normalizedValue,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async removeDomain(
    chatId: string,
    user: AuthUser,
    domain: string,
    source: AdminActionSource = 'miniapp',
  ) {
    await this.assertChatAdmin(chatId, user.userId);
    const normalizedEntry = parseStoredAllowlistEntry(this.decodePathParam(domain));
    if (!normalizedEntry) {
      throw new BadRequestException('Invalid allowlist link');
    }

    const matchingDomains = await this.findStoredAllowlistDomains(chatId, normalizedEntry);
    if (matchingDomains.length === 0) {
      throw new BadRequestException('Link not found in allowlist');
    }

    await this.prisma.domainAllowlist.deleteMany({
      where: {
        chatId,
        domain: {
          in: matchingDomains,
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'REMOVE_DOMAIN',
        payload: {
          domain: normalizedEntry.domain,
          matchType: normalizedEntry.matchType,
          normalizedValue: normalizedEntry.normalizedValue,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async scheduleDomainRemoval(
    chatId: string,
    user: AuthUser,
    domain: string,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ) {
    await this.assertChatAdmin(chatId, user.userId);
    const normalizedEntry = parseStoredAllowlistEntry(this.decodePathParam(domain));
    if (!normalizedEntry) {
      throw new BadRequestException('Invalid allowlist link');
    }
    const parsed = scheduleDomainRemovalRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    let removeAfterAt: Date | null = null;
    if (parsed.data.removeAfterAt) {
      const scheduledAt = new Date(parsed.data.removeAfterAt);
      if (Number.isNaN(scheduledAt.getTime())) {
        throw new BadRequestException('Invalid removal datetime');
      }

      if (scheduledAt.getTime() <= Date.now()) {
        throw new BadRequestException('Removal datetime must be in the future');
      }

      removeAfterAt = scheduledAt;
    }

    const matchingDomains = await this.findStoredAllowlistDomains(chatId, normalizedEntry);
    if (matchingDomains.length === 0) {
      throw new BadRequestException('Link not found in allowlist');
    }

    await this.prisma.domainAllowlist.updateMany({
      where: {
        chatId,
        domain: {
          in: matchingDomains,
        },
      },
      data: {
        removeAfterAt,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: removeAfterAt ? 'SCHEDULE_DOMAIN_REMOVE' : 'CLEAR_DOMAIN_REMOVE_SCHEDULE',
        payload: {
          domain: normalizedEntry.domain,
          matchType: normalizedEntry.matchType,
          normalizedValue: normalizedEntry.normalizedValue,
          removeAfterAt: removeAfterAt ? removeAfterAt.toISOString() : null,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async assertChatAdmin(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType | null = null,
    options: AssertChatAdminOptions = {},
  ) {
    const access = await this.resolveUserAndBotAdminAccess(chatId, userId, {
      bypassNegativeCache: true,
      ...(entityType ? { entityType } : {}),
      trafficClass: options.trafficClass,
      timeoutMs: options.timeoutMs,
      allowPersistedFallback: options.allowPersistedFallback,
    });
    if (access.status === 'denied') {
      if (access.reason === 'bot_not_admin') {
        throw new ForbiddenException(
          'Бот больше не состоит в этом чате MAX или не является его администратором.',
        );
      }

      throw new ForbiddenException('Пользователь не является администратором чата.');
    }

    if (access.status === 'unknown') {
      throw new ServiceUnavailableException(
        'Не удалось проверить права администратора в MAX. Повторите попытку.',
      );
    }

    if (access.status === 'throttled') {
      throw new ServiceUnavailableException(
        'MAX API временно ограничил проверку прав администратора. Повторите попытку.',
      );
    }

    if (options.syncPersistedAccess !== false) {
      await this.upsertUserChatAccess(chatId, userId, null, entityType);
    } else {
      this.rememberVerifiedChatAdminAccess({
        chatId,
        userId,
        entityType,
        source: access.source,
      });
    }
  }

  async assertManagedEntityAdminAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
  ): Promise<void> {
    await this.assertChatAdmin(chatId, userId, entityType);
    await this.ensureEntityType(chatId, userId, entityType);
  }

  async assertManagedEntityReadAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
    options: AdminReadBypassOptions = {},
  ): Promise<void> {
    if (!options.skipAdminCheck) {
      await this.assertReadOnlyChatAdmin(chatId, userId, entityType, {
        forceRemote: options.forceRemote,
        timeoutMs: options.timeoutMs,
      });
    }
    if (!options.skipEntityCheck) {
      await this.ensureEntityType(chatId, userId, entityType);
    }
  }

  async resolveChatSettingsReadBotAssignmentData(
    chatId: string,
  ): Promise<ResolvedBotAssignmentData> {
    const resolvedBotId = await this.resolveChatBotIdForRead(chatId);
    return this.buildResolvedBotAssignmentData(resolvedBotId);
  }

  async resolveChatSettingsWriteBotAssignmentData(
    chatId: string,
  ): Promise<ResolvedBotAssignmentData> {
    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);
    return this.buildResolvedBotAssignmentData(resolvedBotId);
  }

  async resolveChannelSettingsReadBotAssignmentData(
    chatId: string,
  ): Promise<ResolvedBotAssignmentData> {
    const resolvedBotId = await this.resolveChatBotIdForRead(chatId);
    return this.buildResolvedBotAssignmentData(resolvedBotId);
  }

  async resolveChannelSettingsWriteBotAssignmentData(
    chatId: string,
  ): Promise<ResolvedBotAssignmentData> {
    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);
    return this.buildResolvedBotAssignmentData(resolvedBotId);
  }

  async resolveChatRulesActionBotId(chatId: string): Promise<string | undefined> {
    return this.resolveManualActionBotAssignment(chatId);
  }

  async resolveManagedPollReadBotId(chatId: string): Promise<string | undefined> {
    return this.resolveChatBotIdForRead(chatId);
  }

  async resolveManagedPollActionBotId(chatId: string): Promise<string | undefined> {
    return this.resolveManualActionBotAssignment(chatId);
  }

  async resolveChannelEngagementActionBotId(chatId: string): Promise<string | undefined> {
    return this.resolveManualActionBotAssignment(chatId);
  }

  normalizeChatSettingsForApply(sourceChatId: string, settings: ChatSettings): ChatSettings {
    return this.normalizeChatSettings(settings, undefined, sourceChatId, {
      resetRequiredSubscriptionExpiration: true,
    });
  }

  async resolveSettingsApplyTargetChatsForSettings(
    sourceChatId: string,
    user: AuthUser,
    target: ApplySettingsTarget,
  ): Promise<ChatSummary[]> {
    return this.resolveSettingsApplyTargetChats(sourceChatId, user, target);
  }

  async resolveSettingsApplyBotAssignmentData(chatId: string): Promise<ResolvedBotAssignmentData> {
    const resolvedBotId = await this.resolveBotAssignment(chatId);
    return this.buildResolvedBotAssignmentData(resolvedBotId);
  }

  isRequiredSubscriptionCurrentlyActiveForSettings(settings: ChatSettings): boolean {
    return this.isRequiredSubscriptionCurrentlyActive(settings);
  }

  scheduleApplySettingsToAllReadinessRefreshForSettings(params: {
    chatIds: readonly string[];
    shouldRefreshRequiredSubscription: boolean;
    requiredSubscriptionChannelIds: readonly string[];
  }): void {
    this.scheduleApplySettingsToAllReadinessRefresh(params);
  }

  async syncDomainAllowlistToChatsForSettings(
    sourceChatId: string,
    targetChatIds: readonly string[],
  ): Promise<void> {
    await this.syncDomainAllowlistToChats(sourceChatId, targetChatIds);
  }

  async resolveManagedEntityHeaderReadBotId(chatId: string): Promise<string | undefined> {
    return this.resolveBackgroundReadBotAssignment(chatId);
  }

  async attachManagedEntityHeaderBotAssignmentsForManagedEntities(
    header: ManagedEntityHeader,
  ): Promise<ManagedEntityHeader> {
    return this.attachManagedEntityHeaderBotAssignments(header);
  }

  buildChannelEngagementDialogArtifacts(
    params: BuildChannelEngagementDialogArtifactsParams,
  ): ChannelEngagementDialogArtifacts {
    const commentsUrl = this.dialogLinkHelper.buildChannelDialogLaunchUrl(
      params.chatId,
      'comments',
      params.threadId,
      params.botId,
    );
    const suggestPayload = this.dialogLinkHelper.buildChannelSuggestionStartPayload(
      params.chatId,
      params.threadId,
    );
    const suggestLaunchUrl = this.dialogLinkHelper.buildChannelDialogLaunchUrl(
      params.chatId,
      'suggest',
      params.threadId,
      params.botId,
    );
    const suggestUrl =
      params.suggestionEntryMode === 'MINIAPP'
        ? suggestLaunchUrl
        : (this.dialogLinkHelper.buildBotStartUrl(suggestPayload, params.botId) ??
          suggestLaunchUrl);

    return {
      commentsUrl,
      suggestPayload,
      suggestUrl,
      commentsButton: this.buildChannelDialogButton(
        params.chatId,
        'comments',
        params.threadId,
        params.formattedCommentsButtonText,
        params.botId,
      ),
      suggestButton: this.buildChannelDialogButton(
        params.chatId,
        'suggest',
        params.threadId,
        params.suggestButtonText,
        params.botId,
        params.suggestionEntryMode,
      ),
    };
  }

  async buildAutofilledChatRulesTextFromCurrentSettings(
    chatId: string,
    user: AuthUser,
  ): Promise<string> {
    return this.buildAutofilledRulesTextFromCurrentSettings(chatId, user);
  }

  async buildFormattedChatRulesPublicationText(
    chatId: string,
    sourceText: string,
    options: {
      adminContactButtonEnabled: boolean;
      adminContactButtonUrl: string;
    },
  ): Promise<{
    text: string;
    textFormat: MaxSendMessageOptions['textFormat'];
  }> {
    return this.buildFormattedRulesPublicationText(chatId, sourceText, options);
  }

  async sendPublishedChatRulesPrivateConfirmation(
    user: AuthUser,
    publishedUrl: string | null,
  ): Promise<void> {
    await this.sendRulesPublishedPrivateConfirmation(user, publishedUrl);
  }

  async assertRequiredSubscriptionSettingsForChatSettings(settings: ChatSettings): Promise<void> {
    await this.assertRequiredSubscriptionSettings(settings);
  }

  async refreshChatSettingsExecutionReadiness(
    chatId: string,
    settings: ChatSettings,
  ): Promise<void> {
    await this.refreshExecutionReadinessAfterChatSettingsUpdate(chatId, settings);
  }

  async refreshChannelSettingsExecutionReadiness(chatId: string): Promise<void> {
    await this.refreshExecutionReadinessAfterChannelSettingsUpdate(chatId);
  }

  async resolveRequiredSubscriptionChannelHeadersForSettings(
    channelIds: readonly string[],
  ): Promise<ManagedEntityHeader[]> {
    return this.resolveRequiredSubscriptionChannelHeaders(channelIds);
  }

  private async assertReadOnlyChatAdmin(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType | null = null,
    options: {
      forceRemote?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<void> {
    if (options.forceRemote !== true) {
      const cached = (await this.chatContextCache.getAdminAccess?.(chatId, userId)) ?? null;
      if (cached === 'granted') {
        return;
      }

      if (
        (await this.hasPersistedChatAccess(chatId, userId)) &&
        (await this.canUsePersistedChatAccessFallback(chatId))
      ) {
        await this.chatContextCache.setAdminAccess?.(chatId, userId, 'granted');
        return;
      }
    }

    await this.assertChatAdmin(chatId, userId, entityType, {
      syncPersistedAccess: false,
      trafficClass: options.forceRemote === true ? 'interactive' : undefined,
      timeoutMs: options.timeoutMs,
      allowPersistedFallback: options.forceRemote === true ? false : undefined,
    });
  }

  private rememberVerifiedChatAdminAccess(params: {
    chatId: string;
    userId: string;
    entityType: ManagedEntityType | null;
    source: 'cache' | 'remote' | 'allowlist_fallback';
  }): void {
    void Promise.all([
      this.chatContextCache.setAdminAccess?.(params.chatId, params.userId, 'granted') ??
        Promise.resolve(),
      this.chatContextCache.rememberChatAdminUser?.(params.chatId, params.userId) ??
        Promise.resolve(),
    ]).catch((error: unknown) => {
      this.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to remember verified chat admin access after read-only validation',
      );
    });

    if (params.source === 'remote') {
      this.scheduleAdminAccessValidationRosterSync(params.chatId, params.entityType);
    }
  }

  private scheduleAdminAccessValidationRosterSync(
    chatId: string,
    entityType: ManagedEntityType | null,
  ): void {
    if (typeof this.maxChatAdminRosterSyncService?.scheduleChatAdminRosterSync !== 'function') {
      return;
    }

    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }

    const now = Date.now();
    const lastScheduledAt =
      this.adminAccessValidationRosterSyncScheduledAtMs.get(normalizedChatId) ?? 0;
    if (now - lastScheduledAt < ADMIN_ACCESS_VALIDATION_ROSTER_SYNC_THROTTLE_MS) {
      return;
    }
    this.adminAccessValidationRosterSyncScheduledAtMs.set(normalizedChatId, now);

    void this.maxChatAdminRosterSyncService
      .scheduleChatAdminRosterSync({
        chatId: normalizedChatId,
        entityType,
        source: 'admin_access_validation',
        retryUntilMs: null,
      })
      .catch((error: unknown) => {
        this.adminAccessValidationRosterSyncScheduledAtMs.delete(normalizedChatId);
        this.logger.warn(
          {
            chatId: normalizedChatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to schedule admin roster sync after read-only admin validation',
        );
      });
  }

  private resolveLogsDashboardFrom(range: LogsDashboardRange, to: Date): Date {
    const toTimestamp = to.getTime();

    if (range === '24h') {
      return new Date(toTimestamp - 24 * 60 * 60 * 1000);
    }

    if (range === '30d') {
      return new Date(toTimestamp - 30 * 24 * 60 * 60 * 1000);
    }

    return new Date(toTimestamp - 7 * 24 * 60 * 60 * 1000);
  }

  private buildParticipantViolationCountWhere(
    chatId: string,
    userIds: readonly string[],
    from: Date,
    to: Date,
  ): Prisma.ModerationEventWhereInput {
    return {
      chatId,
      userId: {
        in: [...userIds],
      },
      createdAt: { gte: from, lte: to },
      action: {
        in: [
          SanctionAction.WARN,
          SanctionAction.DELETE_MESSAGE,
          SanctionAction.MUTE,
          SanctionAction.KICK,
          SanctionAction.BAN,
        ],
      },
    };
  }

  private normalizeModerationViolationMetadata(metadata: unknown): Record<string, unknown> | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }

    const normalized = { ...(metadata as Record<string, unknown>) };
    if (
      typeof normalized.muteDurationHours !== 'number' &&
      typeof normalized.banDurationHours === 'number'
    ) {
      normalized.muteDurationHours = normalized.banDurationHours;
    }

    if (typeof normalized.muteExpiresAt !== 'string') {
      if (typeof normalized.banExpiresAt === 'string') {
        normalized.muteExpiresAt = normalized.banExpiresAt;
      } else if (typeof normalized.unbanScheduledAt === 'string') {
        normalized.muteExpiresAt = normalized.unbanScheduledAt;
      }
    }

    return normalized;
  }

  private readStoredModerationTargetDisplayName(
    metadata: Record<string, unknown> | null,
  ): string | null {
    return this.readTrimmedString(metadata?.targetDisplayName) ?? null;
  }

  private normalizeModerationViolationAction(
    action: SanctionAction,
    metadata: Record<string, unknown> | null,
  ): SanctionAction {
    if (action === SanctionAction.KICK) {
      return SanctionAction.BAN;
    }

    if (
      action === SanctionAction.BAN &&
      metadata &&
      (typeof metadata.muteDurationHours === 'number' ||
        typeof metadata.banDurationHours === 'number')
    ) {
      return SanctionAction.MUTE;
    }

    return action;
  }

  private normalizeModerationViolationRuleCode(ruleCode: string, action: SanctionAction): string {
    if (ruleCode === 'MANUAL_KICK') {
      return 'MANUAL_BAN';
    }

    if (ruleCode === 'LOCAL_ADMIN_BLOCK') {
      return ruleCode;
    }

    if (ruleCode === 'BAN_ACTIVE_DELETE') {
      return 'MUTE_ACTIVE_DELETE';
    }

    if (ruleCode === 'GLOBAL_SPAMMER_KICK' || action === SanctionAction.KICK) {
      return 'GLOBAL_SPAMMER_BAN';
    }

    return ruleCode;
  }

  private mapModerationViolationRow(
    chatId: string,
    entityType: ManagedEntityType,
    row: ModerationViolationRow,
    userProfiles: Map<string, ResolvedUserProfile>,
  ): LogsDashboardViolation {
    const metadata = this.normalizeModerationViolationMetadata(row.metadata);
    const userProfile = userProfiles.get(row.userId);
    const action = this.normalizeModerationViolationAction(row.action, metadata);
    const ruleCode = this.normalizeModerationViolationRuleCode(row.ruleCode, row.action);
    const userDisplayName =
      this.readTrimmedString(row.userDisplayName) ??
      this.readStoredModerationTargetDisplayName(metadata) ??
      userProfile?.displayName ??
      null;

    return {
      id: row.id,
      action,
      ruleCode,
      userId: row.userId,
      userDisplayName,
      avatarUrl: row.avatarUrl ?? userProfile?.avatarUrl ?? null,
      profileUrl: row.profileUrl ?? userProfile?.profileUrl ?? null,
      profileHandoffUrl:
        row.profileHandoffUrl ??
        userProfile?.profileHandoffUrl ??
        this.buildProfileMentionHandoffUrl(chatId, entityType, row.userId, userDisplayName),
      createdAt: row.createdAt.toISOString(),
      maskedExcerpt: row.maskedExcerpt,
      metadata,
    };
  }

  private encodeModerationFeedCursor(value: ModerationFeedCursor): string {
    return Buffer.from(
      JSON.stringify({
        createdAt: value.createdAt.toISOString(),
        id: value.id,
      }),
      'utf8',
    ).toString('base64url');
  }

  private decodeModerationFeedCursor(cursor: string | undefined): ModerationFeedCursor | null {
    const normalizedCursor = cursor?.trim() ?? '';
    if (!normalizedCursor) {
      return null;
    }

    try {
      const parsed = JSON.parse(
        Buffer.from(normalizedCursor, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      const createdAtIso = typeof parsed.createdAt === 'string' ? parsed.createdAt.trim() : '';
      const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
      const createdAt = new Date(createdAtIso);

      if (!id || !createdAtIso || !Number.isFinite(createdAt.getTime())) {
        return null;
      }

      return {
        createdAt,
        id,
      };
    } catch {
      return null;
    }
  }

  private async getModerationFeedPage(
    chatId: string,
    from: Date,
    to: Date,
    query: ModerationFeedQuery,
    entityType: ManagedEntityType = 'chat',
    profileOptions: ResolveUserProfilesOptions = {},
  ): Promise<ModerationFeedPage> {
    const limit = Math.max(1, Math.min(100, query.limit));
    const cursor = this.decodeModerationFeedCursor(query.cursor);
    const rows = await selectModerationFeedReadModelRows(this.prisma, {
      chatId,
      from,
      to,
      filter: query.filter,
      cursor,
      limit: limit + 1,
    });

    const pageRows = rows.slice(0, limit);
    const userIdsToResolve =
      profileOptions.allowRemoteLookup === false
        ? []
        : pageRows
            .filter((row) => !this.readTrimmedString(row.userDisplayName))
            .map((row) => row.userId);
    const userProfiles =
      userIdsToResolve.length > 0
        ? await this.resolveUserProfiles(chatId, entityType, userIdsToResolve, profileOptions)
        : new Map<string, ResolvedUserProfile>();
    const lastRow = pageRows.at(-1);

    return moderationFeedPageSchema.parse({
      items: pageRows.map((row) =>
        this.mapModerationViolationRow(
          chatId,
          entityType,
          row as ModerationViolationRow,
          userProfiles,
        ),
      ),
      hasMore: rows.length > limit,
      nextCursor:
        rows.length > limit && lastRow
          ? this.encodeModerationFeedCursor({
              createdAt: lastRow.createdAt,
              id: lastRow.id,
            })
          : null,
    });
  }

  private async getCachedModerationFeedPage(
    chatId: string,
    userId: string,
    from: Date,
    to: Date,
    query: ModerationFeedQuery,
    entityType: ManagedEntityType,
    profileOptions: ResolveUserProfilesOptions = {},
  ): Promise<ModerationFeedPage> {
    const cacheKey = buildModerationFeedPageCacheKey(
      chatId,
      userId,
      entityType,
      query,
      profileOptions,
    );
    const cached = this.moderationFeedPageCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.promise;
    }

    const pending = this.getModerationFeedPage(
      chatId,
      from,
      to,
      query,
      entityType,
      profileOptions,
    ).catch((error: unknown) => {
      const current = this.moderationFeedPageCache.get(cacheKey);
      if (current?.promise === pending) {
        this.moderationFeedPageCache.delete(cacheKey);
      }
      throw error;
    });

    this.moderationFeedPageCache.set(cacheKey, {
      expiresAtMs: Date.now() + EVENTS_FEED_PAGE_CACHE_TTL_MS,
      promise: pending,
    });

    return pending;
  }

  private resolveChannelStatsFrom(range: ChannelStatsRange, to: Date): Date {
    return this.resolveLogsDashboardFrom(range, to);
  }

  private resolveChannelStatsBucket(range: ChannelStatsRange): ChannelStatsBucket {
    return range === '24h' ? 'hour' : 'day';
  }

  private async getMembershipActivityFeedPage(
    chatId: string,
    from: Date,
    to: Date,
    query: MembershipActivityQuery,
    entityType: ManagedEntityType = 'chat',
    profileOptions: ResolveUserProfilesOptions = {},
  ): Promise<MembershipActivityPage> {
    const allowRemoteLookup = profileOptions.allowRemoteLookup !== false;
    const limit = Math.max(1, Math.min(100, query.limit));
    const cursor = this.decodeMembershipActivityCursor(query.cursor);
    const eventTypes =
      query.filter === 'joined'
        ? ['user_added']
        : query.filter === 'left'
          ? ['user_removed']
          : ['user_added', 'user_removed'];
    const rows = await this.getMembershipEventRows(chatId, from, to, eventTypes, {
      cursor,
      limit: limit + 1,
      order: 'desc',
    });

    const pageRows = rows.slice(0, limit);
    const userIdsToResolve = pageRows
      .filter((row) => {
        if (allowRemoteLookup) {
          return true;
        }

        const directName = typeof row.sender_name === 'string' ? row.sender_name.trim() : '';
        return !directName;
      })
      .map((row) => (typeof row.user_id === 'string' ? row.user_id.trim() : ''))
      .filter(Boolean);
    const userProfiles = await this.resolveUserProfiles(
      chatId,
      entityType,
      userIdsToResolve,
      profileOptions,
    );
    const items = pageRows
      .map((row) => {
        const createdAt = this.toIsoString(row.created_at);
        if (!createdAt) {
          return null;
        }

        const normalizedUserId =
          typeof row.user_id === 'string' && row.user_id.trim()
            ? row.user_id.trim()
            : `unknown:${row.id}`;
        const eventType = row.event_type === 'user_removed' ? 'left' : 'joined';
        const directName = typeof row.sender_name === 'string' ? row.sender_name.trim() : '';
        const userProfile = userProfiles.get(normalizedUserId);
        const userDisplayName = directName || userProfile?.displayName || 'Участник';

        return {
          id: row.id,
          type: eventType,
          userId: normalizedUserId,
          userDisplayName,
          avatarUrl: userProfile?.avatarUrl ?? null,
          profileUrl: userProfile?.profileUrl ?? null,
          profileHandoffUrl:
            userProfile?.profileHandoffUrl ??
            this.buildProfileMentionHandoffUrl(
              chatId,
              entityType,
              normalizedUserId,
              userDisplayName,
            ),
          createdAt,
        };
      })
      .filter(
        (
          item,
        ): item is {
          id: string;
          type: 'joined' | 'left';
          userId: string;
          userDisplayName: string;
          avatarUrl: string | null;
          profileUrl: string | null;
          profileHandoffUrl: string | null;
          createdAt: string;
        } => item !== null,
      );
    const hasMore = rows.length > limit;
    const lastItem = items[items.length - 1] ?? null;

    return membershipActivityPageSchema.parse({
      items,
      hasMore,
      nextCursor:
        hasMore && lastItem
          ? this.encodeMembershipActivityCursor({
              createdAt: lastItem.createdAt,
              id: lastItem.id,
            })
          : null,
    });
  }

  private async getCachedMembershipActivityFeedPage(
    chatId: string,
    userId: string,
    from: Date,
    to: Date,
    query: MembershipActivityQuery,
    entityType: ManagedEntityType,
    profileOptions: ResolveUserProfilesOptions = {},
  ): Promise<MembershipActivityPage> {
    const cacheKey = buildMembershipActivityFeedPageCacheKey(
      chatId,
      userId,
      entityType,
      query,
      profileOptions,
    );
    const cached = this.membershipActivityFeedPageCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.promise;
    }

    const pending = this.getMembershipActivityFeedPage(
      chatId,
      from,
      to,
      query,
      entityType,
      profileOptions,
    ).catch((error: unknown) => {
      const current = this.membershipActivityFeedPageCache.get(cacheKey);
      if (current?.promise === pending) {
        this.membershipActivityFeedPageCache.delete(cacheKey);
      }
      throw error;
    });

    this.membershipActivityFeedPageCache.set(cacheKey, {
      expiresAtMs: Date.now() + EVENTS_FEED_PAGE_CACHE_TTL_MS,
      promise: pending,
    });

    return pending;
  }

  private async buildChatParticipantsPage(
    chatId: string,
    userId: string,
    query: ChatParticipantsQuery,
    entityType: ManagedEntityType = 'chat',
  ): Promise<ChatParticipantsPage> {
    const limit = Math.max(1, Math.min(100, query.limit));
    const search = this.normalizeChatParticipantsSearchText(query.search ?? '');
    const resolvedBotId = (await this.resolveBackgroundReadBotAssignment(chatId)) ?? null;
    const now = new Date();
    const from = this.resolveLogsDashboardFrom(query.range, now);
    const [membersPage, header, settings] = await Promise.all([
      search
        ? this.searchChatParticipantsMembersPage(chatId, query, search, resolvedBotId)
        : this.loadChatParticipantsMembersPage(chatId, limit, query.cursor ?? null, resolvedBotId),
      this.getManagedEntityHeader(
        chatId,
        {
          userId,
          username: null,
          displayName: null,
          chatTitle: null,
        },
        entityType,
        { skipAdminCheck: true, skipEntityCheck: true },
      ),
      this.prisma.chatSettings.findUnique({
        where: { chatId },
        select: { nightModeTimezone: true },
      }),
    ]);
    const participantUserIds = Array.from(
      new Set(
        membersPage.items
          .map((member) => member.userId.trim())
          .filter((memberUserId) => memberUserId.length > 0),
      ),
    );
    const timeZone = this.normalizeParticipantImmunityTimezone(settings?.nightModeTimezone ?? null);
    const [violationCountRows, immunityRows] = await Promise.all([
      participantUserIds.length > 0
        ? this.prisma.moderationEvent.groupBy({
            by: ['userId'],
            where: this.buildParticipantViolationCountWhere(chatId, participantUserIds, from, now),
            _count: { _all: true },
          })
        : Promise.resolve([]),
      participantUserIds.length > 0
        ? this.prisma.chatParticipantModerationImmunity.findMany({
            where: {
              chatId,
              userId: { in: participantUserIds },
              expiresAt: {
                gt: now,
              },
            },
          })
        : Promise.resolve([]),
    ]);
    const violationCountByUserId = new Map<string, number>();
    const immunityByUserId = new Map<string, ChatParticipantImmunity>();

    for (const row of violationCountRows) {
      const normalizedUserId = row.userId.trim();
      if (!normalizedUserId) {
        continue;
      }

      violationCountByUserId.set(normalizedUserId, this.toSafeInteger(row._count._all));
    }

    for (const immunity of immunityRows) {
      const normalizedUserId = immunity.userId.trim();
      if (!normalizedUserId) {
        continue;
      }

      const summary = this.buildChatParticipantImmunitySummary(immunity, now, timeZone);
      if (!summary) {
        continue;
      }

      immunityByUserId.set(normalizedUserId, summary);
    }

    return chatParticipantsPageSchema.parse({
      items: membersPage.items.map((member) => {
        const normalizedUsername = member.username?.replace(/^@+/u, '').trim() ?? '';
        const userDisplayName =
          member.displayName?.trim() ||
          normalizedUsername ||
          (member.isBot ? 'Бот MAX' : 'Участник');

        return {
          userId: member.userId,
          userDisplayName,
          username: normalizedUsername || null,
          avatarUrl: this.readTrimmedString(member.avatarUrl) ?? null,
          profileUrl:
            this.normalizeMaxProfileUrl(this.readTrimmedString(member.profileUrl) ?? null) ??
            this.buildUserProfileUrl(normalizedUsername || null),
          profileHandoffUrl: this.buildProfileMentionHandoffUrl(
            chatId,
            entityType,
            member.userId,
            userDisplayName,
          ),
          violationCount: violationCountByUserId.get(member.userId.trim()) ?? 0,
          immunity: immunityByUserId.get(member.userId.trim()) ?? null,
          role: this.mapChatMemberRole(member.role),
          isBot: member.isBot,
        } satisfies ChatParticipantItem;
      }),
      totalCount:
        typeof header.participantsCount === 'number' && Number.isFinite(header.participantsCount)
          ? Math.max(0, Math.trunc(header.participantsCount))
          : null,
      hasMore: Boolean(membersPage.nextMarker),
      nextCursor: membersPage.nextMarker,
    });
  }

  private loadChatParticipantsMembersPage(
    chatId: string,
    limit: number,
    marker: string | null,
    resolvedBotId: string | null,
    options: {
      search?: boolean;
    } = {},
  ): Promise<{ items: MaxChatRosterMember[]; nextMarker: string | null }> {
    return this.maxClient.getChatMembersPage(
      chatId,
      {
        limit,
        marker,
      },
      {
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        ...(options.search
          ? {
              sourceTag: MAX_API_SOURCE_TAGS.PARTICIPANT_SEARCH,
              timeoutMs: CHAT_PARTICIPANTS_SEARCH_MAX_API_WAIT_MS,
            }
          : {}),
        ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
        ...(resolvedBotId ? { botId: resolvedBotId } : {}),
      },
    );
  }

  private async searchChatParticipantsMembersPage(
    chatId: string,
    query: ChatParticipantsQuery,
    search: string,
    resolvedBotId: string | null,
  ): Promise<{ items: MaxChatRosterMember[]; nextMarker: string | null }> {
    const limit = Math.max(1, Math.min(100, query.limit));
    const cursor = this.decodeChatParticipantsSearchCursor(query.cursor, search);
    const items: MaxChatRosterMember[] = [];
    let marker = cursor?.marker ?? null;
    let skip = cursor?.skip ?? 0;
    let scannedRemotePages = 0;

    while (true) {
      const currentMarker = marker;
      let membersPage: { items: MaxChatRosterMember[]; nextMarker: string | null };
      try {
        membersPage = await this.loadChatParticipantsMembersPage(
          chatId,
          100,
          currentMarker,
          resolvedBotId,
          { search: true },
        );
      } catch (error: unknown) {
        if (!isMaxApiThrottleError(error)) {
          throw error;
        }

        this.logger.log(
          {
            chatId,
            marker: currentMarker,
            itemsReturned: items.length,
            scannedRemotePages,
            err: error instanceof Error ? error.message : String(error),
          },
          'Paused participant search page scan after MAX API throttling',
        );
        return {
          items,
          nextMarker: this.encodeChatParticipantsSearchCursor({
            marker: currentMarker,
            skip,
            search,
          }),
        };
      }
      scannedRemotePages += 1;
      const matches = membersPage.items.filter((member) =>
        this.chatParticipantMatchesSearch(member, search),
      );
      let matchIndex = 0;

      if (skip > 0) {
        matchIndex = Math.min(skip, matches.length);
        skip -= matchIndex;
      }

      if (skip > 0) {
        if (!membersPage.nextMarker) {
          return {
            items,
            nextMarker: null,
          };
        }

        marker = membersPage.nextMarker;
        if (scannedRemotePages >= CHAT_PARTICIPANTS_SEARCH_REMOTE_PAGES_PER_RESPONSE) {
          return {
            items,
            nextMarker: this.encodeChatParticipantsSearchCursor({
              marker,
              skip,
              search,
            }),
          };
        }

        continue;
      }

      for (; matchIndex < matches.length; matchIndex += 1) {
        if (items.length >= limit) {
          return {
            items,
            nextMarker: this.encodeChatParticipantsSearchCursor({
              marker: currentMarker,
              skip: matchIndex,
              search,
            }),
          };
        }

        items.push(matches[matchIndex]);
      }

      if (items.length >= limit) {
        return {
          items,
          nextMarker: membersPage.nextMarker
            ? this.encodeChatParticipantsSearchCursor({
                marker: membersPage.nextMarker,
                skip: 0,
                search,
              })
            : null,
        };
      }

      if (!membersPage.nextMarker) {
        return {
          items,
          nextMarker: null,
        };
      }

      marker = membersPage.nextMarker;
      skip = 0;

      if (scannedRemotePages >= CHAT_PARTICIPANTS_SEARCH_REMOTE_PAGES_PER_RESPONSE) {
        return {
          items,
          nextMarker: this.encodeChatParticipantsSearchCursor({
            marker,
            skip,
            search,
          }),
        };
      }
    }
  }

  private chatParticipantMatchesSearch(member: MaxChatRosterMember, search: string): boolean {
    const username = member.username?.replace(/^@+/u, '').trim() ?? '';
    const candidates = [
      member.displayName ?? '',
      username,
      username ? `@${username}` : '',
      member.userId,
    ];

    return candidates.some((candidate) =>
      this.normalizeChatParticipantsSearchText(candidate).includes(search),
    );
  }

  private normalizeChatParticipantsSearchText(value: string): string {
    const normalized = value
      .normalize('NFKC')
      .trim()
      .replace(/\s+/gu, ' ')
      .toLocaleLowerCase('ru-RU');
    const withoutMentionPrefix = normalized.replace(/^@+/u, '');
    return withoutMentionPrefix || normalized;
  }

  private encodeChatParticipantsSearchCursor(cursor: ChatParticipantsSearchCursor): string {
    return Buffer.from(
      JSON.stringify({
        v: 1,
        marker: cursor.marker,
        skip: cursor.skip,
        search: cursor.search,
      }),
      'utf8',
    ).toString('base64url');
  }

  private decodeChatParticipantsSearchCursor(
    value: string | undefined,
    search: string,
  ): ChatParticipantsSearchCursor | null {
    if (!value) {
      return null;
    }

    try {
      const decoded = Buffer.from(value, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as Record<string, unknown>;
      const marker =
        typeof parsed.marker === 'string' && parsed.marker.trim()
          ? parsed.marker.trim()
          : parsed.marker === null
            ? null
            : null;
      const skip =
        typeof parsed.skip === 'number' && Number.isFinite(parsed.skip)
          ? Math.max(0, Math.trunc(parsed.skip))
          : 0;
      const cursorSearch =
        typeof parsed.search === 'string'
          ? this.normalizeChatParticipantsSearchText(parsed.search)
          : '';

      if (parsed.v !== 1 || cursorSearch !== search) {
        throw new Error('Invalid chat participants search cursor');
      }

      return {
        marker,
        skip,
        search,
      };
    } catch {
      throw new BadRequestException('Неверный cursor для поиска участников.');
    }
  }

  private async getCachedChatParticipantsPage(
    chatId: string,
    userId: string,
    query: ChatParticipantsQuery,
    entityType: ManagedEntityType,
  ): Promise<ChatParticipantsPage> {
    const cacheKey = buildChatParticipantsPageCacheKey(chatId, userId, entityType, query);
    const cached = this.chatParticipantsPageCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.promise;
    }

    const pending = this.buildChatParticipantsPage(chatId, userId, query, entityType).catch(
      (error: unknown) => {
        const current = this.chatParticipantsPageCache.get(cacheKey);
        if (current?.promise === pending) {
          this.chatParticipantsPageCache.delete(cacheKey);
        }
        throw error;
      },
    );

    this.chatParticipantsPageCache.set(cacheKey, {
      expiresAtMs: Date.now() + EVENTS_FEED_PAGE_CACHE_TTL_MS,
      promise: pending,
    });

    return pending;
  }

  private mapChatMemberRole(role: MaxChatMemberRole): ChatParticipantItem['role'] {
    if (role === 'owner' || role === 'admin') {
      return role;
    }

    return 'member';
  }

  private normalizeParticipantImmunityTimezone(value: string | null | undefined): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return DEFAULT_PARTICIPANT_IMMUNITY_TIMEZONE;
    }

    try {
      Intl.DateTimeFormat('ru-RU', { timeZone: normalized }).format(new Date());
      return normalized;
    } catch {
      return DEFAULT_PARTICIPANT_IMMUNITY_TIMEZONE;
    }
  }

  private formatParticipantImmunityDateKey(date: Date, timeZone: string): string {
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

  private buildChatParticipantImmunitySummary(
    immunity: {
      expiresAt: Date;
      dailyViolationLimit: number;
      dailyViolationUsage: number;
      usageDateKey: string | null;
    },
    now: Date,
    timeZone: string,
  ): ChatParticipantImmunity | null {
    if (!(immunity.expiresAt instanceof Date) || !Number.isFinite(immunity.expiresAt.getTime())) {
      return null;
    }

    if (immunity.expiresAt.getTime() <= now.getTime()) {
      return null;
    }

    const todayKey = this.formatParticipantImmunityDateKey(now, timeZone);
    const dailyViolationLimit = Math.max(
      1,
      Math.min(10, this.toSafeInteger(immunity.dailyViolationLimit)),
    );
    const usedViolatingMessagesToday =
      immunity.usageDateKey === todayKey ? this.toSafeInteger(immunity.dailyViolationUsage) : 0;

    return chatParticipantImmunitySchema.parse({
      expiresAt: immunity.expiresAt.toISOString(),
      dailyViolationLimit,
      usedViolatingMessagesToday,
      remainingViolatingMessagesToday: Math.max(
        0,
        dailyViolationLimit - usedViolatingMessagesToday,
      ),
    });
  }

  private buildEmptyModerationFeedPage(): ModerationFeedPage {
    return moderationFeedPageSchema.parse({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
  }

  private buildEmptyMembershipActivityPage(): MembershipActivityPage {
    return membershipActivityPageSchema.parse({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
  }

  private async getMembershipEventRows(
    chatId: string,
    from: Date,
    to: Date,
    eventTypes: readonly string[],
    options: {
      cursor?: { createdAt: string; id: string } | null;
      limit?: number;
      order?: 'asc' | 'desc';
    } = {},
  ): Promise<MembershipEventRow[]> {
    const order = options.order === 'asc' ? 'asc' : 'desc';
    const orderDirectionSql = Prisma.raw(order === 'asc' ? 'ASC' : 'DESC');
    const cursor = order === 'desc' ? (options.cursor ?? null) : null;
    const cursorClause = cursor
      ? Prisma.sql`
          AND (
            event_at < ${cursor.createdAt}
            OR (event_at = ${cursor.createdAt} AND source_event_id < ${cursor.id})
          )
        `
      : Prisma.empty;
    const limitClause =
      typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? Prisma.sql`LIMIT ${Math.max(1, Math.trunc(options.limit))}`
        : Prisma.empty;

    return this.prisma.$queryRaw<MembershipEventRow[]>`
      SELECT
        source_event_id AS id,
        event_at AS created_at,
        event_type,
        user_id,
        sender_name
      FROM chat_membership_activity_feed_items
      WHERE chat_id = ${chatId}
        AND event_type IN (${Prisma.join(eventTypes)})
        AND event_at >= ${from}
        AND event_at <= ${to}
        ${cursorClause}
      ORDER BY event_at ${orderDirectionSql}, source_event_id ${orderDirectionSql}
      ${limitClause}
    `;
  }

  private async buildPreviousChannelStatsPeriodSnapshot(
    chatId: string,
    from: Date,
    to: Date,
    bucket: ChannelStatsBucket,
  ): Promise<ChannelStatsPreviousPeriodSnapshot> {
    const [membershipBucketRows, contentBucketRows, previousAudienceSnapshot, audienceSnapshots] =
      await Promise.all([
        selectChannelStatsMembershipBucketRows(this.prisma, { chatId, from, to, bucket }),
        selectChannelStatsContentBucketRows(this.prisma, { chatId, from, to, bucket }),
        this.prisma.channelAudienceSnapshot.findFirst({
          where: {
            chatId,
            capturedAt: { lt: from },
          },
          orderBy: { capturedAt: 'desc' },
          select: {
            participantsCount: true,
          },
        }),
        this.prisma.channelAudienceSnapshot.findMany({
          where: {
            chatId,
            capturedAt: { gte: from, lte: to },
          },
          orderBy: { capturedAt: 'asc' },
          select: {
            capturedAt: true,
            participantsCount: true,
          },
        }),
      ]);

    const bucketStarts = this.buildChannelStatsBucketStarts(from, to, bucket);
    const contentSeries = this.buildContentSeriesFromBucketRows(bucketStarts, contentBucketRows);
    const contentTotals = this.buildContentTotals(contentSeries);
    const viewsMode = this.resolveChannelStatsViewsMode(contentTotals);
    const viewsSeries = this.buildViewsSeriesFromContentSeries(contentSeries, viewsMode);
    const views = viewsSeries.reduce((total, item) => total + item.views, 0);

    const membershipSeries = this.buildMembershipSeriesFromBucketRows(
      bucketStarts,
      membershipBucketRows,
    );
    const joined = membershipSeries.reduce((total, item) => total + item.joined, 0);
    const left = membershipSeries.reduce((total, item) => total + item.left, 0);
    const participantSeries = this.buildParticipantSeries(
      bucketStarts,
      bucket,
      previousAudienceSnapshot?.participantsCount ?? null,
      audienceSnapshots,
    );

    return {
      totals: {
        joined,
        left,
        net: joined - left,
        posts: contentTotals.posts,
        views,
        viewsTotal: contentTotals.viewsTotal,
        averageViewsPerPost:
          contentTotals.posts > 0 ? Math.round(contentTotals.viewsTotal / contentTotals.posts) : 0,
        reactions: contentTotals.reactions,
      },
      series: {
        participants: participantSeries,
        membership: membershipSeries,
        views: viewsSeries,
      },
    };
  }

  private buildChannelStatsComparison(
    current: ChannelStatsPeriodTotals,
    previous: ChannelStatsPeriodTotals,
    period: { from: Date; to: Date },
    series?: ChannelStatsComparisonSeries,
  ): ChannelStatsResponse['comparison'] {
    return {
      period: {
        from: period.from.toISOString(),
        to: period.to.toISOString(),
      },
      deltas: {
        audienceNet: this.buildChannelStatsDeltaMetric(current.net, previous.net),
        joined: this.buildChannelStatsDeltaMetric(current.joined, previous.joined),
        left: this.buildChannelStatsDeltaMetric(current.left, previous.left),
        posts: this.buildChannelStatsDeltaMetric(current.posts, previous.posts),
        views: this.buildChannelStatsDeltaMetric(current.views, previous.views),
        averageViewsPerPost: this.buildChannelStatsDeltaMetric(
          current.averageViewsPerPost,
          previous.averageViewsPerPost,
        ),
        reactions: this.buildChannelStatsDeltaMetric(current.reactions, previous.reactions),
      },
      ...(series ? { series } : {}),
    };
  }

  private buildChannelStatsDeltaMetric(current: number, previous: number): ChannelStatsDeltaMetric {
    const normalizedCurrent = this.toSafeInteger(current);
    const normalizedPrevious = this.toSafeInteger(previous);
    const absolute = normalizedCurrent - normalizedPrevious;
    const percent =
      normalizedPrevious === 0
        ? normalizedCurrent === 0
          ? 0
          : null
        : Math.round((absolute / Math.abs(normalizedPrevious)) * 1000) / 10;

    return {
      current: normalizedCurrent,
      previous: normalizedPrevious,
      absolute,
      percent,
    };
  }

  private buildChannelStatsHealth(params: {
    totals: ChannelStatsPeriodTotals;
    comparison: ChannelStatsResponse['comparison'];
    maxSnapshotAvailable: boolean;
    viewsAvailable: boolean;
    churnAvailable: boolean;
    suggestionsDelivered: number;
    suggestionsFailed: number;
  }): ChannelStatsResponse['health'] {
    let score = 72;
    const factors: ChannelStatsResponse['health']['factors'] = [];
    const addFactor = (
      code: string,
      label: string,
      tone: ChannelStatsSignalTone,
      impact: number,
    ) => {
      score += impact;
      factors.push({ code, label, tone, impact });
    };

    if (params.totals.net > 0) {
      addFactor('growth', 'Рост', 'success', Math.min(12, 4 + Math.round(params.totals.net / 12)));
    } else if (params.totals.net < 0) {
      addFactor(
        'negative-growth',
        'Отток',
        'danger',
        -Math.min(18, 6 + Math.round(Math.abs(params.totals.net) / 10)),
      );
    }

    if (params.churnAvailable && params.totals.left > Math.max(2, params.totals.joined)) {
      addFactor('churn', 'Отток', 'warning', -10);
    }

    const viewsDelta = params.comparison.deltas.views;
    if (params.viewsAvailable && viewsDelta.previous > 0) {
      if (typeof viewsDelta.percent === 'number' && viewsDelta.percent >= 20) {
        addFactor('views-up', 'Просмотры', 'success', 8);
      } else if (typeof viewsDelta.percent === 'number' && viewsDelta.percent <= -20) {
        addFactor('views-down', 'Просмотры', 'warning', -10);
      }
    }

    const engagementRate =
      params.totals.views > 0 ? (params.totals.reactions / params.totals.views) * 100 : null;
    if (engagementRate !== null) {
      if (engagementRate >= 4) {
        addFactor('engagement', 'Реакции', 'success', 7);
      } else if (engagementRate < 0.4) {
        addFactor('low-engagement', 'Реакции', 'warning', -6);
      }
    }

    if (params.viewsAvailable && params.totals.posts === 0) {
      addFactor('no-posts', 'Пауза', 'warning', -8);
    }

    const deliveryTotal = params.suggestionsDelivered + params.suggestionsFailed;
    if (deliveryTotal > 0 && params.suggestionsFailed / deliveryTotal >= 0.25) {
      addFactor('delivery', 'Доставка', 'warning', -6);
    }

    if (!params.maxSnapshotAvailable) {
      addFactor('max-snapshot', 'MAX', 'warning', -8);
    }

    const normalizedScore = Math.max(0, Math.min(100, Math.round(score)));
    return {
      score: normalizedScore,
      tone: this.resolveChannelStatsScoreTone(normalizedScore),
      factors: factors
        .sort((left, right) => Math.abs(right.impact) - Math.abs(left.impact))
        .slice(0, 4),
    };
  }

  private resolveChannelStatsScoreTone(score: number): ChannelStatsSignalTone {
    if (score >= 85) {
      return 'success';
    }

    if (score >= 70) {
      return 'accent';
    }

    if (score >= 50) {
      return 'warning';
    }

    return 'danger';
  }

  private buildChannelStatsSignals(params: {
    totals: ChannelStatsPeriodTotals;
    comparison: ChannelStatsResponse['comparison'];
    topPosts: ChannelStatsResponse['official']['content']['topPosts'];
    membershipSeries: ChannelStatsResponse['official']['series']['membership'];
    viewsSeries: ChannelStatsResponse['official']['series']['views'];
    postViewMetrics: ChannelStatsPostViewMetric[];
    range: ChannelStatsRange;
    maxSnapshotAvailable: boolean;
    suggestionsDelivered: number;
    suggestionsFailed: number;
  }): ChannelStatsResponse['signals'] {
    const insights: ChannelStatsSignal[] = [];
    const alerts: ChannelStatsSignal[] = [];
    const markers: ChannelStatsGraphMarker[] = [];
    const bestWindows = this.buildChannelStatsBestWindows(params.postViewMetrics);

    const addInsight = (
      code: string,
      label: string,
      value: string,
      tone: ChannelStatsSignalTone,
      at: string | null = null,
    ) => {
      insights.push({ code, label, value, tone, at });
    };
    const addAlert = (
      code: string,
      label: string,
      value: string,
      tone: ChannelStatsSignalTone,
      at: string | null = null,
    ) => {
      alerts.push({ code, label, value, tone, at });
    };

    const viewsDelta = params.comparison.deltas.views;
    if (viewsDelta.current > 0 || viewsDelta.previous > 0) {
      addInsight(
        'views-delta',
        'Просмотры',
        this.formatChannelStatsDeltaValue(viewsDelta),
        this.resolveChannelStatsDeltaTone(viewsDelta, false),
      );
    }

    const audienceDelta = params.comparison.deltas.audienceNet;
    if (params.totals.net !== 0 || audienceDelta.previous !== 0) {
      addInsight(
        params.totals.net >= 0 ? 'audience-growth' : 'audience-loss',
        params.totals.net >= 0 ? 'Рост' : 'Отток',
        this.formatChannelStatsSignedInteger(params.totals.net),
        params.totals.net >= 0 ? 'success' : 'danger',
      );
    }

    const topPost = params.topPosts[0] ?? null;
    if (topPost) {
      const topPostValue = topPost.viewsDelta || topPost.views;
      addInsight(
        'top-post',
        'Лучший пост',
        this.formatChannelStatsCompactCount(topPostValue),
        'accent',
        topPost.publishedAt,
      );
      markers.push({
        code: 'top-post',
        type: 'post',
        label: '#1',
        value: this.formatChannelStatsCompactCount(topPostValue),
        tone: 'accent',
        at: topPost.publishedAt,
      });
    }

    const bestWindow = bestWindows[0] ?? null;
    if (bestWindow) {
      addInsight('best-window', 'Окно', this.formatChannelStatsWindowValue(bestWindow), 'success');
    }

    const peakView = params.viewsSeries.reduce<(typeof params.viewsSeries)[number] | null>(
      (peak, item) => (!peak || item.views > peak.views ? item : peak),
      null,
    );
    if (peakView && peakView.views > 0) {
      markers.push({
        code: 'views-peak',
        type: 'peak',
        label: 'Пик',
        value: this.formatChannelStatsCompactCount(peakView.views),
        tone: 'success',
        at: peakView.at,
      });
    }

    const peakLeft = params.membershipSeries.reduce<
      (typeof params.membershipSeries)[number] | null
    >((peak, item) => (!peak || (item.left ?? 0) > (peak.left ?? 0) ? item : peak), null);
    if (peakLeft && (peakLeft.left ?? 0) > Math.max(0, peakLeft.joined)) {
      markers.push({
        code: 'audience-left-peak',
        type: 'anomaly',
        label: 'Отток',
        value: this.formatChannelStatsSignedInteger(-Math.max(0, peakLeft.left ?? 0)),
        tone: 'danger',
        at: peakLeft.at,
      });
    }

    if (
      typeof viewsDelta.percent === 'number' &&
      viewsDelta.previous >= 100 &&
      viewsDelta.percent <= -25
    ) {
      addAlert('views-drop', 'Просмотры', this.formatChannelStatsDeltaValue(viewsDelta), 'warning');
    }

    if (params.totals.net < 0) {
      addAlert(
        'audience-drop',
        'Отток',
        this.formatChannelStatsSignedInteger(params.totals.net),
        'danger',
      );
    }

    if (params.range !== '24h' && params.totals.posts === 0) {
      addAlert('no-posts', 'Пауза', '0 постов', 'warning');
    }

    const deliveryTotal = params.suggestionsDelivered + params.suggestionsFailed;
    if (deliveryTotal > 0 && params.suggestionsFailed / deliveryTotal >= 0.25) {
      addAlert('delivery-errors', 'Доставка', `${params.suggestionsFailed}`, 'warning');
    }

    if (!params.maxSnapshotAvailable) {
      addAlert('max-snapshot', 'MAX', 'нет снимка', 'warning');
    }

    return {
      insights: insights.slice(0, 4),
      alerts: alerts.slice(0, 4),
      markers: markers.slice(0, 8),
      bestWindows,
    };
  }

  private buildChannelStatsBestWindows(
    postViewMetrics: ChannelStatsPostViewMetric[],
  ): ChannelStatsBestWindow[] {
    const grouped = new Map<
      string,
      {
        dayOfWeek: number;
        hour: number;
        posts: number;
        views: number;
        reactions: number;
      }
    >();

    for (const metric of postViewMetrics) {
      const views = Math.max(0, metric.viewsDelta || metric.viewsCurrent);
      if (views <= 0) {
        continue;
      }

      const { dayOfWeek, hour } = this.resolveChannelStatsMoscowWindow(metric.post.publishedAt);
      const key = `${dayOfWeek}:${hour}`;
      const current = grouped.get(key) ?? {
        dayOfWeek,
        hour,
        posts: 0,
        views: 0,
        reactions: 0,
      };
      current.posts += 1;
      current.views += views;
      current.reactions += this.toSafeInteger(metric.post.latestReactionsTotal);
      grouped.set(key, current);
    }

    return Array.from(grouped.values())
      .map((item) => {
        const averageViews = item.posts > 0 ? Math.round(item.views / item.posts) : 0;
        const averageReactions = item.posts > 0 ? Math.round(item.reactions / item.posts) : 0;
        return {
          dayOfWeek: item.dayOfWeek,
          hour: item.hour,
          score: averageViews + averageReactions * 12 + item.posts * 4,
          posts: item.posts,
          averageViews,
          averageReactions,
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.posts - left.posts ||
          left.dayOfWeek - right.dayOfWeek ||
          left.hour - right.hour,
      )
      .slice(0, 3);
  }

  private resolveChannelStatsMoscowWindow(date: Date): { dayOfWeek: number; hour: number } {
    const moscowDate = new Date(date.getTime() + 3 * ONE_HOUR_MS);
    return {
      dayOfWeek: moscowDate.getUTCDay(),
      hour: moscowDate.getUTCHours(),
    };
  }

  private resolveChannelStatsDeltaTone(
    metric: ChannelStatsDeltaMetric,
    inverse: boolean,
  ): ChannelStatsSignalTone {
    if (metric.absolute === 0) {
      return 'neutral';
    }

    const positive = inverse ? metric.absolute < 0 : metric.absolute > 0;
    return positive ? 'success' : 'warning';
  }

  private formatChannelStatsDeltaValue(metric: ChannelStatsDeltaMetric): string {
    if (typeof metric.percent === 'number' && Math.abs(metric.percent) >= 1) {
      const rounded = Math.round(metric.percent);
      return `${rounded > 0 ? '+' : ''}${rounded}%`;
    }

    if (metric.absolute !== 0) {
      return this.formatChannelStatsSignedInteger(metric.absolute);
    }

    return '0';
  }

  private formatChannelStatsSignedInteger(value: number): string {
    const normalized = this.toSafeInteger(value);
    return normalized > 0 ? `+${normalized}` : String(normalized);
  }

  private formatChannelStatsCompactCount(value: number): string {
    return new Intl.NumberFormat('ru-RU', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(Math.max(0, this.toSafeInteger(value)));
  }

  private formatChannelStatsWindowValue(window: ChannelStatsBestWindow): string {
    const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    const day = days[window.dayOfWeek] ?? '';
    return `${day} ${String(window.hour).padStart(2, '0')}:00`;
  }

  private buildChannelStatsBucketStarts(from: Date, to: Date, bucket: ChannelStatsBucket): Date[] {
    const starts: Date[] = [];
    let cursor = this.floorChannelStatsBucket(from, bucket);
    const end = this.floorChannelStatsBucket(to, bucket);

    while (cursor.getTime() <= end.getTime()) {
      starts.push(cursor);
      cursor = this.shiftChannelStatsBucket(cursor, bucket, 1);
    }

    return starts;
  }

  private floorChannelStatsBucket(date: Date, bucket: ChannelStatsBucket): Date {
    const result = new Date(date);
    result.setUTCMinutes(0, 0, 0);
    if (bucket === 'day') {
      result.setUTCHours(0, 0, 0, 0);
    }
    return result;
  }

  private shiftChannelStatsBucket(date: Date, bucket: ChannelStatsBucket, amount: number): Date {
    const result = new Date(date);
    if (bucket === 'hour') {
      result.setUTCHours(result.getUTCHours() + amount);
      return result;
    }

    result.setUTCDate(result.getUTCDate() + amount);
    return result;
  }

  private buildParticipantSeries(
    bucketStarts: Date[],
    bucket: ChannelStatsBucket,
    initialParticipantsCount: number | null,
    snapshots: Array<{ capturedAt: Date; participantsCount: number | null }>,
  ) {
    let cursorValue = initialParticipantsCount;
    let snapshotIndex = 0;

    return bucketStarts.map((bucketStart) => {
      const bucketEnd = this.shiftChannelStatsBucket(bucketStart, bucket, 1);
      while (
        snapshotIndex < snapshots.length &&
        snapshots[snapshotIndex].capturedAt.getTime() < bucketEnd.getTime()
      ) {
        cursorValue = snapshots[snapshotIndex].participantsCount;
        snapshotIndex += 1;
      }

      return {
        at: bucketStart.toISOString(),
        participantsCount: cursorValue,
      };
    });
  }

  private buildMembershipSeriesFromBucketRows(
    bucketStarts: Date[],
    rows: ChannelStatsMembershipBucketRow[],
  ) {
    const grouped = new Map<string, { joined: number; left: number }>();

    for (const row of rows) {
      const bucketStart = this.toIsoString(row.bucket_start);
      if (!bucketStart) {
        continue;
      }
      grouped.set(new Date(bucketStart).toISOString(), {
        joined: this.toSafeInteger(row.joined_users),
        left: this.toSafeInteger(row.left_users),
      });
    }

    return bucketStarts.map((bucketStart) => {
      const current = grouped.get(bucketStart.toISOString()) ?? { joined: 0, left: 0 };
      return {
        at: bucketStart.toISOString(),
        joined: current.joined,
        left: current.left,
      };
    });
  }

  private buildPostViewMetrics(
    posts: ChannelStatsPostRow[],
    snapshots: ChannelStatsViewSnapshotRow[],
    from: Date,
  ): ChannelStatsPostViewMetric[] {
    const snapshotsByPostId = new Map<string, ChannelStatsViewSnapshotRow[]>();
    for (const snapshot of snapshots) {
      const current = snapshotsByPostId.get(snapshot.channelPostId) ?? [];
      current.push(snapshot);
      snapshotsByPostId.set(snapshot.channelPostId, current);
    }

    return posts.map((post) => {
      const postSnapshots = snapshotsByPostId
        .get(post.id)
        ?.slice()
        .sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime());
      let previousViews: number | null = post.publishedAt.getTime() >= from.getTime() ? 0 : null;
      let viewsDelta = 0;

      for (const snapshot of postSnapshots ?? []) {
        const currentViews = Math.max(0, this.toSafeInteger(snapshot.views));
        if (previousViews === null) {
          previousViews = currentViews;
          continue;
        }

        viewsDelta += Math.max(0, currentViews - previousViews);
        previousViews = currentViews;
      }

      const viewsCurrent = Math.max(0, this.toSafeInteger(post.latestViews));
      const hasObservedDelta =
        Boolean(postSnapshots && postSnapshots.length > 0) &&
        (post.publishedAt.getTime() >= from.getTime() || (postSnapshots?.length ?? 0) >= 2);

      return {
        post,
        viewsDelta: hasObservedDelta ? viewsDelta : viewsCurrent,
        viewsCurrent,
        hasObservedDelta,
      };
    });
  }

  private buildContentSeriesFromBucketRows(
    bucketStarts: Date[],
    rows: ChannelStatsContentBucketRow[],
  ): ChannelStatsContentBucketPoint[] {
    const grouped = new Map<string, Omit<ChannelStatsContentBucketPoint, 'at'>>();

    for (const row of rows) {
      const bucketStart = this.toIsoString(row.bucket_start);
      if (!bucketStart) {
        continue;
      }
      const key = new Date(bucketStart).toISOString();
      const current = grouped.get(key) ?? {
        posts: 0,
        viewsDelta: 0,
        viewsTotal: 0,
        reactions: 0,
      };
      current.posts += this.toSafeInteger(row.posts);
      current.viewsDelta += this.toSafeInteger(row.views_delta);
      current.viewsTotal += this.toSafeInteger(row.views_total);
      current.reactions += this.toSafeInteger(row.reactions);
      grouped.set(key, current);
    }

    return bucketStarts.map((bucketStart) => {
      const current = grouped.get(bucketStart.toISOString()) ?? {
        posts: 0,
        viewsDelta: 0,
        viewsTotal: 0,
        reactions: 0,
      };
      return {
        at: bucketStart.toISOString(),
        posts: current.posts,
        viewsDelta: current.viewsDelta,
        viewsTotal: current.viewsTotal,
        reactions: current.reactions,
      };
    });
  }

  private buildContentTotals(contentSeries: ChannelStatsContentBucketPoint[]) {
    return contentSeries.reduce(
      (totals, item) => ({
        posts: totals.posts + item.posts,
        viewsDelta: totals.viewsDelta + item.viewsDelta,
        viewsTotal: totals.viewsTotal + item.viewsTotal,
        reactions: totals.reactions + item.reactions,
      }),
      {
        posts: 0,
        viewsDelta: 0,
        viewsTotal: 0,
        reactions: 0,
      },
    );
  }

  private resolveChannelStatsViewsMode(totals: {
    viewsDelta: number;
    viewsTotal: number;
  }): ChannelStatsViewMode {
    if (totals.viewsDelta > 0) {
      return 'observedDelta';
    }

    return 'latestTotal';
  }

  private buildViewsSeriesFromContentSeries(
    contentSeries: ChannelStatsContentBucketPoint[],
    mode: ChannelStatsViewMode,
  ) {
    let cumulativeViews = 0;
    return contentSeries.map((bucket) => {
      const views = mode === 'observedDelta' ? bucket.viewsDelta : bucket.viewsTotal;
      cumulativeViews += views;
      return {
        at: bucket.at,
        views,
        cumulativeViews,
      };
    });
  }

  private buildTopPosts(postViewMetrics: ChannelStatsPostViewMetric[]) {
    return postViewMetrics
      .map((metric) => ({
        messageId: metric.post.messageId,
        publishedAt: metric.post.publishedAt.toISOString(),
        url: metric.post.url,
        views: metric.viewsCurrent,
        viewsDelta: metric.viewsDelta,
        reactions: this.toSafeInteger(metric.post.latestReactionsTotal),
      }))
      .sort(
        (left, right) =>
          right.viewsDelta - left.viewsDelta ||
          right.views - left.views ||
          right.reactions - left.reactions ||
          left.publishedAt.localeCompare(right.publishedAt),
      )
      .slice(0, 5);
  }

  private buildTopReactions(
    posts: Array<{
      latestReactions: Prisma.JsonValue | null;
    }>,
  ) {
    const grouped = new Map<string, number>();

    for (const post of posts) {
      for (const reaction of this.readChannelPostReactions(post.latestReactions)) {
        grouped.set(reaction.emoji, (grouped.get(reaction.emoji) ?? 0) + reaction.count);
      }
    }

    return Array.from(grouped.entries())
      .map(([emoji, count]) => ({ emoji, count }))
      .sort((left, right) => right.count - left.count || left.emoji.localeCompare(right.emoji))
      .slice(0, 3);
  }

  private readChannelPostReactions(
    value: Prisma.JsonValue | null,
  ): Array<{ emoji: string; count: number }> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.readChannelPostReaction(item))
      .filter((item): item is { emoji: string; count: number } => item !== null);
  }

  private readChannelPostReaction(
    value: Prisma.JsonValue,
  ): { emoji: string; count: number } | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const emoji = typeof row.emoji === 'string' ? row.emoji.trim() : '';
    const count = this.toSafeInteger(row.count);
    if (!emoji || count <= 0) {
      return null;
    }

    return {
      emoji,
      count,
    };
  }

  private resolveOfficialCoverageFrom(
    syncState: {
      viewsCoverageFrom: Date | null;
      membershipCoverageFrom: Date | null;
    } | null,
    latestAudienceCapturedAt: Date | null,
  ): string | null {
    const candidates = [
      syncState?.viewsCoverageFrom ?? null,
      syncState?.membershipCoverageFrom ?? null,
      latestAudienceCapturedAt,
    ].filter((value): value is Date => value instanceof Date && Number.isFinite(value.getTime()));

    if (candidates.length === 0) {
      return null;
    }

    const earliest = candidates.reduce((acc, item) =>
      item.getTime() < acc.getTime() ? item : acc,
    );
    return earliest.toISOString();
  }

  private toSafeInteger(value: unknown): number {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    }

    if (typeof value === 'bigint') {
      return value > 0n ? Number(value) : 0;
    }

    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
    }

    if (value && typeof value === 'object') {
      const numericObject = value as {
        toNumber?: () => number;
        toString?: () => string;
      };
      if (typeof numericObject.toNumber === 'function') {
        const parsed = numericObject.toNumber();
        return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
      }

      if (typeof numericObject.toString === 'function') {
        const stringValue = numericObject.toString();
        if (stringValue && stringValue !== '[object Object]') {
          const parsed = Number(stringValue);
          return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
        }
      }
    }

    return 0;
  }

  private toIsoString(value: unknown): string | null {
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return null;
      }

      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    const parsed = new Date(normalized);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  private encodeMembershipActivityCursor(cursor: { createdAt: string; id: string }): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeMembershipActivityCursor(
    value: string | undefined,
  ): { createdAt: string; id: string } | null {
    if (!value) {
      return null;
    }

    try {
      const decoded = Buffer.from(value, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as { createdAt?: unknown; id?: unknown };
      const createdAt =
        typeof parsed.createdAt === 'string' ? this.toIsoString(parsed.createdAt) : null;
      const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';

      if (!createdAt || !id) {
        throw new Error('Invalid membership activity cursor');
      }

      return { createdAt, id };
    } catch {
      throw new BadRequestException('Неверный cursor для activity feed.');
    }
  }

  private async resolveUserDisplayNames(
    chatId: string,
    userIds: string[],
  ): Promise<Map<string, string>> {
    const normalizedUserIds = [...new Set(userIds.map((item) => item.trim()).filter(Boolean))];
    if (normalizedUserIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.$queryRaw<
      Array<{ user_id: string | null; sender_name: string | null }>
    >`
      SELECT DISTINCT ON (user_id)
        user_id,
        sender_name
      FROM (
        SELECT
          user_id,
          sender_name,
          event_at
        FROM chat_membership_activity_feed_items
        WHERE chat_id = ${chatId}
          AND user_id IN (${Prisma.join(normalizedUserIds)})
          AND COALESCE(BTRIM(sender_name), '') <> ''

        UNION ALL

        SELECT
          NULLIF(BTRIM(normalized_payload->'message'->>'senderId'), '') AS user_id,
          NULLIF(BTRIM(normalized_payload->'message'->>'senderName'), '') AS sender_name,
          created_at AS event_at
        FROM webhook_events
        WHERE NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') = ${chatId}
          AND NULLIF(BTRIM(normalized_payload->'message'->>'senderId'), '') IN (${Prisma.join(
            normalizedUserIds,
          )})
          AND NULLIF(BTRIM(normalized_payload->'message'->>'senderName'), '') IS NOT NULL
          AND normalized_payload->>'type' IN (${Prisma.join(LOCAL_USER_DISPLAY_NAME_EVENT_TYPES)})
      ) local_name_events
      ORDER BY user_id, event_at DESC
    `;

    const byUserId = new Map<string, string>();
    for (const row of Array.isArray(rows) ? rows : []) {
      const userId = typeof row.user_id === 'string' ? row.user_id.trim() : '';
      const senderName = typeof row.sender_name === 'string' ? row.sender_name.trim() : '';
      if (!userId || !senderName || byUserId.has(userId)) {
        continue;
      }
      byUserId.set(userId, senderName);
    }

    return byUserId;
  }

  private async resolveManualModerationTargetDisplayName(
    chatId: string,
    targetUserId: string,
    options: {
      botId?: string | null;
      allowRemoteLookup?: boolean;
    } = {},
  ): Promise<string | null> {
    const normalizedChatId = chatId.trim();
    const normalizedTargetUserId = targetUserId.trim();
    if (!normalizedChatId || !normalizedTargetUserId) {
      return null;
    }

    try {
      const localDisplayNames = await this.resolveUserDisplayNames(normalizedChatId, [
        normalizedTargetUserId,
      ]);
      const localDisplayName = localDisplayNames.get(normalizedTargetUserId)?.trim() ?? '';
      if (localDisplayName) {
        return localDisplayName;
      }
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: normalizedChatId,
          userId: normalizedTargetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve local display name for manual moderation target',
      );
    }

    if (options.allowRemoteLookup === false) {
      return null;
    }

    const loadProfiles = this.maxClient.getChatMemberProfiles?.bind(this.maxClient);
    if (typeof loadProfiles !== 'function') {
      return null;
    }

    try {
      const profiles = await loadProfiles(normalizedChatId, [normalizedTargetUserId], {
        trafficClass: 'background',
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
        ...(options.botId ? { botId: options.botId } : {}),
      });
      const profile = profiles.get(normalizedTargetUserId);
      const displayName = this.readTrimmedString(profile?.displayName);
      if (displayName) {
        return displayName;
      }

      const username = this.readTrimmedString(profile?.username);
      return username ? `@${username.replace(/^@+/u, '')}` : null;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: normalizedChatId,
          userId: normalizedTargetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve remote display name for manual moderation target',
      );
      return null;
    }
  }

  private async resolveUserProfiles(
    chatId: string,
    entityType: ManagedEntityType,
    userIds: readonly string[],
    options: ResolveUserProfilesOptions = {},
  ): Promise<Map<string, ResolvedUserProfile>> {
    const allowRemoteLookup = options.allowRemoteLookup !== false;
    const normalizedUserIds = [...new Set(userIds.map((item) => item.trim()).filter(Boolean))];
    if (normalizedUserIds.length === 0) {
      return new Map();
    }

    const profiles = new Map<string, ResolvedUserProfile>();
    const pendingByUserId = new Map<string, Promise<ResolvedUserProfile>>();
    const nowMs = Date.now();
    const missingUserIds: string[] = [];

    for (const userId of normalizedUserIds) {
      const remoteCacheKey = buildResolvedUserProfileCacheKey(chatId, entityType, userId, {
        allowRemoteLookup: true,
      });
      const localCacheKey = buildResolvedUserProfileCacheKey(chatId, entityType, userId, {
        allowRemoteLookup: false,
      });
      const cached =
        this.resolvedUserProfileCache.get(remoteCacheKey) ??
        (allowRemoteLookup ? undefined : this.resolvedUserProfileCache.get(localCacheKey));
      if (cached && cached.expiresAtMs > nowMs) {
        pendingByUserId.set(userId, cached.promise);
        continue;
      }

      if (allowRemoteLookup) {
        this.resolvedUserProfileCache.delete(remoteCacheKey);
      } else {
        this.resolvedUserProfileCache.delete(localCacheKey);
      }
      missingUserIds.push(userId);
    }

    if (missingUserIds.length > 0) {
      const batchPromise = this.loadResolvedUserProfiles(
        chatId,
        entityType,
        missingUserIds,
        options,
      ).catch((error: unknown) => {
        for (const userId of missingUserIds) {
          const cacheKey = buildResolvedUserProfileCacheKey(chatId, entityType, userId, options);
          const current = this.resolvedUserProfileCache.get(cacheKey);
          if (current?.promise === pendingByUserId.get(userId)) {
            this.resolvedUserProfileCache.delete(cacheKey);
          }
        }
        throw error;
      });

      for (const userId of missingUserIds) {
        const cacheKey = buildResolvedUserProfileCacheKey(chatId, entityType, userId, options);
        const pendingProfile = batchPromise.then(
          (batch) =>
            batch.get(userId) ?? {
              displayName: null,
              avatarUrl: null,
              profileUrl: null,
              profileHandoffUrl: this.buildProfileMentionHandoffUrl(
                chatId,
                entityType,
                userId,
                null,
              ),
            },
        );
        this.resolvedUserProfileCache.set(cacheKey, {
          expiresAtMs: nowMs + RESOLVED_USER_PROFILE_CACHE_TTL_MS,
          promise: pendingProfile,
        });
        pendingByUserId.set(userId, pendingProfile);
      }
    }

    for (const userId of normalizedUserIds) {
      const pendingProfile = pendingByUserId.get(userId);
      if (!pendingProfile) {
        continue;
      }
      profiles.set(userId, await pendingProfile);
    }

    return profiles;
  }

  private async loadResolvedUserProfiles(
    chatId: string,
    entityType: ManagedEntityType,
    userIds: readonly string[],
    options: ResolveUserProfilesOptions = {},
  ): Promise<Map<string, ResolvedUserProfile>> {
    const allowRemoteLookup = options.allowRemoteLookup !== false;
    const normalizedUserIds = [...new Set(userIds.map((item) => item.trim()).filter(Boolean))];
    if (normalizedUserIds.length === 0) {
      return new Map();
    }

    const displayNames = await this.resolveUserDisplayNames(chatId, normalizedUserIds);
    let chatMemberProfiles = new Map<
      string,
      {
        displayName: string | null;
        username: string | null;
        avatarUrl: string | null;
        profileUrl: string | null;
      }
    >();

    const loadProfiles = this.maxClient.getChatMemberProfiles?.bind(this.maxClient);
    if (allowRemoteLookup && loadProfiles) {
      try {
        const resolvedBotId = await this.resolveBackgroundReadBotAssignment(chatId);
        chatMemberProfiles = await loadProfiles(chatId, normalizedUserIds, {
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
          ...(resolvedBotId ? { botId: resolvedBotId } : {}),
        });
      } catch (error) {
        this.logger.warn(
          {
            chatId,
            userIds: normalizedUserIds,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to resolve chat member profiles',
        );
      }
    }

    const profiles = new Map<string, ResolvedUserProfile>();
    for (const userId of normalizedUserIds) {
      const profile = chatMemberProfiles.get(userId);
      const username = this.readTrimmedString(profile?.username);
      const displayName =
        displayNames.get(userId) ?? this.readTrimmedString(profile?.displayName) ?? null;
      profiles.set(userId, {
        displayName,
        avatarUrl: this.readTrimmedString(profile?.avatarUrl) ?? null,
        profileUrl:
          this.normalizeMaxProfileUrl(this.readTrimmedString(profile?.profileUrl) ?? null) ??
          this.buildUserProfileUrl(username),
        profileHandoffUrl: this.buildProfileMentionHandoffUrl(
          chatId,
          entityType,
          userId,
          displayName,
        ),
      });
    }

    return profiles;
  }

  private buildUserProfileUrl(username: string | null): string | null {
    return buildUserProfileUrl(username);
  }

  private normalizeMaxProfileUrl(value: string | null): string | null {
    return normalizeMaxProfileUrl(value);
  }

  private normalizeLegacyProfileButtonUrl(url: string | null | undefined): string {
    return normalizeLegacyProfileButtonUrl(url);
  }

  private buildProfileMentionHandoffUrl(
    chatId: string,
    entityType: ManagedEntityType,
    userId: string,
    displayName: string | null,
  ): string | null {
    return buildProfileMentionHandoffUrl(
      this.dialogLinkHelper,
      chatId,
      entityType,
      userId,
      displayName,
    );
  }

  private activeDomainWhere(chatId: string) {
    const now = new Date();
    return {
      chatId,
      OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: now } }],
    };
  }

  private decodePathParam(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  private async syncDomainAllowlistToChats(
    sourceChatId: string,
    targetChatIds: readonly string[],
  ): Promise<void> {
    const rows = await this.prisma.domainAllowlist.findMany({
      where: this.activeDomainWhere(sourceChatId),
      orderBy: [{ removeAfterAt: 'asc' }, { domain: 'asc' }],
      select: {
        domain: true,
        removeAfterAt: true,
      },
    });
    const sourceEntries = await this.canonicalizeActiveAllowlistRows(sourceChatId, rows);

    await mapWithConcurrencyLimit(
      targetChatIds.filter((chatId) => chatId !== sourceChatId),
      APPLY_SETTINGS_TO_ALL_DOMAIN_SYNC_CONCURRENCY,
      async (chatId) => {
        await this.prisma.$transaction([
          this.prisma.domainAllowlist.deleteMany({
            where: {
              chatId,
            },
          }),
          ...sourceEntries.map((entry) =>
            this.prisma.domainAllowlist.upsert({
              where: {
                chatId_domain: {
                  chatId,
                  domain: entry.normalizedValue,
                },
              },
              create: {
                chatId,
                domain: entry.normalizedValue,
                removeAfterAt: entry.removeAfterAt ? new Date(entry.removeAfterAt) : null,
              },
              update: {
                removeAfterAt: entry.removeAfterAt ? new Date(entry.removeAfterAt) : null,
              },
            }),
          ),
        ]);

        await this.chatContextCache.invalidate(chatId);
      },
    );
  }

  private async upsertNormalizedAllowlistDomain(chatId: string, normalizedDomain: string) {
    const rows = await this.prisma.domainAllowlist.findMany({
      where: {
        chatId,
      },
      select: {
        domain: true,
      },
    });

    const obsoleteDomains = rows
      .map((row: { domain: string }) => row.domain)
      .filter(
        (storedDomain) =>
          storedDomain !== normalizedDomain &&
          parseStoredAllowlistEntry(storedDomain)?.normalizedValue === normalizedDomain,
      );

    await this.prisma.domainAllowlist.upsert({
      where: {
        chatId_domain: {
          chatId,
          domain: normalizedDomain,
        },
      },
      create: {
        chatId,
        domain: normalizedDomain,
      },
      update: {
        removeAfterAt: null,
      },
    });

    if (obsoleteDomains.length === 0) {
      return;
    }

    await this.prisma.domainAllowlist.deleteMany({
      where: {
        chatId,
        domain: {
          in: obsoleteDomains,
        },
      },
    });
  }

  private async findStoredAllowlistDomains(
    chatId: string,
    targetEntry: {
      normalizedValue: string;
      matchType: AllowlistMatchType;
    },
  ): Promise<string[]> {
    const rows = await this.prisma.domainAllowlist.findMany({
      where: {
        chatId,
      },
      select: {
        domain: true,
      },
    });

    return rows
      .map((row: { domain: string }) => row.domain)
      .filter((storedDomain) => {
        const parsed = parseStoredAllowlistEntry(storedDomain);
        return (
          parsed?.normalizedValue === targetEntry.normalizedValue &&
          parsed.matchType === targetEntry.matchType
        );
      });
  }

  private async canonicalizeActiveAllowlistRows(
    chatId: string,
    rows: Array<{ domain: string; removeAfterAt: Date | null }>,
  ): Promise<DomainAllowlistEntry[]> {
    const byDomain = new Map<
      string,
      {
        domain: string;
        normalizedValue: string;
        matchType: AllowlistMatchType;
        removeAfterAt: Date | null;
      }
    >();
    const exactRows = new Map<string, Date | null>();
    const obsoleteDomains = new Set<string>();

    for (const row of rows) {
      const normalizedEntry = parseStoredAllowlistEntry(row.domain);
      if (!normalizedEntry) {
        obsoleteDomains.add(row.domain);
        continue;
      }

      if (row.domain === normalizedEntry.normalizedValue) {
        exactRows.set(normalizedEntry.normalizedValue, row.removeAfterAt);
      } else {
        obsoleteDomains.add(row.domain);
      }

      const current = byDomain.get(normalizedEntry.normalizedValue);
      if (current === undefined) {
        byDomain.set(normalizedEntry.normalizedValue, {
          ...normalizedEntry,
          removeAfterAt: row.removeAfterAt,
        });
        continue;
      }

      if (current.removeAfterAt === null || row.removeAfterAt === null) {
        current.removeAfterAt = null;
        continue;
      }

      if (row.removeAfterAt.getTime() < current.removeAfterAt.getTime()) {
        current.removeAfterAt = row.removeAfterAt;
      }
    }

    const normalizedRows = Array.from(byDomain.values())
      .sort((leftEntry, rightEntry) => {
        if (leftEntry.removeAfterAt === null && rightEntry.removeAfterAt !== null) {
          return -1;
        }
        if (leftEntry.removeAfterAt !== null && rightEntry.removeAfterAt === null) {
          return 1;
        }
        if (leftEntry.removeAfterAt !== null && rightEntry.removeAfterAt !== null) {
          const byTime = leftEntry.removeAfterAt.getTime() - rightEntry.removeAfterAt.getTime();
          if (byTime !== 0) {
            return byTime;
          }
        }

        const byDomain = leftEntry.domain.localeCompare(rightEntry.domain);
        if (byDomain !== 0) {
          return byDomain;
        }

        return leftEntry.matchType.localeCompare(rightEntry.matchType);
      })
      .map((entry) => ({
        domain: entry.domain,
        normalizedValue: entry.normalizedValue,
        matchType: entry.matchType,
        removeAfterAt: entry.removeAfterAt ? entry.removeAfterAt.toISOString() : null,
      }));

    const domainsToUpsert = normalizedRows.filter((entry) => {
      const existing = exactRows.get(entry.normalizedValue);
      return !this.isSameOptionalIsoDate(existing, entry.removeAfterAt);
    });

    if (domainsToUpsert.length === 0 && obsoleteDomains.size === 0) {
      return normalizedRows;
    }

    await this.prisma.$transaction([
      ...domainsToUpsert.map((entry) =>
        this.prisma.domainAllowlist.upsert({
          where: {
            chatId_domain: {
              chatId,
              domain: entry.normalizedValue,
            },
          },
          create: {
            chatId,
            domain: entry.normalizedValue,
            removeAfterAt: entry.removeAfterAt ? new Date(entry.removeAfterAt) : null,
          },
          update: {
            removeAfterAt: entry.removeAfterAt ? new Date(entry.removeAfterAt) : null,
          },
        }),
      ),
      ...(obsoleteDomains.size > 0
        ? [
            this.prisma.domainAllowlist.deleteMany({
              where: {
                chatId,
                domain: {
                  in: Array.from(obsoleteDomains),
                },
              },
            }),
          ]
        : []),
    ]);

    await this.chatContextCache.invalidate(chatId);
    return normalizedRows;
  }

  private isSameOptionalIsoDate(value: Date | null | undefined, isoValue: string | null): boolean {
    if (value === undefined) {
      return false;
    }

    if (value === null) {
      return isoValue === null;
    }

    if (isoValue === null) {
      return false;
    }

    return value.toISOString() === isoValue;
  }

  private async getPublicChannelSettings(chatId: string): Promise<ChannelSettings> {
    const settings = await this.prisma.channelSettings.findUnique({
      where: { chatId },
    });

    if (!settings) {
      return DEFAULT_CHANNEL_SETTINGS;
    }

    const parsed = channelSettingsSchema.safeParse(this.sanitizeStoredChannelSettings(settings));
    return parsed.success
      ? this.normalizeChannelSettings(parsed.data, chatId)
      : DEFAULT_CHANNEL_SETTINGS;
  }

  private normalizeChannelSettings(settings: ChannelSettings, chatId?: string): ChannelSettings {
    const normalizedSettings = {
      ...settings,
      autoPostButtonsMode: this.normalizeChannelAutoPostButtonsMode(settings),
    };

    return chatId
      ? this.normalizeChannelSettingsButtonUrls(chatId, normalizedSettings)
      : normalizedSettings;
  }

  private async getPublicChatCommentSettings(
    chatId: string,
  ): Promise<
    Pick<
      ChatSettings,
      | 'commentsEnabled'
      | 'commentsAdminsEnabled'
      | 'commentsAllEnabled'
      | 'commentsChatBroadcastsEnabled'
    >
  > {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
    });

    if (!settings) {
      return {
        commentsEnabled: DEFAULT_CHAT_SETTINGS.commentsEnabled,
        commentsAdminsEnabled: DEFAULT_CHAT_SETTINGS.commentsAdminsEnabled,
        commentsAllEnabled: DEFAULT_CHAT_SETTINGS.commentsAllEnabled,
        commentsChatBroadcastsEnabled: DEFAULT_CHAT_SETTINGS.commentsChatBroadcastsEnabled,
      };
    }

    const parsed = chatSettingsSchema.safeParse(this.sanitizeStoredChatSettings(settings));
    const normalized = parsed.success
      ? this.normalizeChatSettings(parsed.data, undefined, chatId)
      : DEFAULT_CHAT_SETTINGS;
    return {
      commentsEnabled: normalized.commentsEnabled,
      commentsAdminsEnabled: normalized.commentsAdminsEnabled,
      commentsAllEnabled: normalized.commentsAllEnabled,
      commentsChatBroadcastsEnabled: normalized.commentsChatBroadcastsEnabled,
    };
  }

  private shouldIncludeChatCommentsButton(
    settings: Pick<ChatSettings, 'commentsEnabled' | 'commentsChatBroadcastsEnabled'>,
  ): boolean {
    return settings.commentsEnabled && settings.commentsChatBroadcastsEnabled;
  }

  private normalizeChannelAutoPostButtonsMode(
    settings: Pick<
      ChannelSettings,
      'autoPostButtonsMode' | 'commentsEnabled' | 'postSuggestionsEnabled'
    >,
  ): ChannelSettings['autoPostButtonsMode'] {
    const includeComments = settings.commentsEnabled;
    const includeSuggest = settings.postSuggestionsEnabled;

    if (includeComments && includeSuggest) {
      return 'BOTH';
    }
    if (includeComments) {
      return 'COMMENTS';
    }
    if (includeSuggest) {
      return 'SUGGEST';
    }
    return 'OFF';
  }

  private getStoredChannelSettingsSanitizationChanges(
    current: unknown,
    sanitized: ChannelSettings,
  ): Partial<ChannelSettings> {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return {};
    }

    const currentSettings = current as Record<string, unknown>;
    const changes: Partial<ChannelSettings> = {};

    for (const key of CHANNEL_SETTINGS_BUTTON_URL_KEYS) {
      const currentUrl = this.readTrimmedString(currentSettings[key]) ?? '';
      if (currentUrl !== sanitized[key]) {
        changes[key] = sanitized[key];
      }

      const enabledKey = CHANNEL_SETTINGS_BUTTON_ENABLED_BY_URL_KEY[key];
      const currentEnabled = currentSettings[enabledKey] === true;
      if (currentEnabled !== sanitized[enabledKey]) {
        changes[enabledKey] = sanitized[enabledKey];
      }
    }

    return changes;
  }

  private getChannelSettingsNormalizationChanges(
    current: Pick<
      ChannelSettings,
      'autoPostButtonsMode' | 'postSuggestionsButtonEnabled' | 'postSuggestionsButtonUrl'
    >,
    normalized: Pick<
      ChannelSettings,
      'autoPostButtonsMode' | 'postSuggestionsButtonEnabled' | 'postSuggestionsButtonUrl'
    >,
  ): Partial<ChannelSettings> {
    const changes: Partial<ChannelSettings> = {};

    if (current.autoPostButtonsMode !== normalized.autoPostButtonsMode) {
      changes.autoPostButtonsMode = normalized.autoPostButtonsMode;
    }

    if (current.postSuggestionsButtonUrl !== normalized.postSuggestionsButtonUrl) {
      changes.postSuggestionsButtonUrl = normalized.postSuggestionsButtonUrl;
    }

    if (current.postSuggestionsButtonEnabled !== normalized.postSuggestionsButtonEnabled) {
      changes.postSuggestionsButtonEnabled = normalized.postSuggestionsButtonEnabled;
    }

    return changes;
  }

  private async assertChannelCommentAllowed(params: {
    chatId: string;
    threadId: string | null;
    authorUserId: string;
    text: string;
    settings: ChannelSettings;
  }): Promise<void> {
    const { chatId, threadId, authorUserId, text, settings } = params;

    if (settings.commentsBlockLinksEnabled && this.channelCommentContainsLink(text)) {
      throw new BadRequestException('Ссылки в комментариях отключены.');
    }

    const threadFilter = threadId
      ? {
          payload: {
            path: ['threadId'],
            equals: threadId,
          } satisfies Prisma.JsonFilter,
        }
      : {};

    const [recentThreadComments, recentOwnComments] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          chatId,
          action: CHANNEL_DIALOG_ACTION_COMMENT,
          ...threadFilter,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: CHANNEL_COMMENT_MAX_CONSECUTIVE,
      }),
      this.prisma.auditLog.findMany({
        where: {
          chatId,
          action: CHANNEL_DIALOG_ACTION_COMMENT,
          actorUserId: authorUserId,
          ...threadFilter,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 8,
      }),
    ]);

    if (
      settings.commentsLimitTwoInRowEnabled &&
      recentThreadComments.length >= CHANNEL_COMMENT_MAX_CONSECUTIVE &&
      recentThreadComments.every((row) => row.actorUserId === authorUserId)
    ) {
      throw new BadRequestException(
        'Нельзя оставлять больше двух комментариев подряд. Дайте другим ответить.',
      );
    }

    if (!settings.commentsAntiSpamEnabled) {
      return;
    }

    const normalizedCurrentText = this.normalizeChannelCommentText(text);
    const hasRecentDuplicate = recentOwnComments.some((row) => {
      if (Date.now() - row.createdAt.getTime() > CHANNEL_COMMENT_DUPLICATE_WINDOW_MS) {
        return false;
      }

      const payload = this.readObjectPayload(row.payload);
      const previousText = this.readTrimmedString(payload.text);
      return previousText
        ? this.normalizeChannelCommentText(previousText) === normalizedCurrentText
        : false;
    });

    if (hasRecentDuplicate) {
      throw new BadRequestException(
        'Одинаковые комментарии подряд отправлять нельзя. Напишите один комментарий без повтора.',
      );
    }
  }

  private mapChannelDialogAuditLog(
    row: { id: string; actorUserId: string; payload: Prisma.JsonValue; createdAt: Date },
    fallbackType: ChannelDialogType,
    currentUserId?: string | null,
    adminUserIds?: ReadonlySet<string>,
  ): ChannelDialogMessage {
    const payload = this.readObjectPayload(row.payload);
    const normalizedCurrentUserId = this.readTrimmedString(currentUserId);
    const rawType = this.readLowerString(payload.type);
    const type: ChannelDialogType =
      rawType === 'suggest' || rawType === 'comments' ? rawType : fallbackType;
    const authorDisplayName = this.readTrimmedString(payload.authorDisplayName);
    const avatarUrl = this.readTrimmedString(payload.authorAvatarUrl);
    const text = this.readTrimmedString(payload.text) ?? '';
    const textFormat = this.normalizeBroadcastTextFormat(
      this.readTrimmedString(payload.textFormat) ?? 'plain',
    );
    const editedAt = this.readTrimmedString(payload.editedAt);
    const replyTo = this.readDialogReplyPreview(payload.replyTo);
    const attachments = this.buildChannelDialogCommentAttachments(
      this.readChannelDialogAttachmentAssets(payload.attachments),
    );
    const delivered = payload.delivered === true;
    const deliveredToUserId = this.readTrimmedString(payload.deliveredToUserId);
    const reviewStatus = this.readChannelDialogSuggestionReviewStatus(payload.reviewStatus);
    const publishedUrl = this.readTrimmedString(payload.publishedUrl);
    const suggestionImages = this.normalizeChannelSuggestionImages({
      images: this.readChannelSuggestionImageAssets(payload.images),
      imageBase64: this.readTrimmedString(payload.imageBase64),
      imageMimeType: this.readTrimmedString(payload.imageMimeType),
      imageFileName: this.readTrimmedString(payload.imageFileName),
      mediaType: this.readChannelSuggestionMediaType(payload.mediaType),
      mediaPayload: this.readObjectPayloadOrNull(payload.mediaPayload),
      mediaMimeType: this.readTrimmedString(payload.mediaMimeType),
      mediaFileName: this.readTrimmedString(payload.mediaFileName),
    });
    const hasImage =
      payload.hasImage === true ||
      suggestionImages.length > 0 ||
      Boolean(this.readTrimmedString(payload.imageBase64));
    const imageFileNames = Array.from(
      new Set(
        suggestionImages
          .map((image) => image.fileName?.trim() ?? '')
          .filter((fileName): fileName is string => fileName.length > 0),
      ),
    );
    const legacyImageFileName = this.readTrimmedString(payload.imageFileName);
    const resolvedImageFileNames =
      imageFileNames.length > 0 ? imageFileNames : legacyImageFileName ? [legacyImageFileName] : [];
    const imageFileName = resolvedImageFileNames[0] ?? null;
    const imageCount = hasImage
      ? Math.max(
          suggestionImages.length,
          resolvedImageFileNames.length,
          this.toSafeInteger(payload.imageCount),
          this.readChannelSuggestionMediaType(payload.mediaType) === 'image' ? 1 : 0,
        )
      : 0;
    const hasVideo =
      payload.hasVideo === true ||
      this.readChannelSuggestionMediaType(payload.mediaType) === 'video';
    const videoFileName =
      this.readTrimmedString(payload.videoFileName) ??
      this.readTrimmedString(payload.mediaFileName);
    const isOwnMessage = normalizedCurrentUserId === row.actorUserId;
    const canDeleteAsAdmin =
      type === 'comments' &&
      !isOwnMessage &&
      Boolean(normalizedCurrentUserId && adminUserIds?.has(normalizedCurrentUserId));

    return {
      id: row.id,
      type,
      text,
      authorUserId: row.actorUserId,
      authorDisplayName,
      isAdmin: adminUserIds?.has(row.actorUserId) ?? false,
      avatarUrl: avatarUrl ?? null,
      createdAt: row.createdAt.toISOString(),
      editedAt: editedAt ?? null,
      replyToMessageId: replyTo?.messageId ?? null,
      replyTo: replyTo ?? null,
      attachments,
      reactionGroups: this.readDialogReactionGroups(payload.reactions, currentUserId),
      canEdit: type === 'comments' && isOwnMessage,
      canDelete: type === 'comments' && isOwnMessage,
      canDeleteAsAdmin,
      ...(type === 'suggest'
        ? {
            delivered,
            deliveredToUserId: deliveredToUserId ?? null,
            reviewStatus: reviewStatus ?? 'pending',
            publishedUrl: publishedUrl ?? null,
            textFormat,
            hasImage,
            imageCount,
            imageFileName,
            imageFileNames: resolvedImageFileNames,
            hasVideo,
            videoFileName: videoFileName ?? null,
          }
        : {}),
    };
  }

  private readChannelDialogAttachmentAssets(value: unknown): ChannelDialogAttachmentAsset[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.readChannelDialogAttachmentAsset(item))
      .filter((attachment): attachment is ChannelDialogAttachmentAsset => attachment !== null)
      .slice(0, MAX_CHANNEL_DIALOG_ATTACHMENTS);
  }

  private readChannelDialogAttachmentAsset(value: unknown): ChannelDialogAttachmentAsset | null {
    const row = this.readObjectPayloadOrNull(value);
    if (!row) {
      return null;
    }

    const mimeType = this.readTrimmedString(row.mimeType ?? row.mime_type);
    const fileName = this.readTrimmedString(row.fileName ?? row.file_name ?? row.filename);
    const kind = this.resolveChannelDialogAttachmentKind(row.kind ?? row.type, mimeType, fileName);
    if (!kind) {
      return null;
    }

    const payload = this.readObjectPayloadOrNull(row.payload);
    if (payload && Object.keys(payload).length > 0) {
      return {
        kind,
        payload,
        mimeType,
        fileName,
        previewBase64: this.readTrimmedString(row.previewBase64 ?? row.preview_base64),
        width: this.toSafeInteger(row.width ?? row.w),
        height: this.toSafeInteger(row.height ?? row.h),
      };
    }

    const base64 = this.readTrimmedString(row.base64);
    if (!base64) {
      return null;
    }

    return {
      kind,
      base64,
      mimeType,
      fileName,
      previewBase64: this.readTrimmedString(row.previewBase64 ?? row.preview_base64),
      width: this.toSafeInteger(row.width ?? row.w),
      height: this.toSafeInteger(row.height ?? row.h),
    };
  }

  private buildChannelDialogCommentAttachments(
    attachments: ChannelDialogAttachmentAsset[],
  ): ChannelDialogAttachment[] {
    return attachments
      .map((attachment) => this.mapChannelDialogAttachmentAsset(attachment))
      .filter((attachment): attachment is ChannelDialogAttachment => attachment !== null);
  }

  private mapChannelDialogAttachmentAsset(
    attachment: ChannelDialogAttachmentAsset,
  ): ChannelDialogAttachment | null {
    if (!attachment.payload || Object.keys(attachment.payload).length === 0) {
      return null;
    }

    const payload = attachment.payload;
    const fileName =
      this.readTrimmedString(
        attachment.fileName ??
          payload.file_name ??
          payload.fileName ??
          payload.filename ??
          payload.name,
      ) ?? null;
    const mimeType =
      this.readTrimmedString(attachment.mimeType ?? payload.mime_type ?? payload.mimeType) ?? null;
    const kind = this.resolveChannelDialogAttachmentKind(attachment.kind, mimeType, fileName);
    if (!kind) {
      return null;
    }
    const width = this.toSafeInteger(attachment.width ?? payload.width ?? payload.w);
    const height = this.toSafeInteger(attachment.height ?? payload.height ?? payload.h);
    const size = this.toSafeInteger(payload.size);
    const url = this.readTrimmedString(payload.url) ?? null;
    const previewBase64 = this.readTrimmedString(attachment.previewBase64 ?? payload.previewBase64);
    const previewUrl =
      url ||
      (kind === 'image' && previewBase64 && this.canBuildChannelDialogImagePreview(mimeType)
        ? `data:${mimeType};base64,${previewBase64}`
        : null);

    return {
      kind,
      url,
      previewUrl,
      fileName,
      mimeType,
      size: size > 0 ? size : null,
      width: width > 0 ? width : null,
      height: height > 0 ? height : null,
    };
  }

  private buildChannelDialogReplyPreviewText(payload: Record<string, unknown>): string {
    const text = this.readTrimmedString(payload.text);
    if (text) {
      return text;
    }

    return this.summarizeChannelDialogCommentAttachments(
      this.buildChannelDialogCommentAttachments(
        this.readChannelDialogAttachmentAssets(payload.attachments),
      ),
    );
  }

  private summarizeChannelDialogCommentAttachments(
    attachments: Pick<ChannelDialogAttachment, 'kind' | 'fileName'>[],
  ): string {
    if (attachments.length === 0) {
      return '';
    }

    const imageCount = attachments.filter((attachment) => attachment.kind === 'image').length;
    const files = attachments.filter((attachment) => attachment.kind === 'file');

    if (imageCount > 0 && files.length === 0) {
      if (imageCount > 1) {
        return `Фото · ${imageCount} шт.`;
      }
      const fileName = attachments
        .find((attachment) => attachment.kind === 'image')
        ?.fileName?.trim();
      return fileName ? `Фото · ${fileName}` : 'Фото';
    }

    if (files.length > 0 && imageCount === 0) {
      if (files.length > 1) {
        return `Файлы · ${files.length} шт.`;
      }
      const fileName = files[0]?.fileName?.trim();
      return fileName ? `Файл · ${fileName}` : 'Файл';
    }

    return `Вложения · ${attachments.length} шт.`;
  }

  private readChannelSuggestionImageAssets(value: unknown): ChannelSuggestionImageAsset[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.readChannelSuggestionImageAsset(item))
      .filter((image): image is ChannelSuggestionImageAsset => image !== null)
      .slice(0, MAX_CHANNEL_DIALOG_SUGGEST_IMAGES);
  }

  private readChannelSuggestionImageAsset(value: unknown): ChannelSuggestionImageAsset | null {
    const row = this.readObjectPayloadOrNull(value);
    if (!row) {
      return null;
    }

    const payload = this.readObjectPayloadOrNull(row.payload);
    if (payload && Object.keys(payload).length > 0) {
      return {
        payload,
        mimeType: this.readTrimmedString(row.mimeType),
        fileName: this.readTrimmedString(row.fileName),
      };
    }

    const base64 = this.readTrimmedString(row.base64);
    if (!base64) {
      return null;
    }

    return {
      base64,
      mimeType: this.readTrimmedString(row.mimeType),
      fileName: this.readTrimmedString(row.fileName),
    };
  }

  private readChannelSuggestionTextMarkup(value: unknown): ChannelSuggestionTextMarkup[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.readChannelSuggestionTextMarkupItem(item))
      .filter((item): item is ChannelSuggestionTextMarkup => item !== null);
  }

  private readChannelSuggestionTextMarkupItem(value: unknown): ChannelSuggestionTextMarkup | null {
    const row = this.readObjectPayloadOrNull(value);
    if (!row) {
      return null;
    }

    const type = this.readLowerString(row.type);
    const from = this.toSafeInteger(row.from);
    const length = this.toSafeInteger(row.length);
    if (
      !type ||
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
      type: type as ChannelSuggestionTextMarkup['type'],
      url: this.readTrimmedString(row.url),
      userLink: this.readTrimmedString(row.userLink ?? row.user_link),
    };
  }

  private normalizeChannelSuggestionImages(params: {
    images?: ChannelSuggestionImageAsset[] | null;
    imageBase64?: string | null;
    imageMimeType?: string | null;
    imageFileName?: string | null;
    mediaType?: 'image' | 'video' | null;
    mediaPayload?: Record<string, unknown> | null;
    mediaMimeType?: string | null;
    mediaFileName?: string | null;
  }): ChannelSuggestionImageAsset[] {
    const normalizedImages: ChannelSuggestionImageAsset[] = [];

    for (const image of params.images ?? []) {
      if (image.payload && Object.keys(image.payload).length > 0) {
        normalizedImages.push({
          payload: image.payload,
          mimeType: image.mimeType?.trim() || null,
          fileName: image.fileName?.trim() || null,
        });
      } else {
        const base64 = image.base64?.trim() ?? '';
        if (!base64) {
          continue;
        }

        normalizedImages.push({
          base64,
          mimeType: image.mimeType?.trim() || null,
          fileName: image.fileName?.trim() || null,
        });
      }

      if (normalizedImages.length >= MAX_CHANNEL_DIALOG_SUGGEST_IMAGES) {
        break;
      }
    }

    if (normalizedImages.length > 0) {
      return normalizedImages;
    }

    if (params.mediaType === 'image' && params.mediaPayload) {
      return [
        {
          payload: params.mediaPayload,
          mimeType: params.mediaMimeType?.trim() || null,
          fileName: params.mediaFileName?.trim() || null,
        },
      ];
    }

    const imageBase64 = params.imageBase64?.trim() ?? '';
    if (!imageBase64) {
      return [];
    }

    return [
      {
        base64: imageBase64,
        mimeType: params.imageMimeType?.trim() || null,
        fileName: params.imageFileName?.trim() || null,
      },
    ];
  }

  private readChannelDialogSuggestionReviewStatus(
    value: unknown,
  ): ChannelDialogSuggestionReviewStatus | null {
    const normalized = this.readLowerString(value);
    if (normalized === 'pending' || normalized === 'published' || normalized === 'cancelled') {
      return normalized;
    }

    return null;
  }

  private async resolveDialogReplyPreview(params: {
    chatId: string;
    entityType: ManagedEntityType;
    dialogType: ChannelDialogType;
    threadId: string | null;
    replyToMessageId: string | null | undefined;
  }): Promise<ChannelDialogReplyPreview | null> {
    const replyToMessageId = this.readTrimmedString(params.replyToMessageId);
    if (!replyToMessageId) {
      return null;
    }

    if (params.dialogType !== 'comments') {
      throw new BadRequestException('Ответ доступен только в комментариях.');
    }

    const row = await this.prisma.auditLog.findFirst({
      where: {
        id: replyToMessageId,
        chatId: params.chatId,
        action: this.resolveDialogAction(params.dialogType),
        ...(params.threadId
          ? {
              payload: {
                path: ['threadId'],
                equals: params.threadId,
              },
            }
          : {}),
      },
      select: {
        id: true,
        payload: true,
      },
    });

    if (!row) {
      throw new BadRequestException('Сообщение для ответа не найдено.');
    }

    const payload = this.readObjectPayload(row.payload);
    return {
      messageId: row.id,
      authorDisplayName: this.readTrimmedString(payload.authorDisplayName),
      text: this.buildChannelDialogReplyPreviewText(payload),
    };
  }

  private async resolveEntityDialogMessageTarget(params: {
    chatId: string;
    entityType: ManagedEntityType;
    dialogType: ChannelDialogType;
    messageId: string;
    token: string;
  }): Promise<{
    row: { id: string; actorUserId: string; payload: Prisma.JsonValue; createdAt: Date };
    payload: Record<string, unknown>;
    threadId: string | null;
  }> {
    const threadId =
      params.entityType === 'channel'
        ? this.dialogLinkHelper.resolveChannelDialogThreadId(
            params.chatId,
            params.dialogType,
            params.token,
          )
        : this.dialogLinkHelper.resolveChatDialogThreadId(
            params.chatId,
            params.dialogType,
            params.token,
          );
    const messageId = this.readTrimmedString(params.messageId);
    if (!messageId) {
      throw new BadRequestException('Комментарий не найден.');
    }

    const row = await this.prisma.auditLog.findFirst({
      where: {
        id: messageId,
        chatId: params.chatId,
        action: this.resolveDialogAction(params.dialogType),
        ...(threadId
          ? {
              payload: {
                path: ['threadId'],
                equals: threadId,
              },
            }
          : {}),
      },
      select: {
        id: true,
        actorUserId: true,
        payload: true,
        createdAt: true,
      },
    });

    if (!row) {
      throw new BadRequestException('Комментарий не найден.');
    }

    return {
      row,
      payload: this.readObjectPayload(row.payload),
      threadId,
    };
  }

  private async updateEntityDialogMessage(params: {
    chatId: string;
    entityType: ManagedEntityType;
    userId: string;
    dialogType: ChannelDialogType;
    messageId: string;
    token: string;
    text: string;
  }) {
    if (params.dialogType !== 'comments') {
      throw new BadRequestException('Редактирование доступно только в комментариях.');
    }

    const target = await this.resolveEntityDialogMessageTarget(params);
    if (target.row.actorUserId !== params.userId) {
      throw new ForbiddenException('Редактировать можно только свои комментарии.');
    }

    const text = params.text.trim();
    const existingAttachments = this.readChannelDialogAttachmentAssets(target.payload.attachments);
    if (!text && existingAttachments.length === 0) {
      throw new BadRequestException('Введите текст комментария или добавьте вложение.');
    }

    const updated = await this.prisma.auditLog.update({
      where: {
        id: target.row.id,
      },
      data: {
        payload: {
          ...target.payload,
          text,
          editedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        actorUserId: true,
        payload: true,
        createdAt: true,
      },
    });
    const adminUserIds = await this.readDialogAdminUserIds(params.chatId);

    return updateChannelDialogMessageResponseSchema.parse({
      ok: true,
      message: this.mapChannelDialogAuditLog(
        updated,
        params.dialogType,
        params.userId,
        adminUserIds,
      ),
    });
  }

  private async deleteEntityDialogMessage(params: {
    chatId: string;
    entityType: ManagedEntityType;
    userId: string;
    dialogType: ChannelDialogType;
    messageId: string;
    token: string;
  }) {
    if (params.dialogType !== 'comments') {
      throw new BadRequestException('Удаление доступно только в комментариях.');
    }

    const target = await this.resolveEntityDialogMessageTarget(params);
    if (target.row.actorUserId !== params.userId) {
      await this.assertChatAdmin(params.chatId, params.userId, params.entityType);
      await this.ensureEntityType(params.chatId, params.userId, params.entityType);
    }

    await this.prisma.auditLog.delete({
      where: {
        id: target.row.id,
      },
    });

    if (target.threadId) {
      await this.syncCommentsButtonCount({
        chatId: params.chatId,
        entityType: params.entityType,
        threadId: target.threadId,
      });
    }

    return deleteChannelDialogMessageResponseSchema.parse({
      ok: true,
      deletedMessageId: target.row.id,
    });
  }

  private async toggleEntityDialogReaction(params: {
    chatId: string;
    entityType: ManagedEntityType;
    userId: string;
    dialogType: ChannelDialogType;
    messageId: string;
    token: string;
    emoji: string;
  }) {
    if (params.dialogType !== 'comments') {
      throw new BadRequestException('Реакции доступны только в комментариях.');
    }

    const target = await this.resolveEntityDialogMessageTarget(params);
    const updated = await this.prisma.auditLog.update({
      where: {
        id: target.row.id,
      },
      data: {
        payload: {
          ...target.payload,
          reactions: this.toggleDialogReactionEntries(
            target.payload.reactions,
            params.emoji,
            params.userId,
          ),
        } as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        actorUserId: true,
        payload: true,
        createdAt: true,
      },
    });
    const adminUserIds =
      params.dialogType === 'comments'
        ? await this.readDialogAdminUserIds(params.chatId)
        : new Set<string>();

    return toggleChannelDialogReactionResponseSchema.parse({
      ok: true,
      message: this.mapChannelDialogAuditLog(
        updated,
        params.dialogType,
        params.userId,
        adminUserIds,
      ),
    });
  }

  private defaultDialogNotificationSettings(): ChannelDialogNotificationSettings {
    return {
      mode: 'off',
      canUseAll: true,
    };
  }

  private async readEntityDialogNotificationSettings(params: {
    entityType: ManagedEntityType;
    chatId: string;
    threadId: string | null;
    userId: string;
  }): Promise<ChannelDialogNotificationSettings> {
    const row = await this.prisma.dialogNotificationSubscription.findUnique({
      where: {
        entityType_chatId_threadId_userId: {
          entityType: toPrismaEntityType(params.entityType),
          chatId: params.chatId,
          threadId: this.normalizeDialogNotificationThreadId(params.threadId),
          userId: params.userId,
        },
      },
      select: {
        mode: true,
      },
    });

    return {
      mode: row ? this.fromPrismaDialogNotificationMode(row.mode) : 'off',
      canUseAll: true,
    };
  }

  private async upsertEntityDialogNotificationSubscription(params: {
    entityType: ManagedEntityType;
    chatId: string;
    threadId: string | null;
    userId: string;
    mode: ChannelDialogNotificationMode;
  }): Promise<ChannelDialogNotificationSettings> {
    const persistedMode = this.toPrismaDialogNotificationMode(params.mode);

    const row = await this.prisma.dialogNotificationSubscription.upsert({
      where: {
        entityType_chatId_threadId_userId: {
          entityType: toPrismaEntityType(params.entityType),
          chatId: params.chatId,
          threadId: this.normalizeDialogNotificationThreadId(params.threadId),
          userId: params.userId,
        },
      },
      create: {
        entityType: toPrismaEntityType(params.entityType),
        chatId: params.chatId,
        threadId: this.normalizeDialogNotificationThreadId(params.threadId),
        userId: params.userId,
        mode: persistedMode,
      },
      update: {
        mode: persistedMode,
      },
      select: {
        mode: true,
      },
    });

    return {
      mode: this.fromPrismaDialogNotificationMode(row.mode),
      canUseAll: true,
    };
  }

  private async ensureEntityDialogReplySubscription(params: {
    entityType: ManagedEntityType;
    chatId: string;
    threadId: string | null;
    userId: string;
  }): Promise<void> {
    try {
      await this.prisma.dialogNotificationSubscription.upsert({
        where: {
          entityType_chatId_threadId_userId: {
            entityType: toPrismaEntityType(params.entityType),
            chatId: params.chatId,
            threadId: this.normalizeDialogNotificationThreadId(params.threadId),
            userId: params.userId,
          },
        },
        create: {
          entityType: toPrismaEntityType(params.entityType),
          chatId: params.chatId,
          threadId: this.normalizeDialogNotificationThreadId(params.threadId),
          userId: params.userId,
          mode: PrismaDialogNotificationMode.REPLIES,
        },
        update: {},
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          entityType: params.entityType,
          userId: params.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to ensure comment dialog reply subscription',
      );
    }
  }

  private normalizeDialogNotificationThreadId(threadId: string | null | undefined): string {
    return this.readTrimmedString(threadId) ?? '';
  }

  private toPrismaDialogNotificationMode(
    mode: ChannelDialogNotificationMode,
  ): PrismaDialogNotificationMode {
    if (mode === 'all') {
      return PrismaDialogNotificationMode.ALL;
    }
    if (mode === 'off') {
      return PrismaDialogNotificationMode.OFF;
    }
    return PrismaDialogNotificationMode.REPLIES;
  }

  private fromPrismaDialogNotificationMode(value: unknown): ChannelDialogNotificationMode {
    const normalized = this.readTrimmedString(value)?.toUpperCase();
    if (normalized === PrismaDialogNotificationMode.ALL) {
      return 'all';
    }
    if (normalized === PrismaDialogNotificationMode.OFF) {
      return 'off';
    }
    return 'replies';
  }

  private async deliverEntityDialogCommentNotifications(params: {
    entityType: ManagedEntityType;
    chatId: string;
    threadId: string | null;
    messageId: string;
    authorUserId: string;
    authorDisplayName: string | null;
    text: string;
    attachmentCount: number;
    replyToMessageId: string | null;
  }): Promise<void> {
    const authorUserId = this.readTrimmedString(params.authorUserId);
    if (!authorUserId) {
      return;
    }

    const persistedEntityType = toPrismaEntityType(params.entityType);
    const threadId = this.normalizeDialogNotificationThreadId(params.threadId);
    const [replyTargetUserId, subscriptions] = await Promise.all([
      this.resolveCommentDialogReplyTargetUserId({
        chatId: params.chatId,
        threadId: params.threadId,
        replyToMessageId: params.replyToMessageId,
      }),
      this.prisma.dialogNotificationSubscription.findMany({
        where: {
          chatId: params.chatId,
          entityType: persistedEntityType,
          threadId,
        },
        select: {
          userId: true,
          mode: true,
        },
      }),
    ]);

    const subscriptionModes = new Map(
      subscriptions
        .map(
          (subscription) =>
            [this.readTrimmedString(subscription.userId), subscription.mode] as const,
        )
        .filter((entry): entry is readonly [string, PrismaDialogNotificationMode] =>
          Boolean(entry[0]),
        ),
    );
    const recipients = new Map<string, CommentDialogNotificationKind>();
    const normalizedReplyTargetUserId = this.readTrimmedString(replyTargetUserId);
    if (normalizedReplyTargetUserId && normalizedReplyTargetUserId !== authorUserId) {
      const targetMode = subscriptionModes.get(normalizedReplyTargetUserId);
      if (
        targetMode === PrismaDialogNotificationMode.REPLIES ||
        targetMode === PrismaDialogNotificationMode.ALL
      ) {
        recipients.set(normalizedReplyTargetUserId, 'reply');
      }
    }

    for (const subscription of subscriptions) {
      const userId = this.readTrimmedString(subscription.userId);
      if (
        !userId ||
        userId === authorUserId ||
        recipients.has(userId) ||
        subscription.mode !== PrismaDialogNotificationMode.ALL
      ) {
        continue;
      }
      recipients.set(userId, 'all');
    }

    if (recipients.size === 0) {
      return;
    }

    const routeBotId = await this.resolveBotAssignment(params.chatId);
    const deliveryBotId = this.resolvePrivateDeliveryBotId(routeBotId);
    const dialogUrl = this.buildEntityDialogNotificationUrl({
      entityType: params.entityType,
      chatId: params.chatId,
      threadId,
      botId: deliveryBotId,
    });
    if (!dialogUrl) {
      this.logger.warn(
        {
          chatId: params.chatId,
          entityType: params.entityType,
          threadId,
        },
        'Skipping comment dialog notifications without dialog url',
      );
      return;
    }

    const entityTarget = await this.resolveDialogNotificationEntityTarget({
      entityType: params.entityType,
      chatId: params.chatId,
      botId: deliveryBotId,
    });
    let postUrl: string | null = null;
    let postPreview: string | null = null;
    try {
      const postContext = await this.resolveDialogNotificationPostContext({
        entityType: params.entityType,
        chatId: params.chatId,
        threadId,
        botId: deliveryBotId,
      });
      postUrl = postContext.url;
      postPreview = postContext.preview;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: params.chatId,
          entityType: params.entityType,
          threadId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve comment notification post url',
      );
    }
    const preview = this.buildCommentDialogNotificationPreview(params.text, params.attachmentCount);
    const buttons: MaxMessageButton[][] = [
      [
        {
          type: 'link',
          text: 'Открыть комментарии',
          url: dialogUrl,
        },
      ],
    ];
    if (postUrl) {
      buttons.push([
        {
          type: 'link',
          text: 'Открыть пост',
          url: postUrl,
        },
      ]);
    }
    const recipientEntries = Array.from(recipients.entries()).map(([userId, kind]) => ({
      userId,
      kind,
    }));

    await mapWithConcurrencyLimit(
      recipientEntries,
      COMMENT_NOTIFICATION_DELIVERY_CONCURRENCY,
      async (recipient) => {
        try {
          await this.maxClient.sendMessageImmediateToUser(
            recipient.userId,
            this.buildCommentDialogNotificationText({
              kind: recipient.kind,
              entityType: params.entityType,
              entityTitle: entityTarget.title,
              entityLink: entityTarget.link,
              authorUserId,
              authorDisplayName: params.authorDisplayName,
              preview,
              postPreview,
              dialogUrl,
              postUrl,
            }),
            {
              buttons,
              textFormat: 'html',
            },
            {
              trafficClass: 'background',
              sourceTag: MAX_API_SOURCE_TAGS.COMMENT_NOTIFICATION,
              ...(deliveryBotId ? { botId: deliveryBotId } : {}),
            },
          );
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId: params.chatId,
              entityType: params.entityType,
              messageId: params.messageId,
              recipientUserId: recipient.userId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to deliver comment dialog notification',
          );
        }
      },
    );
  }

  private async resolveCommentDialogReplyTargetUserId(params: {
    chatId: string;
    threadId: string | null;
    replyToMessageId: string | null;
  }): Promise<string | null> {
    const replyToMessageId = this.readTrimmedString(params.replyToMessageId);
    if (!replyToMessageId) {
      return null;
    }

    const row = await this.prisma.auditLog.findFirst({
      where: {
        id: replyToMessageId,
        chatId: params.chatId,
        action: CHANNEL_DIALOG_ACTION_COMMENT,
        ...(params.threadId
          ? {
              payload: {
                path: ['threadId'],
                equals: params.threadId,
              },
            }
          : {}),
      },
      select: {
        actorUserId: true,
      },
    });

    return this.readTrimmedString(row?.actorUserId);
  }

  private async resolveDialogNotificationPostContext(params: {
    entityType: ManagedEntityType;
    chatId: string;
    threadId: string;
    botId?: string | null;
  }): Promise<{ url: string | null; preview: string | null }> {
    const actions =
      params.entityType === 'channel'
        ? [CHANNEL_DIALOG_ACTION_PUBLISH, CHANNEL_DIALOG_ACTION_AUTO_ATTACH]
        : [CHAT_DIALOG_ACTION_AUTO_ATTACH];

    const rows = await this.prisma.auditLog.findMany({
      where: {
        chatId: params.chatId,
        action: {
          in: actions,
        },
        payload: {
          path: ['threadId'],
          equals: params.threadId,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 5,
      select: {
        action: true,
        payload: true,
      },
    });

    let preview: string | null = null;
    for (const row of rows) {
      const payload = this.readObjectPayload(row.payload);
      preview ??= this.buildCommentDialogPostPreview(this.readRawString(payload.text));
      if (preview) {
        break;
      }
    }

    for (const row of rows) {
      const payload = this.readObjectPayload(row.payload);
      const persistedUrl = this.normalizeMaxEntityLink(this.readTrimmedString(payload.publishedUrl));
      if (persistedUrl) {
        if (!preview) {
          const messageId = this.resolveDialogNotificationPostPreviewMessageId(
            row.action,
            payload,
          );
          preview = messageId
            ? await this.resolveDialogNotificationPostMessagePreview(messageId, params.botId)
            : null;
        }
        return { url: persistedUrl, preview };
      }
    }

    for (const row of rows) {
      const payload = this.readObjectPayload(row.payload);
      const messageIds = this.resolveDialogNotificationPostMessageIds(row.action, payload);
      for (const messageId of messageIds) {
        const resolvedUrl = await this.resolveDialogNotificationMessageUrl(messageId, params.botId);
        if (resolvedUrl) {
          if (!preview) {
            const previewMessageId = this.resolveDialogNotificationPostPreviewMessageId(
              row.action,
              payload,
            );
            preview = previewMessageId
              ? await this.resolveDialogNotificationPostMessagePreview(
                  previewMessageId,
                  params.botId,
                )
              : null;
          }
          return { url: resolvedUrl, preview };
        }
      }
    }

    return { url: null, preview };
  }

  private resolveDialogNotificationPostMessageIds(
    action: string,
    payload: Record<string, unknown>,
  ): string[] {
    const candidates: Array<string | null> = [];
    if (action === CHANNEL_DIALOG_ACTION_PUBLISH) {
      candidates.push(this.readTrimmedString(payload.messageId));
      return this.uniqueDialogNotificationMessageIds(candidates);
    }

    const deliveryMode = this.readTrimmedString(payload.deliveryMode);
    if (deliveryMode === 'replace_with_bot_message') {
      candidates.push(
        this.readTrimmedString(payload.replacementMessageId),
        this.readTrimmedString(payload.messageId),
      );
      return this.uniqueDialogNotificationMessageIds(candidates);
    }

    if (deliveryMode === 'reply_message') {
      candidates.push(
        this.readTrimmedString(payload.messageId),
        this.readTrimmedString(payload.replyMessageId),
      );
      return this.uniqueDialogNotificationMessageIds(candidates);
    }

    candidates.push(this.readTrimmedString(payload.messageId));
    return this.uniqueDialogNotificationMessageIds(candidates);
  }

  private resolveDialogNotificationPostPreviewMessageId(
    action: string,
    payload: Record<string, unknown>,
  ): string | null {
    if (action === CHANNEL_DIALOG_ACTION_PUBLISH) {
      return this.readTrimmedString(payload.messageId);
    }

    const deliveryMode = this.readTrimmedString(payload.deliveryMode);
    if (deliveryMode === 'replace_with_bot_message') {
      return this.readTrimmedString(payload.replacementMessageId);
    }

    return this.readTrimmedString(payload.messageId);
  }

  private uniqueDialogNotificationMessageIds(candidates: Array<string | null>): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
      const messageId = this.readTrimmedString(candidate);
      if (!messageId || seen.has(messageId)) {
        continue;
      }
      seen.add(messageId);
      ids.push(messageId);
    }

    return ids;
  }

  private async resolveDialogNotificationMessageUrl(
    messageId: string,
    botId?: string | null,
  ): Promise<string | null> {
    const maxClient = this.maxClient as MaxClientService & {
      resolveMessageLink?: MaxClientService['resolveMessageLink'];
    };
    if (typeof maxClient.resolveMessageLink !== 'function') {
      return null;
    }

    try {
      return this.normalizeMaxEntityLink(
        await maxClient.resolveMessageLink(messageId, {
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.COMMENT_NOTIFICATION,
          ...(botId ? { botId } : {}),
        }),
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          messageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve comment notification post link',
      );
      return null;
    }
  }

  private async resolveDialogNotificationPostMessagePreview(
    messageId: string,
    botId?: string | null,
  ): Promise<string | null> {
    const maxClient = this.maxClient as MaxClientService & {
      getMessageTextAsMarkdown?: MaxClientService['getMessageTextAsMarkdown'];
    };
    if (typeof maxClient.getMessageTextAsMarkdown !== 'function') {
      return null;
    }

    try {
      return this.buildCommentDialogPostPreview(
        await maxClient.getMessageTextAsMarkdown(messageId, {
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.COMMENT_NOTIFICATION,
          ...(botId ? { botId } : {}),
        }),
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          messageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve comment notification post preview',
      );
      return null;
    }
  }

  private buildEntityDialogNotificationUrl(params: {
    entityType: ManagedEntityType;
    chatId: string;
    threadId: string;
    botId?: string | null;
  }): string | null {
    if (params.entityType === 'channel') {
      return (
        this.dialogLinkHelper.buildChannelDialogLaunchUrl(
          params.chatId,
          'comments',
          params.threadId,
          params.botId,
        ) ??
        this.dialogLinkHelper.buildChannelDialogDirectWebAppUrl(
          params.chatId,
          'comments',
          params.threadId,
        )
      );
    }

    return (
      this.dialogLinkHelper.buildChatDialogLaunchUrl(
        params.chatId,
        'comments',
        params.threadId,
        params.botId,
      ) ??
      this.dialogLinkHelper.buildChatDialogDirectWebAppUrl(
        params.chatId,
        'comments',
        params.threadId,
      )
    );
  }

  private async resolveDialogNotificationEntityTarget(params: {
    entityType: ManagedEntityType;
    chatId: string;
    botId?: string | null;
  }): Promise<{ title: string; link: string | null }> {
    const local = await this.prisma.chat.findUnique({
      where: { id: params.chatId },
      select: { title: true },
    });

    let title = resolvePresentableManagedEntityTitle(params.chatId, local?.title);
    let link: string | null = null;

    try {
      const cachedHeader = await this.chatContextCache.getManagedEntityHeader?.(
        params.chatId,
        params.entityType,
      );
      title ??= resolvePresentableManagedEntityTitle(params.chatId, cachedHeader?.title);
      link = this.normalizeMaxEntityLink(cachedHeader?.link) ?? link;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: params.chatId,
          entityType: params.entityType,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve cached comment notification entity link',
      );
    }

    if (!link) {
      try {
        const catalogRows = await this.prisma.managedBotChatCatalog.findMany({
          where: {
            chatId: params.chatId,
            status: 'ACTIVE',
          },
          orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
          take: 5,
          select: {
            title: true,
            link: true,
          },
        });

        for (const row of catalogRows) {
          title ??= resolvePresentableManagedEntityTitle(params.chatId, row.title);
          link = this.normalizeMaxEntityLink(row.link) ?? link;
          if (title && link) {
            break;
          }
        }
      } catch (error: unknown) {
        this.logger.debug(
          {
            chatId: params.chatId,
            entityType: params.entityType,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to resolve catalog comment notification entity link',
        );
      }
    }

    if (!title || !link) {
      try {
        const remoteSnapshot = await this.maxClient.getChatSnapshot(params.chatId, {
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.COMMENT_NOTIFICATION,
          ...(params.botId ? { botId: params.botId } : {}),
        });
        title ??= resolvePresentableManagedEntityTitle(params.chatId, remoteSnapshot.title);
        link = this.normalizeMaxEntityLink(remoteSnapshot.link) ?? link;
      } catch (error: unknown) {
        this.logger.debug(
          {
            chatId: params.chatId,
            entityType: params.entityType,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to resolve comment notification entity target',
        );
      }
    }

    return {
      title: title ?? `${params.entityType === 'channel' ? 'Канал' : 'Чат'} ${params.chatId}`,
      link,
    };
  }

  private normalizeMaxEntityLink(value: string | null | undefined): string | null {
    const normalized = this.readTrimmedString(value);
    if (!normalized) {
      return null;
    }

    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }

      const hostname = parsed.hostname.toLowerCase();
      if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
        return null;
      }

      parsed.hash = '';
      return parsed.toString();
    } catch {
      return null;
    }
  }

  private buildCommentDialogNotificationPreview(text: string, attachmentCount: number): string {
    const normalizedText = text.replace(/\s+/gu, ' ').trim();
    if (normalizedText) {
      const symbols = Array.from(normalizedText);
      if (symbols.length <= COMMENT_NOTIFICATION_PREVIEW_MAX_LENGTH) {
        return normalizedText;
      }
      return `${symbols
        .slice(0, COMMENT_NOTIFICATION_PREVIEW_MAX_LENGTH - 1)
        .join('')
        .trimEnd()}…`;
    }

    if (attachmentCount > 0) {
      return attachmentCount === 1 ? 'Вложение' : `Вложения: ${attachmentCount}`;
    }

    return 'Комментарий без текста';
  }

  private buildCommentDialogPostPreview(text: string | null): string | null {
    if (typeof text !== 'string') {
      return null;
    }

    for (const line of text.split(/\r\n|\r|\n/u)) {
      const normalizedLine = line.replace(/\s+/gu, ' ').trim();
      if (!normalizedLine) {
        continue;
      }

      const symbols = Array.from(normalizedLine);
      if (symbols.length <= COMMENT_NOTIFICATION_PREVIEW_MAX_LENGTH) {
        return normalizedLine;
      }
      return `${symbols
        .slice(0, COMMENT_NOTIFICATION_PREVIEW_MAX_LENGTH - 1)
        .join('')
        .trimEnd()}…`;
    }

    return null;
  }

  private buildCommentDialogNotificationText(params: {
    kind: CommentDialogNotificationKind;
    entityType: ManagedEntityType;
    entityTitle: string;
    entityLink: string | null;
    authorUserId: string;
    authorDisplayName: string | null;
    preview: string;
    postPreview: string | null;
    dialogUrl: string;
    postUrl: string | null;
  }): string {
    const authorName =
      this.readTrimmedString(params.authorDisplayName) ??
      this.readTrimmedString(params.authorUserId) ??
      'Пользователь';
    const authorLink = this.readTrimmedString(params.authorUserId)
      ? `<a href="max://user/${encodeURIComponent(params.authorUserId)}">${escapeHtml(
          authorName,
        )}</a>`
      : escapeHtml(authorName);
    const entityLabel = params.entityType === 'channel' ? 'Канал' : 'Чат';
    const entityTitle = escapeHtml(params.entityTitle);
    const entityTarget = params.entityLink
      ? `<a href="${escapeHtmlAttribute(params.entityLink)}">${entityTitle}</a>`
      : entityTitle;
    const title =
      params.kind === 'reply' ? 'Вам ответили в комментариях' : 'Новый комментарий в обсуждении';

    return [
      `<strong>${escapeHtml(title)}</strong>`,
      `${entityLabel}: ${entityTarget}`,
      ...(params.postPreview ? [`Пост: ${escapeHtml(params.postPreview)}`] : []),
      `${params.kind === 'reply' ? 'Ответил' : 'Автор'}: ${authorLink}`,
      `Комментарий: ${escapeHtml(params.preview)}`,
    ].join('\n');
  }

  private async readDialogAdminUserIds(chatId: string): Promise<Set<string>> {
    try {
      const resolvedBotId = await this.resolveBackgroundReadBotAssignment(chatId);
      return new Set(
        (
          await this.maxClient.getChatAdminIds(chatId, {
            trafficClass: 'interactive',
            actionHealthLane: 'background',
            ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
            ...(resolvedBotId ? { botId: resolvedBotId } : {}),
          })
        )
          .map((userId) => userId.trim())
          .filter((userId) => userId.length > 0),
      );
    } catch (error: unknown) {
      const persistedAdminIds = (
        await this.prisma.chatAdminAllowlist.findMany({
          where: { chatId },
          select: { userId: true },
        })
      )
        .map((row) => row.userId.trim())
        .filter((userId) => userId.length > 0);

      if (persistedAdminIds.length > 0) {
        this.logger.warn(
          {
            chatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Using persisted admin allowlist for dialog admin accents',
        );
        return new Set(persistedAdminIds);
      }

      this.logger.warn(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve admin ids for dialog messages',
      );
      return new Set();
    }
  }

  private async readPersistedDialogAdminUserIds(
    chatId: string,
    entityType: ManagedEntityType,
  ): Promise<Set<string>> {
    try {
      const persistedAdminIds = (
        await this.prisma.chatAdminAllowlist.findMany({
          where: { chatId },
          select: { userId: true },
        })
      )
        .map((row) => row.userId.trim())
        .filter((userId) => userId.length > 0);

      if (persistedAdminIds.length === 0) {
        this.scheduleDialogAdminRosterWarmup(chatId, entityType, 'persisted_allowlist_miss');
      }

      return new Set(persistedAdminIds);
    } catch (error: unknown) {
      this.scheduleDialogAdminRosterWarmup(chatId, entityType, 'persisted_allowlist_error');
      this.logger.warn(
        {
          chatId,
          entityType,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read persisted dialog admin ids',
      );
      return new Set<string>();
    }
  }

  private scheduleDialogAdminRosterWarmup(
    chatId: string,
    entityType: ManagedEntityType,
    reason: 'persisted_allowlist_miss' | 'persisted_allowlist_error',
  ): void {
    if (!this.maxChatAdminRosterSyncService) {
      return;
    }

    void this.maxChatAdminRosterSyncService
      .scheduleChatAdminRosterSync({
        chatId,
        entityType,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          {
            chatId,
            entityType,
            reason,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to schedule dialog admin roster warmup',
        );
      });
  }

  private channelCommentContainsLink(value: string): boolean {
    CHANNEL_COMMENT_LINK_PATTERN.lastIndex = 0;
    return CHANNEL_COMMENT_LINK_PATTERN.test(value);
  }

  private resolveDialogAction(dialogType: ChannelDialogType): string {
    return dialogType === 'comments'
      ? CHANNEL_DIALOG_ACTION_COMMENT
      : CHANNEL_DIALOG_ACTION_SUGGEST;
  }

  private normalizeChannelCommentText(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/gu, ' ');
  }

  private readDialogReplyPreview(value: unknown): ChannelDialogReplyPreview | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const messageId = this.readTrimmedString(row.messageId);
    const text = this.readTrimmedString(row.text);
    if (!messageId || !text) {
      return null;
    }

    return {
      messageId,
      authorDisplayName: this.readTrimmedString(row.authorDisplayName),
      text,
    };
  }

  private readDialogReactionGroups(
    value: unknown,
    currentUserId?: string | null,
  ): ChannelDialogReactionGroup[] {
    const normalizedCurrentUserId = this.readTrimmedString(currentUserId);
    return this.readDialogReactionEntries(value).map((entry) => ({
      emoji: entry.emoji,
      count: entry.userIds.length,
      reactedByMe: normalizedCurrentUserId
        ? entry.userIds.includes(normalizedCurrentUserId)
        : false,
    }));
  }

  private readDialogReactionEntries(value: unknown): Array<{ emoji: string; userIds: string[] }> {
    if (!Array.isArray(value)) {
      return [];
    }

    const grouped = new Map<string, Set<string>>();
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }

      const row = item as Record<string, unknown>;
      const emoji = this.readTrimmedString(row.emoji);
      if (!emoji) {
        continue;
      }

      const userIds = Array.isArray(row.userIds)
        ? row.userIds
            .map((userId) => this.readTrimmedString(userId))
            .filter((userId): userId is string => Boolean(userId))
        : [];
      if (userIds.length === 0) {
        continue;
      }

      const bucket = grouped.get(emoji) ?? new Set<string>();
      for (const userId of userIds) {
        bucket.add(userId);
      }
      grouped.set(emoji, bucket);
    }

    return Array.from(grouped.entries())
      .map(([emoji, userIds]) => ({
        emoji,
        userIds: Array.from(userIds),
      }))
      .sort(
        (left, right) =>
          right.userIds.length - left.userIds.length || left.emoji.localeCompare(right.emoji),
      );
  }

  private toggleDialogReactionEntries(
    currentValue: unknown,
    emojiRaw: string,
    userIdRaw: string,
  ): Array<{ emoji: string; userIds: string[] }> {
    const emoji = this.readTrimmedString(emojiRaw);
    const userId = this.readTrimmedString(userIdRaw);
    if (!emoji || !userId) {
      throw new BadRequestException('Реакцию не удалось обработать.');
    }

    const entries = this.readDialogReactionEntries(currentValue).map((entry) => ({
      emoji: entry.emoji,
      userIds: [...entry.userIds],
    }));
    const reactedEmoji = entries.find((entry) => entry.userIds.includes(userId))?.emoji ?? null;
    const clearedEntries = entries
      .map((entry) => ({
        emoji: entry.emoji,
        userIds: entry.userIds.filter((entryUserId) => entryUserId !== userId),
      }))
      .filter((entry) => entry.userIds.length > 0);

    if (reactedEmoji !== emoji) {
      const targetEntry = clearedEntries.find((entry) => entry.emoji === emoji);
      if (targetEntry) {
        targetEntry.userIds = Array.from(new Set([...targetEntry.userIds, userId]));
      } else {
        clearedEntries.push({
          emoji,
          userIds: [userId],
        });
      }
    }

    return clearedEntries.sort(
      (left, right) =>
        right.userIds.length - left.userIds.length || left.emoji.localeCompare(right.emoji),
    );
  }

  private readObjectPayload(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private readObjectPayloadOrNull(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private readTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private readRawString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private readLowerString(value: unknown): string | null {
    const normalized = this.readTrimmedString(value);
    return normalized ? normalized.toLowerCase() : null;
  }

  private async syncCommentsButtonCount(params: {
    chatId: string;
    entityType: ManagedEntityType;
    threadId: string;
  }): Promise<void> {
    const { chatId, entityType, threadId } = params;

    try {
      const count = await this.prisma.auditLog.count({
        where: {
          chatId,
          action: CHANNEL_DIALOG_ACTION_COMMENT,
          payload: {
            path: ['threadId'],
            equals: threadId,
          },
        },
      });

      if (entityType === 'channel') {
        await this.syncChannelCommentsButtonCount(chatId, threadId, count);
        return;
      }

      await this.syncChatCommentsButtonCount(chatId, threadId, count);
    } catch (error) {
      this.logger.warn(
        {
          chatId,
          entityType,
          threadId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to sync comments button count',
      );
    }
  }

  private async syncChannelCommentsButtonCount(
    chatId: string,
    threadId: string,
    count: number,
  ): Promise<void> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        chatId,
        action: {
          in: [CHANNEL_DIALOG_ACTION_PUBLISH, CHANNEL_DIALOG_ACTION_AUTO_ATTACH],
        },
        payload: {
          path: ['threadId'],
          equals: threadId,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        action: true,
        payload: true,
      },
    });

    for (const row of rows) {
      const payload = this.readObjectPayload(row.payload);
      if (row.action === CHANNEL_DIALOG_ACTION_PUBLISH) {
        const messageId = this.readTrimmedString(payload.messageId);
        const botId = this.readTrimmedString(payload.botId);
        const includeCommentsButton = payload.includeCommentsButton !== false;
        const includeSuggestButton = payload.includeSuggestButton === true;
        const suggestionEntryMode = this.readChannelSuggestionEntryMode(
          payload.suggestionEntryMode,
        );
        if (!messageId || (!includeCommentsButton && !includeSuggestButton)) {
          continue;
        }

        const buttons: MaxMessageButton[][] = [];

        if (includeCommentsButton) {
          buttons.push([
            this.buildChannelDialogButton(
              chatId,
              'comments',
              threadId,
              formatCommentsButtonText(this.readTrimmedString(payload.commentsButtonText), count),
              botId,
            ),
          ]);
        }

        if (includeSuggestButton) {
          buttons.push([
            this.buildChannelDialogButton(
              chatId,
              'suggest',
              threadId,
              this.readTrimmedString(payload.suggestButtonText) || '📰 Предложить пост',
              botId,
              suggestionEntryMode,
            ),
          ]);
        }

        await this.safeUpdateCommentsButton(chatId, messageId, buttons, 'channel', botId);
        continue;
      }

      if (row.action !== CHANNEL_DIALOG_ACTION_AUTO_ATTACH) {
        continue;
      }

      const messageId = this.resolveChannelCommentsTargetMessageId(payload);
      const botId = this.readTrimmedString(payload.botId);
      const includeCommentsButton = payload.includeCommentsButton !== false;
      const includeSuggestButton = payload.includeSuggestButton === true;
      const suggestionEntryMode = this.readChannelSuggestionEntryMode(payload.suggestionEntryMode);
      if (!messageId || (!includeCommentsButton && !includeSuggestButton)) {
        continue;
      }

      const buttons: MaxMessageButton[][] = [];

      if (includeCommentsButton) {
        buttons.push([
          this.buildChannelDialogButton(
            chatId,
            'comments',
            threadId,
            formatCommentsButtonText('💬 Комментарии', count),
            botId,
          ),
        ]);
      }

      if (includeSuggestButton) {
        buttons.push([
          this.buildChannelDialogButton(
            chatId,
            'suggest',
            threadId,
            this.readTrimmedString(payload.suggestButtonText) || '📰 Предложить пост',
            botId,
            suggestionEntryMode,
          ),
        ]);
      }

      await this.safeUpdateCommentsButton(chatId, messageId, buttons, 'channel', botId);
    }
  }

  private resolveChannelCommentsTargetMessageId(payload: Record<string, unknown>): string | null {
    const deliveryMode = this.readTrimmedString(payload.deliveryMode);

    if (deliveryMode === 'replace_with_bot_message') {
      return this.readTrimmedString(payload.replacementMessageId);
    }

    if (deliveryMode === 'reply_message') {
      return this.readTrimmedString(payload.replyMessageId);
    }

    return this.readTrimmedString(payload.messageId);
  }

  private async syncChatCommentsButtonCount(
    chatId: string,
    threadId: string,
    count: number,
  ): Promise<void> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        chatId,
        action: CHAT_DIALOG_ACTION_AUTO_ATTACH,
        payload: {
          path: ['threadId'],
          equals: threadId,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        action: true,
        payload: true,
      },
    });

    for (const row of rows) {
      if (row.action !== CHAT_DIALOG_ACTION_AUTO_ATTACH) {
        continue;
      }

      const payload = this.readObjectPayload(row.payload);
      const messageId = this.resolveChatCommentsTargetMessageId(payload);
      const botId = this.readTrimmedString(payload.botId);
      if (!messageId) {
        continue;
      }

      await this.safeUpdateCommentsButton(
        chatId,
        messageId,
        [
          [
            this.dialogLinkHelper.buildChatDialogButton(
              chatId,
              'comments',
              threadId,
              formatCommentsButtonText('💬 Комментарии', count),
              botId,
            ),
          ],
        ],
        'chat',
        botId,
      );
    }
  }

  private resolveChatCommentsTargetMessageId(payload: Record<string, unknown>): string | null {
    const deliveryMode = this.readTrimmedString(payload.deliveryMode);

    if (deliveryMode === 'replace_with_bot_message') {
      return this.readTrimmedString(payload.replacementMessageId);
    }

    if (deliveryMode === 'reply_message') {
      return this.readTrimmedString(payload.replyMessageId);
    }

    return this.readTrimmedString(payload.messageId);
  }

  private async safeUpdateCommentsButton(
    chatId: string,
    messageId: string,
    buttons: MaxMessageButton[][],
    entityType: ManagedEntityType,
    botId?: string | null,
  ): Promise<void> {
    try {
      const resolvedBotId =
        this.maxBotRegistry?.getBotById(botId)?.id ??
        this.readTrimmedString(botId) ??
        (await this.resolveDeliveryBotAssignment(chatId));
      if (resolvedBotId) {
        await this.maxClient.editMessageInlineKeyboard(
          chatId,
          messageId,
          null,
          {
            buttons,
          },
          { botId: resolvedBotId },
        );
      } else {
        await this.maxClient.editMessageInlineKeyboard(chatId, messageId, null, {
          buttons,
        });
      }
    } catch (error) {
      this.logger.warn(
        {
          chatId,
          entityType,
          messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh comments button counter',
      );
    }
  }

  private async createChannelSuggestionAuditLog(params: {
    chatId: string;
    user: AuthUser;
    threadId: string | null;
    source: ChannelDialogMessageSource;
    text: string;
    textFormat?: BroadcastTextFormat | null;
    textMarkup?: ChannelSuggestionTextMarkup[] | null;
    images?: ChannelSuggestionImageAsset[] | null;
    imageBase64?: string | null;
    imageMimeType?: string | null;
    imageFileName?: string | null;
    mediaType?: 'image' | 'video' | null;
    mediaPayload?: Record<string, unknown> | null;
    mediaMimeType?: string | null;
    mediaFileName?: string | null;
  }): Promise<{
    row: { id: string; actorUserId: string; payload: Prisma.JsonValue; createdAt: Date };
    delivered: boolean;
    deliveredToUserId: string | null;
    queued: boolean;
  }> {
    const normalizedImages = this.normalizeChannelSuggestionImages({
      images: params.images,
      imageBase64: params.imageBase64,
      imageMimeType: params.imageMimeType,
      imageFileName: params.imageFileName,
      mediaType: params.mediaType,
      mediaPayload: params.mediaPayload,
      mediaMimeType: params.mediaMimeType,
      mediaFileName: params.mediaFileName,
    });
    const imageFileNames = normalizedImages
      .map((image) => image.fileName?.trim() ?? '')
      .filter((fileName): fileName is string => fileName.length > 0);

    const created = await this.prisma.auditLog.create({
      data: {
        chatId: params.chatId,
        actorUserId: params.user.userId,
        action: CHANNEL_DIALOG_ACTION_SUGGEST,
        payload: {
          type: 'suggest',
          threadId: params.threadId,
          text: params.text,
          ...(params.textFormat === 'markdown' ? { textFormat: params.textFormat } : {}),
          ...(params.textMarkup && params.textMarkup.length > 0
            ? { textMarkup: params.textMarkup as Prisma.InputJsonValue }
            : {}),
          actorUserId: params.user.userId,
          authorDisplayName: this.resolveChannelSuggestionActorDisplayName(params.user),
          authorAvatarUrl: this.readTrimmedString(params.user.avatarUrl) ?? null,
          delivered: false,
          deliveredToUserId: null,
          deliveredToUserIds: [],
          deliveries: [],
          source: params.source,
          reviewStatus: 'pending',
          hasImage: normalizedImages.length > 0,
          imageCount: normalizedImages.length,
          imageFileNames,
          images: normalizedImages as Prisma.InputJsonValue,
          hasVideo: params.mediaType === 'video',
          imageBase64: null,
          imageMimeType: null,
          imageFileName: imageFileNames[0] ?? null,
          mediaType: params.mediaType ?? null,
          mediaPayload: (params.mediaPayload ?? null) as Prisma.InputJsonValue | null,
          mediaMimeType: params.mediaMimeType ?? null,
          mediaFileName: params.mediaFileName ?? null,
        },
      },
      select: {
        id: true,
        actorUserId: true,
        payload: true,
        createdAt: true,
      },
    });

    if (await this.enqueueChannelSuggestionDelivery(created.id)) {
      return {
        row: created,
        delivered: false,
        deliveredToUserId: null,
        queued: true,
      };
    }

    const delivery = await this.deliverSuggestionToAdminPrivates(
      created.id,
      params.chatId,
      params.user,
      {
        text: params.text,
        ...(params.textFormat ? { textFormat: params.textFormat } : {}),
        ...(params.textMarkup ? { textMarkup: params.textMarkup } : {}),
        images: normalizedImages,
        imageBase64: params.imageBase64,
        imageMimeType: params.imageMimeType,
        imageFileName: params.imageFileName,
        mediaType: params.mediaType,
        mediaPayload: params.mediaPayload,
        mediaMimeType: params.mediaMimeType,
        mediaFileName: params.mediaFileName,
      },
    );
    const updated = await this.applyChannelSuggestionDeliveryResult(created, delivery);

    return {
      row: updated,
      delivered: delivery.delivered,
      deliveredToUserId: delivery.deliveredToUserId,
      queued: false,
    };
  }

  async processChannelSuggestionDeliveryJob(auditLogId: string): Promise<void> {
    const normalizedAuditLogId = auditLogId.trim();
    if (!normalizedAuditLogId) {
      return;
    }

    const row = await this.prisma.auditLog.findUnique({
      where: { id: normalizedAuditLogId },
      select: {
        id: true,
        chatId: true,
        actorUserId: true,
        action: true,
        payload: true,
        createdAt: true,
      },
    });
    if (!row || row.action !== CHANNEL_DIALOG_ACTION_SUGGEST) {
      return;
    }

    const payload = this.readObjectPayload(row.payload);
    const reviewStatus = this.readLowerString(payload.reviewStatus);
    if (reviewStatus && reviewStatus !== 'pending') {
      return;
    }

    const alreadyDelivered = payload.delivered === true;
    if (alreadyDelivered || this.readChannelSuggestionDeliveries(payload.deliveries).length > 0) {
      return;
    }

    const delivery = await this.deliverSuggestionToAdminPrivates(
      row.id,
      row.chatId,
      {
        userId: row.actorUserId,
        username: null,
        displayName: this.readTrimmedString(payload.authorDisplayName),
        avatarUrl: this.readTrimmedString(payload.authorAvatarUrl),
      },
      {
        text: this.readRawString(payload.text) ?? '',
        textFormat: this.normalizeBroadcastTextFormat(
          this.readTrimmedString(payload.textFormat) ?? 'plain',
        ),
        textMarkup: this.readChannelSuggestionTextMarkup(payload.textMarkup),
        images: this.readChannelSuggestionImageAssets(payload.images),
        imageBase64: this.readTrimmedString(payload.imageBase64),
        imageMimeType: this.readTrimmedString(payload.imageMimeType),
        imageFileName: this.readTrimmedString(payload.imageFileName),
        mediaType: this.readChannelSuggestionMediaType(payload.mediaType),
        mediaPayload: this.readObjectPayloadOrNull(payload.mediaPayload),
        mediaMimeType: this.readTrimmedString(payload.mediaMimeType),
        mediaFileName: this.readTrimmedString(payload.mediaFileName),
      },
    );
    await this.applyChannelSuggestionDeliveryResult(row, delivery);
  }

  private resolveChannelSuggestionActorDisplayName(user: ChannelSuggestionActor): string | null {
    return user.displayName?.trim() || user.username?.trim() || null;
  }

  private async enqueueChannelSuggestionDelivery(auditLogId: string): Promise<boolean> {
    if (!this.adminSuggestionDeliveryQueue) {
      return false;
    }

    try {
      await this.adminSuggestionDeliveryQueue.add(
        'deliver-channel-suggestion',
        {
          auditLogId,
        },
        {
          jobId: `channel-suggestion-delivery__${auditLogId}`,
          attempts: 5,
          removeOnComplete: true,
          removeOnFail: false,
          backoff: {
            type: 'exponential',
            delay: 1_000,
          },
        },
      );
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          auditLogId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to enqueue channel suggestion delivery',
      );
      return false;
    }
  }

  private async applyChannelSuggestionDeliveryResult(
    row: { id: string; actorUserId: string; payload: Prisma.JsonValue; createdAt: Date },
    delivery: {
      delivered: boolean;
      deliveredToUserId: string | null;
      deliveredToUserIds: string[];
      deliveries: ChannelSuggestionAdminDelivery[];
    },
  ) {
    const createdPayload = this.readObjectPayload(row.payload);
    return this.prisma.auditLog.update({
      where: {
        id: row.id,
      },
      data: {
        payload: {
          ...createdPayload,
          delivered: delivery.delivered,
          deliveredToUserId: delivery.deliveredToUserId,
          deliveredToUserIds: delivery.deliveredToUserIds,
          deliveries: delivery.deliveries,
        } as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        actorUserId: true,
        payload: true,
        createdAt: true,
      },
    });
  }

  private async assertChannelSuggestionDailyLimit(
    chatId: string,
    userId: string,
    settings: Pick<ChannelSettings, 'postSuggestionsDailyLimit'>,
  ): Promise<void> {
    const limit = Math.max(1, Math.min(10, Math.trunc(settings.postSuggestionsDailyLimit)));
    const recentSuggestionsCount = await this.prisma.auditLog.count({
      where: {
        chatId,
        actorUserId: userId,
        action: CHANNEL_DIALOG_ACTION_SUGGEST,
        createdAt: {
          gte: new Date(Date.now() - TWENTY_FOUR_HOURS_MS),
        },
      },
    });

    if (recentSuggestionsCount >= limit) {
      throw new BadRequestException(
        `Лимит предложек для этого канала исчерпан: ${limit} за последние 24 часа. Попробуйте позже.`,
      );
    }
  }

  private async deliverSuggestionToAdminPrivates(
    suggestionId: string,
    chatId: string,
    user: ChannelSuggestionActor,
    suggestion: ChannelSuggestionDeliveryInput,
  ): Promise<{
    delivered: boolean;
    deliveredToUserId: string | null;
    deliveredToUserIds: string[];
    deliveries: ChannelSuggestionAdminDelivery[];
  }> {
    const deliveryBotId = await this.resolveAssistBotAssignment(chatId, 'suggestion_delivery');
    const privateDeliveryBotId = this.resolvePrivateDeliveryBotId(deliveryBotId);
    const knownBotUserIds = await this.resolveKnownBotUserIdsForChat(chatId, [deliveryBotId]);
    const adminIds = Array.from(
      new Set(
        (
          await this.maxClient.getChatAdminIds(chatId, {
            trafficClass: 'background',
            ...(deliveryBotId ? { botId: deliveryBotId } : {}),
          })
        ).filter(
          (id) =>
            id.trim().length > 0 &&
            !knownBotUserIds.has(id.trim()) &&
            !this.dialogLinkHelper.isOwnBotUserId(id),
        ),
      ),
    );

    if (adminIds.length === 0) {
      return {
        delivered: false,
        deliveredToUserId: null,
        deliveredToUserIds: [],
        deliveries: [],
      };
    }

    const channelTitle = await this.resolveChannelTitle(chatId);
    const actorName = this.resolveChannelSuggestionActorDisplayName(user) ?? `user:${user.userId}`;
    const buttons = this.buildChannelSuggestionAdminReviewButtons(suggestionId);
    const baseMessageOptions = await this.buildChannelSuggestionMessageOptions(
      suggestion,
      buttons,
      privateDeliveryBotId,
    );
    const messagePayload = this.buildChannelSuggestionAdminMessagePayload({
      status: 'pending',
      channelTitle,
      actorName,
      actorUserId: user.userId,
      text: suggestion.text,
      textFormat: suggestion.textFormat ?? 'plain',
      textMarkup: suggestion.textMarkup ?? [],
      reviewedBy: null,
      publishedUrl: null,
    });
    const messageOptions = {
      ...baseMessageOptions,
      textFormat: messagePayload.textFormat,
    } satisfies Pick<
      MaxSendMessageOptions,
      'buttons' | 'imagePayload' | 'attachments' | 'textFormat'
    >;
    const deliveries: ChannelSuggestionAdminDelivery[] = [];
    const deliveredAdminUserIds: string[] = [];

    for (const adminUserId of adminIds) {
      let privateChatId: string | null = null;
      try {
        privateChatId = await this.findLatestPrivateChatIdForUser(
          adminUserId,
          privateDeliveryBotId,
        );
        const published = await this.sendChannelSuggestionAdminMessageWithRetry({
          adminUserId,
          privateChatId,
          message: messagePayload.text,
          options: messageOptions,
          ...(privateDeliveryBotId ? { botId: privateDeliveryBotId } : {}),
        });

        deliveredAdminUserIds.push(adminUserId);
        privateChatId =
          this.readTrimmedString(published.chatId) ??
          privateChatId ??
          (await this.findLatestPrivateChatIdForUser(adminUserId, privateDeliveryBotId));

        if (!privateChatId) {
          this.logger.warn(
            {
              chatId,
              adminUserId,
              suggestionId,
              messageId: published.messageId,
            },
            'Delivered suggestion to admin user but could not resolve private chat id',
          );
          continue;
        }

        deliveries.push({
          adminUserId,
          privateChatId,
          messageId: published.messageId,
          ...(privateDeliveryBotId ? { botId: privateDeliveryBotId } : {}),
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            suggestionId,
            chatId,
            adminUserId,
            privateChatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to deliver suggestion to admin private chat',
        );
      }
    }

    return {
      delivered: deliveredAdminUserIds.length > 0,
      deliveredToUserId: deliveredAdminUserIds[0] ?? null,
      deliveredToUserIds: deliveredAdminUserIds,
      deliveries,
    };
  }

  private buildChannelSuggestionAdminReviewButtons(suggestionId: string): MaxMessageButton[][] {
    return [
      [
        {
          type: 'callback',
          text: '📰 В публикацию',
          payload: this.buildPrivateControlCallbackPayload(
            'suggestion_review_publish',
            suggestionId,
          ),
          intent: 'positive',
        },
        {
          type: 'callback',
          text: '✖️ Отклонить',
          payload: this.buildPrivateControlCallbackPayload(
            'suggestion_review_cancel',
            suggestionId,
          ),
          intent: 'negative',
        },
      ],
    ];
  }

  private buildPrivateControlCallbackPayload(action: string, ...args: string[]): string {
    const normalizedArgs = args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
    return [PRIVATE_CONTROL_CALLBACK_PREFIX, action, ...normalizedArgs].join('|');
  }

  private buildChannelSuggestionAdminMessagePayload(params: {
    status: 'pending' | 'published' | 'cancelled';
    channelTitle: string;
    actorName: string;
    actorUserId: string;
    text: string;
    textFormat: BroadcastTextFormat;
    textMarkup: ChannelSuggestionTextMarkup[];
    reviewedBy: string | null;
    publishedUrl: string | null;
  }): {
    text: string;
    textFormat: MaxSendMessageOptions['textFormat'];
  } {
    const hasMeaningfulText = params.text.trim().length > 0;
    const title =
      params.status === 'published'
        ? '✅ Предложка опубликована'
        : params.status === 'cancelled'
          ? '✖️ Предложка отклонена'
          : '📰 Новая предложка';
    const normalizedActorUserId = params.actorUserId.trim();
    const richTextHtml = hasMeaningfulText
      ? this.renderChannelSuggestionTextHtml(params.text, params.textMarkup, params.textFormat)
      : null;

    if (richTextHtml) {
      const senderLine = normalizedActorUserId
        ? `<a href="max://user/${encodeURIComponent(normalizedActorUserId)}">${escapeHtml(
            params.actorName,
          )}</a>`
        : escapeHtml(params.actorName);

      return {
        text: [
          `<strong>${escapeHtml(title)}</strong>`,
          '',
          `Канал: ${escapeHtml(params.channelTitle)}`,
          `Отправитель: ${senderLine}`,
          ...(normalizedActorUserId
            ? [`MAX ID: <code>${escapeHtml(normalizedActorUserId)}</code>`]
            : []),
          ...(params.reviewedBy ? [`Решение принял: ${escapeHtml(params.reviewedBy)}`] : []),
          ...(params.publishedUrl
            ? [
                `<a href="${escapeHtmlAttribute(params.publishedUrl)}">${escapeHtml(
                  params.publishedUrl,
                )}</a>`,
              ]
            : []),
          '',
          '━━━━━━━━━━━━',
          '<strong>Контент публикации</strong>',
          richTextHtml,
        ].join('\n'),
        textFormat: 'html',
      };
    }

    const senderLine = normalizedActorUserId
      ? `[${this.escapeMarkdown(params.actorName)}](max://user/${encodeURIComponent(normalizedActorUserId)})`
      : this.escapeMarkdown(params.actorName);

    return {
      text: [
        this.markdownTitle(title),
        '',
        `Канал: ${this.escapeMarkdown(params.channelTitle)}`,
        `Отправитель: ${senderLine}`,
        ...(normalizedActorUserId
          ? [`MAX ID: \`${this.escapeMarkdown(normalizedActorUserId)}\``]
          : []),
        ...(params.reviewedBy ? [`Решение принял: ${this.escapeMarkdown(params.reviewedBy)}`] : []),
        ...(params.publishedUrl ? [params.publishedUrl] : []),
        '',
        '━━━━━━━━━━━━',
        this.markdownTitle('Контент публикации'),
        ...(hasMeaningfulText
          ? [this.renderSuggestionTextForMarkdown(params.text, params.textFormat)]
          : ['_Медиа без подписи. Смотрите вложение выше._']),
      ].join('\n'),
      textFormat: 'markdown',
    };
  }

  private async publishStoredChannelSuggestion(
    chatId: string,
    payload: Record<string, unknown>,
  ): Promise<{
    messageId: string | null;
    url: string | null;
    threadId: string | null;
    includeCommentsButton: boolean;
    includeSuggestButton: boolean;
    suggestButtonText: string | null;
    autoPostButtonsMode: ChannelSettings['autoPostButtonsMode'];
    suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'];
    botId: string | null;
  }> {
    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);
    const text = this.readRawString(payload.text) ?? '';
    const media = await this.resolveChannelSuggestionAttachments(
      {
        images: this.readChannelSuggestionImageAssets(payload.images),
        imageBase64: this.readTrimmedString(payload.imageBase64),
        imageMimeType: this.readTrimmedString(payload.imageMimeType),
        imageFileName: this.readTrimmedString(payload.imageFileName),
        mediaType: this.readChannelSuggestionMediaType(payload.mediaType),
        mediaPayload: this.readObjectPayloadOrNull(payload.mediaPayload),
        mediaMimeType: this.readTrimmedString(payload.mediaMimeType),
        mediaFileName: this.readTrimmedString(payload.mediaFileName),
      },
      resolvedBotId,
    );
    const buttonContext = await this.buildPublishedChannelSuggestionButtonContext(
      chatId,
      payload,
      resolvedBotId,
    );
    const textFormat = this.normalizeBroadcastTextFormat(
      this.readTrimmedString(payload.textFormat) ?? 'plain',
    );
    const textMarkup = this.readChannelSuggestionTextMarkup(payload.textMarkup);
    const messageTextPayload = this.buildPublishedChannelSuggestionMessagePayload(
      payload,
      text,
      textFormat,
      textMarkup,
    );

    if (!text.trim() && !media.imagePayload && !media.attachments?.length) {
      throw new BadRequestException('В предложке нет текста или медиа для публикации.');
    }

    const messageOptions: Pick<
      MaxSendMessageOptions,
      'buttons' | 'imagePayload' | 'attachments' | 'textFormat'
    > = {
      ...(buttonContext.buttons.length > 0 ? { buttons: buttonContext.buttons } : {}),
      ...(media.imagePayload ? { imagePayload: media.imagePayload } : {}),
      ...(media.attachments?.length ? { attachments: media.attachments } : {}),
      textFormat: messageTextPayload.textFormat,
    };
    const published = await this.publishMessageWithRetry(
      chatId,
      messageTextPayload.text,
      messageOptions,
      resolvedBotId,
    );

    return {
      messageId: published.messageId,
      url: published.url,
      threadId: buttonContext.threadId,
      includeCommentsButton: buttonContext.includeCommentsButton,
      includeSuggestButton: buttonContext.includeSuggestButton,
      suggestButtonText: buttonContext.suggestButtonText,
      autoPostButtonsMode: buttonContext.autoPostButtonsMode,
      suggestionEntryMode: buttonContext.suggestionEntryMode,
      botId: resolvedBotId ?? null,
    };
  }

  private buildPublishedChannelSuggestionMessagePayload(
    payload: Record<string, unknown>,
    suggestionText: string,
    textFormat: BroadcastTextFormat,
    textMarkup: ChannelSuggestionTextMarkup[],
  ): {
    text: string;
    textFormat: MaxSendMessageOptions['textFormat'];
  } {
    const actorUserId = this.readTrimmedString(payload.actorUserId);
    const actorName = this.readTrimmedString(payload.authorDisplayName) ?? actorUserId ?? '';
    const hasMeaningfulSuggestionText = suggestionText.trim().length > 0;
    const richTextHtml = hasMeaningfulSuggestionText
      ? this.renderChannelSuggestionTextHtml(suggestionText, textMarkup, textFormat)
      : null;

    if (richTextHtml) {
      const attribution = actorUserId
        ? `От подписчика <a href="max://user/${encodeURIComponent(actorUserId)}">${escapeHtml(
            actorName || 'подписчика',
          )}</a>`
        : actorName
          ? `От подписчика ${escapeHtml(actorName)}`
          : 'От подписчика';

      return {
        text: hasMeaningfulSuggestionText ? `${attribution}\n\n${richTextHtml}` : attribution,
        textFormat: 'html',
      };
    }

    const attribution = actorUserId
      ? `От подписчика [${this.escapeMarkdown(actorName || 'подписчика')}](max://user/${encodeURIComponent(actorUserId)})`
      : actorName
        ? `От подписчика ${this.escapeMarkdown(actorName)}`
        : 'От подписчика';

    return {
      text: hasMeaningfulSuggestionText
        ? `${attribution}\n\n${this.renderSuggestionTextForMarkdown(suggestionText, textFormat)}`
        : attribution,
      textFormat: 'markdown',
    };
  }

  private async buildPublishedChannelSuggestionButtonContext(
    chatId: string,
    payload: Record<string, unknown>,
    botId?: string | null,
  ): Promise<{
    buttons: MaxMessageButton[][];
    threadId: string | null;
    includeCommentsButton: boolean;
    includeSuggestButton: boolean;
    suggestButtonText: string | null;
    autoPostButtonsMode: ChannelSettings['autoPostButtonsMode'];
    suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'];
  }> {
    const settings = await this.getPublicChannelSettings(chatId);
    const includeCommentsButton = settings.commentsEnabled;
    const includeSuggestButton = settings.postSuggestionsEnabled;
    const autoPostButtonsMode = this.normalizeChannelAutoPostButtonsMode(settings);

    if (!includeCommentsButton && !includeSuggestButton) {
      return {
        buttons: [],
        threadId: null,
        includeCommentsButton,
        includeSuggestButton,
        suggestButtonText: null,
        autoPostButtonsMode,
        suggestionEntryMode: settings.postSuggestionsEntryMode,
      };
    }

    // A published channel post must have its own dialog thread.
    // Reusing the suggestion thread mixes comments between the source post/suggestion
    // and the newly published post.
    const threadId = randomUUID();
    const suggestButtonText = settings.postSuggestionsButtonText.trim() || '📰 Предложить пост';
    const buttons: MaxMessageButton[][] = [];

    if (includeCommentsButton) {
      buttons.push([
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
      buttons.push([
        this.buildChannelDialogButton(
          chatId,
          'suggest',
          threadId,
          suggestButtonText,
          botId,
          settings.postSuggestionsEntryMode,
        ),
      ]);
    }

    return {
      buttons,
      threadId,
      includeCommentsButton,
      includeSuggestButton,
      suggestButtonText: includeSuggestButton ? suggestButtonText : null,
      autoPostButtonsMode,
      suggestionEntryMode: settings.postSuggestionsEntryMode,
    };
  }

  private async syncChannelSuggestionAdminReviewMessages(
    chatId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const deliveries = this.readChannelSuggestionDeliveries(payload.deliveries);
    if (deliveries.length === 0) {
      return;
    }

    const channelTitle = await this.resolveChannelTitle(chatId);
    const actorUserId = this.readTrimmedString(payload.actorUserId) ?? '';
    const actorName =
      this.readTrimmedString(payload.authorDisplayName) || actorUserId || 'Пользователь';
    const reviewedBy = this.readTrimmedString(payload.reviewedByDisplayName);
    const reviewStatus =
      this.readLowerString(payload.reviewStatus) === 'published' ? 'published' : 'cancelled';
    const textMarkup = this.readChannelSuggestionTextMarkup(payload.textMarkup);
    const messagePayload = this.buildChannelSuggestionAdminMessagePayload({
      status: reviewStatus,
      channelTitle,
      actorName,
      actorUserId,
      text: this.readRawString(payload.text) ?? '',
      textFormat: this.normalizeBroadcastTextFormat(
        this.readTrimmedString(payload.textFormat) ?? 'plain',
      ),
      textMarkup,
      reviewedBy,
      publishedUrl: this.readTrimmedString(payload.publishedUrl),
    });

    for (const delivery of deliveries) {
      try {
        const deliveryBotId = this.resolvePrivateDeliveryBotId(delivery.botId);
        if (deliveryBotId) {
          await this.maxClient.editMessageInlineKeyboard(
            delivery.privateChatId,
            delivery.messageId,
            messagePayload.text,
            {
              buttons: [],
              textFormat: messagePayload.textFormat,
            },
            { botId: deliveryBotId },
          );
        } else {
          await this.maxClient.editMessageInlineKeyboard(
            delivery.privateChatId,
            delivery.messageId,
            messagePayload.text,
            {
              buttons: [],
              textFormat: messagePayload.textFormat,
            },
          );
        }
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            adminUserId: delivery.adminUserId,
            privateChatId: delivery.privateChatId,
            messageId: delivery.messageId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to sync reviewed suggestion message in admin private chat',
        );
      }
    }
  }

  private readChannelSuggestionDeliveries(value: unknown): ChannelSuggestionAdminDelivery[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return null;
        }

        const row = item as Record<string, unknown>;
        const adminUserId = this.readTrimmedString(row.adminUserId);
        const privateChatId = this.readTrimmedString(row.privateChatId);
        const messageId = this.readTrimmedString(row.messageId);
        const botId = this.resolvePrivateDeliveryBotId(this.readTrimmedString(row.botId));
        if (!adminUserId || !privateChatId || !messageId) {
          return null;
        }

        return {
          adminUserId,
          privateChatId,
          messageId,
          ...(botId ? { botId } : {}),
        };
      })
      .filter((entry): entry is ChannelSuggestionAdminDelivery => entry !== null);
  }

  private markdownTitle(title: string): string {
    return `**${this.escapeMarkdown(title)}**`;
  }

  private renderChannelSuggestionTextHtml(
    value: string,
    textMarkup: ChannelSuggestionTextMarkup[],
    textFormat: BroadcastTextFormat | null | undefined,
  ): string | null {
    if (textMarkup.length > 0) {
      return renderMaxTextMarkupAsHtml(value, textMarkup) ?? escapeHtmlPreservingWhitespace(value);
    }

    if (textFormat === 'markdown') {
      return renderSupportedMarkdownAsHtml(value, {
        blockMode: 'raw',
      });
    }

    return null;
  }

  private renderSuggestionTextForMarkdown(
    value: string,
    textFormat: BroadcastTextFormat | null | undefined,
  ): string {
    return textFormat === 'markdown' ? value : this.escapeMarkdownPlainText(value);
  }

  private escapeMarkdown(value: string): string {
    return value.replace(/([\\_*[\]()`])/g, '\\$1');
  }

  private escapeMarkdownPlainText(value: string): string {
    return value.replace(/([\\`*_[\]()~+#])/g, '\\$1');
  }

  private parseChannelSuggestionFromBotPayload(body: unknown): ChannelSuggestionFromBotPayload {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Некорректная предложка.');
    }

    const row = body as Record<string, unknown>;
    const token = this.readTrimmedString(row.token);
    if (!token || token.length < 16 || token.length > 256) {
      throw new BadRequestException('Неверный токен предложки.');
    }

    const text = this.readRawString(row.text) ?? '';
    if (text.length > 2_000) {
      throw new BadRequestException('Текст предложки слишком длинный.');
    }

    const rawImages = Array.isArray(row.images) ? row.images : [];
    if (rawImages.length > MAX_CHANNEL_DIALOG_SUGGEST_IMAGES) {
      throw new BadRequestException(
        `В одной предложке можно отправить до ${MAX_CHANNEL_DIALOG_SUGGEST_IMAGES} фото.`,
      );
    }

    const images = this.readChannelSuggestionImageAssets(row.images);
    const textFormat = this.normalizeBroadcastTextFormat(
      this.readTrimmedString(row.textFormat) ?? 'plain',
    );
    const textMarkup = this.readChannelSuggestionTextMarkup(row.textMarkup);
    const imageBase64 = this.readTrimmedString(row.imageBase64);
    const imageMimeType = this.readTrimmedString(row.imageMimeType);
    const imageFileName = this.readTrimmedString(row.imageFileName);
    const mediaType = this.readChannelSuggestionMediaType(row.mediaType);
    const mediaPayload = this.readObjectPayloadOrNull(row.mediaPayload);
    const mediaMimeType = this.readTrimmedString(row.mediaMimeType);
    const mediaFileName = this.readTrimmedString(row.mediaFileName);

    if (!text.trim() && images.length === 0 && !imageBase64 && !mediaPayload) {
      throw new BadRequestException('Пришлите текст, фото, видео или подпись к медиа.');
    }

    if (images.length > 0 && mediaType === 'video') {
      throw new BadRequestException(
        'В одной предложке можно отправить либо фото, либо одно видео.',
      );
    }

    if (imageBase64 && (!imageMimeType || !imageMimeType.toLowerCase().startsWith('image/'))) {
      throw new BadRequestException('Фото предложки передано в неверном формате.');
    }

    if (
      images.some(
        (image) =>
          image.mimeType &&
          image.mimeType.trim().length > 0 &&
          !image.mimeType.toLowerCase().startsWith('image/'),
      )
    ) {
      throw new BadRequestException('Фото предложки передано в неверном формате.');
    }

    if ((mediaType && !mediaPayload) || (!mediaType && mediaPayload)) {
      throw new BadRequestException('Медиа предложки передано в неполном формате.');
    }

    if (
      mediaType === 'image' &&
      mediaMimeType &&
      !mediaMimeType.toLowerCase().startsWith('image/')
    ) {
      throw new BadRequestException('Фото предложки передано в неверном формате.');
    }

    if (
      mediaType === 'video' &&
      mediaMimeType &&
      !mediaMimeType.toLowerCase().startsWith('video/')
    ) {
      throw new BadRequestException('Видео предложки передано в неверном формате.');
    }

    return {
      token,
      images,
      text,
      textFormat,
      textMarkup,
      imageBase64,
      imageMimeType,
      imageFileName,
      mediaType,
      mediaPayload,
      mediaMimeType,
      mediaFileName,
    };
  }

  private canBuildChannelDialogImagePreview(mimeType: string | null | undefined): boolean {
    const normalized = mimeType?.trim().toLowerCase() ?? '';
    return (
      normalized === 'image/bmp' ||
      normalized === 'image/gif' ||
      normalized === 'image/jpeg' ||
      normalized === 'image/png' ||
      normalized === 'image/webp'
    );
  }

  private normalizeMaxUploadImageMimeType(mimeType: string | null | undefined): string {
    const normalized = mimeType?.trim().toLowerCase() ?? '';
    if (normalized === 'image/jpg' || normalized === 'image/pjpeg') {
      return 'image/jpeg';
    }
    if (normalized === 'image/x-png') {
      return 'image/png';
    }
    return normalized;
  }

  private isSupportedMaxUploadImageMimeType(mimeType: string | null | undefined): boolean {
    const normalized = this.normalizeMaxUploadImageMimeType(mimeType);
    return (
      normalized === 'image/bmp' ||
      normalized === 'image/gif' ||
      normalized === 'image/heic' ||
      normalized === 'image/jpeg' ||
      normalized === 'image/png' ||
      normalized === 'image/tiff'
    );
  }

  private normalizeChannelDialogCommentInputAttachments(
    attachments: Array<{
      type: 'image' | 'file';
      base64: string;
      mimeType: string;
      fileName: string;
      width?: number;
      height?: number;
    }>,
  ): ChannelDialogAttachmentAsset[] {
    return attachments
      .map((attachment) => {
        const mimeType = attachment.mimeType.trim();
        const fileName = attachment.fileName.trim();
        const kind =
          this.resolveChannelDialogAttachmentKind(attachment.type, mimeType, fileName) ??
          attachment.type;

        return {
          kind,
          base64: attachment.base64.trim(),
          mimeType,
          fileName,
          width: this.toSafeInteger(attachment.width),
          height: this.toSafeInteger(attachment.height),
        };
      })
      .filter((attachment) => attachment.base64)
      .slice(0, MAX_CHANNEL_DIALOG_ATTACHMENTS);
  }

  private async uploadChannelDialogCommentAttachments(
    chatId: string,
    attachments: ChannelDialogAttachmentAsset[],
  ): Promise<ChannelDialogAttachmentAsset[]> {
    if (attachments.length === 0) {
      return [];
    }

    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);
    const uploaded: ChannelDialogAttachmentAsset[] = [];

    for (const attachment of attachments) {
      const normalized = await this.uploadChannelDialogCommentAttachment(attachment, resolvedBotId);
      if (normalized) {
        uploaded.push(normalized);
      }
    }

    return uploaded;
  }

  private async uploadChannelDialogCommentAttachment(
    attachment: ChannelDialogAttachmentAsset,
    botId?: string,
  ): Promise<ChannelDialogAttachmentAsset | null> {
    const base64 = attachment.base64?.trim() ?? '';
    if (!base64) {
      return null;
    }

    const kind =
      this.resolveChannelDialogAttachmentKind(
        attachment.kind,
        attachment.mimeType,
        attachment.fileName,
      ) ?? attachment.kind;
    const mimeType =
      kind === 'image'
        ? this.normalizeMaxUploadImageMimeType(attachment.mimeType) || 'image/jpeg'
        : attachment.mimeType?.trim().toLowerCase() || 'application/octet-stream';
    if (kind === 'image' && !mimeType.startsWith('image/')) {
      throw new BadRequestException('Фото комментария передано в неверном формате.');
    }
    if (kind === 'image' && !this.isSupportedMaxUploadImageMimeType(mimeType)) {
      throw new BadRequestException(
        'MAX пока не принимает этот формат фото. Используйте JPG, PNG, GIF, TIFF, BMP или HEIC.',
      );
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      throw new BadRequestException(
        kind === 'image'
          ? 'Не удалось прочитать фото комментария.'
          : 'Не удалось прочитать файл комментария.',
      );
    }

    if (buffer.length === 0) {
      throw new BadRequestException(
        kind === 'image'
          ? 'Фото комментария оказалось пустым.'
          : 'Файл комментария оказался пустым.',
      );
    }

    const fileName =
      this.readTrimmedString(attachment.fileName) ||
      (kind === 'image'
        ? this.resolveBroadcastImageFileName('', mimeType)
        : 'comment-attachment.bin');

    try {
      const payload =
        kind === 'image'
          ? botId
            ? await this.maxClient.uploadImage(buffer, fileName, mimeType, { botId })
            : await this.maxClient.uploadImage(buffer, fileName, mimeType)
          : botId
            ? await this.maxClient.uploadFile(buffer, fileName, mimeType, { botId })
            : await this.maxClient.uploadFile(buffer, fileName, mimeType);

      return {
        kind,
        payload,
        mimeType,
        fileName,
        previewBase64:
          kind === 'image' &&
          this.canBuildChannelDialogImagePreview(mimeType) &&
          !this.readTrimmedString(payload.url)
            ? base64
            : undefined,
        width: attachment.width ?? null,
        height: attachment.height ?? null,
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          kind,
          mimeType,
          fileName,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to upload channel dialog attachment',
      );
      throw new BadRequestException(
        kind === 'image'
          ? 'Не удалось загрузить фото комментария.'
          : 'Не удалось загрузить файл комментария.',
      );
    }
  }

  private resolveChannelDialogAttachmentKind(
    kind: unknown,
    mimeType?: string | null,
    fileName?: string | null,
  ): 'image' | 'file' | null {
    const normalizedKind = this.readLowerString(kind);
    if (
      normalizedKind === 'image' ||
      normalizedKind === 'photo' ||
      normalizedKind === 'picture' ||
      this.isChannelDialogImageLikeAttachment(mimeType, fileName)
    ) {
      return 'image';
    }

    if (normalizedKind === 'file' || normalizedKind === 'document' || normalizedKind === 'doc') {
      return 'file';
    }

    return null;
  }

  private isChannelDialogImageLikeAttachment(
    mimeType?: string | null,
    fileName?: string | null,
  ): boolean {
    return this.isChannelDialogImageMimeType(mimeType) || this.isLikelyImageFileName(fileName);
  }

  private isChannelDialogImageMimeType(value?: string | null): boolean {
    const normalized = this.readLowerString(value);
    return Boolean(normalized && normalized.startsWith('image/') && normalized !== 'image/svg+xml');
  }

  private isLikelyImageFileName(value?: string | null): boolean {
    return Boolean(value && /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(value));
  }

  private async uploadChannelSuggestionImage(
    suggestion: {
      imageBase64?: string | null;
      imageMimeType?: string | null;
      imageFileName?: string | null;
    },
    botId?: string,
  ): Promise<Record<string, unknown> | undefined> {
    const imageBase64 = suggestion.imageBase64?.trim() ?? '';
    if (!imageBase64) {
      return undefined;
    }

    const mimeType = suggestion.imageMimeType?.trim().toLowerCase() || 'image/jpeg';
    if (!mimeType.startsWith('image/')) {
      throw new BadRequestException('Фото предложки передано в неверном формате.');
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = Buffer.from(imageBase64, 'base64');
    } catch {
      throw new BadRequestException('Не удалось прочитать фото предложки.');
    }

    if (imageBuffer.length === 0) {
      throw new BadRequestException('Фото предложки оказалось пустым.');
    }

    const fileName =
      this.readTrimmedString(suggestion.imageFileName) ||
      this.resolveBroadcastImageFileName('', mimeType);

    try {
      return botId
        ? await this.maxClient.uploadImage(imageBuffer, fileName, mimeType, { botId })
        : await this.maxClient.uploadImage(imageBuffer, fileName, mimeType);
    } catch (error: unknown) {
      this.logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          mimeType,
        },
        'Failed to upload channel suggestion image',
      );
      throw new BadRequestException('Не удалось загрузить фото предложки.');
    }
  }

  private async resolveChannelSuggestionAttachments(
    suggestion: {
      images?: ChannelSuggestionImageAsset[] | null;
      imageBase64?: string | null;
      imageMimeType?: string | null;
      imageFileName?: string | null;
      mediaType?: 'image' | 'video' | null;
      mediaPayload?: Record<string, unknown> | null;
      mediaMimeType?: string | null;
      mediaFileName?: string | null;
    },
    botId?: string,
  ): Promise<{
    imagePayload?: Record<string, unknown>;
    attachments?: MaxAttachmentPayload[];
  }> {
    const normalizedImages = this.normalizeChannelSuggestionImages({
      images: suggestion.images,
      imageBase64: suggestion.imageBase64,
      imageMimeType: suggestion.imageMimeType,
      imageFileName: suggestion.imageFileName,
      mediaType: suggestion.mediaType,
      mediaPayload: suggestion.mediaPayload,
      mediaMimeType: suggestion.mediaMimeType,
      mediaFileName: suggestion.mediaFileName,
    });

    if (normalizedImages.length === 1) {
      const [image] = normalizedImages;
      const payload =
        image.payload && Object.keys(image.payload).length > 0
          ? image.payload
          : await this.uploadChannelSuggestionImage(
              {
                imageBase64: image.base64 ?? null,
                imageMimeType: image.mimeType ?? null,
                imageFileName: image.fileName ?? null,
              },
              botId,
            );

      return payload ? { imagePayload: payload } : {};
    }

    if (normalizedImages.length > 1) {
      const attachments: MaxAttachmentPayload[] = [];

      for (const image of normalizedImages) {
        const payload =
          image.payload && Object.keys(image.payload).length > 0
            ? image.payload
            : await this.uploadChannelSuggestionImage(
                {
                  imageBase64: image.base64 ?? null,
                  imageMimeType: image.mimeType ?? null,
                  imageFileName: image.fileName ?? null,
                },
                botId,
              );

        if (!payload) {
          continue;
        }

        attachments.push({
          type: 'image',
          payload,
        });
      }

      return attachments.length > 0 ? { attachments } : {};
    }

    if (suggestion.mediaType && suggestion.mediaPayload) {
      return suggestion.mediaType === 'image'
        ? {
            imagePayload: suggestion.mediaPayload,
          }
        : {
            attachments: [
              {
                type: suggestion.mediaType,
                payload: suggestion.mediaPayload,
              },
            ],
          };
    }

    const uploadedImagePayload = await this.uploadChannelSuggestionImage(
      {
        imageBase64: suggestion.imageBase64,
        imageMimeType: suggestion.imageMimeType,
        imageFileName: suggestion.imageFileName,
      },
      botId,
    );

    return uploadedImagePayload ? { imagePayload: uploadedImagePayload } : {};
  }

  private async buildChannelSuggestionMessageOptions(
    suggestion: {
      images?: ChannelSuggestionImageAsset[] | null;
      imageBase64?: string | null;
      imageMimeType?: string | null;
      imageFileName?: string | null;
      mediaType?: 'image' | 'video' | null;
      mediaPayload?: Record<string, unknown> | null;
      mediaMimeType?: string | null;
      mediaFileName?: string | null;
    },
    buttons: MaxMessageButton[][],
    botId?: string,
  ): Promise<
    Pick<MaxSendMessageOptions, 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'>
  > {
    const media = await this.resolveChannelSuggestionAttachments(suggestion, botId);
    return {
      buttons,
      ...(media.imagePayload ? { imagePayload: media.imagePayload } : {}),
      ...(media.attachments?.length ? { attachments: media.attachments } : {}),
      textFormat: 'markdown',
    };
  }

  private async sendChannelSuggestionAdminMessageWithRetry(params: {
    adminUserId: string;
    privateChatId: string | null;
    message: string;
    options: Pick<MaxSendMessageOptions, 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'>;
    botId?: string;
  }) {
    let lastError: unknown = null;
    let privateChatId = params.privateChatId;
    const attempts =
      Math.max(
        this.hasRetriableMaxAttachment(params.options)
          ? BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS.length
          : 0,
        BROADCAST_THROTTLE_RETRY_DELAYS_MS.length,
      ) + 1;

    for (let attempt = 1; attempt <= attempts; ) {
      try {
        return privateChatId
          ? await this.maxClient.sendMessageImmediateWithId(
              privateChatId,
              params.message,
              params.options,
              {
                trafficClass: 'background',
                ...(params.botId ? { botId: params.botId } : {}),
              },
            )
          : await this.maxClient.sendMessageImmediateToUser(
              params.adminUserId,
              params.message,
              params.options,
              {
                trafficClass: 'background',
                ...(params.botId ? { botId: params.botId } : {}),
              },
            );
      } catch (error: unknown) {
        lastError = error;
        if (privateChatId && isPrivateDialogChatUnavailableError(error)) {
          privateChatId = null;
          continue;
        }
        const retryDelayMs = this.resolveManagedBroadcastSendRetryDelayMs(
          error,
          attempt,
          params.options,
        );
        if (retryDelayMs === null) {
          throw error;
        }
        await this.sleep(retryDelayMs);
        attempt += 1;
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('Suggestion admin delivery failed without error details.');
  }

  private readChannelSuggestionMediaType(value: unknown): 'image' | 'video' | null {
    const normalized = this.readLowerString(value);
    if (normalized === 'image' || normalized === 'video') {
      return normalized;
    }

    return null;
  }

  private async findLatestPrivateChatIdForUser(
    userId: string,
    botId?: string | null,
  ): Promise<string | null> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return null;
    }

    const resolvedBotId = this.maxBotRegistry?.getBotById(botId)?.id ?? botId?.trim() ?? null;
    const botFilter = resolvedBotId ? Prisma.sql`AND bot_id = ${resolvedBotId}` : Prisma.empty;

    const rows = await this.prisma.$queryRaw<Array<{ recipient_chat_id: string | null }>>(
      Prisma.sql`
        SELECT
          COALESCE(raw_payload->'message'->'recipient'->>'chat_id', raw_payload->'message'->>'chat_id') AS recipient_chat_id
        FROM webhook_events
        WHERE COALESCE(raw_payload->'message'->'sender'->>'user_id', raw_payload->'message'->>'sender_id') = ${normalizedUserId}
          AND COALESCE(raw_payload->'message'->'recipient'->>'chat_id', raw_payload->'message'->>'chat_id') ~ '^[0-9]+$'
          ${botFilter}
        ORDER BY created_at DESC
        LIMIT 1
      `,
    );

    if (!rows[0]?.recipient_chat_id) {
      return null;
    }

    return rows[0].recipient_chat_id.trim();
  }

  private async resolvePrivateDialogChatId(
    user: AuthUser,
    botId?: string | null,
  ): Promise<string | null> {
    const resolvedBotId =
      this.resolvePrivateDeliveryBotId(botId) ??
      this.maxBotRegistry?.getBotById(botId)?.id ??
      botId?.trim() ??
      null;
    const currentChatId = user.chatId?.trim() ?? '';
    const activeContextBotId = this.maxBotLinkService?.getContextOrDefaultBotId?.() ?? null;
    if (
      currentChatId &&
      /^[0-9]+$/u.test(currentChatId) &&
      (!resolvedBotId || !activeContextBotId || activeContextBotId === resolvedBotId)
    ) {
      return currentChatId;
    }

    return this.findLatestPrivateChatIdForUser(user.userId, resolvedBotId);
  }

  private async sendRulesPublishedPrivateConfirmation(
    user: AuthUser,
    publishedUrl: string | null,
  ): Promise<void> {
    const privateDeliveryBotId = this.resolvePrivateDeliveryBotId();
    const privateChatId = await this.resolvePrivateDialogChatId(user, privateDeliveryBotId);
    if (!privateChatId) {
      return;
    }

    const message = publishedUrl
      ? `✅ Правила опубликованы.\n${publishedUrl}`
      : '✅ Правила опубликованы.';

    try {
      await this.maxClient.sendMessage(privateChatId, message, undefined, {
        immediate: true,
        ...(privateDeliveryBotId ? { botId: privateDeliveryBotId } : {}),
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId: user.userId,
          privateChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to send private confirmation after rules publish',
      );
    }
  }

  private async resolveChannelTitle(chatId: string): Promise<string> {
    const local = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { title: true },
    });
    if (local?.title?.trim()) {
      return local.title.trim();
    }

    const remote = await this.maxClient.getChatTitle(chatId);
    if (remote?.trim()) {
      return remote.trim();
    }

    return `Канал ${chatId}`;
  }

  private buildChannelSuggestionStartPayload(chatId: string, threadId: string): string {
    return this.dialogLinkHelper.buildChannelSuggestionStartPayload(chatId, threadId);
  }

  private buildEntityDialogToken(
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId?: string | null,
  ): string {
    return this.dialogLinkHelper.buildEntityDialogToken(entityType, chatId, type, threadId);
  }

  private resolveChannelDialogThreadId(
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ): string | null {
    return this.dialogLinkHelper.resolveChannelDialogThreadId(chatId, type, token);
  }

  private resolveChatDialogThreadId(
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ): string | null {
    return this.dialogLinkHelper.resolveChatDialogThreadId(chatId, type, token);
  }

  private resolvePrivateDeliveryBotId(botId?: string | null): string | undefined {
    const explicitBotId = this.maxBotRegistry?.getBotById(botId)?.id ?? botId?.trim() ?? undefined;
    if (explicitBotId) {
      return explicitBotId;
    }

    return (
      this.maxBotLinkService?.getContextOrDefaultBotId?.() ??
      this.maxBotRegistry?.getDefaultBot?.().id ??
      this.ownBotUserId ??
      undefined
    );
  }

  private buildResolvedBotAssignmentData(resolvedBotId?: string | null): {
    botId?: string;
    primaryBotId?: string;
  } {
    const normalizedBotId =
      this.maxBotRegistry?.getBotById(resolvedBotId)?.id ??
      (typeof resolvedBotId === 'string' && resolvedBotId.trim().length > 0
        ? resolvedBotId.trim()
        : null);
    if (!normalizedBotId) {
      return {};
    }

    return {
      botId: normalizedBotId,
      primaryBotId: normalizedBotId,
    };
  }

  private async resolveUnifiedBotRoute(request: MaxBotRouteRequest): Promise<MaxBotRoute | null> {
    const routeResolver = this.maxBotLinkService as unknown as {
      resolveBotRoute?: (request: MaxBotRouteRequest) => Promise<MaxBotRoute>;
      resolveBotRoutes?: (request: MaxBotRouteRequest) => Promise<MaxBotRoute>;
    };
    if (
      request.purpose === 'moderation_action' &&
      typeof routeResolver?.resolveBotRoutes === 'function'
    ) {
      return routeResolver.resolveBotRoutes(request);
    }

    if (typeof routeResolver?.resolveBotRoute === 'function') {
      return routeResolver.resolveBotRoute(request);
    }

    return null;
  }

  private async resolveBotAssignment(chatId: string): Promise<string | undefined> {
    const route = await this.resolveUnifiedBotRoute({
      purpose: 'read',
      chatId,
    });
    if (route?.botId) {
      return route.botId;
    }

    return (
      (await this.maxBotLinkService?.resolveBotIdForRead?.({ chatId })) ??
      (await this.maxBotLinkService?.resolveBotId?.({ chatId })) ??
      undefined
    );
  }

  private async resolveChatBotIdForRead(chatId: string): Promise<string | undefined> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return undefined;
    }

    const persisted = await this.prisma.chat.findUnique({
      where: { id: normalizedChatId },
      select: { primaryBotId: true, botId: true },
    });
    const persistedBotId =
      this.maxBotRegistry?.getBotById(persisted?.primaryBotId ?? persisted?.botId ?? null)?.id ??
      this.readTrimmedString(persisted?.primaryBotId ?? persisted?.botId);

    return persistedBotId ?? (await this.resolveBotAssignment(normalizedChatId)) ?? undefined;
  }

  private resolveManualModerationBotAction(action: string): ManualModerationBotAction | null {
    if (action === 'MUTE') {
      return 'delete_message';
    }
    if (action === 'BAN') {
      return 'moderate_member';
    }
    return null;
  }

  private normalizeManualModerationBotId(botId: unknown): string | null {
    const normalizedBotId = this.readTrimmedString(botId);
    if (!normalizedBotId) {
      return null;
    }

    return this.maxBotRegistry?.getBotById(normalizedBotId)?.id ?? normalizedBotId;
  }

  private appendManualModerationBotCandidate(
    target: string[],
    seen: Set<string>,
    botId: unknown,
  ): void {
    const normalizedBotId = this.normalizeManualModerationBotId(botId);
    if (!normalizedBotId || seen.has(normalizedBotId)) {
      return;
    }
    seen.add(normalizedBotId);
    target.push(normalizedBotId);
  }

  private async resolveManualModerationActionBotAssignment(
    chatId: string,
    action: ManualModerationBotAction | null,
    options: ResolveManualModerationActionBotAssignmentOptions = {},
  ): Promise<string | undefined> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return undefined;
    }

    if (!action) {
      return this.resolveManualActionBotAssignment(normalizedChatId);
    }

    const preferredBotId = this.normalizeManualModerationBotId(options.preferredBotId);
    const maxClientWithAccess = this.maxClient as MaxClientService & {
      getCurrentChatMemberAccess?: MaxClientService['getCurrentChatMemberAccess'];
    };
    if (preferredBotId) {
      if (typeof maxClientWithAccess.getCurrentChatMemberAccess !== 'function') {
        return preferredBotId;
      }

      try {
        const access = await maxClientWithAccess.getCurrentChatMemberAccess(normalizedChatId, {
          trafficClass: 'critical',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          botId: preferredBotId,
        });
        if (this.hasManualModerationBotActionAccess(access, action)) {
          return preferredBotId;
        }
      } catch (error: unknown) {
        if (isBotAdminLookupDeniedError(error)) {
          // Try the regular route below; another runtime bot may still be able to act.
        } else if (isMaxApiThrottleError(error) || isMaxApiTimeoutError(error)) {
          this.logger.debug(
            {
              chatId: normalizedChatId,
              action,
              botId: preferredBotId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Using preferred manual moderation bot after transient MAX API pressure',
          );
          return preferredBotId;
        } else {
          this.logger.debug(
            {
              chatId: normalizedChatId,
              action,
              botId: preferredBotId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to verify preferred manual moderation bot candidate',
          );
        }
      }
    }

    const candidateBotIds: string[] = [];
    const seenBotIds = new Set<string>();

    try {
      const route = await this.resolveUnifiedBotRoute({
        purpose: 'moderation_action',
        chatId: normalizedChatId,
        action,
        fallbackToPrimary: true,
      });
      for (const candidateBotId of route?.candidateBotIds ?? []) {
        this.appendManualModerationBotCandidate(candidateBotIds, seenBotIds, candidateBotId);
      }
      this.appendManualModerationBotCandidate(candidateBotIds, seenBotIds, route?.botId);
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: normalizedChatId,
          action,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve action-specific bot route for manual moderation',
      );
    }

    try {
      for (const candidateBotId of await this.resolveCandidateBotIdsForChat(normalizedChatId)) {
        this.appendManualModerationBotCandidate(candidateBotIds, seenBotIds, candidateBotId);
      }
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: normalizedChatId,
          action,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve chat bot candidates for manual moderation action',
      );
    }

    this.appendManualModerationBotCandidate(
      candidateBotIds,
      seenBotIds,
      await this.resolveChatBotIdForRead(normalizedChatId),
    );

    for (const bot of this.maxBotRegistry?.getActionableBots() ?? []) {
      this.appendManualModerationBotCandidate(candidateBotIds, seenBotIds, bot.id);
    }

    if (candidateBotIds.length === 0) {
      this.appendManualModerationBotCandidate(
        candidateBotIds,
        seenBotIds,
        await this.resolveManualActionBotAssignment(normalizedChatId),
      );
    }

    const fallbackBotId = candidateBotIds[0];
    if (typeof maxClientWithAccess.getCurrentChatMemberAccess !== 'function') {
      return fallbackBotId;
    }

    for (const candidateBotId of candidateBotIds) {
      try {
        const access = await maxClientWithAccess.getCurrentChatMemberAccess(normalizedChatId, {
          trafficClass: 'critical',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          botId: candidateBotId,
        });
        if (this.hasManualModerationBotActionAccess(access, action)) {
          return candidateBotId;
        }
      } catch (error: unknown) {
        if (isBotAdminLookupDeniedError(error)) {
          continue;
        }

        if (isMaxApiThrottleError(error) || isMaxApiTimeoutError(error)) {
          this.logger.debug(
            {
              chatId: normalizedChatId,
              action,
              botId: candidateBotId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Using fallback manual moderation bot assignment after transient MAX API pressure',
          );
          return fallbackBotId;
        }

        this.logger.debug(
          {
            chatId: normalizedChatId,
            action,
            botId: candidateBotId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to verify action-specific bot candidate for manual moderation',
        );
      }
    }

    return fallbackBotId;
  }

  private hasManualModerationBotActionAccess(
    access: Pick<MaxChatMemberAccess, 'isAdmin' | 'isOwner' | 'permissions'>,
    action: ManualModerationBotAction,
  ): boolean {
    if (access.isOwner) {
      return true;
    }
    if (!access.isAdmin) {
      return false;
    }
    if (access.permissions.length === 0) {
      return true;
    }
    return action === 'delete_message'
      ? access.permissions.some((permission) => this.isDeleteMessagesPermission(permission))
      : access.permissions.some((permission) => this.isAddRemoveMembersPermission(permission));
  }

  private async resolveManualActionBotAssignment(chatId: string): Promise<string | undefined> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return undefined;
    }

    const persistedBotId = await this.resolveChatBotIdForRead(normalizedChatId);
    const fallbackBotId = persistedBotId;
    const seenBotIds = new Set<string>();

    if (persistedBotId) {
      seenBotIds.add(persistedBotId);
      try {
        const access = await this.maxClient.getCurrentChatMemberAccess(normalizedChatId, {
          trafficClass: 'critical',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          botId: persistedBotId,
        });
        if (access.isAdmin || access.isOwner) {
          return persistedBotId;
        }

        this.logger.warn(
          {
            chatId: normalizedChatId,
            botId: persistedBotId,
          },
          'Persisted chat bot assignment is no longer admin-capable for manual action',
        );
      } catch (error: unknown) {
        if (isMaxApiThrottleError(error) || isMaxApiTimeoutError(error)) {
          this.logger.debug(
            {
              chatId: normalizedChatId,
              botId: persistedBotId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Using persisted chat bot assignment after transient MAX API pressure',
          );
          return persistedBotId;
        }

        if (!isBotAdminLookupDeniedError(error)) {
          this.logger.debug(
            {
              chatId: normalizedChatId,
              botId: persistedBotId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to verify persisted chat bot assignment for manual action',
          );
        }
      }
    }

    for (const bot of this.maxBotRegistry?.getActionableBots() ?? []) {
      if (seenBotIds.has(bot.id)) {
        continue;
      }
      seenBotIds.add(bot.id);
      try {
        const access = await this.maxClient.getCurrentChatMemberAccess(normalizedChatId, {
          trafficClass: 'critical',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          botId: bot.id,
        });
        if (!access.isAdmin && !access.isOwner) {
          continue;
        }

        try {
          if (this.maxBotLinkService?.bindChatToBot) {
            await this.maxBotLinkService.bindChatToBot({
              chatId: normalizedChatId,
              entityType: ChatEntityType.CHAT,
              botId: bot.id,
            });
          } else {
            await this.prisma.chat.upsert({
              where: { id: normalizedChatId },
              create: {
                id: normalizedChatId,
                title: `Chat ${normalizedChatId}`,
                entityType: ChatEntityType.CHAT,
                ...this.buildResolvedBotAssignmentData(bot.id),
              },
              update: this.buildResolvedBotAssignmentData(bot.id),
            });
          }
        } catch (persistError: unknown) {
          this.logger.warn(
            {
              chatId: normalizedChatId,
              botId: bot.id,
              err: persistError instanceof Error ? persistError.message : String(persistError),
            },
            'Failed to persist recovered chat bot assignment for manual action',
          );
        }

        return bot.id;
      } catch (error: unknown) {
        if (isBotAdminLookupDeniedError(error)) {
          continue;
        }

        if (isMaxApiThrottleError(error) || isMaxApiTimeoutError(error)) {
          this.logger.debug(
            {
              chatId: normalizedChatId,
              botId: bot.id,
              err: error instanceof Error ? error.message : String(error),
            },
            'Stopped probing actionable bots for manual action after transient MAX API pressure',
          );
          return fallbackBotId;
        }

        this.logger.debug(
          {
            chatId: normalizedChatId,
            botId: bot.id,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to probe actionable bot while resolving manual action bot assignment',
        );
      }
    }

    return fallbackBotId;
  }

  private async resolveBackgroundReadBotAssignment(chatId: string): Promise<string | undefined> {
    return (
      (await this.resolveAssistBotAssignment(chatId, 'access_prewarm')) ??
      (await this.resolveBotAssignment(chatId))
    );
  }

  private async refreshExecutionReadinessAfterChatSettingsUpdate(
    chatId: string,
    settings: ChatSettings,
  ): Promise<void> {
    await this.refreshManagedEntityBotAccessSnapshots(chatId, 'chat', 'chat settings update');
    this.scheduleDestructiveModerationAdminRosterWarmup(chatId, settings);

    if (!this.isRequiredSubscriptionCurrentlyActive(settings)) {
      return;
    }

    await this.refreshRequiredSubscriptionAccessSnapshots(
      settings.requiredSubscriptionChannelIds,
      'required subscription settings update',
    );
  }

  private scheduleDestructiveModerationAdminRosterWarmup(
    chatId: string,
    settings: Pick<ChatSettings, 'nightModeEnabled' | 'nightModeForceCloseEnabled'>,
  ): void {
    if (
      typeof this.maxChatAdminRosterSyncService?.scheduleChatAdminRosterSync !== 'function' ||
      (!settings.nightModeEnabled && !settings.nightModeForceCloseEnabled)
    ) {
      return;
    }

    void this.maxChatAdminRosterSyncService
      .scheduleChatAdminRosterSync({
        chatId,
        entityType: 'chat',
        source: 'moderation_destructive_path',
        retryUntilMs: null,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          {
            chatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to schedule destructive moderation admin roster warmup after settings update',
        );
      });
  }

  private async refreshExecutionReadinessAfterChannelSettingsUpdate(chatId: string): Promise<void> {
    await this.refreshManagedEntityBotAccessSnapshots(chatId, 'channel', 'channel settings update');
  }

  private scheduleApplySettingsToAllReadinessRefresh(params: {
    chatIds: readonly string[];
    shouldRefreshRequiredSubscription: boolean;
    requiredSubscriptionChannelIds: readonly string[];
  }): void {
    if (!this.maxBotExecutionPlanner) {
      return;
    }

    void this.refreshApplySettingsToAllReadiness(params).catch((error: unknown) => {
      this.logger.warn(
        {
          chats: params.chatIds.length,
          requiredSubscriptionChannels: params.requiredSubscriptionChannelIds.length,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh apply-to-all readiness snapshots in background',
      );
    });
  }

  private async refreshApplySettingsToAllReadiness(params: {
    chatIds: readonly string[];
    shouldRefreshRequiredSubscription: boolean;
    requiredSubscriptionChannelIds: readonly string[];
  }): Promise<void> {
    await mapWithConcurrencyLimit(
      [...params.chatIds],
      APPLY_SETTINGS_TO_ALL_READINESS_REFRESH_CONCURRENCY,
      async (chatId) => {
        await sleepIfNeeded(APPLY_SETTINGS_TO_ALL_READINESS_REFRESH_SPACING_MS);
        await this.refreshManagedEntityBotAccessSnapshots(
          chatId,
          'chat',
          'chat settings apply-to-all',
        );
      },
    );

    if (!params.shouldRefreshRequiredSubscription) {
      return;
    }

    await this.refreshRequiredSubscriptionAccessSnapshots(
      params.requiredSubscriptionChannelIds,
      'required subscription settings apply-to-all',
    );
  }

  private async refreshManagedEntityBotAccessSnapshots(
    chatId: string,
    entityType: ManagedEntityType,
    reason: string,
  ): Promise<void> {
    if (!this.maxBotExecutionPlanner) {
      return;
    }

    try {
      await this.maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots({
        chatId,
        entityType,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          entityType,
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh bot access snapshots after settings update',
      );
    }
  }

  private async resolveDeliveryBotAssignment(chatId: string): Promise<string | undefined> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return undefined;
    }

    const resolvedBotId = await this.resolveBotAssignment(normalizedChatId);
    if (resolvedBotId) {
      return resolvedBotId;
    }

    const persisted = await this.prisma.chat.findUnique({
      where: { id: normalizedChatId },
      select: { primaryBotId: true, botId: true },
    });
    return this.readTrimmedString(persisted?.primaryBotId ?? persisted?.botId) ?? undefined;
  }

  private async resolveAssistBotAssignment(
    chatId: string,
    capability: ManagedEntityBotCapability,
  ): Promise<string | undefined> {
    const route = await this.resolveUnifiedBotRoute({
      purpose: 'capability',
      chatId,
      capability,
      fallbackToPrimary: true,
    });
    if (route?.botId) {
      return route.botId;
    }

    return (
      (await this.maxBotLinkService?.resolveBotIdForCapability?.({
        chatId,
        capability,
      })) ?? undefined
    );
  }

  private async resolveCurrentBotUserId(
    chatId: string,
    botId?: string | null,
  ): Promise<string | null> {
    try {
      const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
        trafficClass: 'interactive',
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        ...(botId ? { botId } : {}),
      });
      return this.readTrimmedString(access.userId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve current bot user id for chat admin filtering',
      );
      return null;
    }
  }

  private async resolveKnownBotUserIdsForChat(
    chatId: string,
    preferredBotIds: ReadonlyArray<string | null | undefined> = [],
  ): Promise<Set<string>> {
    const knownBotUserIds = new Set<string>();
    const candidateBotIds = new Set<string>();

    for (const preferredBotId of preferredBotIds) {
      const normalizedBotId =
        this.maxBotRegistry?.getBotById(preferredBotId)?.id ??
        this.readTrimmedString(preferredBotId);
      if (normalizedBotId) {
        candidateBotIds.add(normalizedBotId);
      }
    }

    for (const candidateBotId of await this.resolveCandidateBotIdsForChat(chatId)) {
      candidateBotIds.add(candidateBotId);
    }

    for (const botUserId of [this.explicitBotContactId, this.ownBotUserId]) {
      const normalizedBotUserId = this.readTrimmedString(botUserId);
      if (normalizedBotUserId) {
        knownBotUserIds.add(normalizedBotUserId);
      }
    }

    const currentContextBotUserId = this.readTrimmedString(
      await this.resolveCurrentBotUserId(chatId),
    );
    if (currentContextBotUserId) {
      knownBotUserIds.add(currentContextBotUserId);
    }

    for (const candidateBotId of candidateBotIds) {
      const resolvedContactId = this.dialogLinkHelper.resolveBotContactId(candidateBotId);
      if (resolvedContactId) {
        knownBotUserIds.add(resolvedContactId);
      }
    }

    const resolvedBotUserIds = await mapWithConcurrencyLimit(
      [...candidateBotIds],
      3,
      async (candidateBotId) => this.resolveCurrentBotUserId(chatId, candidateBotId),
    );
    for (const resolvedBotUserId of resolvedBotUserIds) {
      const normalizedBotUserId = this.readTrimmedString(resolvedBotUserId);
      if (normalizedBotUserId) {
        knownBotUserIds.add(normalizedBotUserId);
      }
    }

    return knownBotUserIds;
  }

  private async resolveCandidateBotIdsForChat(
    chatId: string,
    options: {
      includeDiscoveryFallback?: boolean;
    } = {},
  ): Promise<string[]> {
    const persisted = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        botId: true,
        primaryBotId: true,
        botMemberships: {
          where: {
            status: ChatBotMembershipStatus.ACTIVE,
          },
          select: {
            botId: true,
          },
        },
      },
    });

    const resolved = new Set<string>();
    for (const botId of [
      this.readTrimmedString(persisted?.primaryBotId),
      this.readTrimmedString(persisted?.botId),
      ...((persisted?.botMemberships ?? []).map((membership) =>
        this.readTrimmedString(membership.botId),
      ) as Array<string | null>),
    ]) {
      const normalizedBotId = this.maxBotRegistry?.getBotById(botId)?.id ?? null;
      if (normalizedBotId) {
        resolved.add(normalizedBotId);
      }
    }

    if (options.includeDiscoveryFallback === true) {
      for (const bot of this.maxBotRegistry?.getDiscoveryBots() ?? []) {
        resolved.add(bot.id);
      }
    }

    return [...resolved];
  }

  private async loadRemoteAdminAccessForBot(
    chatId: string,
    userId: string,
    botId: string | null,
    options: {
      trafficClass?: 'critical' | 'interactive' | 'background';
      sourceTag?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<AdminAccessResolution> {
    try {
      const requestOptions = {
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        ...(options.trafficClass ? { trafficClass: options.trafficClass } : {}),
        ...(options.sourceTag ? { sourceTag: options.sourceTag } : {}),
        ...(typeof options.timeoutMs === 'number' ? { timeoutMs: options.timeoutMs } : {}),
        ...(botId ? { botId } : {}),
      } as const;
      const hasRequestOptions = Object.keys(requestOptions).length > 0;
      const normalizedUserId = userId.trim();
      const botContactId = this.dialogLinkHelper.resolveBotContactId(botId);

      if (typeof this.maxClient.getChatMembersAccess === 'function') {
        const lookupIds =
          botContactId && botContactId !== normalizedUserId
            ? [normalizedUserId, botContactId]
            : [normalizedUserId];
        const accessByUserId = hasRequestOptions
          ? await this.maxClient.getChatMembersAccess(chatId, lookupIds, requestOptions)
          : await this.maxClient.getChatMembersAccess(chatId, lookupIds);
        const botAccess =
          (botContactId ? (accessByUserId.get(botContactId) ?? null) : null) ??
          (hasRequestOptions
            ? await this.maxClient.getCurrentChatMemberAccess(chatId, requestOptions)
            : await this.maxClient.getCurrentChatMemberAccess(chatId));
        const botRole = this.resolveManagedEntityAccessRole(botAccess);

        if (!botAccess.isAdmin && !botAccess.isOwner) {
          return {
            status: 'denied',
            source: 'remote',
            reason: 'bot_not_admin',
            botRole,
          };
        }

        const userAccess =
          accessByUserId.get(normalizedUserId) ??
          (botContactId === normalizedUserId ? botAccess : null);
        const userRole = this.resolveManagedEntityAccessRole(userAccess);
        if (userAccess?.isAdmin === true || userAccess?.isOwner === true) {
          return {
            status: 'granted',
            source: 'remote',
            userRole,
            botRole,
          };
        }

        return {
          status: 'denied',
          source: 'remote',
          reason: 'user_not_admin',
          userRole,
          botRole,
        };
      }

      const adminIds = hasRequestOptions
        ? await this.maxClient.getChatAdminIds(chatId, requestOptions)
        : await this.maxClient.getChatAdminIds(chatId);
      return adminIds.includes(userId)
        ? {
            status: 'granted',
            source: 'remote',
            userRole: 'ADMIN',
            botRole: 'ADMIN',
          }
        : {
            status: 'denied',
            source: 'remote',
            reason: 'user_not_admin',
            userRole: 'MEMBER',
            botRole: 'ADMIN',
          };
    } catch (error: unknown) {
      if (isMaxApiThrottleError(error)) {
        return {
          status: 'throttled',
          error,
        };
      }

      if (isBotAdminLookupDeniedError(error)) {
        return {
          status: 'denied',
          source: 'remote',
          reason: 'bot_not_admin',
        };
      }

      const logData = {
        chatId,
        userId,
        botId: botId ?? 'legacy',
        err: error instanceof Error ? error.message : String(error),
      };
      if (isMaxApiTimeoutError(error)) {
        this.logger.log(
          logData,
          'Chat hidden after transient admin access validation timeout for candidate bot',
        );
      } else {
        this.logger.warn(
          logData,
          'Chat hidden: failed to validate bot/user admin access for candidate bot',
        );
      }
      return {
        status: 'unknown',
        error,
      };
    }
  }

  private async loadRemoteAdminAccess(
    chatId: string,
    userId: string,
    options: {
      entityType?: ManagedEntityType;
      candidateBotIds?: readonly string[];
      trafficClass?: 'critical' | 'interactive' | 'background';
      sourceTag?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<AdminAccessResolution> {
    const discoveryCandidateBotIds = this.normalizeRuntimeManagedEntityBotIds(
      options.candidateBotIds ?? [],
    );
    const persistedCandidateBotIds = await this.resolveCandidateBotIdsForChat(chatId, {
      includeDiscoveryFallback: false,
    });
    const candidateBotIds = Array.from(
      new Set([...discoveryCandidateBotIds, ...persistedCandidateBotIds]),
    );
    if (candidateBotIds.length === 0) {
      const resolution = await this.loadRemoteAdminAccessForBot(chatId, userId, null, options);
      await this.recordRemoteManagedEntityAccessEdge(chatId, userId, null, options, resolution);
      if (resolution.status === 'granted') {
        await this.chatContextCache.setAdminAccess?.(chatId, userId, 'granted');
        return resolution;
      }

      if (resolution.status === 'denied') {
        await this.chatContextCache.setAdminAccess?.(
          chatId,
          userId,
          resolution.reason === 'user_not_admin' ? 'user_denied' : 'bot_denied',
        );
        this.schedulePersistedChatAccessPrune(chatId, userId, 'remote_admin_access');
      }

      return resolution;
    }

    let sawUserDenied = false;
    let sawBotDenied = false;
    let throttledError: unknown = null;
    let unknownError: unknown = null;

    for (const botId of candidateBotIds) {
      const resolution = await this.loadRemoteAdminAccessForBot(chatId, userId, botId, options);
      await this.recordRemoteManagedEntityAccessEdge(chatId, userId, botId, options, resolution);
      if (resolution.status === 'granted') {
        await this.chatContextCache.setAdminAccess?.(chatId, userId, 'granted');
        return resolution;
      }

      if (resolution.status === 'denied') {
        if (resolution.reason === 'user_not_admin') {
          sawUserDenied = true;
        } else {
          sawBotDenied = true;
        }
        continue;
      }

      if (resolution.status === 'throttled' && throttledError === null) {
        throttledError = resolution.error;
        continue;
      }

      if (resolution.status === 'unknown' && unknownError === null) {
        unknownError = resolution.error;
      }
    }

    if (sawUserDenied) {
      await this.chatContextCache.setAdminAccess?.(chatId, userId, 'user_denied');
      this.schedulePersistedChatAccessPrune(chatId, userId, 'remote_admin_access');
      return {
        status: 'denied',
        source: 'remote',
        reason: 'user_not_admin',
      };
    }

    if (throttledError) {
      return {
        status: 'throttled',
        error: throttledError,
      };
    }

    if (unknownError) {
      return {
        status: 'unknown',
        error: unknownError,
      };
    }

    if (sawBotDenied) {
      await this.chatContextCache.setAdminAccess?.(chatId, userId, 'bot_denied');
      this.schedulePersistedChatAccessPrune(chatId, userId, 'remote_admin_access');
      return {
        status: 'denied',
        source: 'remote',
        reason: 'bot_not_admin',
      };
    }

    await this.chatContextCache.setAdminAccess?.(chatId, userId, 'bot_denied');
    this.schedulePersistedChatAccessPrune(chatId, userId, 'remote_admin_access');
    return {
      status: 'denied',
      source: 'remote',
      reason: 'bot_not_admin',
    };
  }

  private async recordRemoteManagedEntityAccessEdge(
    chatId: string,
    userId: string,
    botId: string | null,
    options: {
      entityType?: ManagedEntityType;
    },
    resolution: AdminAccessResolution,
  ): Promise<void> {
    if (
      !options.entityType ||
      resolution.status === 'unknown' ||
      resolution.status === 'throttled'
    ) {
      return;
    }

    if (resolution.status === 'granted') {
      await this.upsertManagedEntityAccessEdge({
        chatId,
        userId,
        botId,
        entityType: options.entityType,
        state: 'GRANTED',
        userRole: resolution.userRole ?? 'ADMIN',
        botRole: resolution.botRole ?? 'ADMIN',
        source: 'remote_admin_access',
      });
      return;
    }

    await this.upsertManagedEntityAccessEdge({
      chatId,
      userId,
      botId,
      entityType: options.entityType,
      state: resolution.reason === 'user_not_admin' ? 'USER_DENIED' : 'BOT_DENIED',
      userRole:
        resolution.reason === 'user_not_admin' ? (resolution.userRole ?? 'MEMBER') : 'UNKNOWN',
      botRole: resolution.reason === 'bot_not_admin' ? (resolution.botRole ?? 'MEMBER') : 'ADMIN',
      deniedReason: resolution.reason,
      source: 'remote_admin_access',
    });
  }

  private async resolveUserAndBotAdminAccess(
    chatId: string,
    userId: string,
    options: {
      bypassNegativeCache?: boolean;
      entityType?: ManagedEntityType;
      candidateBotIds?: readonly string[];
      trafficClass?: 'critical' | 'interactive' | 'background';
      sourceTag?: string;
      timeoutMs?: number;
      allowPersistedFallback?: boolean;
    } = {},
  ): Promise<AdminAccessResolution> {
    const cached = (await this.chatContextCache.getAdminAccess?.(chatId, userId)) ?? null;
    if (cached === 'granted') {
      return {
        status: 'granted',
        source: 'cache',
      };
    }

    if (cached === 'user_denied' && options.bypassNegativeCache !== true) {
      return {
        status: 'denied',
        source: 'cache',
        reason: 'user_not_admin',
      };
    }

    if (cached === 'bot_denied' && options.bypassNegativeCache !== true) {
      return {
        status: 'denied',
        source: 'cache',
        reason: 'bot_not_admin',
      };
    }

    const key = this.buildAdminAccessCheckKey(chatId, userId, options);
    const inFlight = this.adminAccessChecks.get(key);
    if (inFlight) {
      return options.allowPersistedFallback === false
        ? inFlight
        : this.withAllowlistFallback(chatId, userId, inFlight);
    }

    const pending = this.loadRemoteAdminAccess(chatId, userId, {
      entityType: options.entityType,
      candidateBotIds: options.candidateBotIds,
      trafficClass: options.trafficClass,
      sourceTag: options.sourceTag,
      timeoutMs: options.timeoutMs,
    });
    this.adminAccessChecks.set(key, pending);

    try {
      return await (options.allowPersistedFallback === false
        ? pending
        : this.withAllowlistFallback(chatId, userId, pending));
    } finally {
      this.adminAccessChecks.delete(key);
    }
  }

  private buildAdminAccessCheckKey(
    chatId: string,
    userId: string,
    options: {
      candidateBotIds?: readonly string[];
      trafficClass?: 'critical' | 'interactive' | 'background';
      timeoutMs?: number;
    },
  ): string {
    const trafficClass = options.trafficClass ?? 'interactive';
    const timeoutKey =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : 'default';

    const candidateBotIdsKey = this.normalizeRuntimeManagedEntityBotIds(
      options.candidateBotIds ?? [],
    )
      .sort()
      .join(',');

    return [chatId, userId, trafficClass, timeoutKey, candidateBotIdsKey].join(':');
  }

  private async withAllowlistFallback(
    chatId: string,
    userId: string,
    resolutionPromise: Promise<AdminAccessResolution>,
  ): Promise<AdminAccessResolution> {
    const resolution = await resolutionPromise;
    if (resolution.status !== 'unknown' && resolution.status !== 'throttled') {
      return resolution;
    }

    if (!(await this.hasPersistedChatAccess(chatId, userId))) {
      return resolution;
    }
    if (!(await this.canUsePersistedChatAccessFallback(chatId))) {
      return resolution;
    }

    this.logger.log(
      {
        chatId,
        userId,
      },
      'Using persisted admin access allowlist after transient MAX API failure',
    );
    return {
      status: 'granted',
      source: 'allowlist_fallback',
    };
  }

  private async canUsePersistedChatAccessFallback(chatId: string): Promise<boolean> {
    try {
      const memberships = await this.prisma.chatBotMembership.findMany({
        where: {
          chatId,
          status: ChatBotMembershipStatus.ACTIVE,
        },
        select: {
          botId: true,
          permissionsSnapshot: true,
        },
      });
      const knownMemberships = memberships.filter(
        (membership) => this.maxBotRegistry?.getBotById(membership.botId) ?? true,
      );
      if (knownMemberships.length === 0) {
        return false;
      }

      let sawUnknownSnapshot = false;
      for (const membership of knownMemberships) {
        const snapshot = this.normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
        if (!snapshot) {
          sawUnknownSnapshot = true;
          continue;
        }
        if (snapshot.isAdmin || snapshot.isOwner) {
          return true;
        }
      }

      return sawUnknownSnapshot;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to inspect bot memberships before persisted admin access fallback',
      );
      return true;
    }
  }

  private normalizeMembershipAccessSnapshot(
    value: unknown,
  ): { isAdmin: boolean; isOwner: boolean } | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    return {
      isAdmin: row.isAdmin === true,
      isOwner: row.isOwner === true,
    };
  }

  private isManagedEntitiesRefreshThrottledError(
    error: unknown,
  ): error is ManagedEntitiesRefreshThrottledError {
    return error instanceof ManagedEntitiesRefreshThrottledError;
  }

  private async isManagedEntitiesRefreshBackoffActive(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    key: string,
  ): Promise<boolean> {
    const untilMs = this.managedEntitiesRefreshBackoffUntilMs.get(key) ?? 0;
    const memoryActive = untilMs > Date.now();
    if (!memoryActive && untilMs > 0) {
      this.managedEntitiesRefreshBackoffUntilMs.delete(key);
    }

    try {
      return (
        memoryActive ||
        (await this.chatContextCache.isManagedEntitiesRefreshBackoffActive(userId, entityType))
      );
    } catch {
      return memoryActive;
    }
  }

  private buildManagedEntitiesRefreshCooldownKey(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): string {
    return `${userId}:${entityType}`;
  }

  private async isManagedEntitiesRefreshCooldownActive(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    key: string,
  ): Promise<boolean> {
    const untilMs = this.managedEntitiesRefreshCooldownUntilMs.get(key) ?? 0;
    const memoryActive = untilMs > Date.now();
    if (!memoryActive && untilMs > 0) {
      this.managedEntitiesRefreshCooldownUntilMs.delete(key);
    }

    try {
      return (
        memoryActive ||
        (await this.chatContextCache.isManagedEntitiesRefreshCooldownActive(userId, entityType))
      );
    } catch {
      return memoryActive;
    }
  }

  private async activateManagedEntitiesRefreshCooldown(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    key: string,
  ): Promise<void> {
    const untilMs = Date.now() + MANAGED_ENTITIES_REFRESH_SUCCESS_COOLDOWN_MS;
    this.managedEntitiesRefreshCooldownUntilMs.set(key, untilMs);
    try {
      await this.chatContextCache.activateManagedEntitiesRefreshCooldown(
        userId,
        entityType,
        Math.max(1, Math.ceil((untilMs - Date.now()) / 1000)),
      );
    } catch {
      return;
    }
  }

  private async activateManagedEntitiesRefreshBackoff(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    key: string,
  ): Promise<number> {
    const now = Date.now();
    const untilMs = Math.max(
      this.managedEntitiesRefreshBackoffUntilMs.get(key) ?? 0,
      now + MANAGED_ENTITIES_REFRESH_BACKOFF_MS,
    );
    this.managedEntitiesRefreshBackoffUntilMs.set(key, untilMs);
    const backoffMs = untilMs - now;

    try {
      await this.chatContextCache.activateManagedEntitiesRefreshBackoff(
        userId,
        entityType,
        Math.max(1, Math.ceil(backoffMs / 1000)),
      );
    } catch {
      return backoffMs;
    }

    return backoffMs;
  }

  private async getManagedEntitiesRefreshBackoffRemainingMs(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    key: string,
  ): Promise<number> {
    const untilMs = this.managedEntitiesRefreshBackoffUntilMs.get(key) ?? 0;
    const memoryRemainingMs = Math.max(0, untilMs - Date.now());
    if (memoryRemainingMs === 0 && untilMs > 0) {
      this.managedEntitiesRefreshBackoffUntilMs.delete(key);
    }

    try {
      const persistedRemainingMs =
        (await this.chatContextCache.getManagedEntitiesRefreshBackoffRemainingMs?.(
          userId,
          entityType,
        )) ?? 0;
      return Math.max(memoryRemainingMs, persistedRemainingMs);
    } catch {
      return memoryRemainingMs;
    }
  }

  private createManagedEntitiesRefreshState(
    cursor: number | null,
    backoffActive: boolean,
    nextPollAfterMsOverride?: number,
    presentation: ManagedEntitiesRefreshPresentation = {
      totalCandidates: null,
      lastSyncedAt: null,
    },
  ): ManagedEntitiesRefreshState {
    const normalizedNextPollAfterMs =
      typeof nextPollAfterMsOverride === 'number'
        ? Math.max(0, Math.ceil(nextPollAfterMsOverride))
        : backoffActive
          ? MANAGED_ENTITIES_REFRESH_BACKOFF_MS
          : cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE
            ? 0
            : cursor === null
              ? MANAGED_ENTITIES_REFRESH_IDLE_NEXT_POLL_AFTER_MS
              : MANAGED_ENTITIES_REFRESH_NEXT_POLL_AFTER_MS;
    const manualRefreshBlock = this.resolveManagedEntitiesManualRefreshBlockState(
      cursor,
      backoffActive,
      normalizedNextPollAfterMs,
      presentation.lastSyncedAt ?? null,
    );
    const totalCandidates =
      typeof presentation.totalCandidates === 'number' &&
      Number.isFinite(presentation.totalCandidates)
        ? Math.max(0, Math.trunc(presentation.totalCandidates))
        : null;
    const processedCandidates =
      totalCandidates === null
        ? null
        : cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE
          ? totalCandidates
          : cursor === null
            ? 0
            : Math.max(0, Math.min(totalCandidates, Math.trunc(cursor)));
    const progressPercent =
      cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE
        ? 100
        : totalCandidates === null
          ? null
          : totalCandidates === 0
            ? 100
            : processedCandidates === null
              ? null
              : Math.max(
                  0,
                  Math.min(100, Math.round((processedCandidates / totalCandidates) * 100)),
                );

    return {
      complete: cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE,
      cursor,
      backoffActive,
      nextPollAfterMs: normalizedNextPollAfterMs,
      processedCandidates,
      totalCandidates,
      progressPercent,
      lastSyncedAt: presentation.lastSyncedAt ?? null,
      manualRefreshBlockedReason: manualRefreshBlock.reason,
      manualRefreshRetryAfterMs: manualRefreshBlock.retryAfterMs,
    };
  }

  private resolveManagedEntitiesManualRefreshBlockState(
    cursor: number | null,
    backoffActive: boolean,
    nextPollAfterMs: number,
    lastSyncedAt: string | null,
  ): {
    reason: ManagedEntitiesManualRefreshBlockReason | null;
    retryAfterMs: number | null;
  } {
    if (backoffActive) {
      return {
        reason: 'backoff',
        retryAfterMs: Math.max(0, Math.ceil(nextPollAfterMs)),
      };
    }

    if (typeof cursor === 'number' && cursor >= 0) {
      return {
        reason: 'in_progress',
        retryAfterMs: Math.max(0, Math.ceil(nextPollAfterMs)),
      };
    }

    if (!lastSyncedAt) {
      return {
        reason: null,
        retryAfterMs: null,
      };
    }

    const lastSyncedAtMs = Date.parse(lastSyncedAt);
    if (!Number.isFinite(lastSyncedAtMs)) {
      return {
        reason: null,
        retryAfterMs: null,
      };
    }

    const recentSyncRemainingMs =
      MANAGED_ENTITIES_MANUAL_REFRESH_RECENT_SYNC_WINDOW_MS - (Date.now() - lastSyncedAtMs);
    if (recentSyncRemainingMs <= 0) {
      return {
        reason: null,
        retryAfterMs: null,
      };
    }

    return {
      reason: 'recent_sync',
      retryAfterMs: Math.max(0, Math.ceil(recentSyncRemainingMs)),
    };
  }

  private async loadManagedEntitiesRefreshPresentationData(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ManagedEntitiesRefreshPresentation> {
    let totalCandidates: number | null = null;
    try {
      const snapshot =
        (await this.chatContextCache.getManagedEntitiesDiscoverySnapshot?.(userId, entityType)) ??
        null;
      totalCandidates = Array.isArray(snapshot) ? snapshot.length : null;
    } catch {
      totalCandidates = null;
    }

    let lastSyncedAt: string | null = null;
    try {
      lastSyncedAt =
        (await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(userId, entityType)) ?? null;
    } catch {
      lastSyncedAt = null;
    }

    return {
      totalCandidates,
      lastSyncedAt,
    };
  }

  private async readManagedEntitiesLastSyncFreshness(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<{ fresh: boolean; lastSyncedAt: string | null; ageMs: number | null }> {
    let lastSyncedAt: string | null = null;
    try {
      lastSyncedAt =
        (await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(userId, entityType)) ?? null;
    } catch {
      lastSyncedAt = null;
    }

    if (!lastSyncedAt) {
      return {
        fresh: false,
        lastSyncedAt: null,
        ageMs: null,
      };
    }

    const lastSyncedAtMs = Date.parse(lastSyncedAt);
    if (!Number.isFinite(lastSyncedAtMs)) {
      return {
        fresh: false,
        lastSyncedAt,
        ageMs: null,
      };
    }

    const ageMs = Date.now() - lastSyncedAtMs;
    return {
      fresh: ageMs >= 0 && ageMs < MANAGED_ENTITIES_REFRESH_FRESHNESS_WINDOW_MS,
      lastSyncedAt,
      ageMs,
    };
  }

  private async readManagedEntitiesRefreshState(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    options: { backoffActiveOverride?: boolean; cursorOverride?: number | null } = {},
  ): Promise<ManagedEntitiesRefreshState> {
    const refreshCooldownKey = this.buildManagedEntitiesRefreshCooldownKey(userId, entityType);
    let cursor = options.cursorOverride;
    if (cursor === undefined) {
      try {
        cursor =
          (await this.chatContextCache.getManagedEntitiesRefreshCursor?.(userId, entityType)) ??
          null;
      } catch {
        cursor = null;
      }
    }

    const backoffActive =
      options.backoffActiveOverride ??
      (await this.isManagedEntitiesRefreshBackoffActive(userId, entityType, refreshCooldownKey));

    const nextPollAfterMs = backoffActive
      ? await this.getManagedEntitiesRefreshBackoffRemainingMs(
          userId,
          entityType,
          refreshCooldownKey,
        )
      : undefined;
    const presentation = await this.loadManagedEntitiesRefreshPresentationData(userId, entityType);

    return this.createManagedEntitiesRefreshState(
      cursor,
      backoffActive,
      nextPollAfterMs,
      presentation,
    );
  }

  private async isManagedEntitiesBackgroundRefreshPaused(
    reason: 'schedule' | 'job',
  ): Promise<boolean> {
    return (
      (await this.resolveManagedEntitiesBackgroundRefreshPauseDecision(reason, {
        allowRecoveryWindowRun: false,
      })) !== null
    );
  }

  private peekManagedEntitiesBackgroundRefreshPauseDecision(
    reason: 'schedule' | 'job',
    options: {
      allowRecoveryWindowRun?: boolean;
      allowQueueLagSlowPathBelowSec?: number;
    } = {},
  ): { reason: string; retryAfterMs: number } | null {
    if (this.backgroundRuntimeGovernorService) {
      const decision = this.backgroundRuntimeGovernorService.peekDecision({
        component: 'admin-managed-refresh',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        allowRecoveryWindowRun: options.allowRecoveryWindowRun === true,
        allowQueueLagSlowPathBelowSec: options.allowQueueLagSlowPathBelowSec,
      });
      if (this.shouldIgnoreManagedEntitiesQueueLagThrottleDecision(decision, options)) {
        return null;
      }
      if (!decision || decision.action === 'run') {
        return null;
      }

      return this.logManagedEntitiesBackgroundThrottleDecision(reason, decision);
    }

    const systemModeService = this.systemModeService as
      | (SystemModeService & {
          peekCachedSnapshot?: (maxAgeMs?: number) => SystemModeSnapshot | null;
          getSnapshot?: () => SystemModeSnapshot;
        })
      | undefined;
    const snapshot =
      systemModeService?.peekCachedSnapshot?.() ?? systemModeService?.getSnapshot?.() ?? null;
    if (!snapshot || snapshot.mode !== 'degrade' || isSystemModeRecoveryWindow(snapshot)) {
      return null;
    }

    return this.logManagedEntitiesSystemModePauseDecision(reason, snapshot);
  }

  private async resolveManagedEntitiesBackgroundRefreshPauseDecision(
    reason: 'schedule' | 'job',
    options: {
      allowRecoveryWindowRun?: boolean;
      allowQueueLagSlowPathBelowSec?: number;
    } = {},
  ): Promise<{ reason: string; retryAfterMs: number } | null> {
    if (this.backgroundRuntimeGovernorService) {
      const decision = await this.backgroundRuntimeGovernorService.decide({
        component: 'admin-managed-refresh',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        allowRecoveryWindowRun: options.allowRecoveryWindowRun === true,
        allowQueueLagSlowPathBelowSec: options.allowQueueLagSlowPathBelowSec,
      });
      if (this.shouldIgnoreManagedEntitiesQueueLagThrottleDecision(decision, options)) {
        return null;
      }
      if (decision.action === 'run') {
        return null;
      }

      return this.logManagedEntitiesBackgroundThrottleDecision(reason, decision);
    }

    const snapshot = await this.resolveSystemModeSnapshot();
    if (snapshot.mode !== 'degrade' || isSystemModeRecoveryWindow(snapshot)) {
      return null;
    }

    return this.logManagedEntitiesSystemModePauseDecision(reason, snapshot);
  }

  private logManagedEntitiesBackgroundThrottleDecision(
    reason: 'schedule' | 'job',
    decision: {
      action: 'run' | 'slow' | 'pause';
      reason: string;
      retryAfterMs: number;
    },
  ): { reason: string; retryAfterMs: number } {
    const now = Date.now();
    if (
      now - this.managedEntitiesDegradePauseLogAtMs >=
      MANAGED_ENTITIES_DEGRADE_PAUSE_LOG_INTERVAL_MS
    ) {
      this.managedEntitiesDegradePauseLogAtMs = now;
      this.logger.log(
        {
          reason,
          action: decision.action,
          details: decision.reason,
          retryAfterMs: decision.retryAfterMs,
        },
        'Throttled managed entities background refresh because the runtime governor detected pressure',
      );
    }

    return {
      reason: decision.reason,
      retryAfterMs: decision.retryAfterMs,
    };
  }

  private logManagedEntitiesSystemModePauseDecision(
    reason: 'schedule' | 'job',
    snapshot: Pick<SystemModeSnapshot, 'mode' | 'source' | 'reason'>,
  ): { reason: string; retryAfterMs: number } {
    const now = Date.now();
    if (
      now - this.managedEntitiesDegradePauseLogAtMs >=
      MANAGED_ENTITIES_DEGRADE_PAUSE_LOG_INTERVAL_MS
    ) {
      this.managedEntitiesDegradePauseLogAtMs = now;
      this.logger.log(
        {
          reason,
          mode: snapshot.mode,
          source: snapshot.source,
          details: snapshot.reason,
        },
        'Paused managed entities background refresh because the system is degraded',
      );
    }

    return {
      reason: snapshot.reason,
      retryAfterMs: MANAGED_ENTITIES_REFRESH_DEGRADE_PAUSE_RETRY_MS,
    };
  }

  private shouldAllowManagedEntitiesRecoveryWindowRun(options: {
    bypassRemoteCache?: boolean;
    resetRefreshCursor?: boolean;
    allowRecoveryWindowRun?: boolean;
  }): boolean {
    return (
      options.allowRecoveryWindowRun === true ||
      options.resetRefreshCursor === true ||
      options.bypassRemoteCache === true
    );
  }

  private buildManagedEntitiesBackgroundGovernorOptions(options: {
    bypassRemoteCache?: boolean;
    resetRefreshCursor?: boolean;
    allowRecoveryWindowRun?: boolean;
  }): {
    allowRecoveryWindowRun: boolean;
    allowQueueLagSlowPathBelowSec?: number;
  } {
    const allowUserTriggeredBypass = this.shouldAllowManagedEntitiesRecoveryWindowRun(options);
    return {
      allowRecoveryWindowRun: allowUserTriggeredBypass,
      allowQueueLagSlowPathBelowSec: allowUserTriggeredBypass
        ? MANAGED_ENTITIES_REFRESH_QUEUE_LAG_SLOW_PATH_MAX_SEC
        : undefined,
    };
  }

  private shouldIgnoreManagedEntitiesQueueLagThrottleDecision(
    decision:
      | {
          action: 'run' | 'slow' | 'pause';
          reason: string;
          retryAfterMs: number;
        }
      | null
      | undefined,
    options: {
      allowQueueLagSlowPathBelowSec?: number;
    },
  ): boolean {
    if (
      !decision ||
      decision.action === 'run' ||
      typeof options.allowQueueLagSlowPathBelowSec !== 'number' ||
      !Number.isFinite(options.allowQueueLagSlowPathBelowSec)
    ) {
      return false;
    }

    const match = /^user-facing queue lag ([0-9]+(?:\.[0-9]+)?)s$/u.exec(decision.reason);
    if (!match) {
      return false;
    }

    const lagSec = Number.parseFloat(match[1]);
    return Number.isFinite(lagSec) && lagSec < options.allowQueueLagSlowPathBelowSec;
  }

  private async resolveSystemModeSnapshot(): Promise<SystemModeSnapshot> {
    if (!this.systemModeService) {
      return this.createFallbackSystemModeSnapshot();
    }

    const systemModeService = this.systemModeService as SystemModeService & {
      getEffectiveSnapshot?: () => Promise<SystemModeSnapshot>;
      getSnapshot?: () => SystemModeSnapshot;
    };
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

  private async hasPersistedChatAccess(chatId: string, userId: string): Promise<boolean> {
    const rows = await this.prisma.chatAdminAllowlist.findMany({
      where: {
        chatId,
        userId,
      },
      select: {
        chatId: true,
      },
      take: 1,
    });

    return rows.length > 0;
  }

  private async prunePersistedChatAccess(chatId: string, userId: string): Promise<void> {
    await this.markManagedEntityAccessEdgesDeniedForUser({
      chatId,
      userId,
      state: 'USER_DENIED',
      deniedReason: 'persisted_access_pruned',
      source: 'prune_persisted_chat_access',
    });
    await this.prisma.chatAdminAllowlist.deleteMany({
      where: {
        chatId,
        userId,
      },
    });
    this.forgetManagedEntitiesLastSuccessChat(userId, chatId);
    this.invalidateManagedEntitiesAllowlistCache(userId);
    const invalidationResults = await Promise.allSettled([
      this.removeManagedEntitiesPublishedSnapshotItemForChat(userId, chatId),
      this.chatContextCache.clearManagedEntitiesRecentBootstrapForChat?.(chatId, null) ??
        Promise.resolve(),
    ]);
    for (const result of invalidationResults) {
      if (result.status === 'fulfilled') {
        continue;
      }

      this.logger.warn(
        {
          chatId,
          userId,
          err: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
        'Failed to invalidate managed entities published snapshot after persisted access prune',
      );
    }
  }

  private async prunePersistedChatAccessBestEffort(
    chatId: string,
    userId: string,
    source: string,
  ): Promise<void> {
    try {
      await this.prunePersistedChatAccess(chatId, userId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          source,
          code:
            error instanceof Prisma.PrismaClientKnownRequestError
              ? error.code
              : ((error as { code?: string } | null)?.code ?? null),
          err: error instanceof Error ? error.message : String(error),
        },
        isPrismaKnownError(error, 'P2024')
          ? 'Skipped persisted chat access prune because the Prisma pool is saturated'
          : 'Failed to prune persisted chat access',
      );
    }
  }

  private schedulePersistedChatAccessPrune(
    chatId: string,
    userId: string,
    source: 'bootstrap_recent_bot_added' | 'remote_admin_access',
  ): void {
    const normalizedChatId = this.readTrimmedString(chatId);
    const normalizedUserId = this.readTrimmedString(userId);
    if (!normalizedChatId || !normalizedUserId) {
      return;
    }

    const key = `${normalizedChatId}:${normalizedUserId}`;
    if (this.pendingPersistedChatAccessPrunes.has(key)) {
      return;
    }

    this.pendingPersistedChatAccessPrunes.add(key);
    this.persistedChatAccessPruneChain = this.persistedChatAccessPruneChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.prunePersistedChatAccess(normalizedChatId, normalizedUserId);
        } catch (error) {
          this.logger.warn(
            {
              chatId: normalizedChatId,
              userId: normalizedUserId,
              source,
              code:
                error instanceof Prisma.PrismaClientKnownRequestError
                  ? error.code
                  : ((error as { code?: string } | null)?.code ?? null),
              err: error,
            },
            isPrismaKnownError(error, 'P2024')
              ? 'Skipped persisted chat access prune because the Prisma pool is saturated'
              : 'Failed to prune persisted chat access',
          );
        } finally {
          this.pendingPersistedChatAccessPrunes.delete(key);
        }
      });
  }

  private async listChatsFromAllowlist(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ChatSummary[]> {
    const cacheKey = this.buildManagedEntitiesAllowlistCacheKey(userId, entityType);
    const cachedEntry = this.managedEntitiesAllowlistCache.get(cacheKey);
    if (cachedEntry && cachedEntry.expiresAtMs > Date.now()) {
      return cachedEntry.promise;
    }

    const pending = this.listChatsFromAllowlistUncached(userId, entityType).catch((error) => {
      if (this.managedEntitiesAllowlistCache.get(cacheKey)?.promise === pending) {
        this.managedEntitiesAllowlistCache.delete(cacheKey);
      }
      throw error;
    });
    this.managedEntitiesAllowlistCache.set(cacheKey, {
      expiresAtMs: Date.now() + MANAGED_ENTITIES_ALLOWLIST_CACHE_TTL_MS,
      promise: pending,
    });

    return pending;
  }

  private async listChatsFromAllowlistUncached(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    options: {
      allowLastSuccessFallback?: boolean;
    } = {},
  ): Promise<ChatSummary[]> {
    const runtimeChatScopeFilter = this.buildManagedEntitiesRuntimeChatScopeFilter();
    const whereClause =
      entityType === 'all'
        ? {
            userId,
            ...(runtimeChatScopeFilter ? { chat: runtimeChatScopeFilter } : {}),
          }
        : {
            userId,
            chat: {
              entityType: toPrismaEntityType(entityType),
              ...(runtimeChatScopeFilter ?? {}),
            },
          };
    let rows: Array<{
      chat: {
        id: string;
        title: string;
        createdAt: Date;
        entityType: ChatEntityType;
        primaryBotId?: string | null;
        botId?: string | null;
      };
    }> = [];
    const managedEntitiesReadPrisma = this.getManagedEntitiesReadPrisma();
    try {
      rows = await managedEntitiesReadPrisma.chatAdminAllowlist.findMany({
        where: whereClause,
        include: { chat: true },
        orderBy: {
          chat: {
            createdAt: 'desc',
          },
        },
      });
    } catch (error) {
      if (options.allowLastSuccessFallback !== false && isPrismaKnownError(error, 'P2024')) {
        const fallbackSnapshot = this.readManagedEntitiesLastSuccessSnapshot(userId, entityType);
        this.logger.warn(
          {
            entityType,
            fallbackItems: fallbackSnapshot.length,
            userId,
            code:
              error instanceof Prisma.PrismaClientKnownRequestError
                ? error.code
                : ((error as { code?: string } | null)?.code ?? null),
            err: error instanceof Error ? error.message : String(error),
          },
          fallbackSnapshot.length > 0
            ? 'Using last successful managed entities snapshot because the Prisma pool is saturated'
            : 'Using empty managed entities allowlist because the Prisma pool is saturated',
        );
        return fallbackSnapshot;
      }

      throw error;
    }

    const chats = rows.map(
      (row: {
        chat: {
          id: string;
          title: string;
          createdAt: Date;
          entityType: ChatEntityType;
          primaryBotId?: string | null;
          botId?: string | null;
        };
      }) =>
        this.createManagedEntitySummary({
          id: row.chat.id,
          title: row.chat.title,
          createdAt: row.chat.createdAt.toISOString(),
          entityType: fromPrismaEntityType(row.chat.entityType),
          primaryBotId:
            this.normalizeRuntimeManagedEntityBotId(
              this.readTrimmedString(row.chat.primaryBotId) ??
                this.readTrimmedString(row.chat.botId) ??
                null,
            ) ?? null,
        }),
    );

    const unsupportedChatIds = chats
      .filter((chat) => isUnsupportedManagedChat(chat.id, chat.entityType))
      .map((chat) => chat.id);
    if (unsupportedChatIds.length > 0) {
      try {
        await this.prisma.chatAdminAllowlist.deleteMany({
          where: {
            userId,
            chatId: {
              in: unsupportedChatIds,
            },
          },
        });
        this.invalidateManagedEntitiesAllowlistCache(userId);
      } catch (error) {
        this.logger.warn(
          {
            userId,
            chatIds: unsupportedChatIds,
            code:
              error instanceof Prisma.PrismaClientKnownRequestError
                ? error.code
                : ((error as { code?: string } | null)?.code ?? null),
            err: error,
          },
          isPrismaKnownError(error, 'P2024')
            ? 'Skipped managed entities allowlist cleanup because the Prisma pool is saturated'
            : 'Failed to clean unsupported managed entities from allowlist',
        );
      }
    }

    const supportedChats = chats.filter(
      (chat) => !isUnsupportedManagedChat(chat.id, chat.entityType),
    );
    const strictVisibleChats = await this.filterManagedEntitiesByStrictAccessEdges(
      userId,
      supportedChats,
    );
    const repairedChats = await this.repairManagedEntityAccessEdgesFromAllowlist(
      userId,
      supportedChats,
      strictVisibleChats,
    );
    const visibleChats = this.filterManagedEntitiesByVisibleIdsInSourceOrder(
      supportedChats,
      strictVisibleChats,
      repairedChats,
    );
    this.rememberManagedEntitiesLastSuccessChats(userId, visibleChats);

    return visibleChats;
  }

  private async repairManagedEntityAccessEdgesFromAllowlist(
    userId: string,
    candidates: readonly ChatSummary[],
    visibleChats: readonly ChatSummary[],
  ): Promise<ChatSummary[]> {
    if (candidates.length === 0) {
      return [];
    }

    const visibleChatIds = new Set(visibleChats.map((chat) => chat.id));
    const missingEdgeCandidates = candidates.filter((chat) => !visibleChatIds.has(chat.id));
    if (missingEdgeCandidates.length === 0) {
      return [];
    }

    const client = this.getManagedEntityAccessEdgeClient();
    if (!client?.upsert && !this.maxChatAdminRosterSyncService) {
      return [];
    }

    const allowlistedChats = await this.findAllowlistedManagedEntityRepairChats(
      userId,
      missingEdgeCandidates,
    );
    if (allowlistedChats.size === 0) {
      return [];
    }

    const repairCandidates = missingEdgeCandidates
      .map((chat) => {
        const allowlistedAt = allowlistedChats.get(chat.id);
        if (!allowlistedAt) {
          return null;
        }
        const botIds = this.resolveManagedEntityAccessRepairBotIds(chat);

        return { chat, botIds, allowlistedAt };
      })
      .filter(
        (candidate): candidate is { chat: ChatSummary; botIds: string[]; allowlistedAt: Date } =>
          candidate !== null,
      );
    if (repairCandidates.length === 0) {
      return [];
    }

    const deniedRepairKeys = await this.findFreshDeniedManagedEntityRepairKeys(
      userId,
      repairCandidates,
      client,
    );
    const repairedChatIds = new Set<string>();
    const repairWrites: Array<{ chat: ChatSummary; botId: string }> = [];
    for (const { chat, botIds } of repairCandidates) {
      const repairableBotIds = botIds.filter(
        (botId) => !deniedRepairKeys.has(this.buildManagedEntityRepairEdgeKey(chat.id, botId)),
      );
      if (client?.upsert && repairableBotIds.length > 0) {
        repairedChatIds.add(chat.id);
        for (const botId of repairableBotIds) {
          repairWrites.push({ chat, botId });
        }
      }
      if (this.maxChatAdminRosterSyncService) {
        void this.maxChatAdminRosterSyncService
          .scheduleChatAdminRosterSync({
            chatId: chat.id,
            botIds,
            title: chat.title,
            entityType: chat.entityType,
            source: 'admin_access_validation',
          })
          .catch((error: unknown) => {
            this.logger.warn(
              {
                chatId: chat.id,
                entityType: chat.entityType,
                userId,
                err: error instanceof Error ? error.message : String(error),
              },
              'Failed to enqueue managed entity access edge repair from allowlist',
            );
          });
      }
    }

    for (
      let index = 0;
      index < repairWrites.length;
      index += MANAGED_ENTITIES_ALLOWLIST_EDGE_REPAIR_BATCH_SIZE
    ) {
      await Promise.all(
        repairWrites
          .slice(index, index + MANAGED_ENTITIES_ALLOWLIST_EDGE_REPAIR_BATCH_SIZE)
          .map(({ chat, botId }) =>
            this.upsertManagedEntityAccessEdge({
              chatId: chat.id,
              userId,
              botId,
              entityType: chat.entityType,
              state: 'GRANTED',
              userRole: 'ADMIN',
              botRole: 'ADMIN',
              source: 'allowlist_edge_repair',
            }),
          ),
      );
    }

    return repairCandidates
      .filter(({ chat }) => repairedChatIds.has(chat.id))
      .map(({ chat }) => this.cloneManagedEntitySummary(chat));
  }

  private async findAllowlistedManagedEntityRepairChats(
    userId: string,
    candidates: readonly ChatSummary[],
  ): Promise<Map<string, Date>> {
    const chatIds = Array.from(
      new Set(candidates.map((chat) => chat.id.trim()).filter((chatId) => chatId.length > 0)),
    );
    if (chatIds.length === 0) {
      return new Map();
    }

    try {
      const rows = await this.prisma.chatAdminAllowlist.findMany({
        where: {
          userId,
          chatId: {
            in: chatIds,
          },
        },
        select: {
          chatId: true,
          createdAt: true,
        },
      });
      const allowlistedChats = new Map<string, Date>();
      for (const row of rows as Array<{ chatId: string; createdAt: Date }>) {
        const chatId = row.chatId.trim();
        if (chatId.length > 0) {
          allowlistedChats.set(chatId, row.createdAt);
        }
      }
      return allowlistedChats;
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId,
          requestedItems: chatIds.length,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to confirm allowlist rows for managed entity access edge repair',
      );
      return new Map();
    }
  }

  private async findFreshDeniedManagedEntityRepairKeys(
    userId: string,
    candidates: ReadonlyArray<{
      chat: ChatSummary;
      botIds: readonly string[];
      allowlistedAt: Date;
    }>,
    client: ManagedEntityAccessEdgeClient | null,
  ): Promise<Set<string>> {
    if (!client?.findMany || candidates.length === 0) {
      return new Set();
    }

    const chatIds = Array.from(new Set(candidates.map((candidate) => candidate.chat.id)));
    const botIds = Array.from(new Set(candidates.flatMap((candidate) => candidate.botIds)));
    if (chatIds.length === 0 || botIds.length === 0) {
      return new Set();
    }

    const allowlistedAtByChatId = new Map(
      candidates.map((candidate) => [candidate.chat.id, candidate.allowlistedAt] as const),
    );

    try {
      const rows = await client.findMany({
        where: {
          userId,
          chatId: {
            in: chatIds,
          },
          botId: {
            in: botIds,
          },
          state: {
            in: ['USER_DENIED', 'BOT_DENIED'],
          },
        },
        select: {
          chatId: true,
          botId: true,
          state: true,
          checkedAt: true,
        },
      });
      const deniedKeys = new Set<string>();
      for (const row of rows) {
        if (row.state !== 'USER_DENIED' && row.state !== 'BOT_DENIED') {
          continue;
        }
        const allowlistedAt = allowlistedAtByChatId.get(row.chatId);
        if (!allowlistedAt) {
          continue;
        }
        if (!row.checkedAt || row.checkedAt.getTime() >= allowlistedAt.getTime()) {
          deniedKeys.add(this.buildManagedEntityRepairEdgeKey(row.chatId, row.botId));
        }
      }
      return deniedKeys;
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId,
          requestedItems: candidates.length,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to inspect denied managed entity access edges before allowlist repair',
      );
      return new Set();
    }
  }

  private buildManagedEntityRepairEdgeKey(chatId: string, botId: string): string {
    return `${chatId}:${botId}`;
  }

  private async attachChannelOverview(chats: ChatSummary[]): Promise<ChatSummary[]> {
    const channelIds = chats.filter((chat) => chat.entityType === 'channel').map((chat) => chat.id);

    if (channelIds.length === 0 || typeof this.prisma.channelSettings?.findMany !== 'function') {
      return chats;
    }

    try {
      const rows = await this.prisma.channelSettings.findMany({
        where: {
          chatId: {
            in: channelIds,
          },
        },
        select: {
          chatId: true,
          commentsEnabled: true,
          postSuggestionsEnabled: true,
          commentsModerationEnabled: true,
        },
      });

      const byChatId = new Map(
        rows.map((row) => [
          row.chatId,
          {
            commentsEnabled: row.commentsEnabled,
            postSuggestionsEnabled: row.postSuggestionsEnabled,
            commentsModerationEnabled: row.commentsModerationEnabled,
          },
        ]),
      );

      return chats.map((chat) => {
        if (chat.entityType !== 'channel') {
          return chat;
        }

        const settings = byChatId.get(chat.id) ?? DEFAULT_CHANNEL_SETTINGS;
        return {
          ...chat,
          channelOverview: buildChannelOverview(settings),
        };
      });
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to attach channel overview to managed entities list',
      );
      return chats;
    }
  }

  private async attachManagedEntityAvatars(
    chats: ChatSummary[],
    _options: {
      remoteChats?: readonly MaxBotChat[];
    } = {},
  ): Promise<ChatSummary[]> {
    if (chats.length === 0) {
      return chats;
    }

    const headersByChatId = new Map<string, ManagedEntityHeader>();

    await Promise.all(
      chats.map(async (chat) => {
        const cachedHeader = await this.chatContextCache.getManagedEntityHeader?.(
          chat.id,
          chat.entityType,
        );
        if (cachedHeader) {
          headersByChatId.set(chat.id, cachedHeader);
        }
      }),
    );

    if (headersByChatId.size === 0) {
      return chats;
    }

    return chats.map((chat) => {
      const header = headersByChatId.get(chat.id);
      if (!header) {
        return chat;
      }

      const title =
        resolvePresentableManagedEntityTitle(
          chat.id,
          this.readTrimmedString(header.title),
          chat.title,
        ) ?? chat.title;
      const link = this.readTrimmedString(header.link) ?? chat.link ?? null;
      const avatarUrl = this.readTrimmedString(header.avatarUrl);

      return {
        ...chat,
        title,
        link,
        ...(avatarUrl ? { avatarUrl } : {}),
      };
    });
  }

  private async primeManagedEntityHeaders(
    chats: ChatSummary[],
    remoteChats: readonly MaxBotChat[],
  ): Promise<void> {
    if (
      !Array.isArray(remoteChats) ||
      remoteChats.length === 0 ||
      typeof this.chatContextCache.setManagedEntityHeader !== 'function'
    ) {
      return;
    }

    const remoteByChatId = new Map(remoteChats.map((chat) => [chat.chatId, chat]));
    await Promise.all(
      chats.map(async (chat) => {
        const remoteChat = remoteByChatId.get(chat.id);
        if (!remoteChat) {
          return;
        }

        const presentableTitle = resolvePresentableManagedEntityTitle(
          chat.id,
          remoteChat.title,
          chat.title,
        );
        const title = presentableTitle ?? chat.title;
        const link = remoteChat.link ?? chat.link ?? null;
        const avatarUrl =
          this.readTrimmedString(remoteChat.avatarUrl) ?? this.readTrimmedString(chat.avatarUrl);

        if (link === null && avatarUrl === null && title === chat.title) {
          return;
        }

        if (presentableTitle && presentableTitle !== chat.title) {
          try {
            await this.prisma.chat.update({
              where: { id: chat.id },
              data: { title: presentableTitle },
            });
          } catch (error: unknown) {
            this.logger.warn(
              {
                chatId: chat.id,
                err: error instanceof Error ? error.message : String(error),
              },
              'Failed to persist discovered managed entity title',
            );
          }
        }

        await this.chatContextCache.setManagedEntityHeader(
          this.createManagedEntityHeader({
            id: chat.id,
            title,
            entityType: chat.entityType,
            link,
            participantsCount: null,
            avatarUrl,
            primaryBotId: chat.primaryBotId,
            assignedBots: chat.assignedBots,
            sharedMode: chat.sharedMode,
          }),
        );
      }),
    );
  }

  private async hydrateManagedEntities(
    chats: ChatSummary[],
    options: {
      remoteChats?: readonly MaxBotChat[];
    } = {},
  ): Promise<ChatSummary[]> {
    if (Array.isArray(options.remoteChats) && options.remoteChats.length > 0) {
      await this.primeManagedEntityHeaders(chats, options.remoteChats);
    }
    const withAvatars = await this.attachManagedEntityAvatars(chats, options);
    return this.attachChannelOverview(withAvatars);
  }

  private scheduleManagedEntityHeaderHydration(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    chats: ChatSummary[],
    options: {
      remoteChats?: readonly MaxBotChat[];
      deferStart?: boolean;
    } = {},
  ) {
    if (chats.length === 0) {
      return;
    }

    const key = this.buildManagedEntitiesRefreshCooldownKey(userId, entityType);
    if (this.managedEntityHeaderHydrationRuns.has(key)) {
      return;
    }

    const chatsSnapshot = chats.map((chat) => ({ ...chat }));
    const remoteChatsSnapshot =
      Array.isArray(options.remoteChats) && options.remoteChats.length > 0
        ? options.remoteChats.map((chat) => ({ ...chat }))
        : undefined;

    let pending: Promise<void> | null = null;
    const startHydration = (): Promise<void> =>
      this.runManagedEntityHeaderHydration(
        userId,
        entityType,
        key,
        chatsSnapshot,
        remoteChatsSnapshot,
      )
        .catch((error: unknown) => {
          this.logger.warn(
            {
              entityType,
              userId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Managed entity header hydration failed',
          );
        })
        .finally(() => {
          if (pending !== null && this.managedEntityHeaderHydrationRuns.get(key) === pending) {
            this.managedEntityHeaderHydrationRuns.delete(key);
          }
        });

    pending =
      options.deferStart === true
        ? new Promise<void>((resolve) => {
            setImmediate(() => {
              void startHydration().then(resolve);
            });
          })
        : startHydration();

    this.managedEntityHeaderHydrationRuns.set(key, pending);
  }

  private async runManagedEntityHeaderHydration(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    refreshKey: string,
    chats: ChatSummary[],
    remoteChats?: readonly MaxBotChat[],
  ): Promise<void> {
    if (await this.isManagedEntitiesRefreshBackoffActive(userId, entityType, refreshKey)) {
      return;
    }

    if (Array.isArray(remoteChats) && remoteChats.length > 0) {
      await this.primeManagedEntityHeaders(chats, remoteChats);
    }

    const hydrationCandidates = (
      await Promise.all(
        chats.map(async (chat) => {
          const cachedHeader = await this.chatContextCache.getManagedEntityHeader?.(
            chat.id,
            chat.entityType,
          );
          return this.isManagedEntityHeaderStale(cachedHeader ?? null, chat) ? chat : null;
        }),
      )
    )
      .filter((chat): chat is ChatSummary => chat !== null)
      .sort((left, right) => {
        if (left.entityType === right.entityType) {
          return 0;
        }
        return left.entityType === 'channel' ? -1 : 1;
      })
      .slice(0, MANAGED_ENTITY_HEADER_HYDRATION_BATCH_SIZE);

    if (hydrationCandidates.length === 0 || typeof this.maxClient.getChatSnapshot !== 'function') {
      return;
    }

    let shouldBackoff = false;
    let failure: unknown = null;

    await mapWithConcurrencyLimit(
      hydrationCandidates,
      MANAGED_ENTITY_HEADER_HYDRATION_CONCURRENCY,
      async (chat) => {
        if (shouldBackoff) {
          return null;
        }

        try {
          const snapshot = await this.maxClient.getChatSnapshot(chat.id, {
            trafficClass: 'background',
            sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
            ...(chat.primaryBotId ? { botId: chat.primaryBotId } : {}),
          });
          await this.persistManagedEntityHeaderSnapshot(chat, snapshot);
        } catch (error: unknown) {
          if (isMaxApiThrottleError(error) || isMaxApiTimeoutError(error)) {
            shouldBackoff = true;
            failure = error;
          }
        }

        return null;
      },
    );

    if (!shouldBackoff) {
      return;
    }

    const backoffMs = await this.activateManagedEntitiesRefreshBackoff(
      userId,
      entityType,
      refreshKey,
    );
    this.logger.warn(
      {
        entityType,
        userId,
        backoffMs,
        err: failure instanceof Error ? failure.message : String(failure),
      },
      'Paused managed entity header hydration after MAX API throttling',
    );
  }

  private isManagedEntityHeaderStale(
    header: ManagedEntityHeader | null,
    chat: ChatSummary,
    options: {
      refreshMissingLink?: boolean;
    } = {},
  ): boolean {
    if (!header) {
      return true;
    }

    return (
      isFallbackTitle(chat.id, header.title) ||
      !this.readTrimmedString(header.avatarUrl) ||
      (options.refreshMissingLink === true && !this.readTrimmedString(header.link))
    );
  }

  private toHeaderChatSummary(header: ManagedEntityHeader): ChatSummary {
    return this.createManagedEntitySummary({
      id: header.id,
      title: header.title,
      createdAt: new Date(0).toISOString(),
      entityType: header.entityType,
      link: header.link,
      avatarUrl: this.readTrimmedString(header.avatarUrl) ?? null,
      primaryBotId: header.primaryBotId,
      assignedBots: header.assignedBots,
      sharedMode: header.sharedMode,
    });
  }

  private async persistManagedEntityHeaderSnapshot(
    chat: ChatSummary,
    snapshot: {
      title: string | null;
      link: string | null;
      participantsCount: number | null;
      avatarUrl: string | null;
    },
  ): Promise<void> {
    const title = this.readTrimmedString(snapshot.title) ?? chat.title;
    const avatarUrl = this.readTrimmedString(snapshot.avatarUrl);
    const link = this.readTrimmedString(snapshot.link) ?? chat.link ?? null;

    if (!isFallbackTitle(chat.id, title) && title !== chat.title) {
      try {
        await this.prisma.chat.update({
          where: { id: chat.id },
          data: { title },
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: chat.id,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to persist refreshed managed entity title',
        );
      }
    }

    await this.chatContextCache.setManagedEntityHeader?.(
      this.createManagedEntityHeader({
        id: chat.id,
        title,
        entityType: chat.entityType,
        link,
        participantsCount: snapshot.participantsCount ?? null,
        avatarUrl,
        primaryBotId: chat.primaryBotId,
        assignedBots: chat.assignedBots,
        sharedMode: chat.sharedMode,
      }),
    );
  }

  private async upsertUserChatAccess(
    chatId: string,
    userId: string,
    chatTitle: string | null,
    entityType: ManagedEntityType | null = null,
    options: {
      updateEntityType?: boolean;
      preferredBotId?: string | null;
      observedBotIds?: readonly string[] | null;
      titleUpdateMode?: 'always' | 'fallback_only';
    } = {},
  ) {
    const normalizedTitle = chatTitle?.trim() ? chatTitle.trim() : null;
    const fallbackTitle = entityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`;
    const presentableTitle = resolvePresentableManagedEntityTitle(chatId, normalizedTitle);
    const nextTitle = presentableTitle ?? fallbackTitle;
    const updateEntityType = options.updateEntityType === true;
    const titleUpdateMode =
      options.titleUpdateMode === 'fallback_only' ? 'fallback_only' : 'always';
    const observedBotIds = Array.from(
      new Set(
        (options.observedBotIds ?? [])
          .map((botId) => this.maxBotRegistry?.getBotById(botId)?.id ?? null)
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    let shouldUpdateTitle = false;
    if (presentableTitle) {
      if (titleUpdateMode === 'always') {
        shouldUpdateTitle = true;
      } else {
        const existing = await this.prisma.chat.findUnique({
          where: { id: chatId },
          select: { title: true },
        });
        const existingTitle = this.readTrimmedString(existing?.title);
        shouldUpdateTitle =
          !existingTitle || existingTitle === chatId || isFallbackTitle(chatId, existingTitle);
      }
    }
    let resolvedBotId: string | null | undefined =
      this.maxBotRegistry?.getBotById(options.preferredBotId)?.id ?? observedBotIds[0] ?? null;
    if (!resolvedBotId) {
      try {
        resolvedBotId = (await this.resolveBotAssignment(chatId)) ?? undefined;
      } catch (error: unknown) {
        if (!isPrismaKnownError(error, 'P2024')) {
          throw error;
        }

        this.logger.warn(
          {
            chatId,
            userId,
            code:
              error instanceof Prisma.PrismaClientKnownRequestError
                ? error.code
                : ((error as { code?: string } | null)?.code ?? null),
            err: error instanceof Error ? error.message : String(error),
          },
          'Skipped bot assignment lookup while persisting managed entity access because the Prisma pool is saturated',
        );
      }
    }
    const persistedChat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: nextTitle,
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        ...(entityType ? { entityType: toPrismaEntityType(entityType) } : {}),
      },
      update: {
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        ...(shouldUpdateTitle
          ? {
              title: nextTitle,
            }
          : {}),
        ...(updateEntityType && entityType ? { entityType: toPrismaEntityType(entityType) } : {}),
      },
    });

    await this.prisma.chatAdminAllowlist.upsert({
      where: {
        chatId_userId: {
          chatId,
          userId,
        },
      },
      create: {
        chatId,
        userId,
      },
      update: {},
    });
    this.invalidateManagedEntitiesAllowlistCache(userId);

    if (typeof this.maxBotLinkService?.bindDiscoveredChatBots === 'function') {
      try {
        await this.maxBotLinkService.bindDiscoveredChatBots({
          chatId,
          primaryBotId: resolvedBotId,
          botIds: resolvedBotId ? [resolvedBotId, ...observedBotIds] : observedBotIds,
          title: persistedChat.title,
          entityType: entityType ? toPrismaEntityType(entityType) : null,
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            code:
              error instanceof Prisma.PrismaClientKnownRequestError
                ? error.code
                : ((error as { code?: string } | null)?.code ?? null),
            err: error instanceof Error ? error.message : String(error),
          },
          isPrismaKnownError(error, 'P2024')
            ? 'Skipped discovered chat bot binding because the Prisma pool is saturated'
            : 'Failed to bind discovered chat bots after persisting managed entity access',
        );
      }
    }

    if (shouldUpdateTitle || updateEntityType) {
      await this.chatContextCache.invalidateManagedEntityHeader?.(chatId);
    }

    return persistedChat;
  }

  private async ensureEntityType(
    chatId: string,
    userId: string,
    expectedEntityType: ManagedEntityType,
  ): Promise<void> {
    const current = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
      },
    });

    if (current) {
      if (fromPrismaEntityType(current.entityType) === expectedEntityType) {
        return;
      }

      try {
        const resolvedBotId = await this.resolveBotAssignment(chatId);
        const snapshot = await this.maxClient.getChatSnapshot(chatId, {
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
          ...(resolvedBotId ? { botId: resolvedBotId } : {}),
        });
        if (snapshot.entityType === expectedEntityType) {
          await this.upsertUserChatAccess(chatId, userId, snapshot.title, expectedEntityType, {
            updateEntityType: true,
            titleUpdateMode: 'fallback_only',
            preferredBotId: resolvedBotId ?? null,
          });
          return;
        }
      } catch (error: unknown) {
        if (error instanceof BadRequestException) {
          throw error;
        }
      }

      throw new BadRequestException(
        expectedEntityType === 'channel'
          ? 'Этот ID относится к чату, а не к каналу.'
          : 'Этот ID относится к каналу, а не к чату.',
      );
    }

    try {
      const resolvedBotId = await this.resolveBotAssignment(chatId);
      const snapshot = await this.maxClient.getChatSnapshot(chatId, {
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
        ...(resolvedBotId ? { botId: resolvedBotId } : {}),
      });
      if (snapshot.entityType !== expectedEntityType) {
        throw new BadRequestException(
          expectedEntityType === 'channel'
            ? 'Этот ID относится к чату, а не к каналу.'
            : 'Этот ID относится к каналу, а не к чату.',
        );
      }
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }
    }

    await this.upsertUserChatAccess(chatId, userId, null, expectedEntityType);
  }

  private async getManagedEntityHeader(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedEntityHeader> {
    return getManagedEntityHeaderValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      logger: this.logger,
      chatId,
      entityType,
      options,
      assertReadAccess: (readOptions) =>
        this.assertManagedEntityReadAccess(chatId, user.userId, entityType, readOptions),
      resolveReadBotId: () => this.resolveManagedEntityHeaderReadBotId(chatId),
      attachBotAssignments: (header) =>
        this.attachManagedEntityHeaderBotAssignmentsForManagedEntities(header),
    });
  }

  private invalidateLogsDashboardResponseCache(chatId: string): void {
    const prefix = `${chatId}:`;
    for (const key of this.logsDashboardResponseCache.keys()) {
      if (key.startsWith(prefix)) {
        this.logsDashboardResponseCache.delete(key);
      }
    }
  }

  private invalidateChannelStatsResponseCache(chatId: string): void {
    const prefix = `${chatId}:`;
    for (const key of this.channelStatsResponseCache.keys()) {
      if (key.startsWith(prefix)) {
        this.channelStatsResponseCache.delete(key);
      }
    }
  }

  private invalidateModerationFeedPageCache(chatId: string): void {
    const prefix = `${chatId}:`;
    for (const key of this.moderationFeedPageCache.keys()) {
      if (key.startsWith(prefix)) {
        this.moderationFeedPageCache.delete(key);
      }
    }
  }

  private invalidateChatParticipantsPageCache(chatId: string): void {
    const prefix = `${chatId}:`;
    for (const key of this.chatParticipantsPageCache.keys()) {
      if (key.startsWith(prefix)) {
        this.chatParticipantsPageCache.delete(key);
      }
    }
  }
}
