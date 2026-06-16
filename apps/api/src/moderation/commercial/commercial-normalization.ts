import { normalizeForDetection } from '../rule-engine-normalization';

const SPACED_LETTER_SEQUENCE_PATTERN =
  /(?:^|(?<=[\s.,:;!?/+-]))\p{L}(?:[\s.,:;!?/+-]+\p{L}){2,}(?=$|[\s.,:;!?/+-])/gu;
const ZERO_WIDTH_PATTERN = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/gu;
const COMMERCIAL_LATIN_CONFUSABLES: Readonly<Record<string, string>> = {
  a: 'а',
  b: 'б',
  c: 'с',
  d: 'д',
  e: 'е',
  h: 'н',
  i: 'и',
  j: 'й',
  k: 'к',
  l: 'л',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'р',
  r: 'р',
  s: 'с',
  t: 'т',
  u: 'и',
  v: 'в',
  w: 'в',
  x: 'х',
  y: 'у',
  z: 'з',
};

export function normalizeCommercialText(value: string): string {
  const normalized = normalizeForDetection(normalizeCommercialRawText(value));
  if (!normalized) {
    return '';
  }

  return normalized.replace(SPACED_LETTER_SEQUENCE_PATTERN, (sequence) =>
    sequence.replace(/[\s.,:;!?/+-]+/gu, ''),
  );
}

export function normalizeCommercialConfusables(value: string): string {
  const lowered = normalizeCommercialRawText(value);
  if (!/[a-z]/u.test(lowered) || !/[а-яё]/u.test(lowered)) {
    return lowered;
  }

  return lowered.replace(/[\p{L}\p{N}_-]+/gu, (token) => {
    if (!/[a-z]/u.test(token) || !/[а-яё]/u.test(token)) {
      return token;
    }

    let normalizedToken = '';
    for (const char of token) {
      normalizedToken += COMMERCIAL_LATIN_CONFUSABLES[char] ?? char;
    }
    return normalizedToken;
  });
}

export function normalizeCommercialRawText(value: string): string {
  if (!value) {
    return '';
  }

  let normalized = value.toLowerCase().replace(ZERO_WIDTH_PATTERN, '');
  normalized = normalizeObfuscatedUrls(normalized);
  normalized = normalized.replace(/[\p{L}\p{N}_-]+/gu, normalizeMixedCommercialToken);
  return normalized;
}

function normalizeObfuscatedUrls(value: string): string {
  return value
    .replace(/\bh\s*x\s*x\s*p\s*s?\s*(?=[:：]|\/|\\)/giu, (match) =>
      /s/iu.test(match) ? 'https' : 'http',
    )
    .replace(/\b(hxxps?|https?)\s*(?:[:：]\s*)?(?:[\\/]\s*){2}/giu, (_match, scheme: string) => {
      const normalizedScheme = scheme.toLowerCase().startsWith('hxxp')
        ? scheme.toLowerCase().replace('hxxp', 'http')
        : scheme.toLowerCase();
      return `${normalizedScheme}://`;
    })
    .replace(
      /([a-z0-9а-яё-])\s+(?:dot|точка)\s+([a-zа-яё]{2,})(?=$|[^\p{L}\p{N}_-])/giu,
      '$1.$2',
    );
}

function normalizeMixedCommercialToken(token: string): string {
  if (!/[a-z]/u.test(token) || !/[а-яё]/u.test(token)) {
    return token;
  }

  let normalizedToken = '';
  for (const char of token) {
    normalizedToken += COMMERCIAL_LATIN_CONFUSABLES[char] ?? char;
  }
  return normalizedToken;
}
