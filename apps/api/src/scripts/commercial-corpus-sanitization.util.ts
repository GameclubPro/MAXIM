import { replaceUrlsInText } from '../common/url-text.util';
import { replaceCommercialPhoneLikeText } from '../moderation/commercial/commercial-phone';

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
const MAX_DEEP_LINK_PATTERN = /max:\/\/[^\s<>'"`()[\]{}]+/giu;
const HANDLE_PATTERN = /@[a-z0-9_]{4,32}/giu;
const FINANCIAL_CONTEXT_TERM = String.raw`(?:р\s*[/.\\-]\s*с|расч[её]тн\p{L}*\s+сч[её]т\p{L}*|банковск\p{L}*\s+сч[её]т\p{L}*|корр?(?:еспондентск\p{L}*)?\.?\s*сч[её]т\p{L}*|сч[её]т\s+(?:получателя|банка)|номер\s+сч[её]та|карт(?:а|ы|у|е|ой)|card|pan|сч[её]т)`;
const ADJACENT_CONTEXT_SEPARATOR = String.raw`[\s:;,#№()./\\‐‑‒–—―-]`;
const FINANCIAL_CONTEXT_BEFORE_PATTERN = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}_])${FINANCIAL_CONTEXT_TERM}(?![\p{L}\p{N}_])${ADJACENT_CONTEXT_SEPARATOR}{0,12}$`,
  'iu',
);
const FINANCIAL_CONTEXT_AFTER_PATTERN = new RegExp(
  String.raw`^${ADJACENT_CONTEXT_SEPARATOR}{0,12}${FINANCIAL_CONTEXT_TERM}(?![\p{L}\p{N}_])`,
  'iu',
);

function hasFinancialContext(source: string, start: number, matchLength: number): boolean {
  const before = source.slice(Math.max(0, start - 80), start);
  const after = source.slice(start + matchLength, start + matchLength + 80);
  return (
    FINANCIAL_CONTEXT_BEFORE_PATTERN.test(before) || FINANCIAL_CONTEXT_AFTER_PATTERN.test(after)
  );
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

function redactFinancialNumbers(value: string): string {
  const withoutAccounts = value.replace(
    BANK_ACCOUNT_CANDIDATE_PATTERN,
    (match: string, offset: number, input: string) =>
      hasFinancialContext(input, offset, match.length) ? '[account]' : match,
  );
  return withoutAccounts.replace(
    PAYMENT_CARD_CANDIDATE_PATTERN,
    (match: string, offset: number, input: string) =>
      passesLuhnCheck(match) || hasFinancialContext(input, offset, match.length) ? '[card]' : match,
  );
}

export function sanitizeCommercialCorpusText(
  value: string,
  options: { preserveLayout?: boolean } = {},
): string {
  const withoutEmails = value.replace(EMAIL_PATTERN, '[email]');
  const withoutWebUrls = replaceUrlsInText(withoutEmails, '[url]');
  const withoutUrls = withoutWebUrls.replace(MAX_DEEP_LINK_PATTERN, '[url]');
  const sanitized = replaceCommercialPhoneLikeText(redactFinancialNumbers(withoutUrls)).replace(
    HANDLE_PATTERN,
    '@[handle]',
  );
  return (options.preserveLayout ? sanitized : sanitized.replace(/\s+/gu, ' ')).trim();
}

export function isCommercialCorpusTextSanitized(value: string): boolean {
  return sanitizeCommercialCorpusText(value, { preserveLayout: true }) === value;
}

// FLAG: Independent conservative privacy check, not evidence for a moderation decision.
export function hasResidualCommercialContactCandidate(value: string): boolean {
  return (
    /(?<!\d)(?:\+?[78])(?:(?:[\s().\u2010-\u2015/•|-]|\uFE0F|\u20E3)*\d){10}(?!\d)/u.test(value) ||
    /(?:https?:\/\/|max:\/\/|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,})/iu.test(value)
  );
}
