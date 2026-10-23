import { useImperativeHandle, useRef, type InputHTMLAttributes, type Ref } from 'react';
import { AppIcon } from './app-icon';
import { cn } from '../../lib/cn';
import './search-field.css';

type SearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  inputProps?: Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'type' | 'value' | 'onChange' | 'className' | 'aria-label'
  >;
};

export function SearchField({
  value,
  onChange,
  label,
  placeholder,
  disabled,
  className,
  inputRef,
  inputProps,
}: SearchFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(inputRef, () => input.current!, []);
  return (
    <div className={cn('search-field', className)}>
      <AppIcon icon="Search" className="search-field__icon" aria-hidden="true" />
      <input
        {...inputProps}
        ref={input}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        autoComplete={inputProps?.autoComplete ?? 'off'}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="search-field__clear"
          aria-label={`Очистить: ${label}`}
          disabled={disabled}
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
        >
          <AppIcon icon="Xmark" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
