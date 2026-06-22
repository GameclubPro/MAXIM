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
  'transaction:buyout-deal',
  'transaction:handmade-channel-offer',
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
  'risk:bulk-client-leadgen',
  'risk:casino-landing-link',
  'risk:casino-slot-promo',
  'risk:crypto-investment',
  'risk:debt-relief-service',
  'risk:document-service',
  'risk:government-benefit-phishing',
  'risk:loan-leadgen',
  'risk:messaging-automation',
  'risk:online-lottery-bonus',
  'risk:p2p-crypto-arbitrage',
  'risk:paid-group-mailing',
  'risk:paid-raffle',
  'risk:paid-raffle-transfer',
  'risk:paid-review-task',
  'risk:payment-card-drop-leadgen',
  'risk:referral-bonus-link',
]);

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
  hasTransactionalDirectDealEvidence: boolean;
  hasNonCampaignDirectDealEvidence: boolean;
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
  const hasActionDirectDealEvidence =
    (hasPriceEvidence && (hasStrongContactEvidence || hasLinkEvidence)) ||
    (hasLinkEvidence && hasStrongContactEvidence) ||
    (hasTransactionalDirectDealEvidence && hasStrongContactEvidence) ||
    (hasHighRiskEvidence &&
      (hasPriceEvidence ||
        hasStrongContactEvidence ||
        hasLinkEvidence ||
        hasTransactionalDirectDealEvidence));

  return {
    hasPriceEvidence,
    hasStrongContactEvidence,
    hasPhoneEvidence,
    hasLinkEvidence,
    hasHighRiskEvidence,
    hasEscalationRiskEvidence,
    hasTransactionalDirectDealEvidence,
    hasNonCampaignDirectDealEvidence,
    hasActionDirectDealEvidence,
    hasRawActionDirectDealEvidence: hasActionDirectDealEvidence,
  };
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
    hasSignal('goods-retail:clearance-stock-retail');
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
