import type { BroadcastImage } from '@maxim/contracts';
import {
  createEmptyAutoReplyDraft,
  normalizeAutoReplyDraft,
  type AutoReplyAssetMetadata,
  type AutoReplyDraft,
} from '../pages/publisher-auto-replies-page-model';
import {
  readLocalMirrorItem,
  readNativeStorageItem,
  removeLocalMirrorItem,
  removeNativeStorageItem,
  writeLocalMirrorItem,
  writeNativeStorageItem,
} from './native-storage';

const AUTO_REPLY_DRAFT_VERSION = 1;
const AUTO_REPLY_DRAFT_DB_NAME = 'maxim-publisher-auto-replies';
const AUTO_REPLY_DRAFT_DB_VERSION = 1;
const AUTO_REPLY_DRAFT_STORE_NAME = 'drafts';

type StoredAutoReplyDraft = Omit<AutoReplyDraft, 'images'> & { images: BroadcastImage[] };

type AutoReplyDraftEnvelope = {
  version: typeof AUTO_REPLY_DRAFT_VERSION;
  savedAt: string;
  draft: StoredAutoReplyDraft;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAssetMetadata(value: unknown): AutoReplyAssetMetadata[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType.trim() : '';
    const fileName = typeof item.fileName === 'string' ? item.fileName.trim() : '';
    return id && mimeType.startsWith('image/') ? [{ id, mimeType, fileName }] : [];
  });
}

function readImages(value: unknown): BroadcastImage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const base64 = typeof item.base64 === 'string' ? item.base64.trim() : '';
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType.trim() : '';
    const fileName = typeof item.fileName === 'string' ? item.fileName.trim() : '';
    return base64 && mimeType.startsWith('image/') ? [{ base64, mimeType, fileName }] : [];
  });
}

function parseAutoReplyDraftEnvelope(value: unknown): AutoReplyDraft | null {
  if (!isRecord(value) || value.version !== AUTO_REPLY_DRAFT_VERSION || !isRecord(value.draft)) {
    return null;
  }

  const fallback = createEmptyAutoReplyDraft();
  const draft = value.draft;
  return normalizeAutoReplyDraft({
    phrase: typeof draft.phrase === 'string' ? draft.phrase : '',
    text: typeof draft.text === 'string' ? draft.text : '',
    images: readImages(draft.images),
    retainedAssets: readAssetMetadata(draft.retainedAssets),
    cooldownSeconds:
      typeof draft.cooldownSeconds === 'number' ? draft.cooldownSeconds : fallback.cooldownSeconds,
    enabled: typeof draft.enabled === 'boolean' ? draft.enabled : fallback.enabled,
  });
}

export function getAutoReplyDraftStorageKey(chatId: string, ruleId?: string | null): string {
  const scope = ruleId?.trim() || 'new';
  return `maxim:publisher-auto-reply:${encodeURIComponent(chatId)}:${encodeURIComponent(scope)}`;
}

function openAutoReplyDraftDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const request = window.indexedDB.open(AUTO_REPLY_DRAFT_DB_NAME, AUTO_REPLY_DRAFT_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(AUTO_REPLY_DRAFT_STORE_NAME)) {
        request.result.createObjectStore(AUTO_REPLY_DRAFT_STORE_NAME);
      }
    };
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
  });
}

async function readIndexedDraft(key: string): Promise<AutoReplyDraft | null> {
  const db = await openAutoReplyDraftDb();
  if (!db) {
    return null;
  }

  return new Promise((resolve) => {
    const transaction = db.transaction(AUTO_REPLY_DRAFT_STORE_NAME, 'readonly');
    const request = transaction.objectStore(AUTO_REPLY_DRAFT_STORE_NAME).get(key);
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(parseAutoReplyDraftEnvelope(request.result));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => db.close();
  });
}

async function writeIndexedDraft(
  key: string,
  envelope: AutoReplyDraftEnvelope | null,
): Promise<void> {
  const db = await openAutoReplyDraftDb();
  if (!db) {
    return;
  }

  await new Promise<void>((resolve) => {
    const transaction = db.transaction(AUTO_REPLY_DRAFT_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(AUTO_REPLY_DRAFT_STORE_NAME);
    if (envelope) {
      store.put(envelope, key);
    } else {
      store.delete(key);
    }
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      resolve();
    };
  });
}

function serializeNativeEnvelope(envelope: AutoReplyDraftEnvelope): string {
  return JSON.stringify({
    ...envelope,
    draft: { ...envelope.draft, images: [] },
  });
}

export async function loadAutoReplyDraft(
  chatId: string,
  ruleId?: string | null,
): Promise<AutoReplyDraft | null> {
  if (!chatId) {
    return null;
  }

  const key = getAutoReplyDraftStorageKey(chatId, ruleId);
  const indexedDraft = await readIndexedDraft(key);
  if (indexedDraft) {
    return indexedDraft;
  }

  const nativeValue = (await readNativeStorageItem(key)) ?? readLocalMirrorItem(key);
  if (!nativeValue) {
    return null;
  }

  try {
    return parseAutoReplyDraftEnvelope(JSON.parse(nativeValue));
  } catch {
    return null;
  }
}

export function saveAutoReplyDraft(
  chatId: string,
  ruleId: string | null | undefined,
  draft: AutoReplyDraft,
): void {
  if (!chatId || typeof window === 'undefined') {
    return;
  }

  const key = getAutoReplyDraftStorageKey(chatId, ruleId);
  const envelope: AutoReplyDraftEnvelope = {
    version: AUTO_REPLY_DRAFT_VERSION,
    savedAt: new Date().toISOString(),
    draft: normalizeAutoReplyDraft(draft),
  };
  const nativeEnvelope = serializeNativeEnvelope(envelope);
  writeLocalMirrorItem(key, nativeEnvelope);
  void writeNativeStorageItem(key, nativeEnvelope);
  void writeIndexedDraft(key, envelope);
}

export async function clearAutoReplyDraft(chatId: string, ruleId?: string | null): Promise<void> {
  if (!chatId) {
    return;
  }

  const key = getAutoReplyDraftStorageKey(chatId, ruleId);
  removeLocalMirrorItem(key);
  await Promise.allSettled([removeNativeStorageItem(key), writeIndexedDraft(key, null)]);
}
