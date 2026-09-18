import { Minus, Plus } from 'iconoir-react';
import { useRef, useState } from 'react';
import { parseExactTimePart, shiftExactTimePart } from './time-field-exact-model';
import './time-field-exact-input.css';

const QUICK_MINUTES = Array.from({ length: 12 }, (_, index) => index * 5);
const PARTS = [
  { key: 'hour', label: 'Часы', actionLabel: 'часы', maximum: 23 },
  { key: 'minute', label: 'Минуты', actionLabel: 'минуты', maximum: 59 },
] as const;

export function TimeFieldExactInput({
  initialValue,
  onChange,
  onValidityChange,
  onComplete,
}: {
  initialValue: { hour: number; minute: number };
  onChange: (value: { hour: number; minute: number }) => void;
  onValidityChange: (valid: boolean) => void;
  onComplete: () => void;
}) {
  const [fields, setFields] = useState(() => ({
    hour: String(initialValue.hour).padStart(2, '0'),
    minute: String(initialValue.minute).padStart(2, '0'),
  }));
  const minuteRef = useRef<HTMLInputElement | null>(null);
  const hour = parseExactTimePart(fields.hour, 23);
  const minute = parseExactTimePart(fields.minute, 59);

  function update(part: 'hour' | 'minute', value: string) {
    const next = { ...fields, [part]: value };
    setFields(next);
    const nextHour = parseExactTimePart(next.hour, 23);
    const nextMinute = parseExactTimePart(next.minute, 59);
    const valid = nextHour !== null && nextMinute !== null;
    onValidityChange(valid);
    if (valid) onChange({ hour: nextHour, minute: nextMinute });
  }

  return (
    <div className="time-field-exact">
      <div className="time-field-exact__parts">
        {PARTS.map((part) => {
          const invalid = parseExactTimePart(fields[part.key], part.maximum) === null;
          return (
            <div className="time-field-exact__part" key={part.key}>
              <label>
                <span>{part.label}</span>
                <input
                  ref={part.key === 'minute' ? minuteRef : undefined}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={2}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={part.label}
                  aria-invalid={invalid || undefined}
                  value={fields[part.key]}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => update(part.key, event.target.value)}
                  onBlur={() => {
                    const padded = fields[part.key].padStart(2, '0');
                    if (!invalid && padded !== fields[part.key]) update(part.key, padded);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                      event.preventDefault();
                      const next = shiftExactTimePart(
                        fields[part.key],
                        event.key === 'ArrowUp' ? 1 : -1,
                        part.maximum,
                      );
                      if (next !== null) update(part.key, next);
                    } else if (event.key === 'Enter') {
                      event.preventDefault();
                      if (part.key === 'hour') minuteRef.current?.focus();
                      else if (hour !== null && minute !== null) onComplete();
                    }
                  }}
                />
              </label>
              <div className="time-field-exact__steppers">
                {([-1, 1] as const).map((delta) => {
                  const label = `${delta < 0 ? 'Уменьшить' : 'Увеличить'} ${part.actionLabel}`;
                  return (
                    <button
                      type="button"
                      key={delta}
                      disabled={invalid}
                      aria-label={label}
                      title={label}
                      onClick={() => {
                        const next = shiftExactTimePart(fields[part.key], delta, part.maximum);
                        if (next !== null) update(part.key, next);
                      }}
                    >
                      {delta < 0 ? <Minus aria-hidden /> : <Plus aria-hidden />}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="time-field-exact__error" role="status">
        {hour === null ? 'Часы: от 0 до 23' : minute === null ? 'Минуты: от 0 до 59' : ''}
      </div>
      <div className="time-field-exact__presets" role="group" aria-label="Быстрый выбор минут">
        {QUICK_MINUTES.map((value) => (
          <button
            type="button"
            key={value}
            aria-label={`Минуты: ${String(value).padStart(2, '0')}`}
            aria-pressed={minute === value}
            onClick={() => update('minute', String(value).padStart(2, '0'))}
          >
            {String(value).padStart(2, '0')}
          </button>
        ))}
      </div>
    </div>
  );
}
