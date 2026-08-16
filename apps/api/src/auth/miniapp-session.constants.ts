export const MINIAPP_SESSION_COOKIE_NAME = '__Host-maxim_session';
export const MINIAPP_CSRF_HEADER_NAME = 'x-miniapp-csrf-token';

export const DEFAULT_MINIAPP_SESSION_TTL_SEC = 8 * 60 * 60;
export const DEFAULT_MINIAPP_SESSION_REDIS_TIMEOUT_MS = 500;
export const MINIAPP_SESSION_MAX_PER_PRINCIPAL = 8;
export const MINIAPP_SESSION_CREATE_RATE_LIMIT = 12;
export const MINIAPP_SESSION_CREATE_RATE_WINDOW_SEC = 60;

export const MINIAPP_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const MINIAPP_CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
