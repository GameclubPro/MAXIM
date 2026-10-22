import { AppIcon } from './ui/app-icon';
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import './admin-contact-toggle.css';
export function AdminContactToggleField({
  title,
  checked,
  selectedName,
  onChange,
  onOpen,
  ariaLabel,
  meta,
  nested = false,
  className,
  disabled = false,
  children,
}: {
  title: string;
  checked: boolean | 'mixed';
  selectedName: string;
  onChange: (enabled: boolean) => void;
  onOpen: () => void;
  ariaLabel: string;
  meta?: string;
  nested?: boolean;
  className?: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = checked === 'mixed';
  }, [checked]);
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
            ref={input}
            type="checkbox"
            checked={checked === true}
            aria-checked={checked === 'mixed' ? 'mixed' : checked}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>
      {checked ? (
        <button
          type="button"
          className="admin-contact-selection"
          disabled={disabled}
          onClick={onOpen}
          aria-label={`Выбрать администратора: ${selectedName}`}
          aria-haspopup="dialog"
        >
          <span>{selectedName}</span>
          <AppIcon
            icon="NavArrowRight"
            width="1.5em"
            height="1.5em"
            style={{ strokeWidth: 1.5 }}
            aria-hidden
          />
        </button>
      ) : null}
      {children}
    </div>
  );
}
