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
import { normalizeCommercialText } from './commercial-normalization';
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
    const { rawLoweredText, settings, commercialCampaignContext } = params;
    const normalizedText = normalizeCommercialText(params.normalizedText);

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
    const hasBalancedStructuredServicePhoneAnchor = [
      'intent:language-lessons',
      'intent:строительная-бригада',
      'intent:все-виды-работ',
      'intent:crane-beam-under-key',
      'intent:window-door-maintenance',
      'intent:custom-art-order',
      'intent:construction-multi-service',
      'intent:занимаюсь-услугами',
      'service-specialty:appliance-repair',
      'service-specialty:custom-handmade-order',
      'service-specialty:custom-art-order',
      'service-specialty:crane-beam-installation',
      'service-specialty:pvc-window-door-repair',
      'service-specialty:speech-therapy-lessons',
      'service-specialty:tree-yard-repair-service',
      'service-specialty:yard-cleanup-service',
      'service-specialty:paving-landscaping-service',
    ].some((signal) => state.matchedSignals.includes(signal));
    const hasStructuredServicePhoneEvidence =
      state.hasServiceContext &&
      state.hasPhoneContact &&
      !state.hasSearchRequestContext &&
      !state.hasPrivateSaleContext &&
      !state.hasPrivateGoodsItemContext &&
      (appliedThresholds.strictness >= 0.2 || hasBalancedStructuredServicePhoneAnchor);
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

    if (state.hasJobSeekingContext && !hasRecruitmentOfferOverride(state)) {
      return null;
    }

    if (isOfficialAppStoreReferenceNoise(state, rawLoweredText)) {
      return null;
    }

    if (isLikelyDeliveryDiscussionNoise(state, rawLoweredText)) {
      return null;
    }

    if (
      hasRideShareContext(rawLoweredText) &&
      !hasRideShareCommercialOverride(state) &&
      !state.hasBusinessContext &&
      !state.hasDealChannel &&
      !state.hasRecruitmentContext &&
      !state.hasGoodsRetailContext &&
      !state.hasGroupPromoContext &&
      !state.hasCommercialAudienceContext
    ) {
      return null;
    }

    if (
      (state.hasPrivateGoodsItemContext || hasPrivateLowQuantityGoodsListing) &&
      !hasPrivateGoodsCommercialOverride(state)
    ) {
      return null;
    }

    if (hasCommercialDiscussionHardNegative(state.negativeSignals)) {
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

function hasRecruitmentOfferOverride(state: ReturnType<typeof collectCommercialSignals>): boolean {
  if (!state.hasRecruitmentContext) {
    return false;
  }

  const hasOfferMarker = state.matchedSignals.some((signal) =>
    RECRUITMENT_OFFER_OVERRIDE_SIGNALS.has(signal),
  );
  if (!hasOfferMarker) {
    return false;
  }

  return state.matchedSignals.some(
    (signal) =>
      signal === 'combo:recruitment+deal' ||
      signal === 'risk:structured-job-vacancy' ||
      signal === 'contact:implicit-vacancy-offer' ||
      signal === 'contact:recruitment-response-keyword',
  );
}

const RECRUITMENT_OFFER_OVERRIDE_SIGNALS = new Set([
  'recruitment:ваканси',
  'recruitment:сотрудничеств',
  'recruitment:отклик',
  'recruitment:требуется',
  'recruitment:набор',
  'recruitment:ищет-команду',
  'recruitment:приглашаем-на-должность',
  'recruitment:приглашает-на-службу',
  'recruitment:приглашаем-роли',
  'recruitment:вахта-условия',
  'recruitment:warehouse-job-conditions',
  'recruitment:работа-условия',
  'recruitment:people-work-conditions',
  'recruitment:набирают-специалистов',
  'recruitment:есть-работа',
  'recruitment:marketplace-review-work',
  'recruitment:роль-условия',
  'recruitment:leaflet-daily-side-job',
  'recruitment:leaflet-assembly-work',
  'recruitment:remote-network-work',
  'recruitment:hr-chat-recruiter',
  'recruitment:свободное-рабочее-место',
  'recruitment:контрактная-служба',
  'recruitment:контрактная-служба-мо',
  'risk:structured-job-vacancy',
]);

function isOfficialAppStoreReferenceNoise(
  state: ReturnType<typeof collectCommercialSignals>,
  rawLoweredText: string,
): boolean {
  if (state.hasPrice || state.hasContact || state.hasTransactional) {
    return false;
  }

  const hasOfficialAppStoreRisk = state.matchedSignals.some(
    (signal) =>
      signal === 'risk:app-store-directory-promo' || signal === 'risk:app-store-directory-link',
  );
  const hasOnlyOfficialAppStoreLinkContext =
    state.matchedSignals.includes('business:официально') &&
    state.matchedSignals.includes('deal-channel:link') &&
    state.matchedSignals.every(
      (signal) =>
        signal === 'business:официально' ||
        signal === 'deal-channel:link' ||
        signal === 'risk:app-store-directory-promo' ||
        signal === 'risk:app-store-directory-link' ||
        signal === 'combo:business+deal',
    );
  if (!hasOnlyOfficialAppStoreLinkContext && !hasOfficialAppStoreRisk) {
    return false;
  }

  return (
    /(?:apps\.apple\.com|play\.google\.com\/store)/iu.test(rawLoweredText) &&
    /(?:официальн[\p{L}\p{N}_-]*\s+приложени[\p{L}\p{N}_-]*|госуслуг[\p{L}\p{N}_-]*)/iu.test(
      rawLoweredText,
    )
  );
}

function hasCommercialDiscussionHardNegative(negativeSignals: readonly string[]): boolean {
  return negativeSignals.some(
    (signal) =>
      signal === 'context:quoted-ad-example' ||
      signal === 'context:moderation-ad-discussion' ||
      signal === 'context:resale-pricing-discussion' ||
      signal === 'context:channel-metrics-not-selling' ||
      signal === 'context:public-fraud-warning' ||
      signal === 'context:official-civic-instruction',
  );
}

function hasRideShareCommercialOverride(
  state: ReturnType<typeof collectCommercialSignals>,
): boolean {
  return state.matchedSignals.some(
    (signal) =>
      signal.startsWith('service-specialty:') &&
      signal !== 'service-specialty:перевозк' &&
      signal !== 'service-specialty:logistics-delivery',
  );
}

function isLikelyDeliveryDiscussionNoise(
  state: ReturnType<typeof collectCommercialSignals>,
  rawLoweredText: string,
): boolean {
  if (
    !state.matchedSignals.includes('promo:доставк') ||
    state.hasIntent ||
    state.hasBusinessContext ||
    state.hasBuyoutContext ||
    state.hasRecruitmentContext ||
    state.hasInfoProductContext ||
    state.hasServiceContext ||
    state.hasServiceOfferContext ||
    state.hasServiceSpecialtyContext ||
    state.hasGoodsRetailContext ||
    state.hasGroupPromoContext ||
    state.hasCommercialAudienceContext ||
    state.hasChannelPlacementContext ||
    state.hasPropertyAgentContext ||
    state.hasCommercialPropertyContext ||
    state.hasCampaignContext ||
    state.hasPrice ||
    state.hasPhoneContact ||
    state.hasDealChannel
  ) {
    return false;
  }

  const hasOnlyWeakContact = state.matchedSignals.some(
    (signal) =>
      signal === 'contact:в личк' ||
      signal === 'contact:в личные сообщения' ||
      signal === 'contact:личные сообщения' ||
      signal === 'contact:пишите в лич' ||
      signal === 'contact:пишите в личные сообщения' ||
      signal === 'contact:писать в личку',
  );
  if (!hasOnlyWeakContact) {
    return false;
  }

  return /(?:^|[^\p{L}\p{N}_-])(?:мне|меня|она|он|они|я\s+писал[аи]?|пишет|звонит|адрес|удалил[аи]?|разборк[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
    rawLoweredText,
  );
}
