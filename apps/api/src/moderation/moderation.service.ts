import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import { EventType, Operator, SanctionAction, WebhookStatus } from '@prisma/client';
import type { Job } from 'bullmq';
import { MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
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

    const violations = await this.ruleEngine.detect({
      chatId,
      userId: senderId,
      text,
      settings,
      domainAllowlist: chat.domains.map((item: { domain: string }) => item.domain),
    });

    if (violations.length === 0) {
      return;
    }

    const topViolation = violations[0];
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

    const action = await this.sanctionService.resolveAction({
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
