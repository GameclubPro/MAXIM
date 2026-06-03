import { stripUrlsFromText } from '../../common/url-text.util';
import type { CommercialCampaignContext } from '../commercial-campaign.util';
import type { CommercialThresholdProfile } from '../rule-engine-commercial-thresholds';
import type { CommercialSubtype } from '../rule-engine.contract';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import { buildCommercialFeatureVector } from './commercial-explain';
import { normalizeCommercialText } from './commercial-normalization';
import {
  ADS_INTENT_MARKERS,
  ADS_SERVICE_INTENT_MARKERS,
  ADS_BUYOUT_MARKERS,
  ADS_BUYOUT_PATTERNS,
  ADS_PROMO_MARKERS,
  ADS_BUSINESS_MARKERS,
  ADS_BUSINESS_PATTERNS,
  ADS_HIGH_RISK_COMMERCIAL_PATTERNS,
  ADS_HIGH_RISK_COMMERCIAL_SIGNAL_WEIGHTS,
  ADS_HIGH_RISK_RAW_LINK_PATTERNS,
  ADS_SERVICE_SPECIALTY_MARKERS,
  ADS_RECRUITMENT_MARKERS,
  ADS_RECRUITMENT_PATTERNS,
  ADS_INFO_PRODUCT_MARKERS,
  ADS_CALL_TO_ACTION_MARKERS,
  ADS_GROUP_CONTEXT_MARKERS,
  ADS_GROUP_PROMO_MARKERS,
  ADS_GROUP_SELF_REFERENCE_MARKERS,
  ADS_GROUP_TRADE_MARKERS,
  ADS_COMMERCIAL_AUDIENCE_MARKERS,
  ADS_CHANNEL_PLACEMENT_MARKERS,
  ADS_CHANNEL_PLACEMENT_PATTERNS,
  ADS_CONTACT_MARKERS,
  ADS_NEGATIVE_MARKERS,
  ADS_COMMERCIAL_DISCUSSION_NEGATIVE_PATTERNS,
  ADS_PRIVATE_CONTEXT_MARKERS,
  ADS_QUESTION_CONTEXT_MARKERS,
  ADS_SEARCH_REQUEST_MARKERS,
  ADS_JOB_SEEKING_PATTERNS,
  ADS_SEARCH_REQUEST_PATTERNS,
  ADS_RIDE_SHARE_CONTEXT_PATTERN,
  ADS_SERVICE_OFFER_PATTERNS,
  ADS_SERVICE_SPECIALTY_PATTERNS,
  ADS_MASS_INVITE_LINK_PATTERN,
  ADS_GOODS_RETAIL_PATTERNS,
  ADS_PRIVATE_GOODS_PATTERNS,
  ADS_PRIVATE_SINGLE_LISTING_PATTERNS,
  ADS_PROPERTY_PRIVATE_PATTERNS,
  ADS_PROPERTY_CONTEXT_PATTERNS,
  ADS_PROPERTY_COMMERCIAL_PATTERNS,
  ADS_PROPERTY_AGENT_PATTERNS,
  PROPERTY_LISTING_NOISE_SERVICE_SPECIALTY_MARKERS,
  PROPERTY_LISTING_NOISE_BUSINESS_MARKERS,
  ADS_SPECIAL_TOKEN_MATCHERS,
  ADS_LINK_PATTERN,
  ADS_MARKETPLACE_LINK_PATTERN,
  ADS_MARKETPLACE_SERVICE_LINK_PATTERN,
  ADS_GENERIC_DOMAIN_LINK_PATTERN,
  ADS_PRICE_PATTERN,
  ADS_PRICE_RANGE_PATTERN,
  ADS_IMPLIED_PRICE_PATTERN,
  ADS_TRANSACTIONAL_PATTERN,
  ADS_PRIVATE_LOW_QUANTITY_GOODS_PATTERN,
  ADS_PRIVATE_LOW_QUANTITY_COMMERCIAL_OVERRIDE_PATTERN,
  ADS_PROPERTY_UTILITY_PAYMENT_PATTERN,
  ADS_URGENCY_PATTERN,
  ADS_QUANTITY_PATTERN,
  ADS_PHONE_PATTERN,
  ADS_CONTEXTUAL_PHONE_PATTERN,
  ADS_MASKED_PHONE_PATTERN,
  ADS_HANDLE_CONTACT_PATTERN,
  ADS_EMAIL_CONTACT_PATTERN,
  ADS_SOFT_RESPONSE_CTA_PATTERN,
  ADS_GOODS_VARIANT_MARKER_GLOBAL_PATTERN,
  ADS_MULTI_SKU_PRICE_LINE_PATTERN,
} from './commercial-patterns';
import { countPatternMatches } from './commercial-scorer';
import { resolveMissingCommercialAnchors } from './commercial-subtypes';
import type {
  CommercialFeatureVector,
  CommercialRequiredAnchor,
  CommercialSignalState,
} from './commercial.types';

type CommercialMarkerContext = {
  normalizedTextWithoutUrls: string;
  rawLoweredTextWithoutUrls: string;
  normalizedTokensWithoutUrls: string[];
};

export function hasCommercialSpamMarkers(text: string): boolean {
  const normalizedText = normalizeCommercialText(text);
  const rawLoweredText = text.toLowerCase();
  if (!normalizedText) {
    return false;
  }

  const markerContext = buildCommercialMarkerContext(normalizedText, rawLoweredText);
  const hasMarker = (marker: string): boolean => hasCommercialMarker(marker, markerContext);
  const matchesPattern = (pattern: RegExp): boolean =>
    matchesCommercialPattern(pattern, markerContext);
  const hasUtilityPaymentContext =
    ADS_PROPERTY_UTILITY_PAYMENT_PATTERN.test(normalizedText) ||
    ADS_PROPERTY_UTILITY_PAYMENT_PATTERN.test(rawLoweredText);
  const hasPropertyPrivateContext =
    ADS_PROPERTY_PRIVATE_PATTERNS.some(({ pattern }) => matchesPattern(pattern)) ||
    ADS_PROPERTY_CONTEXT_PATTERNS.some(({ pattern }) => matchesPattern(pattern));
  const hasPropertyAgentContext = ADS_PROPERTY_AGENT_PATTERNS.some(({ pattern }) =>
    matchesPattern(pattern),
  );
  const hasCommercialPropertyContext = ADS_PROPERTY_COMMERCIAL_PATTERNS.some(({ pattern }) =>
    matchesPattern(pattern),
  );

  const hasPromoContext = ADS_PROMO_MARKERS.some((marker) => hasMarker(marker));
  const hasBuyoutContext = ADS_BUYOUT_MARKERS.some((marker) => hasMarker(marker));
  const hasRecruitmentContext =
    ADS_RECRUITMENT_MARKERS.some((marker) => hasMarker(marker)) ||
    ADS_RECRUITMENT_PATTERNS.some(({ pattern }) => matchesPattern(pattern));
  const hasInfoProductContext = ADS_INFO_PRODUCT_MARKERS.some((marker) => hasMarker(marker));
  const hasBusinessContext =
    ADS_BUSINESS_MARKERS.some(
      (marker) =>
        !(hasPropertyPrivateContext && PROPERTY_LISTING_NOISE_BUSINESS_MARKERS.has(marker)) &&
        hasMarker(marker),
    ) ||
    ADS_BUSINESS_PATTERNS.some(({ pattern }) => matchesPattern(pattern)) ||
    ADS_HIGH_RISK_COMMERCIAL_PATTERNS.some(({ pattern }) => matchesPattern(pattern));
  const hasCommercialContext =
    hasPromoContext ||
    hasBusinessContext ||
    hasBuyoutContext ||
    hasRecruitmentContext ||
    hasInfoProductContext ||
    hasPropertyAgentContext;
  const hasIntentContext = ADS_INTENT_MARKERS.some(
    (marker) =>
      !(
        hasPropertyPrivateContext &&
        hasUtilityPaymentContext &&
        ADS_SERVICE_INTENT_MARKERS.has(marker)
      ) && hasMarker(marker),
  );
  const hasServiceOfferContext =
    [...ADS_SERVICE_INTENT_MARKERS].some(
      (marker) =>
        !(
          hasPropertyPrivateContext &&
          hasUtilityPaymentContext &&
          ADS_SERVICE_INTENT_MARKERS.has(marker)
        ) && hasMarker(marker),
    ) || ADS_SERVICE_OFFER_PATTERNS.some(({ pattern }) => matchesPattern(pattern));
  const hasServiceSpecialtyContext =
    ADS_SERVICE_SPECIALTY_MARKERS.some(
      (marker) =>
        !(
          hasPropertyPrivateContext &&
          !hasServiceOfferContext &&
          PROPERTY_LISTING_NOISE_SERVICE_SPECIALTY_MARKERS.has(marker)
        ) && hasMarker(marker),
    ) || ADS_SERVICE_SPECIALTY_PATTERNS.some(({ pattern }) => matchesPattern(pattern));
  const hasGroupContext = ADS_GROUP_CONTEXT_MARKERS.some((marker) => hasMarker(marker));
  const hasGroupPromotionIntent =
    ADS_GROUP_PROMO_MARKERS.some((marker) => hasMarker(marker)) ||
    ADS_GROUP_SELF_REFERENCE_MARKERS.some((marker) => hasMarker(marker));
  const hasCommercialAudienceContext = ADS_COMMERCIAL_AUDIENCE_MARKERS.some((marker) =>
    hasMarker(marker),
  );
  const hasMassInviteLinkContext = ADS_MASS_INVITE_LINK_PATTERN.test(rawLoweredText);
  const hasChannelPlacementContext =
    ADS_CHANNEL_PLACEMENT_MARKERS.some((marker) => hasMarker(marker)) ||
    ADS_CHANNEL_PLACEMENT_PATTERNS.some(({ pattern }) => matchesPattern(pattern)) ||
    hasMassInviteLinkContext;
  const hasCallToActionContext = ADS_CALL_TO_ACTION_MARKERS.some((marker) => hasMarker(marker));
  const hasSearchRequestContext =
    ADS_QUESTION_CONTEXT_MARKERS.some((marker) => hasMarker(marker)) ||
    ADS_SEARCH_REQUEST_MARKERS.some((marker) => hasMarker(marker)) ||
    ADS_JOB_SEEKING_PATTERNS.some(
      ({ pattern }) => pattern.test(normalizedText) || pattern.test(rawLoweredText),
    ) ||
    ADS_SEARCH_REQUEST_PATTERNS.some(
      ({ pattern }) => pattern.test(normalizedText) || pattern.test(rawLoweredText),
    );
  const hasDealSignal =
    ADS_LINK_PATTERN.test(rawLoweredText) ||
    ADS_MARKETPLACE_SERVICE_LINK_PATTERN.test(rawLoweredText) ||
    ADS_PHONE_PATTERN.test(rawLoweredText) ||
    ADS_CONTEXTUAL_PHONE_PATTERN.test(rawLoweredText) ||
    ADS_MASKED_PHONE_PATTERN.test(rawLoweredText) ||
    ADS_HANDLE_CONTACT_PATTERN.test(rawLoweredText) ||
    ADS_EMAIL_CONTACT_PATTERN.test(rawLoweredText) ||
    ADS_PRICE_PATTERN.test(rawLoweredText) ||
    ADS_PRICE_RANGE_PATTERN.test(rawLoweredText) ||
    ADS_TRANSACTIONAL_PATTERN.test(normalizedText) ||
    hasIntentContext ||
    ADS_CONTACT_MARKERS.some((marker) => hasMarker(marker));
  const hasServiceCommercialContext =
    (hasServiceOfferContext && hasDealSignal) ||
    (hasServiceSpecialtyContext && hasDealSignal && !hasSearchRequestContext);
  const hasGoodsRetailContext =
    ADS_GOODS_RETAIL_PATTERNS.some(({ pattern }) => matchesPattern(pattern)) ||
    (!hasPropertyPrivateContext &&
      (hasPromoContext || hasBusinessContext) &&
      (hasMarker('в наличии') ||
        hasMarker('каталог') ||
        hasMarker('ассортимент') ||
        hasMarker('заказывайте')));
  const hasPrivateSingleListingContext = ADS_PRIVATE_SINGLE_LISTING_PATTERNS.some(({ pattern }) =>
    matchesPattern(pattern),
  );
  const hasPrivateLowQuantityGoodsListing = isLikelyPrivateLowQuantityGoodsListing(rawLoweredText);
  const hasPrivateGoodsItemContext =
    hasPrivateSingleListingContext ||
    hasPrivateLowQuantityGoodsListing ||
    ADS_PRIVATE_GOODS_PATTERNS.some(({ pattern }) => matchesPattern(pattern));
  const hasStrongGoodsRetailContext =
    ADS_GOODS_RETAIL_PATTERNS.some(({ pattern }) => matchesPattern(pattern)) ||
    countPatternMatches(rawLoweredText, ADS_MULTI_SKU_PRICE_LINE_PATTERN, 4) >= 2;
  const hasPropertyServiceCommercialOverride =
    hasServiceCommercialContext && (!hasPropertyPrivateContext || hasServiceOfferContext);
  const hasPrivateSaleCommercialOverride =
    hasPropertyAgentContext ||
    hasCommercialPropertyContext ||
    hasBusinessContext ||
    hasCommercialAudienceContext ||
    hasChannelPlacementContext ||
    hasBuyoutContext ||
    hasRecruitmentContext ||
    hasInfoProductContext ||
    hasPropertyServiceCommercialOverride ||
    hasStrongGoodsRetailContext;
  const hasPrivateContextMarker =
    hasPrivateSingleListingContext ||
    ADS_PRIVATE_CONTEXT_MARKERS.some((marker) => hasMarker(marker));
  const hasSelfPromotionalContext =
    hasIntentContext ||
    hasPromoContext ||
    hasBuyoutContext ||
    hasRecruitmentContext ||
    hasInfoProductContext ||
    hasServiceOfferContext ||
    hasServiceCommercialContext ||
    hasGoodsRetailContext ||
    hasCallToActionContext ||
    ADS_SOFT_RESPONSE_CTA_PATTERN.test(rawLoweredText) ||
    hasGroupPromotionIntent ||
    hasCommercialAudienceContext ||
    hasChannelPlacementContext ||
    hasPropertyAgentContext ||
    hasCommercialPropertyContext;

  if (hasSearchRequestContext && !hasSelfPromotionalContext) {
    return false;
  }

  if (
    hasPrivateGoodsItemContext &&
    !hasBusinessContext &&
    !hasChannelPlacementContext &&
    !hasServiceCommercialContext &&
    !hasStrongGoodsRetailContext &&
    !ADS_LINK_PATTERN.test(rawLoweredText)
  ) {
    return false;
  }

  return (
    (hasCommercialContext ||
      hasCommercialPropertyContext ||
      hasGoodsRetailContext ||
      hasChannelPlacementContext ||
      hasServiceCommercialContext ||
      (hasGroupContext && hasDealSignal && hasGroupPromotionIntent)) &&
    hasDealSignal &&
    !(hasPropertyPrivateContext && !hasPrivateSaleCommercialOverride) &&
    !(hasPrivateContextMarker && !hasPrivateSaleCommercialOverride)
  );
}

export function hasExplicitSelfPromotionalCommercialContext(state: CommercialSignalState): boolean {
  return (
    state.hasIntent ||
    state.hasPromoContext ||
    state.hasBuyoutContext ||
    state.hasRecruitmentContext ||
    state.hasInfoProductContext ||
    state.hasServiceOfferContext ||
    state.hasServiceContext ||
    state.hasCallToActionContext ||
    state.hasGroupPromotionIntent ||
    state.hasCommercialAudienceContext ||
    state.hasPropertyAgentContext ||
    state.hasCommercialPropertyContext ||
    state.hasGoodsRetailContext
  );
}

export function hasPrivateGoodsCommercialOverride(state: CommercialSignalState): boolean {
  return (
    state.hasBusinessContext ||
    state.hasDealChannel ||
    state.hasGroupPromoContext ||
    state.hasCommercialAudienceContext ||
    state.hasChannelPlacementContext ||
    state.hasServiceOfferContext ||
    hasStrongGoodsRetailEvidence(state, { includePrivateResaleWeakSignals: false })
  );
}

function hasStrongGoodsRetailEvidence(
  state: CommercialSignalState,
  options: { includePrivateResaleWeakSignals: boolean } = {
    includePrivateResaleWeakSignals: true,
  },
): boolean {
  return state.matchedSignals.some(
    (signal) =>
      signal === 'goods-retail:sizes-and-colors' ||
      signal === 'goods-retail:catalog-media' ||
      signal === 'goods-retail:manufacturer' ||
      signal === 'goods-retail:commercial-use' ||
      signal === 'goods-retail:order-flow' ||
      signal === 'goods-retail:bulk-materials' ||
      signal === 'goods-retail:wholesale-produce' ||
      signal === 'goods-retail:volume-price-table' ||
      signal === 'goods-retail:apparel-retail-order-flow' ||
      signal === 'goods-retail:plant-nursery-stock' ||
      signal === 'goods-retail:plant-nursery-shipping' ||
      signal === 'goods-retail:clearance-stock-retail' ||
      signal === 'goods-retail:farm-livestock-retail' ||
      signal === 'goods-retail:poultry-farm-order' ||
      signal === 'goods-retail:home-food-order' ||
      signal === 'goods-retail:commercial-equipment' ||
      signal === 'goods-retail:bath-tub-retail' ||
      signal === 'goods-retail:auto-parts-retail' ||
      signal === 'goods-retail:knife-retail-catalog' ||
      (options.includePrivateResaleWeakSignals && signal === 'goods-retail:multi-sku'),
  );
}

export function isLikelyPrivateLowQuantityGoodsListing(rawLoweredText: string): boolean {
  const textWithoutUrls = stripUrlsFromText(rawLoweredText).replace(/\s+/gu, ' ').trim();
  if (!textWithoutUrls || textWithoutUrls.length > 180) {
    return false;
  }

  if (!ADS_PRIVATE_LOW_QUANTITY_GOODS_PATTERN.test(textWithoutUrls)) {
    return false;
  }

  return !ADS_PRIVATE_LOW_QUANTITY_COMMERCIAL_OVERRIDE_PATTERN.test(textWithoutUrls);
}

export function hasRideShareContext(rawLoweredText: string): boolean {
  return ADS_RIDE_SHARE_CONTEXT_PATTERN.test(rawLoweredText);
}

function buildCommercialMarkerContext(
  normalizedText: string,
  rawLoweredText: string,
): CommercialMarkerContext {
  const rawLoweredTextWithoutUrls = stripUrlsFromText(rawLoweredText);
  const normalizedTextWithoutUrls =
    rawLoweredTextWithoutUrls === rawLoweredText
      ? normalizedText
      : normalizeCommercialText(rawLoweredTextWithoutUrls);

  return {
    normalizedTextWithoutUrls,
    rawLoweredTextWithoutUrls,
    normalizedTokensWithoutUrls: normalizedTextWithoutUrls.match(/[\p{L}\p{N}]+/gu) ?? [],
  };
}

function hasCommercialMarker(marker: string, context: CommercialMarkerContext): boolean {
  const normalizedMarker = normalizeCommercialText(marker);
  if (!normalizedMarker) {
    return false;
  }

  const specialTokenMatcher = ADS_SPECIAL_TOKEN_MATCHERS.get(normalizedMarker);
  if (specialTokenMatcher) {
    return context.normalizedTokensWithoutUrls.some((token) => specialTokenMatcher.test(token));
  }

  if (/^[\p{L}\p{N}]+$/u.test(normalizedMarker)) {
    return context.normalizedTokensWithoutUrls.some((token) => token.startsWith(normalizedMarker));
  }

  return (
    context.normalizedTextWithoutUrls.includes(normalizedMarker) ||
    context.rawLoweredTextWithoutUrls.includes(marker.toLowerCase())
  );
}

function matchesCommercialPattern(pattern: RegExp, context: CommercialMarkerContext): boolean {
  return (
    pattern.test(context.normalizedTextWithoutUrls) ||
    pattern.test(context.rawLoweredTextWithoutUrls)
  );
}

export function collectCommercialSignals(params: {
  normalizedText: string;
  rawLoweredText: string;
  profile: CommercialThresholdProfile;
  commercialCampaignContext?: CommercialCampaignContext | null;
}): CommercialSignalState {
  const { normalizedText, rawLoweredText, profile, commercialCampaignContext } = params;
  const scoringConfig = COMMERCIAL_ENGINE_CONFIG.scoring;
  const weights = scoringConfig.weights;
  const campaignWeights = scoringConfig.campaignWeights;
  const positiveFactor =
    scoringConfig.positiveFactorBase + profile.strictness * scoringConfig.positiveFactorStrictness;
  const negativeFactor =
    scoringConfig.negativeFactorBase - profile.strictness * scoringConfig.negativeFactorStrictness;

  let score = 0;
  const matchedSignals: string[] = [];
  const negativeSignals: string[] = [];

  const addPositive = (label: string, value: number) => {
    score += value * positiveFactor;
    matchedSignals.push(label);
  };
  const addNegative = (label: string, value: number, strong = false) => {
    score -= value * negativeFactor;
    negativeSignals.push(label);
    if (strong) {
      hasStrongNegativeContext = true;
    }
  };

  let hasIntent = false;
  let hasServiceOfferContext = false;
  let hasServiceSpecialtyContext = false;
  let hasPrice = false;
  let hasContact = false;
  let hasPhoneContact = false;
  let hasDealChannel = false;
  let hasTransactional = false;
  let hasDealSignal = false;
  let hasPromoContext = false;
  let hasBusinessContext = false;
  let hasBuyoutContext = false;
  let hasRecruitmentContext = false;
  let hasInfoProductContext = false;
  let hasGroupPromotionIntent = false;
  let hasGroupPromoContext = false;
  let hasSearchRequestContext = false;
  let hasJobSeekingContext = false;
  let hasServiceContext = false;
  let hasCallToActionContext = false;
  let hasCommercialContext = false;
  let hasCampaignContext = false;
  let hasPrivateSaleContext = false;
  let hasPropertyAgentContext = false;
  let hasCommercialPropertyContext = false;
  let hasGoodsRetailContext = false;
  let hasPrivateGoodsItemContext = false;
  let hasStrongNegativeContext = false;
  let hasGroupContext = false;
  let hasGroupTradeContext = false;
  let hasCommercialAudienceContext = false;
  let hasChannelPlacementContext = false;
  let hasPropertyPrivateContext = false;

  const markerContext = buildCommercialMarkerContext(normalizedText, rawLoweredText);
  const hasMarker = (marker: string): boolean => hasCommercialMarker(marker, markerContext);
  const matchesPattern = (pattern: RegExp): boolean =>
    matchesCommercialPattern(pattern, markerContext);
  const hasUtilityPaymentContext =
    ADS_PROPERTY_UTILITY_PAYMENT_PATTERN.test(normalizedText) ||
    ADS_PROPERTY_UTILITY_PAYMENT_PATTERN.test(rawLoweredText);

  const propertyPrivateHits = [
    ...ADS_PROPERTY_PRIVATE_PATTERNS.filter(({ pattern }) => matchesPattern(pattern)).map(
      ({ label }) => label,
    ),
    ...ADS_PROPERTY_CONTEXT_PATTERNS.filter(({ pattern }) => matchesPattern(pattern)).map(
      ({ label }) => label,
    ),
  ];
  if (propertyPrivateHits.length > 0) {
    addNegative('private:property-sale', weights.privatePropertySale, true);
    hasPrivateSaleContext = true;
    hasPropertyPrivateContext = true;
  }

  const privateSingleListingHits = ADS_PRIVATE_SINGLE_LISTING_PATTERNS.filter(({ pattern }) =>
    matchesPattern(pattern),
  );
  for (const { label } of privateSingleListingHits.slice(0, 2)) {
    addNegative(`private-single:${label}`, weights.privateSingleListing, true);
    hasPrivateGoodsItemContext = true;
    hasPrivateSaleContext = true;
  }

  const intentHits = ADS_INTENT_MARKERS.filter((marker) => {
    if (
      hasPropertyPrivateContext &&
      hasUtilityPaymentContext &&
      ADS_SERVICE_INTENT_MARKERS.has(marker)
    ) {
      return false;
    }

    return hasMarker(marker);
  });
  for (const marker of intentHits.slice(0, 3)) {
    addPositive(`intent:${marker}`, weights.intent);
    hasIntent = true;
    if (ADS_SERVICE_INTENT_MARKERS.has(marker)) {
      hasServiceOfferContext = true;
    }
    hasDealSignal = true;
  }

  const serviceOfferHits = ADS_SERVICE_OFFER_PATTERNS.filter(({ pattern }) =>
    matchesPattern(pattern),
  );
  for (const { label } of serviceOfferHits.slice(0, 2)) {
    addPositive(`intent:${label}`, weights.serviceOffer);
    hasIntent = true;
    hasServiceOfferContext = true;
    hasDealSignal = true;
  }

  const promoHits = ADS_PROMO_MARKERS.filter((marker) => hasMarker(marker));
  for (const marker of promoHits.slice(0, 3)) {
    addPositive(`promo:${marker}`, weights.promo);
    hasPromoContext = true;
    hasCommercialContext = true;
  }

  const propertyAgentHits = ADS_PROPERTY_AGENT_PATTERNS.filter(({ pattern }) =>
    matchesPattern(pattern),
  );
  for (const { label } of propertyAgentHits.slice(0, 3)) {
    addPositive(`property-agent:${label}`, weights.propertyAgent);
    hasPropertyAgentContext = true;
    hasBusinessContext = true;
    hasCommercialContext = true;
  }

  const commercialPropertyHits = ADS_PROPERTY_COMMERCIAL_PATTERNS.filter(({ pattern }) =>
    matchesPattern(pattern),
  );
  for (const { label } of commercialPropertyHits.slice(0, 2)) {
    addPositive(`property-commercial:${label}`, weights.propertyCommercial);
    hasCommercialPropertyContext = true;
    hasBusinessContext = true;
    hasCommercialContext = true;
  }

  const businessHits = [
    ...ADS_BUSINESS_MARKERS.filter(
      (marker) =>
        !(hasPropertyPrivateContext && PROPERTY_LISTING_NOISE_BUSINESS_MARKERS.has(marker)) &&
        hasMarker(marker),
    ),
    ...ADS_BUSINESS_PATTERNS.filter(({ pattern }) => matchesPattern(pattern)).map(
      ({ label }) => label,
    ),
  ];
  for (const marker of [...new Set(businessHits)].slice(0, 2)) {
    addPositive(`business:${marker}`, weights.business);
    hasBusinessContext = true;
    hasCommercialContext = true;
  }

  const highRiskCommercialHits = ADS_HIGH_RISK_COMMERCIAL_PATTERNS.filter(({ pattern }) =>
    matchesPattern(pattern),
  );
  for (const { label } of highRiskCommercialHits.slice(0, 3)) {
    addPositive(
      `risk:${label}`,
      ADS_HIGH_RISK_COMMERCIAL_SIGNAL_WEIGHTS.get(label) ?? weights.highRiskFallback,
    );
    hasBusinessContext = true;
    hasCommercialContext = true;
  }

  const rawLinkCommercialHits = ADS_HIGH_RISK_RAW_LINK_PATTERNS.filter(({ pattern }) =>
    pattern.test(rawLoweredText),
  );
  for (const { label } of rawLinkCommercialHits.slice(0, 2)) {
    addPositive(`risk:${label}`, weights.rawHighRiskLink);
    hasBusinessContext = true;
    hasCommercialContext = true;
  }

  const buyoutHits = [
    ...ADS_BUYOUT_MARKERS.filter((marker) => hasMarker(marker)),
    ...ADS_BUYOUT_PATTERNS.filter(({ pattern }) => matchesPattern(pattern)).map(
      ({ label }) => label,
    ),
  ];
  for (const marker of buyoutHits.slice(0, 2)) {
    addPositive(`buyout:${marker}`, weights.buyout);
    hasBuyoutContext = true;
    hasBusinessContext = true;
    hasCommercialContext = true;
  }

  const hasPaydayLoanRisk = highRiskCommercialHits.some(({ label }) => label === 'loan-leadgen');
  const recruitmentHits = [
    ...ADS_RECRUITMENT_MARKERS.filter(
      (marker) => !(hasPaydayLoanRisk && marker === 'зарплат') && hasMarker(marker),
    ),
    ...ADS_RECRUITMENT_PATTERNS.filter(({ pattern }) => matchesPattern(pattern)).map(
      ({ label }) => label,
    ),
  ];
  for (const marker of [...new Set(recruitmentHits)].slice(0, 2)) {
    addPositive(`recruitment:${marker}`, weights.recruitment);
    hasRecruitmentContext = true;
    hasCommercialContext = true;
  }
  if (
    recruitmentHits.includes('hr-chat-recruiter') ||
    recruitmentHits.includes('remote-network-work')
  ) {
    addPositive('contact:recruitment-response-keyword', weights.contactMarker);
    hasContact = true;
    hasDealSignal = true;
  }
  if (recruitmentHits.includes('leaflet-daily-side-job')) {
    addPositive('contact:implicit-vacancy-offer', weights.contactMarker);
    hasContact = true;
    hasDealSignal = true;
  }

  const infoProductHits = ADS_INFO_PRODUCT_MARKERS.filter((marker) => hasMarker(marker));
  for (const marker of infoProductHits.slice(0, 2)) {
    addPositive(`info:${marker}`, weights.infoProduct);
    hasInfoProductContext = true;
    hasCommercialContext = true;
  }

  const serviceSpecialtyHits = [
    ...ADS_SERVICE_SPECIALTY_MARKERS.filter(
      (marker) =>
        !(
          hasPropertyPrivateContext &&
          !hasServiceOfferContext &&
          PROPERTY_LISTING_NOISE_SERVICE_SPECIALTY_MARKERS.has(marker)
        ) && hasMarker(marker),
    ),
    ...ADS_SERVICE_SPECIALTY_PATTERNS.filter(({ pattern }) => matchesPattern(pattern)).map(
      ({ label }) => label,
    ),
  ];
  for (const marker of [...new Set(serviceSpecialtyHits)].slice(0, 3)) {
    addPositive(`service-specialty:${marker}`, weights.serviceSpecialty);
    hasServiceSpecialtyContext = true;
  }

  const goodsRetailHits = ADS_GOODS_RETAIL_PATTERNS.filter(({ pattern }) =>
    matchesPattern(pattern),
  );
  for (const { label } of goodsRetailHits.slice(0, 3)) {
    addPositive(`goods-retail:${label}`, weights.goodsRetail);
    hasGoodsRetailContext = true;
    hasCommercialContext = true;
  }

  const multiSkuPriceLineCount = countPatternMatches(
    rawLoweredText,
    ADS_MULTI_SKU_PRICE_LINE_PATTERN,
    4,
  );
  const goodsVariantMarkerCount = countPatternMatches(
    rawLoweredText,
    ADS_GOODS_VARIANT_MARKER_GLOBAL_PATTERN,
    4,
  );
  if (
    multiSkuPriceLineCount >= 2 ||
    (multiSkuPriceLineCount >= 1 && goodsVariantMarkerCount >= 1)
  ) {
    addPositive('goods-retail:multi-sku', weights.goodsRetailMultiSku);
    hasGoodsRetailContext = true;
    hasCommercialContext = true;
  }

  const groupContextHits = ADS_GROUP_CONTEXT_MARKERS.filter((marker) => hasMarker(marker));
  for (const marker of groupContextHits.slice(0, 2)) {
    addPositive(`group:${marker}`, weights.groupContext);
    hasGroupContext = true;
  }

  const groupPromoHits = ADS_GROUP_PROMO_MARKERS.filter((marker) => hasMarker(marker));
  for (const marker of groupPromoHits.slice(0, 2)) {
    addPositive(`group-promo:${marker}`, weights.groupPromo);
    hasGroupContext = true;
    hasGroupPromotionIntent = true;
    hasCallToActionContext = true;
  }

  const groupSelfReferenceHits = ADS_GROUP_SELF_REFERENCE_MARKERS.filter((marker) =>
    hasMarker(marker),
  );
  for (const marker of groupSelfReferenceHits.slice(0, 2)) {
    addPositive(`group-self:${marker}`, weights.groupSelfReference);
    hasGroupContext = true;
    hasGroupPromotionIntent = true;
  }

  const groupTradeHits = ADS_GROUP_TRADE_MARKERS.filter((marker) => hasMarker(marker));
  for (const marker of groupTradeHits.slice(0, 3)) {
    addPositive(`group-trade:${marker}`, weights.groupTrade);
    hasGroupTradeContext = true;
  }

  const commercialAudienceHits = ADS_COMMERCIAL_AUDIENCE_MARKERS.filter((marker) =>
    hasMarker(marker),
  );
  for (const marker of commercialAudienceHits.slice(0, 2)) {
    addPositive(`audience:${marker}`, weights.commercialAudience);
    hasCommercialAudienceContext = true;
    hasBusinessContext = true;
    hasCommercialContext = true;
  }

  const channelPlacementHits = [
    ...ADS_CHANNEL_PLACEMENT_MARKERS.filter((marker) => hasMarker(marker)),
    ...ADS_CHANNEL_PLACEMENT_PATTERNS.filter(({ pattern }) => matchesPattern(pattern)).map(
      ({ label }) => label,
    ),
  ];
  for (const marker of [...new Set(channelPlacementHits)].slice(0, 4)) {
    addPositive(`channel-placement:${marker}`, weights.channelPlacement);
    hasGroupContext = true;
    hasGroupTradeContext = true;
    hasGroupPromotionIntent = true;
    hasCommercialAudienceContext = true;
    hasChannelPlacementContext = true;
    hasBusinessContext = true;
    hasCallToActionContext = true;
    hasCommercialContext = true;
  }

  if (ADS_MASS_INVITE_LINK_PATTERN.test(rawLoweredText)) {
    addPositive('channel-placement:mass-invite-link', weights.massInviteLink);
    hasGroupContext = true;
    hasGroupPromotionIntent = true;
    hasCommercialAudienceContext = true;
    hasChannelPlacementContext = true;
    hasBusinessContext = true;
    hasCallToActionContext = true;
    hasCommercialContext = true;
  }

  const callToActionHits = ADS_CALL_TO_ACTION_MARKERS.filter((marker) => hasMarker(marker));
  for (const marker of callToActionHits.slice(0, 2)) {
    addPositive(`cta:${marker}`, weights.callToAction);
    hasCallToActionContext = true;
  }

  if (
    ADS_PRICE_PATTERN.test(rawLoweredText) ||
    ADS_PRICE_PATTERN.test(normalizedText) ||
    ADS_PRICE_RANGE_PATTERN.test(rawLoweredText) ||
    ADS_PRICE_RANGE_PATTERN.test(normalizedText)
  ) {
    addPositive('transaction:price', weights.price);
    hasPrice = true;
    hasTransactional = true;
    hasDealSignal = true;
  }

  const hasStructuredContextForImpliedPrice =
    hasPropertyAgentContext ||
    hasCommercialPropertyContext ||
    hasRecruitmentContext ||
    hasServiceContext ||
    hasServiceOfferContext ||
    hasServiceSpecialtyContext ||
    hasGoodsRetailContext ||
    hasBuyoutContext ||
    hasBusinessContext ||
    hasPromoContext;
  if (
    !hasPrice &&
    hasStructuredContextForImpliedPrice &&
    (ADS_IMPLIED_PRICE_PATTERN.test(rawLoweredText) ||
      ADS_IMPLIED_PRICE_PATTERN.test(normalizedText))
  ) {
    addPositive('transaction:implied-price', weights.price);
    hasPrice = true;
    hasTransactional = true;
    hasDealSignal = true;
  }

  if (ADS_TRANSACTIONAL_PATTERN.test(normalizedText)) {
    addPositive('transaction:keywords', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
  }

  if (
    !hasGoodsRetailContext &&
    !hasPropertyPrivateContext &&
    (hasPromoContext || hasBusinessContext) &&
    (hasMarker('в наличии') ||
      hasMarker('каталог') ||
      hasMarker('ассортимент') ||
      hasMarker('заказывайте'))
  ) {
    addPositive('goods-retail:inventory', weights.goodsInventory);
    hasGoodsRetailContext = true;
    hasCommercialContext = true;
  }

  const contactHits = ADS_CONTACT_MARKERS.filter((marker) => hasMarker(marker));
  for (const marker of contactHits.slice(0, 2)) {
    addPositive(`contact:${marker}`, weights.contactMarker);
    hasContact = true;
    hasDealSignal = true;
  }

  if (ADS_PHONE_PATTERN.test(rawLoweredText) || ADS_PHONE_PATTERN.test(normalizedText)) {
    addPositive('contact:phone', weights.phone);
    hasContact = true;
    hasPhoneContact = true;
    hasDealSignal = true;
  }

  if (
    !hasPhoneContact &&
    (ADS_CONTEXTUAL_PHONE_PATTERN.test(rawLoweredText) ||
      ADS_CONTEXTUAL_PHONE_PATTERN.test(normalizedText))
  ) {
    addPositive('contact:contextual-phone', weights.phone);
    hasContact = true;
    hasPhoneContact = true;
    hasDealSignal = true;
  }

  if (
    ADS_MASKED_PHONE_PATTERN.test(rawLoweredText) ||
    ADS_MASKED_PHONE_PATTERN.test(normalizedText)
  ) {
    addPositive('contact:masked-phone', weights.contactMarker);
    hasContact = true;
    hasPhoneContact = true;
    hasDealSignal = true;
  }

  if (
    ADS_HANDLE_CONTACT_PATTERN.test(rawLoweredText) ||
    ADS_HANDLE_CONTACT_PATTERN.test(normalizedText)
  ) {
    addPositive('contact:handle', weights.contactMarker);
    hasContact = true;
    hasDealSignal = true;
  }

  if (ADS_EMAIL_CONTACT_PATTERN.test(rawLoweredText)) {
    addPositive('contact:email', weights.contactMarker);
    hasContact = true;
    hasDealSignal = true;
  }

  if (ADS_LINK_PATTERN.test(rawLoweredText)) {
    addPositive('deal-channel:link', weights.link);
    hasDealChannel = true;
    hasDealSignal = true;
  }

  const hasMarketplaceServiceLink = ADS_MARKETPLACE_SERVICE_LINK_PATTERN.test(rawLoweredText);
  if (hasMarketplaceServiceLink && !hasDealChannel) {
    addPositive('deal-channel:marketplace-service-link', weights.link);
    hasDealChannel = true;
    hasDealSignal = true;
  }

  const hasGenericDomainLink =
    !hasDealChannel &&
    ADS_GENERIC_DOMAIN_LINK_PATTERN.test(rawLoweredText) &&
    (hasPromoContext ||
      hasBusinessContext ||
      hasServiceContext ||
      hasServiceOfferContext ||
      hasServiceSpecialtyContext ||
      hasGoodsRetailContext ||
      hasRecruitmentContext ||
      hasInfoProductContext ||
      hasGroupPromotionIntent ||
      hasCommercialAudienceContext ||
      hasCommercialPropertyContext ||
      hasPropertyAgentContext ||
      hasCallToActionContext);
  if (hasGenericDomainLink) {
    addPositive('deal-channel:generic-domain', weights.link);
    hasDealChannel = true;
    hasDealSignal = true;
  }

  if (commercialCampaignContext) {
    if (commercialCampaignContext.sameTextDistinctChatCount >= 2) {
      addPositive(
        'campaign:cross-chat-text',
        commercialCampaignContext.sameTextDistinctChatCount >= 3
          ? campaignWeights.crossChatTextStrong
          : campaignWeights.crossChatTextStandard,
      );
      hasCampaignContext = true;
    }

    if (commercialCampaignContext.repeatedPhoneDistinctChatCount >= 2) {
      addPositive(
        'campaign:cross-chat-phone',
        commercialCampaignContext.repeatedPhoneDistinctChatCount >= 3
          ? campaignWeights.crossChatPhoneStrong
          : campaignWeights.crossChatPhoneStandard,
      );
      hasCampaignContext = true;
    }

    if (commercialCampaignContext.repeatedLinkDistinctChatCount >= 2) {
      addPositive(
        'campaign:cross-chat-link',
        commercialCampaignContext.repeatedLinkDistinctChatCount >= 3
          ? campaignWeights.crossChatLinkStrong
          : campaignWeights.crossChatLinkStandard,
      );
      hasCampaignContext = true;
    }

    if ((commercialCampaignContext.nearTextDistinctChatCount ?? 0) >= 2) {
      addPositive(
        'campaign:near-duplicate-text',
        (commercialCampaignContext.nearTextDistinctChatCount ?? 0) >= 3
          ? campaignWeights.nearDuplicateTextStrong
          : campaignWeights.nearDuplicateTextStandard,
      );
      hasCampaignContext = true;
    }

    if ((commercialCampaignContext.repeatedDomainDistinctChatCount ?? 0) >= 3) {
      addPositive(
        'campaign:cross-chat-domain',
        (commercialCampaignContext.repeatedDomainDistinctChatCount ?? 0) >= 5
          ? campaignWeights.crossChatDomainStrong
          : campaignWeights.crossChatDomainStandard,
      );
      hasCampaignContext = true;
    }

    if ((commercialCampaignContext.repeatedHandleDistinctChatCount ?? 0) >= 2) {
      addPositive(
        'campaign:cross-chat-handle',
        (commercialCampaignContext.repeatedHandleDistinctChatCount ?? 0) >= 3
          ? campaignWeights.crossChatHandleStrong
          : campaignWeights.crossChatHandleStandard,
      );
      hasCampaignContext = true;
    }

    if (commercialCampaignContext.senderDistinctChatCount >= 3) {
      addPositive(
        'campaign:sender-multi-chat',
        commercialCampaignContext.senderDistinctChatCount >= 5
          ? campaignWeights.senderMultiChatStrong
          : campaignWeights.senderMultiChatStandard,
      );
      hasCampaignContext = true;
    }

    if ((commercialCampaignContext.senderDistinctChatCount5m ?? 0) >= 3) {
      addPositive('campaign:sender-velocity-5m', campaignWeights.senderVelocity5m);
      hasCampaignContext = true;
    } else if ((commercialCampaignContext.senderDistinctChatCount30m ?? 0) >= 4) {
      addPositive('campaign:sender-velocity-30m', campaignWeights.senderVelocity30m);
      hasCampaignContext = true;
    } else if ((commercialCampaignContext.senderDistinctChatCount120m ?? 0) >= 5) {
      addPositive('campaign:sender-velocity-120m', campaignWeights.senderVelocity120m);
      hasCampaignContext = true;
    }
  }

  if (ADS_MARKETPLACE_LINK_PATTERN.test(rawLoweredText) && !hasMarketplaceServiceLink) {
    addNegative('private:marketplace-link', weights.marketplaceLinkNegative);
    hasPrivateSaleContext = true;
  }

  if (ADS_URGENCY_PATTERN.test(normalizedText)) {
    addPositive('booster:urgency', weights.urgency);
  }

  if (ADS_QUANTITY_PATTERN.test(normalizedText)) {
    addPositive('booster:quantity', weights.quantity);
  }

  for (const marker of ADS_NEGATIVE_MARKERS) {
    if (!hasMarker(marker)) {
      continue;
    }

    addNegative(`negative:${marker}`, weights.negativeMarker, true);
  }

  for (const { label, pattern } of ADS_COMMERCIAL_DISCUSSION_NEGATIVE_PATTERNS) {
    if (!(pattern.test(normalizedText) || pattern.test(rawLoweredText))) {
      continue;
    }

    addNegative(`context:${label}`, weights.negativeMarker, true);
    hasSearchRequestContext = true;
  }

  for (const marker of ADS_QUESTION_CONTEXT_MARKERS) {
    if (!hasMarker(marker)) {
      continue;
    }

    addNegative(`context:${marker}`, weights.questionContext, true);
    hasSearchRequestContext = true;
  }

  for (const marker of ADS_PRIVATE_CONTEXT_MARKERS) {
    if (!hasMarker(marker)) {
      continue;
    }
    if (hasPropertyAgentContext || hasCommercialPropertyContext) {
      continue;
    }
    if (hasGoodsRetailContext && marker === 'самовывоз') {
      continue;
    }

    addNegative(`private:${marker}`, weights.privateContext, true);
    hasPrivateSaleContext = true;
  }

  const privateGoodsHits = ADS_PRIVATE_GOODS_PATTERNS.filter(({ pattern }) =>
    matchesPattern(pattern),
  );
  for (const { label } of privateGoodsHits.slice(0, 2)) {
    addNegative(`private-goods:${label}`, weights.privateGoods, true);
    hasPrivateGoodsItemContext = true;
    hasPrivateSaleContext = true;
  }

  for (const marker of ADS_SEARCH_REQUEST_MARKERS) {
    if (!hasMarker(marker)) {
      continue;
    }

    addNegative(`search:${marker}`, weights.searchRequest, true);
    hasSearchRequestContext = true;
  }

  for (const { label, pattern } of ADS_JOB_SEEKING_PATTERNS) {
    if (!(pattern.test(normalizedText) || pattern.test(rawLoweredText))) {
      continue;
    }

    addNegative(`job-seeking:${label}`, weights.jobSeeking, true);
    hasJobSeekingContext = true;
    hasSearchRequestContext = true;
  }

  for (const { label, pattern } of ADS_SEARCH_REQUEST_PATTERNS) {
    if (!(pattern.test(normalizedText) || pattern.test(rawLoweredText))) {
      continue;
    }

    addNegative(`search-pattern:${label}`, weights.searchPattern, true);
    hasSearchRequestContext = true;
  }

  if (rawLoweredText.includes('?') && !hasPrice && !hasContact && !hasDealChannel) {
    addNegative('context:question', weights.bareQuestion);
    hasSearchRequestContext = true;
  }

  if (
    ADS_SOFT_RESPONSE_CTA_PATTERN.test(rawLoweredText) &&
    !hasSearchRequestContext &&
    (hasServiceContext ||
      hasServiceOfferContext ||
      hasServiceSpecialtyContext ||
      hasRecruitmentContext ||
      hasInfoProductContext ||
      hasGoodsRetailContext ||
      hasBusinessContext ||
      hasPromoContext)
  ) {
    addPositive('contact:soft-response-cta', weights.contactMarker);
    hasContact = true;
    hasDealSignal = true;
    hasCallToActionContext = true;
  }

  if (hasIntent && (hasPrice || hasContact || hasDealChannel)) {
    addPositive('combo:intent+deal', weights.comboIntentDeal);
  }

  const hasDirectDealEvidence =
    hasPhoneContact || hasContact || hasDealChannel || hasPrice || hasTransactional;

  if (hasBuyoutContext && hasDirectDealEvidence) {
    addPositive('combo:buyout+deal', weights.comboBuyoutDeal);
    hasCommercialContext = true;
  }

  if (hasServiceOfferContext && hasDirectDealEvidence) {
    addPositive('combo:service-offer+deal', weights.comboServiceOfferDeal);
    hasServiceContext = true;
    hasCommercialContext = true;
  }

  if (hasServiceOfferContext && hasServiceSpecialtyContext) {
    addPositive('combo:service-offer+specialty', weights.comboServiceOfferSpecialty);
  }

  if (
    hasServiceSpecialtyContext &&
    (hasPhoneContact || hasContact || hasDealChannel) &&
    !hasSearchRequestContext
  ) {
    addPositive(
      profile.sensitivity === 'STRICT'
        ? 'combo:strict-service-specialty+deal'
        : 'combo:service-specialty+deal',
      profile.sensitivity === 'STRICT'
        ? weights.comboStrictServiceSpecialtyDeal
        : weights.comboServiceSpecialtyDeal,
    );
    hasServiceContext = true;
    hasCommercialContext = true;
  }

  if (
    profile.sensitivity === 'STRICT' &&
    hasIntent &&
    !hasSearchRequestContext &&
    (hasPhoneContact || hasPrice || hasTransactional || hasDealChannel)
  ) {
    const hasStrictIntentCommercialAnchor =
      hasPromoContext ||
      hasBusinessContext ||
      hasBuyoutContext ||
      hasRecruitmentContext ||
      hasInfoProductContext ||
      hasServiceOfferContext ||
      hasServiceSpecialtyContext ||
      hasGoodsRetailContext ||
      hasGroupPromoContext ||
      hasCommercialAudienceContext ||
      hasCommercialPropertyContext ||
      hasPropertyAgentContext ||
      hasCampaignContext;
    addPositive('combo:strict-intent+direct-deal', weights.comboStrictIntentDirectDeal);
    if (hasStrictIntentCommercialAnchor) {
      hasCommercialContext = true;
    }
  }

  if (
    profile.sensitivity === 'STRICT' &&
    hasPhoneContact &&
    !hasSearchRequestContext &&
    (hasServiceSpecialtyContext ||
      hasPromoContext ||
      hasBusinessContext ||
      hasBuyoutContext ||
      hasRecruitmentContext ||
      hasInfoProductContext ||
      hasCallToActionContext)
  ) {
    addPositive('combo:strict-phone+self-promo', weights.comboStrictPhoneSelfPromo);
    hasCommercialContext = true;
    if (hasServiceSpecialtyContext) {
      hasServiceContext = true;
    }
  }

  if (hasGroupContext && hasDealChannel && hasGroupPromotionIntent) {
    const hasExplicitGroupCommercialContext =
      hasGroupTradeContext || hasCommercialAudienceContext || hasBusinessContext || hasPromoContext;
    addPositive(
      'combo:group-promo+deal',
      hasExplicitGroupCommercialContext
        ? weights.comboGroupPromoDealExplicit
        : weights.comboGroupPromoDealWeak,
    );
    hasGroupPromoContext = true;
    hasCommercialContext = true;
  }

  if (hasCampaignContext && (hasContact || hasDealChannel || hasPrice || hasTransactional)) {
    addPositive('combo:campaign+deal', weights.comboCampaignDeal);
  }

  if (
    hasCampaignContext &&
    (hasPromoContext ||
      hasBusinessContext ||
      hasBuyoutContext ||
      hasRecruitmentContext ||
      hasInfoProductContext ||
      hasServiceContext ||
      hasServiceOfferContext ||
      hasCommercialAudienceContext ||
      hasGroupPromotionIntent)
  ) {
    addPositive('combo:campaign+self-promo', weights.comboCampaignSelfPromo);
    hasCommercialContext = true;
  }

  if (hasPromoContext && (hasPrice || hasContact || hasDealChannel || hasTransactional)) {
    addPositive('combo:promo+deal', weights.comboPromoDeal);
  }

  if (hasBusinessContext && (hasPrice || hasContact || hasDealChannel || hasTransactional)) {
    addPositive('combo:business+deal', weights.comboBusinessDeal);
  }

  if (hasPropertyAgentContext && (hasContact || hasDealChannel || hasPrice || hasTransactional)) {
    addPositive('combo:property-agent+deal', weights.comboBusinessDeal);
  }

  if (
    hasCommercialPropertyContext &&
    (hasContact || hasDealChannel || hasPrice || hasTransactional)
  ) {
    addPositive('combo:property-commercial+deal', weights.comboBusinessDeal);
  }

  if (
    hasGoodsRetailContext &&
    !hasPrivateGoodsItemContext &&
    (hasContact || hasDealChannel || hasPrice)
  ) {
    addPositive('combo:goods-retail+deal', weights.comboPromoDeal);
  }

  if (hasRecruitmentContext && (hasContact || hasDealChannel || hasTransactional)) {
    addPositive('combo:recruitment+deal', weights.comboRecruitmentDeal);
  }

  if (
    hasInfoProductContext &&
    (hasContact || hasDealChannel || hasPrice || hasCallToActionContext)
  ) {
    addPositive('combo:info+deal', weights.comboInfoDeal);
  }

  if (hasServiceContext && (hasContact || hasDealChannel || hasPrice || hasTransactional)) {
    addPositive('combo:service+deal', weights.comboServiceDeal);
  }

  if (hasContact && hasPrice) {
    addPositive('combo:contact+price', weights.comboContactPrice);
  }

  return {
    score,
    matchedSignals: [...new Set(matchedSignals)],
    negativeSignals: [...new Set(negativeSignals)],
    hasIntent,
    hasServiceOfferContext,
    hasServiceSpecialtyContext,
    hasPrice,
    hasContact,
    hasPhoneContact,
    hasDealChannel,
    hasTransactional,
    hasDealSignal,
    hasPromoContext,
    hasBusinessContext,
    hasBuyoutContext,
    hasRecruitmentContext,
    hasInfoProductContext,
    hasGroupPromotionIntent,
    hasGroupPromoContext,
    hasCommercialAudienceContext,
    hasChannelPlacementContext,
    hasSearchRequestContext,
    hasJobSeekingContext,
    hasServiceContext,
    hasCallToActionContext,
    hasCommercialContext,
    hasCampaignContext,
    hasPrivateSaleContext,
    hasPropertyPrivateContext,
    hasPropertyAgentContext,
    hasCommercialPropertyContext,
    hasGoodsRetailContext,
    hasPrivateGoodsItemContext,
    hasStrongNegativeContext,
  };
}

export { buildCommercialFeatureVector };

export type CommercialAnchorAudit = {
  subtype: CommercialSubtype;
  missingAnchors: CommercialRequiredAnchor[];
  hasRequiredAnchors: boolean;
};

export function auditCommercialRequiredAnchors(params: {
  subtype: CommercialSubtype;
  featureVector: CommercialFeatureVector;
  matchedSignals: readonly string[];
}): CommercialAnchorAudit {
  const missingAnchors = resolveMissingCommercialAnchors(params);
  return {
    subtype: params.subtype,
    missingAnchors,
    hasRequiredAnchors: missingAnchors.length === 0,
  };
}
