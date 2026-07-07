import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatSummary, ManagedEntityHeader, ManagedEntityType } from '@maxim/contracts';
import type { ChatSettings } from '../prisma/prisma-client';
import Redis from 'ioredis';
import {
  MaxBotLinkService,
  type MaxBotRoute,
  type MaxBotRouteRequest,
} from '../max/max-bot-link.service';
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
type ManagedEntitiesRecentBootstrapEntry = ChatSummary & {
  bootstrapUserIds?: string[];
};
type ManagedEntitiesRecentBootstrapSnapshot = ManagedEntitiesRecentBootstrapEntry[];
export type ManagedEntitiesPublishedSnapshot = {
  version: string;
  builtAt: string;
  lastSyncedAt: string | null;
  itemCount: number;
  itemsHash: string;
  items: ChatSummary[];
};
export type ManagedEntitiesPublishedDiff = {
  baseVersion: string;
  nextVersion: string;
  added: ChatSummary[];
  updated: ChatSummary[];
  removedIds: string[];
  orderedIds: string[];
  changeCount: number;
};
type ManagedEntityBotProfileSnapshot = {
  avatarUrl: string | null;
};
type LocalChatContextCacheEntry = {
  value: ChatContext;
  expiresAtMs: number;
};

const CHAT_CONTEXT_INVALIDATION_CHANNEL = 'chat:context:invalidate:v1';

@Injectable()
export class ChatContextCacheService implements OnModuleInit, OnModuleDestroy {
  private static readonly CHAT_CONTEXT_TTL_SEC = 60;
  private static readonly LOCAL_CHAT_CONTEXT_TTL_MS = 30_000;
  private static readonly CHAT_CONTEXT_REDIS_READ_TIMEOUT_MS = 150;
  private static readonly CHAT_CONTEXT_REDIS_WRITE_TIMEOUT_MS = 150;
  private static readonly MANAGED_ENTITY_HEADER_REDIS_READ_TIMEOUT_MS = 100;
  private static readonly MANAGED_ENTITY_BOT_PROFILE_REDIS_READ_TIMEOUT_MS = 100;
  private static readonly ADMIN_ACCESS_GRANTED_TTL_SEC = 15 * 60;
  private static readonly ADMIN_ACCESS_DENIED_TTL_SEC = 60;
  private static readonly ADMIN_ACCESS_REDIS_READ_TIMEOUT_MS = 100;
  private static readonly DEFAULT_MANAGED_ENTITY_HEADER_TTL_SEC = 60 * 60;
  private static readonly DEFAULT_MANAGED_ENTITY_BOT_PROFILE_TTL_SEC = 6 * 60 * 60;
  private static readonly MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_ITEMS = 500;
  private static readonly MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_USER_ITEMS = 100;
  private static readonly MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_USER_IDS = 64;
  private readonly logger = new Logger(ChatContextCacheService.name);
  private readonly redis: Redis;
  private readonly subscriber: Redis;
  private readonly localChatContextTtlMs: number;
  private readonly managedEntityHeaderTtlSec: number;
  private readonly managedEntityBotProfileTtlSec: number;
  private readonly localChatContextCache = new Map<string, LocalChatContextCacheEntry>();
  private readonly chatContextInFlightLoads = new Map<string, Promise<ChatContext>>();
  private readonly localChatContextEpochs = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    private readonly maxBotLinkService: MaxBotLinkService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.subscriber = this.redis.duplicate({ enableReadyCheck: false });
    this.localChatContextTtlMs = this.readPositiveInt(
      (configService as { get?: (key: string) => unknown }).get?.(
        'CHAT_CONTEXT_LOCAL_CACHE_TTL_MS',
      ),
      ChatContextCacheService.LOCAL_CHAT_CONTEXT_TTL_MS,
    );
    this.managedEntityHeaderTtlSec = this.readPositiveInt(
      (configService as { get?: (key: string) => unknown }).get?.(
        'MANAGED_ENTITY_HEADER_CACHE_SEC',
      ),
      ChatContextCacheService.DEFAULT_MANAGED_ENTITY_HEADER_TTL_SEC,
    );
    this.managedEntityBotProfileTtlSec = this.readPositiveInt(
      (configService as { get?: (key: string) => unknown }).get?.(
        'MANAGED_ENTITY_BOT_PROFILE_CACHE_SEC',
      ),
      ChatContextCacheService.DEFAULT_MANAGED_ENTITY_BOT_PROFILE_TTL_SEC,
    );
  }

  async onModuleInit(): Promise<void> {
    this.subscriber.on('message', (channel, payload) => {
      if (channel !== CHAT_CONTEXT_INVALIDATION_CHANNEL) {
        return;
      }

      const chatId = this.parseInvalidationPayload(payload);
      if (!chatId) {
        return;
      }

      this.applyLocalInvalidation(chatId);
    });
    await this.subscriber.subscribe(CHAT_CONTEXT_INVALIDATION_CHANNEL);
  }

  async onModuleDestroy() {
    await this.subscriber.quit();
    await this.redis.quit();
  }

  static cacheKey(chatId: string): string {
    return `chat:context:v3:${chatId}`;
  }

  static adminAccessKey(chatId: string, userId: string): string {
    return `chat:admin-access:v2:${chatId}:${userId}`;
  }

  static adminLookupBackoffKey(chatId: string): string {
    return `chat:admin-lookup-backoff:v1:${chatId}`;
  }

  static managedEntityHeaderKey(chatId: string, entityType: ManagedEntityType): string {
    return `chat:managed-header:v1:${entityType}:${chatId}`;
  }

  static managedEntityBotProfileKey(botId: string): string {
    return `chat:managed-bot-profile:v1:${botId}`;
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

  static managedRefreshSourceBackoffKey(): string {
    return 'maxapi:managed-refresh-source-backoff:v1';
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

  static managedEntitiesPublishedSnapshotKey(
    userId: string,
    entityType: ManagedEntityType,
  ): string {
    return `chat:managed-view-snapshot:v1:${entityType}:${userId}`;
  }

  static managedEntitiesPublishedDiffKey(
    userId: string,
    entityType: ManagedEntityType,
    baseVersion: string,
  ): string {
    return `chat:managed-view-diff:v1:${entityType}:${userId}:${baseVersion}`;
  }

  static managedEntitiesRecentBootstrapKey(entityType: ManagedEntityType): string {
    return `chat:managed-recent-bootstrap:v1:${entityType}`;
  }

  static managedEntitiesRecentBootstrapUserKey(
    entityType: ManagedEntityType,
    userId: string,
  ): string {
    return `chat:managed-recent-bootstrap-user:v1:${entityType}:${userId}`;
  }

  static managedEntitiesRecentBootstrapChatIndexKey(
    chatId: string,
    entityType: ManagedEntityType,
  ): string {
    return `chat:managed-recent-bootstrap-index:v1:${entityType}:${chatId}`;
  }

  static managedEntitiesRecentBootstrapChatUsersKey(
    chatId: string,
    entityType: ManagedEntityType,
  ): string {
    return `chat:managed-recent-bootstrap-users:v1:${entityType}:${chatId}`;
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
    const normalizedTitle = chatTitle?.trim() || null;
    const localCached = this.readLocalChatContext(chatId);
    if (localCached) {
      return this.reconcileCachedChatTitle(chatId, localCached, normalizedTitle);
    }

    const expectedEpoch = this.readChatContextEpoch(chatId);

    const existingLoad = this.chatContextInFlightLoads.get(chatId);
    if (existingLoad) {
      const resolved = await existingLoad;
      if (this.readChatContextEpoch(chatId) !== expectedEpoch) {
        return this.getChatContext(chatId, normalizedTitle);
      }
      return this.reconcileCachedChatTitle(chatId, resolved, normalizedTitle);
    }

    const loadPromise = this.loadCachedOrSource(chatId, normalizedTitle, expectedEpoch).finally(
      () => {
        if (this.chatContextInFlightLoads.get(chatId) === loadPromise) {
          this.chatContextInFlightLoads.delete(chatId);
        }
      },
    );
    this.chatContextInFlightLoads.set(chatId, loadPromise);
    const resolved = await loadPromise;
    if (this.readChatContextEpoch(chatId) !== expectedEpoch) {
      return this.getChatContext(chatId, normalizedTitle);
    }
    return this.reconcileCachedChatTitle(chatId, resolved, normalizedTitle);
  }

  async invalidate(chatId: string) {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }

    this.applyLocalInvalidation(normalizedChatId);
    await Promise.all([
      this.redis.del(ChatContextCacheService.cacheKey(normalizedChatId)),
      this.redis.publish(
        CHAT_CONTEXT_INVALIDATION_CHANNEL,
        JSON.stringify({
          chatId: normalizedChatId,
        }),
      ),
    ]);
  }

  async getAdminAccess(chatId: string, userId: string): Promise<ChatAdminAccessState | null> {
    const raw = await this.readRedisStringWithin(
      ChatContextCacheService.adminAccessKey(chatId, userId),
      ChatContextCacheService.ADMIN_ACCESS_REDIS_READ_TIMEOUT_MS,
    );
    return this.parseAdminAccessState(raw);
  }

  async getAdminAccessBatch(
    chatId: string,
    userIds: readonly string[],
  ): Promise<Map<string, ChatAdminAccessState | null>> {
    const normalizedChatId = chatId.trim();
    const normalizedUserIds = Array.from(
      new Set(userIds.map((userId) => userId.trim()).filter((value) => value.length > 0)),
    );
    const results = new Map<string, ChatAdminAccessState | null>();
    if (!normalizedChatId || normalizedUserIds.length === 0) {
      return results;
    }

    const rawStates = await this.readRedisStringsWithin(
      normalizedUserIds.map((userId) =>
        ChatContextCacheService.adminAccessKey(normalizedChatId, userId),
      ),
      ChatContextCacheService.ADMIN_ACCESS_REDIS_READ_TIMEOUT_MS,
    );
    if (!rawStates) {
      for (const normalizedUserId of normalizedUserIds) {
        results.set(normalizedUserId, null);
      }
      return results;
    }

    normalizedUserIds.forEach((normalizedUserId, index) => {
      results.set(normalizedUserId, this.parseAdminAccessState(rawStates[index] ?? null));
    });
    return results;
  }

  async setAdminAccess(chatId: string, userId: string, state: ChatAdminAccessState): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.adminAccessKey(chatId, userId),
      state,
      'EX',
      this.resolveAdminAccessTtlSec(state),
    );
  }

  async getAdminLookupBackoffRemainingMs(chatId: string): Promise<number> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return 0;
    }

    const ttlMs = await this.runRedisReadWithin(
      this.redis
        .pttl(ChatContextCacheService.adminLookupBackoffKey(normalizedChatId))
        .catch(() => 0),
      ChatContextCacheService.ADMIN_ACCESS_REDIS_READ_TIMEOUT_MS,
    );
    return typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : 0;
  }

  async activateAdminLookupBackoff(chatId: string, ttlSec: number): Promise<void> {
    const normalizedChatId = chatId.trim();
    const normalizedTtlSec = Math.max(1, Math.ceil(ttlSec));
    if (!normalizedChatId) {
      return;
    }

    await this.redis.set(
      ChatContextCacheService.adminLookupBackoffKey(normalizedChatId),
      '1',
      'EX',
      normalizedTtlSec,
    );
  }

  async rememberChatAdminUser(chatId: string, userId: string): Promise<void> {
    const normalizedChatId = chatId.trim();
    const normalizedUserId = userId.trim();
    if (!normalizedChatId || !normalizedUserId) {
      return;
    }

    const localCached = this.readLocalChatContext(normalizedChatId);
    if (localCached) {
      const nextValue = this.appendChatAdminUser(localCached, normalizedUserId);
      if (nextValue !== localCached) {
        this.writeLocalChatContext(normalizedChatId, nextValue);
        this.writeChatContextToRedis(normalizedChatId, nextValue);
      }
      return;
    }

    const cached = await this.readRedisStringWithin(
      ChatContextCacheService.cacheKey(normalizedChatId),
      ChatContextCacheService.CHAT_CONTEXT_REDIS_READ_TIMEOUT_MS,
    );
    if (!cached) {
      return;
    }

    try {
      const parsed = JSON.parse(cached) as ChatContext;
      const nextValue = this.appendChatAdminUser(parsed, normalizedUserId);
      if (nextValue !== parsed) {
        this.writeLocalChatContext(normalizedChatId, nextValue);
        this.writeChatContextToRedis(normalizedChatId, nextValue);
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: normalizedChatId,
          userId: normalizedUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to patch chat admin user into cached chat context',
      );
    }
  }

  async replaceChatAdminUsers(chatId: string, userIds: readonly string[]): Promise<void> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }

    const normalizedUserIds = Array.from(
      new Set(
        userIds
          .map((userId) => (typeof userId === 'string' ? userId.trim() : ''))
          .filter((userId): userId is string => userId.length > 0),
      ),
    );

    const patchContext = (value: ChatContext): ChatContext => {
      const currentIds = value.adminUserIds ?? [];
      if (
        currentIds.length === normalizedUserIds.length &&
        currentIds.every((userId, index) => userId === normalizedUserIds[index])
      ) {
        return value;
      }

      return {
        ...value,
        adminUserIds: normalizedUserIds,
      };
    };

    const localCached = this.readLocalChatContext(normalizedChatId);
    if (localCached) {
      const nextValue = patchContext(localCached);
      if (nextValue !== localCached) {
        this.writeLocalChatContext(normalizedChatId, nextValue);
        this.writeChatContextToRedis(normalizedChatId, nextValue);
      }
      return;
    }

    const cached = await this.readRedisStringWithin(
      ChatContextCacheService.cacheKey(normalizedChatId),
      ChatContextCacheService.CHAT_CONTEXT_REDIS_READ_TIMEOUT_MS,
    );
    if (!cached) {
      return;
    }

    try {
      const parsed = JSON.parse(cached) as ChatContext;
      const nextValue = patchContext(parsed);
      if (nextValue !== parsed) {
        this.writeLocalChatContext(normalizedChatId, nextValue);
        this.writeChatContextToRedis(normalizedChatId, nextValue);
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: normalizedChatId,
          adminUserIds: normalizedUserIds,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to replace chat admin users in cached chat context',
      );
    }
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
    const cached = await this.readRedisStringWithin(
      ChatContextCacheService.managedEntityHeaderKey(chatId, entityType),
      ChatContextCacheService.MANAGED_ENTITY_HEADER_REDIS_READ_TIMEOUT_MS,
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

  async getManagedEntityBotProfile(botId: string): Promise<ManagedEntityBotProfileSnapshot | null> {
    const normalizedBotId = botId.trim();
    if (!normalizedBotId) {
      return null;
    }

    const cached = await this.readRedisStringWithin(
      ChatContextCacheService.managedEntityBotProfileKey(normalizedBotId),
      ChatContextCacheService.MANAGED_ENTITY_BOT_PROFILE_REDIS_READ_TIMEOUT_MS,
    );
    if (!cached) {
      return null;
    }

    try {
      const parsed = JSON.parse(cached) as ManagedEntityBotProfileSnapshot;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        !(parsed.avatarUrl === null || typeof parsed.avatarUrl === 'string')
      ) {
        return null;
      }

      return {
        avatarUrl:
          typeof parsed.avatarUrl === 'string' && parsed.avatarUrl.trim().length > 0
            ? parsed.avatarUrl.trim()
            : null,
      };
    } catch (error: unknown) {
      this.logger.warn(
        { botId: normalizedBotId, err: error instanceof Error ? error.message : String(error) },
        'Failed to parse managed entity bot profile cache',
      );
      return null;
    }
  }

  async setManagedEntityBotProfile(
    botId: string,
    profile: ManagedEntityBotProfileSnapshot,
  ): Promise<void> {
    const normalizedBotId = botId.trim();
    if (!normalizedBotId) {
      return;
    }

    await this.redis.set(
      ChatContextCacheService.managedEntityBotProfileKey(normalizedBotId),
      JSON.stringify({
        avatarUrl:
          typeof profile.avatarUrl === 'string' && profile.avatarUrl.trim().length > 0
            ? profile.avatarUrl.trim()
            : null,
      }),
      'EX',
      this.managedEntityBotProfileTtlSec,
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

  async isManagedRefreshSourceBackoffActive(): Promise<boolean> {
    const raw = await this.redis.get(ChatContextCacheService.managedRefreshSourceBackoffKey());
    return typeof raw === 'string' && raw.length > 0;
  }

  async getManagedRefreshSourceBackoffRemainingMs(): Promise<number> {
    const ttlMs = await this.redis.pttl(ChatContextCacheService.managedRefreshSourceBackoffKey());
    return ttlMs > 0 ? ttlMs : 0;
  }

  async activateManagedRefreshSourceBackoff(ttlSec: number): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedRefreshSourceBackoffKey(),
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

  async getManagedEntitiesPublishedSnapshot(
    userId: string,
    entityType: ManagedEntityType,
  ): Promise<ManagedEntitiesPublishedSnapshot | null> {
    const raw = await this.redis.get(
      ChatContextCacheService.managedEntitiesPublishedSnapshotKey(userId, entityType),
    );
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.isManagedEntitiesPublishedSnapshot(parsed) ? parsed : null;
    } catch (error: unknown) {
      this.logger.warn(
        { userId, entityType, err: error instanceof Error ? error.message : String(error) },
        'Failed to parse managed entities published snapshot cache',
      );
      return null;
    }
  }

  async setManagedEntitiesPublishedSnapshot(
    userId: string,
    entityType: ManagedEntityType,
    snapshot: ManagedEntitiesPublishedSnapshot,
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntitiesPublishedSnapshotKey(userId, entityType),
      JSON.stringify(snapshot),
      'EX',
      ttlSec,
    );
  }

  async clearManagedEntitiesPublishedSnapshot(
    userId: string,
    entityType: ManagedEntityType,
  ): Promise<void> {
    await this.redis.del(
      ChatContextCacheService.managedEntitiesPublishedSnapshotKey(userId, entityType),
    );
  }

  async getManagedEntitiesPublishedDiff(
    userId: string,
    entityType: ManagedEntityType,
    baseVersion: string,
  ): Promise<ManagedEntitiesPublishedDiff | null> {
    const raw = await this.redis.get(
      ChatContextCacheService.managedEntitiesPublishedDiffKey(userId, entityType, baseVersion),
    );
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.isManagedEntitiesPublishedDiff(parsed) ? parsed : null;
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId,
          entityType,
          baseVersion,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to parse managed entities published diff cache',
      );
      return null;
    }
  }

  async setManagedEntitiesPublishedDiff(
    userId: string,
    entityType: ManagedEntityType,
    baseVersion: string,
    diff: ManagedEntitiesPublishedDiff,
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntitiesPublishedDiffKey(userId, entityType, baseVersion),
      JSON.stringify(diff),
      'EX',
      ttlSec,
    );
  }

  async getManagedEntitiesRecentBootstrap(
    entityType: ManagedEntityType,
    userId?: string | null,
  ): Promise<ManagedEntitiesRecentBootstrapSnapshot> {
    const global = await this.getManagedEntitiesRecentBootstrapFromKey(
      ChatContextCacheService.managedEntitiesRecentBootstrapKey(entityType),
      { entityType },
    );
    const normalizedUserId =
      typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
    if (!normalizedUserId) {
      return global;
    }

    const userScoped = (
      await this.getManagedEntitiesRecentBootstrapFromKey(
        ChatContextCacheService.managedEntitiesRecentBootstrapUserKey(entityType, normalizedUserId),
        { entityType, userId: normalizedUserId },
      )
    ).map((entry) => this.ensureRecentBootstrapEntryUser(entry, normalizedUserId));

    return this.mergeManagedEntitiesRecentBootstrapEntries(userScoped, global);
  }

  private async getManagedEntitiesRecentBootstrapFromKey(
    key: string,
    logData: {
      entityType: ManagedEntityType;
      userId?: string | null;
    },
  ): Promise<ManagedEntitiesRecentBootstrapSnapshot> {
    const raw = await this.redis.get(key);
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.isManagedEntitiesRecentBootstrapSnapshot(parsed) ? parsed : [];
    } catch (error: unknown) {
      this.logger.warn(
        { ...logData, err: error instanceof Error ? error.message : String(error) },
        'Failed to parse managed entities recent bootstrap cache',
      );
      return [];
    }
  }

  private mergeManagedEntitiesRecentBootstrapEntries(
    ...groups: ManagedEntitiesRecentBootstrapSnapshot[]
  ): ManagedEntitiesRecentBootstrapSnapshot {
    const merged = new Map<string, ManagedEntitiesRecentBootstrapEntry>();
    for (const group of groups) {
      for (const entry of group) {
        const chatId = entry.id.trim();
        if (!chatId || merged.has(chatId)) {
          continue;
        }
        merged.set(chatId, entry);
      }
    }
    return [...merged.values()];
  }

  private ensureRecentBootstrapEntryUser(
    entry: ManagedEntitiesRecentBootstrapEntry,
    userId: string,
  ): ManagedEntitiesRecentBootstrapEntry {
    const bootstrapUserIds = Array.from(
      new Set([
        userId,
        ...(entry.bootstrapUserIds ?? [])
          .map((value) =>
            typeof value === 'string' && value.trim().length > 0 ? value.trim() : null,
          )
          .filter((value): value is string => Boolean(value)),
      ]),
    ).slice(0, ChatContextCacheService.MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_USER_IDS);

    return {
      ...entry,
      bootstrapUserIds,
    };
  }

  async upsertManagedEntitiesRecentBootstrap(
    item: ChatSummary,
    ttlSec: number,
    userId?: string | null,
  ): Promise<void> {
    const normalizedChatId = item.id.trim();
    if (!normalizedChatId) {
      return;
    }

    const entityType = item.entityType;
    const current = await this.getManagedEntitiesRecentBootstrapFromKey(
      ChatContextCacheService.managedEntitiesRecentBootstrapKey(entityType),
      { entityType },
    );
    const existing = current.find((entry) => entry.id.trim() === normalizedChatId) ?? null;
    const normalizedUserId =
      typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
    const mergedBootstrapUserIds = Array.from(
      new Set([
        ...(normalizedUserId ? [normalizedUserId] : []),
        ...(existing?.bootstrapUserIds ?? [])
          .map((value) =>
            typeof value === 'string' && value.trim().length > 0 ? value.trim() : null,
          )
          .filter((value): value is string => Boolean(value)),
      ]),
    ).slice(0, ChatContextCacheService.MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_USER_IDS);
    const nextEntry: ManagedEntitiesRecentBootstrapEntry = {
      ...item,
      ...(mergedBootstrapUserIds.length > 0 ? { bootstrapUserIds: mergedBootstrapUserIds } : {}),
    };
    const next = [
      nextEntry,
      ...current.filter((entry) => entry.id.trim() !== normalizedChatId),
    ].slice(0, ChatContextCacheService.MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_ITEMS);

    const indexKey = ChatContextCacheService.managedEntitiesRecentBootstrapChatIndexKey(
      normalizedChatId,
      entityType,
    );
    const chatUsersKey = ChatContextCacheService.managedEntitiesRecentBootstrapChatUsersKey(
      normalizedChatId,
      entityType,
    );
    const pipeline = this.redis
      .multi()
      .set(
        ChatContextCacheService.managedEntitiesRecentBootstrapKey(entityType),
        JSON.stringify(next),
        'EX',
        ttlSec,
      )
      .set(indexKey, '1', 'EX', ttlSec);

    if (normalizedUserId) {
      const userKey = ChatContextCacheService.managedEntitiesRecentBootstrapUserKey(
        entityType,
        normalizedUserId,
      );
      const currentUserScoped = await this.getManagedEntitiesRecentBootstrapFromKey(userKey, {
        entityType,
        userId: normalizedUserId,
      });
      const nextUserEntry = this.ensureRecentBootstrapEntryUser(nextEntry, normalizedUserId);
      const nextUserScoped = [
        nextUserEntry,
        ...currentUserScoped.filter((entry) => entry.id.trim() !== normalizedChatId),
      ].slice(0, ChatContextCacheService.MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_USER_ITEMS);
      pipeline
        .set(userKey, JSON.stringify(nextUserScoped), 'EX', ttlSec)
        .sadd(chatUsersKey, normalizedUserId)
        .expire(chatUsersKey, ttlSec);
    }

    await pipeline.exec();
  }

  async removeManagedEntitiesRecentBootstrap(
    entityType: ManagedEntityType,
    chatId: string,
    userId?: string | null,
  ): Promise<void> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }

    const normalizedUserId =
      typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
    const key = normalizedUserId
      ? ChatContextCacheService.managedEntitiesRecentBootstrapUserKey(entityType, normalizedUserId)
      : ChatContextCacheService.managedEntitiesRecentBootstrapKey(entityType);
    const current = await this.getManagedEntitiesRecentBootstrapFromKey(key, {
      entityType,
      userId: normalizedUserId,
    });
    if (current.length === 0 || current.every((entry) => entry.id.trim() !== normalizedChatId)) {
      return;
    }

    const next = current.filter((entry) => entry.id.trim() !== normalizedChatId);
    const indexKey = ChatContextCacheService.managedEntitiesRecentBootstrapChatIndexKey(
      normalizedChatId,
      entityType,
    );

    const pipeline = this.redis.multi();
    if (!normalizedUserId) {
      pipeline.del(indexKey);
    }
    if (next.length > 0) {
      const ttlSec = await this.redis.ttl(key);
      pipeline.set(key, JSON.stringify(next), 'EX', ttlSec > 0 ? ttlSec : 1);
    } else {
      pipeline.del(key);
    }
    await pipeline.exec();
  }

  async clearManagedEntitiesRecentBootstrapForChat(
    chatId: string,
    entityType: ManagedEntityType | null,
  ): Promise<void> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }

    const entityTypes: ManagedEntityType[] =
      entityType === 'chat' || entityType === 'channel' ? [entityType] : ['chat', 'channel'];

    for (const currentEntityType of entityTypes) {
      const indexKey = ChatContextCacheService.managedEntitiesRecentBootstrapChatIndexKey(
        normalizedChatId,
        currentEntityType,
      );
      const exists = await this.redis.exists(indexKey);
      if (exists === 0) {
        continue;
      }

      const chatUsersKey = ChatContextCacheService.managedEntitiesRecentBootstrapChatUsersKey(
        normalizedChatId,
        currentEntityType,
      );
      const userIds = await this.redis.smembers(chatUsersKey);
      await Promise.all([
        this.removeManagedEntitiesRecentBootstrap(currentEntityType, normalizedChatId),
        ...userIds
          .map((userId) =>
            typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null,
          )
          .filter((userId): userId is string => Boolean(userId))
          .map((userId) =>
            this.removeManagedEntitiesRecentBootstrap(currentEntityType, normalizedChatId, userId),
          ),
      ]);
      await this.redis.del(chatUsersKey);
    }
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
    const ttlMs = await this.redis.pttl(
      ChatContextCacheService.managedGiveawayRunnerDeferKey(giveawayId),
    );
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

  async clearManagedGiveawayRunnerRetryCounters(giveawayId: string): Promise<void> {
    await this.redis.del(
      ChatContextCacheService.managedGiveawayRunnerBackoffKey(giveawayId),
      ChatContextCacheService.managedGiveawayRunnerFailureCountKey(giveawayId),
    );
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

  private async loadAndCache(
    chatId: string,
    chatTitle?: string | null,
    expectedEpoch?: number,
  ): Promise<ChatContext> {
    const title = chatTitle?.trim();
    let chat = await this.findChatContextRow(chatId);
    if (!chat?.settings) {
      chat = await this.initializeChatContextRow(chatId, title);
    }

    if (!chat) {
      throw new Error(`Chat context missing for chat ${chatId}`);
    }

    if (!chat.settings) {
      throw new Error(`Chat settings missing after initialization for chat ${chatId}`);
    }

    this.maxBotLinkService.rememberChatBotBinding?.(chat.id, chat.primaryBotId ?? chat.botId);
    const resolvedTitle = title || chat.title;
    if (title && chat.title !== title) {
      void this.persistTitle(chatId, title);
    }

    const value: ChatContext = {
      chatId: chat.id,
      title: resolvedTitle,
      settings: chat.settings,
      domainAllowlist: (chat.domains ?? []).map((item) => item.domain),
      adminUserIds: (chat.admins ?? []).map((item) => item.userId),
      rulesPublishedUrl: chat.rules?.publishedUrl ?? null,
      rulesPublishedMessageId: chat.rules?.publishedMessageId ?? null,
    };

    if (expectedEpoch === undefined || this.readChatContextEpoch(chatId) === expectedEpoch) {
      this.writeLocalChatContext(chatId, value);
      this.writeChatContextToRedis(chatId, value);
    }
    return value;
  }

  private async loadCachedOrSource(
    chatId: string,
    normalizedTitle: string | null,
    expectedEpoch: number,
  ): Promise<ChatContext> {
    const key = ChatContextCacheService.cacheKey(chatId);
    const cached = await this.readRedisStringWithin(
      key,
      ChatContextCacheService.CHAT_CONTEXT_REDIS_READ_TIMEOUT_MS,
    );
    if (cached && this.readChatContextEpoch(chatId) === expectedEpoch) {
      try {
        const parsed = JSON.parse(cached) as ChatContext;
        return this.reconcileCachedChatTitle(chatId, parsed, normalizedTitle);
      } catch (error: unknown) {
        this.logger.warn(
          { chatId, err: error instanceof Error ? error.message : String(error) },
          'Failed to parse chat context cache',
        );
      }
    }

    return this.loadAndCache(chatId, normalizedTitle, expectedEpoch);
  }

  private async findChatContextRow(chatId: string) {
    return this.prisma.chat.findUnique({
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
  }

  private async initializeChatContextRow(chatId: string, title?: string | null) {
    const routeResolver = this.maxBotLinkService as unknown as {
      resolveBotRoute?: (request: MaxBotRouteRequest) => Promise<MaxBotRoute>;
    };
    const resolvedRoute =
      typeof routeResolver.resolveBotRoute === 'function'
        ? await routeResolver.resolveBotRoute({
            purpose: 'default',
            chatId,
          })
        : null;
    const resolvedBotId =
      resolvedRoute?.botId ??
      (typeof this.maxBotLinkService.resolveBotId === 'function'
        ? await this.maxBotLinkService.resolveBotId({ chatId })
        : null) ??
      this.maxBotLinkService.getContextOrDefaultBotId();
    return this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        botId: resolvedBotId,
        primaryBotId: resolvedBotId,
        title: title || `Chat ${chatId}`,
        settings: {
          create: {},
        },
      },
      update: {
        ...(title ? { title } : {}),
        settings: {
          upsert: {
            create: {},
            update: {},
          },
        },
      },
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
  }

  private async persistTitle(chatId: string, title: string) {
    try {
      await this.prisma.chat.updateMany({
        where: {
          id: chatId,
          title: {
            not: title,
          },
        },
        data: { title },
      });
    } catch (error: unknown) {
      this.logger.warn(
        { chatId, err: error instanceof Error ? error.message : String(error) },
        'Failed to persist chat title from cache hit',
      );
    }
  }

  private reconcileCachedChatTitle(
    chatId: string,
    value: ChatContext,
    normalizedTitle: string | null,
  ): ChatContext {
    if (!normalizedTitle || value.title === normalizedTitle) {
      this.writeLocalChatContext(chatId, value);
      return value;
    }

    const nextValue: ChatContext = {
      ...value,
      title: normalizedTitle,
    };
    this.writeLocalChatContext(chatId, nextValue);
    this.writeChatContextToRedis(chatId, nextValue);
    void this.persistTitle(chatId, normalizedTitle);
    return nextValue;
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

  private isManagedEntitiesRecentBootstrapSnapshot(
    value: unknown,
  ): value is ManagedEntitiesRecentBootstrapSnapshot {
    return (
      Array.isArray(value) &&
      value.every((item) => this.isManagedEntitiesRecentBootstrapEntry(item))
    );
  }

  private isManagedEntitiesRecentBootstrapEntry(
    value: unknown,
  ): value is ManagedEntitiesRecentBootstrapEntry {
    if (!this.isChatSummary(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    return (
      record.bootstrapUserIds === undefined ||
      (Array.isArray(record.bootstrapUserIds) &&
        record.bootstrapUserIds.every((userId) => typeof userId === 'string'))
    );
  }

  private isManagedEntitiesPublishedSnapshot(
    value: unknown,
  ): value is ManagedEntitiesPublishedSnapshot {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    if (
      typeof record.version !== 'string' ||
      typeof record.builtAt !== 'string' ||
      (record.lastSyncedAt !== null && typeof record.lastSyncedAt !== 'string') ||
      typeof record.itemCount !== 'number' ||
      !Number.isInteger(record.itemCount) ||
      record.itemCount < 0 ||
      typeof record.itemsHash !== 'string' ||
      !Array.isArray(record.items)
    ) {
      return false;
    }

    return record.items.every((item) => this.isChatSummary(item));
  }

  private isManagedEntitiesPublishedDiff(value: unknown): value is ManagedEntitiesPublishedDiff {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    if (
      typeof record.baseVersion !== 'string' ||
      typeof record.nextVersion !== 'string' ||
      !Array.isArray(record.added) ||
      !Array.isArray(record.updated) ||
      !Array.isArray(record.removedIds) ||
      !Array.isArray(record.orderedIds) ||
      typeof record.changeCount !== 'number' ||
      !Number.isInteger(record.changeCount) ||
      record.changeCount < 0
    ) {
      return false;
    }

    return (
      record.added.every((item) => this.isChatSummary(item)) &&
      record.updated.every((item) => this.isChatSummary(item)) &&
      record.removedIds.every((item) => typeof item === 'string' && item.trim().length > 0) &&
      record.orderedIds.every((item) => typeof item === 'string' && item.trim().length > 0)
    );
  }

  private isChatSummary(value: unknown): value is ChatSummary {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      typeof record.title !== 'string' ||
      typeof record.createdAt !== 'string' ||
      (record.entityType !== undefined &&
        record.entityType !== 'chat' &&
        record.entityType !== 'channel') ||
      (record.link !== undefined && record.link !== null && typeof record.link !== 'string') ||
      (record.avatarUrl !== undefined &&
        record.avatarUrl !== null &&
        typeof record.avatarUrl !== 'string') ||
      (record.primaryBotId !== undefined &&
        record.primaryBotId !== null &&
        typeof record.primaryBotId !== 'string') ||
      (record.sharedMode !== undefined &&
        record.sharedMode !== 'owned' &&
        record.sharedMode !== 'shared-standby' &&
        record.sharedMode !== 'shared-assist' &&
        record.sharedMode !== 'shared-failover')
    ) {
      return false;
    }

    if (
      record.channelOverview !== undefined &&
      record.channelOverview !== null &&
      !this.isChannelOverview(record.channelOverview)
    ) {
      return false;
    }

    if (
      record.assignedBots !== undefined &&
      (!Array.isArray(record.assignedBots) ||
        !record.assignedBots.every((item) => this.isManagedEntityAssignedBot(item)))
    ) {
      return false;
    }

    return true;
  }

  private isChannelOverview(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    return (
      typeof record.enabledScenariosCount === 'number' &&
      Number.isInteger(record.enabledScenariosCount) &&
      record.enabledScenariosCount >= 0 &&
      typeof record.commentsEnabled === 'boolean' &&
      typeof record.postSuggestionsEnabled === 'boolean' &&
      typeof record.commentsModerationEnabled === 'boolean'
    );
  }

  private isManagedEntityAssignedBot(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    if (
      typeof record.botId !== 'string' ||
      typeof record.label !== 'string' ||
      (record.role !== undefined && record.role !== 'primary' && record.role !== 'standby') ||
      (record.membershipStatus !== undefined &&
        record.membershipStatus !== 'active' &&
        record.membershipStatus !== 'removed') ||
      (record.lifecycleState !== undefined &&
        record.lifecycleState !== 'active' &&
        record.lifecycleState !== 'dormant' &&
        record.lifecycleState !== 'draining' &&
        record.lifecycleState !== 'disabled') ||
      (record.speechPersona !== undefined &&
        record.speechPersona !== 'male' &&
        record.speechPersona !== 'female' &&
        record.speechPersona !== 'neutral') ||
      (record.characterName !== undefined &&
        record.characterName !== null &&
        typeof record.characterName !== 'string') ||
      (record.avatarUrl !== undefined &&
        record.avatarUrl !== null &&
        typeof record.avatarUrl !== 'string')
    ) {
      return false;
    }

    if (
      record.capabilities !== undefined &&
      (!Array.isArray(record.capabilities) ||
        !record.capabilities.every((capability) => typeof capability === 'string'))
    ) {
      return false;
    }

    if (
      record.permissionsSummary !== undefined &&
      record.permissionsSummary !== null &&
      !this.isManagedEntityPermissionsSummary(record.permissionsSummary)
    ) {
      return false;
    }

    return true;
  }

  private isManagedEntityPermissionsSummary(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    return (
      (record.checkedAt === null ||
        record.checkedAt === undefined ||
        typeof record.checkedAt === 'string') &&
      typeof record.isAdmin === 'boolean' &&
      typeof record.isOwner === 'boolean' &&
      Array.isArray(record.permissions) &&
      record.permissions.every((permission) => typeof permission === 'string')
    );
  }

  private readLocalChatContext(chatId: string): ChatContext | null {
    const cached = this.localChatContextCache.get(chatId);
    if (!cached) {
      return null;
    }

    if (cached.expiresAtMs <= Date.now()) {
      this.localChatContextCache.delete(chatId);
      return null;
    }

    return cached.value;
  }

  private writeLocalChatContext(chatId: string, value: ChatContext): void {
    this.localChatContextCache.set(chatId, {
      value,
      expiresAtMs: Date.now() + this.localChatContextTtlMs,
    });
  }

  private applyLocalInvalidation(chatId: string): void {
    this.localChatContextCache.delete(chatId);
    this.chatContextInFlightLoads.delete(chatId);
    this.localChatContextEpochs.set(chatId, this.readChatContextEpoch(chatId) + 1);
  }

  private parseInvalidationPayload(payload: string): string | null {
    try {
      const parsed = JSON.parse(payload) as { chatId?: unknown };
      return typeof parsed.chatId === 'string' && parsed.chatId.trim().length > 0
        ? parsed.chatId.trim()
        : null;
    } catch {
      return null;
    }
  }

  private readChatContextEpoch(chatId: string): number {
    return this.localChatContextEpochs.get(chatId) ?? 0;
  }

  private appendChatAdminUser(context: ChatContext, userId: string): ChatContext {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId || context.adminUserIds.includes(normalizedUserId)) {
      return context;
    }

    return {
      ...context,
      adminUserIds: [...context.adminUserIds, normalizedUserId],
    };
  }

  private writeChatContextToRedis(chatId: string, value: ChatContext): void {
    void this.runRedisWriteWithin(
      this.redis.set(
        ChatContextCacheService.cacheKey(chatId),
        JSON.stringify(value),
        'EX',
        ChatContextCacheService.CHAT_CONTEXT_TTL_SEC,
      ),
      ChatContextCacheService.CHAT_CONTEXT_REDIS_WRITE_TIMEOUT_MS,
    );
  }

  private async readRedisStringWithin(key: string, maxWaitMs: number): Promise<string | null> {
    const readPromise = this.redis.get(key).catch(() => null);
    return this.runRedisReadWithin(readPromise, maxWaitMs);
  }

  private async readRedisStringsWithin(
    keys: readonly string[],
    maxWaitMs: number,
  ): Promise<Array<string | null> | null> {
    if (keys.length === 0) {
      return [];
    }

    const readPromise = this.redis.mget(...keys).catch(() => null);
    return this.runRedisReadWithin(readPromise, maxWaitMs);
  }

  private parseAdminAccessState(raw: string | null): ChatAdminAccessState | null {
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

  private async runRedisReadWithin<T>(operation: Promise<T>, maxWaitMs: number): Promise<T | null> {
    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), Math.max(1, Math.trunc(maxWaitMs)));
      timeout.unref();
    });

    try {
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async runRedisWriteWithin(operation: Promise<unknown>, maxWaitMs: number): Promise<void> {
    const result = await this.runRedisReadWithin(
      operation.then(() => true).catch(() => false),
      maxWaitMs,
    );
    void result;
  }
}
