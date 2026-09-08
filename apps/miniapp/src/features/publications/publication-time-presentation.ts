export function formatPublicationScheduleField(value: string | null, timezone: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(value));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
  } catch {
    return '';
  }
}

export function getNextPublicationRecurrenceTime(times: readonly string[]): string {
  const last = times.at(-1) ?? '08:00';
  const start = new Date(`2000-01-01T${last}:00Z`);
  if (!Number.isFinite(start.getTime())) start.setTime(Date.UTC(2000, 0, 1, 8));
  for (let step = 1; step <= 48; step += 1) {
    const time = new Date(start.getTime() + step * 30 * 60_000).toISOString().slice(11, 16);
    if (!times.includes(time)) return time;
  }
  return '09:00';
}
