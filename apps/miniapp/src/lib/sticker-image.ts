const STICKER_CANVAS_SIZE = 512;
const STICKER_FRAME_INSET = 28;
const STICKER_FRAME_RADIUS = 96;
const STICKER_IMAGE_INSET = 42;
const STICKER_IMAGE_RADIUS = 78;

export type PreparedStickerImage = {
  base64: string;
  mimeType: 'image/webp';
  fileName: string;
  previewDataUrl: string;
  width: number;
  height: number;
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

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const normalizedRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + normalizedRadius, y);
  context.lineTo(x + width - normalizedRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + normalizedRadius);
  context.lineTo(x + width, y + height - normalizedRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - normalizedRadius, y + height);
  context.lineTo(x + normalizedRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - normalizedRadius);
  context.lineTo(x, y + normalizedRadius);
  context.quadraticCurveTo(x, y, x + normalizedRadius, y);
  context.closePath();
}

function sanitizeStickerFileName(fileName: string): string {
  const normalized = fileName.trim() || 'sticker-photo';
  const baseName = normalized.replace(/\.[^./\\]+$/u, '') || 'sticker-photo';
  return `${baseName}.webp`;
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

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Не удалось подготовить изображение.'));
          return;
        }

        resolve(blob);
      },
      'image/webp',
      0.92,
    );
  });
}

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
  context.save();
  context.shadowColor = 'rgba(19, 49, 73, 0.18)';
  context.shadowBlur = 28;
  context.shadowOffsetY = 14;
  context.fillStyle = '#ffffff';
  drawRoundedRect(
    context,
    STICKER_FRAME_INSET,
    STICKER_FRAME_INSET,
    STICKER_CANVAS_SIZE - STICKER_FRAME_INSET * 2,
    STICKER_CANVAS_SIZE - STICKER_FRAME_INSET * 2,
    STICKER_FRAME_RADIUS,
  );
  context.fill();
  context.restore();

  context.save();
  drawRoundedRect(
    context,
    STICKER_IMAGE_INSET,
    STICKER_IMAGE_INSET,
    STICKER_CANVAS_SIZE - STICKER_IMAGE_INSET * 2,
    STICKER_CANVAS_SIZE - STICKER_IMAGE_INSET * 2,
    STICKER_IMAGE_RADIUS,
  );
  context.clip();

  const sourceAspectRatio = sourceWidth / sourceHeight;
  const targetAspectRatio = 1;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  let cropX = 0;
  let cropY = 0;

  if (sourceAspectRatio > targetAspectRatio) {
    cropWidth = Math.round(sourceHeight * targetAspectRatio);
    cropX = Math.max(0, Math.round((sourceWidth - cropWidth) / 2));
  } else if (sourceAspectRatio < targetAspectRatio) {
    cropHeight = Math.round(sourceWidth / targetAspectRatio);
    cropY = Math.max(0, Math.round((sourceHeight - cropHeight) / 2));
  }

  context.drawImage(
    image,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    STICKER_IMAGE_INSET,
    STICKER_IMAGE_INSET,
    STICKER_CANVAS_SIZE - STICKER_IMAGE_INSET * 2,
    STICKER_CANVAS_SIZE - STICKER_IMAGE_INSET * 2,
  );
  context.restore();

  const blob = await canvasToBlob(canvas);
  const base64 = await blobToBase64(blob);
  const previewDataUrl = `data:image/webp;base64,${base64}`;

  return {
    base64,
    mimeType: 'image/webp',
    fileName: sanitizeStickerFileName(file.name),
    previewDataUrl,
    width: STICKER_CANVAS_SIZE,
    height: STICKER_CANVAS_SIZE,
  };
}
