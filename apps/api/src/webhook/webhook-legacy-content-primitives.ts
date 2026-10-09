function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function identity(value: unknown): boolean {
  return typeof value === 'number'
    ? Number.isSafeInteger(value)
    : typeof value === 'string' && value.length > 0 && value.trim() === value;
}
export function isLegacyImageAttachment(value: unknown): boolean {
  const attachment = record(value);
  const payload = record(attachment?.payload);
  if (
    !attachment ||
    !payload ||
    !onlyKeys(attachment, ['type', 'payload']) ||
    !['image', 'photo'].includes(String(attachment.type)) ||
    !onlyKeys(payload, ['photo_id', 'token', 'url']) ||
    (payload.photo_id !== undefined && !identity(payload.photo_id)) ||
    (payload.token !== undefined && typeof payload.token !== 'string') ||
    (payload.url !== undefined && typeof payload.url !== 'string')
  )
    return false;
  if (payload.url !== undefined) {
    try {
      const url = new URL(payload.url as string);
      if (url.protocol !== 'https:' || url.username || url.password) return false;
    } catch {
      return false;
    }
  }
  return identity(payload.photo_id) || typeof payload.url === 'string';
}
// FLAG: MAX seq is opaque int64 metadata and can exceed JavaScript's exact integer
// range. The explicit mid alone supplies message identity; never derive ordering,
// identity or a timestamp from this rounded metadata value.
export function isLegacyOpaqueSequence(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= 2 ** 63)
  );
}
