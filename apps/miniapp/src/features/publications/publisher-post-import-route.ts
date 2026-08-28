const IMPORT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/u;
const DRAFT_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;

export const STALE_IMPORT_ROUTE_KEYS = ['compose', 'draft', 'import'] as const;

export function isPublisherPostImportRouteToken(value: string | null): value is string {
  return value !== null && IMPORT_TOKEN_PATTERN.test(value);
}

export function isPublisherDraftRouteId(value: string | null | undefined): value is string {
  return typeof value === 'string' && DRAFT_ID_PATTERN.test(value);
}

export function resolvePublisherPostImportRouteCleanup({
  draftId,
  exactQueryResolved,
  hasExactSession,
  importToken,
}: {
  draftId: string | null;
  exactQueryResolved: boolean;
  hasExactSession: boolean;
  importToken: string | null;
}): readonly string[] {
  if (
    (importToken !== null && !isPublisherPostImportRouteToken(importToken)) ||
    (draftId !== null && !isPublisherDraftRouteId(draftId))
  ) {
    return ['draft', 'import'];
  }
  if (importToken && exactQueryResolved && !hasExactSession && !draftId) {
    return ['import'];
  }
  return [];
}
