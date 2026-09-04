import { useEffect, useReducer, useRef } from 'react';
import { cn } from '../../lib/cn';
import {
  createVkParsingNumberDraftState,
  parseVkParsingIntegerDraft,
  reduceVkParsingNumberDraft,
} from './model';

type CommittedNumberFieldProps = {
  label: string;
  ariaLabel: string;
  value: number | '';
  mixed?: boolean;
  min: number;
  max: number;
  available?: boolean;
  disabled: boolean;
  className?: string;
  onCommit: (value: number) => Promise<boolean>;
};

export function CommittedNumberField({
  label,
  ariaLabel,
  value,
  mixed = false,
  min,
  max,
  available = true,
  disabled,
  className,
  onCommit,
}: CommittedNumberFieldProps) {
  const serverDraft = value === '' ? '' : String(value);
  const serverDraftRef = useRef(serverDraft);
  const availableRef = useRef(available);
  const suppressBlurCommitRef = useRef(false);
  const [state, dispatch] = useReducer(
    reduceVkParsingNumberDraft,
    value,
    createVkParsingNumberDraftState,
  );
  serverDraftRef.current = serverDraft;
  availableRef.current = available;

  useEffect(() => {
    dispatch(available ? { type: 'sync', serverDraft } : { type: 'reset', serverDraft: '' });
  }, [available, serverDraft]);

  const commit = async () => {
    const nextValue = parseVkParsingIntegerDraft(state.draft, min, max);
    if (nextValue === null) {
      dispatch({
        type: 'reset',
        serverDraft: availableRef.current ? serverDraftRef.current : '',
      });
      return;
    }
    if (!mixed && value === nextValue) {
      dispatch({ type: 'reset', serverDraft: serverDraftRef.current });
      return;
    }

    dispatch({ type: 'submit', value: nextValue });
    let saved = false;
    try {
      saved = await onCommit(nextValue);
    } catch {
      saved = false;
    }
    dispatch({
      type: 'reset',
      serverDraft: saved ? String(nextValue) : availableRef.current ? serverDraftRef.current : '',
    });
  };

  const pending = state.pendingValue !== null;
  const fieldDisabled = !available || disabled || pending;

  return (
    <label className={cn(className)}>
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        aria-label={ariaLabel}
        aria-busy={pending || undefined}
        value={available ? state.draft : ''}
        placeholder={available && mixed ? 'Разные' : undefined}
        disabled={fieldDisabled}
        onFocus={() => dispatch({ type: 'focus' })}
        onChange={(event) => dispatch({ type: 'change', draft: event.target.value })}
        onBlur={() => {
          if (suppressBlurCommitRef.current) {
            suppressBlurCommitRef.current = false;
            return;
          }
          if (state.editing && !pending) {
            void commit();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            suppressBlurCommitRef.current = true;
            dispatch({
              type: 'reset',
              serverDraft: availableRef.current ? serverDraftRef.current : '',
            });
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
