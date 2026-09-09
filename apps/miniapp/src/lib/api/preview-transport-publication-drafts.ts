import {
  publicationActionRequestSchema,
  type PublicationDetails,
} from '@maxim/contracts/publication';
import {
  savePublicationDraftRequestSchema,
  type PublicationDraftState,
} from '@maxim/contracts/publication-draft';
import {
  buildPreviewPublicationDetails,
  handlePublicationsRequest,
} from './preview-transport-publications';
import {
  PREVIEW_NOT_HANDLED,
  readPreviewClock,
  type PreviewRequestHandler,
} from './preview-transport-runtime';
import { cloneJson, parseJsonBody } from './preview-transport-shared';
import type { PreviewState } from './preview-transport-state';

const previewDraftStores = new WeakMap<
  PreviewState,
  {
    states: Map<string, PublicationDraftState>;
    requests: Map<string, { id: string; version: number; fingerprint: string }>;
    assets: Map<string, Blob>;
  }
>();

function draftStore(state: PreviewState) {
  let store = previewDraftStores.get(state);
  if (!store) {
    store = { states: new Map(), requests: new Map(), assets: new Map() };
    previewDraftStores.set(state, store);
  }
  return store;
}
function draftError(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

export const handlePublicationDraftsPreviewRequest: PreviewRequestHandler = ({
  state,
  segments,
  url,
  method,
  init,
}) => {
  if (segments[0] !== 'publications') return PREVIEW_NOT_HANDLED;
  if (segments.length === 2 && segments[1] === 'drafts' && method === 'GET') {
    const query = new URL(url);
    query.searchParams.set('view', 'drafts');
    return handlePublicationsRequest(state, ['publications'], query, method, init);
  }
  const store = draftStore(state);
  if (segments.length === 4 && segments[2] === 'assets' && method === 'GET') {
    const publication = state.publications.find((item) => item.id === segments[1]);
    if (!publication?.content.media.some((asset) => asset.id === segments[3]))
      draftError(404, 'Медиа недоступно.');
    return store.assets.get(segments[3]) ?? draftError(404, 'Предпросмотр недоступен.');
  }
  if (segments[1] === 'drafts') {
    const id = segments[2] === 'by-request' ? store.requests.get(segments[3])?.id : segments[2];
    const existing = state.publications.find(
      (item) => item.id === id && item.lifecycle === 'DRAFT',
    );
    const response = (publication: PublicationDetails) =>
      cloneJson({ publication, state: store.states.get(publication.id) ?? null });
    if (method === 'GET')
      return existing ? response(existing) : draftError(404, 'Черновик не найден.');
    if (method === 'DELETE') {
      const request = publicationActionRequestSchema.parse(parseJsonBody(init));
      if (existing && existing.version !== request.expectedRevision)
        draftError(409, 'Черновик изменён.');
      if (existing)
        state.publications = state.publications.filter((item) => item.id !== existing.id);
      return null;
    }
    if (method === 'POST' || method === 'PUT') {
      const request = savePublicationDraftRequestSchema.parse(parseJsonBody(init));
      const fingerprint = JSON.stringify({ id: id ?? null, request });
      const replay = store.requests.get(request.requestId);
      if (replay) {
        if (replay.fingerprint !== fingerprint)
          draftError(409, 'Идентификатор запроса уже использован.');
        const saved = state.publications.find(
          (item) => item.id === replay.id && item.lifecycle === 'DRAFT',
        );
        if (!saved || saved.version !== replay.version) draftError(409, 'Черновик изменён.');
        return response(saved);
      }
      if (method === 'PUT' && !existing) draftError(404, 'Черновик не найден.');
      if (existing && request.expectedRevision !== existing.version)
        draftError(409, 'Черновик изменён на другом устройстве.');
      const nextId = existing?.id ?? `draft-${request.requestId}`;
      const version = (existing?.version ?? 0) + 1;
      const built = buildPreviewPublicationDetails(
        state,
        {
          title: request.title,
          content: request.content,
          audience: { selection: 'SELECTED', mode: 'SNAPSHOT', targets: request.targets },
          intent: 'draft',
          schedule: null,
        },
        {
          id: nextId,
          version,
          retainedAssets: state.publications.flatMap((item) => item.content.media),
          createdAt: existing?.createdAt,
          updatedAt: readPreviewClock(state.clock).toISOString(),
        },
      ).publication;
      built.content.media.forEach((asset, index) => {
        const media = request.content.media[index];
        if (media && (media.type === 'image' || media.type === 'video') && media.base64) {
          asset.id = `${nextId}-v${version}-asset-${index}`;
          const raw = atob(media.base64);
          store.assets.set(
            asset.id,
            new Blob([Uint8Array.from(raw, (character) => character.charCodeAt(0))], {
              type: media.mimeType,
            }),
          );
        }
      });
      state.publications = [built, ...state.publications.filter((item) => item.id !== nextId)];
      store.states.set(nextId, request.state);
      store.requests.set(request.requestId, { id: nextId, version, fingerprint });
      return response(built);
    }
  }
  return PREVIEW_NOT_HANDLED;
};
