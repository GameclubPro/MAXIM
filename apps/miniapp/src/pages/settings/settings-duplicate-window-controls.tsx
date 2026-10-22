import { DUPLICATE_WINDOW_MAX_SEC } from '@maxim/contracts/settings';
import { SegmentedControl } from '../../components/ui/segmented-control';
import { TimeField } from '../../components/ui/time-field';
import type { ChatSettingsFieldAdapter } from '../../features/network-settings/field-model';
import { RUSSIAN_TIMEZONE_OPTIONS } from './settings-timezones';
import { formatDuplicateClockTime } from './settings-duplicate-flow';

export default function SettingsDuplicateWindowControls({
  fields,
  windowHours,
  inputValue,
  onHoursChange,
}: {
  fields: ChatSettingsFieldAdapter;
  windowHours: number | null;
  inputValue: string | null;
  onHoursChange: (value: string) => void;
}) {
  const mode = fields.read('duplicateWindowMode');
  const start = fields.read('duplicateStartTimeMinutes');
  const end = fields.read('duplicateEndTimeMinutes');
  const timezone = fields.read('duplicateTimezone');
  const modeValue = mode.kind === 'common' ? mode.value : null;
  const timeError =
    fields.error('duplicateEndTimeMinutes') ??
    (start.kind === 'common' && end.kind === 'common' && start.value === end.value
      ? 'Начало и конец должны отличаться.'
      : undefined);
  const changeTime = (
    key: 'duplicateStartTimeMinutes' | 'duplicateEndTimeMinutes',
    value: string,
  ) => {
    if (!value) {
      fields.revert(key);
      return;
    }
    const [hours, minutes] = value.split(':').map(Number);
    fields.setScalar(key, hours * 60 + minutes);
  };
  return (
    <div className="duplicate-window">
      <SegmentedControl
        className="settings-mode-segments"
        value={modeValue}
        options={[
          { value: 'INTERVAL', label: 'Интервал', disabled: fields.readOnly },
          { value: 'DAILY', label: 'По времени', disabled: fields.readOnly },
        ]}
        ariaLabel="Период проверки дублей"
        onChange={(value) => {
          if (value === 'INTERVAL' || value === 'DAILY')
            fields.setScalar('duplicateWindowMode', value);
        }}
      />
      {mode.kind !== 'common' ? (
        <p className="field__hint">
          Разные значения. Выберите период, чтобы изменить его во всех выбранных чатах.
        </p>
      ) : null}
      {modeValue === 'DAILY' ? (
        <>
          <div className="duplicate-window__times">
            <TimeField
              label="С"
              variant="embedded"
              value={start.kind === 'common' ? formatDuplicateClockTime(start.value) : ''}
              allowEmpty={start.kind !== 'common'}
              placeholder="Разное время"
              clearLabel="Оставить без изменения"
              disabled={fields.readOnly || start.kind === 'loading'}
              error={fields.error('duplicateStartTimeMinutes') ?? undefined}
              onChange={(value) => changeTime('duplicateStartTimeMinutes', value)}
            />
            <TimeField
              label="По"
              variant="embedded"
              value={end.kind === 'common' ? formatDuplicateClockTime(end.value) : ''}
              allowEmpty={end.kind !== 'common'}
              placeholder="Разное время"
              clearLabel="Оставить без изменения"
              disabled={fields.readOnly || end.kind === 'loading'}
              error={timeError ?? undefined}
              onChange={(value) => changeTime('duplicateEndTimeMinutes', value)}
            />
          </div>
          <label className="field duplicate-window__timezone">
            <span className="field__label">Часовой пояс</span>
            <select
              value={timezone.kind === 'common' ? timezone.value : ''}
              disabled={fields.readOnly || timezone.kind === 'loading'}
              aria-invalid={Boolean(fields.error('duplicateTimezone')) || undefined}
              onChange={(event) => fields.setScalar('duplicateTimezone', event.target.value)}
            >
              {timezone.kind !== 'common' ? (
                <option value="" disabled>
                  Разные значения
                </option>
              ) : null}
              {timezone.kind === 'common' &&
              !RUSSIAN_TIMEZONE_OPTIONS.some((option) => option.value === timezone.value) ? (
                <option value={timezone.value}>{timezone.value}</option>
              ) : null}
              {RUSSIAN_TIMEZONE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {fields.error('duplicateTimezone') ? (
              <small className="field__hint">{fields.error('duplicateTimezone')}</small>
            ) : null}
          </label>
          <p className="field__hint duplicate-window__caption" aria-live="polite">
            {start.kind === 'common' && end.kind === 'common'
              ? start.value > end.value
                ? 'Ежедневно, с переходом на следующий день.'
                : 'Каждый день.'
              : 'Время различается между выбранными чатами.'}{' '}
            Вне периода повторы разрешены.
          </p>
        </>
      ) : modeValue === 'INTERVAL' ? (
        <>
          <label className="duplicate-stage__field">
            <span className="duplicate-stage__field-label">После первого сообщения</span>
            <div className="duplicate-stage__input-wrap">
              <input
                type="number"
                min={1}
                max={DUPLICATE_WINDOW_MAX_SEC / 3600}
                step={1}
                inputMode="numeric"
                value={inputValue ?? (windowHours === null ? '' : String(windowHours))}
                placeholder={windowHours === null ? 'Разные значения' : undefined}
                disabled={fields.readOnly}
                onChange={(event) => onHoursChange(event.target.value)}
                aria-label="Период проверки дублей, часы"
                aria-invalid={Boolean(fields.error('duplicateWarnWindowSec')) || undefined}
                aria-describedby={
                  fields.error('duplicateWarnWindowSec')
                    ? 'duplicate-window-hours-error'
                    : undefined
                }
              />
              <span className="duplicate-stage__suffix" aria-hidden>
                часы
              </span>
            </div>
          </label>
          <SegmentedControl
            className="settings-mode-segments"
            value={windowHours === null ? null : String(windowHours)}
            options={[
              { value: '1', label: '1 ч', disabled: fields.readOnly },
              { value: '12', label: '12 ч', disabled: fields.readOnly },
              { value: '24', label: '1 день', disabled: fields.readOnly },
              { value: '48', label: '2 дня', disabled: fields.readOnly },
            ]}
            onChange={onHoursChange}
            ariaLabel="Быстрый выбор периода проверки"
          />
          <p className="field__hint duplicate-window__caption">
            Максимум 48 часов. После выбранного периода повторная публикация разрешена.
          </p>
          {fields.error('duplicateWarnWindowSec') ? (
            <small id="duplicate-window-hours-error" className="field__hint" role="alert">
              {fields.error('duplicateWarnWindowSec')}
            </small>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
