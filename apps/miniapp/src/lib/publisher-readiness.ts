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
    tone: 'setup',
  },
  bot_access_expired: {
    detail: 'Права Публика давно не проверялись. Обновите статус через несколько секунд.',
    tone: 'setup',
  },
  bot_not_admin: {
    detail: 'Назначьте Публика администратором этого чата или канала.',
    tone: 'setup',
  },
  write_permission_missing: {
    detail: 'Включите доступ ко всем сообщениям и право отправлять сообщения.',
    tone: 'setup',
  },
  route_quarantined: {
    detail: 'Маршрут временно остановлен после ошибки. Повторите проверку позднее.',
    tone: 'temporary',
  },
  publisher_runtime_unavailable: {
    detail: 'Сервис отправки не отвечает. Созданные расписания сохранятся.',
    tone: 'temporary',
  },
  module_disabled: {
    detail: 'Включите модуль в кабинете Публика.',
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
      readiness.blockerCode === 'route_quarantined'
        ? formatPublisherRetryAt(readiness.retryAt)
        : null;
    return {
      label: getPublisherReadinessLabel(readiness),
      ...BLOCKER_PRESENTATION[readiness.blockerCode],
      ...(retryAt ? { detail: `Отправка восстановится автоматически после ${retryAt}.` } : {}),
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
