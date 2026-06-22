import { stripUrlsFromText } from '../../common/url-text.util';
import type { CommercialCampaignContext } from '../commercial-campaign.util';
import type { CommercialThresholdProfile } from '../rule-engine-commercial-thresholds';
import type { CommercialSubtype } from '../rule-engine.contract';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import { buildCommercialFeatureVector } from './commercial-explain';
import { normalizeCommercialText } from './commercial-normalization';
import {
  collectFirstMarkers,
  collectFirstPatternLabels,
  countPatternMatches,
  createCommercialTextMatcher,
  hasPriceLikeText,
} from './commercial-match-utils';
import {
  ADS_INTENT_MARKERS,
  ADS_SERVICE_INTENT_MARKERS,
  ADS_BUYOUT_MARKERS,
  ADS_BUYOUT_PATTERNS,
  ADS_BUYOUT_DEAL_PATTERN,
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
  ADS_PLANT_MULTI_PRICE_LISTING_PATTERN,
  ADS_PROPERTY_UTILITY_PAYMENT_PATTERN,
  ADS_URGENCY_PATTERN,
  ADS_QUANTITY_PATTERN,
  ADS_PHONE_PATTERN,
  ADS_CONTEXTUAL_PHONE_PATTERN,
  ADS_MASKED_PHONE_PATTERN,
  ADS_HANDLE_CONTACT_PATTERN,
  ADS_EMAIL_CONTACT_PATTERN,
  ADS_SOFT_RESPONSE_CTA_PATTERN,
  ADS_PRICE_CAPTURE_GLOBAL_PATTERN,
  ADS_GOODS_VARIANT_MARKER_GLOBAL_PATTERN,
  ADS_MULTI_SKU_PRICE_LINE_PATTERN,
} from './commercial-patterns';
import { resolveMissingCommercialAnchors } from './commercial-subtypes';
import type {
  CommercialFeatureVector,
  CommercialRequiredAnchor,
  CommercialSignalState,
} from './commercial.types';

export function hasCommercialSpamMarkers(text: string): boolean {
  const normalizedText = normalizeCommercialText(text);
  const rawLoweredText = text.toLowerCase();
  if (!normalizedText) {
    return false;
  }

  const matcher = createCommercialTextMatcher(normalizedText, rawLoweredText);
  const hasMarker = matcher.hasMarker;
  const matchesPattern = matcher.matchesPattern;
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
  const hasPrivateSingleListingContext = ADS_PRIVATE_SINGLE_LISTING_PATTERNS.some(({ pattern }) =>
    matchesPattern(pattern),
  );
  const serviceOfferPatterns = hasPrivateSingleListingContext
    ? ADS_SERVICE_OFFER_PATTERNS.filter(
        ({ label }) => !isPrivateObjectConditionServiceNoise(label, rawLoweredText),
      )
    : ADS_SERVICE_OFFER_PATTERNS;
  const hasServiceOfferContext =
    [...ADS_SERVICE_INTENT_MARKERS].some(
      (marker) =>
        !(
          hasPropertyPrivateContext &&
          hasUtilityPaymentContext &&
          ADS_SERVICE_INTENT_MARKERS.has(marker)
        ) && hasMarker(marker),
    ) || serviceOfferPatterns.some(({ pattern }) => matchesPattern(pattern));
  const serviceSpecialtyPatterns = hasPrivateSingleListingContext
    ? ADS_SERVICE_SPECIALTY_PATTERNS.filter(
        ({ label }) => !isPrivateObjectConditionServiceNoise(label, rawLoweredText),
      )
    : ADS_SERVICE_SPECIALTY_PATTERNS;
  const hasServiceSpecialtyContext =
    ADS_SERVICE_SPECIALTY_MARKERS.some(
      (marker) =>
        !(
          hasPropertyPrivateContext &&
          !hasServiceOfferContext &&
          PROPERTY_LISTING_NOISE_SERVICE_SPECIALTY_MARKERS.has(marker)
        ) &&
        !(
          hasPrivateSingleListingContext &&
          !hasServiceOfferContext &&
          isPrivateObjectConditionServiceNoise(marker, rawLoweredText)
        ) &&
        hasMarker(marker),
    ) || serviceSpecialtyPatterns.some(({ pattern }) => matchesPattern(pattern));
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
    (hasEmailLikeText(rawLoweredText) && ADS_EMAIL_CONTACT_PATTERN.test(rawLoweredText)) ||
    (hasPriceLikeText(rawLoweredText) &&
      (ADS_PRICE_PATTERN.test(rawLoweredText) || ADS_PRICE_RANGE_PATTERN.test(rawLoweredText))) ||
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
  const hasPersonalResaleContext = state.negativeSignals.some(
    (signal) =>
      signal === 'private:б/у' ||
      signal === 'private:бу' ||
      signal === 'private:не подошл' ||
      signal === 'private-goods:resale-condition' ||
      signal === 'private-goods:private-apparel-avito-delivery' ||
      signal === 'private-goods:private-seedling-leftovers',
  );
  const hasCommercialSeedlingClearance =
    state.negativeSignals.includes('private-goods:private-seedling-leftovers') &&
    state.matchedSignals.includes('goods-retail:plant-nursery-clearance-stock');

  return (
    state.hasBusinessContext ||
    state.hasDealChannel ||
    state.hasGroupPromoContext ||
    state.hasCommercialAudienceContext ||
    state.hasChannelPlacementContext ||
    state.hasServiceOfferContext ||
    hasCommercialSeedlingClearance ||
    hasStrongGoodsRetailEvidence(state, {
      includePrivateResaleWeakSignals: false,
      includeLowQuantityPlantStock: false,
      includePrivateOrderFlowSignals: !hasPersonalResaleContext,
    })
  );
}

function hasStrongGoodsRetailEvidence(
  state: CommercialSignalState,
  options: {
    includePrivateResaleWeakSignals: boolean;
    includeLowQuantityPlantStock?: boolean;
    includePrivateOrderFlowSignals?: boolean;
  } = {
    includePrivateResaleWeakSignals: true,
    includeLowQuantityPlantStock: true,
    includePrivateOrderFlowSignals: true,
  },
): boolean {
  const includeLowQuantityPlantStock = options.includeLowQuantityPlantStock ?? true;
  const includePrivateOrderFlowSignals = options.includePrivateOrderFlowSignals ?? true;
  return state.matchedSignals.some(
    (signal) =>
      signal === 'goods-retail:sizes-and-colors' ||
      signal === 'goods-retail:catalog-media' ||
      signal === 'goods-retail:manufacturer' ||
      signal === 'goods-retail:commercial-use' ||
      (includePrivateOrderFlowSignals && signal === 'goods-retail:order-flow') ||
      signal === 'goods-retail:bulk-materials' ||
      signal === 'goods-retail:wholesale-produce' ||
      signal === 'goods-retail:volume-price-table' ||
      (includePrivateOrderFlowSignals && signal === 'goods-retail:apparel-retail-order-flow') ||
      (includeLowQuantityPlantStock && signal === 'goods-retail:plant-nursery-stock') ||
      signal === 'goods-retail:plant-nursery-shipping' ||
      signal === 'goods-retail:clearance-stock-retail' ||
      signal === 'goods-retail:farm-livestock-retail' ||
      signal === 'goods-retail:poultry-farm-order' ||
      signal === 'goods-retail:home-dairy-retail' ||
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

  if (ADS_PLANT_MULTI_PRICE_LISTING_PATTERN.test(textWithoutUrls)) {
    return false;
  }

  return !ADS_PRIVATE_LOW_QUANTITY_COMMERCIAL_OVERRIDE_PATTERN.test(textWithoutUrls);
}

export function hasRideShareContext(rawLoweredText: string): boolean {
  return ADS_RIDE_SHARE_CONTEXT_PATTERN.test(rawLoweredText);
}

function isPrivateObjectConditionServiceNoise(label: string, rawLoweredText: string): boolean {
  if (
    /(?:^|[^\p{L}\p{N}_-])(?:выполн(?:ю|им)|выполня(?:ю|ем)|оказыва(?:ю|ем)|предлага(?:ю|ем)|сдела(?:ю|ем)|ремонтир(?:ую|уем)|строительн[\p{L}\p{N}_-]*\s+бригад[\p{L}\p{N}_-]*|ремонт\s+под\s+ключ|услуг[\p{L}\p{N}_-]*\s+ремонт[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    )
  ) {
    return false;
  }

  if (
    label === 'ремонт' ||
    label === 'construction-multi-service' ||
    label === 'tree-yard-repair-service' ||
    label === 'yard-cleanup-service'
  ) {
    return /(?:^|[^\p{L}\p{N}_-])(?:косметическ[\p{L}\p{N}_-]*\s+ремонт|требуется\s+(?:небольшой\s+)?(?:косметическ[\p{L}\p{N}_-]*\s+)?ремонт|ремонт\s+(?:фасад[\p{L}\p{N}_-]*|кузов[\p{L}\p{N}_-]*|двигател[\p{L}\p{N}_-]*|после\s+дтп|после\s+покупк[\p{L}\p{N}_-]*|не\s+требуется))(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  }

  return false;
}

function hasGenericDomainLikeText(value: string): boolean {
  return /\.(?:ru|рф|com|net|org|su|shop|online|site|pro|io|app|ai)(?:$|[^\p{L}\p{N}_-])/iu.test(
    value,
  );
}

function hasEmailLikeText(value: string): boolean {
  const atIndex = value.indexOf('@');
  if (atIndex <= 0 || atIndex >= value.length - 4) {
    return false;
  }

  const domainCandidate = value.slice(atIndex + 1, atIndex + 256);
  const dotIndex = domainCandidate.indexOf('.');
  return dotIndex > 0 && dotIndex < domainCandidate.length - 2;
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

  const matcher = createCommercialTextMatcher(normalizedText, rawLoweredText);
  const hasMarker = matcher.hasMarker;
  const matchesPattern = matcher.matchesPattern;
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

  const privateSingleListingHits = collectFirstPatternLabels(
    ADS_PRIVATE_SINGLE_LISTING_PATTERNS,
    matchesPattern,
    2,
  );
  for (const label of privateSingleListingHits) {
    addNegative(`private-single:${label}`, weights.privateSingleListing, true);
    hasPrivateGoodsItemContext = true;
    hasPrivateSaleContext = true;
  }

  const intentHits = collectFirstMarkers(
    ADS_INTENT_MARKERS,
    (marker) => {
      if (
        hasPropertyPrivateContext &&
        hasUtilityPaymentContext &&
        ADS_SERVICE_INTENT_MARKERS.has(marker)
      ) {
        return false;
      }

      return hasMarker(marker);
    },
    3,
  );
  for (const marker of intentHits) {
    addPositive(`intent:${marker}`, weights.intent);
    hasIntent = true;
    if (ADS_SERVICE_INTENT_MARKERS.has(marker)) {
      hasServiceOfferContext = true;
    }
    hasDealSignal = true;
  }

  const serviceOfferPatterns =
    privateSingleListingHits.length > 0
      ? ADS_SERVICE_OFFER_PATTERNS.filter(
          ({ label }) => !isPrivateObjectConditionServiceNoise(label, rawLoweredText),
        )
      : ADS_SERVICE_OFFER_PATTERNS;
  const serviceOfferHits = collectFirstPatternLabels(serviceOfferPatterns, matchesPattern, 2);
  for (const label of serviceOfferHits) {
    addPositive(`intent:${label}`, weights.serviceOffer);
    hasIntent = true;
    hasServiceOfferContext = true;
    hasDealSignal = true;
  }

  const promoHits = collectFirstMarkers(ADS_PROMO_MARKERS, hasMarker, 3);
  for (const marker of promoHits) {
    addPositive(`promo:${marker}`, weights.promo);
    hasPromoContext = true;
    hasCommercialContext = true;
  }

  const propertyAgentHits = collectFirstPatternLabels(
    ADS_PROPERTY_AGENT_PATTERNS,
    matchesPattern,
    3,
  );
  for (const label of propertyAgentHits) {
    addPositive(`property-agent:${label}`, weights.propertyAgent);
    hasPropertyAgentContext = true;
    hasBusinessContext = true;
    hasCommercialContext = true;
  }

  const commercialPropertyHits = collectFirstPatternLabels(
    ADS_PROPERTY_COMMERCIAL_PATTERNS,
    matchesPattern,
    2,
  );
  for (const label of commercialPropertyHits) {
    addPositive(`property-commercial:${label}`, weights.propertyCommercial);
    hasCommercialPropertyContext = true;
    hasBusinessContext = true;
    hasCommercialContext = true;
  }

  const businessMarkerHits = collectFirstMarkers(
    ADS_BUSINESS_MARKERS,
    (marker) =>
      !(hasPropertyPrivateContext && PROPERTY_LISTING_NOISE_BUSINESS_MARKERS.has(marker)) &&
      hasMarker(marker),
    2,
  );
  const businessHits = collectFirstPatternLabels(
    ADS_BUSINESS_PATTERNS,
    matchesPattern,
    2,
    businessMarkerHits,
  );
  for (const marker of businessHits) {
    addPositive(`business:${marker}`, weights.business);
    hasBusinessContext = true;
    hasCommercialContext = true;
  }

  const highRiskCommercialHitLabels = collectFirstPatternLabels(
    ADS_HIGH_RISK_COMMERCIAL_PATTERNS,
    matchesPattern,
    3,
  );
  for (const label of highRiskCommercialHitLabels) {
    addPositive(
      `risk:${label}`,
      ADS_HIGH_RISK_COMMERCIAL_SIGNAL_WEIGHTS.get(label) ?? weights.highRiskFallback,
    );
    hasBusinessContext = true;
    hasCommercialContext = true;
  }
  const hasP2pAccessOffer =
    highRiskCommercialHitLabels.includes('p2p-crypto-arbitrage') &&
    /(?:^|[^\p{L}\p{N}_-])(?:закрыт[\p{L}\p{N}_-]*\s+чат|инвайт|вход\s+(?:по\s+)?инвайт[\p{L}\p{N}_-]*|вход\s+в\s+(?:чат|канал|групп[\p{L}\p{N}_-]*))(?=$|[^\p{L}\p{N}_-])/iu.test(
      normalizedText,
    );
  const hasLoanCommentOffer =
    highRiskCommercialHitLabels.includes('loan-leadgen') &&
    /(?:^|[^\p{L}\p{N}_-])(?:ответ[\p{L}\p{N}_-]*\s+в\s+комментар[\p{L}\p{N}_-]*|комментар[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      normalizedText,
    );
  if (
    highRiskCommercialHitLabels.length > 0 &&
    !highRiskCommercialHitLabels.includes('government-benefit-phishing') &&
    (hasP2pAccessOffer ||
      hasLoanCommentOffer ||
      /(?:^|[^\p{L}\p{N}_-])(?:бонус|депозит|выигрыш[\p{L}\p{N}_-]*|зеркал[\p{L}\p{N}_-]*|регистрац[\p{L}\p{N}_-]*|ссылк[\p{L}\p{N}_-]*|пишите|заявк[\p{L}\p{N}_-]*|связ[ьи]|контакт[\p{L}\p{N}_-]*|мессенджер[\p{L}\p{N}_-]*|whatsapp|ватсап|telegram|телеграм|max|мах|тел\.?|телефон|звон[\p{L}\p{N}_-]*|стартов[\p{L}\p{N}_-]*\s+баланс)(?=$|[^\p{L}\p{N}_-])/iu.test(
        normalizedText,
      ))
  ) {
    addPositive('transaction:high-risk-offer', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
  }
  if (hasLoanCommentOffer) {
    addPositive('contact:comments-response', weights.contactMarker);
    hasContact = true;
    hasDealSignal = true;
  }

  const rawLinkCommercialHits = collectFirstPatternLabels(
    ADS_HIGH_RISK_RAW_LINK_PATTERNS,
    (pattern) => pattern.test(rawLoweredText),
    2,
  );
  for (const label of rawLinkCommercialHits) {
    addPositive(`risk:${label}`, weights.rawHighRiskLink);
    hasBusinessContext = true;
    hasCommercialContext = true;
  }

  const buyoutMarkerHits = collectFirstMarkers(ADS_BUYOUT_MARKERS, hasMarker, 2);
  const buyoutHits = collectFirstPatternLabels(
    ADS_BUYOUT_PATTERNS,
    matchesPattern,
    2,
    buyoutMarkerHits,
  );
  for (const marker of buyoutHits) {
    addPositive(`buyout:${marker}`, weights.buyout);
    hasBuyoutContext = true;
    hasBusinessContext = true;
    hasCommercialContext = true;
  }
  if (
    hasBuyoutContext &&
    (ADS_BUYOUT_DEAL_PATTERN.test(normalizedText) || ADS_BUYOUT_DEAL_PATTERN.test(rawLoweredText))
  ) {
    addPositive('transaction:buyout-deal', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
  }

  const hasPaydayLoanRisk = highRiskCommercialHitLabels.includes('loan-leadgen');
  const hasCryptoInvestmentRisk = highRiskCommercialHitLabels.includes('crypto-investment');
  const recruitmentMarkerHits = collectFirstMarkers(
    ADS_RECRUITMENT_MARKERS,
    (marker) =>
      !(hasPaydayLoanRisk && marker === 'зарплат') &&
      !(hasCryptoInvestmentRisk && marker === 'доход') &&
      hasMarker(marker),
    2,
  );
  const recruitmentHits = collectFirstPatternLabels(
    ADS_RECRUITMENT_PATTERNS,
    matchesPattern,
    2,
    recruitmentMarkerHits,
  );
  for (const marker of recruitmentHits) {
    addPositive(`recruitment:${marker}`, weights.recruitment);
    hasRecruitmentContext = true;
    hasCommercialContext = true;
  }
  const hasRecruitmentResponseKeywordHit =
    recruitmentHits.includes('hr-chat-recruiter') ||
    recruitmentHits.includes('remote-network-work') ||
    recruitmentHits.includes('chat-correspondence-operator') ||
    (recruitmentHits.length > 0 &&
      ADS_RECRUITMENT_PATTERNS.some(
        ({ label, pattern }) =>
          (label === 'hr-chat-recruiter' ||
            label === 'remote-network-work' ||
            label === 'chat-correspondence-operator') &&
          matchesPattern(pattern),
      ));
  if (hasRecruitmentResponseKeywordHit) {
    addPositive('contact:recruitment-response-keyword', weights.contactMarker);
    hasContact = true;
    hasDealSignal = true;
  }
  const hasLeafletDailySideJobHit =
    recruitmentHits.includes('leaflet-daily-side-job') ||
    (recruitmentHits.length > 0 &&
      ADS_RECRUITMENT_PATTERNS.some(
        ({ label, pattern }) => label === 'leaflet-daily-side-job' && matchesPattern(pattern),
      ));
  if (hasLeafletDailySideJobHit) {
    addPositive('contact:implicit-vacancy-offer', weights.contactMarker);
    hasContact = true;
    hasDealSignal = true;
  }

  const infoProductHits = collectFirstMarkers(ADS_INFO_PRODUCT_MARKERS, hasMarker, 2);
  for (const marker of infoProductHits) {
    addPositive(`info:${marker}`, weights.infoProduct);
    hasInfoProductContext = true;
    hasCommercialContext = true;
  }

  const serviceSpecialtyMarkerHits = collectFirstMarkers(
    ADS_SERVICE_SPECIALTY_MARKERS,
    (marker) =>
      !(
        hasPropertyPrivateContext &&
        !hasServiceOfferContext &&
        PROPERTY_LISTING_NOISE_SERVICE_SPECIALTY_MARKERS.has(marker)
      ) &&
      !(
        privateSingleListingHits.length > 0 &&
        !hasServiceOfferContext &&
        isPrivateObjectConditionServiceNoise(marker, rawLoweredText)
      ) &&
      hasMarker(marker),
    3,
  );
  const serviceSpecialtyPatterns =
    privateSingleListingHits.length > 0
      ? ADS_SERVICE_SPECIALTY_PATTERNS.filter(
          ({ label }) => !isPrivateObjectConditionServiceNoise(label, rawLoweredText),
        )
      : ADS_SERVICE_SPECIALTY_PATTERNS;
  const serviceSpecialtyHits = collectFirstPatternLabels(
    serviceSpecialtyPatterns,
    matchesPattern,
    3,
    serviceSpecialtyMarkerHits,
  );
  for (const marker of serviceSpecialtyHits) {
    addPositive(`service-specialty:${marker}`, weights.serviceSpecialty);
    hasServiceSpecialtyContext = true;
  }

  const goodsRetailHits = collectFirstPatternLabels(ADS_GOODS_RETAIL_PATTERNS, matchesPattern, 3);
  for (const label of goodsRetailHits) {
    addPositive(`goods-retail:${label}`, weights.goodsRetail);
    hasGoodsRetailContext = true;
    hasCommercialContext = true;
  }
  if (goodsRetailHits.includes('plant-nursery-clearance-stock')) {
    addPositive('transaction:clearance-stock', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
  }

  const multiSkuPriceLineCount = countPatternMatches(
    rawLoweredText,
    ADS_MULTI_SKU_PRICE_LINE_PATTERN,
    4,
  );
  const retailPricePointCount = countPatternMatches(
    rawLoweredText,
    ADS_PRICE_CAPTURE_GLOBAL_PATTERN,
    4,
  );
  const goodsVariantMarkerCount = countPatternMatches(
    rawLoweredText,
    ADS_GOODS_VARIANT_MARKER_GLOBAL_PATTERN,
    4,
  );
  if (
    multiSkuPriceLineCount >= 2 ||
    (multiSkuPriceLineCount >= 1 && goodsVariantMarkerCount >= 1) ||
    (hasGoodsRetailContext && retailPricePointCount >= 2)
  ) {
    addPositive('goods-retail:multi-sku', weights.goodsRetailMultiSku);
    hasGoodsRetailContext = true;
    hasCommercialContext = true;
  }

  const groupContextHits = collectFirstMarkers(ADS_GROUP_CONTEXT_MARKERS, hasMarker, 2);
  for (const marker of groupContextHits) {
    addPositive(`group:${marker}`, weights.groupContext);
    hasGroupContext = true;
  }

  const groupPromoHits = collectFirstMarkers(ADS_GROUP_PROMO_MARKERS, hasMarker, 2);
  for (const marker of groupPromoHits) {
    addPositive(`group-promo:${marker}`, weights.groupPromo);
    hasGroupContext = true;
    hasGroupPromotionIntent = true;
    hasCallToActionContext = true;
  }

  const groupSelfReferenceHits = collectFirstMarkers(
    ADS_GROUP_SELF_REFERENCE_MARKERS,
    (marker) => hasMarker(marker),
    2,
  );
  for (const marker of groupSelfReferenceHits) {
    addPositive(`group-self:${marker}`, weights.groupSelfReference);
    hasGroupContext = true;
    hasGroupPromotionIntent = true;
  }

  const groupTradeHits = collectFirstMarkers(ADS_GROUP_TRADE_MARKERS, hasMarker, 3);
  for (const marker of groupTradeHits) {
    addPositive(`group-trade:${marker}`, weights.groupTrade);
    hasGroupTradeContext = true;
  }

  const commercialAudienceHits = collectFirstMarkers(
    ADS_COMMERCIAL_AUDIENCE_MARKERS,
    (marker) => hasMarker(marker),
    2,
  );
  for (const marker of commercialAudienceHits) {
    addPositive(`audience:${marker}`, weights.commercialAudience);
    hasCommercialAudienceContext = true;
    hasBusinessContext = true;
    hasCommercialContext = true;
  }

  const channelPlacementMarkerHits = collectFirstMarkers(
    ADS_CHANNEL_PLACEMENT_MARKERS,
    hasMarker,
    4,
  );
  const channelPlacementHits = collectFirstPatternLabels(
    ADS_CHANNEL_PLACEMENT_PATTERNS,
    matchesPattern,
    4,
    channelPlacementMarkerHits,
  );
  for (const marker of channelPlacementHits) {
    addPositive(`channel-placement:${marker}`, weights.channelPlacement);
    hasGroupContext = true;
    hasGroupTradeContext = true;
    hasGroupPromotionIntent = true;
    hasCommercialAudienceContext = true;
    hasChannelPlacementContext = true;
    hasBusinessContext = true;
    hasCallToActionContext = true;
    hasCommercialContext = true;
    hasDealSignal = true;
    if (marker === 'handmade-self-channel-promo') {
      addPositive('transaction:handmade-channel-offer', weights.transactionalKeyword);
      hasTransactional = true;
    }
  }
  if (
    hasChannelPlacementContext &&
    !hasTransactional &&
    !hasDealChannel &&
    /(?:^|[^\p{L}\p{N}_-])(?:свободн[\p{L}\p{N}_-]*\s+(?:окн[\p{L}\p{N}_-]*|мест[\p{L}\p{N}_-]*)|места\s+на\s+(?:завтра|ближайшие\s+дни)|стат[ау][\p{L}\p{N}_-]*\s+скину|охват[\p{L}\p{N}_-]*|размещени[\p{L}\p{N}_-]*|прайс|цена\s+за\s+пост|(?:вп|оп)(?=$|[^\p{L}\p{N}_-]))/iu.test(
      rawLoweredText,
    )
  ) {
    addPositive('transaction:channel-placement-offer', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
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
    hasDealSignal = true;
  }

  const callToActionHits = collectFirstMarkers(ADS_CALL_TO_ACTION_MARKERS, hasMarker, 2);
  for (const marker of callToActionHits) {
    addPositive(`cta:${marker}`, weights.callToAction);
    hasCallToActionContext = true;
  }

  if (
    (hasPriceLikeText(rawLoweredText) &&
      (ADS_PRICE_PATTERN.test(rawLoweredText) || ADS_PRICE_RANGE_PATTERN.test(rawLoweredText))) ||
    (hasPriceLikeText(normalizedText) &&
      (ADS_PRICE_PATTERN.test(normalizedText) || ADS_PRICE_RANGE_PATTERN.test(normalizedText)))
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

  const contactHits = collectFirstMarkers(ADS_CONTACT_MARKERS, hasMarker, 2);
  for (const marker of contactHits) {
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

  if (hasEmailLikeText(rawLoweredText) && ADS_EMAIL_CONTACT_PATTERN.test(rawLoweredText)) {
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

  const hasGenericDomainCommercialContext =
    hasPromoContext ||
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
    hasCallToActionContext;
  const hasGenericDomainLink =
    !hasDealChannel &&
    hasGenericDomainCommercialContext &&
    hasGenericDomainLikeText(rawLoweredText) &&
    ADS_GENERIC_DOMAIN_LINK_PATTERN.test(rawLoweredText);
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
    if (
      marker === 'для себя' &&
      hasGoodsRetailContext &&
      /(?:^|[^\p{L}\p{N}_-])(?:выбер(?:и|ите)|откро(?:й|йте)|подбер(?:и|ите))(?:[\p{L}\p{N}\s.,:;()/%+-]{0,40})для\s+себя(?=$|[^\p{L}\p{N}_-])/iu.test(
        normalizedText,
      )
    ) {
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
    if (
      marker === 'переезд' &&
      (hasServiceContext || hasServiceOfferContext || hasServiceSpecialtyContext)
    ) {
      continue;
    }

    addNegative(`private:${marker}`, weights.privateContext, true);
    hasPrivateSaleContext = true;
  }

  const privateGoodsHits = collectFirstPatternLabels(ADS_PRIVATE_GOODS_PATTERNS, matchesPattern, 2);
  for (const label of privateGoodsHits) {
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

  const hasOnlyBareQuestionSearchContext =
    hasSearchRequestContext &&
    negativeSignals.length > 0 &&
    negativeSignals.every((signal) => signal === 'context:question');
  const hasBlockingSearchRequestContext =
    hasSearchRequestContext && !hasOnlyBareQuestionSearchContext;

  if (
    !hasTransactional &&
    (hasServiceSpecialtyContext || hasServiceOfferContext || hasServiceContext) &&
    !hasBlockingSearchRequestContext &&
    !(
      ADS_PHONE_PATTERN.test(rawLoweredText) ||
      ADS_CONTEXTUAL_PHONE_PATTERN.test(rawLoweredText) ||
      ADS_MASKED_PHONE_PATTERN.test(rawLoweredText)
    ) &&
    !(
      hasPrivateGoodsItemContext &&
      !hasBusinessContext &&
      !hasDealChannel &&
      !hasPrice &&
      !hasPhoneContact
    ) &&
    /(?:^|[^\p{L}\p{N}_-])(?:звон(?:ите|ить)?|пишите?|запис[\p{L}\p{N}_-]*|выезд|замер|гаранти[\p{L}\p{N}_-]*|под\s+ключ|ежедневн[\p{L}\p{N}_-]*|круглосуточн[\p{L}\p{N}_-]*|принима(?:ю|ем)\s+заявк[\p{L}\p{N}_-]*|адрес|режим|консультац[\p{L}\p{N}_-]*|договор)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    )
  ) {
    addPositive('transaction:structured-service-offer', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
    hasServiceOfferContext = true;
    hasServiceContext = true;
    hasCommercialContext = true;
  }

  if (
    !hasTransactional &&
    (hasPropertyAgentContext || hasCommercialPropertyContext) &&
    !hasBlockingSearchRequestContext &&
    /(?:^|[^\p{L}\p{N}_-])(?:брон[\p{L}\p{N}_-]*|заброниру[\p{L}\p{N}_-]*|свободн[\p{L}\p{N}_-]*|заселени[\p{L}\p{N}_-]*|показ|договор|предоплат[\p{L}\p{N}_-]*|отч[её]тн[\p{L}\p{N}_-]*|календар[\p{L}\p{N}_-]*|заявк[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    )
  ) {
    addPositive('transaction:property-booking-offer', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
  }

  if (
    ADS_SOFT_RESPONSE_CTA_PATTERN.test(rawLoweredText) &&
    !hasBlockingSearchRequestContext &&
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
    !hasBlockingSearchRequestContext
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
    !hasBlockingSearchRequestContext &&
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
    !hasBlockingSearchRequestContext &&
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

  if (
    hasGroupContext &&
    hasGroupPromotionIntent &&
    !hasDealChannel &&
    contactHits.some((marker) => marker === 'ссылка в профиле' || marker === 'ссылка в описании')
  ) {
    addPositive('combo:group-promo+profile-contact', weights.comboGroupPromoDealWeak);
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

  if (
    hasGoodsRetailContext &&
    !hasPrivateGoodsItemContext &&
    hasContact &&
    !hasPrice &&
    !hasDealChannel &&
    matchedSignals.includes('goods-retail:collectible-flower-retail')
  ) {
    addPositive('transaction:retail-inquiry', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
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

  if (
    hasPhoneContact &&
    !hasSearchRequestContext &&
    !hasPrivateSaleContext &&
    !hasPrivateGoodsItemContext &&
    (matchedSignals.includes('service-specialty:logistics-delivery') ||
      matchedSignals.includes('service-specialty:beauty-salon-service') ||
      matchedSignals.includes('service-specialty:print-copy-service') ||
      matchedSignals.includes('service-specialty:tool-rental-service') ||
      matchedSignals.includes('service-specialty:locksmith-service') ||
      matchedSignals.includes('service-specialty:well-drilling-service') ||
      matchedSignals.includes('service-specialty:sewer-cleaning-service'))
  ) {
    addPositive('transaction:structured-service-phone-offer', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
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
