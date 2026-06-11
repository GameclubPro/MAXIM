import type { BroadcastLinkButton } from '@maxim/contracts';
import { Link as IconoirLink, Xmark as IconoirXmark } from 'iconoir-react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  BroadcastLinkButtonsEditor,
  type BroadcastLinkButtonPreset,
} from './broadcast-link-buttons-editor';
import type { ApiTransport } from '../lib/api/transport';
import {
  formatBroadcastButtonsPreview,
  type BroadcastLinkButtonFieldErrors,
} from '../lib/broadcast-link-buttons';
import { cn } from '../lib/cn';
import { useNativeBackHandler } from '../lib/native-back';
import './broadcast-buttons-sheet.css';

type BroadcastButtonsSheetProps = {
  open: boolean;
  api: ApiTransport;
  enabled: boolean;
  buttons: BroadcastLinkButton[];
  errors?: BroadcastLinkButtonFieldErrors[];
  disabled?: boolean;
  revealNextStepSignal?: number;
  contextEntityType?: 'chat' | 'channel';
  presets?: BroadcastLinkButtonPreset[];
  closeAriaLabel?: string;
  urlPlaceholder?: string;
  textPlaceholder?: string;
  onEnabledChange: (enabled: boolean) => void;
  onChange: (buttons: BroadcastLinkButton[]) => void;
  onClose: () => void;
};

function resolveButtonsSheetPortalTarget(): Element | null {
  if (typeof document === 'undefined') {
    return null;
  }

  return document.querySelector('.design-preview__device-screen') ?? document.body;
}

export function BroadcastButtonsSheet({
  open,
  api,
  enabled,
  buttons,
  errors = [],
  disabled = false,
  revealNextStepSignal = 0,
  contextEntityType = 'chat',
  presets = [],
  closeAriaLabel = 'Закрыть кнопки',
  urlPlaceholder = 'https://max.ru/channel/...',
  textPlaceholder = 'Открыть',
  onEnabledChange,
  onChange,
  onClose,
}: BroadcastButtonsSheetProps) {
  useNativeBackHandler(
    () => {
      onClose();
      return true;
    },
    { enabled: open, priority: 680 },
  );

  useEffect(() => {
    if (!open || typeof document === 'undefined') {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
    };
  }, [open]);

  const portalTarget = open ? resolveButtonsSheetPortalTarget() : null;
  if (!open || !portalTarget) {
    return null;
  }
  const buttonsPreview = formatBroadcastButtonsPreview(buttons);

  return createPortal(
    <div className="broadcast-buttons-sheet" aria-hidden={!open}>
      <button
        type="button"
        className="broadcast-buttons-sheet__backdrop"
        aria-label={closeAriaLabel}
        onClick={onClose}
      />

      <section
        className="broadcast-buttons-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="broadcast-buttons-sheet-title"
      >
        <div className="broadcast-buttons-sheet__grabber" aria-hidden />

        <div className="broadcast-buttons-sheet__head">
          <span className={cn('broadcast-buttons-sheet__icon', enabled && 'is-active')}>
            <IconoirLink aria-hidden focusable="false" />
          </span>

          <span className="broadcast-buttons-sheet__copy">
            <strong id="broadcast-buttons-sheet-title">Кнопки сообщения</strong>
            {enabled && buttons.length > 0 ? <small>{buttonsPreview}</small> : null}
          </span>

          <button
            type="button"
            className="broadcast-buttons-sheet__close"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <IconoirXmark aria-hidden focusable="false" />
          </button>
        </div>

        <label className="broadcast-buttons-sheet__toggle">
          <span>
            <strong>{enabled ? 'Включены' : 'Выключены'}</strong>
          </span>
          <span className="settings-native-switch" aria-label="Добавить кнопки">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => onEnabledChange(event.currentTarget.checked)}
              disabled={disabled}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </span>
        </label>

        <div className="broadcast-buttons-sheet__body">
          {enabled ? (
            <BroadcastLinkButtonsEditor
              api={api}
              contextEntityType={contextEntityType}
              buttons={buttons}
              errors={errors}
              revealNextStepSignal={revealNextStepSignal}
              compact
              className="broadcast-link-editor--sheet"
              presets={presets}
              title=""
              subtitle=""
              onChange={onChange}
              disabled={disabled}
              urlPlaceholder={urlPlaceholder}
              textPlaceholder={textPlaceholder}
            />
          ) : (
            <button
              type="button"
              className="broadcast-buttons-sheet__empty-action"
              onClick={() => onEnabledChange(true)}
              disabled={disabled}
            >
              Добавить
            </button>
          )}
        </div>
      </section>
    </div>,
    portalTarget,
  );
}

export default BroadcastButtonsSheet;
