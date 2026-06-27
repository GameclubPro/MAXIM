import {
  BOT_SPEECH_EDITABLE_FIELD_KEYS,
  chatSettingsSchema,
  channelSettingsSchema,
  MAX_BROADCAST_IMAGE_BASE64_LENGTH,
  MAX_BROADCAST_IMAGES_TOTAL_BASE64,
  type BroadcastMediaType,
  type BroadcastScheduleMode,
  type BroadcastTextFormat,
  type BotSpeechMediaFieldKey,
  type ChannelSettings,
  type ChannelStatsResponse,
  type ChatSettings,
  type ChatSummary,
  type ManagedBroadcastTargetPreview,
  type ManagedEntitiesResponseDiff,
  type ManagedEntitiesResponseSnapshot,
  type ManagedEntitiesRefreshState,
  type ManagedEntityFavoriteType,
  type ManagedEntityType,
  type SendBroadcastRequest,
} from '@maxim/contracts';
import {
  ChatEntityType,
  ManagedBroadcastStatus as PrismaManagedBroadcastStatus,
  ManagedEntityFavoriteType as PrismaManagedEntityFavoriteType,
  Prisma,
} from '../prisma/prisma-client';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { MaxTextMarkup } from '../common/max-text-markup.util';
import type {
  MaxActionDispatchOptions,
  MaxAttachmentPayload,
  MaxBotChat,
  MaxMessageButton,
} from '../max/max-client.service';
import type { ModerationFeedReadModelRow } from './stats-read-model-selectors';

export type ApplySettingsToAllChatsResult = {
  sourceChatId: string;
  updatedChats: number;
  appliedChatIds: string[];
};

export type ManagedEntityTypeFilter = ManagedEntityType | 'all';

export type ManagedEntitiesListResult = {
  items: ChatSummary[];
  refresh: ManagedEntitiesRefreshState | null;
  fullScanCandidateIds?: string[];
  snapshot?: ManagedEntitiesResponseSnapshot | null;
  diff?: ManagedEntitiesResponseDiff | null;
};

export type ManagedEntitiesRefreshPresentation = {
  totalCandidates: number | null;
  lastSyncedAt: string | null;
};

export type ManagedEntitiesRefreshJobOutcome = {
  continueAfterMs: number;
} | null;

export type ManagedEntitiesManualRefreshBlockReason = 'in_progress' | 'recent_sync' | 'backoff';

export type ManagedEntitiesPublishedSnapshotReadResult = {
  items: ChatSummary[];
  version: string;
  builtAt: string;
  lastSyncedAt: string | null;
};

export type ManagedEntitiesPublishedDiffReadResult = {
  baseVersion: string;
  nextVersion: string;
  added: ChatSummary[];
  updated: ChatSummary[];
  removedIds: string[];
  orderedIds: string[];
};

export type ChannelPublicationEngagementContext = {
  buttons: MaxMessageButton[][];
  threadId: string | null;
  includeCommentsButton: boolean;
  includeSuggestButton: boolean;
  suggestButtonText: string | null;
  autoPostButtonsMode: ChannelSettings['autoPostButtonsMode'];
  suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'];
};

export const DEFAULT_GROUP_COMMAND_MUTE_DURATION_HOURS = 6;
export const ADMIN_ACCESS_VALIDATION_ROSTER_SYNC_THROTTLE_MS = 30_000;

export type ManagedEntitiesListOptions = {
  refresh?: boolean;
  includeRefreshState?: boolean;
  bypassRemoteCache?: boolean;
  resetRefreshCursor?: boolean;
  fresh?: boolean;
  sinceVersion?: string;
};

export type ManagedEntitiesDiscoverySnapshot = MaxBotChat[];
export type ManagedBotChatCatalogSnapshotRow = {
  botId: string;
  chatId: string;
  entityType: ChatEntityType;
  title: string | null;
  link: string | null;
  avatarUrl: string | null;
  lastEventTime: string | null;
  lastSeenAt: Date;
};
export type ManagedBotChatMembershipSnapshotRow = {
  botId: string;
  lastSeenAt: Date | null;
  lastWebhookAt: Date | null;
  chat: {
    id: string;
    title: string;
    entityType: ChatEntityType;
    botId: string | null;
    primaryBotId: string | null;
  };
};
export type ManagedEntityBotProfileSnapshot = {
  avatarUrl: string | null;
};

export type AssertChatAdminOptions = {
  syncPersistedAccess?: boolean;
  trafficClass?: 'critical' | 'interactive' | 'background';
  timeoutMs?: number;
  allowPersistedFallback?: boolean;
};

export type AdminReadBypassOptions = {
  skipAdminCheck?: boolean;
  skipEntityCheck?: boolean;
  forceRemote?: boolean;
  timeoutMs?: number;
};

export type TimedPromiseCacheEntry<T> = {
  expiresAtMs: number;
  promise: Promise<T>;
};

export type TimedValueCacheEntry<T> = {
  expiresAtMs: number;
  value: T;
};

export type ManagedEntityBotAssignmentsRow = {
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

export type AdminAccessResolution =
  | {
      status: 'granted';
      source: 'cache' | 'remote' | 'allowlist_fallback';
      userRole?: ManagedEntityAccessRoleValue;
      botRole?: ManagedEntityAccessRoleValue;
    }
  | {
      status: 'denied';
      source: 'cache' | 'remote';
      reason: 'user_not_admin' | 'bot_not_admin';
      userRole?: ManagedEntityAccessRoleValue;
      botRole?: ManagedEntityAccessRoleValue;
    }
  | {
      status: 'unknown';
      error: unknown;
    }
  | {
      status: 'throttled';
      error: unknown;
    };

export type ManagedEntityAccessRoleValue = 'OWNER' | 'ADMIN' | 'MEMBER' | 'UNKNOWN';
export type ManagedEntityAccessStateValue = 'GRANTED' | 'USER_DENIED' | 'BOT_DENIED';
export type ManagedEntityAccessEdgeRow = {
  chatId: string;
  botId: string;
  state?: ManagedEntityAccessStateValue;
  checkedAt?: Date | null;
  expiresAt?: Date | null;
};
export type ManagedEntityAccessEdgeClient = {
  findMany: (args: unknown) => Promise<ManagedEntityAccessEdgeRow[]>;
  upsert?: (args: unknown) => Promise<unknown>;
  updateMany?: (args: unknown) => Promise<unknown>;
};

export type AdminActionSource = 'miniapp' | 'private_bot' | 'private_command' | 'group_command';
export type ManualModerationFanoutSource = Extract<
  AdminActionSource,
  'miniapp' | 'group_command' | 'private_command'
>;
export type ManualBanFollowUpSource = ManualModerationFanoutSource;

export type AdoptChatRulesFromMessageInput = {
  sourceMessageId?: string | null;
  sourceMessageUrl?: string | null;
  text?: string | null;
};

export type ManualMemberModerationAction = 'MUTE' | 'BAN';
export type ManualMemberManageMembersAction = ManualMemberModerationAction | 'UNBAN';
export type ManualModerationBotAction = 'delete_message' | 'moderate_member';
export type ManualBanExecutionMode = 'MAX_BLOCK' | 'MAX_REMOVE_ONLY';
export type ManualUnbanExecutionMode = 'MAX_UNBLOCK' | 'ALREADY_PRESENT';
export type ManualModerationExecutionOptions = {
  actorAlreadyVerified?: boolean;
  preferredBotId?: string | null;
  targetDisplayNameHint?: string | null;
  allowTargetDisplayNameRemoteLookup?: boolean;
  fanoutAllChats?: boolean;
};
export type ResolveManualModerationActionBotAssignmentOptions = {
  preferredBotId?: string | null;
};

export type ResolvedUserProfile = {
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  profileHandoffUrl: string | null;
};

export type ResolveUserProfilesOptions = {
  allowRemoteLookup?: boolean;
};

export type ModerationFeedCursor = {
  createdAt: Date;
  id: string;
};

export type ChatParticipantsSearchCursor = {
  marker: string | null;
  skip: number;
  search: string;
};

export type ChannelSuggestionActor = Pick<AuthUser, 'userId'> & {
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
};

export type ChannelSuggestionImageAsset = {
  base64?: string | null;
  payload?: Record<string, unknown> | null;
  mimeType?: string | null;
  fileName?: string | null;
};

export type ChannelDialogAttachmentAsset = {
  kind: 'image' | 'file';
  payload?: Record<string, unknown> | null;
  base64?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  previewBase64?: string | null;
  width?: number | null;
  height?: number | null;
};

export type ChannelSuggestionTextMarkup = MaxTextMarkup;

export type ChannelSuggestionDeliveryInput = {
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

export type ModerationViolationRow = ModerationFeedReadModelRow;

export type PreparedManagedBroadcastRequest = {
  payload: SendBroadcastRequest;
  targetChatIds: string[];
  normalizedSourceText: string;
};

export type ManagedBroadcastResolvedMedia = {
  imagePayload?: Record<string, unknown>;
  attachments?: MaxAttachmentPayload[];
};

export type ManagedBroadcastMaxApiOptions = Pick<
  MaxActionDispatchOptions,
  'trafficClass' | 'actionHealthLane' | 'sourceTag'
>;

export type ManagedBroadcastSchedulePlan = {
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

export type ManagedBroadcastBackgroundDecision = {
  action: 'run' | 'slow' | 'pause';
  reason: string;
  retryAfterMs: number;
};

export type ParsedManagedBroadcastCalendarSlots = {
  upcomingSlots: Date[];
  sentCount: number;
};

export type BroadcastOccurrenceResult = {
  status: PrismaManagedBroadcastStatus;
  currentOccurrence: number;
  sentChatIds: string[];
  failedChatIds: string[];
  pendingChatIds: string[];
  canRetry: boolean;
  firstSendError: unknown;
  nextSendAt: Date | null;
};

export type ManagedBroadcastDeliverySnapshot = {
  currentOccurrence: number;
  deliveredChats: number;
  failedChats: number;
  pendingChats: number;
  blockedChats: number;
  failureBreakdown: ManagedBroadcastFailureBreakdown;
  canRetry: boolean;
};

export type ManagedBroadcastTargetPreviewBundle = {
  previews: ManagedBroadcastTargetPreview[];
  overflowCount: number;
};

export type ManagedBroadcastFailureBreakdown = {
  transient: number;
  permanentTarget: number;
  quarantined: number;
  unknown: number;
};

export type MembershipEventRow = {
  id: string;
  created_at: Date | string;
  event_type: string | null;
  user_id: string | null;
  sender_name: string | null;
};

export const MAX_UPLOADED_IMAGE_BYTES = Math.floor((MAX_BROADCAST_IMAGE_BASE64_LENGTH * 3) / 4);
export const RULES_IMAGE_MAX_BYTES = MAX_UPLOADED_IMAGE_BYTES;
export const BROADCAST_IMAGE_MAX_BYTES = MAX_UPLOADED_IMAGE_BYTES;
export const BROADCAST_IMAGES_TOTAL_MAX_BYTES = Math.floor(
  (MAX_BROADCAST_IMAGES_TOTAL_BASE64 * 3) / 4,
);
export const BROADCAST_MIN_DELAY_MS = 30_000;
export const BROADCAST_MAX_DELAY_MS = 31 * 24 * 60 * 60 * 1000;
export const MANAGED_BROADCAST_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MANAGED_BROADCAST_HISTORY_LIMIT = 8;
export const BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS = [1_500, 3_000, 6_000];
export const BROADCAST_THROTTLE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
export const BROADCAST_TIMEOUT_RETRY_DELAYS_MS = [1_500, 4_000, 10_000];
export const CHANNEL_SUGGESTION_DELIVERY_JOB_TIMEOUT_MS = 60_000;
export const CHANNEL_SUGGESTION_ADMIN_LOOKUP_TIMEOUT_MS = 2_500;
export const CHANNEL_SUGGESTION_UPLOAD_TIMEOUT_MS = 12_000;
export const CHANNEL_SUGGESTION_SEND_TIMEOUT_MS = 8_000;
export const BROADCAST_CALENDAR_SLOT_MINUTES = 30;
export const MANAGED_BROADCAST_DUE_BATCH_SIZE = 10;
export const MANAGED_BROADCAST_DUE_SLOW_BATCH_SIZE = 2;
export const MANAGED_BROADCAST_RECOVERY_BATCH_SIZE = 2;
export const MANAGED_BROADCAST_RECOVERY_SLOW_BATCH_SIZE = 1;
export const MANAGED_BROADCAST_DUE_MAX_PASSES = 100;
export const MANAGED_BROADCAST_LOCK_STALE_MS = 5 * 60_000;
export const MANAGED_BROADCAST_AUTO_RETRY_BACKOFF_MS = 5 * 60 * 1000;
export const MANAGED_BROADCAST_MAX_AUTO_RETRY_ATTEMPTS = 6;
export const MANAGED_BROADCAST_TARGET_QUARANTINE_FAILURE_OCCURRENCES = 3;
export const MANAGED_BROADCAST_TARGET_QUARANTINE_ATTEMPTS =
  MANAGED_BROADCAST_MAX_AUTO_RETRY_ATTEMPTS;
export const MANAGED_BROADCAST_TRANSIENT_QUARANTINE_REASON_PREFIX =
  'Чат временно исключен из оставшихся доставок после повторяющихся ошибок отправки';
export const MANAGED_BROADCAST_DEGRADE_PAUSE_RETRY_MS = 15_000;
export const MANAGED_BROADCAST_DEGRADE_PAUSE_LOG_INTERVAL_MS = 60_000;
export const MANAGED_BROADCAST_TARGET_PREVIEW_LIMIT = 3;
export const LOGS_DASHBOARD_VIOLATIONS_LIMIT = 50;
export const MEMBERSHIP_ACTIVITY_PAGE_LIMIT = 50;
export const LOGS_DASHBOARD_RESPONSE_CACHE_TTL_MS = 30_000;
export const SLOW_LOGS_DASHBOARD_THRESHOLD_MS = 1_500;
export const EVENTS_FEED_PAGE_CACHE_TTL_MS = 30_000;
export const CHANNEL_STATS_RESPONSE_CACHE_TTL_MS = 30_000;
export const CHANNEL_STATS_REFRESHING_RESPONSE_CACHE_TTL_MS = 5_000;
export const SLOW_CHANNEL_STATS_THRESHOLD_MS = 1_500;
export const RESOLVED_USER_PROFILE_CACHE_TTL_MS = 30_000;
export const CHAT_PARTICIPANTS_SEARCH_REMOTE_PAGES_PER_RESPONSE = 2;
export const CHAT_PARTICIPANTS_SEARCH_MAX_API_WAIT_MS = 700;
export const ONE_HOUR_MS = 60 * 60 * 1000;
export const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;
export const DEFAULT_PARTICIPANT_IMMUNITY_TIMEZONE = 'Europe/Moscow';
export const MANUAL_BAN_RECENT_MESSAGE_DELETE_LIMIT = 1000;
export const LIST_CHATS_ADMIN_CHECK_CONCURRENCY = 2;
export const MANAGED_ENTITIES_DELTA_ADMIN_CHECK_SPACING_MS =
  process.env.NODE_ENV === 'test' ? 0 : 350;
export const MANAGED_ENTITIES_FULL_SCAN_ADMIN_CHECK_SPACING_MS =
  process.env.NODE_ENV === 'test' ? 0 : 550;
export const MANAGED_ENTITIES_DELTA_DISCOVERY_WINDOW_SIZE = 3;
export const MANAGED_ENTITIES_FOREGROUND_CANDIDATE_CHECK_LIMIT = 10;
export const MANAGED_ENTITIES_BACKGROUND_CANDIDATE_CHECK_LIMIT = 50;
export const MANAGED_ENTITIES_REFRESH_UNCACHED_LIMIT =
  MANAGED_ENTITIES_FOREGROUND_CANDIDATE_CHECK_LIMIT;
export const MANAGED_ENTITIES_REFRESH_SCAN_WINDOW_SIZE = 6;
export const MANAGED_ENTITIES_BACKGROUND_CATALOG_SYNC_WINDOW_SIZE = 3;
export const MANAGED_ENTITIES_LOCAL_REFRESH_SCAN_WINDOW_SIZE =
  MANAGED_ENTITIES_BACKGROUND_CANDIDATE_CHECK_LIMIT;
export const MANAGED_ENTITIES_ALLOWLIST_CACHE_TTL_MS = 2_000;
export const MANAGED_ENTITIES_ALLOWLIST_RESPONSE_BUDGET_MS = 250;
export const MANAGED_ENTITIES_ALLOWLIST_EDGE_REPAIR_BATCH_SIZE = 50;
export const MANAGED_ENTITIES_SUSPICIOUS_ALLOWLIST_REVALIDATION_LIMIT = 3;
export const MANAGED_ENTITIES_SUSPICIOUS_ALLOWLIST_ADMIN_TIMEOUT_MS = 300;
export const MANAGED_ENTITIES_LAST_SUCCESS_SNAPSHOT_TTL_MS = 60_000;
export const MANAGED_ENTITIES_LIGHTWEIGHT_RECENT_BOOTSTRAP_RESPONSE_BUDGET_MS = 500;
export const MANAGED_ENTITIES_RESPONSE_WARMUP_BUDGET_MS = 1_500;
export const MANAGED_ENTITIES_LOCAL_DISCOVERY_ADMIN_TIMEOUT_MS = 1_000;
export const MANAGED_ENTITIES_REMOTE_DELTA_ADMIN_TIMEOUT_MS = 1_200;
export const MANAGED_ENTITIES_REMOTE_FULL_SCAN_ADMIN_TIMEOUT_MS = 1_800;
export const MANAGED_ENTITIES_REMOTE_DELTA_SNAPSHOT_TIMEOUT_MS = 2_500;
export const MANAGED_ENTITIES_REMOTE_FULL_SCAN_SNAPSHOT_TIMEOUT_MS = 4_000;
export const MANAGED_ENTITIES_PRIORITY_ALLOWLIST_WARMUP_LIMIT = 12;
export const MANAGED_ENTITIES_REFRESH_CURSOR_DONE = -1;
export const MANAGED_ENTITIES_REFRESH_CURSOR_TTL_SEC = 60 * 60;
export const MANAGED_ENTITIES_REFRESH_CURSOR_DONE_TTL_SEC = 60;
export const MANAGED_ENTITIES_REFRESH_SNAPSHOT_TTL_SEC = 5 * 60;
export const MANAGED_ENTITIES_REFRESH_LAST_SYNCED_TTL_SEC = 30 * 24 * 60 * 60;
export const MANAGED_ENTITIES_PUBLISHED_DIFF_MAX_CHANGE_RATIO = 0.3;
export const MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC = 7 * 24 * 60 * 60;
export const MANAGED_ENTITIES_REFRESH_SUCCESS_COOLDOWN_MS = 45_000;
export const MANAGED_ENTITIES_MANUAL_REFRESH_RECENT_SYNC_WINDOW_MS = 30_000;
export const MANAGED_ENTITIES_REFRESH_BACKOFF_MS = 60_000;
export const MANAGED_ENTITIES_REFRESH_FRESHNESS_WINDOW_MS = 10 * 60_000;
export const MANAGED_ENTITIES_REFRESH_NEXT_POLL_AFTER_MS = 1_500;
export const MANAGED_ENTITIES_REFRESH_IDLE_NEXT_POLL_AFTER_MS = 3_000;
export const MANAGED_ENTITIES_REFRESH_DEGRADE_PAUSE_RETRY_MS = 15_000;
export const MANAGED_ENTITIES_REFRESH_QUEUE_LAG_SLOW_PATH_MAX_SEC = 30;
export const MANAGED_ENTITIES_DEGRADE_PAUSE_LOG_INTERVAL_MS = 60_000;
export const MANAGED_ENTITIES_DISCOVERY_HEADER_PRIME_COOLDOWN_MS = 60_000;
export const MANAGED_ENTITIES_DISCOVERY_HEADER_PRIME_CONCURRENCY = 24;
export const MANAGED_BOT_CHAT_CATALOG_WRITE_CONCURRENCY = 8;
export const MANAGED_BOT_CHAT_CATALOG_FALLBACK_LIMIT = 20_000;
export const MANAGED_BOT_CHAT_CATALOG_MARK_MISSING_MAX_SEEN = 10_000;
export const MANAGED_ENTITIES_MASS_ACTION_FULL_SCAN_MAX_PASSES = 75;
export const MANAGED_ENTITY_HEADER_HYDRATION_BATCH_SIZE = 8;
export const MANAGED_ENTITY_HEADER_HYDRATION_CONCURRENCY = 1;
export const ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES = [403, 404] as const;
export const ADMIN_ACTION_HEALTH_LANE = 'background' as const;
export const ADMIN_MANUAL_GROUP_COMMAND_QUEUE_PRIORITY = 1;
export const ADMIN_MANUAL_FANOUT_QUEUE_PRIORITY = 20;
export const ADMIN_SUPER_BAN_QUEUE_PRIORITY = 1;
export const DEFAULT_SUPER_BAN_DEVELOPER_USER_IDS = ['98315271'] as const;
export const APPLY_SETTINGS_TO_ALL_CHATS_CONCURRENCY = 6;
export const APPLY_SETTINGS_TO_ALL_READINESS_REFRESH_CONCURRENCY = 2;
export const APPLY_SETTINGS_TO_ALL_READINESS_REFRESH_SPACING_MS =
  process.env.NODE_ENV === 'test' ? 0 : 250;
export const APPLY_SETTINGS_TO_ALL_DOMAIN_SYNC_CONCURRENCY = 4;
export const REQUIRED_SUBSCRIPTION_CHANNEL_CHECK_CONCURRENCY = 3;
export const CHANNEL_DIALOG_MESSAGES_LIMIT = 80;
export const COMMENT_NOTIFICATION_DELIVERY_CONCURRENCY = 4;
export const COMMENT_NOTIFICATION_PREVIEW_MAX_LENGTH = 180;
export const CHANNEL_DIALOG_ACTION_COMMENT = 'CHANNEL_DIALOG_COMMENT';
export const CHANNEL_DIALOG_ACTION_SUGGEST = 'CHANNEL_DIALOG_SUGGESTION';
export const CHANNEL_DIALOG_ACTION_PUBLISH = 'PUBLISH_CHANNEL_ENGAGEMENT';
export const CHANNEL_DIALOG_ACTION_AUTO_ATTACH = 'AUTO_ATTACH_CHANNEL_ENGAGEMENT';
export const CHAT_DIALOG_ACTION_AUTO_ATTACH = 'AUTO_ATTACH_CHAT_COMMENTS';
export const PRIVATE_CONTROL_CALLBACK_PREFIX = 'pc2';
export const CHANNEL_DIALOG_START_PARAM_PREFIX = 'cd-';
export const DEFAULT_CHAT_SETTINGS = chatSettingsSchema.parse({});
export const DEFAULT_CHANNEL_SETTINGS = channelSettingsSchema.parse({});
export const CHAT_SETTINGS_BUTTON_GROUPS = [
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
export const CHANNEL_SETTINGS_BUTTON_URL_KEYS = [
  'postSuggestionsButtonUrl',
] as const satisfies readonly (keyof ChannelSettings)[];
export const CHANNEL_SETTINGS_BUTTON_ENABLED_BY_URL_KEY = {
  postSuggestionsButtonUrl: 'postSuggestionsButtonEnabled',
} as const satisfies Record<
  (typeof CHANNEL_SETTINGS_BUTTON_URL_KEYS)[number],
  keyof ChannelSettings
>;
export const SETTINGS_SECTION_KEYS = {
  links: [
    'linkPolicy',
    'linkEscalationWindowHours',
    'linkWarnMaxCount',
    'linkMuteMaxCount',
    'linkBanMaxCount',
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
    'linkAdminContactButtonEnabled',
    'linkAdminContactButtonUrl',
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
    'profanityAdminContactButtonEnabled',
    'profanityAdminContactButtonUrl',
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
    'textFiltersAdminContactButtonEnabled',
    'textFiltersAdminContactButtonUrl',
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
    'thematicFiltersAdminContactButtonEnabled',
    'thematicFiltersAdminContactButtonUrl',
  ],
  duplicates: [
    'antiDuplicateEnabled',
    'duplicateDetectionPreset',
    'duplicateIgnoreLinksEnabled',
    'duplicateIgnorePhonesEnabled',
    'duplicateNearMatchEnabled',
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
    'duplicateAdminContactButtonEnabled',
    'duplicateAdminContactButtonUrl',
  ],
  limits: [
    'antiSpamEnabled',
    'deleteSpammersEnabled',
    'messageCountLimitEnabled',
    'messageCountLimitMessages',
    'messageCountLimitWindowHours',
    'maxMessageLengthEnabled',
    'maxMessageLength',
    'photoMessageCooldownEnabled',
    'photoMessageCooldownHours',
    'stickerMessageCooldownEnabled',
    'stickerMessageCooldownMinutes',
    'photoMessagesEnabled',
    'videoMessagesEnabled',
    'fileMessagesEnabled',
    'voiceMessagesEnabled',
    'messageLimitsBotMessageEnabled',
    'messageLimitsBotMessageText',
    'messageLimitsWarnEnabled',
    'messageLimitsWarnMessageText',
    'messageLimitsBanEnabled',
    'messageLimitsMuteEnabled',
    'messageLimitsMuteDurationHours',
    'messageLimitsBotButtons',
    'messageLimitsBotButtonEnabled',
    'messageLimitsBotButtonUrl',
    'messageLimitsBotButtonText',
    'messageLimitsAdminContactButtonEnabled',
    'messageLimitsAdminContactButtonUrl',
    'phoneNumbersEnabled',
  ],
  stopWords: [
    'messageLimitsBlockedWords',
    'messageLimitsBlockedDomains',
    'messageLimitsBotMessageText',
    'messageLimitsWarnMessageText',
  ],
  phones: [
    'phoneNumbersEnabled',
    'phoneNumbersBotMessageEnabled',
    'phoneNumbersBotMessageText',
    'phoneNumbersWarnEnabled',
    'phoneNumbersMuteEnabled',
    'phoneNumbersMuteDurationHours',
    'phoneNumbersBanEnabled',
    'phoneNumbersEscalationWindowHours',
    'phoneNumbersWarnMaxCount',
    'phoneNumbersMuteMaxCount',
    'phoneNumbersBanMaxCount',
    'phoneNumbersAdminContactButtonEnabled',
    'phoneNumbersAdminContactButtonUrl',
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
    'requiredSubscriptionBotMessageEnabled',
    'requiredSubscriptionBotMessageText',
    'requiredSubscriptionButtonText',
    'requiredSubscriptionAdminContactButtonEnabled',
    'requiredSubscriptionAdminContactButtonUrl',
    'requiredSubscriptionWarnEnabled',
    'requiredSubscriptionWarnMessageText',
    'requiredSubscriptionBanEnabled',
    'requiredSubscriptionMuteEnabled',
    'requiredSubscriptionMuteDurationHours',
  ],
  invitationAccess: [
    'invitationAccessEnabled',
    'invitationAccessRequiredCount',
    'invitationAccessBotMessageEnabled',
    'invitationAccessBotMessageText',
    'invitationAccessAdminContactButtonEnabled',
    'invitationAccessAdminContactButtonUrl',
    'invitationAccessWarnEnabled',
    'invitationAccessWarnMessageText',
    'invitationAccessBanEnabled',
    'invitationAccessMuteEnabled',
    'invitationAccessMuteDurationHours',
  ],
  commands: [
    'adminBanCommandName',
    'adminBanAllCommandName',
    'adminMuteCommandName',
    'adminPermanentMuteCommandName',
    'adminRulesCommandName',
    'adminSilenceCommandName',
    'adminOpenChatCommandName',
  ],
  extra: [
    'deleteBotMessagesEnabled',
    'deleteBotMessagesDelayMinutes',
    'removeBotsFromGroupEnabled',
  ],
} as const satisfies Record<string, readonly (keyof ChatSettings)[]>;
export const SETTINGS_SECTION_BOT_SPEECH_MEDIA_KEYS = {
  links: ['linkBotMessageText', 'linkWarnMessageText'],
  greeting: ['greetingBotMessageText'],
  profanityFilter: [],
  commercialFilter: ['textFiltersBotMessageText', 'textFiltersWarnMessageText'],
  thematicFilters: [],
  duplicates: ['duplicateBotMessageText'],
  limits: ['messageLimitsBotMessageText', 'messageLimitsWarnMessageText'],
  stopWords: ['messageLimitsBotMessageText', 'messageLimitsWarnMessageText'],
  phones: ['phoneNumbersBotMessageText'],
  night: ['nightModeBotMessageText', 'nightModeOpenMessageText'],
  requiredSubscription: [
    'requiredSubscriptionBotMessageText',
    'requiredSubscriptionWarnMessageText',
  ],
  invitationAccess: ['invitationAccessBotMessageText', 'invitationAccessWarnMessageText'],
  commands: [],
  extra: [],
} as const satisfies Record<keyof typeof SETTINGS_SECTION_KEYS, readonly BotSpeechMediaFieldKey[]>;
export const BOT_SPEECH_MEDIA_SETTING_KEYS = BOT_SPEECH_EDITABLE_FIELD_KEYS;
export const REQUIRED_SUBSCRIPTION_SETTING_KEYS = SETTINGS_SECTION_KEYS.requiredSubscription;
export const MANAGED_ENTITY_FAVORITE_TYPE_ORDER: ManagedEntityFavoriteType[] = [
  'important',
  'watch',
  'broadcast',
  'test',
  'partner',
  'service',
];
export const PRISMA_FAVORITE_TYPE_BY_CONTRACT = {
  important: PrismaManagedEntityFavoriteType.IMPORTANT,
  watch: PrismaManagedEntityFavoriteType.WATCH,
  broadcast: PrismaManagedEntityFavoriteType.BROADCAST,
  test: PrismaManagedEntityFavoriteType.TEST,
  partner: PrismaManagedEntityFavoriteType.PARTNER,
  service: PrismaManagedEntityFavoriteType.SERVICE,
} as const satisfies Record<ManagedEntityFavoriteType, PrismaManagedEntityFavoriteType>;
export const CONTRACT_FAVORITE_TYPE_BY_PRISMA = {
  [PrismaManagedEntityFavoriteType.IMPORTANT]: 'important',
  [PrismaManagedEntityFavoriteType.WATCH]: 'watch',
  [PrismaManagedEntityFavoriteType.BROADCAST]: 'broadcast',
  [PrismaManagedEntityFavoriteType.TEST]: 'test',
  [PrismaManagedEntityFavoriteType.PARTNER]: 'partner',
  [PrismaManagedEntityFavoriteType.SERVICE]: 'service',
} as const satisfies Record<PrismaManagedEntityFavoriteType, ManagedEntityFavoriteType>;
export const APPLY_SECTION_TARGET_PREVIEW_SAMPLE_LIMIT = 8;
export const CHANNEL_STATS_POST_ACTIONS = [
  CHANNEL_DIALOG_ACTION_PUBLISH,
  CHANNEL_DIALOG_ACTION_AUTO_ATTACH,
] as const;
export const CHANNEL_STATS_ACTIVITY_ACTIONS = [
  ...CHANNEL_STATS_POST_ACTIONS,
  CHANNEL_DIALOG_ACTION_COMMENT,
  CHANNEL_DIALOG_ACTION_SUGGEST,
] as const;
export const CHANNEL_STATS_REFRESH_STALE_MS = 2 * 60 * 60 * 1000;
export type ChannelStatsPostRow = {
  id: string;
  messageId: string;
  publishedAt: Date;
  url: string | null;
  previewUrl: string | null;
  latestViews: number;
  latestReactions: Prisma.JsonValue | null;
  latestReactionsTotal: number;
  latestSnapshotAt: Date | null;
};
export type ChannelStatsViewSnapshotRow = {
  channelPostId: string;
  views: number;
  reactionsTotal: number;
  capturedAt: Date;
};
export type ChannelStatsSummaryWindowRow = {
  channel_post_id: string;
  published_at: Date | string;
  captured_at: Date | string;
  snapshot_id: string;
  views: unknown;
  reactions_total: unknown;
};
export type ChannelStatsPostViewMetric = {
  post: ChannelStatsPostRow;
  viewsDelta: number;
  viewDeltas: Array<{
    capturedAt: Date;
    viewsDelta: number;
  }>;
};
export type ChannelStatsContentBucketPoint = {
  at: string;
  posts: number;
  viewsDelta: number;
  reactions: number;
};
export type ChannelStatsViewsBucketPoint = {
  at: string;
  posts: number;
  views: number;
};
export type ChannelStatsPeriodTotals = {
  joined: number;
  left: number;
  net: number;
  posts: number;
  views: number;
  averageViewsPerPost: number;
  reactions: number;
};
export type ChannelStatsComparisonSeries = NonNullable<
  ChannelStatsResponse['comparison']['series']
>;
export type ChannelStatsPreviousPeriodSnapshot = {
  totals: ChannelStatsPeriodTotals;
  series: ChannelStatsComparisonSeries;
};
export type ChannelStatsDeltaMetric = ChannelStatsResponse['comparison']['deltas']['views'];
export type ChannelStatsGraphMarker = ChannelStatsResponse['signals']['markers'][number];
export type ChannelStatsBestWindow = ChannelStatsResponse['signals']['bestWindows'][number];
export const CHANNEL_COMMENT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
export const CHANNEL_COMMENT_MAX_CONSECUTIVE = 2;
export const CHANNEL_COMMENT_LINK_PATTERN = /((https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,})(\/\S*)?/giu;
export const PROFILE_MENTION_START_PREFIX = 'pmh-';
export const RECENT_BOT_ADDED_BOOTSTRAP_LIMIT = 30;
export const RECENT_BOT_ADDED_USER_SCOPED_WEBHOOK_SCAN_LIMIT = 100;
export const RECENT_BOT_ADDED_WEBHOOK_SCAN_LIMIT = 500;
export const RECENT_BOT_ADDED_BOOTSTRAP_MAX_ELAPSED_MS = 2_500;
export const RECENT_BOT_ADDED_BOOTSTRAP_MAX_ADMIN_CHECKS = 8;
export const RECENT_BOT_ADDED_BOOTSTRAP_ADMIN_TIMEOUT_MS = 350;
export const RECENT_BOT_ADDED_BOOTSTRAP_HEADER_RESPONSE_BUDGET_MS = 300;
export const RECENT_BOT_ADDED_BOOTSTRAP_HEADER_TIMEOUT_MS = 350;
export const RECENT_BOT_ADDED_FAST_LANE_RETRY_WINDOW_MS = 120_000;
export const SETTINGS_SCREEN_ADMIN_CHECK_TIMEOUT_MS = 1_500;
export const MANAGED_ENTITIES_LOCAL_CANDIDATE_LIMIT =
  MANAGED_ENTITIES_BACKGROUND_CANDIDATE_CHECK_LIMIT;
export const MANAGED_ENTITIES_LOCAL_ACTIVITY_LOOKBACK_MS = 180 * TWENTY_FOUR_HOURS_MS;
export const MANAGED_ENTITY_ACCESS_EDGE_GRANTED_TTL_MS = 3 * TWENTY_FOUR_HOURS_MS;
export const MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS = 7 * TWENTY_FOUR_HOURS_MS;
export const MANAGED_ENTITIES_LOCAL_ACTIVITY_EVENT_TYPES = [
  'message_created',
  'message_edited',
  'message_callback',
  'bot_started',
  'bot_added',
  'user_added',
  'user_removed',
] as const;
export const LOCAL_USER_DISPLAY_NAME_EVENT_TYPES = MANAGED_ENTITIES_LOCAL_ACTIVITY_EVENT_TYPES;
export class ManagedEntitiesRefreshThrottledError extends Error {
  constructor(readonly cause: unknown) {
    super('Managed entity refresh throttled');
    this.name = 'ManagedEntitiesRefreshThrottledError';
  }
}

export type ChannelDialogMessageSource = 'miniapp_dialog' | 'private_bot';
export type DialogMessageEntityType = 'chat' | 'channel';
export type CommentDialogNotificationKind = 'reply' | 'all';

export type ChannelSuggestionFromBotPayload = {
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

export type ChannelSuggestionReviewAction = 'publish' | 'cancel';

export type ChannelSuggestionAdminDelivery = {
  adminUserId: string;
  privateChatId: string;
  messageId: string;
  botId?: string;
};

export function mapManagedEntityTypeToChatEntityType(
  entityType: ManagedEntityType,
): ChatEntityType {
  return entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
}

export function normalizeBroadcastScheduleMode(value: string): BroadcastScheduleMode {
  return value === 'calendar' ? 'calendar' : 'legacy';
}

export function readManagedBroadcastMediaType(value: unknown): BroadcastMediaType | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'image' || normalized === 'video' ? normalized : null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sleepIfNeeded(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }

  await sleep(ms);
}

export function readNonNegativeConfigInt(value: unknown, fallback: number): number {
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

export function readBooleanConfigFlag(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return fallback;
}
