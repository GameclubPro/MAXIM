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
  debugContext?: {
    screen?: string;
    action?: string;
  };
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
  private readonly limiterRedis: Redis;
  private readonly criticalFailuresMs: number[] = [];
  private readonly pendingTimeouts = new Set<NodeJS.Timeout>();
  private circuitOpenUntilMs = 0;

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService,
    private readonly actionHealthService: ActionHealthService,
    @Optional() @InjectQueue('moderation-actions') private readonly actionQueue?: Queue<MaxActionJob>,
  ) {
    this.baseUrl = configService.getOrThrow<string>('MAX_API_BASE_URL');
    this.token = configService.getOrThrow<string>('MAX_BOT_TOKEN');
    this.dispatchEnabled = configService.get<boolean>('MAX_ACTION_DISPATCH_ENABLED', true);
    this.globalRpsLimit = configService.get<number>('MAX_API_GLOBAL_RPS', 120);
    this.chatRpsLimit = configService.get<number>('MAX_API_CHAT_RPS', 10);
    this.circuitFailureThreshold = configService.get<number>('MAX_API_CIRCUIT_FAILURE_THRESHOLD', 30);
    this.circuitWindowSec = configService.get<number>('MAX_API_CIRCUIT_WINDOW_SEC', 30);
    this.circuitOpenSec = configService.get<number>('MAX_API_CIRCUIT_OPEN_SEC', 20);
    this.limiterRedis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
  }

  async onModuleDestroy() {
    for (const timeout of this.pendingTimeouts) {
      clearTimeout(timeout);
    }
    this.pendingTimeouts.clear();
    await this.limiterRedis.quit();
  }

  async deleteMessage(chatId: string, messageId: string, options?: MaxActionDispatchOptions) {
    await this.dispatchAction({
      actionType: 'DELETE_MESSAGE',
      chatId,
      messageId,
    }, options);
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: MaxSendMessageOptions,
    dispatchOptions?: MaxActionDispatchOptions,
  ) {
    await this.dispatchAction({
      actionType: 'SEND_MESSAGE',
      chatId,
      text,
      options,
    }, dispatchOptions);
  }

  async uploadImage(
    data: Buffer,
    fileName = 'broadcast-image.jpg',
    mimeType = 'image/jpeg',
  ): Promise<Record<string, unknown>> {
    const uploadMeta = await this.request<Record<string, unknown>>('post', '/uploads', {
      params: {
        type: 'image',
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
    await this.dispatchAction({
      actionType: 'KICK_MEMBER',
      chatId,
      userId,
    }, options);
  }

  async banMember(chatId: string, userId: string, options?: MaxActionDispatchOptions) {
    await this.dispatchAction({
      actionType: 'BAN_MEMBER',
      chatId,
      userId,
    }, options);
  }

  async unbanMember(chatId: string, userId: string, options?: MaxActionDispatchOptions) {
    await this.dispatchAction({
      actionType: 'UNBAN_MEMBER',
      chatId,
      userId,
    }, options);
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
          return this.request<Record<string, unknown>>('post', '/messages', {
            params: {
              chat_id: action.chatId,
            },
            data: {
              text: action.text,
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
    const value = data.title ?? data.name;

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
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

  private parseChatLink(row: Record<string, unknown>): string | null {
    const rawLink = row.link ?? row.url ?? row.message_url ?? row.messageUrl;
    if (typeof rawLink !== 'string') {
      return null;
    }

    const normalizedLink = rawLink.trim();
    if (!normalizedLink) {
      return null;
    }

    if (normalizedLink.startsWith('http://') || normalizedLink.startsWith('https://')) {
      return normalizedLink;
    }

    return null;
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
    const job: MaxActionJob = {
      ...payload,
      ...(payload.actionType === 'SEND_MESSAGE' && autoDeleteDelayMs > 0
        ? { autoDeleteDelayMs }
        : {}),
      attempt: 1,
      idempotencyKey: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const delayMs = this.normalizeDelayMs(options?.delayMs);
    const immediate = options?.immediate === true;

    if (immediate && delayMs > 0) {
      throw new Error('Immediate dispatch cannot be combined with delay');
    }

    if (immediate) {
      await this.executeActionJob(job);
      return;
    }

    if (this.dispatchEnabled && this.actionQueue) {
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
      const timeout = setTimeout(() => {
        this.pendingTimeouts.delete(timeout);
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
      return;
    }

    await this.executeActionJob(job);
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

  private buildImageAttachment(imagePayload?: Record<string, unknown>): Record<string, unknown> | null {
    if (!imagePayload || typeof imagePayload !== 'object' || Object.keys(imagePayload).length === 0) {
      return null;
    }

    return {
      type: 'image',
      payload: imagePayload,
    };
  }

  private buildInlineKeyboardAttachment(options?: MaxSendMessageOptions): Record<string, unknown> | null {
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
    const requestedButtons = sourceButtons.reduce((acc, row) => acc + (Array.isArray(row) ? row.length : 0), 0);
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
        const payload = 'payload' in button && typeof button.payload === 'string' ? button.payload.trim() : '';
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
          'quick' in button && typeof button.quick === 'boolean'
            ? button.quick
            : undefined;
        return {
          type: 'request_geo_location',
          text,
          ...(quick !== undefined ? { quick } : {}),
        };
      }
      case 'chat': {
        const chatTitle =
          'chatTitle' in button && typeof button.chatTitle === 'string' ? button.chatTitle.trim() : '';
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
    method: 'delete' | 'post' | 'get',
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

    return response.data;
  }

  private async requestAbsolute<T = unknown>(
    method: 'delete' | 'post' | 'get',
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

  private readLowerString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }
}
