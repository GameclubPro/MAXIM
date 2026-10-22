import { useEffect, useRef } from 'react';

export type PublishedRulesButtonToggleProps = {
  ariaLabel: string;
  enabled: boolean;
  hasRules?: boolean;
  mixed?: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
};

export default function PublishedRulesButtonToggle({
  ariaLabel,
  enabled,
  hasRules,
  mixed = false,
  disabled = false,
  onChange,
}: PublishedRulesButtonToggleProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = mixed;
  }, [mixed]);
  if (hasRules === false && !enabled && !mixed) {
    return (
      <div className="settings-native-toggle settings-native-toggle--nested">
        <div className="settings-native-toggle__row">
          <span className="settings-native-toggle__title">Кнопка «Правила»</span>
        </div>
        <p className="settings-native-toggle__hint">Сначала опубликуйте правила.</p>
      </div>
    );
  }

  return (
    <div className="settings-native-toggle settings-native-toggle--nested">
      <div className="settings-native-toggle__row">
        <div className="settings-native-toggle__title-wrap">
          <span className="settings-native-toggle__title">Кнопка «Правила»</span>
        </div>

        <label className="settings-native-switch" aria-label={ariaLabel}>
          <input
            ref={input}
            type="checkbox"
            checked={enabled}
            disabled={disabled}
            aria-checked={mixed ? 'mixed' : enabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>
      {mixed ? <p className="field__hint">Разные значения</p> : null}
      {hasRules === false ? (
        <p className="settings-native-toggle__hint">Сначала опубликуйте правила.</p>
      ) : null}
    </div>
  );
}
