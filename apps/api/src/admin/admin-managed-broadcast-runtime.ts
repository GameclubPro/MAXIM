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
  sendBroadcastRequestSchema,
  sendBroadcastResultSchema,
  sendBroadcastTestResultSchema,
  scheduleDomainRemovalRequestSchema,
  toggleChannelDialogReactionResponseSchema,
  updateChannelDialogNotificationsRequestSchema,
  updateChannelDialogNotificationsResponseSchema,
  updateChannelDialogMessageRequestSchema,
  updateChannelDialogMessageResponseSchema,
  type AllowlistMatchType,
  MAX_BROADCAST_IMAGES,
  INVITATION_ACCESS_REQUIRED_COUNT_MAX,
  INVITATION_ACCESS_REQUIRED_COUNT_MIN,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_DEFAULT,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN,
  normalizeBroadcastScheduledSlots,
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
  PublicationLifecycle as PrismaPublicationLifecycle,
  PublicationOccurrenceStatus as PrismaPublicationOccurrenceStatus,
  PublicationScheduleMode as PrismaPublicationScheduleMode,
  PublicationScheduleStatus as PrismaPublicationScheduleStatus,
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
  type MaxActionLedgerContext,
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
import {
  isMaxActionNoExecutableRouteError,
  MAX_ACTION_NO_EXECUTABLE_ROUTE_ERROR_CODE,
} from '../max/max-action-dispatch-error';
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
import type { ManagedEntityAccessLossService } from '../max/managed-entity-access-loss.service';
import {
  MaxRoutedPublicationService,
  type MaxRoutedPublicationResult,
} from '../max/max-routed-publication.service';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';
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
  isPrivateDialogChatUnavailableError,
  isPrivateDirectChat,
  isPrismaKnownError,
  isMaxApiTimeoutError,
  isUnsupportedManagedChat,
  mapWithConcurrencyLimit,
  normalizeAppBaseUrl,
  normalizeBotContactId,
  normalizeOwnBotUserId,
  readTrimmedString as readTrimmedStringValue,
  resolvePresentableManagedEntityTitle,
  toPrismaEntityType,
} from './admin-legacy-utils';
import {
  buildManagedBroadcastButtonState as buildManagedBroadcastButtonStateValue,
  buildManagedBroadcastLinkButtonRows,
  normalizeManagedBroadcastButtons as normalizeManagedBroadcastButtonsValue,
  type ManagedBroadcastLegacyButtonState,
} from './admin-managed-broadcast-buttons';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import type { ChannelPostSignatureService } from './channel-post-signature.service';
import type {
  ManagedBroadcastButtonContextOptions,
  ManagedBroadcastButtonContextResult,
} from './admin-managed-broadcast-runtime-context';
import {
  decodeBroadcastImageBase64 as decodeBroadcastImageBase64Value,
  hasRetriableManagedBroadcastAttachment,
  isAttachmentNotReadyError as isAttachmentNotReadyErrorValue,
  isManagedBroadcastSlotConflictError as isManagedBroadcastSlotConflictErrorValue,
  resolveBroadcastImageFileName as resolveBroadcastImageFileNameValue,
  resolveManagedBroadcastAttachmentRetryCount,
  resolveManagedBroadcastSendRetryDelayMs as resolveManagedBroadcastSendRetryDelayMsValue,
  resolveManagedBroadcastUploadRetryDelayMs,
  type ManagedBroadcastRetriableAttachmentOptions,
} from './admin-managed-broadcast-media';
import {
  AdminManagedBroadcastMediaRuntime,
  ManagedBroadcastTransientUploadError,
  type ManagedBroadcastProgressCallback,
  type ManagedBroadcastTestOptions,
} from './admin-managed-broadcast-media-runtime';
import {
  AdminManagedBroadcastPublicationVerification,
  type ManagedBroadcastPublicationVerificationBudget,
} from './admin-managed-broadcast-publication-verification';
import {
  buildManagedBroadcastLedgerContext,
  readManagedBroadcastLedgerCommentDialogContext,
  type ManagedBroadcastCommentDialogReference,
} from './admin-managed-broadcast-ledger';
import {
  buildLegacyManagedBroadcastUpcomingSlots,
  buildManagedBroadcastCalendarReservationRows,
  buildManagedBroadcastDeliveryRows,
  buildManagedBroadcastOccurrenceRows,
  buildManagedBroadcastTargetPreviewBundle,
  fallbackManagedBroadcastTargetPreview,
  getCurrentManagedBroadcastOccurrence,
  normalizeManagedBroadcastCycleCount,
  normalizeManagedBroadcastTargetChatIds,
  parseManagedBroadcastSendAt,
  parseManagedBroadcastTargetChatIds,
  planManagedBroadcastSchedule,
  resolveManagedBroadcastTargetsFromRow as resolveManagedBroadcastTargetsFromRowValue,
  toLegacyCycleEveryDays,
} from './admin-managed-broadcast-planner';
import {
  buildManagedBroadcastDeliveryActionKey as buildManagedBroadcastDeliveryActionKeyValue,
  buildManagedBroadcastFailureMessage,
  buildManagedBroadcastTransientQuarantineMessage,
  createManagedBroadcastDeliverySnapshot as createManagedBroadcastDeliverySnapshotValue,
  isManagedBroadcastAutoRetryableDeliveryFailureMessage,
  isAmbiguousManagedBroadcastSendError,
  isManagedBroadcastPermanentTargetDeliveryFailure,
  isManagedBroadcastTransientDeliveryFailureMessage,
  isManagedBroadcastTransientQuarantineFailureMessage,
  resolveManagedBroadcastFatalProcessingErrorMessage,
  resolveManagedBroadcastFatalProcessingFailureMessage,
  markManagedBroadcastSendPhase,
  shouldAutoRetryManagedBroadcastDeliveryFailure,
} from './admin-managed-broadcast-reconciliation';
import {
  buildManagedBroadcastPendingDeliveryRecoveryUpdates,
  buildManagedBroadcastLedgerRecoveryActionKeys,
  classifyManagedBroadcastLedgerRecovery,
  collectManagedBroadcastLedgerRecoveryActionKeys,
} from './admin-managed-broadcast-ledger-recovery';
import { cancelManagedBroadcastTargetDeliveries } from './admin-managed-broadcast-target-failure';
import {
  cancelPublicationDeliveryBeforeStoppedDispatch,
  deferManagedBroadcastWithFreshDeliveryLocks,
  deferPublicationDeliveryAfterPreDispatchThrottle,
  deferPublicationDeliveryAfterRouteQuarantine,
  ensureManagedBroadcastPublicationExecutionActive as ensurePublicationExecutionActive,
  ManagedBroadcastPublicationExecutionStopped,
  selectManagedBroadcastDeliveryCandidates,
} from './publication-execution-recovery';
import {
  buildPublicationDeliveryVerificationScheduledData,
  hasPublicationDeliveryAutomatedVerificationState,
  PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
  PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA,
} from './publication-delivery-verification-state';
import { PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE } from './publication-access-loss-recovery';
import {
  selectLegacyManagedBroadcastDueBatch,
  selectPublicationManagedBroadcastDueBatch,
} from './admin-managed-broadcast-due-selection';
import { processPriorityHalfOpenPublicationVerifications } from './admin-managed-broadcast-priority-verification';
import {
  PUBLICATION_MAX_VIDEO_BYTES,
  PUBLICATION_VIDEO_ASSET_ID_FIELD,
  PUBLICATION_VIDEO_INLINE_BASE64_FIELD,
} from './publication-video-media';
import {
  PUBLICATION_MAX_IMAGE_BYTES,
  PUBLICATION_MAX_TOTAL_IMAGE_BYTES,
} from './publication-media-limits';
import { safeParseTrustedPublicationTestBroadcastRequest } from './publication-test-broadcast-request';
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
  BROADCAST_VIDEO_SEND_RETRY_DELAYS_MS,
  BROADCAST_CALENDAR_SLOT_MINUTES,
  MANAGED_BROADCAST_DUE_BATCH_SIZE,
  MANAGED_BROADCAST_DEADLINE_BATCH_SIZE,
  MANAGED_BROADCAST_AUTOMATIC_DELIVERY_QUANTUM,
  MANAGED_BROADCAST_DUE_MAX_PASSES,
  MANAGED_BROADCAST_LOCK_STALE_MS,
  MANAGED_BROADCAST_LOCK_HEARTBEAT_MS,
  PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE,
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

type ManagedBroadcastLease = {
  lockedAt: Date;
  lockToken: string;
  lastHeartbeatAt: Date;
};

class ManagedBroadcastIdempotencyReplay extends Error {
  constructor(readonly result: SendBroadcastResult) {
    super('Managed broadcast idempotency replay');
  }
}

class ManagedBroadcastTestIdempotencyReplay extends Error {
  constructor(readonly result: SendBroadcastTestResult) {
    super('Managed broadcast test idempotency replay');
  }
}

const resolveEarlierDate = (current: Date | null, candidate: Date): Date =>
  current && current.getTime() < candidate.getTime() ? current : candidate;

export class AdminManagedBroadcastRuntime {
  private readonly mediaRuntime: AdminManagedBroadcastMediaRuntime;
  private readonly publicationVerification: AdminManagedBroadcastPublicationVerification;

  constructor(private readonly context: AdminManagedBroadcastRuntimeContext) {
    this.mediaRuntime = new AdminManagedBroadcastMediaRuntime(context);
    this.publicationVerification = new AdminManagedBroadcastPublicationVerification(context);
  }

  private get prisma(): PrismaService {
    return this.context.prisma;
  }

  private get maxClient(): MaxClientService {
    return this.context.maxClient;
  }

  private get logger(): Logger {
    return this.context.logger;
  }

  private get backgroundRuntimeGovernorService(): BackgroundRuntimeGovernorService | undefined {
    return this.context.backgroundRuntimeGovernorService;
  }

  private get managedEntityAccessLossService(): ManagedEntityAccessLossService | undefined {
    return this.context.managedEntityAccessLossService;
  }

  private get maxRoutedPublicationService(): MaxRoutedPublicationService | undefined {
    return this.context.maxRoutedPublicationService;
  }

  private get channelPostSignatureService(): ChannelPostSignatureService | undefined {
    return this.context.channelPostSignatureService;
  }

  private get managedBroadcastDegradePauseLogAtMs(): number {
    return this.context.managedBroadcastDegradePauseLogAtMs;
  }

  private set managedBroadcastDegradePauseLogAtMs(value: number) {
    this.context.managedBroadcastDegradePauseLogAtMs = value;
  }

  private resolveSystemModeSnapshot(): Promise<SystemModeSnapshot> {
    return this.context.resolveSystemModeSnapshot();
  }

  private resolveDeliveryBotAssignment(chatId: string): Promise<string | undefined> {
    return this.context.resolveDeliveryBotAssignment(chatId);
  }

  private resolvePrivateDeliveryBotId(botId?: string | null): string | undefined {
    return this.context.resolvePrivateDeliveryBotId(botId);
  }

  private resolvePrivateDialogChatId(
    user: AuthUser,
    botId?: string | null,
  ): Promise<string | null> {
    return this.context.resolvePrivateDialogChatId(user, botId);
  }

  private listChatsForMassBroadcast(
    user: AuthUser,
    options: {
      discoveryMode?: 'full' | 'cached-first';
    } = {},
  ): Promise<ChatSummary[]> {
    return this.context.listChatsForMassBroadcast(user, options);
  }

  private assertManagedEntityAdminAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
  ): Promise<void> {
    return this.context.assertManagedEntityAdminAccess(chatId, userId, entityType);
  }

  private assertManagedEntityReadAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
    options: AdminReadBypassOptions = {},
  ): Promise<void> {
    return this.context.assertManagedEntityReadAccess(chatId, userId, entityType, options);
  }

  private resolveBroadcastButtonContext(
    chatId: string,
    entityType: ManagedEntityType,
    options: ManagedBroadcastButtonContextOptions,
    botId?: string,
  ): Promise<ManagedBroadcastButtonContextResult> {
    return this.context.resolveBroadcastButtonContext(chatId, entityType, options, botId);
  }

  private extractMaxApiErrorMessage(error: unknown): string {
    return extractMaxApiErrorMessageValue(error);
  }

  private readObjectPayloadOrNull(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private readTrimmedString(value: unknown): string | null {
    return readTrimmedStringValue(value);
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

  async sendPublicationBroadcastTest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<SendBroadcastTestResult> {
    return this.sendManagedBroadcastTest(sourceChatId, user, body, 'chat', {
      trustedPublicationTestPayload: true,
      trustedPublicationVideoMarkers: true,
    });
  }

  async sendPublicationChannelBroadcastTest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<SendBroadcastTestResult> {
    return this.sendManagedBroadcastTest(sourceChatId, user, body, 'channel', {
      trustedPublicationTestPayload: true,
      trustedPublicationVideoMarkers: true,
    });
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
    // FLAG: PublicationRunnerService exclusively owns publication execution envelopes. Running
    // them here gives overlapping 15-second runner snapshots a second delivery quantum.
    const processedBroadcastIds = new Set<string>();

    for (let pass = 0; pass < MANAGED_BROADCAST_DUE_MAX_PASSES; pass += 1) {
      const governorDecision = await this.resolveManagedBroadcastBackgroundDecision(reason);
      if (governorDecision.action === 'pause') {
        return;
      }

      const { dueRows, staleLockBefore } = await selectLegacyManagedBroadcastDueBatch(
        this.prisma,
        governorDecision.action,
        processedBroadcastIds,
      );

      if (dueRows.length === 0) {
        return;
      }

      for (const row of dueRows) {
        processedBroadcastIds.add(row.id);
        await this.processManagedBroadcastOccurrence(row.id, reason, staleLockBefore, [
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

  async processDueImmediatePublicationBroadcasts(
    sharedVerificationBudget?: ManagedBroadcastPublicationVerificationBudget,
  ): Promise<ManagedBroadcastPublicationVerificationBudget> {
    const verificationBudget = sharedVerificationBudget ?? {
      remaining: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE,
    };
    await processPriorityHalfOpenPublicationVerifications({
      prisma: this.prisma,
      logger: this.logger,
      verification: this.publicationVerification,
      maxApiOptions: this.mediaRuntime.resolveManagedBroadcastProcessingMaxApiOptions('deadline'),
      budget: verificationBudget,
    });
    const { dueRows, staleLockBefore } = await selectPublicationManagedBroadcastDueBatch(
      this.prisma,
      [PrismaPublicationScheduleMode.NOW],
      MANAGED_BROADCAST_DUE_BATCH_SIZE,
    );

    for (const row of dueRows) {
      await this.processManagedBroadcastOccurrence(
        row.id,
        'immediate',
        staleLockBefore,
        [
          PrismaManagedBroadcastStatus.ACTIVE,
          PrismaManagedBroadcastStatus.PARTIAL,
          PrismaManagedBroadcastStatus.FAILED,
        ],
        undefined,
        verificationBudget,
      );
    }
    return verificationBudget;
  }

  async processDueDeadlinePublicationBroadcasts(
    limit = MANAGED_BROADCAST_DEADLINE_BATCH_SIZE,
    sharedVerificationBudget?: ManagedBroadcastPublicationVerificationBudget,
  ): Promise<ManagedBroadcastPublicationVerificationBudget> {
    const verificationBudget = sharedVerificationBudget ?? {
      remaining: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE,
    };
    const { dueRows, staleLockBefore } = await selectPublicationManagedBroadcastDueBatch(
      this.prisma,
      [
        PrismaPublicationScheduleMode.ONCE,
        PrismaPublicationScheduleMode.SLOTS,
        PrismaPublicationScheduleMode.RECURRENCE,
      ],
      limit,
    );

    for (const row of dueRows) {
      await this.processManagedBroadcastOccurrence(
        row.id,
        'deadline',
        staleLockBefore,
        [
          PrismaManagedBroadcastStatus.ACTIVE,
          PrismaManagedBroadcastStatus.PARTIAL,
          PrismaManagedBroadcastStatus.FAILED,
        ],
        undefined,
        verificationBudget,
      );
    }
    return verificationBudget;
  }

  private async resolveManagedBroadcastBackgroundDecision(
    reason: 'startup' | 'scheduled',
  ): Promise<ManagedBroadcastBackgroundDecision> {
    if (this.backgroundRuntimeGovernorService) {
      const decision = await this.backgroundRuntimeGovernorService.decide({
        component: 'managed-broadcast',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
        allowMaxApiCapacitySlowPath: true,
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
    await this.assertManagedEntityReadAccess(sourceChatId, user.userId, entityType, options);

    const baseWhere = {
      sourceChatId,
      entityType: mapManagedEntityTypeToChatEntityType(entityType),
      publicationOccurrenceId: null,
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
    const autopostRuleIdsByBroadcastId = await this.loadManagedAutopostRuleIdsByBroadcastId(
      rows.map((row) => row.id),
    );

    return rows.map((row) =>
      managedBroadcastSummarySchema.parse(
        this.mapManagedBroadcastSummary(
          row,
          snapshots.get(row.id),
          upcomingSlotsMap.get(row.id) ?? [],
          targetPreviewBundles.get(row.id),
          autopostRuleIdsByBroadcastId.get(row.id) ?? null,
        ),
      ),
    );
  }

  private parseManagedBroadcastCalendarQuery(query: unknown): {
    from: Date;
    to: Date;
    targetMode: BroadcastTargetMode;
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

    const targetModeRaw = typeof source.targetMode === 'string' ? source.targetMode : '';
    const targetMode: BroadcastTargetMode =
      targetModeRaw === 'all' || targetModeRaw === 'selected' ? targetModeRaw : 'current';

    return {
      from,
      to,
      targetMode,
      targetChatIds: normalizeManagedBroadcastTargetChatIds(readTargetValue(source.targetChatIds)),
    };
  }

  private async getManagedBroadcastCalendarForEntity(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    query: unknown,
  ): Promise<ManagedBroadcastCalendarResponse> {
    await this.assertManagedEntityReadAccess(sourceChatId, user.userId, entityType);

    const parsedQuery = this.parseManagedBroadcastCalendarQuery(query);
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

    const targetChatIds =
      entityType === 'chat' && parsedQuery.targetMode === 'all'
        ? [...allowedTargetIds].sort((left, right) => left.localeCompare(right))
        : parsedQuery.targetChatIds.length > 0
          ? parsedQuery.targetChatIds
          : [sourceChatId];

    const invalidTargetChatIds = targetChatIds.filter((chatId) => !allowedTargetIds.has(chatId));
    if (invalidTargetChatIds.length > 0) {
      throw new BadRequestException(
        'Некоторые выбранные чаты больше недоступны. Откройте список заново.',
      );
    }

    const prismaEntityType = mapManagedEntityTypeToChatEntityType(entityType);
    const reservations = await this.prisma.managedBroadcastCalendarReservation.findMany({
      where: {
        entityType: prismaEntityType,
        broadcast: { is: { publicationOccurrenceId: null } },
        targetChatId: {
          in: targetChatIds,
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
    const activeReservations = reservations.filter((reservation: any) => {
      if (
        reservation.broadcast.status !== PrismaManagedBroadcastStatus.ACTIVE &&
        reservation.broadcast.status !== PrismaManagedBroadcastStatus.PARTIAL &&
        reservation.broadcast.status !== PrismaManagedBroadcastStatus.FAILED
      ) {
        return false;
      }

      return true;
    });
    const activeOccurrences = Array.from(
      activeReservations
        .reduce((groups: Map<string, any>, reservation: any) => {
          const key = `${reservation.broadcastId}:${reservation.occurrenceIndex}`;
          const current =
            groups.get(key) ??
            ({
              broadcastId: reservation.broadcastId,
              occurrenceIndex: reservation.occurrenceIndex,
              scheduledAt: reservation.scheduledAt,
              broadcast: reservation.broadcast,
              overlapChatIds: [],
            } as any);
          current.overlapChatIds.push(reservation.targetChatId);
          groups.set(key, current);
          return groups;
        }, new Map<string, any>())
        .values(),
    );
    const requestedTargetChatIdSet = new Set(targetChatIds);
    const broadcastRows = Array.from(
      new Map(
        activeOccurrences.map((occurrence: any) => [occurrence.broadcast.id, occurrence.broadcast]),
      ).values(),
    ) as PersistedManagedBroadcast[];
    const allTargetChatIds = [
      ...targetChatIds,
      ...broadcastRows.flatMap((row) =>
        parseManagedBroadcastTargetChatIds(row.targetChatIds, row.sourceChatId),
      ),
    ];
    const previewMap = await this.loadManagedBroadcastTargetPreviewMap(
      allTargetChatIds,
      entityType,
    );
    const autopostRuleIdsByBroadcastId = await this.loadManagedAutopostRuleIdsByBroadcastId(
      broadcastRows.map((row) => row.id),
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
        const targetPreviewBundle = buildManagedBroadcastTargetPreviewBundle(
          rowTargetChatIds,
          previewMap,
          fromPrismaEntityType(row.entityType),
        );
        const overlapChatIds = normalizeManagedBroadcastTargetChatIds(
          occurrence.overlapChatIds,
        ).filter((chatId) => requestedTargetChatIdSet.has(chatId));
        const overlapPreviewBundle = buildManagedBroadcastTargetPreviewBundle(
          overlapChatIds,
          previewMap,
          fromPrismaEntityType(row.entityType),
        );
        const normalizedText = row.text.replace(/\s+/gu, ' ').trim();
        const hasVideo = readManagedBroadcastMediaType(row.mediaType) === 'video';
        const hasImage = this.mediaRuntime.readManagedBroadcastImagesFromRow(row).length > 0;

        return {
          broadcastId: row.id,
          autopostRuleId: autopostRuleIdsByBroadcastId.get(row.id) ?? null,
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
    await this.assertManagedEntityReadAccess(sourceChatId, user.userId, entityType);

    const row = await this.prisma.managedBroadcast.findFirst({
      where: {
        id: broadcastId,
        sourceChatId,
        entityType: mapManagedEntityTypeToChatEntityType(entityType),
        publicationOccurrenceId: null,
      },
    });
    if (!row) {
      throw new BadRequestException('Автопостинг не найден.');
    }

    const targetChatIds = parseManagedBroadcastTargetChatIds(row.targetChatIds, row.sourceChatId);
    const [snapshot, upcomingSlots, targetPreviewBundle] = await Promise.all([
      this.getManagedBroadcastDeliverySnapshot(row),
      this.getManagedBroadcastUpcomingSlots(row),
      this.getManagedBroadcastTargetPreviewBundle(targetChatIds, entityType),
    ]);
    const autopostRuleId = await this.resolveManagedAutopostRuleIdForBroadcast(row.id);
    return managedBroadcastDetailsSchema.parse(
      this.mapManagedBroadcastDetails(
        row,
        snapshot,
        upcomingSlots,
        targetPreviewBundle,
        autopostRuleId,
      ),
    );
  }

  private async updateManagedBroadcastForEntity(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<ManagedBroadcastDetails> {
    await this.assertManagedEntityAdminAccess(sourceChatId, user.userId, entityType);

    const existing = await this.prisma.managedBroadcast.findFirst({
      where: {
        id: broadcastId,
        sourceChatId,
        entityType: mapManagedEntityTypeToChatEntityType(entityType),
        publicationOccurrenceId: null,
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

    const currentOccurrence = getCurrentManagedBroadcastOccurrence(existing);
    const adminLock = await this.claimManagedBroadcastForAdminMutation(
      existing.id,
      currentOccurrence,
    );
    try {
      await this.reconcileInterruptedManagedBroadcastDeliveries(
        existing.id,
        currentOccurrence,
        new Date(Date.now() - MANAGED_BROADCAST_LOCK_STALE_MS),
      );
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
      const currentOccurrenceProtected = await this.prisma.managedBroadcastDelivery.count({
        where: {
          broadcastId: existing.id,
          occurrenceIndex: currentOccurrence,
          status: {
            in: [
              PrismaManagedBroadcastDeliveryStatus.SENDING,
              PrismaManagedBroadcastDeliveryStatus.AMBIGUOUS,
            ],
          },
        },
      });
      if (currentOccurrenceProtected > 0) {
        throw new BadRequestException(
          'Текущая отправка имеет незавершённую или неоднозначную доставку. Проверьте её перед изменением автопостинга.',
        );
      }
    } catch (error) {
      await this.releaseManagedBroadcastAdminMutationLock(existing.id, adminLock);
      throw error;
    }

    let schedulePlan: ManagedBroadcastSchedulePlan;
    try {
      schedulePlan = await planManagedBroadcastSchedule(request.payload, existing.sentCount);
    } catch (error) {
      await this.releaseManagedBroadcastAdminMutationLock(existing.id, adminLock);
      throw error;
    }
    const buttonState = this.buildManagedBroadcastButtonState(request.payload.buttons);
    const nextOccurrenceIndex = schedulePlan.sentCount + 1;
    const isCalendarPlanComplete =
      schedulePlan.scheduleMode === 'calendar' && schedulePlan.upcomingSlots.length === 0;

    let updatedAfterMutation: PersistedManagedBroadcast | null = null;
    try {
      updatedAfterMutation = await this.runManagedBroadcastCalendarMutationWithRetry(
        async (tx: any) => {
          const updateResult = await tx.managedBroadcast.updateMany({
            where: { id: existing.id, lockToken: adminLock.lockToken },
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
              lockToken: null,
            },
          });
          if (updateResult.count === 0) {
            throw new ServiceUnavailableException(
              'Автопостинг уже обрабатывается другим процессом. Повторите позже.',
            );
          }
          await tx.managedBroadcastDelivery.deleteMany({
            where: {
              broadcastId: existing.id,
              occurrenceIndex: { gte: currentOccurrence },
              status: { not: PrismaManagedBroadcastDeliveryStatus.SENT },
            },
          });
          await tx.managedBroadcastCalendarReservation.deleteMany({
            where: {
              broadcastId: existing.id,
              occurrenceIndex: { gte: currentOccurrence },
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
              data: buildManagedBroadcastDeliveryRows(
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

          return tx.managedBroadcast.findUnique({
            where: { id: existing.id },
          });
        },
      );
    } catch (error) {
      await this.releaseManagedBroadcastAdminMutationLock(existing.id, adminLock);
      throw error;
    }

    const updated = updatedAfterMutation;
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

    const updatedTargetChatIds = parseManagedBroadcastTargetChatIds(
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
    await this.assertManagedEntityAdminAccess(sourceChatId, user.userId, entityType);

    const existing = await this.prisma.managedBroadcast.findFirst({
      where: {
        id: broadcastId,
        sourceChatId,
        entityType: mapManagedEntityTypeToChatEntityType(entityType),
        publicationOccurrenceId: null,
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

    const currentOccurrence = getCurrentManagedBroadcastOccurrence(existing);
    const adminLock = await this.claimManagedBroadcastForAdminMutation(
      existing.id,
      currentOccurrence,
    );
    let canceled: PersistedManagedBroadcast | null = null;
    try {
      await this.reconcileInterruptedManagedBroadcastDeliveries(
        existing.id,
        currentOccurrence,
        new Date(Date.now() - MANAGED_BROADCAST_LOCK_STALE_MS),
      );
      canceled = await this.prisma.$transaction(async (tx: any) => {
        const updateResult = await tx.managedBroadcast.updateMany({
          where: { id: existing.id, lockToken: adminLock.lockToken },
          data: {
            status: PrismaManagedBroadcastStatus.CANCELED,
            nextSendAt: null,
            lockedAt: null,
            lockToken: null,
          },
        });
        if (updateResult.count === 0) {
          throw new ServiceUnavailableException(
            'Автопостинг уже обрабатывается другим процессом. Повторите позже.',
          );
        }
        await tx.managedBroadcastDelivery.updateMany({
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
            lockToken: null,
          },
        });
        await tx.managedBroadcastCalendarReservation.deleteMany({
          where: {
            broadcastId: existing.id,
            occurrenceIndex: { gte: currentOccurrence },
          },
        });
        await tx.managedBroadcastOccurrence.deleteMany({
          where: {
            broadcastId: existing.id,
            occurrenceIndex: { gte: currentOccurrence },
          },
        });
        return tx.managedBroadcast.findUnique({
          where: { id: existing.id },
        });
      });
    } catch (error) {
      await this.releaseManagedBroadcastAdminMutationLock(existing.id, adminLock);
      throw error;
    }
    if (!canceled) {
      throw new BadRequestException('Автопостинг не найден.');
    }

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

    const canceledTargetChatIds = parseManagedBroadcastTargetChatIds(
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
    await this.assertManagedEntityAdminAccess(sourceChatId, user.userId, entityType);

    const existing = await this.prisma.managedBroadcast.findFirst({
      where: {
        id: broadcastId,
        sourceChatId,
        entityType: mapManagedEntityTypeToChatEntityType(entityType),
        publicationOccurrenceId: null,
        status: {
          in: [PrismaManagedBroadcastStatus.PARTIAL, PrismaManagedBroadcastStatus.FAILED],
        },
      },
    });
    if (!existing) {
      throw new BadRequestException('Для повтора нет неуспешного автопостинга.');
    }

    const currentOccurrence = getCurrentManagedBroadcastOccurrence(existing);
    const adminLock = await this.claimManagedBroadcastForAdminMutation(
      existing.id,
      currentOccurrence,
    );
    try {
      await this.reconcileInterruptedManagedBroadcastDeliveries(
        existing.id,
        currentOccurrence,
        new Date(Date.now() - MANAGED_BROADCAST_LOCK_STALE_MS),
      );
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
      const hasAmbiguousDeliveries = deliveriesAfterReconcile.some(
        (delivery: any) => delivery.status === PrismaManagedBroadcastDeliveryStatus.AMBIGUOUS,
      );
      const hasPendingDeliveries = deliveriesAfterReconcile.some(
        (delivery: any) =>
          delivery.status === PrismaManagedBroadcastDeliveryStatus.PENDING ||
          delivery.status === PrismaManagedBroadcastDeliveryStatus.SENDING,
      );

      if (!hasFailedDeliveries && !hasPendingDeliveries && hasAmbiguousDeliveries) {
        throw new BadRequestException(
          'Есть неоднозначные доставки после таймаута MAX. Проверьте канал вручную перед повтором.',
        );
      }

      if (!hasFailedDeliveries && !hasPendingDeliveries) {
        await this.finalizeManagedBroadcastOccurrence(existing, currentOccurrence, [], [], null, {
          lease: adminLock,
        });

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

        const finalizedTargetChatIds = parseManagedBroadcastTargetChatIds(
          finalized.targetChatIds,
          finalized.sourceChatId,
        );
        const [snapshot, upcomingSlots, targetPreviewBundle] = await Promise.all([
          this.getManagedBroadcastDeliverySnapshot(finalized),
          this.getManagedBroadcastUpcomingSlots(finalized),
          this.getManagedBroadcastTargetPreviewBundle(finalizedTargetChatIds, entityType),
        ]);
        await this.releaseManagedBroadcastAdminMutationLock(existing.id, adminLock);
        return managedBroadcastDetailsSchema.parse(
          this.mapManagedBroadcastDetails(finalized, snapshot, upcomingSlots, targetPreviewBundle),
        );
      }

      await this.prisma.$transaction(async (tx: any) => {
        const updateResult = await tx.managedBroadcast.updateMany({
          where: { id: existing.id, lockToken: adminLock.lockToken },
          data: {
            status: PrismaManagedBroadcastStatus.ACTIVE,
            lastError: null,
            lockedAt: adminLock.lockedAt,
            lockToken: adminLock.lockToken,
            nextSendAt: existing.nextSendAt ?? currentOccurrenceSlot?.scheduledAt ?? new Date(),
          },
        });
        if (updateResult.count === 0) {
          throw new ServiceUnavailableException(
            'Автопостинг уже обрабатывается другим процессом. Повторите позже.',
          );
        }
        await tx.managedBroadcastDelivery.updateMany({
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
            lockToken: null,
            lastErrorCode: null,
            lastError: null,
          },
        });
        await tx.managedBroadcastOccurrence.updateMany({
          where: {
            broadcastId: existing.id,
            occurrenceIndex: currentOccurrence,
          },
          data: {
            status: PrismaManagedBroadcastStatus.ACTIVE,
          },
        });
      });
    } catch (error) {
      await this.releaseManagedBroadcastAdminMutationLock(existing.id, adminLock);
      throw error;
    }

    await this.processManagedBroadcastOccurrence(
      existing.id,
      'manual_retry',
      new Date(Date.now() - MANAGED_BROADCAST_LOCK_STALE_MS),
      [
        PrismaManagedBroadcastStatus.ACTIVE,
        PrismaManagedBroadcastStatus.PARTIAL,
        PrismaManagedBroadcastStatus.FAILED,
      ],
      adminLock,
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

    const updatedTargetChatIds = parseManagedBroadcastTargetChatIds(
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
      options.entityType === 'channel' ||
      request.payload.scheduleMode === 'calendar' ||
      request.payload.sendAt !== null ||
      request.payload.cycleEnabled;
    let idempotencyRecord: { id: string } | null;
    try {
      idempotencyRecord = await this.claimManagedBroadcastIdempotencyRecord(
        sourceChatId,
        user,
        request,
        options.entityType,
        options.source,
      );
    } catch (error: unknown) {
      if (error instanceof ManagedBroadcastIdempotencyReplay) {
        return error.result;
      }
      throw error;
    }

    let result: SendBroadcastResult;
    try {
      result = shouldSchedule
        ? await this.scheduleManagedBroadcast(
            sourceChatId,
            user,
            request,
            options.entityType,
            options.source,
            idempotencyRecord?.id ?? null,
          )
        : await this.sendManagedBroadcastViaQueue(
            sourceChatId,
            user,
            request,
            options.entityType,
            options.source,
          );
    } catch (error: unknown) {
      await this.releaseManagedBroadcastIdempotencyRecord(idempotencyRecord?.id ?? null);
      throw error;
    }

    await this.persistManagedBroadcastIdempotencyResult(idempotencyRecord?.id ?? null, result);
    return result;
  }

  private async sendManagedBroadcastTest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
    options: ManagedBroadcastTestOptions = {},
  ): Promise<SendBroadcastTestResult> {
    const request = await this.prepareManagedBroadcastRequest(sourceChatId, user, body, {
      entityType,
      trustedPublicationTestPayload: options.trustedPublicationTestPayload,
    });
    let idempotencyRecord: { id: string } | null;
    try {
      idempotencyRecord = await this.claimManagedBroadcastTestIdempotencyRecord(
        sourceChatId,
        user,
        request,
        entityType,
      );
    } catch (error: unknown) {
      if (error instanceof ManagedBroadcastTestIdempotencyReplay) {
        return error.result;
      }
      throw error;
    }

    const preparedDelivery = await (async () => {
      try {
        const deliveryBotId =
          (await this.resolveDeliveryBotAssignment(sourceChatId)) ??
          this.resolvePrivateDeliveryBotId();
        const privateChatId = await this.resolvePrivateDialogChatId(user, deliveryBotId);
        const maxApiOptions = this.mediaRuntime.buildManagedBroadcastMaxApiOptions('interactive');
        const media = await this.mediaRuntime.resolveManagedBroadcastMedia(
          request.payload,
          entityType,
          sourceChatId,
          user.userId,
          deliveryBotId,
          maxApiOptions,
          undefined,
          options,
        );
        const message = await this.buildManagedBroadcastMessage(
          sourceChatId,
          entityType,
          request.payload,
          request.normalizedSourceText,
          media,
          deliveryBotId,
        );
        return { deliveryBotId, privateChatId, message };
      } catch (error: unknown) {
        await this.releaseManagedBroadcastIdempotencyRecord(idempotencyRecord?.id ?? null);
        throw error;
      }
    })();

    let published: Awaited<
      ReturnType<AdminManagedBroadcastRuntime['sendManagedBroadcastTestPrivateMessage']>
    >;
    try {
      published = await this.sendManagedBroadcastTestPrivateMessage({
        adminUserId: user.userId,
        privateChatId: preparedDelivery.privateChatId,
        message: preparedDelivery.message.messageText,
        options: preparedDelivery.message.messageOptions,
        botId: preparedDelivery.deliveryBotId,
      });
    } catch (error: unknown) {
      if (isAmbiguousManagedBroadcastSendError(error)) {
        throw new ServiceUnavailableException({
          code: 'BROADCAST_TEST_RESULT_PENDING',
          message: 'Результат тестовой отправки не подтверждён.',
        });
      }
      await this.releaseManagedBroadcastIdempotencyRecord(idempotencyRecord?.id ?? null);
      const maxApiMessage = this.extractMaxApiErrorMessage(error);
      throw new BadRequestException(
        maxApiMessage ||
          'Не удалось отправить тест. Откройте личный диалог с ботом и попробуйте ещё раз.',
      );
    }

    const result = sendBroadcastTestResultSchema.parse({
      delivered: true,
      messageId: published.messageId,
      chatId: published.chatId ?? preparedDelivery.privateChatId ?? null,
      url: published.url ?? null,
    });
    await this.persistManagedBroadcastTestIdempotencyResult(idempotencyRecord?.id ?? null, result);
    await this.prisma.auditLog.create({
      data: {
        chatId: sourceChatId,
        actorUserId: user.userId,
        action: 'SEND_BROADCAST_TEST',
        payload: {
          entityType,
          botId: preparedDelivery.deliveryBotId ?? null,
          privateChatId: preparedDelivery.privateChatId ?? null,
          messageId: published.messageId,
        },
      },
    });
    return result;
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
        resolveManagedBroadcastAttachmentRetryCount(params.options),
        BROADCAST_THROTTLE_RETRY_DELAYS_MS.length,
        BROADCAST_TIMEOUT_RETRY_DELAYS_MS.length,
      ) + 1;

    for (let attempt = 1; attempt <= attempts; ) {
      let sendStarted = false;
      const messageOptions = {
        ...params.options,
        beforeSend: async () => {
          sendStarted = true;
        },
      };
      try {
        return privateChatId
          ? await this.maxClient.sendMessageImmediateWithId(
              privateChatId,
              params.message,
              messageOptions,
              {
                trafficClass: 'interactive',
                sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
                ...(params.botId ? { botId: params.botId } : {}),
              },
            )
          : await this.maxClient.sendMessageImmediateToUser(
              params.adminUserId,
              params.message,
              messageOptions,
              {
                trafficClass: 'interactive',
                sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
                ...(params.botId ? { botId: params.botId } : {}),
              },
            );
      } catch (error: unknown) {
        const phasedError = markManagedBroadcastSendPhase(error, sendStarted);
        lastError = phasedError;
        if (privateChatId && isPrivateDialogChatUnavailableError(phasedError)) {
          privateChatId = null;
          continue;
        }

        const retryDelayMs = this.resolveManagedBroadcastSendRetryDelayMs(
          phasedError,
          attempt,
          params.options,
        );
        if (retryDelayMs === null) {
          throw phasedError;
        }

        await sleep(retryDelayMs);
        attempt += 1;
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('Broadcast test delivery failed without error details.');
  }

  private createManagedBroadcastIdempotencyHash(
    payload: SendBroadcastRequest,
    targetChatIds: readonly string[],
    entityType: ManagedEntityType,
  ): string {
    const {
      requestId: _requestId,
      replaceConflictingSlots: _replaceConflictingSlots,
      ...stable
    } = payload;
    return createHash('sha256')
      .update(
        JSON.stringify({
          entityType,
          payload: stable,
          targetChatIds: [...targetChatIds].sort((left, right) => left.localeCompare(right)),
        }),
      )
      .digest('hex');
  }

  private async claimManagedBroadcastIdempotencyRecord(
    sourceChatId: string,
    user: AuthUser,
    request: PreparedManagedBroadcastRequest,
    entityType: ManagedEntityType,
    source: AdminActionSource,
  ): Promise<{ id: string } | null> {
    if (!request.idempotencyKey || !request.idempotencyHash) {
      return null;
    }

    const prismaEntityType = mapManagedEntityTypeToChatEntityType(entityType);
    try {
      return await this.prisma.managedBroadcastIdempotencyRecord.create({
        data: {
          requestId: request.idempotencyKey,
          requestHash: request.idempotencyHash,
          sourceChatId,
          entityType: prismaEntityType,
          actorUserId: user.userId,
          source,
        },
        select: { id: true },
      });
    } catch (error: unknown) {
      if (!isPrismaKnownError(error, 'P2002')) {
        throw error;
      }
    }

    const existing = await this.prisma.managedBroadcastIdempotencyRecord.findUnique({
      where: {
        sourceChatId_entityType_actorUserId_requestId: {
          sourceChatId,
          entityType: prismaEntityType,
          actorUserId: user.userId,
          requestId: request.idempotencyKey,
        },
      },
    });
    if (!existing) {
      throw new ServiceUnavailableException('Автопостинг уже запускается. Повторите позже.');
    }
    if (existing.requestHash !== request.idempotencyHash) {
      throw new BadRequestException('Ключ повтора уже использован для другого автопостинга.');
    }

    const cachedResult = this.readManagedBroadcastIdempotencyResult(existing.result);
    if (cachedResult) {
      throw new ManagedBroadcastIdempotencyReplay(cachedResult);
    }
    if (existing.broadcastId) {
      const replayed = await this.buildManagedBroadcastIdempotencyResultFromBroadcast(
        existing.broadcastId,
        entityType,
      );
      if (replayed) {
        throw new ManagedBroadcastIdempotencyReplay(replayed);
      }
    }

    const staleClaimBefore = new Date(Date.now() - MANAGED_BROADCAST_LOCK_STALE_MS);
    if (existing.updatedAt <= staleClaimBefore) {
      const released = await this.prisma.managedBroadcastIdempotencyRecord.deleteMany({
        where: {
          id: existing.id,
          broadcastId: null,
          result: { equals: Prisma.DbNull },
          updatedAt: { lte: staleClaimBefore },
        },
      });
      if (released.count > 0) {
        return this.claimManagedBroadcastIdempotencyRecord(
          sourceChatId,
          user,
          request,
          entityType,
          source,
        );
      }
    }

    throw new ServiceUnavailableException('Автопостинг уже запускается. Повторите позже.');
  }

  private async claimManagedBroadcastTestIdempotencyRecord(
    sourceChatId: string,
    user: AuthUser,
    request: PreparedManagedBroadcastRequest,
    entityType: ManagedEntityType,
  ): Promise<{ id: string } | null> {
    if (!request.idempotencyKey || !request.idempotencyHash) {
      return null;
    }

    const prismaEntityType = mapManagedEntityTypeToChatEntityType(entityType);
    const requestHash = createHash('sha256')
      .update(`managed-broadcast-test:${request.idempotencyHash}`)
      .digest('hex');
    const semanticLockKey = [
      'managed-broadcast-test',
      sourceChatId,
      prismaEntityType,
      user.userId,
      requestHash,
    ].join(':');

    return this.prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${semanticLockKey}))
      `;

      const unresolvedSemanticClaim = await tx.managedBroadcastIdempotencyRecord.findFirst({
        where: {
          sourceChatId,
          entityType: prismaEntityType,
          actorUserId: user.userId,
          source: 'broadcast_test',
          requestHash,
          broadcastId: null,
          result: { equals: Prisma.DbNull },
        },
        select: { id: true },
      });
      if (unresolvedSemanticClaim) {
        throw new ServiceUnavailableException({
          code: 'BROADCAST_TEST_RESULT_PENDING',
          message: 'Результат тестовой отправки не подтверждён.',
        });
      }

      try {
        return await tx.managedBroadcastIdempotencyRecord.create({
          data: {
            requestId: request.idempotencyKey,
            requestHash,
            sourceChatId,
            entityType: prismaEntityType,
            actorUserId: user.userId,
            source: 'broadcast_test',
          },
          select: { id: true },
        });
      } catch (error: unknown) {
        if (!isPrismaKnownError(error, 'P2002')) {
          throw error;
        }
      }

      const existing = await tx.managedBroadcastIdempotencyRecord.findUnique({
        where: {
          sourceChatId_entityType_actorUserId_requestId: {
            sourceChatId,
            entityType: prismaEntityType,
            actorUserId: user.userId,
            requestId: request.idempotencyKey,
          },
        },
      });
      if (!existing) {
        throw new ServiceUnavailableException('Тестовая отправка уже запускается.');
      }
      if (existing.requestHash !== requestHash) {
        throw new BadRequestException('Ключ повтора уже использован для другой операции.');
      }

      const cachedResult = this.readManagedBroadcastTestIdempotencyResult(existing.result);
      if (cachedResult) {
        throw new ManagedBroadcastTestIdempotencyReplay(cachedResult);
      }

      // The MAX send may have completed even when its response was lost. Keeping this claim
      // quarantines an uncertain test instead of automatically sending a duplicate later.
      throw new ServiceUnavailableException({
        code: 'BROADCAST_TEST_RESULT_PENDING',
        message: 'Результат тестовой отправки не подтверждён.',
      });
    });
  }

  private readManagedBroadcastTestIdempotencyResult(
    value: unknown,
  ): SendBroadcastTestResult | null {
    if (value === null || value === undefined || value === Prisma.DbNull) {
      return null;
    }

    const parsed = sendBroadcastTestResultSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  private async persistManagedBroadcastTestIdempotencyResult(
    idempotencyRecordId: string | null,
    result: SendBroadcastTestResult,
  ): Promise<void> {
    if (!idempotencyRecordId) {
      return;
    }

    await this.prisma.managedBroadcastIdempotencyRecord.update({
      where: { id: idempotencyRecordId },
      data: { result: result as Prisma.InputJsonValue },
    });
  }

  private readManagedBroadcastIdempotencyResult(value: unknown): SendBroadcastResult | null {
    if (value === null || value === undefined || value === Prisma.DbNull) {
      return null;
    }

    const parsed = sendBroadcastResultSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  private async buildManagedBroadcastIdempotencyResultFromBroadcast(
    broadcastId: string,
    entityType: ManagedEntityType,
  ): Promise<SendBroadcastResult | null> {
    const row = await this.prisma.managedBroadcast.findUnique({
      where: { id: broadcastId },
    });
    if (!row) {
      return null;
    }

    const targetChatIds = parseManagedBroadcastTargetChatIds(row.targetChatIds, row.sourceChatId);
    const [snapshot, upcomingSlots, targetPreviewBundle] = await Promise.all([
      this.getManagedBroadcastDeliverySnapshot(row),
      this.getManagedBroadcastUpcomingSlots(row),
      this.getManagedBroadcastTargetPreviewBundle(targetChatIds, entityType),
    ]);
    const details = this.mapManagedBroadcastDetails(
      row,
      snapshot,
      upcomingSlots,
      targetPreviewBundle,
    );
    return sendBroadcastResultSchema.parse({
      sourceChatId: row.sourceChatId,
      targetChats: targetChatIds.length,
      sentChats: snapshot.deliveredChats,
      failedChats: snapshot.failedChats,
      sentChatIds: [],
      failedChatIds: [],
      sentChatPreviews: [],
      failedChatPreviews: [],
      sentChatOverflowCount: 0,
      failedChatOverflowCount: 0,
      scheduleMode: details.scheduleMode,
      scheduleTimezone: details.scheduleTimezone,
      scheduledSlots: details.scheduledSlots,
      sendAt: row.nextSendAt?.toISOString() ?? null,
      nextSendAt: details.nextSendAt,
      cycleEnabled: details.cycleEnabled,
      cycleEveryHours: details.cycleEveryHours,
      cycleCount: details.cycleCount,
      scheduleId: row.id,
      scheduledOccurrences: upcomingSlots.length,
    });
  }

  private async persistManagedBroadcastIdempotencyResult(
    idempotencyRecordId: string | null,
    result: SendBroadcastResult,
  ): Promise<void> {
    if (!idempotencyRecordId) {
      return;
    }

    await this.prisma.managedBroadcastIdempotencyRecord.update({
      where: { id: idempotencyRecordId },
      data: {
        broadcastId: result.scheduleId,
        result: result as Prisma.InputJsonValue,
      },
    });
  }

  private async releaseManagedBroadcastIdempotencyRecord(
    idempotencyRecordId: string | null,
  ): Promise<void> {
    if (!idempotencyRecordId) {
      return;
    }

    await this.prisma.managedBroadcastIdempotencyRecord.deleteMany({
      where: {
        id: idempotencyRecordId,
        broadcastId: null,
        result: { equals: Prisma.DbNull },
      },
    });
  }

  private async prepareManagedBroadcastRequest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    options: {
      entityType: ManagedEntityType;
      resolveTargets?: (user: AuthUser) => Promise<ChatSummary[]>;
      trustedPublicationTestPayload?: boolean;
    },
  ): Promise<PreparedManagedBroadcastRequest> {
    await this.assertManagedEntityAdminAccess(sourceChatId, user.userId, options.entityType);

    const parsed = options.trustedPublicationTestPayload
      ? safeParseTrustedPublicationTestBroadcastRequest(body)
      : sendBroadcastRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    this.mediaRuntime.validateManagedBroadcastMediaPayload(parsed.data, {
      trustedPublicationTestPayload: options.trustedPublicationTestPayload,
    });

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
      idempotencyKey: parsed.data.requestId ?? null,
      idempotencyHash: parsed.data.requestId
        ? this.createManagedBroadcastIdempotencyHash(parsed.data, targetChatIds, options.entityType)
        : null,
    };
  }

  private async sendManagedBroadcastViaQueue(
    sourceChatId: string,
    user: AuthUser,
    request: PreparedManagedBroadcastRequest,
    entityType: ManagedEntityType,
    source: AdminActionSource,
  ): Promise<SendBroadcastResult> {
    if (process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException(
        'Legacy direct managed broadcast dispatch is disabled in production',
      );
    }
    const scheduledAt = parseManagedBroadcastSendAt(request.payload.sendAt, {
      required: false,
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

    const maxApiOptions = this.mediaRuntime.resolveManagedBroadcastSourceMaxApiOptions(source);
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
          await this.mediaRuntime.resolveManagedBroadcastMedia(
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
            hasRetriableManagedBroadcastAttachment(message.messageOptions)
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

    const legacyCycleEveryDays = toLegacyCycleEveryDays(cycleEveryHours);
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
    const sentChatPreviewBundle = buildManagedBroadcastTargetPreviewBundle(
      sentChatIds,
      targetPreviewMap,
      entityType,
    );
    const failedChatPreviewBundle = buildManagedBroadcastTargetPreviewBundle(
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
    idempotencyRecordId: string | null = null,
  ): Promise<SendBroadcastResult> {
    const schedulePlan = await planManagedBroadcastSchedule(request.payload, 0);
    const buttonState = this.buildManagedBroadcastButtonState(request.payload.buttons);
    const nextOccurrenceIndex = schedulePlan.sentCount + 1;
    const isCalendarPlanComplete =
      schedulePlan.scheduleMode === 'calendar' && schedulePlan.upcomingSlots.length === 0;

    const created = await this.runManagedBroadcastCalendarMutationWithRetry(async (tx: any) => {
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

      if (idempotencyRecordId) {
        await tx.managedBroadcastIdempotencyRecord.update({
          where: { id: idempotencyRecordId },
          data: { broadcastId: createdBroadcast.id },
        });
      }

      if (schedulePlan.sentCount < schedulePlan.cycleCount) {
        await tx.managedBroadcastDelivery.createMany({
          data: buildManagedBroadcastDeliveryRows(
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

    const legacyCycleEveryDays = toLegacyCycleEveryDays(schedulePlan.cycleEveryHours);
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
    const sentChatPreviewBundle = buildManagedBroadcastTargetPreviewBundle(
      occurrence.sentChatIds,
      targetPreviewMap,
      entityType,
    );
    const failedChatPreviewBundle = buildManagedBroadcastTargetPreviewBundle(
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
    reason: 'startup' | 'scheduled' | 'manual_retry' | 'immediate' | 'deadline',
    staleLockBefore: Date,
    allowedStatuses: PrismaManagedBroadcastStatus[],
    preclaimedLease?: ManagedBroadcastLease,
    publicationVerificationBudget?: ManagedBroadcastPublicationVerificationBudget,
  ): Promise<BroadcastOccurrenceResult> {
    const claimedAt = preclaimedLease?.lockedAt ?? new Date();
    const claimToken = preclaimedLease?.lockToken ?? this.createManagedBroadcastLockToken();
    let lease = preclaimedLease ?? null;
    if (!lease) {
      const claim = await this.prisma.managedBroadcast.updateMany({
        where: {
          id: broadcastId,
          status: { in: allowedStatuses },
          nextSendAt: { lte: claimedAt },
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
        },
        data: {
          lockedAt: claimedAt,
          lockToken: claimToken,
        },
      });
      if (claim.count === 0) {
        const row = await this.prisma.managedBroadcast.findUnique({
          where: { id: broadcastId },
        });
        return {
          status: row?.status ?? PrismaManagedBroadcastStatus.FAILED,
          currentOccurrence: row ? getCurrentManagedBroadcastOccurrence(row) : 1,
          sentChatIds: [],
          failedChatIds: [],
          pendingChatIds: [],
          canRetry: false,
          firstSendError: null,
          nextSendAt: row?.nextSendAt ?? null,
        };
      }

      lease = {
        lockedAt: claimedAt,
        lockToken: claimToken,
        lastHeartbeatAt: claimedAt,
      };
    }

    const activeLease = lease;
    const row = await this.prisma.managedBroadcast.findUnique({
      where: { id: broadcastId },
    });
    if (!row || !row.nextSendAt || !allowedStatuses.includes(row.status)) {
      await this.prisma.managedBroadcast.updateMany({
        where: { id: broadcastId, lockToken: activeLease.lockToken },
        data: { lockedAt: null, lockToken: null },
      });
      return {
        status: row?.status ?? PrismaManagedBroadcastStatus.FAILED,
        currentOccurrence: row ? getCurrentManagedBroadcastOccurrence(row) : 1,
        sentChatIds: [],
        failedChatIds: [],
        pendingChatIds: [],
        canRetry: false,
        firstSendError: null,
        nextSendAt: row?.nextSendAt ?? null,
      };
    }

    const currentOccurrence = getCurrentManagedBroadcastOccurrence(row);
    const maxApiOptions = this.mediaRuntime.resolveManagedBroadcastProcessingMaxApiOptions(reason);
    if (
      !(await this.ensureManagedBroadcastPublicationExecutionActive(
        row,
        currentOccurrence,
        staleLockBefore,
      ))
    ) {
      return {
        status: PrismaManagedBroadcastStatus.CANCELED,
        currentOccurrence,
        sentChatIds: [],
        failedChatIds: [],
        pendingChatIds: [],
        canRetry: false,
        firstSendError: null,
        nextSendAt: null,
      };
    }

    try {
      await this.reconcileStaleManagedBroadcastDeliveries(
        row.id,
        currentOccurrence,
        staleLockBefore,
      );
      if (
        await this.deferManagedBroadcastOccurrenceWithFreshSendingDeliveries(
          row.id,
          currentOccurrence,
          activeLease,
        )
      ) {
        return {
          status: PrismaManagedBroadcastStatus.ACTIVE,
          currentOccurrence,
          sentChatIds: [],
          failedChatIds: [],
          pendingChatIds: [],
          canRetry: false,
          firstSendError: null,
          nextSendAt: row.nextSendAt,
        };
      }
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
      const requestMedia = await this.mediaRuntime.loadManagedBroadcastRequestMedia(row);

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
          ...requestMedia,
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
        idempotencyKey: null,
        idempotencyHash: null,
      };
      if (!this.maxRoutedPublicationService && process.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException(
          'Routed MAX publication service is required for production managed broadcasts',
        );
      }

      const sentChatIds: string[] = [];
      const failedChatIds: string[] = [];
      let firstSendError: unknown = null;
      const markDeliverySentInMemory = async (
        delivery: any,
        sentMessage: MaxPublishedMessage,
        commentDialogReference: ManagedBroadcastCommentDialogReference | null,
      ) => {
        if (!sentChatIds.includes(delivery.targetChatId)) {
          sentChatIds.push(delivery.targetChatId);
        }

        try {
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
        } catch (error: unknown) {
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
            'Managed broadcast comment dialog reference sync failed after successful send',
          );
        }
      };

      if (reason === 'startup' || reason === 'scheduled') {
        initialDeliveries = await this.recoverManagedBroadcastDeliveriesForAutomaticRun(
          row.id,
          currentOccurrence,
          initialDeliveries,
        );
      }

      const recoveredUnconfirmedChatIds = await this.publicationVerification.verifyAfterSend(
        row,
        currentOccurrence,
        maxApiOptions,
        () => this.heartbeatManagedBroadcastProcessingLock(row.id, currentOccurrence, activeLease),
        publicationVerificationBudget,
      );
      if (recoveredUnconfirmedChatIds.size > 0) {
        initialDeliveries = await this.prisma.managedBroadcastDelivery.findMany({
          where: {
            broadcastId: row.id,
            occurrenceIndex: currentOccurrence,
          },
          orderBy: [{ targetChatId: 'asc' }],
        });
      }

      const fatalRecoveredDelivery = initialDeliveries.find((delivery: any) => {
        if (delivery.status !== PrismaManagedBroadcastDeliveryStatus.FAILED) {
          return false;
        }
        return resolveManagedBroadcastFatalProcessingFailureMessage(delivery.lastError) !== null;
      });
      if (fatalRecoveredDelivery) {
        const fatalProcessingErrorMessage =
          resolveManagedBroadcastFatalProcessingFailureMessage(fatalRecoveredDelivery.lastError) ??
          'Не удалось обработать автопостинг.';
        await this.failManagedBroadcastAfterFatalProcessingError(
          row,
          currentOccurrence,
          fatalProcessingErrorMessage,
          activeLease,
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
        return this.finalizeManagedBroadcastOccurrence(row, currentOccurrence, [], [], null, {
          lease: activeLease,
        });
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
          const heartbeatProgress = () =>
            this.heartbeatManagedBroadcastProcessingLock(row.id, currentOccurrence, activeLease);
          mediaByBotId.set(
            cacheKey,
            await this.mediaRuntime.resolveManagedBroadcastMedia(
              request.payload,
              row.entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
              row.sourceChatId,
              row.actorUserId,
              botId,
              maxApiOptions,
              heartbeatProgress,
              {
                trustedPublicationVideoMarkers: Boolean(row.publicationContentRevisionId),
              },
            ),
          );
        }

        return mediaByBotId.get(cacheKey) ?? {};
      };
      const sendDeliveryWithBot = async (
        targetChatId: string,
        botId: string | undefined,
      ): Promise<{
        sentMessage: MaxPublishedMessage;
        commentDialogReference: ManagedBroadcastCommentDialogReference | null;
        botId: string | null;
      } | null> => {
        let message: Awaited<ReturnType<typeof this.buildManagedBroadcastMessage>>;
        try {
          await this.heartbeatManagedBroadcastProcessingLock(
            row.id,
            currentOccurrence,
            activeLease,
          );
          const media = await resolveMedia(botId);
          message = await this.buildManagedBroadcastMessage(
            targetChatId,
            row.entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
            request.payload,
            request.normalizedSourceText,
            media,
            botId,
          );
          if (
            !(await this.ensureManagedBroadcastPublicationExecutionActive(row, currentOccurrence))
          ) {
            return null;
          }
        } catch (error: unknown) {
          throw markManagedBroadcastSendPhase(error, false);
        }

        try {
          const sentMessage = await this.sendManagedBroadcastMessageImmediateWithId(
            targetChatId,
            message.messageText,
            message.messageOptions,
            botId,
            maxApiOptions,
            () =>
              this.heartbeatManagedBroadcastProcessingLock(row.id, currentOccurrence, activeLease),
          );
          return {
            sentMessage,
            commentDialogReference: message.commentDialogReference,
            botId: botId ?? null,
          };
        } catch (error: unknown) {
          throw markManagedBroadcastSendPhase(error, true);
        }
      };
      const sendDeliveryRouted = async (
        delivery: PersistedManagedBroadcastDelivery,
        deliveryAttemptCount: number,
        deliveryLockToken: string,
        onBotSelected: (botId: string) => void,
      ): Promise<{
        sentMessage: MaxRoutedPublicationResult;
        commentDialogReference: ManagedBroadcastCommentDialogReference | null;
        botId: string;
      }> => {
        const routedPublicationService = this.maxRoutedPublicationService;
        if (!routedPublicationService) {
          throw new Error('Routed MAX publication service is unavailable');
        }
        const commentDialogReferencesByBotId = new Map<
          string,
          ManagedBroadcastCommentDialogReference | null
        >();
        const logicalIdempotencyKey = this.buildManagedBroadcastDeliveryActionKey(
          row,
          currentOccurrence,
          delivery.targetChatId,
          deliveryAttemptCount,
        );
        const maxSendOptions =
          this.mediaRuntime.buildManagedBroadcastMaxApiRequestOptions(maxApiOptions);
        const attempts =
          Math.max(
            BROADCAST_VIDEO_SEND_RETRY_DELAYS_MS.length,
            BROADCAST_THROTTLE_RETRY_DELAYS_MS.length,
          ) + 1;
        let lastError: unknown = null;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          let sendStarted = false;
          let preparedOptions: MaxSendMessageOptions | undefined;
          try {
            const sentMessage = await routedPublicationService.publish({
              entityId: delivery.targetChatId,
              logicalIdempotencyKey,
              text: request.normalizedSourceText || ' ',
              trafficClass: maxSendOptions.trafficClass ?? 'interactive',
              actionHealthLane: maxSendOptions.actionHealthLane,
              sourceTag: maxSendOptions.sourceTag ?? MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
              ...(row.publicationOccurrenceId
                ? { sendRouteHalfOpenProbe: 'publication_exact_verification' as const }
                : {}),
              prepareAttempt: async ({ botId }) => {
                onBotSelected(botId);
                await this.heartbeatManagedBroadcastProcessingLock(
                  row.id,
                  currentOccurrence,
                  activeLease,
                );
                const persistedCandidate = await this.prisma.managedBroadcastDelivery.updateMany({
                  where: {
                    id: delivery.id,
                    status: PrismaManagedBroadcastDeliveryStatus.SENDING,
                    lockToken: deliveryLockToken,
                  },
                  data: { botId },
                });
                if (persistedCandidate.count === 0) {
                  throw new ServiceUnavailableException(
                    'Managed broadcast delivery lock was lost before MAX dispatch',
                  );
                }
                const media = await resolveMedia(botId);
                const message = await this.buildManagedBroadcastMessage(
                  delivery.targetChatId,
                  row.entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
                  request.payload,
                  request.normalizedSourceText,
                  media,
                  botId,
                );
                commentDialogReferencesByBotId.set(botId, message.commentDialogReference);
                preparedOptions = message.messageOptions;
                if (
                  !(await this.ensureManagedBroadcastPublicationExecutionActive(
                    row,
                    currentOccurrence,
                  ))
                ) {
                  throw new ManagedBroadcastPublicationExecutionStopped();
                }
                return {
                  text: message.messageText,
                  options: message.messageOptions,
                  ledgerContext: buildManagedBroadcastLedgerContext(message.commentDialogReference),
                };
              },
              onDispatchAttempt: ({ botId }) => {
                sendStarted = true;
                onBotSelected(botId);
                resolvedBotIdsByChatId.set(delivery.targetChatId, botId);
              },
            });
            let commentDialogReference =
              commentDialogReferencesByBotId.get(sentMessage.botId) ?? null;
            let hasCommentDialogReference = commentDialogReferencesByBotId.has(sentMessage.botId);
            if (!hasCommentDialogReference) {
              const recoveredContext =
                await this.loadManagedBroadcastLedgerCommentDialogContext(logicalIdempotencyKey);
              if (recoveredContext.found) {
                hasCommentDialogReference = true;
                commentDialogReference = recoveredContext.reference;
              }
            }
            if (!hasCommentDialogReference) {
              this.logger.warn(
                {
                  broadcastId: row.id,
                  occurrenceIndex: currentOccurrence,
                  deliveryId: delivery.id,
                  targetChatId: delivery.targetChatId,
                  botId: sentMessage.botId,
                  messageId: sentMessage.messageId,
                },
                'Skipped managed broadcast dialog binding recovery because the exact sent context was not persisted',
              );
            }
            return {
              sentMessage,
              commentDialogReference,
              botId: sentMessage.botId,
            };
          } catch (error: unknown) {
            lastError = error;
            if (error instanceof ManagedBroadcastPublicationExecutionStopped) {
              throw error;
            }
            if (sendStarted && isAmbiguousMaxSendError(error)) {
              throw markManagedBroadcastSendPhase(error, true);
            }
            const retryDelayMs = this.resolveManagedBroadcastSendRetryDelayMs(
              error,
              attempt,
              preparedOptions,
            );
            if (retryDelayMs === null) {
              throw markManagedBroadcastSendPhase(error, sendStarted);
            }
            await this.heartbeatManagedBroadcastProcessingLock(
              row.id,
              currentOccurrence,
              activeLease,
            );
            await sleep(retryDelayMs);
          }
        }

        throw markManagedBroadcastSendPhase(
          lastError ?? new Error('Managed broadcast routed send did not return a result'),
          false,
        );
      };

      const automaticDeliveryQuantum =
        reason === 'startup' || reason === 'scheduled' || reason === 'deadline'
          ? MANAGED_BROADCAST_AUTOMATIC_DELIVERY_QUANTUM
          : Number.POSITIVE_INFINITY;
      const deliveryCandidates = selectManagedBroadcastDeliveryCandidates(
        initialDeliveries,
        Boolean(row.publicationOccurrenceId),
      );
      let claimedDeliveryCount = 0;
      let pendingNotBefore: Date | null = null;
      for (const delivery of deliveryCandidates) {
        if (delivery.status !== PrismaManagedBroadcastDeliveryStatus.PENDING) {
          continue;
        }
        if (claimedDeliveryCount >= automaticDeliveryQuantum) {
          break;
        }

        if (
          !(await this.ensureManagedBroadcastPublicationExecutionActive(row, currentOccurrence))
        ) {
          return {
            status: PrismaManagedBroadcastStatus.CANCELED,
            currentOccurrence,
            sentChatIds,
            failedChatIds,
            pendingChatIds: [],
            canRetry: false,
            firstSendError,
            nextSendAt: null,
          };
        }

        await this.heartbeatManagedBroadcastProcessingLock(row.id, currentOccurrence, activeLease);
        const deliveryAttemptCount = delivery.attemptCount + 1;
        const deliveryLockToken = this.createManagedBroadcastLockToken();
        const deliveryClaim = await this.prisma.managedBroadcastDelivery.updateMany({
          where: {
            id: delivery.id,
            status: PrismaManagedBroadcastDeliveryStatus.PENDING,
          },
          data: {
            status: PrismaManagedBroadcastDeliveryStatus.SENDING,
            lockedAt: activeLease.lockedAt,
            lockToken: deliveryLockToken,
            attemptCount: { increment: 1 },
          },
        });
        if (deliveryClaim.count === 0) {
          continue;
        }
        claimedDeliveryCount += 1;

        let sentMessage: MaxPublishedMessage | null = null;
        let resolvedBotId: string | undefined;
        let commentDialogReference: ManagedBroadcastCommentDialogReference | null = null;
        try {
          await this.heartbeatManagedBroadcastProcessingLock(
            row.id,
            currentOccurrence,
            activeLease,
          );
          const deliveryAttempt = this.maxRoutedPublicationService
            ? await sendDeliveryRouted(
                delivery,
                deliveryAttemptCount,
                deliveryLockToken,
                (botId) => {
                  resolvedBotId = botId;
                },
              )
            : await (async () => {
                resolvedBotId = await resolveTargetBotId(delivery.targetChatId);
                await this.prisma.managedBroadcastDelivery.updateMany({
                  where: {
                    id: delivery.id,
                    status: PrismaManagedBroadcastDeliveryStatus.SENDING,
                    lockToken: deliveryLockToken,
                  },
                  data: {
                    botId: resolvedBotId ?? null,
                  },
                });
                return sendDeliveryWithBot(delivery.targetChatId, resolvedBotId);
              })();
          if (!deliveryAttempt) {
            await cancelPublicationDeliveryBeforeStoppedDispatch(
              this.prisma,
              delivery.id,
              deliveryLockToken,
            );
            return {
              status: PrismaManagedBroadcastStatus.CANCELED,
              currentOccurrence,
              sentChatIds,
              failedChatIds,
              pendingChatIds: [],
              canRetry: false,
              firstSendError,
              nextSendAt: null,
            };
          }
          sentMessage = deliveryAttempt.sentMessage;
          commentDialogReference = deliveryAttempt.commentDialogReference;
          resolvedBotId = deliveryAttempt.botId ?? undefined;
        } catch (error: unknown) {
          if (error instanceof ManagedBroadcastPublicationExecutionStopped) {
            await cancelPublicationDeliveryBeforeStoppedDispatch(
              this.prisma,
              delivery.id,
              deliveryLockToken,
            );
            return {
              status: PrismaManagedBroadcastStatus.CANCELED,
              currentOccurrence,
              sentChatIds,
              failedChatIds,
              pendingChatIds: [],
              canRetry: false,
              firstSendError,
              nextSendAt: null,
            };
          }
          const routeQuarantineDeferredUntil = await deferPublicationDeliveryAfterRouteQuarantine({
            context: this.context,
            row,
            delivery,
            occurrenceIndex: currentOccurrence,
            broadcastLockToken: activeLease.lockToken,
            deliveryLockToken,
            error,
          });
          if (routeQuarantineDeferredUntil) {
            pendingNotBefore = resolveEarlierDate(pendingNotBefore, routeQuarantineDeferredUntil);
            continue;
          }
          if (
            await deferPublicationDeliveryAfterPreDispatchThrottle({
              context: this.context,
              row,
              delivery,
              reason,
              occurrenceIndex: currentOccurrence,
              deliveryLockToken,
              error,
            })
          ) {
            break;
          }
          let effectiveError = error;
          let deliveryFailureMessage =
            this.extractMaxApiErrorMessage(error) ||
            (error instanceof Error && error.message.trim()
              ? error.message
              : 'Не удалось отправить сообщение.');
          const fatalProcessingErrorMessage =
            resolveManagedBroadcastFatalProcessingErrorMessage(error);
          if (fatalProcessingErrorMessage) {
            await this.failManagedBroadcastAfterFatalProcessingError(
              row,
              currentOccurrence,
              fatalProcessingErrorMessage,
              activeLease,
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
          const routedAccessLossRecorded =
            Boolean(error) &&
            typeof error === 'object' &&
            (error as { maxManagedEntityAccessLossRecorded?: unknown })
              .maxManagedEntityAccessLossRecorded === true;
          if (this.maxRoutedPublicationService && routedAccessLossRecorded) {
            await cancelManagedBroadcastTargetDeliveries(this.prisma, row.id, currentOccurrence, {
              targetChatId: delivery.targetChatId,
              currentDeliveryId: delivery.id,
              currentDeliveryLockToken: deliveryLockToken,
              lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
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
                err: deliveryFailureMessage,
              },
              'Managed broadcast target lost MAX access with no surviving routed bot',
            );
            continue;
          }
          const accessLossResult = this.maxRoutedPublicationService
            ? null
            : await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost?.({
                chatId: delivery.targetChatId,
                botId: resolvedBotId ?? null,
                entityType: row.entityType,
                source: 'managed_broadcast:delivery',
                operation: 'send',
                error,
              });
          if (accessLossResult?.recorded) {
            const failedBotIds = new Set<string>(resolvedBotId ? [resolvedBotId] : []);
            let replacementBotId = accessLossResult.recorded.nextOwnerBotId ?? undefined;
            let replacementAccessResult = accessLossResult;

            while (replacementBotId && !failedBotIds.has(replacementBotId)) {
              failedBotIds.add(replacementBotId);
              resolvedBotId = replacementBotId;
              resolvedBotIdsByChatId.set(delivery.targetChatId, replacementBotId);
              await this.prisma.managedBroadcastDelivery.updateMany({
                where: {
                  id: delivery.id,
                  status: PrismaManagedBroadcastDeliveryStatus.SENDING,
                  lockToken: deliveryLockToken,
                },
                data: { botId: replacementBotId },
              });

              try {
                const replacementAttempt = await sendDeliveryWithBot(
                  delivery.targetChatId,
                  replacementBotId,
                );
                if (!replacementAttempt) {
                  await cancelPublicationDeliveryBeforeStoppedDispatch(
                    this.prisma,
                    delivery.id,
                    deliveryLockToken,
                  );
                  return {
                    status: PrismaManagedBroadcastStatus.CANCELED,
                    currentOccurrence,
                    sentChatIds,
                    failedChatIds,
                    pendingChatIds: [],
                    canRetry: false,
                    firstSendError,
                    nextSendAt: null,
                  };
                }
                sentMessage = replacementAttempt.sentMessage;
                commentDialogReference = replacementAttempt.commentDialogReference;
                this.logger.warn(
                  {
                    sourceChatId: row.sourceChatId,
                    broadcastId: row.id,
                    targetChatId: delivery.targetChatId,
                    failedBotIds: [...failedBotIds].slice(0, -1),
                    survivorBotId: replacementBotId,
                    occurrenceIndex: currentOccurrence,
                  },
                  'Managed broadcast delivery recovered through surviving MAX bot',
                );
                break;
              } catch (replacementError: unknown) {
                effectiveError = replacementError;
                deliveryFailureMessage =
                  this.extractMaxApiErrorMessage(replacementError) ||
                  (replacementError instanceof Error && replacementError.message.trim()
                    ? replacementError.message
                    : 'Не удалось отправить сообщение.');
                if (isAmbiguousManagedBroadcastSendError(replacementError)) {
                  replacementBotId = undefined;
                  break;
                }
                replacementAccessResult =
                  (await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost?.({
                    chatId: delivery.targetChatId,
                    botId: replacementBotId,
                    entityType: row.entityType,
                    source: 'managed_broadcast:delivery_failover',
                    operation: 'send',
                    error: replacementError,
                  })) ?? replacementAccessResult;
                replacementBotId = replacementAccessResult.recorded?.nextOwnerBotId ?? undefined;
              }
            }

            if (!sentMessage && !replacementAccessResult.recorded?.nextOwnerBotId) {
              await cancelManagedBroadcastTargetDeliveries(this.prisma, row.id, currentOccurrence, {
                targetChatId: delivery.targetChatId,
                currentDeliveryId: delivery.id,
                currentDeliveryLockToken: deliveryLockToken,
                lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
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
                  reason: replacementAccessResult.reason,
                  err: deliveryFailureMessage,
                },
                'Managed broadcast target lost MAX access with no surviving bot',
              );
              continue;
            }
          }
          if (
            !sentMessage &&
            (!this.maxRoutedPublicationService ||
              (error as { managedBroadcastSendStarted?: unknown })?.managedBroadcastSendStarted ===
                true) &&
            isManagedBroadcastPermanentTargetDeliveryFailure(effectiveError, deliveryFailureMessage)
          ) {
            await cancelManagedBroadcastTargetDeliveries(this.prisma, row.id, currentOccurrence, {
              targetChatId: delivery.targetChatId,
              currentDeliveryId: delivery.id,
              currentDeliveryLockToken: deliveryLockToken,
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
          } else if (!sentMessage) {
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
              await cancelManagedBroadcastTargetDeliveries(this.prisma, row.id, currentOccurrence, {
                targetChatId: delivery.targetChatId,
                currentDeliveryId: delivery.id,
                currentDeliveryLockToken: deliveryLockToken,
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
              firstSendError = effectiveError;
            }
            failedChatIds.push(delivery.targetChatId);
            this.logger.warn(
              {
                sourceChatId: row.sourceChatId,
                broadcastId: row.id,
                targetChatId: delivery.targetChatId,
                actorUserId: row.actorUserId,
                occurrenceIndex: currentOccurrence,
                err:
                  effectiveError instanceof Error ? effectiveError.message : String(effectiveError),
              },
              'Managed broadcast delivery failed for target chat',
            );
            const failedDeliveryStatus = isAmbiguousManagedBroadcastSendError(effectiveError)
              ? PrismaManagedBroadcastDeliveryStatus.AMBIGUOUS
              : PrismaManagedBroadcastDeliveryStatus.FAILED;
            await this.prisma.managedBroadcastDelivery.updateMany({
              where: {
                id: delivery.id,
                status: PrismaManagedBroadcastDeliveryStatus.SENDING,
                lockToken: deliveryLockToken,
              },
              data: {
                status: failedDeliveryStatus,
                botId: resolvedBotId ?? null,
                lockedAt: null,
                lockToken: null,
                lastErrorCode: isMaxActionNoExecutableRouteError(effectiveError)
                  ? MAX_ACTION_NO_EXECUTABLE_ROUTE_ERROR_CODE
                  : null,
                lastError: deliveryFailureMessage,
              },
            });
            continue;
          }
        }

        if (!sentMessage) {
          continue;
        }

        const sentAt = new Date();
        const persistedMismatch = await this.publicationVerification.persistResponseTargetMismatch({
          broadcastId: row.id,
          occurrenceIndex: currentOccurrence,
          delivery,
          deliveryLockToken,
          resolvedBotId,
          sentMessage,
          sentAt,
        });
        if (persistedMismatch !== null) {
          if (persistedMismatch && !failedChatIds.includes(delivery.targetChatId)) {
            failedChatIds.push(delivery.targetChatId);
          }
          continue;
        }

        try {
          const persistedSentMessage = await this.prisma.managedBroadcastDelivery.updateMany({
            where: {
              id: delivery.id,
              status: PrismaManagedBroadcastDeliveryStatus.SENDING,
              lockToken: deliveryLockToken,
            },
            data: {
              status: PrismaManagedBroadcastDeliveryStatus.SENT,
              sentAt,
              botId: resolvedBotId ?? null,
              remoteMessageId: sentMessage.messageId,
              ...buildPublicationDeliveryVerificationScheduledData(sentAt),
              legacySentWithoutRemoteId: false,
              lockedAt: null,
              lockToken: null,
              lastErrorCode: null,
              lastError: null,
            },
          });
          if (persistedSentMessage.count === 0) {
            continue;
          }
          await markDeliverySentInMemory(delivery, sentMessage, commentDialogReference);
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
          const fallbackPersistedSentMessage =
            await this.prisma.managedBroadcastDelivery.updateMany({
              where: {
                id: delivery.id,
                lockToken: deliveryLockToken,
              },
              data: {
                status: PrismaManagedBroadcastDeliveryStatus.SENT,
                sentAt,
                botId: resolvedBotId ?? null,
                remoteMessageId: sentMessage.messageId,
                ...buildPublicationDeliveryVerificationScheduledData(sentAt),
                legacySentWithoutRemoteId: false,
                lockedAt: null,
                lockToken: null,
                lastErrorCode: null,
                lastError: null,
              },
            });
          if (fallbackPersistedSentMessage.count === 0) {
            continue;
          }
          await markDeliverySentInMemory(delivery, sentMessage, commentDialogReference);
          continue;
        }
      }

      const unconfirmedChatIds = await this.publicationVerification.verifyAfterSend(
        row,
        currentOccurrence,
        maxApiOptions,
        () => this.heartbeatManagedBroadcastProcessingLock(row.id, currentOccurrence, activeLease),
        publicationVerificationBudget,
      );
      for (const chatId of unconfirmedChatIds) {
        const sentIndex = sentChatIds.indexOf(chatId);
        if (sentIndex >= 0) {
          sentChatIds.splice(sentIndex, 1);
        }
        if (!failedChatIds.includes(chatId)) {
          failedChatIds.push(chatId);
        }
      }

      return this.finalizeManagedBroadcastOccurrence(
        row,
        currentOccurrence,
        sentChatIds,
        failedChatIds,
        firstSendError,
        { lease: activeLease, pendingNotBefore },
      );
    } catch (error: unknown) {
      const fatalProcessingErrorMessage = resolveManagedBroadcastFatalProcessingErrorMessage(error);
      if (fatalProcessingErrorMessage) {
        await this.failManagedBroadcastAfterFatalProcessingError(
          row,
          currentOccurrence,
          fatalProcessingErrorMessage,
          activeLease,
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
      const updated = await this.updateManagedBroadcastIfNotCanceled(
        row.id,
        {
          status: PrismaManagedBroadcastStatus.FAILED,
          lastError:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : 'Не удалось обработать автопостинг.',
          lockedAt: null,
          lockToken: null,
        },
        activeLease,
      );
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

  private async ensureManagedBroadcastPublicationExecutionActive(
    row: PersistedManagedBroadcast,
    currentOccurrence: number,
    staleLockBefore?: Date,
  ): Promise<boolean> {
    return ensurePublicationExecutionActive({
      prisma: this.prisma,
      row,
      occurrenceIndex: currentOccurrence,
      ...(staleLockBefore
        ? {
            reconcileStaleDeliveries: () =>
              this.reconcileStaleManagedBroadcastDeliveries(
                row.id,
                currentOccurrence,
                staleLockBefore,
              ),
          }
        : {}),
    });
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
    const baseMessageText = shouldUseRichText
      ? renderSupportedMarkdownAsHtml(normalizedSourceText, { blockMode: 'raw' })
      : hasMeaningfulText
        ? normalizedSourceText
        : hasMedia
          ? ' '
          : '';
    const baseTextFormat: MaxSendMessageOptions['textFormat'] = shouldUseRichText
      ? 'html'
      : undefined;
    const preparedText = this.channelPostSignatureService
      ? await this.channelPostSignatureService.preparePostText(
          chatId,
          { text: baseMessageText, ...(baseTextFormat ? { textFormat: baseTextFormat } : {}) },
          {
            entityType,
            trafficClass: 'background',
            sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
          },
        )
      : { text: baseMessageText, textFormat: baseTextFormat, signatureApplied: false };
    const messageText = preparedText.text;
    const textFormat = preparedText.textFormat;
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
    if (!messageId || (!reference?.includeCommentsButton && !reference?.includeSuggestButton)) {
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
      ...(reference.customButtons.length > 0 ? { customButtons: reference.customButtons } : {}),
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

    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtext('publication-calendar'))
    `);

    const rows = buildManagedBroadcastOccurrenceRows(
      options.broadcastId,
      options.sourceChatId,
      options.entityType,
      options.fromOccurrenceIndex,
      options.slots,
    );
    const reservationRows = buildManagedBroadcastCalendarReservationRows(
      options.broadcastId,
      options.sourceChatId,
      options.entityType,
      options.fromOccurrenceIndex,
      options.slots,
      options.targetChatIds,
    );

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

    await tx.managedBroadcastOccurrence.createMany({
      data: rows,
    });
    if (reservationRows.length > 0) {
      await tx.managedBroadcastCalendarReservation.createMany({
        data: reservationRows,
      });
    }
  }

  private async runManagedBroadcastCalendarMutationWithRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) => operation(tx));
      } catch (error: unknown) {
        if (!this.isManagedBroadcastSlotConflictError(error) || attempt > 0) {
          throw error;
        }
      }
    }

    throw new ServiceUnavailableException('Календарь автопостинга обновился. Повторите действие.');
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
    const targetChatIds = normalizeManagedBroadcastTargetChatIds(options.targetChatIds);
    if (targetChatIds.length === 0 || options.slots.length === 0) {
      return;
    }

    const [reservations, publicationOccurrences] = await Promise.all([
      tx.managedBroadcastCalendarReservation.findMany({
        where: {
          entityType: options.entityType,
          targetChatId: { in: targetChatIds },
          scheduledAt: {
            in: options.slots,
          },
          ...(options.excludeBroadcastId
            ? { broadcastId: { not: options.excludeBroadcastId } }
            : {}),
        },
        select: {
          broadcastId: true,
          scheduledAt: true,
          targetChatId: true,
        },
        orderBy: [{ scheduledAt: 'asc' }],
      }),
      tx.publicationOccurrence.findMany({
        where: {
          scheduledAt: { in: options.slots },
          status: {
            in: [
              PrismaPublicationOccurrenceStatus.SCHEDULED,
              PrismaPublicationOccurrenceStatus.IN_PROGRESS,
            ],
          },
          schedule: {
            is: {
              status: {
                in: [PrismaPublicationScheduleStatus.ACTIVE, PrismaPublicationScheduleStatus.ERROR],
              },
            },
          },
          publication: {
            is: {
              lifecycle: {
                in: [PrismaPublicationLifecycle.ACTIVE, PrismaPublicationLifecycle.ERROR],
              },
              targets: {
                some: {
                  entityType: options.entityType,
                  targetChatId: { in: targetChatIds },
                },
              },
            },
          },
        },
        select: {
          scheduledAt: true,
          scheduleRevision: true,
          schedule: { select: { revision: true } },
          publication: {
            select: {
              targets: {
                where: {
                  entityType: options.entityType,
                  targetChatId: { in: targetChatIds },
                },
                select: { targetChatId: true },
              },
            },
          },
        },
        orderBy: [{ scheduledAt: 'asc' }],
      }),
    ]);

    const conflictSlots = new Set<string>();
    const conflictTargetChatIds = new Set<string>();
    for (const reservation of reservations) {
      conflictSlots.add(reservation.scheduledAt.toISOString());
      conflictTargetChatIds.add(reservation.targetChatId);
    }
    for (const occurrence of publicationOccurrences) {
      if (occurrence.scheduleRevision !== occurrence.schedule.revision) {
        continue;
      }
      conflictSlots.add(occurrence.scheduledAt.toISOString());
      for (const target of occurrence.publication.targets) {
        conflictTargetChatIds.add(target.targetChatId);
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
        broadcast: { is: { publicationOccurrenceId: null } },
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
        publicationOccurrenceId: null,
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

    const currentOccurrence = getCurrentManagedBroadcastOccurrence(row);
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

    const removableOccurrenceIndexes = scheduledOccurrences
      .filter((occurrence) => {
        if (!overwrittenSlotsMs.has(occurrence.scheduledAt.getTime())) {
          return false;
        }
        if (occurrence.occurrenceIndex > currentOccurrence) {
          return true;
        }
        return occurrence.status === PrismaManagedBroadcastStatus.ACTIVE;
      })
      .map((occurrence) => occurrence.occurrenceIndex);
    if (removableOccurrenceIndexes.length === 0) {
      return;
    }

    const preservedOccurrences = scheduledOccurrences.filter(
      (occurrence) => !removableOccurrenceIndexes.includes(occurrence.occurrenceIndex),
    );
    const remainingSlots = preservedOccurrences.map((occurrence) => occurrence.scheduledAt);
    if (remainingSlots.length === scheduledOccurrences.length) {
      return;
    }

    const preservedCurrentOccurrence = preservedOccurrences.find(
      (occurrence) => occurrence.occurrenceIndex === currentOccurrence,
    );
    const nextSendAt = preservedCurrentOccurrence ? row.nextSendAt : (remainingSlots[0] ?? null);
    const nextCycleCount = row.sentCount + remainingSlots.length;
    const targetChatIds = parseManagedBroadcastTargetChatIds(row.targetChatIds, row.sourceChatId);
    const rebuildFromOccurrence = preservedOccurrences.some(
      (occurrence) => occurrence.occurrenceIndex === currentOccurrence,
    )
      ? currentOccurrence + 1
      : currentOccurrence;
    const futureOccurrencesToRebuild = preservedOccurrences.filter(
      (occurrence) => occurrence.occurrenceIndex >= rebuildFromOccurrence,
    );
    const rebuiltFutureOccurrences = futureOccurrencesToRebuild.map((occurrence, index) => ({
      ...occurrence,
      occurrenceIndex: rebuildFromOccurrence + index,
    }));
    await this.assertManagedBroadcastCalendarDeliveriesCanBeDiscarded(
      tx,
      row.id,
      rebuildFromOccurrence,
    );

    await tx.managedBroadcastDelivery.deleteMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: { in: removableOccurrenceIndexes },
      },
    });
    await tx.managedBroadcastCalendarReservation.deleteMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: { in: removableOccurrenceIndexes },
      },
    });
    await tx.managedBroadcastOccurrence.deleteMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: { in: removableOccurrenceIndexes },
      },
    });

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
        lockToken: null,
      },
    });

    if (remainingSlots.length === 0) {
      return;
    }

    await tx.managedBroadcastDelivery.deleteMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: { gte: rebuildFromOccurrence },
      },
    });
    await tx.managedBroadcastCalendarReservation.deleteMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: { gte: rebuildFromOccurrence },
      },
    });
    await tx.managedBroadcastOccurrence.deleteMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: { gte: rebuildFromOccurrence },
      },
    });

    if (rebuildFromOccurrence <= nextCycleCount) {
      await tx.managedBroadcastDelivery.createMany({
        data: buildManagedBroadcastDeliveryRows(
          row.id,
          targetChatIds,
          rebuildFromOccurrence,
          nextCycleCount,
        ),
        skipDuplicates: true,
      });
    }
    if (rebuiltFutureOccurrences.length > 0) {
      await tx.managedBroadcastOccurrence.createMany({
        data: rebuiltFutureOccurrences.map((occurrence) => ({
          broadcastId: row.id,
          sourceChatId: row.sourceChatId,
          entityType: row.entityType,
          occurrenceIndex: occurrence.occurrenceIndex,
          scheduledAt: occurrence.scheduledAt,
          status: occurrence.status,
        })),
      });
      const reservationRows = rebuiltFutureOccurrences.flatMap((occurrence) =>
        buildManagedBroadcastCalendarReservationRows(
          row.id,
          row.sourceChatId,
          row.entityType,
          occurrence.occurrenceIndex,
          [occurrence.scheduledAt],
          targetChatIds,
        ),
      );
      if (reservationRows.length > 0) {
        await tx.managedBroadcastCalendarReservation.createMany({
          data: reservationRows,
          skipDuplicates: true,
        });
      }
    }
  }

  private async assertManagedBroadcastCalendarDeliveriesCanBeDiscarded(
    tx: Prisma.TransactionClient,
    broadcastId: string,
    fromOccurrenceIndex: number,
  ): Promise<void> {
    const protectedDeliveries = await tx.managedBroadcastDelivery.count({
      where: {
        broadcastId,
        occurrenceIndex: { gte: fromOccurrenceIndex },
        status: {
          in: [
            PrismaManagedBroadcastDeliveryStatus.SENDING,
            PrismaManagedBroadcastDeliveryStatus.SENT,
            PrismaManagedBroadcastDeliveryStatus.AMBIGUOUS,
          ],
        },
      },
    });
    if (protectedDeliveries > 0) {
      throw new BadRequestException({
        code: 'BROADCAST_SLOT_DELIVERY_PROTECTED',
        message:
          'Нельзя заменить слот: отправка уже началась, завершилась или требует ручной проверки.',
      });
    }
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
        const currentOccurrence = getCurrentManagedBroadcastOccurrence(row);
        const upcoming = (groupedOccurrences.get(row.id) ?? [])
          .filter((occurrence) => occurrence.occurrenceIndex >= currentOccurrence)
          .map((occurrence) => occurrence.scheduledAt);
        result.set(row.id, upcoming);
        continue;
      }

      result.set(
        row.id,
        buildLegacyManagedBroadcastUpcomingSlots(
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

  private resolveManagedBroadcastTargetsFromRow(row: {
    applyToAllChats: boolean;
    sourceChatId: string;
    targetChatIds: Prisma.JsonValue;
  }): { targetMode: BroadcastTargetMode; targetChatIds: string[] } {
    return resolveManagedBroadcastTargetsFromRowValue(row);
  }

  private async loadManagedBroadcastTargetPreviewMap(
    targetChatIds: readonly string[],
    fallbackEntityType: ManagedEntityType = 'chat',
  ): Promise<Map<string, ManagedBroadcastTargetPreview>> {
    const normalizedIds = normalizeManagedBroadcastTargetChatIds(targetChatIds);
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
          fallbackManagedBroadcastTargetPreview(row.id, entityType).title,
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
          fallbackManagedBroadcastTargetPreview(row.chatId, entityType).title,
        entityType,
        link: this.readTrimmedString(row.link) ?? null,
        avatarUrl: this.readTrimmedString(row.avatarUrl) ?? null,
      });
    }

    for (const chatId of normalizedIds) {
      if (!previews.has(chatId)) {
        previews.set(chatId, fallbackManagedBroadcastTargetPreview(chatId, fallbackEntityType));
      }
    }

    return previews;
  }

  private async getManagedBroadcastTargetPreviewBundle(
    targetChatIds: readonly string[],
    fallbackEntityType: ManagedEntityType = 'chat',
  ): Promise<ManagedBroadcastTargetPreviewBundle> {
    const previewMap = await this.loadManagedBroadcastTargetPreviewMap(
      targetChatIds,
      fallbackEntityType,
    );
    return buildManagedBroadcastTargetPreviewBundle(targetChatIds, previewMap, fallbackEntityType);
  }

  private async getManagedBroadcastTargetPreviewBundles(
    rows: readonly PersistedManagedBroadcast[],
  ): Promise<Map<string, ManagedBroadcastTargetPreviewBundle>> {
    const allTargetChatIds = rows.flatMap((row) =>
      parseManagedBroadcastTargetChatIds(row.targetChatIds, row.sourceChatId),
    );
    const previewMap = await this.loadManagedBroadcastTargetPreviewMap(allTargetChatIds);
    const result = new Map<string, ManagedBroadcastTargetPreviewBundle>();

    for (const row of rows) {
      const fallbackEntityType = fromPrismaEntityType(row.entityType);
      result.set(
        row.id,
        buildManagedBroadcastTargetPreviewBundle(
          parseManagedBroadcastTargetChatIds(row.targetChatIds, row.sourceChatId),
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

  private resolveManagedBroadcastSendRetryDelayMs(
    error: unknown,
    attempt: number,
    options: ManagedBroadcastRetriableAttachmentOptions,
  ): number | null {
    return resolveManagedBroadcastSendRetryDelayMsValue(error, attempt, options);
  }

  private isAttachmentNotReadyError(error: unknown): boolean {
    return isAttachmentNotReadyErrorValue(error);
  }

  private isManagedBroadcastSlotConflictError(error: unknown): boolean {
    return isManagedBroadcastSlotConflictErrorValue(error);
  }

  private decodeBroadcastImageBase64(value: string): Buffer {
    return decodeBroadcastImageBase64Value(value);
  }

  private resolveBroadcastImageFileName(fileName: string, mimeType: string): string {
    return resolveBroadcastImageFileNameValue(fileName, mimeType);
  }

  private normalizeManagedBroadcastButtons(
    rawButtons: unknown,
    legacy?: ManagedBroadcastLegacyButtonState,
  ): BroadcastLinkButton[] {
    return normalizeManagedBroadcastButtonsValue(rawButtons, legacy);
  }

  private buildManagedBroadcastButtonState(
    rawButtons: unknown,
    legacy?: ManagedBroadcastLegacyButtonState,
  ) {
    return buildManagedBroadcastButtonStateValue(rawButtons, legacy);
  }

  private async ensureManagedBroadcastDeliveryRows(
    row: Pick<
      PersistedManagedBroadcast,
      'id' | 'cycleCount' | 'publicationOccurrenceId' | 'publicationContentRevisionId'
    >,
    fromOccurrenceIndex: number,
    targetChatIds: string[],
    deliveries: PersistedManagedBroadcastDelivery[],
  ): Promise<PersistedManagedBroadcastDelivery[]> {
    const normalizedTargetChatIds = normalizeManagedBroadcastTargetChatIds(targetChatIds);
    if (normalizedTargetChatIds.length === 0) {
      return deliveries;
    }

    const cycleCount = Math.max(fromOccurrenceIndex, normalizeManagedBroadcastCycleCount(row));
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
    const missingRows = buildManagedBroadcastDeliveryRows(
      row.id,
      normalizedTargetChatIds,
      fromOccurrenceIndex,
      cycleCount,
    )
      .filter(
        (delivery) => !existingKeys.has(`${delivery.occurrenceIndex}:${delivery.targetChatId}`),
      )
      .map((delivery) => ({
        ...delivery,
        ...(row.publicationOccurrenceId
          ? {
              publicationOccurrenceId: row.publicationOccurrenceId,
              contentRevisionId: row.publicationContentRevisionId,
            }
          : {}),
      }));

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
      if (isManagedBroadcastPermanentTargetDeliveryFailure(null, failureMessage)) {
        await cancelManagedBroadcastTargetDeliveries(this.prisma, broadcastId, occurrenceIndex, {
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
        await cancelManagedBroadcastTargetDeliveries(this.prisma, broadcastId, occurrenceIndex, {
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

      if (!shouldAutoRetryManagedBroadcastDeliveryFailure(delivery)) {
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
          lockToken: null,
          lastErrorCode: null,
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

  private async resolveManagedBroadcastTransientQuarantineMessage(
    broadcastId: string,
    occurrenceIndex: number,
    targetChatId: string,
    currentAttemptCount: number,
    failureMessage: string,
  ): Promise<string | null> {
    if (!isManagedBroadcastTransientDeliveryFailureMessage(failureMessage)) {
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
      if (!isManagedBroadcastTransientDeliveryFailureMessage(effectiveFailureMessage)) {
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

    return buildManagedBroadcastTransientQuarantineMessage(
      transientFailureAttempts,
      transientFailureOccurrences.size,
      failureMessage,
    );
  }

  private async reconcileStaleManagedBroadcastDeliveries(
    broadcastId: string,
    occurrenceIndex: number,
    staleLockBefore: Date,
  ): Promise<void> {
    await this.reconcileManagedBroadcastSendingDeliveries(
      broadcastId,
      occurrenceIndex,
      this.buildStaleManagedBroadcastDeliveryLockWhere(staleLockBefore),
    );
  }

  private async reconcileInterruptedManagedBroadcastDeliveries(
    broadcastId: string,
    occurrenceIndex: number,
    staleLockBefore: Date,
  ): Promise<void> {
    await this.reconcileManagedBroadcastSendingDeliveries(
      broadcastId,
      occurrenceIndex,
      this.buildStaleManagedBroadcastDeliveryLockWhere(staleLockBefore),
    );
  }

  private createManagedBroadcastLockToken(): string {
    return `${process.pid}:${randomUUID()}`;
  }

  private async claimManagedBroadcastForAdminMutation(
    broadcastId: string,
    occurrenceIndex: number,
  ): Promise<ManagedBroadcastLease> {
    const staleLockBefore = new Date(Date.now() - MANAGED_BROADCAST_LOCK_STALE_MS);
    await this.assertNoFreshManagedBroadcastDeliveriesInFlight(broadcastId, occurrenceIndex);

    const lockedAt = new Date();
    const lockToken = this.createManagedBroadcastLockToken();
    const claim = await this.prisma.managedBroadcast.updateMany({
      where: {
        id: broadcastId,
        status: {
          in: [
            PrismaManagedBroadcastStatus.ACTIVE,
            PrismaManagedBroadcastStatus.PARTIAL,
            PrismaManagedBroadcastStatus.FAILED,
          ],
        },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
      },
      data: {
        lockedAt,
        lockToken,
      },
    });
    if (claim.count === 0) {
      throw new BadRequestException(
        'Автопостинг сейчас обрабатывается. Дождитесь завершения текущей попытки.',
      );
    }

    return {
      lockedAt,
      lockToken,
      lastHeartbeatAt: lockedAt,
    };
  }

  private async releaseManagedBroadcastAdminMutationLock(
    broadcastId: string,
    lease: ManagedBroadcastLease,
  ): Promise<void> {
    await this.prisma.managedBroadcast.updateMany({
      where: {
        id: broadcastId,
        lockToken: lease.lockToken,
      },
      data: {
        lockedAt: null,
        lockToken: null,
      },
    });
  }

  private buildStaleManagedBroadcastDeliveryLockWhere(
    staleLockBefore: Date,
  ): Prisma.ManagedBroadcastDeliveryWhereInput {
    return {
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
    };
  }

  private async assertNoFreshManagedBroadcastDeliveriesInFlight(
    broadcastId: string,
    occurrenceIndex: number,
  ): Promise<void> {
    const staleLockBefore = new Date(Date.now() - MANAGED_BROADCAST_LOCK_STALE_MS);
    const inFlightCount = await this.prisma.managedBroadcastDelivery.count({
      where: {
        broadcastId,
        occurrenceIndex,
        status: PrismaManagedBroadcastDeliveryStatus.SENDING,
        lockedAt: { gte: staleLockBefore },
      },
    });
    if (inFlightCount > 0) {
      throw new BadRequestException(
        'Автопостинг сейчас отправляется. Дождитесь завершения текущей попытки.',
      );
    }
  }

  private async heartbeatManagedBroadcastProcessingLock(
    broadcastId: string,
    occurrenceIndex: number,
    lease: ManagedBroadcastLease,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const now = new Date();
    if (
      !options.force &&
      now.getTime() - lease.lastHeartbeatAt.getTime() < MANAGED_BROADCAST_LOCK_HEARTBEAT_MS
    ) {
      return;
    }

    const heartbeat = await this.prisma.managedBroadcast.updateMany({
      where: {
        id: broadcastId,
        lockToken: lease.lockToken,
      },
      data: {
        lockedAt: now,
        lockToken: lease.lockToken,
      },
    });
    if (heartbeat.count === 0) {
      throw new ServiceUnavailableException(
        'Автопостинг уже обрабатывается другим процессом. Повторите позже.',
      );
    }

    lease.lockedAt = now;
    lease.lastHeartbeatAt = now;
    await this.prisma.managedBroadcastDelivery.updateMany({
      where: {
        broadcastId,
        occurrenceIndex,
        status: PrismaManagedBroadcastDeliveryStatus.SENDING,
      },
      data: {
        lockedAt: now,
      },
    });
  }

  private async deferManagedBroadcastOccurrenceWithFreshSendingDeliveries(
    broadcastId: string,
    occurrenceIndex: number,
    lease: ManagedBroadcastLease,
  ): Promise<boolean> {
    return deferManagedBroadcastWithFreshDeliveryLocks(
      this.prisma,
      broadcastId,
      occurrenceIndex,
      lease.lockToken,
    );
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
        ...buildPublicationDeliveryVerificationScheduledData(reconciledAt),
        legacySentWithoutRemoteId: false,
        lockedAt: null,
        lockToken: null,
        lastError: null,
      },
    });
    if (
      this.maxRoutedPublicationService &&
      typeof this.prisma.maxActionLedgerEntry?.findMany === 'function'
    ) {
      await this.reconcileRoutedManagedBroadcastSendingDeliveries(
        broadcastId,
        occurrenceIndex,
        extraWhere,
      );
      return;
    }
    await this.prisma.managedBroadcastDelivery.updateMany({
      where: {
        broadcastId,
        occurrenceIndex,
        status: PrismaManagedBroadcastDeliveryStatus.SENDING,
        remoteMessageId: null,
        ...(extraWhere ?? {}),
      },
      data: {
        status: PrismaManagedBroadcastDeliveryStatus.AMBIGUOUS,
        lockedAt: null,
        lockToken: null,
        lastError:
          'Прошлая попытка была прервана после старта отправки. Проверьте чат вручную перед повтором.',
      },
    });
  }

  private async reconcileRoutedManagedBroadcastSendingDeliveries(
    broadcastId: string,
    occurrenceIndex: number,
    extraWhere?: Prisma.ManagedBroadcastDeliveryWhereInput,
  ): Promise<void> {
    const broadcast = await this.prisma.managedBroadcast.findUnique({
      where: { id: broadcastId },
    });
    if (!broadcast) {
      return;
    }
    const deliveries = await this.prisma.managedBroadcastDelivery.findMany({
      where: {
        broadcastId,
        occurrenceIndex,
        status: PrismaManagedBroadcastDeliveryStatus.SENDING,
        remoteMessageId: null,
        ...(extraWhere ?? {}),
      },
      select: {
        id: true,
        targetChatId: true,
        botId: true,
        attemptCount: true,
        lockedAt: true,
        lockToken: true,
      },
    });
    if (deliveries.length === 0) {
      return;
    }

    const actionKeysByDeliveryId = new Map(
      deliveries.map((delivery) => [
        delivery.id,
        buildManagedBroadcastLedgerRecoveryActionKeys(
          broadcast,
          occurrenceIndex,
          delivery.targetChatId,
          delivery.attemptCount,
        ),
      ]),
    );
    const actionKeys = collectManagedBroadcastLedgerRecoveryActionKeys(
      actionKeysByDeliveryId.values(),
    );
    const ledgerRows = await this.prisma.maxActionLedgerEntry.findMany({
      where: {
        jobId: { in: actionKeys },
      },
      select: {
        jobId: true,
        remoteMessageId: true,
        dispatchToken: true,
        dispatchStartedAt: true,
        dispatchBotId: true,
        lastAttemptAt: true,
        ambiguous: true,
        terminal: true,
        lastError: true,
        completedAt: true,
        metadata: true,
      },
    });
    const ledgerByJobId = new Map(ledgerRows.map((ledger) => [ledger.jobId, ledger]));
    const pendingDeliveries: Array<(typeof deliveries)[number]> = [];
    const ambiguousDeliveryIds: string[] = [];
    const failedDeliveries: Array<{
      deliveryId: string;
      botId: string | null;
      lastError: string;
    }> = [];
    const completedDeliveries: Array<{
      delivery: (typeof deliveries)[number];
      ledger: (typeof ledgerRows)[number];
    }> = [];
    for (const delivery of deliveries) {
      const recovery = classifyManagedBroadcastLedgerRecovery(
        actionKeysByDeliveryId.get(delivery.id)!,
        ledgerByJobId,
        { legacyEligibleAfter: delivery.lockedAt },
      );
      if (recovery.kind === 'ambiguous') {
        ambiguousDeliveryIds.push(delivery.id);
        continue;
      }
      if (recovery.kind === 'completed') {
        completedDeliveries.push({ delivery, ledger: recovery.ledger });
        continue;
      }
      if (recovery.kind === 'pending') {
        pendingDeliveries.push(delivery);
        continue;
      }
      failedDeliveries.push({
        deliveryId: delivery.id,
        botId: recovery.ledger.dispatchBotId ?? delivery.botId ?? null,
        lastError:
          recovery.ledger.lastError?.trim() ||
          'Отправка завершилась до обращения к MAX и требует ручного повтора.',
      });
    }

    for (const { delivery, ledger } of completedDeliveries) {
      const sentAt = ledger.completedAt ?? new Date();
      const reconciled = await this.prisma.managedBroadcastDelivery.updateMany({
        where: {
          id: delivery.id,
          status: PrismaManagedBroadcastDeliveryStatus.SENDING,
          remoteMessageId: null,
        },
        data: {
          status: PrismaManagedBroadcastDeliveryStatus.SENT,
          botId: ledger.dispatchBotId ?? delivery.botId ?? null,
          remoteMessageId: ledger.remoteMessageId,
          sentAt,
          ...buildPublicationDeliveryVerificationScheduledData(sentAt),
          legacySentWithoutRemoteId: false,
          lockedAt: null,
          lockToken: null,
          lastError: null,
        },
      });
      if (reconciled.count === 0) {
        continue;
      }
      const recoveredContext = readManagedBroadcastLedgerCommentDialogContext(ledger.metadata);
      if (recoveredContext.found) {
        await this.recordManagedBroadcastCommentDialogReference({
          chatId: delivery.targetChatId,
          actorUserId: broadcast.actorUserId,
          messageId: ledger.remoteMessageId,
          text: broadcast.text,
          reference: recoveredContext.reference,
          source: 'ledger_recovery',
          broadcastId,
          occurrenceIndex,
        });
      }
    }

    for (const recoveryUpdate of buildManagedBroadcastPendingDeliveryRecoveryUpdates(
      pendingDeliveries,
    )) {
      await this.prisma.managedBroadcastDelivery.updateMany({
        where: {
          status: PrismaManagedBroadcastDeliveryStatus.SENDING,
          remoteMessageId: null,
          ...recoveryUpdate.where,
        },
        data: {
          status: PrismaManagedBroadcastDeliveryStatus.PENDING,
          ...recoveryUpdate.data,
        },
      });
    }
    for (const failedDelivery of failedDeliveries) {
      await this.prisma.managedBroadcastDelivery.updateMany({
        where: {
          id: failedDelivery.deliveryId,
          status: PrismaManagedBroadcastDeliveryStatus.SENDING,
          remoteMessageId: null,
        },
        data: {
          status: PrismaManagedBroadcastDeliveryStatus.FAILED,
          botId: failedDelivery.botId,
          lockedAt: null,
          lockToken: null,
          lastError: failedDelivery.lastError,
        },
      });
    }
    if (ambiguousDeliveryIds.length > 0) {
      await this.prisma.managedBroadcastDelivery.updateMany({
        where: {
          id: { in: ambiguousDeliveryIds },
          status: PrismaManagedBroadcastDeliveryStatus.SENDING,
          remoteMessageId: null,
        },
        data: {
          status: PrismaManagedBroadcastDeliveryStatus.AMBIGUOUS,
          lockedAt: null,
          lockToken: null,
          lastError:
            'Прошлая попытка была прервана после старта отправки. Проверьте чат вручную перед повтором.',
        },
      });
    }
  }

  private async failManagedBroadcastAfterFatalProcessingError(
    row: PersistedManagedBroadcast,
    currentOccurrence: number,
    failureMessage: string,
    lease?: ManagedBroadcastLease,
  ): Promise<void> {
    const updated = await this.updateManagedBroadcastIfNotCanceled(
      row.id,
      {
        status: PrismaManagedBroadcastStatus.FAILED,
        lastError: failureMessage,
        nextSendAt: null,
        lockedAt: null,
        lockToken: null,
      },
      lease,
    );
    if (!updated) {
      return;
    }

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
        lockToken: null,
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
        lockToken: null,
        lastError: failureMessage,
      },
    });

    if (normalizeBroadcastScheduleMode(row.scheduleMode) === 'calendar') {
      await this.prisma.managedBroadcastCalendarReservation.deleteMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex: { gt: currentOccurrence },
        },
      });
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
      await this.prisma.managedBroadcastOccurrence.deleteMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex: { gt: currentOccurrence },
        },
      });
    }

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
    lease?: ManagedBroadcastLease,
  ): Promise<boolean> {
    const result = await this.prisma.managedBroadcast.updateMany({
      where: {
        id: broadcastId,
        ...(lease ? { lockedAt: lease.lockedAt, lockToken: lease.lockToken } : {}),
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
    canRetryOverride?: boolean,
  ): Promise<BroadcastOccurrenceResult> {
    const current = await this.prisma.managedBroadcast.findUnique({
      where: { id: broadcastId },
    });
    const currentCanRetry =
      current?.status === PrismaManagedBroadcastStatus.PARTIAL ||
      current?.status === PrismaManagedBroadcastStatus.FAILED;

    return {
      status: current?.status ?? PrismaManagedBroadcastStatus.FAILED,
      currentOccurrence: current ? getCurrentManagedBroadcastOccurrence(current) : 1,
      sentChatIds,
      failedChatIds,
      pendingChatIds,
      canRetry:
        canRetryOverride === undefined ? currentCanRetry : canRetryOverride && currentCanRetry,
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
    options: { lease?: ManagedBroadcastLease; pendingNotBefore?: Date | null } = {},
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
    const ambiguousChats = deliveries.filter(
      (delivery: any) => delivery.status === PrismaManagedBroadcastDeliveryStatus.AMBIGUOUS,
    );
    const canceledChats = deliveries.filter(
      (delivery: any) => delivery.status === PrismaManagedBroadcastDeliveryStatus.CANCELED,
    );
    const failedLikeChats = [...failedChats, ...ambiguousChats, ...canceledChats];
    const terminalFailureChats = [
      ...failedChats,
      ...ambiguousChats,
      ...(row.publicationOccurrenceId ? canceledChats : []),
    ];
    const failedLikeChatIds = [
      ...new Set([
        ...failedLikeChats.map((delivery: any) => delivery.targetChatId),
        ...failedChatIds,
      ]),
    ];
    const pendingChats = deliveries.filter(
      (delivery: any) =>
        delivery.status === PrismaManagedBroadcastDeliveryStatus.PENDING ||
        delivery.status === PrismaManagedBroadcastDeliveryStatus.SENDING,
    );
    const unverifiedPublicationChats = row.publicationOccurrenceId
      ? deliveredChats.filter(
          (delivery: any) =>
            delivery.remoteMessageId !== null &&
            delivery.remoteMessageVerifiedAt === null &&
            hasPublicationDeliveryAutomatedVerificationState(delivery),
        )
      : [];
    const hasImmediatelyReadyPendingDelivery = pendingChats.some(
      (delivery: any) =>
        delivery.lastErrorCode !== PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
    );
    const canRetry = failedChats.length > 0;
    const scheduleMode = normalizeBroadcastScheduleMode(row.scheduleMode);

    if (pendingChats.length > 0 || unverifiedPublicationChats.length > 0) {
      const defaultNextSendAt = this.publicationVerification.nextAt(deliveries);
      const verificationNextSendAt =
        unverifiedPublicationChats.length > 0
          ? this.publicationVerification.nextAt(deliveredChats)
          : null;
      const deferredNextSendAt =
        pendingChats.length > 0 && !hasImmediatelyReadyPendingDelivery && options.pendingNotBefore
          ? verificationNextSendAt && verificationNextSendAt < options.pendingNotBefore
            ? verificationNextSendAt
            : options.pendingNotBefore
          : defaultNextSendAt;
      const updated = await this.updateManagedBroadcastIfNotCanceled(
        row.id,
        {
          status: PrismaManagedBroadcastStatus.ACTIVE,
          nextSendAt: deferredNextSendAt,
          lastError: null,
          lockedAt: null,
          lockToken: null,
        },
        options.lease,
      );
      if (!updated) {
        return this.readManagedBroadcastOccurrenceResult(
          row.id,
          sentChatIds.length > 0
            ? sentChatIds
            : deliveredChats.map((delivery: any) => delivery.targetChatId),
          failedLikeChatIds,
          pendingChats.map((delivery: any) => delivery.targetChatId),
          firstSendError,
          false,
        );
      }
      if (scheduleMode === 'calendar') {
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
        failedChatIds: failedLikeChatIds,
        pendingChatIds: pendingChats.map((delivery: any) => delivery.targetChatId),
        canRetry: false,
        firstSendError,
        nextSendAt: deferredNextSendAt,
      };
    }

    const nextCalendarOccurrence =
      scheduleMode === 'calendar' && currentOccurrence < row.cycleCount
        ? await this.getManagedBroadcastOccurrenceAtIndex(row.id, currentOccurrence + 1)
        : null;
    const hasFutureOccurrence =
      scheduleMode === 'calendar'
        ? nextCalendarOccurrence !== null
        : currentOccurrence < row.cycleCount;
    const canContinueAfterTargetPruning =
      canceledChats.length > 0 &&
      failedChats.length === 0 &&
      ambiguousChats.length === 0 &&
      deliveredChats.length > 0 &&
      hasFutureOccurrence;

    if (terminalFailureChats.length > 0 && !canContinueAfterTargetPruning) {
      const status =
        deliveredChats.length > 0
          ? PrismaManagedBroadcastStatus.PARTIAL
          : PrismaManagedBroadcastStatus.FAILED;
      const failureMessage = buildManagedBroadcastFailureMessage(
        terminalFailureChats.length,
        firstSendError,
      );
      const updated = await this.updateManagedBroadcastIfNotCanceled(
        row.id,
        {
          status,
          lastError: failureMessage,
          lockedAt: null,
          lockToken: null,
        },
        options.lease,
      );
      if (!updated) {
        return this.readManagedBroadcastOccurrenceResult(
          row.id,
          sentChatIds.length > 0
            ? sentChatIds
            : deliveredChats.map((delivery: any) => delivery.targetChatId),
          failedLikeChatIds,
          pendingChats.map((delivery: any) => delivery.targetChatId),
          firstSendError,
          canRetry,
        );
      }
      if (scheduleMode === 'calendar') {
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
        failedChatIds: failedLikeChatIds,
        pendingChatIds: pendingChats.map((delivery: any) => delivery.targetChatId),
        canRetry,
        firstSendError,
        nextSendAt: row.nextSendAt,
      };
    }

    const nextSentCount = currentOccurrence;
    let nextSendAt: Date | null;
    let isComplete: boolean;
    if (scheduleMode === 'calendar') {
      nextSendAt = nextCalendarOccurrence?.scheduledAt ?? null;
      isComplete = nextSentCount >= row.cycleCount || !nextSendAt;
    } else {
      isComplete = nextSentCount >= row.cycleCount;
      nextSendAt = isComplete
        ? null
        : new Date(row.nextSendAt!.getTime() + row.cycleEveryHours * ONE_HOUR_MS);
    }
    const updated = await this.updateManagedBroadcastIfNotCanceled(
      row.id,
      {
        sentCount: nextSentCount,
        nextSendAt,
        status: isComplete
          ? PrismaManagedBroadcastStatus.COMPLETED
          : PrismaManagedBroadcastStatus.ACTIVE,
        lastError: null,
        lockedAt: null,
        lockToken: null,
      },
      options.lease,
    );
    if (!updated) {
      return this.readManagedBroadcastOccurrenceResult(
        row.id,
        sentChatIds.length > 0
          ? sentChatIds
          : deliveredChats.map((delivery: any) => delivery.targetChatId),
        failedLikeChatIds,
        [],
        firstSendError,
        false,
      );
    }
    if (scheduleMode === 'calendar') {
      await this.prisma.managedBroadcastCalendarReservation.deleteMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex: currentOccurrence,
        },
      });
      await this.prisma.managedBroadcastOccurrence.updateMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex: currentOccurrence,
        },
        data: {
          status: canContinueAfterTargetPruning
            ? PrismaManagedBroadcastStatus.PARTIAL
            : PrismaManagedBroadcastStatus.COMPLETED,
        },
      });
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
      failedChatIds: failedLikeChatIds,
      pendingChatIds: [],
      canRetry: false,
      firstSendError,
      nextSendAt,
    };
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
          occurrenceIndex: getCurrentManagedBroadcastOccurrence(row),
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
        occurrenceIndex: getCurrentManagedBroadcastOccurrence(row),
      },
    });
    return this.createManagedBroadcastDeliverySnapshot(row, deliveries);
  }

  private createManagedBroadcastDeliverySnapshot(
    row: PersistedManagedBroadcast,
    deliveries: PersistedManagedBroadcastDelivery[],
  ): ManagedBroadcastDeliverySnapshot {
    return createManagedBroadcastDeliverySnapshotValue(row, deliveries);
  }

  private async loadManagedAutopostRuleIdsByBroadcastId(
    broadcastIds: readonly string[],
  ): Promise<Map<string, string>> {
    const uniqueBroadcastIds = Array.from(new Set(broadcastIds.filter(Boolean)));
    if (uniqueBroadcastIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.managedAutopostMaterialization.findMany({
      where: {
        broadcastId: { in: uniqueBroadcastIds },
      },
      select: {
        broadcastId: true,
        ruleId: true,
      },
    });
    return new Map(
      rows
        .filter((row): row is { broadcastId: string; ruleId: string } => Boolean(row.broadcastId))
        .map((row) => [row.broadcastId, row.ruleId]),
    );
  }

  private async resolveManagedAutopostRuleIdForBroadcast(
    broadcastId: string,
  ): Promise<string | null> {
    const row = await this.prisma.managedAutopostMaterialization.findFirst({
      where: { broadcastId },
      select: { ruleId: true },
    });
    return row?.ruleId ?? null;
  }

  private mapManagedBroadcastSummary(
    row: PersistedManagedBroadcast,
    snapshot?: ManagedBroadcastDeliverySnapshot,
    upcomingSlots: Date[] = [],
    targetPreviewBundle?: ManagedBroadcastTargetPreviewBundle,
    autopostRuleId: string | null = null,
  ): ManagedBroadcastSummary {
    const { targetMode, targetChatIds } = this.resolveManagedBroadcastTargetsFromRow(row);
    const normalizedText = row.text.replace(/\s+/gu, ' ').trim();
    const resolvedSnapshot = snapshot ?? this.createManagedBroadcastDeliverySnapshot(row, []);
    const resolvedTargetPreviewBundle =
      targetPreviewBundle ??
      buildManagedBroadcastTargetPreviewBundle(
        targetChatIds,
        new Map(),
        fromPrismaEntityType(row.entityType),
      );
    const buttonState = this.buildManagedBroadcastButtonState(row.buttons, {
      buttonEnabled: row.buttonEnabled,
      buttonUrl: row.buttonUrl,
      buttonText: row.buttonText,
    });
    const images = this.mediaRuntime.readManagedBroadcastImagesFromRow(row);
    const hasVideo = readManagedBroadcastMediaType(row.mediaType) === 'video';
    const cycleCount = normalizeManagedBroadcastCycleCount(row);

    return {
      id: row.id,
      autopostRuleId,
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
    autopostRuleId: string | null = null,
  ): ManagedBroadcastDetails {
    const { targetMode, targetChatIds } = this.resolveManagedBroadcastTargetsFromRow(row);
    const resolvedSnapshot = snapshot ?? this.createManagedBroadcastDeliverySnapshot(row, []);
    const resolvedTargetPreviewBundle =
      targetPreviewBundle ??
      buildManagedBroadcastTargetPreviewBundle(
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
    const images = this.mediaRuntime.readManagedBroadcastImagesFromRow(row);
    const firstImage = images[0];
    const cycleCount = normalizeManagedBroadcastCycleCount(row);

    return {
      id: row.id,
      autopostRuleId,
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
    onProgress?: ManagedBroadcastProgressCallback,
  ): Promise<MaxPublishedMessage> {
    let lastError: unknown = null;
    const attempts =
      Math.max(
        resolveManagedBroadcastAttachmentRetryCount(options),
        BROADCAST_THROTTLE_RETRY_DELAYS_MS.length,
        BROADCAST_TIMEOUT_RETRY_DELAYS_MS.length,
      ) + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const published = botId
          ? await this.maxClient.sendMessageImmediateWithId(chatId, text, options, {
              ...this.mediaRuntime.buildManagedBroadcastMaxApiRequestOptions(maxApiOptions),
              botId,
            })
          : await this.maxClient.sendMessageImmediateWithId(
              chatId,
              text,
              options,
              this.mediaRuntime.buildManagedBroadcastMaxApiRequestOptions(maxApiOptions),
            );
        return published;
      } catch (error: unknown) {
        lastError = error;
        const retryDelayMs = this.resolveManagedBroadcastSendRetryDelayMs(error, attempt, options);
        if (retryDelayMs === null) {
          throw error;
        }
        await onProgress?.();
        await sleep(retryDelayMs);
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new Error('Managed broadcast send did not return a result.');
  }

  private async loadManagedBroadcastLedgerCommentDialogContext(jobId: string): Promise<{
    found: boolean;
    reference: ManagedBroadcastCommentDialogReference | null;
  }> {
    const ledger = await this.prisma.maxActionLedgerEntry.findUnique({
      where: { jobId },
      select: { metadata: true },
    });
    return readManagedBroadcastLedgerCommentDialogContext(ledger?.metadata ?? null);
  }

  private buildManagedBroadcastDeliveryActionKey(
    row: PersistedManagedBroadcast,
    occurrenceIndex: number,
    targetChatId: string,
    attemptCount = 1,
  ): string {
    return buildManagedBroadcastDeliveryActionKeyValue(
      row,
      occurrenceIndex,
      targetChatId,
      attemptCount,
    );
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
    onProgress?: ManagedBroadcastProgressCallback,
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
                ...this.mediaRuntime.buildManagedBroadcastMaxApiRequestOptions(maxApiOptions),
                botId,
              }
            : {
                immediate: true,
                ...this.mediaRuntime.buildManagedBroadcastMaxApiRequestOptions(maxApiOptions),
              },
        );
        return;
      } catch (error: unknown) {
        lastError = error;
        if (!this.isAttachmentNotReadyError(error) || attempt >= attempts) {
          throw error;
        }
        const delayMs = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS[attempt - 1] ?? 1_500;
        await onProgress?.();
        await sleep(delayMs);
      }
    }

    if (lastError) {
      throw lastError;
    }
  }
}
