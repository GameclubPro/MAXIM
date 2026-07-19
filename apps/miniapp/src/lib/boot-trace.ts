import { getInitData } from './init-data';
import { isMutationTunnelPreferredHost } from './api/transport-mutation-tunnel-hosts';
import { buildMutationTunnelPathSync } from './api/transport-mutation-tunnel-path';
import { createMiniappBootTraceSessionId } from './boot-trace-session-id';
import { API_BASE } from './public-config';

type MiniappBootTracePhase =
  | 'index_loaded'
  | 'bridge_ready'
  | 'init_data_found'
  | 'init_data_waiting'
  | 'route_resolved'
  | 'first_render'
  | 'api_ok'
  | 'api_error'
  | 'publication_api';

type MiniappBootTraceDetails = Record<string, unknown>;

const SESSION_STORAGE_KEY = 'maxim:miniappBootTraceSession';
const TRACE_OVERRIDE_STORAGE_KEY = 'maxim:miniappBootTraceOverride';
const REDACTED = '[redacted]';
const MAX_DETAIL_STRING_LENGTH = 240;
const MAX_DETAILS_JSON_LENGTH = 1_500;
const MAX_ROUTE_LENGTH = 320;
const SENSITIVE_PARAM_PATTERN =
  /(?:token|webapp|init[_-]?data|authorization|hash|secret|sig|start(?:app|[_-]?param))/iu;
const SENSITIVE_EXACT_PARAM_KEYS = new Set(['q', 'query', 'search']);
const TRACE_PATH = '/system/miniapp-boot-trace';

const startedAtMs = Date.now();
let sequence = 0;
let apiResultReported = false;
const reportedOnce = new Set<MiniappBootTracePhase>();

function getSessionId(): string {
  if (typeof window === 'undefined') {
    return createMiniappBootTraceSessionId();
  }

  try {
    const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) {
      return existing;
    }

    const next = createMiniappBootTraceSessionId();
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, next);
    return next;
  } catch {
    return createMiniappBootTraceSessionId();
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

export const isMiniappBootTraceManuallyEnabled = getManualTraceOverride();

export function getMiniappBridgePlatform(): string | null {
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
  const platform = getMiniappBridgePlatform()?.toLowerCase();
  const isIosMax =
    /(?:iPhone|iPad|iPod)/iu.test(userAgent) && (/\bMAX\//u.test(userAgent) || platform === 'ios');

  if (isIosMax) {
    return true;
  }

  if (typeof window === 'undefined') {
    return false;
  }

  return isMiniappBootTraceManuallyEnabled;
}

function sanitizeRoute(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value, typeof window !== 'undefined' ? window.location.href : undefined);
    const search = new URLSearchParams();
    parsed.searchParams.forEach((paramValue, key) => {
      search.append(
        key,
        isSensitiveTraceKey(key)
          ? REDACTED
          : sanitizeMiniappBootTraceText(paramValue, MAX_DETAIL_STRING_LENGTH),
      );
    });

    const query = search.toString();
    const route = `${parsed.pathname}${query ? `?${query}` : ''}`;
    return route.slice(0, MAX_ROUTE_LENGTH);
  } catch {
    return sanitizeMiniappBootTraceText(value, MAX_ROUTE_LENGTH);
  }
}

export function sanitizeMiniappBootTraceText(
  value: string,
  maxLength = MAX_DETAIL_STRING_LENGTH,
): string {
  const redactedQueryValues = value.replace(
    /(^|[?&#\s|,;])([^=?&#\s|,;]{1,100})=([^&#\s|,;]*)/g,
    (match: string, separator: string, key: string) => {
      return isSensitiveTraceKey(decodeURIComponentSafe(key))
        ? `${separator}${key}=${REDACTED}`
        : match;
    },
  );
  const redactedLaunchParamAssignments = redactedQueryValues.replace(
    /\b((?:WebAppStartParam|startapp|start[-_]?param)\s*=\s*)[^\s&#,;|]+/giu,
    (_match: string, prefix: string) => `${prefix}${REDACTED}`,
  );

  const redactedAuthorization = redactedLaunchParamAssignments.replace(
    /\b(authorization\s*[:=]\s*)((?:bearer|initdata)\s+)?[^\r\n,;]+/giu,
    (_match: string, prefix: string, scheme = '') => `${prefix}${scheme}${REDACTED}`,
  );

  return redactChannelDialogPayloadFragments(redactedAuthorization).slice(0, maxLength);
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeMiniappBootTraceText(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 12).map(sanitizeValue);
  }

  if (typeof value === 'object' && value !== null) {
    const sanitized: MiniappBootTraceDetails = {};
    const redactDialogPayloadToken = isChannelDialogLaunchPayload(value);
    for (const [key, entryValue] of Object.entries(value).slice(0, 16)) {
      sanitized[key] =
        isSensitiveTraceKey(key) || (redactDialogPayloadToken && isDialogTokenKey(key))
          ? REDACTED
          : sanitizeValue(entryValue);
    }
    return sanitized;
  }

  return undefined;
}

function isDialogTokenKey(key: string): boolean {
  return key.trim().toLowerCase() === 't';
}

function isSensitiveTraceKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return SENSITIVE_EXACT_PARAM_KEYS.has(normalized) || SENSITIVE_PARAM_PATTERN.test(normalized);
}

function isChannelDialogLaunchPayload(value: object): boolean {
  const payload = value as MiniappBootTraceDetails;
  return payload.k === 'channel-dialog' || payload.k === 'chat-dialog';
}

function redactChannelDialogPayloadFragments(value: string): string {
  const redactedPayload = value.replace(/\bcd-[A-Za-z0-9_-]{16,}/gu, `cd-${REDACTED}`);
  if (!/["']k["']\s*:\s*["'](?:channel-dialog|chat-dialog)["']/u.test(redactedPayload)) {
    return redactedPayload;
  }

  return redactedPayload.replace(/(["']t["']\s*:\s*["'])[^"']{1,512}(["'])/gu, `$1${REDACTED}$2`);
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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

function shouldUseMutationTunnel(apiBase: string): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return isMutationTunnelPreferredHost(apiBase);
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
      const tunnelPath = buildMutationTunnelPathSync(TRACE_PATH, {
        method: 'POST',
        headers,
        body,
      });
      if (!tunnelPath) {
        return null;
      }

      return {
        url: `${API_BASE}${tunnelPath}`,
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
  options: {
    includeRoute?: boolean;
    maxElapsedMs?: number;
    once?: boolean;
    runtimeEnabled?: boolean;
  } = {},
): boolean {
  if (!(options.runtimeEnabled ?? isTraceEnabled())) {
    return false;
  }

  if (options.once && reportedOnce.has(phase)) {
    return false;
  }
  if (options.once) {
    reportedOnce.add(phase);
  }

  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  if (options.maxElapsedMs !== undefined && elapsedMs > options.maxElapsedMs) {
    return false;
  }
  const payload: Record<string, unknown> = {
    phase,
    sessionId,
    sequence: ++sequence,
    elapsedMs,
    details: sanitizeDetails(details),
  };
  const route =
    phase === 'publication_api' || options.includeRoute === false ? null : getCurrentRoute();
  const platform = getMiniappBridgePlatform();
  const ua = typeof navigator === 'undefined' ? null : navigator.userAgent.slice(0, 220);
  if (route) {
    payload.route = route;
  }
  if (platform) {
    payload.platform = platform;
  }
  if (ua) {
    payload.ua = ua;
  }

  const request = buildTraceRequest(payload);
  if (!request) {
    return false;
  }

  void fetch(request.url, request.init).catch(() => undefined);
  return true;
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
