import { TimeField } from '../../components/ui/time-field';

export type NightModeTimeFieldKey = 'nightModeStartTimeMinutes' | 'nightModeEndTimeMinutes';

type SettingsTimeFieldsProps =
  | {
      kind: 'night';
      startMinutes: number;
      endMinutes: number;
      onChange: (key: NightModeTimeFieldKey, value: number) => void;
    }
  | {
      kind: 'schedule';
      value: string;
      onChange: (value: string) => void;
    };

type NightModeTimeFieldsProps = {
  startMinutes: number;
  endMinutes: number;
  onChange: (key: NightModeTimeFieldKey, value: number) => void;
};

type ScheduleTimeFieldProps = {
  value: string;
  onChange: (value: string) => void;
};

function normalizeDayMinutes(value: number, fallback = 0): number {
  if (!Number.isInteger(value) || value < 0 || value > 1_439) {
    return fallback;
  }

  return value;
}

function minutesToTimeInput(value: number): string {
  const safe = normalizeDayMinutes(value);
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function timeInputToMinutes(value: string, fallback: number): number {
  const [hoursRaw, minutesRaw] = value.split(':');
  const hours = Number.parseInt(hoursRaw ?? '', 10);
  const minutes = Number.parseInt(minutesRaw ?? '', 10);

  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return fallback;
  }

  return hours * 60 + minutes;
}

function NightModeTimeFields({ startMinutes, endMinutes, onChange }: NightModeTimeFieldsProps) {
  return (
    <>
      <div className="field night-window-grid__field">
        <TimeField
          label="Закрывать с"
          value={minutesToTimeInput(startMinutes)}
          variant="embedded"
          onChange={(nextValue) =>
            onChange(
              'nightModeStartTimeMinutes',
              timeInputToMinutes(nextValue, normalizeDayMinutes(startMinutes, 23 * 60)),
            )
          }
        />
      </div>

      <div className="field night-window-grid__field">
        <TimeField
          label="Открывать в"
          value={minutesToTimeInput(endMinutes)}
          variant="embedded"
          onChange={(nextValue) =>
            onChange(
              'nightModeEndTimeMinutes',
              timeInputToMinutes(nextValue, normalizeDayMinutes(endMinutes, 8 * 60)),
            )
          }
        />
      </div>
    </>
  );
}

function ScheduleTimeField({ value, onChange }: ScheduleTimeFieldProps) {
  return (
    <TimeField
      className="allowlist-item__schedule-time"
      label="Время удаления"
      value={value}
      variant="embedded"
      onChange={onChange}
    />
  );
}

export default function SettingsTimeFields(props: SettingsTimeFieldsProps) {
  return props.kind === 'night' ? (
    <NightModeTimeFields
      startMinutes={props.startMinutes}
      endMinutes={props.endMinutes}
      onChange={props.onChange}
    />
  ) : (
    <ScheduleTimeField value={props.value} onChange={props.onChange} />
  );
}
