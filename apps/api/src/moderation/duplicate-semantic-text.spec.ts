import {
  hasDuplicateQuantityUnitPrefix,
  hasDuplicateQuantityUnitSuffix,
  normalizeDuplicateSemanticText,
} from './duplicate-semantic-text';

describe('case-sensitive duplicate quantity units', () => {
  it.each([
    ['100 MB/s', '100 Mb/s'],
    ['100 MBps', '100 Mbps'],
    ['100 Mbit/s', '100 mbit/s'],
    ['10 MΩ', '10 mΩ'],
    ['5 MW', '5 mW'],
    ...[
      ['MWh', 'mWh'],
      ['MAh', 'mAh'],
      ['MVA', 'mVA'],
      ['Mvar', 'mvar'],
      ['МВтч', 'мВтч'],
      ['МАч', 'мАч'],
      ['МВА', 'мВА'],
      ['Мвар', 'мвар'],
    ].flatMap(([large, small]) => [
      [`10 ${large}`, `10 ${small}`],
      [`${large}: 10`, `${small}: 10`],
      [`10 ${large}²/V`, `10 ${small}²/V`],
      [`V/(${large}⁻²): 10`, `V/(${small}⁻²): 10`],
    ]),
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
    ['Размер файла (MB): 100', 'Размер файла (Mb): 100'],
    ['Сопротивление, MΩ: 10', 'Сопротивление, mΩ: 10'],
    ['Скорость, MB/s — 100', 'Скорость, Mb/s — 100'],
    ['Скорость, MB/s - 100', 'Скорость, Mb/s - 100'],
    ['MB/s = +100', 'Mb/s = +100'],
    ['MΩ -10', 'mΩ -10'],
    ['MΩ: -١٠', 'mΩ: -١٠'],
    ['MΩ: 1.5e3', 'mΩ: 1.5e3'],
    ['МВт: 10', 'мВт: 10'],
    ['V/(MΩ): 10', 'V/(mΩ): 10'],
    ['MB/S: 10', 'MB/s: 10'],
    ['MB/s²: 10', 'Mb/s²: 10'],
    ['MB/s^2: 10', 'Mb/s^2: 10'],
    ...['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹', '⁻²', '⁺²', '¹²'].map((exponent) => [
      `MΩ${exponent}: 10`,
      `mΩ${exponent}: 10`,
    ]),
    ['MW³/V: 10', 'mW³/V: 10'],
    ['(MΩ⁻²) = 10', '(mΩ⁻²) = 10'],
    ['V/MΩ⁺²: 10', 'V/mΩ⁺²: 10'],
    ['MΩ⁺²/V: 10', 'mΩ⁺²/V: 10'],
    ['10 V/MΩ⁺²', '10 V/mΩ⁺²'],
    ['M\u200bB: 10', 'M\u200bb: 10'],
    ['MB: 10, Mb: 20', 'Mb: 10, MB: 20'],
    ['10 MB/s, Mb: 20', '10 Mb/s, MB: 20'],
    ['10: MΩ', '10: mΩ'],
    ['10 = MB/s', '10 = Mb/s'],
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
    expect(normalizeDuplicateSemanticText(' Размер файла (MB): 100\nсегодня ')).toBe(
      normalizeDuplicateSemanticText('РАЗМЕР ФАЙЛА (MB): 100 СЕГОДНЯ'),
    );
    expect(normalizeDuplicateSemanticText('Передано MBytes: 100')).toBe(
      normalizeDuplicateSemanticText('ПЕРЕДАНО Mbytes: 100'),
    );
    expect(normalizeDuplicateSemanticText('Сопротивление (MΩ²): 10 сегодня')).toBe(
      normalizeDuplicateSemanticText('СОПРОТИВЛЕНИЕ (MΩ²): 10 СЕГОДНЯ'),
    );
  });

  it.each(['MWh', 'MAh', 'MVA', 'Mvar', 'МВтч', 'МАч', 'МВА', 'Мвар', 'МВт·ч', 'мА·ч'])(
    'keeps prose case cosmetic beside the unchanged electrical unit %s',
    (unit) => {
      expect(normalizeDuplicateSemanticText(` Запас оборудования  10 ${unit}\nсегодня `)).toBe(
        normalizeDuplicateSemanticText(`ЗАПАС ОБОРУДОВАНИЯ 10 ${unit} СЕГОДНЯ`),
      );
    },
  );

  it.each([
    'MS Excel',
    'ID100MB',
    '100MB_item',
    '100 ModelCode',
    '100 обычных СЛОВ',
    'MB100',
    'MB-100',
    'MB100_item',
    'MB²100',
    'MB²_100',
    'MB³ModelCode',
    'ModelCode: 100',
    'Передайте MB сегодня: 100',
    'MWh100_item',
    'MWh³ModelCode',
    '100 ModelVA',
    'VARIANT: 100',
  ])('does not extend unit protection to ordinary prose or identifiers: %s', (text) => {
    expect(normalizeDuplicateSemanticText(text)).toBe(text.toLowerCase());
  });

  it('does not erase numeric evidence or punctuation in a long separator chain', () => {
    const text = '1,'.repeat(4000) + '1 MB/s';
    expect(normalizeDuplicateSemanticText(text)).toBe(text);
  });

  it('preserves every component in a long compound exponent chain', () => {
    const text = '1 m' + '^1/MΩ'.repeat(1200);
    expect(normalizeDuplicateSemanticText(text)).toBe(text);
  });

  it.each([
    'MB: ',
    '(MΩ) = ',
    'V/(mΩ): ',
    'MB/s²: ',
    'MB/S — ',
    'MB/s - ',
    'МВт\n',
    'M\u200bB: ',
    'MΩ²: ',
    'MW³/V: ',
    '(MΩ⁻²) = ',
    'MΩ⁺²: ',
  ])('shares a finite prefix quantity classifier for %j', (prefix) => {
    expect(hasDuplicateQuantityUnitPrefix(prefix)).toBe(true);
  });

  it.each(['Wh', 'Ah', 'VA', 'var', 'Втч', 'Ач', 'ВА', 'вар', 'ч'])(
    'shares electrical quantity classifiers for the finite symbol %s',
    (symbol) => {
      for (const unit of [symbol, `M${symbol}`, `m${symbol}`]) {
        if (/\p{Script=Cyrillic}/u.test(symbol) && unit !== symbol) continue;
        expect(hasDuplicateQuantityUnitPrefix(`(${unit}²): `)).toBe(true);
        expect(hasDuplicateQuantityUnitSuffix(` (${unit}²)`)).toBe(true);
      }
    },
  );

  it.each(['МВтч', 'мВтч', 'МАч', 'мАч', 'МВА', 'мВА', 'Мвар', 'мвар', 'МВт·ч', 'мА·ч'])(
    'shares electrical quantity classifiers for the Russian unit %s',
    (unit) => {
      expect(hasDuplicateQuantityUnitPrefix(`(${unit}): `)).toBe(true);
      expect(hasDuplicateQuantityUnitSuffix(` (${unit})`)).toBe(true);
    },
  );

  it.each(['Модель: ', 'MS Excel ', 'MB100 ', 'MB-100 ', '10 MB, ', 'MB сегодня: '])(
    'does not claim a quantity prefix from %j',
    (prefix) => {
      expect(hasDuplicateQuantityUnitPrefix(prefix)).toBe(false);
    },
  );

  it('inspects long prefix compound expressions once while preserving their exact unit order', () => {
    const units = 'V' + '/MΩ'.repeat(1200);
    expect(normalizeDuplicateSemanticText(`${units}: 10`)).toBe(`${units}: 10`);
    expect(hasDuplicateQuantityUnitPrefix(`${units}: `)).toBe(true);
  });
});
