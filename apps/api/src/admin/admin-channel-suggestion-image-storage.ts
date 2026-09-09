import {
  MAX_CHANNEL_DIALOG_SUGGEST_IMAGES,
  MAX_CHANNEL_SUGGESTION_VIDEO_BYTES,
  type ChannelSuggestionVideoInput,
} from '@maxim/contracts';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';

import {
  MaxMediaUploadValidationError,
  type MaxValidatedImageUpload,
  validateMaxMediaUploadPayload,
} from '../max/max-media-upload-validation';
import { canonicalizeAdminMaxMediaFileName } from './admin-max-media-file-name';
import {
  PUBLICATION_MAX_IMAGE_BYTES,
  PUBLICATION_MAX_TOTAL_IMAGE_BYTES,
} from './publication-media-limits';
import type { ChannelSuggestionImageAsset } from './admin.service.support';

export const CHANNEL_SUGGESTION_IMAGE_STORAGE_VERSION = 1;
export const CHANNEL_SUGGESTION_VIDEO_STORAGE_VERSION = 1;

export async function prepareChannelSuggestionMediaRows(
  images: readonly ChannelSuggestionImageInput[],
  video?: ChannelSuggestionVideoInput,
): Promise<PreparedChannelSuggestionImageRow[]> {
  if (!video) return prepareChannelSuggestionImageRows(images);
  if (images.length)
    throw new BadRequestException('Фото и видео отправляются отдельными предложениями.');
  const bytes = decodeChannelSuggestionImageBase64(video.base64, 'Видео');
  if (bytes.length > MAX_CHANNEL_SUGGESTION_VIDEO_BYTES)
    throw new BadRequestException('Видео слишком большое. Максимум 24 МБ.');
  try {
    const validated = await validateMaxMediaUploadPayload('video', bytes);
    return [
      {
        position: 0,
        bytes: Uint8Array.from(bytes),
        mimeType: validated.mimeType,
        fileName: canonicalizeAdminMaxMediaFileName(
          video.fileName,
          validated.extension,
          'suggestion-video',
        ),
        sizeBytes: bytes.length,
      },
    ];
  } catch (error: unknown) {
    if (error instanceof MaxMediaUploadValidationError)
      throw new BadRequestException(error.publicMessage);
    throw error;
  }
}

export function buildChannelSuggestionMediaMetadata(
  rows: readonly PreparedChannelSuggestionImageRow[],
) {
  const video = rows.find((row) => row.mimeType.startsWith('video/'));
  return video
    ? {
        hasImage: false,
        imageCount: 0,
        hasVideo: true,
        videoFileName: video.fileName,
        mediaType: 'video',
        mediaFileName: video.fileName,
        mediaMimeType: video.mimeType,
        // FLAG: Pre-video readers must reject this format on rollback, not publish only text.
        imageStorageVersion: 2,
        videoStorageVersion: CHANNEL_SUGGESTION_VIDEO_STORAGE_VERSION,
      }
    : {
        hasImage: rows.length > 0,
        imageCount: rows.length,
        hasVideo: false,
        imageFileNames: rows.map((row) => row.fileName),
        imageStorageVersion: CHANNEL_SUGGESTION_IMAGE_STORAGE_VERSION,
      };
}

export type ChannelSuggestionImageInput = {
  base64: string;
  mimeType: string;
  fileName: string;
};

export type PreparedChannelSuggestionImageRow = {
  position: number;
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
};

type StoredChannelSuggestionImageRow = {
  position: number;
  bytes: Uint8Array | null;
  durablePayload: unknown;
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
};

type ChannelSuggestionImageRepository = {
  findMany(args: {
    where: { auditLogId: string };
    orderBy: { position: 'asc' };
    take: number;
    select: {
      position: true;
      bytes: true;
      durablePayload: true;
      mimeType: true;
      fileName: true;
      sizeBytes: true;
    };
  }): Promise<StoredChannelSuggestionImageRow[]>;
};

type ChannelSuggestionImageStorageLogger = {
  error(details: unknown, message: string): void;
};

export async function prepareChannelSuggestionImageRows(
  images: readonly ChannelSuggestionImageInput[],
): Promise<PreparedChannelSuggestionImageRow[]> {
  if (images.length > MAX_CHANNEL_DIALOG_SUGGEST_IMAGES) {
    throw new BadRequestException(
      `Можно добавить до ${MAX_CHANNEL_DIALOG_SUGGEST_IMAGES} фотографий.`,
    );
  }

  const prepared: PreparedChannelSuggestionImageRow[] = [];
  const seenHashes = new Set<string>();
  let totalBytes = 0;

  for (const [position, image] of images.entries()) {
    const bytes = decodeChannelSuggestionImageBase64(image.base64);
    if (bytes.length > PUBLICATION_MAX_IMAGE_BYTES) {
      throw new BadRequestException('Фото слишком большое. Максимум 8 МБ.');
    }
    totalBytes += bytes.length;
    if (totalBytes > PUBLICATION_MAX_TOTAL_IMAGE_BYTES) {
      throw new BadRequestException('Суммарный размер фото превышает 24 МБ.');
    }

    let validated: MaxValidatedImageUpload;
    try {
      validated = await validateMaxMediaUploadPayload('image', bytes);
    } catch (error: unknown) {
      if (error instanceof MaxMediaUploadValidationError) {
        throw new BadRequestException(error.publicMessage);
      }
      throw error;
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (seenHashes.has(sha256)) {
      throw new BadRequestException('Один и тот же медиафайл добавлен несколько раз.');
    }
    seenHashes.add(sha256);
    prepared.push({
      position,
      bytes: Uint8Array.from(bytes),
      mimeType: validated.mimeType,
      fileName: canonicalizeAdminMaxMediaFileName(
        image.fileName,
        validated.extension,
        `suggestion-image-${position + 1}`,
      ),
      sizeBytes: bytes.length,
    });
  }

  return prepared;
}

export async function loadStoredChannelSuggestionImages(params: {
  auditLogId: string;
  payload: Record<string, unknown>;
  legacyImages: ChannelSuggestionImageAsset[];
  repository: ChannelSuggestionImageRepository;
  logger: ChannelSuggestionImageStorageLogger;
}): Promise<ChannelSuggestionImageAsset[]> {
  const storageVersion = params.payload.imageStorageVersion;
  const relationRequired = storageVersion === CHANNEL_SUGGESTION_IMAGE_STORAGE_VERSION;
  const hasUnsupportedStorageVersion =
    storageVersion !== undefined && storageVersion !== null && !relationRequired;
  const declaredImageCount = readDeclaredImageCount(params.payload.imageCount);
  const persistedRows = await params.repository.findMany({
    where: { auditLogId: params.auditLogId },
    orderBy: { position: 'asc' },
    take: MAX_CHANNEL_DIALOG_SUGGEST_IMAGES + 1,
    select: {
      position: true,
      bytes: true,
      durablePayload: true,
      mimeType: true,
      fileName: true,
      sizeBytes: true,
    },
  });

  // FLAG: The historical image relation stores opaque media bytes. Video has an explicit
  // storage discriminator so no image path can interpret a video as an image or drop it.
  if (params.payload.videoStorageVersion !== undefined) {
    const row = persistedRows[0];
    if (
      params.payload.videoStorageVersion !== CHANNEL_SUGGESTION_VIDEO_STORAGE_VERSION ||
      params.payload.imageStorageVersion !== 2 ||
      params.payload.hasVideo !== true ||
      params.payload.imageCount !== 0 ||
      persistedRows.length !== 1 ||
      row?.position !== 0 ||
      !row.bytes?.length ||
      row.durablePayload != null ||
      row.sizeBytes !== row.bytes.length ||
      row.bytes.length > MAX_CHANNEL_SUGGESTION_VIDEO_BYTES ||
      !row.mimeType?.startsWith('video/')
    ) {
      throw new ServiceUnavailableException('Видео предложки временно недоступно.');
    }
    return [
      {
        type: 'video',
        base64: Buffer.from(row.bytes).toString('base64'),
        mimeType: row.mimeType,
        fileName: row.fileName,
      },
    ];
  }

  if (persistedRows.length === 0) {
    if (
      hasUnsupportedStorageVersion ||
      (relationRequired && (declaredImageCount === null || declaredImageCount !== 0))
    ) {
      return handleInconsistentAssets({
        ...params,
        declaredImageCount,
        persistedRows,
        relationRequired: true,
        storageVersion,
      });
    }
    return params.legacyImages;
  }

  const images = persistedRows.map((row, index) => {
    const bytes = row.bytes ? Buffer.from(row.bytes) : null;
    const durablePayload = readObject(row.durablePayload);
    const hasBytes = Boolean(bytes && bytes.length > 0);
    const hasDurablePayload = Boolean(durablePayload && Object.keys(durablePayload).length > 0);
    const validStorage =
      hasBytes !== hasDurablePayload &&
      (hasBytes ? row.sizeBytes === bytes?.length : row.sizeBytes === null);

    if (row.position !== index || !validStorage) {
      return null;
    }

    return {
      ...(bytes ? { base64: bytes.toString('base64') } : { payload: durablePayload }),
      mimeType: readTrimmedString(row.mimeType),
      fileName: readTrimmedString(row.fileName),
    } satisfies ChannelSuggestionImageAsset;
  });

  const relationCountMatches = relationRequired
    ? declaredImageCount !== null && persistedRows.length === declaredImageCount
    : (declaredImageCount === null || persistedRows.length === declaredImageCount) &&
      (params.legacyImages.length === 0 || persistedRows.length === params.legacyImages.length) &&
      (declaredImageCount !== null || params.legacyImages.length > 0);
  if (
    hasUnsupportedStorageVersion ||
    persistedRows.length > MAX_CHANNEL_DIALOG_SUGGEST_IMAGES ||
    images.some((image) => image === null) ||
    !relationCountMatches
  ) {
    return handleInconsistentAssets({
      ...params,
      declaredImageCount,
      persistedRows,
      relationRequired: relationRequired || hasUnsupportedStorageVersion,
      storageVersion,
    });
  }

  return images as ChannelSuggestionImageAsset[];
}

export function readLegacyChannelSuggestionImages(
  payload: Record<string, unknown>,
): ChannelSuggestionImageAsset[] {
  const images = Array.isArray(payload.images)
    ? payload.images
        .map((value) => readLegacyImage(value))
        .filter((value): value is ChannelSuggestionImageAsset => value !== null)
        .slice(0, MAX_CHANNEL_DIALOG_SUGGEST_IMAGES)
    : [];
  if (images.length > 0) return images;

  const mediaType = readTrimmedString(payload.mediaType)?.toLowerCase();
  const mediaPayload = readObject(payload.mediaPayload);
  if (mediaType === 'image' && mediaPayload && Object.keys(mediaPayload).length > 0) {
    return [
      {
        payload: mediaPayload,
        mimeType: readTrimmedString(payload.mediaMimeType),
        fileName: readTrimmedString(payload.mediaFileName),
      },
    ];
  }

  const base64 = readTrimmedString(payload.imageBase64);
  return base64
    ? [
        {
          base64,
          mimeType: readTrimmedString(payload.imageMimeType),
          fileName: readTrimmedString(payload.imageFileName),
        },
      ]
    : [];
}

function decodeChannelSuggestionImageBase64(value: string, label = 'Фото'): Buffer {
  const normalized = value.trim().replace(/^data:[^;]+;base64,/u, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) {
    throw new BadRequestException(`${label} повреждено. Добавьте файл заново.`);
  }
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.length === 0) {
    throw new BadRequestException(`${label} пустое.`);
  }
  return bytes;
}

function readDeclaredImageCount(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_CHANNEL_DIALOG_SUGGEST_IMAGES
    ? value
    : null;
}

function handleInconsistentAssets(params: {
  auditLogId: string;
  declaredImageCount: number | null;
  legacyImages: ChannelSuggestionImageAsset[];
  persistedRows: Array<{ position: number }>;
  relationRequired: boolean;
  storageVersion: unknown;
  logger: ChannelSuggestionImageStorageLogger;
}): ChannelSuggestionImageAsset[] {
  params.logger.error(
    {
      auditLogId: params.auditLogId,
      assetCount: params.persistedRows.length,
      assetPositions: params.persistedRows.map((row) => row.position),
      declaredImageCount: params.declaredImageCount,
      legacyImageCount: params.legacyImages.length,
      relationRequired: params.relationRequired,
      storageVersion: params.storageVersion ?? null,
    },
    'Stored channel suggestion image assets are inconsistent',
  );
  if (params.relationRequired) {
    throw new ServiceUnavailableException('Медиа предложки временно недоступно.');
  }
  return params.legacyImages;
}

function readLegacyImage(value: unknown): ChannelSuggestionImageAsset | null {
  const row = readObject(value);
  if (!row) return null;
  const durablePayload = readObject(row.payload);
  if (durablePayload && Object.keys(durablePayload).length > 0) {
    return {
      payload: durablePayload,
      mimeType: readTrimmedString(row.mimeType),
      fileName: readTrimmedString(row.fileName),
    };
  }
  const base64 = readTrimmedString(row.base64);
  return base64
    ? {
        base64,
        mimeType: readTrimmedString(row.mimeType),
        fileName: readTrimmedString(row.fileName),
      }
    : null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
