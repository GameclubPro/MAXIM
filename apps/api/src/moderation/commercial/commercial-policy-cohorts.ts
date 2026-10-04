import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';

export const COMMERCIAL_INTENT_QUALITY_COHORT = 'commercial-intent-quality-v1' as const;
export const COMMERCIAL_INTENT_QUALITY_DECISION_VERSION = 'commercial-intent-quality-v1' as const;
// FLAG: Pin released cohorts separately from the promotion allowlist. Adding a rule or cohort
// cannot expand baseline deletion authority before its independent evidence gate has passed.
export const COMMERCIAL_TEXT_BASELINE_POLICY_COHORTS = [
  'owned-service-contrast-v1',
  'sliding-campaign-v1',
] as const;
export const COMMERCIAL_TEXT_POLICY_COHORTS = [
  ...COMMERCIAL_TEXT_BASELINE_POLICY_COHORTS,
  COMMERCIAL_INTENT_QUALITY_COHORT,
] as const;

export function commercialTextDecisionVersionForCohorts(cohorts: readonly string[]): string {
  return cohorts.includes(COMMERCIAL_INTENT_QUALITY_COHORT)
    ? COMMERCIAL_INTENT_QUALITY_DECISION_VERSION
    : COMMERCIAL_ENGINE_CONFIG.decisionVersion;
}
