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
});
