import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHomeView } from '../src/lib/last-chat';

test('deduplicates the visible launch chat from the main home list and counts it once', () => {
  const [listEntities, visibleCount, hasVisibleLaunchContext] = buildHomeView({
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

  assert.deepEqual(listEntities, [{ id: 'chat-2', title: 'Второй чат' }]);
  assert.equal(visibleCount, 2);
  assert.equal(hasVisibleLaunchContext, true);
});

test('keeps a standalone launch card visible in the home count when the synced list is empty', () => {
  const [listEntities, visibleCount, hasVisibleLaunchContext] = buildHomeView({
    entities: [],
    query: '',
    activeTab: 'chat',
    visibleLaunchContext: {
      tab: 'chat',
      chatId: 'chat-1',
    },
  });

  assert.deepEqual(listEntities, []);
  assert.equal(visibleCount, 1);
  assert.equal(hasVisibleLaunchContext, true);
});

test('leaves the home list unchanged when there is no visible launch context for the active tab', () => {
  const [listEntities, visibleCount, hasVisibleLaunchContext] = buildHomeView({
    entities: [{ id: 'channel-1', title: 'Канал MAX' }],
    query: '',
    activeTab: 'channel',
    visibleLaunchContext: {
      tab: 'chat',
      chatId: 'channel-1',
    },
  });

  assert.deepEqual(listEntities, [{ id: 'channel-1', title: 'Канал MAX' }]);
  assert.equal(visibleCount, 1);
  assert.equal(hasVisibleLaunchContext, false);
});
