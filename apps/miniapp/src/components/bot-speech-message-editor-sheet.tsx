import type { BotSpeechMediaImage } from '@maxim/contracts/settings';
import { hasCustomBotSpeechText } from '@maxim/contracts/bot-speech';
import { Camera as IconoirCamera } from 'iconoir-react';
import { type ChangeEvent, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MAX_MARKDOWN_TOOL_DEFINITIONS, type MaxMarkdownTool } from './max-markdown-editor';
import { MaxRichTextEditor, type MaxRichTextEditorHandle } from './max-rich-text-editor';
import { cn } from '../lib/cn';
import { openFileInputPicker, resolveFileInputActivationMode } from '../lib/file-input-picker';
import { useNativeBackHandler } from '../lib/native-back';
import './bot-speech-message-editor-sheet.css';

type BotSpeechMessageEditorSheetProps = {
  title: string;
  ariaLabel: string;
  value: string;
  defaultValue: string;
  image?: BotSpeechMediaImage | null;
  onChange: (value: string) => void;
  onImageChange?: (image: BotSpeechMediaImage | null) => void;
  onReset: () => void;
  onClose: () => void;
};

const BOT_MESSAGE_EDITOR_MAX_LENGTH = 1000;
const BOT_MESSAGE_EDITOR_IMAGE_MAX_BYTES = 4_000_000;
const BOT_MESSAGE_PLACEHOLDER_LABELS: Readonly<Record<string, string>> = {
  user: 'Имя',
  bot_character_name: 'Имя бота',
  message_status: 'Статус',
  reason: 'Причина',
  channels: 'Каналы',
  required_invites: 'Нужно пригласить',
  required_invites_count: 'Нужно всего',
  invited_count: 'Приглашено',
  remaining_invites: 'Осталось',
  sanction: 'Действие',
  mute_duration: 'Срок ограничения',
  night_status: 'Статус чата',
  night_window: 'Расписание',
  night_timezone: 'Часовой пояс',
  opening_status: 'Статус открытия',
};

function resolveBotMessageEditorPortalTarget(): Element | null {
  if (typeof document === 'undefined') {
    return null;
  }

  return (
    document.querySelector('.design-preview__device-screen') ??
    document.querySelector('.app-shell') ??
    document.body
  );
}

function BotMessageEditorCloseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M5.4 5.4L14.6 14.6M14.6 5.4L5.4 14.6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BotMessageEditorLinkIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M8.6 6.6L9.6 5.6C10.86 4.34 12.91 4.34 14.17 5.6C15.43 6.86 15.43 8.91 14.17 10.17L12.95 11.39C11.8 12.54 9.98 12.65 8.7 11.72M11.4 13.4L10.4 14.4C9.14 15.66 7.09 15.66 5.83 14.4C4.57 13.14 4.57 11.09 5.83 9.83L7.05 8.61C8.2 7.46 10.02 7.35 11.3 8.28"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BotSpeechMessageEditorSheet({
  title,
  ariaLabel,
  value,
  defaultValue,
  image = null,
  onChange,
  onImageChange,
  onReset,
  onClose,
}: BotSpeechMessageEditorSheetProps) {
  const editorRef = useRef<MaxRichTextEditorHandle | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [imageError, setImageError] = useState('');
  const [isPreparingImage, setIsPreparingImage] = useState(false);
  const portalTarget = resolveBotMessageEditorPortalTarget();
  const isDefaultTemplate = !hasCustomBotSpeechText(value);
  const editorValue = isDefaultTemplate ? defaultValue : value;
  const hasImage = Boolean(image?.base64 && image.mimeType);
  const imagePreviewUrl = hasImage ? `data:${image?.mimeType};base64,${image?.base64}` : '';
  const canReset = !isDefaultTemplate || hasImage;
  const remainingLength = BOT_MESSAGE_EDITOR_MAX_LENGTH - editorValue.length;
  const isNearLimit =
    remainingLength >= 0 && remainingLength <= Math.min(100, BOT_MESSAGE_EDITOR_MAX_LENGTH * 0.08);
  const useNativeTapFileInput =
    resolveFileInputActivationMode(
      typeof document === 'undefined' ? undefined : document.documentElement.dataset.maxPlatform,
    ) === 'native-tap';

  useLayoutEffect(() => {
    const body = document.body;
    const documentElement = document.documentElement;
    const previousBodyOverflow = body.style.overflow;
    const previousDocumentOverflow = documentElement.style.overflow;

    body.classList.add('bot-message-editor-open');
    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';

    return () => {
      body.classList.remove('bot-message-editor-open');
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overflow = previousDocumentOverflow;
    };
  }, []);

  useNativeBackHandler(
    () => {
      onClose();
      return true;
    },
    { enabled: true, priority: 540 },
  );

  const applyTextModifier = useCallback((tool: MaxMarkdownTool) => {
    editorRef.current?.applyTool(tool);
  }, []);

  async function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file || !onImageChange) {
      return;
    }

    setIsPreparingImage(true);
    setImageError('');
    try {
      const { prepareBroadcastImage } = await import('../lib/broadcast-image');
      const prepared = await prepareBroadcastImage(file, {
        maxBytes: BOT_MESSAGE_EDITOR_IMAGE_MAX_BYTES,
      });
      onImageChange({
        base64: prepared.base64,
        mimeType: prepared.mimeType,
        fileName: prepared.fileName,
      });
    } catch (error) {
      setImageError(error instanceof Error ? error.message : 'Не удалось подготовить фото.');
    } finally {
      setIsPreparingImage(false);
      if (imageInputRef.current) {
        imageInputRef.current.value = '';
      }
    }
  }

  const sheet = (
    <div
      className="bot-message-editor-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <button
        type="button"
        className="bot-message-editor-sheet__backdrop"
        aria-label="Закрыть редактор"
        onClick={onClose}
      />
      <section
        className="bot-message-editor-sheet__panel"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="bot-message-editor-sheet__header">
          <div className="bot-message-editor-sheet__title-wrap">
            <h2>{title}</h2>
            <span
              className={cn(
                'bot-message-editor-sheet__counter',
                isNearLimit && 'is-warning',
                remainingLength < 0 && 'is-limit',
              )}
              aria-live="polite"
            >
              {editorValue.length}/{BOT_MESSAGE_EDITOR_MAX_LENGTH}
            </span>
          </div>
          <button
            type="button"
            className="bot-message-editor-sheet__close"
            aria-label="Закрыть редактор"
            onClick={onClose}
          >
            <BotMessageEditorCloseIcon />
          </button>
        </header>

        <div className="bot-message-editor-sheet__body">
          <MaxRichTextEditor
            ref={editorRef}
            value={editorValue}
            onChange={onChange}
            maxLength={BOT_MESSAGE_EDITOR_MAX_LENGTH}
            placeholder="Свой текст"
            preserveCurlyBracePlaceholders
            ariaLabel={title}
            className="bot-message-editor-sheet__rich-editor"
            curlyBracePlaceholderLabels={BOT_MESSAGE_PLACEHOLDER_LABELS}
          />

          {onImageChange ? (
            <div className="bot-message-editor-sheet__media">
              {hasImage ? (
                <div className="bot-message-editor-sheet__media-preview">
                  <img src={imagePreviewUrl} alt="" />
                  <button
                    type="button"
                    className="bot-message-editor-sheet__media-remove"
                    aria-label="Убрать фото"
                    onClick={() => {
                      setImageError('');
                      onImageChange(null);
                    }}
                    disabled={isPreparingImage}
                  >
                    <BotMessageEditorCloseIcon />
                  </button>
                </div>
              ) : null}
              {useNativeTapFileInput ? (
                <label
                  className={cn(
                    'bot-message-editor-sheet__media-button',
                    hasImage && 'is-active',
                    isPreparingImage && 'is-loading',
                    isPreparingImage && 'is-disabled',
                  )}
                  aria-disabled={isPreparingImage}
                >
                  <IconoirCamera aria-hidden focusable="false" />
                  <span>
                    {isPreparingImage
                      ? 'Готовим фото'
                      : hasImage
                        ? 'Заменить фото'
                        : 'Добавить фото'}
                  </span>
                  <input
                    ref={imageInputRef}
                    className="bot-message-editor-sheet__file-input bot-message-editor-sheet__file-input--native"
                    type="file"
                    accept="image/*"
                    onChange={handleImageChange}
                    disabled={isPreparingImage}
                    aria-label="Выбрать фото для сообщения"
                  />
                </label>
              ) : (
                <>
                  <button
                    type="button"
                    className={cn(
                      'bot-message-editor-sheet__media-button',
                      hasImage && 'is-active',
                      isPreparingImage && 'is-loading',
                    )}
                    onClick={() => {
                      setImageError('');
                      openFileInputPicker(imageInputRef.current);
                    }}
                    disabled={isPreparingImage}
                  >
                    <IconoirCamera aria-hidden focusable="false" />
                    <span>
                      {isPreparingImage
                        ? 'Готовим фото'
                        : hasImage
                          ? 'Заменить фото'
                          : 'Добавить фото'}
                    </span>
                  </button>
                  <input
                    ref={imageInputRef}
                    className="bot-message-editor-sheet__file-input"
                    type="file"
                    accept="image/*"
                    onChange={handleImageChange}
                    disabled={isPreparingImage}
                    aria-label="Выбрать фото для сообщения"
                  />
                </>
              )}
              {imageError ? (
                <small className="bot-message-editor-sheet__media-error">{imageError}</small>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="bot-message-editor-sheet__tools" role="toolbar" aria-label="Форматирование">
          {MAX_MARKDOWN_TOOL_DEFINITIONS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className={cn(
                'bot-message-editor-sheet__tool',
                tool.id === 'italic' && 'is-italic',
                tool.id === 'code' && 'is-code',
              )}
              title={tool.title}
              aria-label={tool.title}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => applyTextModifier(tool.id)}
            >
              {tool.id === 'link' ? <BotMessageEditorLinkIcon /> : tool.label}
            </button>
          ))}
        </div>

        <footer className="bot-message-editor-sheet__actions">
          {canReset ? (
            <button
              type="button"
              className="button button--ghost bot-message-editor-sheet__reset"
              onClick={() => {
                setImageError('');
                if (hasImage) {
                  onImageChange?.(null);
                }
                onReset();
              }}
            >
              Сбросить
            </button>
          ) : null}
          <button
            type="button"
            className="button button--accent bot-message-editor-sheet__done"
            onClick={onClose}
          >
            Готово
          </button>
        </footer>
      </section>
    </div>
  );

  return portalTarget ? createPortal(sheet, portalTarget) : sheet;
}

export default BotSpeechMessageEditorSheet;
