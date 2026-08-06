import { Injectable } from '@nestjs/common';
import type { LogicalPhotoAlbum } from './photo-attachment-extractor';
import {
  createPhotoAlbumFingerprint,
  PHOTO_FINGERPRINT_ALGORITHM_VERSION,
  type PhotoFingerprint,
  PhotoFingerprintRejectedError,
  type PhotoFingerprintRejectionReason,
  type PhotoMatchPreset,
  PhotoFingerprintService,
} from './photo-fingerprint';
import {
  PhotoDuplicateHistoryStore,
  type PhotoDuplicateScope,
  type PhotoHistoryObservationResult,
} from './photo-duplicate-history.store';
import { SecurePhotoDownloader } from './secure-photo-downloader';

export type PhotoDuplicateAnalysisResult =
  | {
      kind: 'incomplete';
      reason: 'missing_download_url' | PhotoFingerprintRejectionReason;
    }
  | {
      kind: 'observed';
      albumHash: string;
      imageCount: number;
      actionEligible: boolean;
      observation: PhotoHistoryObservationResult;
    };

@Injectable()
export class PhotoDuplicateAnalysisService {
  constructor(
    private readonly downloader: SecurePhotoDownloader,
    private readonly fingerprintService: PhotoFingerprintService,
    private readonly historyStore: PhotoDuplicateHistoryStore,
  ) {}

  async analyzeAlbum(params: {
    album: LogicalPhotoAlbum;
    ttlSeconds: number;
    scope: PhotoDuplicateScope;
    preset: PhotoMatchPreset;
    commitViolation: boolean;
    resolveActionEligibility: () => Promise<boolean>;
  }): Promise<PhotoDuplicateAnalysisResult> {
    const cachedFingerprints = await this.readCachedFingerprints(params.album);
    const missingDownloadUrl = params.album.images.some(
      (image, index) => !cachedFingerprints[index] && !image.downloadUrl,
    );
    if (missingDownloadUrl) {
      return { kind: 'incomplete', reason: 'missing_download_url' };
    }

    const albumBudget = this.fingerprintService.createAlbumDecodeBudget();
    const completeFingerprints: PhotoFingerprint[] = [];
    for (let index = 0; index < params.album.images.length; index += 1) {
      const cached = cachedFingerprints[index];
      if (cached) {
        completeFingerprints.push(cached);
        continue;
      }

      const image = params.album.images[index];
      const downloaded = await this.downloader.download(image.downloadUrl!);
      try {
        completeFingerprints.push(
          await this.fingerprintService.fingerprint(downloaded.bytes, {
            albumBudget,
            expectedFormat: downloaded.format,
          }),
        );
      } catch (error: unknown) {
        if (error instanceof PhotoFingerprintRejectedError) {
          return { kind: 'incomplete', reason: error.reason };
        }
        throw error;
      }
    }

    await this.cacheDownloadedFingerprints(
      params.album,
      cachedFingerprints,
      completeFingerprints,
      params.ttlSeconds,
    );

    const albumFingerprint = createPhotoAlbumFingerprint(completeFingerprints);
    const currentActionEligibility = await params.resolveActionEligibility();
    const actionEligible = params.commitViolation && currentActionEligibility;
    const observation = await this.historyStore.observeAlbum({
      chatId: params.album.chatId,
      senderId: params.album.senderId,
      messageId: params.album.messageId,
      occurredAtMs: params.album.createdAtMs,
      ttlSeconds: params.ttlSeconds,
      scope: params.scope,
      fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
      albumHash: albumFingerprint.albumHash,
      exactMatchKind: 'canonical_sha256',
      perceptualAlbum: albumFingerprint,
      allowPerceptualMatch: true,
      perceptualPreset: params.preset,
      commitViolation: actionEligible,
    });

    return {
      kind: 'observed',
      albumHash: albumFingerprint.albumHash,
      imageCount: albumFingerprint.images.length,
      actionEligible,
      observation,
    };
  }

  private async readCachedFingerprints(
    album: LogicalPhotoAlbum,
  ): Promise<Array<PhotoFingerprint | null>> {
    const photoIds = album.images.map((image) => image.photoId);
    if (photoIds.some((photoId) => !photoId)) {
      return album.images.map(() => null);
    }

    const lookup = await this.historyStore.getCachedPhotoFingerprints(photoIds as string[]);
    return lookup.kind === 'available' ? lookup.fingerprints : album.images.map(() => null);
  }

  private async cacheDownloadedFingerprints(
    album: LogicalPhotoAlbum,
    cached: readonly (PhotoFingerprint | null)[],
    fingerprints: readonly PhotoFingerprint[],
    ttlSeconds: number,
  ): Promise<void> {
    const entries = new Map<string, PhotoFingerprint>();
    album.images.forEach((image, index) => {
      if (image.photoId && !cached[index] && fingerprints[index]) {
        entries.set(image.photoId, fingerprints[index]);
      }
    });
    if (entries.size === 0) {
      return;
    }

    await this.historyStore.cachePhotoFingerprints(
      Array.from(entries, ([photoId, fingerprint]) => ({ photoId, fingerprint })),
      ttlSeconds,
    );
  }
}
