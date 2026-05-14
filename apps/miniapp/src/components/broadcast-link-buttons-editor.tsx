import { useEffect, useRef } from 'react';
import { Xmark as IconoirXmark } from 'iconoir-react';
import type { BroadcastLinkButton } from '@maxim/contracts';
import { ManagedLinkButtonFields } from './managed-link-button-fields';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import {
  MAX_BROADCAST_LINK_BUTTONS,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
  chunkBroadcastLinkButtons,
  createEmptyBroadcastLinkButton,
  formatBroadcastButtonsStatus,
  type BroadcastLinkButtonFieldErrors,
} from '../lib/broadcast-link-buttons';

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
  title = 'Сетка кнопок',
  subtitle = 'До 8 кнопок',
  compact = false,
  urlPlaceholder = 'https://max.ru/channel/...',
  textPlaceholder = 'Открыть',
  onChange,
}: BroadcastLinkButtonsEditorProps) {
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousCountRef = useRef(buttons.length);
  const previewRows = chunkBroadcastLinkButtons(buttons);
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

    previousCountRef.current = buttons.length;

    if (!shouldRevealAddButton || !addButtonRef.current) {
      return;
    }

    addButtonRef.current.scrollIntoView({
      block: 'nearest',
      behavior: previousCount === 0 ? 'smooth' : 'auto',
    });
  }, [buttons.length]);

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
    <div className={cn('broadcast-link-editor', compact && 'broadcast-link-editor--compact')}>
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

      <div className="broadcast-link-editor__preview" aria-label="Предпросмотр рядов кнопок">
        {!compact ? (
          <div className="broadcast-link-editor__preview-meta">
            <span>{formatBroadcastButtonsStatus(buttons)}</span>
            <small>{previewRows.length > 0 ? `${previewRows.length} ряда` : 'Пока пусто'}</small>
          </div>
        ) : null}
        <div className="broadcast-link-editor__preview-board">
          {previewRows.length > 0 ? (
            previewRows.map((row, rowIndex) => (
              <div key={`row-${rowIndex}`} className="broadcast-link-editor__preview-row">
                {row.map((button, buttonIndex) => (
                  <span
                    key={`${rowIndex}-${buttonIndex}-${button.text}-${button.url}`}
                    className={cn(
                      'broadcast-link-editor__preview-pill',
                      !button.text.trim() && 'is-empty',
                    )}
                  >
                    {button.text.trim() ||
                      `Кнопка ${rowIndex * MAX_BROADCAST_LINK_BUTTONS_PER_ROW + buttonIndex + 1}`}
                  </span>
                ))}
              </div>
            ))
          ) : (
            <div className="broadcast-link-editor__empty" aria-hidden={compact}>
              <strong>{compact ? '+' : 'Первая кнопка откроет ленту действий'}</strong>
              {!compact ? (
                <small>После этого снизу появится удобное добавление ещё кнопок.</small>
              ) : null}
            </div>
          )}
        </div>
      </div>

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
                    {index === 0 ? 'Основная' : `Доп. ${index}`}
                  </span>
                  <strong>Кнопка {index + 1}</strong>
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
                textLabel="Текст"
                urlPlaceholder={urlPlaceholder}
                textPlaceholder={textPlaceholder}
                urlHint={null}
                textHint={null}
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
        <div className="broadcast-link-editor__limit">
          Лимит достигнут. Можно оставить до {MAX_BROADCAST_LINK_BUTTONS} кнопок в одном посте.
        </div>
      )}
    </div>
  );
}

export default BroadcastLinkButtonsEditor;

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
