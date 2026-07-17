import {
  BOT_SPEECH_STYLE_METADATA,
  BOT_SPEECH_STYLE_OPTIONS,
  type BotSpeechStyle,
} from '@maxim/contracts/bot-speech';
import botSpeechRobotImage from '../../../../../bot.webp';
import botSpeechFriendlyImage from '../../../../../frendly.webp';
import botSpeechIronicImage from '../../../../../joker.webp';
import botSpeechPoliceImage from '../../../../../police.webp';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { cn } from '../../lib/cn';

type SpeechStylePreviewSamples = {
  greeting: string;
  explanation: string;
  warning: string;
  mute: string;
  ban: string;
};

type SettingsSpeechStylePanelProps = {
  activeStyle: BotSpeechStyle | null;
  selectedStyle: BotSpeechStyle;
  samples: SpeechStylePreviewSamples;
  isSaving: boolean;
  onSelect: (style: BotSpeechStyle) => void;
  onClose: () => void;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: (style: BotSpeechStyle) => void;
};

const STYLE_LABELS: Record<BotSpeechStyle, string> = {
  ROBOT: 'Робот',
  FRIENDLY: 'Друг',
  POLICE: 'Коп',
  IRONIC: 'Шут',
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

export default function SettingsSpeechStylePanel({
  activeStyle,
  selectedStyle,
  samples,
  isSaving,
  onSelect,
  onClose,
  onCancel,
  onDiscard,
  onSave,
}: SettingsSpeechStylePanelProps) {
  const isDirty = selectedStyle !== activeStyle;

  return (
    <SettingsDrilldownPanel
      id="settings-bot-speech-style-panel"
      open
      title="Стиль речи"
      summary={BOT_SPEECH_STYLE_METADATA[selectedStyle].label}
      tone="mint"
      className="settings-drilldown__panel--notice settings-drilldown__panel--speech"
      onClose={onClose}
      confirmCloseWhen={isDirty}
      onDiscardChanges={onDiscard}
      footer={
        isDirty ? (
          <div className="settings-drilldown__footer-actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={onCancel}
              disabled={isSaving}
            >
              Отмена
            </button>
            <button
              type="button"
              className="button button--accent"
              onClick={() => onSave(selectedStyle)}
              disabled={isSaving || !isDirty}
            >
              {isSaving ? 'Сохраняем...' : isDirty ? 'Сохранить' : 'Сохранено'}
            </button>
          </div>
        ) : null
      }
    >
      <div id="settings-bot-speech-style" className="settings-speech-preview">
        <div className="settings-speech-style-grid" role="radiogroup" aria-label="Стиль речи бота">
          {BOT_SPEECH_STYLE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selectedStyle === option.value}
              className={cn(
                'settings-speech-style-option',
                selectedStyle === option.value && 'is-active',
              )}
              onClick={() => onSelect(option.value)}
              disabled={isSaving}
            >
              {selectedStyle === option.value ? (
                <span className="settings-speech-style-option__badge" aria-hidden>
                  <SelectedIcon />
                </span>
              ) : null}
              <span className="settings-speech-style-option__icon" aria-hidden>
                <img src={STYLE_ICONS[option.iconKey]} alt="" />
              </span>
              <span className="settings-speech-style-option__label">
                {STYLE_LABELS[option.value]}
              </span>
            </button>
          ))}
        </div>

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
        ].map(([title, text], index) => (
          <div
            key={title}
            className={cn('settings-native-toggle', index > 0 && 'settings-native-toggle--nested')}
          >
            <div className="settings-native-toggle__row">
              <span className="settings-native-toggle__title">{title}</span>
            </div>
            <p className="settings-native-toggle__hint">{text}</p>
          </div>
        ))}
      </div>
    </SettingsDrilldownPanel>
  );
}
