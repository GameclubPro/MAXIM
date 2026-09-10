export function formatTimezoneLabel(timezone: string): string {
  if (timezone === 'Europe/Moscow') return 'Московское время';
  if (timezone === 'UTC' || timezone === 'Etc/UTC') return 'Всемирное время';
  try {
    return (
      new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, timeZoneName: 'longGeneric' })
        .formatToParts(new Date())
        .find((part) => part.type === 'timeZoneName')?.value ?? 'Часовой пояс не определён'
    );
  } catch {
    return 'Часовой пояс не определён';
  }
}
