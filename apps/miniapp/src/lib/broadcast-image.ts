const MAX_BROADCAST_IMAGE_BYTES = 3_000_000;
const IMAGE_DIMENSION_STEPS = [1920, 1600, 1280, 960];
const IMAGE_QUALITY_STEPS = [0.86, 0.8, 0.74, 0.68, 0.62];
const FALLBACK_IMAGE_ERROR = 'Не удалось подготовить фото. Выберите другое изображение.';

type PreparedBroadcastImage = {
  base64: string;
  mimeType: string;
  fileName: string;
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

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Не удалось открыть изображение.'));
    image.src = dataUrl;
  });
}

function resolveOutputExtension(mimeType: string): string {
  if (mimeType === 'image/webp') {
    return '.webp';
  }
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
  image: HTMLImageElement,
  width: number,
  height: number,
): HTMLCanvasElement {
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

async function readOriginalImage(file: File): Promise<PreparedBroadcastImage> {
  const mimeType = file.type.trim().toLowerCase();
  return {
    base64: await blobToBase64(file),
    mimeType,
    fileName: resolveOutputFileName(file.name, mimeType),
  };
}

export async function prepareBroadcastImage(file: File): Promise<PreparedBroadcastImage> {
  const mimeType = file.type.trim().toLowerCase();
  if (!mimeType.startsWith('image/')) {
    throw new Error('Нужен файл изображения.');
  }

  if (mimeType === 'image/gif') {
    if (file.size > MAX_BROADCAST_IMAGE_BYTES) {
      throw new Error(FALLBACK_IMAGE_ERROR);
    }

    return readOriginalImage(file);
  }

  try {
    const sourceDataUrl = await readBlobAsDataUrl(file);
    const image = await loadImage(sourceDataUrl);
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;

    if (!sourceWidth || !sourceHeight) {
      throw new Error(FALLBACK_IMAGE_ERROR);
    }

    let bestBlob: Blob | null = null;
    let bestMimeType = 'image/webp';

    for (const maxDimension of IMAGE_DIMENSION_STEPS) {
      const scaled = scaleImageSize(sourceWidth, sourceHeight, maxDimension);
      const canvas = renderToCanvas(image, scaled.width, scaled.height);

      for (const targetMimeType of ['image/webp', 'image/jpeg']) {
        for (const quality of IMAGE_QUALITY_STEPS) {
          const blob = await canvasToBlob(canvas, targetMimeType, quality);
          if (!blob || !blob.size) {
            continue;
          }

          const actualMimeType = blob.type || targetMimeType;
          if (!bestBlob || blob.size < bestBlob.size) {
            bestBlob = blob;
            bestMimeType = actualMimeType;
          }

          if (blob.size <= MAX_BROADCAST_IMAGE_BYTES) {
            return {
              base64: await blobToBase64(blob),
              mimeType: actualMimeType,
              fileName: resolveOutputFileName(file.name, actualMimeType),
            };
          }
        }
      }
    }

    if (file.size <= MAX_BROADCAST_IMAGE_BYTES) {
      return readOriginalImage(file);
    }

    if (bestBlob && bestBlob.size <= MAX_BROADCAST_IMAGE_BYTES) {
      return {
        base64: await blobToBase64(bestBlob),
        mimeType: bestMimeType,
        fileName: resolveOutputFileName(file.name, bestMimeType),
      };
    }
  } catch (error: unknown) {
    if (file.size <= MAX_BROADCAST_IMAGE_BYTES) {
      return readOriginalImage(file);
    }

    if (error instanceof Error && error.message.trim()) {
      throw error;
    }

    throw new Error(FALLBACK_IMAGE_ERROR);
  }

  throw new Error(FALLBACK_IMAGE_ERROR);
}
