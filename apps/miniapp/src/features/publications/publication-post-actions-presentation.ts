import type { PublicationPostActions, PublicationPostPublish } from '@maxim/contracts/publication';

export function formatPublicationDeleteDelay(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} дн.`;
  if (minutes % 60 === 0) return `${minutes / 60} ч`;
  return `${minutes} мин`;
}

export function publicationPostPublishLabels(policy?: PublicationPostPublish): string[] {
  if (!policy) return [];
  return [
    ...(policy.pin === 'none'
      ? []
      : [policy.pin === 'notify' ? 'Закрепление с уведомлением' : 'Тихое закрепление']),
    ...(policy.deleteAfterMinutes === null
      ? []
      : [`Удаление через ${formatPublicationDeleteDelay(policy.deleteAfterMinutes)}`]),
  ];
}

export function publicationPostActionsPending(actions?: PublicationPostActions): boolean {
  return Boolean(
    actions &&
    [actions.pinStatus, actions.deleteStatus].some(
      (status) => status === 'PENDING' || status === 'RUNNING',
    ),
  );
}

export function publicationPostActionsPollingInterval(
  actions: PublicationPostActions | undefined,
  nowMs = Date.now(),
): number | false {
  if (!publicationPostActionsPending(actions) || !actions) return false;
  if (
    actions.pinStatus === 'PENDING' ||
    actions.pinStatus === 'RUNNING' ||
    actions.deleteStatus === 'RUNNING' ||
    !actions.deleteAt
  )
    return 5_000;
  return Math.max(5_000, Math.min(60_000, Date.parse(actions.deleteAt) - nowMs));
}

export function publicationPostActionLabels(
  actions: PublicationPostActions | undefined,
  timezone = 'Europe/Moscow',
): string[] {
  if (!actions) return [];
  const pinLabels: Record<PublicationPostActions['pinStatus'], string | null> = {
    NONE: null,
    PENDING: 'Ожидает закрепления',
    RUNNING: 'Закрепляется',
    DONE: 'Закреплён',
    FAILED: 'Не удалось закрепить',
    AMBIGUOUS: 'Закрепление требует проверки',
    SKIPPED: 'Закрепление пропущено: срок истёк',
  };
  const deleteLabels: Record<PublicationPostActions['deleteStatus'], string | null> = {
    NONE: null,
    PENDING: actions.deleteAt
      ? `Удаление ${new Intl.DateTimeFormat('ru-RU', {
          timeZone: timezone,
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(actions.deleteAt))}`
      : 'Ожидает автоудаления',
    RUNNING: 'Удаляется',
    DONE: 'Удалён',
    FAILED: 'Не удалось удалить',
    AMBIGUOUS: 'Удаление требует проверки',
    SKIPPED: 'Автоудаление отменено',
  };
  return [pinLabels[actions.pinStatus], deleteLabels[actions.deleteStatus]].filter(
    (value): value is string => Boolean(value),
  );
}
