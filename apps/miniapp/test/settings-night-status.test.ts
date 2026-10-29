import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  chatSettingsSchema,
  type ChatClosureStatus,
  type NightModeNoticeObservation,
} from '@maxim/contracts/settings';
import SettingsChatClosureStatus from '../src/pages/settings/settings-chat-closure-status';
import {
  getNightTimezoneOptions,
  RUSSIAN_TIMEZONE_OPTIONS,
} from '../src/pages/settings/settings-timezones';
import { getNightStatusRefreshDelay } from '../src/pages/settings/use-settings-screen-query';
import { createPreviewOpenChatClosure } from '../src/lib/api/preview-chat-closure';

function observation(scheduledFor: string): NightModeNoticeObservation {
  return {
    enabledNow: true,
    latest: {
      sessionKey: scheduledFor,
      scheduledFor,
      catchUp: { state: 'expired', endsAt: scheduledFor },
      scheduling: 'recorded',
      delivery: { outcome: 'sent', reason: 'successful_receipt', sentAt: scheduledFor },
    },
  };
}
function status(): ChatClosureStatus {
  return {
    observedAt: '2026-10-30T12:00:00.000Z',
    scheduleEnabled: true,
    restriction: 'open',
    timezone: 'Europe/Moscow',
    opensAt: null,
    deleteRoute: 'available',
    notice: 'delivered',
    recovery: 'idle',
    notices: {
      expectationBasis: 'current_schedule',
      boundary: 'daily',
      evidenceScope: 'exact_send_ledger',
      sendRouteNow: 'available',
      close: observation('2026-10-29T19:00:00.000Z'),
      open: observation('2026-10-30T04:00:00.000Z'),
      recovery: { scope: 'latest_occurrences', observation: 'complete', obligations: [] },
    },
  };
}
function render(value: ChatClosureStatus, refreshFailed = false) {
  return renderToStaticMarkup(
    createElement(SettingsChatClosureStatus, { status: value, refreshFailed }),
  );
}
test('CLOSE and OPEN receipts retain their own dates when current schedule, switches and access are off', () => {
  const value = status();
  value.scheduleEnabled = false;
  value.notices!.sendRouteNow = 'unavailable';
  value.notices!.close.enabledNow = false;
  value.notices!.open.enabledNow = false;
  const html = render(value);
  assert.match(html, /Уведомление о закрытии/);
  assert.match(html, /Уведомление об открытии/);
  assert.match(html, /29 октября.*22:00/);
  assert.match(html, /30 октября.*07:00/);
  assert.equal((html.match(/data-outcome="sent"/gu) ?? []).length, 2);
  assert.match(html, /расписание сейчас выключено/);
  assert.match(html, /Отправка сейчас недоступна/);
  assert.doesNotMatch(html, /Время для отложенной отправки истекло/);
});
test('missing expired evidence and an ambiguous outcome do not claim a proven failed send', () => {
  const value = status();
  value.notices!.close.latest!.delivery = {
    outcome: 'not_recorded',
    reason: 'ledger_missing',
    sentAt: null,
  };
  value.notices!.open.latest!.delivery = { outcome: 'unknown', reason: 'ambiguous', sentAt: null };
  const html = render(value);
  assert.match(html, /Нет подтверждения отправки/);
  assert.match(html, /Результат отправки неизвестен/);
  assert.match(html, /Время для отложенной отправки истекло/);
  assert.doesNotMatch(html, /Не отправлено — ошибка до отправки|Отправлено ·/);
});
test('a certified pre-dispatch failure is distinct from pending and ambiguous outcomes', () => {
  const value = status();
  value.notices!.close.latest!.delivery = {
    outcome: 'not_sent',
    reason: 'proven_pre_dispatch_failure',
    sentAt: null,
  };
  value.notices!.open.latest!.delivery = {
    outcome: 'pending',
    reason: 'awaiting_first_attempt',
    sentAt: null,
  };
  value.notices!.open.latest!.catchUp.state = 'within_window';
  const html = render(value);
  assert.match(html, /Не отправлено — ошибка до отправки/);
  assert.match(html, /Ожидает первой попытки/);
  assert.doesNotMatch(html, /Результат отправки неизвестен/);
});
test('cleanup recovery does not overwrite a successful OPEN receipt; delayed and action-required differ', () => {
  const value = status();
  value.recovery = 'delayed';
  assert.match(render(value), /Восстановление задерживается/);
  value.recovery = 'action_required';
  value.notices!.recovery.obligations = [
    {
      kind: 'close_notice_cleanup',
      sessionKey: 'close',
      scheduledFor: value.observedAt,
      state: 'action_required',
    },
  ];
  const html = render(value);
  assert.match(html, /Нужна проверка удаления прежнего сообщения о закрытии/);
  assert.equal((html.match(/data-outcome="sent"/gu) ?? []).length, 2);
  assert.doesNotMatch(html, /Восстановление задерживается|восстановления уведомления об открытии/);
});
test('continuous schedules do not invent daily sends, and old payloads do not invent OPEN evidence', () => {
  const value = status();
  value.notices!.boundary = 'continuous';
  value.notices!.close.latest = null;
  value.notices!.open.latest = null;
  const html = render(value);
  assert.match(html, /время начала и окончания совпадает/);
  assert.equal((html.match(/нет ежедневного перехода/gu) ?? []).length, 2);
  assert.doesNotMatch(html, /data-outcome/);
  delete value.notices;
  assert.match(render(value), /Уведомление о закрытии: доставлено/);
  assert.match(render(value), /Данные об уведомлении об открытии пока недоступны/);
});
test('failed refresh marks retained data as old while retaining proven historical receipts', () => {
  const html = render(status(), true);
  assert.match(html, /Не удалось обновить статус/);
  assert.match(html, /На момент проверки/);
  assert.doesNotMatch(html, /Сейчас группа открыта/);
  assert.equal((html.match(/data-outcome="sent"/gu) ?? []).length, 2);
});
test('saved international timezones remain selectable and never receive Moscow labels', () => {
  for (const timezone of ['Europe/Berlin', 'America/New_York']) {
    const options = getNightTimezoneOptions(timezone);
    assert.equal(options[0].value, timezone);
    assert.doesNotMatch(options[0].label, /Москва|Московское/);
    const value = status();
    value.timezone = timezone;
    assert.doesNotMatch(render(value), /Московское время/);
  }
  assert.equal(getNightTimezoneOptions('Europe/Moscow'), RUSSIAN_TIMEZONE_OPTIONS);
});
test('refresh delay follows the saved next boundary and bounds stale or distant refreshes', () => {
  const now = Date.parse('2026-10-30T12:00:00.000Z');
  assert.equal(getNightStatusRefreshDelay('2026-10-30T12:00:10.000Z', now), 10_250);
  assert.equal(getNightStatusRefreshDelay('2026-10-30T12:00:00.100Z', now), 1_000);
  for (const boundary of [
    null,
    undefined,
    'invalid',
    '2026-10-29T12:00:00.000Z',
    '2026-10-31T12:00:00.000Z',
  ]) {
    assert.equal(getNightStatusRefreshDelay(boundary, now), 60_000);
  }
});
test('preview exposes independent switches with no fabricated historical sends', () => {
  const preview = createPreviewOpenChatClosure(
    chatSettingsSchema.parse({
      nightModeBotMessageEnabled: true,
      nightModeOpenMessageEnabled: false,
    }),
    new Date('2026-10-30T12:00:00.000Z'),
  );
  assert.equal(preview.notices?.close.enabledNow, true);
  assert.equal(preview.notices?.open.enabledNow, false);
  assert.equal(preview.notices?.close.latest, null);
  assert.equal(preview.notices?.open.latest, null);
});
