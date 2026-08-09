import {
  createManagedEntityWorkspaceState,
  decideManagedEntityWorkspaceBack,
  mergeManagedEntityStatsPreference,
  mergeManagedEntityWorkspaceRouteState,
  readManagedEntityWorkspaceState,
  type ManagedEntityWorkspaceRouteState,
} from './managed-entity-workspace';

type ManagedEntityDirectEntryOptions = {
  hashRouterEnabled: boolean;
  publicRouterBasename: string;
};

type ManagedEntityRoute = {
  entityType: 'chat' | 'channel';
  entityId: string;
  screen: 'settings' | 'events' | 'stats';
  section: string | null;
  range: string | null;
};

export type ManagedEntityLaunchHomeStep =
  | { kind: 'open-detail' }
  | { kind: 'normalize-home'; route: string };

let historyLocationKeySequence = 0;

function createHistoryLocationKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  historyLocationKeySequence = (historyLocationKeySequence + 1) % Number.MAX_SAFE_INTEGER;
  return `managed-${Date.now().toString(36)}-${historyLocationKeySequence.toString(36)}`;
}

function parseRoute(route: string): URL | null {
  try {
    return new URL(route, 'https://miniapp.local');
  } catch {
    return null;
  }
}

function parseManagedEntityRoute(route: URL): ManagedEntityRoute | null {
  const match = route.pathname.match(/^\/(chat|channel)\/([^/]+)\/(settings|events|stats)\/?$/iu);
  if (!match) {
    return null;
  }

  const entityType = match[1]?.toLowerCase() === 'channel' ? 'channel' : 'chat';
  const screen = match[3]?.toLowerCase() as ManagedEntityRoute['screen'] | undefined;
  if (
    !screen ||
    (entityType === 'chat' && screen === 'stats') ||
    (entityType === 'channel' && screen === 'events')
  ) {
    return null;
  }

  try {
    return {
      entityType,
      entityId: decodeURIComponent(match[2] ?? ''),
      screen,
      section: route.searchParams.get('section'),
      range: route.searchParams.get('range'),
    };
  } catch {
    return null;
  }
}

function buildWindowPathForRoute(pathname: string, publicRouterBasename: string): string {
  if (!publicRouterBasename) {
    return pathname;
  }

  return pathname === '/' ? `${publicRouterBasename}/` : `${publicRouterBasename}${pathname}`;
}

export function buildManagedEntityHomeRoute(
  entityType: 'chat' | 'channel',
  currentSearch: string,
): string {
  const searchParams = new URLSearchParams(currentSearch);
  searchParams.delete('section');
  searchParams.delete('range');
  searchParams.set('view', entityType);
  const search = searchParams.toString();
  return search ? `/?${search}` : '/';
}

export function prepareManagedEntityDirectEntry(options: ManagedEntityDirectEntryOptions): void {
  if (typeof window === 'undefined') {
    return;
  }

  const parsedRoute = options.hashRouterEnabled
    ? parseRoute(window.location.hash.replace(/^#/u, '') || '/')
    : new URL(window.location.href);
  if (!parsedRoute) {
    return;
  }

  const routerPathname = options.hashRouterEnabled
    ? parsedRoute.pathname
    : options.publicRouterBasename && parsedRoute.pathname.startsWith(options.publicRouterBasename)
      ? parsedRoute.pathname.slice(options.publicRouterBasename.length) || '/'
      : parsedRoute.pathname;
  const managedRoute = parseManagedEntityRoute(
    new URL(`${routerPathname}${parsedRoute.search}`, parsedRoute),
  );
  if (!managedRoute) {
    return;
  }

  const canonicalRouterPathname = `/${managedRoute.entityType}/${encodeURIComponent(managedRoute.entityId)}/${managedRoute.screen}`;
  const currentUrl = options.hashRouterEnabled
    ? `${window.location.pathname}${window.location.search}#${canonicalRouterPathname}${parsedRoute.search}`
    : `${buildWindowPathForRoute(canonicalRouterPathname, options.publicRouterBasename)}${parsedRoute.search}${window.location.hash}`;
  const rawHistoryState = window.history.state;
  const historyState =
    typeof rawHistoryState === 'object' && rawHistoryState !== null ? rawHistoryState : {};
  const legacyRouteState = 'usr' in historyState ? historyState.usr : historyState;
  const existingWorkspace = readManagedEntityWorkspaceState(legacyRouteState);
  const historyIndex =
    typeof historyState.idx === 'number' &&
    Number.isSafeInteger(historyState.idx) &&
    historyState.idx >= 0
      ? historyState.idx
      : 0;
  const currentLocationKey =
    typeof historyState.key === 'string' && historyState.key ? historyState.key : null;
  const matchingWorkspace =
    existingWorkspace?.entityType === managedRoute.entityType &&
    existingWorkspace.entityId === managedRoute.entityId
      ? existingWorkspace
      : null;

  if (
    matchingWorkspace &&
    decideManagedEntityWorkspaceBack({
      origin: matchingWorkspace.origin,
      currentLocationKey,
      currentHistoryIndex: historyIndex,
    }) === 'history-back'
  ) {
    window.history.replaceState(historyState, '', currentUrl);
    return;
  }

  const matchingOrigin = matchingWorkspace?.origin;
  const existingHomeWorkspace =
    matchingWorkspace &&
    matchingOrigin &&
    matchingOrigin.locationKey === currentLocationKey &&
    matchingOrigin.historyIndex === historyIndex
      ? matchingWorkspace
      : null;
  const homeLocationKey = existingHomeWorkspace?.origin?.locationKey ?? createHistoryLocationKey();
  const detailLocationKey =
    existingHomeWorkspace || !currentLocationKey ? createHistoryLocationKey() : currentLocationKey;
  const workspaceState = createManagedEntityWorkspaceState({
    entityType: managedRoute.entityType,
    entityId: managedRoute.entityId,
    origin: existingHomeWorkspace?.origin ?? { locationKey: homeLocationKey, historyIndex },
    homeSnapshot: existingHomeWorkspace?.homeSnapshot,
    statsPreference: mergeManagedEntityStatsPreference(
      managedRoute.entityType,
      existingHomeWorkspace?.statsPreference,
      {
        section: managedRoute.section,
        range: managedRoute.range,
      },
    ),
  });
  const baseRouteState = existingHomeWorkspace
    ? legacyRouteState
    : existingWorkspace
      ? null
      : legacyRouteState;
  const detailRouteState = mergeManagedEntityWorkspaceRouteState(baseRouteState, workspaceState);
  const homeRouteState = mergeManagedEntityWorkspaceRouteState(
    existingHomeWorkspace ? legacyRouteState : null,
    workspaceState,
  );
  const homeRoute = buildManagedEntityHomeRoute(managedRoute.entityType, parsedRoute.search);
  const homeUrl = options.hashRouterEnabled
    ? `${window.location.pathname}${window.location.search}#${homeRoute}`
    : `${buildWindowPathForRoute('/', options.publicRouterBasename)}${homeRoute.slice(1)}${window.location.hash}`;

  window.history.replaceState(
    {
      ...historyState,
      usr: homeRouteState,
      key: homeLocationKey,
      idx: historyIndex,
    },
    '',
    homeUrl,
  );
  window.history.pushState(
    {
      ...historyState,
      usr: detailRouteState,
      key: detailLocationKey,
      idx: historyIndex + 1,
    },
    '',
    currentUrl,
  );
}

export function canReturnToManagedEntityHome(options: {
  currentRouteState: unknown;
  currentLocationKey: string;
  currentHistoryIndex: number;
}): boolean {
  const workspace = readManagedEntityWorkspaceState(options.currentRouteState);
  return (
    decideManagedEntityWorkspaceBack({
      origin: workspace?.origin,
      currentLocationKey: options.currentLocationKey,
      currentHistoryIndex: options.currentHistoryIndex,
    }) === 'history-back'
  );
}

export function resolveManagedEntityLaunchHomeStep(options: {
  targetEntityType: 'chat' | 'channel';
  currentSearch: string;
}): ManagedEntityLaunchHomeStep {
  const searchParams = new URLSearchParams(options.currentSearch);
  const currentViews = searchParams.getAll('view');
  if (currentViews.length === 1 && currentViews[0] === options.targetEntityType) {
    return { kind: 'open-detail' };
  }

  searchParams.set('view', options.targetEntityType);
  const search = searchParams.toString();
  return {
    kind: 'normalize-home',
    route: search ? `/?${search}` : '/',
  };
}

export function buildManagedEntityLaunchRouteState(options: {
  targetRoute: string;
  currentRouteState: unknown;
  currentLocationKey: string;
  currentHistoryIndex: number;
}): ManagedEntityWorkspaceRouteState | null {
  const parsedRoute = parseRoute(options.targetRoute);
  const managedRoute = parsedRoute ? parseManagedEntityRoute(parsedRoute) : null;
  if (!managedRoute) {
    return null;
  }

  return mergeManagedEntityWorkspaceRouteState(
    options.currentRouteState,
    createManagedEntityWorkspaceState({
      entityType: managedRoute.entityType,
      entityId: managedRoute.entityId,
      origin: {
        locationKey: options.currentLocationKey,
        historyIndex: options.currentHistoryIndex,
      },
      statsPreference: {
        section: managedRoute.section,
        range: managedRoute.range,
      },
    }),
  );
}
