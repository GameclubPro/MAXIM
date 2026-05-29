import type { CommercialSubtype } from '../rule-engine.contract';
import { buildCommercialFeatureVector } from './commercial-explain';
import { resolveMissingCommercialAnchors } from './commercial-subtypes';
import type { CommercialFeatureVector, CommercialRequiredAnchor } from './commercial.types';

export { buildCommercialFeatureVector };

export type CommercialAnchorAudit = {
  subtype: CommercialSubtype;
  missingAnchors: CommercialRequiredAnchor[];
  hasRequiredAnchors: boolean;
};

export function auditCommercialRequiredAnchors(params: {
  subtype: CommercialSubtype;
  featureVector: CommercialFeatureVector;
  matchedSignals: readonly string[];
}): CommercialAnchorAudit {
  const missingAnchors = resolveMissingCommercialAnchors(params);
  return {
    subtype: params.subtype,
    missingAnchors,
    hasRequiredAnchors: missingAnchors.length === 0,
  };
}
