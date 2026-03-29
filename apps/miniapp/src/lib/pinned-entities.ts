export type ManagedEntityKind = 'chat' | 'channel';

function buildStorageKey(entityType: ManagedEntityKind): string {
  return `maxim:pinned-entities:${entityType}`;
}

export function readPinnedEntityIds(entityType: ManagedEntityKind): string[] {
  try {
    const raw = window.localStorage.getItem(buildStorageKey(entityType));
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const normalized = parsed
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);

    return Array.from(new Set(normalized));
  } catch {
    return [];
  }
}

function savePinnedEntityIds(entityType: ManagedEntityKind, entityIds: readonly string[]): void {
  try {
    window.localStorage.setItem(buildStorageKey(entityType), JSON.stringify(entityIds));
  } catch {
    // Ignore localStorage failures in restrictive WebView environments.
  }
}

export function togglePinnedEntity(entityType: ManagedEntityKind, entityId: string): string[] {
  const normalizedId = entityId.trim();
  if (!normalizedId) {
    return readPinnedEntityIds(entityType);
  }

  const current = readPinnedEntityIds(entityType);
  const next = current.includes(normalizedId)
    ? current.filter((value) => value !== normalizedId)
    : [normalizedId, ...current];

  savePinnedEntityIds(entityType, next);
  return next;
}
