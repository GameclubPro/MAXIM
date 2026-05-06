export const BROADCAST_SCHEDULE_MAX_DAYS = 31;
export const BROADCAST_SCHEDULE_STEP_MINUTES = 30;
export const BROADCAST_QUICK_PRESETS = ['now', 'plus30', 'tonight', 'tomorrow'] as const;

export type BroadcastQuickPreset = (typeof BROADCAST_QUICK_PRESETS)[number];

export type BroadcastQuickScheduleSelection = {
  preset: BroadcastQuickPreset;
  label: string;
  summary: string;
  sendAt: string | null;
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function resolveBroadcastScheduleTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60 * 1_000);
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1_000);
}

function formatQuickSummary(date: Date, nowMs: number): string {
  const now = new Date(nowMs);
  const todayKey = getBroadcastScheduleDayKey(now);
  const tomorrowKey = getBroadcastScheduleDayKey(addDays(now, 1));
  const targetKey = getBroadcastScheduleDayKey(date);
  const timeLabel = new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);

  if (targetKey === todayKey) {
    return timeLabel;
  }

  if (targetKey === tomorrowKey) {
    return `Завтра ${timeLabel}`;
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function resolveBroadcastQuickScheduleSelection(
  preset: BroadcastQuickPreset,
  nowMs = Date.now(),
): BroadcastQuickScheduleSelection {
  if (preset === 'now') {
    return {
      preset,
      label: 'Сейчас',
      summary: 'сразу',
      sendAt: null,
    };
  }

  const minimumDate = new Date(nowMs + 30_000);
  let scheduledAt: Date;
  let label: string;

  switch (preset) {
    case 'plus30':
      label = '+30 мин';
      scheduledAt = addMinutes(new Date(nowMs), 30);
      break;
    case 'tonight': {
      label = 'Вечером';
      const candidate = new Date(nowMs);
      candidate.setHours(20, 0, 0, 0);
      if (candidate.getTime() < minimumDate.getTime()) {
        candidate.setDate(candidate.getDate() + 1);
      }
      scheduledAt = candidate;
      break;
    }
    case 'tomorrow': {
      label = 'Завтра';
      const candidate = addDays(new Date(nowMs), 1);
      candidate.setHours(9, 0, 0, 0);
      scheduledAt =
        candidate.getTime() < minimumDate.getTime() ? addMinutes(minimumDate, 30) : candidate;
      break;
    }
  }

  return {
    preset,
    label,
    summary: formatQuickSummary(scheduledAt, nowMs),
    sendAt: scheduledAt.toISOString(),
  };
}

export function sortAndUniqueBroadcastSlots(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

export function getBroadcastScheduleDayKey(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function buildBroadcastScheduleSlotIso(
  dayKey: string,
  minutesFromStartOfDay: number,
): string {
  const [yearRaw, monthRaw, dayRaw] = dayKey.split('-');
  const year = Number.parseInt(yearRaw ?? '', 10);
  const month = Number.parseInt(monthRaw ?? '', 10);
  const day = Number.parseInt(dayRaw ?? '', 10);
  const hours = Math.floor(minutesFromStartOfDay / 60);
  const minutes = minutesFromStartOfDay % 60;
  const date = new Date(year, Math.max(0, month - 1), day, hours, minutes, 0, 0);
  return date.toISOString();
}

export function formatBroadcastScheduleSlot(
  value: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    ...options,
  }).format(date);
}

export function formatBroadcastScheduleDay(dayKey: string): string {
  const [yearRaw, monthRaw, dayRaw] = dayKey.split('-');
  const year = Number.parseInt(yearRaw ?? '', 10);
  const month = Number.parseInt(monthRaw ?? '', 10);
  const day = Number.parseInt(dayRaw ?? '', 10);
  const date = new Date(year, Math.max(0, month - 1), day, 12, 0, 0, 0);
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  }).format(date);
}

export function countBroadcastScheduleDays(values: string[]): number {
  return new Set(values.map((value) => getBroadcastScheduleDayKey(value))).size;
}

export function formatBroadcastScheduleSummary(values: string[]): string {
  const slots = sortAndUniqueBroadcastSlots(values);
  if (slots.length === 0) {
    return 'слоты не выбраны';
  }

  const first = formatBroadcastScheduleSlot(slots[0]);
  const extraCount = slots.length - 1;
  return extraCount > 0 ? `${first} · +${extraCount}` : first;
}
