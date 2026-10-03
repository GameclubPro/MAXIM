import type { ChatSummary } from '@maxim/contracts';
import { AdminManagedEntitiesSnapshotRuntime } from './admin-managed-entities-snapshot-runtime';
import type { ManagedEntityTypeFilter } from './admin.service.support';
import {
  createAssignedBotFixture,
  createChatSummaryFixture,
  createDeferred,
} from './admin-service-test-support';
import {
  MANAGED_ENTITIES_ALLOWLIST_CACHE_TTL_MS,
  MANAGED_ENTITIES_LAST_SUCCESS_SNAPSHOT_TTL_MS,
} from './admin.service.support';

function chat(id: string, entityType: 'chat' | 'channel' = 'chat') {
  return createChatSummaryFixture({ id, title: id, entityType, createdAt: '2026-10-03T12:00:00Z' });
}

function fixture() {
  const load = jest
    .fn<Promise<ChatSummary[]>, [string, ManagedEntityTypeFilter]>()
    .mockResolvedValue([]);
  const filter = jest.fn((items: readonly ChatSummary[]) => [...items]);
  const runtime = new AdminManagedEntitiesSnapshotRuntime({
    loadAllowlist: load,
    filterToRuntimeScope: filter,
  });
  return {
    load,
    filter,
    remember: runtime['rememberManagedEntitiesLastSuccessChats'].bind(runtime),
    read: runtime['readManagedEntitiesLastSuccessSnapshot'].bind(runtime),
    forget: runtime['forgetManagedEntitiesLastSuccessChat'].bind(runtime),
    invalidate: runtime['invalidateManagedEntitiesAllowlistCache'].bind(runtime),
    list: runtime['listChatsFromAllowlist'].bind(runtime),
  };
}

describe('managed entities snapshot ownership', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-03T12:00:00Z')));
  afterEach(() => jest.useRealTimers());

  it('merges new summaries first without dropping old entities or crossing actor/type boundaries', () => {
    const { remember, read } = fixture();
    remember('a', [chat('one'), chat('channel', 'channel')]);
    remember('b', [chat('other')]);
    remember('a', [{ ...chat('one'), title: 'updated' }, chat('two')]);
    expect(read('a', 'all').map(({ id, title }) => [id, title])).toEqual([
      ['one', 'updated'],
      ['two', 'two'],
      ['channel', 'channel'],
    ]);
    expect(read('a', 'chat').map(({ id }) => id)).toEqual(['one', 'two']);
    expect(read('a', 'channel').map(({ id }) => id)).toEqual(['channel']);
    expect(read('b', 'all').map(({ id }) => id)).toEqual(['other']);
  });

  it('isolates mutable summary values on write and read and reapplies runtime scope', () => {
    const { remember, read, filter } = fixture();
    const original = {
      ...chat('one'),
      assignedBots: [createAssignedBotFixture({ botId: 'major' })],
    };
    remember('a', [original, chat('publisher')]);
    original.title = 'mutated';
    original.assignedBots[0].label = 'mutated';
    filter.mockImplementation((items: readonly ChatSummary[]) =>
      items.filter(({ id }) => id !== 'publisher'),
    );
    const first = read('a', 'all');
    expect(first.map(({ id }) => id)).toEqual(['one']);
    expect(first[0].title).toBe('one');
    expect(first[0].assignedBots[0].label).toBe('major');
    first[0].title = 'changed result';
    first[0].assignedBots[0].label = 'changed result';
    expect(read('a', 'all')[0].title).toBe('one');
    expect(read('a', 'all')[0].assignedBots[0].label).toBe('major');
  });

  it('keeps snapshots through an empty refresh and expires them exactly at their TTL', () => {
    const { remember, read } = fixture();
    remember('a', [chat('one')]);
    jest.advanceTimersByTime(MANAGED_ENTITIES_LAST_SUCCESS_SNAPSHOT_TTL_MS - 1);
    remember('a', []);
    expect(read('a', 'all')).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(read('a', 'all')).toEqual([]);
    expect(read('a', 'chat')).toEqual([]);
  });

  it('forgets all actor-specific copies without extending expiry or changing another actor', () => {
    const { remember, read, forget } = fixture();
    remember('a', [chat('one'), chat('two')]);
    remember('ab', [chat('one')]);
    jest.advanceTimersByTime(MANAGED_ENTITIES_LAST_SUCCESS_SNAPSHOT_TTL_MS - 1);
    forget('a', 'one');
    expect(read('a', 'all').map(({ id }) => id)).toEqual(['two']);
    expect(read('a', 'chat').map(({ id }) => id)).toEqual(['two']);
    expect(read('ab', 'all')).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(read('a', 'all')).toEqual([]);
  });

  it('coalesces pending reads only within the same actor and entity type', async () => {
    const { load, list } = fixture();
    const pending = createDeferred<ChatSummary[]>();
    load.mockReturnValueOnce(pending.promise);
    const first = list('a', 'chat');
    const second = list('a', 'chat');
    await list('b', 'chat');
    await list('a', 'channel');
    expect(load).toHaveBeenCalledTimes(3);
    const result = [chat('one')];
    pending.resolve(result);
    expect(await first).toBe(result);
    expect(await second).toBe(result);
    jest.advanceTimersByTime(MANAGED_ENTITIES_ALLOWLIST_CACHE_TTL_MS);
    await list('a', 'chat');
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('evicts failed reads so a later request can retry', async () => {
    const { load, list } = fixture();
    load.mockRejectedValueOnce(new Error('unavailable'));
    await expect(list('a', 'chat')).rejects.toThrow('unavailable');
    await expect(list('a', 'chat')).resolves.toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not let a late rejection evict a replacement after actor-wide invalidation', async () => {
    const { load, list, invalidate } = fixture();
    const old = createDeferred<ChatSummary[]>();
    load.mockReturnValueOnce(old.promise);
    const outcome = expect(list('a', 'chat')).rejects.toThrow('old');
    await list('a', 'channel');
    await list('ab', 'chat');
    invalidate('a');
    await list('a', 'chat');
    await list('a', 'channel');
    old.reject(new Error('old'));
    await outcome;
    await list('a', 'chat');
    await list('ab', 'chat');
    expect(load).toHaveBeenCalledTimes(5);
  });
});
