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
  MAX_CHAT_RULES_TEXT_LENGTH,
  inferAllowlistMatchType,
  normalizeMessageLimitsBlockedDomainCandidate,
  normalizeMessageLimitsBlockedWordCandidate,
  normalizeStoredAllowlistEntry,
  parseStoredAllowlistEntry,
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
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import {
  MAX_MESSAGE_TEXT_LENGTH,
  prepareMarkdownForMaxDelivery,
} from '../common/max-markdown.util';
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
  readTrimmedString,
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
  CHANNEL_STATS_POST_ACTIONS,
  CHANNEL_STATS_ACTIVITY_ACTIONS,
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
  type ChannelStatsPostRow,
  type ChannelStatsViewSnapshotRow,
  type ChannelStatsPostViewMetric,
  type ChannelStatsContentBucketPoint,
  type ChannelStatsPeriodTotals,
  type ChannelStatsComparisonSeries,
  type ChannelStatsPreviousPeriodSnapshot,
  type ChannelStatsDeltaMetric,
  type ChannelStatsGraphMarker,
  type ChannelStatsBestWindow,
  type ChannelDialogMessageSource,
  type DialogMessageEntityType,
  type CommentDialogNotificationKind,
  type ChannelSuggestionFromBotPayload,
  type ChannelSuggestionReviewAction,
  type ChannelSuggestionAdminDelivery,
} from './admin.service.support';
import type { AdminChatRulesTextRuntimeContext } from './admin-chat-rules-text-runtime-context';
import {
  buildRulesTextFromSettings as buildRulesTextFromSettingsValue,
  buildRulesTextItemsFromSettings as buildRulesTextItemsFromSettingsValue,
  buildRulesSanctionsSummary as buildRulesSanctionsSummaryValue,
  formatRulesConjunctionList as formatRulesConjunctionListValue,
  formatRulesDuplicateAllowanceLabel as formatRulesDuplicateAllowanceLabelValue,
  formatRulesHoursLabel as formatRulesHoursLabelValue,
  formatRulesMinutesLabel as formatRulesMinutesLabelValue,
  formatRulesPreviewList as formatRulesPreviewListValue,
  formatRulesTime as formatRulesTimeValue,
  resolveRulesDuplicateAllowedCount as resolveRulesDuplicateAllowedCountValue,
} from './admin-chat-rules-text-format';
export type {
  AdminActionSource,
  ChannelPublicationEngagementContext,
} from './admin.service.support';

export class AdminChatRulesTextRuntime {
  constructor(private readonly context: AdminChatRulesTextRuntimeContext) {}

  private get prisma(): PrismaService {
    return this.context.prisma;
  }

  private get chatContextCache(): ChatContextCacheService {
    return this.context.chatContextCache;
  }

  private get maxClient(): MaxClientService {
    return this.context.maxClient;
  }

  private get logger(): Logger {
    return this.context.logger;
  }

  private get maxBotTokenValidationSecrets(): readonly string[] {
    return this.context.maxBotTokenValidationSecrets;
  }

  private getSettings(chatId: string, user: AuthUser): Promise<ChatSettings> {
    return this.context.getSettings(chatId, user);
  }

  private getDomainAllowlistDetails(
    chatId: string,
    user: AuthUser,
  ): Promise<DomainAllowlistEntry[]> {
    return this.context.getDomainAllowlistDetails(chatId, user);
  }

  private isRequiredSubscriptionCurrentlyActive(settings: ChatSettings): boolean {
    return this.context.isRequiredSubscriptionCurrentlyActive(settings);
  }

  private resolveRequiredSubscriptionChannelHeaders(
    channelIds: readonly string[],
  ): Promise<ManagedEntityHeader[]> {
    return this.context.resolveRequiredSubscriptionChannelHeaders(channelIds);
  }

  private resolveUserDisplayNames(chatId: string, userIds: string[]): Promise<Map<string, string>> {
    return this.context.resolveUserDisplayNames(chatId, userIds);
  }

  private resolveChatSettingsReadBotAssignmentData(
    chatId: string,
  ): Promise<ResolvedBotAssignmentData> {
    return this.context.resolveChatSettingsReadBotAssignmentData(chatId);
  }

  private readTrimmedString(value: unknown): string | null {
    return readTrimmedString(value);
  }

  private normalizeChatRulesDraft(value: UpdateChatRulesRequest): UpdateChatRulesRequest {
    return normalizeChatRulesDraftValue(value);
  }

  private normalizeImportedRulesText(value: string | null | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return null;
    }

    return normalized.length <= MAX_CHAT_RULES_TEXT_LENGTH ? normalized : null;
  }

  private async upsertChatRules(chatId: string): Promise<PersistedChatRules> {
    return ensureChatRulesValue({
      prisma: this.prisma,
      chatId,
    });
  }

  private mapChatRules(rules: PersistedChatRules): ChatRules {
    return mapChatRulesValue(rules);
  }

  private async hydratePublishedRulesUrl(
    chatId: string,
    rules: PersistedChatRules,
  ): Promise<PersistedChatRules> {
    return hydratePublishedRulesUrlValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      logger: this.logger,
      chatId,
      rules,
      resolveBotId: async () => (await this.resolveChatSettingsReadBotAssignmentData(chatId)).botId,
    });
  }

  private normalizePublishedRulesUrl(value: string | null | undefined): string | null {
    return normalizePublishedRulesUrlValue(value);
  }

  private buildChatRulesButtonRows(rules: {
    buttons: unknown;
    buttonEnabled: boolean;
    buttonUrl: string;
    buttonText: string;
  }): MaxMessageButton[][] | null {
    return buildChatRulesButtonRowsValue(rules);
  }

  private async buildFormattedRulesPublicationText(
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
    const fallbackDisplayName = options.adminContactButtonEnabled
      ? await this.resolveAdminContactFallbackDisplayName(chatId, options.adminContactButtonUrl)
      : null;

    const markdown = appendAdminContactMarkdownLinkText(sourceText, {
      enabled: options.adminContactButtonEnabled,
      url: options.adminContactButtonUrl,
      botTokens: this.maxBotTokenValidationSecrets,
      fallbackDisplayName,
    });

    const prepared = prepareMarkdownForMaxDelivery(markdown);
    if (!prepared) {
      throw new BadRequestException(
        `Текст правил после форматирования слишком длинный. Максимум ${MAX_MESSAGE_TEXT_LENGTH} символов.`,
      );
    }

    return prepared;
  }

  private async resolveAdminContactFallbackDisplayName(
    chatId: string,
    url: string | null | undefined,
  ): Promise<string | null> {
    const target = resolveAdminContactMentionTarget(url, this.maxBotTokenValidationSecrets);
    if (!target?.userId || target.displayName) {
      return null;
    }

    const localDisplayNames = await this.resolveUserDisplayNames(chatId, [target.userId]);
    const localDisplayName = this.readTrimmedString(localDisplayNames.get(target.userId));
    if (localDisplayName) {
      return localDisplayName;
    }

    const loadProfiles = this.maxClient.getChatMemberProfiles?.bind(this.maxClient);
    if (!loadProfiles) {
      return null;
    }

    try {
      const profiles = await loadProfiles(chatId, [target.userId], {
        trafficClass: 'interactive',
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      });
      return this.readTrimmedString(profiles.get(target.userId)?.displayName) ?? null;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId: target.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve admin contact display name for rules publication',
      );
      return null;
    }
  }

  private async buildAutofilledRulesTextFromCurrentSettings(
    chatId: string,
    user: AuthUser,
  ): Promise<string> {
    const settings = await this.getSettings(chatId, user);
    const [domains, requiredSubscriptionChannels] = await Promise.all([
      settings.linkPolicy === 'ALLOWLIST_ONLY'
        ? this.getDomainAllowlistDetails(chatId, user)
        : Promise.resolve([] as DomainAllowlistEntry[]),
      this.isRequiredSubscriptionCurrentlyActive(settings)
        ? this.resolveRequiredSubscriptionChannelHeaders(settings.requiredSubscriptionChannelIds)
        : Promise.resolve([] as ManagedEntityHeader[]),
    ]);

    return this.buildRulesTextFromSettings({
      settings,
      domains,
      requiredSubscriptionChannels,
    });
  }

  private buildRulesTextFromSettings(input: {
    settings: ChatSettings;
    domains: DomainAllowlistEntry[];
    requiredSubscriptionChannels: ManagedEntityHeader[];
  }): string {
    return buildRulesTextFromSettingsValue(input);
  }

  private buildRulesTextItemsFromSettings(input: {
    settings: ChatSettings;
    domains: DomainAllowlistEntry[];
    requiredSubscriptionChannels: ManagedEntityHeader[];
  }): string[] {
    return buildRulesTextItemsFromSettingsValue(input);
  }

  private buildRulesSanctionsSummary(
    settings: Pick<
      ChatSettings,
      | 'linkWarnEnabled'
      | 'requiredSubscriptionWarnEnabled'
      | 'textFiltersWarnEnabled'
      | 'messageLimitsWarnEnabled'
      | 'duplicateWarnEnabled'
      | 'linkMuteEnabled'
      | 'requiredSubscriptionMuteEnabled'
      | 'textFiltersMuteEnabled'
      | 'messageLimitsMuteEnabled'
      | 'duplicateMuteEnabled'
      | 'linkBanEnabled'
      | 'requiredSubscriptionBanEnabled'
      | 'textFiltersBanEnabled'
      | 'messageLimitsBanEnabled'
      | 'duplicateBanEnabled'
    >,
  ): string | null {
    return buildRulesSanctionsSummaryValue(settings);
  }

  private resolveRulesDuplicateAllowedCount(
    settings: Pick<
      ChatSettings,
      | 'duplicateBotMessageEnabled'
      | 'duplicateWarnEnabled'
      | 'duplicateMuteEnabled'
      | 'duplicateBanEnabled'
      | 'duplicateWarnMaxCount'
      | 'duplicateMuteMaxCount'
      | 'duplicateBanMaxCount'
    >,
  ): number {
    return resolveRulesDuplicateAllowedCountValue(settings);
  }

  private formatRulesDuplicateAllowanceLabel(count: number): string {
    return formatRulesDuplicateAllowanceLabelValue(count);
  }

  private formatRulesPreviewList(values: readonly string[], limit: number): string {
    return formatRulesPreviewListValue(values, limit);
  }

  private formatRulesConjunctionList(values: readonly string[]): string {
    return formatRulesConjunctionListValue(values);
  }

  private formatRulesHoursLabel(value: number): string {
    return formatRulesHoursLabelValue(value);
  }

  private formatRulesMinutesLabel(value: number): string {
    return formatRulesMinutesLabelValue(value);
  }

  private formatRulesTime(minutes: number): string {
    return formatRulesTimeValue(minutes);
  }
}
