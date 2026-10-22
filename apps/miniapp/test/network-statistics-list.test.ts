import assert from 'node:assert/strict';
import test from 'node:test';
import { selectNetworkStatisticsItems } from '../src/features/networks/network-statistics-communities';
test('full statistics search reaches later pages and sorting distinguishes zero, negative and missing values', () => {
  const items = Array.from({ length: 503 }, (_, i) => ({
    entityId: String(i),
    title: `Чат ${i}`,
    audience: i,
    audienceObservedAt: null,
    netGrowth: i === 0 ? null : i === 1 ? -4 : 0,
    viewsGained: null,
    viewsCoverage: null,
  }));
  assert.equal(
    selectNetworkStatisticsItems(items, { search: 'Чат 502', sort: 'netGrowth', missing: false })[0]
      .entityId,
    '502',
  );
  const sorted = selectNetworkStatisticsItems(items, {
    search: '',
    sort: 'netGrowth',
    missing: false,
  });
  assert.equal(sorted.at(-1)?.entityId, '0');
  assert.equal(sorted.at(-2)?.entityId, '1');
  assert.deepEqual(
    selectNetworkStatisticsItems(items, { search: '', sort: 'netGrowth', missing: true }).map(
      (row) => row.entityId,
    ),
    ['0'],
  );
  assert.equal(items[0].entityId, '0');
});
