import {
  applySectionToAllRequestSchema,
  applySectionToAllResponseSchema,
  addDomainRequestSchema,
  chatParticipantImmunitySchema,
  chatParticipantImmunityUpdateRequestSchema,
  chatParticipantImmunityUpdateResultSchema,
  addAdminRequestSchema,
  chatParticipantsPageSchema,
  chatParticipantsQuerySchema,
  chatSettingsScreenResponseSchema,
  chatRulesSchema,
  channelSettingsScreenResponseSchema,
  channelStatsQuerySchema,
  channelStatsResponseSchema,
  channelDialogResponseSchema,
  channelSuggestionRedirectResponseSchema,
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
  managedEntityBotExecutionPlanSchema,
  publishChatRulesResultSchema,
  promoteManagedEntityStandbyRequestSchema,
  resolveRequiredSubscriptionChannelRequestSchema,
  resolveRequiredSubscriptionChannelResponseSchema,
  type ChannelDialogMessage,
  type ChannelDialogReactionGroup,
  type ChannelDialogReplyPreview,
  type ChannelDialogSuggestionReviewStatus,
  type ChatParticipantImmunity,
  type ChatParticipantItem,
  type ChatParticipantImmunityUpdateResult,
  type ChatParticipantsPage,
  type ChatParticipantsQuery,
  type ChannelDialogType,
  type ChannelStatsBucket,
  type ChannelStatsRange,
  type ChannelStatsResponse,
  type ChannelOverview,
  type ApplySectionToAllResponse,
  type ManagedBroadcastDetails,
  type MembershipActivityPage,
  type MembershipActivityQuery,
  managedBroadcastDetailsSchema,
  type ManagedBroadcastSummary,
  type ManagedEntityBotCapability,
  type ManagedEntityBotExecutionPlan,
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
  type Me,
  type ModerationFeedFilter,
  type ModerationFeedPage,
  type ModerationFeedQuery,
  type ModerationEvent,
  publishChannelEngagementRequestSchema,
  publishChannelEngagementResultSchema,
  type UpdateChatRulesRequest,
  updateChatRulesRequestSchema,
  type PublishChatRulesResult,
  type BroadcastTextFormat,
  type BroadcastLinkButton,
  type ManagedEntityAssignedBot,
  type ManagedEntitiesListResponse,
  type ManagedEntitiesResponseDiff,
  type ManagedEntitiesResponseSnapshot,
  type ManagedEntitiesRefreshState,
  type SendBroadcastRequest,
  type SendBroadcastResult,
  type ChatSummary,
  type ManagedEntityHeader,
  type UpdateManagedEntityPartnerAssistRequest,
  type UpdateManagedEntityPrimaryBotRequest,
  type ResolveRequiredSubscriptionChannelResponse,
  managedPollSchema,
  MAX_CHANNEL_DIALOG_SUGGEST_IMAGES,
  inferAllowlistMatchType,
  normalizeMessageLimitsBlockedWordCandidate,
  normalizeStoredAllowlistEntry,
  parseStoredAllowlistEntry,
  updateManagedPollRequestSchema,
  type ManagedPoll,
  sendBroadcastRequestSchema,
  scheduleDomainRemovalRequestSchema,
  toggleChannelDialogReactionRequestSchema,
  toggleChannelDialogReactionResponseSchema,
  updateManagedEntityPartnerAssistRequestSchema,
  updateManagedEntityPrimaryBotRequestSchema,
  updateChannelDialogMessageRequestSchema,
  updateChannelDialogMessageResponseSchema,
  type AllowlistMatchType,
  type BroadcastScheduleMode,
  DEFAULT_BROADCAST_BUTTON_TEXT,
  MAX_BROADCAST_LINK_BUTTONS,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_DEFAULT,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN,
} from '@maxim/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import {
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedBroadcastDeliveryStatus as PrismaManagedBroadcastDeliveryStatus,
  EventType,
  ManagedBroadcastStatus as PrismaManagedBroadcastStatus,
  ManagedPollStatus as PrismaManagedPollStatus,
  Operator,
  Prisma,
  PrismaClient,
  SanctionAction,
  type ManagedBroadcast as PersistedManagedBroadcast,
  type ManagedBroadcastDelivery as PersistedManagedBroadcastDelivery,
  type ManagedBroadcastOccurrence as PersistedManagedBroadcastOccurrence,
  type ChatRules as PersistedChatRules,
  type ManagedPoll as PersistedManagedPoll,
} from '@prisma/client';
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
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ChatContextCacheService,
  type ChatAdminAccessState,
  type ManagedEntitiesPublishedDiff,
  type ManagedEntitiesPublishedSnapshot,
} from '../chat-context/chat-context-cache.service';
import { collectBotTokenSecrets } from '../common/bot-token.util';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  buildCompactProfileMentionStartPayload,
  isValidMaxBotStartPayload,
  isValidMaxMiniappStartPayload,
} from '../max/max-deep-link.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxAttachmentPayload,
  type MaxBotChat,
  type MaxChatMemberAccess,
  type MaxChatMemberRole,
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
import {
  buildManagedPollButtons,
  buildManagedPollMessageText,
  buildManagedPollOptionSummaries,
  normalizeManagedPollDraft,
  validateManagedPollForPublish,
} from '../common/managed-poll.util';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import { renderSupportedMarkdownAsHtml } from '../common/max-markdown.util';
import {
  escapeHtml,
  escapeHtmlAttribute,
  escapeHtmlPreservingWhitespace,
  renderMaxTextMarkupAsHtml,
  type MaxTextMarkup,
} from '../common/max-text-markup.util';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelStatsCollectorService } from './channel-stats-collector.service';
import { buildDuplicateUserPattern } from '../moderation/duplicate-state';
import {
  ACTIVE_MUTE_CACHE_SLACK_SEC,
  ACTIVE_MUTE_NEGATIVE_CACHE_TTL_SEC,
  buildActiveMuteStateKey,
  type CachedActiveMuteState,
} from '../moderation/moderation-state.util';
import { RedisCounterService } from '../moderation/redis-counter.service';
import {
  canUserAccessSystem,
  readSystemAccessConfig,
  type SystemAccessConfig,
} from '../system/system-access.util';
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
  type AdminManualMuteFanoutJob,
} from './admin-manual-fanout.queue';
import {
  ADMIN_SUGGESTION_DELIVERY_QUEUE,
  type AdminSuggestionDeliveryJob,
} from './admin-suggestion-delivery.queue';

type ApplySettingsToAllChatsResult = {
  sourceChatId: string;
  updatedChats: number;
  appliedChatIds: string[];
};

type ManagedEntityTypeFilter = ManagedEntityType | 'all';

type ManagedEntitiesListResult = {
  items: ChatSummary[];
  refresh: ManagedEntitiesRefreshState | null;
  snapshot?: ManagedEntitiesResponseSnapshot | null;
  diff?: ManagedEntitiesResponseDiff | null;
};

type ManagedEntitiesRefreshPresentation = {
  totalCandidates: number | null;
  lastSyncedAt: string | null;
};

type ManagedEntitiesRefreshJobOutcome = {
  continueAfterMs: number;
} | null;

type ManagedEntitiesManualRefreshBlockReason = 'in_progress' | 'recent_sync' | 'backoff';

type ManagedEntitiesPublishedSnapshotReadResult = {
  items: ChatSummary[];
  version: string;
  builtAt: string;
  lastSyncedAt: string | null;
};

type ManagedEntitiesPublishedDiffReadResult = {
  baseVersion: string;
  nextVersion: string;
  added: ChatSummary[];
  updated: ChatSummary[];
  removedIds: string[];
  orderedIds: string[];
};

type ManagedEntitiesListOptions = {
  refresh?: boolean;
  includeRefreshState?: boolean;
  bypassRemoteCache?: boolean;
  resetRefreshCursor?: boolean;
  fresh?: boolean;
  sinceVersion?: string;
};

type ManagedEntitiesDiscoverySnapshot = MaxBotChat[];
type ManagedEntityBotProfileSnapshot = {
  avatarUrl: string | null;
};

type AssertChatAdminOptions = {
  syncPersistedAccess?: boolean;
};

type AdminReadBypassOptions = {
  skipAdminCheck?: boolean;
  skipEntityCheck?: boolean;
};

type TimedPromiseCacheEntry<T> = {
  expiresAtMs: number;
  promise: Promise<T>;
};

type TimedValueCacheEntry<T> = {
  expiresAtMs: number;
  value: T;
};

type ManagedEntityBotAssignmentsRow = {
  id: string;
  botId: string | null;
  primaryBotId: string | null;
  botMemberships: Array<{
    botId: string;
    role: 'PRIMARY' | 'STANDBY';
    status: 'ACTIVE' | 'REMOVED';
    capabilities: unknown;
    permissionsSnapshot: unknown;
  }>;
};

type AdminAccessResolution =
  | {
      status: 'granted';
      source: 'cache' | 'remote' | 'allowlist_fallback';
    }
  | {
      status: 'denied';
      source: 'cache' | 'remote';
      reason: 'user_not_admin' | 'bot_not_admin';
    }
  | {
      status: 'unknown';
      error: unknown;
    }
  | {
      status: 'throttled';
      error: unknown;
    };

export type AdminActionSource = 'miniapp' | 'private_bot' | 'private_command' | 'group_command';
type ManualBanFollowUpSource = Extract<AdminActionSource, 'miniapp' | 'group_command' | 'private_command'>;

type AdoptChatRulesFromMessageInput = {
  sourceMessageId?: string | null;
  sourceMessageUrl?: string | null;
  text?: string | null;
};

type ManualMemberModerationAction = 'MUTE' | 'BAN';
type ManualMemberManageMembersAction = ManualMemberModerationAction | 'UNBAN';
type ManualBanExecutionMode = 'MAX_BLOCK' | 'MAX_REMOVE_ONLY';
type ManualUnbanExecutionMode = 'MAX_UNBLOCK' | 'ALREADY_PRESENT';

type ResolvedUserProfile = {
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  profileHandoffUrl: string | null;
};

type ResolveUserProfilesOptions = {
  allowRemoteLookup?: boolean;
};

type ModerationFeedCursor = {
  createdAt: Date;
  id: string;
};

type ChannelSuggestionActor = Pick<AuthUser, 'userId'> & {
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
};

type ChannelSuggestionImageAsset = {
  base64?: string | null;
  payload?: Record<string, unknown> | null;
  mimeType?: string | null;
  fileName?: string | null;
};

type ChannelSuggestionTextMarkup = MaxTextMarkup;

type ChannelSuggestionDeliveryInput = {
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
};

type ModerationViolationRow = {
  id: string;
  action: SanctionAction;
  ruleCode: string;
  userId: string;
  createdAt: Date;
  maskedExcerpt: string | null;
  metadata: Prisma.JsonValue | null;
};

type PreparedManagedBroadcastRequest = {
  payload: SendBroadcastRequest;
  targetChatIds: string[];
  normalizedSourceText: string;
};

type ManagedBroadcastSchedulePlan = {
  scheduleMode: BroadcastScheduleMode;
  scheduleTimezone: string;
  upcomingSlots: Date[];
  nextSendAt: Date | null;
  cycleEnabled: boolean;
  cycleEveryHours: number;
  cycleCount: number;
  sendAt: string | null;
  sentCount: number;
};

type ParsedManagedBroadcastCalendarSlots = {
  upcomingSlots: Date[];
  sentCount: number;
};

type BroadcastOccurrenceResult = {
  status: PrismaManagedBroadcastStatus;
  currentOccurrence: number;
  sentChatIds: string[];
  failedChatIds: string[];
  pendingChatIds: string[];
  canRetry: boolean;
  firstSendError: unknown;
  nextSendAt: Date | null;
};

type ManagedBroadcastDeliverySnapshot = {
  currentOccurrence: number;
  deliveredChats: number;
  failedChats: number;
  pendingChats: number;
  blockedChats: number;
  failureBreakdown: ManagedBroadcastFailureBreakdown;
  canRetry: boolean;
};

type ManagedBroadcastFailureBreakdown = {
  transient: number;
  permanentTarget: number;
  quarantined: number;
  unknown: number;
};

type MembershipEventRow = {
  id: string;
  created_at: Date | string;
  event_type: string | null;
  user_id: string | null;
  sender_name: string | null;
};

const RULES_IMAGE_MAX_BYTES = 1_000_000;
const BROADCAST_IMAGE_MAX_BYTES = 3_000_000;
const BROADCAST_MIN_DELAY_MS = 30_000;
const BROADCAST_MAX_DELAY_MS = 31 * 24 * 60 * 60 * 1000;
const BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS = [1_500, 3_000, 6_000];
const BROADCAST_THROTTLE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const BROADCAST_TIMEOUT_RETRY_DELAYS_MS = [1_500, 4_000, 10_000];
const BROADCAST_CALENDAR_SLOT_MINUTES = 30;
const MANAGED_BROADCAST_DUE_BATCH_SIZE = 10;
const MANAGED_BROADCAST_RECOVERY_BATCH_SIZE = 2;
const MANAGED_BROADCAST_DUE_MAX_PASSES = 100;
const MANAGED_BROADCAST_LOCK_STALE_MS = 60_000;
const MANAGED_BROADCAST_AUTO_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const MANAGED_BROADCAST_MAX_AUTO_RETRY_ATTEMPTS = 6;
const MANAGED_BROADCAST_TARGET_QUARANTINE_FAILURE_OCCURRENCES = 3;
const MANAGED_BROADCAST_TARGET_QUARANTINE_ATTEMPTS =
  MANAGED_BROADCAST_MAX_AUTO_RETRY_ATTEMPTS;
const MANAGED_BROADCAST_TRANSIENT_QUARANTINE_REASON_PREFIX =
  'Чат временно исключен из оставшихся доставок после повторяющихся ошибок отправки';
const LOGS_DASHBOARD_VIOLATIONS_LIMIT = 50;
const MEMBERSHIP_ACTIVITY_PAGE_LIMIT = 50;
const LOGS_DASHBOARD_RESPONSE_CACHE_TTL_MS = 30_000;
const SLOW_LOGS_DASHBOARD_THRESHOLD_MS = 1_500;
const EVENTS_FEED_PAGE_CACHE_TTL_MS = 30_000;
const RESOLVED_USER_PROFILE_CACHE_TTL_MS = 30_000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;
const DEFAULT_PARTICIPANT_IMMUNITY_TIMEZONE = 'Europe/Moscow';
const MANUAL_BAN_RECENT_MESSAGE_DELETE_LIMIT = 1000;
const LIST_CHATS_ADMIN_CHECK_CONCURRENCY = 2;
const MANAGED_ENTITIES_DELTA_ADMIN_CHECK_SPACING_MS = process.env.NODE_ENV === 'test' ? 0 : 220;
const MANAGED_ENTITIES_FULL_SCAN_ADMIN_CHECK_SPACING_MS = process.env.NODE_ENV === 'test' ? 0 : 320;
const MANAGED_ENTITIES_DELTA_DISCOVERY_WINDOW_SIZE = 6;
const MANAGED_ENTITIES_REFRESH_UNCACHED_LIMIT = 40;
const MANAGED_ENTITIES_REFRESH_SCAN_WINDOW_SIZE = 10;
const MANAGED_ENTITIES_BACKGROUND_CATALOG_SYNC_WINDOW_SIZE = 6;
const MANAGED_ENTITIES_LOCAL_REFRESH_SCAN_WINDOW_SIZE = 8;
const MANAGED_ENTITIES_ALLOWLIST_CACHE_TTL_MS = 2_000;
const MANAGED_ENTITIES_ALLOWLIST_RESPONSE_BUDGET_MS = 250;
const MANAGED_ENTITIES_SUSPICIOUS_ALLOWLIST_REVALIDATION_LIMIT = 3;
const MANAGED_ENTITIES_SUSPICIOUS_ALLOWLIST_ADMIN_TIMEOUT_MS = 300;
const MANAGED_ENTITIES_LAST_SUCCESS_SNAPSHOT_TTL_MS = 60_000;
const MANAGED_ENTITIES_LIGHTWEIGHT_RECENT_BOOTSTRAP_RESPONSE_BUDGET_MS = 500;
const MANAGED_ENTITIES_RESPONSE_WARMUP_BUDGET_MS = 1_500;
const MANAGED_ENTITIES_LOCAL_DISCOVERY_ADMIN_TIMEOUT_MS = 1_000;
const MANAGED_ENTITIES_REMOTE_DELTA_ADMIN_TIMEOUT_MS = 750;
const MANAGED_ENTITIES_REMOTE_FULL_SCAN_ADMIN_TIMEOUT_MS = 1_000;
const MANAGED_ENTITIES_REMOTE_DELTA_SNAPSHOT_TIMEOUT_MS = 2_500;
const MANAGED_ENTITIES_REMOTE_FULL_SCAN_SNAPSHOT_TIMEOUT_MS = 4_000;
const MANAGED_ENTITIES_PRIORITY_ALLOWLIST_WARMUP_LIMIT = 12;
const MANAGED_ENTITIES_REFRESH_CURSOR_DONE = -1;
const MANAGED_ENTITIES_REFRESH_CURSOR_TTL_SEC = 60 * 60;
const MANAGED_ENTITIES_REFRESH_CURSOR_DONE_TTL_SEC = 60;
const MANAGED_ENTITIES_REFRESH_SNAPSHOT_TTL_SEC = 5 * 60;
const MANAGED_ENTITIES_REFRESH_LAST_SYNCED_TTL_SEC = 30 * 24 * 60 * 60;
const MANAGED_ENTITIES_PUBLISHED_DIFF_MAX_CHANGE_RATIO = 0.3;
const MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC = 7 * 24 * 60 * 60;
const MANAGED_ENTITIES_REFRESH_SUCCESS_COOLDOWN_MS = 45_000;
const MANAGED_ENTITIES_MANUAL_REFRESH_RECENT_SYNC_WINDOW_MS = 30_000;
const MANAGED_ENTITIES_REFRESH_BACKOFF_MS = 60_000;
const MANAGED_ENTITIES_REFRESH_FRESHNESS_WINDOW_MS = 10 * 60_000;
const MANAGED_ENTITIES_REFRESH_NEXT_POLL_AFTER_MS = 1_500;
const MANAGED_ENTITIES_REFRESH_IDLE_NEXT_POLL_AFTER_MS = 3_000;
const MANAGED_ENTITIES_REFRESH_DEGRADE_PAUSE_RETRY_MS = 15_000;
const MANAGED_ENTITIES_REFRESH_QUEUE_LAG_SLOW_PATH_MAX_SEC = 30;
const MANAGED_ENTITIES_DEGRADE_PAUSE_LOG_INTERVAL_MS = 60_000;
const MANAGED_ENTITIES_MASS_ACTION_FULL_SCAN_MAX_PASSES = 75;
const MANAGED_ENTITY_HEADER_HYDRATION_BATCH_SIZE = 8;
const MANAGED_ENTITY_HEADER_HYDRATION_CONCURRENCY = 1;
const ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES = [403, 404] as const;
const ADMIN_ACTION_HEALTH_LANE = 'background' as const;
const APPLY_SETTINGS_TO_ALL_CHATS_CONCURRENCY = 6;
const REQUIRED_SUBSCRIPTION_CHANNEL_CHECK_CONCURRENCY = 3;
const CHANNEL_DIALOG_MESSAGES_LIMIT = 80;
const CHANNEL_DIALOG_ACTION_COMMENT = 'CHANNEL_DIALOG_COMMENT';
const CHANNEL_DIALOG_ACTION_SUGGEST = 'CHANNEL_DIALOG_SUGGESTION';
const CHANNEL_DIALOG_ACTION_PUBLISH = 'PUBLISH_CHANNEL_ENGAGEMENT';
const CHANNEL_DIALOG_ACTION_AUTO_ATTACH = 'AUTO_ATTACH_CHANNEL_ENGAGEMENT';
const CHAT_DIALOG_ACTION_AUTO_ATTACH = 'AUTO_ATTACH_CHAT_COMMENTS';
const MANAGED_POLL_ACTION_UPDATE = 'UPDATE_MANAGED_POLL';
const MANAGED_POLL_ACTION_PUBLISH = 'PUBLISH_MANAGED_POLL';
const MANAGED_POLL_ACTION_CLOSE = 'CLOSE_MANAGED_POLL';
const PRIVATE_CONTROL_CALLBACK_PREFIX = 'pc2';
const CHANNEL_DIALOG_START_PARAM_PREFIX = 'cd-';
const CHANNEL_SUGGESTION_START_PARAM_PREFIX = 'cds-';
const CHANNEL_DIALOG_TOKEN_PREFIX = 'cdt-';
const DEFAULT_CHAT_SETTINGS = chatSettingsSchema.parse({});
const DEFAULT_CHANNEL_SETTINGS = channelSettingsSchema.parse({});
const CHAT_SETTINGS_BUTTON_GROUPS = [
  {
    buttons: 'linkBotButtons',
    enabled: 'linkBotButtonEnabled',
    url: 'linkBotButtonUrl',
    text: 'linkBotButtonText',
  },
  {
    buttons: 'greetingBotButtons',
    enabled: 'greetingBotButtonEnabled',
    url: 'greetingBotButtonUrl',
    text: 'greetingBotButtonText',
  },
  {
    buttons: 'textFiltersBotButtons',
    enabled: 'textFiltersBotButtonEnabled',
    url: 'textFiltersBotButtonUrl',
    text: 'textFiltersBotButtonText',
  },
  {
    buttons: 'thematicFiltersBotButtons',
    enabled: 'thematicFiltersBotButtonEnabled',
    url: 'thematicFiltersBotButtonUrl',
    text: 'thematicFiltersBotButtonText',
  },
  {
    buttons: 'duplicateBotButtons',
    enabled: 'duplicateBotButtonEnabled',
    url: 'duplicateBotButtonUrl',
    text: 'duplicateBotButtonText',
  },
  {
    buttons: 'messageLimitsBotButtons',
    enabled: 'messageLimitsBotButtonEnabled',
    url: 'messageLimitsBotButtonUrl',
    text: 'messageLimitsBotButtonText',
  },
  {
    buttons: 'nightModeBotButtons',
    enabled: 'nightModeBotButtonEnabled',
    url: 'nightModeBotButtonUrl',
    text: 'nightModeBotButtonText',
  },
] as const satisfies ReadonlyArray<{
  buttons: keyof ChatSettings;
  enabled: keyof ChatSettings;
  url: keyof ChatSettings;
  text: keyof ChatSettings;
}>;
const CHANNEL_SETTINGS_BUTTON_URL_KEYS = [
  'postSuggestionsButtonUrl',
] as const satisfies readonly (keyof ChannelSettings)[];
const CHANNEL_SETTINGS_BUTTON_ENABLED_BY_URL_KEY = {
  postSuggestionsButtonUrl: 'postSuggestionsButtonEnabled',
} as const satisfies Record<
  (typeof CHANNEL_SETTINGS_BUTTON_URL_KEYS)[number],
  keyof ChannelSettings
>;
const SETTINGS_SECTION_KEYS = {
  links: [
    'linkPolicy',
    'linkBotMessageEnabled',
    'linkBotMessageText',
    'linkWarnEnabled',
    'linkWarnMessageText',
    'linkBanEnabled',
    'linkMuteEnabled',
    'linkMuteDurationHours',
    'linkBotButtons',
    'linkBotButtonEnabled',
    'linkBotButtonUrl',
    'linkBotButtonText',
  ],
  greeting: [
    'greetingEnabled',
    'greetingBotMessageEnabled',
    'greetingDeleteBotMessageEnabled',
    'greetingDeleteBotMessageDelayMinutes',
    'greetingBotMessageText',
    'greetingBotButtons',
    'greetingBotButtonEnabled',
    'greetingBotButtonUrl',
    'greetingBotButtonText',
    'greetingRulesButtonEnabled',
  ],
  profanityFilter: [
    'russianProfanityFilterEnabled',
    'profanityBotMessageEnabled',
    'profanityWarnEnabled',
    'profanityBanEnabled',
    'profanityMuteEnabled',
    'profanityMuteDurationHours',
  ],
  commercialFilter: [
    'commercialAdsFilterEnabled',
    'commercialAdsSensitivity',
    'commercialAdsWarnThreshold',
    'commercialAdsDeleteThreshold',
    'textFiltersBotMessageEnabled',
    'textFiltersBotMessageText',
    'textFiltersWarnEnabled',
    'textFiltersWarnMessageText',
    'textFiltersBanEnabled',
    'textFiltersMuteEnabled',
    'textFiltersMuteDurationHours',
    'textFiltersBotButtons',
    'textFiltersBotButtonEnabled',
    'textFiltersBotButtonUrl',
    'textFiltersBotButtonText',
  ],
  thematicFilters: [
    'thematicCodewordEnabled',
    'thematicCodeword',
    'thematicFiltersBotMessageEnabled',
    'thematicFiltersWarnEnabled',
    'thematicFiltersBanEnabled',
    'thematicFiltersMuteEnabled',
    'thematicFiltersMuteDurationHours',
    'thematicFiltersBotButtons',
    'thematicFiltersBotButtonEnabled',
    'thematicFiltersBotButtonUrl',
    'thematicFiltersBotButtonText',
  ],
  duplicates: [
    'antiDuplicateEnabled',
    'duplicateWarnEnabled',
    'duplicateMuteEnabled',
    'duplicateBanEnabled',
    'duplicateWarnWindowSec',
    'duplicateWarnMaxCount',
    'duplicateMuteWindowSec',
    'duplicateMuteMaxCount',
    'duplicateMuteDurationHours',
    'duplicateBanWindowSec',
    'duplicateBanMaxCount',
    'duplicateBotMessageEnabled',
    'duplicateBotMessageText',
    'duplicateBotButtons',
    'duplicateBotButtonEnabled',
    'duplicateBotButtonUrl',
    'duplicateBotButtonText',
  ],
  limits: [
    'antiSpamEnabled',
    'messageCountLimitEnabled',
    'messageCountLimitMessages',
    'messageCountLimitWindowHours',
    'maxMessageLengthEnabled',
    'maxMessageLength',
    'photoMessageCooldownEnabled',
    'photoMessageCooldownHours',
    'stickerMessageCooldownEnabled',
    'stickerMessageCooldownMinutes',
    'videoMessagesEnabled',
    'fileMessagesEnabled',
    'voiceMessagesEnabled',
    'messageLimitsBlockedWords',
    'messageLimitsBotMessageEnabled',
    'messageLimitsBotMessageText',
    'messageLimitsWarnEnabled',
    'messageLimitsBanEnabled',
    'messageLimitsMuteEnabled',
    'messageLimitsMuteDurationHours',
    'messageLimitsBotButtons',
    'messageLimitsBotButtonEnabled',
    'messageLimitsBotButtonUrl',
    'messageLimitsBotButtonText',
  ],
  night: [
    'nightModeEnabled',
    'nightModeStartTimeMinutes',
    'nightModeEndTimeMinutes',
    'nightModeTimezone',
    'nightModeBotMessageEnabled',
    'nightModeBotMessageText',
    'nightModeCommentsEnabled',
    'nightModeOpenMessageEnabled',
    'nightModeOpenMessageText',
    'nightModeBotButtons',
    'nightModeBotButtonEnabled',
    'nightModeBotButtonUrl',
    'nightModeBotButtonText',
    'nightModeRulesButtonEnabled',
    'nightModeForceCloseEnabled',
    'nightModeForceCloseForever',
    'nightModeForceCloseHours',
    'nightModeForceCloseDays',
    'nightModeForceCloseUntil',
  ],
  requiredSubscription: [
    'requiredSubscriptionEnabled',
    'requiredSubscriptionChannelIds',
    'requiredSubscriptionDurationDays',
    'requiredSubscriptionExpiresAt',
    'requiredSubscriptionBotMessageEnabled',
    'requiredSubscriptionBotMessageText',
    'requiredSubscriptionWarnEnabled',
    'requiredSubscriptionWarnMessageText',
    'requiredSubscriptionBanEnabled',
    'requiredSubscriptionMuteEnabled',
    'requiredSubscriptionMuteDurationHours',
  ],
  extra: [
    'deleteSpammersEnabled',
    'deleteBotMessagesEnabled',
    'deleteBotMessagesDelayMinutes',
    'removeBotsFromGroupEnabled',
  ],
} as const satisfies Record<string, readonly (keyof ChatSettings)[]>;
const REQUIRED_SUBSCRIPTION_SETTING_KEYS = SETTINGS_SECTION_KEYS.requiredSubscription;
const REQUIRED_SUBSCRIPTION_DURATION_DAY_MS = 24 * 60 * 60 * 1_000;
const CHANNEL_STATS_POST_ACTIONS = [
  CHANNEL_DIALOG_ACTION_PUBLISH,
  CHANNEL_DIALOG_ACTION_AUTO_ATTACH,
] as const;
const CHANNEL_STATS_ACTIVITY_ACTIONS = [
  ...CHANNEL_STATS_POST_ACTIONS,
  CHANNEL_DIALOG_ACTION_COMMENT,
  CHANNEL_DIALOG_ACTION_SUGGEST,
] as const;
const CHANNEL_STATS_MISSING_METRICS = ['reach', 'uniqueViews'] as const;
const CHANNEL_STATS_REFRESH_STALE_MS = 2 * 60 * 60 * 1000;
const CHANNEL_COMMENT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const CHANNEL_COMMENT_MAX_CONSECUTIVE = 2;
const CHANNEL_COMMENT_LINK_PATTERN = /((https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,})(\/\S*)?/giu;
const PROFILE_MENTION_START_PREFIX = 'pmh-';
const RECENT_BOT_ADDED_BOOTSTRAP_LIMIT = 20;
const RECENT_BOT_ADDED_USER_SCOPED_WEBHOOK_SCAN_LIMIT = 50;
const RECENT_BOT_ADDED_WEBHOOK_SCAN_LIMIT = 100;
const RECENT_BOT_ADDED_BOOTSTRAP_MAX_ELAPSED_MS = 1_500;
const RECENT_BOT_ADDED_BOOTSTRAP_MAX_ADMIN_CHECKS = 4;
const RECENT_BOT_ADDED_BOOTSTRAP_ADMIN_TIMEOUT_MS = 250;
const RECENT_BOT_ADDED_BOOTSTRAP_HEADER_RESPONSE_BUDGET_MS = 200;
const RECENT_BOT_ADDED_BOOTSTRAP_HEADER_TIMEOUT_MS = 350;
const RECENT_BOT_ADDED_FAST_LANE_RETRY_WINDOW_MS = 45_000;
const MANAGED_ENTITIES_LOCAL_CANDIDATE_LIMIT = 250;
const MANAGED_ENTITIES_LOCAL_ACTIVITY_LOOKBACK_MS = 180 * TWENTY_FOUR_HOURS_MS;
const MANAGED_ENTITIES_LOCAL_ACTIVITY_EVENT_TYPES = [
  'message_created',
  'message_callback',
  'bot_started',
  'bot_added',
] as const;
type ChannelDialogTokenPayload = {
  v: 1;
  d: string;
  s: string;
};

class ManagedEntitiesRefreshThrottledError extends Error {
  constructor(readonly cause: unknown) {
    super('Managed entity refresh throttled');
    this.name = 'ManagedEntitiesRefreshThrottledError';
  }
}

type ChannelDialogMessageSource = 'miniapp_dialog' | 'private_bot';

type ChannelSuggestionFromBotPayload = {
  token: string;
  images: ChannelSuggestionImageAsset[];
  text: string;
  textFormat: BroadcastTextFormat;
  textMarkup: ChannelSuggestionTextMarkup[];
  imageBase64: string | null;
  imageMimeType: string | null;
  imageFileName: string | null;
  mediaType: 'image' | 'video' | null;
  mediaPayload: Record<string, unknown> | null;
  mediaMimeType: string | null;
  mediaFileName: string | null;
};

type ChannelSuggestionReviewAction = 'publish' | 'cancel';

type ChannelSuggestionAdminDelivery = {
  adminUserId: string;
  privateChatId: string;
  messageId: string;
  botId?: string;
};

type ProfileMentionStartPayload = {
  v: 1;
  k: 'profile-mention';
  c: string;
  e: ManagedEntityType;
  u: string;
  n: string;
};

@Injectable()
export class AdminService implements OnModuleDestroy {
  private readonly logger = new Logger(AdminService.name);
  private readonly appBaseUrl: string | null;
  private readonly explicitBotContactId: string | null;
  private readonly ownBotUserId: string | null;
  private readonly managedEntitiesRuntimeBotIds: ReadonlySet<string>;
  private readonly maxBotToken: string;
  private readonly maxBotTokenValidationSecrets: readonly string[];
  private readonly systemAccessConfig: SystemAccessConfig;
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
  private readonly pendingPersistedChatAccessPrunes = new Set<string>();
  private persistedChatAccessPruneChain: Promise<void> = Promise.resolve();
  private managedEntitiesDegradePauseLogAtMs = 0;
  private readonly logsDashboardResponseCache = new Map<
    string,
    TimedPromiseCacheEntry<LogsDashboardResponse>
  >();
  private readonly moderationFeedPageCache = new Map<
    string,
    TimedPromiseCacheEntry<ModerationFeedPage>
  >();
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
  ) {
    const configuredBotTokens = collectBotTokenSecrets(
      configService.getOrThrow<string>('MAX_BOT_TOKEN'),
      configService.get<string>('MAX_BOT_TOKEN_PREVIOUS'),
    );
    this.maxBotToken =
      this.maxBotLinkService?.getBotTokenSync() ??
      configuredBotTokens[0] ??
      configService.getOrThrow<string>('MAX_BOT_TOKEN');
    this.maxBotTokenValidationSecrets =
      this.maxBotLinkService?.getValidationTokens() ??
      (configuredBotTokens.length > 0 ? configuredBotTokens : [this.maxBotToken]);
    this.appBaseUrl = this.normalizeAppBaseUrl(configService.get<string>('APP_BASE_URL'));
    this.explicitBotContactId = this.normalizeBotContactId(
      configService.get<string>('MAX_BOT_CONTACT_ID'),
    );
    this.ownBotUserId = this.normalizeOwnBotUserId(configService.get<string>('MAX_BOT_ID'));
    const registryBotIds =
      typeof this.maxBotRegistry?.getAllBots === 'function'
        ? this.maxBotRegistry.getAllBots().map((bot) => bot.id)
        : [];
    this.managedEntitiesRuntimeBotIds = new Set(
      [...registryBotIds, this.readTrimmedString(configService.get<string>('MAX_BOT_ID'))].filter(
        (botId): botId is string => Boolean(botId),
      ),
    );
    this.systemAccessConfig = readSystemAccessConfig(configService);
    this.manualFanoutLookupSpacingMs = this.readNonNegativeConfigInt(
      configService.get<number>('MANUAL_FANOUT_LOOKUP_SPACING_MS'),
      process.env.NODE_ENV === 'test' ? 0 : 180,
    );
    this.manualFanoutActionSpacingMs = this.readNonNegativeConfigInt(
      configService.get<number>('MANUAL_FANOUT_ACTION_SPACING_MS'),
      process.env.NODE_ENV === 'test' ? 0 : 120,
    );
    this.managedEntitiesPublishedSnapshotReadEnabled = this.readBooleanConfigFlag(
      configService.get<string>('MANAGED_ENTITIES_SNAPSHOT_READ_ENABLED'),
      true,
    );
    this.managedEntitiesPublishedSnapshotWriteEnabled = this.readBooleanConfigFlag(
      configService.get<string>('MANAGED_ENTITIES_SNAPSHOT_WRITE_ENABLED'),
      true,
    );
    this.managedEntitiesPublishedDiffReadEnabled = this.readBooleanConfigFlag(
      configService.get<string>('MANAGED_ENTITIES_DIFF_READ_ENABLED'),
      true,
    );
    this.managedEntitiesPublishedDiffWriteEnabled = this.readBooleanConfigFlag(
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

    return new PrismaClient({
      datasources: {
        db: {
          url: dedicatedUrl,
        },
      },
    });
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

  async getMe(
    user: AuthUser,
    options: { chatId?: string; entityType?: ManagedEntityType; enrichFromMax?: boolean } = {},
  ): Promise<Me> {
    const canAccessSystem =
      this.systemAccessConfig.requireSystemAdmin &&
      canUserAccessSystem(user.userId, this.systemAccessConfig);
    const fallback: Me = {
      userId: user.userId,
      username: this.readTrimmedString(user.username) ?? null,
      displayName: this.readTrimmedString(user.displayName) ?? null,
      avatarUrl: this.readTrimmedString(user.avatarUrl) ?? null,
      profileUrl:
        this.normalizeMaxProfileUrl(this.readTrimmedString(user.profileUrl) ?? null) ??
        this.buildUserProfileUrl(this.readTrimmedString(user.username) ?? null),
      ...(canAccessSystem ? { canAccessSystem: true } : {}),
    };
    const contextChatId =
      this.readTrimmedString(options.chatId) ?? this.readTrimmedString(user.chatId);
    const loadProfiles = this.maxClient.getChatMemberProfiles?.bind(this.maxClient);

    if (
      options.enrichFromMax !== true ||
      !contextChatId ||
      typeof loadProfiles !== 'function' ||
      (fallback.username && fallback.displayName && fallback.avatarUrl && fallback.profileUrl)
    ) {
      return fallback;
    }

    try {
      const profiles = await loadProfiles(contextChatId, [user.userId], {
        trafficClass: 'interactive',
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      });
      const profile = profiles.get(user.userId);
      const username = this.readTrimmedString(profile?.username) ?? fallback.username;
      const displayName =
        fallback.displayName ?? this.readTrimmedString(profile?.displayName) ?? null;
      const avatarUrl = fallback.avatarUrl ?? this.readTrimmedString(profile?.avatarUrl) ?? null;
      const profileUrl =
        this.normalizeMaxProfileUrl(this.readTrimmedString(profile?.profileUrl) ?? null) ??
        fallback.profileUrl ??
        this.buildUserProfileUrl(username);

      return {
        userId: user.userId,
        username,
        displayName,
        avatarUrl,
        profileUrl,
        ...(canAccessSystem ? { canAccessSystem: true } : {}),
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: contextChatId,
          userId: user.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve current admin profile from MAX',
      );
      return fallback;
    }
  }

  async listChats(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ChatSummary[]> {
    const result = await this.listManagedEntitiesDetailed(user, 'chat', options);
    return result.items;
  }

  async listChatsForMassBroadcast(user: AuthUser): Promise<ChatSummary[]> {
    return this.collectManagedEntitiesForMassAction(user, 'chat');
  }

  async listChannels(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ChatSummary[]> {
    const result = await this.listManagedEntitiesDetailed(user, 'channel', options);
    return result.items;
  }

  async listChatsWithRefreshState(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResponse> {
    const result = await this.listManagedEntitiesDetailed(user, 'chat', {
      ...options,
      includeRefreshState: true,
    });
    const refresh = this.attachManagedEntitiesUserVisibleRefreshState(
      result.refresh ?? this.createManagedEntitiesRefreshState(null, false),
      {
        items: result.items,
        diff: result.diff,
      },
    );
    const response: ManagedEntitiesListResponse = {
      items: result.items,
      refresh,
    };
    if (result.snapshot) {
      response.snapshot = result.snapshot;
    }
    if (result.diff) {
      response.diff = result.diff;
    }
    return response;
  }

  async listChannelsWithRefreshState(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResponse> {
    const result = await this.listManagedEntitiesDetailed(user, 'channel', {
      ...options,
      includeRefreshState: true,
    });
    const refresh = this.attachManagedEntitiesUserVisibleRefreshState(
      result.refresh ?? this.createManagedEntitiesRefreshState(null, false),
      {
        items: result.items,
        diff: result.diff,
      },
    );
    const response: ManagedEntitiesListResponse = {
      items: result.items,
      refresh,
    };
    if (result.snapshot) {
      response.snapshot = result.snapshot;
    }
    if (result.diff) {
      response.diff = result.diff;
    }
    return response;
  }

  async listManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter = 'all',
    options: ManagedEntitiesListOptions = {},
  ): Promise<ChatSummary[]> {
    const result = await this.listManagedEntitiesDetailed(user, entityType, options);
    return result.items;
  }

  private attachManagedEntitiesUserVisibleRefreshState(
    refresh: ManagedEntitiesRefreshState,
    options: {
      items: readonly ChatSummary[];
      diff?: ManagedEntitiesResponseDiff | null;
    },
  ): ManagedEntitiesRefreshState {
    const userVisibleComplete =
      refresh.complete === true || options.items.length > 0 || options.diff != null;
    if (refresh.userVisibleComplete === userVisibleComplete) {
      return refresh;
    }

    return {
      ...refresh,
      userVisibleComplete,
    };
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

  async getChatBotExecutionPlan(
    chatId: string,
    user: AuthUser,
    options: { refresh?: boolean } = {},
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.getManagedEntityBotExecutionPlan(chatId, user, 'chat', options);
  }

  async getChannelBotExecutionPlan(
    chatId: string,
    user: AuthUser,
    options: { refresh?: boolean } = {},
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.getManagedEntityBotExecutionPlan(chatId, user, 'channel', options);
  }

  async updateChatPrimaryBot(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.updateManagedEntityPrimaryBot(chatId, user, 'chat', body);
  }

  async updateChannelPrimaryBot(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.updateManagedEntityPrimaryBot(chatId, user, 'channel', body);
  }

  async updateChatPartnerAssist(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.updateManagedEntityPartnerAssist(chatId, user, 'chat', body);
  }

  async updateChannelPartnerAssist(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.updateManagedEntityPartnerAssist(chatId, user, 'channel', body);
  }

  async promoteChatStandbyBot(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.promoteManagedEntityStandbyBot(chatId, user, 'chat', body);
  }

  async promoteChannelStandbyBot(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.promoteManagedEntityStandbyBot(chatId, user, 'channel', body);
  }

  private async getManagedEntityBotExecutionPlan(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    options: { refresh?: boolean } = {},
  ): Promise<ManagedEntityBotExecutionPlan> {
    await this.assertChatAdmin(chatId, user.userId, entityType);
    await this.ensureEntityType(chatId, user.userId, entityType);

    if (!this.maxBotExecutionPlanner) {
      throw new ServiceUnavailableException(
        'Bot execution planner is not available on this runtime.',
      );
    }

    return managedEntityBotExecutionPlanSchema.parse(
      await this.maxBotExecutionPlanner.getManagedEntityExecutionPlan({
        chatId,
        entityType,
        refreshCapabilities: options.refresh === true,
      }),
    );
  }

  private async updateManagedEntityPrimaryBot(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    await this.assertChatAdmin(chatId, user.userId, entityType);
    await this.ensureEntityType(chatId, user.userId, entityType);

    if (!this.maxBotExecutionPlanner) {
      throw new ServiceUnavailableException(
        'Bot execution planner is not available on this runtime.',
      );
    }

    const request = updateManagedEntityPrimaryBotRequestSchema.parse(
      body,
    ) as UpdateManagedEntityPrimaryBotRequest;
    const plan = await this.maxBotExecutionPlanner.setPrimaryBot({
      chatId,
      entityType,
      botId: request.botId,
    });
    await this.chatContextCache.invalidateManagedEntityHeader?.(chatId);
    return managedEntityBotExecutionPlanSchema.parse(plan);
  }

  private async updateManagedEntityPartnerAssist(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    await this.assertChatAdmin(chatId, user.userId, entityType);
    await this.ensureEntityType(chatId, user.userId, entityType);

    if (!this.maxBotExecutionPlanner) {
      throw new ServiceUnavailableException(
        'Bot execution planner is not available on this runtime.',
      );
    }

    const request = updateManagedEntityPartnerAssistRequestSchema.parse(
      body,
    ) as UpdateManagedEntityPartnerAssistRequest;
    const plan = await this.maxBotExecutionPlanner.setPartnerAssist({
      chatId,
      entityType,
      botId: request.botId,
      enabled: request.enabled,
    });
    await this.chatContextCache.invalidateManagedEntityHeader?.(chatId);
    return managedEntityBotExecutionPlanSchema.parse(plan);
  }

  private async promoteManagedEntityStandbyBot(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    await this.assertChatAdmin(chatId, user.userId, entityType);
    await this.ensureEntityType(chatId, user.userId, entityType);

    if (!this.maxBotExecutionPlanner) {
      throw new ServiceUnavailableException(
        'Bot execution planner is not available on this runtime.',
      );
    }

    const request = promoteManagedEntityStandbyRequestSchema.parse(body);
    const plan = await this.maxBotExecutionPlanner.promoteStandby({
      chatId,
      entityType,
      botId: request.botId ?? null,
    });
    await this.chatContextCache.invalidateManagedEntityHeader?.(chatId);
    return managedEntityBotExecutionPlanSchema.parse(plan);
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
      return this.mergeManagedEntitiesWithLightweightBootstrap(items, await loadLightweightBootstrap());
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
          this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items);
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
        this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items);
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
        this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items);
        return {
          items,
          refresh:
            options.includeRefreshState === true
              ? await this.readLocalManagedEntitiesRefreshState(user.userId, entityType)
              : null,
        };
      }

      const warmupPromise = this.startManagedEntitiesResponseWarmup(user, entityType, {
        bypassRemoteCache: options.bypassRemoteCache === true,
        resetRefreshCursor: options.resetRefreshCursor === true,
        includeRefreshState: options.includeRefreshState === true,
      });
      const discovered = await this.awaitManagedEntitiesResponseValueWithinBudget(warmupPromise, {
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
      });
      const discoveredItems = this.mergeManagedEntityGroups(initial, discovered.items);
      const items =
        discoveredItems.length > 0
          ? await this.attachManagedEntityBotAssignments(
              await this.hydrateManagedEntities(discoveredItems),
            )
          : [];
      this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items);

      return {
        items,
        refresh: discovered.refresh,
      };
    }

    const eagerWarmupPromise =
      options.bypassRemoteCache === true || options.resetRefreshCursor === true
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
      (cached.length === 0
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

      const filteredItems = this.filterManagedEntitiesToRuntimeScope(
        snapshot.items.map((item) => this.cloneManagedEntitySummary(item)),
        { requireKnownBot: true },
      );
      if (filteredItems.length !== snapshot.items.length) {
        this.scheduleManagedEntitiesPublishedSnapshotRebuild(userId, entityType);
      }

      return {
        items: filteredItems,
        version: snapshot.version,
        builtAt: snapshot.builtAt,
        lastSyncedAt: snapshot.lastSyncedAt,
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
        this.isFallbackTitle(summary.id, existing.title) && !this.isFallbackTitle(summary.id, summary.title)
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

  private async writeManagedEntitiesPublishedSnapshotPatched(
    userId: string,
    entityType: ManagedEntityType,
    currentSnapshot: ManagedEntitiesPublishedSnapshot,
    items: readonly ChatSummary[],
  ): Promise<void> {
    if (typeof this.chatContextCache.setManagedEntitiesPublishedSnapshot !== 'function') {
      return;
    }

    const nextSnapshot: ManagedEntitiesPublishedSnapshot = {
      version: randomUUID(),
      builtAt: new Date().toISOString(),
      lastSyncedAt: currentSnapshot.lastSyncedAt,
      itemCount: items.length,
      itemsHash: this.buildManagedEntitiesPublishedSnapshotHash(items, currentSnapshot.lastSyncedAt),
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
    }> = [];
    const seen = new Set<string>();

    for (const row of [
      ...(Array.isArray(userScopedRows) ? userScopedRows : []).map((item) => ({
        ...item,
        user_scoped: true,
      })),
      ...(Array.isArray(globalRows) ? globalRows : []).map((item) => ({
        ...item,
        user_scoped: false,
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
    const refreshCursor =
      typeof this.chatContextCache.getManagedEntitiesRefreshCursor === 'function'
        ? await this.chatContextCache.getManagedEntitiesRefreshCursor(userId, entityType)
        : null;
    if (
      currentSnapshot &&
      typeof refreshCursor === 'number' &&
      refreshCursor >= 0 &&
      refreshCursor !== MANAGED_ENTITIES_REFRESH_CURSOR_DONE
    ) {
      return;
    }

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
    const snapshotIds = new Set(items.map((item) => item.id));
    const recentBotAdded = bootstrap.recentBotAdded.filter((chat) => !snapshotIds.has(chat.id));
    const bootstrapCandidates = this.mergeManagedEntityGroups(recentBotAdded);
    if (bootstrapCandidates.length === 0) {
      return items.map((item) => this.cloneManagedEntitySummary(item));
    }

    const hydratedBootstrap = await this.attachManagedEntityBotAssignments(
      await this.hydrateManagedEntities(bootstrapCandidates),
    );
    const hydratedById = new Map(hydratedBootstrap.map((item) => [item.id, item]));

    return this.mergeManagedEntitiesWithLightweightBootstrap(items, {
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

    return this.runManagedEntitiesRemoteFullRefresh(user, job.entityType, {
      bypassRemoteCache: job.bypassRemoteCache,
      resetRefreshCursor: job.resetRefreshCursor,
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
      await this.repairManagedEntitiesAllowlistAfterFullRefresh(user.userId, entityType);
      await this.rebuildManagedEntitiesPublishedSnapshot(user.userId, entityType);
      return null;
    }

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
    return this.mergeManagedEntityGroups(
      bootstrap.recentBotAdded,
      [...items],
    );
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
        this.logger.warn(
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

  private buildManagedEntitiesRuntimeChatScopeFilter():
    | {
        OR: Array<{
          primaryBotId?: { in: string[] };
          botId?: { in: string[] };
          botMemberships?: { some: { botId: { in: string[] } } };
        }>;
      }
    | null {
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

  private cloneManagedEntitySummary(chat: ChatSummary): ChatSummary {
    return {
      ...chat,
      channelOverview: chat.channelOverview ? { ...chat.channelOverview } : null,
      assignedBots: Array.isArray(chat.assignedBots)
        ? chat.assignedBots.map((bot) => ({ ...bot }))
        : [],
    };
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
      if (hintedEntityType === 'chat' && this.isPrivateDirectChat(chatId)) {
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
          WHERE NULLIF(BTRIM(normalized_payload->'message'->>'senderId'), '') = ${normalizedUserId}
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
        this.isPrismaKnownError(error, 'P2024')
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
    source:
      | 'remote_discovery'
      | 'local_discovery'
      | 'recent_bot_added_bootstrap';
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
            params.source === 'recent_bot_added_bootstrap'
              ? 'fallback_only'
              : 'always',
        },
      );

      const summary = this.createManagedEntitySummary({
        id: persistedChat.id,
        title: persistedChat.title,
        createdAt: persistedChat.createdAt.toISOString(),
        entityType: this.fromPrismaEntityType(persistedChat.entityType),
        link: params.link ?? null,
        avatarUrl: params.avatarUrl ?? null,
        primaryBotId:
          this.readTrimmedString(persistedChat.primaryBotId ?? persistedChat.botId) ?? null,
      });
      this.rememberManagedEntitiesLastSuccessChats(params.userId, [summary]);

      return summary;
    } catch (error: unknown) {
      if (!this.isPrismaKnownError(error, 'P2024')) {
        throw error;
      }

      const resolvedBotId =
        this.maxBotRegistry?.getBotById(params.preferredBotId)?.id ??
        (params.observedBotIds ?? [])
          .map((botId) => this.maxBotRegistry?.getBotById(botId)?.id ?? null)
          .find((botId): botId is string => Boolean(botId)) ??
        null;
      if (resolvedBotId) {
        this.maxBotLinkService?.rememberChatBotBinding(params.chatId, resolvedBotId);
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
          this.resolvePresentableManagedEntityTitle(params.chatId, params.title, null, null) ??
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
  ): Promise<ChatSummary[]> {
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
        if (collected.size > 0 && this.isMaxApiThrottleError(error)) {
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
      if (this.isUnsupportedManagedChat(chatId, hintedEntityType)) {
        this.schedulePersistedChatAccessPrune(
          chatId,
          normalizedUserId,
          'bootstrap_recent_bot_added',
        );
        continue;
      }

      const elapsedMs = Date.now() - startedAtMs;
      if (elapsedMs >= RECENT_BOT_ADDED_BOOTSTRAP_MAX_ELAPSED_MS) {
        this.logger.warn(
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
        this.logger.warn(
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
        trafficClass: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        timeoutMs: RECENT_BOT_ADDED_BOOTSTRAP_ADMIN_TIMEOUT_MS,
      });
      if (access.status === 'unknown' || access.status === 'throttled') {
        const provisional = await this.buildRecentBotAddedProvisionalChat({
          row,
          userId: normalizedUserId,
          entityType,
          hintedEntityType,
          prisma: managedEntitiesReadPrisma,
        });
        if (provisional) {
          bootstrapped.push(provisional);
        }
        if (row.user_scoped) {
          this.scheduleUserScopedRecentBotAddedFastLane({
            chatId,
            entityType: hintedEntityType,
            title: this.readTrimmedString(row.chat_title),
            userId: normalizedUserId,
            reason: access.status,
          });
        }
        this.logger.warn(
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
        const provisional =
          row.user_scoped && access.reason === 'bot_not_admin'
            ? await this.buildRecentBotAddedProvisionalChat({
                row,
                userId: normalizedUserId,
                entityType,
                hintedEntityType,
                prisma: managedEntitiesReadPrisma,
              })
            : null;
        if (provisional) {
          bootstrapped.push(provisional);
        }
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
        this.resolvePresentableManagedEntityTitle(
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
    }>
  > {
    if (typeof this.chatContextCache.getManagedEntitiesRecentBootstrap !== 'function') {
      return [];
    }

    const normalizedUserId = userId.trim();
    const entityTypes: ManagedEntityType[] =
      entityType === 'all' ? ['chat', 'channel'] : [entityType];
    const groups = await Promise.all(
      entityTypes.map((currentEntityType) =>
        this.chatContextCache.getManagedEntitiesRecentBootstrap?.(currentEntityType) ??
        Promise.resolve([]),
      ),
    );

    return this.mergeRecentBotAddedBootstrapRows(
      ...groups.map((group) =>
        group
          .filter((chat) => !this.isUnsupportedManagedChat(chat.id, chat.entityType))
          .map((chat) => ({
            chat_id: chat.id,
            chat_title: chat.title,
            is_channel: chat.entityType === 'channel' ? 'true' : 'false',
            user_scoped:
              normalizedUserId.length > 0 &&
              Array.isArray(chat.bootstrapUserIds) &&
              chat.bootstrapUserIds.some((candidateUserId) => candidateUserId === normalizedUserId),
            last_event_at: this.readTrimmedString(chat.createdAt),
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
      }>
    >
  ): Array<{
    chat_id: string | null;
    chat_title: string | null;
    is_channel: string | null;
    user_scoped: boolean;
    last_event_at: Date | string | null;
  }> {
    const merged = new Map<
      string,
      {
        chat_id: string | null;
        chat_title: string | null;
        is_channel: string | null;
        user_scoped: boolean;
        last_event_at: Date | string | null;
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

    const eventAtMs = this.readRecentBotAddedEventTimestampMs(params.row.last_event_at);
    if (eventAtMs === null || Date.now() - eventAtMs > RECENT_BOT_ADDED_FAST_LANE_RETRY_WINDOW_MS) {
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

    const resolvedTitle =
      this.resolvePresentableManagedEntityTitle(
        chatId,
        this.readTrimmedString(params.row.chat_title),
        this.readTrimmedString(cachedHeader?.title),
        this.readTrimmedString(existing?.title),
      ) ??
      (params.hintedEntityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`);

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
    if (!this.isFallbackTitle(chat.id, chat.title)) {
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
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
          ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
          timeoutMs: RECENT_BOT_ADDED_BOOTSTRAP_HEADER_TIMEOUT_MS,
          bypassCache: true,
          ...(botId ? { botId } : {}),
        });

        const resolvedTitle =
          this.resolvePresentableManagedEntityTitle(chat.id, snapshot.title, chat.title) ??
          chat.title;
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
        if (this.isBotAdminLookupDeniedError(error)) {
          continue;
        }

        if (this.isMaxApiThrottleError(error) || this.isMaxApiTimeoutError(error)) {
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
        trafficClass?: 'interactive';
        sourceTag?: string;
        timeoutMs?: number;
      };
    }> = [
      ...staleDeniedChats.map((candidate) => ({
        ...candidate,
        strict: true,
        options: {
          bypassNegativeCache: true as const,
        },
      })),
      ...suspiciousChatsToRevalidate.map((candidate) => ({
        ...candidate,
        strict: false,
        options: {
          bypassNegativeCache: true as const,
          trafficClass: 'interactive' as const,
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
          timeoutMs: MANAGED_ENTITIES_SUSPICIOUS_ALLOWLIST_ADMIN_TIMEOUT_MS,
        },
      })),
    ];

    if (revalidationCandidates.length > 0) {
      const revalidatedChats = await this.mapWithConcurrencyLimit(
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
    return this.resolvePresentableManagedEntityTitle(chat.id, chat.title) === null;
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
  ): Promise<void> {
    const allowlist = await this.listChatsFromAllowlist(userId, entityType);
    if (allowlist.length === 0) {
      return;
    }

    await this.mapWithConcurrencyLimit(allowlist, 8, async (chat) => {
      if (!this.isFallbackTitle(chat.id, chat.title)) {
        return null;
      }

      const cachedHeader = await this.chatContextCache.getManagedEntityHeader?.(
        chat.id,
        chat.entityType,
      );
      const presentableTitle = this.resolvePresentableManagedEntityTitle(
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
    const prioritizedCandidateIds = new Set(
      staleDeniedCachedCandidates.map((chat) => chat.chatId),
    );
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
      const resolvedChats = await this.mapWithConcurrencyLimit(
        candidateSlice,
        LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
        async (candidate) => {
          const access = await this.resolveUserAndBotAdminAccess(candidate.chatId, user.userId, {
            bypassNegativeCache: true,
            trafficClass: options.fullScan ? 'background' : 'interactive',
            sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
            timeoutMs: MANAGED_ENTITIES_LOCAL_DISCOVERY_ADMIN_TIMEOUT_MS,
          });
          if (access.status === 'throttled') {
            throw new ManagedEntitiesRefreshThrottledError(access.error);
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

      return {
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
    } catch (error: unknown) {
      if (
        this.isManagedEntitiesRefreshThrottledError(error) ||
        this.isMaxApiThrottleError(error) ||
        this.isMaxApiTimeoutError(error)
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
                  this.isMaxApiThrottleError(error) ||
                  this.isMaxApiTimeoutError(error),
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
      const discoveryTrafficClass = options.fullScan ? 'background' : 'interactive';
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
      const resolvedChats = await this.mapWithConcurrencyLimit(
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
            trafficClass: discoveryTrafficClass,
            sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
            timeoutMs: adminCheckTimeoutMs,
          });
          if (access.status === 'throttled') {
            throw new ManagedEntitiesRefreshThrottledError(access.error);
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
      return {
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
    } catch (error: unknown) {
      if (
        this.isManagedEntitiesRefreshThrottledError(error) ||
        this.isMaxApiThrottleError(error) ||
        this.isMaxApiTimeoutError(error)
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
                  this.isMaxApiThrottleError(error) ||
                  this.isMaxApiTimeoutError(error),
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
      const legacyChats = await this.maxClient.listBotChats({
        trafficClass: options.trafficClass,
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        ...(options.bypassCache === true ? { bypassCache: true } : {}),
        ...(typeof options.timeoutMs === 'number' ? { timeoutMs: options.timeoutMs } : {}),
      });
      const candidateChats =
        entityType === 'all'
          ? legacyChats
          : legacyChats.filter((chat) => chat.entityType === entityType);
      const supportedChats = candidateChats.filter(
        (chat) => !this.isUnsupportedManagedChat(chat.chatId, chat.entityType),
      );
      this.scheduleManagedEntitiesCatalogSync(supportedChats, options.trafficClass);

      return supportedChats;
    }

    const remoteGroups = await Promise.all(
      discoveryBots.map(async (bot) => {
        const chats = await this.maxClient.listBotChats({
          trafficClass: options.trafficClass,
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
          ...(options.bypassCache === true ? { bypassCache: true } : {}),
          ...(typeof options.timeoutMs === 'number' ? { timeoutMs: options.timeoutMs } : {}),
          botId: bot.id,
        });

        return chats.map((chat) => ({
          ...chat,
          botId: bot.id,
          botIds: Array.from(new Set([...(chat.botIds ?? []), bot.id])),
        }));
      }),
    );

    const remoteChats = this.mergeManagedEntitiesDiscoverySnapshots(...remoteGroups);
    const candidateChats =
      entityType === 'all'
        ? remoteChats
        : remoteChats.filter((chat) => chat.entityType === entityType);
    const supportedChats = candidateChats.filter(
      (chat) => !this.isUnsupportedManagedChat(chat.chatId, chat.entityType),
    );
    this.scheduleManagedEntitiesCatalogSync(supportedChats, options.trafficClass);
    return supportedChats;
  }

  private scheduleManagedEntitiesCatalogSync(
    chats: readonly MaxBotChat[],
    trafficClass: 'critical' | 'interactive' | 'background',
  ): void {
    if (!this.maxChatAdminRosterSyncService || chats.length === 0) {
      return;
    }

    const syncCandidates =
      trafficClass === 'background'
        ? chats.slice(0, MANAGED_ENTITIES_BACKGROUND_CATALOG_SYNC_WINDOW_SIZE)
        : chats.slice(0, MANAGED_ENTITIES_DELTA_DISCOVERY_WINDOW_SIZE);
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

    const now = new Date();
    const from = this.resolveChannelStatsFrom(parsed.data.range, now);
    const bucket = this.resolveChannelStatsBucket(parsed.data.range);

    try {
      await this.channelStatsCollector?.syncChannelIfStale(chatId, {
        staleMs: CHANNEL_STATS_REFRESH_STALE_MS,
        reason: 'stats_endpoint',
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh channel stats opportunistically',
      );
    }

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
          publishedAt: true,
          latestViews: true,
          latestReactions: true,
          latestReactionsTotal: true,
        },
      }),
      this.prisma.channelPost.findFirst({
        where: { chatId },
        select: { id: true },
      }),
      this.getMembershipEventRows(chatId, from, now, ['user_added', 'user_removed'], {
        order: 'asc',
      }),
    ]);

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
    let joined = 0;
    let left = 0;
    for (const row of membershipRows) {
      if (row.event_type === 'user_added') {
        joined += 1;
      } else if (row.event_type === 'user_removed') {
        left += 1;
      }
    }

    const bucketStarts = this.buildChannelStatsBucketStarts(from, now, bucket);
    const topReactions = this.buildTopReactions(periodPosts);
    const activityFeed = await this.getMembershipActivityFeedPage(
      chatId,
      from,
      now,
      {
        range: parsed.data.range,
        filter: 'all',
        limit: MEMBERSHIP_ACTIVITY_PAGE_LIMIT,
      },
      'channel',
    );
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
        range: parsed.data.range,
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
          posts: periodPosts.length,
          views: periodPosts.reduce((total, item) => total + Math.max(0, item.latestViews), 0),
          reactions: periodPosts.reduce(
            (total, item) => total + this.toSafeInteger(item.latestReactionsTotal),
            0,
          ),
          topReactions,
          lastPublishedAt:
            periodPosts.length > 0
              ? periodPosts[periodPosts.length - 1].publishedAt.toISOString()
              : null,
        },
        series: {
          participants: this.buildParticipantSeries(
            bucketStarts,
            bucket,
            previousAudienceSnapshot?.participantsCount ?? null,
            audienceSnapshots,
          ),
          membership: this.buildMembershipSeries(bucketStarts, bucket, membershipRows),
          views: this.buildViewsSeries(bucketStarts, bucket, periodPosts),
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
      },
      activityFeed,
    };

    return channelStatsResponseSchema.parse(response);
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
    if (!options.skipAdminCheck) {
      await this.assertReadOnlyChatAdmin(chatId, user.userId, 'chat');
    }
    if (!options.skipEntityCheck) {
      await this.ensureEntityType(chatId, user.userId, 'chat');
    }
    const resolvedBotId = await this.resolveChatBotIdForRead(chatId);

    const chat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Chat ${chatId}`,
        entityType: ChatEntityType.CHAT,
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        settings: {
          create: {},
        },
      },
      update: {
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        settings: {
          upsert: {
            update: {},
            create: {},
          },
        },
      },
      include: { settings: true },
    });

    if (!chat.settings) {
      throw new Error('Chat settings missing after upsert');
    }

    const sanitizedStoredSettings = this.sanitizeStoredChatSettings(chat.settings);
    const parsed = chatSettingsSchema.safeParse(sanitizedStoredSettings);
    if (parsed.success) {
      const normalizedSettings = this.normalizeChatSettings(parsed.data, undefined, chatId);
      const normalizationChanges = {
        ...this.getStoredChatSettingsSanitizationChanges(chat.settings, parsed.data),
        ...this.getChatSettingsNormalizationChanges(parsed.data, normalizedSettings),
      };
      if (Object.keys(normalizationChanges).length > 0) {
        await this.prisma.chatSettings.update({
          where: { chatId },
          data: normalizationChanges,
        });
        await this.chatContextCache.invalidate(chatId);
      }

      return normalizedSettings;
    }

    this.logger.warn(
      {
        chatId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      'Invalid chat settings found in DB, applying defaults',
    );

    const fallback = DEFAULT_CHAT_SETTINGS;
    await this.prisma.chatSettings.update({
      where: { chatId },
      data: {
        ...fallback,
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return fallback;
  }

  async getChatSettingsScreen(chatId: string, user: AuthUser): Promise<ChatSettingsScreenResponse> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'chat');
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
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');
    const parsed = chatSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const currentSettings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      select: {
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: true,
        nightModeForceCloseHours: true,
        nightModeForceCloseDays: true,
        nightModeForceCloseUntil: true,
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: true,
        requiredSubscriptionDurationDays: true,
        requiredSubscriptionExpiresAt: true,
      },
    });
    const normalizedSettings = this.normalizeChatSettings(
      parsed.data,
      {
        nightModeForceCloseEnabled: currentSettings?.nightModeForceCloseEnabled ?? false,
        nightModeForceCloseForever: currentSettings?.nightModeForceCloseForever ?? false,
        nightModeForceCloseHours: currentSettings?.nightModeForceCloseHours ?? 0,
        nightModeForceCloseDays: currentSettings?.nightModeForceCloseDays ?? 0,
        nightModeForceCloseUntil: currentSettings?.nightModeForceCloseUntil ?? '',
        requiredSubscriptionEnabled: currentSettings?.requiredSubscriptionEnabled ?? false,
        requiredSubscriptionChannelIds: Array.isArray(
          currentSettings?.requiredSubscriptionChannelIds,
        )
          ? currentSettings.requiredSubscriptionChannelIds
              .filter((item): item is string => typeof item === 'string')
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
          : [],
        requiredSubscriptionDurationDays:
          currentSettings?.requiredSubscriptionDurationDays ??
          REQUIRED_SUBSCRIPTION_DURATION_DAYS_DEFAULT,
        requiredSubscriptionExpiresAt: this.normalizeRequiredSubscriptionExpiresAt(
          currentSettings?.requiredSubscriptionExpiresAt,
        ),
      },
      chatId,
    );
    await this.assertRequiredSubscriptionSettings(normalizedSettings);
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
            ...normalizedSettings,
          },
        },
      },
      update: {
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        settings: {
          upsert: {
            update: {
              ...normalizedSettings,
            },
            create: {
              ...normalizedSettings,
            },
          },
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'UPDATE_SETTINGS',
        payload: {
          ...normalizedSettings,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);
    await this.refreshExecutionReadinessAfterChatSettingsUpdate(chatId, normalizedSettings);

    return normalizedSettings;
  }

  async getRules(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChatRules> {
    if (!options.skipAdminCheck) {
      await this.assertReadOnlyChatAdmin(chatId, user.userId, 'chat');
    }
    if (!options.skipEntityCheck) {
      await this.ensureEntityType(chatId, user.userId, 'chat');
    }

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
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const parsed = updateChatRulesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalizedDraft = this.normalizeChatRulesDraft(parsed.data);
    if (normalizedDraft.imageBase64) {
      const imageBuffer = this.decodeRulesImageBase64(normalizedDraft.imageBase64);
      if (imageBuffer.length > RULES_IMAGE_MAX_BYTES) {
        throw new BadRequestException('Фото правил слишком большое. Максимум 1 MB.');
      }
      if (!normalizedDraft.imageMimeType.toLowerCase().startsWith('image/')) {
        throw new BadRequestException('Поддерживаются только изображения.');
      }
    }

    const rules = await this.prisma.chatRules.upsert({
      where: { chatId },
      create: {
        chatId,
        ...normalizedDraft,
      },
      update: {
        ...normalizedDraft,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'UPDATE_CHAT_RULES',
        payload: {
          autoTextEnabled: normalizedDraft.autoTextEnabled,
          buttonEnabled: normalizedDraft.buttonEnabled,
          hasImage: Boolean(normalizedDraft.imageBase64),
          textLength: normalizedDraft.text.length,
          source,
        },
      },
    });
    await this.chatContextCache?.invalidate(chatId);

    return this.mapChatRules(rules);
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
        const formattedSourceText = await maxClientWithMessageMarkdown.getMessageTextAsMarkdown(
          sourceMessageId,
        );
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
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const rules = await this.upsertChatRules(chatId);
    const previousPublishedMessageId = rules.publishedMessageId?.trim() || null;
    const autofilledText =
      rules.autoTextEnabled && !rules.text.trim()
        ? await this.buildAutofilledRulesTextFromCurrentSettings(chatId, user)
        : null;
    const messageText = (autofilledText ?? rules.text).trim();
    if (!messageText) {
      throw new BadRequestException('Сначала заполните текст правил.');
    }
    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);

    let imagePayload: Record<string, unknown> | undefined;
    if (rules.imageBase64.trim()) {
      const imageMimeType = rules.imageMimeType.trim().toLowerCase();
      if (!imageMimeType.startsWith('image/')) {
        throw new BadRequestException('Поддерживаются только изображения.');
      }

      const imageBuffer = this.decodeRulesImageBase64(rules.imageBase64);
      if (imageBuffer.length > RULES_IMAGE_MAX_BYTES) {
        throw new BadRequestException('Фото правил слишком большое. Максимум 1 MB.');
      }

      try {
        imagePayload = resolvedBotId
          ? await this.maxClient.uploadImage(
              imageBuffer,
              this.resolveRulesImageFileName(rules.imageFileName, imageMimeType),
              imageMimeType,
              { botId: resolvedBotId },
            )
          : await this.maxClient.uploadImage(
              imageBuffer,
              this.resolveRulesImageFileName(rules.imageFileName, imageMimeType),
              imageMimeType,
            );
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            actorUserId: user.userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Rules image upload failed',
        );
        throw new BadRequestException(
          'Не удалось загрузить фото правил. Попробуйте другое изображение.',
        );
      }
    }

    let published: { messageId: string; url: string | null };
    const buttonRows = this.buildChatRulesButtonRows(rules);
    const formattedMessage = this.buildFormattedRulesPublicationText(messageText);
    try {
      published = await this.publishMessageWithRetry(
        chatId,
        formattedMessage.text,
        {
          textFormat: formattedMessage.textFormat,
          ...(imagePayload ? { imagePayload } : {}),
          ...(buttonRows ? { buttons: buttonRows } : {}),
        },
        resolvedBotId,
      );
    } catch (error: unknown) {
      const maxApiMessage = this.extractMaxApiErrorMessage(error);
      throw new BadRequestException(maxApiMessage || 'Не удалось опубликовать правила.');
    }

    if (previousPublishedMessageId && previousPublishedMessageId !== published.messageId) {
      try {
        if (resolvedBotId) {
          await this.maxClient.deleteMessage(chatId, previousPublishedMessageId, {
            immediate: true,
            botId: resolvedBotId,
          });
        } else {
          await this.maxClient.deleteMessage(chatId, previousPublishedMessageId, {
            immediate: true,
          });
        }
      } catch (error: unknown) {
        if (!this.isMaxMessageMissingError(error)) {
          this.logger.warn(
            {
              chatId,
              actorUserId: user.userId,
              messageId: previousPublishedMessageId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to delete previous published chat rules post during republish',
          );
        }
      }
    }

    const publishedAt = new Date();
    await this.prisma.chatRules.update({
      where: { chatId },
      data: {
        ...(autofilledText !== null ? { text: autofilledText } : {}),
        publishedMessageId: published.messageId,
        publishedUrl: published.url,
        publishedAt,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'PUBLISH_CHAT_RULES',
        payload: {
          messageId: published.messageId,
          url: published.url,
          publishedAt: publishedAt.toISOString(),
          buttonEnabled: rules.buttonEnabled,
          hasImage: Boolean(imagePayload),
          autofilledTextApplied: autofilledText !== null,
          replacedPreviousPost: Boolean(
            previousPublishedMessageId && previousPublishedMessageId !== published.messageId,
          ),
          source,
        },
      },
    });

    const hydratedRules = await this.hydratePublishedRulesUrl(chatId, {
      ...rules,
      ...(autofilledText !== null ? { text: autofilledText } : {}),
      publishedMessageId: published.messageId,
      publishedUrl: published.url,
      publishedAt,
    });
    await this.chatContextCache?.invalidate(chatId);

    if (source === 'miniapp') {
      await this.sendRulesPublishedPrivateConfirmation(user, hydratedRules.publishedUrl);
    }

    return publishChatRulesResultSchema.parse({
      chatId,
      messageId: published.messageId,
      url: hydratedRules.publishedUrl,
      publishedAt: publishedAt.toISOString(),
    });
  }

  async resetPublishedRules(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChatRules> {
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const rules = await this.upsertChatRules(chatId);
    const publishedMessageId = rules.publishedMessageId?.trim() ?? '';
    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);

    if (publishedMessageId) {
      try {
        if (resolvedBotId) {
          await this.maxClient.deleteMessage(chatId, publishedMessageId, {
            immediate: true,
            botId: resolvedBotId,
          });
        } else {
          await this.maxClient.deleteMessage(chatId, publishedMessageId, { immediate: true });
        }
      } catch (error: unknown) {
        if (!this.isMaxMessageMissingError(error)) {
          const maxApiMessage = this.extractMaxApiErrorMessage(error);
          throw new BadRequestException(
            maxApiMessage || 'Не удалось удалить опубликованный пост правил.',
          );
        }
      }
    }

    const updatedRules = await this.prisma.chatRules.update({
      where: { chatId },
      data: {
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'RESET_CHAT_RULES_PUBLICATION',
        payload: {
          deletedPost: Boolean(publishedMessageId),
          messageId: publishedMessageId || null,
          source,
        },
      },
    });
    await this.chatContextCache?.invalidate(chatId);

    return this.mapChatRules(updatedRules);
  }

  async getChatPoll(chatId: string, user: AuthUser): Promise<ManagedPoll> {
    return this.getManagedPoll(chatId, user, 'chat');
  }

  async updateChatPoll(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    return this.updateManagedPoll(chatId, user, 'chat', body, source);
  }

  async publishChatPoll(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    return this.publishManagedPoll(chatId, user, 'chat', source);
  }

  async closeChatPoll(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    return this.closeManagedPoll(chatId, user, 'chat', source);
  }

  async getChannelPoll(chatId: string, user: AuthUser): Promise<ManagedPoll> {
    return this.getManagedPoll(chatId, user, 'channel');
  }

  async updateChannelPoll(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    return this.updateManagedPoll(chatId, user, 'channel', body, source);
  }

  async publishChannelPoll(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    return this.publishManagedPoll(chatId, user, 'channel', source);
  }

  async closeChannelPoll(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    return this.closeManagedPoll(chatId, user, 'channel', source);
  }

  async getChannelSettings(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChannelSettings> {
    if (!options.skipAdminCheck) {
      await this.assertReadOnlyChatAdmin(chatId, user.userId, 'channel');
    }
    if (!options.skipEntityCheck) {
      await this.ensureEntityType(chatId, user.userId, 'channel');
    }
    const resolvedBotId = await this.resolveChatBotIdForRead(chatId);

    const chat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Channel ${chatId}`,
        entityType: ChatEntityType.CHANNEL,
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        channelSettings: {
          create: {
            commentsEnabled: false,
          },
        },
      },
      update: {
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        entityType: ChatEntityType.CHANNEL,
        channelSettings: {
          upsert: {
            update: {},
            create: {
              commentsEnabled: false,
            },
          },
        },
      },
      include: { channelSettings: true },
    });

    if (!chat.channelSettings) {
      throw new Error('Channel settings missing after upsert');
    }

    const sanitizedStoredSettings = this.sanitizeStoredChannelSettings(chat.channelSettings);
    const parsed = channelSettingsSchema.safeParse(sanitizedStoredSettings);
    if (parsed.success) {
      const normalized = this.normalizeChannelSettings(parsed.data, chatId);
      const normalizationChanges = {
        ...this.getStoredChannelSettingsSanitizationChanges(chat.channelSettings, parsed.data),
        ...this.getChannelSettingsNormalizationChanges(parsed.data, normalized),
      };
      if (Object.keys(normalizationChanges).length > 0) {
        await this.prisma.channelSettings.update({
          where: { chatId },
          data: normalizationChanges,
        });
      }
      return normalized;
    }

    this.logger.warn(
      {
        chatId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      'Invalid channel settings found in DB, applying defaults',
    );

    const fallback = channelSettingsSchema.parse({});
    await this.prisma.channelSettings.update({
      where: { chatId },
      data: {
        ...fallback,
      },
    });

    return fallback;
  }

  async getChannelSettingsScreen(
    chatId: string,
    user: AuthUser,
  ): Promise<ChannelSettingsScreenResponse> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'channel');
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
    await this.assertChatAdmin(chatId, user.userId, 'channel');
    await this.ensureEntityType(chatId, user.userId, 'channel');
    const parsed = channelSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const normalizedSettings = this.normalizeChannelSettings(parsed.data, chatId);
    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Channel ${chatId}`,
        entityType: ChatEntityType.CHANNEL,
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        channelSettings: {
          create: {
            ...normalizedSettings,
          },
        },
      },
      update: {
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        entityType: ChatEntityType.CHANNEL,
        channelSettings: {
          upsert: {
            update: {
              ...normalizedSettings,
            },
            create: {
              ...normalizedSettings,
            },
          },
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'UPDATE_CHANNEL_SETTINGS',
        payload: {
          ...normalizedSettings,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);
    await this.refreshExecutionReadinessAfterChannelSettingsUpdate(chatId);

    return normalizedSettings;
  }

  async publishChannelEngagementMessage(chatId: string, user: AuthUser, body: unknown) {
    await this.assertChatAdmin(chatId, user.userId, 'channel');
    await this.ensureEntityType(chatId, user.userId, 'channel');

    const parsed = publishChannelEngagementRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const persistedSettings = await this.prisma.channelSettings.upsert({
      where: { chatId },
      create: {
        chatId,
        commentsEnabled: false,
      },
      update: {},
      select: {
        engagementPublishedMessageId: true,
        engagementPublishedThreadId: true,
        engagementPublishedAt: true,
      },
    });
    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);

    const existingPublishedMessageId = persistedSettings.engagementPublishedMessageId?.trim() ?? '';
    const existingThreadId = persistedSettings.engagementPublishedThreadId?.trim() ?? '';
    const threadId = existingThreadId || randomUUID();
    const commentsUrl = this.buildChannelDialogLaunchUrl(chatId, 'comments', threadId);
    const suggestPayload = this.buildChannelSuggestionStartPayload(chatId, threadId);
    const suggestUrl =
      this.buildBotStartUrl(suggestPayload) ??
      this.buildChannelDialogLaunchUrl(chatId, 'suggest', threadId);
    const commentsButton = this.buildChannelDialogButton(
      chatId,
      'comments',
      threadId,
      formatCommentsButtonText(parsed.data.commentsButtonText, 0),
    );
    const suggestButton = this.buildChannelDialogButton(
      chatId,
      'suggest',
      threadId,
      parsed.data.suggestButtonText,
    );
    const buttons: MaxMessageButton[][] = [];
    if (parsed.data.includeCommentsButton) {
      buttons.push([commentsButton]);
    }
    if (parsed.data.includeSuggestButton) {
      buttons.push([suggestButton]);
    }

    let messageId = existingPublishedMessageId;
    let updatedExisting = false;
    let recreatedFromMessageId: string | null = null;
    let publishedAt = persistedSettings.engagementPublishedAt ?? null;

    if (messageId) {
      try {
        if (resolvedBotId) {
          await this.maxClient.editMessageInlineKeyboard(
            chatId,
            messageId,
            parsed.data.text,
            {
              buttons,
            } satisfies Pick<MaxSendMessageOptions, 'buttons'>,
            { botId: resolvedBotId },
          );
        } else {
          await this.maxClient.editMessageInlineKeyboard(chatId, messageId, parsed.data.text, {
            buttons,
          } satisfies Pick<MaxSendMessageOptions, 'buttons'>);
        }
        updatedExisting = true;
      } catch (error: unknown) {
        if (!this.shouldRecreateEditableMessage(error)) {
          const maxApiMessage = this.extractMaxApiErrorMessage(error);
          throw new BadRequestException(
            maxApiMessage || 'Не удалось обновить опубликованный пост с кнопками.',
          );
        }

        recreatedFromMessageId = messageId;
        messageId = '';
      }
    }

    if (!messageId) {
      try {
        const published = resolvedBotId
          ? await this.maxClient.sendMessageImmediateWithResolvedLink(
              chatId,
              parsed.data.text,
              {
                buttons,
              } satisfies MaxSendMessageOptions,
              { botId: resolvedBotId },
            )
          : await this.maxClient.sendMessageImmediateWithResolvedLink(chatId, parsed.data.text, {
              buttons,
            } satisfies MaxSendMessageOptions);
        messageId = published.messageId;
      } catch (error: unknown) {
        const maxApiMessage = this.extractMaxApiErrorMessage(error);
        throw new BadRequestException(maxApiMessage || 'Не удалось опубликовать пост с кнопками.');
      }
      publishedAt = new Date();
      updatedExisting = false;
    } else if (!publishedAt) {
      publishedAt = new Date();
    }

    await this.prisma.channelSettings.update({
      where: { chatId },
      data: {
        engagementPublishedMessageId: messageId,
        engagementPublishedThreadId: threadId,
        engagementPublishedAt: publishedAt,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: CHANNEL_DIALOG_ACTION_PUBLISH,
        payload: {
          messageId,
          text: parsed.data.text,
          commentsButtonText: parsed.data.commentsButtonText,
          suggestButtonText: parsed.data.suggestButtonText,
          includeCommentsButton: parsed.data.includeCommentsButton,
          includeSuggestButton: parsed.data.includeSuggestButton,
          threadId,
          updatedExisting,
          recreatedFromMessageId,
          commentsUrl,
          suggestPayload,
          suggestUrl,
          ...(resolvedBotId ? { botId: resolvedBotId } : {}),
        },
      },
    });

    return publishChannelEngagementResultSchema.parse({
      chatId,
      sent: true,
      messageId,
      updatedExisting,
      publishedAt: publishedAt?.toISOString() ?? null,
    });
  }

  async getChannelDialog(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    token: string | null,
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const threadId = this.resolveChannelDialogThreadId(chatId, dialogType, token);
    const action =
      dialogType === 'comments' ? CHANNEL_DIALOG_ACTION_COMMENT : CHANNEL_DIALOG_ACTION_SUGGEST;
    const [channelSettings, rows, adminUserIds] = await Promise.all([
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
    ]);

    const messages =
      rows
        .slice()
        .reverse()
        .map((row) => this.mapChannelDialogAuditLog(row, dialogType, user.userId, adminUserIds));

    return channelDialogResponseSchema.parse({
      chatId,
      type: dialogType,
      introText: this.resolveChannelDialogIntroText(channelSettings, dialogType),
      messages,
    });
  }

  async getChannelSuggestionRedirect(chatId: string, token: string | null) {
    const threadId = this.resolveChannelDialogThreadId(chatId, 'suggest', token);
    const channelSettings = await this.getPublicChannelSettings(chatId);

    if (!channelSettings.postSuggestionsEnabled && !threadId) {
      throw new BadRequestException('Предложить пост для этого канала сейчас нельзя.');
    }

    const startPayload = threadId
      ? this.buildChannelSuggestionStartPayload(chatId, threadId)
      : this.buildChannelDialogStartParam(chatId, 'suggest', '');
    const url = this.buildBotStartUrl(startPayload);
    if (!url) {
      throw new BadRequestException('Не удалось открыть диалог с ботом.');
    }

    return channelSuggestionRedirectResponseSchema.parse({
      url,
      title: null,
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
    const threadId = this.resolveChannelDialogThreadId(chatId, 'suggest', parsed.token);
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
            source: 'suggestion_review',
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
    const compactPayload = this.parseCompactChannelSuggestionStartPayload(startPayload);
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

    const threadId = this.resolveChannelDialogThreadId(chatId, dialogType, parsed.data.token);
    const text = parsed.data.text.trim();
    const images = parsed.data.images.map((image) => ({
      base64: image.base64.trim(),
      mimeType: image.mimeType.trim(),
      fileName: image.fileName.trim(),
    }));
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

    if (dialogType === 'comments' && images.length > 0) {
      throw new BadRequestException('Фото доступно только в предложке.');
    }

    if (dialogType === 'comments' && !text) {
      throw new BadRequestException('Введите текст комментария.');
    }

    if (dialogType === 'suggest' && !channelSettings.postSuggestionsEnabled && !threadId) {
      throw new BadRequestException('Предложить пост для этого канала сейчас нельзя.');
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
        images,
      });
      return createChannelDialogMessageResponseSchema.parse({
        ok: true,
        message: this.mapChannelDialogAuditLog(created.row, 'suggest', user.userId),
      });
    }

    const created = await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: CHANNEL_DIALOG_ACTION_COMMENT,
        payload: {
          type: dialogType,
          threadId,
          text,
          authorDisplayName: authorDisplayName ?? null,
          authorAvatarUrl: authorAvatarUrl ?? null,
          ...(replyTo
            ? {
                replyTo: {
                  messageId: replyTo.messageId,
                  authorDisplayName: replyTo.authorDisplayName,
                  text: replyTo.text,
                },
              }
            : {}),
          source,
        },
      },
    });

    const message = {
      id: created.id,
      type: dialogType,
      text,
      authorUserId: user.userId,
      authorDisplayName: authorDisplayName ?? null,
      isAdmin: (await this.readDialogAdminUserIds(chatId)).has(user.userId),
      avatarUrl: authorAvatarUrl ?? null,
      createdAt: created.createdAt.toISOString(),
      editedAt: null,
      replyToMessageId: replyTo?.messageId ?? null,
      replyTo: replyTo ?? null,
      reactionGroups: [],
      canEdit: dialogType === 'comments',
      canDelete: dialogType === 'comments',
      canDeleteAsAdmin: false,
    };

    if (dialogType === 'comments' && threadId) {
      await this.syncCommentsButtonCount({
        chatId,
        entityType: 'channel',
        threadId,
      });
    }

    return createChannelDialogMessageResponseSchema.parse({
      ok: true,
      message,
    });
  }

  async getChatDialog(chatId: string, user: AuthUser, dialogTypeRaw: string, token: string | null) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    if (dialogType !== 'comments') {
      throw new BadRequestException('Для чатов доступен только сценарий комментариев.');
    }

    const threadId = this.resolveChatDialogThreadId(chatId, dialogType, token);
    const [chatSettings, rows, adminUserIds] = await Promise.all([
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
    ]);

    if (!chatSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого чата сейчас закрыты.');
    }

    const messages =
      rows
        .slice()
        .reverse()
        .map((row) => this.mapChannelDialogAuditLog(row, dialogType, user.userId, adminUserIds));

    return channelDialogResponseSchema.parse({
      chatId,
      type: dialogType,
      introText: null,
      messages,
    });
  }

  async createChatDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    if (dialogType !== 'comments') {
      throw new BadRequestException('Для чатов доступен только сценарий комментариев.');
    }

    const parsed = createChannelDialogMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const threadId = this.resolveChatDialogThreadId(chatId, dialogType, parsed.data.token);
    const text = parsed.data.text.trim();
    const hasImages = parsed.data.images.length > 0;
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

    if (hasImages) {
      throw new BadRequestException('Фото доступно только в предложке.');
    }

    if (!text) {
      throw new BadRequestException('Введите текст комментария.');
    }

    const created = await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: CHANNEL_DIALOG_ACTION_COMMENT,
        payload: {
          type: dialogType,
          threadId,
          text,
          authorDisplayName: authorDisplayName ?? null,
          authorAvatarUrl: authorAvatarUrl ?? null,
          ...(replyTo
            ? {
                replyTo: {
                  messageId: replyTo.messageId,
                  authorDisplayName: replyTo.authorDisplayName,
                  text: replyTo.text,
                },
              }
            : {}),
          delivered: true,
          deliveredToUserId: null,
          source: 'miniapp_dialog',
        },
      },
    });

    const message = {
      id: created.id,
      type: dialogType,
      text,
      authorUserId: user.userId,
      authorDisplayName: authorDisplayName ?? null,
      isAdmin: (await this.readDialogAdminUserIds(chatId)).has(user.userId),
      avatarUrl: authorAvatarUrl ?? null,
      createdAt: created.createdAt.toISOString(),
      editedAt: null,
      replyToMessageId: replyTo?.messageId ?? null,
      replyTo: replyTo ?? null,
      reactionGroups: [],
      canEdit: true,
      canDelete: true,
      canDeleteAsAdmin: false,
    };

    if (threadId) {
      await this.syncCommentsButtonCount({
        chatId,
        entityType: 'chat',
        threadId,
      });
    }

    return createChannelDialogMessageResponseSchema.parse({
      ok: true,
      message,
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
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const parsed = toggleChannelDialogReactionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const channelSettings = await this.getPublicChannelSettings(chatId);
    if (!channelSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого канала сейчас закрыты.');
    }

    return this.toggleEntityDialogReaction({
      chatId,
      entityType: 'channel',
      userId: user.userId,
      dialogType,
      messageId,
      token: parsed.data.token,
      emoji: parsed.data.emoji,
    });
  }

  async toggleChatDialogReaction(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const parsed = toggleChannelDialogReactionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const chatSettings = await this.getPublicChatCommentSettings(chatId);
    if (!chatSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого чата сейчас закрыты.');
    }

    return this.toggleEntityDialogReaction({
      chatId,
      entityType: 'chat',
      userId: user.userId,
      dialogType,
      messageId,
      token: parsed.data.token,
      emoji: parsed.data.emoji,
    });
  }

  async applySettingsToAllChats(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
    settingKeys?: readonly (keyof ChatSettings)[],
  ): Promise<ApplySettingsToAllChatsResult> {
    await this.assertChatAdmin(sourceChatId, user.userId, 'chat');
    await this.ensureEntityType(sourceChatId, user.userId, 'chat');
    const parsed = chatSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const normalizedSettings = this.normalizeChatSettings(parsed.data, undefined, sourceChatId, {
      resetRequiredSubscriptionExpiration: true,
    });

    const availableChats = await this.listChatsForMassBroadcast(user);
    const appliedChatIds = Array.from(
      new Set([sourceChatId, ...availableChats.map((chat) => chat.id)]),
    );
    const filteredSettingKeys = Array.isArray(settingKeys)
      ? Array.from(new Set(settingKeys)).filter(
          (key): key is keyof ChatSettings => typeof key === 'string' && key in normalizedSettings,
        )
      : [];
    const settingsUpdatePayload: Partial<ChatSettings> =
      filteredSettingKeys.length > 0
        ? filteredSettingKeys.reduce<Partial<ChatSettings>>((acc, key) => {
            (acc as Record<keyof ChatSettings, ChatSettings[keyof ChatSettings]>)[key] =
              normalizedSettings[key];
            return acc;
          }, {})
        : normalizedSettings;
    const settingsCreatePayload =
      filteredSettingKeys.length > 0
        ? {
            ...DEFAULT_CHAT_SETTINGS,
            ...settingsUpdatePayload,
          }
        : normalizedSettings;
    const shouldValidateRequiredSubscription =
      filteredSettingKeys.length === 0 ||
      filteredSettingKeys.some((key) =>
        REQUIRED_SUBSCRIPTION_SETTING_KEYS.includes(
          key as (typeof REQUIRED_SUBSCRIPTION_SETTING_KEYS)[number],
        ),
      );
    if (shouldValidateRequiredSubscription) {
      await this.assertRequiredSubscriptionSettings(normalizedSettings);
    }

    await this.mapWithConcurrencyLimit(
      appliedChatIds,
      APPLY_SETTINGS_TO_ALL_CHATS_CONCURRENCY,
      async (chatId) => {
        const resolvedBotId = await this.resolveBotAssignment(chatId);
        await this.prisma.$transaction([
          this.prisma.chat.upsert({
            where: { id: chatId },
            create: {
              id: chatId,
              title: `Chat ${chatId}`,
              entityType: ChatEntityType.CHAT,
              ...this.buildResolvedBotAssignmentData(resolvedBotId),
              settings: {
                create: {
                  ...settingsCreatePayload,
                },
              },
            },
            update: {
              ...this.buildResolvedBotAssignmentData(resolvedBotId),
              settings: {
                upsert: {
                  update: {
                    ...settingsUpdatePayload,
                  },
                  create: {
                    ...settingsCreatePayload,
                  },
                },
              },
            },
          }),
          this.prisma.chatAdminAllowlist.upsert({
            where: {
              chatId_userId: {
                chatId,
                userId: user.userId,
              },
            },
            create: {
              chatId,
              userId: user.userId,
            },
            update: {},
          }),
          this.prisma.auditLog.create({
            data: {
              chatId,
              actorUserId: user.userId,
              action: 'APPLY_SETTINGS_TO_ALL_CHATS',
              payload: {
                sourceChatId,
                targetChatId: chatId,
                source,
                ...(filteredSettingKeys.length > 0 ? { settingKeys: filteredSettingKeys } : {}),
              },
            },
          }),
        ]);

        await this.chatContextCache.invalidate(chatId);
        await this.refreshManagedEntityBotAccessSnapshots(
          chatId,
          'chat',
          'chat settings apply-to-all',
        );
      },
    );

    if (
      shouldValidateRequiredSubscription &&
      this.isRequiredSubscriptionCurrentlyActive(normalizedSettings)
    ) {
      await this.refreshRequiredSubscriptionAccessSnapshots(
        normalizedSettings.requiredSubscriptionChannelIds,
        'required subscription settings apply-to-all',
      );
    }

    return {
      sourceChatId,
      updatedChats: appliedChatIds.length,
      appliedChatIds,
    };
  }

  async applySettingsSectionToAllChats(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ApplySectionToAllResponse> {
    const parsed = applySectionToAllRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const sourceSettings = await this.getSettings(sourceChatId, user);
    const result = await this.applySettingsToAllChats(
      sourceChatId,
      user,
      sourceSettings,
      source,
      SETTINGS_SECTION_KEYS[parsed.data.section],
    );

    if (parsed.data.section === 'links') {
      await this.syncDomainAllowlistToChats(sourceChatId, result.appliedChatIds);
    }

    return applySectionToAllResponseSchema.parse({
      section: parsed.data.section,
      ...result,
    });
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
      this.normalizeMessageLimitsBlockedWords(
        this.normalizeRequiredSubscriptionSettings(settings, currentState, options),
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
      'requiredSubscriptionEnabled' | 'requiredSubscriptionChannelIds' | 'requiredSubscriptionExpiresAt'
    >,
  ): boolean {
    return (
      settings.requiredSubscriptionEnabled &&
      settings.requiredSubscriptionChannelIds.length > 0 &&
      !this.hasRequiredSubscriptionExpired(settings)
    );
  }

  private buildRequiredSubscriptionExpiresAt(durationDays: number): string {
    return new Date(Date.now() + durationDays * REQUIRED_SUBSCRIPTION_DURATION_DAY_MS).toISOString();
  }

  private resolveRequiredSubscriptionExpiresAt(
    settings: Pick<
      ChatSettings,
      | 'requiredSubscriptionEnabled'
      | 'requiredSubscriptionChannelIds'
      | 'requiredSubscriptionDurationDays'
      | 'requiredSubscriptionExpiresAt'
    >,
    currentState?:
      | Pick<
          ChatSettings,
          | 'requiredSubscriptionEnabled'
          | 'requiredSubscriptionChannelIds'
          | 'requiredSubscriptionDurationDays'
          | 'requiredSubscriptionExpiresAt'
        >
      | null,
    options?: {
      resetRequiredSubscriptionExpiration?: boolean;
    },
  ): string {
    if (!settings.requiredSubscriptionEnabled || settings.requiredSubscriptionChannelIds.length === 0) {
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

  private normalizeMessageLimitsBlockedWords(settings: ChatSettings): ChatSettings {
    const messageLimitsBlockedWords = Array.from(
      new Set(
        settings.messageLimitsBlockedWords
          .map((item) => normalizeMessageLimitsBlockedWordCandidate(item) ?? null)
          .filter((item): item is string => Boolean(item)),
      ),
    );

    return {
      ...settings,
      messageLimitsBlockedWords,
    };
  }

  private normalizeStoredLinkButtons(
    rawButtons: unknown,
    legacy?: {
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

    const legacyUrl = this.normalizeLegacyProfileButtonUrl(legacy?.buttonUrl ?? '');
    if (!legacyUrl) {
      return [];
    }

    return [
      {
        text: legacy?.buttonText?.trim() || DEFAULT_BROADCAST_BUTTON_TEXT,
        url: legacyUrl,
      },
    ];
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
    const buttons = this.normalizeStoredLinkButtons(rawButtons, legacy);
    const primaryButton = buttons[0];

    return {
      buttons,
      buttonUrl: primaryButton?.url ?? '',
      buttonText: primaryButton?.text ?? DEFAULT_BROADCAST_BUTTON_TEXT,
    };
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
    const channels = await this.mapWithConcurrencyLimit(
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
        if (pathSegments[0] !== 'chats' || pathSegments.length < 2) {
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
      throw new BadRequestException('Чат или канал не найден в MAX или бот не имеет к нему доступа.');
    }

    const link = snapshot.link?.trim() || null;
    const entityType = snapshot.entityType;
    const prismaEntityType = this.mapManagedEntityTypeToChatEntityType(entityType);

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
      await this.maxBotLinkService?.bindDiscoveredChatBots({
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
        if (this.isBotAdminLookupDeniedError(error)) {
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
        if (!this.isBotAdminLookupDeniedError(error)) {
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

        pathname = pathname.replace(/^\/channel\//iu, '/channels/');
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
      await this.mapWithConcurrencyLimit(
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

  private async resolveRequiredSubscriptionEntityType(
    chatId: string,
  ): Promise<ManagedEntityType> {
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
        return this.fromPrismaEntityType(persisted.entityType);
      }
    }

    return 'channel';
  }

  private async refreshRequiredSubscriptionAccessSnapshots(
    entityIds: readonly string[],
    reason: string,
  ): Promise<void> {
    const normalizedEntityIds = Array.from(
      new Set(entityIds.map((entityId) => entityId.trim()).filter((entityId) => entityId.length > 0)),
    );
    await this.mapWithConcurrencyLimit(
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

  async sendBroadcast(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<SendBroadcastResult> {
    return this.sendManagedBroadcast(sourceChatId, user, body, {
      entityType: 'chat',
      source,
      resolveTargets: (actor) => this.listChatsForMassBroadcast(actor),
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
      const now = new Date();
      const staleLockBefore = new Date(now.getTime() - MANAGED_BROADCAST_LOCK_STALE_MS);
      const autoRetryBefore = new Date(now.getTime() - MANAGED_BROADCAST_AUTO_RETRY_BACKOFF_MS);
      const activeDueRows = await this.prisma.managedBroadcast.findMany({
        where: {
          status: PrismaManagedBroadcastStatus.ACTIVE,
          nextSendAt: { lte: now },
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
        },
        orderBy: [{ nextSendAt: 'asc' }, { createdAt: 'asc' }],
        take: MANAGED_BROADCAST_DUE_BATCH_SIZE,
        select: { id: true },
      });
      const retryableDueRows = await this.prisma.managedBroadcast.findMany({
        where: {
          status: {
            in: [
              PrismaManagedBroadcastStatus.PARTIAL,
              PrismaManagedBroadcastStatus.FAILED,
            ],
          },
          nextSendAt: { lte: now },
          updatedAt: { lte: autoRetryBefore },
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
        },
        orderBy: [{ nextSendAt: 'asc' }, { createdAt: 'asc' }],
        take: MANAGED_BROADCAST_DUE_BATCH_SIZE,
        select: { id: true },
      });
      const reservedRecoveryCount = Math.min(
        retryableDueRows.length,
        Math.min(MANAGED_BROADCAST_RECOVERY_BATCH_SIZE, MANAGED_BROADCAST_DUE_BATCH_SIZE),
      );
      const dueRows = [
        ...activeDueRows.slice(0, MANAGED_BROADCAST_DUE_BATCH_SIZE - reservedRecoveryCount),
        ...retryableDueRows.slice(0, reservedRecoveryCount),
      ];
      if (dueRows.length < MANAGED_BROADCAST_DUE_BATCH_SIZE) {
        const remainingSlots = MANAGED_BROADCAST_DUE_BATCH_SIZE - dueRows.length;
        const activeOverflowOffset =
          MANAGED_BROADCAST_DUE_BATCH_SIZE - reservedRecoveryCount;
        dueRows.push(
          ...activeDueRows.slice(
            activeOverflowOffset,
            activeOverflowOffset + remainingSlots,
          ),
        );
      }
      if (dueRows.length < MANAGED_BROADCAST_DUE_BATCH_SIZE) {
        const remainingSlots = MANAGED_BROADCAST_DUE_BATCH_SIZE - dueRows.length;
        dueRows.push(
          ...retryableDueRows.slice(
            reservedRecoveryCount,
            reservedRecoveryCount + remainingSlots,
          ),
        );
      }

      if (dueRows.length === 0) {
        return;
      }

      for (const row of dueRows) {
        await this.processManagedBroadcastOccurrence(row.id, reason, staleLockBefore, [
          PrismaManagedBroadcastStatus.ACTIVE,
          PrismaManagedBroadcastStatus.PARTIAL,
          PrismaManagedBroadcastStatus.FAILED,
        ]);
      }
    }

    this.logger.warn(
      `Managed broadcast due backlog was not fully drained after ${MANAGED_BROADCAST_DUE_MAX_PASSES} passes.`,
    );
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

    const rows = await this.prisma.managedBroadcast.findMany({
      where: {
        sourceChatId,
        entityType: this.mapManagedEntityTypeToChatEntityType(entityType),
        status: {
          in: [
            PrismaManagedBroadcastStatus.ACTIVE,
            PrismaManagedBroadcastStatus.PARTIAL,
            PrismaManagedBroadcastStatus.FAILED,
          ],
        },
      },
      orderBy: [{ nextSendAt: 'asc' }, { createdAt: 'desc' }],
    });

    const [snapshots, upcomingSlotsMap] = await Promise.all([
      this.getManagedBroadcastDeliverySnapshots(rows),
      this.getManagedBroadcastUpcomingSlotsMap(rows),
    ]);

    return rows.map((row) =>
      managedBroadcastSummarySchema.parse(
        this.mapManagedBroadcastSummary(
          row,
          snapshots.get(row.id),
          upcomingSlotsMap.get(row.id) ?? [],
        ),
      ),
    );
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
        entityType: this.mapManagedEntityTypeToChatEntityType(entityType),
      },
    });
    if (!row) {
      throw new BadRequestException('Рассылка не найдена.');
    }

    const [snapshot, upcomingSlots] = await Promise.all([
      this.getManagedBroadcastDeliverySnapshot(row),
      this.getManagedBroadcastUpcomingSlots(row),
    ]);
    return managedBroadcastDetailsSchema.parse(
      this.mapManagedBroadcastDetails(row, snapshot, upcomingSlots),
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
        entityType: this.mapManagedEntityTypeToChatEntityType(entityType),
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
      throw new BadRequestException('Рассылка не найдена или уже завершена.');
    }

    const request = await this.prepareManagedBroadcastRequest(sourceChatId, user, body, {
      entityType,
      resolveTargets:
        entityType === 'chat' ? (actor) => this.listChatsForMassBroadcast(actor) : undefined,
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
        'Текущая отправка уже частично доставлена. Сначала повторите ошибки или остановите рассылку.',
      );
    }

    const schedulePlan = await this.planManagedBroadcastSchedule(
      sourceChatId,
      this.mapManagedEntityTypeToChatEntityType(entityType),
      request.payload,
      existing.sentCount,
      existing.id,
    );
    const buttonState = this.buildManagedBroadcastButtonState(request.payload.buttons);
    const nextOccurrenceIndex = schedulePlan.sentCount + 1;
    const isCalendarPlanComplete =
      schedulePlan.scheduleMode === 'calendar' && schedulePlan.upcomingSlots.length === 0;

    await this.prisma.$transaction(async (tx) => {
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
          entityType: this.mapManagedEntityTypeToChatEntityType(entityType),
          fromOccurrenceIndex: nextOccurrenceIndex,
          slots: schedulePlan.upcomingSlots,
          excludeBroadcastId: existing.id,
        });
      }
    });

    const updated = await this.prisma.managedBroadcast.findUnique({
      where: { id: existing.id },
    });
    if (!updated) {
      throw new BadRequestException('Рассылка не найдена.');
    }

    await this.prisma.auditLog.create({
      data: {
        chatId: sourceChatId,
        actorUserId: user.userId,
        action: 'UPDATE_BROADCAST_SCHEDULE',
        payload: {
          broadcastId: existing.id,
          entityType,
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

    const [snapshot, upcomingSlots] = await Promise.all([
      this.getManagedBroadcastDeliverySnapshot(updated),
      this.getManagedBroadcastUpcomingSlots(updated),
    ]);
    return managedBroadcastDetailsSchema.parse(
      this.mapManagedBroadcastDetails(updated, snapshot, upcomingSlots),
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
        entityType: this.mapManagedEntityTypeToChatEntityType(entityType),
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
      throw new BadRequestException('Рассылка не найдена или уже завершена.');
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

    const [snapshot, upcomingSlots] = await Promise.all([
      this.getManagedBroadcastDeliverySnapshot(canceled),
      this.getManagedBroadcastUpcomingSlots(canceled),
    ]);
    return managedBroadcastDetailsSchema.parse(
      this.mapManagedBroadcastDetails(canceled, snapshot, upcomingSlots),
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
        entityType: this.mapManagedEntityTypeToChatEntityType(entityType),
        status: {
          in: [PrismaManagedBroadcastStatus.PARTIAL, PrismaManagedBroadcastStatus.FAILED],
        },
      },
    });
    if (!existing) {
      throw new BadRequestException('Для повтора нет неуспешной рассылки.');
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
      (delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.FAILED,
    );
    const hasPendingDeliveries = deliveriesAfterReconcile.some(
      (delivery) =>
        delivery.status === PrismaManagedBroadcastDeliveryStatus.PENDING ||
        delivery.status === PrismaManagedBroadcastDeliveryStatus.SENDING,
    );

    if (!hasFailedDeliveries && !hasPendingDeliveries) {
      await this.finalizeManagedBroadcastOccurrence(existing, currentOccurrence, [], [], null);

      const finalized = await this.prisma.managedBroadcast.findUnique({
        where: { id: existing.id },
      });
      if (!finalized) {
        throw new BadRequestException('Рассылка не найдена.');
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

      const [snapshot, upcomingSlots] = await Promise.all([
        this.getManagedBroadcastDeliverySnapshot(finalized),
        this.getManagedBroadcastUpcomingSlots(finalized),
      ]);
      return managedBroadcastDetailsSchema.parse(
        this.mapManagedBroadcastDetails(finalized, snapshot, upcomingSlots),
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
      throw new BadRequestException('Рассылка не найдена.');
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

    const [snapshot, upcomingSlots] = await Promise.all([
      this.getManagedBroadcastDeliverySnapshot(updated),
      this.getManagedBroadcastUpcomingSlots(updated),
    ]);
    return managedBroadcastDetailsSchema.parse(
      this.mapManagedBroadcastDetails(updated, snapshot, upcomingSlots),
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

    let targetChatIds = [sourceChatId];
    if (parsed.data.applyToAllChats) {
      if (!options.resolveTargets) {
        throw new BadRequestException('Массовая рассылка по каналам пока недоступна.');
      }

      const availableTargets = await options.resolveTargets(user);
      targetChatIds = Array.from(
        new Set([
          sourceChatId,
          ...availableTargets
            .filter((chat) => chat.entityType === options.entityType)
            .map((chat) => chat.id),
        ]),
      );
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

    const resolvedBotIdsByChatId = new Map<string, string | undefined>();
    const imagePayloadByBotId = new Map<string, Record<string, unknown> | undefined>();
    const resolveTargetBotId = async (chatId: string): Promise<string | undefined> => {
      if (!resolvedBotIdsByChatId.has(chatId)) {
        resolvedBotIdsByChatId.set(chatId, await this.resolveDeliveryBotAssignment(chatId));
      }
      return resolvedBotIdsByChatId.get(chatId);
    };
    const resolveImagePayload = async (
      botId: string | undefined,
    ): Promise<Record<string, unknown> | undefined> => {
      if (!request.payload.imageEnabled) {
        return undefined;
      }

      const cacheKey = botId ?? '__default__';
      if (!imagePayloadByBotId.has(cacheKey)) {
        imagePayloadByBotId.set(
          cacheKey,
          await this.uploadManagedBroadcastImage(
            request.payload,
            entityType,
            sourceChatId,
            user.userId,
            botId,
          ),
        );
      }

      return imagePayloadByBotId.get(cacheKey);
    };
    const sentChatIds: string[] = [];
    const failedChatIds: string[] = [];
    let firstSendError: unknown = null;

    for (const chatId of request.targetChatIds) {
      const resolvedBotId = await resolveTargetBotId(chatId);
      const imagePayload = await resolveImagePayload(resolvedBotId);
      let chatFailed = false;
      for (let cycleIndex = 0; cycleIndex < cycleCount; cycleIndex += 1) {
        const occurrenceDelayMs = delayMs + cycleIndex * cycleEveryMs;
        try {
          const message = await this.buildManagedBroadcastMessage(
            chatId,
            entityType,
            request.payload,
            request.normalizedSourceText,
            imagePayload,
          );
          if (occurrenceDelayMs === 0 && imagePayload) {
            await this.sendBroadcastImageMessageWithRetry(
              chatId,
              message.messageText,
              message.messageOptions,
              resolvedBotId,
            );
          } else {
            await this.maxClient.sendMessage(
              chatId,
              message.messageText,
              message.messageOptions,
              occurrenceDelayMs > 0
                ? {
                    delayMs: occurrenceDelayMs,
                    ...(resolvedBotId ? { botId: resolvedBotId } : {}),
                  }
                : {
                    immediate: true,
                    ...(resolvedBotId ? { botId: resolvedBotId } : {}),
                  },
            );
          }
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
      const fallbackMessage = 'Не удалось отправить рассылку.';
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

    return {
      sourceChatId,
      targetChats: request.targetChatIds.length,
      sentChats: sentChatIds.length,
      failedChats: failedChatIds.length,
      sentChatIds,
      failedChatIds,
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
      this.mapManagedEntityTypeToChatEntityType(entityType),
      request.payload,
      0,
      null,
    );
    const buttonState = this.buildManagedBroadcastButtonState(request.payload.buttons);
    const nextOccurrenceIndex = schedulePlan.sentCount + 1;
    const isCalendarPlanComplete =
      schedulePlan.scheduleMode === 'calendar' && schedulePlan.upcomingSlots.length === 0;

    const created = await this.prisma.$transaction(async (tx) => {
      const createdBroadcast = await tx.managedBroadcast.create({
        data: {
          sourceChatId,
          entityType: this.mapManagedEntityTypeToChatEntityType(entityType),
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
          entityType: this.mapManagedEntityTypeToChatEntityType(entityType),
          fromOccurrenceIndex: nextOccurrenceIndex,
          slots: schedulePlan.upcomingSlots,
          excludeBroadcastId: createdBroadcast.id,
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
      throw new BadRequestException('Рассылка не найдена.');
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

    return {
      sourceChatId,
      targetChats: request.targetChatIds.length,
      sentChats: occurrence.sentChatIds.length,
      failedChats: occurrence.failedChatIds.length,
      sentChatIds: occurrence.sentChatIds,
      failedChatIds: occurrence.failedChatIds,
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

    try {
      await this.reconcileStaleManagedBroadcastDeliveries(
        row.id,
        currentOccurrence,
        staleLockBefore,
      );

      const request: PreparedManagedBroadcastRequest = {
        payload: {
          text: row.text,
          textFormat: this.normalizeBroadcastTextFormat(row.textFormat),
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
          scheduleMode: this.normalizeBroadcastScheduleMode(row.scheduleMode),
          scheduleTimezone: row.scheduleTimezone,
          scheduledSlots: [],
          sendAt: row.nextSendAt.toISOString(),
          cycleEnabled: row.cycleEnabled,
          cycleEveryHours: row.cycleEveryHours,
          cycleCount: row.cycleCount,
        },
        targetChatIds: this.parseManagedBroadcastTargetChatIds(row.targetChatIds),
        normalizedSourceText: row.text,
      };

      const sentChatIds: string[] = [];
      const failedChatIds: string[] = [];
      let firstSendError: unknown = null;
      let initialDeliveries = await this.prisma.managedBroadcastDelivery.findMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex: currentOccurrence,
        },
        orderBy: [{ targetChatId: 'asc' }],
      });

      if (reason === 'startup' || reason === 'scheduled') {
        initialDeliveries = await this.recoverManagedBroadcastDeliveriesForAutomaticRun(
          row.id,
          currentOccurrence,
          initialDeliveries,
        );
      }

      const fatalRecoveredDelivery = initialDeliveries.find((delivery) => {
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
          ) ?? 'Не удалось обработать рассылку.';
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

      if (
        initialDeliveries.some(
          (delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.FAILED,
        )
      ) {
        return this.finalizeManagedBroadcastOccurrence(row, currentOccurrence, [], [], null);
      }

      const resolvedBotIdsByChatId = new Map<string, string | undefined>();
      const imagePayloadByBotId = new Map<string, Record<string, unknown> | undefined>();
      const resolveTargetBotId = async (chatId: string): Promise<string | undefined> => {
        if (!resolvedBotIdsByChatId.has(chatId)) {
          resolvedBotIdsByChatId.set(chatId, await this.resolveDeliveryBotAssignment(chatId));
        }
        return resolvedBotIdsByChatId.get(chatId);
      };
      const resolveImagePayload = async (
        botId: string | undefined,
      ): Promise<Record<string, unknown> | undefined> => {
        if (!request.payload.imageEnabled) {
          return undefined;
        }

        const cacheKey = botId ?? '__default__';
        if (!imagePayloadByBotId.has(cacheKey)) {
          imagePayloadByBotId.set(
            cacheKey,
            await this.uploadManagedBroadcastImage(
              request.payload,
              row.entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
              row.sourceChatId,
              row.actorUserId,
              botId,
            ),
          );
        }

        return imagePayloadByBotId.get(cacheKey);
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

        let sentMessageId: string;
        try {
          const resolvedBotId = await resolveTargetBotId(delivery.targetChatId);
          const imagePayload = await resolveImagePayload(resolvedBotId);
          const message = await this.buildManagedBroadcastMessage(
            delivery.targetChatId,
            row.entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
            request.payload,
            request.normalizedSourceText,
            imagePayload,
          );
          sentMessageId = await this.sendManagedBroadcastMessageImmediateWithId(
            delivery.targetChatId,
            message.messageText,
            message.messageOptions,
            resolvedBotId,
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
              remoteMessageId: sentMessageId,
              lastError: null,
            },
          });
          sentChatIds.push(delivery.targetChatId);
          if (persistedSentMessage.count === 0) {
            continue;
          }

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
              messageId: sentMessageId,
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
              remoteMessageId: sentMessageId,
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
            : 'Не удалось обработать рассылку.',
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
    imagePayload?: Record<string, unknown>,
  ): Promise<{
    messageText: string;
    messageOptions:
      | Pick<MaxSendMessageOptions, 'buttons' | 'imagePayload' | 'textFormat'>
      | undefined;
  }> {
    const broadcastButtons = await this.resolveBroadcastButtons(chatId, entityType, {
      customButtons: payload.buttons,
      includeCustomButton: payload.buttonEnabled,
      customButtonText: payload.buttonText.trim(),
      customButtonUrl: payload.buttonUrl.trim(),
    });
    const hasMeaningfulText = normalizedSourceText.trim().length > 0;
    const shouldUseRichText = payload.textFormat === 'markdown' && hasMeaningfulText;
    const messageText = shouldUseRichText
      ? renderSupportedMarkdownAsHtml(normalizedSourceText)
      : hasMeaningfulText
        ? normalizedSourceText
        : payload.imageEnabled
          ? ' '
          : '';
    const textFormat: MaxSendMessageOptions['textFormat'] = shouldUseRichText ? 'html' : undefined;
    const messageOptions =
      broadcastButtons.length > 0 || imagePayload || textFormat
        ? {
            ...(textFormat ? { textFormat } : {}),
            ...(broadcastButtons.length > 0 ? { buttons: broadcastButtons } : {}),
            ...(imagePayload ? { imagePayload } : {}),
          }
        : undefined;

    return {
      messageText,
      messageOptions,
    };
  }

  private async uploadManagedBroadcastImage(
    payload: SendBroadcastRequest,
    entityType: ManagedEntityType,
    sourceChatId: string,
    actorUserId: string,
    botId?: string,
  ): Promise<Record<string, unknown> | undefined> {
    if (!payload.imageEnabled) {
      return undefined;
    }

    const imageMimeType = payload.imageMimeType.trim().toLowerCase();
    if (!imageMimeType.startsWith('image/')) {
      throw new BadRequestException('Поддерживаются только изображения.');
    }
    const imageBuffer = this.decodeBroadcastImageBase64(payload.imageBase64);
    if (imageBuffer.length > BROADCAST_IMAGE_MAX_BYTES) {
      throw new BadRequestException('Фото слишком большое. Попробуйте другое изображение.');
    }

    let lastError: unknown = null;
    const attempts =
      Math.max(BROADCAST_THROTTLE_RETRY_DELAYS_MS.length, BROADCAST_TIMEOUT_RETRY_DELAYS_MS.length) +
      1;

    try {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return botId
            ? await this.maxClient.uploadImage(
                imageBuffer,
                this.resolveBroadcastImageFileName(payload.imageFileName, imageMimeType),
                imageMimeType,
                { botId },
              )
            : await this.maxClient.uploadImage(
                imageBuffer,
                this.resolveBroadcastImageFileName(payload.imageFileName, imageMimeType),
                imageMimeType,
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

  private mapManagedEntityTypeToChatEntityType(entityType: ManagedEntityType): ChatEntityType {
    return entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
  }

  private normalizeBroadcastScheduleMode(value: string): BroadcastScheduleMode {
    return value === 'calendar' ? 'calendar' : 'legacy';
  }

  private async planManagedBroadcastSchedule(
    sourceChatId: string,
    entityType: ChatEntityType,
    payload: SendBroadcastRequest,
    sentCount: number,
    excludeBroadcastId: string | null,
  ): Promise<ManagedBroadcastSchedulePlan> {
    const scheduleMode = this.normalizeBroadcastScheduleMode(payload.scheduleMode);
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
      excludeBroadcastId: string | null;
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

  private async overwriteManagedBroadcastCalendarSlots(
    tx: Prisma.TransactionClient,
    options: {
      sourceChatId: string;
      entityType: ChatEntityType;
      slots: Date[];
      excludeBroadcastId: string | null;
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
      this.normalizeBroadcastScheduleMode(row.scheduleMode) !== 'calendar'
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
        this.parseManagedBroadcastTargetChatIds(row.targetChatIds),
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
      (row) => this.normalizeBroadcastScheduleMode(row.scheduleMode) === 'calendar',
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
      if (this.normalizeBroadcastScheduleMode(row.scheduleMode) === 'calendar') {
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
      throw new BadRequestException('Некорректное время рассылки.');
    }
    const calculatedDelayMs = scheduledAt.getTime() - Date.now();
    if (calculatedDelayMs < BROADCAST_MIN_DELAY_MS) {
      const message =
        options.sentCount > 0
          ? 'Следующую отправку можно поставить минимум через 30 секунд.'
          : 'Укажите время рассылки минимум через 30 секунд.';
      throw new BadRequestException(message);
    }
    if (calculatedDelayMs > BROADCAST_MAX_DELAY_MS) {
      throw new BadRequestException('Максимальный таймер рассылки: 31 день.');
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

  private parseManagedBroadcastTargetChatIds(value: Prisma.JsonValue): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
  }

  private normalizeBroadcastTextFormat(value: string): BroadcastTextFormat {
    return value === 'markdown' ? 'markdown' : 'plain';
  }

  private getCurrentManagedBroadcastOccurrence(row: PersistedManagedBroadcast): number {
    return Math.min(Math.max(1, row.sentCount + 1), Math.max(1, row.cycleCount));
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

    const retryAllowedAtMs =
      delivery.updatedAt.getTime() + MANAGED_BROADCAST_AUTO_RETRY_BACKOFF_MS;
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
    if (error && this.isPrivateDialogChatUnavailableError(error)) {
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

    if (this.normalizeBroadcastScheduleMode(row.scheduleMode) === 'calendar') {
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
      (delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.SENT,
    );
    const failedChats = deliveries.filter(
      (delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.FAILED,
    );
    const pendingChats = deliveries.filter(
      (delivery) =>
        delivery.status === PrismaManagedBroadcastDeliveryStatus.PENDING ||
        delivery.status === PrismaManagedBroadcastDeliveryStatus.SENDING,
    );
    const canRetry = failedChats.length > 0;

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
            : deliveredChats.map((delivery) => delivery.targetChatId),
          failedChatIds.length > 0
            ? failedChatIds
            : failedChats.map((delivery) => delivery.targetChatId),
          pendingChats.map((delivery) => delivery.targetChatId),
          firstSendError,
        );
      }
      if (this.normalizeBroadcastScheduleMode(row.scheduleMode) === 'calendar') {
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
            : deliveredChats.map((delivery) => delivery.targetChatId),
        failedChatIds:
          failedChatIds.length > 0
            ? failedChatIds
            : failedChats.map((delivery) => delivery.targetChatId),
        pendingChatIds: pendingChats.map((delivery) => delivery.targetChatId),
        canRetry,
        firstSendError,
        nextSendAt: row.nextSendAt,
      };
    }

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
            : deliveredChats.map((delivery) => delivery.targetChatId),
          [],
          pendingChats.map((delivery) => delivery.targetChatId),
          firstSendError,
        );
      }
      if (this.normalizeBroadcastScheduleMode(row.scheduleMode) === 'calendar') {
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
            : deliveredChats.map((delivery) => delivery.targetChatId),
        failedChatIds: [],
        pendingChatIds: pendingChats.map((delivery) => delivery.targetChatId),
        canRetry: false,
        firstSendError,
        nextSendAt: row.nextSendAt,
      };
    }

    const nextSentCount = currentOccurrence;
    let nextSendAt: Date | null;
    let isComplete: boolean;
    if (this.normalizeBroadcastScheduleMode(row.scheduleMode) === 'calendar') {
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
          : deliveredChats.map((delivery) => delivery.targetChatId),
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
          : deliveredChats.map((delivery) => delivery.targetChatId),
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
        (delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.SENT,
      ).length,
      failedChats: deliveries.filter(
        (delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.FAILED,
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
  ): ManagedBroadcastSummary {
    const targetChatIds = this.parseManagedBroadcastTargetChatIds(row.targetChatIds);
    const normalizedText = row.text.replace(/\s+/gu, ' ').trim();
    const resolvedSnapshot = snapshot ?? this.createManagedBroadcastDeliverySnapshot(row, []);
    const buttonState = this.buildManagedBroadcastButtonState(row.buttons, {
      buttonEnabled: row.buttonEnabled,
      buttonUrl: row.buttonUrl,
      buttonText: row.buttonText,
    });

    return {
      id: row.id,
      status: row.status,
      textPreview: normalizedText
        ? normalizedText.slice(0, 160)
        : row.imageEnabled
          ? 'Фото без текста'
          : 'Пустая рассылка',
      textLength: row.text.length,
      applyToAllChats: row.applyToAllChats,
      targetChats: targetChatIds.length,
      hasImage: row.imageEnabled,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      scheduleMode: this.normalizeBroadcastScheduleMode(row.scheduleMode),
      scheduleTimezone: row.scheduleTimezone,
      scheduledSlots: upcomingSlots.map((slot) => slot.toISOString()),
      nextSendAt: row.nextSendAt?.toISOString() ?? null,
      cycleEnabled: row.cycleEnabled,
      cycleEveryHours: row.cycleEveryHours,
      cycleCount: row.cycleCount,
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
  ): ManagedBroadcastDetails {
    const targetChatIds = this.parseManagedBroadcastTargetChatIds(row.targetChatIds);
    const resolvedSnapshot = snapshot ?? this.createManagedBroadcastDeliverySnapshot(row, []);
    const buttonState = this.buildManagedBroadcastButtonState(row.buttons, {
      buttonEnabled: row.buttonEnabled,
      buttonUrl: row.buttonUrl,
      buttonText: row.buttonText,
    });

    return {
      id: row.id,
      status: row.status,
      text: row.text,
      textFormat: this.normalizeBroadcastTextFormat(row.textFormat),
      applyToAllChats: row.applyToAllChats,
      targetChatIds,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      imageEnabled: row.imageEnabled,
      imageBase64: row.imageBase64,
      imageMimeType: row.imageMimeType,
      imageFileName: row.imageFileName,
      scheduleMode: this.normalizeBroadcastScheduleMode(row.scheduleMode),
      scheduleTimezone: row.scheduleTimezone,
      scheduledSlots: upcomingSlots.map((slot) => slot.toISOString()),
      nextSendAt: row.nextSendAt?.toISOString() ?? null,
      cycleEnabled: row.cycleEnabled,
      cycleEveryHours: row.cycleEveryHours,
      cycleCount: row.cycleCount,
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
  ): Promise<string> {
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
          ? await this.maxClient.sendMessageImmediateWithId(chatId, text, options, { botId })
          : await this.maxClient.sendMessageImmediateWithId(chatId, text, options);
        return published.messageId;
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
  ): Promise<void> {
    let lastError: unknown = null;
    const attempts = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.maxClient.sendMessage(
          chatId,
          text,
          options,
          botId ? { immediate: true, botId } : { immediate: true },
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

    if (this.isMaxApiThrottleError(error)) {
      return BROADCAST_THROTTLE_RETRY_DELAYS_MS[attempt - 1] ?? null;
    }

    if (this.isMaxApiTimeoutError(error)) {
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
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async sleepIfNeeded(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) {
      return;
    }

    await this.sleep(ms);
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

  private readBooleanConfigFlag(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value !== 'string') {
      return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (
      normalized === '1' ||
      normalized === 'true' ||
      normalized === 'yes' ||
      normalized === 'on'
    ) {
      return true;
    }
    if (
      normalized === '0' ||
      normalized === 'false' ||
      normalized === 'no' ||
      normalized === 'off'
    ) {
      return false;
    }

    return fallback;
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
    const responseData = (error as { response?: { data?: unknown } })?.response?.data;
    if (!responseData || typeof responseData !== 'object') {
      return '';
    }

    const row = responseData as Record<string, unknown>;
    const message = row.message;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }

    const code = row.code;
    if (typeof code === 'string' && code.trim()) {
      return `Ошибка MAX API: ${code.trim()}`;
    }

    return '';
  }

  private decodeBroadcastImageBase64(value: string): Buffer {
    const normalized = value.trim().replace(/^data:[^;]+;base64,/, '');
    if (!normalized) {
      throw new BadRequestException('Добавьте фото для рассылки.');
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
    const normalized = value.trim().replace(/^data:[^;]+;base64,/, '');
    if (!normalized) {
      throw new BadRequestException('Добавьте фото для правил.');
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = Buffer.from(normalized, 'base64');
    } catch {
      throw new BadRequestException('Не удалось прочитать фото правил.');
    }

    if (imageBuffer.length === 0) {
      throw new BadRequestException('Не удалось прочитать фото правил.');
    }

    return imageBuffer;
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
  ): Promise<MaxMessageButton[][]> {
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

      if (this.shouldIncludeChatCommentsButton(chatSettings)) {
        rows.push([
          this.buildChatDialogButton(
            chatId,
            'comments',
            threadId,
            formatCommentsButtonText('💬 Комментарии', 0),
          ),
        ]);
      }

      return rows;
    }

    if (entityType !== 'channel') {
      return rows;
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
        postSuggestionsButtonText: true,
        commentsEnabled: true,
      },
    });
    const threadId = randomUUID();

    if (channelSettings.commentsEnabled) {
      rows.push([
        this.buildChannelDialogButton(
          chatId,
          'comments',
          threadId,
          formatCommentsButtonText('💬 Комментарии', 0),
        ),
      ]);
    }

    if (channelSettings.postSuggestionsEnabled) {
      rows.push([
        this.buildChannelDialogButton(
          chatId,
          'suggest',
          threadId,
          channelSettings.postSuggestionsButtonText.trim() || '📰 Предложить пост',
        ),
      ]);
    }

    return rows;
  }

  private buildChannelDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
  ): MaxMessageButton {
    if (type === 'suggest') {
      const startPayload = this.buildChannelSuggestionStartPayload(chatId, threadId);
      const botStartUrl = this.buildBotStartUrl(startPayload);
      if (botStartUrl) {
        return {
          type: 'link',
          text,
          url: botStartUrl,
        };
      }
    }

    const launchUrl = this.buildChannelDialogLaunchUrl(chatId, type, threadId);
    const webAppUrl = this.buildChannelDialogDirectWebAppUrl(chatId, type, threadId);
    const botContactId = this.resolveBotContactId();

    if (webAppUrl && botContactId) {
      return {
        type: 'open_app',
        text,
        webApp: webAppUrl,
        contactId: botContactId,
      };
    }

    if (launchUrl) {
      return {
        type: 'link',
        text,
        url: launchUrl,
      };
    }

    return {
      type: 'link',
      text,
      url: webAppUrl ?? `${this.appBaseUrl ?? 'https://maxim.play-team.ru'}/app/`,
    };
  }

  private resolveRulesImageFileName(fileName: string, mimeType: string): string {
    const trimmed = fileName.trim();
    if (trimmed) {
      return trimmed;
    }

    if (mimeType === 'image/png') {
      return 'chat-rules.png';
    }
    if (mimeType === 'image/webp') {
      return 'chat-rules.webp';
    }
    if (mimeType === 'image/gif') {
      return 'chat-rules.gif';
    }

    return 'chat-rules.jpg';
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

  private normalizeChatRulesDraft(value: UpdateChatRulesRequest): UpdateChatRulesRequest {
    const buttonState = this.buildStoredLinkButtonState(value.buttons, {
      buttonUrl: value.buttonUrl,
      buttonText: value.buttonText,
    });
    const baseDraft = {
      text: value.text,
      autoTextEnabled: value.autoTextEnabled,
      buttons: buttonState.buttons,
      buttonEnabled: value.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
    } satisfies Pick<
      UpdateChatRulesRequest,
      'text' | 'autoTextEnabled' | 'buttons' | 'buttonEnabled' | 'buttonUrl' | 'buttonText'
    >;
    const normalizedImageBase64 = value.imageBase64.trim();
    if (!normalizedImageBase64) {
      return {
        ...baseDraft,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
      };
    }

    return {
      ...baseDraft,
      imageBase64: normalizedImageBase64,
      imageMimeType: value.imageMimeType.trim(),
      imageFileName: value.imageFileName.trim(),
    };
  }

  private normalizeImportedRulesText(value: string | null | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return null;
    }

    return normalized.slice(0, 2_000);
  }

  private async upsertChatRules(chatId: string): Promise<PersistedChatRules> {
    return this.prisma.chatRules.upsert({
      where: { chatId },
      create: {
        chatId,
        autoTextEnabled: true,
      },
      update: {},
    });
  }

  private mapChatRules(rules: PersistedChatRules): ChatRules {
    const buttonState = this.buildStoredLinkButtonState(rules.buttons, {
      buttonUrl: rules.buttonUrl,
      buttonText: rules.buttonText,
    });

    return chatRulesSchema.parse({
      text: rules.text,
      imageBase64: rules.imageBase64,
      imageMimeType: rules.imageMimeType,
      imageFileName: rules.imageFileName,
      autoTextEnabled: rules.autoTextEnabled,
      buttons: buttonState.buttons,
      buttonEnabled: rules.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      publishedMessageId: rules.publishedMessageId,
      publishedUrl: rules.publishedUrl,
      publishedAt: rules.publishedAt ? rules.publishedAt.toISOString() : null,
    });
  }

  private async hydratePublishedRulesUrl(
    chatId: string,
    rules: PersistedChatRules,
  ): Promise<PersistedChatRules> {
    const currentUrl = this.normalizePublishedRulesUrl(rules.publishedUrl);
    if (currentUrl || !rules.publishedMessageId?.trim()) {
      return {
        ...rules,
        publishedUrl: currentUrl,
      };
    }

    let resolvedUrl: string | null = null;
    try {
      resolvedUrl = this.normalizePublishedRulesUrl(
        await this.maxClient.resolveMessageLink(rules.publishedMessageId),
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          messageId: rules.publishedMessageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to recover published chat rules url',
      );
      return rules;
    }

    if (!resolvedUrl) {
      return rules;
    }

    await this.prisma.chatRules.update({
      where: { chatId },
      data: {
        publishedUrl: resolvedUrl,
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return {
      ...rules,
      publishedUrl: resolvedUrl,
    };
  }

  private normalizePublishedRulesUrl(value: string | null | undefined): string | null {
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

  private buildChatRulesButtonRows(rules: {
    buttons: unknown;
    buttonEnabled: boolean;
    buttonUrl: string;
    buttonText: string;
  }): MaxMessageButton[][] | null {
    if (!rules.buttonEnabled) {
      return null;
    }

    const buttons = this.normalizeStoredLinkButtons(rules.buttons, {
      buttonUrl: rules.buttonUrl,
      buttonText: rules.buttonText,
    }).map((button) => ({
      ...button,
      url: this.normalizePublishedRulesUrl(button.url) ?? '',
    }));
    const normalizedButtons = buttons.filter((button) => button.url.length > 0);
    if (normalizedButtons.length === 0) {
      return null;
    }

    return this.buildBroadcastLinkButtonRows(normalizedButtons);
  }

  private buildFormattedRulesPublicationText(sourceText: string): {
    text: string;
    textFormat: MaxSendMessageOptions['textFormat'];
  } {
    return {
      text: sourceText,
      textFormat: 'markdown',
    };
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

    if (!settings.videoMessagesEnabled) {
      items.push('Видео сюда отправлять нельзя.');
    }

    if (!settings.fileMessagesEnabled) {
      items.push('Файлы сюда отправлять нельзя.');
    }

    if (!settings.voiceMessagesEnabled) {
      items.push('Голосовые сообщения сюда отправлять нельзя.');
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

  private async getManagedPoll(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedPoll> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, entityType);
    await this.ensureEntityType(chatId, user.userId, entityType);

    const poll = await this.upsertManagedPoll(chatId);
    const hydrated = await this.hydrateManagedPollPublishedUrl(chatId, poll);
    return this.mapManagedPoll(hydrated);
  }

  private async updateManagedPoll(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    body: unknown,
    source: AdminActionSource,
  ): Promise<ManagedPoll> {
    await this.assertChatAdmin(chatId, user.userId, entityType);
    await this.ensureEntityType(chatId, user.userId, entityType);

    const parsed = updateManagedPollRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const current = await this.upsertManagedPoll(chatId);
    if (current.status === PrismaManagedPollStatus.ACTIVE) {
      throw new BadRequestException('Сначала закройте активный опрос.');
    }

    const normalizedDraft = normalizeManagedPollDraft(parsed.data.question, parsed.data.options);
    const currentDraft = normalizeManagedPollDraft(
      current.question,
      this.readManagedPollOptions(current.options),
    );
    const hasChanges =
      normalizedDraft.question !== currentDraft.question ||
      normalizedDraft.options.length !== currentDraft.options.length ||
      normalizedDraft.options.some((option, index) => option !== currentDraft.options[index]);

    const updated = await this.prisma.managedPoll.update({
      where: { chatId },
      data: {
        question: normalizedDraft.question,
        options: normalizedDraft.options as Prisma.InputJsonValue,
        ...(current.status === PrismaManagedPollStatus.CLOSED && hasChanges
          ? {
              status: PrismaManagedPollStatus.DRAFT,
              publishedMessageId: null,
              publishedUrl: null,
              publishedAt: null,
              closedAt: null,
            }
          : {}),
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: MANAGED_POLL_ACTION_UPDATE,
        payload: {
          entityType,
          questionLength: normalizedDraft.question.length,
          optionsCount: normalizedDraft.options.length,
          statusBefore: current.status,
          statusAfter:
            current.status === PrismaManagedPollStatus.CLOSED && hasChanges
              ? PrismaManagedPollStatus.DRAFT
              : current.status,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return this.mapManagedPoll(updated);
  }

  private async publishManagedPoll(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    source: AdminActionSource,
  ): Promise<ManagedPoll> {
    await this.assertChatAdmin(chatId, user.userId, entityType);
    await this.ensureEntityType(chatId, user.userId, entityType);

    const current = await this.upsertManagedPoll(chatId);
    if (current.status === PrismaManagedPollStatus.ACTIVE && current.publishedMessageId?.trim()) {
      throw new BadRequestException('Сначала закройте активный опрос.');
    }

    let normalizedDraft: { question: string; options: string[] };
    try {
      normalizedDraft = validateManagedPollForPublish(
        current.question,
        this.readManagedPollOptions(current.options),
      );
    } catch (error: unknown) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Опрос заполнен некорректно.',
      );
    }

    const nextVersion = Math.max(0, current.activeVersion) + 1;
    const zeroResults = buildManagedPollOptionSummaries(
      normalizedDraft.options,
      normalizedDraft.options.map(() => 0),
    );
    const buttons = buildManagedPollButtons(
      current.id,
      nextVersion,
      normalizedDraft.options,
      zeroResults.optionResults,
    );
    const messageText = buildManagedPollMessageText(
      normalizedDraft.question,
      zeroResults.optionResults,
      'ACTIVE',
    );
    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);

    let published: { messageId: string; url: string | null };
    try {
      published = resolvedBotId
        ? await this.maxClient.sendMessageImmediateWithResolvedLink(
            chatId,
            messageText,
            {
              buttons,
            },
            { botId: resolvedBotId },
          )
        : await this.maxClient.sendMessageImmediateWithResolvedLink(chatId, messageText, {
            buttons,
          });
    } catch (error: unknown) {
      const maxApiMessage = this.extractMaxApiErrorMessage(error);
      throw new BadRequestException(maxApiMessage || 'Не удалось опубликовать опрос.');
    }

    const publishedAt = new Date();
    const updated = await this.prisma.managedPoll.update({
      where: { chatId },
      data: {
        question: normalizedDraft.question,
        options: normalizedDraft.options as Prisma.InputJsonValue,
        status: PrismaManagedPollStatus.ACTIVE,
        activeVersion: nextVersion,
        publishedMessageId: published.messageId,
        publishedUrl: this.normalizePublishedRulesUrl(published.url),
        publishedAt,
        closedAt: null,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: MANAGED_POLL_ACTION_PUBLISH,
        payload: {
          entityType,
          messageId: published.messageId,
          url: published.url,
          questionLength: normalizedDraft.question.length,
          optionsCount: normalizedDraft.options.length,
          activeVersion: nextVersion,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return this.mapManagedPoll(updated);
  }

  private async closeManagedPoll(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    source: AdminActionSource,
  ): Promise<ManagedPoll> {
    await this.assertChatAdmin(chatId, user.userId, entityType);
    await this.ensureEntityType(chatId, user.userId, entityType);

    const current = await this.upsertManagedPoll(chatId);
    const publishedMessageId = current.publishedMessageId?.trim() ?? '';
    if (current.status !== PrismaManagedPollStatus.ACTIVE || !publishedMessageId) {
      throw new BadRequestException('Активного опроса нет.');
    }

    const normalizedDraft = normalizeManagedPollDraft(
      current.question,
      this.readManagedPollOptions(current.options),
    );
    const voteCounts = await this.loadManagedPollVoteCounts(
      current.id,
      current.activeVersion,
      normalizedDraft.options.length,
    );
    const summary = buildManagedPollOptionSummaries(normalizedDraft.options, voteCounts);
    const messageText = buildManagedPollMessageText(
      normalizedDraft.question,
      summary.optionResults,
      'CLOSED',
    );
    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);
    let nextPublishedMessageId = publishedMessageId;
    let nextPublishedUrl = this.normalizePublishedRulesUrl(current.publishedUrl);
    let recreatedFromMessageId: string | null = null;

    try {
      if (resolvedBotId) {
        await this.maxClient.editMessageInlineKeyboard(
          chatId,
          publishedMessageId,
          messageText,
          undefined,
          { botId: resolvedBotId },
        );
      } else {
        await this.maxClient.editMessageInlineKeyboard(chatId, publishedMessageId, messageText);
      }
    } catch (error: unknown) {
      if (!this.shouldRecreateEditableMessage(error)) {
        const maxApiMessage = this.extractMaxApiErrorMessage(error);
        throw new BadRequestException(maxApiMessage || 'Не удалось закрыть опрос.');
      }

      recreatedFromMessageId = publishedMessageId;
      try {
        const recreated = resolvedBotId
          ? await this.maxClient.sendMessageImmediateWithResolvedLink(
              chatId,
              messageText,
              undefined,
              {
                botId: resolvedBotId,
              },
            )
          : await this.maxClient.sendMessageImmediateWithResolvedLink(chatId, messageText);
        nextPublishedMessageId = recreated.messageId;
        nextPublishedUrl = this.normalizePublishedRulesUrl(recreated.url);
      } catch (recreateError: unknown) {
        const maxApiMessage = this.extractMaxApiErrorMessage(recreateError);
        throw new BadRequestException(maxApiMessage || 'Не удалось закрыть опрос.');
      }
    }

    const closedAt = new Date();
    const updated = await this.prisma.managedPoll.update({
      where: { chatId },
      data: {
        status: PrismaManagedPollStatus.CLOSED,
        closedAt,
        ...(recreatedFromMessageId
          ? {
              publishedMessageId: nextPublishedMessageId,
              publishedUrl: nextPublishedUrl,
            }
          : {}),
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: MANAGED_POLL_ACTION_CLOSE,
        payload: {
          entityType,
          messageId: nextPublishedMessageId,
          activeVersion: current.activeVersion,
          totalVotes: summary.totalVotes,
          recreatedFromMessageId,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return this.mapManagedPoll(updated);
  }

  private async upsertManagedPoll(chatId: string): Promise<PersistedManagedPoll> {
    return this.prisma.managedPoll.upsert({
      where: { chatId },
      create: {
        chatId,
      },
      update: {},
    });
  }

  private async mapManagedPoll(poll: PersistedManagedPoll): Promise<ManagedPoll> {
    const normalizedDraft = normalizeManagedPollDraft(
      poll.question,
      this.readManagedPollOptions(poll.options),
    );
    const voteCounts =
      poll.status === PrismaManagedPollStatus.ACTIVE ||
      poll.status === PrismaManagedPollStatus.CLOSED
        ? await this.loadManagedPollVoteCounts(
            poll.id,
            poll.activeVersion,
            normalizedDraft.options.length,
          )
        : normalizedDraft.options.map(() => 0);
    const summary = buildManagedPollOptionSummaries(normalizedDraft.options, voteCounts);

    return managedPollSchema.parse({
      question: normalizedDraft.question,
      options: normalizedDraft.options,
      status: poll.status,
      activeVersion: poll.activeVersion,
      publishedMessageId: poll.publishedMessageId?.trim() || null,
      publishedUrl: this.normalizePublishedRulesUrl(poll.publishedUrl),
      publishedAt: poll.publishedAt ? poll.publishedAt.toISOString() : null,
      closedAt: poll.closedAt ? poll.closedAt.toISOString() : null,
      totalVotes: summary.totalVotes,
      optionResults: summary.optionResults,
    });
  }

  private async hydrateManagedPollPublishedUrl(
    chatId: string,
    poll: PersistedManagedPoll,
  ): Promise<PersistedManagedPoll> {
    const currentUrl = this.normalizePublishedRulesUrl(poll.publishedUrl);
    if (currentUrl || !poll.publishedMessageId?.trim()) {
      return {
        ...poll,
        publishedUrl: currentUrl,
      };
    }

    let resolvedUrl: string | null = null;
    try {
      const resolvedBotId = await this.resolveChatBotIdForRead(chatId);
      resolvedUrl = this.normalizePublishedRulesUrl(
        resolvedBotId
          ? await this.maxClient.resolveMessageLink(poll.publishedMessageId, {
              botId: resolvedBotId,
            })
          : await this.maxClient.resolveMessageLink(poll.publishedMessageId),
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          messageId: poll.publishedMessageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to recover published managed poll url',
      );
      return poll;
    }

    if (!resolvedUrl) {
      return poll;
    }

    await this.prisma.managedPoll.update({
      where: { chatId },
      data: {
        publishedUrl: resolvedUrl,
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return {
      ...poll,
      publishedUrl: resolvedUrl,
    };
  }

  private readManagedPollOptions(value: Prisma.JsonValue): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is string => typeof item === 'string');
  }

  private async loadManagedPollVoteCounts(
    pollId: string,
    pollVersion: number,
    optionCount: number,
  ): Promise<number[]> {
    const counts = Array.from({ length: optionCount }, () => 0);
    const votes = await this.prisma.managedPollVote.groupBy({
      where: {
        pollId,
        pollVersion,
      },
      by: ['optionIndex'],
      _count: {
        _all: true,
      },
    });

    for (const vote of votes) {
      if (vote.optionIndex >= 0 && vote.optionIndex < counts.length) {
        counts[vote.optionIndex] = vote._count._all;
      }
    }

    return counts;
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
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return true;
    }

    const responseData = (error as { response?: { data?: unknown } })?.response?.data;
    const normalized = JSON.stringify(responseData ?? '').toLowerCase();
    return normalized.includes('not found') || normalized.includes('message_not_found');
  }

  private shouldRecreateEditableMessage(error: unknown): boolean {
    if (this.isMaxMessageMissingError(error)) {
      return true;
    }

    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status !== 400 && status !== 403) {
      return false;
    }

    const responseData = (error as { response?: { data?: unknown } })?.response?.data;
    const normalized = JSON.stringify(responseData ?? '').toLowerCase();
    return (
      normalized.includes('edit') ||
      normalized.includes('update') ||
      normalized.includes('too old') ||
      normalized.includes('24') ||
      normalized.includes("can't be edited") ||
      normalized.includes('cannot edit') ||
      normalized.includes('cant edit') ||
      normalized.includes('message.not.updated')
    );
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

    const cacheKey = this.buildLogsDashboardResponseCacheKey(
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

    let pending!: Promise<LogsDashboardResponse>;
    pending = this.buildLogsDashboardResponse(
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
    const membershipEventsSql = this.buildMembershipEventDedupeSourceSql(chatId, from, now, [
      'user_added',
      'user_removed',
    ]);
    const headerPromise =
      this.chatContextCache.getManagedEntityHeader?.(chatId, 'chat') ?? Promise.resolve(null);

    const violationsWhere = this.buildModerationFeedWhere(chatId, from, now, 'ALL');

    const baseQueriesStartedAtMs = Date.now();
    const [chat, membershipRows, chatHeader, moderationSummaryRows, affectedUsers, violationRows] =
      await Promise.all([
        this.prisma.chat.findUnique({
          where: { id: chatId },
          select: { id: true, title: true },
        }),
        this.prisma.$queryRaw<Array<{ joined_users: unknown; left_users: unknown }>>`
        WITH membership_events AS (${membershipEventsSql})
        SELECT
          COUNT(*) FILTER (WHERE event_type = 'user_added') AS joined_users,
          COUNT(*) FILTER (WHERE event_type = 'user_removed') AS left_users
        FROM membership_events
      `,
        headerPromise,
        this.prisma.moderationEvent.groupBy({
          by: ['action', 'ruleCode'],
          where: {
            chatId,
            createdAt: { gte: from, lte: now },
            OR: [
              { action: 'WARN' },
              { action: 'DELETE_MESSAGE' },
              { action: 'MUTE' },
              { action: { in: [SanctionAction.BAN, SanctionAction.KICK] } },
              {
                action: SanctionAction.NONE,
                ruleCode: { in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'] },
              },
            ],
          },
          _count: { _all: true },
        }),
        this.prisma.moderationEvent.findMany({
          where: violationsWhere,
          distinct: ['userId'],
          select: { userId: true },
        }),
        includeModerationPreview
          ? this.prisma.moderationEvent.findMany({
              where: violationsWhere,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: LOGS_DASHBOARD_VIOLATIONS_LIMIT + 1,
            })
          : Promise.resolve([]),
      ]);
    const baseQueriesFinishedAtMs = Date.now();
    const moderationSummary = this.summarizeLogsDashboardModerationCounts(moderationSummaryRows);
    const moderationPreviewRows = violationRows.slice(0, LOGS_DASHBOARD_VIOLATIONS_LIMIT);
    const moderationProfilesStartedAtMs = Date.now();
    const moderationUserProfiles = includeModerationPreview
      ? await this.resolveUserProfiles(
          chatId,
          'chat',
          moderationPreviewRows.map((row) => row.userId),
        )
      : new Map<string, ResolvedUserProfile>();
    const moderationProfilesFinishedAtMs = Date.now();

    const membershipSource = membershipRows[0] ?? { joined_users: 0, left_users: 0 };
    const joinedUsers = this.toSafeInteger(membershipSource.joined_users);
    const leftUsers = this.toSafeInteger(membershipSource.left_users);
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
        )
      : this.buildEmptyMembershipActivityPage();
    const activityFeedFinishedAtMs = Date.now();
    const moderationFeedStartedAtMs = Date.now();
    const moderationFeed = includeModerationPreview
      ? moderationFeedPageSchema.parse({
          items: moderationPreviewRows.map((row) =>
            this.mapModerationViolationRow(
              chatId,
              'chat',
              row as ModerationViolationRow,
              moderationUserProfiles,
            ),
          ),
          hasMore: violationRows.length > LOGS_DASHBOARD_VIOLATIONS_LIMIT,
          nextCursor:
            violationRows.length > LOGS_DASHBOARD_VIOLATIONS_LIMIT &&
            moderationPreviewRows[moderationPreviewRows.length - 1]
              ? this.encodeModerationFeedCursor({
                  createdAt: moderationPreviewRows[moderationPreviewRows.length - 1]!.createdAt,
                  id: moderationPreviewRows[moderationPreviewRows.length - 1]!.id,
                })
              : null,
        })
      : this.buildEmptyModerationFeedPage();
    const moderationFeedFinishedAtMs = Date.now();
    const response: LogsDashboardResponse = {
      chat: {
        id: chatId,
        title: chat?.title?.trim() || 'Чат без названия',
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
        affectedUsers: affectedUsers.length,
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
          moderationProfilesMs: moderationProfilesFinishedAtMs - moderationProfilesStartedAtMs,
          activityFeedMs: activityFeedFinishedAtMs - activityFeedStartedAtMs,
          moderationFeedAssembleMs: moderationFeedFinishedAtMs - moderationFeedStartedAtMs,
          moderationPreviewCount: moderationPreviewRows.length,
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

    await this.assertTargetUserCanReceiveParticipantImmunity(chatId, targetUserId);

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
  ): Promise<ManualModerationActionResult> {
    const targetUserId = await this.prepareManualModerationTarget(chatId, targetUserIdRaw, user);

    const parsed = manualModerationActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);

    const metadataBase = {
      source,
      initiatedByUserId: user.userId,
    } as const;
    const shouldFanoutCommandMute = source === 'group_command' || source === 'private_command';

    if (parsed.data.action === 'MUTE') {
      const muteDurationHours = parsed.data.muteDurationHours;
      if (!muteDurationHours) {
        throw new BadRequestException('Укажите длительность мута в часах.');
      }

      await this.assertManualMemberModerationPreconditions(
        chatId,
        targetUserId,
        'MUTE',
        resolvedBotId,
      );
      const muteExpiresAt = new Date(Date.now() + muteDurationHours * ONE_HOUR_MS);
      const { sourceMessageCleanup, crossChatMuteFanout } = shouldFanoutCommandMute
        ? await this.resolveManualMuteCommandFollowUpSummaries({
            sourceChatId: chatId,
            targetUserId,
            actor: user,
            muteDurationHours,
            muteExpiresAt,
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
        actorUserId: user.userId,
        ruleCode: 'MANUAL_MUTE',
        sanctionAction: SanctionAction.MUTE,
        auditAction: 'MANUAL_MUTE_MEMBER',
        metadata: {
          ...metadataBase,
          reason: `Ручной мут участника ${this.describeManualModerationActionSource(source)}`,
          muteDurationHours,
          muteExpiresAt: muteExpiresAt.toISOString(),
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
          muteDurationHours,
          muteExpiresAt: muteExpiresAt.toISOString(),
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
        muteExpiresAt: muteExpiresAt.toISOString(),
        message: `Мут на ${muteDurationHours}ч.`,
      });
    }

    if (parsed.data.action === 'BAN') {
      await this.assertManualMemberModerationPreconditions(
        chatId,
        targetUserId,
        'BAN',
        resolvedBotId,
      );
      const executionMode = await this.resolveManualBanExecutionMode(chatId, resolvedBotId);

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
      await this.assertBotCanManageMembers(chatId, 'UNBAN', resolvedBotId);
      try {
        await this.maxClient.unbanMember(chatId, targetUserId, {
          immediate: true,
          ...(resolvedBotId ? { botId: resolvedBotId } : {}),
        });
      } catch (error: unknown) {
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

  async applyManualSystemBan(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    source: Extract<AdminActionSource, 'group_command' | 'private_command'> = 'group_command',
  ): Promise<ManualModerationActionResult> {
    const targetUserId = await this.prepareManualModerationTarget(chatId, targetUserIdRaw, user);
    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);
    await this.assertManualMemberModerationPreconditions(
      chatId,
      targetUserId,
      'BAN',
      resolvedBotId,
    );

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
      await this.maxClient.banMember(chatId, targetUserId, {
        immediate: true,
        ...(resolvedBotId ? { botId: resolvedBotId } : {}),
      });
    } catch (error: unknown) {
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
        mode: 'MAX_BLOCK_PERMANENT',
        recentMessageCleanup,
        crossChatFanout,
      },
      auditPayload: {
        userId: targetUserId,
        source,
        permanent: true,
        recentMessageCleanup,
        crossChatFanout,
      },
    });
    await this.sendManualBanChatNotice({
      chatId,
      targetUserId,
      source,
      removedOnly: false,
      botId: resolvedBotId,
    });

    return manualModerationActionResultSchema.parse({
      ok: true,
      action: 'BAN',
      userId: targetUserId,
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Пользователь забанен.',
    });
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
        muteExpiresAt: new Date(job.muteExpiresAt),
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

  private async resolveManualMuteCommandFollowUpSummaries(params: {
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    muteDurationHours: number;
    muteExpiresAt: Date;
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
          botId: await this.resolveManualActionBotAssignment(params.sourceChatId),
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
    if (params.source === 'group_command' || params.source === 'private_command') {
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

  private buildManualMuteFanoutJob(params: {
    sourceChatId: string;
    targetUserId: string;
    cleanupSourceChatMessages?: boolean;
    actor: AuthUser;
    muteDurationHours: number;
    muteExpiresAt: Date;
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
      muteExpiresAt: params.muteExpiresAt.toISOString(),
      source: params.source,
    };
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
    source: Extract<AdminActionSource, 'group_command' | 'private_command'>;
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
    source: Extract<AdminActionSource, 'group_command' | 'private_command'>,
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
        botId: botId ?? (await this.resolveManualActionBotAssignment(chatId)),
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
    muteDurationHours: number;
    muteExpiresAt: Date;
    source: Extract<AdminActionSource, 'group_command' | 'private_command'>;
  }): Promise<{
    mutedChatIds: string[];
    skippedChatIds: string[];
    failedChatIds: string[];
  }> {
    const { sourceChatId, targetUserId, actor, muteDurationHours, muteExpiresAt, source } = params;
    const result = {
      mutedChatIds: [] as string[],
      skippedChatIds: [] as string[],
      failedChatIds: [] as string[],
    };
    const chats = await this.resolveManualCommandFanoutChats(actor, sourceChatId);

    for (const [index, chat] of chats.entries()) {
      if (index > 0) {
        await this.sleepIfNeeded(this.manualFanoutLookupSpacingMs);
      }

      const targetState = await this.resolveManualFanoutTargetState(chat.id, targetUserId, {
        trafficClass: 'background',
      });
      if (targetState !== 'present') {
        result.skippedChatIds.push(chat.id);
        continue;
      }

      try {
        await this.recordManualModerationAction({
          chatId: chat.id,
          targetUserId,
          actorUserId: actor.userId,
          ruleCode: 'MANUAL_MUTE',
          sanctionAction: SanctionAction.MUTE,
          auditAction: 'MANUAL_MUTE_MEMBER',
          metadata: {
            source,
            initiatedByUserId: actor.userId,
            reason: `Ручной мут участника ${this.describeManualModerationActionSource(source)}`,
            muteDurationHours,
            muteExpiresAt: muteExpiresAt.toISOString(),
            sourceChatId,
            fanout: true,
          },
          auditPayload: {
            userId: targetUserId,
            source,
            muteDurationHours,
            muteExpiresAt: muteExpiresAt.toISOString(),
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
        await this.sleepIfNeeded(this.manualFanoutLookupSpacingMs);
      }

      const resolvedBotId = await this.resolveManualActionBotAssignment(chat.id);

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
        await this.sleepIfNeeded(this.manualFanoutActionSpacingMs);
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
        await this.sleepIfNeeded(options.spacingMs ?? 0);
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
            AND NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') = ${chatId}
            AND NULLIF(BTRIM(normalized_payload->'message'->>'senderId'), '') = ${targetUserId}
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
  ): Promise<string> {
    await this.assertChatAdmin(chatId, user.userId);
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
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        ...(botId ? { botId } : {}),
      } as never);
    } catch (error: unknown) {
      if (this.isBotAdminLookupDeniedError(error)) {
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
      },
      update: {
        sourceChatId,
        reason: 'MANUAL_UNBAN',
      },
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
      await deleteKeysByPattern.call(
        this.redisCounter,
        buildDuplicateUserPattern(chatId, targetUserId),
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId: targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to reset duplicate moderation state after manual release',
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
      const muteDurationHours = params.metadata.muteDurationHours;
      const muteExpiresAt = params.metadata.muteExpiresAt;
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
      actorUserId,
      ruleCode,
      sanctionAction,
      auditAction,
      metadata,
      auditPayload,
    } = params;

    await this.prisma.$transaction([
      this.prisma.moderationEvent.create({
        data: {
          chatId,
          userId: targetUserId,
          eventType: EventType.MEMBER_ACTION,
          ruleCode,
          action: sanctionAction,
          operator: Operator.ADMIN,
          metadata: metadata as Prisma.InputJsonValue,
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
      metadata,
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
    }
  }

  private async assertReadOnlyChatAdmin(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType | null = null,
  ): Promise<void> {
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

    await this.assertChatAdmin(chatId, userId, entityType, {
      syncPersistedAccess: false,
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

  private buildModerationFeedWhere(
    chatId: string,
    from: Date,
    to: Date,
    filter: ModerationFeedFilter,
  ): Prisma.ModerationEventWhereInput {
    const baseWhere: Prisma.ModerationEventWhereInput = {
      chatId,
      createdAt: { gte: from, lte: to },
    };

    if (filter === 'ALL') {
      return {
        ...baseWhere,
        OR: [
          {
            action: {
              in: ['WARN', 'DELETE_MESSAGE', 'MUTE', 'KICK', 'BAN'],
            },
          },
          {
            action: SanctionAction.NONE,
            ruleCode: {
              in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'],
            },
          },
        ],
      };
    }

    if (filter === 'UNMUTE') {
      return {
        ...baseWhere,
        action: SanctionAction.NONE,
        ruleCode: 'MANUAL_UNMUTE',
      };
    }

    if (filter === 'UNBAN') {
      return {
        ...baseWhere,
        action: SanctionAction.NONE,
        ruleCode: 'MANUAL_UNBAN',
      };
    }

    if (filter === 'BAN') {
      return {
        ...baseWhere,
        action: {
          in: [SanctionAction.BAN, SanctionAction.KICK],
        },
      };
    }

    return {
      ...baseWhere,
      action: filter,
    };
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
    const userProfile = userProfiles.get(row.userId);
    const metadata = this.normalizeModerationViolationMetadata(row.metadata);
    const action = this.normalizeModerationViolationAction(row.action, metadata);
    const ruleCode = this.normalizeModerationViolationRuleCode(row.ruleCode, row.action);
    const userDisplayName = userProfile?.displayName ?? null;

    return {
      id: row.id,
      action,
      ruleCode,
      userId: row.userId,
      userDisplayName,
      avatarUrl: userProfile?.avatarUrl ?? null,
      profileUrl: userProfile?.profileUrl ?? null,
      profileHandoffUrl:
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
    const baseWhere = this.buildModerationFeedWhere(chatId, from, to, query.filter);
    const rows = await this.prisma.moderationEvent.findMany({
      where: cursor
        ? {
            AND: [
              baseWhere,
              {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  {
                    createdAt: cursor.createdAt,
                    id: { lt: cursor.id },
                  },
                ],
              },
            ],
          }
        : baseWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const pageRows = rows.slice(0, limit);
    const userProfiles = await this.resolveUserProfiles(
      chatId,
      entityType,
      pageRows.map((row) => row.userId),
      profileOptions,
    );
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
    const cacheKey = this.buildModerationFeedPageCacheKey(
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

    let pending!: Promise<ModerationFeedPage>;
    pending = this.getModerationFeedPage(chatId, from, to, query, entityType, profileOptions).catch(
      (error: unknown) => {
        const current = this.moderationFeedPageCache.get(cacheKey);
        if (current?.promise === pending) {
          this.moderationFeedPageCache.delete(cacheKey);
        }
        throw error;
      },
    );

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
    const cacheKey = this.buildMembershipActivityFeedPageCacheKey(
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

    let pending!: Promise<MembershipActivityPage>;
    pending = this.getMembershipActivityFeedPage(
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
    const resolvedBotId = await this.resolveBackgroundReadBotAssignment(chatId);
    const now = new Date();
    const from = this.resolveLogsDashboardFrom(query.range, now);
    const [membersPage, header, settings] = await Promise.all([
      this.maxClient.getChatMembersPage(
        chatId,
        {
          limit,
          marker: query.cursor ?? null,
        },
        {
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
          ...(resolvedBotId ? { botId: resolvedBotId } : {}),
        },
      ),
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

  private async getCachedChatParticipantsPage(
    chatId: string,
    userId: string,
    query: ChatParticipantsQuery,
    entityType: ManagedEntityType,
  ): Promise<ChatParticipantsPage> {
    const cacheKey = this.buildChatParticipantsPageCacheKey(chatId, userId, entityType, query);
    const cached = this.chatParticipantsPageCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.promise;
    }

    let pending!: Promise<ChatParticipantsPage>;
    pending = this.buildChatParticipantsPage(chatId, userId, query, entityType).catch(
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

  private buildMembershipEventDedupeSourceSql(
    chatId: string,
    from: Date,
    to: Date,
    eventTypes: readonly string[],
  ): Prisma.Sql {
    return Prisma.sql`
      SELECT
        id,
        event_at AS created_at,
        event_type,
        user_id,
        sender_name
      FROM (
        SELECT
          id,
          event_at,
          event_type,
          user_id,
          sender_name,
          ROW_NUMBER() OVER (
            PARTITION BY chat_id, event_type, COALESCE(user_id, ''), event_at
            ORDER BY
              CASE
                WHEN sender_name IS NULL OR BTRIM(sender_name) = '' THEN 1
                ELSE 0
              END ASC,
              created_at DESC,
              id DESC
          ) AS membership_event_rank
        FROM chat_membership_activity_events
        WHERE chat_id = ${chatId}
          AND event_type IN (${Prisma.join(eventTypes)})
          AND event_at >= ${from}
          AND event_at <= ${to}
      ) membership_events_ranked
      WHERE membership_event_rank = 1
      ORDER BY event_at DESC, id DESC
    `;
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
            created_at < ${cursor.createdAt}
            OR (created_at = ${cursor.createdAt} AND id < ${cursor.id})
          )
        `
      : Prisma.empty;
    const limitClause =
      typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? Prisma.sql`LIMIT ${Math.max(1, Math.trunc(options.limit))}`
        : Prisma.empty;
    const membershipEventsSql = this.buildMembershipEventDedupeSourceSql(
      chatId,
      from,
      to,
      eventTypes,
    );

    return this.prisma.$queryRaw<MembershipEventRow[]>`
      WITH membership_events AS (${membershipEventsSql})
      SELECT
        id,
        created_at,
        event_type,
        user_id,
        sender_name
      FROM membership_events
      WHERE 1 = 1
        ${cursorClause}
      ORDER BY created_at ${orderDirectionSql}, id ${orderDirectionSql}
      ${limitClause}
    `;
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

  private buildMembershipSeries(
    bucketStarts: Date[],
    bucket: ChannelStatsBucket,
    rows: Array<{ created_at: Date | string; event_type: string | null }>,
  ) {
    const grouped = new Map<string, { joined: number; left: number }>();

    for (const row of rows) {
      const createdAt = this.toIsoString(row.created_at);
      if (!createdAt) {
        continue;
      }
      const bucketStart = this.floorChannelStatsBucket(new Date(createdAt), bucket).toISOString();
      const current = grouped.get(bucketStart) ?? { joined: 0, left: 0 };
      if (row.event_type === 'user_added') {
        current.joined += 1;
      } else if (row.event_type === 'user_removed') {
        current.left += 1;
      }
      grouped.set(bucketStart, current);
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

  private buildViewsSeries(
    bucketStarts: Date[],
    bucket: ChannelStatsBucket,
    posts: Array<{ publishedAt: Date; latestViews: number }>,
  ) {
    const grouped = new Map<string, number>();

    for (const post of posts) {
      const bucketStart = this.floorChannelStatsBucket(post.publishedAt, bucket).toISOString();
      grouped.set(bucketStart, (grouped.get(bucketStart) ?? 0) + Math.max(0, post.latestViews));
    }

    return bucketStarts.map((bucketStart) => ({
      at: bucketStart.toISOString(),
      views: grouped.get(bucketStart.toISOString()) ?? 0,
    }));
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
      FROM chat_membership_activity_events
      WHERE chat_id = ${chatId}
        AND user_id IN (${Prisma.join(normalizedUserIds)})
        AND sender_name IS NOT NULL
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
      const remoteCacheKey = this.buildResolvedUserProfileCacheKey(chatId, entityType, userId, {
        allowRemoteLookup: true,
      });
      const localCacheKey = this.buildResolvedUserProfileCacheKey(chatId, entityType, userId, {
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
      let batchPromise!: Promise<Map<string, ResolvedUserProfile>>;
      batchPromise = this.loadResolvedUserProfiles(
        chatId,
        entityType,
        missingUserIds,
        options,
      ).catch((error: unknown) => {
        for (const userId of missingUserIds) {
          const cacheKey = this.buildResolvedUserProfileCacheKey(
            chatId,
            entityType,
            userId,
            options,
          );
          const current = this.resolvedUserProfileCache.get(cacheKey);
          if (current?.promise === pendingByUserId.get(userId)) {
            this.resolvedUserProfileCache.delete(cacheKey);
          }
        }
        throw error;
      });

      for (const userId of missingUserIds) {
        const cacheKey = this.buildResolvedUserProfileCacheKey(chatId, entityType, userId, options);
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
    const normalizedUsername = username?.replace(/^@+/u, '').trim() ?? '';
    if (!normalizedUsername) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(normalizedUsername)}`;
  }

  private normalizeMaxProfileUrl(value: string | null): string | null {
    if (!value) {
      return null;
    }

    try {
      const parsed = new URL(value);
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

  private extractLegacyMaxUserId(url: string | null | undefined): string | null {
    if (typeof url !== 'string') {
      return null;
    }

    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol !== 'max:' || parsed.hostname.trim().toLowerCase() !== 'user') {
        return null;
      }

      const userId = decodeURIComponent(parsed.pathname.replace(/^\/+/u, '').trim());
      return userId || null;
    } catch {
      return null;
    }
  }

  private isLegacyProfileHandoffUrl(url: string | null | undefined): boolean {
    if (typeof url !== 'string') {
      return false;
    }

    try {
      const parsed = new URL(url.trim());
      const hostname = parsed.hostname.trim().toLowerCase();
      if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
        return false;
      }

      const startPayload = parsed.searchParams.get('start')?.trim() ?? '';
      return startPayload.startsWith(PROFILE_MENTION_START_PREFIX);
    } catch {
      return false;
    }
  }

  private normalizeLegacyProfileButtonUrl(url: string | null | undefined): string {
    const normalizedUrl = typeof url === 'string' ? url.trim() : '';
    if (
      this.extractLegacyMaxUserId(normalizedUrl) ||
      this.isLegacyProfileHandoffUrl(normalizedUrl)
    ) {
      return '';
    }

    return normalizedUrl;
  }

  private buildProfileMentionHandoffUrl(
    chatId: string,
    entityType: ManagedEntityType,
    userId: string,
    displayName: string | null,
  ): string | null {
    const normalizedChatId = chatId.trim();
    const normalizedUserId = userId.trim();
    if (!normalizedChatId || !normalizedUserId) {
      return null;
    }

    const startPayload = this.buildProfileMentionStartPayload({
      chatId: normalizedChatId,
      entityType,
      userId: normalizedUserId,
      displayName: displayName?.trim() || 'Пользователь',
    });
    return this.buildBotStartUrl(startPayload);
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

    for (const chatId of targetChatIds) {
      if (chatId === sourceChatId) {
        continue;
      }

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
    }
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
    const editedAt = this.readTrimmedString(payload.editedAt);
    const replyTo = this.readDialogReplyPreview(payload.replyTo);
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
      text: this.readTrimmedString(payload.text) ?? '',
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
        ? this.resolveChannelDialogThreadId(params.chatId, params.dialogType, params.token)
        : this.resolveChatDialogThreadId(params.chatId, params.dialogType, params.token);
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
    if (!text) {
      throw new BadRequestException('Введите текст комментария.');
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
            this.buildChatDialogButton(
              chatId,
              'comments',
              threadId,
              formatCommentsButtonText('💬 Комментарии', count),
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
            id.trim().length > 0 && !knownBotUserIds.has(id.trim()) && !this.isOwnBotUserId(id),
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
    const buttonContext = await this.buildPublishedChannelSuggestionButtonContext(chatId, payload);
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
  ): Promise<{
    buttons: MaxMessageButton[][];
    threadId: string | null;
    includeCommentsButton: boolean;
    includeSuggestButton: boolean;
    suggestButtonText: string | null;
    autoPostButtonsMode: ChannelSettings['autoPostButtonsMode'];
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
        ),
      ]);
    }

    if (includeSuggestButton) {
      buttons.push([this.buildChannelDialogButton(chatId, 'suggest', threadId, suggestButtonText)]);
    }

    return {
      buttons,
      threadId,
      includeCommentsButton,
      includeSuggestButton,
      suggestButtonText: includeSuggestButton ? suggestButtonText : null,
      autoPostButtonsMode,
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
          : await this.uploadChannelSuggestionImage({
              imageBase64: image.base64 ?? null,
              imageMimeType: image.mimeType ?? null,
              imageFileName: image.fileName ?? null,
            }, botId);

      return payload ? { imagePayload: payload } : {};
    }

    if (normalizedImages.length > 1) {
      const attachments: MaxAttachmentPayload[] = [];

      for (const image of normalizedImages) {
        const payload =
          image.payload && Object.keys(image.payload).length > 0
            ? image.payload
            : await this.uploadChannelSuggestionImage({
                imageBase64: image.base64 ?? null,
                imageMimeType: image.mimeType ?? null,
                imageFileName: image.fileName ?? null,
              }, botId);

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

    const uploadedImagePayload = await this.uploadChannelSuggestionImage({
      imageBase64: suggestion.imageBase64,
      imageMimeType: suggestion.imageMimeType,
      imageFileName: suggestion.imageFileName,
    }, botId);

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
        if (privateChatId && this.isPrivateDialogChatUnavailableError(error)) {
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
    const activeContextBotId = this.maxBotLinkService?.getContextOrDefaultBotId() ?? null;
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

  private buildChannelDialogLaunchUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    return this.buildEntityDialogLaunchUrl('channel', chatId, type, threadId);
  }

  private buildChannelDialogDirectWebAppUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    return this.buildEntityDialogDirectWebAppUrl('channel', chatId, type, threadId);
  }

  private buildChatDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
  ): MaxMessageButton {
    const launchUrl = this.buildChatDialogLaunchUrl(chatId, type, threadId);
    const webAppUrl = this.buildChatDialogDirectWebAppUrl(chatId, type, threadId);
    const botContactId = this.resolveBotContactId();

    return webAppUrl && botContactId
      ? {
          type: 'open_app',
          text,
          webApp: webAppUrl,
          contactId: botContactId,
        }
      : launchUrl
        ? {
          type: 'link',
          text,
          url: launchUrl,
        }
        : {
            type: 'link',
            text,
            url: webAppUrl ?? `${this.appBaseUrl ?? 'https://maxim.play-team.ru'}/app/`,
          };
  }

  private buildChatDialogLaunchUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    return this.buildEntityDialogLaunchUrl('chat', chatId, type, threadId);
  }

  private buildChatDialogDirectWebAppUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    return this.buildEntityDialogDirectWebAppUrl('chat', chatId, type, threadId);
  }

  private buildEntityDialogLaunchUrl(
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    return this.buildMiniappStartUrl(
      this.buildEntityDialogStartParam(entityType, chatId, type, threadId),
    );
  }

  private buildEntityDialogDirectWebAppUrl(
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    const token = this.buildEntityDialogToken(entityType, chatId, type, threadId);
    const encodedChatId = encodeURIComponent(chatId);
    const entitySegment = entityType === 'channel' ? 'channel' : 'chat';
    return `${this.appBaseUrl}/app/${entitySegment}/${encodedChatId}/dialog/${type}?token=${token}`;
  }

  private buildChannelDialogStartParam(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string {
    return this.buildEntityDialogStartParam('channel', chatId, type, threadId);
  }

  public buildChannelSuggestionStartPayload(chatId: string, threadId: string): string {
    const normalizedChatId = chatId.trim();
    const normalizedThreadId = threadId.trim();
    const compactThreadId = this.compactSuggestionThreadId(normalizedThreadId);

    if (!normalizedChatId || !compactThreadId) {
      return this.buildChannelDialogStartParam(chatId, 'suggest', threadId);
    }

    const signature = this.buildChannelSuggestionStartSignature(
      normalizedChatId,
      normalizedThreadId,
    );
    return `${CHANNEL_SUGGESTION_START_PARAM_PREFIX}${normalizedChatId}.${compactThreadId}.${signature}`;
  }

  private buildEntityDialogStartParam(
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string {
    const token = this.buildEntityDialogToken(entityType, chatId, type, threadId);
    const payload = JSON.stringify({
      v: 1,
      k: entityType === 'channel' ? 'channel-dialog' : 'chat-dialog',
      c: chatId,
      m: type,
      t: token,
    });
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${CHANNEL_DIALOG_START_PARAM_PREFIX}${encoded}`;
  }

  private buildMiniappStartUrl(startParam: string): string | null {
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    return (
      this.maxBotLinkService?.buildMiniappStartUrlSync?.(startParam) ??
      (this.ownBotUserId
        ? `https://max.ru/${encodeURIComponent(this.ownBotUserId)}?startapp=${encodeURIComponent(startParam)}`
        : null)
    );
  }

  private buildBotStartUrl(startPayload: string): string | null {
    if (!isValidMaxBotStartPayload(startPayload)) {
      return null;
    }

    return (
      this.maxBotLinkService?.buildBotStartUrlSync?.(startPayload) ??
      (this.ownBotUserId
        ? `https://max.ru/${encodeURIComponent(this.ownBotUserId)}?start=${encodeURIComponent(startPayload)}`
        : null)
    );
  }

  private parseCompactChannelSuggestionStartPayload(
    startPayload: string | null,
  ): { chatId: string; token: string } | null {
    if (!startPayload || !startPayload.startsWith(CHANNEL_SUGGESTION_START_PARAM_PREFIX)) {
      return null;
    }

    const rawPayload = startPayload.slice(CHANNEL_SUGGESTION_START_PARAM_PREFIX.length);
    const [chatIdRaw, compactThreadIdRaw, signatureRaw, ...rest] = rawPayload.split('.');
    if (rest.length > 0) {
      return null;
    }

    const chatId = chatIdRaw?.trim() ?? '';
    const compactThreadId = compactThreadIdRaw?.trim().toLowerCase() ?? '';
    const signature = signatureRaw?.trim().toLowerCase() ?? '';
    const threadId = this.expandSuggestionThreadId(compactThreadId);
    if (!chatId || !threadId || !/^[a-f0-9]{24}$/u.test(signature)) {
      return null;
    }

    if (!this.isValidChannelSuggestionStartSignature(signature, chatId, threadId)) {
      return null;
    }

    return {
      chatId,
      token: this.buildChannelDialogToken(chatId, 'suggest', threadId),
    };
  }

  private buildChannelSuggestionStartSignature(
    chatId: string,
    threadId: string,
    botToken = this.getCurrentBotToken(),
  ): string {
    return createHmac('sha256', botToken)
      .update(`suggest-start:${chatId}:${threadId}`)
      .digest('hex')
      .slice(0, 24);
  }

  private compactSuggestionThreadId(threadId: string): string | null {
    const normalized = threadId.trim().toLowerCase();
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(normalized)
    ) {
      return null;
    }

    return normalized.replace(/-/gu, '');
  }

  private expandSuggestionThreadId(compactThreadId: string): string | null {
    const normalized = compactThreadId.trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/u.test(normalized)) {
      return null;
    }

    return [
      normalized.slice(0, 8),
      normalized.slice(8, 12),
      normalized.slice(12, 16),
      normalized.slice(16, 20),
      normalized.slice(20),
    ].join('-');
  }

  private buildProfileMentionStartPayload(params: {
    chatId: string;
    entityType: ManagedEntityType;
    userId: string;
    displayName: string;
  }): string {
    const compactPayload = buildCompactProfileMentionStartPayload(
      {
        chatId: params.chatId,
        entityType: params.entityType,
        userId: params.userId,
      },
      this.getCurrentBotToken(),
    );
    if (compactPayload) {
      return compactPayload;
    }

    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'profile-mention',
        c: params.chatId,
        e: params.entityType,
        u: params.userId,
        n: params.displayName.trim() || 'Пользователь',
      } satisfies ProfileMentionStartPayload),
      'utf8',
    ).toString('base64url');

    return `${PROFILE_MENTION_START_PREFIX}${payload}`;
  }

  private buildChannelDialogToken(
    chatId: string,
    type: ChannelDialogType,
    threadId?: string | null,
  ): string {
    return this.buildEntityDialogToken('channel', chatId, type, threadId);
  }

  private buildEntityDialogToken(
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId?: string | null,
  ): string {
    const normalizedThreadId = threadId?.trim() ?? '';
    if (!normalizedThreadId) {
      return this.buildEntityDialogTokenSignature(entityType, chatId, type);
    }

    const payload = JSON.stringify({
      v: 1,
      d: normalizedThreadId,
      s: this.buildEntityDialogTokenSignature(entityType, chatId, type, normalizedThreadId),
    } satisfies ChannelDialogTokenPayload);
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${CHANNEL_DIALOG_TOKEN_PREFIX}${encoded}`;
  }

  private buildChannelDialogTokenSignature(
    chatId: string,
    type: ChannelDialogType,
    threadId?: string | null,
  ): string {
    return this.buildEntityDialogTokenSignature('channel', chatId, type, threadId);
  }

  private buildEntityDialogTokenSignature(
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId?: string | null,
    botToken = this.getCurrentBotToken(),
  ): string {
    const normalizedThreadId = threadId?.trim() ?? '';
    const baseScope =
      entityType === 'channel' ? `dialog:${chatId}:${type}` : `dialog:chat:${chatId}:${type}`;
    const scope = normalizedThreadId ? `${baseScope}:${normalizedThreadId}` : baseScope;
    return createHmac('sha256', botToken).update(scope).digest('hex');
  }

  private resolveChannelDialogThreadId(
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ): string | null {
    return this.resolveEntityDialogThreadId('channel', chatId, type, token);
  }

  private resolveChatDialogThreadId(
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ): string | null {
    return this.resolveEntityDialogThreadId('chat', chatId, type, token);
  }

  private resolveEntityDialogThreadId(
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ): string | null {
    const normalizedToken = typeof token === 'string' ? token.trim() : '';
    const openAgainMessage =
      entityType === 'channel'
        ? 'Неверный токен кнопки. Откройте диалог заново из сообщения канала.'
        : 'Неверный токен кнопки. Откройте диалог заново из сообщения чата.';
    const staleMessage =
      entityType === 'channel'
        ? 'Кнопка устарела. Откройте сообщение в канале и нажмите кнопку снова.'
        : 'Кнопка устарела. Откройте сообщение в чате и нажмите кнопку снова.';
    if (!normalizedToken) {
      throw new BadRequestException(openAgainMessage);
    }

    if (/^[a-f0-9]{64}$/iu.test(normalizedToken)) {
      const signature = normalizedToken.toLowerCase();
      if (!this.isValidEntityDialogTokenSignature(signature, entityType, chatId, type)) {
        throw new BadRequestException(staleMessage);
      }

      return null;
    }

    if (!normalizedToken.startsWith(CHANNEL_DIALOG_TOKEN_PREFIX)) {
      throw new BadRequestException(openAgainMessage);
    }

    const encodedPayload = normalizedToken.slice(CHANNEL_DIALOG_TOKEN_PREFIX.length);
    if (!encodedPayload) {
      throw new BadRequestException(openAgainMessage);
    }

    let payload: Partial<ChannelDialogTokenPayload>;
    try {
      payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as Partial<ChannelDialogTokenPayload>;
    } catch {
      throw new BadRequestException(openAgainMessage);
    }

    const threadId = this.readTrimmedString(payload.d);
    const signature = this.readTrimmedString(payload.s)?.toLowerCase() ?? '';
    if (
      payload.v !== 1 ||
      !threadId ||
      threadId.length > 120 ||
      !/^[a-f0-9]{64}$/u.test(signature)
    ) {
      throw new BadRequestException(openAgainMessage);
    }

    if (!this.isValidEntityDialogTokenSignature(signature, entityType, chatId, type, threadId)) {
      throw new BadRequestException(staleMessage);
    }

    return threadId;
  }

  private isValidChannelSuggestionStartSignature(
    providedHex: string,
    chatId: string,
    threadId: string,
  ): boolean {
    return this.maxBotTokenValidationSecrets.some((botToken) =>
      this.isValidChannelDialogSignature(
        providedHex,
        this.buildChannelSuggestionStartSignature(chatId, threadId, botToken),
      ),
    );
  }

  private isValidEntityDialogTokenSignature(
    providedHex: string,
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId?: string | null,
  ): boolean {
    return this.maxBotTokenValidationSecrets.some((botToken) =>
      this.isValidChannelDialogSignature(
        providedHex,
        this.buildEntityDialogTokenSignature(entityType, chatId, type, threadId, botToken),
      ),
    );
  }

  private isValidChannelDialogSignature(providedHex: string, expectedHex: string): boolean {
    return (
      providedHex.length === expectedHex.length &&
      timingSafeEqual(Buffer.from(providedHex, 'hex'), Buffer.from(expectedHex, 'hex'))
    );
  }

  private normalizeAppBaseUrl(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().replace(/\/+$/, '');
    if (!normalized || !/^https?:\/\//iu.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private normalizeOwnBotUserId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeBotContactId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!normalized || !/^\d+$/u.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private resolveBotContactId(botId?: string | null): string | null {
    const contextAwareContactId = this.maxBotLinkService?.resolveContactIdSync(botId);
    if (contextAwareContactId) {
      return contextAwareContactId;
    }

    if (!botId && this.explicitBotContactId) {
      return this.explicitBotContactId;
    }

    const resolvedBotId = this.maxBotRegistry?.getBotById(botId)?.id ?? null;
    const fallbackBotUserId = resolvedBotId ?? this.ownBotUserId;
    if (!fallbackBotUserId) {
      return null;
    }

    const [candidate] = fallbackBotUserId.split('_');
    return /^\d+$/u.test(candidate) ? candidate : null;
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

  private isOwnBotUserId(userId: string): boolean {
    if (this.maxBotLinkService?.isKnownBotUserId(userId)) {
      return true;
    }

    const normalized = userId.trim();
    if (!normalized) {
      return false;
    }

    if (this.explicitBotContactId && normalized === this.explicitBotContactId) {
      return true;
    }

    if (!this.ownBotUserId) {
      return false;
    }

    return normalized === this.ownBotUserId || normalized === this.ownBotUserId.split('_')[0];
  }

  private getCurrentBotToken(): string {
    return this.maxBotLinkService?.getBotTokenSync() ?? this.maxBotToken;
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

  private async resolveUnifiedBotRoute(
    request: MaxBotRouteRequest,
  ): Promise<MaxBotRoute | null> {
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
      (await this.maxBotLinkService?.resolveBotId({ chatId })) ??
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

  private async resolveManualActionBotAssignment(chatId: string): Promise<string | undefined> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return undefined;
    }

    const persistedBotId = await this.resolveChatBotIdForRead(normalizedChatId);
    let fallbackBotId = persistedBotId;
    const seenBotIds = new Set<string>();

    if (persistedBotId) {
      seenBotIds.add(persistedBotId);
      try {
        const access = await this.maxClient.getCurrentChatMemberAccess(normalizedChatId, {
          trafficClass: 'interactive',
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
        if (!this.isBotAdminLookupDeniedError(error)) {
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
          trafficClass: 'interactive',
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
        if (this.isBotAdminLookupDeniedError(error)) {
          continue;
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

    if (!this.isRequiredSubscriptionCurrentlyActive(settings)) {
      return;
    }

    await this.refreshRequiredSubscriptionAccessSnapshots(
      settings.requiredSubscriptionChannelIds,
      'required subscription settings update',
    );
  }

  private async refreshExecutionReadinessAfterChannelSettingsUpdate(chatId: string): Promise<void> {
    await this.refreshManagedEntityBotAccessSnapshots(chatId, 'channel', 'channel settings update');
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
      (await this.maxBotLinkService?.resolveBotIdForCapability({
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
      const resolvedContactId = this.resolveBotContactId(candidateBotId);
      if (resolvedContactId) {
        knownBotUserIds.add(resolvedContactId);
      }
    }

    const resolvedBotUserIds = await this.mapWithConcurrencyLimit(
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

  private async mapWithConcurrencyLimit<T, R>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }

    const concurrency = Math.max(1, Math.min(limit, items.length));
    const results: R[] = new Array<R>(items.length);
    let currentIndex = 0;

    const runWorker = async () => {
      while (true) {
        const itemIndex = currentIndex;
        currentIndex += 1;

        if (itemIndex >= items.length) {
          return;
        }

        results[itemIndex] = await worker(items[itemIndex]);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
    return results;
  }

  private isFallbackTitle(chatId: string, title: string): boolean {
    const normalized = title.trim();
    return normalized === `Chat ${chatId}` || normalized === `Channel ${chatId}`;
  }

  private resolvePresentableManagedEntityTitle(
    chatId: string,
    ...candidates: Array<string | null | undefined>
  ): string | null {
    for (const candidate of candidates) {
      const normalized = this.readTrimmedString(candidate);
      if (!normalized || normalized === chatId || this.isFallbackTitle(chatId, normalized)) {
        continue;
      }

      return normalized;
    }

    return null;
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
      const botContactId = this.resolveBotContactId(botId);

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

        if (!botAccess.isAdmin && !botAccess.isOwner) {
          return {
            status: 'denied',
            source: 'remote',
            reason: 'bot_not_admin',
          };
        }

        const userAccess =
          accessByUserId.get(normalizedUserId) ??
          (botContactId === normalizedUserId ? botAccess : null);
        if (userAccess?.isAdmin === true || userAccess?.isOwner === true) {
          return {
            status: 'granted',
            source: 'remote',
          };
        }

        return {
          status: 'denied',
          source: 'remote',
          reason: 'user_not_admin',
        };
      }

      const adminIds = hasRequestOptions
        ? await this.maxClient.getChatAdminIds(chatId, requestOptions)
        : await this.maxClient.getChatAdminIds(chatId);
      return adminIds.includes(userId)
        ? {
            status: 'granted',
            source: 'remote',
          }
        : {
            status: 'denied',
            source: 'remote',
            reason: 'user_not_admin',
          };
    } catch (error: unknown) {
      if (this.isMaxApiThrottleError(error)) {
        return {
          status: 'throttled',
          error,
        };
      }

      if (this.isBotAdminLookupDeniedError(error)) {
        return {
          status: 'denied',
          source: 'remote',
          reason: 'bot_not_admin',
        };
      }

      this.logger.warn(
        {
          chatId,
          userId,
          botId: botId ?? 'legacy',
          err: error instanceof Error ? error.message : String(error),
        },
        'Chat hidden: failed to validate bot/user admin access for candidate bot',
      );
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
      trafficClass?: 'critical' | 'interactive' | 'background';
      sourceTag?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<AdminAccessResolution> {
    const candidateBotIds = await this.resolveCandidateBotIdsForChat(chatId, {
      includeDiscoveryFallback: false,
    });
    if (candidateBotIds.length === 0) {
      const resolution = await this.loadRemoteAdminAccessForBot(chatId, userId, null, options);
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

    if (sawBotDenied) {
      await this.chatContextCache.setAdminAccess?.(chatId, userId, 'bot_denied');
      this.schedulePersistedChatAccessPrune(chatId, userId, 'remote_admin_access');
      return {
        status: 'denied',
        source: 'remote',
        reason: 'bot_not_admin',
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

    await this.chatContextCache.setAdminAccess?.(chatId, userId, 'bot_denied');
    this.schedulePersistedChatAccessPrune(chatId, userId, 'remote_admin_access');
    return {
      status: 'denied',
      source: 'remote',
      reason: 'bot_not_admin',
    };
  }

  private async resolveUserAndBotAdminAccess(
    chatId: string,
    userId: string,
    options: {
      bypassNegativeCache?: boolean;
      trafficClass?: 'critical' | 'interactive' | 'background';
      sourceTag?: string;
      timeoutMs?: number;
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
      return this.withAllowlistFallback(chatId, userId, inFlight);
    }

    const pending = this.loadRemoteAdminAccess(chatId, userId, {
      trafficClass: options.trafficClass,
      sourceTag: options.sourceTag,
      timeoutMs: options.timeoutMs,
    });
    this.adminAccessChecks.set(key, pending);

    try {
      return await this.withAllowlistFallback(chatId, userId, pending);
    } finally {
      this.adminAccessChecks.delete(key);
    }
  }

  private buildAdminAccessCheckKey(
    chatId: string,
    userId: string,
    options: {
      trafficClass?: 'critical' | 'interactive' | 'background';
      timeoutMs?: number;
    },
  ): string {
    const trafficClass = options.trafficClass ?? 'interactive';
    const timeoutKey =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : 'default';

    return [chatId, userId, trafficClass, timeoutKey].join(':');
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

    this.logger.warn(
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

  private extractMaxErrorStatus(error: unknown): number | null {
    const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
    return typeof maybeStatus === 'number' ? maybeStatus : null;
  }

  private extractMaxErrorCode(error: unknown): string | null {
    const maybeCode = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof maybeCode === 'string' && maybeCode.trim()
      ? maybeCode.trim().toLowerCase()
      : null;
  }

  private extractMaxErrorMessage(error: unknown): string {
    const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response
      ?.data?.message;
    if (typeof responseMessage === 'string' && responseMessage.trim()) {
      return responseMessage.trim().toLowerCase();
    }

    if (error instanceof Error && error.message.trim()) {
      return error.message.trim().toLowerCase();
    }

    return String(error).trim().toLowerCase();
  }

  private isPrivateDialogChatUnavailableError(error: unknown): boolean {
    const status = this.extractMaxErrorStatus(error);
    if (status === 404) {
      return true;
    }

    if (status !== 403) {
      return false;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found') {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('chat not found') ||
      message.includes('not accessible') ||
      message.includes('bot is not a chat member') ||
      message.includes('forbidden')
    );
  }

  private isBotAdminLookupDeniedError(error: unknown): boolean {
    const status = this.extractMaxErrorStatus(error);
    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found') {
      return true;
    }

    if (status !== 400 && status !== 403) {
      return false;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('method is available only for chat administrator') ||
      message.includes('bot is not a chat member') ||
      message.includes('not accessible') ||
      message.includes('chat not found')
    );
  }

  private isMaxApiThrottleError(error: unknown): boolean {
    const status = this.extractMaxErrorStatus(error);
    if (status === 429) {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return message.includes('rate limit exceeded') || message.includes('circuit breaker');
  }

  private isMaxApiTimeoutError(error: unknown): boolean {
    if (this.isPrismaKnownError(error, 'P2024')) {
      return false;
    }

    const maybeCode = (error as { code?: unknown }).code;
    if (typeof maybeCode === 'string' && maybeCode.trim().toUpperCase() === 'ECONNABORTED') {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return message.includes('timeout');
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
    await this.prisma.chatAdminAllowlist.deleteMany({
      where: {
        chatId,
        userId,
      },
    });
    this.forgetManagedEntitiesLastSuccessChat(userId, chatId);
    this.invalidateManagedEntitiesAllowlistCache(userId);
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
            this.isPrismaKnownError(error, 'P2024')
              ? 'Skipped persisted chat access prune because the Prisma pool is saturated'
              : 'Failed to prune persisted chat access',
          );
        } finally {
          this.pendingPersistedChatAccessPrunes.delete(key);
        }
      });
  }

  private isPrismaKnownError(error: unknown, code: string): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return error.code === code;
    }

    return (error as { code?: string } | null)?.code === code;
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
              entityType: this.toPrismaEntityType(entityType),
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
      if (options.allowLastSuccessFallback !== false && this.isPrismaKnownError(error, 'P2024')) {
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
          entityType: this.fromPrismaEntityType(row.chat.entityType),
          primaryBotId:
            this.normalizeRuntimeManagedEntityBotId(
              this.readTrimmedString(row.chat.primaryBotId) ??
                this.readTrimmedString(row.chat.botId) ??
                null,
            ) ?? null,
        }),
    );

    const unsupportedChatIds = chats
      .filter((chat) => this.isUnsupportedManagedChat(chat.id, chat.entityType))
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
          this.isPrismaKnownError(error, 'P2024')
            ? 'Skipped managed entities allowlist cleanup because the Prisma pool is saturated'
            : 'Failed to clean unsupported managed entities from allowlist',
        );
      }
    }

    const supportedChats = chats.filter(
      (chat) => !this.isUnsupportedManagedChat(chat.id, chat.entityType),
    );
    this.rememberManagedEntitiesLastSuccessChats(userId, supportedChats);

    return supportedChats;
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
          channelOverview: this.buildChannelOverview(settings),
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
        this.resolvePresentableManagedEntityTitle(
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

        const presentableTitle = this.resolvePresentableManagedEntityTitle(
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

    const pending = this.runManagedEntityHeaderHydration(
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
        if (this.managedEntityHeaderHydrationRuns.get(key) === pending) {
          this.managedEntityHeaderHydrationRuns.delete(key);
        }
      });

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

    await this.mapWithConcurrencyLimit(
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
          if (this.isMaxApiThrottleError(error) || this.isMaxApiTimeoutError(error)) {
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
      this.isFallbackTitle(chat.id, header.title) ||
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

    if (!this.isFallbackTitle(chat.id, title) && title !== chat.title) {
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
    const presentableTitle = this.resolvePresentableManagedEntityTitle(chatId, normalizedTitle);
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
          !existingTitle || existingTitle === chatId || this.isFallbackTitle(chatId, existingTitle);
      }
    }
    let resolvedBotId: string | null | undefined =
      this.maxBotRegistry?.getBotById(options.preferredBotId)?.id ?? observedBotIds[0] ?? null;
    if (!resolvedBotId) {
      try {
        resolvedBotId = (await this.resolveBotAssignment(chatId)) ?? undefined;
      } catch (error: unknown) {
        if (!this.isPrismaKnownError(error, 'P2024')) {
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
        ...(entityType ? { entityType: this.toPrismaEntityType(entityType) } : {}),
      },
      update: {
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        ...(shouldUpdateTitle
          ? {
              title: nextTitle,
            }
          : {}),
        ...(updateEntityType && entityType
          ? { entityType: this.toPrismaEntityType(entityType) }
          : {}),
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

    if (this.maxBotLinkService) {
      try {
        await this.maxBotLinkService.bindDiscoveredChatBots({
          chatId,
          primaryBotId: resolvedBotId,
          botIds: resolvedBotId ? [resolvedBotId, ...observedBotIds] : observedBotIds,
          title: persistedChat.title,
          entityType: entityType ? this.toPrismaEntityType(entityType) : null,
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
          this.isPrismaKnownError(error, 'P2024')
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

  private isPrivateDirectChat(chatId: string): boolean {
    const numericChatId = this.parseChatIdAsBigInt(chatId);
    return numericChatId !== null && numericChatId > 0n;
  }

  private isUnsupportedManagedChat(chatId: string, entityType: ManagedEntityType): boolean {
    return entityType === 'chat' && this.isPrivateDirectChat(chatId);
  }

  private parseChatIdAsBigInt(chatId: string): bigint | null {
    if (typeof chatId !== 'string') {
      return null;
    }

    const normalized = chatId.trim();
    if (!/^-?\d+$/u.test(normalized)) {
      return null;
    }

    try {
      return BigInt(normalized);
    } catch {
      return null;
    }
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
      if (this.fromPrismaEntityType(current.entityType) !== expectedEntityType) {
        throw new BadRequestException(
          expectedEntityType === 'channel'
            ? 'Этот ID относится к чату, а не к каналу.'
            : 'Этот ID относится к каналу, а не к чату.',
        );
      }
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
    if (!options.skipAdminCheck) {
      await this.assertReadOnlyChatAdmin(chatId, user.userId, entityType);
    }
    if (!options.skipEntityCheck) {
      await this.ensureEntityType(chatId, user.userId, entityType);
    }

    const cached = await this.chatContextCache.getManagedEntityHeader?.(chatId, entityType);
    if (
      cached &&
      !this.isManagedEntityHeaderStale(cached, this.toHeaderChatSummary(cached), {
        refreshMissingLink: entityType === 'channel',
      })
    ) {
      return this.attachManagedEntityHeaderBotAssignments(cached);
    }

    const persistedChat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        title: true,
      },
    });

    try {
      const resolvedBotId = await this.resolveBackgroundReadBotAssignment(chatId);
      const snapshot = await this.maxClient.getChatSnapshot(chatId, {
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
        ...(resolvedBotId ? { botId: resolvedBotId } : {}),
      });
      const title = snapshot.title?.trim() || persistedChat?.title?.trim() || chatId;

      if (
        persistedChat &&
        title &&
        title !== persistedChat.title &&
        !this.isFallbackTitle(chatId, title)
      ) {
        await this.prisma.chat.update({
          where: { id: chatId },
          data: { title },
        });
      }

      const header = this.createManagedEntityHeader({
        id: chatId,
        title,
        entityType,
        link: snapshot.link,
        participantsCount: snapshot.participantsCount,
        avatarUrl: snapshot.avatarUrl,
      });
      const enrichedHeader = await this.attachManagedEntityHeaderBotAssignments(header);
      await this.chatContextCache.setManagedEntityHeader?.(enrichedHeader);
      return enrichedHeader;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          entityType,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to load managed entity header snapshot from MAX API',
      );
    }

    if (cached) {
      return this.attachManagedEntityHeaderBotAssignments(cached);
    }

    const fallbackHeader = this.createManagedEntityHeader({
      id: chatId,
      title: persistedChat?.title?.trim() || chatId,
      entityType,
      link: null,
      participantsCount: null,
      avatarUrl: null,
    });
    const enrichedHeader = await this.attachManagedEntityHeaderBotAssignments(fallbackHeader);
    await this.chatContextCache.setManagedEntityHeader?.(enrichedHeader);
    return enrichedHeader;
  }

  private summarizeLogsDashboardModerationCounts(
    rows: Array<{
      action: SanctionAction;
      ruleCode: string | null;
      _count: { _all: number };
    }>,
  ): {
    warn: number;
    deleteMessage: number;
    mute: number;
    ban: number;
    unmute: number;
    unban: number;
  } {
    const summary = {
      warn: 0,
      deleteMessage: 0,
      mute: 0,
      ban: 0,
      unmute: 0,
      unban: 0,
    };

    for (const row of rows) {
      const count = this.toSafeInteger(row._count._all);
      if (row.action === 'WARN') {
        summary.warn += count;
        continue;
      }
      if (row.action === 'DELETE_MESSAGE') {
        summary.deleteMessage += count;
        continue;
      }
      if (row.action === 'MUTE') {
        summary.mute += count;
        continue;
      }
      if (row.action === SanctionAction.BAN || row.action === SanctionAction.KICK) {
        summary.ban += count;
        continue;
      }
      if (row.action !== SanctionAction.NONE) {
        continue;
      }
      if (row.ruleCode === 'MANUAL_UNMUTE') {
        summary.unmute += count;
        continue;
      }
      if (row.ruleCode === 'MANUAL_UNBAN') {
        summary.unban += count;
      }
    }

    return summary;
  }

  private buildLogsDashboardResponseCacheKey(
    chatId: string,
    userId: string,
    range: LogsDashboardRange,
    includeActivityPreview: boolean,
    includeModerationPreview: boolean,
  ): string {
    return `${chatId}:${userId}:${range}:activity=${includeActivityPreview ? 1 : 0}:moderation=${
      includeModerationPreview ? 1 : 0
    }`;
  }

  private buildModerationFeedPageCacheKey(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
    query: ModerationFeedQuery,
    profileOptions: ResolveUserProfilesOptions = {},
  ): string {
    const profileMode = profileOptions.allowRemoteLookup === false ? 'local' : 'remote';
    return [
      chatId,
      userId,
      entityType,
      query.range,
      query.filter,
      String(query.limit),
      query.cursor ?? '',
      profileMode,
    ].join(':');
  }

  private buildMembershipActivityFeedPageCacheKey(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
    query: MembershipActivityQuery,
    profileOptions: ResolveUserProfilesOptions = {},
  ): string {
    const profileMode = profileOptions.allowRemoteLookup === false ? 'local' : 'remote';
    return [
      chatId,
      userId,
      entityType,
      query.range,
      query.filter,
      String(query.limit),
      query.cursor ?? '',
      profileMode,
    ].join(':');
  }

  private buildChatParticipantsPageCacheKey(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
    query: ChatParticipantsQuery,
  ): string {
    return [chatId, userId, entityType, query.range, String(query.limit), query.cursor ?? ''].join(
      ':',
    );
  }

  private buildResolvedUserProfileCacheKey(
    chatId: string,
    entityType: ManagedEntityType,
    userId: string,
    options: ResolveUserProfilesOptions = {},
  ): string {
    return [
      chatId,
      entityType,
      userId,
      options.allowRemoteLookup === false ? 'local' : 'remote',
    ].join(':');
  }

  private invalidateLogsDashboardResponseCache(chatId: string): void {
    const prefix = `${chatId}:`;
    for (const key of this.logsDashboardResponseCache.keys()) {
      if (key.startsWith(prefix)) {
        this.logsDashboardResponseCache.delete(key);
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

  private toPrismaEntityType(entityType: ManagedEntityType): ChatEntityType {
    return entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
  }

  private fromPrismaEntityType(entityType: ChatEntityType): ManagedEntityType {
    return entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat';
  }

  private buildChannelOverview(
    settings: Pick<
      ChannelSettings,
      'commentsEnabled' | 'postSuggestionsEnabled' | 'commentsModerationEnabled'
    >,
  ): ChannelOverview {
    const enabledScenariosCount =
      Number(settings.commentsEnabled) + Number(settings.postSuggestionsEnabled);

    return {
      enabledScenariosCount,
      commentsEnabled: settings.commentsEnabled,
      postSuggestionsEnabled: settings.postSuggestionsEnabled,
      commentsModerationEnabled: settings.commentsEnabled && settings.commentsModerationEnabled,
    };
  }
}
