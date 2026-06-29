import { BadRequestException } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import type {
  DownloadedBinaryAsset,
  DownloadedImageAsset,
  ParsedFileAttachment,
  ParsedImageAttachment,
  ParsedImageFileAttachment,
  ParsedImageSourceAttachment,
  ParsedVideoSourceAttachment,
  PrivateSuggestionImageDraft,
  PrivateSuggestionVideoDraft,
} from './private-control.types';

const PRIVATE_VIDEO_DOWNLOAD_MAX_BYTES = 250 * 1024 * 1024;
const PRIVATE_VIDEO_DOWNLOAD_TIMEOUT_MS = 10_000;

export type PrivateControlMediaAttachmentUploader = {
  uploadImage(data: Buffer, fileName: string, mimeType: string): Promise<Record<string, unknown>>;
  uploadVideo(data: Buffer, fileName: string, mimeType: string): Promise<Record<string, unknown>>;
};

export function collectPrivateMessageAttachments(update: MaxUpdate): Record<string, unknown>[] {
  const raw = asRecord(update.raw);
  if (!raw) {
    return [];
  }

  const messageCandidates = [
    asRecord(raw.message),
    asRecord(asRecord(raw.data)?.message),
    asRecord(asRecord(raw.event)?.message),
  ].filter((candidate): candidate is Record<string, unknown> => Boolean(candidate));

  const attachments: Record<string, unknown>[] = [];

  for (const message of messageCandidates) {
    const body = asRecord(message.body);
    const candidates = [
      message.attachments,
      body?.attachments,
      asRecord(message.data)?.attachments,
      asRecord(message.payload)?.attachments,
    ];

    for (const node of candidates) {
      if (!Array.isArray(node)) {
        continue;
      }

      for (const attachment of node) {
        if (!attachment || typeof attachment !== 'object') {
          continue;
        }

        attachments.push(attachment as Record<string, unknown>);
      }
    }
  }

  return attachments;
}

export function extractPrivateImageSourceAttachments(
  update: MaxUpdate,
): ParsedImageSourceAttachment[] {
  const attachments: ParsedImageSourceAttachment[] = [];

  for (const row of collectPrivateMessageAttachments(update)) {
    const imageAttachment = parsePrivateImageAttachment(row);
    if (imageAttachment) {
      attachments.push({
        kind: 'image',
        attachment: imageAttachment,
      });
      continue;
    }

    const imageFileAttachment = parsePrivateImageFileAttachment(row);
    if (imageFileAttachment) {
      attachments.push({
        kind: 'file',
        attachment: imageFileAttachment,
      });
    }
  }

  return attachments;
}

export function extractPrivateFirstImageSourceAttachment(
  update: MaxUpdate,
): ParsedImageSourceAttachment | null {
  return extractPrivateImageSourceAttachments(update)[0] ?? null;
}

export function extractPrivateFirstFileAttachment(update: MaxUpdate): ParsedFileAttachment | null {
  for (const row of collectPrivateMessageAttachments(update)) {
    const parsed = parsePrivateFileAttachment(row);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

export function extractPrivateFirstVideoSourceAttachment(
  update: MaxUpdate,
): ParsedVideoSourceAttachment | null {
  for (const row of collectPrivateMessageAttachments(update)) {
    const type = readLowerString(row.type);
    const payload = asRecord(row.payload);

    if (type === 'video' && payload) {
      const url = readString(payload.url);
      const token = readString(payload.token);
      const mediaType = readLowerString(payload.media_type ?? payload.mediaType ?? row.media_type);
      const fileName =
        readString(
          payload.file_name ??
            payload.fileName ??
            row.file_name ??
            row.fileName ??
            row.filename ??
            row.name,
        ) ?? null;
      const mimeType =
        resolvePrivateVideoMimeType(
          readLowerString(payload.mime_type ?? payload.mimeType),
          fileName,
          url,
        ) ?? (token || mediaType === 'video' ? 'video/mp4' : null);
      if ((!url && !token) || !mimeType) {
        continue;
      }

      return {
        url,
        token: token ?? null,
        fileId:
          readString(payload.video_id ?? payload.videoId ?? payload.file_id ?? payload.fileId) ??
          null,
        fileName,
        size: readOptionalInteger(payload.size ?? row.size),
        mimeType,
        mediaType,
        payloadKeys: Object.keys(payload).sort(),
      };
    }

    const parsed = parsePrivateFileAttachment(row);
    if (!parsed || (!parsed.url && !parsed.token)) {
      continue;
    }

    const mimeType =
      resolvePrivateVideoMimeType(parsed.mimeType, parsed.fileName, parsed.url) ??
      (parsed.mediaType === 'video' ? 'video/mp4' : null);
    if (!mimeType) {
      continue;
    }

    return {
      ...parsed,
      mimeType,
    };
  }

  return null;
}

export function hasPrivateVideoAttachment(update: MaxUpdate): boolean {
  for (const row of collectPrivateMessageAttachments(update)) {
    const type = readLowerString(row.type);
    const payload = asRecord(row.payload);
    const mimeType = readLowerString(payload?.mime_type ?? payload?.mimeType);
    const fileName = readString(
      payload?.file_name ??
        payload?.fileName ??
        row.file_name ??
        row.fileName ??
        row.filename ??
        row.name,
    );
    const url = readString(payload?.url);
    const mediaType = readLowerString(payload?.media_type ?? payload?.mediaType ?? row.media_type);

    if (
      type === 'video' ||
      mediaType === 'video' ||
      mimeType?.startsWith('video/') ||
      Boolean(resolvePrivateVideoMimeType(mimeType, fileName, url))
    ) {
      return true;
    }
  }

  return false;
}

export async function downloadPrivateImageSourceAttachment(
  imageSourceAttachment: ParsedImageSourceAttachment,
  filePrefix = 'private-broadcast',
): Promise<DownloadedImageAsset> {
  if (imageSourceAttachment.kind === 'image') {
    return downloadPrivateImageAttachment(imageSourceAttachment.attachment, filePrefix);
  }

  return downloadPrivateImageFileAttachment(imageSourceAttachment.attachment, filePrefix);
}

export async function downloadPrivateVideoSourceAttachment(
  videoSourceAttachment: ParsedVideoSourceAttachment,
  filePrefix = 'channel-suggestion',
): Promise<DownloadedBinaryAsset> {
  if (!videoSourceAttachment.url) {
    throw new BadRequestException('Не удалось получить ссылку на видео из сообщения.');
  }

  if (
    typeof videoSourceAttachment.size === 'number' &&
    videoSourceAttachment.size > PRIVATE_VIDEO_DOWNLOAD_MAX_BYTES
  ) {
    throw new BadRequestException('Видео слишком большое. Максимальный размер — 250 МБ.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, PRIVATE_VIDEO_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(videoSourceAttachment.url, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new BadRequestException(`Не удалось загрузить видео (${response.status}).`);
    }

    const contentLength = parseContentLength(response.headers.get('content-length'));
    if (contentLength !== null && contentLength > PRIVATE_VIDEO_DOWNLOAD_MAX_BYTES) {
      throw new BadRequestException('Видео слишком большое. Максимальный размер — 250 МБ.');
    }

    const mimeTypeHeader = response.headers.get('content-type') ?? '';
    const mimeType = resolvePrivateVideoMimeType(
      mimeTypeHeader.toLowerCase().startsWith('video/')
        ? mimeTypeHeader.split(';')[0].trim().toLowerCase()
        : videoSourceAttachment.mimeType,
      videoSourceAttachment.fileName,
      videoSourceAttachment.url,
    );
    if (!mimeType) {
      throw new BadRequestException('Файл должен быть видео.');
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0) {
      throw new BadRequestException('Видео оказалось пустым.');
    }
    if (buffer.length > PRIVATE_VIDEO_DOWNLOAD_MAX_BYTES) {
      throw new BadRequestException('Видео слишком большое. Максимальный размер — 250 МБ.');
    }

    const fileName = buildPrivateDownloadedFileName(
      filePrefix,
      videoSourceAttachment.fileName ?? fileNameFromUrl(videoSourceAttachment.url),
      videoSourceAttachment.fileId,
      mimeType,
    );

    return {
      buffer,
      mimeType,
      fileName,
    };
  } catch (error: unknown) {
    if (error instanceof BadRequestException) {
      throw error;
    }

    throw new BadRequestException('Не удалось загрузить видео из сообщения.');
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildPrivateSuggestionImageDraftsFromImages(
  imageSourceAttachments: ParsedImageSourceAttachment[],
  uploader: PrivateControlMediaAttachmentUploader,
  filePrefix = 'channel-suggestion',
): Promise<PrivateSuggestionImageDraft[]> {
  const drafts: PrivateSuggestionImageDraft[] = [];

  for (const imageSourceAttachment of imageSourceAttachments) {
    drafts.push(
      await buildPrivateSuggestionMediaDraftFromImage(imageSourceAttachment, uploader, filePrefix),
    );
  }

  return drafts;
}

export async function buildPrivateSuggestionMediaDraftFromImage(
  imageSourceAttachment: ParsedImageSourceAttachment,
  uploader: PrivateControlMediaAttachmentUploader,
  filePrefix = 'channel-suggestion',
): Promise<PrivateSuggestionImageDraft> {
  const downloaded = await downloadPrivateImageSourceAttachment(imageSourceAttachment, filePrefix);
  const payload = await uploader.uploadImage(
    Buffer.from(downloaded.base64, 'base64'),
    downloaded.fileName,
    downloaded.mimeType,
  );

  return {
    kind: 'image',
    mimeType: downloaded.mimeType,
    fileName: downloaded.fileName,
    payload,
  };
}

export async function buildPrivateSuggestionMediaDraftFromVideo(
  videoSourceAttachment: ParsedVideoSourceAttachment,
  uploader: PrivateControlMediaAttachmentUploader,
  filePrefix = 'channel-suggestion',
): Promise<PrivateSuggestionVideoDraft> {
  if (videoSourceAttachment.token) {
    return {
      kind: 'video',
      mimeType: videoSourceAttachment.mimeType,
      fileName: buildPrivateDownloadedFileName(
        filePrefix,
        videoSourceAttachment.fileName ??
          (videoSourceAttachment.url ? fileNameFromUrl(videoSourceAttachment.url) : null),
        videoSourceAttachment.fileId,
        videoSourceAttachment.mimeType,
      ),
      payload: { token: videoSourceAttachment.token },
    };
  }

  const downloaded = await downloadPrivateVideoSourceAttachment(videoSourceAttachment, filePrefix);
  const payload = await uploader.uploadVideo(
    downloaded.buffer,
    downloaded.fileName,
    downloaded.mimeType,
  );

  return {
    kind: 'video',
    mimeType: downloaded.mimeType,
    fileName: downloaded.fileName,
    payload,
  };
}

export function buildPrivateDownloadedFileName(
  filePrefix: string,
  preferredFileName: string | null,
  fallbackId: string | null,
  mimeType: string,
): string {
  const normalizedFileName = normalizeDownloadedFileName(preferredFileName);
  if (normalizedFileName) {
    return normalizedFileName;
  }

  const extension = extensionFromMimeType(mimeType);
  return `${filePrefix}-${fallbackId ?? Date.now()}.${extension}`;
}

export function parsePrivateFileAttachment(
  row: Record<string, unknown>,
): ParsedFileAttachment | null {
  const type = readLowerString(row.type);
  if (type !== 'file') {
    return null;
  }

  const payload = asRecord(row.payload);
  if (!payload) {
    return null;
  }

  return {
    url: readString(payload.url) ?? null,
    token: readString(payload.token) ?? null,
    fileId: readString(payload.file_id ?? payload.fileId) ?? null,
    fileName:
      readString(
        payload.file_name ?? payload.fileName ?? row.file_name ?? row.fileName ?? row.filename ?? row.name,
      ) ?? null,
    size: readOptionalInteger(payload.size ?? row.size),
    mimeType: readLowerString(payload.mime_type ?? payload.mimeType ?? row.mime_type),
    mediaType: readLowerString(payload.media_type ?? payload.mediaType ?? row.media_type),
    payloadKeys: Object.keys(payload).sort(),
  };
}

export function resolvePrivateImageMimeType(
  mimeType: string | null,
  fileName: string | null,
  url: string | null,
): string | null {
  if (mimeType?.startsWith('image/')) {
    return mimeType;
  }

  return (
    inferImageMimeTypeFromFileName(fileName) ?? inferImageMimeTypeFromFileName(fileNameFromUrl(url))
  );
}

export function resolvePrivateVideoMimeType(
  mimeType: string | null,
  fileName: string | null,
  url: string | null,
): string | null {
  if (mimeType?.startsWith('video/')) {
    return mimeType;
  }

  return (
    inferVideoMimeTypeFromFileName(fileName) ?? inferVideoMimeTypeFromFileName(fileNameFromUrl(url))
  );
}

async function downloadPrivateImageAttachment(
  imageAttachment: ParsedImageAttachment,
  filePrefix = 'private-broadcast',
): Promise<DownloadedImageAsset> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 10_000);

  try {
    const response = await fetch(imageAttachment.url, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new BadRequestException(`Не удалось загрузить фото (${response.status}).`);
    }

    const mimeTypeHeader = response.headers.get('content-type') ?? '';
    const mimeType = mimeTypeHeader.toLowerCase().startsWith('image/')
      ? mimeTypeHeader.split(';')[0].trim().toLowerCase()
      : (imageAttachment.mimeType ?? 'image/jpeg');

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0) {
      throw new BadRequestException('Фото оказалось пустым.');
    }

    const extension = extensionFromMimeType(mimeType);
    const fileName = imageAttachment.photoId
      ? `${filePrefix}-${imageAttachment.photoId}.${extension}`
      : `${filePrefix}-${Date.now()}.${extension}`;

    return {
      base64: buffer.toString('base64'),
      mimeType,
      fileName,
    };
  } catch (error: unknown) {
    if (error instanceof BadRequestException) {
      throw error;
    }

    throw new BadRequestException('Не удалось загрузить фото из сообщения.');
  } finally {
    clearTimeout(timeout);
  }
}

function parsePrivateImageAttachment(row: Record<string, unknown>): ParsedImageAttachment | null {
  const type = readLowerString(row.type);
  if (type !== 'image') {
    return null;
  }

  const payload = asRecord(row.payload);
  if (!payload) {
    return null;
  }

  const url = readString(payload.url);
  if (!url) {
    return null;
  }

  return {
    url,
    token: readString(payload.token) ?? null,
    photoId: normalizeEntityId(payload.photo_id ?? payload.photoId) ?? null,
    width: readOptionalInteger(payload.width ?? payload.w),
    height: readOptionalInteger(payload.height ?? payload.h),
    mimeType: readLowerString(payload.mime_type ?? payload.mimeType),
    mediaType: readLowerString(payload.media_type ?? payload.mediaType),
    payloadKeys: Object.keys(payload).sort(),
  };
}

function parsePrivateImageFileAttachment(
  row: Record<string, unknown>,
): ParsedImageFileAttachment | null {
  const parsed = parsePrivateFileAttachment(row);
  if (!parsed?.url) {
    return null;
  }

  const resolvedMimeType = resolvePrivateImageMimeType(parsed.mimeType, parsed.fileName, parsed.url);
  if (!resolvedMimeType) {
    return null;
  }

  return {
    url: parsed.url,
    token: parsed.token,
    fileId: parsed.fileId,
    fileName: parsed.fileName,
    size: parsed.size,
    mimeType: resolvedMimeType,
    mediaType: parsed.mediaType,
    payloadKeys: parsed.payloadKeys,
  };
}

async function downloadPrivateImageFileAttachment(
  imageFileAttachment: ParsedImageFileAttachment,
  filePrefix = 'private-broadcast',
): Promise<DownloadedImageAsset> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 10_000);

  try {
    const response = await fetch(imageFileAttachment.url, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new BadRequestException(`Не удалось загрузить файл (${response.status}).`);
    }

    const mimeTypeHeader = response.headers.get('content-type') ?? '';
    const mimeType = resolvePrivateImageMimeType(
      mimeTypeHeader.toLowerCase().startsWith('image/')
        ? mimeTypeHeader.split(';')[0].trim().toLowerCase()
        : imageFileAttachment.mimeType,
      imageFileAttachment.fileName,
      imageFileAttachment.url,
    );
    if (!mimeType) {
      throw new BadRequestException('Файл должен быть изображением.');
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0) {
      throw new BadRequestException('Файл оказался пустым.');
    }

    const fileName = buildPrivateDownloadedFileName(
      filePrefix,
      imageFileAttachment.fileName ?? fileNameFromUrl(imageFileAttachment.url),
      imageFileAttachment.fileId,
      mimeType,
    );

    return {
      base64: buffer.toString('base64'),
      mimeType,
      fileName,
    };
  } catch (error: unknown) {
    if (error instanceof BadRequestException) {
      throw error;
    }

    throw new BadRequestException('Не удалось загрузить изображение из файла.');
  } finally {
    clearTimeout(timeout);
  }
}

function extensionFromMimeType(mimeType: string): string {
  if (mimeType === 'image/png') {
    return 'png';
  }
  if (mimeType === 'image/webp') {
    return 'webp';
  }
  if (mimeType === 'image/gif') {
    return 'gif';
  }
  if (mimeType === 'image/heic') {
    return 'heic';
  }
  if (mimeType === 'video/mp4') {
    return 'mp4';
  }
  if (mimeType === 'video/quicktime') {
    return 'mov';
  }
  if (mimeType === 'video/webm') {
    return 'webm';
  }
  if (mimeType === 'video/x-msvideo') {
    return 'avi';
  }
  if (mimeType === 'video/x-m4v') {
    return 'm4v';
  }

  return 'jpg';
}

function inferImageMimeTypeFromFileName(fileName: string | null): string | null {
  if (!fileName) {
    return null;
  }

  const normalized = fileName.trim().toLowerCase();
  if (normalized.endsWith('.png')) {
    return 'image/png';
  }
  if (normalized.endsWith('.webp')) {
    return 'image/webp';
  }
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (normalized.endsWith('.gif')) {
    return 'image/gif';
  }
  if (normalized.endsWith('.heic')) {
    return 'image/heic';
  }

  return null;
}

function inferVideoMimeTypeFromFileName(fileName: string | null): string | null {
  if (!fileName) {
    return null;
  }

  const normalized = fileName.trim().toLowerCase();
  if (normalized.endsWith('.mp4')) {
    return 'video/mp4';
  }
  if (normalized.endsWith('.mov')) {
    return 'video/quicktime';
  }
  if (normalized.endsWith('.webm')) {
    return 'video/webm';
  }
  if (normalized.endsWith('.avi')) {
    return 'video/x-msvideo';
  }
  if (normalized.endsWith('.m4v')) {
    return 'video/x-m4v';
  }

  return null;
}

function fileNameFromUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop();
    if (!lastSegment) {
      return null;
    }

    const decoded = decodeURIComponent(lastSegment).trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function normalizeDownloadedFileName(fileName: string | null): string | null {
  if (!fileName) {
    return null;
  }

  const sanitized = fileName
    .trim()
    .replace(/[/\\?%*:|"<>]/gu, '-')
    .replace(/\s+/gu, ' ');

  return sanitized.length > 0 ? sanitized : null;
}

function normalizeEntityId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readLowerString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseContentLength(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readOptionalInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}
