import { cn } from '../lib/cn';
import type { ApiTransport } from '../lib/api/transport';

export type ManagedLinkButtonFieldsProps = {
  api: ApiTransport;
  contextEntityType?: 'chat' | 'channel';
  urlValue: string;
  onUrlChange: (value: string) => void;
  textValue: string;
  onTextChange: (value: string) => void;
  urlError?: string;
  textError?: string;
  disabled?: boolean;
  urlLabel?: string;
  textLabel?: string;
  urlPlaceholder?: string;
  textPlaceholder?: string;
  textMaxLength?: number;
  urlHint?: string | null;
  textHint?: string | null;
};

export function ManagedLinkButtonFields({
  api: _api,
  contextEntityType: _contextEntityType = 'chat',
  urlValue,
  onUrlChange,
  textValue,
  onTextChange,
  urlError,
  textError,
  disabled = false,
  urlLabel = 'Ссылка кнопки',
  textLabel = 'Название кнопки',
  urlPlaceholder = 'https://max.ru/...',
  textPlaceholder = 'Открыть',
  textMaxLength = 32,
  urlHint = 'Вставьте ссылку вручную.',
  textHint = 'Текст кнопки задаётся вручную.',
}: ManagedLinkButtonFieldsProps) {
  return (
    <div className="settings-button-fields">
      <label className={cn('field settings-url-field', urlError && 'field--error')}>
        <span className="field__label">{urlLabel}</span>
        <input
          type="url"
          inputMode="url"
          value={urlValue}
          onChange={(event) => onUrlChange(event.target.value)}
          placeholder={urlPlaceholder}
          disabled={disabled}
        />
        {urlError ? <small className="field__hint">{urlError}</small> : null}
        {!urlError && urlHint !== null ? <small className="field__hint">{urlHint}</small> : null}
      </label>

      <label className={cn('field settings-text-field', textError && 'field--error')}>
        <span className="field__label">{textLabel}</span>
        <input
          type="text"
          maxLength={textMaxLength}
          value={textValue}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder={textPlaceholder}
          disabled={disabled}
        />
        {textError ? <small className="field__hint">{textError}</small> : null}
        {!textError && textHint !== null ? (
          <small className="field__hint">{textHint}</small>
        ) : null}
      </label>
    </div>
  );
}

export default ManagedLinkButtonFields;
