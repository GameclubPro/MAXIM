import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelDialogMessage } from '@maxim/contracts/channel-dialog';
import { resolveSuggestionStatus } from '../src/lib/channel-suggestion-status';

function createSuggestion(overrides: Partial<ChannelDialogMessage> = {}): ChannelDialogMessage {
  return {
    id: 'suggestion-1',
    type: 'suggest',
    text: 'Идея',
    authorUserId: 'author-1',
    authorDisplayName: 'Автор',
    isAdmin: false,
    avatarUrl: null,
    createdAt: '2026-08-24T10:00:00.000Z',
    attachments: [],
    reactionGroups: [],
    canEdit: false,
    canDelete: false,
    canDeleteAsAdmin: false,
    ...overrides,
  };
}

test('published and cancelled review outcomes stay authoritative over delivery', () => {
  const unreachableDelivery = { state: 'no_reachable_editor' as const };

  assert.deepEqual(
    resolveSuggestionStatus(
      createSuggestion({ reviewStatus: 'published', suggestionDelivery: unreachableDelivery }),
    ),
    { badge: 'Принято', tone: 'published' },
  );
  assert.deepEqual(
    resolveSuggestionStatus(
      createSuggestion({
        reviewStatus: 'published',
        publishedUrl: 'https://max.ru/channel/message/1',
        suggestionDelivery: unreachableDelivery,
      }),
    ),
    { badge: 'Опубликовано', tone: 'published' },
  );
  assert.deepEqual(
    resolveSuggestionStatus(
      createSuggestion({ reviewStatus: 'cancelled', suggestionDelivery: unreachableDelivery }),
    ),
    { badge: 'Отклонено', tone: 'cancelled' },
  );
});

test('maps aggregate delivery states to concise public suggestion statuses', () => {
  const cases = [
    {
      state: 'queued' as const,
      expected: { badge: 'В очереди', tone: 'pending' as const },
    },
    {
      state: 'delivered' as const,
      expected: { badge: 'На рассмотрении', tone: 'pending' as const },
    },
    {
      state: 'partially_delivered' as const,
      expected: {
        badge: 'Доставлено частично',
        tone: 'pending' as const,
      },
    },
    {
      state: 'no_reachable_editor' as const,
      expected: {
        badge: 'Не доставлено',
        detail: 'Редакторы пока недоступны',
        tone: 'pending' as const,
      },
    },
    {
      state: 'uncertain' as const,
      expected: { badge: 'Проверяем', tone: 'pending' as const },
    },
  ];

  for (const { state, expected } of cases) {
    const status = resolveSuggestionStatus(
      createSuggestion({
        suggestionDelivery: { state },
      }),
    );

    assert.deepEqual(status, expected);
  }
});

test('partial delivery does not expose editor routing or counts', () => {
  const status = resolveSuggestionStatus(
    createSuggestion({
      suggestionDelivery: {
        state: 'partially_delivered',
      },
    }),
  );

  assert.deepEqual(status, {
    badge: 'Доставлено частично',
    tone: 'pending',
  });
  assert.doesNotMatch(JSON.stringify(status), /редактор|1|3/iu);
});

test('legacy undelivered suggestions remain visibly distinct from delivered ones', () => {
  assert.deepEqual(resolveSuggestionStatus(createSuggestion({ delivered: false })), {
    badge: 'Не доставлено',
    detail: 'Доставка редакторам не подтверждена',
    tone: 'pending',
  });

  assert.deepEqual(resolveSuggestionStatus(createSuggestion({ delivered: true })), {
    badge: 'На рассмотрении',
    tone: 'pending',
  });
});
