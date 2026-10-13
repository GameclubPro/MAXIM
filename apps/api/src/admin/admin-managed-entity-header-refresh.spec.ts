import type { ChatSummary } from '@maxim/contracts';
import { AdminService } from './admin.service';
import {
  createAssignedBotFixture,
  createChatContextCacheMock,
  createChatSummaryFixture,
  createConfigMock,
  createPrismaMock,
} from './admin-service-test-support';
import {
  hydrateManagedEntityHeaders,
  publishManagedEntityHeaderChanges,
} from './admin-managed-entity-header-refresh';

const summary = (id = 'chat-1') =>
  createChatSummaryFixture({
    id,
    title: `Chat ${id}`,
    entityType: 'chat',
    primaryBotId: '777000_bot',
    createdAt: '2026-10-01T00:00:00.000Z',
  });
const published = (items: ChatSummary[] = [summary()]) => ({
  version: 'before',
  builtAt: '2026-10-01T00:00:00.000Z',
  lastSyncedAt: null,
  itemCount: items.length,
  itemsHash: 'before',
  items,
});
const snapshot = {
  chatId: 'chat-1',
  title: 'Название чата',
  avatarUrl: 'https://i.oneme.ru/new.webp',
  link: null,
  participantsCount: 10,
  entityType: 'chat',
  status: 'active',
  isPublic: false,
  lastEventAt: null,
} as const;

describe('managed entity header refresh', () => {
  it('returns a new snapshot version after cached metadata replaces an ID, including on a sinceVersion refresh', async () => {
    let stored = published();
    const cache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn(async () => stored),
      setManagedEntitiesPublishedSnapshot: jest.fn(async (_userId, _type, next) => {
        stored = next;
        return true;
      }),
      getManagedEntityHeader: jest.fn(async () => ({ ...snapshot, id: 'chat-1' })),
    });
    const max = { getChatSnapshot: jest.fn() };
    const service = new AdminService(
      createPrismaMock() as never,
      max as never,
      cache as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service as never, 'scheduleManagedEntitiesBoundedRefresh' as never)
      .mockResolvedValue({ complete: true, userVisibleComplete: true } as never);
    const response = await service.listChatsWithRefreshState(
      { userId: 'admin-1', username: null, displayName: null, chatTitle: null },
      { refresh: true, sinceVersion: 'before' },
    );
    expect(response.snapshot?.version).not.toBe('before');
    expect(response.diff?.mode).not.toBe('noop');
    expect(response.diff).toMatchObject({
      mode: 'patch',
      baseVersion: 'before',
      updated: [expect.objectContaining({ title: snapshot.title, avatarUrl: snapshot.avatarUrl })],
    });
    expect(max.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('does not let eight chats without an icon starve the ninth chat', async () => {
    const admitted = new Set<string>();
    const cache = {
      getManagedEntityHeader: jest.fn(async (id: string) => ({ id, title: id, avatarUrl: null })),
      claimManagedEntityHeaderRefresh: jest.fn(async (id: string) => {
        if (admitted.has(id)) return false;
        admitted.add(id);
        return true;
      }),
    };
    const maxClient = { getChatSnapshot: jest.fn(async () => ({ ...snapshot, avatarUrl: null })) };
    const params = {
      chats: Array.from({ length: 9 }, (_, index) => summary(`chat-${index}`)),
      cache: cache as never,
      maxClient,
      persist: jest.fn(),
    };
    await hydrateManagedEntityHeaders(params);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(8);
    await hydrateManagedEntityHeaders(params);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(9);
    expect(maxClient.getChatSnapshot).toHaveBeenLastCalledWith(
      'chat-8',
      expect.objectContaining({ timeoutMs: 2500, bypassCache: true, trafficClass: 'background' }),
    );
  });

  it('reads through an active standby after the assigned primary denies metadata access', async () => {
    const chat = {
      ...summary(),
      assignedBots: [
        createAssignedBotFixture({ botId: '777000_bot' }),
        createAssignedBotFixture({ botId: 'standby', role: 'standby' }),
      ],
    };
    const maxClient = {
      getChatSnapshot: jest
        .fn()
        .mockRejectedValueOnce({ response: { status: 404, data: { code: 'chat.not.found' } } })
        .mockResolvedValue(snapshot),
    };
    const persist = jest.fn();
    await hydrateManagedEntityHeaders({
      chats: [chat],
      cache: {
        getManagedEntityHeader: jest.fn(),
        claimManagedEntityHeaderRefresh: jest.fn().mockResolvedValue(true),
      } as never,
      maxClient,
      persist,
    });
    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatSnapshot).toHaveBeenLastCalledWith(
      chat.id,
      expect.objectContaining({ botId: 'standby' }),
    );
    expect(persist).toHaveBeenCalledWith(chat, snapshot);
  });

  it('does not read metadata through dormant assignments', async () => {
    const chat = {
      ...summary(),
      assignedBots: [
        createAssignedBotFixture({ botId: '777000_bot', membershipStatus: 'removed' }),
      ],
    };
    const maxClient = { getChatSnapshot: jest.fn() };
    await hydrateManagedEntityHeaders({
      chats: [chat],
      cache: { getManagedEntityHeader: jest.fn() } as never,
      maxClient,
      persist: jest.fn(),
    });
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('stops the batch on throttling without persisting guessed metadata', async () => {
    const error = { response: { status: 429 } };
    const maxClient = { getChatSnapshot: jest.fn().mockRejectedValue(error) };
    const persist = jest.fn();
    expect(
      await hydrateManagedEntityHeaders({
        chats: [summary(), summary('chat-2')],
        cache: { getManagedEntityHeader: jest.fn() } as never,
        maxClient,
        persist,
      }),
    ).toBe(error);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
  });

  it('publishes only title, avatar and link, preserving order and access assignments', async () => {
    const old = published([summary(), summary('chat-2')]);
    const cache = {
      setManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(true),
      setManagedEntitiesPublishedDiff: jest.fn(),
    };
    const result = await publishManagedEntityHeaderChanges({
      cache: cache as never,
      userId: 'admin-1',
      entityType: 'chat',
      snapshot: old,
      visibleItems: [
        { ...summary(), ...snapshot, primaryBotId: 'unrelated', assignedBots: [] },
        summary('not-in-snapshot'),
      ],
      writeDiff: true,
    });
    expect(result?.items.map((item) => item.id)).toEqual(['chat-1', 'chat-2']);
    expect(result?.items[0]).toMatchObject({
      title: snapshot.title,
      avatarUrl: snapshot.avatarUrl,
      primaryBotId: '777000_bot',
    });
    expect(result?.version).not.toBe(old.version);
    expect(cache.setManagedEntitiesPublishedDiff).toHaveBeenCalledTimes(1);
  });

  it('never recreates a snapshot after a concurrent removal wins the CAS', async () => {
    const cache = {
      setManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(false),
      setManagedEntitiesPublishedDiff: jest.fn(),
    };
    const result = await publishManagedEntityHeaderChanges({
      cache: cache as never,
      userId: 'admin-1',
      entityType: 'chat',
      snapshot: published(),
      visibleItems: [{ ...summary(), ...snapshot }],
      writeDiff: true,
    });
    expect(result).toBeNull();
    expect(cache.setManagedEntitiesPublishedSnapshot).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      expect.any(Object),
      expect.any(Number),
      { expectedVersion: 'before' },
    );
    expect(cache.setManagedEntitiesPublishedDiff).not.toHaveBeenCalled();
  });
});
