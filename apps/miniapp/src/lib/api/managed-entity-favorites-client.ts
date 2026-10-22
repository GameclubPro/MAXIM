import type { ManagedEntityFavoriteLabelsResponse } from '@maxim/contracts';
import type { ApiTransport } from './transport';
import { parseManagedEntityFavoriteLabelsResponse } from './managed-entity-favorite-labels-response';

export async function getManagedEntityFavoriteLabels(
  api: ApiTransport,
  options: { signal?: AbortSignal } = {},
): Promise<ManagedEntityFavoriteLabelsResponse> {
  const response = await api.request('/managed-entities/favorite-labels', {
    signal: options.signal,
  });
  return parseManagedEntityFavoriteLabelsResponse(response);
}

export async function updateManagedEntityFavorites(
  ...args: Parameters<
    typeof import('./managed-entity-favorites-write-client').updateManagedEntityFavorites
  >
) {
  const client = await import('./managed-entity-favorites-write-client');
  return client.updateManagedEntityFavorites(...args);
}

export async function updateManagedEntityFavoriteLabels(
  ...args: Parameters<
    typeof import('./managed-entity-favorites-write-client').updateManagedEntityFavoriteLabels
  >
) {
  const client = await import('./managed-entity-favorites-write-client');
  return client.updateManagedEntityFavoriteLabels(...args);
}
