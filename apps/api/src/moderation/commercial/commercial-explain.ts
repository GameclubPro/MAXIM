import type { CommercialDetection } from './commercial-ad.detector';
import { resolveCommercialActionPolicy } from './commercial-action-policy';
import { resolveCommercialCampaignStrength } from './commercial-campaign';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import {
  resolveCommercialSignalEvidence,
  type CommercialSignalEvidenceProfile,
} from './commercial-evidence';
import {
  deriveCommercialSafeContextBucket,
  type CommercialSafeContextBucket,
} from './commercial-safe-context';
import { resolveMissingCommercialAnchors } from './commercial-subtypes';
import type {
  CommercialEvidenceTier,
  CommercialExplainableDecision,
  CommercialFeatureVector,
  CommercialReviewPriority,
} from './commercial.types';

export const COMMERCIAL_DECISION_VERSION = COMMERCIAL_ENGINE_CONFIG.decisionVersion;

export type CommercialExplainableMetadata = CommercialExplainableDecision;

export function enrichCommercialDetection<T extends CommercialDetection>(
  detection: T,
): T & CommercialExplainableMetadata {
  const matchedSignals = detection.matchedSignals;
  const negativeSignals = detection.negativeSignals;
  const featureVector = buildCommercialFeatureVector(matchedSignals, negativeSignals);
  const fpRisk = estimateCommercialFpRisk({
    negativeSignals,
    reviewRecommended: detection.reviewRecommended,
    evidenceStrength: detection.evidenceStrength,
    primarySubtype: detection.primarySubtype,
  });
  const evidence = resolveCommercialSignalEvidence(matchedSignals);
  const hasActionDirectDealEvidence =
    detection.hasActionDirectDealEvidence ?? evidence.hasActionDirectDealEvidence;
  const policyFpRisk = estimateCommercialPolicyFpRisk({
    baseFpRisk: fpRisk,
    detection,
    signalEvidence: evidence,
    hasActionDirectDealEvidence,
  });
  const evidenceTier = resolveEvidenceTier({
    legacyStrength: detection.evidenceStrength,
    hasHighRiskEvidence: evidence.hasHighRiskEvidence,
    hasDirectDealEvidence: hasActionDirectDealEvidence,
  });
  const campaignStrength = resolveCommercialCampaignStrength(detection.campaignContext);
  const safeContextBucket = deriveCommercialSafeContextBucket({
    text: detection.rawText ?? '',
    matchedSignals,
    negativeSignals,
    hasCommercialHit: true,
  });
  const missingRequiredAnchors = resolveMissingCommercialAnchors({
    subtype: detection.primarySubtype,
    featureVector,
    matchedSignals,
  });
  const actionPolicy = resolveCommercialActionPolicy({
    confidenceScore: detection.confidenceScore,
    deleteThreshold: detection.appliedThresholds.deleteThreshold,
    warnThreshold: detection.appliedThresholds.warnThreshold,
    fpRisk: policyFpRisk,
    evidenceTier,
    subtype: detection.primarySubtype,
    reviewRecommended: detection.reviewRecommended,
    reviewReasons: detection.reviewReasons,
    missingRequiredAnchors,
    featureVector,
    safeContextBucket,
    campaignStrength,
    hasCampaignContext: detection.campaignContext !== null,
    hasDirectDealEvidence: hasActionDirectDealEvidence,
    hasNonCampaignDirectDealEvidence:
      detection.hasNonCampaignDirectDealEvidence ?? evidence.hasNonCampaignDirectDealEvidence,
    hasHighRiskEvidence: evidence.hasHighRiskEvidence,
    hasEscalationRiskEvidence:
      detection.hasEscalationRiskEvidence ?? evidence.hasEscalationRiskEvidence,
    hasLocalEscalationOfferEvidence: evidence.hasLocalEscalationOfferEvidence,
    hasStructuredTransportEvidence: evidence.hasStructuredTransportEvidence,
    hasReviewOnlyTransportEvidence: evidence.hasReviewOnlyTransportEvidence,
    hasWarnCappedRecallEvidence: evidence.hasWarnCappedRecallEvidence,
    hasReviewCappedRecallEvidence: evidence.hasReviewCappedRecallEvidence,
    hasConservativeRecallEvidence: evidence.hasConservativeRecallEvidence,
    hasIndependentCommercialOfferEvidence: evidence.hasIndependentCommercialOfferEvidence,
  });
  const reasonCodes = buildReasonCodes({
    detection,
    featureVector,
    signalEvidence: evidence,
    fpRisk,
    policyFpRisk,
    actionBand: actionPolicy.actionBand,
    evidenceTier,
    hasActionDirectDealEvidence,
    actionScore: actionPolicy.actionScore,
    reviewPriority: actionPolicy.reviewPriority,
    campaignStrength,
    safeContextBucket,
    missingRequiredAnchors,
    suppressionReasons: actionPolicy.suppressionReasons,
  });

  return Object.assign(detection, {
    decisionVersion: COMMERCIAL_DECISION_VERSION,
    score: detection.confidenceScore,
    actionScore: actionPolicy.actionScore,
    fpRisk,
    policyFpRisk,
    evidenceTier,
    subtype: detection.primarySubtype,
    actionBand: actionPolicy.actionBand,
    reviewPriority: actionPolicy.reviewPriority,
    campaignStrength,
    safeContextBucket,
    actionable: actionPolicy.actionable,
    recordable: actionPolicy.recordable,
    deleteSuppressed: actionPolicy.deleteSuppressed,
    suppressionReasons: actionPolicy.suppressionReasons,
    reasonCodes,
    featureVector,
  });
}

export function buildCommercialFeatureVector(
  matchedSignals: readonly string[],
  negativeSignals: readonly string[],
): CommercialFeatureVector {
  let commercialIntent = 0;
  let dealEvidence = 0;
  let contactEvidence = 0;
  let businessContext = 0;
  let massDistribution = 0;
  let priceStructure = 0;
  let cta = 0;
  let highRisk = 0;

  for (const signal of matchedSignals) {
    if (commercialIntent === 0 && signal.startsWith('intent:')) {
      commercialIntent = 1;
    }
    if (
      dealEvidence === 0 &&
      (signal.startsWith('deal-channel:') || signal.startsWith('transaction:'))
    ) {
      dealEvidence = 1;
    }
    if (contactEvidence === 0 && signal.startsWith('contact:')) {
      contactEvidence = 1;
    }
    if (
      businessContext === 0 &&
      (signal.startsWith('business:') ||
        signal.startsWith('service-specialty:') ||
        signal.startsWith('goods-retail:') ||
        signal.startsWith('property-agent:') ||
        signal.startsWith('property-commercial:'))
    ) {
      businessContext = 1;
    }
    if (
      massDistribution === 0 &&
      (signal.startsWith('campaign:') || signal.startsWith('channel-placement:'))
    ) {
      massDistribution = 1;
    }
    if (
      priceStructure === 0 &&
      (signal === 'transaction:price' ||
        signal === 'transaction:implied-price' ||
        signal === 'combo:contact+price')
    ) {
      priceStructure = 1;
    }
    if (cta === 0 && (signal.startsWith('cta:') || signal.startsWith('group-promo:'))) {
      cta = 1;
    }
    if (highRisk === 0 && signal.startsWith('risk:')) {
      highRisk = 1;
    }
  }

  let negativePrivateContext = 0;
  let questionContext = 0;
  for (const signal of negativeSignals) {
    if (
      negativePrivateContext === 0 &&
      (signal.startsWith('private:') ||
        signal.startsWith('private-single:') ||
        signal.startsWith('private-goods:'))
    ) {
      negativePrivateContext = 1;
    }
    if (questionContext === 0 && (signal.startsWith('context:') || signal.startsWith('search:'))) {
      questionContext = 1;
    }
  }

  return {
    commercialIntent,
    dealEvidence,
    contactEvidence,
    businessContext,
    massDistribution,
    priceStructure,
    cta,
    negativePrivateContext,
    questionContext,
    highRisk,
  };
}

export function estimateCommercialFpRisk(params: {
  negativeSignals: readonly string[];
  reviewRecommended: boolean;
  evidenceStrength: CommercialDetection['evidenceStrength'];
  primarySubtype: CommercialDetection['primarySubtype'];
}): number {
  const config = COMMERCIAL_ENGINE_CONFIG.fpRisk;
  let risk = 0;
  if (params.reviewRecommended) {
    risk += config.reviewRecommended;
  }
  risk += config.evidenceStrength[params.evidenceStrength];
  if (params.primarySubtype === 'GENERIC' || params.primarySubtype === 'GOODS') {
    risk += config.genericSubtype;
  }

  for (const signal of params.negativeSignals) {
    if (signal.startsWith('private:') || signal.startsWith('private-single:')) {
      risk += config.privateSignal;
    } else if (signal.startsWith('search:') || signal.startsWith('context:')) {
      risk += config.questionSignal;
    } else {
      risk += config.defaultNegativeSignal;
    }
  }

  return Math.max(config.min, Math.min(config.max, risk));
}

function estimateCommercialPolicyFpRisk(params: {
  baseFpRisk: number;
  detection: CommercialDetection;
  signalEvidence: CommercialSignalEvidenceProfile;
  hasActionDirectDealEvidence: boolean;
}): number {
  let risk = params.baseFpRisk;
  const { detection, signalEvidence } = params;
  const hasPolicyGuardedDirectEvidence =
    signalEvidence.hasRawActionDirectDealEvidence && !params.hasActionDirectDealEvidence;
  const hasLocalPrivateLikeSignal =
    detection.matchedSignals.some((signal) => LOCAL_PRIVATE_LIKE_RETAIL_SIGNALS.has(signal)) ||
    detection.negativeSignals.some(
      (signal) =>
        signal.startsWith('private:') ||
        signal.startsWith('private-single:') ||
        signal.startsWith('private-goods:'),
    );

  if (hasPolicyGuardedDirectEvidence) {
    risk += 70;
  } else if (
    hasLocalPrivateLikeSignal &&
    detection.primarySubtype === 'GOODS_RETAIL' &&
    signalEvidence.hasPriceEvidence &&
    signalEvidence.hasPhoneEvidence &&
    !signalEvidence.hasLinkEvidence &&
    !signalEvidence.hasHighRiskEvidence
  ) {
    risk += 30;
  }

  return Math.max(
    COMMERCIAL_ENGINE_CONFIG.fpRisk.min,
    Math.min(COMMERCIAL_ENGINE_CONFIG.fpRisk.max, risk),
  );
}

function resolveEvidenceTier(params: {
  legacyStrength: CommercialDetection['evidenceStrength'];
  hasHighRiskEvidence: boolean;
  hasDirectDealEvidence: boolean;
}): CommercialEvidenceTier {
  if (params.hasHighRiskEvidence) {
    return 'HIGH_RISK';
  }
  if (params.hasDirectDealEvidence) {
    return 'DIRECT';
  }
  return params.legacyStrength;
}

function buildReasonCodes(params: {
  detection: CommercialDetection;
  featureVector: CommercialFeatureVector;
  signalEvidence: CommercialSignalEvidenceProfile;
  fpRisk: number;
  policyFpRisk: number;
  actionBand: string;
  actionScore: number;
  reviewPriority: CommercialReviewPriority;
  campaignStrength: string;
  safeContextBucket: CommercialSafeContextBucket;
  missingRequiredAnchors: readonly string[];
  suppressionReasons: readonly string[];
  evidenceTier: CommercialEvidenceTier;
  hasActionDirectDealEvidence: boolean;
}): string[] {
  const reasonCodes = new Set<string>();
  reasonCodes.add(`action:${params.actionBand}`);
  reasonCodes.add(`action-score:${params.actionScore}`);
  reasonCodes.add(`review-priority:${params.reviewPriority}`);
  reasonCodes.add(`evidence:${params.evidenceTier}`);
  reasonCodes.add(`subtype:${params.detection.primarySubtype}`);
  reasonCodes.add(`campaign-strength:${params.campaignStrength}`);

  if (params.safeContextBucket !== 'none') {
    reasonCodes.add(`safe-context:${params.safeContextBucket}`);
  }
  for (const anchor of params.missingRequiredAnchors) {
    reasonCodes.add(`missing-anchor:${anchor}`);
  }
  for (const reason of params.suppressionReasons) {
    reasonCodes.add(`suppressed:${reason}`);
  }

  if (params.featureVector.highRisk > 0) {
    reasonCodes.add('high-risk-signal');
  }
  if (params.signalEvidence.hasEscalationRiskEvidence) {
    reasonCodes.add('risk:escalation-grade');
  }
  if (params.hasActionDirectDealEvidence) {
    reasonCodes.add('evidence:action-direct');
  }
  if (params.signalEvidence.hasHighRiskEvidence && !params.hasActionDirectDealEvidence) {
    reasonCodes.add('evidence:high-risk-only');
  }
  if (params.signalEvidence.hasRawActionDirectDealEvidence && !params.hasActionDirectDealEvidence) {
    reasonCodes.add('policy:guarded-local-direct');
  }
  if (params.signalEvidence.hasPriceEvidence && params.signalEvidence.hasStrongContactEvidence) {
    reasonCodes.add('evidence:direct:price-contact');
  }
  if (params.signalEvidence.hasPriceEvidence && params.signalEvidence.hasLinkEvidence) {
    reasonCodes.add('evidence:direct:price-link');
  }
  if (params.signalEvidence.hasLinkEvidence && params.signalEvidence.hasStrongContactEvidence) {
    reasonCodes.add('evidence:direct:link-contact');
  }
  if (
    params.signalEvidence.hasTransactionalDirectDealEvidence &&
    params.signalEvidence.hasStrongContactEvidence
  ) {
    reasonCodes.add('evidence:direct:transaction-contact');
  }
  if (params.featureVector.priceStructure > 0 && params.featureVector.contactEvidence > 0) {
    reasonCodes.add('direct-price-contact');
  }
  if (params.featureVector.massDistribution > 0) {
    reasonCodes.add('mass-distribution');
  }
  if (params.fpRisk >= COMMERCIAL_ENGINE_CONFIG.actionPolicy.highFpRiskThreshold) {
    reasonCodes.add('fp-risk-high');
  }
  if (
    params.policyFpRisk >= COMMERCIAL_ENGINE_CONFIG.actionPolicy.highFpRiskThreshold &&
    params.fpRisk < COMMERCIAL_ENGINE_CONFIG.actionPolicy.highFpRiskThreshold
  ) {
    reasonCodes.add('fp-risk-policy-high');
  }
  for (const reason of params.detection.reviewReasons) {
    reasonCodes.add(`review:${reason}`);
  }
  for (const reason of params.detection.classifierReasons) {
    reasonCodes.add(`classifier:${reason}`);
  }

  return [...reasonCodes];
}

const LOCAL_PRIVATE_LIKE_RETAIL_SIGNALS = new Set([
  'goods-retail:wholesale-produce',
  'goods-retail:collectible-flower-retail',
  'goods-retail:flower-herb-unit-price-retail',
  'goods-retail:plant-nursery-stock',
  'goods-retail:plant-nursery-clearance-stock',
  'goods-retail:farm-livestock-retail',
  'goods-retail:poultry-farm-order',
  'goods-retail:home-food-order',
  'goods-retail:home-dairy-retail',
]);
