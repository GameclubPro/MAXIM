import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ManagedEntityHeader, ManagedEntityType } from '@maxim/contracts';
import { Prisma, type ChatSettings } from '@prisma/client';
import Redis from 'ioredis';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import type { MaxBotChat } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';

export type ChatAdminAccessState = 'granted' | 'user_denied' | 'bot_denied';

export type ChatContext = {
  chatId: string;
  title: string;
  settings: ChatSettings;
  domainAllowlist: string[];
  adminUserIds: string[];
  rulesPublishedUrl: string | null;
  rulesPublishedMessageId: string | null;
};

type ManagedEntitiesDiscoverySnapshot = MaxBotChat[];

@Injectable()
export class ChatContextCacheService implements OnModuleDestroy {
  private static readonly CHAT_CONTEXT_TTL_SEC = 60;
  private static readonly ADMIN_ACCESS_GRANTED_TTL_SEC = 5 * 60;
  private static readonly ADMIN_ACCESS_DENIED_TTL_SEC = 60;
  private static readonly DEFAULT_MANAGED_ENTITY_HEADER_TTL_SEC = 60 * 60;
  private readonly logger = new Logger(ChatContextCacheService.name);
  private readonly redis: Redis;
  private readonly managedEntityHeaderTtlSec: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    private readonly maxBotLinkService: MaxBotLinkService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.managedEntityHeaderTtlSec = this.readPositiveInt(
      (configService as { get?: (key: string) => unknown }).get?.(
        'MANAGED_ENTITY_HEADER_CACHE_SEC',
      ),
      ChatContextCacheService.DEFAULT_MANAGED_ENTITY_HEADER_TTL_SEC,
    );
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  static cacheKey(chatId: string): string {
    return `chat:context:v3:${chatId}`;
  }

  static adminAccessKey(chatId: string, userId: string): string {
    return `chat:admin-access:v2:${chatId}:${userId}`;
  }

  static managedEntityHeaderKey(chatId: string, entityType: ManagedEntityType): string {
    return `chat:managed-header:v1:${entityType}:${chatId}`;
  }

  static managedEntitiesRefreshCooldownKey(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): string {
    return `chat:managed-refresh-cooldown:v1:${entityType}:${userId}`;
  }

  static managedEntitiesRefreshBackoffKey(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): string {
    return `chat:managed-refresh-backoff:v1:${entityType}:${userId}`;
  }

  static managedEntitiesRefreshTriggerCooldownKey(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): string {
    return `chat:managed-refresh-trigger-cooldown:v1:${entityType}:${userId}`;
  }

  static managedEntitiesRefreshCursorKey(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): string {
    return `chat:managed-refresh-cursor:v1:${entityType}:${userId}`;
  }

  static managedEntitiesDiscoverySnapshotKey(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): string {
    return `chat:managed-refresh-snapshot:v1:${entityType}:${userId}`;
  }

  static managedEntitiesLastSyncedKey(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): string {
    return `chat:managed-refresh-last-synced:v1:${entityType}:${userId}`;
  }

  static managedGiveawayRunnerBackoffKey(giveawayId: string): string {
    return `managed-giveaway:runner-backoff:v1:${giveawayId}`;
  }

  static managedGiveawayRunnerFailureCountKey(giveawayId: string): string {
    return `managed-giveaway:runner-failure-count:v1:${giveawayId}`;
  }

  static managedGiveawayRunnerDeferKey(giveawayId: string): string {
    return `managed-giveaway:runner-defer:v1:${giveawayId}`;
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

  async getAdminAccess(chatId: string, userId: string): Promise<ChatAdminAccessState | null> {
    const raw = await this.redis.get(ChatContextCacheService.adminAccessKey(chatId, userId));
    if (raw === null) {
      return null;
    }

    if (raw === 'granted' || raw === 'user_denied' || raw === 'bot_denied') {
      return raw;
    }

    if (raw === '1') {
      return 'granted';
    }

    if (raw === '0') {
      return 'user_denied';
    }

    return null;
  }

  async setAdminAccess(chatId: string, userId: string, state: ChatAdminAccessState): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.adminAccessKey(chatId, userId),
      state,
      'EX',
      this.resolveAdminAccessTtlSec(state),
    );
  }

  private resolveAdminAccessTtlSec(state: ChatAdminAccessState): number {
    return state === 'granted'
      ? ChatContextCacheService.ADMIN_ACCESS_GRANTED_TTL_SEC
      : ChatContextCacheService.ADMIN_ACCESS_DENIED_TTL_SEC;
  }

  async getManagedEntityHeader(
    chatId: string,
    entityType: ManagedEntityType,
  ): Promise<ManagedEntityHeader | null> {
    const cached = await this.redis.get(
      ChatContextCacheService.managedEntityHeaderKey(chatId, entityType),
    );
    if (!cached) {
      return null;
    }

    try {
      return JSON.parse(cached) as ManagedEntityHeader;
    } catch (error: unknown) {
      this.logger.warn(
        { chatId, entityType, err: error instanceof Error ? error.message : String(error) },
        'Failed to parse managed entity header cache',
      );
      return null;
    }
  }

  async setManagedEntityHeader(header: ManagedEntityHeader): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntityHeaderKey(header.id, header.entityType),
      JSON.stringify(header),
      'EX',
      this.managedEntityHeaderTtlSec,
    );
  }

  async invalidateManagedEntityHeader(
    chatId: string,
    entityType?: ManagedEntityType,
  ): Promise<void> {
    if (entityType) {
      await this.redis.del(ChatContextCacheService.managedEntityHeaderKey(chatId, entityType));
      return;
    }

    await this.redis.del(
      ChatContextCacheService.managedEntityHeaderKey(chatId, 'chat'),
      ChatContextCacheService.managedEntityHeaderKey(chatId, 'channel'),
    );
  }

  async isManagedEntitiesRefreshCooldownActive(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<boolean> {
    const raw = await this.redis.get(
      ChatContextCacheService.managedEntitiesRefreshCooldownKey(userId, entityType),
    );
    return typeof raw === 'string' && raw.length > 0;
  }

  async activateManagedEntitiesRefreshCooldown(
    userId: string,
    entityType: ManagedEntityType | 'all',
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntitiesRefreshCooldownKey(userId, entityType),
      '1',
      'EX',
      ttlSec,
    );
  }

  async isManagedEntitiesRefreshBackoffActive(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<boolean> {
    const raw = await this.redis.get(
      ChatContextCacheService.managedEntitiesRefreshBackoffKey(userId, entityType),
    );
    return typeof raw === 'string' && raw.length > 0;
  }

  async getManagedEntitiesRefreshBackoffRemainingMs(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<number> {
    const ttlMs = await this.redis.pttl(
      ChatContextCacheService.managedEntitiesRefreshBackoffKey(userId, entityType),
    );
    return ttlMs > 0 ? ttlMs : 0;
  }

  async activateManagedEntitiesRefreshBackoff(
    userId: string,
    entityType: ManagedEntityType | 'all',
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntitiesRefreshBackoffKey(userId, entityType),
      '1',
      'EX',
      ttlSec,
    );
  }

  async getManagedEntitiesRefreshTriggerCooldownRemainingMs(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<number> {
    const ttlMs = await this.redis.pttl(
      ChatContextCacheService.managedEntitiesRefreshTriggerCooldownKey(userId, entityType),
    );
    return ttlMs > 0 ? ttlMs : 0;
  }

  async activateManagedEntitiesRefreshTriggerCooldown(
    userId: string,
    entityType: ManagedEntityType | 'all',
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntitiesRefreshTriggerCooldownKey(userId, entityType),
      '1',
      'EX',
      ttlSec,
    );
  }

  async getManagedEntitiesRefreshCursor(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<number | null> {
    const raw = await this.redis.get(
      ChatContextCacheService.managedEntitiesRefreshCursorKey(userId, entityType),
    );
    if (raw === null) {
      return null;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  async setManagedEntitiesRefreshCursor(
    userId: string,
    entityType: ManagedEntityType | 'all',
    cursor: number,
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntitiesRefreshCursorKey(userId, entityType),
      String(cursor),
      'EX',
      ttlSec,
    );
  }

  async clearManagedEntitiesRefreshCursor(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<void> {
    await this.redis.del(
      ChatContextCacheService.managedEntitiesRefreshCursorKey(userId, entityType),
    );
  }

  async getManagedEntitiesDiscoverySnapshot(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<ManagedEntitiesDiscoverySnapshot | null> {
    const raw = await this.redis.get(
      ChatContextCacheService.managedEntitiesDiscoverySnapshotKey(userId, entityType),
    );
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.isManagedEntitiesDiscoverySnapshot(parsed) ? parsed : null;
    } catch (error: unknown) {
      this.logger.warn(
        { userId, entityType, err: error instanceof Error ? error.message : String(error) },
        'Failed to parse managed entities discovery snapshot cache',
      );
      return null;
    }
  }

  async setManagedEntitiesDiscoverySnapshot(
    userId: string,
    entityType: ManagedEntityType | 'all',
    snapshot: ManagedEntitiesDiscoverySnapshot,
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntitiesDiscoverySnapshotKey(userId, entityType),
      JSON.stringify(snapshot),
      'EX',
      ttlSec,
    );
  }

  async clearManagedEntitiesDiscoverySnapshot(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<void> {
    await this.redis.del(
      ChatContextCacheService.managedEntitiesDiscoverySnapshotKey(userId, entityType),
    );
  }

  async getManagedEntitiesLastSyncedAt(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<string | null> {
    const raw = await this.redis.get(
      ChatContextCacheService.managedEntitiesLastSyncedKey(userId, entityType),
    );
    if (typeof raw !== 'string') {
      return null;
    }

    const normalized = raw.trim();
    return normalized.length > 0 ? normalized : null;
  }

  async setManagedEntitiesLastSyncedAt(
    userId: string,
    entityType: ManagedEntityType | 'all',
    isoValue: string,
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntitiesLastSyncedKey(userId, entityType),
      isoValue,
      'EX',
      ttlSec,
    );
  }

  async getManagedGiveawayRunnerBackoffRemainingMs(giveawayId: string): Promise<number> {
    const ttlMs = await this.redis.pttl(
      ChatContextCacheService.managedGiveawayRunnerBackoffKey(giveawayId),
    );
    return ttlMs > 0 ? ttlMs : 0;
  }

  async activateManagedGiveawayRunnerBackoff(giveawayId: string, ttlSec: number): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedGiveawayRunnerBackoffKey(giveawayId),
      '1',
      'EX',
      ttlSec,
    );
  }

  async getManagedGiveawayRunnerDeferRemainingMs(giveawayId: string): Promise<number> {
    const ttlMs = await this.redis.pttl(ChatContextCacheService.managedGiveawayRunnerDeferKey(giveawayId));
    return ttlMs > 0 ? ttlMs : 0;
  }

  async activateManagedGiveawayRunnerDefer(giveawayId: string, ttlSec: number): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedGiveawayRunnerDeferKey(giveawayId),
      '1',
      'EX',
      ttlSec,
    );
  }

  async incrementManagedGiveawayRunnerFailureCount(
    giveawayId: string,
    ttlSec: number,
  ): Promise<number> {
    const key = ChatContextCacheService.managedGiveawayRunnerFailureCountKey(giveawayId);
    const result = await this.redis.multi().incr(key).expire(key, ttlSec).exec();
    const count = result?.[0]?.[1];
    return typeof count === 'number' ? count : Number.parseInt(String(count ?? '1'), 10) || 1;
  }

  async clearManagedGiveawayRunnerFailureState(giveawayId: string): Promise<void> {
    await this.redis.del(
      ChatContextCacheService.managedGiveawayRunnerBackoffKey(giveawayId),
      ChatContextCacheService.managedGiveawayRunnerFailureCountKey(giveawayId),
      ChatContextCacheService.managedGiveawayRunnerDeferKey(giveawayId),
    );
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= 1) {
      return Math.trunc(numericValue);
    }

    return fallback;
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

    this.maxBotLinkService.rememberChatBotBinding?.(chat.id, chat.primaryBotId ?? chat.botId);

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
      ChatContextCacheService.CHAT_CONTEXT_TTL_SEC,
    );
    return value;
  }

  private async ensureChatInitialized(chatId: string, title: string | undefined) {
    const resolvedTitle = title || `Chat ${chatId}`;

    try {
      await this.prisma.chat.create({
        data: {
          id: chatId,
          botId: this.maxBotLinkService.getContextOrDefaultBotId(),
          primaryBotId: this.maxBotLinkService.getContextOrDefaultBotId(),
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

  private isManagedEntitiesDiscoverySnapshot(
    value: unknown,
  ): value is ManagedEntitiesDiscoverySnapshot {
    return (
      Array.isArray(value) &&
      value.every((item) => {
        if (!item || typeof item !== 'object') {
          return false;
        }

        const row = item as Record<string, unknown>;
        return (
          typeof row.chatId === 'string' &&
          (row.title === null || typeof row.title === 'string') &&
          (row.lastEventTime === null || typeof row.lastEventTime === 'number') &&
          (row.entityType === 'chat' || row.entityType === 'channel') &&
          (row.link === null || typeof row.link === 'string') &&
          (row.avatarUrl === null || typeof row.avatarUrl === 'string')
        );
      })
    );
  }
}
