const DEFAULT_COMMENTS_BUTTON_TEXT = '💬 Комментарии';
const COMMENTS_BUTTON_TEXT_LIMIT = 32;
const COMMENTS_BUTTON_SEPARATOR = ' · ';

function normalizeBaseText(value: string | null | undefined): string {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : DEFAULT_COMMENTS_BUTTON_TEXT;
}

function toSymbols(value: string): string[] {
  return Array.from(value);
}

function trimToSymbolLength(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return '';
  }

  return toSymbols(value).slice(0, maxLength).join('').trimEnd();
}

function formatCompactCount(value: number): string {
  const count = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

  if (count < 1_000) {
    return String(count);
  }

  if (count < 10_000) {
    return `${(count / 1_000).toFixed(1).replace(/\.0$/u, '').replace('.', ',')}K`;
  }

  if (count < 1_000_000) {
    return `${Math.floor(count / 1_000)}K`;
  }

  if (count < 10_000_000) {
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/u, '').replace('.', ',')}M`;
  }

  return `${Math.floor(count / 1_000_000)}M`;
}

export function formatCommentsButtonText(
  baseText: string | null | undefined,
  count: number,
): string {
  const normalizedBase = normalizeBaseText(baseText);
  const suffix = `${COMMENTS_BUTTON_SEPARATOR}${formatCompactCount(count)}`;
  const fullLabel = `${normalizedBase}${suffix}`;

  if (toSymbols(fullLabel).length <= COMMENTS_BUTTON_TEXT_LIMIT) {
    return fullLabel;
  }

  const maxBaseLength = COMMENTS_BUTTON_TEXT_LIMIT - toSymbols(suffix).length;
  const truncatedBase = trimToSymbolLength(normalizedBase, maxBaseLength);
  if (truncatedBase) {
    return `${truncatedBase}${suffix}`;
  }

  return trimToSymbolLength(`💬 ${formatCompactCount(count)}`, COMMENTS_BUTTON_TEXT_LIMIT);
}
