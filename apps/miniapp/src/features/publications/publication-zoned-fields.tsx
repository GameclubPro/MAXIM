import { TimeField } from '../../components/ui/time-field';
import { formatPublicationScheduleField } from './publication-time-presentation';
import { parsePublicationScheduleField } from './publication-schedule-fields';

export function PublicationZonedDateField({
  label,
  value,
  timezone,
  endOfDay = false,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null;
  timezone: string;
  endOfDay?: boolean;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="publication-recurrence__date">
      <span>{label}</span>
      <input
        type="date"
        value={formatPublicationScheduleField(value, timezone).slice(0, 10)}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            parsePublicationScheduleField(
              `${event.target.value}T${endOfDay ? '23:59' : '00:00'}`,
              timezone,
            ),
          )
        }
      />
    </label>
  );
}

export function PublicationOnceFields({
  date,
  time,
  timezone,
  disabled,
  onChange,
}: {
  date: string;
  time: string;
  timezone: string;
  disabled: boolean;
  onChange: (date: string, time: string, at: string | null) => void;
}) {
  return (
    <div className="publication-once-fields">
      <label>
        <span>Дата</span>
        <input
          type="date"
          value={date}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              event.target.value,
              time,
              parsePublicationScheduleField(`${event.target.value}T${time}`, timezone),
            )
          }
        />
      </label>
      <TimeField
        label="Время"
        value={time}
        allowEmpty
        minuteStep={30}
        disabled={disabled}
        onChange={(value) =>
          onChange(date, value, parsePublicationScheduleField(`${date}T${value}`, timezone))
        }
      />
    </div>
  );
}
