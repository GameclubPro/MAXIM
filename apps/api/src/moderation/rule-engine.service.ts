import { Injectable } from '@nestjs/common';
import { CommercialAdsSensitivity, LinkPolicy, type ChatSettings } from '@prisma/client';
import { createHash } from 'node:crypto';
import { RedisCounterService } from './redis-counter.service';

export type CommercialDecisionBand = 'LOW' | 'MEDIUM' | 'HIGH';

export type RuleViolation = {
  ruleCode: string;
  score: number;
  reason: string;
  metadata?: Record<string, unknown>;
};

export type DuplicateAction = 'WARN' | 'KICK' | 'BAN';
export type TopicFilterTopic = 'REAL_ESTATE' | 'AUTO_MARKET';

export type DuplicateDecision = {
  action: DuplicateAction;
  count: number;
  threshold: number;
  windowSec: number;
  hash: string;
  nextAction: DuplicateAction | null;
};

export type DuplicateHit = {
  count: number;
  windowSec: number;
  hash: string;
};

export type DetectionResult = {
  violations: RuleViolation[];
  duplicateHit?: DuplicateHit;
  duplicateDecision?: DuplicateDecision;
};

type DuplicateStageName = 'warn' | 'kick' | 'ban';

type DuplicateStage = {
  name: DuplicateStageName;
  action: DuplicateAction;
  windowSec: number;
  threshold: number;
};

type CommercialDetection = {
  confidenceScore: number;
  decisionBand: CommercialDecisionBand;
  matchedSignals: string[];
  negativeSignals: string[];
  appliedThresholds: {
    warnThreshold: number;
    deleteThreshold: number;
    sensitivity: 'BALANCED' | 'STRICT';
  };
};

type CommercialSignalState = {
  score: number;
  matchedSignals: string[];
  negativeSignals: string[];
  hasIntent: boolean;
  hasPrice: boolean;
  hasContact: boolean;
  hasDealChannel: boolean;
  hasTransactional: boolean;
  hasStrongNegativeContext: boolean;
};

type TopicDictionary = {
  phrases: readonly string[];
  exactTokens: readonly string[];
  strongTokenPrefixes: readonly string[];
  supportingExactTokens: readonly string[];
  supportingTokenPrefixes: readonly string[];
  intentMarkers: readonly string[];
  minSupportingIndicators: number;
};

type TopicFilterDetection = {
  mode: 'CODEWORD' | 'TOPIC';
  activeTopics: TopicFilterTopic[];
  matchedTopics: TopicFilterTopic[];
  messageLength: number;
  genericOffTopicMinLengthExclusive: number | null;
  detectedOffTopicTopics: TopicFilterTopic[];
  requiredCodeword: string | null;
  messageFirstToken: string | null;
};

type TopicEvidence = {
  score: number;
  phraseHits: string[];
  exactTokenHits: string[];
  strongPrefixHits: string[];
  supportingIndicators: string[];
  hasIntentMarker: boolean;
};

const PROFANITY_CORE_TOKEN_PATTERNS = [
  /^бля[а-я0-9]*$/u,
  /^пизд[а-я0-9]*$/u,
  /^(?:на|по|до|о|за|ни|вы)?ху[йеяиё][а-я0-9]*$/u,
  /^(?:за|вы|на|по|до|пере|про|об|раз|под|у)?[её]б[а-я0-9]*$/u,
  /^долбо[её]б[а-я0-9]*$/u,
];
const PROFANITY_EXCEPTIONS = [
  'бляха',
  'бляхер',
  'бляхой',
  'страхуй',
  'подстрахуй',
  'застрахуй',
  'страхуем',
  'страхуя',
  'педикюр',
  'сукно',
  'сукон',
  'скипидар',
  'дебилитац',
  'идиомат',
];
const PROFANITY_OBFUSCATED_PATTERNS = [
  /(?:^|[^\p{L}\p{N}])б(?:[^\p{L}\p{N}]{0,3})л(?:[^\p{L}\p{N}]{0,3})[яе](?:[^\p{L}\p{N}]{0,3})[дт]/iu,
  /(?:^|[^\p{L}\p{N}])(?:на|по|до|о|за|ни|вы)?х(?:[^\p{L}\p{N}]{0,3})у(?:[^\p{L}\p{N}]{0,3})[йиея]/iu,
  /(?:^|[^\p{L}\p{N}])п(?:[^\p{L}\p{N}]{0,3})и(?:[^\p{L}\p{N}]{0,3})з(?:[^\p{L}\p{N}]{0,3})д/iu,
  /(?:^|[^\p{L}\p{N}])(?:за|вы|на|по|до|пере|про|об|раз|под|у)?[её](?:[^\p{L}\p{N}]{0,3})б(?:[^\p{L}\p{N}]{0,3})[аоуыиеё]/iu,
  /(?:^|[^\p{L}\p{N}])д(?:[^\p{L}\p{N}]{0,3})о(?:[^\p{L}\p{N}]{0,3})л(?:[^\p{L}\p{N}]{0,3})б(?:[^\p{L}\p{N}]{0,3})о(?:[^\p{L}\p{N}]{0,3})[её](?:[^\p{L}\p{N}]{0,3})б/iu,
  /(?:^|[^\p{L}\p{N}])у(?:[^\p{L}\p{N}]{0,3})[её](?:[^\p{L}\p{N}]{0,3})б(?:[^\p{L}\p{N}]{0,3})[аоуыиеё]/iu,
];
const ADS_INTENT_MARKERS = [
  'продам',
  'продаю',
  'продажа',
  'продается',
  'продаётся',
  'куплю',
  'купите',
  'сдам',
  'сдаю',
  'аренда',
  'запись',
  'записывайтесь',
  'услуга',
  'услуги',
  'на заказ',
  'заказ',
  'прайс',
  'прайс-лист',
  'прайс лист',
  'коммерция',
];
const ADS_PROMO_MARKERS = [
  'промокод',
  'скидк',
  'акци',
  'распродаж',
  'доставк',
  'в наличии',
  'опт',
  'розниц',
  'остатк',
];
const ADS_CONTACT_MARKERS = [
  'пишите в лс',
  'пишите в лич',
  'в лс',
  'в личк',
  'в директ',
  'директ',
  'звоните',
  'пишите',
  'ватсап',
  'whatsapp',
  'вацап',
  'telegram',
  'телеграм',
  'телега',
  'в тг',
  ' тг',
];
const ADS_NEGATIVE_MARKERS = [
  'не продаю',
  'не продается',
  'не реклама',
  'без рекламы',
  'без коммерции',
  'кто подскажет',
  'ищу совет',
  'посоветуйте',
];
const ADS_QUESTION_CONTEXT_MARKERS = ['кто подскажет', 'посоветуйте', 'как лучше', 'что выбрать'];
const ADS_LINK_PATTERN = /(https?:\/\/|t\.me\/|max\.ru\/|vk\.com\/|wa\.me\/|taplink|avito|youla)/iu;
const ADS_PRICE_PATTERN = /\b\d{2,}\s?(₽|руб(\.|лей)?|р\.|р|₸|\$|€)\b/iu;
const ADS_TRANSACTIONAL_PATTERN = /\b(цена|стоимость|оплата|предоплата|доставка|в наличии)\b/iu;
const ADS_URGENCY_PATTERN = /\b(срочно|только сегодня|до конца дня|осталось\s+\d+)\b/iu;
const ADS_QUANTITY_PATTERN = /\b(шт|штук|шт\.|пачк|упак|остатк|места)\b/iu;
const ADS_PHONE_PATTERN = /\b(?:\+7|8)\s*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/u;
const TOPIC_FILTER_GENERIC_OFFTOPIC_MIN_LENGTH = 70;
const TOPIC_FILTER_TOPICS: readonly TopicFilterTopic[] = ['REAL_ESTATE', 'AUTO_MARKET'];
const TOPIC_PHRASE_SCORE = 5;
const TOPIC_EXACT_TOKEN_SCORE = 5;
const TOPIC_STRONG_PREFIX_SCORE = 5;
const TOPIC_SUPPORTING_INDICATOR_SCORE = 2;
const TOPIC_INTENT_MARKER_SCORE = 1;
const TOPIC_MIN_MATCH_SCORE = 5;
const REAL_ESTATE_TOPIC_DICTIONARY: TopicDictionary = {
  phrases: [
    'жилой комплекс',
    'коммерческая недвижимость',
    'продам квартиру',
    'продаю квартиру',
    'куплю квартиру',
    'сдаю квартиру',
    'сниму квартиру',
    'аренда квартиры',
    'продажа квартиры',
    'продается квартира',
    'продаётся квартира',
    'продам комнату',
    'продаю комнату',
    'куплю комнату',
    'продам дом',
    'продаю дом',
    'куплю дом',
    'ищу дом',
    'сдам дом',
    'сдаю дом',
    'дом в аренду',
    'продам коттедж',
    'продаю коттедж',
    'куплю коттедж',
    'сдам коттедж',
    'сдаю коттедж',
    'коттедж в аренду',
    'продам таунхаус',
    'продаю таунхаус',
    'куплю таунхаус',
    'сдам таунхаус',
    'сдаю таунхаус',
    'таунхаус в аренду',
    'продам дачу',
    'продаю дачу',
    'куплю дачу',
    'сдам дачу',
    'сдаю дачу',
    'дачный дом',
    'садовый дом',
    'домик в деревне',
    'продам участок',
    'продаю участок',
    'куплю участок',
    'ищу участок',
    'сдам участок',
    'сдаю участок',
    'аренда участка',
    'дачный участок',
    'садовый участок',
    'участок ижс',
    'участок снт',
    'участок днп',
    'участок лпх',
    'земля в собственности',
    'участок в собственности',
    'назначение земли',
    'категория земель',
    'земли населенных пунктов',
    'земля населенных пунктов',
    'участок под строительство',
    'дом с участком',
    'межевание сделано',
    'межевание есть',
    'выход на сделку',
    'ипотека проходит',
    'подходит под ипотеку',
    'без обременений',
    'без обременения',
    'продам студию',
    'сдам студию',
    'куплю студию',
    'студия в аренду',
    'студия в продаже',
    'квартира студия',
    'сдается студия',
    'сдаётся студия',
    'сниму студию',
    'продам однушку',
    'сдам однушку',
    'куплю однушку',
    'сниму однушку',
    'продам однуху',
    'сдам однуху',
    'куплю однуху',
    'сниму однуху',
    'продам евродвушку',
    'сдам евродвушку',
    'куплю евродвушку',
    'сниму евродвушку',
    'продам евро2',
    'сдам евро2',
    'куплю евро2',
    'продам двушку',
    'сдам двушку',
    'куплю двушку',
    'продам евротрешку',
    'сдам евротрешку',
    'куплю евротрешку',
    'сниму евротрешку',
    'продам евро3',
    'сдам евро3',
    'куплю евро3',
    'продам трешку',
    'сдам трешку',
    'куплю трешку',
    'сниму трешку',
    'продам трёшку',
    'сдам трёшку',
    'куплю трёшку',
    'сниму трёшку',
    'продам четырешку',
    'сдам четырешку',
    'куплю четырешку',
    'сниму четырешку',
    'продам четырёшку',
    'сдам четырёшку',
    'куплю четырёшку',
    'сниму четырёшку',
    'апартаменты в продаже',
    'апартаменты в аренду',
    'апарты в продаже',
    'апарты в аренду',
    'зем уч',
    'кадастровый номер',
    'ипотечная ставка',
    'вторичное жилье',
    'вторичное жильё',
    'ищу квартиру',
    'сдам квартиру',
    'сдается квартира',
    'сдаётся квартира',
    'сдам комнату',
    'сдается комната',
    'сдаётся комната',
    'сниму комнату',
    'комната в аренду',
    'долгосрочная аренда',
    'посуточная аренда',
    'продам гараж',
    'продаю гараж',
    'куплю гараж',
    'сдам гараж',
    'сдаю гараж',
    'сниму гараж',
    'гараж в аренду',
    'гаражный бокс',
    'машиноместо в продаже',
    'машиноместо в аренду',
    'машино место в продаже',
    'машино место в аренду',
    'машино-место в продаже',
    'машино-место в аренду',
    'продам машиноместо',
    'продаю машиноместо',
    'сдам машиноместо',
    'сдаю машиноместо',
    'кладовка в продаже',
    'кладовка в аренду',
    'кладовая в продаже',
    'кладовая в аренду',
    'земельный участок',
    'частный дом',
    'загородный дом',
    'коммерческое помещение',
    'нежилое помещение',
    'помещение свободного назначения',
    'торговое помещение',
    'торговая площадь',
    'торговый павильон',
    'павильон в аренду',
    'павильон в продаже',
    'офисное помещение',
    'продам помещение',
    'продаю помещение',
    'сдам помещение',
    'сдаю помещение',
    'сниму помещение',
    'субаренда помещения',
    'офис в аренду',
    'аренда офиса',
    'продам офис',
    'продаю офис',
    'сдам офис',
    'сдаю офис',
    'сниму офис',
    'склад в аренду',
    'аренда склада',
    'продам склад',
    'продаю склад',
    'сдам склад',
    'сдаю склад',
    'сниму склад',
    'жилая площадь',
    'общая площадь',
    'без посредников',
    'от собственника',
    'квартира от собственника',
    'дом от собственника',
    'без комиссии',
    'залог за месяц',
    'депозит за месяц',
    'чистая продажа',
    'свободная продажа',
    'никто не прописан',
    'мат капитал',
    'маткапитал',
    'риелка не нужна',
    'риэлка не нужна',
    'агентам не беспокоить',
    'риелторам не беспокоить',
    'риэлторам не беспокоить',
    'мокрая точка',
    'первая линия',
    'витринные окна',
    'арендные каникулы',
    'отдельный вход',
    'open space',
    'опен спейс',
    'комната в коммуналке',
    'комната в общежитии',
    'первый взнос',
    'ипотека возможна',
    'иппотека возможна',
    'иппотека проходит',
    'сельхозназначения',
  ],
  exactTokens: [
    'егрн',
    'ижс',
    'снт',
    'днп',
    'лпх',
    'евродвушка',
    'евротрешка',
    'еврооднушка',
    'еврочетырешка',
    'квартира',
    'однушка',
    'двушка',
    'трешка',
    'четырешка',
    'студийка',
    'первичка',
    'вторичка',
    'маткапитал',
    'гостинка',
    'малосемейка',
    'апарты',
    'евро2',
    'евро3',
    'коттедж',
    'таунхаус',
    'коммуналка',
    'риелка',
    'риэлка',
  ],
  strongTokenPrefixes: [
    'квартир',
    'апартамент',
    'апарт',
    'ипотек',
    'новострой',
    'вторичк',
    'таунхаус',
    'однушк',
    'двушк',
    'трешк',
    'трёшк',
    'четырешк',
    'четырёшк',
    'гостинк',
    'студийк',
    'малосеме',
    'коттедж',
    'первичк',
    'маткап',
    'риелтор',
    'риэлтор',
    'риелк',
    'риэлк',
    'недвижим',
    'застройщ',
    'пентхаус',
    'дуплекс',
    'кадастр',
    'домовладен',
    'земельн',
    'межеван',
    'обременен',
    'переуступ',
    'сельхоз',
    'машиномест',
    'еврооднушк',
    'евродвушк',
    'евротрешк',
    'еврочетырешк',
    'посуточн',
  ],
  supportingExactTokens: [
    'участок',
    'участка',
    'участке',
    'участком',
    'участки',
    'межевание',
    'межеванием',
    'обременение',
    'обременений',
    'сотка',
    'сотки',
    'соток',
    'земля',
    'земли',
    'землю',
    'земле',
    'дача',
    'дачу',
    'дачи',
    'однушка',
    'однушку',
    'однушке',
    'однуха',
    'однуху',
    'однухе',
    'двушка',
    'двушку',
    'двушке',
    'трешка',
    'трешку',
    'трешке',
    'трёшка',
    'трёшку',
    'трёшке',
    'четырешка',
    'четырешку',
    'четырешке',
    'четырёшка',
    'четырёшку',
    'четырёшке',
    'студийка',
    'студийку',
    'первичка',
    'вторичка',
    'маткапитал',
    'маткап',
    'гостинка',
    'гостинку',
    'малосемейка',
    'апарт',
    'апарты',
    'апартаменты',
    'домик',
    'домика',
    'жк',
    'комната',
    'комнаты',
    'комнату',
    'комнате',
    'сдам',
    'сдаю',
    'сдается',
    'сдаётся',
    'сниму',
    'этаж',
    'этаже',
    'этажа',
    'балкон',
    'метро',
    'гараж',
    'гаража',
    'гараже',
    'гаражом',
    'кладовка',
    'кладовку',
    'кладовке',
    'кладовая',
    'кладовую',
    'кладовой',
    'машиноместо',
    'машиноместа',
    'коммуналка',
    'коммуналку',
    'коммуналке',
    'студия',
    'студии',
    'студию',
    'помещение',
    'помещения',
    'помещении',
    'склад',
    'склада',
    'складе',
    'павильон',
    'павильона',
    'павильоне',
    'псн',
    'субаренда',
    'опенспейс',
    'риелка',
    'риэлка',
    'иппотека',
    'ипатека',
    'залог',
    'депозит',
    'комиссия',
    'комиссии',
    'показ',
    'просмотр',
  ],
  supportingTokenPrefixes: [
    'собственник',
    'собственик',
    'собсвен',
    'собственност',
    'планировк',
    'паркинг',
    'метраж',
    'санузел',
    'лоджи',
    'район',
    'ремонт',
    'долгосроч',
    'жилплощ',
    'газифиц',
    'скважин',
    'канализац',
    'водопровод',
    'электрич',
    'фасад',
    'прописк',
    'террас',
    'комис',
    'депозит',
    'залог',
    'кладов',
    'парковоч',
    'паркомест',
    'коммунал',
    'витрин',
    'субаренд',
    'ипатек',
    'иппотек',
    'ипотечн',
    'маткап',
    'павильон',
  ],
  intentMarkers: [
    'продаю',
    'продам',
    'продажа',
    'продается',
    'продаётся',
    'сдам',
    'сдаю',
    'сдается',
    'сдаётся',
    'сниму',
    'аренда',
    'куплю',
    'ищу',
    'переуступка',
    'продаеца',
    'продаеться',
    'сдаеца',
    'сдаеться',
  ],
  minSupportingIndicators: 2,
};
const AUTO_MARKET_BRAND_PHRASES = [
  'land rover',
  'range rover',
  'great wall',
  'alfa romeo',
  'aston martin',
  'rolls royce',
  'ленд ровер',
  'лэнд ровер',
  'рендж ровер',
  'рэндж ровер',
  'грейт волл',
  'альфа ромео',
  'астон мартин',
  'роллс ройс',
] as const;
const AUTO_MARKET_BRAND_TOKENS = [
  'lada',
  'лада',
  'ладу',
  'ваз',
  'vaz',
  'жига',
  'жигу',
  'жиги',
  'жигули',
  'нива',
  'ниву',
  'уаз',
  'uaz',
  'газель',
  'камаз',
  'bmw',
  'бмв',
  'бэха',
  'бэху',
  'mercedes',
  'mersedes',
  'мерседес',
  'мерс',
  'мерин',
  'audi',
  'ауди',
  'toyota',
  'тойота',
  'lexus',
  'лексус',
  'nissan',
  'ниссан',
  'infiniti',
  'инфинити',
  'honda',
  'хонда',
  'mazda',
  'мазда',
  'mitsubishi',
  'митсубиси',
  'мицубиси',
  'subaru',
  'субару',
  'suzuki',
  'сузуки',
  'hyundai',
  'хендай',
  'хундай',
  'хендэ',
  'kia',
  'киа',
  'кия',
  'renault',
  'рено',
  'peugeot',
  'пежо',
  'citroen',
  'ситроен',
  'opel',
  'опель',
  'volkswagen',
  'фольксваген',
  'фолксваген',
  'фольц',
  'skoda',
  'шкода',
  'fiat',
  'фиат',
  'ford',
  'форд',
  'chevrolet',
  'шевроле',
  'cadillac',
  'кадиллак',
  'lincoln',
  'линкольн',
  'dodge',
  'додж',
  'chrysler',
  'крайслер',
  'acura',
  'акура',
  'volvo',
  'вольво',
  'porsche',
  'порше',
  'tesla',
  'тесла',
  'jaguar',
  'ягуар',
  'jeep',
  'джип',
  'geely',
  'джили',
  'chery',
  'чери',
  'omoda',
  'омода',
  'jaecoo',
  'джейку',
  'джейко',
  'jetour',
  'джетур',
  'exeed',
  'эксид',
  'haval',
  'хавал',
  'changan',
  'чанган',
  'zeekr',
  'зеекр',
  'voyah',
  'войя',
  'lixiang',
  'лисян',
  'byd',
  'hongqi',
  'хончи',
  'moskvich',
  'москвич',
  'lifan',
  'лифан',
  'dongfeng',
  'донгфенг',
  'daewoo',
  'дэу',
  'ravon',
  'равон',
  'belgee',
  'белджи',
  'genesis',
  'генезис',
  'kaiyi',
  'кайи',
  'джак',
  'jac',
  'swm',
  'свм',
  'sollers',
  'соллерс',
  'ssangyong',
  'сангйонг',
  'санг енг',
  'isuzu',
  'исузу',
  'iveco',
  'ивеко',
  'faw',
  'фау',
  'baic',
  'баик',
  'foton',
  'фотон',
  'gac',
  'гак',
] as const;
const AUTO_MARKET_TOPIC_DICTIONARY: TopicDictionary = {
  phrases: [
    ...AUTO_MARKET_BRAND_PHRASES,
    'лошадиных сил',
    'коробка передач',
    'автомобиль с пробегом',
    'второй комплект шин',
    'обмен на авто',
    'авто с пробегом',
    'без дтп',
    'после дтп',
    'сервисная книжка',
    'родной пробег',
    'продаю авто',
    'продам авто',
    'продаю машину',
    'продам машину',
    'куплю авто',
    'куплю машину',
    'продаю тачку',
    'продам тачку',
    'куплю тачку',
    'продам приору',
    'продаю приору',
    'куплю приору',
    'продам гранту',
    'продаю гранту',
    'куплю гранту',
    'продам весту',
    'продаю весту',
    'куплю весту',
    'продам ларгус',
    'продаю ларгус',
    'куплю ларгус',
    'продам логан',
    'продаю логан',
    'куплю логан',
    'продам дастер',
    'продаю дастер',
    'куплю дастер',
    'продам патриот',
    'продаю патриот',
    'куплю патриот',
    'на ходу',
    'на полном ходу',
    'своим ходом',
    'сел и поехал',
    'сел поехал',
    'завел и поехал',
    'не бит не крашен',
    'не битый не крашеный',
    'один владелец',
    'один хозяин',
    'вложений не требует',
    'торг у капота',
    'без вложений',
    'в хорошем состоянии',
    'документы в порядке',
    'комплект колес',
    'комплект колёс',
    'зимняя резина',
    'летняя резина',
    'полный привод',
    'передний привод',
    'задний привод',
    'левый руль',
    'правый руль',
    'камера заднего вида',
    'подогрев сидений',
    'климат контроль',
    'круиз контроль',
    'авто в наличии',
    'коробка не пинается',
    'продам автомобиль',
    'продается автомобиль',
    'продаётся автомобиль',
    'продается машина',
    'продаётся машина',
    'обмен на машину',
    'переоформление в гибдд',
    'собственник по птс',
    'юридически чист',
    'без запретов',
    'запретов нет',
    'запретов арестов нет',
    'любые проверки',
    'родной окрас',
    'в родной краске',
    'без окрасов',
    'снят с учета',
    'снята с учета',
    'на учете',
    'на учёте',
    'два ключа',
    '2 ключа',
    'на механике',
    'на автомате',
    'на вариаторе',
    'продам мотоцикл',
    'куплю мотоцикл',
    'продам мотик',
    'куплю мотик',
    'мотик на ходу',
    'автомат не пинается',
    'варик не пинается',
    'робот не пинается',
    'ходовка не стучит',
    'масло не ест',
    'масло не жрет',
    'масло не жрёт',
    'не дымит не троит',
    'без штрафов и запретов',
    'на бодром ходу',
    'по кузову ровная',
    'по технике без нареканий',
    'птс оригинал',
    'оригинал птс',
    'переоформ без проблем',
    'контрактный двигатель',
    'контрактный мотор',
    'контрактная коробка',
    'автотека зеленая',
    'автотека зелёная',
    'без рыжиков',
    'без жуков',
    'без гнили',
    'не гнилая',
    'не гнилой',
    'не такси',
    'не из под такси',
    'в такси не была',
    'отчет зеленый',
    'отчёт зелёный',
    'масло от замены до замены',
    'мотор шепчет',
    'движок шепчет',
    'авторазбор',
    'авто в разбор',
    'машина в разбор',
    'на разбор',
    'коммерческий транспорт',
    'продам грузовик',
    'продаю грузовик',
    'куплю грузовик',
    'продам микроавтобус',
    'продаю микроавтобус',
    'куплю микроавтобус',
    'микроавтобус на ходу',
    'штрафов нет',
    'учет на мне',
    'учёт на мне',
    'оформлена на меня',
    'хозяин по птс',
    'по птс я хозяин',
  ],
  exactTokens: [
    'vin',
    'вин',
    'акпп',
    'мкпп',
    'кпп',
    'двс',
    'осаго',
    'каско',
    'птс',
    'стс',
    'дкп',
    'грм',
    'гбо',
    'лкп',
    'грз',
    'мото',
    'мотик',
    'варик',
    'cvt',
    'амт',
    'карб',
    'карбюратор',
    'инжектор',
    'солярис',
    'камри',
    'королла',
    'октавия',
    'крузак',
    'прадо',
    'матиз',
    'нексия',
    'кулрей',
    'тигго',
    'джолион',
    'монжаро',
    'приора',
    'гранта',
    'веста',
    'ларгус',
    'логан',
    'дастер',
    'патриот',
    'соболь',
    'кобальт',
  ],
  strongTokenPrefixes: [
    'автомобил',
    'авторын',
    'автосалон',
    'мотоцикл',
    'квадроцикл',
    'скутер',
    'вариатор',
    'седан',
    'кроссовер',
    'хэтчбек',
    'пикап',
    'внедорож',
    'электромоб',
    'кабриолет',
    'минивэн',
    'лифтбек',
    'паркетник',
    'микроавтобус',
    'грузовик',
    'фургон',
    'самосвал',
    'тягач',
    'полуприцеп',
    'универсал',
    'купе',
    'карбюр',
    'инжектор',
    'леворул',
    'праворул',
    'солярис',
    'королл',
    'октави',
    'кулре',
    'джолион',
    'монжар',
    'ларгус',
    'патриот',
  ],
  supportingExactTokens: [
    'дтп',
    'авто',
    'машина',
    'машину',
    'машины',
    'машиной',
    'тачка',
    'тачку',
    'тачки',
    ...AUTO_MARKET_BRAND_TOKENS,
    'мот',
    'мото',
    'мотик',
    'двигатель',
    'двигателя',
    'движок',
    'мотор',
    'лс',
    'автомат',
    'механика',
    'варик',
    'робот',
    'ходовка',
    'коробас',
    'резина',
    'колеса',
    'колёса',
    'шины',
    'шина',
    'фара',
    'фару',
    'диски',
    'фары',
    'пороги',
    'багажник',
    'пластик',
    'дно',
    'двс',
    'кпп',
    'лкп',
    'грз',
    'прицеп',
    'запчасти',
    'разборка',
    'автотека',
    'корч',
    'корча',
    'рыжик',
    'рыжики',
    'гниль',
    'гнилая',
    'гнилой',
    'шрус',
    'ступица',
    'ступицу',
    'рейка',
    'гур',
    'эгур',
    'дизель',
    'бензин',
    'гибрид',
    'карб',
    'карбюратор',
    'инжектор',
    'солярис',
    'камри',
    'королла',
    'октавия',
    'крузак',
    'прадо',
    'матиз',
    'нексия',
    'кулрей',
    'тигго',
    'джолион',
    'монжаро',
    'приора',
    'гранта',
    'веста',
    'ларгус',
    'логан',
    'дастер',
    'патриот',
    'соболь',
    'кобальт',
    'такси',
    'фаркоп',
    'парктроник',
    'автозапуск',
    'турбина',
    'катализатор',
  ],
  supportingTokenPrefixes: [
    'пробег',
    'двигател',
    'кузов',
    'подвеск',
    'бампер',
    'тормозн',
    'сцеплен',
    'обслуж',
    'капот',
    'шин',
    'резин',
    'рулев',
    'ходов',
    'окрас',
    'переоформ',
    'госномер',
    'автотек',
    'контракт',
    'рыжик',
    'гнил',
    'ступиц',
    'рейк',
    'дизел',
    'бензин',
    'гибрид',
    'карбюр',
    'инжект',
    'штраф',
    'леворул',
    'праворул',
    'фаркоп',
    'парктрон',
    'автозапуск',
    'турбин',
    'катализ',
  ],
  intentMarkers: [
    'продаю',
    'продам',
    'продается',
    'продаётся',
    'продаеца',
    'продаеться',
    'куплю',
    'обмен',
    'обменяю',
    'торг',
  ],
  minSupportingIndicators: 2,
};
const DEFAULT_DUPLICATE_WINDOW_SEC = 60;
const DUPLICATE_MIN_LENGTH = 32;
const DUPLICATE_MIN_TOKEN_COUNT = 5;
const DUPLICATE_MIN_UNIQUE_LONG_TOKENS = 3;
const MIXED_CHAR_MAP: Record<string, string> = {
  a: 'а',
  b: 'б',
  c: 'с',
  d: 'д',
  e: 'е',
  f: 'ф',
  g: 'г',
  h: 'х',
  i: 'и',
  j: 'й',
  k: 'к',
  l: 'л',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'п',
  q: 'к',
  r: 'р',
  s: 'с',
  t: 'т',
  u: 'у',
  v: 'в',
  w: 'в',
  x: 'х',
  y: 'у',
  z: 'з',
  '0': 'о',
  '1': 'и',
  '3': 'з',
  '4': 'а',
  '6': 'б',
  '7': 'т',
  '8': 'в',
  '9': 'д',
  '@': 'а',
  $: 'с',
};

@Injectable()
export class RuleEngineService {
  constructor(private readonly redisCounter: RedisCounterService) {}

  async detect(params: {
    chatId: string;
    userId: string;
    text: string;
    settings: ChatSettings;
    domainAllowlist: string[];
    effectiveLength?: number;
    hasPhotoAttachment?: boolean;
    hasStickerAttachment?: boolean;
    hasVideoAttachment?: boolean;
    hasFileAttachment?: boolean;
    hasVoiceAttachment?: boolean;
  }): Promise<DetectionResult> {
    const {
      chatId,
      userId,
      text,
      settings,
      domainAllowlist,
      effectiveLength,
      hasPhotoAttachment,
      hasStickerAttachment,
      hasVideoAttachment,
      hasFileAttachment,
      hasVoiceAttachment,
    } = params;
    const violations: RuleViolation[] = [];
    const normalized = this.normalizeForDetection(text);
    const lowered = text.toLowerCase();
    const measuredLength = typeof effectiveLength === 'number' ? effectiveLength : text.length;

    if (settings.russianProfanityFilterEnabled && this.hasProfanity(normalized)) {
      violations.push({ ruleCode: 'PROFANITY', score: 0.95, reason: 'Detected profanity pattern' });
    }

    if (settings.commercialAdsFilterEnabled) {
      const commercial = this.detectCommercialAd({
        normalizedText: normalized,
        rawLoweredText: lowered,
        settings,
      });
      if (commercial) {
        violations.push({
          ruleCode: 'COMMERCIAL_AD',
          score: commercial.confidenceScore / 100,
          reason: 'Detected Russian commercial ad pattern',
          metadata: {
            confidenceScore: commercial.confidenceScore,
            decisionBand: commercial.decisionBand,
            matchedSignals: commercial.matchedSignals,
            negativeSignals: commercial.negativeSignals,
            appliedThresholds: commercial.appliedThresholds,
          },
        });
      }
    }

    const topicMismatch = this.detectTopicFilterMismatch({
      normalizedText: normalized,
      measuredLength,
      settings,
    });
    if (topicMismatch) {
      violations.push({
        ruleCode: 'TOPIC_FILTER_MISMATCH',
        score: 0.84,
        reason: 'Message without required thematic markers',
        metadata: {
          mode: topicMismatch.mode,
          activeTopics: topicMismatch.activeTopics,
          matchedTopics: topicMismatch.matchedTopics,
          messageLength: topicMismatch.messageLength,
          genericOffTopicMinLengthExclusive: topicMismatch.genericOffTopicMinLengthExclusive,
          detectedOffTopicTopics: topicMismatch.detectedOffTopicTopics,
          requiredCodeword: topicMismatch.requiredCodeword,
          messageFirstToken: topicMismatch.messageFirstToken,
        },
      });
    }

    const linkViolation = this.hasBlockedLink(text, settings.linkPolicy, domainAllowlist);
    if (linkViolation) {
      violations.push({ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: linkViolation });
    }

    if (settings.maxMessageLengthEnabled && measuredLength > settings.maxMessageLength) {
      violations.push({
        ruleCode: 'MESSAGE_TOO_LONG',
        score: 0.82,
        reason: `Message length ${measuredLength} exceeds limit ${settings.maxMessageLength}`,
      });
    }

    if (hasVideoAttachment && !settings.videoMessagesEnabled) {
      violations.push({
        ruleCode: 'VIDEO_BLOCKED',
        score: 0.88,
        reason: 'Video messages are disabled by chat settings',
      });
    }

    if (hasFileAttachment && !settings.fileMessagesEnabled) {
      violations.push({
        ruleCode: 'FILE_BLOCKED',
        score: 0.88,
        reason: 'File messages are disabled by chat settings',
      });
    }

    if (hasVoiceAttachment && !settings.voiceMessagesEnabled) {
      violations.push({
        ruleCode: 'VOICE_BLOCKED',
        score: 0.88,
        reason: 'Voice messages are disabled by chat settings',
      });
    }

    if (hasPhotoAttachment && settings.photoMessageCooldownEnabled) {
      const cooldownSec = settings.photoMessageCooldownHours * 60 * 60;
      const key = `photo:cooldown:${chatId}:${userId}`;
      const count = await this.redisCounter.incrementWithTtl(key, cooldownSec + 1);
      if (count > 1) {
        violations.push({
          ruleCode: 'PHOTO_RATE_LIMIT',
          score: 0.86,
          reason: `Messages with photos are limited to one per ${settings.photoMessageCooldownHours}h`,
        });
      }
    }

    if (hasStickerAttachment && settings.stickerMessageCooldownEnabled) {
      const cooldownSec = settings.stickerMessageCooldownMinutes * 60;
      const key = `sticker:cooldown:${chatId}:${userId}`;
      const count = await this.redisCounter.incrementWithTtl(key, cooldownSec + 1);
      if (count > 1) {
        violations.push({
          ruleCode: 'STICKER_RATE_LIMIT',
          score: 0.86,
          reason: `Stickers are limited to one per ${settings.stickerMessageCooldownMinutes}m`,
        });
      }
    }

    const compactText = normalized.replace(/\s+/g, ' ').trim();
    const duplicateCandidate = this.shouldTrackDuplicate(compactText);
    const duplicateState =
      settings.antiDuplicateEnabled && duplicateCandidate
        ? await this.detectDuplicateState({
            chatId,
            userId,
            compactText,
            settings,
          })
        : undefined;

    return {
      violations,
      ...(duplicateState?.hit ? { duplicateHit: duplicateState.hit } : {}),
      ...(duplicateState?.decision ? { duplicateDecision: duplicateState.decision } : {}),
    };
  }

  private async detectDuplicateState(params: {
    chatId: string;
    userId: string;
    compactText: string;
    settings: ChatSettings;
  }): Promise<{
    hit?: DuplicateHit;
    decision?: DuplicateDecision;
  }> {
    const { chatId, userId, compactText, settings } = params;
    const hash = createHash('sha256').update(compactText).digest('hex').slice(0, 20);
    const hitKey = `dup:v3:${chatId}:${userId}:${hash}:hit`;
    const hitTotal = await this.redisCounter.incrementWithTtl(
      hitKey,
      DEFAULT_DUPLICATE_WINDOW_SEC + 1,
    );
    const hitCount = Math.max(0, hitTotal - 1);
    const hit =
      hitCount > 0
        ? {
            count: hitCount,
            windowSec: DEFAULT_DUPLICATE_WINDOW_SEC,
            hash,
          }
        : undefined;

    const stages = this.getEnabledDuplicateStages(settings);
    if (stages.length === 0) {
      return { hit };
    }

    const repeatCounts = new Map<DuplicateStageName, number>();

    for (const stage of stages) {
      const key = `dup:v3:${chatId}:${userId}:${hash}:${stage.name}`;
      const count = await this.redisCounter.incrementWithTtl(key, stage.windowSec + 1);
      repeatCounts.set(stage.name, Math.max(0, count - 1));
    }

    const priority: DuplicateStageName[] = ['ban', 'kick', 'warn'];
    for (const stageName of priority) {
      const stage = stages.find((candidate) => candidate.name === stageName);
      if (!stage) {
        continue;
      }

      const count = repeatCounts.get(stageName) ?? 0;
      if (count < stage.threshold) {
        continue;
      }

      return {
        hit,
        decision: {
          action: stage.action,
          count,
          threshold: stage.threshold,
          windowSec: stage.windowSec,
          hash,
          nextAction: this.resolveNextDuplicateAction(stages, stageName),
        },
      };
    }

    return { hit };
  }

  private getEnabledDuplicateStages(settings: ChatSettings): DuplicateStage[] {
    const stages: Array<DuplicateStage | null> = [
      settings.duplicateWarnEnabled
        ? {
            name: 'warn',
            action: 'WARN',
            windowSec: settings.duplicateWarnWindowSec,
            threshold: settings.duplicateWarnMaxCount,
          }
        : null,
      settings.duplicateKickEnabled
        ? {
            name: 'kick',
            action: 'KICK',
            windowSec: settings.duplicateKickWindowSec,
            threshold: settings.duplicateKickMaxCount,
          }
        : null,
      settings.duplicateBanEnabled
        ? {
            name: 'ban',
            action: 'BAN',
            windowSec: settings.duplicateBanWindowSec,
            threshold: settings.duplicateBanMaxCount,
          }
        : null,
    ];

    return stages.filter((item): item is DuplicateStage => item !== null);
  }

  private resolveNextDuplicateAction(
    stages: DuplicateStage[],
    actionName: DuplicateStageName,
  ): DuplicateAction | null {
    const order: DuplicateStageName[] = ['warn', 'kick', 'ban'];
    const stageNames = stages.map((stage) => stage.name);
    const currentIndex = order.indexOf(actionName);

    for (let index = currentIndex + 1; index < order.length; index += 1) {
      const nextName = order[index];
      if (!stageNames.includes(nextName)) {
        continue;
      }

      if (nextName === 'warn') {
        return 'WARN';
      }
      if (nextName === 'kick') {
        return 'KICK';
      }
      return 'BAN';
    }

    return null;
  }

  private hasProfanity(normalizedText: string): boolean {
    const profanityText = this.normalizeForProfanity(normalizedText);
    const sanitizedProfanityText = this.stripProfanityExceptions(profanityText);
    const tokens = this.extractProfanityTokens(profanityText);
    if (tokens.length === 0) {
      return false;
    }

    const tokenHit = tokens.some((token) => this.isProfanityToken(token));
    if (tokenHit) {
      return true;
    }

    return this.hasPatternHit(sanitizedProfanityText, PROFANITY_OBFUSCATED_PATTERNS);
  }

  private isProfanityToken(token: string): boolean {
    if (!token) {
      return false;
    }

    if (PROFANITY_EXCEPTIONS.some((exception) => token.startsWith(exception))) {
      return false;
    }

    return PROFANITY_CORE_TOKEN_PATTERNS.some((pattern) => pattern.test(token));
  }

  private hasPatternHit(text: string, patterns: RegExp[]): boolean {
    if (!text) {
      return false;
    }

    return patterns.some((pattern) => pattern.test(text));
  }

  private stripProfanityExceptions(text: string): string {
    let sanitized = text;
    for (const exception of PROFANITY_EXCEPTIONS) {
      const pattern = new RegExp(this.escapeRegExp(exception), 'giu');
      sanitized = sanitized.replace(pattern, ' ');
    }

    return sanitized;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private shouldTrackDuplicate(compactText: string): boolean {
    if (!compactText) {
      return false;
    }

    const hasUrl = this.extractUrlsFromText(compactText).length > 0;
    if (hasUrl || ADS_PHONE_PATTERN.test(compactText)) {
      return true;
    }

    const hasAdMarker =
      ADS_INTENT_MARKERS.some((marker) => compactText.includes(marker)) ||
      ADS_CONTACT_MARKERS.some((marker) => compactText.includes(marker)) ||
      ADS_PROMO_MARKERS.some((marker) => compactText.includes(marker)) ||
      ADS_PRICE_PATTERN.test(compactText) ||
      ADS_TRANSACTIONAL_PATTERN.test(compactText);
    if (hasAdMarker) {
      return true;
    }

    const tokens = this.extractTokens(compactText);
    if (tokens.length < DUPLICATE_MIN_TOKEN_COUNT || compactText.length < DUPLICATE_MIN_LENGTH) {
      return false;
    }

    const uniqueLongTokens = new Set(tokens.filter((token) => token.length >= 4)).size;
    return uniqueLongTokens >= DUPLICATE_MIN_UNIQUE_LONG_TOKENS;
  }

  private hasBlockedLink(text: string, policy: LinkPolicy, allowlist: string[]): string | null {
    if (policy === LinkPolicy.ALERT_ONLY) {
      return null;
    }

    const links = this.extractUrlsFromText(text);

    if (links.length === 0) {
      return null;
    }

    if (policy === LinkPolicy.BLOCKLIST_ONLY) {
      return 'Links are not allowed by policy';
    }

    const normalizedAllowlist = new Set(
      allowlist
        .map((entry) => this.normalizeAllowlistLink(entry))
        .filter((entry): entry is string => Boolean(entry)),
    );

    for (const link of links) {
      const normalizedLink = this.normalizeAllowlistLink(link);
      if (!normalizedLink) {
        continue;
      }

      if (!normalizedAllowlist.has(normalizedLink)) {
        return `Link ${normalizedLink} is not in allowlist`;
      }
    }

    return null;
  }

  private extractUrlsFromText(value: string): string[] {
    if (!value || value.trim().length === 0) {
      return [];
    }

    const regex = /((https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,})(\/\S*)?/gi;
    return [...value.matchAll(regex)]
      .map((match) => match[0].trim().replace(/[),.;!?]+$/, ''))
      .filter((url) => url.length > 0);
  }

  private normalizeAllowlistLink(value: string): string | null {
    const raw = value.trim();
    if (!raw) {
      return null;
    }

    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let parsed: URL;
    try {
      parsed = new URL(withScheme);
    } catch {
      return null;
    }

    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (!hostname) {
      return null;
    }

    const shouldKeepPort =
      parsed.port.length > 0 &&
      !(
        (protocol === 'https:' && parsed.port === '443') ||
        (protocol === 'http:' && parsed.port === '80')
      );
    const port = shouldKeepPort ? `:${parsed.port}` : '';
    return `${hostname}${port}`.toLowerCase();
  }

  private detectCommercialAd(params: {
    normalizedText: string;
    rawLoweredText: string;
    settings: ChatSettings;
  }): CommercialDetection | null {
    const { normalizedText, rawLoweredText, settings } = params;

    if (!normalizedText || normalizedText.length < 6) {
      return null;
    }

    const appliedThresholds = this.resolveCommercialThresholds(settings);
    const state = this.collectCommercialSignals(normalizedText, rawLoweredText, settings);
    if (state.matchedSignals.length === 0) {
      return null;
    }

    let confidenceScore = Math.round(Math.max(0, Math.min(100, state.score)));
    if (state.hasStrongNegativeContext && !state.hasPrice && !state.hasContact) {
      confidenceScore = Math.min(confidenceScore, appliedThresholds.warnThreshold - 1);
    }

    if (confidenceScore >= appliedThresholds.deleteThreshold) {
      const hasStrongCommercialCombo =
        state.hasIntent && (state.hasTransactional || state.hasContact || state.hasDealChannel);
      if (!hasStrongCommercialCombo) {
        confidenceScore = Math.max(
          appliedThresholds.warnThreshold,
          appliedThresholds.deleteThreshold - 1,
        );
      }
    }

    const decisionBand: CommercialDecisionBand =
      confidenceScore >= appliedThresholds.deleteThreshold
        ? 'HIGH'
        : confidenceScore >= appliedThresholds.warnThreshold
          ? 'MEDIUM'
          : 'LOW';

    return {
      confidenceScore,
      decisionBand,
      matchedSignals: state.matchedSignals,
      negativeSignals: state.negativeSignals,
      appliedThresholds,
    };
  }

  private resolveCommercialThresholds(settings: ChatSettings): {
    warnThreshold: number;
    deleteThreshold: number;
    sensitivity: 'BALANCED' | 'STRICT';
  } {
    const strict = settings.commercialAdsSensitivity === CommercialAdsSensitivity.STRICT;
    const warnBase = Number.isFinite(settings.commercialAdsWarnThreshold)
      ? settings.commercialAdsWarnThreshold
      : 45;
    const deleteBase = Number.isFinite(settings.commercialAdsDeleteThreshold)
      ? settings.commercialAdsDeleteThreshold
      : 65;
    const warnThreshold = strict ? Math.max(10, warnBase - 3) : warnBase;
    const deleteThreshold = strict
      ? Math.max(warnThreshold + 5, deleteBase - 4)
      : Math.max(warnThreshold + 5, deleteBase);

    return {
      warnThreshold,
      deleteThreshold,
      sensitivity: strict ? 'STRICT' : 'BALANCED',
    };
  }

  private detectTopicFilterMismatch(params: {
    normalizedText: string;
    measuredLength: number;
    settings: ChatSettings;
  }): TopicFilterDetection | null {
    const { normalizedText, measuredLength, settings } = params;
    const requiredCodeword = this.resolveRequiredThematicCodeword(settings);
    if (requiredCodeword) {
      const messageFirstToken = this.extractFirstNormalizedToken(normalizedText);
      if (messageFirstToken === requiredCodeword) {
        return null;
      }

      return {
        mode: 'CODEWORD',
        activeTopics: [],
        matchedTopics: [],
        messageLength: measuredLength,
        genericOffTopicMinLengthExclusive: null,
        detectedOffTopicTopics: [],
        requiredCodeword,
        messageFirstToken,
      };
    }

    const activeTopics = this.getActiveTopics(settings);
    if (activeTopics.length === 0) {
      return null;
    }

    const topicEvidence = new Map(
      TOPIC_FILTER_TOPICS.map((topic) => [topic, this.collectTopicEvidence(normalizedText, topic)]),
    );
    const matchedTopics = activeTopics.filter((topic) =>
      this.hasSufficientTopicEvidence(topicEvidence.get(topic)),
    );
    if (matchedTopics.length > 0) {
      return null;
    }

    const detectedOffTopicTopics = TOPIC_FILTER_TOPICS.filter(
      (topic) => !activeTopics.includes(topic) && this.hasSufficientTopicEvidence(topicEvidence.get(topic)),
    );
    if (
      measuredLength <= TOPIC_FILTER_GENERIC_OFFTOPIC_MIN_LENGTH &&
      detectedOffTopicTopics.length === 0
    ) {
      return null;
    }

    return {
      mode: 'TOPIC',
      activeTopics,
      matchedTopics,
      messageLength: measuredLength,
      genericOffTopicMinLengthExclusive: TOPIC_FILTER_GENERIC_OFFTOPIC_MIN_LENGTH,
      detectedOffTopicTopics,
      requiredCodeword: null,
      messageFirstToken: this.extractFirstNormalizedToken(normalizedText),
    };
  }

  private resolveRequiredThematicCodeword(settings: ChatSettings): string | null {
    if (!settings.thematicCodewordEnabled) {
      return null;
    }

    return this.normalizeThematicCodeword(settings.thematicCodeword);
  }

  private normalizeThematicCodeword(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = this.normalizeForDetection(value).replace(/ё/g, 'е').trim();
    if (!normalized || normalized.includes(' ')) {
      return null;
    }

    return normalized;
  }

  private extractFirstNormalizedToken(normalizedText: string): string | null {
    const [firstToken] = this.extractTokens(normalizedText);
    if (!firstToken) {
      return null;
    }

    return firstToken.replace(/ё/g, 'е');
  }

  private getActiveTopics(settings: ChatSettings): TopicFilterTopic[] {
    const activeTopics: TopicFilterTopic[] = [];
    if (settings.realEstateTopicFilterEnabled) {
      activeTopics.push('REAL_ESTATE');
    }
    if (settings.autoMarketTopicFilterEnabled) {
      activeTopics.push('AUTO_MARKET');
    }

    return activeTopics;
  }

  private getTopicDictionary(topic: TopicFilterTopic): TopicDictionary {
    return topic === 'REAL_ESTATE' ? REAL_ESTATE_TOPIC_DICTIONARY : AUTO_MARKET_TOPIC_DICTIONARY;
  }

  private collectTopicEvidence(normalizedText: string, topic: TopicFilterTopic): TopicEvidence {
    if (!normalizedText) {
      return {
        score: 0,
        phraseHits: [],
        exactTokenHits: [],
        strongPrefixHits: [],
        supportingIndicators: [],
        hasIntentMarker: false,
      };
    }

    const dictionary = this.getTopicDictionary(topic);
    const phraseHits = dictionary.phrases.filter((phrase) => normalizedText.includes(phrase));
    const tokens = this.extractTokens(normalizedText);
    if (tokens.length === 0) {
      return {
        score: phraseHits.length > 0 ? TOPIC_PHRASE_SCORE : 0,
        phraseHits,
        exactTokenHits: [],
        strongPrefixHits: [],
        supportingIndicators: [],
        hasIntentMarker: false,
      };
    }

    const tokenSet = new Set(tokens);
    const exactTokenHits = new Set<string>();
    for (const token of dictionary.exactTokens) {
      if (this.hasTopicExactTokenMatch(tokenSet, tokens, token)) {
        exactTokenHits.add(token);
      }
    }

    const strongPrefixHits = new Set<string>();
    for (const token of tokens) {
      if (
        dictionary.strongTokenPrefixes.some((prefix) => this.hasTopicPrefixMatch(token, prefix))
      ) {
        strongPrefixHits.add(token);
      }
    }

    const supportingIndicators = this.collectTopicSupportingIndicators(tokens, dictionary);
    const hasIntentMarker = dictionary.intentMarkers.some((marker) => normalizedText.includes(marker));
    const score =
      (phraseHits.length > 0 ? TOPIC_PHRASE_SCORE : 0) +
      (exactTokenHits.size > 0 ? TOPIC_EXACT_TOKEN_SCORE : 0) +
      (strongPrefixHits.size > 0 ? TOPIC_STRONG_PREFIX_SCORE : 0) +
      supportingIndicators.size * TOPIC_SUPPORTING_INDICATOR_SCORE +
      (hasIntentMarker ? TOPIC_INTENT_MARKER_SCORE : 0);

    return {
      score,
      phraseHits,
      exactTokenHits: [...exactTokenHits],
      strongPrefixHits: [...strongPrefixHits],
      supportingIndicators: [...supportingIndicators],
      hasIntentMarker,
    };
  }

  private hasSufficientTopicEvidence(evidence?: TopicEvidence): boolean {
    return (evidence?.score ?? 0) >= TOPIC_MIN_MATCH_SCORE;
  }

  private collectTopicSupportingIndicators(
    tokens: string[],
    dictionary: TopicDictionary,
  ): Set<string> {
    const supportingIndicators = new Set<string>();
    for (const token of tokens) {
      let tokenMatched = false;

      for (const exactToken of dictionary.supportingExactTokens) {
        if (this.hasTopicSupportingTokenMatch(token, exactToken)) {
          tokenMatched = true;
          break;
        }
      }

      if (!tokenMatched) {
        for (const prefix of dictionary.supportingTokenPrefixes) {
          if (this.hasTopicSupportingPrefixMatch(token, prefix)) {
            tokenMatched = true;
            break;
          }
        }
      }

      if (tokenMatched) {
        supportingIndicators.add(token);
      }
    }

    return supportingIndicators;
  }

  private hasTopicSupportingTokenMatch(token: string, expectedToken: string): boolean {
    if (token === expectedToken) {
      return true;
    }

    if (expectedToken.length < 6) {
      return false;
    }

    return this.isApproximateTopicTokenMatch(token, expectedToken);
  }

  private hasTopicSupportingPrefixMatch(token: string, prefix: string): boolean {
    return token === prefix || token.startsWith(prefix);
  }

  private hasTopicExactTokenMatch(
    tokenSet: Set<string>,
    tokens: string[],
    expectedToken: string,
  ): boolean {
    if (tokenSet.has(expectedToken)) {
      return true;
    }

    if (expectedToken.length < 6) {
      return false;
    }

    return tokens.some((token) => this.isApproximateTopicTokenMatch(token, expectedToken));
  }

  private hasTopicPrefixMatch(token: string, prefix: string): boolean {
    if (token === prefix || token.startsWith(prefix)) {
      return true;
    }

    if (prefix.length < 6 || token.length < prefix.length - 1) {
      return false;
    }

    if (token.slice(0, 3) !== prefix.slice(0, 3)) {
      return false;
    }

    const candidateLengths = new Set([prefix.length - 1, prefix.length, prefix.length + 1]);
    for (const candidateLength of candidateLengths) {
      if (candidateLength < 1 || token.length < candidateLength) {
        continue;
      }

      const candidate = token.slice(0, candidateLength);
      if (this.hasEditDistanceAtMostOne(candidate, prefix)) {
        return true;
      }
    }

    return false;
  }

  private isApproximateTopicTokenMatch(token: string, expectedToken: string): boolean {
    if (token.length < 6 || Math.abs(token.length - expectedToken.length) > 1) {
      return false;
    }

    if (token.slice(0, 3) !== expectedToken.slice(0, 3)) {
      return false;
    }

    return this.hasEditDistanceAtMostOne(token, expectedToken);
  }

  private hasEditDistanceAtMostOne(left: string, right: string): boolean {
    if (left === right) {
      return true;
    }

    if (Math.abs(left.length - right.length) > 1) {
      return false;
    }

    let leftIndex = 0;
    let rightIndex = 0;
    let edits = 0;

    while (leftIndex < left.length && rightIndex < right.length) {
      if (left[leftIndex] === right[rightIndex]) {
        leftIndex += 1;
        rightIndex += 1;
        continue;
      }

      if (edits === 1) {
        return false;
      }

      if (
        leftIndex + 1 < left.length &&
        rightIndex + 1 < right.length &&
        left[leftIndex] === right[rightIndex + 1] &&
        left[leftIndex + 1] === right[rightIndex]
      ) {
        edits += 1;
        leftIndex += 2;
        rightIndex += 2;
        continue;
      }

      edits += 1;
      if (left.length > right.length) {
        leftIndex += 1;
      } else if (right.length > left.length) {
        rightIndex += 1;
      } else {
        leftIndex += 1;
        rightIndex += 1;
      }
    }

    if (leftIndex < left.length || rightIndex < right.length) {
      edits += 1;
    }

    return edits <= 1;
  }

  private collectCommercialSignals(
    normalizedText: string,
    rawLoweredText: string,
    settings: ChatSettings,
  ): CommercialSignalState {
    const strict = settings.commercialAdsSensitivity === CommercialAdsSensitivity.STRICT;
    const positiveFactor = strict ? 1.15 : 1;
    const negativeFactor = strict ? 0.85 : 1;

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
    let hasPrice = false;
    let hasContact = false;
    let hasDealChannel = false;
    let hasTransactional = false;
    let hasStrongNegativeContext = false;

    const hasMarker = (marker: string): boolean =>
      normalizedText.includes(marker) || rawLoweredText.includes(marker);

    const intentHits = ADS_INTENT_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of intentHits.slice(0, 3)) {
      addPositive(`intent:${marker}`, 18);
      hasIntent = true;
    }

    const promoHits = ADS_PROMO_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of promoHits.slice(0, 3)) {
      addPositive(`promo:${marker}`, 8);
    }

    if (ADS_PRICE_PATTERN.test(rawLoweredText) || ADS_PRICE_PATTERN.test(normalizedText)) {
      addPositive('transaction:price', 24);
      hasPrice = true;
      hasTransactional = true;
    }

    if (ADS_TRANSACTIONAL_PATTERN.test(normalizedText)) {
      addPositive('transaction:keywords', 10);
      hasTransactional = true;
    }

    const contactHits = ADS_CONTACT_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of contactHits.slice(0, 2)) {
      addPositive(`contact:${marker}`, 16);
      hasContact = true;
    }

    if (ADS_PHONE_PATTERN.test(rawLoweredText) || ADS_PHONE_PATTERN.test(normalizedText)) {
      addPositive('contact:phone', 18);
      hasContact = true;
    }

    if (ADS_LINK_PATTERN.test(rawLoweredText)) {
      addPositive('deal-channel:link', 18);
      hasDealChannel = true;
    }

    if (ADS_URGENCY_PATTERN.test(normalizedText)) {
      addPositive('booster:urgency', 9);
    }

    if (ADS_QUANTITY_PATTERN.test(normalizedText)) {
      addPositive('booster:quantity', 8);
    }

    for (const marker of ADS_NEGATIVE_MARKERS) {
      if (!hasMarker(marker)) {
        continue;
      }

      addNegative(`negative:${marker}`, 24, true);
    }

    for (const marker of ADS_QUESTION_CONTEXT_MARKERS) {
      if (!hasMarker(marker)) {
        continue;
      }

      addNegative(`context:${marker}`, 18, true);
    }

    if (rawLoweredText.includes('?') && !hasPrice && !hasContact) {
      addNegative('context:question', 10);
    }

    if (hasIntent && (hasPrice || hasContact || hasDealChannel)) {
      addPositive('combo:intent+deal', 15);
    }

    if (hasContact && hasPrice) {
      addPositive('combo:contact+price', 8);
    }

    return {
      score,
      matchedSignals: [...new Set(matchedSignals)],
      negativeSignals: [...new Set(negativeSignals)],
      hasIntent,
      hasPrice,
      hasContact,
      hasDealChannel,
      hasTransactional,
      hasStrongNegativeContext,
    };
  }

  private normalizeForDetection(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = value.toLowerCase();
    normalized = this.normalizeMixedWriting(normalized);
    normalized = normalized.replace(/([a-zа-яё0-9])\1{2,}/giu, '$1$1');
    normalized = normalized.replace(/[_*~`"'«»“”(){}[[]\]|]+/g, ' ');
    normalized = normalized.replace(/[^\p{L}\p{N}\s:/?.,&%+-]/gu, ' ');
    normalized = normalized.replace(/\s+/g, ' ').trim();
    return normalized;
  }

  private normalizeForProfanity(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = value.toLowerCase();
    normalized = this.normalizeMixedWriting(normalized);
    normalized = normalized.replace(/ё/g, 'е');
    normalized = normalized.replace(/([a-zа-я0-9])\1{2,}/giu, '$1$1');
    normalized = normalized.replace(/[_*~`"'«»“”(){}[[]\]|]+/g, ' ');
    normalized = normalized.replace(/[^\p{L}\p{N}\s]+/gu, ' ');
    normalized = normalized.replace(/\s+/g, ' ').trim();
    return normalized;
  }

  private normalizeMixedWriting(value: string): string {
    let result = '';
    for (const char of value) {
      result += MIXED_CHAR_MAP[char] ?? char;
    }
    return result;
  }

  private extractTokens(value: string): string[] {
    const normalized = this.normalizeForDetection(value);
    return normalized.match(/[a-zа-яё0-9]+/giu) ?? [];
  }

  private extractProfanityTokens(value: string): string[] {
    return value.match(/[a-zа-яё0-9]+/giu) ?? [];
  }
}
