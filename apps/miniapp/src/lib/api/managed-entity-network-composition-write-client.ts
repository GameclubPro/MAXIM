import type { ManagedEntityNetworkCompositionChange, ManagedEntityType } from '@maxim/contracts';
import type { ApiTransport } from './transport';
import { parseManagedEntityNetworkCompositionResponse } from './managed-entity-network-composition-response';

const prefix = (type: ManagedEntityType) => `/managed-entities/networks/${type}`;

export async function updateManagedEntityNetworkComposition(
  api: ApiTransport,
  type: ManagedEntityType,
  changes: ManagedEntityNetworkCompositionChange[],
  signal?: AbortSignal,
) {
  return parseManagedEntityNetworkCompositionResponse(
    await api.request(`${prefix(type)}/composition`, {
      method: 'PUT',
      body: JSON.stringify({ changes }),
      signal,
      retryMutationOnTransportError: false,
    }),
  );
}
