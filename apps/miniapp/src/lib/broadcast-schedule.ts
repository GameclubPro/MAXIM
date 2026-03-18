export const BROADCAST_SCHEDULE_MAX_DAYS = 31;
export const BROADCAST_SCHEDULE_STEP_MINUTES = 30;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function resolveBroadcastScheduleTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
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
