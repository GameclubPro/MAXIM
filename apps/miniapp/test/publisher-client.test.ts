import assert from 'node:assert/strict';
import test from 'node:test';
import { getMe } from '../src/lib/api/me-client';
import { getPublication } from '../src/lib/api/publication-client';
import {
  getPublisherEntity,
  getPublisherPolicy,
  listPublisherEntities,
  refreshPublisherEntities,
  refreshPublisherEntity,
  resolvePublisherEntities,
  updatePublisherPolicy,
  updatePublisherModules,
} from '../src/lib/api/publisher-client';
import {
  listPublisherSuggestions,
  reviewPublisherSuggestion,
} from '../src/lib/api/publisher-suggestions-client';
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

test('publisher suggestions client sends a bounded server view and opaque cursor', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api = {
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return { items: [], total: 61, nextCursor: 'next_cursor' };
    },
  };
  const signal = new AbortController().signal;

  const response = await listPublisherSuggestions(api as never, 'channel/with symbols', {
    view: 'history',
    limit: 25,
    cursor: 'opaque_cursor',
    signal,
  });

  assert.equal(
    calls[0]?.path,
    '/publisher/entities/channel/channel%2Fwith%20symbols/suggestions?view=history&limit=25&cursor=opaque_cursor',
  );
  assert.equal(calls[0]?.init?.signal, signal);
  assert.equal(response.total, 61);
  assert.equal(response.nextCursor, 'next_cursor');
});

test('publisher suggestions client applies pending page defaults before requesting', async () => {
  const calls: string[] = [];
  const api = {
    request: async (path: string) => {
      calls.push(path);
      return { items: [], total: 0, nextCursor: null };
    },
  };

  await listPublisherSuggestions(api as never, 'channel-1');

  assert.equal(calls[0], '/publisher/entities/channel/channel-1/suggestions?view=pending&limit=25');
  await assert.rejects(listPublisherSuggestions(api as never, 'channel-1', { limit: 101 }));
  assert.equal(calls.length, 1);
});

test('publisher entity client encodes ids and validates policy update payloads', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const entity = {
    id: 'channel/with?symbols',
    title: 'Канал',
    entityType: 'channel',
    policy: {
      publikEnabled: true,
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
  const signal = new AbortController().signal;
  const policy = await updatePublisherPolicy(
    api as never,
    'channel',
    entity.id,
    {
      expectedRevision: 4,
      publikEnabled: false,
    },
    { signal },
  );

  assert.equal(calls[0]?.path, '/publisher/entities/channel/channel%2Fwith%3Fsymbols');
  assert.equal(calls[1]?.path, '/publisher/entities/channel/channel%2Fwith%3Fsymbols/policy');
  assert.equal(calls[1]?.init?.method, 'PATCH');
  assert.equal(calls[1]?.init?.signal, signal);
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    expectedRevision: 4,
    publikEnabled: false,
  });
  assert.equal(policy.revision, 5);
});

test('Major reads only the policy endpoint without requesting Publisher inventory', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api = {
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return {
        publikEnabled: true,
        revision: 3,
        updatedAt: null,
      };
    },
  };
  const signal = new AbortController().signal;

  const policy = await getPublisherPolicy(api as never, 'chat', 'chat/with?symbols', { signal });

  assert.equal(calls[0]?.path, '/publisher/entities/chat/chat%2Fwith%3Fsymbols/policy');
  assert.equal(calls[0]?.init?.signal, signal);
  assert.equal(policy.revision, 3);
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
    /Invalid input/u,
  );
  assert.equal(requested, false);
});

test('publisher client sends all chat comment module settings as one revisioned change', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api = {
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return {
        revision: 8,
        chatComments: {
          commentsEnabled: true,
          commentsAdminsEnabled: false,
          commentsChatBroadcastsEnabled: true,
        },
        autoRepliesEnabled: false,
        channelSuggestionsEnabled: null,
      };
    },
  };
  const chatComments = {
    commentsEnabled: true,
    commentsAdminsEnabled: false,
    commentsChatBroadcastsEnabled: true,
  };

  await updatePublisherModules(api as never, 'chat', 'chat/one', {
    expectedRevision: 7,
    chatComments,
  });

  assert.equal(calls[0]?.path, '/publisher/entities/chat/chat%2Fone/modules');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    expectedRevision: 7,
    chatComments,
  });
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
  assert.ok(mixed.items.every((item) => !Object.hasOwn(item, 'settingsHandoffUrl')));
  assert.ok(mixed.items.every((item) => !Object.hasOwn(item, 'channelOverview')));
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

test('preview exposes the disabled-policy permission blocker used by visual validation', async () => {
  const api = createPreviewApiTransport({ search: '?publisherPolicyState=permission' });

  await assert.rejects(
    updatePublisherPolicy(api, 'channel', 'preview-channel', {
      expectedRevision: 0,
      publikEnabled: true,
    }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'BOT_CAPABILITY_REQUIRED' &&
      'payload' in error &&
      (error.payload as { blockerCode?: unknown })?.blockerCode === 'bot_access_unconfirmed',
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

test('preview publisher suggestions preserve multiline rich text source format', async () => {
  const suggestions = await listPublisherSuggestions(
    createPreviewApiTransport({
      search: '?profile=publisher&publisherSuggestions=mixed',
    }),
    'preview-channel',
  );

  assert.equal(suggestions.items[0]?.textFormat, 'markdown');
  assert.match(suggestions.items[0]?.text ?? '', /\*\*[\s\S]+\n\n[\s\S]+\*\*/u);
  assert.ok(suggestions.items.slice(1).every((suggestion) => suggestion.textFormat === 'plain'));
  assert.equal(suggestions.total, 4);
  assert.equal(suggestions.nextCursor, null);
});

test('preview publisher suggestions paginate pending and history independently', async () => {
  const api = createPreviewApiTransport({
    search: '?profile=publisher&publisherSuggestions=large',
  });
  const pendingFirst = await listPublisherSuggestions(api, 'preview-channel', {
    view: 'pending',
    limit: 17,
  });
  assert.equal(pendingFirst.items.length, 17);
  assert.equal(pendingFirst.total, 40);
  assert.ok(pendingFirst.nextCursor);
  assert.ok(
    pendingFirst.items.every(
      (suggestion) =>
        suggestion.reviewStatus === 'pending' || suggestion.reviewStatus === 'publishing',
    ),
  );

  const pendingSecond = await listPublisherSuggestions(api, 'preview-channel', {
    view: 'pending',
    limit: 17,
    cursor: pendingFirst.nextCursor,
  });
  assert.equal(pendingSecond.total, 40);
  assert.equal(pendingSecond.items.length, 17);
  assert.equal(
    new Set([...pendingFirst.items, ...pendingSecond.items].map((suggestion) => suggestion.id))
      .size,
    34,
  );

  const history = await listPublisherSuggestions(api, 'preview-channel', {
    view: 'history',
  });
  assert.equal(history.items.length, 25);
  assert.equal(history.total, 60);
  assert.ok(history.nextCursor);
  assert.ok(
    history.items.every(
      (suggestion) =>
        suggestion.reviewStatus === 'published' ||
        suggestion.reviewStatus === 'drafted' ||
        suggestion.reviewStatus === 'cancelled',
    ),
  );
  await assert.rejects(
    listPublisherSuggestions(api, 'preview-channel', {
      view: 'history',
      cursor: pendingFirst.nextCursor,
    }),
    /cursor/u,
  );
});

test('preview publisher review exposes asynchronous publishing and updates server totals', async () => {
  const api = createPreviewApiTransport({
    search: '?profile=publisher&publisherSuggestions=mixed',
  });
  const before = await listPublisherSuggestions(api, 'preview-channel');
  const publishTarget = before.items.find((suggestion) => suggestion.reviewStatus === 'pending');
  assert.ok(publishTarget);

  const publishing = await reviewPublisherSuggestion(api, 'preview-channel', publishTarget.id, {
    action: 'publish',
  });
  assert.equal(publishing.suggestion.reviewStatus, 'publishing');
  assert.equal(publishing.suggestion.publicationId, null);

  const cancelTarget = before.items.find(
    (suggestion) => suggestion.reviewStatus === 'pending' && suggestion.id !== publishTarget.id,
  );
  assert.ok(cancelTarget);
  await reviewPublisherSuggestion(api, 'preview-channel', cancelTarget.id, {
    action: 'cancel',
  });
  const draftTarget = before.items.find(
    (suggestion) =>
      suggestion.reviewStatus === 'pending' &&
      suggestion.id !== publishTarget.id &&
      suggestion.id !== cancelTarget.id,
  );
  assert.ok(draftTarget);
  const drafted = await reviewPublisherSuggestion(api, 'preview-channel', draftTarget.id, {
    action: 'draft',
  });
  assert.equal(drafted.suggestion.reviewStatus, 'drafted');
  assert.ok(drafted.suggestion.publicationId);
  const draftPublication = await getPublication(api, drafted.suggestion.publicationId);
  assert.equal(draftPublication.lifecycle, 'DRAFT');
  assert.equal(draftPublication.content.text, draftTarget.text);
  const pendingAfter = await listPublisherSuggestions(api, 'preview-channel');
  const historyAfter = await listPublisherSuggestions(api, 'preview-channel', {
    view: 'history',
  });

  assert.equal(pendingAfter.total, before.total - 2);
  assert.equal(historyAfter.total, 6);
  assert.equal(
    pendingAfter.items.find((suggestion) => suggestion.id === publishTarget.id)?.reviewStatus,
    'publishing',
  );
  assert.equal(
    historyAfter.items.find((suggestion) => suggestion.id === cancelTarget.id)?.reviewStatus,
    'cancelled',
  );
  assert.equal(
    historyAfter.items.find((suggestion) => suggestion.id === draftTarget.id)?.reviewStatus,
    'drafted',
  );
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

test('preview persists Publik-owned chat comment module settings', async () => {
  const api = createPreviewApiTransport({ search: '?profile=publisher' });
  const listed = await listPublisherEntities(api);
  const chat = listed.items.find((entity) => entity.entityType === 'chat');
  assert.ok(chat);
  const before = await getPublisherEntity(api, 'chat', chat.id);
  const chatComments = {
    commentsEnabled: true,
    commentsAdminsEnabled: true,
    commentsChatBroadcastsEnabled: false,
  };

  await updatePublisherModules(api, 'chat', before.id, {
    expectedRevision: before.moduleSettings.revision,
    chatComments,
  });
  const after = await getPublisherEntity(api, 'chat', before.id);

  assert.deepEqual(after.moduleSettings.chatComments, chatComments);
  assert.equal(Object.hasOwn(after, 'settingsHandoffUrl'), false);
  assert.equal(Object.hasOwn(after, 'channelOverview'), false);
});

test('preview keeps Publisher channel comments independent and exposes channel CTA metadata', async () => {
  const api = createPreviewApiTransport({
    search: '?profile=publisher&channelPostSignature=button',
  });
  const listed = await listPublisherEntities(api);
  const channel = listed.items.find(
    (entity) => entity.entityType === 'channel' && entity.readiness.canPublish,
  );
  assert.ok(channel);

  await updatePublisherModules(api, 'channel', channel.id, {
    expectedRevision: channel.moduleSettings.revision,
    channelCommentsEnabled: false,
  });
  const disabled = await getPublisherEntity(api, 'channel', channel.id);
  assert.equal(disabled.moduleSettings.channelCommentsEnabled, false);
  assert.equal(disabled.readiness.canUseChannelComments, false);
  assert.deepEqual(disabled.channelPostSignature, {
    enabled: true,
    presentation: 'button',
    text: '📞 Заказать рекламу',
    url: 'https://example.test/advertising',
  });

  await updatePublisherModules(api, 'channel', channel.id, {
    expectedRevision: disabled.moduleSettings.revision,
    channelCommentsEnabled: true,
  });
  const enabled = await getPublisherEntity(api, 'channel', channel.id);
  assert.equal(enabled.moduleSettings.channelCommentsEnabled, true);
  assert.equal(enabled.readiness.canUseChannelComments, true);
});
