import { renderSupportedMarkdownAsHtml } from './max-markdown.util';

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
});
