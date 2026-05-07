import assert from 'node:assert/strict';
import test from 'node:test';
import { clipboardHtmlToSupportedMarkdown } from '../src/lib/max-rich-text-clipboard';
import { renderSupportedMarkdownAsHtml } from '../src/lib/max-markdown';

test('converts semantic clipboard html to supported MAX markdown', () => {
  assert.equal(
    clipboardHtmlToSupportedMarkdown(
      '<p><strong>Жирный</strong> и <em>курсив</em><br><u>низ</u> <s>стоп</s></p>',
    ),
    '**Жирный** и _курсив_\n++низ++ ~~стоп~~',
  );
});

test('converts common styled clipboard spans without duplicated marks', () => {
  assert.equal(
    clipboardHtmlToSupportedMarkdown(
      '<strong><span style="font-weight: 700; font-style: italic; text-decoration: underline line-through">MAX</span></strong>',
    ),
    '**_++~~MAX~~++_**',
  );
});

test('keeps only safe clipboard links', () => {
  assert.equal(
    clipboardHtmlToSupportedMarkdown(
      '<a href="https://max.ru/test?a=1&amp;b=2">MAX</a> <a href="javascript:alert(1)">bad</a>',
    ),
    '[MAX](https://max.ru/test?a=1&b=2) bad',
  );
});

test('skips active content and decodes html entities', () => {
  assert.equal(
    clipboardHtmlToSupportedMarkdown('<p>A&amp;B<script>alert(1)</script><style>.x{}</style></p>'),
    'A&B',
  );
});

test('preserves modern clipboard blocks with safe fallbacks', () => {
  assert.equal(
    clipboardHtmlToSupportedMarkdown(
      '<h2>Анонс</h2><pre><code>const value = "&lt;MAX&gt;";</code></pre><ul><li>Первое</li><li><b>Второе</b></li></ul><blockquote>Важно<br>сейчас</blockquote><mark>Фокус</mark>',
    ),
    '# Анонс\n\n```\nconst value = "<MAX>";\n```\n\n• Первое\n• **Второе**\n\n> Важно\n> сейчас\n\n**Фокус**',
  );
});

test('escapes pasted markdown punctuation as literal text', () => {
  const markdown = clipboardHtmlToSupportedMarkdown('<b>A*B_[C]</b>');

  assert.equal(markdown, '**A\\*B\\_\\[C\\]**');
  assert.equal(
    renderSupportedMarkdownAsHtml(markdown, { blockMode: 'inline' }),
    '<strong>A*B_[C]</strong>',
  );
});
