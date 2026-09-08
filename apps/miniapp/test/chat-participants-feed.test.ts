import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ChatParticipantItem,
  ChatParticipantsPage,
  ChatParticipantsQuery,
} from '@maxim/contracts';
import {
  buildParticipantsFeedKey,
  describeParticipantViolations,
  mergeParticipants,
  normalizeParticipantsSearch,
  validateParticipantsCursor,
} from '../src/lib/chat-participants-feed';

const participant = (userId: string, violationCount = 0): ChatParticipantItem => ({
  userId,
  userDisplayName: userId,
  violationCount,
  role: 'member',
  isBot: false,
  username: null,
  avatarUrl: null,
  profileUrl: null,
  profileHandoffUrl: null,
  immunity: null,
});

test('participant feed identity separates chat, period, role, search and page size', () => {
  const query: ChatParticipantsQuery = { range: '7d', roleFilter: 'all', limit: 100 };
  const key = buildParticipantsFeedKey('a', query);
  assert.notEqual(key, buildParticipantsFeedKey('b', query));
  for (const change of [
    { range: '30d' },
    { roleFilter: 'bots' },
    { search: 'Иван' },
    { limit: 24 },
  ] as Partial<ChatParticipantsQuery>[]) {
    assert.notEqual(key, buildParticipantsFeedKey('a', { ...query, ...change }));
  }
});

test('participant search respects the API limit and trims surrounding spaces', () => {
  assert.equal(normalizeParticipantsSearch('  @иван  '), '@иван');
  assert.equal(normalizeParticipantsSearch(' '), '');
  assert.equal(normalizeParticipantsSearch('я'.repeat(101)).length, 100);
});

test('overlapping participant pages update rows without duplicates or reordering', () => {
  const current = [participant('a'), participant('b')];
  const updated = participant('a', 4);
  assert.deepEqual(mergeParticipants(current, [updated, participant('c')]), [
    updated,
    current[1],
    participant('c'),
  ]);
  assert.equal(current[0].violationCount, 0);
  assert.deepEqual(mergeParticipants([], [updated, updated]), [updated]);
});

test('participant pagination rejects missing, repeated and cyclic continuation cursors', () => {
  const page: ChatParticipantsPage = {
    items: [],
    totalCount: null,
    hasMore: true,
    nextCursor: 'b',
  };
  assert.doesNotThrow(() => validateParticipantsCursor(page, new Set(['a'])));
  assert.throws(() => validateParticipantsCursor(page, new Set(['a', 'b'])));
  assert.throws(() => validateParticipantsCursor({ ...page, nextCursor: null }, new Set()));
  assert.doesNotThrow(() =>
    validateParticipantsCursor({ ...page, hasMore: false, nextCursor: null }, new Set(['a'])),
  );
});

test('participant violation labels use Russian plural forms, including teens', () => {
  for (const [count, word] of [
    [0, 'нарушений'],
    [1, 'нарушение'],
    [2, 'нарушения'],
    [11, 'нарушений'],
    [14, 'нарушений'],
    [21, 'нарушение'],
    [24, 'нарушения'],
    [112, 'нарушений'],
  ] as const) {
    assert.equal(describeParticipantViolations(count), `${count} ${word} за выбранный период`);
  }
});
