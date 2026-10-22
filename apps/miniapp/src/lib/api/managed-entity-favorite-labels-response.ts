import type {
  ManagedEntityFavoriteLabelOverrides,
  ManagedEntityFavoriteLabelsResponse,
  ManagedEntityFavoriteType,
} from '@maxim/contracts';

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

export function parseManagedEntityFavoriteLabelsResponse(
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
