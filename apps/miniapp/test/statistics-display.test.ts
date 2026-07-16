import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMembershipMovementSummary,
  formatStatisticsRangeLabel,
  resolveNullableMetricPresentation,
  resolveMembershipMovementShares,
  resolveStatisticsTitle,
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

test('statistics title prefers current API identity over stale route and storage values', () => {
  assert.deepEqual(
    resolveStatisticsTitle({
      remoteTitle: '  Новое имя  ',
      routeTitle: 'Имя из маршрута',
      storedTitle: 'Старое имя',
      fallback: 'Чат без названия',
    }),
    { title: 'Новое имя', source: 'remote' },
  );
});

test('statistics title reports fallback separately so it is never persisted', () => {
  assert.deepEqual(
    resolveStatisticsTitle({
      remoteTitle: ' ',
      routeTitle: null,
      storedTitle: '',
      fallback: 'Чат без названия',
    }),
    { title: 'Чат без названия', source: 'fallback' },
  );
});

test('statistics title ignores API placeholders when route or stored identity is meaningful', () => {
  assert.deepEqual(
    resolveStatisticsTitle({
      remoteTitle: '  Канал channel-42  ',
      remoteFallbackTitles: ['Канал channel-42', 'Channel channel-42'],
      routeTitle: 'Новости команды',
      storedTitle: 'Старые новости',
      fallback: 'Канал',
    }),
    { title: 'Новости команды', source: 'route' },
  );
  assert.deepEqual(
    resolveStatisticsTitle({
      remoteTitle: 'Чат без названия',
      routeTitle: null,
      storedTitle: 'Живое имя чата',
      fallback: 'Чат без названия',
    }),
    { title: 'Живое имя чата', source: 'stored' },
  );
});

test('nullable metric stops announcing loading after a terminal unavailable result', () => {
  assert.deepEqual(resolveNullableMetricPresentation(null, true), {
    value: '',
    status: 'loading',
  });
  assert.deepEqual(resolveNullableMetricPresentation(null, false), {
    value: '—',
    status: 'unavailable',
  });
  assert.deepEqual(resolveNullableMetricPresentation(0, false), {
    value: '0',
    status: 'ready',
  });
});
