import {
  DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES as BOT_MESSAGES_DELETE_DELAY_OPTIONS,
  formatDeleteBotMessagesDelayLabel,
} from '@maxim/contracts/settings';
import { cn } from '../../lib/cn';

export type DeleteDelayStepperProps = {
  title: string;
  value: number | null;
  fieldError?: string;
  disabled?: boolean;
  onSelect?: (value: number) => void;
  groupAriaLabel: string;
  decreaseAriaLabel: string;
  increaseAriaLabel: string;
  onAdjust: (direction: number) => void;
};
export function DeleteDelayStepper({
  title,
  value,
  fieldError,
  disabled = false,
  onSelect,
  groupAriaLabel,
  decreaseAriaLabel,
  increaseAriaLabel,
  onAdjust,
}: DeleteDelayStepperProps) {
  return (
    <div
      className={cn(
        'settings-native-toggle',
        'settings-native-toggle--nested',
        fieldError && 'field--error',
      )}
    >
      <div className="settings-native-toggle__row">
        <span className="settings-native-toggle__title">{title}</span>

        <div className="ban-duration-stepper" role="group" aria-label={groupAriaLabel}>
          <button
            type="button"
            className="ban-duration-stepper__button"
            onClick={() => onAdjust(-1)}
            disabled={disabled || value === null || value <= BOT_MESSAGES_DELETE_DELAY_OPTIONS[0]}
            aria-label={decreaseAriaLabel}
          >
            -
          </button>

          <output className="ban-duration-stepper__value" aria-live="polite">
            {value === null ? 'Разные значения' : formatDeleteBotMessagesDelayLabel(value)}
          </output>

          <button
            type="button"
            className="ban-duration-stepper__button"
            onClick={() => onAdjust(1)}
            disabled={
              disabled ||
              value === null ||
              value >=
                BOT_MESSAGES_DELETE_DELAY_OPTIONS[BOT_MESSAGES_DELETE_DELAY_OPTIONS.length - 1]
            }
            aria-label={increaseAriaLabel}
          >
            +
          </button>
        </div>
      </div>

      {value === null && onSelect ? (
        <label className="field">
          <span className="field__label">Задать общую задержку</span>
          <select
            aria-label={groupAriaLabel}
            value=""
            disabled={disabled}
            onChange={(event) => {
              if (event.target.value) onSelect(Number(event.target.value));
            }}
          >
            <option value="" disabled>
              Разные значения
            </option>
            {BOT_MESSAGES_DELETE_DELAY_OPTIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {formatDeleteBotMessagesDelayLabel(minutes)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {fieldError ? <small className="field__hint">{fieldError}</small> : null}
    </div>
  );
}
