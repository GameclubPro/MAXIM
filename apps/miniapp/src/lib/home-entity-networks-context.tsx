import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ManagedEntityType } from '@maxim/contracts';
import {
  useHomeEntityFavorites,
  useHomeEntityFavoritesSession,
} from './home-entity-favorites-context';
import type { ManagedEntityNetworkKey } from './home-entity-favorites-types';
import { ManagedEntityNetworkCompositionDraft } from './managed-entity-network-composition-draft';

export function useHomeEntityNetworkCatalogue(type: ManagedEntityType) {
  const { snapshot, actions } = useHomeEntityFavorites();
  const current = snapshot.byType[type];
  const refresh = useCallback(() => actions.refreshCatalogue(type), [actions, type]);
  useEffect(() => {
    const controller = new AbortController();
    void actions.refreshCatalogue(type, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [actions, type]);
  return {
    cards:
      current.catalogue?.items.map((card) => ({
        ...card,
        label: snapshot.labels.resolved[card.favoriteType],
      })) ?? [],
    compositionEpoch: current.compositionEpoch,
    typeCompositionVersion: current.typeCompositionVersion,
    labelsRevision: snapshot.labels.revision,
    stale: current.catalogueStale,
    status: current.status,
    error: current.error,
    refresh,
  };
}
export function useHomeEntityNetwork(key: ManagedEntityNetworkKey) {
  const catalogue = useHomeEntityNetworkCatalogue(key.entityType);
  const { snapshot } = useHomeEntityFavorites();
  const card = catalogue.cards.find((item) => item.favoriteType === key.favoriteType);
  return {
    label: snapshot.labels.resolved[key.favoriteType],
    entityCount: card?.entityCount ?? null,
    compositionVersion: card?.compositionVersion ?? null,
    compositionEpoch: catalogue.compositionEpoch,
    stale: catalogue.stale,
    status: catalogue.status,
    error: catalogue.error,
    refresh: catalogue.refresh,
  };
}
export function useManagedEntityNetworkCompositionDraft(key: ManagedEntityNetworkKey) {
  const session = useHomeEntityFavoritesSession();
  const draft = useMemo(
    () => new ManagedEntityNetworkCompositionDraft(session, key),
    [session, key.entityType, key.favoriteType],
  );
  const snapshot = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  return {
    ...snapshot,
    stage: draft.stage,
    discard: draft.discard,
    save: draft.save,
    rebaseAfterReview: draft.rebaseAfterReview,
  };
}
