import {
  KaravanStorefrontAllowlistService,
  resolveKaravanStorefrontExpiresAt,
} from './karavan-storefront-allowlist.service';

const actor = {
  userId: 'admin-1',
  username: 'admin',
  displayName: 'Admin',
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    chatId: 'chat-1',
    userId: 'user-1',
    displayName: 'Seller',
    expiresAt: null,
    createdByUserId: 'admin-1',
    sourceMessageId: null,
    createdAt: new Date('2026-08-24T10:00:00.000Z'),
    updatedAt: new Date('2026-08-24T10:00:00.000Z'),
    ...overrides,
  };
}

describe('KaravanStorefrontAllowlistService', () => {
  it('resolves the private-flow duration buttons on the server', () => {
    const now = new Date('2026-08-24T12:00:00.000Z');
    expect(resolveKaravanStorefrontExpiresAt('1d', now)).toEqual(
      new Date('2026-08-25T12:00:00.000Z'),
    );
    expect(resolveKaravanStorefrontExpiresAt('90d', now)).toEqual(
      new Date('2026-11-22T12:00:00.000Z'),
    );
    expect(resolveKaravanStorefrontExpiresAt('forever', now)).toBeNull();
  });

  it('lists only active entries by default and enforces managed-chat admin access', async () => {
    const findMany = jest.fn().mockResolvedValue([row()]);
    const adminService = { assertChatAdminAccess: jest.fn().mockResolvedValue(undefined) };
    const service = new KaravanStorefrontAllowlistService(
      {
        karavanStorefrontAllowlistEntry: { findMany },
      } as never,
      adminService as never,
    );

    await expect(service.list('chat-1', actor)).resolves.toEqual({
      items: [
        {
          id: 'entry-1',
          chatId: 'chat-1',
          userId: 'user-1',
          displayName: 'Seller',
          expiresAt: null,
          createdByUserId: 'admin-1',
          sourceMessageId: null,
          createdAt: '2026-08-24T10:00:00.000Z',
          updatedAt: '2026-08-24T10:00:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    expect(adminService.assertChatAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      { userId: 'admin-1', username: null, displayName: null },
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId: 'chat-1',
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        },
        take: 51,
      }),
    );
  });

  it('uses a short-lived active-entry cache and invalidates it after revoke', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'entry-1' });
    const findMany = jest.fn().mockResolvedValue([row()]);
    const deleteEntry = jest.fn().mockResolvedValue(row());
    const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const delegate = { findFirst, findMany, delete: deleteEntry };
    const adminService = { assertChatAdminAccess: jest.fn().mockResolvedValue(undefined) };
    const prisma = {} as {
      karavanStorefrontAllowlistEntry: typeof delegate;
      auditLog: { create: typeof auditCreate };
      $transaction: (callback: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    };
    prisma.karavanStorefrontAllowlistEntry = delegate;
    prisma.auditLog = { create: auditCreate };
    prisma.$transaction = async (callback) => callback(prisma);
    const service = new KaravanStorefrontAllowlistService(prisma as never, adminService as never);

    await expect(service.isActive('chat-1', 'user-1')).resolves.toBe(true);
    await expect(service.isActive('chat-1', 'user-1')).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledTimes(1);

    await expect(service.revoke('chat-1', 'entry-1', actor)).resolves.toEqual({ revoked: true });
    expect(deleteEntry).toHaveBeenCalledWith({ where: { id: 'entry-1' } });
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'KARAVAN_STOREFRONT_ALLOWLIST_REVOKE',
          payload: expect.objectContaining({ entryId: 'entry-1', targetUserId: 'user-1' }),
        }),
      }),
    );
    await expect(service.isActive('chat-1', 'user-1')).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('never keeps a positive cache entry beyond the grant expiry', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce({ id: 'entry-1', expiresAt: new Date(1_100) })
      .mockResolvedValueOnce(null);
    const service = new KaravanStorefrontAllowlistService(
      { karavanStorefrontAllowlistEntry: { findFirst } } as never,
      { assertChatAdminAccess: jest.fn() } as never,
    );

    try {
      await expect(service.isActive('chat-1', 'user-1')).resolves.toBe(true);
      nowSpy.mockReturnValue(1_200);
      await expect(service.isActive('chat-1', 'user-1')).resolves.toBe(false);
      expect(findFirst).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('shares authorization decisions through Redis and invalidates the shared key on revoke', async () => {
    const shared = new Map<string, string>();
    const redis = {
      getString: jest.fn(async (key: string) => shared.get(key) ?? null),
      setStringWithTtl: jest.fn(async (key: string, value: string) => {
        shared.set(key, value);
      }),
      deleteKey: jest.fn(async (key: string) => {
        shared.delete(key);
        return 1;
      }),
    };
    const firstFindFirst = jest.fn().mockResolvedValue({ id: 'entry-1', expiresAt: null });
    const first = new KaravanStorefrontAllowlistService(
      { karavanStorefrontAllowlistEntry: { findFirst: firstFindFirst } } as never,
      { assertChatAdminAccess: jest.fn() } as never,
      redis as never,
    );
    await expect(first.isActive('chat-1', 'user-1')).resolves.toBe(true);
    expect(redis.setStringWithTtl).toHaveBeenCalledTimes(1);

    const secondFindFirst = jest.fn();
    const second = new KaravanStorefrontAllowlistService(
      { karavanStorefrontAllowlistEntry: { findFirst: secondFindFirst } } as never,
      { assertChatAdminAccess: jest.fn() } as never,
      redis as never,
    );
    await expect(second.isActive('chat-1', 'user-1')).resolves.toBe(true);
    expect(secondFindFirst).not.toHaveBeenCalled();

    const deleteEntry = jest.fn().mockResolvedValue({ userId: 'user-1' });
    const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const prisma = {
      karavanStorefrontAllowlistEntry: {
        findMany: jest.fn().mockResolvedValue([row()]),
        delete: deleteEntry,
      },
      auditLog: { create: auditCreate },
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    } as never;
    const revoker = new KaravanStorefrontAllowlistService(
      prisma,
      { assertChatAdminAccess: jest.fn().mockResolvedValue(undefined) } as never,
      redis as never,
    );
    await revoker.revoke('chat-1', 'entry-1', actor);
    expect(redis.deleteKey).toHaveBeenCalledWith(
      'karavan-storefront-allowlist:v1:chat-1:user-1',
    );
  });

  it('upserts with bounded fields and records a bounded audit payload in one transaction', async () => {
    const upsert = jest.fn().mockResolvedValue(row({ id: 'entry-2', userId: 'user-2' }));
    const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-2' });
    const prisma = {} as {
      karavanStorefrontAllowlistEntry: { upsert: typeof upsert };
      auditLog: { create: typeof auditCreate };
      $transaction: (callback: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    };
    prisma.karavanStorefrontAllowlistEntry = { upsert };
    prisma.auditLog = { create: auditCreate };
    prisma.$transaction = async (callback) => callback(prisma);
    const adminService = { assertChatAdminAccess: jest.fn() };
    const service = new KaravanStorefrontAllowlistService(prisma as never, adminService as never);
    const expiresAt = new Date(Date.now() + 86_400_000);

    await service.upsert({
      chatId: 'chat-1',
      userId: 'user-2',
      displayName: 'x'.repeat(400),
      expiresAt,
      createdByUserId: 'admin-1',
      sourceMessageId: 'source-1',
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId_userId: { chatId: 'chat-1', userId: 'user-2' } },
        create: expect.objectContaining({ displayName: 'x'.repeat(256) }),
      }),
    );
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'KARAVAN_STOREFRONT_ALLOWLIST_ADD',
          payload: expect.objectContaining({ targetUserId: 'user-2', sourceMessageId: 'source-1' }),
        }),
      }),
    );
  });
});
