import { randomUUID } from 'node:crypto';

import type { PrismaService } from '../prisma/prisma.service';
import {
  CHANNEL_DIALOG_AUTO_ATTACH_ACTION,
  CHANNEL_DIALOG_AUTO_ATTACH_SKIP_ACTION,
  CHAT_DIALOG_AUTO_ATTACH_ACTION,
} from './moderation.service.support';

export type ReplacementAttachMarkerStatus = 'IN_PROGRESS' | 'SUCCEEDED' | 'SKIPPED';

export const CHANNEL_AUTO_POST_ATTACH_STATUS = {
  IN_PROGRESS: 'IN_PROGRESS',
  SUCCEEDED: 'SUCCEEDED',
  SKIPPED: 'SKIPPED',
} as const satisfies Record<string, ReplacementAttachMarkerStatus>;

export const CHAT_AUTO_COMMENT_ATTACH_STATUS = {
  IN_PROGRESS: 'IN_PROGRESS',
  SUCCEEDED: 'SUCCEEDED',
  SKIPPED: 'SKIPPED',
} as const satisfies Record<string, ReplacementAttachMarkerStatus>;

export type ReplacementAttachMarkerClaim =
  | { status: 'claimed'; lockToken: string }
  | { status: 'done' | 'in_progress' };

type MarkerKind = 'channel_auto_post' | 'chat_auto_comment';

type MarkerRow = {
  status: ReplacementAttachMarkerStatus;
  lockedAt: Date | null;
  replacementMessageId: string | null;
  replyMessageId: string | null;
  replacementSendStartedAt: Date | null;
};

type MarkerDelegate = {
  findUnique?: (args: unknown) => Promise<MarkerRow | null>;
  create?: (args: unknown) => Promise<unknown>;
  createMany?: (args: unknown) => Promise<{ count: number }>;
  updateMany?: (args: unknown) => Promise<{ count: number }>;
};

type MarkerPrisma = {
  channelAutoPostAttachMarker?: MarkerDelegate;
  chatAutoCommentAttachMarker?: MarkerDelegate;
};

const ATTACH_LOCK_TTL_MS = 2 * 60_000;

export class ReplacementAttachMarkerStore {
  constructor(private readonly prisma: PrismaService) {}

  claimChannelAutoPost(params: {
    chatId: string;
    messageId: string;
    source: 'webhook' | 'poll';
    botId: string | null;
    linkType: string | null;
  }): Promise<ReplacementAttachMarkerClaim> {
    return this.claim('channel_auto_post', params);
  }

  claimChatAutoComment(params: {
    chatId: string;
    messageId: string;
    source: 'webhook';
    botId: string | null;
  }): Promise<ReplacementAttachMarkerClaim> {
    return this.claim('chat_auto_comment', params);
  }

  completeChannelAutoPost(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    status: 'SUCCEEDED' | 'SKIPPED';
    source: 'webhook' | 'poll';
    botId: string | null;
    linkType: string | null;
    deliveryMode: string | null;
    replacementMessageId?: string | null;
    publishedUrl?: string | null;
    originalDeleted?: boolean;
    lastError: string | null;
    lastStatusCode: number | null;
  }): Promise<void> {
    return this.complete('channel_auto_post', params);
  }

  completeChatAutoComment(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    status: 'SUCCEEDED' | 'SKIPPED';
    source: 'webhook';
    botId: string | null;
    deliveryMode: string | null;
    replacementMessageId?: string | null;
    replyMessageId?: string | null;
    publishedUrl?: string | null;
    originalDeleted: boolean;
    lastError: string | null;
    lastStatusCode: number | null;
  }): Promise<void> {
    return this.complete('chat_auto_comment', params);
  }

  recordChannelReplacementMessage(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    replacementMessageId: string;
    publishedUrl: string | null;
  }): Promise<void> {
    return this.recordReplacementMessage('channel_auto_post', params);
  }

  recordChatReplacementMessage(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    replacementMessageId: string;
    publishedUrl: string | null;
  }): Promise<void> {
    return this.recordReplacementMessage('chat_auto_comment', params);
  }

  recordChatReplyMessage(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    replyMessageId: string;
  }): Promise<void> {
    return this.recordChatReplyResult(params);
  }

  recordChannelReplacementSendStarted(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
  }): Promise<void> {
    return this.recordReplacementSendStarted('channel_auto_post', params);
  }

  recordChatReplacementSendStarted(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
  }): Promise<void> {
    return this.recordReplacementSendStarted('chat_auto_comment', params);
  }

  recordChatReplySendStarted(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
  }): Promise<void> {
    // FLAG: Keep replies on this durable fence so stale recovery and Safety Desk see every send.
    return this.recordSendStarted('chat_auto_comment', params, 'reply_message');
  }

  releaseChannelAutoPost(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    source: 'webhook' | 'poll';
    botId: string | null;
    linkType: string | null;
    lastError: string | null;
    lastStatusCode: number | null;
  }): Promise<void> {
    return this.release('channel_auto_post', params);
  }

  releaseChatAutoComment(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    source: 'webhook';
    botId: string | null;
    lastError: string | null;
    lastStatusCode: number | null;
  }): Promise<void> {
    return this.release('chat_auto_comment', params);
  }

  private async claim(
    kind: MarkerKind,
    params: {
      chatId: string;
      messageId: string;
      source: 'webhook' | 'poll';
      botId: string | null;
      linkType?: string | null;
    },
  ): Promise<ReplacementAttachMarkerClaim> {
    if (await this.hasCompleted(kind, params.chatId, params.messageId)) {
      return { status: 'done' };
    }

    const delegate = this.getDelegate(kind);
    const lockToken = randomUUID();
    const now = new Date();
    if (
      !delegate?.findUnique ||
      (!delegate.create && !delegate.createMany) ||
      !delegate.updateMany
    ) {
      return { status: 'claimed', lockToken };
    }

    const existing = await delegate.findUnique({
      where: { chatId_messageId: { chatId: params.chatId, messageId: params.messageId } },
      select: {
        status: true,
        lockedAt: true,
        replacementMessageId: true,
        ...(kind === 'chat_auto_comment' ? { replyMessageId: true } : {}),
        replacementSendStartedAt: true,
      },
    });
    if (existing?.status === 'SUCCEEDED' || existing?.status === 'SKIPPED') {
      return { status: 'done' };
    }
    if (
      existing?.replacementMessageId ||
      existing?.replyMessageId ||
      existing?.replacementSendStartedAt
    ) {
      return { status: 'in_progress' };
    }

    if (!existing) {
      const createData = {
        chatId: params.chatId,
        messageId: params.messageId,
        status: 'IN_PROGRESS',
        lockToken,
        lockedAt: now,
        source: params.source,
        botId: params.botId,
        ...(kind === 'channel_auto_post' ? { linkType: params.linkType ?? null } : {}),
      };
      if (delegate.createMany) {
        const created = await delegate.createMany({ data: [createData], skipDuplicates: true });
        if (created.count > 0) {
          return { status: 'claimed', lockToken };
        }
      } else if (delegate.create) {
        try {
          await delegate.create({ data: createData });
          return { status: 'claimed', lockToken };
        } catch (error: unknown) {
          if (!this.isPrismaKnownError(error, 'P2002')) {
            throw error;
          }
        }
      }
    }

    const claimed = await delegate.updateMany({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        status: 'IN_PROGRESS',
        replacementMessageId: null,
        ...(kind === 'chat_auto_comment' ? { replyMessageId: null } : {}),
        replacementSendStartedAt: null,
        OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(Date.now() - ATTACH_LOCK_TTL_MS) } }],
      },
      data: {
        lockToken,
        lockedAt: now,
        source: params.source,
        botId: params.botId,
        ...(kind === 'channel_auto_post' ? { linkType: params.linkType ?? null } : {}),
      },
    });
    return claimed.count > 0 ? { status: 'claimed', lockToken } : { status: 'in_progress' };
  }

  private async hasCompleted(
    kind: MarkerKind,
    chatId: string,
    messageId: string,
  ): Promise<boolean> {
    const marker = await this.getDelegate(kind)?.findUnique?.({
      where: { chatId_messageId: { chatId, messageId } },
      select: { status: true, lockedAt: true },
    });
    if (marker?.status === 'SUCCEEDED' || marker?.status === 'SKIPPED') {
      return true;
    }

    const alreadyAttached = await this.prisma.auditLog.findFirst({
      where: {
        chatId,
        action:
          kind === 'channel_auto_post'
            ? { in: [CHANNEL_DIALOG_AUTO_ATTACH_ACTION, CHANNEL_DIALOG_AUTO_ATTACH_SKIP_ACTION] }
            : CHAT_DIALOG_AUTO_ATTACH_ACTION,
        payload: { path: ['messageId'], equals: messageId },
      },
      select: { id: true },
    });
    return Boolean(alreadyAttached);
  }

  private async complete(
    kind: MarkerKind,
    params: {
      chatId: string;
      messageId: string;
      lockToken: string;
      status: 'SUCCEEDED' | 'SKIPPED';
      source: 'webhook' | 'poll';
      botId: string | null;
      linkType?: string | null;
      deliveryMode: string | null;
      replacementMessageId?: string | null;
      replyMessageId?: string | null;
      publishedUrl?: string | null;
      originalDeleted?: boolean;
      lastError: string | null;
      lastStatusCode: number | null;
    },
  ): Promise<void> {
    await this.getDelegate(kind)?.updateMany?.({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        lockToken: params.lockToken,
        status: 'IN_PROGRESS',
      },
      data: {
        status: params.status,
        lockToken: null,
        lockedAt: null,
        source: params.source,
        botId: params.botId,
        ...(kind === 'channel_auto_post' ? { linkType: params.linkType ?? null } : {}),
        deliveryMode: params.deliveryMode,
        replacementMessageId: params.replacementMessageId ?? null,
        ...(kind === 'chat_auto_comment' ? { replyMessageId: params.replyMessageId ?? null } : {}),
        publishedUrl: params.publishedUrl ?? null,
        ...(params.originalDeleted ? { originalDeleted: true } : {}),
        lastError: params.lastError,
        lastStatusCode: params.lastStatusCode,
      },
    });
  }

  private async recordReplacementMessage(
    kind: MarkerKind,
    params: {
      chatId: string;
      messageId: string;
      lockToken: string;
      replacementMessageId: string;
      publishedUrl: string | null;
    },
  ): Promise<void> {
    const updated = await this.getDelegate(kind)?.updateMany?.({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        lockToken: params.lockToken,
        status: 'IN_PROGRESS',
      },
      data: {
        deliveryMode: 'replace_with_bot_message',
        replacementMessageId: params.replacementMessageId,
        publishedUrl: params.publishedUrl,
      },
    });
    if (updated && updated.count !== 1) {
      throw new Error(`Failed to persist the ${this.label(kind)} replacement message marker`);
    }
  }

  private async recordReplacementSendStarted(
    kind: MarkerKind,
    params: { chatId: string; messageId: string; lockToken: string },
  ): Promise<void> {
    return this.recordSendStarted(kind, params, 'replace_with_bot_message');
  }

  private async recordSendStarted(
    kind: MarkerKind,
    params: { chatId: string; messageId: string; lockToken: string },
    deliveryMode: 'replace_with_bot_message' | 'reply_message',
  ): Promise<void> {
    const updated = await this.getDelegate(kind)?.updateMany?.({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        lockToken: params.lockToken,
        status: 'IN_PROGRESS',
        replacementMessageId: null,
        replacementSendStartedAt: null,
      },
      data: {
        deliveryMode,
        replacementSendStartedAt: new Date(),
      },
    });
    if (updated && updated.count !== 1) {
      const sendKind = deliveryMode === 'reply_message' ? 'reply' : 'replacement';
      throw new Error(`Failed to persist the ${this.label(kind)} ${sendKind} send fence`);
    }
  }

  private async recordChatReplyResult(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    replyMessageId: string;
  }): Promise<void> {
    const updated = await this.getDelegate('chat_auto_comment')?.updateMany?.({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        lockToken: params.lockToken,
        status: 'IN_PROGRESS',
      },
      data: {
        deliveryMode: 'reply_message',
        replyMessageId: params.replyMessageId,
        replacementSendStartedAt: null,
      },
    });
    if (updated && updated.count !== 1) {
      throw new Error('Failed to persist the chat auto-comment reply message marker');
    }
  }

  private async release(
    kind: MarkerKind,
    params: {
      chatId: string;
      messageId: string;
      lockToken: string;
      source: 'webhook' | 'poll';
      botId: string | null;
      linkType?: string | null;
      lastError: string | null;
      lastStatusCode: number | null;
    },
  ): Promise<void> {
    await this.getDelegate(kind)?.updateMany?.({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        lockToken: params.lockToken,
        status: 'IN_PROGRESS',
      },
      data: {
        lockToken: null,
        lockedAt: null,
        replacementSendStartedAt: null,
        source: params.source,
        botId: params.botId,
        ...(kind === 'channel_auto_post' ? { linkType: params.linkType ?? null } : {}),
        lastError: params.lastError,
        lastStatusCode: params.lastStatusCode,
      },
    });
  }

  private getDelegate(kind: MarkerKind): MarkerDelegate | null {
    const prisma = this.prisma as unknown as MarkerPrisma;
    return (
      (kind === 'channel_auto_post'
        ? prisma.channelAutoPostAttachMarker
        : prisma.chatAutoCommentAttachMarker) ?? null
    );
  }

  private label(kind: MarkerKind): string {
    return kind === 'channel_auto_post' ? 'channel auto-post' : 'chat auto-comment';
  }

  private isPrismaKnownError(error: unknown, code: string): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      String((error as { code?: unknown }).code) === code,
    );
  }
}
