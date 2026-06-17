import { Link as IconoirLink } from 'iconoir-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { useNativeBackHandler } from '../lib/native-back';
import './max-markdown-editor.css';

export type MaxMarkdownTool =
  | 'heading'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'link';

type SelectionRange = {
  start: number;
  end: number;
};

export type MaxMarkdownEditorHandle = {
  focus: () => void;
  applyTool: (tool: MaxMarkdownTool) => void;
  openFormattingTray: () => void;
  closeFormattingTray: () => void;
  toggleFormattingTray: () => void;
};

type MaxMarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  placeholder: string;
  rows?: number;
  disabled?: boolean;
  showToolbar?: boolean;
  compactToolbar?: boolean;
  toolbarMode?: 'inline' | 'selection-tray';
  ariaLabel: string;
  className?: string;
  onFormattingTrayOpenChange?: (open: boolean) => void;
};

const LINK_PLACEHOLDER_URL = 'https://max.ru/';

export const MAX_MARKDOWN_TOOL_DEFINITIONS: Array<{
  id: MaxMarkdownTool;
  label: string;
  title: string;
}> = [
  { id: 'heading', label: 'H', title: 'Заголовок' },
  { id: 'bold', label: 'B', title: 'Жирный' },
  { id: 'italic', label: 'I', title: 'Курсив' },
  { id: 'underline', label: 'U', title: 'Подчеркнутый' },
  { id: 'strike', label: 'S', title: 'Зачеркнутый' },
  { id: 'code', label: '</>', title: 'Код' },
  { id: 'link', label: 'Link', title: 'Ссылка' },
];

export const MaxMarkdownEditor = forwardRef<MaxMarkdownEditorHandle, MaxMarkdownEditorProps>(
  function MaxMarkdownEditor(
    {
      value,
      onChange,
      maxLength,
      placeholder,
      rows = 5,
      disabled = false,
      showToolbar = true,
      compactToolbar = false,
      toolbarMode = 'inline',
      ariaLabel,
      className,
      onFormattingTrayOpenChange,
    },
    ref,
  ) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const pendingSelectionRef = useRef<SelectionRange | null>(null);
    const savedSelectionRef = useRef<SelectionRange>({ start: value.length, end: value.length });
    const [hasSelectedText, setHasSelectedText] = useState(false);
    const [formattingTrayOpen, setFormattingTrayOpen] = useState(false);
    const shouldRenderInlineToolbar = showToolbar && toolbarMode === 'inline';
    const shouldEnableSelectionTray = showToolbar && toolbarMode === 'selection-tray';
    const isSelectionTrayVisible =
      shouldEnableSelectionTray && (formattingTrayOpen || hasSelectedText);

    useNativeBackHandler(
      () => {
        setFormattingTrayOpen(false);
        setHasSelectedText(false);
        textareaRef.current?.blur();
        return true;
      },
      { enabled: isSelectionTrayVisible, priority: 560 },
    );

    const syncSelection = useCallback((textarea: HTMLTextAreaElement | null) => {
      if (!textarea) {
        return;
      }

      const nextSelection = clampSelection(
        {
          start: textarea.selectionStart,
          end: textarea.selectionEnd,
        },
        textarea.value.length,
      );
      savedSelectionRef.current = nextSelection;
      setHasSelectedText(nextSelection.start !== nextSelection.end);
    }, []);

    useEffect(() => {
      const textarea = textareaRef.current;
      const pendingSelection = pendingSelectionRef.current;
      if (!textarea || !pendingSelection) {
        return;
      }

      textarea.focus();
      textarea.setSelectionRange(pendingSelection.start, pendingSelection.end);
      syncSelection(textarea);
      pendingSelectionRef.current = null;
    }, [syncSelection, value]);

    useEffect(() => {
      savedSelectionRef.current = clampSelection(savedSelectionRef.current, value.length);
    }, [value.length]);

    useEffect(() => {
      if (!shouldEnableSelectionTray || typeof document === 'undefined') {
        return undefined;
      }

      const handleSelectionChange = () => {
        const textarea = textareaRef.current;
        if (textarea && document.activeElement === textarea) {
          syncSelection(textarea);
        }
      };

      document.addEventListener('selectionchange', handleSelectionChange);
      return () => {
        document.removeEventListener('selectionchange', handleSelectionChange);
      };
    }, [shouldEnableSelectionTray, syncSelection]);

    useEffect(() => {
      if (disabled) {
        setFormattingTrayOpen(false);
        setHasSelectedText(false);
      }
    }, [disabled]);

    useEffect(() => {
      onFormattingTrayOpenChange?.(isSelectionTrayVisible);
    }, [isSelectionTrayVisible, onFormattingTrayOpenChange]);

    const applyTool = useCallback(
      (tool: MaxMarkdownTool) => {
        const { selectionStart, selectionEnd } = resolveSelectionForTool(
          value,
          textareaRef.current,
          savedSelectionRef.current,
        );
        const selectedText = value.slice(selectionStart, selectionEnd);

        const next = buildNextMarkdownValue(value, {
          tool,
          selectionStart,
          selectionEnd,
          selectedText,
        });

        onChange(next.value);
        pendingSelectionRef.current = next.selection;
        savedSelectionRef.current = next.selection;
        if (shouldEnableSelectionTray) {
          setFormattingTrayOpen(true);
          setHasSelectedText(next.selection.start !== next.selection.end);
        }
      },
      [onChange, shouldEnableSelectionTray, value],
    );

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          textareaRef.current?.focus();
        },
        applyTool,
        openFormattingTray: () => {
          if (!disabled && shouldEnableSelectionTray) {
            setFormattingTrayOpen(true);
            textareaRef.current?.focus();
          }
        },
        closeFormattingTray: () => {
          setFormattingTrayOpen(false);
        },
        toggleFormattingTray: () => {
          if (!disabled && shouldEnableSelectionTray) {
            setFormattingTrayOpen((open) => !open);
            textareaRef.current?.focus();
          }
        },
      }),
      [applyTool, disabled, shouldEnableSelectionTray],
    );

    return (
      <div
        className={cn(
          'max-markdown-editor',
          shouldEnableSelectionTray && 'max-markdown-editor--selection-tray',
          className,
        )}
      >
        {shouldRenderInlineToolbar ? (
          <div
            className={cn(
              'max-markdown-editor__toolbar',
              compactToolbar && 'max-markdown-editor__toolbar--compact',
            )}
            role="toolbar"
            aria-label="Форматирование MAX"
          >
            {MAX_MARKDOWN_TOOL_DEFINITIONS.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className={cn(
                  'max-markdown-editor__tool',
                  tool.id === 'italic' && 'max-markdown-editor__tool--italic',
                  tool.id === 'code' && 'max-markdown-editor__tool--code',
                )}
                title={tool.title}
                aria-label={tool.title}
                disabled={disabled}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => applyTool(tool.id)}
              >
                {tool.id === 'link' ? <IconoirLink aria-hidden focusable="false" /> : tool.label}
              </button>
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            syncSelection(event.currentTarget);
          }}
          onSelect={(event) => syncSelection(event.currentTarget)}
          onClick={(event) => syncSelection(event.currentTarget)}
          onKeyUp={(event) => syncSelection(event.currentTarget)}
          onPointerUp={(event) => syncSelection(event.currentTarget)}
          rows={rows}
          maxLength={maxLength}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={ariaLabel}
        />

        {isSelectionTrayVisible ? (
          <div
            className="max-markdown-editor__format-tray"
            role="toolbar"
            aria-label="Форматирование MAX"
          >
            <span className="max-markdown-editor__format-tray-label" aria-hidden>
              Aa
            </span>
            {MAX_MARKDOWN_TOOL_DEFINITIONS.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className={cn(
                  'max-markdown-editor__tool',
                  tool.id === 'italic' && 'max-markdown-editor__tool--italic',
                  tool.id === 'code' && 'max-markdown-editor__tool--code',
                )}
                title={tool.title}
                aria-label={tool.title}
                disabled={disabled}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => applyTool(tool.id)}
              >
                {tool.id === 'link' ? <IconoirLink aria-hidden focusable="false" /> : tool.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  },
);

MaxMarkdownEditor.displayName = 'MaxMarkdownEditor';

function clampSelection(selection: SelectionRange, sourceLength: number): SelectionRange {
  const start = Math.max(0, Math.min(selection.start, sourceLength));
  const end = Math.max(0, Math.min(selection.end, sourceLength));

  return start <= end ? { start, end } : { start: end, end: start };
}

function resolveSelectionForTool(
  source: string,
  textarea: HTMLTextAreaElement | null,
  savedSelection: SelectionRange,
): {
  selectionStart: number;
  selectionEnd: number;
} {
  const liveSelection = textarea
    ? clampSelection(
        {
          start: textarea.selectionStart,
          end: textarea.selectionEnd,
        },
        source.length,
      )
    : null;
  const saved = clampSelection(savedSelection, source.length);
  const selection = saved.start !== saved.end ? saved : (liveSelection ?? saved);

  return {
    selectionStart: selection.start,
    selectionEnd: selection.end,
  };
}

function buildNextMarkdownValue(
  source: string,
  selection: {
    tool: MaxMarkdownTool;
    selectionStart: number;
    selectionEnd: number;
    selectedText: string;
  },
): {
  value: string;
  selection: SelectionRange;
} {
  switch (selection.tool) {
    case 'heading':
      return insertHeading(
        source,
        selection.selectionStart,
        selection.selectionEnd,
        selection.selectedText,
      );
    case 'bold':
      return wrapSelection(
        source,
        selection.selectionStart,
        selection.selectionEnd,
        '**',
        '**',
        'жирный',
      );
    case 'italic':
      return wrapSelection(
        source,
        selection.selectionStart,
        selection.selectionEnd,
        '_',
        '_',
        'курсив',
      );
    case 'underline':
      return wrapSelection(
        source,
        selection.selectionStart,
        selection.selectionEnd,
        '++',
        '++',
        'подчеркнутый',
      );
    case 'strike':
      return wrapSelection(
        source,
        selection.selectionStart,
        selection.selectionEnd,
        '~~',
        '~~',
        'зачеркнутый',
      );
    case 'code':
      return selection.selectedText.includes('\n')
        ? wrapCodeBlock(source, selection.selectionStart, selection.selectionEnd)
        : wrapSelection(source, selection.selectionStart, selection.selectionEnd, '`', '`', 'код');
    case 'link':
      return insertLink(
        source,
        selection.selectionStart,
        selection.selectionEnd,
        selection.selectedText,
      );
  }
}

function insertHeading(
  source: string,
  selectionStart: number,
  selectionEnd: number,
  selectedText: string,
): {
  value: string;
  selection: SelectionRange;
} {
  const content = selectedText || 'Заголовок';
  const replacement = content
    .split('\n')
    .map((line) => (line.trim() ? line.replace(/^\s*#{1,6}[ \t]+/u, '# ') : line))
    .map((line) => (line.trim() && !/^\s*#{1,6}[ \t]+/u.test(line) ? `# ${line}` : line))
    .join('\n');
  const value = `${source.slice(0, selectionStart)}${replacement}${source.slice(selectionEnd)}`;
  const contentStart = selectionStart + (replacement.startsWith('# ') ? 2 : 0);

  return {
    value,
    selection: {
      start: contentStart,
      end: contentStart + content.length,
    },
  };
}

function wrapCodeBlock(
  source: string,
  selectionStart: number,
  selectionEnd: number,
): {
  value: string;
  selection: SelectionRange;
} {
  const selectedText = source.slice(selectionStart, selectionEnd).replace(/```/gu, "'''");
  const content = selectedText || 'код';
  const prefix = '```\n';
  const suffix = '\n```';
  const replacement = `${prefix}${content}${suffix}`;
  const value = `${source.slice(0, selectionStart)}${replacement}${source.slice(selectionEnd)}`;
  const contentStart = selectionStart + prefix.length;

  return {
    value,
    selection: {
      start: contentStart,
      end: contentStart + content.length,
    },
  };
}

function wrapSelection(
  source: string,
  selectionStart: number,
  selectionEnd: number,
  prefix: string,
  suffix: string,
  placeholder: string,
): {
  value: string;
  selection: SelectionRange;
} {
  const selectedText = source.slice(selectionStart, selectionEnd);
  const content = selectedText || placeholder;
  const replacement = `${prefix}${content}${suffix}`;
  const value = `${source.slice(0, selectionStart)}${replacement}${source.slice(selectionEnd)}`;
  const contentStart = selectionStart + prefix.length;
  const contentEnd = contentStart + content.length;

  return {
    value,
    selection: {
      start: contentStart,
      end: contentEnd,
    },
  };
}

function insertLink(
  source: string,
  selectionStart: number,
  selectionEnd: number,
  selectedText: string,
): {
  value: string;
  selection: SelectionRange;
} {
  const label = selectedText || 'текст ссылки';
  const replacement = `[${label}](${LINK_PLACEHOLDER_URL})`;
  const value = `${source.slice(0, selectionStart)}${replacement}${source.slice(selectionEnd)}`;
  const urlStart = selectionStart + label.length + 3;

  return {
    value,
    selection: {
      start: urlStart,
      end: urlStart + LINK_PLACEHOLDER_URL.length,
    },
  };
}
