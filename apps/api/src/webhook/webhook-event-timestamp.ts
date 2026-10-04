const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

// FLAG: Only numeric Unix timestamps may need seconds conversion. Date/string parsing
// already returns milliseconds; invalid normalized dates must not become lifecycle evidence.
export function parseWebhookEventTimestampMs(value: unknown): number | null {
  const parsed =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value < 10_000_000_000
          ? value * 1_000
          : value
        : typeof value === 'string' && value.trim().length > 0
          ? Date.parse(value)
          : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_DATE_TIMESTAMP_MS) {
    return null;
  }

  const timestampMs = Math.trunc(parsed);
  return timestampMs > 0 ? timestampMs : null;
}
