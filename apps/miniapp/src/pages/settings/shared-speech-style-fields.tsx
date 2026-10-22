import {
  BOT_SPEECH_STYLE_METADATA,
  BOT_SPEECH_STYLE_OPTIONS,
  type BotSpeechStyle,
} from '@maxim/contracts/bot-speech';
import { useRef, type RefObject } from 'react';
import botSpeechRobotImage from '../../../../../bot.webp';
import botSpeechFriendlyImage from '../../../../../frendly.webp';
import botSpeechIronicImage from '../../../../../joker.webp';
import botSpeechPoliceImage from '../../../../../police.webp';
import { cn } from '../../lib/cn';
import { resolveRadioGroupNavigationIndex } from '../../lib/radio-group-navigation';
import { buildSpeechStylePreviewSamples } from '../../lib/bot-speech-style-preview';
import type { BotSpeechPreviewContext } from '../../lib/bot-speech-preview-context';

export type SharedSpeechStyleFieldsProps = {
  selectedStyle: BotSpeechStyle | null;
  disabled: boolean;
  onSelect: (style: BotSpeechStyle) => void;
  previewContext?: BotSpeechPreviewContext;
  initialFocusRef?: RefObject<HTMLButtonElement | null>;
  emptyMessage?: string;
};

const STYLE_ICONS = {
  robot: botSpeechRobotImage,
  friendly: botSpeechFriendlyImage,
  police: botSpeechPoliceImage,
  ironic: botSpeechIronicImage,
} satisfies Record<(typeof BOT_SPEECH_STYLE_OPTIONS)[number]['iconKey'], string>;

function SelectedIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M5.5 10.4L8.3 13.2L14.6 6.9"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SharedSpeechStyleFields({
  selectedStyle,
  disabled,
  onSelect,
  previewContext,
  initialFocusRef,
  emptyMessage,
}: SharedSpeechStyleFieldsProps) {
  const ownSelectedOptionRef = useRef<HTMLButtonElement | null>(null);
  const selectedOptionRef = initialFocusRef ?? ownSelectedOptionRef;
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const samples = selectedStyle
    ? buildSpeechStylePreviewSamples(selectedStyle, previewContext)
    : null;
  return (
    <div id="settings-bot-speech-style" className="settings-speech-preview">
      <div className="settings-speech-style-grid" role="radiogroup" aria-label="Стиль речи бота">
        {BOT_SPEECH_STYLE_OPTIONS.map((option, index) => (
          <button
            key={option.value}
            ref={(node) => {
              optionRefs.current[index] = node;
              if (selectedStyle === option.value) {
                selectedOptionRef.current = node;
              }
            }}
            type="button"
            role="radio"
            aria-checked={selectedStyle === option.value}
            tabIndex={selectedStyle === option.value || (!selectedStyle && index === 0) ? 0 : -1}
            className={cn(
              'settings-speech-style-option',
              selectedStyle === option.value && 'is-active',
            )}
            onClick={() => onSelect(option.value)}
            onKeyDown={(event) => {
              const nextIndex = resolveRadioGroupNavigationIndex(
                index,
                BOT_SPEECH_STYLE_OPTIONS.length,
                event.key,
              );
              if (nextIndex === null) {
                return;
              }

              event.preventDefault();
              const nextOption = BOT_SPEECH_STYLE_OPTIONS[nextIndex];
              if (!nextOption) {
                return;
              }
              onSelect(nextOption.value);
              optionRefs.current[nextIndex]?.focus();
            }}
            disabled={disabled}
          >
            {selectedStyle === option.value ? (
              <span className="settings-speech-style-option__badge" aria-hidden>
                <SelectedIcon />
              </span>
            ) : null}
            <span className="settings-speech-style-option__icon" aria-hidden>
              <img src={STYLE_ICONS[option.iconKey]} alt="" />
            </span>
            <span className="settings-speech-style-option__label">{option.shortLabel}</span>
          </button>
        ))}
      </div>

      <p className="settings-native-toggle__hint" aria-live="polite">
        {selectedStyle
          ? BOT_SPEECH_STYLE_METADATA[selectedStyle].description
          : (emptyMessage ?? 'Разные значения. Выберите общий стиль речи.')}
      </p>
      <p className="settings-native-toggle__hint">
        Примеры стандартных сообщений. Ваши собственные тексты и изображения сохранятся.
      </p>

      {samples ? (
        <>
          <div className="settings-subsection-divider" role="separator" aria-label="Приветствие">
            <span>Приветствие</span>
          </div>

          <div className="settings-native-toggle">
            <div className="settings-native-toggle__row">
              <span className="settings-native-toggle__title">Новые участники</span>
            </div>
            <p className="settings-native-toggle__hint">{samples.greeting}</p>
          </div>

          <div
            className="settings-subsection-divider"
            role="separator"
            aria-label="Стандартные действия бота"
          >
            <span>Стандартные действия бота</span>
          </div>

          {[
            ['1. Объяснение', samples.explanation],
            ['2. Предупреждение', samples.warning],
            ['3. Ограничение', samples.mute],
            ['4. Блокировка', samples.ban],
            ['Повтор сообщения', samples.duplicate],
            ['Ночной режим', samples.night],
          ].map(([title, text], index) => (
            <div
              key={title}
              className={cn(
                'settings-native-toggle',
                index > 0 && 'settings-native-toggle--nested',
              )}
            >
              <div className="settings-native-toggle__row">
                <span className="settings-native-toggle__title">{title}</span>
              </div>
              <p className="settings-native-toggle__hint">{text}</p>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
