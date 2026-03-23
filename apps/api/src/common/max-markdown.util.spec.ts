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

  it('strips supported markdown to plain text', () => {
    expect(
      stripSupportedMarkdownToPlainText(
        '**Заголовок**\nТекст с _курсивом_, ++подчеркиванием++, ~~зачеркиванием~~ и `кодом`.\n\n[Открыть MAX](https://max.ru/)',
      ),
    ).toBe(
      'Заголовок\nТекст с курсивом, подчеркиванием, зачеркиванием и кодом.\n\nОткрыть MAX',
    );
  });
});
