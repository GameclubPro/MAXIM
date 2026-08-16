import { isMutationTunnelPreferredHost } from './api/transport-mutation-tunnel-hosts';
import { createMiniappBootTraceSessionId } from './boot-trace-session-id';
import type { MiniappBootTraceDetails } from './boot-trace-sanitizer';
import { getInitData } from './init-data';
import { API_BASE } from './public-config';

export { sanitizeMiniappBootTraceText } from './boot-trace-text-sanitizer';

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

type MiniappBootTraceOptions = {
  includeRoute?: boolean;
  maxElapsedMs?: number;
  once?: boolean;
  runtimeEnabled?: boolean;
};

export type MiniappBootTraceSnapshot = {
  phase: MiniappBootTracePhase;
  sessionId: string;
  sequence: number;
  elapsedMs: number;
  details?: MiniappBootTraceDetails;
  route: string | null;
  baseUrl?: string;
  platform: string | null;
  userAgent: string | null;
  mutationTunnelInitData: string | null;
};

const SESSION_STORAGE_KEY = 'maxim:miniappBootTraceSession';
const TRACE_OVERRIDE_STORAGE_KEY = 'maxim:miniappBootTraceOverride';
const startedAtMs = Date.now();
let sequence = 0;
let apiResultReported = false;
const reportedOnce = new Set<MiniappBootTracePhase>();
let runtimePromise: Promise<typeof import('./boot-trace-runtime')> | null = null;
let dispatchQueue = Promise.resolve();

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

  return typeof window !== 'undefined' && isMiniappBootTraceManuallyEnabled;
}

function loadRuntime(): Promise<typeof import('./boot-trace-runtime')> {
  if (!runtimePromise) {
    const loading = import('./boot-trace-runtime').catch((error: unknown) => {
      if (runtimePromise === loading) {
        runtimePromise = null;
      }
      throw error;
    });
    runtimePromise = loading;
  }
  return runtimePromise;
}

function enqueueTrace(snapshot: MiniappBootTraceSnapshot): void {
  dispatchQueue = dispatchQueue
    .then(async () => {
      const runtime = await loadRuntime();
      runtime.dispatchMiniappBootTrace(snapshot);
    })
    .catch(() => undefined);
}

export function traceMiniappBoot(
  phase: MiniappBootTracePhase,
  details?: MiniappBootTraceDetails,
  options: MiniappBootTraceOptions = {},
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

  const hasWindow = typeof window !== 'undefined';
  const useMutationTunnel = hasWindow && isMutationTunnelPreferredHost(API_BASE);
  const mutationTunnelInitData = useMutationTunnel ? getInitData() : null;
  if (useMutationTunnel && !mutationTunnelInitData) {
    return false;
  }

  enqueueTrace({
    phase,
    sessionId,
    sequence: ++sequence,
    elapsedMs,
    details,
    route:
      phase === 'publication_api' || options.includeRoute === false || !hasWindow
        ? null
        : `${window.location.pathname}${window.location.search}`,
    baseUrl: hasWindow ? window.location.href : undefined,
    platform: getMiniappBridgePlatform(),
    userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent.slice(0, 220),
    mutationTunnelInitData,
  });
  return true;
}

export function traceMiniappLaunchRoute(targetRoute: string | null, source: string): void {
  traceMiniappBoot(
    'route_resolved',
    {
      source,
      targetRoute,
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
