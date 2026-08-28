import type { PublicationSummary } from '@maxim/contracts/publication';
import { formatRussianCountLabel } from '../../lib/broadcast-audience';
import {
  formatLocalDateTimeInputValue,
  sortAndUniqueBroadcastSlots,
} from '../../lib/broadcast-schedule';
import type { PublicationFeedTone } from './publication-feed-card';
import {
  getPublicationActionableDelivery,
  getPublicationTargetTitle,
  type PublicationDraft,
  type PublicationTarget,
} from './publication-model';

export function formatDateTime(value: string | null, timezone = 'Europe/Moscow'): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(date);
}

export function formatDateInput(value: string | null): string {
  return value ? formatLocalDateTimeInputValue(value).slice(0, 10) : '';
}

export function formatTargetSummary(targets: readonly PublicationTarget[]): string {
  if (targets.length === 0) {
    return 'Выберите получателей';
  }
  if (targets.length === 1) {
    return targets[0] ? getPublicationTargetTitle(targets[0]) : '1 получатель';
  }
  const channels = targets.filter((target) => target.entityType === 'channel').length;
  const chats = targets.length - channels;
  return [
    chats ? formatRussianCountLabel(chats, 'чат', 'чата', 'чатов') : '',
    channels ? formatRussianCountLabel(channels, 'канал', 'канала', 'каналов') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function formatLoadedCount(count: number, hasMore: boolean): string {
  return `${count}${hasMore ? '+' : ''}`;
}

export function formatPublicationTargets(publication: PublicationSummary): string {
  if (publication.targetCount === 0) {
    return 'Нет получателей';
  }
  if (publication.targetCount === 1) {
    return publication.targetPreviews[0]?.title ?? '1 получатель';
  }
  return formatRussianCountLabel(
    publication.targetCount,
    'получатель',
    'получателя',
    'получателей',
  );
}

function formatRecurrence(draft: PublicationDraft): string {
  if (
    !draft.recurrence.startsAt ||
    draft.recurrence.times.length === 0 ||
    (draft.recurrence.frequency === 'weekly' && draft.recurrence.weekdays.length === 0)
  ) {
    return 'Настройте повтор';
  }
  const interval = draft.recurrence.interval;
  const frequency =
    draft.recurrence.frequency === 'daily'
      ? interval === 1
        ? 'Каждый день'
        : `Каждые ${interval} дн.`
      : interval === 1
        ? 'Каждую неделю'
        : `Каждые ${interval} нед.`;
  return `${frequency} · ${draft.recurrence.times.join(', ')}`;
}

export function formatDraftTiming(draft: PublicationDraft): string {
  if (draft.timingMode === 'now') {
    return 'Сейчас';
  }
  if (draft.timingMode === 'once') {
    return (
      formatDateTime(draft.scheduledSlots[0] ?? null, draft.scheduleTimezone) || 'Время не выбрано'
    );
  }
  if (draft.scheduleKind === 'recurrence') {
    return formatRecurrence(draft);
  }
  const slots = sortAndUniqueBroadcastSlots(draft.scheduledSlots);
  if (slots.length === 0) {
    return 'Время не выбрано';
  }
  return slots.length === 1
    ? formatDateTime(slots[0] ?? null, draft.scheduleTimezone)
    : formatRussianCountLabel(slots.length, 'отправка', 'отправки', 'отправок');
}

export function formatPublicationSchedule(publication: PublicationSummary): string {
  const schedule = publication.schedule;
  if (!schedule) {
    return 'Черновик';
  }
  if (schedule.mode === 'now') {
    return 'Сейчас';
  }
  if (schedule.mode === 'once') {
    return `Следующая · ${formatDateTime(schedule.at, schedule.timezone)}`;
  }
  if (schedule.mode === 'slots') {
    if (schedule.nextOccurrenceAt) {
      return `Следующая · ${formatDateTime(schedule.nextOccurrenceAt, schedule.timezone)}`;
    }
    return formatRussianCountLabel(schedule.slots.length, 'отправка', 'отправки', 'отправок');
  }
  const interval = schedule.interval;
  const frequency =
    schedule.frequency === 'daily'
      ? interval === 1
        ? 'Каждый день'
        : `Каждые ${interval} дн.`
      : interval === 1
        ? 'Каждую неделю'
        : `Каждые ${interval} нед.`;
  const next = schedule.nextOccurrenceAt
    ? `Следующая · ${formatDateTime(schedule.nextOccurrenceAt, schedule.timezone)}`
    : '';
  return next || `${frequency} · ${schedule.times.join(', ')}`;
}

export function getLifecycleTone(publication: PublicationSummary): PublicationFeedTone {
  const delivery = getPublicationActionableDelivery(publication);
  if (publication.lifecycle === 'ERROR' || delivery.ambiguous > 0) {
    return 'danger';
  }
  if (publication.lifecycle === 'PAUSED' || delivery.failed > 0) {
    return 'warning';
  }
  if (publication.lifecycle === 'COMPLETED' || publication.lifecycle === 'CANCELED') {
    return 'muted';
  }
  return 'active';
}

export function getRecurrenceError(draft: PublicationDraft): string {
  if (!draft.recurrence.startsAt) {
    return 'Выберите дату начала.';
  }
  if (!Number.isFinite(Date.parse(draft.recurrence.startsAt))) {
    return 'Выберите корректную дату начала.';
  }
  if (draft.recurrence.times.length === 0) {
    return 'Добавьте хотя бы одно время.';
  }
  if (draft.recurrence.frequency === 'weekly' && draft.recurrence.weekdays.length === 0) {
    return 'Выберите хотя бы один день недели.';
  }
  if (new Set(draft.recurrence.times).size !== draft.recurrence.times.length) {
    return 'Время не должно повторяться.';
  }
  if (
    draft.recurrence.startsAt &&
    draft.recurrence.endsAt &&
    Date.parse(draft.recurrence.endsAt) <= Date.parse(draft.recurrence.startsAt)
  ) {
    return 'Дата завершения должна быть позже даты начала.';
  }
  return '';
}
