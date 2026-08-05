import type { PhotoAlbumFingerprint } from './photo-fingerprint';
import { PHOTO_FINGERPRINT_ALGORITHM_VERSION } from './photo-fingerprint';
import { PhotoDuplicateHistoryStore } from './photo-duplicate-history.store';

const clusterId = 'c'.repeat(64);
const albumHash = 'a'.repeat(64);

function createService(params: { evalResult?: unknown; recentRows?: string[]; evalError?: Error }) {
  const redis = {
    eval: params.evalError
      ? jest.fn().mockRejectedValue(params.evalError)
      : jest.fn().mockResolvedValue(params.evalResult ?? [1, 'new', clusterId, '', '', 0, '']),
    zrevrangebyscore: jest.fn().mockResolvedValue(params.recentRows ?? []),
    mget: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    quit: jest.fn(),
  };
  const service = Object.create(PhotoDuplicateHistoryStore.prototype) as PhotoDuplicateHistoryStore;
  Object.defineProperties(service, {
    redis: { value: redis },
    maxItems: { value: 250 },
    logger: { value: { warn: jest.fn() } },
  });
  return { redis, service };
}

function baseInput() {
  return {
    chatId: 'chat-secret-id',
    senderId: 'user-secret-id',
    messageId: 'message-secret-id',
    occurredAtMs: 1_800_000_000_000,
    ttlSeconds: 3_600,
    scope: 'CHAT' as const,
    fingerprintVersion: 'max-photo-id-album-v1',
    albumHash,
    exactMatchKind: 'platform_id' as const,
    commitViolation: true,
  };
}

function makeAlbum(
  pdqHash: string,
  canonicalHash: string,
  fingerprintAlbumHash = albumHash,
): PhotoAlbumFingerprint {
  return {
    algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
    albumHash: fingerprintAlbumHash,
    images: [
      {
        algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
        canonicalHash,
        pdqHash,
        pdqQuality: 80,
      },
    ],
  };
}

describe('PhotoDuplicateHistoryStore', () => {
  it('returns an inserted duplicate with the current-author repeat count', async () => {
    const { service } = createService({
      evalResult: [1, 'duplicate', clusterId, 'platform_id', '0', '2', 'previous-message'],
    });

    await expect(service.observeExactAlbum(baseInput())).resolves.toEqual({
      kind: 'available',
      inserted: true,
      replayed: false,
      classification: 'duplicate',
      clusterId,
      matchKind: 'platform_id',
      matchedDistance: 0,
      repeatCount: 2,
      duplicateOfMessageId: 'previous-message',
    });
  });

  it('marks a mirrored delivery as replayed without incrementing again', async () => {
    const { redis, service } = createService({
      evalResult: [2, 'duplicate', clusterId, 'platform_id', '0', '1', 'previous-message'],
    });

    await expect(service.observeExactAlbum(baseInput())).resolves.toMatchObject({
      inserted: false,
      replayed: true,
      classification: 'duplicate',
      repeatCount: 1,
    });
    const script = String(redis.eval.mock.calls[0]?.[0] ?? '');
    expect(script.indexOf("redis.call('HGET', KEYS[1], 'classification')")).toBeLessThan(
      script.indexOf("redis.call('ZADD'"),
    );
    expect(script.indexOf("redis.call('HGET', KEYS[1], 'classification')")).toBeLessThan(
      script.indexOf("redis.call('HINCRBY'"),
    );
    expect(script).toContain("redis.call('HDEL', KEYS[4], cluster_id)");
    expect(script).toContain("redis.call('HLEN', KEYS[4])");
    expect(script).toContain("redis.call('HKEYS', KEYS[4])");
  });

  it('does not expose chat or author identifiers in Redis keys', async () => {
    const { redis, service } = createService({});

    await service.observeExactAlbum(baseInput());

    const keys = redis.eval.mock.calls[0]?.slice(2, 6).map(String) ?? [];
    expect(keys.join('|')).not.toContain('chat-secret-id');
    expect(keys.join('|')).not.toContain('user-secret-id');
    expect(keys.join('|')).not.toContain('message-secret-id');
    expect(keys.every((key: string) => key.startsWith('photo-duplicate:history:v1:'))).toBe(true);
  });

  it('returns unavailable on Redis failure instead of moderating', async () => {
    const { service } = createService({ evalError: new Error('redis unavailable') });

    await expect(service.observeExactAlbum(baseInput())).resolves.toEqual({ kind: 'unavailable' });
  });

  it('adopts a prior perceptual cluster after bounded full-album comparison', async () => {
    const candidateAlbum = makeAlbum('0'.repeat(64), 'b'.repeat(64), 'e'.repeat(64));
    const currentAlbum = makeAlbum(`${'0'.repeat(63)}1`, 'd'.repeat(64));
    const candidate = JSON.stringify({
      schemaVersion: 1,
      clusterId,
      messageId: 'prior-pdq-message',
      occurredAtMs: 1_799_999_999_000,
      album: candidateAlbum,
    });
    const { redis, service } = createService({
      recentRows: [candidate],
      evalResult: [1, 'duplicate', clusterId, 'pdq', '1', '0', 'prior-pdq-message'],
    });

    await expect(
      service.observeAlbum({
        ...baseInput(),
        fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
        exactMatchKind: 'canonical_sha256',
        perceptualAlbum: currentAlbum,
        allowPerceptualMatch: true,
        perceptualPreset: 'SAME_IMAGE',
        commitViolation: false,
      }),
    ).resolves.toMatchObject({
      classification: 'duplicate',
      clusterId,
      matchKind: 'pdq',
      matchedDistance: 1,
      repeatCount: 0,
    });
    expect(redis.zrevrangebyscore).toHaveBeenCalledWith(
      expect.stringContaining(':recent:'),
      '1800000000000',
      '1799996400000',
      'LIMIT',
      0,
      250,
    );
    expect(redis.eval.mock.calls[0]).toContain(clusterId);
    expect(redis.eval.mock.calls[0]).toContain('prior-pdq-message');
    expect(redis.eval.mock.calls[0]).toContain('0');
  });

  it('does not adopt a low-quality PDQ candidate', async () => {
    const lowQualityCandidate = makeAlbum('0'.repeat(64), 'b'.repeat(64), 'e'.repeat(64));
    lowQualityCandidate.images[0].pdqQuality = 49;
    const currentAlbum = makeAlbum(`${'0'.repeat(63)}1`, 'd'.repeat(64));
    const { redis, service } = createService({
      recentRows: [
        JSON.stringify({
          schemaVersion: 1,
          clusterId,
          messageId: 'low-quality-prior',
          occurredAtMs: 1_799_999_999_000,
          album: lowQualityCandidate,
        }),
      ],
    });

    await service.observeAlbum({
      ...baseInput(),
      fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
      exactMatchKind: 'canonical_sha256',
      perceptualAlbum: currentAlbum,
      allowPerceptualMatch: true,
      commitViolation: false,
    });

    expect(redis.eval.mock.calls[0]).not.toContain('low-quality-prior');
  });

  it('reads versioned photo-id fingerprints without putting raw ids in cache keys', async () => {
    const { redis, service } = createService({});
    const fingerprint = makeAlbum('0'.repeat(64), 'b'.repeat(64)).images[0];
    redis.mget.mockResolvedValue([JSON.stringify(fingerprint), null, '{bad-json']);

    await expect(
      service.getCachedPhotoFingerprints(['photo-secret-1', 'photo-secret-2', 'photo-secret-3']),
    ).resolves.toEqual({
      kind: 'available',
      fingerprints: [fingerprint, null, null],
    });
    expect(redis.mget.mock.calls[0].join('|')).not.toContain('photo-secret');
    expect(redis.mget.mock.calls[0]).toHaveLength(3);
  });

  it('writes only fingerprints to the photo-id cache and fails open on write errors', async () => {
    const { redis, service } = createService({});
    const fingerprint = makeAlbum('0'.repeat(64), 'b'.repeat(64)).images[0];

    await expect(
      service.cachePhotoFingerprints([{ photoId: 'photo-secret-1', fingerprint }], 3_600),
    ).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      expect.not.stringContaining('photo-secret-1'),
      JSON.stringify(fingerprint),
      'EX',
      3_600,
    );

    redis.set.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(
      service.cachePhotoFingerprints([{ photoId: 'photo-secret-1', fingerprint }], 3_600),
    ).resolves.toBe(false);
  });

  it('isolates replay, history and counters across scope and preset changes', async () => {
    const { redis, service } = createService({});
    const input = {
      ...baseInput(),
      scope: 'SAME_AUTHOR' as const,
      perceptualPreset: 'SAME_IMAGE' as const,
    };

    await service.observeAlbum({ ...input, allowPerceptualMatch: false });
    const sameAuthorKeys = redis.eval.mock.calls[0]?.slice(2, 6).map(String);
    redis.eval.mockClear();
    await service.observeAlbum({ ...input, scope: 'CHAT', allowPerceptualMatch: false });
    const chatKeys = redis.eval.mock.calls[0]?.slice(2, 6).map(String);
    redis.eval.mockClear();
    await service.observeAlbum({
      ...input,
      perceptualPreset: 'MINOR_EDITS',
      allowPerceptualMatch: false,
    });
    const minorEditKeys = redis.eval.mock.calls[0]?.slice(2, 6).map(String);

    expect(chatKeys).not.toEqual(sameAuthorKeys);
    expect(minorEditKeys).not.toEqual(sameAuthorKeys);
  });

  it('allows a previously observed message with the same timestamp to be the baseline', async () => {
    const { redis, service } = createService({});

    await service.observeExactAlbum(baseInput());

    const script = String(redis.eval.mock.calls[0]?.[0] ?? '');
    expect(script).toContain('tostring(occurred_at),\n    cutoff_at');
    expect(script).not.toContain("'(' .. tostring(occurred_at),\n    cutoff_at");
  });
});
