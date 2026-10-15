import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatSummary, ManagedEntityPresentation } from '@maxim/contracts';
import { mergeEntityPresentation } from '../src/lib/use-entity-presentation';
import { displayChatTitle, resolveChatTitle, saveChatTitle } from '../src/lib/chat-titles';

const entity = {
  id: '-123',
  title: 'Имя',
  entityType: 'chat',
  avatarUrl: 'https://example.com/old.webp',
} as ChatSummary;
const data = {
  id: '-123',
  entityType: 'chat',
  title: null,
  avatarUrl: null,
  avatarState: 'unknown',
  pending: false,
  observedAt: null,
} satisfies ManagedEntityPresentation;

test('missing metadata preserves a photo; explicit absence clears it; foreign entities cannot replace it', () => {
  assert.equal(mergeEntityPresentation(entity, data).avatarUrl, entity.avatarUrl);
  assert.equal(mergeEntityPresentation(entity, { ...data, avatarState: 'absent' }).avatarUrl, null);
  assert.equal(mergeEntityPresentation(entity, { ...data, id: 'foreign', title: 'Other' }), entity);
});

test('service IDs never become display titles, while genuine numeric names remain valid', () => {
  assert.equal(displayChatTitle('-123', 'Chat -123', 'chat'), 'Группа');
  assert.equal(displayChatTitle('-123', '-123', 'channel'), 'Канал');
  assert.equal(displayChatTitle('-123', '2026', 'chat'), '2026');
});

test('last known names are scoped to the init-data account and the old unscoped cache is discarded', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const store = new Map([['maxim:chat-titles', JSON.stringify({ '-123': 'Чужое имя' })]]);
  const windowMock = {
    location: { search: '', hash: '' },
    WebApp: { initData: 'user_id=first&hash=fixture' },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowMock });
  try {
    assert.equal(resolveChatTitle('-123', 'Chat -123'), 'Chat -123');
    saveChatTitle('-123', 'Наше имя');
    assert.equal(resolveChatTitle('-123', 'Chat -123'), 'Наше имя');
    windowMock.WebApp.initData = 'user_id=second&hash=fixture';
    assert.equal(resolveChatTitle('-123', 'Chat -123'), 'Chat -123');
    assert.equal(store.has('maxim:chat-titles'), false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
