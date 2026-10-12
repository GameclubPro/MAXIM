import { PublisherSelectedAccessService } from './publisher-selected-access.service';

describe('selected Publisher access', () => {
  const now = new Date('2026-10-13T01:00:05Z');
  const user = {
    userId: 'alice',
    username: null,
    displayName: null,
    accessCheckedAfter: +now - 5000,
  };
  const old = {
    entityType: 'CHAT',
    state: 'GRANTED',
    userRole: 'ADMIN',
    checkedAt: new Date(0),
    expiresAt: new Date(0),
    lastAdminConfirmedAt: new Date(0),
    sourceVersion: 'version',
  };
  function fixture() {
    const read = jest.fn().mockResolvedValue(old);
    const enqueue = jest.fn().mockResolvedValue('job');
    const service = new PublisherSelectedAccessService(
      { managedEntityAccessEdge: { findUnique: read } } as never,
      { getPublisherBotDescriptor: () => ({ id: 'publik' }) } as never,
      { enqueue } as never,
    );
    return { read, enqueue, service };
  }
  beforeEach(() => jest.useFakeTimers({ now }));
  afterEach(() => jest.useRealTimers());

  it('coalesces simultaneous screen reads into one exact-user/exact-chat probe', async () => {
    const f = fixture();
    f.read
      .mockResolvedValueOnce(old)
      .mockResolvedValue({ ...old, checkedAt: now, expiresAt: new Date(+now + 60_000) });
    const first = f.service.assertAccess(user, '-1', 'chat');
    const second = f.service.assertAccess(user, '-1', 'chat');
    await jest.advanceTimersByTimeAsync(100);
    await Promise.all([first, second]);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.enqueue).toHaveBeenCalledWith({
      chatId: '-1',
      publisherBotId: 'publik',
      candidateUserId: 'alice',
      candidateVersion: 'version',
      reason: 'selected_actor_access',
      requestedAt: new Date(user.accessCheckedAfter),
    });
    expect(f.read.mock.calls.every(([q]) => q.where.chatId_userId_botId.chatId === '-1')).toBe(
      true,
    );
  });

  it.each([
    null,
    { ...old, entityType: 'CHANNEL' },
    { ...old, state: 'UNKNOWN', lastAdminConfirmedAt: null },
  ])(
    'refuses missing or unconfirmed discovery without scheduling arbitrary MAX work',
    async (edge) => {
      const f = fixture();
      f.read.mockResolvedValue(edge);
      await expect(f.service.assertAccess(user, '-1', 'chat')).rejects.toMatchObject({
        status: 403,
      });
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );

  it('accepts a recent SQL proof without another request and requires a new launch boundary', async () => {
    const f = fixture();
    f.read.mockResolvedValue({ ...old, checkedAt: now, expiresAt: new Date(+now + 60_000) });
    await f.service.assertAccess(user, '-1', 'chat');
    expect(f.enqueue).not.toHaveBeenCalled();
    jest.setSystemTime(+now + 1000);
    f.enqueue.mockRejectedValue(new Error('Redis unavailable'));
    await expect(
      f.service.assertAccess({ ...user, accessCheckedAfter: +now + 1000 }, '-1', 'chat'),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('denies a fresh negative verdict without exposing settings', async () => {
    const f = fixture();
    f.read
      .mockResolvedValueOnce(old)
      .mockResolvedValue({ ...old, state: 'USER_DENIED', checkedAt: now });
    const work = expect(f.service.assertAccess(user, '-1', 'chat')).rejects.toMatchObject({
      status: 403,
    });
    await jest.advanceTimersByTimeAsync(100);
    await work;
  });

  it('fails closed after bounded waits and releases the in-flight slot for retry', async () => {
    const f = fixture();
    const work = expect(f.service.assertAccess(user, '-1', 'chat')).rejects.toMatchObject({
      status: 503,
    });
    await jest.advanceTimersByTimeAsync(5500);
    await work;
    expect(f.read).toHaveBeenCalledTimes(8);
    f.read.mockResolvedValue({ ...old, checkedAt: new Date(), expiresAt: new Date(+now + 60_000) });
    await f.service.assertAccess(user, '-1', 'chat');
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
});
