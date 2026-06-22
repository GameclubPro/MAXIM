import { resolveCommercialActionPolicy } from './commercial-action-policy';
import type { CommercialActionPolicyInput } from './commercial-action-policy';

const BASE_INPUT: CommercialActionPolicyInput = {
  confidenceScore: 80,
  deleteThreshold: 55,
  warnThreshold: 38,
  fpRisk: 10,
  evidenceTier: 'BORDERLINE',
  subtype: 'SERVICES',
  reviewRecommended: false,
  reviewReasons: [],
  missingRequiredAnchors: [],
  featureVector: {
    commercialIntent: 1,
    dealEvidence: 1,
    contactEvidence: 1,
    businessContext: 1,
    massDistribution: 0,
    priceStructure: 1,
    cta: 0,
    negativePrivateContext: 0,
    questionContext: 0,
    highRisk: 0,
  },
  safeContextBucket: 'none',
  campaignStrength: 'NONE',
  hasCampaignContext: false,
  hasDirectDealEvidence: false,
  hasNonCampaignDirectDealEvidence: false,
  hasHighRiskEvidence: false,
  hasEscalationRiskEvidence: false,
};

const actionOf = (input: Partial<CommercialActionPolicyInput>) =>
  resolveCommercialActionPolicy({ ...BASE_INPUT, ...input }).actionBand;

describe('commercial action policy', () => {
  it('allows messages below warn threshold', () => {
    const decision = resolveCommercialActionPolicy({
      ...BASE_INPUT,
      confidenceScore: 37,
    });

    expect(decision.actionBand).toBe('ALLOW');
    expect(decision.actionable).toBe(false);
    expect(decision.recordable).toBe(false);
  });

  it('starts warning exactly at the warn threshold', () => {
    expect(actionOf({ confidenceScore: BASE_INPUT.warnThreshold })).toBe('WARN');
  });

  it('starts deleting exactly at the delete threshold with action-direct evidence', () => {
    expect(
      actionOf({
        confidenceScore: BASE_INPUT.deleteThreshold,
        evidenceTier: 'DIRECT',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('DELETE');
  });

  it('keeps campaign-only detections out of delete actions', () => {
    expect(
      actionOf({
        hasCampaignContext: true,
        campaignStrength: 'STRONG',
        reviewRecommended: false,
      }),
    ).toBe('WARN');
    expect(
      actionOf({
        hasCampaignContext: true,
        campaignStrength: 'STRONG',
        reviewRecommended: true,
      }),
    ).toBe('REVIEW_ONLY');
  });

  it('keeps campaign-only escalation-grade detections out of delete actions', () => {
    expect(
      actionOf({
        confidenceScore: 100,
        fpRisk: 0,
        evidenceTier: 'HIGH_RISK',
        hasCampaignContext: true,
        campaignStrength: 'STRONG',
        hasHighRiskEvidence: true,
        hasEscalationRiskEvidence: true,
        reviewRecommended: false,
      }),
    ).toBe('REVIEW_ONLY');
    expect(
      actionOf({
        confidenceScore: 100,
        fpRisk: 0,
        evidenceTier: 'HIGH_RISK',
        hasCampaignContext: true,
        campaignStrength: 'STRONG',
        hasHighRiskEvidence: true,
        hasEscalationRiskEvidence: true,
        reviewRecommended: true,
      }),
    ).toBe('REVIEW_ONLY');
  });

  it('does not delete classifier-direct evidence without action-direct deal evidence', () => {
    expect(
      actionOf({
        evidenceTier: 'DIRECT',
        hasDirectDealEvidence: false,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('WARN');
  });

  it('deletes when direct action evidence and subtype anchors are present', () => {
    expect(
      actionOf({
        evidenceTier: 'DIRECT',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('DELETE');
  });

  it('keeps reviewRecommended from blocking high-confidence direct delete by itself', () => {
    expect(
      actionOf({
        evidenceTier: 'DIRECT',
        reviewRecommended: true,
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('DELETE');
  });

  it('escalates escalation-grade high-risk detections above delete threshold', () => {
    expect(
      actionOf({
        fpRisk: 90,
        evidenceTier: 'HIGH_RISK',
        subtype: 'GOODS',
        hasHighRiskEvidence: true,
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
        hasEscalationRiskEvidence: true,
      }),
    ).toBe('DELETE_AND_ESCALATE');
  });

  it('does not escalate non-escalation risk evidence by itself', () => {
    expect(
      actionOf({
        evidenceTier: 'HIGH_RISK',
        hasHighRiskEvidence: true,
        hasEscalationRiskEvidence: false,
      }),
    ).toBe('WARN');
  });

  it('keeps high false-positive risk without escalation evidence out of delete actions', () => {
    expect(
      actionOf({
        evidenceTier: 'DIRECT',
        fpRisk: 90,
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('WARN');
  });

  it('routes high false-positive review detections to review-only', () => {
    expect(
      actionOf({
        evidenceTier: 'DIRECT',
        fpRisk: 90,
        reviewRecommended: true,
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('REVIEW_ONLY');
  });

  it('keeps the high false-positive guard boundary at 70 for direct evidence', () => {
    expect(
      actionOf({
        evidenceTier: 'DIRECT',
        fpRisk: 69,
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('DELETE');
    expect(
      actionOf({
        evidenceTier: 'DIRECT',
        fpRisk: 70,
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('WARN');
  });

  it('warns or reviews medium-band detections even with direct evidence', () => {
    expect(
      actionOf({
        confidenceScore: 54,
        evidenceTier: 'DIRECT',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('WARN');
    expect(
      actionOf({
        confidenceScore: 54,
        evidenceTier: 'DIRECT',
        reviewRecommended: true,
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('REVIEW_ONLY');
  });

  it('suppresses delete in safe context buckets even with direct evidence', () => {
    const decision = resolveCommercialActionPolicy({
      ...BASE_INPUT,
      evidenceTier: 'DIRECT',
      safeContextBucket: 'news_or_analytics',
      hasDirectDealEvidence: true,
      hasNonCampaignDirectDealEvidence: true,
    });

    expect(decision.actionBand).toBe('REVIEW_ONLY');
    expect(decision.deleteSuppressed).toBe(true);
    expect(decision.suppressionReasons).toContain('safe-context:news_or_analytics');
  });

  it('keeps private one-off sales out of hard delete unless risk or strong business campaign exists', () => {
    expect(
      actionOf({
        evidenceTier: 'DIRECT',
        subtype: 'GOODS_RETAIL',
        safeContextBucket: 'private_one_off_sale',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('REVIEW_ONLY');
    expect(
      actionOf({
        evidenceTier: 'HIGH_RISK',
        subtype: 'GOODS',
        safeContextBucket: 'private_one_off_sale',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
        hasHighRiskEvidence: true,
        hasEscalationRiskEvidence: true,
      }),
    ).toBe('DELETE_AND_ESCALATE');
  });

  it('suppresses hard delete when subtype required anchors are missing', () => {
    const decision = resolveCommercialActionPolicy({
      ...BASE_INPUT,
      evidenceTier: 'DIRECT',
      hasDirectDealEvidence: true,
      hasNonCampaignDirectDealEvidence: true,
      missingRequiredAnchors: ['serviceSpecialty'],
    });

    expect(decision.actionBand).toBe('REVIEW_ONLY');
    expect(decision.suppressionReasons).toContain('missing-subtype-anchor');
  });

  it('keeps generic goods delete conservative without high-risk or strong campaign evidence', () => {
    expect(
      actionOf({
        evidenceTier: 'DIRECT',
        subtype: 'GOODS',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('WARN');
  });
});
