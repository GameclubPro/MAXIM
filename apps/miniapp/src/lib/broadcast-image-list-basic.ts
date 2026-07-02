import type { BroadcastImage } from '@maxim/contracts';

export const BROADCAST_IMAGES_MAX = 10;
export const BROADCAST_IMAGES_TOTAL_BASE64_MAX = 24_000_000;

export function resolveBroadcastImageMaxCount(value: number | null | undefined): number {
  const rawMaxImageCount = Math.trunc(value ?? BROADCAST_IMAGES_MAX);
  return Number.isFinite(rawMaxImageCount)
    ? Math.max(1, Math.min(BROADCAST_IMAGES_MAX, rawMaxImageCount))
    : BROADCAST_IMAGES_MAX;
}

export function getBroadcastImagesBase64Length(images: readonly BroadcastImage[]): number {
  return images.reduce((total, image) => total + image.base64.length, 0);
}

export function normalizeComposerBroadcastImages(
  images: readonly BroadcastImage[],
  maxImageCount = BROADCAST_IMAGES_MAX,
): BroadcastImage[] {
  const normalized: BroadcastImage[] = [];
  const seenBase64 = new Set<string>();

  for (const image of images) {
    if (normalized.length >= maxImageCount) {
      break;
    }

    const base64 = image.base64.trim();
    const mimeType = image.mimeType.trim();
    if (!base64 || !mimeType || seenBase64.has(base64)) {
      continue;
    }

    normalized.push({
      base64,
      mimeType,
      fileName: image.fileName.trim(),
    });
    seenBase64.add(base64);
  }

  return normalized;
}
