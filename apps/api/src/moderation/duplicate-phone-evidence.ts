import { getUrlTextRanges } from '../common/url-text.util';
import {
  hasDuplicateQuantityUnitPrefix,
  hasDuplicateQuantityUnitSuffix,
} from './duplicate-semantic-text';

// FLAG: This is deliberately stricter than phone blocking. Erasing an ambiguous number or
// using it as a phone-only duplicate match can authorize deletion of a different message.
export const DUPLICATE_PHONE_EVIDENCE_VERSION = 8;

// FLAG: A period followed by spacing starts another phrase. Never erase its numeric content
// as part of the phone; dots without spacing remain conventional phone separators.
const CANDIDATE =
  /(?:^|[^\d+])(\+?\d(?:[\d \t()\u00a0\u202f\u2010-\u2013-]|\.(?![ \t\u00a0\u202f])){7,}\d)(?=$|[^\d])/gu;
const CONTEXT_CLAUSE_BOUNDARY = /[.!?;,\n\r\u2028\u2029]/u;
const UNFINISHED_RIGHT_CONTEXT = /^[\s\p{Cf})\]}»"'”’\p{Sm}*/%^·:\u2010-\u2013-]*$/u;
// FLAG: Bounded phone labels must never classify product names or bell/mobility words.
const PHONE_CONTEXT =
  /(?:^|[^\p{L}\p{N}_])(?:тел|телефон(?:а|у|ом|е|ы|ов|ам|ами|ах)?|звоните|позвоните|звони|позвони|звонить|позвонить|связаться|свяжитесь|whatsapp|ватсап|viber|вайбер|phone|telephone|call)\s*(?:для\s+связи\s*)?[:=№#.-]?\s*$/iu;
// FLAG: Only this finite identifier phrase is itself a phone label. Product/order codes
// containing a phone noun remain identifiers, even beside an otherwise valid phone label.
const PHONE_NUMBER_CONTEXT =
  /(?:^|[^\p{L}\p{N}_])номер(?:а|у|ом|е|ов|ам|ами|ах)?\s+телефон(?:а|у|ом|е|ы|ов|ам|ами|ах)?\s*(?:для\s+связи\s*)?[:=№#.-]?\s*$/iu;
const IDENTIFIER_CONTEXT =
  /(?:номер(?:а|у|ом|е|ов|ам|ами|ах)?|код(?:а|у|ом|е|ы|ов|ам|ами|ах)?|идентификатор(?:а|у|ом|е|ы|ов|ам|ами|ах)?|артикул(?:а|у|ом|е|ы|ов|ам|ами|ах)?|модел(?:ь|и|ью|ей|ям|ями|ях)|сертификат(?:а|у|ом|е|ы|ов|ам|ами|ах)?|штрих[- ]?код(?:а|у|ом|е|ы|ов|ам|ами|ах)?|model|certificate|barcode|imei|ean|gtin|инн|кпп|огрн|сч[её]т|заказ\p{L}*|накладн\p{L}*|договор\p{L}*|документ\p{L}*|кадастр\p{L}*|серийн\p{L}*|order|invoice|account|sku|part|identifier|number|id)(?:\s+[\p{L}]+){0,2}\s*[:=№#.-]?\s*$/iu;
const QUANTITY_PREFIX =
  /(?:цен\p{L}*|стоимост\p{L}*|сумм\p{L}*|бюджет\p{L}*|оплат\p{L}*|баланс\p{L}*|остат[оа]к\p{L}*|средств\p{L}*|температур\p{L}*|вес\p{L}*|масс\p{L}*|длин\p{L}*|площад\p{L}*|объ[её]м\p{L}*|price|cost|total|amount|balance|weight|length|temperature)(?:\s+[\p{L}]+){0,2}\s*[:=]?\s*$/iu;
const QUANTITY_SUFFIX =
  /^\s*(?:\p{Sc}|%|руб\p{L}*|р\.|коп\p{L}*|usd|eur|rub|rubles?|dollars?|тыс\.?|тысяч\p{L}*|млн|миллион\p{L}*|млрд|миллиард\p{L}*|кг|мг|грамм\p{L}*|тонн\p{L}*|т\.?|метр\p{L}*|мм|см|км|м[²³]?|литр\p{L}*|мл|л|градус\p{L}*|°[cfс]?|ватт\p{L}*|вт|квт|час\p{L}*|минут\p{L}*|секунд\p{L}*|шт\.?|штук\p{L}*|человек\p{L}*|людей|участник\p{L}*|people|persons?|participants?|pieces?|items?|байт\p{L}*|бит\p{L}*|[кмгт]б|(?:кило|мега|гига|тера)байт\p{L}*|bytes?|bps|[kmgt]i?(?:b|bps|bits?))(?![\p{L}\p{N}])/iu;
const PROTECTED_LABEL_IN_CLAUSE =
  /(?:^|[^\p{L}\p{N}_])(?:номер(?:а|у|ом|е|ов|ам|ами|ах)?|код(?:а|у|ом|е|ы|ов|ам|ами|ах)?|идентификатор(?:а|у|ом|е|ы|ов|ам|ами|ах)?|артикул(?:а|у|ом|е|ы|ов|ам|ами|ах)?|модел(?:ь|и|ью|ей|ям|ями|ях)|сертификат(?:а|у|ом|е|ы|ов|ам|ами|ах)?|штрих[- ]?код(?:а|у|ом|е|ы|ов|ам|ами|ах)?|model|certificate|barcode|imei|ean|gtin|инн|кпп|огрн|сч[её]т|заказ\p{L}*|накладн\p{L}*|договор\p{L}*|документ\p{L}*|кадастр\p{L}*|серийн\p{L}*|цен\p{L}*|стоимост\p{L}*|сумм\p{L}*|бюджет\p{L}*|оплат\p{L}*|баланс\p{L}*|остат[оа]к\p{L}*|средств\p{L}*|температур\p{L}*|вес\p{L}*|масс\p{L}*|длин\p{L}*|площад\p{L}*|объ[её]м\p{L}*|размер\p{L}*|диапазон\p{L}*|order|invoice|account|sku|part|identifier|number|id|price|cost|total|amount|balance|weight|length|temperature|range|size|dimensions)(?![\p{L}\p{N}_])/iu;

function hasProtectedValueContext(before: string, after: string): boolean {
  const clause = before.split(/[.!?;,\n\r\u2028\u2029]/u).at(-1) ?? '';
  const phoneNumberLabel = PHONE_NUMBER_CONTEXT.test(before);
  const phoneLabel = PHONE_CONTEXT.exec(before);
  const protectedClause = clause.replace(PHONE_NUMBER_CONTEXT, ' ');
  return (
    QUANTITY_PREFIX.test(before) ||
    QUANTITY_SUFFIX.test(after) ||
    hasDuplicateQuantityUnitSuffix(after) ||
    hasDuplicateQuantityUnitPrefix(before) ||
    (phoneLabel !== null && hasDuplicateQuantityUnitPrefix(before.slice(0, phoneLabel.index))) ||
    (IDENTIFIER_CONTEXT.test(before) && !phoneNumberLabel) ||
    PROTECTED_LABEL_IN_CLAUSE.test(protectedClause)
  );
}

function hasLabelledPhoneListContinuation(
  before: string,
  after: string,
  afterTruncated: boolean,
): boolean {
  if (!PHONE_CONTEXT.test(before)) return false;
  const next = after.matchAll(CANDIDATE).next().value;
  if (!next) return false;
  const candidate = next[1]!;
  const start = next.index + next[0].length - candidate.length;
  // FLAG: A plus begins a phone list only after a finite phone label and a complete,
  // independently valid next phone. Keep the finite source label for that bounded proof;
  // an unlabelled signed operand must never gain authority from another positive number.
  return (
    candidate.startsWith('+') &&
    /^[\s\p{Cf})\]}»"'”’]*$/u.test(after.slice(0, start)) &&
    phoneEvidence(candidate, before, after.slice(start + candidate.length), afterTruncated) !== null
  );
}

function hasLabelledPhoneListPredecessor(before: string): boolean {
  const previous = [...before.matchAll(CANDIDATE)].at(-1);
  if (!previous) return false;
  const candidate = previous[1]!;
  const start = previous.index + previous[0].length - candidate.length;
  const prefix = before.slice(0, start);
  // FLAG: A long signed operand cannot become a phone merely by following another
  // number. Preserve independent phone lists only with the actual finite source label.
  return (
    PHONE_CONTEXT.test(prefix.replace(/[\s([{«"'“‘]+$/u, ' ')) &&
    /^\s*$/u.test(before.slice(start + candidate.length)) &&
    phoneEvidence(candidate, prefix, '') !== null
  );
}

function hasEmbeddedIdentifierAdjacency(
  before: string,
  after: string,
  afterTruncated: boolean,
): boolean {
  // FLAG: Preserve whitespace boundaries before examining compact identifier affixes.
  // A true phone label may adjoin the left side; no label excuses a right identifier suffix.
  const protocolBefore = before.replace(/[\p{Cf}()[\]{}«»"'“‘”’]+$/u, '');
  if (/(?:^|[^\p{L}\p{N}_])(?:tel|mailto|sms|callto|sips?):$/iu.test(protocolBefore)) return true;
  if (/@[^\s]*$/u.test(before) || /^[^\s]*@/u.test(after)) return true;
  // FLAG: Currency prefixes and right arithmetic operands are quantities even with a
  // phone label. Unicode math symbols include comparisons and non-ASCII operators.
  const arithmeticContext = before.replace(/\p{Cf}/gu, '');
  const arithmeticBefore = arithmeticContext.replace(/[\s([{«"'“‘]+$/u, '');
  if (/\p{Sc}$/u.test(arithmeticBefore)) return true;
  // FLAG: A colon can bind a ratio/code/quantity, but a complete prose note after a
  // real phone remains admissible. Never guess a word cut by the right context budget.
  const colon = /^[\s\p{Cf})\]}»"'”’]*:[\s\p{Cf}]*/u.exec(after);
  if (colon) {
    const value = after.slice(colon[0].length).replace(/\p{Cf}/gu, '');
    if (
      QUANTITY_SUFFIX.test(value) ||
      hasDuplicateQuantityUnitSuffix(value) ||
      /^[\p{N}_]|^\p{L}\p{M}*(?=$|[^\p{L}\p{M}\p{N}_])/u.test(value) ||
      (afterTruncated && !/[\s.!?;,\n\r\u2028\u2029]/u.test(value))
    )
      return true;
  }
  if (
    /^[\s\p{Cf})\]}»"'”’]*[\p{Sm}*/%^·\u2010-\u2013-]+[\s\p{Cf}]*[\p{L}\p{M}\p{N}_]/u.test(after) &&
    !hasLabelledPhoneListContinuation(arithmeticBefore, after, afterTruncated)
  )
    return true;
  if (
    !PHONE_CONTEXT.test(arithmeticBefore) &&
    (/[\p{Sm}*/%^·\u2010-\u2013-]$/u.test(arithmeticBefore) ||
      /(?:^|\s)(?:\p{L}\p{M}*|\p{N}{1,6}|_)\s+$/u.test(arithmeticContext))
  )
    return true;
  if (
    /(?:^|\s)[+-]?\d(?:[\d \t().-]*\d)?\s+$/u.test(arithmeticContext) &&
    !hasLabelledPhoneListPredecessor(arithmeticContext)
  )
    return true;
  const left = before.replace(/[^\s\p{L}\p{M}\p{N}_]+$/u, '');
  const right = after.replace(/^[^\s\p{L}\p{M}\p{N}_]+/u, '');
  const label = PHONE_CONTEXT.exec(left);
  const labelled =
    label !== null &&
    (label.index === 0 || /^\s/u.test(label[0]) || /\s$/u.test(left.slice(0, label.index)));
  return (/[\p{L}\p{M}\p{N}_]$/u.test(left) && !labelled) || /^[\p{L}\p{M}\p{N}_]/u.test(right);
}

function phoneEvidence(
  candidate: string,
  before: string,
  after: string,
  afterTruncated = false,
): string | null {
  // FLAG: Padding, wrappers or an unfinished operand must not hide a unit/email/expression
  // beyond the bounded view. A recursive list proof also needs a complete right boundary.
  if (afterTruncated && UNFINISHED_RIGHT_CONTEXT.test(after)) return null;
  if (hasEmbeddedIdentifierAdjacency(before, after, afterTruncated)) return null;
  // FLAG: Wrappers must not hide an explicit order/part/quantity label. Only bounded
  // adjacent context is inspected; numeric payloads and surrounding prose remain intact.
  // FLAG: Format controls affect only bounded context detection, never the original text.
  before = before.replace(/\p{Cf}/gu, '').replace(/[\s:=№#.\-([{«"'“‘]+$/u, ' ');
  after = after.replace(/\p{Cf}/gu, '').replace(/^[\s)\]}»"'”’]+/u, ' ');
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15 || hasProtectedValueContext(before, after))
    return null;
  // FLAG: Grouping alone cannot distinguish a phone from an order/model/version identifier.
  // Require an explicit phone label or an international + prefix with nonzero country digits.
  const international = candidate.startsWith('+') && /^[1-9]\d{9,14}$/u.test(digits);
  // FLAG: A greedy span must not absorb bare quantities into known-length phones.
  // Country-prefixed 1/7 forms use eleven total digits; national 8/9 use eleven/ten.
  if (/^[17]/u.test(digits) && digits.length !== 11) return null;
  if (!international && digits.startsWith('8') && digits.length !== 11) return null;
  if (!international && digits.startsWith('9') && digits.length !== 10) return null;
  // FLAG: Unknown-length grouped spans cannot prove where a phone ends and a quantity
  // begins. Preserve the whole candidate instead of guessing a country plan or prefix.
  const knownLength =
    (/^[17]/u.test(digits) && digits.length === 11) ||
    (!international && digits.startsWith('8') && digits.length === 11) ||
    (!international && digits.startsWith('9') && digits.length === 10);
  // FLAG: A phone noun cannot prove an arbitrary compact EAN/document number. Without
  // an international + prefix only the known 1/7 and national 8/9 forms are admissible.
  if (!international && !knownLength) return null;
  if (!knownLength && /[^\d+]/u.test(candidate)) return null;
  const labelled = PHONE_CONTEXT.test(before) || hasLabelledPhoneListPredecessor(before);
  // FLAG: Additional typographic separators are phones only with a finite source label
  // and a known complete length; they must not broaden signed identifiers or arithmetic.
  if (/[\u00a0\u202f\u2010-\u2013]/u.test(candidate) && (!knownLength || !labelled)) return null;
  // FLAG: A signed decimal is not phone evidence. Dotted phones require known, finite
  // group lengths; preserving every other dotted span costs only an approximate match.
  if (candidate.includes('.')) {
    const groups = candidate
      .match(/\d+/gu)
      ?.map((group) => group.length)
      .join('/');
    const conventionalGroups =
      (digits.length === 11 && ['1/3/3/2/2', '1/3/3/4'].includes(groups ?? '')) ||
      (digits.length === 10 && groups === '3/3/2/2');
    if (!knownLength || !conventionalGroups) return null;
  }
  // FLAG: A compact international + prefix is also an ordinary signed quantity. Only
  // a finite phone label/list or conventional known-country grouping grants phone authority.
  if (!labelled && !hasConventionalInternationalPhoneFormat(candidate)) return null;
  if (!international && digits.length === 11 && digits.startsWith('8'))
    return `7${digits.slice(1)}`;
  if (!international && digits.length === 10 && digits.startsWith('9')) return `7${digits}`;
  return digits;
}

function hasConventionalInternationalPhoneFormat(candidate: string): boolean {
  return /^\+[17](?:\s*\(\d{3}\)\s*\d{3}(?:-\d{2}-\d{2}|-\d{4})|[ .-]\d{3}[ .-]\d{3}(?:[ .-]\d{2}[ .-]\d{2}|[ .-]\d{4}))$/u.test(
    candidate,
  );
}

type TextRange = { start: number; end: number };

export type DuplicatePhoneAnalysis = {
  phoneNumbers: string[];
  phoneRanges: TextRange[];
  urlRanges: TextRange[];
  urlValues: string[];
};

function mergeTextRanges(left: readonly TextRange[], right: readonly TextRange[]): TextRange[] {
  const merged: TextRange[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const next =
      rightIndex >= right.length ||
      (leftIndex < left.length && left[leftIndex]!.start <= right[rightIndex]!.start)
        ? left[leftIndex++]!
        : right[rightIndex++]!;
    const previous = merged.at(-1);
    if (previous && next.start <= previous.end) previous.end = Math.max(previous.end, next.end);
    else merged.push({ ...next });
  }
  return merged;
}

export function analyzeDuplicatePhoneNumbers(text: string): DuplicatePhoneAnalysis {
  const phones = new Set<string>();
  const phoneRanges: TextRange[] = [];
  const urlRanges = getUrlTextRanges(text);
  const urlValues = [
    ...new Set(
      urlRanges.map((range) => text.slice(range.start, range.end).replace(/\p{Cf}+/gu, '')),
    ),
  ];
  let urlIndex = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const candidate = match[1]!;
    const start = match.index + match[0].length - candidate.length;
    const end = start + candidate.length;
    // FLAG: Shared URL ranges refer to original offsets. Both streams are ordered, so a
    // single cursor excludes URL overlap without multiplying phone and URL candidate counts.
    while (urlIndex < urlRanges.length && urlRanges[urlIndex]!.end <= start) urlIndex += 1;
    if (urlIndex < urlRanges.length && urlRanges[urlIndex]!.start < end) continue;
    const beforeStart = Math.max(0, start - 128);
    const before = text.slice(beforeStart, start);
    // FLAG: An unfinished long clause may hide an identifier/price label just outside the
    // view. Preserve the candidate when the bounded context cannot prove its left boundary.
    if (beforeStart > 0 && !CONTEXT_CLAUSE_BOUNDARY.test(before)) continue;
    const phone = phoneEvidence(
      candidate,
      before,
      text.slice(end, end + 64),
      end + 64 < text.length,
    );
    if (phone) {
      phones.add(phone);
      phoneRanges.push({ start, end });
    }
  }
  return { phoneNumbers: [...phones], phoneRanges, urlRanges, urlValues };
}

export function stripAnalyzedDuplicatePhoneNumbers(
  text: string,
  analysis: DuplicatePhoneAnalysis,
  options: { ignorePhones: boolean; ignoreLinks: boolean } = {
    ignorePhones: true,
    ignoreLinks: false,
  },
): string {
  const ranges = mergeTextRanges(
    options.ignorePhones ? analysis.phoneRanges : [],
    options.ignoreLinks ? analysis.urlRanges : [],
  );
  if (ranges.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    // FLAG: The leading boundary belongs to surrounding prose, never to the phone.
    parts.push(text.slice(cursor, range.start), ' ');
    cursor = range.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

export function extractDuplicatePhoneNumbers(text: string): string[] {
  return analyzeDuplicatePhoneNumbers(text).phoneNumbers;
}

export function stripDuplicatePhoneNumbers(text: string): string {
  return stripAnalyzedDuplicatePhoneNumbers(text, analyzeDuplicatePhoneNumbers(text));
}
