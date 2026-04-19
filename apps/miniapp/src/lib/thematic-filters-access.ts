const THEMATIC_FILTERS_ALLOWED_USER_IDS = new Set(['98315271', '16316155']);

export function canUserAccessThematicFilters(userId: string | null | undefined): boolean {
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : '';
  if (!normalizedUserId) {
    return false;
  }

  return THEMATIC_FILTERS_ALLOWED_USER_IDS.has(normalizedUserId);
}
