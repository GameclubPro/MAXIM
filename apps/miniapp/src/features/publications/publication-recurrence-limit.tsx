import { cn } from '../../lib/cn';
import type { PublicationRecurrenceDraft } from './publication-model';
import { PublicationNumberInput } from './publication-number-input';
import { PublicationZonedDateField } from './publication-zoned-fields';
import { formatPublicationScheduleField } from './publication-time-presentation';
import { parsePublicationScheduleField } from './publication-schedule-fields';

export function PublicationRecurrenceLimit({
  recurrence,
  timezone,
  disabled,
  onChange,
}: {
  recurrence: PublicationRecurrenceDraft;
  timezone: string;
  disabled: boolean;
  onChange: (patch: Partial<PublicationRecurrenceDraft>) => void;
}) {
  const mode = recurrence.endsAt ? 'date' : recurrence.maxOccurrences ? 'count' : 'never';
  return (
    <>
      <div className="publication-recurrence__end" role="group" aria-label="Завершение">
        {(
          [
            { value: 'count', label: 'По числу' },
            { value: 'date', label: 'По дате' },
            { value: 'never', label: 'Без лимита' },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={mode === option.value}
            className={cn(mode === option.value && 'is-active')}
            disabled={disabled}
            onClick={() => {
              const defaultDate = formatPublicationScheduleField(
                new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
                timezone,
              ).slice(0, 10);
              onChange({
                endsAt:
                  option.value === 'date'
                    ? (recurrence.endsAt ??
                      parsePublicationScheduleField(`${defaultDate}T23:59`, timezone))
                    : null,
                maxOccurrences: option.value === 'count' ? (recurrence.maxOccurrences ?? 30) : null,
              });
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      {mode === 'count' ? (
        <label className="publication-recurrence__limit">
          <span>Запусков</span>
          <PublicationNumberInput
            label="Число запусков"
            min={1}
            max={365}
            value={recurrence.maxOccurrences ?? 30}
            disabled={disabled}
            onChange={(maxOccurrences) => onChange({ maxOccurrences })}
          />
        </label>
      ) : mode === 'date' ? (
        <PublicationZonedDateField
          label="До даты"
          value={recurrence.endsAt}
          timezone={timezone}
          endOfDay
          disabled={disabled}
          onChange={(endsAt) => {
            if (endsAt) onChange({ endsAt });
          }}
        />
      ) : null}
    </>
  );
}
