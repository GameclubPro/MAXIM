import type { ChatSettings } from '../prisma/prisma-client';
import { DEFAULT_NIGHT_MODE_TIMEZONE } from './moderation.service.support';

export type NightModeTransitionKind = 'close' | 'open';

export type NightModeTransitionScheduleSettings = Pick<
  ChatSettings,
  'nightModeEnabled' | 'nightModeStartTimeMinutes' | 'nightModeEndTimeMinutes' | 'nightModeTimezone'
>;

export type NightModeTransitionSnapshot = {
  status: 'open' | 'closed';
  sessionKey: string;
  startMinutes: number;
  endMinutes: number;
  timezone: string;
  isCloseBoundary: boolean;
  isOpenBoundary: boolean;
};

export type NightModeTransitionOccurrence = {
  transition: NightModeTransitionKind;
  dueAt: Date;
  sessionKey: string;
};

export type ParsedNightModeTransitionSession = {
  timezone: string;
  startMinutes: number;
  endMinutes: number;
  sessionDateKey: string;
};

export const NIGHT_MODE_OPEN_CATCH_UP_MAX_AGE_MS = 2 * 60 * 60 * 1_000;

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export function normalizeNightModeTimezone(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return DEFAULT_NIGHT_MODE_TIMEZONE;
  }

  try {
    Intl.DateTimeFormat('ru-RU', { timeZone: normalized }).format(new Date());
    return normalized;
  } catch {
    return DEFAULT_NIGHT_MODE_TIMEZONE;
  }
}

export function normalizeDayMinutes(value: number, fallback: number): number {
  if (Number.isInteger(value) && value >= 0 && value <= 1_439) {
    return value;
  }

  return fallback;
}

export function formatMinutesAsTime(value: number): string {
  const normalized = normalizeDayMinutes(value, 0);
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function getCurrentMinutesInTimeZone(timeZone: string, date = new Date()): number | null {
  const parts = getZonedDateParts(date, timeZone);
  return parts ? parts.hour * 60 + parts.minute : null;
}

export function formatDateKeyInTimeZone(date: Date, timeZone: string): string {
  const parts = getZonedDateParts(date, timeZone);
  if (!parts) {
    return date.toISOString().slice(0, 10);
  }

  return formatDateKey(parts.year, parts.month, parts.day);
}

export function resolveNightModeTransitionSnapshot(
  settings: NightModeTransitionScheduleSettings,
  now = new Date(),
): NightModeTransitionSnapshot | null {
  if (!settings.nightModeEnabled) {
    return null;
  }

  const startMinutes = normalizeDayMinutes(settings.nightModeStartTimeMinutes, 23 * 60);
  const endMinutes = normalizeDayMinutes(settings.nightModeEndTimeMinutes, 8 * 60);
  const timezone = normalizeNightModeTimezone(settings.nightModeTimezone);
  const currentMinutes = getCurrentMinutesInTimeZone(timezone, now);
  if (currentMinutes === null) {
    return null;
  }

  const currentDateKey = formatDateKeyInTimeZone(now, timezone);
  const previousDateKey = addDaysToDateKey(currentDateKey, -1);

  if (startMinutes === endMinutes) {
    return {
      status: 'closed',
      sessionKey: buildNightModeTransitionSessionKey({
        timezone,
        startMinutes,
        endMinutes,
        sessionDateKey: currentDateKey,
      }),
      startMinutes,
      endMinutes,
      timezone,
      isCloseBoundary: false,
      isOpenBoundary: false,
    };
  }

  const isClosed =
    startMinutes < endMinutes
      ? currentMinutes >= startMinutes && currentMinutes < endMinutes
      : currentMinutes >= startMinutes || currentMinutes < endMinutes;
  const status = isClosed ? 'closed' : 'open';
  const sessionDateKey = resolveNightModeTransitionSessionDateKey({
    currentDateKey,
    previousDateKey,
    currentMinutes,
    startMinutes,
    endMinutes,
    status,
  });

  return {
    status,
    sessionKey: buildNightModeTransitionSessionKey({
      timezone,
      startMinutes,
      endMinutes,
      sessionDateKey,
    }),
    startMinutes,
    endMinutes,
    timezone,
    isCloseBoundary: currentMinutes === startMinutes,
    isOpenBoundary: currentMinutes === endMinutes,
  };
}

export function resolveNextNightModeTransitionOccurrences(
  settings: NightModeTransitionScheduleSettings,
  now = new Date(),
): NightModeTransitionOccurrence[] {
  if (!settings.nightModeEnabled) {
    return [];
  }

  const startMinutes = normalizeDayMinutes(settings.nightModeStartTimeMinutes, 23 * 60);
  const endMinutes = normalizeDayMinutes(settings.nightModeEndTimeMinutes, 8 * 60);
  if (startMinutes === endMinutes) {
    return [];
  }

  const timezone = normalizeNightModeTimezone(settings.nightModeTimezone);
  const currentMinutes = getCurrentMinutesInTimeZone(timezone, now);
  if (currentMinutes === null) {
    return [];
  }

  const currentDateKey = formatDateKeyInTimeZone(now, timezone);
  const closeDateKey = resolveNextBoundaryDateKey(currentDateKey, currentMinutes, startMinutes);
  const openDateKey = resolveNextBoundaryDateKey(currentDateKey, currentMinutes, endMinutes);
  const closeDueAt = zonedDateTimeToUtc(closeDateKey, startMinutes, timezone);
  const openDueAt = zonedDateTimeToUtc(openDateKey, endMinutes, timezone);
  const closeSessionKey = buildNightModeTransitionSessionKey({
    timezone,
    startMinutes,
    endMinutes,
    sessionDateKey: closeDateKey,
  });
  const openSessionDateKey =
    startMinutes < endMinutes ? openDateKey : addDaysToDateKey(openDateKey, -1);
  const openSessionKey = buildNightModeTransitionSessionKey({
    timezone,
    startMinutes,
    endMinutes,
    sessionDateKey: openSessionDateKey,
  });

  const occurrences: NightModeTransitionOccurrence[] = [
    {
      transition: 'close',
      dueAt: closeDueAt,
      sessionKey: closeSessionKey,
    },
    {
      transition: 'open',
      dueAt: openDueAt,
      sessionKey: openSessionKey,
    },
  ];

  return occurrences.sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());
}

export function resolveCurrentNightModeCloseOccurrence(
  settings: NightModeTransitionScheduleSettings,
  now = new Date(),
): NightModeTransitionOccurrence | null {
  if (!settings.nightModeEnabled) {
    return null;
  }

  const startMinutes = normalizeDayMinutes(settings.nightModeStartTimeMinutes, 23 * 60);
  const endMinutes = normalizeDayMinutes(settings.nightModeEndTimeMinutes, 8 * 60);
  if (startMinutes === endMinutes) {
    return null;
  }

  const timezone = normalizeNightModeTimezone(settings.nightModeTimezone);
  const currentMinutes = getCurrentMinutesInTimeZone(timezone, now);
  if (currentMinutes === null) {
    return null;
  }

  const currentDateKey = formatDateKeyInTimeZone(now, timezone);
  const previousDateKey = addDaysToDateKey(currentDateKey, -1);
  const isClosed =
    startMinutes < endMinutes
      ? currentMinutes >= startMinutes && currentMinutes < endMinutes
      : currentMinutes >= startMinutes || currentMinutes < endMinutes;
  if (!isClosed) {
    return null;
  }

  const sessionDateKey = resolveNightModeTransitionSessionDateKey({
    currentDateKey,
    previousDateKey,
    currentMinutes,
    startMinutes,
    endMinutes,
    status: 'closed',
  });
  const dueAt = zonedDateTimeToUtc(sessionDateKey, startMinutes, timezone);
  if (dueAt.getTime() > now.getTime()) {
    return null;
  }

  return {
    transition: 'close',
    dueAt,
    sessionKey: buildNightModeTransitionSessionKey({
      timezone,
      startMinutes,
      endMinutes,
      sessionDateKey,
    }),
  };
}

export function resolveCurrentNightModeOpenOccurrence(
  settings: NightModeTransitionScheduleSettings,
  now = new Date(),
): NightModeTransitionOccurrence | null {
  if (!settings.nightModeEnabled) {
    return null;
  }

  const startMinutes = normalizeDayMinutes(settings.nightModeStartTimeMinutes, 23 * 60);
  const endMinutes = normalizeDayMinutes(settings.nightModeEndTimeMinutes, 8 * 60);
  if (startMinutes === endMinutes) {
    return null;
  }

  const timezone = normalizeNightModeTimezone(settings.nightModeTimezone);
  const currentMinutes = getCurrentMinutesInTimeZone(timezone, now);
  if (currentMinutes === null) {
    return null;
  }

  const snapshot = resolveNightModeTransitionSnapshot(settings, now);
  if (!snapshot || snapshot.status !== 'open') {
    return null;
  }

  const currentDateKey = formatDateKeyInTimeZone(now, timezone);
  const openDateKey =
    startMinutes < endMinutes && currentMinutes < startMinutes
      ? addDaysToDateKey(currentDateKey, -1)
      : currentDateKey;
  const dueAt = zonedDateTimeToUtc(openDateKey, endMinutes, timezone);
  const ageMs = now.getTime() - dueAt.getTime();
  if (ageMs < 0 || ageMs > NIGHT_MODE_OPEN_CATCH_UP_MAX_AGE_MS) {
    return null;
  }

  return {
    transition: 'open',
    dueAt,
    sessionKey: snapshot.sessionKey,
  };
}

export function buildNightModeTransitionSessionKey(params: {
  timezone: string;
  startMinutes: number;
  endMinutes: number;
  sessionDateKey: string;
}): string {
  return [
    'v1',
    params.timezone,
    formatMinutesAsTime(params.startMinutes),
    formatMinutesAsTime(params.endMinutes),
    params.sessionDateKey,
  ].join(':');
}

export function parseNightModeTransitionSessionKey(
  value: string,
): ParsedNightModeTransitionSession | null {
  const match = /^v1:([^:]+):(\d{2}):(\d{2}):(\d{2}):(\d{2}):(\d{4}-\d{2}-\d{2})$/u.exec(
    value.trim(),
  );
  if (!match) {
    return null;
  }
  const [, timezone, startHourRaw, startMinuteRaw, endHourRaw, endMinuteRaw, sessionDateKey] =
    match;
  const startHour = Number(startHourRaw);
  const startMinute = Number(startMinuteRaw);
  const endHour = Number(endHourRaw);
  const endMinute = Number(endMinuteRaw);
  const parsedDate = new Date(`${sessionDateKey}T00:00:00.000Z`);
  if (
    !timezone ||
    normalizeNightModeTimezone(timezone) !== timezone ||
    startHour > 23 ||
    startMinute > 59 ||
    endHour > 23 ||
    endMinute > 59 ||
    !Number.isFinite(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== sessionDateKey
  ) {
    return null;
  }
  const parsed = {
    timezone,
    startMinutes: startHour * 60 + startMinute,
    endMinutes: endHour * 60 + endMinute,
    sessionDateKey,
  };
  return buildNightModeTransitionSessionKey(parsed) === value.trim() ? parsed : null;
}

export function resolveNightModeTransitionSessionCloseAt(sessionKey: string): Date | null {
  const parsed = parseNightModeTransitionSessionKey(sessionKey);
  return parsed
    ? zonedDateTimeToUtc(parsed.sessionDateKey, parsed.startMinutes, parsed.timezone)
    : null;
}

function resolveNightModeTransitionSessionDateKey(params: {
  currentDateKey: string;
  previousDateKey: string;
  currentMinutes: number;
  startMinutes: number;
  endMinutes: number;
  status: 'open' | 'closed';
}): string {
  if (params.startMinutes < params.endMinutes) {
    if (params.status === 'closed') {
      return params.currentDateKey;
    }
    return params.currentMinutes < params.startMinutes
      ? params.previousDateKey
      : params.currentDateKey;
  }

  if (params.status === 'closed') {
    return params.currentMinutes < params.endMinutes
      ? params.previousDateKey
      : params.currentDateKey;
  }

  return params.previousDateKey;
}

function resolveNextBoundaryDateKey(
  currentDateKey: string,
  currentMinutes: number,
  boundaryMinutes: number,
): string {
  return currentMinutes < boundaryMinutes ? currentDateKey : addDaysToDateKey(currentDateKey, 1);
}

function zonedDateTimeToUtc(dateKey: string, minutes: number, timeZone: string): Date {
  const [year, month, day] = dateKey.split('-').map((item) => Number(item));
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = getZonedDateParts(new Date(utcMs), timeZone);
    if (!parts) {
      return new Date(utcMs);
    }

    const actualLocalMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0,
      0,
    );
    const targetLocalMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const diffMs = targetLocalMs - actualLocalMs;
    if (diffMs === 0) {
      break;
    }
    utcMs += diffMs;
  }

  return new Date(utcMs);
}

function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);

    const year = Number(parts.find((item) => item.type === 'year')?.value ?? '');
    const month = Number(parts.find((item) => item.type === 'month')?.value ?? '');
    const day = Number(parts.find((item) => item.type === 'day')?.value ?? '');
    const hour = Number(parts.find((item) => item.type === 'hour')?.value ?? '');
    const minute = Number(parts.find((item) => item.type === 'minute')?.value ?? '');
    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      !Number.isInteger(day) ||
      !Number.isInteger(hour) ||
      !Number.isInteger(minute)
    ) {
      return null;
    }

    return {
      year,
      month,
      day,
      hour,
      minute,
    };
  } catch {
    return null;
  }
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map((item) => Number(item));
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function formatDateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
