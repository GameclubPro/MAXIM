import type { ChannelStatsRange } from '@maxim/contracts/channel-stats';

export const periodOptions: Array<{ value: ChannelStatsRange; label: string }> = [
  { value: '24h', label: '24ч' },
  { value: '7d', label: '7д' },
  { value: '30d', label: '30д' },
];

const COUNT_FORMATTER = new Intl.NumberFormat('ru-RU');

const DATE_ONLY_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'short',
  timeZone: 'Europe/Moscow',
});

export function formatCount(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  return COUNT_FORMATTER.format(value);
}

function formatDateOnly(value: string | null): string {
  if (!value) {
    return '—';
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return '—';
  }

  return DATE_ONLY_FORMATTER.format(parsed);
}

export function formatPeriodRange(from: string, to: string): string {
  return `${formatDateOnly(from)} — ${formatDateOnly(to)}`;
}
