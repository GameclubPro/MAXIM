import { buildPublicationDraftStorageKey } from './publication-draft-storage';
import type { PublicationCreateIdentityRecord } from './publication-request-identity';

const CREATE_IDENTITY_STORAGE_SUFFIX = ':pending-create:v1';
const MAX_CREATE_IDENTITY_STORAGE_LENGTH = 512;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const FINGERPRINT_PATTERN = /^v1:[a-f0-9]{32}$/u;

export type PublicationCreateIdentityStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function resolveStorage(
  storage: PublicationCreateIdentityStorage | null | undefined,
): PublicationCreateIdentityStorage | null {
  if (storage !== undefined) {
    return storage;
  }
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function buildPublicationCreateIdentityStorageKey(userId?: string | null): string {
  return `${buildPublicationDraftStorageKey(userId)}${CREATE_IDENTITY_STORAGE_SUFFIX}`;
}

export function parsePublicationCreateIdentityRecord(
  value: unknown,
): PublicationCreateIdentityRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !keys.includes('requestId') ||
    !keys.includes('fingerprint') ||
    typeof record.requestId !== 'string' ||
    typeof record.fingerprint !== 'string'
  ) {
    return null;
  }
  const requestId = record.requestId.trim();
  const fingerprint = record.fingerprint.trim();
  return REQUEST_ID_PATTERN.test(requestId) && FINGERPRINT_PATTERN.test(fingerprint)
    ? Object.freeze({ requestId, fingerprint })
    : null;
}

export function parsePublicationCreateIdentityStorageValue(
  rawValue: string | null,
): PublicationCreateIdentityRecord | null {
  if (!rawValue || rawValue.length > MAX_CREATE_IDENTITY_STORAGE_LENGTH) {
    return null;
  }
  try {
    return parsePublicationCreateIdentityRecord(JSON.parse(rawValue));
  } catch {
    return null;
  }
}

export function readPublicationCreateIdentity(
  storageKey: string,
  storage?: PublicationCreateIdentityStorage | null,
): PublicationCreateIdentityRecord | null {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) {
    return null;
  }
  try {
    const rawValue = resolvedStorage.getItem(storageKey);
    const record = parsePublicationCreateIdentityStorageValue(rawValue);
    if (rawValue && !record) {
      resolvedStorage.removeItem(storageKey);
    }
    return record;
  } catch {
    return null;
  }
}

export function writePublicationCreateIdentity(
  storageKey: string,
  value: PublicationCreateIdentityRecord,
  storage?: PublicationCreateIdentityStorage | null,
): void {
  const resolvedStorage = resolveStorage(storage);
  const record = parsePublicationCreateIdentityRecord(value);
  if (!resolvedStorage || !record) {
    return;
  }
  try {
    resolvedStorage.setItem(storageKey, JSON.stringify(record));
  } catch {
    // The in-memory identity remains active when WebView storage is unavailable.
  }
}

export function clearPublicationCreateIdentity(
  storageKey: string,
  storage?: PublicationCreateIdentityStorage | null,
): void {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) {
    return;
  }
  try {
    resolvedStorage.removeItem(storageKey);
  } catch {
    // Storage failures must not turn a confirmed publication into a UI error.
  }
}
