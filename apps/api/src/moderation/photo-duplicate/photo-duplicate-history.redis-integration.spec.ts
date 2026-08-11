import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import {
  PhotoDuplicateHistoryStore,
  type PhotoHistoryMatchKind,
  type PhotoHistoryViolationActionBinding,
} from './photo-duplicate-history.store';
import {
  PHOTO_FINGERPRINT_ALGORITHM_VERSION,
  type PhotoAlbumFingerprint,
} from './photo-fingerprint';

const authorizationConfigDigest = 'e'.repeat(64);
const actionConfigDigest = 'f'.repeat(64);

const redisIntegrationUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const isLocalRedisUrl = (() => {
  try {
    const hostname = new URL(redisIntegrationUrl).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
})();
const describeLocalRedis = isLocalRedisUrl ? describe : describe.skip;

describeLocalRedis('PhotoDuplicateHistoryStore Redis integration', () => {
  it('keeps stale exact observations out of history', async () => {
    const suffix = randomUUID();
    const chatId = `photo-order-chat-${suffix}`;
    const senderId = `photo-order-user-${suffix}`;
    const exactAlbumHash = '6'.repeat(64);
    const messageIds = ['newest', 'oldest', 'middle'].map(
      (messageId) => `${messageId}-${suffix}`,
    );
    const cleanupKeys = buildCleanupKeys({
      chatId,
      senderId,
      messageIds,
      albumHashes: [exactAlbumHash],
    });
    const service = new PhotoDuplicateHistoryStore({
      getOrThrow: () => redisIntegrationUrl,
      get: () => 250,
    } as never);
    const inspector = new Redis(redisIntegrationUrl);
    const baseOccurredAtMs = Date.now() - 10_000;
    const observe = (messageId: string, occurredAtMs: number) =>
      service.observeExactAlbum({
        chatId,
        senderId,
        messageId,
        occurredAtMs,
        ttlSeconds: 3_600,
        scope: 'SAME_AUTHOR',
        fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
        albumHash: exactAlbumHash,
        exactMatchKind: 'canonical_sha256',
        authorization: {
          eligible: true,
          configDigest: authorizationConfigDigest,
          allowedMatchKinds: ['canonical_sha256'],
        },
      });

    try {
      await inspector.del(...cleanupKeys);
      await expect(observe(messageIds[0]!, baseOccurredAtMs + 200)).resolves.toMatchObject({
        classification: 'new',
      });
      await expect(observe(messageIds[1]!, baseOccurredAtMs + 100)).resolves.toMatchObject({
        inserted: false,
        replayed: false,
        classification: 'out_of_order',
      });
      await expect(observe(messageIds[2]!, baseOccurredAtMs + 150)).resolves.toMatchObject({
        inserted: false,
        replayed: false,
        classification: 'out_of_order',
      });
    } finally {
      await inspector.del(...cleanupKeys);
      await inspector.quit();
      await service.onModuleDestroy();
    }
  });

  it('escalates PDQ variants together while keeping canonical sanction counters isolated', async () => {
    const suffix = randomUUID();
    const chatId = `photo-history-chat-${suffix}`;
    const senderId = `photo-history-user-${suffix}`;
    const aHash = 'a'.repeat(64);
    const bHash = 'b'.repeat(64);
    const cHash = 'c'.repeat(64);
    const occurredAtMs = Date.now() - 10_000;
    const service = new PhotoDuplicateHistoryStore({
      getOrThrow: () => redisIntegrationUrl,
      get: () => 250,
    } as never);
    const inspector = new Redis(redisIntegrationUrl);
    const dHash = 'd'.repeat(64);
    const messageIds = ['a-0', 'b-0', 'c-0', 'b-1', 'a-1', 'b-2', 'd-denied'].map(
      (messageId) => `${messageId}-${suffix}`,
    );
    const cleanupKeys = buildCleanupKeys({
      chatId,
      senderId,
      messageIds,
      albumHashes: [aHash, bHash, cHash, dHash],
    });
    const albumA = album(aHash, 'a'.repeat(64), '0'.repeat(64));
    const albumB = album(bHash, 'b'.repeat(64), `${'0'.repeat(63)}1`);
    const albumC = album(cHash, 'c'.repeat(64), `${'0'.repeat(62)}11`);
    const albumD = album(dHash, 'd'.repeat(64), `${'0'.repeat(61)}111`);
    const observe = (params: {
      messageId: string;
      occurredAtMs: number;
      album: PhotoAlbumFingerprint;
      allowedMatchKinds?: readonly PhotoHistoryMatchKind[];
    }) =>
      service.observeAlbum({
        chatId,
        senderId,
        messageId: params.messageId,
        occurredAtMs: params.occurredAtMs,
        ttlSeconds: 3_600,
        scope: 'SAME_AUTHOR',
        fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
        albumHash: params.album.albumHash,
        exactMatchKind: 'canonical_sha256',
        perceptualAlbum: params.album,
        allowPerceptualMatch: true,
        perceptualPreset: 'SAME_IMAGE',
        authorization: {
          eligible: true,
          configDigest: authorizationConfigDigest,
          allowedMatchKinds: params.allowedMatchKinds ?? ['canonical_sha256', 'pdq'],
        },
      });

    try {
      await inspector.del(...cleanupKeys);
      const firstA = await observe({
        messageId: messageIds[0]!,
        occurredAtMs,
        album: albumA,
      });
      expect(firstA).toMatchObject({ kind: 'available', classification: 'new' });

      const nearB = await observe({
        messageId: messageIds[1]!,
        occurredAtMs: occurredAtMs + 1,
        album: albumB,
      });
      expect(nearB).toMatchObject({
        kind: 'available',
        classification: 'duplicate',
        matchKind: 'pdq',
        repeatCount: 1,
      });
      if (nearB.kind !== 'available' || nearB.matchKind === null) {
        throw new Error('Expected an available PDQ observation');
      }
      const firstPdqCommit = await commitObservation(service, {
        chatId,
        senderId,
        messageId: messageIds[1]!,
        albumHash: bHash,
        observation: nearB,
        allowedMatchKinds: ['pdq'],
      });
      expect(firstPdqCommit).toMatchObject({
        kind: 'available',
        committed: true,
        repeatCount: 1,
      });
      if (firstPdqCommit.kind !== 'available') {
        throw new Error('Expected the first PDQ counter commit');
      }

      const nearC = await observe({
        messageId: messageIds[2]!,
        occurredAtMs: occurredAtMs + 2,
        album: albumC,
      });
      expect(nearC).toMatchObject({
        kind: 'available',
        classification: 'duplicate',
        clusterId: nearB.clusterId,
        matchKind: 'pdq',
        repeatCount: 2,
      });
      const secondPdqCommit = await commitObservation(service, {
        chatId,
        senderId,
        messageId: messageIds[2]!,
        albumHash: cHash,
        observation: nearC,
        allowedMatchKinds: ['pdq'],
      });
      expect(secondPdqCommit).toMatchObject({
        kind: 'available',
        committed: true,
        repeatCount: 2,
        sanctionClusterId: firstPdqCommit.sanctionClusterId,
      });

      const exactB = await observe({
        messageId: messageIds[3]!,
        occurredAtMs: occurredAtMs + 3,
        album: albumB,
      });
      expect(exactB).toMatchObject({
        kind: 'available',
        classification: 'duplicate',
        matchKind: 'canonical_sha256',
        repeatCount: 1,
      });
      const bCommit = await commitCanonical(service, {
        chatId,
        senderId,
        messageId: messageIds[3]!,
        albumHash: bHash,
        observation: exactB,
      });
      expect(bCommit).toMatchObject({ kind: 'available', committed: true, repeatCount: 1 });

      const exactA = await observe({
        messageId: messageIds[4]!,
        occurredAtMs: occurredAtMs + 4,
        album: albumA,
      });
      const aCommit = await commitCanonical(service, {
        chatId,
        senderId,
        messageId: messageIds[4]!,
        albumHash: aHash,
        observation: exactA,
      });
      expect(aCommit).toMatchObject({ kind: 'available', committed: true, repeatCount: 1 });
      if (aCommit.kind !== 'available' || bCommit.kind !== 'available') {
        throw new Error('Expected canonical counter commits');
      }
      expect(aCommit.sanctionClusterId).not.toBe(bCommit.sanctionClusterId);
      expect(aCommit.sanctionClusterId).not.toBe(firstPdqCommit.sanctionClusterId);
      expect(bCommit.sanctionClusterId).not.toBe(firstPdqCommit.sanctionClusterId);

      const secondExactB = await observe({
        messageId: messageIds[5]!,
        occurredAtMs: occurredAtMs + 5,
        album: albumB,
      });
      const secondBCommit = await commitCanonical(service, {
        chatId,
        senderId,
        messageId: messageIds[5]!,
        albumHash: bHash,
        observation: secondExactB,
      });
      expect(secondBCommit).toMatchObject({
        kind: 'available',
        committed: true,
        replayed: false,
        repeatCount: 2,
        sanctionClusterId: bCommit.sanctionClusterId,
      });
      await expect(
        commitCanonical(service, {
          chatId,
          senderId,
          messageId: messageIds[5]!,
          albumHash: bHash,
          observation: secondExactB,
        }),
      ).resolves.toMatchObject({
        kind: 'available',
        committed: false,
        replayed: true,
        repeatCount: 2,
      });

      const disallowedPdq = await observe({
        messageId: messageIds[6]!,
        occurredAtMs: occurredAtMs + 6,
        album: albumD,
        allowedMatchKinds: ['canonical_sha256'],
      });
      expect(disallowedPdq).toMatchObject({
        kind: 'available',
        classification: 'duplicate',
        matchKind: 'pdq',
        authorization: { authorized: false },
      });
      const replayedAfterKindUpgrade = await observe({
        messageId: messageIds[6]!,
        occurredAtMs: occurredAtMs + 6,
        album: albumD,
        allowedMatchKinds: ['pdq'],
      });
      expect(replayedAfterKindUpgrade).toMatchObject({
        kind: 'available',
        replayed: true,
        authorization: { authorized: false },
      });
    } finally {
      await inspector.del(...cleanupKeys);
      await inspector.quit();
      await service.onModuleDestroy();
    }
  });

  it('keeps first-write authorization and NONE action bindings immutable on replay', async () => {
    const suffix = randomUUID();
    const chatId = `photo-binding-chat-${suffix}`;
    const senderId = `photo-binding-user-${suffix}`;
    const albumHash = '7'.repeat(64);
    const messageIds = ['baseline', 'denied', 'none-bound'].map(
      (messageId) => `${messageId}-${suffix}`,
    );
    const cleanupKeys = buildCleanupKeys({
      chatId,
      senderId,
      messageIds,
      albumHashes: [albumHash],
    });
    const service = new PhotoDuplicateHistoryStore({
      getOrThrow: () => redisIntegrationUrl,
      get: () => 250,
    } as never);
    const inspector = new Redis(redisIntegrationUrl);
    const occurredAtMs = Date.now() - 10_000;
    const observe = (params: {
      messageId: string;
      occurredAtMs: number;
      eligible: boolean;
      configDigest: string;
    }) =>
      service.observeAlbum({
        chatId,
        senderId,
        messageId: params.messageId,
        occurredAtMs: params.occurredAtMs,
        ttlSeconds: 3_600,
        scope: 'SAME_AUTHOR',
        fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
        albumHash,
        exactMatchKind: 'canonical_sha256',
        allowPerceptualMatch: false,
        perceptualPreset: 'SAME_IMAGE',
        authorization: {
          eligible: params.eligible,
          configDigest: params.configDigest,
          allowedMatchKinds: ['canonical_sha256'],
        },
      });

    try {
      await inspector.del(...cleanupKeys);
      await observe({
        messageId: messageIds[0]!,
        occurredAtMs,
        eligible: true,
        configDigest: authorizationConfigDigest,
      });
      const denied = await observe({
        messageId: messageIds[1]!,
        occurredAtMs: occurredAtMs + 1,
        eligible: false,
        configDigest: '1'.repeat(64),
      });
      expect(denied).toMatchObject({
        kind: 'available',
        classification: 'duplicate',
        authorization: { authorized: false, configDigest: '1'.repeat(64) },
      });

      const replayedAfterUpgrade = await observe({
        messageId: messageIds[1]!,
        occurredAtMs: occurredAtMs + 1,
        eligible: true,
        configDigest: authorizationConfigDigest,
      });
      expect(replayedAfterUpgrade).toMatchObject({
        kind: 'available',
        replayed: true,
        authorization: { authorized: false, configDigest: '1'.repeat(64) },
      });
      await expect(
        commitObservation(service, {
          chatId,
          senderId,
          messageId: messageIds[1]!,
          albumHash,
          observation: replayedAfterUpgrade,
          allowedMatchKinds: ['canonical_sha256'],
        }),
      ).resolves.toEqual({ kind: 'unavailable' });

      const actionable = await observe({
        messageId: messageIds[2]!,
        occurredAtMs: occurredAtMs + 2,
        eligible: true,
        configDigest: authorizationConfigDigest,
      });
      const noneBinding = {
        intendedAction: 'NONE',
        configDigest: '2'.repeat(64),
      } as const;
      const committedNone = await commitObservation(service, {
        chatId,
        senderId,
        messageId: messageIds[2]!,
        albumHash,
        observation: actionable,
        allowedMatchKinds: ['canonical_sha256'],
        actionBinding: noneBinding,
      });
      expect(committedNone).toMatchObject({
        kind: 'available',
        committed: true,
        bindingMatches: true,
        actionBinding: noneBinding,
      });

      const strengthenedReplay = await commitObservation(service, {
        chatId,
        senderId,
        messageId: messageIds[2]!,
        albumHash,
        observation: actionable,
        allowedMatchKinds: ['canonical_sha256'],
        actionBinding: {
          intendedAction: 'BAN',
          configDigest: '3'.repeat(64),
        },
      });
      expect(strengthenedReplay).toMatchObject({
        kind: 'available',
        committed: false,
        replayed: true,
        bindingMatches: false,
        actionBinding: noneBinding,
      });
    } finally {
      await inspector.del(...cleanupKeys);
      await inspector.quit();
      await service.onModuleDestroy();
    }
  });

  it('does not let one out-of-order observation seed another late duplicate', async () => {
    const suffix = randomUUID();
    const chatId = `photo-order-chat-${suffix}`;
    const senderId = `photo-order-user-${suffix}`;
    const albumHash = '6'.repeat(64);
    const messageIds = ['newest', 'oldest', 'middle'].map(
      (messageId) => `${messageId}-${suffix}`,
    );
    const cleanupKeys = buildCleanupKeys({
      chatId,
      senderId,
      messageIds,
      albumHashes: [albumHash],
    });
    const service = new PhotoDuplicateHistoryStore({
      getOrThrow: () => redisIntegrationUrl,
      get: () => 250,
    } as never);
    const inspector = new Redis(redisIntegrationUrl);
    const occurredAtMs = Date.now() - 10_000;
    const observe = (messageId: string, eventOffsetMs: number) =>
      service.observeExactAlbum({
        chatId,
        senderId,
        messageId,
        occurredAtMs: occurredAtMs + eventOffsetMs,
        ttlSeconds: 3_600,
        scope: 'SAME_AUTHOR',
        fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
        albumHash,
        exactMatchKind: 'canonical_sha256',
        authorization: {
          eligible: true,
          configDigest: authorizationConfigDigest,
          allowedMatchKinds: ['canonical_sha256'],
        },
      });

    try {
      await inspector.del(...cleanupKeys);
      await expect(observe(messageIds[0]!, 2)).resolves.toMatchObject({
        classification: 'new',
      });
      await expect(observe(messageIds[1]!, 0)).resolves.toMatchObject({
        classification: 'out_of_order',
      });
      await expect(observe(messageIds[2]!, 1)).resolves.toMatchObject({
        classification: 'out_of_order',
        repeatCount: 0,
      });
    } finally {
      await inspector.del(...cleanupKeys);
      await inspector.quit();
      await service.onModuleDestroy();
    }
  });
});

function album(albumHash: string, canonicalHash: string, pdqHash: string): PhotoAlbumFingerprint {
  return {
    algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
    albumHash,
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

async function commitCanonical(
  service: PhotoDuplicateHistoryStore,
  params: {
    chatId: string;
    senderId: string;
    messageId: string;
    albumHash: string;
    observation: Awaited<ReturnType<PhotoDuplicateHistoryStore['observeAlbum']>>;
  },
) {
  if (
    params.observation.kind !== 'available' ||
    params.observation.matchKind !== 'canonical_sha256'
  ) {
    throw new Error('Expected an available canonical observation');
  }
  return commitObservation(service, {
    ...params,
    observation: params.observation,
    allowedMatchKinds: ['canonical_sha256'],
  });
}

async function commitObservation(
  service: PhotoDuplicateHistoryStore,
  params: {
    chatId: string;
    senderId: string;
    messageId: string;
    albumHash: string;
    observation: Awaited<ReturnType<PhotoDuplicateHistoryStore['observeAlbum']>>;
    allowedMatchKinds: readonly PhotoHistoryMatchKind[];
    actionBinding?: PhotoHistoryViolationActionBinding;
  },
) {
  if (params.observation.kind !== 'available' || params.observation.matchKind === null) {
    throw new Error('Expected an available duplicate observation');
  }
  return service.commitViolation({
    chatId: params.chatId,
    senderId: params.senderId,
    messageId: params.messageId,
    ttlSeconds: 3_600,
    scope: 'SAME_AUTHOR',
    fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
    albumHash: params.albumHash,
    perceptualPreset: 'SAME_IMAGE',
    observationClusterId: params.observation.clusterId,
    matchKind: params.observation.matchKind,
    expectedRepeatCount: params.observation.repeatCount,
    allowedMatchKinds: params.allowedMatchKinds,
    authorizationConfigDigest,
    actionBinding: params.actionBinding ?? {
      intendedAction: 'HIT',
      configDigest: actionConfigDigest,
    },
  });
}

function buildCleanupKeys(params: {
  chatId: string;
  senderId: string;
  messageIds: string[];
  albumHashes: string[];
}): string[] {
  const namespace = 'photo-duplicate:history:v2';
  const versionHash = shortHash(PHOTO_FINGERPRINT_ALGORITHM_VERSION);
  const policyHash = shortHash('SAME_AUTHOR:SAME_IMAGE');
  const chatHash = shortHash(params.chatId);
  const senderHash = shortHash(params.senderId);
  const scopeHash = `author:${chatHash}:${senderHash}`;
  return [
    ...params.messageIds.map(
      (messageId) =>
        `${namespace}:replay:${versionHash}:${policyHash}:${chatHash}:${shortHash(messageId)}`,
    ),
    ...params.albumHashes.map(
      (albumHash) => `${namespace}:exact:${versionHash}:${policyHash}:${scopeHash}:${albumHash}`,
    ),
    `${namespace}:recent:${versionHash}:${policyHash}:${scopeHash}`,
    `${namespace}:author-count:${versionHash}:${policyHash}:${chatHash}:${senderHash}`,
  ];
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}
