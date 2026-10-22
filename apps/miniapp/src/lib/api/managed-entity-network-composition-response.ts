import type {
  ManagedEntityNetworkCompositionChange,
  ManagedEntityNetworkCompositionResponse,
} from '@maxim/contracts';
import {
  invalidNetworkResponse as invalid,
  networkResponseRecord as record,
  networkResponseText as text,
  networkResponseEntityType as type,
  networkResponseNullableFavorite as nullableFavorite,
  networkResponseItems as items,
} from './managed-entity-networks-response';

export function parseManagedEntityNetworkCompositionResponse(
  value: unknown,
): ManagedEntityNetworkCompositionResponse {
  const source = record(value);
  return {
    entityType: type(source.entityType),
    changes: items(source.changes, 500).map((value): ManagedEntityNetworkCompositionChange => {
      const change = record(value);
      if (
        Object.keys(change).some(
          (key) => key !== 'entityId' && key !== 'expectedFavoriteType' && key !== 'favoriteType',
        )
      )
        return invalid();
      return {
        entityId: text(change.entityId, 1, 128, true),
        expectedFavoriteType: nullableFavorite(change.expectedFavoriteType),
        favoriteType: nullableFavorite(change.favoriteType),
      };
    }),
  };
}
