import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelDialogMessage } from '@maxim/contracts/channel-dialog';
import { resolveSuggestionStatus } from '../src/lib/channel-suggestion-status';

function createSuggestion(
  overrides: Partial<ChannelDialogMessage> = {},
): ChannelDialogMessage {
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

  assert.equal(
    resolveSuggestionStatus(
      createSuggestion({ reviewStatus: 'published', suggestionDelivery: unreachableDelivery }),
    ).headline,
    'Пост вышел в канале',
  );
  assert.equal(
    resolveSuggestionStatus(
      createSuggestion({ reviewStatus: 'cancelled', suggestionDelivery: unreachableDelivery }),
    ).headline,
    'Идея не ушла в публикацию',
  );
});

test('maps aggregate delivery states to truthful public suggestion statuses', () => {
  const cases = [
    {
      state: 'queued' as const,
      counts: [0, 2, 2, 0] as const,
      headline: 'Ждёт доставки редакторам',
    },
    {
      state: 'delivered' as const,
      counts: [2, 2, 0, 0] as const,
      headline: 'Материал доставлен редакторам',
    },
    {
      state: 'partially_delivered' as const,
      counts: [1, 3, 0, 2] as const,
      headline: 'Доставлено части редакторов',
    },
    {
      state: 'no_reachable_editor' as const,
      counts: [0, 2, 0, 2] as const,
      headline: 'Сохранено, редакторы пока недоступны',
    },
    {
      state: 'uncertain' as const,
      counts: [0, 1, 0, 0] as const,
      headline: 'Доставка требует проверки',
    },
  ];

  for (const { state, counts, headline } of cases) {
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

    assert.equal(status.headline, headline);
    assert.equal(status.tone, 'pending');
  }
});

test('partial delivery exposes only aggregate counts', () => {
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

  assert.equal(
    status.note,
    'Подтверждена доставка 1 из 3. Для остальных доставка пока не подтверждена.',
  );
});

test('legacy undelivered suggestions are described as saved rather than sent', () => {
  assert.deepEqual(resolveSuggestionStatus(createSuggestion({ delivered: false })), {
    badge: 'Сохранено',
    headline: 'Предложка сохранена',
    note: 'Доставка редакторам пока не подтверждена.',
    tone: 'pending',
  });

  assert.equal(
    resolveSuggestionStatus(createSuggestion({ delivered: true })).headline,
    'Материал ушёл редакторам',
  );
});
