import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
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
import { MaxClientService, type MaxSendMessageOptions } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { SystemModeService } from '../system/system-mode.service';
import { ChatContextCacheService } from './chat-context-cache.service';
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
const DEFAULT_NIGHT_MODE_TIMEZONE = 'Europe/Moscow';
const LINK_ESCALATION_WINDOW_HOURS = 24;
const TEXT_FILTER_ESCALATION_WINDOW_HOURS = 24;
const MAX_FORWARD_SCAN_DEPTH = 8;
const GLOBAL_BLACKLIST_TOGGLE_CACHE_TTL_MS = 30_000;
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
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);
  private globalUserBlacklistEnabledCache: { value: boolean; checkedAt: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ruleEngine: RuleEngineService,
    private readonly sanctionService: SanctionService,
    private readonly maxClient: MaxClientService,
    @Optional() private readonly chatContextCache?: ChatContextCacheService,
    @Optional() private readonly systemModeService?: SystemModeService,
  ) {}

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

    const { chatId, chatTitle, senderId, senderName, text, createdAt, messageId } = update.message;
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

    if (serviceAuthored) {
      if (globalUserBlacklistEnabled) {
        await this.handleServiceGloballyBlacklistedMembersEvent({
          chatId,
          messageId,
          text,
          update,
        });
      }

      if (settings.removeBotsFromGroupEnabled) {
        await this.handleServiceBotEvent({
          chatId,
          messageId,
          text,
          update,
        });
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
        });
      }
      return;
    }

    if (this.isBotAuthoredMessage(update)) {
      if (settings.removeBotsFromGroupEnabled) {
        await this.handleBotMessage({
          chatId,
          userId: senderId,
          messageId,
          text,
        });
      }
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

    const senderIsChatAdmin = this.isSenderChatAdmin(
      chat.adminUserIds.map((userId) => ({ userId })),
      senderId,
    );
    if (this.isNightModeActiveNow(settings) && !senderIsChatAdmin) {
      await this.handleNightModeMessage({
        chatId,
        userId: senderId,
        messageId,
        text,
        createdAt,
        userLabel,
        nightModeStartTimeMinutes: settings.nightModeStartTimeMinutes,
        nightModeEndTimeMinutes: settings.nightModeEndTimeMinutes,
        nightModeTimezone: settings.nightModeTimezone,
        nightModeBotMessageEnabled: settings.nightModeBotMessageEnabled,
        nightModeBotMessageText: settings.nightModeBotMessageText,
        nightModeBotButtonEnabled: settings.nightModeBotButtonEnabled,
        nightModeBotButtonUrl: settings.nightModeBotButtonUrl,
        nightModeBotButtonText: settings.nightModeBotButtonText,
      });
      return;
    }

    const effectiveMessageLength = this.calculateEffectiveMessageLength(update);
    const mediaFlags = this.detectMediaFlags(update);

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
    const textFilterMessageOptions = isTextFilterHit
      ? this.buildBotMessageOptions(
          settings.textFiltersBotButtonEnabled,
          settings.textFiltersBotButtonUrl,
          settings.textFiltersBotButtonText,
        )
      : null;
    const textFilterViolationCount24h = isTextFilterHit
      ? await this.countRecentTextFilterViolations(chatId, senderId)
      : null;

    if (
      topViolation.ruleCode === 'LINK_BLOCKED' &&
      settings.linkBotMessageEnabled &&
      linkViolationCount24h === 1
    ) {
      try {
        if (linkMessageOptions) {
          await this.maxClient.sendMessage(
            chatId,
            this.buildLinkExplanation(userLabel, canDeleteMessage, settings.linkBotMessageText),
            linkMessageOptions,
          );
        } else {
          await this.maxClient.sendMessage(
            chatId,
            this.buildLinkExplanation(userLabel, canDeleteMessage, settings.linkBotMessageText),
          );
        }
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

    if (
      this.isMessageLimitsViolation(topViolation.ruleCode) &&
      settings.messageLimitsBotMessageEnabled
    ) {
      const limitsMessageOptions = this.buildBotMessageOptions(
        settings.messageLimitsBotButtonEnabled,
        settings.messageLimitsBotButtonUrl,
        settings.messageLimitsBotButtonText,
      );
      try {
        if (limitsMessageOptions) {
          await this.maxClient.sendMessage(
            chatId,
            this.buildMessageLimitsExplanation(
              userLabel,
              topViolation.ruleCode,
              canDeleteMessage,
              settings.photoMessageCooldownHours,
              effectiveMessageLength,
              settings.maxMessageLength,
              settings.messageLimitsBotMessageText,
            ),
            limitsMessageOptions,
          );
        } else {
          await this.maxClient.sendMessage(
            chatId,
            this.buildMessageLimitsExplanation(
              userLabel,
              topViolation.ruleCode,
              canDeleteMessage,
              settings.photoMessageCooldownHours,
              effectiveMessageLength,
              settings.maxMessageLength,
              settings.messageLimitsBotMessageText,
            ),
          );
        }
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

    if (
      isTextFilterHit &&
      settings.textFiltersBotMessageEnabled &&
      textFilterViolationCount24h === 1
    ) {
      try {
        if (textFilterMessageOptions) {
          await this.maxClient.sendMessage(
            chatId,
            this.buildTextFilterExplanation(
              userLabel,
              topViolation.ruleCode,
              canDeleteMessage,
              settings.textFiltersBotMessageText,
            ),
            textFilterMessageOptions,
          );
        } else {
          await this.maxClient.sendMessage(
            chatId,
            this.buildTextFilterExplanation(
              userLabel,
              topViolation.ruleCode,
              canDeleteMessage,
              settings.textFiltersBotMessageText,
            ),
          );
        }
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
          await this.maxClient.sendMessage(
            chatId,
            this.buildLinkWarnExplanation(userLabel, settings.linkWarnMessageText),
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
          warnEnabled: settings.textFiltersWarnEnabled,
          banEnabled: settings.textFiltersBanEnabled,
          kickEnabled: settings.textFiltersKickEnabled,
        },
      );
      action = textFilterAction;

      if (textFilterAction === SanctionAction.WARN) {
        try {
          await this.maxClient.sendMessage(
            chatId,
            this.buildTextFilterWarnExplanation(userLabel, settings.textFiltersWarnMessageText),
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
      });

      if (topViolation.ruleCode === 'LINK_BLOCKED' && action === SanctionAction.KICK) {
        try {
          await this.maxClient.sendMessage(chatId, this.buildLinkKickExplanation(userLabel));
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
          await this.maxClient.sendMessage(chatId, this.buildTextFilterKickExplanation(userLabel));
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
        if (duplicateMessageOptions) {
          await this.maxClient.sendMessage(
            chatId,
            this.buildDuplicateExplanation(
              userLabel,
              decision,
              banDurationHours,
              duplicateBotMessageText,
            ),
            duplicateMessageOptions,
          );
        } else {
          await this.maxClient.sendMessage(
            chatId,
            this.buildDuplicateExplanation(
              userLabel,
              decision,
              banDurationHours,
              duplicateBotMessageText,
            ),
          );
        }
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
        if (duplicateMessageOptions) {
          await this.maxClient.sendMessage(
            chatId,
            this.buildDuplicateHitExplanation(userLabel, canDeleteMessage, duplicateBotMessageText),
            duplicateMessageOptions,
          );
        } else {
          await this.maxClient.sendMessage(
            chatId,
            this.buildDuplicateHitExplanation(userLabel, canDeleteMessage, duplicateBotMessageText),
          );
        }
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

  private buildTextFilterWarnExplanation(userLabel: string, templateText: string): string {
    const fallback = `Пользователю ${userLabel} вынесено предупреждение за нарушение текстовых правил.`;
    return this.renderBotMessageTemplate(templateText, fallback, {
      user: userLabel,
      reason: 'нарушение текстовых правил',
      warning: 'вынесено предупреждение за нарушение текстовых правил',
    });
  }

  private buildTextFilterKickExplanation(userLabel: string): string {
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
    botMessageOptions?: MaxSendMessageOptions;
  }) {
    const { chatId, userId, action, userLabel, messageId, banDurationHours, botMessageOptions } =
      params;
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
      botMessageOptions,
    });
  }

  private async sendBanNotice(params: {
    chatId: string;
    userId: string;
    messageId: string;
    userLabel: string;
    banDurationHours: number;
    botMessageOptions?: MaxSendMessageOptions;
  }) {
    const { chatId, userId, messageId, userLabel, banDurationHours, botMessageOptions } = params;
    try {
      if (botMessageOptions) {
        await this.maxClient.sendMessage(
          chatId,
          this.buildBanNotice(userLabel, banDurationHours),
          botMessageOptions,
        );
      } else {
        await this.maxClient.sendMessage(chatId, this.buildBanNotice(userLabel, banDurationHours));
      }
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
      ? `Сообщение пользователя ${userLabel} удалено: фото можно отправлять не чаще одного раза в ${hours}ч.`
      : `Сообщение пользователя ${userLabel} нарушает правило: фото можно отправлять не чаще одного раза в ${hours}ч.`;
    return this.renderBotMessageTemplate(templateText ?? '', fallback, {
      user: userLabel,
      message_status: messageStatus,
      reason: `фото можно отправлять не чаще одного раза в ${hours}ч`,
      photo_cooldown_hours: String(hours),
    });
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

  private async countRecentTextFilterViolations(chatId: string, userId: string): Promise<number> {
    const violationModel = this.prisma.violation as unknown as {
      count?: (args: {
        where: {
          chatId: string;
          userId: string;
          ruleCode: { in: string[] };
          createdAt: { gte: Date };
        };
      }) => Promise<number>;
    };

    if (typeof violationModel.count !== 'function') {
      return 1;
    }

    const since = new Date(Date.now() - TEXT_FILTER_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000);
    const count = await violationModel.count({
      where: {
        chatId,
        userId,
        ruleCode: { in: ['PROFANITY', 'COMMERCIAL_AD'] },
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

  private async handleServiceBotEvent(params: {
    chatId: string;
    messageId: string;
    text: string;
    update: MaxUpdate;
  }) {
    const { chatId, messageId, text, update } = params;
    const botUserIds = this.extractBotUserIdsFromServiceEvent(update);

    for (const userId of botUserIds) {
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
      const greetingMessage = this.buildGreetingMessage(member.userLabel, greetingBotMessageText);
      try {
        if (greetingMessageOptions) {
          await this.maxClient.sendMessage(chatId, greetingMessage, greetingMessageOptions);
        } else {
          await this.maxClient.sendMessage(chatId, greetingMessage);
        }

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

  private extractHumanServiceMembers(update: MaxUpdate): Array<{ userId: string; userLabel: string }> {
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
  }) {
    const { chatId, messageId, text, update } = params;
    const serviceMemberUserIds = this.extractServiceMemberUserIds(update);
    if (serviceMemberUserIds.length === 0) {
      return;
    }

    if (!this.prisma.globalUserBlacklist?.findMany) {
      return;
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
      return;
    }

    for (const row of rows) {
      await this.kickAndLogGlobalBlacklistEvent({
        chatId,
        userId: row.userId,
        messageId,
        text,
        reason: 'Member was added via service event and is globally blacklisted',
      });
    }
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

  private async handleNightModeMessage(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    userLabel: string;
    nightModeStartTimeMinutes: number;
    nightModeEndTimeMinutes: number;
    nightModeTimezone: string;
    nightModeBotMessageEnabled: boolean;
    nightModeBotMessageText: string;
    nightModeBotButtonEnabled: boolean;
    nightModeBotButtonUrl: string;
    nightModeBotButtonText: string;
  }) {
    const {
      chatId,
      userId,
      messageId,
      text,
      createdAt,
      userLabel,
      nightModeStartTimeMinutes,
      nightModeEndTimeMinutes,
      nightModeTimezone,
      nightModeBotMessageEnabled,
      nightModeBotMessageText,
      nightModeBotButtonEnabled,
      nightModeBotButtonUrl,
      nightModeBotButtonText,
    } = params;
    const startMinutes = this.normalizeDayMinutes(nightModeStartTimeMinutes, 23 * 60);
    const endMinutes = this.normalizeDayMinutes(nightModeEndTimeMinutes, 8 * 60);
    const timezone = this.normalizeNightModeTimezone(nightModeTimezone);
    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;
    let wasDeleted = false;

    if (canDeleteMessage) {
      try {
        await this.maxClient.deleteMessage(chatId, messageId);
        wasDeleted = true;
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

    if (!nightModeBotMessageEnabled) {
      return;
    }

    const nightModeMessageOptions = this.buildBotMessageOptions(
      nightModeBotButtonEnabled,
      nightModeBotButtonUrl,
      nightModeBotButtonText,
    );
    try {
      if (nightModeMessageOptions) {
        await this.maxClient.sendMessage(
          chatId,
          this.buildNightModeExplanation(
            userLabel,
            startMinutes,
            endMinutes,
            timezone,
            wasDeleted,
            nightModeBotMessageText,
          ),
          nightModeMessageOptions,
        );
      } else {
        await this.maxClient.sendMessage(
          chatId,
          this.buildNightModeExplanation(
            userLabel,
            startMinutes,
            endMinutes,
            timezone,
            wasDeleted,
            nightModeBotMessageText,
          ),
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to send night mode explanation message',
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

  private isSenderChatAdmin(
    admins: Array<{ userId: string }> | undefined,
    userId: string,
  ): boolean {
    if (!Array.isArray(admins) || admins.length === 0) {
      return false;
    }

    return admins.some((item) => String(item.userId) === String(userId));
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

  private buildNightModeExplanation(
    userLabel: string,
    startMinutes: number,
    endMinutes: number,
    timezone: string,
    wasDeleted: boolean,
    templateText: string,
  ): string {
    const windowLabel = `${this.formatMinutesAsTime(startMinutes)}-${this.formatMinutesAsTime(endMinutes)}`;
    const timezoneLabel = timezone === DEFAULT_NIGHT_MODE_TIMEZONE ? 'Москва' : timezone;
    const nightStatus = wasDeleted
      ? `Сообщение пользователя ${userLabel} удалено.`
      : 'Новые сообщения временно не принимаются.';
    const fallback = wasDeleted
      ? `Чат сейчас закрыт на ночь (${windowLabel}, ${timezoneLabel}). Сообщение пользователя ${userLabel} удалено.`
      : `Чат сейчас закрыт на ночь (${windowLabel}, ${timezoneLabel}). Новые сообщения временно не принимаются.`;

    return this.renderBotMessageTemplate(templateText, fallback, {
      user: userLabel,
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

    const messageNode = this.extractRawMessageNode(raw) ?? raw;
    const rows: Array<Record<string, unknown>> = [];
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

  private async loadChatContext(chatId: string, chatTitle?: string): Promise<{
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
      linkBotMessageEnabled: false,
      textFiltersBotMessageEnabled: false,
      messageLimitsBotMessageEnabled: false,
      duplicateBotMessageEnabled: false,
      greetingBotMessageEnabled: false,
      nightModeBotMessageEnabled: false,
      commercialAdsFilterEnabled: false,
      russianProfanityFilterEnabled: false,
    };
  }

  private readLowerString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
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
