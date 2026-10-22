import {
  managedEntityNetworkCompositionResponseSchema,
  managedEntityNetworkEntriesResponseSchema,
  managedEntityNetworksResponseSchema,
} from '@maxim/contracts/managed-entities';
import type {
  ManagedEntityFavoriteType,
  ManagedEntityNetworkCompositionChange,
  ManagedEntityNetworkEntry,
  ManagedEntityType,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

const prefix = (type: ManagedEntityType) => `/managed-entities/networks/${type}`;

export async function getManagedEntityNetworks(
  api: ApiTransport,
  type: ManagedEntityType,
  signal?: AbortSignal,
) {
  return managedEntityNetworksResponseSchema.parse(await api.request(prefix(type), { signal }));
}

export async function getManagedEntityNetworkEntries(
  api: ApiTransport,
  type: ManagedEntityType,
  options: {
    favoriteType?: ManagedEntityFavoriteType;
    favoritesOnly?: boolean;
    search?: string;
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  } = {},
) {
  const query = new URLSearchParams();
  if (options.favoriteType) query.set('favoriteType', options.favoriteType);
  if (options.favoritesOnly) query.set('favoritesOnly', 'true');
  if (options.search) query.set('search', options.search);
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit) query.set('limit', String(options.limit));
  return managedEntityNetworkEntriesResponseSchema.parse(
    await api.request(`${prefix(type)}/entities?${query}`, { signal: options.signal }),
  );
}

export async function loadManagedEntityFavoriteAssignments(
  api: ApiTransport,
  type: ManagedEntityType,
  signal?: AbortSignal,
) {
  const items: ManagedEntityNetworkEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let compositionVersion: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await getManagedEntityNetworkEntries(api, type, {
      favoritesOnly: true,
      cursor,
      limit: 100,
      signal,
    });
    if (
      page.entityType !== type ||
      (compositionVersion && compositionVersion !== page.compositionVersion)
    )
      throw new Error('Состав сеток изменился во время загрузки.');
    compositionVersion = page.compositionVersion;
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seenCursors.has(cursor))
      throw new Error('Список сеток не удалось загрузить полностью.');
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return { entityType: type, compositionVersion: compositionVersion!, items };
}

export async function updateManagedEntityNetworkComposition(
  api: ApiTransport,
  type: ManagedEntityType,
  changes: ManagedEntityNetworkCompositionChange[],
  signal?: AbortSignal,
) {
  return managedEntityNetworkCompositionResponseSchema.parse(
    await api.request(`${prefix(type)}/composition`, {
      method: 'PUT',
      body: JSON.stringify({ changes }),
      signal,
      retryMutationOnTransportError: false,
    }),
  );
}
