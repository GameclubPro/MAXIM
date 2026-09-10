import { PublicationNumberInput } from './publication-number-input';
import {
  getPublicationRecurrenceIntervalNotice,
  getPublicationRecurrenceIntervalUnit,
  type PublicationRecurrenceFrequency,
} from './publication-model';
import './publication-recurrence-interval-field.css';

type PublicationRecurrenceIntervalFieldProps = {
  frequency: PublicationRecurrenceFrequency;
  interval: number;
  disabled: boolean;
  onChange: (interval: number) => void;
};

export function PublicationRecurrenceIntervalField({
  frequency,
  interval,
  disabled,
  onChange,
}: PublicationRecurrenceIntervalFieldProps) {
  const notice = getPublicationRecurrenceIntervalNotice(frequency, interval);

  return (
    <>
      <label className="publication-recurrence__interval">
        <span>Раз в</span>
        <PublicationNumberInput
          label="Интервал повтора"
          min={1}
          max={31}
          value={interval}
          onChange={onChange}
          disabled={disabled}
        />
        <small>{getPublicationRecurrenceIntervalUnit(frequency, interval)}</small>
      </label>

      {notice ? (
        <div
          className="publications-inline-notice publication-recurrence__interval-notice"
          role="status"
        >
          <span>
            <strong>{notice.title}</strong>
            <small>{notice.description}</small>
          </span>
        </div>
      ) : null}
    </>
  );
}
