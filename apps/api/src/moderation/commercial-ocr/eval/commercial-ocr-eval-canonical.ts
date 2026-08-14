import { createHash } from 'node:crypto';

export function calculateCommercialOcrEvalCanonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalCommercialOcrEvalJson(value)).digest('hex');
}

export function canonicalCommercialOcrEvalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Commercial OCR canonical payload contains a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => (item === undefined ? 'null' : canonicalCommercialOcrEvalJson(item)))
      .join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalCommercialOcrEvalJson(record[key])}`,
      )
      .join(',')}}`;
  }
  throw new Error('Commercial OCR canonical payload contains an unsupported value');
}
