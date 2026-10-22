import { LEGACY_STOP_WORD_PHRASES, type StopWordsRule } from '@maxim/contracts/settings';
import { MESSAGE_LIMITS_BLOCKED_WORD_PRESETS } from '../../lib/message-limits-blocked-word-presets';
import { prepareStopWordsLists } from '../../lib/stop-words-editor';

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
      {MESSAGE_LIMITS_BLOCKED_WORD_PRESETS.map((preset) => (
        <button
          type="button"
          key={preset.id}
          disabled={disabled}
          onClick={() => {
            const omitted = new Set(['рулетка', 'отливка', 'простыезадания', 'продвижениетоваров']);
            const values = preset.words
              .filter((word) => !omitted.has(word))
              .map((word) => LEGACY_STOP_WORD_PHRASES[word] ?? word);
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
          {preset.title}
        </button>
      ))}
    </>
  );
}
