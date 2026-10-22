import { useEffect, useState } from 'react';
import type { ChannelSettingsFieldAdapter } from '../../features/network-settings/field-model';
import { FieldToggle, FieldSelect } from '../../features/network-settings/settings-field-controls';
import {
  CHANNEL_POST_BUTTON_TEXT_MAX_LENGTH,
  CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH,
  CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH,
} from '@maxim/contracts/channel-post-signature';
function SignatureInput({
  fields,
  path,
  label,
  maxLength,
  onBlur,
  fallbackUrl,
}: {
  fields: ChannelSettingsFieldAdapter;
  path: 'text' | 'url';
  label: string;
  maxLength: number;
  onBlur?: () => void;
  fallbackUrl?: string;
}) {
  const state = fields.read(path);
  const key = state.kind === 'common' ? state.value : state.kind;
  const [buffer, setBuffer] = useState<string | null>(null);
  useEffect(() => setBuffer(null), [key]);
  return (
    <label className="field channel-post-signature__field">
      <span>{label}</span>
      <input
        type={path === 'url' ? 'url' : 'text'}
        value={buffer ?? (state.kind === 'common' ? state.value : '')}
        aria-label={label}
        placeholder={
          state.kind === 'mixed'
            ? 'Разные значения'
            : path === 'url'
              ? fallbackUrl || 'Своя ссылка канала'
              : ''
        }
        maxLength={maxLength}
        disabled={fields.readOnly || state.kind === 'loading'}
        onChange={(event) => {
          const value = event.target.value;
          setBuffer(value);
          try {
            fields.setScalar(path, value);
            fields.setError(path, null);
          } catch (cause) {
            fields.setError(path, cause instanceof Error ? cause.message : 'Проверьте значение.');
          }
        }}
        onBlur={onBlur}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
      {fields.error(path) ? <small role="alert">{fields.error(path)}</small> : null}
      {path === 'url' ? (
        <small>Пустой адрес использует собственную ссылку каждого канала.</small>
      ) : null}
    </label>
  );
}
export function ChannelPostSignatureFields({
  fields,
  onBlur,
  fallbackUrl,
}: {
  fields: ChannelSettingsFieldAdapter;
  onBlur?: () => void;
  fallbackUrl?: string;
}) {
  const presentation = fields.read('presentation');
  return (
    <>
      <FieldToggle
        label="Добавлять действие"
        state={fields.read('enabled')}
        onChange={(value) => fields.setScalar('enabled', value)}
        disabled={fields.readOnly}
      />
      <FieldSelect
        label="Отображение"
        state={presentation}
        options={[
          { value: 'signature', label: 'Ссылка в тексте' },
          { value: 'button', label: 'Кнопка' },
        ]}
        onChange={(value) => fields.setScalar('presentation', value)}
        disabled={fields.readOnly}
      />
      <div className="channel-post-signature__fields">
        <SignatureInput
          fields={fields}
          path="text"
          label={
            presentation.kind === 'common' && presentation.value === 'button'
              ? 'Текст кнопки'
              : 'Текст ссылки'
          }
          maxLength={
            presentation.kind === 'common' && presentation.value === 'button'
              ? CHANNEL_POST_BUTTON_TEXT_MAX_LENGTH
              : CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH
          }
          onBlur={onBlur}
        />
        <SignatureInput
          fields={fields}
          path="url"
          label="Адрес ссылки"
          maxLength={CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH}
          onBlur={onBlur}
          fallbackUrl={fallbackUrl}
        />
      </div>
    </>
  );
}
