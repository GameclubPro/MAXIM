const NUMBER_SEPARATOR_CHARS = String.raw`\s()./\\‐‑‒–—―-`;
const KEYCAP_MARK_PATTERN = String.raw`\uFE0F?\u20E3`;
const EMOJI_PHONE_SEPARATOR_PATTERN = String.raw`\p{Extended_Pictographic}\uFE0F?`;
const OBFUSCATED_PHONE_SEPARATOR_PATTERN = String.raw`(?:${KEYCAP_MARK_PATTERN}|[•|]|${EMOJI_PHONE_SEPARATOR_PATTERN})`;
const PHONE_SEPARATOR_PATTERN = String.raw`(?:[${NUMBER_SEPARATOR_CHARS}]|[•|]|${EMOJI_PHONE_SEPARATOR_PATTERN})*`;
const PHONE_DIGIT_PATTERN = String.raw`\d(?:${KEYCAP_MARK_PATTERN})?`;
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
  String.raw`(?<![\d+])\+?[78](?:${KEYCAP_MARK_PATTERN})?(?:${PHONE_SEPARATOR_PATTERN}${PHONE_DIGIT_PATTERN}){10}(?![${NUMBER_SEPARATOR_CHARS}]*\d)`,
  'gu',
);
const LOCAL_PHONE_CANDIDATE_PATTERN = new RegExp(
  String.raw`(?<!\d)\d(?:[${NUMBER_SEPARATOR_CHARS}]*\d){9}(?![${NUMBER_SEPARATOR_CHARS}]*\d)`,
  'gu',
);
const ADJACENT_NUMERIC_SEQUENCE_BEFORE_PATTERN = new RegExp(
  String.raw`\d${PHONE_SEPARATOR_PATTERN}$`,
  'u',
);
const ADJACENT_NUMERIC_SEQUENCE_AFTER_PATTERN = new RegExp(
  String.raw`^${PHONE_SEPARATOR_PATTERN}\d`,
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

export function normalizeCommercialPhoneConfusables(value: string): string {
  return value.replace(PHONE_LIKE_CONFUSABLE_SPAN_PATTERN, (phoneLikeSpan) =>
    phoneLikeSpan.replace(/[OoОо]/gu, '0'),
  );
}

export function hasCommercialPhoneLikeText(value: string): boolean {
  const normalized = normalizeCommercialPhoneConfusables(value);
  if (hasCandidate(normalized, INTERNATIONAL_PHONE_PATTERN, () => true)) {
    return true;
  }
  if (
    hasCandidate(
      normalized,
      CONTEXTUAL_OBFUSCATED_INTERNATIONAL_PHONE_PATTERN,
      (match, offset) =>
        hasObfuscatedPhoneSeparator(match) &&
        hasAdjacentPhoneContext(normalized, offset, match.length),
    )
  ) {
    return true;
  }
  if (
    hasCandidate(normalized, RUSSIAN_PHONE_CANDIDATE_PATTERN, (match, offset) => {
      if (isEmbeddedInLongerNumericSequence(normalized, offset, match.length)) {
        return false;
      }
      const hasContext = hasAdjacentPhoneContext(normalized, offset, match.length);
      const hasIdentifierContext = hasAdjacentIdentifierContext(normalized, offset, match.length);
      if (hasIdentifierContext && !hasContext) {
        return false;
      }
      return hasObfuscatedPhoneSeparator(match)
        ? true
        : looksLikeStructuredPhone(match) || hasContext || looksLikeBareRussianPhone(match);
    })
  ) {
    return true;
  }
  if (
    hasCandidate(
      normalized,
      LOCAL_PHONE_CANDIDATE_PATTERN,
      (match, offset) =>
        !isEmbeddedInLongerNumericSequence(normalized, offset, match.length) &&
        !hasAdjacentIdentifierContext(normalized, offset, match.length) &&
        (looksLikeStructuredPhone(match) ||
          hasAdjacentPhoneContext(normalized, offset, match.length)),
    )
  ) {
    return true;
  }
  return hasCandidate(normalized, SHORT_LOCAL_PHONE_CANDIDATE_PATTERN, (match, offset) =>
    hasAdjacentPhoneContext(normalized, offset, match.length),
  );
}

export function replaceCommercialPhoneLikeText(value: string, replacement = '[phone]'): string {
  const normalized = normalizeCommercialPhoneConfusables(value);
  const withoutInternationalPhones = replaceCandidates(
    normalized,
    INTERNATIONAL_PHONE_PATTERN,
    replacement,
    () => true,
  );
  const withoutObfuscatedInternationalPhones = replaceCandidates(
    withoutInternationalPhones,
    CONTEXTUAL_OBFUSCATED_INTERNATIONAL_PHONE_PATTERN,
    replacement,
    (match, offset, input) =>
      hasObfuscatedPhoneSeparator(match) && hasAdjacentPhoneContext(input, offset, match.length),
  );
  const withoutRussianPhones = replaceCandidates(
    withoutObfuscatedInternationalPhones,
    RUSSIAN_PHONE_CANDIDATE_PATTERN,
    replacement,
    (match, offset, input) => {
      if (isEmbeddedInLongerNumericSequence(input, offset, match.length)) {
        return false;
      }
      const hasContext = hasAdjacentPhoneContext(input, offset, match.length);
      const hasIdentifierContext = hasAdjacentIdentifierContext(input, offset, match.length);
      if (hasIdentifierContext && !hasContext) {
        return false;
      }
      return hasObfuscatedPhoneSeparator(match)
        ? true
        : looksLikeStructuredPhone(match) || hasContext || looksLikeBareRussianPhone(match);
    },
  );
  const withoutLocalPhones = replaceCandidates(
    withoutRussianPhones,
    LOCAL_PHONE_CANDIDATE_PATTERN,
    replacement,
    (match, offset, input) =>
      !isEmbeddedInLongerNumericSequence(input, offset, match.length) &&
      !hasAdjacentIdentifierContext(input, offset, match.length) &&
      (looksLikeStructuredPhone(match) || hasAdjacentPhoneContext(input, offset, match.length)),
  );
  return replaceCandidates(
    withoutLocalPhones,
    SHORT_LOCAL_PHONE_CANDIDATE_PATTERN,
    replacement,
    (match, offset, input) => hasAdjacentPhoneContext(input, offset, match.length),
  );
}

function hasCandidate(
  value: string,
  pattern: RegExp,
  predicate: (match: string, offset: number) => boolean,
): boolean {
  pattern.lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    if (predicate(match[0], match.index ?? 0)) {
      return true;
    }
  }
  return false;
}

function replaceCandidates(
  value: string,
  pattern: RegExp,
  replacement: string,
  predicate: (match: string, offset: number, input: string) => boolean,
): string {
  pattern.lastIndex = 0;
  return value.replace(pattern, (match: string, offset: number, input: string) =>
    predicate(match, offset, input) ? replacement : match,
  );
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
