import type { ChatSettings } from '@maxim/contracts/settings';
import { DUPLICATE_WINDOW_MAX_SEC } from '@maxim/contracts/settings';
import { SegmentedControl } from '../../components/ui/segmented-control';
import { TimeField } from '../../components/ui/time-field';
import type { FieldErrors } from './settings-page-helpers';
import { RUSSIAN_TIMEZONE_OPTIONS } from './settings-timezones';
import type { SettingsSectionMutationProps } from './settings-section-shared';
import { formatDuplicateClockTime } from './settings-duplicate-flow';

export default function SettingsDuplicateWindowControls({
  draft,
  setFieldValue,
  fieldErrors,
  windowHours,
  inputValue,
  onHoursChange,
  onHoursBlur,
}: Pick<SettingsSectionMutationProps, 'setFieldValue'> & {
  draft: ChatSettings;
  fieldErrors: FieldErrors;
  windowHours: number;
  inputValue: string | null;
  onHoursChange: (value: string) => void;
  onHoursBlur: () => void;
}) {
  const daily = draft.duplicateWindowMode === 'DAILY';
  const timeError =
    fieldErrors.duplicateEndTimeMinutes ??
    (draft.duplicateStartTimeMinutes === draft.duplicateEndTimeMinutes
      ? 'Начало и конец должны отличаться.'
      : undefined);
  const changeTime = (
    key: 'duplicateStartTimeMinutes' | 'duplicateEndTimeMinutes',
    value: string,
  ) => {
    const [hours, minutes] = value.split(':').map(Number);
    setFieldValue(key, hours * 60 + minutes);
  };
  return (
    <div className="duplicate-window">
      <SegmentedControl
        className="settings-mode-segments"
        value={draft.duplicateWindowMode}
        options={[
          { value: 'INTERVAL', label: 'Интервал' },
          { value: 'DAILY', label: 'По времени' },
        ]}
        ariaLabel="Период проверки дублей"
        onChange={(value) => setFieldValue('duplicateWindowMode', value)}
      />
      {daily ? (
        <>
          <div className="duplicate-window__times">
            <TimeField
              label="С"
              variant="embedded"
              value={formatDuplicateClockTime(draft.duplicateStartTimeMinutes)}
              error={fieldErrors.duplicateStartTimeMinutes}
              onChange={(value) => changeTime('duplicateStartTimeMinutes', value)}
            />
            <TimeField
              label="По"
              variant="embedded"
              value={formatDuplicateClockTime(draft.duplicateEndTimeMinutes)}
              error={timeError}
              onChange={(value) => changeTime('duplicateEndTimeMinutes', value)}
            />
          </div>
          <label className="field duplicate-window__timezone">
            <span className="field__label">Часовой пояс</span>
            <select
              value={draft.duplicateTimezone}
              aria-invalid={Boolean(fieldErrors.duplicateTimezone) || undefined}
              aria-describedby={
                fieldErrors.duplicateTimezone ? 'duplicate-timezone-error' : undefined
              }
              onChange={(event) => setFieldValue('duplicateTimezone', event.target.value)}
            >
              {!RUSSIAN_TIMEZONE_OPTIONS.some(
                (option) => option.value === draft.duplicateTimezone,
              ) ? (
                <option value={draft.duplicateTimezone}>{draft.duplicateTimezone}</option>
              ) : null}
              {RUSSIAN_TIMEZONE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {fieldErrors.duplicateTimezone ? (
              <small id="duplicate-timezone-error" className="field__hint">
                {fieldErrors.duplicateTimezone}
              </small>
            ) : null}
          </label>
          <p className="field__hint duplicate-window__caption" aria-live="polite">
            {draft.duplicateStartTimeMinutes > draft.duplicateEndTimeMinutes
              ? 'Ежедневно, с переходом на следующий день.'
              : 'Каждый день.'}{' '}
            Вне периода повторы разрешены.
          </p>
        </>
      ) : (
        <>
          <label className="duplicate-stage__field">
            <span className="duplicate-stage__field-label">После первого сообщения</span>
            <div className="duplicate-stage__input-wrap">
              <input
                type="number"
                min={1}
                max={DUPLICATE_WINDOW_MAX_SEC / 3_600}
                step={1}
                inputMode="numeric"
                value={inputValue ?? String(windowHours)}
                onChange={(event) => onHoursChange(event.target.value)}
                onBlur={onHoursBlur}
                aria-label="Период проверки дублей, часы"
                aria-invalid={Boolean(fieldErrors.duplicateWarnWindowSec) || undefined}
                aria-describedby={
                  fieldErrors.duplicateWarnWindowSec ? 'duplicate-window-hours-error' : undefined
                }
              />
              <span className="duplicate-stage__suffix" aria-hidden>
                часы
              </span>
            </div>
          </label>
          <SegmentedControl
            className="settings-mode-segments"
            value={String(windowHours)}
            options={[
              { value: '1', label: '1 ч' },
              { value: '12', label: '12 ч' },
              { value: '24', label: '1 день' },
              { value: '48', label: '2 дня' },
            ]}
            onChange={onHoursChange}
            ariaLabel="Быстрый выбор периода проверки"
          />
          <p className="field__hint duplicate-window__caption">
            Максимум 48 часов. После выбранного периода повторная публикация разрешена.
          </p>
          {fieldErrors.duplicateWarnWindowSec ? (
            <small id="duplicate-window-hours-error" className="field__hint">
              {fieldErrors.duplicateWarnWindowSec}
            </small>
          ) : null}
        </>
      )}
    </div>
  );
}
