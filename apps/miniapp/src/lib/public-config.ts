const DEFAULT_API_BASE = '/api/v1';
const DEFAULT_PUBLIC_BASE_PATH = '/app/';

function normalizeBasePath(value: string | undefined, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return fallback;
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

export function normalizeApiBase(value: string | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return DEFAULT_API_BASE;
  }

  const normalized = /^(?:https?:)?\/\//iu.test(trimmed)
    ? trimmed
    : trimmed.startsWith('/')
      ? trimmed
      : `/${trimmed}`;

  return normalized.replace(/\/+$/u, '') || '/';
}

export function normalizeApiFallbackBases(value: string | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of (value ?? '').split(',')) {
    const normalized = normalizeApiBase(item);
    if (!item.trim() || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

export function normalizeApiBases(primary: string, fallbacks: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const base of [primary, ...fallbacks]) {
    const normalized = normalizeApiBase(base);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result.length ? result : [DEFAULT_API_BASE];
}

export const PUBLIC_BASE_PATH = normalizeBasePath(
  import.meta.env?.VITE_PUBLIC_BASE_PATH,
  DEFAULT_PUBLIC_BASE_PATH,
);
export const PUBLIC_ROUTER_BASENAME = PUBLIC_BASE_PATH.replace(/\/+$/u, '');
export const API_BASE = normalizeApiBase(import.meta.env?.VITE_API_BASE);
export const API_BASES = import.meta.env?.VITE_API_FALLBACK_BASES
  ? normalizeApiBases(API_BASE, normalizeApiFallbackBases(import.meta.env.VITE_API_FALLBACK_BASES))
  : [API_BASE];
export const HEALTH_BASE = API_BASE.replace(/\/v1$/u, '');

export function resolveRuntimeApiBases(): string[] {
  return API_BASES;
}

export function resolveRuntimeHealthBase(): string {
  return HEALTH_BASE;
}
