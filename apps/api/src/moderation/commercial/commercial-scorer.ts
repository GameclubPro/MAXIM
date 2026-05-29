import { estimateCommercialFpRisk } from './commercial-explain';
import { isCommercialDeleteAction } from './commercial-subtypes';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import type { CommercialActionBand, CommercialEvidenceTier } from './commercial.types';

export { estimateCommercialFpRisk };

export function canCommercialActionDelete(params: {
  actionBand: CommercialActionBand | string | null;
  evidenceTier: CommercialEvidenceTier | string | null;
  hasHighRiskEvidence: boolean;
  hasDirectDealEvidence: boolean;
  fpRisk: number | null;
}): boolean {
  if (!isCommercialDeleteAction(params.actionBand)) {
    return false;
  }

  if (params.hasHighRiskEvidence) {
    return true;
  }

  if (params.fpRisk !== null && params.fpRisk >= 70) {
    return false;
  }

  return params.evidenceTier === 'DIRECT' && params.hasDirectDealEvidence;
}

export function sigmoid(value: number): number {
  if (value >= 0) {
    const exponent = Math.exp(-value);
    return 1 / (1 + exponent);
  }

  const exponent = Math.exp(value);
  return exponent / (1 + exponent);
}

export function countPatternMatches(
  value: string,
  pattern: RegExp,
  limit: number = COMMERCIAL_ENGINE_CONFIG.secondStage.countLimits.defaultPatternMatches,
): number {
  if (!value || limit <= 0) {
    return 0;
  }

  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  let count = 0;

  while (count < limit && matcher.exec(value)) {
    count += 1;
  }

  return count;
}
