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
  hasNonCampaignDirectDealEvidence: boolean;
  hasHighRiskEvidence: boolean;
  hasEscalationRiskEvidence: boolean;
};

export function resolveCommercialActionPolicy(
  input: CommercialActionPolicyInput,
): CommercialActionBand {
  if (input.confidenceScore < input.warnThreshold) {
    return 'ALLOW';
  }

  const campaignOnly = input.hasCampaignContext && !input.hasNonCampaignDirectDealEvidence;
  if (campaignOnly) {
    return input.reviewRecommended ? 'REVIEW_ONLY' : 'WARN';
  }

  if (input.confidenceScore >= input.deleteThreshold && input.hasEscalationRiskEvidence) {
    return 'DELETE_AND_ESCALATE';
  }

  if (
    input.fpRisk >= COMMERCIAL_ENGINE_CONFIG.actionPolicy.highFpRiskThreshold &&
    !input.hasHighRiskEvidence
  ) {
    return input.reviewRecommended ? 'REVIEW_ONLY' : 'WARN';
  }

  if (input.confidenceScore >= input.deleteThreshold) {
    if (input.hasDirectDealEvidence) {
      return 'DELETE';
    }
    return input.reviewRecommended ? 'REVIEW_ONLY' : 'WARN';
  }

  return input.reviewRecommended ? 'REVIEW_ONLY' : 'WARN';
}
