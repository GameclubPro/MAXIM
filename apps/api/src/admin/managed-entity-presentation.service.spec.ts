import { ManagedEntityPresentationService } from './managed-entity-presentation.service';

function fixture() {
  const visible = {
    chatId: 'chat-1',
    botId: 'bot-1',
    chat: {
      title: 'Chat chat-1',
      primaryBotId: 'bot-1',
      updatedAt: new Date(0),
      botMemberships: [{ botId: 'bot-1', botAccessState: 'CONFIRMED_ADMIN' }],
    },
  };
  const db = {
    managedEntityAccessEdge: { findMany: jest.fn().mockResolvedValue([visible]) },
    managedBotChatCatalog: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockRejectedValue({ code: 'P2002' }),
      findUnique: jest.fn().mockResolvedValue({
        title: 'Настоящее название',
        avatarUrl: 'https://i.oneme.ru/p.webp',
        link: null,
        status: 'ACTIVE',
      }),
    },
    chat: { updateMany: jest.fn(), findUnique: jest.fn().mockResolvedValue(null) },
  };
  const registry = {
    getAllBots: () => [{ id: 'bot-1', state: 'active' }],
    getBotById: () => ({ state: 'active' }),
  };
  const max = {
    getChatSnapshot: jest.fn().mockResolvedValue({
      chatId: 'chat-1',
      entityType: 'chat',
      title: 'Настоящее название',
      avatarUrl: 'https://i.oneme.ru/p.webp',
      avatarState: 'present',
    }),
  };
  const cache = { setManagedEntityHeader: jest.fn() };
  const queue = { getJob: jest.fn(), add: jest.fn() };
  return {
    db,
    max,
    cache,
    queue,
    service: new ManagedEntityPresentationService(
      db as never,
      registry as never,
      max as never,
      cache as never,
      queue as never,
    ),
  };
}
const user = { userId: 'admin', username: null, displayName: null };
const request = { entityType: 'chat', entityIds: ['chat-1'] };
const job = {
  userId: 'admin',
  entityType: 'chat' as const,
  bypassRemoteCache: false,
  resetRefreshCursor: false,
  presentationEntityId: 'chat-1',
};

describe('bounded home presentation', () => {
  it('returns navigation data immediately and admits durable metadata work without MAX rights checks', async () => {
    const f = fixture();
    expect(await f.service.read(user, request)).toMatchObject({
      items: [{ id: 'chat-1', title: null, pending: true }],
    });
    expect(f.max.getChatSnapshot).not.toHaveBeenCalled();
    expect(f.queue.add).toHaveBeenCalledWith(
      'refresh-presentation',
      expect.objectContaining(job),
      expect.objectContaining({ attempts: 3 }),
    );
    expect(f.db.managedEntityAccessEdge.findMany.mock.calls[0][0].where).not.toHaveProperty(
      'expiresAt',
    );
  });
  it('rejects oversized batches before SQL and does not reveal or enqueue unauthorized IDs', async () => {
    const f = fixture();
    await expect(
      f.service.read(user, { ...request, entityIds: Array(33).fill('chat-1') }),
    ).rejects.toThrow();
    expect(f.db.managedEntityAccessEdge.findMany).not.toHaveBeenCalled();
    f.db.managedEntityAccessEdge.findMany.mockResolvedValue([]);
    expect(await f.service.read(user, request)).toMatchObject({ items: [] });
    expect(f.queue.add).not.toHaveBeenCalled();
  });
  it('keeps a confirmed no-photo observation fresh without periodic probing', async () => {
    const f = fixture();
    f.db.managedBotChatCatalog.findMany.mockResolvedValue([
      {
        chatId: 'chat-1',
        botId: 'bot-1',
        title: 'Название',
        avatarState: 'absent',
        avatarUrl: null,
        metadataObservedAt: new Date(),
      },
    ]);
    expect(await f.service.read(user, request)).toMatchObject({
      items: [{ avatarState: 'absent', avatarUrl: null, pending: false }],
    });
    expect(f.queue.add).not.toHaveBeenCalled();
  });
  it('rechecks navigation access in the worker and retires a revoked demand without MAX calls', async () => {
    const f = fixture();
    f.db.managedEntityAccessEdge.findMany.mockResolvedValue([]);
    await f.service.process(job);
    expect(f.max.getChatSnapshot).not.toHaveBeenCalled();
  });
  it('persists metadata without changing status, activation or access freshness', async () => {
    const f = fixture();
    await f.service.process(job);
    const write = f.db.managedBotChatCatalog.updateMany.mock.calls[0][0];
    expect(write.data).toMatchObject({ title: 'Настоящее название', avatarState: 'present' });
    for (const key of ['status', 'source', 'lastSeenAt', 'firstSeenAt'])
      expect(write.data).not.toHaveProperty(key);
    expect(f.cache.setManagedEntityHeader).toHaveBeenCalled();
  });
  it('does not overwrite unknown photos or publish a stale SQL compare-and-swap loser', async () => {
    const f = fixture();
    f.max.getChatSnapshot.mockResolvedValue({
      chatId: 'chat-1',
      entityType: 'chat',
      title: null,
      avatarUrl: null,
      avatarState: 'unknown',
    });
    f.db.managedBotChatCatalog.updateMany.mockResolvedValue({ count: 0 });
    await f.service.process(job);
    const data = f.db.managedBotChatCatalog.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('avatarUrl');
    expect(data).not.toHaveProperty('avatarState');
    expect(f.cache.setManagedEntityHeader).not.toHaveBeenCalled();
    expect(f.db.chat.updateMany).not.toHaveBeenCalled();
  });
  it('creates only an inert presentation row when discovery has not stored a catalog row', async () => {
    const f = fixture();
    f.db.managedBotChatCatalog.updateMany.mockResolvedValue({ count: 0 });
    f.db.managedBotChatCatalog.create.mockResolvedValue({});
    await f.service.process(job);
    expect(f.db.managedBotChatCatalog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        botId: 'bot-1',
        chatId: 'chat-1',
        status: 'PRESENTATION',
        source: 'presentation',
      }),
    });
    expect(f.cache.setManagedEntityHeader).toHaveBeenCalled();
  });
  it('keeps a newer authoritative Chat rename over an older catalog response', async () => {
    const f = fixture();
    f.db.managedEntityAccessEdge.findMany.mockResolvedValue([
      {
        chatId: 'chat-1',
        botId: 'bot-1',
        chat: {
          title: 'Новое название',
          primaryBotId: 'bot-1',
          updatedAt: new Date(),
          botMemberships: [{ botId: 'bot-1', botAccessState: 'CONFIRMED_ADMIN' }],
        },
      },
    ]);
    f.db.managedBotChatCatalog.findMany.mockResolvedValue([
      {
        chatId: 'chat-1',
        botId: 'bot-1',
        title: 'Старое название',
        avatarState: 'absent',
        avatarUrl: null,
        metadataObservedAt: new Date(Date.now() - 1000),
      },
    ]);
    expect((await f.service.read(user, request)).items[0].title).toBe('Новое название');
  });
  it('ages waiting visible metadata ahead of ordinary discovery without creating a second job', async () => {
    const f = fixture();
    const changePriority = jest.fn();
    f.queue.getJob.mockResolvedValue({
      getState: async () => 'prioritized',
      timestamp: Date.now() - 31_000,
      opts: { priority: 10 },
      changePriority,
    });
    expect((await f.service.read(user, request)).items[0].pending).toBe(true);
    expect(changePriority).toHaveBeenCalledWith({ priority: 4 });
    expect(f.queue.add).not.toHaveBeenCalled();
  });
  it('lets queue retry a MAX timeout instead of declaring photo absence', async () => {
    const f = fixture();
    f.max.getChatSnapshot.mockRejectedValue(new Error('timeout'));
    await expect(f.service.process(job)).rejects.toThrow('timeout');
    expect(f.db.managedBotChatCatalog.updateMany).not.toHaveBeenCalled();
  });
});
