import type { ManagedEntityFavoriteType, ManagedEntityType } from '@maxim/contracts';
import type { NetworkSettingsTarget } from '@maxim/contracts/network-settings';
import type { NetworkSettingsOperationReceipt } from '../../lib/network-settings-operation-storage';
import { HOME_ENTITY_FAVORITE_TYPES } from '../../lib/home-entity-favorites';

export type NetworkRouteState = {
  entityType: ManagedEntityType;
  favoriteType: ManagedEntityFavoriteType | null;
  range: '7d' | '30d';
  tab: 'overview' | 'communities';
};
export type NetworkRecipientSelection =
  | { mode: 'category' }
  | { mode: 'selected'; entityIds: readonly string[] };
export type NetworkListPosition = {
  scrollY: number;
  loadedPageCount: number;
  anchor?: { entityId: string; offset: number };
};

export function resolveNetworkRouteOperation(input: {
  userId: string;
  scopeId: string;
  entityType: ManagedEntityType;
  section: string | undefined;
  requestedOperationId?: string;
  receipts: readonly Pick<
    NetworkSettingsOperationReceipt,
    'userId' | 'scopeId' | 'entityType' | 'section' | 'operationId' | 'updatedAt'
  >[];
}): { kind: 'none' } | { kind: 'unavailable' } | { kind: 'resume'; operationId: string } {
  const matching = input.receipts.filter(
    (receipt) =>
      receipt.userId === input.userId &&
      receipt.scopeId === input.scopeId &&
      receipt.entityType === input.entityType &&
      receipt.section === input.section,
  );
  const receipt = input.requestedOperationId
    ? matching.find((value) => value.operationId === input.requestedOperationId)
    : matching.reduce<(typeof matching)[number] | undefined>(
        (latest, value) => (!latest || value.updatedAt > latest.updatedAt ? value : latest),
        undefined,
      );
  return receipt
    ? { kind: 'resume', operationId: receipt.operationId }
    : input.requestedOperationId
      ? { kind: 'unavailable' }
      : { kind: 'none' };
}

export function readNetworkRoute(search: string): NetworkRouteState {
  const query = new URLSearchParams(search);
  const category = query.get('category');
  return {
    entityType: query.get('type') === 'channel' ? 'channel' : 'chat',
    favoriteType: HOME_ENTITY_FAVORITE_TYPES.find((value) => value === category) ?? null,
    range: query.get('range') === '30d' ? '30d' : '7d',
    tab: query.get('tab') === 'communities' ? 'communities' : 'overview',
  };
}

export function buildNetworkRoute(state: NetworkRouteState): string {
  const query = new URLSearchParams({ type: state.entityType, range: state.range });
  if (state.favoriteType) {
    query.set('category', state.favoriteType);
    query.set('tab', state.tab);
  }
  return `/networks?${query}`;
}

export function networkSelectionTarget(
  selection: NetworkRecipientSelection,
  favoriteType: ManagedEntityFavoriteType,
): NetworkSettingsTarget | null {
  if (selection.mode === 'category') return { mode: 'category', favoriteType };
  const entityIds = [...new Set(selection.entityIds)];
  return entityIds.length > 0 && entityIds.length <= 500 ? { mode: 'selected', entityIds } : null;
}

export function toggleNetworkRecipient(
  selection: NetworkRecipientSelection,
  entityId: string,
): NetworkRecipientSelection {
  if (selection.mode === 'category') return selection;
  const ids = new Set(selection.entityIds);
  if (ids.has(entityId)) ids.delete(entityId);
  else if (ids.size < 500) ids.add(entityId);
  return { mode: 'selected', entityIds: [...ids] };
}

const positions = new Map<string, NetworkListPosition>();
const recipientSelections = new Map<
  string,
  { compositionVersion: string; selection: NetworkRecipientSelection }
>();
const recipientSelectionKey = (actor: string, state: NetworkRouteState) =>
  `maxim:networks:selection:v1:${actor}:${state.entityType}:${state.favoriteType ?? ''}`;

export function readNetworkRecipientSelection(
  actor: string,
  state: NetworkRouteState,
  compositionVersion: string,
): NetworkRecipientSelection {
  const key = recipientSelectionKey(actor, state);
  let value: unknown = recipientSelections.get(key);
  try {
    value ??= JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
  } catch {
    /* Memory remains available. */
  }
  if (
    value &&
    typeof value === 'object' &&
    'compositionVersion' in value &&
    value.compositionVersion === compositionVersion &&
    'selection' in value
  ) {
    const selection = value.selection;
    if (selection && typeof selection === 'object' && 'mode' in selection) {
      if (selection.mode === 'category') return { mode: 'category' };
      if (
        selection.mode === 'selected' &&
        'entityIds' in selection &&
        Array.isArray(selection.entityIds) &&
        selection.entityIds.length <= 500 &&
        selection.entityIds.every((id) => typeof id === 'string' && id.length > 0)
      )
        return { mode: 'selected', entityIds: [...new Set(selection.entityIds)] };
    }
  }
  return { mode: 'selected', entityIds: [] };
}

export function saveNetworkRecipientSelection(
  actor: string,
  state: NetworkRouteState,
  compositionVersion: string,
  selection: NetworkRecipientSelection,
): void {
  const key = recipientSelectionKey(actor, state);
  const value = { compositionVersion, selection: structuredClone(selection) };
  recipientSelections.delete(key);
  recipientSelections.set(key, value);
  if (recipientSelections.size > 48)
    recipientSelections.delete(recipientSelections.keys().next().value!);
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Keep memory state. */
  }
}
const positionKey = (actor: string, state: NetworkRouteState) =>
  `maxim:networks:position:v1:${actor}:${buildNetworkRoute(state)}`;

export function readNetworkListPosition(
  actor: string,
  state: NetworkRouteState,
): NetworkListPosition {
  const key = positionKey(actor, state);
  const cached = positions.get(key);
  if (cached) return cached;
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
    if (
      value &&
      typeof value === 'object' &&
      'scrollY' in value &&
      'loadedPageCount' in value &&
      typeof value.scrollY === 'number' &&
      Number.isFinite(value.scrollY) &&
      value.scrollY >= 0 &&
      typeof value.loadedPageCount === 'number' &&
      Number.isInteger(value.loadedPageCount) &&
      value.loadedPageCount >= 1
    ) {
      const result: NetworkListPosition = {
        scrollY: value.scrollY,
        loadedPageCount: value.loadedPageCount,
      };
      if (
        'anchor' in value &&
        value.anchor &&
        typeof value.anchor === 'object' &&
        'entityId' in value.anchor &&
        typeof value.anchor.entityId === 'string' &&
        'offset' in value.anchor &&
        typeof value.anchor.offset === 'number' &&
        Number.isFinite(value.anchor.offset)
      ) {
        result.anchor = { entityId: value.anchor.entityId, offset: value.anchor.offset };
      }
      return result;
    }
  } catch {
    /* A blocked session store still permits in-session navigation. */
  }
  return { scrollY: 0, loadedPageCount: 1 };
}

export function saveNetworkListPosition(
  actor: string,
  state: NetworkRouteState,
  position: NetworkListPosition,
): void {
  const key = positionKey(actor, state);
  positions.delete(key);
  positions.set(key, position);
  if (positions.size > 48) positions.delete(positions.keys().next().value!);
  try {
    window.sessionStorage.setItem(key, JSON.stringify(position));
  } catch {
    /* Keep memory state. */
  }
}

export function captureNetworkListPosition(loadedPageCount: number): NetworkListPosition {
  const rows = document.querySelectorAll<HTMLElement>('[data-network-entity-id]');
  const anchor = [...rows].find((row) => row.getBoundingClientRect().bottom > 0);
  return {
    scrollY: window.scrollY,
    loadedPageCount,
    ...(anchor
      ? {
          anchor: {
            entityId: anchor.dataset.networkEntityId!,
            offset: anchor.getBoundingClientRect().top,
          },
        }
      : {}),
  };
}
