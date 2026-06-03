import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { useNativeBackHandler } from '../../lib/native-back';
import { useVisualViewportOverlayStyle } from '../../lib/use-visual-viewport-overlay-style';
import './time-field.css';

type TimeParts = {
  hour: number;
  minute: number;
};

type TimePartKey = keyof TimeParts;

type TimeFieldProps = {
  value: string;
  label: string;
  className?: string;
  disabled?: boolean;
  error?: string;
  allowEmpty?: boolean;
  clearLabel?: string;
  placeholder?: string;
  variant?: 'default' | 'embedded' | 'compact';
  onChange: (nextValue: string) => void;
};

const HOURS = Array.from({ length: 24 }, (_, index) => index);
const MINUTES = Array.from({ length: 60 }, (_, index) => index);
const TIME_VALUE_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function TimeFieldClockIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      focusable="false"
    >
      <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.9" />
      <path
        d="M12 7.6v4.8l3.2 2"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function padTimePart(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTime({ hour, minute }: TimeParts): string {
  return `${padTimePart(hour)}:${padTimePart(minute)}`;
}

function parseTime(value: string): TimeParts {
  const match = TIME_VALUE_PATTERN.exec(value);

  if (!match) {
    return { hour: 0, minute: 0 };
  }

  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

function resolveTimeLabel(value: string): string {
  return TIME_VALUE_PATTERN.test(value) ? value : '00:00';
}

function resolveTimeFieldPortalTarget(): Element | null {
  if (typeof document === 'undefined') {
    return null;
  }

  return document.querySelector('.design-preview__device-screen') ?? document.body;
}

export function TimeField({
  value,
  label,
  className,
  disabled = false,
  error,
  allowEmpty = false,
  clearLabel = 'Очистить',
  placeholder = 'Не задано',
  variant = 'default',
  onChange,
}: TimeFieldProps) {
  const reactId = useId();
  const fieldId = `time-field-${reactId}`;
  const titleId = `${fieldId}-title`;
  const errorId = error ? `${fieldId}-error` : undefined;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TimeParts>(() => parseTime(value));
  const [draftTouched, setDraftTouched] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const overlayStyle = useVisualViewportOverlayStyle(open);
  const isEmpty = allowEmpty && !TIME_VALUE_PATTERN.test(value);
  const displayValue = isEmpty ? placeholder : resolveTimeLabel(value);
  const portalTarget = open ? resolveTimeFieldPortalTarget() : null;

  const selectedValue = useMemo(() => formatTime(draft), [draft]);
  const sheetValueLabel = isEmpty && !draftTouched ? placeholder : selectedValue;

  const close = () => {
    setOpen(false);
    window.requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  };

  const openSheet = () => {
    if (disabled) {
      return;
    }

    setDraft(parseTime(value));
    setDraftTouched(false);
    setOpen(true);
  };

  const apply = () => {
    if (isEmpty && !draftTouched) {
      close();
      return;
    }

    onChange(formatTime(draft));
    close();
  };

  const clear = () => {
    onChange('');
    close();
  };

  const focusTimeOption = (part: TimePartKey, partValue: number) => {
    window.requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLButtonElement>(
          `[data-time-part="${part}"][data-time-value="${partValue}"]`,
        )
        ?.focus();
    });
  };

  const setDraftPart = (part: TimePartKey, partValue: number, shouldFocus = false) => {
    setDraft((current) =>
      current[part] === partValue ? current : { ...current, [part]: partValue },
    );
    setDraftTouched(true);
    if (shouldFocus) {
      focusTimeOption(part, partValue);
    }
  };

  const shiftDraftPart = (part: TimePartKey, delta: number) => {
    const limit = part === 'hour' ? 24 : 60;
    const nextValue = (draft[part] + delta + limit) % limit;
    setDraftPart(part, nextValue, true);
  };

  const handleOptionKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    part: TimePartKey,
  ) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      shiftDraftPart(part, 1);
      return;
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      shiftDraftPart(part, -1);
      return;
    }

    if (event.key === 'PageDown') {
      event.preventDefault();
      shiftDraftPart(part, part === 'hour' ? 6 : 10);
      return;
    }

    if (event.key === 'PageUp') {
      event.preventDefault();
      shiftDraftPart(part, part === 'hour' ? -6 : -10);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      setDraftPart(part, 0, true);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      setDraftPart(part, part === 'hour' ? 23 : 59, true);
    }
  };

  useNativeBackHandler(
    () => {
      close();
      return true;
    },
    { enabled: open, priority: 720 },
  );

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    setDraft(parseTime(value));
    setDraftTouched(false);
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      const selectedOptions = panel?.querySelectorAll('.time-field-sheet__option.is-active');
      const selectedHour = panel?.querySelector<HTMLButtonElement>(
        '.time-field-sheet__option.is-active[data-time-part="hour"]',
      );
      (selectedHour ?? panel)?.focus();
      selectedOptions?.forEach((option) => {
        option.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open, value]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const { body, documentElement } = document;
    const previousBodyOverflow = body.style.overflow;
    const previousDocumentOverflow = documentElement.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const panel = panelRef.current;
      if (!panel) {
        return;
      }

      const focusableItems = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled):not([tabindex="-1"]), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((item) => !item.hasAttribute('disabled') && item.getClientRects().length > 0);

      if (focusableItems.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const firstItem = focusableItems[0];
      const lastItem = focusableItems[focusableItems.length - 1];
      const activeElement = document.activeElement;

      if (activeElement && !panel.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastItem : firstItem)?.focus();
      } else if (!event.shiftKey && activeElement === panel) {
        event.preventDefault();
        firstItem?.focus();
      } else if (event.shiftKey && (activeElement === firstItem || activeElement === panel)) {
        event.preventDefault();
        lastItem?.focus();
      } else if (!event.shiftKey && activeElement === lastItem) {
        event.preventDefault();
        firstItem?.focus();
      }
    };

    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overflow = previousDocumentOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const sheet =
    open && portalTarget
      ? createPortal(
          <div className="time-field-sheet" style={overlayStyle} aria-hidden={!open}>
            <button
              type="button"
              className="time-field-sheet__backdrop"
              aria-label="Закрыть выбор времени"
              onClick={close}
            />

            <section
              ref={panelRef}
              className="time-field-sheet__panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              tabIndex={-1}
            >
              <div className="time-field-sheet__grabber" aria-hidden />

              <div className="time-field-sheet__head">
                <div>
                  <strong id={titleId}>{label}</strong>
                  <small>{sheetValueLabel}</small>
                </div>
                <TimeFieldClockIcon size={22} />
              </div>

              <div className="time-field-sheet__wheels" aria-label="Выбор времени">
                <div className="time-field-sheet__column">
                  <span className="time-field-sheet__column-label">Часы</span>
                  <div className="time-field-sheet__options" role="listbox" aria-label="Часы">
                    {HOURS.map((hour) => {
                      const active = hour === draft.hour;

                      return (
                        <button
                          key={hour}
                          type="button"
                          className={cn('time-field-sheet__option', active && 'is-active')}
                          aria-selected={active}
                          role="option"
                          tabIndex={active ? 0 : -1}
                          data-time-part="hour"
                          data-time-value={hour}
                          onClick={() => setDraftPart('hour', hour)}
                          onKeyDown={(event) => handleOptionKeyDown(event, 'hour')}
                        >
                          {padTimePart(hour)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="time-field-sheet__divider" aria-hidden>
                  :
                </div>

                <div className="time-field-sheet__column">
                  <span className="time-field-sheet__column-label">Минуты</span>
                  <div className="time-field-sheet__options" role="listbox" aria-label="Минуты">
                    {MINUTES.map((minute) => {
                      const active = minute === draft.minute;

                      return (
                        <button
                          key={minute}
                          type="button"
                          className={cn('time-field-sheet__option', active && 'is-active')}
                          aria-selected={active}
                          role="option"
                          tabIndex={active ? 0 : -1}
                          data-time-part="minute"
                          data-time-value={minute}
                          onClick={() => setDraftPart('minute', minute)}
                          onKeyDown={(event) => handleOptionKeyDown(event, 'minute')}
                        >
                          {padTimePart(minute)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div
                className={cn(
                  'time-field-sheet__actions',
                  allowEmpty && 'time-field-sheet__actions--with-clear',
                )}
              >
                {allowEmpty ? (
                  <button
                    type="button"
                    className="time-field-sheet__button time-field-sheet__button--clear"
                    onClick={clear}
                  >
                    {clearLabel}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="time-field-sheet__button time-field-sheet__button--ghost"
                  onClick={close}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="time-field-sheet__button time-field-sheet__button--apply"
                  onClick={apply}
                >
                  Применить
                </button>
              </div>
            </section>
          </div>,
          portalTarget,
        )
      : null;

  return (
    <div
      className={cn(
        'time-field',
        variant === 'embedded' && 'time-field--embedded',
        variant === 'compact' && 'time-field--compact',
        isEmpty && 'is-empty',
        disabled && 'is-disabled',
        error && 'has-error',
        className,
      )}
    >
      <button
        id={fieldId}
        ref={triggerRef}
        type="button"
        className="time-field__button"
        onClick={openSheet}
        disabled={disabled}
        aria-label={`${label}: ${displayValue}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
      >
        <span className="time-field__copy">
          <span className="time-field__label">{label}</span>
          <span className="time-field__value">{displayValue}</span>
        </span>
        <span className="time-field__icon" aria-hidden>
          <TimeFieldClockIcon />
        </span>
      </button>
      {error ? (
        <span id={errorId} className="time-field__error">
          {error}
        </span>
      ) : null}
      {sheet}
    </div>
  );
}
