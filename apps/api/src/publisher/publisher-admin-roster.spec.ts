import { syncPublisherAdminRoster } from './publisher-admin-roster';

describe('Publisher administrator discovery', () => {
  function fixture() {
    const probeStartedAt = new Date('2026-09-23T10:00:00Z');
    const botAccessCheckedAt = new Date('2026-09-23T10:00:01Z');
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'chat-1' }]),
      publisherEntityBinding: {
        findUnique: jest.fn().mockResolvedValue({
          publisherBotId: 'publik',
          status: 'ACTIVE',
          lifecycleEventAt: null,
          botAccessCheckedAt,
          botAccessState: 'CONFIRMED_ADMIN',
        }),
      },
      managedEntityAccessEdge: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const maxClient = {
      getChatAdminAccesses: jest.fn().mockResolvedValue([
        { userId: 'installer', isBot: false, isAdmin: true, isOwner: false },
        { userId: 'other-admin', isBot: false, isAdmin: true, isOwner: true },
        { userId: 'bot-admin', isBot: true, isAdmin: true, isOwner: false },
        { userId: 'untyped-admin', isBot: null, isAdmin: true, isOwner: false },
      ]),
    };
    const prisma = { $transaction: jest.fn((fn) => fn(tx)) };
    const params = {
      prisma: prisma as never,
      maxClient: maxClient as never,
      chatId: 'chat-1',
      publisherBotId: 'publik',
      entityType: 'CHAT' as const,
      probeStartedAt,
      botAccessCheckedAt,
      botAccessState: 'CONFIRMED_ADMIN' as const,
    };
    return { tx, maxClient, prisma, params };
  }

  it.each(['CHAT', 'CHANNEL'] as const)(
    'discovers other human admins of a %s without Major evidence',
    async (entityType) => {
      const f = fixture();
      await expect(syncPublisherAdminRoster({ ...f.params, entityType })).resolves.toBe(true);
      expect(f.maxClient.getChatAdminAccesses).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({
          botId: 'publik',
          bypassCache: true,
          trafficClass: 'background',
        }),
      );
      expect(f.tx.managedEntityAccessEdge.createMany).toHaveBeenCalledWith({
        skipDuplicates: true,
        data: ['installer', 'other-admin'].map((userId) =>
          expect.objectContaining({
            userId,
            botId: 'publik',
            entityType,
            state: 'GRANTED',
          }),
        ),
      });
      const update = f.tx.managedEntityAccessEdge.updateMany.mock.calls[0][0];
      expect(update.where.checkedAt).toEqual({ lte: f.params.probeStartedAt });
      expect(update.data).not.toHaveProperty('sourceVersion');
      expect(f.tx.managedEntityAccessEdge.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            chatId: 'chat-1',
            botId: 'publik',
            state: 'GRANTED',
            userId: { notIn: ['installer', 'other-admin', 'bot-admin', 'untyped-admin'] },
            checkedAt: { lte: f.params.probeStartedAt },
          },
          data: expect.objectContaining({ state: 'USER_DENIED' }),
        }),
      );
    },
  );

  it.each([
    { publisherBotId: 'major' },
    { status: 'REMOVED' },
    { botAccessState: 'DENIED' },
    { botAccessCheckedAt: new Date('2026-09-23T10:00:02Z') },
    { lifecycleEventAt: new Date('2026-09-23T10:00:02Z') },
  ])('does not persist a superseded roster: %j', async (change) => {
    const f = fixture();
    const binding = await f.tx.publisherEntityBinding.findUnique();
    f.tx.publisherEntityBinding.findUnique.mockResolvedValue({ ...binding, ...change });
    await expect(syncPublisherAdminRoster(f.params)).resolves.toBe(false);
    expect(f.tx.managedEntityAccessEdge.createMany).not.toHaveBeenCalled();
    expect(f.tx.managedEntityAccessEdge.updateMany).not.toHaveBeenCalled();
  });

  it('does not revive an admin removed while the MAX roster request was in flight', async () => {
    const f = fixture();
    f.tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'chat-1' }])
      .mockResolvedValueOnce([{ userId: 'other-admin' }]);
    await syncPublisherAdminRoster(f.params);
    expect(f.tx.managedEntityAccessEdge.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ userId: 'installer' })],
      }),
    );
  });

  it('leaves all grants intact on an incomplete or failed MAX roster', async () => {
    const f = fixture();
    f.maxClient.getChatAdminAccesses.mockRejectedValue(new Error('incomplete roster'));
    await expect(syncPublisherAdminRoster(f.params)).rejects.toThrow('incomplete roster');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
});
