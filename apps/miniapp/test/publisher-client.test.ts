import assert from 'node:assert/strict';
import test from 'node:test';
import { getMe } from '../src/lib/api/me-client';
import {
  getPublisherEntity,
  listPublisherEntities,
  refreshPublisherEntities,
  refreshPublisherEntity,
  resolvePublisherEntities,
  updatePublisherPolicy,
} from '../src/lib/api/publisher-client';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import { createInitialState } from '../src/lib/api/preview-transport-state';
import { systemPreviewClock } from '../src/lib/api/preview-transport-runtime';

test('getMe keeps the server-issued publisher profile', async () => {
  const api = {
    request: async () => ({
      userId: '42',
      username: null,
      displayName: null,
      profile: 'publisher',
      capabilities: ['publisher_workspace', 'publisher_entities', 'chat_comments'],
      homeRoute: '/',
    }),
  };

  const me = await getMe(api as never);
  assert.equal(me.profile, 'publisher');
  assert.equal(me.homeRoute, '/');
  assert.deepEqual(me.capabilities, ['publisher_workspace', 'publisher_entities', 'chat_comments']);
});

test('publisher entities preserve unready targets for the picker', async () => {
  const api = {
    request: async () => ({
      items: [
        {
          id: 'chat-1',
          title: 'Команда',
          entityType: 'chat',
          policy: {
            publikEnabled: true,
            suggestionsViaPublik: false,
            revision: 0,
            updatedAt: null,
          },
          readiness: {
            state: 'setup_required',
            canPublish: false,
            canUseChatComments: false,
            canPublishSuggestions: false,
            blockerCode: 'bot_not_connected',
            checkedAt: null,
            retryAt: null,
          },
        },
      ],
    }),
  };

  const response = await listPublisherEntities(api as never);
  assert.equal(response.items.length, 1);
  assert.equal(response.items[0]?.readiness.canPublish, false);
});

test('publisher entity cursor client sends bound server filters and validates page metadata', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api = {
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return {
        items: [],
        nextCursor: 'next_cursor',
        filteredTotal: 14,
        summary: { total: 40, chat: 26, channel: 14, ready: 30, attention: 10 },
      };
    },
  };
  const signal = new AbortController().signal;

  const response = await listPublisherEntities(api as never, {
    pagination: 'cursor',
    limit: 25,
    query: ' Новости ',
    entityType: 'channel',
    readiness: 'ready',
    cursor: 'page_cursor',
    signal,
  });

  const url = new URL(calls[0]!.path, 'https://preview.local');
  assert.deepEqual(Object.fromEntries(url.searchParams.entries()), {
    pagination: 'cursor',
    limit: '25',
    query: 'Новости',
    entityType: 'channel',
    readiness: 'ready',
    cursor: 'page_cursor',
  });
  assert.equal(calls[0]?.init?.signal, signal);
  assert.equal(response.nextCursor, 'next_cursor');
  assert.equal(response.filteredTotal, 14);
  assert.equal(response.summary.total, 40);
});

test('publisher entity client encodes ids and validates policy update payloads', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const entity = {
    id: 'channel/with?symbols',
    title: 'Канал',
    entityType: 'channel',
    policy: {
      publikEnabled: true,
      suggestionsViaPublik: false,
      revision: 4,
      updatedAt: null,
    },
    readiness: {
      state: 'ready',
      canPublish: true,
      canUseChatComments: false,
      canPublishSuggestions: false,
      blockerCode: null,
      checkedAt: null,
      retryAt: null,
    },
  };
  const api = {
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return init?.method === 'PATCH' ? { ...entity.policy, revision: 5 } : entity;
    },
  };

  await getPublisherEntity(api as never, 'channel', entity.id);
  const policy = await updatePublisherPolicy(api as never, 'channel', entity.id, {
    expectedRevision: 4,
    suggestionsViaPublik: true,
  });

  assert.equal(calls[0]?.path, '/publisher/entities/channel/channel%2Fwith%3Fsymbols');
  assert.equal(calls[1]?.path, '/publisher/entities/channel/channel%2Fwith%3Fsymbols/policy');
  assert.equal(calls[1]?.init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    expectedRevision: 4,
    suggestionsViaPublik: true,
  });
  assert.equal(policy.revision, 5);
});

test('publisher update rejects an empty policy change before transport', async () => {
  let requested = false;
  const api = {
    request: async () => {
      requested = true;
      return {};
    },
  };

  await assert.rejects(
    updatePublisherPolicy(api as never, 'chat', 'chat-1', { expectedRevision: 0 }),
    /Specify at least one publication policy field/u,
  );
  assert.equal(requested, false);
});

test('publisher entity refresh is target-specific and encodes the entity id', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api = {
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return { accepted: true };
    },
  };

  const response = await refreshPublisherEntity(api as never, 'chat', 'chat/with?symbols');

  assert.deepEqual(response, { accepted: true });
  assert.equal(calls[0]?.path, '/publisher/entities/chat/chat%2Fwith%3Fsymbols/refresh');
  assert.equal(calls[0]?.init?.method, 'POST');
});

test('publisher bulk refresh uses the bounded workspace endpoint', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api = {
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return { accepted: true, queuedCount: 3 };
    },
  };

  assert.deepEqual(await refreshPublisherEntities(api as never), {
    accepted: true,
    queuedCount: 3,
  });
  assert.equal(calls[0]?.path, '/publisher/entities/refresh');
  assert.equal(calls[0]?.init?.method, 'POST');
});

test('publisher entity hydration sends one bounded exact-target request', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api = {
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return { items: [] };
    },
  };
  const targets = [
    { id: 'chat-1', entityType: 'chat' as const },
    { id: 'channel-1', entityType: 'channel' as const },
  ];

  assert.deepEqual(await resolvePublisherEntities(api as never, { targets }), { items: [] });
  assert.equal(calls[0]?.path, '/publisher/entities/resolve');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { targets });
});

test('preview publisher list includes ready, setup, temporary, empty, and error states', async () => {
  const mixed = await listPublisherEntities(
    createPreviewApiTransport({ search: '?profile=publisher' }),
  );
  assert.equal(mixed.items.length, 4);
  assert.ok(mixed.items.some((item) => item.readiness.state === 'ready'));
  assert.ok(mixed.items.some((item) => item.readiness.blockerCode === 'write_permission_missing'));
  assert.ok(mixed.items.every((item) => item.entityUrl?.startsWith('https://max.ru/join/')));
  assert.ok(mixed.items.every((item) => item.settingsHandoffUrl?.includes('startapp=mr-')));
  assert.ok(
    mixed.items.some((item) => item.readiness.blockerCode === 'publisher_runtime_unavailable'),
  );

  const empty = await listPublisherEntities(
    createPreviewApiTransport({ search: '?profile=publisher&publisherState=empty' }),
  );
  assert.deepEqual(empty.items, []);

  const large = await listPublisherEntities(
    createPreviewApiTransport({ search: '?profile=publisher&publisherState=large' }),
  );
  assert.equal(large.items.length, 400);
  assert.equal(new Set(large.items.map((item) => item.id)).size, 400);

  const pagedApi = createPreviewApiTransport({
    search: '?profile=publisher&publisherState=large',
  });
  const firstPage = await listPublisherEntities(pagedApi, {
    pagination: 'cursor',
    limit: 30,
    entityType: 'chat',
  });
  assert.equal(firstPage.items.length, 30);
  assert.equal(firstPage.filteredTotal, 200);
  assert.equal(firstPage.summary.total, 400);
  assert.ok(firstPage.items.every((item) => item.entityType === 'chat'));
  assert.ok(firstPage.nextCursor);

  const secondPage = await listPublisherEntities(pagedApi, {
    pagination: 'cursor',
    limit: 30,
    entityType: 'chat',
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.items.length, 30);
  assert.equal(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size, 60);

  const searched = await listPublisherEntities(pagedApi, {
    pagination: 'cursor',
    query: firstPage.items[0]!.id,
    entityType: 'chat',
  });
  assert.equal(searched.filteredTotal, 1);
  assert.equal(searched.items[0]?.id, firstPage.items[0]?.id);

  await assert.rejects(
    listPublisherEntities(
      createPreviewApiTransport({ search: '?profile=publisher&publisherState=error' }),
    ),
    /unavailable/u,
  );
});

test('preview can render the isolated publisher profile', () => {
  const state = createInitialState('?profile=publisher', systemPreviewClock);

  assert.equal(state.me.profile, 'publisher');
  assert.equal(state.me.homeRoute, '/');
  assert.equal(state.me.canAccessSystem, false);
  assert.deepEqual(state.me.capabilities, [
    'publisher_workspace',
    'publisher_entities',
    'chat_comments',
  ]);
});

test('preview target-specific refresh can transition a blocked publisher entity to ready', async () => {
  const api = createPreviewApiTransport({
    search: '?profile=publisher',
    clock: { now: () => new Date('2026-08-27T10:00:00.000Z') },
  });
  const before = await getPublisherEntity(api, 'chat', 'preview-chat-2');
  const response = await refreshPublisherEntity(api, 'chat', 'preview-chat-2');
  const after = await getPublisherEntity(api, 'chat', 'preview-chat-2');

  assert.equal(before.readiness.blockerCode, 'write_permission_missing');
  assert.deepEqual(response, { accepted: true });
  assert.equal(after.readiness.state, 'ready');
  assert.equal(after.readiness.canPublish, true);
  assert.equal(after.readiness.checkedAt, '2026-08-27T10:00:00.001Z');
});
