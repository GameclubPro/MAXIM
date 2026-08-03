import { stripUrlsFromText } from '../../common/url-text.util';
import type { CommercialCampaignContext } from '../commercial-campaign.util';
import type { CommercialThresholdProfile } from '../rule-engine-commercial-thresholds';
import type { CommercialSubtype } from '../rule-engine.contract';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import { buildCommercialFeatureVector } from './commercial-explain';
import { collectCommercialHighRiskRecallHits } from './commercial-high-risk-recall';
import { normalizeCommercialRawText, normalizeCommercialText } from './commercial-normalization';
import { resolveCommercialLocalContext } from './commercial-local-context';
import { hasCommercialPhoneLikeText, replaceCommercialPhoneLikeText } from './commercial-phone';
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
  ADS_EXPLICIT_SOURCE_SIDE_PROMO_FRAME_PATTERN,
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
  ADS_CONTEXTUAL_LINK_PLACEHOLDER_PATTERN,
  ADS_MARKETPLACE_LINK_PATTERN,
  ADS_MARKETPLACE_SERVICE_LINK_PATTERN,
  ADS_GENERIC_DOMAIN_LINK_PATTERN,
  ADS_PRICE_PATTERN,
  ADS_PRICE_RANGE_PATTERN,
  ADS_CONTEXTUAL_PRICE_PLACEHOLDER_PATTERN,
  ADS_IMPLIED_PRICE_PATTERN,
  ADS_TRANSACTIONAL_PATTERN,
  ADS_PRIVATE_LOW_QUANTITY_GOODS_PATTERN,
  ADS_PRIVATE_LOW_QUANTITY_COMMERCIAL_OVERRIDE_PATTERN,
  ADS_PLANT_MULTI_PRICE_LISTING_PATTERN,
  ADS_PROPERTY_UTILITY_PAYMENT_PATTERN,
  ADS_URGENCY_PATTERN,
  ADS_QUANTITY_PATTERN,
  ADS_CONTEXTUAL_PHONE_PATTERN,
  ADS_CONTEXTUAL_PHONE_PLACEHOLDER_PATTERN,
  ADS_CURRENT_SERVICE_BOOKING_OFFER_PATTERN,
  ADS_MASKED_PHONE_PATTERN,
  ADS_HANDLE_CONTACT_PATTERN,
  ADS_EMAIL_CONTACT_PATTERN,
  ADS_SOFT_RESPONSE_CTA_PATTERN,
  ADS_PRICE_CAPTURE_GLOBAL_PATTERN,
  ADS_GOODS_VARIANT_MARKER_GLOBAL_PATTERN,
  ADS_MULTI_SKU_PRICE_LINE_PATTERN,
} from './commercial-patterns';
import { resolveMissingCommercialAnchors } from './commercial-subtypes';
import {
  isCommercialEscalationRiskSignal,
  resolveCommercialSignalEvidence,
} from './commercial-evidence';
import { selectServiceSpecialtyPatterns } from './commercial-service-specialty-prefilter';
import {
  hasStrongCommercialGroupSubscribeFrame,
  resolveGroupPromotionRecall,
  resolveLocalServiceRecall,
  resolveManualLaborServiceRecall,
  resolveProfessionalPropertyRecall,
  resolveProfessionalRetailRecall,
  resolveRecurringBuyoutRecall,
  resolveStructuredRecruitmentRecall,
  resolveTourEventRentalRecall,
  resolveTransportServiceRecall,
} from './commercial-recall-patterns';
import type {
  CommercialFeatureVector,
  CommercialRequiredAnchor,
  CommercialSignalState,
} from './commercial.types';

const STRUCTURED_TRANSPORT_CONTACT_SPECIALTIES = new Set([
  'advance-airport-station-transfer',
  'professional-passenger-parcel-transfer',
  'scheduled-round-trip-door-to-door',
  'scheduled-round-trip-parcel-route',
  'taxiing-contact-self-offer',
]);

const IMPLICIT_STRUCTURED_SERVICE_SPECIALTIES = new Set([
  ...STRUCTURED_TRANSPORT_CONTACT_SPECIALTIES,
  'address-sign-service',
  'currency-exchange-service',
  'custom-3d-printing',
  'custom-gingerbread-order',
  'custom-ribbon-bouquet',
  'custom-song-package',
  'banquet-hall-catalog',
  'construction-service-catalog',
  'cosmetic-procedure-catalog',
  'divination-self-offer',
  'event-bus-hire',
  'inflatable-trampoline-rental',
  'local-mowing-self-offer',
  'multi-route-transport-table',
  'sauna-under-key-service',
  'seasonal-lodging-offer',
  'scheduled-passenger-parcel-route',
  'taxi-callsign-availability',
  'taxi-driver-self-offer',
  'tourist-lodging-offer',
  'well-drilling-self-offer',
]);

const MAX_EXPLICIT_FUEL_RETAIL_TEXT_LENGTH = 8_000;
const MAX_EXPLICIT_FUEL_RETAIL_CLAUSES = 24;

const EXPLICIT_FUEL_OFFER_ANCHOR_PREFILTER =
  /(?:бензин[а-яё-]*|дизел[а-яё-]*|топлив[а-яё-]*|нефтепродукт[а-яё-]*|аи(?:[\s\p{Pd}-])?(?:80|92|95|98|100)|(?:^|[^\p{L}\p{N}_-])дт(?=$|[^\p{L}\p{N}_-]))/iu;
const EXPLICIT_FUEL_SELLER_PREFILTER =
  /(?:^|[^\p{L}\p{N}_-])(?:азс|прода(?:ю|ем|[её]т|ют)|предлага(?:ю|ем|ет|ют)|реализу(?:ю|ем|ет|ют)|поставля(?:ю|ем|ет|ют)|(?:в|на)\s+наш(?:ем|ей)\s+(?:магазин[а-яё-]*|азс)|у\s+нас|в\s+продаже|в\s+наличии|доставк[а-яё-]*\s+топлив[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const FUEL_EDITORIAL_REPORTING_PREFILTER =
  /(?:^|[^\p{L}\p{N}_-])(?:по\s+данн[а-яё-]*|согласно\s+(?:данн[а-яё-]*|мониторинг[а-яё-]*)|мониторинг[а-яё-]*|средн[а-яё-]*\s+цен[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const FUEL_SOURCE_SIDE_OWNERSHIP_PREFILTER =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:у\s+нас|(?:в|на)\s+наш(?:ем|ей)\s+(?:магазин[а-яё-]*|азс))|(?:прода(?:ю|ем|ём)|предлага(?:ю|ем|ём)|реализу(?:ю|ем|ём)|поставля(?:ю|ем|ём)))(?=$|[^\p{L}\p{N}_-])/iu;
const FUEL_SOURCE_SIDE_CTA_PREFILTER =
  /(?:^|[^\p{L}\p{N}_-])(?:закаж[а-яё-]*|звон[а-яё-]*|пишите?|остав(?:ьте|ляйте)\s+заявк[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const FUEL_EDITORIAL_CONTACT_PREFILTER =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:телефон|номер)\s+редакци[а-яё-]*|по\s+вопрос[а-яё-]*\s+(?:публикаци[а-яё-]*|редакци[а-яё-]*|новост[а-яё-]*)(?:[^.!?;\n]{0,80})(?:звон[а-яё-]*|пишите?)|(?:звон[а-яё-]*|пишите?)(?:[^.!?;\n]{0,48})(?:в|к)\s+редакци[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const FUEL_INACTIVE_RETAIL_PREFILTER =
  /(?:^|[^\p{L}\p{N}_-])(?:азс(?:[^.!?;\n]{0,100})(?:закры(?:т|л)[а-яё-]*|не\s+(?:работа[а-яё-]*|существу[а-яё-]*)|снесл[а-яё-]*|демонтирован[а-яё-]*|ликвидирован[а-яё-]*|прекратил[а-яё-]*\s+(?:работ[а-яё-]*|деятельност[а-яё-]*))|(?:бензин[а-яё-]*|дизел[а-яё-]*|топлив[а-яё-]*|нефтепродукт[а-яё-]*|аи(?:[\s\p{Pd}-])?(?:80|92|95|98|100)|дт)(?:[^.!?;\n]{0,100})(?:в\s+продаже\s+больше\s+нет|больше\s+нет|не\s+(?:прода[а-яё-]*|реализу[а-яё-]*|поставля[а-яё-]*))|больше\s+не\s+(?:прода[а-яё-]*|реализу[а-яё-]*|поставля[а-яё-]*)(?:[^.!?;\n]{0,80})(?:бензин[а-яё-]*|дизел[а-яё-]*|топлив[а-яё-]*|нефтепродукт[а-яё-]*|аи(?:[\s\p{Pd}-])?(?:80|92|95|98|100)|дт))(?=$|[^\p{L}\p{N}_-])/iu;
const FUEL_ACCESS_CLOSURE_PREFILTER =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:дорог[а-яё-]*|проезд[а-яё-]*|подъезд[а-яё-]*|въезд[а-яё-]*|выезд[а-яё-]*|трасс[а-яё-]*)(?:[^.!?;\n]{0,48})закры[а-яё-]*|закры[а-яё-]*(?:[^.!?;\n]{0,48})(?:дорог[а-яё-]*|проезд[а-яё-]*|подъезд[а-яё-]*|въезд[а-яё-]*|выезд[а-яё-]*|трасс[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu;
const FUEL_PARTIAL_OUTAGE_PREFILTER =
  /(?:^|[^\p{L}\p{N}_-])азс(?:[^.!?;\n]{0,100})(?:(?:временно\s+)?не\s+работа[а-яё-]*\s+(?:терминал[а-яё-]*|касс[а-яё-]*|оплат[а-яё-]*|карт[а-яё-]*|колонк[а-яё-]*|ночью|по\s+ночам|с\s+\d{1,2}(?::\d{2})?|до\s+\d{1,2}(?::\d{2})?)|закрыл[а-яё-]*\s+(?:одн[ау]\s+)?(?:колонк[ауи]|касс[ауи]|терминал[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu;
const FUEL_CURRENT_REOPENING_PREFILTER =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:(?:но|а)\s+)?(?:теперь|сейчас|сегодня|завтра|с\s+(?:понедельник[а-яё-]*|вторник[а-яё-]*|сред[ыа]|четверг[а-яё-]*|пятниц[ыа]|суббот[ыа]|воскресень[яе]|\d{1,2}(?:[./-]\d{1,2})?)|после\s+(?:\d{1,2}(?::\d{2})?|ремонт[а-яё-]*))\s+(?:(?:(?:снова|вновь)\s+)?(?:работа(?:ем|ет)|прода(?:ю|ем|[её]т|ют)|предлага(?:ю|ем|ет|ют)|(?:бензин[а-яё-]*|дизел[а-яё-]*|топлив[а-яё-]*|аи(?:[\s\p{Pd}-])?(?:80|92|95|98|100)|дт)\s+в\s+наличи[а-яё-]*)|(?:(?:снова|вновь)\s+)?откры(?:лась|лись|та|то|ты)(?=[\s\S]{0,220}(?:бензин[а-яё-]*|дизел[а-яё-]*|топлив[а-яё-]*|аи(?:[\s\p{Pd}-])?(?:80|92|95|98|100)|дт)(?:[\s\S]{0,100})(?:в\s+наличи[а-яё-]*|прода(?:ю|ем|[её]т|ют)|предлага(?:ю|ем|ет|ют)))|(?:на|в)\s+наш(?:ей|ем)\s+азс(?=[^.!?;\n]{0,180}(?:работаем|прода(?:ю|ем|[её]т|ют)|в\s+наличи[а-яё-]*)))|(?:у\s+нас|(?:на|в)\s+наш(?:ей|ем)\s+азс)(?=[^.!?;\n]{0,180}(?:работаем|прода(?:ю|ем|[её]т|ют)|в\s+наличи[а-яё-]*)))(?=$|[^\p{L}\p{N}_-])/iu;
const FUEL_CURRENT_NAMED_RETAIL_PREFILTER =
  /(?:^|[^\p{L}\p{N}_-])азс(?:\s+[\p{L}\p{N}_-]{2,40}){0,4}(?![\s\S]{0,260}(?:музе[йя][а-яё-]*|кафе|тогда|раньше|когда\s+она\s+работал[а-яё-]*|по\s+стар[а-яё-]*\s+объявлени[а-яё-]*))(?=[\s\S]{0,260}(?:бензин[а-яё-]*|дизел[а-яё-]*|топлив[а-яё-]*|аи(?:[\s\p{Pd}-])?(?:80|92|95|98|100)|дт))(?=[\s\S]{0,260}(?:прода(?:ю|ем|[её]т|ют)|в\s+наличи[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu;

const RIDESHARE_SENSITIVE_TAXI_SPECIALTIES = new Set([
  'taxi-callsign-availability',
  'taxi-driver-self-offer',
]);

const CONSERVATIVE_PROPERTY_AGENT_SPECIALTIES = new Set([
  'agent-object-id-contact',
  'commission-rental-contact',
  'multi-property-directory-contact',
  'professional-property-spec-listing',
]);

const EXPLICIT_STRUCTURED_SERVICE_INTENT = new Set([
  ...STRUCTURED_TRANSPORT_CONTACT_SPECIALTIES,
  'event-bus-hire',
  'multi-route-transport-table',
  'scheduled-passenger-parcel-route',
  'taxi-driver-self-offer',
]);

const THIRD_PARTY_SERVICE_RECOMMENDATION_PREFILTER =
  /(?:электрик|мастер|сантехник|водител|такси|химчист|ремонт|подрядчик|договор|протокол|управляющ[а-яё-]*\s+компани|(?:^|[^\p{L}\p{N}_-])акт[еу](?=$|[^\p{L}\p{N}_-]))/iu;
const PUBLIC_SERVICE_WORK_ASSERTION_PATTERN =
  /^(?:(?:сегодня|по\s+данн[ыа-яё-]*|в\s+город[еа]?)\s+)?(?:администраци[яи]|мчс|власт[ьи]|городск[\p{L}\p{N}_-]*\s+служб[\p{L}\p{N}_-]*|экстренн[\p{L}\p{N}_-]*\s+служб[\p{L}\p{N}_-]*|оперативн[\p{L}\p{N}_-]*\s+штаб)(?:[^.!?;\n]{0,240})(?:выполня[а-яё-]*|вед[а-яё-]*|начал[а-яё-]*|приступил[а-яё-]*|провод[а-яё-]*|ремонтиру[а-яё-]*|восстанавлива[а-яё-]*)(?:[^.!?;\n]{0,100})(?:ремонт[а-яё-]*|работ[а-яё-]*|последстви[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const PUBLIC_SERVICE_CONTACT_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:телефон|номер)(?:[\p{L}\p{N}\s,:-]{0,48})(?:диспетчер[а-яё-]*|штаб[а-яё-]*|администраци[иия]|мчс|служб[а-яё-]*|горяч[а-яё-]*\s+лини[а-яё-]*|подрядчик[а-яё-]*|подрядн[а-яё-]*\s+организаци[а-яё-]*)|(?:звоните|обращайтесь|пишите)(?:[\p{L}\p{N}\s,:-]{0,48})(?:диспетчер[а-яё-]*|штаб[а-яё-]*|администраци[иия]|мчс|служб[а-яё-]*|горяч[а-яё-]*\s+лини[а-яё-]*|подрядчик[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu;
const PUBLIC_SERVICE_CONTACT_ASSERTION_PATTERN =
  /^(?:по\s+вопрос[а-яё-]*(?:[\p{L}\p{N}\s,:-]{0,32}))?(?:(?:телефон|номер)(?:[\p{L}\p{N}\s,:-]{0,48})(?:диспетчер[а-яё-]*|штаб[а-яё-]*|администраци[иия]|мчс|служб[а-яё-]*|горяч[а-яё-]*\s+лини[а-яё-]*|подрядчик[а-яё-]*|подрядн[а-яё-]*\s+организаци[а-яё-]*)|(?:звоните|обращайтесь|пишите)(?:[\p{L}\p{N}\s,:-]{0,48})(?:диспетчер[а-яё-]*|штаб[а-яё-]*|администраци[иия]|мчс|служб[а-яё-]*|горяч[а-яё-]*\s+лини[а-яё-]*|подрядчик[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu;
const INDEPENDENT_SERVICE_SELF_PROMO_ASSERTION_PATTERN =
  /^(?=[^.!?;\n]{0,320}(?:ремонт[а-яё-]*|строительств[а-яё-]*|работ[а-яё-]*|услуг[а-яё-]*))(?:(?:я|мы|наш[аиоуы]?|наша|наше|наши)\b|компани[яи]\s+[\p{L}\p{N}_-]+(?:[^.!?;\n]{0,80})(?:выполня[а-яё-]*|оказыва[а-яё-]*|предлага[а-яё-]*|ремонтиру[а-яё-]*|стро[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu;
const INDEPENDENT_SERVICE_CTA_ASSERTION_PATTERN =
  /^(?=[^.!?;\n]{0,320}(?:ремонт[а-яё-]*|строительств[а-яё-]*|работ[а-яё-]*|услуг[а-яё-]*))(?=[^.!?;\n]{0,320}(?:звоните|пишите|обращайтесь|закаж[а-яё-]*|запис[а-яё-]*|остав[а-яё-]*\s+заявк[а-яё-]*|цен[аы]|стоимост[ьи]|скидк[а-яё-]*))[^.!?;\n]+$/iu;

const RECRUITMENT_PATTERNS_WITHOUT_LEAFLET_DAILY_SIDE_JOB = ADS_RECRUITMENT_PATTERNS.filter(
  ({ label }) => label !== 'leaflet-daily-side-job',
);
const RECRUITMENT_PATTERNS_WITHOUT_MARKETPLACE_REVIEW_WORK = ADS_RECRUITMENT_PATTERNS.filter(
  ({ label }) => label !== 'marketplace-review-work',
);
const RECRUITMENT_PATTERNS_WITHOUT_EXPENSIVE_NARROW_FAMILIES = ADS_RECRUITMENT_PATTERNS.filter(
  ({ label }) => label !== 'leaflet-daily-side-job' && label !== 'marketplace-review-work',
);

const PAID_REVIEW_TASK_PREFILTER = /(?:отзыв|пост|коммент|лайк|реакци|голос|подписк)/iu;
const MARKETPLACE_REVIEW_WORK_PREFILTER = /(?:отзыв|коммент|модератор)/iu;
const PAID_RAFFLE_PREFILTER =
  /(?:розыгрыш|разыгрыва|разыгра|лотере|лот|приз|победител|выигрыш|генератор|рандомус|денежн[а-яё-]*\s+групп|[ρμӷλαωβϲηϰτƅγɥσɞχ])/iu;
const PAID_RAFFLE_TRANSFER_PREFILTER = /(?:лот|[\u{1D400}-\u{1D7FF}])/iu;
const DOCUMENT_SERVICE_PREFILTER =
  /(?:документ|(?:^|[^\p{L}\p{N}_-])прав[аы](?=$|[^\p{L}\p{N}_-])|справ|мед\s*книж|медкниж|диплом|аттестат|удостоверени|сертификат|корочк|(?:^|[^\p{L}\p{N}_-])(?:инн|снилс)(?=$|[^\p{L}\p{N}_-])|патент|миграционн[а-яё-]*\s+карт|регистрац)/iu;
const SERVICE_DOCUMENT_SPECIALTY_PREFILTER =
  /(?:водительск|документ|(?:^|[^\p{L}\p{N}_-])прав[а-яё-]*(?=$|[^\p{L}\p{N}_-]))/iu;
const BETTING_GAMBLING_PREFILTER =
  /(?:казино|букмекер|фрибет|фриспин|слот|ставк|win4land|w\s*i\s*n\s*4\s*l\s*a\s*n\s*d|к[\s._-]*[aа][\s._-]*з[\s._-]*и[\s._-]*н[\s._-]*[oо])/iu;
const CASINO_SLOT_PROMO_PREFILTER =
  /(?:maxbetslots|слот|игров[а-яё-]*\s+процесс|больш[а-яё-]*\s+выигрыш|депозит)/iu;
const PAID_GAMBLING_GROUP_PREFILTER = /[ᴛᥲᴦρᥰ᧐ᥴκ᧘ᥔᥙδʍʙɜᥱɯɸ]/u;

export function hasCommercialSpamMarkers(text: string): boolean {
  const rawLoweredText = normalizeCommercialRawText(text.toLowerCase());
  const normalizedText = normalizeCommercialText(rawLoweredText);
  if (!normalizedText) {
    return false;
  }

  const matcher = createCommercialTextMatcher(normalizedText, rawLoweredText, {
    rawLoweredTextIsCommercialNormalized: true,
  });
  const hasMarker = matcher.hasMarker;
  const matchesPattern = matcher.matchesPattern;
  const hasProfessionalCurrencyExchangeContext =
    isProfessionalCurrencyExchangeOffer(rawLoweredText);
  const hasRideShareText = ADS_RIDE_SHARE_CONTEXT_PATTERN.test(rawLoweredText);
  const hasCurrentServiceBookingOffer =
    ADS_CURRENT_SERVICE_BOOKING_OFFER_PATTERN.test(rawLoweredText);
  const hasExplicitPropertyRepairService = isExplicitPropertyRepairService(rawLoweredText);
  const hasAnimalRescueContext = isAnimalRescueContext(rawLoweredText);
  const hasPrivateGoodsPatternContext = ADS_PRIVATE_GOODS_PATTERNS.some(({ pattern }) =>
    matchesPattern(pattern),
  );
  const hasUtilityPaymentContext =
    ADS_PROPERTY_UTILITY_PAYMENT_PATTERN.test(normalizedText) ||
    ADS_PROPERTY_UTILITY_PAYMENT_PATTERN.test(rawLoweredText);
  const hasPropertyPrivateContext =
    ADS_PROPERTY_PRIVATE_PATTERNS.some(
      ({ label, pattern }) =>
        !(
          label === 'property-listing' &&
          (hasCurrentServiceBookingOffer || hasExplicitPropertyRepairService)
        ) && matchesPattern(pattern),
    ) || ADS_PROPERTY_CONTEXT_PATTERNS.some(({ pattern }) => matchesPattern(pattern));
  const hasPropertyAgentContext = ADS_PROPERTY_AGENT_PATTERNS.some(({ pattern }) =>
    matchesPattern(pattern),
  );
  const hasCommercialPropertyContext = ADS_PROPERTY_COMMERCIAL_PATTERNS.some(
    ({ label, pattern }) =>
      !(
        label === 'commercial-space' &&
        (hasProfessionalCurrencyExchangeContext ||
          isPrivateGoodsCommercialSpaceNoise(rawLoweredText, hasPrivateGoodsPatternContext))
      ) && matchesPattern(pattern),
  );

  const hasPromoContext = ADS_PROMO_MARKERS.some((marker) => hasMarker(marker));
  const hasBuyoutContext = ADS_BUYOUT_MARKERS.some((marker) => hasMarker(marker));
  const recruitmentPatterns = selectRecruitmentPatterns(rawLoweredText, normalizedText);
  const hasRecruitmentContext =
    ADS_RECRUITMENT_MARKERS.some((marker) => hasMarker(marker)) ||
    recruitmentPatterns.some(({ pattern }) => matchesPattern(pattern));
  const hasInfoProductContext = ADS_INFO_PRODUCT_MARKERS.some((marker) => hasMarker(marker));
  const hasHighRiskCommercialContext =
    collectHighRiskCommercialHitLabels(rawLoweredText, normalizedText, matchesPattern, 1).length >
    0;
  const hasBusinessContext =
    ADS_BUSINESS_MARKERS.some(
      (marker) =>
        !(hasPropertyPrivateContext && PROPERTY_LISTING_NOISE_BUSINESS_MARKERS.has(marker)) &&
        hasMarker(marker),
    ) ||
    ADS_BUSINESS_PATTERNS.some(({ pattern }) => matchesPattern(pattern)) ||
    hasHighRiskCommercialContext;
  const hasCommercialContext =
    hasPromoContext ||
    hasBusinessContext ||
    hasBuyoutContext ||
    hasRecruitmentContext ||
    hasInfoProductContext ||
    hasPropertyAgentContext;
  const hasIntentContext = ADS_INTENT_MARKERS.some(
    (marker) =>
      !(marker === 'продажа' && hasProfessionalCurrencyExchangeContext) &&
      !(
        hasPropertyPrivateContext &&
        hasUtilityPaymentContext &&
        ADS_SERVICE_INTENT_MARKERS.has(marker)
      ) &&
      hasMarker(marker),
  );
  const privateSingleListingHits = ADS_PRIVATE_SINGLE_LISTING_PATTERNS.filter(({ pattern }) =>
    matchesPattern(pattern),
  ).map(({ label }) => label);
  const hasPrivateSingleListingContext = privateSingleListingHits.length > 0;
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
  const serviceSpecialtyPatterns = selectServiceSpecialtyPatterns(
    ADS_SERVICE_SPECIALTY_PATTERNS,
    rawLoweredText,
    normalizedText,
  ).filter(
    ({ label }) =>
      !(
        (hasPrivateSingleListingContext || hasPropertyPrivateContext) &&
        isPrivateObjectConditionServiceNoise(label, rawLoweredText)
      ) &&
      !(hasRideShareText && RIDESHARE_SENSITIVE_TAXI_SPECIALTIES.has(label)) &&
      !(
        hasAnimalRescueContext &&
        (label === 'logistics-delivery' || label === 'moving-cargo-service')
      ) &&
      !(
        label === 'document-service' &&
        !matchesQuickPattern(SERVICE_DOCUMENT_SPECIALTY_PREFILTER, rawLoweredText, normalizedText)
      ),
  );
  const hasOrganizedWellnessTripContext = hasOrganizedWellnessTripOffer(rawLoweredText);
  const hasImplicitStructuredServiceOffer = serviceSpecialtyPatterns.some(
    ({ label, pattern }) =>
      IMPLICIT_STRUCTURED_SERVICE_SPECIALTIES.has(label) && matchesPattern(pattern),
  );
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
    ) ||
    serviceSpecialtyPatterns.some(({ pattern }) => matchesPattern(pattern)) ||
    hasOrganizedWellnessTripContext;
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
    ADS_CONTEXTUAL_LINK_PLACEHOLDER_PATTERN.test(rawLoweredText) ||
    ADS_MARKETPLACE_SERVICE_LINK_PATTERN.test(rawLoweredText) ||
    ADS_CONTEXTUAL_PHONE_PATTERN.test(rawLoweredText) ||
    hasCommercialPhoneLikeText(rawLoweredText) ||
    ADS_CONTEXTUAL_PHONE_PLACEHOLDER_PATTERN.test(rawLoweredText) ||
    ADS_MASKED_PHONE_PATTERN.test(rawLoweredText) ||
    ADS_HANDLE_CONTACT_PATTERN.test(rawLoweredText) ||
    (hasEmailLikeText(rawLoweredText) && ADS_EMAIL_CONTACT_PATTERN.test(rawLoweredText)) ||
    (hasPriceLikeText(rawLoweredText) &&
      (ADS_PRICE_PATTERN.test(rawLoweredText) || ADS_PRICE_RANGE_PATTERN.test(rawLoweredText))) ||
    ADS_CONTEXTUAL_PRICE_PLACEHOLDER_PATTERN.test(rawLoweredText) ||
    ADS_TRANSACTIONAL_PATTERN.test(normalizedText) ||
    hasImplicitStructuredServiceOffer ||
    hasIntentContext ||
    ADS_CONTACT_MARKERS.some((marker) => hasMarker(marker));
  const hasServiceCommercialContext =
    (hasServiceOfferContext && hasDealSignal) ||
    (hasServiceSpecialtyContext && hasDealSignal && !hasSearchRequestContext);
  const goodsRetailPatterns = ADS_GOODS_RETAIL_PATTERNS.filter(
    ({ label }) =>
      label !== 'animal-breeder-retail' ||
      (!privateSingleListingHits.includes('private-pet-sale') &&
        !isAnimalRescueContext(rawLoweredText) &&
        !isPrivatePetAccessoryListing(rawLoweredText)),
  );
  const hasGoodsRetailContext =
    goodsRetailPatterns.some(({ pattern }) => matchesPattern(pattern)) ||
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
    hasPrivateGoodsPatternContext;
  const hasStrongGoodsRetailContext =
    goodsRetailPatterns.some(({ pattern }) => matchesPattern(pattern)) ||
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
    ADS_PRIVATE_CONTEXT_MARKERS.some(
      (marker) =>
        !(marker === 'обмен' && hasProfessionalCurrencyExchangeContext) &&
        hasPrivateContextMarkerHit(marker, hasMarker, rawLoweredText),
    );
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

export function hasExplicitSelfPromotionalCommercialContext(
  state: CommercialSignalState,
  rawLoweredText: string,
): boolean {
  const nonPromoSignals = state.matchedSignals.filter((signal) => !signal.startsWith('promo:'));
  return (
    hasExplicitSelfPromotionalSignals(nonPromoSignals) ||
    hasExplicitLinkedBoundedGroupPromotion(state, rawLoweredText) ||
    (state.matchedSignals.some((signal) => signal.startsWith('promo:')) &&
      ADS_EXPLICIT_SOURCE_SIDE_PROMO_FRAME_PATTERN.test(rawLoweredText))
  );
}

export function hasExplicitLinkedBoundedGroupPromotion(
  state: CommercialSignalState,
  rawLoweredText: string,
): boolean {
  if (!/(?:\[url\]|https?:\/\/)/iu.test(rawLoweredText)) {
    return false;
  }

  const hasDirectPromotionRecall = state.matchedSignals.some(
    (signal) =>
      signal === 'recall-source:group-promo:explicit-group-promotion' ||
      signal === 'recall-source:group-promo:link-exchange-group',
  );
  const hasAcquaintanceGroupInvitation =
    state.matchedSignals.includes('recall-source:group-promo:weak-promo-link') &&
    /(?:^|[^\p{L}\p{N}_-])групп[а-яё-]*(?:[^.!?\n]{0,100})знакомств[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    ) &&
    /(?:^|[^\p{L}\p{N}_-])(?:перейдите|переходите)\s+по\s+ссылк[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );

  return hasDirectPromotionRecall || hasAcquaintanceGroupInvitation;
}

function hasExplicitSelfPromotionalSignals(matchedSignals: readonly string[]): boolean {
  const boundedRecallCompanionSignals = new Set(
    matchedSignals
      .filter((signal) => signal.startsWith('recall-source:'))
      .map((signal) => signal.slice('recall-source:'.length)),
  );
  const explicitSignalPrefixes = [
    'intent:',
    'promo:',
    'buyout:',
    'recruitment:',
    'info:',
    'cta:',
    'group-promo:',
    'group-self:',
    'channel-placement:',
    'audience:',
    'property-agent:',
    'property-commercial:',
    'goods-retail:',
  ];
  const explicitResponseSignals = new Set([
    'contact:пишите в лс',
    'contact:пишите в лич',
    'contact:пишите в личные сообщения',
    'contact:писать в личку',
    'contact:для записи',
    'contact:по записи',
    'contact:звоните',
    'contact:обращайтесь',
  ]);

  return matchedSignals.some(
    (signal) =>
      (explicitResponseSignals.has(signal) ||
        explicitSignalPrefixes.some((prefix) => signal.startsWith(prefix))) &&
      !boundedRecallCompanionSignals.has(signal),
  );
}

function hasLinkedPublicServiceEditorialFrame(rawLoweredText: string): boolean {
  const assertions = rawLoweredText
    .split(/[\n.!?;]+/u)
    .map((assertion) => assertion.trim())
    .filter(Boolean)
    .slice(0, 64);

  if (
    assertions.some(
      (assertion) =>
        !PUBLIC_SERVICE_WORK_ASSERTION_PATTERN.test(assertion) &&
        (INDEPENDENT_SERVICE_SELF_PROMO_ASSERTION_PATTERN.test(assertion) ||
          INDEPENDENT_SERVICE_CTA_ASSERTION_PATTERN.test(assertion)),
    )
  ) {
    return false;
  }

  return assertions.some((assertion, index) => {
    if (!PUBLIC_SERVICE_WORK_ASSERTION_PATTERN.test(assertion)) {
      return false;
    }
    if (PUBLIC_SERVICE_CONTACT_PATTERN.test(assertion)) {
      return true;
    }
    const nextAssertion = assertions[index + 1];
    return Boolean(nextAssertion && PUBLIC_SERVICE_CONTACT_ASSERTION_PATTERN.test(nextAssertion));
  });
}

export function hasPrivateGoodsCommercialOverride(state: CommercialSignalState): boolean {
  const hasPersonalResaleContext = state.negativeSignals.some(
    (signal) =>
      signal === 'private:б/у' ||
      signal === 'private:бу' ||
      signal === 'private:не подошл' ||
      signal === 'private-goods:resale-condition' ||
      signal === 'private-goods:private-apparel-avito-delivery' ||
      signal === 'private-goods:private-seedling-leftovers' ||
      signal === 'private-single:private-pet-sale',
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
      signal === 'goods-retail:animal-breeder-retail' ||
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
    label === 'appliance-repair' ||
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

  const matcher = createCommercialTextMatcher(normalizedText, rawLoweredText, {
    rawLoweredTextIsCommercialNormalized: true,
  });
  const hasMarker = matcher.hasMarker;
  const matchesPattern = matcher.matchesPattern;
  const hasProfessionalCurrencyExchangeContext =
    isProfessionalCurrencyExchangeOffer(rawLoweredText);
  const hasRideShareText = ADS_RIDE_SHARE_CONTEXT_PATTERN.test(rawLoweredText);
  const hasCurrentServiceBookingOffer =
    ADS_CURRENT_SERVICE_BOOKING_OFFER_PATTERN.test(rawLoweredText);
  const hasExplicitPropertyRepairService = isExplicitPropertyRepairService(rawLoweredText);
  const hasPhoneLikeText = hasCommercialPhoneLikeText(rawLoweredText);
  const hasAnimalRescueContext = isAnimalRescueContext(rawLoweredText);
  const privateGoodsPatternHits = collectFirstPatternLabels(
    ADS_PRIVATE_GOODS_PATTERNS,
    matchesPattern,
    2,
  );
  const hasUtilityPaymentContext =
    ADS_PROPERTY_UTILITY_PAYMENT_PATTERN.test(normalizedText) ||
    ADS_PROPERTY_UTILITY_PAYMENT_PATTERN.test(rawLoweredText);

  const propertyPrivateHits = [
    ...ADS_PROPERTY_PRIVATE_PATTERNS.filter(
      ({ label, pattern }) =>
        !(
          label === 'property-listing' &&
          (hasCurrentServiceBookingOffer || hasExplicitPropertyRepairService)
        ) && matchesPattern(pattern),
    ).map(({ label }) => label),
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
      if (marker === 'продажа' && hasProfessionalCurrencyExchangeContext) {
        return false;
      }
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
    4,
  );
  for (const label of propertyAgentHits) {
    addPositive(`property-agent:${label}`, weights.propertyAgent);
    hasPropertyAgentContext = true;
    hasBusinessContext = true;
    hasCommercialContext = true;
  }
  const hasConservativePropertyAgentOffer = propertyAgentHits.some((label) =>
    CONSERVATIVE_PROPERTY_AGENT_SPECIALTIES.has(label),
  );

  const commercialPropertyHits = collectFirstPatternLabels(
    ADS_PROPERTY_COMMERCIAL_PATTERNS.filter(
      ({ label }) =>
        !(
          label === 'commercial-space' &&
          (hasProfessionalCurrencyExchangeContext ||
            isPrivateGoodsCommercialSpaceNoise(rawLoweredText, privateGoodsPatternHits.length > 0))
        ),
    ),
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

  const boundedHighRiskRecallHits = collectCommercialHighRiskRecallHits(rawLoweredText);
  const highRiskCommercialHitLabels = collectHighRiskCommercialHitLabels(
    rawLoweredText,
    normalizedText,
    matchesPattern,
    3,
  );
  for (const { label, actionCap } of boundedHighRiskRecallHits) {
    if (!highRiskCommercialHitLabels.includes(label)) {
      highRiskCommercialHitLabels.push(label);
    }
    addPositive(`recall-cap:${actionCap}:${label}`, 0);
    addPositive(`recall-source:risk:${label}`, 0);
  }
  for (const label of highRiskCommercialHitLabels) {
    addPositive(
      `risk:${label}`,
      ADS_HIGH_RISK_COMMERCIAL_SIGNAL_WEIGHTS.get(label) ?? weights.highRiskFallback,
    );
    hasBusinessContext = true;
    hasCommercialContext = true;
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
  const allHighRiskLabels = [
    ...new Set([...highRiskCommercialHitLabels, ...rawLinkCommercialHits]),
  ];
  const escalationRiskLabels = allHighRiskLabels.filter((label) =>
    isCommercialEscalationRiskSignal(`risk:${label}`),
  );
  const commercialLocalContext = resolveCommercialLocalContext({
    rawLoweredText,
    escalationRiskLabels,
  });
  if (commercialLocalContext.hasIndependentEscalationOffer) {
    addPositive('locality:escalation-offer', 0);
  } else if (
    commercialLocalContext.hasOnlyProtectedEscalationMentions &&
    !commercialLocalContext.hasIndependentCommercialOffer
  ) {
    addNegative('context:reported-escalation-risk', weights.negativeMarker, true);
    hasSearchRequestContext = true;
  }
  if (boundedHighRiskRecallHits.length > 0) {
    addPositive('transaction:bounded-high-risk-recall', 0);
    hasTransactional = true;
    hasDealSignal = true;
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
  const hasPaidRaffleOffer = highRiskCommercialHitLabels.includes('paid-raffle');
  const hasPlaceholderHighRiskResponseChannel = /\[(?:phone|url)\]/iu.test(rawLoweredText);
  if (
    allHighRiskLabels.length > 0 &&
    (escalationRiskLabels.length === 0 || commercialLocalContext.hasIndependentEscalationOffer) &&
    !highRiskCommercialHitLabels.includes('government-benefit-phishing') &&
    (hasP2pAccessOffer ||
      hasLoanCommentOffer ||
      hasPaidRaffleOffer ||
      hasPlaceholderHighRiskResponseChannel ||
      /(?:^|[^\p{L}\p{N}_-])(?:бонус|депозит|выигрыш[\p{L}\p{N}_-]*|зеркал[\p{L}\p{N}_-]*|регистрац[\p{L}\p{N}_-]*|ссылк[\p{L}\p{N}_-]*|пишите|заявк[\p{L}\p{N}_-]*|связ[ьи]|контакт[\p{L}\p{N}_-]*|мессенджер[\p{L}\p{N}_-]*|whatsapp|ватсап|telegram|телеграм|max|мах|тел\.?|телефон|звон[\p{L}\p{N}_-]*|стартов[\p{L}\p{N}_-]*\s+баланс)(?=$|[^\p{L}\p{N}_-])/iu.test(
        normalizedText,
      ))
  ) {
    addPositive('transaction:high-risk-offer', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
  }
  if (highRiskCommercialHitLabels.length > 0 && hasPlaceholderHighRiskResponseChannel) {
    addPositive('contact:high-risk-response-channel', weights.contactMarker);
    hasContact = true;
    hasPhoneContact = /\[phone\]/iu.test(rawLoweredText);
    hasDealSignal = true;
  }
  if (
    (highRiskCommercialHitLabels.includes('paid-raffle') ||
      highRiskCommercialHitLabels.includes('paid-raffle-transfer')) &&
    (hasPaidRaffleRiskContext(rawLoweredText) ||
      hasPaidRaffleTransferRiskContext(rawLoweredText) ||
      hasObfuscatedPaidRaffleRiskContext(rawLoweredText))
  ) {
    addPositive('transaction:paid-raffle-entry', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
  }
  if (
    highRiskCommercialHitLabels.includes('paid-gambling-group') &&
    hasPaidGamblingGroupRiskContext(rawLoweredText)
  ) {
    addPositive('transaction:paid-gambling-entry', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
  }
  if (
    highRiskCommercialHitLabels.includes('document-service') &&
    hasExplicitIllicitDocumentServiceContext(rawLoweredText)
  ) {
    addPositive('transaction:illicit-document-deal', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
  }
  if (
    highRiskCommercialHitLabels.includes('migration-registration-service') &&
    hasIllicitMigrationRegistrationOffer(rawLoweredText)
  ) {
    addPositive('transaction:illicit-registration-deal', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
  }
  if (
    highRiskCommercialHitLabels.includes('paid-review-task') &&
    hasPaidReviewCompensationOffer(rawLoweredText)
  ) {
    addPositive('transaction:paid-review-compensation', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
  }
  if (
    highRiskCommercialHitLabels.includes('bot-income-scam') &&
    hasBotIncomeScamOffer(rawLoweredText)
  ) {
    addPositive('transaction:bot-income-leadgen', weights.transactionalKeyword);
    addPositive('contact:bot-income-response-channel', weights.contactMarker);
    hasTransactional = true;
    hasContact = true;
    hasDealSignal = true;
  }
  if (
    highRiskCommercialHitLabels.includes('unregulated-medicinal-goods') &&
    hasUnregulatedMedicinalGoodsOffer(rawLoweredText)
  ) {
    addPositive('transaction:unregulated-medicinal-goods-deal', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
  }
  if (
    highRiskCommercialHitLabels.includes('wildlife-product-sale') &&
    hasWildlifeProductSaleOffer(rawLoweredText)
  ) {
    addPositive('transaction:wildlife-product-deal', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
  }
  if (hasLoanCommentOffer) {
    addPositive('contact:comments-response', weights.contactMarker);
    hasContact = true;
    hasDealSignal = true;
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
  const recruitmentPatterns = selectRecruitmentPatterns(rawLoweredText, normalizedText);
  const hasRoleFirstVacancyContext = recruitmentPatterns.some(
    ({ label, pattern }) => label === 'role-first-vacancy' && matchesPattern(pattern),
  );
  const recruitmentSeed = hasRoleFirstVacancyContext
    ? ['role-first-vacancy', ...recruitmentMarkerHits].slice(0, 2)
    : recruitmentMarkerHits;
  const recruitmentHits = collectFirstPatternLabels(
    recruitmentPatterns,
    matchesPattern,
    2,
    recruitmentSeed,
  );
  for (const marker of recruitmentHits) {
    addPositive(`recruitment:${marker}`, weights.recruitment);
    hasRecruitmentContext = true;
    hasCommercialContext = true;
  }
  const hasConservativeStructuredOffer =
    hasConservativePropertyAgentOffer || recruitmentHits.includes('role-first-vacancy');
  if (hasConservativeStructuredOffer) {
    addPositive('transaction:conservative-recall-offer', weights.transactionalKeyword);
    hasTransactional = true;
    hasDealSignal = true;
    if (
      rawLoweredText.includes('[phone]') &&
      !ADS_CONTEXTUAL_PHONE_PLACEHOLDER_PATTERN.test(rawLoweredText)
    ) {
      addPositive('contact:contextual-phone', weights.phone);
      hasContact = true;
      hasPhoneContact = true;
    }
  }
  const hasRecruitmentResponseKeywordHit =
    recruitmentHits.includes('hr-chat-recruiter') ||
    recruitmentHits.includes('remote-network-work') ||
    recruitmentHits.includes('chat-correspondence-operator') ||
    (recruitmentHits.length > 0 &&
      recruitmentPatterns.some(
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
      recruitmentPatterns.some(
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
  const serviceSpecialtyPatterns = selectServiceSpecialtyPatterns(
    ADS_SERVICE_SPECIALTY_PATTERNS,
    rawLoweredText,
    normalizedText,
  ).filter(
    ({ label }) =>
      !(
        (privateSingleListingHits.length > 0 || hasPropertyPrivateContext) &&
        isPrivateObjectConditionServiceNoise(label, rawLoweredText)
      ) &&
      !(hasRideShareText && RIDESHARE_SENSITIVE_TAXI_SPECIALTIES.has(label)) &&
      !(
        hasAnimalRescueContext &&
        (label === 'logistics-delivery' || label === 'moving-cargo-service')
      ) &&
      !(
        label === 'document-service' &&
        !matchesQuickPattern(SERVICE_DOCUMENT_SPECIALTY_PREFILTER, rawLoweredText, normalizedText)
      ),
  );
  const hasOrganizedWellnessTripContext = hasOrganizedWellnessTripOffer(rawLoweredText);
  const serviceSpecialtySeed = hasOrganizedWellnessTripContext
    ? ['organized-wellness-trip', ...serviceSpecialtyMarkerHits].slice(0, 3)
    : serviceSpecialtyMarkerHits;
  const serviceSpecialtyHits = collectFirstPatternLabels(
    serviceSpecialtyPatterns,
    matchesPattern,
    3,
    serviceSpecialtySeed,
  );
  for (const marker of serviceSpecialtyHits) {
    addPositive(`service-specialty:${marker}`, weights.serviceSpecialty);
    hasServiceSpecialtyContext = true;
    if (EXPLICIT_STRUCTURED_SERVICE_INTENT.has(marker)) {
      addPositive(`intent:${marker}`, weights.intent);
      hasIntent = true;
      hasServiceOfferContext = true;
      hasCommercialContext = true;
    }
  }
  if (
    serviceSpecialtyHits.includes('event-bus-hire') ||
    serviceSpecialtyHits.some((label) => STRUCTURED_TRANSPORT_CONTACT_SPECIALTIES.has(label))
  ) {
    addPositive('contact:contextual-phone', weights.phone);
    hasContact = true;
    hasPhoneContact = true;
    hasDealSignal = true;
  }

  const hasImplicitStructuredServiceOffer = serviceSpecialtyHits.some((label) =>
    IMPLICIT_STRUCTURED_SERVICE_SPECIALTIES.has(label),
  );

  const goodsRetailPatterns = ADS_GOODS_RETAIL_PATTERNS.filter(
    ({ label }) =>
      label !== 'animal-breeder-retail' ||
      (!privateSingleListingHits.includes('private-pet-sale') &&
        !isAnimalRescueContext(rawLoweredText) &&
        !isPrivatePetAccessoryListing(rawLoweredText)),
  );
  const goodsRetailHits = collectFirstPatternLabels(goodsRetailPatterns, matchesPattern, 3);
  for (const label of goodsRetailHits) {
    addPositive(`goods-retail:${label}`, weights.goodsRetail);
    hasGoodsRetailContext = true;
    hasCommercialContext = true;
  }
  if (goodsRetailHits.includes('indoor-plant-assortment')) {
    addPositive('recall-cap:warn:indoor-plant-assortment', 0);
    addPositive('recall-source:goods-retail:indoor-plant-assortment', 0);
  }
  if (goodsRetailHits.includes('named-store-stock-promotion')) {
    addPositive('business:named-store-stock-promotion', weights.business);
    addPositive('transaction:conservative-retail-offer', weights.transactionalKeyword);
    hasBusinessContext = true;
    hasTransactional = true;
    hasDealSignal = true;
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

  const groupTradeHits = collectFirstMarkers(
    ADS_GROUP_TRADE_MARKERS,
    (marker) =>
      !(marker === 'продажа' && hasProfessionalCurrencyExchangeContext) && hasMarker(marker),
    3,
  );
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

  if (!hasPrice && ADS_CONTEXTUAL_PRICE_PLACEHOLDER_PATTERN.test(rawLoweredText)) {
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

  if (hasPhoneLikeText) {
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

  if (!hasPhoneContact && ADS_CONTEXTUAL_PHONE_PLACEHOLDER_PATTERN.test(rawLoweredText)) {
    addPositive('contact:contextual-phone', weights.phone);
    hasContact = true;
    hasPhoneContact = true;
    hasDealSignal = true;
  }

  if (hasGoodsRetailContext && hasPrice && isStructuredRetailPlaceholderContact(rawLoweredText)) {
    addPositive('goods-retail:structured-placeholder-contact', weights.goodsRetail);
    if (!hasPhoneContact) {
      addPositive('contact:contextual-phone', weights.phone);
    }
    hasContact = true;
    hasPhoneContact = true;
    hasDealSignal = true;
    hasBusinessContext = true;
    hasCommercialContext = true;
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

  if (!hasDealChannel && ADS_CONTEXTUAL_LINK_PLACEHOLDER_PATTERN.test(rawLoweredText)) {
    addPositive('deal-channel:contextual-link', weights.link);
    hasDealChannel = true;
    hasDealSignal = true;
  }

  const hasProfessionalLocalRetailOrder =
    hasGoodsRetailContext &&
    hasPrice &&
    (hasPhoneContact || hasDealChannel) &&
    ((matchedSignals.includes('goods-retail:multi-sku') &&
      (hasBusinessContext ||
        (matchedSignals.includes('intent:принимаем заказы') && hasPromoContext))) ||
      (matchedSignals.includes('goods-retail:poultry-farm-order') && hasPromoContext && hasIntent));
  if (hasProfessionalLocalRetailOrder) {
    addPositive('goods-retail:professional-order-catalog', weights.goodsRetail);
    hasBusinessContext = true;
    hasCommercialContext = true;
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

  const boundedRecallText = replaceCommercialPhoneLikeText(rawLoweredText);
  const hasRuntimePhoneRecallReplacement = boundedRecallText !== rawLoweredText;
  const hasExplicitRuntimePropertyOfferAnchor =
    /(?:^|[^\p{L}\p{N}_-])(?:цен[аы]|стоимост[\p{L}\p{N}_-]*|аренд[аы]|арендн[\p{L}\p{N}_-]*\s+плат[аы]|продаж[аы]|прода[её]тся|сда[её]тся|комисси[яи]|агентств[\p{L}\p{N}_-]*|риелтор[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasProfessionalRuntimePropertyCardAnchor =
    /^(?=[\s\S]{0,1400}(?:^|[^\p{L}\p{N}_-])(?:жк|мкр)\.?\s+[\p{L}\p{N}_-]{3,})(?=[\s\S]{0,1400}(?:(?:вся|полная)\s+(?:сумма\s+)?(?:в\s+)?дкп|разбивк[\p{L}\p{N}_-]*\s+в\s+дкп|без\s+обременени[йя]))(?=[\s\S]{0,1400}\d[\d\s.,]{4,}\s*(?:₽|руб(?:л[ьяе]|лей)?|млн|т\.?\s*р\.?))[\s\S]*$/iu.test(
      rawLoweredText,
    );
  const boundedRecallMatches = [
    {
      family: 'goods' as const,
      match: resolveProfessionalRetailRecall({
        text: boundedRecallText,
        campaignContext: commercialCampaignContext,
      }),
    },
    { family: 'service' as const, match: resolveLocalServiceRecall(boundedRecallText) },
    {
      family: 'property' as const,
      match: hasConservativePropertyAgentOffer
        ? null
        : hasRuntimePhoneRecallReplacement &&
            hasPropertyPrivateContext &&
            !hasExplicitRuntimePropertyOfferAnchor &&
            !hasProfessionalRuntimePropertyCardAnchor &&
            !commercialCampaignContext
          ? null
          : resolveProfessionalPropertyRecall({
              text: boundedRecallText,
              campaignContext: commercialCampaignContext,
            }),
    },
    {
      family: 'recruitment' as const,
      match: recruitmentHits.includes('role-first-vacancy')
        ? null
        : resolveStructuredRecruitmentRecall(boundedRecallText),
    },
    { family: 'service' as const, match: resolveManualLaborServiceRecall(boundedRecallText) },
    {
      family: 'group' as const,
      match: resolveGroupPromotionRecall({
        text: boundedRecallText,
        campaignContext: commercialCampaignContext,
      }),
    },
    { family: 'service' as const, match: resolveTransportServiceRecall(boundedRecallText) },
    {
      family: 'service' as const,
      match: resolveTourEventRentalRecall({
        text: boundedRecallText,
        campaignContext: commercialCampaignContext,
      }),
    },
    {
      family: 'buyout' as const,
      match: resolveRecurringBuyoutRecall({
        text: boundedRecallText,
        campaignContext: commercialCampaignContext,
      }),
    },
  ].filter(
    (
      entry,
    ): entry is {
      family: 'goods' | 'service' | 'property' | 'recruitment' | 'group' | 'buyout';
      match: NonNullable<typeof entry.match>;
    } => entry.match !== null,
  );

  for (const { family, match } of boundedRecallMatches) {
    if (family === 'goods') {
      addPositive(`goods-retail:${match.label}`, weights.goodsRetail);
      addPositive(`recall-source:goods-retail:${match.label}`, 0);
      hasGoodsRetailContext = true;
    } else if (family === 'property') {
      addPositive(`property-agent:${match.label}`, weights.propertyAgent);
      addPositive(`recall-source:property-agent:${match.label}`, 0);
      hasPropertyAgentContext = true;
    } else if (family === 'recruitment') {
      addPositive(`recruitment:${match.label}`, weights.recruitment);
      addPositive(`recall-source:recruitment:${match.label}`, 0);
      hasRecruitmentContext = true;
    } else if (family === 'group') {
      addPositive(`group-promo:${match.label}`, weights.groupPromo);
      addPositive(`recall-source:group-promo:${match.label}`, 0);
      hasGroupContext = true;
      hasGroupPromotionIntent = true;
      hasGroupPromoContext = true;
      hasCallToActionContext = true;
    } else if (family === 'buyout') {
      addPositive(`buyout:${match.label}`, weights.buyout);
      addPositive(`recall-source:buyout:${match.label}`, 0);
      hasBuyoutContext = true;
    } else {
      addPositive(`service-specialty:${match.label}`, weights.serviceSpecialty);
      addPositive(`recall-source:service-specialty:${match.label}`, 0);
      hasServiceContext = true;
      hasServiceOfferContext = true;
      hasServiceSpecialtyContext = true;
    }
    hasBusinessContext = true;
    hasCommercialContext = true;
  }

  if (boundedRecallMatches.length > 0) {
    const capMatch =
      boundedRecallMatches.find(({ match }) => match.cap === 'WARN') ?? boundedRecallMatches[0];
    const capLabel = capMatch.match.cap === 'WARN' ? 'warn' : 'review';
    addPositive(`recall-cap:${capLabel}:${capMatch.match.label}`, 0);
    addPositive('transaction:bounded-recall-offer', weights.transactionalKeyword);
    hasIntent = true;
    hasTransactional = true;
    hasDealSignal = true;
  }

  const explicitFuelRetailContext = resolveExplicitFuelRetailContext(rawLoweredText);
  const hasExplicitFuelRetailRecall = explicitFuelRetailContext.hasCurrentOffer;
  if (hasExplicitFuelRetailRecall) {
    addPositive('goods-retail:explicit-fuel-retail', weights.goodsRetail);
    addPositive('recall-source:goods-retail:explicit-fuel-retail', 0);
    addPositive('recall-cap:warn:explicit-fuel-retail', 0);
    addPositive('transaction:bounded-recall-offer', weights.transactionalKeyword);
    hasGoodsRetailContext = true;
    hasBusinessContext = true;
    hasCommercialContext = true;
    hasIntent = true;
    hasTransactional = true;
    hasDealSignal = true;
  }
  if (explicitFuelRetailContext.hasInactiveReport && !hasExplicitFuelRetailRecall) {
    addNegative('context:fuel-availability-report', weights.negativeMarker, true);
    hasSearchRequestContext = true;
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

  const hasCommunityExerciseContext =
    /(?:^|[^\p{L}\p{N}_-])(?:зарядк[\p{L}\p{N}_-]*|комплекс\s+упражнени[\p{L}\p{N}_-]*|физическ[\p{L}\p{N}_-]*\s+активност[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasPaidPublicTrainingOffer =
    hasPrice ||
    /(?:^|[^\p{L}\p{N}_-])(?:платн[\p{L}\p{N}_-]*|стоимост[\p{L}\p{N}_-]*|цен[\p{L}\p{N}_-]*|оплат[\p{L}\p{N}_-]*|абонемент[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasCommunityExerciseCommercialOffer =
    hasCommunityExerciseContext &&
    (hasPaidPublicTrainingOffer ||
      hasContact ||
      hasDealChannel ||
      /(?:^|[^\p{L}\p{N}_-])(?:фитнес[\s-]*клуб[\p{L}\p{N}_-]*|фитнес[\s-]*студи[\p{L}\p{N}_-]*|персональн[\p{L}\p{N}_-]*\s+тренировк[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
        rawLoweredText,
      ));
  const hasAttributedPublicServiceEditorialFrame =
    hasLinkedPublicServiceEditorialFrame(rawLoweredText);
  const hasOwnedMerchantNewsFrame =
    /(?:^|[^\p{L}\p{N}_-])новост[а-яё-]*(?:[^.!?;\n]{0,80})наш[а-яё-]*\s+магазин[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasExplicitLocalNewsCommercialOffer =
    !hasAttributedPublicServiceEditorialFrame &&
    (hasOwnedMerchantNewsFrame ||
      /(?:^|[^\p{L}\p{N}_-])(?:закаж[\p{L}\p{N}_-]*|купить|прода(?:м|ю|ем|[её]тся)|запис[\p{L}\p{N}_-]*|брониру[\p{L}\p{N}_-]*|прайс[\p{L}\p{N}_-]*|звоните|пишите\s+(?:в\s+)?(?:лс|личк[\p{L}\p{N}_-]*))(?=$|[^\p{L}\p{N}_-])/iu.test(
        rawLoweredText,
      ));
  const hasStructuredLocalNewsCommercialOffer =
    hasPhoneContact &&
    hasServiceOfferContext &&
    (hasServiceContext || hasServiceSpecialtyContext || hasBusinessContext) &&
    matchedSignals.some((signal) => signal.startsWith('intent:')) &&
    !hasAttributedPublicServiceEditorialFrame;
  const hasExplicitLocalNewsGroupPromotion =
    matchedSignals.includes('recall-source:group-promo:explicit-group-promotion') &&
    hasStrongCommercialGroupSubscribeFrame(rawLoweredText) &&
    hasOwnedMerchantNewsFrame;
  const hasPublicHelpCommercialCatalog =
    hasGoodsRetailContext &&
    hasPrice &&
    (hasContact || hasDealChannel || hasCallToActionContext) &&
    /(?:^|[^\p{L}\p{N}_-])(?:каталог[а-яё-]*|в\s+наличи[а-яё-]*|стоимост[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );

  for (const { label, pattern } of ADS_COMMERCIAL_DISCUSSION_NEGATIVE_PATTERNS) {
    const matchesDiscussionContext =
      label === 'attributed-commercial-report'
        ? commercialLocalContext.hasAttributedCommercialReport
        : pattern.test(normalizedText) || pattern.test(rawLoweredText);
    if (!matchesDiscussionContext) {
      continue;
    }
    if (
      (label === 'channel-ad-due-diligence' &&
        commercialLocalContext.hasIndependentEscalationOffer) ||
      (label === 'public-fraud-warning' && commercialLocalContext.hasIndependentCommercialOffer) ||
      (label === 'public-help-request' &&
        (commercialLocalContext.hasIndependentCommercialOffer || hasPublicHelpCommercialCatalog)) ||
      (label === 'moderation-ad-discussion' &&
        commercialLocalContext.hasIndependentCommercialOffer) ||
      (label === 'local-news-subscribe' &&
        (hasExplicitLocalNewsCommercialOffer ||
          hasStructuredLocalNewsCommercialOffer ||
          hasExplicitLocalNewsGroupPromotion))
    ) {
      continue;
    }
    if (
      (label === 'animal-adoption' ||
        label === 'fuel-availability-report' ||
        label === 'fuel-price-analysis' ||
        label === 'public-help-request' ||
        label === 'pseudomedical-attribution-or-debunking') &&
      resolveCommercialSignalEvidence(matchedSignals).hasEscalationRiskEvidence
    ) {
      continue;
    }
    if (
      label === 'public-training-or-event' &&
      (serviceSpecialtyHits.includes('organized-wellness-trip') ||
        hasPaidPublicTrainingOffer ||
        hasCommunityExerciseCommercialOffer ||
        resolveCommercialSignalEvidence(matchedSignals).hasEscalationRiskEvidence)
    ) {
      continue;
    }
    if (
      label === 'animal-adoption' &&
      goodsRetailHits.includes('animal-breeder-retail') &&
      (hasPrice || hasContact || hasDealChannel) &&
      (hasTransactional || hasCallToActionContext || hasBusinessContext || hasContact)
    ) {
      continue;
    }
    if (
      (label === 'fuel-availability-report' || label === 'fuel-price-analysis') &&
      hasExplicitFuelRetailRecall &&
      (hasContact ||
        hasDealChannel ||
        hasCallToActionContext ||
        hasBusinessContext ||
        hasGoodsRetailContext)
    ) {
      continue;
    }
    if (label === 'fuel-price-analysis' && commercialLocalContext.hasIndependentCommercialOffer) {
      continue;
    }

    addNegative(`context:${label}`, weights.negativeMarker, true);
    hasSearchRequestContext = true;
  }

  const hasActionableEscalationOffer = (() => {
    const signalEvidence = resolveCommercialSignalEvidence(matchedSignals);
    return signalEvidence.hasEscalationRiskEvidence && signalEvidence.hasActionDirectDealEvidence;
  })();

  for (const marker of ADS_QUESTION_CONTEXT_MARKERS) {
    if (!hasMarker(marker)) {
      continue;
    }
    if (hasActionableEscalationOffer) {
      continue;
    }

    addNegative(`context:${marker}`, weights.questionContext, true);
    hasSearchRequestContext = true;
  }

  for (const marker of ADS_PRIVATE_CONTEXT_MARKERS) {
    if (!hasPrivateContextMarkerHit(marker, hasMarker, rawLoweredText)) {
      continue;
    }
    if (hasPropertyAgentContext || hasCommercialPropertyContext) {
      continue;
    }
    if (hasGoodsRetailContext && marker === 'самовывоз') {
      continue;
    }
    if (marker === 'обмен' && hasProfessionalCurrencyExchangeContext) {
      continue;
    }
    if (
      marker === 'обмен' &&
      hasBuyoutContext &&
      matchedSignals.includes('transaction:buyout-deal')
    ) {
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

  for (const label of privateGoodsPatternHits) {
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
    if (
      label === 'request:turkic-need' &&
      hasCallToActionContext &&
      (hasPrice ||
        /(?:^|[^\p{L}\p{N}_-])(?:круглосуточн[\p{L}\p{N}_-]*|24\s*\/\s*7|межгород[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
          rawLoweredText,
        ))
    ) {
      continue;
    }

    addNegative(`search-pattern:${label}`, weights.searchPattern, true);
    hasSearchRequestContext = true;
  }

  if (
    rawLoweredText.includes('?') &&
    !hasImplicitStructuredServiceOffer &&
    !(
      (hasBusinessContext || hasCallToActionContext) &&
      (hasServiceSpecialtyContext || hasServiceOfferContext || hasServiceContext) &&
      /\?(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,240})(?:мы\s+предлагаем|заказывайте)(?=$|[^\p{L}\p{N}_-])/iu.test(
        rawLoweredText,
      )
    ) &&
    !hasPrice &&
    !hasContact &&
    !hasDealChannel
  ) {
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
    (hasImplicitStructuredServiceOffer || !hasTransactional) &&
    (hasServiceSpecialtyContext || hasServiceOfferContext || hasServiceContext) &&
    !hasBlockingSearchRequestContext &&
    !(
      ADS_CONTEXTUAL_PHONE_PATTERN.test(rawLoweredText) ||
      hasPhoneLikeText ||
      ADS_MASKED_PHONE_PATTERN.test(rawLoweredText)
    ) &&
    !(
      hasPrivateGoodsItemContext &&
      !hasBusinessContext &&
      !hasDealChannel &&
      !hasPrice &&
      !hasPhoneContact
    ) &&
    (hasImplicitStructuredServiceOffer ||
      /(?:^|[^\p{L}\p{N}_-])(?:звон(?:ите|ить)?|пишите?|запис[\p{L}\p{N}_-]*|выезд|замер|гаранти[\p{L}\p{N}_-]*|под\s+ключ|ежедневн[\p{L}\p{N}_-]*|круглосуточн[\p{L}\p{N}_-]*|принима(?:ю|ем)\s+заявк[\p{L}\p{N}_-]*|адрес|режим|консультац[\p{L}\p{N}_-]*|договор)(?=$|[^\p{L}\p{N}_-])/iu.test(
        rawLoweredText,
      ))
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

  const hasExplicitIntentSignal = matchedSignals.some((signal) => signal.startsWith('intent:'));
  if (hasExplicitIntentSignal && (hasPrice || hasContact || hasDealChannel)) {
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

  const hasCampaignInfoProductOffer =
    hasInfoProductContext &&
    (hasIntent ||
      hasCallToActionContext ||
      hasContact ||
      hasDealChannel ||
      hasPrice ||
      hasTransactional);
  if (
    hasCampaignContext &&
    hasExplicitSelfPromotionalSignals(matchedSignals) &&
    (hasPromoContext ||
      hasBusinessContext ||
      hasBuyoutContext ||
      hasRecruitmentContext ||
      hasCampaignInfoProductOffer ||
      hasServiceContext ||
      hasServiceOfferContext ||
      hasCommercialAudienceContext ||
      hasGroupPromotionIntent)
  ) {
    addPositive('combo:campaign+self-promo', weights.comboCampaignSelfPromo);
    hasCommercialContext = true;
    hasDealSignal = true;
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

export function isThirdPartyServiceRecommendation(rawLoweredText: string): boolean {
  const hasSelfAuthoredOffer =
    /(?:^|[^\p{L}\p{N}_-])(?:(?:я|мы|наш[аиоуы]?|наша|наше|наши)\s+(?:мастер[\p{L}\p{N}_-]*|электрик[\p{L}\p{N}_-]*|сантехник[\p{L}\p{N}_-]*|водител[\p{L}\p{N}_-]*|такси|подрядчик[\p{L}\p{N}_-]*)|(?:работа(?:ю|ем)|оказыва(?:ю|ем)|предлага(?:ю|ем)|выполня(?:ю|ем)|выезжа(?:ю|ем)|принима(?:ю|ем)\s+заказ[\p{L}\p{N}_-]*|запись\s+ко\s+мне|пишите\s+мне|звоните\s+мне))(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  if (hasSelfAuthoredOffer) {
    return false;
  }

  const hasServiceIdentity =
    /(?:^|[^\p{L}\p{N}_-])(?:электрик[\p{L}\p{N}_-]*|мастер[\p{L}\p{N}_-]*|сантехник[\p{L}\p{N}_-]*|водител[\p{L}\p{N}_-]*|такси|химчистк[\p{L}\p{N}_-]*|ремонт[\p{L}\p{N}_-]*|подрядчик[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasCompletedPersonalExperience =
    /(?:^|[^\p{L}\p{N}_-])(?:(?:делал[аи]?|сделал[аи]?|чистил[аи]?|ремонтировал[аи]?|устанавливал[аи]?|дов[её]з|возил[аи]?)(?:[\p{L}\p{N}\s.,:;()/%+-]{0,28})(?:нам|нас|мне|у\s+нас|мой|мою|нашу)|(?:нам|нас|мне|у\s+нас)(?:[\p{L}\p{N}\s.,:;()/%+-]{0,28})(?:делал[аи]?|сделал[аи]?|чистил[аи]?|ремонтировал[аи]?|устанавливал[аи]?|дов[её]з|возил[аи]?))(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasContractorDocumentReference =
    /(?:^|[^\p{L}\p{N}_-])(?:(?:в|по)\s+(?:договор[еу]|акт[еу]|протокол[еу])(?:[\p{L}\p{N}\s.,:;()/%+_[\]-]{0,180})(?:указан[аыо]?|выбран[аыо]?|подрядчик[\p{L}\p{N}_-]*|телефон|номер|диспетчер[\p{L}\p{N}_-]*)|(?:телефон|номер|стоимост[ьи]\s+услуг[иу])(?:[\p{L}\p{N}\s.,:;()/%+_[\]-]{0,80})указан[\p{L}\p{N}_-]*(?:[\p{L}\p{N}\s.,:;()/%+_[\]-]{0,100})(?:в\s+)?(?:договор[еу]|акт[еу]|протокол[еу]))(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasCompletedContractorWork =
    /(?:^|[^\p{L}\p{N}_-])(?:(?:подрядчик[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,120})(?:завершил[\p{L}\p{N}_-]*|выполнил[\p{L}\p{N}_-]*|сделал[\p{L}\p{N}_-]*|отремонтировал[\p{L}\p{N}_-]*)|(?:работ[аы]|ремонт)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,100})(?:завершен[ыао]?|завершён[ыао]?|выполнен[ыао]?|принят[ыао]?)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,120})подрядчик[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasManagingCompanyDispatcherReference =
    /(?:^|[^\p{L}\p{N}_-])управляющ[\p{L}\p{N}_-]*\s+компани[яи](?:[\p{L}\p{N}\s.,:;()/%+_-]{0,180})(?:телефон|номер|диспетчер[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,100})подрядчик[\p{L}\p{N}_-]*(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasAttributedServiceContact =
    /(?:^|[^\p{L}\p{N}_-])(?:телефон|номер)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,48})(?:подрядчик[\p{L}\p{N}_-]*|подрядн[\p{L}\p{N}_-]*\s+организаци[\p{L}\p{N}_-]*|диспетчер[\p{L}\p{N}_-]*|мастер[\p{L}\p{N}_-]*|городск[\p{L}\p{N}_-]*\s+служб[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasInformationalWorkStatus =
    /(?:^|[^\p{L}\p{N}_-])(?:(?:обсуждал[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,48})ремонт[\p{L}\p{N}_-]*|ремонт[\p{L}\p{N}_-]*(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,80})(?:запланирован[\p{L}\p{N}_-]*|ид[её]т\s+по\s+график[у]?|уже\s+заверш[её]н[\p{L}\p{N}_-]*)|(?:администраци[яи]|мчс|городск[\p{L}\p{N}_-]*\s+служб[\p{L}\p{N}_-]*|экстренн[\p{L}\p{N}_-]*\s+служб[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,120})(?:вед[еуё]т|начал[\p{L}\p{N}_-]*|приступил[\p{L}\p{N}_-]*\s+к)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,48})(?:ремонт[\p{L}\p{N}_-]*|восстановительн[\p{L}\p{N}_-]*\s+работ[\p{L}\p{N}_-]*))(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasLinkedPublicServiceContact = hasLinkedPublicServiceEditorialFrame(rawLoweredText);

  return (
    (hasServiceIdentity && hasCompletedPersonalExperience) ||
    hasContractorDocumentReference ||
    hasCompletedContractorWork ||
    hasManagingCompanyDispatcherReference ||
    hasLinkedPublicServiceContact ||
    (hasAttributedServiceContact && hasInformationalWorkStatus)
  );
}

export function isThirdPartyServiceRecommendationWithoutCurrentOffer(
  rawLoweredText: string,
  state: CommercialSignalState,
): boolean {
  if (!THIRD_PARTY_SERVICE_RECOMMENDATION_PREFILTER.test(rawLoweredText)) {
    return false;
  }
  if (!isThirdPartyServiceRecommendation(rawLoweredText)) {
    return false;
  }
  if (
    state.hasPropertyAgentContext ||
    state.hasCommercialPropertyContext ||
    state.hasRecruitmentContext ||
    state.hasBuyoutContext ||
    state.hasInfoProductContext ||
    state.hasGoodsRetailContext ||
    state.hasChannelPlacementContext ||
    state.hasGroupPromoContext
  ) {
    return false;
  }

  const hasCurrentBookingOffer = ADS_CURRENT_SERVICE_BOOKING_OFFER_PATTERN.test(rawLoweredText);
  const hasPresentThirdPartyOffer =
    /(?:^|[^\p{L}\p{N}_-])(?:(?:теперь|сейчас)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,48})(?:выполня(?:ет|ют)|оказыва(?:ет|ют)|выезжа(?:ет|ют)|работа(?:ет|ют))|(?:бер[её]тся|оказыва(?:ет|ют)|выполня(?:ет|ют)|занима(?:ется|ются)))(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,100})(?:работ[уы]|услуг[иу]|ремонт[\p{L}\p{N}_-]*|монтаж[\p{L}\p{N}_-]*|химчистк[\p{L}\p{N}_-]*|перевозк[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasCurrentAvailabilityOffer =
    /(?:^|[^\p{L}\p{N}_-])(?:(?:теперь|сейчас)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,24}))?(?:свобод[её]н|свободна|свободны|есть\s+свободн[\p{L}\p{N}_-]*\s+(?:окн[ао]|мест[ао]))(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasStructuredCurrentServiceCatalog = rawLoweredText
    .split(/[\n.!?;]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some(
      (clause) =>
        /(?:^|[^\p{L}\p{N}_-])(?:ремонт[\p{L}\p{N}_-]*(?:[\p{L}\p{N}\s,:()/%+_-]{0,48})квартир[\p{L}\p{N}_-]*(?:[\p{L}\p{N}\s,:()/%+_-]{0,32})под\s+ключ|ремонтн[\p{L}\p{N}_-]*\s+услуг[иу]|строительн[\p{L}\p{N}_-]*\s+услуг[иу])(?=$|[^\p{L}\p{N}_-])/iu.test(
          clause,
        ) &&
        /(?:^|[^\p{L}\p{N}_-])(?:цен[аы]|стоимост[ьи]|от\s+\d{2,}|выезд|замер[\p{L}\p{N}_-]*\s+бесплатн[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
          clause,
        ) &&
        !/(?:^|[^\p{L}\p{N}_-])(?:сделал[аи]?|делал[аи]?|выполнил[аи]?|ремонтировал[аи]?)(?:[\p{L}\p{N}\s,:()/%+_-]{0,32})(?:нам|мне|у\s+нас)(?=$|[^\p{L}\p{N}_-])/iu.test(
          clause,
        ),
    );

  const hasCurrentOfferDealEvidence =
    state.hasContact ||
    state.hasDealChannel ||
    state.hasPrice ||
    state.hasTransactional ||
    state.hasCallToActionContext;

  return !(
    (hasCurrentBookingOffer ||
      hasPresentThirdPartyOffer ||
      hasCurrentAvailabilityOffer ||
      hasStructuredCurrentServiceCatalog) &&
    hasCurrentOfferDealEvidence
  );
}

function isAnimalRescueContext(rawLoweredText: string): boolean {
  const hasRescueMarker =
    /(?:^|[^\p{L}\p{N}_-])(?:приют[\p{L}\p{N}_-]*|волонт[её]р[\p{L}\p{N}_-]*|бездомн[\p{L}\p{N}_-]*|спас(?:ли|лися|ён|ен)[\p{L}\p{N}_-]*|отда[её]м\s+бесплатн[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasSaleMarker =
    /(?:^|[^\p{L}\p{N}_-])(?:прода(?:м|ю|ем|ются|[её]тся)|продажа|в\s+продаже|предлага[\p{L}\p{N}_-]*|бронь|цен[аы]|рассрочк[\p{L}\p{N}_-]*|породист[\p{L}\p{N}_-]*(?:[\p{L}\p{N}\s.,:;()/%+-]{0,80})ркф)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );

  return hasRescueMarker && !hasSaleMarker;
}

function isProfessionalCurrencyExchangeOffer(rawLoweredText: string): boolean {
  return ADS_SERVICE_SPECIALTY_PATTERNS.some(
    ({ label, pattern }) => label === 'currency-exchange-service' && pattern.test(rawLoweredText),
  );
}

function isStructuredRetailPlaceholderContact(rawLoweredText: string): boolean {
  const placeholderCount = rawLoweredText.match(/\[phone\]/giu)?.length ?? 0;
  if (placeholderCount < 2) {
    return false;
  }

  return (
    /(?:^|[^\p{L}\p{N}_-])в\s+наличи[ие](?=$|[^\p{L}\p{N}_-])/iu.test(rawLoweredText) &&
    /(?:^|[^\p{L}\p{N}_-])доставк[\p{L}\p{N}_-]*(?=$|[^\p{L}\p{N}_-])/iu.test(rawLoweredText) &&
    /\[phone\](?:\s+[\p{L}][\p{L}-]{1,32})?[.!?\s]*$/iu.test(rawLoweredText)
  );
}

function isPrivatePetAccessoryListing(rawLoweredText: string): boolean {
  return ADS_PRIVATE_GOODS_PATTERNS.some(
    ({ label, pattern }) =>
      (label === 'private-pet-accessory' || label === 'private-pet-apparel') &&
      pattern.test(rawLoweredText),
  );
}

function isPrivateGoodsCommercialSpaceNoise(
  rawLoweredText: string,
  hasPrivateGoodsPatternContext: boolean,
): boolean {
  if (!hasPrivateGoodsPatternContext) {
    return false;
  }

  const hasExplicitCommercialPropertyAnchor =
    /(?:^|[^\p{L}\p{N}_-])(?:(?:коммерческ[\p{L}\p{N}_-]*|нежил[\p{L}\p{N}_-]*|офисн[\p{L}\p{N}_-]*|складск[\p{L}\p{N}_-]*|производственн[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,48})(?:помещени[\p{L}\p{N}_-]*|недвижим[\p{L}\p{N}_-]*|площад[\p{L}\p{N}_-]*|здани[\p{L}\p{N}_-]*|офис[\p{L}\p{N}_-]*|склад(?:а|у|ом|е|ы|ов|ам|ами|ах)?|павильон[\p{L}\p{N}_-]*|цех[\p{L}\p{N}_-]*|кабинет[\p{L}\p{N}_-]*)|(?:продажа|аренда|сдам|сдаю|сда[её]тся)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,72})(?:помещени[\p{L}\p{N}_-]*|недвижим[\p{L}\p{N}_-]*|павильон[\p{L}\p{N}_-]*|цех[\p{L}\p{N}_-]*|кабинет[\p{L}\p{N}_-]*|торгов[\p{L}\p{N}_-]*\s+площад[\p{L}\p{N}_-]*))(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );

  return !hasExplicitCommercialPropertyAnchor;
}

function isSalaryCardVacancyContext(rawLoweredText: string): boolean {
  if (!rawLoweredText.includes('карт')) {
    return false;
  }

  const hasVacancyContext =
    /(?:^|[^\p{L}\p{N}_-])(?:ваканси[\p{L}\p{N}_-]*|вахт[\p{L}\p{N}_-]*|работ[ауы][\p{L}\p{N}_-]*|склад[\p{L}\p{N}_-]*|смен[аы][\p{L}\p{N}_-]*|обязанност[\p{L}\p{N}_-]*|график)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasSalaryCardPayment =
    /(?:^|[^\p{L}\p{N}_-])(?:зарплат[\p{L}\p{N}_-]*|зп|выплат[\p{L}\p{N}_-]*|расч[её]т)(?:[\p{L}\p{N}\s.,:;()/%+-]{0,80})(?:на|по)(?:[\p{L}\p{N}\s.,:;()/%+-]{0,24})карт[\p{L}\p{N}_-]*(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasExplicitCardAcquisition =
    /(?:^|[^\p{L}\p{N}_-])(?:бонус\s+за\s+оформлени[\p{L}\p{N}_-]*|дарим(?:[\p{L}\p{N}\s.,:;()/%+-]{0,60})карт[\p{L}\p{N}_-]*|оформ(?:ить|лени[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;()/%+-]{0,40})банковск[\p{L}\p{N}_-]*\s+карт[\p{L}\p{N}_-]*|(?:закаж[\p{L}\p{N}_-]*|получи[\p{L}\p{N}_-]*|активиру[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;()/%+-]{0,48})карт[\p{L}\p{N}_-]*|карт[\p{L}\p{N}_-]*(?:[\p{L}\p{N}\s.,:;()/%+[\]-]{0,80})(?:закаж[\p{L}\p{N}_-]*|получи[\p{L}\p{N}_-]*|активиру[\p{L}\p{N}_-]*|ссылк[\p{L}\p{N}_-]*|\[url\]))(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasExternalLeadgenLink =
    /(?:https?:\/\/|\[url\]|(?:^|[^\p{L}\p{N}_@-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:ru|рф|com|net|org|su|site|online)(?:\/[^\s]*)?)/iu.test(
      rawLoweredText,
    );
  const hasBankReferralReward =
    hasExternalLeadgenLink &&
    /(?:^|[^\p{L}\p{N}_-])(?:(?:банк(?![\p{L}\p{N}_-])|альфа[\s-]*банк|банковск[\p{L}\p{N}_-]*\s+карт[\p{L}\p{N}_-]*|карт[ауы][\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;()/%+₽$€-]{0,100})(?:платит|выплат[ауы][\p{L}\p{N}_-]*|бонус)(?:[\p{L}\p{N}\s.,:;()/%+₽$€-]{0,80})(?:при\s+оформлени[\p{L}\p{N}_-]*|оформлени[\p{L}\p{N}_-]*\s+онлайн|ссылк[\p{L}\p{N}_-]*)|(?:карт[ауы][\p{L}\p{N}_-]*|банк(?![\p{L}\p{N}_-])|альфа[\s-]*банк)(?:[\p{L}\p{N}\s.,:;()/%+₽$€-]{0,100})(?:при\s+оформлени[\p{L}\p{N}_-]*|оформлени[\p{L}\p{N}_-]*\s+онлайн)(?:[\p{L}\p{N}\s.,:;()/%+₽$€-]{0,80})(?:платит|выплат[ауы][\p{L}\p{N}_-]*|бонус))(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasCardLeadgenOffer = hasExplicitCardAcquisition || hasBankReferralReward;

  return hasVacancyContext && hasSalaryCardPayment && !hasCardLeadgenOffer;
}

function splitHighRiskOfferClauses(rawLoweredText: string): string[] {
  return rawLoweredText
    .slice(0, 8_000)
    .split(/[\n.!?;]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .slice(0, 64);
}

function isFraudWarningClause(text: string): boolean {
  return /(?:^|[^\p{L}\p{N}_-])(?:осторожно|мошенник[а-яё-]*|предупреждени[а-яё-]*|не\s+(?:переходите|запускайте|платите|соглашайтесь|верьте)|сообщите\s+(?:администратор[а-яё-]*|в\s+полици[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu.test(
    text,
  );
}

function buildLocalOfferWindows(
  rawLoweredText: string,
  maxClauses: number,
  maxCharacters: number,
): string[] {
  const clauses = splitHighRiskOfferClauses(rawLoweredText);
  const windows: string[] = [];

  for (let start = 0; start < clauses.length; start += 1) {
    let window = '';
    for (let offset = 0; offset < maxClauses && start + offset < clauses.length; offset += 1) {
      const next = clauses[start + offset];
      if (window.length + next.length + 1 > maxCharacters) {
        break;
      }
      window = window === '' ? next : `${window} ${next}`;
      windows.push(window);
    }
  }

  return windows;
}

function hasExplicitIllicitDocumentServiceContext(rawLoweredText: string): boolean {
  if (
    isLicensedEducationProgramContext(rawLoweredText) ||
    isCredentialCoverServiceContext(rawLoweredText) ||
    isOfficialCredentialDuplicateContext(rawLoweredText)
  ) {
    return false;
  }

  if (hasProfessionalCredentialSolicitation(rawLoweredText)) {
    return true;
  }
  if (hasSuspiciousFormalDocumentCatalog(rawLoweredText)) {
    return true;
  }

  const credentialPattern =
    /(?:^|[^\p{L}\p{N}_-])(?:диплом(?:а|ы|ов|у|ом|е)?|аттестат[\p{L}\p{N}_-]*|удостоверени[ея][\p{L}\p{N}_-]*|водительск[\p{L}\p{N}_-]*\s+прав(?:а|ы)?|медицинск[\p{L}\p{N}_-]*\s+справк[аеиуы][\p{L}\p{N}_-]*|медкнижк[аеиуы][\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;

  return buildLocalOfferWindows(rawLoweredText, 5, 2_200).some((offerWindow) => {
    if (!credentialPattern.test(offerWindow)) {
      return false;
    }

    const hasCredentialSaleOrOrder =
      /(?:^|[^\p{L}\p{N}_-])(?:прода(?:м|ю|ем|[её]тся)|купить|заказать|закаж[её]м|изготов(?:им|лю|ить)|сдела(?:ем|ть)|оформ(?:им|ить))(?:[\p{L}\p{N}\s,:()/%+_-]{0,100})(?:диплом(?:а|ы|ов|у|ом|е)?|аттестат[\p{L}\p{N}_-]*|удостоверени[ея][\p{L}\p{N}_-]*|водительск[\p{L}\p{N}_-]*\s+прав(?:а|ы)?|медицинск[\p{L}\p{N}_-]*\s+справк[аеиуы][\p{L}\p{N}_-]*|медкнижк[аеиуы][\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
        offerWindow,
      );
    const hasBypassOrRegistryAnchor = hasNonNegatedIllicitCredentialAnchor(offerWindow);
    const hasCredentialFirstOfferMechanic =
      /(?:^|[^\p{L}\p{N}_-])(?:диплом(?:а|ы|ов|у|ом|е)?|аттестат[\p{L}\p{N}_-]*|удостоверени[ея][\p{L}\p{N}_-]*|водительск[\p{L}\p{N}_-]*\s+прав(?:а|ы)?|медицинск[\p{L}\p{N}_-]*\s+справк[аеиуы][\p{L}\p{N}_-]*|медкнижк[аеиуы][\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,260})(?:заказать|купить|оформ(?:ить|им)|изготов(?:ить|им)|сдела(?:ть|ем))(?=$|[^\p{L}\p{N}_-])/iu.test(
        offerWindow,
      );
    const hasOfferMechanic =
      /(?:^|[^\p{L}\p{N}_-])(?:оформлени[ея][\p{L}\p{N}_-]*|оперативн[\p{L}\p{N}_-]*|конфиденциальн[\p{L}\p{N}_-]*|гаранти[яи][\p{L}\p{N}_-]*|готов[ыа][\p{L}\p{N}_-]*\s+документ[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
        offerWindow,
      );
    const hasResponseChannel =
      /\[phone\]|\[url\]|https?:\/\/|(?:^|[^\p{L}\p{N}_-])(?:пишите?|напишите?|звон[\p{L}\p{N}_-]*|тел\.?|телефон[а-яё-]*|whatsapp|ватсап|telegram|телеграм|личк[а-яё-]*|лс)(?=$|[^\p{L}\p{N}_-])/iu.test(
        offerWindow,
      );

    return (
      (hasCredentialSaleOrOrder && (hasBypassOrRegistryAnchor || hasResponseChannel)) ||
      (hasBypassOrRegistryAnchor &&
        (hasOfferMechanic || hasCredentialFirstOfferMechanic) &&
        hasResponseChannel)
    );
  });
}

function hasNonNegatedIllicitCredentialAnchor(offerWindow: string): boolean {
  const illicitAnchorPattern =
    /(?:^|[^\p{L}\p{N}_-])(?:без\s+(?:обучени[яе][\p{L}\p{N}_-]*|экзамен[а-яё-]*|автошкол[ыи][\p{L}\p{N}_-]*)|внес[её]н[\p{L}\p{N}_-]*\s+в\s+(?:официальн[\p{L}\p{N}_-]*\s+)?(?:реестр|баз[ауые][\p{L}\p{N}_-]*)|внес[её]м\s+в\s+(?:реестр|баз[ауые][\p{L}\p{N}_-]*)|государственн[\p{L}\p{N}_-]*\s+образц[аы][\p{L}\p{N}_-]*|поддельн[\p{L}\p{N}_-]*|фальшив[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;
  const hasDenial =
    /(?:^|[^\p{L}\p{N}_-])(?:не\s+(?:выда[а-яё-]*|оформля[а-яё-]*|дела[а-яё-]*|изготавлива[а-яё-]*|прода[а-яё-]*|получа[а-яё-]*)|не\s+может\s+быть\s+(?:выдан[а-яё-]*|оформлен[а-яё-]*)|невозможно|нельзя)(?=$|[^\p{L}\p{N}_-])/iu;

  return offerWindow
    .split(/(?:[\n.!?;]+|,\s*(?:но|однако|зато)\s+)/iu)
    .some((assertion) => illicitAnchorPattern.test(assertion) && !hasDenial.test(assertion));
}

function hasProfessionalCredentialSolicitation(rawLoweredText: string): boolean {
  const hasManufacturingRequest =
    /(?:^|[^\p{L}\p{N}_-])(?:сдела(?:ть|ем|ю)|изготов(?:ить|им|лю)|оформ(?:ить|им))(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,60})корочк[а-яё-]*(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,60})(?:маляр[а-яё-]*|сварщик[а-яё-]*|электрик[а-яё-]*|стропальщик[а-яё-]*|крановщик[а-яё-]*|монтажник[а-яё-]*|изолировщик[а-яё-]*|машинист[а-яё-]*|тракторист[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasResponseChannel =
    /(?:^|[^\p{L}\p{N}_-])(?:напишите?|пишите?|личк[а-яё-]*|лс|звон[а-яё-]*|whatsapp|ватсап|telegram|телеграм|тел\.?|телефон)(?=$|[^\p{L}\p{N}_-])|\[phone\]|\[url\]|https?:\/\//iu.test(
      rawLoweredText,
    );

  return hasManufacturingRequest && hasResponseChannel;
}

function hasSuspiciousFormalDocumentCatalog(rawLoweredText: string): boolean {
  const hasContact =
    /\[phone\]|\[url\]|https?:\/\/|(?:^|[^\p{L}\p{N}_-])(?:whatsapp|ватсап|telegram|телеграм|max|мах|тел\.?|телефон|пишите?|звон[а-яё-]*|прямо[йя]|примой)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  if (!hasContact) {
    return false;
  }

  const formalDocumentPatterns = [
    /(?:^|[^\p{L}\p{N}_-])инн(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])снилс(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])мед\s*книжк[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])диплом[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])аттестат[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])удостоверени[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])сертификат[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])прав[аы](?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])патент[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])миграционн[а-яё-]*\s+карт[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])трудов[а-яё-]*\s+договор[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu,
  ];
  const distinctDocumentCount = formalDocumentPatterns.filter((pattern) =>
    pattern.test(rawLoweredText),
  ).length;
  const hasCredentialCover = /(?:^|[^\p{L}\p{N}_-])корочк[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu.test(
    rawLoweredText,
  );
  const hasSuspiciousAuthenticityOrServiceMarker =
    /(?:^|[^\p{L}\p{N}_-])(?:оригинал|оргинал|базов[а-яё-]*|базав[а-яё-]*|тоза|гаранти[а-яё-]*|кафолат[а-яё-]*|хизмат[а-яё-]*|реестр[а-яё-]*|депорт[а-яё-]*\s+текшир[а-яё-]*|олиб\s+берамиз)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );

  return (
    (hasCredentialCover && distinctDocumentCount >= 2) ||
    (distinctDocumentCount >= 3 && hasSuspiciousAuthenticityOrServiceMarker)
  );
}

function hasIllicitMigrationRegistrationOffer(rawLoweredText: string): boolean {
  const hasRegistration =
    /(?:^|[^\p{L}\p{N}_-])(?:регистрац[а-яё-]*|регистратси[яа])(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasPlacementOrDuration =
    /(?:^|[^\p{L}\p{N}_-])(?:куямиз|қўямиз|qo['’]?yamiz|(?:3|6|9)\s*ой)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasIllicitTrustMarker =
    /(?:^|[^\p{L}\p{N}_-])(?:прямо[йя]|примой|хозя(?:ин|йка)|тоза\s+баз[а-яё-]*|оргинал|оригинал|гаранти[а-яё-]*|кафолат)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasContact =
    /\[phone\]|\[url\]|https?:\/\/|(?:^|[^\p{L}\p{N}_-])(?:whatsapp|ватсап|telegram|телеграм|max|мах|тел\.?|телефон|пишите?|звон[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );

  return hasRegistration && hasPlacementOrDuration && hasIllicitTrustMarker && hasContact;
}

function hasPaidReviewCompensationOffer(rawLoweredText: string): boolean {
  return buildLocalOfferWindows(rawLoweredText, 4, 1_200).some((offerWindow) => {
    const isWarningOrDiscussion =
      isFraudWarningClause(offerWindow) ||
      /(?:^|[^\p{L}\p{N}_-])(?:без\s+оплат[ыа]|оплат[ыа]\s+за\s+отзыв\s+нет|отзыв\s+не\s+оплачива[а-яё-]*|сообщил[а-яё-]*\s+о\s+схеме)(?=$|[^\p{L}\p{N}_-])/iu.test(
        offerWindow,
      );
    if (isWarningOrDiscussion) {
      return false;
    }

    const hasEmploymentDutyContext =
      /(?:^|[^\p{L}\p{N}_-])(?:оплат[а-яё-]*\s+труд[а-яё-]*|оклад|зарплат[а-яё-]*|должностн[а-яё-]*\s+обязанност[а-яё-]*|работ[а-яё-]*\s+с\s+отзыв[а-яё-]*\s+клиент[а-яё-]*|отвеча[а-яё-]*\s+на\s+(?:отзыв[а-яё-]*|комментари[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu.test(
        offerWindow,
      );
    if (hasEmploymentDutyContext) {
      return false;
    }

    const paidActionPattern =
      /(?:отзыв[а-яё-]*|голос[а-яё-]*|реакци[а-яё-]*|комментари[а-яё-]*|лайк[а-яё-]*)/iu;
    const hasMarketplaceReviewTask =
      /(?:^|[^\p{L}\p{N}_-])(?:озон|ozon|wildberries|wb|вб|вайлдберриз|яндекс\s*маркет|сбермегамаркет|али|aliexpress|авито)(?:[\p{L}\p{N}\s,:()/%+_—–-]{0,180})(?:модератор[а-яё-]*\s+отзыв[а-яё-]*|задани[а-яё-]*(?:[\p{L}\p{N}\s,:()/%+_—–-]{0,60})отзыв[а-яё-]*|отзыв[а-яё-]*(?:[\p{L}\p{N}\s,:()/%+_—–-]{0,60})задани[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
        offerWindow,
      );
    const hasGuaranteedPaymentAfterReviewTask =
      /(?:^|[^\p{L}\p{N}_-])отзыв[а-яё-]*(?:[\p{L}\p{N}\s.,:;!?()/%+_₽$€—–-]{0,100})гарантированн[а-яё-]*\s+оплат[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu.test(
        offerWindow,
      );
    const hasExplicitTaskPaymentRelation =
      /(?:^|[^\p{L}\p{N}_-])(?:(?:платим|оплатим|плачу|вознаграждени[а-яё-]*)(?:[\p{L}\p{N}\s,:()/%+_₽$€—–-]{0,100})(?:за|на)\s*(?:честн[а-яё-]*\s+)?(?:отзыв[а-яё-]*|голос[а-яё-]*|реакци[а-яё-]*|комментари[а-яё-]*|лайк[а-яё-]*)|оплат[а-яё-]*\s+за\s+(?:отзыв[а-яё-]*|голос[а-яё-]*|реакци[а-яё-]*|комментари[а-яё-]*|лайк[а-яё-]*)|(?:отзыв[а-яё-]*|голос[а-яё-]*|реакци[а-яё-]*|комментари[а-яё-]*|лайк[а-яё-]*)(?:[\p{L}\p{N}\s,:()/%+_₽$€—–-]{0,80})(?:оплат[а-яё-]*\s+(?:сразу|после\s+задани[а-яё-]*|за\s+(?:отзыв|голос|реакци[а-яё-]*))|вознаграждени[а-яё-]*|платим))(?=$|[^\p{L}\p{N}_-])/iu.test(
        offerWindow,
      ) ||
      hasGuaranteedPaymentAfterReviewTask ||
      (hasMarketplaceReviewTask &&
        /(?:^|[^\p{L}\p{N}_-])(?:оплат[а-яё-]*|платим|вознаграждени[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
          offerWindow,
        ));
    const hasCompensation =
      /\d{2,6}\s*(?:₽|руб[а-яё-]*|р\.?)|(?:отзыв[а-яё-]*|отзыва)\s+\d{2,6}(?=$|[^\d])/iu.test(
        offerWindow,
      ) ||
      /\d{1,3}\s*[-–—]\s*\d{1,3}\s+отзыв[а-яё-]*(?:[\p{L}\p{N}\s,:()/%+_-]{0,40})\d{2,6}(?=$|[^\d])/iu.test(
        offerWindow,
      ) ||
      (paidActionPattern.test(offerWindow) &&
        /(?:^|[^\p{L}\p{N}_-])оплат[а-яё-]*(?:[\p{L}\p{N}\s,:()/%+_-]{0,50})(?:сразу|после\s+задани[а-яё-]*|за\s+(?:отзыв|голос|реакци[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu.test(
          offerWindow,
        ));
    const hasResponseChannel =
      /\[phone\]|\[url\]|https?:\/\/|(?:^|[^\p{L}\p{N}_-])(?:пишите?|напишите?|личк[а-яё-]*|чат[а-яё-]*|ставьте?\s+плюс|пишите?\s*\+)(?=$|[^\p{L}\p{N}_-])/iu.test(
        offerWindow,
      );

    return hasExplicitTaskPaymentRelation && hasCompensation && hasResponseChannel;
  });
}

function hasBotIncomeScamOffer(rawLoweredText: string): boolean {
  return buildLocalOfferWindows(rawLoweredText, 3, 650).some((offerWindow) => {
    const isWarningOrOperationalInstruction =
      isFraudWarningClause(offerWindow) ||
      /(?:^|[^\p{L}\p{N}_-])(?:служебн[а-яё-]*\s+бот|перед\s+смен[а-яё-]*|коммунальн[а-яё-]*\s+услуг[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
        offerWindow,
      );
    if (isWarningOrOperationalInstruction) {
      return false;
    }

    const launchMatch =
      /(?:^|[^\p{L}\p{N}_-])(?:запускай|запусти|активируй)(?:[\p{L}\p{N}\s,:()/%+_-]{0,40}?)бот[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu.exec(
        offerWindow,
      );
    if (!launchMatch || launchMatch.index === undefined) {
      return false;
    }

    const afterLaunch = offerWindow.slice(launchMatch.index + launchMatch[0].length);
    const incomeMatch =
      /(?:^|[^\p{L}\p{N}_-])(?:жив[а-яё-]*\s+деньг[а-яё-]*|заработ[а-яё-]*|(?:получи[а-яё-]*|получай|тебе|вам|ваш|твой|ежедневн[а-яё-]*)\s+доход|доход(?:[\p{L}\p{N}\s,:()/%+_-]{0,40})(?:ежедневн[а-яё-]*|сразу|без\s+вложени[а-яё-]*|до\s+\d{2,}))(?=$|[^\p{L}\p{N}_-])/iu.exec(
        afterLaunch,
      );
    if (!incomeMatch || incomeMatch.index === undefined) {
      return false;
    }

    const afterIncome = afterLaunch.slice(incomeMatch.index + incomeMatch[0].length);
    return /\[url\]|https?:\/\/|(?:^|[^\p{L}\p{N}_-])(?:переход[а-яё-]*|пишите?|личк[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      afterIncome,
    );
  });
}

function hasUnregulatedMedicinalGoodsOffer(rawLoweredText: string): boolean {
  const riskyCatalogPatterns: readonly RegExp[] = [
    /бобров[а-яё-]*\s+стру[яи]/iu,
    /пантокрин/iu,
    /пантогематоген/iu,
    /пант[ыа][а-яё-]*(?:\s+сух[а-яё-]*|\s+в\s+капсул[а-яё-]*)/iu,
    /кров[ьи]\s+марал[а-яё-]*/iu,
  ];
  const clauses = splitHighRiskOfferClauses(rawLoweredText);

  return clauses.some((productClause, productIndex) => {
    const hasSaleIntent =
      /(?:^|[^\p{L}\p{N}_-])(?:продам|прода(?:ю|ем)|в\s+продаже|заказ[а-яё-]*\s+в\s+личк[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
        productClause,
      );
    if (!hasSaleIntent) {
      return false;
    }

    const hasRiskyCatalog =
      riskyCatalogPatterns.filter((pattern) => pattern.test(productClause)).length >= 2;
    const hasPlantTincture =
      /(?:^|[^\p{L}\p{N}_-])настойк[а-яё-]*(?:[\p{L}\p{N}\s,:()/%+_-]{0,80})(?:лопух[а-яё-]*|болиголов[а-яё-]*|аконит[а-яё-]*|чистотел[а-яё-]*|мухомор[а-яё-]*|зверобо[йя][а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
        productClause,
      );
    const hasStructuredPlantTincture =
      hasPlantTincture &&
      /(?:^|[^\d])\d{2,3}\s*%(?=$|[^\d])/u.test(productClause) &&
      /(?:^|[^\d])\d+(?:[.,]\d+)?\s*(?:мл|л)(?=$|[^\p{L}\p{N}_-])/iu.test(productClause) &&
      /(?:^|[^\d])\d{2,6}\s*(?:₽|руб[а-яё-]*|р\.)(?=$|[^\p{L}\p{N}_-])/iu.test(productClause);
    if (!hasRiskyCatalog && !hasStructuredPlantTincture) {
      return false;
    }

    const offerSpan = clauses
      .slice(productIndex, productIndex + 4)
      .join(' ')
      .slice(0, 2_400);
    const hasContactOrShipping =
      /\[phone\]|\[url\]|https?:\/\/|(?:^|[^\p{L}\p{N}_-])(?:тел\.?|телефон|личк[а-яё-]*|whatsapp|ватсап|telegram|телеграм|доставк[а-яё-]*|отправ[а-яё-]*|почт[а-яё-]*|сдэк)(?=$|[^\p{L}\p{N}_-])/iu.test(
        offerSpan,
      );
    const isRecipeOrRegisteredPharmacyContext =
      /(?:^|[^\p{L}\p{N}_-])(?:рецепт\s+настойк[а-яё-]*|как\s+приготовить|ингредиент[а-яё-]*|зарегистрированн[а-яё-]*\s+(?:лекарственн[а-яё-]*\s+)?препарат|аптечн[а-яё-]*\s+препарат)(?=$|[^\p{L}\p{N}_-])/iu.test(
        offerSpan,
      );

    return hasContactOrShipping && !isRecipeOrRegisteredPharmacyContext;
  });
}

function hasWildlifeProductSaleOffer(rawLoweredText: string): boolean {
  const clauses = splitHighRiskOfferClauses(rawLoweredText);

  return clauses.some((productClause, productIndex) => {
    const hasSaleIntent =
      /(?:^|[^\p{L}\p{N}_-])(?:продам|прода(?:ю|ем)|в\s+продаже|заказ[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
        productClause,
      );
    const hasRegulatedItem =
      /(?:^|[^\p{L}\p{N}_-])(?:шкур[а-яё-]*\s+медвед[а-яё-]*|медвеж[а-яё-]*\s+шкур[а-яё-]*|желч[ьи]\s+медвед[а-яё-]*|лап[а-яё-]*\s+медвед[а-яё-]*|рог[а-яё-]*\s+марал[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
        productClause,
      );
    if (!hasSaleIntent || !hasRegulatedItem) {
      return false;
    }

    const offerSpan = clauses
      .slice(productIndex, productIndex + 3)
      .join(' ')
      .slice(0, 1_800);
    const hasDealChannel =
      /\[phone\]|\[url\]|https?:\/\/|(?:^|[^\p{L}\p{N}_-])(?:тел\.?|телефон|звон[а-яё-]*|пишите?|доставк[а-яё-]*|отправ[а-яё-]*)(?=$|[^\p{L}\p{N}_-])|\d{2,7}\s*(?:₽|руб[а-яё-]*|р\.?)/iu.test(
        offerSpan,
      );
    const hasSyntheticMarker =
      /(?:^|[^\p{L}\p{N}_-])(?:искусственн[а-яё-]*|эко[\s-]*шкур[а-яё-]*|имитаци[яи])(?=$|[^\p{L}\p{N}_-])/iu.test(
        productClause,
      );
    const hasNaturalOverride =
      /(?:^|[^\p{L}\p{N}_-])(?:натуральн[а-яё-]*|настоящ[а-яё-]*|подлинн[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
        productClause,
      );
    const isEditorialOrMuseumContext =
      /(?:^|[^\p{L}\p{N}_-])(?:музе[йя][а-яё-]*|экспозици[яи]|выставочн[а-яё-]*\s+экспонат|конфискова[а-яё-]*|изъял[а-яё-]*|новост[ьи]|сообщил[а-яё-]*\s+о\s+продаж[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
        offerSpan,
      );

    return (
      hasDealChannel && (!hasSyntheticMarker || hasNaturalOverride) && !isEditorialOrMuseumContext
    );
  });
}

function hasOrganizedWellnessTripOffer(rawLoweredText: string): boolean {
  const boundedText = rawLoweredText.slice(0, 2_400);
  const groupMatch =
    /(?:^|[^\p{L}\p{N}_-])собира(?:ем|ется)\s+групп[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu.exec(
      boundedText,
    );
  if (!groupMatch || groupMatch.index === undefined) {
    return false;
  }

  const offerSpan = boundedText.slice(groupMatch.index).replace(/\s+/gu, ' ');
  const hasWellnessDestination =
    /(?:^|[^\p{L}\p{N}_-])(?:оздоровлен[а-яё-]*|термальн[а-яё-]*|грязев[а-яё-]*\s+источник[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      offerSpan.slice(0, 500),
    );
  const hasHostedLogistics =
    /(?:^|[^\p{L}\p{N}_-])(?:встреча[а-яё-]*|размеща[а-яё-]*|сопровожда[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      offerSpan.slice(0, 1_000),
    );
  const hasTravelDeal =
    /(?:^|[^\p{L}\p{N}_-])(?:проживан[а-яё-]*|проезд)(?=$|[^\p{L}\p{N}_-])/iu.test(offerSpan) &&
    /(?:^|[^\d])\d{3,6}\s*(?:₽|руб[а-яё-]*|р\.?|с\s+чел)(?=$|[^\p{L}\p{N}_-])/iu.test(offerSpan);
  const hasCurrentBooking =
    /(?:^|[^\p{L}\p{N}_-])(?:мест[а-яё-]*\s+ограничен[а-яё-]*|запис[а-яё-]*|возим\s+[а-яё-]+\s+раз[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      offerSpan,
    );
  const hasContact =
    /\[phone\]|(?:^|[^\p{L}\p{N}_-])(?:тел\.?|телефон|whatsapp|ватсап|telegram|телеграм|звон[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      offerSpan,
    );
  const isPastSocialOrPrivateTrip =
    /(?:^|[^\p{L}\p{N}_-])(?:в\s+прошл[а-яё-]*|отч[её]т|фотографи[а-яё-]*|с\s+друз[а-яё-]*|делим\s+бензин|бесплатн[а-яё-]*\s+социальн[а-яё-]*\s+поездк[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      offerSpan,
    );

  return (
    hasWellnessDestination &&
    hasHostedLogistics &&
    hasTravelDeal &&
    hasCurrentBooking &&
    hasContact &&
    !isPastSocialOrPrivateTrip
  );
}

function isPseudomedicalAttributionOrDebunkingContext(rawLoweredText: string): boolean {
  if (!/био\s*резонанс/iu.test(rawLoweredText)) {
    return false;
  }

  return /(?:^|[^\p{L}\p{N}_-])(?:(?:в\s+(?:реклам[еы]|объявлени[ие]|ролик[еа]|публикаци[ие])|реклам[аы])(?:[\p{L}\p{N}\s.,:;!?"'«»()/%+_—-]{0,180})(?:утвержда[\p{L}\p{N}_-]*|обеща[\p{L}\p{N}_-]*|заявля[\p{L}\p{N}_-]*|якобы)|(?:в\s+стать[еьи]|редакци[яи]|автор[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?"'«»()/%+_—-]{0,120})опроверга[\p{L}\p{N}_-]*|опроверга[\p{L}\p{N}_-]*(?:[\p{L}\p{N}\s.,:;!?"'«»()/%+_—-]{0,80})заявлени[\p{L}\p{N}_-]*|шарлатан[\p{L}\p{N}_-]*|лженаучн[\p{L}\p{N}_-]*|якобы|не\s+верьте|ввод(?:ит|ят)\s+в\s+заблуждени[ея]|не\s+доказан[\p{L}\p{N}_-]*|нет\s+доказательств|доказательств\s+нет)(?=$|[^\p{L}\p{N}_-])/iu.test(
    rawLoweredText,
  );
}

function hasNonNegatedPseudomedicalRiskClaim(rawLoweredText: string): boolean {
  const clauses = rawLoweredText
    .split(/[\n.!?;]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => /био\s*резонанс/iu.test(clause));
  const claimPatterns = [
    /заменя[\p{L}\p{N}_-]*(?:[\p{L}\p{N}\s,:()/%+-]{0,60})(?:анализ[\p{L}\p{N}_-]*|биохими[\p{L}\p{N}_-]*|мрт|кт|узи|снимк[\p{L}\p{N}_-]*)/iu,
    /избав[\p{L}\p{N}_-]*(?:[\p{L}\p{N}\s,:()/%+-]{0,60})(?:очеред[\p{L}\p{N}_-]*\s+к\s+врач[\p{L}\p{N}_-]*|сдач[\p{L}\p{N}_-]*\s+анализ[\p{L}\p{N}_-]*)/iu,
    /выяв[\p{L}\p{N}_-]*(?:[\p{L}\p{N}\s,:()/%+-]{0,80})(?:причин[\p{L}\p{N}_-]*\s+(?:аллерги[\p{L}\p{N}_-]*|бесплоди[\p{L}\p{N}_-]*|аутизм[\p{L}\p{N}_-]*)|состояни[\p{L}\p{N}_-]*\s+кажд[\p{L}\p{N}_-]*\s+орган[\p{L}\p{N}_-]*)/iu,
  ];

  return clauses.some((clause) => {
    if (isPseudomedicalAttributionOrDebunkingContext(clause)) {
      return false;
    }

    return claimPatterns.some((pattern) => {
      const match = pattern.exec(clause);
      if (!match || match.index === undefined) {
        return false;
      }

      const prefix = clause.slice(Math.max(0, match.index - 80), match.index);
      const hasLocalNegation =
        /(?:^|[^\p{L}\p{N}_-])не\s+(?!только(?:\s|$))(?:(?:может|должн[аоы]?|способн[аоы]?|помога[\p{L}\p{N}_-]*|позволя[\p{L}\p{N}_-]*)\s+)?(?:полностью\s+)?$/iu.test(
          prefix,
        ) || /(?:^|[^\p{L}\p{N}_-])нельзя(?:[\p{L}\p{N}\s,:()/%+-]{0,60})$/iu.test(prefix);
      return !hasLocalNegation;
    });
  });
}

function isLicensedEducationProgramContext(rawLoweredText: string): boolean {
  if (
    /(?:^|[^\p{L}\p{N}_-])(?:без\s+(?:обучени[\p{L}\p{N}_-]*|экзамен[\p{L}\p{N}_-]*)|(?:прода(?:м|ю|ем)|купить)(?:[\p{L}\p{N}\s.,:;()/%+-]{0,80})(?:диплом[\p{L}\p{N}_-]*|аттестат[\p{L}\p{N}_-]*)|внес[\p{L}\p{N}_-]*\s+в\s+(?:официальн[\p{L}\p{N}_-]*\s+)?(?:реестр|баз[\p{L}\p{N}_-]*))(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    )
  ) {
    return false;
  }

  const hasEducationProgram =
    /(?:^|[^\p{L}\p{N}_-])(?:обучени[\p{L}\p{N}_-]*|учебн[\p{L}\p{N}_-]*\s+центр[\p{L}\p{N}_-]*|курс[аы]?(?=$|[^\p{L}\p{N}_-])|переподготовк[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasProgramStructure =
    /(?:^|[^\p{L}\p{N}_-])(?:\d{2,4}\s+час[а-яё-]*|экзамен[\p{L}\p{N}_-]*|заняти[яй][\p{L}\p{N}_-]*|дистанционн[\p{L}\p{N}_-]*|онлайн[\s-]*обучени[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasLegitimacyMarker =
    /(?:^|[^\p{L}\p{N}_-])(?:лицензи[яи][\p{L}\p{N}_-]*|после\s+(?:онлайн[\s-]*)?обучени[\p{L}\p{N}_-]*|выдач[аеи]\s+диплом[\p{L}\p{N}_-]*\s+после)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );

  return hasEducationProgram && hasProgramStructure && hasLegitimacyMarker;
}

function collectHighRiskCommercialHitLabels(
  rawLoweredText: string,
  normalizedText: string,
  matchesPattern: (pattern: RegExp) => boolean,
  limit: number,
): string[] {
  const hits: string[] = [];
  const prefilterByLabel = new Map<string, boolean>();
  const eligibilityByLabel = new Map<string, boolean>();

  for (const { label, pattern } of ADS_HIGH_RISK_COMMERCIAL_PATTERNS) {
    if (hits.length >= limit) {
      break;
    }
    if (hits.includes(label)) {
      continue;
    }
    let canContainLabel = prefilterByLabel.get(label);
    if (canContainLabel === undefined) {
      canContainLabel = canContainHighRiskCommercialLabel(label, rawLoweredText, normalizedText);
      prefilterByLabel.set(label, canContainLabel);
    }
    if (!canContainLabel) {
      continue;
    }
    if (!matchesPattern(pattern)) {
      continue;
    }

    let eligible = eligibilityByLabel.get(label);
    if (eligible === undefined) {
      eligible = isHighRiskCommercialLabelEligible(label, rawLoweredText);
      eligibilityByLabel.set(label, eligible);
    }
    if (eligible) {
      hits.push(label);
    }
  }

  return hits;
}

function selectRecruitmentPatterns(rawLoweredText: string, normalizedText: string) {
  const canContainLeafletDailySideJob =
    includesQuickToken('подработ', rawLoweredText, normalizedText) &&
    includesQuickToken('листов', rawLoweredText, normalizedText);
  const canContainMarketplaceReviewWork =
    matchesQuickPattern(MARKETPLACE_REVIEW_WORK_PREFILTER, rawLoweredText, normalizedText) ||
    (includesQuickToken('пост', rawLoweredText, normalizedText) &&
      matchesQuickPattern(/\d{1,3}\s+человек/iu, rawLoweredText, normalizedText));

  if (canContainLeafletDailySideJob && canContainMarketplaceReviewWork) {
    return ADS_RECRUITMENT_PATTERNS;
  }
  if (canContainLeafletDailySideJob) {
    return RECRUITMENT_PATTERNS_WITHOUT_MARKETPLACE_REVIEW_WORK;
  }
  if (canContainMarketplaceReviewWork) {
    return RECRUITMENT_PATTERNS_WITHOUT_LEAFLET_DAILY_SIDE_JOB;
  }
  return RECRUITMENT_PATTERNS_WITHOUT_EXPENSIVE_NARROW_FAMILIES;
}

function canContainHighRiskCommercialLabel(
  label: string,
  rawLoweredText: string,
  normalizedText: string,
): boolean {
  return (
    canContainHighRiskCommercialLabelInText(label, rawLoweredText) ||
    (normalizedText !== rawLoweredText &&
      canContainHighRiskCommercialLabelInText(label, normalizedText))
  );
}

function canContainHighRiskCommercialLabelInText(label: string, text: string): boolean {
  if (label === 'paid-review-task') {
    return PAID_REVIEW_TASK_PREFILTER.test(text);
  }
  if (label === 'paid-raffle') {
    return PAID_RAFFLE_PREFILTER.test(text);
  }
  if (label === 'paid-raffle-transfer') {
    return PAID_RAFFLE_TRANSFER_PREFILTER.test(text);
  }
  if (label === 'online-lottery-bonus') {
    return text.includes('лотере') || text.includes('выигрыш');
  }
  if (label === 'payment-card-drop-leadgen') {
    return text.includes('карт');
  }
  if (label === 'document-service') {
    return DOCUMENT_SERVICE_PREFILTER.test(text);
  }
  if (label === 'migration-registration-service') {
    return text.includes('регистрац') || text.includes('регистратси');
  }
  if (label === 'betting-gambling') {
    return BETTING_GAMBLING_PREFILTER.test(text);
  }
  if (label === 'casino-slot-promo') {
    return CASINO_SLOT_PROMO_PREFILTER.test(text);
  }
  if (label === 'paid-gambling-group') {
    return PAID_GAMBLING_GROUP_PREFILTER.test(text);
  }
  if (label === 'pseudomedical-diagnostics') {
    return /био\s*резонанс/iu.test(text);
  }

  return true;
}

function includesQuickToken(
  token: string,
  rawLoweredText: string,
  normalizedText: string,
): boolean {
  return rawLoweredText.includes(token) || normalizedText.includes(token);
}

function matchesQuickPattern(
  pattern: RegExp,
  rawLoweredText: string,
  normalizedText: string,
): boolean {
  return (
    pattern.test(rawLoweredText) ||
    (normalizedText !== rawLoweredText && pattern.test(normalizedText))
  );
}

function isHighRiskCommercialLabelEligible(label: string, rawLoweredText: string): boolean {
  if (label === 'bank-card-leadgen') {
    return !isSalaryCardVacancyContext(rawLoweredText);
  }
  if (label === 'document-service') {
    return hasExplicitIllicitDocumentServiceContext(rawLoweredText);
  }
  if (label === 'migration-registration-service') {
    return hasIllicitMigrationRegistrationOffer(rawLoweredText);
  }
  if (label === 'paid-raffle') {
    return (
      hasPaidRaffleRiskContext(rawLoweredText) || hasObfuscatedPaidRaffleRiskContext(rawLoweredText)
    );
  }
  if (label === 'paid-raffle-transfer') {
    return hasPaidRaffleTransferRiskContext(rawLoweredText);
  }
  if (label === 'paid-gambling-group') {
    return hasPaidGamblingGroupRiskContext(rawLoweredText);
  }
  if (label === 'paid-review-task') {
    return hasPaidReviewCompensationOffer(rawLoweredText);
  }
  if (label === 'bot-income-scam') {
    return hasBotIncomeScamOffer(rawLoweredText);
  }
  if (label === 'unregulated-medicinal-goods') {
    return hasUnregulatedMedicinalGoodsOffer(rawLoweredText);
  }
  if (label === 'wildlife-product-sale') {
    return hasWildlifeProductSaleOffer(rawLoweredText);
  }
  if (label === 'pseudomedical-diagnostics') {
    return hasNonNegatedPseudomedicalRiskClaim(rawLoweredText);
  }
  return true;
}

function hasPaidRaffleRiskContext(rawLoweredText: string): boolean {
  const clauses = rawLoweredText
    .split(/[\n.!?;]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);

  return clauses.some((raffleClause, raffleIndex) => {
    if (!hasRaffleContext(raffleClause)) {
      return false;
    }

    const semanticWindowClauses = clauses.slice(
      Math.max(0, raffleIndex - 3),
      Math.min(clauses.length, raffleIndex + 4),
    );
    const semanticWindow = semanticWindowClauses.join(' ');
    const hasSameClausePaidEntry = hasExplicitPaidRaffleEntry(raffleClause);
    if (hasExplicitFreeRaffleEntry(raffleClause) && !hasSameClausePaidEntry) {
      return false;
    }
    if (isJudgedCompetitionFeeContext(semanticWindow)) {
      return false;
    }
    if (hasSameClausePaidEntry && !hasDistinctPaidEventContext(raffleClause)) {
      return true;
    }

    return semanticWindowClauses.some(
      (entryClause) =>
        entryClause !== raffleClause &&
        hasExplicitPaidRaffleEntry(entryClause) &&
        !isPublicEventAdmissionPrice(entryClause) &&
        !hasDistinctPaidEventContext(entryClause),
    );
  });
}

function isJudgedCompetitionFeeContext(text: string): boolean {
  const hasJudgedCompetition =
    /(?:^|[^\p{L}\p{N}_-])(?:жюри|суд[ьи][а-яё-]*|оценк[а-яё-]*\s+(?:жюри|работ[а-яё-]*)|победител[а-яё-]*\s+выбер[а-яё-]*\s+жюри)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasOrganizationalFee =
    /(?:^|[^\p{L}\p{N}_-])(?:орг(?:анизационн[а-яё-]*)?\s*взнос|взнос\s+за\s+участи[ея])(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  return hasJudgedCompetition && hasOrganizationalFee;
}

function hasDistinctPaidEventContext(text: string): boolean {
  const hasDistinctEvent =
    /(?:^|[^\p{L}\p{N}_-])(?:мастер[\s-]*класс|курс[аы]?|обучени[\p{L}\p{N}_-]*|лекци[\p{L}\p{N}_-]*|семинар[\p{L}\p{N}_-]*|тренинг[\p{L}\p{N}_-]*|экскурси[яи][\p{L}\p{N}_-]*|фестивал[\p{L}\p{N}_-]*|концерт[\p{L}\p{N}_-]*|спектакл[\p{L}\p{N}_-]*|театр[\p{L}\p{N}_-]*|выставк[\p{L}\p{N}_-]*|музе[йя][\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasPricedTransportTicket =
    /(?:^|[^\p{L}\p{N}_-])(?:(?:билет[\p{L}\p{N}_-]*|проезд)(?:[\p{L}\p{N}\s,:()/%+_—–-]{0,40})\d[\d\s.,]{0,6}\s*(?:₽|руб(?:\.|л[\p{L}\p{N}_-]*)?|р\.)(?:[\p{L}\p{N}\s,:()/%+_—–-]{0,80})(?:автобус[\p{L}\p{N}_-]*|рейс[\p{L}\p{N}_-]*|маршрут[\p{L}\p{N}_-]*|проезд|поезд[\p{L}\p{N}_-]*)|(?:автобус[\p{L}\p{N}_-]*|рейс[\p{L}\p{N}_-]*|маршрут[\p{L}\p{N}_-]*|проезд|поезд[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s,:()/%+_—–-]{0,80})(?:билет[\p{L}\p{N}_-]*|проезд)(?:[\p{L}\p{N}\s,:()/%+_—–-]{0,40})\d[\d\s.,]{0,6}\s*(?:₽|руб(?:\.|л[\p{L}\p{N}_-]*)?|р\.))(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );

  return hasDistinctEvent || hasPricedTransportTicket;
}

function hasRaffleContext(text: string): boolean {
  const hasDirectRaffleMechanic =
    /(?:^|[^\p{L}\p{N}_-])(?:розыгрыш[\p{L}\p{N}_-]*|разыгрыва(?:ю|ем|ют)|разыгра(?:ем|ют|ть)|лотере[яи][\p{L}\p{N}_-]*|денежн[\p{L}\p{N}_-]*\s+(?:лот|групп)[\p{L}\p{N}_-]*|групп[аы]\s+розыгрыш[\p{L}\p{N}_-]*|призов[а-яё-]*\s+лот[а-яё-]*|лот\s+с\s+повтор[\p{L}\p{N}_-]*|генератор[\p{L}\p{N}_-]*|рандомус)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  if (hasDirectRaffleMechanic) {
    return true;
  }

  const hasPrizeLotMechanic =
    /(?:^|[^\p{L}\p{N}_-])(?:лот[а-яё-]*(?:[\s\S]{0,220})(?:приз[а-яё-]*|угадайк[а-яё-]*|проигрыш[а-яё-]*|выигрыш[а-яё-]*|забрать\s+приз\s+деньгами)|(?:приз[а-яё-]*|угадайк[а-яё-]*|проигрыш[а-яё-]*|выигрыш[а-яё-]*)(?:[\s\S]{0,220})лот[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  if (hasPrizeLotMechanic) {
    return true;
  }

  const hasWinnerLanguage =
    /(?:^|[^\p{L}\p{N}_-])(?:победител[\p{L}\p{N}_-]*|выигрыш[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasChanceLotMechanic =
    /(?:^|[^\p{L}\p{N}_-])(?:призов[а-яё-]*\s+лот[а-яё-]*|номер(?:ок|ка|ки|ков)(?:[\s\S]{0,80})(?:выбер[\p{L}\p{N}_-]*|случайн[\p{L}\p{N}_-]*)|проигрыш[\p{L}\p{N}_-]*|игр[аы]\s+на\s+(?:деньги|приз)|случайн[\p{L}\p{N}_-]*\s+чис[ел][\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  return hasWinnerLanguage && hasChanceLotMechanic;
}

function hasExplicitFreeRaffleEntry(text: string): boolean {
  return /(?:^|[^\p{L}\p{N}_-])(?:бесплатн[\p{L}\p{N}_-]*\s+розыгрыш[\p{L}\p{N}_-]*|розыгрыш[\p{L}\p{N}_-]*(?:[\p{L}\p{N}\s.,:;()/%+-]{0,160})(?:участи[ея]\s+бесплатн[\p{L}\p{N}_-]*|без\s+взнос[а-яё-]*|доплачивать\s+не\s+нужно)|участи[ея](?:[\p{L}\p{N}\s.,:;()/%+-]{0,32})бесплатн[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
    text,
  );
}

function hasExplicitPaidRaffleEntry(text: string): boolean {
  const hasDirectPaidEntry = [
    /(?:^|[^\p{L}\p{N}_-])(?:участи[ея](?:\s+(?:является|будет))?\s+платн[\p{L}\p{N}_-]*|платн[\p{L}\p{N}_-]*\s+участи[ея]|обязательн[\p{L}\p{N}_-]*\s+взнос|взнос\s+обязател[её]н)(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])(?:стоимост[\p{L}\p{N}_-]*|цена)\s+(?:участи[ея]|взнос[а-яё-]*|номер(?:ка|ки|ков|ок)|лот[а-яё-]*)(?:[\p{L}\p{N}\s.,:;()/%+=—–-]{0,20})\d[\d\s.,]{0,6}\s*(?:₽|руб(?:\.|л[\p{L}\p{N}_-]*)?|р\.?)(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])(?:участи[ея]|взнос[а-яё-]*|номер(?:ка|ки|ков|ок)|лот[а-яё-]*|билет[\p{L}\p{N}_-]*|вход)(?:\s+(?:стоит|по|от|за)\s+|\s*[-=:]|\s+)\d[\d\s.,]{0,6}\s*(?:₽|руб(?:\.|л[\p{L}\p{N}_-]*)?|р\.?)(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])\d[\d\s.,]{0,6}\s*(?:₽|руб(?:\.|л[\p{L}\p{N}_-]*)?|р\.?)\s*(?:за\s+)?(?:участи[ея]|взнос[а-яё-]*|номер(?:ок|ка|ки|ков)|лот[а-яё-]*|билет[\p{L}\p{N}_-]*|вход)(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])номер(?:ок|ка|ки|ков)(?:\s+не\s+дорог[а-яё-]*|\s+недорог[а-яё-]*)?\s+от\s+\d[\d\s.,]{0,6}\s*(?:₽|руб(?:\.|л[\p{L}\p{N}_-]*)?|р\.?)(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])лот[а-яё-]*\s+от\s+(?:\d(?:\uFE0F?\u20E3)?(?:[\s.,]*)?){1,7}(?:\s*(?:₽|руб(?:\.|л[\p{L}\p{N}_-]*)?|р\.?)|\s+и\s+выше)(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])лот[а-яё-]*\s+у\s+нас\s+от\s+\d[\d\s.,]{0,6}(?:\s+до\s+\d[\d\s.,]{0,6})?\s*(?:₽|руб(?:\.|л[\p{L}\p{N}_-]*)?|р\.)(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])стоимост[ьи][\p{L}\p{N}_-]*\s+номер(?:ка|ки|ков|ок)(?:[\s\S]{0,100})(?:возвраща[\p{L}\p{N}_-]*\s+на\s+баланс|проигрыш[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  ].some((pattern) => pattern.test(text));

  return hasDirectPaidEntry;
}

function hasPaidRaffleTransferRiskContext(rawLoweredText: string): boolean {
  const rareSkeleton = buildRareRaffleSkeleton(rawLoweredText);
  const raffleText = rareSkeleton ?? rawLoweredText;
  const hasLot = /(?:^|[^\p{L}\p{N}_-])лот[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu.test(raffleText);
  const hasPaymentDestination =
    /(?:^|[^\p{L}\p{N}_-])(?:перевод|т[\s-]*банк|сбер[а-яё-]*|альфа[\s-]*банк|моб[а-яё-]*\s*банк|оплат[а-яё-]*)(?:[\s\S]{0,80})(?:\[phone\]|карт[а-яё-]*|банк[а-яё-]*|номер[а-яё-]*)|\[phone\](?:[\s\S]{0,80})(?:т[\s-]*банк|сбер[а-яё-]*|банк[а-яё-]*)/iu.test(
      rawLoweredText,
    );
  const hasExplicitChanceLanguage =
    /(?:^|[^\p{L}\p{N}_-])(?:удач[а-яё-]*|победител[а-яё-]*|выигрыш[а-яё-]*|генератор[а-яё-]*|рандомус|случайн[а-яё-]*\s+чис[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasPaidRepeatLotMechanic =
    /(?:^|[^\p{L}\p{N}_-])лот[а-яё-]*\s+с\s+повтор[а-яё-]*(?:[\s\S]{0,100})(?:номер(?:ок|ка|ки|ков)|\d{2,6}\s*(?:₽|руб[а-яё-]*|р\.?))(?=$|[^\p{L}\p{N}_-])/iu.test(
      raffleText,
    );
  const payoutAmounts =
    rawLoweredText.match(/(?:\d(?:\uFE0F?\u20E3)?(?:[\s.,]*)?){2,}\s*(?:₽|руб[а-яё-]*|р\.?)/giu) ??
    [];
  const numberGrid = rawLoweredText.match(/(?:^|\s)\d{1,2}(?:[^\p{L}\p{N}]{0,4})[.)]?/gu) ?? [];
  const hasChanceMechanic =
    hasExplicitChanceLanguage ||
    hasPaidRepeatLotMechanic ||
    payoutAmounts.length >= 3 ||
    numberGrid.length >= 5;

  return hasLot && hasPaymentDestination && hasChanceMechanic;
}

function buildRareRaffleSkeleton(rawLoweredText: string): string | null {
  if (
    !/[\u{1D400}-\u{1D7FF}]/u.test(rawLoweredText) &&
    !/(?:^|[^\p{L}\p{N}_-])лот[а-яё-]*\s+c\s+повтор[а-яё-]*/iu.test(rawLoweredText)
  ) {
    return null;
  }

  return rawLoweredText
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[a]/g, 'а')
    .replace(/[b]/g, 'в')
    .replace(/[c]/g, 'с')
    .replace(/[e]/g, 'е')
    .replace(/[k]/g, 'к')
    .replace(/[m]/g, 'м')
    .replace(/[o]/g, 'о')
    .replace(/[p]/g, 'р')
    .replace(/[t]/g, 'т')
    .replace(/[x]/g, 'х');
}

function hasPaidGamblingGroupRiskContext(rawLoweredText: string): boolean {
  const rareCharacters = rawLoweredText.match(/[ᴛᥲᴦρᥰ᧐ᥴκ᧘ᥔᥙδʍʙɜᥱɯɸ]/gu) ?? [];
  if (rareCharacters.length < 12) {
    return false;
  }

  const substitutions: Readonly<Record<string, string>> = {
    ᴛ: 'т',
    ᥲ: 'а',
    ᴦ: 'г',
    ρ: 'р',
    ᥰ: 'п',
    '᧐': 'о',
    ᥴ: 'с',
    κ: 'к',
    '᧘': 'л',
    ᥔ: 'й',
    ᥙ: 'и',
    δ: 'б',
    ʍ: 'м',
    ʙ: 'в',
    ɜ: 'з',
    ᥱ: 'е',
    ɯ: 'ш',
    ɸ: 'ф',
  };
  const skeleton = [...rawLoweredText]
    .map((character) => substitutions[character] ?? character)
    .join('')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  const hasGroupAndGame = skeleton.includes('группа') && skeleton.includes('лоты');
  const hasPaidMechanic =
    /\d{2,}/u.test(skeleton) &&
    (skeleton.includes('играй') || skeleton.includes('играешь') || skeleton.includes('игроты'));
  const hasMoneyOutcome =
    skeleton.includes('деньги') ||
    skeleton.includes('выводы') ||
    skeleton.includes('колесофортуны');
  const hasResponseChannel =
    /\[url\]|https?:\/\//iu.test(rawLoweredText) ||
    skeleton.includes('заходи') ||
    skeleton.includes('ждемответ');

  return hasGroupAndGame && hasPaidMechanic && hasMoneyOutcome && hasResponseChannel;
}

function hasObfuscatedPaidRaffleRiskContext(rawLoweredText: string): boolean {
  const rareCharacters = rawLoweredText.match(/[ρμӷλαωβϲηϰτƅγɥσɞχ]/gu) ?? [];
  if (rareCharacters.length < 12) {
    return false;
  }

  const hasPricedLot =
    /(?:^|[^\p{L}\p{N}_-])лот[а-яё-]*(?:[\s\S]{0,60})(?:\d(?:\uFE0F?\u20E3)?(?:[\s.,]*)?){1,7}\s*(?:ρ|р\.?|₽|руб[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasChanceOrPrizeMechanic =
    /(?:^|[^\p{L}\p{N}_-])(?:приз[а-яё-]*|угадайк[а-яё-]*|проигрыш[а-яё-]*|забрать\s+приз\s+деньгами|бесплатн[а-яё-]*\s+лот[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasResponseChannel =
    /\[url\]|https?:\/\/|(?:^|[^\p{L}\p{N}_-])жд[её]м?\s+ваш\s+ответ(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );

  return hasPricedLot && hasChanceOrPrizeMechanic && hasResponseChannel;
}

function isPublicEventAdmissionPrice(text: string): boolean {
  const hasPublicEvent =
    /(?:^|[^\p{L}\p{N}_-])(?:фестивал[\p{L}\p{N}_-]*|концерт[\p{L}\p{N}_-]*|спектакл[\p{L}\p{N}_-]*|театр[\p{L}\p{N}_-]*|выставк[\p{L}\p{N}_-]*|музе[йя][\p{L}\p{N}_-]*|кино(?:театр[\p{L}\p{N}_-]*)?)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasTicketOrAdmissionPrice =
    /(?:^|[^\p{L}\p{N}_-])(?:билет[\p{L}\p{N}_-]*|вход)(?:\s+(?:стоит|по|от|за)\s+|\s*[-=:]|\s+)\d[\d\s.,]{0,6}\s*(?:₽|руб(?:\.|л[\p{L}\p{N}_-]*)?|р\.?)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasRaffleSpecificEntry =
    /(?:^|[^\p{L}\p{N}_-])(?:участи[ея]|взнос[а-яё-]*|номер(?:ок|ка|ки|ков)|лот[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );

  return hasPublicEvent && hasTicketOrAdmissionPrice && !hasRaffleSpecificEntry;
}

function isOfficialCredentialDuplicateContext(rawLoweredText: string): boolean {
  const hasOfficialIssuer =
    /(?:^|[^\p{L}\p{N}_-])(?:мфц|многофункциональн[\p{L}\p{N}_-]*\s+центр[\p{L}\p{N}_-]*|государственн[\p{L}\p{N}_-]*\s+архив[\p{L}\p{N}_-]*|городск[\p{L}\p{N}_-]*\s+архив[\p{L}\p{N}_-]*|архив[еа](?:\s+(?:школ[ыи]|вуз[а-яё-]*|колледж[а-яё-]*|техникум[а-яё-]*))?)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasDuplicateCredentialRequest =
    /(?:^|[^\p{L}\p{N}_-])(?:(?:заказать|получить|выдать|выдач[аеиуы]|оформить|восстановить)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,80})?(?:дубликат[\p{L}\p{N}_-]*|архивн[\p{L}\p{N}_-]*\s+копи[яи])(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,80})?(?:диплом[\p{L}\p{N}_-]*|аттестат[\p{L}\p{N}_-]*|удостоверени[\p{L}\p{N}_-]*)|(?:дубликат[\p{L}\p{N}_-]*|архивн[\p{L}\p{N}_-]*\s+копи[яи])(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,80})?(?:диплом[\p{L}\p{N}_-]*|аттестат[\p{L}\p{N}_-]*|удостоверени[\p{L}\p{N}_-]*))(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasExplicitIllicitOverride =
    /(?:^|[^\p{L}\p{N}_-])(?:без\s+(?:обучени[\p{L}\p{N}_-]*|экзамен[\p{L}\p{N}_-]*)|поддельн[\p{L}\p{N}_-]*|фальшив[\p{L}\p{N}_-]*|(?:прода(?:м|ю|ем)|купить)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,80})(?:диплом[\p{L}\p{N}_-]*|аттестат[\p{L}\p{N}_-]*)|внес[её]м(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,40})в\s+(?:реестр|баз[\p{L}\p{N}_-]*))(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );

  return hasOfficialIssuer && hasDuplicateCredentialRequest && !hasExplicitIllicitOverride;
}

function isExplicitPropertyRepairService(rawLoweredText: string): boolean {
  return /(?:^|[^\p{L}\p{N}_-])(?:бригад[а-яё-]*|подрядчик[а-яё-]*|компани[яи]|мы)(?:[^.!?;\n]{0,120})(?:выполня(?:ю|ем|ет|ют)|дела(?:ю|ем|ет|ют)|предлага(?:ю|ем|ет|ют))(?:[^.!?;\n]{0,100})ремонт[а-яё-]*\s+квартир[а-яё-]*(?=[\s\S]{0,220}(?:цен[а-яё-]*|стоимост[а-яё-]*|звоните|пишите|\[phone\]|\d+[\d\s.,]{0,8}\s*(?:₽|руб)))/iu.test(
    rawLoweredText,
  );
}

function isCredentialCoverServiceContext(rawLoweredText: string): boolean {
  const hasIllicitDocumentAnchor =
    /(?:^|[^\p{L}\p{N}_-])(?:готов[ыа][\p{L}\p{N}_-]*\s+документ[\p{L}\p{N}_-]*|без\s+(?:обучени[\p{L}\p{N}_-]*|экзамен[\p{L}\p{N}_-]*)|внес[\p{L}\p{N}_-]*\s+в\s+(?:официальн[\p{L}\p{N}_-]*\s+)?(?:реестр|баз[\p{L}\p{N}_-]*)|конфиденциальн[\p{L}\p{N}_-]*|государственн[\p{L}\p{N}_-]*\s+образц[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  if (hasIllicitDocumentAnchor) {
    return false;
  }

  const hasCredentialContext =
    /(?:^|[^\p{L}\p{N}_-])(?:диплом[\p{L}\p{N}_-]*|аттестат[\p{L}\p{N}_-]*|удостоверени[\p{L}\p{N}_-]*|сертификат[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  const hasPhysicalCoverWork =
    /(?:^|[^\p{L}\p{N}_-])(?:перепл[её]т[\p{L}\p{N}_-]*|обложк[\p{L}\p{N}_-]*|папк[аеиуы][\p{L}\p{N}_-]*|восстанов[\p{L}\p{N}_-]*(?:[\p{L}\p{N}\s.,:;()/%+-]{0,40})корочк[\p{L}\p{N}_-]*|без\s+печат[иь][\p{L}\p{N}_-]*\s+документ[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );

  return hasCredentialContext && hasPhysicalCoverWork;
}

function resolveExplicitFuelRetailContext(rawLoweredText: string): {
  hasCurrentOffer: boolean;
  hasInactiveReport: boolean;
} {
  const boundedRawLoweredText = rawLoweredText.slice(0, MAX_EXPLICIT_FUEL_RETAIL_TEXT_LENGTH);
  if (
    !EXPLICIT_FUEL_OFFER_ANCHOR_PREFILTER.test(boundedRawLoweredText) ||
    !EXPLICIT_FUEL_SELLER_PREFILTER.test(boundedRawLoweredText)
  ) {
    return { hasCurrentOffer: false, hasInactiveReport: false };
  }

  const fuelOfferClauses = boundedRawLoweredText
    .replace(/(руб|р)\./giu, '$1')
    .split(/[.!?;\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .slice(0, MAX_EXPLICIT_FUEL_RETAIL_CLAUSES);
  let hasInactiveRetailCarry = false;
  let hasInactiveReport = false;
  const fuelOfferClauseStates = fuelOfferClauses.map((clause, index) => {
    const transitionWindow = `${clause}. ${fuelOfferClauses[index + 1] ?? ''}`;
    const startsInCurrentClause = (pattern: RegExp): boolean => {
      pattern.lastIndex = 0;
      const match = pattern.exec(transitionWindow);
      return match !== null && match.index < clause.length;
    };
    const hasInactiveClause =
      FUEL_INACTIVE_RETAIL_PREFILTER.test(clause) &&
      !FUEL_ACCESS_CLOSURE_PREFILTER.test(clause) &&
      !FUEL_PARTIAL_OUTAGE_PREFILTER.test(clause);
    if (hasInactiveClause) {
      hasInactiveRetailCarry = true;
      hasInactiveReport = true;
    }
    if (
      startsInCurrentClause(FUEL_CURRENT_REOPENING_PREFILTER) ||
      (!hasInactiveClause && startsInCurrentClause(FUEL_CURRENT_NAMED_RETAIL_PREFILTER))
    ) {
      hasInactiveRetailCarry = false;
    }
    return { clause, isCurrent: !hasInactiveRetailCarry };
  });
  const fuelOfferWindows = fuelOfferClauseStates.flatMap((_, start) =>
    [1, 2, 3].flatMap((length) => {
      const clauseStates = fuelOfferClauseStates.slice(start, start + length);
      return clauseStates.length === length && clauseStates.every(({ isCurrent }) => isCurrent)
        ? [
            {
              attributionWindow: [...clauseStates, fuelOfferClauseStates[start + length]]
                .filter((state): state is { clause: string; isCurrent: boolean } => Boolean(state))
                .map(({ clause }) => clause)
                .join(' '),
              offerWindow: clauseStates.map(({ clause }) => clause).join(' '),
            },
          ]
        : [];
    }),
  );
  const isAttributedOrQuotedFuelWindow = (window: string): boolean => {
    const hasEditorialContact = FUEL_EDITORIAL_CONTACT_PREFILTER.test(window);
    return (
      /(?:^|[^\p{L}\p{N}_-])(?:(?:цитир[а-яё-]*|привод[а-яё-]*)(?:[\p{L}\p{N}\s,:«»"'-]{0,80})пример[а-яё-]*|(?:образец|пример)[а-яё-]*\s+реклам[а-яё-]*|не\s+предложени[а-яё-]*|(?:представител[а-яё-]*|поставщик[а-яё-]*|продавец[а-яё-]*)(?:[\p{L}\p{N}\s,()-]{0,80})(?:сообщил[а-яё-]*|заявил[а-яё-]*|рассказал[а-яё-]*|отметил[а-яё-]*|пояснил[а-яё-]*)\s*[:,-]?\s*[«"])/iu.test(
        window,
      ) ||
      ((FUEL_EDITORIAL_REPORTING_PREFILTER.test(window) || hasEditorialContact) &&
        !FUEL_SOURCE_SIDE_OWNERSHIP_PREFILTER.test(window) &&
        (!FUEL_SOURCE_SIDE_CTA_PREFILTER.test(window) || hasEditorialContact))
    );
  };
  const eligibleFuelOfferWindows = fuelOfferWindows
    .filter(({ attributionWindow }) => !isAttributedOrQuotedFuelWindow(attributionWindow))
    .map(({ offerWindow }) => offerWindow);
  const hasEstablishedRetailFrame = eligibleFuelOfferWindows.some((window) =>
    /(?:^|[^\p{L}\p{N}_-])(?:азс(?:\s+[\p{L}\p{N}_-]+)?(?:[\p{L}\p{N}\s.,:;()/%+-]{0,180})(?:скидк[\p{L}\p{N}_-]*|карт[аые][\p{L}\p{N}_-]*|работа(?:ем|ет)|круглосуточн[\p{L}\p{N}_-]*)|доставк[\p{L}\p{N}_-]*\s+топлив[\p{L}\p{N}_-]*(?:[\p{L}\p{N}\s.,:;()/%+-]{0,180})(?:для\s+бизнес[а-яё-]*|заказ[\p{L}\p{N}_-]*|заявк[\p{L}\p{N}_-]*|тел\.?|телефон|звон[\p{L}\p{N}_-]*))(?=$|[^\p{L}\p{N}_-])/iu.test(
      window,
    ),
  );
  const hasDirectFuelSellerFrame = eligibleFuelOfferWindows.some(
    (window) =>
      /(?:^|[^\p{L}\p{N}_-])(?:(?:прода(?:ю|ем|[её]т|ют)|предлага(?:ю|ем|ет|ют)|реализу(?:ю|ем|ет|ют)|поставля(?:ю|ем|ет|ют))(?:[^.!?\n]{0,80})(?:дт(?=$|[^\p{L}\p{N}_-])|аи(?:[\s\p{Pd}-])?(?:80|92|95|98|100)|дизельн[а-яё-]*\s+топлив[а-яё-]*|бензин[а-яё-]*|топлив[а-яё-]*|нефтепродукт[а-яё-]*)|(?:дт(?=$|[^\p{L}\p{N}_-])|аи(?:[\s\p{Pd}-])?(?:80|92|95|98|100)|дизельн[а-яё-]*\s+топлив[а-яё-]*|бензин[а-яё-]*|топлив[а-яё-]*|нефтепродукт[а-яё-]*)(?:[^.!?\n]{0,80})(?:прода(?:ю|ем|[её]т|ют)|предлага(?:ю|ем|ет|ют)|реализу(?:ю|ем|ет|ют)|поставля(?:ю|ем|ет|ют)|в\s+наличи[а-яё-]*|оптом|закаж[а-яё-]*|заказ[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu.test(
        window,
      ) &&
      /(?:опт[а-яё-]*|розниц[а-яё-]*|\d+[\d\s.,]{0,8}\s*(?:₽|р(?:уб)?)(?:\s*(?:за|\/)?\s*(?:литр[а-яё-]*|л))?|скидк[а-яё-]*|доставк[а-яё-]*|заказ[а-яё-]*|пишите?|звон[а-яё-]*)/iu.test(
        window,
      ),
  );
  const hasFuelGradeStoreOffer = eligibleFuelOfferWindows.some(
    (window) =>
      /(?:^|[^\p{L}\p{N}_-])(?:(?:в|на)\s+наш(?:ем|ей)\s+(?:магазин[а-яё-]*|азс)|у\s+нас|в\s+продаже|в\s+наличии)(?:[\s\S]{0,100})(?:аи(?:[\s\p{Pd}-])?(?:80|92|95|98|100)|дт(?=$|[^\p{L}\p{N}_-])|бензин[а-яё-]*)/iu.test(
        window,
      ) &&
      /\d+[\d\s.,]{0,8}\s*(?:₽|р(?:уб)?)\s*(?:(?:за|\/)\s*)?(?:литр[а-яё-]*|л)(?=$|[^\p{L}\p{N}_-])/iu.test(
        window,
      ) &&
      /(?:^|[^\p{L}\p{N}_-])(?:закаж[а-яё-]*|заказ[а-яё-]*|пишите?|звон[а-яё-]*|\[phone\])(?=$|[^\p{L}\p{N}_-])/iu.test(
        window,
      ),
  );

  return {
    hasCurrentOffer:
      hasEstablishedRetailFrame || hasDirectFuelSellerFrame || hasFuelGradeStoreOffer,
    hasInactiveReport,
  };
}

function hasPrivateContextMarkerHit(
  marker: string,
  hasMarker: (marker: string) => boolean,
  rawLoweredText: string,
): boolean {
  if (marker === 'торг') {
    return /(?:^|[^\p{L}\p{N}_-])торг(?:а|у|ом)?(?=$|[^\p{L}\p{N}_-])/iu.test(rawLoweredText);
  }
  if (marker === 'обмен') {
    return /(?:^|[^\p{L}\p{N}_-])обмен(?:а|у|ом|яю|яем|яете|яет|яют|иваю|иваем|ивать|ю|им)?(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  }
  return hasMarker(marker);
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
