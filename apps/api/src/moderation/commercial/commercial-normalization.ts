import { normalizeForDetection } from '../rule-engine-normalization';

export function normalizeCommercialText(value: string): string {
  return normalizeForDetection(value);
}

