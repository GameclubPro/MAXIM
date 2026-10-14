import { PublisherSelectedAccessService } from './publisher-selected-access.service';

describe('durable selected Publisher access', () => {
  const user = {
    userId: 'alice',
    username: null,
    displayName: null,
    accessCheckedAfter: Date.now(),
  };
  const old = {
    entityType: 'CHAT',
    state: 'GRANTED',
    userRole: 'ADMIN',
    checkedAt: new Date(0),
    expiresAt: new Date(0),
    lastAdminConfirmedAt: new Date(0),
  };
  function fixture() {
    const read = jest.fn().mockResolvedValue(old);
    const service = new PublisherSelectedAccessService(
      { managedEntityAccessEdge: { findUnique: read } } as never,
      { getPublisherBotDescriptor: () => ({ id: 'publik' }) } as never,
    );
    return { read, service };
  }

  it.each(['ADMIN', 'OWNER'])(
    'preserves an expired %s grant across launches without MAX or Redis',
    async (userRole) => {
      const f = fixture();
      f.read.mockResolvedValue({ ...old, userRole });
      await f.service.assertAccess(user, '-1', 'chat');
      await f.service.assertAccess(
        { ...user, accessCheckedAfter: Date.now() + 1000 },
        '-1',
        'chat',
      );
      expect(f.read).toHaveBeenCalledWith({
        where: { chatId_userId_botId: { chatId: '-1', userId: 'alice', botId: 'publik' } },
        select: { entityType: true, state: true, userRole: true },
      });
    },
  );

  it.each([
    null,
    { ...old, entityType: 'CHANNEL' },
    { ...old, userRole: 'MEMBER' },
    { ...old, state: 'USER_DENIED' },
    { ...old, state: 'BOT_DENIED' },
  ])(
    'refuses missing, mismatched or explicitly denied authority, regardless of historical grant',
    async (edge) => {
      const f = fixture();
      f.read.mockResolvedValue(edge);
      await expect(f.service.assertAccess(user, '-1', 'chat')).rejects.toMatchObject({
        status: 403,
      });
    },
  );

  it('observes explicit revocation on the next operation and never mutates the retained edge', async () => {
    const f = fixture();
    await f.service.assertAccess(user, '-1', 'chat');
    f.read.mockResolvedValue({ ...old, state: 'USER_DENIED' });
    await expect(f.service.assertAccess(user, '-1', 'chat')).rejects.toMatchObject({ status: 403 });
  });

  it('does not convert an unavailable database into a grant or denial', async () => {
    const f = fixture();
    const error = new Error('database unavailable');
    f.read.mockRejectedValue(error);
    await expect(f.service.assertAccess(user, '-1', 'chat')).rejects.toBe(error);
  });
});
