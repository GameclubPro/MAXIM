import { buildMutationTunnelPathSync } from './api/transport-mutation-tunnel-path';
import {
  sanitizeMiniappBootTraceDetails,
  sanitizeMiniappBootTraceRoute,
  type MiniappBootTraceDetails,
} from './boot-trace-sanitizer';
import type { MiniappBootTraceSnapshot } from './boot-trace';
import { API_BASE } from './public-config';

const TRACE_PATH = '/system/miniapp-boot-trace';

function buildTraceRequest(
  payload: unknown,
  mutationTunnelInitData: string | null,
): { url: string; init: RequestInit } | null {
  const body = JSON.stringify(payload);
  const headers = new Headers({
    'Content-Type': 'application/json',
  });

  if (mutationTunnelInitData !== null) {
    headers.set('Authorization', `InitData ${mutationTunnelInitData}`);
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

function prepareDetails(snapshot: MiniappBootTraceSnapshot): MiniappBootTraceDetails | undefined {
  if (snapshot.phase !== 'route_resolved' || !snapshot.details) {
    return snapshot.details;
  }

  const targetRoute = snapshot.details.targetRoute;
  return {
    ...snapshot.details,
    targetRoute:
      typeof targetRoute === 'string'
        ? sanitizeMiniappBootTraceRoute(targetRoute, snapshot.baseUrl)
        : targetRoute,
  };
}

export function dispatchMiniappBootTrace(snapshot: MiniappBootTraceSnapshot): void {
  const payload: Record<string, unknown> = {
    phase: snapshot.phase,
    sessionId: snapshot.sessionId,
    sequence: snapshot.sequence,
    elapsedMs: snapshot.elapsedMs,
    details: sanitizeMiniappBootTraceDetails(prepareDetails(snapshot)),
  };
  const route = sanitizeMiniappBootTraceRoute(snapshot.route, snapshot.baseUrl);
  if (route) {
    payload.route = route;
  }
  if (snapshot.platform) {
    payload.platform = snapshot.platform;
  }
  if (snapshot.userAgent) {
    payload.ua = snapshot.userAgent;
  }

  const request = buildTraceRequest(payload, snapshot.mutationTunnelInitData);
  if (request) {
    void fetch(request.url, request.init).catch(() => undefined);
  }
}
