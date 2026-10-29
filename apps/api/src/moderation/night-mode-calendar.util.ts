import { DateTime } from 'luxon';

export type NightModeCalendarGeometry = Readonly<{
  timezone: string;
  startMinutes: number;
  endMinutes: number;
}>;
export type NightModeCalendarWindow = Readonly<{
  sessionDateKey: string;
  memberDateKeys: readonly string[];
  closeAtMs: number;
  openAtMs: number;
}>;
type Calendar = Readonly<{
  fromMs: number;
  untilMs: number;
  windows: readonly NightModeCalendarWindow[];
}>;

export const NIGHT_MODE_CALENDAR_CACHE_LIMIT = 256;
const calendars = new Map<string, Calendar>();

/** FLAG: Cache geometry, never closure state. Both ends of the absolute validity range
 * are checked on every call, including after backward clock jumps and settings changes. */
export function resolveNightModeCalendar(
  geometry: NightModeCalendarGeometry,
  atMs: number,
): readonly NightModeCalendarWindow[] {
  if (!Number.isFinite(atMs)) throw new Error('Invalid night mode calendar instant');
  const key = `${geometry.timezone}:${geometry.startMinutes}:${geometry.endMinutes}`;
  const cached = calendars.get(key);
  if (cached && cached.fromMs <= atMs && atMs < cached.untilMs) {
    calendars.delete(key);
    calendars.set(key, cached);
    return cached.windows;
  }
  const local = DateTime.fromMillis(atMs, { zone: geometry.timezone });
  if (!local.isValid) throw new Error('Invalid night mode calendar zone');
  // Ordinary calls build 17 days once, then reuse the sealed inner range for many days.
  // A skipped date or unusual offset change may need the bounded 65-day fallback.
  for (const radius of [8, 32]) {
    const raw: NightModeCalendarWindow[] = [];
    for (let offset = -radius; offset <= radius; offset += 1) {
      // Use a UTC calendar date, not zoned plus(days): skipped civil dates remain identities.
      const day = DateTime.utc(local.year, local.month, local.day).plus({ days: offset });
      const closeAtMs = resolveBoundary(day, geometry.startMinutes, geometry.timezone);
      const openDay = geometry.startMinutes < geometry.endMinutes ? day : day.plus({ days: 1 });
      const openAtMs = resolveBoundary(openDay, geometry.endMinutes, geometry.timezone);
      if (closeAtMs >= openAtMs) continue;
      const dateKey = day.toISODate()!;
      raw.push({ sessionDateKey: dateKey, memberDateKeys: [dateKey], closeAtMs, openAtMs });
    }
    raw.sort(
      (left, right) =>
        left.closeAtMs - right.closeAtMs || left.sessionDateKey.localeCompare(right.sessionDateKey),
    );
    const merged: NightModeCalendarWindow[] = [];
    for (const item of raw) {
      const previous = merged.at(-1);
      if (previous && item.closeAtMs <= previous.openAtMs) {
        merged[merged.length - 1] = {
          ...previous,
          openAtMs: Math.max(previous.openAtMs, item.openAtMs),
          memberDateKeys: [...previous.memberDateKeys, ...item.memberDateKeys],
        };
      } else merged.push(item);
    }
    // The outer components can be truncated. Require sealed neighbors on both sides.
    const fromMs = merged[2]?.closeAtMs;
    const untilMs = merged.at(-2)?.closeAtMs;
    if (fromMs === undefined || untilMs === undefined || atMs < fromMs || atMs >= untilMs) continue;
    const windows = Object.freeze(
      merged.slice(1, -1).map((window) =>
        Object.freeze({
          ...window,
          memberDateKeys: Object.freeze([...window.memberDateKeys]),
        }),
      ),
    );
    calendars.delete(key);
    if (calendars.size >= NIGHT_MODE_CALENDAR_CACHE_LIMIT)
      calendars.delete(calendars.keys().next().value!);
    calendars.set(key, { fromMs, untilMs, windows });
    return windows;
  }
  // No fabricated OPEN on an unresolved calendar; callers retain their normal error fences.
  throw new Error('Night mode calendar exceeds bounded interval search');
}

function resolveBoundary(day: DateTime, minutes: number, timezone: string): number {
  const local = DateTime.fromObject(
    {
      year: day.year,
      month: day.month,
      day: day.day,
      hour: Math.floor(minutes / 60),
      minute: minutes % 60,
      second: 0,
      millisecond: 0,
    },
    { zone: timezone },
  );
  // FLAG: First occurrence for BOTH edges. Luxon advances missing wall times by the gap.
  const instant = Math.min(...local.getPossibleOffsets().map((candidate) => candidate.toMillis()));
  if (!Number.isFinite(instant)) throw new Error('Invalid night mode calendar boundary');
  return instant;
}
