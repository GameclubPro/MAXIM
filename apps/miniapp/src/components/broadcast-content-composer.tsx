import {
  type BroadcastImage,
  type BroadcastLinkButton,
  type BroadcastTextFormat,
} from '@maxim/contracts';
import { Camera as IconoirCamera, Link as IconoirLink, Xmark as IconoirXmark } from 'iconoir-react';
import { useId, useRef, useState } from 'react';
import './broadcast-content-composer.css';
import { MAX_MARKDOWN_TOOL_DEFINITIONS, type MaxMarkdownTool } from './max-markdown-editor';
import { MaxRichTextEditor, type MaxRichTextEditorHandle } from './max-rich-text-editor';
import { cn } from '../lib/cn';
import { prepareBroadcastImage } from '../lib/broadcast-image';
import {
  appendComposerBroadcastImages,
  BROADCAST_IMAGES_TOTAL_BASE64_MAX,
  getBroadcastImagesBase64Length,
  normalizeComposerBroadcastImages,
  resolveBroadcastImageMaxCount,
} from '../lib/broadcast-image-list';
import {
  buildBroadcastPreviewButtonRows,
  formatBroadcastButtonsPreview,
} from '../lib/broadcast-link-buttons';
import type { BroadcastSystemButtonPreview } from '../lib/broadcast-system-buttons';
import { openFileInputPicker, resolveFileInputActivationMode } from '../lib/file-input-picker';

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

function isBroadcastSystemButtonPreview(
  button: BroadcastLinkButton | BroadcastSystemButtonPreview,
): button is BroadcastSystemButtonPreview {
  return 'kind' in button;
}

type BroadcastContentComposerProps = {
  className?: string;
  text: string;
  sourceFormat?: BroadcastTextFormat;
  maxLength: number;
  image?: BroadcastContentComposerImage;
  images?: BroadcastImage[];
  maxImages?: number;
  allowImages?: boolean;
  buttons?: BroadcastLinkButton[];
  systemButtons?: BroadcastSystemButtonPreview[];
  buttonsStatusLabel?: string;
  buttonsActive?: boolean;
  buttonsError?: boolean;
  buttonsPerRow?: number;
  videoLabel?: string | null;
  disabled?: boolean;
  textError?: string;
  imageError?: string;
  messageAriaLabel?: string;
  textPlaceholder?: string;
  textAriaLabel?: string;
  showToolLabels?: boolean;
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
  sourceFormat = 'markdown',
  maxLength,
  image,
  images,
  maxImages,
  allowImages = true,
  buttons = [],
  systemButtons = [],
  buttonsStatusLabel = 'Без кнопки',
  buttonsActive = false,
  buttonsError = false,
  buttonsPerRow,
  videoLabel = null,
  disabled = false,
  textError = '',
  imageError = '',
  messageAriaLabel = 'Сообщение автопостинга',
  textPlaceholder = 'Текст',
  textAriaLabel = textPlaceholder,
  showToolLabels = false,
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
  const textErrorId = useId();
  const [formatToolsOpen, setFormatToolsOpen] = useState(false);
  const [normalizationReady, setNormalizationReady] = useState(true);
  const [preparingImages, setPreparingImages] = useState<PreparingImagesState>({
    done: 0,
    total: 0,
  });
  const maxImageCount = resolveBroadcastImageMaxCount(
    maxImages ?? (images || onImagesChange ? undefined : 1),
  );
  const currentImages = normalizeComposerBroadcastImages(
    images ??
      (image?.enabled && image.base64 && image.mimeType
        ? [
            {
              base64: image.base64,
              mimeType: image.mimeType,
              fileName: image.fileName,
            },
          ]
        : []),
    maxImageCount,
  );
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
  const previewButtonRows = buildBroadcastPreviewButtonRows(
    previewButtons,
    previewSystemButtons,
    buttonsPerRow,
  );
  const previewButtonCount = previewButtons.length + previewSystemButtons.length;
  const previewButtonLabel = formatBroadcastButtonsPreview([
    ...previewButtons,
    ...previewSystemButtons,
  ]);
  const openButtonsLabel =
    previewButtonCount > 0 ? `Кнопки: ${previewButtonLabel}` : buttonsStatusLabel;
  const hasPreview = Boolean(normalizedText || imagePreviewItems.length > 0 || videoLabel);
  const remainingLength = maxLength - text.length;
  const isNearTextLimit =
    remainingLength >= 0 && remainingLength <= Math.min(120, maxLength * 0.08);
  const showTextCounter = text.length > 0 && (isNearTextLimit || remainingLength < 0);
  const isPreparingImage = pendingImageSlots > 0;
  const editorDisabled = disabled || isPreparingImage;
  const isBusy = editorDisabled || !normalizationReady;
  const useNativeTapFileInput =
    resolveFileInputActivationMode(
      typeof document === 'undefined' ? undefined : document.documentElement.dataset.maxPlatform,
    ) === 'native-tap';

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

  function updatePreparingImages(nextState: PreparingImagesState) {
    setPreparingImages(nextState);
    onImagePreparationChange?.(nextState.total > nextState.done);
  }

  async function handleImageFiles(files: FileList | File[] | null) {
    if (!allowImages) {
      onError?.('Сначала уберите одно из добавленных фото.');
      return;
    }

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
      const preparedImages: BroadcastImage[] = [];
      let estimatedImages = currentImages.slice(0, maxImageCount);
      for (const [index, file] of filesToPrepare.entries()) {
        const remainingBase64Budget =
          BROADCAST_IMAGES_TOTAL_BASE64_MAX - getBroadcastImagesBase64Length(estimatedImages);
        if (remainingBase64Budget <= 0) {
          throw new Error('Суммарный размер фото слишком большой.');
        }

        const remainingFileCount = Math.max(1, filesToPrepare.length - index);
        const maxBytes = Math.floor((remainingBase64Budget * 3) / (4 * remainingFileCount));
        const prepared = await prepareBroadcastImage(file, { maxBytes });
        const preparedImage = {
          base64: prepared.base64,
          mimeType: prepared.mimeType,
          fileName: prepared.fileName,
        };
        const appendPreview = appendComposerBroadcastImages(estimatedImages, [preparedImage], {
          maxImageCount,
          totalBase64Limit: BROADCAST_IMAGES_TOTAL_BASE64_MAX,
        });
        if (appendPreview.oversizedCount > 0) {
          throw new Error('Суммарный размер фото слишком большой.');
        }
        preparedImages.push(preparedImage);
        estimatedImages = appendPreview.images;

        updatePreparingImages({ done: index + 1, total: filesToPrepare.length });
      }

      const result = appendComposerBroadcastImages(currentImages, preparedImages, {
        maxImageCount,
        totalBase64Limit: BROADCAST_IMAGES_TOTAL_BASE64_MAX,
      });
      if (result.addedCount > 0) {
        emitImages(result.images);
      }
      if (result.duplicateCount > 0 && result.addedCount === 0) {
        onError?.('Это фото уже добавлено.');
      } else if (result.duplicateCount > 0) {
        onError?.('Повторяющиеся фото пропущены.');
      }
      if (result.limitCount > 0) {
        onError?.(`Можно добавить до ${maxImageCount} фото.`);
      }
      if (result.oversizedCount > 0) {
        onError?.('Суммарный размер фото слишком большой.');
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
        hasPreview && 'has-preview',
        !hasPreview && 'is-empty',
        previewButtonRows.length > 0 && 'has-buttons',
        (textError || imageError) && 'field--error',
      )}
      aria-busy={isPreparingImage || undefined}
    >
      <div
        className={cn(
          'broadcast-content-composer__workspace',
          'broadcast-content-composer__workspace--rich',
          hasPreview && 'has-preview',
        )}
      >
        <div className="broadcast-content-composer__editor broadcast-content-composer__editor--rich">
          {showTextCounter ? (
            <div className="broadcast-content-composer__editor-head">
              <span
                className={cn(
                  'broadcast-content-composer__counter',
                  isNearTextLimit && 'is-warning',
                  remainingLength < 0 && 'is-limit',
                )}
                aria-live="polite"
              >
                {text.length}/{maxLength}
              </span>
            </div>
          ) : null}

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
                          aria-label={`Убрать фото ${item.index + 1}`}
                          title={`Убрать фото ${item.index + 1}`}
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
                  sourceFormat={sourceFormat}
                  onChange={onTextChange}
                  maxLength={maxLength}
                  placeholder={textPlaceholder}
                  disabled={editorDisabled}
                  onNormalizationReadyChange={setNormalizationReady}
                  ariaLabel={textAriaLabel}
                  ariaInvalid={Boolean(textError)}
                  ariaDescribedBy={textError ? textErrorId : undefined}
                  className="broadcast-message-card__rich-editor"
                  onPasteFiles={(files) => void handleImageFiles(files)}
                />

                {previewButtonRows.length > 0 ? (
                  <div className="broadcast-message-card__buttons">
                    {previewButtonRows.map((row, rowIndex) => (
                      <div
                        key={`preview-row-${rowIndex}`}
                        className="broadcast-message-card__button-row"
                      >
                        {row.map((button, buttonIndex) => {
                          const isSystemButton = isBroadcastSystemButtonPreview(button);

                          return (
                            <span
                              key={`${rowIndex}-${buttonIndex}-${button.text}-${
                                isSystemButton ? button.kind : button.url
                              }`}
                              className={cn(
                                'broadcast-message-card__button',
                                isSystemButton && 'is-system',
                              )}
                            >
                              {button.text.trim()}
                            </span>
                          );
                        })}
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
            <div
              className="broadcast-content-composer__media-actions"
              role="group"
              aria-label="Инструменты сообщения"
            >
              <button
                type="button"
                className={cn(
                  'broadcast-content-composer__tool',
                  'broadcast-content-composer__tool--format',
                  showToolLabels && 'has-label',
                  formatToolsOpen && 'is-active',
                )}
                onClick={() => setFormatToolsOpen((current) => !current)}
                disabled={isBusy}
                aria-expanded={formatToolsOpen}
                aria-label="Форматирование"
                title="Форматирование"
              >
                A
                {showToolLabels ? (
                  <span className="broadcast-content-composer__tool-label">Формат</span>
                ) : null}
              </button>
              {useNativeTapFileInput ? (
                <label
                  className={cn(
                    'broadcast-content-composer__tool',
                    'broadcast-content-composer__tool--native-file',
                    showToolLabels && 'has-label',
                    imagePreviewItems.length > 0 && 'is-active',
                    (!allowImages || isBusy || imagePreviewItems.length >= maxImageCount) &&
                      'is-disabled',
                  )}
                  aria-label={isPreparingImage ? 'Готовим фото' : 'Добавить фото'}
                  title={isPreparingImage ? 'Готовим фото' : 'Добавить фото'}
                  aria-disabled={
                    !allowImages || isBusy || imagePreviewItems.length >= maxImageCount
                  }
                >
                  <IconoirCamera aria-hidden focusable="false" />
                  {showToolLabels ? (
                    <span className="broadcast-content-composer__tool-label">Фото</span>
                  ) : null}
                  <input
                    ref={imageInputRef}
                    className="broadcast-content-composer__file-input broadcast-content-composer__file-input--native"
                    type="file"
                    accept="image/*"
                    multiple={maxImageCount > 1}
                    disabled={!allowImages || isBusy || imagePreviewItems.length >= maxImageCount}
                    onChange={(event) => void handleImageFiles(event.currentTarget.files)}
                    aria-label={isPreparingImage ? 'Готовим фото' : 'Добавить фото'}
                  />
                </label>
              ) : (
                <>
                  <button
                    type="button"
                    className={cn(
                      'broadcast-content-composer__tool',
                      showToolLabels && 'has-label',
                      imagePreviewItems.length > 0 && 'is-active',
                    )}
                    onClick={() => openFileInputPicker(imageInputRef.current)}
                    disabled={!allowImages || isBusy || imagePreviewItems.length >= maxImageCount}
                    aria-label={isPreparingImage ? 'Готовим фото' : 'Добавить фото'}
                    title={isPreparingImage ? 'Готовим фото' : 'Добавить фото'}
                  >
                    <IconoirCamera aria-hidden focusable="false" />
                    {showToolLabels ? (
                      <span className="broadcast-content-composer__tool-label">Фото</span>
                    ) : null}
                  </button>
                  <input
                    ref={imageInputRef}
                    className="broadcast-content-composer__file-input"
                    type="file"
                    accept="image/*"
                    multiple={maxImageCount > 1}
                    disabled={!allowImages || isBusy}
                    onChange={(event) => void handleImageFiles(event.currentTarget.files)}
                    tabIndex={-1}
                  />
                </>
              )}
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
                  aria-label={buttonsActive ? openButtonsLabel : 'Добавить кнопки'}
                  title={buttonsActive ? openButtonsLabel : 'Добавить кнопки'}
                >
                  <IconoirLink aria-hidden focusable="false" />
                </button>
              ) : null}
            </div>

            <span className="broadcast-content-composer__asset-strip">
              {isPreparingImage || imagePreviewItems.length > 0 || videoLabel ? (
                <span className="broadcast-content-composer__media-label" aria-live="polite">
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
                  title={openButtonsLabel}
                >
                  {previewButtonCount > 0 ? previewButtonLabel : buttonsStatusLabel}
                </button>
              ) : null}
            </span>
          </div>

          {formatToolsOpen ? (
            <div className="broadcast-content-composer__modifier-row" aria-label="Форматирование">
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
          ) : null}
        </div>
      </div>

      {textError ? (
        <small id={textErrorId} className="field__hint" role="alert">
          {textError}
        </small>
      ) : imageError ? (
        <small className="field__hint" role="alert">
          {imageError}
        </small>
      ) : null}
    </div>
  );
}

export default BroadcastContentComposer;
