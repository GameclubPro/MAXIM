import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ManagedAutopostRuleSummary, ManagedBroadcastSummary } from '@maxim/contracts';
import test from 'node:test';
import { formatPublicationDeliveryError } from '../src/features/publications/publication-delivery-error';

const cssHook = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : nextLoad(url, context);
  },
});
const [{ ManagedBroadcastHistoryCard }, { ManagedAutopostRuleCard }] = await Promise.all([
  import('../src/components/managed-broadcast-history-card'),
  import('../src/components/managed-autopost-rule-card'),
]);
cssHook.deregister();

const detailsSheetSource = readFileSync(
  new URL('../src/features/publications/publication-details-sheet.tsx', import.meta.url),
  'utf8',
);

test('keeps concise Russian delivery reasons', () => {
  assert.equal(
    formatPublicationDeliveryError('Администратор подтвердил, что сообщение не было опубликовано.'),
    'Администратор подтвердил, что сообщение не было опубликовано.',
  );
  assert.equal(
    formatPublicationDeliveryError('MAX принял запрос, но ответ не получен.'),
    'MAX принял запрос, но ответ не получен.',
  );
  assert.equal(
    formatPublicationDeliveryError('  Публикация остановлена до отправки.  '),
    'Публикация остановлена до отправки.',
  );
  assert.equal(formatPublicationDeliveryError('   '), null);
});

test('maps known runtime failures without exposing transport details', () => {
  assert.equal(
    formatPublicationDeliveryError('MAX response timeout ETIMEDOUT'),
    'MAX временно не ответил.',
  );
  assert.equal(
    formatPublicationDeliveryError('platform rate limit exceeded: 429'),
    'MAX временно ограничил отправку.',
  );
  assert.equal(
    formatPublicationDeliveryError('403 Forbidden: bot is not an admin'),
    'Нет доступа для отправки.',
  );
  assert.equal(
    formatPublicationDeliveryError('attachment.not.ready during media upload'),
    'Не удалось подготовить медиа.',
  );
});

test('replaces internal, sensitive, and malformed stored errors with a safe fallback', () => {
  const unsafeReasons = [
    'Prisma connection pool timeout for publication abc',
    '{"message":"Внутренняя ошибка","token":"secret"}',
    'Ошибка запроса https://internal.example/api?token=secret',
    'Внутренняя ошибка request_id 6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    'MAX response timeout ETIMEDOUT requestId=secret',
    'Ошибка выполнения\n    at send (/app/src/publication.ts:42:3)',
    'Внутренняя ошибка сервера при доставке на 10.0.0.1',
    'Служебная причина для получателя 123 456 789',
    'Internal delivery failure',
    `Слишком длинная причина ${'безопасный текст '.repeat(20)}`,
  ];

  for (const reason of unsafeReasons) {
    assert.equal(formatPublicationDeliveryError(reason), 'Не удалось доставить публикацию.');
  }
});

test('publication details never renders stored lastError directly', () => {
  assert.match(detailsSheetSource, /formatPublicationDeliveryError\(delivery\.lastError\)/u);
  assert.doesNotMatch(detailsSheetSource, /\{delivery\.lastError\}/u);
});

function renderStoredErrorCards(lastError: string): string[] {
  const shared = {
    id: 'post-1',
    textPreview: 'Новости',
    textLength: 7,
    targetMode: 'current' as const,
    applyToAllChats: false,
    targetChatIds: ['chat-1'],
    targetChats: 1,
    hasImage: false,
    imageCount: 0,
    hasVideo: false,
    buttons: [],
    scheduleTimezone: 'Europe/Moscow',
    scheduledSlots: [],
    nextSendAt: null,
    createdAt: '2026-10-29T10:00:00.000Z',
    updatedAt: '2026-10-29T10:00:00.000Z',
    lastError,
  };
  const broadcast: ManagedBroadcastSummary = {
    ...shared,
    autopostRuleId: null,
    status: 'FAILED',
    targetPreviews: [],
    targetOverflowCount: 0,
    buttonEnabled: false,
    scheduleMode: 'legacy',
    cycleEnabled: false,
    cycleEveryHours: 1,
    cycleCount: 1,
    sentCount: 0,
    currentOccurrence: 1,
    deliveredChats: 0,
    failedChats: 1,
    pendingChats: 0,
    blockedChats: 0,
    failureBreakdown: { transient: 0, permanentTarget: 0, quarantined: 0, unknown: 1 },
    canRetry: false,
    remainingCount: 0,
  };
  const rule: ManagedAutopostRuleSummary = {
    ...shared,
    sourceChatId: 'chat-1',
    entityType: 'chat',
    status: 'ERROR',
    title: 'Новости',
    materializedCount: 0,
    revision: 1,
  };
  const noop = () => undefined;
  return [
    renderToStaticMarkup(
      createElement(ManagedBroadcastHistoryCard, {
        broadcast,
        tone: 'danger',
        badge: 'Ошибка',
        title: 'Новости',
        metric: { label: 'Состояние', value: 'Ошибка', caption: '', tone: 'danger' },
        facts: [],
        canEdit: false,
        canCancel: false,
        isBusy: false,
        isDeleting: false,
        isRetrying: false,
        onEdit: noop,
        onRetry: noop,
        onDelete: noop,
      }),
    ),
    renderToStaticMarkup(
      createElement(ManagedAutopostRuleCard, {
        rule,
        nextLabel: '',
        facts: [],
        onPause: noop,
        onDelete: noop,
      }),
    ),
  ];
}

function assertStoredErrorTextAndTooltip(html: string, expected: string) {
  const error = html.match(
    /<small class="managed-broadcast-card__error" title="([^"]+)">([^<]*)<\/small>/u,
  );
  assert.ok(error, 'The card must show a reason with a tooltip');
  assert.deepEqual(error.slice(1), [expected, expected]);
}

test('broadcast history and recurring posts hide technical stored errors in text and tooltips', () => {
  const unsafe = 'MAXIM_EXECUTION_OWNER: Внутренняя ошибка worker';
  for (const html of renderStoredErrorCards(unsafe)) {
    assertStoredErrorTextAndTooltip(html, 'Не удалось выполнить отправку.');
    assert.doesNotMatch(html, /MAXIM_EXECUTION_OWNER|worker/u);
  }
});

test('broadcast history and recurring posts preserve concise Russian error reasons', () => {
  const reason = 'MAX временно недоступен.';
  for (const html of renderStoredErrorCards(reason)) {
    assertStoredErrorTextAndTooltip(html, reason);
  }
});
