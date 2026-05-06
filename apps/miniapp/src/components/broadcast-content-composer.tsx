import type { BroadcastLinkButton } from '@maxim/contracts';
import { Camera as IconoirCamera, Link as IconoirLink, Xmark as IconoirXmark } from 'iconoir-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MaxMarkdownEditor, type MaxMarkdownEditorHandle } from './max-markdown-editor';
import { MaxMarkdownPreview } from './max-markdown-preview';
import { cn } from '../lib/cn';
import { prepareBroadcastImage } from '../lib/broadcast-image';
import { buildBroadcastPreviewButtonRows } from '../lib/broadcast-link-buttons';
import {
  createBroadcastTextTemplate,
  deleteBroadcastTextTemplate,
  readBroadcastTextTemplates,
} from '../lib/broadcast-text-templates';
import { openFileInputPicker } from '../lib/file-input-picker';

type BroadcastContentComposerImage = {
  enabled: boolean;
  base64: string;
  mimeType: string;
  fileName: string;
};

type BroadcastContentComposerProps = {
  text: string;
  maxLength: number;
  image: BroadcastContentComposerImage;
  buttons?: BroadcastLinkButton[];
  systemButtons?: BroadcastLinkButton[];
  buttonsStatusLabel?: string;
  buttonsActive?: boolean;
  buttonsError?: boolean;
  templateScope?: string;
  videoLabel?: string | null;
  disabled?: boolean;
  textError?: string;
  imageError?: string;
  onTextChange: (value: string) => void;
  onImageChange: (image: BroadcastContentComposerImage) => void;
  onOpenButtons?: () => void;
  onClearVideo?: () => void;
  onError?: (message: string) => void;
};

const QUICK_TEXT_TEMPLATES = [
  {
    label: 'Анонс',
    text: 'Анонс: скоро важное обновление. Следите за сообщениями.',
  },
  {
    label: 'Напоминание',
    text: 'Напоминание: событие начнется сегодня. Не пропустите.',
  },
  {
    label: 'Итоги',
    text: 'Итоги дня: собрали главное в одном сообщении.',
  },
];

export function BroadcastContentComposer({
  text,
  maxLength,
  image,
  buttons = [],
  systemButtons = [],
  buttonsStatusLabel = 'Без кнопки',
  buttonsActive = false,
  buttonsError = false,
  templateScope,
  videoLabel = null,
  disabled = false,
  textError = '',
  imageError = '',
  onTextChange,
  onImageChange,
  onOpenButtons,
  onClearVideo,
  onError,
}: BroadcastContentComposerProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const markdownEditorRef = useRef<MaxMarkdownEditorHandle | null>(null);
  const [isPreparingImage, setIsPreparingImage] = useState(false);
  const [templateSheetOpen, setTemplateSheetOpen] = useState(false);
  const [formattingTrayOpen, setFormattingTrayOpen] = useState(false);
  const [savedTemplates, setSavedTemplates] = useState(() =>
    templateScope ? readBroadcastTextTemplates(templateScope) : [],
  );
  const imagePreviewUrl =
    image.enabled && image.base64 && image.mimeType
      ? `data:${image.mimeType};base64,${image.base64}`
      : null;
  const normalizedText = text.trim();
  const previewButtons = buttons.filter((button) => button.text.trim());
  const previewSystemButtons = systemButtons.filter((button) => button.text.trim());
  const previewButtonRows = buildBroadcastPreviewButtonRows(previewButtons, previewSystemButtons);
  const hasPreview = Boolean(normalizedText || imagePreviewUrl || videoLabel);
  const remainingLength = maxLength - text.length;
  const isBusy = disabled || isPreparingImage;
  const canUseTemplates = Boolean(templateScope);
  const canSaveTemplate = Boolean(canUseTemplates && normalizedText);
  const canOpenTemplates = savedTemplates.length > 0;

  useEffect(() => {
    setSavedTemplates(templateScope ? readBroadcastTextTemplates(templateScope) : []);
  }, [templateScope]);

  useEffect(() => {
    if (!templateSheetOpen || typeof document === 'undefined') {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [templateSheetOpen]);

  async function handleImageFiles(files: FileList | null) {
    const file = files?.[0] ?? null;
    if (!file) {
      return;
    }

    setIsPreparingImage(true);
    try {
      const prepared = await prepareBroadcastImage(file);
      onImageChange({
        enabled: true,
        base64: prepared.base64,
        mimeType: prepared.mimeType,
        fileName: prepared.fileName,
      });
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Не удалось подготовить фото.');
    } finally {
      setIsPreparingImage(false);
      if (imageInputRef.current) {
        imageInputRef.current.value = '';
      }
    }
  }

  function clearImage() {
    onImageChange({
      enabled: false,
      base64: '',
      mimeType: '',
      fileName: '',
    });
  }

  function applyTemplate(value: string) {
    const nextValue = text.trim().length > 0 ? `${text.trimEnd()}\n\n${value}` : value;
    onTextChange(nextValue.slice(0, maxLength));
    setTemplateSheetOpen(false);
  }

  function saveTemplate() {
    if (!templateScope || !normalizedText) {
      return;
    }

    setSavedTemplates(createBroadcastTextTemplate(templateScope, normalizedText).templates);
  }

  function deleteTemplate(templateId: string) {
    if (!templateScope) {
      return;
    }

    setSavedTemplates(deleteBroadcastTextTemplate(templateScope, templateId));
  }

  return (
    <div className={cn('broadcast-content-composer', (textError || imageError) && 'field--error')}>
      <div
        className={cn(
          'broadcast-content-composer__workspace',
          'has-preview',
          !hasPreview && 'is-empty-preview',
        )}
      >
        <div className="broadcast-content-composer__editor">
          <div className="broadcast-content-composer__editor-head">
            <span
              className={cn(
                'broadcast-content-composer__counter',
                remainingLength < 0 && 'is-limit',
              )}
            >
              {text.length}/{maxLength}
            </span>
          </div>

          <div className="broadcast-content-composer__template-row" aria-label="Быстрый текст">
            {canOpenTemplates ? (
              <button
                type="button"
                className="broadcast-content-composer__template-chip"
                onClick={() => setTemplateSheetOpen(true)}
                disabled={isBusy}
              >
                Шаблоны
              </button>
            ) : null}
            {canUseTemplates ? (
              <button
                type="button"
                className="broadcast-content-composer__template-chip is-save"
                onClick={saveTemplate}
                disabled={isBusy || !canSaveTemplate}
              >
                Сохранить
              </button>
            ) : null}
            {QUICK_TEXT_TEMPLATES.map((template) => (
              <button
                key={template.label}
                type="button"
                className="broadcast-content-composer__template-chip is-snippet"
                onClick={() => applyTemplate(template.text)}
                disabled={isBusy}
              >
                {template.label}
              </button>
            ))}
          </div>

          <MaxMarkdownEditor
            ref={markdownEditorRef}
            value={text}
            onChange={onTextChange}
            maxLength={maxLength}
            placeholder="Текст рассылки"
            rows={3}
            disabled={isBusy}
            toolbarMode="selection-tray"
            ariaLabel="Текст рассылки"
            className="broadcast-content-composer__markdown"
            onFormattingTrayOpenChange={setFormattingTrayOpen}
          />

          <div className="broadcast-content-composer__bar">
            <div className="broadcast-content-composer__media-actions">
              <button
                type="button"
                className={cn(
                  'broadcast-content-composer__tool',
                  'broadcast-content-composer__tool--format',
                  formattingTrayOpen && 'is-active',
                )}
                onClick={() => markdownEditorRef.current?.toggleFormattingTray()}
                disabled={isBusy}
                aria-label="Форматирование"
                title="Форматирование"
              >
                Aa
              </button>
              <button
                type="button"
                className={cn('broadcast-content-composer__tool', imagePreviewUrl && 'is-active')}
                onClick={() => openFileInputPicker(imageInputRef.current)}
                disabled={isBusy}
                aria-label={isPreparingImage ? 'Готовим фото' : 'Добавить фото'}
                title={isPreparingImage ? 'Готовим фото' : 'Добавить фото'}
              >
                <IconoirCamera aria-hidden focusable="false" />
              </button>
              <input
                ref={imageInputRef}
                className="broadcast-content-composer__file-input"
                type="file"
                accept="image/*"
                disabled={isBusy}
                onChange={(event) => void handleImageFiles(event.currentTarget.files)}
                tabIndex={-1}
              />
              {onOpenButtons ? (
                <button
                  type="button"
                  className={cn(
                    'broadcast-content-composer__tool',
                    buttonsActive && 'is-active',
                    buttonsError && 'is-danger',
                  )}
                  onClick={onOpenButtons}
                  disabled={isBusy}
                  aria-label={buttonsActive ? buttonsStatusLabel : 'Добавить кнопки'}
                  title={buttonsActive ? buttonsStatusLabel : 'Добавить кнопки'}
                >
                  <IconoirLink aria-hidden focusable="false" />
                </button>
              ) : null}
            </div>

            <span className="broadcast-content-composer__asset-strip">
              {imagePreviewUrl || videoLabel ? (
                <span className="broadcast-content-composer__media-label">
                  {imagePreviewUrl ? image.fileName || 'Фото' : videoLabel}
                </span>
              ) : null}
              {onOpenButtons && buttonsActive ? (
                <button
                  type="button"
                  className={cn(
                    'broadcast-content-composer__button-label',
                    buttonsError && 'is-danger',
                  )}
                  onClick={onOpenButtons}
                  disabled={isBusy}
                >
                  {buttonsStatusLabel}
                </button>
              ) : null}
            </span>
          </div>
        </div>

        <div
          className={cn('broadcast-message-card', !hasPreview && 'is-empty')}
          aria-label="Предпросмотр сообщения"
        >
          <div className="broadcast-message-card__phone" aria-hidden>
            <div className="broadcast-message-card__bubble">
              {imagePreviewUrl ? (
                <img className="broadcast-message-card__image" src={imagePreviewUrl} alt="" />
              ) : null}

              {videoLabel ? (
                <span className="broadcast-message-card__video-preview">{videoLabel}</span>
              ) : null}

              {normalizedText ? (
                <MaxMarkdownPreview
                  value={text}
                  className="broadcast-message-card__preview"
                  preserveLinks
                  fallback={null}
                />
              ) : null}

              {!hasPreview ? (
                <span className="broadcast-message-card__empty-lines">
                  <span />
                  <span />
                  <span />
                </span>
              ) : null}

              {previewButtonRows.length > 0 ? (
                <div className="broadcast-message-card__buttons">
                  {previewButtonRows.map((row, rowIndex) => (
                    <div
                      key={`preview-row-${rowIndex}`}
                      className="broadcast-message-card__button-row"
                    >
                      {row.map((button, buttonIndex) => (
                        <span
                          key={`${rowIndex}-${buttonIndex}-${button.text}-${button.url}`}
                          className={cn(
                            'broadcast-message-card__button',
                            previewSystemButtons.includes(button) && 'is-system',
                          )}
                        >
                          {button.text.trim()}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              ) : null}

              <span className="broadcast-message-card__tail" />
              <span className="broadcast-message-card__checks" />
            </div>
          </div>
        </div>
      </div>

      {(imagePreviewUrl || videoLabel) && (
        <div className="broadcast-content-composer__media-grid">
          {imagePreviewUrl ? (
            <figure className="broadcast-content-composer__media">
              <img src={imagePreviewUrl} alt="" />
              <button
                type="button"
                className="broadcast-content-composer__media-remove"
                onClick={clearImage}
                disabled={isBusy}
                aria-label="Убрать фото"
                title="Убрать фото"
              >
                <IconoirXmark aria-hidden focusable="false" />
              </button>
            </figure>
          ) : null}

          {videoLabel ? (
            <div className="broadcast-content-composer__video">
              <span>{videoLabel}</span>
              {onClearVideo ? (
                <button
                  type="button"
                  className="broadcast-content-composer__media-remove"
                  onClick={onClearVideo}
                  disabled={isBusy}
                  aria-label="Убрать видео"
                  title="Убрать видео"
                >
                  <IconoirXmark aria-hidden focusable="false" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {textError || imageError ? (
        <small className="field__hint">{textError || imageError}</small>
      ) : null}

      {templateSheetOpen && typeof document !== 'undefined'
        ? createPortal(
            <div className="broadcast-template-sheet" aria-hidden={!templateSheetOpen}>
              <button
                type="button"
                className="broadcast-template-sheet__backdrop"
                aria-label="Закрыть шаблоны"
                onClick={() => setTemplateSheetOpen(false)}
              />

              <section
                className="broadcast-template-sheet__panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby="broadcast-template-sheet-title"
              >
                <div className="broadcast-template-sheet__grabber" aria-hidden />
                <div className="broadcast-template-sheet__head">
                  <strong id="broadcast-template-sheet-title">Шаблоны</strong>
                  <button
                    type="button"
                    className="broadcast-template-sheet__close"
                    onClick={() => setTemplateSheetOpen(false)}
                    aria-label="Закрыть"
                  >
                    <IconoirXmark aria-hidden focusable="false" />
                  </button>
                </div>

                <div className="broadcast-template-sheet__grid">
                  {savedTemplates.map((template) => (
                    <span key={template.id} className="broadcast-template-sheet__saved">
                      <button
                        type="button"
                        className="broadcast-template-sheet__item is-saved"
                        onClick={() => applyTemplate(template.text)}
                        disabled={isBusy}
                      >
                        <strong>{template.label}</strong>
                      </button>
                      {canUseTemplates ? (
                        <button
                          type="button"
                          className="broadcast-template-sheet__delete"
                          onClick={() => deleteTemplate(template.id)}
                          disabled={isBusy}
                          aria-label={`Удалить шаблон ${template.label}`}
                          title="Удалить"
                        >
                          <IconoirXmark aria-hidden focusable="false" />
                        </button>
                      ) : null}
                    </span>
                  ))}
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export default BroadcastContentComposer;
