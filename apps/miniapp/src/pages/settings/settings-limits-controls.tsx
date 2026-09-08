import {
  MAX_MESSAGE_LENGTH_MAX,
  MAX_MESSAGE_LENGTH_MIN,
  type ChatSettings,
} from '@maxim/contracts/settings';
import { useEffect, useRef, useState } from 'react';
import type { AdminContactButtonGroup, ChatSettingsButtonGroup } from './settings-page-helpers';

export const MESSAGE_COUNT_LIMIT_MIN = 1;
export const MESSAGE_COUNT_LIMIT_MAX = 10;
export const MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS = 1;
export const MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS = 24;
export const MESSAGE_LENGTH_MIN = MAX_MESSAGE_LENGTH_MIN;
export const MESSAGE_LENGTH_MAX = MAX_MESSAGE_LENGTH_MAX;
export const MESSAGE_LENGTH_STEP = 10;
export const PHOTO_COOLDOWN_MIN_HOURS = 1;
export const PHOTO_COOLDOWN_MAX_HOURS = 24;
export const STICKER_COOLDOWN_MIN_MINUTES = 1;
export const STICKER_COOLDOWN_MAX_MINUTES = 60;

export const MESSAGE_LIMITS_BOT_BUTTON_GROUP = {
  buttonsKey: 'messageLimitsBotButtons',
  enabledKey: 'messageLimitsBotButtonEnabled',
  urlKey: 'messageLimitsBotButtonUrl',
  textKey: 'messageLimitsBotButtonText',
} as const satisfies ChatSettingsButtonGroup;

export const MESSAGE_LIMITS_ADMIN_CONTACT_BUTTON_GROUP = {
  enabledKey: 'messageLimitsAdminContactButtonEnabled',
  urlKey: 'messageLimitsAdminContactButtonUrl',
} as const satisfies AdminContactButtonGroup;

export type MaxMessageLengthSliderProps = {
  value: ChatSettings['maxMessageLength'];
  min: number;
  max: number;
  step: number;
  onCommit: (value: ChatSettings['maxMessageLength']) => void;
};

export function MaxMessageLengthSlider({
  value,
  min,
  max,
  step,
  onCommit,
}: MaxMessageLengthSliderProps) {
  const [localValue, setLocalValue] = useState(value);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    if (!isDraggingRef.current) {
      setLocalValue(value);
    }
  }, [value]);

  function normalizeValue(rawValue: string): ChatSettings['maxMessageLength'] {
    const parsedValue = Number(rawValue);
    const safeValue = Number.isFinite(parsedValue) ? parsedValue : value;
    return Math.min(max, Math.max(min, safeValue)) as ChatSettings['maxMessageLength'];
  }

  function commitValue(nextValue: ChatSettings['maxMessageLength']) {
    isDraggingRef.current = false;
    setIsDragging(false);
    setLocalValue(nextValue);
    if (nextValue !== value) {
      onCommit(nextValue);
    }
  }

  return (
    <>
      <div className="settings-native-toggle__row">
        <span className="settings-native-toggle__title settings-native-toggle__title--sub">
          Максимум
        </span>
        <output className="settings-length-limit__value" aria-live="polite">
          {localValue} симв.
        </output>
      </div>

      <input
        className="settings-length-limit__slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={localValue}
        onPointerDown={() => {
          isDraggingRef.current = true;
          setIsDragging(true);
        }}
        onChange={(event) => {
          const nextValue = normalizeValue(event.target.value);
          setLocalValue(nextValue);
          if (!isDraggingRef.current) {
            onCommit(nextValue);
          }
        }}
        onPointerUp={(event) => {
          commitValue(normalizeValue(event.currentTarget.value));
        }}
        onPointerCancel={(event) => {
          commitValue(normalizeValue(event.currentTarget.value));
        }}
        onBlur={(event) => {
          if (!isDragging && !isDraggingRef.current) {
            commitValue(normalizeValue(event.currentTarget.value));
          }
        }}
        aria-label="Лимит длины сообщения"
      />

      <div className="settings-length-limit__labels" aria-hidden>
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </>
  );
}
