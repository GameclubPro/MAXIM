import { useState } from 'react';
import { cn } from '../lib/cn';
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

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden focusable="false">
      <path
        d="M8 3.25V12.75M3.25 8H12.75"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden focusable="false">
      <path
        d="M3.25 8H12.75"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatPresetDelta(
  addableCount: number,
  removableCount: number,
  remainingSlots: number,
): string {
  if (addableCount > 0 && removableCount > 0) {
    return `+${addableCount} · -${removableCount}`;
  }

  if (addableCount > 0) {
    return `+${addableCount}`;
  }

  if (removableCount > 0) {
    return `-${removableCount}`;
  }

  return remainingSlots === 0 ? 'лимит' : 'без изменений';
}

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
          const compactTitle =
            preset.id === 'gambling'
              ? 'Казино'
              : preset.id === 'earnings'
                ? 'Заработок'
                : preset.id === 'crypto'
                  ? 'Крипта'
                  : 'Таро';

          return (
            <article
              key={preset.id}
              className={cn(
                'settings-word-banlist__preset-card',
                `settings-word-banlist__preset-card--${preset.id}`,
              )}
            >
              <div className="settings-word-banlist__preset-head">
                <div className="settings-word-banlist__preset-badge-copy">
                  <span className="settings-word-banlist__preset-badge-mark" aria-hidden>
                    ±
                  </span>
                  <div className="settings-word-banlist__preset-badge-text">
                    <strong>{compactTitle}</strong>
                    <small>
                      {formatPresetDelta(addableCount, removableCount, remainingSlots)} из{' '}
                      {presetWords.length}
                    </small>
                  </div>
                </div>

                <div className="settings-word-banlist__preset-actions">
                  <button
                    type="button"
                    className={cn(
                      'settings-info-button',
                      activePresetId === preset.id && 'is-open',
                    )}
                    aria-label={`Открыть полный список слов пакета ${preset.title}`}
                    onClick={() =>
                      setActivePresetId((current) => (current === preset.id ? null : preset.id))
                    }
                  >
                    <span aria-hidden>i</span>
                  </button>

                  <button
                    type="button"
                    className="settings-word-banlist__preset-action settings-word-banlist__preset-action--remove"
                    onClick={() => removePreset(preset)}
                    disabled={removableCount === 0}
                    aria-label={
                      removableCount > 0
                        ? `Убрать слова пакета ${preset.title}`
                        : `Из пакета ${preset.title} нечего убирать`
                    }
                  >
                    <MinusIcon />
                  </button>

                  <button
                    type="button"
                    className="settings-word-banlist__preset-action settings-word-banlist__preset-action--add"
                    onClick={() => applyPreset(preset)}
                    disabled={addableCount === 0}
                    aria-label={
                      addableCount > 0
                        ? `Добавить пакет ${preset.title}`
                        : remainingSlots === 0
                          ? `Лимит стоп-слов достигнут для пакета ${preset.title}`
                          : `Пакет ${preset.title} уже добавлен`
                    }
                  >
                    <PlusIcon />
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
                {activePresetRemovableCount > 0
                  ? `Убрать ${activePresetRemovableCount} слов`
                  : 'Убирать нечего'}
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
              <span className="chip">В списке: {activePresetRemovableCount}</span>
            </div>

            <p className="settings-word-banlist__preset-sheet-note">
              Пакет можно добавить поверх текущего списка или целиком убрать из него. Перед
              применением можно просмотреть все слова ниже.
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
