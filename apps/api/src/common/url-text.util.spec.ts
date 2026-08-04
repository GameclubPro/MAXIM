import { extractUrlsFromText, replaceUrlsInText, stripUrlsFromText } from './url-text.util';

describe('url-text util', () => {
  it('extracts bare MAX invite links', () => {
    expect(extractUrlsFromText('вступай max.ru/join/abcDEF123')).toEqual(['max.ru/join/abcDEF123']);
  });

  it('extracts unicode domains with scheme', () => {
    expect(extractUrlsFromText('вакансии https://центр-занятости-иркутск38.рф')).toEqual([
      'https://центр-занятости-иркутск38.рф',
    ]);
  });

  it('keeps scheme matching independent from bare URL TLD candidates', () => {
    expect(extractUrlsFromText('сайт https://例え.テスト/путь')).toEqual([
      'https://例え.テスト/путь',
    ]);
  });

  it('trims punctuation that wraps pasted scheme urls', () => {
    expect(
      extractUrlsFromText('ссылки: [https://max.ru/channel/news] {https://docs.max.ru/start}:'),
    ).toEqual(['https://max.ru/channel/news', 'https://docs.max.ru/start']);
  });

  it('extracts bare urls before trailing punctuation', () => {
    expect(extractUrlsFromText('ссылки bad.com, test.org. max.ru!')).toEqual([
      'bad.com',
      'test.org',
      'max.ru',
    ]);
  });

  it('preserves trailing punctuation when replacing or stripping scheme urls', () => {
    const text = 'https://example.com, дальше';

    expect(extractUrlsFromText(text)).toEqual(['https://example.com']);
    expect(replaceUrlsInText(text, '[url]')).toBe('[url], дальше');
    expect(stripUrlsFromText(text)).toBe(', дальше');
  });

  it('stops scheme urls before an attached Russian sentence', () => {
    const text = 'https://example.com.Не реклама';

    expect(extractUrlsFromText(text)).toEqual(['https://example.com']);
    expect(replaceUrlsInText(text, '[url]')).toBe('[url].Не реклама');
    expect(stripUrlsFromText(text)).toBe('.Не реклама');
  });

  it('keeps dotted Cyrillic path segments inside scheme urls', () => {
    const text = 'https://example.ru/Иван.Иванов';

    expect(extractUrlsFromText(text)).toEqual(['https://example.ru/Иван.Иванов']);
    expect(replaceUrlsInText(text, '[url]')).toBe('[url]');
    expect(stripUrlsFromText(text)).toBe('');
  });

  it('extracts separate urls from markdown-style links', () => {
    expect(extractUrlsFromText('жми [https://safe.example](https://casino.example/path).')).toEqual(
      ['https://safe.example', 'https://casino.example/path'],
    );
  });

  it('does not merge adjacent scheme urls across closing punctuation', () => {
    expect(
      extractUrlsFromText('старое https://safe.example)https://casino.example/path новое'),
    ).toEqual(['https://safe.example', 'https://casino.example/path']);
  });

  it('keeps an outer bare url when its query contains another scheme url', () => {
    expect(extractUrlsFromText('редирект bad.example?to=https://safe.example/path')).toEqual([
      'bad.example?to=https://safe.example/path',
      'https://safe.example/path',
    ]);
  });

  it('extracts bare punycode IDN domains as complete urls', () => {
    expect(extractUrlsFromText('сайт xn--d1acufc.xn--p1ai/about')).toEqual([
      'xn--d1acufc.xn--p1ai/about',
    ]);
  });

  it('does not treat dotted russian text as a url', () => {
    expect(extractUrlsFromText('Продам кузов Нивы.Весь перевареный')).toEqual([]);
  });

  it('keeps long dotted near-misses out of bare URL matching', () => {
    const text = `Продаем бензин ${Array.from({ length: 1_100 }, () => 'x').join('.')}. Архив.`;

    expect(extractUrlsFromText(text)).toEqual([]);
    expect(stripUrlsFromText(text)).toBe(text);
  });

  it('extracts urls split with zero-width format controls', () => {
    const text = 'пример exa\u200bmple.com и https://bad.ex\u200bample/path в тексте';

    expect(extractUrlsFromText(text)).toEqual(['example.com', 'https://bad.example/path']);
    expect(stripUrlsFromText(text)).toBe('пример и в тексте');
  });

  it('does not treat dotted addresses as a url', () => {
    expect(extractUrlsFromText('ул.Первомайская,34')).toEqual([]);
  });

  it('does not treat decimal values as a url', () => {
    expect(extractUrlsFromText('Завтра доставка после 18.00')).toEqual([]);
  });

  it('does not treat numbered cultivar lines as urls', () => {
    expect(
      extractUrlsFromText('2.Humako Inches\n5.Dn-Bora Bora\n8.Dn- Цвет Сакуры\nтел.89883218131'),
    ).toEqual([]);
  });

  it('does not treat plain file names as bare urls', () => {
    const fileName = 'Протокол_проверки_права_по_заявлению___ЗЕП-226-004535580.pdf';

    expect(extractUrlsFromText(fileName)).toEqual([]);
    expect(stripUrlsFromText(fileName)).toBe(fileName);
  });

  it('keeps explicit links to files', () => {
    expect(
      extractUrlsFromText(
        'документ https://example.com/files/report.pdf и зеркало example.com/files/report.pdf',
      ),
    ).toEqual(['https://example.com/files/report.pdf', 'example.com/files/report.pdf']);
  });

  it('strips urls while keeping the rest of the message', () => {
    expect(stripUrlsFromText('смотри https://max.ru/join/abcDEF123 прямо сейчас')).toBe(
      'смотри прямо сейчас',
    );
  });
});
