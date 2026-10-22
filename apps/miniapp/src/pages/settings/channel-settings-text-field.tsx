import { useEffect, useState } from 'react';
import type { ChannelSettingsFieldAdapter } from '../../features/network-settings/field-model';
import { cn } from '../../lib/cn';

type TextPath =
  | 'commentsMessageText'
  | 'postSuggestionsButtonText'
  | 'postSuggestionsText'
  | 'engagementMessageText'
  | 'text'
  | 'url';
export function ChannelSettingsTextField({
  fields,
  path,
  label,
  placeholder = '',
  rows,
  maxLength,
  className,
  id,
  onBlur,
}: {
  fields: ChannelSettingsFieldAdapter;
  path: TextPath;
  label: string;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  className?: string;
  id?: string;
  onBlur?: () => void;
}) {
  const state = fields.read(path);
  const key = state.kind === 'common' ? state.value : state.kind;
  const [buffer, setBuffer] = useState<string | null>(null);
  useEffect(() => setBuffer(null), [key]);
  const error = fields.error(path);
  const props = {
    id,
    value: buffer ?? (state.kind === 'common' ? state.value : ''),
    placeholder: state.kind === 'mixed' ? 'Разные значения' : placeholder,
    maxLength,
    'aria-label': label,
    'aria-invalid': Boolean(error),
    disabled: fields.readOnly || state.kind === 'loading',
    onBlur,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = event.target.value;
      setBuffer(value);
      try {
        fields.setScalar(path, value);
        fields.setError(path, null);
      } catch (cause) {
        fields.setError(path, cause instanceof Error ? cause.message : 'Проверьте значение.');
      }
    },
  };
  return (
    <label className={cn('field', className, error && 'field--error')}>
      <span>{label}</span>
      {rows ? (
        <textarea {...props} rows={rows} />
      ) : (
        <input
          {...props}
          type={path === 'url' ? 'url' : 'text'}
          {...(path === 'url'
            ? ({
                inputMode: 'url',
                autoCapitalize: 'none',
                autoCorrect: 'off',
                spellCheck: false,
                enterKeyHint: 'done',
              } as const)
            : {})}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      )}
      {error ? (
        <small className="field__hint" role="alert">
          {error}
        </small>
      ) : null}
    </label>
  );
}
