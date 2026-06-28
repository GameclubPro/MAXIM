export type PrivateControlPage<T> = {
  items: T[];
  page: number;
  pages: number;
  start: number;
  end: number;
};

export function paginatePrivateControlItems<T>(
  items: readonly T[],
  rawPage: number,
  pageSize: number,
): PrivateControlPage<T> {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.max(1, Math.min(pages, rawPage));
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, items.length);

  return {
    items: items.slice(start, end),
    page,
    pages,
    start,
    end,
  };
}

export function limitPrivateControlMessageText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return ' ';
  }

  if (trimmed.length <= 4000) {
    return trimmed;
  }

  const hardLimit = 3990;
  const chunk = trimmed.slice(0, hardLimit);
  const newlineIndex = chunk.lastIndexOf('\n');
  if (newlineIndex > 120) {
    return `${chunk.slice(0, newlineIndex).trimEnd()}\n...`;
  }

  return `${chunk.trimEnd()}...`;
}

export function formatPrivateControlAllowlistEntryLabel(entry: {
  domain: string;
  matchType: 'EXACT' | 'DOMAIN';
}): string {
  return entry.matchType === 'DOMAIN' ? `${entry.domain} [домен]` : `${entry.domain} [ссылка]`;
}

export function formatPrivateControlIsoDate(iso: string, timeZone?: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const formatterOptions: Intl.DateTimeFormatOptions = {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone?.trim() ? { timeZone: timeZone.trim() } : {}),
  };

  try {
    return new Intl.DateTimeFormat('ru-RU', formatterOptions).format(date);
  } catch {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }
}

export function formatPrivateControlDateTimeLabel(
  iso: string | null,
  timeZone?: string | null,
): string {
  if (!iso) {
    return 'не задано';
  }

  return formatPrivateControlIsoDate(iso, timeZone);
}

export function asPrivateControlRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function readPrivateControlLowerString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function readPrivateControlString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function readPrivateControlOptionalInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}
