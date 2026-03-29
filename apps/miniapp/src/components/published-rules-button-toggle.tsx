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

      <p className="settings-native-toggle__hint">
        Кнопка использует опубликованные правила из блока «Правила».
        {hasRules
          ? ' Сейчас публикация найдена.'
          : ' Сейчас публикации нет, поэтому кнопка пока не появится.'}
      </p>
    </div>
  );
}
