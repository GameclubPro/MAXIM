import { PublisherEntitiesCursorStore } from './publisher-entities-cursor.store';

describe('PublisherEntitiesCursorStore', () => {
  const summary = { total: 3, chat: 3, channel: 0, ready: 1, attention: 2 };

  function scope(userId = 'admin-1', query = '') {
    return {
      userId,
      query,
      entityType: null,
      readiness: null,
    } as const;
  }

  function snapshot(userId = 'admin-1', query = '', count = 3) {
    return {
      ...scope(userId, query),
      filteredTotal: count,
      summary: { ...summary, total: count, chat: count, attention: Math.max(0, count - 1) },
      items: Array.from({ length: count }, (_, index) => ({
        id: `${userId}-${query || 'all'}-${index}`,
        entityType: 'chat' as const,
      })),
    };
  }

  it('binds a short-lived snapshot to the exact user and filters', () => {
    const store = new PublisherEntitiesCursorStore({ ttlMs: 900_000, reuseMs: 15_000 });
    const created = store.createOrReuse(snapshot(), 1_000);

    expect(created).toMatchObject({ reused: false });
    expect(store.read(created?.snapshotId ?? '', scope(), 1_001)).toMatchObject(snapshot());
    expect(store.read(created?.snapshotId ?? '', scope('admin-2'), 1_001)).toBeNull();
    expect(store.read(created?.snapshotId ?? '', scope('admin-1', 'другой'), 1_001)).toBeNull();
    expect(store.read(created?.snapshotId ?? '', scope(), 901_002)).toBeNull();
  });

  it('reuses an identical fresh scope without allocating another snapshot', () => {
    const store = new PublisherEntitiesCursorStore({ reuseMs: 15_000 });
    const first = store.createOrReuse(snapshot(), 1_000);
    const second = store.createOrReuse(snapshot(), 1_001);

    expect(second).toMatchObject({ snapshotId: first?.snapshotId, reused: true });
    expect(store.findReusable(scope(), 15_999)?.snapshotId).toBe(first?.snapshotId);
    expect(store.findReusable(scope(), 16_000)).toBeNull();
  });

  it('applies per-user fairness before global eviction', () => {
    const store = new PublisherEntitiesCursorStore({
      reuseMs: 0,
      maxEntries: 3,
      maxItems: 30,
      maxEntriesPerUser: 1,
      maxItemsPerUser: 10,
    });
    const victim = store.createOrReuse(snapshot('victim', 'all', 2), 1_000);
    const noisyFirst = store.createOrReuse(snapshot('noisy', 'first', 2), 1_001);
    const noisySecond = store.createOrReuse(snapshot('noisy', 'second', 2), 1_002);

    expect(store.read(victim?.snapshotId ?? '', scope('victim', 'all'), 1_003)).not.toBeNull();
    expect(store.read(noisyFirst?.snapshotId ?? '', scope('noisy', 'first'), 1_003)).toBeNull();
    expect(
      store.read(noisySecond?.snapshotId ?? '', scope('noisy', 'second'), 1_003),
    ).not.toBeNull();
  });

  it('evicts the globally least-recently-used snapshot within hard bounds', () => {
    const store = new PublisherEntitiesCursorStore({
      reuseMs: 0,
      maxEntries: 2,
      maxItems: 10,
      maxEntriesPerUser: 2,
      maxItemsPerUser: 10,
    });
    const first = store.createOrReuse(snapshot('admin-1', 'first', 2), 1_000);
    const second = store.createOrReuse(snapshot('admin-2', 'second', 2), 1_001);
    store.read(first?.snapshotId ?? '', scope('admin-1', 'first'), 1_002);
    const third = store.createOrReuse(snapshot('admin-3', 'third', 2), 1_003);

    expect(store.read(first?.snapshotId ?? '', scope('admin-1', 'first'), 1_004)).not.toBeNull();
    expect(store.read(second?.snapshotId ?? '', scope('admin-2', 'second'), 1_004)).toBeNull();
    expect(store.read(third?.snapshotId ?? '', scope('admin-3', 'third'), 1_004)).not.toBeNull();
  });

  it('deletes a completed snapshot and releases its scope for a fresh one', () => {
    const store = new PublisherEntitiesCursorStore();
    const first = store.createOrReuse(snapshot(), 1_000);

    expect(store.complete(first?.snapshotId ?? '', scope('admin-2'))).toBe(false);
    expect(store.complete(first?.snapshotId ?? '', scope())).toBe(true);
    expect(store.read(first?.snapshotId ?? '', scope(), 1_001)).toBeNull();

    const replacement = store.createOrReuse(snapshot(), 1_002);
    expect(replacement?.snapshotId).not.toBe(first?.snapshotId);
    expect(replacement).toMatchObject({ reused: false });
  });

  it('rejects a single snapshot that cannot fit the per-user item bound', () => {
    const store = new PublisherEntitiesCursorStore({ maxItems: 10, maxItemsPerUser: 2 });

    expect(store.createOrReuse(snapshot('admin-1', '', 3), 1_000)).toBeNull();
  });
});
