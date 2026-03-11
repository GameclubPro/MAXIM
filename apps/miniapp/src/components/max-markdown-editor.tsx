import { useEffect, useRef } from 'react';
import { cn } from '../lib/cn';

type MaxMarkdownTool = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link';

type SelectionRange = {
  start: number;
  end: number;
};

const LINK_PLACEHOLDER_URL = 'https://max.ru/';

const TOOL_DEFINITIONS: Array<{
  id: MaxMarkdownTool;
  label: string;
  title: string;
}> = [
  { id: 'bold', label: 'B', title: 'Жирный' },
  { id: 'italic', label: 'I', title: 'Курсив' },
  { id: 'underline', label: 'U', title: 'Подчеркнутый' },
  { id: 'strike', label: 'S', title: 'Зачеркнутый' },
  { id: 'code', label: '</>', title: 'Код' },
  { id: 'link', label: 'Link', title: 'Ссылка' },
];

export function MaxMarkdownEditor({
  value,
  onChange,
  maxLength,
  placeholder,
  rows = 5,
  disabled = false,
  showToolbar = true,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  placeholder: string;
  rows?: number;
  disabled?: boolean;
  showToolbar?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingSelectionRef = useRef<SelectionRange | null>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    const pendingSelection = pendingSelectionRef.current;
    if (!textarea || !pendingSelection) {
      return;
    }

    textarea.focus();
    textarea.setSelectionRange(pendingSelection.start, pendingSelection.end);
    pendingSelectionRef.current = null;
  }, [value]);

  const applyTool = (tool: MaxMarkdownTool) => {
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? value.length;
    const selectionEnd = textarea?.selectionEnd ?? value.length;
    const selectedText = value.slice(selectionStart, selectionEnd);

    const next = buildNextMarkdownValue(value, {
      tool,
      selectionStart,
      selectionEnd,
      selectedText,
    });

    onChange(next.value);
    pendingSelectionRef.current = next.selection;
  };

  return (
    <div className={cn('max-markdown-editor', className)}>
      {showToolbar ? (
        <div
          className="max-markdown-editor__toolbar"
          role="toolbar"
          aria-label="Форматирование MAX"
        >
          {TOOL_DEFINITIONS.map((tool) => (
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
              {tool.label}
            </button>
          ))}
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        maxLength={maxLength}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </div>
  );
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
      return wrapSelection(
        source,
        selection.selectionStart,
        selection.selectionEnd,
        '`',
        '`',
        'код',
      );
    case 'link':
      return insertLink(
        source,
        selection.selectionStart,
        selection.selectionEnd,
        selection.selectedText,
      );
  }
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
