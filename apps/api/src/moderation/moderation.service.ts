import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
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
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { SystemModeService } from '../system/system-mode.service';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { PrivateControlService } from './private-control.service';
import { RedisCounterService } from './redis-counter.service';
import type {
  DuplicateAction,
  DuplicateDecision,
  DuplicateHit,
} from './rule-engine.service';
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

type ProcessWebhookJob = {
  webhookEventId: string;
};

type ActiveBan = {
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

type ManagedChannelContext = {
  channelSettings: PersistedChannelSettings;
  adminUserIds: string[];
};

type RulesButtonReference = {
  publishedUrl: string | null;
  publishedMessageId: string | null;
};

type ChannelDialogType = 'comments' | 'suggest';

const DEFAULT_BAN_DURATION_HOURS = 6;
const DEFAULT_BOT_BUTTON_TEXT = 'Открыть';
const RULES_BOT_BUTTON_TEXT = 'Правила';
const RULES_CALLBACK_PAYLOAD = 'rules:open';
const DEFAULT_BOT_MESSAGES_DELETE_DELAY_MINUTES = 2;
const BOT_MESSAGES_DELETE_DELAY_MIN_MINUTES = 1;
const BOT_MESSAGES_DELETE_DELAY_MAX_MINUTES = 60;
const DEFAULT_NIGHT_MODE_TIMEZONE = 'Europe/Moscow';
const NIGHT_MODE_NOTICE_RULE_CODE = 'NIGHT_MODE_NOTICE';
const LINK_ESCALATION_WINDOW_HOURS = 24;
const TEXT_FILTER_ESCALATION_WINDOW_HOURS = 24;
const TOPIC_FILTER_ESCALATION_WINDOW_HOURS = 24;
const MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS = 12;
const CHAT_ADMIN_CACHE_TTL_MS = 60_000;
const CHAT_ADMIN_CACHE_TTL_SEC = Math.ceil(CHAT_ADMIN_CACHE_TTL_MS / 1_000);
const CHAT_ADMIN_SHARED_CACHE_KEY_PREFIX = 'chat-admins:v2';
const SUPPORT_CHAT_URL = 'https://max.ru/join/qX7U_Hj-L-xMJG8V7wlF6dD-6a6cXIzTBGRtU2mRMzk';
const BOT_STARTED_INSTRUCTION_OPTIONS: MaxSendMessageOptions = {
  button: {
    text: 'Поддержка',
    url: SUPPORT_CHAT_URL,
  },
};
const BOT_STARTED_INSTRUCTION_TEXT = [
  'Отдел чат-порядка «Майор Максимов» на месте. Чат взят под контроль.',
  '',
  'Коротко по делу:',
  '- Мат, реклама и мутные ссылки - под нож.',
  '- Повторяешь одно и то же - сначала предупреждение, потом дверь.',
  '- Слишком длинные простыни, лишние файлы и голосовые тоже ловлю.',
  '- Ночью в чате тишина: шумных быстро успокаиваю.',
  '- Новых людей встречаю, ботов из группы вывожу.',
  '- Могу сделать рассылку: текст, кнопка, фото, сразу или по времени.',
  '',
  'Настройка во встроенном приложении: открой бота в MAX и нажми «Открыть».',
  'Там включаешь правила и тексты так, как нужно вашему чату.',
  '',
  'Схема простая: сначала слово, потом протокол.',
].join('\n');
const PRIVATE_MENU_CALLBACK_MENU = 'private_menu:menu';
const PRIVATE_MENU_CALLBACK_CHATS = 'private_menu:chats';
const PRIVATE_MENU_CALLBACK_HELP = 'private_menu:help';
const PRIVATE_BOT_CHATS_PREVIEW_LIMIT = 12;
const PRIVATE_MENU_PROMPT_TEXT = [
  'Управление без приложения:',
  '- «Мои чаты» — список чатов, где бот уже подключён.',
  '- «Помощь» — короткий гайд по запуску и правам.',
  '- «Открыть приложение» — полный набор настроек.',
].join('\n');
const PRIVATE_HELP_TEXT = [
  'Быстрый гайд:',
  '1) Добавьте бота в нужный чат.',
  '2) Дайте боту права администратора.',
  '3) Откройте приложение для тонкой настройки правил.',
  '',
  'Команды в личке:',
  '- /menu',
  '- /chats',
  '- /help',
].join('\n');
const MAX_FORWARD_SCAN_DEPTH = 8;
const CHANNEL_AUTO_POST_SCAN_INTERVAL_MS = 5_000;
const CHANNEL_DIALOG_START_PARAM_PREFIX = 'cd-';
const CHANNEL_DIALOG_TOKEN_PREFIX = 'cdt-';
const CHANNEL_DIALOG_AUTO_ATTACH_ACTION = 'AUTO_ATTACH_CHANNEL_ENGAGEMENT';
const GLOBAL_BLACKLIST_TOGGLE_CACHE_TTL_MS = 30_000;
const GLOBAL_CROSS_CHAT_SPAM_SCOPE_CACHE_TTL_MS = 30_000;
const GLOBAL_CROSS_CHAT_SPAM_WINDOW_SEC = 2 * 60;
const GLOBAL_CROSS_CHAT_SPAM_MIN_CHATS = 3;
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
  'MESSAGE_TOO_LONG',
  'VIDEO_BLOCKED',
  'FILE_BLOCKED',
  'VOICE_BLOCKED',
  'PHOTO_RATE_LIMIT',
  'STICKER_RATE_LIMIT',
]);
const MESSAGE_LIMITS_RULE_CODES = new Set([
  'MESSAGE_TOO_LONG',
  'VIDEO_BLOCKED',
  'FILE_BLOCKED',
  'VOICE_BLOCKED',
  'PHOTO_RATE_LIMIT',
  'STICKER_RATE_LIMIT',
]);
const TEXT_FILTER_RULE_CODES = new Set(['PROFANITY', 'COMMERCIAL_AD']);
const TOPIC_FILTER_RULE_CODES = new Set(['TOPIC_FILTER_MISMATCH']);
type PrivateControlCommand = 'menu' | 'chats' | 'help';

@Injectable()
export class ModerationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModerationService.name);
  private globalUserBlacklistEnabledCache: { value: boolean; checkedAt: number } | null = null;
  private readonly globalCrossChatSpamScopeCache = new Map<
    string,
    {
      expiresAt: number;
      adminScopeIds: string[];
    }
  >();
  private readonly chatAdminCache = new Map<
    string,
    {
      expiresAt: number;
      adminUserIds: Set<string>;
    }
  >();
  private readonly ownBotUserId: string | null;
  private readonly ownBotUserIdVariants: Set<string>;
  private nightModeAnnounceTimer: NodeJS.Timeout | null = null;
  private nightModeAnnounceInFlight = false;
  private channelAutoPostTimer: NodeJS.Timeout | null = null;
  private channelAutoPostInFlight = false;
  private readonly appBaseUrl: string | null;
  private readonly explicitBotContactId: string | null;
  private readonly maxBotToken: string | null;

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
  ) {
    this.maxBotToken = this.normalizeSecret(configService?.get<string>('MAX_BOT_TOKEN'));
    this.ownBotUserId = this.normalizeOwnBotUserId(configService?.get<string>('MAX_BOT_ID'));
    this.ownBotUserIdVariants = this.buildBotIdVariants(this.ownBotUserId);
    this.appBaseUrl = this.normalizeAppBaseUrl(configService?.get<string>('APP_BASE_URL'));
    this.explicitBotContactId = this.normalizeBotContactId(
      configService?.get<string>('MAX_BOT_CONTACT_ID'),
    );
  }

  onModuleInit() {
    if (!roleRunsModeration(getAppRole())) {
      return;
    }

    this.nightModeAnnounceTimer = setInterval(() => {
      void this.processNightModeAnnouncements();
    }, 30_000);
    void this.processNightModeAnnouncements();

    this.channelAutoPostTimer = setInterval(() => {
      void this.processChannelAutoPostButtons();
    }, CHANNEL_AUTO_POST_SCAN_INTERVAL_MS);
    void this.processChannelAutoPostButtons();
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
      await this.handleRulesCallback(
        chatId,
        callbackId,
        update.message?.messageId ?? null,
      );
      return;
    }

    const userLabel = this.formatUserLabel(senderName);
    const mode = this.systemModeService?.getSnapshot() ?? {
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
    const degradeMode = mode.mode === 'degrade';
    const chat = await this.loadChatContext(chatId, chatTitle);
    const settings = this.applyDegradeSettings(chat.settings, degradeMode);
    const rulesPublishedUrl = chat.rulesPublishedUrl;
    const rulesPublishedMessageId = chat.rulesPublishedMessageId;
    const globalUserBlacklistEnabled = await this.isGlobalUserBlacklistEnabled(
      settings.globalUserBlacklistEnabled,
    );
    const globalCrossChatSpamAdminScopeIds = await this.resolveGlobalCrossChatSpamAdminScopeIds({
      chatId,
      chatSettingEnabled: settings.globalCrossChatSpamEnabled,
      localAdminUserIds: chat.adminUserIds,
    });
    const globalCrossChatSpamEnabled = globalCrossChatSpamAdminScopeIds.length > 0;

    const updateType = this.readLowerString(update.type);
    const senderIsOwnBotInMessage =
      updateType === 'message_created' && senderId ? this.isOwnBotSender(senderId) : false;
    if (senderIsOwnBotInMessage) {
      const skipOwnBotAutoDelete = this.isNightModeNoticeMessage({
        text,
        settings,
      });
      if (settings.deleteBotMessagesEnabled && !skipOwnBotAutoDelete) {
        await this.handleBotMessageAutoDelete({
          chatId,
          userId: senderId,
          messageId,
          text,
          delayMinutes: settings.deleteBotMessagesDelayMinutes,
        });
      } else if (skipOwnBotAutoDelete) {
        this.logger.debug(
          {
            chatId,
            messageId,
          },
          'Skipped auto-delete for scheduled night mode notice',
        );
      }
      return;
    }

    if (serviceAuthored || serviceMembersEvent) {
      const excludedGreetingUserIds = new Set<string>();

      if (globalUserBlacklistEnabled) {
        const kickedUserIds = await this.handleServiceGloballyBlacklistedMembersEvent({
          chatId,
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
          greetingBotMessageText: settings.greetingBotMessageText,
          greetingBotButtonEnabled: settings.greetingBotButtonEnabled,
          greetingBotButtonUrl: settings.greetingBotButtonUrl,
          greetingBotButtonText: settings.greetingBotButtonText,
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
      } else if (settings.deleteBotMessagesEnabled && senderIsOwnBot) {
        const skipOwnBotAutoDelete = this.isNightModeNoticeMessage({
          text,
          settings,
        });
        if (skipOwnBotAutoDelete) {
          this.logger.debug(
            {
              chatId,
              messageId,
            },
            'Skipped auto-delete for scheduled night mode notice',
          );
        } else {
          await this.handleBotMessageAutoDelete({
            chatId,
            userId: senderId,
            messageId,
            text,
            delayMinutes: settings.deleteBotMessagesDelayMinutes,
          });
        }
      }
      return;
    }

    const senderChatAdminCheck = await this.resolveSenderChatAdminCheck(
      chatId,
      chat.adminUserIds,
      senderId,
    );
    if (senderChatAdminCheck.isAdmin) {
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

    if (globalUserBlacklistEnabled) {
      const handled = await this.handleGloballyBlacklistedSenderMessage({
        chatId,
        userId: senderId,
        messageId,
        text,
      });
      if (handled) {
        return;
      }
    }

    const activeBan = await this.getActiveBan(chatId, senderId, settings.banDurationHours);
    if (activeBan) {
      await this.handleActiveBanMessage({
        chatId,
        userId: senderId,
        messageId,
        text,
        createdAt,
        ban: activeBan,
      });
      return;
    }

    if (this.isNightModeActiveNow(settings)) {
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

    const effectiveMessageLength = this.calculateEffectiveMessageLength(update);
    const mediaFlags = this.detectMediaFlags(update);
    if (globalCrossChatSpamEnabled) {
      const handled = await this.handleGlobalCrossChatSpamMessage({
        chatId,
        userId: senderId,
        userLabel,
        messageId,
        text,
        createdAt,
        update,
        scopeAdminIds: globalCrossChatSpamAdminScopeIds,
        deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
        mediaFlags,
      });
      if (handled) {
        return;
      }
    }

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
    const hasBlockingDeleteViolation = violations.some(
      (item) =>
        item.ruleCode === 'LINK_BLOCKED' ||
        item.ruleCode === 'PROFANITY' ||
        item.ruleCode === 'COMMERCIAL_AD' ||
        item.ruleCode === 'TOPIC_FILTER_MISMATCH' ||
        item.ruleCode === 'MESSAGE_TOO_LONG' ||
        item.ruleCode === 'VIDEO_BLOCKED' ||
        item.ruleCode === 'FILE_BLOCKED' ||
        item.ruleCode === 'VOICE_BLOCKED' ||
        item.ruleCode === 'PHOTO_RATE_LIMIT' ||
        item.ruleCode === 'STICKER_RATE_LIMIT',
    );
    if (!hasBlockingDeleteViolation && detection.duplicateDecision) {
      await this.handleDuplicateDecision({
        chatId,
        userId: senderId,
        messageId,
        text,
        createdAt,
        decision: detection.duplicateDecision,
        userLabel,
        banDurationHours: settings.banDurationHours,
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

    if (!hasBlockingDeleteViolation && detection.duplicateHit) {
      await this.handleDuplicateHit({
        chatId,
        userId: senderId,
        messageId,
        text,
        createdAt,
        hit: detection.duplicateHit,
        userLabel,
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
      return;
    }

    const topViolation =
      violations.find((item) => item.ruleCode === 'LINK_BLOCKED') ??
      violations.find((item) => item.ruleCode === 'COMMERCIAL_AD') ??
      violations.find((item) => item.ruleCode === 'PROFANITY') ??
      violations.find((item) => item.ruleCode === 'TOPIC_FILTER_MISMATCH') ??
      violations.find((item) => item.ruleCode === 'MESSAGE_TOO_LONG') ??
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
            ...(topViolation.ruleCode === 'TOPIC_FILTER_MISMATCH' &&
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
    const actionBanDurationHours = settings.banDurationHours;

    if (topViolation.ruleCode === 'LINK_BLOCKED') {
      action = this.resolveLinkEscalationAction(linkViolationCount24h ?? 1, {
        warnEnabled: settings.linkWarnEnabled,
        banEnabled: settings.linkBanEnabled,
        kickEnabled: settings.linkKickEnabled,
      });
    } else if (isTextFilterHit) {
      action = this.resolveTextFilterEscalationAction(textFilterViolationCount24h ?? 1, {
        warnEnabled: Boolean(textFilterEscalationSettings?.warnEnabled),
        banEnabled: Boolean(textFilterEscalationSettings?.banEnabled),
        kickEnabled: Boolean(textFilterEscalationSettings?.kickEnabled),
      });
    } else if (isTopicFilterHit) {
      action = this.resolveTextFilterEscalationAction(topicFilterViolationCount24h ?? 1, {
        warnEnabled: settings.thematicFiltersWarnEnabled,
        banEnabled: settings.thematicFiltersBanEnabled,
        kickEnabled: settings.thematicFiltersKickEnabled,
      });
    } else if (isMessageLimitsHit) {
      action = this.resolveMessageLimitsEscalationAction(messageLimitsViolationCount12h ?? 1, {
        warnEnabled: settings.messageLimitsWarnEnabled,
        banEnabled: settings.messageLimitsBanEnabled,
        kickEnabled: settings.messageLimitsKickEnabled,
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
            this.buildLinkExplanation(userLabel, canDeleteMessage, settings.linkBotMessageText),
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
            this.buildLinkWarnExplanation(userLabel, settings.linkWarnMessageText),
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
              settings.photoMessageCooldownHours,
              settings.stickerMessageCooldownMinutes,
              effectiveMessageLength,
              settings.maxMessageLength,
              '',
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
            this.buildMessageLimitsWarnExplanation(userLabel, topViolation.ruleCode),
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
        banDurationHours: actionBanDurationHours,
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
        banNoticeText:
          isMessageLimitsHit && action === SanctionAction.BAN
            ? this.buildMessageLimitsBanExplanation(
                userLabel,
                topViolation.ruleCode,
                actionBanDurationHours,
              )
            : isTopicFilterHit && action === SanctionAction.BAN
              ? this.buildTopicFilterBanExplanation(
                  userLabel,
                  this.extractTopicFilterRequiredCodeword(topViolation.metadata),
                  actionBanDurationHours,
                )
              : undefined,
      });

      if (topViolation.ruleCode === 'LINK_BLOCKED' && action === SanctionAction.KICK) {
        try {
          await sendChatBotMessage(
            this.buildLinkKickExplanation(userLabel),
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
            'Failed to send link kick message',
          );
        }
      }

      if (isTextFilterHit && action === SanctionAction.KICK) {
        try {
          await sendChatBotMessage(
            this.buildTextFilterKickExplanation(userLabel, topViolation.ruleCode),
          );
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId,
              userId: senderId,
              messageId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed to send text filter kick message',
          );
        }
      }

      if (isTopicFilterHit && action === SanctionAction.KICK) {
        try {
          await sendChatBotMessage(
            this.buildTopicFilterKickExplanation(
              userLabel,
              this.extractTopicFilterRequiredCodeword(topViolation.metadata),
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
            'Failed to send thematic filter kick message',
          );
        }
      }

      if (isMessageLimitsHit && action === SanctionAction.KICK) {
        try {
          await sendChatBotMessage(
            this.buildMessageLimitsKickExplanation(userLabel, topViolation.ruleCode),
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
            'Failed to send message limits kick message',
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
          ...(isTopicFilterHit && topViolation.metadata && typeof topViolation.metadata === 'object'
            ? topViolation.metadata
            : {}),
          ...(action === SanctionAction.BAN ? { banDurationHours: actionBanDurationHours } : {}),
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
    banDurationHours: number;
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
      banDurationHours,
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

    if (canDeleteMessage) {
      try {
        await this.maxClient.deleteMessage(chatId, messageId);
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
            banDurationHours,
            duplicateBotMessageText,
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
      banDurationHours,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      botMessageOptions: duplicateMessageOptions ?? undefined,
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
          ...(action === SanctionAction.BAN ? { banDurationHours } : {}),
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

    if (canDeleteMessage) {
      try {
        await this.maxClient.deleteMessage(chatId, messageId);
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
            canDeleteMessage,
            duplicateBotMessageText,
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
    if (action === 'KICK') {
      return SanctionAction.KICK;
    }
    return SanctionAction.BAN;
  }

  private buildLinkExplanation(
    userLabel: string,
    canDeleteMessage: boolean,
    templateText: string,
  ): string {
    const reason = 'в этом чате ссылки не проходят, без ссылок';
    const messageStatus = this.buildMessageStatusLabel(canDeleteMessage);
    const fallback = this.buildMajorExplanationFallback(userLabel, 'Сообщение', messageStatus, reason);

    return this.renderBotMessageTemplate(templateText, fallback, {
      user: userLabel,
      message_status: messageStatus,
      reason,
    });
  }

  private buildLinkWarnExplanation(userLabel: string, templateText: string): string {
    const reason = 'в этом чате ссылки не проходят, без ссылок';
    const warning = 'вынесено предупреждение за ссылку';
    const fallback = `Товарищ ${userLabel}, ${warning}. 👮‍♂️ ${reason}. Без повторов, и разойдёмся по-хорошему.`;

    return this.renderBotMessageTemplate(templateText, fallback, {
      user: userLabel,
      reason,
      warning,
    });
  }

  private buildLinkKickExplanation(userLabel: string): string {
    return `Товарищ ${userLabel}, за повторные заходы со ссылками пришлось вывести вас из чата.`;
  }

  private buildTextFilterWarnExplanation(
    userLabel: string,
    ruleCode: string,
    templateText: string,
  ): string {
    const reason =
      ruleCode === 'COMMERCIAL_AD'
        ? 'рекламу'
        : ruleCode === 'PROFANITY'
          ? 'грубую лексику'
          : 'нарушение текстовых правил';
    const warning = `вынесено предупреждение за ${reason}`;
    const fallback = `Товарищ ${userLabel}, ${warning}. Дальше держим порядок.`;

    return this.renderBotMessageTemplate(templateText, fallback, {
      user: userLabel,
      reason,
      warning,
    });
  }

  private buildTextFilterKickExplanation(userLabel: string, ruleCode: string): string {
    if (ruleCode === 'COMMERCIAL_AD') {
      return `Товарищ ${userLabel}, за повторную рекламу пришлось вывести вас из чата.`;
    }

    if (ruleCode === 'PROFANITY') {
      return `Товарищ ${userLabel}, за повторную грубую лексику пришлось вывести вас из чата.`;
    }

    return `Товарищ ${userLabel}, за повторные нарушения текстовых правил пришлось вывести вас из чата.`;
  }

  private buildTopicFilterExplanation(
    userLabel: string,
    canDeleteMessage: boolean,
    requiredCodeword: string | null,
  ): string {
    const messageStatus = this.buildMessageStatusLabel(canDeleteMessage);
    if (requiredCodeword) {
      return this.buildMajorExplanationFallback(
        userLabel,
        'Объявление',
        messageStatus,
        this.resolveTopicFilterRequirementLabel(requiredCodeword),
      );
    }

    const requirement = this.resolveTopicFilterRequirementLabel(requiredCodeword);
    return this.buildMajorExplanationFallback(userLabel, 'Сообщение', messageStatus, requirement);
  }

  private buildTopicFilterWarnExplanation(
    userLabel: string,
    requiredCodeword: string | null,
  ): string {
    const requirement = this.resolveTopicFilterRequirementLabel(requiredCodeword);
    return `Товарищ ${userLabel}, фиксирую предупреждение. Причина: ${requirement}.`;
  }

  private buildTopicFilterKickExplanation(
    userLabel: string,
    requiredCodeword: string | null,
  ): string {
    if (requiredCodeword) {
      return `Товарищ ${userLabel}, за повторные объявления не по форме пришлось вывести вас из чата.`;
    }

    return `Товарищ ${userLabel}, за повторные сообщения не по форме пришлось вывести вас из чата.`;
  }

  private buildTopicFilterBanExplanation(
    userLabel: string,
    requiredCodeword: string | null,
    banDurationHours: number,
  ): string {
    const durationLabel = this.formatBanDurationLabel(banDurationHours);
    const requirement = this.resolveTopicFilterRequirementLabel(requiredCodeword);
    return `Товарищ ${userLabel}, оформляю тайм-аут на ${durationLabel}. Причина: ${requirement}.`;
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

  private buildDuplicateExplanation(
    userLabel: string,
    decision: DuplicateDecision,
    banDurationHours: number,
    templateText: string,
  ): string {
    const banDurationLabel = this.formatBanDurationLabel(banDurationHours);
    const baseContext = this.buildDuplicateContextLabel(true);

    if (decision.action === 'WARN') {
      const fallback = `Товарищ ${userLabel}, Майор Максимов на связи 👮‍♂️ Повтор по базе: сообщение ${baseContext}. Фиксирую предупреждение. Дальше без серий, договорились.`;
      return this.renderBotMessageTemplate(templateText, fallback, {
        user: userLabel,
        message_status: this.buildMessageStatusLabel(true),
        reason: 'в этом чате серийные повторы не проходят',
        duplicate_context: baseContext,
        sanction: 'Фиксирую предупреждение.',
        ban_duration: banDurationLabel,
      });
    }

    if (decision.action === 'KICK') {
      const fallback = `Товарищ ${userLabel}, Майор Максимов на связи 👮‍♂️ Повтор по базе: сообщение ${baseContext}. Пришлось вывести из чата. Дальше без серий, договорились.`;
      return this.renderBotMessageTemplate(templateText, fallback, {
        user: userLabel,
        message_status: this.buildMessageStatusLabel(true),
        reason: 'в этом чате серийные повторы не проходят',
        duplicate_context: baseContext,
        sanction: 'Пришлось вывести из чата.',
        ban_duration: banDurationLabel,
      });
    }

    const fallback = `Товарищ ${userLabel}, Майор Максимов на связи 👮‍♂️ Повтор по базе: сообщение ${baseContext}. Оформляю тайм-аут на ${banDurationLabel}. Дальше без серий, договорились.`;
    return this.renderBotMessageTemplate(templateText, fallback, {
      user: userLabel,
      message_status: this.buildMessageStatusLabel(true),
      reason: 'в этом чате серийные повторы не проходят',
      duplicate_context: baseContext,
      sanction: `Оформляю тайм-аут на ${banDurationLabel}.`,
      ban_duration: banDurationLabel,
    });
  }

  private buildDuplicateHitExplanation(
    userLabel: string,
    canDeleteMessage: boolean,
    templateText: string,
  ): string {
    const duplicateContext = this.buildDuplicateContextLabel(canDeleteMessage);
    const messageStatus = this.buildMessageStatusLabel(canDeleteMessage);
    const fallback = `Товарищ ${userLabel}, Майор Максимов на связи 👮‍♂️ Повтор по базе: сообщение ${duplicateContext}. Пока без взыскания. Дальше без серий, договорились.`;

    return this.renderBotMessageTemplate(templateText, fallback, {
      user: userLabel,
      message_status: messageStatus,
      reason: 'в этом чате серийные повторы не проходят',
      duplicate_context: duplicateContext,
      sanction: 'Пока без взыскания.',
    });
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

  private buildMessageStatusLabel(canDeleteMessage: boolean): string {
    return canDeleteMessage ? 'снято с линии' : 'не по форме';
  }

  private buildDuplicateContextLabel(canDeleteMessage: boolean): string {
    return canDeleteMessage ? 'снято с линии как дубль' : 'идёт повтором';
  }

  private escapeMaxMarkdownText(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/([*_`\[\]()~+])/g, '\\$1');
  }

  private formatUserLabel(senderName?: string): string {
    const normalized =
      typeof senderName === 'string' ? senderName.replace(/\s+/g, ' ').trim() : '';
    const safe = normalized.length > 0 ? this.escapeMaxMarkdownText(normalized) : 'Пользователь';
    return `**${safe}**`;
  }

  private async applySanctionAction(params: {
    chatId: string;
    userId: string;
    action: SanctionAction;
    userLabel: string;
    messageId: string;
    banDurationHours: number;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    botMessageOptions?: MaxSendMessageOptions;
    banNoticeText?: string;
  }) {
    const {
      chatId,
      userId,
      action,
      userLabel,
      messageId,
      banDurationHours,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      botMessageOptions,
      banNoticeText,
    } = params;
    if (action === SanctionAction.KICK) {
      await this.upsertGlobalUserBlacklistEntry({
        userId,
        sourceChatId: chatId,
        reason: 'KICK_SANCTION',
      });
      try {
        await this.maxClient.kickMember(chatId, userId);
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to kick member',
        );
      }
      return;
    }

    if (action !== SanctionAction.BAN) {
      return;
    }

    // Soft-ban mode: do not remove member from chat, enforce ban via active-ban auto-delete window.
    await this.sendBanNotice({
      chatId,
      userId,
      messageId,
      userLabel,
      banDurationHours,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      botMessageOptions,
      banNoticeText,
    });
  }

  private async sendBanNotice(params: {
    chatId: string;
    userId: string;
    messageId: string;
    userLabel: string;
    banDurationHours: number;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    botMessageOptions?: MaxSendMessageOptions;
    banNoticeText?: string;
  }) {
    const {
      chatId,
      userId,
      messageId,
      userLabel,
      banDurationHours,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      botMessageOptions,
      banNoticeText,
    } = params;
    const noticeText = banNoticeText ?? this.buildBanNotice(userLabel, banDurationHours);
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
        'Failed to send ban notice message',
      );
    }
  }

  private buildBanNotice(userLabel: string, banDurationHours: number): string {
    return `Товарищ ${userLabel}, оформляю тайм-аут на ${this.formatBanDurationLabel(banDurationHours)}. Возвращайтесь без нарушений.`;
  }

  private shouldResolveSanction(ruleCode: string): boolean {
    return !NON_SANCTION_RULE_CODES.has(ruleCode);
  }

  private resolveLinkEscalationAction(
    linkViolationCount24h: number,
    settings: { warnEnabled: boolean; banEnabled: boolean; kickEnabled: boolean },
  ): SanctionAction {
    const count = Number.isInteger(linkViolationCount24h) ? Math.max(1, linkViolationCount24h) : 1;

    if (count >= 4) {
      if (settings.kickEnabled) {
        return SanctionAction.KICK;
      }
      if (settings.banEnabled) {
        return SanctionAction.BAN;
      }
      if (settings.warnEnabled) {
        return SanctionAction.WARN;
      }
      return SanctionAction.NONE;
    }

    if (count === 3) {
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

  private resolveTextFilterEscalationAction(
    textFilterViolationCount24h: number,
    settings: { warnEnabled: boolean; banEnabled: boolean; kickEnabled: boolean },
  ): SanctionAction {
    const count = Number.isInteger(textFilterViolationCount24h)
      ? Math.max(1, textFilterViolationCount24h)
      : 1;

    if (count >= 4) {
      if (settings.kickEnabled) {
        return SanctionAction.KICK;
      }
      if (settings.banEnabled) {
        return SanctionAction.BAN;
      }
      if (settings.warnEnabled) {
        return SanctionAction.WARN;
      }
      return SanctionAction.NONE;
    }

    if (count === 3) {
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
    settings: { warnEnabled: boolean; banEnabled: boolean; kickEnabled: boolean },
  ): SanctionAction {
    const count = Number.isInteger(violationCount12h) ? Math.max(1, violationCount12h) : 1;

    if (count >= 4) {
      if (settings.kickEnabled) {
        return SanctionAction.KICK;
      }
      if (settings.banEnabled) {
        return SanctionAction.BAN;
      }
      if (settings.warnEnabled) {
        return SanctionAction.WARN;
      }
      return SanctionAction.NONE;
    }

    if (count === 3) {
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
    kickEnabled: boolean;
  } {
    if (ruleCode === 'PROFANITY') {
      return {
        botMessageEnabled: settings.profanityBotMessageEnabled,
        botMessageText: settings.textFiltersBotMessageText,
        warnEnabled: settings.profanityWarnEnabled,
        warnMessageText: settings.textFiltersWarnMessageText,
        banEnabled: settings.profanityBanEnabled,
        kickEnabled: settings.profanityKickEnabled,
      };
    }

    return {
      botMessageEnabled: settings.textFiltersBotMessageEnabled,
      botMessageText: settings.textFiltersBotMessageText,
      warnEnabled: settings.textFiltersWarnEnabled,
      warnMessageText: settings.textFiltersWarnMessageText,
      banEnabled: settings.textFiltersBanEnabled,
      kickEnabled: settings.textFiltersKickEnabled,
    };
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
  ): string {
    const messageStatus = this.buildMessageStatusLabel(canDeleteMessage);

    if (ruleCode === 'PROFANITY') {
      const reason = 'грубая лексика запрещена правилами чата';
      const fallback = this.buildMajorExplanationFallback(
        userLabel,
        'Сообщение',
        messageStatus,
        reason,
      );
      return this.renderBotMessageTemplate(templateText, fallback, {
        user: userLabel,
        message_status: messageStatus,
        reason,
      });
    }

    const reason = 'коммерческая реклама в этом чате запрещена';
    const fallback = this.buildMajorExplanationFallback(
      userLabel,
      'Сообщение',
      messageStatus,
      reason,
    );
    return this.renderBotMessageTemplate(templateText, fallback, {
      user: userLabel,
      message_status: messageStatus,
      reason,
    });
  }

  private buildMessageLimitsExplanation(
    userLabel: string,
    ruleCode: string,
    canDeleteMessage: boolean,
    photoCooldownHours: number,
    stickerCooldownMinutes: number,
    messageLength?: number,
    maxMessageLength?: number,
    templateText?: string,
  ): string {
    const messageStatus = this.buildMessageStatusLabel(canDeleteMessage);

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
      const fallback = this.buildMajorExplanationFallback(
        userLabel,
        'Сообщение',
        messageStatus,
        `${reason}${actualLength !== null && maxLength !== null ? '.' : ''}`.replace(/\.$/u, ''),
      );
      return this.renderBotMessageTemplate(templateText ?? '', fallback, {
        user: userLabel,
        message_status: messageStatus,
        reason,
        actual_length: actualLength !== null ? String(actualLength) : '',
        max_length: maxLength !== null ? String(maxLength) : '',
      });
    }

    if (ruleCode === 'VIDEO_BLOCKED') {
      const reason = 'видео в этом чате отключены';
      const fallback = this.buildMajorExplanationFallback(
        userLabel,
        'Сообщение',
        messageStatus,
        reason,
      );
      return this.renderBotMessageTemplate(templateText ?? '', fallback, {
        user: userLabel,
        message_status: messageStatus,
        reason,
      });
    }

    if (ruleCode === 'FILE_BLOCKED') {
      const reason = 'файлы в этом чате отключены';
      const fallback = this.buildMajorExplanationFallback(
        userLabel,
        'Сообщение',
        messageStatus,
        reason,
      );
      return this.renderBotMessageTemplate(templateText ?? '', fallback, {
        user: userLabel,
        message_status: messageStatus,
        reason,
      });
    }

    if (ruleCode === 'VOICE_BLOCKED') {
      const reason = 'голосовые сообщения в этом чате отключены';
      const fallback = this.buildMajorExplanationFallback(
        userLabel,
        'Сообщение',
        messageStatus,
        reason,
      );
      return this.renderBotMessageTemplate(templateText ?? '', fallback, {
        user: userLabel,
        message_status: messageStatus,
        reason,
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
      const fallback = this.buildMajorExplanationFallback(
        userLabel,
        'Сообщение',
        messageStatus,
        reason,
      );
      return this.renderBotMessageTemplate(templateText ?? '', fallback, {
        user: userLabel,
        message_status: messageStatus,
        reason,
      });
    }

    const hours =
      Number.isInteger(photoCooldownHours) && photoCooldownHours >= 1 && photoCooldownHours <= 24
        ? photoCooldownHours
        : 1;
    const reason = `слишком частая отправка фото: не чаще одного раза в ${hours}ч. Если фото несколько, лучше собрать их в альбом или коллаж`;
    const fallback = this.buildMajorExplanationFallback(
      userLabel,
      'Сообщение',
      messageStatus,
      reason,
    );
    return this.renderBotMessageTemplate(templateText ?? '', fallback, {
      user: userLabel,
      message_status: messageStatus,
      reason,
      photo_cooldown_hours: String(hours),
    });
  }

  private buildMessageLimitsKickExplanation(userLabel: string, ruleCode: string): string {
    return `Товарищ ${userLabel}, за повторные нарушения пришлось вывести вас из чата. Причина: ${this.resolveMessageLimitsSanctionReasonLabel(ruleCode)}.`;
  }

  private buildMessageLimitsWarnExplanation(userLabel: string, ruleCode: string): string {
    return `Товарищ ${userLabel}, фиксирую предупреждение. Причина: ${this.resolveMessageLimitsSanctionReasonLabel(ruleCode)}.`;
  }

  private buildMessageLimitsBanExplanation(
    userLabel: string,
    ruleCode: string,
    banDurationHours: number,
  ): string {
    const durationLabel = this.formatBanDurationLabel(banDurationHours);
    return `Товарищ ${userLabel}, оформляю тайм-аут на ${durationLabel}. Причина: ${this.resolveMessageLimitsSanctionReasonLabel(ruleCode)}.`;
  }

  private resolveMessageLimitsSanctionReasonLabel(ruleCode: string): string {
    if (ruleCode === 'PHOTO_RATE_LIMIT') {
      return 'слишком частая отправка фото';
    }

    if (ruleCode === 'STICKER_RATE_LIMIT') {
      return 'слишком частая отправка стикеров';
    }

    if (ruleCode === 'MESSAGE_TOO_LONG') {
      return 'слишком длинное сообщение';
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

    const since = new Date(Date.now() - LINK_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000);
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

    const since = new Date(Date.now() - TEXT_FILTER_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000);
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

    const since = new Date(Date.now() - TOPIC_FILTER_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000);
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

    const since = new Date(Date.now() - MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000);
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

  private async getActiveBan(
    chatId: string,
    userId: string,
    fallbackBanDurationHours: number,
  ): Promise<ActiveBan | null> {
    const latestBan = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId,
        action: SanctionAction.BAN,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        createdAt: true,
        metadata: true,
      },
    });

    if (!latestBan) {
      return null;
    }

    const durationHours = this.readBanDurationHoursFromMetadata(
      latestBan.metadata,
      fallbackBanDurationHours,
    );
    const expiresAt = new Date(latestBan.createdAt.getTime() + durationHours * 60 * 60 * 1000);
    if (expiresAt.getTime() <= Date.now()) {
      return null;
    }

    return {
      eventId: latestBan.id,
      issuedAt: latestBan.createdAt,
      expiresAt,
      durationHours,
    };
  }

  private async handleActiveBanMessage(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    ban: ActiveBan;
  }) {
    const { chatId, userId, messageId, text, createdAt, ban } = params;
    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;

    if (!canDeleteMessage) {
      await this.maxClient.notifyModerators(
        chatId,
        `Сообщение от ${userId} попало под активный бан, но старше 24 часов и не может быть удалено`,
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
          ruleCode: 'BAN_ACTIVE_DELETE',
          action: SanctionAction.DELETE_MESSAGE,
          maskedExcerpt: maskText(text),
          score: 1,
          operator: Operator.BOT,
          metadata: {
            reason: 'Message removed during active ban window',
            banEventId: ban.eventId,
            banIssuedAt: ban.issuedAt.toISOString(),
            banExpiresAt: ban.expiresAt.toISOString(),
            banDurationHours: ban.durationHours,
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
        'Failed to delete message during active ban',
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
    const safeDelayMinutes = this.normalizeDeleteBotMessagesDelayMinutes(delayMinutes);

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
    greetingBotMessageText: string;
    greetingBotButtonEnabled: boolean;
    greetingBotButtonUrl: string;
    greetingBotButtonText: string;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    excludedUserIds: ReadonlySet<string>;
  }) {
    const {
      chatId,
      messageId,
      update,
      greetingBotMessageEnabled,
      greetingBotMessageText,
      greetingBotButtonEnabled,
      greetingBotButtonUrl,
      greetingBotButtonText,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      excludedUserIds,
    } = params;

    if (!greetingBotMessageEnabled) {
      return;
    }

    const joinedMembers = this.extractHumanServiceMembers(update);
    if (joinedMembers.length === 0) {
      return;
    }

    const greetingMessageOptions = this.buildBotMessageOptions(
      chatId,
      greetingBotButtonEnabled,
      greetingBotButtonUrl,
      greetingBotButtonText,
    );

    for (const member of joinedMembers) {
      if (excludedUserIds.has(member.userId)) {
        continue;
      }
      const greetingMessage = this.buildGreetingMessage(member.userLabel, greetingBotMessageText);
      try {
        await this.sendBotMessageWithOptionalAutoDelete({
          chatId,
          text: greetingMessage,
          messageOptions: greetingMessageOptions ?? undefined,
          deleteBotMessagesEnabled,
          deleteBotMessagesDelayMinutes,
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

      const userLabel = this.formatUserLabel(this.readDisplayNameFromEntity(row) ?? undefined);
      members.set(userId, { userId, userLabel });
    }

    return [...members.values()];
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

  private buildGreetingMessage(userLabel: string, templateText: string): string {
    const fallback = `Здравия желаю, ${userLabel}. Майор Максимов на связи 🤝 Добро пожаловать в чат.`;
    return this.renderBotMessageTemplate(templateText, fallback, {
      user: userLabel,
      greeting: 'добро пожаловать в чат',
    });
  }

  private async handleGloballyBlacklistedSenderMessage(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
  }): Promise<boolean> {
    const { chatId, userId, messageId, text } = params;
    const isBlacklisted = await this.isUserGloballyBlacklisted(userId);
    if (!isBlacklisted) {
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
        'Failed to delete message from globally blacklisted user',
      );
    }

    await this.kickAndLogGlobalBlacklistEvent({
      chatId,
      userId,
      messageId,
      text,
      reason: 'Sender is included in global user blacklist',
    });
    return true;
  }

  private async handleServiceGloballyBlacklistedMembersEvent(params: {
    chatId: string;
    messageId: string;
    text: string;
    update: MaxUpdate;
  }): Promise<string[]> {
    const { chatId, messageId, text, update } = params;
    const serviceMemberUserIds = this.extractServiceMemberUserIds(update);
    const kickedUserIds = new Set<string>();
    if (serviceMemberUserIds.length === 0) {
      return [];
    }

    if (!this.prisma.globalUserBlacklist?.findMany) {
      return [];
    }

    const rows = await this.prisma.globalUserBlacklist.findMany({
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

    for (const row of rows) {
      kickedUserIds.add(row.userId);
      await this.kickAndLogGlobalBlacklistEvent({
        chatId,
        userId: row.userId,
        messageId,
        text,
        reason: 'Member was added via service event and is globally blacklisted',
      });
    }

    return [...kickedUserIds];
  }

  private async kickAndLogGlobalBlacklistEvent(params: {
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
          ruleCode: 'GLOBAL_USER_BLACKLIST_KICK',
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
        'Failed to kick globally blacklisted user',
      );
    }
  }

  private async handleGlobalCrossChatSpamMessage(params: {
    chatId: string;
    userId: string;
    userLabel: string;
    messageId: string;
    text: string;
    createdAt: string;
    update: MaxUpdate;
    scopeAdminIds: string[];
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    mediaFlags: {
      hasPhotoAttachment: boolean;
      hasVideoAttachment: boolean;
      hasFileAttachment: boolean;
      hasVoiceAttachment: boolean;
    };
  }): Promise<boolean> {
    if (!this.redisCounter) {
      return false;
    }

    const {
      chatId,
      userId,
      userLabel,
      messageId,
      text,
      createdAt,
      update,
      scopeAdminIds,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      mediaFlags,
    } = params;
    if (scopeAdminIds.length === 0) {
      return false;
    }
    const signature = this.buildGlobalCrossChatSpamSignature({
      text,
      update,
      mediaFlags,
    });
    if (!signature) {
      return false;
    }

    let uniqueChatsCount: number;

    try {
      const spreadStates = await Promise.all(
        scopeAdminIds.map((scopeAdminId) =>
          this.redisCounter!.addToSetWithTtl(
            this.buildGlobalCrossChatSpamRedisKey(scopeAdminId, userId, signature),
            chatId,
            GLOBAL_CROSS_CHAT_SPAM_WINDOW_SEC + 5,
          ),
        ),
      );
      uniqueChatsCount = spreadStates.reduce(
        (max, spreadState) => Math.max(max, spreadState.size),
        0,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          scopeAdminIds,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to evaluate global cross-chat spam state',
      );
      return false;
    }

    if (uniqueChatsCount < GLOBAL_CROSS_CHAT_SPAM_MIN_CHATS) {
      return false;
    }

    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;
    if (!canDeleteMessage) {
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
          uniqueChatsCount,
          scopeAdminIds,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to delete global cross-chat spam message',
      );
      return false;
    }

    await this.prisma.violation.create({
      data: {
        chatId,
        userId,
        ruleCode: 'GLOBAL_CROSS_CHAT_SPAM',
        score: 0.94,
      },
    });

    await this.prisma.moderationEvent.create({
      data: {
        chatId,
        userId,
        messageId,
        eventType: EventType.MESSAGE,
        ruleCode: 'GLOBAL_CROSS_CHAT_SPAM_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
        maskedExcerpt: maskText(text),
        score: 0.94,
        operator: Operator.BOT,
        metadata: {
          reason: 'Same payload was sent to multiple chats in a short window',
          uniqueChatsCount,
          windowSec: GLOBAL_CROSS_CHAT_SPAM_WINDOW_SEC,
          signatureKind: signature.kind,
          scopeAdminIds,
        },
      },
    });

    try {
      await this.sendBotMessageWithOptionalAutoDelete({
        chatId,
        text: this.buildGlobalCrossChatSpamNotice(userLabel, uniqueChatsCount),
        deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          uniqueChatsCount,
          scopeAdminIds,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to send global cross-chat spam notice',
      );
    }

    return true;
  }

  private buildGlobalCrossChatSpamSignature(params: {
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

  private buildGlobalCrossChatSpamRedisKey(
    scopeAdminId: string,
    userId: string,
    signature: { kind: 'text' | 'photo' | 'forwarded'; hash: string },
  ): string {
    return `cross-chat-spam:v2:${scopeAdminId}:${userId}:${signature.kind}:${signature.hash}`;
  }

  private buildGlobalCrossChatSpamNotice(userLabel: string, uniqueChatsCount: number): string {
    return `Товарищ ${userLabel}, сообщение снято с линии: одинаковый текст или фото улетели в ${uniqueChatsCount} чатов за 2 минуты. Похоже на кросс-чат спам.`;
  }

  private async resolveGlobalCrossChatSpamAdminScopeIds(params: {
    chatId: string;
    chatSettingEnabled: boolean;
    localAdminUserIds: string[] | undefined;
  }): Promise<string[]> {
    const { chatId, chatSettingEnabled, localAdminUserIds } = params;
    const currentAdminScopeIds = await this.resolveCurrentChatAdminScopeIds(
      chatId,
      localAdminUserIds,
    );
    if (currentAdminScopeIds.length === 0) {
      return [];
    }

    if (chatSettingEnabled) {
      return currentAdminScopeIds;
    }

    const cacheKey = `${chatId}:${currentAdminScopeIds.join(',')}`;
    const now = Date.now();
    const cached = this.globalCrossChatSpamScopeCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.adminScopeIds;
    }

    const adminScopeIds =
      await this.findEnabledGlobalCrossChatSpamAdminScopeIds(currentAdminScopeIds);
    this.globalCrossChatSpamScopeCache.set(cacheKey, {
      expiresAt: now + GLOBAL_CROSS_CHAT_SPAM_SCOPE_CACHE_TTL_MS,
      adminScopeIds,
    });
    return adminScopeIds;
  }

  private async resolveCurrentChatAdminScopeIds(
    chatId: string,
    localAdminUserIds: string[] | undefined,
  ): Promise<string[]> {
    const remoteAdminIds = await this.getRemoteChatAdminIds(chatId);
    const sourceAdminIds =
      remoteAdminIds && remoteAdminIds.size > 0
        ? Array.from(remoteAdminIds)
        : Array.isArray(localAdminUserIds)
          ? localAdminUserIds
          : [];

    const adminScopeIds = new Set<string>();
    for (const adminUserId of sourceAdminIds) {
      const canonical = this.normalizeCrossChatSpamAdminScopeId(adminUserId);
      if (canonical) {
        adminScopeIds.add(canonical);
      }
    }

    return Array.from(adminScopeIds).sort();
  }

  private async findEnabledGlobalCrossChatSpamAdminScopeIds(
    currentAdminScopeIds: readonly string[],
  ): Promise<string[]> {
    if (
      currentAdminScopeIds.length === 0 ||
      typeof this.prisma.chatAdminAllowlist?.findMany !== 'function'
    ) {
      return [];
    }

    const candidateUserIds = Array.from(
      new Set(
        currentAdminScopeIds.flatMap((adminScopeId) =>
          Array.from(this.buildUserIdVariants(adminScopeId)),
        ),
      ),
    );
    const currentAdminScopeIdSet = new Set(currentAdminScopeIds);
    const rows = await this.prisma.chatAdminAllowlist.findMany({
      where: {
        userId: {
          in: candidateUserIds,
        },
        chat: {
          settings: {
            is: {
              globalCrossChatSpamEnabled: true,
            },
          },
        },
      },
      select: {
        userId: true,
      },
    });

    const enabledAdminScopeIds = new Set<string>();
    for (const row of rows) {
      const canonical = this.normalizeCrossChatSpamAdminScopeId(row.userId);
      if (canonical && currentAdminScopeIdSet.has(canonical)) {
        enabledAdminScopeIds.add(canonical);
      }
    }

    return Array.from(enabledAdminScopeIds).sort();
  }

  private normalizeCrossChatSpamAdminScopeId(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    if (/^id\d+$/u.test(normalized)) {
      return normalized.slice(2);
    }

    return normalized;
  }

  private async isGlobalUserBlacklistEnabled(chatSettingEnabled: boolean): Promise<boolean> {
    if (chatSettingEnabled) {
      this.globalUserBlacklistEnabledCache = {
        value: true,
        checkedAt: Date.now(),
      };
      return true;
    }

    const now = Date.now();
    if (
      this.globalUserBlacklistEnabledCache &&
      now - this.globalUserBlacklistEnabledCache.checkedAt <= GLOBAL_BLACKLIST_TOGGLE_CACHE_TTL_MS
    ) {
      return this.globalUserBlacklistEnabledCache.value;
    }

    const enabledSomewhere = await this.prisma.chatSettings?.findFirst({
      where: {
        globalUserBlacklistEnabled: true,
      },
      select: {
        chatId: true,
      },
    });
    const value = Boolean(enabledSomewhere);
    this.globalUserBlacklistEnabledCache = {
      value,
      checkedAt: now,
    };
    return value;
  }

  private async isUserGloballyBlacklisted(userId: string): Promise<boolean> {
    const row = await this.prisma.globalUserBlacklist?.findUnique({
      where: {
        userId,
      },
      select: {
        userId: true,
      },
    });
    return Boolean(row);
  }

  private async upsertGlobalUserBlacklistEntry(params: {
    userId: string;
    sourceChatId: string;
    reason: string;
  }) {
    const { userId, sourceChatId, reason } = params;
    if (!this.prisma.globalUserBlacklist?.upsert) {
      return;
    }

    try {
      await this.prisma.globalUserBlacklist.upsert({
        where: {
          userId,
        },
        create: {
          userId,
          sourceChatId,
          reason,
        },
        update: {
          sourceChatId,
          reason,
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
        'Failed to upsert global user blacklist entry',
      );
    }
  }

  private async processNightModeAnnouncements() {
    if (this.nightModeAnnounceInFlight || !roleRunsModeration(getAppRole())) {
      return;
    }

    this.nightModeAnnounceInFlight = true;
    try {
      const nightModeChats = await this.prisma.chatSettings.findMany({
        where: {
          nightModeEnabled: true,
          nightModeBotMessageEnabled: true,
        },
        select: {
          chatId: true,
          deleteBotMessagesEnabled: true,
          deleteBotMessagesDelayMinutes: true,
          nightModeStartTimeMinutes: true,
          nightModeEndTimeMinutes: true,
          nightModeTimezone: true,
          nightModeBotMessageText: true,
          nightModeBotButtonEnabled: true,
          nightModeBotButtonUrl: true,
          nightModeBotButtonText: true,
        },
      });

      for (const settings of nightModeChats) {
        const startMinutes = this.normalizeDayMinutes(settings.nightModeStartTimeMinutes, 23 * 60);
        const endMinutes = this.normalizeDayMinutes(settings.nightModeEndTimeMinutes, 8 * 60);
        const timezone = this.normalizeNightModeTimezone(settings.nightModeTimezone);

        if (!this.isNightModeStartMomentNow(startMinutes, timezone)) {
          continue;
        }

        const nightSessionKey = this.buildNightModeSessionKey(startMinutes, endMinutes, timezone);
        const noticeAlreadySent = await this.wasNightModeNoticeSent(
          settings.chatId,
          nightSessionKey,
        );
        if (noticeAlreadySent) {
          continue;
        }

        const messageText = this.buildNightModeClosedNotice(
          startMinutes,
          endMinutes,
          timezone,
          settings.nightModeBotMessageText,
        );
        const nightModeMessageOptions = this.buildBotMessageOptions(
          settings.chatId,
          settings.nightModeBotButtonEnabled,
          settings.nightModeBotButtonUrl,
          settings.nightModeBotButtonText,
        );

        try {
          await this.sendBotMessageWithOptionalAutoDelete({
            chatId: settings.chatId,
            text: messageText,
            messageOptions: nightModeMessageOptions ?? undefined,
            deleteBotMessagesEnabled: false,
            deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
          });

          await this.prisma.moderationEvent.create({
            data: {
              chatId: settings.chatId,
              userId: 'system',
              eventType: EventType.SYSTEM,
              ruleCode: NIGHT_MODE_NOTICE_RULE_CODE,
              action: SanctionAction.NONE,
              score: 0,
              operator: Operator.BOT,
              metadata: {
                reason: 'Night mode notice sent by schedule',
                nightSessionKey,
                nightModeTimezone: timezone,
                nightModeStartTime: this.formatMinutesAsTime(startMinutes),
                nightModeEndTime: this.formatMinutesAsTime(endMinutes),
              },
            },
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
        await this.maxClient.deleteMessage(chatId, messageId);
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
          'Failed to delete message during night mode',
        );
      }
    } else {
      await this.maxClient.notifyModerators(
        chatId,
        `Сообщение от ${userId} попало в закрытие чата на ночь, но старше 24 часов и не может быть удалено`,
      );
    }
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

  private isNightModeStartMomentNow(startMinutes: number, timezone: string): boolean {
    const currentMinutes = this.getCurrentMinutesInTimeZone(timezone);
    return currentMinutes !== null && currentMinutes === startMinutes;
  }

  private isBotStartedUpdate(update: MaxUpdate): boolean {
    return this.readLowerString(update.type) === 'bot_started';
  }

  private isMembershipLeaveUpdate(update: MaxUpdate): boolean {
    const normalizedType = this.readLowerString(update.type);
    return normalizedType === 'user_removed' || normalizedType === 'bot_removed';
  }

  private async handleBotStartedInstruction(update: MaxUpdate, chatId: string) {
    if (!this.shouldSendBotStartedInstruction(update, chatId)) {
      return;
    }

    try {
      await this.maxClient.sendMessage(
        chatId,
        BOT_STARTED_INSTRUCTION_TEXT,
        BOT_STARTED_INSTRUCTION_OPTIONS,
      );
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
      await this.sendPrivateMenu(
        chatId,
        'Команду не понял. Нажмите кнопку ниже или используйте /menu.',
      );
      return;
    }

    await this.sendPrivateMenu(chatId, PRIVATE_MENU_PROMPT_TEXT);
  }

  private buildPrivateCallbackNotification(command: PrivateControlCommand | null): string {
    if (command === 'chats') {
      return 'Собираю список чатов';
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

    if (!existingVote || existingVote.optionIndex !== pollCallback.optionIndex) {
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
    }

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

    await this.maxClient.editMessageInlineKeyboard(chatId, sourceMessageId, text, {
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
    });

    if (callbackId) {
      await this.answerCallbackSafe(callbackId, notification);
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
      await this.sendPrivateChatList(chatId);
      return;
    }

    await this.sendPrivateMenu(chatId, PRIVATE_MENU_PROMPT_TEXT);
  }

  private async sendPrivateChatList(chatId: string): Promise<void> {
    try {
      const chats = await this.maxClient.listBotChats();
      const groupChats = chats.filter((chat) => {
        const numericChatId = this.parseChatIdAsBigInt(chat.chatId);
        return numericChatId !== null && numericChatId < 0n;
      });

      if (groupChats.length === 0) {
        await this.sendPrivateMenu(
          chatId,
          'Пока нет групповых чатов с ботом. Добавьте бота в чат и выдайте права администратора.',
        );
        return;
      }

      const preview = groupChats.slice(0, PRIVATE_BOT_CHATS_PREVIEW_LIMIT);
      const lines = preview.map((chat, index) => {
        const title = (chat.title ?? `Чат ${chat.chatId}`).replace(/\s+/g, ' ').trim();
        return `${index + 1}. ${title} (${chat.chatId})`;
      });

      const moreCount = groupChats.length - preview.length;
      const message = [
        `Чаты с ботом: ${groupChats.length}`,
        '',
        ...lines,
        ...(moreCount > 0 ? ['', `... и ещё ${moreCount} чатов.`] : []),
        '',
        'Для подробной настройки откройте приложение.',
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
    const botContactId = this.resolveBotContactId();
    const miniappButton: MaxMessageButton =
      miniappUrl && botContactId
        ? {
            type: 'open_app',
            text: 'Открыть приложение',
            webApp: miniappUrl,
            contactId: botContactId,
          }
        : {
            type: 'link',
            text: 'Открыть приложение',
            url: miniappUrl ?? 'https://maxim.play-team.ru/app/',
          };

    const buttons: MaxSendMessageOptions['buttons'] = [
      [
        {
          type: 'callback',
          text: 'Меню',
          payload: PRIVATE_MENU_CALLBACK_MENU,
        },
        {
          type: 'callback',
          text: 'Мои чаты',
          payload: PRIVATE_MENU_CALLBACK_CHATS,
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
  ): Promise<ChatAdminCheckResult> {
    const localIsAdmin = this.isSenderChatAdmin(localAdminUserIds, userId);
    const remoteAdminIds = await this.getRemoteChatAdminIds(chatId);
    if (remoteAdminIds) {
      let remoteIsAdmin = false;
      for (const variant of this.buildUserIdVariants(userId)) {
        if (remoteAdminIds.has(variant)) {
          remoteIsAdmin = true;
          break;
        }
      }

      if (remoteIsAdmin && localIsAdmin) {
        return { isAdmin: true, source: 'remote+local' };
      }
      if (remoteIsAdmin) {
        return { isAdmin: true, source: 'remote' };
      }
      if (localIsAdmin) {
        return { isAdmin: true, source: 'local' };
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

  private async getRemoteChatAdminIds(chatId: string): Promise<Set<string> | null> {
    const now = Date.now();
    const cached = this.chatAdminCache.get(chatId);
    if (cached && cached.expiresAt > now) {
      return cached.adminUserIds;
    }

    const cachedFromSharedStore = await this.readChatAdminsFromSharedCache(chatId, now);
    if (cachedFromSharedStore) {
      return cachedFromSharedStore;
    }

    const getChatAdminIds = (this.maxClient as Partial<MaxClientService>).getChatAdminIds;
    if (typeof getChatAdminIds !== 'function') {
      return null;
    }

    try {
      const rawAdminUserIds = await getChatAdminIds.call(this.maxClient, chatId);
      if (!Array.isArray(rawAdminUserIds)) {
        return null;
      }

      const adminUserIds = rawAdminUserIds;
      const normalizedAdminUserIds = new Set<string>();
      for (const adminUserId of adminUserIds) {
        for (const variant of this.buildUserIdVariants(adminUserId)) {
          normalizedAdminUserIds.add(variant);
        }
      }

      this.chatAdminCache.set(chatId, {
        expiresAt: now + CHAT_ADMIN_CACHE_TTL_MS,
        adminUserIds: normalizedAdminUserIds,
      });
      await this.writeChatAdminsToSharedCache(chatId, normalizedAdminUserIds);

      return normalizedAdminUserIds;
    } catch (error: unknown) {
      this.chatAdminCache.delete(chatId);
      this.logger.warn(
        {
          chatId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to resolve chat admins for moderation bypass',
      );
      return null;
    }
  }

  private buildChatAdminSharedCacheKey(chatId: string): string {
    return `${CHAT_ADMIN_SHARED_CACHE_KEY_PREFIX}:${chatId}`;
  }

  private async readChatAdminsFromSharedCache(
    chatId: string,
    nowMs: number,
  ): Promise<Set<string> | null> {
    const getString = (this.redisCounter as Partial<RedisCounterService> | undefined)?.getString;
    if (typeof getString !== 'function') {
      return null;
    }

    const key = this.buildChatAdminSharedCacheKey(chatId);
    let rawValue: string | null = null;
    try {
      rawValue = await getString.call(this.redisCounter, key);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to read chat admins from shared cache',
      );
      return null;
    }

    if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (!Array.isArray(parsed)) {
        return null;
      }

      const adminUserIds = new Set<string>();
      for (const value of parsed) {
        if (typeof value !== 'string') {
          continue;
        }

        const normalizedValue = value.trim().toLowerCase();
        if (!normalizedValue) {
          continue;
        }
        adminUserIds.add(normalizedValue);
      }

      this.chatAdminCache.set(chatId, {
        expiresAt: nowMs + CHAT_ADMIN_CACHE_TTL_MS,
        adminUserIds,
      });

      return adminUserIds;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to parse chat admins from shared cache',
      );
      return null;
    }
  }

  private async writeChatAdminsToSharedCache(
    chatId: string,
    adminUserIds: Set<string>,
  ): Promise<void> {
    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (typeof setStringWithTtl !== 'function') {
      return;
    }

    try {
      await setStringWithTtl.call(
        this.redisCounter,
        this.buildChatAdminSharedCacheKey(chatId),
        JSON.stringify([...adminUserIds]),
        CHAT_ADMIN_CACHE_TTL_SEC,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to write chat admins to shared cache',
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
  ): string {
    const currentMinutes = this.getCurrentMinutesInTimeZone(timezone);
    const wrapsMidnight = startMinutes > endMinutes;
    const inAfterMidnightSegment =
      wrapsMidnight && currentMinutes !== null && currentMinutes < endMinutes;
    const referenceTime = inAfterMidnightSegment
      ? new Date(Date.now() - 24 * 60 * 60 * 1000)
      : new Date();
    const dateKey = this.formatDateKeyInTimeZone(referenceTime, timezone);
    return `${timezone}|${startMinutes}-${endMinutes}|${dateKey}`;
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

  private async wasNightModeNoticeSent(chatId: string, nightSessionKey: string): Promise<boolean> {
    const existingNotice = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        ruleCode: NIGHT_MODE_NOTICE_RULE_CODE,
        metadata: {
          path: ['nightSessionKey'],
          equals: nightSessionKey,
        },
      },
      select: {
        id: true,
      },
    });

    return Boolean(existingNotice);
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
  ): string {
    const windowLabel = `${this.formatMinutesAsTime(startMinutes)}-${this.formatMinutesAsTime(endMinutes)}`;
    const timezoneLabel = timezone === DEFAULT_NIGHT_MODE_TIMEZONE ? 'Москва' : timezone;
    const nightStatus = 'Новые сообщения временно не принимаются.';
    const fallback = `Ночной режим, граждане 🌙 Участок закрыт на ${windowLabel} (${timezoneLabel}). ${nightStatus}`;

    return this.renderBotMessageTemplate(templateText, fallback, {
      user: '',
      night_window: windowLabel,
      night_timezone: timezoneLabel,
      night_status: nightStatus,
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
    if (!senderId || !messageId) {
      return;
    }

    if (
      this.isOwnBotSender(senderId) ||
      this.isBotAuthoredMessage(update) ||
      this.isServiceAuthoredMessage(update)
    ) {
      return;
    }

    const senderAdminCheck = await this.resolveSenderChatAdminCheck(
      chatId,
      managedChannel.adminUserIds,
      senderId,
    );
    if (!senderAdminCheck.isAdmin) {
      return;
    }

    await this.tryAutoAttachChannelMessageButtons({
      chatId,
      messageId,
      text: typeof text === 'string' && text.trim() ? text : null,
      managedChannel,
      source: 'webhook',
      senderId,
    });
  }

  private async processChannelAutoPostButtons(): Promise<void> {
    if (this.channelAutoPostInFlight) {
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
      });

      for (const channelSettings of channels) {
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
        }
      }
    } finally {
      this.channelAutoPostInFlight = false;
    }
  }

  private async processManagedChannelAutoPostButtons(
    managedChannel: ManagedChannelContext,
  ): Promise<void> {
    const messages = await this.maxClient.listMessages(managedChannel.channelSettings.chatId, 10);

    for (const message of messages) {
      const normalized = this.parseChannelListedMessage(message);
      if (!normalized) {
        continue;
      }
      if (normalized.timestampMs < managedChannel.channelSettings.updatedAt.getTime()) {
        continue;
      }
      if (normalized.hasInlineKeyboard) {
        continue;
      }

      await this.tryAutoAttachChannelMessageButtons({
        chatId: managedChannel.channelSettings.chatId,
        messageId: normalized.messageId,
        text: normalized.text,
        managedChannel,
        source: 'poll',
        senderId: null,
      });
    }
  }

  private parseChannelListedMessage(message: Record<string, unknown>): {
    messageId: string;
    text: string | null;
    timestampMs: number;
    hasInlineKeyboard: boolean;
  } | null {
    const body = this.asRecord(message.body);
    const messageIdCandidate = body?.mid;
    const timestampCandidate = message.timestamp;
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
      text: typeof body?.text === 'string' && body.text.trim() ? body.text : null,
      timestampMs,
      hasInlineKeyboard,
    };
  }

  private async tryAutoAttachChannelMessageButtons(params: {
    chatId: string;
    messageId: string;
    text: string | null;
    managedChannel: ManagedChannelContext;
    source: 'webhook' | 'poll';
    senderId: string | null;
  }): Promise<void> {
    const { chatId, messageId, text, managedChannel, source, senderId } = params;
    const { includeCommentsButton, includeSuggestButton } = this.resolveChannelAutoPostButtons(
      managedChannel.channelSettings,
    );
    if (!includeCommentsButton && !includeSuggestButton) {
      return;
    }

    const alreadyAttached = await this.prisma.auditLog.findFirst({
      where: {
        chatId,
        action: CHANNEL_DIALOG_AUTO_ATTACH_ACTION,
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

    try {
      await this.maxClient.editMessageInlineKeyboard(chatId, messageId, text, {
        buttons,
        debugContext: {
          screen: 'channel-auto-post',
          action: source === 'poll' ? 'scan-attach-buttons' : 'attach-buttons',
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
          'Failed to auto-attach channel post buttons; skipping retry',
        );
        return;
      }
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
          autoPostButtonsMode: managedChannel.channelSettings.autoPostButtonsMode,
          source,
        },
      },
    });
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

  private resolveChannelAutoPostButtons(
    settings: Pick<
      PersistedChannelSettings,
      'autoPostButtonsMode' | 'postSuggestionsEnabled' | 'commentsEnabled'
    >,
  ) {
    return {
      includeCommentsButton:
        settings.autoPostButtonsMode === 'COMMENTS' || settings.autoPostButtonsMode === 'BOTH'
          ? true
          : settings.autoPostButtonsMode === 'OFF'
            ? settings.commentsEnabled
            : false,
      includeSuggestButton: settings.postSuggestionsEnabled,
    };
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
      rows.push([this.buildChannelDialogButton(chatId, 'comments', threadId, '💬 Комментарии')]);
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

  private buildChannelDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
  ): MaxMessageButton {
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

  private buildChannelDialogLaunchUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    const startParam = this.buildChannelDialogStartParam(chatId, type, threadId);
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

  private buildMiniappStartUrl(startParam: string): string | null {
    if (!this.ownBotUserId) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.ownBotUserId)}?startapp=${encodeURIComponent(startParam)}`;
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
        if (!resolvedUrl) {
          return null;
        }

        return [
          row.chatId,
          {
            publishedUrl: resolvedUrl,
            publishedMessageId: row.publishedMessageId ?? null,
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
      | 'nightModeStartTimeMinutes'
      | 'nightModeEndTimeMinutes'
      | 'nightModeTimezone'
      | 'nightModeBotMessageText'
    >;
  }): boolean {
    if (!params.settings.nightModeEnabled || !params.settings.nightModeBotMessageEnabled) {
      return false;
    }

    const normalizedMessage = this.normalizeTextForComparison(params.text);
    if (!normalizedMessage) {
      return false;
    }

    const expectedNotice = this.buildNightModeClosedNotice(
      params.settings.nightModeStartTimeMinutes,
      params.settings.nightModeEndTimeMinutes,
      params.settings.nightModeTimezone,
      params.settings.nightModeBotMessageText,
    );

    return normalizedMessage === this.normalizeTextForComparison(expectedNotice);
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
        this.normalizeDeleteBotMessagesDelayMinutes(params.deleteBotMessagesDelayMinutes) *
        60 *
        1000;
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

  private normalizeDeleteBotMessagesDelayMinutes(value: number): number {
    if (!Number.isInteger(value)) {
      return DEFAULT_BOT_MESSAGES_DELETE_DELAY_MINUTES;
    }

    return Math.min(
      BOT_MESSAGES_DELETE_DELAY_MAX_MINUTES,
      Math.max(BOT_MESSAGES_DELETE_DELAY_MIN_MINUTES, value),
    );
  }

  private readBanDurationHoursFromMetadata(metadata: unknown, fallback: number): number {
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const value = (metadata as Record<string, unknown>).banDurationHours;
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 36) {
        return value;
      }
    }

    if (Number.isInteger(fallback) && fallback >= 1 && fallback <= 36) {
      return fallback;
    }

    return DEFAULT_BAN_DURATION_HOURS;
  }

  private formatBanDurationLabel(hours: number): string {
    const safeHours =
      Number.isInteger(hours) && hours >= 1 && hours <= 36 ? hours : DEFAULT_BAN_DURATION_HOURS;
    return `${safeHours}ч`;
  }
}

@Processor('moderation', {
  concurrency: Number(process.env.MODERATION_CONCURRENCY ?? 24),
})
export class ModerationProcessor extends WorkerHost {
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
