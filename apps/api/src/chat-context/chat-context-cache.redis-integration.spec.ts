import type { ChatSummary } from '@maxim/contracts';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { ChatContextCacheService } from './chat-context-cache.service';

const redisIntegrationUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const isLocalRedisUrl = (() => {
  try {
    const hostname = new URL(redisIntegrationUrl).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
})();
const describeLocalRedis = isLocalRedisUrl ? describe : describe.skip;

describeLocalRedis('ChatContextCacheService Redis integration', () => {
  it('orders equal-time denial above grant and expires the per-user epoch', async () => {
    const suffix = randomUUID();
    const userId = `redis-epoch-user-${suffix}`;
    const chatId = `redis-epoch-chat-${suffix}`;
    const service = new ChatContextCacheService(
      {} as never,
      { getOrThrow: () => redisIntegrationUrl } as never,
      {} as never,
    );
    const inspector = new Redis(redisIntegrationUrl);
    const eventAt = new Date('2026-08-20T10:00:00.123Z');
    const epochKey = ChatContextCacheService.adminAccessEpochKey(chatId, userId);
    const accessKey = ChatContextCacheService.adminAccessKey(chatId, userId);

    try {
      await expect(
        service.applyAdminAccessEpochMutation({
          chatId,
          userId,
          state: 'user_denied',
          eventAt,
        }),
      ).resolves.toBe(true);
      await expect(
        service.applyAdminAccessEpochMutation({
          chatId,
          userId,
          state: 'granted',
          eventAt,
        }),
      ).resolves.toBe(false);
      await expect(inspector.get(accessKey)).resolves.toBe('user_denied');
      const epochTtlSec = await inspector.ttl(epochKey);
      expect(epochTtlSec).toBeGreaterThan(29 * 24 * 60 * 60);
      expect(epochTtlSec).toBeLessThanOrEqual(30 * 24 * 60 * 60);
      await expect(
        inspector.ttl(ChatContextCacheService.chatContextRevisionKey(chatId)),
      ).resolves.toBe(-1);
    } finally {
      await inspector.del(
        epochKey,
        accessKey,
        ChatContextCacheService.chatContextRevisionKey(chatId),
        ChatContextCacheService.cacheKey(chatId),
      );
      await inspector.quit();
      await service.onModuleDestroy();
    }
  });

  it('retries a denial when a stale context appears between MGET and EVAL', async () => {
    const suffix = randomUUID();
    const userId = `redis-context-race-user-${suffix}`;
    const chatId = `redis-context-race-chat-${suffix}`;
    const service = new ChatContextCacheService(
      {} as never,
      { getOrThrow: () => redisIntegrationUrl } as never,
      {} as never,
    );
    const inspector = new Redis(redisIntegrationUrl);
    const contextKey = ChatContextCacheService.cacheKey(chatId);
    const epochKey = ChatContextCacheService.adminAccessEpochKey(chatId, userId);
    const accessKey = ChatContextCacheService.adminAccessKey(chatId, userId);
    const revisionKey = ChatContextCacheService.chatContextRevisionKey(chatId);
    const redis = service as unknown as {
      redis: { eval: (...args: unknown[]) => Promise<unknown> };
    };
    const evaluate = redis.redis.eval.bind(redis.redis);
    let injected = false;
    redis.redis.eval = async (...args: unknown[]) => {
      if (!injected) {
        injected = true;
        await inspector.set(
          contextKey,
          JSON.stringify({
            chatId,
            title: 'Race chat',
            settings: {},
            domainAllowlist: [],
            adminUserIds: [userId],
            rulesPublishedUrl: null,
            rulesPublishedMessageId: null,
          }),
        );
      }
      return evaluate(...args);
    };

    try {
      await expect(
        service.applyAdminAccessEpochMutation({
          chatId,
          userId,
          state: 'user_denied',
          eventAt: new Date('2026-08-20T10:00:00.123Z'),
        }),
      ).resolves.toBe(true);

      const stored = JSON.parse((await inspector.get(contextKey)) ?? 'null') as {
        adminUserIds?: unknown;
      };
      expect(stored.adminUserIds).toEqual([]);
      await expect(inspector.get(accessKey)).resolves.toBe('user_denied');
    } finally {
      await inspector.del(contextKey, epochKey, accessKey, revisionKey);
      await inspector.quit();
      await service.onModuleDestroy();
    }
  });

  it('preserves empty arrays while moving a recovered entity between snapshots', async () => {
    const userId = `redis-integration-${randomUUID()}`;
    const service = new ChatContextCacheService(
      {} as never,
      { getOrThrow: () => redisIntegrationUrl } as never,
      {} as never,
    );
    const inspector = new Redis(redisIntegrationUrl);
    const chatKey = ChatContextCacheService.managedEntitiesPublishedSnapshotKey(userId, 'chat');
    const channelKey = ChatContextCacheService.managedEntitiesPublishedSnapshotKey(
      userId,
      'channel',
    );
    const original: ChatSummary = {
      id: '-100-forwarded',
      title: 'Recovered entity',
      createdAt: '2026-08-01T00:00:00.000Z',
      entityType: 'chat',
      link: null,
      avatarUrl: null,
      channelOverview: null,
      primaryBotId: 'launch-bot',
      assignedBots: [],
      sharedMode: 'owned',
    };

    try {
      await service.setManagedEntitiesPublishedSnapshot(
        userId,
        'chat',
        {
          version: 'before-recovery',
          builtAt: '2026-08-01T00:00:00.000Z',
          lastSyncedAt: null,
          itemCount: 1,
          itemsHash: 'before-recovery',
          items: [original],
        },
        60,
        { expectedVersion: null },
      );
      await service.upsertManagedEntityPublishedSnapshot(
        userId,
        { ...original, entityType: 'channel' },
        60,
      );

      await expect(service.getManagedEntitiesPublishedSnapshot(userId, 'channel')).resolves.toEqual(
        expect.objectContaining({
          items: [expect.objectContaining({ assignedBots: [] })],
        }),
      );
      await expect(inspector.exists(chatKey)).resolves.toBe(0);
      const stored = JSON.parse((await inspector.get(channelKey)) ?? 'null') as {
        items?: Array<{ assignedBots?: unknown }>;
      };
      expect(Array.isArray(stored.items?.[0]?.assignedBots)).toBe(true);
    } finally {
      await inspector.del(chatKey, channelKey);
      await inspector.quit();
      await service.onModuleDestroy();
    }
  });

  it('merges concurrent standalone recent bootstrap upserts without losing either chat', async () => {
    const suffix = randomUUID();
    const userId = `redis-bootstrap-user-${suffix}`;
    const chatIds = [`redis-bootstrap-a-${suffix}`, `redis-bootstrap-b-${suffix}`];
    const service = new ChatContextCacheService(
      {} as never,
      { getOrThrow: () => redisIntegrationUrl } as never,
      {} as never,
    );
    const buildSummary = (chatId: string): ChatSummary => ({
      id: chatId,
      title: chatId,
      createdAt: '2026-08-20T10:00:00.000Z',
      entityType: 'chat',
      link: null,
      avatarUrl: null,
      channelOverview: null,
      primaryBotId: null,
      assignedBots: [],
      sharedMode: 'owned',
    });

    try {
      await Promise.all(
        chatIds.map((chatId) =>
          service.upsertManagedEntitiesRecentBootstrap(buildSummary(chatId), 60, userId),
        ),
      );
      const recent = await service.getManagedEntitiesRecentBootstrap('chat', userId);
      expect(
        recent
          .map((item) => item.id)
          .filter((chatId) => chatIds.includes(chatId))
          .sort(),
      ).toEqual([...chatIds].sort());
    } finally {
      await Promise.all(
        chatIds.map((chatId) => service.clearManagedEntitiesRecentBootstrapForChat(chatId, 'chat')),
      );
      await service.onModuleDestroy();
    }
  });
});
