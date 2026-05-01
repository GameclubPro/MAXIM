import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEmptyHomeEntityFavorites,
  mergeHomeEntityFavorites,
  orderHomeEntitiesByFavorites,
  sanitizeHomeEntityFavorites,
  toggleHomeEntityFavorite,
} from '../src/lib/home-entity-favorites';

test('sanitizes favorite ids per entity type', () => {
  assert.deepEqual(
    sanitizeHomeEntityFavorites({
      chat: [' 1 ', '1', '', 2, '2'],
      channel: ['a', ' b ', 'a'],
    }),
    {
      chat: ['1', '2'],
      channel: ['a', 'b'],
    },
  );
});

test('toggles favorites with the newest favorite first', () => {
  const initial = createEmptyHomeEntityFavorites();
  const first = toggleHomeEntityFavorite(initial, 'chat', 'chat-1').favorites;
  const second = toggleHomeEntityFavorite(first, 'chat', 'chat-2').favorites;
  const removed = toggleHomeEntityFavorite(second, 'chat', 'chat-1');

  assert.deepEqual(second.chat, ['chat-2', 'chat-1']);
  assert.equal(removed.favorite, false);
  assert.deepEqual(removed.favorites.chat, ['chat-2']);
});

test('orders visible entities by favorite order without dropping the rest', () => {
  const entities = [
    { id: '1', title: 'One' },
    { id: '2', title: 'Two' },
    { id: '3', title: 'Three' },
  ];

  assert.deepEqual(orderHomeEntitiesByFavorites(entities, ['3', 'missing', '1']), [
    { id: '3', title: 'Three' },
    { id: '1', title: 'One' },
    { id: '2', title: 'Two' },
  ]);
});

test('merges migrated device favorites behind stored user favorites', () => {
  assert.deepEqual(
    mergeHomeEntityFavorites(
      { chat: ['user-1', 'shared'], channel: ['channel-1'] },
      { chat: ['shared', 'device-1'], channel: ['channel-2'] },
    ),
    {
      chat: ['user-1', 'shared', 'device-1'],
      channel: ['channel-1', 'channel-2'],
    },
  );
});
