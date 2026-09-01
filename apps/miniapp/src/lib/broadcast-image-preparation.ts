import type { BroadcastImage } from '@maxim/contracts';
import { prepareBroadcastImage, type PreparedBroadcastImage } from './broadcast-image';
import {
  appendComposerBroadcastImages,
  BROADCAST_IMAGES_TOTAL_BASE64_MAX,
  getBroadcastImagesBase64Length,
  normalizeComposerBroadcastImages,
  resolveBroadcastImageMaxCount,
} from './broadcast-image-list';

type BroadcastImagePreparer = (
  file: File,
  options: { maxBytes: number },
) => Promise<PreparedBroadcastImage>;

export type ComposerImagePreparationProgress = {
  done: number;
  total: number;
};

export type ComposerImagePreparationResult = {
  images: BroadcastImage[];
  addedCount: number;
  duplicateCount: number;
  oversizedCount: number;
  limitCount: number;
  failedMessages: string[];
  aborted: boolean;
};

type PrepareComposerImageFilesOptions = {
  files: readonly File[];
  currentImages: readonly BroadcastImage[];
  maxImageCount?: number;
  totalBase64Limit?: number;
  signal: AbortSignal;
  prepareImage?: BroadcastImagePreparer;
  onProgress?: (progress: ComposerImagePreparationProgress) => void;
  onImagesReady?: (images: BroadcastImage[]) => void;
};

function readPreparationError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'Не удалось подготовить фото.';
}

export async function prepareComposerImageFiles({
  files,
  currentImages,
  maxImageCount: requestedMaxImageCount,
  totalBase64Limit = BROADCAST_IMAGES_TOTAL_BASE64_MAX,
  signal,
  prepareImage = prepareBroadcastImage,
  onProgress,
  onImagesReady,
}: PrepareComposerImageFilesOptions): Promise<ComposerImagePreparationResult> {
  const maxImageCount = resolveBroadcastImageMaxCount(requestedMaxImageCount);
  let images = normalizeComposerBroadcastImages(currentImages, maxImageCount);
  let addedCount = 0;
  let duplicateCount = 0;
  let oversizedCount = 0;
  let limitCount = 0;
  const failedMessages: string[] = [];

  for (const [index, file] of files.entries()) {
    if (signal.aborted) {
      break;
    }

    try {
      const remainingBase64Budget = totalBase64Limit - getBroadcastImagesBase64Length(images);
      if (remainingBase64Budget <= 0) {
        oversizedCount += 1;
        continue;
      }

      const remainingFileCount = Math.max(1, files.length - index);
      const maxBytes = Math.floor((remainingBase64Budget * 3) / (4 * remainingFileCount));
      const prepared = await prepareImage(file, { maxBytes });
      if (signal.aborted) {
        break;
      }

      const appendResult = appendComposerBroadcastImages(
        images,
        [
          {
            base64: prepared.base64,
            mimeType: prepared.mimeType,
            fileName: prepared.fileName,
          },
        ],
        { maxImageCount, totalBase64Limit },
      );
      duplicateCount += appendResult.duplicateCount;
      oversizedCount += appendResult.oversizedCount;
      limitCount += appendResult.limitCount;
      if (appendResult.addedCount > 0) {
        addedCount += appendResult.addedCount;
        images = appendResult.images;
        onImagesReady?.(images);
      }
    } catch (error) {
      if (!signal.aborted) {
        failedMessages.push(readPreparationError(error));
      }
    } finally {
      if (!signal.aborted) {
        onProgress?.({ done: index + 1, total: files.length });
      }
    }
  }

  return {
    images,
    addedCount,
    duplicateCount,
    oversizedCount,
    limitCount,
    failedMessages,
    aborted: signal.aborted,
  };
}
