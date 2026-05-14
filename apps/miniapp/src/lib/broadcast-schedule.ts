export const BROADCAST_SCHEDULE_MAX_DAYS = 31;
export const BROADCAST_SCHEDULE_STEP_MINUTES = 30;
export const BROADCAST_CYCLE_MIN_HOURS = 1;
export const BROADCAST_CYCLE_MAX_HOURS = 14 * 24;
export const BROADCAST_CYCLE_MIN_COUNT = 2;
export const BROADCAST_CYCLE_MAX_COUNT = 100;
export const BROADCAST_CYCLE_MAX_WINDOW_DAYS = 31;
export const BROADCAST_CYCLE_INTERVAL_PRESETS = [1, 2, 6, 12, 24] as const;

export type BroadcastTimingMode = 'now' | 'scheduled' | 'cycle';
export type BroadcastCycleStartMode = 'now' | 'later';

export type BroadcastCycleDraft = {
  startMode: BroadcastCycleStartMode;
  startAt: string;
  everyHours: number;
  count: number;
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function resolveBroadcastScheduleTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
}

function formatCountLabel(count: number, singular: string, few: string, plural: string): string {
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

export function createDefaultBroadcastCycleDraft(nowMs = Date.now()): BroadcastCycleDraft {
  return {
    startMode: 'now',
    startAt: new Date(nowMs + 60 * 60 * 1_000).toISOString(),
    everyHours: BROADCAST_CYCLE_MIN_HOURS,
    count: 5,
  };
}

export function clampBroadcastCycleEveryHours(value: number): number {
  if (!Number.isFinite(value)) {
    return BROADCAST_CYCLE_MIN_HOURS;
  }

  return Math.min(
    BROADCAST_CYCLE_MAX_HOURS,
    Math.max(BROADCAST_CYCLE_MIN_HOURS, Math.trunc(value)),
  );
}

export function clampBroadcastCycleCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 5;
  }

  return Math.min(
    BROADCAST_CYCLE_MAX_COUNT,
    Math.max(BROADCAST_CYCLE_MIN_COUNT, Math.trunc(value)),
  );
}

export function normalizeBroadcastTimingMode(value: unknown): BroadcastTimingMode | null {
  return value === 'now' || value === 'scheduled' || value === 'cycle' ? value : null;
}

export function normalizeBroadcastCycleDraft(
  value: Partial<BroadcastCycleDraft> | null | undefined,
  nowMs = Date.now(),
): BroadcastCycleDraft {
  const fallback = createDefaultBroadcastCycleDraft(nowMs);
  const startMode = value?.startMode === 'later' ? 'later' : 'now';
  const parsedStartAt = typeof value?.startAt === 'string' ? new Date(value.startAt) : null;
  const startAt =
    parsedStartAt && Number.isFinite(parsedStartAt.getTime())
      ? parsedStartAt.toISOString()
      : fallback.startAt;

  return {
    startMode,
    startAt,
    everyHours: clampBroadcastCycleEveryHours(value?.everyHours ?? fallback.everyHours),
    count: clampBroadcastCycleCount(value?.count ?? fallback.count),
  };
}

export function resolveBroadcastCycleSendAt(cycle: BroadcastCycleDraft): string | null {
  return cycle.startMode === 'later' ? cycle.startAt : null;
}

export function formatBroadcastCycleIntervalLabel(hours: number): string {
  const normalizedHours = clampBroadcastCycleEveryHours(hours);
  if (normalizedHours % 24 === 0) {
    const days = normalizedHours / 24;
    return formatCountLabel(days, 'день', 'дня', 'дней');
  }

  return `${normalizedHours} ч`;
}

export function resolveBroadcastCycleLastSendAt(
  cycle: BroadcastCycleDraft,
  nowMs = Date.now(),
): string {
  const normalizedCycle = normalizeBroadcastCycleDraft(cycle, nowMs);
  const firstSendAt =
    normalizedCycle.startMode === 'later' ? new Date(normalizedCycle.startAt) : new Date(nowMs);
  const lastSendAt = new Date(
    firstSendAt.getTime() + (normalizedCycle.count - 1) * normalizedCycle.everyHours * 60 * 60_000,
  );
  return lastSendAt.toISOString();
}

export function formatBroadcastCycleSummary(
  cycle: BroadcastCycleDraft,
  nowMs = Date.now(),
): string {
  const normalizedCycle = normalizeBroadcastCycleDraft(cycle, nowMs);
  return `каждые ${formatBroadcastCycleIntervalLabel(normalizedCycle.everyHours)} · ${normalizedCycle.count} раз`;
}

export function formatBroadcastCycleLastSendLabel(
  cycle: BroadcastCycleDraft,
  nowMs = Date.now(),
): string {
  return formatBroadcastScheduleSlot(resolveBroadcastCycleLastSendAt(cycle, nowMs));
}

export function getBroadcastCycleValidationError(
  cycle: BroadcastCycleDraft,
  nowMs = Date.now(),
): string | null {
  const normalizedCycle = normalizeBroadcastCycleDraft(cycle, nowMs);
  const firstSendMs =
    normalizedCycle.startMode === 'later' ? new Date(normalizedCycle.startAt).getTime() : nowMs;
  if (!Number.isFinite(firstSendMs)) {
    return 'Некорректный старт цикла.';
  }

  if (normalizedCycle.startMode === 'later' && firstSendMs - nowMs < 30_000) {
    return 'Старт минимум через 30 секунд.';
  }

  const lastSendMs = new Date(resolveBroadcastCycleLastSendAt(normalizedCycle, nowMs)).getTime();
  const maxWindowMs = BROADCAST_CYCLE_MAX_WINDOW_DAYS * 24 * 60 * 60_000;
  if (lastSendMs - nowMs > maxWindowMs) {
    return 'Цикл должен уложиться в 31 день.';
  }

  return null;
}

export function formatLocalDateTimeInputValue(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function parseLocalDateTimeInputValue(value: string): string | null {
  if (!value.trim()) {
    return null;
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function parseBroadcastSlotTime(value: string): number | null {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function getBroadcastSlotInstantKey(value: string): string {
  const trimmed = value.trim();
  const parsedTime = parseBroadcastSlotTime(trimmed);
  return parsedTime !== null ? `time:${parsedTime}` : `raw:${trimmed}`;
}

export function sortAndUniqueBroadcastSlots(values: string[]): string[] {
  const slots: string[] = [];
  const seenKeys = new Set<string>();

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    const key = getBroadcastSlotInstantKey(trimmed);
    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    slots.push(trimmed);
  }

  return slots.sort((left, right) => {
    const leftTime = parseBroadcastSlotTime(left);
    const rightTime = parseBroadcastSlotTime(right);
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    if (leftTime !== null && rightTime === null) {
      return -1;
    }

    if (leftTime === null && rightTime !== null) {
      return 1;
    }

    return left.localeCompare(right);
  });
}

export function findBroadcastSlotConflicts(
  selectedSlots: string[],
  occupiedSlots: string[],
): string[] {
  const occupiedKeys = new Set(
    occupiedSlots
      .map((slot) => slot.trim())
      .filter(Boolean)
      .map(getBroadcastSlotInstantKey),
  );

  return sortAndUniqueBroadcastSlots(selectedSlots).filter((slot) => {
    return occupiedKeys.has(getBroadcastSlotInstantKey(slot));
  });
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
