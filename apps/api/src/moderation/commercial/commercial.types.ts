import type { CommercialCampaignContext } from '../commercial-campaign.util';
import type { CommercialDecisionBand, CommercialSubtype } from '../rule-engine.contract';

export type CommercialActionBand =
  | 'ALLOW'
  | 'REVIEW_ONLY'
  | 'WARN'
  | 'DELETE'
  | 'DELETE_AND_ESCALATE';

export type CommercialEvidenceTier = 'NONE' | 'BORDERLINE' | 'STRUCTURED' | 'CAMPAIGN' | 'DIRECT' | 'HIGH_RISK';

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
  evidenceTier: CommercialEvidenceTier;
  subtype: CommercialSubtype;
  actionBand: CommercialActionBand;
  reasonCodes: string[];
  featureVector: CommercialFeatureVector;
  campaignContext: CommercialCampaignContext | null;
  decisionBand: CommercialDecisionBand;
};

