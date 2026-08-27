import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  Prisma,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { readWebhookEventTimestamp } from '../webhook/webhook-semantic-event-key';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import { PublisherBindingRefreshQueueService } from './publisher-binding-refresh.queue';

type PublisherObservationKind = 'bot_added' | 'bot_removed' | 'observed';

type PublisherBindingOrderingState = {
  lifecycleEventAt: Date | null;
  lifecycleEventType: string | null;
};

export type PublisherWebhookObservationResult =
  | 'not_publisher'
  | 'missing_chat'
  | 'unmanaged_chat'
  | 'untrusted_terminal_event'
  | 'stale'
  | 'applied';

function publisherObservationRank(type: string | null | undefined): number {
  switch (type?.trim().toLowerCase()) {
    case 'bot_removed':
      return 3;
    case 'bot_added':
      return 2;
    default:
      return 1;
  }
}

export function shouldApplyPublisherObservation(
  current: PublisherBindingOrderingState | null,
  next: { eventAt: Date | null; eventType: string },
): boolean {
  if (!current?.lifecycleEventAt || !next.eventAt) {
    return current?.lifecycleEventAt === null || current === null;
  }
  const timeDifference = next.eventAt.getTime() - current.lifecycleEventAt.getTime();
  if (timeDifference !== 0) {
    return timeDifference > 0;
  }
  return (
    publisherObservationRank(next.eventType) >= publisherObservationRank(current.lifecycleEventType)
  );
}

@Injectable()
export class PublisherEntityBindingLifecycleService {
  private readonly logger = new Logger(PublisherEntityBindingLifecycleService.name);
  private readonly publisherBotId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly refreshQueue: PublisherBindingRefreshQueueService,
    configService: ConfigService,
  ) {
    this.publisherBotId = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
  }

  isPublisherUpdate(update: Pick<MaxUpdate, 'botId'>): boolean {
    return update.botId?.trim() === this.publisherBotId;
  }

  async observeWebhook(update: MaxUpdate): Promise<PublisherWebhookObservationResult> {
    if (!this.isPublisherUpdate(update)) {
      return 'not_publisher';
    }
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId) {
      return 'missing_chat';
    }
    const explicitEntityType = update.message?.entityType;
    if (explicitEntityType !== 'channel' && isPrivateDirectChatId(chatId)) {
      return 'unmanaged_chat';
    }

    const normalizedType = update.type.trim().toLowerCase();
    const kind: PublisherObservationKind =
      normalizedType === 'bot_added'
        ? 'bot_added'
        : normalizedType === 'bot_removed'
          ? 'bot_removed'
          : 'observed';
    const accessHandshake = kind === 'bot_added' || isManagedEntityHandshakeStartCommand(update);
    const eventAt = readWebhookEventTimestamp(update);
    if ((kind === 'bot_added' || kind === 'bot_removed') && !eventAt) {
      this.logger.warn(
        {
          updateId: update.updateId,
          chatId,
          type: normalizedType,
        },
        'Skipped publisher terminal lifecycle event without a trusted timestamp',
      );
      return 'untrusted_terminal_event';
    }

    const receivedAt = new Date();
    const entityType =
      explicitEntityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
    const title =
      update.message?.chatTitle?.trim() ||
      (entityType === ChatEntityType.CHANNEL ? `Channel ${chatId}` : `Chat ${chatId}`);
    const result = await this.prisma.$transaction(async (tx) => {
      const existingChat = await tx.chat.findUnique({
        where: { id: chatId },
        select: { id: true, entityType: true },
      });
      if (!existingChat && !accessHandshake) {
        return 'unmanaged_chat' as const;
      }
      await tx.chat.upsert({
        where: { id: chatId },
        create: { id: chatId, title, entityType },
        update: {},
      });
      const chats = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT chat."id"
        FROM "chats" AS chat
        WHERE chat."id" = ${chatId}
        FOR UPDATE OF chat
      `);
      if (chats.length === 0) return 'unmanaged_chat' as const;

      const persistCatalog = async (status: 'ACTIVE' | 'MISSING') => {
        await tx.chat.update({
          where: { id: chatId },
          data: {
            ...(update.message?.chatTitle?.trim() ? { title } : {}),
            ...(explicitEntityType ? { entityType } : {}),
          },
        });
        await tx.managedBotChatCatalog.upsert({
          where: { botId_chatId: { botId: this.publisherBotId, chatId } },
          create: {
            botId: this.publisherBotId,
            chatId,
            entityType: explicitEntityType ? entityType : (existingChat?.entityType ?? entityType),
            title,
            status,
            source: `publisher_webhook_${normalizedType}`,
            lastSeenAt: eventAt ?? receivedAt,
          },
          update: {
            ...(update.message?.chatTitle?.trim() ? { title } : {}),
            ...(explicitEntityType ? { entityType } : {}),
            status,
            source: `publisher_webhook_${normalizedType}`,
            lastSeenAt: eventAt ?? receivedAt,
          },
        });
      };
      const invalidatePublisherUserAccess = async (reason: string) => {
        await tx.managedEntityAccessEdge.updateMany({
          where: { chatId, botId: this.publisherBotId },
          data: {
            state: ManagedEntityAccessState.BOT_DENIED,
            userRole: ManagedEntityAccessRole.UNKNOWN,
            botRole: ManagedEntityAccessRole.UNKNOWN,
            expiresAt: null,
            deniedReason: reason,
            source: `publisher_webhook_${normalizedType}`,
          },
        });
      };

      const current = await tx.publisherEntityBinding.findUnique({
        where: { chatId },
        select: {
          lifecycleEventAt: true,
          lifecycleEventType: true,
          status: true,
        },
      });
      if (
        eventAt &&
        !shouldApplyPublisherObservation(current, {
          eventAt,
          eventType: normalizedType,
        })
      ) {
        await tx.publisherEntityBinding.updateMany({
          where: {
            chatId,
            publisherBotId: this.publisherBotId,
            OR: [{ lastWebhookAt: null }, { lastWebhookAt: { lt: receivedAt } }],
          },
          data: { lastWebhookAt: receivedAt },
        });
        return 'stale' as const;
      }

      const preservesRemovedLifecycleFence =
        kind === 'observed' && current?.status === ChatBotMembershipStatus.REMOVED;
      const lifecycle =
        eventAt && !preservesRemovedLifecycleFence
          ? {
              lifecycleEventAt: eventAt,
              lifecycleEventType: normalizedType,
              lifecycleSource: 'webhook',
            }
          : {};
      const observation = {
        lastSeenAt: eventAt ?? receivedAt,
        lastWebhookAt: receivedAt,
        ...lifecycle,
      };

      if (!current) {
        await tx.publisherEntityBinding.create({
          data: {
            chatId,
            publisherBotId: this.publisherBotId,
            status:
              kind === 'bot_removed'
                ? ChatBotMembershipStatus.REMOVED
                : ChatBotMembershipStatus.ACTIVE,
            botAccessState:
              kind === 'bot_removed' ? ChatBotAccessState.LOST : ChatBotAccessState.UNKNOWN,
            botAccessCheckedAt: kind === 'bot_removed' ? eventAt : null,
            botAccessSource: `webhook_${normalizedType}`,
            botAccessLastErrorCode: kind === 'bot_removed' ? 'BOT_REMOVED' : null,
            ...observation,
          },
        });
        await persistCatalog(kind === 'bot_removed' ? 'MISSING' : 'ACTIVE');
        if (kind === 'bot_added' || kind === 'bot_removed') {
          await invalidatePublisherUserAccess(kind);
        }
        return 'applied' as const;
      }

      if (kind === 'bot_removed') {
        await tx.publisherEntityBinding.update({
          where: { chatId },
          data: {
            status: ChatBotMembershipStatus.REMOVED,
            capabilities: [],
            permissionsSnapshot: Prisma.JsonNull,
            botAccessState: ChatBotAccessState.LOST,
            botAccessCheckedAt: eventAt,
            botAccessExpiresAt: null,
            botAccessSource: 'webhook_bot_removed',
            botAccessLastErrorCode: 'BOT_REMOVED',
            permissionsHash: null,
            sendRouteQuarantinedUntil: null,
            ...observation,
          },
        });
        await persistCatalog('MISSING');
        await invalidatePublisherUserAccess('bot_removed');
        return 'applied' as const;
      }

      if (kind === 'bot_added') {
        await tx.publisherEntityBinding.update({
          where: { chatId },
          data: {
            publisherBotId: this.publisherBotId,
            status: ChatBotMembershipStatus.ACTIVE,
            capabilities: [],
            permissionsSnapshot: Prisma.JsonNull,
            botAccessState: ChatBotAccessState.UNKNOWN,
            botAccessCheckedAt: null,
            botAccessExpiresAt: null,
            botAccessSource: 'webhook_bot_added',
            botAccessLastErrorCode: null,
            permissionsHash: null,
            sendRouteFailureCount: 0,
            sendRouteQuarantinedUntil: null,
            sendRouteLastFailureAt: null,
            sendRouteLastFailureCode: null,
            ...observation,
          },
        });
        await persistCatalog('ACTIVE');
        await invalidatePublisherUserAccess('bot_added');
        return 'applied' as const;
      }

      await tx.publisherEntityBinding.update({
        where: { chatId },
        data: {
          ...observation,
          ...(current.status === ChatBotMembershipStatus.REMOVED
            ? {}
            : { status: ChatBotMembershipStatus.ACTIVE }),
        },
      });
      await persistCatalog(
        current.status === ChatBotMembershipStatus.REMOVED ? 'MISSING' : 'ACTIVE',
      );
      return 'applied' as const;
    });

    if (result === 'applied' && kind !== 'bot_removed') {
      await this.refreshQueue.enqueue({
        chatId,
        publisherBotId: this.publisherBotId,
        reason: kind === 'bot_added' ? 'bot_added' : 'webhook_observed',
        ...(accessHandshake && update.message?.senderId
          ? { candidateUserId: update.message.senderId }
          : {}),
        requestedAt: receivedAt,
        eventAt,
      });
    }
    return result;
  }
}
