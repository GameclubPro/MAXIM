import type { ChatClosureStatus, NightModeNoticeObservation } from '@maxim/contracts/settings';
import { formatTimezoneLabel } from '../../lib/timezone-label';

function formatTime(value: string, timezone: string) {
  try {
    return new Date(value).toLocaleString('ru-RU', {
      timeZone: timezone,
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'время не определено';
  }
}

function NoticeStatus({
  title,
  observation,
  timezone,
  continuous,
}: {
  title: string;
  observation: NightModeNoticeObservation;
  timezone: string;
  continuous: boolean;
}) {
  const latest = observation.latest;
  const outcome = latest?.delivery.outcome;
  return (
    <section className="night-status__notice" aria-label={title}>
      <div className="night-status__notice-heading">
        <strong>{title}</strong>
        <span>{observation.enabledNow ? 'Сейчас включено' : 'Сейчас выключено'}</span>
      </div>
      {latest ? (
        <>
          <p className="night-status__date">
            По расписанию: {formatTime(latest.scheduledFor, timezone)}
          </p>
          <p className="night-status__result" data-outcome={outcome}>
            {
              {
                sent: 'Отправлено',
                not_recorded: 'Нет подтверждения отправки',
                pending: 'Отправка ещё не подтверждена',
                not_sent: 'Не отправлено — ошибка до отправки',
                unknown: 'Результат отправки неизвестен',
              }[latest.delivery.outcome]
            }
            {outcome === 'sent' && latest.delivery.sentAt
              ? ` · ${formatTime(latest.delivery.sentAt, timezone)}`
              : ''}
          </p>
          {outcome !== 'sent' && latest.catchUp.state === 'expired' ? (
            <p className="night-status__detail">Время для отложенной отправки истекло.</p>
          ) : outcome === 'pending' ? (
            <p className="night-status__detail">Ожидает первой попытки.</p>
          ) : null}
        </>
      ) : (
        <p className="night-status__detail">
          {continuous
            ? 'В этом расписании нет ежедневного перехода.'
            : 'Данные о последнем событии недоступны.'}
        </p>
      )}
    </section>
  );
}

export default function SettingsChatClosureStatus({
  status,
  refreshFailed = false,
}: {
  status: ChatClosureStatus;
  refreshFailed?: boolean;
}) {
  const notices = status.notices;
  const actionRequired = [
    ...new Set(
      notices?.recovery.obligations
        .filter((entry) => entry.state === 'action_required')
        .map((entry) => entry.kind),
    ),
  ];
  return (
    <div className="night-status" role="status">
      {refreshFailed ? (
        <p className="night-status__warning">
          Не удалось обновить статус. Показаны данные последней проверки.
        </p>
      ) : null}
      <strong className="night-status__heading">
        {refreshFailed ? 'На момент проверки: ' : 'Сейчас '}
        {status.restriction === 'open' ? 'группа открыта' : 'действует ограничение'}
      </strong>
      <p>
        {formatTimezoneLabel(status.timezone)}
        {status.opensAt ? ` · Открытие: ${formatTime(status.opensAt, status.timezone)}` : ''}
      </p>
      {!status.scheduleEnabled ? <p>Ночное расписание сейчас выключено.</p> : null}
      {notices?.boundary === 'continuous' ? (
        <p>Круглосуточное расписание: время начала и окончания совпадает.</p>
      ) : null}
      <p>
        Удаление сообщений:{' '}
        {
          {
            available: 'права подтверждены',
            unavailable: 'недоступно — проверьте подключение бота',
            unknown: 'права пока не подтверждены',
          }[status.deleteRoute]
        }
        .
      </p>
      {notices ? (
        <>
          {notices.sendRouteNow !== 'available' ? (
            <p className="night-status__warning">
              {notices.sendRouteNow === 'unavailable'
                ? 'Отправка сейчас недоступна — проверьте подключение бота.'
                : 'Доступность отправки сейчас не подтверждена.'}
            </p>
          ) : null}
          <p className="night-status__caption">Последние даты по сохранённому расписанию</p>
          <NoticeStatus
            title="Уведомление о закрытии"
            observation={notices.close}
            timezone={status.timezone}
            continuous={notices.boundary === 'continuous'}
          />
          <NoticeStatus
            title="Уведомление об открытии"
            observation={notices.open}
            timezone={status.timezone}
            continuous={notices.boundary === 'continuous'}
          />
          {actionRequired.map((kind) => (
            <p className="night-status__warning" key={kind}>
              {
                {
                  close_notice_event: 'Нужна проверка восстановления уведомления о закрытии.',
                  open_notice_event: 'Нужна проверка восстановления уведомления об открытии.',
                  close_notice_cleanup: 'Нужна проверка удаления прежнего сообщения о закрытии.',
                }[kind]
              }
            </p>
          ))}
          {notices.recovery.observation !== 'complete' ? (
            <p className="night-status__detail">
              Проверка восстановления{' '}
              {notices.recovery.observation === 'partial' ? 'неполная' : 'временно недоступна'}.
            </p>
          ) : null}
        </>
      ) : (
        <>
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
          <p className="night-status__detail">Данные об уведомлении об открытии пока недоступны.</p>
        </>
      )}
      {status.recovery === 'delayed' ? (
        <p className="night-status__warning">Восстановление задерживается.</p>
      ) : null}
      {status.recovery === 'action_required' && !actionRequired.length ? (
        <p className="night-status__warning">Восстановление требует проверки.</p>
      ) : null}
      <small className="night-status__checked">
        Проверено: {formatTime(status.observedAt, status.timezone)}.
      </small>
    </div>
  );
}
