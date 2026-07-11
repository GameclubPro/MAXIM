import {
  createPublicationRequestSchema,
  listPublicationDeliveriesQuerySchema,
  listPublicationDeliveriesResponseSchema,
  listPublicationsQuerySchema,
  listPublicationsResponseSchema,
  publicationActionRequestSchema,
  publicationCalendarAvailabilityRequestSchema,
  publicationCalendarAvailabilityResponseSchema,
  publicationDetailsSchema,
  retryPublicationOccurrenceRequestSchema,
  resolvePublicationAmbiguousDeliveryRequestSchema,
  testPublicationRequestSchema,
  updatePublicationRequestSchema,
  type CreatePublicationRequest,
  type ListPublicationDeliveriesQuery,
  type ListPublicationDeliveriesResponse,
  type ListPublicationsQuery,
  type ListPublicationsResponse,
  type PublicationActionRequest,
  type PublicationCalendarAvailabilityRequest,
  type PublicationCalendarAvailabilityResponse,
  type PublicationDetails,
  type RetryPublicationOccurrenceRequest,
  type ResolvePublicationAmbiguousDeliveryRequest,
  type TestPublicationRequest,
  type UpdatePublicationRequest,
} from '@maxim/contracts/publication';
import type { ApiTransport } from './transport';

function appendQuery(path: string, values: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `${path}?${serialized}` : path;
}

export async function listPublications(
  api: ApiTransport,
  query: Partial<ListPublicationsQuery> = {},
): Promise<ListPublicationsResponse> {
  const parsed = listPublicationsQuerySchema.parse(query);
  const response = await api.request(appendQuery('/publications', parsed));
  return listPublicationsResponseSchema.parse(response);
}

export async function getPublicationCalendarAvailability(
  api: ApiTransport,
  payload: PublicationCalendarAvailabilityRequest,
): Promise<PublicationCalendarAvailabilityResponse> {
  const response = await api.request('/publications/calendar-availability', {
    method: 'POST',
    body: JSON.stringify(publicationCalendarAvailabilityRequestSchema.parse(payload)),
  });
  return publicationCalendarAvailabilityResponseSchema.parse(response);
}

export async function getPublication(
  api: ApiTransport,
  publicationId: string,
): Promise<PublicationDetails> {
  const response = await api.request(`/publications/${encodeURIComponent(publicationId)}`);
  return publicationDetailsSchema.parse(response);
}

export async function createPublication(
  api: ApiTransport,
  payload: CreatePublicationRequest,
): Promise<PublicationDetails> {
  const response = await api.request('/publications', {
    method: 'POST',
    body: JSON.stringify(createPublicationRequestSchema.parse(payload)),
  });
  return publicationDetailsSchema.parse(response);
}

export async function updatePublication(
  api: ApiTransport,
  publicationId: string,
  payload: UpdatePublicationRequest,
): Promise<PublicationDetails> {
  const response = await api.request(`/publications/${encodeURIComponent(publicationId)}`, {
    method: 'PUT',
    body: JSON.stringify(updatePublicationRequestSchema.parse(payload)),
  });
  return publicationDetailsSchema.parse(response);
}

export async function deletePublication(
  api: ApiTransport,
  publicationId: string,
  payload: PublicationActionRequest,
): Promise<PublicationDetails> {
  const response = await api.request(`/publications/${encodeURIComponent(publicationId)}`, {
    method: 'DELETE',
    body: JSON.stringify(publicationActionRequestSchema.parse(payload)),
  });
  return publicationDetailsSchema.parse(response);
}

export async function cancelPublication(
  api: ApiTransport,
  publicationId: string,
  payload: PublicationActionRequest,
): Promise<PublicationDetails> {
  const response = await api.request(`/publications/${encodeURIComponent(publicationId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify(publicationActionRequestSchema.parse(payload)),
  });
  return publicationDetailsSchema.parse(response);
}

export async function testPublication(
  api: ApiTransport,
  payload: TestPublicationRequest,
): Promise<void> {
  await api.request('/publications/test', {
    method: 'POST',
    body: JSON.stringify(testPublicationRequestSchema.parse(payload)),
  });
}

async function runPublicationAction(
  api: ApiTransport,
  publicationId: string,
  action: 'pause' | 'resume',
  payload: PublicationActionRequest,
): Promise<PublicationDetails> {
  const response = await api.request(
    `/publications/${encodeURIComponent(publicationId)}/${action}`,
    {
      method: 'POST',
      body: JSON.stringify(publicationActionRequestSchema.parse(payload)),
    },
  );
  return publicationDetailsSchema.parse(response);
}

export const pausePublication = (
  api: ApiTransport,
  publicationId: string,
  payload: PublicationActionRequest,
) => runPublicationAction(api, publicationId, 'pause', payload);

export const resumePublication = (
  api: ApiTransport,
  publicationId: string,
  payload: PublicationActionRequest,
) => runPublicationAction(api, publicationId, 'resume', payload);

export async function listPublicationDeliveries(
  api: ApiTransport,
  publicationId: string,
  query: Partial<ListPublicationDeliveriesQuery> = {},
): Promise<ListPublicationDeliveriesResponse> {
  const parsed = listPublicationDeliveriesQuerySchema.parse(query);
  const response = await api.request(
    appendQuery(`/publications/${encodeURIComponent(publicationId)}/deliveries`, parsed),
  );
  return listPublicationDeliveriesResponseSchema.parse(response);
}

export async function retryPublicationOccurrence(
  api: ApiTransport,
  publicationId: string,
  occurrenceId: string,
  payload: RetryPublicationOccurrenceRequest,
): Promise<PublicationDetails> {
  const response = await api.request(
    `/publications/${encodeURIComponent(publicationId)}/occurrences/${encodeURIComponent(
      occurrenceId,
    )}/retry`,
    {
      method: 'POST',
      body: JSON.stringify(retryPublicationOccurrenceRequestSchema.parse(payload)),
    },
  );
  return publicationDetailsSchema.parse(response);
}

export async function resolvePublicationAmbiguousDelivery(
  api: ApiTransport,
  publicationId: string,
  occurrenceId: string,
  payload: ResolvePublicationAmbiguousDeliveryRequest,
): Promise<PublicationDetails> {
  const response = await api.request(
    `/publications/${encodeURIComponent(publicationId)}/occurrences/${encodeURIComponent(
      occurrenceId,
    )}/resolve-ambiguous`,
    {
      method: 'POST',
      body: JSON.stringify(resolvePublicationAmbiguousDeliveryRequestSchema.parse(payload)),
    },
  );
  return publicationDetailsSchema.parse(response);
}
