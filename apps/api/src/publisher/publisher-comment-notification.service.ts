import type {
  ChannelDialogNotificationMode,
  ChannelDialogNotificationScope,
  ChannelDialogNotificationSettings,
  ManagedEntityType,
} from '@maxim/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type PublisherCommentNotificationPreference } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import { PublisherChatCommentQueueService } from './publisher-chat-comment.queue';
import { publisherConnectedBindingWhere } from './publisher-entity-connection.util';

export const PUBLISHER_COMMENT_NOTIFICATION_TTL_MS = 24 * 60 * 60_000;
export const PUBLISHER_COMMENT_ACTION = 'PUBLISHER_CHAT_DIALOG_COMMENT';

export type PublisherCommentScope = {
  entityType: ManagedEntityType;
  chatId: string;
  threadId: string;
};

export async function readPublisherNotificationComment(
  db: Pick<Prisma.TransactionClient, 'auditLog'>,
  target: PublisherCommentScope,
  id: string,
) {
  const row = await db.auditLog.findUnique({ where: { id } });
  if (!row || row.chatId !== target.chatId || row.action !== PUBLISHER_COMMENT_ACTION) return null;
  const payload = row.payload;
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    payload.publisherProfile !== true ||
    payload.threadId !== target.threadId
  )
    return null;
  return { ...row, payload };
}
type Preference = Pick<
  PublisherCommentNotificationPreference,
  'chatId' | 'threadId' | 'mode' | 'explicit'
>;

export function resolvePublisherCommentNotificationSettings(
  rows: readonly Preference[],
  target: PublisherCommentScope,
): ChannelDialogNotificationSettings {
  const state = (row: Preference | undefined) => ({
    mode: (row?.mode.toLowerCase() ?? 'off') as ChannelDialogNotificationMode,
    explicit: row?.explicit ?? false,
  });
  const thread = state(
    rows.find((row) => row.chatId === target.chatId && row.threadId === target.threadId),
  );
  const channel = state(rows.find((row) => row.chatId === target.chatId && row.threadId === ''));
  const allChannels = state(rows.find((row) => row.chatId === '' && row.threadId === ''));
  const scope = thread.explicit
    ? 'thread'
    : channel.explicit
      ? 'channel'
      : allChannels.explicit
        ? 'all_channels'
        : 'thread';
  const selected = scope === 'thread' ? thread : scope === 'channel' ? channel : allChannels;
  return { mode: selected.mode, scope, thread, channel, allChannels, canUseAll: true };
}

@Injectable()
export class PublisherCommentNotificationService {
  private readonly logger = new Logger(PublisherCommentNotificationService.name);
  readonly botId: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    private readonly queue: PublisherChatCommentQueueService,
  ) {
    this.botId = buildPublisherBotDescriptor({ id: config.get<string>('MAX_PUBLISHER_BOT_ID') }).id;
  }

  preferenceWhere(
    target: PublisherCommentScope,
  ): Prisma.PublisherCommentNotificationPreferenceWhereInput {
    return {
      botId: this.botId,
      entityType: target.entityType === 'channel' ? 'CHANNEL' : 'CHAT',
      OR: [
        { chatId: target.chatId, threadId: target.threadId },
        { chatId: target.chatId, threadId: '' },
        { chatId: '', threadId: '' },
      ],
    };
  }

  async readSettings(
    target: PublisherCommentScope,
    userId: string,
    includeCount = true,
  ): Promise<ChannelDialogNotificationSettings> {
    const rows = await this.prisma.publisherCommentNotificationPreference.findMany({
      where: { ...this.preferenceWhere(target), userId },
      take: 3,
    });
    const settings = resolvePublisherCommentNotificationSettings(rows, target);
    if (includeCount) {
      settings.availableChannelCount = await this.prisma.managedEntityAccessEdge.count({
        where: this.accessWhere(target, userId),
      });
    }
    return settings;
  }

  async updateSettings(
    target: PublisherCommentScope,
    userId: string,
    mode: ChannelDialogNotificationMode,
    scope: ChannelDialogNotificationScope,
  ) {
    const key = {
      botId: this.botId,
      entityType: target.entityType === 'channel' ? ('CHANNEL' as const) : ('CHAT' as const),
      chatId: scope === 'all_channels' ? '' : target.chatId,
      threadId: scope === 'thread' ? target.threadId : '',
      userId,
    };
    const persistedMode = mode === 'all' ? 'ALL' : mode === 'replies' ? 'REPLIES' : 'OFF';
    await this.prisma.publisherCommentNotificationPreference.upsert({
      where: { botId_entityType_chatId_threadId_userId: key },
      create: { ...key, mode: persistedMode, explicit: true },
      update: { mode: persistedMode, explicit: true },
    });
    return this.readSettings(target, userId);
  }

  async recordComment(
    tx: Prisma.TransactionClient,
    target: PublisherCommentScope & {
      id: string;
      authorUserId: string;
      replyToId: string | null;
      createdAt: Date;
    },
  ): Promise<void> {
    // FLAG: The comment, implicit subscription and outbox commit atomically. Existing OFF wins.
    const key = {
      botId: this.botId,
      entityType: target.entityType === 'channel' ? ('CHANNEL' as const) : ('CHAT' as const),
      chatId: target.chatId,
      threadId: target.threadId,
      userId: target.authorUserId,
    };
    const reply = target.replyToId
      ? await readPublisherNotificationComment(tx, target, target.replyToId)
      : null;
    for (const userId of [
      ...new Set([target.authorUserId, ...(reply ? [reply.actorUserId] : [])]),
    ].sort()) {
      const userKey = { ...key, userId };
      await tx.publisherCommentNotificationPreference.upsert({
        where: { botId_entityType_chatId_threadId_userId: userKey },
        create: { ...userKey, mode: 'REPLIES', explicit: false, createdAt: target.createdAt },
        update: {},
      });
    }
    await tx.publisherCommentNotificationEvent.create({
      data: {
        id: target.id,
        botId: this.botId,
        entityType: key.entityType,
        chatId: target.chatId,
        threadId: target.threadId,
        authorUserId: target.authorUserId,
        replyToId: target.replyToId,
        createdAt: target.createdAt,
        expiresAt: new Date(target.createdAt.getTime() + PUBLISHER_COMMENT_NOTIFICATION_TTL_MS),
      },
    });
  }

  async enqueue(eventId: string): Promise<void> {
    try {
      await this.queue.enqueueNotification(eventId);
    } catch {
      this.logger.warn({ eventId }, 'Publisher comment notification awaits outbox recovery');
    }
  }

  async canReceive(
    target: PublisherCommentScope,
    userId: string,
    isReply: boolean,
  ): Promise<boolean> {
    const settings = await this.readSettings(target, userId, false);
    if (settings.mode !== 'all' && !(settings.mode === 'replies' && isReply)) return false;
    if (settings.scope !== 'all_channels') return true;
    return (
      (await this.prisma.managedEntityAccessEdge.count({
        where: { ...this.accessWhere(target, userId), chatId: target.chatId },
      })) > 0
    );
  }

  private accessWhere(
    target: PublisherCommentScope,
    userId: string,
  ): Prisma.ManagedEntityAccessEdgeWhereInput {
    const now = new Date();
    return {
      botId: this.botId,
      userId,
      entityType: target.entityType === 'channel' ? 'CHANNEL' : 'CHAT',
      state: 'GRANTED',
      userRole: { in: ['OWNER', 'ADMIN'] },
      OR: [
        { expiresAt: { gt: now } },
        { expiresAt: null, checkedAt: { gt: new Date(now.getTime() - 15 * 60_000) } },
      ],
      chat: {
        catalogKind: 'MANAGED',
        publisherBinding: { is: publisherConnectedBindingWhere(this.botId) },
        OR: [
          { publicationPolicy: { is: null } },
          { publicationPolicy: { is: { publikEnabled: true } } },
        ],
      },
    };
  }
}
