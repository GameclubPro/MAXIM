import assert from 'node:assert/strict';
import test from 'node:test';
import type { MembershipActivityItem } from '@maxim/contracts';
import {
  buildMembershipActivityGroups,
  MEMBERSHIP_ACTIVITY_INITIAL_RENDER_LIMIT,
  MEMBERSHIP_ACTIVITY_RENDER_STEP,
  resolveNextMembershipActivityRenderLimit,
} from '../src/lib/membership-activity-feed';

function item(
  id: string,
  type: MembershipActivityItem['type'],
  createdAt: string,
): MembershipActivityItem {
  return {
    id,
    type,
    createdAt,
    userId: `user-${id}`,
    userDisplayName: `User ${id}`,
    avatarUrl: null,
    profileUrl: null,
    profileHandoffUrl: null,
  };
}

test('membership activity grouping only walks the visible slice', () => {
  const items = [
    item('1', 'joined', '2026-07-03T09:00:00.000Z'),
    item('2', 'left', '2026-07-03T10:00:00.000Z'),
    item('3', 'joined', '2026-07-02T10:00:00.000Z'),
    item('4', 'left', '2026-07-01T10:00:00.000Z'),
  ];

  const result = buildMembershipActivityGroups(items, 3, new Date('2026-07-03T12:00:00.000Z'));

  assert.equal(result.visibleCount, 3);
  assert.equal(result.hiddenCount, 1);
  assert.deepEqual(
    result.groups.map((group) => ({
      label: group.label,
      ids: group.items.map((entry) => entry.id),
      joined: group.joinedCount,
      left: group.leftCount,
    })),
    [
      { label: 'Сегодня', ids: ['1', '2'], joined: 1, left: 1 },
      { label: 'Вчера', ids: ['3'], joined: 1, left: 0 },
    ],
  );
});

test('membership activity render limit reveals loaded events in bounded chunks', () => {
  assert.equal(
    resolveNextMembershipActivityRenderLimit(MEMBERSHIP_ACTIVITY_INITIAL_RENDER_LIMIT, 1_000),
    MEMBERSHIP_ACTIVITY_INITIAL_RENDER_LIMIT + MEMBERSHIP_ACTIVITY_RENDER_STEP,
  );
  assert.equal(resolveNextMembershipActivityRenderLimit(9_999, 180), 180);
});
