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
import { extractHttpStatusCode } from '../common/http-error.util';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import {
  PublisherChatCommentAdmissionError,
  PublisherChatCommentQueueService,
} from './publisher-chat-comment.queue';

const PUBLISHER_ACCESS_LEGACY_GRACE_MS = 7 * 24 * 60 * 60_000;

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
            OR: [
              { sendRouteQuarantinedUntil: null },
              { sendRouteQuarantinedUntil: { lte: now } },
            ],
          },
        },
      },
      select: {
        publisherSettings: {
          select: {
            chatCommentsEnabled: true,
            chatCommentsAdminsEnabled: true,
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

    const claim = await this.markerStore.claimChatAutoComment({
      chatId,
      messageId,
      source: 'webhook',
      botId: this.publisherBotId,
    });
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
      await this.markerStore.releaseChatAutoComment({
        chatId,
        messageId,
        lockToken: claim.lockToken,
        source: 'webhook',
        botId: this.publisherBotId,
        lastError: this.errorSummary(error),
        lastStatusCode: extractHttpStatusCode(error),
      });
      this.logger.warn(
        { chatId, messageId, err: this.errorSummary(error) },
        'Failed to enqueue Publisher chat-comment attach',
      );
      throw error;
    }
  }

  private errorSummary(error: unknown): string {
    return (error instanceof Error ? error.message : String(error ?? 'Unknown error'))
      .trim()
      .slice(0, 500);
  }
}
