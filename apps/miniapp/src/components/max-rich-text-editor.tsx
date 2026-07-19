import { Link as IconoirLink, Xmark as IconoirXmark } from 'iconoir-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { MAX_MARKDOWN_TOOL_DEFINITIONS, type MaxMarkdownTool } from './max-markdown-editor';
import { cn } from '../lib/cn';
import { renderPlainTextAsEditorHtml, renderSupportedMarkdownAsHtml } from '../lib/max-markdown';
import { parseEditorLinkHref, serializeEditorLinkMarkdown } from '../lib/max-rich-text-link';
import { useNativeBackHandler } from '../lib/native-back';
import './max-rich-text-editor.css';

export type MaxRichTextEditorHandle = {
  focus: () => void;
  applyTool: (tool: MaxMarkdownTool) => void;
};

type MaxRichTextEditorProps = {
  value: string;
  sourceFormat?: 'plain' | 'markdown';
  onChange: (value: string) => void;
  maxLength: number;
  placeholder: string;
  disabled?: boolean;
  preserveCurlyBracePlaceholders?: boolean;
  curlyBracePlaceholderLabels?: Readonly<Record<string, string>>;
  ariaLabel: string;
  className?: string;
  onPasteFiles?: (files: File[]) => void;
};

const LINK_PLACEHOLDER_URL = 'https://max.ru/';
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'blockquote',
  'div',
  'footer',
  'header',
  'li',
  'p',
]);

export const MaxRichTextEditor = forwardRef<MaxRichTextEditorHandle, MaxRichTextEditorProps>(
  function MaxRichTextEditor(
    {
      value,
      sourceFormat = 'markdown',
      onChange,
      maxLength,
      placeholder,
      disabled = false,
      preserveCurlyBracePlaceholders = false,
      curlyBracePlaceholderLabels,
      ariaLabel,
      className,
      onPasteFiles,
    },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement | null>(null);
    const savedRangeRef = useRef<Range | null>(null);
    const editingLinkRef = useRef<HTMLAnchorElement | null>(null);
    const lastEmittedMarkdownRef = useRef(value);
    const lastRenderedSourceFormatRef = useRef(sourceFormat);
    const [linkEditorOpen, setLinkEditorOpen] = useState(false);
    const [linkDraft, setLinkDraft] = useState(LINK_PLACEHOLDER_URL);
    const [linkError, setLinkError] = useState('');
    const [activeTools, setActiveTools] = useState<ReadonlySet<MaxMarkdownTool>>(() => new Set());

    const remainingLength = maxLength - value.length;
    const isOverLimit = remainingLength < 0;
    const editorHtml = useMemo(
      () =>
        sourceFormat === 'plain'
          ? renderPlainTextAsEditorHtml(value)
          : renderSupportedMarkdownAsHtml(value, {
              blockMode: 'inline',
              linkMode: 'anchor',
              preserveCurlyBracePlaceholders,
              curlyBracePlaceholderLabels,
            }),
      [curlyBracePlaceholderLabels, preserveCurlyBracePlaceholders, sourceFormat, value],
    );

    const emitCurrentMarkdown = useCallback(() => {
      const editor = editorRef.current;
      if (!editor) {
        return;
      }

      const nextMarkdown = serializeEditorMarkdown(editor, {
        preserveCurlyBracePlaceholders,
      });
      lastEmittedMarkdownRef.current = nextMarkdown;
      lastRenderedSourceFormatRef.current = 'markdown';
      onChange(nextMarkdown);
    }, [onChange, preserveCurlyBracePlaceholders]);

    const syncActiveTools = useCallback(() => {
      const editor = editorRef.current;
      if (!editor || typeof document === 'undefined') {
        setActiveTools(new Set());
        return;
      }

      const range = readCurrentEditorRange(editor);
      if (!range) {
        setActiveTools(new Set());
        return;
      }

      savedRangeRef.current = range.cloneRange();
      setActiveTools(resolveActiveTools(editor, range));
    }, []);

    useEffect(() => {
      const editor = editorRef.current;
      if (!editor) {
        return;
      }

      if (
        lastEmittedMarkdownRef.current === value &&
        lastRenderedSourceFormatRef.current === sourceFormat &&
        editor.innerHTML
      ) {
        return;
      }

      editor.innerHTML = editorHtml;
      lastEmittedMarkdownRef.current = value;
      lastRenderedSourceFormatRef.current = sourceFormat;
      syncActiveTools();
    }, [editorHtml, sourceFormat, syncActiveTools, value]);

    useEffect(() => {
      if (disabled) {
        editingLinkRef.current = null;
        setLinkEditorOpen(false);
        setActiveTools(new Set());
      }
    }, [disabled]);

    useEffect(() => {
      if (typeof document === 'undefined') {
        return undefined;
      }

      document.addEventListener('selectionchange', syncActiveTools);
      return () => {
        document.removeEventListener('selectionchange', syncActiveTools);
      };
    }, [syncActiveTools]);

    const focusEditor = useCallback(() => {
      editorRef.current?.focus();
    }, []);

    useNativeBackHandler(
      () => {
        editingLinkRef.current = null;
        setLinkEditorOpen(false);
        setLinkError('');
        focusEditor();
        return true;
      },
      { enabled: linkEditorOpen, priority: 570 },
    );

    const restoreOrCreateEditorRange = useCallback(() => {
      const editor = editorRef.current;
      if (!editor || typeof document === 'undefined') {
        return null;
      }

      const liveRange = readCurrentEditorRange(editor);
      if (liveRange) {
        savedRangeRef.current = liveRange.cloneRange();
        return liveRange;
      }

      const savedRange = savedRangeRef.current;
      if (savedRange && editorContainsRange(editor, savedRange)) {
        applyDocumentRange(savedRange);
        return savedRange.cloneRange();
      }

      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      applyDocumentRange(range);
      savedRangeRef.current = range.cloneRange();
      return range;
    }, []);

    const applyInlineTool = useCallback(
      (tool: MaxMarkdownTool) => {
        if (disabled) {
          return;
        }

        if (tool === 'heading') {
          const range = restoreOrCreateEditorRange();
          if (!range) {
            return;
          }

          wrapRangeWithHeading(range);
          emitCurrentMarkdown();
          syncActiveTools();
          return;
        }

        if (tool === 'link') {
          const range = restoreOrCreateEditorRange();
          const editor = editorRef.current;
          if (!range || !editor) {
            return;
          }

          savedRangeRef.current = range.cloneRange();
          const existingLink = findClosestElement(range.commonAncestorContainer, editor, 'a');
          editingLinkRef.current = existingLink instanceof HTMLAnchorElement ? existingLink : null;
          setLinkDraft(existingLink?.getAttribute('href') || LINK_PLACEHOLDER_URL);
          setLinkError('');
          setLinkEditorOpen(true);
          return;
        }

        const range = restoreOrCreateEditorRange();
        if (!range) {
          return;
        }

        wrapRangeWithElement(range, resolveToolTagName(tool), resolveToolPlaceholder(tool));
        emitCurrentMarkdown();
        syncActiveTools();
      },
      [disabled, emitCurrentMarkdown, restoreOrCreateEditorRange, syncActiveTools],
    );

    const confirmLink = useCallback(() => {
      if (disabled) {
        return;
      }

      if (!linkDraft.trim()) {
        setLinkError('Укажите ссылку.');
        return;
      }

      const canonicalHref = parseEditorLinkHref(linkDraft);
      if (!canonicalHref) {
        setLinkError('Поддерживаются https:// и max://.');
        return;
      }

      const editor = editorRef.current;
      const savedRange = savedRangeRef.current;
      const editingLink = editingLinkRef.current;
      if (editor && editingLink && editor.contains(editingLink)) {
        editingLink.setAttribute('href', canonicalHref);
        editingLinkRef.current = null;
        setLinkEditorOpen(false);
        setLinkError('');
        emitCurrentMarkdown();
        syncActiveTools();
        return;
      }

      if (!editor || !savedRange || !editorContainsRange(editor, savedRange)) {
        editingLinkRef.current = null;
        setLinkEditorOpen(false);
        return;
      }

      applyDocumentRange(savedRange);
      wrapRangeWithLink(savedRange, canonicalHref);
      editingLinkRef.current = null;
      setLinkEditorOpen(false);
      setLinkError('');
      emitCurrentMarkdown();
      syncActiveTools();
    }, [disabled, emitCurrentMarkdown, linkDraft, syncActiveTools]);

    const closeLinkEditor = useCallback(() => {
      editingLinkRef.current = null;
      setLinkEditorOpen(false);
      setLinkError('');
      focusEditor();
    }, [focusEditor]);

    useImperativeHandle(
      ref,
      () => ({
        focus: focusEditor,
        applyTool: applyInlineTool,
      }),
      [applyInlineTool, focusEditor],
    );

    return (
      <div className={cn('max-rich-text-editor', className)}>
        <div
          ref={editorRef}
          className={cn('max-rich-text-editor__surface', isOverLimit && 'is-limit')}
          contentEditable={!disabled}
          data-placeholder={placeholder}
          role="textbox"
          aria-label={ariaLabel}
          aria-multiline="true"
          aria-disabled={disabled || undefined}
          spellCheck
          suppressContentEditableWarning
          onBeforeInput={() => {
            savedRangeRef.current = restoreOrCreateEditorRange();
          }}
          onInput={() => {
            emitCurrentMarkdown();
            syncActiveTools();
          }}
          onKeyUp={syncActiveTools}
          onMouseUp={syncActiveTools}
          onPointerUp={syncActiveTools}
          onFocus={syncActiveTools}
          onPaste={(event) => {
            if (disabled) {
              return;
            }

            event.preventDefault();
            const pastedFiles = Array.from(event.clipboardData.files).filter((file) =>
              file.type.toLowerCase().startsWith('image/'),
            );
            const pastedHtml = event.clipboardData.getData('text/html');
            const pastedText = event.clipboardData.getData('text/plain');
            if (pastedFiles.length > 0 && onPasteFiles) {
              onPasteFiles(pastedFiles);
              if (pastedText) {
                insertPlainTextAtCurrentRange(pastedText);
                emitCurrentMarkdown();
                syncActiveTools();
              }
              return;
            }

            if (!pastedHtml) {
              insertPlainTextAtCurrentRange(pastedText);
              emitCurrentMarkdown();
              syncActiveTools();
              return;
            }

            const pasteRange = restoreOrCreateEditorRange()?.cloneRange() ?? null;
            void import('../lib/max-rich-text-clipboard')
              .then(({ clipboardHtmlToSupportedMarkdown }) => {
                restorePasteRange(editorRef.current, pasteRange);
                const pastedMarkdown = clipboardHtmlToSupportedMarkdown(pastedHtml);
                if (
                  pastedMarkdown &&
                  insertSupportedMarkdownAtCurrentRange(pastedMarkdown, {
                    preserveCurlyBracePlaceholders,
                    curlyBracePlaceholderLabels,
                  })
                ) {
                  emitCurrentMarkdown();
                  syncActiveTools();
                  return;
                }

                insertPlainTextAtCurrentRange(pastedText);
                emitCurrentMarkdown();
                syncActiveTools();
              })
              .catch(() => {
                restorePasteRange(editorRef.current, pasteRange);
                insertPlainTextAtCurrentRange(pastedText);
                emitCurrentMarkdown();
                syncActiveTools();
              });
          }}
        />

        {linkEditorOpen ? (
          <div className="max-rich-text-editor__link-panel">
            <IconoirLink aria-hidden focusable="false" />
            <input
              value={linkDraft}
              onChange={(event) => {
                setLinkDraft(event.target.value);
                if (linkError) {
                  setLinkError('');
                }
              }}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="https://"
              aria-label="Адрес ссылки"
              disabled={disabled}
            />
            <button type="button" onClick={confirmLink} disabled={disabled} aria-label="Применить">
              OK
            </button>
            <button
              type="button"
              onClick={closeLinkEditor}
              disabled={disabled}
              aria-label="Закрыть"
            >
              <IconoirXmark aria-hidden focusable="false" />
            </button>
            {linkError ? <small>{linkError}</small> : null}
          </div>
        ) : null}

        <span className={cn('max-rich-text-editor__counter', isOverLimit && 'is-limit')}>
          {value.length}/{maxLength}
        </span>

        <span className="max-rich-text-editor__active-tools" aria-hidden>
          {MAX_MARKDOWN_TOOL_DEFINITIONS.map((tool) => (
            <span
              key={tool.id}
              className={cn(activeTools.has(tool.id) && 'is-active')}
              data-tool={tool.id}
            />
          ))}
        </span>
      </div>
    );
  },
);

MaxRichTextEditor.displayName = 'MaxRichTextEditor';

function resolveToolTagName(
  tool: Exclude<MaxMarkdownTool, 'heading' | 'link'>,
): keyof HTMLElementTagNameMap {
  switch (tool) {
    case 'bold':
      return 'strong';
    case 'italic':
      return 'em';
    case 'underline':
      return 'u';
    case 'strike':
      return 's';
    case 'code':
      return 'code';
  }
}

function resolveToolPlaceholder(tool: Exclude<MaxMarkdownTool, 'heading' | 'link'>): string {
  switch (tool) {
    case 'bold':
      return 'жирный';
    case 'italic':
      return 'курсив';
    case 'underline':
      return 'подчеркнутый';
    case 'strike':
      return 'зачеркнутый';
    case 'code':
      return 'код';
  }
}

function readCurrentEditorRange(editor: HTMLElement): Range | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!editorContainsRange(editor, range)) {
    return null;
  }

  return range.cloneRange();
}

function editorContainsRange(editor: HTMLElement, range: Range): boolean {
  return (
    editor.contains(resolveRangeNode(range.startContainer)) &&
    editor.contains(resolveRangeNode(range.endContainer))
  );
}

function resolveRangeNode(node: Node): Node {
  return node.nodeType === Node.ELEMENT_NODE ? node : (node.parentNode ?? node);
}

function applyDocumentRange(range: Range): void {
  const selection = document.getSelection();
  if (!selection) {
    return;
  }

  selection.removeAllRanges();
  selection.addRange(range);
}

function wrapRangeWithElement(
  range: Range,
  tagName: keyof HTMLElementTagNameMap,
  placeholder: string,
): void {
  const element = document.createElement(tagName);

  if (range.collapsed) {
    element.textContent = placeholder;
    range.insertNode(element);
    selectElementContents(element);
    return;
  }

  const fragment = range.extractContents();
  element.appendChild(fragment);
  range.insertNode(element);
  selectElementContents(element);
}

function wrapRangeWithLink(range: Range, href: string): void {
  const link = document.createElement('a');
  link.setAttribute('href', href);

  if (range.collapsed) {
    link.textContent = 'текст ссылки';
    range.insertNode(link);
    selectElementContents(link);
    return;
  }

  const fragment = range.extractContents();
  link.appendChild(fragment);
  range.insertNode(link);
  selectElementContents(link);
}

function wrapRangeWithHeading(range: Range): void {
  const heading = document.createElement('h3');

  if (range.collapsed) {
    heading.textContent = 'Заголовок';
    range.insertNode(heading);
    selectElementContents(heading);
    return;
  }

  const fragment = range.extractContents();
  heading.appendChild(fragment);
  range.insertNode(heading);
  selectElementContents(heading);
}

function selectElementContents(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  applyDocumentRange(range);
}

function insertPlainTextAtCurrentRange(text: string): void {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  applyDocumentRange(range);
}

type RichTextSerializationOptions = {
  preserveCurlyBracePlaceholders?: boolean;
  curlyBracePlaceholderLabels?: Readonly<Record<string, string>>;
};

function insertSupportedMarkdownAtCurrentRange(
  markdown: string,
  options: RichTextSerializationOptions = {},
): boolean {
  if (typeof document === 'undefined') {
    return false;
  }

  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  const html = renderSupportedMarkdownAsHtml(markdown, {
    blockMode: 'inline',
    linkMode: 'anchor',
    preserveCurlyBracePlaceholders: options.preserveCurlyBracePlaceholders,
    curlyBracePlaceholderLabels: options.curlyBracePlaceholderLabels,
  });
  if (!html) {
    return false;
  }

  const template = document.createElement('template');
  template.innerHTML = html;
  const fragment = template.content;
  const lastNode = fragment.lastChild;
  if (!lastNode) {
    return false;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(fragment);
  range.setStartAfter(lastNode);
  range.collapse(true);
  applyDocumentRange(range);
  return true;
}

function restorePasteRange(editor: HTMLElement | null, range: Range | null): void {
  if (!editor || !range || !editorContainsRange(editor, range)) {
    return;
  }

  applyDocumentRange(range);
}

function resolveActiveTools(editor: HTMLElement, range: Range): ReadonlySet<MaxMarkdownTool> {
  const active = new Set<MaxMarkdownTool>();
  const container = resolveRangeNode(range.commonAncestorContainer);

  if (
    findClosestElement(container, editor, 'strong') ||
    findClosestElement(container, editor, 'b')
  ) {
    active.add('bold');
  }

  if (findClosestElement(container, editor, 'em') || findClosestElement(container, editor, 'i')) {
    active.add('italic');
  }

  if (findClosestElement(container, editor, 'u')) {
    active.add('underline');
  }

  if (
    findClosestElement(container, editor, 's') ||
    findClosestElement(container, editor, 'strike') ||
    findClosestElement(container, editor, 'del')
  ) {
    active.add('strike');
  }

  if (findClosestElement(container, editor, 'code')) {
    active.add('code');
  }

  if (findClosestElement(container, editor, 'a')) {
    active.add('link');
  }

  if (
    findClosestElement(container, editor, '[data-max-block="heading"]') ||
    findClosestElement(container, editor, 'h1,h2,h3,h4,h5,h6')
  ) {
    active.add('heading');
  }

  return active;
}

function findClosestElement(node: Node, root: HTMLElement, selector: string): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const closest = element?.closest(selector);
  return closest && root.contains(closest) ? (closest as HTMLElement) : null;
}

function serializeEditorMarkdown(
  root: HTMLElement,
  options: RichTextSerializationOptions = {},
): string {
  return serializeChildNodes(root.childNodes, options)
    .replace(/\n{3,}/gu, '\n\n')
    .trimEnd();
}

function serializeChildNodes(
  nodes: NodeListOf<ChildNode> | ChildNode[],
  options: RichTextSerializationOptions = {},
): string {
  return Array.from(nodes)
    .map((node) => serializeNode(node, options))
    .join('');
}

function serializeNode(node: Node, options: RichTextSerializationOptions = {}): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeMarkdownText((node.textContent ?? '').replace(/\u00a0/g, ' '), options);
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const element = node as HTMLElement;
  const tagName = element.tagName.toLowerCase();

  if (options.preserveCurlyBracePlaceholders && element.dataset.maxPlaceholder) {
    const placeholderKey = element.dataset.maxPlaceholder;
    return /^[A-Za-z0-9_]+$/u.test(placeholderKey) ? `{${placeholderKey}}` : '';
  }

  if (tagName === 'br') {
    return '\n';
  }

  if (tagName === 'code') {
    return `\`${serializeCodeText(element.textContent ?? '')}\``;
  }

  if (tagName === 'pre') {
    return appendBlockBreak(`\`\`\`\n${serializeCodeBlockText(element.textContent ?? '')}\n\`\`\``);
  }

  const content = serializeChildNodes(element.childNodes, options);

  if (isHeadingElement(element, tagName)) {
    const headingContent = content.replace(/\n+/gu, ' ').trim();
    return headingContent ? appendBlockBreak(`# ${headingContent}`) : '';
  }

  switch (tagName) {
    case 'strong':
    case 'b':
      return content ? `**${content}**` : '';
    case 'em':
    case 'i':
      return content ? `_${content}_` : '';
    case 'u':
      return content ? `++${content}++` : '';
    case 's':
    case 'strike':
    case 'del':
      return content ? `~~${content}~~` : '';
    case 'a':
      return serializeEditorLinkMarkdown(content, element.getAttribute('href') || '');
    default:
      return BLOCK_TAGS.has(tagName) ? appendBlockBreak(content) : content;
  }
}

function appendBlockBreak(content: string): string {
  if (!content) {
    return '\n';
  }

  return content.endsWith('\n') ? content : `${content}\n`;
}

function escapeMarkdownText(value: string, options: RichTextSerializationOptions = {}): string {
  if (options.preserveCurlyBracePlaceholders) {
    const parts: string[] = [];
    const placeholderPattern = /\{[A-Za-z0-9_]+\}/gu;
    let cursor = 0;

    for (const match of value.matchAll(placeholderPattern)) {
      parts.push(escapePlainMarkdownText(value.slice(cursor, match.index)));
      parts.push(match[0]);
      cursor = match.index + match[0].length;
    }

    parts.push(escapePlainMarkdownText(value.slice(cursor)));
    return parts.join('');
  }

  return escapePlainMarkdownText(value);
}

function escapePlainMarkdownText(value: string): string {
  return value.replace(/[\\`*_()[\]~+]/gu, '\\$&');
}

function serializeCodeText(value: string): string {
  return value.replace(/\r?\n/gu, ' ').replace(/`/gu, "'");
}

function serializeCodeBlockText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').replace(/```/gu, "'''").trimEnd();
}

function isHeadingElement(element: HTMLElement, tagName: string): boolean {
  return /^h[1-6]$/u.test(tagName) || element.dataset.maxBlock === 'heading';
}
