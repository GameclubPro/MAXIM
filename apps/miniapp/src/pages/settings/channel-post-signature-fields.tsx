import { useEffect, useRef, type ReactNode } from 'react';
import type { ChannelSettingsFieldAdapter } from '../../features/network-settings/field-model';
import { AppIcon } from '../../components/ui/app-icon';
import { SegmentedControl } from '../../components/ui/segmented-control';
import { cn } from '../../lib/cn';
import {
  CHANNEL_POST_BUTTON_TEXT_MAX_LENGTH,
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH,
  CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH,
} from '@maxim/contracts/channel-post-signature';
import { ChannelSettingsTextField } from './channel-settings-text-field';

export function ChannelPostSignatureFields({
  fields,
  onBlur,
  fallbackUrl,
  children,
}: {
  fields: ChannelSettingsFieldAdapter;
  onBlur?: () => void;
  fallbackUrl?: string;
  children?: ReactNode;
}) {
  const enabled = fields.read('enabled');
  const presentation = fields.read('presentation');
  const text = fields.read('text');
  const url = fields.read('url');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = enabled.kind === 'mixed';
  }, [enabled.kind]);
  const isEnabled = enabled.kind === 'common' && enabled.value;
  const isButton = presentation.kind === 'common' && presentation.value === 'button';
  const label =
    text.kind === 'common'
      ? text.value.trim() || CHANNEL_POST_SIGNATURE_DEFAULT_TEXT
      : 'Разные значения';
  const previewUrl =
    url.kind === 'common'
      ? url.value.trim() || fallbackUrl || 'Собственная ссылка каждого канала'
      : 'Разные значения';
  return (
    <>
      <div className="channel-post-signature__activation">
        <span className="channel-post-signature__activation-icon" aria-hidden>
          <AppIcon icon="Link" />
        </span>
        <span className="channel-post-signature__activation-copy">
          <strong>Добавлять действие</strong>
          <small>
            {enabled.kind !== 'common' || (isEnabled && presentation.kind !== 'common')
              ? 'Разные значения'
              : isEnabled
                ? isButton
                  ? 'Кнопкой под публикацией'
                  : 'Ссылкой в конце текста'
                : 'Выключено'}
          </small>
        </span>
        <label className="settings-native-switch channel-post-signature__switch">
          <input
            ref={input}
            type="checkbox"
            checked={isEnabled}
            aria-label="Действие под публикацией"
            aria-checked={enabled.kind === 'mixed' ? 'mixed' : isEnabled}
            disabled={fields.readOnly || enabled.kind === 'loading'}
            onChange={(event) => fields.setScalar('enabled', event.target.checked)}
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>
      <div className="channel-post-signature__presentation">
        <span>Отображение{presentation.kind === 'mixed' ? ' · Разные значения' : ''}</span>
        <SegmentedControl
          value={presentation.kind === 'common' ? presentation.value : ''}
          options={[
            {
              value: 'signature',
              label: 'Ссылка в тексте',
              disabled: fields.readOnly || presentation.kind === 'loading',
            },
            {
              value: 'button',
              label: 'Кнопка',
              disabled: fields.readOnly || presentation.kind === 'loading',
            },
          ]}
          ariaLabel="Формат действия под публикацией"
          onChange={(value) => {
            if (value === 'signature' || value === 'button')
              fields.setScalar('presentation', value);
          }}
        />
      </div>
      <div className="channel-post-signature__workspace">
        <div className="channel-post-signature__fields">
          <ChannelSettingsTextField
            fields={fields}
            path="text"
            label={
              presentation.kind === 'common'
                ? isButton
                  ? 'Текст кнопки'
                  : 'Текст ссылки'
                : 'Текст ссылки / кнопки'
            }
            id="channel-post-signature-text"
            className="channel-post-signature__field"
            maxLength={
              presentation.kind === 'common'
                ? isButton
                  ? CHANNEL_POST_BUTTON_TEXT_MAX_LENGTH
                  : CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH
                : undefined
            }
            onBlur={onBlur}
          />
          <ChannelSettingsTextField
            fields={fields}
            path="url"
            label="Адрес ссылки"
            id="channel-post-signature-url"
            className="channel-post-signature__field"
            placeholder={fallbackUrl || 'https://max.ru/...'}
            maxLength={CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH}
            onBlur={onBlur}
          />
        </div>
        {children ?? (
          <div
            className={cn(
              'channel-post-signature__preview',
              enabled.kind === 'common' && !enabled.value && 'is-disabled',
            )}
          >
            <div className="channel-post-signature__preview-head">
              <span>Предпросмотр</span>
              <small>
                {enabled.kind !== 'common' || presentation.kind !== 'common'
                  ? 'Разные значения'
                  : isEnabled
                    ? isButton
                      ? 'Кнопка'
                      : 'Ссылка'
                    : 'Выключено'}
              </small>
            </div>
            <div className="channel-post-signature__message-preview">
              <span className="channel-post-signature__message-lines" aria-hidden>
                <i />
                <i />
              </span>
              {isButton ? (
                <button type="button" className="channel-post-signature__message-button" disabled>
                  {label}
                </button>
              ) : (
                <span className="channel-post-signature__message-signature">
                  <AppIcon icon="Link" />
                  <strong>{label}</strong>
                </span>
              )}
            </div>
            <small
              className={cn(
                'channel-post-signature__preview-url',
                fields.error('url') && 'is-error',
              )}
              title={previewUrl}
            >
              {fields.error('url') || previewUrl}
            </small>
          </div>
        )}
      </div>
    </>
  );
}
