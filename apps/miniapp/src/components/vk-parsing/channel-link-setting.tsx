import {
  VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT,
  VK_PARSING_MAX_CHANNEL_LINK_TEXT_LENGTH,
  type UpdateVkParsingSettingsRequest,
  type VkParsingSettings,
} from '@maxim/contracts';
import { Link as IconoirLink } from 'iconoir-react';
import { type FocusEvent, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

type ChannelLinkSettingProps = {
  settings: VkParsingSettings;
  disabled: boolean;
  onUpdate: (payload: UpdateVkParsingSettingsRequest) => Promise<boolean>;
};

export function ChannelLinkSetting({ settings, disabled, onUpdate }: ChannelLinkSettingProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const errorId = useId();
  const [draft, setDraft] = useState(settings.channelLinkText);
  const [dirty, setDirty] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!dirty) {
      setDraft(settings.channelLinkText);
      setInvalid(false);
    }
  }, [dirty, settings.channelLinkText]);

  async function saveDraft(): Promise<boolean> {
    const normalized = draft.trim();
    if (!normalized) {
      setInvalid(true);
      return false;
    }
    if (normalized === settings.channelLinkText) {
      setDraft(normalized);
      setDirty(false);
      setInvalid(false);
      return true;
    }

    const saved = await onUpdate({ channelLinkText: normalized });
    if (saved) {
      setDraft(normalized);
      setDirty(false);
      setInvalid(false);
    }
    return saved;
  }

  function handleInputBlur(event: FocusEvent<HTMLInputElement>) {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof HTMLElement &&
      nextTarget.closest('.vk-channel-link-setting__switch')
    ) {
      return;
    }
    if (dirty) {
      void saveDraft();
    }
  }

  async function toggleEnabled(checked: boolean) {
    const normalized = draft.trim() || VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT;
    setDraft(normalized);
    setInvalid(false);
    const saved = await onUpdate({
      appendChannelLinkEnabled: checked,
      ...(dirty || checked ? { channelLinkText: normalized } : {}),
    });
    if (saved) {
      setDirty(false);
    }
  }

  return (
    <div className={cn('vk-channel-link-setting', settings.appendChannelLinkEnabled && 'is-on')}>
      <label className="vk-channel-link-setting__toggle">
        <span className="vk-channel-link-setting__icon" aria-hidden>
          <IconoirLink />
        </span>
        <strong>Ссылка в конце</strong>
        <span className="settings-native-switch vk-channel-link-setting__switch">
          <input
            type="checkbox"
            checked={settings.appendChannelLinkEnabled}
            disabled={disabled}
            onChange={(event) => void toggleEnabled(event.target.checked)}
            aria-label="Добавлять ссылку на канал в конце поста"
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </span>
      </label>

      {settings.appendChannelLinkEnabled ? (
        <label className={cn('vk-channel-link-setting__field', invalid && 'is-invalid')}>
          <span className="vk-parsing-sr-only">Текст ссылки</span>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            maxLength={VK_PARSING_MAX_CHANNEL_LINK_TEXT_LENGTH}
            disabled={disabled}
            placeholder={VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT}
            aria-label="Текст ссылки на канал"
            aria-invalid={invalid || undefined}
            aria-errormessage={invalid ? errorId : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setDirty(true);
              setInvalid(false);
            }}
            onBlur={handleInputBlur}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void saveDraft().then((saved) => {
                  if (saved) {
                    inputRef.current?.blur();
                  }
                });
              }
              if (event.key === 'Escape') {
                setDraft(settings.channelLinkText);
                setDirty(false);
                setInvalid(false);
                inputRef.current?.blur();
              }
            }}
          />
          {invalid ? (
            <span id={errorId} className="vk-channel-link-setting__error" role="alert">
              Укажите текст ссылки
            </span>
          ) : null}
        </label>
      ) : null}
    </div>
  );
}
