import { isLegacyPassiveMarkup } from './webhook-legacy-direct-source';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function sourceAbandonmentHttpsUrl(value: unknown): boolean {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 8192 ||
    value !== value.trim() ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  )
    return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

// FLAG: Modern link formatting decorates only the original bounded text. Its
// URL or bounded numeric user mention never supplies a secondary mutation target.
// Unknown metadata remains refused. Bounds use the original JavaScript UTF-16 text.
export function isSourceAbandonmentMarkup(value: unknown, text: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 64 || typeof text !== 'string') return false;
  return value.every((entry) => {
    if (isLegacyPassiveMarkup([entry], text)) return true;
    const item = record(entry);
    if (
      !item ||
      typeof item.from !== 'number' ||
      !Number.isSafeInteger(item.from) ||
      item.from < 0 ||
      typeof item.length !== 'number' ||
      !Number.isSafeInteger(item.length) ||
      item.length <= 0 ||
      item.from + item.length > text.length
    )
      return false;
    if (item.type === 'user_mention')
      return (
        onlyKeys(item, ['type', 'from', 'length', 'user_id']) &&
        typeof item.user_id === 'number' &&
        Number.isSafeInteger(item.user_id) &&
        item.user_id > 0
      );
    return (
      item.type === 'link' &&
      onlyKeys(item, ['type', 'from', 'length', 'url']) &&
      typeof item.url === 'string' &&
      item.url.length <= 2048 &&
      sourceAbandonmentHttpsUrl(item.url)
    );
  });
}

// FLAG: MAX may duplicate a forward's linked markup onto its empty outer body.
// Accept that decoration only when it is byte-identical to the independently
// validated linked markup. Never use composed/normalized text to invent offsets.
export function isSourceAbandonmentOuterMarkup(
  body: Record<string, unknown>,
  linkValue: unknown,
): boolean {
  if (isSourceAbandonmentMarkup(body.markup, body.text)) return true;
  const link = record(linkValue),
    linked = record(link?.message);
  return Boolean(
    body.text === '' &&
    link?.type === 'forward' &&
    linked &&
    Array.isArray(body.markup) &&
    body.markup.length <= 64 &&
    isSourceAbandonmentMarkup(linked.markup, linked.text) &&
    JSON.stringify(body.markup) === JSON.stringify(linked.markup),
  );
}
