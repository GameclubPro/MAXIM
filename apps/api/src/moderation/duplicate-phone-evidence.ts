// FLAG: This is deliberately stricter than phone blocking. Erasing an ambiguous number or
// using it as a phone-only duplicate match can authorize deletion of a different message.
export const DUPLICATE_PHONE_EVIDENCE_VERSION = 2;

// FLAG: A period followed by spacing starts another phrase. Never erase its numeric content
// as part of the phone; dots without spacing remain conventional phone separators.
const CANDIDATE = /(?:^|[^\d+])(\+?\d(?:[\d \t()-]|\.(?![ \t])){7,}\d)(?=$|[^\d])/gu;
// FLAG: Bounded phone labels must never classify product names or bell/mobility words.
const PHONE_CONTEXT =
  /(?:^|[^\p{L}\p{N}_])(?:тел|телефон(?:а|у|ом|е|ы|ов|ам|ами|ах)?|звоните|позвоните|звони|позвони|звонить|позвонить|whatsapp|ватсап|viber|вайбер|phone|telephone|call)\s*(?:для\s+связи\s*)?[:=№#.-]?\s*$/iu;
const IDENTIFIER_CONTEXT =
  /(?:номер|код|идентификатор|артикул|инн|кпп|огрн|сч[её]т|заказ\p{L}*|накладн\p{L}*|договор\p{L}*|документ\p{L}*|кадастр\p{L}*|серийн\p{L}*|order|invoice|account|sku|part|identifier|number|id)(?:\s+[\p{L}]+){0,2}\s*[:=№#.-]?\s*$/iu;
const QUANTITY_PREFIX =
  /(?:цен\p{L}*|стоимост\p{L}*|сумм\p{L}*|бюджет\p{L}*|оплат\p{L}*|температур\p{L}*|вес\p{L}*|масс\p{L}*|длин\p{L}*|площад\p{L}*|объ[её]м\p{L}*|price|cost|total|amount|weight|length|temperature)(?:\s+[\p{L}]+){0,2}\s*[:=]?\s*$/iu;
const QUANTITY_SUFFIX =
  /^\s*(?:₽|\$|€|£|%|руб\p{L}*|р\.|коп\p{L}*|usd|eur|rub|rubles?|dollars?|млн|миллион\p{L}*|млрд|миллиард\p{L}*|кг|мг|грамм\p{L}*|тонн\p{L}*|метр\p{L}*|мм|см|км|м[²³]?|литр\p{L}*|мл|л|градус\p{L}*|°[cfс]?|ватт\p{L}*|вт|квт|час\p{L}*|минут\p{L}*|секунд\p{L}*|шт\.?)(?![\p{L}\p{N}])/iu;
const PROTECTED_LABEL_IN_CLAUSE =
  /(?:^|[^\p{L}\p{N}_])(?:номер|код|идентификатор|артикул|инн|кпп|огрн|сч[её]т|заказ\p{L}*|накладн\p{L}*|договор\p{L}*|документ\p{L}*|кадастр\p{L}*|серийн\p{L}*|цен\p{L}*|стоимост\p{L}*|сумм\p{L}*|бюджет\p{L}*|оплат\p{L}*|температур\p{L}*|вес\p{L}*|масс\p{L}*|длин\p{L}*|площад\p{L}*|объ[её]м\p{L}*|размер\p{L}*|диапазон\p{L}*|order|invoice|account|sku|part|identifier|number|id|price|cost|total|amount|weight|length|temperature|range|size|dimensions)(?![\p{L}\p{N}_])/iu;

function hasProtectedValueContext(before: string, after: string): boolean {
  const clause = before.split(/[.!?;\n\r\u2028\u2029]/u).at(-1) ?? '';
  return (
    QUANTITY_PREFIX.test(before) ||
    QUANTITY_SUFFIX.test(after) ||
    (!PHONE_CONTEXT.test(before) &&
      (IDENTIFIER_CONTEXT.test(before) || PROTECTED_LABEL_IN_CLAUSE.test(clause)))
  );
}

function phoneEvidence(candidate: string, before: string, after: string): string | null {
  // FLAG: Wrappers must not hide an explicit order/part/quantity label. Only bounded
  // adjacent context is inspected; numeric payloads and surrounding prose remain intact.
  before = before.replace(/[\s:=№#.\-([{«"'“‘]+$/u, ' ');
  after = after.replace(/^[\s)\]}»"'”’]+/u, ' ');
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15 || hasProtectedValueContext(before, after))
    return null;
  // FLAG: Grouping alone cannot distinguish a phone from an order/model/version identifier.
  // Require an explicit phone label or an international + prefix with nonzero country digits.
  const international = candidate.startsWith('+') && /^[1-9]\d{9,14}$/u.test(digits);
  const labelled = PHONE_CONTEXT.test(before);
  if (!international && !labelled) return null;
  if (!international && digits.length === 11 && digits.startsWith('8'))
    return `7${digits.slice(1)}`;
  if (!international && digits.length === 10 && digits.startsWith('9')) return `7${digits}`;
  return digits;
}

export function extractDuplicatePhoneNumbers(text: string): string[] {
  const phones = new Set<string>();
  for (const match of text.matchAll(CANDIDATE)) {
    const candidate = match[1]!;
    const start = match.index + match[0].length - candidate.length;
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
  return text.replace(CANDIDATE, (match, candidate: string, index: number) => {
    const start = index + match.length - candidate.length;
    const phone = phoneEvidence(
      candidate,
      text.slice(Math.max(0, start - 128), start),
      text.slice(start + candidate.length, start + candidate.length + 64),
    );
    // FLAG: The leading boundary belongs to surrounding prose, never to the phone.
    return phone ? `${match.slice(0, match.length - candidate.length)} ` : match;
  });
}
