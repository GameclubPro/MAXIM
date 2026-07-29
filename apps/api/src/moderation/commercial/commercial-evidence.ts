import type { CommercialCampaignContext } from '../commercial-campaign.util';
import type { CommercialThresholdProfile } from '../rule-engine-commercial-thresholds';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import type { CommercialSignalState } from './commercial.types';

const PRICE_EVIDENCE_SIGNALS = new Set([
  'transaction:price',
  'transaction:implied-price',
  'combo:contact+price',
]);

const TRANSACTION_DIRECT_DEAL_SIGNALS = new Set([
  'transaction:bot-income-leadgen',
  'transaction:buyout-deal',
  'transaction:handmade-channel-offer',
  'transaction:illicit-document-deal',
  'transaction:illicit-registration-deal',
  'transaction:paid-gambling-entry',
  'transaction:paid-raffle-entry',
  'transaction:paid-review-compensation',
  'transaction:unregulated-medicinal-goods-deal',
  'transaction:wildlife-product-deal',
]);

const STRONG_CONTACT_SIGNALS = new Set([
  'contact:phone',
  'contact:contextual-phone',
  'contact:masked-phone',
  'contact:handle',
  'contact:email',
]);

const ESCALATION_RISK_SIGNALS = new Set([
  'risk:bank-card-leadgen',
  'risk:betting-gambling',
  'risk:bot-income-scam',
  'risk:bulk-client-leadgen',
  'risk:casino-landing-link',
  'risk:casino-slot-promo',
  'risk:crypto-investment',
  'risk:debt-relief-service',
  'risk:document-service',
  'risk:government-benefit-phishing',
  'risk:loan-leadgen',
  'risk:messaging-automation',
  'risk:migration-registration-service',
  'risk:online-lottery-bonus',
  'risk:p2p-crypto-arbitrage',
  'risk:paid-group-mailing',
  'risk:paid-gambling-group',
  'risk:paid-raffle',
  'risk:paid-raffle-transfer',
  'risk:paid-review-task',
  'risk:payment-card-drop-leadgen',
  'risk:pseudomedical-diagnostics',
  'risk:referral-bonus-link',
  'risk:unregulated-medicinal-goods',
  'risk:wildlife-product-sale',
]);

const STRUCTURED_TRANSPORT_SIGNALS = new Set([
  'service-specialty:advance-airport-station-transfer',
  'service-specialty:professional-passenger-parcel-transfer',
  'service-specialty:scheduled-round-trip-door-to-door',
  'service-specialty:scheduled-round-trip-parcel-route',
  'service-specialty:taxiing-contact-self-offer',
]);

const REVIEW_ONLY_TRANSPORT_SIGNALS = new Set([
  'review-only:transport-airport-station-waypoint',
  'review-only:transport-door-to-door-operator',
  'review-only:transport-promotional-vehicle-wording',
  'review-only:transport-single-date-schedule',
]);

const WARN_CAPPED_RECALL_PREFIX = 'recall-cap:warn:';
const REVIEW_CAPPED_RECALL_PREFIX = 'recall-cap:review:';
const RECALL_SOURCE_PREFIX = 'recall-source:';

const CONSERVATIVE_RECALL_SIGNALS = new Set([
  'goods-retail:named-store-stock-promotion',
  'property-agent:agent-object-id-contact',
  'property-agent:commission-rental-contact',
  'property-agent:multi-property-directory-contact',
  'property-agent:professional-property-spec-listing',
  'recruitment:role-first-vacancy',
  'service-specialty:banquet-hall-catalog',
  'service-specialty:construction-service-catalog',
  'service-specialty:cosmetic-procedure-catalog',
  'service-specialty:divination-self-offer',
  'service-specialty:marketplace-construction-service',
  'service-specialty:seasonal-lodging-offer',
  'service-specialty:website-creation-service',
  'service-specialty:well-drilling-self-offer',
]);

const CONSERVATIVE_RECALL_COMPANION_SIGNALS = new Set([
  'intent:все-виды-работ',
  'intent:строительная-бригада',
  'property-agent:комиссия-процент',
  'recruitment:зарплат',
  'recruitment:смена',
  'recruitment:роль-условия',
  'service-specialty:бригада',
  'service-specialty:мастер',
  'service-specialty:монтаж',
  'service-specialty:ремонт',
  'service-specialty:well-drilling-service',
]);

const INDEPENDENT_COMMERCIAL_OFFER_PREFIXES = [
  'buyout:',
  'channel-placement:',
  'goods-retail:',
  'group-promo:',
  'group-trade:',
  'info:',
  'property-agent:',
  'property-commercial:',
  'recruitment:',
  'service-specialty:',
] as const;

const BALANCED_STRUCTURED_SERVICE_PHONE_ANCHOR_SIGNALS = new Set([
  'intent:language-lessons',
  'intent:строительная-бригада',
  'intent:все-виды-работ',
  'intent:crane-beam-under-key',
  'intent:window-door-maintenance',
  'intent:custom-art-order',
  'intent:construction-multi-service',
  'intent:занимаюсь-услугами',
  'service-specialty:appliance-repair',
  'service-specialty:stretch-ceiling-service',
  'service-specialty:custom-handmade-order',
  'service-specialty:custom-art-order',
  'service-specialty:crane-beam-installation',
  'service-specialty:logistics-delivery',
  'service-specialty:beauty-salon-service',
  'service-specialty:print-copy-service',
  'service-specialty:tool-rental-service',
  'service-specialty:locksmith-service',
  'service-specialty:well-drilling-service',
  'service-specialty:sewer-cleaning-service',
  'service-specialty:pvc-window-door-repair',
  'service-specialty:speech-therapy-lessons',
  'service-specialty:tree-yard-repair-service',
  'service-specialty:yard-cleanup-service',
  'service-specialty:paving-landscaping-service',
]);

const LOCAL_PRIVATE_LIKE_RETAIL_SIGNALS = new Set([
  'goods-retail:wholesale-produce',
  'goods-retail:collectible-flower-retail',
  'goods-retail:flower-herb-unit-price-retail',
  'goods-retail:plant-nursery-stock',
  'goods-retail:plant-nursery-clearance-stock',
  'goods-retail:farm-livestock-retail',
  'goods-retail:poultry-farm-order',
  'goods-retail:home-food-order',
  'goods-retail:home-dairy-retail',
]);

export type CommercialSignalEvidenceProfile = {
  hasPriceEvidence: boolean;
  hasStrongContactEvidence: boolean;
  hasPhoneEvidence: boolean;
  hasLinkEvidence: boolean;
  hasHighRiskEvidence: boolean;
  hasEscalationRiskEvidence: boolean;
  hasStructuredTransportEvidence: boolean;
  hasReviewOnlyTransportEvidence: boolean;
  hasWarnCappedRecallEvidence: boolean;
  hasReviewCappedRecallEvidence: boolean;
  hasBoundedRecallEvidence: boolean;
  hasConservativeRecallEvidence: boolean;
  hasIndependentCommercialOfferEvidence: boolean;
  hasTransactionalDirectDealEvidence: boolean;
  hasNonCampaignDirectDealEvidence: boolean;
  hasLocalEscalationOfferEvidence: boolean;
  hasActionDirectDealEvidence: boolean;
  hasRawActionDirectDealEvidence: boolean;
};

export type CommercialStateEvidenceProfile = CommercialSignalEvidenceProfile & {
  hasClassifierDirectDealEvidence: boolean;
  hasStructuredEvidence: boolean;
  hasStandardCommercialEvidence: boolean;
  hasStructuredVacancyContactEvidence: boolean;
  hasStructuredBuyoutPhoneEvidence: boolean;
  hasStructuredServicePhoneEvidence: boolean;
  hasStructuredServiceTransactionalEvidence: boolean;
  hasStructuredPropertyContactEvidence: boolean;
  hasStructuredRetailTransactionalEvidence: boolean;
  hasStrongCampaignEvidence: boolean;
  hasStrongCommercialEvidence: boolean;
  hasStructuredCommercialContext: boolean;
  hasPrivateSaleCommercialOverride: boolean;
};

export function resolveCommercialSignalEvidence(
  matchedSignals: readonly string[],
): CommercialSignalEvidenceProfile {
  const hasPrefix = (prefix: string): boolean =>
    matchedSignals.some((signal) => signal.startsWith(prefix));
  const hasAny = (signals: ReadonlySet<string>): boolean =>
    matchedSignals.some((signal) => signals.has(signal));

  const hasHighRiskEvidence = hasPrefix('risk:');
  const hasEscalationRiskEvidence = hasAny(ESCALATION_RISK_SIGNALS);
  const hasLocalEscalationOfferEvidence = matchedSignals.includes('locality:escalation-offer');
  const hasStructuredTransportEvidence = hasAny(STRUCTURED_TRANSPORT_SIGNALS);
  const hasReviewOnlyTransportEvidence = hasAny(REVIEW_ONLY_TRANSPORT_SIGNALS);
  const hasWarnCappedRecallEvidence = hasPrefix(WARN_CAPPED_RECALL_PREFIX);
  const hasReviewCappedRecallEvidence = hasPrefix(REVIEW_CAPPED_RECALL_PREFIX);
  const hasBoundedRecallEvidence = hasWarnCappedRecallEvidence || hasReviewCappedRecallEvidence;
  const boundedRecallLabels = new Set(
    matchedSignals.flatMap((signal) => {
      if (signal.startsWith(WARN_CAPPED_RECALL_PREFIX)) {
        return [signal.slice(WARN_CAPPED_RECALL_PREFIX.length)];
      }
      if (signal.startsWith(REVIEW_CAPPED_RECALL_PREFIX)) {
        return [signal.slice(REVIEW_CAPPED_RECALL_PREFIX.length)];
      }
      return [];
    }),
  );
  const boundedRecallCompanionSignals = new Set(
    matchedSignals
      .filter((signal) => signal.startsWith(RECALL_SOURCE_PREFIX))
      .map((signal) => signal.slice(RECALL_SOURCE_PREFIX.length)),
  );
  const hasBoundedGoodsRecallSource = [...boundedRecallCompanionSignals].some((signal) =>
    signal.startsWith('goods-retail:'),
  );
  const hasConservativeRecallEvidence = hasAny(CONSERVATIVE_RECALL_SIGNALS);
  const hasIndependentCommercialOfferEvidence = matchedSignals.some(
    (signal) =>
      INDEPENDENT_COMMERCIAL_OFFER_PREFIXES.some((prefix) => signal.startsWith(prefix)) &&
      !boundedRecallCompanionSignals.has(signal) &&
      !(hasBoundedGoodsRecallSource && signal === 'goods-retail:multi-sku') &&
      ![...boundedRecallLabels].some((label) =>
        INDEPENDENT_COMMERCIAL_OFFER_PREFIXES.some((prefix) => signal === `${prefix}${label}`),
      ) &&
      !STRUCTURED_TRANSPORT_SIGNALS.has(signal) &&
      !CONSERVATIVE_RECALL_SIGNALS.has(signal) &&
      !(hasConservativeRecallEvidence && CONSERVATIVE_RECALL_COMPANION_SIGNALS.has(signal)),
  );
  const hasPriceEvidence = hasAny(PRICE_EVIDENCE_SIGNALS);
  const hasStrongContactEvidence = hasAny(STRONG_CONTACT_SIGNALS);
  const hasPhoneEvidence =
    matchedSignals.includes('contact:phone') ||
    matchedSignals.includes('contact:contextual-phone') ||
    matchedSignals.includes('contact:masked-phone');
  const hasLinkEvidence = hasPrefix('deal-channel:');
  const hasTransactionalDirectDealEvidence = hasAny(TRANSACTION_DIRECT_DEAL_SIGNALS);
  const hasNonCampaignDirectDealEvidence =
    hasPriceEvidence || hasPhoneEvidence || hasLinkEvidence || hasTransactionalDirectDealEvidence;
  const hasRawActionDirectDealEvidence =
    (hasPriceEvidence && (hasStrongContactEvidence || hasLinkEvidence)) ||
    (hasLinkEvidence && hasStrongContactEvidence) ||
    (hasTransactionalDirectDealEvidence && hasStrongContactEvidence) ||
    (hasHighRiskEvidence &&
      (hasPriceEvidence ||
        hasStrongContactEvidence ||
        hasLinkEvidence ||
        hasTransactionalDirectDealEvidence));
  const hasActionDirectDealEvidence =
    hasRawActionDirectDealEvidence &&
    (!hasEscalationRiskEvidence || hasLocalEscalationOfferEvidence);

  return {
    hasPriceEvidence,
    hasStrongContactEvidence,
    hasPhoneEvidence,
    hasLinkEvidence,
    hasHighRiskEvidence,
    hasEscalationRiskEvidence,
    hasStructuredTransportEvidence,
    hasReviewOnlyTransportEvidence,
    hasWarnCappedRecallEvidence,
    hasReviewCappedRecallEvidence,
    hasBoundedRecallEvidence,
    hasConservativeRecallEvidence,
    hasIndependentCommercialOfferEvidence,
    hasTransactionalDirectDealEvidence,
    hasNonCampaignDirectDealEvidence,
    hasLocalEscalationOfferEvidence,
    hasActionDirectDealEvidence,
    hasRawActionDirectDealEvidence,
  };
}

export function isCommercialEscalationRiskSignal(signal: string): boolean {
  return ESCALATION_RISK_SIGNALS.has(signal);
}

export function hasStrongCommercialCampaignEvidence(
  context: CommercialCampaignContext | null | undefined,
  state: CommercialSignalState,
): boolean {
  if (!context) {
    return false;
  }

  const thresholds = COMMERCIAL_ENGINE_CONFIG.campaignEvidence;
  const hasDealAnchor = state.hasContact || state.hasDealChannel || state.hasTransactional;
  const hasRepeatedDomainSelfPromo =
    (context.repeatedDomainDistinctChatCount ?? 0) >= thresholds.repeatedContactChats &&
    (state.hasDealChannel ||
      state.hasPromoContext ||
      state.hasBusinessContext ||
      state.hasServiceContext ||
      state.hasRecruitmentContext ||
      state.hasInfoProductContext ||
      state.hasGoodsRetailContext ||
      state.hasGroupPromoContext ||
      state.hasCommercialAudienceContext ||
      state.hasChannelPlacementContext ||
      state.hasCallToActionContext);

  return (
    (context.repeatedPhoneDistinctChatCount >= thresholds.repeatedContactChats &&
      state.hasContact) ||
    (context.repeatedLinkDistinctChatCount >= thresholds.repeatedContactChats &&
      state.hasDealChannel) ||
    ((context.repeatedHandleDistinctChatCount ?? 0) >= thresholds.repeatedContactChats &&
      state.hasContact) ||
    hasRepeatedDomainSelfPromo ||
    ((context.senderDistinctChatCount5m ?? 0) >= thresholds.senderVelocity5mChats &&
      hasDealAnchor) ||
    (context.sameTextDistinctChatCount >= thresholds.repeatedTextChats && hasDealAnchor) ||
    ((context.nearTextDistinctChatCount ?? 0) >= thresholds.repeatedTextChats && hasDealAnchor)
  );
}

export function resolveCommercialEvidenceProfile(params: {
  state: CommercialSignalState;
  appliedThresholds?: CommercialThresholdProfile;
  commercialCampaignContext?: CommercialCampaignContext | null;
}): CommercialStateEvidenceProfile {
  const { state, appliedThresholds, commercialCampaignContext } = params;
  const signalEvidence = resolveCommercialSignalEvidence(state.matchedSignals);
  const hasSignal = (signal: string): boolean => state.matchedSignals.includes(signal);
  const hasSignalPrefix = (prefix: string): boolean =>
    state.matchedSignals.some((signal) => signal.startsWith(prefix));
  const hasBalancedStructuredServicePhoneAnchor = state.matchedSignals.some((signal) =>
    BALANCED_STRUCTURED_SERVICE_PHONE_ANCHOR_SIGNALS.has(signal),
  );
  const hasLocalPrivateLikeRetailSignal = state.matchedSignals.some((signal) =>
    LOCAL_PRIVATE_LIKE_RETAIL_SIGNALS.has(signal),
  );
  const hasClassifierDirectDealEvidence =
    (state.hasPrice && (state.hasContact || state.hasDealChannel || state.hasTransactional)) ||
    (state.hasDealChannel && state.hasContact);
  const hasStructuredEvidence =
    (state.hasPropertyAgentContext ||
      state.hasCommercialPropertyContext ||
      state.hasRecruitmentContext ||
      state.hasInfoProductContext ||
      state.hasBuyoutContext ||
      state.hasServiceContext ||
      state.hasGoodsRetailContext ||
      state.hasGroupPromoContext ||
      state.hasBusinessContext ||
      state.hasPromoContext) &&
    (state.hasContact || state.hasDealChannel || state.hasPrice || state.hasTransactional);
  const hasStandardCommercialEvidence =
    state.hasPrice || state.hasContact || state.hasDealChannel || state.hasTransactional;
  const hasStructuredVacancyContactEvidence =
    state.hasContact &&
    !state.hasSearchRequestContext &&
    !state.hasJobSeekingContext &&
    (hasSignal('risk:structured-job-vacancy') || state.hasRecruitmentContext);
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
    ((appliedThresholds?.strictness ?? 1) >= 0.2 || hasBalancedStructuredServicePhoneAnchor);
  const hasStructuredServiceTransactionalEvidence =
    state.hasServiceContext &&
    state.hasTransactional &&
    !state.hasSearchRequestContext &&
    !state.hasJobSeekingContext &&
    !state.hasPrivateSaleContext &&
    !state.hasPrivateGoodsItemContext &&
    hasSignal('transaction:structured-service-offer');
  const hasStructuredPropertyContactEvidence =
    (state.hasPropertyAgentContext || state.hasCommercialPropertyContext) &&
    state.hasContact &&
    !state.hasSearchRequestContext;
  const hasStructuredRetailTransactionalEvidence =
    state.hasGoodsRetailContext &&
    (state.hasPhoneContact ||
      state.hasDealChannel ||
      state.hasPrice ||
      (state.hasTransactional && hasSignal('goods-retail:clearance-stock-retail'))) &&
    !state.hasSearchRequestContext &&
    !state.hasPrivateGoodsItemContext;
  const hasStructuredChannelOfferEvidence =
    state.hasChannelPlacementContext && hasSignal('transaction:handmade-channel-offer');
  const hasStrongCampaignEvidence = hasStrongCommercialCampaignEvidence(
    commercialCampaignContext,
    state,
  );
  const hasOnlyPricePhoneActionDirectEvidence =
    signalEvidence.hasRawActionDirectDealEvidence &&
    signalEvidence.hasPriceEvidence &&
    signalEvidence.hasPhoneEvidence &&
    !signalEvidence.hasLinkEvidence &&
    !signalEvidence.hasHighRiskEvidence &&
    !signalEvidence.hasTransactionalDirectDealEvidence &&
    !hasSignal('contact:handle') &&
    !hasSignal('contact:email');
  const hasStrongerLocalListingAnchor =
    state.hasDealChannel ||
    state.hasBusinessContext ||
    state.hasChannelPlacementContext ||
    state.hasCommercialAudienceContext ||
    state.hasGroupPromoContext ||
    state.hasInfoProductContext ||
    state.hasRecruitmentContext ||
    state.hasBuyoutContext ||
    state.hasCommercialPropertyContext ||
    state.hasPropertyAgentContext ||
    signalEvidence.hasHighRiskEvidence ||
    signalEvidence.hasTransactionalDirectDealEvidence ||
    hasStrongCampaignEvidence ||
    hasSignalPrefix('campaign:cross-chat-link') ||
    hasSignalPrefix('campaign:cross-chat-domain') ||
    hasSignalPrefix('campaign:cross-chat-handle') ||
    hasSignal('goods-retail:multi-sku') ||
    hasSignal('goods-retail:sizes-and-colors') ||
    hasSignal('goods-retail:catalog-media') ||
    hasSignal('goods-retail:manufacturer') ||
    hasSignal('goods-retail:commercial-use') ||
    hasSignal('goods-retail:volume-price-table') ||
    hasSignal('goods-retail:apparel-retail-order-flow') ||
    hasSignal('goods-retail:plant-nursery-shipping') ||
    hasSignal('goods-retail:clearance-stock-retail') ||
    hasSignal('goods-retail:structured-placeholder-contact') ||
    hasSignal('goods-retail:professional-order-catalog');
  const shouldConstrainLocalPrivateLikePricePhone =
    hasOnlyPricePhoneActionDirectEvidence &&
    !hasStrongerLocalListingAnchor &&
    (state.hasPrivateSaleContext ||
      state.hasPrivateGoodsItemContext ||
      state.hasPropertyPrivateContext ||
      hasLocalPrivateLikeRetailSignal ||
      (state.hasGoodsRetailContext && !state.hasBusinessContext) ||
      (state.hasServiceContext && state.hasStrongNegativeContext));
  const hasActionDirectDealEvidence =
    signalEvidence.hasActionDirectDealEvidence && !shouldConstrainLocalPrivateLikePricePhone;
  const hasStrongCommercialEvidence =
    state.hasPrice ||
    state.hasDealChannel ||
    (state.hasContact && state.hasTransactional) ||
    hasStructuredVacancyContactEvidence ||
    hasStructuredBuyoutPhoneEvidence ||
    hasStructuredServicePhoneEvidence ||
    hasStructuredServiceTransactionalEvidence ||
    hasStructuredPropertyContactEvidence ||
    hasStructuredRetailTransactionalEvidence ||
    hasStructuredChannelOfferEvidence ||
    hasStrongCampaignEvidence;
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

  return {
    ...signalEvidence,
    hasActionDirectDealEvidence,
    hasClassifierDirectDealEvidence,
    hasStructuredEvidence,
    hasStandardCommercialEvidence,
    hasStructuredVacancyContactEvidence,
    hasStructuredBuyoutPhoneEvidence,
    hasStructuredServicePhoneEvidence,
    hasStructuredServiceTransactionalEvidence,
    hasStructuredPropertyContactEvidence,
    hasStructuredRetailTransactionalEvidence,
    hasStrongCampaignEvidence,
    hasStrongCommercialEvidence,
    hasStructuredCommercialContext,
    hasPrivateSaleCommercialOverride,
  };
}
