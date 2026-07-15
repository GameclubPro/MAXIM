import assert from 'node:assert/strict';
import test from 'node:test';
import type { LogsDashboardResponse } from '@maxim/contracts';
import {
  buildChatParticipantsSnapshotParts,
  buildLogsDashboardSnapshotParts,
  buildMembershipActivitySnapshotParts,
  isChatParticipantsPage,
  isLogsDashboardResponseForRange,
  isMembershipActivityPage,
  shouldPrefetchSecondaryEventsDashboard,
} from '../src/lib/logs-dashboard-cache';

function createDashboard(
  overrides: {
    chatId?: string;
    range?: LogsDashboardResponse['period']['range'];
  } = {},
): LogsDashboardResponse {
  return {
    chat: {
      id: overrides.chatId ?? 'chat-1',
      title: 'Chat',
      participantsCount: 120,
      avatarUrl: null,
    },
    period: {
      range: overrides.range ?? '24h',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-02T00:00:00.000Z',
    },
    membership: {
      joinedUsers: 0,
      leftUsers: 0,
      netUsers: 0,
    },
    violationsSummary: {
      warn: 0,
      deleteMessage: 0,
      mute: 0,
      ban: 0,
      unmute: 0,
      unban: 0,
      affectedUsers: 0,
      total: 0,
    },
    violations: [],
    moderationFeed: {
      items: [],
      hasMore: false,
      nextCursor: null,
    },
    activityFeed: {
      items: [],
      hasMore: false,
      nextCursor: null,
    },
  };
}

test('buildLogsDashboardSnapshotParts scopes chat dashboard snapshots by active previews', () => {
  assert.deepEqual(buildLogsDashboardSnapshotParts('chat-1', '24h', true, false), [
    'chat-1',
    '24h',
    'activity',
    'no-moderation',
  ]);
  assert.deepEqual(buildLogsDashboardSnapshotParts('chat-1', '7d', false, true), [
    'chat-1',
    '7d',
    'no-activity',
    'moderation',
  ]);
});

test('feed snapshot keys stay scoped by entity, range, filter, and search', () => {
  assert.deepEqual(buildMembershipActivitySnapshotParts('channel', 'channel-1', '7d', 'all'), [
    'channel',
    'channel-1',
    '7d',
    'all',
    'first-page',
  ]);
  assert.deepEqual(buildChatParticipantsSnapshotParts('chat-1', '24h', '  Иван  '), [
    'chat-1',
    '24h',
    'all',
    'Иван',
    'first-page',
  ]);
  assert.deepEqual(buildChatParticipantsSnapshotParts('chat-1', '24h', ''), [
    'chat-1',
    '24h',
    'all',
    'all',
    'first-page',
  ]);
  assert.deepEqual(buildChatParticipantsSnapshotParts('chat-1', '7d', '', 'admins'), [
    'chat-1',
    '7d',
    'admins',
    'all',
    'first-page',
  ]);
});

test('isLogsDashboardResponseForRange accepts only matching chat and period', () => {
  assert.equal(isLogsDashboardResponseForRange(createDashboard(), 'chat-1', '24h'), true);
  assert.equal(
    isLogsDashboardResponseForRange(createDashboard({ chatId: 'chat-2' }), 'chat-1', '24h'),
    false,
  );
  assert.equal(
    isLogsDashboardResponseForRange(createDashboard({ range: '7d' }), 'chat-1', '24h'),
    false,
  );
  assert.equal(isLogsDashboardResponseForRange(null, 'chat-1', '24h'), false);
});

test('first page snapshot validators accept only page-shaped feed data', () => {
  assert.equal(
    isMembershipActivityPage({
      items: [],
      hasMore: false,
      nextCursor: null,
    }),
    true,
  );
  assert.equal(
    isMembershipActivityPage({
      items: [],
      hasMore: false,
    }),
    false,
  );
  assert.equal(
    isChatParticipantsPage({
      items: [],
      totalCount: 10,
      hasMore: true,
      nextCursor: 'cursor',
    }),
    true,
  );
  assert.equal(
    isChatParticipantsPage({
      items: [],
      totalCount: undefined,
      hasMore: false,
      nextCursor: null,
    }),
    false,
  );
});

test('shouldPrefetchSecondaryEventsDashboard keeps automatic prefetch inside a small budget', () => {
  assert.equal(
    shouldPrefetchSecondaryEventsDashboard({
      range: '24h',
      participantsCount: 1_500,
      network: { effectiveType: '4g' },
    }),
    true,
  );
  assert.equal(
    shouldPrefetchSecondaryEventsDashboard({
      range: '7d',
      participantsCount: 120,
      network: { effectiveType: '4g' },
    }),
    false,
  );
  assert.equal(
    shouldPrefetchSecondaryEventsDashboard({
      range: '24h',
      participantsCount: 1_501,
      network: { effectiveType: '4g' },
    }),
    false,
  );
  assert.equal(
    shouldPrefetchSecondaryEventsDashboard({
      range: '24h',
      participantsCount: null,
      network: { effectiveType: '4g' },
    }),
    false,
  );
  assert.equal(
    shouldPrefetchSecondaryEventsDashboard({
      range: '24h',
      participantsCount: 120,
      network: { saveData: true, effectiveType: '4g' },
    }),
    false,
  );
  assert.equal(
    shouldPrefetchSecondaryEventsDashboard({
      range: '24h',
      participantsCount: 120,
      network: { effectiveType: '2g' },
    }),
    false,
  );
});
