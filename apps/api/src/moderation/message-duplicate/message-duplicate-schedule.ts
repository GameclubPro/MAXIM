import { DateTime } from 'luxon';
import type { ChatSettings } from '../../prisma/prisma-client';

type ScheduleSettings = Pick<
  ChatSettings,
  | 'duplicateWindowMode'
  | 'duplicateStartTimeMinutes'
  | 'duplicateEndTimeMinutes'
  | 'duplicateTimezone'
>;
export type DuplicateDailyWindow = { startMs: number; endMs: number };
const windows = new Map<string, DuplicateDailyWindow | null>();

export function duplicateScheduleDigestInput(settings: ScheduleSettings) {
  return settings.duplicateWindowMode === 'DAILY'
    ? {
        mode: 'DAILY',
        start: settings.duplicateStartTimeMinutes,
        end: settings.duplicateEndTimeMinutes,
        timezone: settings.duplicateTimezone,
      }
    : { mode: 'INTERVAL' };
}

/** Half-open daily window. null means outside/invalid; undefined means interval mode. */
export function resolveDuplicateDailyWindow(
  settings: ScheduleSettings,
  atMs: number,
): DuplicateDailyWindow | null | undefined {
  if (settings.duplicateWindowMode !== 'DAILY') return undefined;
  const start = settings.duplicateStartTimeMinutes;
  const end = settings.duplicateEndTimeMinutes;
  if (
    !Number.isSafeInteger(atMs) ||
    ![start, end].every((minute) => Number.isInteger(minute) && minute >= 0 && minute < 1440) ||
    start === end
  )
    return null;
  const local = DateTime.fromMillis(atMs, { zone: settings.duplicateTimezone });
  if (!local.isValid) return null;
  // FLAG: Calendar days, never 24-hour subtraction: overnight windows must survive DST.
  for (const day of [local, local.minus({ days: 1 })]) {
    const key = `${settings.duplicateTimezone}:${day.toISODate()}:${start}:${end}`;
    let window = windows.get(key);
    if (window === undefined) {
      const startAt = boundary(day, start, 'start');
      const endAt = boundary(start > end ? day.plus({ days: 1 }) : day, end, 'end');
      window = startAt < endAt ? { startMs: startAt, endMs: endAt } : null;
      if (windows.size >= 128) windows.delete(windows.keys().next().value!);
      windows.set(key, window);
    }
    if (window && atMs >= window.startMs && atMs < window.endMs) return window;
  }
  return null;
}

/** A delayed job must belong to the same currently open daily window. */
export function isDuplicateScheduleOpen(
  settings: ScheduleSettings,
  eventAtMs: number,
  nowMs = Date.now(),
): boolean {
  const window = resolveDuplicateDailyWindow(settings, eventAtMs);
  return (
    window === undefined || (window !== null && nowMs >= window.startMs && nowMs < window.endMs)
  );
}

function boundary(day: DateTime, minutes: number, edge: 'start' | 'end'): number {
  const local = DateTime.fromObject(
    {
      year: day.year,
      month: day.month,
      day: day.day,
      hour: Math.floor(minutes / 60),
      minute: minutes % 60,
    },
    { zone: day.zone },
  );
  // FLAG: Repeated local times form one continuous window: first start, last end.
  // Luxon advances a nonexistent spring boundary by the DST gap; a collapsed window is skipped.
  const candidates = local.getPossibleOffsets().map((value) => value.toMillis());
  return edge === 'start' ? Math.min(...candidates) : Math.max(...candidates);
}
