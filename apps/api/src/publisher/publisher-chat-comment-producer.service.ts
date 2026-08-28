import type { MaxUpdate } from '@maxim/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildChatAutoCommentAuditId,
  ReplacementAttachMarkerStore,
} from '../moderation/replacement-attach-marker.store';
import {
  WEBHOOK_PREPARATION_DEFER_DEFAULT_MS,
  WebhookPreparationDeferredError,
} from '../common/webhook-preparation-deferred.error';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import {
  PublisherChatCommentAdmissionError,
  PublisherChatCommentQueueService,
} from './publisher-chat-comment.queue';

const PUBLISHER_ACCESS_LEGACY_GRACE_MS = 7 * 24 * 60 * 60_000;

export class PublisherChatCommentClaimPendingError extends WebhookPreparationDeferredError {
  constructor(cause?: unknown) {
    super(
      'Publisher chat-comment durable job is not confirmed yet',
      WEBHOOK_PREPARATION_DEFER_DEFAULT_MS,
      cause,
    );
    this.name = 'PublisherChatCommentClaimPendingError';
  }
}

@Injectable()
export class PublisherChatCommentProducerService {
  private readonly logger = new Logger(PublisherChatCommentProducerService.name);
  private readonly markerStore: ReplacementAttachMarkerStore;
  private readonly publisherBotId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublisherChatCommentQueueService,
    configService: ConfigService,
  ) {
    this.markerStore = new ReplacementAttachMarkerStore(prisma);
    this.publisherBotId = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
  }

  async observeWebhook(update: MaxUpdate): Promise<void> {
    if (
      update.botId?.trim() !== this.publisherBotId ||
      update.type.trim().toLowerCase() !== 'message_created' ||
      update.message?.entityType === 'channel'
    ) {
      return;
    }

    const chatId = update.message?.chatId?.trim() ?? '';
    const messageId = update.message?.messageId?.trim() ?? '';
    const senderId = update.message?.senderId?.trim() ?? '';
    if (!chatId || !messageId || !senderId) {
      return;
    }

    const now = new Date();
    const legacyGraceStart = new Date(now.getTime() - PUBLISHER_ACCESS_LEGACY_GRACE_MS);
    const entity = await this.prisma.chat.findFirst({
      where: {
        id: chatId,
        entityType: ChatEntityType.CHAT,
        OR: [
          { publicationPolicy: { is: null } },
          { publicationPolicy: { is: { publikEnabled: true } } },
        ],
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
        publicationPolicy: {
          select: {
            publikEnabled: true,
            revision: true,
          },
        },
        publisherSettings: {
          select: {
            chatCommentsEnabled: true,
            chatCommentsAdminsEnabled: true,
            revision: true,
          },
        },
        accessEdges: {
          where: {
            botId: this.publisherBotId,
            userId: senderId,
            entityType: ChatEntityType.CHAT,
            OR: [
              { expiresAt: { gt: now } },
              { expiresAt: null, checkedAt: { gt: legacyGraceStart } },
            ],
          },
          orderBy: { checkedAt: 'desc' },
          take: 1,
          select: { state: true, userRole: true },
        },
      },
    });
    if (
      !entity?.publisherSettings?.chatCommentsEnabled ||
      !entity.publisherSettings.chatCommentsAdminsEnabled
    ) {
      return;
    }
    const access = entity.accessEdges[0];
    if (
      !access ||
      access.state !== ManagedEntityAccessState.GRANTED ||
      (access.userRole !== ManagedEntityAccessRole.OWNER &&
        access.userRole !== ManagedEntityAccessRole.ADMIN)
    ) {
      return;
    }
    const publicationPolicyRevision = entity.publicationPolicy?.revision ?? 0;

    const claim = await this.markerStore.claimChatAutoComment({
      chatId,
      messageId,
      source: 'webhook',
      botId: this.publisherBotId,
      publisherSettingsRevision: entity.publisherSettings.revision,
      publicationPolicyRevision,
    });
    if (claim.status === 'in_progress') {
      try {
        const identity = await this.markerStore.readChatAutoCommentPendingJobIdentity({
          chatId,
          messageId,
        });
        if (
          identity &&
          (await this.queue.hasMatchingAttachJob({
            ...identity,
            chatId,
            messageId,
            senderId,
            dialogBotId: this.publisherBotId,
          }))
        ) {
          return;
        }
      } catch (error: unknown) {
        throw new PublisherChatCommentClaimPendingError(error);
      }
      throw new PublisherChatCommentClaimPendingError();
    }
    if (claim.status !== 'claimed') {
      return;
    }

    const markerId = claim.markerId?.trim() ?? '';
    if (!buildChatAutoCommentAuditId(markerId)) {
      await this.markerStore.releaseChatAutoComment({
        chatId,
        messageId,
        lockToken: claim.lockToken,
        source: 'webhook',
        botId: this.publisherBotId,
        lastError: 'Publisher chat-comment claim did not provide a valid marker id',
        lastStatusCode: null,
      });
      throw new Error('Publisher chat-comment claim did not provide a valid marker id');
    }

    try {
      await this.queue.enqueueAttach({
        markerId,
        lockToken: claim.lockToken,
        chatId,
        messageId,
        senderId,
        dialogBotId: this.publisherBotId,
        publisherSettingsRevision: entity.publisherSettings.revision,
        publicationPolicyRevision,
      });
    } catch (error: unknown) {
      if (error instanceof PublisherChatCommentAdmissionError) {
        await this.markerStore.skipChatAutoCommentAfterPublisherAdmissionFailure({
          markerId,
          chatId,
          messageId,
          lockToken: claim.lockToken,
          botId: this.publisherBotId,
          reason: error.reason,
        });
        return;
      }
      this.logger.warn(
        { chatId, messageId, err: this.errorSummary(error) },
        'Deferred Publisher chat-comment until its durable job can be confirmed',
      );
      throw new WebhookPreparationDeferredError(
        'Publisher chat-comment durable enqueue is unavailable',
        WEBHOOK_PREPARATION_DEFER_DEFAULT_MS,
        error,
      );
    }
  }

  private errorSummary(error: unknown): string {
    return (error instanceof Error ? error.message : String(error ?? 'Unknown error'))
      .trim()
      .slice(0, 500);
  }
}
