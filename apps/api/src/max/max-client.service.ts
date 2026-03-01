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
};

export type MaxMessageButton = {
  text: string;
  url: string;
};

export type MaxSendMessageOptions = {
  button?: MaxMessageButton;
  imageToken?: string;
};

export type MaxActionType =
  | 'DELETE_MESSAGE'
  | 'SEND_MESSAGE'
  | 'KICK_MEMBER'
  | 'BAN_MEMBER'
  | 'NOTIFY_MODERATORS';

export type MaxActionJob = {
  actionType: MaxActionType;
  chatId: string;
  messageId?: string;
  userId?: string;
  text?: string;
  options?: MaxSendMessageOptions;
  attempt: number;
  idempotencyKey: string;
  createdAt: string;
};

type MaxActionDispatchOptions = {
  delayMs?: number;
};

const MAX_ACTION_DELAY_MS = 14 * 24 * 60 * 60 * 1000;

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
  ): Promise<string> {
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
      auth: false,
    });
    const uploadResultToken = typeof uploadResult.token === 'string' ? uploadResult.token.trim() : '';
    const token = uploadResultToken || uploadMetaToken;
    if (!token) {
      throw new Error('MAX upload token is missing');
    }
    return token;
  }

  async kickMember(chatId: string, userId: string) {
    await this.dispatchAction({
      actionType: 'KICK_MEMBER',
      chatId,
      userId,
    });
  }

  async banMember(chatId: string, userId: string) {
    await this.dispatchAction({
      actionType: 'BAN_MEMBER',
      chatId,
      userId,
    });
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
        await this.executeMutation(action.chatId, async () => {
          await this.request('post', '/messages', {
            params: {
              chat_id: action.chatId,
            },
            data: {
              text: action.text,
              ...(attachments.length > 0 ? { attachments } : {}),
            },
          });
        });
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
        results.push({
          chatId: String(chatId),
          title: typeof title === 'string' ? title : null,
          lastEventTime:
            typeof lastEventTime === 'number'
              ? lastEventTime
              : typeof lastEventTime === 'string' && lastEventTime.trim() !== ''
                ? Number(lastEventTime)
                : null,
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

  private async dispatchAction(
    payload: Omit<MaxActionJob, 'attempt' | 'idempotencyKey' | 'createdAt'>,
    options?: MaxActionDispatchOptions,
  ) {
    const job: MaxActionJob = {
      ...payload,
      attempt: 1,
      idempotencyKey: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const delayMs = this.normalizeDelayMs(options?.delayMs);

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
    const imageAttachment = this.buildImageAttachment(options?.imageToken);
    if (imageAttachment) {
      attachments.push(imageAttachment);
    }
    const keyboardAttachment = this.buildInlineKeyboardAttachment(options?.button);
    if (keyboardAttachment) {
      attachments.push(keyboardAttachment);
    }
    return attachments;
  }

  private buildImageAttachment(imageToken?: string): Record<string, unknown> | null {
    const token = imageToken?.trim();
    if (!token) {
      return null;
    }

    return {
      type: 'image',
      payload: {
        token,
      },
    };
  }

  private buildInlineKeyboardAttachment(button?: MaxMessageButton): Record<string, unknown> | null {
    if (!button) {
      return null;
    }

    return {
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            {
              type: 'link',
              text: button.text,
              url: button.url,
            },
          ],
        ],
      },
    };
  }

  private async executeMutation(chatId: string, operation: () => Promise<void>) {
    await this.ensureCircuitClosed();
    await this.enforceRateLimit(chatId);

    try {
      await operation();
      this.actionHealthService.recordSuccess();
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
    const auth = config.auth !== false;
    const headers = config.headers as Record<string, string> | undefined;
    const { auth: _auth, ...restConfig } = config;
    const response = await firstValueFrom(
      this.httpService.request<T>({
        method,
        url,
        ...restConfig,
        headers: auth ? { Authorization: this.token, ...(headers ?? {}) } : headers,
      }),
    );

    return response.data;
  }
}
