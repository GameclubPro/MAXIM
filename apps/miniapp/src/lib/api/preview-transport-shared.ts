export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function parseJsonBody(init?: RequestInit): unknown {
  if (!init?.body || typeof init.body !== 'string') {
    return null;
  }

  return JSON.parse(init.body);
}

export function addHours(value: Date, hours: number): Date {
  return new Date(value.getTime() + hours * 60 * 60 * 1_000);
}

export function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60 * 1_000);
}

export function addDays(value: Date, days: number): Date {
  return addHours(value, days * 24);
}

export function buildAuthorBadge(value: string | null | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    return 'MX';
  }

  const words = normalized
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);

  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
  }

  return normalized.slice(0, 2).toUpperCase();
}

export function buildPreviewAvatarDataUrl(
  label: string,
  startColor: string,
  endColor: string,
): string {
  const initials = buildAuthorBadge(label);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
      <defs>
        <linearGradient id="avatar-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${startColor}" />
          <stop offset="100%" stop-color="${endColor}" />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="28" fill="url(#avatar-gradient)" />
      <text
        x="50%"
        y="52%"
        dominant-baseline="middle"
        text-anchor="middle"
        font-family="Manrope, Arial, sans-serif"
        font-size="34"
        font-weight="700"
        fill="#ffffff"
      >${initials}</text>
    </svg>
  `.trim();

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export function buildPreviewProfileUrl(handle: string): string {
  return `https://max.ru/${encodeURIComponent(handle)}`;
}

export function buildPreviewProfileHandoffUrl(seed: string): string {
  return `https://max.ru/id613002203036_bot?start=${encodeURIComponent(`preview-profile-${seed}`)}`;
}
