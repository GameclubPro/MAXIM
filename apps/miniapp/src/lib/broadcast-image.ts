export const MAX_PREPARED_IMAGE_BYTES = 6_000_000;
const MAX_SOURCE_IMAGE_BYTES = 64_000_000;
const MIN_PREPARED_IMAGE_BYTES = 96_000;
const IMAGE_DIMENSION_STEPS = [2560, 2200, 1920, 1600, 1440, 1280, 1080, 960, 800, 640];
const IMAGE_QUALITY_STEPS = [0.92, 0.88, 0.84, 0.8, 0.76, 0.72];
const FALLBACK_IMAGE_ERROR = 'Не удалось подготовить фото. Выберите другое изображение.';
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};
const NORMALIZED_IMAGE_MIME_TYPES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
};
const ORIGINAL_IMAGE_MIME_TYPES = new Set([
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/jpeg',
  'image/png',
  'image/tiff',
]);
const CANVAS_BLACK_PIXEL_MAX_VALUE = 8;
const CANVAS_BLANK_ALPHA_MAX_VALUE = 4;

export function resolveMaxUploadImageTargetMimeTypes(inputMimeType: string): string[] {
  return inputMimeType === 'image/png' ? ['image/png', 'image/jpeg'] : ['image/jpeg', 'image/png'];
}

export function canUseOriginalBroadcastImage(
  inputMimeType: string,
  fileSize: number,
  maxImageBytes = MAX_PREPARED_IMAGE_BYTES,
): boolean {
  return (
    Number.isFinite(fileSize) &&
    fileSize > 0 &&
    fileSize <= maxImageBytes &&
    ORIGINAL_IMAGE_MIME_TYPES.has(normalizeImageMimeType(inputMimeType))
  );
}

export type PreparedBroadcastImage = {
  base64: string;
  mimeType: string;
  fileName: string;
  width: number | null;
  height: number | null;
};

type PrepareBroadcastImageOptions = {
  maxBytes?: number;
  maxSourceBytes?: number;
};

type LoadedImageSource = {
  width: number;
  height: number;
  draw: (
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    width: number,
    height: number,
  ) => void;
  close: () => void;
};

class SuspiciousCanvasRenderError extends Error {
  constructor() {
    super(FALLBACK_IMAGE_ERROR);
    this.name = 'SuspiciousCanvasRenderError';
  }
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        reject(new Error('Не удалось прочитать файл.'));
        return;
      }

      resolve(result);
    };
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(blob);
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await readBlobAsDataUrl(blob);
  const payload = dataUrl.includes(',') ? dataUrl.split(',')[1] : '';
  if (!payload) {
    throw new Error('Не удалось прочитать файл.');
  }

  return payload;
}

async function loadImageFromBlob(blob: Blob): Promise<LoadedImageSource> {
  if (typeof createImageBitmap === 'function' && !shouldPreferHtmlImageElementDecode()) {
    try {
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: 'from-image',
      } as ImageBitmapOptions);
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (context, width, height) => {
          context.drawImage(bitmap, 0, 0, width, height);
        },
        close: () => bitmap.close(),
      };
    } catch {
      // Fall through to HTMLImageElement for WebViews with partial bitmap support.
    }
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);
    image.onload = () => {
      resolve({
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        draw: (context, width, height) => {
          context.drawImage(image, 0, 0, width, height);
        },
        close: () => URL.revokeObjectURL(objectUrl),
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Не удалось открыть изображение.'));
    };
    image.src = objectUrl;
  });
}

function normalizeImageMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized || normalized === 'image/*') {
    return '';
  }

  return NORMALIZED_IMAGE_MIME_TYPES[normalized] ?? normalized;
}

function inferImageMimeTypeFromName(fileName: string): string {
  const normalized = fileName.trim().toLowerCase();
  const extensionMatch = normalized.match(/\.([a-z0-9]+)$/u);
  if (!extensionMatch) {
    return '';
  }

  return IMAGE_MIME_BY_EXTENSION[extensionMatch[1] ?? ''] ?? '';
}

function resolveInputImageMimeType(file: File): string {
  return normalizeImageMimeType(file.type) || inferImageMimeTypeFromName(file.name);
}

function ensureTypedImageBlob(file: File, mimeType: string): Blob {
  const normalizedMimeType = normalizeImageMimeType(file.type);
  if (!mimeType || normalizedMimeType === mimeType) {
    return file;
  }

  return new Blob([file], { type: mimeType });
}

function resolveOutputExtension(mimeType: string): string {
  if (mimeType === 'image/bmp') {
    return '.bmp';
  }
  if (mimeType === 'image/png') {
    return '.png';
  }
  if (mimeType === 'image/webp') {
    return '.webp';
  }
  if (mimeType === 'image/gif') {
    return '.gif';
  }
  if (mimeType === 'image/heic') {
    return '.heic';
  }
  if (mimeType === 'image/heif') {
    return '.heif';
  }
  if (mimeType === 'image/tiff') {
    return '.tiff';
  }

  return '.jpg';
}

function resolveOutputFileName(fileName: string, mimeType: string): string {
  const normalized = fileName.trim() || 'broadcast-image';
  const baseName = normalized.replace(/\.[^./\\]+$/u, '') || 'broadcast-image';
  return `${baseName}${resolveOutputExtension(mimeType)}`;
}

function scaleImageSize(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number } {
  const currentMaxDimension = Math.max(width, height);
  if (currentMaxDimension <= maxDimension) {
    return { width, height };
  }

  const scale = maxDimension / currentMaxDimension;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function shouldPreferHtmlImageElementDecode(): boolean {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /\b(iPhone|iPad|iPod)\b/u.test(userAgent) && /AppleWebKit/u.test(userAgent);
}

function shouldPreferHtmlCanvasElement(): boolean {
  return (
    typeof document !== 'undefined' &&
    (typeof OffscreenCanvas !== 'function' || shouldPreferHtmlImageElementDecode())
  );
}

function canReadOriginalImage(file: File, mimeType: string, maxImageBytes: number): boolean {
  return canUseOriginalBroadcastImage(mimeType, file.size, maxImageBytes);
}

function renderToCanvas(
  image: LoadedImageSource,
  width: number,
  height: number,
  mimeType: string,
): HTMLCanvasElement | OffscreenCanvas {
  const canvas =
    shouldPreferHtmlCanvasElement()
      ? Object.assign(document.createElement('canvas'), { width, height })
      : new OffscreenCanvas(width, height);

  const context = canvas.getContext('2d', { alpha: true });
  if (!context) {
    throw new Error('Не удалось подготовить изображение.');
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  if (mimeType === 'image/jpeg') {
    context.save();
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.restore();
  }
  image.draw(context, width, height);
  assertCanvasHasReadableImage(context, width, height);
  return canvas;
}

function assertCanvasHasReadableImage(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  if (width <= 0 || height <= 0) {
    throw new SuspiciousCanvasRenderError();
  }

  let opaquePixels = 0;
  let nonBlackPixels = 0;

  const sampleRects = buildCanvasSampleRects(width, height);
  for (const rect of sampleRects) {
    let data: Uint8ClampedArray;
    try {
      data = context.getImageData(rect.x, rect.y, rect.width, rect.height).data;
    } catch {
      return;
    }

    for (let index = 0; index < data.length; index += 4) {
      const red = data[index] ?? 0;
      const green = data[index + 1] ?? 0;
      const blue = data[index + 2] ?? 0;
      const alpha = data[index + 3] ?? 0;
      if (alpha > CANVAS_BLANK_ALPHA_MAX_VALUE) {
        opaquePixels += 1;
        if (
          red > CANVAS_BLACK_PIXEL_MAX_VALUE ||
          green > CANVAS_BLACK_PIXEL_MAX_VALUE ||
          blue > CANVAS_BLACK_PIXEL_MAX_VALUE
        ) {
          nonBlackPixels += 1;
        }
      }
    }
  }

  if (opaquePixels === 0 || nonBlackPixels === 0) {
    throw new SuspiciousCanvasRenderError();
  }
}

function buildCanvasSampleRects(
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number }[] {
  const sampleWidth = Math.max(1, Math.min(48, width));
  const sampleHeight = Math.max(1, Math.min(48, height));
  const maxX = Math.max(0, width - sampleWidth);
  const maxY = Math.max(0, height - sampleHeight);
  const points = [
    [0, 0],
    [maxX, 0],
    [Math.round(maxX / 2), Math.round(maxY / 2)],
    [0, maxY],
    [maxX, maxY],
  ] as const;
  const seen = new Set<string>();

  return points.flatMap(([x, y]) => {
    const key = `${x}:${y}`;
    if (seen.has(key)) {
      return [];
    }

    seen.add(key);
    return [{ x, y, width: sampleWidth, height: sampleHeight }];
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mimeType: string,
  quality: number,
): Promise<Blob | null> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: mimeType, quality }).catch(() => null);
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

async function readOriginalImage(
  file: Blob,
  mimeType: string,
  fileName: string,
  dimensions: { width: number | null; height: number | null } = { width: null, height: null },
): Promise<PreparedBroadcastImage> {
  return {
    base64: await blobToBase64(file),
    mimeType,
    fileName: resolveOutputFileName(fileName, mimeType),
    width: dimensions.width,
    height: dimensions.height,
  };
}

export function resolvePreparedImageMaxBytes(options: PrepareBroadcastImageOptions = {}): number {
  const rawMaxBytes = Math.trunc(options.maxBytes ?? MAX_PREPARED_IMAGE_BYTES);
  if (!Number.isFinite(rawMaxBytes)) {
    return MAX_PREPARED_IMAGE_BYTES;
  }

  return Math.max(MIN_PREPARED_IMAGE_BYTES, Math.min(MAX_PREPARED_IMAGE_BYTES, rawMaxBytes));
}

function resolveSourceImageMaxBytes(options: PrepareBroadcastImageOptions): number {
  const rawMaxBytes = Math.trunc(options.maxSourceBytes ?? MAX_SOURCE_IMAGE_BYTES);
  if (!Number.isFinite(rawMaxBytes)) {
    return MAX_SOURCE_IMAGE_BYTES;
  }

  return Math.max(MAX_PREPARED_IMAGE_BYTES, rawMaxBytes);
}

export async function prepareBroadcastImage(
  file: File,
  options: PrepareBroadcastImageOptions = {},
): Promise<PreparedBroadcastImage> {
  const maxImageBytes = resolvePreparedImageMaxBytes(options);
  const maxSourceBytes = resolveSourceImageMaxBytes(options);
  const inputMimeType = resolveInputImageMimeType(file);
  const sourceBlob = ensureTypedImageBlob(file, inputMimeType);
  const targetMimeTypes = resolveMaxUploadImageTargetMimeTypes(inputMimeType);

  if (file.size > maxSourceBytes) {
    throw new Error('Фото слишком большое для обработки на телефоне.');
  }

  if (canReadOriginalImage(file, inputMimeType, maxImageBytes)) {
    return readOriginalImage(sourceBlob, inputMimeType, file.name);
  }

  try {
    const image = await loadImageFromBlob(sourceBlob);
    const sourceWidth = image.width;
    const sourceHeight = image.height;

    try {
      if (!sourceWidth || !sourceHeight) {
        throw new Error(FALLBACK_IMAGE_ERROR);
      }

      if (inputMimeType === 'image/gif') {
        if (file.size > maxImageBytes) {
          throw new Error(FALLBACK_IMAGE_ERROR);
        }

        return readOriginalImage(sourceBlob, inputMimeType, file.name, {
          width: sourceWidth,
          height: sourceHeight,
        });
      }

      let bestBlob: Blob | null = null;
      let bestMimeType = targetMimeTypes[0] ?? 'image/jpeg';
      let bestWidth = sourceWidth;
      let bestHeight = sourceHeight;

      for (const maxDimension of IMAGE_DIMENSION_STEPS) {
        const scaled = scaleImageSize(sourceWidth, sourceHeight, maxDimension);

        for (const targetMimeType of targetMimeTypes) {
          const canvas = renderToCanvas(image, scaled.width, scaled.height, targetMimeType);
          const qualitySteps = targetMimeType === 'image/png' ? [1] : IMAGE_QUALITY_STEPS;
          for (const quality of qualitySteps) {
            const blob = await canvasToBlob(canvas, targetMimeType, quality);
            if (!blob || !blob.size) {
              continue;
            }

            const actualMimeType = blob.type || targetMimeType;
            if (!bestBlob || blob.size < bestBlob.size) {
              bestBlob = blob;
              bestMimeType = actualMimeType;
              bestWidth = scaled.width;
              bestHeight = scaled.height;
            }

            if (blob.size <= maxImageBytes) {
              return {
                base64: await blobToBase64(blob),
                mimeType: actualMimeType,
                fileName: resolveOutputFileName(file.name, actualMimeType),
                width: scaled.width,
                height: scaled.height,
              };
            }
          }
        }
      }

      if (inputMimeType && file.size <= maxImageBytes) {
        return readOriginalImage(sourceBlob, inputMimeType, file.name, {
          width: sourceWidth,
          height: sourceHeight,
        });
      }

      if (bestBlob && bestBlob.size <= maxImageBytes) {
        return {
          base64: await blobToBase64(bestBlob),
          mimeType: bestMimeType,
          fileName: resolveOutputFileName(file.name, bestMimeType),
          width: bestWidth,
          height: bestHeight,
        };
      }
    } finally {
      image.close();
    }
  } catch (error: unknown) {
    if (!inputMimeType) {
      throw new Error('Нужен файл изображения.');
    }

    if (file.size <= maxImageBytes) {
      return readOriginalImage(sourceBlob, inputMimeType, file.name);
    }

    if (error instanceof Error && error.message.trim()) {
      throw error;
    }

    throw new Error(FALLBACK_IMAGE_ERROR);
  }

  throw new Error(FALLBACK_IMAGE_ERROR);
}
