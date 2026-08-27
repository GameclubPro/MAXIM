import type {
  PublisherEntityReadiness,
  PublisherReadinessBlockerCode,
} from '@maxim/contracts/publisher';

const BLOCKER_LABELS: Record<PublisherReadinessBlockerCode, string> = {
  policy_disabled: 'Публик выключен',
  bot_not_connected: 'Публик не добавлен',
  bot_access_unconfirmed: 'Проверяем доступ',
  bot_access_expired: 'Доступ нужно обновить',
  bot_not_admin: 'Публик не администратор',
  write_permission_missing: 'Нет права публиковать',
  route_quarantined: 'Отправка приостановлена',
  publisher_runtime_unavailable: 'Публик временно недоступен',
  module_disabled: 'Модуль выключен',
};

export function getPublisherReadinessLabel(
  readiness: PublisherEntityReadiness | null | undefined,
): string {
  if (!readiness) {
    return 'Статус не проверен';
  }
  if (readiness.blockerCode) {
    return BLOCKER_LABELS[readiness.blockerCode];
  }
  switch (readiness.state) {
    case 'ready':
      return 'Готов к публикации';
    case 'disabled':
      return BLOCKER_LABELS.policy_disabled;
    case 'temporarily_unavailable':
      return 'Временно недоступен';
    case 'setup_required':
      return 'Требуется настройка';
  }
}
