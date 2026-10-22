import { useMemo, useSyncExternalStore } from 'react';
import { useHomeEntityFavoritesSession } from './home-entity-favorites-context';
import type { ManagedEntityNetworkKey } from './home-entity-favorites-types';
import { ManagedEntityNetworkCompositionDraft } from './managed-entity-network-composition-draft';

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
