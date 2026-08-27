import assert from 'node:assert/strict';
import test from 'node:test';
import {
  publisherEntitySchema,
  type PublisherEntity,
  type PublisherReadinessBlockerCode,
} from '@maxim/contracts/publisher';
import {
  buildPublisherComposeRoute,
  buildPublisherEntityViewRoute,
  fingerprintPublisherEntities,
  isPublisherEntityRefreshObserved,
  normalizePublisherEntityView,
  pollPublisherEntityRefresh,
  resolvePublisherHomeView,
  retryPublisherEntitiesNextPage,
  shouldOfferPublisherRecheck,
} from '../src/pages/publisher-entities-page-model';
import { createApiRequestError } from '../src/lib/api-request-error';

function publisherEntity(
  id: string,
  entityType: 'chat' | 'channel',
  options: {
    title?: string;
    ready?: boolean;
    blockerCode?: PublisherReadinessBlockerCode | null;
    channelSuggestionsEnabled?: boolean;
    checkedAt?: string | null;
    entityUrl?: string | null;
  } = {},
): PublisherEntity {
  const ready = options.ready ?? true;
  const blockerCode = ready ? null : (options.blockerCode ?? 'bot_not_connected');
  return publisherEntitySchema.parse({
    id,
    title: options.title ?? id,
    entityType,
    entityUrl: options.entityUrl ?? null,
    policy: {
      publikEnabled: blockerCode !== 'policy_disabled',
      revision: 0,
      updatedAt: null,
    },
    moduleSettings: {
      revision: 0,
      chatComments:
        entityType === 'chat'
          ? {
              commentsEnabled: ready,
              commentsAdminsEnabled: ready,
              commentsChatBroadcastsEnabled: false,
            }
          : null,
      channelSuggestionsEnabled:
        entityType === 'channel' ? (options.channelSuggestionsEnabled ?? false) : null,
    },
    readiness: {
      state: ready
        ? 'ready'
        : blockerCode === 'publisher_runtime_unavailable' || blockerCode === 'route_quarantined'
          ? 'temporarily_unavailable'
          : blockerCode === 'policy_disabled'
            ? 'disabled'
            : 'setup_required',
      canPublish: ready,
      canUseChatComments: entityType === 'chat' && ready,
      canPublishSuggestions:
        entityType === 'channel' && ready && options.channelSuggestionsEnabled === true,
      blockerCode,
      checkedAt: options.checkedAt ?? null,
      retryAt: null,
    },
  });
}

test('publisher cabinet normalizes its server-side entity view', () => {
  assert.equal(normalizePublisherEntityView('channel'), 'channel');
  assert.equal(normalizePublisherEntityView('unknown'), 'chat');
});

test('publisher cabinet opens the populated channel view only when no view was requested', () => {
  assert.deepEqual(resolvePublisherHomeView(null, { chat: 0, channel: 4 }), {
    view: 'channel',
    shouldReplace: true,
  });
  assert.deepEqual(resolvePublisherHomeView('chat', { chat: 0, channel: 4 }), {
    view: 'chat',
    shouldReplace: false,
  });
  assert.deepEqual(resolvePublisherHomeView(null, { chat: 2, channel: 4 }), {
    view: 'chat',
    shouldReplace: false,
  });
});

test('publisher cabinet view links preserve launch context and replace only the view', () => {
  assert.equal(
    buildPublisherEntityViewRoute('channel', '?profile=publisher&view=chat&device=iphone'),
    '/?profile=publisher&view=channel&device=iphone',
  );
});

test('publisher entity fingerprints observe access updates without depending on response order', () => {
  const first = publisherEntity('chat-1', 'chat', {
    checkedAt: '2026-08-27T10:00:00.000Z',
  });
  const second = publisherEntity('channel-1', 'channel', {
    checkedAt: '2026-08-27T10:00:00.000Z',
  });
  assert.equal(
    fingerprintPublisherEntities([first, second]),
    fingerprintPublisherEntities([second, first]),
  );
  assert.notEqual(
    fingerprintPublisherEntities([first]),
    fingerprintPublisherEntities([
      publisherEntity('chat-1', 'chat', { checkedAt: '2026-08-27T10:00:01.000Z' }),
    ]),
  );
});

test('publisher cabinet builds an encoded compose deep link', () => {
  const entity = publisherEntity('channel/with?symbols', 'channel');
  assert.equal(
    buildPublisherComposeRoute(entity),
    '/publications?compose=1&entityType=channel&entityId=channel%2Fwith%3Fsymbols',
  );
});

test('publisher cabinet exposes rechecks only for access blockers', () => {
  const blockedChat = publisherEntity('chat-setup', 'chat', { ready: false });
  const externalSuggestions = publisherEntity('channel-main', 'channel');

  assert.equal(shouldOfferPublisherRecheck(blockedChat), true);
  assert.equal(shouldOfferPublisherRecheck(externalSuggestions), false);
  assert.equal(
    shouldOfferPublisherRecheck(
      publisherEntity('channel-runtime', 'channel', {
        ready: false,
        blockerCode: 'publisher_runtime_unavailable',
      }),
    ),
    false,
  );
  assert.equal(
    shouldOfferPublisherRecheck(
      publisherEntity('channel-disabled', 'channel', {
        ready: false,
        blockerCode: 'policy_disabled',
      }),
    ),
    false,
  );
});

test('publisher cabinet retries transient next-page failures without discarding loaded pages', async () => {
  let fetchCount = 0;
  let resetCount = 0;
  const result = await retryPublisherEntitiesNextPage({
    fetchNextPage: async () => {
      fetchCount += 1;
      return { isError: true, error: new TypeError('Network failed') };
    },
    resetInvalidCursor: async () => {
      resetCount += 1;
    },
  });

  assert.equal(result, 'retried');
  assert.equal(fetchCount, 1);
  assert.equal(resetCount, 0);
});

test('publisher cabinet resets pagination only after an explicit invalid cursor response', async () => {
  let resetCount = 0;
  const result = await retryPublisherEntitiesNextPage({
    fetchNextPage: async () => ({
      isError: true,
      error: createApiRequestError(
        400,
        JSON.stringify({ code: 'PUBLISHER_ENTITIES_CURSOR_INVALID' }),
        'Invalid cursor',
      ),
    }),
    resetInvalidCursor: async () => {
      resetCount += 1;
    },
  });

  assert.equal(result, 'reset');
  assert.equal(resetCount, 1);
});

test('publisher refresh polling uses targeted backoff until a newer access check is observed', async () => {
  const initial = publisherEntity('chat-setup', 'chat', { ready: false });
  const intermediate = publisherEntity('chat-setup', 'chat', {
    ready: false,
    blockerCode: 'bot_not_connected',
  });
  const updated = publisherEntity('chat-setup', 'chat', {
    checkedAt: '2026-08-27T10:00:01.000Z',
  });
  const transientReadError = new Error('temporary read failure');
  const reads: Array<PublisherEntity | Error> = [transientReadError, intermediate, updated];
  const waited: number[] = [];

  assert.equal(isPublisherEntityRefreshObserved(initial, intermediate), false);
  assert.equal(isPublisherEntityRefreshObserved(initial, updated), true);

  const result = await pollPublisherEntityRefresh({
    initialEntity: initial,
    delaysMs: [100, 250, 500],
    wait: async (delayMs) => {
      waited.push(delayMs);
    },
    readEntity: async () => {
      const next = reads.shift() ?? updated;
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  });

  assert.equal(result.status, 'updated');
  assert.equal(result.attempts, 3);
  assert.deepEqual(waited, [100, 250, 500]);
});

test('publisher refresh polling reports timeout separately from a final status read failure', async () => {
  const initial = publisherEntity('chat-ready', 'chat', {
    checkedAt: '2026-08-27T10:00:00.000Z',
  });
  const timedOut = await pollPublisherEntityRefresh({
    initialEntity: initial,
    delaysMs: [100, 200],
    wait: async () => undefined,
    readEntity: async () => initial,
  });
  assert.equal(timedOut.status, 'timed_out');
  assert.equal(timedOut.attempts, 2);

  const readError = new Error('status unavailable');
  const readFailed = await pollPublisherEntityRefresh({
    initialEntity: initial,
    delaysMs: [100, 200],
    wait: async () => undefined,
    readEntity: async () => {
      throw readError;
    },
  });
  assert.equal(readFailed.status, 'read_failed');
  assert.equal(readFailed.attempts, 2);
  assert.equal(readFailed.status === 'read_failed' ? readFailed.error : null, readError);
});
