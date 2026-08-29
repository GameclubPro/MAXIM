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
import {
  extractPublisherAutoReplyMessageCandidate,
  isExplicitlyBotAuthoredPublisherGroupMessage,
  type PublisherAutoReplyMessageCandidate,
} from './publisher-auto-reply-normalization';
import { PublisherAutoReplyFloodGateService } from './publisher-auto-reply-flood-gate.service';
import {
  PublisherAutoReplySourceFenceService,
  type PublisherAutoReplySourceFenceState,
} from './publisher-auto-reply-source-fence.service';
import {
  PublisherAutoReplyAdmissionError,
  PublisherAutoReplyQueueService,
} from './publisher-auto-reply.queue';

const DEFAULT_AUTO_REPLY_DELAY_MS = 1_500;
const MAX_AUTO_REPLY_DELAY_MS = 60_000;

export type PublisherAutoReplyObservation = { matched: boolean };
export type PublisherAutoReplyObservationOptions = { duplicateRepair?: boolean };

type PublisherAutoReplyDeliverySnapshot = {
  id: string;
  sourceWebhookEventId: string | null;
  status: PublisherAutoReplyDeliveryStatus;
  dueAt: Date;
  dispatchStartedAt: Date | null;
};

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
    private readonly floodGate: PublisherAutoReplyFloodGateService,
    private readonly sourceFence: PublisherAutoReplySourceFenceService,
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
    options: PublisherAutoReplyObservationOptions = {},
  ): Promise<PublisherAutoReplyObservation> {
    if (update.botId?.trim() !== this.publisherBotId) {
      return { matched: false };
    }
    if (isExplicitlyBotAuthoredPublisherGroupMessage(update, this.publisherBotId)) {
      return { matched: true };
    }
    const updateType = update.type.trim().toLowerCase();
    if (updateType === 'message_edited' || updateType === 'message_removed') {
      await this.cancelPendingSourceDelivery(update, updateType, sourceWebhookEventId);
      return { matched: false };
    }

    const candidate = extractPublisherAutoReplyMessageCandidate(update, {
      publisherBotId: this.publisherBotId,
      isKnownRuntimeBotUserId: (userId) => this.botRegistry.isKnownBotUserId(userId),
    });
    if (!candidate) {
      return { matched: false };
    }
    let replayedFloodDecision: { allowed: true; replayed: true } | null = null;
    if (options.duplicateRepair === true) {
      const delivery = await this.findSourceDelivery(candidate.chatId, candidate.sourceMessageId);
      if (delivery) {
        const sourceState = await this.admitSource(
          candidate,
          delivery.sourceWebhookEventId ?? sourceWebhookEventId,
        );
        if (sourceState !== 'admitted') {
          await this.cancelPendingDelivery(delivery.id, 'SOURCE_CHANGED');
          return { matched: true };
        }
        await this.ensureDeliveryJob(delivery);
        return { matched: true };
      }
      let replayDecision: Awaited<ReturnType<PublisherAutoReplyFloodGateService['replay']>>;
      try {
        replayDecision = await this.floodGate.replay({
          publisherBotId: this.publisherBotId,
          chatId: candidate.chatId,
          senderUserId: candidate.senderUserId,
          sourceMessageId: candidate.sourceMessageId,
        });
      } catch (error: unknown) {
        throw new PublisherAutoReplyEnqueuePendingError(error);
      }
      if (!replayDecision.allowed) {
        return { matched: true };
      }
      if (!replayDecision.replayed) {
        throw new PublisherAutoReplyEnqueuePendingError();
      }
      replayedFloodDecision = { allowed: true, replayed: true };
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
      return { matched: replayedFloodDecision !== null };
    }
    if (entity.publisherAutoReplyRules.length !== 1) {
      if (entity.publisherAutoReplyRules.length > 1) {
        this.logger.error(
          { chatId: candidate.chatId, normalizedTrigger: candidate.normalizedTrigger },
          'Publisher auto-reply trigger has multiple active matches; delivery was suppressed',
        );
        return { matched: true };
      }
      return { matched: replayedFloodDecision !== null };
    }

    const rule = entity.publisherAutoReplyRules[0]!;
    const contentRevisionId = rule.currentContentRevisionId?.trim() ?? '';
    if (!contentRevisionId) {
      return { matched: replayedFloodDecision !== null };
    }
    let upstreamDenialReason: 'backlog_limit' | 'backlog_unavailable' | undefined;
    try {
      await this.queue.assertNewDeliveryAdmissionEnabled();
    } catch (error: unknown) {
      if (error instanceof PublisherAutoReplyAdmissionError) {
        if (error.reason === 'dispatch_disabled') {
          return { matched: true };
        }
        upstreamDenialReason = error.reason;
      } else {
        throw new PublisherAutoReplyEnqueuePendingError(error);
      }
    }
    let floodDecision: Awaited<ReturnType<PublisherAutoReplyFloodGateService['reserve']>>;
    if (replayedFloodDecision) {
      floodDecision = replayedFloodDecision;
    } else {
      try {
        floodDecision = await this.floodGate.reserve({
          publisherBotId: this.publisherBotId,
          chatId: candidate.chatId,
          senderUserId: candidate.senderUserId,
          sourceMessageId: candidate.sourceMessageId,
          ...(upstreamDenialReason ? { upstreamDenialReason } : {}),
        });
      } catch (error: unknown) {
        throw new PublisherAutoReplyEnqueuePendingError(error);
      }
    }
    if (!floodDecision.allowed || (upstreamDenialReason && !floodDecision.replayed)) {
      return { matched: true };
    }
    const sourceState = await this.admitSource(candidate, sourceWebhookEventId);
    if (sourceState !== 'admitted') {
      return { matched: true };
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
    const delivery = await this.findSourceDelivery(candidate.chatId, candidate.sourceMessageId);
    if (!delivery) {
      throw new PublisherAutoReplyEnqueuePendingError();
    }
    const confirmedSourceState = await this.readSourceFence(candidate);
    if (confirmedSourceState !== 'admitted') {
      await this.cancelPendingDelivery(
        delivery.id,
        confirmedSourceState === 'canceled' ? 'SOURCE_CHANGED' : 'SOURCE_FENCE_MISSING',
      );
      return { matched: true };
    }
    await this.ensureDeliveryJob(delivery);
    return { matched: true };
  }

  private async findSourceDelivery(
    chatId: string,
    sourceMessageId: string,
  ): Promise<PublisherAutoReplyDeliverySnapshot | null> {
    return this.prisma.publisherAutoReplyDelivery.findUnique({
      where: {
        chatId_sourceMessageId: {
          chatId,
          sourceMessageId,
        },
      },
      select: {
        id: true,
        sourceWebhookEventId: true,
        status: true,
        dueAt: true,
        dispatchStartedAt: true,
      },
    });
  }

  private async ensureDeliveryJob(delivery: PublisherAutoReplyDeliverySnapshot): Promise<void> {
    if (
      delivery.dispatchStartedAt === null &&
      (delivery.status === PublisherAutoReplyDeliveryStatus.PENDING ||
        delivery.status === PublisherAutoReplyDeliveryStatus.SENDING)
    ) {
      try {
        await this.queue.ensureDeliveryJob(delivery.id, delivery.dueAt);
      } catch (error: unknown) {
        if (
          error instanceof PublisherAutoReplyAdmissionError &&
          error.reason === 'dispatch_disabled'
        ) {
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
          return;
        }
        throw new PublisherAutoReplyEnqueuePendingError(error);
      }
    }
  }

  private async cancelPendingSourceDelivery(
    update: MaxUpdate,
    updateType: 'message_edited' | 'message_removed',
    sourceWebhookEventId?: string | null,
  ): Promise<void> {
    const chatId = update.message?.chatId?.trim() ?? '';
    const sourceMessageId = update.message?.messageId?.trim() ?? '';
    if (!chatId || !sourceMessageId) {
      return;
    }
    let fenceError: unknown = null;
    try {
      await this.sourceFence.cancel({
        publisherBotId: this.publisherBotId,
        chatId,
        sourceMessageId,
        sourceWebhookEventId,
      });
    } catch (error: unknown) {
      fenceError = error;
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
    if (fenceError) {
      throw new PublisherAutoReplyEnqueuePendingError(fenceError);
    }
  }

  private async admitSource(
    candidate: PublisherAutoReplyMessageCandidate,
    sourceWebhookEventId?: string | null,
  ): Promise<PublisherAutoReplySourceFenceState> {
    try {
      return await this.sourceFence.admit({
        publisherBotId: this.publisherBotId,
        chatId: candidate.chatId,
        sourceMessageId: candidate.sourceMessageId,
        sourceWebhookEventId,
      });
    } catch (error: unknown) {
      throw new PublisherAutoReplyEnqueuePendingError(error);
    }
  }

  private async readSourceFence(
    candidate: PublisherAutoReplyMessageCandidate,
  ): Promise<PublisherAutoReplySourceFenceState> {
    try {
      return await this.sourceFence.read({
        publisherBotId: this.publisherBotId,
        chatId: candidate.chatId,
        sourceMessageId: candidate.sourceMessageId,
      });
    } catch (error: unknown) {
      throw new PublisherAutoReplyEnqueuePendingError(error);
    }
  }

  private cancelPendingDelivery(id: string, failureCode: string): Promise<{ count: number }> {
    return this.prisma.publisherAutoReplyDelivery.updateMany({
      where: {
        id,
        status: {
          in: [PublisherAutoReplyDeliveryStatus.PENDING, PublisherAutoReplyDeliveryStatus.SENDING],
        },
        dispatchStartedAt: null,
      },
      data: {
        status: PublisherAutoReplyDeliveryStatus.CANCELED,
        canceledAt: new Date(),
        lockedAt: null,
        lockToken: null,
        failureCode,
        failureMessage: null,
      },
    });
  }
}
