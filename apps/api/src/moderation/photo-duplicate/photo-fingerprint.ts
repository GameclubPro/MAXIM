import { createHash } from 'node:crypto';
import type { OnModuleInit } from '@nestjs/common';
import { PDQ } from 'pdq-wasm';
import sharp from 'sharp';
import {
  PhotoDecodeBudget,
  PhotoDecodePipelineCapacityError,
  PhotoDecodePipelineGate,
} from './photo-decode-resource';

export const PHOTO_FINGERPRINT_ALGORITHM_VERSION = 'sharp-rgb512-pdq-v2';
export const PHOTO_PLATFORM_ID_ALGORITHM_VERSION = 'max-photo-id-album-v1';
export const PHOTO_PD_DEFAULT_MIN_QUALITY = 50;
export const PHOTO_PD_SAME_IMAGE_MAX_DISTANCE = 12;
export const PHOTO_PD_MINOR_EDITS_MAX_DISTANCE = 31;

const NORMALIZED_IMAGE_SIZE = 512;
const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_ALBUM_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_ALBUM_INPUT_PIXELS = 160_000_000;
const DEFAULT_MAX_CONCURRENT_PIPELINES = 1;
const DEFAULT_MAX_QUEUED_PIPELINES = 8;
const ALBUM_BUDGET_MULTIPLIER = 2;

export type SupportedPhotoFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'heif' | 'tiff';

export type PhotoFingerprintRejectionReason =
  | 'unsupported_image'
  | 'unsupported_multi_frame'
  | 'album_decode_budget_exceeded'
  | 'decode_capacity_exceeded';

export class PhotoFingerprintRejectedError extends Error {
  constructor(
    readonly reason: PhotoFingerprintRejectionReason,
    options?: { cause?: unknown },
  ) {
    super(`Photo fingerprint rejected: ${reason}`, options);
    this.name = 'PhotoFingerprintRejectedError';
  }
}

export type PhotoFingerprint = {
  algorithmVersion: typeof PHOTO_FINGERPRINT_ALGORITHM_VERSION;
  canonicalHash: string;
  pdqHash: string;
  pdqQuality: number;
};

export type PhotoAlbumFingerprint = {
  algorithmVersion: typeof PHOTO_FINGERPRINT_ALGORITHM_VERSION;
  albumHash: string;
  images: PhotoFingerprint[];
};

export type PhotoMatchPreset = 'SAME_IMAGE' | 'MINOR_EDITS';

export type PhotoAlbumMatch = {
  matched: boolean;
  strongestDistance: number | null;
  usedPerceptualHash: boolean;
};

let pdqInitialization: Promise<void> | null = null;

export async function initializePhotoFingerprintRuntime(): Promise<void> {
  // In CommonJS Node, pdq-wasm resolves both pdq.js and pdq.wasm from its installed package.
  // No URL is supplied, so the browser-only CDN branch cannot be selected.
  if (!pdqInitialization) {
    const initialization = PDQ.init().catch((error: unknown) => {
      if (pdqInitialization === initialization) {
        pdqInitialization = null;
      }
      throw error;
    });
    pdqInitialization = initialization;
  }
  await pdqInitialization;
}

export class PhotoFingerprintService implements OnModuleInit {
  private readonly maxInputBytes: number;
  private readonly maxInputPixels: number;
  private readonly maxAlbumInputBytes: number;
  private readonly maxAlbumInputPixels: number;
  private readonly decodeGate: PhotoDecodePipelineGate;

  constructor(
    limits: {
      maxInputBytes?: number;
      maxInputPixels?: number;
      maxAlbumInputBytes?: number;
      maxAlbumInputPixels?: number;
      maxConcurrentPipelines?: number;
      maxQueuedPipelines?: number;
    } = {},
  ) {
    this.maxInputBytes = normalizePositiveInteger(
      limits.maxInputBytes,
      MAX_INPUT_BYTES,
      'maxInputBytes',
    );
    this.maxInputPixels = normalizePositiveInteger(
      limits.maxInputPixels,
      MAX_INPUT_PIXELS,
      'maxInputPixels',
    );
    this.maxAlbumInputBytes = normalizeAlbumLimit(
      limits.maxAlbumInputBytes,
      this.maxInputBytes,
      MAX_ALBUM_INPUT_BYTES,
      'maxAlbumInputBytes',
    );
    this.maxAlbumInputPixels = normalizeAlbumLimit(
      limits.maxAlbumInputPixels,
      this.maxInputPixels,
      MAX_ALBUM_INPUT_PIXELS,
      'maxAlbumInputPixels',
    );
    this.decodeGate = new PhotoDecodePipelineGate(
      normalizePositiveInteger(
        limits.maxConcurrentPipelines,
        DEFAULT_MAX_CONCURRENT_PIPELINES,
        'maxConcurrentPipelines',
      ),
      normalizePositiveInteger(
        limits.maxQueuedPipelines,
        DEFAULT_MAX_QUEUED_PIPELINES,
        'maxQueuedPipelines',
      ),
    );
  }

  async onModuleInit(): Promise<void> {
    await initializePhotoFingerprintRuntime();
  }

  createAlbumDecodeBudget(): PhotoDecodeBudget {
    return new PhotoDecodeBudget({
      maxEncodedBytes: this.maxAlbumInputBytes,
      maxPixels: this.maxAlbumInputPixels,
    });
  }

  async fingerprint(
    encodedImage: Uint8Array,
    options: {
      albumBudget?: PhotoDecodeBudget;
      expectedFormat?: SupportedPhotoFormat;
    } = {},
  ): Promise<PhotoFingerprint> {
    if (encodedImage.byteLength === 0 || encodedImage.byteLength > this.maxInputBytes) {
      throw new Error('Photo input byte length is outside the configured bounds');
    }

    try {
      return await this.decodeGate.run(() => this.fingerprintWithinSlot(encodedImage, options));
    } catch (error: unknown) {
      if (error instanceof PhotoDecodePipelineCapacityError) {
        throw new PhotoFingerprintRejectedError('decode_capacity_exceeded', { cause: error });
      }
      throw error;
    }
  }

  private async fingerprintWithinSlot(
    encodedImage: Uint8Array,
    options: {
      albumBudget?: PhotoDecodeBudget;
      expectedFormat?: SupportedPhotoFormat;
    },
  ): Promise<PhotoFingerprint> {
    const input = Buffer.from(
      encodedImage.buffer,
      encodedImage.byteOffset,
      encodedImage.byteLength,
    );
    const image = sharp(input, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: this.maxInputPixels,
      sequentialRead: true,
    });
    let metadata: Awaited<ReturnType<typeof image.metadata>>;
    try {
      metadata = await image.metadata();
    } catch (error: unknown) {
      throw new PhotoFingerprintRejectedError('unsupported_image', { cause: error });
    }

    if (
      !isSupportedPhotoFormat(metadata.format) ||
      (options.expectedFormat && !formatsAreCompatible(options.expectedFormat, metadata.format))
    ) {
      throw new PhotoFingerprintRejectedError('unsupported_image');
    }
    const pages = metadata.pages ?? 1;
    if (
      !Number.isSafeInteger(pages) ||
      pages !== 1 ||
      (metadata.pageHeight !== undefined && metadata.pageHeight !== metadata.height)
    ) {
      throw new PhotoFingerprintRejectedError('unsupported_multi_frame');
    }

    const width = metadata.width;
    const height = metadata.height;
    if (!width || !height) {
      throw new PhotoFingerprintRejectedError('unsupported_image');
    }
    const pixelCount = width * height;
    if (!Number.isSafeInteger(pixelCount) || pixelCount > this.maxInputPixels) {
      throw new PhotoFingerprintRejectedError('unsupported_image');
    }
    if (
      options.albumBudget &&
      !options.albumBudget.tryReserve({
        encodedBytes: encodedImage.byteLength,
        pixels: pixelCount,
      })
    ) {
      throw new PhotoFingerprintRejectedError('album_decode_budget_exceeded');
    }

    const normalized = await normalizePhotoImage(image);
    const { data, info } = normalized;

    if (
      info.width !== NORMALIZED_IMAGE_SIZE ||
      info.height !== NORMALIZED_IMAGE_SIZE ||
      info.channels !== 3
    ) {
      throw new Error('Photo normalization returned an unexpected pixel layout');
    }

    await initializePhotoFingerprintRuntime();
    const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const pdq = PDQ.hash({
      data: pixels,
      width: info.width,
      height: info.height,
      channels: 3,
    });
    const pdqHash = PDQ.toHex(pdq.hash).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pdqHash)) {
      throw new Error('PDQ returned an invalid fingerprint');
    }

    const canonicalHash = createHash('sha256')
      .update(PHOTO_FINGERPRINT_ALGORITHM_VERSION)
      .update('\0')
      .update(String(info.width))
      .update('x')
      .update(String(info.height))
      .update('\0')
      .update(data)
      .digest('hex');

    return {
      algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
      canonicalHash,
      pdqHash,
      pdqQuality: pdq.quality,
    };
  }
}

function isSupportedPhotoFormat(value: string): value is SupportedPhotoFormat {
  return ['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'].includes(value);
}

async function normalizePhotoImage(image: ReturnType<typeof sharp>) {
  try {
    return await image
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .toColourspace('srgb')
      .removeAlpha()
      .resize({
        width: NORMALIZED_IMAGE_SIZE,
        height: NORMALIZED_IMAGE_SIZE,
        fit: 'contain',
        position: 'centre',
        background: { r: 255, g: 255, b: 255 },
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: false,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error: unknown) {
    throw new PhotoFingerprintRejectedError('unsupported_image', { cause: error });
  }
}

function formatsAreCompatible(expected: SupportedPhotoFormat, decoded: string): boolean {
  return (
    expected === decoded || ((expected === 'avif' || expected === 'heif') && decoded === 'heif')
  );
}

function normalizeAlbumLimit(
  value: number | undefined,
  perImageLimit: number,
  absoluteLimit: number,
  field: string,
): number {
  const derivedLimit =
    perImageLimit > Math.floor(absoluteLimit / ALBUM_BUDGET_MULTIPLIER)
      ? absoluteLimit
      : perImageLimit * ALBUM_BUDGET_MULTIPLIER;
  return Math.min(normalizePositiveInteger(value, derivedLimit, field), absoluteLimit);
}

export function createPhotoAlbumFingerprint(
  images: readonly PhotoFingerprint[],
): PhotoAlbumFingerprint {
  if (images.length === 0) {
    throw new Error('A photo album fingerprint requires at least one image');
  }
  if (images.some((image) => image.algorithmVersion !== PHOTO_FINGERPRINT_ALGORITHM_VERSION)) {
    throw new Error('Photo fingerprint algorithm versions must match');
  }

  const normalizedImages = images.map((image) => ({
    ...image,
    canonicalHash: validateHexHash(image.canonicalHash),
    pdqHash: validateHexHash(image.pdqHash),
    pdqQuality: normalizeBoundedInteger(image.pdqQuality, 0, 0, 100, 'pdqQuality'),
  }));
  const canonicalHashes = normalizedImages.map((image) => image.canonicalHash).sort();
  const albumHash = createHash('sha256')
    .update(PHOTO_FINGERPRINT_ALGORITHM_VERSION)
    .update('\0album\0')
    .update(String(canonicalHashes.length))
    .update('\0')
    .update(canonicalHashes.join('\n'))
    .digest('hex');

  return {
    algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
    albumHash,
    images: normalizedImages,
  };
}

export function createPlatformPhotoAlbumHash(
  photoIds: readonly (string | null | undefined)[],
): string | null {
  if (photoIds.length === 0) {
    return null;
  }
  const normalized = photoIds.map((photoId) => photoId?.trim() ?? '');
  if (normalized.some((photoId) => photoId.length === 0)) {
    return null;
  }

  return createHash('sha256')
    .update(PHOTO_PLATFORM_ID_ALGORITHM_VERSION)
    .update('\0')
    .update(String(normalized.length))
    .update('\0')
    .update(normalized.sort().join('\n'))
    .digest('hex');
}

export function matchPhotoAlbums(
  left: PhotoAlbumFingerprint,
  right: PhotoAlbumFingerprint,
  options: {
    preset: PhotoMatchPreset;
    minPdqQuality?: number;
    sameImageMaxDistance?: number;
    minorEditsMaxDistance?: number;
  },
): PhotoAlbumMatch {
  if (
    left.algorithmVersion !== right.algorithmVersion ||
    left.images.length === 0 ||
    left.images.length !== right.images.length
  ) {
    return { matched: false, strongestDistance: null, usedPerceptualHash: false };
  }
  const leftCanonicalHashes = left.images.map((image) => image.canonicalHash).sort();
  const rightCanonicalHashes = right.images.map((image) => image.canonicalHash).sort();
  if (leftCanonicalHashes.every((hash, index) => hash === rightCanonicalHashes[index])) {
    return { matched: true, strongestDistance: 0, usedPerceptualHash: false };
  }

  const minPdqQuality = normalizeBoundedInteger(
    options.minPdqQuality,
    PHOTO_PD_DEFAULT_MIN_QUALITY,
    0,
    100,
    'minPdqQuality',
  );
  const maxDistance =
    options.preset === 'SAME_IMAGE'
      ? normalizeBoundedInteger(
          options.sameImageMaxDistance,
          PHOTO_PD_SAME_IMAGE_MAX_DISTANCE,
          0,
          256,
          'sameImageMaxDistance',
        )
      : normalizeBoundedInteger(
          options.minorEditsMaxDistance,
          PHOTO_PD_MINOR_EDITS_MAX_DISTANCE,
          0,
          256,
          'minorEditsMaxDistance',
        );

  const candidates = left.images.map((leftImage) =>
    right.images.map((rightImage) => {
      if (leftImage.canonicalHash === rightImage.canonicalHash) {
        return { eligible: true, distance: 0, perceptual: false };
      }
      if (
        leftImage.pdqQuality < minPdqQuality ||
        rightImage.pdqQuality < minPdqQuality ||
        !isHexHash(leftImage.pdqHash) ||
        !isHexHash(rightImage.pdqHash)
      ) {
        return { eligible: false, distance: 257, perceptual: false };
      }
      const distance = hammingDistanceHex(leftImage.pdqHash, rightImage.pdqHash);
      return { eligible: distance <= maxDistance, distance, perceptual: true };
    }),
  );

  // A complete bipartite matching preserves duplicate multiplicity and prevents partial albums
  // from matching. Lower-distance edges are tried first to avoid consuming a scarce candidate.
  const rightOwners = new Array<number>(right.images.length).fill(-1);
  const matchedEdges = new Map<number, { distance: number; perceptual: boolean }>();
  const assign = (leftIndex: number, visited: Set<number>): boolean => {
    const rankedRightIndices = candidates[leftIndex]
      .map((candidate, rightIndex) => ({ candidate, rightIndex }))
      .filter(({ candidate }) => candidate.eligible)
      .sort((a, b) => a.candidate.distance - b.candidate.distance);

    for (const { candidate, rightIndex } of rankedRightIndices) {
      if (visited.has(rightIndex)) {
        continue;
      }
      visited.add(rightIndex);
      const previousOwner = rightOwners[rightIndex];
      if (previousOwner === -1 || assign(previousOwner, visited)) {
        rightOwners[rightIndex] = leftIndex;
        matchedEdges.set(leftIndex, {
          distance: candidate.distance,
          perceptual: candidate.perceptual,
        });
        return true;
      }
    }
    return false;
  };

  for (let leftIndex = 0; leftIndex < left.images.length; leftIndex += 1) {
    if (!assign(leftIndex, new Set())) {
      return { matched: false, strongestDistance: null, usedPerceptualHash: false };
    }
  }

  const edges = [...matchedEdges.values()];
  return {
    matched: true,
    strongestDistance: Math.max(...edges.map((edge) => edge.distance)),
    usedPerceptualHash: edges.some((edge) => edge.perceptual),
  };
}

export function hammingDistanceHex(left: string, right: string): number {
  const normalizedLeft = validateHexHash(left);
  const normalizedRight = validateHexHash(right);
  let distance = 0;
  for (let index = 0; index < normalizedLeft.length; index += 2) {
    let value =
      Number.parseInt(normalizedLeft.slice(index, index + 2), 16) ^
      Number.parseInt(normalizedRight.slice(index, index + 2), 16);
    while (value > 0) {
      distance += value & 1;
      value >>>= 1;
    }
  }
  return distance;
}

function isHexHash(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function validateHexHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isHexHash(normalized)) {
    throw new Error('Photo hash must be a 256-bit hexadecimal value');
  }
  return normalized;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return normalized;
}

function normalizeBoundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return normalized;
}
