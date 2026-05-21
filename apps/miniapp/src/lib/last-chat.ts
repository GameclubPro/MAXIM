import {
  hydrateMirroredItem,
  readLocalMirrorItem,
  saveMirroredItem,
} from './native-storage';

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
  return readLocalMirrorItem(LAST_CHAT_ID_KEY) ?? readLastEntityId(readLastEntityType()) ?? '';
}

export function saveLastChatId(chatId: string): void {
  if (!chatId) {
    return;
  }

  saveMirroredItem(LAST_CHAT_ID_KEY, chatId);
}

function resolveEntityIdKey(entityType: LastEntityType): string {
  return entityType === 'channel' ? LAST_CHANNEL_ENTITY_ID_KEY : LAST_CHAT_ENTITY_ID_KEY;
}

export function readLastEntityType(): LastEntityType {
  const value = readLocalMirrorItem(LAST_ENTITY_TYPE_KEY);
  return value === 'channel' ? 'channel' : 'chat';
}

export function saveLastEntityType(entityType: LastEntityType): void {
  saveMirroredItem(LAST_ENTITY_TYPE_KEY, entityType);
}

export function readLastEntityId(entityType: LastEntityType): string {
  const storedId = readLocalMirrorItem(resolveEntityIdKey(entityType));
  if (storedId) {
    return storedId;
  }

  const legacyId = readLocalMirrorItem(LAST_CHAT_ID_KEY) ?? '';
  return legacyId && readLastEntityType() === entityType ? legacyId : '';
}

export function saveLastEntityId(entityType: LastEntityType, entityId: string): void {
  if (!entityId) {
    return;
  }

  saveMirroredItem(resolveEntityIdKey(entityType), entityId);
  saveMirroredItem(LAST_CHAT_ID_KEY, entityId);
  saveMirroredItem(LAST_ENTITY_TYPE_KEY, entityType);
}

export async function hydrateLastEntityState(): Promise<{
  entityType: LastEntityType;
  chatId: string;
  channelId: string;
}> {
  const [entityTypeValue, chatId, channelId, legacyChatId] = await Promise.all([
    hydrateMirroredItem(LAST_ENTITY_TYPE_KEY),
    hydrateMirroredItem(LAST_CHAT_ENTITY_ID_KEY),
    hydrateMirroredItem(LAST_CHANNEL_ENTITY_ID_KEY),
    hydrateMirroredItem(LAST_CHAT_ID_KEY),
  ]);
  const entityType = normalizeEntityType(entityTypeValue, 'chat');

  return {
    entityType,
    chatId: chatId || (entityType === 'chat' ? legacyChatId : '') || '',
    channelId: channelId || (entityType === 'channel' ? legacyChatId : '') || '',
  };
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
