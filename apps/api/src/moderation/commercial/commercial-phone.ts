const NUMBER_SEPARATOR_CHARS = String.raw`\s()./\\‐‑‒–—―-`;
const KEYCAP_MARK_PATTERN = String.raw`\uFE0F?\u20E3`;
const EMOJI_PHONE_SEPARATOR_PATTERN = String.raw`\p{Extended_Pictographic}\uFE0F?`;
const OBFUSCATED_PHONE_SEPARATOR_PATTERN = String.raw`(?:${KEYCAP_MARK_PATTERN}|[•|]|${EMOJI_PHONE_SEPARATOR_PATTERN})`;
const PHONE_SEPARATOR_PATTERN = String.raw`(?:[${NUMBER_SEPARATOR_CHARS}]|[•|]|${EMOJI_PHONE_SEPARATOR_PATTERN})*`;
const PHONE_DIGIT_PATTERN = String.raw`\d(?:${KEYCAP_MARK_PATTERN})?`;
// FLAG: A new line or phone label separates contacts, not digits of one identifier.
const ADJACENT_DIGIT_SEPARATOR_PATTERN = String.raw`(?:(?![\r\n\u260E\u{1F4DE}\u{1F4F1}\u{1F4F2}])(?:[${NUMBER_SEPARATOR_CHARS}]|[•|]|${EMOJI_PHONE_SEPARATOR_PATTERN}))*`;
const INLINE_NUMBER_SEPARATOR_PATTERN = String.raw`(?:(?![\r\n])[${NUMBER_SEPARATOR_CHARS}])*`;
const PHONE_CONTEXT_TERM = String.raw`(?:телефон(?:а|у|ом|ы)?|тел\.?|номер\s+телефона|(?:пишите?|звоните?|обращайтесь)\s+по\s+номер[у]?|звон(?:ить|ите|ок|ки)|контакт(?:ы|ный\s+номер)?|связь|для\s+связи|ватсап|whats?app|viber)`;
const NON_PHONE_IDENTIFIER_CONTEXT_TERM = String.raw`(?:заказ(?:а|у|ом|е|ы)?|код(?:а|у|ом|е|ы)?|номер\s+заказа|маркировк\p{L}*|парти\p{L}*|инн|огрн|снилс)`;
const PHONE_ADJACENT_CONTEXT_SEPARATOR = String.raw`(?:[\s:;,#№()./\\‐‑‒–—―-]|[•|]|${EMOJI_PHONE_SEPARATOR_PATTERN})`;

const PHONE_LIKE_CONFUSABLE_SPAN_PATTERN =
  /(?:^|[^\p{L}\p{N}])(?:(?:\+\s*[1-9])(?:[\s().‐‑‒–—―•·|/:+-]*[\dOoОо]){6,14}|[78](?:[\s().‐‑‒–—―•·|/:+-]*[\dOoОо]){10})(?=$|[^\p{L}\p{N}])/gu;
const INTERNATIONAL_PHONE_PATTERN = new RegExp(
  String.raw`(?<![\d+])\+\d(?:[${NUMBER_SEPARATOR_CHARS}]*\d){6,14}(?![${NUMBER_SEPARATOR_CHARS}]*\d)`,
  'gu',
);
const CONTEXTUAL_OBFUSCATED_INTERNATIONAL_PHONE_PATTERN = new RegExp(
  String.raw`(?<![\d+])\+[1-9](?:${KEYCAP_MARK_PATTERN})?(?:${PHONE_SEPARATOR_PATTERN}${PHONE_DIGIT_PATTERN}){6,14}(?!${PHONE_SEPARATOR_PATTERN}${PHONE_DIGIT_PATTERN})`,
  'gu',
);
const RUSSIAN_PHONE_CANDIDATE_PATTERN = new RegExp(
  String.raw`(?<![\d+])\+?[78](?:${KEYCAP_MARK_PATTERN})?(?:${PHONE_SEPARATOR_PATTERN}${PHONE_DIGIT_PATTERN}){10}(?!${INLINE_NUMBER_SEPARATOR_PATTERN}\d)`,
  'gu',
);
const LOCAL_PHONE_CANDIDATE_PATTERN = new RegExp(
  String.raw`(?<!\d)\d(?:[${NUMBER_SEPARATOR_CHARS}]*\d){9}(?!${INLINE_NUMBER_SEPARATOR_PATTERN}\d)`,
  'gu',
);
const ADJACENT_NUMERIC_SEQUENCE_BEFORE_PATTERN = new RegExp(
  String.raw`\d${ADJACENT_DIGIT_SEPARATOR_PATTERN}$`,
  'u',
);
const ADJACENT_NUMERIC_SEQUENCE_AFTER_PATTERN = new RegExp(
  String.raw`^${ADJACENT_DIGIT_SEPARATOR_PATTERN}\d`,
  'u',
);
const SHORT_LOCAL_PHONE_CANDIDATE_PATTERN =
  /(?<!\d)\d{2}[\u2010-\u2015-]\d{2}[\u2010-\u2015-]\d{2}(?!\d)/gu;
const HAS_OBFUSCATED_PHONE_SEPARATOR_PATTERN = new RegExp(OBFUSCATED_PHONE_SEPARATOR_PATTERN, 'u');
const PHONE_CONTEXT_BEFORE_PATTERN = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}_])${PHONE_CONTEXT_TERM}(?![\p{L}\p{N}_])${PHONE_ADJACENT_CONTEXT_SEPARATOR}{0,12}$`,
  'iu',
);
const PHONE_CONTEXT_AFTER_PATTERN = new RegExp(
  String.raw`^${PHONE_ADJACENT_CONTEXT_SEPARATOR}{0,12}${PHONE_CONTEXT_TERM}(?![\p{L}\p{N}_])`,
  'iu',
);
const NON_PHONE_IDENTIFIER_CONTEXT_BEFORE_PATTERN = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}_])${NON_PHONE_IDENTIFIER_CONTEXT_TERM}(?![\p{L}\p{N}_])${PHONE_ADJACENT_CONTEXT_SEPARATOR}{0,12}$`,
  'iu',
);
const NON_PHONE_IDENTIFIER_CONTEXT_AFTER_PATTERN = new RegExp(
  String.raw`^${PHONE_ADJACENT_CONTEXT_SEPARATOR}{0,12}${NON_PHONE_IDENTIFIER_CONTEXT_TERM}(?![\p{L}\p{N}_])`,
  'iu',
);
const COMPLETE_RUSSIAN_PHONE_SOURCE = String.raw`\+?[78](?:${KEYCAP_MARK_PATTERN})?(?:${PHONE_SEPARATOR_PATTERN}${PHONE_DIGIT_PATTERN}){10}`;
const CONTACT_PAIR_SEPARATOR_PATTERN = new RegExp(
  String.raw`(?<![\d+])(${COMPLETE_RUSSIAN_PHONE_SOURCE})([ \t]*/[ \t]*)(?=${COMPLETE_RUSSIAN_PHONE_SOURCE}(?!\d))`,
  'gu',
);
const SCHEDULE_CONTACT_SEPARATOR_PATTERN = new RegExp(
  String.raw`((?:^|[^\p{L}\p{N}_])24\s*(?:на|/)\s*7)([ \t]+)(?=${COMPLETE_RUSSIAN_PHONE_SOURCE}(?!\d))`,
  'giu',
);

export type CommercialPhoneContact = {
  start: number;
  end: number;
  normalizedNumber: string;
};

export function normalizeCommercialPhoneConfusables(value: string): string {
  return value.replace(PHONE_LIKE_CONFUSABLE_SPAN_PATTERN, (phoneLikeSpan) =>
    phoneLikeSpan.replace(/[OoОо]/gu, '0'),
  );
}

export function hasCommercialPhoneLikeText(value: string): boolean {
  return collectCommercialPhones(value, true).length > 0;
}

export function parseCommercialPhones(value: string): CommercialPhoneContact[] {
  return collectCommercialPhones(value, false);
}

function collectCommercialPhones(value: string, firstOnly: boolean): CommercialPhoneContact[] {
  if (!/\d/u.test(value)) return [];
  const normalized = normalizeCommercialPhoneConfusables(value);
  // FLAG: Change only delimiter characters in the scan copy; spans retain original UTF-16 offsets.
  const scanText = normalized
    .replace(
      CONTACT_PAIR_SEPARATOR_PATTERN,
      (_match, phone: string, separator: string) => phone + separator.replace('/', ','),
    )
    .replace(
      SCHEDULE_CONTACT_SEPARATOR_PATTERN,
      (_match, schedule: string, separator: string) => schedule + ',' + separator.slice(1),
    );
  const contacts: CommercialPhoneContact[] = [];
  for (const pattern of [
    INTERNATIONAL_PHONE_PATTERN,
    CONTEXTUAL_OBFUSCATED_INTERNATIONAL_PHONE_PATTERN,
    RUSSIAN_PHONE_CANDIDATE_PATTERN,
    LOCAL_PHONE_CANDIDATE_PATTERN,
    SHORT_LOCAL_PHONE_CANDIDATE_PATTERN,
  ]) {
    pattern.lastIndex = 0;
    for (const match of scanText.matchAll(pattern)) {
      const start = match.index;
      const text = match[0];
      const end = start + text.length;
      if (contacts.some((contact) => start < contact.end && end > contact.start)) continue;
      const hasContext = hasAdjacentPhoneContext(scanText, start, text.length);
      let accepted: boolean;
      if (pattern === INTERNATIONAL_PHONE_PATTERN) {
        accepted = true;
      } else if (pattern === CONTEXTUAL_OBFUSCATED_INTERNATIONAL_PHONE_PATTERN) {
        accepted = hasObfuscatedPhoneSeparator(text) && hasContext;
      } else if (pattern === SHORT_LOCAL_PHONE_CANDIDATE_PATTERN) {
        accepted = hasContext;
      } else {
        const hasIdentifier = hasAdjacentIdentifierContext(scanText, start, text.length);
        accepted =
          !isEmbeddedInLongerNumericSequence(scanText, start, text.length) &&
          (pattern === RUSSIAN_PHONE_CANDIDATE_PATTERN
            ? !(hasIdentifier && !hasContext) &&
              (hasObfuscatedPhoneSeparator(text) ||
                looksLikeStructuredPhone(text) ||
                hasContext ||
                looksLikeBareRussianPhone(text))
            : !hasIdentifier && (looksLikeStructuredPhone(text) || hasContext));
      }
      if (!accepted) continue;
      const digits = text.replace(/\D/gu, '');
      contacts.push({
        start,
        end,
        normalizedNumber:
          digits.length === 11 && digits.startsWith('8') ? `7${digits.slice(1)}` : digits,
      });
      if (firstOnly) return contacts;
    }
  }
  return contacts.sort((left, right) => left.start - right.start);
}

export function replaceCommercialPhoneLikeText(value: string, replacement = '[phone]'): string {
  const normalized = normalizeCommercialPhoneConfusables(value);
  const contacts = parseCommercialPhones(normalized);
  let end = 0;
  const parts: string[] = [];
  for (const contact of contacts) {
    parts.push(normalized.slice(end, contact.start), replacement);
    end = contact.end;
  }
  parts.push(normalized.slice(end));
  return parts.join('');
}

function hasAdjacentPhoneContext(source: string, start: number, matchLength: number): boolean {
  const before = source.slice(Math.max(0, start - 80), start);
  const after = source.slice(start + matchLength, start + matchLength + 80);
  return PHONE_CONTEXT_BEFORE_PATTERN.test(before) || PHONE_CONTEXT_AFTER_PATTERN.test(after);
}

function hasAdjacentIdentifierContext(source: string, start: number, matchLength: number): boolean {
  const before = source.slice(Math.max(0, start - 80), start);
  const after = source.slice(start + matchLength, start + matchLength + 80);
  return (
    NON_PHONE_IDENTIFIER_CONTEXT_BEFORE_PATTERN.test(before) ||
    NON_PHONE_IDENTIFIER_CONTEXT_AFTER_PATTERN.test(after)
  );
}

function isEmbeddedInLongerNumericSequence(
  source: string,
  start: number,
  matchLength: number,
): boolean {
  const before = source.slice(Math.max(0, start - 32), start);
  const after = source.slice(start + matchLength, start + matchLength + 32);
  return (
    ADJACENT_NUMERIC_SEQUENCE_BEFORE_PATTERN.test(before) ||
    ADJACENT_NUMERIC_SEQUENCE_AFTER_PATTERN.test(after)
  );
}

function looksLikeStructuredPhone(value: string): boolean {
  if (/[()]/u.test(value)) {
    return true;
  }
  if (!/[\s\u2010-\u2015-]/u.test(value) || /^\d{3}(?:\.\d{2,3}){3}$/u.test(value)) {
    return false;
  }
  return value.replace(/\D/gu, '').length >= 10;
}

function looksLikeBareRussianPhone(value: string): boolean {
  return /^[78]\d{10}$/u.test(value);
}

function hasObfuscatedPhoneSeparator(value: string): boolean {
  return HAS_OBFUSCATED_PHONE_SEPARATOR_PATTERN.test(value);
}
