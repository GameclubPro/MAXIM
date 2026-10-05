import { normalizeDuplicateSemanticText } from './duplicate-semantic-text';

describe('case-sensitive duplicate quantity units', () => {
  it.each([
    ['100 MB/s', '100 Mb/s'],
    ['100 MBps', '100 Mbps'],
    ['100 Mbit/s', '100 mbit/s'],
    ['10 MΩ', '10 mΩ'],
    ['5 MW', '5 mW'],
    ['10 Ms', '10 ms'],
    ['1 PA', '1 pA'],
    ['1 MB/S', '1 MB/s'],
    ['1 MiB', '1 Mib'],
    ['1 MiBps', '1 Mibps'],
    ['10 МВт', '10 мВт'],
    ['10 МБ', '10 Мб'],
    ['١٠ MΩ', '١٠ mΩ'],
    ['1.5e3 MW', '1.5e3 mW'],
    ['10MΩ', '10mΩ'],
    ['1 W/m²', '1 W/M²'],
    ['10 M', '10 m'],
    ['10 mG', '10 mg'],
    ['10 V/(MΩ)', '10 V/(mΩ)'],
    ['10 (MΩ)', '10 (mΩ)'],
    ['10\u200bMΩ', '10\u200bmΩ'],
    ['10·MΩ', '10·mΩ'],
    ['10 V×MΩ', '10 V×mΩ'],
    ['10 V∙MΩ', '10 V∙mΩ'],
    ['100 M\u200bB/s', '100 M\u200bb/s'],
    ['10 «MΩ»', '10 «mΩ»'],
    ['10 V/«MΩ»', '10 V/«mΩ»'],
    ['10x20mm', '10x20Mm'],
    ['10х20 mm', '10х20 Mm'],
    ['10V∕MΩ', '10V∕mΩ'],
    ['10V÷MΩ', '10V÷mΩ'],
    ['10V⁄MΩ', '10V⁄mΩ'],
    ['10 N S', '10 N s'],
    ['10 (N) S', '10 (N) s'],
    ['10 N \u200b/ MΩ', '10 N \u200b/ mΩ'],
    ['1 W·mS', '1 W·MS'],
    ['10 MB, 20 Mb', '10 Mb, 20 MB'],
  ])('preserves different quantities %s and %s', (first, second) => {
    expect(normalizeDuplicateSemanticText(first)).not.toBe(normalizeDuplicateSemanticText(second));
  });

  it('keeps ordinary prose case and whitespace cosmetic beside the same quantity', () => {
    expect(normalizeDuplicateSemanticText(' Производительность  100 MB/s\nсегодня ')).toBe(
      normalizeDuplicateSemanticText('ПРОИЗВОДИТЕЛЬНОСТЬ 100 MB/s СЕГОДНЯ'),
    );
    expect(normalizeDuplicateSemanticText('Сопротивление 10 MΩ')).toBe(
      normalizeDuplicateSemanticText('СОПРОТИВЛЕНИЕ 10 MΩ'),
    );
    expect(normalizeDuplicateSemanticText('Передано 10 BYTES')).toBe(
      normalizeDuplicateSemanticText('ПЕРЕДАНО 10 bytes'),
    );
    expect(normalizeDuplicateSemanticText('Передано 10 MBit')).toBe(
      normalizeDuplicateSemanticText('ПЕРЕДАНО 10 Mbit'),
    );
    expect(normalizeDuplicateSemanticText('Значение 10 N m сегодня')).toBe(
      normalizeDuplicateSemanticText('ЗНАЧЕНИЕ 10 N m СЕГОДНЯ'),
    );
  });

  it.each(['MS Excel', 'ID100MB', '100MB_item', '100 ModelCode', '100 обычных СЛОВ'])(
    'does not extend unit protection to ordinary prose or identifiers: %s',
    (text) => {
      expect(normalizeDuplicateSemanticText(text)).toBe(text.toLowerCase());
    },
  );

  it('does not erase numeric evidence or punctuation in a long separator chain', () => {
    const text = '1,'.repeat(4000) + '1 MB/s';
    expect(normalizeDuplicateSemanticText(text)).toBe(text);
  });

  it('preserves every component in a long compound exponent chain', () => {
    const text = '1 m' + '^1/MΩ'.repeat(1200);
    expect(normalizeDuplicateSemanticText(text)).toBe(text);
  });
});
