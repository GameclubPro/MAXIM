import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHomeView } from '../src/lib/last-chat';

test('returns all home entities when the query is empty', () => {
  const [listEntities, visibleCount] = buildHomeView({
    entities: [
      { id: 'chat-1', title: 'Первый чат' },
      { id: 'chat-2', title: 'Второй чат' },
    ],
    query: '',
  });

  assert.deepEqual(listEntities, [
    { id: 'chat-1', title: 'Первый чат' },
    { id: 'chat-2', title: 'Второй чат' },
  ]);
  assert.equal(visibleCount, 2);
});

test('filters home entities by title and id', () => {
  const [listEntities, visibleCount] = buildHomeView({
    entities: [
      { id: 'chat-1', title: 'Первый чат' },
      { id: 'channel-1', title: 'Канал MAX' },
    ],
    query: 'channel-1',
  });

  assert.deepEqual(listEntities, [{ id: 'channel-1', title: 'Канал MAX' }]);
  assert.equal(visibleCount, 1);
});
