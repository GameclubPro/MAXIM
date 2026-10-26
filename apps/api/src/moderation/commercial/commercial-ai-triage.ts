import type { RuleViolation } from '../rule-engine.contract';

export const COMMERCIAL_AI_TRIAGE_POLICY_VERSION = 'commercial-ai-triage-shadow-v1';

export type CommercialAiTriage = {
  route: 'NEEDS_AI';
  priority: 'suspected_ad' | 'normal';
  policyVersion: typeof COMMERCIAL_AI_TRIAGE_POLICY_VERSION;
  verification: 'unvalidated';
  signal: 'commercial_review' | 'commercial_rule' | 'commercial_language' | 'none';
};

// FLAG: Broad language is a scheduling hint, never a negative verdict or permission
// to delete. Buyer requests, quoted ads and ordinary discussion can match it too.
const COMMERCIAL_LANGUAGE =
  /(?:^|[^\p{L}\p{N}_])(?:услуг|прайс|скидк|акци[яюи]|заказ|запис|прода|доставк|ваканси|заработ|кредит|реклам|клиент|предлага[юе]|оказыва[юе]|изготавлива[юе])/iu;
const MAX_TRIAGE_TEXT_CHARS = 2500;

export function resolveCommercialAiTriage(input: {
  text: string;
  violations?: readonly Pick<RuleViolation, 'ruleCode' | 'metadata'>[];
}): CommercialAiTriage {
  const commercial = input.violations?.filter(
    (violation) => violation.ruleCode === 'COMMERCIAL_AD',
  );
  const signal: CommercialAiTriage['signal'] = commercial?.some(
    (violation) => violation.metadata?.reviewRecommended === true,
  )
    ? 'commercial_review'
    : commercial?.length
      ? 'commercial_rule'
      : COMMERCIAL_LANGUAGE.test(input.text.slice(0, MAX_TRIAGE_TEXT_CHARS))
        ? 'commercial_language'
        : 'none';

  // FLAG: No independently reviewed AI triage corpus currently authorizes a
  // VERIFIED_KEEP shortcut. Every eligible source still needs the model cascade.
  return {
    route: 'NEEDS_AI',
    priority: signal === 'none' ? 'normal' : 'suspected_ad',
    policyVersion: COMMERCIAL_AI_TRIAGE_POLICY_VERSION,
    verification: 'unvalidated',
    signal,
  };
}
