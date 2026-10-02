import { ChatContextLocalCache } from './chat-context-local-cache';
import type { ChatContext } from './chat-context-cache.service';

const context = (chatId: string, text = '') =>
  ({ chatId, title: text, settings: { botSpeechMedia: { text } } }) as unknown as ChatContext;

function createCache(
  overrides: Partial<ConstructorParameters<typeof ChatContextLocalCache>[0]> = {},
) {
  return new ChatContextLocalCache({
    ttlMs: 100,
    maxEntries: 3,
    maxBytes: 10_000,
    maxEntryBytes: 5000,
    sweepBatchSize: 2,
    now: () => 0,
    ...overrides,
  });
}

describe('ChatContextLocalCache retained memory boundaries', () => {
  it('evicts the least recently read entry when the entry cap is reached', () => {
    const cache = createCache();
    for (const key of ['a', 'b', 'c']) cache.set(key, context(key));
    expect(cache.get('a')?.chatId).toBe('a');
    cache.set('d', context('d'));
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')?.chatId).toBe('a');
    expect(cache.snapshot()).toMatchObject({ entries: 3, capacityEvictions: 1 });
  });

  it('bounds estimated retained bytes independently of the entry cap', () => {
    const cache = createCache({ maxEntries: 100, maxBytes: 1800 });
    for (const key of ['a', 'b', 'c', 'd']) cache.set(key, context(key, 'x'.repeat(100)));
    expect(cache.snapshot().estimatedBytes).toBeLessThanOrEqual(1800);
    expect(cache.snapshot().entries).toBeLessThan(4);
    expect(cache.get('d')?.chatId).toBe('d');
    expect(cache.get('a')).toBeNull();
  });

  it('does not evict hot entries to admit an oversized context', () => {
    const cache = createCache({ maxEntryBytes: 1500 });
    cache.set('hot', context('hot'));
    cache.set('oversized', context('oversized', 'x'.repeat(2000)));
    expect(cache.get('hot')?.chatId).toBe('hot');
    expect(cache.get('oversized')).toBeNull();
    expect(cache.snapshot()).toMatchObject({ entries: 1, oversizedSkips: 1, capacityEvictions: 0 });
  });

  it('removes a former cached value when its replacement exceeds the byte cap', () => {
    const cache = createCache({ maxEntryBytes: 1500 });
    cache.set('chat', context('chat', 'old'));
    cache.set('chat', context('chat', 'x'.repeat(2000)));
    expect(cache.get('chat')).toBeNull();
    expect(cache.snapshot()).toMatchObject({ entries: 0, estimatedBytes: 0, oversizedSkips: 1 });
  });

  it('releases overwritten and invalidated weights without double subtraction', () => {
    const cache = createCache();
    cache.set('chat', context('chat', 'x'.repeat(100)));
    cache.set('chat', context('chat'));
    expect(cache.snapshot().estimatedBytes).toBeGreaterThan(0);
    cache.delete('chat');
    cache.delete('chat');
    expect(cache.snapshot()).toMatchObject({ entries: 0, estimatedBytes: 0, invalidations: 1 });
  });

  it('sweeps cold expired entries in bounded batches and eventually reaches every entry', () => {
    let now = 0;
    const cache = createCache({ maxEntries: 10, now: () => now });
    for (const key of ['a', 'b', 'c', 'd', 'e']) cache.set(key, context(key));
    now = 100;
    cache.sweepExpired();
    expect(cache.snapshot()).toMatchObject({ entries: 3, expiredEvictions: 2, sweepInspected: 2 });
    cache.sweepExpired();
    expect(cache.snapshot()).toMatchObject({ entries: 1, expiredEvictions: 4, sweepInspected: 4 });
    cache.sweepExpired();
    expect(cache.snapshot()).toMatchObject({ entries: 0, estimatedBytes: 0, expiredEvictions: 5 });
  });

  it('eventually releases cold media while hot reads continuously reorder the LRU cache', () => {
    let now = 0;
    const cache = createCache({ now: () => now, sweepBatchSize: 1 });
    const hotA = context('hot-a');
    const hotB = context('hot-b');
    cache.set('hot-a', hotA);
    cache.set('hot-b', hotB);
    cache.set('cold', context('cold', 'media'.repeat(100)));
    for (now = 99; now <= 101; now += 1) {
      cache.set('hot-a', cache.get('hot-a')!);
      cache.set('hot-b', cache.get('hot-b')!);
      cache.sweepExpired();
    }
    expect(cache.snapshot()).toMatchObject({ entries: 2, expiredEvictions: 1, sweepInspected: 3 });
    expect(cache.get('hot-a')).toBe(hotA);
    expect(cache.get('hot-b')).toBe(hotB);
  });

  it('expires at the deadline and preserves the current sliding TTL refresh', () => {
    let now = 0;
    const cache = createCache({ now: () => now });
    const value = context('chat');
    cache.set('chat', value);
    now = 99;
    expect(cache.get('chat')).toBe(value);
    cache.set('chat', value);
    now = 100;
    cache.sweepExpired();
    expect(cache.get('chat')).toBe(value);
    now = 199;
    expect(cache.get('chat')).toBeNull();
    expect(cache.snapshot()).toMatchObject({ estimatedBytes: 0, expiredEvictions: 1 });
  });

  it('reuses the encoded size from Redis and on local hits without serializing media again', () => {
    const cache = createCache();
    const value = context('chat', 'media');
    const encodedBytes = Buffer.byteLength(JSON.stringify(value));
    const stringify = jest.spyOn(JSON, 'stringify');
    try {
      cache.set('chat', value, encodedBytes);
      cache.set('chat', cache.get('chat')!);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it('reports only fixed scalar fields and returns an independent snapshot', () => {
    const cache = createCache();
    cache.set('private-chat', context('private-chat', 'private-media'));
    const snapshot = cache.snapshot();
    snapshot.estimatedBytes = 0;
    expect(cache.snapshot().estimatedBytes).toBeGreaterThan(0);
    expect(Object.values(snapshot).every((value) => typeof value === 'number')).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/private-chat|private-media/u);
    cache.clear();
    expect(cache.snapshot()).toMatchObject({ entries: 0, estimatedBytes: 0 });
  });
});
