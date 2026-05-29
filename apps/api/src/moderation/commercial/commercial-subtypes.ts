import type { CommercialSubtype } from '../rule-engine.contract';
import type {
  CommercialActionBand,
  CommercialEvidenceTier,
  CommercialFeatureVector,
  CommercialRequiredAnchor,
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
