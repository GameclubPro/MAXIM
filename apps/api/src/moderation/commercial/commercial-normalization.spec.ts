import {
  normalizeCommercialRawText,
  normalizeCommercialConfusables,
  normalizeCommercialText,
} from './commercial-normalization';

describe('normalizeCommercialText', () => {
  it('collapses intentionally spaced commercial words', () => {
    expect(normalizeCommercialText('П Р О Д А Е М мебель')).toContain('продаем мебель');
    expect(normalizeCommercialText('П.Р.О.Д.А.Е.М мебель')).toContain('продаем мебель');
  });

  it('keeps regular words around obfuscated tokens readable', () => {
    expect(normalizeCommercialText('Сдам офис в центре')).toBe('сдам офис в центре');
    expect(normalizeCommercialText('Подскажите, где офис?')).toBe('подскажите, где офис?');
  });

  it('normalizes common visual Latin confusables in commercial spam words', () => {
    expect(normalizeCommercialConfusables('Дeньги дo зapплaты oнлaйн')).toBe(
      'деньги до зарплаты онлайн',
    );
  });

  it('restores obfuscated commercial links before rule matching', () => {
    expect(normalizeCommercialRawText('hxxps://max dot ru/join/sale')).toBe(
      'https://max.ru/join/sale',
    );
    expect(normalizeCommercialRawText('hxxp://credit точка ru')).toBe('http://credit.ru');
  });

  it('strips zero-width separators from obfuscated commercial words', () => {
    expect(normalizeCommercialRawText('п\u200bр\u200bо\u200bд\u200bа\u200bм')).toBe('продам');
  });
});
