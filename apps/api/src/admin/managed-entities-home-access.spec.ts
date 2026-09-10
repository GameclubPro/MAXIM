import { ServiceUnavailableException } from '@nestjs/common';
import { AdminService } from './admin.service';
import {
  createChatContextCacheMock,
  createConfigMock,
  createPrismaMock,
} from './admin-service-test-support';

describe('Home access profile isolation', () => {
  function fixture() {
    const prisma = createPrismaMock();
    const edges = {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    Object.assign(prisma, { managedEntityAccessEdge: edges });
    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock({ botId: 'major' }) as never,
    );
    Object.assign(service, {
      maxBotRegistry: { getPublisherBotDescriptor: () => ({ id: 'publik' }) },
    });
    return { prisma, edges, service: service as any };
  }

  it.each(['chat', 'channel'])(
    'ignores a newer Publisher denial for a granted moderation %s',
    async (entityType) => {
      const f = fixture();
      f.edges.findMany.mockResolvedValue([
        { chatId: 'entity-1', botId: 'major', state: 'GRANTED', checkedAt: new Date(100) },
        { chatId: 'entity-1', botId: 'publik', state: 'USER_DENIED', checkedAt: new Date(200) },
      ]);
      const items = [{ id: 'entity-1', entityType, title: 'Owned entity' }];
      await expect(
        f.service.filterManagedEntitiesByStrictAccessEdges('user-1', items),
      ).resolves.toMatchObject(items);
      f.edges.findMany.mockResolvedValue([
        { chatId: 'entity-1', botId: 'major', state: 'USER_DENIED', checkedAt: new Date(300) },
      ]);
      await expect(
        f.service.filterManagedEntitiesByStrictAccessEdges('user-1', items),
      ).resolves.toEqual([]);
    },
  );

  it('does not publish a verified empty list when the access database fails', async () => {
    const f = fixture();
    f.edges.findMany.mockRejectedValue(new Error('temporary database failure'));
    await expect(
      f.service.filterManagedEntitiesByStrictAccessEdges('user-1', [{ id: 'entity-1' }]),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('keeps the last published snapshot intact when strict revalidation fails', async () => {
    const f = fixture();
    f.prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'entity-1',
          title: 'Owned entity',
          entityType: 'CHANNEL',
          createdAt: new Date(),
        },
      },
    ]);
    f.edges.findMany.mockRejectedValue(new Error('temporary database failure'));
    await expect(
      f.service.rebuildManagedEntitiesPublishedSnapshot('user-1', 'channel'),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(f.service.chatContextCache.setManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
  });

  it('restricts legacy and epoch-fenced access pruning to moderation bots', async () => {
    const f = fixture();
    await f.service.prunePersistedChatAccess('entity-1', 'user-1');
    expect(f.edges.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'entity-1',
          userId: 'user-1',
          botId: { in: ['major'] },
        }),
      }),
    );
    await f.service.prunePersistedChatAccess('entity-1', 'user-1', { eventAt: new Date() });
    expect(f.edges.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'entity-1',
          userId: { in: ['user-1', 'iduser-1'] },
          botId: { in: ['major'] },
        }),
      }),
    );
  });
});
