import type { BroadcastLinkButton } from '@maxim/contracts';
import { Camera as IconoirCamera, Link as IconoirLink, Xmark as IconoirXmark } from 'iconoir-react';
import { useRef, useState } from 'react';
import { MAX_MARKDOWN_TOOL_DEFINITIONS, type MaxMarkdownTool } from './max-markdown-editor';
import { MaxRichTextEditor, type MaxRichTextEditorHandle } from './max-rich-text-editor';
import { cn } from '../lib/cn';
import { prepareBroadcastImage } from '../lib/broadcast-image';
import { buildBroadcastPreviewButtonRows } from '../lib/broadcast-link-buttons';
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

export function BroadcastContentComposer({
  text,
  maxLength,
  image,
  buttons = [],
  systemButtons = [],
  buttonsStatusLabel = 'Без кнопки',
  buttonsActive = false,
  buttonsError = false,
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
  const richTextEditorRef = useRef<MaxRichTextEditorHandle | null>(null);
  const [isPreparingImage, setIsPreparingImage] = useState(false);
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

  function applyTextModifier(tool: MaxMarkdownTool) {
    richTextEditorRef.current?.applyTool(tool);
  }

  return (
    <div className={cn('broadcast-content-composer', (textError || imageError) && 'field--error')}>
      <div className="broadcast-content-composer__workspace broadcast-content-composer__workspace--rich">
        <div className="broadcast-content-composer__editor broadcast-content-composer__editor--rich">
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

          <div className="broadcast-content-composer__modifier-row" aria-label="Модификаторы">
            {MAX_MARKDOWN_TOOL_DEFINITIONS.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className={cn(
                  'broadcast-content-composer__modifier',
                  tool.id === 'italic' && 'is-italic',
                  tool.id === 'code' && 'is-code',
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => applyTextModifier(tool.id)}
                disabled={isBusy}
                title={tool.title}
                aria-label={tool.title}
              >
                {tool.id === 'link' ? <IconoirLink aria-hidden focusable="false" /> : tool.label}
              </button>
            ))}
          </div>

          <div
            className={cn(
              'broadcast-message-card',
              'broadcast-message-card--editable',
              !hasPreview && 'is-empty',
            )}
            aria-label="Сообщение рассылки"
          >
            <div className="broadcast-message-card__phone">
              <div className="broadcast-message-card__bubble">
                {imagePreviewUrl ? (
                  <figure className="broadcast-message-card__media-frame">
                    <img className="broadcast-message-card__image" src={imagePreviewUrl} alt="" />
                    <button
                      type="button"
                      className="broadcast-message-card__media-remove"
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
                  <span className="broadcast-message-card__video-preview">
                    {videoLabel}
                    {onClearVideo ? (
                      <button
                        type="button"
                        className="broadcast-message-card__media-remove"
                        onClick={onClearVideo}
                        disabled={isBusy}
                        aria-label="Убрать видео"
                        title="Убрать видео"
                      >
                        <IconoirXmark aria-hidden focusable="false" />
                      </button>
                    ) : null}
                  </span>
                ) : null}

                <MaxRichTextEditor
                  ref={richTextEditorRef}
                  value={text}
                  onChange={onTextChange}
                  maxLength={maxLength}
                  placeholder="Текст рассылки"
                  disabled={isBusy}
                  ariaLabel="Текст рассылки"
                  className="broadcast-message-card__rich-editor"
                />

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

          <div className="broadcast-content-composer__bar">
            <div className="broadcast-content-composer__media-actions">
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
      </div>

      {textError || imageError ? (
        <small className="field__hint">{textError || imageError}</small>
      ) : null}
    </div>
  );
}

export default BroadcastContentComposer;
