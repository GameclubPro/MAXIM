export const LAST_CHAT_ID_KEY = 'maxim:last-chat-id';
export const LAST_ENTITY_TYPE_KEY = 'maxim:last-entity-type';
export const LAST_CHAT_ENTITY_ID_KEY = 'maxim:last-chat-entity-id';
export const LAST_CHANNEL_ENTITY_ID_KEY = 'maxim:last-channel-entity-id';

export type LastEntityType = 'chat' | 'channel';
type ManagedEntityListItem = {
  id: string;
  title: string;
  link?: string | null;
};

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

export function buildHomeView<T extends ManagedEntityListItem>(options: {
  entities: readonly T[] | null | undefined;
  query: string;
}) {
  const normalizedQuery = options.query.trim().toLowerCase();
  const matchingEntities = !Array.isArray(options.entities)
    ? []
    : !normalizedQuery
      ? options.entities
      : options.entities.filter((entity) =>
          `${entity.title} ${entity.id} ${entity.link?.trim() ?? ''}`
            .toLowerCase()
            .includes(normalizedQuery),
        );

  return [matchingEntities, matchingEntities.length] as const;
}
