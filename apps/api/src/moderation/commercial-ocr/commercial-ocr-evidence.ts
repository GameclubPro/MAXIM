import type { CommercialOcrCriticalEvidence } from './commercial-ocr-decision-policy';

export type CommercialOcrEvidenceWord = Readonly<{
  text: string;
  start: number;
  end: number;
  confidencePermille: number;
}>;

type EvidenceMatch = Readonly<{
  start: number;
  end: number;
  value: string;
}>;

type EvidencePattern = Readonly<{
  semanticKey: string;
  pattern: RegExp;
}>;

const COMMERCIAL_ANCHOR_PATTERNS: readonly EvidencePattern[] = [
  {
    semanticKey: 'offer:high-risk',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?<evidence>казин[оа-яё-]*|букмекер[а-яё-]*|фрибет[а-яё-]*|крипт[а-яё-]*|трейдинг|инвестиц[а-яё-]*|микрозайм[а-яё-]*|займ[а-яё-]*|кредит[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    semanticKey: 'offer:recruitment',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?<evidence>ваканси[а-яё-]*|требу(?:ется|ются)|ищем\s+(?:сотрудник[а-яё-]*|работник[а-яё-]*|специалист[а-яё-]*)|набор\s+(?:сотрудник[а-яё-]*|персонал[а-яё-]*)|зарплат[а-яё-]*|подработк[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    semanticKey: 'offer:services',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?<evidence>услуг[а-яё-]*|ремонт[а-яё-]*|монтаж[а-яё-]*|установк[а-яё-]*|строительств[а-яё-]*|перевозк[а-яё-]*|грузоперевозк[а-яё-]*|такси|маникюр[а-яё-]*|косметолог[а-яё-]*|репетитор[а-яё-]*|юрист[а-яё-]*|ри[еэ]лтор[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    semanticKey: 'offer:info-product',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?<evidence>курс[а-яё-]*|вебинар[а-яё-]*|марафон[а-яё-]*|обучени[а-яё-]*|интенсив[а-яё-]*|наставничеств[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    semanticKey: 'offer:retail',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?<evidence>интернет[\s-]*магазин[а-яё-]*|магазин[а-яё-]*|каталог[а-яё-]*|ассортимент[а-яё-]*|поставщик[а-яё-]*|производител[а-яё-]*|оптом|розниц[а-яё-]*|товар[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    semanticKey: 'offer:property',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?<evidence>недвижимост[а-яё-]*|квартир[а-яё-]*|дом[а-яё-]*|участок[а-яё-]*|аренд[а-яё-]*|сда[еёю][а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    semanticKey: 'offer:source-side',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?<evidence>прода(?:ю|ем|ём|ется|ётся)|предлага(?:ю|ем)|выкупа(?:ю|ем)|скупа(?:ю|ем)|закупа(?:ю|ем)|принима(?:ю|ем)\s+заказ[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    semanticKey: 'offer:promotion',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?<evidence>реклам[а-яё-]*|акци[а-яё-]*|скидк[а-яё-]*|прайс(?:[\s-]*лист)?|промокод[а-яё-]*|распродаж[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
];

const DEAL_CHANNEL_PATTERNS: readonly EvidencePattern[] = [
  {
    semanticKey: 'channel:response',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?<evidence>звоните?|пишите?|напишите?|обращайтесь|в\s+(?:лс|личк[а-яё-]*|директ)|whats?app|ватсап|telegram|телеграм|пишите?\s+в\s+(?:max|мах))(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    semanticKey: 'channel:order',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?<evidence>закаж(?:и|ите|ите\s+сейчас)|остав(?:ьте|ляйте)\s+заявк[а-яё-]*|записывайтесь|забронируйте|оформ(?:ить|ляйте)\s+заказ[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    semanticKey: 'channel:navigation',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?<evidence>переходите|подписывайтесь|ссылк[а-яё-]*\s+в\s+(?:профил[а-яё-]*|описани[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu,
  },
];

const TRANSACTION_PATTERNS: readonly EvidencePattern[] = [
  {
    semanticKey: 'transaction:payment',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?<evidence>оплат[а-яё-]*|предоплат[а-яё-]*|расч[её]т[а-яё-]*|комисси[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    semanticKey: 'transaction:order',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?<evidence>заказ[а-яё-]*|предзаказ[а-яё-]*|заявк[а-яё-]*|брон[ьи][а-яё-]*|регистраци[а-яё-]*|анкет[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    semanticKey: 'transaction:fulfilment',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?<evidence>доставк[а-яё-]*|достав(?:им|лю)|в\s+наличи[а-яё-]*|самовывоз[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    semanticKey: 'transaction:price-term',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?<evidence>цен(?:а|ы|е|у|ой|ам|ами|ах)?|стоимост[а-яё-]*|прайс)(?=$|[^\p{L}\p{N}_-])/iu,
  },
];

const PHONE_PATTERN =
  /(?<![\d+])(?<evidence>(?:\+\d(?:[\s()./\\\u2010-\u2015-]*\d){6,14}|[78](?:[\s()./\\\u2010-\u2015-]*\d){10}))(?![\s()./\\\u2010-\u2015-]*\d)/u;
const EMAIL_PATTERN =
  /(?:^|[^\p{L}\p{N}_@])(?<evidence>[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})(?=$|[^\p{L}\p{N}_-])/iu;
const DOMAIN_PATTERN =
  /(?:^|[^\p{L}\p{N}_@-])(?:https?:\/\/)?(?:www\.)?(?<evidence>(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:ru|рф|com|net|org|su|shop|online|site|pro|io|app|ai))(?=$|[^\p{L}\p{N}_-])/iu;
const HANDLE_PATTERN = /(?:^|[^\p{L}\p{N}_@])(?<evidence>@[a-z0-9_]{4,32})(?=$|[^\p{L}\p{N}_])/iu;
const PRICE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?<evidence>(?:цен[а-яё-]*|стоимост[а-яё-]*|прайс)?[\s:=-]*(?:от\s+)?\d[\d\s.,]{1,12}\s*(?:₽|руб(?:\.|лей)?|р\.?|\u20b8|\$|€))(?=$|[^\p{L}\p{N}_-])/iu;

/**
 * Builds bounded, pass-comparable evidence tied to the confidence of the OCR words that produced it.
 */
export function deriveCommercialOcrCriticalEvidence(params: {
  text: string;
  words: readonly CommercialOcrEvidenceWord[];
}): CommercialOcrCriticalEvidence[] {
  if (!params.text || params.text.length > 8_000 || params.words.length === 0) {
    return [];
  }
  const words = validateWords(params.text, params.words);
  if (!words) {
    return [];
  }

  const evidence: CommercialOcrCriticalEvidence[] = [];
  addPatternEvidence(evidence, 'commercial_anchor', params.text, words, COMMERCIAL_ANCHOR_PATTERNS);

  const contact = firstSupportedMatch(params.text, words, [
    { pattern: PHONE_PATTERN, semanticKey: normalizePhoneSemanticKey },
    { pattern: EMAIL_PATTERN, semanticKey: (value) => `email:${value.toLowerCase()}` },
    { pattern: DOMAIN_PATTERN, semanticKey: (value) => `domain:${value.toLowerCase()}` },
    { pattern: HANDLE_PATTERN, semanticKey: (value) => `handle:${value.toLowerCase()}` },
  ]);
  if (contact) {
    evidence.push({
      kind: 'contact',
      semanticKey: contact.semanticKey,
      confidencePermille: contact.confidencePermille,
    });
  }

  addPatternEvidence(evidence, 'deal_channel', params.text, words, DEAL_CHANNEL_PATTERNS);

  const priceMatch = findEvidenceMatch(PRICE_PATTERN, params.text);
  const priceConfidence = priceMatch ? confidenceForMatch(params.text, words, priceMatch) : null;
  if (priceMatch && priceConfidence !== null) {
    evidence.push({
      kind: 'price',
      semanticKey: normalizePriceSemanticKey(priceMatch.value),
      confidencePermille: priceConfidence,
    });
  }

  addPatternEvidence(evidence, 'transaction', params.text, words, TRANSACTION_PATTERNS);
  return evidence;
}

function addPatternEvidence(
  target: CommercialOcrCriticalEvidence[],
  kind: CommercialOcrCriticalEvidence['kind'],
  text: string,
  words: readonly CommercialOcrEvidenceWord[],
  patterns: readonly EvidencePattern[],
): void {
  for (const entry of patterns) {
    const match = findEvidenceMatch(entry.pattern, text);
    const confidencePermille = match ? confidenceForMatch(text, words, match) : null;
    if (match && confidencePermille !== null) {
      target.push({ kind, semanticKey: entry.semanticKey, confidencePermille });
      return;
    }
  }
}

function firstSupportedMatch(
  text: string,
  words: readonly CommercialOcrEvidenceWord[],
  patterns: readonly Readonly<{
    pattern: RegExp;
    semanticKey: (value: string) => string;
  }>[],
): { semanticKey: string; confidencePermille: number } | null {
  for (const entry of patterns) {
    const match = findEvidenceMatch(entry.pattern, text);
    const confidencePermille = match ? confidenceForMatch(text, words, match) : null;
    if (match && confidencePermille !== null) {
      return { semanticKey: entry.semanticKey(match.value), confidencePermille };
    }
  }
  return null;
}

function findEvidenceMatch(pattern: RegExp, text: string): EvidenceMatch | null {
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  pattern.lastIndex = 0;
  const value = match?.groups?.evidence;
  if (!match || !value) {
    return null;
  }
  const relativeStart = match[0].indexOf(value);
  const start = match.index + relativeStart;
  return { start, end: start + value.length, value };
}

function confidenceForMatch(
  text: string,
  words: readonly CommercialOcrEvidenceWord[],
  match: EvidenceMatch,
): number | null {
  const overlappingWords = words.filter((word) => word.start < match.end && word.end > match.start);
  if (overlappingWords.length === 0) {
    return null;
  }

  for (const token of text.slice(match.start, match.end).matchAll(/[\p{L}\p{N}@]+/gu)) {
    const tokenStart = match.start + (token.index ?? 0);
    const tokenEnd = tokenStart + token[0].length;
    if (!overlappingWords.some((word) => word.start < tokenEnd && word.end > tokenStart)) {
      return null;
    }
  }
  return Math.min(...overlappingWords.map((word) => word.confidencePermille));
}

function validateWords(
  text: string,
  words: readonly CommercialOcrEvidenceWord[],
): readonly CommercialOcrEvidenceWord[] | null {
  let previousEnd = 0;
  for (const word of words) {
    if (
      !word ||
      typeof word.text !== 'string' ||
      word.text.length === 0 ||
      !Number.isSafeInteger(word.start) ||
      !Number.isSafeInteger(word.end) ||
      word.start < previousEnd ||
      word.end <= word.start ||
      word.end > text.length ||
      text.slice(word.start, word.end) !== word.text ||
      !Number.isSafeInteger(word.confidencePermille) ||
      word.confidencePermille < 0 ||
      word.confidencePermille > 1_000
    ) {
      return null;
    }
    previousEnd = word.end;
  }
  return words;
}

function normalizePhoneSemanticKey(value: string): string {
  let digits = value.replace(/\D/gu, '');
  if (digits.length === 11 && digits.startsWith('8')) {
    digits = `7${digits.slice(1)}`;
  }
  return `phone:${digits}`;
}

function normalizePriceSemanticKey(value: string): string {
  const digits = value.replace(/\D/gu, '').replace(/^0+(?=\d)/u, '');
  const lowered = value.toLowerCase();
  const currency = /(?:₽|руб|(?:^|\s)р\.?\s*$)/iu.test(lowered)
    ? 'rub'
    : /₸/u.test(lowered)
      ? 'kzt'
      : /\$/u.test(lowered)
        ? 'usd'
        : 'eur';
  return `amount:${digits}:${currency}`;
}
