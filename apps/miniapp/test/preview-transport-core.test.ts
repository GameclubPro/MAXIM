import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiRequestError } from '../src/lib/api-request-error';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import {
  PREVIEW_NOT_HANDLED,
  dispatchPreviewRequest,
  type PreviewRequestContext,
} from '../src/lib/api/preview-transport-runtime';

test('preview dispatcher stops at the first handler that owns a request', async () => {
  const calls: string[] = [];
  const context = {
    url: new URL('https://preview.local/owned'),
    segments: ['owned'],
    method: 'GET',
    init: {},
  } as PreviewRequestContext;

  const result = await dispatchPreviewRequest(context, [
    () => {
      calls.push('skip');
      return PREVIEW_NOT_HANDLED;
    },
    () => {
      calls.push('owner');
      return { owner: true };
    },
    () => {
      calls.push('late');
      return { owner: false };
    },
  ]);

  assert.deepEqual(result, { owner: true });
  assert.deepEqual(calls, ['skip', 'owner']);
});

test('preview transports keep mutable state isolated per instance', async () => {
  const first = createPreviewApiTransport();
  const second = createPreviewApiTransport();

  await first.request('/chats/preview-chat/rules', {
    method: 'PUT',
    body: JSON.stringify({ text: 'Изменено только в первом preview.' }),
  });

  const firstRules = (await first.request('/chats/preview-chat/rules')) as { text: string };
  const secondRules = (await second.request('/chats/preview-chat/rules')) as { text: string };
  assert.equal(firstRules.text, 'Изменено только в первом preview.');
  assert.notEqual(secondRules.text, firstRules.text);
});

test('preview transport persists favorite labels and keeps initialization non-destructive', async () => {
  const api = createPreviewApiTransport();

  assert.deepEqual(await api.request('/managed-entities/favorite-labels'), {
    initialized: true,
    labels: {},
    revision: 1,
  });
  assert.deepEqual(
    await api.request('/managed-entities/favorite-labels', {
      method: 'PUT',
      body: JSON.stringify({
        labels: { important: 'VIP' },
        mode: 'replace',
        expectedRevision: 1,
      }),
    }),
    { initialized: true, labels: { important: 'VIP' }, revision: 2 },
  );
  assert.deepEqual(
    await api.request('/managed-entities/favorite-labels', {
      method: 'PUT',
      body: JSON.stringify({ labels: { important: 'Старое' }, mode: 'initialize' }),
    }),
    { initialized: true, labels: { important: 'VIP' }, revision: 2 },
  );
  await assert.rejects(
    () =>
      api.request('/managed-entities/favorite-labels', {
        method: 'PUT',
        body: JSON.stringify({
          labels: { watch: 'Старое окно' },
          mode: 'replace',
          expectedRevision: 1,
        }),
      }),
    (error: unknown) =>
      error instanceof ApiRequestError &&
      error.status === 409 &&
      error.code === 'MANAGED_ENTITY_FAVORITE_LABELS_REVISION_CONFLICT',
  );
});

test('preview generated ids and timestamps use the injected clock', async () => {
  const now = new Date('2031-04-05T06:07:08.009Z');
  const api = createPreviewApiTransport({ clock: { now: () => now } });

  const published = (await api.request('/chats/preview-chat/rules/publish', {
    method: 'POST',
  })) as { messageId: string; publishedAt: string };

  assert.equal(published.messageId, `rules-${now.getTime()}`);
  assert.equal(published.publishedAt, now.toISOString());
});

test('preview Karavan storefront allowlist supports listing, handoff, and revoke', async () => {
  const api = createPreviewApiTransport();

  const initial = (await api.request('/chats/preview-chat/karavan-storefront/allowlist')) as {
    items: Array<{ id: string; userId: string }>;
    hasMore: boolean;
    nextCursor: string | null;
  };
  assert.equal(initial.items.length, 1);
  assert.equal(initial.items[0]?.userId, 'preview-storefront-user-1');
  assert.equal(initial.hasMore, false);
  assert.equal(initial.nextCursor, null);

  const handoff = (await api.request(
    '/chats/preview-chat/karavan-storefront/allowlist/handoff',
    { method: 'POST', body: '{}' },
  )) as { botUrl: string };
  assert.match(handoff.botUrl, /^https:\/\/max\.ru\//u);

  const entryId = initial.items[0]?.id;
  assert.ok(entryId);
  assert.deepEqual(
    await api.request(
      `/chats/preview-chat/karavan-storefront/allowlist/${encodeURIComponent(entryId)}`,
      { method: 'DELETE' },
    ),
    { revoked: true },
  );
  const afterRevoke = (await api.request(
    '/chats/preview-chat/karavan-storefront/allowlist',
  )) as { items: unknown[] };
  assert.deepEqual(afterRevoke.items, []);
  await assert.rejects(
    () => api.request('/chats/preview-chat/karavan-storefront/allowlist?cursor=missing'),
    /cursor is invalid/u,
  );
});

test('preview keepalive reports rejection without an unhandled rejection', async () => {
  const keepaliveErrors: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    const api = createPreviewApiTransport({
      onKeepaliveError: (error) => keepaliveErrors.push(error),
    });
    api.requestKeepalive('/preview-route-that-does-not-exist');
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(keepaliveErrors.length, 1);
    assert.match(String(keepaliveErrors[0]), /does not implement GET/u);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
