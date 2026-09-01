import type {
  PublisherSuggestionsResponse,
  PublisherSuggestionsView,
} from '@maxim/contracts/publisher';
import { listPublisherSuggestions } from '../lib/api/publisher-suggestions-client';
import type { ApiTransport } from '../lib/api/transport';

export const PUBLISHER_SUGGESTIONS_PAGE_SIZE = 25;
export const PUBLISHER_SUGGESTIONS_POLL_INTERVAL_MS = 4_000;

export function resolvePublisherSuggestionsRefetchInterval(options: {
  enabled: boolean;
  activeView: PublisherSuggestionsView;
}): number | false {
  return options.enabled && options.activeView === 'pending'
    ? PUBLISHER_SUGGESTIONS_POLL_INTERVAL_MS
    : false;
}

export function shouldLoadPublisherSuggestions(options: {
  enabled: boolean;
  entityId: string;
  activeView: PublisherSuggestionsView;
  requestView: PublisherSuggestionsView;
}): boolean {
  return (
    options.enabled &&
    options.entityId.trim().length > 0 &&
    options.activeView === options.requestView
  );
}

export async function loadPublisherSuggestionsPage(options: {
  api: ApiTransport;
  enabled: boolean;
  entityId: string;
  activeView: PublisherSuggestionsView;
  requestView: PublisherSuggestionsView;
  cursor: string | null;
  signal?: AbortSignal;
}): Promise<PublisherSuggestionsResponse> {
  if (!shouldLoadPublisherSuggestions(options)) {
    return { items: [], total: 0, nextCursor: null };
  }

  return listPublisherSuggestions(options.api, options.entityId, {
    view: options.requestView,
    limit: PUBLISHER_SUGGESTIONS_PAGE_SIZE,
    cursor: options.cursor,
    signal: options.signal,
  });
}
