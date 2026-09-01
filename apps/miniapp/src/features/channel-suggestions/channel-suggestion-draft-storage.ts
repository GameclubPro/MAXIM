import type { MiniappProfile } from '@maxim/contracts/publisher';
import {
  advanceContentBoundRequestIdentity,
  type ContentBoundRequestIdentity,
} from '../../lib/client-request-id';
import type { PreparedCommentDialogAttachment } from '../../lib/dialog-attachments';

const DB_NAME = 'maxim-channel-suggestion-drafts';
const DB_VERSION = 2;
const STORE_NAME = 'drafts';
const MEDIA_STORE_NAME = 'media';
const STORAGE_VERSION = 1;
const DRAFT_TTL_MS = 72 * 60 * 60_000;
const IDB_OPEN_TIMEOUT_MS = 1_500;
const MAX_TEXT_LENGTH = 2_000;
const MAX_IMAGES = 10;
const MAX_IMAGE_BASE64_LENGTH = 8_000_000;
const MAX_TOTAL_BASE64_LENGTH = 24_000_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const THREAD_SCOPE_PATTERN = /^[0-9a-f]{32}$/u;
const FNV_1A_128_OFFSET = 0x6c62272e07bb014262b821756295c58dn;
const FNV_1A_128_PRIME = 0x0000000001000000000000000000013bn;
const UINT128_MASK = (1n << 128n) - 1n;

export type ChannelSuggestionDraftScope = {
  userId: string;
  chatId: string;
  profile: MiniappProfile;
  threadScope: string;
};

export type StoredChannelSuggestionDraft = {
  text: string;
  attachments: PreparedCommentDialogAttachment[];
  requestIdentity: ContentBoundRequestIdentity;
  savedAt: string;
  imagesNeedReselection: boolean;
  imageCount: number;
  threadScope: string | null;
};

type StoredAttachment = Omit<PreparedCommentDialogAttachment, 'previewUrl'>;

type ChannelSuggestionDraftEnvelope = {
  version: 1;
  savedAt: string;
  expiresAt: string;
  text: string;
  imageCount: number;
  requestIdentity: ContentBoundRequestIdentity;
  threadScope: string;
};

type ChannelSuggestionMediaEnvelope = {
  version: 1;
  attachments: StoredAttachment[];
};

const storageQueues = new Map<string, Promise<void>>();
const mediaCache = new Map<
  string,
  { attachments: readonly PreparedCommentDialogAttachment[]; stored: boolean }
>();

export type ChannelSuggestionDraftLoadResolution = {
  draft: StoredChannelSuggestionDraft | null;
  source: 'indexed' | 'local' | null;
  discardIndexed: boolean;
  discardLocal: boolean;
};

type ChannelSuggestionDraftCandidate = {
  draft: StoredChannelSuggestionDraft;
  source: 'indexed' | 'local';
  savedAtMs: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function buildChannelSuggestionThreadScope(token: string): string | null {
  const normalized = token.trim();
  if (!normalized) {
    return null;
  }

  // This fingerprint partitions retry state only; the server remains the token authority.
  let hash = FNV_1A_128_OFFSET;
  for (let index = 0; index < normalized.length; index += 1) {
    const codeUnit = normalized.charCodeAt(index);
    hash ^= BigInt(codeUnit & 0xff);
    hash = (hash * FNV_1A_128_PRIME) & UINT128_MASK;
    hash ^= BigInt(codeUnit >>> 8);
    hash = (hash * FNV_1A_128_PRIME) & UINT128_MASK;
  }
  return hash.toString(16).padStart(32, '0');
}

function readThreadScope(value: unknown): string | null {
  return typeof value === 'string' && THREAD_SCOPE_PATTERN.test(value) ? value : null;
}

function readRequestIdentity(value: unknown): ContentBoundRequestIdentity | null {
  if (!isObject(value) || !isSafeRevision(value.draftRevision)) {
    return null;
  }
  const requestId =
    value.requestId === null
      ? null
      : typeof value.requestId === 'string' && REQUEST_ID_PATTERN.test(value.requestId)
        ? value.requestId
        : null;
  const requestRevision =
    value.requestRevision === null
      ? null
      : isSafeRevision(value.requestRevision) && value.requestRevision <= value.draftRevision
        ? value.requestRevision
        : null;
  if ((requestId === null) !== (requestRevision === null)) {
    return null;
  }
  return { requestId, draftRevision: value.draftRevision, requestRevision };
}

function readAttachment(value: unknown): StoredAttachment | null {
  if (!isObject(value)) {
    return null;
  }
  const base64 = typeof value.base64 === 'string' ? value.base64 : '';
  const mimeType = typeof value.mimeType === 'string' ? value.mimeType.trim().toLowerCase() : '';
  const fileName = typeof value.fileName === 'string' ? value.fileName.slice(0, 240) : '';
  const size = typeof value.size === 'number' && Number.isFinite(value.size) ? value.size : 0;
  if (
    !base64 ||
    base64.length > MAX_IMAGE_BASE64_LENGTH ||
    !mimeType.startsWith('image/') ||
    mimeType === 'image/svg+xml'
  ) {
    return null;
  }
  const width =
    typeof value.width === 'number' && Number.isFinite(value.width) && value.width > 0
      ? value.width
      : undefined;
  const height =
    typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0
      ? value.height
      : undefined;
  return {
    type: 'image',
    base64,
    mimeType,
    fileName,
    size: Math.max(0, size),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  };
}

function buildPreviewUrl(attachment: StoredAttachment): string {
  return `data:${attachment.mimeType};base64,${attachment.base64}`;
}

export function buildChannelSuggestionDraftStorageKey(
  scope: ChannelSuggestionDraftScope,
): string | null {
  const userId = scope.userId.trim();
  const chatId = scope.chatId.trim();
  if (!userId || !chatId || !readThreadScope(scope.threadScope)) {
    return null;
  }
  // Keep content channel-scoped; the envelope rotates retry identity when the thread changes.
  return `maxim:channel-suggestion-draft:v1:${scope.profile}:${encodeURIComponent(userId)}:${encodeURIComponent(chatId)}`;
}

export function parseChannelSuggestionDraftEnvelope(
  value: unknown,
  nowMs = Date.now(),
  mediaValue?: unknown,
): StoredChannelSuggestionDraft | null {
  if (!isObject(value) || value.version !== STORAGE_VERSION) {
    return null;
  }
  const savedAtMs = typeof value.savedAt === 'string' ? Date.parse(value.savedAt) : Number.NaN;
  const expiresAtMs =
    typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : Number.NaN;
  const text = typeof value.text === 'string' ? value.text : '';
  const imageCount =
    typeof value.imageCount === 'number' &&
    Number.isSafeInteger(value.imageCount) &&
    value.imageCount >= 0 &&
    value.imageCount <= MAX_IMAGES
      ? value.imageCount
      : -1;
  const requestIdentity = readRequestIdentity(value.requestIdentity);
  if (
    !Number.isFinite(savedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= nowMs ||
    expiresAtMs - savedAtMs > DRAFT_TTL_MS + 60_000 ||
    text.length > MAX_TEXT_LENGTH ||
    !requestIdentity ||
    imageCount < 0
  ) {
    return null;
  }
  const rawMediaAttachments =
    isObject(mediaValue) && mediaValue.version === 1 && Array.isArray(mediaValue.attachments)
      ? mediaValue.attachments
      : [];
  const storedAttachments = rawMediaAttachments.map(readAttachment);
  const validAttachments = storedAttachments.filter(
    (attachment): attachment is StoredAttachment => attachment !== null,
  );
  const mediaValid =
    validAttachments.length === imageCount &&
    validAttachments.reduce((total, attachment) => total + attachment.base64.length, 0) <=
      MAX_TOTAL_BASE64_LENGTH;
  const attachments = mediaValid ? validAttachments : [];
  return {
    text,
    attachments: attachments.map((attachment) => ({
      ...attachment,
      previewUrl: buildPreviewUrl(attachment),
    })),
    requestIdentity,
    savedAt: new Date(savedAtMs).toISOString(),
    imagesNeedReselection: imageCount > 0 && !mediaValid,
    imageCount,
    threadScope: readThreadScope(value.threadScope),
  };
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined') {
    return Promise.resolve(null);
  }
  let indexedDb: IDBFactory | undefined;
  try {
    indexedDb = window.indexedDB;
  } catch {
    return Promise.resolve(null);
  }
  if (!indexedDb) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDb.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let timeoutId: number | null = null;
    const finish = (database: IDBDatabase | null) => {
      if (settled) {
        database?.close();
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      resolve(database);
    };
    timeoutId = globalThis.setTimeout(() => finish(null), IDB_OPEN_TIMEOUT_MS);
    request.onupgradeneeded = () => {
      try {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
        if (!request.result.objectStoreNames.contains(MEDIA_STORE_NAME)) {
          request.result.createObjectStore(MEDIA_STORE_NAME);
        }
      } catch {
        request.transaction?.abort();
      }
    };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
    request.onsuccess = () => finish(request.result);
  });
}

async function readState(storageKey: string): Promise<{ envelope: unknown; media: unknown }> {
  const db = await openDatabase();
  if (!db) {
    return { envelope: null, media: null };
  }
  try {
    return await new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME, MEDIA_STORE_NAME], 'readonly');
      const envelopeRequest = transaction.objectStore(STORE_NAME).get(storageKey);
      const mediaRequest = transaction.objectStore(MEDIA_STORE_NAME).get(storageKey);
      let envelope: unknown = null;
      let media: unknown = null;
      let settled = false;
      envelopeRequest.onsuccess = () => {
        envelope = envelopeRequest.result;
      };
      mediaRequest.onsuccess = () => {
        media = mediaRequest.result;
      };
      const finish = (state: { envelope: unknown; media: unknown }) => {
        if (settled) {
          return;
        }
        settled = true;
        db.close();
        resolve(state);
      };
      transaction.oncomplete = () => finish({ envelope, media });
      transaction.onabort = () => finish({ envelope: null, media: null });
      transaction.onerror = () => finish({ envelope: null, media: null });
    });
  } catch {
    db.close();
    return { envelope: null, media: null };
  }
}

async function writeState(
  storageKey: string,
  envelope: ChannelSuggestionDraftEnvelope | null,
  mediaUpdate?: readonly PreparedCommentDialogAttachment[] | null,
): Promise<boolean> {
  const db = await openDatabase();
  if (!db) {
    return false;
  }
  try {
    return await new Promise<boolean>((resolve) => {
      const transaction = db.transaction([STORE_NAME, MEDIA_STORE_NAME], 'readwrite');
      const draftStore = transaction.objectStore(STORE_NAME);
      const mediaStore = transaction.objectStore(MEDIA_STORE_NAME);
      let settled = false;
      const finish = (success: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        db.close();
        resolve(success);
      };
      if (envelope) {
        draftStore.put(envelope, storageKey);
      } else {
        draftStore.delete(storageKey);
        mediaStore.delete(storageKey);
      }
      if (envelope && mediaUpdate !== undefined) {
        if (mediaUpdate && mediaUpdate.length > 0) {
          const attachments = mediaUpdate.map(({ previewUrl: _previewUrl, ...attachment }) => ({
            ...attachment,
            type: 'image' as const,
          }));
          mediaStore.put(
            { version: 1, attachments } satisfies ChannelSuggestionMediaEnvelope,
            storageKey,
          );
        } else {
          mediaStore.delete(storageKey);
        }
      }
      transaction.oncomplete = () => finish(true);
      transaction.onabort = () => finish(false);
      transaction.onerror = () => finish(false);
    });
  } catch {
    db.close();
    return false;
  }
}

function enqueue(storageKey: string, mutation: () => Promise<void>): Promise<void> {
  const previous = storageQueues.get(storageKey) ?? Promise.resolve();
  const queued = previous.then(mutation, mutation);
  storageQueues.set(storageKey, queued);
  const clearQueue = () => {
    if (storageQueues.get(storageKey) === queued) {
      storageQueues.delete(storageKey);
    }
  };
  void queued.then(clearQueue, clearQueue);
  return queued;
}

function readLocalEnvelope(storageKey: string): unknown {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const value = window.localStorage.getItem(storageKey);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeLocalEnvelope(storageKey: string, envelope: ChannelSuggestionDraftEnvelope): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(envelope));
  } catch {
    // IndexedDB remains the primary store when localStorage is unavailable or full.
  }
}

function removeLocalEnvelope(storageKey: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Storage can be unavailable inside a WebView.
  }
}

function readDraftCandidate(params: {
  envelope: unknown;
  media?: unknown;
  source: 'indexed' | 'local';
  nowMs: number;
}): { candidate: ChannelSuggestionDraftCandidate | null; discard: boolean } {
  if (params.envelope === null || params.envelope === undefined) {
    return { candidate: null, discard: false };
  }
  const draft = parseChannelSuggestionDraftEnvelope(params.envelope, params.nowMs, params.media);
  if (!draft) {
    return { candidate: null, discard: true };
  }
  return {
    candidate: {
      draft,
      source: params.source,
      savedAtMs: Date.parse(draft.savedAt),
    },
    discard: false,
  };
}

export function bindChannelSuggestionDraftToThread(
  draft: StoredChannelSuggestionDraft,
  threadScope: string,
): StoredChannelSuggestionDraft {
  const normalizedThreadScope = readThreadScope(threadScope);
  if (!normalizedThreadScope || draft.threadScope === normalizedThreadScope) {
    return draft;
  }
  return {
    ...draft,
    requestIdentity: advanceContentBoundRequestIdentity(draft.requestIdentity),
    threadScope: normalizedThreadScope,
  };
}

export function resolveChannelSuggestionDraftLoadState(params: {
  indexedEnvelope: unknown;
  indexedMedia?: unknown;
  localEnvelope: unknown;
  threadScope: string;
  nowMs?: number;
}): ChannelSuggestionDraftLoadResolution {
  const nowMs = params.nowMs ?? Date.now();
  const indexed = readDraftCandidate({
    envelope: params.indexedEnvelope,
    media: params.indexedMedia,
    source: 'indexed',
    nowMs,
  });
  const local = readDraftCandidate({
    envelope: params.localEnvelope,
    source: 'local',
    nowMs,
  });
  const candidates = [indexed.candidate, local.candidate].filter(
    (candidate): candidate is ChannelSuggestionDraftCandidate => candidate !== null,
  );
  candidates.sort((left, right) => {
    const savedAtDiff = right.savedAtMs - left.savedAtMs;
    if (savedAtDiff !== 0) {
      return savedAtDiff;
    }
    if (left.draft.imagesNeedReselection !== right.draft.imagesNeedReselection) {
      return Number(left.draft.imagesNeedReselection) - Number(right.draft.imagesNeedReselection);
    }
    return left.source === 'indexed' ? -1 : 1;
  });
  const selected = candidates[0] ?? null;
  const draft = selected
    ? bindChannelSuggestionDraftToThread(selected.draft, params.threadScope)
    : null;

  return {
    draft,
    source: selected?.source ?? null,
    discardIndexed:
      indexed.discard ||
      Boolean(
        selected?.source === 'local' &&
        indexed.candidate &&
        indexed.candidate.savedAtMs < selected.savedAtMs,
      ),
    discardLocal:
      local.discard ||
      Boolean(
        selected?.source === 'indexed' &&
        local.candidate &&
        local.candidate.savedAtMs < selected.savedAtMs,
      ),
  };
}

export async function loadChannelSuggestionDraft(
  scope: ChannelSuggestionDraftScope,
): Promise<StoredChannelSuggestionDraft | null> {
  const storageKey = buildChannelSuggestionDraftStorageKey(scope);
  if (!storageKey) {
    return null;
  }
  await storageQueues.get(storageKey);
  const [state, localEnvelope] = await Promise.all([
    readState(storageKey),
    Promise.resolve(readLocalEnvelope(storageKey)),
  ]);
  const resolved = resolveChannelSuggestionDraftLoadState({
    indexedEnvelope: state.envelope,
    indexedMedia: state.media,
    localEnvelope,
    threadScope: scope.threadScope,
  });
  if (resolved.discardIndexed) {
    await writeState(storageKey, null);
  }
  if (resolved.discardLocal) {
    removeLocalEnvelope(storageKey);
  }
  if (!resolved.draft) {
    mediaCache.delete(storageKey);
  } else if (resolved.source === 'indexed' && !resolved.draft.imagesNeedReselection) {
    const mediaStored =
      resolved.draft.imageCount === 0 ||
      (isObject(state.media) &&
        state.media.version === 1 &&
        Array.isArray(state.media.attachments));
    mediaCache.set(storageKey, {
      attachments: resolved.draft.attachments,
      stored: mediaStored,
    });
  } else {
    mediaCache.delete(storageKey);
  }
  return resolved.draft;
}

export async function saveChannelSuggestionDraft(
  scope: ChannelSuggestionDraftScope,
  draft: Pick<
    StoredChannelSuggestionDraft,
    'text' | 'attachments' | 'requestIdentity' | 'imagesNeedReselection' | 'imageCount'
  >,
): Promise<void> {
  const storageKey = buildChannelSuggestionDraftStorageKey(scope);
  if (!storageKey) {
    return;
  }
  const savedAt = new Date();
  const threadScope = readThreadScope(scope.threadScope);
  if (!threadScope) {
    return;
  }
  const envelope: ChannelSuggestionDraftEnvelope = {
    version: STORAGE_VERSION,
    savedAt: savedAt.toISOString(),
    expiresAt: new Date(savedAt.getTime() + DRAFT_TTL_MS).toISOString(),
    text: draft.text.slice(0, MAX_TEXT_LENGTH),
    imageCount: draft.imagesNeedReselection
      ? Math.max(1, Math.min(MAX_IMAGES, draft.imageCount))
      : Math.min(MAX_IMAGES, draft.attachments.length),
    requestIdentity: { ...draft.requestIdentity },
    threadScope,
  };
  writeLocalEnvelope(storageKey, envelope);
  await enqueue(storageKey, async () => {
    const cached = mediaCache.get(storageKey);
    const mediaChanged =
      draft.imagesNeedReselection || !cached?.stored || cached.attachments !== draft.attachments;
    const stored = await writeState(
      storageKey,
      envelope,
      mediaChanged
        ? draft.imagesNeedReselection
          ? null
          : draft.attachments.slice(0, MAX_IMAGES)
        : undefined,
    );
    if (stored && !draft.imagesNeedReselection) {
      mediaCache.set(storageKey, { attachments: draft.attachments, stored: true });
    } else if (!stored || draft.imagesNeedReselection) {
      mediaCache.delete(storageKey);
    }
  });
}

export async function clearChannelSuggestionDraft(
  scope: ChannelSuggestionDraftScope,
): Promise<void> {
  const storageKey = buildChannelSuggestionDraftStorageKey(scope);
  if (!storageKey) {
    return;
  }
  removeLocalEnvelope(storageKey);
  await enqueue(storageKey, async () => {
    await writeState(storageKey, null);
    mediaCache.delete(storageKey);
  });
}

export async function flushChannelSuggestionDraftStorage(
  scope: ChannelSuggestionDraftScope,
): Promise<void> {
  const storageKey = buildChannelSuggestionDraftStorageKey(scope);
  if (storageKey) {
    await storageQueues.get(storageKey);
  }
}
