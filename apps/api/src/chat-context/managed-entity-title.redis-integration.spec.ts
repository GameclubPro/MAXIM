import type { ChatSummary } from '@maxim/contracts';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { ChatContextCacheService } from './chat-context-cache.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = redisUrl ? describe : describe.skip;

native('connection title preservation on native Redis', () => {
  it.each(['chat', 'channel'] as const)(
    'preserves a renamed %s through missing-title grants and late bootstrap writes',
    async (entityType) => {
      if (!['localhost', '127.0.0.1', '::1'].includes(new URL(redisUrl).hostname)) {
        throw new Error('Disposable local Redis required');
      }
      const chatId = `-title-${randomUUID()}`;
      const userId = `title-user-${randomUUID()}`;
      const service = new ChatContextCacheService(
        {} as never,
        { getOrThrow: () => redisUrl } as never,
        {} as never,
      );
      const inspector = new Redis(redisUrl);
      const key = ChatContextCacheService.managedEntitiesPublishedSnapshotKey(userId, entityType);
      const globalKey = ChatContextCacheService.managedEntitiesRecentBootstrapKey(entityType);
      const userKey = ChatContextCacheService.managedEntitiesRecentBootstrapUserKey(
        entityType,
        userId,
      );
      const item: ChatSummary & { entityType: typeof entityType } = {
        id: chatId,
        title: 'Сохранённое название',
        createdAt: new Date().toISOString(),
        entityType,
        link: null,
        avatarUrl: 'https://example.test/avatar.webp',
        primaryBotId: 'original-bot',
        assignedBots: [],
        sharedMode: 'owned',
        channelOverview: null,
      };
      const assertTitles = async (title: string) => {
        expect(
          (await service.getManagedEntitiesPublishedSnapshot(userId, entityType))?.items[0]?.title,
        ).toBe(title);
        for (const snapshotKey of [globalKey, userKey]) {
          const entries = JSON.parse((await inspector.get(snapshotKey)) ?? '[]') as ChatSummary[];
          expect(entries.find((entry) => entry.id === chatId)?.title).toBe(title);
        }
      };
      const grant = async (summary: typeof item, offset: number) => {
        expect(
          await service.applyAdminAccessEpochMutation({
            chatId,
            userId,
            state: 'granted',
            eventAt: new Date(Date.now() + offset),
            publishedSummary: summary,
            recentBootstrapSummary: summary,
          }),
        ).toBe(true);
      };
      try {
        await grant(item, 0);
        const renamed = { ...item, title: 'Новое название сообщества' };
        await grant(renamed, 1_000);
        const missing = {
          ...item,
          title: `${entityType === 'chat' ? 'Chat' : 'Channel'} ${chatId}`,
        };
        await grant(missing, 2_000);
        await assertTitles(renamed.title);
        await service.upsertManagedEntityPublishedSnapshot(userId, missing, 60);
        await service.upsertManagedEntitiesRecentBootstrap(missing, 60, userId);
        await assertTitles(renamed.title);
        await service.upsertManagedEntityPublishedSnapshot(
          userId,
          { ...item, title: 'Настоящее новое имя' },
          60,
        );
        expect(
          (await service.getManagedEntitiesPublishedSnapshot(userId, entityType))?.items[0]?.title,
        ).toBe('Настоящее новое имя');
        await service.applyAdminAccessEpochMutation({
          chatId,
          userId,
          state: 'user_denied',
          eventAt: new Date(Date.now() + 3_000),
        });
        expect(
          await service.applyAdminAccessEpochMutation({
            chatId,
            userId,
            state: 'granted',
            eventAt: new Date(Date.now() - 1_000),
            publishedSummary: missing,
            recentBootstrapSummary: missing,
          }),
        ).toBe(false);
        expect(await service.getAdminAccess(chatId, userId)).toBe('user_denied');
        expect(
          (await service.getManagedEntitiesPublishedSnapshot(userId, entityType))?.items ?? [],
        ).toEqual([]);
      } finally {
        await service.removeManagedEntitiesRecentBootstrap(entityType, chatId);
        await inspector.del(
          key,
          userKey,
          ChatContextCacheService.adminAccessKey(chatId, userId),
          ChatContextCacheService.adminAccessEpochKey(chatId, userId),
          ChatContextCacheService.chatContextRevisionKey(chatId),
        );
        await inspector.quit();
        await service.onModuleDestroy();
      }
    },
  );
});
