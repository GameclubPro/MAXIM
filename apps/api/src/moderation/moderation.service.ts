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
  getBotSpeechEditableTemplate,
  getBotSpeechSystemTemplate,
  normalizeDeleteBotMessagesDelayMinutes,
  type BotSpeechEditableFieldKey,
  type BotSpeechStyle,
  type BotSpeechSystemTemplateKey,
  type MaxUpdate,
} from '@maxim/contracts';
import {
  ChatEntityType,
  EventType,
  ManagedPollStatus as PrismaManagedPollStatus,
  Operator,
  Prisma,
  SanctionAction,
  WebhookStatus,
  type ChannelSettings as PersistedChannelSettings,
  type ChatSettings,
} from '@prisma/client';
import type { Job } from 'bullmq';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  MaxClientService,
  type MaxActionDispatchOptions,
  type MaxLinkButton,
  type MaxMessageButton,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import {
  isValidMaxBotStartPayload,
  isValidMaxMiniappStartPayload,
} from '../max/max-deep-link.util';
import { MaxMembershipLookupService } from '../max/max-membership-lookup.service';
import { AdminService } from '../admin/admin.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { moderationBackgroundTasksEnabled } from '../runtime/moderation-runtime';
import { SystemModeService, type SystemModeSnapshot } from '../system/system-mode.service';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { PrivateControlService } from './private-control.service';
import { RedisCounterService } from './redis-counter.service';
import type { DuplicateAction, DuplicateDecision, DuplicateHit } from './rule-engine.service';
import { RuleEngineService } from './rule-engine.service';
import { SanctionService } from './sanction.service';
import { maskText } from './text-mask.util';
import {
  buildManagedPollButtons,
  buildManagedPollMessageText,
  buildManagedPollOptionSummaries,
  normalizeManagedPollDraft,
  parseManagedPollCallbackPayload,
} from '../common/managed-poll.util';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  LEGACY_WEBHOOK_QUEUE,
  type AnyWebhookQueueName,
  type ProcessWebhookJob,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
} from '../webhook/webhook-queues';

type ActiveMute = {
  eventId: string;
  issuedAt: Date;
  expiresAt: Date;
  durationHours: number;
};

type ChatAdminCheckSource = 'remote' | 'local' | 'remote+local' | 'local_fallback';

type ChatAdminCheckResult = {
  isAdmin: boolean;
  source: ChatAdminCheckSource;
};

type RemoteChatAdminAccessState = 'granted' | 'user_denied';

type ManagedChannelContext = {
  channelSettings: PersistedChannelSettings;
  adminUserIds: string[];
};

type ChannelAutoPostScanState = {
  latestTimestampMs: number;
  latestMessageIdsAtTimestamp: string[];
  idleStreak: number;
  nextScanAtMs: number;
};

type PendingChatAdminLookup = {
  cacheKey: string;
  userId: string;
  staleCached: RemoteChatAdminAccessState | null;
  resolve: (value: RemoteChatAdminAccessState | null) => void;
};

type PendingChatAdminLookupBatch = {
  chatId: string;
  lookups: Map<string, PendingChatAdminLookup>;
  scheduled: boolean;
};

type RulesButtonReference = {
  publishedUrl: string | null;
  publishedMessageId: string | null;
};

type ChannelDialogType = 'comments' | 'suggest';

type AdminForwardedModerationCommand =
  | {
      action: 'BAN';
    }
  | {
      action: 'MUTE';
      muteDurationHours: number;
    };

type ForwardedModerationTarget = {
  chatId: string;
  chatTitle: string | null;
  userId: string;
  senderName: string | null;
};

const DEFAULT_MUTE_DURATION_HOURS = 6;
const MAX_ACTIVE_MUTE_DURATION_HOURS = 336;
const DEFAULT_BOT_BUTTON_TEXT = 'Открыть';
const RULES_BOT_BUTTON_TEXT = 'Правила';
const RULES_CALLBACK_PAYLOAD = 'rules:open';
const DEFAULT_NIGHT_MODE_TIMEZONE = 'Europe/Moscow';
const NIGHT_MODE_NOTICE_RULE_CODE = 'NIGHT_MODE_NOTICE';
const NIGHT_MODE_OPEN_NOTICE_RULE_CODE = 'NIGHT_MODE_OPEN_NOTICE';
const LINK_ESCALATION_WINDOW_HOURS = 24;
const TEXT_FILTER_ESCALATION_WINDOW_HOURS = 24;
const TOPIC_FILTER_ESCALATION_WINDOW_HOURS = 24;
const MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS = 12;
const REQUIRED_SUBSCRIPTION_ESCALATION_WINDOW_HOURS = 24;
const REQUIRED_SUBSCRIPTION_MEMBER_PRESENT_TTL_SEC = 30;
const REQUIRED_SUBSCRIPTION_MEMBER_MISSING_TTL_SEC = 10;
const REQUIRED_SUBSCRIPTION_LOOKUP_BACKOFF_MS = 15_000;
const REQUIRED_SUBSCRIPTION_NOTICE_COOLDOWN_SEC = 15 * 60;
const REQUIRED_SUBSCRIPTION_RULE_CODE = 'REQUIRED_SUBSCRIPTION';
const NIGHT_MODE_NOTICE_LOCK_TTL_MS = 2 * 60 * 1_000;
const NIGHT_MODE_NOTICE_MARKER_TTL_SEC = 2 * 24 * 60 * 60;
const NIGHT_MODE_SESSION_MARKER_TTL_SEC = 2 * 24 * 60 * 60;
const NIGHT_MODE_DELIVERY_TERMINAL_TTL_SEC = 2 * 60 * 60;
const NIGHT_MODE_TERMINAL_DELIVERY_FAILURE_METRIC_STATUSES = [403, 404] as const;
const CHAT_ADMIN_CACHE_TTL_MS = 60_000;
const CHAT_ADMIN_LOOKUP_BACKOFF_MS = 30_000;
const BACKGROUND_WORK_PAUSE_LOG_INTERVAL_MS = 60_000;
const MODERATION_CONCURRENCY_SPLIT = resolveModerationConcurrencySplit(
  readPositiveInt(process.env.MODERATION_CONCURRENCY, 24),
);
const LEGACY_MODERATION_CONCURRENCY = readPositiveInt(process.env.MODERATION_CONCURRENCY_LEGACY, 1);
const CRITICAL_MODERATION_CONCURRENCY = readPositiveInt(
  process.env.MODERATION_CONCURRENCY_CRITICAL,
  MODERATION_CONCURRENCY_SPLIT.critical,
);
const DEFAULT_MODERATION_CONCURRENCY = readPositiveInt(
  process.env.MODERATION_CONCURRENCY_DEFAULT,
  MODERATION_CONCURRENCY_SPLIT.default,
);
const DEFAULT_MODERATION_SHARD_CONCURRENCY_DEFAULTS = resolveShardConcurrencyDistribution(
  DEFAULT_MODERATION_CONCURRENCY,
  DEFAULT_WEBHOOK_QUEUE_NAMES.length,
);
const DEFAULT_MODERATION_SHARD_CONCURRENCIES = DEFAULT_WEBHOOK_QUEUE_NAMES.map((_, index) =>
  readPositiveInt(
    process.env[`MODERATION_CONCURRENCY_DEFAULT_SHARD_${index}`],
    DEFAULT_MODERATION_SHARD_CONCURRENCY_DEFAULTS[index] ?? 1,
  ),
);
const BACKGROUND_MODERATION_CONCURRENCY = readPositiveInt(
  process.env.MODERATION_CONCURRENCY_BACKGROUND,
  MODERATION_CONCURRENCY_SPLIT.background,
);
const SUPPORT_CHAT_URL = 'https://max.ru/join/qX7U_Hj-L-xMJG8V7wlF6dD-6a6cXIzTBGRtU2mRMzk';
const MINIAPP_ROUTE_START_PARAM_PREFIX = 'mr-';
const PRIVATE_MENU_CALLBACK_MENU = 'private_menu:menu';
const PRIVATE_MENU_CALLBACK_CHATS = 'private_menu:chats';
const PRIVATE_MENU_CALLBACK_CHANNELS = 'private_menu:channels';
const PRIVATE_MENU_CALLBACK_HELP = 'private_menu:help';
const PRIVATE_BOT_CHATS_PREVIEW_LIMIT = 12;
const PRIVATE_MENU_PROMPT_TEXT = [
  'Центр управления MAX:',
  '- «Чаты» — выбрать групповой чат для контента и публикации.',
  '- «Каналы» — выбрать канал для контента и публикации.',
  '- «Помощь» — короткий гайд по запуску и правам.',
  '- «Открыть приложение» — все основные настройки и rich-сценарии.',
].join('\n');
const PRIVATE_HELP_TEXT = [
  'Настройки и управление разделами перенесены в mini app.',
  'Бот используйте для текста, фото и подтверждения публикации.',
  'Добавьте бота в чат/канал и выдайте права администратора.',
  'Для точной настройки используйте приложение.',
].join('\n');
const MAX_FORWARD_SCAN_DEPTH = 8;
const DEFAULT_CHANNEL_AUTO_POST_SCAN_INTERVAL_MS = 30_000;
const DEFAULT_CHANNEL_AUTO_POST_SCAN_MAX_CHANNELS = 8;
const DEFAULT_CHANNEL_AUTO_POST_INTER_CHANNEL_DELAY_MS = 150;
const DEFAULT_CHANNEL_AUTO_POST_IDLE_BACKOFF_MAX_MS = 5 * 60 * 1_000;
const DEFAULT_CHANNEL_AUTO_POST_STARTUP_DELAY_MS = 30_000;
const DEFAULT_CHANNEL_AUTO_POST_STARTUP_JITTER_MS = 15_000;
const DEFAULT_CHANNEL_AUTO_POST_MAX_NEW_MESSAGES_PER_SCAN = 3;
const DEFAULT_NIGHT_MODE_SCHEDULED_NOTICE_SPACING_MS = 150;
const CHANNEL_AUTO_POST_RATE_LIMIT_BACKOFF_MS = 60_000;
const CHANNEL_DIALOG_START_PARAM_PREFIX = 'cd-';
const CHANNEL_DIALOG_TOKEN_PREFIX = 'cdt-';
const CHANNEL_DIALOG_AUTO_ATTACH_ACTION = 'AUTO_ATTACH_CHANNEL_ENGAGEMENT';
const CHANNEL_DIALOG_AUTO_ATTACH_SKIP_ACTION = 'AUTO_ATTACH_CHANNEL_ENGAGEMENT_SKIPPED';
const CHAT_DIALOG_AUTO_ATTACH_ACTION = 'AUTO_ATTACH_CHAT_COMMENTS';
const CHAT_COMMENTS_REPLY_TEXT = 'Открыть комментарии';
const CHANNEL_FORWARD_REPLY_TEXT = 'Действия к посту';
const GLOBAL_SPAMMER_WINDOW_SEC = 2 * 60;
const GLOBAL_SPAMMER_REDIS_TTL_SEC = GLOBAL_SPAMMER_WINDOW_SEC + 5;
const GLOBAL_SPAMMER_WARN_MIN_CHATS = 5;
const GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS = 6;
const GLOBAL_SPAMMER_WARN_THRESHOLD = 2;
const GLOBAL_SPAMMER_WARN_COUNTER_TTL_SEC = 7 * 24 * 60 * 60;
const GREETING_BURST_WINDOW_SEC = 60;
const GREETING_BURST_LIMIT = 3;
const GREETING_AUTO_DISABLE_SEC = 60 * 60;
const CROSS_CHAT_SPAM_ALWAYS_IGNORED_KEYS = new Set([
  'chat_id',
  'chatid',
  'message_id',
  'messageid',
  'sender_id',
  'senderid',
  'user_id',
  'userid',
  'update_id',
  'updateid',
  'created_at',
  'createdat',
  'timestamp',
  'seq',
  'mid',
]);
const NON_SANCTION_RULE_CODES = new Set([
  'LINK_BLOCKED',
  'PROFANITY',
  'COMMERCIAL_AD',
  'TOPIC_FILTER_MISMATCH',
  'MESSAGE_BLOCKED_WORD',
  'MESSAGE_TOO_LONG',
  'MESSAGE_COUNT_LIMIT',
  'VIDEO_BLOCKED',
  'FILE_BLOCKED',
  'VOICE_BLOCKED',
  'PHOTO_RATE_LIMIT',
  'STICKER_RATE_LIMIT',
]);
const MESSAGE_LIMITS_RULE_CODES = new Set([
  'MESSAGE_BLOCKED_WORD',
  'MESSAGE_TOO_LONG',
  'MESSAGE_COUNT_LIMIT',
  'VIDEO_BLOCKED',
  'FILE_BLOCKED',
  'VOICE_BLOCKED',
  'PHOTO_RATE_LIMIT',
  'STICKER_RATE_LIMIT',
]);
type GlobalSpammerTrackingResult = {
  handled: boolean;
  skipKnownSpammerCheck: boolean;
};
const TEXT_FILTER_RULE_CODES = new Set(['PROFANITY', 'COMMERCIAL_AD']);
const TOPIC_FILTER_RULE_CODES = new Set(['TOPIC_FILTER_MISMATCH']);
type PrivateControlCommand = 'menu' | 'chats' | 'channels' | 'help';

@Injectable()
export class ModerationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModerationService.name);
  private readonly chatAdminAccessCache = new Map<
    string,
    {
      expiresAt: number;
      state: RemoteChatAdminAccessState;
    }
  >();
  private readonly chatAdminLookupInFlight = new Map<
    string,
    Promise<RemoteChatAdminAccessState | null>
  >();
  private readonly chatAdminLookupBackoffUntilMs = new Map<string, number>();
  private readonly chatAdminChatBackoffUntilMs = new Map<string, number>();
  private readonly pendingChatAdminLookupBatches = new Map<string, PendingChatAdminLookupBatch>();
  private readonly requiredSubscriptionMembershipCache = new Map<
    string,
    {
      expiresAt: number;
      isMember: boolean;
    }
  >();
  private readonly requiredSubscriptionMembershipInFlight = new Map<
    string,
    Promise<boolean | null>
  >();
  private readonly requiredSubscriptionMembershipBackoffUntilMs = new Map<string, number>();
  private readonly ownBotUserId: string | null;
  private readonly ownBotUserIdVariants: Set<string>;
  private readonly nightModeNoticeMemoryLocks = new Map<string, string>();
  private readonly nightModeSessionMemoryMarkers = new Map<string, number>();
  private readonly nightModeDeliveryTerminalMemoryMarkers = new Map<string, number>();
  private nightModeAnnounceTimer: NodeJS.Timeout | null = null;
  private nightModeAnnounceInFlight = false;
  private channelAutoPostTimer: NodeJS.Timeout | null = null;
  private channelAutoPostStartupTimer: NodeJS.Timeout | null = null;
  private readonly channelAutoPostScanState = new Map<string, ChannelAutoPostScanState>();
  private channelAutoPostInFlight = false;
  private channelAutoPostBackoffUntilMs = 0;
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
  private readonly nightModeScheduledNoticeSpacingMs: number;
  private readonly requiredSubscriptionLookupConcurrency: number;
  private readonly backgroundTasksEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ruleEngine: RuleEngineService,
    private readonly sanctionService: SanctionService,
    private readonly maxClient: MaxClientService,
    @Optional() private readonly chatContextCache?: ChatContextCacheService,
    @Optional() private readonly systemModeService?: SystemModeService,
    @Optional() configService?: ConfigService,
    @Optional() private readonly redisCounter?: RedisCounterService,
    @Optional() private readonly privateControlService?: PrivateControlService,
    @Optional() private readonly adminService?: AdminService,
    @Optional() private readonly membershipLookupService?: MaxMembershipLookupService,
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
    this.nightModeScheduledNoticeSpacingMs = this.readNonNegativeConfigInt(
      configService?.get<number>('NIGHT_MODE_SCHEDULED_NOTICE_SPACING_MS'),
      DEFAULT_NIGHT_MODE_SCHEDULED_NOTICE_SPACING_MS,
    );
    this.requiredSubscriptionLookupConcurrency = this.readPositiveConfigInt(
      configService?.get<number>('REQUIRED_SUBSCRIPTION_LOOKUP_CONCURRENCY'),
      2,
    );
    this.backgroundTasksEnabled = moderationBackgroundTasksEnabled(
      configService?.get<string>('MODERATION_BACKGROUND_TASKS_ENABLED'),
    );
  }

  onModuleInit() {
    if (!roleRunsModeration(getAppRole())) {
      return;
    }
    if (!this.backgroundTasksEnabled) {
      return;
    }

    this.nightModeAnnounceTimer = setInterval(() => {
      void this.processNightModeAnnouncements();
    }, 30_000);
    void this.processNightModeAnnouncements();

    if (this.channelAutoPostScanMaxChannels > 0) {
      this.channelAutoPostTimer = setInterval(() => {
        void this.processChannelAutoPostButtons();
      }, this.channelAutoPostScanIntervalMs);
      this.scheduleChannelAutoPostStartupScan();
    }
  }

  onModuleDestroy() {
    if (this.nightModeAnnounceTimer) {
      clearInterval(this.nightModeAnnounceTimer);
      this.nightModeAnnounceTimer = null;
    }
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

    try {
      await this.handleUpdate(update);
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

      await this.prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          status: WebhookStatus.FAILED,
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
          nextEnqueueAt: new Date(Date.now() + 15_000),
          ...(recoveredRawPayload
            ? { rawPayload: recoveredRawPayload as Prisma.InputJsonValue }
            : {}),
        },
      });
      throw error;
    }
  }

  async handleUpdate(update: MaxUpdate) {
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
    if (this.isBotStartedUpdate(update)) {
      await this.handleBotStartedInstruction(update, chatId);
      return;
    }

    if (await this.handleBlockedBotJoin(update, chatId)) {
      return;
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
      callbackPayload && this.adminService
        ? this.adminService.parseChannelSuggestionStartPayload(callbackPayload)
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
    const pollCallback = parseManagedPollCallbackPayload(callbackPayload);
    if (pollCallback) {
      await this.handleManagedPollCallback(update, pollCallback, callbackId);
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

    const userLabel = this.formatUserLabel(senderName, senderId);
    const mode = await this.resolveSystemModeSnapshot();
    const degradeMode = mode.mode === 'degrade';
    const chat = await this.loadChatContext(chatId, chatTitle);
    const settings = this.applyDegradeSettings(chat.settings, degradeMode);
    const manualGroupCloseActiveNow = this.isNightModeForceCloseActiveNow(settings);
    const nightModeActiveNow = !manualGroupCloseActiveNow && this.isNightModeActiveNow(settings);
    const rulesPublishedUrl = chat.rulesPublishedUrl;
    const rulesPublishedMessageId = chat.rulesPublishedMessageId;

    const updateType = this.readLowerString(update.type);
    const senderIsOwnBotInMessage =
      updateType === 'message_created' && senderId ? this.isOwnBotSender(senderId) : false;
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

    if (serviceAuthored || serviceMembersEvent) {
      const excludedGreetingUserIds = new Set<string>();

      if (settings.deleteSpammersEnabled) {
        const kickedUserIds = await this.handleServiceKnownSpammerMembersEvent({
          chatId,
          adminUserIds: chat.adminUserIds,
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

      if (settings.greetingEnabled) {
        await this.handleServiceGreetingEvent({
          chatId,
          messageId,
          update,
          greetingBotMessageEnabled: settings.greetingBotMessageEnabled,
          greetingDeleteBotMessageEnabled: settings.greetingDeleteBotMessageEnabled,
          greetingDeleteBotMessageDelayMinutes: settings.greetingDeleteBotMessageDelayMinutes,
          greetingBotMessageText: settings.greetingBotMessageText,
          botSpeechStyle: settings.botSpeechStyle,
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
      return;
    }

    if (!senderId) {
      return;
    }

    const senderIsOwnBot = this.isOwnBotSender(senderId);
    const senderIsBot = senderIsOwnBot || this.isBotAuthoredMessage(update);
    if (senderIsBot) {
      if (settings.removeBotsFromGroupEnabled && !senderIsOwnBot) {
        await this.handleBotMessage({
          chatId,
          userId: senderId,
          messageId,
          text,
        });
      } else if (senderIsOwnBot) {
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

    const senderChatAdminCheck = await this.resolveSenderChatAdminCheck(
      chatId,
      chat.adminUserIds,
      senderId,
      {
        allowRemoteLookup: !degradeMode,
        skipRemoteLookupWhenLocalAdminsKnown:
          degradeMode || manualGroupCloseActiveNow || nightModeActiveNow,
      },
    );
    if (senderChatAdminCheck.isAdmin) {
      const handledAdminCommand = await this.handleAdminForwardedModerationCommand({
        update,
        chatId,
        chatTitle,
        senderId,
        senderName,
        messageId,
        settings,
      });
      if (handledAdminCommand) {
        return;
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
          source: senderChatAdminCheck.source,
        },
        'Moderation bypassed for chat admin',
      );
      return;
    }

    const mediaFlags = this.detectMediaFlags(update);
    const globalSpammerExemptUserIds = settings.deleteSpammersEnabled
      ? await this.resolveGlobalSpammerExemptUserIds([senderId], chat.adminUserIds)
      : new Set<string>();
    const isGlobalSpammerExempt = globalSpammerExemptUserIds.has(senderId);
    const globalSpammerTracking = await this.trackAndRegisterGlobalSpammer({
      chatId,
      userId: senderId,
      userLabel,
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
      const handled = await this.handleKnownSpammerSenderMessage({
        chatId,
        userId: senderId,
        messageId,
        text,
      });
      if (handled) {
        return;
      }
    }

    const activeMute = await this.getActiveMute(chatId, senderId, settings.muteDurationHours);
    if (activeMute) {
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
      await this.handleNightModeMessage({
        chatId,
        userId: senderId,
        messageId,
        text,
        createdAt,
        nightModeStartTimeMinutes: settings.nightModeStartTimeMinutes,
        nightModeEndTimeMinutes: settings.nightModeEndTimeMinutes,
        nightModeTimezone: settings.nightModeTimezone,
        botSpeechStyle: settings.botSpeechStyle,
        nightModeBotMessageEnabled: settings.nightModeBotMessageEnabled,
        nightModeBotMessageText: settings.nightModeBotMessageText,
        commentsEnabled: settings.commentsEnabled,
        nightModeCommentsEnabled: settings.nightModeCommentsEnabled,
        nightModeBotButtonEnabled: settings.nightModeBotButtonEnabled,
        nightModeBotButtonUrl: settings.nightModeBotButtonUrl,
        nightModeBotButtonText: settings.nightModeBotButtonText,
        nightModeRulesButtonEnabled: settings.nightModeRulesButtonEnabled,
        rulesPublishedUrl,
        rulesPublishedMessageId,
      });
      return;
    }

    const requiredSubscriptionHandled = await this.handleRequiredSubscriptionMessage({
      chatId,
      userId: senderId,
      userLabel,
      messageId,
      text,
      createdAt,
      degradeMode,
      settings,
      rulesPublishedUrl,
      rulesPublishedMessageId,
    });
    if (requiredSubscriptionHandled) {
      return;
    }

    const effectiveMessageLength = this.calculateEffectiveMessageLength(update);
    const detection = await this.ruleEngine.detect({
      chatId,
      userId: senderId,
      text,
      settings,
      domainAllowlist: chat.domainAllowlist,
      effectiveLength: effectiveMessageLength,
      hasPhotoAttachment: mediaFlags.hasPhotoAttachment,
      hasStickerAttachment: mediaFlags.hasStickerAttachment,
      hasVideoAttachment: mediaFlags.hasVideoAttachment,
      hasFileAttachment: mediaFlags.hasFileAttachment,
      hasVoiceAttachment: mediaFlags.hasVoiceAttachment,
    });

    const { violations } = detection;
    const hasCompetingViolation = violations.length > 0;
    const latestManualUnbanAt =
      detection.duplicateDecision || detection.duplicateHit
        ? await this.resolveLatestManualUnbanCreatedAt(chatId, senderId)
        : null;
    const duplicateDecisionSuppressed =
      detection.duplicateDecision && latestManualUnbanAt
        ? this.isWithinWindowFromDate(latestManualUnbanAt, detection.duplicateDecision.windowSec)
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
        duplicateBotMessageEnabled: settings.duplicateBotMessageEnabled,
        duplicateBotMessageText: settings.duplicateBotMessageText,
        duplicateBotButtonEnabled: settings.duplicateBotButtonEnabled,
        duplicateBotButtonUrl: settings.duplicateBotButtonUrl,
        duplicateBotButtonText: settings.duplicateBotButtonText,
        rulesAttachViolationsEnabled: settings.rulesAttachViolationsEnabled,
        rulesPublishedUrl,
        rulesPublishedMessageId,
        deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
      });
      return;
    }

    const duplicateHitSuppressed =
      detection.duplicateHit && latestManualUnbanAt
        ? this.isWithinWindowFromDate(latestManualUnbanAt, detection.duplicateHit.windowSec)
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
        duplicateBotMessageEnabled: settings.duplicateBotMessageEnabled,
        duplicateBotMessageText: settings.duplicateBotMessageText,
        duplicateBotButtonEnabled: settings.duplicateBotButtonEnabled,
        duplicateBotButtonUrl: settings.duplicateBotButtonUrl,
        duplicateBotButtonText: settings.duplicateBotButtonText,
        rulesAttachViolationsEnabled: settings.rulesAttachViolationsEnabled,
        rulesPublishedUrl,
        rulesPublishedMessageId,
        deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
      });
      return;
    }

    if (violations.length === 0) {
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
      violations.find((item) => item.ruleCode === 'MESSAGE_TOO_LONG') ??
      violations.find((item) => item.ruleCode === 'MESSAGE_COUNT_LIMIT') ??
      violations.find((item) => item.ruleCode === 'VIDEO_BLOCKED') ??
      violations.find((item) => item.ruleCode === 'FILE_BLOCKED') ??
      violations.find((item) => item.ruleCode === 'VOICE_BLOCKED') ??
      violations.find((item) => item.ruleCode === 'PHOTO_RATE_LIMIT') ??
      violations.find((item) => item.ruleCode === 'STICKER_RATE_LIMIT') ??
      violations[0];

    await this.prisma.violation.create({
      data: {
        chatId,
        userId: senderId,
        ruleCode: topViolation.ruleCode,
        score: topViolation.score,
      },
    });

    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;

    if (canDeleteMessage) {
      await this.maxClient.deleteMessage(chatId, messageId);
      await this.prisma.moderationEvent.create({
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
            ...((topViolation.ruleCode === 'TOPIC_FILTER_MISMATCH' ||
              topViolation.ruleCode === 'MESSAGE_BLOCKED_WORD') &&
            topViolation.metadata &&
            typeof topViolation.metadata === 'object'
              ? topViolation.metadata
              : {}),
          },
        },
      });
    } else {
      await this.maxClient.notifyModerators(
        chatId,
        `Нарушение ${topViolation.ruleCode} от ${senderId}, но сообщение старше 24 часов и не может быть удалено`,
      );
    }

    const linkMessageOptions =
      topViolation.ruleCode === 'LINK_BLOCKED'
        ? this.buildBotMessageOptions(
            chatId,
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
        ? await this.countRecentLinkViolations(chatId, senderId)
        : null;
    const isTextFilterHit = this.isTextFilterViolation(topViolation.ruleCode);
    const isTopicFilterHit = this.isTopicFilterViolation(topViolation.ruleCode);
    const isMessageLimitsHit = this.isMessageLimitsViolation(topViolation.ruleCode);
    const messageLimitsBlockedWord = this.extractMessageLimitsBlockedWord(topViolation.metadata);
    const textFilterEscalationSettings = isTextFilterHit
      ? this.resolveTextFilterEscalationSettings(topViolation.ruleCode, settings)
      : null;
    const textFilterMessageOptions = isTextFilterHit
      ? this.buildBotMessageOptions(
          chatId,
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
          settings.messageLimitsBotButtonEnabled,
          settings.messageLimitsBotButtonUrl,
          settings.messageLimitsBotButtonText,
          settings.rulesAttachViolationsEnabled,
          rulesPublishedUrl,
          rulesPublishedMessageId,
        )
      : null;
    const topicMessageOptions = isTopicFilterHit
      ? this.buildBotMessageOptions(
          chatId,
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
    const sendChatBotMessage = async (textValue: string, messageOptions?: MaxSendMessageOptions) =>
      this.sendBotMessageWithOptionalAutoDelete({
        chatId,
        text: textValue,
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

    if (topViolation.ruleCode === 'LINK_BLOCKED') {
      if (
        action === SanctionAction.NONE &&
        isFirstLinkViolation &&
        settings.linkBotMessageEnabled
      ) {
        try {
          await sendChatBotMessage(
            this.buildLinkExplanation(
              userLabel,
              canDeleteMessage,
              settings.linkBotMessageText,
              settings.botSpeechStyle,
            ),
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
            'Failed to send link explanation message',
          );
        }
      } else if (action === SanctionAction.WARN) {
        try {
          await sendChatBotMessage(
            this.buildLinkWarnExplanation(
              userLabel,
              settings.linkWarnMessageText,
              settings.botSpeechStyle,
            ),
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
            'Failed to send link warning message',
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
            this.buildMessageLimitsExplanation(
              userLabel,
              topViolation.ruleCode,
              canDeleteMessage,
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
            'Failed to send message limits explanation message',
          );
        }
      } else if (action === SanctionAction.WARN) {
        try {
          await sendChatBotMessage(
            this.buildMessageLimitsWarnExplanation(
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
            this.buildTextFilterExplanation(
              userLabel,
              topViolation.ruleCode,
              canDeleteMessage,
              textFilterEscalationSettings.botMessageText,
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
              ruleCode: topViolation.ruleCode,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed to send text filter explanation message',
          );
        }
      } else if (action === SanctionAction.WARN) {
        try {
          await sendChatBotMessage(
            this.buildTextFilterWarnExplanation(
              userLabel,
              topViolation.ruleCode,
              textFilterEscalationSettings?.warnMessageText ?? settings.textFiltersWarnMessageText,
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
            this.buildTopicFilterExplanation(
              userLabel,
              canDeleteMessage,
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
            'Failed to send thematic filter explanation message',
          );
        }
      } else if (action === SanctionAction.WARN) {
        try {
          await sendChatBotMessage(
            this.buildTopicFilterWarnExplanation(
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
              : isMessageLimitsHit
                ? (limitsMessageOptions ?? undefined)
                : undefined,
        sanctionNoticeText:
          isMessageLimitsHit && action === SanctionAction.BAN
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
    }

    await this.prisma.moderationEvent.create({
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
          ...((isTopicFilterHit || topViolation.ruleCode === 'MESSAGE_BLOCKED_WORD') &&
          topViolation.metadata &&
          typeof topViolation.metadata === 'object'
            ? topViolation.metadata
            : {}),
          ...(topViolation.ruleCode === 'LINK_BLOCKED' && linkViolationCount24h !== null
            ? {
                linkViolationCount24h,
                linkEscalationWindowHours: LINK_ESCALATION_WINDOW_HOURS,
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
    duplicateBotMessageEnabled: boolean;
    duplicateBotMessageText: string;
    duplicateBotButtonEnabled: boolean;
    duplicateBotButtonUrl: string;
    duplicateBotButtonText: string;
    rulesAttachViolationsEnabled: boolean;
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
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
      duplicateBotMessageEnabled,
      duplicateBotMessageText,
      duplicateBotButtonEnabled,
      duplicateBotButtonUrl,
      duplicateBotButtonText,
      rulesAttachViolationsEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
    } = params;
    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;
    let messageDeleted = false;

    if (canDeleteMessage) {
      try {
        await this.maxClient.deleteMessage(chatId, messageId);
        messageDeleted = true;
        await this.prisma.moderationEvent.create({
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

    const duplicateMessageOptions = this.buildBotMessageOptions(
      chatId,
      duplicateBotButtonEnabled,
      duplicateBotButtonUrl,
      duplicateBotButtonText,
      rulesAttachViolationsEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
    );

    if (duplicateBotMessageEnabled && decision.action !== 'BAN') {
      try {
        await this.sendBotMessageWithOptionalAutoDelete({
          chatId,
          text: this.buildDuplicateExplanation(
            userLabel,
            decision,
            muteDurationHours,
            messageDeleted,
            duplicateBotMessageText,
            botSpeechStyle,
          ),
          messageOptions: duplicateMessageOptions ?? undefined,
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

    await this.prisma.moderationEvent.create({
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
    duplicateBotMessageEnabled: boolean;
    duplicateBotMessageText: string;
    duplicateBotButtonEnabled: boolean;
    duplicateBotButtonUrl: string;
    duplicateBotButtonText: string;
    rulesAttachViolationsEnabled: boolean;
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
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
      duplicateBotMessageEnabled,
      duplicateBotMessageText,
      duplicateBotButtonEnabled,
      duplicateBotButtonUrl,
      duplicateBotButtonText,
      rulesAttachViolationsEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
    } = params;
    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;
    let messageDeleted = false;

    if (canDeleteMessage) {
      try {
        await this.maxClient.deleteMessage(chatId, messageId);
        messageDeleted = true;
        await this.prisma.moderationEvent.create({
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

    const duplicateMessageOptions = this.buildBotMessageOptions(
      chatId,
      duplicateBotButtonEnabled,
      duplicateBotButtonUrl,
      duplicateBotButtonText,
      rulesAttachViolationsEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
    );

    if (duplicateBotMessageEnabled) {
      try {
        await this.sendBotMessageWithOptionalAutoDelete({
          chatId,
          text: this.buildDuplicateHitExplanation(
            userLabel,
            messageDeleted,
            duplicateBotMessageText,
            botSpeechStyle,
          ),
          messageOptions: duplicateMessageOptions ?? undefined,
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

  private buildLinkExplanation(
    userLabel: string,
    canDeleteMessage: boolean,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const reason = 'в этом чате ссылки не проходят, без ссылок';
    const messageStatus = this.buildMessageStatusLabel(canDeleteMessage);
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
    const reason = 'для сообщений нужна подписка на обязательные каналы';
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

  private buildLinkWarnExplanation(
    userLabel: string,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const reason = 'в этом чате ссылки не проходят, без ссылок';
    const warning = 'вынесено предупреждение за ссылку';

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
      return 'обязательные каналы';
    }

    return normalizedTitles.join(', ');
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
        sanction: this.buildDuplicatePassiveSanctionLabel(botSpeechStyle),
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
      : getBotSpeechEditableTemplate(style, fieldKey);
  }

  private renderEditableBotSpeechTemplate(params: {
    style: BotSpeechStyle | null;
    fieldKey: BotSpeechEditableFieldKey;
    overrideText: string;
    replacements: Record<string, string>;
  }): string {
    const fallback = getBotSpeechEditableTemplate(params.style, params.fieldKey);

    return this.renderBotMessageTemplate(
      this.resolveEditableBotSpeechText(params.style, params.fieldKey, params.overrideText),
      fallback,
      params.replacements,
    );
  }

  private renderSystemBotSpeechTemplate(params: {
    style: BotSpeechStyle | null;
    templateKey: BotSpeechSystemTemplateKey;
    replacements: Record<string, string>;
  }): string {
    const template = getBotSpeechSystemTemplate(params.style, params.templateKey);

    return this.renderBotMessageTemplate(template, template, params.replacements);
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
    return `Товарищ ${userLabel}, Майор Максимов на связи 👮‍♂️ ${subject} ${messageStatus}: ${reason}. Поправьте и едем дальше.`;
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
      if (action === 'WARN') {
        return 'Предупреждение оформил.';
      }
      if (action === 'MUTE') {
        return `Оформляю мут на ${muteDurationLabel}.`;
      }
      return 'Оформляю бан до ручного разбана.';
    }

    if (style === 'ROBOT') {
      if (action === 'WARN') {
        return 'Предупреждение зарегистрировано.';
      }
      if (action === 'MUTE') {
        return `Установлен мут на ${muteDurationLabel}.`;
      }
      return 'Установлен бан до ручного снятия.';
    }

    if (style === 'FRIENDLY') {
      if (action === 'WARN') {
        return 'Это уже предупреждение.';
      }
      if (action === 'MUTE') {
        return `Нужен мут на ${muteDurationLabel}.`;
      }
      return 'Пришлось выдать бан до ручного разбана.';
    }

    if (style === 'IRONIC') {
      if (action === 'WARN') {
        return 'Да, это уже предупреждение.';
      }
      if (action === 'MUTE') {
        return `Мут на ${muteDurationLabel}. Пусть идея чуть остынет.`;
      }
      return 'Бан без таймера. Чат решил больше не рисковать.';
    }

    if (action === 'WARN') {
      return 'Фиксирую предупреждение.';
    }
    if (action === 'MUTE') {
      return `Оформляю мут на ${muteDurationLabel}.`;
    }
    return 'Оформляю бан до ручного снятия.';
  }

  private buildDuplicatePassiveSanctionLabel(style: BotSpeechStyle | null): string {
    if (style === 'POLICE' || style === null) {
      return 'Повтор изъял, пока без протокола.';
    }

    if (style === 'ROBOT') {
      return 'Сообщение удалено.';
    }

    if (style === 'FRIENDLY') {
      return 'Пока просто убрал повтор.';
    }

    if (style === 'IRONIC') {
      return 'Повтор убрал. Коллекцию можно не собирать.';
    }

    return 'Пока без взыскания.';
  }

  private escapeMaxMarkdownText(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/([*_`[\]()~+])/g, '\\$1');
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
    if (action === SanctionAction.MUTE) {
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

    try {
      await this.maxClient.banMember(chatId, userId);
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
      return `Система: ${userLabel}. Выдан бан до ручного снятия.`;
    }

    if (botSpeechStyle === 'FRIENDLY') {
      return `${userLabel}, пришлось выдать бан до ручного разбана.`;
    }

    if (botSpeechStyle === 'IRONIC') {
      return `${userLabel}, на этот раз дошло до бана без таймера.`;
    }

    return `Товарищ ${userLabel}, оформляю бан до ручного разбана.`;
  }

  private shouldResolveSanction(ruleCode: string): boolean {
    return !NON_SANCTION_RULE_CODES.has(ruleCode);
  }

  private resolveLinkEscalationAction(
    linkViolationCount24h: number,
    settings: { warnEnabled: boolean; banEnabled: boolean; muteEnabled: boolean },
  ): SanctionAction {
    const count = Number.isInteger(linkViolationCount24h) ? Math.max(1, linkViolationCount24h) : 1;

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
  } {
    if (ruleCode === 'PROFANITY') {
      return {
        botMessageEnabled: settings.profanityBotMessageEnabled,
        botMessageText: settings.textFiltersBotMessageText,
        warnEnabled: settings.profanityWarnEnabled,
        warnMessageText: settings.textFiltersWarnMessageText,
        banEnabled: settings.profanityBanEnabled,
        muteEnabled: settings.profanityMuteEnabled,
      };
    }

    return {
      botMessageEnabled: settings.textFiltersBotMessageEnabled,
      botMessageText: settings.textFiltersBotMessageText,
      warnEnabled: settings.textFiltersWarnEnabled,
      warnMessageText: settings.textFiltersWarnMessageText,
      banEnabled: settings.textFiltersBanEnabled,
      muteEnabled: settings.textFiltersMuteEnabled,
    };
  }

  private resolveAutomaticMuteDurationHours(ruleCode: string, settings: ChatSettings): number {
    if (ruleCode === 'LINK_BLOCKED') {
      return settings.linkMuteDurationHours;
    }

    if (ruleCode === REQUIRED_SUBSCRIPTION_RULE_CODE) {
      return settings.requiredSubscriptionMuteDurationHours;
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

    if (ruleCode === 'MESSAGE_BLOCKED_WORD') {
      const reason = blockedWord ? `стоп-слово: ${blockedWord}` : 'слово из стоп-листа';
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
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'messageLimitsWarn',
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

    if (ruleCode === 'STICKER_RATE_LIMIT') {
      return 'слишком частая отправка стикеров';
    }

    if (ruleCode === 'MESSAGE_COUNT_LIMIT') {
      return 'слишком частая отправка сообщений';
    }

    if (ruleCode === 'MESSAGE_TOO_LONG') {
      return 'слишком длинное сообщение';
    }

    if (ruleCode === 'MESSAGE_BLOCKED_WORD') {
      return blockedWord ? `стоп-слово: ${blockedWord}` : 'слово из стоп-листа';
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

  private extractMessageLimitsBlockedWord(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== 'object') {
      return null;
    }

    const blockedWord = (metadata as { blockedWord?: unknown }).blockedWord;
    return typeof blockedWord === 'string' && blockedWord.trim().length > 0
      ? blockedWord.trim()
      : null;
  }

  private calculateEffectiveMessageLength(update: MaxUpdate): number {
    const baseText = update.message?.text ?? '';
    const baseLength = baseText.length;
    const forwardedSnippets = this.collectForwardedTextSnippets(update.raw);

    if (forwardedSnippets.length === 0) {
      return baseLength;
    }

    const normalizedBaseText = baseText.toLowerCase();
    let totalLength = baseLength;

    for (const snippet of forwardedSnippets) {
      if (!snippet) {
        continue;
      }

      if (normalizedBaseText.includes(snippet.toLowerCase())) {
        continue;
      }

      totalLength += snippet.length;
    }

    return totalLength;
  }

  private collectForwardedTextSnippets(raw: unknown): string[] {
    const rawRecord = this.asRecord(raw);
    if (!rawRecord) {
      return [];
    }

    const messageNode = this.extractRawMessageNode(rawRecord) ?? rawRecord;
    const forwardedNodes = this.collectForwardedNodes(messageNode);
    if (forwardedNodes.length === 0) {
      return [];
    }

    const snippets = new Set<string>();
    for (const node of forwardedNodes) {
      this.collectTextSnippets(node, snippets);
    }

    return [...snippets];
  }

  private extractRawMessageNode(raw: Record<string, unknown>): Record<string, unknown> | null {
    const directMessage = this.asRecord(raw.message);
    if (directMessage) {
      return directMessage;
    }

    const envelopeKeys = ['message_created', 'data', 'event'];
    if (typeof raw.update_type === 'string') {
      envelopeKeys.push(raw.update_type);
    }
    if (typeof raw.type === 'string') {
      envelopeKeys.push(raw.type);
    }

    for (const key of envelopeKeys) {
      const envelope = this.asRecord(raw[key]);
      if (!envelope) {
        continue;
      }

      const nestedMessage = this.asRecord(envelope.message);
      if (nestedMessage) {
        return nestedMessage;
      }

      const nestedData = this.asRecord(envelope.data);
      const nestedDataMessage = nestedData ? this.asRecord(nestedData.message) : null;
      if (nestedDataMessage) {
        return nestedDataMessage;
      }
    }

    return null;
  }

  private collectForwardedNodes(node: unknown, depth = 0, acc: unknown[] = []): unknown[] {
    if (depth > MAX_FORWARD_SCAN_DEPTH || node === null || node === undefined) {
      return acc;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectForwardedNodes(item, depth + 1, acc);
      }
      return acc;
    }

    if (typeof node !== 'object') {
      return acc;
    }

    const row = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(row)) {
      if (/forward/i.test(key)) {
        acc.push(value);
      }

      if (value && (typeof value === 'object' || Array.isArray(value))) {
        this.collectForwardedNodes(value, depth + 1, acc);
      }
    }

    return acc;
  }

  private collectTextSnippets(node: unknown, acc: Set<string>, depth = 0) {
    if (depth > MAX_FORWARD_SCAN_DEPTH || node === null || node === undefined) {
      return;
    }

    if (typeof node === 'string') {
      const normalized = node.trim();
      if (normalized.length > 0) {
        acc.add(normalized);
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectTextSnippets(item, acc, depth + 1);
      }
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    const row = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(row)) {
      if (
        (key === 'text' ||
          key === 'caption' ||
          key === 'plain' ||
          key === 'message_text' ||
          key === 'messageText') &&
        typeof value === 'string'
      ) {
        const normalized = value.trim();
        if (normalized.length > 0) {
          acc.add(normalized);
        }
        continue;
      }

      if (
        value &&
        (typeof value === 'object' || Array.isArray(value) || typeof value === 'string')
      ) {
        this.collectTextSnippets(value, acc, depth + 1);
      }
    }
  }

  private detectMediaFlags(update: MaxUpdate): {
    hasPhotoAttachment: boolean;
    hasStickerAttachment: boolean;
    hasVideoAttachment: boolean;
    hasFileAttachment: boolean;
    hasVoiceAttachment: boolean;
  } {
    const rawRecord = this.asRecord(update.raw);
    if (!rawRecord) {
      return {
        hasPhotoAttachment: false,
        hasStickerAttachment: false,
        hasVideoAttachment: false,
        hasFileAttachment: false,
        hasVoiceAttachment: false,
      };
    }

    const messageNode = this.extractRawMessageNode(rawRecord) ?? rawRecord;
    const flags = {
      hasPhotoAttachment: false,
      hasStickerAttachment: false,
      hasVideoAttachment: false,
      hasFileAttachment: false,
      hasVoiceAttachment: false,
    };
    this.collectMediaFlags(messageNode, flags);
    return flags;
  }

  private collectMediaFlags(
    node: unknown,
    flags: {
      hasPhotoAttachment: boolean;
      hasStickerAttachment: boolean;
      hasVideoAttachment: boolean;
      hasFileAttachment: boolean;
      hasVoiceAttachment: boolean;
    },
    depth = 0,
    inStickerContext = false,
    inFileContext = false,
  ) {
    if (
      depth > MAX_FORWARD_SCAN_DEPTH ||
      node === null ||
      node === undefined ||
      (flags.hasPhotoAttachment &&
        flags.hasStickerAttachment &&
        flags.hasVideoAttachment &&
        flags.hasFileAttachment &&
        flags.hasVoiceAttachment)
    ) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectMediaFlags(item, flags, depth + 1, inStickerContext, inFileContext);
      }
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    const row = node as Record<string, unknown>;
    const type = this.readLowerString(row.type);
    const mimeType = this.readLowerString(row.mime_type ?? row.mimeType);
    const fileName = this.readLowerString(row.file_name ?? row.fileName ?? row.filename);
    const mediaType = this.readLowerString(row.media_type ?? row.mediaType);
    const stickerContext = inStickerContext || type === 'sticker' || mediaType === 'sticker';
    const fileContext =
      inFileContext ||
      type === 'file' ||
      type === 'document' ||
      type === 'doc' ||
      mediaType === 'file' ||
      mediaType === 'document';

    if (
      !stickerContext &&
      !fileContext &&
      (type === 'photo' ||
        type === 'image' ||
        type === 'picture' ||
        mimeType?.startsWith('image/') ||
        mediaType === 'photo' ||
        mediaType === 'image')
    ) {
      flags.hasPhotoAttachment = true;
    }

    if (stickerContext) {
      flags.hasStickerAttachment = true;
    }

    if (
      type === 'video' ||
      mimeType?.startsWith('video/') ||
      mediaType === 'video' ||
      this.isLikelyVideoFileName(fileName)
    ) {
      flags.hasVideoAttachment = true;
    }

    if (
      type === 'voice' ||
      type === 'audio' ||
      type === 'audio_message' ||
      type === 'ptt' ||
      mimeType?.startsWith('audio/') ||
      mediaType === 'voice' ||
      mediaType === 'audio' ||
      this.isLikelyVoiceFileName(fileName)
    ) {
      flags.hasVoiceAttachment = true;
    }

    if (fileContext) {
      flags.hasFileAttachment = true;
    }

    for (const [key, value] of Object.entries(row)) {
      const keyLower = key.toLowerCase();
      if (
        !stickerContext &&
        !fileContext &&
        (keyLower === 'photo' ||
          keyLower === 'image' ||
          keyLower === 'picture' ||
          keyLower === 'images')
      ) {
        flags.hasPhotoAttachment = true;
      }

      if (keyLower === 'sticker' || keyLower === 'stickers') {
        flags.hasStickerAttachment = true;
      }

      if (keyLower === 'video' || keyLower === 'videos') {
        flags.hasVideoAttachment = true;
      }

      if (
        keyLower === 'voice' ||
        keyLower === 'voices' ||
        keyLower === 'audio' ||
        keyLower === 'audio_message'
      ) {
        flags.hasVoiceAttachment = true;
      }

      if (keyLower === 'file' || keyLower === 'files' || keyLower === 'document') {
        flags.hasFileAttachment = true;
      }

      if (value && (typeof value === 'object' || Array.isArray(value))) {
        const childStickerContext =
          stickerContext || keyLower === 'sticker' || keyLower === 'stickers';
        const childFileContext =
          fileContext ||
          keyLower === 'file' ||
          keyLower === 'files' ||
          keyLower === 'document' ||
          keyLower === 'documents';
        this.collectMediaFlags(value, flags, depth + 1, childStickerContext, childFileContext);
      }
    }
  }

  private isLikelyVideoFileName(value: string | null): boolean {
    if (!value) {
      return false;
    }

    return /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(value);
  }

  private isLikelyVoiceFileName(value: string | null): boolean {
    if (!value) {
      return false;
    }

    return /\.(ogg|opus|mp3|m4a|wav|flac)$/i.test(value);
  }

  private buildBotMessageOptions(
    chatId: string,
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
    const primaryButton = this.buildLinkButton(buttonEnabled, buttonUrl, buttonText);
    if (primaryButton) {
      buttons.push(primaryButton);
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

    if (buttons.length === 1 && this.isLinkButton(buttons[0])) {
      return {
        button: buttons[0],
        ...(rulesMessageLink ? { messageLink: rulesMessageLink } : {}),
      };
    }

    return buttons.length > 0
      ? {
          buttons: [buttons],
          ...(rulesMessageLink ? { messageLink: rulesMessageLink } : {}),
        }
      : {
          messageLink: rulesMessageLink,
        };
  }

  private buildRequiredSubscriptionMessageOptions(
    channels: ReadonlyArray<{ id: string; title: string; link: string | null }>,
    rulesButtonEnabled: boolean,
    rulesPublishedUrl: string | null,
    rulesPublishedMessageId: string | null,
  ): MaxSendMessageOptions | null {
    const buttons = channels
      .map((channel) => {
        const normalizedUrl = this.normalizeBotButtonUrl(channel.link ?? '');
        if (!normalizedUrl) {
          return null;
        }

        return {
          text: this.normalizeBotButtonText(channel.title),
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

  private async countRecentLinkViolations(chatId: string, userId: string): Promise<number> {
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

    const since = await this.resolveViolationResetSince(
      chatId,
      userId,
      LINK_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000,
    );
    const count = await violationModel.count({
      where: {
        chatId,
        userId,
        ruleCode: 'LINK_BLOCKED',
        createdAt: { gte: since },
      },
    });

    return Number.isInteger(count) && count > 0 ? count : 1;
  }

  private async countRecentRequiredSubscriptionViolations(
    chatId: string,
    userId: string,
  ): Promise<number> {
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

    const since = await this.resolveViolationResetSince(
      chatId,
      userId,
      REQUIRED_SUBSCRIPTION_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000,
    );
    const count = await violationModel.count({
      where: {
        chatId,
        userId,
        ruleCode: REQUIRED_SUBSCRIPTION_RULE_CODE,
        createdAt: { gte: since },
      },
    });

    return Number.isInteger(count) && count > 0 ? count : 1;
  }

  private async countRecentTextFilterViolations(
    chatId: string,
    userId: string,
    ruleCode: string,
  ): Promise<number> {
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

    const since = await this.resolveViolationResetSince(
      chatId,
      userId,
      TEXT_FILTER_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000,
    );
    const ruleCodeFilter =
      ruleCode === 'PROFANITY' || ruleCode === 'COMMERCIAL_AD'
        ? ruleCode
        : { in: ['PROFANITY', 'COMMERCIAL_AD'] };
    const count = await violationModel.count({
      where: {
        chatId,
        userId,
        ruleCode: ruleCodeFilter,
        createdAt: { gte: since },
      },
    });

    return Number.isInteger(count) && count > 0 ? count : 1;
  }

  private async countRecentTopicFilterViolations(
    chatId: string,
    userId: string,
    ruleCode: string,
  ): Promise<number> {
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

    const since = await this.resolveViolationResetSince(
      chatId,
      userId,
      TOPIC_FILTER_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000,
    );
    const count = await violationModel.count({
      where: {
        chatId,
        userId,
        ruleCode,
        createdAt: { gte: since },
      },
    });

    return Number.isInteger(count) && count > 0 ? count : 1;
  }

  private async countRecentMessageLimitsViolations(
    chatId: string,
    userId: string,
    ruleCode: string,
  ): Promise<number> {
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

    const since = await this.resolveViolationResetSince(
      chatId,
      userId,
      MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000,
    );
    const count = await violationModel.count({
      where: {
        chatId,
        userId,
        ruleCode,
        createdAt: { gte: since },
      },
    });

    return Number.isInteger(count) && count > 0 ? count : 1;
  }

  private async resolveViolationResetSince(
    chatId: string,
    userId: string,
    windowMs: number,
  ): Promise<Date> {
    const baseSince = new Date(Date.now() - windowMs);
    const latestManualUnban = await this.resolveLatestManualUnbanCreatedAt(chatId, userId);

    if (latestManualUnban && latestManualUnban.getTime() > baseSince.getTime()) {
      return latestManualUnban;
    }

    return baseSince;
  }

  private async resolveLatestManualUnbanCreatedAt(
    chatId: string,
    userId: string,
  ): Promise<Date | null> {
    const latestManualUnban = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId,
        ruleCode: 'MANUAL_UNBAN',
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        createdAt: true,
      },
    });

    return latestManualUnban?.createdAt ?? null;
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
    const latestRelevantEvent = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId,
        OR: [
          { action: SanctionAction.MUTE },
          { action: SanctionAction.BAN },
          { ruleCode: 'MANUAL_UNMUTE' },
          { ruleCode: 'MANUAL_UNBAN' },
        ],
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
    });

    if (!latestRelevantEvent) {
      return null;
    }

    const latestAction = latestRelevantEvent.action ?? SanctionAction.BAN;
    if (
      latestRelevantEvent.ruleCode === 'MANUAL_UNMUTE' ||
      latestRelevantEvent.ruleCode === 'MANUAL_UNBAN'
    ) {
      return null;
    }

    const storedDurationHours = this.readStoredMuteDurationHoursFromMetadata(
      latestRelevantEvent.metadata,
    );
    const isTimedMute =
      latestAction === SanctionAction.MUTE ||
      (latestAction === SanctionAction.BAN && storedDurationHours !== null);

    if (!isTimedMute) {
      return null;
    }

    const durationHours = storedDurationHours ?? fallbackMuteDurationHours;
    const expiresAt = new Date(
      latestRelevantEvent.createdAt.getTime() + durationHours * 60 * 60 * 1000,
    );
    if (expiresAt.getTime() <= Date.now()) {
      return null;
    }

    return {
      eventId: latestRelevantEvent.id,
      issuedAt: latestRelevantEvent.createdAt,
      expiresAt,
      durationHours,
    };
  }

  private async handleAdminForwardedModerationCommand(params: {
    update: MaxUpdate;
    chatId: string;
    chatTitle?: string;
    senderId: string;
    senderName?: string;
    messageId: string;
    settings: ChatSettings;
  }): Promise<boolean> {
    const { update, chatId, chatTitle, senderId, senderName, messageId, settings } = params;
    const directText = this.extractDirectIncomingMessageText(update);
    let command: AdminForwardedModerationCommand | null;
    try {
      command = this.parseAdminForwardedModerationCommand(directText);
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

    const targets = this.extractForwardedModerationTargets(update);
    if (targets.length === 0) {
      return false;
    }

    const uniqueTargets = this.dedupeForwardedModerationTargets(targets);
    if (uniqueTargets.length !== 1) {
      await this.sendGroupAdminCommandNotice({
        chatId,
        settings,
        text: 'Перешлите или ответьте на одно сообщение из этого чата и добавьте слово `бан` или `мут`.',
      });
      return true;
    }

    const target = uniqueTargets[0];
    if (target.chatId !== chatId) {
      await this.sendGroupAdminCommandNotice({
        chatId,
        settings,
        text: 'Команда `бан` или `мут` работает только для сообщений из этого чата.',
      });
      return true;
    }

    if (!this.adminService) {
      this.logger.warn(
        {
          chatId,
          actorUserId: senderId,
          targetUserId: target.userId,
        },
        'Admin forwarded moderation command ignored: AdminService is unavailable',
      );
      return false;
    }

    const actor: AuthUser = {
      userId: senderId,
      username: null,
      displayName: senderName?.trim() || null,
      chatId,
      chatTitle: chatTitle?.trim() || null,
    };
    try {
      const result =
        command.action === 'BAN'
          ? await this.adminService.applyManualSystemBan(
              chatId,
              target.userId,
              actor,
              'group_command',
            )
          : await this.adminService.applyManualModerationAction(
              chatId,
              target.userId,
              actor,
              {
                action: 'MUTE',
                muteDurationHours: command.muteDurationHours,
              },
              'group_command',
            );

      await this.deleteAdminCommandMessage(chatId, messageId);
      const targetLabel = this.formatUserLabel(target.senderName ?? undefined, target.userId);
      await this.sendGroupAdminCommandNotice({
        chatId,
        settings,
        text:
          command.action === 'BAN'
            ? `Пользователь ${targetLabel} забанен.`
            : `${result.message}\nПользователь: ${targetLabel}`,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          actorUserId: senderId,
          targetUserId: target.userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to apply forwarded admin moderation command',
      );

      await this.sendGroupAdminCommandNotice({
        chatId,
        settings,
        text: `Не удалось применить ${command.action === 'BAN' ? 'бан' : 'мут'}: ${this.escapeMaxMarkdownText(
          this.extractGroupAdminCommandErrorMessage(error),
        )}`,
      });
    }

    return true;
  }

  private parseAdminForwardedModerationCommand(
    text: string,
  ): AdminForwardedModerationCommand | null {
    const normalized = this.readLowerString(text);
    if (!normalized) {
      return null;
    }

    if (
      normalized === 'бан' ||
      normalized === 'ban' ||
      normalized === 'бан!' ||
      normalized === 'ban!'
    ) {
      return {
        action: 'BAN',
      };
    }

    if (
      /^(?:бан|ban)\s+\d{1,3}(?:\s*(?:ч|час|часа|часов|h|hr|hrs|hour|hours))?[.!]?$/u.test(
        normalized,
      )
    ) {
      throw new BadRequestException(
        'Команда `бан` теперь делает только постоянный системный бан. Используйте просто `бан`.',
      );
    }

    if (!/^(?:бан|ban)[.!]?$/u.test(normalized)) {
      if (/^(?:мут|мьют|мью|mute)[.!]?$/u.test(normalized)) {
        return {
          action: 'MUTE',
          muteDurationHours: DEFAULT_MUTE_DURATION_HOURS,
        };
      }

      const muteDurationMatch = normalized.match(
        /^(?:мут|мьют|мью|mute)\s+(\d{1,3})(?:\s*(?:ч|час|часа|часов|h|hr|hrs|hour|hours))?[.!]?$/u,
      );
      if (!muteDurationMatch) {
        return null;
      }

      const muteDurationHours = Number.parseInt(muteDurationMatch[1], 10);
      if (
        !Number.isInteger(muteDurationHours) ||
        muteDurationHours < 1 ||
        muteDurationHours > MAX_ACTIVE_MUTE_DURATION_HOURS
      ) {
        throw new BadRequestException(
          `Длительность мута должна быть от 1 до ${MAX_ACTIVE_MUTE_DURATION_HOURS} часов.`,
        );
      }

      return {
        action: 'MUTE',
        muteDurationHours,
      };
    }

    return {
      action: 'BAN',
    };
  }

  private extractDirectIncomingMessageText(update: MaxUpdate): string {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return '';
    }

    const messageNode = this.extractRawMessageNode(raw) ?? raw;
    const body = this.asRecord(messageNode.body);
    const content = this.asRecord(messageNode.content);
    const payload = this.asRecord(messageNode.payload);
    const nestedMessage = this.asRecord(messageNode.message);
    const candidates = [
      messageNode.text,
      messageNode.caption,
      messageNode.message_text,
      messageNode.messageText,
      body?.text,
      body?.plain,
      content?.text,
      content?.caption,
      payload?.text,
      nestedMessage?.text,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    return '';
  }

  private extractForwardedModerationTargets(update: MaxUpdate): ForwardedModerationTarget[] {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return [];
    }

    const messageNode = this.extractRawMessageNode(raw) ?? raw;
    const body = this.asRecord(messageNode.body);
    const content = this.asRecord(messageNode.content);
    const payload = this.asRecord(messageNode.payload);
    const nestedMessage = this.asRecord(messageNode.message);
    const candidates = [
      messageNode.link,
      messageNode.forward,
      messageNode.forwarded_message,
      messageNode.forwardedMessage,
      body?.link,
      body?.forward,
      body?.forwarded_message,
      body?.forwardedMessage,
      content?.link,
      content?.forward,
      content?.forwarded_message,
      content?.forwardedMessage,
      payload?.link,
      payload?.forward,
      payload?.forwarded_message,
      payload?.forwardedMessage,
      nestedMessage?.link,
      nestedMessage?.forward,
      nestedMessage?.forwarded_message,
      nestedMessage?.forwardedMessage,
    ];

    const targets: ForwardedModerationTarget[] = [];
    for (const candidate of candidates) {
      this.collectForwardedModerationTargets(candidate, targets);
    }

    return this.dedupeForwardedModerationTargets(targets);
  }

  private collectForwardedModerationTargets(
    node: unknown,
    acc: ForwardedModerationTarget[],
    depth = 0,
  ): void {
    if (depth > MAX_FORWARD_SCAN_DEPTH || node === null || node === undefined) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectForwardedModerationTargets(item, acc, depth + 1);
      }
      return;
    }

    const row = this.asRecord(node);
    if (!row) {
      return;
    }

    const target = this.parseForwardedModerationTarget(row);
    if (target) {
      acc.push(target);
    }

    for (const value of Object.values(row)) {
      if (value && (typeof value === 'object' || Array.isArray(value))) {
        this.collectForwardedModerationTargets(value, acc, depth + 1);
      }
    }
  }

  private parseForwardedModerationTarget(
    row: Record<string, unknown>,
  ): ForwardedModerationTarget | null {
    const chatId = this.readChatIdFromEntity(row);
    const userId = this.readUserIdFromForwardedNode(row);
    if (!chatId || !userId) {
      return null;
    }

    return {
      chatId,
      chatTitle: this.readChatTitleFromEntity(row),
      userId,
      senderName: this.readSenderNameFromForwardedNode(row),
    };
  }

  private dedupeForwardedModerationTargets(
    targets: ForwardedModerationTarget[],
  ): ForwardedModerationTarget[] {
    const unique = new Map<string, ForwardedModerationTarget>();
    for (const target of targets) {
      const key = `${target.chatId}:${target.userId}`;
      if (!unique.has(key)) {
        unique.set(key, target);
      }
    }

    return [...unique.values()];
  }

  private readUserIdFromForwardedNode(node: Record<string, unknown>): string | null {
    const sender = this.asRecord(node.sender);
    const from = this.asRecord(node.from);
    const user = this.asRecord(node.user);
    const actor = this.asRecord(node.actor);
    const payloadSender = this.asRecord(this.asRecord(node.payload)?.sender);
    const candidates = [sender, from, user, actor, payloadSender].filter(
      (item): item is Record<string, unknown> => item !== null,
    );

    for (const candidate of candidates) {
      const userId = this.readUserIdFromEntity(candidate);
      if (userId) {
        return userId;
      }
    }

    return this.readUserIdFromEntity(node);
  }

  private readSenderNameFromForwardedNode(node: Record<string, unknown>): string | null {
    const sender = this.asRecord(node.sender);
    const from = this.asRecord(node.from);
    const user = this.asRecord(node.user);
    const actor = this.asRecord(node.actor);
    const payloadSender = this.asRecord(this.asRecord(node.payload)?.sender);
    const candidates = [sender, from, user, actor, payloadSender, node].filter(
      (item): item is Record<string, unknown> => item !== null,
    );

    for (const candidate of candidates) {
      const displayName = this.readDisplayNameFromEntity(candidate);
      if (displayName) {
        return displayName;
      }
    }

    return null;
  }

  private readChatIdFromEntity(node: Record<string, unknown>): string | null {
    const chat = this.asRecord(node.chat);
    const recipient = this.asRecord(node.recipient);
    const conversation = this.asRecord(node.conversation);
    const payloadChat = this.asRecord(this.asRecord(node.payload)?.chat);
    const candidates = [
      node.chatId,
      node.chat_id,
      chat?.chatId,
      chat?.chat_id,
      chat?.id,
      recipient?.chatId,
      recipient?.chat_id,
      recipient?.id,
      conversation?.chatId,
      conversation?.chat_id,
      conversation?.id,
      payloadChat?.chatId,
      payloadChat?.chat_id,
      payloadChat?.id,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' || typeof candidate === 'number') {
        const normalized = String(candidate).trim();
        if (normalized.length > 0) {
          return normalized;
        }
      }
    }

    return null;
  }

  private readChatTitleFromEntity(node: Record<string, unknown>): string | null {
    const chat = this.asRecord(node.chat);
    const recipient = this.asRecord(node.recipient);
    const candidates = [
      node.chatTitle,
      node.chat_title,
      node.chatName,
      node.chat_name,
      chat?.title,
      chat?.name,
      recipient?.title,
      recipient?.chat_title,
      recipient?.chatTitle,
      recipient?.name,
      recipient?.display_name,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    return null;
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
    settings: ChatSettings;
    text: string;
  }): Promise<void> {
    await this.sendBotMessageWithOptionalAutoDelete({
      chatId: params.chatId,
      text: params.text,
      deleteBotMessagesEnabled: params.settings.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: params.settings.deleteBotMessagesDelayMinutes,
      immediate: true,
    });
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
      await this.maxClient.deleteMessage(chatId, messageId);
      await this.prisma.moderationEvent.create({
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
            muteExpiresAt: mute.expiresAt.toISOString(),
            muteDurationHours: mute.durationHours,
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

    try {
      await this.maxClient.deleteMessage(chatId, messageId);
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
      await this.maxClient.kickMember(chatId, userId);
      await this.prisma.moderationEvent.create({
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
      await this.prisma.moderationEvent.create({
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
      kickedUserIds.add(userId);
      try {
        await this.maxClient.kickMember(chatId, userId);
        await this.prisma.moderationEvent.create({
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

    const skipGreetingDueToBurst = await this.shouldSkipGreetingForJoinBurst({
      chatId,
      joinedMembersCount: joinedMembers.length,
    });
    if (skipGreetingDueToBurst) {
      return;
    }

    const greetingMessageOptions = this.buildBotMessageOptions(
      chatId,
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
          deleteBotMessagesEnabled: shouldDeleteGreetingMessage,
          deleteBotMessagesDelayMinutes: greetingDeleteDelayMinutes,
        });

        await this.prisma.moderationEvent.create({
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

  private async shouldSkipGreetingForJoinBurst(params: {
    chatId: string;
    joinedMembersCount: number;
  }): Promise<boolean> {
    const { chatId, joinedMembersCount } = params;
    if (joinedMembersCount <= 0) {
      return false;
    }

    const getString = (this.redisCounter as Partial<RedisCounterService> | undefined)?.getString;
    const incrementByWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.incrementByWithTtl;
    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (
      typeof getString !== 'function' ||
      typeof incrementByWithTtl !== 'function' ||
      typeof setStringWithTtl !== 'function'
    ) {
      return false;
    }

    const autoDisabledKey = this.buildGreetingAutoDisabledRedisKey(chatId);
    try {
      const autoDisabledUntil = await getString.call(this.redisCounter, autoDisabledKey);
      if (typeof autoDisabledUntil === 'string' && autoDisabledUntil.trim().length > 0) {
        return true;
      }

      const joinedMembersTotal = await incrementByWithTtl.call(
        this.redisCounter,
        this.buildGreetingJoinBurstRedisKey(chatId),
        joinedMembersCount,
        GREETING_BURST_WINDOW_SEC,
      );
      if (joinedMembersTotal <= GREETING_BURST_LIMIT) {
        return false;
      }

      const disabledUntil = new Date(Date.now() + GREETING_AUTO_DISABLE_SEC * 1_000).toISOString();
      try {
        await setStringWithTtl.call(
          this.redisCounter,
          autoDisabledKey,
          disabledUntil,
          GREETING_AUTO_DISABLE_SEC,
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to persist greeting auto-disable state',
        );
      }

      this.logger.warn(
        {
          chatId,
          joinedMembersCount,
          joinedMembersTotal,
          disabledUntil,
        },
        'Temporarily disabled greeting messages due to join burst',
      );
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to evaluate greeting join burst state',
      );
      return false;
    }
  }

  private readDisplayNameFromEntity(node: Record<string, unknown>): string | null {
    const candidates = [
      node.display_name,
      node.displayName,
      node.name,
      node.username,
      node.first_name,
      node.firstName,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
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
    const isKnownSpammer = await this.isUserKnownGlobalSpammer(userId);
    if (!isKnownSpammer) {
      return false;
    }

    try {
      await this.maxClient.deleteMessage(chatId, messageId);
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

    const rows = await this.prisma.globalSpammer.findMany({
      where: {
        userId: {
          in: serviceMemberUserIds,
        },
      },
      select: {
        userId: true,
      },
    });
    if (rows.length === 0) {
      return [];
    }

    const exemptUserIds = await this.resolveGlobalSpammerExemptUserIds(
      rows.map((row) => row.userId),
      adminUserIds,
    );

    for (const row of rows) {
      if (exemptUserIds.has(row.userId)) {
        continue;
      }
      await this.kickAndLogKnownSpammerEvent({
        chatId,
        userId: row.userId,
        messageId,
        text,
        reason: 'Member joined via service event and exists in global spammer registry',
      });
    }

    return rows.map((row) => row.userId).filter((userId) => !exemptUserIds.has(userId));
  }

  private async kickAndLogKnownSpammerEvent(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    reason: string;
  }) {
    const { chatId, userId, messageId, text, reason } = params;
    try {
      await this.maxClient.kickMember(chatId, userId);
      await this.prisma.moderationEvent.create({
        data: {
          chatId,
          userId,
          messageId,
          eventType: EventType.MEMBER_ACTION,
          ruleCode: 'GLOBAL_SPAMMER_KICK',
          action: SanctionAction.KICK,
          maskedExcerpt: maskText(text),
          score: 0.95,
          operator: Operator.BOT,
          metadata: {
            reason,
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
        'Failed to kick known global spammer',
      );
    }
  }

  private async trackAndRegisterGlobalSpammer(params: {
    chatId: string;
    userId: string;
    userLabel: string;
    messageId: string;
    text: string;
    deleteSpammersEnabled: boolean;
    exemptFromEnforcement: boolean;
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
      userLabel,
      messageId,
      text,
      deleteSpammersEnabled,
      exemptFromEnforcement,
    } = params;

    try {
      const uniqueChatsState = await this.redisCounter.addToSetWithTtl(
        this.buildGlobalSpammerAnyRedisKey(userId),
        chatId,
        GLOBAL_SPAMMER_REDIS_TTL_SEC,
      );

      if (!uniqueChatsState.added) {
        return baseResult;
      }

      if (uniqueChatsState.size >= GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS) {
        await this.upsertGlobalSpammerEntry({
          userId,
          sourceChatId: chatId,
          reason: 'HIGH_FANOUT_6_CHATS_2M',
          evidence: {
            uniqueChats: uniqueChatsState.size,
            windowSec: GLOBAL_SPAMMER_WINDOW_SEC,
          },
        });
        if (deleteSpammersEnabled && !exemptFromEnforcement) {
          await this.deleteAndKickDetectedGlobalSpammer({
            chatId,
            userId,
            messageId,
            text,
            reason: 'Detected in 6 unique chats within 2 minutes',
          });
          return {
            handled: true,
            skipKnownSpammerCheck: true,
          };
        }

        return {
          handled: false,
          skipKnownSpammerCheck: false,
        };
      }

      if (uniqueChatsState.size < GLOBAL_SPAMMER_WARN_MIN_CHATS) {
        return baseResult;
      }

      const warningCount = await this.redisCounter.incrementWithTtl(
        this.buildGlobalSpammerWarnRedisKey(userId),
        GLOBAL_SPAMMER_WARN_COUNTER_TTL_SEC,
      );
      if (deleteSpammersEnabled) {
        await this.sendGlobalSpammerFanoutWarning({
          chatId,
          userLabel,
          warningCount,
        });
      }

      if (warningCount >= GLOBAL_SPAMMER_WARN_THRESHOLD) {
        await this.upsertGlobalSpammerEntry({
          userId,
          sourceChatId: chatId,
          reason: 'HIGH_FANOUT_5_CHATS_WARN_THRESHOLD',
          evidence: {
            uniqueChats: uniqueChatsState.size,
            windowSec: GLOBAL_SPAMMER_WINDOW_SEC,
            warningCount,
            warningThreshold: GLOBAL_SPAMMER_WARN_THRESHOLD,
          },
        });
      }

      return {
        handled: false,
        skipKnownSpammerCheck: deleteSpammersEnabled,
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

  private async sendGlobalSpammerFanoutWarning(params: {
    chatId: string;
    userLabel: string;
    warningCount: number;
  }): Promise<void> {
    const { chatId, userLabel, warningCount } = params;
    const safeCount = Math.max(1, Math.min(warningCount, GLOBAL_SPAMMER_WARN_THRESHOLD));
    const warningText = `${userLabel}, похоже на массовую рассылку по чатам. Предупреждение ${safeCount}/${GLOBAL_SPAMMER_WARN_THRESHOLD}.`;
    try {
      await this.maxClient.sendMessage(chatId, warningText, { textFormat: 'markdown' });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          warningCount,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to send global spammer fanout warning',
      );
    }
  }

  private async deleteAndKickDetectedGlobalSpammer(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    reason: string;
  }): Promise<void> {
    const { chatId, userId, messageId, text, reason } = params;
    try {
      await this.maxClient.deleteMessage(chatId, messageId);
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
    const messageNode = rawRecord ? (this.extractRawMessageNode(rawRecord) ?? rawRecord) : null;
    const forwardedNodes = messageNode ? this.collectForwardedNodes(messageNode) : [];

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

  private buildGlobalSpammerWarnRedisKey(userId: string): string {
    return `global-spammer:warn:v1:${userId}`;
  }

  private buildGreetingJoinBurstRedisKey(chatId: string): string {
    return `greeting-burst:v1:${chatId}`;
  }

  private buildGreetingAutoDisabledRedisKey(chatId: string): string {
    return `greeting-disabled:v1:${chatId}`;
  }

  private async resolveGlobalSpammerExemptUserIds(
    userIds: readonly string[],
    adminUserIds: readonly string[] | undefined,
  ): Promise<Set<string>> {
    if (!Array.isArray(adminUserIds) || adminUserIds.length === 0 || userIds.length === 0) {
      return new Set<string>();
    }

    const adminUserVariants = new Set<string>();
    for (const adminUserId of adminUserIds) {
      for (const variant of this.buildUserIdVariants(adminUserId)) {
        adminUserVariants.add(variant);
      }
    }
    if (adminUserVariants.size === 0) {
      return new Set<string>();
    }

    const userIdVariants = new Set<string>();
    const variantToUserIds = new Map<string, Set<string>>();
    for (const rawUserId of userIds) {
      const normalizedUserId = rawUserId.trim();
      if (!normalizedUserId) {
        continue;
      }

      for (const variant of this.buildUserIdVariants(normalizedUserId)) {
        userIdVariants.add(variant);
        const matchingUserIds = variantToUserIds.get(variant) ?? new Set<string>();
        matchingUserIds.add(normalizedUserId);
        variantToUserIds.set(variant, matchingUserIds);
      }
    }

    if (userIdVariants.size === 0) {
      return new Set<string>();
    }

    const prismaWithAdminGlobalSpammerExemption = this.prisma as unknown as {
      adminGlobalSpammerExemption?: {
        findMany?: (args: {
          where: {
            adminUserId: { in: string[] };
            userId: { in: string[] };
          };
          select: { userId: true };
        }) => Promise<Array<{ userId: string }>>;
      };
    };
    const adminGlobalSpammerExemptionModel =
      prismaWithAdminGlobalSpammerExemption.adminGlobalSpammerExemption ?? {};
    if (typeof adminGlobalSpammerExemptionModel.findMany !== 'function') {
      return new Set<string>();
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
      },
    });

    const exemptUserIds = new Set<string>();
    for (const row of rows) {
      const matchingUserIds = variantToUserIds.get(row.userId);
      if (!matchingUserIds) {
        continue;
      }

      for (const matchingUserId of matchingUserIds) {
        exemptUserIds.add(matchingUserId);
      }
    }

    return exemptUserIds;
  }

  private async isUserKnownGlobalSpammer(userId: string): Promise<boolean> {
    const row = await this.prisma.globalSpammer.findUnique({
      where: {
        userId,
      },
      select: {
        userId: true,
      },
    });
    return Boolean(row);
  }

  private async upsertGlobalSpammerEntry(params: {
    userId: string;
    sourceChatId: string;
    reason: string;
    evidence?: Prisma.InputJsonValue;
  }) {
    const { userId, sourceChatId, reason, evidence } = params;

    try {
      await this.prisma.globalSpammer.upsert({
        where: {
          userId,
        },
        create: {
          userId,
          lastReason: reason,
          lastChatId: sourceChatId,
          lastEvidence: evidence ?? Prisma.JsonNull,
        },
        update: {
          detectionsCount: {
            increment: 1,
          },
          lastReason: reason,
          lastChatId: sourceChatId,
          lastEvidence: evidence ?? Prisma.JsonNull,
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

  private async processNightModeAnnouncements() {
    if (
      this.nightModeAnnounceInFlight ||
      !this.backgroundTasksEnabled ||
      !roleRunsModeration(getAppRole())
    ) {
      return;
    }
    if (await this.shouldPauseBackgroundWork('night-mode-announcements')) {
      return;
    }

    this.nightModeAnnounceInFlight = true;
    try {
      const nightModeChats = await this.prisma.chatSettings.findMany({
        where: {
          nightModeEnabled: true,
        },
        select: {
          chatId: true,
          botSpeechStyle: true,
          deleteBotMessagesEnabled: true,
          deleteBotMessagesDelayMinutes: true,
          nightModeStartTimeMinutes: true,
          nightModeEndTimeMinutes: true,
          nightModeTimezone: true,
          nightModeBotMessageEnabled: true,
          nightModeBotMessageText: true,
          commentsEnabled: true,
          nightModeCommentsEnabled: true,
          nightModeOpenMessageEnabled: true,
          nightModeOpenMessageText: true,
          nightModeBotButtonEnabled: true,
          nightModeBotButtonUrl: true,
          nightModeBotButtonText: true,
          nightModeRulesButtonEnabled: true,
          nightModeForceCloseEnabled: true,
          nightModeForceCloseForever: true,
          nightModeForceCloseUntil: true,
        },
      });
      const rulesButtonReferences = await this.loadRulesButtonReferenceMap(
        nightModeChats.map((settings) => settings.chatId),
      );

      for (const [index, settings] of nightModeChats.entries()) {
        if (index > 0) {
          await this.sleep(this.nightModeScheduledNoticeSpacingMs);
        }

        const startMinutes = this.normalizeDayMinutes(settings.nightModeStartTimeMinutes, 23 * 60);
        const endMinutes = this.normalizeDayMinutes(settings.nightModeEndTimeMinutes, 8 * 60);
        const timezone = this.normalizeNightModeTimezone(settings.nightModeTimezone);
        const rulesButtonReference = rulesButtonReferences.get(settings.chatId) ?? null;
        const nightModeActiveNow = this.isNightModeActiveNow({
          nightModeEnabled: true,
          nightModeStartTimeMinutes: startMinutes,
          nightModeEndTimeMinutes: endMinutes,
          nightModeTimezone: timezone,
        });
        const manualGroupCloseActiveNow = this.isNightModeForceCloseActiveNow({
          nightModeForceCloseEnabled: settings.nightModeForceCloseEnabled,
          nightModeForceCloseForever: settings.nightModeForceCloseForever,
          nightModeForceCloseUntil: settings.nightModeForceCloseUntil,
        });
        const activeSessionKey = this.buildNightModeSessionKey(
          startMinutes,
          endMinutes,
          timezone,
          'current',
        );
        if (await this.readNightModeDeliveryTerminalMarker(settings.chatId)) {
          continue;
        }

        if (nightModeActiveNow) {
          await this.writeNightModeSessionMarker(
            this.buildNightModeSessionMarkerKey(settings.chatId, activeSessionKey),
          );
        }

        if (
          settings.nightModeBotMessageEnabled &&
          nightModeActiveNow &&
          !manualGroupCloseActiveNow
        ) {
          try {
            await this.sendNightModeClosedNoticeIfNeeded({
              chatId: settings.chatId,
              startMinutes,
              endMinutes,
              timezone,
              botSpeechStyle: settings.botSpeechStyle,
              nightModeBotMessageText: settings.nightModeBotMessageText,
              commentsEnabled: settings.commentsEnabled,
              nightModeCommentsEnabled: settings.nightModeCommentsEnabled,
              nightModeBotButtonEnabled: settings.nightModeBotButtonEnabled,
              nightModeBotButtonUrl: settings.nightModeBotButtonUrl,
              nightModeBotButtonText: settings.nightModeBotButtonText,
              nightModeRulesButtonEnabled: settings.nightModeRulesButtonEnabled,
              rulesPublishedUrl: rulesButtonReference?.publishedUrl ?? null,
              rulesPublishedMessageId: rulesButtonReference?.publishedMessageId ?? null,
              reason: 'Night mode notice sent by schedule',
            });
          } catch (error: unknown) {
            this.logger.warn(
              {
                chatId: settings.chatId,
                error: error instanceof Error ? error.message : 'Unknown error',
              },
              'Failed to send scheduled night mode notice',
            );
          }
        }

        const reopenSessionKey = this.resolveNightModeReopenSessionKey({
          startMinutes,
          endMinutes,
          timezone,
          nightModeActiveNow,
        });
        if (!reopenSessionKey) {
          continue;
        }

        if (manualGroupCloseActiveNow) {
          continue;
        }

        const reopenSessionObserved = await this.readNightModeSessionMarker(
          this.buildNightModeSessionMarkerKey(settings.chatId, reopenSessionKey),
        );

        const reopenAlreadyProcessed = await this.wasNightModeScheduledNoticeProcessed(
          settings.chatId,
          reopenSessionKey,
          NIGHT_MODE_OPEN_NOTICE_RULE_CODE,
        );
        if (reopenAlreadyProcessed) {
          continue;
        }

        const closedNoticeSent = await this.wasNightModeScheduledNoticeProcessed(
          settings.chatId,
          reopenSessionKey,
          NIGHT_MODE_NOTICE_RULE_CODE,
        );
        const canSendReopenNotice =
          closedNoticeSent || (!settings.nightModeBotMessageEnabled && reopenSessionObserved);
        if (!canSendReopenNotice) {
          continue;
        }

        try {
          await this.sendNightModeOpenNoticeIfNeeded({
            chatId: settings.chatId,
            nightSessionKey: reopenSessionKey,
            startMinutes,
            endMinutes,
            timezone,
            botSpeechStyle: settings.botSpeechStyle,
            nightModeOpenMessageEnabled: settings.nightModeOpenMessageEnabled,
            nightModeOpenMessageText: settings.nightModeOpenMessageText,
          });
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId: settings.chatId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed to process scheduled night mode reopen notice',
          );
        }
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to process scheduled night mode notices',
      );
    } finally {
      this.nightModeAnnounceInFlight = false;
    }
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
    botSpeechStyle: BotSpeechStyle | null;
    nightModeBotMessageEnabled: boolean;
    nightModeBotMessageText: string;
    commentsEnabled: boolean;
    nightModeCommentsEnabled: boolean;
    nightModeBotButtonEnabled: boolean;
    nightModeBotButtonUrl: string;
    nightModeBotButtonText: string;
    nightModeRulesButtonEnabled: boolean;
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
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
      botSpeechStyle,
      nightModeBotMessageEnabled,
      nightModeBotMessageText,
      commentsEnabled,
      nightModeCommentsEnabled,
      nightModeBotButtonEnabled,
      nightModeBotButtonUrl,
      nightModeBotButtonText,
      nightModeRulesButtonEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
    } = params;
    const startMinutes = this.normalizeDayMinutes(nightModeStartTimeMinutes, 23 * 60);
    const endMinutes = this.normalizeDayMinutes(nightModeEndTimeMinutes, 8 * 60);
    const timezone = this.normalizeNightModeTimezone(nightModeTimezone);
    await this.writeNightModeSessionMarker(
      this.buildNightModeSessionMarkerKey(
        chatId,
        this.buildNightModeSessionKey(startMinutes, endMinutes, timezone, 'current'),
      ),
    );
    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;

    if (nightModeBotMessageEnabled) {
      try {
        await this.sendNightModeClosedNoticeIfNeeded({
          chatId,
          startMinutes,
          endMinutes,
          timezone,
          botSpeechStyle,
          nightModeBotMessageText,
          commentsEnabled,
          nightModeCommentsEnabled,
          nightModeBotButtonEnabled,
          nightModeBotButtonUrl,
          nightModeBotButtonText,
          nightModeRulesButtonEnabled,
          rulesPublishedUrl,
          rulesPublishedMessageId,
          sessionMoment: 'current',
          reason: 'Night mode notice sent before blocked message',
          sourceMessageId: messageId,
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send night mode notice before blocked message',
        );
      }
    }

    if (canDeleteMessage) {
      try {
        await this.maxClient.deleteMessage(chatId, messageId);
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
        await this.prisma.moderationEvent.create({
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
      await this.maxClient.notifyModerators(
        chatId,
        `Сообщение от ${userId} попало в закрытие чата на ночь, но старше 24 часов и не может быть удалено`,
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
        await this.maxClient.deleteMessage(chatId, messageId);
        await this.prisma.moderationEvent.create({
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
      await this.maxClient.notifyModerators(
        chatId,
        `Сообщение от ${userId} попало в ручное закрытие группы, но старше 24 часов и не может быть удалено`,
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
    settings: Pick<
      ChatSettings,
      | 'requiredSubscriptionEnabled'
      | 'requiredSubscriptionChannelIds'
      | 'requiredSubscriptionBotMessageEnabled'
      | 'requiredSubscriptionBotMessageText'
      | 'requiredSubscriptionWarnEnabled'
      | 'requiredSubscriptionWarnMessageText'
      | 'requiredSubscriptionBanEnabled'
      | 'requiredSubscriptionMuteEnabled'
      | 'requiredSubscriptionMuteDurationHours'
      | 'botSpeechStyle'
      | 'rulesAttachViolationsEnabled'
      | 'deleteBotMessagesEnabled'
      | 'deleteBotMessagesDelayMinutes'
      | 'muteDurationHours'
    >;
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
  }): Promise<boolean> {
    if (!params.settings.requiredSubscriptionEnabled) {
      return false;
    }

    const requiredChannelIds = this.readRequiredSubscriptionChannelIds(
      params.settings.requiredSubscriptionChannelIds,
    );
    if (requiredChannelIds.length === 0) {
      return false;
    }

    const membership = await this.resolveRequiredSubscriptionMembership(
      params.chatId,
      params.userId,
      requiredChannelIds,
    );
    if (!membership || membership.missingChannelIds.length === 0) {
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

    await this.maxClient.deleteMessage(params.chatId, params.messageId);

    const missingChannels = await this.resolveRequiredSubscriptionChannels(
      membership.missingChannelIds,
      { allowRemoteFetch: !params.degradeMode },
    );
    const missingChannelTitles = missingChannels.map((channel) => channel.title);

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
    const isFirstRequiredSubscriptionViolation = requiredSubscriptionViolationCount24h === 1;

    await this.prisma.moderationEvent.create({
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
          requiredChannelIds,
          missingChannelIds: membership.missingChannelIds,
          missingChannelTitles,
        },
      },
    });

    const requiredSubscriptionMessageOptions =
      this.buildRequiredSubscriptionMessageOptions(
        missingChannels,
        params.settings.rulesAttachViolationsEnabled,
        params.rulesPublishedUrl,
        params.rulesPublishedMessageId,
      ) ?? undefined;

    const sendRequiredSubscriptionBotMessage = async (textValue: string) =>
      this.sendBotMessageWithOptionalAutoDelete({
        chatId: params.chatId,
        text: textValue,
        messageOptions: requiredSubscriptionMessageOptions,
        deleteBotMessagesEnabled: params.settings.deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes: params.settings.deleteBotMessagesDelayMinutes,
      });

    if (action === SanctionAction.NONE) {
      if (
        isFirstRequiredSubscriptionViolation &&
        params.settings.requiredSubscriptionBotMessageEnabled
      ) {
        const noticeOnCooldown = await this.hasRequiredSubscriptionNoticeCooldown(
          params.chatId,
          params.userId,
        );
        if (!noticeOnCooldown) {
          try {
            await sendRequiredSubscriptionBotMessage(
              this.buildRequiredSubscriptionExplanation(
                params.userLabel,
                canDeleteMessage,
                missingChannelTitles,
                params.settings.requiredSubscriptionBotMessageText,
                params.settings.botSpeechStyle,
              ),
            );
            await this.markRequiredSubscriptionNoticeSent(params.chatId, params.userId);
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
    } else if (action === SanctionAction.WARN) {
      try {
        await sendRequiredSubscriptionBotMessage(
          this.buildRequiredSubscriptionWarnExplanation(
            params.userLabel,
            missingChannelTitles,
            params.settings.requiredSubscriptionWarnMessageText,
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
          'Failed to send required subscription warning message',
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
        muteDurationHours: params.settings.requiredSubscriptionMuteDurationHours,
        deleteBotMessagesEnabled: params.settings.deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes: params.settings.deleteBotMessagesDelayMinutes,
        botMessageOptions: requiredSubscriptionMessageOptions,
        sanctionNoticeText:
          action === SanctionAction.BAN
            ? this.buildRequiredSubscriptionBanExplanation(
                params.userLabel,
                missingChannelTitles,
                params.settings.requiredSubscriptionMuteDurationHours,
                params.settings.botSpeechStyle,
              )
            : undefined,
        botSpeechStyle: params.settings.botSpeechStyle,
        trackAsGlobalSpammer: false,
      });

      if (action === SanctionAction.MUTE) {
        try {
          await sendRequiredSubscriptionBotMessage(
            this.buildRequiredSubscriptionMuteExplanation(
              params.userLabel,
              missingChannelTitles,
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

    await this.prisma.moderationEvent.create({
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
          requiredChannelIds,
          missingChannelIds: membership.missingChannelIds,
          missingChannelTitles,
          requiredSubscriptionViolationCount24h,
          requiredSubscriptionEscalationWindowHours: REQUIRED_SUBSCRIPTION_ESCALATION_WINDOW_HOURS,
        },
      },
    });

    return true;
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

  private async resolveRequiredSubscriptionMembership(
    chatId: string,
    userId: string,
    requiredChannelIds: readonly string[],
  ): Promise<{ missingChannelIds: string[] } | null> {
    const membershipChecks = await this.mapWithConcurrency(
      requiredChannelIds,
      this.requiredSubscriptionLookupConcurrency,
      async (channelId) => ({
        channelId,
        membership: await this.getRequiredSubscriptionMembership(channelId, userId),
      }),
    );
    const failedChannelIds = membershipChecks
      .filter((item) => item.membership === null)
      .map((item) => item.channelId);
    if (failedChannelIds.length > 0) {
      this.logger.warn(
        {
          chatId,
          userId,
          failedChannelIds,
          checkedChannelCount: requiredChannelIds.length,
        },
        'Required subscription checks failed; skipping enforcement',
      );
      return null;
    }

    const missingChannelIds = membershipChecks
      .filter((item) => item.membership === false)
      .map((item) => item.channelId);

    return { missingChannelIds };
  }

  private async getRequiredSubscriptionMembership(
    channelId: string,
    userId: string,
  ): Promise<boolean | null> {
    if (this.membershipLookupService) {
      return this.membershipLookupService.getMembership(
        channelId,
        userId,
        'moderation_required_subscription',
      );
    }

    const cacheKey = this.buildRequiredSubscriptionMembershipCacheKey(channelId, userId);
    const now = Date.now();
    const memoryCached = this.requiredSubscriptionMembershipCache.get(cacheKey);
    if (memoryCached && memoryCached.expiresAt > now) {
      return memoryCached.isMember;
    }

    const cached = await this.redisCounter?.getString(cacheKey);
    if (cached === '1') {
      this.requiredSubscriptionMembershipCache.set(cacheKey, {
        isMember: true,
        expiresAt: now + REQUIRED_SUBSCRIPTION_MEMBER_PRESENT_TTL_SEC * 1_000,
      });
      return true;
    }
    if (cached === '0') {
      this.requiredSubscriptionMembershipCache.set(cacheKey, {
        isMember: false,
        expiresAt: now + REQUIRED_SUBSCRIPTION_MEMBER_MISSING_TTL_SEC * 1_000,
      });
      return false;
    }

    const backoffUntilMs = this.requiredSubscriptionMembershipBackoffUntilMs.get(cacheKey) ?? 0;
    if (backoffUntilMs > now) {
      return memoryCached?.isMember ?? null;
    }

    const inFlight = this.requiredSubscriptionMembershipInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const lookupPromise = (async () => {
      try {
        const isMember = await this.maxClient.hasChatMember(channelId, userId, {
          trafficClass: 'critical',
          timeoutMs: 2_000,
        });
        const ttlSec = isMember
          ? REQUIRED_SUBSCRIPTION_MEMBER_PRESENT_TTL_SEC
          : REQUIRED_SUBSCRIPTION_MEMBER_MISSING_TTL_SEC;
        this.requiredSubscriptionMembershipCache.set(cacheKey, {
          isMember,
          expiresAt: Date.now() + ttlSec * 1_000,
        });
        this.requiredSubscriptionMembershipBackoffUntilMs.delete(cacheKey);
        await this.redisCounter?.setStringWithTtl(cacheKey, isMember ? '1' : '0', ttlSec);
        return isMember;
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
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to resolve required subscription membership',
        );
        return memoryCached?.isMember ?? null;
      }
    })();
    let trackedLookupPromise!: Promise<boolean | null>;
    trackedLookupPromise = lookupPromise.finally(() => {
      if (this.requiredSubscriptionMembershipInFlight.get(cacheKey) === trackedLookupPromise) {
        this.requiredSubscriptionMembershipInFlight.delete(cacheKey);
      }
    });

    this.requiredSubscriptionMembershipInFlight.set(cacheKey, trackedLookupPromise);
    return trackedLookupPromise;
  }

  private async resolveRequiredSubscriptionChannels(
    channelIds: readonly string[],
    options: {
      allowRemoteFetch?: boolean;
    } = {},
  ): Promise<Array<{ id: string; title: string; link: string | null }>> {
    const allowRemoteFetch = options.allowRemoteFetch === true;
    return this.mapWithConcurrency(channelIds, 2, async (channelId) => {
      const cached = await this.chatContextCache?.getManagedEntityHeader(channelId, 'channel');
      const cachedLink = cached?.link?.trim() || null;
      const cachedTitle = cached?.title?.trim() || '';
      if (cached && cachedLink) {
        return {
          id: channelId,
          title: cachedTitle || `Канал ${channelId}`,
          link: cachedLink,
        };
      }

      if (!allowRemoteFetch) {
        return {
          id: channelId,
          title: cachedTitle || `Канал ${channelId}`,
          link: cachedLink,
        };
      }

      try {
        const snapshot = await this.maxClient.getChatSnapshot(channelId, {
          trafficClass: 'interactive',
          timeoutMs: 2_500,
        });
        const title = snapshot.title?.trim() || `Канал ${channelId}`;
        const link = snapshot.link?.trim() || null;
        await this.chatContextCache?.setManagedEntityHeader({
          id: channelId,
          title,
          entityType: 'channel',
          link,
          participantsCount: snapshot.participantsCount,
        });
        return {
          id: channelId,
          title,
          link,
        };
      } catch (error: unknown) {
        this.logger.warn(
          {
            channelId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to resolve required subscription channel metadata',
        );
        return {
          id: channelId,
          title: cachedTitle || `Канал ${channelId}`,
          link: null,
        };
      }
    });
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

  private buildRequiredSubscriptionMembershipCacheKey(channelId: string, userId: string): string {
    return `required-subscription:member:v1:${channelId}:${userId}`;
  }

  private buildRequiredSubscriptionNoticeCooldownKey(chatId: string, userId: string): string {
    return `required-subscription:notice:v1:${chatId}:${userId}`;
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

  private isNightModeStartMomentNow(startMinutes: number, timezone: string): boolean {
    const currentMinutes = this.getCurrentMinutesInTimeZone(timezone);
    return currentMinutes !== null && currentMinutes === startMinutes;
  }

  private isNightModeEndMomentNow(endMinutes: number, timezone: string): boolean {
    const currentMinutes = this.getCurrentMinutesInTimeZone(timezone);
    return currentMinutes !== null && currentMinutes === endMinutes;
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

    await this.maxClient.leaveCurrentChat(chatId);
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
        await this.sendPrivateMenu(chatId, PRIVATE_MENU_PROMPT_TEXT);
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          updateId: update.updateId,
          error: error instanceof Error ? error.message : 'Unknown error',
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

    await this.sendPrivateMenu(chatId, PRIVATE_MENU_PROMPT_TEXT);
  }

  private buildPrivateCallbackNotification(command: PrivateControlCommand | null): string {
    if (command === 'chats') {
      return 'Собираю список чатов';
    }
    if (command === 'channels') {
      return 'Собираю список каналов';
    }
    if (command === 'help') {
      return 'Открываю подсказки';
    }
    return 'Открываю меню';
  }

  private async answerCallbackSafe(callbackId: string, notification: string): Promise<void> {
    try {
      await this.maxClient.answerCallback(callbackId, notification);
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

  private async handleManagedPollCallback(
    update: MaxUpdate,
    pollCallback: {
      pollId: string;
      version: number;
      optionIndex: number;
    },
    callbackId: string | null,
  ): Promise<void> {
    const message = update.message;
    const chatId = message?.chatId?.trim() ?? '';
    const sourceMessageId = message?.messageId?.trim() ?? '';
    const voterUserId = this.extractCallbackUserId(update);
    if (!chatId || !sourceMessageId || !voterUserId) {
      if (callbackId) {
        await this.answerCallbackSafe(callbackId, 'Опрос уже неактуален');
      }
      return;
    }

    const poll = await this.prisma.managedPoll.findUnique({
      where: { id: pollCallback.pollId },
      select: {
        id: true,
        chatId: true,
        question: true,
        options: true,
        status: true,
        activeVersion: true,
        publishedMessageId: true,
      },
    });

    if (!poll || poll.chatId !== chatId) {
      if (callbackId) {
        await this.answerCallbackSafe(callbackId, 'Опрос уже неактуален');
      }
      return;
    }

    if (poll.status !== PrismaManagedPollStatus.ACTIVE) {
      if (callbackId) {
        await this.answerCallbackSafe(callbackId, 'Опрос закрыт');
      }
      return;
    }

    if (
      poll.activeVersion !== pollCallback.version ||
      (poll.publishedMessageId?.trim() ?? '') !== sourceMessageId
    ) {
      if (callbackId) {
        await this.answerCallbackSafe(callbackId, 'Опрос уже неактуален');
      }
      return;
    }

    const normalizedDraft = normalizeManagedPollDraft(
      poll.question,
      this.readManagedPollOptions(poll.options),
    );
    if (
      pollCallback.optionIndex < 0 ||
      pollCallback.optionIndex >= normalizedDraft.options.length ||
      !normalizedDraft.options[pollCallback.optionIndex]
    ) {
      if (callbackId) {
        await this.answerCallbackSafe(callbackId, 'Опрос уже неактуален');
      }
      return;
    }

    const existingVote = await this.prisma.managedPollVote.findUnique({
      where: {
        pollId_pollVersion_userId: {
          pollId: poll.id,
          pollVersion: poll.activeVersion,
          userId: voterUserId,
        },
      },
      select: {
        optionIndex: true,
      },
    });

    const notification =
      existingVote && existingVote.optionIndex === pollCallback.optionIndex
        ? 'Вы уже выбрали этот вариант'
        : 'Голос учтён';

    if (existingVote && existingVote.optionIndex === pollCallback.optionIndex) {
      if (callbackId) {
        await this.answerCallbackSafe(callbackId, notification);
      }
      return;
    }

    await this.prisma.managedPollVote.upsert({
      where: {
        pollId_pollVersion_userId: {
          pollId: poll.id,
          pollVersion: poll.activeVersion,
          userId: voterUserId,
        },
      },
      create: {
        pollId: poll.id,
        pollVersion: poll.activeVersion,
        userId: voterUserId,
        optionIndex: pollCallback.optionIndex,
      },
      update: {
        optionIndex: pollCallback.optionIndex,
      },
    });

    const voteCounts = await this.loadManagedPollVoteCounts(
      poll.id,
      poll.activeVersion,
      normalizedDraft.options.length,
    );
    const summary = buildManagedPollOptionSummaries(normalizedDraft.options, voteCounts);
    const text = buildManagedPollMessageText(
      normalizedDraft.question,
      summary.optionResults,
      'ACTIVE',
    );
    const editOptions: Pick<MaxSendMessageOptions, 'buttons' | 'debugContext'> = {
      buttons: buildManagedPollButtons(
        poll.id,
        poll.activeVersion,
        normalizedDraft.options,
        summary.optionResults,
      ),
      debugContext: {
        screen: 'managed-poll',
        action: 'vote',
      },
    };

    if (callbackId) {
      await this.maxClient.answerCallback(callbackId, notification, {
        text,
        options: editOptions,
      });
      return;
    }

    await this.maxClient.editMessageInlineKeyboard(chatId, sourceMessageId, text, editOptions);
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
      await this.sendPrivateMenu(chatId, PRIVATE_HELP_TEXT);
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

    await this.sendPrivateMenu(chatId, PRIVATE_MENU_PROMPT_TEXT);
  }

  private async sendPrivateEntityList(
    chatId: string,
    entityType: 'chat' | 'channel',
  ): Promise<void> {
    try {
      const chats = await this.maxClient.listBotChats();
      const entities = chats.filter((chat) => {
        const numericChatId = this.parseChatIdAsBigInt(chat.chatId);
        const isGroup = numericChatId !== null && numericChatId < 0n;
        return entityType === 'channel' ? chat.entityType === 'channel' : isGroup;
      });

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
        const title = (chat.title ?? `Чат ${chat.chatId}`).replace(/\s+/g, ' ').trim();
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

  private async sendPrivateMenu(chatId: string, text: string): Promise<void> {
    await this.maxClient.sendMessage(chatId, text, this.buildPrivateMenuOptions());
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
        {
          type: 'callback',
          text: 'Помощь',
          payload: PRIVATE_MENU_CALLBACK_HELP,
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
      url: fallbackWebAppUrl ?? 'https://maxim.play-team.ru/app/',
    };
  }

  private buildMiniappRouteLaunchUrl(route: string): string | null {
    return this.buildMiniappStartUrl(this.buildMiniappRouteStartParam(route));
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

  private resolveBotContactId(): string | null {
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
    },
  ): Promise<ChatAdminCheckResult> {
    const localIsAdmin = this.isSenderChatAdmin(localAdminUserIds, userId);
    if (localIsAdmin) {
      return { isAdmin: true, source: 'local' };
    }

    const localAdminsKnown = Array.isArray(localAdminUserIds) && localAdminUserIds.length > 0;
    if (options?.allowRemoteLookup === false) {
      return { isAdmin: false, source: 'local_fallback' };
    }
    if (options?.skipRemoteLookupWhenLocalAdminsKnown && localAdminsKnown) {
      return { isAdmin: false, source: 'local_fallback' };
    }

    const remoteAdminAccess = await this.getRemoteChatAdminAccess(chatId, userId);
    if (remoteAdminAccess) {
      if (remoteAdminAccess === 'granted') {
        return { isAdmin: true, source: 'remote' };
      }
      return { isAdmin: false, source: 'remote' };
    }

    // Fallback for temporary MAX API issues: keep local allowlist behavior.
    return {
      isAdmin: localIsAdmin,
      source: 'local_fallback',
    };
  }

  private isSenderChatAdmin(adminUserIds: string[] | undefined, userId: string): boolean {
    if (!Array.isArray(adminUserIds) || adminUserIds.length === 0) {
      return false;
    }

    const senderVariants = this.buildUserIdVariants(userId);
    if (senderVariants.size === 0) {
      return false;
    }

    for (const adminUserId of adminUserIds) {
      for (const variant of this.buildUserIdVariants(adminUserId)) {
        if (senderVariants.has(variant)) {
          return true;
        }
      }
    }

    return false;
  }

  private buildChatAdminAccessLookupKey(chatId: string, userId: string): string {
    const normalizedUserId =
      [...this.buildUserIdVariants(userId)].sort((left, right) => {
        if (left.length !== right.length) {
          return left.length - right.length;
        }
        return left.localeCompare(right);
      })[0] ?? userId.trim().toLowerCase();

    return `${chatId}:${normalizedUserId}`;
  }

  private async getRemoteChatAdminAccess(
    chatId: string,
    userId: string,
  ): Promise<RemoteChatAdminAccessState | null> {
    const cacheKey = this.buildChatAdminAccessLookupKey(chatId, userId);
    const now = Date.now();
    const cached = this.chatAdminAccessCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.state;
    }
    const staleCached = cached?.state ?? null;

    const cachedFromSharedStore = await this.readChatAdminAccessFromSharedCache(
      chatId,
      userId,
      now,
    );
    if (cachedFromSharedStore) {
      this.chatAdminLookupBackoffUntilMs.delete(cacheKey);
      return cachedFromSharedStore;
    }

    const backoffUntilMs = this.chatAdminLookupBackoffUntilMs.get(cacheKey) ?? 0;
    if (backoffUntilMs > now) {
      return staleCached;
    }

    const chatBackoffUntilMs = this.chatAdminChatBackoffUntilMs.get(chatId) ?? 0;
    if (chatBackoffUntilMs > now) {
      return staleCached;
    }

    const inFlight = this.chatAdminLookupInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    return this.enqueueChatAdminLookupBatch(chatId, userId, cacheKey, staleCached);
  }

  private enqueueChatAdminLookupBatch(
    chatId: string,
    userId: string,
    cacheKey: string,
    staleCached: RemoteChatAdminAccessState | null,
  ): Promise<RemoteChatAdminAccessState | null> {
    let batch = this.pendingChatAdminLookupBatches.get(chatId);
    if (!batch) {
      batch = {
        chatId,
        lookups: new Map(),
        scheduled: false,
      };
      this.pendingChatAdminLookupBatches.set(chatId, batch);
    }

    const lookupPromise = new Promise<RemoteChatAdminAccessState | null>((resolve) => {
      batch!.lookups.set(cacheKey, {
        cacheKey,
        userId,
        staleCached,
        resolve,
      });
    });

    let trackedLookupPromise!: Promise<RemoteChatAdminAccessState | null>;
    trackedLookupPromise = lookupPromise.finally(() => {
      if (this.chatAdminLookupInFlight.get(cacheKey) === trackedLookupPromise) {
        this.chatAdminLookupInFlight.delete(cacheKey);
      }
    });

    this.chatAdminLookupInFlight.set(cacheKey, trackedLookupPromise);

    if (!batch.scheduled) {
      batch.scheduled = true;
      void Promise.resolve().then(() => this.flushPendingChatAdminLookupBatch(chatId));
    }

    return trackedLookupPromise;
  }

  private async flushPendingChatAdminLookupBatch(chatId: string): Promise<void> {
    const batch = this.pendingChatAdminLookupBatches.get(chatId);
    if (!batch) {
      return;
    }

    this.pendingChatAdminLookupBatches.delete(chatId);
    const lookups = [...batch.lookups.values()];
    if (lookups.length === 0) {
      return;
    }

    const normalizedUserIds = Array.from(
      new Set(lookups.map((lookup) => lookup.userId.trim()).filter((value) => value.length > 0)),
    );
    if (normalizedUserIds.length === 0) {
      for (const lookup of lookups) {
        lookup.resolve('user_denied');
      }
      return;
    }

    try {
      const accessStates = await this.loadRemoteChatAdminAccessBatch(chatId, normalizedUserIds);
      this.chatAdminChatBackoffUntilMs.delete(chatId);

      for (const lookup of lookups) {
        const normalizedUserId = lookup.userId.trim();
        const accessState = accessStates.get(normalizedUserId) ?? lookup.staleCached;
        if (!accessState) {
          lookup.resolve(null);
          continue;
        }

        this.chatAdminAccessCache.set(lookup.cacheKey, {
          expiresAt: Date.now() + CHAT_ADMIN_CACHE_TTL_MS,
          state: accessState,
        });
        this.chatAdminLookupBackoffUntilMs.delete(lookup.cacheKey);
        void this.writeChatAdminAccessToSharedCache(chatId, lookup.userId, accessState);

        if (accessState === 'granted') {
          void this.persistRemoteAdminGrant(chatId, lookup.userId);
        }

        lookup.resolve(accessState);
      }
    } catch (error: unknown) {
      const transient = this.isTransientMaxApiLookupError(error);
      if (transient) {
        const backoffUntilMs = Date.now() + CHAT_ADMIN_LOOKUP_BACKOFF_MS;
        this.chatAdminChatBackoffUntilMs.set(chatId, backoffUntilMs);
        for (const lookup of lookups) {
          this.chatAdminLookupBackoffUntilMs.set(lookup.cacheKey, backoffUntilMs);
        }
      }

      this.logger.warn(
        {
          chatId,
          userIds: lookups.map((lookup) => lookup.userId),
          backoffMs: transient ? CHAT_ADMIN_LOOKUP_BACKOFF_MS : 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to resolve chat admins for moderation bypass',
      );
      for (const lookup of lookups) {
        lookup.resolve(lookup.staleCached);
      }
    }
  }

  private async loadRemoteChatAdminAccessBatch(
    chatId: string,
    userIds: readonly string[],
  ): Promise<Map<string, RemoteChatAdminAccessState>> {
    const normalizedUserIds = Array.from(
      new Set(userIds.map((userId) => userId.trim()).filter((value) => value.length > 0)),
    );
    const results = new Map<string, RemoteChatAdminAccessState>();
    if (normalizedUserIds.length === 0) {
      return results;
    }

    const requestOptions = { trafficClass: 'interactive' as const };
    const maxClientWithAccess = this.maxClient as Partial<MaxClientService>;
    const botContactId = this.resolveBotContactId();

    if (typeof maxClientWithAccess.getChatMembersAccess === 'function') {
      const lookupIds =
        botContactId && !normalizedUserIds.includes(botContactId)
          ? [...normalizedUserIds, botContactId]
          : normalizedUserIds;
      const accessByUserId = await maxClientWithAccess.getChatMembersAccess.call(
        this.maxClient,
        chatId,
        lookupIds,
        requestOptions,
      );
      const botAccess =
        (botContactId ? (accessByUserId.get(botContactId) ?? null) : null) ??
        (typeof maxClientWithAccess.getCurrentChatMemberAccess === 'function'
          ? await maxClientWithAccess.getCurrentChatMemberAccess.call(
              this.maxClient,
              chatId,
              requestOptions,
            )
          : null);
      for (const normalizedUserId of normalizedUserIds) {
        const userAccess =
          accessByUserId.get(normalizedUserId) ??
          (botContactId === normalizedUserId ? botAccess : null);
        const hasUserAccess = userAccess?.isAdmin === true || userAccess?.isOwner === true;
        const accessState: RemoteChatAdminAccessState = hasUserAccess ? 'granted' : 'user_denied';

        if (botAccess && !botAccess.isAdmin && !botAccess.isOwner) {
          results.set(normalizedUserId, accessState);
          continue;
        }

        results.set(normalizedUserId, accessState);
      }

      return results;
    }

    const getChatAdminIds = maxClientWithAccess.getChatAdminIds;
    if (typeof getChatAdminIds !== 'function') {
      return results;
    }

    const rawAdminUserIds = await getChatAdminIds.call(this.maxClient, chatId, requestOptions);
    if (!Array.isArray(rawAdminUserIds)) {
      return results;
    }

    for (const normalizedUserId of normalizedUserIds) {
      results.set(
        normalizedUserId,
        this.isSenderChatAdmin(rawAdminUserIds, normalizedUserId) ? 'granted' : 'user_denied',
      );
    }

    return results;
  }

  private async readChatAdminAccessFromSharedCache(
    chatId: string,
    userId: string,
    nowMs: number,
  ): Promise<RemoteChatAdminAccessState | null> {
    if (!this.chatContextCache?.getAdminAccess) {
      return null;
    }

    for (const variant of this.buildUserIdVariants(userId)) {
      const cached = await this.chatContextCache.getAdminAccess(chatId, variant);
      if (cached === 'granted' || cached === 'user_denied') {
        this.chatAdminAccessCache.set(this.buildChatAdminAccessLookupKey(chatId, userId), {
          expiresAt: nowMs + CHAT_ADMIN_CACHE_TTL_MS,
          state: cached,
        });
        return cached;
      }
    }

    return null;
  }

  private async writeChatAdminAccessToSharedCache(
    chatId: string,
    userId: string,
    state: RemoteChatAdminAccessState,
  ): Promise<void> {
    const chatContextCache = this.chatContextCache;
    if (!chatContextCache?.setAdminAccess) {
      return;
    }

    try {
      await Promise.all(
        [...this.buildUserIdVariants(userId)].map((variant) =>
          chatContextCache.setAdminAccess(chatId, variant, state),
        ),
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to write chat admin access to shared cache',
      );
    }
  }

  private async persistRemoteAdminGrant(chatId: string, userId: string): Promise<void> {
    if (typeof this.prisma.chatAdminAllowlist?.upsert !== 'function') {
      return;
    }

    try {
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
      await this.chatContextCache?.invalidate?.(chatId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to persist remotely confirmed chat admin access',
      );
    }
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

  private getCurrentMinutesInTimeZone(timeZone: string): number | null {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date());

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

  private buildNightModeSessionKey(
    startMinutes: number,
    endMinutes: number,
    timezone: string,
    moment: 'current' | 'start' | 'end' = 'current',
  ): string {
    const currentMinutes = this.getCurrentMinutesInTimeZone(timezone);
    const wrapsMidnight = startMinutes > endMinutes;
    let referenceTime = new Date();

    if (moment === 'end') {
      referenceTime = wrapsMidnight ? new Date(Date.now() - 24 * 60 * 60 * 1000) : new Date();
    } else if (moment === 'current') {
      const inAfterMidnightSegment =
        wrapsMidnight && currentMinutes !== null && currentMinutes < endMinutes;
      referenceTime = inAfterMidnightSegment
        ? new Date(Date.now() - 24 * 60 * 60 * 1000)
        : new Date();
    }

    const dateKey = this.formatDateKeyInTimeZone(referenceTime, timezone);
    return `${timezone}|${startMinutes}-${endMinutes}|${dateKey}`;
  }

  private resolveNightModeReopenSessionKey(params: {
    startMinutes: number;
    endMinutes: number;
    timezone: string;
    nightModeActiveNow: boolean;
  }): string | null {
    if (params.nightModeActiveNow || params.startMinutes === params.endMinutes) {
      return null;
    }

    const currentMinutes = this.getCurrentMinutesInTimeZone(params.timezone);
    if (currentMinutes === null) {
      return null;
    }

    if (params.startMinutes < params.endMinutes) {
      if (currentMinutes < params.endMinutes) {
        return null;
      }

      return this.buildNightModeSessionKey(
        params.startMinutes,
        params.endMinutes,
        params.timezone,
        'end',
      );
    }

    if (currentMinutes < params.endMinutes || currentMinutes >= params.startMinutes) {
      return null;
    }

    return this.buildNightModeSessionKey(
      params.startMinutes,
      params.endMinutes,
      params.timezone,
      'end',
    );
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

  private async wasNightModeScheduledNoticeProcessed(
    chatId: string,
    nightSessionKey: string,
    ruleCode: string,
  ): Promise<boolean> {
    const markerKey = this.buildNightModeNoticeMarkerKey(chatId, nightSessionKey, ruleCode);
    const cachedMarker = await this.readNightModeNoticeMarker(markerKey);
    if (cachedMarker) {
      return true;
    }

    const existingNotice = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        ruleCode,
        metadata: {
          path: ['nightSessionKey'],
          equals: nightSessionKey,
        },
      },
      select: {
        id: true,
      },
    });

    if (existingNotice) {
      await this.writeNightModeNoticeMarker(markerKey);
    }

    return Boolean(existingNotice);
  }

  private async sendNightModeClosedNoticeIfNeeded(params: {
    chatId: string;
    startMinutes: number;
    endMinutes: number;
    timezone: string;
    botSpeechStyle: BotSpeechStyle | null;
    nightModeBotMessageText: string;
    commentsEnabled: boolean;
    nightModeCommentsEnabled: boolean;
    nightModeBotButtonEnabled: boolean;
    nightModeBotButtonUrl: string;
    nightModeBotButtonText: string;
    nightModeRulesButtonEnabled?: boolean;
    rulesPublishedUrl?: string | null;
    rulesPublishedMessageId?: string | null;
    sessionMoment?: 'current' | 'start';
    reason: string;
    sourceMessageId?: string;
  }): Promise<void> {
    const nightSessionKey = this.buildNightModeSessionKey(
      params.startMinutes,
      params.endMinutes,
      params.timezone,
      params.sessionMoment ?? 'current',
    );
    const noticeLockKey = this.buildNightModeNoticeLockKey(
      params.chatId,
      nightSessionKey,
      NIGHT_MODE_NOTICE_RULE_CODE,
    );
    const noticeLock = await this.acquireNightModeNoticeLock(noticeLockKey);
    if (!noticeLock) {
      return;
    }

    try {
      const noticeAlreadySent = await this.wasNightModeScheduledNoticeProcessed(
        params.chatId,
        nightSessionKey,
        NIGHT_MODE_NOTICE_RULE_CODE,
      );
      if (noticeAlreadySent) {
        return;
      }

      const messageText = this.buildNightModeClosedNotice(
        params.startMinutes,
        params.endMinutes,
        params.timezone,
        params.nightModeBotMessageText,
        params.botSpeechStyle,
      );
      const nightModeMessageOptions = this.buildNightModeClosedNoticeOptions(params);
      let noticeMessageId: string | null = null;
      try {
        noticeMessageId = await this.sendScheduledBotMessage({
          chatId: params.chatId,
          text: messageText,
          messageOptions: nightModeMessageOptions ?? undefined,
        });
      } catch (error: unknown) {
        if (
          await this.suppressNightModeDeliveryAfterTerminalError(
            params.chatId,
            error,
            'scheduled_closed_notice',
          )
        ) {
          return;
        }
        throw error;
      }

      await this.writeNightModeNoticeMarker(
        this.buildNightModeNoticeMarkerKey(
          params.chatId,
          nightSessionKey,
          NIGHT_MODE_NOTICE_RULE_CODE,
        ),
      );

      await this.prisma.moderationEvent.create({
        data: {
          chatId: params.chatId,
          userId: 'system',
          eventType: EventType.SYSTEM,
          ruleCode: NIGHT_MODE_NOTICE_RULE_CODE,
          action: SanctionAction.NONE,
          score: 0,
          operator: Operator.BOT,
          metadata: {
            reason: params.reason,
            nightSessionKey,
            nightModeTimezone: params.timezone,
            nightModeStartTime: this.formatMinutesAsTime(params.startMinutes),
            nightModeEndTime: this.formatMinutesAsTime(params.endMinutes),
            ...(params.sourceMessageId ? { sourceMessageId: params.sourceMessageId } : {}),
            ...(noticeMessageId ? { noticeMessageId } : {}),
          },
        },
      });
    } finally {
      await this.releaseNightModeNoticeLock(noticeLock);
    }
  }

  private async sendNightModeOpenNoticeIfNeeded(params: {
    chatId: string;
    nightSessionKey: string;
    startMinutes: number;
    endMinutes: number;
    timezone: string;
    botSpeechStyle: BotSpeechStyle | null;
    nightModeOpenMessageEnabled: boolean;
    nightModeOpenMessageText: string;
  }): Promise<void> {
    const noticeLockKey = this.buildNightModeNoticeLockKey(
      params.chatId,
      params.nightSessionKey,
      NIGHT_MODE_OPEN_NOTICE_RULE_CODE,
    );
    const noticeLock = await this.acquireNightModeNoticeLock(noticeLockKey);
    if (!noticeLock) {
      return;
    }

    try {
      const noticeAlreadySent = await this.wasNightModeScheduledNoticeProcessed(
        params.chatId,
        params.nightSessionKey,
        NIGHT_MODE_OPEN_NOTICE_RULE_CODE,
      );
      if (noticeAlreadySent) {
        return;
      }

      const closedNoticeMessageId = await this.findNightModeClosedNoticeMessageId(
        params.chatId,
        params.nightSessionKey,
      );
      let closedNoticeDeleted = false;
      if (closedNoticeMessageId) {
        try {
          await this.maxClient.deleteMessage(params.chatId, closedNoticeMessageId, {
            immediate: true,
            ignoreFailureMetricStatuses: NIGHT_MODE_TERMINAL_DELIVERY_FAILURE_METRIC_STATUSES,
          });
          closedNoticeDeleted = true;
        } catch (error: unknown) {
          if (
            await this.suppressNightModeDeliveryAfterTerminalError(
              params.chatId,
              error,
              'scheduled_open_notice_delete_previous',
              this.isNightModeTerminalDeleteError(error),
            )
          ) {
            return;
          }
          this.logger.warn(
            {
              chatId: params.chatId,
              messageId: closedNoticeMessageId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed to delete previous night mode closed notice',
          );
        }
      }

      let reopenNoticeMessageId: string | null = null;
      if (params.nightModeOpenMessageEnabled) {
        const messageText = this.buildNightModeOpenedNotice(
          params.startMinutes,
          params.endMinutes,
          params.timezone,
          params.nightModeOpenMessageText,
          params.botSpeechStyle,
        );

        try {
          reopenNoticeMessageId = await this.sendScheduledBotMessage({
            chatId: params.chatId,
            text: messageText,
          });
        } catch (error: unknown) {
          if (
            await this.suppressNightModeDeliveryAfterTerminalError(
              params.chatId,
              error,
              'scheduled_open_notice',
            )
          ) {
            return;
          }
          throw error;
        }
      }

      await this.writeNightModeNoticeMarker(
        this.buildNightModeNoticeMarkerKey(
          params.chatId,
          params.nightSessionKey,
          NIGHT_MODE_OPEN_NOTICE_RULE_CODE,
        ),
      );

      await this.prisma.moderationEvent.create({
        data: {
          chatId: params.chatId,
          userId: 'system',
          eventType: EventType.SYSTEM,
          ruleCode: NIGHT_MODE_OPEN_NOTICE_RULE_CODE,
          action: SanctionAction.NONE,
          score: 0,
          operator: Operator.BOT,
          metadata: {
            reason: params.nightModeOpenMessageEnabled
              ? 'Night mode open notice sent by schedule'
              : 'Night mode reopened without open notice',
            nightSessionKey: params.nightSessionKey,
            nightModeTimezone: params.timezone,
            nightModeStartTime: this.formatMinutesAsTime(params.startMinutes),
            nightModeEndTime: this.formatMinutesAsTime(params.endMinutes),
            closedNoticeDeleted,
            ...(closedNoticeMessageId ? { closedNoticeMessageId } : {}),
            ...(reopenNoticeMessageId ? { noticeMessageId: reopenNoticeMessageId } : {}),
          },
        },
      });
    } finally {
      await this.releaseNightModeNoticeLock(noticeLock);
    }
  }

  private async findNightModeClosedNoticeMessageId(
    chatId: string,
    nightSessionKey: string,
  ): Promise<string | null> {
    const existingNotice = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        ruleCode: NIGHT_MODE_NOTICE_RULE_CODE,
        metadata: {
          path: ['nightSessionKey'],
          equals: nightSessionKey,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        metadata: true,
      },
    });

    const metadata = this.asRecord(existingNotice?.metadata);
    const noticeMessageId = metadata?.noticeMessageId;
    return typeof noticeMessageId === 'string' && noticeMessageId.trim().length > 0
      ? noticeMessageId.trim()
      : null;
  }

  private normalizeDayMinutes(value: number, fallback: number): number {
    if (Number.isInteger(value) && value >= 0 && value <= 1_439) {
      return value;
    }

    return fallback;
  }

  private formatMinutesAsTime(value: number): string {
    const normalized = this.normalizeDayMinutes(value, 0);
    const hours = Math.floor(normalized / 60);
    const minutes = normalized % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  private buildNightModeClosedNotice(
    startMinutes: number,
    endMinutes: number,
    timezone: string,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const windowLabel = `${this.formatMinutesAsTime(startMinutes)}-${this.formatMinutesAsTime(endMinutes)}`;
    const timezoneLabel = timezone === DEFAULT_NIGHT_MODE_TIMEZONE ? 'Москва' : timezone;
    const nightStatus = 'Новые сообщения временно не принимаются.';

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'nightModeBotMessageText',
      overrideText: templateText,
      replacements: {
        user: '',
        night_window: windowLabel,
        night_timezone: timezoneLabel,
        night_status: nightStatus,
      },
    });
  }

  private buildNightModeNoticeLockKey(
    chatId: string,
    nightSessionKey: string,
    ruleCode: string,
  ): string {
    return `night-notice-lock:v1:${ruleCode}:${chatId}:${nightSessionKey}`;
  }

  private buildNightModeNoticeMarkerKey(
    chatId: string,
    nightSessionKey: string,
    ruleCode: string,
  ): string {
    return `night-notice-sent:v1:${ruleCode}:${chatId}:${nightSessionKey}`;
  }

  private buildNightModeDeliveryTerminalKey(chatId: string): string {
    return `night-notice-terminal:v1:${chatId}`;
  }

  private buildNightModeSessionMarkerKey(chatId: string, nightSessionKey: string): string {
    return `night-session-seen:v1:${chatId}:${nightSessionKey}`;
  }

  private async readNightModeSessionMarker(key: string): Promise<boolean> {
    const getString = (this.redisCounter as Partial<RedisCounterService> | undefined)?.getString;
    if (getString && this.redisCounter) {
      try {
        return (await getString.call(this.redisCounter, key)) === '1';
      } catch (error: unknown) {
        this.logger.warn(
          {
            key,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to read night mode session marker from redis',
        );
      }
    }

    const expiresAt = this.nightModeSessionMemoryMarkers.get(key);
    if (!expiresAt) {
      return false;
    }
    if (expiresAt <= Date.now()) {
      this.nightModeSessionMemoryMarkers.delete(key);
      return false;
    }

    return true;
  }

  private async writeNightModeSessionMarker(key: string): Promise<void> {
    const expiresAt = Date.now() + NIGHT_MODE_SESSION_MARKER_TTL_SEC * 1_000;
    this.nightModeSessionMemoryMarkers.set(key, expiresAt);

    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (!setStringWithTtl || !this.redisCounter) {
      return;
    }

    try {
      await setStringWithTtl.call(this.redisCounter, key, '1', NIGHT_MODE_SESSION_MARKER_TTL_SEC);
    } catch (error: unknown) {
      this.logger.warn(
        {
          key,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to write night mode session marker to redis',
      );
    }
  }

  private async readNightModeDeliveryTerminalMarker(chatId: string): Promise<boolean> {
    const key = this.buildNightModeDeliveryTerminalKey(chatId);
    const getString = (this.redisCounter as Partial<RedisCounterService> | undefined)?.getString;
    if (getString && this.redisCounter) {
      try {
        if ((await getString.call(this.redisCounter, key)) === '1') {
          return true;
        }
      } catch (error: unknown) {
        this.logger.warn(
          {
            key,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to read night mode delivery suppression marker from redis',
        );
      }
    }

    const expiresAt = this.nightModeDeliveryTerminalMemoryMarkers.get(key);
    if (!expiresAt) {
      return false;
    }
    if (expiresAt <= Date.now()) {
      this.nightModeDeliveryTerminalMemoryMarkers.delete(key);
      return false;
    }

    return true;
  }

  private async writeNightModeDeliveryTerminalMarker(chatId: string): Promise<void> {
    const key = this.buildNightModeDeliveryTerminalKey(chatId);
    const expiresAt = Date.now() + NIGHT_MODE_DELIVERY_TERMINAL_TTL_SEC * 1_000;
    this.nightModeDeliveryTerminalMemoryMarkers.set(key, expiresAt);

    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (!setStringWithTtl || !this.redisCounter) {
      return;
    }

    try {
      await setStringWithTtl.call(
        this.redisCounter,
        key,
        '1',
        NIGHT_MODE_DELIVERY_TERMINAL_TTL_SEC,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          key,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to write night mode delivery suppression marker to redis',
      );
    }
  }

  private async readNightModeNoticeMarker(key: string): Promise<boolean> {
    const getString = (this.redisCounter as Partial<RedisCounterService> | undefined)?.getString;
    if (!getString || !this.redisCounter) {
      return false;
    }

    try {
      return (await getString.call(this.redisCounter, key)) === '1';
    } catch (error: unknown) {
      this.logger.warn(
        {
          key,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to read night mode notice marker from redis',
      );
      return false;
    }
  }

  private async writeNightModeNoticeMarker(key: string): Promise<void> {
    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (!setStringWithTtl || !this.redisCounter) {
      return;
    }

    try {
      await setStringWithTtl.call(this.redisCounter, key, '1', NIGHT_MODE_NOTICE_MARKER_TTL_SEC);
    } catch (error: unknown) {
      this.logger.warn(
        {
          key,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to write night mode notice marker to redis',
      );
    }
  }

  private async acquireNightModeNoticeLock(
    key: string,
  ): Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null> {
    const acquireLock = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.acquireLock;

    if (acquireLock && this.redisCounter) {
      try {
        const token = await acquireLock.call(this.redisCounter, key, NIGHT_MODE_NOTICE_LOCK_TTL_MS);
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
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to acquire redis night mode notice lock; falling back to memory lock',
        );
      }
    }

    if (this.nightModeNoticeMemoryLocks.has(key)) {
      return null;
    }

    const token = randomUUID();
    this.nightModeNoticeMemoryLocks.set(key, token);
    return {
      key,
      token,
      mode: 'memory',
    };
  }

  private async releaseNightModeNoticeLock(lock: {
    key: string;
    token: string;
    mode: 'redis' | 'memory';
  }): Promise<void> {
    if (lock.mode === 'memory') {
      if (this.nightModeNoticeMemoryLocks.get(lock.key) === lock.token) {
        this.nightModeNoticeMemoryLocks.delete(lock.key);
      }
      return;
    }

    const releaseLock = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.releaseLock;
    if (!releaseLock || !this.redisCounter) {
      return;
    }

    try {
      await releaseLock.call(this.redisCounter, lock.key, lock.token);
    } catch (error: unknown) {
      this.logger.warn(
        {
          key: lock.key,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to release redis night mode notice lock',
      );
    }
  }

  private async suppressNightModeDeliveryAfterTerminalError(
    chatId: string,
    error: unknown,
    operation: string,
    isTerminal = this.isNightModeTerminalDeliveryError(error),
  ): Promise<boolean> {
    if (!isTerminal) {
      return false;
    }

    await this.writeNightModeDeliveryTerminalMarker(chatId);
    this.logger.warn(
      {
        chatId,
        operation,
        status: this.extractStatusCode(error),
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Suppressing repeated scheduled night mode delivery after terminal MAX API error',
    );
    return true;
  }

  private buildNightModeClosedNoticeOptions(params: {
    chatId: string;
    commentsEnabled: boolean;
    nightModeCommentsEnabled: boolean;
    nightModeBotButtonEnabled: boolean;
    nightModeBotButtonUrl: string;
    nightModeBotButtonText: string;
    nightModeRulesButtonEnabled?: boolean;
    rulesPublishedUrl?: string | null;
    rulesPublishedMessageId?: string | null;
  }): MaxSendMessageOptions | null {
    const baseOptions = this.buildBotMessageOptions(
      params.chatId,
      params.nightModeBotButtonEnabled,
      params.nightModeBotButtonUrl,
      params.nightModeBotButtonText,
      params.nightModeRulesButtonEnabled ?? false,
      params.rulesPublishedUrl ?? null,
      params.rulesPublishedMessageId ?? null,
    );
    const commentsButton = this.buildNightModeCommentsButton(
      params.chatId,
      params.commentsEnabled,
      params.nightModeCommentsEnabled,
    );

    if (!commentsButton) {
      return baseOptions;
    }

    const buttons: MaxMessageButton[][] = [[commentsButton]];
    if (baseOptions?.buttons?.length) {
      buttons.push(...baseOptions.buttons);
    } else if (baseOptions?.button) {
      buttons.push([baseOptions.button]);
    }

    return {
      buttons,
      ...(baseOptions?.messageLink ? { messageLink: baseOptions.messageLink } : {}),
      ...(baseOptions?.textFormat ? { textFormat: baseOptions.textFormat } : {}),
      ...(baseOptions?.debugContext ? { debugContext: baseOptions.debugContext } : {}),
    };
  }

  private buildNightModeCommentsButton(
    chatId: string,
    commentsEnabled: boolean,
    nightModeCommentsEnabled: boolean,
  ): MaxMessageButton | null {
    if (!commentsEnabled || !nightModeCommentsEnabled) {
      return null;
    }

    return this.buildChatDialogButton(
      chatId,
      'comments',
      randomUUID(),
      formatCommentsButtonText('💬 Комментарии', 0),
    );
  }

  private buildNightModeOpenedNotice(
    startMinutes: number,
    endMinutes: number,
    timezone: string,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const windowLabel = `${this.formatMinutesAsTime(startMinutes)}-${this.formatMinutesAsTime(endMinutes)}`;
    const timezoneLabel = timezone === DEFAULT_NIGHT_MODE_TIMEZONE ? 'Москва' : timezone;
    const openingStatus = 'Группа снова открыта.';

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'nightModeOpenMessageText',
      overrideText: templateText,
      replacements: {
        user: '',
        night_window: windowLabel,
        night_timezone: timezoneLabel,
        opening_status: openingStatus,
      },
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

    const messageNode = this.extractRawMessageNode(raw);
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

    const messageNode = this.extractRawMessageNode(raw) ?? raw;
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

    if (senderId) {
      const mode = await this.resolveSystemModeSnapshot();
      const senderAdminCheck = await this.resolveSenderChatAdminCheck(
        chatId,
        managedChannel.adminUserIds,
        senderId,
        {
          allowRemoteLookup: mode.mode !== 'degrade',
          skipRemoteLookupWhenLocalAdminsKnown: true,
        },
      );
      if (!senderAdminCheck.isAdmin) {
        return;
      }
    }

    await this.tryAutoAttachChannelMessageButtons({
      chatId,
      messageId,
      text: typeof text === 'string' && text.trim() ? text : null,
      linkType: this.extractChannelMessageLinkType(update),
      managedChannel,
      source: 'webhook',
      senderId,
    });
  }

  private async processChannelAutoPostButtons(): Promise<void> {
    if (this.channelAutoPostInFlight || !this.backgroundTasksEnabled) {
      return;
    }
    if (Date.now() < this.channelAutoPostBackoffUntilMs) {
      return;
    }
    if (await this.shouldPauseBackgroundWork('channel-auto-post-buttons')) {
      return;
    }
    if (this.channelAutoPostScanMaxChannels === 0) {
      return;
    }
    if (typeof this.prisma.channelSettings?.findMany !== 'function') {
      return;
    }

    this.channelAutoPostInFlight = true;
    try {
      const channels = await this.prisma.channelSettings.findMany({
        where: {
          OR: [
            {
              autoPostButtonsMode: {
                in: ['COMMENTS', 'BOTH'],
              },
            },
            {
              commentsEnabled: true,
            },
            {
              postSuggestionsEnabled: true,
            },
          ],
        },
        include: {
          chat: {
            include: {
              admins: {
                select: {
                  userId: true,
                },
              },
            },
          },
        },
        orderBy: {
          updatedAt: 'desc',
        },
      });
      const scanBatch = this.selectChannelAutoPostScanBatch(channels);

      for (const [index, channelSettings] of scanBatch.entries()) {
        if (index > 0) {
          await this.sleep(this.channelAutoPostInterChannelDelayMs);
        }

        try {
          await this.processManagedChannelAutoPostButtons({
            channelSettings,
            adminUserIds: channelSettings.chat.admins.map((item) => item.userId),
          });
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId: channelSettings.chatId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed channel auto post buttons scan',
          );
          if (this.isMaxApiThrottleError(error)) {
            this.channelAutoPostBackoffUntilMs =
              Date.now() + CHANNEL_AUTO_POST_RATE_LIMIT_BACKOFF_MS;
            break;
          }
        }
      }
    } finally {
      this.channelAutoPostInFlight = false;
    }
  }

  private async processManagedChannelAutoPostButtons(
    managedChannel: ManagedChannelContext,
  ): Promise<void> {
    const chatId = managedChannel.channelSettings.chatId;
    const existingScanState = this.channelAutoPostScanState.get(chatId) ?? null;
    if (existingScanState && Date.now() < existingScanState.nextScanAtMs) {
      return;
    }

    const messages = await this.maxClient.listMessages(chatId, {
      count: 10,
      trafficClass: 'background',
    });
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
      if (autoAttachAttempts >= this.channelAutoPostMaxNewMessagesPerScan) {
        break;
      }

      await this.tryAutoAttachChannelMessageButtons({
        chatId,
        messageId: normalized.messageId,
        text: normalized.text,
        linkType: normalized.linkType,
        managedChannel,
        source: 'poll',
        senderId: null,
      });
      autoAttachAttempts += 1;
      scanState = this.advanceChannelAutoPostScanState(scanState, normalized);
      this.channelAutoPostScanState.set(chatId, scanState);
    }

    this.channelAutoPostScanState.set(
      chatId,
      this.scheduleChannelAutoPostScanState(scanState, sawNewMessages),
    );
  }

  private parseChannelListedMessage(message: Record<string, unknown>): {
    messageId: string;
    text: string | null;
    linkType: string | null;
    timestampMs: number;
    hasInlineKeyboard: boolean;
    senderId: string | null;
  } | null {
    const body = this.asRecord(message.body);
    const link = this.asRecord(message.link);
    const linkedMessage = this.asRecord(link?.message);
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

    return {
      messageId: String(messageIdCandidate),
      text: (() => {
        const candidates = [body?.text, message.text, message.caption, linkedMessage?.text];
        for (const candidate of candidates) {
          if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
          }
        }
        return null;
      })(),
      linkType: this.readLowerString(link?.type),
      timestampMs,
      hasInlineKeyboard,
      senderId: (() => {
        const senderId = this.asRecord(message.sender)?.user_id ?? message.sender_id;
        return typeof senderId === 'string' && senderId.trim() ? senderId.trim() : null;
      })(),
    };
  }

  private async tryAutoAttachChannelMessageButtons(params: {
    chatId: string;
    messageId: string;
    text: string | null;
    linkType: string | null;
    managedChannel: ManagedChannelContext;
    source: 'webhook' | 'poll';
    senderId: string | null;
  }): Promise<void> {
    const { chatId, messageId, text, linkType, managedChannel, source, senderId } = params;
    const { includeCommentsButton, includeSuggestButton } = this.resolveChannelAutoPostButtons(
      managedChannel.channelSettings,
    );
    if (!includeCommentsButton && !includeSuggestButton) {
      return;
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
    if (alreadyAttached) {
      return;
    }

    const threadId = randomUUID();
    const buttons = this.buildChannelAutoPostButtons(
      chatId,
      threadId,
      managedChannel.channelSettings,
      includeCommentsButton,
      includeSuggestButton,
    );
    if (buttons.length === 0) {
      return;
    }

    let deliveryMode: 'edit_message' | 'reply_message' | 'replace_with_bot_message' =
      'edit_message';
    let replacementMessageId: string | null = null;
    let replyMessageId: string | null = null;
    let originalDeleted = false;

    try {
      if (linkType === 'forward') {
        const sent = await this.maxClient.sendMessageCopyWithInlineKeyboard(
          chatId,
          messageId,
          text,
          {
            buttons,
            debugContext: {
              screen: 'channel-auto-post',
              action:
                source === 'poll'
                  ? 'scan-replace-forward-with-bot-copy'
                  : 'replace-forward-with-bot-copy',
            },
          },
        );
        replacementMessageId = sent.messageId;
        deliveryMode = 'replace_with_bot_message';

        try {
          await this.maxClient.deleteMessage(chatId, messageId, {
            immediate: true,
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
        await this.maxClient.editMessageInlineKeyboard(chatId, messageId, text, {
          buttons,
          debugContext: {
            screen: 'channel-auto-post',
            action: source === 'poll' ? 'scan-attach-buttons' : 'attach-buttons',
          },
        });
      }
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
          linkType === 'forward'
            ? 'Failed to replace forwarded channel post with bot copy; falling back to reply'
            : 'Failed to auto-attach channel post buttons; skipping retry',
        );
        if (linkType !== 'forward') {
          await this.recordChannelAutoPostTerminalSkip({
            chatId,
            messageId,
            senderId,
            linkType,
            source,
            deliveryMode: 'edit_message',
            status,
            error,
          });
          return;
        }

        try {
          const sent = await this.maxClient.sendMessageReplyWithInlineKeyboard(
            chatId,
            messageId,
            CHANNEL_FORWARD_REPLY_TEXT,
            {
              buttons,
              debugContext: {
                screen: 'channel-auto-post',
                action:
                  source === 'poll'
                    ? 'scan-attach-buttons-reply-fallback'
                    : 'attach-buttons-reply-fallback',
              },
            },
          );
          deliveryMode = 'reply_message';
          replyMessageId = sent?.messageId ?? null;
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
              'Failed to publish fallback reply for channel post buttons; skipping retry',
            );
            await this.recordChannelAutoPostTerminalSkip({
              chatId,
              messageId,
              senderId,
              linkType,
              source,
              deliveryMode: 'reply_message',
              status: fallbackStatus,
              error: fallbackError,
            });
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
          deliveryMode,
          linkType,
          replacementMessageId,
          ...(replyMessageId ? { replyMessageId } : {}),
          originalDeleted,
          source,
        },
      },
    });
  }

  private async recordChannelAutoPostTerminalSkip(params: {
    chatId: string;
    messageId: string;
    senderId: string | null;
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
              create: {},
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

    const message = this.extractRawMessageNode(raw) ?? raw;
    const link = this.asRecord(message.link);
    return this.readLowerString(link?.type);
  }

  private resolveChannelAutoPostButtons(
    settings: Pick<
      PersistedChannelSettings,
      'autoPostButtonsMode' | 'postSuggestionsEnabled' | 'commentsEnabled'
    >,
  ) {
    return {
      includeCommentsButton: settings.commentsEnabled,
      includeSuggestButton: settings.postSuggestionsEnabled,
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
  ): MaxMessageButton[][] {
    const rows: MaxMessageButton[][] = [];

    if (includeCommentsButton) {
      rows.push([
        this.buildChannelDialogButton(
          chatId,
          'comments',
          threadId,
          formatCommentsButtonText('💬 Комментарии', 0),
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
        ),
      ],
    ];
    let deliveryMode: 'edit_message' | 'reply_message' | 'replace_with_bot_message' =
      'edit_message';
    let replacementMessageId: string | null = null;
    let replyMessageId: string | null = null;
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
        );
        replacementMessageId = sent.messageId;
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
            originalDeleted,
          },
        },
      });
      return;
    }

    try {
      await this.maxClient.editMessageInlineKeyboard(chatId, messageId, text, {
        buttons,
        debugContext: {
          screen: 'chat-auto-comments',
          action: 'attach-comments',
        },
      });
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
          ...(replyMessageId ? { replyMessageId } : {}),
          originalDeleted,
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
  ): MaxMessageButton {
    if (type === 'suggest') {
      const startPayload =
        this.adminService?.buildChannelSuggestionStartPayload(chatId, threadId) ??
        this.buildChannelDialogStartParam(chatId, 'suggest', threadId);
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

  private buildChatDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
  ): MaxMessageButton {
    const launchUrl = this.buildChatDialogLaunchUrl(chatId, type, threadId);
    const webAppUrl = this.buildChatDialogDirectWebAppUrl(chatId, type, threadId);
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

  private buildChannelDialogLaunchUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    const startParam = this.buildChannelDialogStartParam(chatId, type, threadId);
    return this.buildMiniappStartUrl(startParam);
  }

  private buildChatDialogLaunchUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    const startParam = this.buildChatDialogStartParam(chatId, type, threadId);
    return this.buildMiniappStartUrl(startParam);
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

  private buildMiniappStartUrl(startParam: string): string | null {
    if (!this.ownBotUserId) {
      return null;
    }
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.ownBotUserId)}?startapp=${encodeURIComponent(startParam)}`;
  }

  private buildBotStartUrl(startPayload: string): string | null {
    if (!this.ownBotUserId) {
      return null;
    }
    if (!isValidMaxBotStartPayload(startPayload)) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.ownBotUserId)}?start=${encodeURIComponent(startPayload)}`;
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
    return createHmac('sha256', this.maxBotToken ?? '')
      .update(scope)
      .digest('hex');
  }

  private buildChatDialogTokenSignature(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string {
    const scope = `dialog:chat:${chatId}:${type}:${threadId}`;
    return createHmac('sha256', this.maxBotToken ?? '')
      .update(scope)
      .digest('hex');
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
    if (this.chatContextCache) {
      const cached = await this.chatContextCache.getChatContext(chatId, chatTitle);
      const resolvedRulesPublishedUrl = await this.resolveRulesPublishedUrl(
        chatId,
        cached.rulesPublishedUrl ?? null,
        cached.rulesPublishedMessageId ?? null,
      );
      return {
        settings: cached.settings,
        domainAllowlist: cached.domainAllowlist,
        adminUserIds: cached.adminUserIds,
        rulesPublishedUrl: resolvedRulesPublishedUrl,
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

    const resolvedRulesPublishedUrl = await this.resolveRulesPublishedUrl(
      chatId,
      chat.rules?.publishedUrl ?? null,
      chat.rules?.publishedMessageId ?? null,
    );

    return {
      settings: chat.settings,
      domainAllowlist: (chat.domains ?? []).map((item) => item.domain),
      adminUserIds: (chat.admins ?? []).map((item) => item.userId),
      rulesPublishedUrl: resolvedRulesPublishedUrl,
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

  private extractStatusCode(error: unknown): number | null {
    const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
    return typeof maybeStatus === 'number' ? maybeStatus : null;
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

  private isNightModeTerminalDeliveryError(error: unknown): boolean {
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
    return message.includes('rate limit exceeded') || message.includes('circuit breaker');
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
    if (
      !params.settings.nightModeEnabled ||
      (!params.settings.nightModeBotMessageEnabled && !params.settings.nightModeOpenMessageEnabled)
    ) {
      return false;
    }

    const normalizedMessage = this.normalizeTextForComparison(params.text);
    if (!normalizedMessage) {
      return false;
    }

    if (params.settings.nightModeBotMessageEnabled) {
      const expectedClosedNotice = this.buildNightModeClosedNotice(
        params.settings.nightModeStartTimeMinutes,
        params.settings.nightModeEndTimeMinutes,
        params.settings.nightModeTimezone,
        params.settings.nightModeBotMessageText,
        params.settings.botSpeechStyle,
      );

      if (normalizedMessage === this.normalizeTextForComparison(expectedClosedNotice)) {
        return true;
      }
    }

    if (params.settings.nightModeOpenMessageEnabled) {
      const expectedOpenNotice = this.buildNightModeOpenedNotice(
        params.settings.nightModeStartTimeMinutes,
        params.settings.nightModeEndTimeMinutes,
        params.settings.nightModeTimezone,
        params.settings.nightModeOpenMessageText,
        params.settings.botSpeechStyle,
      );

      if (normalizedMessage === this.normalizeTextForComparison(expectedOpenNotice)) {
        return true;
      }
    }

    return false;
  }

  private normalizeTextForComparison(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private buildBotMessageDispatchOptions(params: {
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    immediate?: boolean;
  }): MaxActionDispatchOptions | undefined {
    const dispatchOptions: MaxActionDispatchOptions = {};
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
    text: string;
    messageOptions?: MaxSendMessageOptions;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    immediate?: boolean;
  }) {
    const {
      chatId,
      text,
      messageOptions,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      immediate,
    } = params;

    await this.maxClient.sendMessage(
      chatId,
      text,
      {
        ...(messageOptions ?? {}),
        textFormat: 'markdown',
      },
      this.buildBotMessageDispatchOptions({
        deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes,
        immediate,
      }),
    );
  }

  private async sendScheduledBotMessage(params: {
    chatId: string;
    text: string;
    messageOptions?: MaxSendMessageOptions;
  }): Promise<string | null> {
    const options = {
      ...(params.messageOptions ?? {}),
      textFormat: 'markdown' as const,
    };

    if (typeof this.maxClient.sendMessageImmediateWithId === 'function') {
      const sent = await this.maxClient.sendMessageImmediateWithId(
        params.chatId,
        params.text,
        options,
        {
          trafficClass: 'background',
          ignoreFailureMetricStatuses: NIGHT_MODE_TERMINAL_DELIVERY_FAILURE_METRIC_STATUSES,
        },
      );

      return typeof sent.messageId === 'string' && sent.messageId.trim().length > 0
        ? sent.messageId.trim()
        : null;
    }

    if (typeof this.maxClient.sendMessageImmediateWithResolvedLink === 'function') {
      const sent = await this.maxClient.sendMessageImmediateWithResolvedLink(
        params.chatId,
        params.text,
        options,
        {
          trafficClass: 'background',
          ignoreFailureMetricStatuses: NIGHT_MODE_TERMINAL_DELIVERY_FAILURE_METRIC_STATUSES,
        },
      );

      return typeof sent.messageId === 'string' && sent.messageId.trim().length > 0
        ? sent.messageId.trim()
        : null;
    }

    await this.maxClient.sendMessage(params.chatId, params.text, options);
    return null;
  }

  private selectChannelAutoPostScanBatch<T>(channels: T[]): T[] {
    if (channels.length <= this.channelAutoPostScanMaxChannels) {
      this.channelAutoPostCursor = 0;
      return channels;
    }

    const startIndex = this.channelAutoPostCursor % channels.length;
    const batch: T[] = [];

    for (let index = 0; index < this.channelAutoPostScanMaxChannels; index += 1) {
      batch.push(channels[(startIndex + index) % channels.length]!);
    }

    this.channelAutoPostCursor = (startIndex + batch.length) % channels.length;
    return batch;
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

  private async shouldPauseBackgroundWork(
    task: 'night-mode-announcements' | 'channel-auto-post-buttons',
  ): Promise<boolean> {
    if (task === 'night-mode-announcements') {
      return false;
    }

    const mode = await this.resolveSystemModeSnapshot();
    if (mode.mode !== 'degrade') {
      return false;
    }

    const now = Date.now();
    if (now - this.channelAutoPostPausedLogAtMs >= BACKGROUND_WORK_PAUSE_LOG_INTERVAL_MS) {
      this.channelAutoPostPausedLogAtMs = now;
      this.logger.log(
        {
          task,
          mode: mode.mode,
          source: mode.source,
          reason: mode.reason,
        },
        'Paused moderation background work because the system is degraded',
      );
    }
    return true;
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
    constructor(private readonly moderationService: ModerationService) {
      super();
    }

    async process(job: Job<ProcessWebhookJob>) {
      if (!roleRunsModeration(getAppRole())) {
        return;
      }
      await this.moderationService.processWebhookEvent(job.data.webhookEventId);
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

function readPositiveInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number(rawValue);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function resolveModerationConcurrencySplit(total: number): {
  critical: number;
  default: number;
  background: number;
} {
  if (total <= 2) {
    return {
      critical: 1,
      default: 1,
      background: 1,
    };
  }

  if (total === 3) {
    return {
      critical: 1,
      default: 1,
      background: 1,
    };
  }

  const background = total >= 8 ? 2 : 1;
  const critical = Math.max(1, Math.ceil(total * 0.35));
  const defaultQueue = Math.max(1, total - critical - background);

  return {
    critical,
    default: defaultQueue,
    background,
  };
}

function resolveShardConcurrencyDistribution(total: number, shardCount: number): number[] {
  if (shardCount <= 1) {
    return [Math.max(1, total)];
  }

  const normalizedTotal = Math.max(1, total);
  const base = Math.floor(normalizedTotal / shardCount);
  let remainder = normalizedTotal % shardCount;

  return Array.from({ length: shardCount }, () => {
    const next = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) {
      remainder -= 1;
    }
    return Math.max(1, next);
  });
}
