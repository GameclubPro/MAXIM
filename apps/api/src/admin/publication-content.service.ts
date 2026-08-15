import {
  type PublicationContentInput,
  type PublicationMediaInput,
  type TestPublicationRequest,
} from '@maxim/contracts/publication';
import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MaxClientService } from '../max/max-client.service';
import { MaxMediaUploadValidationError } from '../max/max-media-upload-validation';
import { Prisma, PublicationContentFormat } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  hasPublicationVideoInternalMarker,
  PUBLICATION_MAX_VIDEO_BYTES,
  PUBLICATION_VIDEO_ASSET_ID_FIELD,
  PUBLICATION_VIDEO_INLINE_BASE64_FIELD,
} from './publication-video-media';
import {
  PUBLICATION_MAX_IMAGE_BYTES,
  PUBLICATION_MAX_TOTAL_IMAGE_BYTES,
} from './publication-media-limits';
import { canonicalizeAdminMaxMediaFileName } from './admin-max-media-file-name';

const PUBLICATION_VIDEO_MIME_TYPE_FALLBACK = 'application/octet-stream';

type PersistedAssetInput = {
  sha256: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  bytes: Buffer | null;
  durablePayload: Prisma.InputJsonValue | null;
  expectedType: 'image' | 'video';
  existingAssetId?: string;
};

type PreparedAssetInput =
  | {
      kind: 'reference';
      assetId: string;
      expectedType: 'image' | 'video';
    }
  | ({ kind: 'prepared' } & Omit<PersistedAssetInput, 'existingAssetId'>);

export type PreparedPublicationContentRevision = {
  text: string;
  textFormat: PublicationContentInput['textFormat'];
  buttons: PublicationContentInput['buttons'];
  assets: PreparedAssetInput[];
};

@Injectable()
export class PublicationContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
  ) {}

  async prepareContentRevision(
    content: PublicationContentInput,
  ): Promise<PreparedPublicationContentRevision> {
    return {
      text: content.text,
      textFormat: content.textFormat,
      buttons: content.buttons,
      assets: await this.prepareAssetInputs(content.media),
    };
  }

  async persistPreparedContentRevision(
    tx: any,
    publicationId: string,
    revision: number,
    content: PreparedPublicationContentRevision,
    actorUserId: string,
  ): Promise<{ id: string }> {
    const assets = await this.resolvePersistedAssetInputs(tx, content.assets, actorUserId);
    const contentRevision = await tx.publicationContentRevision.create({
      data: {
        publicationId,
        revision,
        text: content.text,
        textFormat:
          content.textFormat === 'markdown'
            ? PublicationContentFormat.MARKDOWN
            : PublicationContentFormat.PLAIN,
        buttons: content.buttons as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    const linkedAssetIds = new Set<string>();
    for (const [position, assetInput] of assets.entries()) {
      const asset = assetInput.existingAssetId
        ? { id: assetInput.existingAssetId }
        : await tx.publicationAsset.upsert({
            where: {
              actorUserId_sha256: {
                actorUserId,
                sha256: assetInput.sha256,
              },
            },
            create: {
              actorUserId,
              sha256: assetInput.sha256,
              mimeType: assetInput.mimeType,
              fileName: assetInput.fileName,
              sizeBytes: assetInput.sizeBytes,
              bytes: assetInput.bytes,
              durablePayload: assetInput.durablePayload ?? Prisma.DbNull,
            },
            update: {},
            select: { id: true },
          });
      if (linkedAssetIds.has(asset.id)) {
        throw new BadRequestException('Один и тот же медиафайл добавлен несколько раз.');
      }
      linkedAssetIds.add(asset.id);
      await tx.publicationContentAsset.create({
        data: {
          contentRevisionId: contentRevision.id,
          assetId: asset.id,
          position,
        },
      });
    }
    return contentRevision;
  }

  async buildLegacyTestPayload(request: TestPublicationRequest, actorUserId: string) {
    const images: Array<{ base64: string; mimeType: string; fileName: string }> = [];
    let video: { payload: Record<string, unknown>; mimeType: string; fileName: string } | null =
      null;
    for (const media of request.content.media) {
      if (media.type === 'image') {
        images.push({ base64: media.base64, mimeType: media.mimeType, fileName: media.fileName });
      } else if (media.type === 'video') {
        if (media.base64) {
          const bytes = this.decodeAndValidateVideo(media.base64);
          const validated = await this.mapMaxMediaValidation(
            this.maxClient.validateMediaUploadPayload('video', bytes),
          );
          video = {
            payload: { [PUBLICATION_VIDEO_INLINE_BASE64_FIELD]: bytes.toString('base64') },
            mimeType: validated.mimeType,
            fileName: canonicalizeAdminMaxMediaFileName(
              media.fileName,
              validated.extension,
              'publication-video',
            ),
          };
        }
        if (media.payload) {
          this.assertPublicVideoPayload(media.payload);
          video = { payload: media.payload, mimeType: media.mimeType, fileName: media.fileName };
        }
      } else {
        const asset = await this.prisma.publicationAsset.findFirst({
          where: {
            id: media.assetId,
            actorUserId,
            contentLinks: {
              some: { contentRevision: { publication: { actorUserId } } },
            },
          },
        });
        if (!asset) {
          throw new BadRequestException('Медиа публикации больше недоступно.');
        }
        if (media.type === 'image-ref') {
          if (!asset.bytes) {
            throw new BadRequestException('Фото публикации повреждено.');
          }
          images.push({
            base64: Buffer.from(asset.bytes).toString('base64'),
            mimeType: asset.mimeType,
            fileName: asset.fileName,
          });
        } else {
          const payload = this.readJsonObject(asset.durablePayload);
          if (!payload) {
            if (asset.bytes && asset.mimeType.toLowerCase().startsWith('video/')) {
              video = {
                payload: { [PUBLICATION_VIDEO_ASSET_ID_FIELD]: asset.id },
                mimeType: asset.mimeType,
                fileName: asset.fileName,
              };
              continue;
            }
            throw new BadRequestException('Видео публикации повреждено.');
          }
          video = { payload, mimeType: asset.mimeType, fileName: asset.fileName };
        }
      }
    }
    return {
      requestId: request.requestId,
      text: request.content.text,
      textFormat: request.content.textFormat,
      targetMode: 'current',
      targetChatIds: [],
      applyToAllChats: false,
      buttons: request.content.buttons.map(({ text, url }) => ({ text, url })),
      imageEnabled: images.length > 0,
      imageBase64: images[0]?.base64 ?? '',
      imageMimeType: images[0]?.mimeType ?? '',
      imageFileName: images[0]?.fileName ?? '',
      images,
      mediaType: video ? 'video' : images.length > 1 ? 'image' : null,
      mediaPayload: video ? video.payload : images.length > 1 ? { images } : null,
      mediaMimeType: video?.mimeType ?? '',
      mediaFileName: video?.fileName ?? '',
      scheduleTimezone: 'Europe/Moscow',
      scheduledSlots: [],
      sendAt: null,
      cycleEnabled: false,
      cycleCount: 1,
    };
  }

  private async prepareAssetInputs(media: PublicationMediaInput[]): Promise<PreparedAssetInput[]> {
    const prepared: PreparedAssetInput[] = [];
    let totalImageBytes = 0;
    for (const item of media) {
      if (item.type === 'image-ref' || item.type === 'video-ref') {
        prepared.push({
          kind: 'reference',
          assetId: item.assetId,
          expectedType: item.type === 'video-ref' ? 'video' : 'image',
        });
        continue;
      }
      if (item.type === 'image') {
        const bytes = this.decodeImageBase64(item.base64);
        if (bytes.length > PUBLICATION_MAX_IMAGE_BYTES) {
          throw new BadRequestException('Фото слишком большое. Максимум 8 МБ.');
        }
        const validated = await this.mapMaxMediaValidation(
          this.maxClient.validateMediaUploadPayload('image', bytes),
        );
        totalImageBytes += bytes.length;
        prepared.push({
          kind: 'prepared',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          mimeType: validated.mimeType,
          fileName: canonicalizeAdminMaxMediaFileName(
            item.fileName,
            validated.extension,
            'publication-image',
          ),
          sizeBytes: bytes.length,
          bytes,
          durablePayload: null,
          expectedType: 'image',
        });
        continue;
      }
      if (item.base64) {
        const bytes = this.decodeAndValidateVideo(item.base64);
        const validated = await this.mapMaxMediaValidation(
          this.maxClient.validateMediaUploadPayload('video', bytes),
        );
        prepared.push({
          kind: 'prepared',
          sha256: createHash('sha256').update('video-bytes:').update(bytes).digest('hex'),
          mimeType: validated.mimeType,
          fileName: canonicalizeAdminMaxMediaFileName(
            item.fileName,
            validated.extension,
            'publication-video',
          ),
          sizeBytes: bytes.length,
          bytes,
          durablePayload: null,
          expectedType: 'video',
        });
        continue;
      }
      if (!item.payload) {
        throw new BadRequestException('Добавьте видеофайл или сохранённое видео.');
      }
      this.assertPublicVideoPayload(item.payload);
      const stablePayload = this.stableStringify(item.payload);
      prepared.push({
        kind: 'prepared',
        sha256: createHash('sha256').update(`video:${stablePayload}`).digest('hex'),
        mimeType: item.mimeType || PUBLICATION_VIDEO_MIME_TYPE_FALLBACK,
        fileName: item.fileName,
        sizeBytes: Buffer.byteLength(stablePayload),
        bytes: null,
        durablePayload: item.payload as Prisma.InputJsonValue,
        expectedType: 'video',
      });
    }
    if (totalImageBytes > PUBLICATION_MAX_TOTAL_IMAGE_BYTES) {
      throw new BadRequestException('Суммарный размер фото превышает 24 МБ.');
    }
    return prepared;
  }

  private async resolvePersistedAssetInputs(
    tx: any,
    prepared: PreparedAssetInput[],
    actorUserId: string,
  ): Promise<PersistedAssetInput[]> {
    const resolved: PersistedAssetInput[] = [];
    let totalImageBytes = 0;
    for (const item of prepared) {
      if (item.kind === 'reference') {
        const asset = await tx.publicationAsset.findFirst({
          where: {
            id: item.assetId,
            actorUserId,
            contentLinks: {
              some: { contentRevision: { publication: { actorUserId } } },
            },
          },
        });
        if (!asset) {
          throw new BadRequestException('Медиа публикации больше недоступно.');
        }
        const actualType =
          asset.durablePayload || asset.mimeType.toLowerCase().startsWith('video/')
            ? 'video'
            : 'image';
        if (actualType !== item.expectedType) {
          throw new BadRequestException('Тип сохранённого медиа не совпадает.');
        }
        if (actualType === 'image') {
          totalImageBytes += asset.sizeBytes;
        }
        resolved.push({
          sha256: asset.sha256,
          mimeType: asset.mimeType,
          fileName: asset.fileName,
          sizeBytes: asset.sizeBytes,
          bytes: null,
          durablePayload: null,
          expectedType: item.expectedType,
          existingAssetId: asset.id,
        });
        continue;
      }

      if (item.expectedType === 'image') {
        totalImageBytes += item.sizeBytes;
      }
      resolved.push({
        sha256: item.sha256,
        mimeType: item.mimeType,
        fileName: item.fileName,
        sizeBytes: item.sizeBytes,
        bytes: item.bytes,
        durablePayload: item.durablePayload,
        expectedType: item.expectedType,
      });
    }
    if (totalImageBytes > PUBLICATION_MAX_TOTAL_IMAGE_BYTES) {
      throw new BadRequestException('Суммарный размер фото превышает 24 МБ.');
    }
    return resolved;
  }

  private decodeImageBase64(value: string): Buffer {
    const normalized = value.trim().replace(/^data:[^;]+;base64,/u, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) {
      throw new BadRequestException('Фото повреждено. Добавьте файл заново.');
    }
    const bytes = Buffer.from(normalized, 'base64');
    if (bytes.length === 0) {
      throw new BadRequestException('Фото пустое.');
    }
    return bytes;
  }

  private async mapMaxMediaValidation<T>(validation: Promise<T>): Promise<T> {
    try {
      return await validation;
    } catch (error: unknown) {
      if (error instanceof MaxMediaUploadValidationError) {
        throw new BadRequestException(error.publicMessage);
      }
      throw error;
    }
  }

  private decodeVideoBase64(value: string): Buffer {
    const normalized = value.trim().replace(/^data:[^;]+;base64,/u, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) {
      throw new BadRequestException('Видео повреждено. Добавьте файл заново.');
    }
    const bytes = Buffer.from(normalized, 'base64');
    if (bytes.length === 0) {
      throw new BadRequestException('Видео пустое.');
    }
    return bytes;
  }

  private decodeAndValidateVideo(value: string): Buffer {
    const bytes = this.decodeVideoBase64(value);
    if (bytes.length > PUBLICATION_MAX_VIDEO_BYTES) {
      throw new BadRequestException('Видео слишком большое. Максимум 24 МБ.');
    }
    return bytes;
  }

  private assertPublicVideoPayload(value: Record<string, unknown>): void {
    if (hasPublicationVideoInternalMarker(value)) {
      throw new BadRequestException('Сохранённое видео больше недоступно.');
    }
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.stableStringify(item)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  private readJsonObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
}
