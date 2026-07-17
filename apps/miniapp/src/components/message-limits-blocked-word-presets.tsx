import { useState } from 'react';
import { cn } from '../lib/cn';
import './message-limits-blocked-word-presets.css';
import {
  mergeMessageLimitsBlockedWords,
  normalizeMessageLimitsBlockedWords,
  subtractMessageLimitsBlockedWords,
} from '../lib/message-limits-blocked-words';
import {
  MESSAGE_LIMITS_BLOCKED_WORD_PRESETS,
  type MessageLimitsBlockedWordPreset,
  type MessageLimitsBlockedWordPresetId,
} from '../lib/message-limits-blocked-word-presets';
import { SettingsDrilldownPanel } from './ui/settings-drilldown-panel';
import { useToast } from './ui/toast';

type MessageLimitsBlockedWordPresetsProps = {
  selectedWords: readonly string[];
  remainingSlots: number;
  onApplyWords: (nextWords: string[]) => void;
};

function formatPresetState(selectedCount: number, totalCount: number): string {
  if (selectedCount === 0) {
    return `${totalCount} слов`;
  }
  if (selectedCount === totalCount) {
    return 'Добавлен';
  }
  return `${selectedCount} из ${totalCount}`;
}

const MESSAGE_LIMITS_BLOCKED_WORD_PRESET_COMPACT_TITLES: Record<
  MessageLimitsBlockedWordPresetId,
  string
> = {
  gambling: 'Казино',
  earnings: 'Заработок',
  crypto: 'Крипта',
  accounts: 'Аккаунты',
  tarot: 'Таро',
};

export default function MessageLimitsBlockedWordPresets({
  selectedWords,
  remainingSlots,
  onApplyWords,
}: MessageLimitsBlockedWordPresetsProps) {
  const { pushToast } = useToast();
  const [activePresetId, setActivePresetId] = useState<MessageLimitsBlockedWordPresetId | null>(
    null,
  );
  const selectedWordsSet = new Set(normalizeMessageLimitsBlockedWords(selectedWords));
  const activePreset =
    MESSAGE_LIMITS_BLOCKED_WORD_PRESETS.find((preset) => preset.id === activePresetId) ?? null;
  const activePresetWords = activePreset
    ? normalizeMessageLimitsBlockedWords(activePreset.words)
    : [];
  const activePresetSelectedWords = activePresetWords.filter((word) => selectedWordsSet.has(word));
  const activePresetMissingWords = activePresetWords.filter((word) => !selectedWordsSet.has(word));
  const activePresetAddableCount = Math.min(remainingSlots, activePresetMissingWords.length);
  const activePresetRemovableCount = activePresetSelectedWords.length;

  function applyPreset(preset: MessageLimitsBlockedWordPreset) {
    const { addedWords, nextWords } = mergeMessageLimitsBlockedWords(
      selectedWords,
      preset.words,
      selectedWords.length + remainingSlots,
    );

    if (addedWords.length === 0) {
      pushToast({
        tone: 'info',
        title: remainingSlots === 0 ? 'Лимит стоп-слов достигнут' : 'Пакет уже добавлен',
      });
      return;
    }

    onApplyWords(nextWords);
    pushToast({
      tone: 'success',
      title: `+${addedWords.length} слов`,
    });
  }

  function removePreset(preset: MessageLimitsBlockedWordPreset) {
    const { nextWords, removedWords } = subtractMessageLimitsBlockedWords(
      selectedWords,
      preset.words,
    );

    if (removedWords.length === 0) {
      pushToast({
        tone: 'info',
        title: 'Из пакета нечего убирать',
      });
      return;
    }

    onApplyWords(nextWords);
    pushToast({
      tone: 'success',
      title: `-${removedWords.length} слов`,
    });
  }

  return (
    <>
      <div className="settings-word-banlist__preset-grid">
        {MESSAGE_LIMITS_BLOCKED_WORD_PRESETS.map((preset) => {
          const presetWords = normalizeMessageLimitsBlockedWords(preset.words);
          const selectedPresetWords = presetWords.filter((word) => selectedWordsSet.has(word));
          const missingWords = presetWords.filter((word) => !selectedWordsSet.has(word));
          const addableCount = Math.min(remainingSlots, missingWords.length);
          const removableCount = selectedPresetWords.length;
          const compactTitle = MESSAGE_LIMITS_BLOCKED_WORD_PRESET_COMPACT_TITLES[preset.id];

          return (
            <article
              key={preset.id}
              className={cn(
                'settings-word-banlist__preset-card',
                `settings-word-banlist__preset-card--${preset.id}`,
                removableCount > 0 && 'is-selected',
              )}
            >
              <div className="settings-word-banlist__preset-head">
                <button
                  type="button"
                  className="settings-word-banlist__preset-open"
                  onClick={() => setActivePresetId(preset.id)}
                  aria-label={`Открыть набор «${preset.title}»`}
                >
                  <div className="settings-word-banlist__preset-badge-text">
                    <strong>{compactTitle}</strong>
                    <small>{formatPresetState(removableCount, presetWords.length)}</small>
                  </div>
                  <span className="settings-word-banlist__preset-chevron" aria-hidden>
                    ›
                  </span>
                </button>

                <div className="settings-word-banlist__preset-actions">
                  <button
                    type="button"
                    className="settings-word-banlist__preset-toggle"
                    onClick={() =>
                      missingWords.length > 0 ? applyPreset(preset) : removePreset(preset)
                    }
                    disabled={missingWords.length > 0 && addableCount === 0}
                  >
                    {missingWords.length === 0
                      ? 'Убрать'
                      : removableCount > 0
                        ? 'Дополнить'
                        : remainingSlots === 0
                          ? 'Лимит'
                          : 'Добавить'}
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {activePreset ? (
        <SettingsDrilldownPanel
          id={`message-limits-blocked-word-preset-${activePreset.id}`}
          open
          title={activePreset.title}
          summary={activePreset.description}
          onClose={() => setActivePresetId(null)}
          className="settings-drilldown__panel--blocked-word-preset"
          footer={
            <div className="settings-drilldown__footer-actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  removePreset(activePreset);
                  setActivePresetId(null);
                }}
                disabled={activePresetRemovableCount === 0}
              >
                {activePresetRemovableCount > 0 ? 'Убрать' : 'Не добавлен'}
              </button>
              <button
                type="button"
                className="button button--accent"
                onClick={() => {
                  applyPreset(activePreset);
                  setActivePresetId(null);
                }}
                disabled={activePresetAddableCount === 0}
              >
                {activePresetAddableCount > 0
                  ? 'Добавить'
                  : remainingSlots === 0
                    ? 'Лимит достигнут'
                    : 'Уже добавлен'}
              </button>
            </div>
          }
        >
          <div className="settings-word-banlist__preset-sheet">
            <div
              className="settings-word-banlist__preset-sheet-words"
              aria-label={`Полный список слов пакета ${activePreset.title}`}
            >
              {activePresetWords.map((word) => (
                <span
                  key={word}
                  className={cn(
                    'settings-word-banlist__preset-sheet-word',
                    selectedWordsSet.has(word) && 'is-active',
                  )}
                >
                  {word}
                </span>
              ))}
            </div>
          </div>
        </SettingsDrilldownPanel>
      ) : null}
    </>
  );
}
