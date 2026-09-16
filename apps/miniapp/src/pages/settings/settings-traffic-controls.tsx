import type { SettingsLimitsSectionProps } from './settings-limits-section';

const controls = [
  { enabled: 'slowModeEnabled', interval: 'slowModeIntervalSeconds', title: 'Медленный режим' },
  {
    enabled: 'mediaMessageCooldownEnabled',
    interval: 'mediaMessageCooldownSeconds',
    title: 'Интервал медиа',
  },
] as const;

export function SettingsTrafficControls({
  draft,
  setFieldValue,
  fieldErrors,
}: Pick<SettingsLimitsSectionProps, 'draft' | 'setFieldValue' | 'fieldErrors'>) {
  return controls.map(({ enabled, interval, title }) => (
    <div className="settings-native-toggle" key={enabled}>
      <div className="settings-native-toggle__row">
        <span className="settings-native-toggle__title">{title}</span>
        <label className="settings-native-switch" aria-label={title}>
          <input
            type="checkbox"
            checked={draft[enabled]}
            onChange={(event) => setFieldValue(enabled, event.target.checked)}
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>
      {draft[enabled] ? (
        <div className="settings-native-toggle__row">
          <label
            className="settings-native-toggle__title settings-native-toggle__title--sub"
            htmlFor={interval}
          >
            Интервал, с
          </label>
          <input
            id={interval}
            className="field__input"
            type="number"
            inputMode="numeric"
            min={10}
            max={86400}
            step={1}
            value={draft[interval]}
            style={{ width: 88, flex: '0 0 88px' }}
            aria-label={`${title}: интервал в секундах`}
            aria-invalid={Boolean(fieldErrors[interval])}
            aria-describedby={fieldErrors[interval] ? `${interval}-error` : undefined}
            onChange={(event) => setFieldValue(interval, Number(event.target.value))}
          />
        </div>
      ) : null}
      {fieldErrors[interval] ? (
        <small id={`${interval}-error`} className="field__hint" role="alert">
          {fieldErrors[interval]}
        </small>
      ) : null}
    </div>
  ));
}
