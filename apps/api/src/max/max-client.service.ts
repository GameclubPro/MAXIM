import { HttpService } from '@nestjs/axios';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import FormData from 'form-data';
import { randomUUID } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import Redis from 'ioredis';
import { ActionHealthService } from '../system/action-health.service';

export type MaxBotChat = {
  chatId: string;
  title: string | null;
  lastEventTime: number | null;
  entityType: 'chat' | 'channel';
  link: string | null;
};

export type MaxChatSnapshot = {
  chatId: string;
  title: string | null;
  participantsCount: number | null;
  status: string | null;
  isPublic: boolean | null;
  link: string | null;
  lastEventAt: string | null;
  entityType: 'chat' | 'channel';
};

export type MaxChannelMessageSnapshot = {
  chatId: string;
  messageId: string;
  publishedAt: string;
  publishedAtMs: number;
  url: string | null;
  views: number | null;
  reactions: MaxChannelMessageReaction[];
};

export type MaxChannelMessageReaction = {
  emoji: string;
  count: number;
};

export type MaxWebhookSubscription = {
  url: string;
  updateTypes: string[];
};

export type MaxChatMemberProfile = {
  userId: string;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
};

export type MaxChatMemberAccess = {
  userId: string | null;
  isAdmin: boolean;
  isOwner: boolean;
  permissions: string[];
};

export type MaxPublishedMessage = {
  messageId: string;
  url: string | null;
};

type MaxMessageMarkup = {
  from: number;
  length: number;
  type:
    | 'emphasized'
    | 'heading'
    | 'link'
    | 'monospaced'
    | 'strikethrough'
    | 'strong'
    | 'underline'
    | 'user_mention';
  url: string | null;
  userLink: string | null;
};

const MAX_CHAT_POST_LINK_BASE_URL = 'https://max.ru';
const DEFAULT_SUCCESS_FALSE_STATUS = 200;

class MaxApiRequestRejectedError extends Error {
  readonly response: {
    status: number;
    data: unknown;
  };

  constructor(status: number, payload: unknown, message: string) {
    super(message);
    this.name = 'MaxApiRequestRejectedError';
    this.response = {
      status,
      data: payload,
    };
  }
}

export type MaxButtonIntent = 'default' | 'positive' | 'negative';

export type MaxLinkButton = {
  type?: 'link';
  text: string;
  url: string;
};

export type MaxCallbackButton = {
  type: 'callback';
  text: string;
  payload: string;
  intent?: MaxButtonIntent;
};

export type MaxOpenAppButton = {
  type: 'open_app';
  text: string;
  webApp?: string | null;
  contactId?: string | number | null;
};

export type MaxRequestContactButton = {
  type: 'request_contact';
  text: string;
};

export type MaxRequestGeoLocationButton = {
  type: 'request_geo_location';
  text: string;
  quick?: boolean;
};

export type MaxChatButton = {
  type: 'chat';
  text: string;
  chatTitle: string;
  chatDescription?: string | null;
  startPayload?: string | null;
  uuid?: string | null;
};

export type MaxReplyMessageLink = {
  type: 'reply';
  mid: string;
};

export type MaxTextFormat = 'markdown' | 'html';

export type MaxMessageButton =
  | MaxLinkButton
  | MaxCallbackButton
  | MaxOpenAppButton
  | MaxRequestContactButton
  | MaxRequestGeoLocationButton
  | MaxChatButton;

export type MaxSendMessageOptions = {
  button?: MaxLinkButton;
  buttons?: MaxMessageButton[][];
  imagePayload?: Record<string, unknown>;
  messageLink?: MaxReplyMessageLink | null;
  textFormat?: MaxTextFormat;
  debugContext?: {
    screen?: string;
    action?: string;
  };
};

export type MaxCustomMessagePayload = {
  text?: string;
  attachments?: Record<string, unknown>[];
  messageLink?: MaxReplyMessageLink | null;
  textFormat?: MaxTextFormat;
};

export type MaxCallbackMessageEdit = {
  text: string;
  options?: MaxSendMessageOptions;
};

export type MaxActionType =
  | 'DELETE_MESSAGE'
  | 'SEND_MESSAGE'
  | 'KICK_MEMBER'
  | 'BAN_MEMBER'
  | 'UNBAN_MEMBER'
  | 'NOTIFY_MODERATORS';

export type MaxActionJob = {
  actionType: MaxActionType;
  chatId: string;
  messageId?: string;
  userId?: string;
  text?: string;
  options?: MaxSendMessageOptions;
  autoDeleteDelayMs?: number;
  attempt: number;
  idempotencyKey: string;
  createdAt: string;
};

export type MaxActionDispatchOptions = {
  delayMs?: number;
  immediate?: boolean;
  autoDeleteDelayMs?: number;
};

const MAX_ACTION_DELAY_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_INLINE_KEYBOARD_BUTTONS = 210;

@Injectable()
export class MaxClientService implements OnModuleDestroy {
  private readonly logger = new Logger(MaxClientService.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly dispatchEnabled: boolean;
  private readonly globalRpsLimit: number;
  private readonly chatRpsLimit: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitWindowSec: number;
  private readonly circuitOpenSec: number;
  private readonly webhookUrl: string | null;
  private readonly webhookHeaderSecret: string | null;
  private readonly limiterRedis: Redis;
  private readonly criticalFailuresMs: number[] = [];
  private readonly pendingTimeouts = new Set<NodeJS.Timeout>();
  private readonly keyedActionTimeouts = new Map<string, NodeJS.Timeout>();
  private circuitOpenUntilMs = 0;

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService,
    private readonly actionHealthService: ActionHealthService,
    @Optional()
    @InjectQueue('moderation-actions')
    private readonly actionQueue?: Queue<MaxActionJob>,
  ) {
    this.baseUrl = configService.getOrThrow<string>('MAX_API_BASE_URL');
    this.token = configService.getOrThrow<string>('MAX_BOT_TOKEN');
    this.dispatchEnabled = configService.get<boolean>('MAX_ACTION_DISPATCH_ENABLED', true);
    this.globalRpsLimit = configService.get<number>('MAX_API_GLOBAL_RPS', 120);
    this.chatRpsLimit = configService.get<number>('MAX_API_CHAT_RPS', 10);
    this.circuitFailureThreshold = configService.get<number>(
      'MAX_API_CIRCUIT_FAILURE_THRESHOLD',
      30,
    );
    this.circuitWindowSec = configService.get<number>('MAX_API_CIRCUIT_WINDOW_SEC', 30);
    this.circuitOpenSec = configService.get<number>('MAX_API_CIRCUIT_OPEN_SEC', 20);
    this.webhookUrl = this.buildWebhookUrl(
      configService.get<string>('APP_BASE_URL'),
      configService.get<string>('MAX_BOT_ID'),
      configService.get<string>('MAX_WEBHOOK_SECRET_PATH'),
    );
    this.webhookHeaderSecret = this.readTrimmedString(
      configService.get<string>('MAX_WEBHOOK_HEADER_SECRET'),
    );
    this.limiterRedis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
  }

  async onModuleDestroy() {
    for (const timeout of new Set([
      ...this.pendingTimeouts,
      ...this.keyedActionTimeouts.values(),
    ])) {
      clearTimeout(timeout);
    }
    this.pendingTimeouts.clear();
    this.keyedActionTimeouts.clear();
    await this.limiterRedis.quit();
  }

  async deleteMessage(chatId: string, messageId: string, options?: MaxActionDispatchOptions) {
    await this.dispatchAction(
      {
        actionType: 'DELETE_MESSAGE',
        chatId,
        messageId,
      },
      options,
    );
  }

  async pinMessage(chatId: string, messageId: string, notify = false): Promise<void> {
    await this.executeMutation(chatId, async () => {
      await this.request('put', `/chats/${chatId}/pin`, {
        data: {
          message_id: messageId,
          notify,
        },
      });
    });
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: MaxSendMessageOptions,
    dispatchOptions?: MaxActionDispatchOptions,
  ) {
    await this.dispatchAction(
      {
        actionType: 'SEND_MESSAGE',
        chatId,
        text,
        options,
      },
      dispatchOptions,
    );
  }

  async sendMessageImmediateWithId(
    chatId: string,
    text: string,
    options?: MaxSendMessageOptions,
  ): Promise<MaxPublishedMessage> {
    const attachments = this.buildMessageAttachments(options);
    const messageLink = this.buildMessageLinkData(options?.messageLink);
    const sendResponse = await this.executeMutation(chatId, async () => {
      return this.request<Record<string, unknown>>('post', '/messages', {
        params: {
          chat_id: chatId,
        },
        data: {
          text,
          ...(options?.textFormat ? { format: options.textFormat } : {}),
          ...(messageLink ? { link: messageLink } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      });
    });

    const messageId = this.extractMessageIdFromSendResponse(sendResponse);
    if (!messageId) {
      throw new Error('MAX send response is missing message id');
    }

    return {
      messageId,
      url: this.parseChatLink(sendResponse),
    };
  }

  async sendMessageImmediateToUser(
    userId: string,
    text: string,
    options?: MaxSendMessageOptions,
  ): Promise<MaxPublishedMessage> {
    const attachments = this.buildMessageAttachments(options);
    const messageLink = this.buildMessageLinkData(options?.messageLink);
    const sendResponse = await this.executeMutation(`user:${userId}`, async () => {
      return this.request<Record<string, unknown>>('post', '/messages', {
        params: {
          user_id: userId,
        },
        data: {
          text,
          ...(options?.textFormat ? { format: options.textFormat } : {}),
          ...(messageLink ? { link: messageLink } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      });
    });

    const messageId = this.extractMessageIdFromSendResponse(sendResponse);
    if (!messageId) {
      throw new Error('MAX send response is missing message id');
    }

    return {
      messageId,
      url: this.parseChatLink(sendResponse),
    };
  }

  async sendMessageImmediateWithResolvedLink(
    chatId: string,
    text: string,
    options?: MaxSendMessageOptions,
  ): Promise<MaxPublishedMessage> {
    const { messageId, url: directUrl } = await this.sendMessageImmediateWithId(
      chatId,
      text,
      options,
    );
    if (directUrl) {
      return { messageId, url: directUrl };
    }

    const resolvedUrl = await this.resolveMessageLink(messageId);
    return {
      messageId,
      url: resolvedUrl ?? null,
    };
  }

  async sendCustomMessageImmediate(
    chatId: string,
    payload: MaxCustomMessagePayload,
  ): Promise<Record<string, unknown>> {
    const attachments = Array.isArray(payload.attachments)
      ? payload.attachments.filter(
          (attachment): attachment is Record<string, unknown> =>
            Boolean(attachment) && typeof attachment === 'object',
        )
      : [];
    const messageLink = this.buildMessageLinkData(payload.messageLink);
    const hasText = typeof payload.text === 'string';

    if (!hasText && attachments.length === 0) {
      throw new Error('MAX custom message payload is empty');
    }

    return this.executeMutation(chatId, async () => {
      return this.request<Record<string, unknown>>('post', '/messages', {
        params: {
          chat_id: chatId,
        },
        data: {
          ...(hasText ? { text: payload.text } : {}),
          ...(payload.textFormat ? { format: payload.textFormat } : {}),
          ...(messageLink ? { link: messageLink } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      });
    });
  }

  async sendCustomMessageImmediateWithResolvedLink(
    chatId: string,
    payload: MaxCustomMessagePayload,
  ): Promise<MaxPublishedMessage> {
    const sendResponse = await this.sendCustomMessageImmediate(chatId, payload);
    const messageId = this.extractMessageIdFromSendResponse(sendResponse);
    if (!messageId) {
      throw new Error('MAX send response is missing message id');
    }

    const directUrl = this.parseChatLink(sendResponse);
    if (directUrl) {
      return { messageId, url: directUrl };
    }

    const resolvedUrl = await this.resolveMessageLink(messageId);
    return {
      messageId,
      url: resolvedUrl ?? null,
    };
  }

  async sendMessageCopyWithInlineKeyboard(
    chatId: string,
    sourceMessageId: string,
    fallbackText: string | null,
    options?: Pick<MaxSendMessageOptions, 'button' | 'buttons' | 'debugContext'>,
  ): Promise<MaxPublishedMessage> {
    const sourceMessage = await this.getMessageById(sourceMessageId);
    const attachments = this.buildEditableMessageAttachments(sourceMessage, options);
    const replyLink = this.extractReplyMessageLink(sourceMessage);
    const messageTextPayload = this.buildOutgoingMessageTextPayload(sourceMessage, fallbackText);

    return this.sendCustomMessageImmediateWithResolvedLink(chatId, {
      ...(typeof messageTextPayload.text === 'string' && messageTextPayload.text.length > 0
        ? { text: messageTextPayload.text }
        : {}),
      ...(messageTextPayload.textFormat ? { textFormat: messageTextPayload.textFormat } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(replyLink ? { messageLink: replyLink } : {}),
    });
  }

  async resolveMessageLink(messageId: string): Promise<string | null> {
    const sentMessage = await this.getMessageById(messageId);
    const batchLink = sentMessage ? this.parseChatLink(sentMessage) : null;
    if (batchLink) {
      return batchLink;
    }

    const detailedMessage = await this.getMessageByPath(messageId);
    return detailedMessage ? this.parseChatLink(detailedMessage) : null;
  }

  async editMessageInlineKeyboard(
    chatId: string,
    messageId: string,
    text: string | null,
    options?: Pick<MaxSendMessageOptions, 'button' | 'buttons' | 'debugContext' | 'textFormat'>,
  ) {
    const message = await this.getMessageById(messageId);
    const attachments = this.buildEditableMessageAttachments(message, options);
    const messageTextPayload =
      typeof text === 'string'
        ? this.buildOutgoingMessageTextPayload(message, text, options?.textFormat ?? null)
        : null;

    await this.executeMutation(chatId, async () => {
      await this.request('put', '/messages', {
        params: {
          chat_id: chatId,
          message_id: messageId,
        },
        data: {
          ...(messageTextPayload && typeof messageTextPayload.text === 'string'
            ? {
                text: messageTextPayload.text,
                ...(messageTextPayload.textFormat ? { format: messageTextPayload.textFormat } : {}),
              }
            : {}),
          attachments,
        },
      });
    });
  }

  async listMessages(
    chatId: string,
    countOrOptions:
      | number
      | {
          count?: number;
          from?: number | string | Date | null;
          to?: number | string | Date | null;
        } = 10,
  ): Promise<Record<string, unknown>[]> {
    const options =
      typeof countOrOptions === 'number'
        ? { count: countOrOptions }
        : {
            count: countOrOptions.count ?? 10,
            from: countOrOptions.from ?? null,
            to: countOrOptions.to ?? null,
          };
    const data = await this.request<Record<string, unknown>>('get', '/messages', {
      params: {
        chat_id: chatId,
        count: options.count,
        ...(options.from !== null && options.from !== undefined
          ? { from: this.normalizeMessageQueryBoundary(options.from) }
          : {}),
        ...(options.to !== null && options.to !== undefined
          ? { to: this.normalizeMessageQueryBoundary(options.to) }
          : {}),
      },
    });
    return this.normalizeMessageRows(data);
  }

  async listMessageSnapshots(
    chatId: string,
    options: {
      from?: Date | number | string | null;
      to?: Date | number | string | null;
      count?: number;
      maxPages?: number;
    } = {},
  ): Promise<MaxChannelMessageSnapshot[]> {
    const fromMs = this.normalizeMessageTimestamp(options.from ?? null);
    const toMs = this.normalizeMessageTimestamp(options.to ?? null) ?? Date.now();
    const count = Math.min(Math.max(options.count ?? 100, 1), 100);
    const maxPages = Math.min(Math.max(options.maxPages ?? 60, 1), 200);
    const snapshots = new Map<string, MaxChannelMessageSnapshot>();
    let cursorTo: number | null = toMs;
    let previousSignature = '';

    for (let page = 0; page < maxPages; page += 1) {
      const rows = await this.listMessages(chatId, {
        count,
        ...(cursorTo !== null ? { to: cursorTo } : {}),
      });
      if (rows.length === 0) {
        break;
      }

      const pageItems = rows
        .map((row) => this.parseMessageSnapshot(chatId, row))
        .filter((item): item is MaxChannelMessageSnapshot => item !== null)
        .sort((left, right) => right.publishedAtMs - left.publishedAtMs);

      if (pageItems.length === 0) {
        break;
      }

      for (const item of pageItems) {
        if (fromMs !== null && item.publishedAtMs < fromMs) {
          continue;
        }
        if (item.publishedAtMs > toMs) {
          continue;
        }
        snapshots.set(
          item.messageId,
          this.mergeMessageSnapshots(snapshots.get(item.messageId) ?? null, item),
        );
      }

      const signature = `${pageItems[0]?.messageId ?? ''}:${pageItems.at(-1)?.messageId ?? ''}`;
      if (signature && signature === previousSignature) {
        break;
      }
      previousSignature = signature;

      const oldest = pageItems.at(-1);
      if (!oldest) {
        break;
      }

      if (fromMs !== null && oldest.publishedAtMs <= fromMs) {
        break;
      }

      const nextCursor = oldest.publishedAtMs - 1_000;
      if (cursorTo !== null && nextCursor >= cursorTo) {
        break;
      }

      cursorTo = nextCursor;

      if (rows.length < count) {
        break;
      }
    }

    return Array.from(snapshots.values()).sort(
      (left, right) => right.publishedAtMs - left.publishedAtMs,
    );
  }

  async listWebhookSubscriptions(): Promise<MaxWebhookSubscription[]> {
    const data = await this.request<Record<string, unknown> | unknown[]>('get', '/subscriptions');
    const rows = Array.isArray(data)
      ? data
      : Array.isArray((data as { subscriptions?: unknown }).subscriptions)
        ? ((data as { subscriptions?: unknown[] }).subscriptions ?? [])
        : [];

    return rows
      .map((row) => this.parseWebhookSubscription(row))
      .filter((item): item is MaxWebhookSubscription => item !== null);
  }

  async ensureWebhookSubscription(
    requiredUpdateTypes: string[],
  ): Promise<MaxWebhookSubscription | null> {
    const normalizedRequired = Array.from(
      new Set(
        requiredUpdateTypes
          .map((value) => this.readLowerString(value))
          .filter((value): value is string => Boolean(value)),
      ),
    );
    if (normalizedRequired.length === 0 || !this.webhookUrl || !this.webhookHeaderSecret) {
      return null;
    }

    const existing = await this.listWebhookSubscriptions();
    const current =
      existing.find((item) => item.url === this.webhookUrl) ??
      existing.find((item) => this.normalizeUrl(item.url) === this.normalizeUrl(this.webhookUrl!));
    const mergedUpdateTypes = Array.from(
      new Set([...(current?.updateTypes ?? []), ...normalizedRequired]),
    ).sort();

    if (
      current &&
      current.updateTypes.length === mergedUpdateTypes.length &&
      current.updateTypes.every((value, index) => value === mergedUpdateTypes[index])
    ) {
      return current;
    }

    await this.request('post', '/subscriptions', {
      data: {
        url: this.webhookUrl,
        update_types: mergedUpdateTypes,
        secret: this.webhookHeaderSecret,
      },
    });

    return {
      url: this.webhookUrl,
      updateTypes: mergedUpdateTypes,
    };
  }

  async uploadImage(
    data: Buffer,
    fileName = 'broadcast-image.jpg',
    mimeType = 'image/jpeg',
  ): Promise<Record<string, unknown>> {
    return this.uploadBinary('image', data, fileName, mimeType);
  }

  async uploadFile(
    data: Buffer,
    fileName = 'asset.bin',
    mimeType = 'application/octet-stream',
  ): Promise<Record<string, unknown>> {
    return this.uploadBinary('file', data, fileName, mimeType);
  }

  private async uploadBinary(
    uploadType: 'image' | 'file',
    data: Buffer,
    fileName: string,
    mimeType: string,
  ): Promise<Record<string, unknown>> {
    const uploadMeta = await this.request<Record<string, unknown>>('post', '/uploads', {
      params: {
        type: uploadType,
      },
    });
    const uploadUrl = typeof uploadMeta.url === 'string' ? uploadMeta.url.trim() : '';
    const uploadMetaToken = typeof uploadMeta.token === 'string' ? uploadMeta.token.trim() : '';
    if (!uploadUrl) {
      throw new Error('MAX upload URL is missing');
    }

    const form = new FormData();
    form.append('data', data, {
      filename: fileName,
      contentType: mimeType,
    });
    const uploadResult = await this.requestAbsolute<Record<string, unknown>>('post', uploadUrl, {
      data: form,
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    if (!uploadResult || typeof uploadResult !== 'object') {
      throw new Error('MAX upload payload is missing');
    }

    if (Object.keys(uploadResult).length > 0) {
      return uploadResult;
    }

    if (uploadMetaToken) {
      return { token: uploadMetaToken };
    }

    throw new Error('MAX upload payload is missing');
  }

  async kickMember(chatId: string, userId: string, options?: MaxActionDispatchOptions) {
    await this.dispatchAction(
      {
        actionType: 'KICK_MEMBER',
        chatId,
        userId,
      },
      options,
    );
  }

  async banMember(chatId: string, userId: string, options?: MaxActionDispatchOptions) {
    await this.dispatchAction(
      {
        actionType: 'BAN_MEMBER',
        chatId,
        userId,
      },
      options,
    );
  }

  async unbanMember(chatId: string, userId: string, options?: MaxActionDispatchOptions) {
    await this.dispatchAction(
      {
        actionType: 'UNBAN_MEMBER',
        chatId,
        userId,
      },
      options,
    );
  }

  async cancelScheduledUnban(chatId: string, userId: string) {
    const jobId = this.buildScheduledMemberActionJobId('UNBAN_MEMBER', chatId, userId);
    if (!jobId) {
      return;
    }

    const timeout = this.keyedActionTimeouts.get(jobId);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingTimeouts.delete(timeout);
      this.keyedActionTimeouts.delete(jobId);
    }

    if (this.dispatchEnabled && this.actionQueue) {
      await this.removeQueuedActionJob(jobId);
    }
  }

  async notifyModerators(chatId: string, text: string) {
    await this.dispatchAction({
      actionType: 'NOTIFY_MODERATORS',
      chatId,
      text,
    });
  }

  async executeActionJob(job: MaxActionJob): Promise<void> {
    const action = {
      ...job,
      attempt: Number.isInteger(job.attempt) && job.attempt > 0 ? job.attempt : 1,
    };

    switch (action.actionType) {
      case 'DELETE_MESSAGE':
        if (!action.messageId) {
          throw new Error('messageId is required for DELETE_MESSAGE');
        }
        await this.executeMutation(action.chatId, async () => {
          await this.request('delete', '/messages', {
            params: {
              message_id: action.messageId,
              chat_id: action.chatId,
            },
          });
        });
        return;

      case 'SEND_MESSAGE': {
        if (typeof action.text !== 'string') {
          throw new Error('text is required for SEND_MESSAGE');
        }
        const attachments = this.buildMessageAttachments(action.options);
        const sendResponse = await this.executeMutation(action.chatId, async () => {
          const messageLink = this.buildMessageLinkData(action.options?.messageLink);
          return this.request<Record<string, unknown>>('post', '/messages', {
            params: {
              chat_id: action.chatId,
            },
            data: {
              text: action.text,
              ...(action.options?.textFormat ? { format: action.options.textFormat } : {}),
              ...(messageLink ? { link: messageLink } : {}),
              ...(attachments.length > 0 ? { attachments } : {}),
            },
          });
        });
        const autoDeleteDelayMs = this.normalizeDelayMs(action.autoDeleteDelayMs);
        if (autoDeleteDelayMs > 0) {
          const sentMessageId = this.extractMessageIdFromSendResponse(sendResponse);
          if (!sentMessageId) {
            this.logger.warn(
              {
                chatId: action.chatId,
                autoDeleteDelayMs,
                sendResponse,
              },
              'Failed to schedule auto-delete for sent bot message: response has no message id',
            );
            return;
          }

          try {
            await this.dispatchAction(
              {
                actionType: 'DELETE_MESSAGE',
                chatId: action.chatId,
                messageId: sentMessageId,
              },
              {
                delayMs: autoDeleteDelayMs,
              },
            );
          } catch (error: unknown) {
            this.logger.warn(
              {
                chatId: action.chatId,
                messageId: sentMessageId,
                autoDeleteDelayMs,
                error: error instanceof Error ? error.message : 'Unknown error',
              },
              'Failed to enqueue auto-delete for sent bot message',
            );
          }
        }
        return;
      }

      case 'KICK_MEMBER':
        if (!action.userId) {
          throw new Error('userId is required for KICK_MEMBER');
        }
        await this.executeMutation(action.chatId, async () => {
          await this.request('delete', `/chats/${action.chatId}/members`, {
            params: {
              user_id: action.userId,
            },
          });
        });
        return;

      case 'BAN_MEMBER':
        if (!action.userId) {
          throw new Error('userId is required for BAN_MEMBER');
        }
        await this.executeMutation(action.chatId, async () => {
          await this.request('delete', `/chats/${action.chatId}/members`, {
            params: {
              user_id: action.userId,
              block: true,
            },
          });
        });
        return;

      case 'UNBAN_MEMBER': {
        if (!action.userId) {
          throw new Error('userId is required for UNBAN_MEMBER');
        }
        await this.executeMutation(action.chatId, async () => {
          await this.request('post', `/chats/${action.chatId}/members`, {
            data: {
              user_ids: [action.userId],
            },
          });
        });
        return;
      }

      case 'NOTIFY_MODERATORS':
        this.logger.warn({ chatId: action.chatId, text: action.text ?? '' }, 'Moderator alert');
        this.actionHealthService.recordSuccess();
        return;
    }
  }

  async getChatTitle(chatId: string): Promise<string | null> {
    const data = await this.request<Record<string, unknown>>('get', `/chats/${chatId}`);
    return this.readTrimmedString(data.title ?? data.name);
  }

  async getChatSnapshot(chatId: string): Promise<MaxChatSnapshot> {
    const data = await this.request<Record<string, unknown>>('get', `/chats/${chatId}`);
    const link = this.parseChatLink(data);
    const isPublic = this.readBoolean(data.is_public ?? data.isPublic ?? data.public);

    return {
      chatId,
      title: this.readTrimmedString(data.title ?? data.name),
      participantsCount: this.readNullableInteger(
        data.participants_count ??
          data.participantsCount ??
          data.members_count ??
          data.membersCount,
      ),
      status: this.readLowerString(data.status),
      isPublic: isPublic ?? (link ? true : null),
      link,
      lastEventAt: this.readIsoDateTime(
        data.last_event_time ?? data.lastEventTime ?? data.updated_at ?? data.updatedAt,
      ),
      entityType: this.parseChatEntityType(data),
    };
  }

  async getChatAdminIds(chatId: string): Promise<string[]> {
    const data = await this.request<Record<string, unknown>>(
      'get',
      `/chats/${chatId}/members/admins`,
    );
    const members = Array.isArray(data.members) ? data.members : [];

    return members
      .map((member) => {
        if (!member || typeof member !== 'object') {
          return null;
        }

        const row = member as Record<string, unknown>;
        if (!this.isChatAdminMemberRow(row)) {
          return null;
        }

        const value = row.user_id ?? row.userId ?? row.id;
        if (typeof value === 'number' || typeof value === 'string') {
          return String(value);
        }
        return null;
      })
      .filter((value): value is string => value !== null);
  }

  async getChatEditableAdminIds(chatId: string): Promise<string[]> {
    const data = await this.request<Record<string, unknown>>(
      'get',
      `/chats/${chatId}/members/admins`,
    );
    const members = Array.isArray(data.members) ? data.members : [];

    return members
      .map((member) => {
        if (!member || typeof member !== 'object') {
          return null;
        }

        const row = member as Record<string, unknown>;
        if (!this.isChatAdminMemberRow(row) || !this.canChatAdminEditChat(row)) {
          return null;
        }

        const value = row.user_id ?? row.userId ?? row.id;
        if (typeof value === 'number' || typeof value === 'string') {
          return String(value);
        }
        return null;
      })
      .filter((value): value is string => value !== null);
  }

  async getCurrentChatMemberAccess(chatId: string): Promise<MaxChatMemberAccess> {
    const data = await this.request<Record<string, unknown>>('get', `/chats/${chatId}/members/me`);
    return this.parseChatMemberAccess(data);
  }

  async getChatMemberAccess(chatId: string, userId: string): Promise<MaxChatMemberAccess | null> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return null;
    }

    const data = await this.request<Record<string, unknown>>('get', `/chats/${chatId}/members`, {
      params: {
        user_ids: normalizedUserId,
      },
    });
    const members = Array.isArray(data.members)
      ? data.members
      : Array.isArray(data.users)
        ? data.users
        : [];
    const member = members.find((value) => this.readMemberUserId(value) === normalizedUserId);

    return member ? this.parseChatMemberAccess(member) : null;
  }

  async hasChatMember(chatId: string, userId: string): Promise<boolean> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return false;
    }

    const data = await this.request<Record<string, unknown>>('get', `/chats/${chatId}/members`, {
      params: {
        user_ids: normalizedUserId,
      },
    });
    const members = Array.isArray(data.members)
      ? data.members
      : Array.isArray(data.users)
        ? data.users
        : [];

    return members.some((member) => this.readMemberUserId(member) === normalizedUserId);
  }

  async getChatMemberProfiles(
    chatId: string,
    userIds: readonly string[],
  ): Promise<Map<string, MaxChatMemberProfile>> {
    const normalizedUserIds = Array.from(
      new Set(
        userIds.map((value) => value.trim()).filter((value): value is string => value.length > 0),
      ),
    );
    if (normalizedUserIds.length === 0) {
      return new Map();
    }

    const profiles = new Map<string, MaxChatMemberProfile>();

    for (let index = 0; index < normalizedUserIds.length; index += 100) {
      const chunk = normalizedUserIds.slice(index, index + 100);
      const query = new URLSearchParams();
      for (const userId of chunk) {
        query.append('user_ids', userId);
      }

      const data = await this.request<Record<string, unknown>>(
        'get',
        `/chats/${chatId}/members?${query.toString()}`,
      );
      const members = Array.isArray(data.members)
        ? data.members
        : Array.isArray(data.users)
          ? data.users
          : [];

      for (const member of members) {
        const profile = this.parseChatMemberProfile(member);
        if (!profile) {
          continue;
        }

        profiles.set(profile.userId, profile);
      }
    }

    return profiles;
  }

  async listBotChats(): Promise<MaxBotChat[]> {
    const results: MaxBotChat[] = [];
    const seenMarkers = new Set<string>();
    let marker: string | number | null = null;

    for (let i = 0; i < 20; i += 1) {
      const pageData: Record<string, unknown> = await this.request('get', '/chats', {
        params: {
          count: 100,
          ...(marker !== null ? { marker } : {}),
        },
      });

      const pageChats = Array.isArray(pageData.chats) ? pageData.chats : [];
      for (const item of pageChats) {
        if (!item || typeof item !== 'object') {
          continue;
        }

        const row = item as Record<string, unknown>;
        const chatId = row.chat_id ?? row.chatId ?? row.id;
        if (typeof chatId !== 'string' && typeof chatId !== 'number') {
          continue;
        }

        const title = row.title ?? row.name;
        const lastEventTime = row.last_event_time ?? row.lastEventTime;
        const entityType = this.parseChatEntityType(row);
        const link = this.parseChatLink(row);
        results.push({
          chatId: String(chatId),
          title: typeof title === 'string' ? title : null,
          lastEventTime:
            typeof lastEventTime === 'number'
              ? lastEventTime
              : typeof lastEventTime === 'string' && lastEventTime.trim() !== ''
                ? Number(lastEventTime)
                : null,
          entityType,
          link,
        });
      }

      const nextMarker: unknown = pageData.marker;
      if (
        nextMarker === null ||
        nextMarker === undefined ||
        (typeof nextMarker !== 'string' && typeof nextMarker !== 'number')
      ) {
        break;
      }

      const markerKey = String(nextMarker);
      if (seenMarkers.has(markerKey)) {
        break;
      }
      seenMarkers.add(markerKey);
      marker = nextMarker;
    }

    return results;
  }

  private async getMessageById(messageId: string): Promise<Record<string, unknown> | null> {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) {
      return null;
    }

    const data = await this.request<Record<string, unknown>>('get', '/messages', {
      params: {
        message_ids: normalizedMessageId,
      },
    });
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const firstMessage = messages[0];
    return firstMessage && typeof firstMessage === 'object' && !Array.isArray(firstMessage)
      ? (firstMessage as Record<string, unknown>)
      : null;
  }

  private async getMessageByPath(messageId: string): Promise<Record<string, unknown> | null> {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) {
      return null;
    }

    const data = await this.request<Record<string, unknown>>(
      'get',
      `/messages/${encodeURIComponent(normalizedMessageId)}`,
    );
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  }

  private parseChatEntityType(row: Record<string, unknown>): 'chat' | 'channel' {
    const rawType = row.type ?? row.chat_type ?? row.chatType;
    if (typeof rawType === 'string') {
      const normalized = rawType.trim().toLowerCase();
      if (normalized === 'channel') {
        return 'channel';
      }
      if (normalized === 'chat' || normalized === 'group' || normalized === 'supergroup') {
        return 'chat';
      }
    }

    const link = this.parseChatLink(row);
    if (link && link.toLowerCase().includes('/channel/')) {
      return 'channel';
    }

    return 'chat';
  }

  private readMemberUserId(value: unknown): string | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const row = value as Record<string, unknown>;
    const nestedUser =
      row.user && typeof row.user === 'object' && !Array.isArray(row.user)
        ? (row.user as Record<string, unknown>)
        : null;
    const candidate =
      row.user_id ??
      row.userId ??
      row.id ??
      nestedUser?.user_id ??
      nestedUser?.userId ??
      nestedUser?.id;

    if (typeof candidate !== 'string' && typeof candidate !== 'number') {
      return null;
    }

    const normalized = String(candidate).trim();
    return normalized.length > 0 ? normalized : null;
  }

  private parseChatMemberAccess(value: unknown): MaxChatMemberAccess {
    const row = this.asRecord(value);
    const roleValue = this.readLowerString(
      row?.role ??
        row?.member_role ??
        row?.memberRole ??
        row?.chat_role ??
        row?.chatRole ??
        row?.status ??
        row?.member_status ??
        row?.memberStatus,
    );
    const isOwner =
      roleValue?.includes('owner') === true ||
      roleValue?.includes('creator') === true ||
      row?.is_owner === true ||
      row?.isOwner === true ||
      row?.owner === true ||
      row?.is_creator === true ||
      row?.isCreator === true ||
      row?.creator === true;

    return {
      userId: this.readMemberUserId(value),
      isAdmin: isOwner || (row ? this.isChatAdminMemberRow(row) : false),
      isOwner,
      permissions: row ? this.readChatAdminPermissions(row) : [],
    };
  }

  private parseChatMemberProfile(value: unknown): MaxChatMemberProfile | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const userId = this.readMemberUserId(value);
    if (!userId) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const nestedUser =
      row.user && typeof row.user === 'object' && !Array.isArray(row.user)
        ? (row.user as Record<string, unknown>)
        : null;

    return {
      userId,
      displayName: this.readTrimmedString(
        row.first_name ??
          row.firstName ??
          row.display_name ??
          row.displayName ??
          row.name ??
          nestedUser?.first_name ??
          nestedUser?.firstName ??
          nestedUser?.display_name ??
          nestedUser?.displayName ??
          nestedUser?.name,
      ),
      username: this.readTrimmedString(row.username ?? nestedUser?.username),
      avatarUrl: this.readTrimmedString(
        row.full_avatar_url ??
          row.fullAvatarUrl ??
          row.avatar_url ??
          row.avatarUrl ??
          nestedUser?.full_avatar_url ??
          nestedUser?.fullAvatarUrl ??
          nestedUser?.avatar_url ??
          nestedUser?.avatarUrl,
      ),
    };
  }

  private parseChatLink(row: Record<string, unknown>): string | null {
    const rawLink = row.link ?? row.url ?? row.message_url ?? row.messageUrl;
    if (typeof rawLink === 'string') {
      const normalizedLink = rawLink.trim();
      if (!normalizedLink) {
        return null;
      }

      if (normalizedLink.startsWith('http://') || normalizedLink.startsWith('https://')) {
        return normalizedLink;
      }
    }

    const inferredChatPostLink = this.inferChatPostLink(row);
    if (!inferredChatPostLink) {
      return null;
    }

    return inferredChatPostLink;
  }

  private buildWebhookUrl(
    appBaseUrl: string | undefined,
    botId: string | undefined,
    secretPath: string | undefined,
  ): string | null {
    const normalizedBase = this.readTrimmedString(appBaseUrl);
    const normalizedBotId = this.readTrimmedString(botId);
    const normalizedSecretPath = this.readTrimmedString(secretPath);
    if (!normalizedBase || !normalizedBotId || !normalizedSecretPath) {
      return null;
    }

    return `${normalizedBase.replace(/\/+$/u, '')}/api/webhook/max/${normalizedBotId}/${normalizedSecretPath}`;
  }

  private normalizeMessageRows(payload: Record<string, unknown>): Record<string, unknown>[] {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    return messages.filter(
      (message): message is Record<string, unknown> =>
        Boolean(message) && typeof message === 'object' && !Array.isArray(message),
    );
  }

  private normalizeMessageTimestamp(value: unknown): number | null {
    if (value === null) {
      return null;
    }
    if (value instanceof Date) {
      const millis = value.getTime();
      return Number.isFinite(millis) ? millis : null;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.trunc(value) : null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      if (/^\d+$/u.test(trimmed)) {
        return Number(trimmed);
      }
      const parsed = Date.parse(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  private normalizeMessageQueryBoundary(value: unknown): number | null {
    const timestampMs = this.normalizeMessageTimestamp(value);
    if (timestampMs === null) {
      return null;
    }

    return Math.floor(timestampMs / 1_000);
  }

  private parseMessageSnapshot(
    chatId: string,
    row: Record<string, unknown>,
  ): MaxChannelMessageSnapshot | null {
    const body = this.asRecord(row.body);
    const messageId = this.readTrimmedString(
      body?.mid ?? row.message_id ?? row.messageId ?? row.id,
    );
    const timestampMs = this.normalizeMessageTimestamp(
      row.timestamp ?? row.created_at ?? row.createdAt ?? body?.timestamp,
    );
    if (!messageId || timestampMs === null) {
      return null;
    }

    const publishedAt = new Date(timestampMs);
    if (!Number.isFinite(publishedAt.getTime())) {
      return null;
    }

    const stat = this.asRecord(row.stat);
    return {
      chatId,
      messageId,
      publishedAt: publishedAt.toISOString(),
      publishedAtMs: timestampMs,
      url: this.parseChatLink(row),
      views: this.readNullableInteger(stat?.views),
      reactions: this.parseMessageReactions(row),
    };
  }

  private parseMessageReactions(row: Record<string, unknown>): MaxChannelMessageReaction[] {
    const body = this.asRecord(row.body);
    const stat = this.asRecord(row.stat);
    const candidates = [
      stat?.reactions,
      stat?.reaction_counts,
      stat?.emoji_reactions,
      row.reactions,
      body?.reactions,
    ];

    for (const candidate of candidates) {
      const normalized = this.normalizeMessageReactionSource(candidate);
      if (normalized.length > 0) {
        return normalized;
      }
    }

    return [];
  }

  private normalizeMessageReactionSource(value: unknown): MaxChannelMessageReaction[] {
    if (Array.isArray(value)) {
      const normalized = value
        .map((item) => this.parseMessageReaction(item))
        .filter((item): item is MaxChannelMessageReaction => item !== null);

      return this.mergeMessageReactions(normalized);
    }

    const row = this.asRecord(value);
    if (!row) {
      return [];
    }

    const singleReaction = this.parseMessageReaction(row);
    if (singleReaction) {
      return [singleReaction];
    }

    return this.mergeMessageReactions(
      Object.entries(row)
        .map(([emoji, count]) => this.parseMessageReaction(count, emoji))
        .filter((item): item is MaxChannelMessageReaction => item !== null),
    );
  }

  private parseMessageReaction(
    value: unknown,
    fallbackEmoji?: string,
  ): MaxChannelMessageReaction | null {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') {
      const count = this.readNullableInteger(value);
      const emoji = this.readTrimmedString(fallbackEmoji);
      if (!emoji || count === null || count <= 0) {
        return null;
      }

      return {
        emoji,
        count,
      };
    }

    const row = this.asRecord(value);
    if (!row) {
      return null;
    }

    const emoji = this.readTrimmedString(
      row.emoji ??
        row.reaction ??
        row.code ??
        row.value ??
        row.text ??
        row.label ??
        row.name ??
        fallbackEmoji,
    );
    const count = this.readNullableInteger(
      row.count ?? row.total ?? row.value_count ?? row.votes ?? row.times ?? row.value,
    );
    if (!emoji || count === null || count <= 0) {
      return null;
    }

    return {
      emoji,
      count,
    };
  }

  private mergeMessageReactions(
    reactions: MaxChannelMessageReaction[],
  ): MaxChannelMessageReaction[] {
    const grouped = new Map<string, number>();

    for (const reaction of reactions) {
      grouped.set(reaction.emoji, (grouped.get(reaction.emoji) ?? 0) + reaction.count);
    }

    return Array.from(grouped.entries())
      .map(([emoji, count]) => ({ emoji, count }))
      .sort((left, right) => right.count - left.count || left.emoji.localeCompare(right.emoji));
  }

  private mergeMessageSnapshots(
    current: MaxChannelMessageSnapshot | null,
    incoming: MaxChannelMessageSnapshot,
  ): MaxChannelMessageSnapshot {
    if (!current) {
      return incoming;
    }

    return {
      ...incoming,
      url: incoming.url ?? current.url,
      views: Math.max(current.views ?? 0, incoming.views ?? 0),
      reactions: this.mergeMessageReactions([...current.reactions, ...incoming.reactions]),
    };
  }

  private parseWebhookSubscription(value: unknown): MaxWebhookSubscription | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const url = this.readTrimmedString(row.url);
    if (!url) {
      return null;
    }

    const updateTypesSource = Array.isArray(row.update_types)
      ? row.update_types
      : Array.isArray(row.updateTypes)
        ? row.updateTypes
        : [];
    const updateTypes = Array.from(
      new Set(
        updateTypesSource
          .map((item) => this.readLowerString(item))
          .filter((item): item is string => Boolean(item)),
      ),
    ).sort();

    return {
      url,
      updateTypes,
    };
  }

  private normalizeUrl(value: string): string {
    return value.trim().replace(/\/+$/u, '');
  }

  async answerCallback(
    callbackId: string,
    notification?: string,
    messageEdit?: MaxCallbackMessageEdit,
  ): Promise<void> {
    const normalizedCallbackId = callbackId.trim();
    if (!normalizedCallbackId) {
      throw new Error('callbackId is required');
    }

    const normalizedNotification = typeof notification === 'string' ? notification.trim() : '';
    const hasMessageEdit =
      Boolean(messageEdit) &&
      typeof messageEdit?.text === 'string' &&
      messageEdit.text.trim().length > 0;
    const callbackData: Record<string, unknown> = {};
    if (normalizedNotification) {
      callbackData.notification = normalizedNotification;
    }
    if (hasMessageEdit) {
      const attachments = this.buildMessageAttachments(messageEdit?.options);
      callbackData.message = {
        text: messageEdit!.text.trim(),
        ...(messageEdit?.options?.textFormat ? { format: messageEdit.options.textFormat } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
    }

    await this.request('post', '/answers', {
      params: {
        callback_id: normalizedCallbackId,
      },
      data: callbackData,
    });
  }

  private async dispatchAction(
    payload: Omit<MaxActionJob, 'attempt' | 'idempotencyKey' | 'createdAt'>,
    options?: MaxActionDispatchOptions,
  ) {
    const autoDeleteDelayMs = this.normalizeDelayMs(options?.autoDeleteDelayMs);
    const delayMs = this.normalizeDelayMs(options?.delayMs);
    const immediate = options?.immediate === true;
    const scheduledJobId =
      delayMs > 0
        ? this.buildScheduledMemberActionJobId(payload.actionType, payload.chatId, payload.userId)
        : null;
    const job: MaxActionJob = {
      ...payload,
      ...(payload.actionType === 'SEND_MESSAGE' && autoDeleteDelayMs > 0
        ? { autoDeleteDelayMs }
        : {}),
      attempt: 1,
      idempotencyKey: scheduledJobId ?? randomUUID(),
      createdAt: new Date().toISOString(),
    };

    if (immediate && delayMs > 0) {
      throw new Error('Immediate dispatch cannot be combined with delay');
    }

    if (immediate) {
      await this.executeActionJob(job);
      return;
    }

    if (this.dispatchEnabled && this.actionQueue) {
      if (scheduledJobId) {
        await this.removeQueuedActionJob(scheduledJobId);
      }

      await this.actionQueue.add('execute-max-action', job, {
        jobId: job.idempotencyKey,
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        ...(delayMs > 0 ? { delay: delayMs } : {}),
        backoff: {
          type: 'exponential',
          delay: 1_000,
        },
      });
      return;
    }

    if (delayMs > 0) {
      if (scheduledJobId) {
        const existingTimeout = this.keyedActionTimeouts.get(scheduledJobId);
        if (existingTimeout) {
          clearTimeout(existingTimeout);
          this.pendingTimeouts.delete(existingTimeout);
        }
      }

      const timeout = setTimeout(() => {
        this.pendingTimeouts.delete(timeout);
        if (scheduledJobId) {
          this.keyedActionTimeouts.delete(scheduledJobId);
        }
        void this.executeActionJob(job).catch((error: unknown) => {
          this.logger.warn(
            {
              actionType: job.actionType,
              chatId: job.chatId,
              messageId: job.messageId,
              userId: job.userId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed delayed max action',
          );
        });
      }, delayMs);
      this.pendingTimeouts.add(timeout);
      if (scheduledJobId) {
        this.keyedActionTimeouts.set(scheduledJobId, timeout);
      }
      return;
    }

    await this.executeActionJob(job);
  }

  private buildScheduledMemberActionJobId(
    actionType: MaxActionType,
    chatId: string,
    userId: string | undefined,
  ): string | null {
    if (actionType !== 'UNBAN_MEMBER' || !userId) {
      return null;
    }

    return `member-action:${actionType}:${chatId}:${userId}`;
  }

  private async removeQueuedActionJob(jobId: string) {
    if (!this.actionQueue) {
      return;
    }

    const existingJob = await this.actionQueue.getJob(jobId);
    if (!existingJob) {
      return;
    }

    await existingJob.remove();
  }

  private normalizeDelayMs(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 0;
    }

    const normalized = Math.trunc(value);
    if (normalized <= 0) {
      return 0;
    }

    return Math.min(normalized, MAX_ACTION_DELAY_MS);
  }

  private buildMessageAttachments(options?: MaxSendMessageOptions): Record<string, unknown>[] {
    const attachments: Record<string, unknown>[] = [];
    const imageAttachment = this.buildImageAttachment(options?.imagePayload);
    if (imageAttachment) {
      attachments.push(imageAttachment);
    }
    const keyboardAttachment = this.buildInlineKeyboardAttachment(options);
    if (keyboardAttachment) {
      attachments.push(keyboardAttachment);
    }
    return attachments;
  }

  private buildEditableMessageAttachments(
    message: Record<string, unknown> | null,
    options?: Pick<MaxSendMessageOptions, 'button' | 'buttons' | 'debugContext'>,
  ): Record<string, unknown>[] {
    const existingAttachments = this.extractEditableAttachments(message).filter(
      (attachment) => this.readLowerString(attachment.type) !== 'inline_keyboard',
    );
    const keyboardAttachment = this.buildInlineKeyboardAttachment(options);
    return keyboardAttachment ? [...existingAttachments, keyboardAttachment] : existingAttachments;
  }

  private extractReplyMessageLink(
    message: Record<string, unknown> | null,
  ): MaxReplyMessageLink | null {
    const link = this.asRecord(message?.link);
    if (this.readLowerString(link?.type) !== 'reply') {
      return null;
    }

    const linkedMessage = this.asRecord(link?.message);
    const mid = this.readTrimmedString(linkedMessage?.mid ?? link?.mid);
    return mid
      ? {
          type: 'reply',
          mid,
        }
      : null;
  }

  private extractMessageTextFormat(message: Record<string, unknown> | null): MaxTextFormat | null {
    const body = this.asRecord(message?.body);
    const format = this.readLowerString(body?.format ?? message?.format);

    return format === 'markdown' || format === 'html' ? format : null;
  }

  private buildOutgoingMessageTextPayload(
    message: Record<string, unknown> | null,
    fallbackText: string | null,
    fallbackTextFormat: MaxTextFormat | null = null,
  ): { text: string | null; textFormat: MaxTextFormat | null } {
    const body = this.asRecord(message?.body);
    const sourceText = typeof body?.text === 'string' ? body.text : null;
    const text = sourceText ?? fallbackText;

    if (fallbackTextFormat && typeof fallbackText === 'string') {
      return {
        text: fallbackText,
        textFormat: fallbackTextFormat,
      };
    }

    if (typeof sourceText === 'string' && typeof text === 'string' && text === sourceText) {
      const html = this.renderMessageMarkupAsHtml(sourceText, this.extractMessageMarkup(message));
      if (html && html !== sourceText) {
        return {
          text: html,
          textFormat: 'html',
        };
      }

      const textFormat = this.extractMessageTextFormat(message);
      if (textFormat) {
        return {
          text,
          textFormat,
        };
      }
    }

    return {
      text,
      textFormat: null,
    };
  }

  private extractMessageMarkup(message: Record<string, unknown> | null): MaxMessageMarkup[] {
    const body = this.asRecord(message?.body);
    const rawMarkup = Array.isArray(body?.markup)
      ? body.markup
      : Array.isArray(message?.markup)
        ? message.markup
        : [];

    return rawMarkup
      .map((item) => this.normalizeMessageMarkup(item))
      .filter((item): item is MaxMessageMarkup => item !== null);
  }

  private normalizeMessageMarkup(value: unknown): MaxMessageMarkup | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const type = this.readLowerString(row.type);
    const from = this.readNullableInteger(row.from);
    const length = this.readNullableInteger(row.length);

    if (
      !type ||
      from === null ||
      length === null ||
      from < 0 ||
      length <= 0 ||
      ![
        'emphasized',
        'heading',
        'link',
        'monospaced',
        'strikethrough',
        'strong',
        'underline',
        'user_mention',
      ].includes(type)
    ) {
      return null;
    }

    return {
      from,
      length,
      type: type as MaxMessageMarkup['type'],
      url: this.readTrimmedString(row.url),
      userLink: this.readTrimmedString(row.user_link ?? row.userLink),
    };
  }

  private renderMessageMarkupAsHtml(text: string, markup: MaxMessageMarkup[]): string | null {
    if (markup.length === 0) {
      return null;
    }

    const chars = Array.from(text);
    const openTags = new Map<number, Array<{ open: string; close: string; end: number }>>();
    const closeTags = new Map<number, Array<{ close: string; start: number; end: number }>>();

    for (const item of markup) {
      const start = item.from;
      const end = item.from + item.length;

      if (start < 0 || end <= start || end > chars.length) {
        continue;
      }

      const tag = this.resolveMarkupHtmlTags(item, chars.slice(start, end).join(''));
      if (!tag) {
        continue;
      }

      const openBucket = openTags.get(start) ?? [];
      openBucket.push({
        open: tag.open,
        close: tag.close,
        end,
      });
      openTags.set(start, openBucket);

      const closeBucket = closeTags.get(end) ?? [];
      closeBucket.push({
        close: tag.close,
        start,
        end,
      });
      closeTags.set(end, closeBucket);
    }

    if (openTags.size === 0 && closeTags.size === 0) {
      return null;
    }

    let html = '';

    for (let index = 0; index < chars.length; index += 1) {
      const closing = closeTags.get(index);
      if (closing) {
        closing
          .slice()
          .sort((left, right) => right.start - left.start || left.end - right.end)
          .forEach((tag) => {
            html += tag.close;
          });
      }

      const opening = openTags.get(index);
      if (opening) {
        opening
          .slice()
          .sort((left, right) => right.end - left.end)
          .forEach((tag) => {
            html += tag.open;
          });
      }

      html += this.escapeHtml(chars[index] ?? '');
    }

    const trailing = closeTags.get(chars.length);
    if (trailing) {
      trailing
        .slice()
        .sort((left, right) => right.start - left.start || left.end - right.end)
        .forEach((tag) => {
          html += tag.close;
        });
    }

    return html;
  }

  private resolveMarkupHtmlTags(
    markup: MaxMessageMarkup,
    visibleText: string,
  ): { open: string; close: string } | null {
    switch (markup.type) {
      case 'strong':
      case 'heading':
        return { open: '<strong>', close: '</strong>' };
      case 'emphasized':
        return { open: '<em>', close: '</em>' };
      case 'underline':
        return { open: '<u>', close: '</u>' };
      case 'strikethrough':
        return { open: '<del>', close: '</del>' };
      case 'monospaced':
        return visibleText.includes('\n')
          ? { open: '<pre>', close: '</pre>' }
          : { open: '<code>', close: '</code>' };
      case 'link':
        return markup.url
          ? {
              open: `<a href="${this.escapeHtmlAttribute(markup.url)}">`,
              close: '</a>',
            }
          : null;
      case 'user_mention':
        return markup.userLink
          ? {
              open: `<a href="${this.escapeHtmlAttribute(`https://max.ru/${markup.userLink}`)}">`,
              close: '</a>',
            }
          : null;
      default:
        return null;
    }
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  private escapeHtmlAttribute(value: string): string {
    return this.escapeHtml(value).replaceAll("'", '&#39;');
  }

  private extractEditableAttachments(
    message: Record<string, unknown> | null,
  ): Record<string, unknown>[] {
    const body = this.asRecord(message?.body);
    const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
    return attachments
      .map((attachment) => this.normalizeEditableAttachment(attachment))
      .filter((attachment): attachment is Record<string, unknown> => attachment !== null);
  }

  private normalizeEditableAttachment(attachment: unknown): Record<string, unknown> | null {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      return null;
    }

    const row = attachment as Record<string, unknown>;
    const type = this.readLowerString(row.type);
    const payload = row.payload;
    if (!type || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }

    return {
      type,
      payload,
    };
  }

  private buildImageAttachment(
    imagePayload?: Record<string, unknown>,
  ): Record<string, unknown> | null {
    if (
      !imagePayload ||
      typeof imagePayload !== 'object' ||
      Object.keys(imagePayload).length === 0
    ) {
      return null;
    }

    return {
      type: 'image',
      payload: imagePayload,
    };
  }

  private buildMessageLinkData(link?: MaxReplyMessageLink | null): Record<string, unknown> | null {
    if (!link || link.type !== 'reply') {
      return null;
    }

    const mid = typeof link.mid === 'string' ? link.mid.trim() : '';
    if (!mid) {
      return null;
    }

    return {
      type: 'reply',
      mid,
    };
  }

  private buildInlineKeyboardAttachment(
    options?: MaxSendMessageOptions,
  ): Record<string, unknown> | null {
    const buttons = this.normalizeInlineKeyboardButtons(options);
    if (!buttons) {
      return null;
    }

    return {
      type: 'inline_keyboard',
      payload: {
        buttons,
      },
    };
  }

  private normalizeInlineKeyboardButtons(
    options?: MaxSendMessageOptions,
  ): Array<Array<Record<string, unknown>>> | null {
    if (!options) {
      return null;
    }

    const sourceButtons: MaxMessageButton[][] =
      Array.isArray(options.buttons) && options.buttons.length > 0
        ? options.buttons
        : options.button
          ? [[options.button]]
          : [];

    if (sourceButtons.length === 0) {
      return null;
    }

    const rows: Array<Array<Record<string, unknown>>> = [];
    const requestedButtons = sourceButtons.reduce(
      (acc, row) => acc + (Array.isArray(row) ? row.length : 0),
      0,
    );
    let totalButtons = 0;
    let truncated = false;

    for (const row of sourceButtons) {
      if (!Array.isArray(row) || row.length === 0) {
        continue;
      }

      const normalizedRow: Array<Record<string, unknown>> = [];
      for (const button of row) {
        if (totalButtons >= MAX_INLINE_KEYBOARD_BUTTONS) {
          truncated = true;
          break;
        }

        const normalizedButton = this.normalizeInlineKeyboardButton(button);
        if (normalizedButton) {
          normalizedRow.push(normalizedButton);
          totalButtons += 1;
        }
      }

      if (normalizedRow.length > 0) {
        rows.push(normalizedRow);
      }

      if (truncated) {
        break;
      }
    }

    if (truncated || requestedButtons > MAX_INLINE_KEYBOARD_BUTTONS) {
      this.logger.warn(
        {
          requestedButtons,
          deliveredButtons: totalButtons,
          limit: MAX_INLINE_KEYBOARD_BUTTONS,
          screen: options.debugContext?.screen ?? null,
          action: options.debugContext?.action ?? null,
        },
        'Inline keyboard exceeds MAX limit; tail buttons were trimmed',
      );
    }

    return rows.length > 0 ? rows : null;
  }

  private normalizeInlineKeyboardButton(button: MaxMessageButton): Record<string, unknown> | null {
    const text = typeof button.text === 'string' ? button.text.trim() : '';
    if (!text) {
      return null;
    }

    const explicitType = this.readLowerString((button as { type?: unknown }).type);
    const type = explicitType ?? ('url' in button ? 'link' : null);

    switch (type) {
      case 'link': {
        const url = 'url' in button && typeof button.url === 'string' ? button.url.trim() : '';
        if (!url) {
          return null;
        }
        return {
          type: 'link',
          text,
          url,
        };
      }
      case 'callback': {
        const payload =
          'payload' in button && typeof button.payload === 'string' ? button.payload.trim() : '';
        if (!payload) {
          return null;
        }

        const intent =
          'intent' in button && typeof button.intent === 'string'
            ? this.readLowerString(button.intent)
            : null;

        return {
          type: 'callback',
          text,
          payload,
          ...(intent === 'default' || intent === 'positive' || intent === 'negative'
            ? { intent }
            : {}),
        };
      }
      case 'open_app': {
        const webApp =
          'webApp' in button && typeof button.webApp === 'string' ? button.webApp.trim() : '';
        const contactIdCandidate = 'contactId' in button ? button.contactId : null;
        const contactId =
          typeof contactIdCandidate === 'number'
            ? String(contactIdCandidate)
            : typeof contactIdCandidate === 'string'
              ? contactIdCandidate.trim()
              : '';

        return {
          type: 'open_app',
          text,
          ...(webApp ? { web_app: webApp } : {}),
          ...(contactId ? { contact_id: contactId } : {}),
        };
      }
      case 'request_contact':
        return {
          type: 'request_contact',
          text,
        };
      case 'request_geo_location': {
        const quick =
          'quick' in button && typeof button.quick === 'boolean' ? button.quick : undefined;
        return {
          type: 'request_geo_location',
          text,
          ...(quick !== undefined ? { quick } : {}),
        };
      }
      case 'chat': {
        const chatTitle =
          'chatTitle' in button && typeof button.chatTitle === 'string'
            ? button.chatTitle.trim()
            : '';
        if (!chatTitle) {
          return null;
        }

        const chatDescription =
          'chatDescription' in button && typeof button.chatDescription === 'string'
            ? button.chatDescription.trim()
            : '';
        const startPayload =
          'startPayload' in button && typeof button.startPayload === 'string'
            ? button.startPayload.trim()
            : '';
        const uuid = 'uuid' in button && typeof button.uuid === 'string' ? button.uuid.trim() : '';

        return {
          type: 'chat',
          text,
          chat_title: chatTitle,
          ...(chatDescription ? { chat_description: chatDescription } : {}),
          ...(startPayload ? { start_payload: startPayload } : {}),
          ...(uuid ? { uuid } : {}),
        };
      }
      default:
        return null;
    }
  }

  private async executeMutation<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    await this.ensureCircuitClosed();
    await this.enforceRateLimit(chatId);

    try {
      const result = await operation();
      this.actionHealthService.recordSuccess();
      return result;
    } catch (error: unknown) {
      const status = this.extractStatusCode(error);
      const isCritical = status === 429 || (typeof status === 'number' && status >= 500);
      this.actionHealthService.recordFailure(isCritical);
      if (isCritical) {
        this.registerCriticalFailure();
      }
      throw error;
    }
  }

  private extractMessageIdFromSendResponse(payload: unknown): string | null {
    const queue: Array<{ node: unknown; depth: number }> = [{ node: payload, depth: 0 }];
    const visited = new Set<unknown>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.depth > 4) {
        continue;
      }

      const { node, depth } = current;
      if (!node || typeof node !== 'object') {
        continue;
      }

      if (visited.has(node)) {
        continue;
      }
      visited.add(node);

      if (Array.isArray(node)) {
        for (const item of node) {
          queue.push({ node: item, depth: depth + 1 });
        }
        continue;
      }

      const row = node as Record<string, unknown>;
      const directCandidates = [row.message_id, row.messageId, row.mid];
      for (const value of directCandidates) {
        if (typeof value === 'string' || typeof value === 'number') {
          return String(value);
        }
      }

      if (typeof row.id === 'string' || typeof row.id === 'number') {
        return String(row.id);
      }

      for (const value of Object.values(row)) {
        if (value && (typeof value === 'object' || Array.isArray(value))) {
          queue.push({ node: value, depth: depth + 1 });
        }
      }
    }

    return null;
  }

  private async enforceRateLimit(chatId: string) {
    const nowSec = Math.floor(Date.now() / 1_000);
    const globalKey = `maxapi:rps:global:${nowSec}`;
    const globalCount = await this.limiterRedis.incr(globalKey);
    if (globalCount === 1) {
      await this.limiterRedis.expire(globalKey, 2);
    }
    if (globalCount > this.globalRpsLimit) {
      throw new Error('MAX API global rate limit exceeded');
    }

    const chatKey = `maxapi:rps:chat:${chatId}:${nowSec}`;
    const chatCount = await this.limiterRedis.incr(chatKey);
    if (chatCount === 1) {
      await this.limiterRedis.expire(chatKey, 2);
    }
    if (chatCount > this.chatRpsLimit) {
      throw new Error(`MAX API per-chat rate limit exceeded for chat ${chatId}`);
    }
  }

  private async ensureCircuitClosed() {
    const now = Date.now();
    if (now < this.circuitOpenUntilMs) {
      throw new Error('MAX API circuit breaker is open');
    }

    const windowStart = now - this.circuitWindowSec * 1_000;
    while (this.criticalFailuresMs.length > 0 && this.criticalFailuresMs[0] < windowStart) {
      this.criticalFailuresMs.shift();
    }

    if (this.criticalFailuresMs.length >= this.circuitFailureThreshold) {
      this.circuitOpenUntilMs = now + this.circuitOpenSec * 1_000;
      throw new Error('MAX API circuit breaker opened due to critical failures');
    }
  }

  private registerCriticalFailure(now = Date.now()) {
    this.criticalFailuresMs.push(now);
    const windowStart = now - this.circuitWindowSec * 1_000;
    while (this.criticalFailuresMs.length > 0 && this.criticalFailuresMs[0] < windowStart) {
      this.criticalFailuresMs.shift();
    }
  }

  private extractStatusCode(error: unknown): number | null {
    const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
    return typeof maybeStatus === 'number' ? maybeStatus : null;
  }

  private async request<T = unknown>(
    method: 'delete' | 'post' | 'get' | 'put',
    path: string,
    config: Record<string, unknown> = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await firstValueFrom(
      this.httpService.request<T>({
        method,
        url,
        ...config,
        headers: {
          Authorization: this.token,
          ...(config.headers as Record<string, string> | undefined),
        },
      }),
    );
    this.assertSuccessfulMutationResponse(method, response.status, response.data);

    return response.data;
  }

  private async requestAbsolute<T = unknown>(
    method: 'delete' | 'post' | 'get' | 'put',
    url: string,
    config: Record<string, unknown> = {},
  ): Promise<T> {
    const headers = config.headers as Record<string, string> | undefined;
    const response = await firstValueFrom(
      this.httpService.request<T>({
        method,
        url,
        ...config,
        headers: {
          Authorization: this.token,
          ...(headers ?? {}),
        },
      }),
    );

    return response.data;
  }

  private assertSuccessfulMutationResponse(
    method: 'delete' | 'post' | 'get' | 'put',
    status: number | undefined,
    payload: unknown,
  ) {
    if (method === 'get') {
      return;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return;
    }

    const row = payload as Record<string, unknown>;
    if (row.success !== false) {
      return;
    }

    const message =
      typeof row.message === 'string' && row.message.trim().length > 0
        ? row.message.trim()
        : `MAX API ${method.toUpperCase()} request returned success=false`;

    throw new MaxApiRequestRejectedError(
      typeof status === 'number' ? status : DEFAULT_SUCCESS_FALSE_STATUS,
      payload,
      message,
    );
  }

  private isChatAdminMemberRow(row: Record<string, unknown>): boolean {
    const roleValue = this.readLowerString(
      row.role ??
        row.member_role ??
        row.memberRole ??
        row.chat_role ??
        row.chatRole ??
        row.status ??
        row.member_status ??
        row.memberStatus,
    );

    if (roleValue) {
      if (
        roleValue.includes('admin') ||
        roleValue.includes('owner') ||
        roleValue.includes('creator') ||
        roleValue.includes('moderator')
      ) {
        return true;
      }

      if (
        roleValue.includes('member') ||
        roleValue.includes('user') ||
        roleValue.includes('participant') ||
        roleValue.includes('guest')
      ) {
        return false;
      }
    }

    const positiveFlags = [
      row.is_admin,
      row.isAdmin,
      row.admin,
      row.is_owner,
      row.isOwner,
      row.owner,
      row.is_creator,
      row.isCreator,
      row.creator,
      row.is_moderator,
      row.isModerator,
      row.moderator,
      row.can_manage_chat,
      row.canManageChat,
      row.can_delete_messages,
      row.canDeleteMessages,
    ];
    if (positiveFlags.some((value) => value === true)) {
      return true;
    }

    const explicitNegativeFlags = [
      row.is_admin,
      row.isAdmin,
      row.admin,
      row.is_owner,
      row.isOwner,
      row.owner,
      row.is_creator,
      row.isCreator,
      row.creator,
      row.is_moderator,
      row.isModerator,
      row.moderator,
    ];
    if (explicitNegativeFlags.some((value) => value === false)) {
      return false;
    }

    // Backward compatibility: keep old behavior when API does not expose roles/flags.
    return true;
  }

  private canChatAdminEditChat(row: Record<string, unknown>): boolean {
    const roleValue = this.readLowerString(
      row.role ??
        row.member_role ??
        row.memberRole ??
        row.chat_role ??
        row.chatRole ??
        row.status ??
        row.member_status ??
        row.memberStatus,
    );

    const isOwnerLikeRole =
      roleValue?.includes('owner') === true || roleValue?.includes('creator') === true;
    const isOwnerLikeFlag =
      row.is_owner === true ||
      row.isOwner === true ||
      row.owner === true ||
      row.is_creator === true ||
      row.isCreator === true ||
      row.creator === true;

    if (isOwnerLikeRole || isOwnerLikeFlag) {
      return true;
    }

    const permissions = this.readChatAdminPermissions(row);
    if (permissions.length > 0) {
      const hasEditPermission = permissions.some((permission) =>
        this.isChatEditPermission(permission),
      );
      if (!hasEditPermission) {
        return false;
      }
      return true;
    }

    const explicitEditFlags = [
      row.can_manage_chat,
      row.canManageChat,
      row.can_manage_info,
      row.canManageInfo,
      row.can_change_info,
      row.canChangeInfo,
      row.can_change_chat_info,
      row.canChangeChatInfo,
      row.can_edit_chat,
      row.canEditChat,
      row.can_edit_info,
      row.canEditInfo,
      row.can_edit_link,
      row.canEditLink,
    ]
      .map((value) => this.readBoolean(value))
      .filter((value): value is boolean => value !== null);

    if (explicitEditFlags.length > 0) {
      return explicitEditFlags.some((value) => value === true);
    }

    // Backward compatibility for chats where MAX payload has no granular permissions.
    return true;
  }

  private readChatAdminPermissions(row: Record<string, unknown>): string[] {
    const sources = [
      row.permissions,
      row.rights,
      row.admin_permissions,
      row.adminPermissions,
      row.chat_permissions,
      row.chatPermissions,
    ];

    const normalized = new Set<string>();
    for (const source of sources) {
      const list = this.readPermissionList(source);
      for (const item of list) {
        normalized.add(item);
      }
    }

    return [...normalized];
  }

  private readPermissionList(source: unknown): string[] {
    if (Array.isArray(source)) {
      return source
        .map((item) => this.readLowerString(item))
        .filter((item): item is string => item !== null)
        .map((item) => item.replace(/[-\s]+/gu, '_'));
    }

    if (!source || typeof source !== 'object') {
      return [];
    }

    const row = source as Record<string, unknown>;
    return Object.entries(row)
      .map(([key, value]) => ({ key, value: this.readBoolean(value) }))
      .filter((item) => item.value === true)
      .map((item) => item.key.toLowerCase().replace(/[-\s]+/gu, '_'));
  }

  private isChatEditPermission(permission: string): boolean {
    return (
      permission === 'change_chat_info' ||
      permission === 'edit_chat_info' ||
      permission === 'manage_chat_info' ||
      permission === 'can_change_chat_info' ||
      permission === 'can_edit_chat_info' ||
      permission === 'can_manage_chat_info' ||
      permission === 'edit_chat' ||
      permission === 'can_edit_chat' ||
      permission === 'manage_chat' ||
      permission === 'can_manage_chat' ||
      permission === 'change_info' ||
      permission === 'can_change_info' ||
      permission === 'edit_info' ||
      permission === 'can_edit_info' ||
      permission === 'manage_info' ||
      permission === 'can_manage_info' ||
      permission === 'edit_link' ||
      permission === 'can_edit_link'
    );
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private readBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      if (value === 1) {
        return true;
      }
      if (value === 0) {
        return false;
      }
      return null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }

    return null;
  }

  private readNullableInteger(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
    }

    if (typeof value === 'bigint') {
      return value >= 0n ? Number(value) : null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    const parsed = Number.parseInt(normalized, 10);
    return Number.isNaN(parsed) ? null : Math.max(0, parsed);
  }

  private readBigInt(value: unknown): bigint | null {
    if (typeof value === 'bigint') {
      return value >= 0n ? value : null;
    }

    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) {
        return null;
      }
      return BigInt(value);
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!/^\d+$/u.test(normalized)) {
      return null;
    }

    try {
      return BigInt(normalized);
    } catch {
      return null;
    }
  }

  private inferChatPostLink(row: Record<string, unknown>): string | null {
    const recipient = this.asRecord(row.recipient);
    const chatType = this.readLowerString(
      recipient?.chat_type ?? recipient?.chatType ?? row.chat_type ?? row.chatType,
    );
    if (chatType === 'channel') {
      return null;
    }

    const chatIdValue = recipient?.chat_id ?? recipient?.chatId ?? row.chat_id ?? row.chatId;
    const chatId =
      typeof chatIdValue === 'number' || typeof chatIdValue === 'string'
        ? String(chatIdValue).trim()
        : '';
    if (!chatId) {
      return null;
    }

    const body = this.asRecord(row.body);
    const messageId = this.readTrimmedString(
      body?.mid ?? row.message_id ?? row.messageId ?? row.mid ?? row.id,
    );
    const tokenFromMessageId = this.buildChatPostLinkTokenFromMessageId(messageId);
    if (tokenFromMessageId) {
      return `${MAX_CHAT_POST_LINK_BASE_URL}/c/${chatId}/${tokenFromMessageId}`;
    }

    const tokenFromSequence = this.buildChatPostLinkTokenFromSequence(
      this.readBigInt(body?.seq ?? row.seq ?? row.sequence),
    );
    return tokenFromSequence
      ? `${MAX_CHAT_POST_LINK_BASE_URL}/c/${chatId}/${tokenFromSequence}`
      : null;
  }

  private buildChatPostLinkTokenFromMessageId(messageId: string | null): string | null {
    if (!messageId) {
      return null;
    }

    const hexTail = messageId.split('.').pop()?.trim().toLowerCase() ?? '';
    if (!/^[0-9a-f]{16,}$/u.test(hexTail)) {
      return null;
    }

    return Buffer.from(hexTail.slice(-16), 'hex').toString('base64url');
  }

  private buildChatPostLinkTokenFromSequence(sequence: bigint | null): string | null {
    if (sequence === null || sequence < 0n || sequence > 0xffff_ffff_ffff_ffffn) {
      return null;
    }

    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(sequence);
    return buffer.toString('base64url');
  }

  private readIsoDateTime(value: unknown): string | null {
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return null;
      }

      const timestampMs = value >= 100_000_000_000 ? value : value * 1_000;
      const parsed = new Date(timestampMs);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    if (/^\d+$/u.test(normalized)) {
      return this.readIsoDateTime(Number.parseInt(normalized, 10));
    }

    const parsed = new Date(normalized);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  private readLowerString(value: unknown): string | null {
    const normalized = this.readTrimmedString(value);
    return normalized ? normalized.toLowerCase() : null;
  }
}
