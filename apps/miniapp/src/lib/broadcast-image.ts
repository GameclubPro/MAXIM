import { normalizeImageMimeType, resolveInputImageMimeType } from './broadcast-image-format';

export const MAX_PREPARED_IMAGE_BYTES = 6_000_000;
export const BROADCAST_IMAGE_OPERATION_TIMEOUT_MS = 10_000;
export const BROADCAST_IMAGE_PREPARATION_TIMEOUT_MS = 45_000;
const MAX_SOURCE_IMAGE_BYTES = 64_000_000;
const MIN_PREPARED_IMAGE_BYTES = 96_000;
const IMAGE_DIMENSION_STEPS = [2560, 2200, 1920, 1600, 1440, 1280, 1080, 960, 800, 640];
const IMAGE_QUALITY_STEPS = [0.92, 0.88, 0.84, 0.8, 0.76, 0.72];
const BASE64_BINARY_CHUNK_BYTES = 12_288;
const FALLBACK_IMAGE_ERROR =
  'Не удалось обработать фото на этом устройстве. Попробуйте ещё раз или выберите JPEG/PNG.';
const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heic',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/tiff': '.tiff',
};
const MAX_DIRECT_UPLOAD_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/tiff',
  'image/bmp',
  'image/heic',
]);

export function resolveMaxUploadImageTargetMimeTypes(inputMimeType: string): string[] {
  return inputMimeType === 'image/png' ? ['image/png', 'image/jpeg'] : ['image/jpeg', 'image/png'];
}

export function canUploadOriginalImageToMax(inputMimeType: string, fileName: string): boolean {
  if (MAX_DIRECT_UPLOAD_IMAGE_MIME_TYPES.has(inputMimeType)) {
    return true;
  }

  return inputMimeType === 'image/heif' && /\.heic$/iu.test(fileName.trim());
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
  signal?: AbortSignal;
};

export class ImagePreparationError extends Error {
  constructor(
    readonly code:
      | 'empty'
      | 'source-size'
      | 'format'
      | 'read'
      | 'decode'
      | 'encode'
      | 'output-size'
      | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'ImagePreparationError';
  }
}

function imagePreparationAbortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Подготовка фото отменена.', 'AbortError');
}

function throwIfImagePreparationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw imagePreparationAbortReason(signal);
}

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

function safeCloseImageBitmap(bitmap: ImageBitmap): void {
  try {
    bitmap.close();
  } catch {
    // A timed-out WebView decoder may already have released the bitmap.
  }
}

function waitForImageOperation<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
  releaseLate?: (value: T) => void,
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) {
        if (value !== null) releaseLate?.(value);
        return;
      }
      settled = true;
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener('abort', cancel);
      resolve(value);
    };
    const cancel = () => finish(null);
    const timeoutId = globalThis.setTimeout(cancel, BROADCAST_IMAGE_OPERATION_TIMEOUT_MS);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    void pending.then(finish, cancel);
  });
}

async function loadImageBitmapWithTimeout(
  blob: Blob,
  signal: AbortSignal,
): Promise<LoadedImageSource | null> {
  let bitmap: ImageBitmap | null;
  try {
    bitmap = await waitForImageOperation(
      createImageBitmap(blob, { imageOrientation: 'from-image' }),
      signal,
      safeCloseImageBitmap,
    );
  } catch {
    return null;
  }
  if (!bitmap) return null;
  return {
    width: bitmap.width,
    height: bitmap.height,
    draw: (context, width, height) => context.drawImage(bitmap, 0, 0, width, height),
    close: () => safeCloseImageBitmap(bitmap),
  };
}

function loadHtmlImageWithTimeout(blob: Blob, signal: AbortSignal): Promise<LoadedImageSource> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);
    let settled = false;
    let revoked = false;

    const revokeObjectUrl = () => {
      if (revoked) {
        return;
      }
      revoked = true;
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // URL cleanup is best-effort in older WebViews.
      }
    };
    const clearHandlers = () => {
      signal.removeEventListener('abort', fail);
      image.onload = null;
      image.onerror = null;
    };
    const clearSource = () => {
      try {
        image.src = '';
      } catch {
        // Some WebViews expose a read-only image source during teardown.
      }
    };
    const fail = () => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timeoutId);
      clearHandlers();
      revokeObjectUrl();
      clearSource();
      reject(new Error(FALLBACK_IMAGE_ERROR));
    };
    const timeoutId = globalThis.setTimeout(fail, BROADCAST_IMAGE_OPERATION_TIMEOUT_MS);
    signal.addEventListener('abort', fail, { once: true });

    image.onload = () => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timeoutId);
      clearHandlers();
      revokeObjectUrl();
      resolve({
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        draw: (context, width, height) => {
          context.drawImage(image, 0, 0, width, height);
        },
        close: clearSource,
      });
    };
    image.onerror = fail;

    try {
      image.src = objectUrl;
    } catch {
      fail();
    }
  });
}

function readBlobAsDataUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    const clearHandlers = () => {
      signal?.removeEventListener('abort', rejectRead);
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
    };
    const rejectRead = () => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timeoutId);
      clearHandlers();
      try {
        reader.abort();
      } catch {
        // The reader may already be inactive after a WebView failure.
      }
      reject(new Error('Не удалось прочитать файл.'));
    };
    const timeoutId = globalThis.setTimeout(rejectRead, BROADCAST_IMAGE_OPERATION_TIMEOUT_MS);
    signal?.addEventListener('abort', rejectRead, { once: true });

    reader.onload = () => {
      if (settled) {
        return;
      }
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        rejectRead();
        return;
      }

      settled = true;
      globalThis.clearTimeout(timeoutId);
      clearHandlers();
      resolve(result);
    };
    reader.onerror = rejectRead;
    reader.onabort = rejectRead;
    try {
      reader.readAsDataURL(blob);
    } catch {
      rejectRead();
    }
  });
}

function readBlobArrayBufferWithTimeout(
  blob: Blob,
  signal?: AbortSignal,
): Promise<ArrayBuffer | null> {
  try {
    return waitForImageOperation(blob.arrayBuffer(), signal);
  } catch {
    return Promise.resolve(null);
  }
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

export async function readBlobAsBase64(blob: Blob, signal?: AbortSignal): Promise<string> {
  throwIfImagePreparationAborted(signal);
  if (typeof blob.arrayBuffer === 'function' && typeof globalThis.btoa === 'function') {
    try {
      const buffer = await readBlobArrayBufferWithTimeout(blob, signal);
      throwIfImagePreparationAborted(signal);
      const base64 = buffer?.byteLength === blob.size ? encodeArrayBufferAsBase64(buffer) : '';
      if (base64) {
        return base64;
      }
    } catch {
      // Some older WebViews only support FileReader for Blob reads.
    }
  }

  throwIfImagePreparationAborted(signal);
  let dataUrl: string;
  try {
    dataUrl = await readBlobAsDataUrl(blob, signal);
  } catch {
    throwIfImagePreparationAborted(signal);
    throw new ImagePreparationError('read', 'Не удалось прочитать файл. Выберите его заново.');
  }
  const payload = dataUrl.includes(',') ? dataUrl.split(',')[1] : '';
  if (!payload) {
    throw new ImagePreparationError('read', 'Не удалось прочитать файл. Выберите его заново.');
  }

  return payload;
}

async function loadImageFromBlob(blob: Blob, signal: AbortSignal): Promise<LoadedImageSource> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await loadImageBitmapWithTimeout(blob, signal);
    if (bitmap) {
      return bitmap;
    }
  }

  throwIfImagePreparationAborted(signal);
  return loadHtmlImageWithTimeout(blob, signal);
}

function ensureTypedImageBlob(file: File, mimeType: string): Blob {
  if (!mimeType || file.type === mimeType) {
    return file;
  }

  return new Blob([file], { type: mimeType });
}

export function resolveOutputFileName(fileName: string, mimeType: string): string {
  const normalized = fileName.trim() || 'broadcast-image';
  const baseName = normalized.replace(/\.[^./\\]+$/u, '') || 'broadcast-image';
  const extension = IMAGE_EXTENSION_BY_MIME_TYPE[mimeType] ?? '.jpg';
  return `${baseName.slice(0, 128 - extension.length)}${extension}`;
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
  mimeType: string,
  offscreen: boolean,
): HTMLCanvasElement | OffscreenCanvas {
  const canvas = offscreen
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });

  try {
    const context = canvas.getContext('2d', { alpha: mimeType === 'image/png' });
    if (!context) throw new ImagePreparationError('encode', FALLBACK_IMAGE_ERROR);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    if (mimeType === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    }
    image.draw(context, width, height);
    return canvas;
  } catch (error) {
    canvas.width = 0;
    canvas.height = 0;
    throw error;
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mimeType: string,
  quality: number,
  signal: AbortSignal,
): Promise<Blob | null> {
  try {
    const pending =
      'convertToBlob' in canvas
        ? canvas.convertToBlob({ type: mimeType, quality })
        : new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
    return waitForImageOperation(pending, signal);
  } catch {
    return Promise.resolve(null);
  }
}

async function readOriginalImage(
  file: Blob,
  mimeType: string,
  fileName: string,
  signal: AbortSignal,
  dimensions: { width: number | null; height: number | null } = { width: null, height: null },
): Promise<PreparedBroadcastImage> {
  return {
    base64: await readBlobAsBase64(file, signal),
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
  const controller = new AbortController();
  let abortReason: unknown;
  const cancel = () => {
    abortReason = imagePreparationAbortReason(options.signal);
    controller.abort(abortReason);
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = globalThis.setTimeout(() => {
    abortReason = new ImagePreparationError(
      'timeout',
      'Обработка фото заняла слишком много времени. Попробуйте фото меньшего размера.',
    );
    controller.abort(abortReason);
  }, BROADCAST_IMAGE_PREPARATION_TIMEOUT_MS);
  let rejectOnAbort: () => void = () => undefined;
  try {
    throwIfImagePreparationAborted(controller.signal);
    return await Promise.race([
      prepareImage(file, options, controller.signal),
      new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(abortReason);
        controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectOnAbort);
  }
}

async function prepareImage(
  file: File,
  options: PrepareBroadcastImageOptions,
  signal: AbortSignal,
): Promise<PreparedBroadcastImage> {
  const maxImageBytes = resolvePreparedImageMaxBytes(options);
  const maxSourceBytes = resolveSourceImageMaxBytes(options);
  if (!file.size) {
    throw new ImagePreparationError('empty', 'Файл фото пустой. Выберите фото заново.');
  }
  if (file.size > maxSourceBytes) {
    throw new ImagePreparationError(
      'source-size',
      `Исходное фото больше ${Math.round(maxSourceBytes / 1_000_000)} МБ. Выберите фото меньшего размера.`,
    );
  }
  const header = await readBlobArrayBufferWithTimeout(file.slice(0, 32), signal);
  throwIfImagePreparationAborted(signal);
  const inputMimeType = resolveInputImageMimeType(
    file,
    header ? new Uint8Array(header) : new Uint8Array(),
  );
  if (!inputMimeType) {
    throw new ImagePreparationError(
      'format',
      'Не удалось определить формат фото. Выберите файл JPEG или PNG.',
    );
  }
  const sourceBlob = ensureTypedImageBlob(file, inputMimeType);
  const targetMimeTypes = resolveMaxUploadImageTargetMimeTypes(inputMimeType);
  const outputSizeError = () =>
    new ImagePreparationError(
      'output-size',
      `Не удалось уменьшить фото до ${Number((maxImageBytes / 1_000_000).toFixed(2))} МБ. Выберите фото меньшего размера.`,
    );
  let decoded = false;

  try {
    const image = await loadImageFromBlob(sourceBlob, signal);
    const sourceWidth = image.width;
    const sourceHeight = image.height;

    try {
      throwIfImagePreparationAborted(signal);
      if (!sourceWidth || !sourceHeight) {
        throw new Error(FALLBACK_IMAGE_ERROR);
      }
      decoded = true;

      if (inputMimeType === 'image/gif') {
        if (file.size > maxImageBytes) {
          throw outputSizeError();
        }

        return readOriginalImage(sourceBlob, inputMimeType, file.name, signal, {
          width: sourceWidth,
          height: sourceHeight,
        });
      }

      let encoded = false;
      const visitedSizes = new Set<string>();
      let useOffscreen = typeof OffscreenCanvas === 'function';
      for (const maxDimension of IMAGE_DIMENSION_STEPS) {
        const scaled = scaleImageSize(sourceWidth, sourceHeight, maxDimension);
        const sizeKey = `${scaled.width}x${scaled.height}`;
        if (visitedSizes.has(sizeKey)) continue;
        visitedSizes.add(sizeKey);
        let encodedAtSize = false;

        for (const targetMimeType of targetMimeTypes) {
          let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
          try {
            throwIfImagePreparationAborted(signal);
            try {
              canvas = renderToCanvas(
                image,
                scaled.width,
                scaled.height,
                targetMimeType,
                useOffscreen,
              );
            } catch {
              useOffscreen = false;
              canvas = renderToCanvas(image, scaled.width, scaled.height, targetMimeType, false);
            }
            const qualitySteps = targetMimeType === 'image/png' ? [1] : IMAGE_QUALITY_STEPS;
            for (const quality of qualitySteps) {
              throwIfImagePreparationAborted(signal);
              let blob = await canvasToBlob(canvas, targetMimeType, quality, signal);
              throwIfImagePreparationAborted(signal);
              if ((!blob || !blob.size) && useOffscreen) {
                canvas.width = 0;
                canvas.height = 0;
                useOffscreen = false;
                canvas = renderToCanvas(image, scaled.width, scaled.height, targetMimeType, false);
                blob = await canvasToBlob(canvas, targetMimeType, quality, signal);
              }
              throwIfImagePreparationAborted(signal);
              if (!blob?.size) break;
              const actualMimeType = normalizeImageMimeType(blob.type);
              if (actualMimeType !== 'image/png' && actualMimeType !== 'image/jpeg') {
                break;
              }
              encoded = true;
              encodedAtSize = true;
              if (blob.size <= maxImageBytes) {
                return {
                  base64: await readBlobAsBase64(blob, signal),
                  mimeType: actualMimeType,
                  fileName: resolveOutputFileName(file.name, actualMimeType),
                  width: scaled.width,
                  height: scaled.height,
                };
              }
            }
          } finally {
            if (canvas) {
              canvas.width = 0;
              canvas.height = 0;
            }
          }
        }
        if (!encodedAtSize) throw new ImagePreparationError('encode', FALLBACK_IMAGE_ERROR);
      }

      if (canUploadOriginalImageToMax(inputMimeType, file.name) && file.size <= maxImageBytes) {
        return readOriginalImage(sourceBlob, inputMimeType, file.name, signal, {
          width: sourceWidth,
          height: sourceHeight,
        });
      }

      if (encoded) throw outputSizeError();
    } finally {
      image.close();
    }
  } catch (error: unknown) {
    throwIfImagePreparationAborted(signal);

    if (canUploadOriginalImageToMax(inputMimeType, file.name) && file.size <= maxImageBytes) {
      return readOriginalImage(sourceBlob, inputMimeType, file.name, signal);
    }

    if (error instanceof ImagePreparationError) throw error;
    if (!decoded) {
      throw new ImagePreparationError(
        'decode',
        inputMimeType === 'image/heic' || inputMimeType === 'image/heif'
          ? `Не удалось преобразовать HEIC/HEIF на этом устройстве. Выберите JPEG/PNG или HEIC до ${Number((maxImageBytes / 1_000_000).toFixed(2))} МБ.`
          : 'Не удалось открыть фото на этом устройстве. Файл может быть повреждён или его формат не поддерживается. Выберите JPEG/PNG.',
      );
    }
    throw new ImagePreparationError('encode', FALLBACK_IMAGE_ERROR);
  }

  throw new ImagePreparationError('encode', FALLBACK_IMAGE_ERROR);
}
