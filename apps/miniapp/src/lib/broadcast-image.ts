export const MAX_PREPARED_IMAGE_BYTES = 6_000_000;
const MAX_SOURCE_IMAGE_BYTES = 64_000_000;
const MIN_PREPARED_IMAGE_BYTES = 96_000;
const IMAGE_DIMENSION_STEPS = [2560, 2200, 1920, 1600, 1440, 1280, 1080, 960, 800, 640];
const IMAGE_QUALITY_STEPS = [0.92, 0.88, 0.84, 0.8, 0.76, 0.72];
const BASE64_BINARY_CHUNK_BYTES = 12_288;
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
    const rejectRead = () => reject(new Error('Не удалось прочитать файл.'));
    reader.onerror = rejectRead;
    reader.onabort = rejectRead;
    try {
      reader.readAsDataURL(blob);
    } catch {
      rejectRead();
    }
  });
}

function encodeArrayBufferAsBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength === 0) {
    return '';
  }

  const chunks: string[] = [];
  // The chunk size is divisible by three so independent base64 chunks concatenate correctly.
  for (let start = 0; start < bytes.length; start += BASE64_BINARY_CHUNK_BYTES) {
    const end = Math.min(start + BASE64_BINARY_CHUNK_BYTES, bytes.length);
    let binary = '';
    for (let index = start; index < end; index += 1) {
      binary += String.fromCharCode(bytes[index] ?? 0);
    }
    chunks.push(globalThis.btoa(binary));
  }

  return chunks.join('');
}

export async function readBlobAsBase64(blob: Blob): Promise<string> {
  if (typeof blob.arrayBuffer === 'function' && typeof globalThis.btoa === 'function') {
    try {
      const base64 = encodeArrayBufferAsBase64(await blob.arrayBuffer());
      if (base64) {
        return base64;
      }
    } catch {
      // Some older WebViews only support FileReader for Blob reads.
    }
  }

  const dataUrl = await readBlobAsDataUrl(blob);
  const payload = dataUrl.includes(',') ? dataUrl.split(',')[1] : '';
  if (!payload) {
    throw new Error('Не удалось прочитать файл.');
  }

  return payload;
}

async function loadImageFromBlob(blob: Blob): Promise<LoadedImageSource> {
  if (typeof createImageBitmap === 'function') {
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
      URL.revokeObjectURL(objectUrl);
      resolve({
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        draw: (context, width, height) => {
          context.drawImage(image, 0, 0, width, height);
        },
        close: () => undefined,
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

function renderToCanvas(
  image: LoadedImageSource,
  width: number,
  height: number,
): HTMLCanvasElement | OffscreenCanvas {
  const canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });

  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new Error('Не удалось подготовить изображение.');
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  image.draw(context, width, height);
  return canvas;
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
    base64: await readBlobAsBase64(file),
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

            if (blob.size <= maxImageBytes) {
              return {
                base64: await readBlobAsBase64(blob),
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
          base64: await readBlobAsBase64(bestBlob),
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
