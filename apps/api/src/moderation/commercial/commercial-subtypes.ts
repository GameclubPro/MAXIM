import type { CommercialSubtype } from '../rule-engine.contract';
import type { CommercialDecisionBand } from '../rule-engine.contract';
import type { CommercialThresholdProfile } from '../rule-engine-commercial-thresholds';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import type {
  CommercialActionBand,
  CommercialClassification,
  CommercialEvidenceTier,
  CommercialFeatureVector,
  CommercialRequiredAnchor,
  CommercialSignalState,
  CommercialSubtypePolicy,
} from './commercial.types';

const DELETE_ALLOWED_EVIDENCE: readonly CommercialEvidenceTier[] = ['DIRECT', 'HIGH_RISK'];
const AMBIGUOUS_ACTION_BANDS: readonly CommercialActionBand[] = ['WARN', 'REVIEW_ONLY'];

export const COMMERCIAL_SUBTYPE_POLICIES = {
  CHANNEL_PLACEMENT: {
    subtype: 'CHANNEL_PLACEMENT',
    taxonomyClass: 'TRUE_AD',
    requiredAnchors: ['channelAudience', 'dealEvidence'],
    deleteAllowedEvidence: DELETE_ALLOWED_EVIDENCE,
    ambiguousActionBands: AMBIGUOUS_ACTION_BANDS,
  },
  PROPERTY_AGENT: {
    subtype: 'PROPERTY_AGENT',
    taxonomyClass: 'TRUE_AD',
    requiredAnchors: ['propertyAgency', 'dealEvidence'],
    deleteAllowedEvidence: DELETE_ALLOWED_EVIDENCE,
    ambiguousActionBands: AMBIGUOUS_ACTION_BANDS,
  },
  PROPERTY_COMMERCIAL: {
    subtype: 'PROPERTY_COMMERCIAL',
    taxonomyClass: 'TRUE_AD',
    requiredAnchors: ['commercialProperty', 'dealEvidence'],
    deleteAllowedEvidence: DELETE_ALLOWED_EVIDENCE,
    ambiguousActionBands: AMBIGUOUS_ACTION_BANDS,
  },
  RECRUITMENT: {
    subtype: 'RECRUITMENT',
    taxonomyClass: 'TRUE_AD',
    requiredAnchors: ['recruitment', 'contactEvidence'],
    deleteAllowedEvidence: DELETE_ALLOWED_EVIDENCE,
    ambiguousActionBands: AMBIGUOUS_ACTION_BANDS,
  },
  INFO_PRODUCT: {
    subtype: 'INFO_PRODUCT',
    taxonomyClass: 'TRUE_AD',
    requiredAnchors: ['infoProduct', 'dealEvidence'],
    deleteAllowedEvidence: DELETE_ALLOWED_EVIDENCE,
    ambiguousActionBands: AMBIGUOUS_ACTION_BANDS,
  },
  BUYOUT: {
    subtype: 'BUYOUT',
    taxonomyClass: 'TRUE_AD',
    requiredAnchors: ['buyout', 'dealEvidence'],
    deleteAllowedEvidence: DELETE_ALLOWED_EVIDENCE,
    ambiguousActionBands: AMBIGUOUS_ACTION_BANDS,
  },
  SERVICES: {
    subtype: 'SERVICES',
    taxonomyClass: 'TRUE_AD',
    requiredAnchors: ['serviceSpecialty', 'dealEvidence'],
    deleteAllowedEvidence: DELETE_ALLOWED_EVIDENCE,
    ambiguousActionBands: AMBIGUOUS_ACTION_BANDS,
  },
  GOODS_RETAIL: {
    subtype: 'GOODS_RETAIL',
    taxonomyClass: 'TRUE_AD',
    requiredAnchors: ['retailStructure', 'dealEvidence'],
    deleteAllowedEvidence: DELETE_ALLOWED_EVIDENCE,
    ambiguousActionBands: AMBIGUOUS_ACTION_BANDS,
  },
  GOODS: {
    subtype: 'GOODS',
    taxonomyClass: 'GRAY',
    requiredAnchors: ['commercialIntent', 'dealEvidence'],
    deleteAllowedEvidence: DELETE_ALLOWED_EVIDENCE,
    ambiguousActionBands: AMBIGUOUS_ACTION_BANDS,
  },
  GROUP_PROMOTION: {
    subtype: 'GROUP_PROMOTION',
    taxonomyClass: 'TRUE_AD',
    requiredAnchors: ['channelAudience', 'dealEvidence'],
    deleteAllowedEvidence: DELETE_ALLOWED_EVIDENCE,
    ambiguousActionBands: AMBIGUOUS_ACTION_BANDS,
  },
  GENERIC: {
    subtype: 'GENERIC',
    taxonomyClass: 'GRAY',
    requiredAnchors: ['commercialIntent', 'dealEvidence'],
    deleteAllowedEvidence: DELETE_ALLOWED_EVIDENCE,
    ambiguousActionBands: AMBIGUOUS_ACTION_BANDS,
  },
} as const satisfies Record<CommercialSubtype, CommercialSubtypePolicy>;

export function classifyCommercialDetection(params: {
  state: CommercialSignalState;
  confidenceScore: number;
  decisionBand: CommercialDecisionBand;
  appliedThresholds: CommercialThresholdProfile;
  hasCampaignDependentEvidence: boolean;
}): CommercialClassification {
  const { state, confidenceScore, decisionBand, appliedThresholds, hasCampaignDependentEvidence } =
    params;
  const subtypeConfig = COMMERCIAL_ENGINE_CONFIG.subtypeScores;
  const subtypeScores = new Map<CommercialSubtype, number>();
  const addSubtype = (subtype: CommercialSubtype, score: number) => {
    subtypeScores.set(subtype, Math.max(score, subtypeScores.get(subtype) ?? 0));
  };

  if (
    state.hasChannelPlacementContext ||
    (state.hasCommercialAudienceContext && state.hasGroupPromotionIntent)
  ) {
    addSubtype('CHANNEL_PLACEMENT', subtypeConfig.CHANNEL_PLACEMENT);
  }

  if (state.hasPropertyAgentContext) {
    addSubtype('PROPERTY_AGENT', subtypeConfig.PROPERTY_AGENT);
  }

  if (state.hasCommercialPropertyContext) {
    addSubtype('PROPERTY_COMMERCIAL', subtypeConfig.PROPERTY_COMMERCIAL);
  }

  if (state.hasRecruitmentContext) {
    addSubtype('RECRUITMENT', subtypeConfig.RECRUITMENT);
  }

  if (state.hasInfoProductContext) {
    addSubtype('INFO_PRODUCT', subtypeConfig.INFO_PRODUCT);
  }

  if (state.hasBuyoutContext) {
    addSubtype('BUYOUT', subtypeConfig.BUYOUT);
  }

  if (state.hasServiceContext) {
    addSubtype('SERVICES', subtypeConfig.SERVICES);
  } else if (state.hasServiceOfferContext || state.hasServiceSpecialtyContext) {
    addSubtype('SERVICES', subtypeConfig.SERVICES_WEAK);
  }

  if (state.hasGoodsRetailContext) {
    addSubtype(
      'GOODS_RETAIL',
      state.hasServiceContext
        ? subtypeConfig.GOODS_RETAIL_WITH_SERVICE
        : subtypeConfig.GOODS_RETAIL,
    );
  }

  if (state.hasGroupPromoContext || (state.hasGroupPromotionIntent && state.hasDealChannel)) {
    addSubtype(
      'GROUP_PROMOTION',
      state.hasGroupPromoContext
        ? subtypeConfig.GROUP_PROMOTION
        : subtypeConfig.GROUP_PROMOTION_WEAK,
    );
  }

  if (
    !state.hasServiceContext &&
    !state.hasPropertyAgentContext &&
    !state.hasCommercialPropertyContext &&
    !state.hasRecruitmentContext &&
    !state.hasInfoProductContext &&
    !state.hasGoodsRetailContext &&
    (state.hasIntent || state.hasPromoContext || state.hasBusinessContext) &&
    (state.hasPrice || state.hasTransactional || state.hasContact || state.hasDealChannel)
  ) {
    addSubtype('GOODS', subtypeConfig.GOODS);
  }

  if (subtypeScores.size === 0) {
    addSubtype('GENERIC', subtypeConfig.GENERIC);
  }

  const rankedSubtypes = [...subtypeScores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([subtype, score]) => ({ subtype, score }));
  const primarySubtype = rankedSubtypes[0]?.subtype ?? 'GENERIC';
  const supportingSubtypes = rankedSubtypes
    .filter(
      (entry, index) =>
        index > 0 && entry.score >= rankedSubtypes[0].score - subtypeConfig.supportingWindow,
    )
    .slice(0, subtypeConfig.maxSupportingSubtypes)
    .map((entry) => entry.subtype);

  const hasDirectEvidence =
    (state.hasPrice && (state.hasContact || state.hasDealChannel || state.hasTransactional)) ||
    (state.hasDealChannel && state.hasContact);
  const hasStructuredEvidence =
    (state.hasPropertyAgentContext ||
      state.hasCommercialPropertyContext ||
      state.hasRecruitmentContext ||
      state.hasInfoProductContext ||
      state.hasBuyoutContext ||
      state.hasServiceContext ||
      state.hasGoodsRetailContext ||
      state.hasGroupPromoContext ||
      state.hasBusinessContext ||
      state.hasPromoContext) &&
    (state.hasContact || state.hasDealChannel || state.hasPrice || state.hasTransactional);
  const evidenceStrength: CommercialClassification['evidenceStrength'] = hasDirectEvidence
    ? 'DIRECT'
    : hasCampaignDependentEvidence
      ? 'CAMPAIGN'
      : hasStructuredEvidence
        ? 'STRUCTURED'
        : 'BORDERLINE';
  const suppressPropertyAgentReviewNoise =
    primarySubtype === 'PROPERTY_AGENT' &&
    confidenceScore >= appliedThresholds.deleteThreshold &&
    (state.hasPrice || state.hasContact || state.hasTransactional);
  const suppressStructuredGoodsReviewNoise =
    (primarySubtype === 'GOODS_RETAIL' || primarySubtype === 'PROPERTY_COMMERCIAL') &&
    confidenceScore >= appliedThresholds.deleteThreshold &&
    (state.hasPrice || state.hasContact || state.hasTransactional);

  const reviewReasons: string[] = [];
  if (decisionBand !== 'HIGH') {
    reviewReasons.push('medium-band');
  }
  if (
    confidenceScore <=
    appliedThresholds.warnThreshold +
      COMMERCIAL_ENGINE_CONFIG.secondStage.reviewLogit.nearWarnWindow
  ) {
    reviewReasons.push('near-threshold');
  }
  if (
    (state.hasStrongNegativeContext || state.negativeSignals.length > 0) &&
    !suppressPropertyAgentReviewNoise &&
    !suppressStructuredGoodsReviewNoise
  ) {
    reviewReasons.push('conflicting-negative-signals');
  }
  if (hasCampaignDependentEvidence && evidenceStrength === 'CAMPAIGN') {
    reviewReasons.push('campaign-dependent');
  }
  if (primarySubtype === 'GENERIC' || primarySubtype === 'GOODS') {
    reviewReasons.push('generic-subtype');
  }
  if (
    state.hasPrivateSaleContext &&
    (state.hasServiceContext ||
      state.hasPropertyAgentContext ||
      state.hasCommercialPropertyContext) &&
    !suppressPropertyAgentReviewNoise &&
    !suppressStructuredGoodsReviewNoise
  ) {
    reviewReasons.push('private-sale-override');
  }

  const reviewRecommended =
    reviewReasons.length > 0 &&
    (decisionBand !== 'HIGH' ||
      reviewReasons.includes('campaign-dependent') ||
      reviewReasons.includes('generic-subtype') ||
      reviewReasons.includes('conflicting-negative-signals'));

  return {
    primarySubtype,
    supportingSubtypes: [...new Set(supportingSubtypes)],
    evidenceStrength,
    reviewRecommended,
    reviewReasons: [...new Set(reviewReasons)],
  };
}

export function getCommercialSubtypePolicy(subtype: CommercialSubtype): CommercialSubtypePolicy {
  return COMMERCIAL_SUBTYPE_POLICIES[subtype];
}

export function isCommercialDeleteAction(
  actionBand: CommercialActionBand | string | null,
): boolean {
  return actionBand === 'DELETE' || actionBand === 'DELETE_AND_ESCALATE';
}

export function isCommercialAmbiguousAction(
  actionBand: CommercialActionBand | string | null,
): boolean {
  return actionBand === 'WARN' || actionBand === 'REVIEW_ONLY';
}

export function hasCommercialAnchor(
  anchor: CommercialRequiredAnchor,
  params: {
    featureVector: CommercialFeatureVector;
    matchedSignals: readonly string[];
  },
): boolean {
  const { featureVector, matchedSignals } = params;
  const hasPrefix = (prefix: string): boolean =>
    matchedSignals.some((signal) => signal.startsWith(prefix));
  const hasAny = (...signals: string[]): boolean =>
    signals.some((signal) => matchedSignals.includes(signal));

  switch (anchor) {
    case 'commercialIntent':
      return featureVector.commercialIntent > 0 || featureVector.highRisk > 0;
    case 'serviceSpecialty':
      return hasPrefix('service-specialty:') || hasPrefix('intent:');
    case 'retailStructure':
      return hasPrefix('goods-retail:') || hasAny('transaction:price', 'combo:contact+price');
    case 'channelAudience':
      return hasPrefix('channel-placement:') || hasPrefix('audience:') || hasPrefix('group-promo:');
    case 'propertyAgency':
      return hasPrefix('property-agent:');
    case 'commercialProperty':
      return hasPrefix('property-commercial:');
    case 'recruitment':
      return hasPrefix('recruitment:') || hasPrefix('risk:structured-job-vacancy');
    case 'infoProduct':
      return hasPrefix('info:');
    case 'buyout':
      return hasPrefix('buyout:');
    case 'highRisk':
      return featureVector.highRisk > 0;
    case 'dealEvidence':
      return (
        featureVector.dealEvidence > 0 ||
        featureVector.contactEvidence > 0 ||
        featureVector.priceStructure > 0
      );
    case 'contactEvidence':
      return featureVector.contactEvidence > 0;
    case 'priceStructure':
      return featureVector.priceStructure > 0;
    case 'cta':
      return featureVector.cta > 0;
    case 'massDistribution':
      return featureVector.massDistribution > 0;
  }
}

export function resolveMissingCommercialAnchors(params: {
  subtype: CommercialSubtype;
  featureVector: CommercialFeatureVector;
  matchedSignals: readonly string[];
}): CommercialRequiredAnchor[] {
  const policy = getCommercialSubtypePolicy(params.subtype);
  return policy.requiredAnchors.filter(
    (anchor) =>
      !hasCommercialAnchor(anchor, {
        featureVector: params.featureVector,
        matchedSignals: params.matchedSignals,
      }),
  );
}

export type { CommercialSubtype };
