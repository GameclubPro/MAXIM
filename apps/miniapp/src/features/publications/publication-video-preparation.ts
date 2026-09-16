import {
  MAX_PUBLICATION_VIDEO_UPLOAD_BYTES,
  type CreatePublicationVideoUpload,
} from '@maxim/contracts/publication';
import { inferPublicationVideoMimeType } from './publication-model';

export const MAX_PUBLICATION_VIDEO_FILE_BYTES = MAX_PUBLICATION_VIDEO_UPLOAD_BYTES;
export const PUBLICATION_VIDEO_MAX_SIZE_MB = MAX_PUBLICATION_VIDEO_FILE_BYTES / 1_000_000;

const VIDEO_SIZE_ERROR = `Видео не прикреплено. Максимум ${PUBLICATION_VIDEO_MAX_SIZE_MB} МБ.`;

export function preparePublicationVideo(
  file: File,
): Omit<CreatePublicationVideoUpload, 'requestId'> {
  if (file.size > MAX_PUBLICATION_VIDEO_FILE_BYTES) {
    throw new Error(VIDEO_SIZE_ERROR);
  }
  if (file.size === 0) {
    throw new Error('Видео пустое. Выберите другой файл.');
  }
  const mimeType = inferPublicationVideoMimeType(file.name, file.type) as
    | CreatePublicationVideoUpload['mimeType']
    | null;
  if (!mimeType) {
    throw new Error('Видео не прикреплено. Поддерживаются MP4, MOV, MKV и WebM.');
  }

  return {
    mimeType,
    fileName: file.name.trim().slice(0, 128),
    sizeBytes: file.size,
  };
}
