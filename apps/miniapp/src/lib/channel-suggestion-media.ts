import {
  MAX_CHANNEL_SUGGESTION_VIDEO_BYTES,
  type ChannelSuggestionVideoInput,
} from '@maxim/contracts/channel-dialog';
import type { PreparedCommentDialogAttachment } from './dialog-attachments';
import { readBlobAsBase64 } from './broadcast-image';

export type PreparedSuggestionAttachment = Omit<PreparedCommentDialogAttachment, 'type'> & {
  type: 'image' | 'video';
};

const VIDEO_MIME_TYPES: Record<string, ChannelSuggestionVideoInput['mimeType']> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
};

export async function prepareSuggestionVideo(file: File): Promise<PreparedSuggestionAttachment> {
  if (!file.size || file.size > MAX_CHANNEL_SUGGESTION_VIDEO_BYTES)
    throw new Error('Выберите видео размером до 24 МБ.');
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const declared = file.type.toLowerCase();
  const mimeType =
    Object.values(VIDEO_MIME_TYPES).find((type) => type === declared) ??
    (!declared || declared === 'application/octet-stream'
      ? VIDEO_MIME_TYPES[extension]
      : undefined);
  if (!mimeType) throw new Error('Поддерживаются MP4, MOV, WebM и MKV.');
  const base64 = await readBlobAsBase64(file);
  return {
    type: 'video',
    base64,
    mimeType,
    fileName: file.name.slice(0, 128),
    size: file.size,
    previewUrl: `data:${mimeType};base64,${base64}`,
  };
}

export function toSuggestionMediaPayload(attachments: readonly PreparedSuggestionAttachment[]): {
  images: Array<{ base64: string; mimeType: string; fileName: string }>;
  video?: ChannelSuggestionVideoInput;
} {
  const video = attachments.find((item) => item.type === 'video');
  if (video) {
    if (attachments.length !== 1)
      throw new Error('Фото и видео отправляются отдельными предложениями.');
    return {
      images: [],
      video: {
        base64: video.base64,
        mimeType: video.mimeType as ChannelSuggestionVideoInput['mimeType'],
        fileName: video.fileName,
      },
    };
  }
  return {
    images: attachments.map(({ base64, mimeType, fileName }) => ({ base64, mimeType, fileName })),
  };
}

export async function readSuggestionTextFile(
  file: File,
  current: string,
  maxLength: number,
): Promise<string> {
  if (file.size > 100_000 || !/\.(txt|md|markdown)$/iu.test(file.name))
    throw new Error('Выберите текстовый файл TXT или Markdown до 100 КБ.');
  const text = (await file.text())
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .trim();
  if (!text || text.includes('\0'))
    throw new Error('Файл пустой или содержит неподдерживаемые данные.');
  const next = current.trim() ? `${current.trim()}\n\n${text}` : text;
  if (next.length > maxLength)
    throw new Error(`Текст превышает ${maxLength} символов. Сократите файл перед добавлением.`);
  return next;
}
