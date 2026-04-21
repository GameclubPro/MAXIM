import { prepareBroadcastImage } from './broadcast-image';

export type PreparedCommentDialogAttachment = {
  type: 'image' | 'file';
  base64: string;
  mimeType: string;
  fileName: string;
  previewUrl: string | null;
  size: number;
  width?: number;
  height?: number;
};

const PREVIEWABLE_IMAGE_MIME_TYPES = new Set([
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function canRenderImagePreview(mimeType: string): boolean {
  return PREVIEWABLE_IMAGE_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

function readFileAsDataUrl(file: Blob): Promise<string> {
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
    reader.readAsDataURL(file);
  });
}

async function fileToBase64(file: Blob): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file);
  const payload = dataUrl.includes(',') ? dataUrl.split(',')[1] : '';
  if (!payload) {
    throw new Error('Не удалось прочитать файл.');
  }

  return payload;
}

function normalizeFileName(fileName: string, fallback: string): string {
  const normalized = fileName.trim();
  return normalized || fallback;
}

export async function prepareCommentDialogImageAttachment(
  file: File,
): Promise<PreparedCommentDialogAttachment> {
  const prepared = await prepareBroadcastImage(file);
  const size = Math.max(1, Math.floor((prepared.base64.length * 3) / 4));

  return {
    type: 'image',
    base64: prepared.base64,
    mimeType: prepared.mimeType,
    fileName: prepared.fileName,
    previewUrl: canRenderImagePreview(prepared.mimeType)
      ? `data:${prepared.mimeType};base64,${prepared.base64}`
      : null,
    size,
    ...(prepared.width ? { width: prepared.width } : {}),
    ...(prepared.height ? { height: prepared.height } : {}),
  };
}

export async function prepareCommentDialogFileAttachment(
  file: File,
): Promise<PreparedCommentDialogAttachment> {
  const mimeType = file.type.trim() || 'application/octet-stream';
  const base64 = await fileToBase64(file);

  return {
    type: 'file',
    base64,
    mimeType,
    fileName: normalizeFileName(file.name, 'attachment.bin'),
    previewUrl: null,
    size: file.size,
  };
}

export function formatDialogAttachmentSize(bytes: number | null | undefined): string {
  const normalized = typeof bytes === 'number' && Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (normalized >= 1_000_000) {
    return `${(normalized / 1_000_000).toFixed(1)} MB`;
  }

  if (normalized >= 1_000) {
    return `${Math.max(1, Math.round(normalized / 1_000))} KB`;
  }

  return `${normalized} B`;
}
