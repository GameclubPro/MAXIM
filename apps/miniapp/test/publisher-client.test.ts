import assert from 'node:assert/strict';
import test from 'node:test';
import { getMe } from '../src/lib/api/me-client';
import { listPublisherEntities } from '../src/lib/api/publisher-client';
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
      homeRoute: '/publications',
    }),
  };

  const me = await getMe(api as never);
  assert.equal(me.profile, 'publisher');
  assert.equal(me.homeRoute, '/publications');
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

test('preview can render the isolated publisher profile', () => {
  const state = createInitialState('?profile=publisher', systemPreviewClock);

  assert.equal(state.me.profile, 'publisher');
  assert.equal(state.me.homeRoute, '/publications');
  assert.equal(state.me.canAccessSystem, false);
  assert.deepEqual(state.me.capabilities, [
    'publisher_workspace',
    'publisher_entities',
    'chat_comments',
  ]);
});
