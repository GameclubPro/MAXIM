import {
  supportRequestDecisionResponseSchema,
  supportRequestQueueResponseSchema,
  type SupportRequestAttachment,
  type SupportRequestDecisionResponse,
  type SupportRequestItem,
  type SupportRequestQueueResponse,
} from '@maxim/contracts/support-requests';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';

type SupportRequestRow = Prisma.SupportRequestGetPayload<Record<string, never>>;

export type CreateSupportRequestInput = {
  botId?: string | null;
  privateChatId: string;
  userId: string;
  userName?: string | null;
  messageId?: string | null;
  text: string;
  attachments: SupportRequestAttachment[];
};

@Injectable()
export class SupportRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  async createRequest(input: CreateSupportRequestInput): Promise<SupportRequestItem> {
    const text = input.text.trim();
    const attachments = input.attachments.slice(0, 10).map((attachment) => ({
      type: attachment.type,
      fileName: attachment.fileName ?? null,
      mimeType: attachment.mimeType ?? null,
      url: attachment.url ?? null,
      payload: attachment.payload ?? null,
    }));

    if (!text && attachments.length === 0) {
      throw new BadRequestException('Пришлите текст проблемы или фото.');
    }

    const row = await this.prisma.supportRequest.create({
      data: {
        botId: input.botId?.trim() || null,
        privateChatId: input.privateChatId,
        userId: input.userId,
        userName: input.userName?.trim() || null,
        messageId: input.messageId?.trim() || null,
        text,
        attachments: attachments as Prisma.InputJsonValue,
      },
    });

    return this.mapItem(row);
  }

  async getQueue(): Promise<SupportRequestQueueResponse> {
    const [items, openCount, closedCount] = await Promise.all([
      this.prisma.supportRequest.findMany({
        where: {
          status: { in: ['NEW', 'CLOSED'] },
        },
        orderBy: [{ status: 'desc' }, { createdAt: 'desc' }],
        take: 100,
      }),
      this.prisma.supportRequest.count({ where: { status: 'NEW' } }),
      this.prisma.supportRequest.count({ where: { status: 'CLOSED' } }),
    ]);

    return supportRequestQueueResponseSchema.parse({
      generatedAt: new Date().toISOString(),
      items: items.map((item) => this.mapItem(item)),
      summary: {
        new: openCount,
        closed: closedCount,
      },
    });
  }

  async closeItem(
    itemId: string,
    actorUserId: string | null,
  ): Promise<SupportRequestDecisionResponse> {
    const existing = await this.prisma.supportRequest.findUnique({ where: { id: itemId } });
    if (!existing) {
      throw new NotFoundException('Обращение не найдено.');
    }

    const row = await this.prisma.supportRequest.update({
      where: { id: itemId },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closedByUserId: actorUserId?.trim() || 'admin',
      },
    });

    return supportRequestDecisionResponseSchema.parse({
      item: this.mapItem(row),
      queue: await this.getQueue(),
      message: 'Обращение закрыто.',
    });
  }

  private mapItem(row: SupportRequestRow): SupportRequestItem {
    return {
      id: row.id,
      status: row.status === 'CLOSED' ? 'CLOSED' : 'NEW',
      botId: row.botId,
      privateChatId: row.privateChatId,
      userId: row.userId,
      userName: row.userName,
      messageId: row.messageId,
      text: row.text,
      attachments: this.normalizeAttachments(row.attachments),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
    };
  }

  private normalizeAttachments(value: Prisma.JsonValue): SupportRequestAttachment[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.normalizeAttachment(item))
      .filter((item): item is SupportRequestAttachment => item !== null);
  }

  private normalizeAttachment(value: Prisma.JsonValue): SupportRequestAttachment | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, Prisma.JsonValue>;
    const type =
      row.type === 'image' || row.type === 'file' || row.type === 'video' || row.type === 'unknown'
        ? row.type
        : 'unknown';
    const payload =
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : null;

    return {
      type,
      fileName: typeof row.fileName === 'string' ? row.fileName : null,
      mimeType: typeof row.mimeType === 'string' ? row.mimeType : null,
      url: typeof row.url === 'string' ? row.url : null,
      payload,
    };
  }
}
