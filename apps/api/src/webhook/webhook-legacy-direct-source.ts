import { isLegacyImageAttachment } from './webhook-legacy-forward-source';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function httpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

// FLAG: Official passive VideoAttachment metadata only; no download, execution,
// nested content or additional target authority. The enclosing original mid/author
// and permanent holds remain mandatory. Unknown attachment families stay blocked.
function video(value: unknown): boolean {
  const item = record(value);
  const payload = record(item?.payload);
  return Boolean(
    item &&
    item.type === 'video' &&
    onlyKeys(item, ['type', 'payload', 'thumbnail', 'width', 'height', 'duration']) &&
    payload &&
    onlyKeys(payload, ['url', 'token']) &&
    httpsUrl(payload.url) &&
    typeof payload.token === 'string' &&
    payload.token.length > 0 &&
    payload.token.length <= 32768 &&
    (item.thumbnail === undefined || item.thumbnail === null || httpsUrl(item.thumbnail)) &&
    ['width', 'height', 'duration'].every(
      (key) =>
        item[key] === undefined ||
        item[key] === null ||
        (typeof item[key] === 'number' &&
          Number.isSafeInteger(item[key]) &&
          item[key] >= 0 &&
          item[key] <= 2147483647),
    ),
  );
}

export function isLegacyDirectMedia(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 10 &&
      value.every((item) => isLegacyImageAttachment(item) || video(item)))
  );
}

// FLAG: Formatting may only decorate the same bounded original text. Mentions,
// links, unknown data and secondary identities do not gain abandonment authority.
export function isLegacyPassiveMarkup(value: unknown, text: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 64 || typeof text !== 'string') return false;
  return value.every((entry) => {
    const item = record(entry);
    return Boolean(
      item &&
      onlyKeys(item, ['type', 'from', 'length']) &&
      [
        'strong',
        'emphasized',
        'monospaced',
        'strikethrough',
        'underline',
        'heading',
        'highlighted',
        'quote',
      ].includes(String(item.type)) &&
      typeof item.from === 'number' &&
      Number.isSafeInteger(item.from) &&
      item.from >= 0 &&
      typeof item.length === 'number' &&
      Number.isSafeInteger(item.length) &&
      item.length > 0 &&
      item.from + item.length <= text.length,
    );
  });
}
