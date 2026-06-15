import { getInitData } from './init-data';
import { API_BASE } from './public-config';

type MiniappBootTracePhase =
  | 'index_loaded'
  | 'bridge_ready'
  | 'init_data_found'
  | 'init_data_waiting'
  | 'route_resolved'
  | 'first_render'
  | 'api_ok'
  | 'api_error';

type MiniappBootTraceDetails = Record<string, unknown>;

const SESSION_STORAGE_KEY = 'maxim:miniappBootTraceSession';
const TRACE_OVERRIDE_STORAGE_KEY = 'maxim:miniappBootTraceOverride';
const MAX_DETAIL_STRING_LENGTH = 240;
const MAX_DETAILS_JSON_LENGTH = 1_500;
const MAX_ROUTE_LENGTH = 320;
const SENSITIVE_PARAM_PATTERN = /(?:token|webapp|init[_-]?data|authorization|hash|secret|sig)/iu;
const CDN_API_HOSTS = new Set(['api-cdn.flex-craft.ru', 'api2.major-maksimov.ru']);
const TRACE_PATH = '/system/miniapp-boot-trace';

const startedAtMs = Date.now();
let sequence = 0;
let apiResultReported = false;
const reportedOnce = new Set<MiniappBootTracePhase>();

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getSessionId(): string {
  if (typeof window === 'undefined') {
    return createSessionId();
  }

  try {
    const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) {
      return existing;
    }

    const next = createSessionId();
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, next);
    return next;
  } catch {
    return createSessionId();
  }
}

const sessionId = getSessionId();

function getManualTraceOverride(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const enabledFromUrl = params.get('bootTrace') === '1';
    if (params.has('bootTrace')) {
      params.delete('bootTrace');
      const search = params.toString();
      const nextUrl = `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`;
      window.history.replaceState(window.history.state, '', nextUrl);
    }

    if (enabledFromUrl) {
      window.sessionStorage.setItem(TRACE_OVERRIDE_STORAGE_KEY, '1');
      return true;
    }

    return window.sessionStorage.getItem(TRACE_OVERRIDE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

const manualTraceOverride = getManualTraceOverride();

function getBridgePlatform(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const value = window.MAX?.WebApp?.platform ?? window.WebApp?.platform;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 32) : null;
}

function isTraceEnabled(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent || '';
  const platform = getBridgePlatform()?.toLowerCase();
  const isIosMax =
    /(?:iPhone|iPad|iPod)/iu.test(userAgent) && (/\bMAX\//u.test(userAgent) || platform === 'ios');

  if (isIosMax) {
    return true;
  }

  if (typeof window === 'undefined') {
    return false;
  }

  return manualTraceOverride;
}

function sanitizeRoute(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value, typeof window !== 'undefined' ? window.location.href : undefined);
    const search = new URLSearchParams();
    parsed.searchParams.forEach((paramValue, key) => {
      search.append(key, SENSITIVE_PARAM_PATTERN.test(key) ? '[redacted]' : paramValue);
    });

    const query = search.toString();
    const route = `${parsed.pathname}${query ? `?${query}` : ''}`;
    return route.slice(0, MAX_ROUTE_LENGTH);
  } catch {
    return value.replace(/([?&][^=]*(?:token|WebAppData|initData|init_data)[^=]*=)[^&#]*/giu, '$1[redacted]')
      .slice(0, MAX_ROUTE_LENGTH);
  }
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.slice(0, MAX_DETAIL_STRING_LENGTH);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 12).map(sanitizeValue);
  }

  if (typeof value === 'object' && value !== null) {
    const sanitized: MiniappBootTraceDetails = {};
    for (const [key, entryValue] of Object.entries(value).slice(0, 16)) {
      sanitized[key] = SENSITIVE_PARAM_PATTERN.test(key) ? '[redacted]' : sanitizeValue(entryValue);
    }
    return sanitized;
  }

  return undefined;
}

function sanitizeDetails(details: MiniappBootTraceDetails | undefined): MiniappBootTraceDetails {
  const sanitized = sanitizeValue(details ?? {});
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return {};
  }

  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= MAX_DETAILS_JSON_LENGTH) {
    return sanitized as MiniappBootTraceDetails;
  }

  return {
    truncated: true,
    length: serialized.length,
  };
}

function getCurrentRoute(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return sanitizeRoute(`${window.location.pathname}${window.location.search}`);
}

function encodeBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return window.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function shouldUseMutationTunnel(apiBase: string): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return CDN_API_HOSTS.has(new URL(apiBase, window.location.href).hostname);
  } catch {
    return [...CDN_API_HOSTS].some((host) => apiBase.includes(host));
  }
}

function buildTraceRequest(payload: unknown): {
  url: string;
  init: RequestInit;
} | null {
  const body = JSON.stringify(payload);
  const headers = new Headers({
    'Content-Type': 'application/json',
  });

  if (shouldUseMutationTunnel(API_BASE)) {
    const initData = getInitData();
    if (initData) {
      headers.set('Authorization', `InitData ${initData}`);
      const params = new URLSearchParams({
        method: 'POST',
        path: TRACE_PATH,
        nonce: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        contentType: 'application/json',
        body: encodeBase64UrlUtf8(body),
      });

      return {
        url: `${API_BASE}/_mutation-tunnel?${params.toString()}`,
        init: {
          method: 'GET',
          headers,
          keepalive: true,
        },
      };
    }

    return null;
  }

  return {
    url: `${API_BASE}${TRACE_PATH}`,
    init: {
      method: 'POST',
      headers,
      body,
      keepalive: true,
    },
  };
}

export function traceMiniappBoot(
  phase: MiniappBootTracePhase,
  details?: MiniappBootTraceDetails,
  options: { once?: boolean } = {},
): void {
  if (!isTraceEnabled()) {
    return;
  }

  if (options.once && reportedOnce.has(phase)) {
    return;
  }
  if (options.once) {
    reportedOnce.add(phase);
  }

  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const payload = {
    phase,
    sessionId,
    sequence: ++sequence,
    elapsedMs,
    route: getCurrentRoute(),
    platform: getBridgePlatform(),
    ua: typeof navigator === 'undefined' ? null : navigator.userAgent.slice(0, 220),
    details: sanitizeDetails(details),
  };

  const request = buildTraceRequest(payload);
  if (!request) {
    return;
  }

  void fetch(request.url, request.init).catch(() => undefined);
}

export function traceMiniappLaunchRoute(targetRoute: string | null, source: string): void {
  traceMiniappBoot(
    'route_resolved',
    {
      source,
      targetRoute: targetRoute ? sanitizeRoute(targetRoute) : null,
    },
    { once: true },
  );
}

export function traceFirstMiniappApiResult(details: MiniappBootTraceDetails): void {
  if (apiResultReported) {
    return;
  }

  apiResultReported = true;
  traceMiniappBoot(details.ok === false ? 'api_error' : 'api_ok', details);
}
