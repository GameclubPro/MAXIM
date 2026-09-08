import { useEffect, useState } from 'react';

export function PublicationNumberInput({
  value,
  min,
  max,
  label,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [editing, value]);
  return (
    <input
      type="number"
      inputMode="numeric"
      step={1}
      min={min}
      max={max}
      aria-label={label}
      value={draft}
      disabled={disabled}
      onFocus={() => setEditing(true)}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        const number = Number(next);
        if (next.trim() && Number.isInteger(number) && number >= min && number <= max)
          onChange(number);
      }}
      onBlur={() => {
        setEditing(false);
        setDraft(String(value));
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}
