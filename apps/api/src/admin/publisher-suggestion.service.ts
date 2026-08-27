import {
  publisherSuggestionSchema,
  publisherSuggestionsResponseSchema,
  reviewPublisherSuggestionRequestSchema,
  reviewPublisherSuggestionResponseSchema,
  type PublisherSuggestion,
  type PublisherSuggestionsResponse,
  type ReviewPublisherSuggestionResponse,
} from '@maxim/contracts/publisher';
import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PublicationDispatchProfile, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST } from './admin.service.support';
import { PublicationService } from './publication.service';
import { PublisherPolicyService } from './publisher-policy.service';

@Injectable()
export class PublisherSuggestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PublisherPolicyService,
    private readonly publications: PublicationService,
  ) {}

  async list(entityId: string, user: AuthUser): Promise<PublisherSuggestionsResponse> {
    await this.policy.getEntity('channel', entityId, user);
    const rows = await this.prisma.auditLog.findMany({
      where: { chatId: entityId, action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, payload: true, createdAt: true },
    });
    return publisherSuggestionsResponseSchema.parse({
      items: rows.map((row) => this.present(row)),
    });
  }

  async review(
    entityId: string,
    suggestionId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ReviewPublisherSuggestionResponse> {
    await this.policy.getEntity('channel', entityId, user);
    const parsed = reviewPublisherSuggestionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const row = await this.prisma.auditLog.findFirst({
      where: {
        id: suggestionId.trim(),
        chatId: entityId,
        action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST,
      },
      select: { id: true, chatId: true, payload: true, createdAt: true },
    });
    if (!row) {
      throw new BadRequestException('Предложка не найдена.');
    }
    const payload = this.readPayload(row.payload);
    const currentStatus = this.readStatus(payload.reviewStatus);
    if (currentStatus === 'published' || currentStatus === 'cancelled') {
      return reviewPublisherSuggestionResponseSchema.parse({ suggestion: this.present(row) });
    }

    if (parsed.data.action === 'cancel') {
      const cancelledPayload = {
        ...payload,
        reviewStatus: 'cancelled',
        reviewedAt: new Date().toISOString(),
        reviewedByUserId: user.userId,
      } satisfies Prisma.InputJsonObject;
      const updated = await this.replacePayload(row.id, row.payload, cancelledPayload);
      return reviewPublisherSuggestionResponseSchema.parse({
        suggestion: this.present(updated ?? (await this.requireRow(row.id, entityId))),
      });
    }

    if (currentStatus === 'publishing') {
      const claimedBy = this.readString(payload.reviewedByUserId);
      if (claimedBy && claimedBy !== user.userId) {
        throw new BadRequestException('Предложку уже обрабатывает другой администратор.');
      }
    }
    const claimedPayload = {
      ...payload,
      reviewStatus: 'publishing',
      reviewedAt: new Date().toISOString(),
      reviewedByUserId: user.userId,
    } satisfies Prisma.InputJsonObject;
    if (currentStatus !== 'publishing') {
      const claimed = await this.replacePayload(row.id, row.payload, claimedPayload);
      if (!claimed) {
        return reviewPublisherSuggestionResponseSchema.parse({
          suggestion: this.present(await this.requireRow(row.id, entityId)),
        });
      }
    }

    const text = this.readString(payload.text);
    if (!text) {
      throw new BadRequestException('В предложке нет текста.');
    }
    try {
      const publication = await this.publications.create(
        user,
        {
          requestId: this.publicationRequestId(row.id),
          title: 'Предложка',
          content: {
            text,
            textFormat: this.readString(payload.textFormat) === 'markdown' ? 'markdown' : 'plain',
            buttons: [],
            media: [],
          },
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: entityId, entityType: 'channel' }],
          },
          schedule: { mode: 'now', timezone: 'Europe/Moscow' },
          intent: 'publish',
        },
        PublicationDispatchProfile.PUBLIK_V1,
      );
      const publishedPayload = {
        ...claimedPayload,
        reviewStatus: 'published',
        publicationId: publication.id,
        publishedAt: new Date().toISOString(),
      } satisfies Prisma.InputJsonObject;
      const latest = await this.requireRow(row.id, entityId);
      const updated = await this.replacePayload(row.id, latest.payload, publishedPayload);
      return reviewPublisherSuggestionResponseSchema.parse({
        suggestion: this.present(updated ?? (await this.requireRow(row.id, entityId))),
      });
    } catch (error: unknown) {
      const latest = await this.requireRow(row.id, entityId).catch(() => null);
      if (latest) {
        const latestPayload = this.readPayload(latest.payload);
        if (
          this.readStatus(latestPayload.reviewStatus) === 'publishing' &&
          this.readString(latestPayload.reviewedByUserId) === user.userId
        ) {
          await this.replacePayload(row.id, latest.payload, {
            ...latestPayload,
            reviewStatus: 'pending',
            reviewError: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
          });
        }
      }
      throw error;
    }
  }

  private replacePayload(
    id: string,
    expected: Prisma.JsonValue,
    payload: Prisma.InputJsonObject,
  ): Promise<{ id: string; payload: Prisma.JsonValue; createdAt: Date } | null> {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.auditLog.updateMany({
        where: { id, payload: { equals: expected as Prisma.InputJsonValue } },
        data: { payload },
      });
      if (changed.count !== 1) return null;
      return tx.auditLog.findUniqueOrThrow({
        where: { id },
        select: { id: true, payload: true, createdAt: true },
      });
    });
  }

  private requireRow(id: string, chatId: string) {
    return this.prisma.auditLog.findFirstOrThrow({
      where: { id, chatId, action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST },
      select: { id: true, payload: true, createdAt: true },
    });
  }

  private present(row: {
    id: string;
    payload: Prisma.JsonValue;
    createdAt: Date;
  }): PublisherSuggestion {
    const payload = this.readPayload(row.payload);
    return publisherSuggestionSchema.parse({
      id: row.id,
      text: this.readString(payload.text) ?? '',
      authorDisplayName: this.readString(payload.authorDisplayName),
      createdAt: row.createdAt.toISOString(),
      reviewStatus: this.readStatus(payload.reviewStatus),
      publicationId: this.readString(payload.publicationId),
    });
  }

  private publicationRequestId(suggestionId: string): string {
    return `psg_${createHash('sha256').update(suggestionId).digest('hex').slice(0, 32)}`;
  }

  private readPayload(value: Prisma.JsonValue): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private readStatus(value: unknown): PublisherSuggestion['reviewStatus'] {
    return value === 'publishing' || value === 'published' || value === 'cancelled'
      ? value
      : 'pending';
  }
}
