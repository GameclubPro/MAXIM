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
  isThirdPartyServiceRecommendationWithoutCurrentOffer,
} from './commercial-features';
import {
  isCommercialEscalationRiskSignal,
  resolveCommercialEvidenceProfile,
} from './commercial-evidence';
import { resolveCommercialLocalContext } from './commercial-local-context';
import { collectFirstPatternLabels, createCommercialTextMatcher } from './commercial-match-utils';
import { CommercialSecondStageScorer } from './commercial-scorer';
import { normalizeCommercialRawText, normalizeCommercialText } from './commercial-normalization';
import { ADS_AMBIGUOUS_TRANSPORT_REVIEW_PATTERNS } from './commercial-patterns';
import { classifyCommercialDetection } from './commercial-subtypes';
import type { CommercialLegacyEvidenceStrength } from './commercial.types';

const COMMERCIAL_WARMUP_SETTINGS = {
  commercialAdsSensitivity: 'BALANCED',
  commercialAdsWarnThreshold: 57,
  commercialAdsDeleteThreshold: 77,
} as unknown as ChatSettings;

const COMMERCIAL_WARMUP_TEXTS = [
  'ГРУЗОПЕРЕВОЗКИ +7 900 000 10 42',
  'Приглашаю на окрашивание, окудрение, флисинг, карвинг и реконструкцию волос. Пиши/звони +7 900 000 10 43.',
  'Откройте для себя коллекцию селективных ароматов. Полный флакон 2400₽, мини-версия 250₽.',
  'Всем привет. Добро пожаловать в мой Мир страз: изделия ручной работы, портреты со скидкой, мой канал.',
] as const;

const AMBIGUOUS_TRANSPORT_REVIEW_PREFILTER =
  /(?:водител|пассажир|(?:^|[^\p{L}\p{N}_-])еду(?=$|[^\p{L}\p{N}_-]))/iu;
const MIXED_PROTECTED_COMMERCIAL_CONTEXT_PREFILTER =
  /(?:^|[.!?;\n])\s*(?:(?:(?:а|но)\s+)?(?:отдельно|также|другая\s+тема|по\s+другой\s+теме|ещ[её]\s+одно\s+предложение)\s*[:,-]?|(?:(?:а|но)\s+)?(?:у\s+нас|мы|наш[аи]\s+компани[яи]|я\s+(?:помогу|помогаю|предлагаю|оформлю|выдам))\b)/iu;
const BOUNDARY_LOCAL_CURRENT_OFFER_PREFILTER =
  /[.!?;\n]\s*[^.!?;\n]{0,320}(?:пишите?|напишите?|звоните?|обращайтесь|остав(?:ьте|ляйте)\s+заявк[\p{L}\p{N}_-]*|получите|оформите|закаж(?:ите|и|ем|у)|заказывайте|регистрируйтесь|переходите|свяжитесь|записывайтесь|запис[ьи\p{L}\p{N}_-]*\s+в\s+(?:лс|личк[\p{L}\p{N}_-]*))(?=$|[^\p{L}\p{N}_-])/iu;

let commercialDetectorWarmUpComplete = false;
let commercialDetectorWarmUpInProgress = false;

export type CommercialDetection = {
  rawText: string;
  analysisText?: string;
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
  hasActionDirectDealEvidence?: boolean;
  hasNonCampaignDirectDealEvidence?: boolean;
  hasEscalationRiskEvidence?: boolean;
  decisionVersion?: string;
  score?: number;
  actionScore?: number;
  fpRisk?: number;
  policyFpRisk?: number;
  evidenceTier?: string;
  subtype?: CommercialSubtype;
  actionBand?: string;
  reviewPriority?: string;
  campaignStrength?: string;
  safeContextBucket?: string;
  actionable?: boolean;
  recordable?: boolean;
  deleteSuppressed?: boolean;
  suppressionReasons?: string[];
  reasonCodes?: string[];
  featureVector?: Record<string, number>;
};

export class CommercialAdDetector {
  private readonly commercialSecondStageScorer = new CommercialSecondStageScorer();

  constructor() {
    this.warmUpProcessPatterns();
  }

  detect(params: {
    normalizedText: string;
    rawLoweredText: string;
    settings: ChatSettings;
    commercialCampaignContext?: CommercialCampaignContext | null;
  }): CommercialDetection | null {
    const detection = this.detectCommercialAd(params);
    const reviewSignals = collectAmbiguousTransportReviewSignals(params);
    if (!detection && reviewSignals.length === 0) {
      return null;
    }

    if (!detection) {
      return enrichCommercialDetection(
        buildAmbiguousTransportReviewDetection(params, reviewSignals),
      );
    }

    for (const signal of reviewSignals) {
      if (!detection.matchedSignals.includes(signal)) {
        detection.matchedSignals.push(signal);
      }
    }
    return enrichCommercialDetection(detection);
  }

  hasCommercialSpamMarkers(text: string): boolean {
    return hasCommercialSpamMarkersInText(text);
  }

  private warmUpProcessPatterns(): void {
    if (commercialDetectorWarmUpComplete || commercialDetectorWarmUpInProgress) {
      return;
    }

    commercialDetectorWarmUpInProgress = true;
    try {
      for (const text of COMMERCIAL_WARMUP_TEXTS) {
        this.detectCommercialAd({
          normalizedText: normalizeCommercialText(text),
          rawLoweredText: text.toLowerCase(),
          settings: COMMERCIAL_WARMUP_SETTINGS,
          commercialCampaignContext: null,
        });
      }
      commercialDetectorWarmUpComplete = true;
    } finally {
      commercialDetectorWarmUpInProgress = false;
    }
  }

  private detectCommercialAd(params: {
    normalizedText: string;
    rawLoweredText: string;
    settings: ChatSettings;
    commercialCampaignContext?: CommercialCampaignContext | null;
  }): CommercialDetection | null {
    const { settings, commercialCampaignContext } = params;
    let analysisCampaignContext = commercialCampaignContext;
    let rawLoweredText = normalizeCommercialRawText(params.rawLoweredText);
    let normalizedText = normalizeCommercialText(rawLoweredText || params.normalizedText);

    if (!normalizedText || normalizedText.length < 6) {
      return null;
    }

    const appliedThresholds = resolveCommercialThresholds(settings);
    let state = collectCommercialSignals({
      normalizedText,
      rawLoweredText,
      profile: appliedThresholds,
      commercialCampaignContext,
    });
    const shouldInspectOrdinaryProtectedContext =
      (MIXED_PROTECTED_COMMERCIAL_CONTEXT_PREFILTER.test(rawLoweredText) ||
        (state.hasSearchRequestContext &&
          BOUNDARY_LOCAL_CURRENT_OFFER_PREFILTER.test(rawLoweredText))) &&
      !state.matchedSignals.some(isCommercialEscalationRiskSignal);
    const localContext = shouldInspectOrdinaryProtectedContext
      ? resolveCommercialLocalContext({
          rawLoweredText,
          escalationRiskLabels: [],
          includeOrdinaryProtectedContext: true,
        })
      : null;
    const localOfferText = localContext?.hasProtectedContext
      ? localContext.independentCommercialOfferText
      : null;
    let isolatedIndependentOffer = false;
    if (localOfferText) {
      const localRawLoweredText = normalizeCommercialRawText(localOfferText);
      const localNormalizedText = normalizeCommercialText(localRawLoweredText);
      const localCampaignContext = retainSenderCommercialCampaignContext(commercialCampaignContext);
      const localState = collectCommercialSignals({
        normalizedText: localNormalizedText,
        rawLoweredText: localRawLoweredText,
        profile: appliedThresholds,
        commercialCampaignContext: localCampaignContext,
      });
      if (
        localState.matchedSignals.length > 0 &&
        localState.hasCommercialContext &&
        localState.hasDealSignal
      ) {
        localState.matchedSignals.push('locality:independent-commercial-offer');
        rawLoweredText = localRawLoweredText;
        normalizedText = localNormalizedText;
        state = localState;
        analysisCampaignContext = localCampaignContext;
        isolatedIndependentOffer = true;
      }
    }
    if (state.matchedSignals.length === 0 || !state.hasCommercialContext || !state.hasDealSignal) {
      return null;
    }

    if (isBareAvailabilityReply(rawLoweredText)) {
      return null;
    }

    const evidence = resolveCommercialEvidenceProfile({
      state,
      appliedThresholds,
      commercialCampaignContext: analysisCampaignContext,
    });
    const hasBoundedRecallEvidence = evidence.hasBoundedRecallEvidence;

    if (
      isThirdPartyServiceRecommendationWithoutCurrentOffer(rawLoweredText, state) &&
      !evidence.hasEscalationRiskEvidence
    ) {
      return null;
    }

    if (
      state.negativeSignals.includes('search-pattern:request:specialist') &&
      /(?:^|[.!?;\n])\s*(?:ищу|нуж(?:ен|на|ны)|посоветуйте|порекомендуйте|подскажите)\s+/iu.test(
        rawLoweredText,
      ) &&
      !hasRecruitmentOfferOverride(state) &&
      !evidence.hasEscalationRiskEvidence &&
      !evidence.hasIndependentCommercialOfferEvidence
    ) {
      return null;
    }

    const hasSelfPromotionalCommercialContext = hasExplicitSelfPromotionalCommercialContext(state);
    const hasPrivateLowQuantityGoodsListing =
      isLikelyPrivateLowQuantityGoodsListing(rawLoweredText);
    const hasOnlyBareQuestionSearchContext =
      state.negativeSignals.length > 0 &&
      state.negativeSignals.every((signal) => signal === 'context:question');
    const hasBareQuestionStructuredOfferEvidence =
      hasOnlyBareQuestionSearchContext &&
      evidence.hasStructuredCommercialContext &&
      state.hasTransactional &&
      (state.hasBusinessContext ||
        state.hasCallToActionContext ||
        state.hasServiceContext ||
        state.hasServiceOfferContext);

    if (
      state.hasPrivateSaleContext &&
      !evidence.hasPrivateSaleCommercialOverride &&
      !evidence.hasEscalationRiskEvidence &&
      !hasBoundedRecallEvidence
    ) {
      return null;
    }

    if (
      state.hasSearchRequestContext &&
      !hasSelfPromotionalCommercialContext &&
      !evidence.hasEscalationRiskEvidence &&
      !hasBareQuestionStructuredOfferEvidence
    ) {
      return null;
    }

    const hasBareQuestionSelfPromoTransactionalEvidence =
      hasBareQuestionStructuredOfferEvidence && hasSelfPromotionalCommercialContext;

    if (
      state.hasSearchRequestContext &&
      !state.hasPrice &&
      !state.hasContact &&
      !state.hasDealChannel &&
      !evidence.hasEscalationRiskEvidence &&
      !hasBoundedRecallEvidence &&
      !hasBareQuestionSelfPromoTransactionalEvidence
    ) {
      return null;
    }

    if (
      state.hasJobSeekingContext &&
      !hasRecruitmentOfferOverride(state) &&
      !hasBoundedRecallEvidence
    ) {
      return null;
    }

    if (isOfficialAppStoreReferenceNoise(state, rawLoweredText)) {
      return null;
    }

    if (isDefaultMaxInviteNoise(state, rawLoweredText)) {
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
      !state.hasCommercialAudienceContext &&
      !hasBoundedRecallEvidence
    ) {
      return null;
    }

    if (
      (state.hasPrivateGoodsItemContext || hasPrivateLowQuantityGoodsListing) &&
      !hasPrivateGoodsCommercialOverride(state) &&
      !evidence.hasEscalationRiskEvidence &&
      !hasBoundedRecallEvidence
    ) {
      return null;
    }

    if (hasCommercialDiscussionHardNegative(state, evidence.hasEscalationRiskEvidence)) {
      return null;
    }

    if (isLikelyThirdPartyChatDirectoryNoise(state, rawLoweredText)) {
      return null;
    }

    if (
      appliedThresholds.strictness < 0.35 &&
      !hasBoundedRecallEvidence &&
      !(evidence.hasStructuredCommercialContext && evidence.hasStrongCommercialEvidence)
    ) {
      return null;
    }

    if (
      appliedThresholds.strictness < 0.65 &&
      !hasBoundedRecallEvidence &&
      !(evidence.hasStructuredCommercialContext && evidence.hasStandardCommercialEvidence)
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
    if (hasBoundedRecallEvidence) {
      confidenceScore = Math.max(confidenceScore, appliedThresholds.warnThreshold);
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
      hasCampaignDependentEvidence: state.hasCampaignContext && evidence.hasStrongCampaignEvidence,
    });
    const secondStage = this.commercialSecondStageScorer.evaluate({
      normalizedText,
      rawLoweredText,
      state,
      confidenceScore,
      decisionBand,
      appliedThresholds,
      classification,
      commercialCampaignContext: analysisCampaignContext,
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

    if (hasBoundedRecallEvidence) {
      confidenceScore = Math.max(confidenceScore, appliedThresholds.warnThreshold);
      decisionBand = confidenceScore >= appliedThresholds.deleteThreshold ? 'HIGH' : 'MEDIUM';
    }

    if (confidenceScore < appliedThresholds.warnThreshold) {
      return null;
    }

    return {
      rawText: params.rawLoweredText,
      ...(isolatedIndependentOffer ? { analysisText: rawLoweredText } : {}),
      confidenceScore,
      decisionBand,
      matchedSignals: state.matchedSignals,
      negativeSignals: state.negativeSignals,
      primarySubtype: classification.primarySubtype,
      supportingSubtypes: classification.supportingSubtypes,
      evidenceStrength: classification.evidenceStrength,
      reviewRecommended: classification.reviewRecommended,
      reviewReasons: classification.reviewReasons,
      campaignContext: state.hasCampaignContext ? (analysisCampaignContext ?? null) : null,
      appliedThresholds,
      classifierVersion: secondStage?.classifierVersion ?? null,
      commercialProbability: secondStage?.commercialProbability ?? null,
      reviewProbability: secondStage?.reviewProbability ?? null,
      classifierReasons: [
        ...(secondStage?.classifierReasons ?? []),
        ...(isolatedIndependentOffer ? ['locality:isolated-independent-commercial-offer'] : []),
      ],
      hasActionDirectDealEvidence: evidence.hasActionDirectDealEvidence,
      hasNonCampaignDirectDealEvidence: evidence.hasNonCampaignDirectDealEvidence,
      hasEscalationRiskEvidence: evidence.hasEscalationRiskEvidence,
    };
  }
}

function retainSenderCommercialCampaignContext(
  context: CommercialCampaignContext | null | undefined,
): CommercialCampaignContext | null {
  if (!context) {
    return null;
  }

  return {
    senderDistinctChatCount: context.senderDistinctChatCount,
    senderDistinctChatCount5m: context.senderDistinctChatCount5m,
    senderDistinctChatCount30m: context.senderDistinctChatCount30m,
    senderDistinctChatCount120m: context.senderDistinctChatCount120m,
    sameTextDistinctChatCount: 0,
    nearTextDistinctChatCount: 0,
    repeatedPhoneDistinctChatCount: 0,
    repeatedLinkDistinctChatCount: 0,
    repeatedDomainDistinctChatCount: 0,
    repeatedHandleDistinctChatCount: 0,
  };
}

function collectAmbiguousTransportReviewSignals(params: {
  normalizedText: string;
  rawLoweredText: string;
}): string[] {
  const hasTransportCandidate = [params.rawLoweredText, params.normalizedText].some(
    (text) =>
      text.length >= 20 && text.length <= 300 && AMBIGUOUS_TRANSPORT_REVIEW_PREFILTER.test(text),
  );
  if (!hasTransportCandidate) {
    return [];
  }

  const rawLoweredText = normalizeCommercialRawText(params.rawLoweredText);
  const normalizedText = normalizeCommercialText(rawLoweredText || params.normalizedText);
  if (!normalizedText || normalizedText.length < 6) {
    return [];
  }

  const matcher = createCommercialTextMatcher(normalizedText, rawLoweredText, {
    rawLoweredTextIsCommercialNormalized: true,
  });
  return collectFirstPatternLabels(
    ADS_AMBIGUOUS_TRANSPORT_REVIEW_PATTERNS,
    matcher.matchesPattern,
    ADS_AMBIGUOUS_TRANSPORT_REVIEW_PATTERNS.length,
  ).map((label) => `review-only:transport-${label}`);
}

function buildAmbiguousTransportReviewDetection(
  params: {
    rawLoweredText: string;
    settings: ChatSettings;
  },
  matchedSignals: string[],
): CommercialDetection {
  return {
    rawText: params.rawLoweredText,
    confidenceScore: 0,
    decisionBand: 'LOW',
    matchedSignals,
    negativeSignals: [],
    primarySubtype: 'SERVICES',
    supportingSubtypes: [],
    evidenceStrength: 'BORDERLINE',
    reviewRecommended: true,
    reviewReasons: ['ambiguous-transport-review-only'],
    campaignContext: null,
    appliedThresholds: resolveCommercialThresholds(params.settings),
    classifierVersion: null,
    commercialProbability: null,
    reviewProbability: null,
    classifierReasons: [],
    hasActionDirectDealEvidence: false,
    hasNonCampaignDirectDealEvidence: false,
    hasEscalationRiskEvidence: false,
  };
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
  'recruitment:bot-income-work',
  'recruitment:роль-условия',
  'recruitment:role-first-vacancy',
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

function hasCommercialDiscussionHardNegative(
  state: ReturnType<typeof collectCommercialSignals>,
  hasEscalationRiskEvidence: boolean,
): boolean {
  const hasCommercialAnimalAdoptionOverride =
    state.negativeSignals.includes('context:animal-adoption') &&
    state.hasPrice &&
    (state.hasContact || state.hasDealChannel || state.hasGoodsRetailContext);
  const hasCommercialFuelRetailOverride =
    state.negativeSignals.includes('context:fuel-availability-report') &&
    state.hasPrice &&
    (state.hasContact ||
      state.hasDealChannel ||
      state.hasBusinessContext ||
      state.hasGoodsRetailContext);

  return state.negativeSignals.some(
    (signal) =>
      signal === 'context:quoted-ad-example' ||
      signal === 'context:commercial-review-question' ||
      signal === 'context:channel-ad-due-diligence' ||
      signal === 'context:marketplace-review-complaint' ||
      signal === 'context:reported-escalation-risk' ||
      signal === 'context:leadgen-training-recap' ||
      signal === 'context:local-news-subscribe' ||
      signal === 'context:moderation-ad-discussion' ||
      signal === 'context:resale-pricing-discussion' ||
      signal === 'context:channel-metrics-not-selling' ||
      signal === 'context:public-fraud-warning' ||
      signal === 'context:official-civic-instruction' ||
      signal === 'context:public-training-or-event' ||
      signal === 'context:public-voting-contest' ||
      signal === 'context:public-service-enrollment' ||
      signal === 'context:currency-rate-news' ||
      signal === 'context:giveaway-results-report' ||
      signal === 'context:pseudomedical-attribution-or-debunking' ||
      (signal === 'context:fuel-availability-report' &&
        !hasCommercialFuelRetailOverride &&
        !hasEscalationRiskEvidence) ||
      (signal === 'context:public-help-request' && !hasEscalationRiskEvidence) ||
      (signal === 'context:animal-adoption' &&
        !hasCommercialAnimalAdoptionOverride &&
        !hasEscalationRiskEvidence),
  );
}

function isDefaultMaxInviteNoise(
  state: ReturnType<typeof collectCommercialSignals>,
  rawLoweredText: string,
): boolean {
  if (state.hasPrice || state.hasPhoneContact || state.hasTransactional) {
    return false;
  }
  if (state.matchedSignals.some((signal) => signal.startsWith('risk:'))) {
    return false;
  }

  const hasExpectedMaxInvite = /(?:\[url\]|https?:\/\/(?:www\.)?max\.ru\/(?:join\/)?\S+)/iu.test(
    rawLoweredText,
  );
  if (!hasExpectedMaxInvite) {
    return false;
  }

  const withoutUrls = rawLoweredText
    .replace(/(?:https?:\/\/\S+|\[url\])/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^я\s+пользуюсь\s+мессенджером\s+max[.!?]?\s*присоединяйся[.!?]?$/iu.test(withoutUrls);
}

function isBareAvailabilityReply(rawLoweredText: string): boolean {
  const compactText = rawLoweredText.replace(/\s+/gu, ' ').trim();
  return /^(?:(?:да|нет|есть)[,.!?:-]?\s+)?(?:(?:там|тут|здесь)\s+)?(?:(?:весь|вся|все|всё)\s+)?в\s+наличи[ие][.!?]*$/iu.test(
    compactText,
  );
}

function isLikelyThirdPartyChatDirectoryNoise(
  state: ReturnType<typeof collectCommercialSignals>,
  rawLoweredText: string,
): boolean {
  if (state.matchedSignals.includes('group-promo:explicit-group-promotion')) {
    return false;
  }

  if (
    state.hasPrice ||
    state.hasContact ||
    state.matchedSignals.some((signal) => signal.startsWith('risk:'))
  ) {
    return false;
  }

  if (!state.hasDealChannel) {
    return false;
  }

  const hasDirectoryWording =
    /(?:^|[^\p{L}\p{N}_-])(?:подборк[\p{L}\p{N}_-]*|список|каталог|навигатор|полезн[\p{L}\p{N}_-]*)(?:[\s\S]{0,100})(?:чат[\p{L}\p{N}_-]*|групп[\p{L}\p{N}_-]*|канал[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    ) ||
    /(?:^|[^\p{L}\p{N}_-])(?:присоединяйся|вступай)(?:[\p{L}\p{N}\s.,:;()/%+-]{0,60})(?:групп[\p{L}\p{N}_-]*|чат(?:ы|ов|ам|ами|ах)|канал(?:ы|ов|ам|ами|ах))(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  if (!hasDirectoryWording) {
    return false;
  }

  const linkCount = rawLoweredText.match(/(?:https?:\/\/|max\.ru\/join\/|\[url\])/giu)?.length ?? 0;
  const numberedItemCount =
    rawLoweredText.match(/(?:^|[\s.,;:])\d{1,2}\s*[.)]\s+\p{L}/giu)?.length ?? 0;
  if (linkCount < 3 && numberedItemCount < 4) {
    return false;
  }

  if (
    /(?:^|[^\p{L}\p{N}_-])(?:размест(?:им|ить|иться)|реклам[\p{L}\p{N}_-]*|рассылк[\p{L}\p{N}_-]*|охват[\p{L}\p{N}_-]*|аудитори[\p{L}\p{N}_-]*|цена\s+за\s+пост|стоимость\s+(?:реклам[\p{L}\p{N}_-]*|размещени[\p{L}\p{N}_-]*)|прайс|продвижени[\p{L}\p{N}_-]*|платим\s+комисси[\p{L}\p{N}_-]*|добавлени[\p{L}\p{N}_-]*\s+платн[\p{L}\p{N}_-]*|платн[\p{L}\p{N}_-]*\s+добавлени[\p{L}\p{N}_-]*|публикаци[\p{L}\p{N}_-]*\s+платн[\p{L}\p{N}_-]*|платн[\p{L}\p{N}_-]*\s+публикаци[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    )
  ) {
    return false;
  }

  return true;
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
  const hasDeliveryPlatformOnboardingOnly =
    state.matchedSignals.includes('service-specialty:delivery-platform-onboarding') &&
    !state.matchedSignals.some(
      (signal) =>
        signal.startsWith('service-specialty:') &&
        signal !== 'service-specialty:delivery-platform-onboarding',
    );
  const hasDeliveryComplaintContext =
    /(?:^|[^\p{L}\p{N}_-])(?:заказал[аи]?|заказ|курьер[\p{L}\p{N}_-]*|ozon|озон|доставк[\p{L}\p{N}_-]*|оплат[\p{L}\p{N}_-]*\s+наличн[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;()/%+-]{0,180})(?:это\s+нормальн[\p{L}\p{N}_-]*|просит|пишет|звонит|мне|меня|в\s+личк[\p{L}\p{N}_-]*|личн[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );

  if (
    !state.matchedSignals.includes('promo:доставк') ||
    state.hasIntent ||
    state.hasBusinessContext ||
    state.hasBuyoutContext ||
    state.hasRecruitmentContext ||
    state.hasInfoProductContext ||
    (state.hasServiceContext && !hasDeliveryPlatformOnboardingOnly) ||
    state.hasServiceOfferContext ||
    (state.hasServiceSpecialtyContext && !hasDeliveryPlatformOnboardingOnly) ||
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

  return (
    hasDeliveryComplaintContext ||
    /(?:^|[^\p{L}\p{N}_-])(?:мне|меня|она|он|они|я\s+писал[аи]?|пишет|звонит|адрес|удалил[аи]?|разборк[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    )
  );
}
