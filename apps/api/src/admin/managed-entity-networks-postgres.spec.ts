import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { createPrismaAdapter, PrismaClient } from '../prisma/prisma-client';
import { ManagedEntityNetworksService } from './managed-entity-networks.service';
import { writeManagedEntityFavorites } from './managed-entity-favorites-writer';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const integration = databaseUrl ? describe : describe.skip;

integration('managed network composition with PostgreSQL', () => {
  let db: PrismaClient;
  let service: ManagedEntityNetworksService;
  const suffix = randomUUID();
  const actor = `networks-actor-${suffix}`;
  const bot = `networks-bot-${suffix}`;
  const publisherBot = `networks-publisher-${suffix}`;
  const ids = ['a', 'b', 'c', 'channel', 'denied', 'publisher'].map(
    (name) => `networks-${suffix}-${name}`,
  );
  const user = { userId: actor, username: null, displayName: null };

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('race_test'))
      throw new Error('Disposable PostgreSQL required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 6, statement_timeout: 15000 }),
    });
    service = new ManagedEntityNetworksService(
      db as never,
      { getAllBots: () => [{ id: bot }] } as never,
    );
    for (const id of ids) {
      const entityType = id === ids[3] ? 'CHANNEL' : 'CHAT';
      await db.chat.create({ data: { id, title: `Сетка ${id}`, entityType } });
      await db.managedEntityAccessEdge.create({
        data: {
          chatId: id,
          userId: actor,
          botId: id === ids[5] ? publisherBot : bot,
          entityType,
          state: id === ids[4] ? 'USER_DENIED' : 'GRANTED',
          userRole: 'ADMIN',
          expiresAt: new Date(0),
        },
      });
    }
  });
  beforeEach(async () => {
    await db.managedEntityFavorite.deleteMany({ where: { userId: actor } });
  });
  afterAll(async () => {
    await db?.chat.deleteMany({ where: { id: { in: ids } } });
    await db?.managedEntityFavoritePreference.deleteMany({ where: { userId: actor } });
    await db?.$disconnect();
  });

  it('reads all typed networks independently of loaded home pages and keeps legacy assignment canonical', async () => {
    await db.managedEntityFavorite.createMany({
      data: [
        { userId: actor, chatId: ids[0], favoriteType: 'WATCH' },
        { userId: actor, chatId: ids[0], favoriteType: 'IMPORTANT' },
        { userId: actor, chatId: ids[1], favoriteType: 'WATCH' },
        { userId: actor, chatId: ids[3], entityType: 'CHANNEL', favoriteType: 'WATCH' },
        { userId: actor, chatId: ids[4], favoriteType: 'WATCH' },
        { userId: actor, chatId: ids[5], favoriteType: 'WATCH' },
      ],
    });
    const catalogue = await service.catalogue(user, 'chat');
    expect(catalogue.items).toHaveLength(6);
    expect(catalogue.items.find((item) => item.favoriteType === 'important')?.entityCount).toBe(1);
    expect(catalogue.items.find((item) => item.favoriteType === 'watch')?.entityCount).toBe(1);
    expect((await service.resolveSelection(user, 'chat', 'watch')).entityIds).toEqual([ids[1]]);
    expect((await service.resolveSelection(user, 'channel', 'watch')).entityIds).toEqual([ids[3]]);
    expect(
      await db.managedEntityFavoritePreference.findUnique({ where: { userId: actor } }),
    ).toBeNull();
    const first = await service.entries(user, 'chat', { favoritesOnly: 'true', limit: 1 });
    const second = await service.entries(user, 'chat', {
      favoritesOnly: 'true',
      limit: 1,
      cursor: first.nextCursor,
    });
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual([ids[0], ids[1]]);
    expect(second.nextCursor).toBeNull();
  });

  it('serializes empty-assignment races and rejects a competing category without partial writes', async () => {
    const outcomes = await Promise.allSettled([
      service.updateComposition(user, 'chat', {
        changes: [{ entityId: ids[0], expectedFavoriteType: null, favoriteType: 'important' }],
      }),
      service.updateComposition(user, 'chat', {
        changes: [{ entityId: ids[0], expectedFavoriteType: null, favoriteType: 'watch' }],
      }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(ConflictException);
    expect(await db.managedEntityFavorite.count({ where: { userId: actor, chatId: ids[0] } })).toBe(
      1,
    );
  });

  it('prevents a delayed single writer from restoring an assignment removed on another device', async () => {
    await service.updateComposition(user, 'chat', {
      changes: [{ entityId: ids[0], expectedFavoriteType: null, favoriteType: 'important' }],
    });
    await service.updateComposition(user, 'chat', {
      changes: [{ entityId: ids[0], expectedFavoriteType: 'important', favoriteType: null }],
    });
    await expect(
      writeManagedEntityFavorites(db as never, actor, 'chat', [
        { entityId: ids[0], expectedFavoriteType: 'important', favoriteType: 'watch' },
      ]),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await db.managedEntityFavorite.count({ where: { userId: actor, chatId: ids[0] } })).toBe(
      0,
    );
  });

  it('preserves unrelated device changes, retries an already achieved result and atomically rejects conflicts', async () => {
    await service.updateComposition(user, 'chat', {
      changes: [{ entityId: ids[1], expectedFavoriteType: null, favoriteType: 'watch' }],
    });
    const change = { entityId: ids[0], expectedFavoriteType: null, favoriteType: 'important' };
    await service.updateComposition(user, 'chat', { changes: [change] });
    await service.updateComposition(user, 'chat', { changes: [change] });
    await expect(
      service.updateComposition(user, 'chat', {
        changes: [
          { entityId: ids[0], expectedFavoriteType: 'watch', favoriteType: 'service' },
          { entityId: ids[2], expectedFavoriteType: null, favoriteType: 'service' },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await service.resolveSelection(user, 'chat', 'watch')).entityIds).toEqual([ids[1]]);
    expect((await service.resolveSelection(user, 'chat', 'service')).entityIds).toEqual([]);
    expect(
      await db.managedEntityFavoritePreference.findUnique({ where: { userId: actor } }),
    ).toBeNull();
  });

  it('shares serialization with legacy single writes and refuses wrong-type/denied/Publisher targets', async () => {
    await Promise.allSettled([
      writeManagedEntityFavorites(db as never, actor, 'chat', [
        { entityId: ids[0], favoriteType: 'watch', expectedFavoriteType: null },
      ]),
      service.updateComposition(user, 'chat', {
        changes: [{ entityId: ids[0], expectedFavoriteType: null, favoriteType: 'important' }],
      }),
    ]);
    expect(await db.managedEntityFavorite.count({ where: { userId: actor, chatId: ids[0] } })).toBe(
      1,
    );
    for (const id of [ids[3], ids[4], ids[5]]) {
      await expect(
        service.updateComposition(user, 'chat', {
          changes: [{ entityId: id, expectedFavoriteType: null, favoriteType: 'important' }],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('binds pagination to actor/filter/composition and invalidates only the affected network selection', async () => {
    const beforeWatch = await service.resolveSelection(user, 'chat', 'watch');
    const page = await service.entries(user, 'chat', { limit: 1 });
    await expect(
      service.entries(user, 'chat', { limit: 1, search: 'other', cursor: page.nextCursor }),
    ).rejects.toThrow('Недействительный курсор');
    await service.updateComposition(user, 'chat', {
      changes: [{ entityId: ids[0], expectedFavoriteType: null, favoriteType: 'important' }],
    });
    await expect(
      service.entries(user, 'chat', { limit: 1, cursor: page.nextCursor }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await service.resolveSelection(user, 'chat', 'watch')).compositionVersion).toBe(
      beforeWatch.compositionVersion,
    );
  });
});
