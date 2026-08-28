import type { AuthSessionCoordinator } from '../auth-session-coordinator';
import { traceFirstMiniappApiResult } from '../boot-trace';
import { resolveRuntimeApiBases } from '../public-config';
import type { MiniappServerSessionManager } from './miniapp-server-session';
import { isMutationTunnelPreferredHost } from './transport-mutation-tunnel-hosts';
import { buildMutationTunnelPathSync } from './transport-mutation-tunnel-path';
const INIT_DATA_REFRESH_WAIT_MS = 1_000;
const INIT_DATA_REFRESH_POLL_INTERVAL_MS = 50;
const API_REQUEST_TIMEOUT_MS = 25_000;
const API_FALLBACKS_ENABLED =
  typeof __MAXIM_API_FALLBACKS_ENABLED__ === 'boolean' ? __MAXIM_API_FALLBACKS_ENABLED__ : true;

export type ApiRequestInit = RequestInit & {
  timeoutMs?: number;
  retryMutationOnTransportError?: boolean;
};

export type ApiTransport = {
  request: (path: string, init?: ApiRequestInit) => Promise<unknown>;
  requestKeepalive: (path: string, init?: RequestInit) => void;
};

export type ApiTransportOptions = {
  apiBases?: readonly string[];
  authSession?: AuthSessionCoordinator;
  durableSession?: boolean;
  serverSession?: MiniappServerSessionManager;
};

type FetchAttemptResult = {
  apiBase: string;
  response: Response;
};

function resolveInitDataValue(initData: string | (() => string)): string {
  return (typeof initData === 'function' ? initData() : initData).trim();
}

async function waitForUpdatedInitData(
  readInitData: (refresh?: boolean) => string,
  currentInitData: string,
): Promise<string> {
  const initialAttempt = readInitData(true);
  if (initialAttempt && initialAttempt !== currentInitData) {
    return initialAttempt;
  }

  const startedAt = Date.now();
  let latestInitData = initialAttempt;

  while (!latestInitData || latestInitData === currentInitData) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = INIT_DATA_REFRESH_WAIT_MS - elapsedMs;
    if (remainingMs <= 0) {
      return latestInitData;
    }

    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, Math.min(INIT_DATA_REFRESH_POLL_INTERVAL_MS, remainingMs));
    });
    latestInitData = readInitData(true);
  }

  return latestInitData;
}

async function hasResponseErrorCode(response: Response, expectedCode: string): Promise<boolean> {
  if (typeof response.clone !== 'function') {
    return false;
  }

  try {
    const payload = (await response.clone().json()) as unknown;
    return Boolean(
      payload &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>).code === expectedCode,
    );
  } catch {
    return false;
  }
}

function hasReplayableBody(init: RequestInit): boolean {
  const body = init.body;
  if (!body || typeof body !== 'object') {
    return true;
  }
  return typeof (body as { getReader?: unknown }).getReader !== 'function';
}

export function createLazyMiniappServerSessionManager(
  enabled: boolean,
): MiniappServerSessionManager {
  let resolved: MiniappServerSessionManager | null = null;
  let loading: Promise<MiniappServerSessionManager> | null = null;
  const load = async (): Promise<MiniappServerSessionManager | null> => {
    if (!enabled) {
      return null;
    }
    loading ??= import('./miniapp-server-session').then((module) =>
      module.createMiniappServerSessionManager(true),
    );
    resolved = await loading;
    return resolved;
  };

  return {
    async ensure(apiBase, initData, options) {
      await (await load())?.ensure(apiBase, initData, options);
    },
    async recover(apiBase, initData, options) {
      return (await load())?.recover(apiBase, initData, options) ?? false;
    },
    applyHeaders(apiBase, initData, headers) {
      return resolved?.applyHeaders(apiBase, initData, headers) ?? null;
    },
  };
}

export function createApiTransport(
  initData: string | (() => string),
  options: ApiTransportOptions = {},
): ApiTransport {
  let cachedInitData = resolveInitDataValue(initData);
  let preferredApiBase: string | null = null;
  const apiBases = options.apiBases?.length ? options.apiBases : resolveRuntimeApiBases();
  const authSession = options.authSession;
  const durableSessionEnabled =
    options.durableSession ?? (typeof document !== 'undefined' && Boolean(authSession));
  const serverSession =
    options.serverSession ?? createLazyMiniappServerSessionManager(durableSessionEnabled);
  const responseCsrfTokens = new WeakMap<Response, string | null>();

  const readInitData = (refresh = false): string => {
    if (refresh || typeof initData === 'function') {
      const nextInitData = resolveInitDataValue(initData);
      if (nextInitData) {
        cachedInitData = nextInitData;
      }
    }

    return cachedInitData;
  };

  const buildHeaders = (apiBase: string, authInitData: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (authInitData) {
      headers.set('Authorization', `InitData ${authInitData}`);
    }

    const hasBody = init.body !== undefined && init.body !== null;
    const isFormDataBody = typeof FormData !== 'undefined' && init.body instanceof FormData;
    if (hasBody && !isFormDataBody && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const csrfToken = serverSession.applyHeaders(apiBase, authInitData, headers);

    return { headers, csrfToken };
  };
  const resolveAttemptBases = (): readonly string[] => {
    if (!preferredApiBase) {
      return apiBases;
    }

    return [preferredApiBase, ...apiBases.filter((base) => base !== preferredApiBase)];
  };
  const fetchWithTimeout = async (
    apiBase: string,
    path: string,
    authInitData: string,
    init: ApiRequestInit = {},
  ): Promise<FetchAttemptResult> => {
    const requestedTimeoutMs = init.timeoutMs;
    const fetchInit = { ...init };
    delete fetchInit.timeoutMs;
    delete fetchInit.retryMutationOnTransportError;
    const timeoutMs =
      typeof requestedTimeoutMs === 'number' && Number.isFinite(requestedTimeoutMs)
        ? Math.max(1, Math.trunc(requestedTimeoutMs))
        : API_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    const timeoutId = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    if (fetchInit.signal) {
      if (fetchInit.signal.aborted) {
        abortFromCaller();
      } else {
        fetchInit.signal.addEventListener('abort', abortFromCaller, { once: true });
      }
    }

    try {
      await serverSession.ensure(apiBase, authInitData, { signal: controller.signal });
      const { headers, csrfToken } = buildHeaders(apiBase, authInitData, fetchInit);
      const response = await fetch(`${apiBase}${path}`, {
        ...fetchInit,
        credentials: fetchInit.credentials ?? 'include',
        signal: controller.signal,
        headers,
      });
      responseCsrfTokens.set(response, csrfToken);
      return { apiBase, response };
    } catch (error: unknown) {
      if (timedOut) {
        traceFirstMiniappApiResult({
          ok: false,
          path,
          error: 'timeout',
        });
        throw new Error('Сервис не отвечает. Повторите.');
      }

      if (fetchInit.signal?.aborted) {
        throw error;
      }

      traceFirstMiniappApiResult({
        ok: false,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Нет связи с сервисом. Повторите.');
    } finally {
      globalThis.clearTimeout(timeoutId);
      fetchInit.signal?.removeEventListener('abort', abortFromCaller);
    }
  };
  const fetchWithFallback = async (
    path: string,
    authInitData: string,
    init: ApiRequestInit = {},
  ): Promise<FetchAttemptResult> => {
    const attemptBases = resolveAttemptBases();
    const method = (init.method ?? 'GET').toUpperCase();
    const retryMutationOnTransportError = init.retryMutationOnTransportError !== false;

    if (!API_FALLBACKS_ENABLED || attemptBases.length <= 1) {
      if (!['GET', 'HEAD'].includes(method) && isMutationTunnelPreferredHost(attemptBases[0])) {
        const { fetchMutationWithTunnel } = await import('./transport-mutation-tunnel');
        const tunnelResult = await fetchMutationWithTunnel(
          attemptBases[0],
          path,
          authInitData,
          init,
          fetchWithTimeout,
        );
        if (tunnelResult) {
          preferredApiBase = tunnelResult.apiBase;
          return tunnelResult;
        }
      }

      try {
        const result = await fetchWithTimeout(attemptBases[0], path, authInitData, init);
        if (!['GET', 'HEAD'].includes(method) && result.response.status === 405) {
          const { fetchMutationWithTunnel } = await import('./transport-mutation-tunnel');
          const tunnelResult = await fetchMutationWithTunnel(
            attemptBases[0],
            path,
            authInitData,
            init,
            fetchWithTimeout,
          );
          if (tunnelResult) {
            preferredApiBase = tunnelResult.apiBase;
            return tunnelResult;
          }
        }

        preferredApiBase = result.apiBase;
        return result;
      } catch (error: unknown) {
        if (
          init.signal?.aborted ||
          ['GET', 'HEAD'].includes(method) ||
          !retryMutationOnTransportError
        ) {
          throw error;
        }

        const { fetchMutationWithTunnel } = await import('./transport-mutation-tunnel');
        const tunnelResult = await fetchMutationWithTunnel(
          attemptBases[0],
          path,
          authInitData,
          init,
          fetchWithTimeout,
        );
        if (tunnelResult) {
          preferredApiBase = tunnelResult.apiBase;
          return tunnelResult;
        }

        throw error;
      }
    }

    if (!['GET', 'HEAD'].includes(method)) {
      const { fetchMutationWithTunnelFallback } = await import('./transport-mutation-tunnel');
      const result = await fetchMutationWithTunnelFallback(
        attemptBases,
        path,
        authInitData,
        init,
        fetchWithTimeout,
        { retryOnTransportError: retryMutationOnTransportError },
      );
      preferredApiBase = result.apiBase;
      return result;
    }

    const { fetchWithApiBaseFallback } = await import('./transport-fallback');
    const result = await fetchWithApiBaseFallback(attemptBases, init, (apiBase) =>
      fetchWithTimeout(apiBase, path, authInitData, init),
    );
    preferredApiBase = result.apiBase;
    return result;
  };
  const fetchWithSessionRecovery = async (
    path: string,
    authInitData: string,
    init: ApiRequestInit,
  ): Promise<FetchAttemptResult> => {
    let result = await fetchWithFallback(path, authInitData, init);
    if (
      result.response.status === 403 &&
      (await hasResponseErrorCode(result.response, 'MINIAPP_CSRF_REJECTED'))
    ) {
      const recovered = await serverSession.recover(result.apiBase, authInitData, {
        expectedCsrfToken: responseCsrfTokens.get(result.response) ?? null,
        signal: init.signal ?? undefined,
      });
      if (recovered && hasReplayableBody(init)) {
        result = await fetchWithFallback(path, authInitData, init);
      }
    }
    return result;
  };

  return {
    async request(path: string, init: ApiRequestInit = {}) {
      let authInitData = readInitData();
      if (authSession) {
        authSession.observeInitData(authInitData);
        await authSession.waitForPendingRecovery(authInitData);
        authInitData = readInitData();
        if (authSession.isBlocked(authInitData)) {
          const { createApiRequestError } = await import('../api-request-error');
          const payload = JSON.stringify({
            statusCode: 401,
            code: 'MINIAPP_AUTH_EXPIRED',
            recovery: 'relaunch_miniapp',
          });
          throw createApiRequestError(
            401,
            payload,
            'Срок входа истёк. Закройте мини-приложение и откройте его снова из MAX.',
          );
        }
      }

      let responseInitData = authInitData;
      let { response } = await fetchWithSessionRecovery(path, authInitData, init);
      if (response.status === 401 && typeof initData === 'function') {
        const refreshedInitData = authSession
          ? await authSession.recoverAfterUnauthorized(authInitData, () =>
              waitForUpdatedInitData(readInitData, authInitData),
            )
          : await waitForUpdatedInitData(readInitData, authInitData);
        if (
          refreshedInitData &&
          refreshedInitData !== authInitData &&
          hasReplayableBody(init)
        ) {
          responseInitData = refreshedInitData;
          ({ response } = await fetchWithSessionRecovery(path, refreshedInitData, init));
        }
      }

      if (response.status === 401) {
        authSession?.markUnauthorized(responseInitData);
      }

      if (!response.ok) {
        const payload = await response.text();
        traceFirstMiniappApiResult({
          ok: false,
          path,
          status: response.status,
        });
        const contentType = response.headers.get('content-type');
        const { buildApiErrorMessage } = await import('../api-error');
        const message = buildApiErrorMessage(response.status, payload, contentType);
        const { createApiRequestError } = await import('../api-request-error');
        throw createApiRequestError(response.status, payload, message);
      }

      traceFirstMiniappApiResult({
        ok: true,
        path,
        status: response.status,
      });

      if (response.status === 204 || response.status === 205) {
        return null;
      }

      const payload = await response.text();
      if (!payload.trim()) {
        return null;
      }

      try {
        return JSON.parse(payload);
      } catch {
        return payload;
      }
    },
    requestKeepalive(path: string, init: RequestInit = {}) {
      const apiBase = preferredApiBase ?? apiBases[0];
      const authInitData = readInitData();
      authSession?.observeInitData(authInitData);
      if (
        authSession &&
        (authSession.hasPendingRecovery(authInitData) || authSession.isBlocked(authInitData))
      ) {
        return;
      }

      const { headers } = buildHeaders(apiBase, authInitData, init);
      const method = (init.method ?? 'GET').toUpperCase();
      const isMutation = !['GET', 'HEAD'].includes(method);
      const sendTunnel = async () => {
        if (!isMutation) {
          return;
        }

        const { buildMutationTunnelPath } = await import('./transport-mutation-tunnel');
        const tunnelPath = await buildMutationTunnelPath(path, { ...init, headers });
        if (!tunnelPath) {
          return;
        }

        await fetch(`${apiBase}${tunnelPath}`, {
          method: 'GET',
          credentials: 'include',
          headers,
          keepalive: true,
          signal: init.signal,
        });
      };
      const sendSyncTunnel = (): boolean => {
        if (!isMutation) {
          return false;
        }

        const tunnelPath = buildMutationTunnelPathSync(path, { ...init, headers });
        if (!tunnelPath) {
          return false;
        }

        void fetch(`${apiBase}${tunnelPath}`, {
          method: 'GET',
          credentials: 'include',
          headers,
          keepalive: true,
          signal: init.signal,
        }).catch(() => undefined);
        return true;
      };

      if (isMutation && isMutationTunnelPreferredHost(apiBase) && sendSyncTunnel()) {
        return;
      }

      void fetch(`${apiBase}${path}`, {
        ...init,
        credentials: init.credentials ?? 'include',
        headers,
        keepalive: true,
      })
        .then((response) => {
          if (response.status === 405) {
            void sendTunnel().catch(() => undefined);
          }
        })
        .catch(() => {
          void sendTunnel().catch(() => undefined);
        });
    },
  };
}
