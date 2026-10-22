import { useEffect, useRef, type ReactNode } from 'react';
import type { SettingsFieldState } from '../../features/network-settings/field-model';

export function SharedNativeSettingsToggle({
  state,
  title,
  label,
  disabled,
  onChange,
  actions,
  hint,
  nested = false,
  className = '',
  children,
}: {
  state: SettingsFieldState<boolean>;
  title: string;
  label: string;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
  actions?: ReactNode;
  hint?: ReactNode;
  nested?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = state.kind === 'mixed';
  }, [state.kind]);
  return (
    <div
      className={`settings-native-toggle${nested ? ' settings-native-toggle--nested' : ''} ${className}`}
    >
      <div className="settings-native-toggle__row">
        <div className="settings-native-toggle__title-wrap">
          <span className="settings-native-toggle__title">{title}</span>
          {hint}
          {actions ? <div className="settings-native-toggle__title-actions">{actions}</div> : null}
        </div>
        <label className="settings-native-switch" aria-label={label}>
          <input
            ref={input}
            type="checkbox"
            checked={state.kind === 'common' && state.value}
            aria-checked={state.kind === 'mixed' ? 'mixed' : state.kind === 'common' && state.value}
            disabled={disabled || state.kind === 'loading'}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>
      {state.kind !== 'common' ? (
        <p className="field__hint">{state.kind === 'mixed' ? 'Разные значения' : 'Загрузка…'}</p>
      ) : null}
      {children}
    </div>
  );
}
