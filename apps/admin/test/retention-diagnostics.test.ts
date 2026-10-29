import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RetentionRuntimeMetrics } from '../src/retention-desk-shell';
import { RetentionProtectionDetails } from '../src/retention-details';
import type { SafetyDeskRetentionPreviewResponse } from '@maxim/contracts/safety-desk';
import type { SafetyDeskRetentionRuntimeResponse } from '@maxim/contracts/safety-desk';
import type { SafetyDeskRetentionRuntimeItem } from '@maxim/contracts/safety-desk';
import {
  retentionCountLabel,
  retentionPageWarning,
  retentionWorkerWarning,
  retentionDiagnosticLabels,
  retentionConnectionErrorLabel,
} from '../src/retention-diagnostics';

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
    ['Результат удаления не подтверждён', 'Нет подтверждения защиты старой истории'],
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
  assert.ok(labels.includes('Результат удаления не подтверждён'));
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

test('protected history and a coverage gap do not claim execution is stopped', () => {
  const labels = retentionDiagnosticLabels({
    ...item,
    coverage: { lastCompletedAt: null, gap: true, protectedHistory: true, executionStopped: false },
  });
  assert.ok(labels.includes('Защищённая часть истории отложена'));
  assert.ok(labels.includes('Полнота обхода не подтверждена'));
  assert.equal(labels.includes('Выполнение очистки недоступно'), false);
  assert.ok(
    retentionDiagnosticLabels({
      ...item,
      coverage: {
        lastCompletedAt: null,
        gap: false,
        protectedHistory: false,
        executionStopped: true,
      },
    }).includes('Выполнение очистки недоступно'),
  );
});

test('bounded and old counts preserve their different completeness', () => {
  assert.equal(retentionCountLabel(201, false), 'не менее 201');
  assert.equal(retentionCountLabel(0, true), '0');
  assert.equal(retentionCountLabel(0, undefined), '0 · полнота неизвестна');
});

test('closed connection reasons remain useful without leaking internal codes', () => {
  assert.equal(
    retentionConnectionErrorLabel('actor_rights_missing'),
    'У инициатора запроса нет прав администратора',
  );
  assert.equal(
    retentionConnectionErrorLabel('connection_check_failed'),
    'Не удалось проверить подключение',
  );
  assert.equal(retentionConnectionErrorLabel(null), null);
});

test('worker failure is a separate visible condition from protected history and old missing health', () => {
  assert.equal(retentionWorkerWarning({ mode: 'on' }), null);
  const worker = {
    healthy: false,
    ready: true,
    running: false,
    sampledAt: null,
    occupiedSlots: 0,
    oldestOccupiedAt: null,
    lastCompletedAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    progressOverdue: false,
  };
  const runtime = {
    mode: 'on' as const,
    health: {
      schedulerLastSuccessfulAt: null,
      schedulerHealthy: false,
      workers: { cleanup: worker, connection: worker },
    },
  };
  assert.equal(retentionWorkerWarning(runtime), 'Исполнитель очистки недоступен.');
  assert.equal(retentionWorkerWarning({ ...runtime, mode: 'off' }), null);
  assert.equal(
    retentionWorkerWarning({
      ...runtime,
      health: {
        ...runtime.health,
        workers: {
          cleanup: { ...worker, running: true, progressOverdue: true },
          connection: worker,
        },
      },
    }),
    'Исполнитель очистки не подтверждает прогресс.',
  );
});

test('a page of unavailable chat identities keeps its size and unknown review count', () => {
  const runtime: SafetyDeskRetentionRuntimeResponse = {
    generatedAt: '2026-10-29T00:00:00.000Z',
    mode: 'on',
    nextAfter: '-999',
    quotas: [],
    items: [],
    incomplete: true,
    unavailableSources: Array.from({ length: 50 }, (_, index) => ({
      chatId: `-${index + 1}`,
      chatTitle: 'Чат',
      source: 'eraser',
      reason: 'unavailable',
    })),
  };
  const html = renderToStaticMarkup(createElement(RetentionRuntimeMetrics, { runtime }));
  assert.ok(html.includes('<span>Чатов на странице</span><strong>50</strong>'));
  assert.ok(html.includes('<span>Проверка (по доступным)</span><strong>—</strong>'));
  assert.ok(html.includes('<span>Без диагностики</span><strong>50</strong>'));
});

test('a complete empty page has confirmed zero while a missing snapshot stays unknown', () => {
  const runtime: SafetyDeskRetentionRuntimeResponse = {
    generatedAt: '2026-10-29T00:00:00.000Z',
    mode: 'on',
    nextAfter: null,
    quotas: [],
    items: [],
    incomplete: false,
    unavailableSources: [],
  };
  const empty = renderToStaticMarkup(createElement(RetentionRuntimeMetrics, { runtime }));
  assert.ok(empty.includes('<span>Нужна проверка</span><strong>0</strong>'));
  const missing = renderToStaticMarkup(createElement(RetentionRuntimeMetrics, { runtime: null }));
  assert.ok(missing.includes('<span>Чатов на странице</span><strong>—</strong>'));
});

test('bounded diagnostics are incomplete without inventing source failure or treating pagination as a failure', () => {
  assert.equal(
    retentionPageWarning({ incomplete: true, unavailableSources: [] }),
    'Диагностика этой страницы неполная.',
  );
  assert.equal(
    retentionPageWarning({
      incomplete: true,
      unavailableSources: [
        { chatId: '-1', chatTitle: 'Чат', source: 'eraser', reason: 'unavailable' },
      ],
    }),
    'Часть источников диагностики недоступна.',
  );
  const anotherPage = { incomplete: false, unavailableSources: [], nextAfter: '-999' };
  assert.equal(retentionPageWarning(anotherPage), null);
  assert.equal(retentionPageWarning({}), 'Полнота диагностики не подтверждена.');
});

test('protection details separate exact import completion from historical coverage and delivery', () => {
  const preview: SafetyDeskRetentionPreviewResponse = {
    chatId: '-1',
    revision: 1,
    activationId: 'a',
    source: 'eraser',
    items: [],
    protection: {
      status: 'available',
      sourceRevision: 2,
      deliveredRevision: 1,
      historicalGapBefore: '2026-10-29T00:00:00.000Z',
      imports: {
        giveawayEntities: true,
        rulesAudit: true,
        giveawayAudit: true,
        legacyHolds: true,
        sourceHolds: true,
      },
      catalog: { ready: true, referencesHashed: 501 },
      deliveredEvidence: null,
      legacyRetirement: {
        scanComplete: true,
        retiredCount: 2,
        reconciliationCount: 1,
        retainedAtScan: 4,
      },
    },
    protectionEvidence: null,
  };
  const html = renderToStaticMarkup(createElement(RetentionProtectionDetails, { preview }));
  assert.match(html, /синхронизация не подтверждена/);
  assert.match(html, /полностью не подтверждена/);
  assert.match(html, /Журнал публикаций розыгрышей/);
  assert.match(html, /а не текущее число неизвестных результатов/);
  assert.doesNotMatch(html, /Подтверждённый интервал:/);
  const unavailable = renderToStaticMarkup(
    createElement(RetentionProtectionDetails, {
      preview: { ...preview, protection: { status: 'unavailable' } },
    }),
  );
  assert.match(unavailable, /Отчёт о защите истории недоступен/);
  assert.doesNotMatch(unavailable, /импорт завершён/);
});
