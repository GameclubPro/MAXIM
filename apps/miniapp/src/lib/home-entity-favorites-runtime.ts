import { getMe } from './api/me-client';
import { updateManagedEntityFavorites } from './api/managed-entity-favorites-client';
import { getPreviewApiPrincipalUserId } from './api/preview-principal';
import type { ApiTransport } from './api/transport';
import { synchronizeManagedEntityFavoriteLabels } from './home-entity-favorite-label-sync';
import {
  createEmptyHomeEntityFavorites,
  getHomeEntityFavoriteTypes,
  getHomeEntityFavoritesFallbackScope,
  mergeHomeEntityFavorites,
  sanitizeHomeEntityFavoriteLabels,
  sanitizeHomeEntityFavorites,
  saveHomeEntityFavoriteLabels,
  saveHomeEntityFavorites,
  type HomeEntityFavoriteLabelOverrides,
  type HomeEntityFavorites,
} from './home-entity-favorites';
import { readLocalMirrorItem, writeLocalMirrorItem } from './native-storage';

type LegacyHomeEntityFavorites = {
  chat?: unknown;
  channel?: unknown;
};

function normalizeScope(scope: string): string {
  return scope.trim() || getHomeEntityFavoritesFallbackScope();
}

function readLegacyHomeEntityFavorites(scope: string): HomeEntityFavorites {
  if (typeof window === 'undefined') {
    return createEmptyHomeEntityFavorites();
  }

  try {
    const raw = readLocalMirrorItem(`maxim:home-entity-favorites:v1:${normalizeScope(scope)}`);
    const legacy = (raw ? JSON.parse(raw) : {}) as LegacyHomeEntityFavorites;
    return sanitizeHomeEntityFavorites({
      chat: { important: legacy.chat },
      channel: { important: legacy.channel },
    });
  } catch {
    return createEmptyHomeEntityFavorites();
  }
}

export async function synchronizeAuthenticatedHomeEntityFavoriteLabels(
  api: ApiTransport,
  initDataUserId: string | null,
  signal: AbortSignal,
  onUserId: (userId: string) => void,
  onLabels: (labels: HomeEntityFavoriteLabelOverrides) => void,
): Promise<boolean | undefined> {
  try {
    const me = await getMe(api, { signal });
    if (signal.aborted) {
      return false;
    }

    const userId = me.userId.trim();
    if (!userId) {
      return false;
    }

    onUserId(userId);
    if (
      initDataUserId !== null &&
      initDataUserId !== userId &&
      getPreviewApiPrincipalUserId(api) !== userId
    ) {
      return false;
    }

    const scope = `u:${userId}`;
    await synchronizeManagedEntityFavoriteLabels(api, scope, signal, (labels, options) => {
      const nextLabels = sanitizeHomeEntityFavoriteLabels(labels);
      onLabels(nextLabels);
      if (options.persistCache) {
        saveHomeEntityFavoriteLabels(scope, nextLabels);
      }
    });
    return !signal.aborted;
  } catch {
    return signal.aborted ? false : undefined;
  }
}

export function migrateLegacyHomeEntityFavorites(
  api: ApiTransport,
  scope: string,
  currentFavorites: HomeEntityFavorites,
  signal: AbortSignal,
  onFavorites: (favorites: HomeEntityFavorites) => void,
): void {
  if (
    signal.aborted ||
    typeof window === 'undefined' ||
    scope === getHomeEntityFavoritesFallbackScope()
  ) {
    return;
  }

  const normalizedScope = normalizeScope(scope);
  const migrationKey = `maxim:home-entity-favorites:migrated:v1->v2:${normalizedScope}`;
  if (readLocalMirrorItem(migrationKey) === '1') {
    return;
  }

  const legacyFavorites = readLegacyHomeEntityFavorites(normalizedScope);
  const legacyItems = [
    ...legacyFavorites.chat.important.map((id) => ({ entityType: 'chat' as const, id })),
    ...legacyFavorites.channel.important.map((id) => ({ entityType: 'channel' as const, id })),
  ];
  if (legacyItems.length === 0) {
    writeLocalMirrorItem(migrationKey, '1');
    return;
  }

  const nextFavorites = mergeHomeEntityFavorites(currentFavorites, legacyFavorites);
  onFavorites(nextFavorites);
  saveHomeEntityFavorites(normalizedScope, nextFavorites);
  writeLocalMirrorItem(migrationKey, '1');

  void Promise.allSettled(
    legacyItems.map((item) =>
      updateManagedEntityFavorites(
        api,
        item.entityType,
        item.id,
        getHomeEntityFavoriteTypes(nextFavorites, item.entityType, item.id),
      ),
    ),
  );
}
