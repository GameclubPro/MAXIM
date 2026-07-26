import type { ChangeEvent } from 'react';
import {
  getPublicationRecurrenceIntervalNotice,
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
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(Math.max(1, Math.min(31, Number(event.currentTarget.value) || 1)));
  };

  return (
    <>
      <label className="publication-recurrence__interval">
        <span>Интервал</span>
        <input
          type="number"
          min={1}
          max={31}
          value={interval}
          onChange={handleChange}
          disabled={disabled}
        />
        <small>{frequency === 'daily' ? 'дней' : 'недель'}</small>
      </label>

      {notice ? (
        <div
          className="publications-inline-notice publication-recurrence__interval-notice is-warning"
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
