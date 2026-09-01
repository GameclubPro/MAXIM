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
  const unreachableDelivery = {
    state: 'no_reachable_editor' as const,
    deliveredCount: 0,
    targetCount: 1,
    pendingCount: 0,
    unreachableCount: 1,
  };

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
      counts: [0, 2, 2, 0] as const,
      expected: { badge: 'В очереди', tone: 'pending' as const },
    },
    {
      state: 'delivered' as const,
      counts: [2, 2, 0, 0] as const,
      expected: { badge: 'На рассмотрении', tone: 'pending' as const },
    },
    {
      state: 'partially_delivered' as const,
      counts: [1, 3, 0, 2] as const,
      expected: {
        badge: 'Доставлено частично',
        detail: 'Доставлено редакторам: 1 из 3',
        tone: 'pending' as const,
      },
    },
    {
      state: 'no_reachable_editor' as const,
      counts: [0, 2, 0, 2] as const,
      expected: {
        badge: 'Не доставлено',
        detail: 'Редакторы пока недоступны',
        tone: 'pending' as const,
      },
    },
    {
      state: 'uncertain' as const,
      counts: [0, 1, 0, 0] as const,
      expected: { badge: 'Проверяем', tone: 'pending' as const },
    },
  ];

  for (const { state, counts, expected } of cases) {
    const [deliveredCount, targetCount, pendingCount, unreachableCount] = counts;
    const status = resolveSuggestionStatus(
      createSuggestion({
        suggestionDelivery: {
          state,
          deliveredCount,
          targetCount,
          pendingCount,
          unreachableCount,
        },
      }),
    );

    assert.deepEqual(status, expected);
  }
});

test('partial delivery exposes only the useful aggregate count', () => {
  const status = resolveSuggestionStatus(
    createSuggestion({
      suggestionDelivery: {
        state: 'partially_delivered',
        deliveredCount: 1,
        targetCount: 3,
        pendingCount: 0,
        unreachableCount: 2,
      },
    }),
  );

  assert.deepEqual(status, {
    badge: 'Доставлено частично',
    detail: 'Доставлено редакторам: 1 из 3',
    tone: 'pending',
  });
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
