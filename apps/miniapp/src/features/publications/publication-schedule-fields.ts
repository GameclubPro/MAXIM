import { DateTime } from 'luxon';

export function parsePublicationScheduleField(value: string, timezone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
  const date = DateTime.fromISO(value, { zone: timezone });
  // Reject nonexistent spring-forward times instead of silently shifting the user's input.
  if (!date.isValid || date.toFormat("yyyy-MM-dd'T'HH:mm") !== value) return null;
  // FLAG: Match recurring schedules: a repeated wall time uses the earlier UTC instant.
  return date
    .getPossibleOffsets()
    .reduce((earliest, possible) =>
      possible.toMillis() < earliest.toMillis() ? possible : earliest,
    )
    .toUTC()
    .toISO();
}
