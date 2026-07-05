import type {
  ManagedEntityFavoriteType,
  ManagedEntityFavoritesResponse,
  ManagedEntityType,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

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
): Promise<ManagedEntityFavoritesResponse> {
  const response = await api.request(
    `/managed-entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/favorites`,
    {
      method: 'PUT',
      body: JSON.stringify({ favoriteTypes }),
    },
  );
  return parseManagedEntityFavoritesResponse(response);
}
