import type {
  ChatSummary,
  ManagedEntityNetworkCompositionChange,
  ManagedEntityType,
} from '@maxim/contracts';
import { loadManagedEntityFavoriteAssignments } from './api/managed-entity-networks-client';
import type { ApiTransport } from './api/transport';
import {
  createEmptyHomeEntityFavoritesByType,
  hydrateHomeEntityFavorites,
  readHomeEntityFavorites,
  reconcileHomeEntityFavoritesFromEntities,
  sanitizeHomeEntityFavorites,
  saveHomeEntityFavorites,
  setHomeEntityFavoriteTypes,
  type HomeEntityFavorites,
} from './home-entity-favorites';

export class HomeEntityFavoritesStore {
  private value: HomeEntityFavorites;
  private generation = 0;
  private readonly typeGenerations: Record<ManagedEntityType, number> = { chat: 0, channel: 0 };
  private readonly completeTypes = new Set<ManagedEntityType>();
  private readonly listeners = new Set<() => void>();

  constructor(readonly scope: string) {
    if (!scope.startsWith('u:') || scope.length <= 2)
      throw new Error('Authenticated favorites scope required');
    this.value = readHomeEntityFavorites(scope);
  }

  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(next: HomeEntityFavorites) {
    this.value = sanitizeHomeEntityFavorites(next);
    this.generation += 1;
    saveHomeEntityFavorites(this.scope, this.value);
    this.listeners.forEach((listener) => listener());
  }

  async hydrate() {
    const generation = this.generation;
    const native = await hydrateHomeEntityFavorites(this.scope);
    if (generation !== this.generation) return;
    const next = sanitizeHomeEntityFavorites(native);
    for (const type of this.completeTypes) next[type] = this.value[type];
    this.publish(next);
  }

  reconcileLoadedEntities(entities: {
    chats?: readonly ChatSummary[];
    channels?: readonly ChatSummary[];
  }) {
    // FLAG: A partial home page is never proof that absent entities left a network.
    const next = reconcileHomeEntityFavoritesFromEntities(this.value, {
      chats: this.completeTypes.has('chat') ? undefined : entities.chats,
      channels: this.completeTypes.has('channel') ? undefined : entities.channels,
    });
    this.publish(next);
  }

  async refresh(api: ApiTransport, type: ManagedEntityType, signal?: AbortSignal) {
    const generation = this.typeGenerations[type];
    const loaded = await loadManagedEntityFavoriteAssignments(api, type, signal);
    signal?.throwIfAborted();
    // FLAG: A confirmed mutation or another completed refresh wins over a late read.
    if (generation !== this.typeGenerations[type]) return false;
    const byType = createEmptyHomeEntityFavoritesByType();
    for (const item of loaded.items) {
      if (item.entityType !== type || item.favoriteType === null)
        throw new Error('Invalid authoritative favorites assignment');
      byType[item.favoriteType].push(item.id);
    }
    this.completeTypes.add(type);
    this.typeGenerations[type] += 1;
    this.publish({ ...this.value, [type]: byType });
    return true;
  }

  confirmChanges(
    type: ManagedEntityType,
    changes: readonly ManagedEntityNetworkCompositionChange[],
  ) {
    this.typeGenerations[type] += 1;
    let next = this.value;
    for (const change of changes) {
      next = setHomeEntityFavoriteTypes(
        next,
        type,
        change.entityId,
        change.favoriteType ? [change.favoriteType] : [],
      );
    }
    this.publish(next);
  }
}
