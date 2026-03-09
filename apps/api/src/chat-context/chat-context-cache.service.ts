import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ChatSettings } from '@prisma/client';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';

export type ChatContext = {
  chatId: string;
  title: string;
  settings: ChatSettings;
  domainAllowlist: string[];
  adminUserIds: string[];
  rulesPublishedUrl: string | null;
  rulesPublishedMessageId: string | null;
};

@Injectable()
export class ChatContextCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(ChatContextCacheService.name);
  private readonly redis: Redis;
  private readonly ttlSec: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.ttlSec = 60;
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  static cacheKey(chatId: string): string {
    return `chat:context:v3:${chatId}`;
  }

  async getChatContext(chatId: string, chatTitle?: string | null): Promise<ChatContext> {
    const key = ChatContextCacheService.cacheKey(chatId);
    const cached = await this.redis.get(key);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as ChatContext;
        if (chatTitle && chatTitle.trim() && parsed.title !== chatTitle.trim()) {
          void this.updateTitle(chatId, chatTitle.trim());
        }
        return parsed;
      } catch (error: unknown) {
        this.logger.warn(
          { chatId, err: error instanceof Error ? error.message : String(error) },
          'Failed to parse chat context cache',
        );
      }
    }

    const fresh = await this.loadAndCache(chatId, chatTitle);
    return fresh;
  }

  async invalidate(chatId: string) {
    await this.redis.del(ChatContextCacheService.cacheKey(chatId));
  }

  private async loadAndCache(chatId: string, chatTitle?: string | null): Promise<ChatContext> {
    const title = chatTitle?.trim();
    await this.ensureChatInitialized(chatId, title);

    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        settings: true,
        rules: {
          select: {
            publishedUrl: true,
            publishedMessageId: true,
          },
        },
        domains: {
          where: {
            OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: new Date() } }],
          },
          select: {
            domain: true,
          },
        },
        admins: {
          select: {
            userId: true,
          },
        },
      },
    });

    if (!chat) {
      throw new Error(`Chat missing after initialization for chat ${chatId}`);
    }

    if (!chat.settings) {
      throw new Error(`Chat settings missing after initialization for chat ${chatId}`);
    }

    const value: ChatContext = {
      chatId: chat.id,
      title: chat.title,
      settings: chat.settings,
      domainAllowlist: (chat.domains ?? []).map((item) => item.domain),
      adminUserIds: (chat.admins ?? []).map((item) => item.userId),
      rulesPublishedUrl: chat.rules?.publishedUrl ?? null,
      rulesPublishedMessageId: chat.rules?.publishedMessageId ?? null,
    };

    await this.redis.set(
      ChatContextCacheService.cacheKey(chatId),
      JSON.stringify(value),
      'EX',
      this.ttlSec,
    );
    return value;
  }

  private async ensureChatInitialized(chatId: string, title: string | undefined) {
    const resolvedTitle = title || `Chat ${chatId}`;

    try {
      await this.prisma.chat.create({
        data: {
          id: chatId,
          title: resolvedTitle,
        },
      });
    } catch (error: unknown) {
      if (!this.isPrismaError(error, 'P2002')) {
        throw error;
      }
    }

    if (title) {
      try {
        await this.prisma.chat.update({
          where: { id: chatId },
          data: { title },
        });
      } catch (error: unknown) {
        if (!this.isPrismaError(error, 'P2025')) {
          throw error;
        }
      }
    }

    await this.prisma.chatSettings.createMany({
      data: [{ chatId }],
      skipDuplicates: true,
    });
  }

  private async updateTitle(chatId: string, title: string) {
    try {
      await this.prisma.chat.update({
        where: { id: chatId },
        data: { title },
      });
      await this.invalidate(chatId);
    } catch (error: unknown) {
      this.logger.warn(
        { chatId, err: error instanceof Error ? error.message : String(error) },
        'Failed to refresh chat title from cache hit',
      );
    }
  }

  private isPrismaError(error: unknown, code: string): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return error.code === code;
    }

    return (error as { code?: string } | null)?.code === code;
  }
}
