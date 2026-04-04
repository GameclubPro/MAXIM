import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHomeView } from '../src/lib/last-chat';

test('keeps the current launch chat in the main home list when it is already present', () => {
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
      title: 'Текущий чат',
    },
  });

  assert.deepEqual(listEntities, [
    { id: 'chat-1', title: 'Текущий чат' },
    { id: 'chat-2', title: 'Второй чат' },
  ]);
  assert.equal(visibleCount, 2);
  assert.equal(hasVisibleLaunchContext, false);
});

test('injects a provisional launch entity into the main home list when sync has not caught up yet', () => {
  const [listEntities, visibleCount, hasVisibleLaunchContext] = buildHomeView({
    entities: [],
    query: '',
    activeTab: 'chat',
    visibleLaunchContext: {
      tab: 'chat',
      chatId: 'chat-1',
      title: 'Новая группа',
    },
    provisionalEntity: {
      id: 'chat-1',
      title: 'Новая группа',
    },
  });

  assert.deepEqual(listEntities, [{ id: 'chat-1', title: 'Новая группа' }]);
  assert.equal(visibleCount, 1);
  assert.equal(hasVisibleLaunchContext, false);
});

test('leaves the home list unchanged when there is no visible launch context for the active tab', () => {
  const [listEntities, visibleCount, hasVisibleLaunchContext] = buildHomeView({
    entities: [{ id: 'channel-1', title: 'Канал MAX' }],
    query: '',
    activeTab: 'channel',
    visibleLaunchContext: {
      tab: 'chat',
      chatId: 'channel-1',
      title: 'Канал MAX',
    },
    provisionalEntity: {
      id: 'channel-1',
      title: 'Канал MAX',
    },
  });

  assert.deepEqual(listEntities, [{ id: 'channel-1', title: 'Канал MAX' }]);
  assert.equal(visibleCount, 1);
  assert.equal(hasVisibleLaunchContext, false);
});
