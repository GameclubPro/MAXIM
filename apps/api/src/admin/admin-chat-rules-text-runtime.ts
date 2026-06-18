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
export type {
  AdminActionSource,
  ChannelPublicationEngagementContext,
} from './admin.service.support';


export class AdminChatRulesTextRuntime {
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

  private normalizeChatRulesDraft(value: UpdateChatRulesRequest): UpdateChatRulesRequest {
    return normalizeChatRulesDraftValue(value);
  }

  private normalizeImportedRulesText(value: string | null | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return null;
    }

    return normalized.slice(0, 2_000);
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

    return {
      text: appendAdminContactMarkdownLinkText(sourceText, {
        enabled: options.adminContactButtonEnabled,
        url: options.adminContactButtonUrl,
        botTokens: this.maxBotTokenValidationSecrets,
        fallbackDisplayName,
      }),
      textFormat: 'markdown',
    };
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
    const items = this.buildRulesTextItemsFromSettings(input);
    if (items.length === 0) {
      throw new BadRequestException('Нет активных настроек, из которых можно собрать правила.');
    }

    const lines = ['Правила чата:', ''];
    const numberedItems: string[] = [];

    for (const [index, item] of items.entries()) {
      const numberedItem = `${index + 1}. ${item}`;
      const candidate = [...lines, ...numberedItems, numberedItem].join('\n');
      if (candidate.length > 2_000) {
        break;
      }
      numberedItems.push(numberedItem);
    }

    if (numberedItems.length === 0) {
      throw new BadRequestException(
        'Не удалось собрать короткий текст правил из текущих настроек.',
      );
    }

    return [...lines, ...numberedItems].join('\n');
  }

  private buildRulesTextItemsFromSettings(input: {
    settings: ChatSettings;
    domains: DomainAllowlistEntry[];
    requiredSubscriptionChannels: ManagedEntityHeader[];
  }): string[] {
    const { settings, requiredSubscriptionChannels, domains } = input;
    const items: string[] = [];

    if (settings.linkPolicy === 'BLOCKLIST_ONLY') {
      items.push('Пожалуйста, не отправляйте ссылки: бот их удаляет.');
    } else if (settings.linkPolicy === 'ALLOWLIST_ONLY') {
      items.push(
        domains.length > 0
          ? 'Можно отправлять только ссылки из разрешённого списка.'
          : 'Ссылки здесь ограничены: если нужно, сначала согласуйте их с администраторами.',
      );
    } else if (settings.linkPolicy === 'ALERT_ONLY') {
      items.push('Ссылки бот проверяет, но не удаляет автоматически.');
    }

    if (this.isRequiredSubscriptionCurrentlyActive(settings)) {
      const channelTitles = requiredSubscriptionChannels
        .map((channel) => channel.title.trim())
        .filter(Boolean);
      items.push(
        channelTitles.length > 0
          ? `Чтобы писать в чат, сначала подпишитесь на: ${this.formatRulesPreviewList(channelTitles, 3)}.`
          : 'Чтобы писать в чат, сначала подпишитесь на обязательные чаты или каналы.',
      );
    }

    if (settings.russianProfanityFilterEnabled) {
      items.push('Пожалуйста, без мата и грубой лексики.');
    }

    if (settings.commercialAdsFilterEnabled) {
      items.push('Коммерческую рекламу публикуйте только по согласованию с администраторами.');
    }

    if (settings.thematicCodewordEnabled) {
      const codeword = settings.thematicCodeword.trim();
      items.push(
        codeword
          ? `Если пишете по теме, начинайте сообщение со слова "${codeword}".`
          : 'Если включён тематический фильтр, придерживайтесь темы чата.',
      );
    }

    if (settings.antiDuplicateEnabled) {
      const allowedCount = this.resolveRulesDuplicateAllowedCount(settings);
      items.push(
        allowedCount === 0
          ? 'Не повторяйте одно и то же сообщение несколько раз.'
          : `Не повторяйте одно и то же сообщение: бот среагирует ${this.formatRulesDuplicateAllowanceLabel(allowedCount)}.`,
      );
    }

    if (settings.antiSpamEnabled) {
      items.push('Пожалуйста, не флудите и не спамьте.');
    }

    if (settings.messageCountLimitEnabled) {
      items.push(
        `Пожалуйста, не отправляйте больше ${settings.messageCountLimitMessages} сообщений за ${settings.messageCountLimitWindowHours} ${this.formatRulesHoursLabel(settings.messageCountLimitWindowHours)}.`,
      );
    }

    if (settings.maxMessageLengthEnabled) {
      items.push(
        `Старайтесь писать короче: до ${settings.maxMessageLength} символов в одном сообщении.`,
      );
    }

    if (settings.photoMessageCooldownEnabled) {
      items.push(
        `Фото можно отправлять не чаще одного раза в ${settings.photoMessageCooldownHours} ${this.formatRulesHoursLabel(settings.photoMessageCooldownHours)}.`,
      );
    }

    if (settings.stickerMessageCooldownEnabled) {
      items.push(
        `Стикеры можно отправлять не чаще одного раза в ${settings.stickerMessageCooldownMinutes} ${this.formatRulesMinutesLabel(settings.stickerMessageCooldownMinutes)}.`,
      );
    }

    if (!settings.photoMessagesEnabled) {
      items.push('Фото сюда отправлять нельзя.');
    }

    if (!settings.videoMessagesEnabled) {
      items.push('Видео сюда отправлять нельзя.');
    }

    if (!settings.fileMessagesEnabled) {
      items.push('Файлы сюда отправлять нельзя.');
    }

    if (!settings.voiceMessagesEnabled) {
      items.push('Голосовые сообщения сюда отправлять нельзя.');
    }

    if (!settings.phoneNumbersEnabled) {
      items.push('Телефонные номера в сообщениях запрещены.');
    }

    if (settings.nightModeEnabled) {
      items.push(
        `Ночью чат работает тише: ограничения действуют с ${this.formatRulesTime(settings.nightModeStartTimeMinutes)} до ${this.formatRulesTime(settings.nightModeEndTimeMinutes)}.`,
      );
    }

    const sanctionsSummary = this.buildRulesSanctionsSummary(
      this.isRequiredSubscriptionCurrentlyActive(settings)
        ? settings
        : {
            ...settings,
            requiredSubscriptionWarnEnabled: false,
            requiredSubscriptionMuteEnabled: false,
            requiredSubscriptionBanEnabled: false,
          },
    );
    if (sanctionsSummary) {
      items.push(sanctionsSummary);
    }

    return items;
  }

  private buildRulesSanctionsSummary(
    settings: Pick<
      ChatSettings,
      | 'linkWarnEnabled'
      | 'requiredSubscriptionWarnEnabled'
      | 'textFiltersWarnEnabled'
      | 'thematicFiltersWarnEnabled'
      | 'messageLimitsWarnEnabled'
      | 'duplicateWarnEnabled'
      | 'linkMuteEnabled'
      | 'requiredSubscriptionMuteEnabled'
      | 'textFiltersMuteEnabled'
      | 'thematicFiltersMuteEnabled'
      | 'messageLimitsMuteEnabled'
      | 'duplicateMuteEnabled'
      | 'linkBanEnabled'
      | 'requiredSubscriptionBanEnabled'
      | 'textFiltersBanEnabled'
      | 'thematicFiltersBanEnabled'
      | 'messageLimitsBanEnabled'
      | 'duplicateBanEnabled'
    >,
  ): string | null {
    const sanctions = new Set<string>();

    if (
      settings.linkWarnEnabled ||
      settings.requiredSubscriptionWarnEnabled ||
      settings.textFiltersWarnEnabled ||
      settings.thematicFiltersWarnEnabled ||
      settings.messageLimitsWarnEnabled ||
      settings.duplicateWarnEnabled
    ) {
      sanctions.add('предупредить');
    }

    if (
      settings.linkMuteEnabled ||
      settings.requiredSubscriptionMuteEnabled ||
      settings.textFiltersMuteEnabled ||
      settings.thematicFiltersMuteEnabled ||
      settings.messageLimitsMuteEnabled ||
      settings.duplicateMuteEnabled
    ) {
      sanctions.add('временно ограничить сообщения');
    }

    if (
      settings.linkBanEnabled ||
      settings.requiredSubscriptionBanEnabled ||
      settings.textFiltersBanEnabled ||
      settings.thematicFiltersBanEnabled ||
      settings.messageLimitsBanEnabled ||
      settings.duplicateBanEnabled
    ) {
      sanctions.add('заблокировать');
    }

    if (sanctions.size === 0) {
      return null;
    }

    return `За повторные нарушения бот может ${this.formatRulesConjunctionList([...sanctions])}.`;
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
    const firstThreshold = settings.duplicateWarnEnabled
      ? settings.duplicateWarnMaxCount
      : settings.duplicateMuteEnabled
        ? settings.duplicateMuteMaxCount
        : settings.duplicateBanEnabled
          ? settings.duplicateBanMaxCount
          : settings.duplicateWarnMaxCount;
    const duplicateThresholdOffset =
      (settings.duplicateBotMessageEnabled ? 2 : 1) +
      (settings.duplicateWarnEnabled ? 1 : 0) +
      (settings.duplicateMuteEnabled ? 1 : 0);
    const allowedCountMax = Math.max(0, 20 - duplicateThresholdOffset);

    return Math.max(
      0,
      Math.min(allowedCountMax, firstThreshold - (settings.duplicateBotMessageEnabled ? 2 : 1)),
    );
  }

  private formatRulesDuplicateAllowanceLabel(count: number): string {
    if (count === 0) {
      return 'с первого дубля';
    }

    if (count === 1) {
      return 'после 1 дубля';
    }

    return `после ${count} дублей`;
  }

  private formatRulesPreviewList(values: readonly string[], limit: number): string {
    const uniqueValues = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
    const visible = uniqueValues.slice(0, limit);
    const remaining = uniqueValues.length - visible.length;
    if (remaining <= 0) {
      return visible.join(', ');
    }

    return `${visible.join(', ')} и ещё ${remaining}`;
  }

  private formatRulesConjunctionList(values: readonly string[]): string {
    if (values.length <= 1) {
      return values[0] ?? '';
    }

    if (values.length === 2) {
      return `${values[0]} и ${values[1]}`;
    }

    return `${values.slice(0, -1).join(', ')} и ${values[values.length - 1]}`;
  }

  private formatRulesHoursLabel(value: number): string {
    const normalized = Math.abs(Math.trunc(value));
    const mod10 = normalized % 10;
    const mod100 = normalized % 100;

    if (mod10 === 1 && mod100 !== 11) {
      return 'час';
    }

    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
      return 'часа';
    }

    return 'часов';
  }

  private formatRulesMinutesLabel(value: number): string {
    const normalized = Math.abs(Math.trunc(value));
    const mod10 = normalized % 10;
    const mod100 = normalized % 100;

    if (mod10 === 1 && mod100 !== 11) {
      return 'минуту';
    }

    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
      return 'минуты';
    }

    return 'минут';
  }

  private formatRulesTime(minutes: number): string {
    const totalMinutes = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
    const hours = Math.floor(totalMinutes / 60)
      .toString()
      .padStart(2, '0');
    const mins = (totalMinutes % 60).toString().padStart(2, '0');
    return `${hours}:${mins}`;
  }

}
