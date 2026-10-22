import assert from 'node:assert/strict';
import test from 'node:test';
import { HomeEntityFavoritesStore } from '../src/lib/home-entity-favorites-store';
import {
  createEmptyHomeEntityFavorites,
  saveHomeEntityFavorites,
} from '../src/lib/home-entity-favorites';
import type { ApiTransport } from '../src/lib/api/transport';

function installStorage() {
  const original = globalThis.window;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
      },
    },
  });
  return () => Object.defineProperty(globalThis, 'window', { configurable: true, value: original });
}
const entry = (id: string, entityType: 'chat' | 'channel' = 'chat') => ({
  id,
  entityType,
  title: id,
  avatarUrl: null,
  favoriteType: 'watch',
});
const api = (request: ApiTransport['request']): ApiTransport => ({
  request,
  requestKeepalive() {},
});

test('an incomplete home page is not an authoritative network snapshot; all server pages commit together', async () => {
  const restore = installStorage();
  try {
    const initial = createEmptyHomeEntityFavorites();
    initial.chat.important = ['unloaded'];
    saveHomeEntityFavorites('u:store-paged', initial);
    const store = new HomeEntityFavoritesStore('u:store-paged');
    store.reconcileLoadedEntities({ chats: [{ id: 'loaded', favoriteTypes: [] }] as never });
    assert.deepEqual(store.getSnapshot().chat.important, ['unloaded']);
    let release!: (value: unknown) => void;
    let secondStarted!: () => void;
    const secondRequest = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const refreshing = store.refresh(
      api(async (path) => {
        if (!path.includes('cursor='))
          return {
            entityType: 'chat',
            compositionVersion: 'v1',
            items: [entry('a')],
            nextCursor: 'next',
          };
        secondStarted();
        return new Promise((resolve) => {
          release = resolve;
        });
      }),
      'chat',
    );
    await secondRequest;
    assert.deepEqual(store.getSnapshot().chat.important, ['unloaded']);
    release({
      entityType: 'chat',
      compositionVersion: 'v1',
      items: [entry('b')],
      nextCursor: null,
    });
    assert.equal(await refreshing, true);
    assert.deepEqual(store.getSnapshot().chat.watch, ['a', 'b']);
    assert.deepEqual(store.getSnapshot().chat.important, []);
    store.reconcileLoadedEntities({ chats: [{ id: 'a', favoriteTypes: ['important'] }] as never });
    assert.deepEqual(store.getSnapshot().chat.watch, ['a', 'b']);
  } finally {
    restore();
  }
});

test('failed or inconsistent paginated reads retain the existing complete snapshot', async () => {
  const restore = installStorage();
  try {
    const store = new HomeEntityFavoritesStore('u:store-failed');
    store.confirmChanges('chat', [
      { entityId: 'keep', expectedFavoriteType: null, favoriteType: 'important' },
    ]);
    await assert.rejects(
      store.refresh(
        api(async (path) => ({
          entityType: 'chat',
          compositionVersion: path.includes('cursor=') ? 'changed' : 'initial',
          items: [entry('new')],
          nextCursor: path.includes('cursor=') ? null : 'next',
        })),
        'chat',
      ),
    );
    assert.deepEqual(store.getSnapshot().chat.important, ['keep']);
    assert.deepEqual(store.getSnapshot().chat.watch, []);
  } finally {
    restore();
  }
});

test('a confirmed mutation wins over a late server read, while chat/channel refreshes remain independent', async () => {
  const restore = installStorage();
  try {
    const store = new HomeEntityFavoritesStore('u:store-race');
    let resolveRead!: (value: unknown) => void;
    const late = store.refresh(
      api(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
      ),
      'chat',
    );
    store.confirmChanges('chat', [
      { entityId: 'a', expectedFavoriteType: 'watch', favoriteType: null },
    ]);
    resolveRead({
      entityType: 'chat',
      compositionVersion: 'old',
      items: [entry('a')],
      nextCursor: null,
    });
    assert.equal(await late, false);
    assert.deepEqual(store.getSnapshot().chat.watch, []);
    await Promise.all(
      ['chat', 'channel'].map((type) =>
        store.refresh(
          api(async () => ({
            entityType: type,
            compositionVersion: 'typed',
            items: [entry(type, type as 'chat' | 'channel')],
            nextCursor: null,
          })),
          type as 'chat' | 'channel',
        ),
      ),
    );
    assert.deepEqual(store.getSnapshot().chat.watch, ['chat']);
    assert.deepEqual(store.getSnapshot().channel.watch, ['channel']);
  } finally {
    restore();
  }
});

test('authenticated stores reject fallback scope and keep accounts isolated', () => {
  const restore = installStorage();
  try {
    assert.throws(() => new HomeEntityFavoritesStore('device'));
    const first = new HomeEntityFavoritesStore('u:account-first');
    const second = new HomeEntityFavoritesStore('u:account-second');
    first.confirmChanges('chat', [
      { entityId: 'private', expectedFavoriteType: null, favoriteType: 'watch' },
    ]);
    assert.deepEqual(second.getSnapshot().chat.watch, []);
  } finally {
    restore();
  }
});
