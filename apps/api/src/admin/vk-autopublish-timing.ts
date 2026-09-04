import { DateTime, IANAZone } from 'luxon';

export const VK_AUTOPUBLISH_DEFAULT_TIMEZONE = 'Europe/Moscow';
export const VK_AUTOPUBLISH_MIN_SOURCE_SPACING_MS = 5 * 60_000;
export const VK_AUTOPUBLISH_CHAT_SLOT_CLEARANCE_MS = 60_000;

const DEFAULT_PUBLISH_INTERVAL_MINUTES = 60;
const DEFAULT_MIN_PUBLISH_INTERVAL_MINUTES = 30;
const DEFAULT_WORK_HOURS_START = '09:00';
const DEFAULT_WORK_HOURS_END = '22:00';
const ALLOWED_SLOT_LOOKAHEAD_MINUTES = 8 * 24 * 60;

export type VkAutoPublishTimingSettings = {
  schedulerTimezone?: string | null;
  workHoursStart?: string | null;
  workHoursEnd?: string | null;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  distributeEvenlyEnabled: boolean;
  roundRobinEnabled: boolean;
};

export type VkAutoPublishTimingSource = {
  publishIntervalMinutes?: number | null;
  minPublishIntervalMinutes?: number | null;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
};

export type VkAutoPublishLocalDayRange = {
  timezone: string;
  start: Date;
  end: Date;
};

export type PlanVkAutoPublishSourceSlotsOptions = {
  count: number;
  now: Date;
  lastSourceAt?: Date | null;
  existingChatSlots?: readonly Date[];
  settings: VkAutoPublishTimingSettings;
  source: VkAutoPublishTimingSource;
  chatSlotClearanceMs?: number;
};

type ParsedDailyRange = {
  startMinute: number;
  endMinute: number;
};

export function isValidVkAutoPublishTimezone(value: unknown): value is string {
  return typeof value === 'string' && IANAZone.isValidZone(value.trim());
}

export function normalizeVkAutoPublishTimezone(
  value: unknown,
  fallback: string = VK_AUTOPUBLISH_DEFAULT_TIMEZONE,
): string {
  const normalizedFallback = isValidVkAutoPublishTimezone(fallback)
    ? fallback.trim()
    : VK_AUTOPUBLISH_DEFAULT_TIMEZONE;
  return isValidVkAutoPublishTimezone(value) ? value.trim() : normalizedFallback;
}

export function getVkAutoPublishLocalDayRange(
  at: Date,
  timezone: unknown,
): VkAutoPublishLocalDayRange {
  const timestamp = readDate(at, 'at');
  const normalizedTimezone = normalizeVkAutoPublishTimezone(timezone);
  const start = DateTime.fromMillis(timestamp, { zone: normalizedTimezone }).startOf('day');

  return {
    timezone: normalizedTimezone,
    start: start.toJSDate(),
    end: start.plus({ days: 1 }).toJSDate(),
  };
}

export function resolveVkAutoPublishSourceSpacingMs(
  settings: Pick<VkAutoPublishTimingSettings, 'distributeEvenlyEnabled'>,
  source: Pick<VkAutoPublishTimingSource, 'publishIntervalMinutes' | 'minPublishIntervalMinutes'>,
): number {
  const publishIntervalMinutes = readFiniteNumber(
    source.publishIntervalMinutes,
    (value) => value > 0,
    DEFAULT_PUBLISH_INTERVAL_MINUTES,
  );
  const minPublishIntervalMinutes = readFiniteNumber(
    source.minPublishIntervalMinutes,
    (value) => value >= 0,
    DEFAULT_MIN_PUBLISH_INTERVAL_MINUTES,
  );
  const effectiveMinutes = Math.max(
    VK_AUTOPUBLISH_MIN_SOURCE_SPACING_MS / 60_000,
    settings.distributeEvenlyEnabled ? publishIntervalMinutes : 0,
    minPublishIntervalMinutes,
  );

  return effectiveMinutes * 60_000;
}

export function isVkAutoPublishTimeAllowed(
  at: Date,
  settings: Pick<
    VkAutoPublishTimingSettings,
    'schedulerTimezone' | 'workHoursStart' | 'workHoursEnd' | 'quietHoursStart' | 'quietHoursEnd'
  >,
  source: Pick<VkAutoPublishTimingSource, 'quietHoursStart' | 'quietHoursEnd'>,
): boolean {
  const timestamp = readDate(at, 'at');
  const timezone = normalizeVkAutoPublishTimezone(settings.schedulerTimezone);
  const local = DateTime.fromMillis(timestamp, { zone: timezone });
  const minute = local.hour * 60 + local.minute;
  const windows = parseScheduleWindows(settings, source);

  return isMinuteAllowed(minute, windows);
}

export function resolveNextAllowedVkAutoPublishAt(
  candidate: Date,
  settings: Pick<
    VkAutoPublishTimingSettings,
    'schedulerTimezone' | 'workHoursStart' | 'workHoursEnd' | 'quietHoursStart' | 'quietHoursEnd'
  >,
  source: Pick<VkAutoPublishTimingSource, 'quietHoursStart' | 'quietHoursEnd'>,
): Date | null {
  const candidateMs = readDate(candidate, 'candidate');
  const timezone = normalizeVkAutoPublishTimezone(settings.schedulerTimezone);
  const windows = parseScheduleWindows(settings, source);
  const initial = DateTime.fromMillis(candidateMs, { zone: timezone });

  if (isMinuteAllowed(initial.hour * 60 + initial.minute, windows)) {
    return new Date(candidateMs);
  }
  if (!hasAnyAllowedMinute(windows)) {
    return null;
  }

  let cursor = initial.startOf('minute');
  if (cursor.toMillis() < candidateMs) {
    cursor = cursor.plus({ minutes: 1 });
  }

  for (let index = 0; index <= ALLOWED_SLOT_LOOKAHEAD_MINUTES; index += 1) {
    if (isMinuteAllowed(cursor.hour * 60 + cursor.minute, windows)) {
      return cursor.toJSDate();
    }
    cursor = cursor.plus({ minutes: 1 });
  }

  return null;
}

export function planVkAutoPublishSourceSlots(options: PlanVkAutoPublishSourceSlotsOptions): Date[] {
  if (!Number.isInteger(options.count) || options.count < 0) {
    throw new RangeError('VK autopublish slot count must be a non-negative integer.');
  }
  if (options.count === 0) {
    return [];
  }

  const nowMs = readDate(options.now, 'now');
  const lastSourceMs = options.lastSourceAt ? readDate(options.lastSourceAt, 'lastSourceAt') : null;
  const spacingMs = resolveVkAutoPublishSourceSpacingMs(options.settings, options.source);
  const clearanceMs = readClearance(options.chatSlotClearanceMs);
  const occupiedMs = options.settings.roundRobinEnabled
    ? readDates(options.existingChatSlots ?? [], 'existingChatSlots').sort(
        (left, right) => left - right,
      )
    : [];
  const slots: Date[] = [];
  let earliestMs = lastSourceMs === null ? nowMs : Math.max(nowMs, lastSourceMs + spacingMs);

  for (let index = 0; index < options.count; index += 1) {
    const slot = resolveCollisionFreeAllowedSlot(
      earliestMs,
      occupiedMs,
      clearanceMs,
      options.settings,
      options.source,
    );
    if (!slot) {
      throw new RangeError('VK autopublish timing rules do not contain an available slot.');
    }

    slots.push(slot);
    insertSortedNumber(occupiedMs, slot.getTime());
    earliestMs = slot.getTime() + spacingMs;
  }

  return slots;
}

function resolveCollisionFreeAllowedSlot(
  earliestMs: number,
  occupiedMs: readonly number[],
  clearanceMs: number,
  settings: PlanVkAutoPublishSourceSlotsOptions['settings'],
  source: PlanVkAutoPublishSourceSlotsOptions['source'],
): Date | null {
  let candidateMs = earliestMs;

  for (let attempt = 0; attempt <= occupiedMs.length + 1; attempt += 1) {
    const allowed = resolveNextAllowedVkAutoPublishAt(new Date(candidateMs), settings, source);
    if (!allowed) {
      return null;
    }

    const nextCollisionFreeMs = advancePastChatSlotCollisions(
      allowed.getTime(),
      occupiedMs,
      clearanceMs,
    );
    if (nextCollisionFreeMs === allowed.getTime()) {
      return allowed;
    }
    candidateMs = nextCollisionFreeMs;
  }

  return null;
}

function advancePastChatSlotCollisions(
  candidateMs: number,
  occupiedMs: readonly number[],
  clearanceMs: number,
): number {
  let resultMs = candidateMs;

  for (const occupiedAtMs of occupiedMs) {
    if (occupiedAtMs <= resultMs - clearanceMs) {
      continue;
    }
    if (occupiedAtMs >= resultMs + clearanceMs) {
      break;
    }
    resultMs = occupiedAtMs + clearanceMs;
  }

  return resultMs;
}

function insertSortedNumber(values: number[], value: number): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! <= value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  values.splice(low, 0, value);
}

function parseScheduleWindows(
  settings: Pick<
    VkAutoPublishTimingSettings,
    'workHoursStart' | 'workHoursEnd' | 'quietHoursStart' | 'quietHoursEnd'
  >,
  source: Pick<VkAutoPublishTimingSource, 'quietHoursStart' | 'quietHoursEnd'>,
): {
  work: ParsedDailyRange;
  globalQuiet: ParsedDailyRange | null;
  sourceQuiet: ParsedDailyRange | null;
} {
  const workStartMinute = parseTimeOfDay(settings.workHoursStart);
  const workEndMinute = parseTimeOfDay(settings.workHoursEnd);
  return {
    work:
      workStartMinute === null || workEndMinute === null
        ? {
            startMinute: parseTimeOfDay(DEFAULT_WORK_HOURS_START)!,
            endMinute: parseTimeOfDay(DEFAULT_WORK_HOURS_END)!,
          }
        : { startMinute: workStartMinute, endMinute: workEndMinute },
    globalQuiet: parseOptionalDailyRange(settings.quietHoursStart, settings.quietHoursEnd),
    sourceQuiet: parseOptionalDailyRange(source.quietHoursStart, source.quietHoursEnd),
  };
}

function parseOptionalDailyRange(
  start: string | null | undefined,
  end: string | null | undefined,
): ParsedDailyRange | null {
  const startMinute = parseTimeOfDay(start);
  const endMinute = parseTimeOfDay(end);
  return startMinute === null || endMinute === null ? null : { startMinute, endMinute };
}

function parseTimeOfDay(value: string | null | undefined): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/u.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function isMinuteAllowed(
  minute: number,
  windows: {
    work: ParsedDailyRange;
    globalQuiet: ParsedDailyRange | null;
    sourceQuiet: ParsedDailyRange | null;
  },
): boolean {
  return (
    isMinuteInRange(minute, windows.work) &&
    !(windows.globalQuiet && isMinuteInRange(minute, windows.globalQuiet)) &&
    !(windows.sourceQuiet && isMinuteInRange(minute, windows.sourceQuiet))
  );
}

function hasAnyAllowedMinute(windows: {
  work: ParsedDailyRange;
  globalQuiet: ParsedDailyRange | null;
  sourceQuiet: ParsedDailyRange | null;
}): boolean {
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    if (isMinuteAllowed(minute, windows)) {
      return true;
    }
  }
  return false;
}

function isMinuteInRange(minute: number, range: ParsedDailyRange): boolean {
  if (range.startMinute === range.endMinute) {
    return true;
  }
  if (range.startMinute < range.endMinute) {
    return minute >= range.startMinute && minute < range.endMinute;
  }
  return minute >= range.startMinute || minute < range.endMinute;
}

function readFiniteNumber(
  value: number | null | undefined,
  predicate: (value: number) => boolean,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value) && predicate(value) ? value : fallback;
}

function readDate(value: Date, field: string): number {
  const timestamp = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new RangeError(`Invalid VK autopublish ${field} date.`);
  }
  return timestamp;
}

function readDates(values: readonly Date[], field: string): number[] {
  return values.map((value, index) => readDate(value, `${field}[${index}]`));
}

function readClearance(value: number | undefined): number {
  if (value === undefined) {
    return VK_AUTOPUBLISH_CHAT_SLOT_CLEARANCE_MS;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('VK autopublish chat slot clearance must be non-negative.');
  }
  return value;
}
