import {
  analyzeDuplicatePhoneNumbers,
  extractDuplicatePhoneNumbers,
  stripAnalyzedDuplicatePhoneNumbers,
  stripDuplicatePhoneNumbers,
} from './duplicate-phone-evidence';
import { extractDetectedPhoneNumbers } from './rule-engine-message-limits.detector';

describe('conservative phone evidence for duplicates', () => {
  it.each([
    `+79991234567${' '.repeat(65)}рублей`,
    `+79991234567${'\u200b'.repeat(65)}@example.test`,
    `+79991234567${')'.repeat(65)}рублей`,
    `+79991234567${' '.repeat(40)}×${' '.repeat(40)}2`,
    `$${'('.repeat(129)}+79991234567`,
    `tel:${'\u200b'.repeat(129)}+79991234567`,
    `@${'\u200b'.repeat(129)}+79991234567`,
    `Модель ${'А'.repeat(140)} телефон: +79991234567`,
    `Телефон: +79991234567 +44${' '.repeat(48)}2079460958000`,
    'Выражение x – +79991234567',
    'Телефон: +79991234567 – x',
    '+79991234567: 1000',
    'Телефон: +79991234567 : x',
    `+79991234567:${' '.repeat(65)}рублей`,
  ])('preserves evidence hidden beyond a bounded context in %s', (text) => {
    expect(extractDuplicatePhoneNumbers(text)).toEqual([]);
    expect(stripDuplicatePhoneNumbers(text)).toBe(text);
  });

  it.each(['\u00a0', '\u202f', '\u2010', '\u2011', '\u2012', '\u2013'])(
    'accepts a finite labelled known-length phone with separator %j',
    (separator) => {
      const phone = `+7${separator}999${separator}123${separator}45${separator}67`;
      expect(extractDuplicatePhoneNumbers(`Телефон: ${phone}`)).toEqual(['79991234567']);
      expect(stripDuplicatePhoneNumbers(`Телефон: ${phone}`)).toBe('Телефон:  ');
      expect(extractDuplicatePhoneNumbers(phone)).toEqual([]);
      expect(extractDuplicatePhoneNumbers(`Модель телефона: ${phone}`)).toEqual([]);
      expect(extractDuplicatePhoneNumbers(`Телефон: ${phone} рублей`)).toEqual([]);
    },
  );

  it('reuses original URL and phone spans without joining unrelated numeric fragments', () => {
    const text =
      'Телефон: +79991234567. Значения +7999 https://example.test/\u200bOffer?id=1234567 1234567 пользователей';
    const analysis = analyzeDuplicatePhoneNumbers(text);
    expect(analysis.phoneNumbers).toEqual(['79991234567']);
    expect(analysis.urlValues).toEqual(['https://example.test/Offer?id=1234567']);
    expect(stripAnalyzedDuplicatePhoneNumbers(text, analysis)).toBe(
      'Телефон:  . Значения +7999 https://example.test/\u200bOffer?id=1234567 1234567 пользователей',
    );
    expect(
      stripAnalyzedDuplicatePhoneNumbers(text, analysis, { ignorePhones: true, ignoreLinks: true }),
    ).toBe('Телефон:  . Значения +7999   1234567 пользователей');
  });

  it.each([
    [false, false, 'Телефон:+79991234567 https://example.test/Offer'],
    [true, false, 'Телефон:  https://example.test/Offer'],
    [false, true, 'Телефон:+79991234567  '],
    [true, true, 'Телефон:   '],
  ])('independently ignores phones=%s and links=%s', (ignorePhones, ignoreLinks, expected) => {
    const text = 'Телефон:+79991234567 https://example.test/Offer';
    expect(
      stripAnalyzedDuplicatePhoneNumbers(text, analyzeDuplicatePhoneNumbers(text), {
        ignorePhones: ignorePhones as boolean,
        ignoreLinks: ignoreLinks as boolean,
      }),
    ).toBe(expected);
  });

  it.each([
    'Номер заказа 1234567890 для получения оборудования',
    'Артикул 9123456789 доступен для покупки',
    'Артикул (999-123-45-67) доступен для покупки',
    'Номер заказа №(123-456-78-90) подтвержден',
    'Артикул нового оборудования для нашего каталога (999-123-45-67) доступен',
    'Номер заказа нового промышленного оборудования для нашего склада №[(123-456-78-90)] подтвержден',
    'Стоимость выбранного промышленного оборудования для нового большого предприятия (+9000000000) согласована',
    'Диапазон значений для нового оборудования в нашем каталоге №[(999-123-45-67)]',
    'SKU [999-123-45-67] available',
    'Recall 1234567890 подтвержден',
    'Цена (9000000000) рублей с доставкой',
    'ИНН 9123456789 проверен',
    'Номер счета +1234567890 подтвержден',
    'Цена 9000000000 рублей с доставкой',
    'Стоимость предприятия 9100000000 рублей',
    'Оплата +9000000000 USD',
    'Масса оборудования 9000000000 кг',
    'Расстояние 9000000000 метров',
    'Температура +1234567890 градусов',
    'Размер 9000000000 мм',
    'Скидка 9000000000%',
    'Order number 1234567890 available today',
    'Invoice 123-456-78-90 confirmed',
    'Account number 1234567890 confirmed',
    'Дата 22.09.2026 и диапазон 100-200-300',
    'Необозначенное значение 9123456789',
    'Серия (999-123-45-67) доступна для заказа',
    'Модель (999-123-45-67) доступна для заказа',
    'Версия (999-123-45-67) доступна для заказа',
    '(999-123-45-67) доступна для заказа',
    'Доставка 8 (999) 123-45-67',
    'Контакт 999-123-45-67',
    'Продаю модель ABC+79991234567Z в рабочем состоянии',
    'ABC+79991234567',
    '+79991234567Z',
    'ABC-+79991234567',
    '+79991234567-ABC',
    'ABC:+79991234567',
    '+79991234567/ABC',
    'ABC.+79991234567',
    '+79991234567.ABC',
    '_+79991234567',
    '+79991234567_',
    'ABC[(+79991234567)]',
    '[(+79991234567)]Z',
    'ABC«+79991234567»',
    '«+79991234567»Z',
    'Γ+79991234567',
    '+79991234567ع',
    '٢+79991234567',
    '+79991234567٢',
    'e\u0301+79991234567',
    '+79991234567\u0301',
    'ABC\u200b+79991234567',
    '+79991234567\u200bZ',
    'Номер заказа ABC+79991234567Z подтвержден',
    'SKU ABC(+79991234567) доступен',
    'Документ ABC:+79991234567 опубликован',
    'Код ABC/+79991234567 опубликован',
    'SKU.Phone+79991234567',
    'Телефон:+79991234567Z',
    'Телефон(+79991234567)-ABC',
    'x+12345678901',
    '2*+12345678901',
    '+12345678901*x',
    '+12345678901/2',
    'x = +79991234567',
    '2 +79991234567',
    'x +79991234567',
    'Телефон +79991234567 +79991234568 1000',
    'Телефон +79991234567 +44 20 7946 0958 100',
    'Выражение +79991234567 +79991234568',
    ...[
      '^',
      '×',
      '÷',
      '⋅',
      '·',
      '+',
      '＋',
      '<',
      '>',
      '＜',
      '≤',
      '≥',
      '≠',
      '≈',
      '=',
      '/',
      '*',
      '%',
      '-',
      '−',
    ].flatMap((operator) => [
      `Выражение z ${operator} +79991234567`,
      `Выражение z ${operator} (+79991234567)`,
      `Выражение +79991234567 ${operator} 2`,
      `Телефон (+79991234567) ${operator} 2`,
    ]),
    ...['₽', '$', '€', '£', '¥'].flatMap((currency) => [
      `Итого ${currency}+79991234567`,
      `Итого ${currency} +79991234567`,
      `Итого ${currency} (+79991234567)`,
    ]),
    ...[
      'тыс.',
      'тысяч рублей',
      'человек',
      'участников',
      'штук',
      'байт',
      'кБ',
      'МБ',
      'ГБ',
      'т',
      'kB',
      'MB',
      'GiB',
      'bytes',
      'bps',
      'Mbps',
      'participants',
    ].map((unit) => `Подтверждено +79991234567 ${unit}`),
    'Баланс проекта на конец квартала составил +79991234567',
    'Остаток на конец квартала составил +79991234567',
    'Наличие денежных средств +79991234567',
    ...['\u200b', '\u200e', '\u200f', '\u061c', '\u2066', '\u2069'].flatMap((format) => [
      `Итого $${format}+79991234567`,
      `Итого €${format} +79991234567`,
      `Итого +79991234567 ${format}₽`,
      `Выражение z ×${format} (+79991234567)`,
      `Выражение +79991234567 ${format}× 2`,
      `Выражение x${format} +79991234567`,
      `Выражение 2${format} +79991234567`,
      `Артикул ${format}телефона: +79991234567`,
      `Прирост +79991234567 ${format}bps`,
    ]),
    ...['Артикул', 'Код', 'Заказ', 'Идентификатор', 'Номер заказа'].map(
      (label) => `${label} телефона: +79991234567`,
    ),
    ...['Телефон', 'Phone', 'Позвоните', 'Модель телефона', 'Сертификат телефона'].flatMap(
      (label) =>
        ['4601234567890', '5601234567890', '442079460958', '5551234567'].map(
          (value) => `${label}: ${value}`,
        ),
    ),
    ...[
      'Модель',
      'Модели',
      'Моделью',
      'Моделей',
      'Моделям',
      'Моделями',
      'Моделях',
      'Сертификат',
      'Сертификата',
      'Сертификаты',
      'Сертификатов',
      'Штрихкод',
      'Штрих-код',
      'Штрих код',
      'Штрихкоды',
      'Штрихкодов',
      'Model',
      'Certificate',
      'Barcode',
      'IMEI',
      'EAN',
      'GTIN',
    ].flatMap((label) =>
      ['79991234567', '89991234567', '9991234567', '+79991234567', '+442079460958'].map(
        (value) => `${label} телефона: ${value}`,
      ),
    ),
    ...[
      '+44 20 7946 0958',
      '+44 20 7946 0958 100',
      '+44-20-7946-0958-100',
      '+44.20.7946.0958',
      '+49 (30) 12345678 100',
      '555-123-4567 100',
      '555-123-4567',
    ].map((span) => `Телефон: ${span}`),
    ...[
      '+799912345.67',
      '+7999.1234567',
      '+79.991.234.567',
      '+7.99.912.345.67',
      '799912345.67',
    ].map((span) => `Погрешность ${span}`),
    ...['Номера', 'Коды', 'Идентификаторы', 'Артикулы'].map(
      (label) => `${label} +79991234567 опубликованы`,
    ),
    ...[
      'https://example.test/+79991234567',
      'https://example.test/?phone=+79991234567',
      'example.test/+79991234567',
      'https://example.test/#phone=+79991234567',
      'https://example.test/\u200b+79991234567',
      '+79991234567@example.test',
      'user+79991234567@example.test',
      '@+79991234567',
      '+79991234567@',
      'tel:+79991234567',
      'tel:(+79991234567)',
      'mailto:+79991234567@example.test',
      'sms:+79991234567',
    ],
    ...[
      '+79991234567',
      '+12025550123',
      '79991234567',
      '19991234567',
      '89991234567',
      '999-123-45-67',
    ].map((phone) => `Телефон ${phone} 1000`),
    ...[
      'Телевизор',
      'Тележка',
      'Телескоп',
      'Телефонограмма',
      'Телефония',
      'Мобильность',
      'Мобильный',
      'Мобильник',
      'Звонок',
      'Звонки',
      'Звонарь',
      'Phonebook',
      'Mobile',
      'Whatsappify',
      'Ватсапный',
      'Viberbox',
      'Вайберный',
    ].map((label) => `${label} 999-123-45-67 продаётся с подробным описанием`),
    '+00000000000 доступно',
  ])('preserves the numeric meaning of %s', (text) => {
    expect(extractDuplicatePhoneNumbers(text)).toEqual([]);
    expect(stripDuplicatePhoneNumbers(text)).toBe(text);
  });

  it.each([
    ['Телефон: 9123456789', '79123456789'],
    ['Номер телефона 89991234567', '79991234567'],
    ['Телефон для связи: 89991234567', '79991234567'],
    ['Phone: 12025550123', '12025550123'],
    ['Телефон: (9123456789)', '79123456789'],
    ['Код товара известен, телефон: +7 (999) 123-45-67', '79991234567'],
    ['Связаться +7 (999) 123-45-67', '79991234567'],
    ['Телефон 8 (999) 123-45-67', '79991234567'],
    ['Телефон 999-123-45-67', '79991234567'],
    ...[
      'Телефона',
      'Телефону',
      'Телефоном',
      'Телефоне',
      'Телефоны',
      'Телефонов',
      'Телефонам',
      'Телефонами',
      'Телефонах',
      'Тел.',
      'Позвоните',
      'Звоните',
      'Позвони',
      'Звони',
      'Позвонить',
      'Звонить',
      'WhatsApp',
      'Ватсап',
      'Viber',
      'Вайбер',
      'Telephone',
      'Call',
    ].map((label) => [`${label}: 999-123-45-67`, '79991234567']),
    ['Доставка +7 (999) 123-45-67', '79991234567'],
    ['Связаться +80011122233', '80011122233'],
    ['Телефон +7.999.123.45.67', '79991234567'],
    ['Телефон +7.999.123.4567', '79991234567'],
    ['Телефон 999.123.45.67', '79991234567'],
    ['Телефон +1.202.555.0123', '12025550123'],
    ['Телефон: +442079460958', '442079460958'],
    ['Телефон: +4601234567890', '4601234567890'],
    ['Позвоните +12025550123', '12025550123'],
    ['+79991234567', '79991234567'],
    ['(+79991234567)', '79991234567'],
    ['Связаться «+79991234567»', '79991234567'],
    ['Тел+79991234567', '79991234567'],
    ['Тел.:+79991234567', '79991234567'],
    ['Телефон(+79991234567)', '79991234567'],
    ['Телефон=+79991234567', '79991234567'],
    ['Телефон = +79991234567', '79991234567'],
    ['Телефон = (+79991234567)', '79991234567'],
    ['Телефон 79991234567', '79991234567'],
    ['Phone 19991234567', '19991234567'],
    ['Номера телефонов +79991234567', '79991234567'],
  ])('recognizes true phone evidence in %s', (text, phone) => {
    expect(extractDuplicatePhoneNumbers(text)).toEqual([phone]);
    expect(stripDuplicatePhoneNumbers(text)).not.toBe(text);
  });

  it('preserves labels and order IDs while removing multiple independent phones', () => {
    const text = 'Заказ 1234567890. Телефон:+7 (999) 123-45-67, телефон:+7 (999) 123-45-68';
    expect(extractDuplicatePhoneNumbers(text)).toEqual(['79991234567', '79991234568']);
    expect(stripDuplicatePhoneNumbers(text)).toBe('Заказ 1234567890. Телефон: , телефон: ');
  });

  it.each([' ', '\n'])('preserves URL bytes and finds a separate phone across %j', (separator) => {
    const url = 'https://example.test/?phone=+79991234567';
    const text = `${url}${separator}Телефон:+79991234568`;
    expect(extractDuplicatePhoneNumbers(text)).toEqual(['79991234568']);
    expect(stripDuplicatePhoneNumbers(text)).toBe(`${url}${separator}Телефон: `);
  });

  it.each(['. ', '.\t', '\n'])('keeps the numeric phrase after a phone across %j', (separator) => {
    const text = `Телефон: +7 (999) 123-45-67${separator}100 участников`;
    expect(extractDuplicatePhoneNumbers(text)).toEqual(['79991234567']);
    expect(stripDuplicatePhoneNumbers(text)).toContain(`${separator}100 участников`);
  });

  it.each([' ', '\n'])('keeps adjacent international phones separate across %j', (separator) => {
    const text = `Телефон: +7 (999) 123-45-67${separator}+7 (999) 123-45-68`;
    expect(extractDuplicatePhoneNumbers(text)).toEqual(['79991234567', '79991234568']);
    expect(stripDuplicatePhoneNumbers(text)).not.toContain('123-45');
  });

  it('keeps a finite-labelled compact phone list independently verified', () => {
    const text = 'Телефон: +79991234567 +79991234568';
    expect(extractDuplicatePhoneNumbers(text)).toEqual(['79991234567', '79991234568']);
    expect(stripDuplicatePhoneNumbers(text)).not.toContain('7999');
  });

  it('keeps the separate phone blocking policy unchanged', () => {
    const text = 'Номер заказа 1234567890 для получения оборудования';
    expect(extractDetectedPhoneNumbers(text)).toEqual(['1234567890']);
    expect(extractDuplicatePhoneNumbers(text)).toEqual([]);
  });
});
