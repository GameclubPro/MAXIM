import { getManagedEntityFavoriteLabels } from './api/managed-entity-favorites-client';
import type { ApiTransport } from './api/transport';
import { type HomeEntityFavoriteLabelOverrides } from './home-entity-favorites';
import {
  hydrateHomeEntityFavoriteLabelMigrationCandidate,
  migrateHomeEntityFavoriteLabelsAfterNativeStorage,
} from './home-entity-favorite-label-migration';
import { initializeManagedEntityFavoriteLabels } from './home-entity-favorite-label-writes';

export {
  planHomeEntityFavoriteLabelsSync,
  migrateHomeEntityFavoriteLabelsAfterNativeStorage,
  hydrateHomeEntityFavoriteLabelMigrationCandidate,
} from './home-entity-favorite-label-migration';
export {
  mergeHomeEntityFavoriteLabelEdits,
  isHomeEntityFavoriteLabelsRevisionConflict,
  saveHomeEntityFavoriteLabelEditsWithConflictRetry,
  initializeManagedEntityFavoriteLabels,
  saveManagedEntityFavoriteLabelEdits,
} from './home-entity-favorite-label-writes';

export async function synchronizeManagedEntityFavoriteLabels(
  api: ApiTransport,
  scope: string,
  signal: AbortSignal,
  onLabels: (labels: HomeEntityFavoriteLabelOverrides, options: { persistCache: boolean }) => void,
): Promise<void> {
  const [cachedResult, serverResult] = await Promise.allSettled([
    hydrateHomeEntityFavoriteLabelMigrationCandidate(scope),
    loadManagedEntityFavoriteLabels(api, signal),
  ]);
  if (signal.aborted) {
    return;
  }

  const cachedLabels = cachedResult.status === 'fulfilled' ? cachedResult.value : {};
  const applyLabels = (labels: HomeEntityFavoriteLabelOverrides, persistCache: boolean) => {
    if (!signal.aborted) {
      onLabels(labels, { persistCache });
    }
  };

  if (serverResult.status === 'rejected') {
    applyLabels(cachedLabels, false);
    try {
      const lateLabels = await hydrateHomeEntityFavoriteLabelMigrationCandidate(scope, {
        signal,
        waitForNativeStorage: true,
      });
      applyLabels(lateLabels, false);
    } catch {
      // Keep the already displayed scoped cache when native storage is unavailable.
    }
    return;
  }

  if (serverResult.value.initialized) {
    applyLabels(serverResult.value.labels, true);
    return;
  }

  applyLabels(cachedLabels, false);
  try {
    let serverProfileConfirmed = false;
    const labels = await migrateHomeEntityFavoriteLabelsAfterNativeStorage(
      serverResult.value,
      () =>
        hydrateHomeEntityFavoriteLabelMigrationCandidate(scope, {
          signal,
          waitForNativeStorage: true,
        }),
      async (candidateLabels) => {
        const initialized = await initializeManagedEntityFavoriteLabels(
          api,
          candidateLabels,
          signal,
        );
        serverProfileConfirmed = initialized.initialized;
        return initialized;
      },
      (candidateLabels) => applyLabels(candidateLabels, false),
    );
    applyLabels(labels, serverProfileConfirmed || Object.keys(labels).length > 0);
  } catch {
    // The scoped cache remains usable when migration or initialization fails.
  }
}

export function loadManagedEntityFavoriteLabels(api: ApiTransport, signal?: AbortSignal) {
  return getManagedEntityFavoriteLabels(api, { signal });
}
