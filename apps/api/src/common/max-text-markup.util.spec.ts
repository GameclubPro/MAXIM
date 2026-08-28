import {
  isMaxTextMarkupType,
  normalizeMaxUserMentionLink,
  renderMaxTextMarkupAsHtml,
  renderMaxTextMarkupAsMarkdown,
  type MaxTextMarkup,
} from './max-text-markup.util';

function markup(type: MaxTextMarkup['type'], length: number, userLink: string | null = null) {
  return [{ type, from: 0, length, url: null, userLink }];
}

describe('MAX text markup', () => {
  it('recognizes every current official markup type', () => {
    expect(isMaxTextMarkupType('highlighted')).toBe(true);
    expect(isMaxTextMarkupType('quote')).toBe(true);
    expect(isMaxTextMarkupType('unknown')).toBe(false);
  });

  it('renders heading, highlight, and quote markup as supported MAX HTML', () => {
    expect(renderMaxTextMarkupAsHtml('Раздел', markup('heading', 6))).toBe(
      '<h3>Раздел</h3>',
    );
    expect(renderMaxTextMarkupAsHtml('Фокус', markup('highlighted', 5))).toBe(
      '<mark>Фокус</mark>',
    );
    expect(renderMaxTextMarkupAsHtml('Цитата', markup('quote', 6))).toBe(
      '<blockquote>Цитата</blockquote>',
    );
  });

  it('canonicalizes official user_id mentions without weakening link validation', () => {
    expect(normalizeMaxUserMentionLink(null, 67123224)).toBe('max://user/67123224');
    expect(normalizeMaxUserMentionLink(null, '00042')).toBe('max://user/42');
    expect(normalizeMaxUserMentionLink('user/77', 42)).toBe('user/77');
    expect(normalizeMaxUserMentionLink(null, 'not-a-user')).toBeNull();
    expect(
      renderMaxTextMarkupAsHtml('Стас', markup('user_mention', 4, 'max://user/67123224')),
    ).toBe('<a href="max://user/67123224">Стас</a>');
  });

  it('keeps partially overlapping markup balanced and splits formatting by lines', () => {
    expect(
      renderMaxTextMarkupAsHtml('ABCDEFGH', [
        { type: 'strong', from: 0, length: 5, url: null, userLink: null },
        { type: 'emphasized', from: 3, length: 5, url: null, userLink: null },
      ]),
    ).toBe('<strong>ABC<em>DE</em></strong><em>FGH</em>');

    expect(
      renderMaxTextMarkupAsHtml('Первая\n\nВторая', [
        { type: 'highlighted', from: 0, length: 14, url: null, userLink: null },
      ]),
    ).toBe('<mark>Первая</mark>\n\n<mark>Вторая</mark>');
  });

  it('keeps outer heading and quote blocks open across nested inline boundaries', () => {
    expect(
      renderMaxTextMarkupAsHtml('Heading', [
        { type: 'heading', from: 0, length: 7, url: null, userLink: null },
        { type: 'strong', from: 3, length: 2, url: null, userLink: null },
      ]),
    ).toBe('<h3>Hea<strong>di</strong>ng</h3>');

    expect(
      renderMaxTextMarkupAsHtml('Quote', [
        { type: 'quote', from: 0, length: 5, url: null, userLink: null },
        { type: 'emphasized', from: 1, length: 3, url: null, userLink: null },
      ]),
    ).toBe('<blockquote>Q<em>uot</em>e</blockquote>');
  });

  it('reconstructs crossing markdown ranges without crossing delimiters', () => {
    expect(
      renderMaxTextMarkupAsMarkdown('ABCDEFGH', [
        { type: 'strong', from: 0, length: 5, url: null, userLink: null },
        { type: 'emphasized', from: 3, length: 5, url: null, userLink: null },
      ]),
    ).toBe('**ABC_DE_**_FGH_');
  });

  it('keeps markdown punctuation literal inside monospaced ranges', () => {
    expect(renderMaxTextMarkupAsMarkdown('a_b*c', markup('monospaced', 5))).toBe('`a_b*c`');
    expect(renderMaxTextMarkupAsMarkdown('a`b', markup('monospaced', 3))).toBeNull();
  });

  it('keeps redundant MAX auto-links plain and safely escapes them beside formatting', () => {
    const url = 'https://t.me/glavnyy_admin';
    const source = `Docs ${url}`;
    const autoLink = {
      type: 'link' as const,
      from: 5,
      length: url.length,
      url,
      userLink: null,
    };

    expect(renderMaxTextMarkupAsMarkdown(source, [autoLink])).toBeNull();
    expect(
      renderMaxTextMarkupAsMarkdown(source, [
        { type: 'strong', from: 0, length: 4, url: null, userLink: null },
        autoLink,
      ]),
    ).toBe('**Docs** https://t.me/glavnyy\\_admin');
  });

  it('keeps invalid ranges on the plain-text renderer fallback contracts', () => {
    const invalid = [
      { type: 'strong', from: 99, length: 4, url: null, userLink: null },
    ] satisfies MaxTextMarkup[];

    expect(renderMaxTextMarkupAsHtml('a_b*<x>', invalid)).toBeNull();
    expect(renderMaxTextMarkupAsMarkdown('a_b*<x>', invalid)).toBeNull();
  });

  it('allows only safe anchor schemes and serializes markdown URL delimiters', () => {
    const unsafe = [
      {
        type: 'link',
        from: 0,
        length: 4,
        url: 'javascript:alert(1)',
        userLink: null,
      },
    ] satisfies MaxTextMarkup[];
    expect(renderMaxTextMarkupAsHtml('Docs', unsafe)).toBeNull();
    expect(renderMaxTextMarkupAsMarkdown('Docs', unsafe)).toBeNull();

    const safe = [
      {
        type: 'link',
        from: 0,
        length: 4,
        url: 'https://example.com/a(b)?q=white space\\x',
        userLink: null,
      },
    ] satisfies MaxTextMarkup[];
    expect(renderMaxTextMarkupAsHtml('Docs', safe)).toBe(
      '<a href="https://example.com/a(b)?q=white%20space%5Cx">Docs</a>',
    );
    expect(renderMaxTextMarkupAsMarkdown('Docs', safe)).toBe(
      '[Docs](https://example.com/a%28b%29?q=white%20space%5Cx)',
    );
  });

  it('keeps case-sensitive URL paths distinct when detecting redundant auto-links', () => {
    const visible = 'https://example.com/Admin';
    expect(
      renderMaxTextMarkupAsMarkdown(visible, [
        {
          type: 'link',
          from: 0,
          length: visible.length,
          url: 'https://example.com/admin',
          userLink: null,
        },
      ]),
    ).toBe('[https://example.com/Admin](https://example.com/admin)');
  });
});
