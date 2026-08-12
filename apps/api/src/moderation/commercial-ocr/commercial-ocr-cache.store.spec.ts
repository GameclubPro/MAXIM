import {
  COMMERCIAL_OCR_CACHE_SCHEMA_VERSION,
  CommercialOcrCacheStore,
  type CommercialOcrCacheValue,
} from './commercial-ocr-cache.store';

type RedisMock = {
  status: string;
  disconnect: jest.Mock;
  set: jest.Mock;
  eval: jest.Mock;
  quit: jest.Mock;
};

const identity = {
  contentSha256: 'a'.repeat(64),
  ocrVersion: 'tesseract-rus-eng-v1',
  pass: 'primary' as const,
  preprocessProfile: 'gray-bounded-v2',
  psm: 6 as const,
};
const recognized: CommercialOcrCacheValue = {
  schemaVersion: COMMERCIAL_OCR_CACHE_SCHEMA_VERSION,
  status: 'recognized',
  text: 'Ремонт окон звоните',
  confidencePermille: 923,
  words: [
    { text: 'Ремонт', start: 0, end: 6, confidencePermille: 940 },
    { text: 'окон', start: 7, end: 11, confidencePermille: 920 },
    { text: 'звоните', start: 12, end: 19, confidencePermille: 910 },
  ],
};

function createStore() {
  const redis: RedisMock = {
    status: 'ready',
    disconnect: jest.fn(),
    set: jest.fn(),
    eval: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
  };
  const store = Object.create(CommercialOcrCacheStore.prototype) as CommercialOcrCacheStore;
  Object.defineProperties(store, {
    redis: { value: redis },
    logger: { value: { warn: jest.fn() } },
    localEntries: { value: new Map() },
    expiryTimer: { value: null, writable: true },
    expiryTimerDueAtMs: { value: null, writable: true },
    destroyed: { value: false, writable: true },
  });
  return { redis, store };
}

describe('CommercialOcrCacheStore', () => {
  it('reads a compact exact result from an opaque process-local key', async () => {
    const { redis, store } = createStore();

    await store.write(identity, recognized, 3_600);

    await expect(store.read(identity)).resolves.toEqual({ kind: 'hit', value: recognized });

    const keys = [...((store as any).localEntries as Map<string, unknown>).keys()];
    expect(keys).toHaveLength(1);
    const key = keys[0]!;
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
    expect(key).not.toContain(identity.contentSha256);
    expect(key).not.toContain(identity.ocrVersion);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('isolates cache entries by pass, preprocessing profile, and PSM', async () => {
    const { store } = createStore();

    await store.write(identity, recognized, 60);
    await store.write(
      {
        ...identity,
        pass: 'confirmation',
        preprocessProfile: 'normalized-threshold160-v2',
        psm: 11,
      },
      recognized,
      60,
    );

    expect((store as any).localEntries.size).toBe(2);
  });

  it('treats absent or expired process-local cache data as a miss', async () => {
    const { store } = createStore();
    await expect(store.read(identity)).resolves.toEqual({ kind: 'miss' });
    await store.write(identity, recognized, 60);
    const entry = [...((store as any).localEntries as Map<string, any>).values()][0]!;
    entry.expiresAtMs = 0;
    await expect(store.read(identity)).resolves.toEqual({ kind: 'miss' });
    expect((store as any).localEntries.size).toBe(0);
  });

  it('purges recognized text at its TTL without another cache read', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-12T12:00:00.000Z') });
    try {
      const { store } = createStore();
      await store.write(identity, recognized, 1);

      expect((store as any).localEntries.size).toBe(1);
      expect(jest.getTimerCount()).toBe(1);

      jest.advanceTimersByTime(999);
      expect((store as any).localEntries.size).toBe(1);
      jest.advanceTimersByTime(1);
      expect((store as any).localEntries.size).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the local expiry timer and OCR text during shutdown', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-12T12:00:00.000Z') });
    try {
      const { redis, store } = createStore();
      await store.write(identity, recognized, 60);

      await store.onModuleDestroy();

      expect((store as any).localEntries.size).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
      expect(redis.quit).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('caches recognized and no-text results with an explicit TTL', async () => {
    const { redis, store } = createStore();
    redis.set.mockResolvedValue('OK');

    await expect(store.write(identity, recognized, 3_600)).resolves.toBe(true);
    await expect(
      store.write(
        identity,
        {
          schemaVersion: COMMERCIAL_OCR_CACHE_SCHEMA_VERSION,
          status: 'no_text',
          text: '',
          confidencePermille: 0,
          words: [],
        },
        600,
      ),
    ).resolves.toBe(true);

    expect((store as any).localEntries.size).toBe(1);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('rejects inconsistent or oversized cache values before Redis', async () => {
    const { redis, store } = createStore();

    await expect(store.write(identity, { ...recognized, status: 'no_text' }, 60)).rejects.toThrow(
      'does not match',
    );
    await expect(
      store.write(identity, { ...recognized, text: 'x'.repeat(8_001) }, 60),
    ).rejects.toThrow('text is invalid');
    await expect(
      store.write(
        identity,
        {
          schemaVersion: COMMERCIAL_OCR_CACHE_SCHEMA_VERSION,
          status: 'recognized',
          text: 'aaaa',
          confidencePermille: 900,
          words: [
            { text: 'aaa', start: 0, end: 3, confidencePermille: 900 },
            { text: 'aa', start: 2, end: 4, confidencePermille: 900 },
          ],
        },
        60,
      ),
    ).rejects.toThrow('word ordering is invalid');
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('uses a bounded NX lease for singleflight', async () => {
    const { redis, store } = createStore();
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    const acquired = await store.claimSingleflight(identity, 15_000);
    await expect(store.claimSingleflight(identity, 15_000)).resolves.toEqual({ kind: 'busy' });

    expect(acquired).toEqual({ kind: 'acquired', token: expect.any(String) });
    expect(redis.set.mock.calls[0]!.slice(2)).toEqual(['PX', 15_000, 'NX']);
    expect(String(redis.set.mock.calls[0]![0])).toMatch(
      /^commercial-ocr:singleflight:v3:[a-f0-9]{64}$/u,
    );
  });

  it('rejects invalid TTLs before Redis instead of disguising configuration errors', async () => {
    const { redis, store } = createStore();

    await expect(store.write(identity, recognized, 0)).rejects.toThrow('cache TTL is invalid');
    await expect(store.claimSingleflight(identity, 999)).rejects.toThrow(
      'singleflight TTL is invalid',
    );
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('commits a cache result only while holding the matching lease', async () => {
    const { redis, store } = createStore();
    redis.eval.mockResolvedValue(1);
    const token = '12345678-1234-1234-1234-123456789abc';

    await expect(
      store.commitSingleflight({ identity, token, value: recognized, ttlSeconds: 3_600 }),
    ).resolves.toBe(true);

    const call = redis.eval.mock.calls[0] as unknown[];
    expect(call[1]).toBe(1);
    expect(call[3]).toBe(token);
    expect(String(call[0])).toContain("redis.call('GET', KEYS[1]) ~= ARGV[1]");
    expect(String(call[0])).toContain("redis.call('DEL', KEYS[1])");
    expect(JSON.stringify(call)).not.toContain(recognized.text);
    await expect(store.read(identity)).resolves.toEqual({ kind: 'hit', value: recognized });
  });

  it('releases a lease through a token fence and fails open on Redis errors', async () => {
    const { redis, store } = createStore();
    redis.eval.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('redis unavailable'));
    const token = '12345678-1234-1234-1234-123456789abc';

    await expect(store.releaseSingleflight(identity, token)).resolves.toBe(true);
    await expect(store.releaseSingleflight(identity, token)).resolves.toBe(false);
    expect(String(redis.eval.mock.calls[0]![0])).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
  });

  it('keeps exact caching local when Redis is unavailable', async () => {
    const { redis, store } = createStore();
    redis.set.mockRejectedValue(new Error('redis unavailable'));

    await expect(store.read(identity)).resolves.toEqual({ kind: 'miss' });
    await expect(store.write(identity, recognized, 60)).resolves.toBe(true);
    await expect(store.read(identity)).resolves.toEqual({ kind: 'hit', value: recognized });
    await expect(store.claimSingleflight(identity, 15_000)).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});
