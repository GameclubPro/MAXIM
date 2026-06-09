/* eslint-disable @typescript-eslint/no-unused-vars */

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
  managedBroadcastDetailsSchema,
  type ManagedBroadcastSummary,
  type ManagedBroadcastTargetPreview,
  type ManagedEntityBotCapability,
  managedBroadcastCalendarResponseSchema,
  managedBroadcastSummarySchema,
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
  type UpdateChatRulesRequest,
  type PublishChatRulesResult,
  type BroadcastTextFormat,
  type BroadcastTargetMode,
  type BroadcastLinkButton,
  type ManagedEntityAssignedBot,
  type ManagedEntitiesListResponse,
  type ManagedEntitiesResponseDiff,
  type ManagedEntitiesResponseSnapshot,
  type ManagedEntitiesRefreshState,
  type SendBroadcastRequest,
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
  sendBroadcastRequestSchema,
  sendBroadcastTestResultSchema,
  scheduleDomainRemovalRequestSchema,
  toggleChannelDialogReactionResponseSchema,
  updateChannelDialogNotificationsRequestSchema,
  updateChannelDialogNotificationsResponseSchema,
  updateChannelDialogMessageRequestSchema,
  updateChannelDialogMessageResponseSchema,
  type AllowlistMatchType,
  type BroadcastImage,
  DEFAULT_BROADCAST_BUTTON_TEXT,
  MAX_BROADCAST_IMAGES,
  MAX_BROADCAST_LINK_BUTTONS,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
  INVITATION_ACCESS_REQUIRED_COUNT_MAX,
  INVITATION_ACCESS_REQUIRED_COUNT_MIN,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_DEFAULT,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN,
  normalizeDeleteBotMessagesDelayMinutes,
} from '@maxim/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import {
  ChatBotMembershipStatus,
  ChatEntityType,
  DialogNotificationMode as PrismaDialogNotificationMode,
  ManagedBroadcastDeliveryStatus as PrismaManagedBroadcastDeliveryStatus,
  EventType,
  ManagedBroadcastStatus as PrismaManagedBroadcastStatus,
  Operator,
  Prisma,
  PrismaClient,
  SanctionAction,
  createPrismaClient,
  type ManagedBroadcast as PersistedManagedBroadcast,
  type ManagedBroadcastDelivery as PersistedManagedBroadcastDelivery,
  type ManagedBroadcastOccurrence as PersistedManagedBroadcastOccurrence,
  type ChatRules as PersistedChatRules,
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
import {
  appendAdminContactMarkdownLink as appendAdminContactMarkdownLinkText,
  resolveAdminContactMentionTarget,
} from '../common/admin-contact-link.util';
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
  type MaxPublishedMessage,
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
  buildChatRulesButtonRows as buildChatRulesButtonRowsValue,
  buildStoredLinkButtonState as buildStoredLinkButtonStateValue,
  decodeRulesImageBase64 as decodeRulesImageBase64Value,
  ensureChatRules as ensureChatRulesValue,
  extractMaxApiErrorMessage as extractMaxApiErrorMessageValue,
  hydratePublishedRulesUrl as hydratePublishedRulesUrlValue,
  isMaxMessageMissingError as isMaxMessageMissingErrorValue,
  mapChatRules as mapChatRulesValue,
  normalizeChatRulesDraft as normalizeChatRulesDraftValue,
  normalizePublishedRulesUrl as normalizePublishedRulesUrlValue,
  normalizeStoredLinkButtons as normalizeStoredLinkButtonsValue,
  publishChatRules,
  resetPublishedChatRules,
  resolveRulesImageFileName as resolveRulesImageFileNameValue,
  saveChatRulesDraft,
} from './admin-chat-rules';
import {
  publishChannelEngagementMessage as publishChannelEngagementMessageValue,
  type BuildChannelEngagementDialogArtifactsParams,
  type ChannelEngagementDialogArtifacts,
} from './admin-channel-engagement';
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
  RULES_IMAGE_MAX_BYTES,
  BROADCAST_IMAGE_MAX_BYTES,
  BROADCAST_IMAGES_TOTAL_MAX_BYTES,
  BROADCAST_MIN_DELAY_MS,
  BROADCAST_MAX_DELAY_MS,
  MANAGED_BROADCAST_HISTORY_WINDOW_MS,
  MANAGED_BROADCAST_HISTORY_LIMIT,
  BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS,
  BROADCAST_THROTTLE_RETRY_DELAYS_MS,
  BROADCAST_TIMEOUT_RETRY_DELAYS_MS,
  BROADCAST_CALENDAR_SLOT_MINUTES,
  MANAGED_BROADCAST_DUE_BATCH_SIZE,
  MANAGED_BROADCAST_DUE_SLOW_BATCH_SIZE,
  MANAGED_BROADCAST_RECOVERY_BATCH_SIZE,
  MANAGED_BROADCAST_RECOVERY_SLOW_BATCH_SIZE,
  MANAGED_BROADCAST_DUE_MAX_PASSES,
  MANAGED_BROADCAST_LOCK_STALE_MS,
  MANAGED_BROADCAST_AUTO_RETRY_BACKOFF_MS,
  MANAGED_BROADCAST_MAX_AUTO_RETRY_ATTEMPTS,
  MANAGED_BROADCAST_TARGET_QUARANTINE_FAILURE_OCCURRENCES,
  MANAGED_BROADCAST_TARGET_QUARANTINE_ATTEMPTS,
  MANAGED_BROADCAST_TRANSIENT_QUARANTINE_REASON_PREFIX,
  MANAGED_BROADCAST_DEGRADE_PAUSE_RETRY_MS,
  MANAGED_BROADCAST_DEGRADE_PAUSE_LOG_INTERVAL_MS,
  MANAGED_BROADCAST_TARGET_PREVIEW_LIMIT,
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
  normalizeBroadcastScheduleMode,
  readBooleanConfigFlag,
  readManagedBroadcastMediaType,
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
  type PreparedManagedBroadcastRequest,
  type ManagedBroadcastResolvedMedia,
  type ManagedBroadcastMaxApiOptions,
  type ManagedBroadcastSchedulePlan,
  type ManagedBroadcastBackgroundDecision,
  type ParsedManagedBroadcastCalendarSlots,
  type BroadcastOccurrenceResult,
  type ManagedBroadcastDeliverySnapshot,
  type ManagedBroadcastTargetPreviewBundle,
  type ManagedBroadcastFailureBreakdown,
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

type ManagedBroadcastCommentDialogReference = {
  entityType: ManagedEntityType;
  threadId: string;
  includeCommentsButton: boolean;
  includeSuggestButton: boolean;
  suggestButtonText: string | null;
  autoPostButtonsMode: ChannelSettings['autoPostButtonsMode'] | null;
  suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'] | null;
  botId: string | null;
};

export class AdminManagedBroadcastRuntime {
  [key: string]: any;

  constructor(private readonly context: any) {
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return this.context[prop as keyof typeof this.context];
      },
      set: (target, prop, value, receiver) => {
        if (prop in target) {
          return Reflect.set(target, prop, value, receiver);
        }
        this.context[prop as keyof typeof this.context] = value;
        return true;
      },
    });
  }

  async sendBroadcast(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<SendBroadcastResult> {
    return this.sendManagedBroadcast(sourceChatId, user, body, {
      entityType: 'chat',
      source,
      resolveTargets: (actor) =>
        this.listChatsForMassBroadcast(actor, { discoveryMode: 'cached-first' }),
    });
  }

  async sendChannelBroadcast(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<SendBroadcastResult> {
    return this.sendManagedBroadcast(sourceChatId, user, body, {
      entityType: 'channel',
      source,
    });
  }

  async sendBroadcastTest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<SendBroadcastTestResult> {
    return this.sendManagedBroadcastTest(sourceChatId, user, body, 'chat');
  }

  async sendChannelBroadcastTest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<SendBroadcastTestResult> {
    return this.sendManagedBroadcastTest(sourceChatId, user, body, 'channel');
  }

  async listManagedBroadcasts(
    sourceChatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedBroadcastSummary[]> {
    return this.listManagedBroadcastsForEntity(sourceChatId, user, 'chat', options);
  }

  async listChannelManagedBroadcasts(
    sourceChatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedBroadcastSummary[]> {
    return this.listManagedBroadcastsForEntity(sourceChatId, user, 'channel', options);
  }

  async getManagedBroadcastCalendar(
    sourceChatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ManagedBroadcastCalendarResponse> {
    return this.getManagedBroadcastCalendarForEntity(sourceChatId, user, 'chat', query);
  }

  async getChannelManagedBroadcastCalendar(
    sourceChatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ManagedBroadcastCalendarResponse> {
    return this.getManagedBroadcastCalendarForEntity(sourceChatId, user, 'channel', query);
  }

  async getManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.getManagedBroadcastForEntity(sourceChatId, broadcastId, user, 'chat');
  }

  async getChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.getManagedBroadcastForEntity(sourceChatId, broadcastId, user, 'channel');
  }

  async updateManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedBroadcastDetails> {
    return this.updateManagedBroadcastForEntity(sourceChatId, broadcastId, user, body, 'chat');
  }

  async updateChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedBroadcastDetails> {
    return this.updateManagedBroadcastForEntity(sourceChatId, broadcastId, user, body, 'channel');
  }

  async cancelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.cancelManagedBroadcastForEntity(sourceChatId, broadcastId, user, 'chat');
  }

  async cancelChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.cancelManagedBroadcastForEntity(sourceChatId, broadcastId, user, 'channel');
  }

  async retryManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.retryManagedBroadcastForEntity(sourceChatId, broadcastId, user, 'chat');
  }

  async retryChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.retryManagedBroadcastForEntity(sourceChatId, broadcastId, user, 'channel');
  }

  async processDueManagedBroadcasts(reason: 'startup' | 'scheduled'): Promise<void> {
    for (let pass = 0; pass < MANAGED_BROADCAST_DUE_MAX_PASSES; pass += 1) {
      const governorDecision = await this.resolveManagedBroadcastBackgroundDecision(reason);
      if (governorDecision.action === 'pause') {
        return;
      }

      const dueBatchSize =
        governorDecision.action === 'slow'
          ? MANAGED_BROADCAST_DUE_SLOW_BATCH_SIZE
          : MANAGED_BROADCAST_DUE_BATCH_SIZE;
      const recoveryBatchSize =
        governorDecision.action === 'slow'
          ? MANAGED_BROADCAST_RECOVERY_SLOW_BATCH_SIZE
          : MANAGED_BROADCAST_RECOVERY_BATCH_SIZE;
      const now = new Date();
      const staleLockBefore = new Date(now.getTime() - MANAGED_BROADCAST_LOCK_STALE_MS);
      const autoRetryBefore = new Date(now.getTime() - MANAGED_BROADCAST_AUTO_RETRY_BACKOFF_MS);
      const [activeDueRows, retryableDueRows] = await Promise.all([
        this.prisma.managedBroadcast.findMany({
          where: {
            status: PrismaManagedBroadcastStatus.ACTIVE,
            nextSendAt: { lte: now },
            OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
          },
          orderBy: [{ nextSendAt: 'asc' }, { createdAt: 'asc' }],
          take: dueBatchSize,
          select: { id: true },
        }),
        this.prisma.managedBroadcast.findMany({
          where: {
            status: {
              in: [PrismaManagedBroadcastStatus.PARTIAL, PrismaManagedBroadcastStatus.FAILED],
            },
            nextSendAt: { lte: now },
            updatedAt: { lte: autoRetryBefore },
            OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
          },
          orderBy: [{ nextSendAt: 'asc' }, { createdAt: 'asc' }],
          take: dueBatchSize,
          select: { id: true },
        }),
      ]);
      const reservedRecoveryCount = Math.min(
        retryableDueRows.length,
        Math.min(recoveryBatchSize, dueBatchSize),
      );
      const dueRows = [
        ...activeDueRows.slice(0, dueBatchSize - reservedRecoveryCount),
        ...retryableDueRows.slice(0, reservedRecoveryCount),
      ];
      if (dueRows.length < dueBatchSize) {
        const remainingSlots = dueBatchSize - dueRows.length;
        const activeOverflowOffset = dueBatchSize - reservedRecoveryCount;
        dueRows.push(
          ...activeDueRows.slice(activeOverflowOffset, activeOverflowOffset + remainingSlots),
        );
      }
      if (dueRows.length < dueBatchSize) {
        const remainingSlots = dueBatchSize - dueRows.length;
        dueRows.push(
          ...retryableDueRows.slice(reservedRecoveryCount, reservedRecoveryCount + remainingSlots),
        );
      }

      if (dueRows.length === 0) {
        return;
      }

      for (const row of dueRows) {
        await this.context.processManagedBroadcastOccurrence(row.id, reason, staleLockBefore, [
          PrismaManagedBroadcastStatus.ACTIVE,
          PrismaManagedBroadcastStatus.PARTIAL,
          PrismaManagedBroadcastStatus.FAILED,
        ]);
      }

      if (governorDecision.action === 'slow') {
        return;
      }
    }

    this.logger.warn(
      `Managed broadcast due backlog was not fully drained after ${MANAGED_BROADCAST_DUE_MAX_PASSES} passes.`,
    );
  }

  private async resolveManagedBroadcastBackgroundDecision(
    reason: 'startup' | 'scheduled',
  ): Promise<ManagedBroadcastBackgroundDecision> {
    if (this.backgroundRuntimeGovernorService) {
      const decision = await this.backgroundRuntimeGovernorService.decide({
        component: 'managed-broadcast',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
      });
      if (decision.action !== 'run') {
        return this.logManagedBroadcastBackgroundThrottleDecision(reason, decision);
      }

      return decision;
    }

    const snapshot = await this.resolveSystemModeSnapshot();
    if (snapshot.mode === 'degrade' && !isSystemModeRecoveryWindow(snapshot)) {
      return this.logManagedBroadcastSystemModePauseDecision(reason, snapshot);
    }

    return {
      action: 'run',
      reason: 'background headroom available',
      retryAfterMs: 0,
    };
  }

  private logManagedBroadcastBackgroundThrottleDecision(
    reason: 'startup' | 'scheduled',
    decision: ManagedBroadcastBackgroundDecision,
  ): ManagedBroadcastBackgroundDecision {
    const now = Date.now();
    if (
      now - this.managedBroadcastDegradePauseLogAtMs >=
      MANAGED_BROADCAST_DEGRADE_PAUSE_LOG_INTERVAL_MS
    ) {
      this.managedBroadcastDegradePauseLogAtMs = now;
      this.logger.log(
        {
          reason,
          action: decision.action,
          details: decision.reason,
          retryAfterMs: decision.retryAfterMs,
        },
        'Throttled managed broadcast background delivery because the runtime governor detected pressure',
      );
    }

    return decision;
  }

  private logManagedBroadcastSystemModePauseDecision(
    reason: 'startup' | 'scheduled',
    snapshot: Pick<SystemModeSnapshot, 'mode' | 'source' | 'reason'>,
  ): ManagedBroadcastBackgroundDecision {
    const now = Date.now();
    if (
      now - this.managedBroadcastDegradePauseLogAtMs >=
      MANAGED_BROADCAST_DEGRADE_PAUSE_LOG_INTERVAL_MS
    ) {
      this.managedBroadcastDegradePauseLogAtMs = now;
      this.logger.log(
        {
          reason,
          mode: snapshot.mode,
          source: snapshot.source,
          details: snapshot.reason,
        },
        'Paused managed broadcast background delivery because the system is degraded',
      );
    }

    return {
      action: 'pause',
      reason: snapshot.reason,
      retryAfterMs: MANAGED_BROADCAST_DEGRADE_PAUSE_RETRY_MS,
    };
  }

  private async listManagedBroadcastsForEntity(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedBroadcastSummary[]> {
    if (!options.skipAdminCheck) {
      await this.assertReadOnlyChatAdmin(sourceChatId, user.userId, entityType);
    }
    if (!options.skipEntityCheck) {
      await this.ensureEntityType(sourceChatId, user.userId, entityType);
    }

    const baseWhere = {
      sourceChatId,
      entityType: mapManagedEntityTypeToChatEntityType(entityType),
    };
    const [activeRows, recentRows] = await Promise.all([
      this.prisma.managedBroadcast.findMany({
        where: {
          ...baseWhere,
          status: {
            in: [
              PrismaManagedBroadcastStatus.ACTIVE,
              PrismaManagedBroadcastStatus.PARTIAL,
              PrismaManagedBroadcastStatus.FAILED,
            ],
          },
        },
        orderBy: [{ nextSendAt: 'asc' }, { createdAt: 'desc' }],
      }),
      this.prisma.managedBroadcast.findMany({
        where: {
          ...baseWhere,
          status: {
            in: [PrismaManagedBroadcastStatus.COMPLETED, PrismaManagedBroadcastStatus.CANCELED],
          },
          updatedAt: {
            gte: new Date(Date.now() - MANAGED_BROADCAST_HISTORY_WINDOW_MS),
          },
        },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        take: MANAGED_BROADCAST_HISTORY_LIMIT,
      }),
    ]);
    const rows = [
      ...activeRows,
      ...recentRows.filter((row: any) => !activeRows.some((active: any) => active.id === row.id)),
    ];

    const [snapshots, upcomingSlotsMap, targetPreviewBundles] = await Promise.all([
      this.getManagedBroadcastDeliverySnapshots(rows),
      this.getManagedBroadcastUpcomingSlotsMap(rows),
      this.getManagedBroadcastTargetPreviewBundles(rows),
    ]);

    return rows.map((row) =>
      managedBroadcastSummarySchema.parse(
        this.mapManagedBroadcastSummary(
          row,
          snapshots.get(row.id),
          upcomingSlotsMap.get(row.id) ?? [],
          targetPreviewBundles.get(row.id),
        ),
      ),
    );
  }

  private parseManagedBroadcastCalendarQuery(query: unknown): {
    from: Date;
    to: Date;
    targetChatIds: string[];
  } {
    const source = query && typeof query === 'object' ? (query as Record<string, unknown>) : {};
    const now = new Date();
    const fromRaw = typeof source.from === 'string' ? source.from : '';
    const toRaw = typeof source.to === 'string' ? source.to : '';
    const from = fromRaw ? new Date(fromRaw) : now;
    const to = toRaw ? new Date(toRaw) : new Date(from.getTime() + BROADCAST_MAX_DELAY_MS);

    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
      throw new BadRequestException('Некорректный диапазон календаря автопостинга.');
    }
    if (to.getTime() < from.getTime()) {
      throw new BadRequestException('Конец календаря должен быть позже начала.');
    }
    if (to.getTime() - from.getTime() > BROADCAST_MAX_DELAY_MS) {
      throw new BadRequestException('Календарь автопостинга доступен максимум на 31 день.');
    }

    const readTargetValue = (value: unknown): string[] => {
      if (Array.isArray(value)) {
        return value.flatMap((item) => readTargetValue(item));
      }
      if (typeof value !== 'string') {
        return [];
      }
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    };

    return {
      from,
      to,
      targetChatIds: this.normalizeManagedBroadcastTargetChatIds(
        readTargetValue(source.targetChatIds),
      ),
    };
  }

  private async getManagedBroadcastCalendarForEntity(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    query: unknown,
  ): Promise<ManagedBroadcastCalendarResponse> {
    await this.assertReadOnlyChatAdmin(sourceChatId, user.userId, entityType);
    await this.ensureEntityType(sourceChatId, user.userId, entityType);

    const parsedQuery = this.parseManagedBroadcastCalendarQuery(query);
    const targetChatIds =
      parsedQuery.targetChatIds.length > 0 ? parsedQuery.targetChatIds : [sourceChatId];
    const allowedTargetIds = new Set([sourceChatId]);
    if (entityType === 'chat') {
      const availableTargets = await this.listChatsForMassBroadcast(user, {
        discoveryMode: 'cached-first',
      });
      for (const chat of availableTargets) {
        if (chat.entityType === entityType) {
          allowedTargetIds.add(chat.id);
        }
      }
    }

    const invalidTargetChatIds = targetChatIds.filter((chatId) => !allowedTargetIds.has(chatId));
    if (invalidTargetChatIds.length > 0) {
      throw new BadRequestException(
        'Некоторые выбранные чаты больше недоступны. Откройте список заново.',
      );
    }

    const prismaEntityType = mapManagedEntityTypeToChatEntityType(entityType);
    const occurrences = await this.prisma.managedBroadcastOccurrence.findMany({
      where: {
        entityType: prismaEntityType,
        status: {
          in: [
            PrismaManagedBroadcastStatus.ACTIVE,
            PrismaManagedBroadcastStatus.PARTIAL,
            PrismaManagedBroadcastStatus.FAILED,
          ],
        },
        scheduledAt: {
          gte: parsedQuery.from,
          lte: parsedQuery.to,
        },
      },
      include: {
        broadcast: true,
      },
      orderBy: [{ scheduledAt: 'asc' }],
    });
    const requestedTargetChatIdSet = new Set(targetChatIds);
    const activeOccurrences = occurrences.filter((occurrence: any) => {
      if (
        occurrence.broadcast.status !== PrismaManagedBroadcastStatus.ACTIVE &&
        occurrence.broadcast.status !== PrismaManagedBroadcastStatus.PARTIAL &&
        occurrence.broadcast.status !== PrismaManagedBroadcastStatus.FAILED
      ) {
        return false;
      }

      return this.parseManagedBroadcastTargetChatIds(
        occurrence.broadcast.targetChatIds,
        occurrence.broadcast.sourceChatId,
      ).some((chatId) => requestedTargetChatIdSet.has(chatId));
    });
    const broadcastRows = Array.from(
      new Map(
        activeOccurrences.map((occurrence: any) => [occurrence.broadcast.id, occurrence.broadcast]),
      ).values(),
    ) as PersistedManagedBroadcast[];
    const allTargetChatIds = [
      ...targetChatIds,
      ...broadcastRows.flatMap((row) =>
        this.parseManagedBroadcastTargetChatIds(row.targetChatIds, row.sourceChatId),
      ),
    ];
    const previewMap = await this.loadManagedBroadcastTargetPreviewMap(
      allTargetChatIds,
      entityType,
    );

    return managedBroadcastCalendarResponseSchema.parse({
      sourceChatId,
      entityType,
      from: parsedQuery.from.toISOString(),
      to: parsedQuery.to.toISOString(),
      targetChatIds,
      slots: activeOccurrences.map((occurrence: any) => {
        const row = occurrence.broadcast;
        const { targetMode, targetChatIds: rowTargetChatIds } =
          this.resolveManagedBroadcastTargetsFromRow(row);
        const targetPreviewBundle = this.buildManagedBroadcastTargetPreviewBundle(
          rowTargetChatIds,
          previewMap,
          fromPrismaEntityType(row.entityType),
        );
        const overlapChatIds =
          requestedTargetChatIdSet.size > 0
            ? rowTargetChatIds.filter((chatId) => requestedTargetChatIdSet.has(chatId))
            : [];
        const overlapPreviewBundle = this.buildManagedBroadcastTargetPreviewBundle(
          overlapChatIds,
          previewMap,
          fromPrismaEntityType(row.entityType),
        );
        const normalizedText = row.text.replace(/\s+/gu, ' ').trim();
        const hasVideo = readManagedBroadcastMediaType(row.mediaType) === 'video';
        const hasImage = this.readManagedBroadcastImagesFromRow(row).length > 0;

        return {
          broadcastId: row.id,
          sourceChatId: row.sourceChatId,
          scheduledAt: occurrence.scheduledAt.toISOString(),
          status: row.status,
          textPreview: normalizedText
            ? normalizedText.slice(0, 160)
            : hasImage
              ? 'Фото без текста'
              : hasVideo
                ? 'Видео без текста'
                : 'Пустой автопостинг',
          targetMode,
          targetChatIds: rowTargetChatIds,
          targetChats: rowTargetChatIds.length,
          targetPreviews: targetPreviewBundle.previews,
          targetOverflowCount: targetPreviewBundle.overflowCount,
          overlapChatIds,
          overlapPreviews: overlapPreviewBundle.previews,
          overlapOverflowCount: overlapPreviewBundle.overflowCount,
          hasTargetOverlap: overlapChatIds.length > 0,
        };
      }),
    });
  }

  private async getManagedBroadcastForEntity(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedBroadcastDetails> {
    await this.assertReadOnlyChatAdmin(sourceChatId, user.userId, entityType);
    await this.ensureEntityType(sourceChatId, user.userId, entityType);

    const row = await this.prisma.managedBroadcast.findFirst({
      where: {
        id: broadcastId,
        sourceChatId,
        entityType: mapManagedEntityTypeToChatEntityType(entityType),
      },
    });
    if (!row) {
      throw new BadRequestException('Автопостинг не найден.');
    }

    const targetChatIds = this.parseManagedBroadcastTargetChatIds(
      row.targetChatIds,
      row.sourceChatId,
    );
    const [snapshot, upcomingSlots, targetPreviewBundle] = await Promise.all([
      this.getManagedBroadcastDeliverySnapshot(row),
      this.getManagedBroadcastUpcomingSlots(row),
      this.getManagedBroadcastTargetPreviewBundle(targetChatIds, entityType),
    ]);
    return managedBroadcastDetailsSchema.parse(
      this.mapManagedBroadcastDetails(row, snapshot, upcomingSlots, targetPreviewBundle),
    );
  }

  private async updateManagedBroadcastForEntity(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<ManagedBroadcastDetails> {
    await this.assertChatAdmin(sourceChatId, user.userId, entityType);
    await this.ensureEntityType(sourceChatId, user.userId, entityType);

    const existing = await this.prisma.managedBroadcast.findFirst({
      where: {
        id: broadcastId,
        sourceChatId,
        entityType: mapManagedEntityTypeToChatEntityType(entityType),
        status: {
          in: [
            PrismaManagedBroadcastStatus.ACTIVE,
            PrismaManagedBroadcastStatus.PARTIAL,
            PrismaManagedBroadcastStatus.FAILED,
          ],
        },
      },
    });
    if (!existing) {
      throw new BadRequestException('Автопостинг не найден или уже завершён.');
    }

    const request = await this.prepareManagedBroadcastRequest(sourceChatId, user, body, {
      entityType,
      resolveTargets:
        entityType === 'chat'
          ? (actor) => this.listChatsForMassBroadcast(actor, { discoveryMode: 'cached-first' })
          : undefined,
    });

    const currentOccurrence = this.getCurrentManagedBroadcastOccurrence(existing);
    await this.reconcileInterruptedManagedBroadcastDeliveries(existing.id, currentOccurrence);
    const currentOccurrenceDelivered = await this.prisma.managedBroadcastDelivery.count({
      where: {
        broadcastId: existing.id,
        occurrenceIndex: currentOccurrence,
        status: PrismaManagedBroadcastDeliveryStatus.SENT,
      },
    });
    if (currentOccurrenceDelivered > 0) {
      throw new BadRequestException(
        'Текущая отправка уже частично доставлена. Сначала повторите ошибки или остановите автопостинг.',
      );
    }

    const schedulePlan = await this.planManagedBroadcastSchedule(
      sourceChatId,
      mapManagedEntityTypeToChatEntityType(entityType),
      request.payload,
      existing.sentCount,
      existing.id,
    );
    const buttonState = this.buildManagedBroadcastButtonState(request.payload.buttons);
    const nextOccurrenceIndex = schedulePlan.sentCount + 1;
    const isCalendarPlanComplete =
      schedulePlan.scheduleMode === 'calendar' && schedulePlan.upcomingSlots.length === 0;

    await this.prisma.$transaction(async (tx: any) => {
      await tx.managedBroadcast.update({
        where: { id: existing.id },
        data: {
          actorUserId: user.userId,
          text: request.payload.text,
          textFormat: request.payload.textFormat,
          applyToAllChats: request.payload.applyToAllChats,
          targetChatIds: request.targetChatIds as Prisma.InputJsonValue,
          buttons: buttonState.buttons as Prisma.InputJsonValue,
          buttonEnabled: buttonState.buttonEnabled,
          buttonUrl: buttonState.buttonUrl,
          buttonText: buttonState.buttonText,
          imageEnabled: request.payload.imageEnabled,
          imageBase64: request.payload.imageEnabled ? request.payload.imageBase64 : '',
          imageMimeType: request.payload.imageEnabled ? request.payload.imageMimeType : '',
          imageFileName: request.payload.imageEnabled ? request.payload.imageFileName : '',
          mediaType: request.payload.mediaType,
          mediaPayload: request.payload.mediaPayload
            ? (request.payload.mediaPayload as Prisma.InputJsonValue)
            : Prisma.DbNull,
          mediaMimeType: request.payload.mediaMimeType,
          mediaFileName: request.payload.mediaFileName,
          scheduleMode: schedulePlan.scheduleMode,
          scheduleTimezone: schedulePlan.scheduleTimezone,
          nextSendAt: schedulePlan.nextSendAt,
          cycleEnabled: schedulePlan.cycleEnabled,
          cycleEveryHours: schedulePlan.cycleEveryHours,
          cycleCount: schedulePlan.cycleCount,
          sentCount: schedulePlan.sentCount,
          status: isCalendarPlanComplete
            ? PrismaManagedBroadcastStatus.COMPLETED
            : PrismaManagedBroadcastStatus.ACTIVE,
          lastError: null,
          lockedAt: null,
        },
      });
      await tx.managedBroadcastDelivery.deleteMany({
        where: {
          broadcastId: existing.id,
          occurrenceIndex: { gte: currentOccurrence },
          status: { not: PrismaManagedBroadcastDeliveryStatus.SENT },
        },
      });
      await tx.managedBroadcastOccurrence.deleteMany({
        where: {
          broadcastId: existing.id,
          occurrenceIndex: { gte: currentOccurrence },
        },
      });

      if (schedulePlan.sentCount < schedulePlan.cycleCount) {
        await tx.managedBroadcastDelivery.createMany({
          data: this.buildManagedBroadcastDeliveryRows(
            existing.id,
            request.targetChatIds,
            nextOccurrenceIndex,
            schedulePlan.cycleCount,
          ),
        });
      }

      if (schedulePlan.scheduleMode === 'calendar' && schedulePlan.upcomingSlots.length > 0) {
        await this.createManagedBroadcastOccurrencesWithOverwrite(tx, {
          broadcastId: existing.id,
          sourceChatId,
          entityType: mapManagedEntityTypeToChatEntityType(entityType),
          fromOccurrenceIndex: nextOccurrenceIndex,
          slots: schedulePlan.upcomingSlots,
          targetChatIds: request.targetChatIds,
          excludeBroadcastId: existing.id,
          allowOverwrite: request.payload.replaceConflictingSlots,
        });
      }
    });

    const updated = await this.prisma.managedBroadcast.findUnique({
      where: { id: existing.id },
    });
    if (!updated) {
      throw new BadRequestException('Автопостинг не найден.');
    }

    await this.prisma.auditLog.create({
      data: {
        chatId: sourceChatId,
        actorUserId: user.userId,
        action: 'UPDATE_BROADCAST_SCHEDULE',
        payload: {
          broadcastId: existing.id,
          entityType,
          targetMode: request.payload.targetMode,
          targetChats: request.targetChatIds.length,
          nextSendAt: schedulePlan.nextSendAt?.toISOString() ?? null,
          scheduleMode: schedulePlan.scheduleMode,
          scheduleTimezone: schedulePlan.scheduleTimezone,
          scheduledSlots: schedulePlan.upcomingSlots.map((slot) => slot.toISOString()),
          cycleEnabled: schedulePlan.cycleEnabled,
          cycleEveryHours: schedulePlan.cycleEveryHours,
          cycleCount: schedulePlan.cycleCount,
        },
      },
    });

    const updatedTargetChatIds = this.parseManagedBroadcastTargetChatIds(
      updated.targetChatIds,
      updated.sourceChatId,
    );
    const [snapshot, upcomingSlots, targetPreviewBundle] = await Promise.all([
      this.getManagedBroadcastDeliverySnapshot(updated),
      this.getManagedBroadcastUpcomingSlots(updated),
      this.getManagedBroadcastTargetPreviewBundle(updatedTargetChatIds, entityType),
    ]);
    return managedBroadcastDetailsSchema.parse(
      this.mapManagedBroadcastDetails(updated, snapshot, upcomingSlots, targetPreviewBundle),
    );
  }

  private async cancelManagedBroadcastForEntity(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedBroadcastDetails> {
    await this.assertChatAdmin(sourceChatId, user.userId, entityType);
    await this.ensureEntityType(sourceChatId, user.userId, entityType);

    const existing = await this.prisma.managedBroadcast.findFirst({
      where: {
        id: broadcastId,
        sourceChatId,
        entityType: mapManagedEntityTypeToChatEntityType(entityType),
        status: {
          in: [
            PrismaManagedBroadcastStatus.ACTIVE,
            PrismaManagedBroadcastStatus.PARTIAL,
            PrismaManagedBroadcastStatus.FAILED,
          ],
        },
      },
    });
    if (!existing) {
      throw new BadRequestException('Автопостинг не найден или уже завершён.');
    }

    const currentOccurrence = this.getCurrentManagedBroadcastOccurrence(existing);
    await this.reconcileInterruptedManagedBroadcastDeliveries(existing.id, currentOccurrence);
    const [canceled] = await this.prisma.$transaction([
      this.prisma.managedBroadcast.update({
        where: { id: existing.id },
        data: {
          status: PrismaManagedBroadcastStatus.CANCELED,
          nextSendAt: null,
          lockedAt: null,
        },
      }),
      this.prisma.managedBroadcastDelivery.updateMany({
        where: {
          broadcastId: existing.id,
          status: {
            in: [
              PrismaManagedBroadcastDeliveryStatus.PENDING,
              PrismaManagedBroadcastDeliveryStatus.SENDING,
              PrismaManagedBroadcastDeliveryStatus.FAILED,
            ],
          },
        },
        data: {
          status: PrismaManagedBroadcastDeliveryStatus.CANCELED,
          lockedAt: null,
        },
      }),
      this.prisma.managedBroadcastOccurrence.deleteMany({
        where: {
          broadcastId: existing.id,
          occurrenceIndex: { gte: currentOccurrence },
        },
      }),
    ]);

    await this.prisma.auditLog.create({
      data: {
        chatId: sourceChatId,
        actorUserId: user.userId,
        action: 'CANCEL_BROADCAST_SCHEDULE',
        payload: {
          broadcastId: existing.id,
          entityType,
        },
      },
    });

    const canceledTargetChatIds = this.parseManagedBroadcastTargetChatIds(
      canceled.targetChatIds,
      canceled.sourceChatId,
    );
    const [snapshot, upcomingSlots, targetPreviewBundle] = await Promise.all([
      this.getManagedBroadcastDeliverySnapshot(canceled),
      this.getManagedBroadcastUpcomingSlots(canceled),
      this.getManagedBroadcastTargetPreviewBundle(canceledTargetChatIds, entityType),
    ]);
    return managedBroadcastDetailsSchema.parse(
      this.mapManagedBroadcastDetails(canceled, snapshot, upcomingSlots, targetPreviewBundle),
    );
  }

  private async retryManagedBroadcastForEntity(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedBroadcastDetails> {
    await this.assertChatAdmin(sourceChatId, user.userId, entityType);
    await this.ensureEntityType(sourceChatId, user.userId, entityType);

    const existing = await this.prisma.managedBroadcast.findFirst({
      where: {
        id: broadcastId,
        sourceChatId,
        entityType: mapManagedEntityTypeToChatEntityType(entityType),
        status: {
          in: [PrismaManagedBroadcastStatus.PARTIAL, PrismaManagedBroadcastStatus.FAILED],
        },
      },
    });
    if (!existing) {
      throw new BadRequestException('Для повтора нет неуспешного автопостинга.');
    }

    const currentOccurrence = this.getCurrentManagedBroadcastOccurrence(existing);
    await this.reconcileInterruptedManagedBroadcastDeliveries(existing.id, currentOccurrence);
    const currentOccurrenceSlot = await this.getManagedBroadcastOccurrenceAtIndex(
      existing.id,
      currentOccurrence,
    );
    const deliveriesAfterReconcile = await this.prisma.managedBroadcastDelivery.findMany({
      where: {
        broadcastId: existing.id,
        occurrenceIndex: currentOccurrence,
      },
    });
    const hasFailedDeliveries = deliveriesAfterReconcile.some(
      (delivery: any) => delivery.status === PrismaManagedBroadcastDeliveryStatus.FAILED,
    );
    const hasPendingDeliveries = deliveriesAfterReconcile.some(
      (delivery: any) =>
        delivery.status === PrismaManagedBroadcastDeliveryStatus.PENDING ||
        delivery.status === PrismaManagedBroadcastDeliveryStatus.SENDING,
    );

    if (!hasFailedDeliveries && !hasPendingDeliveries) {
      await this.finalizeManagedBroadcastOccurrence(existing, currentOccurrence, [], [], null);

      const finalized = await this.prisma.managedBroadcast.findUnique({
        where: { id: existing.id },
      });
      if (!finalized) {
        throw new BadRequestException('Автопостинг не найден.');
      }

      await this.prisma.auditLog.create({
        data: {
          chatId: sourceChatId,
          actorUserId: user.userId,
          action: 'RETRY_BROADCAST_SCHEDULE',
          payload: {
            broadcastId: existing.id,
            entityType,
            occurrenceIndex: currentOccurrence,
            reconciledWithoutResend: true,
          },
        },
      });

      const finalizedTargetChatIds = this.parseManagedBroadcastTargetChatIds(
        finalized.targetChatIds,
        finalized.sourceChatId,
      );
      const [snapshot, upcomingSlots, targetPreviewBundle] = await Promise.all([
        this.getManagedBroadcastDeliverySnapshot(finalized),
        this.getManagedBroadcastUpcomingSlots(finalized),
        this.getManagedBroadcastTargetPreviewBundle(finalizedTargetChatIds, entityType),
      ]);
      return managedBroadcastDetailsSchema.parse(
        this.mapManagedBroadcastDetails(finalized, snapshot, upcomingSlots, targetPreviewBundle),
      );
    }

    await this.prisma.$transaction([
      this.prisma.managedBroadcast.update({
        where: { id: existing.id },
        data: {
          status: PrismaManagedBroadcastStatus.ACTIVE,
          lastError: null,
          lockedAt: null,
          nextSendAt: existing.nextSendAt ?? currentOccurrenceSlot?.scheduledAt ?? new Date(),
        },
      }),
      this.prisma.managedBroadcastDelivery.updateMany({
        where: {
          broadcastId: existing.id,
          occurrenceIndex: currentOccurrence,
          status: {
            in: [PrismaManagedBroadcastDeliveryStatus.FAILED],
          },
        },
        data: {
          status: PrismaManagedBroadcastDeliveryStatus.PENDING,
          lockedAt: null,
          lastError: null,
        },
      }),
      this.prisma.managedBroadcastOccurrence.updateMany({
        where: {
          broadcastId: existing.id,
          occurrenceIndex: currentOccurrence,
        },
        data: {
          status: PrismaManagedBroadcastStatus.ACTIVE,
        },
      }),
    ]);

    await this.processManagedBroadcastOccurrence(
      existing.id,
      'manual_retry',
      new Date(Date.now() - MANAGED_BROADCAST_LOCK_STALE_MS),
      [
        PrismaManagedBroadcastStatus.ACTIVE,
        PrismaManagedBroadcastStatus.PARTIAL,
        PrismaManagedBroadcastStatus.FAILED,
      ],
    );

    const updated = await this.prisma.managedBroadcast.findUnique({
      where: { id: existing.id },
    });
    if (!updated) {
      throw new BadRequestException('Автопостинг не найден.');
    }

    await this.prisma.auditLog.create({
      data: {
        chatId: sourceChatId,
        actorUserId: user.userId,
        action: 'RETRY_BROADCAST_SCHEDULE',
        payload: {
          broadcastId: existing.id,
          entityType,
          occurrenceIndex: currentOccurrence,
        },
      },
    });

    const updatedTargetChatIds = this.parseManagedBroadcastTargetChatIds(
      updated.targetChatIds,
      updated.sourceChatId,
    );
    const [snapshot, upcomingSlots, targetPreviewBundle] = await Promise.all([
      this.getManagedBroadcastDeliverySnapshot(updated),
      this.getManagedBroadcastUpcomingSlots(updated),
      this.getManagedBroadcastTargetPreviewBundle(updatedTargetChatIds, entityType),
    ]);
    return managedBroadcastDetailsSchema.parse(
      this.mapManagedBroadcastDetails(updated, snapshot, upcomingSlots, targetPreviewBundle),
    );
  }

  private async sendManagedBroadcast(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    options: {
      entityType: ManagedEntityType;
      source: AdminActionSource;
      resolveTargets?: (user: AuthUser) => Promise<ChatSummary[]>;
    },
  ): Promise<SendBroadcastResult> {
    const request = await this.prepareManagedBroadcastRequest(sourceChatId, user, body, {
      entityType: options.entityType,
      resolveTargets: options.resolveTargets,
    });

    const shouldSchedule =
      options.entityType === 'chat' ||
      request.payload.scheduleMode === 'calendar' ||
      request.payload.sendAt !== null ||
      request.payload.cycleEnabled;

    if (shouldSchedule) {
      return this.scheduleManagedBroadcast(
        sourceChatId,
        user,
        request,
        options.entityType,
        options.source,
      );
    }

    return this.sendManagedBroadcastViaQueue(
      sourceChatId,
      user,
      request,
      options.entityType,
      options.source,
    );
  }

  private async sendManagedBroadcastTest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<SendBroadcastTestResult> {
    const request = await this.prepareManagedBroadcastRequest(sourceChatId, user, body, {
      entityType,
    });
    const deliveryBotId =
      (await this.resolveDeliveryBotAssignment(sourceChatId)) ?? this.resolvePrivateDeliveryBotId();
    const privateChatId = await this.resolvePrivateDialogChatId(user, deliveryBotId);
    const maxApiOptions = this.buildManagedBroadcastMaxApiOptions('interactive');
    const media = await this.resolveManagedBroadcastMedia(
      request.payload,
      entityType,
      sourceChatId,
      user.userId,
      deliveryBotId,
      maxApiOptions,
    );
    const message = await this.buildManagedBroadcastMessage(
      sourceChatId,
      entityType,
      request.payload,
      request.normalizedSourceText,
      media,
      deliveryBotId,
    );

    try {
      const published = await this.sendManagedBroadcastTestPrivateMessage({
        adminUserId: user.userId,
        privateChatId,
        message: message.messageText,
        options: message.messageOptions,
        botId: deliveryBotId,
      });

      await this.prisma.auditLog.create({
        data: {
          chatId: sourceChatId,
          actorUserId: user.userId,
          action: 'SEND_BROADCAST_TEST',
          payload: {
            entityType,
            botId: deliveryBotId ?? null,
            privateChatId: privateChatId ?? null,
            messageId: published.messageId,
          },
        },
      });

      return sendBroadcastTestResultSchema.parse({
        delivered: true,
        messageId: published.messageId,
        chatId: published.chatId ?? privateChatId ?? null,
        url: published.url ?? null,
      });
    } catch (error: unknown) {
      const maxApiMessage = this.extractMaxApiErrorMessage(error);
      throw new BadRequestException(
        maxApiMessage ||
          'Не удалось отправить тест. Откройте личный диалог с ботом и попробуйте ещё раз.',
      );
    }
  }

  private async sendManagedBroadcastTestPrivateMessage(params: {
    adminUserId: string;
    privateChatId: string | null;
    message: string;
    options?:
      | Pick<MaxSendMessageOptions, 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'>
      | undefined;
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
        BROADCAST_TIMEOUT_RETRY_DELAYS_MS.length,
      ) + 1;

    for (let attempt = 1; attempt <= attempts; ) {
      try {
        return privateChatId
          ? await this.maxClient.sendMessageImmediateWithId(
              privateChatId,
              params.message,
              params.options,
              {
                trafficClass: 'interactive',
                sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
                ...(params.botId ? { botId: params.botId } : {}),
              },
            )
          : await this.maxClient.sendMessageImmediateToUser(
              params.adminUserId,
              params.message,
              params.options,
              {
                trafficClass: 'interactive',
                sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
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

    throw new Error('Broadcast test delivery failed without error details.');
  }

  private async prepareManagedBroadcastRequest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    options: {
      entityType: ManagedEntityType;
      resolveTargets?: (user: AuthUser) => Promise<ChatSummary[]>;
    },
  ): Promise<PreparedManagedBroadcastRequest> {
    await this.assertChatAdmin(sourceChatId, user.userId, options.entityType);
    await this.ensureEntityType(sourceChatId, user.userId, options.entityType);

    const parsed = sendBroadcastRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    this.validateManagedBroadcastMediaPayload(parsed.data);

    let targetChatIds = [sourceChatId];
    const needsAvailableTargets =
      parsed.data.targetMode === 'all' || parsed.data.targetMode === 'selected';
    const availableTargets =
      needsAvailableTargets && options.resolveTargets ? await options.resolveTargets(user) : [];
    const allowedTargetIds = new Set([
      sourceChatId,
      ...availableTargets
        .filter((chat) => chat.entityType === options.entityType)
        .map((chat) => chat.id),
    ]);
    if (parsed.data.targetMode === 'all') {
      if (!options.resolveTargets) {
        throw new BadRequestException('Массовый автопостинг по каналам пока недоступен.');
      }

      targetChatIds = [...allowedTargetIds];
    } else if (parsed.data.targetMode === 'selected') {
      if (!options.resolveTargets) {
        throw new BadRequestException('Выбор нескольких чатов для этого автопостинга недоступен.');
      }

      const invalidTargetChatIds = parsed.data.targetChatIds.filter(
        (chatId) => !allowedTargetIds.has(chatId),
      );
      if (invalidTargetChatIds.length > 0) {
        throw new BadRequestException(
          'Некоторые выбранные чаты больше недоступны. Откройте список заново.',
        );
      }

      targetChatIds = parsed.data.targetChatIds;
    }

    return {
      payload: parsed.data,
      targetChatIds,
      normalizedSourceText: parsed.data.text,
    };
  }

  private async sendManagedBroadcastViaQueue(
    sourceChatId: string,
    user: AuthUser,
    request: PreparedManagedBroadcastRequest,
    entityType: ManagedEntityType,
    source: AdminActionSource,
  ): Promise<SendBroadcastResult> {
    const scheduledAt = this.parseManagedBroadcastSendAt(request.payload.sendAt, {
      required: false,
      sourceChatId,
      sentCount: 0,
    });
    const delayMs = scheduledAt ? scheduledAt.getTime() - Date.now() : 0;
    const cycleEnabled = request.payload.cycleEnabled;
    const cycleEveryHours = cycleEnabled ? request.payload.cycleEveryHours : 1;
    const cycleCount = cycleEnabled ? request.payload.cycleCount : 1;
    const cycleEveryMs = cycleEveryHours * ONE_HOUR_MS;
    const maxDelayWithCycles = delayMs + (cycleCount - 1) * cycleEveryMs;
    if (maxDelayWithCycles > BROADCAST_MAX_DELAY_MS) {
      throw new BadRequestException('Все циклы должны укладываться в 31 день от текущего момента.');
    }

    const maxApiOptions = this.resolveManagedBroadcastSourceMaxApiOptions(source);
    const resolvedBotIdsByChatId = new Map<string, string | undefined>();
    const mediaByBotId = new Map<string, ManagedBroadcastResolvedMedia>();
    const resolveTargetBotId = async (chatId: string): Promise<string | undefined> => {
      if (!resolvedBotIdsByChatId.has(chatId)) {
        resolvedBotIdsByChatId.set(chatId, await this.resolveDeliveryBotAssignment(chatId));
      }
      return resolvedBotIdsByChatId.get(chatId);
    };
    const resolveMedia = async (
      botId: string | undefined,
    ): Promise<ManagedBroadcastResolvedMedia> => {
      const cacheKey = botId ?? '__default__';
      if (!mediaByBotId.has(cacheKey)) {
        mediaByBotId.set(
          cacheKey,
          await this.resolveManagedBroadcastMedia(
            request.payload,
            entityType,
            sourceChatId,
            user.userId,
            botId,
            maxApiOptions,
          ),
        );
      }

      return mediaByBotId.get(cacheKey) ?? {};
    };
    const sentChatIds: string[] = [];
    const failedChatIds: string[] = [];
    let firstSendError: unknown = null;

    for (const chatId of request.targetChatIds) {
      const resolvedBotId = await resolveTargetBotId(chatId);
      const media = await resolveMedia(resolvedBotId);
      let chatFailed = false;
      for (let cycleIndex = 0; cycleIndex < cycleCount; cycleIndex += 1) {
        const occurrenceDelayMs = delayMs + cycleIndex * cycleEveryMs;
        try {
          const message = await this.buildManagedBroadcastMessage(
            chatId,
            entityType,
            request.payload,
            request.normalizedSourceText,
            media,
            resolvedBotId,
          );
          let sentMessage: MaxPublishedMessage | null = null;
          if (occurrenceDelayMs === 0 && message.commentDialogReference) {
            sentMessage = await this.sendManagedBroadcastMessageImmediateWithId(
              chatId,
              message.messageText,
              message.messageOptions,
              resolvedBotId,
              maxApiOptions,
            );
          } else if (
            occurrenceDelayMs === 0 &&
            this.hasRetriableMaxAttachment(message.messageOptions)
          ) {
            await this.sendBroadcastImageMessageWithRetry(
              chatId,
              message.messageText,
              message.messageOptions,
              resolvedBotId,
              maxApiOptions,
            );
          } else {
            await this.maxClient.sendMessage(
              chatId,
              message.messageText,
              message.messageOptions,
              occurrenceDelayMs > 0
                ? {
                    delayMs: occurrenceDelayMs,
                    ...maxApiOptions,
                    ...(resolvedBotId ? { botId: resolvedBotId } : {}),
                  }
                : {
                    immediate: true,
                    ...maxApiOptions,
                    ...(resolvedBotId ? { botId: resolvedBotId } : {}),
                  },
            );
          }
          await this.recordManagedBroadcastCommentDialogReference({
            chatId,
            actorUserId: user.userId,
            messageId: sentMessage?.messageId ?? null,
            publishedUrl: sentMessage?.url ?? null,
            text: request.normalizedSourceText,
            reference: message.commentDialogReference,
            source,
          });
        } catch (error: unknown) {
          if (!firstSendError) {
            firstSendError = error;
          }
          chatFailed = true;
          this.logger.warn(
            {
              entityType,
              sourceChatId,
              targetChatId: chatId,
              actorUserId: user.userId,
              sendAt: scheduledAt?.toISOString() ?? null,
              cycleEnabled,
              cycleEveryHours,
              cycleCount,
              cycleIndex: cycleIndex + 1,
              err: error instanceof Error ? error.message : String(error),
            },
            'Broadcast message failed for target chat',
          );
          break;
        }
      }

      if (chatFailed) {
        failedChatIds.push(chatId);
      } else {
        sentChatIds.push(chatId);
      }
    }

    if (sentChatIds.length === 0 && failedChatIds.length > 0) {
      const fallbackMessage = 'Не удалось отправить автопостинг.';
      const maxApiMessage = this.extractMaxApiErrorMessage(firstSendError);
      throw new BadRequestException(maxApiMessage || fallbackMessage);
    }

    const legacyCycleEveryDays = this.toLegacyCycleEveryDays(cycleEveryHours);
    await this.prisma.auditLog.create({
      data: {
        chatId: sourceChatId,
        actorUserId: user.userId,
        action: 'SEND_BROADCAST',
        payload: {
          entityType,
          targetMode: request.payload.targetMode,
          applyToAllChats: request.payload.applyToAllChats,
          targetChats: request.targetChatIds.length,
          sentChats: sentChatIds.length,
          failedChats: failedChatIds.length,
          scheduleMode: 'legacy',
          scheduleTimezone: request.payload.scheduleTimezone,
          scheduledSlots: [],
          sendAt: scheduledAt?.toISOString() ?? null,
          nextSendAt: scheduledAt?.toISOString() ?? null,
          cycleEnabled,
          cycleEveryHours,
          ...(legacyCycleEveryDays ? { cycleEveryDays: legacyCycleEveryDays } : {}),
          cycleCount,
          sentChatIds,
          failedChatIds,
          source,
        },
      },
    });

    const targetPreviewMap = await this.loadManagedBroadcastTargetPreviewMap(
      request.targetChatIds,
      entityType,
    );
    const sentChatPreviewBundle = this.buildManagedBroadcastTargetPreviewBundle(
      sentChatIds,
      targetPreviewMap,
      entityType,
    );
    const failedChatPreviewBundle = this.buildManagedBroadcastTargetPreviewBundle(
      failedChatIds,
      targetPreviewMap,
      entityType,
    );

    return {
      sourceChatId,
      targetChats: request.targetChatIds.length,
      sentChats: sentChatIds.length,
      failedChats: failedChatIds.length,
      sentChatIds,
      failedChatIds,
      sentChatPreviews: sentChatPreviewBundle.previews,
      failedChatPreviews: failedChatPreviewBundle.previews,
      sentChatOverflowCount: sentChatPreviewBundle.overflowCount,
      failedChatOverflowCount: failedChatPreviewBundle.overflowCount,
      scheduleMode: 'legacy',
      scheduleTimezone: request.payload.scheduleTimezone,
      scheduledSlots: [],
      sendAt: scheduledAt?.toISOString() ?? null,
      nextSendAt: scheduledAt?.toISOString() ?? null,
      cycleEnabled,
      cycleEveryHours,
      ...(legacyCycleEveryDays ? { cycleEveryDays: legacyCycleEveryDays } : {}),
      cycleCount,
      scheduleId: null,
      scheduledOccurrences: 0,
    };
  }

  private async scheduleManagedBroadcast(
    sourceChatId: string,
    user: AuthUser,
    request: PreparedManagedBroadcastRequest,
    entityType: ManagedEntityType,
    source: AdminActionSource,
  ): Promise<SendBroadcastResult> {
    const schedulePlan = await this.planManagedBroadcastSchedule(
      sourceChatId,
      mapManagedEntityTypeToChatEntityType(entityType),
      request.payload,
      0,
      null,
    );
    const buttonState = this.buildManagedBroadcastButtonState(request.payload.buttons);
    const nextOccurrenceIndex = schedulePlan.sentCount + 1;
    const isCalendarPlanComplete =
      schedulePlan.scheduleMode === 'calendar' && schedulePlan.upcomingSlots.length === 0;

    const created = await this.prisma.$transaction(async (tx: any) => {
      const createdBroadcast = await tx.managedBroadcast.create({
        data: {
          sourceChatId,
          entityType: mapManagedEntityTypeToChatEntityType(entityType),
          actorUserId: user.userId,
          text: request.payload.text,
          textFormat: request.payload.textFormat,
          applyToAllChats: request.payload.applyToAllChats,
          targetChatIds: request.targetChatIds as Prisma.InputJsonValue,
          buttons: buttonState.buttons as Prisma.InputJsonValue,
          buttonEnabled: buttonState.buttonEnabled,
          buttonUrl: buttonState.buttonUrl,
          buttonText: buttonState.buttonText,
          imageEnabled: request.payload.imageEnabled,
          imageBase64: request.payload.imageEnabled ? request.payload.imageBase64 : '',
          imageMimeType: request.payload.imageEnabled ? request.payload.imageMimeType : '',
          imageFileName: request.payload.imageEnabled ? request.payload.imageFileName : '',
          mediaType: request.payload.mediaType,
          mediaPayload: request.payload.mediaPayload
            ? (request.payload.mediaPayload as Prisma.InputJsonValue)
            : Prisma.DbNull,
          mediaMimeType: request.payload.mediaMimeType,
          mediaFileName: request.payload.mediaFileName,
          scheduleMode: schedulePlan.scheduleMode,
          scheduleTimezone: schedulePlan.scheduleTimezone,
          nextSendAt: schedulePlan.nextSendAt,
          cycleEnabled: schedulePlan.cycleEnabled,
          cycleEveryHours: schedulePlan.cycleEveryHours,
          cycleCount: schedulePlan.cycleCount,
          sentCount: schedulePlan.sentCount,
          status: isCalendarPlanComplete
            ? PrismaManagedBroadcastStatus.COMPLETED
            : PrismaManagedBroadcastStatus.ACTIVE,
        },
      });

      if (schedulePlan.sentCount < schedulePlan.cycleCount) {
        await tx.managedBroadcastDelivery.createMany({
          data: this.buildManagedBroadcastDeliveryRows(
            createdBroadcast.id,
            request.targetChatIds,
            nextOccurrenceIndex,
            schedulePlan.cycleCount,
          ),
        });
      }

      if (schedulePlan.scheduleMode === 'calendar' && schedulePlan.upcomingSlots.length > 0) {
        await this.createManagedBroadcastOccurrencesWithOverwrite(tx, {
          broadcastId: createdBroadcast.id,
          sourceChatId,
          entityType: mapManagedEntityTypeToChatEntityType(entityType),
          fromOccurrenceIndex: nextOccurrenceIndex,
          slots: schedulePlan.upcomingSlots,
          targetChatIds: request.targetChatIds,
          excludeBroadcastId: createdBroadcast.id,
          allowOverwrite: request.payload.replaceConflictingSlots,
        });
      }

      return createdBroadcast;
    });

    let occurrence: BroadcastOccurrenceResult = {
      status: isCalendarPlanComplete
        ? PrismaManagedBroadcastStatus.COMPLETED
        : PrismaManagedBroadcastStatus.ACTIVE,
      currentOccurrence: Math.min(
        Math.max(1, schedulePlan.sentCount + 1),
        Math.max(1, schedulePlan.cycleCount),
      ),
      sentChatIds: [],
      failedChatIds: [],
      pendingChatIds: isCalendarPlanComplete ? [] : request.targetChatIds,
      canRetry: false,
      firstSendError: null,
      nextSendAt: schedulePlan.nextSendAt,
    };

    if (schedulePlan.scheduleMode !== 'calendar' && schedulePlan.sendAt === null) {
      occurrence = await this.processManagedBroadcastOccurrence(
        created.id,
        'immediate',
        new Date(Date.now() - MANAGED_BROADCAST_LOCK_STALE_MS),
        [PrismaManagedBroadcastStatus.ACTIVE],
      );
    }

    const updated = await this.prisma.managedBroadcast.findUnique({
      where: { id: created.id },
    });
    if (!updated) {
      throw new BadRequestException('Автопостинг не найден.');
    }

    const legacyCycleEveryDays = this.toLegacyCycleEveryDays(schedulePlan.cycleEveryHours);
    await this.prisma.auditLog.create({
      data: {
        chatId: sourceChatId,
        actorUserId: user.userId,
        action: 'SCHEDULE_BROADCAST',
        payload: {
          broadcastId: created.id,
          entityType,
          targetMode: request.payload.targetMode,
          applyToAllChats: request.payload.applyToAllChats,
          targetChats: request.targetChatIds.length,
          sendAt: schedulePlan.sendAt,
          nextSendAt: updated.nextSendAt?.toISOString() ?? null,
          scheduleMode: schedulePlan.scheduleMode,
          scheduleTimezone: schedulePlan.scheduleTimezone,
          scheduledSlots: schedulePlan.upcomingSlots.map((slot) => slot.toISOString()),
          cycleEnabled: schedulePlan.cycleEnabled,
          cycleEveryHours: schedulePlan.cycleEveryHours,
          ...(legacyCycleEveryDays ? { cycleEveryDays: legacyCycleEveryDays } : {}),
          cycleCount: schedulePlan.cycleCount,
          sentCount: updated.sentCount,
          source,
        },
      },
    });

    const targetPreviewMap = await this.loadManagedBroadcastTargetPreviewMap(
      request.targetChatIds,
      entityType,
    );
    const sentChatPreviewBundle = this.buildManagedBroadcastTargetPreviewBundle(
      occurrence.sentChatIds,
      targetPreviewMap,
      entityType,
    );
    const failedChatPreviewBundle = this.buildManagedBroadcastTargetPreviewBundle(
      occurrence.failedChatIds,
      targetPreviewMap,
      entityType,
    );

    return {
      sourceChatId,
      targetChats: request.targetChatIds.length,
      sentChats: occurrence.sentChatIds.length,
      failedChats: occurrence.failedChatIds.length,
      sentChatIds: occurrence.sentChatIds,
      failedChatIds: occurrence.failedChatIds,
      sentChatPreviews: sentChatPreviewBundle.previews,
      failedChatPreviews: failedChatPreviewBundle.previews,
      sentChatOverflowCount: sentChatPreviewBundle.overflowCount,
      failedChatOverflowCount: failedChatPreviewBundle.overflowCount,
      scheduleMode: schedulePlan.scheduleMode,
      scheduleTimezone: schedulePlan.scheduleTimezone,
      scheduledSlots: schedulePlan.upcomingSlots.map((slot) => slot.toISOString()),
      sendAt: schedulePlan.sendAt,
      nextSendAt: updated.nextSendAt?.toISOString() ?? null,
      cycleEnabled: schedulePlan.cycleEnabled,
      cycleEveryHours: schedulePlan.cycleEveryHours,
      ...(legacyCycleEveryDays ? { cycleEveryDays: legacyCycleEveryDays } : {}),
      cycleCount: schedulePlan.cycleCount,
      scheduleId: created.id,
      scheduledOccurrences: Math.max(0, schedulePlan.cycleCount - updated.sentCount),
    };
  }

  private async processManagedBroadcastOccurrence(
    broadcastId: string,
    reason: 'startup' | 'scheduled' | 'manual_retry' | 'immediate',
    staleLockBefore: Date,
    allowedStatuses: PrismaManagedBroadcastStatus[],
  ): Promise<BroadcastOccurrenceResult> {
    const claimedAt = new Date();
    const claim = await this.prisma.managedBroadcast.updateMany({
      where: {
        id: broadcastId,
        status: { in: allowedStatuses },
        nextSendAt: { lte: claimedAt },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
      },
      data: {
        lockedAt: claimedAt,
      },
    });
    if (claim.count === 0) {
      const row = await this.prisma.managedBroadcast.findUnique({
        where: { id: broadcastId },
      });
      return {
        status: row?.status ?? PrismaManagedBroadcastStatus.FAILED,
        currentOccurrence: row ? this.getCurrentManagedBroadcastOccurrence(row) : 1,
        sentChatIds: [],
        failedChatIds: [],
        pendingChatIds: [],
        canRetry: false,
        firstSendError: null,
        nextSendAt: row?.nextSendAt ?? null,
      };
    }

    const row = await this.prisma.managedBroadcast.findUnique({
      where: { id: broadcastId },
    });
    if (!row || !row.nextSendAt || !allowedStatuses.includes(row.status)) {
      await this.prisma.managedBroadcast.updateMany({
        where: { id: broadcastId },
        data: { lockedAt: null },
      });
      return {
        status: row?.status ?? PrismaManagedBroadcastStatus.FAILED,
        currentOccurrence: row ? this.getCurrentManagedBroadcastOccurrence(row) : 1,
        sentChatIds: [],
        failedChatIds: [],
        pendingChatIds: [],
        canRetry: false,
        firstSendError: null,
        nextSendAt: row?.nextSendAt ?? null,
      };
    }

    const currentOccurrence = this.getCurrentManagedBroadcastOccurrence(row);
    const maxApiOptions = this.resolveManagedBroadcastProcessingMaxApiOptions(reason);

    try {
      await this.reconcileStaleManagedBroadcastDeliveries(
        row.id,
        currentOccurrence,
        staleLockBefore,
      );
      const { targetMode, targetChatIds } = this.resolveManagedBroadcastTargetsFromRow(row);
      let initialDeliveries = await this.prisma.managedBroadcastDelivery.findMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex: currentOccurrence,
        },
        orderBy: [{ targetChatId: 'asc' }],
      });
      initialDeliveries = await this.ensureManagedBroadcastDeliveryRows(
        row,
        currentOccurrence,
        targetChatIds,
        initialDeliveries,
      );

      const request: PreparedManagedBroadcastRequest = {
        payload: {
          text: row.text,
          textFormat: this.normalizeBroadcastTextFormat(row.textFormat),
          targetMode,
          targetChatIds,
          applyToAllChats: row.applyToAllChats,
          ...this.buildManagedBroadcastButtonState(row.buttons, {
            buttonEnabled: row.buttonEnabled,
            buttonUrl: row.buttonUrl,
            buttonText: row.buttonText,
          }),
          imageEnabled: row.imageEnabled,
          imageBase64: row.imageBase64,
          imageMimeType: row.imageMimeType,
          imageFileName: row.imageFileName,
          images: this.readManagedBroadcastImagesFromRow(row),
          mediaType: readManagedBroadcastMediaType(row.mediaType),
          mediaPayload: this.readObjectPayloadOrNull(row.mediaPayload),
          mediaMimeType: row.mediaMimeType,
          mediaFileName: row.mediaFileName,
          scheduleMode: normalizeBroadcastScheduleMode(row.scheduleMode),
          scheduleTimezone: row.scheduleTimezone,
          scheduledSlots: [],
          replaceConflictingSlots: false,
          sendAt: row.nextSendAt.toISOString(),
          cycleEnabled: row.cycleEnabled,
          cycleEveryHours: row.cycleEveryHours,
          cycleCount: row.cycleCount,
        },
        targetChatIds,
        normalizedSourceText: row.text,
      };

      const sentChatIds: string[] = [];
      const failedChatIds: string[] = [];
      let firstSendError: unknown = null;

      if (reason === 'startup' || reason === 'scheduled') {
        initialDeliveries = await this.recoverManagedBroadcastDeliveriesForAutomaticRun(
          row.id,
          currentOccurrence,
          initialDeliveries,
        );
      }

      const fatalRecoveredDelivery = initialDeliveries.find((delivery: any) => {
        if (delivery.status !== PrismaManagedBroadcastDeliveryStatus.FAILED) {
          return false;
        }
        return (
          this.resolveManagedBroadcastFatalProcessingFailureMessage(delivery.lastError) !== null
        );
      });
      if (fatalRecoveredDelivery) {
        const fatalProcessingErrorMessage =
          this.resolveManagedBroadcastFatalProcessingFailureMessage(
            fatalRecoveredDelivery.lastError,
          ) ?? 'Не удалось обработать автопостинг.';
        await this.failManagedBroadcastAfterFatalProcessingError(
          row,
          currentOccurrence,
          fatalProcessingErrorMessage,
        );
        return {
          status: PrismaManagedBroadcastStatus.FAILED,
          currentOccurrence,
          sentChatIds: [],
          failedChatIds: [fatalRecoveredDelivery.targetChatId],
          pendingChatIds: [],
          canRetry: true,
          firstSendError: new BadRequestException(fatalProcessingErrorMessage),
          nextSendAt: null,
        };
      }

      const hasFailedInitialDelivery = initialDeliveries.some(
        (delivery: any) => delivery.status === PrismaManagedBroadcastDeliveryStatus.FAILED,
      );
      const hasUnfinishedInitialDelivery = initialDeliveries.some(
        (delivery: any) =>
          delivery.status === PrismaManagedBroadcastDeliveryStatus.PENDING ||
          delivery.status === PrismaManagedBroadcastDeliveryStatus.SENDING,
      );
      if (hasFailedInitialDelivery && !hasUnfinishedInitialDelivery) {
        return this.finalizeManagedBroadcastOccurrence(row, currentOccurrence, [], [], null);
      }

      const resolvedBotIdsByChatId = new Map<string, string | undefined>();
      const mediaByBotId = new Map<string, ManagedBroadcastResolvedMedia>();
      const resolveTargetBotId = async (chatId: string): Promise<string | undefined> => {
        if (!resolvedBotIdsByChatId.has(chatId)) {
          resolvedBotIdsByChatId.set(chatId, await this.resolveDeliveryBotAssignment(chatId));
        }
        return resolvedBotIdsByChatId.get(chatId);
      };
      const resolveMedia = async (
        botId: string | undefined,
      ): Promise<ManagedBroadcastResolvedMedia> => {
        const cacheKey = botId ?? '__default__';
        if (!mediaByBotId.has(cacheKey)) {
          mediaByBotId.set(
            cacheKey,
            await this.resolveManagedBroadcastMedia(
              request.payload,
              row.entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
              row.sourceChatId,
              row.actorUserId,
              botId,
              maxApiOptions,
            ),
          );
        }

        return mediaByBotId.get(cacheKey) ?? {};
      };

      for (const delivery of initialDeliveries) {
        if (delivery.status !== PrismaManagedBroadcastDeliveryStatus.PENDING) {
          continue;
        }

        const deliveryClaim = await this.prisma.managedBroadcastDelivery.updateMany({
          where: {
            id: delivery.id,
            status: PrismaManagedBroadcastDeliveryStatus.PENDING,
          },
          data: {
            status: PrismaManagedBroadcastDeliveryStatus.SENDING,
            lockedAt: claimedAt,
            attemptCount: { increment: 1 },
          },
        });
        if (deliveryClaim.count === 0) {
          continue;
        }

        let sentMessage: MaxPublishedMessage;
        let resolvedBotId: string | undefined;
        let commentDialogReference: ManagedBroadcastCommentDialogReference | null = null;
        try {
          resolvedBotId = await resolveTargetBotId(delivery.targetChatId);
          const media = await resolveMedia(resolvedBotId);
          const message = await this.buildManagedBroadcastMessage(
            delivery.targetChatId,
            row.entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
            request.payload,
            request.normalizedSourceText,
            media,
            resolvedBotId,
          );
          commentDialogReference = message.commentDialogReference;
          sentMessage = await this.sendManagedBroadcastMessageImmediateWithId(
            delivery.targetChatId,
            message.messageText,
            message.messageOptions,
            resolvedBotId,
            maxApiOptions,
          );
        } catch (error: unknown) {
          const deliveryFailureMessage =
            this.extractMaxApiErrorMessage(error) ||
            (error instanceof Error && error.message.trim()
              ? error.message
              : 'Не удалось отправить сообщение.');
          const fatalProcessingErrorMessage =
            this.resolveManagedBroadcastFatalProcessingErrorMessage(error);
          if (fatalProcessingErrorMessage) {
            await this.failManagedBroadcastAfterFatalProcessingError(
              row,
              currentOccurrence,
              fatalProcessingErrorMessage,
            );
            return {
              status: PrismaManagedBroadcastStatus.FAILED,
              currentOccurrence,
              sentChatIds,
              failedChatIds: [...failedChatIds, delivery.targetChatId],
              pendingChatIds: [],
              canRetry: true,
              firstSendError: error,
              nextSendAt: null,
            };
          }
          const accessLossResult =
            await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost?.({
              chatId: delivery.targetChatId,
              botId: resolvedBotId ?? null,
              entityType: row.entityType,
              source: 'managed_broadcast:delivery',
              operation: 'send',
              error,
            });
          if (accessLossResult?.recorded) {
            await this.cancelManagedBroadcastTargetDeliveries(row.id, currentOccurrence, {
              targetChatId: delivery.targetChatId,
              currentDeliveryId: delivery.id,
              lastError: deliveryFailureMessage,
            });
            this.logger.warn(
              {
                sourceChatId: row.sourceChatId,
                broadcastId: row.id,
                targetChatId: delivery.targetChatId,
                botId: resolvedBotId ?? null,
                actorUserId: row.actorUserId,
                occurrenceIndex: currentOccurrence,
                reason: accessLossResult.reason,
                err: deliveryFailureMessage,
              },
              'Managed broadcast target lost MAX access and runtime work was stopped',
            );
            continue;
          }
          if (
            this.isManagedBroadcastPermanentTargetDeliveryFailure(error, deliveryFailureMessage)
          ) {
            await this.cancelManagedBroadcastTargetDeliveries(row.id, currentOccurrence, {
              targetChatId: delivery.targetChatId,
              currentDeliveryId: delivery.id,
              lastError: deliveryFailureMessage,
            });
            this.logger.warn(
              {
                sourceChatId: row.sourceChatId,
                broadcastId: row.id,
                targetChatId: delivery.targetChatId,
                actorUserId: row.actorUserId,
                occurrenceIndex: currentOccurrence,
                err: deliveryFailureMessage,
              },
              'Managed broadcast target became unavailable and was removed from remaining deliveries',
            );
            continue;
          }
          const currentAttemptCount = delivery.attemptCount + 1;
          const transientQuarantineMessage =
            await this.resolveManagedBroadcastTransientQuarantineMessage(
              row.id,
              currentOccurrence,
              delivery.targetChatId,
              currentAttemptCount,
              deliveryFailureMessage,
            );
          if (transientQuarantineMessage) {
            await this.cancelManagedBroadcastTargetDeliveries(row.id, currentOccurrence, {
              targetChatId: delivery.targetChatId,
              currentDeliveryId: delivery.id,
              lastError: transientQuarantineMessage,
            });
            this.logger.warn(
              {
                sourceChatId: row.sourceChatId,
                broadcastId: row.id,
                targetChatId: delivery.targetChatId,
                actorUserId: row.actorUserId,
                occurrenceIndex: currentOccurrence,
                attempts: currentAttemptCount,
                err: deliveryFailureMessage,
              },
              'Managed broadcast target was quarantined after repeated transient delivery failures',
            );
            continue;
          }
          if (!firstSendError) {
            firstSendError = error;
          }
          failedChatIds.push(delivery.targetChatId);
          this.logger.warn(
            {
              sourceChatId: row.sourceChatId,
              broadcastId: row.id,
              targetChatId: delivery.targetChatId,
              actorUserId: row.actorUserId,
              occurrenceIndex: currentOccurrence,
              err: error instanceof Error ? error.message : String(error),
            },
            'Managed broadcast delivery failed for target chat',
          );
          await this.prisma.managedBroadcastDelivery.updateMany({
            where: {
              id: delivery.id,
              status: PrismaManagedBroadcastDeliveryStatus.SENDING,
            },
            data: {
              status: PrismaManagedBroadcastDeliveryStatus.FAILED,
              lockedAt: null,
              lastError: deliveryFailureMessage,
            },
          });
          continue;
        }

        const sentAt = new Date();
        try {
          const persistedSentMessage = await this.prisma.managedBroadcastDelivery.updateMany({
            where: {
              id: delivery.id,
              status: PrismaManagedBroadcastDeliveryStatus.SENDING,
            },
            data: {
              sentAt,
              remoteMessageId: sentMessage.messageId,
              lastError: null,
            },
          });
          if (persistedSentMessage.count === 0) {
            continue;
          }
          sentChatIds.push(delivery.targetChatId);

          await this.recordManagedBroadcastCommentDialogReference({
            chatId: delivery.targetChatId,
            actorUserId: row.actorUserId,
            messageId: sentMessage.messageId,
            publishedUrl: sentMessage.url ?? null,
            text: request.normalizedSourceText,
            reference: commentDialogReference,
            source: reason,
            broadcastId: row.id,
            occurrenceIndex: currentOccurrence,
          });

          await this.prisma.managedBroadcastDelivery.updateMany({
            where: {
              id: delivery.id,
              status: PrismaManagedBroadcastDeliveryStatus.SENDING,
            },
            data: {
              status: PrismaManagedBroadcastDeliveryStatus.SENT,
              lockedAt: null,
              lastError: null,
            },
          });
        } catch (error: unknown) {
          if (!firstSendError) {
            firstSendError = error;
          }
          this.logger.warn(
            {
              sourceChatId: row.sourceChatId,
              broadcastId: row.id,
              targetChatId: delivery.targetChatId,
              actorUserId: row.actorUserId,
              occurrenceIndex: currentOccurrence,
              messageId: sentMessage.messageId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Managed broadcast delivery state sync failed after successful send',
          );
          await this.prisma.managedBroadcastDelivery.updateMany({
            where: {
              id: delivery.id,
              status: PrismaManagedBroadcastDeliveryStatus.SENDING,
            },
            data: {
              sentAt,
              remoteMessageId: sentMessage.messageId,
              lastError: null,
            },
          });
          throw error;
        }
      }

      return this.finalizeManagedBroadcastOccurrence(
        row,
        currentOccurrence,
        sentChatIds,
        failedChatIds,
        firstSendError,
      );
    } catch (error: unknown) {
      const fatalProcessingErrorMessage =
        this.resolveManagedBroadcastFatalProcessingErrorMessage(error);
      if (fatalProcessingErrorMessage) {
        await this.failManagedBroadcastAfterFatalProcessingError(
          row,
          currentOccurrence,
          fatalProcessingErrorMessage,
        );
        return {
          status: PrismaManagedBroadcastStatus.FAILED,
          currentOccurrence,
          sentChatIds: [],
          failedChatIds: [],
          pendingChatIds: [],
          canRetry: true,
          firstSendError: error,
          nextSendAt: null,
        };
      }
      this.logger.warn(
        {
          broadcastId: row.id,
          sourceChatId: row.sourceChatId,
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Managed broadcast processing failed',
      );
      const updated = await this.updateManagedBroadcastIfNotCanceled(row.id, {
        status: PrismaManagedBroadcastStatus.FAILED,
        lastError:
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : 'Не удалось обработать автопостинг.',
        lockedAt: null,
      });
      if (!updated) {
        return this.readManagedBroadcastOccurrenceResult(row.id, [], [], [], error);
      }
      return {
        status: PrismaManagedBroadcastStatus.FAILED,
        currentOccurrence,
        sentChatIds: [],
        failedChatIds: [],
        pendingChatIds: [],
        canRetry: true,
        firstSendError: error,
        nextSendAt: row.nextSendAt,
      };
    }
  }

  private async buildManagedBroadcastMessage(
    chatId: string,
    entityType: ManagedEntityType,
    payload: SendBroadcastRequest,
    normalizedSourceText: string,
    media: ManagedBroadcastResolvedMedia,
    botId?: string,
  ): Promise<{
    messageText: string;
    messageOptions:
      | Pick<MaxSendMessageOptions, 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'>
      | undefined;
    commentDialogReference: ManagedBroadcastCommentDialogReference | null;
  }> {
    const { buttons: broadcastButtons, commentDialogReference } =
      await this.resolveBroadcastButtonContext(
        chatId,
        entityType,
        {
          customButtons: payload.buttons,
          includeCustomButton: payload.buttonEnabled,
          customButtonText: payload.buttonText.trim(),
          customButtonUrl: payload.buttonUrl.trim(),
        },
        botId,
      );
    const hasMedia = Boolean(media.imagePayload) || Boolean(media.attachments?.length);
    const hasMeaningfulText = normalizedSourceText.trim().length > 0;
    const shouldUseRichText = payload.textFormat === 'markdown' && hasMeaningfulText;
    const messageText = shouldUseRichText
      ? renderSupportedMarkdownAsHtml(normalizedSourceText, { blockMode: 'raw' })
      : hasMeaningfulText
        ? normalizedSourceText
        : hasMedia
          ? ' '
          : '';
    const textFormat: MaxSendMessageOptions['textFormat'] = shouldUseRichText ? 'html' : undefined;
    const messageOptions =
      broadcastButtons.length > 0 || hasMedia || textFormat
        ? {
            ...(textFormat ? { textFormat } : {}),
            ...(broadcastButtons.length > 0 ? { buttons: broadcastButtons } : {}),
            ...(media.imagePayload ? { imagePayload: media.imagePayload } : {}),
            ...(media.attachments?.length ? { attachments: media.attachments } : {}),
          }
        : undefined;

    return {
      messageText,
      messageOptions,
      commentDialogReference,
    };
  }

  private async recordManagedBroadcastCommentDialogReference(params: {
    chatId: string;
    actorUserId: string;
    messageId: string | null;
    publishedUrl?: string | null;
    text?: string | null;
    reference: ManagedBroadcastCommentDialogReference | null;
    source: string;
    broadcastId?: string;
    occurrenceIndex?: number;
  }): Promise<void> {
    const { chatId, actorUserId, messageId, reference } = params;
    if (!messageId || !reference?.includeCommentsButton) {
      return;
    }
    const postPreviewText =
      typeof params.text === 'string' && params.text.trim().length > 0 ? params.text : null;
    const publishedUrl =
      typeof params.publishedUrl === 'string' && params.publishedUrl.trim().length > 0
        ? params.publishedUrl.trim()
        : null;

    const commonPayload = {
      messageId,
      threadId: reference.threadId,
      source: 'managed_broadcast',
      managedBroadcastSource: params.source,
      ...(postPreviewText ? { text: postPreviewText } : {}),
      ...(publishedUrl ? { publishedUrl } : {}),
      ...(params.broadcastId ? { broadcastId: params.broadcastId } : {}),
      ...(params.occurrenceIndex ? { occurrenceIndex: params.occurrenceIndex } : {}),
      ...(reference.botId ? { botId: reference.botId } : {}),
    };
    const payload =
      reference.entityType === 'channel'
        ? {
            ...commonPayload,
            includeCommentsButton: reference.includeCommentsButton,
            includeSuggestButton: reference.includeSuggestButton,
            autoPostButtonsMode: reference.autoPostButtonsMode,
            suggestionEntryMode: reference.suggestionEntryMode,
            ...(reference.suggestButtonText
              ? { suggestButtonText: reference.suggestButtonText }
              : {}),
          }
        : commonPayload;

    try {
      await this.prisma.auditLog.create({
        data: {
          chatId,
          actorUserId,
          action:
            reference.entityType === 'channel'
              ? CHANNEL_DIALOG_ACTION_AUTO_ATTACH
              : CHAT_DIALOG_ACTION_AUTO_ATTACH,
          payload,
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          entityType: reference.entityType,
          messageId,
          threadId: reference.threadId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record managed broadcast comments button reference',
      );
    }
  }

  private async resolveManagedBroadcastMedia(
    payload: SendBroadcastRequest,
    entityType: ManagedEntityType,
    sourceChatId: string,
    actorUserId: string,
    botId?: string,
    maxApiOptions?: ManagedBroadcastMaxApiOptions,
  ): Promise<ManagedBroadcastResolvedMedia> {
    const images = this.resolveManagedBroadcastRequestImages(payload);
    if (images.length === 1) {
      const imagePayload = await this.uploadManagedBroadcastImage(
        images[0],
        entityType,
        sourceChatId,
        actorUserId,
        botId,
        maxApiOptions,
      );
      return imagePayload ? { imagePayload } : {};
    }

    if (images.length > 1) {
      const attachments: MaxAttachmentPayload[] = [];
      for (const image of images) {
        const imagePayload = await this.uploadManagedBroadcastImage(
          image,
          entityType,
          sourceChatId,
          actorUserId,
          botId,
          maxApiOptions,
        );
        if (imagePayload) {
          attachments.push({
            type: 'image',
            payload: imagePayload,
          });
        }
      }

      return attachments.length > 0 ? { attachments } : {};
    }

    if (payload.mediaType === 'video' && payload.mediaPayload) {
      return {
        attachments: [
          {
            type: 'video',
            payload: payload.mediaPayload,
          },
        ],
      };
    }

    return {};
  }

  private resolveManagedBroadcastRequestImages(payload: SendBroadcastRequest): BroadcastImage[] {
    const explicitImages = Array.isArray(payload.images)
      ? payload.images.filter((image) => image.base64.trim().length > 0)
      : [];
    if (explicitImages.length > 0) {
      return explicitImages.slice(0, MAX_BROADCAST_IMAGES);
    }

    const imageBase64 = payload.imageBase64.trim();
    if (!payload.imageEnabled || !imageBase64) {
      return [];
    }

    return [
      {
        base64: imageBase64,
        mimeType: payload.imageMimeType.trim(),
        fileName: payload.imageFileName.trim(),
      },
    ];
  }

  private readManagedBroadcastMediaPayloadImages(value: unknown): BroadcastImage[] {
    const payload = this.readObjectPayloadOrNull(value);
    if (!payload || !Array.isArray(payload.images)) {
      return [];
    }

    return payload.images
      .map((item: any) => this.readManagedBroadcastMediaPayloadImage(item))
      .filter((image: any): image is BroadcastImage => image !== null)
      .slice(0, MAX_BROADCAST_IMAGES);
  }

  private readManagedBroadcastMediaPayloadImage(value: unknown): BroadcastImage | null {
    const payload = this.readObjectPayloadOrNull(value);
    if (!payload) {
      return null;
    }

    const base64 = this.readTrimmedString(payload.base64);
    if (!base64) {
      return null;
    }

    return {
      base64,
      mimeType: this.readTrimmedString(payload.mimeType) ?? '',
      fileName: this.readTrimmedString(payload.fileName) ?? '',
    };
  }

  private readManagedBroadcastImagesFromRow(row: PersistedManagedBroadcast): BroadcastImage[] {
    if (readManagedBroadcastMediaType(row.mediaType) === 'image') {
      const payloadImages = this.readManagedBroadcastMediaPayloadImages(row.mediaPayload);
      if (payloadImages.length > 0) {
        return payloadImages;
      }
    }

    const imageBase64 = row.imageBase64.trim();
    if (!row.imageEnabled || !imageBase64) {
      return [];
    }

    return [
      {
        base64: imageBase64,
        mimeType: row.imageMimeType.trim(),
        fileName: row.imageFileName.trim(),
      },
    ];
  }

  private validateManagedBroadcastMediaPayload(payload: SendBroadcastRequest): void {
    const images = this.resolveManagedBroadcastRequestImages(payload);
    if (images.length === 0) {
      return;
    }

    if (images.length > MAX_BROADCAST_IMAGES) {
      throw new BadRequestException(
        `В одном автопостинге можно добавить до ${MAX_BROADCAST_IMAGES} фото.`,
      );
    }

    let totalBytes = 0;
    for (const image of images) {
      totalBytes += this.validateManagedBroadcastImagePayload(image).length;
    }

    if (totalBytes > BROADCAST_IMAGES_TOTAL_MAX_BYTES) {
      throw new BadRequestException('Суммарный размер фото слишком большой.');
    }
  }

  private validateManagedBroadcastImagePayload(image: BroadcastImage): Buffer {
    const imageMimeType = image.mimeType.trim().toLowerCase();
    if (!imageMimeType.startsWith('image/')) {
      throw new BadRequestException('Поддерживаются только изображения.');
    }

    const imageBuffer = this.decodeBroadcastImageBase64(image.base64);
    if (imageBuffer.length > BROADCAST_IMAGE_MAX_BYTES) {
      throw new BadRequestException('Фото слишком большое. Попробуйте другое изображение.');
    }

    return imageBuffer;
  }

  private async uploadManagedBroadcastImage(
    image: BroadcastImage,
    entityType: ManagedEntityType,
    sourceChatId: string,
    actorUserId: string,
    botId?: string,
    maxApiOptions?: ManagedBroadcastMaxApiOptions,
  ): Promise<Record<string, unknown> | undefined> {
    const imageMimeType = image.mimeType.trim().toLowerCase();
    const imageBuffer = this.validateManagedBroadcastImagePayload(image);

    let lastError: unknown = null;
    const attempts =
      Math.max(
        BROADCAST_THROTTLE_RETRY_DELAYS_MS.length,
        BROADCAST_TIMEOUT_RETRY_DELAYS_MS.length,
      ) + 1;

    try {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return botId
            ? await this.maxClient.uploadImage(
                imageBuffer,
                this.resolveBroadcastImageFileName(image.fileName, imageMimeType),
                imageMimeType,
                {
                  ...this.buildManagedBroadcastMaxApiRequestOptions(maxApiOptions),
                  botId,
                },
              )
            : await this.maxClient.uploadImage(
                imageBuffer,
                this.resolveBroadcastImageFileName(image.fileName, imageMimeType),
                imageMimeType,
                this.buildManagedBroadcastMaxApiRequestOptions(maxApiOptions),
              );
        } catch (error: unknown) {
          lastError = error;
          const retryDelayMs = this.resolveManagedBroadcastSendRetryDelayMs(
            error,
            attempt,
            undefined,
          );
          if (retryDelayMs === null) {
            throw error;
          }
          await this.sleep(retryDelayMs);
        }
      }

      if (lastError) {
        throw lastError;
      }

      throw new Error('Managed broadcast image upload did not return a result.');
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityType,
          sourceChatId,
          actorUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Broadcast image upload failed',
      );
      throw new BadRequestException('Не удалось загрузить фото. Попробуйте другое изображение.');
    }
  }

  private buildManagedBroadcastMaxApiOptions(
    trafficClass: NonNullable<ManagedBroadcastMaxApiOptions['trafficClass']>,
  ): ManagedBroadcastMaxApiOptions {
    return {
      trafficClass,
      actionHealthLane: trafficClass,
      sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
    };
  }

  private buildManagedBroadcastMaxApiRequestOptions(
    options?: ManagedBroadcastMaxApiOptions,
  ): ManagedBroadcastMaxApiOptions {
    return options ?? this.buildManagedBroadcastMaxApiOptions('interactive');
  }

  private resolveManagedBroadcastSourceMaxApiOptions(
    _source: AdminActionSource,
  ): ManagedBroadcastMaxApiOptions {
    return this.buildManagedBroadcastMaxApiOptions('interactive');
  }

  private resolveManagedBroadcastProcessingMaxApiOptions(
    reason: 'startup' | 'scheduled' | 'manual_retry' | 'immediate',
  ): ManagedBroadcastMaxApiOptions {
    return this.buildManagedBroadcastMaxApiOptions(
      reason === 'startup' || reason === 'scheduled' ? 'background' : 'interactive',
    );
  }

  private async planManagedBroadcastSchedule(
    sourceChatId: string,
    entityType: ChatEntityType,
    payload: SendBroadcastRequest,
    sentCount: number,
    excludeBroadcastId: string | null,
  ): Promise<ManagedBroadcastSchedulePlan> {
    const scheduleMode = normalizeBroadcastScheduleMode(payload.scheduleMode);
    const scheduleTimezone = payload.scheduleTimezone.trim() || 'Europe/Moscow';

    if (scheduleMode === 'calendar') {
      const calendarPlan = await this.parseManagedBroadcastCalendarSlots(payload.scheduledSlots, {
        sourceChatId,
        sentCount,
        entityType,
        excludeBroadcastId,
        scheduleTimezone,
      });
      const upcomingSlots = calendarPlan.upcomingSlots;

      return {
        scheduleMode,
        scheduleTimezone,
        upcomingSlots,
        nextSendAt: upcomingSlots[0] ?? null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: calendarPlan.sentCount + upcomingSlots.length,
        sendAt: upcomingSlots[0]?.toISOString() ?? null,
        sentCount: calendarPlan.sentCount,
      };
    }

    const scheduledAt = this.parseManagedBroadcastSendAt(payload.sendAt, {
      required: false,
      sourceChatId,
      sentCount,
    });
    const cycleEveryHours = payload.cycleEnabled ? payload.cycleEveryHours : 1;
    const cycleCount = payload.cycleEnabled ? payload.cycleCount : 1;

    if (sentCount > 0 && !payload.cycleEnabled) {
      throw new BadRequestException(
        'После первого запуска цикла оставьте циклический режим включенным.',
      );
    }
    if (sentCount > 0 && cycleCount <= sentCount) {
      throw new BadRequestException('Количество отправок должно быть больше уже выполненных.');
    }

    const initialDelayMs = scheduledAt ? scheduledAt.getTime() - Date.now() : 0;
    const maxDelayWithCycles = initialDelayMs + (cycleCount - 1) * cycleEveryHours * ONE_HOUR_MS;
    if (maxDelayWithCycles > BROADCAST_MAX_DELAY_MS) {
      throw new BadRequestException('Все оставшиеся отправки должны уместиться в 31 день.');
    }

    const firstOccurrenceAt = scheduledAt ?? new Date();
    const remainingOccurrences = Math.max(1, cycleCount - sentCount);

    return {
      scheduleMode,
      scheduleTimezone,
      upcomingSlots: this.buildLegacyManagedBroadcastUpcomingSlots(
        firstOccurrenceAt,
        remainingOccurrences,
        cycleEveryHours,
      ),
      nextSendAt: firstOccurrenceAt,
      cycleEnabled: payload.cycleEnabled,
      cycleEveryHours,
      cycleCount,
      sendAt: scheduledAt?.toISOString() ?? null,
      sentCount,
    };
  }

  private async parseManagedBroadcastCalendarSlots(
    values: string[],
    options: {
      sourceChatId: string;
      sentCount: number;
      entityType: ChatEntityType;
      excludeBroadcastId: string | null;
      scheduleTimezone: string;
    },
  ): Promise<ParsedManagedBroadcastCalendarSlots> {
    const normalized = Array.from(
      new Set(values.map((value) => value.trim()).filter(Boolean)),
    ).sort((a, b) => a.localeCompare(b));
    if (normalized.length === 0) {
      throw new BadRequestException('Добавьте хотя бы один слот публикации.');
    }

    const now = new Date();
    const todayKey = this.getDateKeyInTimeZone(now, options.scheduleTimezone);
    const upcomingSlots: Date[] = [];
    let pastTodayCount = 0;

    for (const value of normalized) {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('Некорректный слот публикации.');
      }
      if (
        parsed.getUTCMinutes() % BROADCAST_CALENDAR_SLOT_MINUTES !== 0 ||
        parsed.getUTCSeconds() !== 0 ||
        parsed.getUTCMilliseconds() !== 0
      ) {
        throw new BadRequestException('Слоты должны быть кратны 30 минутам.');
      }

      const delayMs = parsed.getTime() - now.getTime();
      if (delayMs < 0) {
        if (this.getDateKeyInTimeZone(parsed, options.scheduleTimezone) !== todayKey) {
          throw new BadRequestException(
            'Прошедшие слоты можно оставлять только в пределах сегодняшнего дня.',
          );
        }
        pastTodayCount += 1;
        continue;
      }
      if (delayMs < BROADCAST_MIN_DELAY_MS) {
        throw new BadRequestException('Ближайший слот должен быть минимум через 30 секунд.');
      }
      if (delayMs > BROADCAST_MAX_DELAY_MS) {
        throw new BadRequestException('Планирование календаря доступно максимум на 31 день.');
      }
      upcomingSlots.push(parsed);
    }

    return {
      upcomingSlots,
      sentCount: Math.max(options.sentCount, pastTodayCount),
    };
  }

  private buildLegacyManagedBroadcastUpcomingSlots(
    nextSendAt: Date | null,
    remainingOccurrences: number,
    cycleEveryHours: number,
  ): Date[] {
    if (!nextSendAt || remainingOccurrences <= 0) {
      return [];
    }

    const slots: Date[] = [];
    for (let index = 0; index < remainingOccurrences; index += 1) {
      slots.push(new Date(nextSendAt.getTime() + index * cycleEveryHours * ONE_HOUR_MS));
    }
    return slots;
  }

  private buildManagedBroadcastOccurrenceRows(
    broadcastId: string,
    sourceChatId: string,
    entityType: ChatEntityType,
    fromOccurrenceIndex: number,
    slots: Date[],
  ): Prisma.ManagedBroadcastOccurrenceCreateManyInput[] {
    return slots.map((scheduledAt, index) => ({
      broadcastId,
      sourceChatId,
      entityType,
      occurrenceIndex: fromOccurrenceIndex + index,
      scheduledAt,
      status: PrismaManagedBroadcastStatus.ACTIVE,
    }));
  }

  private async createManagedBroadcastOccurrencesWithOverwrite(
    tx: Prisma.TransactionClient,
    options: {
      broadcastId: string;
      sourceChatId: string;
      entityType: ChatEntityType;
      fromOccurrenceIndex: number;
      slots: Date[];
      targetChatIds: string[];
      excludeBroadcastId: string | null;
      allowOverwrite: boolean;
    },
  ): Promise<void> {
    if (options.slots.length === 0) {
      return;
    }

    const rows = this.buildManagedBroadcastOccurrenceRows(
      options.broadcastId,
      options.sourceChatId,
      options.entityType,
      options.fromOccurrenceIndex,
      options.slots,
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.overwriteManagedBroadcastCalendarSlots(tx, {
        sourceChatId: options.sourceChatId,
        entityType: options.entityType,
        slots: options.slots,
        excludeBroadcastId: options.excludeBroadcastId,
        allowOverwrite: options.allowOverwrite,
      });
      await this.assertManagedBroadcastTargetCalendarSlotsAvailable(tx, {
        targetChatIds: options.targetChatIds,
        entityType: options.entityType,
        slots: options.slots,
        excludeBroadcastId: options.excludeBroadcastId,
      });

      try {
        await tx.managedBroadcastOccurrence.createMany({
          data: rows,
        });
        return;
      } catch (error: unknown) {
        if (!this.isManagedBroadcastSlotConflictError(error) || attempt > 0) {
          throw error;
        }
      }
    }
  }

  private async assertManagedBroadcastTargetCalendarSlotsAvailable(
    tx: Prisma.TransactionClient,
    options: {
      targetChatIds: readonly string[];
      entityType: ChatEntityType;
      slots: Date[];
      excludeBroadcastId: string | null;
    },
  ): Promise<void> {
    const targetChatIds = this.normalizeManagedBroadcastTargetChatIds(options.targetChatIds);
    if (targetChatIds.length === 0 || options.slots.length === 0) {
      return;
    }

    const targetChatIdSet = new Set(targetChatIds);
    const occurrences = await tx.managedBroadcastOccurrence.findMany({
      where: {
        entityType: options.entityType,
        status: {
          in: [
            PrismaManagedBroadcastStatus.ACTIVE,
            PrismaManagedBroadcastStatus.PARTIAL,
            PrismaManagedBroadcastStatus.FAILED,
          ],
        },
        scheduledAt: {
          in: options.slots,
        },
        ...(options.excludeBroadcastId ? { broadcastId: { not: options.excludeBroadcastId } } : {}),
      },
      select: {
        broadcastId: true,
        scheduledAt: true,
        broadcast: {
          select: {
            sourceChatId: true,
            targetChatIds: true,
            status: true,
          },
        },
      },
      orderBy: [{ scheduledAt: 'asc' }],
    });

    const conflictSlots = new Set<string>();
    const conflictTargetChatIds = new Set<string>();
    for (const occurrence of occurrences) {
      if (
        occurrence.broadcast.status !== PrismaManagedBroadcastStatus.ACTIVE &&
        occurrence.broadcast.status !== PrismaManagedBroadcastStatus.PARTIAL &&
        occurrence.broadcast.status !== PrismaManagedBroadcastStatus.FAILED
      ) {
        continue;
      }

      const existingTargetChatIds = this.parseManagedBroadcastTargetChatIds(
        occurrence.broadcast.targetChatIds,
        occurrence.broadcast.sourceChatId,
      );
      const overlaps = existingTargetChatIds.filter((chatId) => targetChatIdSet.has(chatId));
      if (overlaps.length === 0) {
        continue;
      }

      conflictSlots.add(occurrence.scheduledAt.toISOString());
      for (const chatId of overlaps) {
        conflictTargetChatIds.add(chatId);
      }
    }

    if (conflictSlots.size === 0) {
      return;
    }

    throw new BadRequestException({
      code: 'BROADCAST_TARGET_SLOT_CONFLICT',
      message: 'В выбранной группе на это время уже есть автопостинг.',
      conflicts: [...conflictSlots],
      targetChatIds: [...conflictTargetChatIds],
    });
  }

  private async overwriteManagedBroadcastCalendarSlots(
    tx: Prisma.TransactionClient,
    options: {
      sourceChatId: string;
      entityType: ChatEntityType;
      slots: Date[];
      excludeBroadcastId: string | null;
      allowOverwrite: boolean;
    },
  ): Promise<void> {
    if (options.slots.length === 0) {
      return;
    }

    const conflicts = await tx.managedBroadcastOccurrence.findMany({
      where: {
        sourceChatId: options.sourceChatId,
        entityType: options.entityType,
        scheduledAt: {
          in: options.slots,
        },
        ...(options.excludeBroadcastId ? { broadcastId: { not: options.excludeBroadcastId } } : {}),
      },
      select: {
        broadcastId: true,
        scheduledAt: true,
      },
      orderBy: [{ broadcastId: 'asc' }, { scheduledAt: 'asc' }],
    });
    if (conflicts.length === 0) {
      return;
    }
    if (!options.allowOverwrite) {
      throw new BadRequestException({
        code: 'BROADCAST_SLOT_CONFLICT',
        message: 'На выбранное время уже есть автопостинг. Обновите календарь или замените слот.',
        conflicts: conflicts.map((conflict) => conflict.scheduledAt.toISOString()),
      });
    }

    const overwrittenSlotsByBroadcastId = new Map<string, Set<number>>();
    for (const conflict of conflicts) {
      const current = overwrittenSlotsByBroadcastId.get(conflict.broadcastId) ?? new Set<number>();
      current.add(conflict.scheduledAt.getTime());
      overwrittenSlotsByBroadcastId.set(conflict.broadcastId, current);
    }

    const affectedRows = await tx.managedBroadcast.findMany({
      where: {
        id: {
          in: [...overwrittenSlotsByBroadcastId.keys()],
        },
      },
      orderBy: [{ createdAt: 'asc' }],
    });

    for (const row of affectedRows) {
      await this.rebuildManagedBroadcastCalendarSlotsAfterOverwrite(
        tx,
        row,
        overwrittenSlotsByBroadcastId.get(row.id) ?? new Set<number>(),
      );
    }
  }

  private async rebuildManagedBroadcastCalendarSlotsAfterOverwrite(
    tx: Prisma.TransactionClient,
    row: PersistedManagedBroadcast,
    overwrittenSlotsMs: ReadonlySet<number>,
  ): Promise<void> {
    if (
      overwrittenSlotsMs.size === 0 ||
      normalizeBroadcastScheduleMode(row.scheduleMode) !== 'calendar'
    ) {
      return;
    }

    const currentOccurrence = this.getCurrentManagedBroadcastOccurrence(row);
    const scheduledOccurrences = await tx.managedBroadcastOccurrence.findMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: { gte: currentOccurrence },
      },
      orderBy: [{ occurrenceIndex: 'asc' }],
    });
    if (scheduledOccurrences.length === 0) {
      return;
    }

    const remainingSlots = scheduledOccurrences
      .filter((occurrence) => !overwrittenSlotsMs.has(occurrence.scheduledAt.getTime()))
      .map((occurrence) => occurrence.scheduledAt);
    if (remainingSlots.length === scheduledOccurrences.length) {
      return;
    }

    await tx.managedBroadcastDelivery.deleteMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: { gte: currentOccurrence },
      },
    });
    await tx.managedBroadcastOccurrence.deleteMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: { gte: currentOccurrence },
      },
    });

    const nextSendAt = remainingSlots[0] ?? null;
    const nextCycleCount = row.sentCount + remainingSlots.length;
    await tx.managedBroadcast.update({
      where: { id: row.id },
      data: {
        nextSendAt,
        cycleCount: nextCycleCount,
        status: nextSendAt
          ? PrismaManagedBroadcastStatus.ACTIVE
          : PrismaManagedBroadcastStatus.COMPLETED,
        lastError: null,
        lockedAt: null,
      },
    });

    if (remainingSlots.length === 0) {
      return;
    }

    await tx.managedBroadcastDelivery.createMany({
      data: this.buildManagedBroadcastDeliveryRows(
        row.id,
        this.parseManagedBroadcastTargetChatIds(row.targetChatIds, row.sourceChatId),
        currentOccurrence,
        nextCycleCount,
      ),
    });
    await tx.managedBroadcastOccurrence.createMany({
      data: this.buildManagedBroadcastOccurrenceRows(
        row.id,
        row.sourceChatId,
        row.entityType,
        currentOccurrence,
        remainingSlots,
      ),
    });
  }

  private async getManagedBroadcastOccurrenceAtIndex(
    broadcastId: string,
    occurrenceIndex: number,
  ): Promise<PersistedManagedBroadcastOccurrence | null> {
    return this.prisma.managedBroadcastOccurrence.findUnique({
      where: {
        broadcastId_occurrenceIndex: {
          broadcastId,
          occurrenceIndex,
        },
      },
    });
  }

  private async getManagedBroadcastUpcomingSlotsMap(
    rows: PersistedManagedBroadcast[],
  ): Promise<Map<string, Date[]>> {
    if (rows.length === 0) {
      return new Map();
    }

    const calendarRows = rows.filter(
      (row) => normalizeBroadcastScheduleMode(row.scheduleMode) === 'calendar',
    );
    const occurrences =
      calendarRows.length > 0
        ? await this.prisma.managedBroadcastOccurrence.findMany({
            where: {
              broadcastId: {
                in: calendarRows.map((row) => row.id),
              },
            },
            orderBy: [{ occurrenceIndex: 'asc' }],
          })
        : [];

    const groupedOccurrences = new Map<string, PersistedManagedBroadcastOccurrence[]>();
    for (const occurrence of occurrences) {
      const current = groupedOccurrences.get(occurrence.broadcastId) ?? [];
      current.push(occurrence);
      groupedOccurrences.set(occurrence.broadcastId, current);
    }

    const result = new Map<string, Date[]>();
    for (const row of rows) {
      if (normalizeBroadcastScheduleMode(row.scheduleMode) === 'calendar') {
        const currentOccurrence = this.getCurrentManagedBroadcastOccurrence(row);
        const upcoming = (groupedOccurrences.get(row.id) ?? [])
          .filter((occurrence) => occurrence.occurrenceIndex >= currentOccurrence)
          .map((occurrence) => occurrence.scheduledAt);
        result.set(row.id, upcoming);
        continue;
      }

      result.set(
        row.id,
        this.buildLegacyManagedBroadcastUpcomingSlots(
          row.nextSendAt,
          Math.max(0, row.cycleCount - row.sentCount),
          row.cycleEveryHours,
        ),
      );
    }

    return result;
  }

  private async getManagedBroadcastUpcomingSlots(row: PersistedManagedBroadcast): Promise<Date[]> {
    return (await this.getManagedBroadcastUpcomingSlotsMap([row])).get(row.id) ?? [];
  }

  private parseManagedBroadcastSendAt(
    sendAt: string | null,
    options: {
      required: boolean;
      sourceChatId: string;
      sentCount: number;
    },
  ): Date | null {
    if (!sendAt) {
      if (options.required) {
        throw new BadRequestException('Укажите следующее время отправки.');
      }
      return null;
    }

    const scheduledAt = new Date(sendAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('Некорректное время автопостинга.');
    }
    const calculatedDelayMs = scheduledAt.getTime() - Date.now();
    if (calculatedDelayMs < BROADCAST_MIN_DELAY_MS) {
      const message =
        options.sentCount > 0
          ? 'Следующую отправку можно поставить минимум через 30 секунд.'
          : 'Укажите время автопостинга минимум через 30 секунд.';
      throw new BadRequestException(message);
    }
    if (calculatedDelayMs > BROADCAST_MAX_DELAY_MS) {
      throw new BadRequestException('Максимальный таймер автопостинга: 31 день.');
    }
    return scheduledAt;
  }

  private getDateKeyInTimeZone(value: Date, timeZone: string): string {
    const baseOptions: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    };
    let formatter: Intl.DateTimeFormat;

    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        ...baseOptions,
        timeZone,
      });
    } catch {
      formatter = new Intl.DateTimeFormat('en-CA', baseOptions);
    }

    const parts = formatter.formatToParts(value);
    const year = parts.find((part) => part.type === 'year')?.value ?? '0000';
    const month = parts.find((part) => part.type === 'month')?.value ?? '00';
    const day = parts.find((part) => part.type === 'day')?.value ?? '00';
    return `${year}-${month}-${day}`;
  }

  private toLegacyCycleEveryDays(cycleEveryHours: number): number | undefined {
    return cycleEveryHours % 24 === 0 ? cycleEveryHours / 24 : undefined;
  }

  private normalizeManagedBroadcastTargetChatIds(
    targetChatIds: readonly string[],
    fallbackChatId?: string,
  ): string[] {
    const normalized = Array.from(
      new Set(
        targetChatIds.map((item) => item.trim()).filter((item): item is string => item.length > 0),
      ),
    );
    if (normalized.length > 0) {
      return normalized;
    }

    return fallbackChatId?.trim() ? [fallbackChatId.trim()] : [];
  }

  private parseManagedBroadcastTargetChatIds(
    value: Prisma.JsonValue,
    fallbackChatId?: string,
  ): string[] {
    if (!Array.isArray(value)) {
      return this.normalizeManagedBroadcastTargetChatIds([], fallbackChatId);
    }

    return this.normalizeManagedBroadcastTargetChatIds(
      value.filter((item): item is string => typeof item === 'string'),
      fallbackChatId,
    );
  }

  private resolveManagedBroadcastTargetMode(params: {
    applyToAllChats: boolean;
    sourceChatId: string;
    targetChatIds: readonly string[];
  }): BroadcastTargetMode {
    if (params.applyToAllChats) {
      return 'all';
    }

    if (params.targetChatIds.length === 1 && params.targetChatIds[0] === params.sourceChatId) {
      return 'current';
    }

    return 'selected';
  }

  private resolveManagedBroadcastTargetsFromRow(row: {
    applyToAllChats: boolean;
    sourceChatId: string;
    targetChatIds: Prisma.JsonValue;
  }): { targetMode: BroadcastTargetMode; targetChatIds: string[] } {
    const targetChatIds = this.parseManagedBroadcastTargetChatIds(
      row.targetChatIds,
      row.sourceChatId,
    );
    return {
      targetMode: this.resolveManagedBroadcastTargetMode({
        applyToAllChats: row.applyToAllChats,
        sourceChatId: row.sourceChatId,
        targetChatIds,
      }),
      targetChatIds,
    };
  }

  private fallbackManagedBroadcastTargetPreview(
    chatId: string,
    entityType: ManagedEntityType = 'chat',
  ): ManagedBroadcastTargetPreview {
    const normalizedChatId = chatId.trim();
    return {
      id: normalizedChatId,
      title: `${entityType === 'channel' ? 'Канал' : 'Чат'} ${normalizedChatId}`,
      entityType,
      link: null,
      avatarUrl: null,
    };
  }

  private async loadManagedBroadcastTargetPreviewMap(
    targetChatIds: readonly string[],
    fallbackEntityType: ManagedEntityType = 'chat',
  ): Promise<Map<string, ManagedBroadcastTargetPreview>> {
    const normalizedIds = this.normalizeManagedBroadcastTargetChatIds(targetChatIds);
    if (normalizedIds.length === 0) {
      return new Map();
    }

    const [chatRows, catalogRows] = await Promise.all([
      this.prisma.chat.findMany({
        where: {
          id: { in: normalizedIds },
        },
        select: {
          id: true,
          title: true,
          entityType: true,
        },
      }),
      this.prisma.managedBotChatCatalog.findMany({
        where: {
          chatId: { in: normalizedIds },
          status: 'ACTIVE',
        },
        orderBy: [{ lastSeenAt: 'desc' }],
        select: {
          chatId: true,
          entityType: true,
          title: true,
          link: true,
          avatarUrl: true,
        },
      }),
    ]);

    const previews = new Map<string, ManagedBroadcastTargetPreview>();
    for (const row of chatRows) {
      const entityType = fromPrismaEntityType(row.entityType);
      previews.set(row.id, {
        id: row.id,
        title:
          this.readTrimmedString(row.title) ??
          this.fallbackManagedBroadcastTargetPreview(row.id, entityType).title,
        entityType,
        link: null,
        avatarUrl: null,
      });
    }

    for (const row of catalogRows) {
      if (previews.has(row.chatId)) {
        const current = previews.get(row.chatId);
        if (current) {
          previews.set(row.chatId, {
            ...current,
            title:
              this.readTrimmedString(current.title) ??
              this.readTrimmedString(row.title) ??
              current.title,
            link: this.readTrimmedString(current.link) ?? this.readTrimmedString(row.link) ?? null,
            avatarUrl:
              this.readTrimmedString(current.avatarUrl) ??
              this.readTrimmedString(row.avatarUrl) ??
              null,
          });
        }
        continue;
      }

      const entityType = fromPrismaEntityType(row.entityType);
      previews.set(row.chatId, {
        id: row.chatId,
        title:
          this.readTrimmedString(row.title) ??
          this.fallbackManagedBroadcastTargetPreview(row.chatId, entityType).title,
        entityType,
        link: this.readTrimmedString(row.link) ?? null,
        avatarUrl: this.readTrimmedString(row.avatarUrl) ?? null,
      });
    }

    for (const chatId of normalizedIds) {
      if (!previews.has(chatId)) {
        previews.set(
          chatId,
          this.fallbackManagedBroadcastTargetPreview(chatId, fallbackEntityType),
        );
      }
    }

    return previews;
  }

  private buildManagedBroadcastTargetPreviewBundle(
    targetChatIds: readonly string[],
    previewMap: ReadonlyMap<string, ManagedBroadcastTargetPreview>,
    fallbackEntityType: ManagedEntityType = 'chat',
  ): ManagedBroadcastTargetPreviewBundle {
    const normalizedIds = this.normalizeManagedBroadcastTargetChatIds(targetChatIds);
    const previews = normalizedIds
      .slice(0, MANAGED_BROADCAST_TARGET_PREVIEW_LIMIT)
      .map(
        (chatId) =>
          previewMap.get(chatId) ??
          this.fallbackManagedBroadcastTargetPreview(chatId, fallbackEntityType),
      );

    return {
      previews,
      overflowCount: Math.max(0, normalizedIds.length - previews.length),
    };
  }

  private async getManagedBroadcastTargetPreviewBundle(
    targetChatIds: readonly string[],
    fallbackEntityType: ManagedEntityType = 'chat',
  ): Promise<ManagedBroadcastTargetPreviewBundle> {
    const previewMap = await this.loadManagedBroadcastTargetPreviewMap(
      targetChatIds,
      fallbackEntityType,
    );
    return this.buildManagedBroadcastTargetPreviewBundle(
      targetChatIds,
      previewMap,
      fallbackEntityType,
    );
  }

  private async getManagedBroadcastTargetPreviewBundles(
    rows: readonly PersistedManagedBroadcast[],
  ): Promise<Map<string, ManagedBroadcastTargetPreviewBundle>> {
    const allTargetChatIds = rows.flatMap((row) =>
      this.parseManagedBroadcastTargetChatIds(row.targetChatIds, row.sourceChatId),
    );
    const previewMap = await this.loadManagedBroadcastTargetPreviewMap(allTargetChatIds);
    const result = new Map<string, ManagedBroadcastTargetPreviewBundle>();

    for (const row of rows) {
      const fallbackEntityType = fromPrismaEntityType(row.entityType);
      result.set(
        row.id,
        this.buildManagedBroadcastTargetPreviewBundle(
          this.parseManagedBroadcastTargetChatIds(row.targetChatIds, row.sourceChatId),
          previewMap,
          fallbackEntityType,
        ),
      );
    }

    return result;
  }

  private normalizeBroadcastTextFormat(value: string): BroadcastTextFormat {
    return value === 'markdown' ? 'markdown' : 'plain';
  }

  private getCurrentManagedBroadcastOccurrence(row: PersistedManagedBroadcast): number {
    return Math.min(Math.max(1, row.sentCount + 1), Math.max(1, row.cycleCount));
  }

  private normalizeManagedBroadcastCycleCount(row: Pick<PersistedManagedBroadcast, 'cycleCount'>) {
    return Math.max(1, row.cycleCount);
  }

  private buildManagedBroadcastDeliveryRows(
    broadcastId: string,
    targetChatIds: string[],
    fromOccurrenceIndex: number,
    cycleCount: number,
  ): Prisma.ManagedBroadcastDeliveryCreateManyInput[] {
    const rows: Prisma.ManagedBroadcastDeliveryCreateManyInput[] = [];
    for (
      let occurrenceIndex = fromOccurrenceIndex;
      occurrenceIndex <= cycleCount;
      occurrenceIndex += 1
    ) {
      for (const targetChatId of targetChatIds) {
        rows.push({
          broadcastId,
          occurrenceIndex,
          targetChatId,
          status: PrismaManagedBroadcastDeliveryStatus.PENDING,
        });
      }
    }
    return rows;
  }

  private async ensureManagedBroadcastDeliveryRows(
    row: Pick<PersistedManagedBroadcast, 'id' | 'cycleCount'>,
    fromOccurrenceIndex: number,
    targetChatIds: string[],
    deliveries: PersistedManagedBroadcastDelivery[],
  ): Promise<PersistedManagedBroadcastDelivery[]> {
    const normalizedTargetChatIds = this.normalizeManagedBroadcastTargetChatIds(targetChatIds);
    if (normalizedTargetChatIds.length === 0) {
      return deliveries;
    }

    const cycleCount = Math.max(fromOccurrenceIndex, this.normalizeManagedBroadcastCycleCount(row));
    const existingCurrentTargetChatIds = new Set(
      deliveries.map((delivery) => delivery.targetChatId),
    );
    if (
      cycleCount === fromOccurrenceIndex &&
      normalizedTargetChatIds.every((targetChatId) =>
        existingCurrentTargetChatIds.has(targetChatId),
      )
    ) {
      return deliveries;
    }

    const expectedRemainingDeliveryRows =
      normalizedTargetChatIds.length * (cycleCount - fromOccurrenceIndex + 1);
    const existingRemainingDeliveryRows = await this.prisma.managedBroadcastDelivery.count({
      where: {
        broadcastId: row.id,
        occurrenceIndex: {
          gte: fromOccurrenceIndex,
          lte: cycleCount,
        },
        targetChatId: {
          in: normalizedTargetChatIds,
        },
      },
    });

    if (existingRemainingDeliveryRows >= expectedRemainingDeliveryRows) {
      if (
        normalizedTargetChatIds.some(
          (targetChatId) => !existingCurrentTargetChatIds.has(targetChatId),
        )
      ) {
        return this.prisma.managedBroadcastDelivery.findMany({
          where: {
            broadcastId: row.id,
            occurrenceIndex: fromOccurrenceIndex,
          },
          orderBy: [{ targetChatId: 'asc' }],
        });
      }
      return deliveries;
    }

    const existingDeliveries: Array<{ occurrenceIndex: number; targetChatId: string }> =
      await this.prisma.managedBroadcastDelivery.findMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex: {
            gte: fromOccurrenceIndex,
            lte: cycleCount,
          },
          targetChatId: {
            in: normalizedTargetChatIds,
          },
        },
        select: {
          occurrenceIndex: true,
          targetChatId: true,
        },
      });
    const existingKeys = new Set(
      existingDeliveries.map((delivery) => `${delivery.occurrenceIndex}:${delivery.targetChatId}`),
    );
    const missingRows = this.buildManagedBroadcastDeliveryRows(
      row.id,
      normalizedTargetChatIds,
      fromOccurrenceIndex,
      cycleCount,
    ).filter(
      (delivery) => !existingKeys.has(`${delivery.occurrenceIndex}:${delivery.targetChatId}`),
    );

    if (missingRows.length === 0) {
      return deliveries;
    }

    const currentOccurrenceMissing = missingRows.some(
      (delivery) => delivery.occurrenceIndex === fromOccurrenceIndex,
    );
    await this.prisma.managedBroadcastDelivery.createMany({
      data: missingRows,
      skipDuplicates: true,
    });

    if (!currentOccurrenceMissing) {
      return deliveries;
    }

    return this.prisma.managedBroadcastDelivery.findMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: fromOccurrenceIndex,
      },
      orderBy: [{ targetChatId: 'asc' }],
    });
  }

  private async recoverManagedBroadcastDeliveriesForAutomaticRun(
    broadcastId: string,
    occurrenceIndex: number,
    deliveries: PersistedManagedBroadcastDelivery[],
  ): Promise<PersistedManagedBroadcastDelivery[]> {
    let mutated = false;

    for (const delivery of deliveries) {
      if (delivery.status !== PrismaManagedBroadcastDeliveryStatus.FAILED) {
        continue;
      }

      const failureMessage = delivery.lastError?.trim() ?? '';
      if (this.isManagedBroadcastPermanentTargetDeliveryFailure(null, failureMessage)) {
        await this.cancelManagedBroadcastTargetDeliveries(broadcastId, occurrenceIndex, {
          targetChatId: delivery.targetChatId,
          currentDeliveryId: delivery.id,
          lastError:
            failureMessage || 'Чат больше недоступен для бота, дальнейшие доставки пропущены.',
        });
        mutated = true;
        continue;
      }
      const transientQuarantineMessage =
        await this.resolveManagedBroadcastTransientQuarantineMessage(
          broadcastId,
          occurrenceIndex,
          delivery.targetChatId,
          delivery.attemptCount,
          failureMessage,
        );
      if (transientQuarantineMessage) {
        await this.cancelManagedBroadcastTargetDeliveries(broadcastId, occurrenceIndex, {
          targetChatId: delivery.targetChatId,
          currentDeliveryId: delivery.id,
          lastError: transientQuarantineMessage,
        });
        this.logger.warn(
          {
            broadcastId,
            targetChatId: delivery.targetChatId,
            occurrenceIndex,
            attempts: delivery.attemptCount,
            err: failureMessage,
          },
          'Managed broadcast target was quarantined during automatic recovery after repeated transient failures',
        );
        mutated = true;
        continue;
      }

      if (!this.shouldAutoRetryManagedBroadcastDeliveryFailure(delivery)) {
        continue;
      }

      const resetResult = await this.prisma.managedBroadcastDelivery.updateMany({
        where: {
          id: delivery.id,
          status: PrismaManagedBroadcastDeliveryStatus.FAILED,
        },
        data: {
          status: PrismaManagedBroadcastDeliveryStatus.PENDING,
          lockedAt: null,
          lastError: null,
        },
      });
      mutated ||= resetResult.count > 0;
    }

    if (!mutated) {
      return deliveries;
    }

    return this.prisma.managedBroadcastDelivery.findMany({
      where: {
        broadcastId,
        occurrenceIndex,
      },
      orderBy: [{ targetChatId: 'asc' }],
    });
  }

  private async cancelManagedBroadcastTargetDeliveries(
    broadcastId: string,
    occurrenceIndex: number,
    options: {
      targetChatId: string;
      currentDeliveryId?: string;
      lastError: string;
    },
  ): Promise<void> {
    const normalizedLastError =
      options.lastError.trim() || 'Чат больше недоступен для бота, дальнейшие доставки пропущены.';

    if (options.currentDeliveryId) {
      await this.prisma.managedBroadcastDelivery.updateMany({
        where: {
          id: options.currentDeliveryId,
          status: {
            in: [
              PrismaManagedBroadcastDeliveryStatus.PENDING,
              PrismaManagedBroadcastDeliveryStatus.SENDING,
              PrismaManagedBroadcastDeliveryStatus.FAILED,
            ],
          },
        },
        data: {
          status: PrismaManagedBroadcastDeliveryStatus.CANCELED,
          lockedAt: null,
          lastError: normalizedLastError,
        },
      });
    }

    await this.prisma.managedBroadcastDelivery.updateMany({
      where: {
        broadcastId,
        targetChatId: options.targetChatId,
        occurrenceIndex: { gte: occurrenceIndex + 1 },
        status: {
          in: [
            PrismaManagedBroadcastDeliveryStatus.PENDING,
            PrismaManagedBroadcastDeliveryStatus.FAILED,
          ],
        },
      },
      data: {
        status: PrismaManagedBroadcastDeliveryStatus.CANCELED,
        lockedAt: null,
        lastError: normalizedLastError,
      },
    });
  }

  private async resolveManagedBroadcastTransientQuarantineMessage(
    broadcastId: string,
    occurrenceIndex: number,
    targetChatId: string,
    currentAttemptCount: number,
    failureMessage: string,
  ): Promise<string | null> {
    if (!this.isManagedBroadcastTransientDeliveryFailureMessage(failureMessage)) {
      return null;
    }

    if (
      currentAttemptCount < MANAGED_BROADCAST_TARGET_QUARANTINE_ATTEMPTS &&
      occurrenceIndex < MANAGED_BROADCAST_TARGET_QUARANTINE_FAILURE_OCCURRENCES
    ) {
      return null;
    }

    const history = await this.prisma.managedBroadcastDelivery.findMany({
      where: {
        broadcastId,
        targetChatId,
        occurrenceIndex: { lte: occurrenceIndex },
      },
      orderBy: [{ occurrenceIndex: 'asc' }],
    });

    let transientFailureAttempts = 0;
    const transientFailureOccurrences = new Set<number>();
    for (const delivery of history) {
      const isCurrentOccurrence = delivery.occurrenceIndex === occurrenceIndex;
      const effectiveFailureMessage = isCurrentOccurrence
        ? failureMessage
        : (delivery.lastError ?? '').trim();
      if (!this.isManagedBroadcastTransientDeliveryFailureMessage(effectiveFailureMessage)) {
        continue;
      }

      transientFailureOccurrences.add(delivery.occurrenceIndex);
      transientFailureAttempts += isCurrentOccurrence
        ? Math.max(1, currentAttemptCount)
        : Math.max(1, delivery.attemptCount);
    }

    if (
      transientFailureAttempts < MANAGED_BROADCAST_TARGET_QUARANTINE_ATTEMPTS &&
      transientFailureOccurrences.size < MANAGED_BROADCAST_TARGET_QUARANTINE_FAILURE_OCCURRENCES
    ) {
      return null;
    }

    return this.buildManagedBroadcastTransientQuarantineMessage(
      transientFailureAttempts,
      transientFailureOccurrences.size,
      failureMessage,
    );
  }

  private shouldAutoRetryManagedBroadcastDeliveryFailure(
    delivery: PersistedManagedBroadcastDelivery,
  ): boolean {
    if (delivery.attemptCount >= MANAGED_BROADCAST_MAX_AUTO_RETRY_ATTEMPTS) {
      return false;
    }

    const retryAllowedAtMs = delivery.updatedAt.getTime() + MANAGED_BROADCAST_AUTO_RETRY_BACKOFF_MS;
    if (retryAllowedAtMs > Date.now()) {
      return false;
    }

    return this.isManagedBroadcastTransientDeliveryFailureMessage(delivery.lastError ?? '');
  }

  private isManagedBroadcastTransientDeliveryFailureMessage(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return true;
    }

    return (
      normalized.includes('timeout') ||
      normalized.includes('rate limit exceeded') ||
      normalized.includes('circuit breaker') ||
      normalized.includes('attachment.not.ready') ||
      normalized.includes('not ready') ||
      normalized.includes('temporarily unavailable') ||
      normalized.includes('service unavailable') ||
      normalized.includes('socket hang up') ||
      normalized.includes('econnaborted') ||
      normalized.includes('econnreset') ||
      normalized.includes('network error') ||
      normalized.includes('прошлая попытка была прервана после старта отправки')
    );
  }

  private isManagedBroadcastTransientQuarantineFailureMessage(value: string): boolean {
    return value
      .trim()
      .toLowerCase()
      .startsWith(MANAGED_BROADCAST_TRANSIENT_QUARANTINE_REASON_PREFIX.toLowerCase());
  }

  private buildManagedBroadcastTransientQuarantineMessage(
    transientFailureAttempts: number,
    transientFailureOccurrences: number,
    lastFailureMessage: string,
  ): string {
    const reason =
      transientFailureOccurrences >= MANAGED_BROADCAST_TARGET_QUARANTINE_FAILURE_OCCURRENCES
        ? `${MANAGED_BROADCAST_TRANSIENT_QUARANTINE_REASON_PREFIX}: ${transientFailureOccurrences} проблемных слота подряд.`
        : `${MANAGED_BROADCAST_TRANSIENT_QUARANTINE_REASON_PREFIX}: ${transientFailureAttempts} неудачных попыток.`;
    const normalizedLastFailureMessage = lastFailureMessage.trim();
    return normalizedLastFailureMessage
      ? `${reason} Последняя ошибка: ${normalizedLastFailureMessage}`
      : reason;
  }

  private isManagedBroadcastPermanentTargetDeliveryFailure(
    error: unknown,
    failureMessage: string,
  ): boolean {
    if (error && isPrivateDialogChatUnavailableError(error)) {
      return true;
    }

    const normalized = failureMessage.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    return (
      normalized.includes('chat closed') ||
      normalized.includes('chat not found') ||
      /^chat\s+.+\s+not found$/i.test(failureMessage.trim()) ||
      normalized.includes('not active chat member') ||
      normalized.includes('not a chat member') ||
      normalized.includes('bot is not a chat member') ||
      normalized.includes('not accessible') ||
      normalized.includes('forbidden') ||
      normalized.includes('chat.denied') ||
      normalized.includes('chat.not.found')
    );
  }

  private async reconcileStaleManagedBroadcastDeliveries(
    broadcastId: string,
    occurrenceIndex: number,
    staleLockBefore: Date,
  ): Promise<void> {
    await this.reconcileManagedBroadcastSendingDeliveries(broadcastId, occurrenceIndex, {
      lockedAt: { lt: staleLockBefore },
    });
  }

  private async reconcileInterruptedManagedBroadcastDeliveries(
    broadcastId: string,
    occurrenceIndex: number,
  ): Promise<void> {
    await this.reconcileManagedBroadcastSendingDeliveries(broadcastId, occurrenceIndex);
  }

  private async reconcileManagedBroadcastSendingDeliveries(
    broadcastId: string,
    occurrenceIndex: number,
    extraWhere?: Prisma.ManagedBroadcastDeliveryWhereInput,
  ): Promise<void> {
    const reconciledAt = new Date();
    await this.prisma.managedBroadcastDelivery.updateMany({
      where: {
        broadcastId,
        occurrenceIndex,
        status: PrismaManagedBroadcastDeliveryStatus.SENDING,
        remoteMessageId: { not: null },
        ...(extraWhere ?? {}),
      },
      data: {
        status: PrismaManagedBroadcastDeliveryStatus.SENT,
        sentAt: reconciledAt,
        lockedAt: null,
        lastError: null,
      },
    });
    await this.prisma.managedBroadcastDelivery.updateMany({
      where: {
        broadcastId,
        occurrenceIndex,
        status: PrismaManagedBroadcastDeliveryStatus.SENDING,
        remoteMessageId: null,
        ...(extraWhere ?? {}),
      },
      data: {
        status: PrismaManagedBroadcastDeliveryStatus.FAILED,
        lockedAt: null,
        lastError:
          'Прошлая попытка была прервана после старта отправки. Проверьте чат и повторите только ошибочные доставки.',
      },
    });
  }

  private resolveManagedBroadcastFatalProcessingErrorMessage(error: unknown): string | null {
    if (!(error instanceof BadRequestException)) {
      return null;
    }

    const response = error.getResponse();
    if (typeof response === 'string' && response.trim().length > 0) {
      return response.trim();
    }

    const message = (response as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message.trim();
    }
    if (Array.isArray(message)) {
      const normalized = message.find(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      );
      if (normalized) {
        return normalized.trim();
      }
    }

    return error.message.trim().length > 0 ? error.message.trim() : null;
  }

  private resolveManagedBroadcastFatalProcessingFailureMessage(
    failureMessage: string | null | undefined,
  ): string | null {
    const normalized = failureMessage?.trim();
    if (!normalized) {
      return null;
    }

    switch (normalized) {
      case 'Поддерживаются только изображения.':
      case 'Фото слишком большое. Попробуйте другое изображение.':
      case 'Не удалось загрузить фото. Попробуйте другое изображение.':
        return normalized;
      default:
        return null;
    }
  }

  private async failManagedBroadcastAfterFatalProcessingError(
    row: PersistedManagedBroadcast,
    currentOccurrence: number,
    failureMessage: string,
  ): Promise<void> {
    await this.prisma.managedBroadcastDelivery.updateMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: currentOccurrence,
        status: {
          in: [
            PrismaManagedBroadcastDeliveryStatus.PENDING,
            PrismaManagedBroadcastDeliveryStatus.SENDING,
            PrismaManagedBroadcastDeliveryStatus.FAILED,
          ],
        },
      },
      data: {
        status: PrismaManagedBroadcastDeliveryStatus.FAILED,
        lockedAt: null,
        lastError: failureMessage,
      },
    });
    await this.prisma.managedBroadcastDelivery.updateMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: { gt: currentOccurrence },
        status: {
          in: [
            PrismaManagedBroadcastDeliveryStatus.PENDING,
            PrismaManagedBroadcastDeliveryStatus.SENDING,
            PrismaManagedBroadcastDeliveryStatus.FAILED,
          ],
        },
      },
      data: {
        status: PrismaManagedBroadcastDeliveryStatus.CANCELED,
        lockedAt: null,
        lastError: failureMessage,
      },
    });

    if (normalizeBroadcastScheduleMode(row.scheduleMode) === 'calendar') {
      await this.prisma.managedBroadcastOccurrence.updateMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex: currentOccurrence,
        },
        data: {
          status: PrismaManagedBroadcastStatus.FAILED,
        },
      });
      await this.prisma.managedBroadcastOccurrence.updateMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex: { gt: currentOccurrence },
        },
        data: {
          status: PrismaManagedBroadcastStatus.CANCELED,
        },
      });
    }

    await this.updateManagedBroadcastIfNotCanceled(row.id, {
      status: PrismaManagedBroadcastStatus.FAILED,
      lastError: failureMessage,
      nextSendAt: null,
      lockedAt: null,
    });

    this.logger.warn(
      {
        broadcastId: row.id,
        sourceChatId: row.sourceChatId,
        actorUserId: row.actorUserId,
        occurrenceIndex: currentOccurrence,
        err: failureMessage,
      },
      'Managed broadcast was stopped after a fatal processing error',
    );
  }

  private async updateManagedBroadcastIfNotCanceled(
    broadcastId: string,
    data: Prisma.ManagedBroadcastUpdateManyMutationInput,
  ): Promise<boolean> {
    const result = await this.prisma.managedBroadcast.updateMany({
      where: {
        id: broadcastId,
        status: {
          in: [
            PrismaManagedBroadcastStatus.ACTIVE,
            PrismaManagedBroadcastStatus.PARTIAL,
            PrismaManagedBroadcastStatus.FAILED,
          ],
        },
      },
      data,
    });

    return result.count > 0;
  }

  private async readManagedBroadcastOccurrenceResult(
    broadcastId: string,
    sentChatIds: string[],
    failedChatIds: string[],
    pendingChatIds: string[],
    firstSendError: unknown,
  ): Promise<BroadcastOccurrenceResult> {
    const current = await this.prisma.managedBroadcast.findUnique({
      where: { id: broadcastId },
    });

    return {
      status: current?.status ?? PrismaManagedBroadcastStatus.FAILED,
      currentOccurrence: current ? this.getCurrentManagedBroadcastOccurrence(current) : 1,
      sentChatIds,
      failedChatIds,
      pendingChatIds,
      canRetry:
        current?.status === PrismaManagedBroadcastStatus.PARTIAL ||
        current?.status === PrismaManagedBroadcastStatus.FAILED,
      firstSendError,
      nextSendAt: current?.nextSendAt ?? null,
    };
  }

  private async finalizeManagedBroadcastOccurrence(
    row: PersistedManagedBroadcast,
    currentOccurrence: number,
    sentChatIds: string[],
    failedChatIds: string[],
    firstSendError: unknown,
  ): Promise<BroadcastOccurrenceResult> {
    const deliveries = await this.prisma.managedBroadcastDelivery.findMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: currentOccurrence,
      },
    });
    const deliveredChats = deliveries.filter(
      (delivery: any) => delivery.status === PrismaManagedBroadcastDeliveryStatus.SENT,
    );
    const failedChats = deliveries.filter(
      (delivery: any) => delivery.status === PrismaManagedBroadcastDeliveryStatus.FAILED,
    );
    const pendingChats = deliveries.filter(
      (delivery: any) =>
        delivery.status === PrismaManagedBroadcastDeliveryStatus.PENDING ||
        delivery.status === PrismaManagedBroadcastDeliveryStatus.SENDING,
    );
    const canRetry = failedChats.length > 0;

    if (pendingChats.length > 0) {
      const updated = await this.updateManagedBroadcastIfNotCanceled(row.id, {
        status: PrismaManagedBroadcastStatus.ACTIVE,
        lastError: null,
        lockedAt: null,
      });
      if (!updated) {
        return this.readManagedBroadcastOccurrenceResult(
          row.id,
          sentChatIds.length > 0
            ? sentChatIds
            : deliveredChats.map((delivery: any) => delivery.targetChatId),
          failedChatIds.length > 0
            ? failedChatIds
            : failedChats.map((delivery: any) => delivery.targetChatId),
          pendingChats.map((delivery: any) => delivery.targetChatId),
          firstSendError,
        );
      }
      if (normalizeBroadcastScheduleMode(row.scheduleMode) === 'calendar') {
        await this.prisma.managedBroadcastOccurrence.updateMany({
          where: {
            broadcastId: row.id,
            occurrenceIndex: currentOccurrence,
          },
          data: {
            status: PrismaManagedBroadcastStatus.ACTIVE,
          },
        });
      }

      return {
        status: PrismaManagedBroadcastStatus.ACTIVE,
        currentOccurrence,
        sentChatIds:
          sentChatIds.length > 0
            ? sentChatIds
            : deliveredChats.map((delivery: any) => delivery.targetChatId),
        failedChatIds:
          failedChatIds.length > 0
            ? failedChatIds
            : failedChats.map((delivery: any) => delivery.targetChatId),
        pendingChatIds: pendingChats.map((delivery: any) => delivery.targetChatId),
        canRetry: false,
        firstSendError,
        nextSendAt: row.nextSendAt,
      };
    }

    if (failedChats.length > 0) {
      const status =
        deliveredChats.length > 0
          ? PrismaManagedBroadcastStatus.PARTIAL
          : PrismaManagedBroadcastStatus.FAILED;
      const failureMessage = this.buildManagedBroadcastFailureMessage(
        failedChats.length,
        firstSendError,
      );
      const updated = await this.updateManagedBroadcastIfNotCanceled(row.id, {
        status,
        lastError: failureMessage,
        lockedAt: null,
      });
      if (!updated) {
        return this.readManagedBroadcastOccurrenceResult(
          row.id,
          sentChatIds.length > 0
            ? sentChatIds
            : deliveredChats.map((delivery: any) => delivery.targetChatId),
          failedChatIds.length > 0
            ? failedChatIds
            : failedChats.map((delivery: any) => delivery.targetChatId),
          pendingChats.map((delivery: any) => delivery.targetChatId),
          firstSendError,
        );
      }
      if (normalizeBroadcastScheduleMode(row.scheduleMode) === 'calendar') {
        await this.prisma.managedBroadcastOccurrence.updateMany({
          where: {
            broadcastId: row.id,
            occurrenceIndex: currentOccurrence,
          },
          data: {
            status,
          },
        });
      }

      return {
        status,
        currentOccurrence,
        sentChatIds:
          sentChatIds.length > 0
            ? sentChatIds
            : deliveredChats.map((delivery: any) => delivery.targetChatId),
        failedChatIds:
          failedChatIds.length > 0
            ? failedChatIds
            : failedChats.map((delivery: any) => delivery.targetChatId),
        pendingChatIds: pendingChats.map((delivery: any) => delivery.targetChatId),
        canRetry,
        firstSendError,
        nextSendAt: row.nextSendAt,
      };
    }

    const nextSentCount = currentOccurrence;
    let nextSendAt: Date | null;
    let isComplete: boolean;
    if (normalizeBroadcastScheduleMode(row.scheduleMode) === 'calendar') {
      const nextOccurrence = await this.getManagedBroadcastOccurrenceAtIndex(
        row.id,
        currentOccurrence + 1,
      );
      nextSendAt = nextOccurrence?.scheduledAt ?? null;
      isComplete = nextSentCount >= row.cycleCount || !nextSendAt;
      await this.prisma.managedBroadcastOccurrence.updateMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex: currentOccurrence,
        },
        data: {
          status: PrismaManagedBroadcastStatus.COMPLETED,
        },
      });
    } else {
      isComplete = nextSentCount >= row.cycleCount;
      nextSendAt = isComplete
        ? null
        : new Date(row.nextSendAt!.getTime() + row.cycleEveryHours * ONE_HOUR_MS);
    }
    const updated = await this.updateManagedBroadcastIfNotCanceled(row.id, {
      sentCount: nextSentCount,
      nextSendAt,
      status: isComplete
        ? PrismaManagedBroadcastStatus.COMPLETED
        : PrismaManagedBroadcastStatus.ACTIVE,
      lastError: null,
      lockedAt: null,
    });
    if (!updated) {
      return this.readManagedBroadcastOccurrenceResult(
        row.id,
        sentChatIds.length > 0
          ? sentChatIds
          : deliveredChats.map((delivery: any) => delivery.targetChatId),
        [],
        [],
        firstSendError,
      );
    }
    return {
      status: isComplete
        ? PrismaManagedBroadcastStatus.COMPLETED
        : PrismaManagedBroadcastStatus.ACTIVE,
      currentOccurrence,
      sentChatIds:
        sentChatIds.length > 0
          ? sentChatIds
          : deliveredChats.map((delivery: any) => delivery.targetChatId),
      failedChatIds: [],
      pendingChatIds: [],
      canRetry: false,
      firstSendError,
      nextSendAt,
    };
  }

  private buildManagedBroadcastFailureMessage(
    failedChats: number,
    firstSendError: unknown,
  ): string {
    return (
      this.extractMaxApiErrorMessage(firstSendError) ||
      (firstSendError instanceof Error && firstSendError.message.trim()
        ? firstSendError.message
        : `Не удалось отправить в ${failedChats} чат(ов).`)
    );
  }

  private async getManagedBroadcastDeliverySnapshots(
    rows: PersistedManagedBroadcast[],
  ): Promise<Map<string, ManagedBroadcastDeliverySnapshot>> {
    if (rows.length === 0) {
      return new Map();
    }

    const deliveries = await this.prisma.managedBroadcastDelivery.findMany({
      where: {
        OR: rows.map((row) => ({
          broadcastId: row.id,
          occurrenceIndex: this.getCurrentManagedBroadcastOccurrence(row),
        })),
      },
      select: {
        broadcastId: true,
        status: true,
      },
    });

    const grouped = new Map<string, PersistedManagedBroadcastDelivery[]>();
    for (const delivery of deliveries) {
      const current = grouped.get(delivery.broadcastId) ?? [];
      current.push(delivery as PersistedManagedBroadcastDelivery);
      grouped.set(delivery.broadcastId, current);
    }

    return new Map(
      rows.map((row) => [
        row.id,
        this.createManagedBroadcastDeliverySnapshot(row, grouped.get(row.id) ?? []),
      ]),
    );
  }

  private async getManagedBroadcastDeliverySnapshot(
    row: PersistedManagedBroadcast,
  ): Promise<ManagedBroadcastDeliverySnapshot> {
    const deliveries = await this.prisma.managedBroadcastDelivery.findMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: this.getCurrentManagedBroadcastOccurrence(row),
      },
    });
    return this.createManagedBroadcastDeliverySnapshot(row, deliveries);
  }

  private createManagedBroadcastDeliverySnapshot(
    row: PersistedManagedBroadcast,
    deliveries: PersistedManagedBroadcastDelivery[],
  ): ManagedBroadcastDeliverySnapshot {
    const failureBreakdown = this.createEmptyManagedBroadcastFailureBreakdown();
    for (const delivery of deliveries) {
      if (
        delivery.status !== PrismaManagedBroadcastDeliveryStatus.FAILED &&
        delivery.status !== PrismaManagedBroadcastDeliveryStatus.CANCELED
      ) {
        continue;
      }

      const failureMessage = delivery.lastError ?? '';
      if (this.isManagedBroadcastTransientQuarantineFailureMessage(failureMessage)) {
        failureBreakdown.quarantined += 1;
        continue;
      }
      if (this.isManagedBroadcastPermanentTargetDeliveryFailure(null, failureMessage)) {
        failureBreakdown.permanentTarget += 1;
        continue;
      }
      if (this.isManagedBroadcastTransientDeliveryFailureMessage(failureMessage)) {
        failureBreakdown.transient += 1;
        continue;
      }
      failureBreakdown.unknown += 1;
    }

    return {
      currentOccurrence: this.getCurrentManagedBroadcastOccurrence(row),
      deliveredChats: deliveries.filter(
        (delivery: any) => delivery.status === PrismaManagedBroadcastDeliveryStatus.SENT,
      ).length,
      failedChats: deliveries.filter(
        (delivery: any) => delivery.status === PrismaManagedBroadcastDeliveryStatus.FAILED,
      ).length,
      pendingChats: deliveries.filter(
        (delivery) =>
          delivery.status === PrismaManagedBroadcastDeliveryStatus.PENDING ||
          delivery.status === PrismaManagedBroadcastDeliveryStatus.SENDING,
      ).length,
      blockedChats: deliveries.filter(
        (delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.CANCELED,
      ).length,
      failureBreakdown,
      canRetry:
        row.status === PrismaManagedBroadcastStatus.PARTIAL ||
        row.status === PrismaManagedBroadcastStatus.FAILED,
    };
  }

  private createEmptyManagedBroadcastFailureBreakdown(): ManagedBroadcastFailureBreakdown {
    return {
      transient: 0,
      permanentTarget: 0,
      quarantined: 0,
      unknown: 0,
    };
  }

  private mapManagedBroadcastSummary(
    row: PersistedManagedBroadcast,
    snapshot?: ManagedBroadcastDeliverySnapshot,
    upcomingSlots: Date[] = [],
    targetPreviewBundle?: ManagedBroadcastTargetPreviewBundle,
  ): ManagedBroadcastSummary {
    const { targetMode, targetChatIds } = this.resolveManagedBroadcastTargetsFromRow(row);
    const normalizedText = row.text.replace(/\s+/gu, ' ').trim();
    const resolvedSnapshot = snapshot ?? this.createManagedBroadcastDeliverySnapshot(row, []);
    const resolvedTargetPreviewBundle =
      targetPreviewBundle ??
      this.buildManagedBroadcastTargetPreviewBundle(
        targetChatIds,
        new Map(),
        fromPrismaEntityType(row.entityType),
      );
    const buttonState = this.buildManagedBroadcastButtonState(row.buttons, {
      buttonEnabled: row.buttonEnabled,
      buttonUrl: row.buttonUrl,
      buttonText: row.buttonText,
    });
    const images = this.readManagedBroadcastImagesFromRow(row);
    const hasVideo = readManagedBroadcastMediaType(row.mediaType) === 'video';
    const cycleCount = this.normalizeManagedBroadcastCycleCount(row);

    return {
      id: row.id,
      status: row.status,
      textPreview: normalizedText
        ? normalizedText.slice(0, 160)
        : images.length > 0
          ? 'Фото без текста'
          : hasVideo
            ? 'Видео без текста'
            : 'Пустой автопостинг',
      textLength: row.text.length,
      targetMode,
      applyToAllChats: row.applyToAllChats,
      targetChatIds,
      targetChats: targetChatIds.length,
      targetPreviews: resolvedTargetPreviewBundle.previews,
      targetOverflowCount: resolvedTargetPreviewBundle.overflowCount,
      hasImage: images.length > 0,
      imageCount: images.length,
      hasVideo,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      scheduleMode: normalizeBroadcastScheduleMode(row.scheduleMode),
      scheduleTimezone: row.scheduleTimezone,
      scheduledSlots: upcomingSlots.map((slot) => slot.toISOString()),
      nextSendAt: row.nextSendAt?.toISOString() ?? null,
      cycleEnabled: row.cycleEnabled,
      cycleEveryHours: row.cycleEveryHours,
      cycleCount,
      sentCount: row.sentCount,
      currentOccurrence: resolvedSnapshot.currentOccurrence,
      deliveredChats: resolvedSnapshot.deliveredChats,
      failedChats: resolvedSnapshot.failedChats,
      pendingChats: resolvedSnapshot.pendingChats,
      blockedChats: resolvedSnapshot.blockedChats,
      failureBreakdown: resolvedSnapshot.failureBreakdown,
      canRetry: resolvedSnapshot.canRetry,
      remainingCount: Math.max(0, row.cycleCount - row.sentCount),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastError: row.lastError && row.lastError.trim() ? row.lastError : null,
    };
  }

  private mapManagedBroadcastDetails(
    row: PersistedManagedBroadcast,
    snapshot?: ManagedBroadcastDeliverySnapshot,
    upcomingSlots: Date[] = [],
    targetPreviewBundle?: ManagedBroadcastTargetPreviewBundle,
  ): ManagedBroadcastDetails {
    const { targetMode, targetChatIds } = this.resolveManagedBroadcastTargetsFromRow(row);
    const resolvedSnapshot = snapshot ?? this.createManagedBroadcastDeliverySnapshot(row, []);
    const resolvedTargetPreviewBundle =
      targetPreviewBundle ??
      this.buildManagedBroadcastTargetPreviewBundle(
        targetChatIds,
        new Map(),
        fromPrismaEntityType(row.entityType),
      );
    const buttonState = this.buildManagedBroadcastButtonState(row.buttons, {
      buttonEnabled: row.buttonEnabled,
      buttonUrl: row.buttonUrl,
      buttonText: row.buttonText,
    });
    const mediaType = readManagedBroadcastMediaType(row.mediaType);
    const images = this.readManagedBroadcastImagesFromRow(row);
    const firstImage = images[0];
    const cycleCount = this.normalizeManagedBroadcastCycleCount(row);

    return {
      id: row.id,
      status: row.status,
      text: row.text,
      textFormat: this.normalizeBroadcastTextFormat(row.textFormat),
      targetMode,
      applyToAllChats: row.applyToAllChats,
      targetChatIds,
      targetPreviews: resolvedTargetPreviewBundle.previews,
      targetOverflowCount: resolvedTargetPreviewBundle.overflowCount,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      imageEnabled: images.length > 0,
      imageBase64: firstImage?.base64 ?? '',
      imageMimeType: firstImage?.mimeType ?? '',
      imageFileName: firstImage?.fileName ?? '',
      images,
      mediaType,
      mediaPayload: mediaType ? this.readObjectPayloadOrNull(row.mediaPayload) : null,
      mediaMimeType: mediaType ? row.mediaMimeType : '',
      mediaFileName: mediaType ? row.mediaFileName : '',
      scheduleMode: normalizeBroadcastScheduleMode(row.scheduleMode),
      scheduleTimezone: row.scheduleTimezone,
      scheduledSlots: upcomingSlots.map((slot) => slot.toISOString()),
      nextSendAt: row.nextSendAt?.toISOString() ?? null,
      cycleEnabled: row.cycleEnabled,
      cycleEveryHours: row.cycleEveryHours,
      cycleCount,
      sentCount: row.sentCount,
      currentOccurrence: resolvedSnapshot.currentOccurrence,
      deliveredChats: resolvedSnapshot.deliveredChats,
      failedChats: resolvedSnapshot.failedChats,
      pendingChats: resolvedSnapshot.pendingChats,
      blockedChats: resolvedSnapshot.blockedChats,
      failureBreakdown: resolvedSnapshot.failureBreakdown,
      canRetry: resolvedSnapshot.canRetry,
      remainingCount: Math.max(0, row.cycleCount - row.sentCount),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastError: row.lastError && row.lastError.trim() ? row.lastError : null,
    };
  }

  private async sendManagedBroadcastMessageImmediateWithId(
    chatId: string,
    text: string,
    options:
      | Pick<
          MaxSendMessageOptions,
          'button' | 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'
        >
      | undefined,
    botId?: string,
    maxApiOptions?: ManagedBroadcastMaxApiOptions,
  ): Promise<MaxPublishedMessage> {
    let lastError: unknown = null;
    const attempts =
      Math.max(
        this.hasRetriableMaxAttachment(options) ? BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS.length : 0,
        BROADCAST_THROTTLE_RETRY_DELAYS_MS.length,
        BROADCAST_TIMEOUT_RETRY_DELAYS_MS.length,
      ) + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const published = botId
          ? await this.maxClient.sendMessageImmediateWithId(chatId, text, options, {
              ...this.buildManagedBroadcastMaxApiRequestOptions(maxApiOptions),
              botId,
            })
          : await this.maxClient.sendMessageImmediateWithId(
              chatId,
              text,
              options,
              this.buildManagedBroadcastMaxApiRequestOptions(maxApiOptions),
            );
        return published;
      } catch (error: unknown) {
        lastError = error;
        const retryDelayMs = this.resolveManagedBroadcastSendRetryDelayMs(error, attempt, options);
        if (retryDelayMs === null) {
          throw error;
        }
        await this.sleep(retryDelayMs);
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new Error('Managed broadcast send did not return a result.');
  }

  private async sendBroadcastImageMessageWithRetry(
    chatId: string,
    text: string,
    options:
      | Pick<
          MaxSendMessageOptions,
          'button' | 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'
        >
      | undefined,
    botId?: string,
    maxApiOptions?: ManagedBroadcastMaxApiOptions,
  ): Promise<void> {
    let lastError: unknown = null;
    const attempts = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.maxClient.sendMessage(
          chatId,
          text,
          options,
          botId
            ? {
                immediate: true,
                ...this.buildManagedBroadcastMaxApiRequestOptions(maxApiOptions),
                botId,
              }
            : {
                immediate: true,
                ...this.buildManagedBroadcastMaxApiRequestOptions(maxApiOptions),
              },
        );
        return;
      } catch (error: unknown) {
        lastError = error;
        if (!this.isAttachmentNotReadyError(error) || attempt >= attempts) {
          throw error;
        }
        const delayMs = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS[attempt - 1] ?? 1_500;
        await this.sleep(delayMs);
      }
    }

    if (lastError) {
      throw lastError;
    }
  }
}
