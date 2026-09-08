import type { VkParsingSettings, VkParsingSource } from '@maxim/contracts/vk-parsing';

export type AutopostStatusTone = 'success' | 'warning' | 'danger' | 'muted';
export type AutopostStatusModel = { title: string; reason: string; tone: AutopostStatusTone };

function timeMinutes(value: string | null): number | null {
  const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/u.exec(value ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function withinRange(now: number, start: string | null, end: string | null): boolean {
  const from = timeMinutes(start);
  const to = timeMinutes(end);
  if (from === null || to === null) return false;
  if (from === to) return true;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export function buildAutopostStatus(
  settings: VkParsingSettings,
  sources: VkParsingSource[],
  now = new Date(),
): AutopostStatusModel {
  if (settings.autoPublishKillSwitchEnabled) {
    return { title: 'На паузе', reason: 'Автопубликация приостановлена', tone: 'muted' };
  }
  if (!settings.autoPublishEnabled) {
    return { title: 'Ручной режим', reason: 'Автопубликация выключена', tone: 'muted' };
  }
  const active = sources.filter((source) => source.status === 'ACTIVE' && source.importEnabled);
  if (!active.length) {
    return { title: 'Нет источников', reason: 'Нет активных источников импорта', tone: 'warning' };
  }
  if (active.every((source) => source.publishMode === 'REVIEW')) {
    return {
      title: 'На проверке',
      reason: 'Все источники требуют ручной публикации',
      tone: 'muted',
    };
  }
  const automatic = active.filter(
    (source) => source.autoPublishEnabled && source.publishMode !== 'REVIEW',
  );
  if (!automatic.length) {
    return {
      title: 'Авто не настроено',
      reason: 'Автопубликация выключена у источников',
      tone: 'warning',
    };
  }

  let minutes: number;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: settings.schedulerTimezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    minutes =
      Number(parts.find((part) => part.type === 'hour')?.value) * 60 +
      Number(parts.find((part) => part.type === 'minute')?.value);
  } catch {
    return {
      title: 'Проверьте время',
      reason: 'Часовой пояс недоступен на устройстве',
      tone: 'warning',
    };
  }
  if (!withinRange(minutes, settings.workHoursStart, settings.workHoursEnd)) {
    return {
      title: 'Ожидает расписания',
      reason: `Рабочее время ${settings.workHoursStart} - ${settings.workHoursEnd}`,
      tone: 'muted',
    };
  }
  if (withinRange(minutes, settings.quietHoursStart, settings.quietHoursEnd)) {
    return {
      title: 'Тихие часы',
      reason: `Пауза ${settings.quietHoursStart} - ${settings.quietHoursEnd}`,
      tone: 'muted',
    };
  }
  const blocked = automatic.filter(
    (source) => source.autoPublishPausedReason === 'circuit_breaker',
  );
  if (blocked.length === automatic.length) {
    return {
      title: 'Сработала защита',
      reason: 'Автопубликация источников приостановлена',
      tone: 'danger',
    };
  }
  const available = automatic.filter(
    (source) =>
      source.autoPublishPausedReason !== 'circuit_breaker' &&
      !withinRange(minutes, source.quietHoursStart, source.quietHoursEnd),
  );
  if (!available.length) {
    return {
      title: 'Источники на паузе',
      reason: 'Тихие часы или защита источников',
      tone: 'warning',
    };
  }
  const errors = automatic.filter(
    (source) => source.syncStatus === 'ERROR' || source.circuitOpenedAt !== null,
  );
  if (errors.length || blocked.length) {
    return {
      title: 'Требует внимания',
      reason: 'У источников есть ошибки или ограничения',
      tone: 'warning',
    };
  }
  return {
    title: 'Авто включено',
    reason: `Источников в рабочем окне: ${available.length} из ${active.length}`,
    tone: 'success',
  };
}
