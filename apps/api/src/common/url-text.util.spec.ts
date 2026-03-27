import { extractUrlsFromText, stripUrlsFromText } from './url-text.util';

describe('url-text util', () => {
  it('extracts bare MAX invite links', () => {
    expect(extractUrlsFromText('вступай max.ru/join/abcDEF123')).toEqual([
      'max.ru/join/abcDEF123',
    ]);
  });

  it('extracts unicode domains with scheme', () => {
    expect(extractUrlsFromText('вакансии https://центр-занятости-иркутск38.рф')).toEqual([
      'https://центр-занятости-иркутск38.рф',
    ]);
  });

  it('does not treat dotted russian text as a url', () => {
    expect(extractUrlsFromText("Продам кузов Нивы.Весь перевареный")).toEqual([]);
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

  it('strips urls while keeping the rest of the message', () => {
    expect(stripUrlsFromText('смотри https://max.ru/join/abcDEF123 прямо сейчас')).toBe(
      'смотри прямо сейчас',
    );
  });
});
