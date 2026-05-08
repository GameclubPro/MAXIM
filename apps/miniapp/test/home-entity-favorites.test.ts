import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEmptyHomeEntityFavorites,
  createEmptyHomeEntityFavoritesByType,
  getHomeEntityFavoriteTypes,
  mergeHomeEntityFavorites,
  orderHomeEntitiesByFavorites,
  sanitizeHomeEntityFavorites,
  toggleHomeEntityFavoriteType,
} from '../src/lib/home-entity-favorites';

test('sanitizes favorite ids per entity type and favorite type', () => {
  const favorites = sanitizeHomeEntityFavorites({
    chat: {
      important: [' 1 ', '1', '', 2, '2'],
      watch: ['watch-1'],
    },
    channel: {
      broadcast: ['a', ' b ', 'a'],
    },
  });

  assert.deepEqual(favorites.chat.important, ['1', '2']);
  assert.deepEqual(favorites.chat.watch, ['watch-1']);
  assert.deepEqual(favorites.channel.broadcast, ['a', 'b']);
  assert.deepEqual(favorites.channel.important, []);
});

test('toggles favorite types with the newest favorite first', () => {
  const initial = createEmptyHomeEntityFavorites();
  const first = toggleHomeEntityFavoriteType(initial, 'chat', 'chat-1', 'important').favorites;
  const second = toggleHomeEntityFavoriteType(first, 'chat', 'chat-2', 'important').favorites;
  const removed = toggleHomeEntityFavoriteType(second, 'chat', 'chat-1', 'important');

  assert.deepEqual(second.chat.important, ['chat-2', 'chat-1']);
  assert.deepEqual(removed.favoriteTypes, []);
  assert.deepEqual(removed.favorites.chat.important, ['chat-2']);
});

test('orders visible entities by favorite order without dropping the rest', () => {
  const entities = [
    { id: '1', title: 'One' },
    { id: '2', title: 'Two' },
    { id: '3', title: 'Three' },
  ];
  const favorites = createEmptyHomeEntityFavoritesByType();
  favorites.important = ['3', 'missing', '1'];

  assert.deepEqual(orderHomeEntitiesByFavorites(entities, favorites), [
    { id: '3', title: 'Three' },
    { id: '1', title: 'One' },
    { id: '2', title: 'Two' },
  ]);
});

test('merges migrated device favorites behind stored user favorites', () => {
  const userFavorites = createEmptyHomeEntityFavorites();
  userFavorites.chat.important = ['user-1', 'shared'];
  userFavorites.channel.important = ['channel-1'];
  const deviceFavorites = createEmptyHomeEntityFavorites();
  deviceFavorites.chat.important = ['shared', 'device-1'];
  deviceFavorites.channel.important = ['channel-2'];

  const merged = mergeHomeEntityFavorites(userFavorites, deviceFavorites);

  assert.deepEqual(merged.chat.important, ['user-1', 'shared', 'device-1']);
  assert.deepEqual(merged.channel.important, ['channel-1', 'channel-2']);
});

test('reads all favorite types for one entity in display order', () => {
  const favorites = createEmptyHomeEntityFavorites();
  favorites.chat.service = ['chat-1'];
  favorites.chat.important = ['chat-1'];

  assert.deepEqual(getHomeEntityFavoriteTypes(favorites, 'chat', 'chat-1'), [
    'important',
    'service',
  ]);
});
