import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import { EventType, Operator, SanctionAction, WebhookStatus } from '@prisma/client';
import type { Job } from 'bullmq';
import { MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import type { DuplicateAction, DuplicateDecision, DuplicateHit } from './rule-engine.service';
import { RuleEngineService } from './rule-engine.service';
import { SanctionService } from './sanction.service';
import { maskText } from './text-mask.util';

type ProcessWebhookJob = {
  webhookEventId: string;
};

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ruleEngine: RuleEngineService,
    private readonly sanctionService: SanctionService,
    private readonly maxClient: MaxClientService,
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
        },
      });
    } catch (error: unknown) {
      await this.prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          status: WebhookStatus.FAILED,
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
        },
      });
      throw error;
    }
  }

  async handleUpdate(update: MaxUpdate) {
    if (!update.message) {
      return;
    }

    if (this.isBotAuthoredMessage(update)) {
      return;
    }

    const { chatId, chatTitle, senderId, text, createdAt, messageId } = update.message;
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
        domains: true,
      },
    });

    const settings = chat.settings;
    if (!settings) {
      this.logger.warn({ chatId }, 'Chat settings missing after upsert');
      return;
    }

    const detection = await this.ruleEngine.detect({
      chatId,
      userId: senderId,
      text,
      settings,
      domainAllowlist: chat.domains.map((item: { domain: string }) => item.domain),
    });

    const { violations } = detection;
    const hasLinkViolation = violations.some((item) => item.ruleCode === 'LINK_BLOCKED');
    if (!hasLinkViolation && detection.duplicateDecision) {
      await this.handleDuplicateDecision({
        chatId,
        userId: senderId,
        messageId,
        text,
        createdAt,
        decision: detection.duplicateDecision,
        duplicateBotMessageEnabled: settings.duplicateBotMessageEnabled,
      });
      return;
    }

    if (!hasLinkViolation && detection.duplicateHit) {
      await this.handleDuplicateHit({
        chatId,
        userId: senderId,
        messageId,
        text,
        createdAt,
        hit: detection.duplicateHit,
        duplicateBotMessageEnabled: settings.duplicateBotMessageEnabled,
      });
      return;
    }

    if (violations.length === 0) {
      return;
    }

    const topViolation = violations.find((item) => item.ruleCode === 'LINK_BLOCKED') ?? violations[0];
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

    if (topViolation.ruleCode === 'LINK_BLOCKED' && settings.linkBotMessageEnabled) {
      try {
        await this.maxClient.sendMessage(
          chatId,
          this.buildLinkExplanation(senderId, canDeleteMessage),
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

    let action: SanctionAction = SanctionAction.NONE;
    if (topViolation.ruleCode !== 'LINK_BLOCKED') {
      action = await this.sanctionService.resolveAction({
        chatId,
        userId: senderId,
        warnThreshold: settings.warnThreshold,
        repeatBanWindowDays: settings.repeatBanWindowDays,
      });

      if (action === SanctionAction.KICK) {
        await this.maxClient.kickMember(chatId, senderId);
      } else if (action === SanctionAction.BAN) {
        await this.maxClient.banMember(chatId, senderId);
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
    duplicateBotMessageEnabled: boolean;
  }) {
    const { chatId, userId, messageId, text, createdAt, decision, duplicateBotMessageEnabled } =
      params;
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

    if (duplicateBotMessageEnabled) {
      try {
        await this.maxClient.sendMessage(chatId, this.buildDuplicateExplanation(userId, decision));
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
    if (action === SanctionAction.KICK) {
      await this.maxClient.kickMember(chatId, userId);
    } else if (action === SanctionAction.BAN) {
      await this.maxClient.banMember(chatId, userId);
    }

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
    duplicateBotMessageEnabled: boolean;
  }) {
    const { chatId, userId, messageId, text, createdAt, hit, duplicateBotMessageEnabled } = params;
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

    if (duplicateBotMessageEnabled) {
      try {
        await this.maxClient.sendMessage(chatId, this.buildDuplicateHitExplanation(userId, hit, canDeleteMessage));
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

  private buildLinkExplanation(userId: string, canDeleteMessage: boolean): string {
    if (canDeleteMessage) {
      return `Сообщение пользователя ${userId} удалено: ссылки в этом чате ограничены.`;
    }

    return `Сообщение пользователя ${userId} нарушает правила: ссылки в этом чате ограничены.`;
  }

  private buildDuplicateExplanation(userId: string, decision: DuplicateDecision): string {
    const actionLabel =
      decision.action === 'WARN'
        ? 'предупреждение'
        : decision.action === 'KICK'
          ? 'удаление участника'
          : 'бан';
    const nextActionLabel =
      decision.nextAction === 'KICK'
        ? 'удаление участника'
        : decision.nextAction === 'BAN'
          ? 'бан'
          : null;

    return [
      `Дубли сообщений: пользователь ${userId}.`,
      `Окно ${this.formatWindow(decision.windowSec)}: ${decision.count}/${decision.threshold}.`,
      `Действие: ${actionLabel}.`,
      nextActionLabel ? `Следующая ступень: ${nextActionLabel}.` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join(' ');
  }

  private buildDuplicateHitExplanation(userId: string, hit: DuplicateHit, canDeleteMessage: boolean): string {
    const repeatLabel = hit.count === 1 ? 'повтор' : 'повтора';
    const statusLine = canDeleteMessage
      ? 'Сообщение удалено как дубль.'
      : 'Сообщение помечено как дубль.';

    return [
      `Дубли сообщений: пользователь ${userId}.`,
      `Окно ${this.formatWindow(hit.windowSec)}: ${hit.count} ${repeatLabel}.`,
      statusLine,
    ].join(' ');
  }

  private formatWindow(windowSec: number): string {
    if (windowSec % 3600 === 0) {
      return `${windowSec / 3600}ч`;
    }

    return `${windowSec}с`;
  }

  private isBotAuthoredMessage(update: MaxUpdate): boolean {
    const raw = this.asRecord(update.raw);
    const message = this.asRecord(raw?.message);
    const candidates = [
      this.asRecord(message?.sender),
      this.asRecord(message?.from),
      this.asRecord(raw?.sender),
      this.asRecord(raw?.from),
    ].filter((item): item is Record<string, unknown> => item !== null);

    for (const sender of candidates) {
      const type = this.readLowerString(sender.type) ?? this.readLowerString(sender.kind);
      if (type === 'bot' || type === 'service') {
        return true;
      }

      if (
        sender.is_bot === true ||
        sender.isBot === true ||
        sender.bot === true ||
        sender.is_service === true ||
        sender.isService === true
      ) {
        return true;
      }
    }

    return false;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readLowerString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
  }
}

@Processor('moderation', {
  concurrency: 10,
})
export class ModerationProcessor extends WorkerHost {
  constructor(private readonly moderationService: ModerationService) {
    super();
  }

  async process(job: Job<ProcessWebhookJob>) {
    await this.moderationService.processWebhookEvent(job.data.webhookEventId);
  }
}
