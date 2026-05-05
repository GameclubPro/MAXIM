import type { BroadcastLinkButton, BroadcastTargetMode } from '@maxim/contracts';
import type { BroadcastQuickPreset } from './broadcast-schedule';
import type { BroadcastScopedTargetMode } from './broadcast-audience';

export type BroadcastComposerDraftEntityType = 'chat' | 'channel';

export type BroadcastComposerDraft = {
  text: string;
  targetMode: BroadcastTargetMode;
  targetChatIds: string[];
  lastScopedTargetMode: BroadcastScopedTargetMode;
  buttons: BroadcastLinkButton[];
  imageEnabled: boolean;
  imageBase64: string;
  imageMimeType: string;
  imageFileName: string;
  scheduledSlots: string[];
  quickPreset: BroadcastQuickPreset | null;
  scheduleTimezone: string;
};

const STORAGE_VERSION = 1;
const LOCAL_STORAGE_IMAGE_BASE64_LIMIT = 250_000;
const DRAFT_DB_NAME = 'maxim-broadcast-composer';
const DRAFT_DB_VERSION = 1;
const DRAFT_STORE_NAME = 'drafts';

function getStorageKey(entityType: BroadcastComposerDraftEntityType, entityId: string): string {
  return `maxim:broadcast-composer:${entityType}:${entityId}`;
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function canUseIndexedDb(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function readTargetMode(value: unknown, fallback: BroadcastTargetMode): BroadcastTargetMode {
  return value === 'all' || value === 'selected' || value === 'current' ? value : fallback;
}

function readScopedMode(
  value: unknown,
  fallback: BroadcastScopedTargetMode,
): BroadcastScopedTargetMode {
  return value === 'selected' || value === 'current' ? value : fallback;
}

function readQuickPreset(value: unknown): BroadcastQuickPreset | null {
  return value === 'now' || value === 'plus30' || value === 'tonight' || value === 'tomorrow'
    ? value
    : null;
}

function readButtons(value: unknown): BroadcastLinkButton[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!isObject(item)) {
        return null;
      }

      return {
        text: readString(item.text),
        url: readString(item.url),
      };
    })
    .filter((item): item is BroadcastLinkButton => item !== null);
}

function parseBroadcastComposerDraftEnvelope(value: unknown): BroadcastComposerDraft | null {
  if (!isObject(value) || value.version !== STORAGE_VERSION || !isObject(value.draft)) {
    return null;
  }

  const draft = value.draft;
  return {
    text: readString(draft.text),
    targetMode: readTargetMode(draft.targetMode, 'current'),
    targetChatIds: readStringArray(draft.targetChatIds),
    lastScopedTargetMode: readScopedMode(draft.lastScopedTargetMode, 'current'),
    buttons: readButtons(draft.buttons),
    imageEnabled: draft.imageEnabled === true,
    imageBase64: readString(draft.imageBase64),
    imageMimeType: readString(draft.imageMimeType),
    imageFileName: readString(draft.imageFileName),
    scheduledSlots: readStringArray(draft.scheduledSlots),
    quickPreset: readQuickPreset(draft.quickPreset),
    scheduleTimezone: readString(draft.scheduleTimezone),
  };
}

function openBroadcastDraftDb(): Promise<IDBDatabase | null> {
  if (!canUseIndexedDb()) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const request = window.indexedDB.open(DRAFT_DB_NAME, DRAFT_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        db.createObjectStore(DRAFT_STORE_NAME);
      }
    };
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
  });
}

async function readBroadcastDraftFromIndexedDb(
  key: string,
): Promise<BroadcastComposerDraft | null> {
  const db = await openBroadcastDraftDb();
  if (!db) {
    return null;
  }

  return new Promise((resolve) => {
    const transaction = db.transaction(DRAFT_STORE_NAME, 'readonly');
    const request = transaction.objectStore(DRAFT_STORE_NAME).get(key);

    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(parseBroadcastComposerDraftEnvelope(request.result));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => db.close();
  });
}

async function writeBroadcastDraftToIndexedDb(key: string, value: unknown | null): Promise<void> {
  const db = await openBroadcastDraftDb();
  if (!db) {
    return;
  }

  await new Promise<void>((resolve) => {
    const transaction = db.transaction(DRAFT_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(DRAFT_STORE_NAME);

    if (value === null) {
      store.delete(key);
    } else {
      store.put(value, key);
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

export function loadBroadcastComposerDraft(
  entityType: BroadcastComposerDraftEntityType,
  entityId: string,
): BroadcastComposerDraft | null {
  if (!entityId || !canUseStorage()) {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(getStorageKey(entityType, entityId));
    if (!rawValue) {
      return null;
    }

    return parseBroadcastComposerDraftEnvelope(JSON.parse(rawValue));
  } catch {
    return null;
  }
}

export async function loadBroadcastComposerDraftAsync(
  entityType: BroadcastComposerDraftEntityType,
  entityId: string,
): Promise<BroadcastComposerDraft | null> {
  if (!entityId) {
    return null;
  }

  return (
    (await readBroadcastDraftFromIndexedDb(getStorageKey(entityType, entityId))) ??
    loadBroadcastComposerDraft(entityType, entityId)
  );
}

export function isBroadcastComposerDraftEmpty(draft: BroadcastComposerDraft): boolean {
  return (
    !draft.text.trim() &&
    draft.targetMode === 'current' &&
    draft.targetChatIds.length <= 1 &&
    draft.lastScopedTargetMode === 'current' &&
    draft.buttons.length === 0 &&
    !draft.imageEnabled &&
    draft.scheduledSlots.length === 0 &&
    draft.quickPreset === null
  );
}

export function saveBroadcastComposerDraft(
  entityType: BroadcastComposerDraftEntityType,
  entityId: string,
  draft: BroadcastComposerDraft,
): void {
  if (!entityId || !canUseStorage()) {
    return;
  }

  try {
    const key = getStorageKey(entityType, entityId);
    if (isBroadcastComposerDraftEmpty(draft)) {
      window.localStorage.removeItem(key);
      void writeBroadcastDraftToIndexedDb(key, null);
      return;
    }

    const envelope = {
      version: STORAGE_VERSION,
      savedAt: new Date().toISOString(),
      draft,
    };
    const localDraft =
      draft.imageEnabled && draft.imageBase64.length > LOCAL_STORAGE_IMAGE_BASE64_LIMIT
        ? {
            ...draft,
            imageEnabled: false,
            imageBase64: '',
            imageMimeType: '',
            imageFileName: '',
          }
        : draft;

    void writeBroadcastDraftToIndexedDb(key, envelope);
    window.localStorage.setItem(
      key,
      JSON.stringify({
        ...envelope,
        draft: localDraft,
      }),
    );
  } catch {
    // Storage can be unavailable or quota-limited inside a WebView.
  }
}
