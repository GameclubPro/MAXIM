export const LAST_CHAT_ID_KEY = 'maxim:last-chat-id';
export const LAST_ENTITY_TYPE_KEY = 'maxim:last-entity-type';
export const LAST_CHAT_ENTITY_ID_KEY = 'maxim:last-chat-entity-id';
export const LAST_CHANNEL_ENTITY_ID_KEY = 'maxim:last-channel-entity-id';
export const RECENT_CHAT_ENTITY_IDS_KEY = 'maxim:recent-chat-entity-ids';
export const RECENT_CHANNEL_ENTITY_IDS_KEY = 'maxim:recent-channel-entity-ids';

const MAX_RECENT_ENTITY_IDS = 8;

export type LastEntityType = 'chat' | 'channel';

export function readLastChatId(): string {
  try {
    return (
      window.localStorage.getItem(LAST_CHAT_ID_KEY) ??
      readLastEntityId(readLastEntityType()) ??
      ''
    );
  } catch {
    return '';
  }
}

export function saveLastChatId(chatId: string): void {
  if (!chatId) {
    return;
  }

  try {
    window.localStorage.setItem(LAST_CHAT_ID_KEY, chatId);
  } catch {
    // Ignore localStorage failures in restrictive WebView environments.
  }
}

function resolveEntityIdKey(entityType: LastEntityType): string {
  return entityType === 'channel' ? LAST_CHANNEL_ENTITY_ID_KEY : LAST_CHAT_ENTITY_ID_KEY;
}

function resolveRecentEntityIdsKey(entityType: LastEntityType): string {
  return entityType === 'channel' ? RECENT_CHANNEL_ENTITY_IDS_KEY : RECENT_CHAT_ENTITY_IDS_KEY;
}

export function readLastEntityType(): LastEntityType {
  try {
    const value = window.localStorage.getItem(LAST_ENTITY_TYPE_KEY);
    return value === 'channel' ? 'channel' : 'chat';
  } catch {
    return 'chat';
  }
}

export function saveLastEntityType(entityType: LastEntityType): void {
  try {
    window.localStorage.setItem(LAST_ENTITY_TYPE_KEY, entityType);
  } catch {
    // Ignore localStorage failures in restrictive WebView environments.
  }
}

export function readLastEntityId(entityType: LastEntityType): string {
  try {
    const storedId = window.localStorage.getItem(resolveEntityIdKey(entityType));
    if (storedId) {
      return storedId;
    }

    const legacyId = window.localStorage.getItem(LAST_CHAT_ID_KEY) ?? '';
    return legacyId && readLastEntityType() === entityType ? legacyId : '';
  } catch {
    return '';
  }
}

export function saveLastEntityId(entityType: LastEntityType, entityId: string): void {
  if (!entityId) {
    return;
  }

  try {
    window.localStorage.setItem(resolveEntityIdKey(entityType), entityId);
    window.localStorage.setItem(LAST_CHAT_ID_KEY, entityId);
    window.localStorage.setItem(LAST_ENTITY_TYPE_KEY, entityType);
  } catch {
    // Ignore localStorage failures in restrictive WebView environments.
  }
}

export function readRecentEntityIds(entityType: LastEntityType): string[] {
  try {
    const raw = window.localStorage.getItem(resolveRecentEntityIdsKey(entityType));
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const normalized = parsed
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);

    return [...new Set(normalized)].slice(0, MAX_RECENT_ENTITY_IDS);
  } catch {
    return [];
  }
}

export function saveRecentEntityVisit(entityType: LastEntityType, entityId: string): void {
  const normalizedEntityId = entityId.trim();
  if (!normalizedEntityId) {
    return;
  }

  try {
    const nextIds = [
      normalizedEntityId,
      ...readRecentEntityIds(entityType).filter((currentId) => currentId !== normalizedEntityId),
    ].slice(0, MAX_RECENT_ENTITY_IDS);

    window.localStorage.setItem(resolveRecentEntityIdsKey(entityType), JSON.stringify(nextIds));
  } catch {
    // Ignore localStorage failures in restrictive WebView environments.
  }
}

export function normalizeEntityType(
  value: string | null | undefined,
  fallback: LastEntityType = 'chat',
): LastEntityType {
  if (value === 'chat' || value === 'channel') {
    return value;
  }

  return fallback;
}

export function buildManagedEntitiesRoute(entityType: LastEntityType): string {
  return entityType === 'channel' ? '/?view=channel' : '/?view=chat';
}
