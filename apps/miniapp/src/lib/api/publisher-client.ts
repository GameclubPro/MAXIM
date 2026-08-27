import {
  PUBLISHER_ENTITIES_CURSOR_INVALID_CODE,
  managedEntityPublicationPolicySchema,
  publisherEntitiesCursorQuerySchema,
  publisherEntitiesCursorResponseSchema,
  publisherEntitiesRefreshResponseSchema,
  publisherEntitiesResponseSchema,
  publisherEntitySchema,
  publisherEntityRefreshResponseSchema,
  resolvePublisherEntitiesRequestSchema,
  resolvePublisherEntitiesResponseSchema,
  updateManagedEntityPublicationPolicyRequestSchema,
  type ManagedEntityPublicationPolicy,
  type ManagedEntityType,
  type PublisherEntitiesCursorQuery,
  type PublisherEntitiesCursorResponse,
  type PublisherEntitiesRefreshResponse,
  type PublisherEntitiesResponse,
  type PublisherEntity,
  type PublisherEntityRefreshResponse,
  type ResolvePublisherEntitiesRequest,
  type ResolvePublisherEntitiesResponse,
  type UpdateManagedEntityPublicationPolicyRequest,
} from '@maxim/contracts/publisher';
import type { ApiTransport } from './transport';

export type ListPublisherEntitiesCursorOptions = Omit<
  PublisherEntitiesCursorQuery,
  'cursor' | 'limit' | 'query'
> & {
  cursor?: string | null;
  limit?: number;
  query?: string;
  signal?: AbortSignal;
};

export function isInvalidPublisherEntitiesCursorError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'ApiRequestError') {
    return false;
  }

  const apiError = error as Error & { status?: unknown; code?: unknown };
  return (
    apiError.status === 400 && apiError.code === PUBLISHER_ENTITIES_CURSOR_INVALID_CODE
  );
}

export function listPublisherEntities(
  api: ApiTransport,
  options: ListPublisherEntitiesCursorOptions,
): Promise<PublisherEntitiesCursorResponse>;
export function listPublisherEntities(
  api: ApiTransport,
  options?: { signal?: AbortSignal },
): Promise<PublisherEntitiesResponse>;
export async function listPublisherEntities(
  api: ApiTransport,
  options: ListPublisherEntitiesCursorOptions | { signal?: AbortSignal } = {},
): Promise<PublisherEntitiesResponse> {
  if ('pagination' in options) {
    const { signal, cursor, ...rawQuery } = options;
    const query = publisherEntitiesCursorQuerySchema.parse({
      ...rawQuery,
      ...(cursor ? { cursor } : {}),
    });
    const search = new URLSearchParams({ pagination: query.pagination });
    search.set('limit', String(query.limit));
    if (query.query) {
      search.set('query', query.query);
    }
    if (query.entityType) {
      search.set('entityType', query.entityType);
    }
    if (query.readiness) {
      search.set('readiness', query.readiness);
    }
    if (query.cursor) {
      search.set('cursor', query.cursor);
    }
    const response = await api.request(`/publisher/entities?${search.toString()}`, { signal });
    return publisherEntitiesCursorResponseSchema.parse(response);
  }

  const response = await api.request('/publisher/entities', { signal: options.signal });
  return publisherEntitiesResponseSchema.parse(response);
}

export async function getPublisherEntity(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  options: { signal?: AbortSignal } = {},
): Promise<PublisherEntity> {
  const response = await api.request(
    `/publisher/entities/${entityType}/${encodeURIComponent(entityId)}`,
    { signal: options.signal },
  );
  return publisherEntitySchema.parse(response);
}

export async function refreshPublisherEntity(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
): Promise<PublisherEntityRefreshResponse> {
  const response = await api.request(
    `/publisher/entities/${entityType}/${encodeURIComponent(entityId)}/refresh`,
    { method: 'POST' },
  );
  return publisherEntityRefreshResponseSchema.parse(response);
}

export async function refreshPublisherEntities(
  api: ApiTransport,
): Promise<PublisherEntitiesRefreshResponse> {
  const response = await api.request('/publisher/entities/refresh', { method: 'POST' });
  return publisherEntitiesRefreshResponseSchema.parse(response);
}

export async function resolvePublisherEntities(
  api: ApiTransport,
  payload: ResolvePublisherEntitiesRequest,
  options: { signal?: AbortSignal } = {},
): Promise<ResolvePublisherEntitiesResponse> {
  const body = resolvePublisherEntitiesRequestSchema.parse(payload);
  const response = await api.request('/publisher/entities/resolve', {
    method: 'POST',
    body: JSON.stringify(body),
    signal: options.signal,
  });
  return resolvePublisherEntitiesResponseSchema.parse(response);
}

export async function updatePublisherPolicy(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  payload: UpdateManagedEntityPublicationPolicyRequest,
): Promise<ManagedEntityPublicationPolicy> {
  const body = updateManagedEntityPublicationPolicyRequestSchema.parse(payload);
  const response = await api.request(
    `/publisher/entities/${entityType}/${encodeURIComponent(entityId)}/policy`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  return managedEntityPublicationPolicySchema.parse(response);
}
