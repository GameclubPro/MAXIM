import {
  BOT_SPEECH_STYLE_METADATA,
  resolveBotSpeechStyle,
  type BotSpeechStyle,
} from '@maxim/contracts/bot-speech';
import { useRef } from 'react';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionIcon } from '../../components/ui/settings-section-toggle';
import type { BotSpeechPreviewContext } from '../../lib/bot-speech-preview-context';
import { SharedSpeechStyleFields } from './shared-speech-style-fields';

type SettingsSpeechStylePanelProps = {
  activeStyle: BotSpeechStyle | null;
  selectedStyle: BotSpeechStyle;
  previewContext?: BotSpeechPreviewContext;
  isSaving: boolean;
  onSelect: (style: BotSpeechStyle) => void;
  onClose: () => void;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: (style: BotSpeechStyle) => void;
};

export default function SettingsSpeechStylePanel({
  activeStyle,
  selectedStyle,
  previewContext,
  isSaving,
  onSelect,
  onClose,
  onCancel,
  onDiscard,
  onSave,
}: SettingsSpeechStylePanelProps) {
  const isDirty = selectedStyle !== resolveBotSpeechStyle(activeStyle);
  const selectedOptionRef = useRef<HTMLButtonElement | null>(null);

  return (
    <SettingsDrilldownPanel
      id="settings-bot-speech-style-panel"
      icon={<SettingsSectionIcon name="comments" />}
      open
      title="Стиль речи"
      summary={BOT_SPEECH_STYLE_METADATA[selectedStyle].label}
      tone="mint"
      className="settings-drilldown__panel--notice settings-drilldown__panel--speech"
      onClose={onClose}
      confirmCloseWhen={isDirty}
      closeDisabled={isSaving}
      onDiscardChanges={onDiscard}
      initialFocusRef={selectedOptionRef}
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
      <SharedSpeechStyleFields
        selectedStyle={selectedStyle}
        disabled={isSaving}
        onSelect={onSelect}
        previewContext={previewContext}
        initialFocusRef={selectedOptionRef}
      />
    </SettingsDrilldownPanel>
  );
}
