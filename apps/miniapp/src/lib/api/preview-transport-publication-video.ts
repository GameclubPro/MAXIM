import {
  createPublicationVideoUploadSchema,
  type PublicationAsset,
  type PublicationVideoUploadStatus,
} from '@maxim/contracts/publication';
import type { PreviewState } from './preview-transport-state';
import { PREVIEW_NOT_HANDLED, type PreviewRequestHandler } from './preview-transport-runtime';
import { parseJsonBody } from './preview-transport-shared';

const uploads = new WeakMap<PreviewState, Map<string, PublicationAsset>>();

export function getPreviewUploadedVideos(state: PreviewState): PublicationAsset[] {
  return Array.from(uploads.get(state)?.values() ?? []);
}

export const handlePublicationVideoPreviewRequest: PreviewRequestHandler = ({
  state,
  segments,
  method,
  init,
}) => {
  if (segments[0] !== 'publications' || segments[1] !== 'video-uploads') return PREVIEW_NOT_HANDLED;
  if (state.me.profile !== 'publisher') throw new Error('Видео недоступно.');
  let store = uploads.get(state);
  if (!store) {
    store = new Map();
    uploads.set(state, store);
  }
  if (method === 'POST' && segments.length === 2) {
    const input = createPublicationVideoUploadSchema.parse(parseJsonBody(init));
    store.set(input.requestId, {
      id: `preview-video-${input.requestId}`,
      type: 'video',
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    });
    return {
      status: 'UPLOADING',
      uploadId: input.requestId,
      url: `https://preview.okcdn.ru/video/${input.requestId}`,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    } satisfies PublicationVideoUploadStatus;
  }
  const uploadId = segments[2];
  const asset = store.get(uploadId);
  if (!asset) throw new Error('Загрузка видео недоступна.');
  if ((method === 'POST' && segments[3] === 'complete') || method === 'GET') {
    return { status: 'READY', uploadId, asset } satisfies PublicationVideoUploadStatus;
  }
  return PREVIEW_NOT_HANDLED;
};
