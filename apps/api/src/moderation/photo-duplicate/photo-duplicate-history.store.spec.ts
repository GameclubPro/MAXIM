import type { PhotoAlbumFingerprint } from './photo-fingerprint';
import { PHOTO_FINGERPRINT_ALGORITHM_VERSION } from './photo-fingerprint';
import { PhotoDuplicateHistoryStore } from './photo-duplicate-history.store';

const clusterId = 'c'.repeat(64);
const sanctionClusterId = 'd'.repeat(64);
const albumHash = 'a'.repeat(64);
const authorizationConfigDigest = 'e'.repeat(64);
const actionConfigDigest = 'f'.repeat(64);

function createService(params: {
  evalResult?: unknown;
  evalResults?: unknown[];
  recentRows?: string[];
  evalError?: Error;
}) {
  const defaultResult = [
    1,
    'new',
    clusterId,
    '',
    '',
    0,
    '',
    sanctionClusterId,
    '0',
    '1',
    authorizationConfigDigest,
  ];
  const evalMock = params.evalError ? jest.fn().mockRejectedValue(params.evalError) : jest.fn();
  if (!params.evalError) {
    for (const result of params.evalResults ?? []) {
      evalMock.mockResolvedValueOnce(result);
    }
    evalMock.mockResolvedValue(params.evalResult ?? defaultResult);
  }
  const redis = {
    eval: evalMock,
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
    authorization: {
      eligible: true,
      configDigest: authorizationConfigDigest,
      allowedMatchKinds: ['platform_id'] as const,
    },
  };
}

function commitInput() {
  return {
    chatId: 'chat-secret-id',
    senderId: 'user-secret-id',
    messageId: 'message-secret-id',
    ttlSeconds: 3_600,
    scope: 'CHAT' as const,
    fingerprintVersion: 'max-photo-id-album-v1',
    albumHash,
    observationClusterId: clusterId,
    matchKind: 'platform_id' as const,
    expectedRepeatCount: 2,
    allowedMatchKinds: ['platform_id'] as const,
    authorizationConfigDigest,
    actionBinding: {
      intendedAction: 'MUTE' as const,
      configDigest: actionConfigDigest,
    },
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
      evalResult: [
        1,
        'duplicate',
        clusterId,
        'platform_id',
        '0',
        '2',
        'previous-message',
        sanctionClusterId,
        '0',
        '1',
        authorizationConfigDigest,
      ],
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
      sanctionClusterId,
      violationCommitted: false,
      authorization: {
        authorized: true,
        configDigest: authorizationConfigDigest,
      },
    });
  });

  it('marks a mirrored delivery as replayed without incrementing again', async () => {
    const { redis, service } = createService({
      evalResult: [
        2,
        'duplicate',
        clusterId,
        'platform_id',
        '0',
        '1',
        'previous-message',
        sanctionClusterId,
        '0',
        '1',
        authorizationConfigDigest,
      ],
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
    expect(script).not.toContain("redis.call('HINCRBY'");
    expect(script).toContain("redis.call('HDEL', KEYS[4], sanction_cluster_id)");
  });

  it('returns out-of-order observations before every history mutation', async () => {
    const { redis, service } = createService({
      evalResult: [
        3,
        'out_of_order',
        clusterId,
        '',
        '',
        '0',
        '',
        sanctionClusterId,
        '0',
        '1',
        authorizationConfigDigest,
      ],
    });

    await expect(service.observeExactAlbum(baseInput())).resolves.toMatchObject({
      classification: 'out_of_order',
      inserted: false,
      replayed: false,
    });

    const script = String(redis.eval.mock.calls[0]?.[0] ?? '');
    const staleReturn = script.indexOf("'out_of_order'");
    expect(staleReturn).toBeGreaterThan(-1);
    expect(staleReturn).toBeLessThan(
      script.indexOf("redis.call('ZREMRANGEBYSCORE', KEYS[2]"),
    );
    expect(script).not.toContain("if classification ~= 'out_of_order' then");
    expect(script.indexOf("redis.call('ZADD', KEYS[3]")).toBeLessThan(
      script.indexOf("redis.call(\n  'HSET',\n  KEYS[1]"),
    );
  });

  it('commits a violation atomically only after checking replay and match-kind policy', async () => {
    const { redis, service } = createService({
      evalResult: [1, '2', sanctionClusterId, 'MUTE', actionConfigDigest, '1'],
    });

    await expect(service.commitViolation(commitInput())).resolves.toEqual({
      kind: 'available',
      committed: true,
      replayed: false,
      repeatCount: 2,
      sanctionClusterId,
      bindingMatches: true,
      actionBinding: {
        intendedAction: 'MUTE',
        configDigest: actionConfigDigest,
      },
    });

    const script = String(redis.eval.mock.calls[0]?.[0] ?? '');
    expect(script.indexOf("'violation_committed'")).toBeLessThan(
      script.indexOf("redis.call('HINCRBY'"),
    );
    expect(script).toContain('match_kind_allowed');
    expect(script).toContain('current_repeat_count + 1 ~= expected_repeat_count');
    expect(redis.eval.mock.calls[0]?.at(-5)).toBe(',platform_id,');
  });

  it('returns the prior commit on replay without incrementing the sanction counter again', async () => {
    const { redis, service } = createService({
      evalResults: [
        [1, '2', sanctionClusterId, 'MUTE', actionConfigDigest, '1'],
        [2, '2', sanctionClusterId, 'MUTE', actionConfigDigest, '1'],
      ],
    });

    await expect(service.commitViolation(commitInput())).resolves.toMatchObject({
      committed: true,
      replayed: false,
      repeatCount: 2,
    });
    await expect(service.commitViolation(commitInput())).resolves.toMatchObject({
      committed: false,
      replayed: true,
      repeatCount: 2,
    });
    expect(redis.eval).toHaveBeenCalledTimes(2);
  });

  it('returns the immutable NONE binding when a replay requests a stronger action', async () => {
    const noneBindingDigest = '9'.repeat(64);
    const { service } = createService({
      evalResult: [2, '2', sanctionClusterId, 'NONE', noneBindingDigest, '0'],
    });

    await expect(service.commitViolation(commitInput())).resolves.toEqual({
      kind: 'available',
      committed: false,
      replayed: true,
      repeatCount: 2,
      sanctionClusterId,
      bindingMatches: false,
      actionBinding: {
        intendedAction: 'NONE',
        configDigest: noneBindingDigest,
      },
    });
  });

  it('keeps first-write observation authorization absorbing on replay', async () => {
    const originalDigest = '8'.repeat(64);
    const { redis, service } = createService({
      evalResult: [
        2,
        'duplicate',
        clusterId,
        'platform_id',
        '0',
        '1',
        'previous-message',
        sanctionClusterId,
        '0',
        '0',
        originalDigest,
      ],
    });

    await expect(service.observeExactAlbum(baseInput())).resolves.toMatchObject({
      replayed: true,
      authorization: {
        authorized: false,
        configDigest: originalDigest,
      },
    });
    const script = String(redis.eval.mock.calls[0]?.[0] ?? '');
    expect(script.indexOf("redis.call('HGET', KEYS[1], 'classification')")).toBeLessThan(
      script.indexOf('local authorization_eligible = ARGV[15]'),
    );
  });

  it('does not expose chat or author identifiers in Redis keys', async () => {
    const { redis, service } = createService({});

    await service.observeExactAlbum(baseInput());

    const keys = redis.eval.mock.calls[0]?.slice(2, 6).map(String) ?? [];
    expect(keys.join('|')).not.toContain('chat-secret-id');
    expect(keys.join('|')).not.toContain('user-secret-id');
    expect(keys.join('|')).not.toContain('message-secret-id');
    expect(keys.every((key: string) => key.startsWith('photo-duplicate:history:v2:'))).toBe(true);
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
      evalResult: [
        1,
        'duplicate',
        clusterId,
        'pdq',
        '1',
        '1',
        'prior-pdq-message',
        sanctionClusterId,
        '0',
        '1',
        authorizationConfigDigest,
      ],
    });

    await expect(
      service.observeAlbum({
        ...baseInput(),
        fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
        exactMatchKind: 'canonical_sha256',
        perceptualAlbum: currentAlbum,
        allowPerceptualMatch: true,
        perceptualPreset: 'SAME_IMAGE',
      }),
    ).resolves.toMatchObject({
      classification: 'duplicate',
      clusterId,
      matchKind: 'pdq',
      matchedDistance: 1,
      repeatCount: 1,
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
    expect(script).toMatch(/tostring\(occurred_at\),\s+cutoff_at/u);
    expect(script).not.toMatch(/'\(' \.\. tostring\(occurred_at\),\s+cutoff_at/u);
  });

  it('returns out-of-order observations before every Redis history mutation', async () => {
    const { redis, service } = createService({
      evalResult: [
        3,
        'out_of_order',
        clusterId,
        '',
        '',
        0,
        '',
        sanctionClusterId,
        '0',
        '0',
        authorizationConfigDigest,
      ],
    });

    await expect(service.observeExactAlbum(baseInput())).resolves.toMatchObject({
      inserted: false,
      replayed: false,
      classification: 'out_of_order',
      authorization: { authorized: false },
    });

    const script = String(redis.eval.mock.calls[0]?.[0] ?? '');
    const staleCheck = script.indexOf('local newer = redis.call(');
    const staleReturn = script.indexOf("'out_of_order'", staleCheck);
    expect(staleCheck).toBeGreaterThan(-1);
    expect(staleReturn).toBeGreaterThan(staleCheck);
    expect(staleReturn).toBeLessThan(script.indexOf("redis.call('ZREMRANGEBYSCORE'"));
    expect(staleReturn).toBeLessThan(script.indexOf("redis.call('ZADD'"));
    expect(staleReturn).toBeLessThan(script.indexOf("redis.call(\n  'HSET'"));
  });

  it('checks exact history before accepting a forced perceptual match', async () => {
    const { redis, service } = createService({});

    await service.observeExactAlbum(baseInput());

    const script = String(redis.eval.mock.calls[0]?.[0] ?? '');
    expect(script.indexOf('if prior then')).toBeLessThan(
      script.indexOf("elseif forced_cluster_id ~= ''"),
    );
  });

  it('derives sanction clusters from the current canonical album independently of baseline clusters', async () => {
    const { redis, service } = createService({});

    await service.observeExactAlbum(baseInput());
    await service.observeExactAlbum({
      ...baseInput(),
      messageId: 'message-b-1',
      albumHash: 'b'.repeat(64),
    });
    await service.observeExactAlbum({
      ...baseInput(),
      messageId: 'message-b-2',
      albumHash: 'b'.repeat(64),
    });

    const sanctionClusters = redis.eval.mock.calls.map((call) => String(call.at(-5)));
    expect(sanctionClusters[0]).not.toBe(sanctionClusters[1]);
    expect(sanctionClusters[1]).toBe(sanctionClusters[2]);
  });

  it('uses one namespaced perceptual sanction cluster across near-image variants', async () => {
    const candidateAlbum = makeAlbum('0'.repeat(64), '1'.repeat(64), '1'.repeat(64));
    const candidate = JSON.stringify({
      schemaVersion: 1,
      clusterId,
      messageId: 'pdq-baseline',
      occurredAtMs: 1_799_999_999_000,
      album: candidateAlbum,
    });
    const { redis, service } = createService({ recentRows: [candidate] });

    await service.observeAlbum({
      ...baseInput(),
      albumHash: '2'.repeat(64),
      fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
      exactMatchKind: 'canonical_sha256',
      perceptualAlbum: makeAlbum(`${'0'.repeat(63)}1`, '2'.repeat(64), '2'.repeat(64)),
      allowPerceptualMatch: true,
      perceptualPreset: 'MINOR_EDITS',
    });
    await service.observeAlbum({
      ...baseInput(),
      messageId: 'message-near-c',
      albumHash: '3'.repeat(64),
      fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
      exactMatchKind: 'canonical_sha256',
      perceptualAlbum: makeAlbum(`${'0'.repeat(62)}11`, '3'.repeat(64), '3'.repeat(64)),
      allowPerceptualMatch: true,
      perceptualPreset: 'MINOR_EDITS',
    });

    const canonicalClusters = redis.eval.mock.calls.map((call) => String(call.at(-5)));
    const perceptualClusters = redis.eval.mock.calls.map((call) => String(call.at(-4)));
    expect(canonicalClusters[0]).not.toBe(canonicalClusters[1]);
    expect(perceptualClusters[0]).toBe(perceptualClusters[1]);
    expect(perceptualClusters[0]).not.toBe(canonicalClusters[0]);
  });
});
