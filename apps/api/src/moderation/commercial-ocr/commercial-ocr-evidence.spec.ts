import { deriveCommercialOcrCriticalEvidence } from './commercial-ocr-evidence';

function wordsFor(text: string, confidences: readonly number[] = []) {
  return [...text.matchAll(/\S+/gu)].map((match, index) => ({
    text: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    confidencePermille: confidences[index] ?? 940,
  }));
}

describe('commercial OCR critical evidence', () => {
  it('extracts an offer anchor and canonical Russian phone with word confidence', () => {
    const text = 'Ремонт окон, звоните 8 999 123 45 67';
    const result = deriveCommercialOcrCriticalEvidence({
      text,
      words: wordsFor(text, [960, 950, 940, 930, 920, 910, 900]),
    });

    expect(result).toEqual(
      expect.arrayContaining([
        {
          kind: 'commercial_anchor',
          semanticKey: 'offer:services',
          confidencePermille: 960,
        },
        { kind: 'contact', semanticKey: 'phone:79991234567', confidencePermille: 900 },
        { kind: 'deal_channel', semanticKey: 'channel:response', confidencePermille: 940 },
      ]),
    );
  });

  it('produces stable semantic keys across formatting and inflection changes', () => {
    const primary = 'Ремонт окон. Телефон: +7 (999) 123-45-67. Цена 5 000 руб.';
    const confirmation = 'УСЛУГИ: ремонт окон +7 999 123 45 67 стоимость 5000 ₽';

    const primaryEvidence = deriveCommercialOcrCriticalEvidence({
      text: primary,
      words: wordsFor(primary),
    });
    const confirmationEvidence = deriveCommercialOcrCriticalEvidence({
      text: confirmation,
      words: wordsFor(confirmation),
    });

    const signature = (items: typeof primaryEvidence) =>
      items.map((item) => `${item.kind}:${item.semanticKey}`).sort();
    expect(signature(primaryEvidence)).toEqual(signature(confirmationEvidence));
  });

  it('uses only words that overlap an evidence range for confidence', () => {
    const text = 'Магазин мебели доставка по городу';
    const result = deriveCommercialOcrCriticalEvidence({
      text,
      words: wordsFor(text, [910, 100, 880, 120, 130]),
    });

    expect(result).toEqual(
      expect.arrayContaining([
        { kind: 'commercial_anchor', semanticKey: 'offer:retail', confidencePermille: 910 },
        {
          kind: 'transaction',
          semanticKey: 'transaction:fulfilment',
          confidencePermille: 880,
        },
      ]),
    );
  });

  it('normalizes domains and prices into bounded exact signatures', () => {
    const text = 'Акция магазина: example.COM, цена 12 500₽';
    const result = deriveCommercialOcrCriticalEvidence({ text, words: wordsFor(text) });

    expect(result).toEqual(
      expect.arrayContaining([
        { kind: 'contact', semanticKey: 'domain:example.com', confidencePermille: 940 },
        { kind: 'price', semanticKey: 'amount:12500:rub', confidencePermille: 940 },
      ]),
    );
  });

  it('omits evidence whose matched OCR text is not covered by word spans', () => {
    const text = 'Ремонт окон, звоните +7 999 123 45 67';
    const words = wordsFor(text).filter((word) => !word.text.startsWith('+7'));

    expect(deriveCommercialOcrCriticalEvidence({ text, words })).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'contact' })]),
    );
  });
});
