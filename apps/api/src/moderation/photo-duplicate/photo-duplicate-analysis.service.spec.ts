import type { LogicalPhotoAlbum } from './photo-attachment-extractor';
import { PhotoDuplicateAnalysisService } from './photo-duplicate-analysis.service';
import { PhotoDecodeBudget } from './photo-decode-resource';
import {
  PHOTO_FINGERPRINT_ALGORITHM_VERSION,
  PhotoFingerprintRejectedError,
  type PhotoFingerprint,
} from './photo-fingerprint';

const authorizationConfigDigest = 'f'.repeat(64);
const actionConfigDigest = 'e'.repeat(64);

function fingerprint(seed: string): PhotoFingerprint {
  return {
    algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
    canonicalHash: seed.repeat(64).slice(0, 64),
    pdqHash: seed.repeat(64).slice(0, 64),
    pdqQuality: 80,
  };
}

function album(images: LogicalPhotoAlbum['images']): LogicalPhotoAlbum {
  return {
    chatId: 'chat-1',
    messageId: 'message-1',
    senderId: 'user-1',
    createdAtMs: Date.parse('2026-08-05T12:00:00.000Z'),
    images,
  };
}

function createService(cache: Array<PhotoFingerprint | null>) {
  const downloader = {
    download: jest.fn(async (url: string) => ({
      bytes: Buffer.from(url),
      format: 'jpeg' as const,
    })),
  };
  const generated = fingerprint('c');
  const fingerprintService = {
    createAlbumDecodeBudget: jest.fn(
      () => new PhotoDecodeBudget({ maxEncodedBytes: 1_024, maxPixels: 1_024 }),
    ),
    fingerprint: jest.fn().mockResolvedValue(generated),
  };
  const historyStore = {
    getCachedPhotoFingerprints: jest.fn().mockResolvedValue({
      kind: 'available',
      fingerprints: cache,
    }),
    cachePhotoFingerprints: jest.fn().mockResolvedValue(true),
    observeAlbum: jest.fn().mockResolvedValue({
      kind: 'available',
      inserted: true,
      replayed: false,
      classification: 'new',
      clusterId: 'd'.repeat(64),
      matchKind: null,
      matchedDistance: null,
      repeatCount: 0,
      duplicateOfMessageId: null,
      sanctionClusterId: 'e'.repeat(64),
      violationCommitted: false,
      authorization: {
        authorized: true,
        configDigest: authorizationConfigDigest,
      },
    }),
    commitViolation: jest.fn().mockResolvedValue({
      kind: 'available',
      committed: true,
      replayed: false,
      repeatCount: 1,
      sanctionClusterId: 'e'.repeat(64),
      bindingMatches: true,
      actionBinding: {
        intendedAction: 'HIT',
        configDigest: actionConfigDigest,
      },
    }),
  };
  return {
    downloader,
    fingerprintService,
    historyStore,
    generated,
    service: new PhotoDuplicateAnalysisService(
      downloader as never,
      fingerprintService as never,
      historyStore as never,
    ),
  };
}

describe('PhotoDuplicateAnalysisService', () => {
  it('uses the photo-id fingerprint cache without downloading bytes', async () => {
    const first = fingerprint('a');
    const second = fingerprint('b');
    const { service, downloader, historyStore } = createService([first, second]);
    const resolveActionEligibility = jest.fn().mockResolvedValue(true);

    const result = await service.analyzeAlbum({
      album: album([
        { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' },
        { source: 'direct', photoId: 'photo-2', downloadUrl: 'https://i.oneme.ru/2' },
      ]),
      ttlSeconds: 3_601,
      scope: 'SAME_AUTHOR',
      preset: 'SAME_IMAGE',
      actionEligible: true,
      authorizationConfigDigest,
      allowedViolationMatchKinds: ['canonical_sha256'],
      resolveActionEligibility,
    });

    expect(result).toMatchObject({ kind: 'observed', imageCount: 2, actionEligible: true });
    expect(downloader.download).not.toHaveBeenCalled();
    expect(resolveActionEligibility).toHaveBeenCalledTimes(1);
    expect(historyStore.observeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
        exactMatchKind: 'canonical_sha256',
        allowPerceptualMatch: true,
        perceptualPreset: 'SAME_IMAGE',
        authorization: {
          eligible: true,
          configDigest: authorizationConfigDigest,
          allowedMatchKinds: ['canonical_sha256'],
        },
      }),
    );
  });

  it('downloads only cache misses and stores no URL or token in the cache', async () => {
    const cached = fingerprint('a');
    const { service, downloader, historyStore, generated } = createService([cached, null]);
    const resolveActionEligibility = jest.fn().mockResolvedValue(true);

    await service.analyzeAlbum({
      album: album([
        { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' },
        { source: 'direct', photoId: 'photo-2', downloadUrl: 'https://i.oneme.ru/2?token=secret' },
      ]),
      ttlSeconds: 7_201,
      scope: 'CHAT',
      preset: 'MINOR_EDITS',
      actionEligible: false,
      authorizationConfigDigest,
      allowedViolationMatchKinds: ['canonical_sha256'],
      resolveActionEligibility,
    });

    expect(downloader.download).toHaveBeenCalledTimes(1);
    expect(historyStore.cachePhotoFingerprints).toHaveBeenCalledWith(
      [{ photoId: 'photo-2', fingerprint: generated }],
      7_201,
    );
    expect(JSON.stringify(historyStore.cachePhotoFingerprints.mock.calls[0]?.[0])).not.toContain(
      'secret',
    );
    expect(resolveActionEligibility).toHaveBeenCalledTimes(1);
    expect(historyStore.cachePhotoFingerprints.mock.invocationCallOrder[0]!).toBeLessThan(
      resolveActionEligibility.mock.invocationCallOrder[0]!,
    );
    expect(resolveActionEligibility.mock.invocationCallOrder[0]!).toBeLessThan(
      historyStore.observeAlbum.mock.invocationCallOrder[0]!,
    );
  });

  it('shares one bounded decode budget across all cache misses in an album', async () => {
    const { service, fingerprintService } = createService([null, null]);

    await service.analyzeAlbum({
      album: album([
        { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' },
        { source: 'direct', photoId: 'photo-2', downloadUrl: 'https://i.oneme.ru/2' },
      ]),
      ttlSeconds: 7_201,
      scope: 'CHAT',
      preset: 'MINOR_EDITS',
      actionEligible: false,
      authorizationConfigDigest,
      allowedViolationMatchKinds: ['canonical_sha256'],
      resolveActionEligibility: jest.fn().mockResolvedValue(true),
    });

    expect(fingerprintService.createAlbumDecodeBudget).toHaveBeenCalledTimes(1);
    expect(fingerprintService.fingerprint).toHaveBeenCalledTimes(2);
    expect(fingerprintService.fingerprint.mock.calls[0]?.[1]?.albumBudget).toBe(
      fingerprintService.fingerprint.mock.calls[1]?.[1]?.albumBudget,
    );
    expect(fingerprintService.fingerprint).toHaveBeenNthCalledWith(
      1,
      expect.any(Buffer),
      expect.objectContaining({ expectedFormat: 'jpeg' }),
    );
  });

  it('fails open without observing or caching a rejected image container', async () => {
    const { service, fingerprintService, historyStore } = createService([null]);
    fingerprintService.fingerprint.mockRejectedValueOnce(
      new PhotoFingerprintRejectedError('unsupported_multi_frame'),
    );

    await expect(
      service.analyzeAlbum({
        album: album([
          { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/animated' },
        ]),
        ttlSeconds: 3_601,
        scope: 'SAME_AUTHOR',
        preset: 'SAME_IMAGE',
        actionEligible: true,
        authorizationConfigDigest,
        allowedViolationMatchKinds: ['canonical_sha256'],
        resolveActionEligibility: jest.fn().mockResolvedValue(true),
      }),
    ).resolves.toEqual({ kind: 'incomplete', reason: 'unsupported_multi_frame' });
    expect(historyStore.cachePhotoFingerprints).not.toHaveBeenCalled();
    expect(historyStore.observeAlbum).not.toHaveBeenCalled();
  });

  it('fails open when an uncached album member has no download URL', async () => {
    const { service, historyStore } = createService([null]);

    await expect(
      service.analyzeAlbum({
        album: album([{ source: 'direct', photoId: 'photo-1', downloadUrl: null }]),
        ttlSeconds: 3_601,
        scope: 'SAME_AUTHOR',
        preset: 'SAME_IMAGE',
        actionEligible: true,
        authorizationConfigDigest,
        allowedViolationMatchKinds: ['canonical_sha256'],
        resolveActionEligibility: jest.fn().mockResolvedValue(true),
      }),
    ).resolves.toEqual({ kind: 'incomplete', reason: 'missing_download_url' });
    expect(historyStore.observeAlbum).not.toHaveBeenCalled();
  });

  it('downgrades a late action latch before observing the violation counter', async () => {
    const cached = fingerprint('a');
    const { service, historyStore } = createService([cached]);
    const resolveActionEligibility = jest.fn().mockResolvedValue(false);

    const result = await service.analyzeAlbum({
      album: album([{ source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' }]),
      ttlSeconds: 3_601,
      scope: 'SAME_AUTHOR',
      preset: 'SAME_IMAGE',
      actionEligible: true,
      authorizationConfigDigest,
      allowedViolationMatchKinds: ['canonical_sha256'],
      resolveActionEligibility,
    });

    expect(resolveActionEligibility).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: 'observed', actionEligible: false });
    expect(historyStore.observeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({ eligible: false }),
      }),
    );
  });

  it('keeps a disallowed PDQ observation non-actionable after matching', async () => {
    const cached = fingerprint('a');
    const { service, historyStore } = createService([cached]);
    historyStore.observeAlbum.mockResolvedValueOnce({
      kind: 'available',
      inserted: true,
      replayed: false,
      classification: 'duplicate',
      clusterId: 'd'.repeat(64),
      matchKind: 'pdq',
      matchedDistance: 4,
      repeatCount: 0,
      duplicateOfMessageId: 'message-0',
      sanctionClusterId: 'e'.repeat(64),
      violationCommitted: false,
      authorization: {
        authorized: false,
        configDigest: authorizationConfigDigest,
      },
    });

    await expect(
      service.analyzeAlbum({
        album: album([
          { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' },
        ]),
        ttlSeconds: 3_601,
        scope: 'SAME_AUTHOR',
        preset: 'SAME_IMAGE',
        actionEligible: true,
        authorizationConfigDigest,
        allowedViolationMatchKinds: ['canonical_sha256'],
        resolveActionEligibility: jest.fn().mockResolvedValue(true),
      }),
    ).resolves.toMatchObject({ kind: 'observed', actionEligible: false });
    expect(historyStore.observeAlbum).toHaveBeenCalledWith(
      expect.not.objectContaining({ commitViolation: expect.anything() }),
    );
  });

  it('keeps an authorized replay non-actionable when its first-write config digest differs', async () => {
    const cached = fingerprint('a');
    const { service, historyStore } = createService([cached]);
    historyStore.observeAlbum.mockResolvedValueOnce({
      kind: 'available',
      inserted: false,
      replayed: true,
      classification: 'duplicate',
      clusterId: 'd'.repeat(64),
      matchKind: 'canonical_sha256',
      matchedDistance: 0,
      repeatCount: 1,
      duplicateOfMessageId: 'message-0',
      sanctionClusterId: 'e'.repeat(64),
      violationCommitted: false,
      authorization: {
        authorized: true,
        configDigest: '1'.repeat(64),
      },
    });

    await expect(
      service.analyzeAlbum({
        album: album([
          { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' },
        ]),
        ttlSeconds: 3_601,
        scope: 'SAME_AUTHOR',
        preset: 'SAME_IMAGE',
        actionEligible: true,
        authorizationConfigDigest,
        allowedViolationMatchKinds: ['canonical_sha256'],
        resolveActionEligibility: jest.fn().mockResolvedValue(true),
      }),
    ).resolves.toMatchObject({ kind: 'observed', actionEligible: false });
  });

  it('delegates the guarded violation commit with the exact observed identity', async () => {
    const cached = fingerprint('a');
    const { service, historyStore } = createService([cached]);
    const logicalAlbum = album([
      { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' },
    ]);

    await expect(
      service.commitViolation({
        album: logicalAlbum,
        albumHash: 'a'.repeat(64),
        ttlSeconds: 3_601,
        scope: 'SAME_AUTHOR',
        preset: 'SAME_IMAGE',
        observationClusterId: 'd'.repeat(64),
        matchKind: 'canonical_sha256',
        expectedRepeatCount: 1,
        allowedMatchKinds: ['canonical_sha256'],
        authorizationConfigDigest,
        actionBinding: {
          intendedAction: 'HIT',
          configDigest: actionConfigDigest,
        },
      }),
    ).resolves.toMatchObject({ kind: 'available', committed: true });
    expect(historyStore.commitViolation).toHaveBeenCalledWith({
      chatId: logicalAlbum.chatId,
      senderId: logicalAlbum.senderId,
      messageId: logicalAlbum.messageId,
      ttlSeconds: 3_601,
      scope: 'SAME_AUTHOR',
      fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
      albumHash: 'a'.repeat(64),
      perceptualPreset: 'SAME_IMAGE',
      observationClusterId: 'd'.repeat(64),
      matchKind: 'canonical_sha256',
      expectedRepeatCount: 1,
      allowedMatchKinds: ['canonical_sha256'],
      authorizationConfigDigest,
      actionBinding: {
        intendedAction: 'HIT',
        configDigest: actionConfigDigest,
      },
    });
  });

  it('does not observe when action eligibility resolution rejects', async () => {
    const cached = fingerprint('a');
    const { service, historyStore } = createService([cached]);
    const resolveActionEligibility = jest.fn().mockRejectedValue(new Error('redis unavailable'));

    await expect(
      service.analyzeAlbum({
        album: album([
          { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' },
        ]),
        ttlSeconds: 3_601,
        scope: 'SAME_AUTHOR',
        preset: 'SAME_IMAGE',
        actionEligible: true,
        authorizationConfigDigest,
        allowedViolationMatchKinds: ['canonical_sha256'],
        resolveActionEligibility,
      }),
    ).rejects.toThrow('redis unavailable');

    expect(historyStore.observeAlbum).not.toHaveBeenCalled();
  });
});
