import {
  containsSupportedMarkdownSyntax,
  containsSupportedMarkdownUrl,
  extractSupportedMarkdownLinks,
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

  it('renders strong spans that cross paragraph boundaries without leaking markers', () => {
    const source = '**Первая строка\n\nВторая строка**';

    expect(renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' })).toBe(
      '<strong>Первая строка</strong>\n\n<strong>Вторая строка</strong>',
    );
    expect(stripSupportedMarkdownToPlainText(source)).toBe('Первая строка\n\nВторая строка');
  });

  it('recognizes multiline strong spans after punctuation or emoji prefixes', () => {
    expect(renderSupportedMarkdownAsHtml('🔥**Первая\n\nВторая**', { blockMode: 'raw' })).toBe(
      '🔥<strong>Первая</strong>\n\n<strong>Вторая</strong>',
    );
    expect(
      renderSupportedMarkdownAsHtml('Префикс: **Первая\nВторая**.', { blockMode: 'raw' }),
    ).toBe('Префикс: <strong>Первая</strong>\n<strong>Вторая</strong>.');
    expect(
      renderSupportedMarkdownAsHtml('Префикс **Первая\n\nВторая** хвост', { blockMode: 'raw' }),
    ).toBe('Префикс <strong>Первая</strong>\n\n<strong>Вторая</strong> хвост');
  });

  it('does not reinterpret ordinary single-line strong pairs as multiline spans', () => {
    expect(
      renderSupportedMarkdownAsHtml(
        '👋 **Ваша публикация удалена.**\n\n**✏️ Условие. **\n\n**💙 **Нужно подписаться',
        { blockMode: 'raw' },
      ),
    ).toBe(
      '👋 <strong>Ваша публикация удалена.</strong>\n\n<strong>✏️ Условие. </strong>\n\n<strong>💙 </strong>Нужно подписаться',
    );
  });

  it('handles a strong span whose closing marker is on its own line', () => {
    const source = '**Одна строка\n\n**';

    expect(renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' })).toBe(
      '<strong>Одна строка</strong>\n\n',
    );
    expect(containsSupportedMarkdownSyntax(source)).toBe(true);
    expect(
      renderSupportedMarkdownAsHtml('**Одна строка\n\n**\nСледующая', { blockMode: 'raw' }),
    ).toBe('<strong>Одна строка</strong>\n\nСледующая');
  });

  it('does not normalize escaped or fenced strong markers', () => {
    expect(renderSupportedMarkdownAsHtml('\\**literal\n\n\\**', { blockMode: 'raw' })).toBe(
      '**literal\n\n**',
    );
    expect(renderSupportedMarkdownAsHtml('```\n**literal\n\n**\n```', { blockMode: 'raw' })).toBe(
      '<pre>**literal\n\n**</pre>',
    );
  });

  it('renders heading and fenced code blocks for MAX publication', () => {
    expect(
      renderSupportedMarkdownAsHtml('# Анонс\n\n```\nconst value = "<MAX>";\n```\n\nТекст', {
        blockMode: 'raw',
      }),
    ).toBe('<strong>Анонс</strong>\n\n<pre>const value = &quot;&lt;MAX&gt;&quot;;</pre>\n\nТекст');
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

  it('extracts safe markdown links while ignoring code and unsupported schemes', () => {
    expect(
      extractSupportedMarkdownLinks(
        '[Витрина](https://shop.example/path) `https://code.example`\n```\n[x](https://hidden.example)\n```\n[Профиль](max://user/42) [bad](javascript:alert(1))',
      ),
    ).toEqual(['https://shop.example/path', 'max://user/42']);
  });

  it('finds URLs in link hrefs and Markdown-escaped visible text', () => {
    expect(
      containsSupportedMarkdownUrl('[Сайт](https://site.example/a_b)', 'https://site.example/a_b'),
    ).toBe(true);
    for (const [source, url] of [
      ['https://site.example/a\\_b', 'https://site.example/a_b'],
      ['https://site.example/a\\(b\\)', 'https://site.example/a(b)'],
      ['https://site.example/a\\+b', 'https://site.example/a+b'],
      ['https://site.example/a\\~b', 'https://site.example/a~b'],
    ]) {
      expect(containsSupportedMarkdownUrl(source, url)).toBe(true);
    }
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
