import { ServiceUnavailableException } from '@nestjs/common';

import { MAX_CHANNEL_DIALOG_SUGGEST_IMAGES } from '@maxim/contracts';
import type { ChannelSuggestionImageAsset } from './admin.service.support';
import type { AdminChannelSuggestionImageRuntimeContext } from './admin-channel-suggestion-image-runtime-context';

export class AdminChannelSuggestionImageRuntime {
  constructor(private readonly context: AdminChannelSuggestionImageRuntimeContext) {}

  async loadStoredImages(
    auditLogId: string,
    payload: Record<string, unknown>,
  ): Promise<ChannelSuggestionImageAsset[]> {
    const legacyImages = this.context.normalizeChannelSuggestionImages({
      images: this.context.readChannelSuggestionImageAssets(payload.images),
      imageBase64: this.context.readTrimmedString(payload.imageBase64),
      imageMimeType: this.context.readTrimmedString(payload.imageMimeType),
      imageFileName: this.context.readTrimmedString(payload.imageFileName),
      mediaType: this.context.readChannelSuggestionMediaType(payload.mediaType),
      mediaPayload: this.context.readObjectPayloadOrNull(payload.mediaPayload),
      mediaMimeType: this.context.readTrimmedString(payload.mediaMimeType),
      mediaFileName: this.context.readTrimmedString(payload.mediaFileName),
    });
    const storageVersion = payload.imageStorageVersion;
    const relationRequired = storageVersion === 1;
    const hasUnsupportedStorageVersion =
      storageVersion !== undefined && storageVersion !== null && !relationRequired;
    const declaredImageCount = this.readDeclaredImageCount(payload.imageCount);
    const persistedRows = await this.context.prisma.channelSuggestionImageAsset.findMany({
      where: { auditLogId },
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

    if (persistedRows.length === 0) {
      if (
        hasUnsupportedStorageVersion ||
        (relationRequired && (declaredImageCount === null || declaredImageCount !== 0))
      ) {
        return this.handleInconsistentAssets({
          auditLogId,
          declaredImageCount,
          legacyImages,
          persistedRows,
          relationRequired: true,
          storageVersion,
        });
      }
      return legacyImages;
    }

    const images = persistedRows.map((row, index) => {
      const bytes = row.bytes ? Buffer.from(row.bytes) : null;
      const durablePayload = this.context.readObjectPayloadOrNull(row.durablePayload);
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
        mimeType: this.context.readTrimmedString(row.mimeType),
        fileName: this.context.readTrimmedString(row.fileName),
      } satisfies ChannelSuggestionImageAsset;
    });

    const relationCountMatches = relationRequired
      ? declaredImageCount !== null && persistedRows.length === declaredImageCount
      : (declaredImageCount === null || persistedRows.length === declaredImageCount) &&
        (legacyImages.length === 0 || persistedRows.length === legacyImages.length) &&
        (declaredImageCount !== null || legacyImages.length > 0);
    if (
      hasUnsupportedStorageVersion ||
      persistedRows.length > MAX_CHANNEL_DIALOG_SUGGEST_IMAGES ||
      images.some((image) => image === null) ||
      !relationCountMatches
    ) {
      return this.handleInconsistentAssets({
        auditLogId,
        declaredImageCount,
        legacyImages,
        persistedRows,
        relationRequired: relationRequired || hasUnsupportedStorageVersion,
        storageVersion,
      });
    }

    return images as ChannelSuggestionImageAsset[];
  }

  private readDeclaredImageCount(value: unknown): number | null {
    return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= MAX_CHANNEL_DIALOG_SUGGEST_IMAGES
      ? value
      : null;
  }

  private handleInconsistentAssets(params: {
    auditLogId: string;
    declaredImageCount: number | null;
    legacyImages: ChannelSuggestionImageAsset[];
    persistedRows: Array<{ position: number }>;
    relationRequired: boolean;
    storageVersion: unknown;
  }): ChannelSuggestionImageAsset[] {
    this.context.logger.error(
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
}
