import { type BroadcastImage, type BroadcastLinkButton } from '@maxim/contracts';
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

type PreparingImagesState = {
  done: number;
  total: number;
};

const BROADCAST_IMAGES_MAX = 10;
const BROADCAST_IMAGES_TOTAL_BASE64_MAX = 24_000_000;

type BroadcastContentComposerProps = {
  className?: string;
  text: string;
  maxLength: number;
  image?: BroadcastContentComposerImage;
  images?: BroadcastImage[];
  maxImages?: number;
  buttons?: BroadcastLinkButton[];
  systemButtons?: BroadcastLinkButton[];
  buttonsStatusLabel?: string;
  buttonsActive?: boolean;
  buttonsError?: boolean;
  videoLabel?: string | null;
  disabled?: boolean;
  textError?: string;
  imageError?: string;
  messageAriaLabel?: string;
  textPlaceholder?: string;
  textAriaLabel?: string;
  onTextChange: (value: string) => void;
  onImageChange?: (image: BroadcastContentComposerImage) => void;
  onImagesChange?: (images: BroadcastImage[]) => void;
  onImagePreparationChange?: (preparing: boolean) => void;
  onOpenButtons?: () => void;
  onClearVideo?: () => void;
  onError?: (message: string) => void;
};

export function BroadcastContentComposer({
  className,
  text,
  maxLength,
  image,
  images,
  maxImages,
  buttons = [],
  systemButtons = [],
  buttonsStatusLabel = 'Без кнопки',
  buttonsActive = false,
  buttonsError = false,
  videoLabel = null,
  disabled = false,
  textError = '',
  imageError = '',
  messageAriaLabel = 'Сообщение автопостинга',
  textPlaceholder = 'Текст',
  textAriaLabel = textPlaceholder,
  onTextChange,
  onImageChange,
  onImagesChange,
  onImagePreparationChange,
  onOpenButtons,
  onClearVideo,
  onError,
}: BroadcastContentComposerProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const richTextEditorRef = useRef<MaxRichTextEditorHandle | null>(null);
  const [preparingImages, setPreparingImages] = useState<PreparingImagesState>({
    done: 0,
    total: 0,
  });
  const rawMaxImageCount = Math.trunc(
    maxImages ?? (images || onImagesChange ? BROADCAST_IMAGES_MAX : 1),
  );
  const maxImageCount = Number.isFinite(rawMaxImageCount)
    ? Math.max(1, Math.min(BROADCAST_IMAGES_MAX, rawMaxImageCount))
    : BROADCAST_IMAGES_MAX;
  const currentImages =
    images ??
    (image?.enabled && image.base64 && image.mimeType
      ? [
          {
            base64: image.base64,
            mimeType: image.mimeType,
            fileName: image.fileName,
          },
        ]
      : []);
  const imagePreviewItems = currentImages
    .filter((item) => item.base64 && item.mimeType)
    .slice(0, maxImageCount)
    .map((item, index) => ({
      ...item,
      index,
      url: `data:${item.mimeType};base64,${item.base64}`,
    }));
  const pendingImageSlots = Math.max(0, preparingImages.total - preparingImages.done);
  const normalizedText = text.trim();
  const previewButtons = buttons.filter((button) => button.text.trim());
  const previewSystemButtons = systemButtons.filter((button) => button.text.trim());
  const previewButtonRows = buildBroadcastPreviewButtonRows(previewButtons, previewSystemButtons);
  const previewButtonCount = previewButtons.length + previewSystemButtons.length;
  const hasPreview = Boolean(normalizedText || imagePreviewItems.length > 0 || videoLabel);
  const remainingLength = maxLength - text.length;
  const isNearTextLimit =
    remainingLength >= 0 && remainingLength <= Math.min(120, maxLength * 0.08);
  const isPreparingImage = pendingImageSlots > 0;
  const isBusy = disabled || isPreparingImage;

  function emitImages(nextImages: BroadcastImage[]) {
    const normalizedImages = nextImages
      .filter((item) => item.base64.trim() && item.mimeType.trim())
      .slice(0, maxImageCount);
    onImagesChange?.(normalizedImages);
    const firstImage = normalizedImages[0];
    onImageChange?.({
      enabled: Boolean(firstImage),
      base64: firstImage?.base64 ?? '',
      mimeType: firstImage?.mimeType ?? '',
      fileName: firstImage?.fileName ?? '',
    });
  }

  function getImagesBase64Length(nextImages: BroadcastImage[]) {
    return nextImages.reduce((total, item) => total + item.base64.length, 0);
  }

  function updatePreparingImages(nextState: PreparingImagesState) {
    setPreparingImages(nextState);
    onImagePreparationChange?.(nextState.total > nextState.done);
  }

  async function handleImageFiles(files: FileList | null) {
    const selectedFiles = Array.from(files ?? []);
    if (selectedFiles.length === 0) {
      return;
    }

    const freeSlots = maxImageCount - imagePreviewItems.length;
    if (freeSlots <= 0) {
      onError?.(`Можно добавить до ${maxImageCount} фото.`);
      if (imageInputRef.current) {
        imageInputRef.current.value = '';
      }
      return;
    }

    const filesToPrepare = selectedFiles.slice(0, freeSlots);
    if (selectedFiles.length > freeSlots) {
      onError?.(`Можно добавить до ${maxImageCount} фото.`);
    }

    updatePreparingImages({ done: 0, total: filesToPrepare.length });
    try {
      let nextImages = currentImages.slice(0, maxImageCount);
      for (const [index, file] of filesToPrepare.entries()) {
        const remainingBase64Budget =
          BROADCAST_IMAGES_TOTAL_BASE64_MAX - getImagesBase64Length(nextImages);
        if (remainingBase64Budget <= 0) {
          throw new Error('Суммарный размер фото слишком большой.');
        }

        const remainingFileCount = Math.max(1, filesToPrepare.length - index);
        const maxBytes = Math.floor((remainingBase64Budget * 3) / (4 * remainingFileCount));
        const prepared = await prepareBroadcastImage(file, { maxBytes });
        const candidateImages = [
          ...nextImages,
          {
            base64: prepared.base64,
            mimeType: prepared.mimeType,
            fileName: prepared.fileName,
          },
        ];
        if (getImagesBase64Length(candidateImages) > BROADCAST_IMAGES_TOTAL_BASE64_MAX) {
          throw new Error('Суммарный размер фото слишком большой.');
        }

        nextImages = candidateImages;
        emitImages(nextImages);
        updatePreparingImages({ done: index + 1, total: filesToPrepare.length });
      }
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Не удалось подготовить фото.');
    } finally {
      updatePreparingImages({ done: 0, total: 0 });
      if (imageInputRef.current) {
        imageInputRef.current.value = '';
      }
    }
  }

  function removeImage(imageIndex: number) {
    emitImages(currentImages.filter((_, index) => index !== imageIndex));
  }

  function applyTextModifier(tool: MaxMarkdownTool) {
    richTextEditorRef.current?.applyTool(tool);
  }

  return (
    <div
      className={cn(
        'broadcast-content-composer',
        className,
        (textError || imageError) && 'field--error',
      )}
    >
      <div
        className={cn(
          'broadcast-content-composer__workspace',
          'broadcast-content-composer__workspace--rich',
          hasPreview && 'has-preview',
        )}
      >
        <div className="broadcast-content-composer__editor broadcast-content-composer__editor--rich">
          <div className="broadcast-content-composer__editor-head">
            <span
              className={cn(
                'broadcast-content-composer__counter',
                text.length === 0 && 'is-empty',
                isNearTextLimit && 'is-warning',
                remainingLength < 0 && 'is-limit',
              )}
              aria-live="polite"
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
            aria-label={messageAriaLabel}
          >
            <div className="broadcast-message-card__phone">
              <div className="broadcast-message-card__bubble">
                {imagePreviewItems.length > 0 || pendingImageSlots > 0 ? (
                  <div
                    className={cn(
                      'broadcast-message-card__media-grid',
                      `is-count-${Math.min(maxImageCount, imagePreviewItems.length + pendingImageSlots)}`,
                    )}
                  >
                    {imagePreviewItems.map((item) => (
                      <figure
                        key={`${item.fileName}-${item.index}`}
                        className="broadcast-message-card__media-frame"
                      >
                        <img className="broadcast-message-card__image" src={item.url} alt="" />
                        <button
                          type="button"
                          className="broadcast-message-card__media-remove"
                          onClick={() => removeImage(item.index)}
                          disabled={isBusy}
                          aria-label="Убрать фото"
                          title="Убрать фото"
                        >
                          <IconoirXmark aria-hidden focusable="false" />
                        </button>
                      </figure>
                    ))}
                    {Array.from({ length: pendingImageSlots }, (_, index) => (
                      <span
                        key={`pending-image-${index}`}
                        className="broadcast-message-card__media-frame broadcast-message-card__media-frame--loading"
                        aria-hidden
                      />
                    ))}
                  </div>
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
                  placeholder={textPlaceholder}
                  disabled={isBusy}
                  ariaLabel={textAriaLabel}
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
                className={cn(
                  'broadcast-content-composer__tool',
                  imagePreviewItems.length > 0 && 'is-active',
                )}
                onClick={() => openFileInputPicker(imageInputRef.current)}
                disabled={isBusy || imagePreviewItems.length >= maxImageCount}
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
                multiple={maxImageCount > 1}
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
              {isPreparingImage || imagePreviewItems.length > 0 || videoLabel ? (
                <span className="broadcast-content-composer__media-label">
                  {isPreparingImage
                    ? `${preparingImages.done}/${preparingImages.total}`
                    : imagePreviewItems.length > 1
                      ? `${imagePreviewItems.length} фото`
                      : imagePreviewItems.length === 1
                        ? '1 фото'
                        : videoLabel}
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
                  title={buttonsStatusLabel}
                >
                  {previewButtonCount > 0 ? `${previewButtonCount} кноп.` : buttonsStatusLabel}
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
