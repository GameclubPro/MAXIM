import {
  managedEntityPublicationPolicySchema,
  publisherEntitiesResponseSchema,
  publisherEntitySchema,
  updateManagedEntityPublicationPolicyRequestSchema,
  type ManagedEntityPublicationPolicy,
  type ManagedEntityType,
  type PublisherEntitiesResponse,
  type PublisherEntity,
  type UpdateManagedEntityPublicationPolicyRequest,
} from '@maxim/contracts/publisher';
import type { ApiTransport } from './transport';

export async function listPublisherEntities(
  api: ApiTransport,
  options: { signal?: AbortSignal } = {},
): Promise<PublisherEntitiesResponse> {
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
