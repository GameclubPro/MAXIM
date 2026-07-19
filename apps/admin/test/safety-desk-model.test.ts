import assert from 'node:assert/strict';
import test from 'node:test';
import { safetyDeskQueueResponseSchema } from '@maxim/contracts/safety-desk';
import {
  buildReviewQueueSnapshot,
  createMutationGuard,
  filterReviewItems,
  type MutationLease,
} from '../src/safety-desk-model';

test('builds stable queue snapshots and filters mapped items', () => {
  const response = safetyDeskQueueResponseSchema.parse({
    generatedAt: '2026-07-19T10:00:00.000Z',
    items: [
      {
        id: 'review-1',
        source: 'VK_REVIEW',
        sourceId: 'source-1',
        chatId: 'channel-1',
        entityTitle: 'Канал: Новости',
        sourceTitle: 'Источник',
        author: 'Редактор',
        status: 'REVIEW',
        risk: 'MEDIUM',
        title: 'Важный анонс',
        text: 'Публикация о запуске',
        previewHtml: '<p onclick="bad()">Публикация <strong>о запуске</strong></p>',
        createdAt: '2026-07-19T09:00:00.000Z',
        updatedAt: '2026-07-19T09:00:00.000Z',
      },
      {
        id: 'approved-1',
        source: 'VK_REVIEW',
        sourceId: 'source-2',
        chatId: 'channel-2',
        entityTitle: 'Канал: Архив',
        sourceTitle: 'Архивный источник',
        author: '',
        status: 'APPROVED',
        risk: 'LOW',
        title: 'Старый анонс',
        text: 'Уже опубликовано',
        createdAt: '2026-07-18T09:00:00.000Z',
        updatedAt: '2026-07-18T09:00:00.000Z',
      },
    ],
    summary: { review: 1, approved: 1, rejected: 1, blocked: 2, servicePosts: 4 },
  });

  const snapshot = buildReviewQueueSnapshot(response, 'approved-1');
  assert.equal(snapshot.selectedId, 'approved-1');
  assert.deepEqual(snapshot.metrics, { review: 1, approved: 1, stopped: 3, servicePosts: 4 });
  assert.equal(snapshot.items[0]?.previewHtml, '<p>Публикация <strong>о запуске</strong></p>');
  assert.deepEqual(
    filterReviewItems(snapshot.items, 'review', 'новости').map((item) => item.id),
    ['review-1'],
  );
  assert.deepEqual(filterReviewItems(snapshot.items, 'all', 'нет совпадений'), []);
});

test('prevents duplicate and overlapping mutation leases without partial acquisition', () => {
  const guard = createMutationGuard();
  const first = guard.acquire('review:item-1');
  assert.ok(first);
  assert.equal(guard.acquire('review:item-1'), null);
  assert.equal(guard.isActive('review:item-1'), true);

  assert.equal(guard.acquireMany(['review:item-2', 'review:item-1']), null);
  assert.equal(guard.isActive('review:item-2'), false);

  const forgedLease: MutationLease = { key: first.key, token: Symbol('wrong-owner') };
  assert.equal(guard.release(forgedLease), false);
  assert.equal(guard.isActive(first.key), true);
  assert.equal(guard.release(first), true);

  const bulk = guard.acquireMany(['review:item-1', 'review:item-2', 'review:item-2']);
  assert.ok(bulk);
  assert.equal(bulk.length, 2);
  assert.equal(guard.acquire('review:item-2'), null);
  bulk.forEach((lease) => assert.equal(guard.release(lease), true));
});
