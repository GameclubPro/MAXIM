import type { MaxUpdate } from '@maxim/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  PublisherAutoReplyDeliveryStatus,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  WEBHOOK_PREPARATION_DEFER_DEFAULT_MS,
  WebhookPreparationDeferredError,
} from '../common/webhook-preparation-deferred.error';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import { extractPublisherAutoReplyMessageCandidate } from './publisher-auto-reply-normalization';
import {
  PublisherAutoReplyAdmissionError,
  PublisherAutoReplyQueueService,
} from './publisher-auto-reply.queue';

const DEFAULT_AUTO_REPLY_DELAY_MS = 1_500;
const MAX_AUTO_REPLY_DELAY_MS = 60_000;

export type PublisherAutoReplyObservation = { matched: boolean };

export class PublisherAutoReplyEnqueuePendingError extends WebhookPreparationDeferredError {
  constructor(cause?: unknown) {
    super(
      'Publisher auto-reply durable job is not confirmed yet',
      WEBHOOK_PREPARATION_DEFER_DEFAULT_MS,
      cause,
    );
    this.name = 'PublisherAutoReplyEnqueuePendingError';
  }
}

@Injectable()
export class PublisherAutoReplyProducerService {
  private readonly logger = new Logger(PublisherAutoReplyProducerService.name);
  private readonly publisherBotId: string;
  private readonly deliveryDelayMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublisherAutoReplyQueueService,
    private readonly botRegistry: MaxBotRegistryService,
    configService: ConfigService,
  ) {
    this.publisherBotId = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
    const configuredDelay = configService.get<number>(
      'PUBLISHER_AUTO_REPLY_DELAY_MS',
      DEFAULT_AUTO_REPLY_DELAY_MS,
    );
    this.deliveryDelayMs = Number.isFinite(configuredDelay)
      ? Math.max(0, Math.min(MAX_AUTO_REPLY_DELAY_MS, Math.floor(configuredDelay)))
      : DEFAULT_AUTO_REPLY_DELAY_MS;
  }

  async observeWebhook(
    update: MaxUpdate,
    sourceWebhookEventId?: string | null,
  ): Promise<PublisherAutoReplyObservation> {
    if (update.botId?.trim() !== this.publisherBotId) {
      return { matched: false };
    }
    const updateType = update.type.trim().toLowerCase();
    if (updateType === 'message_edited' || updateType === 'message_removed') {
      await this.cancelPendingSourceDelivery(update, updateType);
      return { matched: false };
    }

    const candidate = extractPublisherAutoReplyMessageCandidate(update, {
      publisherBotId: this.publisherBotId,
      isKnownRuntimeBotUserId: (userId) => this.botRegistry.isKnownBotUserId(userId),
    });
    if (!candidate) {
      return { matched: false };
    }

    const now = new Date();
    const entity = await this.prisma.chat.findFirst({
      where: {
        id: candidate.chatId,
        entityType: ChatEntityType.CHAT,
        OR: [
          { publicationPolicy: { is: null } },
          { publicationPolicy: { is: { publikEnabled: true } } },
        ],
        publisherSettings: { is: { autoRepliesEnabled: true } },
        publisherBinding: {
          is: {
            publisherBotId: this.publisherBotId,
            status: ChatBotMembershipStatus.ACTIVE,
            botAccessState: {
              in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
            },
            botAccessExpiresAt: { gt: now },
            OR: [{ sendRouteQuarantinedUntil: null }, { sendRouteQuarantinedUntil: { lte: now } }],
          },
        },
      },
      select: {
        publisherSettings: { select: { revision: true, autoRepliesEnabled: true } },
        publicationPolicy: { select: { revision: true, publikEnabled: true } },
        publisherAutoReplyRules: {
          where: {
            normalizedPhrase: candidate.normalizedTrigger,
            enabled: true,
            archivedAt: null,
            currentContentRevisionId: { not: null },
          },
          orderBy: { id: 'asc' },
          take: 2,
          select: {
            id: true,
            version: true,
            normalizedPhrase: true,
            currentContentRevisionId: true,
          },
        },
      },
    });
    if (!entity?.publisherSettings?.autoRepliesEnabled) {
      return { matched: false };
    }
    if (entity.publisherAutoReplyRules.length !== 1) {
      if (entity.publisherAutoReplyRules.length > 1) {
        this.logger.error(
          { chatId: candidate.chatId, normalizedTrigger: candidate.normalizedTrigger },
          'Publisher auto-reply trigger has multiple active matches; delivery was suppressed',
        );
        return { matched: true };
      }
      return { matched: false };
    }

    const rule = entity.publisherAutoReplyRules[0]!;
    const contentRevisionId = rule.currentContentRevisionId?.trim() ?? '';
    if (!contentRevisionId) {
      return { matched: false };
    }
    try {
      await this.queue.assertAdmissionEnabled();
    } catch (error: unknown) {
      if (error instanceof PublisherAutoReplyAdmissionError) {
        return { matched: true };
      }
      throw new PublisherAutoReplyEnqueuePendingError(error);
    }
    const dueAt = new Date(now.getTime() + this.deliveryDelayMs);
    await this.prisma.publisherAutoReplyDelivery.createMany({
      data: [
        {
          chatId: candidate.chatId,
          ruleId: rule.id,
          contentRevisionId,
          publisherBotId: this.publisherBotId,
          sourceMessageId: candidate.sourceMessageId,
          sourceUserId: candidate.senderUserId,
          sourceWebhookEventId: sourceWebhookEventId?.trim() || null,
          matchedRuleVersion: rule.version,
          matchedNormalizedPhrase: rule.normalizedPhrase,
          publisherSettingsRevision: entity.publisherSettings.revision,
          publicationPolicyRevision: entity.publicationPolicy?.revision ?? 0,
          dueAt,
        },
      ],
      skipDuplicates: true,
    });
    const delivery = await this.prisma.publisherAutoReplyDelivery.findUnique({
      where: {
        chatId_sourceMessageId: {
          chatId: candidate.chatId,
          sourceMessageId: candidate.sourceMessageId,
        },
      },
      select: {
        id: true,
        status: true,
        dueAt: true,
        dispatchStartedAt: true,
      },
    });
    if (!delivery) {
      throw new PublisherAutoReplyEnqueuePendingError();
    }
    if (
      delivery.dispatchStartedAt === null &&
      (delivery.status === PublisherAutoReplyDeliveryStatus.PENDING ||
        delivery.status === PublisherAutoReplyDeliveryStatus.SENDING)
    ) {
      try {
        await this.queue.ensureDeliveryJob(delivery.id, delivery.dueAt);
      } catch (error: unknown) {
        if (error instanceof PublisherAutoReplyAdmissionError) {
          await this.prisma.publisherAutoReplyDelivery.updateMany({
            where: {
              id: delivery.id,
              status: PublisherAutoReplyDeliveryStatus.PENDING,
              dispatchStartedAt: null,
            },
            data: {
              status: PublisherAutoReplyDeliveryStatus.CANCELED,
              canceledAt: new Date(),
              failureCode: 'DISPATCH_DISABLED',
              failureMessage: null,
            },
          });
          return { matched: true };
        }
        throw new PublisherAutoReplyEnqueuePendingError(error);
      }
    }
    return { matched: true };
  }

  private async cancelPendingSourceDelivery(
    update: MaxUpdate,
    updateType: 'message_edited' | 'message_removed',
  ): Promise<void> {
    const chatId = update.message?.chatId?.trim() ?? '';
    const sourceMessageId = update.message?.messageId?.trim() ?? '';
    if (!chatId || !sourceMessageId) {
      return;
    }
    const now = new Date();
    await this.prisma.publisherAutoReplyDelivery.updateMany({
      where: {
        chatId,
        sourceMessageId,
        publisherBotId: this.publisherBotId,
        status: {
          in: [PublisherAutoReplyDeliveryStatus.PENDING, PublisherAutoReplyDeliveryStatus.SENDING],
        },
        dispatchStartedAt: null,
      },
      data: {
        status: PublisherAutoReplyDeliveryStatus.CANCELED,
        canceledAt: now,
        lockedAt: null,
        lockToken: null,
        failureCode: updateType === 'message_edited' ? 'SOURCE_EDITED' : 'SOURCE_REMOVED',
        failureMessage: null,
      },
    });
  }
}
