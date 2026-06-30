import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import {
  escapeHtmlAttribute,
  escapeHtmlPreservingWhitespace,
  renderMaxTextMarkupAsHtml,
  type MaxTextMarkup,
} from '../../common/max-text-markup.util';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MaxClientService,
  type MaxActionDispatchOptions,
  type MaxAttachmentPayload,
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

type VisibleMessageText = {
  text: string;
  markup: MaxTextMarkup[];
};

type RelayMessagePayload = {
  text: VisibleMessageText;
  imageAttachments: MaxAttachmentPayload[];
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

const DEFAULT_LOOKUP_TIMEOUT_MS = 1_000;
const DEFAULT_CACHE_TTL_SEC = 120;
const DEFAULT_RELAY_LOCK_TTL_SEC = 3_600;
const RELAY_LOCK_PREFIX = 'karavan-storefront-relay:v1';
const KARAVAN_STOREFRONT_RELAY_SOURCE_TAG = 'karavan_storefront_relay';
const MESSAGE_PREVIEW_LIMIT = 3_500;

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
  private readonly inFlightLookups = new Map<string, Promise<LookupResponse>>();

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

    const relayPayload = this.extractRelayMessagePayload(context);
    if (!relayPayload) {
      return 'noop';
    }

    const store = await this.lookupStorefront(context.senderId);
    if (!store) {
      return 'noop';
    }

    const lockKey = this.buildRelayLockKey(context.chatId, context.messageId!);
    const lockToken = await this.redisCounter.acquireLock(lockKey, this.relayLockTtlSec * 1_000);
    if (!lockToken) {
      return 'duplicate';
    }

    try {
      const sent = await this.maxClient.sendMessageImmediateWithResolvedLink(
        context.chatId,
        this.renderRelayMessage({
          senderId: context.senderId,
          senderName: context.senderName,
          text: relayPayload.text,
        }),
        {
          textFormat: 'html',
          ...(relayPayload.imageAttachments.length > 0
            ? { attachments: relayPayload.imageAttachments }
            : {}),
          buttons: [[{ type: 'link', text: 'Открыть витрину', url: store.url }]],
          debugContext: {
            screen: 'karavan-storefront-relay',
            action: 'replace-dollar-message',
          },
        },
        this.buildDispatchOptions(context.botId),
      );

      let originalDeleted = false;
      let deleteError: string | null = null;
      try {
        await this.maxClient.deleteMessage(context.chatId, context.messageId!, {
          ...this.buildDispatchOptions(context.botId),
          immediate: true,
          actionHealthLane: 'interactive',
        });
        originalDeleted = true;
      } catch (error) {
        deleteError = this.formatError(error);
        this.logger.warn(
          {
            chatId: context.chatId,
            messageId: context.messageId,
            senderId: context.senderId,
            storeSlug: store.slug,
            err: deleteError,
          },
          'Failed to delete original Karavan storefront relay message after bot repost',
        );
      }

      await this.recordAuditLog({
        context,
        store,
        replacementMessageId: sent.messageId,
        publishedUrl: sent.url ?? null,
        originalDeleted,
        deleteError,
      });

      return 'handled';
    } catch (error) {
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
    if (context.updateType !== 'message_created') {
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

  private isPrivateDirectChat(chatId: string): boolean {
    return /^\d+$/u.test(chatId.trim());
  }

  private async lookupStorefront(maxUserId: string): Promise<LookupStore | null> {
    const normalizedMaxUserId = maxUserId.trim();
    const cached = this.cache.get(normalizedMaxUserId);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.response.exists ? cached.response.store : null;
    }

    const existing = this.inFlightLookups.get(normalizedMaxUserId);
    if (existing) {
      const response = await existing;
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
        return { exists: false, store: null };
      })
      .finally(() => {
        this.inFlightLookups.delete(normalizedMaxUserId);
      });

    this.inFlightLookups.set(normalizedMaxUserId, lookup);
    const response = await lookup;
    this.cache.set(normalizedMaxUserId, {
      expiresAtMs: Date.now() + this.cacheTtlSec * 1_000,
      response,
    });
    return response.exists ? response.store : null;
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

  private renderRelayMessage(params: {
    senderId: string;
    senderName?: string | null;
    text: VisibleMessageText;
  }): string {
    const name = escapeHtmlPreservingWhitespace(
      this.resolveSenderName(params.senderName, params.senderId),
    );
    const userUrl = `max://user/${encodeURIComponent(params.senderId)}`;
    const text = this.renderVisibleText(params.text);
    return `<a href="${escapeHtmlAttribute(userUrl)}">${name}</a>\n\n${text}`;
  }

  private resolveSenderName(senderName: string | null | undefined, senderId: string): string {
    const normalized = senderName?.trim();
    return normalized || `Пользователь ${senderId}`;
  }

  private renderVisibleText(source: VisibleMessageText): string {
    const compacted = this.compactText(source.text);
    if (source.markup.length > 0 && compacted.length === source.text.length) {
      const rendered = renderMaxTextMarkupAsHtml(compacted, source.markup);
      if (rendered) {
        return rendered;
      }
    }

    return escapeHtmlPreservingWhitespace(compacted);
  }

  private extractRelayMessagePayload(context: RelayContext): RelayMessagePayload | null {
    const visibleText = this.extractVisibleText(context);
    const trigger = this.findRelayTrigger(visibleText.text);
    if (!trigger) {
      return null;
    }

    return {
      text: this.removeRelayTrigger(visibleText, trigger),
      imageAttachments: this.extractImageAttachments(context.raw),
    };
  }

  private findRelayTrigger(text: string): { start: number; end: number } | null {
    const match = /^\s*\$[ \t]*/u.exec(text);
    if (!match) {
      return null;
    }

    return {
      start: 0,
      end: match[0].length,
    };
  }

  private removeRelayTrigger(
    source: VisibleMessageText,
    trigger: { start: number; end: number },
  ): VisibleMessageText {
    const text = `${source.text.slice(0, trigger.start)}${source.text.slice(trigger.end)}`;
    return {
      text,
      markup: this.shiftMarkupAfterRemovedRange(source.markup, trigger),
    };
  }

  private shiftMarkupAfterRemovedRange(
    markup: MaxTextMarkup[],
    removed: { start: number; end: number },
  ): MaxTextMarkup[] {
    const removedLength = removed.end - removed.start;

    return markup
      .map((item) => {
        const start = item.from;
        const end = item.from + item.length;

        if (end <= removed.start) {
          return item;
        }

        if (start >= removed.end) {
          return {
            ...item,
            from: start - removedLength,
          };
        }

        const nextStart = Math.min(start, removed.start);
        const nextEnd = Math.max(nextStart, end - removedLength);
        const nextLength = nextEnd - nextStart;
        return nextLength > 0
          ? {
              ...item,
              from: nextStart,
              length: nextLength,
            }
          : null;
      })
      .filter((item): item is MaxTextMarkup => item !== null);
  }

  private compactText(text: string): string {
    if (text.length <= MESSAGE_PREVIEW_LIMIT) {
      return text;
    }
    return `${text.slice(0, MESSAGE_PREVIEW_LIMIT - 1)}…`;
  }

  private extractVisibleText(context: RelayContext): VisibleMessageText {
    const rawSource = this.extractRawTextSource(context.raw);
    if (rawSource) {
      return rawSource;
    }
    return {
      text: context.text ?? '',
      markup: [],
    };
  }

  private extractRawTextSource(raw: unknown): VisibleMessageText | null {
    const rawRecord = this.asRecord(raw);
    const message = this.extractRawMessageNode(rawRecord);
    const body = this.asRecord(message?.body);
    const content = this.asRecord(message?.content);
    const payload = this.asRecord(message?.payload);
    const data = this.asRecord(message?.data);
    const messageNode = this.asRecord(message?.message);
    const candidates = [
      body?.text,
      body?.caption,
      body?.plain,
      message?.text,
      message?.caption,
      message?.plain,
      message?.message_text,
      message?.messageText,
      content?.text,
      content?.caption,
      content?.plain,
      payload?.text,
      payload?.caption,
      payload?.plain,
      data?.text,
      data?.caption,
      data?.plain,
      messageNode?.text,
      messageNode?.caption,
      messageNode?.plain,
      rawRecord?.text,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        return {
          text: candidate,
          markup: this.extractRawTextMarkup(message),
        };
      }
    }

    return null;
  }

  private extractRawTextMarkup(message: Record<string, unknown> | null): MaxTextMarkup[] {
    const body = this.asRecord(message?.body);
    const candidates = [
      body?.markup,
      body?.text_markup,
      body?.textMarkup,
      body?.caption_markup,
      body?.captionMarkup,
      message?.markup,
      message?.text_markup,
      message?.textMarkup,
      message?.caption_markup,
      message?.captionMarkup,
    ];

    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) {
        continue;
      }

      const markup = candidate
        .map((item) => this.normalizeTextMarkup(item))
        .filter((item): item is MaxTextMarkup => item !== null);
      if (markup.length > 0) {
        return markup;
      }
    }

    return [];
  }

  private extractImageAttachments(raw: unknown): MaxAttachmentPayload[] {
    const rawRecord = this.asRecord(raw);
    const message = this.extractRawMessageNode(rawRecord);
    const body = this.asRecord(message?.body);
    const content = this.asRecord(message?.content);
    const payload = this.asRecord(message?.payload ?? rawRecord?.payload);
    const data = this.asRecord(message?.data);
    const messageNode = this.asRecord(message?.message);
    const candidates = [
      body?.attachments,
      message?.attachments,
      content?.attachments,
      payload?.attachments,
      data?.attachments,
      messageNode?.attachments,
      rawRecord?.attachments,
    ];

    const attachments: MaxAttachmentPayload[] = [];
    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) {
        continue;
      }

      for (const item of candidate) {
        const attachment = this.normalizeImageAttachment(item);
        if (attachment) {
          attachments.push(attachment);
        }
      }
    }

    return this.dedupeImageAttachments(attachments);
  }

  private normalizeImageAttachment(value: unknown): MaxAttachmentPayload | null {
    const row = this.asRecord(value);
    if (!row) {
      return null;
    }

    const type = this.readLowerString(row.type);
    const mediaType = this.readLowerString(
      row.media_type ??
        row.mediaType ??
        this.asRecord(row.payload)?.media_type ??
        this.asRecord(row.payload)?.mediaType,
    );
    if (
      type !== 'image' &&
      type !== 'photo' &&
      type !== 'picture' &&
      mediaType !== 'image' &&
      mediaType !== 'photo'
    ) {
      return null;
    }

    const payload = this.asRecord(row.payload);
    if (!payload || Object.keys(payload).length === 0) {
      return null;
    }

    return {
      type: 'image',
      payload,
    };
  }

  private extractRawMessageNode(raw: Record<string, unknown> | null): Record<string, unknown> | null {
    const direct = this.asRecord(raw?.message);
    if (direct) {
      return direct;
    }

    const updateType = typeof raw?.update_type === 'string' ? raw.update_type : null;
    const type = typeof raw?.type === 'string' ? raw.type : null;
    const envelopes = [
      this.asRecord(raw?.data),
      this.asRecord(raw?.event),
      this.asRecord(raw?.message_created),
      updateType ? this.asRecord(raw?.[updateType]) : null,
      type ? this.asRecord(raw?.[type]) : null,
    ];

    for (const envelope of envelopes) {
      const nested = this.asRecord(envelope?.message);
      if (nested) {
        return nested;
      }

      const nestedData = this.asRecord(envelope?.data);
      const nestedDataMessage = this.asRecord(nestedData?.message);
      if (nestedDataMessage) {
        return nestedDataMessage;
      }
    }

    return null;
  }

  private dedupeImageAttachments(attachments: MaxAttachmentPayload[]): MaxAttachmentPayload[] {
    const seen = new Set<string>();
    const deduped: MaxAttachmentPayload[] = [];

    for (const attachment of attachments) {
      const key = JSON.stringify(attachment.payload);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(attachment);
    }

    return deduped;
  }

  private normalizeTextMarkup(value: unknown): MaxTextMarkup | null {
    const row = this.asRecord(value);
    if (!row) {
      return null;
    }

    const type = this.readLowerString(row.type);
    const from = this.readInteger(row.from);
    const length = this.readInteger(row.length);
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
      type: type as MaxTextMarkup['type'],
      url: this.readString(row.url) || null,
      userLink: this.readString(row.user_link ?? row.userLink) || null,
    };
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
    replacementMessageId: string;
    publishedUrl: string | null;
    originalDeleted: boolean;
    deleteError: string | null;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          chatId: params.context.chatId,
          actorUserId: params.context.senderId,
          action: 'KARAVAN_STOREFRONT_RELAY',
          payload: {
            sourceMessageId: params.context.messageId,
            replacementMessageId: params.replacementMessageId,
            publishedUrl: params.publishedUrl,
            originalDeleted: params.originalDeleted,
            deleteError: params.deleteError,
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

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
