import type { BroadcastImage, BroadcastLinkButton } from '@maxim/contracts';
import { formatLocalDateTimeInputValue } from '../../lib/broadcast-schedule';
import { getInitDataUserId } from '../../lib/init-data';
import {
  createEmptyPublicationDraft,
  type PublicationDraft,
  PublicationTarget,
  PublicationTimingMode,
} from './publication-model';

const STORAGE_VERSION = 1;
const STORAGE_KEY_PREFIX = 'maxim:publications-composer:v1';
const LEGACY_STORAGE_KEY = STORAGE_KEY_PREFIX;
const ANONYMOUS_STORAGE_SCOPE = 'anonymous';
const DB_NAME = 'maxim-publications-composer';
const DB_VERSION = 1;
const STORE_NAME = 'drafts';

type DraftEnvelope = {
  version: 1;
  savedAt: string;
  draft: PublicationDraft;
};

export function buildPublicationDraftStorageKey(userId?: string | null): string {
  const resolvedUserId =
    userId === undefined && typeof window !== 'undefined' ? getInitDataUserId() : userId;
  const scope = resolvedUserId?.trim() || ANONYMOUS_STORAGE_SCOPE;
  return `${STORAGE_KEY_PREFIX}:${encodeURIComponent(scope)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readTargets(value: unknown): PublicationTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isObject(item) || typeof item.id !== 'string') {
      return [];
    }
    const entityType =
      item.entityType === 'channel' ? 'channel' : item.entityType === 'chat' ? 'chat' : null;
    if (!entityType) {
      return [];
    }
    return [
      {
        id: item.id,
        entityType,
        title: readString(item.title),
        avatarUrl: typeof item.avatarUrl === 'string' ? item.avatarUrl : null,
      },
    ];
  });
}

function readImages(value: unknown): BroadcastImage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isObject(item)) {
      return [];
    }
    const base64 = readString(item.base64);
    const mimeType = readString(item.mimeType);
    if (!base64 || !mimeType) {
      return [];
    }
    return [{ base64, mimeType, fileName: readString(item.fileName) }];
  });
}

function readButtons(value: unknown): BroadcastLinkButton[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) =>
    isObject(item) ? [{ text: readString(item.text), url: readString(item.url) }] : [],
  );
}

function readTimingMode(value: unknown): PublicationTimingMode {
  return value === 'once' || value === 'schedule' ? value : 'now';
}

function readRecurrence(value: unknown): PublicationDraft['recurrence'] {
  const source = isObject(value) ? value : {};
  return {
    frequency: source.frequency === 'daily' ? 'daily' : 'weekly',
    interval:
      typeof source.interval === 'number' && Number.isInteger(source.interval)
        ? Math.max(1, Math.min(31, source.interval))
        : 1,
    weekdays: Array.isArray(source.weekdays)
      ? source.weekdays.filter(
          (item): item is number =>
            typeof item === 'number' && Number.isInteger(item) && item >= 1 && item <= 7,
        )
      : [],
    times: Array.isArray(source.times)
      ? source.times.filter((item): item is string => typeof item === 'string')
      : ['10:00'],
    startsAt: typeof source.startsAt === 'string' ? source.startsAt : null,
    endsAt: typeof source.endsAt === 'string' ? source.endsAt : null,
    maxOccurrences:
      typeof source.maxOccurrences === 'number' && Number.isInteger(source.maxOccurrences)
        ? source.maxOccurrences
        : null,
  };
}

export function parsePublicationDraftEnvelope(value: unknown): PublicationDraft | null {
  if (!isObject(value) || value.version !== STORAGE_VERSION || !isObject(value.draft)) {
    return null;
  }
  const draft = value.draft;
  const hasExplicitTimingFields =
    Object.prototype.hasOwnProperty.call(draft, 'onceDate') ||
    Object.prototype.hasOwnProperty.call(draft, 'onceTime');
  const timingMode = readTimingMode(draft.timingMode);
  const scheduleKind = draft.scheduleKind === 'recurrence' ? 'recurrence' : 'slots';
  const safeTimingDefaults = createEmptyPublicationDraft().recurrence;
  const scheduledSlots = Array.isArray(draft.scheduledSlots)
    ? draft.scheduledSlots.filter((item): item is string => typeof item === 'string')
    : [];
  const shouldRestoreLegacySlots =
    hasExplicitTimingFields ||
    timingMode === 'once' ||
    (timingMode === 'schedule' && scheduleKind === 'slots');
  const shouldRestoreLegacyRecurrence =
    hasExplicitTimingFields || (timingMode === 'schedule' && scheduleKind === 'recurrence');
  const storedOnceValue = scheduledSlots[0] ? formatLocalDateTimeInputValue(scheduledSlots[0]) : '';
  const [storedOnceDate = '', storedOnceTime = ''] = storedOnceValue.split('T');
  return {
    title: readString(draft.title),
    text: readString(draft.text),
    images: readImages(draft.images),
    buttons: readButtons(draft.buttons),
    buttonEnabled: draft.buttonEnabled === true,
    targets: readTargets(draft.targets),
    timingMode,
    scheduleKind,
    scheduledSlots: shouldRestoreLegacySlots ? scheduledSlots : [],
    onceDate:
      hasExplicitTimingFields || timingMode === 'once'
        ? readString(draft.onceDate) || storedOnceDate
        : '',
    onceTime:
      hasExplicitTimingFields || timingMode === 'once'
        ? readString(draft.onceTime) || storedOnceTime
        : '',
    scheduleTimezone: readString(draft.scheduleTimezone) || 'Europe/Moscow',
    recurrence: shouldRestoreLegacyRecurrence
      ? readRecurrence(draft.recurrence)
      : safeTimingDefaults,
    mediaType: draft.mediaType === 'video' ? 'video' : null,
    mediaPayload: isObject(draft.mediaPayload) ? draft.mediaPayload : null,
    mediaBase64: readString(draft.mediaBase64),
    mediaMimeType: readString(draft.mediaMimeType),
    mediaFileName: readString(draft.mediaFileName),
    retainedAssets: [],
  };
}

function openDraftDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
  });
}

async function readIndexedDraft(storageKey: string): Promise<PublicationDraft | null> {
  const db = await openDraftDb();
  if (!db) {
    return null;
  }
  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(storageKey);
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(parsePublicationDraftEnvelope(request.result));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => db.close();
  });
}

async function writeIndexedDraft(
  storageKey: string,
  envelope: DraftEnvelope | null,
): Promise<void> {
  const db = await openDraftDb();
  if (!db) {
    return;
  }
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    if (envelope) {
      store.put(envelope, storageKey);
    } else {
      store.delete(storageKey);
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

async function clearLegacyPublicationDraft(): Promise<void> {
  await writeIndexedDraft(LEGACY_STORAGE_KEY, null);
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Storage can be unavailable inside a WebView.
  }
}

export async function loadPublicationDraft(): Promise<PublicationDraft | null> {
  const storageKey = buildPublicationDraftStorageKey();
  await clearLegacyPublicationDraft();
  const indexedDraft = await readIndexedDraft(storageKey);
  if (indexedDraft) {
    return indexedDraft;
  }
  try {
    const value = window.localStorage.getItem(storageKey);
    return value ? parsePublicationDraftEnvelope(JSON.parse(value)) : null;
  } catch {
    return null;
  }
}

export async function savePublicationDraft(draft: PublicationDraft): Promise<void> {
  const storageKey = buildPublicationDraftStorageKey();
  const envelope: DraftEnvelope = {
    version: STORAGE_VERSION,
    savedAt: new Date().toISOString(),
    draft,
  };
  await clearLegacyPublicationDraft();
  await writeIndexedDraft(storageKey, envelope);
  try {
    const localDraft = {
      ...draft,
      images: [],
      mediaPayload: null,
      mediaBase64: '',
      mediaType: null,
      retainedAssets: [],
    };
    window.localStorage.setItem(storageKey, JSON.stringify({ ...envelope, draft: localDraft }));
  } catch {
    // IndexedDB remains the primary storage in quota-limited WebViews.
  }
}

export async function clearPublicationDraft(): Promise<void> {
  const storageKey = buildPublicationDraftStorageKey();
  await clearLegacyPublicationDraft();
  await writeIndexedDraft(storageKey, null);
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Storage can be unavailable inside a WebView.
  }
}
