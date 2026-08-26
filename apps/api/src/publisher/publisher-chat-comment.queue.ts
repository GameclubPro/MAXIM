import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import type { ManagedEntityType } from '@maxim/contracts';
import type { QueueJobEnvelope } from '../common/queue-job-envelope';
import type { MaxMessageButton } from '../max/max-client.service';
import type { PublisherFeature } from './publisher-readiness.service';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import { PublisherRuntimeHeartbeatReaderService } from './publisher-runtime-heartbeat.service';

export const PUBLISHER_CHAT_COMMENT_QUEUE = 'publisher-chat-comments';

export type PublisherChatCommentAdmissionFailureReason = 'heartbeat_missing' | 'dispatch_disabled';

export class PublisherChatCommentAdmissionError extends Error {
  constructor(readonly reason: PublisherChatCommentAdmissionFailureReason) {
    super(`Publisher chat-comment admission failed: ${reason}`);
    this.name = 'PublisherChatCommentAdmissionError';
  }
}

type PublisherCommentJobMetadata = {
  idempotencyKey: string;
  sourceTag: 'chat_auto_comment' | 'comment_button_count';
  retryPolicyName: 'publisher-chat-comment';
  createdAt: string;
};

export type PublisherChatCommentAttachJob = QueueJobEnvelope<
  {
    version: 1;
    kind: 'attach_chat_reply';
    markerId: string;
    lockToken: string;
    chatId: string;
    messageId: string;
    senderId: string;
    requiredBotId: string;
    dialogBotId: string;
    button: MaxMessageButton;
  },
  PublisherCommentJobMetadata
>;

export type PublisherCommentKeyboardEditJob = QueueJobEnvelope<
  {
    version: 1;
    kind: 'edit_comment_keyboard';
    entityType: ManagedEntityType;
    readinessFeature: Extract<PublisherFeature, 'publication' | 'chat_comments'>;
    chatId: string;
    messageId: string;
    threadId: string;
    requiredBotId: string;
    dialogBotId: string;
    buttons: MaxMessageButton[][];
    commentsButton: {
      rowIndex: number;
      columnIndex: number;
      baseText: string | null;
    };
    countSnapshot: number;
  },
  PublisherCommentJobMetadata
>;

export type PublisherChatCommentJob =
  | PublisherChatCommentAttachJob
  | PublisherCommentKeyboardEditJob;

const ATTACH_JOB_ATTEMPTS = 12;
const KEYBOARD_EDIT_JOB_ATTEMPTS = 8;
const RETRY_DELAY_MS = 30_000;

export function buildPublisherChatCommentAttachJobId(markerId: string, lockToken: string): string {
  const claimHash = createHash('sha256')
    .update(`${markerId.trim()}\0${lockToken.trim()}`)
    .digest('hex')
    .slice(0, 32);
  return `publisher-chat-comment-${claimHash}`;
}

@Injectable()
export class PublisherChatCommentQueueService {
  private readonly publisherBotId: string;

  constructor(
    @InjectQueue(PUBLISHER_CHAT_COMMENT_QUEUE)
    private readonly queue: Queue<PublisherChatCommentJob>,
    configService: ConfigService,
    private readonly runtimeHeartbeat: PublisherRuntimeHeartbeatReaderService,
  ) {
    this.publisherBotId = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
  }

  async enqueueAttach(params: {
    markerId: string;
    lockToken: string;
    chatId: string;
    messageId: string;
    senderId: string;
    dialogBotId: string;
    button: MaxMessageButton;
    createdAt?: Date;
  }): Promise<void> {
    const markerId = this.requireString(params.markerId, 'markerId');
    const lockToken = this.requireString(params.lockToken, 'lockToken');
    const chatId = this.requireString(params.chatId, 'chatId');
    const messageId = this.requireString(params.messageId, 'messageId');
    const senderId = this.requireString(params.senderId, 'senderId');
    const dialogBotId = this.requireString(params.dialogBotId, 'dialogBotId');
    const createdAt = params.createdAt ?? new Date();

    await this.assertPublisherAdmissionEnabled();
    await this.queue.add(
      'attach-chat-reply',
      {
        version: 1,
        kind: 'attach_chat_reply',
        markerId,
        lockToken,
        chatId,
        messageId,
        senderId,
        requiredBotId: this.publisherBotId,
        dialogBotId,
        button: params.button,
        idempotencyKey: markerId,
        sourceTag: 'chat_auto_comment',
        retryPolicyName: 'publisher-chat-comment',
        createdAt: createdAt.toISOString(),
      },
      this.jobOptions(
        buildPublisherChatCommentAttachJobId(markerId, lockToken),
        ATTACH_JOB_ATTEMPTS,
        true,
      ),
    );
  }

  async enqueueKeyboardEdit(params: {
    entityType: ManagedEntityType;
    readinessFeature: Extract<PublisherFeature, 'publication' | 'chat_comments'>;
    chatId: string;
    messageId: string;
    threadId: string;
    requiredBotId: string;
    dialogBotId: string;
    buttons: MaxMessageButton[][];
    commentsButton: {
      rowIndex: number;
      columnIndex: number;
      baseText: string | null;
    };
    countSnapshot: number;
    createdAt?: Date;
  }): Promise<void> {
    const chatId = this.requireString(params.chatId, 'chatId');
    const messageId = this.requireString(params.messageId, 'messageId');
    const threadId = this.requireString(params.threadId, 'threadId');
    const requiredBotId = this.requireString(params.requiredBotId, 'requiredBotId');
    const dialogBotId = this.requireString(params.dialogBotId, 'dialogBotId');
    const countSnapshot = Math.max(0, Math.trunc(params.countSnapshot));
    const createdAt = params.createdAt ?? new Date();
    const identity = this.hash(
      `${params.entityType}\0${chatId}\0${messageId}\0${threadId}\0${countSnapshot}`,
    );

    await this.assertPublisherAdmissionEnabled();
    await this.queue.add(
      'edit-comment-keyboard',
      {
        version: 1,
        kind: 'edit_comment_keyboard',
        entityType: params.entityType,
        readinessFeature: params.readinessFeature,
        chatId,
        messageId,
        threadId,
        requiredBotId,
        dialogBotId,
        buttons: params.buttons,
        commentsButton: params.commentsButton,
        countSnapshot,
        idempotencyKey: `${params.entityType}:${chatId}:${messageId}:${threadId}`,
        sourceTag: 'comment_button_count',
        retryPolicyName: 'publisher-chat-comment',
        createdAt: createdAt.toISOString(),
      },
      this.jobOptions(`publisher-comment-keyboard-${identity}`, KEYBOARD_EDIT_JOB_ATTEMPTS, false),
    );
  }

  private jobOptions(jobId: string, attempts: number, retainFailed: boolean) {
    return {
      jobId,
      attempts,
      backoff: {
        type: 'fixed' as const,
        delay: RETRY_DELAY_MS,
      },
      removeOnComplete: {
        age: 24 * 60 * 60,
        count: 20_000,
      },
      removeOnFail: retainFailed
        ? false
        : {
            age: 14 * 24 * 60 * 60,
            count: 20_000,
          },
    };
  }

  private async assertPublisherAdmissionEnabled(): Promise<void> {
    const heartbeat = await this.runtimeHeartbeat.read(this.publisherBotId);
    if (!heartbeat) {
      throw new PublisherChatCommentAdmissionError('heartbeat_missing');
    }
    if (!heartbeat.dispatchEnabled) {
      throw new PublisherChatCommentAdmissionError('dispatch_disabled');
    }
  }

  private requireString(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new Error(`Publisher chat-comment ${label} is required`);
    }
    return normalized;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 32);
  }
}
