const LAZY_PAGE_RELOAD_MARKER_PREFIX = 'maxim:lazy-page-reload:v1:';
const ASSET_URL_PATTERN = /(?:https?:\/\/[^\s"'()]+)?\/assets\/[^\s"'()]+\.js/iu;

export function buildLazyPageReloadMarkerKey(exportName: string, cause: unknown): string {
  const message =
    cause instanceof Error
      ? `${cause.name}: ${cause.message}`
      : typeof cause === 'string'
        ? cause
        : '';
  const assetUrl = message.match(ASSET_URL_PATTERN)?.[0];
  return `${LAZY_PAGE_RELOAD_MARKER_PREFIX}${assetUrl ?? exportName}`;
}

export function reloadAfterLazyPageLoadFailure(exportName: string, cause: unknown): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const markerKey = buildLazyPageReloadMarkerKey(exportName, cause);
  try {
    if (window.sessionStorage.getItem(markerKey) === '1') {
      return false;
    }
    window.sessionStorage.setItem(markerKey, '1');
  } catch {
    return false;
  }

  window.location.reload();
  return true;
}
