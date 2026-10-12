import { probeManagedEntityActor } from './managed-entity-actor-probe';

describe('personal human access probe', () => {
  function fixture() {
    const old = new Date('2020-01-01T00:00:00Z');
    const membership = {
      botId: 'major',
      status: 'ACTIVE',
      botAccessState: 'CONFIRMED_ADMIN',
      botAccessCheckedAt: old,
      botAccessExpiresAt: old,
      botAccessSource: 'explicit_start',
      lifecycleEventAt: old,
      permissionsSnapshot: {
        checkedAt: old.toISOString(),
        isAdmin: true,
        isOwner: false,
        permissionsKnown: true,
        permissions: ['read_all_messages', 'write'],
      },
      chat: { entityType: 'CHAT' },
    };
    const human = {
      userId: '123',
      isBot: false,
      isAdmin: true,
      isOwner: false,
      explicitPrivilegeEvidence: true,
      permissions: [],
    };
    const prisma = {
      chatBotMembership: { findUnique: jest.fn().mockResolvedValue(membership) },
      managedEntityAccessEdge: {
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
        updateMany: jest.fn(),
      },
      chatAdminAllowlist: { upsert: jest.fn(), deleteMany: jest.fn() },
      $queryRaw: jest
        .fn()
        .mockImplementation(async (q) => (q.sql.includes('FROM chats') ? [{ id: '-1' }] : [])),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn) => fn(prisma));
    const maxClient = {
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map([['123', human]])),
      getChatAdminAccesses: jest.fn().mockResolvedValue([human]),
    };
    const cache = { applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true) };
    const run = () =>
      probeManagedEntityActor({
        prisma: prisma as never,
        maxClient: maxClient as never,
        cache: cache as never,
        chatId: '-1',
        botId: 'major',
        userId: 'id123',
        requiredCheckedAfter: new Date(Date.now() - 10),
      });
    return { run, prisma, maxClient, cache, membership, human };
  }
  it('checks only the human using durable bot proof and accepts MAX id aliases', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toBe(true);
    expect(f.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      '-1',
      ['123'],
      expect.objectContaining({ botId: 'major', bypassCache: true }),
    );
    expect(f.maxClient.getChatAdminAccesses).not.toHaveBeenCalled();
    expect(f.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ state: 'GRANTED' }) }),
    );
    expect(f.cache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'granted' }),
    );
  });
  it.each([429, 500, 503])('preserves SQL and Redis evidence on MAX %s', async (status) => {
    const f = fixture();
    f.maxClient.getChatMembersAccess.mockRejectedValue({ response: { status } });
    await expect(f.run()).rejects.toEqual({ response: { status } });
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.cache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });
  it('confirms member GET denial through a roster before denying only the human', async () => {
    const f = fixture();
    f.maxClient.getChatMembersAccess.mockRejectedValue({ response: { status: 403 } });
    f.maxClient.getChatAdminAccesses.mockResolvedValue([]);
    await f.run();
    expect(f.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ state: 'USER_DENIED' }) }),
    );
    expect(f.membership.botAccessState).toBe('CONFIRMED_ADMIN');
  });
  it('does not turn an incomplete positive result into a denial', async () => {
    const f = fixture();
    f.human.explicitPrivilegeEvidence = false;
    await expect(f.run()).rejects.toThrow('incomplete');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('rejects a grant if a newer bot denial wins while MAX responds', async () => {
    const f = fixture();
    f.prisma.chatBotMembership.findUnique
      .mockResolvedValueOnce(f.membership)
      .mockResolvedValue({ ...f.membership, botAccessState: 'DENIED' });
    await expect(f.run()).rejects.toThrow('superseded');
    expect(f.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(f.cache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });
  it('does not overwrite a newer actor verdict or an in-flight membership event', async () => {
    const f = fixture();
    f.prisma.managedEntityAccessEdge.findFirst.mockResolvedValue({ userId: '123' });
    await expect(f.run()).rejects.toThrow('superseded');
    expect(f.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    f.prisma.managedEntityAccessEdge.findFirst.mockResolvedValue(null);
    f.prisma.$queryRaw.mockResolvedValue([{ id: '-1', userId: '123' }]);
    await expect(f.run()).rejects.toThrow('superseded');
    expect(f.cache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });
  it('publishes Redis only after a successful SQL commit', async () => {
    const f = fixture();
    f.prisma.$transaction.mockRejectedValue(new Error('commit failed'));
    await expect(f.run()).rejects.toThrow('commit failed');
    expect(f.cache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });
});
