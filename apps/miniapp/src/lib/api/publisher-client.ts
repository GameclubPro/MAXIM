import {
  MAX_PUBLISHER_ENTITY_RESOLVE_TARGETS,
  publisherRefreshOperationSchema,
  PUBLISHER_ENTITIES_CURSOR_INVALID_CODE,
  managedEntityPublicationPolicySchema,
  publisherEntitiesCursorQuerySchema,
  publisherEntitiesCursorResponseSchema,
  publisherEntitiesRefreshResponseSchema,
  publisherEntitiesResponseSchema,
  publisherEntitySchema,
  publisherEntityModuleSettingsSchema,
  publisherEntityRefreshResponseSchema,
  resolvePublisherEntitiesRequestSchema,
  resolvePublisherEntitiesResponseSchema,
  updateManagedEntityPublicationPolicyRequestSchema,
  updatePublisherEntityModuleSettingsRequestSchema,
  type ManagedEntityPublicationPolicy,
  type ManagedEntityType,
  type PublisherEntitiesCursorQuery,
  type PublisherEntitiesCursorResponse,
  type PublisherEntitiesRefreshResponse,
  type PublisherEntitiesResponse,
  type PublisherEntity,
  type PublisherEntityModuleSettings,
  type PublisherEntityRefreshResponse,
  type ResolvePublisherEntitiesRequest,
  type ResolvePublisherEntitiesResponse,
  type UpdateManagedEntityPublicationPolicyRequest,
  type UpdatePublisherEntityModuleSettingsRequest,
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
  return apiError.status === 400 && apiError.code === PUBLISHER_ENTITIES_CURSOR_INVALID_CODE;
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

export async function getPublisherPolicy(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ManagedEntityPublicationPolicy> {
  const response = await api.request(
    `/publisher/entities/${entityType}/${encodeURIComponent(entityId)}/policy`,
    { signal: options.signal },
  );
  return managedEntityPublicationPolicySchema.parse(response);
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

class PublisherRefreshTerminalError extends Error {}
type PendingRefresh = { startedAt: number; result: Promise<{ operationId?: string }> };
const pendingRefreshes = new WeakMap<ApiTransport, Map<string, PendingRefresh>>();

export async function runOrResumePublisherRefresh(
  api: ApiTransport,
  scope: string,
  enqueue: () => Promise<{ operationId?: string }>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const operations = pendingRefreshes.get(api) ?? new Map<string, PendingRefresh>();
  pendingRefreshes.set(api, operations);
  for (const [key, value] of operations) {
    if (Date.now() - value.startedAt >= 3600_000) operations.delete(key);
  }
  let pending = operations.get(scope);
  if (!pending) {
    pending = { startedAt: Date.now(), result: enqueue() };
    operations.set(scope, pending);
  }
  let result: { operationId?: string };
  try {
    result = await pending.result;
  } catch (error) {
    if (operations.get(scope) === pending) operations.delete(scope);
    throw error;
  }
  try {
    await waitForPublisherRefresh(api, result.operationId, signal);
    if (operations.get(scope) === pending) operations.delete(scope);
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    if (
      error instanceof PublisherRefreshTerminalError ||
      status === 401 ||
      status === 403 ||
      status === 404
    ) {
      if (operations.get(scope) === pending) operations.delete(scope);
    }
    throw error;
  }
}

export async function waitForPublisherRefresh(
  api: ApiTransport,
  operationId: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!operationId)
    throw new PublisherRefreshTerminalError(
      'Проверка принята. Обновите список позже, чтобы увидеть результат.',
    );
  const deadline = Date.now() + 120_000;
  let delayMs = 1000;
  while (true) {
    signal?.throwIfAborted();
    const result = publisherRefreshOperationSchema.parse(
      await api.request(`/publisher/refresh-operations/${encodeURIComponent(operationId)}`, {
        signal,
      }),
    );
    signal?.throwIfAborted();
    if (result.state === 'complete') return;
    if (result.state === 'partial')
      throw new PublisherRefreshTerminalError(
        'Часть подключений не удалось проверить. Повторите проверку позже.',
      );
    if (result.state === 'unavailable')
      throw new PublisherRefreshTerminalError(
        'Результат проверки недоступен. Обновите список и повторите проверку.',
      );
    if (Date.now() >= deadline)
      throw new Error('Проверка ещё выполняется. Результаты появятся после обновления списка.');
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, delayMs);
      signal?.addEventListener('abort', abort, { once: true });
    });
    delayMs = Math.min(5000, delayMs + 500);
  }
}

export async function resolvePublisherEntities(
  api: ApiTransport,
  payload: ResolvePublisherEntitiesRequest,
  options: { signal?: AbortSignal } = {},
): Promise<ResolvePublisherEntitiesResponse> {
  const items: ResolvePublisherEntitiesResponse['items'] = [];
  for (
    let offset = 0;
    offset < payload.targets.length;
    offset += MAX_PUBLISHER_ENTITY_RESOLVE_TARGETS
  ) {
    options.signal?.throwIfAborted();
    const body = resolvePublisherEntitiesRequestSchema.parse({
      ...payload,
      targets: payload.targets.slice(offset, offset + MAX_PUBLISHER_ENTITY_RESOLVE_TARGETS),
    });
    const response = await api.request('/publisher/entities/resolve', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: options.signal,
    });
    items.push(...resolvePublisherEntitiesResponseSchema.parse(response).items);
  }
  return { items };
}

export async function updatePublisherPolicy(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  payload: UpdateManagedEntityPublicationPolicyRequest,
  options: { signal?: AbortSignal } = {},
): Promise<ManagedEntityPublicationPolicy> {
  const body = updateManagedEntityPublicationPolicyRequestSchema.parse(payload);
  const response = await api.request(
    `/publisher/entities/${entityType}/${encodeURIComponent(entityId)}/policy`,
    { method: 'PATCH', body: JSON.stringify(body), signal: options.signal },
  );
  return managedEntityPublicationPolicySchema.parse(response);
}

export async function updatePublisherModules(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  payload: UpdatePublisherEntityModuleSettingsRequest,
): Promise<PublisherEntityModuleSettings> {
  const body = updatePublisherEntityModuleSettingsRequestSchema.parse(payload);
  const response = await api.request(
    `/publisher/entities/${entityType}/${encodeURIComponent(entityId)}/modules`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  return publisherEntityModuleSettingsSchema.parse(response);
}
