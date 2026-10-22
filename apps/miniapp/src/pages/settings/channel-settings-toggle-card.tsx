import { useEffect, useRef } from 'react';
import type { SettingsFieldState } from '../../features/network-settings/field-model';
import { cn } from '../../lib/cn';

export function ChannelSettingsToggleCard({
  title,
  state,
  disabled,
  onChange,
  describedBy,
  error,
}: {
  title: string;
  state: SettingsFieldState<boolean>;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
  describedBy?: string;
  error?: string | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = state.kind === 'mixed';
  }, [state.kind]);
  const checked = state.kind === 'common' && state.value;
  const blocked = disabled || state.kind === 'loading';
  return (
    <>
      <div
        className={cn('channel-settings-toggle-card', checked && 'is-on', blocked && 'is-disabled')}
        onClick={(event) => {
          if (
            blocked ||
            (event.target as HTMLElement).closest(
              'button, input, label, .channel-settings-hint-anchor, .settings-native-toggle__hint',
            )
          )
            return;
          onChange(!checked);
        }}
      >
        <div className="channel-settings-toggle-card__copy">
          <div className="channel-settings-toggle-card__title-row">
            <strong>{title}</strong>
          </div>
          {state.kind === 'mixed' ? <span>Разные значения</span> : null}
        </div>
        <label className="settings-native-switch">
          <input
            ref={input}
            type="checkbox"
            checked={checked}
            aria-label={title}
            aria-checked={state.kind === 'mixed' ? 'mixed' : checked}
            aria-describedby={describedBy}
            disabled={blocked}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>
      {error ? (
        <small className="field__hint" role="alert">
          {error}
        </small>
      ) : null}
    </>
  );
}
