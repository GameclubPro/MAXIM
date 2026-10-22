import { LEGACY_STOP_WORD_PHRASES, type StopWordsRule } from '@maxim/contracts/settings';
import { MESSAGE_LIMITS_BLOCKED_WORD_PRESETS } from '../../lib/message-limits-blocked-word-presets';
import { prepareStopWordsLists } from '../../lib/stop-words-editor';
import { AppIcon } from '../../components/ui/app-icon';

export type SharedStopWordsPresetButtonsProps = {
  items: readonly StopWordsRule[];
  disabled: boolean;
  replace: (items: StopWordsRule[]) => void;
  onError: (message: string) => void;
};

export function SharedStopWordsPresetButtons({
  items,
  disabled,
  replace,
  onError,
}: SharedStopWordsPresetButtonsProps) {
  return (
    <>
      {MESSAGE_LIMITS_BLOCKED_WORD_PRESETS.map((preset) => {
        const omitted = new Set(['рулетка', 'отливка', 'простыезадания', 'продвижениетоваров']);
        const values = preset.words
          .filter((word) => !omitted.has(word))
          .map((word) => LEGACY_STOP_WORD_PHRASES[word] ?? word);
        return (
          <details key={preset.id} className="stop-words-editor__section">
            <summary>{preset.title}</summary>
            <div className="stop-words-editor__preview-values">
              {values.map((value) => (
                <span key={value}>{value}</span>
              ))}
            </div>
            <button
              type="button"
              className="button button--accent"
              disabled={disabled}
              onClick={() => {
                const parsed = prepareStopWordsLists(
                  { rules: [...items], domains: [] },
                  values.join('\n'),
                );
                if (parsed.errors.length) {
                  onError(parsed.errors[0]);
                  return;
                }
                replace(parsed.lists.rules);
              }}
            >
              <AppIcon icon="Plus" />
              Добавить набор
            </button>
          </details>
        );
      })}
    </>
  );
}
