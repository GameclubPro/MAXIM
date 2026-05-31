import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MAX_MARKDOWN_TOOL_DEFINITIONS, type MaxMarkdownTool } from './max-markdown-editor';
import { MaxRichTextEditor, type MaxRichTextEditorHandle } from './max-rich-text-editor';
import { cn } from '../lib/cn';
import { useNativeBackHandler } from '../lib/native-back';

type BotSpeechMessageEditorSheetProps = {
  title: string;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  onReset: () => void;
  onClose: () => void;
};

const BOT_MESSAGE_EDITOR_MAX_LENGTH = 1000;

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
  onChange,
  onReset,
  onClose,
}: BotSpeechMessageEditorSheetProps) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const editorRef = useRef<MaxRichTextEditorHandle | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const isDefaultTemplate = value.trim().length === 0;
  const remainingLength = BOT_MESSAGE_EDITOR_MAX_LENGTH - value.length;
  const isNearLimit =
    remainingLength >= 0 && remainingLength <= Math.min(100, BOT_MESSAGE_EDITOR_MAX_LENGTH * 0.08);

  useEffect(() => {
    const body = document.body;
    const documentElement = document.documentElement;
    const previousBodyOverflow = body.style.overflow;
    const previousDocumentOverflow = documentElement.style.overflow;
    const target =
      anchorRef.current?.closest<HTMLElement>('.design-preview__device-screen') ??
      anchorRef.current?.closest<HTMLElement>('.app-shell') ??
      body;

    setPortalTarget(target);
    body.classList.add('bot-message-editor-open');
    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';

    const focusTimeout = window.setTimeout(() => {
      editorRef.current?.focus();
    }, 80);

    return () => {
      window.clearTimeout(focusTimeout);
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
            <span className="bot-message-editor-sheet__status">
              {isDefaultTemplate ? 'Стандартный' : 'Свой текст'}
            </span>
            <h2>{title}</h2>
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

        <div className="bot-message-editor-sheet__meta">
          <span
            className={cn(
              'bot-message-editor-sheet__counter',
              isNearLimit && 'is-warning',
              remainingLength < 0 && 'is-limit',
            )}
            aria-live="polite"
          >
            {value.length}/{BOT_MESSAGE_EDITOR_MAX_LENGTH}
          </span>
        </div>

        <div className="bot-message-editor-sheet__body">
          <MaxRichTextEditor
            ref={editorRef}
            value={value}
            onChange={onChange}
            maxLength={BOT_MESSAGE_EDITOR_MAX_LENGTH}
            placeholder="Свой текст"
            preserveCurlyBracePlaceholders
            ariaLabel={title}
            className="bot-message-editor-sheet__rich-editor"
          />
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
          <button
            type="button"
            className="button button--ghost bot-message-editor-sheet__reset"
            onClick={onReset}
            disabled={isDefaultTemplate}
          >
            Сбросить
          </button>
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

  return (
    <>
      <span ref={anchorRef} className="bot-message-editor-sheet__anchor" aria-hidden />
      {portalTarget ? createPortal(sheet, portalTarget) : null}
    </>
  );
}

export default BotSpeechMessageEditorSheet;
