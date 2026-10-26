import { useEffect, useRef } from 'react';
import { AppIcon } from '../../components/ui/app-icon';
import { SegmentedControl } from '../../components/ui/segmented-control';
import type { SettingsFieldState } from '../../features/network-settings/field-model';
import type { MessageRetentionState } from '@maxim/contracts/settings';
import { LASTIK_BOT_URL, openLastikBot } from '../../lib/lastik-bot';
import './shared-message-retention-fields.css';

export type SharedMessageRetentionFieldsProps = {
  enabled: SettingsFieldState<boolean>;
  hours: SettingsFieldState<24 | 48 | 168>;
  disabled: boolean;
  enableDisabled?: boolean;
  scope?: 'chat' | 'network';
  connectionStatus?: MessageRetentionState['connectionStatus'];
  connectionRequest?: MessageRetentionState['connectionRequest'];
  connectionActionsDisabled?: boolean;
  onConnect?: () => void;
  onCancelConnection?: () => void;
  onEnabledChange: (enabled: boolean) => void;
  onHoursChange: (hours: 24 | 48 | 168) => void;
};

const connectionCopy = {
  connected: { title: '«Ластик» подключён', description: null },
  missing: {
    title: 'Подключите «Ластика»',
    description:
      'Добавьте «Ластика» в чат администратором с правами чтения всех сообщений и удаления.',
  },
  no_access: {
    title: '«Ластику» нужны права',
    description: 'Назначьте «Ластика» администратором с правами чтения всех сообщений и удаления.',
  },
  unknown: {
    title: 'Бот «Ластик»',
    description:
      'Добавьте «Ластика» в чат администратором с правами чтения всех сообщений и удаления.',
  },
  network: {
    title: '«Ластик» для чатов сетки',
    description:
      'Добавьте «Ластика» в каждый нужный чат администратором с правами чтения всех сообщений и удаления.',
  },
};

export function SharedMessageRetentionFields({
  enabled,
  hours,
  disabled,
  enableDisabled,
  scope = 'chat',
  connectionStatus,
  connectionRequest,
  connectionActionsDisabled,
  onConnect,
  onCancelConnection,
  onEnabledChange,
  onHoursChange,
}: SharedMessageRetentionFieldsProps) {
  const toggle = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (toggle.current) toggle.current.indeterminate = enabled.kind === 'mixed';
  }, [enabled.kind]);
  const requestStatus = scope === 'chat' ? connectionRequest?.status : undefined;
  const pending = requestStatus === 'pending';
  const connectionState =
    requestStatus ?? (scope === 'network' ? 'network' : (connectionStatus ?? 'unknown'));
  const connected = connectionState === 'connected';
  const copy = connectionCopy[scope === 'network' ? 'network' : (connectionStatus ?? 'unknown')];
  const title = pending
    ? 'Ожидаем подключения «Ластика»'
    : requestStatus === 'expired'
      ? 'Время ожидания истекло'
      : requestStatus === 'cancelled'
        ? 'Подключение отменено'
        : copy.title;
  const description = copy.description;
  return (
    <>
      <div className="message-retention-controls">
        <div className="message-retention-settings__row">
          <div className="message-retention-settings__row-copy">
            <label htmlFor="message-retention-enabled">Удаление по сроку</label>
            {enabled.kind === 'mixed' ? <span role="status">Разные значения</span> : null}
          </div>
          <label className="settings-native-switch">
            <input
              ref={toggle}
              id="message-retention-enabled"
              type="checkbox"
              role={enabled.kind === 'mixed' ? 'checkbox' : 'switch'}
              checked={enabled.kind === 'common' && enabled.value}
              aria-checked={
                enabled.kind === 'mixed' ? 'mixed' : enabled.kind === 'common' && enabled.value
              }
              disabled={disabled || enableDisabled || enabled.kind === 'loading'}
              onChange={(event) => onEnabledChange(event.target.checked)}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
        <fieldset disabled={disabled || hours.kind === 'loading'}>
          <legend>Удалять сообщения старше</legend>
          {hours.kind === 'mixed' ? <p role="status">Разные значения</p> : null}
          <SegmentedControl
            ariaLabel="Удалять сообщения старше"
            value={hours.kind === 'common' ? String(hours.value) : null}
            options={[
              { value: '24', label: '24 часа', disabled: disabled || hours.kind === 'loading' },
              { value: '48', label: '48 часов', disabled: disabled || hours.kind === 'loading' },
              { value: '168', label: '1 неделя', disabled: disabled || hours.kind === 'loading' },
            ]}
            onChange={(value) => onHoursChange(value === '24' ? 24 : value === '168' ? 168 : 48)}
          />
        </fieldset>
      </div>
      <div className="message-retention-bot" data-connection-state={connectionState}>
        <span className="message-retention-bot__icon" aria-hidden>
          <AppIcon icon={connected ? 'Check' : 'Trash'} />
        </span>
        <div className="message-retention-bot__copy" aria-live="polite">
          <strong>{title}</strong>
          {description ? <p>{description}</p> : null}
          {pending && connectionRequest ? (
            <p>
              Проверяем права до{' '}
              <time dateTime={connectionRequest.expiresAt}>
                {new Date(connectionRequest.expiresAt).toLocaleTimeString('ru-RU', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
              . Очистка включится автоматически — возвращаться сюда не нужно.
            </p>
          ) : requestStatus ? (
            <p>Запустите подключение снова, когда бот будет готов.</p>
          ) : null}
        </div>
        <div className="message-retention-bot__actions">
          {onConnect && !connected && !pending ? (
            <button
              type="button"
              className="button button--accent message-retention-bot__link"
              disabled={connectionActionsDisabled}
              onClick={onConnect}
            >
              {requestStatus ? 'Проверить и включить' : 'Подключить и включить'}
              <AppIcon icon="NavArrowRight" aria-hidden />
            </button>
          ) : null}
          {!onConnect || connected || pending ? (
            <a
              className={`button ${connected ? 'button--ghost' : 'button--accent'} message-retention-bot__link`}
              href={LASTIK_BOT_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={openLastikBot}
            >
              {connected ? 'Профиль бота' : 'Открыть Ластика'}
              {connected ? null : <AppIcon icon="NavArrowRight" aria-hidden />}
            </a>
          ) : null}
          {pending && onCancelConnection ? (
            <button
              type="button"
              className="button button--ghost message-retention-bot__link"
              disabled={connectionActionsDisabled}
              onClick={onCancelConnection}
            >
              Отменить подключение
            </button>
          ) : null}
        </div>
      </div>
      <p className="message-retention-policy">
        Сообщения старше выбранного срока удаляются без возможности восстановления.
      </p>
      <details className="message-retention-help">
        <summary>Как работает очистка</summary>
        <p>
          Удаляются сообщения любых авторов из всей доступной истории, включая сообщения до
          включения. Большая история очищается постепенно.
        </p>
        <p>Срок отсчитывается от создания сообщения. Редактирование не продлевает срок хранения.</p>
      </details>
    </>
  );
}

export function SharedMessageRetentionExclusions() {
  return (
    <div className="message-retention-exclusions">
      <AppIcon
        icon="ShieldCheck"
        width="1.5em"
        height="1.5em"
        style={{ strokeWidth: 1.5 }}
        aria-hidden
      />
      <div>
        <span>Не удаляются</span>
        <p>
          Все закреплённые сообщения. Также сохраняются правила, объявления розыгрышей и их итоги из
          наших модулей.
        </p>
      </div>
    </div>
  );
}
