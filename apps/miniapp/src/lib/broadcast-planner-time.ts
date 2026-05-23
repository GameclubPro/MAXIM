import {
  BROADCAST_SCHEDULE_STEP_MINUTES,
  buildBroadcastScheduleSlotIso,
  getBroadcastScheduleDayKey,
  sortAndUniqueBroadcastSlots,
} from './broadcast-schedule';

export type BroadcastPlannerSlotGroup = {
  label: string;
  start: number;
  end: number;
};

export type BroadcastFreeWindow = {
  id: string;
  label: string;
  startMinutes: number;
  endMinutes: number;
};

export const BROADCAST_PLANNER_SLOT_GROUPS: BroadcastPlannerSlotGroup[] = [
  { label: 'Ночь', start: 0, end: 6 * 60 },
  { label: 'Утро', start: 6 * 60, end: 12 * 60 },
  { label: 'День', start: 12 * 60, end: 18 * 60 },
  { label: 'Вечер', start: 18 * 60, end: 24 * 60 },
];

export const BROADCAST_PLANNER_NOW_REFRESH_MS = 30_000;

const FREE_WINDOW_START_MINUTES = 8 * 60;
const FREE_WINDOW_END_MINUTES = 22 * 60;

export function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1_000);
}

export function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 0, 0, 0, 0);
}

function startOfMonth(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1, 0, 0, 0, 0);
}

export function endOfMonth(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth() + 1, 0, 23, 59, 59, 999);
}

export function getMonthKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
}

function parseMonthKey(value: string): Date {
  const [yearRaw, monthRaw] = value.split('-');
  const year = Number.parseInt(yearRaw ?? '', 10);
  const month = Number.parseInt(monthRaw ?? '', 10);
  return new Date(year, Math.max(0, month - 1), 1, 0, 0, 0, 0);
}

export function formatMonthKey(value: string): string {
  const date = parseMonthKey(value);
  return new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
  }).format(date);
}

export function formatDayChipLabel(dayKey: string): string {
  const date = new Date(`${dayKey}T12:00:00`);
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
  }).format(date);
}

export function formatCountLabel(
  count: number,
  singular: string,
  few: string,
  plural: string,
): string {
  const remainder10 = count % 10;
  const remainder100 = count % 100;

  if (remainder10 === 1 && remainder100 !== 11) {
    return `${count} ${singular}`;
  }

  if (remainder10 >= 2 && remainder10 <= 4 && (remainder100 < 12 || remainder100 > 14)) {
    return `${count} ${few}`;
  }

  return `${count} ${plural}`;
}

export function formatAgendaTime(slot: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(slot));
}

export function getMonthKeys(windowStart: Date, windowEnd: Date): string[] {
  const keys: string[] = [];
  const cursor = startOfMonth(windowStart);
  const lastMonth = startOfMonth(windowEnd);

  while (cursor.getTime() <= lastMonth.getTime()) {
    keys.push(getMonthKey(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return keys;
}

export function getMonthCells(monthKey: string): Date[] {
  const monthStart = parseMonthKey(monthKey);
  const gridStart = addDays(monthStart, -((monthStart.getDay() + 6) % 7));
  const cells: Date[] = [];
  for (let index = 0; index < 42; index += 1) {
    cells.push(addDays(gridStart, index));
  }
  return cells;
}

export function getMinutesList(group: BroadcastPlannerSlotGroup): number[] {
  const values: number[] = [];
  for (let minute = group.start; minute < group.end; minute += BROADCAST_SCHEDULE_STEP_MINUTES) {
    values.push(minute);
  }
  return values;
}

export function formatMinuteLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function snapMinutesToStep(minutes: number): number {
  return Math.ceil(minutes / BROADCAST_SCHEDULE_STEP_MINUTES) * BROADCAST_SCHEDULE_STEP_MINUTES;
}

export function getSelectedDaySlots(dayKey: string, slots: string[]): string[] {
  return slots.filter((slot) => getBroadcastScheduleDayKey(slot) === dayKey);
}

export function sortDayKeys(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

export function formatDaySummary(dayKeys: string[]): string {
  const labels = sortDayKeys(dayKeys).map((dayKey) => formatDayChipLabel(dayKey));
  if (labels.length <= 2) {
    return labels.join(', ');
  }

  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`;
}

export function formatDayDensityLabel(slotCount: number): string {
  if (slotCount <= 0) {
    return '';
  }

  if (slotCount >= 4) {
    return '4+';
  }

  return String(slotCount);
}

export function getSuggestedMinutes(dayKey: string, minimumTimeMs: number): number[] {
  const minimumDate = new Date(minimumTimeMs);
  const minimumDayKey = getBroadcastScheduleDayKey(minimumDate);
  const minimumMinutes = snapMinutesToStep(minimumDate.getHours() * 60 + minimumDate.getMinutes());
  const baseCandidates =
    dayKey === minimumDayKey
      ? [minimumMinutes, minimumMinutes + 60, 18 * 60, 21 * 60]
      : [9 * 60, 13 * 60, 18 * 60, 21 * 60];
  const fallbackStart =
    dayKey === minimumDayKey ? Math.max(FREE_WINDOW_START_MINUTES, minimumMinutes) : 9 * 60;
  const fallbackCandidates: number[] = [];

  for (
    let minute = fallbackStart;
    minute < FREE_WINDOW_END_MINUTES;
    minute += BROADCAST_SCHEDULE_STEP_MINUTES
  ) {
    fallbackCandidates.push(minute);
  }

  return Array.from(
    new Set(
      [...baseCandidates, ...fallbackCandidates].filter((minutes) => {
        if (minutes < 0 || minutes >= 24 * 60) {
          return false;
        }

        return (
          buildBroadcastScheduleSlotIso(dayKey, minutes).localeCompare(minimumDate.toISOString()) >=
          0
        );
      }),
    ),
  ).slice(0, 4);
}

function getSlotMinutes(slot: string): number | null {
  const date = new Date(slot);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  return date.getHours() * 60 + date.getMinutes();
}

export function buildFreeWindowsForDay(slots: readonly string[]): BroadcastFreeWindow[] {
  const minutes = Array.from(
    new Set(
      slots.map((slot) => getSlotMinutes(slot)).filter((value): value is number => value !== null),
    ),
  ).sort((left, right) => left - right);
  if (minutes.length === 0) {
    return [];
  }

  const windows: BroadcastFreeWindow[] = [];

  function pushWindow(startMinutes: number, endMinutes: number) {
    const normalizedStart = Math.max(FREE_WINDOW_START_MINUTES, startMinutes);
    const normalizedEnd = Math.min(FREE_WINDOW_END_MINUTES, endMinutes);
    if (normalizedEnd - normalizedStart < BROADCAST_SCHEDULE_STEP_MINUTES) {
      return;
    }

    windows.push({
      id: `${normalizedStart}-${normalizedEnd}`,
      label: `${formatMinuteLabel(normalizedStart)}-${formatMinuteLabel(normalizedEnd)}`,
      startMinutes: normalizedStart,
      endMinutes: normalizedEnd,
    });
  }

  pushWindow(FREE_WINDOW_START_MINUTES, minutes[0]);

  for (let index = 0; index < minutes.length - 1; index += 1) {
    const startMinutes = minutes[index] + BROADCAST_SCHEDULE_STEP_MINUTES;
    const endMinutes = minutes[index + 1];
    pushWindow(startMinutes, endMinutes);
  }

  pushWindow(
    minutes[minutes.length - 1] + BROADCAST_SCHEDULE_STEP_MINUTES,
    FREE_WINDOW_END_MINUTES,
  );

  return windows.slice(0, 5);
}

export function buildSlotsByDay(slots: readonly string[]): Map<string, string[]> {
  const slotsByDay = new Map<string, string[]>();
  for (const slot of sortAndUniqueBroadcastSlots([...slots])) {
    const dayKey = getBroadcastScheduleDayKey(slot);
    const current = slotsByDay.get(dayKey) ?? [];
    current.push(slot);
    slotsByDay.set(dayKey, current);
  }
  return slotsByDay;
}
