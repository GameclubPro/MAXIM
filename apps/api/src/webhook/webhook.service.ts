import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookStatus, type Prisma } from '@prisma/client';
import type { MaxUpdate } from '@maxim/contracts';
import { MaxClientService, type MaxChatMemberAccess } from '../max/max-client.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxMembershipLookupService } from '../max/max-membership-lookup.service';
import { PrismaService } from '../prisma/prisma.service';

type WebhookIngestResult = {
  accepted: boolean;
  duplicate: boolean;
};

type BotSelfAccessCacheEntry = {
  canModerate: boolean;
  expiresAtMs: number;
};

const BOT_SELF_ACCESS_CACHE_TTL_MS = 5 * 60 * 1_000;
const BOT_SELF_ACCESS_NEGATIVE_CACHE_TTL_MS = 60 * 1_000;
const BOT_SELF_ACCESS_BACKOFF_MS = 30 * 1_000;
const BOT_SELF_ACCESS_TIMEOUT_MS = 900;
const BOT_SELF_ACCESS_FAILURE_METRIC_STATUSES = [403, 404] as const;

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly rawPayloadSampleRate: number;
  private readonly botSelfAccessCache = new Map<string, BotSelfAccessCacheEntry>();
  private readonly botSelfAccessBackoffUntilMs = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    private readonly maxBotLinkService: MaxBotLinkService,
    @Optional() private readonly membershipLookupService?: MaxMembershipLookupService,
    @Optional() private readonly maxClient?: MaxClientService,
  ) {
    this.rawPayloadSampleRate = configService.get<number>('RAW_PAYLOAD_SAMPLE_RATE', 0.01);
  }

  async ingest(update: MaxUpdate, sourceIp: string | null) {
    await this.invalidateMembershipCacheFromWebhook(update);
    const executionOwnerBotId = await this.syncChatBotBindingFromWebhook(update);
    this.attachExecutionOwnerBotId(update, executionOwnerBotId);

    const shouldKeepRawPayload = Math.random() <= this.rawPayloadSampleRate;
    const rawPayload = shouldKeepRawPayload ? (update.raw ?? {}) : {};

    try {
      await this.persistEvent(update, sourceIp, rawPayload);

      return { accepted: true, duplicate: false };
    } catch (error: unknown) {
      const duplicateResult = await this.handleDuplicateError(error, update.updateId);
      if (duplicateResult) {
        return duplicateResult;
      }

      if (this.shouldRetryWithSanitizedPayload(error)) {
        const sanitizedUpdate = this.sanitizeForJsonStorage(update) as MaxUpdate;
        const sanitizedRawPayload = this.sanitizeForJsonStorage(rawPayload);

        try {
          await this.persistEvent(sanitizedUpdate, sourceIp, sanitizedRawPayload);
          this.logger.warn(
            {
              dedupKey: update.updateId,
              reason: this.extractErrorMessage(error),
            },
            'Stored webhook event with sanitized payload fallback',
          );
          return { accepted: true, duplicate: false };
        } catch (retryError: unknown) {
          const duplicateRetryResult = await this.handleDuplicateError(retryError, update.updateId);
          if (duplicateRetryResult) {
            return duplicateRetryResult;
          }
        }
      }

      this.logger.error({ err: error }, 'Failed to ingest webhook event');
      throw error;
    }
  }

  private async invalidateMembershipCacheFromWebhook(update: MaxUpdate): Promise<void> {
    if (!this.membershipLookupService) {
      return;
    }

    const chatId = update.message?.chatId?.trim() ?? '';
    const memberUserIds =
      update.membership?.memberUserIds ??
      (this.isDirectMembershipChange(update) && update.message?.senderId
        ? [update.message.senderId]
        : []);

    if (!chatId || memberUserIds.length === 0) {
      return;
    }

    try {
      await this.membershipLookupService.invalidateMemberships(chatId, memberUserIds);
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: update.updateId,
          chatId,
          memberUserIds,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to invalidate MAX membership cache from webhook',
      );
    }
  }

  private isDirectMembershipChange(update: MaxUpdate): boolean {
    const normalizedType = update.type.trim().toLowerCase();
    return (
      normalizedType === 'user_added' ||
      normalizedType === 'bot_added' ||
      normalizedType === 'user_removed' ||
      normalizedType === 'bot_removed'
    );
  }

  private async persistEvent(
    update: MaxUpdate,
    sourceIp: string | null,
    rawPayload: Prisma.InputJsonValue,
  ) {
    await this.prisma.webhookEvent.create({
      data: {
        dedupKey: update.updateId,
        ...(update.botId ? { botId: update.botId } : {}),
        sourceIp: sourceIp ?? undefined,
        rawPayload,
        normalizedPayload: update as Prisma.InputJsonValue,
        status: WebhookStatus.RECEIVED,
      },
    });
  }

  private async syncChatBotBindingFromWebhook(update: MaxUpdate): Promise<string | null> {
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId) {
      return null;
    }

    try {
      if (this.isBotRemovalUpdate(update)) {
        return await this.maxBotLinkService.markChatBotRemoved({
          chatId,
          title: update.message?.chatTitle ?? null,
          botId: update.botId,
        });
      }

      const boundBotId = await this.maxBotLinkService.bindChatToBot({
        chatId,
        title: update.message?.chatTitle ?? null,
        botId: update.botId,
      });
      return await this.maybeFailOverExecutionOwner({
        update,
        chatId,
        incomingBotId: update.botId ?? null,
        currentOwnerBotId: boundBotId,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: update.updateId,
          botId: update.botId ?? null,
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to bind chat to bot during webhook ingest',
      );
      return null;
    }
  }

  private async maybeFailOverExecutionOwner(params: {
    update: MaxUpdate;
    chatId: string;
    incomingBotId: string | null;
    currentOwnerBotId: string | null;
  }): Promise<string | null> {
    const incomingBotId = params.incomingBotId?.trim() ?? '';
    const currentOwnerBotId = params.currentOwnerBotId?.trim() ?? '';
    if (
      !this.maxClient ||
      !params.chatId.startsWith('-') ||
      !incomingBotId ||
      !currentOwnerBotId ||
      incomingBotId === currentOwnerBotId
    ) {
      return params.currentOwnerBotId;
    }

    const currentOwnerCanModerate = await this.getBotSelfModerationAccessState(
      params.chatId,
      currentOwnerBotId,
    );
    if (currentOwnerCanModerate !== false) {
      return params.currentOwnerBotId;
    }

    const incomingBotCanModerate = await this.getBotSelfModerationAccessState(
      params.chatId,
      incomingBotId,
    );
    if (incomingBotCanModerate !== true) {
      return params.currentOwnerBotId;
    }

    const reassignedBotId = await this.maxBotLinkService.bindChatToBot({
      chatId: params.chatId,
      title: params.update.message?.chatTitle ?? null,
      botId: incomingBotId,
      allowReassign: true,
    });

    if (reassignedBotId === incomingBotId) {
      this.logger.warn(
        {
          chatId: params.chatId,
          updateId: params.update.updateId,
          previousPrimaryBotId: currentOwnerBotId,
          nextPrimaryBotId: incomingBotId,
        },
        'Promoted the incoming bot to primary after detecting stale owner permissions',
      );
    }

    return reassignedBotId ?? params.currentOwnerBotId;
  }

  private async getBotSelfModerationAccessState(
    chatId: string,
    botId: string,
  ): Promise<boolean | null> {
    const cacheKey = this.buildBotSelfAccessCacheKey(chatId, botId);
    const cached = this.readCachedBotSelfAccess(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const backoffUntilMs = this.botSelfAccessBackoffUntilMs.get(cacheKey) ?? 0;
    if (backoffUntilMs > Date.now()) {
      return null;
    }

    if (!this.maxClient) {
      return null;
    }

    try {
      const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
        botId,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        timeoutMs: BOT_SELF_ACCESS_TIMEOUT_MS,
        ignoreFailureMetricStatuses: BOT_SELF_ACCESS_FAILURE_METRIC_STATUSES,
      });
      return await this.cacheBotSelfAccess(chatId, botId, access);
    } catch (error: unknown) {
      if (this.isTerminalBotSelfAccessError(error)) {
        await this.cacheBotSelfAccess(chatId, botId, null);
        return false;
      }

      this.botSelfAccessBackoffUntilMs.set(cacheKey, Date.now() + BOT_SELF_ACCESS_BACKOFF_MS);
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh bot self access snapshot during webhook owner failover check',
      );
      return null;
    }
  }

  private async cacheBotSelfAccess(
    chatId: string,
    botId: string,
    access: MaxChatMemberAccess | null,
  ): Promise<boolean> {
    const canModerate = access?.isAdmin === true || access?.isOwner === true;
    const cacheKey = this.buildBotSelfAccessCacheKey(chatId, botId);
    this.botSelfAccessCache.set(cacheKey, {
      canModerate,
      expiresAtMs:
        Date.now() +
        (canModerate ? BOT_SELF_ACCESS_CACHE_TTL_MS : BOT_SELF_ACCESS_NEGATIVE_CACHE_TTL_MS),
    });
    this.botSelfAccessBackoffUntilMs.delete(cacheKey);
    await this.persistBotSelfAccessSnapshot(chatId, botId, access);
    return canModerate;
  }

  private async persistBotSelfAccessSnapshot(
    chatId: string,
    botId: string,
    access: MaxChatMemberAccess | null,
  ): Promise<void> {
    try {
      await this.prisma.chatBotMembership.updateMany({
        where: {
          chatId,
          botId,
        },
        data: {
          permissionsSnapshot: {
            checkedAt: new Date().toISOString(),
            isAdmin: access?.isAdmin === true,
            isOwner: access?.isOwner === true,
            permissions: Array.from(
              new Set(
                (access?.permissions ?? [])
                  .map((permission) => permission.trim())
                  .filter((permission) => permission.length > 0),
              ),
            ),
          } satisfies Prisma.InputJsonValue,
        },
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist bot self access snapshot during webhook owner failover check',
      );
    }
  }

  private buildBotSelfAccessCacheKey(chatId: string, botId: string): string {
    return `${chatId}:${botId}`;
  }

  private readCachedBotSelfAccess(cacheKey: string): boolean | null {
    const cached = this.botSelfAccessCache.get(cacheKey);
    if (!cached) {
      return null;
    }
    if (cached.expiresAtMs <= Date.now()) {
      this.botSelfAccessCache.delete(cacheKey);
      return null;
    }
    return cached.canModerate;
  }

  private isBotRemovalUpdate(update: MaxUpdate): boolean {
    return update.type.trim().toLowerCase() === 'bot_removed';
  }

  private attachExecutionOwnerBotId(update: MaxUpdate, botId: string | null): void {
    if (!botId) {
      return;
    }

    (
      update as MaxUpdate & {
        executionOwnerBotId?: string;
      }
    ).executionOwnerBotId = botId;
  }

  private async handleDuplicateError(
    error: unknown,
    updateId: string,
  ): Promise<WebhookIngestResult | null> {
    const code = (error as { code?: string }).code;
    if (code !== 'P2002') {
      return null;
    }

    return { accepted: true, duplicate: true };
  }

  private shouldRetryWithSanitizedPayload(error: unknown): boolean {
    const code = (error as { code?: string }).code;
    if (code === 'P2002') {
      return false;
    }

    const message = this.extractErrorMessage(error);
    return (
      code === 'InvalidArg' ||
      message.includes('hex escape') ||
      message.includes('unicode') ||
      message.includes('surrogate') ||
      message.includes('invalid byte sequence') ||
      message.includes('null byte')
    );
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim().toLowerCase();
    }

    const directMessage = (error as { message?: unknown }).message;
    if (typeof directMessage === 'string' && directMessage.trim().length > 0) {
      return directMessage.trim().toLowerCase();
    }

    return String(error).trim().toLowerCase();
  }

  private extractStatusCode(error: unknown): number | null {
    const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
    return typeof maybeStatus === 'number' ? maybeStatus : null;
  }

  private extractMaxErrorCode(error: unknown): string | null {
    const maybeCode = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof maybeCode === 'string' && maybeCode.trim().length > 0
      ? maybeCode.trim().toLowerCase()
      : null;
  }

  private isTerminalBotSelfAccessError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 403 || status === 404) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found') {
      return true;
    }

    const message = this.extractErrorMessage(error);
    return message.includes('bot is not a chat member') || message.includes('not accessible');
  }

  private sanitizeForJsonStorage(
    value: unknown,
    seen = new WeakSet<object>(),
  ): Prisma.InputJsonValue {
    const sanitized = this.sanitizeJsonFragment(value, seen);
    return sanitized ?? ({} as Prisma.InputJsonObject);
  }

  private sanitizeJsonFragment(
    value: unknown,
    seen = new WeakSet<object>(),
  ): Prisma.InputJsonValue | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'string') {
      return this.normalizeStorageString(value);
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (Buffer.isBuffer(value)) {
      return value.toString('base64');
    }

    if (ArrayBuffer.isView(value)) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeJsonFragment(item, seen));
    }

    if (typeof value === 'object') {
      if (seen.has(value)) {
        return null;
      }
      seen.add(value);

      const sanitized: Record<string, Prisma.InputJsonValue | null> = {};
      for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (
          nestedValue === undefined ||
          typeof nestedValue === 'function' ||
          typeof nestedValue === 'symbol'
        ) {
          continue;
        }
        sanitized[key] = this.sanitizeJsonFragment(nestedValue, seen);
      }

      seen.delete(value);
      return sanitized as Prisma.InputJsonObject;
    }

    return this.normalizeStorageString(String(value));
  }

  private normalizeStorageString(value: string): string {
    let normalized = '';

    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);

      if (codeUnit === 0) {
        continue;
      }

      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const nextCodeUnit = value.charCodeAt(index + 1);
        if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
          normalized += value[index] + value[index + 1];
          index += 1;
        } else {
          normalized += '\ufffd';
        }
        continue;
      }

      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        normalized += '\ufffd';
        continue;
      }

      normalized += value[index];
    }

    return normalized;
  }
}
