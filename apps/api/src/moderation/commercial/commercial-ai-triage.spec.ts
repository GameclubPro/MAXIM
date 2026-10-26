import type { RuleViolation } from '../rule-engine.contract';
import {
  COMMERCIAL_AI_TRIAGE_POLICY_VERSION,
  resolveCommercialAiTriage,
} from './commercial-ai-triage';

describe('commercial AI shadow triage', () => {
  it.each([
    'Доброе утро, соседи!',
    'Кто может помочь с ремонтом?',
    'Продам свой старый велосипед.',
    'Реклама в нашей группе запрещена.',
    'Предлагаем услуги ремонта, принимаем заказы.',
    '',
  ])('keeps the cascade required for every input including protected negatives: %s', (text) => {
    expect(resolveCommercialAiTriage({ text })).toMatchObject({
      route: 'NEEDS_AI',
      verification: 'unvalidated',
      policyVersion: COMMERCIAL_AI_TRIAGE_POLICY_VERSION,
    });
  });

  it('prioritizes the existing commercial review without changing its policy or metadata', () => {
    const metadata = Object.freeze({
      reviewRecommended: true,
      actionable: false,
      messageDisposition: 'KEEP',
      reasonCodes: Object.freeze(['unpromoted-policy:synthetic']),
    });
    const violation = Object.freeze({ ruleCode: 'COMMERCIAL_AD', metadata });
    expect(
      resolveCommercialAiTriage({ text: 'Спорный пример', violations: Object.freeze([violation]) }),
    ).toMatchObject({ priority: 'suspected_ad', signal: 'commercial_review', route: 'NEEDS_AI' });
    expect(metadata.messageDisposition).toBe('KEEP');
    expect(metadata.actionable).toBe(false);
  });

  it('prioritizes a known commercial rule without treating its score as model confidence', () => {
    const violations: RuleViolation[] = [
      { ruleCode: 'COMMERCIAL_AD', score: 0, reason: 'synthetic', metadata: { actionable: false } },
    ];
    expect(resolveCommercialAiTriage({ text: 'Спорный пример', violations })).toMatchObject({
      priority: 'suspected_ad',
      signal: 'commercial_rule',
      route: 'NEEDS_AI',
    });
  });

  it('accepts only the exact commercial rule and boolean review marker', () => {
    expect(
      resolveCommercialAiTriage({
        text: 'Добрый вечер',
        violations: [
          { ruleCode: 'COMMERCIAL_AD_suffix', metadata: { reviewRecommended: true } },
          { ruleCode: 'PROFANITY', metadata: { reviewRecommended: true } },
        ],
      }),
    ).toMatchObject({ priority: 'normal', signal: 'none' });
    expect(
      resolveCommercialAiTriage({
        text: 'Добрый вечер',
        violations: [{ ruleCode: 'COMMERCIAL_AD', metadata: { reviewRecommended: 'true' } }],
      }),
    ).toMatchObject({ priority: 'suspected_ad', signal: 'commercial_rule' });
  });

  it.each([
    'ГРУЗОПЕРЕВОЗКИ: доставка по городу.',
    'Есть скидка на услуги мастера.',
    'Ищу услуги мастера, пришлите прайс.',
    'В сообщении была реклама, это цитата.',
  ])('uses broad language only to prioritize, including buyer or quoted context: %s', (text) => {
    expect(resolveCommercialAiTriage({ text })).toMatchObject({
      priority: 'suspected_ad',
      signal: 'commercial_language',
      route: 'NEEDS_AI',
    });
  });

  it('returns only finite policy fields without text, contacts or arbitrary metadata', () => {
    const text = 'Предлагаю услуги. private-person@example.test';
    const triage = resolveCommercialAiTriage({
      text,
      violations: [
        {
          ruleCode: 'COMMERCIAL_AD',
          metadata: { rawText: text, reasonCodes: ['private-custom-reason'], contact: text },
        },
      ],
    });
    expect(triage).toEqual({
      route: 'NEEDS_AI',
      priority: 'suspected_ad',
      policyVersion: COMMERCIAL_AI_TRIAGE_POLICY_VERSION,
      verification: 'unvalidated',
      signal: 'commercial_rule',
    });
    expect(JSON.stringify(triage)).not.toMatch(/private-|@|rawText|reasonCodes/);
  });
});
