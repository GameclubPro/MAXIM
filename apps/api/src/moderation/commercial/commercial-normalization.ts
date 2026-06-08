import { normalizeForDetection } from '../rule-engine-normalization';

const SPACED_LETTER_SEQUENCE_PATTERN =
  /(?:^|(?<=[\s.,:;!?/+-]))\p{L}(?:[\s.,:;!?/+-]+\p{L}){2,}(?=$|[\s.,:;!?/+-])/gu;
const COMMERCIAL_LATIN_CONFUSABLES: Readonly<Record<string, string>> = {
  a: 'а',
  c: 'с',
  e: 'е',
  k: 'к',
  m: 'м',
  o: 'о',
  p: 'р',
  t: 'т',
  x: 'х',
  y: 'у',
};

export function normalizeCommercialText(value: string): string {
  const normalized = normalizeForDetection(value);
  if (!normalized) {
    return '';
  }

  return normalized.replace(SPACED_LETTER_SEQUENCE_PATTERN, (sequence) =>
    sequence.replace(/[\s.,:;!?/+-]+/gu, ''),
  );
}

export function normalizeCommercialConfusables(value: string): string {
  const lowered = value.toLowerCase();
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
