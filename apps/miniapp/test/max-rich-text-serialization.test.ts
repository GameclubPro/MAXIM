import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSupportedMarkdownAsHtml } from '../src/lib/max-markdown';
import { serializeEditorInlineMarkdown } from '../src/lib/max-rich-text-serialization';

test('rich text serialization keeps every inline wrapper inside one line', () => {
  const expectedTags = {
    bold: 'strong',
    italic: 'em',
    underline: 'u',
    strike: 's',
    highlight: 'mark',
  } as const;

  for (const [mark, tag] of Object.entries(expectedTags)) {
    const markdown = serializeEditorInlineMarkdown(
      '🔥 Первая строка\n\nВторая \\*звезда\\* строка',
      mark as keyof typeof expectedTags,
    );
    const html = renderSupportedMarkdownAsHtml(markdown, { blockMode: 'inline' });

    assert.equal(markdown.split('\n')[1], '');
    assert.match(html, new RegExp(`<${tag}>🔥 Первая строка</${tag}>`, 'u'));
    assert.match(html, new RegExp(`<${tag}>Вторая \\*звезда\\* строка</${tag}>`, 'u'));
    assert.doesNotMatch(html, /(?:\*\*|\+\+|~~|\^\^)/u);
  }
});
