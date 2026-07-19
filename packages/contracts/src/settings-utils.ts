import { z } from 'zod';

export const DELETE_BOT_MESSAGES_DELAY_MIN_MINUTES = 0.5;
export const DELETE_BOT_MESSAGES_DELAY_MAX_MINUTES = 60;
export const DELETE_BOT_MESSAGES_DELAY_DEFAULT_MINUTES = 2;
export const DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES = Object.freeze([
  DELETE_BOT_MESSAGES_DELAY_MIN_MINUTES,
  ...Array.from({ length: DELETE_BOT_MESSAGES_DELAY_MAX_MINUTES }, (_, index) => index + 1),
]);

export function isValidDeleteBotMessagesDelayMinutes(value: number): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }

  return DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES.some(
    (candidate) => Math.abs(candidate - value) < 1e-9,
  );
}

export function normalizeDeleteBotMessagesDelayMinutes(value: number): number {
  if (!Number.isFinite(value)) {
    return DELETE_BOT_MESSAGES_DELAY_DEFAULT_MINUTES;
  }

  let closest = DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES[0];
  let closestDistance = Math.abs(closest - value);

  for (const candidate of DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES.slice(1)) {
    const distance = Math.abs(candidate - value);
    if (distance < closestDistance || (distance === closestDistance && candidate > closest)) {
      closest = candidate;
      closestDistance = distance;
    }
  }

  return closest;
}

export function stepDeleteBotMessagesDelayMinutes(value: number, direction: number): number {
  const normalized = normalizeDeleteBotMessagesDelayMinutes(value);
  const currentIndex = DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES.findIndex(
    (candidate) => Math.abs(candidate - normalized) < 1e-9,
  );
  if (currentIndex < 0) {
    return normalized;
  }

  const nextIndex = Math.min(
    DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES.length - 1,
    Math.max(0, currentIndex + Math.sign(direction)),
  );

  return DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES[nextIndex] ?? normalized;
}

export function formatDeleteBotMessagesDelayLabel(value: number): string {
  const normalized = normalizeDeleteBotMessagesDelayMinutes(value);
  if (normalized < 1) {
    return '30 сек';
  }

  return `${normalized} мин`;
}

const ALLOWLIST_URL_CANDIDATE_PATTERN =
  /(?:https?:\/\/|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:xn--[a-z0-9-]{2,59}|[a-z]{2,24}|рф))[^\s<>"'()[\]{}]*/iu;
const ALLOWLIST_TRAILING_URL_PUNCTUATION = new Set([')', ']', '}', ',', '.', ';', '!', '?', ':']);
const ENCODED_WHITESPACE_PATTERN = /%(?:09|0a|0d|20)/i;
const ALLOWLIST_HOST_ALIASES = new Map<string, string>([
  ['vk.com', 'vk.com'],
  ['www.vk.com', 'vk.com'],
  ['vk.ru', 'vk.com'],
  ['www.vk.ru', 'vk.com'],
  ['instagram.com', 'instagram.com'],
  ['www.instagram.com', 'instagram.com'],
]);

export const ALLOWLIST_DOMAIN_RULE_PREFIX = 'domain:';
export const allowlistMatchTypeSchema = z.enum(['EXACT', 'DOMAIN']);
export type AllowlistMatchType = z.infer<typeof allowlistMatchTypeSchema>;

type ParsedAllowlistCandidate = {
  protocol: 'http:' | 'https:';
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
};

function tryDecodeUriComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function trimAllowlistTrailingUrlPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && ALLOWLIST_TRAILING_URL_PUNCTUATION.has(value[end - 1] ?? '')) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function extractAllowlistUrlCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const decoded = tryDecodeUriComponent(trimmed);
  const candidates =
    decoded && decoded !== trimmed && ENCODED_WHITESPACE_PATTERN.test(trimmed)
      ? [decoded, trimmed]
      : decoded && decoded !== trimmed
        ? [trimmed, decoded]
        : [trimmed];

  for (const candidate of candidates) {
    const match = candidate.match(ALLOWLIST_URL_CANDIDATE_PATTERN);
    if (!match) {
      continue;
    }

    const extracted = trimAllowlistTrailingUrlPunctuation(match[0]);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

function canonicalizeAllowlistHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  return ALLOWLIST_HOST_ALIASES.get(normalized) ?? normalized;
}

function parseAllowlistCandidate(value: string): ParsedAllowlistCandidate | null {
  const raw = extractAllowlistUrlCandidate(value);
  if (!raw) {
    return null;
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    return null;
  }

  const hostname = canonicalizeAllowlistHostname(parsed.hostname);
  if (!hostname) {
    return null;
  }

  return {
    protocol,
    hostname,
    port: parsed.port,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  };
}

export function normalizeAllowlistLink(value: string): string | null {
  const parsed = parseAllowlistCandidate(value);
  if (!parsed) {
    return null;
  }

  const shouldKeepPort =
    parsed.port.length > 0 &&
    !(
      (parsed.protocol === 'https:' && parsed.port === '443') ||
      (parsed.protocol === 'http:' && parsed.port === '80')
    );
  const port = shouldKeepPort ? `:${parsed.port}` : '';
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname;

  return `${parsed.protocol}//${parsed.hostname}${port}${pathname}${parsed.search}${parsed.hash}`;
}

export function normalizeAllowlistDomain(value: string): string | null {
  const parsed = parseAllowlistCandidate(value);
  if (!parsed) {
    return null;
  }

  return parsed.hostname;
}

export function inferAllowlistMatchType(value: string): AllowlistMatchType | null {
  const parsed = parseAllowlistCandidate(value);
  if (!parsed) {
    return null;
  }

  if (parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0) {
    return 'EXACT';
  }

  return 'DOMAIN';
}

export function normalizeStoredAllowlistEntry(
  value: string,
  matchType: AllowlistMatchType,
): string | null {
  if (matchType === 'DOMAIN') {
    const normalizedDomain = normalizeAllowlistDomain(value);
    return normalizedDomain ? `${ALLOWLIST_DOMAIN_RULE_PREFIX}${normalizedDomain}` : null;
  }

  return normalizeAllowlistLink(value);
}

export function parseStoredAllowlistEntry(value: string): {
  domain: string;
  normalizedValue: string;
  matchType: AllowlistMatchType;
} | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.toLowerCase().startsWith(ALLOWLIST_DOMAIN_RULE_PREFIX)) {
    const normalizedDomain = normalizeAllowlistDomain(
      trimmed.slice(ALLOWLIST_DOMAIN_RULE_PREFIX.length),
    );
    if (!normalizedDomain) {
      return null;
    }

    return {
      domain: normalizedDomain,
      normalizedValue: `${ALLOWLIST_DOMAIN_RULE_PREFIX}${normalizedDomain}`,
      matchType: 'DOMAIN',
    };
  }

  const normalizedLink = normalizeAllowlistLink(trimmed);
  if (!normalizedLink) {
    return null;
  }

  return {
    domain: normalizedLink,
    normalizedValue: normalizedLink,
    matchType: 'EXACT',
  };
}
