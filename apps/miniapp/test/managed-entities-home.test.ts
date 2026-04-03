import assert from 'node:assert/strict';
import test from 'node:test';
import { buildManagedEntitiesHomeView } from '../src/lib/managed-entities-home';

test('deduplicates the visible launch chat from the main home list and counts it once', () => {
  const result = buildManagedEntitiesHomeView({
    entities: [
      { id: 'chat-1', title: 'Текущий чат' },
      { id: 'chat-2', title: 'Второй чат' },
    ],
    query: '',
    activeTab: 'chat',
    visibleLaunchContext: {
      tab: 'chat',
      chatId: 'chat-1',
    },
  });

  assert.deepEqual(result.listEntities, [{ id: 'chat-2', title: 'Второй чат' }]);
  assert.equal(result.visibleCount, 2);
  assert.equal(result.hasVisibleLaunchContext, true);
});

test('keeps a standalone launch card visible in the home count when the synced list is empty', () => {
  const result = buildManagedEntitiesHomeView({
    entities: [],
    query: '',
    activeTab: 'chat',
    visibleLaunchContext: {
      tab: 'chat',
      chatId: 'chat-1',
    },
  });

  assert.deepEqual(result.listEntities, []);
  assert.equal(result.visibleCount, 1);
  assert.equal(result.hasVisibleLaunchContext, true);
});

test('leaves the home list unchanged when there is no visible launch context for the active tab', () => {
  const result = buildManagedEntitiesHomeView({
    entities: [{ id: 'channel-1', title: 'Канал MAX' }],
    query: '',
    activeTab: 'channel',
    visibleLaunchContext: {
      tab: 'chat',
      chatId: 'channel-1',
    },
  });

  assert.deepEqual(result.listEntities, [{ id: 'channel-1', title: 'Канал MAX' }]);
  assert.equal(result.visibleCount, 1);
  assert.equal(result.hasVisibleLaunchContext, false);
});
