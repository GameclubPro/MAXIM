import { DateTime } from 'luxon';

export function parseVkQueueDate(
  value: string,
  timezone: string,
  nowMs = Date.now(),
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
  const date = DateTime.fromISO(value, { zone: timezone });
  return date.isValid && date.toFormat("yyyy-MM-dd'T'HH:mm") === value && date.toMillis() > nowMs
    ? date.toUTC().toISO()
    : null;
}

export function resolveVkQueueQuickSlot(
  minutes: number | null,
  timezone: string,
  nowMs = Date.now(),
): string {
  const now = DateTime.fromMillis(nowMs, { zone: timezone });
  return (
    minutes === null ? now.plus({ days: 1 }).startOf('day').set({ hour: 9 }) : now.plus({ minutes })
  )
    .toUTC()
    .toISO()!;
}
