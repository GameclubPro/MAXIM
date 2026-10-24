import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';

import { useEffect, useState } from 'react';
import {
  KARAVAN_STOREFRONT_BUTTON_MAX_LENGTH,
  KARAVAN_STOREFRONT_MESSAGE_MAX_LENGTH,
  KARAVAN_STOREFRONT_TEXT_DEFAULTS,
  type KaravanStorefrontTextField,
  type KaravanStorefrontTexts,
} from '@maxim/contracts/karavan-storefront';
import type {
  ChatSettingsFieldAdapter,
  SettingsFieldState,
} from '../../features/network-settings/field-model';

const buttonFields = [
  ['karavanStorefrontOpenButtonText', 'Кнопка продавца'],
  ['karavanStorefrontCatalogButtonText', 'Кнопка каталога'],
  ['karavanStorefrontCreateButtonText', 'Кнопка создания витрины'],
] as const;
type Props =
  | {
      draft: KaravanStorefrontTexts;
      onChange: (field: KaravanStorefrontTextField, value: string) => void;
      fields?: never;
    }
  | { fields: ChatSettingsFieldAdapter; draft?: never; onChange?: never };
function StorefrontTextField({
  field,
  label,
  state,
  disabled,
  onChange,
  error,
  onError,
  multiline = false,
}: {
  field: KaravanStorefrontTextField;
  label: string;
  state: SettingsFieldState<string>;
  disabled: boolean;
  onChange: (value: string) => void;
  error?: string | null;
  onError: (error: string | null) => void;
  multiline?: boolean;
}) {
  const key = state.kind === 'common' ? state.value : state.kind;
  const [buffer, setBuffer] = useState<string | null>(null);
  useEffect(() => setBuffer(null), [key]);
  const value = buffer ?? (state.kind === 'common' ? state.value : '');
  const maxLength = multiline
    ? KARAVAN_STOREFRONT_MESSAGE_MAX_LENGTH
    : KARAVAN_STOREFRONT_BUTTON_MAX_LENGTH;
  const props = {
    id: field,
    value,
    placeholder:
      state.kind === 'mixed' ? 'Разные значения' : KARAVAN_STOREFRONT_TEXT_DEFAULTS[field],
    maxLength,
    disabled: disabled || state.kind === 'loading',
    'aria-invalid': Boolean(error),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const next = multiline
        ? event.target.value
        : event.target.value.replace(/[\r\n\u2028\u2029]+/gu, ' ');
      setBuffer(next);
      try {
        onChange(next);
        onError(null);
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : 'Проверьте значение.');
      }
    },
  };
  return (
    <label className="settings-storefront-editor__field" htmlFor={field}>
      <span className="settings-storefront-editor__label">
        <span>{label}</span>
        <span className="settings-storefront-editor__counter">
          {buffer !== null || state.kind === 'common' ? value.length : '—'}/{maxLength}
        </span>
      </span>
      {multiline ? <textarea {...props} rows={3} /> : <input {...props} type="text" />}
      {error ? (
        <small className="field__hint" role="alert">
          {error}
        </small>
      ) : null}
    </label>
  );
}
export function SettingsStorefrontTextEditor(props: Props) {
  const [variant, setVariant] = useState<'storefront' | 'directory'>('storefront');
  const [resetVersion, setResetVersion] = useState(0);
  const state = (field: KaravanStorefrontTextField): SettingsFieldState<string> =>
    props.fields ? props.fields.read(field) : { kind: 'common', value: props.draft[field] };
  const change = (field: KaravanStorefrontTextField, value: string) => {
    if (props.fields) props.fields.setScalar(field, value);
    else props.onChange(field, value);
  };
  const preview = (field: KaravanStorefrontTextField) => {
    const value = state(field);
    return value.kind === 'common'
      ? value.value.trim() || KARAVAN_STOREFRONT_TEXT_DEFAULTS[field]
      : value.kind === 'mixed'
        ? 'Разные значения'
        : 'Загрузка…';
  };
  const paths = Object.keys(KARAVAN_STOREFRONT_TEXT_DEFAULTS) as KaravanStorefrontTextField[];
  const hasCustomText = paths.some((field) => {
    const value = state(field);
    return value.kind === 'mixed' || (value.kind === 'common' && Boolean(value.value));
  });
  const previewButtons =
    variant === 'storefront'
      ? [preview('karavanStorefrontOpenButtonText')]
      : [
          preview('karavanStorefrontCatalogButtonText'),
          preview('karavanStorefrontCreateButtonText'),
        ];
  const disabled = Boolean(props.fields?.readOnly);
  const textField = (field: KaravanStorefrontTextField, label: string, multiline = false) => (
    <StorefrontTextField
      key={`${field}-${resetVersion}`}
      field={field}
      label={label}
      state={state(field)}
      disabled={disabled}
      onChange={(value) => change(field, value)}
      error={props.fields?.error(field)}
      onError={(error) => props.fields?.setError(field, error)}
      multiline={multiline}
    />
  );
  return (
    <section className="settings-storefront-editor" aria-labelledby="storefront-text-title">
      <div className="settings-storefront-editor__head">
        <h3 id="storefront-text-title">Сообщение и кнопки</h3>
        <button
          type="button"
          className="settings-storefront-editor__reset"
          aria-label="Вернуть стандартные тексты витрины"
          title="Вернуть стандартные тексты"
          disabled={
            disabled || !hasCustomText || paths.some((field) => state(field).kind === 'loading')
          }
          onClick={() => {
            if (props.fields)
              props.fields.transact(paths.map((path) => ({ op: 'set', path, value: '' })));
            else for (const field of paths) props.onChange(field, '');
            for (const field of paths) props.fields?.setError(field, null);
            setResetVersion((version) => version + 1);
          }}
        >
          <IconoirSprite variant="iconoir" icon="Undo" aria-hidden />
        </button>
      </div>
      {textField('karavanStorefrontMessageText', 'Текст сообщения', true)}
      <div className="settings-storefront-editor__buttons">
        {buttonFields.map(([field, label]) => textField(field, label))}
      </div>
      <div className="settings-storefront-editor__preview-head">
        <h4>Предпросмотр</h4>
        <div
          className="settings-storefront-editor__modes"
          role="group"
          aria-label="Вариант витрины"
        >
          {(
            [
              ['storefront', 'Есть витрина'],
              ['directory', 'Нет витрины'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={variant === value}
              onClick={() => setVariant(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div
        className="settings-storefront-editor__preview"
        aria-label="Предпросмотр сообщения витрины"
      >
        <div className="settings-storefront-editor__message">
          <span className="settings-storefront-editor__sender">Бот</span>
          <p>{preview('karavanStorefrontMessageText')}</p>
        </div>
        <div className="settings-storefront-editor__preview-buttons">
          {previewButtons.map((label, index) => (
            <div className="settings-storefront-editor__preview-button" key={index}>
              <span>{label}</span>
              <IconoirSprite variant="iconoir" icon="ArrowUpRight" aria-hidden />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
