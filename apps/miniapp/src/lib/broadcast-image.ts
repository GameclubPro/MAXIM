const MAX_BROADCAST_IMAGE_BYTES = 3_000_000;
const IMAGE_DIMENSION_STEPS = [1920, 1600, 1280, 960, 800, 640];
const IMAGE_QUALITY_STEPS = [0.86, 0.8, 0.74, 0.68, 0.62, 0.56, 0.5, 0.44];
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

export function resolveMaxUploadImageTargetMimeTypes(inputMimeType: string): string[] {
  return inputMimeType === 'image/png' ? ['image/png', 'image/jpeg'] : ['image/jpeg', 'image/png'];
}

export type PreparedBroadcastImage = {
  base64: string;
  mimeType: string;
  fileName: string;
  width: number | null;
  height: number | null;
};

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

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
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
  if (mimeType === 'image/png') {
    return '.png';
  }
  if (mimeType === 'image/gif') {
    return '.gif';
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

function renderToCanvas(image: HTMLImageElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Не удалось подготовить изображение.');
  }

  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number,
): Promise<Blob | null> {
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

export async function prepareBroadcastImage(file: File): Promise<PreparedBroadcastImage> {
  const inputMimeType = resolveInputImageMimeType(file);
  const sourceBlob = ensureTypedImageBlob(file, inputMimeType);
  const targetMimeTypes = resolveMaxUploadImageTargetMimeTypes(inputMimeType);

  try {
    const image = await loadImageFromBlob(sourceBlob);
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;

    if (!sourceWidth || !sourceHeight) {
      throw new Error(FALLBACK_IMAGE_ERROR);
    }

    if (inputMimeType === 'image/gif') {
      if (file.size > MAX_BROADCAST_IMAGE_BYTES) {
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
      const canvas = renderToCanvas(image, scaled.width, scaled.height);

      for (const targetMimeType of targetMimeTypes) {
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

          if (blob.size <= MAX_BROADCAST_IMAGE_BYTES) {
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

    if (inputMimeType && file.size <= MAX_BROADCAST_IMAGE_BYTES) {
      return readOriginalImage(sourceBlob, inputMimeType, file.name, {
        width: sourceWidth,
        height: sourceHeight,
      });
    }

    if (bestBlob && bestBlob.size <= MAX_BROADCAST_IMAGE_BYTES) {
      return {
        base64: await blobToBase64(bestBlob),
        mimeType: bestMimeType,
        fileName: resolveOutputFileName(file.name, bestMimeType),
        width: bestWidth,
        height: bestHeight,
      };
    }
  } catch (error: unknown) {
    if (!inputMimeType) {
      throw new Error('Нужен файл изображения.');
    }

    if (file.size <= MAX_BROADCAST_IMAGE_BYTES) {
      return readOriginalImage(sourceBlob, inputMimeType, file.name);
    }

    if (error instanceof Error && error.message.trim()) {
      throw error;
    }

    throw new Error(FALLBACK_IMAGE_ERROR);
  }

  throw new Error(FALLBACK_IMAGE_ERROR);
}
