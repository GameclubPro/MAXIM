import { cn } from '../lib/cn';

type AdminContactToggleProps = {
  title: string;
  checked: boolean;
  onChange: (enabled: boolean) => void;
  ariaLabel: string;
  meta?: string;
  nested?: boolean;
  className?: string;
};

export function AdminContactToggle({
  title,
  checked,
  onChange,
  ariaLabel,
  meta,
  nested = false,
  className,
}: AdminContactToggleProps) {
  return (
    <div
      className={cn(
        'settings-native-toggle',
        nested && 'settings-native-toggle--nested',
        className,
      )}
    >
      <div className="settings-native-toggle__row">
        {meta ? (
          <div className="settings-native-toggle__title-wrap">
            <div className="rules-native-card__copy">
              <span className="settings-native-toggle__title">{title}</span>
              <span className="rules-native-card__meta">{meta}</span>
            </div>
          </div>
        ) : (
          <span className="settings-native-toggle__title">{title}</span>
        )}

        <label className="settings-native-switch" aria-label={ariaLabel}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>
    </div>
  );
}
