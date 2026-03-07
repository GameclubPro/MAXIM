const MASKED_EXCERPT_MAX_SYMBOLS = 220;

export function maskText(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, ' ');
  if (!normalized) {
    return '';
  }

  const symbols = Array.from(normalized);
  if (symbols.length <= MASKED_EXCERPT_MAX_SYMBOLS) {
    return normalized;
  }

  return `${symbols.slice(0, MASKED_EXCERPT_MAX_SYMBOLS - 3).join('')}...`;
}
