import { getUrlTextRanges } from '../common/url-text.util';

// FLAG: This is deliberately stricter than phone blocking. Erasing an ambiguous number or
// using it as a phone-only duplicate match can authorize deletion of a different message.
export const DUPLICATE_PHONE_EVIDENCE_VERSION = 4;

// FLAG: A period followed by spacing starts another phrase. Never erase its numeric content
// as part of the phone; dots without spacing remain conventional phone separators.
const CANDIDATE = /(?:^|[^\d+])(\+?\d(?:[\d \t()-]|\.(?![ \t])){7,}\d)(?=$|[^\d])/gu;
// FLAG: Bounded phone labels must never classify product names or bell/mobility words.
const PHONE_CONTEXT =
  /(?:^|[^\p{L}\p{N}_])(?:тел|телефон(?:а|у|ом|е|ы|ов|ам|ами|ах)?|звоните|позвоните|звони|позвони|звонить|позвонить|whatsapp|ватсап|viber|вайбер|phone|telephone|call)\s*(?:для\s+связи\s*)?[:=№#.-]?\s*$/iu;
// FLAG: Only this finite identifier phrase is itself a phone label. Product/order codes
// containing a phone noun remain identifiers, even beside an otherwise valid phone label.
const PHONE_NUMBER_CONTEXT =
  /(?:^|[^\p{L}\p{N}_])номер(?:а|у|ом|е|ов|ам|ами|ах)?\s+телефон(?:а|у|ом|е|ы|ов|ам|ами|ах)?\s*(?:для\s+связи\s*)?[:=№#.-]?\s*$/iu;
const IDENTIFIER_CONTEXT =
  /(?:номер(?:а|у|ом|е|ов|ам|ами|ах)?|код(?:а|у|ом|е|ы|ов|ам|ами|ах)?|идентификатор(?:а|у|ом|е|ы|ов|ам|ами|ах)?|артикул(?:а|у|ом|е|ы|ов|ам|ами|ах)?|инн|кпп|огрн|сч[её]т|заказ\p{L}*|накладн\p{L}*|договор\p{L}*|документ\p{L}*|кадастр\p{L}*|серийн\p{L}*|order|invoice|account|sku|part|identifier|number|id)(?:\s+[\p{L}]+){0,2}\s*[:=№#.-]?\s*$/iu;
const QUANTITY_PREFIX =
  /(?:цен\p{L}*|стоимост\p{L}*|сумм\p{L}*|бюджет\p{L}*|оплат\p{L}*|баланс\p{L}*|остат[оа]к\p{L}*|средств\p{L}*|температур\p{L}*|вес\p{L}*|масс\p{L}*|длин\p{L}*|площад\p{L}*|объ[её]м\p{L}*|price|cost|total|amount|balance|weight|length|temperature)(?:\s+[\p{L}]+){0,2}\s*[:=]?\s*$/iu;
const QUANTITY_SUFFIX =
  /^\s*(?:\p{Sc}|%|руб\p{L}*|р\.|коп\p{L}*|usd|eur|rub|rubles?|dollars?|тыс\.?|тысяч\p{L}*|млн|миллион\p{L}*|млрд|миллиард\p{L}*|кг|мг|грамм\p{L}*|тонн\p{L}*|т\.?|метр\p{L}*|мм|см|км|м[²³]?|литр\p{L}*|мл|л|градус\p{L}*|°[cfс]?|ватт\p{L}*|вт|квт|час\p{L}*|минут\p{L}*|секунд\p{L}*|шт\.?|штук\p{L}*|человек\p{L}*|людей|участник\p{L}*|people|persons?|participants?|pieces?|items?|байт\p{L}*|бит\p{L}*|[кмгт]б|(?:кило|мега|гига|тера)байт\p{L}*|bytes?|bps|[kmgt]i?(?:b|bps|bits?))(?![\p{L}\p{N}])/iu;
const PROTECTED_LABEL_IN_CLAUSE =
  /(?:^|[^\p{L}\p{N}_])(?:номер(?:а|у|ом|е|ов|ам|ами|ах)?|код(?:а|у|ом|е|ы|ов|ам|ами|ах)?|идентификатор(?:а|у|ом|е|ы|ов|ам|ами|ах)?|артикул(?:а|у|ом|е|ы|ов|ам|ами|ах)?|инн|кпп|огрн|сч[её]т|заказ\p{L}*|накладн\p{L}*|договор\p{L}*|документ\p{L}*|кадастр\p{L}*|серийн\p{L}*|цен\p{L}*|стоимост\p{L}*|сумм\p{L}*|бюджет\p{L}*|оплат\p{L}*|баланс\p{L}*|остат[оа]к\p{L}*|средств\p{L}*|температур\p{L}*|вес\p{L}*|масс\p{L}*|длин\p{L}*|площад\p{L}*|объ[её]м\p{L}*|размер\p{L}*|диапазон\p{L}*|order|invoice|account|sku|part|identifier|number|id|price|cost|total|amount|balance|weight|length|temperature|range|size|dimensions)(?![\p{L}\p{N}_])/iu;

function hasProtectedValueContext(before: string, after: string): boolean {
  const clause = before.split(/[.!?;,\n\r\u2028\u2029]/u).at(-1) ?? '';
  const phoneNumberLabel = PHONE_NUMBER_CONTEXT.test(before);
  const protectedClause = clause.replace(PHONE_NUMBER_CONTEXT, ' ');
  return (
    QUANTITY_PREFIX.test(before) ||
    QUANTITY_SUFFIX.test(after) ||
    (IDENTIFIER_CONTEXT.test(before) && !phoneNumberLabel) ||
    PROTECTED_LABEL_IN_CLAUSE.test(protectedClause)
  );
}

function hasLabelledPhoneListContinuation(before: string, after: string): boolean {
  if (!PHONE_CONTEXT.test(before)) return false;
  const next = after.matchAll(CANDIDATE).next().value;
  if (!next) return false;
  const candidate = next[1]!;
  const start = next.index + next[0].length - candidate.length;
  // FLAG: A plus begins a phone list only after a finite phone label and a complete,
  // independently valid next phone. Empty context prevents recursive list authority.
  return (
    candidate.startsWith('+') &&
    /^[\s\p{Cf})\]}»"'”’]*$/u.test(after.slice(0, start)) &&
    phoneEvidence(candidate, '', after.slice(start + candidate.length)) !== null
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

function hasEmbeddedIdentifierAdjacency(before: string, after: string): boolean {
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
  if (
    /^[\s\p{Cf})\]}»"'”’]*[\p{Sm}*/%^·-]+[\s\p{Cf}]*[\p{L}\p{M}\p{N}_]/u.test(after) &&
    !hasLabelledPhoneListContinuation(arithmeticBefore, after)
  )
    return true;
  if (
    !PHONE_CONTEXT.test(arithmeticBefore) &&
    (/[\p{Sm}*/%^·-]$/u.test(arithmeticBefore) ||
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

function isDuplicatePhoneCandidateInUrl(
  ranges: readonly { start: number; end: number }[],
  start: number,
  end: number,
): boolean {
  // FLAG: Shared URL ranges refer to original text offsets; never erase URL bytes as phones.
  return ranges.some((range) => start < range.end && end > range.start);
}

function phoneEvidence(candidate: string, before: string, after: string): string | null {
  if (hasEmbeddedIdentifierAdjacency(before, after)) return null;
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
  if (!knownLength && /[^\d+]/u.test(candidate)) return null;
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
  const labelled = PHONE_CONTEXT.test(before);
  if (!international && !labelled) return null;
  if (!international && digits.length === 11 && digits.startsWith('8'))
    return `7${digits.slice(1)}`;
  if (!international && digits.length === 10 && digits.startsWith('9')) return `7${digits}`;
  return digits;
}

export function extractDuplicatePhoneNumbers(text: string): string[] {
  const phones = new Set<string>();
  const urlRanges = getUrlTextRanges(text);
  for (const match of text.matchAll(CANDIDATE)) {
    const candidate = match[1]!;
    const start = match.index + match[0].length - candidate.length;
    if (isDuplicatePhoneCandidateInUrl(urlRanges, start, start + candidate.length)) continue;
    const phone = phoneEvidence(
      candidate,
      text.slice(Math.max(0, start - 128), start),
      text.slice(start + candidate.length, start + candidate.length + 64),
    );
    if (phone) phones.add(phone);
  }
  return [...phones];
}

export function stripDuplicatePhoneNumbers(text: string): string {
  const urlRanges = getUrlTextRanges(text);
  return text.replace(CANDIDATE, (match, candidate: string, index: number) => {
    const start = index + match.length - candidate.length;
    if (isDuplicatePhoneCandidateInUrl(urlRanges, start, start + candidate.length)) return match;
    const phone = phoneEvidence(
      candidate,
      text.slice(Math.max(0, start - 128), start),
      text.slice(start + candidate.length, start + candidate.length + 64),
    );
    // FLAG: The leading boundary belongs to surrounding prose, never to the phone.
    return phone ? `${match.slice(0, match.length - candidate.length)} ` : match;
  });
}
