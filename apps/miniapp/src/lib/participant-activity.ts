import type { ChatParticipantActivityFilter, ChatParticipantItem } from '@maxim/contracts';

export const PARTICIPANT_ACTIVITY_OPTIONS: {
  value: ChatParticipantActivityFilter;
  label: string;
}[] = [
  { value: 'all', label: 'Любая активность' },
  { value: '7d', label: 'Не был 7+ дней' },
  { value: '14d', label: 'Не был 14+ дней' },
  { value: '30d', label: 'Не был 30+ дней' },
  { value: '60d', label: 'Не был 60+ дней' },
  { value: '90d', label: 'Не был 90+ дней' },
  { value: 'unknown', label: 'Нет данных' },
];

export function describeParticipantActivity(
  item: Pick<ChatParticipantItem, 'lastMaxActivityAt' | 'activityCheckedAt'>,
  nowMs = Date.now(),
): { label: string; detail: string; tone: string } {
  const checked = item.activityCheckedAt ? Date.parse(item.activityCheckedAt) : NaN;
  if (Number.isFinite(checked) && nowMs - checked > 86_400_000) {
    return {
      label: 'Данные устарели',
      detail: 'Последняя активность в MAX не обновлена',
      tone: 'unknown',
    };
  }
  const at = item.lastMaxActivityAt ? Date.parse(item.lastMaxActivityAt) : NaN;
  if (!Number.isFinite(checked) || !Number.isFinite(at) || at <= 0 || at > nowMs) {
    return {
      label: 'Нет данных',
      detail: 'Последняя активность в MAX недоступна',
      tone: 'unknown',
    };
  }
  const days = Math.floor((nowMs - at) / 86_400_000);
  const threshold = [90, 60, 30, 14, 7].find((value) => days >= value);
  return {
    label: threshold ? `${threshold}+ дней` : days >= 1 ? `${days} д назад` : 'Был недавно',
    detail: `Последняя активность в MAX: ${new Date(at).toLocaleString('ru-RU')}`,
    tone: threshold && threshold >= 30 ? 'long' : threshold ? 'week' : 'recent',
  };
}
