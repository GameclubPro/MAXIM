import type { CommercialCampaignContext } from '../commercial-campaign.util';
import {
  CommercialSecondStageDecisionCache,
  COMMERCIAL_SECOND_STAGE_VERSION,
  type CommercialSecondStageDecision,
} from '../rule-engine-commercial-second-stage-cache';
import type { CommercialThresholdProfile } from '../rule-engine-commercial-thresholds';
import type { CommercialDecisionBand, CommercialSubtype } from '../rule-engine.contract';
import { estimateCommercialFpRisk } from './commercial-explain';
import {
  hasStrongCommercialCampaignEvidence,
  resolveCommercialEvidenceProfile,
} from './commercial-evidence';
import { isCommercialDeleteAction } from './commercial-subtypes';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import {
  ADS_GOODS_FRESH_STOCK_PATTERN,
  ADS_GOODS_VARIANT_MARKER_GLOBAL_PATTERN,
  ADS_MULTI_SKU_PRICE_LINE_PATTERN,
  ADS_PERSONAL_RESALE_ONCE_PATTERN,
  ADS_PERSONAL_RESALE_STRONG_PATTERN,
  ADS_PRICE_CAPTURE_GLOBAL_PATTERN,
  ADS_RETAIL_INVENTORY_PATTERN,
  ADS_RETAIL_ORDER_FLOW_PATTERN,
  ADS_REVIEW_CLEARING_HIGH_RISK_SIGNALS,
} from './commercial-patterns';
import { countPatternMatches, hasPriceLikeText } from './commercial-match-utils';
import type {
  CommercialActionBand,
  CommercialClassification,
  CommercialEvidenceTier,
  CommercialSignalState,
} from './commercial.types';

export { estimateCommercialFpRisk };

export function canCommercialActionDelete(params: {
  actionBand: CommercialActionBand | string | null;
  evidenceTier: CommercialEvidenceTier | string | null;
  hasHighRiskEvidence: boolean;
  hasEscalationRiskEvidence?: boolean;
  hasDirectDealEvidence: boolean;
  fpRisk: number | null;
}): boolean {
  if (!isCommercialDeleteAction(params.actionBand)) {
    return false;
  }

  if (params.hasEscalationRiskEvidence === true) {
    return true;
  }

  if (params.fpRisk !== null && params.fpRisk >= 70) {
    return false;
  }

  return params.hasDirectDealEvidence;
}

export function sigmoid(value: number): number {
  if (value >= 0) {
    const exponent = Math.exp(-value);
    return 1 / (1 + exponent);
  }

  const exponent = Math.exp(value);
  return exponent / (1 + exponent);
}

function shouldRunCommercialSecondStage(params: {
  state: CommercialSignalState;
  confidenceScore: number;
  decisionBand: CommercialDecisionBand;
  appliedThresholds: CommercialThresholdProfile;
  classification: CommercialClassification;
}): boolean {
  const { state, confidenceScore, decisionBand, appliedThresholds, classification } = params;
  const runConfig = COMMERCIAL_ENGINE_CONFIG.secondStage.run;
  return (
    confidenceScore <= appliedThresholds.deleteThreshold + runConfig.deleteWindow ||
    decisionBand === 'LOW' ||
    classification.reviewRecommended ||
    classification.primarySubtype === 'GOODS' ||
    classification.primarySubtype === 'GENERIC' ||
    state.hasGoodsRetailContext ||
    state.hasCommercialPropertyContext ||
    (state.hasCampaignContext &&
      confidenceScore <= appliedThresholds.deleteThreshold + runConfig.campaignDeleteWindow) ||
    (state.hasPrivateSaleContext &&
      !state.hasPropertyAgentContext &&
      !state.hasCommercialPropertyContext) ||
    (state.hasGoodsRetailContext && classification.primarySubtype !== 'GOODS_RETAIL') ||
    (state.hasCommercialPropertyContext && classification.primarySubtype !== 'PROPERTY_COMMERCIAL')
  );
}

export class CommercialSecondStageScorer {
  private readonly cache = new CommercialSecondStageDecisionCache();

  evaluate(params: {
    normalizedText: string;
    rawLoweredText: string;
    state: CommercialSignalState;
    confidenceScore: number;
    decisionBand: CommercialDecisionBand;
    appliedThresholds: CommercialThresholdProfile;
    classification: CommercialClassification;
    commercialCampaignContext?: CommercialCampaignContext | null;
  }): CommercialSecondStageDecision | null {
    const {
      normalizedText,
      rawLoweredText,
      state,
      confidenceScore,
      decisionBand,
      appliedThresholds,
      classification,
      commercialCampaignContext,
    } = params;
    const secondStageConfig = COMMERCIAL_ENGINE_CONFIG.secondStage;
    const commercialLogitConfig = secondStageConfig.commercialLogit;
    const reviewLogitConfig = secondStageConfig.reviewLogit;

    if (
      !shouldRunCommercialSecondStage({
        state,
        confidenceScore,
        decisionBand,
        appliedThresholds,
        classification,
      })
    ) {
      return null;
    }

    const cacheKey = this.cache.buildKey({
      normalizedText,
      confidenceScore,
      decisionBand,
      appliedThresholds,
      classification,
      commercialCampaignContext,
    });
    const cached = this.cache.read(cacheKey);
    if (cached) {
      return cached;
    }

    const evidence = resolveCommercialEvidenceProfile({
      state,
      appliedThresholds,
      commercialCampaignContext,
    });
    const directDealEvidence = evidence.hasClassifierDirectDealEvidence;
    const strongCampaignEvidence = evidence.hasStrongCampaignEvidence;
    const structuredEvidence = evidence.hasStructuredEvidence;
    const priceMatchCount =
      (hasPriceLikeText(rawLoweredText) &&
        countPatternMatches(rawLoweredText, ADS_PRICE_CAPTURE_GLOBAL_PATTERN)) ||
      (hasPriceLikeText(normalizedText) &&
        countPatternMatches(normalizedText, ADS_PRICE_CAPTURE_GLOBAL_PATTERN)) ||
      0;
    const phoneMatchCount = rawLoweredText.match(/(?:\+?\d[\d\s()/-]{8,}\d)/g)?.length ?? 0;
    const multiSkuPriceLineCount = countPatternMatches(
      rawLoweredText,
      ADS_MULTI_SKU_PRICE_LINE_PATTERN,
      secondStageConfig.countLimits.multiSkuEvidence,
    );
    const goodsVariantMarkerCount = countPatternMatches(
      rawLoweredText,
      ADS_GOODS_VARIANT_MARKER_GLOBAL_PATTERN,
      secondStageConfig.countLimits.multiSkuEvidence,
    );
    const hasPriceRange = /(?:^|[^\p{L}\p{N}_-])от\s+\d{2,}/iu.test(rawLoweredText);
    const hasFreshStockContext = ADS_GOODS_FRESH_STOCK_PATTERN.test(rawLoweredText);
    const hasRetailOrderFlow =
      ADS_RETAIL_ORDER_FLOW_PATTERN.test(rawLoweredText) ||
      ADS_RETAIL_INVENTORY_PATTERN.test(rawLoweredText);
    const hasMultiSkuGoodsStructure =
      multiSkuPriceLineCount >= 2 || (priceMatchCount >= 2 && goodsVariantMarkerCount >= 1);
    const hasPersonalResalePattern =
      ADS_PERSONAL_RESALE_STRONG_PATTERN.test(rawLoweredText) ||
      ADS_PERSONAL_RESALE_ONCE_PATTERN.test(rawLoweredText);
    const hasStrongDealCombo =
      state.matchedSignals.includes('combo:contact+price') ||
      state.matchedSignals.includes('combo:business+deal') ||
      state.matchedSignals.includes('combo:promo+deal') ||
      state.matchedSignals.includes('combo:service+deal') ||
      state.matchedSignals.includes('combo:service-offer+deal') ||
      state.matchedSignals.includes('combo:group-promo+deal') ||
      state.matchedSignals.includes('combo:campaign+deal');
    const scoreMargin = confidenceScore - appliedThresholds.warnThreshold;

    let commercialLogit =
      commercialLogitConfig.base + scoreMargin / commercialLogitConfig.scoreMarginDivisor;
    if (state.hasPrice) {
      commercialLogit += commercialLogitConfig.price;
    }
    if (state.hasContact) {
      commercialLogit += commercialLogitConfig.contact;
    }
    if (state.hasDealChannel) {
      commercialLogit += commercialLogitConfig.dealChannel;
    }
    if (state.hasTransactional) {
      commercialLogit += commercialLogitConfig.transactional;
    }
    if (state.hasBusinessContext) {
      commercialLogit += commercialLogitConfig.businessContext;
    }
    if (state.hasPromoContext) {
      commercialLogit += commercialLogitConfig.promoContext;
    }
    if (state.hasGoodsRetailContext) {
      commercialLogit += commercialLogitConfig.goodsRetailContext;
    }
    if (state.hasCommercialPropertyContext) {
      commercialLogit += commercialLogitConfig.commercialPropertyContext;
    }
    if (state.hasPropertyAgentContext) {
      commercialLogit += commercialLogitConfig.propertyAgentContext;
    }
    if (state.hasServiceContext) {
      commercialLogit += commercialLogitConfig.serviceContext;
    }
    if (state.hasRecruitmentContext) {
      commercialLogit += commercialLogitConfig.recruitmentContext;
    }
    if (state.hasInfoProductContext) {
      commercialLogit += commercialLogitConfig.infoProductContext;
    }
    if (state.hasGroupPromoContext) {
      commercialLogit += commercialLogitConfig.groupPromoContext;
    }
    if (structuredEvidence) {
      commercialLogit += commercialLogitConfig.structuredEvidence;
    }
    if (strongCampaignEvidence) {
      commercialLogit += commercialLogitConfig.strongCampaignEvidence;
    } else if (state.hasCampaignContext) {
      commercialLogit += commercialLogitConfig.weakCampaignEvidence;
    }
    if (priceMatchCount >= 2 || hasPriceRange) {
      commercialLogit += commercialLogitConfig.repeatedPriceEvidence;
    }
    if (phoneMatchCount >= 2) {
      commercialLogit += commercialLogitConfig.repeatedPhoneEvidence;
    }
    if (hasMultiSkuGoodsStructure) {
      commercialLogit += commercialLogitConfig.multiSkuGoods;
    }
    if (hasFreshStockContext) {
      commercialLogit += commercialLogitConfig.freshStock;
    }
    if (hasRetailOrderFlow) {
      commercialLogit += commercialLogitConfig.retailOrderFlow;
    }
    if (hasStrongDealCombo) {
      commercialLogit += commercialLogitConfig.strongDealCombo;
    }
    if (state.hasPrivateGoodsItemContext) {
      commercialLogit += commercialLogitConfig.privateGoodsPenalty;
    }
    if (
      state.hasPrivateSaleContext &&
      !state.hasBusinessContext &&
      !state.hasCampaignContext &&
      !state.hasGoodsRetailContext &&
      !state.hasCommercialPropertyContext &&
      !state.hasPropertyAgentContext
    ) {
      commercialLogit += commercialLogitConfig.privateSalePenalty;
    }
    if (
      state.hasPropertyPrivateContext &&
      !state.hasCommercialPropertyContext &&
      !state.hasPropertyAgentContext
    ) {
      commercialLogit += commercialLogitConfig.privatePropertyPenalty;
    }
    if (state.hasSearchRequestContext || state.hasJobSeekingContext) {
      commercialLogit += commercialLogitConfig.searchOrJobPenalty;
    }
    if (state.hasStrongNegativeContext) {
      commercialLogit += commercialLogitConfig.strongNegativePenalty;
    }
    if (state.negativeSignals.length >= 2) {
      commercialLogit += commercialLogitConfig.multipleNegativeSignalsPenalty;
    }
    if (hasPersonalResalePattern) {
      commercialLogit += commercialLogitConfig.personalResalePenalty;
    }
    if (
      hasMultiSkuGoodsStructure &&
      hasPersonalResalePattern &&
      !state.hasBusinessContext &&
      !state.hasCampaignContext
    ) {
      commercialLogit += commercialLogitConfig.personalMultiSkuPenalty;
    }

    const commercialProbability = sigmoid(commercialLogit);
    const classifierReasons: string[] = [];
    let adjustedConfidenceScore = confidenceScore;

    if (
      decisionBand === 'LOW' &&
      confidenceScore >=
        appliedThresholds.warnThreshold - commercialLogitConfig.rescueWindowBelowWarn &&
      commercialProbability >= commercialLogitConfig.rescueProbability &&
      structuredEvidence &&
      (state.hasPrice || state.hasContact || state.hasDealChannel || state.hasTransactional)
    ) {
      adjustedConfidenceScore = Math.max(
        adjustedConfidenceScore,
        appliedThresholds.warnThreshold +
          Math.round(
            (commercialProbability - commercialLogitConfig.rescueProbability) *
              commercialLogitConfig.rescueScale,
          ) +
          1,
      );
      classifierReasons.push('rescued-borderline');
    }

    if (
      adjustedConfidenceScore >= appliedThresholds.warnThreshold &&
      commercialProbability <= commercialLogitConfig.suppressPrivateLikeProbability &&
      (classification.primarySubtype === 'GOODS' || classification.primarySubtype === 'GENERIC') &&
      (state.hasPrivateSaleContext ||
        state.hasPrivateGoodsItemContext ||
        state.hasStrongNegativeContext)
    ) {
      adjustedConfidenceScore = Math.min(
        adjustedConfidenceScore,
        appliedThresholds.warnThreshold - 1,
      );
      classifierReasons.push('suppressed-private-like');
    }

    if (
      adjustedConfidenceScore >= appliedThresholds.warnThreshold &&
      commercialProbability >= commercialLogitConfig.structuredBoostProbability &&
      adjustedConfidenceScore < appliedThresholds.deleteThreshold &&
      structuredEvidence &&
      directDealEvidence
    ) {
      adjustedConfidenceScore = Math.min(
        100,
        adjustedConfidenceScore + commercialLogitConfig.structuredBoostScoreDelta,
      );
      classifierReasons.push('boosted-structured');
    }

    let primarySubtype = classification.primarySubtype;
    const supportingSubtypes = [...classification.supportingSubtypes];
    const pushSupportingSubtype = (subtype: CommercialSubtype) => {
      if (subtype === primarySubtype || supportingSubtypes.includes(subtype)) {
        return;
      }
      supportingSubtypes.unshift(subtype);
      supportingSubtypes.splice(COMMERCIAL_ENGINE_CONFIG.subtypeScores.maxSupportingSubtypes);
    };

    if (
      state.hasCommercialPropertyContext &&
      commercialProbability >= commercialLogitConfig.propertyCommercialProbability &&
      primarySubtype !== 'PROPERTY_AGENT' &&
      primarySubtype !== 'PROPERTY_COMMERCIAL'
    ) {
      pushSupportingSubtype(primarySubtype);
      primarySubtype = 'PROPERTY_COMMERCIAL';
      classifierReasons.push('subtype:property-commercial');
    } else if (
      state.hasGoodsRetailContext &&
      commercialProbability >= commercialLogitConfig.goodsRetailProbability &&
      (primarySubtype === 'GOODS' ||
        primarySubtype === 'GENERIC' ||
        (primarySubtype === 'SERVICES' &&
          state.matchedSignals.some(
            (signal) =>
              signal === 'goods-retail:home-food-order' ||
              signal === 'goods-retail:home-dairy-retail' ||
              signal === 'goods-retail:home-goods-low-price-order' ||
              signal === 'goods-retail:order-flow' ||
              signal === 'goods-retail:wholesale-produce' ||
              signal === 'goods-retail:poultry-farm-order',
          )))
    ) {
      pushSupportingSubtype(primarySubtype);
      primarySubtype = 'GOODS_RETAIL';
      classifierReasons.push('subtype:goods-retail');
    } else if (
      hasMultiSkuGoodsStructure &&
      !hasPersonalResalePattern &&
      commercialProbability >= commercialLogitConfig.goodsMultiSkuProbability &&
      state.hasContact &&
      state.hasPrice &&
      (primarySubtype === 'GOODS' || primarySubtype === 'GENERIC')
    ) {
      pushSupportingSubtype(primarySubtype);
      primarySubtype = 'GOODS_RETAIL';
      classifierReasons.push('subtype:goods-multi-sku');
    }

    const adjustedDecisionBand: CommercialDecisionBand =
      adjustedConfidenceScore >= appliedThresholds.deleteThreshold
        ? 'HIGH'
        : adjustedConfidenceScore >= appliedThresholds.warnThreshold
          ? 'MEDIUM'
          : 'LOW';

    let reviewLogit = reviewLogitConfig.base;
    if (adjustedDecisionBand !== 'HIGH') {
      reviewLogit += reviewLogitConfig.nonHighDecision;
    } else {
      reviewLogit += reviewLogitConfig.highDecision;
    }
    if (
      adjustedConfidenceScore <=
      appliedThresholds.warnThreshold + reviewLogitConfig.nearWarnWindow
    ) {
      reviewLogit += reviewLogitConfig.nearWarn;
    }
    if (primarySubtype === 'GENERIC' || primarySubtype === 'GOODS') {
      reviewLogit += reviewLogitConfig.genericSubtype;
    }
    if (state.hasCampaignContext && !strongCampaignEvidence) {
      reviewLogit += reviewLogitConfig.weakCampaign;
    } else if (state.hasCampaignContext && strongCampaignEvidence && !directDealEvidence) {
      reviewLogit += reviewLogitConfig.campaignWithoutDirectDeal;
    }
    if (state.hasStrongNegativeContext || state.negativeSignals.length > 0) {
      reviewLogit += reviewLogitConfig.negativeContext;
    }
    if (
      state.hasPrivateSaleContext &&
      (state.hasServiceContext || state.hasGoodsRetailContext || state.hasCommercialPropertyContext)
    ) {
      reviewLogit += reviewLogitConfig.privateSaleMixedContext;
    }
    if (hasMultiSkuGoodsStructure && !hasPersonalResalePattern) {
      reviewLogit += reviewLogitConfig.multiSkuGoods;
    }
    if (hasFreshStockContext || hasRetailOrderFlow) {
      reviewLogit += reviewLogitConfig.retailStructure;
    }
    if (directDealEvidence) {
      reviewLogit += reviewLogitConfig.directDeal;
    }
    if (structuredEvidence) {
      reviewLogit += reviewLogitConfig.structuredEvidence;
    }
    if (
      (primarySubtype === 'GOODS_RETAIL' ||
        primarySubtype === 'PROPERTY_COMMERCIAL' ||
        primarySubtype === 'PROPERTY_AGENT') &&
      adjustedConfidenceScore >= appliedThresholds.deleteThreshold
    ) {
      reviewLogit += reviewLogitConfig.strongStructuredSubtype;
    }
    if (commercialProbability < reviewLogitConfig.lowCommercialProbabilityThreshold) {
      reviewLogit += reviewLogitConfig.lowCommercialProbability;
    }
    if (
      commercialProbability > reviewLogitConfig.highCommercialProbabilityThreshold &&
      structuredEvidence
    ) {
      reviewLogit += reviewLogitConfig.highCommercialProbability;
    }

    const reviewProbability = sigmoid(reviewLogit);
    let reviewReasons = [...classification.reviewReasons];
    if (primarySubtype !== 'GOODS' && primarySubtype !== 'GENERIC') {
      reviewReasons = reviewReasons.filter((reason) => reason !== 'generic-subtype');
    }
    if (
      (primarySubtype === 'GOODS_RETAIL' || primarySubtype === 'PROPERTY_COMMERCIAL') &&
      adjustedConfidenceScore >= appliedThresholds.deleteThreshold &&
      directDealEvidence
    ) {
      reviewReasons = reviewReasons.filter(
        (reason) =>
          reason !== 'private-sale-override' &&
          reason !== 'conflicting-negative-signals' &&
          reason !== 'near-threshold' &&
          reason !== 'medium-band',
      );
    }
    if (
      primarySubtype === 'GOODS_RETAIL' &&
      hasMultiSkuGoodsStructure &&
      adjustedConfidenceScore >= appliedThresholds.deleteThreshold &&
      directDealEvidence
    ) {
      reviewReasons = reviewReasons.filter(
        (reason) => reason !== 'generic-subtype' && reason !== 'near-threshold',
      );
    }

    const hasHardReviewReason =
      reviewReasons.includes('campaign-dependent') || reviewReasons.includes('paid-review-work');
    let reviewRecommended =
      reviewReasons.length > 0 &&
      (adjustedDecisionBand !== 'HIGH' ||
        reviewReasons.includes('campaign-dependent') ||
        reviewReasons.includes('paid-review-work') ||
        reviewReasons.includes('generic-subtype') ||
        reviewReasons.includes('conflicting-negative-signals'));

    const hasReviewClearingHighRiskEvidence = state.matchedSignals.some((signal) =>
      ADS_REVIEW_CLEARING_HIGH_RISK_SIGNALS.has(signal),
    );

    if (hasReviewClearingHighRiskEvidence && adjustedDecisionBand === 'HIGH') {
      reviewRecommended = false;
      reviewReasons = [];
      classifierReasons.push('cleared-high-risk');
    } else if (
      !hasHardReviewReason &&
      reviewProbability <= reviewLogitConfig.clearReviewProbability &&
      adjustedDecisionBand === 'HIGH' &&
      structuredEvidence &&
      directDealEvidence
    ) {
      reviewRecommended = false;
      reviewReasons = [];
      classifierReasons.push('cleared-review');
    } else if (
      reviewProbability >= reviewLogitConfig.ambiguousReviewProbability &&
      adjustedConfidenceScore >= appliedThresholds.warnThreshold
    ) {
      reviewRecommended = true;
      if (!reviewReasons.includes('classifier-ambiguous')) {
        reviewReasons.push('classifier-ambiguous');
      }
      classifierReasons.push('review:ambiguous');
    }

    const decision: CommercialSecondStageDecision = {
      adjustedConfidenceScore,
      primarySubtype,
      supportingSubtypes: [...new Set(supportingSubtypes)].slice(
        0,
        COMMERCIAL_ENGINE_CONFIG.subtypeScores.maxSupportingSubtypes,
      ),
      reviewRecommended,
      reviewReasons: [...new Set(reviewReasons)],
      classifierVersion: COMMERCIAL_SECOND_STAGE_VERSION,
      commercialProbability: Number(commercialProbability.toFixed(4)),
      reviewProbability: Number(reviewProbability.toFixed(4)),
      classifierReasons,
    };
    this.cache.remember(cacheKey, decision);
    return decision;
  }
}
