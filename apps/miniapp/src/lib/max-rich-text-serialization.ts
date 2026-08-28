export type EditorInlineMarkdownMark = 'bold' | 'italic' | 'underline' | 'strike' | 'highlight';

const EDITOR_INLINE_MARKERS: Record<EditorInlineMarkdownMark, string> = {
  bold: '**',
  italic: '_',
  underline: '++',
  strike: '~~',
  highlight: '^^',
};

export function serializeEditorMarkdownLines(
  content: string,
  wrapLine: (line: string) => string,
): string {
  return content
    .split('\n')
    .map((line) => (line.trim() ? wrapLine(line) : line))
    .join('\n');
}

export function serializeEditorInlineMarkdown(
  content: string,
  mark: EditorInlineMarkdownMark,
): string {
  const marker = EDITOR_INLINE_MARKERS[mark];
  return serializeEditorMarkdownLines(content, (line) => `${marker}${line}${marker}`);
}
