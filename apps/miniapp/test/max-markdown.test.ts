import assert from 'node:assert/strict';
import test from 'node:test';
import {
  containsSupportedMarkdownUrl,
  renderPlainTextAsEditorHtml,
  renderSupportedMarkdownAsHtml,
  stripSupportedMarkdownToPlainText,
} from '../src/lib/max-markdown';

test('finds URLs in link hrefs and Markdown-escaped visible text', () => {
  assert.equal(
    containsSupportedMarkdownUrl('[Сайт](https://site.example/a_b)', 'https://site.example/a_b'),
    true,
  );
  for (const [source, url] of [
    ['https://site.example/a\\_b', 'https://site.example/a_b'],
    ['https://site.example/a\\(b\\)', 'https://site.example/a(b)'],
    ['https://site.example/a\\+b', 'https://site.example/a+b'],
    ['https://site.example/a\\~b', 'https://site.example/a~b'],
  ]) {
    assert.equal(containsSupportedMarkdownUrl(source, url), true);
  }
});

test('renders compact bold italic marker runs without leaking markdown punctuation', () => {
  assert.equal(
    renderSupportedMarkdownAsHtml('***MAX Docs***', { blockMode: 'inline' }),
    '<strong><em>MAX Docs</em></strong>',
  );
  assert.equal(
    renderSupportedMarkdownAsHtml('___++~~MAX Docs~~++___', { blockMode: 'inline' }),
    '<strong><em><u><s>MAX Docs</s></u></em></strong>',
  );
  assert.equal(stripSupportedMarkdownToPlainText('___++~~MAX Docs~~++___'), 'MAX Docs');
});

test('renders heading blocks and fenced code blocks', () => {
  assert.equal(
    renderSupportedMarkdownAsHtml('# Анонс\n\n```\nconst value = "<MAX>";\n```\n\nТекст', {
      blockMode: 'inline',
    }),
    '<h3>Анонс</h3><br><br><pre>const value = &quot;&lt;MAX&gt;&quot;;</pre><br><br>Текст',
  );
  assert.equal(
    stripSupportedMarkdownToPlainText('# Анонс\n\n```\nconst value = "<MAX>";\n```'),
    'Анонс\n\nconst value = "<MAX>";',
  );
});

test('uses the MAX publication heading markup in raw mode', () => {
  assert.equal(
    renderSupportedMarkdownAsHtml('# Анонс', { blockMode: 'raw' }),
    '<strong>Анонс</strong>',
  );
});

test('keeps plain VK-looking markdown literal in the rich editor source', () => {
  assert.equal(
    renderPlainTextAsEditorHtml('**скидка**\n# заголовок\n<x> & y'),
    '**скидка**<br># заголовок<br>&lt;x&gt; &amp; y',
  );
});

test('renders every nested rich text modifier combination without leaking markers', () => {
  for (const source of buildNestedModifierSamples()) {
    assert.doesNotMatch(
      renderSupportedMarkdownAsHtml(source, { blockMode: 'inline' }),
      /(?:\*\*|__|\+\+|~~)/u,
    );
    assert.equal(stripSupportedMarkdownToPlainText(source), 'MAX Docs');
  }
});

test('keeps bot template placeholders literal when requested', () => {
  assert.equal(
    renderSupportedMarkdownAsHtml('{message_status} {required_invites_count}', {
      blockMode: 'inline',
      preserveCurlyBracePlaceholders: true,
    }),
    '{message_status} {required_invites_count}',
  );
});

test('renders bot placeholders as readable editor tokens without changing their keys', () => {
  assert.equal(
    renderSupportedMarkdownAsHtml('{user}, сообщение {message_status}: {reason}.', {
      blockMode: 'inline',
      preserveCurlyBracePlaceholders: true,
      curlyBracePlaceholderLabels: {
        user: 'Имя',
        message_status: 'Статус',
        reason: 'Причина',
      },
    }),
    '<span class="max-rich-text-editor__placeholder-token" data-max-placeholder="user" contenteditable="false">Имя</span>, сообщение <span class="max-rich-text-editor__placeholder-token" data-max-placeholder="message_status" contenteditable="false">Статус</span>: <span class="max-rich-text-editor__placeholder-token" data-max-placeholder="reason" contenteditable="false">Причина</span>.',
  );
});

function buildNestedModifierSamples(): string[] {
  const wrappers: Array<[string, string]> = [
    ['**', '**'],
    ['_', '_'],
    ['++', '++'],
    ['~~', '~~'],
  ];

  return permute(wrappers).map((permutation) =>
    permutation.reduce((content, [prefix, suffix]) => `${prefix}${content}${suffix}`, 'MAX Docs'),
  );
}

function permute<T>(items: T[]): T[][] {
  if (items.length === 0) {
    return [[]];
  }

  return items.flatMap((item, index) =>
    permute([...items.slice(0, index), ...items.slice(index + 1)]).map((permutation) => [
      item,
      ...permutation,
    ]),
  );
}
