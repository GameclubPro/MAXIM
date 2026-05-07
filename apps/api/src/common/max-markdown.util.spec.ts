import {
  renderSupportedMarkdownAsHtml,
  stripSupportedMarkdownToPlainText,
} from './max-markdown.util';

describe('renderSupportedMarkdownAsHtml', () => {
  it('renders supported formatting and links to html', () => {
    expect(
      renderSupportedMarkdownAsHtml(
        '**Заголовок**\nТекст с _курсивом_, ++подчеркиванием++, ~~зачеркиванием~~ и `кодом`.\n\n[Открыть MAX](https://max.ru/)',
      ),
    ).toBe(
      '<p><strong>Заголовок</strong><br>Текст с <em>курсивом</em>, <u>подчеркиванием</u>, <s>зачеркиванием</s> и <code>кодом</code>.</p><p><a href="https://max.ru/">Открыть MAX</a></p>',
    );
  });

  it('escapes html in plain text and keeps unsupported links as text', () => {
    expect(renderSupportedMarkdownAsHtml('<b>x</b> [bad](javascript:alert(1))')).toBe(
      '<p>&lt;b&gt;x&lt;/b&gt; [bad](javascript:alert(1))</p>',
    );
  });

  it('falls back to bold block for markdown headings and inserts wraps into raw url labels', () => {
    expect(
      renderSupportedMarkdownAsHtml(
        '# Заголовок\n\n[https://dev.max.ru/docs-api/very/long/path](https://dev.max.ru/docs-api/very/long/path)',
      ),
    ).toBe(
      '<p><strong>Заголовок</strong></p><p><a href="https://dev.max.ru/docs-api/very/long/path">https:\u200B/\u200B/\u200Bdev.\u200Bmax.\u200Bru/\u200Bdocs-\u200Bapi/\u200Bvery/\u200Blong/\u200Bpath</a></p>',
    );
  });

  it('renders links as underlined preview labels when requested', () => {
    expect(
      renderSupportedMarkdownAsHtml('**[MAX Docs](https://dev.max.ru/)**', {
        linkMode: 'underline',
      }),
    ).toBe('<p><strong><u>MAX Docs</u></strong></p>');
  });

  it('renders nested bold italic underline links for publication and preview modes', () => {
    expect(renderSupportedMarkdownAsHtml('[**_++MAX Docs++_**](https://dev.max.ru/docs-api)')).toBe(
      '<p><a href="https://dev.max.ru/docs-api"><strong><em><u>MAX Docs</u></em></strong></a></p>',
    );
    expect(
      renderSupportedMarkdownAsHtml('[**_++MAX Docs++_**](https://dev.max.ru/docs-api)', {
        linkMode: 'underline',
      }),
    ).toBe('<p><u><strong><em><u>MAX Docs</u></em></strong></u></p>');
  });

  it('renders compact bold italic marker runs without leaking markdown punctuation', () => {
    expect(renderSupportedMarkdownAsHtml('***MAX Docs***')).toBe(
      '<p><strong><em>MAX Docs</em></strong></p>',
    );
    expect(renderSupportedMarkdownAsHtml('___++~~MAX Docs~~++___')).toBe(
      '<p><strong><em><u><s>MAX Docs</s></u></em></strong></p>',
    );
    expect(stripSupportedMarkdownToPlainText('___++~~MAX Docs~~++___')).toBe('MAX Docs');
  });

  it('renders every nested rich text modifier combination without leaking markers', () => {
    for (const source of buildNestedModifierSamples()) {
      expect(renderSupportedMarkdownAsHtml(source)).not.toMatch(/(?:\*\*|__|\+\+|~~)/u);
      expect(stripSupportedMarkdownToPlainText(source)).toBe('MAX Docs');
    }
  });

  it('preserves paragraphs, indentation and repeated spaces in html output', () => {
    expect(
      renderSupportedMarkdownAsHtml('**Анонс**\n\n  Второй абзац с  двойным пробелом\tи табом'),
    ).toBe(
      '<p><strong>Анонс</strong></p><p>&nbsp;&nbsp;Второй абзац с&nbsp;&nbsp;двойным пробелом&nbsp;&nbsp;&nbsp;&nbsp;и табом</p>',
    );
  });

  it('renders raw html output for MAX publication without paragraph tags', () => {
    expect(
      renderSupportedMarkdownAsHtml(
        '🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)\n\n  Второй абзац с  пробелами',
        { blockMode: 'raw' },
      ),
    ).toBe(
      '🔥<a href="https://dev.max.ru/docs-api"><strong><em><u>MAX Docs</u></em></strong></a>\n\n&nbsp;&nbsp;Второй абзац с&nbsp;&nbsp;пробелами',
    );
  });

  it('renders heading and fenced code blocks for MAX publication', () => {
    expect(
      renderSupportedMarkdownAsHtml('# Анонс\n\n```\nconst value = "<MAX>";\n```\n\nТекст', {
        blockMode: 'raw',
      }),
    ).toBe(
      '<strong>Анонс</strong>\n\n<pre>const value = &quot;&lt;MAX&gt;&quot;;</pre>\n\nТекст',
    );
    expect(stripSupportedMarkdownToPlainText('# Анонс\n\n```\nconst value = "<MAX>";\n```')).toBe(
      'Анонс\n\nconst value = "<MAX>";',
    );
  });

  it('renders escaped markdown punctuation as literal text', () => {
    expect(renderSupportedMarkdownAsHtml('**Анонс** C\\+\\+ \\[beta\\] \\(v2\\) \\_raw\\_')).toBe(
      '<p><strong>Анонс</strong> C++ [beta] (v2) _raw_</p>',
    );
    expect(
      stripSupportedMarkdownToPlainText('**Анонс** C\\+\\+ \\[beta\\] \\(v2\\) \\_raw\\_'),
    ).toBe('Анонс C++ [beta] (v2) _raw_');
  });

  it('strips supported markdown to plain text', () => {
    expect(
      stripSupportedMarkdownToPlainText(
        '**Заголовок**\nТекст с _курсивом_, ++подчеркиванием++, ~~зачеркиванием~~ и `кодом`.\n\n[Открыть MAX](https://max.ru/)',
      ),
    ).toBe('Заголовок\nТекст с курсивом, подчеркиванием, зачеркиванием и кодом.\n\nОткрыть MAX');
  });
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
