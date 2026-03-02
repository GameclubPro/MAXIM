import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import {
  EventType,
  Operator,
  Prisma,
  SanctionAction,
  WebhookStatus,
  type ChatSettings,
} from '@prisma/client';
import type { Job } from 'bullmq';
import { createHash } from 'node:crypto';
import {
  MaxClientService,
  type MaxActionDispatchOptions,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { SystemModeService } from '../system/system-mode.service';
import { ChatContextCacheService } from './chat-context-cache.service';
import { RedisCounterService } from './redis-counter.service';
import type { DuplicateAction, DuplicateDecision, DuplicateHit } from './rule-engine.service';
import { RuleEngineService } from './rule-engine.service';
import { SanctionService } from './sanction.service';
import { maskText } from './text-mask.util';

type ProcessWebhookJob = {
  webhookEventId: string;
};

type ActiveBan = {
  eventId: string;
  issuedAt: Date;
  expiresAt: Date;
  durationHours: number;
};

const DEFAULT_BAN_DURATION_HOURS = 6;
const DEFAULT_BOT_BUTTON_TEXT = 'Открыть';
const DEFAULT_BOT_MESSAGES_DELETE_DELAY_MINUTES = 2;
const BOT_MESSAGES_DELETE_DELAY_MIN_MINUTES = 1;
const BOT_MESSAGES_DELETE_DELAY_MAX_MINUTES = 60;
const DEFAULT_NIGHT_MODE_TIMEZONE = 'Europe/Moscow';
const NIGHT_MODE_NOTICE_RULE_CODE = 'NIGHT_MODE_NOTICE';
const LINK_ESCALATION_WINDOW_HOURS = 24;
const TEXT_FILTER_ESCALATION_WINDOW_HOURS = 24;
const MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS = 12;
const CHAT_ADMIN_CACHE_TTL_MS = 60_000;
const CHAT_ADMIN_CACHE_TTL_SEC = Math.ceil(CHAT_ADMIN_CACHE_TTL_MS / 1_000);
const CHAT_ADMIN_SHARED_CACHE_KEY_PREFIX = 'chat-admins:v2';
const BOT_STARTED_INSTRUCTION_OPTIONS: MaxSendMessageOptions = {
  button: {
    text: 'Поддержка',
    url: 'https://max.ru/join/qX7U_Hj-L-xMJG8V7wlF6dD-6a6cXIzTBGRtU2mRMzk',
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
  'Настройка в mini app: открой бота в MAX и нажми «Открыть».',
  'Там включаешь правила и тексты так, как нужно вашему чату.',
  '',
  'Схема простая: сначала слово, потом протокол.',
].join('\n');
const MAX_FORWARD_SCAN_DEPTH = 8;
const GLOBAL_BLACKLIST_TOGGLE_CACHE_TTL_MS = 30_000;
const GLOBAL_CROSS_CHAT_SPAM_TOGGLE_CACHE_TTL_MS = 30_000;
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
  'MESSAGE_TOO_LONG',
  'VIDEO_BLOCKED',
  'FILE_BLOCKED',
  'VOICE_BLOCKED',
  'PHOTO_RATE_LIMIT',
]);
const MESSAGE_LIMITS_RULE_CODES = new Set([
  'MESSAGE_TOO_LONG',
  'VIDEO_BLOCKED',
  'FILE_BLOCKED',
  'VOICE_BLOCKED',
  'PHOTO_RATE_LIMIT',
]);
const TEXT_FILTER_RULE_CODES = new Set(['PROFANITY', 'COMMERCIAL_AD']);

@Injectable()
export class ModerationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModerationService.name);
  private globalUserBlacklistEnabledCache: { value: boolean; checkedAt: number } | null = null;
  private globalCrossChatSpamEnabledCache: { value: boolean; checkedAt: number } | null = null;
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly ruleEngine: RuleEngineService,
    private readonly sanctionService: SanctionService,
    private readonly maxClient: MaxClientService,
    @Optional() private readonly chatContextCache?: ChatContextCacheService,
    @Optional() private readonly systemModeService?: SystemModeService,
    @Optional() configService?: ConfigService,
    @Optional() private readonly redisCounter?: RedisCounterService,
  ) {
    this.ownBotUserId = this.normalizeOwnBotUserId(configService?.get<string>('MAX_BOT_ID'));
    this.ownBotUserIdVariants = this.buildBotIdVariants(this.ownBotUserId);
  }

  onModuleInit() {
    if (!roleRunsModeration(getAppRole())) {
      return;
    }

    this.nightModeAnnounceTimer = setInterval(() => {
      void this.processNightModeAnnouncements();
    }, 30_000);
    void this.processNightModeAnnouncements();
  }

  onModuleDestroy() {
    if (this.nightModeAnnounceTimer) {
      clearInterval(this.nightModeAnnounceTimer);
      this.nightModeAnnounceTimer = null;
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
    const globalUserBlacklistEnabled = await this.isGlobalUserBlacklistEnabled(
      settings.globalUserBlacklistEnabled,
    );
    const globalCrossChatSpamEnabled = await this.isGlobalCrossChatSpamEnabled(
      settings.globalCrossChatSpamEnabled,
    );

    const updateType = this.readLowerString(update.type);
    const senderIsOwnBotInMessage =
      updateType === 'message_created' && senderId ? this.isOwnBotSender(senderId) : false;
    if (senderIsOwnBotInMessage) {
      if (settings.deleteBotMessagesEnabled) {
        await this.handleBotMessageAutoDelete({
          chatId,
          userId: senderId,
          messageId,
          text,
          delayMinutes: settings.deleteBotMessagesDelayMinutes,
        });
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
        await this.handleBotMessageAutoDelete({
          chatId,
          userId: senderId,
          messageId,
          text,
          delayMinutes: settings.deleteBotMessagesDelayMinutes,
        });
      }
      return;
    }

    const senderIsChatAdmin = await this.isSenderChatAdminWithFallback(chatId, chat.adminUserIds, senderId);
    if (senderIsChatAdmin) {
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
        item.ruleCode === 'MESSAGE_TOO_LONG' ||
        item.ruleCode === 'VIDEO_BLOCKED' ||
        item.ruleCode === 'FILE_BLOCKED' ||
        item.ruleCode === 'VOICE_BLOCKED' ||
        item.ruleCode === 'PHOTO_RATE_LIMIT',
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
      violations.find((item) => item.ruleCode === 'MESSAGE_TOO_LONG') ??
      violations.find((item) => item.ruleCode === 'VIDEO_BLOCKED') ??
      violations.find((item) => item.ruleCode === 'FILE_BLOCKED') ??
      violations.find((item) => item.ruleCode === 'VOICE_BLOCKED') ??
      violations.find((item) => item.ruleCode === 'PHOTO_RATE_LIMIT') ??
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
            settings.linkBotButtonEnabled,
            settings.linkBotButtonUrl,
            settings.linkBotButtonText,
          )
        : null;
    const linkViolationCount24h =
      topViolation.ruleCode === 'LINK_BLOCKED'
        ? await this.countRecentLinkViolations(chatId, senderId)
        : null;
    const isTextFilterHit = this.isTextFilterViolation(topViolation.ruleCode);
    const isMessageLimitsHit = this.isMessageLimitsViolation(topViolation.ruleCode);
    const textFilterEscalationSettings = isTextFilterHit
      ? this.resolveTextFilterEscalationSettings(topViolation.ruleCode, settings)
      : null;
    const textFilterMessageOptions =
      topViolation.ruleCode === 'COMMERCIAL_AD'
        ? this.buildBotMessageOptions(
            settings.textFiltersBotButtonEnabled,
            settings.textFiltersBotButtonUrl,
            settings.textFiltersBotButtonText,
          )
        : null;
    const limitsMessageOptions = isMessageLimitsHit
      ? this.buildBotMessageOptions(
          settings.messageLimitsBotButtonEnabled,
          settings.messageLimitsBotButtonUrl,
          settings.messageLimitsBotButtonText,
        )
      : null;
    const textFilterViolationCount24h = isTextFilterHit
      ? await this.countRecentTextFilterViolations(chatId, senderId, topViolation.ruleCode)
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

    if (topViolation.ruleCode === 'LINK_BLOCKED' && settings.linkBotMessageEnabled) {
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
    }

    if (isMessageLimitsHit && settings.messageLimitsBotMessageEnabled) {
      try {
        await sendChatBotMessage(
          this.buildMessageLimitsExplanation(
            userLabel,
            topViolation.ruleCode,
            canDeleteMessage,
            settings.photoMessageCooldownHours,
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
    }

    if (isTextFilterHit && textFilterEscalationSettings?.botMessageEnabled) {
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
    }

    let action: SanctionAction = SanctionAction.NONE;
    const actionBanDurationHours = settings.banDurationHours;

    if (topViolation.ruleCode === 'LINK_BLOCKED') {
      const linkAction = this.resolveLinkEscalationAction(linkViolationCount24h ?? 1, {
        warnEnabled: settings.linkWarnEnabled,
        banEnabled: settings.linkBanEnabled,
        kickEnabled: settings.linkKickEnabled,
      });
      action = linkAction;

      if (linkAction === SanctionAction.WARN) {
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
    } else if (isTextFilterHit) {
      const textFilterAction = this.resolveTextFilterEscalationAction(
        textFilterViolationCount24h ?? 1,
        {
          warnEnabled: Boolean(textFilterEscalationSettings?.warnEnabled),
          banEnabled: Boolean(textFilterEscalationSettings?.banEnabled),
          kickEnabled: Boolean(textFilterEscalationSettings?.kickEnabled),
        },
      );
      action = textFilterAction;

      if (textFilterAction === SanctionAction.WARN) {
        try {
          await sendChatBotMessage(
            this.buildTextFilterWarnExplanation(
              userLabel,
              topViolation.ruleCode,
              textFilterEscalationSettings?.warnMessageText ?? settings.textFiltersWarnMessageText,
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
            'Failed to send text filter warning message',
          );
        }
      }
    } else if (isMessageLimitsHit) {
      action = this.resolveMessageLimitsEscalationAction(
        messageLimitsViolationCount12h ?? 1,
        {
          warnEnabled: settings.messageLimitsWarnEnabled,
          banEnabled: settings.messageLimitsBanEnabled,
          kickEnabled: settings.messageLimitsKickEnabled,
        },
      );

      if (action === SanctionAction.WARN) {
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
    } else if (this.shouldResolveSanction(topViolation.ruleCode)) {
      action = await this.sanctionService.resolveAction({
        chatId,
        userId: senderId,
        warnThreshold: settings.warnThreshold,
      });
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
      duplicateBotButtonEnabled,
      duplicateBotButtonUrl,
      duplicateBotButtonText,
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
      duplicateBotButtonEnabled,
      duplicateBotButtonUrl,
      duplicateBotButtonText,
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
    const fallback = canDeleteMessage
      ? `Сообщение пользователя ${userLabel} удалено: в этом чате нельзя отправлять ссылки. Пожалуйста, без ссылок.`
      : `Сообщение пользователя ${userLabel} нарушает правило: в этом чате нельзя отправлять ссылки. Пожалуйста, без ссылок.`;
    const messageStatus = canDeleteMessage ? 'удалено' : 'нарушает правило';

    return this.renderBotMessageTemplate(templateText, fallback, {
      user: userLabel,
      message_status: messageStatus,
      reason: 'в этом чате нельзя отправлять ссылки. Пожалуйста, без ссылок.',
    });
  }

  private buildLinkWarnExplanation(userLabel: string, templateText: string): string {
    const fallback = `Пользователю ${userLabel} вынесено предупреждение за ссылку. В этом чате нельзя отправлять ссылки.`;
    return this.renderBotMessageTemplate(templateText, fallback, {
      user: userLabel,
      reason: 'в этом чате нельзя отправлять ссылки',
      warning: 'вынесено предупреждение за ссылку',
    });
  }

  private buildLinkKickExplanation(userLabel: string): string {
    return `Пользователь ${userLabel} удален из чата за повторные сообщения со ссылками.`;
  }

  private buildTextFilterWarnExplanation(
    userLabel: string,
    ruleCode: string,
    templateText: string,
  ): string {
    const reason =
      ruleCode === 'COMMERCIAL_AD'
        ? 'коммерческую рекламу'
        : ruleCode === 'PROFANITY'
          ? 'нецензурную лексику'
          : 'нарушение текстовых правил';
    const fallback = `Пользователю ${userLabel} вынесено предупреждение за ${reason}.`;
    return this.renderBotMessageTemplate(templateText, fallback, {
      user: userLabel,
      reason,
      warning: `вынесено предупреждение за ${reason}`,
    });
  }

  private buildTextFilterKickExplanation(userLabel: string, ruleCode: string): string {
    if (ruleCode === 'COMMERCIAL_AD') {
      return `Пользователь ${userLabel} удален из чата за повторную коммерческую рекламу.`;
    }

    if (ruleCode === 'PROFANITY') {
      return `Пользователь ${userLabel} удален из чата за повторную нецензурную лексику.`;
    }

    return `Пользователь ${userLabel} удален из чата за повторные нарушения текстовых правил.`;
  }

  private buildDuplicateExplanation(
    userLabel: string,
    decision: DuplicateDecision,
    banDurationHours: number,
    templateText: string,
  ): string {
    const banDurationLabel = this.formatBanDurationLabel(banDurationHours);
    const baseContext = 'удалено как дубль';

    if (decision.action === 'WARN') {
      const fallback = `Сообщение пользователя ${userLabel} удалено как дубль. Пользователю вынесено предупреждение.`;
      return this.renderBotMessageTemplate(templateText, fallback, {
        user: userLabel,
        message_status: 'удалено',
        reason: 'в этом чате нельзя отправлять дубли сообщений',
        duplicate_context: baseContext,
        sanction: 'Пользователю вынесено предупреждение.',
        ban_duration: banDurationLabel,
      });
    }

    if (decision.action === 'KICK') {
      const fallback = `Сообщение пользователя ${userLabel} удалено как дубль. Пользователь удален из чата.`;
      return this.renderBotMessageTemplate(templateText, fallback, {
        user: userLabel,
        message_status: 'удалено',
        reason: 'в этом чате нельзя отправлять дубли сообщений',
        duplicate_context: baseContext,
        sanction: 'Пользователь удален из чата.',
        ban_duration: banDurationLabel,
      });
    }

    const fallback = `Сообщение пользователя ${userLabel} удалено как дубль. Пользователю выдан временный бан на ${banDurationLabel}.`;
    return this.renderBotMessageTemplate(templateText, fallback, {
      user: userLabel,
      message_status: 'удалено',
      reason: 'в этом чате нельзя отправлять дубли сообщений',
      duplicate_context: baseContext,
      sanction: `Пользователю выдан временный бан на ${banDurationLabel}.`,
      ban_duration: banDurationLabel,
    });
  }

  private buildDuplicateHitExplanation(
    userLabel: string,
    canDeleteMessage: boolean,
    templateText: string,
  ): string {
    const fallback = canDeleteMessage
      ? `Сообщение пользователя ${userLabel} удалено: в этом чате нельзя отправлять дубли сообщений.`
      : `Сообщение пользователя ${userLabel} нарушает правило: в этом чате нельзя отправлять дубли сообщений.`;
    const messageStatus = canDeleteMessage ? 'удалено' : 'нарушает правило';
    const duplicateContext = canDeleteMessage
      ? 'удалено: в этом чате нельзя отправлять дубли сообщений'
      : 'нарушает правило: в этом чате нельзя отправлять дубли сообщений';

    return this.renderBotMessageTemplate(templateText, fallback, {
      user: userLabel,
      message_status: messageStatus,
      reason: 'в этом чате нельзя отправлять дубли сообщений',
      duplicate_context: duplicateContext,
      sanction: '',
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

  private formatUserLabel(senderName?: string): string {
    const normalized = typeof senderName === 'string' ? senderName.trim() : '';
    const safe = normalized.length > 0 ? normalized.replace(/"/g, "'") : 'Пользователь';
    return `"${safe}"`;
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
    return `Пользователю ${userLabel} выдан временный бан на ${this.formatBanDurationLabel(banDurationHours)}.`;
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

  private buildTextFilterExplanation(
    userLabel: string,
    ruleCode: string,
    canDeleteMessage: boolean,
    templateText: string,
  ): string {
    const messageStatus = canDeleteMessage ? 'удалено' : 'нарушает правило';

    if (ruleCode === 'PROFANITY') {
      const fallback = canDeleteMessage
        ? `Сообщение пользователя ${userLabel} удалено: нецензурная лексика запрещена правилами чата.`
        : `Сообщение пользователя ${userLabel} нарушает правило: нецензурная лексика запрещена правилами чата.`;
      return this.renderBotMessageTemplate(templateText, fallback, {
        user: userLabel,
        message_status: messageStatus,
        reason: 'нецензурная лексика запрещена правилами чата',
      });
    }

    const fallback = canDeleteMessage
      ? `Сообщение пользователя ${userLabel} удалено: коммерческие объявления в этом чате запрещены.`
      : `Сообщение пользователя ${userLabel} нарушает правило: коммерческие объявления в этом чате запрещены.`;
    return this.renderBotMessageTemplate(templateText, fallback, {
      user: userLabel,
      message_status: messageStatus,
      reason: 'коммерческие объявления в этом чате запрещены',
    });
  }

  private buildMessageLimitsExplanation(
    userLabel: string,
    ruleCode: string,
    canDeleteMessage: boolean,
    photoCooldownHours: number,
    messageLength?: number,
    maxMessageLength?: number,
    templateText?: string,
  ): string {
    const messageStatus = canDeleteMessage ? 'удалено' : 'нарушает правило';

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
      const lengthDetails =
        actualLength !== null && maxLength !== null
          ? ` длина сообщения ${actualLength} символов, лимит ${maxLength}.`
          : ' сообщение превышает допустимую длину.';
      const reason =
        actualLength !== null && maxLength !== null
          ? `длина сообщения ${actualLength} символов, лимит ${maxLength}`
          : 'сообщение превышает допустимую длину';

      const fallback = canDeleteMessage
        ? `Сообщение пользователя ${userLabel} удалено:${lengthDetails}`
        : `Сообщение пользователя ${userLabel} нарушает правило:${lengthDetails}`;
      return this.renderBotMessageTemplate(templateText ?? '', fallback, {
        user: userLabel,
        message_status: messageStatus,
        reason,
        actual_length: actualLength !== null ? String(actualLength) : '',
        max_length: maxLength !== null ? String(maxLength) : '',
      });
    }

    if (ruleCode === 'VIDEO_BLOCKED') {
      const fallback = canDeleteMessage
        ? `Сообщение пользователя ${userLabel} удалено: отправка видео в этом чате отключена.`
        : `Сообщение пользователя ${userLabel} нарушает правило: отправка видео в этом чате отключена.`;
      return this.renderBotMessageTemplate(templateText ?? '', fallback, {
        user: userLabel,
        message_status: messageStatus,
        reason: 'отправка видео в этом чате отключена',
      });
    }

    if (ruleCode === 'FILE_BLOCKED') {
      const fallback = canDeleteMessage
        ? `Сообщение пользователя ${userLabel} удалено: отправка файлов в этом чате отключена.`
        : `Сообщение пользователя ${userLabel} нарушает правило: отправка файлов в этом чате отключена.`;
      return this.renderBotMessageTemplate(templateText ?? '', fallback, {
        user: userLabel,
        message_status: messageStatus,
        reason: 'отправка файлов в этом чате отключена',
      });
    }

    if (ruleCode === 'VOICE_BLOCKED') {
      const fallback = canDeleteMessage
        ? `Сообщение пользователя ${userLabel} удалено: голосовые сообщения в этом чате отключены.`
        : `Сообщение пользователя ${userLabel} нарушает правило: голосовые сообщения в этом чате отключены.`;
      return this.renderBotMessageTemplate(templateText ?? '', fallback, {
        user: userLabel,
        message_status: messageStatus,
        reason: 'голосовые сообщения в этом чате отключены',
      });
    }

    const hours =
      Number.isInteger(photoCooldownHours) && photoCooldownHours >= 1 && photoCooldownHours <= 24
        ? photoCooldownHours
        : 1;
    const fallback = canDeleteMessage
      ? `Сообщение пользователя ${userLabel} удалено: фото можно отправлять не чаще одного раза в ${hours}ч, чтобы не перегружать ленту. Если нужно отправить несколько фото, используйте альбом или коллаж.`
      : `Сообщение пользователя ${userLabel} нарушает правило: фото можно отправлять не чаще одного раза в ${hours}ч, чтобы не перегружать ленту. Если нужно отправить несколько фото, используйте альбом или коллаж.`;
    return this.renderBotMessageTemplate(templateText ?? '', fallback, {
      user: userLabel,
      message_status: messageStatus,
      reason: `фото можно отправлять не чаще одного раза в ${hours}ч, чтобы не перегружать ленту; используйте альбом или коллаж`,
      photo_cooldown_hours: String(hours),
    });
  }

  private buildMessageLimitsKickExplanation(userLabel: string, ruleCode: string): string {
    if (ruleCode === 'PHOTO_RATE_LIMIT') {
      return `Пользователь ${userLabel} удален из чата за повторные нарушения лимита по фото.`;
    }

    if (ruleCode === 'MESSAGE_TOO_LONG') {
      return `Пользователь ${userLabel} удален из чата за повторные слишком длинные сообщения.`;
    }

    if (ruleCode === 'VIDEO_BLOCKED') {
      return `Пользователь ${userLabel} удален из чата за повторную отправку видео при отключенном видео-режиме.`;
    }

    if (ruleCode === 'FILE_BLOCKED') {
      return `Пользователь ${userLabel} удален из чата за повторную отправку файлов при отключенной отправке файлов.`;
    }

    if (ruleCode === 'VOICE_BLOCKED') {
      return `Пользователь ${userLabel} удален из чата за повторную отправку голосовых при отключенных голосовых сообщениях.`;
    }

    return `Пользователь ${userLabel} удален из чата за повторные нарушения ограничений сообщений.`;
  }

  private buildMessageLimitsWarnExplanation(userLabel: string, ruleCode: string): string {
    if (ruleCode === 'PHOTO_RATE_LIMIT') {
      return `Пользователю ${userLabel} вынесено предупреждение: слишком частая отправка фото.`;
    }

    if (ruleCode === 'MESSAGE_TOO_LONG') {
      return `Пользователю ${userLabel} вынесено предупреждение: слишком длинные сообщения.`;
    }

    if (ruleCode === 'VIDEO_BLOCKED') {
      return `Пользователю ${userLabel} вынесено предупреждение: отправка видео в этом чате отключена.`;
    }

    if (ruleCode === 'FILE_BLOCKED') {
      return `Пользователю ${userLabel} вынесено предупреждение: отправка файлов в этом чате отключена.`;
    }

    if (ruleCode === 'VOICE_BLOCKED') {
      return `Пользователю ${userLabel} вынесено предупреждение: голосовые сообщения в этом чате отключены.`;
    }

    return `Пользователю ${userLabel} вынесено предупреждение за нарушение ограничений сообщений.`;
  }

  private buildMessageLimitsBanExplanation(
    userLabel: string,
    ruleCode: string,
    banDurationHours: number,
  ): string {
    const durationLabel = this.formatBanDurationLabel(banDurationHours);

    if (ruleCode === 'PHOTO_RATE_LIMIT') {
      return `Пользователю ${userLabel} выдан временный бан на ${durationLabel} за повторные нарушения лимита по фото.`;
    }

    if (ruleCode === 'MESSAGE_TOO_LONG') {
      return `Пользователю ${userLabel} выдан временный бан на ${durationLabel} за повторные слишком длинные сообщения.`;
    }

    if (ruleCode === 'VIDEO_BLOCKED') {
      return `Пользователю ${userLabel} выдан временный бан на ${durationLabel} за повторную отправку видео при отключенном видео-режиме.`;
    }

    if (ruleCode === 'FILE_BLOCKED') {
      return `Пользователю ${userLabel} выдан временный бан на ${durationLabel} за повторную отправку файлов при отключенной отправке файлов.`;
    }

    if (ruleCode === 'VOICE_BLOCKED') {
      return `Пользователю ${userLabel} выдан временный бан на ${durationLabel} за повторную отправку голосовых при отключенных голосовых сообщениях.`;
    }

    return `Пользователю ${userLabel} выдан временный бан на ${durationLabel} за повторные нарушения ограничений сообщений.`;
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
    hasVideoAttachment: boolean;
    hasFileAttachment: boolean;
    hasVoiceAttachment: boolean;
  } {
    const rawRecord = this.asRecord(update.raw);
    if (!rawRecord) {
      return {
        hasPhotoAttachment: false,
        hasVideoAttachment: false,
        hasFileAttachment: false,
        hasVoiceAttachment: false,
      };
    }

    const messageNode = this.extractRawMessageNode(rawRecord) ?? rawRecord;
    const flags = {
      hasPhotoAttachment: false,
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
      hasVideoAttachment: boolean;
      hasFileAttachment: boolean;
      hasVoiceAttachment: boolean;
    },
    depth = 0,
  ) {
    if (
      depth > MAX_FORWARD_SCAN_DEPTH ||
      node === null ||
      node === undefined ||
      (flags.hasPhotoAttachment &&
        flags.hasVideoAttachment &&
        flags.hasFileAttachment &&
        flags.hasVoiceAttachment)
    ) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectMediaFlags(item, flags, depth + 1);
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

    if (
      type === 'photo' ||
      type === 'image' ||
      type === 'picture' ||
      type === 'sticker' ||
      mimeType?.startsWith('image/') ||
      mediaType === 'photo' ||
      mediaType === 'image'
    ) {
      flags.hasPhotoAttachment = true;
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

    if (
      type === 'file' ||
      type === 'document' ||
      type === 'doc' ||
      mediaType === 'file' ||
      mediaType === 'document'
    ) {
      flags.hasFileAttachment = true;
    }

    for (const [key, value] of Object.entries(row)) {
      const keyLower = key.toLowerCase();
      if (
        keyLower === 'photo' ||
        keyLower === 'image' ||
        keyLower === 'picture' ||
        keyLower === 'images'
      ) {
        flags.hasPhotoAttachment = true;
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
        this.collectMediaFlags(value, flags, depth + 1);
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
    buttonEnabled: boolean,
    buttonUrl: string,
    buttonText: string,
  ): MaxSendMessageOptions | null {
    if (!buttonEnabled) {
      return null;
    }

    const normalizedUrl = this.normalizeBotButtonUrl(buttonUrl);
    if (!normalizedUrl) {
      return null;
    }

    const normalizedText = this.normalizeBotButtonText(buttonText);

    return {
      button: {
        text: normalizedText,
        url: normalizedUrl,
      },
    };
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
    const fallback = `Приветствуем ${userLabel} в чате!`;
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
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      mediaFlags,
    } = params;
    const signature = this.buildGlobalCrossChatSpamSignature({
      text,
      update,
      mediaFlags,
    });
    if (!signature) {
      return false;
    }

    const redisKey = `cross-chat-spam:v1:${userId}:${signature.kind}:${signature.hash}`;
    let uniqueChatsCount: number;

    try {
      const spreadState = await this.redisCounter.addToSetWithTtl(
        redisKey,
        chatId,
        GLOBAL_CROSS_CHAT_SPAM_WINDOW_SEC + 5,
      );
      uniqueChatsCount = spreadState.size;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
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
    const messageNode = rawRecord ? this.extractRawMessageNode(rawRecord) ?? rawRecord : null;
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
    if (depth > MAX_FORWARD_SCAN_DEPTH || node === null || node === undefined || tokens.size >= 120) {
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

  private buildGlobalCrossChatSpamNotice(userLabel: string, uniqueChatsCount: number): string {
    return `Сообщение пользователя ${userLabel} удалено: одинаковый текст/фото/пересланное отправлено в ${uniqueChatsCount} чатах за 2 минуты (кросс-чат спам).`;
  }

  private async isGlobalCrossChatSpamEnabled(chatSettingEnabled: boolean): Promise<boolean> {
    if (chatSettingEnabled) {
      this.globalCrossChatSpamEnabledCache = {
        value: true,
        checkedAt: Date.now(),
      };
      return true;
    }

    const now = Date.now();
    if (
      this.globalCrossChatSpamEnabledCache &&
      now - this.globalCrossChatSpamEnabledCache.checkedAt <= GLOBAL_CROSS_CHAT_SPAM_TOGGLE_CACHE_TTL_MS
    ) {
      return this.globalCrossChatSpamEnabledCache.value;
    }

    const enabledSomewhere = await this.prisma.chatSettings?.findFirst({
      where: {
        globalCrossChatSpamEnabled: true,
      },
      select: {
        chatId: true,
      },
    });
    const value = Boolean(enabledSomewhere);
    this.globalCrossChatSpamEnabledCache = {
      value,
      checkedAt: now,
    };
    return value;
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
        const noticeAlreadySent = await this.wasNightModeNoticeSent(settings.chatId, nightSessionKey);
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
          settings.nightModeBotButtonEnabled,
          settings.nightModeBotButtonUrl,
          settings.nightModeBotButtonText,
        );

        try {
          await this.sendBotMessageWithOptionalAutoDelete({
            chatId: settings.chatId,
            text: messageText,
            messageOptions: nightModeMessageOptions ?? undefined,
            deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
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
      await this.maxClient.sendMessage(chatId, BOT_STARTED_INSTRUCTION_TEXT, BOT_STARTED_INSTRUCTION_OPTIONS);
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
        candidate.chat_type ?? candidate.chatType ?? chat?.type ?? chat?.chat_type ?? chat?.chatType,
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

  private async isSenderChatAdminWithFallback(
    chatId: string,
    localAdminUserIds: string[] | undefined,
    userId: string,
  ): Promise<boolean> {
    const remoteAdminIds = await this.getRemoteChatAdminIds(chatId);
    if (remoteAdminIds) {
      for (const variant of this.buildUserIdVariants(userId)) {
        if (remoteAdminIds.has(variant)) {
          return true;
        }
      }

      return false;
    }

    // Fallback for temporary MAX API issues: keep legacy local allowlist behavior.
    return this.isSenderChatAdmin(localAdminUserIds, userId);
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

  private async writeChatAdminsToSharedCache(chatId: string, adminUserIds: Set<string>): Promise<void> {
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
    const fallback = `Чат сейчас закрыт на ночь (${windowLabel}, ${timezoneLabel}). Новые сообщения временно не принимаются.`;

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

  private async loadChatContext(
    chatId: string,
    chatTitle?: string,
  ): Promise<{
    settings: ChatSettings;
    domainAllowlist: string[];
    adminUserIds: string[];
  }> {
    if (this.chatContextCache) {
      const cached = await this.chatContextCache.getChatContext(chatId, chatTitle);
      return {
        settings: cached.settings,
        domainAllowlist: cached.domainAllowlist,
        adminUserIds: cached.adminUserIds,
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

    return {
      settings: chat.settings,
      domainAllowlist: (chat.domains ?? []).map((item) => item.domain),
      adminUserIds: (chat.admins ?? []).map((item) => item.userId),
    };
  }

  private applyDegradeSettings(settings: ChatSettings, degradeMode: boolean): ChatSettings {
    if (!degradeMode) {
      return settings;
    }

    return {
      ...settings,
      commercialAdsFilterEnabled: false,
      russianProfanityFilterEnabled: false,
    };
  }

  private readLowerString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
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
        this.normalizeDeleteBotMessagesDelayMinutes(params.deleteBotMessagesDelayMinutes) * 60 * 1000;
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
      messageOptions,
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
