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

function normalizeApiBase(value: string | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return DEFAULT_API_BASE;
  }

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export const PUBLIC_BASE_PATH = normalizeBasePath(
  import.meta.env.VITE_PUBLIC_BASE_PATH,
  DEFAULT_PUBLIC_BASE_PATH,
);
export const PUBLIC_ROUTER_BASENAME = PUBLIC_BASE_PATH.replace(/\/+$/u, '');
export const API_BASE = normalizeApiBase(import.meta.env.VITE_API_BASE);
export const HEALTH_BASE = API_BASE.replace(/\/v1$/u, '');
