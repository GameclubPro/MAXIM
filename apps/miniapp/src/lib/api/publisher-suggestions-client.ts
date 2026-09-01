import {
  publisherSuggestionsQuerySchema,
  publisherSuggestionsResponseSchema,
  reviewPublisherSuggestionRequestSchema,
  reviewPublisherSuggestionResponseSchema,
  type PublisherSuggestionsQuery,
  type PublisherSuggestionsResponse,
  type ReviewPublisherSuggestionRequest,
  type ReviewPublisherSuggestionResponse,
} from '@maxim/contracts/publisher';
import type { ApiTransport } from './transport';

export type ListPublisherSuggestionsOptions = Partial<
  Pick<PublisherSuggestionsQuery, 'view' | 'limit'>
> & {
  cursor?: string | null;
  signal?: AbortSignal;
};

export async function listPublisherSuggestions(
  api: ApiTransport,
  entityId: string,
  options: ListPublisherSuggestionsOptions = {},
): Promise<PublisherSuggestionsResponse> {
  const { signal, cursor, ...rawQuery } = options;
  const query = publisherSuggestionsQuerySchema.parse({
    ...rawQuery,
    ...(cursor !== null && cursor !== undefined ? { cursor } : {}),
  });
  const search = new URLSearchParams({
    view: query.view,
    limit: String(query.limit),
  });
  if (query.cursor) {
    search.set('cursor', query.cursor);
  }
  const response = await api.request(
    `/publisher/entities/channel/${encodeURIComponent(entityId)}/suggestions?${search.toString()}`,
    { signal },
  );
  return publisherSuggestionsResponseSchema.parse(response);
}

export async function reviewPublisherSuggestion(
  api: ApiTransport,
  entityId: string,
  suggestionId: string,
  payload: ReviewPublisherSuggestionRequest,
): Promise<ReviewPublisherSuggestionResponse> {
  const body = reviewPublisherSuggestionRequestSchema.parse({
    ...payload,
    responseVersion: 2,
  });
  const response = await api.request(
    `/publisher/entities/channel/${encodeURIComponent(entityId)}/suggestions/${encodeURIComponent(
      suggestionId,
    )}/review`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  return reviewPublisherSuggestionResponseSchema.parse(response);
}
