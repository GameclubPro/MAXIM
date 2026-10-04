import {
  extractDuplicatePhoneNumbers,
  stripDuplicatePhoneNumbers,
} from './duplicate-phone-evidence';
import { extractDetectedPhoneNumbers } from './rule-engine-message-limits.detector';

describe('conservative phone evidence for duplicates', () => {
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
    ['Позвоните +12025550123', '12025550123'],
  ])('recognizes true phone evidence in %s', (text, phone) => {
    expect(extractDuplicatePhoneNumbers(text)).toEqual([phone]);
    expect(stripDuplicatePhoneNumbers(text)).not.toBe(text);
  });

  it('preserves labels and order IDs while removing multiple independent phones', () => {
    const text = 'Заказ 1234567890. A+7 (999) 123-45-67, B+7 (999) 123-45-68';
    expect(extractDuplicatePhoneNumbers(text)).toEqual(['79991234567', '79991234568']);
    expect(stripDuplicatePhoneNumbers(text)).toBe('Заказ 1234567890. A , B ');
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

  it('keeps the separate phone blocking policy unchanged', () => {
    const text = 'Номер заказа 1234567890 для получения оборудования';
    expect(extractDetectedPhoneNumbers(text)).toEqual(['1234567890']);
    expect(extractDuplicatePhoneNumbers(text)).toEqual([]);
  });
});
