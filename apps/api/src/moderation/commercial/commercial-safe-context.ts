import { resolveCommercialSignalEvidence } from './commercial-evidence';

export type CommercialSafeContextBucket =
  | 'rules_or_moderation_context'
  | 'spam_complaint_or_fraud_warning'
  | 'news_or_analytics'
  | 'brand_mention_only'
  | 'private_one_off_sale'
  | 'ordinary_recruitment'
  | 'public_training_or_help'
  | 'request_or_recommendation'
  | 'none';

const RULES_OR_MODERATION_CONTEXT_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_-])(?:реклам[\p{L}\p{N}_-]*|объявлен[\p{L}\p{N}_-]*|ссылк[\p{L}\p{N}_-]*|спам[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?'"«»()/%+-]{0,80})(?:запрещ[её]н[\p{L}\p{N}_-]*|нельзя|удал[яи][\p{L}\p{N}_-]*|бан[\p{L}\p{N}_-]*|мут[\p{L}\p{N}_-]*|модерац[\p{L}\p{N}_-]*|модератор[\p{L}\p{N}_-]*|админ[\p{L}\p{N}_-]*|фильтр[\p{L}\p{N}_-]*)/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:запрещ[её]н[\p{L}\p{N}_-]*|нельзя|удал[яи][\p{L}\p{N}_-]*|бан[\p{L}\p{N}_-]*|мут[\p{L}\p{N}_-]*|модерац[\p{L}\p{N}_-]*|модератор[\p{L}\p{N}_-]*|админ[\p{L}\p{N}_-]*|фильтр[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?'"«»()/%+-]{0,80})(?:реклам[\p{L}\p{N}_-]*|объявлен[\p{L}\p{N}_-]*|ссылк[\p{L}\p{N}_-]*|спам[\p{L}\p{N}_-]*)/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:пример|образец|цитат[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?'"«»()/%+-]{0,60})(?:реклам[\p{L}\p{N}_-]*|объявлен[\p{L}\p{N}_-]*|спам[\p{L}\p{N}_-]*)/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:бот|фильтр[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?'"«»()/%+-]{0,60})(?:удал[яи][\p{L}\p{N}_-]*|бан[\p{L}\p{N}_-]*|мут[\p{L}\p{N}_-]*|блокир[\p{L}\p{N}_-]*|фильтру[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?'"«»()/%+-]{0,60})(?:реклам[\p{L}\p{N}_-]*|объявлен[\p{L}\p{N}_-]*|ссылк[\p{L}\p{N}_-]*|спам[\p{L}\p{N}_-]*)?/iu,
] as const;

const FRAUD_WARNING_CONTEXT_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_-])(?:мошенник[\p{L}\p{N}_-]*|спамер[\p{L}\p{N}_-]*|это\s+спам|полици[\p{L}\p{N}_-]*\s+предупрежда[\p{L}\p{N}_-]*|мвд\s+предупрежда[\p{L}\p{N}_-]*|предупрежда(?:ет|ют|ем)|осторожн[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?"'«»()/%+-]{0,220})(?:не\s+(?:переходите|переводите|отправляйте|сообщайте|верьте)|обман[\p{L}\p{N}_-]*|похищ[\p{L}\p{N}_-]*|сообщите\s+(?:в\s+)?(?:полици[\p{L}\p{N}_-]*|мвд|админ[\p{L}\p{N}_-]*))(?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:не\s+(?:переходите|переводите|отправляйте|сообщайте|верьте)|обман[\p{L}\p{N}_-]*|похищ[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?"'«»()/%+-]{0,180})(?:мошенник[\p{L}\p{N}_-]*|спамер[\p{L}\p{N}_-]*|спам|полици[\p{L}\p{N}_-]*|мвд|предупрежда[\p{L}\p{N}_-]*|осторожн[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu,
] as const;

const NEWS_OR_ANALYTICS_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:новост(?:ь|и|ью|ей|ям|ями|ях|н[\p{L}\p{N}_-]*)|отчет|отч[её]т|аналитик[\p{L}\p{N}_-]*|статистик[\p{L}\p{N}_-]*|обзор|рынк[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;

const PUBLIC_TRAINING_OR_HELP_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:администраци[\p{L}\p{N}_-]*|госуслуг[\p{L}\p{N}_-]*|компенсаци[\p{L}\p{N}_-]*|голосовани[\p{L}\p{N}_-]*|обучени[\p{L}\p{N}_-]*\s+бесплатн[\p{L}\p{N}_-]*|центр\s+занятост[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;

const BRAND_MENTION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:отзыв|жалоба|подскажите|посоветуйте|кто\s+знает)(?:[\p{L}\p{N}\s.,:;()/%+-]{0,100})(?:wildberries|wb|вб|ozon|озон|авито|банк|маркетплейс[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;

const DIRECT_DEAL_SIGNAL_PREFIXES = ['contact:', 'deal-channel:', 'transaction:'] as const;

const COMMERCIAL_SELF_PROMO_SIGNAL_PREFIXES = [
  'business:',
  'buyout:',
  'channel-placement:',
  'goods-retail:',
  'group-promo:',
  'info:',
  'intent:',
  'property-agent:',
  'property-commercial:',
  'recruitment:',
  'service-specialty:',
] as const;

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

export function hasCommercialDirectDealSignal(signals: readonly string[]): boolean {
  return signals.some((signal) =>
    DIRECT_DEAL_SIGNAL_PREFIXES.some((prefix) => signal.startsWith(prefix)),
  );
}

function hasCommercialSelfPromoSignal(signals: readonly string[]): boolean {
  return signals.some((signal) =>
    COMMERCIAL_SELF_PROMO_SIGNAL_PREFIXES.some((prefix) => signal.startsWith(prefix)),
  );
}

export function deriveCommercialSafeContextBucket(params: {
  text: string;
  matchedSignals?: readonly string[];
  negativeSignals?: readonly string[];
  hasCommercialHit?: boolean;
}): CommercialSafeContextBucket {
  const matchedSignals = params.matchedSignals ?? [];
  const negativeSignals = params.negativeSignals ?? [];
  const text = params.text.toLowerCase();
  const hasCommercialHit = params.hasCommercialHit === true;
  const hasDirectDealSignal = hasCommercialDirectDealSignal(matchedSignals);
  const hasSelfPromoSignal = hasCommercialSelfPromoSignal(matchedSignals);
  const signalEvidence = resolveCommercialSignalEvidence(matchedSignals);
  const hasEscalationRiskEvidence = signalEvidence.hasEscalationRiskEvidence;
  const hasPriceSignal = matchedSignals.some(
    (signal) => signal === 'transaction:price' || signal === 'transaction:implied-price',
  );
  const hasProfessionalLocalRetailOrder =
    signalEvidence.hasActionDirectDealEvidence &&
    matchedSignals.includes('goods-retail:professional-order-catalog');
  const hasProfessionalServiceOffer =
    hasDirectDealSignal &&
    matchedSignals.some(
      (signal) =>
        signal === 'transaction:structured-service-offer' ||
        signal.startsWith('recall-source:service-specialty:') ||
        signal === 'service-specialty:internet-connection-service',
    ) &&
    matchedSignals.some(
      (signal) =>
        signal.startsWith('business:') ||
        signal.startsWith('intent:') ||
        signal.startsWith('recall-source:service-specialty:'),
    );
  const hasProfessionalPrivateSaleOverride =
    hasProfessionalLocalRetailOrder ||
    hasProfessionalServiceOffer ||
    (hasDirectDealSignal &&
      matchedSignals.some(
        (signal) =>
          signal.startsWith('buyout:') ||
          (signal.startsWith('property-agent:') &&
            signal !== 'property-agent:structured-rental-review') ||
          signal.startsWith('property-commercial:') ||
          signal.startsWith('channel-placement:') ||
          signal.startsWith('group-promo:'),
      ));
  const hasLocalPrivateLikeRetailSignal = matchedSignals.some((signal) =>
    LOCAL_PRIVATE_LIKE_RETAIL_SIGNALS.has(signal),
  );
  const hasLinkOrRiskSignal = matchedSignals.some(
    (signal) => signal.startsWith('deal-channel:') || signal.startsWith('risk:'),
  );
  const hasActionableOfferSignal =
    hasSelfPromoSignal ||
    matchedSignals.some(
      (signal) =>
        signal.startsWith('contact:') ||
        signal.startsWith('deal-channel:') ||
        signal.startsWith('cta:') ||
        signal === 'transaction:price' ||
        signal === 'transaction:implied-price' ||
        signal === 'transaction:keywords',
    );
  const hasEscalationOffer = hasEscalationRiskEvidence && hasActionableOfferSignal;
  const hasSignal = (signal: string): boolean => negativeSignals.includes(signal);
  const hasSignalPrefix = (prefix: string): boolean =>
    negativeSignals.some((signal) => signal.startsWith(prefix));

  if (hasSignal('context:moderation-ad-discussion') || hasSignal('context:quoted-ad-example')) {
    return 'rules_or_moderation_context';
  }

  if (
    !hasCommercialHit &&
    RULES_OR_MODERATION_CONTEXT_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return 'rules_or_moderation_context';
  }

  if (
    !hasEscalationOffer &&
    (hasSignal('context:public-fraud-warning') ||
      FRAUD_WARNING_CONTEXT_PATTERNS.some((pattern) => pattern.test(text)))
  ) {
    return 'spam_complaint_or_fraud_warning';
  }

  if (
    hasSignal('context:local-news-subscribe') ||
    hasSignal('context:channel-metrics-not-selling') ||
    hasSignal('context:giveaway-results-report') ||
    (hasSignal('context:fuel-availability-report') &&
      !(hasPriceSignal && hasDirectDealSignal && hasSelfPromoSignal)) ||
    (NEWS_OR_ANALYTICS_PATTERN.test(text) && (!hasCommercialHit || !hasDirectDealSignal))
  ) {
    return 'news_or_analytics';
  }

  if (
    hasSignal('context:official-civic-instruction') ||
    hasSignal('context:public-voting-contest') ||
    hasSignal('context:public-service-enrollment') ||
    (hasSignal('context:public-training-or-event') && !hasEscalationRiskEvidence) ||
    (hasSignal('context:public-help-request') && !hasEscalationRiskEvidence) ||
    (!hasEscalationRiskEvidence &&
      PUBLIC_TRAINING_OR_HELP_PATTERN.test(text) &&
      (!hasCommercialHit || !hasDirectDealSignal || !hasSelfPromoSignal))
  ) {
    return 'public_training_or_help';
  }

  if (hasSignalPrefix('job-seeking:') && !hasEscalationOffer) {
    return 'ordinary_recruitment';
  }

  if (!hasEscalationOffer && (hasSignalPrefix('search:') || hasSignalPrefix('search-pattern:'))) {
    return 'request_or_recommendation';
  }

  if (hasSignal('context:animal-adoption') && !hasPriceSignal) {
    return 'request_or_recommendation';
  }

  if (
    !hasEscalationRiskEvidence &&
    !hasProfessionalPrivateSaleOverride &&
    (hasSignalPrefix('private:') ||
      hasSignalPrefix('private-single:') ||
      hasSignalPrefix('private-goods:') ||
      (hasLocalPrivateLikeRetailSignal && !hasLinkOrRiskSignal))
  ) {
    return 'private_one_off_sale';
  }

  if (
    !hasEscalationOffer &&
    BRAND_MENTION_PATTERN.test(text) &&
    (!hasCommercialHit || !hasSelfPromoSignal)
  ) {
    return 'brand_mention_only';
  }

  return 'none';
}
