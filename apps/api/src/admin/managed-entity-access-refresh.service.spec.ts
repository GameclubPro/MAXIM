import { ManagedEntityAccessRefreshService } from './managed-entity-access-refresh.service';

describe('ManagedEntityAccessRefreshService', () => {
  function fixture() {
    const prisma = { managedEntityAccessEdge: { findMany: jest.fn().mockResolvedValue([]) } };
    const registry = {
      getPublisherBotDescriptor: () => ({ id: 'publik' }),
      getDiscoveryBots: () => [{ id: 'major-1' }, { id: 'major-2' }],
    };
    const roster = { scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true) };
    const publisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedEntityAccessRefreshService(
      prisma as never,
      registry as never,
      roster as never,
      publisher as never,
    );
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    return { prisma, roster, publisher, service, flush };
  }

  afterEach(() => jest.restoreAllMocks());

  it('renews and recovers only exact Publisher grants or known cross-profile corruptions', async () => {
    const f = fixture();
    f.prisma.managedEntityAccessEdge.findMany.mockResolvedValue([
      { chatId: 'channel-1', botId: 'publik', entityType: 'CHANNEL', sourceVersion: 'edge-v1' },
    ]);
    f.service.schedule('user-1', 'publisher');
    await f.flush();
    expect(f.prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          botId: { in: ['publik'] },
          OR: [
            expect.objectContaining({
              state: 'GRANTED',
              userRole: { in: ['ADMIN', 'OWNER'] },
              OR: [{ expiresAt: null }, { expiresAt: { lte: expect.any(Date) } }],
            }),
            {
              state: { in: ['USER_DENIED', 'BOT_DENIED'] },
              source: { in: ['admin_roster_sync_clear', 'prune_persisted_chat_access'] },
            },
          ],
          chat: {
            publisherBinding: {
              is: expect.objectContaining({ publisherBotId: 'publik', status: 'ACTIVE' }),
            },
          },
        }),
        take: 25,
      }),
    );
    expect(f.publisher.enqueue).toHaveBeenCalledWith({
      chatId: 'channel-1',
      publisherBotId: 'publik',
      candidateUserId: 'user-1',
      candidateVersion: 'edge-v1',
      reason: 'stale_user_access',
      requestedAt: expect.any(Date),
    });
    expect(f.roster.scheduleChatAdminRosterSync).not.toHaveBeenCalled();
  });

  it('coalesces active moderation bots per entity and keeps CHAT and CHANNEL independent', async () => {
    const f = fixture();
    f.prisma.managedEntityAccessEdge.findMany.mockResolvedValue([
      { chatId: 'chat-1', botId: 'major-1', entityType: 'CHAT' },
      { chatId: 'chat-1', botId: 'major-2', entityType: 'CHAT' },
      { chatId: 'foreign', botId: 'publik', entityType: 'CHAT' },
    ]);
    f.service.schedule('user-1', 'moderation', 'chat');
    f.service.schedule('user-1', 'moderation', 'chat');
    await f.flush();
    f.service.schedule('user-1', 'moderation', 'chat');
    expect(f.prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledTimes(1);
    expect(f.prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          entityType: 'CHAT',
          botId: { in: ['major-1', 'major-2'] },
          OR: expect.arrayContaining([
            expect.objectContaining({
              state: 'GRANTED',
              chat: {
                botMemberships: {
                  some: { botId: { in: ['major-1', 'major-2'] }, status: 'ACTIVE' },
                },
              },
            }),
          ]),
        }),
      }),
    );
    expect(f.roster.scheduleChatAdminRosterSync).toHaveBeenCalledTimes(1);
    expect(f.roster.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botIds: ['major-1', 'major-2'],
      entityType: 'chat',
      source: 'admin_access_validation',
    });
    f.service.schedule('user-1', 'moderation', 'channel');
    await f.flush();
    expect(f.prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledTimes(2);
    expect(f.publisher.enqueue).not.toHaveBeenCalled();
  });

  it('backs off failed enqueues without losing the ability to retry', async () => {
    const f = fixture();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    f.prisma.managedEntityAccessEdge.findMany.mockRejectedValueOnce(
      new Error('temporary database failure'),
    );
    f.service.schedule('user-1', 'publisher');
    await f.flush();
    f.service.schedule('user-1', 'publisher');
    expect(f.prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(6_001);
    f.service.schedule('user-1', 'publisher');
    await f.flush();
    expect(f.prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledTimes(2);
  });

  it('rechecks historical message-only denials even after their membership was removed', async () => {
    const f = fixture();
    f.prisma.managedEntityAccessEdge.findMany.mockResolvedValue([
      { chatId: 'chat-1', botId: 'major-1', entityType: 'CHAT' },
    ]);
    f.service.schedule('user-1', 'moderation', 'chat');
    await f.flush();
    const query = f.prisma.managedEntityAccessEdge.findMany.mock.calls[0][0];
    expect(query.where).not.toHaveProperty('chat');
    expect(query.where.OR[1]).toEqual({
      state: 'BOT_DENIED',
      source: { in: ['managed_poll:lookup', 'managed_giveaway:results:verification'] },
      lastMaxStatusCode: { in: [403, 404] },
      lastMaxErrorCode: null,
    });
    expect(f.roster.scheduleChatAdminRosterSync).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', botIds: ['major-1'] }),
    );
    expect(f.publisher.enqueue).not.toHaveBeenCalled();
  });
});
