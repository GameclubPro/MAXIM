import type {
  ManagedEntityFavoriteLabelOverrides,
  ManagedEntityFavoriteLabelsResponse,
  ManagedEntityFavoriteType,
  ManagedEntityFavoritesResponse,
  ManagedEntityType,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';
import { parseManagedEntityFavoriteLabelsResponse } from './managed-entity-favorite-labels-response';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFavoriteTypes(value: unknown): ManagedEntityFavoriteType[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<ManagedEntityFavoriteType>();
  const favoriteTypes: ManagedEntityFavoriteType[] = [];
  for (const item of value) {
    if (
      item !== 'important' &&
      item !== 'watch' &&
      item !== 'broadcast' &&
      item !== 'test' &&
      item !== 'partner' &&
      item !== 'service'
    ) {
      continue;
    }

    if (seen.has(item)) {
      continue;
    }

    seen.add(item);
    favoriteTypes.push(item);
  }

  return favoriteTypes;
}

function parseManagedEntityFavoritesResponse(value: unknown): ManagedEntityFavoritesResponse {
  if (
    !isRecord(value) ||
    (value.entityType !== 'chat' && value.entityType !== 'channel') ||
    typeof value.entityId !== 'string'
  ) {
    throw new Error('Invalid managed entity favorites response');
  }

  return {
    entityType: value.entityType,
    entityId: value.entityId,
    favoriteTypes: parseFavoriteTypes(value.favoriteTypes),
  };
}

export async function updateManagedEntityFavorites(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  favoriteTypes: ManagedEntityFavoriteType[],
  expectedFavoriteType: ManagedEntityFavoriteType | null,
  options: { signal?: AbortSignal } = {},
): Promise<ManagedEntityFavoritesResponse> {
  const response = await api.request(
    `/managed-entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/favorites`,
    {
      method: 'PUT',
      body: JSON.stringify({ favoriteTypes, expectedFavoriteType }),
      signal: options.signal,
      retryMutationOnTransportError: false,
    },
  );
  return parseManagedEntityFavoritesResponse(response);
}

export async function updateManagedEntityFavoriteLabels(
  api: ApiTransport,
  labels: ManagedEntityFavoriteLabelOverrides,
  options:
    | { mode: 'initialize'; signal?: AbortSignal }
    | { mode?: 'replace'; expectedRevision: number | null; signal?: AbortSignal },
): Promise<ManagedEntityFavoriteLabelsResponse> {
  const payload =
    options.mode === 'initialize'
      ? { labels, mode: 'initialize' as const }
      : {
          labels,
          mode: 'replace' as const,
          expectedRevision: options.expectedRevision,
        };
  const response = await api.request('/managed-entities/favorite-labels', {
    method: 'PUT',
    body: JSON.stringify(payload),
    signal: options.signal,
    retryMutationOnTransportError: false,
  });
  return parseManagedEntityFavoriteLabelsResponse(response);
}
