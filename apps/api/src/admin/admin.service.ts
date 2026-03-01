import {
  addGlobalUserBlacklistRequestSchema,
  addDomainRequestSchema,
  addAdminRequestSchema,
  dateRangeQuerySchema,
  type ChatSettings,
  chatSettingsSchema,
  type DomainAllowlistEntry,
  type GlobalUserBlacklistEntry,
  type Me,
  type ModerationEvent,
  type ChatSummary,
  scheduleDomainRemovalRequestSchema,
} from '@maxim/contracts';
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MaxClientService } from '../max/max-client.service';
import { ChatContextCacheService } from '../moderation/chat-context-cache.service';
import { PrismaService } from '../prisma/prisma.service';

type ApplySettingsToAllChatsResult = {
  sourceChatId: string;
  updatedChats: number;
  appliedChatIds: string[];
};

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly chatContextCache: ChatContextCacheService,
  ) {}

  getMe(user: AuthUser): Me {
    return {
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
    };
  }

  async listChats(user: AuthUser): Promise<ChatSummary[]> {
    try {
      const remoteChats = await this.maxClient.listBotChats();
      const resolvedChats = await Promise.all(
        remoteChats.map(async (remoteChat) => {
          const hasAdminAccess = await this.hasUserAndBotAdminAccess(
            remoteChat.chatId,
            user.userId,
          );
          if (!hasAdminAccess) {
            return null;
          }

          const persistedChat = await this.upsertUserChatAccess(
            remoteChat.chatId,
            user.userId,
            remoteChat.title,
          );

          const chat: ChatSummary = {
            id: persistedChat.id,
            title: persistedChat.title,
            createdAt: persistedChat.createdAt.toISOString(),
          };

          if (this.isFallbackTitle(chat.id, chat.title)) {
            await this.refreshChatTitle(chat);
          }

          return {
            chat,
            lastEventTime: remoteChat.lastEventTime ?? 0,
          };
        }),
      );

      const filtered = resolvedChats.filter(
        (item): item is { chat: ChatSummary; lastEventTime: number } => item !== null,
      );

      if (filtered.length > 0) {
        filtered.sort((a, b) => b.lastEventTime - a.lastEventTime);
        return filtered.map((item) => item.chat);
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to auto-discover chats via MAX API',
      );
    }

    const cached = await this.listChatsFromAllowlist(user.userId);
    if (cached.length > 0) {
      return cached;
    }

    const bootstrapped = await this.bootstrapCurrentChat(user);
    return bootstrapped ? [bootstrapped] : [];
  }

  async getSettings(chatId: string, user: AuthUser): Promise<ChatSettings> {
    await this.assertChatAdmin(chatId, user.userId);

    const chat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Chat ${chatId}`,
        settings: {
          create: {},
        },
      },
      update: {
        settings: {
          upsert: {
            update: {},
            create: {},
          },
        },
      },
      include: { settings: true },
    });

    if (!chat.settings) {
      throw new Error('Chat settings missing after upsert');
    }

    const parsed = chatSettingsSchema.safeParse(chat.settings);
    if (parsed.success) {
      return parsed.data;
    }

    this.logger.warn(
      {
        chatId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      'Invalid chat settings found in DB, applying defaults',
    );

    const fallback = chatSettingsSchema.parse({});
    await this.prisma.chatSettings.update({
      where: { chatId },
      data: {
        ...fallback,
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return fallback;
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
    await this.chatContextCache.invalidate(chatId);

    return parsed.data;
  }

  async applySettingsToAllChats(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ApplySettingsToAllChatsResult> {
    await this.assertChatAdmin(sourceChatId, user.userId);
    const parsed = chatSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const availableChats = await this.listChats(user);
    const appliedChatIds = Array.from(
      new Set([sourceChatId, ...availableChats.map((chat) => chat.id)]),
    );

    for (const chatId of appliedChatIds) {
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

      await this.prisma.chatAdminAllowlist.upsert({
        where: {
          chatId_userId: {
            chatId,
            userId: user.userId,
          },
        },
        create: {
          chatId,
          userId: user.userId,
        },
        update: {},
      });

      await this.prisma.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'APPLY_SETTINGS_TO_ALL_CHATS',
          payload: {
            sourceChatId,
            targetChatId: chatId,
          },
        },
      });

      await this.chatContextCache.invalidate(chatId);
    }

    return {
      sourceChatId,
      updatedChats: appliedChatIds.length,
      appliedChatIds,
    };
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

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chatId,
      userId: row.userId,
      eventType: row.eventType,
      ruleCode: row.ruleCode,
      action: row.action,
      maskedExcerpt: row.maskedExcerpt,
      score: row.score,
      metadata:
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : null,
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
    await this.chatContextCache.invalidate(chatId);

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
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async getDomainAllowlist(chatId: string, user: AuthUser): Promise<string[]> {
    await this.assertChatAdmin(chatId, user.userId);

    const rows = await this.prisma.domainAllowlist.findMany({
      where: this.activeDomainWhere(chatId),
      orderBy: { domain: 'asc' },
      select: { domain: true },
    });

    return rows.map((row: { domain: string }) => row.domain);
  }

  async getDomainAllowlistDetails(chatId: string, user: AuthUser): Promise<DomainAllowlistEntry[]> {
    await this.assertChatAdmin(chatId, user.userId);

    const rows = await this.prisma.domainAllowlist.findMany({
      where: this.activeDomainWhere(chatId),
      orderBy: [{ removeAfterAt: 'asc' }, { domain: 'asc' }],
      select: {
        domain: true,
        removeAfterAt: true,
      },
    });

    return rows.map((row: { domain: string; removeAfterAt: Date | null }) => ({
      domain: row.domain,
      removeAfterAt: row.removeAfterAt ? row.removeAfterAt.toISOString() : null,
    }));
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
      update: {
        removeAfterAt: null,
      },
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
    await this.chatContextCache.invalidate(chatId);

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
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async scheduleDomainRemoval(chatId: string, user: AuthUser, domain: string, body: unknown) {
    await this.assertChatAdmin(chatId, user.userId);
    const normalizedDomain = domain.toLowerCase();
    const parsed = scheduleDomainRemovalRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    let removeAfterAt: Date | null = null;
    if (parsed.data.removeAfterAt) {
      const scheduledAt = new Date(parsed.data.removeAfterAt);
      if (Number.isNaN(scheduledAt.getTime())) {
        throw new BadRequestException('Invalid removal datetime');
      }

      if (scheduledAt.getTime() <= Date.now()) {
        throw new BadRequestException('Removal datetime must be in the future');
      }

      removeAfterAt = scheduledAt;
    }

    await this.prisma.domainAllowlist.update({
      where: {
        chatId_domain: {
          chatId,
          domain: normalizedDomain,
        },
      },
      data: {
        removeAfterAt,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: removeAfterAt ? 'SCHEDULE_DOMAIN_REMOVE' : 'CLEAR_DOMAIN_REMOVE_SCHEDULE',
        payload: {
          domain: normalizedDomain,
          removeAfterAt: removeAfterAt ? removeAfterAt.toISOString() : null,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async getGlobalUserBlacklist(chatId: string, user: AuthUser): Promise<GlobalUserBlacklistEntry[]> {
    await this.assertChatAdmin(chatId, user.userId);

    const rows = await this.prisma.globalUserBlacklist.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        userId: true,
        createdAt: true,
      },
    });

    return rows.map((row: { userId: string; createdAt: Date }) => ({
      userId: row.userId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async addGlobalUserBlacklistUser(chatId: string, user: AuthUser, body: unknown) {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = addGlobalUserBlacklistRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalizedUserId = parsed.data.userId.trim();

    await this.prisma.globalUserBlacklist.upsert({
      where: {
        userId: normalizedUserId,
      },
      create: {
        userId: normalizedUserId,
        sourceChatId: chatId,
        reason: 'MANUAL',
      },
      update: {
        sourceChatId: chatId,
        reason: 'MANUAL',
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'ADD_GLOBAL_USER_BLACKLIST',
        payload: {
          userId: normalizedUserId,
        },
      },
    });

    return { ok: true };
  }

  async removeGlobalUserBlacklistUser(chatId: string, user: AuthUser, targetUserId: string) {
    await this.assertChatAdmin(chatId, user.userId);
    const normalizedUserId = targetUserId.trim();

    await this.prisma.globalUserBlacklist.deleteMany({
      where: {
        userId: normalizedUserId,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'REMOVE_GLOBAL_USER_BLACKLIST',
        payload: {
          userId: normalizedUserId,
        },
      },
    });

    return { ok: true };
  }

  async assertChatAdmin(chatId: string, userId: string) {
    const hasAdminAccess = await this.hasUserAndBotAdminAccess(chatId, userId);
    if (!hasAdminAccess) {
      throw new ForbiddenException('User is not chat admin');
    }

    await this.upsertUserChatAccess(chatId, userId, null);
  }

  private activeDomainWhere(chatId: string) {
    const now = new Date();
    return {
      chatId,
      OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: now } }],
    };
  }

  private isFallbackTitle(chatId: string, title: string): boolean {
    return title.trim() === `Chat ${chatId}`;
  }

  private async hasUserAndBotAdminAccess(chatId: string, userId: string): Promise<boolean> {
    try {
      const adminIds = await this.maxClient.getChatAdminIds(chatId);
      return adminIds.includes(userId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Chat hidden: failed to validate bot/user admin access',
      );
      return false;
    }
  }

  private async refreshChatTitle(chat: ChatSummary): Promise<void> {
    try {
      const refreshedTitle = await this.maxClient.getChatTitle(chat.id);
      if (!refreshedTitle) {
        return;
      }

      chat.title = refreshedTitle;
      await this.prisma.chat.update({
        where: { id: chat.id },
        data: {
          title: refreshedTitle,
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: chat.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh chat title from MAX API',
      );
    }
  }

  private async listChatsFromAllowlist(userId: string): Promise<ChatSummary[]> {
    const rows = await this.prisma.chatAdminAllowlist.findMany({
      where: { userId },
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

  private async upsertUserChatAccess(chatId: string, userId: string, chatTitle: string | null) {
    const normalizedTitle = chatTitle?.trim() ? chatTitle.trim() : null;
    const persistedChat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: normalizedTitle ?? `Chat ${chatId}`,
      },
      update: {
        ...(normalizedTitle
          ? {
              title: normalizedTitle,
            }
          : {}),
      },
    });

    await this.prisma.chatAdminAllowlist.upsert({
      where: {
        chatId_userId: {
          chatId,
          userId,
        },
      },
      create: {
        chatId,
        userId,
      },
      update: {},
    });

    return persistedChat;
  }

  private async bootstrapCurrentChat(user: AuthUser): Promise<ChatSummary | null> {
    if (!user.chatId) {
      return null;
    }

    const hasAdminAccess = await this.hasUserAndBotAdminAccess(user.chatId, user.userId);
    if (!hasAdminAccess) {
      return null;
    }

    const persistedChat = await this.upsertUserChatAccess(
      user.chatId,
      user.userId,
      user.chatTitle ?? null,
    );

    const chat: ChatSummary = {
      id: user.chatId,
      title: persistedChat.title,
      createdAt: persistedChat.createdAt.toISOString(),
    };

    if (this.isFallbackTitle(chat.id, chat.title)) {
      await this.refreshChatTitle(chat);
    }

    return chat;
  }
}
