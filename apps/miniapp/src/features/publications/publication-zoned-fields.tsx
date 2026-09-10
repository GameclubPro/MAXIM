import { TimeField } from '../../components/ui/time-field';
import { DateField } from '../../components/ui/date-field';
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
    <DateField
      label={label}
      className="publication-recurrence__date"
      value={formatPublicationScheduleField(value, timezone).slice(0, 10)}
      disabled={disabled}
      onChange={(date) =>
        onChange(parsePublicationScheduleField(`${date}T${endOfDay ? '23:59' : '00:00'}`, timezone))
      }
    />
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
      <DateField
        label="Дата"
        value={date}
        disabled={disabled}
        onChange={(nextDate) =>
          onChange(nextDate, time, parsePublicationScheduleField(`${nextDate}T${time}`, timezone))
        }
      />
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
