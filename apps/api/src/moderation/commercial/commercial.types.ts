import type { CommercialCampaignContext } from '../commercial-campaign.util';
import type { CommercialDecisionBand, CommercialSubtype } from '../rule-engine.contract';

export type CommercialTaxonomyClass = 'TRUE_AD' | 'HARD_NEGATIVE' | 'GRAY';

export type CommercialRequiredAnchor =
  | 'commercialIntent'
  | 'serviceSpecialty'
  | 'retailStructure'
  | 'channelAudience'
  | 'propertyAgency'
  | 'commercialProperty'
  | 'recruitment'
  | 'infoProduct'
  | 'buyout'
  | 'highRisk'
  | 'dealEvidence'
  | 'contactEvidence'
  | 'priceStructure'
  | 'cta'
  | 'massDistribution';

export type CommercialPatternEvidence =
  | 'BORDERLINE'
  | 'STRUCTURED'
  | 'DIRECT'
  | 'HIGH_RISK'
  | 'HARD_NEGATIVE';

export type CommercialPatternRule = {
  id: string;
  subtype: CommercialSubtype | 'HARD_NEGATIVE';
  taxonomyClass: CommercialTaxonomyClass;
  pattern: RegExp;
  weight: number;
  evidence: CommercialPatternEvidence;
  fpRisk: number;
  examples: readonly string[];
};

export type CommercialSignalState = {
  score: number;
  matchedSignals: string[];
  negativeSignals: string[];
  hasIntent: boolean;
  hasServiceOfferContext: boolean;
  hasServiceSpecialtyContext: boolean;
  hasPrice: boolean;
  hasContact: boolean;
  hasPhoneContact: boolean;
  hasDealChannel: boolean;
  hasTransactional: boolean;
  hasDealSignal: boolean;
  hasPromoContext: boolean;
  hasBusinessContext: boolean;
  hasBuyoutContext: boolean;
  hasRecruitmentContext: boolean;
  hasInfoProductContext: boolean;
  hasGroupPromotionIntent: boolean;
  hasGroupPromoContext: boolean;
  hasCommercialAudienceContext: boolean;
  hasChannelPlacementContext: boolean;
  hasSearchRequestContext: boolean;
  hasJobSeekingContext: boolean;
  hasServiceContext: boolean;
  hasCallToActionContext: boolean;
  hasCommercialContext: boolean;
  hasCampaignContext: boolean;
  hasPrivateSaleContext: boolean;
  hasPropertyPrivateContext: boolean;
  hasPropertyAgentContext: boolean;
  hasCommercialPropertyContext: boolean;
  hasGoodsRetailContext: boolean;
  hasPrivateGoodsItemContext: boolean;
  hasStrongNegativeContext: boolean;
};

export type CommercialClassification = {
  primarySubtype: CommercialSubtype;
  supportingSubtypes: CommercialSubtype[];
  evidenceStrength: CommercialLegacyEvidenceStrength;
  reviewRecommended: boolean;
  reviewReasons: string[];
};

export type CommercialSubtypePolicy = {
  subtype: CommercialSubtype;
  taxonomyClass: CommercialTaxonomyClass;
  requiredAnchors: readonly CommercialRequiredAnchor[];
  deleteAllowedEvidence: readonly CommercialEvidenceTier[];
  ambiguousActionBands: readonly CommercialActionBand[];
};

export type CommercialActionBand =
  | 'ALLOW'
  | 'REVIEW_ONLY'
  | 'WARN'
  | 'DELETE'
  | 'DELETE_AND_ESCALATE';

export type CommercialEvidenceTier =
  | 'NONE'
  | 'BORDERLINE'
  | 'STRUCTURED'
  | 'CAMPAIGN'
  | 'DIRECT'
  | 'HIGH_RISK';

export type CommercialLegacyEvidenceStrength = Exclude<
  CommercialEvidenceTier,
  'NONE' | 'HIGH_RISK'
>;

export type CommercialFeatureVector = {
  commercialIntent: number;
  dealEvidence: number;
  contactEvidence: number;
  businessContext: number;
  massDistribution: number;
  priceStructure: number;
  cta: number;
  negativePrivateContext: number;
  questionContext: number;
  highRisk: number;
};

export type CommercialExplainableDecision = {
  decisionVersion: string;
  score: number;
  fpRisk: number;
  policyFpRisk?: number;
  evidenceTier: CommercialEvidenceTier;
  subtype: CommercialSubtype;
  actionBand: CommercialActionBand;
  reasonCodes: string[];
  featureVector: CommercialFeatureVector;
  campaignContext: CommercialCampaignContext | null;
  decisionBand: CommercialDecisionBand;
};
