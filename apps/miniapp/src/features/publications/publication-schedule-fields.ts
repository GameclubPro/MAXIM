import { DateTime } from 'luxon';

export function parsePublicationScheduleField(value: string, timezone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
  const date = DateTime.fromISO(value, { zone: timezone });
  // Reject nonexistent spring-forward times instead of silently shifting the user's input.
  return date.isValid && date.toFormat("yyyy-MM-dd'T'HH:mm") === value
    ? date.toUTC().toISO()
    : null;
}
