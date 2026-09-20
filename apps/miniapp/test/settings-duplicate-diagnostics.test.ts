import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IsRestoringProvider, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { chatSettingsSchema, duplicateDiagnosticsResponseSchema } from '@maxim/contracts/settings';
import SettingsDuplicateDiagnostics from '../src/pages/settings/settings-duplicate-diagnostics';
import { formatDuplicateAllowanceLabel } from '../src/pages/settings/settings-duplicate-flow';
import { formatDuplicateSettingsSummary } from '../src/pages/settings/settings-duplicate-photo-status';
import type { ApiTransport } from '../src/lib/api/transport';

const time = '2026-09-14T12:00:00.000Z';
test('settings summary uses the same message numbering as the controls and keeps disabled state explicit', () => {
  const settings = chatSettingsSchema.parse({
    antiDuplicateEnabled: true,
    duplicateBotMessageEnabled: false,
    duplicateWarnEnabled: true,
    duplicateWarnMaxCount: 2,
    duplicateMuteEnabled: false,
    duplicateBanEnabled: false,
  });
  assert.equal(
    formatDuplicateSettingsSummary(settings, 12),
    'удаление с сообщения №3 • 12 ч • картинки',
  );
  assert.equal(formatDuplicateSettingsSummary(null, 12), 'Выключено');
});
function render(
  state: 'CONFIRMED' | 'MISSING' | 'UNKNOWN',
  options = { available: true, limited: false, failed: false },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = ['duplicate-diagnostics', 'user', 'chat'];
  client.setQueryData(
    key,
    duplicateDiagnosticsResponseSchema.parse({
      generatedAt: time,
      enabled: true,
      mode: 'FULL',
      capability: { state, checkedAt: time },
      history: {
        available: options.available,
        since: time,
        sampledIntents: 0,
        limited: options.limited,
        attempts: [],
      },
    }),
  );
  if (options.failed)
    client
      .getQueryCache()
      .find({ queryKey: key })!
      .setState({ status: 'error', error: new Error('offline') });
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        IsRestoringProvider,
        { value: true },
        createElement(SettingsDuplicateDiagnostics, {
          api: {} as ApiTransport,
          chatId: 'chat',
          userId: 'user',
        }),
      ),
    ),
  );
  client.clear();
  return html;
}
test('message numbering presents the stored allowance without changing its meaning', () => {
  assert.equal(formatDuplicateAllowanceLabel(0), 'удаление с сообщения №2');
  assert.equal(formatDuplicateAllowanceLabel(1), 'удаление с сообщения №3');
  assert.equal(formatDuplicateAllowanceLabel(19), 'удаление с сообщения №21');
});
test('permission state is distinct from the enabled setting', () => {
  assert.match(render('CONFIRMED'), /Права удаления подтверждены/);
  const missing = render('MISSING');
  assert.match(missing, /Нет прав удаления/);
  assert.match(missing, /Сохранённая настройка/);
  assert.match(missing, /Включён/);
  assert.match(render('UNKNOWN'), /Права удаления не подтверждены/);
});
test('refresh errors never reuse the old confirmed badge', () => {
  const html = render('CONFIRMED', { available: true, limited: false, failed: true });
  assert.doesNotMatch(html, />Права удаления подтверждены</);
  assert.match(html, /Не удалось обновить проверку/);
});
test('unknown and capped history do not claim there were no attempts', () => {
  const unavailable = render('UNKNOWN', { available: false, limited: false, failed: false });
  assert.match(unavailable, /История временно недоступна/);
  assert.doesNotMatch(unavailable, /Попыток удаления не было/);
  const partial = render('CONFIRMED', { available: true, limited: true, failed: false });
  assert.match(partial, /Неполная выборка/);
  assert.doesNotMatch(partial, /Попыток удаления не было/);
});
