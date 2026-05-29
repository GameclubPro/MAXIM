import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import type { CommercialPatternRule } from './commercial.types';

export const COMMERCIAL_PATTERN_POLICY_VERSION = COMMERCIAL_ENGINE_CONFIG.patternPolicyVersion;

export const COMMERCIAL_PATTERN_RULES: readonly CommercialPatternRule[] = [
  {
    id: 'services-specialist-offer',
    subtype: 'SERVICES',
    taxonomyClass: 'TRUE_AD',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:услуг[\p{L}\p{N}_-]*|мастер|ремонт|монтаж|установк[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu,
    weight: COMMERCIAL_ENGINE_CONFIG.scoring.weights.serviceSpecialty,
    evidence: 'STRUCTURED',
    fpRisk: 35,
    examples: ['ремонт окон звоните', 'услуги мастера запись'],
  },
  {
    id: 'goods-retail-order-flow',
    subtype: 'GOODS_RETAIL',
    taxonomyClass: 'TRUE_AD',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:в\s+наличии|под\s+заказ|опт(?:ом)?|розниц[\p{L}\p{N}_-]*|доставк[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu,
    weight: COMMERCIAL_ENGINE_CONFIG.scoring.weights.goodsRetail,
    evidence: 'STRUCTURED',
    fpRisk: 30,
    examples: ['в наличии размеры доставка', 'оптом и в розницу'],
  },
  {
    id: 'channel-placement-traffic',
    subtype: 'CHANNEL_PLACEMENT',
    taxonomyClass: 'TRUE_AD',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:трафик|перелив|места\s+на\s+завтра|цена\s+за\s+пост|аудитори[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu,
    weight: COMMERCIAL_ENGINE_CONFIG.scoring.weights.channelPlacement,
    evidence: 'STRUCTURED',
    fpRisk: 25,
    examples: ['каналы на трафике цена за пост'],
  },
  {
    id: 'property-agent-commission',
    subtype: 'PROPERTY_AGENT',
    taxonomyClass: 'TRUE_AD',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:комисси[\p{L}\p{N}_-]*|агентств[\p{L}\p{N}_-]*|риелтор|риэлтор|показ\s+24\s*\/\s*7)(?=$|[^\p{L}\p{N}_-])/iu,
    weight: COMMERCIAL_ENGINE_CONFIG.scoring.weights.propertyAgent,
    evidence: 'STRUCTURED',
    fpRisk: 25,
    examples: ['комиссия сверху показ 24/7'],
  },
  {
    id: 'high-risk-casino-crypto-loans',
    subtype: 'GENERIC',
    taxonomyClass: 'TRUE_AD',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:казино|букмекер|крипт[\p{L}\p{N}_-]*|трейдинг|займ[\p{L}\p{N}_-]*|кредит[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu,
    weight: COMMERCIAL_ENGINE_CONFIG.scoring.weights.highRiskFallback,
    evidence: 'HIGH_RISK',
    fpRisk: 10,
    examples: ['крипто сигналы пишите', 'займ онлайн без отказа'],
  },
  {
    id: 'private-one-off-goods',
    subtype: 'HARD_NEGATIVE',
    taxonomyClass: 'HARD_NEGATIVE',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:продам\s+(?:свой|свою|свои)|б\s*\/\s*у|после\s+одного\s+раза|самовывоз)(?=$|[^\p{L}\p{N}_-])/iu,
    weight: -COMMERCIAL_ENGINE_CONFIG.scoring.weights.privateGoods,
    evidence: 'HARD_NEGATIVE',
    fpRisk: 5,
    examples: ['продам свой диван самовывоз'],
  },
  {
    id: 'request-recommendation',
    subtype: 'HARD_NEGATIVE',
    taxonomyClass: 'HARD_NEGATIVE',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:посоветуйте|где\s+купить|ищу\s+(?:мастера|специалиста|работу)|кто\s+знает)(?=$|[^\p{L}\p{N}_-])/iu,
    weight: -COMMERCIAL_ENGINE_CONFIG.scoring.weights.searchRequest,
    evidence: 'HARD_NEGATIVE',
    fpRisk: 5,
    examples: ['посоветуйте мастера', 'где купить запчасть'],
  },
] as const;

export function findCommercialPatternRules(params: {
  text: string;
  taxonomyClass?: CommercialPatternRule['taxonomyClass'];
}): CommercialPatternRule[] {
  return COMMERCIAL_PATTERN_RULES.filter(
    (rule) =>
      (!params.taxonomyClass || rule.taxonomyClass === params.taxonomyClass) &&
      rule.pattern.test(params.text),
  );
}
