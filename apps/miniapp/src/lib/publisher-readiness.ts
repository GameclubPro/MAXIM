import type {
  PublisherEntityReadiness,
  PublisherReadinessBlockerCode,
} from '@maxim/contracts/publisher';
import { getPublisherReadinessLabel } from './publisher-readiness-label';

export type PublisherReadinessTone = 'ready' | 'disabled' | 'setup' | 'temporary';

export type PublisherReadinessPresentation = {
  label: string;
  detail: string;
  tone: PublisherReadinessTone;
};

export function canPreparePublisherPublicationTarget(target: {
  readiness?: PublisherEntityReadiness | null;
}): boolean {
  const readiness = target.readiness;
  // FLAG: Selecting a stale target only permits preparation. Submission still
  // requires the server's fresh actor/bot checks after the explicit access refresh.
  return (
    readiness?.canPublish === true ||
    ((readiness?.state === 'setup_required' || readiness?.state === 'temporarily_unavailable') &&
      (readiness.blockerCode === 'bot_access_expired' ||
        readiness.blockerCode === 'bot_access_unconfirmed'))
  );
}

const BLOCKER_PRESENTATION: Record<
  PublisherReadinessBlockerCode,
  Omit<PublisherReadinessPresentation, 'label'>
> = {
  policy_disabled: {
    detail: 'Включите Публик в настройках этого чата или канала.',
    tone: 'disabled',
  },
  bot_not_connected: {
    detail: 'Добавьте Публик в чат или канал и обновите проверку.',
    tone: 'setup',
  },
  bot_access_unconfirmed: {
    detail: 'Доступ Публика ещё не подтверждён. Обновите статус через несколько секунд.',
    tone: 'temporary',
  },
  bot_access_expired: {
    detail: 'Права Публика перепроверяются автоматически. Расписания сохранены.',
    tone: 'temporary',
  },
  bot_not_admin: {
    detail: 'Назначьте Публика администратором этого чата или канала.',
    tone: 'setup',
  },
  write_permission_missing: {
    detail: 'Разрешите Публику отправлять сообщения в этом чате или канале.',
    tone: 'setup',
  },
  route_quarantined: {
    detail: 'Отправка временно приостановлена. Повторите проверку позже.',
    tone: 'temporary',
  },
  publisher_runtime_unavailable: {
    detail: 'Публик пока не отвечает. Расписания сохранены.',
    tone: 'temporary',
  },
  module_disabled: {
    detail: 'Эта функция выключена.',
    tone: 'disabled',
  },
};

function formatPublisherRetryAt(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const retryAt = new Date(value);
  if (!Number.isFinite(retryAt.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(retryAt);
}

export function getPublisherReadinessPresentation(
  readiness: PublisherEntityReadiness | null | undefined,
): PublisherReadinessPresentation {
  if (!readiness) {
    return {
      label: getPublisherReadinessLabel(readiness),
      detail: 'Обновите список получателей.',
      tone: 'setup',
    };
  }

  if (readiness.blockerCode) {
    const retryAt =
      readiness.blockerCode === 'route_quarantined' ||
      readiness.blockerCode === 'bot_access_expired'
        ? formatPublisherRetryAt(readiness.retryAt)
        : null;
    return {
      label: getPublisherReadinessLabel(readiness),
      ...BLOCKER_PRESENTATION[readiness.blockerCode],
      ...(retryAt
        ? {
            detail:
              readiness.blockerCode === 'bot_access_expired'
                ? `Права Публика перепроверяются автоматически. Обновление статуса: ${retryAt}.`
                : `Следующая проверка: ${retryAt}.`,
          }
        : {}),
    };
  }

  switch (readiness.state) {
    case 'ready':
      return {
        label: getPublisherReadinessLabel(readiness),
        detail: 'Публик подключён и может отправлять сообщения.',
        tone: 'ready',
      };
    case 'disabled':
      return {
        label: getPublisherReadinessLabel(readiness),
        ...BLOCKER_PRESENTATION.policy_disabled,
      };
    case 'temporarily_unavailable':
      return {
        label: getPublisherReadinessLabel(readiness),
        detail: 'Повторите проверку позднее.',
        tone: 'temporary',
      };
    case 'setup_required':
      return {
        label: getPublisherReadinessLabel(readiness),
        detail: 'Проверьте подключение и права Публика.',
        tone: 'setup',
      };
  }
}

export function getPublisherReadinessPollingInterval(
  readiness: PublisherEntityReadiness | null | undefined,
  nowMs = Date.now(),
): number | false {
  if (readiness?.blockerCode !== 'bot_access_expired' || readiness.canPublish) {
    return false;
  }
  const retryAtMs = Date.parse(readiness.retryAt ?? '');
  return Number.isFinite(retryAtMs) ? Math.min(60_000, Math.max(5_000, retryAtMs - nowMs)) : 15_000;
}
