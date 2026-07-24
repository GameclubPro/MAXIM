import {
  isCommercialCorpusTextSanitized,
  sanitizeCommercialCorpusText,
} from './commercial-corpus-sanitization.util';

describe('commercial corpus sanitization', () => {
  it.each([
    ['Телефон 999.123.45.67', 'Телефон [phone]'],
    ['Телефон +7 (999).123.45.67', 'Телефон [phone]'],
    ['Телефон +49 30 12345678', 'Телефон [phone]'],
    ['Связь +1 (415) 555-2671', 'Связь [phone]'],
    ['E.164 +447911123456', 'E.164 [phone]'],
    ['Связь +1🟢415🟢555🟢2671', 'Связь [phone]'],
    ['Телефон +44🟢7911🟢123456', 'Телефон [phone]'],
    ['Телефон 79991234567', 'Телефон [phone]'],
    ['Телефон 7️⃣9️⃣9️⃣9️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣', 'Телефон [phone]'],
    ['Связь +7🟢999🟢123🟢45🟢67', 'Связь [phone]'],
    ['ТЕЛЕФОНУ📱☎️ 🐤7🐥9🐥9🐥9🐥1🐥2🐥3🐥4🐥5🐥6🐥7🐤', 'ТЕЛЕФОНУ📱☎️ 🐤[phone]🐤'],
    ['Тел. 8•999•123•45•67', 'Тел. [phone]'],
    ['Тел. 8|999|123|45|67', 'Тел. [phone]'],
    ['Телефон • 7•9•9•9•1•2•3•4•5•6•7', 'Телефон • [phone]'],
    ['Телефон | 7|9|9|9|1|2|3|4|5|6|7', 'Телефон | [phone]'],
    ['7|9|9|9|1|2|3|4|5|6|7 | телефон', '[phone] | телефон'],
    ['Тел. 12-34-56', 'Тел. [phone]'],
    ['12-34-56 (телефон)', '[phone] (телефон)'],
    ['Карта 2202.2002.0000.0001', 'Карта [card]'],
    ['PAN 1234567890123', 'PAN [card]'],
    ['Расчётный счёт 40702 810 1 0000 0000000', 'Расчётный счёт [account]'],
    ['40702810100000000001, р/с', '[account], р/с'],
    ['Счёт: 12345678901234567890', 'Счёт: [account]'],
    ['Сайт www.example.com/catalog', 'Сайт [url]'],
    ['Сайт offers.example.ru/catalog?q=1', 'Сайт [url]'],
    ['Профиль max://user/123456', 'Профиль [url]'],
    ['Почта sales@example.ru', 'Почта [email]'],
    ['Почта продажи@пример.рф', 'Почта [email]'],
    ['Почта support@xn--e1afmkfd.xn--p1ai', 'Почта [email]'],
    ['Почта χρήστης@παράδειγμα.ελ', 'Почта [email]'],
    ['Напишите @example_user', 'Напишите @[handle]'],
  ])('redacts private contact data in %s', (input, expected) => {
    expect(sanitizeCommercialCorpusText(input)).toBe(expected);
    expect(isCommercialCorpusTextSanitized(input)).toBe(false);
    expect(isCommercialCorpusTextSanitized(expected)).toBe(true);
  });

  it('preserves dotted prose and common local filenames', () => {
    expect(sanitizeCommercialCorpusText('Версия 1.2, файл report.pdf')).toBe(
      'Версия 1.2, файл report.pdf',
    );
  });

  it.each([
    'Размеры коробки 12-34-56 см',
    'Заказ 1234567890 уже выдан',
    'Заказ 71234567890 уже выдан',
    'ИНН 1234567890123',
    'ОГРН 123456789012345',
    'Код партии 12345678901234567890',
    'Размеры 8|10|20',
    'Маркировка 7🟢999🟢123🟢45🟢67 относится к партии',
    'Маркировка 7️⃣9️⃣9️⃣9️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣ относится к партии',
    'Код партии 8•999•123•45•67',
    'Код партии 8|999|123|45|67',
    'Маркировка +1🟢415🟢555🟢2671 относится к партии',
    'Телефон 1🟢415🟢555🟢2671',
    'Телефон +0🟢415🟢555🟢2671',
    'Телефон +1🟢234🟢56',
    'Телефон +1🟢234🟢567🟢890🟢123🟢456',
    'Диапазон +123456 единиц',
    'Адрес сети 192.168.10.20',
  ])('preserves an ambiguous non-contact number in %s', (input) => {
    expect(sanitizeCommercialCorpusText(input)).toBe(input);
    expect(isCommercialCorpusTextSanitized(input)).toBe(true);
  });

  it('is idempotent across residual phone families', () => {
    const input =
      'Телефон 79991234567 | Телефон 7️⃣9️⃣9️⃣9️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣ • Телефон | 7|9|9|9|1|2|3|4|5|6|7 • Связь +7🟢999🟢123🟢45🟢67 • Связь +1🟢415🟢555🟢2671 • Телефон +44🟢7911🟢123456';
    const sanitized = sanitizeCommercialCorpusText(input);

    expect(sanitized).toBe(
      'Телефон [phone] | Телефон [phone] • Телефон | [phone] • Связь [phone] • Связь [phone] • Телефон [phone]',
    );
    expect(sanitizeCommercialCorpusText(sanitized)).toBe(sanitized);
    expect(isCommercialCorpusTextSanitized(sanitized)).toBe(true);
  });
});
