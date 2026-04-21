import { MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64 } from '@maxim/contracts';
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

const COMMENT_IMAGE_FALLBACK_MAX_BYTES = Math.floor(
  (MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64 * 3) / 4,
);
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
const FILE_MIME_BY_EXTENSION: Record<string, string> = {
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  webp: 'image/webp',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
};

function canRenderImagePreview(mimeType: string): boolean {
  return PREVIEWABLE_IMAGE_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

function normalizeMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized || normalized === 'application/octet-stream') {
    return '';
  }

  if (normalized === 'image/jpg' || normalized === 'image/pjpeg') {
    return 'image/jpeg';
  }

  return normalized;
}

function inferMimeTypeFromName(fileName: string, mimeByExtension: Record<string, string>): string {
  const normalized = fileName.trim().toLowerCase();
  const extensionMatch = normalized.match(/\.([a-z0-9]+)$/u);
  if (!extensionMatch) {
    return '';
  }

  return mimeByExtension[extensionMatch[1] ?? ''] ?? '';
}

function normalizeFileNameWithExtension(
  fileName: string,
  fallbackBaseName: string,
  mimeType: string,
): string {
  const normalized = fileName.trim();
  if (normalized) {
    return normalized;
  }

  const extension = (() => {
    switch (mimeType) {
      case 'image/png':
        return '.png';
      case 'image/webp':
        return '.webp';
      case 'image/gif':
        return '.gif';
      case 'image/heic':
        return '.heic';
      case 'image/heif':
        return '.heif';
      case 'application/pdf':
        return '.pdf';
      default:
        return mimeType.startsWith('image/') ? '.jpg' : '.bin';
    }
  })();

  return `${fallbackBaseName}${extension}`;
}

function parseDataUrlPayload(dataUrl: string): { base64: string; mimeType: string } {
  const [header = '', payload = ''] = dataUrl.split(',', 2);
  const mimeTypeMatch = header.match(/^data:([^;,]+)[;,]/iu);
  return {
    base64: payload,
    mimeType: normalizeMimeType(mimeTypeMatch?.[1] ?? ''),
  };
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

export async function prepareCommentDialogImageAttachment(
  file: File,
): Promise<PreparedCommentDialogAttachment> {
  try {
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
  } catch {
    const dataUrl = await readFileAsDataUrl(file);
    const parsed = parseDataUrlPayload(dataUrl);
    const mimeType =
      normalizeMimeType(file.type) ||
      parsed.mimeType ||
      inferMimeTypeFromName(file.name, IMAGE_MIME_BY_EXTENSION);
    if (!mimeType.startsWith('image/')) {
      throw new Error('Нужен файл изображения.');
    }

    if (file.size > COMMENT_IMAGE_FALLBACK_MAX_BYTES) {
      throw new Error('Фото слишком большое. Выберите другое изображение.');
    }

    if (!parsed.base64) {
      throw new Error('Не удалось прочитать файл.');
    }

    return {
      type: 'image',
      base64: parsed.base64,
      mimeType,
      fileName: normalizeFileNameWithExtension(file.name, 'comment-image', mimeType),
      previewUrl: canRenderImagePreview(mimeType) ? dataUrl : null,
      size: file.size || Math.max(1, Math.floor((parsed.base64.length * 3) / 4)),
    };
  }
}

export async function prepareCommentDialogFileAttachment(
  file: File,
): Promise<PreparedCommentDialogAttachment> {
  const dataUrl = await readFileAsDataUrl(file);
  const parsed = parseDataUrlPayload(dataUrl);
  const mimeType =
    normalizeMimeType(file.type) ||
    parsed.mimeType ||
    inferMimeTypeFromName(file.name, FILE_MIME_BY_EXTENSION) ||
    'application/octet-stream';
  const base64 = parsed.base64;
  if (!base64) {
    throw new Error('Не удалось прочитать файл.');
  }

  return {
    type: 'file',
    base64,
    mimeType,
    fileName: normalizeFileNameWithExtension(file.name, 'attachment', mimeType),
    previewUrl: null,
    size: file.size || Math.max(1, Math.floor((base64.length * 3) / 4)),
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
