import { assertCommercialOcrWorkerSmokeText } from './smoke-commercial-ocr-worker';

describe('assertCommercialOcrWorkerSmokeText', () => {
  const completeResult = 'РЕМОНТ КВАРТИР\nREPAIR SERVICE\nЗВОНИТЕ +7 (999) 123-45-67';

  it('requires Cyrillic, Latin, call-to-action, and phone recognition together', () => {
    expect(() => assertCommercialOcrWorkerSmokeText(completeResult)).not.toThrow();

    for (const incompleteResult of [
      'REPAIR SERVICE\nЗВОНИТЕ +7 (999) 123-45-67',
      'РЕМОНТ КВАРТИР\nЗВОНИТЕ +7 (999) 123-45-67',
      'РЕМОНТ КВАРТИР\nREPAIR SERVICE\n+7 (999) 123-45-67',
      'РЕМОНТ КВАРТИР\nREPAIR SERVICE\nЗВОНИТЕ +7 (999) 123-45-66',
    ]) {
      expect(() => assertCommercialOcrWorkerSmokeText(incompleteResult)).toThrow(
        'Commercial OCR worker smoke did not recognize the expected opaque fixture',
      );
    }
  });
});
