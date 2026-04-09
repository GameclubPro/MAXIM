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

type BroadcastLinkButtonsEditorProps = {
  api: ApiTransport;
  buttons: BroadcastLinkButton[];
  errors?: BroadcastLinkButtonFieldErrors[];
  disabled?: boolean;
  contextEntityType?: 'chat' | 'channel';
  title?: string;
  subtitle?: string;
  urlPlaceholder?: string;
  textPlaceholder?: string;
  onChange: (buttons: BroadcastLinkButton[]) => void;
};

export function BroadcastLinkButtonsEditor({
  api,
  buttons,
  errors = [],
  disabled = false,
  contextEntityType = 'chat',
  title = 'Сетка кнопок',
  subtitle = 'До 8 ссылочных кнопок. MAX покажет их рядами по 3.',
  urlPlaceholder = 'https://max.ru/channel/...',
  textPlaceholder = 'Открыть',
  onChange,
}: BroadcastLinkButtonsEditorProps) {
  const previewRows = chunkBroadcastLinkButtons(buttons);
  const canAddMore = buttons.length < MAX_BROADCAST_LINK_BUTTONS;

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

  return (
    <div className="broadcast-link-editor">
      <div className="broadcast-link-editor__head">
        <div className="broadcast-link-editor__copy">
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </div>
        <span className="broadcast-link-editor__count">
          {buttons.length}/{MAX_BROADCAST_LINK_BUTTONS}
        </span>
      </div>

      <div className="broadcast-link-editor__preview" aria-label="Предпросмотр рядов кнопок">
        <div className="broadcast-link-editor__preview-meta">
          <span>{formatBroadcastButtonsStatus(buttons)}</span>
          <small>{previewRows.length > 0 ? `${previewRows.length} ряда` : 'Пока пусто'}</small>
        </div>
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
            <div className="broadcast-link-editor__empty">
              <strong>Первая кнопка откроет ленту действий</strong>
              <small>После этого снизу появится удобное добавление ещё кнопок.</small>
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
                >
                  Убрать
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
          type="button"
          className="broadcast-link-editor__add"
          onClick={handleAdd}
          disabled={disabled}
        >
          <span className="broadcast-link-editor__add-icon">+</span>
          <span className="broadcast-link-editor__add-copy">
            <strong>
              {buttons.length === 0 ? 'Добавить первую кнопку' : 'Добавить ещё кнопку'}
            </strong>
            <small>
              {buttons.length === 0
                ? 'Запустит каскадный редактор снизу.'
                : `Осталось ${MAX_BROADCAST_LINK_BUTTONS - buttons.length}.`}
            </small>
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
