export const MANAGED_ENTITY_WORKSPACE_STATE_VERSION = 1 as const;
export const MANAGED_ENTITY_WORKSPACE_STATE_KEY = 'managedEntityWorkspace' as const;
const MANAGED_ENTITY_HOME_SNAPSHOT_STORAGE_VERSION = 1;
const MANAGED_ENTITY_HOME_SNAPSHOT_STORAGE_PREFIX = 'maxim:managed-home-snapshot';
const MANAGED_ENTITY_STATS_PREFERENCE_STORAGE_VERSION = 1;
const MANAGED_ENTITY_STATS_PREFERENCE_STORAGE_PREFIX = 'maxim:managed-stats-preference';

export type ManagedEntityType = 'chat' | 'channel';
export type ManagedEntityHomeFilter =
  | 'all'
  | 'important'
  | 'watch'
  | 'broadcast'
  | 'test'
  | 'partner'
  | 'service';
export type ManagedEntityHomeScrollMode = 'document' | 'virtual';
export type ManagedEntityHomeFocusTarget = 'entity-title' | 'settings' | 'statistics';
export type ManagedEntityStatsRange = '24h' | '7d' | '30d';
export type ManagedEntityChatStatsSection = 'activity' | 'moderation' | 'participants';
export type ManagedEntityChannelStatsSection = 'overview' | 'events';
export type ManagedEntityStatsSection =
  | ManagedEntityChatStatsSection
  | ManagedEntityChannelStatsSection;

export type ManagedEntityHomeAnchor = {
  id: string | null;
  index: number;
  offset: number;
};

export type ManagedEntityHomeSnapshot = {
  query: string;
  filter: ManagedEntityHomeFilter;
  anchor: ManagedEntityHomeAnchor;
  focusTarget: ManagedEntityHomeFocusTarget;
  scrollMode: ManagedEntityHomeScrollMode;
};

export type ManagedEntityWorkspaceOrigin = {
  locationKey: string;
  historyIndex: number;
};

export type ManagedEntityStatsPreference = {
  section?: ManagedEntityStatsSection;
  range?: ManagedEntityStatsRange;
};

export type ManagedEntityWorkspaceState = {
  version: typeof MANAGED_ENTITY_WORKSPACE_STATE_VERSION;
  entityType: ManagedEntityType;
  entityId: string;
  origin: ManagedEntityWorkspaceOrigin | null;
  homeSnapshot: ManagedEntityHomeSnapshot | null;
  statsPreference: ManagedEntityStatsPreference;
};

export type ManagedEntityWorkspaceRouteState = Record<string, unknown> & {
  managedEntityWorkspace: ManagedEntityWorkspaceState;
};

export type ManagedEntityWorkspaceBackDecision = 'history-back' | 'home';

export type ManagedEntityHomeAnchorResolution =
  | {
      kind: 'entity';
      id: string;
      index: number;
      offset: number;
      focusTarget: ManagedEntityHomeFocusTarget;
      scrollMode: ManagedEntityHomeScrollMode;
    }
  | {
      kind: 'search-heading';
      offset: 0;
      focusTarget: 'search-heading';
      scrollMode: ManagedEntityHomeScrollMode;
    };

type WorkspaceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const HOME_FILTERS = new Set<ManagedEntityHomeFilter>([
  'all',
  'important',
  'watch',
  'broadcast',
  'test',
  'partner',
  'service',
]);
const HOME_SCROLL_MODES = new Set<ManagedEntityHomeScrollMode>(['document', 'virtual']);
const HOME_FOCUS_TARGETS = new Set<ManagedEntityHomeFocusTarget>([
  'entity-title',
  'settings',
  'statistics',
]);
const STATS_RANGES = new Set<ManagedEntityStatsRange>(['24h', '7d', '30d']);
const CHAT_STATS_SECTIONS = new Set<ManagedEntityChatStatsSection>([
  'activity',
  'moderation',
  'participants',
]);
const CHANNEL_STATS_SECTIONS = new Set<ManagedEntityChannelStatsSection>(['overview', 'events']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function normalizeHistoryIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeAnchorIndex(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function normalizeAnchorOffset(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isManagedEntityType(value: unknown): value is ManagedEntityType {
  return value === 'chat' || value === 'channel';
}

function normalizeEntityId(value: unknown): string {
  const entityId = normalizeNonEmptyString(value);
  if (!entityId) {
    throw new TypeError('Managed entity id must be a non-empty string.');
  }

  return entityId;
}

function isStatsSectionForEntity(
  entityType: ManagedEntityType,
  value: unknown,
): value is ManagedEntityStatsSection {
  if (typeof value !== 'string') {
    return false;
  }

  return entityType === 'chat'
    ? CHAT_STATS_SECTIONS.has(value as ManagedEntityChatStatsSection)
    : CHANNEL_STATS_SECTIONS.has(value as ManagedEntityChannelStatsSection);
}

function getDefaultStatsSection(entityType: ManagedEntityType): ManagedEntityStatsSection {
  return entityType === 'chat' ? 'activity' : 'overview';
}

export function sanitizeManagedEntityHomeSnapshot(
  value: unknown,
): ManagedEntityHomeSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const anchor = isRecord(value.anchor) ? value.anchor : {};
  const anchorId = normalizeNonEmptyString(anchor.id);

  return {
    query: typeof value.query === 'string' ? value.query : '',
    filter: HOME_FILTERS.has(value.filter as ManagedEntityHomeFilter)
      ? (value.filter as ManagedEntityHomeFilter)
      : 'all',
    anchor: {
      id: anchorId,
      index: normalizeAnchorIndex(anchor.index),
      offset: normalizeAnchorOffset(anchor.offset),
    },
    focusTarget: HOME_FOCUS_TARGETS.has(value.focusTarget as ManagedEntityHomeFocusTarget)
      ? (value.focusTarget as ManagedEntityHomeFocusTarget)
      : 'entity-title',
    scrollMode: HOME_SCROLL_MODES.has(value.scrollMode as ManagedEntityHomeScrollMode)
      ? (value.scrollMode as ManagedEntityHomeScrollMode)
      : 'document',
  };
}

export function buildManagedEntityHomeSnapshotStorageKey(options: {
  userId: string | null | undefined;
  locationKey: string;
  entityType: ManagedEntityType;
}): string {
  const locationKey = normalizeNonEmptyString(options.locationKey);
  if (!locationKey) {
    throw new TypeError('Home location key must be a non-empty string.');
  }

  const userId = normalizeNonEmptyString(options.userId) ?? 'anonymous';
  return [
    MANAGED_ENTITY_HOME_SNAPSHOT_STORAGE_PREFIX,
    `v${MANAGED_ENTITY_HOME_SNAPSHOT_STORAGE_VERSION}`,
    encodeURIComponent(userId),
    encodeURIComponent(locationKey),
    options.entityType,
  ].join(':');
}

export function buildManagedEntityStatsPreferenceStorageKey(options: {
  locationKey: string;
  entityType: ManagedEntityType;
  entityId: string;
}): string {
  const locationKey = normalizeNonEmptyString(options.locationKey);
  if (!locationKey) {
    throw new TypeError('Home location key must be a non-empty string.');
  }

  return [
    MANAGED_ENTITY_STATS_PREFERENCE_STORAGE_PREFIX,
    `v${MANAGED_ENTITY_STATS_PREFERENCE_STORAGE_VERSION}`,
    encodeURIComponent(locationKey),
    options.entityType,
    encodeURIComponent(normalizeEntityId(options.entityId)),
  ].join(':');
}

export function readManagedEntityHomeSnapshot(
  storage: WorkspaceStorage,
  key: string,
): ManagedEntityHomeSnapshot | null {
  try {
    const serialized = storage.getItem(key);
    return serialized ? sanitizeManagedEntityHomeSnapshot(JSON.parse(serialized)) : null;
  } catch {
    return null;
  }
}

export function saveManagedEntityHomeSnapshot(
  storage: WorkspaceStorage,
  key: string,
  snapshot: ManagedEntityHomeSnapshot,
): boolean {
  const sanitized = sanitizeManagedEntityHomeSnapshot(snapshot);
  if (!sanitized) {
    return false;
  }

  try {
    storage.setItem(key, JSON.stringify(sanitized));
    return true;
  } catch {
    return false;
  }
}

export function clearManagedEntityHomeSnapshot(storage: WorkspaceStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Session storage can be unavailable in hardened WebViews.
  }
}

export function sanitizeManagedEntityWorkspaceOrigin(
  value: unknown,
): ManagedEntityWorkspaceOrigin | null {
  if (!isRecord(value)) {
    return null;
  }

  const locationKey = normalizeNonEmptyString(value.locationKey);
  const historyIndex = normalizeHistoryIndex(value.historyIndex);
  if (!locationKey || historyIndex === null) {
    return null;
  }

  return { locationKey, historyIndex };
}

export function sanitizeManagedEntityStatsPreference(
  entityType: ManagedEntityType,
  value: unknown,
): ManagedEntityStatsPreference {
  if (!isRecord(value)) {
    return {};
  }

  const preference: ManagedEntityStatsPreference = {};
  if (isStatsSectionForEntity(entityType, value.section)) {
    preference.section = value.section;
  }
  if (STATS_RANGES.has(value.range as ManagedEntityStatsRange)) {
    preference.range = value.range as ManagedEntityStatsRange;
  }

  return preference;
}

export function mergeManagedEntityStatsPreference(
  entityType: ManagedEntityType,
  current: unknown,
  update: unknown,
): ManagedEntityStatsPreference {
  return {
    ...sanitizeManagedEntityStatsPreference(entityType, current),
    ...sanitizeManagedEntityStatsPreference(entityType, update),
  };
}

export function readManagedEntityStatsPreference(
  storage: WorkspaceStorage,
  key: string,
  entityType: ManagedEntityType,
): ManagedEntityStatsPreference {
  try {
    const serialized = storage.getItem(key);
    return serialized
      ? sanitizeManagedEntityStatsPreference(entityType, JSON.parse(serialized))
      : {};
  } catch {
    return {};
  }
}

export function saveManagedEntityStatsPreference(
  storage: WorkspaceStorage,
  key: string,
  entityType: ManagedEntityType,
  preference: unknown,
): boolean {
  try {
    storage.setItem(
      key,
      JSON.stringify(sanitizeManagedEntityStatsPreference(entityType, preference)),
    );
    return true;
  } catch {
    return false;
  }
}

export function getManagedEntitySessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveManagedEntityStatsPreferenceForWorkspace(
  storage: WorkspaceStorage | null,
  routeState: unknown,
  options: {
    entityType: ManagedEntityType;
    entityId: string;
    preference: unknown;
  },
): boolean {
  if (!storage) {
    return false;
  }

  const workspace = readManagedEntityWorkspaceState(routeState);
  if (
    workspace?.entityType !== options.entityType ||
    workspace.entityId !== options.entityId ||
    !workspace.origin
  ) {
    return false;
  }

  return saveManagedEntityStatsPreference(
    storage,
    buildManagedEntityStatsPreferenceStorageKey({
      locationKey: workspace.origin.locationKey,
      entityType: options.entityType,
      entityId: options.entityId,
    }),
    options.entityType,
    mergeManagedEntityStatsPreference(
      options.entityType,
      workspace.statsPreference,
      options.preference,
    ),
  );
}

export function createManagedEntityWorkspaceState(options: {
  entityType: ManagedEntityType;
  entityId: string;
  origin?: unknown;
  homeSnapshot?: unknown;
  statsPreference?: unknown;
}): ManagedEntityWorkspaceState {
  return {
    version: MANAGED_ENTITY_WORKSPACE_STATE_VERSION,
    entityType: options.entityType,
    entityId: normalizeEntityId(options.entityId),
    origin: sanitizeManagedEntityWorkspaceOrigin(options.origin),
    homeSnapshot: sanitizeManagedEntityHomeSnapshot(options.homeSnapshot),
    statsPreference: sanitizeManagedEntityStatsPreference(
      options.entityType,
      options.statsPreference,
    ),
  };
}

export function sanitizeManagedEntityWorkspaceState(
  value: unknown,
): ManagedEntityWorkspaceState | null {
  if (
    !isRecord(value) ||
    value.version !== MANAGED_ENTITY_WORKSPACE_STATE_VERSION ||
    !isManagedEntityType(value.entityType)
  ) {
    return null;
  }

  const entityId = normalizeNonEmptyString(value.entityId);
  if (!entityId) {
    return null;
  }

  return {
    version: MANAGED_ENTITY_WORKSPACE_STATE_VERSION,
    entityType: value.entityType,
    entityId,
    origin: sanitizeManagedEntityWorkspaceOrigin(value.origin),
    homeSnapshot: sanitizeManagedEntityHomeSnapshot(value.homeSnapshot),
    statsPreference: sanitizeManagedEntityStatsPreference(value.entityType, value.statsPreference),
  };
}

export function readManagedEntityWorkspaceState(
  routeState: unknown,
): ManagedEntityWorkspaceState | null {
  return isRecord(routeState)
    ? sanitizeManagedEntityWorkspaceState(routeState[MANAGED_ENTITY_WORKSPACE_STATE_KEY])
    : null;
}

export function mergeManagedEntityWorkspaceRouteState(
  routeState: unknown,
  workspaceState: ManagedEntityWorkspaceState,
): ManagedEntityWorkspaceRouteState {
  const sanitizedWorkspace = sanitizeManagedEntityWorkspaceState(workspaceState);
  if (!sanitizedWorkspace) {
    throw new TypeError('Managed entity workspace state is invalid.');
  }

  return {
    ...(isRecord(routeState) ? routeState : {}),
    [MANAGED_ENTITY_WORKSPACE_STATE_KEY]: sanitizedWorkspace,
  };
}

export function buildManagedEntitySettingsRoute(
  entityType: ManagedEntityType,
  entityId: string,
): string {
  return `/${entityType}/${encodeURIComponent(normalizeEntityId(entityId))}/settings`;
}

export function buildManagedEntityStatisticsRoute(
  entityType: ManagedEntityType,
  entityId: string,
  preference?: unknown,
): string {
  const pathSegment = entityType === 'chat' ? 'events' : 'stats';
  const sanitizedPreference = sanitizeManagedEntityStatsPreference(entityType, preference);
  const search = new URLSearchParams();
  search.set('section', sanitizedPreference.section ?? getDefaultStatsSection(entityType));
  if (sanitizedPreference.range) {
    search.set('range', sanitizedPreference.range);
  }

  return `/${entityType}/${encodeURIComponent(normalizeEntityId(entityId))}/${pathSegment}?${search.toString()}`;
}

export function preserveManagedEntityRouteContext(
  targetRoute: string,
  currentSearch: string,
  currentHash: string,
): string {
  const target = new URL(targetRoute, 'https://miniapp.local');
  const contextSearch = new URLSearchParams(currentSearch);
  contextSearch.delete('view');
  contextSearch.delete('section');
  contextSearch.delete('range');

  for (const [key, value] of contextSearch) {
    if (!target.searchParams.has(key)) {
      target.searchParams.append(key, value);
    }
  }

  if (!target.hash && currentHash.trim()) {
    target.hash = currentHash.startsWith('#') ? currentHash : `#${currentHash}`;
  }

  return `${target.pathname}${target.search}${target.hash}`;
}

export function decideManagedEntityWorkspaceBack(options: {
  origin: unknown;
  currentLocationKey: unknown;
  currentHistoryIndex: unknown;
}): ManagedEntityWorkspaceBackDecision {
  const origin = sanitizeManagedEntityWorkspaceOrigin(options.origin);
  const currentLocationKey = normalizeNonEmptyString(options.currentLocationKey);
  const currentHistoryIndex = normalizeHistoryIndex(options.currentHistoryIndex);

  if (
    origin &&
    currentLocationKey &&
    currentLocationKey !== origin.locationKey &&
    currentHistoryIndex === origin.historyIndex + 1
  ) {
    return 'history-back';
  }

  return 'home';
}

export function resolveManagedEntityHomeAnchor(
  snapshot: ManagedEntityHomeSnapshot,
  entityIds: readonly string[],
): ManagedEntityHomeAnchorResolution {
  if (entityIds.length === 0) {
    return {
      kind: 'search-heading',
      offset: 0,
      focusTarget: 'search-heading',
      scrollMode: snapshot.scrollMode,
    };
  }

  const matchingIndex = snapshot.anchor.id ? entityIds.indexOf(snapshot.anchor.id) : -1;
  const index =
    matchingIndex >= 0
      ? matchingIndex
      : Math.min(Math.max(0, snapshot.anchor.index), entityIds.length - 1);

  return {
    kind: 'entity',
    id: entityIds[index] as string,
    index,
    offset: snapshot.anchor.offset,
    focusTarget: snapshot.focusTarget,
    scrollMode: snapshot.scrollMode,
  };
}
