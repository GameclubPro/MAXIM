import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMembershipMovementSummary,
  formatStatisticsRangeLabel,
  resolveMembershipMovementShares,
} from '../src/lib/statistics-display';

test('membership summary is derived from complete aggregate counters', () => {
  assert.deepEqual(buildMembershipMovementSummary(18, 7), {
    joined: 18,
    left: 7,
    total: 25,
    balance: 11,
  });
});

test('zero membership movement never renders a fictional 50/50 split', () => {
  assert.deepEqual(resolveMembershipMovementShares(0, 0), {
    joined: 0,
    left: 0,
    hasMovement: false,
  });
});

test('movement shares stay complementary for non-empty periods', () => {
  assert.deepEqual(resolveMembershipMovementShares(2, 1), {
    joined: 67,
    left: 33,
    hasMovement: true,
  });
});

test('statistics ranges have explicit human-readable semantics', () => {
  assert.equal(formatStatisticsRangeLabel('24h'), 'за 24 часа');
  assert.equal(formatStatisticsRangeLabel('7d'), 'за 7 дней');
  assert.equal(formatStatisticsRangeLabel('30d'), 'за 30 дней');
});
