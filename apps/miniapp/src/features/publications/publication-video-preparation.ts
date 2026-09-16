import { MAX_PUBLICATION_VIDEO_BASE64_LENGTH } from '@maxim/contracts/publication';
import { readBlobAsBase64 } from '../../lib/broadcast-image';
import { inferPublicationVideoMimeType } from './publication-model';

export const MAX_PUBLICATION_VIDEO_FILE_BYTES =
  Math.floor(MAX_PUBLICATION_VIDEO_BASE64_LENGTH / 4) * 3;
export const PUBLICATION_VIDEO_MAX_SIZE_MB = MAX_PUBLICATION_VIDEO_FILE_BYTES / 1_000_000;

const VIDEO_SIZE_ERROR = `Видео не прикреплено. Максимум ${PUBLICATION_VIDEO_MAX_SIZE_MB} МБ.`;

export async function preparePublicationVideo(
  file: File,
  readBase64: (blob: Blob) => Promise<string> = readBlobAsBase64,
) {
  if (file.size > MAX_PUBLICATION_VIDEO_FILE_BYTES) {
    throw new Error(VIDEO_SIZE_ERROR);
  }
  if (file.size === 0) {
    throw new Error('Видео пустое. Выберите другой файл.');
  }
  const mediaMimeType = inferPublicationVideoMimeType(file.name, file.type);
  if (!mediaMimeType) {
    throw new Error('Видео не прикреплено. Поддерживаются MP4, MOV, MKV и WebM.');
  }

  const mediaBase64 = await readBase64(file);
  if (mediaBase64.length > MAX_PUBLICATION_VIDEO_BASE64_LENGTH) {
    throw new Error(VIDEO_SIZE_ERROR);
  }
  if (mediaBase64.length !== Math.ceil(file.size / 3) * 4) {
    throw new Error('Не удалось прочитать видео полностью. Выберите файл снова.');
  }
  return {
    mediaBase64,
    mediaMimeType,
    mediaFileName: file.name.trim().slice(0, 128),
  };
}
