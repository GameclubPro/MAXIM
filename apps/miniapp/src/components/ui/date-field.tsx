import { Calendar } from 'iconoir-react';
import { forwardRef, useId } from 'react';
import { cn } from '../../lib/cn';
import './date-field.css';

type DateFieldProps = {
  value: string;
  label: string;
  min?: string;
  disabled?: boolean;
  error?: string;
  placeholder?: string;
  variant?: 'default' | 'embedded';
  className?: string;
  onChange: (nextValue: string) => void;
};

function formatDate(value: string, placeholder: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : placeholder;
}

export const DateField = forwardRef<HTMLInputElement, DateFieldProps>(function DateField(
  {
    value,
    label,
    min,
    disabled = false,
    error,
    placeholder = 'Не задано',
    variant = 'default',
    className,
    onChange,
  },
  ref,
) {
  const reactId = useId();
  const errorId = error ? `date-field-${reactId}-error` : undefined;

  return (
    <label
      className={cn(
        'date-field',
        `date-field--${variant}`,
        !value && 'is-empty',
        disabled && 'is-disabled',
        error && 'has-error',
        className,
      )}
    >
      <span className="date-field__label">{label}</span>
      <span className="date-field__control">
        <strong className="date-field__value">{formatDate(value, placeholder)}</strong>
        <Calendar aria-hidden focusable="false" />
        <input
          ref={ref}
          type="date"
          value={value}
          min={min}
          disabled={disabled}
          aria-label={label}
          aria-invalid={Boolean(error)}
          aria-describedby={errorId}
          onChange={(event) => onChange(event.target.value)}
        />
      </span>
      {error ? (
        <small id={errorId} className="date-field__error">
          {error}
        </small>
      ) : null}
    </label>
  );
});
