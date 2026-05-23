import type { BroadcastImage, BroadcastLinkButton, BroadcastTargetMode } from '@maxim/contracts';
import {
  normalizeBroadcastCycleDraft,
  normalizeBroadcastTimingMode,
  type BroadcastCycleDraft,
  type BroadcastTimingMode,
} from './broadcast-schedule';
import type { BroadcastScopedTargetMode } from './broadcast-audience';
import {
  readNativeStorageItem,
  removeNativeStorageItem,
  writeNativeStorageItem,
} from './native-storage';

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
  images: BroadcastImage[];
  timingMode: BroadcastTimingMode;
  scheduledSlots: string[];
  scheduleTimezone: string;
  cycle: BroadcastCycleDraft;
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
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
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

function readTimingMode(value: unknown, legacyQuickPreset: unknown): BroadcastTimingMode {
  const normalized = normalizeBroadcastTimingMode(value);
  if (normalized) {
    return normalized;
  }

  return legacyQuickPreset === 'now' ? 'now' : 'scheduled';
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

function readImages(value: unknown): BroadcastImage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!isObject(item)) {
        return null;
      }

      const base64 = readString(item.base64).trim();
      if (!base64) {
        return null;
      }

      return {
        base64,
        mimeType: readString(item.mimeType).trim(),
        fileName: readString(item.fileName).trim(),
      };
    })
    .filter((item): item is BroadcastImage => item !== null)
    .slice(0, 10);
}

function resolveDraftImages(draft: Record<string, unknown>): BroadcastImage[] {
  const images = readImages(draft.images);
  if (images.length > 0) {
    return images;
  }

  const imageBase64 = readString(draft.imageBase64).trim();
  if (!imageBase64) {
    return [];
  }

  return [
    {
      base64: imageBase64,
      mimeType: readString(draft.imageMimeType).trim(),
      fileName: readString(draft.imageFileName).trim(),
    },
  ];
}

function parseBroadcastComposerDraftEnvelope(value: unknown): BroadcastComposerDraft | null {
  if (!isObject(value) || value.version !== STORAGE_VERSION || !isObject(value.draft)) {
    return null;
  }

  const draft = value.draft;
  const images = resolveDraftImages(draft);
  const firstImage = images[0];
  return {
    text: readString(draft.text),
    targetMode: readTargetMode(draft.targetMode, 'current'),
    targetChatIds: readStringArray(draft.targetChatIds),
    lastScopedTargetMode: readScopedMode(draft.lastScopedTargetMode, 'current'),
    buttons: readButtons(draft.buttons),
    imageEnabled: images.length > 0,
    imageBase64: firstImage?.base64 ?? '',
    imageMimeType: firstImage?.mimeType ?? '',
    imageFileName: firstImage?.fileName ?? '',
    images,
    timingMode: readTimingMode(draft.timingMode, draft.quickPreset),
    scheduledSlots: readStringArray(draft.scheduledSlots),
    scheduleTimezone: readString(draft.scheduleTimezone),
    cycle: normalizeBroadcastCycleDraft(isObject(draft.cycle) ? draft.cycle : null),
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

  const key = getStorageKey(entityType, entityId);
  const indexedDraft = await readBroadcastDraftFromIndexedDb(key);
  if (indexedDraft) {
    return indexedDraft;
  }

  const nativeDraft = await readNativeStorageItem(key);
  if (nativeDraft) {
    try {
      return parseBroadcastComposerDraftEnvelope(JSON.parse(nativeDraft));
    } catch {
      return loadBroadcastComposerDraft(entityType, entityId);
    }
  }

  return loadBroadcastComposerDraft(entityType, entityId);
}

export function isBroadcastComposerDraftEmpty(draft: BroadcastComposerDraft): boolean {
  const hasButtonDraft = draft.buttons.some((button) => button.text.trim() || button.url.trim());
  const hasImageDraft =
    draft.images.length > 0 || draft.imageEnabled || Boolean(draft.imageBase64.trim());
  const hasSchedule =
    draft.timingMode === 'scheduled'
      ? draft.scheduledSlots.length > 0
      : draft.timingMode === 'cycle';

  return (
    !draft.text.trim() &&
    draft.targetMode === 'current' &&
    draft.targetChatIds.length <= 1 &&
    draft.lastScopedTargetMode === 'current' &&
    !hasButtonDraft &&
    !hasImageDraft &&
    !hasSchedule
  );
}

function getDraftImagesBase64Length(draft: BroadcastComposerDraft): number {
  return draft.images.reduce((total, image) => total + image.base64.length, 0);
}

export function saveBroadcastComposerDraft(
  entityType: BroadcastComposerDraftEntityType,
  entityId: string,
  draft: BroadcastComposerDraft,
): void {
  if (!entityId || typeof window === 'undefined') {
    return;
  }

  const key = getStorageKey(entityType, entityId);
  try {
    if (isBroadcastComposerDraftEmpty(draft)) {
      if (canUseStorage()) {
        window.localStorage.removeItem(key);
      }
      void writeBroadcastDraftToIndexedDb(key, null);
      void removeNativeStorageItem(key);
      return;
    }

    const envelope = {
      version: STORAGE_VERSION,
      savedAt: new Date().toISOString(),
      draft,
    };
    const localDraft =
      draft.images.length > 0 &&
      getDraftImagesBase64Length(draft) > LOCAL_STORAGE_IMAGE_BASE64_LIMIT
        ? {
            ...draft,
            imageEnabled: false,
            imageBase64: '',
            imageMimeType: '',
            imageFileName: '',
            images: [],
          }
        : draft;
    const localEnvelope = {
      ...envelope,
      draft: localDraft,
    };

    void writeBroadcastDraftToIndexedDb(key, envelope);
    const serializedLocalEnvelope = JSON.stringify(localEnvelope);
    if (serializedLocalEnvelope.length <= LOCAL_STORAGE_IMAGE_BASE64_LIMIT) {
      void writeNativeStorageItem(key, serializedLocalEnvelope);
    }
    if (canUseStorage()) {
      window.localStorage.setItem(key, serializedLocalEnvelope);
    }
  } catch {
    // Storage can be unavailable or quota-limited inside a WebView.
  }
}
