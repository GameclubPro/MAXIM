import { normalizeForDetection } from '../rule-engine-normalization';

const SPACED_LETTER_SEQUENCE_PATTERN =
  /(?:^|(?<=[\s.,:;!?/+-]))\p{L}(?:[\s.,:;!?/+-]+\p{L}){2,}(?=$|[\s.,:;!?/+-])/gu;

export function normalizeCommercialText(value: string): string {
  const normalized = normalizeForDetection(value);
  if (!normalized) {
    return '';
  }

  return normalized.replace(SPACED_LETTER_SEQUENCE_PATTERN, (sequence) =>
    sequence.replace(/[\s.,:;!?/+-]+/gu, ''),
  );
}
