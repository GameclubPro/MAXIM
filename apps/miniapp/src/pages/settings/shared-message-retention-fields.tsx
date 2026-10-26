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
  onEnabledChange: (enabled: boolean) => void;
  onHoursChange: (hours: 24 | 48 | 168) => void;
};

export function SharedMessageRetentionFields({
  enabled,
  hours,
  disabled,
  enableDisabled,
  scope = 'chat',
  connectionStatus,
  onEnabledChange,
  onHoursChange,
}: SharedMessageRetentionFieldsProps) {
  const toggle = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (toggle.current) toggle.current.indeterminate = enabled.kind === 'mixed';
  }, [enabled.kind]);
  return (
    <>
      <div className="message-retention-bot">
        <span className="message-retention-bot__icon" aria-hidden>
          <AppIcon icon="Trash" />
        </span>
        <div className="message-retention-bot__copy">
          <strong>
            {scope === 'chat' && connectionStatus === 'connected'
              ? '«Ластик» подключён'
              : 'Бот «Ластик»'}
          </strong>
          {scope === 'network' ? (
            <p>
              Добавьте «Ластика» администратором в чаты сетки с правами чтения и удаления сообщений.
            </p>
          ) : connectionStatus !== 'connected' ? (
            <p>
              {connectionStatus === 'no_access'
                ? 'Назначьте бота администратором с правами чтения и удаления сообщений.'
                : 'Добавьте бота в чат администратором с правами чтения и удаления сообщений.'}
            </p>
          ) : null}
        </div>
        <a
          className="button button--accent message-retention-bot__link"
          href={LASTIK_BOT_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={openLastikBot}
        >
          Открыть бота «Ластик»
          <AppIcon icon="NavArrowRight" aria-hidden />
        </a>
      </div>
      <div className="message-retention-settings__row">
        <label htmlFor="message-retention-enabled">Удаление по сроку</label>
        {enabled.kind === 'mixed' ? <span role="status">Разные значения</span> : null}
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
        <span>Исключения</span>
        <p>Закрепы, правила, объявления розыгрышей и их итоги из наших модулей</p>
      </div>
    </div>
  );
}
