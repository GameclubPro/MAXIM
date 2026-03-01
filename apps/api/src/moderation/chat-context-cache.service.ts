import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatSettings } from '@prisma/client';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';

export type ChatContext = {
  chatId: string;
  title: string;
  settings: ChatSettings;
  domainAllowlist: string[];
  adminUserIds: string[];
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
    return `chat:context:v1:${chatId}`;
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
    const chat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: title || `Chat ${chatId}`,
        settings: {
          create: {},
        },
      },
      update: {
        ...(title
          ? {
              title,
            }
          : {}),
        settings: {
          upsert: {
            update: {},
            create: {},
          },
        },
      },
      include: {
        settings: true,
        domains: {
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

    if (!chat.settings) {
      throw new Error(`Chat settings missing after upsert for chat ${chatId}`);
    }

    const value: ChatContext = {
      chatId: chat.id,
      title: chat.title,
      settings: chat.settings,
      domainAllowlist: (chat.domains ?? []).map((item) => item.domain),
      adminUserIds: (chat.admins ?? []).map((item) => item.userId),
    };

    await this.redis.set(ChatContextCacheService.cacheKey(chatId), JSON.stringify(value), 'EX', this.ttlSec);
    return value;
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
}
