import {
  addDomainRequestSchema,
  addAdminRequestSchema,
  dateRangeQuerySchema,
  type ChatSettings,
  chatSettingsSchema,
  type Me,
  type ModerationEvent,
  type ChatSummary,
} from '@maxim/contracts';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  getMe(user: AuthUser): Me {
    return {
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
    };
  }

  async listChats(user: AuthUser): Promise<ChatSummary[]> {
    const rows = await this.prisma.chatAdminAllowlist.findMany({
      where: { userId: user.userId },
      include: { chat: true },
      orderBy: {
        chat: {
          createdAt: 'desc',
        },
      },
    });

    return rows.map((row: { chat: { id: string; title: string; createdAt: Date } }) => ({
      id: row.chat.id,
      title: row.chat.title,
      createdAt: row.chat.createdAt.toISOString(),
    }));
  }

  async getSettings(chatId: string, user: AuthUser): Promise<ChatSettings> {
    await this.assertChatAdmin(chatId, user.userId);

    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      include: { settings: true },
    });

    if (!chat?.settings) {
      throw new NotFoundException('Chat settings not found');
    }

    return chatSettingsSchema.parse(chat.settings);
  }

  async updateSettings(chatId: string, user: AuthUser, body: unknown): Promise<ChatSettings> {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = chatSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Chat ${chatId}`,
        settings: {
          create: {
            ...parsed.data,
          },
        },
      },
      update: {
        settings: {
          upsert: {
            update: {
              ...parsed.data,
            },
            create: {
              ...parsed.data,
            },
          },
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'UPDATE_SETTINGS',
        payload: parsed.data,
      },
    });

    return parsed.data;
  }

  async getEvents(chatId: string, user: AuthUser, query: unknown): Promise<ModerationEvent[]> {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = dateRangeQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const from = parsed.data.from ? new Date(parsed.data.from) : undefined;
    const to = parsed.data.to ? new Date(parsed.data.to) : undefined;

    const rows = await this.prisma.moderationEvent.findMany({
      where: {
        chatId,
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      skip: (parsed.data.page - 1) * parsed.data.limit,
      take: parsed.data.limit,
    });

    return rows.map((row: {
      id: string;
      chatId: string;
      userId: string;
      eventType: 'MESSAGE' | 'MEMBER_ACTION' | 'SYSTEM';
      ruleCode: string;
      action: 'NONE' | 'WARN' | 'DELETE_MESSAGE' | 'KICK' | 'BAN';
      maskedExcerpt: string | null;
      score: number;
      createdAt: Date;
      operator: 'BOT' | 'ADMIN';
    }) => ({
      id: row.id,
      chatId: row.chatId,
      userId: row.userId,
      eventType: row.eventType,
      ruleCode: row.ruleCode,
      action: row.action,
      maskedExcerpt: row.maskedExcerpt,
      score: row.score,
      createdAt: row.createdAt.toISOString(),
      operator: row.operator,
    }));
  }

  async addAdmin(chatId: string, user: AuthUser, body: unknown) {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = addAdminRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Chat ${chatId}`,
      },
      update: {},
    });

    await this.prisma.chatAdminAllowlist.upsert({
      where: {
        chatId_userId: {
          chatId,
          userId: parsed.data.userId,
        },
      },
      create: {
        chatId,
        userId: parsed.data.userId,
      },
      update: {},
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'ADD_ADMIN',
        payload: {
          userId: parsed.data.userId,
        },
      },
    });

    return { ok: true };
  }

  async removeAdmin(chatId: string, user: AuthUser, targetUserId: string) {
    await this.assertChatAdmin(chatId, user.userId);

    await this.prisma.chatAdminAllowlist.delete({
      where: {
        chatId_userId: {
          chatId,
          userId: targetUserId,
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'REMOVE_ADMIN',
        payload: {
          userId: targetUserId,
        },
      },
    });

    return { ok: true };
  }

  async addDomain(chatId: string, user: AuthUser, body: unknown) {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = addDomainRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalized = parsed.data.domain.toLowerCase();

    await this.prisma.domainAllowlist.upsert({
      where: {
        chatId_domain: {
          chatId,
          domain: normalized,
        },
      },
      create: {
        chatId,
        domain: normalized,
      },
      update: {},
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'ADD_DOMAIN',
        payload: {
          domain: normalized,
        },
      },
    });

    return { ok: true };
  }

  async removeDomain(chatId: string, user: AuthUser, domain: string) {
    await this.assertChatAdmin(chatId, user.userId);
    const normalized = domain.toLowerCase();

    await this.prisma.domainAllowlist.delete({
      where: {
        chatId_domain: {
          chatId,
          domain: normalized,
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'REMOVE_DOMAIN',
        payload: {
          domain: normalized,
        },
      },
    });

    return { ok: true };
  }

  async assertChatAdmin(chatId: string, userId: string) {
    const admin = await this.prisma.chatAdminAllowlist.findUnique({
      where: {
        chatId_userId: {
          chatId,
          userId,
        },
      },
    });

    if (!admin) {
      throw new ForbiddenException('User is not in chat admin allowlist');
    }
  }
}
