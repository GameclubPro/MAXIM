import type { ManagedEntityFavoriteLabelsResponse } from '@maxim/contracts';
import { ApiRequestError } from './api-request-error';
import {
  getManagedEntityFavoriteLabels,
  updateManagedEntityFavoriteLabels,
} from './api/managed-entity-favorites-client';
import type { ApiTransport } from './api/transport';
import {
  HOME_ENTITY_FAVORITE_LABELS,
  HOME_ENTITY_FAVORITE_TYPES,
  hydrateHomeEntityFavoriteLabels,
  resolveHomeEntityFavoriteLabels,
  sanitizeHomeEntityFavoriteLabels,
  type HomeEntityFavoriteLabelOverrides,
} from './home-entity-favorites';
import { waitForNativeStorageRuntime } from './native-storage-runtime';

export function planHomeEntityFavoriteLabelsSync(
  cachedLabels: HomeEntityFavoriteLabelOverrides,
  server: ManagedEntityFavoriteLabelsResponse,
): {
  labels: HomeEntityFavoriteLabelOverrides;
  initializeServer: boolean;
} {
  if (server.initialized) {
    return {
      labels: sanitizeHomeEntityFavoriteLabels(server.labels),
      initializeServer: false,
    };
  }

  const labels = sanitizeHomeEntityFavoriteLabels(cachedLabels);
  return {
    labels,
    initializeServer: Object.keys(labels).length > 0,
  };
}

export async function migrateHomeEntityFavoriteLabelsAfterNativeStorage(
  server: ManagedEntityFavoriteLabelsResponse,
  hydrateLabels: () => Promise<HomeEntityFavoriteLabelOverrides>,
  initializeServer: (
    labels: HomeEntityFavoriteLabelOverrides,
  ) => Promise<ManagedEntityFavoriteLabelsResponse>,
  onCandidate: (labels: HomeEntityFavoriteLabelOverrides) => void,
): Promise<HomeEntityFavoriteLabelOverrides> {
  if (server.initialized) {
    return sanitizeHomeEntityFavoriteLabels(server.labels);
  }

  const labels = await hydrateLabels();
  const plan = planHomeEntityFavoriteLabelsSync(labels, server);
  onCandidate(plan.labels);
  if (!plan.initializeServer) {
    return plan.labels;
  }

  const initialized = await initializeServer(plan.labels);
  return sanitizeHomeEntityFavoriteLabels(initialized.labels);
}

export function mergeHomeEntityFavoriteLabelEdits(
  baseLabels: HomeEntityFavoriteLabelOverrides,
  draftLabels: HomeEntityFavoriteLabelOverrides,
  latestServerLabels: HomeEntityFavoriteLabelOverrides,
): HomeEntityFavoriteLabelOverrides {
  const base = resolveHomeEntityFavoriteLabels(sanitizeHomeEntityFavoriteLabels(baseLabels));
  const draft = resolveHomeEntityFavoriteLabels(sanitizeHomeEntityFavoriteLabels(draftLabels));
  const next = sanitizeHomeEntityFavoriteLabels(latestServerLabels);

  for (const favoriteType of HOME_ENTITY_FAVORITE_TYPES) {
    if (draft[favoriteType] === base[favoriteType]) {
      continue;
    }
    if (draft[favoriteType] === HOME_ENTITY_FAVORITE_LABELS[favoriteType]) {
      delete next[favoriteType];
    } else {
      next[favoriteType] = draft[favoriteType];
    }
  }

  return sanitizeHomeEntityFavoriteLabels(next);
}

export function isHomeEntityFavoriteLabelsRevisionConflict(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.status === 409 &&
    error.code === 'MANAGED_ENTITY_FAVORITE_LABELS_REVISION_CONFLICT'
  );
}

export async function saveHomeEntityFavoriteLabelEditsWithConflictRetry(
  baseLabels: HomeEntityFavoriteLabelOverrides,
  draftLabels: HomeEntityFavoriteLabelOverrides,
  loadLatest: () => Promise<ManagedEntityFavoriteLabelsResponse>,
  replace: (
    labels: HomeEntityFavoriteLabelOverrides,
    expectedRevision: number | null,
  ) => Promise<ManagedEntityFavoriteLabelsResponse>,
): Promise<ManagedEntityFavoriteLabelsResponse> {
  let latest = await loadLatest();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const labels = latest.initialized
      ? mergeHomeEntityFavoriteLabelEdits(baseLabels, draftLabels, latest.labels)
      : sanitizeHomeEntityFavoriteLabels(draftLabels);
    try {
      return await replace(labels, latest.revision);
    } catch (error: unknown) {
      if (attempt !== 0 || !isHomeEntityFavoriteLabelsRevisionConflict(error)) {
        throw error;
      }
      latest = await loadLatest();
    }
  }

  throw new Error('Не удалось согласовать актуальные названия категорий.');
}

export async function hydrateHomeEntityFavoriteLabelMigrationCandidate(
  scope: string | null | undefined,
  options: { signal?: AbortSignal; waitForNativeStorage?: boolean } = {},
): Promise<HomeEntityFavoriteLabelOverrides> {
  if (options.waitForNativeStorage) {
    await waitForNativeStorageRuntime({ signal: options.signal });
  }
  if (options.signal?.aborted) {
    return {};
  }

  return hydrateHomeEntityFavoriteLabels(scope);
}

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

export function initializeManagedEntityFavoriteLabels(
  api: ApiTransport,
  labels: HomeEntityFavoriteLabelOverrides,
  signal?: AbortSignal,
) {
  return updateManagedEntityFavoriteLabels(api, labels, { mode: 'initialize', signal });
}

export function saveManagedEntityFavoriteLabelEdits(
  api: ApiTransport,
  baseLabels: HomeEntityFavoriteLabelOverrides,
  draftLabels: HomeEntityFavoriteLabelOverrides,
  signal?: AbortSignal,
) {
  return saveHomeEntityFavoriteLabelEditsWithConflictRetry(
    baseLabels,
    draftLabels,
    () => getManagedEntityFavoriteLabels(api, { signal }),
    (labels, expectedRevision) =>
      updateManagedEntityFavoriteLabels(api, labels, { expectedRevision, signal }),
  );
}
