export const MAX_HTTP_BUTTON_URL_LENGTH = 2_048;

const NESTED_HTTP_BUTTON_URL_PATTERN = /(?:https?|max):\/\//iu;
const HTTP_BUTTON_URL_WHITESPACE_PATTERN = /\s/u;

function hasRawButtonUrlWhitespaceOrControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      HTTP_BUTTON_URL_WHITESPACE_PATTERN.test(character) ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return true;
    }
  }

  return false;
}

export function normalizeHttpButtonUrl(value: string): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (
    normalized.length === 0 ||
    normalized.length > MAX_HTTP_BUTTON_URL_LENGTH ||
    hasRawButtonUrlWhitespaceOrControl(normalized)
  ) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }

    let decodedPathname: string;
    try {
      decodedPathname = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
    if (
      NESTED_HTTP_BUTTON_URL_PATTERN.test(parsed.pathname) ||
      NESTED_HTTP_BUTTON_URL_PATTERN.test(decodedPathname)
    ) {
      return null;
    }

    const canonicalUrl = parsed.toString();
    return canonicalUrl.length <= MAX_HTTP_BUTTON_URL_LENGTH ? canonicalUrl : null;
  } catch {
    return null;
  }
}
