import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedAutopostRuleSummary } from '@maxim/contracts';
import { buildManagedAutopostRuleFacts } from '../src/lib/managed-autopost-ui';

function createRule(
  overrides: Partial<ManagedAutopostRuleSummary> = {},
): ManagedAutopostRuleSummary {
  return {
    id: 'rule-1',
    sourceChatId: 'chat-1',
    entityType: 'chat',
    status: 'ACTIVE',
    title: '',
    textPreview: 'Новости',
    textLength: 7,
    targetMode: 'current',
    applyToAllChats: false,
    targetChatIds: ['chat-1'],
    targetChats: 1,
    hasImage: false,
    imageCount: 0,
    hasVideo: false,
    buttons: [],
    scheduleTimezone: 'Europe/Moscow',
    scheduledSlots: ['2026-07-01T10:00:00.000Z'],
    nextSendAt: '2026-07-01T10:00:00.000Z',
    materializedCount: 0,
    revision: 1,
    createdAt: '2026-06-29T10:00:00.000Z',
    updatedAt: '2026-06-29T10:00:00.000Z',
    lastError: null,
    ...overrides,
  };
}

test('buildManagedAutopostRuleFacts names all-chat rules explicitly', () => {
  assert.deepEqual(
    buildManagedAutopostRuleFacts(
      createRule({
        targetMode: 'all',
        applyToAllChats: true,
        targetChatIds: ['chat-1', 'chat-2'],
        targetChats: 2,
      }),
      'Текущий чат',
    ),
    ['Все чаты', '1 публикация'],
  );
});

test('buildManagedAutopostRuleFacts keeps selected-chat counts compact', () => {
  assert.deepEqual(
    buildManagedAutopostRuleFacts(
      createRule({
        targetMode: 'selected',
        targetChatIds: ['chat-1', 'chat-2', 'chat-3'],
        targetChats: 3,
        scheduledSlots: ['2026-07-01T10:00:00.000Z', '2026-07-02T10:00:00.000Z'],
      }),
      'Текущий чат',
    ),
    ['3 чата', '2 публикации'],
  );
});
