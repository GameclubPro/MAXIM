import { normalizeMessageLimitsBlockedWordCandidate } from '@maxim/contracts';
import { useState } from 'react';
import { cn } from '../lib/cn';
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

function normalizeMessageLimitsBlockedWords(values: readonly string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((item) => normalizeMessageLimitsBlockedWordCandidate(item))
        .filter((item): item is string => Boolean(item)),
    ),
  );
}

function mergeMessageLimitsBlockedWords(
  currentWords: readonly string[],
  candidates: readonly string[],
  maxWords: number,
): {
  addedWords: string[];
  nextWords: string[];
} {
  const existingWords = new Set(normalizeMessageLimitsBlockedWords(currentWords));
  const nextWords = [...currentWords];
  const addedWords: string[] = [];

  for (const candidate of normalizeMessageLimitsBlockedWords(candidates)) {
    if (nextWords.length >= maxWords || existingWords.has(candidate)) {
      continue;
    }

    existingWords.add(candidate);
    nextWords.push(candidate);
    addedWords.push(candidate);
  }

  return {
    addedWords,
    nextWords,
  };
}

export default function MessageLimitsBlockedWordPresets({
  selectedWords,
  remainingSlots,
  onApplyWords,
}: MessageLimitsBlockedWordPresetsProps) {
  const { pushToast } = useToast();
  const [activePresetId, setActivePresetId] = useState<MessageLimitsBlockedWordPresetId | null>(null);
  const selectedWordsSet = new Set(normalizeMessageLimitsBlockedWords(selectedWords));
  const activePreset =
    MESSAGE_LIMITS_BLOCKED_WORD_PRESETS.find((preset) => preset.id === activePresetId) ?? null;
  const activePresetWords = activePreset ? normalizeMessageLimitsBlockedWords(activePreset.words) : [];
  const activePresetMissingWords = activePresetWords.filter((word) => !selectedWordsSet.has(word));
  const activePresetAddableCount = Math.min(remainingSlots, activePresetMissingWords.length);

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

  return (
    <>
      <div className="settings-word-banlist__preset-grid">
        {MESSAGE_LIMITS_BLOCKED_WORD_PRESETS.map((preset) => {
          const presetWords = normalizeMessageLimitsBlockedWords(preset.words);
          const missingWords = presetWords.filter((word) => !selectedWordsSet.has(word));
          const addableCount = Math.min(remainingSlots, missingWords.length);
          const previewWords = presetWords.slice(0, 4);
          const hiddenPreviewWords = Math.max(0, presetWords.length - previewWords.length);

          return (
            <article
              key={preset.id}
              className={cn(
                'settings-word-banlist__preset-card',
                `settings-word-banlist__preset-card--${preset.id}`,
              )}
            >
              <div className="settings-word-banlist__preset-head">
                <div className="settings-word-banlist__preset-copy">
                  <strong>{preset.title}</strong>
                  <p>{preset.description}</p>
                </div>

                <button
                  type="button"
                  className={cn('settings-info-button', activePresetId === preset.id && 'is-open')}
                  aria-label={`Открыть полный список слов пакета ${preset.title}`}
                  onClick={() =>
                    setActivePresetId((current) => (current === preset.id ? null : preset.id))
                  }
                >
                  <span aria-hidden>i</span>
                </button>
              </div>

              <div
                className="settings-word-banlist__preset-preview"
                aria-label={`Превью слов пакета ${preset.title}`}
              >
                {previewWords.map((word) => (
                  <span key={word} className="settings-word-banlist__preset-preview-chip">
                    {word}
                  </span>
                ))}
                {hiddenPreviewWords > 0 ? (
                  <span className="settings-word-banlist__preset-preview-chip is-muted">
                    +{hiddenPreviewWords}
                  </span>
                ) : null}
              </div>

              <div className="settings-word-banlist__preset-footer">
                <span className="settings-word-banlist__preset-meta">
                  {presetWords.length} слов
                  {addableCount > 0
                    ? ` • добавится ${addableCount}`
                    : remainingSlots === 0
                      ? ' • лимит достигнут'
                      : ' • уже в списке'}
                </span>

                <button
                  type="button"
                  className="button button--ghost settings-word-banlist__preset-action"
                  onClick={() => applyPreset(preset)}
                  disabled={addableCount === 0}
                >
                  {addableCount > 0
                    ? `Добавить ${addableCount}`
                    : remainingSlots === 0
                      ? 'Лимит'
                      : 'Добавлено'}
                </button>
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
            <div className="settings-drilldown__footer-actions is-single-action">
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
                  ? `Добавить ${activePresetAddableCount} слов в стоп-лист`
                  : remainingSlots === 0
                    ? 'Лимит стоп-слов уже достигнут'
                    : 'Все слова уже добавлены'}
              </button>
            </div>
          }
        >
          <div className="settings-word-banlist__preset-sheet">
            <div className="settings-word-banlist__preset-sheet-facts">
              <span className="chip">{activePresetWords.length} слов</span>
              <span className="chip">Новых: {activePresetAddableCount}</span>
            </div>

            <p className="settings-word-banlist__preset-sheet-note">
              Пакет добавляется поверх текущего списка. Перед применением можно просмотреть все
              слова ниже.
            </p>

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
