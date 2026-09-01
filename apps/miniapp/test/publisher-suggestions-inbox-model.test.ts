import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiTransport } from '../src/lib/api/transport';
import {
  PUBLISHER_SUGGESTIONS_POLL_INTERVAL_MS,
  loadPublisherSuggestionsPage,
  resolvePublisherSuggestionsRefetchInterval,
  shouldLoadPublisherSuggestions,
} from '../src/pages/publisher-suggestions-inbox-model';

test('active pending suggestions poll even before an item enters publishing', () => {
  assert.equal(
    resolvePublisherSuggestionsRefetchInterval({ enabled: true, activeView: 'pending' }),
    PUBLISHER_SUGGESTIONS_POLL_INTERVAL_MS,
  );
  assert.equal(
    resolvePublisherSuggestionsRefetchInterval({ enabled: true, activeView: 'history' }),
    false,
  );
  assert.equal(
    resolvePublisherSuggestionsRefetchInterval({ enabled: false, activeView: 'pending' }),
    false,
  );
});

test('disabled and inactive suggestion views perform zero transport requests', async () => {
  const calls: string[] = [];
  const api = {
    request: async (path: string) => {
      calls.push(path);
      return { items: [], total: 0, nextCursor: null };
    },
  } as ApiTransport;

  const disabled = await loadPublisherSuggestionsPage({
    api,
    enabled: false,
    entityId: 'channel-1',
    activeView: 'pending',
    requestView: 'pending',
    cursor: null,
  });
  const inactive = await loadPublisherSuggestionsPage({
    api,
    enabled: true,
    entityId: 'channel-1',
    activeView: 'pending',
    requestView: 'history',
    cursor: null,
  });

  assert.deepEqual(disabled, { items: [], total: 0, nextCursor: null });
  assert.deepEqual(inactive, { items: [], total: 0, nextCursor: null });
  assert.deepEqual(calls, []);
});

test('only the enabled active suggestion view reaches the transport', async () => {
  const calls: string[] = [];
  const api = {
    request: async (path: string) => {
      calls.push(path);
      return { items: [], total: 3, nextCursor: null };
    },
  } as ApiTransport;

  assert.equal(
    shouldLoadPublisherSuggestions({
      enabled: true,
      entityId: 'channel-1',
      activeView: 'history',
      requestView: 'history',
    }),
    true,
  );
  const response = await loadPublisherSuggestionsPage({
    api,
    enabled: true,
    entityId: 'channel-1',
    activeView: 'history',
    requestView: 'history',
    cursor: null,
  });

  assert.equal(response.total, 3);
  assert.deepEqual(calls, [
    '/publisher/entities/channel/channel-1/suggestions?view=history&limit=25',
  ]);
});
