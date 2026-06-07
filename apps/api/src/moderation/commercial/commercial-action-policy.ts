import type { CommercialActionBand, CommercialEvidenceTier } from './commercial.types';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';

export type CommercialActionPolicyInput = {
  confidenceScore: number;
  deleteThreshold: number;
  warnThreshold: number;
  fpRisk: number;
  evidenceTier: CommercialEvidenceTier;
  reviewRecommended: boolean;
  hasCampaignContext: boolean;
  hasDirectDealEvidence: boolean;
  hasHighRiskEvidence: boolean;
};

export function resolveCommercialActionPolicy(input: CommercialActionPolicyInput): CommercialActionBand {
  if (input.confidenceScore < input.warnThreshold) {
    return 'ALLOW';
  }

  if (input.confidenceScore >= input.deleteThreshold && input.hasHighRiskEvidence) {
    return 'DELETE_AND_ESCALATE';
  }

  const campaignOnly = input.hasCampaignContext && !input.hasDirectDealEvidence;
  if (campaignOnly) {
    return input.reviewRecommended ? 'REVIEW_ONLY' : 'WARN';
  }

  if (
    input.fpRisk >= COMMERCIAL_ENGINE_CONFIG.actionPolicy.highFpRiskThreshold &&
    !input.hasHighRiskEvidence
  ) {
    return input.reviewRecommended ? 'REVIEW_ONLY' : 'WARN';
  }

  if (input.confidenceScore >= input.deleteThreshold) {
    if (input.evidenceTier === 'DIRECT' || input.hasDirectDealEvidence) {
      return 'DELETE';
    }
    return input.reviewRecommended ? 'REVIEW_ONLY' : 'WARN';
  }

  return input.reviewRecommended ? 'REVIEW_ONLY' : 'WARN';
}
