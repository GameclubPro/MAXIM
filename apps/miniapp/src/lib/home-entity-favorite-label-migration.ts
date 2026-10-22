import type { ManagedEntityFavoriteLabelsResponse } from '@maxim/contracts';
import {
  buildHomeEntityFavoriteLabelsStorageKey,
  sanitizeHomeEntityFavoriteLabels,
  type HomeEntityFavoriteLabelOverrides,
} from './home-entity-favorites';
import { hydrateMirroredItem } from './native-storage';
import { waitForNativeStorageRuntime } from './native-storage-runtime';

async function hydrateHomeEntityFavoriteLabels(
  scope: string | null | undefined,
): Promise<HomeEntityFavoriteLabelOverrides> {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = await hydrateMirroredItem(buildHomeEntityFavoriteLabelsStorageKey(scope));
    return raw ? sanitizeHomeEntityFavoriteLabels(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

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
