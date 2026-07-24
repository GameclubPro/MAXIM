import { replaceUrlsInText } from '../common/url-text.util';

const NUMBER_SEPARATOR_CHARS = String.raw`\s()./\\‐‑‒–—―-`;
const EMAIL_ATOM_CHARS = String.raw`\p{L}\p{N}!#$%&'*+/=?^_\x60{|}~\x2d`;
const EMAIL_PATTERN = new RegExp(
  String.raw`(?<![${EMAIL_ATOM_CHARS}.])[${EMAIL_ATOM_CHARS}]+(?:\.[${EMAIL_ATOM_CHARS}]+)*@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:xn--[a-z0-9-]{2,59}|\p{L}{2,63})(?![\p{L}\p{N}-])`,
  'giu',
);
const BANK_ACCOUNT_CANDIDATE_PATTERN = new RegExp(
  String.raw`(?<!\d)\d(?:[${NUMBER_SEPARATOR_CHARS}]*\d){19}(?![${NUMBER_SEPARATOR_CHARS}]*\d)`,
  'gu',
);
const PAYMENT_CARD_CANDIDATE_PATTERN = new RegExp(
  String.raw`(?<!\d)\d(?:[${NUMBER_SEPARATOR_CHARS}]*\d){12,18}(?![${NUMBER_SEPARATOR_CHARS}]*\d)`,
  'gu',
);
const INTERNATIONAL_PHONE_PATTERN = new RegExp(
  String.raw`(?<![\d+])\+\d(?:[${NUMBER_SEPARATOR_CHARS}]*\d){6,14}(?![${NUMBER_SEPARATOR_CHARS}]*\d)`,
  'gu',
);
const KEYCAP_MARK_PATTERN = String.raw`\uFE0F?\u20E3`;
const EMOJI_PHONE_SEPARATOR_PATTERN = String.raw`\p{Extended_Pictographic}\uFE0F?`;
const OBFUSCATED_PHONE_SEPARATOR_PATTERN = String.raw`(?:${KEYCAP_MARK_PATTERN}|[•|]|${EMOJI_PHONE_SEPARATOR_PATTERN})`;
const HAS_OBFUSCATED_PHONE_SEPARATOR_PATTERN = new RegExp(OBFUSCATED_PHONE_SEPARATOR_PATTERN, 'u');
const PHONE_SEPARATOR_PATTERN = String.raw`(?:[${NUMBER_SEPARATOR_CHARS}]|[•|]|${EMOJI_PHONE_SEPARATOR_PATTERN})*`;
const PHONE_DIGIT_PATTERN = String.raw`\d(?:${KEYCAP_MARK_PATTERN})?`;
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
const SHORT_LOCAL_PHONE_CANDIDATE_PATTERN =
  /(?<!\d)\d{2}[\u2010-\u2015-]\d{2}[\u2010-\u2015-]\d{2}(?!\d)/gu;
const MAX_DEEP_LINK_PATTERN = /max:\/\/[^\s<>'"`()[\]{}]+/giu;
const HANDLE_PATTERN = /@[a-z0-9_]{4,32}/giu;

const PHONE_CONTEXT_TERM = String.raw`(?:телефон(?:а|у|ом|ы)?|тел\.?|номер\s+телефона|звон(?:ить|ите|ок|ки)|контакт(?:ы|ный\s+номер)?|связь|для\s+связи|ватсап|whats?app|viber)`;
const FINANCIAL_CONTEXT_TERM = String.raw`(?:р\s*[/.\\-]\s*с|расч[её]тн\p{L}*\s+сч[её]т\p{L}*|банковск\p{L}*\s+сч[её]т\p{L}*|корр?(?:еспондентск\p{L}*)?\.?\s*сч[её]т\p{L}*|сч[её]т\s+(?:получателя|банка)|номер\s+сч[её]та|карт(?:а|ы|у|е|ой)|card|pan|сч[её]т)`;
const ADJACENT_CONTEXT_SEPARATOR = String.raw`[\s:;,#№()./\\‐‑‒–—―-]`;
const PHONE_ADJACENT_CONTEXT_SEPARATOR = String.raw`(?:${ADJACENT_CONTEXT_SEPARATOR}|[•|]|${EMOJI_PHONE_SEPARATOR_PATTERN})`;

function createAdjacentContextPatterns(
  contextTerm: string,
  separatorPattern = ADJACENT_CONTEXT_SEPARATOR,
): {
  before: RegExp;
  after: RegExp;
} {
  return {
    before: new RegExp(
      String.raw`(?:^|[^\p{L}\p{N}_])${contextTerm}(?![\p{L}\p{N}_])${separatorPattern}{0,12}$`,
      'iu',
    ),
    after: new RegExp(String.raw`^${separatorPattern}{0,12}${contextTerm}(?![\p{L}\p{N}_])`, 'iu'),
  };
}

const PHONE_CONTEXT_PATTERNS = createAdjacentContextPatterns(
  PHONE_CONTEXT_TERM,
  PHONE_ADJACENT_CONTEXT_SEPARATOR,
);
const FINANCIAL_CONTEXT_PATTERNS = createAdjacentContextPatterns(FINANCIAL_CONTEXT_TERM);

function hasAdjacentContext(
  source: string,
  start: number,
  matchLength: number,
  patterns: { before: RegExp; after: RegExp },
): boolean {
  const before = source.slice(Math.max(0, start - 80), start);
  const after = source.slice(start + matchLength, start + matchLength + 80);
  return patterns.before.test(before) || patterns.after.test(after);
}

function redactCandidates(
  source: string,
  pattern: RegExp,
  replacement: string,
  shouldRedact: (match: string, offset: number, input: string) => boolean,
): string {
  return source.replace(pattern, (match: string, offset: number, input: string) =>
    shouldRedact(match, offset, input) ? replacement : match,
  );
}

function digitCount(value: string): number {
  return value.replace(/\D/gu, '').length;
}

function passesLuhnCheck(value: string): boolean {
  const digits = value.replace(/\D/gu, '');
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits)) {
    return false;
  }

  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function looksLikeStructuredPhone(value: string): boolean {
  if (/[()]/u.test(value)) {
    return true;
  }
  if (!/[\s\u2010-\u2015-]/u.test(value) || /^\d{3}(?:\.\d{2,3}){3}$/u.test(value)) {
    return false;
  }
  return digitCount(value) >= 10;
}

function hasObfuscatedPhoneSeparator(value: string): boolean {
  return HAS_OBFUSCATED_PHONE_SEPARATOR_PATTERN.test(value);
}

function redactFinancialNumbers(value: string): string {
  const withoutAccounts = redactCandidates(
    value,
    BANK_ACCOUNT_CANDIDATE_PATTERN,
    '[account]',
    (match, offset, input) =>
      hasAdjacentContext(input, offset, match.length, FINANCIAL_CONTEXT_PATTERNS),
  );
  return redactCandidates(
    withoutAccounts,
    PAYMENT_CARD_CANDIDATE_PATTERN,
    '[card]',
    (match, offset, input) =>
      passesLuhnCheck(match) ||
      hasAdjacentContext(input, offset, match.length, FINANCIAL_CONTEXT_PATTERNS),
  );
}

function redactPhones(value: string): string {
  const withoutInternationalPhones = value.replace(INTERNATIONAL_PHONE_PATTERN, '[phone]');
  const withoutObfuscatedInternationalPhones = redactCandidates(
    withoutInternationalPhones,
    CONTEXTUAL_OBFUSCATED_INTERNATIONAL_PHONE_PATTERN,
    '[phone]',
    (match, offset, input) =>
      hasObfuscatedPhoneSeparator(match) &&
      hasAdjacentContext(input, offset, match.length, PHONE_CONTEXT_PATTERNS),
  );
  const withoutRussianPhones = redactCandidates(
    withoutObfuscatedInternationalPhones,
    RUSSIAN_PHONE_CANDIDATE_PATTERN,
    '[phone]',
    (match, offset, input) => {
      const hasPhoneContext = hasAdjacentContext(
        input,
        offset,
        match.length,
        PHONE_CONTEXT_PATTERNS,
      );
      return hasObfuscatedPhoneSeparator(match)
        ? hasPhoneContext
        : looksLikeStructuredPhone(match) || hasPhoneContext;
    },
  );
  const withoutLocalPhones = redactCandidates(
    withoutRussianPhones,
    LOCAL_PHONE_CANDIDATE_PATTERN,
    '[phone]',
    (match, offset, input) =>
      looksLikeStructuredPhone(match) ||
      hasAdjacentContext(input, offset, match.length, PHONE_CONTEXT_PATTERNS),
  );
  return redactCandidates(
    withoutLocalPhones,
    SHORT_LOCAL_PHONE_CANDIDATE_PATTERN,
    '[phone]',
    (match, offset, input) =>
      hasAdjacentContext(input, offset, match.length, PHONE_CONTEXT_PATTERNS),
  );
}

export function sanitizeCommercialCorpusText(value: string): string {
  const withoutEmails = value.replace(EMAIL_PATTERN, '[email]');
  const withoutWebUrls = replaceUrlsInText(withoutEmails, '[url]');
  const withoutUrls = withoutWebUrls.replace(MAX_DEEP_LINK_PATTERN, '[url]');
  return redactPhones(redactFinancialNumbers(withoutUrls))
    .replace(HANDLE_PATTERN, '@[handle]')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function isCommercialCorpusTextSanitized(value: string): boolean {
  return sanitizeCommercialCorpusText(value) === value;
}
