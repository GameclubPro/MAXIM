import type { ChatSettings } from '../../prisma/prisma-client';
import type { CommercialCampaignContext } from '../commercial-campaign.util';
import { resolveCommercialThresholds } from '../rule-engine-commercial-thresholds';
import type { CommercialDecisionBand, CommercialSubtype } from '../rule-engine.contract';
import { enrichCommercialDetection } from './commercial-explain';
import {
  collectCommercialSignals,
  hasCommercialSpamMarkers as hasCommercialSpamMarkersInText,
  hasExplicitSelfPromotionalCommercialContext,
  hasPrivateGoodsCommercialOverride,
  hasRideShareContext,
  isLikelyPrivateLowQuantityGoodsListing,
} from './commercial-features';
import {
  CommercialSecondStageScorer,
  hasStrongCommercialCampaignEvidence,
} from './commercial-scorer';
import { classifyCommercialDetection } from './commercial-subtypes';
import type { CommercialLegacyEvidenceStrength } from './commercial.types';

export type CommercialDetection = {
  confidenceScore: number;
  decisionBand: CommercialDecisionBand;
  matchedSignals: string[];
  negativeSignals: string[];
  primarySubtype: CommercialSubtype;
  supportingSubtypes: CommercialSubtype[];
  evidenceStrength: CommercialLegacyEvidenceStrength;
  reviewRecommended: boolean;
  reviewReasons: string[];
  campaignContext: CommercialCampaignContext | null;
  appliedThresholds: {
    warnThreshold: number;
    deleteThreshold: number;
    sensitivity: 'BALANCED' | 'STRICT';
    strictness: number;
  };
  classifierVersion: string | null;
  commercialProbability: number | null;
  reviewProbability: number | null;
  classifierReasons: string[];
  decisionVersion?: string;
  score?: number;
  fpRisk?: number;
  evidenceTier?: string;
  subtype?: CommercialSubtype;
  actionBand?: string;
  reasonCodes?: string[];
  featureVector?: Record<string, number>;
};

export class CommercialAdDetector {
  private readonly commercialSecondStageScorer = new CommercialSecondStageScorer();

  detect(params: {
    normalizedText: string;
    rawLoweredText: string;
    settings: ChatSettings;
    commercialCampaignContext?: CommercialCampaignContext | null;
  }): CommercialDetection | null {
    const detection = this.detectCommercialAd(params);
    return detection ? enrichCommercialDetection(detection) : null;
  }

  hasCommercialSpamMarkers(text: string): boolean {
    return hasCommercialSpamMarkersInText(text);
  }

  private detectCommercialAd(params: {
    normalizedText: string;
    rawLoweredText: string;
    settings: ChatSettings;
    commercialCampaignContext?: CommercialCampaignContext | null;
  }): CommercialDetection | null {
    const { normalizedText, rawLoweredText, settings, commercialCampaignContext } = params;

    if (!normalizedText || normalizedText.length < 6) {
      return null;
    }

    const appliedThresholds = resolveCommercialThresholds(settings);
    const state = collectCommercialSignals({
      normalizedText,
      rawLoweredText,
      profile: appliedThresholds,
      commercialCampaignContext,
    });
    if (state.matchedSignals.length === 0 || !state.hasCommercialContext || !state.hasDealSignal) {
      return null;
    }

    const hasStandardCommercialEvidence =
      state.hasPrice || state.hasContact || state.hasDealChannel || state.hasTransactional;
    const hasCampaignStrongEvidence = hasStrongCommercialCampaignEvidence(
      commercialCampaignContext,
      state,
    );
    const hasStructuredVacancyContactEvidence =
      state.hasContact && state.matchedSignals.includes('risk:structured-job-vacancy');
    const hasStructuredBuyoutPhoneEvidence =
      state.hasBuyoutContext &&
      state.hasPhoneContact &&
      !state.hasSearchRequestContext &&
      !state.hasPrivateSaleContext &&
      !state.hasPrivateGoodsItemContext;
    const hasStructuredServicePhoneEvidence =
      state.hasServiceContext &&
      state.hasPhoneContact &&
      !state.hasSearchRequestContext &&
      !state.hasPrivateSaleContext &&
      !state.hasPrivateGoodsItemContext &&
      (appliedThresholds.strictness >= 0.2 ||
        state.matchedSignals.includes('intent:language-lessons'));
    const hasStructuredPropertyContactEvidence =
      (state.hasPropertyAgentContext || state.hasCommercialPropertyContext) &&
      state.hasContact &&
      !state.hasSearchRequestContext;
    const hasStructuredRetailTransactionalEvidence =
      state.hasGoodsRetailContext &&
      (state.hasPhoneContact ||
        state.hasDealChannel ||
        state.hasPrice ||
        (state.hasTransactional &&
          state.matchedSignals.includes('goods-retail:clearance-stock-retail'))) &&
      !state.hasSearchRequestContext &&
      !state.hasPrivateGoodsItemContext;
    const hasStrongCommercialEvidence =
      state.hasPrice ||
      state.hasDealChannel ||
      (state.hasContact && state.hasTransactional) ||
      hasStructuredVacancyContactEvidence ||
      hasStructuredBuyoutPhoneEvidence ||
      hasStructuredServicePhoneEvidence ||
      hasStructuredPropertyContactEvidence ||
      hasStructuredRetailTransactionalEvidence ||
      hasCampaignStrongEvidence;
    const hasStructuredCommercialContext =
      state.hasPromoContext ||
      state.hasBusinessContext ||
      state.hasBuyoutContext ||
      state.hasRecruitmentContext ||
      state.hasInfoProductContext ||
      state.hasGroupPromoContext ||
      state.hasServiceContext ||
      state.hasCommercialPropertyContext ||
      state.hasGoodsRetailContext ||
      state.hasCampaignContext;
    const hasSelfPromotionalCommercialContext = hasExplicitSelfPromotionalCommercialContext(state);
    const hasPrivateSaleCommercialOverride =
      state.hasPropertyAgentContext ||
      state.hasCommercialPropertyContext ||
      state.hasBusinessContext ||
      state.hasGroupPromoContext ||
      state.hasCommercialAudienceContext ||
      state.hasRecruitmentContext ||
      state.hasBuyoutContext ||
      state.hasInfoProductContext ||
      state.hasGoodsRetailContext ||
      (state.hasServiceContext &&
        (!state.hasPropertyPrivateContext || state.hasServiceOfferContext)) ||
      state.hasServiceOfferContext;
    const hasPrivateLowQuantityGoodsListing =
      isLikelyPrivateLowQuantityGoodsListing(rawLoweredText);

    if (state.hasPrivateSaleContext && !hasPrivateSaleCommercialOverride) {
      return null;
    }

    if (state.hasSearchRequestContext && !hasSelfPromotionalCommercialContext) {
      return null;
    }

    if (
      state.hasSearchRequestContext &&
      !state.hasPrice &&
      !state.hasContact &&
      !state.hasDealChannel
    ) {
      return null;
    }

    if (state.hasJobSeekingContext) {
      return null;
    }

    if (
      hasRideShareContext(rawLoweredText) &&
      !state.hasBusinessContext &&
      !state.hasDealChannel &&
      !state.hasPrice
    ) {
      return null;
    }

    if (
      (state.hasPrivateGoodsItemContext || hasPrivateLowQuantityGoodsListing) &&
      !hasPrivateGoodsCommercialOverride(state)
    ) {
      return null;
    }

    if (
      appliedThresholds.strictness < 0.35 &&
      !(hasStructuredCommercialContext && hasStrongCommercialEvidence)
    ) {
      return null;
    }

    if (
      appliedThresholds.strictness < 0.65 &&
      !(hasStructuredCommercialContext && hasStandardCommercialEvidence)
    ) {
      return null;
    }

    let confidenceScore = Math.round(Math.max(0, Math.min(100, state.score)));
    if (
      state.hasStrongNegativeContext &&
      !state.hasPrice &&
      !state.hasContact &&
      !state.hasDealChannel
    ) {
      confidenceScore = Math.min(confidenceScore, appliedThresholds.warnThreshold - 1);
    }

    if (confidenceScore >= appliedThresholds.deleteThreshold) {
      const hasStrongCommercialCombo =
        state.hasCommercialContext &&
        (state.hasTransactional || state.hasContact || state.hasDealChannel || state.hasPrice);
      if (!hasStrongCommercialCombo) {
        confidenceScore = Math.max(
          appliedThresholds.warnThreshold,
          appliedThresholds.deleteThreshold - 1,
        );
      }
    }

    let decisionBand: CommercialDecisionBand =
      confidenceScore >= appliedThresholds.deleteThreshold
        ? 'HIGH'
        : confidenceScore >= appliedThresholds.warnThreshold
          ? 'MEDIUM'
          : 'LOW';
    let classification = classifyCommercialDetection({
      state,
      confidenceScore,
      decisionBand,
      appliedThresholds,
      hasCampaignDependentEvidence:
        state.hasCampaignContext &&
        hasStrongCommercialCampaignEvidence(commercialCampaignContext, state),
    });
    const secondStage = this.commercialSecondStageScorer.evaluate({
      normalizedText,
      rawLoweredText,
      state,
      confidenceScore,
      decisionBand,
      appliedThresholds,
      classification,
      commercialCampaignContext,
    });
    if (secondStage) {
      confidenceScore = secondStage.adjustedConfidenceScore;
      decisionBand =
        confidenceScore >= appliedThresholds.deleteThreshold
          ? 'HIGH'
          : confidenceScore >= appliedThresholds.warnThreshold
            ? 'MEDIUM'
            : 'LOW';
      classification = {
        ...classification,
        primarySubtype: secondStage.primarySubtype,
        supportingSubtypes: secondStage.supportingSubtypes,
        reviewRecommended: secondStage.reviewRecommended,
        reviewReasons: secondStage.reviewReasons,
      };
    }

    if (confidenceScore < appliedThresholds.warnThreshold) {
      return null;
    }

    return {
      confidenceScore,
      decisionBand,
      matchedSignals: state.matchedSignals,
      negativeSignals: state.negativeSignals,
      primarySubtype: classification.primarySubtype,
      supportingSubtypes: classification.supportingSubtypes,
      evidenceStrength: classification.evidenceStrength,
      reviewRecommended: classification.reviewRecommended,
      reviewReasons: classification.reviewReasons,
      campaignContext: state.hasCampaignContext ? (commercialCampaignContext ?? null) : null,
      appliedThresholds,
      classifierVersion: secondStage?.classifierVersion ?? null,
      commercialProbability: secondStage?.commercialProbability ?? null,
      reviewProbability: secondStage?.reviewProbability ?? null,
      classifierReasons: secondStage?.classifierReasons ?? [],
    };
  }
}
