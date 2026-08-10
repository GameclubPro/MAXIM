import type {
  ManagedEntityFavoriteLabelOverrides,
  ManagedEntityFavoriteLabelsResponse,
  ManagedEntityFavoriteType,
  ManagedEntityFavoritesResponse,
  ManagedEntityType,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

const FAVORITE_TYPES: readonly ManagedEntityFavoriteType[] = [
  'important',
  'watch',
  'broadcast',
  'test',
  'partner',
  'service',
];
const FAVORITE_LABEL_MAX_LENGTH = 24;

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

function parseFavoriteLabelOverrides(value: unknown): ManagedEntityFavoriteLabelOverrides {
  if (!isRecord(value)) {
    throw new Error('Invalid managed entity favorite labels response');
  }

  const favoriteTypeSet = new Set<string>(FAVORITE_TYPES);
  if (Object.keys(value).some((key) => !favoriteTypeSet.has(key))) {
    throw new Error('Invalid managed entity favorite labels response');
  }

  const labels: ManagedEntityFavoriteLabelOverrides = {};
  for (const favoriteType of FAVORITE_TYPES) {
    const rawLabel = value[favoriteType];
    if (rawLabel === undefined) {
      continue;
    }
    if (typeof rawLabel !== 'string') {
      throw new Error('Invalid managed entity favorite labels response');
    }

    const label = rawLabel.replace(/\s+/gu, ' ').trim();
    if (
      !label ||
      label.includes('\u0000') ||
      Array.from(label).length > FAVORITE_LABEL_MAX_LENGTH
    ) {
      throw new Error('Invalid managed entity favorite labels response');
    }
    labels[favoriteType] = label;
  }
  return labels;
}

function parseManagedEntityFavoriteLabelsResponse(
  value: unknown,
): ManagedEntityFavoriteLabelsResponse {
  const allowedKeys = new Set(['initialized', 'labels', 'revision']);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    typeof value.initialized !== 'boolean' ||
    (value.revision !== null &&
      (typeof value.revision !== 'number' ||
        !Number.isInteger(value.revision) ||
        value.revision < 1))
  ) {
    throw new Error('Invalid managed entity favorite labels response');
  }

  const labels = parseFavoriteLabelOverrides(value.labels);
  if (
    (!value.initialized && (value.revision !== null || Object.keys(labels).length > 0)) ||
    (value.initialized && value.revision === null)
  ) {
    throw new Error('Invalid managed entity favorite labels response');
  }

  return {
    initialized: value.initialized,
    labels,
    revision: value.revision,
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

export async function getManagedEntityFavoriteLabels(
  api: ApiTransport,
  options: { signal?: AbortSignal } = {},
): Promise<ManagedEntityFavoriteLabelsResponse> {
  const response = await api.request('/managed-entities/favorite-labels', {
    signal: options.signal,
  });
  return parseManagedEntityFavoriteLabelsResponse(response);
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
  });
  return parseManagedEntityFavoriteLabelsResponse(response);
}
