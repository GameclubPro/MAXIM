import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { SettingsFieldState } from './field-model';
import type { BotSpeechMediaImage } from '@maxim/contracts/settings';

type FieldProps<T> = {
  state: SettingsFieldState<T>;
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  error?: string | null;
  description?: ReactNode;
  onError?: (error: string | null) => void;
};
function FieldFrame({
  label,
  error,
  description,
  children,
}: {
  label: string;
  error?: string | null;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="network-settings-field">
      <span className="network-settings-field__label">{label}</span>
      {children}
      {description ? <small>{description}</small> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
export function FieldToggle({
  state,
  onChange,
  label,
  disabled,
  error,
  description,
}: FieldProps<boolean>) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state.kind === 'mixed';
  }, [state.kind]);
  return (
    <FieldFrame label={label} error={error} description={description}>
      <label className="network-settings-field__toggle">
        <input
          ref={ref}
          type="checkbox"
          checked={state.kind === 'common' && state.value}
          aria-label={label}
          aria-checked={state.kind === 'mixed' ? 'mixed' : state.kind === 'common' && state.value}
          disabled={disabled || state.kind === 'loading'}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          {state.kind === 'mixed'
            ? 'Разные значения'
            : state.kind === 'loading'
              ? 'Загрузка…'
              : state.value
                ? 'Включено'
                : 'Выключено'}
        </span>
      </label>
    </FieldFrame>
  );
}
export function FieldText({
  state,
  onChange,
  label,
  disabled,
  error,
  description,
  multiline = false,
  maxLength,
  onError,
  placeholder,
}: FieldProps<string> & { multiline?: boolean; maxLength?: number; placeholder?: string }) {
  const [buffer, setBuffer] = useState<string | null>(null);
  const key = state.kind === 'common' ? state.value : state.kind;
  useEffect(() => setBuffer(null), [key]);
  const props = {
    value: buffer ?? (state.kind === 'common' ? state.value : ''),
    placeholder: state.kind === 'mixed' ? 'Разные значения' : placeholder,
    'aria-label': label,
    disabled: disabled || state.kind === 'loading',
    maxLength,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setBuffer(e.target.value);
      try {
        onError?.(null);
        onChange(e.target.value);
      } catch (cause) {
        onError?.(cause instanceof Error ? cause.message : 'Проверьте значение.');
      }
    },
  };
  return (
    <FieldFrame label={label} error={error} description={description}>
      {multiline ? <textarea {...props} /> : <input type="text" {...props} />}
    </FieldFrame>
  );
}
export function FieldNumber({
  state,
  onChange,
  label,
  disabled,
  error,
  description,
  min,
  max,
  step = 1,
  onError,
}: FieldProps<number> & { min?: number; max?: number; step?: number }) {
  const [buffer, setBuffer] = useState<string | null>(null);
  const key = state.kind === 'common' ? state.value : state.kind;
  useEffect(() => setBuffer(null), [key]);
  return (
    <FieldFrame label={label} error={error} description={description}>
      <input
        type="number"
        inputMode="decimal"
        aria-label={label}
        value={buffer ?? (state.kind === 'common' ? String(state.value) : '')}
        placeholder={state.kind === 'mixed' ? 'Разные значения' : undefined}
        min={min}
        max={max}
        step={step}
        disabled={disabled || state.kind === 'loading'}
        onChange={(e) => {
          const raw = e.target.value;
          setBuffer(raw);
          const value = Number(raw);
          if (
            !raw.trim() ||
            !Number.isFinite(value) ||
            (min !== undefined && value < min) ||
            (max !== undefined && value > max) ||
            (step === 1 && !Number.isInteger(value))
          ) {
            onError?.('Укажите допустимое число.');
            return;
          }
          try {
            onError?.(null);
            onChange(value);
          } catch (cause) {
            onError?.(cause instanceof Error ? cause.message : 'Проверьте число.');
          }
        }}
      />
    </FieldFrame>
  );
}
export function FieldSelect<T extends string>({
  state,
  onChange,
  label,
  disabled,
  error,
  description,
  options,
}: FieldProps<T> & { options: readonly { value: T; label: string }[] }) {
  return (
    <FieldFrame label={label} error={error} description={description}>
      <select
        aria-label={label}
        value={state.kind === 'common' ? state.value : ''}
        disabled={disabled || state.kind === 'loading'}
        onChange={(e) => {
          const value = options.find((o) => o.value === e.target.value)?.value;
          if (value !== undefined) onChange(value);
        }}
      >
        {state.kind !== 'common' ? (
          <option value="" disabled>
            {state.kind === 'mixed' ? 'Разные значения' : 'Загрузка…'}
          </option>
        ) : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldFrame>
  );
}
export function FieldTime({
  state,
  onChange,
  label,
  disabled,
  error,
  description,
  onError,
}: FieldProps<number>) {
  const [buffer, setBuffer] = useState<string | null>(null);
  const key = state.kind === 'common' ? state.value : state.kind;
  useEffect(() => setBuffer(null), [key]);
  const saved =
    state.kind === 'common'
      ? String(Math.floor(state.value / 60)).padStart(2, '0') +
        ':' +
        String(state.value % 60).padStart(2, '0')
      : '';
  return (
    <FieldFrame label={label} error={error} description={description}>
      <input
        aria-label={label}
        inputMode="numeric"
        placeholder={state.kind === 'mixed' ? 'Разное время · ЧЧ:ММ' : 'ЧЧ:ММ'}
        value={buffer ?? saved}
        disabled={disabled || state.kind === 'loading'}
        onChange={(event) => {
          const raw = event.target.value;
          setBuffer(raw);
          const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
          if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
            onError?.('Укажите время в формате ЧЧ:ММ.');
            return;
          }
          try {
            onError?.(null);
            onChange(Number(match[1]) * 60 + Number(match[2]));
          } catch (cause) {
            onError?.(cause instanceof Error ? cause.message : 'Проверьте время.');
          }
        }}
      />
    </FieldFrame>
  );
}
export function FieldMedia({
  state,
  onChange,
  label,
  disabled,
  error,
  onClear,
  onRevert,
  onError,
}: FieldProps<BotSpeechMediaImage | null> & { onClear: () => void; onRevert?: () => void }) {
  const id = useId();
  const [failure, setFailure] = useState<string | null>(null);
  const request = useRef(0);
  const latest = useRef({ state, disabled, onChange, onError });
  const before = latest.current.state;
  const sameMedia =
    before.kind === state.kind &&
    (before.kind !== 'common' ||
      state.kind !== 'common' ||
      before.value === state.value ||
      (before.value !== null &&
        state.value !== null &&
        before.value.base64 === state.value.base64 &&
        before.value.mimeType === state.value.mimeType &&
        before.value.fileName === state.value.fileName));
  if (!sameMedia || disabled !== latest.current.disabled) request.current++;
  latest.current = { state, disabled, onChange, onError };
  const isAvailable = () => !latest.current.disabled && latest.current.state.kind !== 'loading';
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  return (
    <FieldFrame label={label} error={failure ?? error}>
      <span>
        {state.kind === 'mixed'
          ? 'Разные изображения'
          : state.kind === 'common' && state.value
            ? 'Изображение добавлено'
            : 'Изображение не выбрано'}
      </span>
      <label className="network-settings-media-input" htmlFor={id}>
        Выбрать изображение
        <input
          id={id}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label={label}
          disabled={disabled || state.kind === 'loading'}
          onChange={async (e) => {
            const input = e.currentTarget;
            const file = input.files?.[0];
            if (!file || !isAvailable()) return;
            const revision = ++request.current;
            try {
              if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
                throw new Error('Выберите изображение JPG, PNG или WebP.');
              if (file.size > 5 * 1024 * 1024) throw new Error('Выберите изображение до 5 МБ.');
              const bytes = new Uint8Array(await file.arrayBuffer());
              if (request.current !== revision || !isAvailable()) return;
              let binary = '';
              for (let start = 0; start < bytes.length; start += 8192)
                binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
              setFailure(null);
              latest.current.onError?.(null);
              latest.current.onChange({
                base64: btoa(binary),
                mimeType: file.type,
                fileName: file.name,
              });
            } catch (cause) {
              if (request.current === revision && !latest.current.disabled) {
                const message =
                  cause instanceof Error ? cause.message : 'Не удалось прочитать изображение.';
                setFailure(message);
                latest.current.onError?.(message);
              }
            } finally {
              if (request.current === revision) input.value = '';
            }
          }}
        />
      </label>
      <button
        type="button"
        disabled={disabled || state.kind === 'loading'}
        onClick={() => {
          request.current++;
          setFailure(null);
          onError?.(null);
          onClear();
        }}
      >
        Удалить изображение
      </button>
      {onRevert ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            request.current++;
            setFailure(null);
            onError?.(null);
            onRevert?.();
          }}
        >
          Отменить изменение изображения
        </button>
      ) : null}
    </FieldFrame>
  );
}
export function FieldList<T>({
  state,
  onChange,
  label,
  disabled,
  error,
  children,
}: FieldProps<T[]> & { children?: (items: T[], replace: (items: T[]) => void) => ReactNode }) {
  const [authored, setAuthored] = useState(false);
  return (
    <FieldFrame label={label} error={error}>
      {state.kind === 'mixed' && !authored ? (
        <>
          <p>Списки различаются. Замена изменит список в каждом выбранном сообществе.</p>
          <button type="button" disabled={disabled} onClick={() => setAuthored(true)}>
            Составить общий список
          </button>
        </>
      ) : (
        children?.(state.kind === 'common' ? state.value : [], onChange)
      )}
      <button
        type="button"
        disabled={disabled || state.kind === 'loading'}
        onClick={() => onChange([])}
      >
        Очистить список у выбранных
      </button>
    </FieldFrame>
  );
}
