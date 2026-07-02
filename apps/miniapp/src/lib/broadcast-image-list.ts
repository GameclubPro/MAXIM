import type { BroadcastImage } from '@maxim/contracts';
import {
  BROADCAST_IMAGES_MAX,
  BROADCAST_IMAGES_TOTAL_BASE64_MAX,
  getBroadcastImagesBase64Length,
  normalizeComposerBroadcastImages,
  resolveBroadcastImageMaxCount,
} from './broadcast-image-list-basic';

export {
  BROADCAST_IMAGES_MAX,
  BROADCAST_IMAGES_TOTAL_BASE64_MAX,
  getBroadcastImagesBase64Length,
  normalizeComposerBroadcastImages,
  resolveBroadcastImageMaxCount,
} from './broadcast-image-list-basic';

export type AppendBroadcastImagesResult = {
  images: BroadcastImage[];
  addedCount: number;
  duplicateCount: number;
  oversizedCount: number;
  limitCount: number;
};

export function appendComposerBroadcastImages(
  currentImages: readonly BroadcastImage[],
  nextImages: readonly BroadcastImage[],
  options: {
    maxImageCount?: number;
    totalBase64Limit?: number;
  } = {},
): AppendBroadcastImagesResult {
  const maxImageCount = resolveBroadcastImageMaxCount(options.maxImageCount);
  const totalBase64Limit = Math.max(0, options.totalBase64Limit ?? BROADCAST_IMAGES_TOTAL_BASE64_MAX);
  const images = normalizeComposerBroadcastImages(currentImages, maxImageCount);
  const seenBase64 = new Set(images.map((image) => image.base64));
  let totalBase64Length = getBroadcastImagesBase64Length(images);
  let addedCount = 0;
  let duplicateCount = 0;
  let oversizedCount = 0;
  let limitCount = 0;

  for (const image of nextImages) {
    const base64 = image.base64.trim();
    const mimeType = image.mimeType.trim();
    if (!base64 || !mimeType) {
      continue;
    }
    if (seenBase64.has(base64)) {
      duplicateCount += 1;
      continue;
    }
    if (images.length >= maxImageCount) {
      limitCount += 1;
      continue;
    }
    if (totalBase64Length + base64.length > totalBase64Limit) {
      oversizedCount += 1;
      continue;
    }

    images.push({
      base64,
      mimeType,
      fileName: image.fileName.trim(),
    });
    seenBase64.add(base64);
    totalBase64Length += base64.length;
    addedCount += 1;
  }

  return {
    images,
    addedCount,
    duplicateCount,
    oversizedCount,
    limitCount,
  };
}
