import assert from 'node:assert/strict';
import test from 'node:test';
import { reportDetailSchema, reportSummarySchema } from '@maxim/contracts/settings';
import {
  mergeReportPages,
  newestReport,
  reportDetailsMatch,
} from '../src/pages/settings/report-journal-model';
const summary = reportSummarySchema.parse({
  id: 'case',
  messageId: 'message',
  authorId: 'author',
  status: 'COLLECTING',
  votes: 2,
  threshold: 3,
  deleteMode: 'MESSAGE',
  muteHours: null,
  muteApplied: false,
  candidates: 0,
  deleted: 0,
  pending: 0,
  failed: 0,
  createdAt: '2026-10-01T08:00:00.000Z',
  expiresAt: '2026-10-02T08:00:00.000Z',
  lastError: null,
  updatedAt: '2026-10-01T09:00:00.000Z',
  contentVersion: 1,
  snapshotVersion: 'collecting',
});
test('a late response cannot restore a revoked dismissal or older content version', () => {
  const closed = {
    ...summary,
    status: 'DISMISSED' as const,
    updatedAt: '2026-10-01T10:00:00.000Z',
    observedAt: '2026-10-01T10:00:01.000Z',
    snapshotVersion: 'dismissed',
  };
  assert.equal(
    newestReport(closed, { ...summary, observedAt: '2026-10-01T10:00:02.000Z' }),
    closed,
  );
  const reopened = { ...summary, contentVersion: 2, updatedAt: '2026-10-01T11:00:00.000Z' };
  assert.equal(newestReport(reopened, closed), reopened);
});
test('independent receipt changes use observed snapshots when state timestamp ties', () => {
  const old = { ...summary, observedAt: '2026-10-01T10:00:00.000Z' };
  const receipt = {
    ...summary,
    deleted: 1,
    observedAt: '2026-10-01T10:00:01.000Z',
    snapshotVersion: 'receipt',
  };
  assert.equal(newestReport(old, receipt), receipt);
  assert.equal(
    reportDetailsMatch(receipt, reportDetailSchema.parse({ ...old, reporters: [] })),
    false,
  );
});
test('older loaded pages cannot overwrite fresh head rows and are deduplicated', () => {
  const rows = mergeReportPages([
    {
      items: [{ ...summary, status: 'COMPLETED', updatedAt: '2026-10-01T10:00:00.000Z' }],
      nextCursor: null,
      observedAt: '2026-10-01T10:00:01.000Z',
    },
    { items: [summary], nextCursor: null, observedAt: '2026-10-01T09:00:01.000Z' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'COMPLETED');
});
