import assert from 'node:assert/strict';
import test from 'node:test';
import type { SafetyDeskRetentionRuntimeItem } from '@maxim/contracts/safety-desk';
import { retentionDiagnosticLabels } from '../src/retention-diagnostics';

const item = {
  hasTerminalReview: false,
  hasUnresolvedReceipt: false,
  connectionStatus: 'connected',
  historyStatus: 'blocked',
  diagnostics: {
    lastError: null,
    historyBoundaryBlocked: false,
    awaitingCurrentProtection: false,
    awaitingHistoricalProtection: false,
  },
} satisfies Pick<
  SafetyDeskRetentionRuntimeItem,
  | 'hasTerminalReview'
  | 'hasUnresolvedReceipt'
  | 'connectionStatus'
  | 'historyStatus'
  | 'diagnostics'
>;

test('historical protection and uncertain deletion remain separate visible states', () => {
  assert.deepEqual(
    retentionDiagnosticLabels({
      ...item,
      hasUnresolvedReceipt: true,
      diagnostics: { ...item.diagnostics, awaitingHistoricalProtection: true },
    }),
    ['Проверяется результат MAX', 'Нет подтверждения защиты старой истории'],
  );
});

test('current protection and the unsafe history boundary have distinct explanations', () => {
  assert.deepEqual(
    retentionDiagnosticLabels({
      ...item,
      diagnostics: {
        ...item.diagnostics,
        historyBoundaryBlocked: true,
        awaitingCurrentProtection: true,
      },
    }),
    ['История: граница обхода не подтверждена', 'Нет подтверждения защиты новых сообщений'],
  );
});

test('older runtime keeps the blocked history label without claiming a reason', () => {
  assert.deepEqual(retentionDiagnosticLabels({ ...item, diagnostics: undefined }), [
    'История: часть истории отложена',
  ]);
});

test('a known MAX error is explained without implying successful deletion', () => {
  const labels = retentionDiagnosticLabels({
    ...item,
    hasTerminalReview: true,
    hasUnresolvedReceipt: true,
    diagnostics: { ...item.diagnostics, lastError: 'delete_unconfirmed' },
  });
  assert.ok(labels.includes('Нужна проверка'));
  assert.ok(labels.includes('Проверяется результат MAX'));
  assert.ok(labels.includes('MAX не подтвердил результат удаления'));
  assert.equal(
    labels.some((label) => label.includes('delete_unconfirmed')),
    false,
  );
});

test('missing access stays visible without repeating the same connection problem', () => {
  assert.deepEqual(
    retentionDiagnosticLabels({
      ...item,
      connectionStatus: 'no_access',
      diagnostics: { ...item.diagnostics, lastError: 'eraser_rights_missing' },
    }),
    ['«Ластику» нужны права', 'История: часть истории отложена'],
  );
});

test('unknown errors never become a healthy status or an internal code', () => {
  assert.deepEqual(
    retentionDiagnosticLabels({
      ...item,
      diagnostics: { ...item.diagnostics, lastError: 'unknown' },
    }),
    ['История: часть истории отложена', 'Причина последней ошибки не распознана'],
  );
});
