import { useEffect, useRef } from 'react';
import { AppIcon } from '../../components/ui/app-icon';
import { SegmentedControl } from '../../components/ui/segmented-control';
import type { SettingsFieldState } from '../../features/network-settings/field-model';
import './settings-message-retention.css';

export type SharedMessageRetentionFieldsProps = {
  enabled: SettingsFieldState<boolean>;
  hours: SettingsFieldState<24 | 48>;
  disabled: boolean;
  enableDisabled?: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onHoursChange: (hours: 24 | 48) => void;
};

export function SharedMessageRetentionFields({
  enabled,
  hours,
  disabled,
  enableDisabled,
  onEnabledChange,
  onHoursChange,
}: SharedMessageRetentionFieldsProps) {
  const toggle = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (toggle.current) toggle.current.indeterminate = enabled.kind === 'mixed';
  }, [enabled.kind]);
  return (
    <>
      <div className="message-retention-settings__row">
        <label htmlFor="message-retention-enabled">Удаление по сроку</label>
        {enabled.kind === 'mixed' ? <span role="status">Разные значения</span> : null}
        <label className="settings-native-switch">
          <input
            ref={toggle}
            id="message-retention-enabled"
            type="checkbox"
            role="switch"
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
        Удаляем только новые сообщения, полученные после включения. Старую историю не очищаем. 24
        или 48 часов — минимальный возраст. Очистка ждёт периода низкой нагрузки, поэтому сообщения
        могут оставаться в чате дольше. После повторного включения учёт начинается заново. Удалённые
        сообщения восстановить нельзя.
      </p>
      <fieldset disabled={disabled || hours.kind === 'loading'}>
        <legend>Минимальный возраст сообщений</legend>
        {hours.kind === 'mixed' ? <p role="status">Разные значения</p> : null}
        <SegmentedControl
          ariaLabel="Минимальный возраст сообщений"
          value={hours.kind === 'common' ? String(hours.value) : ''}
          options={[
            { value: '24', label: '24 часа', disabled: disabled || hours.kind === 'loading' },
            { value: '48', label: '48 часов', disabled: disabled || hours.kind === 'loading' },
          ]}
          onChange={(value) => onHoursChange(value === '24' ? 24 : 48)}
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
        <p>Администраторы, закрепы, боты</p>
      </div>
    </div>
  );
}
