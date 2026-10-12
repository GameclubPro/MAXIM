import { ManagedEntityAccessRefreshService } from './managed-entity-access-refresh.service';
import { buildBotAccessSnapshotPersistence } from '../max/bot-access-snapshot.util';

describe('personal managed entity demand', () => {
  const boundary = new Date('2026-10-12T10:00:00Z');
  function fixture() {
    const prisma = {
      managedEntityAccessEdge: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      managedBotChatCatalog: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const registry = {
      getPublisherBotDescriptor: () => ({ id: 'publik' }),
      getDiscoveryBots: () => [{ id: 'major-1' }, { id: 'major-2' }],
    };
    const roster = { scheduleActorProbe: jest.fn().mockResolvedValue(true) };
    const publisher = { enqueue: jest.fn().mockResolvedValue('job') };
    const service = new ManagedEntityAccessRefreshService(
      prisma as never,
      registry as never,
      roster as never,
      publisher as never,
    );
    return {
      service,
      prisma,
      roster,
      publisher,
      flush: () => new Promise<void>((resolve) => setImmediate(resolve)),
    };
  }
  const edge = (overrides = {}) => ({
    chatId: '-1',
    botId: 'major-1',
    entityType: 'CHAT',
    state: 'GRANTED',
    userRole: 'ADMIN',
    checkedAt: new Date(boundary.getTime() - 1000),
    lastAdminConfirmedAt: null,
    sourceVersion: null,
    ...overrides,
  });
  afterEach(() => jest.restoreAllMocks());

  it('only requests the entering human in their historically confirmed profile and entity type', async () => {
    const f = fixture();
    f.prisma.managedEntityAccessEdge.findMany.mockResolvedValue([
      edge(),
      edge({ chatId: '-2', state: 'USER_DENIED', lastAdminConfirmedAt: new Date(0) }),
      edge({ chatId: '-3', state: 'USER_DENIED' }),
      edge({ chatId: '-4', botId: 'publik' }),
      edge({ chatId: '-5', entityType: 'CHANNEL' }),
      edge({ chatId: '-6', checkedAt: boundary }),
    ]);
    f.service.schedule('alice', 'moderation', 'chat', +boundary);
    f.service.schedule('alice', 'moderation', 'chat', +boundary);
    await f.flush();
    expect(f.prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledTimes(1);
    expect(f.prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'alice' },
        take: 25,
        orderBy: [{ chatId: 'asc' }, { botId: 'asc' }],
      }),
    );
    expect(f.roster.scheduleActorProbe.mock.calls.map(([job]) => job)).toEqual(
      ['-1', '-2'].map((chatId) => ({
        chatId,
        botId: 'major-1',
        userId: 'alice',
        requiredCheckedAfter: boundary,
      })),
    );
    expect(f.publisher.enqueue).not.toHaveBeenCalled();
  });

  it('keeps Publisher demand exact-bot, including publication-disabled connections', async () => {
    const f = fixture();
    f.prisma.managedEntityAccessEdge.findMany.mockResolvedValue([
      edge({ botId: 'publik', sourceVersion: 'v1' }),
      edge(),
    ]);
    f.service.schedule('alice', 'publisher', 'chat', +boundary);
    await f.flush();
    expect(f.publisher.enqueue).toHaveBeenCalledTimes(1);
    expect(f.publisher.enqueue).toHaveBeenCalledWith({
      chatId: '-1',
      publisherBotId: 'publik',
      candidateUserId: 'alice',
      candidateVersion: 'v1',
      reason: 'stale_user_access',
      requestedAt: boundary,
    });
    expect(f.roster.scheduleActorProbe).not.toHaveBeenCalled();
  });

  it('advances the raw cursor past 25 rejected candidates and wraps after the last page', async () => {
    const f = fixture();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(+boundary);
    f.prisma.managedEntityAccessEdge.findMany.mockResolvedValueOnce(
      Array.from({ length: 25 }, (_, i) =>
        edge({ chatId: `chat-${String(i).padStart(2, '0')}`, state: 'USER_DENIED' }),
      ),
    );
    f.service.schedule('alice', 'moderation', 'chat', +boundary);
    await f.flush();
    clock.mockReturnValue(+boundary + 1501);
    f.service.schedule('alice', 'moderation', 'chat', +boundary);
    await f.flush();
    expect(f.prisma.managedEntityAccessEdge.findMany.mock.calls[1][0].where).toEqual({
      userId: 'alice',
      OR: [{ chatId: { gt: 'chat-24' } }, { chatId: 'chat-24', botId: { gt: 'major-1' } }],
    });
    clock.mockReturnValue(+boundary + 3002);
    f.service.schedule('alice', 'moderation', 'chat', +boundary);
    await f.flush();
    expect(f.prisma.managedEntityAccessEdge.findMany.mock.calls[2][0].where).toEqual({
      userId: 'alice',
    });
  });

  it('retries admission failures without skipping a page or blocking other users', async () => {
    const f = fixture();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(+boundary);
    f.prisma.managedEntityAccessEdge.findMany.mockResolvedValue([edge()]);
    f.roster.scheduleActorProbe.mockResolvedValueOnce(false);
    f.service.schedule('alice', 'moderation', 'chat', +boundary);
    await f.flush();
    f.service.schedule('bob', 'moderation', 'chat', +boundary);
    await f.flush();
    f.service.schedule('alice', 'moderation', 'chat', +boundary);
    await f.flush();
    expect(f.roster.scheduleActorProbe).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(+boundary + 5001);
    f.service.schedule('alice', 'moderation', 'chat', +boundary);
    await f.flush();
    expect(f.roster.scheduleActorProbe).toHaveBeenCalledTimes(3);
  });

  it('returns 150 saved cards on every launch without scheduling or waiting for MAX', async () => {
    const f = fixture();
    const records = Array.from({ length: 150 }, (_, i) =>
      edge({
        chatId: `chat-${i}`,
        expiresAt: new Date(0),
        chat: {
          id: `chat-${i}`,
          title: `Saved ${i}`,
          createdAt: new Date(0),
          primaryBotId: 'major-1',
          botMemberships: [
            {
              botId: 'major-1',
              status: 'ACTIVE',
              ...buildBotAccessSnapshotPersistence(
                {
                  isAdmin: true,
                  isOwner: false,
                  permissionsKnown: true,
                  permissions: ['read_all_messages', 'write'],
                },
                { source: 'explicit_start', now: new Date(0) },
              ),
            },
          ],
        },
      }),
    );
    f.prisma.managedEntityAccessEdge.findMany.mockResolvedValue(records);
    const user = {
        userId: 'alice',
        username: null,
        displayName: null,
        accessCheckedAfter: +boundary,
      },
      result = await f.service.listPersonal(user, 'chat');
    expect(result.items).toHaveLength(150);
    expect(result.refresh).toMatchObject({ complete: true, nextPollAfterMs: 0 });
    expect(
      (await f.service.listPersonal({ ...user, accessCheckedAfter: +boundary + 60_000 }, 'chat'))
        .items,
    ).toEqual(result.items);
    expect(f.prisma.managedEntityAccessEdge.findMany.mock.calls[0][0].where).toEqual({
      userId: 'alice',
      botId: { in: ['major-1', 'major-2'] },
      entityType: 'CHAT',
      state: 'GRANTED',
      userRole: { in: ['ADMIN', 'OWNER'] },
    });
    expect(f.roster.scheduleActorProbe).not.toHaveBeenCalled();
    expect(f.publisher.enqueue).not.toHaveBeenCalled();
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
    await f.service.onModuleDestroy();
  });
});
