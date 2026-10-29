import type { ChatSettings } from '../prisma/prisma-client';
import { DEFAULT_NIGHT_MODE_TIMEZONE } from './moderation.service.support';
import {
  resolveNightModeCalendar,
  type NightModeCalendarGeometry,
  type NightModeCalendarWindow,
} from './night-mode-calendar.util';

export type NightModeTransitionKind = 'close' | 'open';
export type NightModeTransitionScheduleSettings = Pick<
  ChatSettings,
  'nightModeEnabled' | 'nightModeStartTimeMinutes' | 'nightModeEndTimeMinutes' | 'nightModeTimezone'
>;
export type NightModeScheduleGeometry = Omit<
  NightModeTransitionScheduleSettings,
  'nightModeEnabled'
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
type ZonedDateParts = { year: number; month: number; day: number; hour: number; minute: number };
const normalizedZones = new Map<string, string>();

export function normalizeNightModeTimezone(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return DEFAULT_NIGHT_MODE_TIMEZONE;
  const cached = normalizedZones.get(normalized);
  if (cached) return cached;
  let result = normalized;
  try {
    Intl.DateTimeFormat('ru-RU', { timeZone: normalized }).format(0);
  } catch {
    result = DEFAULT_NIGHT_MODE_TIMEZONE;
  }
  if (normalizedZones.size >= 256) normalizedZones.delete(normalizedZones.keys().next().value!);
  normalizedZones.set(normalized, result);
  return result;
}
export function normalizeDayMinutes(value: number, fallback: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 1_439 ? value : fallback;
}
export function formatMinutesAsTime(value: number): string {
  const normalized = normalizeDayMinutes(value, 0);
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}
export function getCurrentMinutesInTimeZone(timeZone: string, date = new Date()): number | null {
  const parts = getZonedDateParts(date, timeZone);
  return parts ? parts.hour * 60 + parts.minute : null;
}
export function formatDateKeyInTimeZone(date: Date, timeZone: string): string {
  const parts = getZonedDateParts(date, timeZone);
  return parts
    ? formatDateKey(parts.year, parts.month, parts.day)
    : date.toISOString().slice(0, 10);
}
function lastMatching<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1)
    if (predicate(items[index]!)) return items[index];
  return undefined;
}
function geometry(settings: NightModeScheduleGeometry): NightModeCalendarGeometry {
  return {
    startMinutes: normalizeDayMinutes(settings.nightModeStartTimeMinutes, 23 * 60),
    endMinutes: normalizeDayMinutes(settings.nightModeEndTimeMinutes, 8 * 60),
    timezone: normalizeNightModeTimezone(settings.nightModeTimezone),
  };
}
function sessionKey(window: NightModeCalendarWindow, value: NightModeCalendarGeometry): string {
  return buildNightModeTransitionSessionKey({ ...value, sessionDateKey: window.sessionDateKey });
}
function occurrence(
  window: NightModeCalendarWindow,
  value: NightModeCalendarGeometry,
  transition: NightModeTransitionKind,
): NightModeTransitionOccurrence {
  return {
    transition,
    sessionKey: sessionKey(window, value),
    dueAt: new Date(transition === 'close' ? window.closeAtMs : window.openAtMs),
  };
}
export function resolveNightModeTransitionSnapshot(
  settings: NightModeTransitionScheduleSettings,
  now = new Date(),
): NightModeTransitionSnapshot | null {
  if (!settings.nightModeEnabled || !Number.isFinite(now.getTime())) return null;
  const value = geometry(settings);
  if (value.startMinutes === value.endMinutes)
    return {
      ...value,
      status: 'closed',
      isCloseBoundary: false,
      isOpenBoundary: false,
      sessionKey: buildNightModeTransitionSessionKey({
        ...value,
        sessionDateKey: formatDateKeyInTimeZone(now, value.timezone),
      }),
    };
  const at = now.getTime();
  const windows = resolveNightModeCalendar(value, at);
  const active = windows.find((window) => window.closeAtMs <= at && at < window.openAtMs);
  const previous = lastMatching(windows, (window) => window.openAtMs <= at);
  const window = active ?? previous;
  if (!window) throw new Error('Night mode calendar has no prior session');
  return {
    ...value,
    status: active ? 'closed' : 'open',
    sessionKey: sessionKey(window, value),
    isCloseBoundary: Boolean(active && Math.floor(at / 60_000) === window.closeAtMs / 60_000),
    isOpenBoundary: !active && Math.floor(at / 60_000) === window.openAtMs / 60_000,
  };
}
export function resolveNextNightModeTransitionOccurrences(
  settings: NightModeTransitionScheduleSettings,
  now = new Date(),
): NightModeTransitionOccurrence[] {
  if (!settings.nightModeEnabled) return [];
  const value = geometry(settings);
  if (value.startMinutes === value.endMinutes) return [];
  const at = now.getTime();
  const windows = resolveNightModeCalendar(value, at);
  const close = windows.find((window) => window.closeAtMs > at);
  const open = windows.find((window) => window.openAtMs > at);
  return [close && occurrence(close, value, 'close'), open && occurrence(open, value, 'open')]
    .filter((item): item is NightModeTransitionOccurrence => Boolean(item))
    .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());
}
/** Current saved geometry only: this is neither historical configuration nor SEND authority. */
export function resolveLatestNightModeTransitionOccurrences(
  settings: NightModeScheduleGeometry,
  now = new Date(),
): {
  basis: 'current_schedule';
  close: NightModeTransitionOccurrence | null;
  open: NightModeTransitionOccurrence | null;
} {
  const value = geometry(settings);
  if (value.startMinutes === value.endMinutes)
    return { basis: 'current_schedule', close: null, open: null };
  const at = now.getTime();
  const windows = resolveNightModeCalendar(value, at);
  const close = lastMatching(windows, (window) => window.closeAtMs <= at);
  const open = lastMatching(windows, (window) => window.openAtMs <= at);
  return {
    basis: 'current_schedule',
    close: close ? occurrence(close, value, 'close') : null,
    open: open ? occurrence(open, value, 'open') : null,
  };
}
export function resolveCurrentNightModeCloseOccurrence(
  settings: NightModeTransitionScheduleSettings,
  now = new Date(),
): NightModeTransitionOccurrence | null {
  const snapshot = resolveNightModeTransitionSnapshot(settings, now);
  if (snapshot?.status !== 'closed' || snapshot.startMinutes === snapshot.endMinutes) return null;
  return resolveLatestNightModeTransitionOccurrences(settings, now).close;
}
export function resolveCurrentNightModeOpenOccurrence(
  settings: NightModeTransitionScheduleSettings,
  now = new Date(),
): NightModeTransitionOccurrence | null {
  if (resolveNightModeTransitionSnapshot(settings, now)?.status !== 'open') return null;
  const latest = resolveLatestNightModeTransitionOccurrences(settings, now).open;
  return latest &&
    resolveNightModeNoticeCatchUpWindow(latest, settings, now).state === 'within_window'
    ? latest
    : null;
}
export function resolveNightModeNoticeCatchUpWindow(
  item: NightModeTransitionOccurrence,
  settings: NightModeScheduleGeometry,
  now = new Date(),
): { state: 'within_window' | 'expired'; endsAt: Date } {
  const value = geometry(settings);
  const windows = resolveNightModeCalendar(value, item.dueAt.getTime());
  const window = windows.find((candidate) => sessionKey(candidate, value) === item.sessionKey);
  if (!window) return { state: 'expired', endsAt: item.dueAt };
  const nextClose =
    windows.find((candidate) => candidate.closeAtMs > window.openAtMs)?.closeAtMs ?? Infinity;
  const limit =
    item.transition === 'close'
      ? window.openAtMs
      : Math.min(window.openAtMs + NIGHT_MODE_OPEN_CATCH_UP_MAX_AGE_MS, nextClose);
  const at = now.getTime();
  const within =
    at >= item.dueAt.getTime() &&
    (at < limit || (item.transition === 'open' && at === limit && limit < nextClose));
  return { state: within ? 'within_window' : 'expired', endsAt: new Date(limit) };
}
function absoluteSession(
  key: string,
): { value: NightModeCalendarGeometry; window: NightModeCalendarWindow } | null {
  const parsed = parseNightModeTransitionSessionKey(key);
  if (!parsed || parsed.startMinutes === parsed.endMinutes) return null;
  const at = Date.parse(`${parsed.sessionDateKey}T12:00:00.000Z`);
  const windows = resolveNightModeCalendar(parsed, at);
  const window = windows.find((candidate) => candidate.sessionDateKey === parsed.sessionDateKey);
  return window ? { value: parsed, window } : null;
}
export function resolveNightModeTransitionSessionCloseAt(key: string): Date | null {
  const session = absoluteSession(key);
  return session ? new Date(session.window.closeAtMs) : null;
}
export function resolveNightModeTransitionSessionOpenAt(key: string): Date | null {
  const session = absoluteSession(key);
  return session ? new Date(session.window.openAtMs) : null;
}
/** FLAG: Aliases are only negative effect fences; never use a member as SEND/retry authority. */
export function resolveNightModeTransitionSessionAliases(key: string): readonly string[] {
  const session = absoluteSession(key);
  return session
    ? session.window.memberDateKeys.map((sessionDateKey) =>
        buildNightModeTransitionSessionKey({ ...session.value, sessionDateKey }),
      )
    : [key];
}

type ManualClosureSettings = Pick<
  ChatSettings,
  'nightModeForceCloseEnabled' | 'nightModeForceCloseForever' | 'nightModeForceCloseUntil'
>;
export function resolveManualChatClosure(
  settings: ManualClosureSettings,
  now = new Date(),
): {
  active: boolean;
  mode: 'forever' | 'timed' | null;
  until: string | null;
} {
  const active =
    settings.nightModeForceCloseEnabled &&
    (settings.nightModeForceCloseForever ||
      Date.parse(settings.nightModeForceCloseUntil) > now.getTime());
  return {
    active,
    mode: !active ? null : settings.nightModeForceCloseForever ? 'forever' : 'timed',
    until:
      active && !settings.nightModeForceCloseForever
        ? new Date(settings.nightModeForceCloseUntil).toISOString()
        : null,
  };
}
export function resolveEffectiveChatClosure(
  settings: NightModeTransitionScheduleSettings & ManualClosureSettings,
  now = new Date(),
) {
  const manual = resolveManualChatClosure(settings, now);
  const night = resolveNightModeTransitionSnapshot(settings, now);
  const restriction = manual.active
    ? ('manual' as const)
    : night?.status === 'closed'
      ? ('night' as const)
      : ('open' as const);
  const reference = manual.until ? new Date(manual.until) : now;
  const then = resolveNightModeTransitionSnapshot(settings, reference);
  const opensAt =
    manual.mode === 'forever'
      ? null
      : then?.status === 'closed'
        ? resolveNightModeTransitionSessionOpenAt(then.sessionKey)
        : manual.until
          ? reference
          : null;
  const next = resolveNextNightModeTransitionOccurrences(settings, now)[0]?.dueAt ?? null;
  const manualUntil = manual.until ? new Date(manual.until) : null;
  const nextTransitionAt = !next
    ? manualUntil
    : manualUntil && manualUntil < next
      ? manualUntil
      : next;
  return {
    closed: restriction !== 'open',
    restriction,
    manual,
    night,
    opensAt,
    nextTransitionAt,
    boundary:
      geometry(settings).startMinutes === geometry(settings).endMinutes
        ? ('continuous' as const)
        : ('daily' as const),
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

function formatDateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
