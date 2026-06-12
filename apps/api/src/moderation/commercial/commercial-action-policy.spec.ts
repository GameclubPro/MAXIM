import { resolveCommercialActionPolicy } from './commercial-action-policy';

const BASE_INPUT = {
  confidenceScore: 80,
  deleteThreshold: 55,
  warnThreshold: 38,
  fpRisk: 10,
  evidenceTier: 'BORDERLINE' as const,
  reviewRecommended: false,
  hasCampaignContext: false,
  hasDirectDealEvidence: false,
  hasNonCampaignDirectDealEvidence: false,
  hasHighRiskEvidence: false,
  hasEscalationRiskEvidence: false,
};

describe('commercial action policy', () => {
  it('allows messages below warn threshold', () => {
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        confidenceScore: 37,
      }),
    ).toBe('ALLOW');
  });

  it('starts warning exactly at the warn threshold', () => {
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        confidenceScore: BASE_INPUT.warnThreshold,
      }),
    ).toBe('WARN');
  });

  it('starts deleting exactly at the delete threshold with action-direct evidence', () => {
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        confidenceScore: BASE_INPUT.deleteThreshold,
        evidenceTier: 'DIRECT',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('DELETE');
  });

  it('keeps campaign-only detections out of delete actions', () => {
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        hasCampaignContext: true,
        reviewRecommended: false,
      }),
    ).toBe('WARN');
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        hasCampaignContext: true,
        reviewRecommended: true,
      }),
    ).toBe('REVIEW_ONLY');
  });

  it('keeps campaign-only escalation-grade detections out of delete actions', () => {
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        confidenceScore: 100,
        fpRisk: 0,
        evidenceTier: 'HIGH_RISK',
        hasCampaignContext: true,
        hasHighRiskEvidence: true,
        hasEscalationRiskEvidence: true,
        reviewRecommended: false,
      }),
    ).toBe('WARN');
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        confidenceScore: 100,
        fpRisk: 0,
        evidenceTier: 'HIGH_RISK',
        hasCampaignContext: true,
        hasHighRiskEvidence: true,
        hasEscalationRiskEvidence: true,
        reviewRecommended: true,
      }),
    ).toBe('REVIEW_ONLY');
  });

  it('does not delete classifier-direct evidence without action-direct deal evidence', () => {
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        evidenceTier: 'DIRECT',
        hasDirectDealEvidence: false,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('WARN');
  });

  it('deletes when direct action evidence is present', () => {
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        evidenceTier: 'STRUCTURED',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('DELETE');
  });

  it('keeps reviewRecommended from blocking high-confidence direct delete by itself', () => {
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        evidenceTier: 'STRUCTURED',
        reviewRecommended: true,
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('DELETE');
  });

  it('escalates high-risk detections above delete threshold', () => {
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        fpRisk: 90,
        hasHighRiskEvidence: true,
        hasEscalationRiskEvidence: true,
      }),
    ).toBe('DELETE_AND_ESCALATE');
  });

  it('does not escalate non-escalation risk evidence by itself', () => {
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        evidenceTier: 'HIGH_RISK',
        hasHighRiskEvidence: true,
        hasEscalationRiskEvidence: false,
      }),
    ).toBe('WARN');
  });

  it('keeps high false-positive risk without high-risk evidence out of delete actions', () => {
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        evidenceTier: 'DIRECT',
        fpRisk: 90,
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('WARN');
  });

  it('routes high false-positive review detections to review-only', () => {
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
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
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        evidenceTier: 'DIRECT',
        fpRisk: 69,
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('DELETE');
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        evidenceTier: 'DIRECT',
        fpRisk: 70,
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('WARN');
  });

  it('keeps non-escalation risk evidence under high false-positive guard', () => {
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        evidenceTier: 'HIGH_RISK',
        fpRisk: 90,
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
        hasHighRiskEvidence: true,
        hasEscalationRiskEvidence: false,
      }),
    ).toBe('WARN');
  });

  it('warns or reviews medium-band detections even with direct evidence', () => {
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        confidenceScore: 54,
        evidenceTier: 'DIRECT',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('WARN');
    expect(
      resolveCommercialActionPolicy({
        ...BASE_INPUT,
        confidenceScore: 54,
        evidenceTier: 'DIRECT',
        reviewRecommended: true,
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
      }),
    ).toBe('REVIEW_ONLY');
  });
});
