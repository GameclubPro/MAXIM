import type { CommercialDetection } from './commercial-ad.detector';
import { resolveCommercialActionPolicy } from './commercial-action-policy';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import type {
  CommercialEvidenceTier,
  CommercialExplainableDecision,
  CommercialFeatureVector,
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
  const hasHighRiskEvidence = matchedSignals.some((signal) => signal.startsWith('risk:'));
  const hasPriceEvidence =
    matchedSignals.includes('transaction:price') ||
    matchedSignals.includes('transaction:implied-price') ||
    matchedSignals.includes('combo:contact+price');
  const hasStrongContactEvidence =
    matchedSignals.includes('contact:phone') ||
    matchedSignals.includes('contact:contextual-phone') ||
    matchedSignals.includes('contact:masked-phone') ||
    matchedSignals.includes('contact:handle') ||
    matchedSignals.includes('contact:email');
  const hasPhoneEvidence =
    matchedSignals.includes('contact:phone') ||
    matchedSignals.includes('contact:contextual-phone') ||
    matchedSignals.includes('contact:masked-phone');
  const hasLinkEvidence = matchedSignals.some((signal) => signal.startsWith('deal-channel:'));
  const hasNonCampaignDirectDealEvidence =
    hasPriceEvidence ||
    hasPhoneEvidence ||
    hasLinkEvidence;
  const hasDirectDealEvidence =
    (hasPriceEvidence && (hasStrongContactEvidence || hasLinkEvidence)) ||
    (hasLinkEvidence && hasStrongContactEvidence) ||
    (hasHighRiskEvidence && (hasPriceEvidence || hasStrongContactEvidence || hasLinkEvidence));
  const evidenceTier = resolveEvidenceTier({
    legacyStrength: detection.evidenceStrength,
    hasHighRiskEvidence,
    hasDirectDealEvidence,
  });
  const actionBand = resolveCommercialActionPolicy({
    confidenceScore: detection.confidenceScore,
    deleteThreshold: detection.appliedThresholds.deleteThreshold,
    warnThreshold: detection.appliedThresholds.warnThreshold,
    fpRisk,
    evidenceTier,
    reviewRecommended: detection.reviewRecommended,
    hasCampaignContext: detection.campaignContext !== null,
    hasDirectDealEvidence,
    hasNonCampaignDirectDealEvidence,
    hasHighRiskEvidence,
  });
  const reasonCodes = buildReasonCodes({
    detection,
    featureVector,
    fpRisk,
    actionBand,
    evidenceTier,
  });

  return Object.assign(detection, {
    decisionVersion: COMMERCIAL_DECISION_VERSION,
    score: detection.confidenceScore,
    fpRisk,
    evidenceTier,
    subtype: detection.primarySubtype,
    actionBand,
    reasonCodes,
    featureVector,
  });
}

export function buildCommercialFeatureVector(
  matchedSignals: readonly string[],
  negativeSignals: readonly string[],
): CommercialFeatureVector {
  const hasPrefix = (prefix: string): boolean =>
    matchedSignals.some((signal) => signal.startsWith(prefix));
  const hasAny = (...signals: string[]): boolean =>
    signals.some((signal) => matchedSignals.includes(signal));

  return {
    commercialIntent: hasPrefix('intent:') ? 1 : 0,
    dealEvidence: hasPrefix('deal-channel:') || hasPrefix('transaction:') ? 1 : 0,
    contactEvidence: hasPrefix('contact:') ? 1 : 0,
    businessContext:
      hasPrefix('business:') ||
      hasPrefix('service-specialty:') ||
      hasPrefix('goods-retail:') ||
      hasPrefix('property-agent:') ||
      hasPrefix('property-commercial:')
        ? 1
        : 0,
    massDistribution: hasPrefix('campaign:') || hasPrefix('channel-placement:') ? 1 : 0,
    priceStructure: hasAny('transaction:price', 'transaction:implied-price', 'combo:contact+price')
      ? 1
      : 0,
    cta: hasPrefix('cta:') || hasPrefix('group-promo:') ? 1 : 0,
    negativePrivateContext: negativeSignals.some(
      (signal) =>
        signal.startsWith('private:') ||
        signal.startsWith('private-single:') ||
        signal.startsWith('private-goods:'),
    )
      ? 1
      : 0,
    questionContext: negativeSignals.some(
      (signal) => signal.startsWith('context:') || signal.startsWith('search:'),
    )
      ? 1
      : 0,
    highRisk: hasPrefix('risk:') ? 1 : 0,
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
  fpRisk: number;
  actionBand: string;
  evidenceTier: CommercialEvidenceTier;
}): string[] {
  const reasonCodes = new Set<string>();
  reasonCodes.add(`action:${params.actionBand}`);
  reasonCodes.add(`evidence:${params.evidenceTier}`);
  reasonCodes.add(`subtype:${params.detection.primarySubtype}`);

  if (params.featureVector.highRisk > 0) {
    reasonCodes.add('high-risk-signal');
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
  for (const reason of params.detection.reviewReasons) {
    reasonCodes.add(`review:${reason}`);
  }
  for (const reason of params.detection.classifierReasons) {
    reasonCodes.add(`classifier:${reason}`);
  }

  return [...reasonCodes];
}
