import type { CommercialSubtype } from '../rule-engine.contract';
import type { CommercialCampaignStrength } from './commercial-campaign';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import type { CommercialSafeContextBucket } from './commercial-safe-context';
import { getCommercialSubtypePolicy } from './commercial-subtypes';
import type {
  CommercialActionBand,
  CommercialActionPolicyDecision,
  CommercialEvidenceTier,
  CommercialFeatureVector,
  CommercialRequiredAnchor,
  CommercialReviewPriority,
} from './commercial.types';

export type CommercialActionPolicyInput = {
  confidenceScore: number;
  deleteThreshold: number;
  warnThreshold: number;
  fpRisk: number;
  evidenceTier: CommercialEvidenceTier;
  subtype: CommercialSubtype;
  reviewRecommended: boolean;
  reviewReasons: readonly string[];
  missingRequiredAnchors: readonly CommercialRequiredAnchor[];
  featureVector: CommercialFeatureVector;
  safeContextBucket: CommercialSafeContextBucket;
  campaignStrength: CommercialCampaignStrength;
  hasCampaignContext: boolean;
  hasDirectDealEvidence: boolean;
  hasNonCampaignDirectDealEvidence: boolean;
  hasHighRiskEvidence: boolean;
  hasEscalationRiskEvidence: boolean;
  hasLocalEscalationOfferEvidence: boolean;
  hasStructuredTransportEvidence: boolean;
  hasReviewOnlyTransportEvidence: boolean;
  hasWarnCappedRecallEvidence?: boolean;
  hasReviewCappedRecallEvidence?: boolean;
  hasConservativeRecallEvidence: boolean;
  hasIndependentCommercialOfferEvidence: boolean;
};

export function resolveCommercialActionPolicy(
  input: CommercialActionPolicyInput,
): CommercialActionPolicyDecision {
  const suppressionReasons: string[] = [];
  const actionScore = resolveCommercialActionScore(input);
  const hasIndependentDeleteEligibleOffer =
    input.hasIndependentCommercialOfferEvidence &&
    input.hasNonCampaignDirectDealEvidence &&
    input.hasDirectDealEvidence &&
    input.confidenceScore >= input.deleteThreshold &&
    actionScore >= input.deleteThreshold &&
    input.fpRisk < COMMERCIAL_ENGINE_CONFIG.actionPolicy.highFpRiskThreshold &&
    input.missingRequiredAnchors.length === 0 &&
    !shouldSuppressDeleteForSafeContext(input) &&
    !shouldSuppressDeleteForSubtype(input);
  const reviewPriority = resolveCommercialReviewPriority({
    ...input,
    actionScore,
  });
  const reviewOrWarn =
    input.reviewRecommended || reviewPriority === 'HIGH' || reviewPriority === 'URGENT'
      ? 'REVIEW_ONLY'
      : 'WARN';

  if (
    input.hasReviewOnlyTransportEvidence &&
    input.confidenceScore < input.warnThreshold &&
    !input.hasStructuredTransportEvidence &&
    !input.hasConservativeRecallEvidence &&
    !input.hasIndependentCommercialOfferEvidence &&
    !input.hasEscalationRiskEvidence
  ) {
    suppressionReasons.push('ambiguous-transport-review-only');
    return buildDecision({
      actionBand: 'REVIEW_ONLY',
      confidenceScore: input.confidenceScore,
      actionScore,
      reviewPriority,
      suppressionReasons,
    });
  }

  if (input.confidenceScore < input.warnThreshold) {
    return buildDecision({
      actionBand: 'ALLOW',
      confidenceScore: input.confidenceScore,
      actionScore,
      reviewPriority: 'NONE',
      suppressionReasons,
    });
  }

  if (input.hasEscalationRiskEvidence && !input.hasLocalEscalationOfferEvidence) {
    suppressionReasons.push('non-local-escalation-offer');
    return buildDecision({
      actionBand:
        input.hasIndependentCommercialOfferEvidence && input.hasNonCampaignDirectDealEvidence
          ? 'WARN'
          : 'REVIEW_ONLY',
      confidenceScore: input.confidenceScore,
      actionScore,
      reviewPriority:
        input.hasIndependentCommercialOfferEvidence && input.hasNonCampaignDirectDealEvidence
          ? 'LOW'
          : reviewPriority === 'NONE'
            ? 'HIGH'
            : reviewPriority,
      suppressionReasons,
    });
  }

  if (
    input.hasWarnCappedRecallEvidence &&
    !hasIndependentDeleteEligibleOffer &&
    !input.hasEscalationRiskEvidence
  ) {
    suppressionReasons.push('bounded-recall-warn-cap');
    return buildDecision({
      actionBand: 'WARN',
      confidenceScore: input.confidenceScore,
      actionScore,
      reviewPriority,
      suppressionReasons,
    });
  }

  if (
    input.hasReviewCappedRecallEvidence &&
    !hasIndependentDeleteEligibleOffer &&
    !input.hasEscalationRiskEvidence
  ) {
    suppressionReasons.push('bounded-recall-review-cap');
    return buildDecision({
      actionBand: 'REVIEW_ONLY',
      confidenceScore: input.confidenceScore,
      actionScore,
      reviewPriority: reviewPriority === 'NONE' ? 'MEDIUM' : reviewPriority,
      suppressionReasons,
    });
  }

  if (
    input.hasConservativeRecallEvidence &&
    !input.hasIndependentCommercialOfferEvidence &&
    !input.hasEscalationRiskEvidence
  ) {
    suppressionReasons.push('conservative-recall-warn-cap');
    return buildDecision({
      actionBand: 'WARN',
      confidenceScore: input.confidenceScore,
      actionScore,
      reviewPriority,
      suppressionReasons,
    });
  }

  if (
    input.subtype === 'SERVICES' &&
    input.reviewReasons.includes('organized-wellness-trip') &&
    !input.hasEscalationRiskEvidence
  ) {
    return buildDecision({
      actionBand: 'WARN',
      confidenceScore: input.confidenceScore,
      actionScore,
      reviewPriority,
      suppressionReasons,
    });
  }

  const campaignOnly = input.hasCampaignContext && !input.hasNonCampaignDirectDealEvidence;
  if (campaignOnly) {
    suppressionReasons.push('campaign-only');
    return buildDecision({
      actionBand: reviewOrWarn,
      confidenceScore: input.confidenceScore,
      actionScore,
      reviewPriority,
      suppressionReasons,
    });
  }

  if (input.missingRequiredAnchors.length > 0) {
    suppressionReasons.push('missing-subtype-anchor');
  }

  const safeContextDeleteSuppressed = shouldSuppressDeleteForSafeContext(input);
  if (safeContextDeleteSuppressed) {
    suppressionReasons.push(`safe-context:${input.safeContextBucket}`);
  }

  const subtypeDeleteSuppressed = shouldSuppressDeleteForSubtype(input);
  if (subtypeDeleteSuppressed) {
    suppressionReasons.push(`subtype-policy:${input.subtype}`);
  }

  if (
    input.confidenceScore >= input.deleteThreshold &&
    actionScore >= input.deleteThreshold &&
    input.hasEscalationRiskEvidence &&
    input.hasLocalEscalationOfferEvidence &&
    !safeContextDeleteSuppressed &&
    input.missingRequiredAnchors.length === 0
  ) {
    return buildDecision({
      actionBand: 'DELETE_AND_ESCALATE',
      confidenceScore: input.confidenceScore,
      actionScore,
      reviewPriority: 'URGENT',
      suppressionReasons,
    });
  }

  if (
    input.fpRisk >= COMMERCIAL_ENGINE_CONFIG.actionPolicy.highFpRiskThreshold &&
    !input.hasEscalationRiskEvidence
  ) {
    suppressionReasons.push('high-fp-risk');
    return buildDecision({
      actionBand: safeContextDeleteSuppressed
        ? 'REVIEW_ONLY'
        : input.reviewRecommended
          ? 'REVIEW_ONLY'
          : 'WARN',
      confidenceScore: input.confidenceScore,
      actionScore,
      reviewPriority,
      suppressionReasons,
    });
  }

  if (safeContextDeleteSuppressed) {
    return buildDecision({
      actionBand: 'REVIEW_ONLY',
      confidenceScore: input.confidenceScore,
      actionScore,
      reviewPriority,
      suppressionReasons,
    });
  }

  if (
    input.hasStructuredTransportEvidence &&
    !input.hasIndependentCommercialOfferEvidence &&
    !input.hasEscalationRiskEvidence
  ) {
    suppressionReasons.push('structured-transport-warn-cap');
    return buildDecision({
      actionBand: reviewOrWarn,
      confidenceScore: input.confidenceScore,
      actionScore,
      reviewPriority,
      suppressionReasons,
    });
  }

  if (input.confidenceScore >= input.deleteThreshold && actionScore >= input.deleteThreshold) {
    if (
      input.hasDirectDealEvidence &&
      input.missingRequiredAnchors.length === 0 &&
      !safeContextDeleteSuppressed &&
      !subtypeDeleteSuppressed
    ) {
      return buildDecision({
        actionBand: 'DELETE',
        confidenceScore: input.confidenceScore,
        actionScore,
        reviewPriority,
        suppressionReasons,
      });
    }
    return buildDecision({
      actionBand:
        safeContextDeleteSuppressed || input.missingRequiredAnchors.length > 0
          ? 'REVIEW_ONLY'
          : reviewOrWarn,
      confidenceScore: input.confidenceScore,
      actionScore,
      reviewPriority,
      suppressionReasons,
    });
  }

  return buildDecision({
    actionBand: reviewOrWarn,
    confidenceScore: input.confidenceScore,
    actionScore,
    reviewPriority,
    suppressionReasons,
  });
}

function buildDecision(params: {
  actionBand: CommercialActionBand;
  confidenceScore: number;
  actionScore: number;
  reviewPriority: CommercialReviewPriority;
  suppressionReasons: readonly string[];
}): CommercialActionPolicyDecision {
  const deleteSuppressed =
    params.suppressionReasons.length > 0 &&
    (params.actionScore >= COMMERCIAL_ENGINE_CONFIG.actionPolicy.hardDeleteScoreThreshold ||
      params.confidenceScore >= COMMERCIAL_ENGINE_CONFIG.actionPolicy.hardDeleteScoreThreshold) &&
    params.actionBand !== 'DELETE' &&
    params.actionBand !== 'DELETE_AND_ESCALATE';
  return {
    actionBand: params.actionBand,
    actionScore: params.actionScore,
    reviewPriority: params.reviewPriority,
    actionable: params.actionBand !== 'ALLOW' && params.actionBand !== 'REVIEW_ONLY',
    recordable: params.actionBand !== 'ALLOW' && params.actionBand !== 'REVIEW_ONLY',
    deleteSuppressed,
    suppressionReasons: [...params.suppressionReasons],
  };
}

function resolveCommercialActionScore(input: CommercialActionPolicyInput): number {
  let score = input.confidenceScore;
  if (input.hasDirectDealEvidence) {
    score += COMMERCIAL_ENGINE_CONFIG.actionPolicy.scoreAdjustments.directDeal;
  }
  if (input.hasHighRiskEvidence) {
    score += COMMERCIAL_ENGINE_CONFIG.actionPolicy.scoreAdjustments.highRisk;
  }
  if (input.hasEscalationRiskEvidence && input.hasLocalEscalationOfferEvidence) {
    score += COMMERCIAL_ENGINE_CONFIG.actionPolicy.scoreAdjustments.escalationRisk;
  }
  if (input.campaignStrength === 'STANDARD') {
    score += COMMERCIAL_ENGINE_CONFIG.actionPolicy.scoreAdjustments.standardCampaign;
  } else if (input.campaignStrength === 'STRONG') {
    score += COMMERCIAL_ENGINE_CONFIG.actionPolicy.scoreAdjustments.strongCampaign;
  } else if (input.campaignStrength === 'WEAK') {
    score += COMMERCIAL_ENGINE_CONFIG.actionPolicy.scoreAdjustments.weakCampaign;
  }
  if (input.reviewRecommended) {
    score -= COMMERCIAL_ENGINE_CONFIG.actionPolicy.scoreAdjustments.reviewRecommended;
  }
  if (input.missingRequiredAnchors.length > 0) {
    score -= COMMERCIAL_ENGINE_CONFIG.actionPolicy.scoreAdjustments.missingAnchor;
  }
  if (input.fpRisk >= COMMERCIAL_ENGINE_CONFIG.actionPolicy.highFpRiskThreshold) {
    score -= COMMERCIAL_ENGINE_CONFIG.actionPolicy.scoreAdjustments.highFpRisk;
  }
  if (input.safeContextBucket !== 'none') {
    score -= COMMERCIAL_ENGINE_CONFIG.actionPolicy.scoreAdjustments.safeContext;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function resolveCommercialReviewPriority(
  input: CommercialActionPolicyInput & { actionScore: number },
): CommercialReviewPriority {
  if (input.confidenceScore < input.warnThreshold) {
    return 'NONE';
  }
  if (input.hasEscalationRiskEvidence && input.hasLocalEscalationOfferEvidence) {
    return 'URGENT';
  }
  if (
    input.safeContextBucket !== 'none' ||
    input.fpRisk >= COMMERCIAL_ENGINE_CONFIG.actionPolicy.highFpRiskThreshold ||
    input.missingRequiredAnchors.length > 0
  ) {
    return 'HIGH';
  }
  if (input.reviewRecommended || input.reviewReasons.length > 0) {
    return 'MEDIUM';
  }
  if (input.actionScore >= input.deleteThreshold || input.hasDirectDealEvidence) {
    return 'LOW';
  }
  return 'LOW';
}

function shouldSuppressDeleteForSafeContext(input: CommercialActionPolicyInput): boolean {
  switch (input.safeContextBucket) {
    case 'none':
      return false;
    case 'rules_or_moderation_context':
    case 'spam_complaint_or_fraud_warning':
    case 'news_or_analytics':
    case 'brand_mention_only':
    case 'public_training_or_help':
    case 'request_or_recommendation':
    case 'ordinary_recruitment':
    case 'private_one_off_sale':
      return true;
  }
}

function shouldSuppressDeleteForSubtype(input: CommercialActionPolicyInput): boolean {
  const policy = getCommercialSubtypePolicy(input.subtype);
  if (!policy.deleteAllowedEvidence.includes(input.evidenceTier)) {
    return true;
  }
  if (input.subtype === 'GENERIC') {
    return !input.hasEscalationRiskEvidence;
  }
  if (input.subtype === 'GOODS') {
    return !(
      input.hasEscalationRiskEvidence ||
      (input.hasHighRiskEvidence && input.hasDirectDealEvidence) ||
      (input.campaignStrength === 'STRONG' && input.hasDirectDealEvidence)
    );
  }
  if (input.subtype === 'PROPERTY_AGENT' || input.subtype === 'PROPERTY_COMMERCIAL') {
    return !(
      input.hasEscalationRiskEvidence ||
      (input.hasDirectDealEvidence &&
        (input.featureVector.businessContext > 0 || input.campaignStrength === 'STRONG'))
    );
  }
  if (input.subtype === 'CHANNEL_PLACEMENT' || input.subtype === 'GROUP_PROMOTION') {
    return !(
      input.hasDirectDealEvidence &&
      (input.featureVector.priceStructure > 0 ||
        input.featureVector.contactEvidence > 0 ||
        input.featureVector.dealEvidence > 0 ||
        input.campaignStrength === 'STRONG')
    );
  }
  if (input.subtype === 'RECRUITMENT') {
    return !(
      input.hasDirectDealEvidence ||
      input.hasEscalationRiskEvidence ||
      input.featureVector.highRisk > 0
    );
  }
  if (input.subtype === 'GOODS_RETAIL') {
    return !(
      input.hasEscalationRiskEvidence ||
      (input.hasDirectDealEvidence &&
        (input.featureVector.businessContext > 0 ||
          input.featureVector.massDistribution > 0 ||
          input.campaignStrength === 'STRONG'))
    );
  }
  if (input.subtype === 'SERVICES') {
    return !(
      input.hasEscalationRiskEvidence ||
      (input.hasDirectDealEvidence &&
        (input.featureVector.businessContext > 0 ||
          input.featureVector.priceStructure > 0 ||
          input.featureVector.massDistribution > 0 ||
          input.campaignStrength === 'STRONG'))
    );
  }
  return !input.hasDirectDealEvidence && !input.hasEscalationRiskEvidence;
}
