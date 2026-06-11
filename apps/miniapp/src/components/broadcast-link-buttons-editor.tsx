import { useEffect, useRef } from 'react';
import { Xmark as IconoirXmark } from 'iconoir-react';
import type { BroadcastLinkButton } from '@maxim/contracts';
import { ManagedLinkButtonFields } from './managed-link-button-fields';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import {
  MAX_BROADCAST_LINK_BUTTONS,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
  createEmptyBroadcastLinkButton,
  type BroadcastLinkButtonFieldErrors,
} from '../lib/broadcast-link-buttons';
import './broadcast-link-buttons-editor.css';

export type BroadcastLinkButtonPreset = {
  label: string;
  text: string;
  url?: string;
};

type BroadcastLinkButtonsEditorProps = {
  api: ApiTransport;
  buttons: BroadcastLinkButton[];
  errors?: BroadcastLinkButtonFieldErrors[];
  disabled?: boolean;
  revealNextStepSignal?: number;
  contextEntityType?: 'chat' | 'channel';
  presets?: BroadcastLinkButtonPreset[];
  title?: string;
  subtitle?: string;
  compact?: boolean;
  className?: string;
  urlPlaceholder?: string;
  textPlaceholder?: string;
  onChange: (buttons: BroadcastLinkButton[]) => void;
};

export function BroadcastLinkButtonsEditor({
  api,
  buttons,
  errors = [],
  disabled = false,
  revealNextStepSignal = 0,
  contextEntityType = 'chat',
  presets = [],
  title = 'Кнопки сообщения',
  subtitle = 'Название и ссылка',
  compact = false,
  className,
  urlPlaceholder = 'https://max.ru/channel/...',
  textPlaceholder = 'Открыть',
  onChange,
}: BroadcastLinkButtonsEditorProps) {
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const firstTextInputRef = useRef<HTMLInputElement | null>(null);
  const previousCountRef = useRef(buttons.length);
  const didAutofocusInitialEmptyButtonRef = useRef(false);
  const canAddMore = buttons.length < MAX_BROADCAST_LINK_BUTTONS;
  const shouldSpotlightNextStep = revealNextStepSignal > 0 && buttons.length === 1 && canAddMore;
  const emptyButtonIndex = buttons.findIndex((button) => !button.url.trim());
  const compactPresets: BroadcastLinkButtonPreset[] =
    contextEntityType === 'channel'
      ? [
          { label: 'Канал', text: 'Открыть канал' },
          { label: 'Бот', text: 'Открыть бота' },
          { label: 'URL', text: 'Открыть' },
        ]
      : [
          { label: 'Бот', text: 'Открыть бота' },
          { label: 'Канал', text: 'Открыть канал' },
          { label: 'URL', text: 'Открыть' },
        ];
  const visiblePresets = compact ? [...compactPresets, ...presets] : presets;
  const canShowPresets =
    visiblePresets.length > 0 &&
    visiblePresets.some((preset) => canApplyPreset(preset, buttons, canAddMore));
  const nextButtonLabel = compact
    ? buttons.length === 0
      ? 'Добавить'
      : 'Ещё'
    : buttons.length === 0
      ? 'Добавить первую кнопку'
      : buttons.length === 1
        ? 'Добавить вторую кнопку'
        : buttons.length === 2
          ? 'Добавить третью кнопку'
          : 'Добавить ещё кнопку';
  const nextButtonHint = compact
    ? ''
    : buttons.length === 0
      ? ''
      : buttons.length === 1
        ? ''
        : `Осталось ${MAX_BROADCAST_LINK_BUTTONS - buttons.length}.`;

  useEffect(() => {
    const previousCount = previousCountRef.current;
    const shouldRevealAddButton =
      buttons.length > 0 &&
      buttons.length < MAX_BROADCAST_LINK_BUTTONS &&
      buttons.length !== previousCount;
    const shouldFocusFirstButton =
      buttons.length === 1 && previousCount === 0 && !buttons[0]?.url.trim();

    previousCountRef.current = buttons.length;

    if (shouldFocusFirstButton) {
      didAutofocusInitialEmptyButtonRef.current = true;
      const timeoutId = window.setTimeout(() => {
        firstTextInputRef.current?.focus();
        firstTextInputRef.current?.select();
      }, 80);
      return () => window.clearTimeout(timeoutId);
    }

    if (!shouldRevealAddButton || !addButtonRef.current) {
      return;
    }

    addButtonRef.current.scrollIntoView({
      block: 'nearest',
      behavior: previousCount === 0 ? 'smooth' : 'auto',
    });
    return undefined;
  }, [buttons]);

  useEffect(() => {
    if (didAutofocusInitialEmptyButtonRef.current || buttons.length !== 1) {
      return;
    }

    const button = buttons[0];
    if (!button || button.url.trim()) {
      return;
    }

    didAutofocusInitialEmptyButtonRef.current = true;
    const timeoutId = window.setTimeout(() => {
      firstTextInputRef.current?.focus();
      firstTextInputRef.current?.select();
    }, 80);

    return () => window.clearTimeout(timeoutId);
  }, [buttons]);

  useEffect(() => {
    if (!shouldSpotlightNextStep || !addButtonRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      addButtonRef.current?.scrollIntoView({
        block: 'end',
        behavior: 'smooth',
      });
    }, 140);

    return () => window.clearTimeout(timeoutId);
  }, [revealNextStepSignal, shouldSpotlightNextStep]);

  function handleChange(index: number, patch: Partial<BroadcastLinkButton>) {
    onChange(
      buttons.map((button, buttonIndex) =>
        buttonIndex === index ? { ...button, ...patch } : button,
      ),
    );
  }

  function handleRemove(index: number) {
    onChange(buttons.filter((_, buttonIndex) => buttonIndex !== index));
  }

  function handleAdd() {
    if (!canAddMore) {
      return;
    }

    onChange([...buttons, createEmptyBroadcastLinkButton()]);
  }

  function applyPreset(preset: BroadcastLinkButtonPreset) {
    const emptyButton = createEmptyBroadcastLinkButton();
    const nextButton = {
      ...emptyButton,
      text: preset.text.trim() || emptyButton.text,
      url: preset.url?.trim() ?? '',
    };
    const matchingUrlIndex = nextButton.url
      ? buttons.findIndex((button) => button.url.trim() === nextButton.url)
      : -1;

    if (matchingUrlIndex >= 0) {
      onChange(
        buttons.map((button, index) =>
          index === matchingUrlIndex ? { ...button, ...nextButton } : button,
        ),
      );
      return;
    }

    if (emptyButtonIndex >= 0) {
      onChange(
        buttons.map((button, index) =>
          index === emptyButtonIndex ? { ...button, ...nextButton } : button,
        ),
      );
      return;
    }

    if (canAddMore) {
      onChange([...buttons, nextButton]);
    }
  }

  function isPresetDisabled(preset: BroadcastLinkButtonPreset): boolean {
    return disabled || !canApplyPreset(preset, buttons, canAddMore);
  }

  return (
    <div
      className={cn(
        'broadcast-link-editor',
        compact && 'broadcast-link-editor--compact',
        className,
      )}
    >
      <div className="broadcast-link-editor__head">
        {title || subtitle ? (
          <div className="broadcast-link-editor__copy">
            {title ? <strong>{title}</strong> : null}
            {subtitle ? <small>{subtitle}</small> : null}
          </div>
        ) : null}
        <span className="broadcast-link-editor__count">
          {buttons.length}/{MAX_BROADCAST_LINK_BUTTONS}
        </span>
      </div>

      <ButtonPreview buttons={buttons} />

      {canShowPresets ? (
        <div className="broadcast-link-editor__presets" aria-label="Быстрые кнопки">
          {visiblePresets.map((preset) => (
            <button
              key={`${preset.label}-${preset.text}-${preset.url ?? ''}`}
              type="button"
              className="broadcast-link-editor__preset"
              disabled={isPresetDisabled(preset)}
              onClick={() => applyPreset(preset)}
              aria-label={preset.text}
            >
              {preset.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="broadcast-link-editor__stack">
        {buttons.map((button, index) => {
          const error = errors[index] ?? {};

          return (
            <article
              key={`broadcast-button-${index}`}
              className={cn(
                'broadcast-link-editor__card',
                (error.url || error.text) && 'field--error',
              )}
            >
              <div className="broadcast-link-editor__card-top">
                <div className="broadcast-link-editor__card-copy">
                  <span className="broadcast-link-editor__badge">
                    {buttons.length === 1 ? 'Кнопка' : `${index + 1}`}
                  </span>
                  <strong>{button.text.trim() || textPlaceholder}</strong>
                </div>
                <button
                  type="button"
                  className="broadcast-link-editor__remove"
                  onClick={() => handleRemove(index)}
                  disabled={disabled}
                  aria-label={`Убрать кнопку ${index + 1}`}
                  title="Убрать"
                >
                  <IconoirXmark aria-hidden focusable="false" />
                </button>
              </div>

              <ManagedLinkButtonFields
                api={api}
                contextEntityType={contextEntityType}
                urlValue={button.url}
                onUrlChange={(nextValue) => handleChange(index, { url: nextValue })}
                textValue={button.text}
                onTextChange={(nextValue) => handleChange(index, { text: nextValue })}
                urlError={error.url}
                textError={error.text}
                disabled={disabled}
                urlLabel="Ссылка"
                textLabel="Название"
                urlPlaceholder={urlPlaceholder}
                textPlaceholder={textPlaceholder}
                urlHint={null}
                textHint={null}
                textInputRef={index === 0 ? firstTextInputRef : undefined}
              />
            </article>
          );
        })}
      </div>

      {canAddMore ? (
        <button
          ref={addButtonRef}
          type="button"
          className={cn('broadcast-link-editor__add', shouldSpotlightNextStep && 'is-spotlighted')}
          onClick={handleAdd}
          disabled={disabled}
        >
          <span className="broadcast-link-editor__add-icon">+</span>
          <span className="broadcast-link-editor__add-copy">
            <strong>{nextButtonLabel}</strong>
            {nextButtonHint ? <small>{nextButtonHint}</small> : null}
          </span>
        </button>
      ) : (
        <div className="broadcast-link-editor__limit">Лимит {MAX_BROADCAST_LINK_BUTTONS}.</div>
      )}
    </div>
  );
}

export default BroadcastLinkButtonsEditor;

function ButtonPreview({ buttons }: { buttons: BroadcastLinkButton[] }) {
  const visibleButtons = buttons.filter((button) => button.text.trim() || button.url.trim());
  if (visibleButtons.length === 0) {
    return (
      <div className="broadcast-link-editor__empty">
        <strong>Кнопок пока нет</strong>
      </div>
    );
  }

  const rows: BroadcastLinkButton[][] = [];
  for (let index = 0; index < visibleButtons.length; index += MAX_BROADCAST_LINK_BUTTONS_PER_ROW) {
    rows.push(visibleButtons.slice(index, index + MAX_BROADCAST_LINK_BUTTONS_PER_ROW));
  }

  return (
    <div className="broadcast-link-editor__preview" aria-label="Превью кнопок">
      <div className="broadcast-link-editor__preview-board">
        {rows.map((row, rowIndex) => (
          <div className="broadcast-link-editor__preview-row" key={`preview-row-${rowIndex}`}>
            {row.map((button, buttonIndex) => (
              <span
                className={cn(
                  'broadcast-link-editor__preview-pill',
                  !button.url.trim() && 'is-empty',
                )}
                key={`preview-button-${rowIndex}-${buttonIndex}`}
              >
                {button.text.trim() || 'Открыть'}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function canApplyPreset(
  preset: BroadcastLinkButtonPreset,
  buttons: BroadcastLinkButton[],
  canAddMore: boolean,
): boolean {
  const url = preset.url?.trim() ?? '';
  if (url && buttons.some((button) => button.url.trim() === url)) {
    return true;
  }

  return canAddMore || buttons.some((button) => !button.url.trim());
}
