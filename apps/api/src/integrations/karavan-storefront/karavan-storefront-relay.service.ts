import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MaxClientService,
  type MaxActionDispatchOptions,
} from '../../max/max-client.service';
import { RedisCounterService } from '../../moderation/redis-counter.service';

type RelayContext = {
  updateType: string | null;
  chatId: string;
  messageId: string | null | undefined;
  senderId: string;
  senderName?: string | null;
  text?: string | null;
  raw?: unknown;
  botId?: string | null;
};

export type KaravanStorefrontRelayResult =
  | 'handled'
  | 'noop'
  | 'duplicate'
  | 'disabled'
  | 'failed';

const lookupResponseSchema = z.object({
  exists: z.boolean(),
  store: z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    name: z.string().min(1),
    sellerAccountId: z.string().min(1),
    url: z.string().url(),
    inviteUrl: z.string().url(),
  }).nullable(),
});

type LookupResponse = z.infer<typeof lookupResponseSchema>;
type LookupStore = NonNullable<LookupResponse['store']>;

type CacheEntry = {
  expiresAtMs: number;
  response: LookupResponse;
};

const DEFAULT_LOOKUP_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_TTL_SEC = 120;
const DEFAULT_RELAY_LOCK_TTL_SEC = 3_600;
const RELAY_LOCK_PREFIX = 'karavan-storefront-relay:v1';
const KARAVAN_STOREFRONT_RELAY_SOURCE_TAG = 'karavan_storefront_relay';
export const KARAVAN_STOREFRONT_BUTTON_MESSAGE_TEXT = 'Витрина продавца';

export function isKaravanStorefrontRelayCompanionText(value: unknown): boolean {
  return value === KARAVAN_STOREFRONT_BUTTON_MESSAGE_TEXT;
}

@Injectable()
export class KaravanStorefrontRelayService {
  private readonly logger = new Logger(KaravanStorefrontRelayService.name);
  private readonly enabled: boolean;
  private readonly apiBaseUrl: string | null;
  private readonly integrationToken: string | null;
  private readonly lookupTimeoutMs: number;
  private readonly cacheTtlSec: number;
  private readonly relayLockTtlSec: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlightLookups = new Map<string, Promise<LookupResponse | null>>();

  constructor(
    private readonly maxClient: MaxClientService,
    private readonly prisma: PrismaService,
    private readonly redisCounter: RedisCounterService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    this.enabled = this.readBooleanConfig('KARAVAN_STOREFRONT_RELAY_ENABLED', false);
    this.apiBaseUrl = this.normalizeBaseUrl(
      this.configService?.get<string>('KARAVAN_API_BASE_URL'),
    );
    this.integrationToken = this.normalizeToken(
      this.configService?.get<string>('KARAVAN_INTEGRATION_TOKEN'),
    );
    this.lookupTimeoutMs = this.readPositiveIntConfig(
      'KARAVAN_STOREFRONT_LOOKUP_TIMEOUT_MS',
      DEFAULT_LOOKUP_TIMEOUT_MS,
    );
    this.cacheTtlSec = this.readPositiveIntConfig(
      'KARAVAN_STOREFRONT_CACHE_TTL_SEC',
      DEFAULT_CACHE_TTL_SEC,
    );
    this.relayLockTtlSec = this.readPositiveIntConfig(
      'KARAVAN_STOREFRONT_RELAY_LOCK_TTL_SEC',
      DEFAULT_RELAY_LOCK_TTL_SEC,
    );
  }

  async handleMessageCreated(context: RelayContext): Promise<KaravanStorefrontRelayResult> {
    if (!this.isConfigured()) {
      return this.enabled ? 'failed' : 'disabled';
    }

    if (!this.isEligibleContext(context)) {
      return 'noop';
    }

    if (!this.hasStorefrontRelayTrigger(context)) {
      return 'noop';
    }

    // `$` is an explicit seller action, so the button must reflect the active
    // storefront at this message rather than a previous cached selection.
    const store = await this.lookupStorefront(context.senderId, { fresh: true });
    if (store === undefined) {
      return 'failed';
    }
    if (!store) {
      return 'noop';
    }

    const lockKey = this.buildRelayLockKey(context.chatId, context.messageId!);
    const lockToken = await this.redisCounter.acquireLock(lockKey, this.relayLockTtlSec * 1_000);
    if (!lockToken) {
      return 'duplicate';
    }

    try {
      const sent = await this.maxClient.sendCustomMessageImmediateWithResolvedLink(
        context.chatId,
        {
          text: KARAVAN_STOREFRONT_BUTTON_MESSAGE_TEXT,
          messageLink: {
            type: 'reply',
            mid: context.messageId!,
          },
          attachments: [this.buildStorefrontButtonAttachment(store.url)],
        },
        this.buildDispatchOptions(context.botId),
      );

      await this.recordAuditLog({
        context,
        store,
        companionMessageId: sent.messageId,
        publishedUrl: sent.url ?? null,
      });

      return 'handled';
    } catch (error) {
      if (this.isNonRetriableSendError(error)) {
        await this.redisCounter.releaseLock(lockKey, lockToken);
      }
      this.logger.warn(
        {
          chatId: context.chatId,
          messageId: context.messageId,
          senderId: context.senderId,
          err: this.formatError(error),
        },
        'Karavan storefront relay failed open after claiming the source message',
      );
      return 'failed';
    }
  }

  private isConfigured(): boolean {
    return this.enabled && Boolean(this.apiBaseUrl && this.integrationToken);
  }

  private isEligibleContext(context: RelayContext): boolean {
    if (context.updateType !== 'message_created' && context.updateType !== 'message_edited') {
      return false;
    }
    if (!context.messageId?.trim()) {
      return false;
    }
    if (!context.senderId.trim()) {
      return false;
    }
    return !this.isPrivateDirectChat(context.chatId);
  }

  private hasStorefrontRelayTrigger(context: RelayContext): boolean {
    return this.extractVisibleText(context)?.trimStart().startsWith('$') === true;
  }

  // FLAG: Normalized text can include reply/quote previews; use it only without raw payload or after a validated forward.
  private extractVisibleText(context: RelayContext): string | null {
    const raw = this.asRecord(context.raw);
    const message = this.extractRawMessage(raw);
    if (!message) {
      return raw ? null : this.readString(context.text);
    }

    const directText = this.extractMessageText(message) ?? this.readString(raw?.text);
    if (directText) {
      return directText;
    }

    const link = this.asRecord(message.link);
    if (
      this.readLowerString(link?.type) !== 'forward' ||
      !this.isForwardFromContextSender(link, context.senderId)
    ) {
      return null;
    }

    return this.extractMessageText(this.asRecord(link?.message)) ?? this.readString(context.text);
  }

  private extractRawMessage(raw: Record<string, unknown> | null): Record<string, unknown> | null {
    const directMessage = this.asRecord(raw?.message);
    if (directMessage) {
      return directMessage;
    }

    const envelopeKeys = ['message_created', 'data', 'event'];
    for (const typeKey of [raw?.update_type, raw?.type]) {
      if (typeof typeKey === 'string' && typeKey.trim()) {
        envelopeKeys.push(typeKey);
      }
    }

    for (const key of envelopeKeys) {
      const envelope = this.asRecord(raw?.[key]);
      if (!envelope) {
        continue;
      }

      const nestedMessage = this.asRecord(envelope.message);
      if (nestedMessage) {
        return nestedMessage;
      }

      const nestedData = this.asRecord(envelope.data);
      const nestedDataMessage = this.asRecord(nestedData?.message);
      if (nestedDataMessage) {
        return nestedDataMessage;
      }
    }

    return null;
  }

  private extractMessageText(message: Record<string, unknown> | null): string | null {
    const body = this.asRecord(message?.body);
    const candidates = [
      body?.text,
      body?.caption,
      body?.plain,
      message?.text,
      message?.caption,
      message?.plain,
      message?.message_text,
      message?.messageText,
    ];

    for (const candidate of candidates) {
      const text = this.readString(candidate);
      if (text) {
        return text;
      }
    }

    return null;
  }

  private isForwardFromContextSender(
    link: Record<string, unknown> | null,
    contextSenderId: string,
  ): boolean {
    const sender = this.asRecord(link?.sender);
    const forwardSenderId = this.readString(
      link?.sender_id ?? link?.senderId ?? sender?.user_id ?? sender?.userId ?? sender?.id,
    );

    return !forwardSenderId || forwardSenderId === contextSenderId.trim();
  }

  private isPrivateDirectChat(chatId: string): boolean {
    return /^\d+$/u.test(chatId.trim());
  }

  private async lookupStorefront(
    maxUserId: string,
    options: { fresh?: boolean } = {},
  ): Promise<LookupStore | null | undefined> {
    const normalizedMaxUserId = maxUserId.trim();
    const cached = options.fresh ? undefined : this.cache.get(normalizedMaxUserId);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.response.exists ? cached.response.store : null;
    }

    const existing = options.fresh
      ? undefined
      : this.inFlightLookups.get(normalizedMaxUserId);
    if (existing) {
      const response = await existing;
      if (!response) {
        return undefined;
      }
      return response.exists ? response.store : null;
    }

    const lookup = this.fetchLookup(normalizedMaxUserId)
      .catch((error: unknown) => {
        this.logger.warn(
          {
            maxUserId: normalizedMaxUserId,
            err: this.formatError(error),
          },
          'Karavan storefront lookup failed open',
        );
        return null;
      })
      .finally(() => {
        if (!options.fresh) {
          this.inFlightLookups.delete(normalizedMaxUserId);
        }
      });

    if (!options.fresh) {
      this.inFlightLookups.set(normalizedMaxUserId, lookup);
    }
    const response = await lookup;
    if (!response) {
      return undefined;
    }
    this.cache.set(normalizedMaxUserId, {
      expiresAtMs: Date.now() + this.cacheTtlSec * 1_000,
      response,
    });
    return response.exists ? response.store : null;
  }

  private buildStorefrontButtonAttachment(url: string): Record<string, unknown> {
    return {
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            {
              type: 'link',
              text: 'Открыть витрину',
              url,
            },
          ],
        ],
      },
    };
  }

  private async fetchLookup(maxUserId: string): Promise<LookupResponse> {
    if (!this.apiBaseUrl || !this.integrationToken) {
      return { exists: false, store: null };
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.lookupTimeoutMs);
    timeout.unref();

    try {
      const url = `${this.apiBaseUrl}/v1/integrations/maxim/storefronts/by-max-user/${encodeURIComponent(maxUserId)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.integrationToken}`,
        },
        signal: timeoutController.signal,
      });

      if (!response.ok) {
        throw new Error(`Karavan lookup returned HTTP ${response.status}`);
      }

      return lookupResponseSchema.parse(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildRelayLockKey(chatId: string, messageId: string): string {
    return `${RELAY_LOCK_PREFIX}:${encodeURIComponent(chatId)}:${encodeURIComponent(messageId)}`;
  }

  private buildDispatchOptions(botId?: string | null): MaxActionDispatchOptions {
    return {
      immediate: true,
      trafficClass: 'interactive',
      actionHealthLane: 'interactive',
      sourceTag: KARAVAN_STOREFRONT_RELAY_SOURCE_TAG,
      ...(botId ? { botId } : {}),
    };
  }

  private async recordAuditLog(params: {
    context: RelayContext;
    store: LookupStore;
    companionMessageId: string;
    publishedUrl: string | null;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          chatId: params.context.chatId,
          actorUserId: params.context.senderId,
          action: 'KARAVAN_STOREFRONT_RELAY',
          payload: {
            sourceMessageId: params.context.messageId,
            companionMessageId: params.companionMessageId,
            publishedUrl: params.publishedUrl,
            botId: params.context.botId ?? null,
            store: {
              id: params.store.id,
              slug: params.store.slug,
              name: params.store.name,
              sellerAccountId: params.store.sellerAccountId,
              url: params.store.url,
              inviteUrl: params.store.inviteUrl,
            },
          } as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      this.logger.warn(
        {
          chatId: params.context.chatId,
          sourceMessageId: params.context.messageId,
          err: this.formatError(error),
        },
        'Failed to persist Karavan storefront relay audit log',
      );
    }
  }

  private readBooleanConfig(key: string, fallback: boolean): boolean {
    const value = this.configService?.get<boolean | string>(key);
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
      }
      if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
      }
    }
    return fallback;
  }

  private readPositiveIntConfig(key: string, fallback: number): number {
    const value = this.configService?.get<number | string>(key);
    const numeric = typeof value === 'string' ? Number(value) : value;
    return Number.isFinite(numeric) && numeric! > 0 ? Math.trunc(numeric!) : fallback;
  }

  private normalizeBaseUrl(value: string | null | undefined): string | null {
    const normalized = value?.trim().replace(/\/+$/u, '') ?? '';
    if (!normalized) {
      return null;
    }

    try {
      const url = new URL(normalized);
      return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
    } catch {
      return null;
    }
  }

  private normalizeToken(value: string | null | undefined): string | null {
    const normalized = value?.trim() ?? '';
    return normalized.length >= 16 ? normalized : null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readLowerString(value: unknown): string | null {
    const text = this.readString(value);
    return text ? text.toLowerCase() : null;
  }

  private readString(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }

    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  private readInteger(value: unknown): number | null {
    if (typeof value !== 'number' && typeof value !== 'string') {
      return null;
    }

    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed)) {
      return null;
    }

    return parsed;
  }

  private isNonRetriableSendError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
  }

  private extractStatusCode(error: unknown): number | null {
    const row = this.asRecord(error);
    const response = this.asRecord(row?.response);
    const status = response?.status ?? row?.status ?? row?.statusCode;
    const parsed =
      typeof status === 'number' ? status : typeof status === 'string' ? Number(status) : NaN;

    return Number.isInteger(parsed) ? parsed : null;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
