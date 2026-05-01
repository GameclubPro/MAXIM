export type HomeEntityFavoriteType = 'chat' | 'channel';

export type HomeEntityFavorites = Record<HomeEntityFavoriteType, string[]>;

const HOME_ENTITY_FAVORITES_VERSION = 1;
const HOME_ENTITY_FAVORITES_FALLBACK_SCOPE = 'device';
const HOME_ENTITY_FAVORITES_TYPES: HomeEntityFavoriteType[] = ['chat', 'channel'];

type HomeEntityListItem = {
  id: string;
};

export function getHomeEntityFavoritesFallbackScope(): string {
  return HOME_ENTITY_FAVORITES_FALLBACK_SCOPE;
}

export function createEmptyHomeEntityFavorites(): HomeEntityFavorites {
  return {
    chat: [],
    channel: [],
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

export function sanitizeHomeEntityFavorites(value: unknown): HomeEntityFavorites {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return createEmptyHomeEntityFavorites();
  }

  const record = value as Partial<Record<HomeEntityFavoriteType, unknown>>;
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

  for (const entityType of HOME_ENTITY_FAVORITES_TYPES) {
    const seen = new Set<string>();
    for (const id of [...primary[entityType], ...secondary[entityType]]) {
      if (seen.has(id)) {
        continue;
      }

      seen.add(id);
      merged[entityType].push(id);
    }
  }

  return merged;
}

export function isHomeEntityFavorite(
  favorites: HomeEntityFavorites,
  entityType: HomeEntityFavoriteType,
  entityId: string,
): boolean {
  const normalizedId = normalizeFavoriteId(entityId);
  return Boolean(normalizedId && favorites[entityType].includes(normalizedId));
}

export function toggleHomeEntityFavorite(
  favorites: HomeEntityFavorites,
  entityType: HomeEntityFavoriteType,
  entityId: string,
): { favorites: HomeEntityFavorites; favorite: boolean } {
  const normalizedId = normalizeFavoriteId(entityId);
  if (!normalizedId) {
    return { favorites: sanitizeHomeEntityFavorites(favorites), favorite: false };
  }

  const next = sanitizeHomeEntityFavorites(favorites);
  const currentIds = next[entityType];
  const existingIndex = currentIds.indexOf(normalizedId);
  if (existingIndex >= 0) {
    next[entityType] = currentIds.filter((id) => id !== normalizedId);
    return { favorites: next, favorite: false };
  }

  next[entityType] = [normalizedId, ...currentIds];
  return { favorites: next, favorite: true };
}

export function orderHomeEntitiesByFavorites<T extends HomeEntityListItem>(
  entities: readonly T[],
  favoriteIds: readonly string[],
): T[] {
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
