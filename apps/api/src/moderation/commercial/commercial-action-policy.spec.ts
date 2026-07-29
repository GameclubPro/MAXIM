import { resolveCommercialActionPolicy } from './commercial-action-policy';
import type { CommercialActionPolicyInput } from './commercial-action-policy';
import type { CommercialSafeContextBucket } from './commercial-safe-context';

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
  hasLocalEscalationOfferEvidence: false,
  hasStructuredTransportEvidence: false,
  hasReviewOnlyTransportEvidence: false,
  hasConservativeRecallEvidence: false,
  hasIndependentCommercialOfferEvidence: false,
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
        hasLocalEscalationOfferEvidence: true,
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
        hasLocalEscalationOfferEvidence: true,
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
        hasLocalEscalationOfferEvidence: true,
      }),
    ).toBe('DELETE_AND_ESCALATE');
  });

  it('keeps non-local escalation evidence non-actionable', () => {
    const decision = resolveCommercialActionPolicy({
      ...BASE_INPUT,
      evidenceTier: 'HIGH_RISK',
      subtype: 'GOODS',
      hasHighRiskEvidence: true,
      hasDirectDealEvidence: true,
      hasNonCampaignDirectDealEvidence: true,
      hasEscalationRiskEvidence: true,
      hasLocalEscalationOfferEvidence: false,
    });

    expect(decision.actionBand).toBe('REVIEW_ONLY');
    expect(decision.actionable).toBe(false);
    expect(decision.recordable).toBe(false);
    expect(decision.suppressionReasons).toContain('non-local-escalation-offer');
  });

  it('keeps an independent offer actionable beside a non-local warning context', () => {
    const decision = resolveCommercialActionPolicy({
      ...BASE_INPUT,
      evidenceTier: 'HIGH_RISK',
      subtype: 'SERVICES',
      safeContextBucket: 'spam_complaint_or_fraud_warning',
      hasHighRiskEvidence: true,
      hasDirectDealEvidence: true,
      hasNonCampaignDirectDealEvidence: true,
      hasEscalationRiskEvidence: true,
      hasLocalEscalationOfferEvidence: false,
      hasIndependentCommercialOfferEvidence: true,
      hasWarnCappedRecallEvidence: true,
    });

    expect(decision.actionBand).toBe('WARN');
    expect(decision.actionable).toBe(true);
    expect(decision.suppressionReasons).toContain('non-local-escalation-offer');
    expect(decision.suppressionReasons).not.toContain(
      'safe-context:spam_complaint_or_fraud_warning',
    );
    expect(decision.suppressionReasons).not.toContain('bounded-recall-warn-cap');
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

  it('applies exact warn and review caps to rescue-only evidence', () => {
    expect(
      actionOf({
        evidenceTier: 'DIRECT',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
        hasWarnCappedRecallEvidence: true,
      }),
    ).toBe('WARN');
    expect(
      actionOf({
        evidenceTier: 'DIRECT',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
        hasReviewCappedRecallEvidence: true,
      }),
    ).toBe('REVIEW_ONLY');
  });

  it('keeps an independent warn-capped rescue actionable beside review-only recall', () => {
    const decision = resolveCommercialActionPolicy({
      ...BASE_INPUT,
      evidenceTier: 'DIRECT',
      hasDirectDealEvidence: true,
      hasNonCampaignDirectDealEvidence: true,
      hasWarnCappedRecallEvidence: true,
      hasReviewCappedRecallEvidence: true,
    });

    expect(decision.actionBand).toBe('WARN');
    expect(decision.suppressionReasons).toContain('bounded-recall-warn-cap');
    expect(decision.suppressionReasons).not.toContain('bounded-recall-review-cap');
  });

  it('keeps a safe context non-actionable before applying a rescue cap', () => {
    const decision = resolveCommercialActionPolicy({
      ...BASE_INPUT,
      evidenceTier: 'DIRECT',
      safeContextBucket: 'private_one_off_sale',
      hasDirectDealEvidence: true,
      hasNonCampaignDirectDealEvidence: true,
      hasIndependentCommercialOfferEvidence: true,
      hasWarnCappedRecallEvidence: true,
    });

    expect(decision.actionBand).toBe('REVIEW_ONLY');
    expect(decision.actionable).toBe(false);
    expect(decision.suppressionReasons).toContain('safe-context:private_one_off_sale');
    expect(decision.suppressionReasons).not.toContain('bounded-recall-warn-cap');
  });

  it('keeps bounded high-risk recall ahead of a weak private-context collision', () => {
    const decision = resolveCommercialActionPolicy({
      ...BASE_INPUT,
      evidenceTier: 'HIGH_RISK',
      safeContextBucket: 'private_one_off_sale',
      hasHighRiskEvidence: true,
      hasWarnCappedRecallEvidence: true,
    });

    expect(decision.actionBand).toBe('WARN');
    expect(decision.suppressionReasons).toContain('bounded-recall-warn-cap');
    expect(decision.suppressionReasons).not.toContain('safe-context:private_one_off_sale');
  });

  it('does not let a rescue cap weaken an independently deletable offer', () => {
    expect(
      actionOf({
        evidenceTier: 'DIRECT',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
        hasIndependentCommercialOfferEvidence: true,
        hasWarnCappedRecallEvidence: true,
      }),
    ).toBe('DELETE');
  });

  it('does not let a rescue cap weaken escalation-grade evidence', () => {
    expect(
      actionOf({
        evidenceTier: 'HIGH_RISK',
        subtype: 'GOODS',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
        hasHighRiskEvidence: true,
        hasEscalationRiskEvidence: true,
        hasLocalEscalationOfferEvidence: true,
        hasReviewCappedRecallEvidence: true,
      }),
    ).toBe('DELETE_AND_ESCALATE');
  });

  it('caps structured transport evidence at warn without independent escalation risk', () => {
    const decision = resolveCommercialActionPolicy({
      ...BASE_INPUT,
      evidenceTier: 'DIRECT',
      hasDirectDealEvidence: true,
      hasNonCampaignDirectDealEvidence: true,
      hasStructuredTransportEvidence: true,
    });

    expect(decision.actionBand).toBe('WARN');
    expect(decision.deleteSuppressed).toBe(true);
    expect(decision.suppressionReasons).toContain('structured-transport-warn-cap');
  });

  it('preserves independent escalation risk on structured transport evidence', () => {
    const decision = resolveCommercialActionPolicy({
      ...BASE_INPUT,
      evidenceTier: 'HIGH_RISK',
      hasDirectDealEvidence: true,
      hasNonCampaignDirectDealEvidence: true,
      hasHighRiskEvidence: true,
      hasEscalationRiskEvidence: true,
      hasLocalEscalationOfferEvidence: true,
      hasStructuredTransportEvidence: true,
    });

    expect(decision.actionBand).toBe('DELETE_AND_ESCALATE');
    expect(decision.suppressionReasons).not.toContain('structured-transport-warn-cap');
  });

  it('does not let structured transport weaken an independent commercial offer', () => {
    const decision = resolveCommercialActionPolicy({
      ...BASE_INPUT,
      evidenceTier: 'DIRECT',
      hasDirectDealEvidence: true,
      hasNonCampaignDirectDealEvidence: true,
      hasStructuredTransportEvidence: true,
      hasIndependentCommercialOfferEvidence: true,
    });

    expect(decision.actionBand).toBe('DELETE');
    expect(decision.suppressionReasons).not.toContain('structured-transport-warn-cap');
  });

  it('routes non-scoring ambiguous transport metadata to review-only', () => {
    const decision = resolveCommercialActionPolicy({
      ...BASE_INPUT,
      confidenceScore: 0,
      reviewRecommended: true,
      featureVector: {
        commercialIntent: 0,
        dealEvidence: 0,
        contactEvidence: 0,
        businessContext: 0,
        massDistribution: 0,
        priceStructure: 0,
        cta: 0,
        negativePrivateContext: 0,
        questionContext: 0,
        highRisk: 0,
      },
      hasReviewOnlyTransportEvidence: true,
    });

    expect(decision.actionBand).toBe('REVIEW_ONLY');
    expect(decision.actionScore).toBe(0);
    expect(decision.actionable).toBe(false);
    expect(decision.recordable).toBe(false);
    expect(decision.suppressionReasons).toContain('ambiguous-transport-review-only');
  });

  it('does not let ambiguous transport metadata weaken an existing action', () => {
    expect(
      actionOf({
        evidenceTier: 'DIRECT',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
        hasReviewOnlyTransportEvidence: true,
        hasIndependentCommercialOfferEvidence: true,
      }),
    ).toBe('DELETE');
    expect(
      actionOf({
        evidenceTier: 'DIRECT',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
        hasStructuredTransportEvidence: true,
        hasReviewOnlyTransportEvidence: true,
      }),
    ).toBe('WARN');
  });

  it('caps conservative recall evidence at warn when it is necessary for the decision', () => {
    const decision = resolveCommercialActionPolicy({
      ...BASE_INPUT,
      evidenceTier: 'DIRECT',
      hasDirectDealEvidence: true,
      hasNonCampaignDirectDealEvidence: true,
      hasConservativeRecallEvidence: true,
    });

    expect(decision.actionBand).toBe('WARN');
    expect(decision.suppressionReasons).toContain('conservative-recall-warn-cap');
  });

  it('preserves independent delete and escalation evidence beside conservative recall', () => {
    expect(
      actionOf({
        evidenceTier: 'DIRECT',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
        hasConservativeRecallEvidence: true,
        hasIndependentCommercialOfferEvidence: true,
      }),
    ).toBe('DELETE');
    expect(
      actionOf({
        evidenceTier: 'HIGH_RISK',
        hasDirectDealEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
        hasHighRiskEvidence: true,
        hasEscalationRiskEvidence: true,
        hasLocalEscalationOfferEvidence: true,
        hasConservativeRecallEvidence: true,
      }),
    ).toBe('DELETE_AND_ESCALATE');
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

  it.each<CommercialSafeContextBucket>([
    'rules_or_moderation_context',
    'spam_complaint_or_fraud_warning',
    'news_or_analytics',
    'brand_mention_only',
    'private_one_off_sale',
    'ordinary_recruitment',
    'public_training_or_help',
    'request_or_recommendation',
  ])('suppresses delete in safe context bucket %s even with strong risk evidence', (bucket) => {
    const decision = resolveCommercialActionPolicy({
      ...BASE_INPUT,
      confidenceScore: 100,
      evidenceTier: 'HIGH_RISK',
      subtype: 'GOODS_RETAIL',
      safeContextBucket: bucket,
      campaignStrength: 'STRONG',
      hasCampaignContext: true,
      hasDirectDealEvidence: true,
      hasNonCampaignDirectDealEvidence: true,
      hasHighRiskEvidence: true,
      hasEscalationRiskEvidence: true,
      hasLocalEscalationOfferEvidence: true,
      featureVector: {
        ...BASE_INPUT.featureVector,
        businessContext: 1,
        massDistribution: 1,
        highRisk: 1,
      },
    });

    expect(decision.actionBand).toBe('REVIEW_ONLY');
    expect(decision.reviewPriority).toBe('URGENT');
    expect(decision.deleteSuppressed).toBe(true);
    expect(decision.suppressionReasons).toContain(`safe-context:${bucket}`);
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
