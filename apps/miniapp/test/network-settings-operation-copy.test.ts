import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NetworkSettingsOperationResponse } from '@maxim/contracts/network-settings';
import { NetworkSettingsOperationPanel } from '../src/features/network-settings/network-settings-operation-panel';

function renderFailure(failureMessage: string) {
  const operation: NetworkSettingsOperationResponse = {
    operationId: '00000000-0000-4000-8000-000000000001',
    entityType: 'chat',
    section: 'links',
    status: 'PARTIAL',
    expiresAt: '2026-10-30T00:00:00.000Z',
    outcomes: [
      { entityId: 'chat-a', status: 'FAILED', failureCode: 'INVALID', failureMessage },
      { entityId: 'chat-b', status: 'COMPLETE' },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(NetworkSettingsOperationPanel, {
      operation,
      controller: {
        preview: null,
        canStartAgain: false,
        failedRecipients: [],
        retryChanges: [],
        navigationAllowlist: null,
      },
      recipientTitles: new Map([
        ['chat-a', 'Первый чат'],
        ['chat-b', 'Второй чат'],
      ]),
      onStartAgain: () => undefined,
      onRetry: () => undefined,
    }),
  );
  return { html, operation };
}

test('operation results hide technical failure text without changing the recorded outcome', () => {
  const failureMessage = 'Ошибка API: Prisma SQL payload';
  const { html, operation } = renderFailure(failureMessage);
  assert.match(html, /Не удалось применить настройки\./u);
  assert.doesNotMatch(html, /API|Prisma|SQL|payload/u);
  assert.match(html, /Применена часть изменений/u);
  assert.match(html, /Проверьте параметры/u);
  assert.equal(operation.outcomes[0]?.failureMessage, failureMessage);
  assert.equal(operation.outcomes[0]?.status, 'FAILED');
  assert.equal(operation.outcomes[1]?.status, 'COMPLETE');
});

test('operation results preserve useful Russian guidance', () => {
  const { html } = renderFailure('Настройки изменились. Проверьте новую версию.');
  assert.match(html, /Настройки изменились\. Проверьте новую версию\./u);
});
