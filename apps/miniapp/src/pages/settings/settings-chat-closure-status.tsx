import type { ChatClosureStatus } from '@maxim/contracts/settings';

export default function SettingsChatClosureStatus({ status }: { status: ChatClosureStatus }) {
  return (
    <div className="settings-native-toggle" role="status">
      <strong>
        {status.restriction === 'open' ? 'Сейчас группа открыта' : 'Сейчас действует ограничение'}
      </strong>
      <p>
        {status.timezone}
        {status.opensAt
          ? ` · Открытие: ${new Date(status.opensAt).toLocaleString('ru-RU', { timeZone: status.timezone })}`
          : ''}
      </p>
      <p>
        Удаление:{' '}
        {
          {
            available: 'права подтверждены',
            unavailable: 'нет подходящего бота — проверьте подключение',
            unknown: 'состояние пока неизвестно',
          }[status.deleteRoute]
        }
        .
      </p>
      <p>
        Уведомление о закрытии:{' '}
        {
          {
            delivered: 'доставлено',
            disabled: 'выключено',
            not_expected: 'сейчас не ожидается',
            not_recorded: 'нет подтверждения отправки',
            pending: 'ожидает отправки',
            unknown: 'результат неизвестен',
            failed: 'не доставлено',
          }[status.notice]
        }
        .
      </p>
      {status.recovery === 'delayed' || status.recovery === 'action_required' ? (
        <p>Восстановление задерживается.</p>
      ) : null}
      <small>
        Сохранённые данные на {new Date(status.observedAt).toLocaleTimeString('ru-RU')}.
      </small>
    </div>
  );
}
