import {
  BROADCAST_SCHEDULE_MAX_DAYS,
  BROADCAST_SCHEDULE_STEP_MINUTES,
  buildBroadcastScheduleSlotIso,
  getBroadcastSlotInstantKey,
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

export type BroadcastQuickScheduleSlot = {
  slot: string;
  label: string;
};

export type BroadcastSmartScheduleTemplate = {
  id: string;
  label: string;
  meta: string;
  slots: string[];
};

export type BroadcastDayPresetId = 'five-days' | 'workdays' | 'seven-days';

export type BroadcastDayPreset = {
  id: BroadcastDayPresetId;
  label: string;
  count: number;
  weekdayMode: 'any' | 'workdays';
};

type BroadcastScheduleTemplateBlueprint = {
  id: string;
  label: string;
  count: number;
  minutes: number;
  weekdayMode: 'any' | 'workdays';
};

type BroadcastSmartScheduleOptions = {
  nowMs: number;
  minimumTimeMs?: number;
  occupiedSlots?: readonly string[];
  maxDays?: number;
  limit?: number;
};

type BroadcastDayPresetOptions = {
  nowMs: number;
  maxDays?: number;
};

type BroadcastDailySlotsOptions = {
  dayKeys: readonly string[];
  minutes: readonly number[];
  minimumTimeMs?: number;
};

export const BROADCAST_PLANNER_SLOT_GROUPS: BroadcastPlannerSlotGroup[] = [
  { label: 'Ночь', start: 0, end: 6 * 60 },
  { label: 'Утро', start: 6 * 60, end: 12 * 60 },
  { label: 'День', start: 12 * 60, end: 18 * 60 },
  { label: 'Вечер', start: 18 * 60, end: 24 * 60 },
];

export const BROADCAST_PLANNER_NOW_REFRESH_MS = 30_000;
export const BROADCAST_DAY_PRESETS: BroadcastDayPreset[] = [
  { id: 'five-days', label: '5 дней', count: 5, weekdayMode: 'any' },
  { id: 'workdays', label: 'Будни', count: 5, weekdayMode: 'workdays' },
  { id: 'seven-days', label: '7 дней', count: 7, weekdayMode: 'any' },
];

const FREE_WINDOW_START_MINUTES = 8 * 60;
const FREE_WINDOW_END_MINUTES = 22 * 60;
const QUICK_SCHEDULE_SLOT_LIMIT = 3;
const SMART_SCHEDULE_TEMPLATE_BLUEPRINTS: BroadcastScheduleTemplateBlueprint[] = [
  { id: 'prime-3', label: 'Прайм', count: 3, minutes: 18 * 60, weekdayMode: 'any' },
  { id: 'workdays-5', label: 'Будни', count: 5, minutes: 9 * 60, weekdayMode: 'workdays' },
  { id: 'daily-7', label: '7 дней', count: 7, minutes: 13 * 60, weekdayMode: 'any' },
];

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

export function getBroadcastPlannerWindow(now = new Date()): { start: Date; end: Date } {
  return {
    start: startOfDay(now),
    end: endOfMonth(addDays(now, BROADCAST_SCHEDULE_MAX_DAYS - 1)),
  };
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

export function getBroadcastPlannerKeyboardNavigationDayKey(
  dayKey: string,
  key: string,
  windowStart: Date,
  windowEnd: Date,
): string | null {
  const currentDate = new Date(`${dayKey}T12:00:00`);
  if (!Number.isFinite(currentDate.getTime())) {
    return null;
  }

  let offsetDays: number | null = null;
  switch (key) {
    case 'ArrowLeft':
      offsetDays = -1;
      break;
    case 'ArrowRight':
      offsetDays = 1;
      break;
    case 'ArrowUp':
      offsetDays = -7;
      break;
    case 'ArrowDown':
      offsetDays = 7;
      break;
    case 'Home':
      offsetDays = -((currentDate.getDay() + 6) % 7);
      break;
    case 'End':
      offsetDays = 6 - ((currentDate.getDay() + 6) % 7);
      break;
    default:
      return null;
  }

  const targetDayKey = getBroadcastScheduleDayKey(addDays(currentDate, offsetDays));
  const targetTime = startOfDay(new Date(`${targetDayKey}T12:00:00`)).getTime();
  if (
    !Number.isFinite(targetTime) ||
    targetTime < startOfDay(windowStart).getTime() ||
    targetTime > startOfDay(windowEnd).getTime()
  ) {
    return null;
  }

  return targetDayKey;
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

export function parseBroadcastPlannerTimeLabel(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value.trim());
  if (!match) {
    return null;
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

export function snapMinutesToStep(minutes: number): number {
  return Math.ceil(minutes / BROADCAST_SCHEDULE_STEP_MINUTES) * BROADCAST_SCHEDULE_STEP_MINUTES;
}

export function normalizeBroadcastPlannerTimeMinutes(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const lastSlot = 24 * 60 - BROADCAST_SCHEDULE_STEP_MINUTES;
  const snapped =
    Math.round(value / BROADCAST_SCHEDULE_STEP_MINUTES) * BROADCAST_SCHEDULE_STEP_MINUTES;
  return Math.min(lastSlot, Math.max(0, snapped));
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

function getScheduleWindowEnd(nowMs: number, maxDays: number): Date {
  return endOfMonth(addDays(new Date(nowMs), Math.max(0, maxDays - 1)));
}

function buildOccupiedInstantSet(occupiedSlots: readonly string[] = []): Set<string> {
  return new Set(sortAndUniqueBroadcastSlots([...occupiedSlots]).map(getBroadcastSlotInstantKey));
}

function isCandidateSlotAvailable(
  dayKey: string,
  minutes: number,
  minimumTimeMs: number,
  occupiedInstantSet: Set<string>,
): boolean {
  const slot = buildBroadcastScheduleSlotIso(dayKey, minutes);
  const slotTime = new Date(slot).getTime();
  return (
    Number.isFinite(slotTime) &&
    slotTime >= minimumTimeMs &&
    !occupiedInstantSet.has(getBroadcastSlotInstantKey(slot))
  );
}

function shouldUseTemplateDay(
  dayKey: string,
  template: BroadcastScheduleTemplateBlueprint,
): boolean {
  if (template.weekdayMode === 'any') {
    return true;
  }

  const weekDay = new Date(`${dayKey}T12:00:00`).getDay();
  return weekDay !== 0 && weekDay !== 6;
}

function shouldUsePresetDay(dayKey: string, preset: BroadcastDayPreset): boolean {
  if (preset.weekdayMode === 'any') {
    return true;
  }

  const weekDay = new Date(`${dayKey}T12:00:00`).getDay();
  return weekDay !== 0 && weekDay !== 6;
}

export function buildBroadcastPresetDayKeys(
  preset: BroadcastDayPreset,
  { nowMs, maxDays = BROADCAST_SCHEDULE_MAX_DAYS }: BroadcastDayPresetOptions,
): string[] {
  const windowEnd = getScheduleWindowEnd(nowMs, maxDays);
  const dayKeys: string[] = [];

  for (let dayOffset = 0; dayOffset < maxDays && dayKeys.length < preset.count; dayOffset += 1) {
    const dayKey = getBroadcastScheduleDayKey(addDays(new Date(nowMs), dayOffset));
    if (startOfDay(new Date(`${dayKey}T12:00:00`)).getTime() > windowEnd.getTime()) {
      break;
    }

    if (!shouldUsePresetDay(dayKey, preset)) {
      continue;
    }

    dayKeys.push(dayKey);
  }

  return dayKeys;
}

export function buildBroadcastDailyScheduleSlots({
  dayKeys,
  minutes,
  minimumTimeMs,
}: BroadcastDailySlotsOptions): string[] {
  const normalizedDayKeys = sortDayKeys([...dayKeys]);
  const normalizedMinutes = Array.from(
    new Set(minutes.map(normalizeBroadcastPlannerTimeMinutes)),
  ).sort((left, right) => left - right);

  return sortAndUniqueBroadcastSlots(
    normalizedDayKeys.flatMap((dayKey) =>
      normalizedMinutes
        .map((minute) => buildBroadcastScheduleSlotIso(dayKey, minute))
        .filter((slot) => minimumTimeMs === undefined || new Date(slot).getTime() >= minimumTimeMs),
    ),
  );
}

export function filterBroadcastSlotsByDayKeys(
  slots: readonly string[],
  dayKeys: readonly string[],
): string[] {
  const dayKeySet = new Set(dayKeys);
  return sortAndUniqueBroadcastSlots(
    slots.filter((slot) => dayKeySet.has(getBroadcastScheduleDayKey(slot))),
  );
}

export function getSelectedMinutesForDay(dayKey: string, slots: readonly string[]): number[] {
  return getSelectedDaySlots(dayKey, [...slots])
    .map((slot) => getSlotMinutes(slot))
    .filter((value): value is number => value !== null)
    .map(normalizeBroadcastPlannerTimeMinutes)
    .sort((left, right) => left - right);
}

export function getCommonSelectedMinutesForDays(
  dayKeys: readonly string[],
  slots: readonly string[],
): number[] {
  const normalizedDayKeys = sortDayKeys([...dayKeys]);
  if (normalizedDayKeys.length === 0) {
    return [];
  }

  const [firstDayKey, ...restDayKeys] = normalizedDayKeys;
  const common = new Set(getSelectedMinutesForDay(firstDayKey, slots));

  for (const dayKey of restDayKeys) {
    const dayMinutes = new Set(getSelectedMinutesForDay(dayKey, slots));
    for (const minute of Array.from(common)) {
      if (!dayMinutes.has(minute)) {
        common.delete(minute);
      }
    }
  }

  return Array.from(common).sort((left, right) => left - right);
}

export function buildBroadcastQuickScheduleSlots({
  nowMs,
  minimumTimeMs = nowMs + 30_000,
  occupiedSlots = [],
  maxDays = BROADCAST_SCHEDULE_MAX_DAYS,
  limit = QUICK_SCHEDULE_SLOT_LIMIT,
}: BroadcastSmartScheduleOptions): BroadcastQuickScheduleSlot[] {
  const occupiedInstantSet = buildOccupiedInstantSet(occupiedSlots);
  const windowEnd = getScheduleWindowEnd(nowMs, maxDays);
  const result: BroadcastQuickScheduleSlot[] = [];

  for (let dayOffset = 0; dayOffset < maxDays && result.length < limit; dayOffset += 1) {
    const dayKey = getBroadcastScheduleDayKey(addDays(new Date(nowMs), dayOffset));
    if (startOfDay(new Date(`${dayKey}T12:00:00`)).getTime() > windowEnd.getTime()) {
      break;
    }

    for (const minutes of getSuggestedMinutes(dayKey, minimumTimeMs)) {
      if (result.length >= limit) {
        break;
      }

      if (!isCandidateSlotAvailable(dayKey, minutes, minimumTimeMs, occupiedInstantSet)) {
        continue;
      }

      result.push({
        slot: buildBroadcastScheduleSlotIso(dayKey, minutes),
        label: `${formatDayChipLabel(dayKey)} ${formatMinuteLabel(minutes)}`,
      });
    }
  }

  return result;
}

export function buildBroadcastSmartScheduleTemplates({
  nowMs,
  minimumTimeMs = nowMs + 30_000,
  occupiedSlots = [],
  maxDays = BROADCAST_SCHEDULE_MAX_DAYS,
}: Omit<BroadcastSmartScheduleOptions, 'limit'>): BroadcastSmartScheduleTemplate[] {
  const occupiedInstantSet = buildOccupiedInstantSet(occupiedSlots);
  const windowEnd = getScheduleWindowEnd(nowMs, maxDays);
  const templates: BroadcastSmartScheduleTemplate[] = [];

  for (const template of SMART_SCHEDULE_TEMPLATE_BLUEPRINTS) {
    const slots: string[] = [];

    for (let dayOffset = 0; dayOffset < maxDays && slots.length < template.count; dayOffset += 1) {
      const dayKey = getBroadcastScheduleDayKey(addDays(new Date(nowMs), dayOffset));
      if (startOfDay(new Date(`${dayKey}T12:00:00`)).getTime() > windowEnd.getTime()) {
        break;
      }

      if (!shouldUseTemplateDay(dayKey, template)) {
        continue;
      }

      if (!isCandidateSlotAvailable(dayKey, template.minutes, minimumTimeMs, occupiedInstantSet)) {
        continue;
      }

      slots.push(buildBroadcastScheduleSlotIso(dayKey, template.minutes));
    }

    if (slots.length === template.count) {
      templates.push({
        id: template.id,
        label: template.label,
        meta: `${template.count}×${formatMinuteLabel(template.minutes)}`,
        slots,
      });
    }
  }

  return templates;
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
