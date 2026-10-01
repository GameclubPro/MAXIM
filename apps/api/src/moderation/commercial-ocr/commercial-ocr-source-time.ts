// FLAG: Update.timestamp identifies the event; only the selected Message's creation fields
// identify the immutable OCR source. Never fall back to a containing event's timestamp.
export function extractCommercialOcrSourceCreatedAt(value: unknown): string | null {
  const message = selectCommercialOcrMessageNode(value);
  return message ? extractCommercialOcrMessageCreatedAt(message) : null;
}

export function extractCommercialOcrMessageCreatedAt(
  message: Record<string, unknown>,
): string | null {
  const body = asRecord(message.body);
  for (const candidate of [
    message.timestamp,
    message.created_at,
    message.createdAt,
    body?.timestamp,
    body?.created_at,
    body?.createdAt,
  ]) {
    const parsed =
      candidate instanceof Date
        ? candidate.getTime()
        : typeof candidate === 'number'
          ? candidate
          : typeof candidate === 'string' && candidate.trim()
            ? Number.isFinite(Number(candidate))
              ? Number(candidate)
              : Date.parse(candidate)
            : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      continue;
    }
    const timestampMs = parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
    const date = new Date(timestampMs);
    if (Number.isFinite(date.getTime())) {
      return date.toISOString();
    }
  }
  return null;
}

export function selectCommercialOcrMessageNode(value: unknown): Record<string, unknown> | null {
  const root = asRecord(value);
  if (!root) {
    return null;
  }
  for (const candidate of [
    root.message,
    asRecord(root.message_created)?.message,
    asRecord(root.data)?.message,
    asRecord(root.event)?.message,
  ]) {
    const row = asRecord(candidate);
    if (row) {
      return row;
    }
  }
  return 'message' in root || 'update_type' in root || root.type === 'message_created'
    ? null
    : root;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
