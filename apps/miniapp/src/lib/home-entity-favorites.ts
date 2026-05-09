import type { ChatSummary, ManagedEntityFavoriteType } from '@maxim/contracts';

export type HomeEntityFavoriteEntityType = 'chat' | 'channel';
export type HomeEntityFavoriteType = ManagedEntityFavoriteType;
export type HomeEntityFavoritesByType = Record<HomeEntityFavoriteType, string[]>;
export type HomeEntityFavorites = Record<HomeEntityFavoriteEntityType, HomeEntityFavoritesByType>;

const HOME_ENTITY_FAVORITES_VERSION = 2;
const HOME_ENTITY_FAVORITES_LEGACY_VERSION = 1;
const HOME_ENTITY_FAVORITES_FALLBACK_SCOPE = 'device';
export const HOME_ENTITY_FAVORITE_TYPES: HomeEntityFavoriteType[] = [
  'important',
  'watch',
  'broadcast',
  'test',
  'partner',
  'service',
];
export const HOME_ENTITY_FAVORITE_LABELS: Record<HomeEntityFavoriteType, string> = {
  important: 'Важные',
  watch: 'На контроле',
  broadcast: 'Рассылки',
  test: 'Тестовые',
  partner: 'Партнеры',
  service: 'Служебные',
};
export const HOME_ENTITY_FAVORITE_TITLES: Record<HomeEntityFavoriteType, string> = {
  important: 'Ключевые чаты и каналы',
  watch: 'Повышенное внимание модерации',
  broadcast: 'Аудитории для автопостинга',
  test: 'Песочницы и проверки',
  partner: 'Партнерские и клиентские пространства',
  service: 'Операционные и внутренние пространства',
};
const HOME_ENTITY_FAVORITES_ENTITY_TYPES: HomeEntityFavoriteEntityType[] = ['chat', 'channel'];

type HomeEntityListItem = {
  id: string;
  favoriteTypes?: readonly HomeEntityFavoriteType[];
};

type LegacyHomeEntityFavorites = Record<HomeEntityFavoriteEntityType, string[]>;

export function getHomeEntityFavoritesFallbackScope(): string {
  return HOME_ENTITY_FAVORITES_FALLBACK_SCOPE;
}

export function createEmptyHomeEntityFavoritesByType(): HomeEntityFavoritesByType {
  return {
    important: [],
    watch: [],
    broadcast: [],
    test: [],
    partner: [],
    service: [],
  };
}

export function createEmptyHomeEntityFavorites(): HomeEntityFavorites {
  return {
    chat: createEmptyHomeEntityFavoritesByType(),
    channel: createEmptyHomeEntityFavoritesByType(),
  };
}

function normalizeFavoriteId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function sanitizeFavoriteIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    const id = normalizeFavoriteId(item);
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    ids.push(id);
  }

  return ids;
}

function sanitizeFavoritesByType(value: unknown): HomeEntityFavoritesByType {
  const result = createEmptyHomeEntityFavoritesByType();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return result;
  }

  const record = value as Partial<Record<HomeEntityFavoriteType, unknown>>;
  const selectedIds = new Set<string>();
  for (const favoriteType of HOME_ENTITY_FAVORITE_TYPES) {
    result[favoriteType] = sanitizeFavoriteIds(record[favoriteType]).filter((id) => {
      if (selectedIds.has(id)) {
        return false;
      }

      selectedIds.add(id);
      return true;
    });
  }

  return result;
}

export function sanitizeHomeEntityFavorites(value: unknown): HomeEntityFavorites {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return createEmptyHomeEntityFavorites();
  }

  const record = value as Partial<Record<HomeEntityFavoriteEntityType, unknown>>;
  return {
    chat: sanitizeFavoritesByType(record.chat),
    channel: sanitizeFavoritesByType(record.channel),
  };
}

function sanitizeLegacyHomeEntityFavorites(value: unknown): LegacyHomeEntityFavorites {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      chat: [],
      channel: [],
    };
  }

  const record = value as Partial<Record<HomeEntityFavoriteEntityType, unknown>>;
  return {
    chat: sanitizeFavoriteIds(record.chat),
    channel: sanitizeFavoriteIds(record.channel),
  };
}

function normalizeFavoritesScope(scope: string | null | undefined): string {
  const normalized = typeof scope === 'string' ? scope.trim() : '';
  return normalized.length > 0 ? normalized : HOME_ENTITY_FAVORITES_FALLBACK_SCOPE;
}

function buildHomeEntityFavoritesStorageKey(scope: string | null | undefined): string {
  return `maxim:home-entity-favorites:v${HOME_ENTITY_FAVORITES_VERSION}:${normalizeFavoritesScope(
    scope,
  )}`;
}

function buildLegacyHomeEntityFavoritesStorageKey(scope: string | null | undefined): string {
  return `maxim:home-entity-favorites:v${HOME_ENTITY_FAVORITES_LEGACY_VERSION}:${normalizeFavoritesScope(
    scope,
  )}`;
}

export function buildHomeEntityFavoritesMigrationKey(scope: string | null | undefined): string {
  return `maxim:home-entity-favorites:migrated:v${HOME_ENTITY_FAVORITES_LEGACY_VERSION}->v${HOME_ENTITY_FAVORITES_VERSION}:${normalizeFavoritesScope(
    scope,
  )}`;
}

export function readHomeEntityFavorites(scope?: string | null): HomeEntityFavorites {
  if (typeof window === 'undefined') {
    return createEmptyHomeEntityFavorites();
  }

  try {
    const raw = window.localStorage.getItem(buildHomeEntityFavoritesStorageKey(scope));
    if (!raw) {
      return createEmptyHomeEntityFavorites();
    }

    return sanitizeHomeEntityFavorites(JSON.parse(raw));
  } catch {
    return createEmptyHomeEntityFavorites();
  }
}

export function readLegacyHomeEntityFavorites(scope?: string | null): LegacyHomeEntityFavorites {
  if (typeof window === 'undefined') {
    return {
      chat: [],
      channel: [],
    };
  }

  try {
    const raw = window.localStorage.getItem(buildLegacyHomeEntityFavoritesStorageKey(scope));
    if (!raw) {
      return {
        chat: [],
        channel: [],
      };
    }

    return sanitizeLegacyHomeEntityFavorites(JSON.parse(raw));
  } catch {
    return {
      chat: [],
      channel: [],
    };
  }
}

export function saveHomeEntityFavorites(
  scope: string | null | undefined,
  favorites: HomeEntityFavorites,
): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(
      buildHomeEntityFavoritesStorageKey(scope),
      JSON.stringify(sanitizeHomeEntityFavorites(favorites)),
    );
  } catch {
    // Ignore localStorage failures in restrictive WebView environments.
  }
}

export function mergeHomeEntityFavorites(
  primary: HomeEntityFavorites,
  secondary: HomeEntityFavorites,
): HomeEntityFavorites {
  const merged = createEmptyHomeEntityFavorites();

  for (const entityType of HOME_ENTITY_FAVORITES_ENTITY_TYPES) {
    for (const favoriteType of HOME_ENTITY_FAVORITE_TYPES) {
      const seen = new Set<string>();
      for (const id of [
        ...primary[entityType][favoriteType],
        ...secondary[entityType][favoriteType],
      ]) {
        if (seen.has(id)) {
          continue;
        }

        seen.add(id);
        merged[entityType][favoriteType].push(id);
      }
    }
  }

  return sanitizeHomeEntityFavorites(merged);
}

export function createHomeEntityFavoritesFromLegacy(
  legacy: LegacyHomeEntityFavorites,
): HomeEntityFavorites {
  const favorites = createEmptyHomeEntityFavorites();
  favorites.chat.important = sanitizeFavoriteIds(legacy.chat);
  favorites.channel.important = sanitizeFavoriteIds(legacy.channel);
  return favorites;
}

export function createHomeEntityFavoritesFromEntities(params: {
  chats?: readonly ChatSummary[];
  channels?: readonly ChatSummary[];
}): HomeEntityFavorites {
  const favorites = createEmptyHomeEntityFavorites();
  const addEntities = (
    entityType: HomeEntityFavoriteEntityType,
    entities: readonly ChatSummary[] | undefined,
  ) => {
    for (const entity of entities ?? []) {
      const id = normalizeFavoriteId(entity.id);
      if (!id) {
        continue;
      }

      for (const favoriteType of entity.favoriteTypes ?? []) {
        if (!HOME_ENTITY_FAVORITE_TYPES.includes(favoriteType)) {
          continue;
        }

        if (!favorites[entityType][favoriteType].includes(id)) {
          favorites[entityType][favoriteType].push(id);
        }
        break;
      }
    }
  };

  addEntities('chat', params.chats);
  addEntities('channel', params.channels);
  return favorites;
}

export function getHomeEntityFavoriteTypes(
  favorites: HomeEntityFavorites,
  entityType: HomeEntityFavoriteEntityType,
  entityId: string,
): HomeEntityFavoriteType[] {
  const normalizedId = normalizeFavoriteId(entityId);
  if (!normalizedId) {
    return [];
  }

  const result: HomeEntityFavoriteType[] = [];
  for (const favoriteType of HOME_ENTITY_FAVORITE_TYPES) {
    if (favorites[entityType][favoriteType].includes(normalizedId)) {
      result.push(favoriteType);
      break;
    }
  }

  return result;
}

export function getHomeEntityFavoriteIds(
  favorites: HomeEntityFavorites,
  entityType: HomeEntityFavoriteEntityType,
  favoriteTypes: readonly HomeEntityFavoriteType[] = HOME_ENTITY_FAVORITE_TYPES,
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const favoriteType of favoriteTypes) {
    for (const id of favorites[entityType][favoriteType] ?? []) {
      const normalizedId = normalizeFavoriteId(id);
      if (!normalizedId || seen.has(normalizedId)) {
        continue;
      }

      seen.add(normalizedId);
      ids.push(normalizedId);
    }
  }

  return ids;
}

export function isHomeEntityFavorite(
  favorites: HomeEntityFavorites,
  entityType: HomeEntityFavoriteEntityType,
  entityId: string,
  favoriteType?: HomeEntityFavoriteType,
): boolean {
  if (favoriteType) {
    const normalizedId = normalizeFavoriteId(entityId);
    return Boolean(normalizedId && favorites[entityType][favoriteType].includes(normalizedId));
  }

  return getHomeEntityFavoriteTypes(favorites, entityType, entityId).length > 0;
}

export function setHomeEntityFavoriteTypes(
  favorites: HomeEntityFavorites,
  entityType: HomeEntityFavoriteEntityType,
  entityId: string,
  favoriteTypes: readonly HomeEntityFavoriteType[],
): HomeEntityFavorites {
  const normalizedId = normalizeFavoriteId(entityId);
  const next = sanitizeHomeEntityFavorites(favorites);
  if (!normalizedId) {
    return next;
  }

  const selectedType = favoriteTypes.find((favoriteType) =>
    HOME_ENTITY_FAVORITE_TYPES.includes(favoriteType),
  );
  for (const favoriteType of HOME_ENTITY_FAVORITE_TYPES) {
    const currentIds = next[entityType][favoriteType].filter((id) => id !== normalizedId);
    next[entityType][favoriteType] =
      selectedType === favoriteType ? [normalizedId, ...currentIds] : currentIds;
  }

  return next;
}

export function toggleHomeEntityFavoriteType(
  favorites: HomeEntityFavorites,
  entityType: HomeEntityFavoriteEntityType,
  entityId: string,
  favoriteType: HomeEntityFavoriteType,
): { favorites: HomeEntityFavorites; favoriteTypes: HomeEntityFavoriteType[] } {
  const currentTypes = getHomeEntityFavoriteTypes(favorites, entityType, entityId);
  const nextTypes = currentTypes.includes(favoriteType) ? [] : [favoriteType];

  return {
    favorites: setHomeEntityFavoriteTypes(favorites, entityType, entityId, nextTypes),
    favoriteTypes: nextTypes,
  };
}

export function orderHomeEntitiesByFavorites<T extends HomeEntityListItem>(
  entities: readonly T[],
  favorites: HomeEntityFavoritesByType,
  favoriteTypes: readonly HomeEntityFavoriteType[] = HOME_ENTITY_FAVORITE_TYPES,
): T[] {
  const favoriteIds = getHomeEntityFavoriteIds(
    {
      chat: favorites,
      channel: createEmptyHomeEntityFavoritesByType(),
    },
    'chat',
    favoriteTypes,
  );

  if (entities.length === 0 || favoriteIds.length === 0) {
    return [...entities];
  }

  const entityById = new Map<string, T>();
  for (const entity of entities) {
    if (!entityById.has(entity.id)) {
      entityById.set(entity.id, entity);
    }
  }

  const seenFavoriteIds = new Set<string>();
  const favoriteEntities: T[] = [];
  for (const id of favoriteIds) {
    const normalizedId = normalizeFavoriteId(id);
    if (!normalizedId || seenFavoriteIds.has(normalizedId)) {
      continue;
    }

    const entity = entityById.get(normalizedId);
    if (!entity) {
      continue;
    }

    seenFavoriteIds.add(normalizedId);
    favoriteEntities.push(entity);
  }

  if (favoriteEntities.length === 0) {
    return [...entities];
  }

  return [...favoriteEntities, ...entities.filter((entity) => !seenFavoriteIds.has(entity.id))];
}
