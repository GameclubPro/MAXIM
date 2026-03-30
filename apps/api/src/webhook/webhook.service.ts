import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookStatus, type Prisma } from '@prisma/client';
import type { MaxUpdate } from '@maxim/contracts';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxMembershipLookupService } from '../max/max-membership-lookup.service';
import { PrismaService } from '../prisma/prisma.service';

type WebhookIngestResult = {
  accepted: boolean;
  duplicate: boolean;
};

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly rawPayloadSampleRate: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    private readonly maxBotLinkService: MaxBotLinkService,
    @Optional() private readonly membershipLookupService?: MaxMembershipLookupService,
  ) {
    this.rawPayloadSampleRate = configService.get<number>('RAW_PAYLOAD_SAMPLE_RATE', 0.01);
  }

  async ingest(update: MaxUpdate, sourceIp: string | null) {
    await this.invalidateMembershipCacheFromWebhook(update);
    await this.bindChatToBot(update);

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

  private async bindChatToBot(update: MaxUpdate): Promise<void> {
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId) {
      return;
    }

    try {
      await this.maxBotLinkService.bindChatToBot({
        chatId,
        title: update.message?.chatTitle ?? null,
        botId: update.botId,
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
    }
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
