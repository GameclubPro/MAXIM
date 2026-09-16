import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import {
  parseCommentDialogLocation,
  prepareCommentDialogStartup,
} from '../src/lib/comment-dialog-startup';
import { getEntityDialog } from '../src/lib/api/channel-dialog-client';
import type { ApiTransport } from '../src/lib/api/transport';
import { queryKeys } from '../src/lib/query-keys';

const token = 'test-comment-thread-token';
const pathname = '/channel/-123/dialog/comments';
const search = `?token=${token}`;

test('comment startup accepts only exact comment routes with a thread token', () => {
  assert.deepEqual(parseCommentDialogLocation(pathname, search), {
    entityType: 'channel',
    chatId: '-123',
    token,
  });
  assert.deepEqual(parseCommentDialogLocation('/chat/test%20chat/dialog/comments/', search), {
    entityType: 'chat',
    chatId: 'test chat',
    token,
  });
  for (const route of [
    '/',
    '/channel/-123/dialog/suggest',
    '/channel/%2F/dialog/comments',
    '/channel/%ZZ/dialog/comments',
    '/channel/%2E%2E/dialog/comments',
    '/channel/-123/dialog/comments/messages',
  ]) {
    assert.equal(parseCommentDialogLocation(route, search), null);
  }
  assert.equal(parseCommentDialogLocation(pathname, '?token=%20'), null);
});

test('startup shares the authenticated in-flight query with the mounted comment page', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
  let calls = 0;
  let finish!: (data: unknown) => void;
  const api: ApiTransport = {
    request: async () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    requestKeepalive: () => undefined,
  };
  const cleanup = prepareCommentDialogStartup(client, api, pathname, search);
  const queryKey = queryKeys.entityDialog('channel', '-123', 'comments', token);
  const mounted = client.fetchQuery({
    queryKey,
    queryFn: ({ signal }) => getEntityDialog(api, 'channel', '-123', 'comments', token, { signal }),
  });
  finish({ chatId: '-123', type: 'comments', messages: [] });
  assert.equal((await mounted).chatId, '-123');
  assert.equal(calls, 1);
  assert.equal(client.getQueryData(queryKey), await client.fetchQuery({ queryKey }));
  const otherPrincipal = new QueryClient();
  assert.equal(otherPrincipal.getQueryData(queryKey), undefined);
  cleanup();
  client.clear();
  otherPrincipal.clear();
});

test('leaving a prefetched comment route aborts its request without populating the cache', async () => {
  const client = new QueryClient();
  let signal: AbortSignal | null | undefined;
  const api: ApiTransport = {
    request: async (_path, init) => {
      signal = init?.signal;
      return new Promise(() => undefined);
    },
    requestKeepalive: () => undefined,
  };
  const cleanup = prepareCommentDialogStartup(client, api, pathname, search);
  cleanup();
  assert.equal(signal?.aborted, true);
  assert.equal(
    client.getQueryData(queryKeys.entityDialog('channel', '-123', 'comments', token)),
    undefined,
  );
  client.clear();
});

test('unrelated or tokenless launches never request comment data', () => {
  const client = new QueryClient();
  const api: ApiTransport = {
    request: async () => assert.fail('unexpected request'),
    requestKeepalive: () => undefined,
  };
  prepareCommentDialogStartup(client, api, '/', search)();
  prepareCommentDialogStartup(client, api, pathname, '')();
  assert.equal(client.getQueryCache().getAll().length, 0);
  client.clear();
});

test('failed speculative reads do not retry in the background or become cached data', async () => {
  const client = new QueryClient();
  let calls = 0;
  const api: ApiTransport = {
    request: async () => {
      calls++;
      throw new Error('Access denied');
    },
    requestKeepalive: () => undefined,
  };
  const queryKey = queryKeys.entityDialog('channel', '-123', 'comments', token);
  const finished = new Promise<void>((resolve) => {
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.query.state.status === 'error') {
        unsubscribe();
        resolve();
      }
    });
  });
  const cleanup = prepareCommentDialogStartup(client, api, pathname, search);
  await finished;
  assert.equal(calls, 1);
  assert.equal(client.getQueryData(queryKey), undefined);
  cleanup();
  client.clear();
});
