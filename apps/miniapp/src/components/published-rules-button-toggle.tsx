export type PublishedRulesButtonToggleProps = {
  ariaLabel: string;
  enabled: boolean;
  hasRules: boolean;
  onChange: (enabled: boolean) => void;
};

export default function PublishedRulesButtonToggle({
  ariaLabel,
  enabled,
  hasRules,
  onChange,
}: PublishedRulesButtonToggleProps) {
  if (!hasRules && !enabled) {
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
            type="checkbox"
            checked={enabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>
      {!hasRules ? (
        <p className="settings-native-toggle__hint">Сначала опубликуйте правила.</p>
      ) : null}
    </div>
  );
}
