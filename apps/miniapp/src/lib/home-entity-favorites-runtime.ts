import { getMe } from './api/me-client';
import { getPreviewApiPrincipalUserId } from './api/preview-principal';
import type { ApiTransport } from './api/transport';
import { synchronizeManagedEntityFavoriteLabels } from './home-entity-favorite-label-sync';
import {
  sanitizeHomeEntityFavoriteLabels,
  saveHomeEntityFavoriteLabels,
  type HomeEntityFavoriteLabelOverrides,
} from './home-entity-favorites';

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
