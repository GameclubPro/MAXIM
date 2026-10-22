import { useEffect, useRef, type ReactNode } from 'react';
import type { SettingsFieldState } from '../../features/network-settings/field-model';

export function SharedAdvertisingFields({
  enabled,
  disabled,
  onChange,
  refresh,
}: {
  enabled: SettingsFieldState<boolean>;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
  refresh?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = enabled.kind === 'mixed';
  }, [enabled.kind]);
  return (
    <div className="advertising-workspace__row">
      <strong>
        {enabled.kind === 'mixed'
          ? 'Разные значения'
          : enabled.kind === 'loading'
            ? 'Загрузка…'
            : enabled.value
              ? 'Включена'
              : 'Выключена'}
      </strong>
      {refresh}
      <label className="settings-native-switch" aria-label="Включить рекламную площадку">
        <input
          ref={input}
          type="checkbox"
          checked={enabled.kind === 'common' && enabled.value}
          aria-checked={
            enabled.kind === 'mixed' ? 'mixed' : enabled.kind === 'common' && enabled.value
          }
          disabled={disabled || enabled.kind === 'loading'}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="toggle-switch" aria-hidden>
          <span className="toggle-switch__thumb" />
        </span>
      </label>
    </div>
  );
}
