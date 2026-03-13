const STICKER_CANVAS_SIZE = 512;

export type PreparedStickerImage = {
  base64: string;
  mimeType: 'image/png' | 'image/webp';
  fileName: string;
  previewDataUrl: string;
  width: number;
  height: number;
};

export type PreparedStickerClipboardImage = {
  blob: Blob;
  dataUrl: string;
  mimeType: 'image/png';
  fileName: string;
};

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        reject(new Error('Не удалось прочитать изображение.'));
        return;
      }

      resolve(result);
    };
    reader.onerror = () => reject(new Error('Не удалось прочитать изображение.'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Не удалось открыть изображение.'));
    image.src = dataUrl;
  });
}

function sanitizeStickerFileName(fileName: string, extension: 'png' | 'webp'): string {
  const normalized = fileName.trim() || 'sticker-photo';
  const baseName = normalized.replace(/\.[^./\\]+$/u, '') || 'sticker-photo';
  return `${baseName}.${extension}`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return readBlobAsDataUrl(blob).then((dataUrl) => {
    const payload = dataUrl.includes(',') ? dataUrl.split(',')[1] : '';
    if (!payload) {
      throw new Error('Не удалось подготовить изображение.');
    }

    return payload;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: 'image/png' | 'image/webp',
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Не удалось подготовить изображение.'));
          return;
        }

        resolve(blob);
      },
      mimeType,
      quality,
    );
  });
}

const MAX_STICKER_IMAGE_BYTES = 1_000_000;

export async function prepareStickerImage(file: File): Promise<PreparedStickerImage> {
  const mimeType = file.type.trim().toLowerCase();
  if (!mimeType.startsWith('image/')) {
    throw new Error('Нужен файл изображения.');
  }

  const sourceDataUrl = await readBlobAsDataUrl(file);
  const image = await loadImage(sourceDataUrl);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;

  if (!sourceWidth || !sourceHeight) {
    throw new Error('Не удалось определить размер изображения.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = STICKER_CANVAS_SIZE;
  canvas.height = STICKER_CANVAS_SIZE;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Не удалось подготовить изображение.');
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(STICKER_CANVAS_SIZE / sourceWidth, STICKER_CANVAS_SIZE / sourceHeight);
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
  const targetX = Math.floor((STICKER_CANVAS_SIZE - targetWidth) / 2);
  const targetY = Math.floor((STICKER_CANVAS_SIZE - targetHeight) / 2);

  context.drawImage(image, targetX, targetY, targetWidth, targetHeight);

  let blob = await canvasToBlob(canvas, 'image/png');
  let targetMimeType: 'image/png' | 'image/webp' = 'image/png';

  if (blob.size > MAX_STICKER_IMAGE_BYTES) {
    blob = await canvasToBlob(canvas, 'image/webp', 0.92);
    targetMimeType = 'image/webp';
  }

  const base64 = await blobToBase64(blob);
  const previewDataUrl = `data:${targetMimeType};base64,${base64}`;
  const extension = targetMimeType === 'image/png' ? 'png' : 'webp';

  return {
    base64,
    mimeType: targetMimeType,
    fileName: sanitizeStickerFileName(file.name, extension),
    previewDataUrl,
    width: STICKER_CANVAS_SIZE,
    height: STICKER_CANVAS_SIZE,
  };
}

export async function prepareStickerClipboardImage(
  prepared: PreparedStickerImage,
): Promise<PreparedStickerClipboardImage> {
  const sourceDataUrl = `data:${prepared.mimeType};base64,${prepared.base64}`;
  const image = await loadImage(sourceDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = STICKER_CANVAS_SIZE;
  canvas.height = STICKER_CANVAS_SIZE;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Не удалось подготовить изображение для копирования.');
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const blob = await canvasToBlob(canvas, 'image/png');
  const dataUrl = await readBlobAsDataUrl(blob);

  return {
    blob,
    dataUrl,
    mimeType: 'image/png',
    fileName: sanitizeStickerFileName(prepared.fileName, 'png'),
  };
}
