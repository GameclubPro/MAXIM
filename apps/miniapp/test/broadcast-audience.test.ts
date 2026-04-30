import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterBroadcastAudienceChoices,
  normalizeBroadcastAudienceTargetChatIds,
  resolveBroadcastAudienceLastScopedMode,
  resolveBroadcastAudiencePayload,
  resolveBroadcastAudienceTargetLabel,
  restoreBroadcastAudienceModeFromAll,
} from '../src/lib/broadcast-audience';

test('normalizes selected audience ids with trim and dedupe', () => {
  assert.deepEqual(
    normalizeBroadcastAudienceTargetChatIds([' chat-1 ', 'chat-2', 'chat-1', '   ']),
    ['chat-1', 'chat-2'],
  );
});

test('resolves payload for current selected and all target modes', () => {
  assert.deepEqual(
    resolveBroadcastAudiencePayload({
      targetMode: 'current',
      targetChatIds: ['chat-2'],
      currentChatId: 'chat-1',
    }),
    {
      targetMode: 'current',
      targetChatIds: ['chat-1'],
      applyToAllChats: false,
    },
  );

  assert.deepEqual(
    resolveBroadcastAudiencePayload({
      targetMode: 'selected',
      targetChatIds: [' chat-2 ', 'chat-2', 'chat-3'],
      currentChatId: 'chat-1',
    }),
    {
      targetMode: 'selected',
      targetChatIds: ['chat-2', 'chat-3'],
      applyToAllChats: false,
    },
  );

  assert.deepEqual(
    resolveBroadcastAudiencePayload({
      targetMode: 'all',
      targetChatIds: ['chat-2', 'chat-3'],
      currentChatId: 'chat-1',
    }),
    {
      targetMode: 'all',
      targetChatIds: ['chat-2', 'chat-3'],
      applyToAllChats: true,
    },
  );
});

test('restores last scoped mode from all mode using saved selection memory', () => {
  assert.equal(
    restoreBroadcastAudienceModeFromAll({
      lastScopedMode: 'selected',
      targetChatIds: ['chat-2'],
    }),
    'selected',
  );

  assert.equal(
    restoreBroadcastAudienceModeFromAll({
      lastScopedMode: 'selected',
      targetChatIds: [],
    }),
    'current',
  );
});

test('derives last scoped mode from persisted all-mode broadcasts', () => {
  assert.equal(
    resolveBroadcastAudienceLastScopedMode({
      targetMode: 'all',
      targetChatIds: ['chat-1'],
      currentChatId: 'chat-1',
    }),
    'current',
  );

  assert.equal(
    resolveBroadcastAudienceLastScopedMode({
      targetMode: 'all',
      targetChatIds: ['chat-2', 'chat-3'],
      currentChatId: 'chat-1',
    }),
    'selected',
  );
});

test('builds compact audience labels for current selected and all modes', () => {
  assert.equal(
    resolveBroadcastAudienceTargetLabel({
      targetMode: 'current',
      targetChatIds: [],
    }),
    'Текущий чат',
  );
  assert.equal(
    resolveBroadcastAudienceTargetLabel({
      targetMode: 'selected',
      targetChatIds: ['chat-2', 'chat-3'],
    }),
    '2 чата',
  );
  assert.equal(
    resolveBroadcastAudienceTargetLabel({
      targetMode: 'all',
      targetChatIds: ['chat-1', 'chat-2'],
    }),
    'Все чаты',
  );
});

test('filters audience choices by title link and id', () => {
  const items = [
    { id: 'chat-1', title: 'Главный чат', link: 'https://max.ru/main' },
    { id: 'chat-2', title: 'Саппорт', link: 'https://max.ru/help' },
  ];

  assert.deepEqual(filterBroadcastAudienceChoices(items, 'сап'), [
    { id: 'chat-2', title: 'Саппорт', link: 'https://max.ru/help' },
  ]);
  assert.deepEqual(filterBroadcastAudienceChoices(items, 'main'), [
    { id: 'chat-1', title: 'Главный чат', link: 'https://max.ru/main' },
  ]);
  assert.deepEqual(filterBroadcastAudienceChoices(items, 'chat-2'), [
    { id: 'chat-2', title: 'Саппорт', link: 'https://max.ru/help' },
  ]);
});

test('filters audience choices with normalized punctuation and russian letters', () => {
  const items = [
    { id: '-100', title: 'Жильё / ремонт', link: 'https://max.ru/home-repair' },
    { id: '-200', title: 'Новости района', link: 'https://max.ru/rayon_news' },
  ];

  assert.deepEqual(filterBroadcastAudienceChoices(items, 'жилье ремонт'), [
    { id: '-100', title: 'Жильё / ремонт', link: 'https://max.ru/home-repair' },
  ]);
  assert.deepEqual(filterBroadcastAudienceChoices(items, '@rayon news'), [
    { id: '-200', title: 'Новости района', link: 'https://max.ru/rayon_news' },
  ]);
  assert.deepEqual(filterBroadcastAudienceChoices(items, 'maxru/home'), [
    { id: '-100', title: 'Жильё / ремонт', link: 'https://max.ru/home-repair' },
  ]);
});
