import {
  applySectionToAllRequestSchema,
  applySectionToAllResponseSchema,
  addDomainRequestSchema,
  addAdminRequestSchema,
  chatSettingsScreenResponseSchema,
  chatRulesSchema,
  channelSettingsScreenResponseSchema,
  channelStatsQuerySchema,
  channelStatsResponseSchema,
  channelDialogResponseSchema,
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
  type ManagedEntityAssignedBot,
  type ManagedEntitiesListResponse,
  type ManagedEntitiesRefreshState,
  type SendBroadcastRequest,
  type SendBroadcastResult,
  type ChatSummary,
  type ManagedEntityHeader,
  type UpdateManagedEntityPartnerAssistRequest,
  type UpdateManagedEntityPrimaryBotRequest,
  type ResolveRequiredSubscriptionChannelResponse,
  managedPollSchema,
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
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ChatContextCacheService,
  type ChatAdminAccessState,
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
  type MaxMessageButton,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MaxBotExecutionPlannerService } from '../max/max-bot-execution-planner.service';
import {
  buildManagedPollButtons,
  buildManagedPollMessageText,
  buildManagedPollOptionSummaries,
  normalizeManagedPollDraft,
  validateManagedPollForPublish,
} from '../common/managed-poll.util';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import { renderSupportedMarkdownAsHtml } from '../common/max-markdown.util';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelStatsCollectorService } from './channel-stats-collector.service';
import { buildDuplicateUserPattern } from '../moderation/duplicate-state';
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
};

type ManagedEntitiesRefreshPresentation = {
  totalCandidates: number | null;
  lastSyncedAt: string | null;
};

type ManagedEntitiesManualRefreshBlockReason = 'in_progress' | 'recent_sync' | 'backoff';

type ManagedEntitiesListOptions = {
  refresh?: boolean;
  includeRefreshState?: boolean;
  bypassRemoteCache?: boolean;
  resetRefreshCursor?: boolean;
  fresh?: boolean;
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

type ModerationFeedCursor = {
  createdAt: Date;
  id: string;
};

type ChannelSuggestionActor = Pick<AuthUser, 'userId'> & {
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
};

type ChannelSuggestionDeliveryInput = {
  text: string;
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
  canRetry: boolean;
};

const RULES_IMAGE_MAX_BYTES = 1_000_000;
const BROADCAST_IMAGE_MAX_BYTES = 3_000_000;
const BROADCAST_MIN_DELAY_MS = 30_000;
const BROADCAST_MAX_DELAY_MS = 31 * 24 * 60 * 60 * 1000;
const BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS = [1_500, 3_000, 6_000];
const BROADCAST_THROTTLE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const BROADCAST_CALENDAR_SLOT_MINUTES = 30;
const MANAGED_BROADCAST_DUE_BATCH_SIZE = 10;
const MANAGED_BROADCAST_DUE_MAX_PASSES = 100;
const MANAGED_BROADCAST_LOCK_STALE_MS = 60_000;
const LOGS_DASHBOARD_VIOLATIONS_LIMIT = 30;
const MEMBERSHIP_ACTIVITY_PAGE_LIMIT = 50;
const LOGS_DASHBOARD_RESPONSE_CACHE_TTL_MS = 5_000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;
const MANUAL_BAN_RECENT_MESSAGE_DELETE_LIMIT = 1000;
const LIST_CHATS_ADMIN_CHECK_CONCURRENCY = 2;
const MANAGED_ENTITIES_DELTA_ADMIN_CHECK_SPACING_MS = process.env.NODE_ENV === 'test' ? 0 : 220;
const MANAGED_ENTITIES_FULL_SCAN_ADMIN_CHECK_SPACING_MS = process.env.NODE_ENV === 'test' ? 0 : 320;
const MANAGED_ENTITIES_REFRESH_UNCACHED_LIMIT = 40;
const MANAGED_ENTITIES_REFRESH_SCAN_WINDOW_SIZE = 20;
const MANAGED_ENTITIES_LOCAL_REFRESH_SCAN_WINDOW_SIZE = 8;
const MANAGED_ENTITIES_REFRESH_CURSOR_DONE = -1;
const MANAGED_ENTITIES_REFRESH_CURSOR_TTL_SEC = 60 * 60;
const MANAGED_ENTITIES_REFRESH_CURSOR_DONE_TTL_SEC = 60;
const MANAGED_ENTITIES_REFRESH_SNAPSHOT_TTL_SEC = 5 * 60;
const MANAGED_ENTITIES_REFRESH_LAST_SYNCED_TTL_SEC = 30 * 24 * 60 * 60;
const MANAGED_ENTITIES_REFRESH_SUCCESS_COOLDOWN_MS = 30_000;
const MANAGED_ENTITIES_MANUAL_REFRESH_RECENT_SYNC_WINDOW_MS = 30_000;
const MANAGED_ENTITIES_REFRESH_BACKOFF_MS = 60_000;
const MANAGED_ENTITIES_REFRESH_FRESHNESS_WINDOW_MS = 10 * 60_000;
const MANAGED_ENTITIES_REFRESH_NEXT_POLL_AFTER_MS = 1_500;
const MANAGED_ENTITIES_REFRESH_IDLE_NEXT_POLL_AFTER_MS = 3_000;
const MANAGED_ENTITIES_REFRESH_DEGRADE_PAUSE_RETRY_MS = 15_000;
const MANAGED_ENTITIES_DEGRADE_PAUSE_LOG_INTERVAL_MS = 60_000;
const MANAGED_ENTITIES_MASS_ACTION_FULL_SCAN_MAX_PASSES = 75;
const MANAGED_ENTITY_HEADER_HYDRATION_BATCH_SIZE = 8;
const MANAGED_ENTITY_HEADER_HYDRATION_CONCURRENCY = 1;
const ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES = [403, 404] as const;
const ADMIN_ACTION_HEALTH_LANE = 'background' as const;
const APPLY_SETTINGS_TO_ALL_CHATS_CONCURRENCY = 6;
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
const CHAT_SETTINGS_BUTTON_URL_KEYS = [
  'linkBotButtonUrl',
  'greetingBotButtonUrl',
  'textFiltersBotButtonUrl',
  'thematicFiltersBotButtonUrl',
  'duplicateBotButtonUrl',
  'messageLimitsBotButtonUrl',
  'nightModeBotButtonUrl',
] as const satisfies readonly (keyof ChatSettings)[];
const CHAT_SETTINGS_BUTTON_ENABLED_BY_URL_KEY = {
  linkBotButtonUrl: 'linkBotButtonEnabled',
  greetingBotButtonUrl: 'greetingBotButtonEnabled',
  textFiltersBotButtonUrl: 'textFiltersBotButtonEnabled',
  thematicFiltersBotButtonUrl: 'thematicFiltersBotButtonEnabled',
  duplicateBotButtonUrl: 'duplicateBotButtonEnabled',
  messageLimitsBotButtonUrl: 'messageLimitsBotButtonEnabled',
  nightModeBotButtonUrl: 'nightModeBotButtonEnabled',
} as const satisfies Record<(typeof CHAT_SETTINGS_BUTTON_URL_KEYS)[number], keyof ChatSettings>;
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
    'nightModeBotButtonEnabled',
    'nightModeBotButtonUrl',
    'nightModeBotButtonText',
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
const RECENT_BOT_ADDED_WEBHOOK_SCAN_LIMIT = 100;
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
  text: string;
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
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private readonly appBaseUrl: string | null;
  private readonly explicitBotContactId: string | null;
  private readonly ownBotUserId: string | null;
  private readonly maxBotToken: string;
  private readonly maxBotTokenValidationSecrets: readonly string[];
  private readonly systemAccessConfig: SystemAccessConfig;
  private readonly manualFanoutLookupSpacingMs: number;
  private readonly manualFanoutActionSpacingMs: number;
  private readonly adminAccessChecks = new Map<string, Promise<AdminAccessResolution>>();
  private readonly managedEntitiesDiscoveryChecks = new Map<
    string,
    Promise<ManagedEntitiesListResult>
  >();
  private readonly managedEntitiesRefreshCooldownUntilMs = new Map<string, number>();
  private readonly managedEntitiesRefreshBackoffUntilMs = new Map<string, number>();
  private readonly managedEntityHeaderHydrationRuns = new Map<string, Promise<void>>();
  private readonly managedEntitiesBackgroundRefreshRuns = new Map<string, Promise<void>>();
  private managedEntitiesDegradePauseLogAtMs = 0;
  private readonly logsDashboardResponseCache = new Map<
    string,
    TimedPromiseCacheEntry<LogsDashboardResponse>
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
    this.systemAccessConfig = readSystemAccessConfig(configService);
    this.manualFanoutLookupSpacingMs = this.readNonNegativeConfigInt(
      configService.get<number>('MANUAL_FANOUT_LOOKUP_SPACING_MS'),
      process.env.NODE_ENV === 'test' ? 0 : 180,
    );
    this.manualFanoutActionSpacingMs = this.readNonNegativeConfigInt(
      configService.get<number>('MANUAL_FANOUT_ACTION_SPACING_MS'),
      process.env.NODE_ENV === 'test' ? 0 : 120,
    );
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
    return {
      items: result.items,
      refresh: result.refresh ?? this.createManagedEntitiesRefreshState(null, false),
    };
  }

  async listChannelsWithRefreshState(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResponse> {
    const result = await this.listManagedEntitiesDetailed(user, 'channel', {
      ...options,
      includeRefreshState: true,
    });
    return {
      items: result.items,
      refresh: result.refresh ?? this.createManagedEntitiesRefreshState(null, false),
    };
  }

  async listManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter = 'all',
    options: ManagedEntitiesListOptions = {},
  ): Promise<ChatSummary[]> {
    const result = await this.listManagedEntitiesDetailed(user, entityType, options);
    return result.items;
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
      throw new ServiceUnavailableException('Bot execution planner is not available on this runtime.');
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
      throw new ServiceUnavailableException('Bot execution planner is not available on this runtime.');
    }

    const request = updateManagedEntityPrimaryBotRequestSchema.parse(body) as UpdateManagedEntityPrimaryBotRequest;
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
      throw new ServiceUnavailableException('Bot execution planner is not available on this runtime.');
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
      throw new ServiceUnavailableException('Bot execution planner is not available on this runtime.');
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
          const recentBotAdded = await this.bootstrapRecentBotAddedEntities(user, entityType);
          const bootstrapped = await this.bootstrapCurrentChat(user, entityType);
          const mergedFresh = this.mergeManagedEntityGroups(
            bootstrapped ? [bootstrapped] : [],
            recentBotAdded,
            fresh.items,
          );
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

      const recentBotAdded = await this.bootstrapRecentBotAddedEntities(user, entityType);
      const cached = await this.revalidateCachedManagedEntities(
        user,
        await this.listChatsFromAllowlist(user.userId, entityType),
      );
      const bootstrapped = await this.bootstrapCurrentChat(user, entityType);
      const initial = this.mergeManagedEntityGroups(
        bootstrapped ? [bootstrapped] : [],
        recentBotAdded,
        cached,
      );
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

      const discovered = await this.discoverManagedEntities(user, entityType, {
        respectCooldown: true,
        fullScan: false,
        includeRefreshState: options.includeRefreshState === true,
        bypassRemoteCache: options.bypassRemoteCache === true,
        resetRefreshCursor: options.resetRefreshCursor === true,
      });

      return {
        items: await this.attachManagedEntityBotAssignments(discovered.items),
        refresh: discovered.refresh,
      };
    }

    const refresh = await this.scheduleManagedEntitiesRemoteFullRefresh(user, entityType, {
      bypassRemoteCache: options.bypassRemoteCache === true,
      resetRefreshCursor: options.resetRefreshCursor === true,
    });
    const cached = await this.listChatsFromAllowlist(user.userId, entityType);
    const items =
      cached.length > 0
        ? await this.attachManagedEntityBotAssignments(await this.hydrateManagedEntities(cached))
        : [];
    this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items);
    return {
      items,
      refresh,
    };
  }

  private async scheduleManagedEntitiesRemoteFullRefresh(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
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
        const pending = this.runManagedEntitiesRemoteFullRefresh(user, entityType, options)
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

  async processManagedEntitiesRefreshJob(job: AdminManagedEntitiesRefreshJob): Promise<void> {
    const user: AuthUser = {
      userId: job.userId,
      username: null,
      displayName: null,
      chatTitle: null,
    };

    await this.runManagedEntitiesRemoteFullRefresh(user, job.entityType, {
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
      if (existing) {
        const state = await existing.getState();
        if (state !== 'failed' && state !== 'completed') {
          return true;
        }

        await existing.remove();
      }

      await this.adminManagedEntitiesRefreshQueue.add(
        'refresh-managed-entities',
        {
          userId,
          entityType,
          bypassRemoteCache: options.bypassRemoteCache === true,
          resetRefreshCursor: options.resetRefreshCursor === true,
        },
        {
          jobId,
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
    } = {},
  ): Promise<ManagedEntitiesRefreshState> {
    let cursor: number | null = null;
    try {
      cursor =
        (await this.chatContextCache.getManagedEntitiesRefreshCursor?.(userId, entityType)) ?? null;
    } catch {
      cursor = null;
    }

    if (await this.isManagedEntitiesBackgroundRefreshPaused('schedule')) {
      const pausedCursor =
        cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE ? null : cursor;
      const presentation = await this.loadManagedEntitiesRefreshPresentationData(userId, entityType);
      return this.createManagedEntitiesRefreshState(
        pausedCursor,
        true,
        MANAGED_ENTITIES_REFRESH_DEGRADE_PAUSE_RETRY_MS,
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
      options.bypassRemoteCache === true &&
      (cursor === null || cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE)
    ) {
      const freshness = await this.readManagedEntitiesLastSyncFreshness(userId, entityType);
      if (
        typeof freshness.ageMs === 'number' &&
        freshness.ageMs >= 0 &&
        freshness.ageMs < MANAGED_ENTITIES_MANUAL_REFRESH_RECENT_SYNC_WINDOW_MS
      ) {
        const presentation = await this.loadManagedEntitiesRefreshPresentationData(userId, entityType);
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
      options.bypassRemoteCache !== true &&
      (cursor === null || cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE)
    ) {
      const freshness = await this.readManagedEntitiesLastSyncFreshness(userId, entityType);
      if (freshness.fresh) {
        const presentation = await this.loadManagedEntitiesRefreshPresentationData(userId, entityType);
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

    if (options.resetRefreshCursor === true || cursor === null || cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE) {
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
    } = {},
  ): Promise<void> {
    if (await this.isManagedEntitiesBackgroundRefreshPaused('job')) {
      return;
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
      return;
    }

    if (refresh.complete) {
      await this.repairManagedEntitiesAllowlistAfterFullRefresh(user.userId, entityType);
    }
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

  private createManagedEntitySummary(
    params: {
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
    },
  ): ChatSummary {
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

  private createManagedEntityHeader(
    params: {
      id: string;
      title: string;
      entityType: ManagedEntityType;
      link?: string | null;
      participantsCount?: number | null;
      avatarUrl?: string | null;
      primaryBotId?: string | null;
      assignedBots?: ManagedEntityAssignedBot[];
      sharedMode?: ManagedEntityHeader['sharedMode'];
    },
  ): ManagedEntityHeader {
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

  private async attachManagedEntityBotAssignments(
    chats: ChatSummary[],
  ): Promise<ChatSummary[]> {
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
          (
            entry,
          ): entry is readonly [string, ManagedEntityBotProfileSnapshot] => entry !== null,
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

  private normalizeManagedEntityBotCapabilities(
    value: unknown,
  ): ManagedEntityBotCapability[] {
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
          new Set([...(existing?.botIds ?? []), ...(chat.botIds ?? []), ...(chat.botId ? [chat.botId] : [])]),
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

  private buildCurrentContextDiscoveryCandidates(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
  ): ManagedEntitiesDiscoverySnapshot {
    if (!user.chatId) {
      return [];
    }

    const currentContextEntityType = this.resolveCurrentContextManagedEntityType(user);
    if (!currentContextEntityType) {
      return [];
    }
    if (entityType !== 'all' && currentContextEntityType !== entityType) {
      return [];
    }
    if (currentContextEntityType === 'chat' && this.isPrivateDirectChat(user.chatId)) {
      return [];
    }

    return [
      {
        chatId: user.chatId,
        title: this.readTrimmedString(user.chatTitle) ?? user.chatId,
        lastEventTime: Date.now(),
        entityType: currentContextEntityType,
        link: null,
        avatarUrl: null,
        botId: this.maxBotLinkService?.getContextOrDefaultBotId() ?? null,
        botIds: this.maxBotLinkService ? [this.maxBotLinkService.getContextOrDefaultBotId()] : [],
      },
    ];
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
    const rows = await this.prisma.$queryRaw<
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
      LIMIT ${Math.max(1, options.limit)}
    `;

    const snapshot: ManagedEntitiesDiscoverySnapshot = [];
    for (const row of Array.isArray(rows) ? rows : []) {
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

    const rows = await this.prisma.$queryRaw<
      Array<{
        chat_id: string | null;
        chat_title: string | null;
        is_channel: string | null;
      }>
    >`
      SELECT
        NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') AS chat_id,
        NULLIF(BTRIM(normalized_payload->'message'->>'chatTitle'), '') AS chat_title,
        NULLIF(BTRIM(normalized_payload->'raw'->>'is_channel'), '') AS is_channel
      FROM webhook_events
      WHERE normalized_payload->>'type' = 'bot_added'
        AND NULLIF(BTRIM(normalized_payload->'message'->>'senderId'), '') = ${normalizedUserId}
      ORDER BY created_at DESC
      LIMIT ${RECENT_BOT_ADDED_WEBHOOK_SCAN_LIMIT}
    `;
    const safeRows = Array.isArray(rows) ? rows : [];

    const bootstrapped: ChatSummary[] = [];
    const seen = new Set<string>();

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
        await this.prunePersistedChatAccess(chatId, normalizedUserId);
        continue;
      }

      const access = await this.resolveUserAndBotAdminAccess(chatId, normalizedUserId, {
        bypassNegativeCache: true,
      });
      if (access.status !== 'granted') {
        continue;
      }

      const existing = await this.prisma.chat.findUnique({
        where: { id: chatId },
        select: {
          title: true,
        },
      });
      const cachedHeader = await this.chatContextCache.getManagedEntityHeader?.(
        chatId,
        hintedEntityType,
      );
      const resolvedTitle = this.resolvePresentableManagedEntityTitle(
        chatId,
        this.readTrimmedString(row.chat_title),
        this.readTrimmedString(cachedHeader?.title),
        this.readTrimmedString(existing?.title),
      );
      if (!resolvedTitle) {
        continue;
      }
      const persistedChat = await this.upsertUserChatAccess(
        chatId,
        normalizedUserId,
        resolvedTitle,
        hintedEntityType,
        { updateEntityType: true },
      );

      const chat = this.createManagedEntitySummary({
        id: persistedChat.id,
        title: persistedChat.title,
        createdAt: persistedChat.createdAt.toISOString(),
        entityType: this.fromPrismaEntityType(persistedChat.entityType),
      });

      bootstrapped.push(chat);
      if (bootstrapped.length >= RECENT_BOT_ADDED_BOOTSTRAP_LIMIT) {
        break;
      }
    }

    return bootstrapped;
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

    for (const [index, entry] of cachedAccessStates.entries()) {
      if (entry.cachedAccess !== 'user_denied' && entry.cachedAccess !== 'bot_denied') {
        filtered[index] = entry.chat;
        continue;
      }

      staleDeniedChats.push({
        chat: entry.chat,
        index,
      });
    }

    if (staleDeniedChats.length > 0) {
      const revalidatedChats = await this.mapWithConcurrencyLimit(
        staleDeniedChats,
        LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
        async ({ chat }) => {
          const access = await this.resolveUserAndBotAdminAccess(chat.id, user.userId, {
            bypassNegativeCache: true,
          });

          return access.status === 'granted' ? chat : null;
        },
      );

      for (const [index, chat] of revalidatedChats.entries()) {
        if (!chat) {
          continue;
        }

        filtered[staleDeniedChats[index].index] = chat;
      }
    }

    return filtered.filter((chat): chat is ChatSummary => chat !== null);
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
    const currentContextCandidates = this.buildCurrentContextDiscoveryCandidates(user, entityType);
    const prioritizedCandidateIds = new Set(
      [...currentContextCandidates, ...staleDeniedCachedCandidates].map((chat) => chat.chatId),
    );
    const candidateChats = this.mergeManagedEntitiesDiscoverySnapshots(
      currentContextCandidates,
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

          const persistedChat = await this.upsertUserChatAccess(
            candidate.chatId,
            user.userId,
            candidate.title,
            candidate.entityType,
            {
              updateEntityType: true,
              preferredBotId: candidate.botId ?? null,
              observedBotIds: candidate.botIds ?? [],
            },
          );

          const chat = this.createManagedEntitySummary({
            id: persistedChat.id,
            title: persistedChat.title,
            createdAt: persistedChat.createdAt.toISOString(),
            entityType: this.fromPrismaEntityType(persistedChat.entityType),
            link: candidate.link,
            avatarUrl: candidate.avatarUrl?.trim() ?? null,
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
                    ((await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(
                      user.userId,
                      entityType,
                    )) ?? null),
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
      if (this.isManagedEntitiesRefreshThrottledError(error) || this.isMaxApiThrottleError(error)) {
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
                  this.isMaxApiThrottleError(error),
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
          });
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
        });
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
          : uncachedCandidates.slice(0, MANAGED_ENTITIES_REFRESH_UNCACHED_LIMIT);
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

          const persistedChat = await this.upsertUserChatAccess(
            remoteChat.chatId,
            user.userId,
            remoteChat.title,
            remoteChat.entityType,
            {
              updateEntityType: true,
              preferredBotId: remoteChat.botId ?? null,
              observedBotIds: remoteChat.botIds ?? [],
            },
          );

          const chat = this.createManagedEntitySummary({
            id: persistedChat.id,
            title: persistedChat.title,
            createdAt: persistedChat.createdAt.toISOString(),
            entityType: this.fromPrismaEntityType(persistedChat.entityType),
            link: remoteChat.link,
            avatarUrl: remoteChat.avatarUrl?.trim() ?? null,
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
      return {
        items,
        refresh:
          options.includeRefreshState === true
            ? options.fullScan === true
              ? this.createManagedEntitiesRefreshState(nextCursor, false, undefined, {
                  totalCandidates: supportedCandidateChats.length,
                  lastSyncedAt:
                    completedAt ??
                    ((await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(
                      user.userId,
                      entityType,
                    )) ?? null),
                })
              : await this.readManagedEntitiesRefreshState(user.userId, entityType)
            : null,
      };
    } catch (error: unknown) {
      if (this.isManagedEntitiesRefreshThrottledError(error) || this.isMaxApiThrottleError(error)) {
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
                  this.isMaxApiThrottleError(error),
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
      });
      const candidateChats =
        entityType === 'all'
          ? legacyChats
          : legacyChats.filter((chat) => chat.entityType === entityType);

      return candidateChats.filter(
        (chat) => !this.isUnsupportedManagedChat(chat.chatId, chat.entityType),
      );
    }

    const remoteGroups = await Promise.all(
      discoveryBots.map(async (bot) => {
        const chats = await this.maxClient.listBotChats({
          trafficClass: options.trafficClass,
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
          ...(options.bypassCache === true ? { bypassCache: true } : {}),
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

    return candidateChats.filter(
      (chat) => !this.isUnsupportedManagedChat(chat.chatId, chat.entityType),
    );
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
      this.prisma.$queryRaw<
        Array<{
          created_at: Date | string;
          event_type: string | null;
        }>
      >`
        SELECT
          created_at,
          normalized_payload->>'type' AS event_type
        FROM webhook_events
        WHERE normalized_payload->'message'->>'chatId' = ${chatId}
          AND normalized_payload->>'type' IN ('user_added', 'user_removed')
          AND created_at >= ${from}
          AND created_at <= ${now}
        ORDER BY created_at ASC
      `,
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
    return this.getMembershipActivityFeedPage(chatId, from, now, parsed.data, 'channel');
  }

  async getSettings(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChatSettings> {
    if (!options.skipAdminCheck) {
      await this.assertChatAdmin(chatId, user.userId, 'chat');
    }
    if (!options.skipEntityCheck) {
      await this.ensureEntityType(chatId, user.userId, 'chat');
    }
    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);

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
    await this.assertChatAdmin(chatId, user.userId, 'chat');
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

    return normalizedSettings;
  }

  async getRules(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChatRules> {
    if (!options.skipAdminCheck) {
      await this.assertChatAdmin(chatId, user.userId, 'chat');
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

    const normalizedSourceText = this.normalizeImportedRulesText(input.text);
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
    const autofilledText =
      rules.autoTextEnabled && !rules.text.trim()
        ? await this.buildAutofilledRulesTextFromCurrentSettings(chatId, user)
        : null;
    const messageText = (autofilledText ?? rules.text).trim();
    if (!messageText) {
      throw new BadRequestException('Сначала заполните текст правил.');
    }

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
        imagePayload = await this.maxClient.uploadImage(
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
    const buttonRow = this.buildChatRulesButtonRow(rules);
    try {
      published = await this.publishMessageWithRetry(chatId, messageText, {
        textFormat: 'markdown',
        ...(imagePayload ? { imagePayload } : {}),
        ...(buttonRow ? { buttons: [buttonRow] } : {}),
      });
    } catch (error: unknown) {
      const maxApiMessage = this.extractMaxApiErrorMessage(error);
      throw new BadRequestException(maxApiMessage || 'Не удалось опубликовать правила.');
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

    if (publishedMessageId) {
      try {
        await this.maxClient.deleteMessage(chatId, publishedMessageId, { immediate: true });
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
      await this.assertChatAdmin(chatId, user.userId, 'channel');
    }
    if (!options.skipEntityCheck) {
      await this.ensureEntityType(chatId, user.userId, 'channel');
    }
    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);

    const chat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Channel ${chatId}`,
        entityType: ChatEntityType.CHANNEL,
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        channelSettings: {
          create: {},
        },
      },
      update: {
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        entityType: ChatEntityType.CHANNEL,
        channelSettings: {
          upsert: {
            update: {},
            create: {},
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
    await this.assertChatAdmin(chatId, user.userId, 'channel');
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
      },
      update: {},
      select: {
        engagementPublishedMessageId: true,
        engagementPublishedThreadId: true,
        engagementPublishedAt: true,
      },
    });

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
        await this.maxClient.editMessageInlineKeyboard(chatId, messageId, parsed.data.text, {
          buttons,
        } satisfies Pick<MaxSendMessageOptions, 'buttons'>);
        updatedExisting = true;
      } catch (error: unknown) {
        if (!this.shouldRecreateChannelEngagementMessage(error)) {
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
        const published = await this.maxClient.sendMessageImmediateWithResolvedLink(
          chatId,
          parsed.data.text,
          {
            buttons,
          } satisfies MaxSendMessageOptions,
        );
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
    const channelSettings = await this.getPublicChannelSettings(chatId);

    const action =
      dialogType === 'comments' ? CHANNEL_DIALOG_ACTION_COMMENT : CHANNEL_DIALOG_ACTION_SUGGEST;
    const rows = await this.prisma.auditLog.findMany({
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
    });
    const adminUserIds =
      dialogType === 'comments' ? await this.readDialogAdminUserIds(chatId) : new Set<string>();

    const messages = await this.enrichDialogMessagesWithAuthorAvatars(
      chatId,
      rows
        .slice()
        .reverse()
        .map((row) => this.mapChannelDialogAuditLog(row, dialogType, user.userId, adminUserIds)),
    );

    return channelDialogResponseSchema.parse({
      chatId,
      type: dialogType,
      introText: this.resolveChannelDialogIntroText(channelSettings, dialogType),
      messages,
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
    const imageBase64 = parsed.data.imageBase64.trim();
    const imageMimeType = parsed.data.imageMimeType.trim();
    const imageFileName = parsed.data.imageFileName.trim();
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

    if (dialogType === 'comments' && imageBase64) {
      throw new BadRequestException('Фото доступно только в предложке.');
    }

    if (dialogType === 'comments' && !text) {
      throw new BadRequestException('Введите текст комментария.');
    }

    if (dialogType === 'suggest' && !channelSettings.postSuggestionsEnabled && !threadId) {
      throw new BadRequestException('Предложить пост для этого канала сейчас нельзя.');
    }

    if (dialogType === 'suggest' && !text && !imageBase64) {
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
        imageBase64: imageBase64 || null,
        imageMimeType: imageMimeType || null,
        imageFileName: imageFileName || null,
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
    const chatSettings = await this.getPublicChatCommentSettings(chatId);

    if (!chatSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого чата сейчас закрыты.');
    }

    const rows = await this.prisma.auditLog.findMany({
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
    });
    const adminUserIds =
      dialogType === 'comments' ? await this.readDialogAdminUserIds(chatId) : new Set<string>();

    const messages = await this.enrichDialogMessagesWithAuthorAvatars(
      chatId,
      rows
        .slice()
        .reverse()
        .map((row) => this.mapChannelDialogAuditLog(row, dialogType, user.userId, adminUserIds)),
    );

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
    const imageBase64 = parsed.data.imageBase64.trim();
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

    if (imageBase64) {
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
    const normalizedSettings = this.normalizeChatSettings(parsed.data, undefined, sourceChatId);

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
      },
    );

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
    > | null,
    chatId?: string,
  ): ChatSettings {
    const normalized = this.normalizeNightModeSettings(
      this.normalizeMessageLimitsBlockedWords(this.normalizeRequiredSubscriptionSettings(settings)),
      currentState,
    );

    return chatId ? this.normalizeChatSettingsButtonUrls(chatId, normalized) : normalized;
  }

  private normalizeRequiredSubscriptionSettings(settings: ChatSettings): ChatSettings {
    const requiredSubscriptionChannelIds = Array.from(
      new Set(
        settings.requiredSubscriptionChannelIds
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    );

    return {
      ...settings,
      requiredSubscriptionChannelIds,
    };
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

  private sanitizeStoredChatSettings(settings: unknown): unknown {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return settings;
    }

    let normalizedSettings = settings as Record<string, unknown>;

    for (const key of CHAT_SETTINGS_BUTTON_URL_KEYS) {
      const normalizedUrl = this.normalizeLegacyProfileButtonUrl(
        normalizedSettings[key] as string | null | undefined,
      );
      const enabledKey = CHAT_SETTINGS_BUTTON_ENABLED_BY_URL_KEY[key];
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

    for (const key of CHAT_SETTINGS_BUTTON_URL_KEYS) {
      const normalizedUrl = this.normalizeLegacyProfileButtonUrl(settings[key]);
      const enabledKey = CHAT_SETTINGS_BUTTON_ENABLED_BY_URL_KEY[key];
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
    const channels: ManagedEntityHeader[] = [];

    for (const channelId of normalizedChannelIds) {
      try {
        channels.push(await this.resolveRequiredSubscriptionChannelById(channelId));
      } catch (error: unknown) {
        this.logger.warn(
          {
            channelId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to resolve required subscription channel for settings screen',
        );
      }
    }

    return channels;
  }

  private async resolveRequiredSubscriptionChannelReference(
    value: string,
  ): Promise<ManagedEntityHeader> {
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      throw new BadRequestException('Укажите публичную ссылку или ID канала.');
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

  private async resolveRequiredSubscriptionChannelByLink(link: string): Promise<MaxBotChat> {
    const normalizedLink = this.normalizeRequiredSubscriptionChannelLink(link);
    if (!normalizedLink) {
      throw new BadRequestException('Укажите корректную ссылку канала MAX.');
    }

    try {
      const chats = await this.loadManagedEntitiesDiscoverySnapshot('channel', {
        trafficClass: 'interactive',
      });
      const matched = chats.find(
        (chat) =>
          chat.entityType === 'channel' &&
          this.normalizeRequiredSubscriptionChannelLink(chat.link) === normalizedLink,
      );

      if (matched?.chatId) {
        return matched;
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          link: normalizedLink,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve required subscription channel by public link',
      );
      throw new ServiceUnavailableException(
        'Не удалось проверить публичную ссылку канала в MAX. Повторите попытку.',
      );
    }

    throw new BadRequestException(
      'Канал по этой ссылке не найден. Проверьте ссылку и убедитесь, что бот состоит в канале.',
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
      throw new BadRequestException('Укажите корректный ID канала.');
    }

    const resolvedBotId =
      this.maxBotRegistry?.getBotById(options.preferredBotId)?.id ??
      (await this.resolveBotAssignment(normalizedChatId)) ??
      null;
    let snapshot: Awaited<ReturnType<MaxClientService['getChatSnapshot']>>;
    try {
      snapshot = resolvedBotId
        ? await this.maxClient.getChatSnapshot(normalizedChatId, {
            botId: resolvedBotId,
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
        'Failed to load required subscription channel snapshot',
      );
      throw new BadRequestException('Канал не найден в MAX или бот не имеет к нему доступа.');
    }

    if (snapshot.entityType !== 'channel') {
      throw new BadRequestException('Этот идентификатор относится к чату, а не к каналу.');
    }

    const link = snapshot.link?.trim() ?? '';
    if (!link) {
      throw new BadRequestException(
        'Для обязательной подписки нужен публичный канал с рабочей ссылкой.',
      );
    }

    await this.assertBotCanInspectRequiredSubscriptionChannel(normalizedChatId, {
      preferredBotId: resolvedBotId,
      observedBotIds: options.observedBotIds ?? [],
    });

    const header = this.createManagedEntityHeader({
      id: normalizedChatId,
      title: snapshot.title?.trim() || normalizedChatId,
      entityType: 'channel',
      link,
      participantsCount: snapshot.participantsCount,
      avatarUrl: snapshot.avatarUrl,
      primaryBotId: resolvedBotId,
    });

    try {
      await this.prisma.chat.upsert({
        where: { id: normalizedChatId },
        create: {
          id: normalizedChatId,
          title: header.title,
          entityType: ChatEntityType.CHANNEL,
          ...(resolvedBotId ? { botId: resolvedBotId, primaryBotId: resolvedBotId } : {}),
        },
        update: {
          title: header.title,
          entityType: ChatEntityType.CHANNEL,
          ...(resolvedBotId ? { botId: resolvedBotId, primaryBotId: resolvedBotId } : {}),
        },
      });
      await this.maxBotLinkService?.bindDiscoveredChatBots({
        chatId: normalizedChatId,
        primaryBotId: resolvedBotId,
        botIds:
          resolvedBotId || (options.observedBotIds?.length ?? 0) > 0
            ? [resolvedBotId, ...(options.observedBotIds ?? [])].filter(
                (botId): botId is string => typeof botId === 'string' && botId.trim().length > 0,
              )
            : [],
        title: header.title,
        entityType: ChatEntityType.CHANNEL,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: normalizedChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist resolved required subscription channel title',
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
  ): Promise<void> {
    const candidateBotIds = Array.from(
      new Set(
        [
          this.maxBotRegistry?.getBotById(options.preferredBotId)?.id ?? null,
          ...((options.observedBotIds ?? []).map(
            (botId) => this.maxBotRegistry?.getBotById(botId)?.id ?? null,
          ) as Array<string | null>),
          ...(await this.resolveCandidateBotIdsForChat(chatId)),
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
          return;
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
          return;
        }
      } catch (error: unknown) {
        if (!this.isBotAdminLookupDeniedError(error)) {
          serviceFailure = serviceFailure ?? error;
        }
      }
    }

    if (!serviceFailure) {
      throw new BadRequestException(
        'Бот должен быть администратором этого канала, чтобы проверять подписку.',
      );
    }

    this.logger.warn(
      {
        chatId,
        err: serviceFailure instanceof Error ? serviceFailure.message : String(serviceFailure),
      },
      'Failed to verify bot admin access for required subscription channel',
    );
    throw new ServiceUnavailableException(
      'Не удалось проверить права бота в канале MAX. Повторите попытку.',
    );
  }

  private normalizeRequiredSubscriptionChannelLink(
    value: string | null | undefined,
  ): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
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

    for (const candidate of candidates) {
      try {
        const parsed = new URL(candidate);
        const hostname = parsed.hostname.trim().toLowerCase();
        if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
          continue;
        }

        const pathname = parsed.pathname.replace(/\/+$/u, '');
        if (!pathname) {
          continue;
        }

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
          _errors: ['Выберите хотя бы один канал для обязательной подписки.'],
        },
      });
    }

    const invalidChannelIds: string[] = [];
    for (const channelId of selectedChannelIds) {
      try {
        await this.resolveRequiredSubscriptionChannelById(channelId);
      } catch {
        invalidChannelIds.push(channelId);
      }
    }

    if (invalidChannelIds.length > 0) {
      throw new BadRequestException({
        requiredSubscriptionChannelIds: {
          _errors: [
            'Для обязательной подписки нужны каналы с публичной ссылкой. Для внешнего канала бот должен быть его администратором.',
          ],
        },
      });
    }
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
    current: Pick<
      ChatSettings,
      | 'linkBotButtonUrl'
      | 'greetingBotButtonUrl'
      | 'textFiltersBotButtonUrl'
      | 'thematicFiltersBotButtonUrl'
      | 'duplicateBotButtonUrl'
      | 'messageLimitsBotButtonUrl'
      | 'nightModeBotButtonUrl'
      | 'nightModeBotMessageEnabled'
      | 'nightModeCommentsEnabled'
      | 'nightModeBotButtonEnabled'
      | 'nightModeRulesButtonEnabled'
      | 'nightModeForceCloseEnabled'
      | 'nightModeForceCloseUntil'
    >,
    normalized: Pick<
      ChatSettings,
      | 'linkBotButtonUrl'
      | 'greetingBotButtonUrl'
      | 'textFiltersBotButtonUrl'
      | 'thematicFiltersBotButtonUrl'
      | 'duplicateBotButtonUrl'
      | 'messageLimitsBotButtonUrl'
      | 'nightModeBotButtonUrl'
      | 'nightModeBotMessageEnabled'
      | 'nightModeCommentsEnabled'
      | 'nightModeBotButtonEnabled'
      | 'nightModeRulesButtonEnabled'
      | 'nightModeForceCloseEnabled'
      | 'nightModeForceCloseUntil'
    >,
  ): Partial<
    Pick<
      ChatSettings,
      | 'linkBotButtonUrl'
      | 'greetingBotButtonUrl'
      | 'textFiltersBotButtonUrl'
      | 'thematicFiltersBotButtonUrl'
      | 'duplicateBotButtonUrl'
      | 'messageLimitsBotButtonUrl'
      | 'nightModeBotButtonUrl'
      | 'nightModeBotMessageEnabled'
      | 'nightModeCommentsEnabled'
      | 'nightModeBotButtonEnabled'
      | 'nightModeRulesButtonEnabled'
      | 'nightModeForceCloseEnabled'
      | 'nightModeForceCloseUntil'
    >
  > {
    const changes: Partial<
      Pick<
        ChatSettings,
        | 'linkBotButtonUrl'
        | 'greetingBotButtonUrl'
        | 'textFiltersBotButtonUrl'
        | 'thematicFiltersBotButtonUrl'
        | 'duplicateBotButtonUrl'
        | 'messageLimitsBotButtonUrl'
        | 'nightModeBotButtonUrl'
        | 'nightModeBotMessageEnabled'
        | 'nightModeCommentsEnabled'
        | 'nightModeBotButtonEnabled'
        | 'nightModeRulesButtonEnabled'
        | 'nightModeForceCloseEnabled'
        | 'nightModeForceCloseUntil'
      >
    > = {};

    for (const key of CHAT_SETTINGS_BUTTON_URL_KEYS) {
      if (current[key] !== normalized[key]) {
        changes[key] = normalized[key];
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

    for (const key of CHAT_SETTINGS_BUTTON_URL_KEYS) {
      const currentUrl = this.readTrimmedString(currentSettings[key]) ?? '';
      if (currentUrl !== sanitized[key]) {
        changes[key] = sanitized[key];
      }

      const enabledKey = CHAT_SETTINGS_BUTTON_ENABLED_BY_URL_KEY[key];
      const currentEnabled = currentSettings[enabledKey] === true;
      if (currentEnabled !== sanitized[enabledKey]) {
        changes[enabledKey] = sanitized[enabledKey];
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
      const dueRows = await this.prisma.managedBroadcast.findMany({
        where: {
          status: PrismaManagedBroadcastStatus.ACTIVE,
          nextSendAt: { lte: now },
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
        },
        orderBy: [{ nextSendAt: 'asc' }, { createdAt: 'asc' }],
        take: MANAGED_BROADCAST_DUE_BATCH_SIZE,
        select: { id: true },
      });

      if (dueRows.length === 0) {
        return;
      }

      for (const row of dueRows) {
        await this.processManagedBroadcastOccurrence(row.id, reason, staleLockBefore, [
          PrismaManagedBroadcastStatus.ACTIVE,
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
      await this.assertChatAdmin(sourceChatId, user.userId, entityType);
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
    await this.assertChatAdmin(sourceChatId, user.userId, entityType);
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
          buttonEnabled: request.payload.buttonEnabled,
          buttonUrl: request.payload.buttonEnabled
            ? this.normalizeLegacyProfileButtonUrl(request.payload.buttonUrl)
            : '',
          buttonText: request.payload.buttonEnabled
            ? request.payload.buttonText.trim() || 'Открыть'
            : 'Открыть',
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

    const imagePayload = await this.uploadManagedBroadcastImage(
      request.payload,
      entityType,
      sourceChatId,
      user.userId,
    );
    const sentChatIds: string[] = [];
    const failedChatIds: string[] = [];
    let firstSendError: unknown = null;

    for (const chatId of request.targetChatIds) {
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
            );
          } else {
            await this.maxClient.sendMessage(
              chatId,
              message.messageText,
              message.messageOptions,
              occurrenceDelayMs > 0 ? { delayMs: occurrenceDelayMs } : { immediate: true },
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
          buttonEnabled: request.payload.buttonEnabled,
          buttonUrl: request.payload.buttonEnabled
            ? this.normalizeLegacyProfileButtonUrl(request.payload.buttonUrl)
            : '',
          buttonText: request.payload.buttonEnabled
            ? request.payload.buttonText.trim() || 'Открыть'
            : 'Открыть',
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
          buttonEnabled: row.buttonEnabled,
          buttonUrl: row.buttonEnabled ? this.normalizeLegacyProfileButtonUrl(row.buttonUrl) : '',
          buttonText: row.buttonText,
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
      const initialDeliveries = await this.prisma.managedBroadcastDelivery.findMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex: currentOccurrence,
        },
        orderBy: [{ targetChatId: 'asc' }],
      });

      if (
        initialDeliveries.some(
          (delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.FAILED,
        )
      ) {
        return this.finalizeManagedBroadcastOccurrence(row, currentOccurrence, [], [], null);
      }

      const imagePayload = await this.uploadManagedBroadcastImage(
        request.payload,
        row.entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
        row.sourceChatId,
        row.actorUserId,
      );

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
          );
        } catch (error: unknown) {
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
          await this.prisma.managedBroadcastDelivery.update({
            where: { id: delivery.id },
            data: {
              status: PrismaManagedBroadcastDeliveryStatus.FAILED,
              lockedAt: null,
              lastError:
                this.extractMaxApiErrorMessage(error) ||
                (error instanceof Error && error.message.trim()
                  ? error.message
                  : 'Не удалось отправить сообщение.'),
            },
          });
          continue;
        }

        const sentAt = new Date();
        try {
          await this.prisma.managedBroadcastDelivery.update({
            where: { id: delivery.id },
            data: {
              status: PrismaManagedBroadcastDeliveryStatus.SENDING,
              sentAt,
              remoteMessageId: sentMessageId,
              lastError: null,
            },
          });

          sentChatIds.push(delivery.targetChatId);
          await this.prisma.managedBroadcastDelivery.update({
            where: { id: delivery.id },
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
      this.logger.warn(
        {
          broadcastId: row.id,
          sourceChatId: row.sourceChatId,
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Managed broadcast processing failed',
      );
      await this.prisma.managedBroadcast.update({
        where: { id: row.id },
        data: {
          status: PrismaManagedBroadcastStatus.FAILED,
          lastError:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : 'Не удалось обработать рассылку.',
          lockedAt: null,
        },
      });
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

    try {
      return await this.maxClient.uploadImage(
        imageBuffer,
        this.resolveBroadcastImageFileName(payload.imageFileName, imageMimeType),
        imageMimeType,
      );
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
      await this.prisma.managedBroadcast.update({
        where: { id: row.id },
        data: {
          status,
          lastError: failureMessage,
          lockedAt: null,
        },
      });
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
      await this.prisma.managedBroadcast.update({
        where: { id: row.id },
        data: {
          status: PrismaManagedBroadcastStatus.ACTIVE,
          lastError: null,
          lockedAt: null,
        },
      });
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
    await this.prisma.managedBroadcast.update({
      where: { id: row.id },
      data: {
        sentCount: nextSentCount,
        nextSendAt,
        status: isComplete
          ? PrismaManagedBroadcastStatus.COMPLETED
          : PrismaManagedBroadcastStatus.ACTIVE,
        lastError: null,
        lockedAt: null,
      },
    });
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
      canRetry:
        row.status === PrismaManagedBroadcastStatus.PARTIAL ||
        row.status === PrismaManagedBroadcastStatus.FAILED,
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
      buttonEnabled: row.buttonEnabled,
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

    return {
      id: row.id,
      status: row.status,
      text: row.text,
      textFormat: this.normalizeBroadcastTextFormat(row.textFormat),
      applyToAllChats: row.applyToAllChats,
      targetChatIds,
      buttonEnabled: row.buttonEnabled,
      buttonUrl: row.buttonEnabled ? this.normalizeLegacyProfileButtonUrl(row.buttonUrl) : '',
      buttonText: row.buttonText,
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
  ): Promise<string> {
    let lastError: unknown = null;
    const attempts =
      Math.max(
        this.hasRetriableMaxAttachment(options) ? BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS.length : 0,
        BROADCAST_THROTTLE_RETRY_DELAYS_MS.length,
      ) + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const published = await this.maxClient.sendMessageImmediateWithId(chatId, text, options);
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
  ): Promise<void> {
    let lastError: unknown = null;
    const attempts = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.maxClient.sendMessage(chatId, text, options, { immediate: true });
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

  private async resolveBroadcastButtons(
    chatId: string,
    entityType: ManagedEntityType,
    options: {
      includeCustomButton: boolean;
      customButtonText: string;
      customButtonUrl: string;
    },
  ): Promise<MaxMessageButton[][]> {
    const rows: MaxMessageButton[][] = [];

    if (options.includeCustomButton) {
      const normalizedCustomButtonUrl = this.normalizeLegacyProfileButtonUrl(
        options.customButtonUrl,
      );
      rows.push([
        {
          type: 'link',
          text: options.customButtonText,
          url: normalizedCustomButtonUrl,
        },
      ]);
    }

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
      create: { chatId },
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
  ): Promise<{ messageId: string; url: string | null }> {
    let lastError: unknown = null;
    const attempts = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.maxClient.sendMessageImmediateWithResolvedLink(chatId, text, options);
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
    const normalizedButtonText = value.buttonText.trim() || 'Открыть';
    const baseDraft = {
      text: value.text,
      autoTextEnabled: value.autoTextEnabled,
      buttonEnabled: value.buttonEnabled,
      buttonUrl: value.buttonUrl.trim(),
      buttonText: normalizedButtonText,
    } satisfies Pick<
      UpdateChatRulesRequest,
      'text' | 'autoTextEnabled' | 'buttonEnabled' | 'buttonUrl' | 'buttonText'
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
    return chatRulesSchema.parse({
      text: rules.text,
      imageBase64: rules.imageBase64,
      imageMimeType: rules.imageMimeType,
      imageFileName: rules.imageFileName,
      autoTextEnabled: rules.autoTextEnabled,
      buttonEnabled: rules.buttonEnabled,
      buttonUrl: rules.buttonUrl,
      buttonText: rules.buttonText,
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

  private buildChatRulesButtonRow(
    rules: Pick<ChatRules, 'buttonEnabled' | 'buttonUrl' | 'buttonText'>,
  ): [MaxMessageButton] | null {
    if (!rules.buttonEnabled) {
      return null;
    }

    const buttonUrl = this.normalizePublishedRulesUrl(rules.buttonUrl);
    if (!buttonUrl) {
      return null;
    }

    const buttonText = rules.buttonText.trim() || 'Открыть';
    return [
      {
        text: buttonText.slice(0, 32),
        url: buttonUrl,
      },
    ];
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
      settings.requiredSubscriptionEnabled
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

    if (settings.requiredSubscriptionEnabled) {
      const channelTitles = requiredSubscriptionChannels
        .map((channel) => channel.title.trim())
        .filter(Boolean);
      items.push(
        channelTitles.length > 0
          ? `Чтобы писать в чат, сначала подпишитесь на: ${this.formatRulesPreviewList(channelTitles, 3)}.`
          : 'Чтобы писать в чат, сначала подпишитесь на обязательные каналы.',
      );
    }

    if (settings.russianProfanityFilterEnabled) {
      items.push('Пожалуйста, без мата и грубой лексики.');
    }

    if (settings.commercialAdsFilterEnabled) {
      items.push(
        'Коммерческую рекламу публикуйте только по согласованию с администраторами.',
      );
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

    const sanctionsSummary = this.buildRulesSanctionsSummary(settings);
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
    await this.assertChatAdmin(chatId, user.userId, entityType);
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

    let published: { messageId: string; url: string | null };
    try {
      published = await this.maxClient.sendMessageImmediateWithResolvedLink(chatId, messageText, {
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

    try {
      await this.maxClient.editMessageInlineKeyboard(chatId, publishedMessageId, messageText);
    } catch (error: unknown) {
      if (!this.isMaxMessageMissingError(error)) {
        const maxApiMessage = this.extractMaxApiErrorMessage(error);
        throw new BadRequestException(maxApiMessage || 'Не удалось закрыть опрос.');
      }
    }

    const closedAt = new Date();
    const updated = await this.prisma.managedPoll.update({
      where: { chatId },
      data: {
        status: PrismaManagedPollStatus.CLOSED,
        closedAt,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: MANAGED_POLL_ACTION_CLOSE,
        payload: {
          entityType,
          messageId: publishedMessageId,
          activeVersion: current.activeVersion,
          totalVotes: summary.totalVotes,
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
      resolvedUrl = this.normalizePublishedRulesUrl(
        await this.maxClient.resolveMessageLink(poll.publishedMessageId),
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
    const votes = await this.prisma.managedPollVote.findMany({
      where: {
        pollId,
        pollVersion,
      },
      select: {
        optionIndex: true,
      },
    });

    for (const vote of votes) {
      if (vote.optionIndex >= 0 && vote.optionIndex < counts.length) {
        counts[vote.optionIndex] += 1;
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

  private shouldRecreateChannelEngagementMessage(error: unknown): boolean {
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
    await this.assertChatAdmin(chatId, user.userId, null, {
      syncPersistedAccess: false,
    });
    const parsed = logsDashboardQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const cacheKey = this.buildLogsDashboardResponseCacheKey(chatId, user.userId, parsed.data.range);
    const cached = this.logsDashboardResponseCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.promise;
    }

    let pending!: Promise<LogsDashboardResponse>;
    pending = this.buildLogsDashboardResponse(chatId, parsed.data.range).catch(
      (error: unknown) => {
        const current = this.logsDashboardResponseCache.get(cacheKey);
        if (current?.promise === pending) {
          this.logsDashboardResponseCache.delete(cacheKey);
        }
        throw error;
      },
    );

    this.logsDashboardResponseCache.set(cacheKey, {
      expiresAtMs: Date.now() + LOGS_DASHBOARD_RESPONSE_CACHE_TTL_MS,
      promise: pending,
    });

    return pending;
  }

  private async buildLogsDashboardResponse(
    chatId: string,
    range: LogsDashboardRange,
  ): Promise<LogsDashboardResponse> {
    const now = new Date();
    const from = this.resolveLogsDashboardFrom(range, now);
    const headerPromise =
      this.chatContextCache.getManagedEntityHeader?.(chatId, 'chat') ?? Promise.resolve(null);

    const violationsWhere = this.buildModerationFeedWhere(chatId, from, now, 'ALL');

    const [
      chat,
      membershipRows,
      chatHeader,
      moderationSummaryRows,
      affectedUsers,
      violationRows,
    ] = await Promise.all([
      this.prisma.chat.findUnique({
        where: { id: chatId },
        select: { id: true, title: true },
      }),
      this.prisma.$queryRaw<
        Array<{ joined_users: unknown; left_users: unknown }>
      >`
        SELECT
          COUNT(*) FILTER (WHERE normalized_payload->>'type' = 'user_added') AS joined_users,
          COUNT(*) FILTER (WHERE normalized_payload->>'type' = 'user_removed') AS left_users
        FROM webhook_events
        WHERE normalized_payload->'message'->>'chatId' = ${chatId}
          AND normalized_payload->>'type' IN ('user_added', 'user_removed')
          AND created_at >= ${from}
          AND created_at <= ${now}
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
      this.prisma.moderationEvent.findMany({
        where: violationsWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: LOGS_DASHBOARD_VIOLATIONS_LIMIT,
      }),
    ]);
    const userProfiles = await this.resolveUserProfiles(
      chatId,
      'chat',
      violationRows.map((row) => row.userId),
    );
    const moderationSummary = this.summarizeLogsDashboardModerationCounts(moderationSummaryRows);

    const membershipSource = membershipRows[0] ?? { joined_users: 0, left_users: 0 };
    const joinedUsers = this.toSafeInteger(membershipSource.joined_users);
    const leftUsers = this.toSafeInteger(membershipSource.left_users);
    const activityFeed = await this.getMembershipActivityFeedPage(
      chatId,
      from,
      now,
      {
        range,
        filter: 'all',
        limit: MEMBERSHIP_ACTIVITY_PAGE_LIMIT,
      },
      'chat',
    );
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
      violations: violationRows.map((row) =>
        this.mapModerationViolationRow(row as ModerationViolationRow, userProfiles),
      ),
      activityFeed,
    };

    return logsDashboardResponseSchema.parse(response);
  }

  async getChatActivityFeed(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<MembershipActivityPage> {
    await this.assertChatAdmin(chatId, user.userId, 'chat', {
      syncPersistedAccess: false,
    });
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const parsed = membershipActivityQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const now = new Date();
    const from = this.resolveLogsDashboardFrom(parsed.data.range, now);
    return this.getMembershipActivityFeedPage(chatId, from, now, parsed.data, 'chat');
  }

  async getChatModerationFeed(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ModerationFeedPage> {
    await this.assertChatAdmin(chatId, user.userId, 'chat', {
      syncPersistedAccess: false,
    });
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const parsed = moderationFeedQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const now = new Date();
    const from = this.resolveLogsDashboardFrom(parsed.data.range, now);
    return this.getModerationFeedPage(chatId, from, now, parsed.data, 'chat');
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
      let sourceCleanup = {
        candidateMessageIds: [] as string[],
        deletedMessageIds: [] as string[],
        failedMessageIds: [] as string[],
      };
      if (shouldFanoutCommandMute) {
        try {
          sourceCleanup = await this.deleteRecentTrackedMessagesForManualAction(
            chatId,
            targetUserId,
          );
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId,
              targetUserId,
              actorUserId: user.userId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to run recent message cleanup after manual mute',
          );
        }
      }

      const sourceMessageCleanup = this.summarizeManualModerationCleanup(sourceCleanup);
      const crossChatMuteFanout = shouldFanoutCommandMute
        ? await this.resolveManualMuteFanoutSummary({
            sourceChatId: chatId,
            targetUserId,
            actor: user,
            muteDurationHours,
            muteExpiresAt,
            source,
          })
        : this.summarizeManualMuteFanout({
            mutedChatIds: [],
            skippedChatIds: [],
            failedChatIds: [],
          });

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
        },
        auditPayload: {
          userId: targetUserId,
          source,
          mode: executionMode,
          permanent: true,
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
            resolvedMessage || 'MAX отклонил возврат участника в чат. Проверьте тип чата, статус цели и права бота.',
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

    let sourceCleanup = {
      candidateMessageIds: [] as string[],
      deletedMessageIds: [] as string[],
      failedMessageIds: [] as string[],
    };
    try {
      sourceCleanup = await this.deleteRecentTrackedMessagesForManualAction(chatId, targetUserId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          targetUserId,
          actorUserId: user.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to run recent message cleanup after manual system ban',
      );
    }

    const recentMessageCleanup = this.summarizeManualModerationCleanup(sourceCleanup);
    const crossChatFanout =
      source === 'group_command' || source === 'private_command'
        ? await this.resolveManualBanFanoutSummary({
            sourceChatId: chatId,
            targetUserId,
            actor: user,
            source,
          })
        : this.summarizeManualBanFanout({
            removedChatIds: [],
            skippedChatIds: [],
            failedChatIds: [],
            deletedMessageCount: 0,
            failedMessageDeleteCount: 0,
          });

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

  private async resolveManualMuteFanoutSummary(params: {
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    muteDurationHours: number;
    muteExpiresAt: Date;
    source: Extract<AdminActionSource, 'group_command' | 'private_command'>;
  }) {
    const queuedJob = this.buildManualMuteFanoutJob(params);
    if (await this.enqueueManualModerationFanout(queuedJob)) {
      return this.buildQueuedManualMuteFanoutSummary(queuedJob.jobId);
    }

    try {
      const fanout = await this.applyManualMuteFanout(params);
      return this.summarizeManualMuteFanout(fanout);
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
      return this.summarizeManualMuteFanout({
        mutedChatIds: [],
        skippedChatIds: [],
        failedChatIds: [],
      });
    }
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
    options: { spacingMs?: number } = {},
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
        await this.maxClient.deleteMessage(chatId, messageId, { immediate: true });
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

    const targetAccess = await maxClientWithMemberAccess.getChatMemberAccess(
      chatId,
      targetUserId,
      {
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        ...(botId ? { botId } : {}),
      } as never,
    );
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
    this.invalidateLogsDashboardResponseCache(chatId);
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
    row: ModerationViolationRow,
    userProfiles: Map<string, ResolvedUserProfile>,
  ): LogsDashboardViolation {
    const userProfile = userProfiles.get(row.userId);
    const metadata = this.normalizeModerationViolationMetadata(row.metadata);
    const action = this.normalizeModerationViolationAction(row.action, metadata);
    const ruleCode = this.normalizeModerationViolationRuleCode(row.ruleCode, row.action);

    return {
      id: row.id,
      action,
      ruleCode,
      userId: row.userId,
      userDisplayName: userProfile?.displayName ?? null,
      avatarUrl: userProfile?.avatarUrl ?? null,
      profileUrl: userProfile?.profileUrl ?? null,
      profileHandoffUrl: userProfile?.profileHandoffUrl ?? null,
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
    );
    const lastRow = pageRows.at(-1);

    return moderationFeedPageSchema.parse({
      items: pageRows.map((row) =>
        this.mapModerationViolationRow(row as ModerationViolationRow, userProfiles),
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
  ): Promise<MembershipActivityPage> {
    const limit = Math.max(1, Math.min(100, query.limit));
    const cursor = this.decodeMembershipActivityCursor(query.cursor);
    const eventTypes =
      query.filter === 'joined'
        ? ['user_added']
        : query.filter === 'left'
          ? ['user_removed']
          : ['user_added', 'user_removed'];
    const cursorClause = cursor
      ? Prisma.sql`
          AND (
            created_at < ${new Date(cursor.createdAt)}
            OR (created_at = ${new Date(cursor.createdAt)} AND id < ${cursor.id})
          )
        `
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        created_at: Date | string;
        event_type: string | null;
        user_id: string | null;
        sender_name: string | null;
      }>
    >`
      SELECT
        id,
        created_at,
        normalized_payload->>'type' AS event_type,
        NULLIF(BTRIM(normalized_payload->'message'->>'senderId'), '') AS user_id,
        NULLIF(BTRIM(normalized_payload->'message'->>'senderName'), '') AS sender_name
      FROM webhook_events
      WHERE normalized_payload->'message'->>'chatId' = ${chatId}
        AND normalized_payload->>'type' IN (${Prisma.join(eventTypes)})
        AND created_at >= ${from}
        AND created_at <= ${to}
        ${cursorClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `;

    const pageRows = rows.slice(0, limit);
    const userProfiles = await this.resolveUserProfiles(
      chatId,
      entityType,
      pageRows
        .map((row) => (typeof row.user_id === 'string' ? row.user_id.trim() : ''))
        .filter(Boolean),
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
          profileHandoffUrl: userProfile?.profileHandoffUrl ?? null,
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
      SELECT DISTINCT ON (sender_id)
        sender_id AS user_id,
        sender_name
      FROM (
        SELECT
          normalized_payload->'message'->>'senderId' AS sender_id,
          NULLIF(BTRIM(normalized_payload->'message'->>'senderName'), '') AS sender_name,
          created_at
        FROM webhook_events
        WHERE normalized_payload->'message'->>'chatId' = ${chatId}
          AND normalized_payload->'message'->>'senderId' IN (${Prisma.join(normalizedUserIds)})
      ) AS sender_rows
      WHERE sender_id IS NOT NULL AND sender_name IS NOT NULL
      ORDER BY sender_id, created_at DESC
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
  ): Promise<Map<string, ResolvedUserProfile>> {
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
    if (loadProfiles) {
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
      profiles.set(userId, {
        displayName:
          displayNames.get(userId) ?? this.readTrimmedString(profile?.displayName) ?? null,
        avatarUrl: this.readTrimmedString(profile?.avatarUrl) ?? null,
        profileUrl:
          this.normalizeMaxProfileUrl(this.readTrimmedString(profile?.profileUrl) ?? null) ??
          this.buildUserProfileUrl(username),
        profileHandoffUrl: this.buildProfileMentionHandoffUrl(
          chatId,
          entityType,
          userId,
          displayNames.get(userId) ?? this.readTrimmedString(profile?.displayName) ?? null,
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
    const hasImage =
      payload.hasImage === true || Boolean(this.readTrimmedString(payload.imageBase64));
    const imageFileName = this.readTrimmedString(payload.imageFileName);
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
            imageFileName: imageFileName ?? null,
            hasVideo,
            videoFileName: videoFileName ?? null,
          }
        : {}),
    };
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
      message: this.mapChannelDialogAuditLog(updated, params.dialogType, params.userId, adminUserIds),
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

  private async enrichDialogMessagesWithAuthorAvatars(
    chatId: string,
    messages: ChannelDialogMessage[],
  ): Promise<ChannelDialogMessage[]> {
    const missingUserIds = Array.from(
      new Set(
        messages
          .filter((message) => !this.readTrimmedString(message.avatarUrl))
          .map((message) => message.authorUserId.trim())
          .filter((value): value is string => value.length > 0),
      ),
    );
    if (missingUserIds.length === 0) {
      return messages;
    }

    try {
      const resolvedBotId = await this.resolveBackgroundReadBotAssignment(chatId);
      const profiles = await this.maxClient.getChatMemberProfiles(chatId, missingUserIds, {
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
        ...(resolvedBotId ? { botId: resolvedBotId } : {}),
      });
      if (profiles.size === 0) {
        return messages;
      }

      return messages.map((message) => {
        if (this.readTrimmedString(message.avatarUrl)) {
          return message;
        }

        return {
          ...message,
          avatarUrl: profiles.get(message.authorUserId)?.avatarUrl ?? null,
        };
      });
    } catch (error) {
      this.logger.warn(
        {
          chatId,
          missingUserIds,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to enrich dialog messages with author avatars',
      );
      return messages;
    }
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

        await this.safeUpdateCommentsButton(chatId, messageId, buttons, 'channel');
        continue;
      }

      if (row.action !== CHANNEL_DIALOG_ACTION_AUTO_ATTACH) {
        continue;
      }

      const messageId = this.resolveChannelCommentsTargetMessageId(payload);
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

      await this.safeUpdateCommentsButton(chatId, messageId, buttons, 'channel');
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

      const messageId = this.resolveChatCommentsTargetMessageId(
        this.readObjectPayload(row.payload),
      );
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
  ): Promise<void> {
    try {
      await this.maxClient.editMessageInlineKeyboard(chatId, messageId, null, {
        buttons,
      });
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
  }> {
    const created = await this.prisma.auditLog.create({
      data: {
        chatId: params.chatId,
        actorUserId: params.user.userId,
        action: CHANNEL_DIALOG_ACTION_SUGGEST,
        payload: {
          type: 'suggest',
          threadId: params.threadId,
          text: params.text,
          actorUserId: params.user.userId,
          authorDisplayName: this.resolveChannelSuggestionActorDisplayName(params.user),
          authorAvatarUrl: this.readTrimmedString(params.user.avatarUrl) ?? null,
          delivered: false,
          deliveredToUserId: null,
          deliveredToUserIds: [],
          deliveries: [],
          source: params.source,
          reviewStatus: 'pending',
          hasImage: params.mediaType === 'image' || Boolean(params.imageBase64),
          hasVideo: params.mediaType === 'video',
          imageBase64: params.imageBase64 ?? null,
          imageMimeType: params.imageMimeType ?? null,
          imageFileName: params.imageFileName ?? null,
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
      };
    }

    const delivery = await this.deliverSuggestionToAdminPrivates(
      created.id,
      params.chatId,
      params.user,
      {
        text: params.text,
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
        text: this.readTrimmedString(payload.text) ?? '',
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
    const currentBotUserId = await this.resolveCurrentBotUserId(chatId, deliveryBotId);
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
            !this.isOwnBotUserId(id) &&
            (!currentBotUserId || id.trim() !== currentBotUserId),
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
    const messageOptions = await this.buildChannelSuggestionMessageOptions(suggestion, buttons);
    const message = this.buildChannelSuggestionAdminMessage({
      status: 'pending',
      channelTitle,
      actorName,
      actorUserId: user.userId,
      text: suggestion.text,
      reviewedBy: null,
      publishedUrl: null,
    });
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
          message,
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

  private buildChannelSuggestionAdminMessage(params: {
    status: 'pending' | 'published' | 'cancelled';
    channelTitle: string;
    actorName: string;
    actorUserId: string;
    text: string;
    reviewedBy: string | null;
    publishedUrl: string | null;
  }): string {
    const normalizedText = params.text.trim();
    const title =
      params.status === 'published'
        ? '✅ Предложка опубликована'
        : params.status === 'cancelled'
          ? '✖️ Предложка отклонена'
          : '📰 Новая предложка';
    const normalizedActorUserId = params.actorUserId.trim();
    const senderLine = normalizedActorUserId
      ? `[${this.escapeMarkdown(params.actorName)}](max://user/${encodeURIComponent(normalizedActorUserId)})`
      : this.escapeMarkdown(params.actorName);

    return [
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
      ...(normalizedText
        ? [this.escapeMarkdown(normalizedText)]
        : ['_Медиа без подписи. Смотрите вложение выше._']),
    ].join('\n');
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
  }> {
    const text = this.readTrimmedString(payload.text) ?? '';
    const media = await this.resolveChannelSuggestionAttachments({
      imageBase64: this.readTrimmedString(payload.imageBase64),
      imageMimeType: this.readTrimmedString(payload.imageMimeType),
      imageFileName: this.readTrimmedString(payload.imageFileName),
      mediaType: this.readChannelSuggestionMediaType(payload.mediaType),
      mediaPayload: this.readObjectPayloadOrNull(payload.mediaPayload),
      mediaMimeType: this.readTrimmedString(payload.mediaMimeType),
      mediaFileName: this.readTrimmedString(payload.mediaFileName),
    });
    const buttonContext = await this.buildPublishedChannelSuggestionButtonContext(chatId, payload);
    const messageText = this.buildPublishedChannelSuggestionMessageText(payload, text);

    if (!text && !media.imagePayload && !media.attachments?.length) {
      throw new BadRequestException('В предложке нет текста или медиа для публикации.');
    }

    const messageOptions: Pick<
      MaxSendMessageOptions,
      'buttons' | 'imagePayload' | 'attachments' | 'textFormat'
    > = {
      ...(buttonContext.buttons.length > 0 ? { buttons: buttonContext.buttons } : {}),
      ...(media.imagePayload ? { imagePayload: media.imagePayload } : {}),
      ...(media.attachments?.length ? { attachments: media.attachments } : {}),
      textFormat: 'markdown',
    };
    const published = await this.publishMessageWithRetry(chatId, messageText, messageOptions);

    return {
      messageId: published.messageId,
      url: published.url,
      threadId: buttonContext.threadId,
      includeCommentsButton: buttonContext.includeCommentsButton,
      includeSuggestButton: buttonContext.includeSuggestButton,
      suggestButtonText: buttonContext.suggestButtonText,
      autoPostButtonsMode: buttonContext.autoPostButtonsMode,
    };
  }

  private buildPublishedChannelSuggestionMessageText(
    payload: Record<string, unknown>,
    suggestionText: string,
  ): string {
    const actorUserId = this.readTrimmedString(payload.actorUserId);
    const actorName = this.readTrimmedString(payload.authorDisplayName) ?? actorUserId ?? '';
    const attribution = actorUserId
      ? `От подписчика [${this.escapeMarkdown(actorName || 'подписчика')}](max://user/${encodeURIComponent(actorUserId)})`
      : actorName
        ? `От подписчика ${this.escapeMarkdown(actorName)}`
        : 'От подписчика';
    const normalizedSuggestionText = suggestionText.trim();

    return normalizedSuggestionText
      ? `${attribution}\n\n${this.escapeMarkdown(normalizedSuggestionText)}`
      : attribution;
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

    const threadId = this.readTrimmedString(payload.threadId) ?? randomUUID();
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
    const message = this.buildChannelSuggestionAdminMessage({
      status: reviewStatus,
      channelTitle,
      actorName,
      actorUserId,
      text: this.readTrimmedString(payload.text) ?? '',
      reviewedBy,
      publishedUrl: this.readTrimmedString(payload.publishedUrl),
    });

    for (const delivery of deliveries) {
      try {
        await this.maxClient.editMessageInlineKeyboard(
          delivery.privateChatId,
          delivery.messageId,
          message,
          {
            buttons: [],
            textFormat: 'markdown',
          },
        );
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
        if (!adminUserId || !privateChatId || !messageId) {
          return null;
        }

        return {
          adminUserId,
          privateChatId,
          messageId,
        };
      })
      .filter((entry): entry is ChannelSuggestionAdminDelivery => entry !== null);
  }

  private markdownTitle(title: string): string {
    return `**${this.escapeMarkdown(title)}**`;
  }

  private escapeMarkdown(value: string): string {
    return value.replace(/([\\_*[\]()`])/g, '\\$1');
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

    const text = this.readTrimmedString(row.text) ?? '';
    if (text.length > 2_000) {
      throw new BadRequestException('Текст предложки слишком длинный.');
    }

    const imageBase64 = this.readTrimmedString(row.imageBase64);
    const imageMimeType = this.readTrimmedString(row.imageMimeType);
    const imageFileName = this.readTrimmedString(row.imageFileName);
    const mediaType = this.readChannelSuggestionMediaType(row.mediaType);
    const mediaPayload = this.readObjectPayloadOrNull(row.mediaPayload);
    const mediaMimeType = this.readTrimmedString(row.mediaMimeType);
    const mediaFileName = this.readTrimmedString(row.mediaFileName);

    if (!text && !imageBase64 && !mediaPayload) {
      throw new BadRequestException('Пришлите текст, фото, видео или подпись к медиа.');
    }

    if (imageBase64 && (!imageMimeType || !imageMimeType.toLowerCase().startsWith('image/'))) {
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
      text,
      imageBase64,
      imageMimeType,
      imageFileName,
      mediaType,
      mediaPayload,
      mediaMimeType,
      mediaFileName,
    };
  }

  private async uploadChannelSuggestionImage(suggestion: {
    imageBase64?: string | null;
    imageMimeType?: string | null;
    imageFileName?: string | null;
  }): Promise<Record<string, unknown> | undefined> {
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
      return await this.maxClient.uploadImage(imageBuffer, fileName, mimeType);
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

  private async resolveChannelSuggestionAttachments(suggestion: {
    imageBase64?: string | null;
    imageMimeType?: string | null;
    imageFileName?: string | null;
    mediaType?: 'image' | 'video' | null;
    mediaPayload?: Record<string, unknown> | null;
    mediaMimeType?: string | null;
    mediaFileName?: string | null;
  }): Promise<{
    imagePayload?: Record<string, unknown>;
    attachments?: MaxAttachmentPayload[];
  }> {
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
    });

    return uploadedImagePayload ? { imagePayload: uploadedImagePayload } : {};
  }

  private async buildChannelSuggestionMessageOptions(
    suggestion: {
      imageBase64?: string | null;
      imageMimeType?: string | null;
      imageFileName?: string | null;
      mediaType?: 'image' | 'video' | null;
      mediaPayload?: Record<string, unknown> | null;
      mediaMimeType?: string | null;
      mediaFileName?: string | null;
    },
    buttons: MaxMessageButton[][],
  ): Promise<
    Pick<MaxSendMessageOptions, 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'>
  > {
    const media = await this.resolveChannelSuggestionAttachments(suggestion);
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

    return launchUrl
      ? {
          type: 'link',
          text,
          url: launchUrl,
        }
      : webAppUrl && botContactId
        ? {
            type: 'open_app',
            text,
            webApp: webAppUrl,
            contactId: botContactId,
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

  buildChannelSuggestionStartPayload(chatId: string, threadId: string): string {
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
      this.maxBotLinkService?.buildEntryMiniappStartUrlSync(startParam) ??
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
      this.maxBotLinkService?.buildEntryBotStartUrlSync(startPayload) ??
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
    const entryBotId = this.maxBotLinkService?.getEntryBotId() ?? this.maxBotRegistry?.getEntryBot().id;
    if (entryBotId) {
      return entryBotId;
    }

    return this.maxBotRegistry?.getBotById(botId)?.id ?? botId?.trim() ?? undefined;
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

  private buildResolvedBotAssignmentData(
    resolvedBotId?: string | null,
  ): { botId?: string; primaryBotId?: string } {
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

  private async resolveBotAssignment(chatId: string): Promise<string | undefined> {
    return (await this.maxBotLinkService?.resolveBotId({ chatId })) ?? undefined;
  }

  private async resolveManualActionBotAssignment(chatId: string): Promise<string | undefined> {
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
    let fallbackBotId = persistedBotId ?? ((await this.resolveBotAssignment(normalizedChatId)) ?? undefined);
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

  private async resolveAssistBotAssignment(
    chatId: string,
    capability: ManagedEntityBotCapability,
  ): Promise<string | undefined> {
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

  private async resolveCandidateBotIdsForChat(chatId: string): Promise<string[]> {
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

    for (const bot of this.maxBotRegistry?.getDiscoveryBots() ?? []) {
      resolved.add(bot.id);
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
    } = {},
  ): Promise<AdminAccessResolution> {
    try {
      const requestOptions =
        options.trafficClass === undefined
          ? (botId
              ? ({
                  botId,
                  actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
                  ...(options.sourceTag ? { sourceTag: options.sourceTag } : {}),
                } as const)
              : ({
                  actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
                  ...(options.sourceTag ? { sourceTag: options.sourceTag } : {}),
                } as const))
          : (botId
              ? ({
                  trafficClass: options.trafficClass,
                  actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
                  ...(options.sourceTag ? { sourceTag: options.sourceTag } : {}),
                  botId,
                } as const)
              : ({
                  trafficClass: options.trafficClass,
                  actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
                  ...(options.sourceTag ? { sourceTag: options.sourceTag } : {}),
                } as const));
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
    } = {},
  ): Promise<AdminAccessResolution> {
    const candidateBotIds = await this.resolveCandidateBotIdsForChat(chatId);
    if (candidateBotIds.length === 0) {
      return this.loadRemoteAdminAccessForBot(chatId, userId, null, options);
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
      await this.prunePersistedChatAccess(chatId, userId);
      return {
        status: 'denied',
        source: 'remote',
        reason: 'user_not_admin',
      };
    }

    if (sawBotDenied) {
      await this.chatContextCache.setAdminAccess?.(chatId, userId, 'bot_denied');
      await this.prunePersistedChatAccess(chatId, userId);
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
    await this.prunePersistedChatAccess(chatId, userId);
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

    const key = `${chatId}:${userId}`;
    const inFlight = this.adminAccessChecks.get(key);
    if (inFlight) {
      return this.withAllowlistFallback(chatId, userId, inFlight);
    }

    const pending = this.loadRemoteAdminAccess(chatId, userId, {
      trafficClass: options.trafficClass,
      sourceTag: options.sourceTag,
    });
    this.adminAccessChecks.set(key, pending);

    try {
      return await this.withAllowlistFallback(chatId, userId, pending);
    } finally {
      this.adminAccessChecks.delete(key);
    }
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
      typeof presentation.totalCandidates === 'number' && Number.isFinite(presentation.totalCandidates)
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
              : Math.max(0, Math.min(100, Math.round((processedCandidates / totalCandidates) * 100)));

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

    return this.createManagedEntitiesRefreshState(cursor, backoffActive, nextPollAfterMs, presentation);
  }

  private async isManagedEntitiesBackgroundRefreshPaused(
    reason: 'schedule' | 'job',
  ): Promise<boolean> {
    const snapshot = await this.resolveSystemModeSnapshot();
    if (snapshot.mode !== 'degrade' || isSystemModeRecoveryWindow(snapshot)) {
      return false;
    }

    const now = Date.now();
    if (now - this.managedEntitiesDegradePauseLogAtMs >= MANAGED_ENTITIES_DEGRADE_PAUSE_LOG_INTERVAL_MS) {
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

    return true;
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
  }

  private async listChatsFromAllowlist(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ChatSummary[]> {
    const whereClause =
      entityType === 'all'
        ? { userId }
        : {
            userId,
            chat: {
              entityType: this.toPrismaEntityType(entityType),
            },
          };
    const rows = await this.prisma.chatAdminAllowlist.findMany({
      where: whereClause,
      include: { chat: true },
      orderBy: {
        chat: {
          createdAt: 'desc',
        },
      },
    });

    const chats = rows.map(
      (row: {
        chat: { id: string; title: string; createdAt: Date; entityType: ChatEntityType };
      }) =>
        this.createManagedEntitySummary({
          id: row.chat.id,
          title: row.chat.title,
          createdAt: row.chat.createdAt.toISOString(),
          entityType: this.fromPrismaEntityType(row.chat.entityType),
        }),
    );

    const unsupportedChatIds = chats
      .filter((chat) => this.isUnsupportedManagedChat(chat.id, chat.entityType))
      .map((chat) => chat.id);
    if (unsupportedChatIds.length > 0) {
      await this.prisma.chatAdminAllowlist.deleteMany({
        where: {
          userId,
          chatId: {
            in: unsupportedChatIds,
          },
        },
      });
    }

    return chats.filter((chat) => !this.isUnsupportedManagedChat(chat.id, chat.entityType));
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

      const title = this.readTrimmedString(header.title) ?? chat.title;
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

        const title = remoteChat.title?.trim() || chat.title;
        const link = remoteChat.link ?? chat.link ?? null;
        const avatarUrl =
          this.readTrimmedString(remoteChat.avatarUrl) ?? this.readTrimmedString(chat.avatarUrl);

        if (link === null && avatarUrl === null && title === chat.title) {
          return;
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
    } = {},
  ) {
    const normalizedTitle = chatTitle?.trim() ? chatTitle.trim() : null;
    const fallbackTitle = entityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`;
    const updateEntityType = options.updateEntityType === true;
    const observedBotIds = Array.from(
      new Set(
        (options.observedBotIds ?? [])
          .map((botId) => this.maxBotRegistry?.getBotById(botId)?.id ?? null)
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    const resolvedBotId =
      this.maxBotRegistry?.getBotById(options.preferredBotId)?.id ??
      observedBotIds[0] ??
      (await this.resolveBotAssignment(chatId));
    const persistedChat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: normalizedTitle ?? fallbackTitle,
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        ...(entityType ? { entityType: this.toPrismaEntityType(entityType) } : {}),
      },
      update: {
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        ...(normalizedTitle
          ? {
              title: normalizedTitle,
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

    if (this.maxBotLinkService) {
      await this.maxBotLinkService.bindDiscoveredChatBots({
        chatId,
        primaryBotId: resolvedBotId,
        botIds: resolvedBotId ? [resolvedBotId, ...observedBotIds] : observedBotIds,
        title: normalizedTitle ?? fallbackTitle,
        entityType: entityType ? this.toPrismaEntityType(entityType) : null,
      });
    }

    if (normalizedTitle || updateEntityType) {
      await this.chatContextCache.invalidateManagedEntityHeader?.(chatId);
    }

    return persistedChat;
  }

  private async bootstrapCurrentChat(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ChatSummary | null> {
    if (!user.chatId) {
      return null;
    }

    const currentContextEntityType = this.resolveCurrentContextManagedEntityType(user);
    if (!currentContextEntityType) {
      return null;
    }
    if (entityType !== 'all' && currentContextEntityType !== entityType) {
      return null;
    }
    if (currentContextEntityType === 'chat' && this.isPrivateDirectChat(user.chatId)) {
      return null;
    }

    const access = await this.resolveUserAndBotAdminAccess(user.chatId, user.userId, {
      bypassNegativeCache: true,
    });
    if (access.status !== 'granted') {
      return null;
    }

    const persistedChat = await this.upsertUserChatAccess(
      user.chatId,
      user.userId,
      user.chatTitle ?? null,
      currentContextEntityType,
    );

    const chat = this.createManagedEntitySummary({
      id: user.chatId,
      title: persistedChat.title,
      createdAt: persistedChat.createdAt.toISOString(),
      entityType: this.fromPrismaEntityType(persistedChat.entityType),
    });

    return chat;
  }

  private resolveCurrentContextManagedEntityType(user: AuthUser): ManagedEntityType | null {
    if (user.chatType === 'channel') {
      return 'channel';
    }
    if (user.chatType === 'dialog') {
      return null;
    }

    return 'chat';
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
      await this.assertChatAdmin(chatId, user.userId, entityType);
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
  ): string {
    return `${chatId}:${userId}:${range}`;
  }

  private invalidateLogsDashboardResponseCache(chatId: string): void {
    const prefix = `${chatId}:`;
    for (const key of this.logsDashboardResponseCache.keys()) {
      if (key.startsWith(prefix)) {
        this.logsDashboardResponseCache.delete(key);
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
