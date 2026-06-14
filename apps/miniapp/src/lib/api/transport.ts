import { buildApiErrorMessage } from '../api-error';
import { traceFirstMiniappApiResult } from '../boot-trace';
import { resolveRuntimeApiBases } from '../public-config';
const INIT_DATA_REFRESH_WAIT_MS = 1_000;
const INIT_DATA_REFRESH_POLL_INTERVAL_MS = 50;
const API_REQUEST_TIMEOUT_MS = 25_000;
const API_FALLBACKS_ENABLED =
  typeof __MAXIM_API_FALLBACKS_ENABLED__ === 'boolean'
    ? __MAXIM_API_FALLBACKS_ENABLED__
    : true;
const MUTATION_TUNNEL_PREFERRED_HOSTS = new Set([
  'api-cdn.flex-craft.ru',
  'api2.major-maksimov.ru',
]);

export type ApiTransport = {
  request: (path: string, init?: RequestInit) => Promise<unknown>;
  requestKeepalive: (path: string, init?: RequestInit) => void;
};

export type ApiTransportOptions = {
  apiBases?: readonly string[];
};

type FetchAttemptResult = {
  apiBase: string;
  response: Response;
};

function resolveInitDataValue(initData: string | (() => string)): string {
  return (typeof initData === 'function' ? initData() : initData).trim();
}

function shouldPreferMutationTunnel(apiBase: string): boolean {
  try {
    return MUTATION_TUNNEL_PREFERRED_HOSTS.has(new URL(apiBase, window.location.href).hostname);
  } catch {
    return [...MUTATION_TUNNEL_PREFERRED_HOSTS].some((host) => apiBase.includes(host));
  }
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

export function createApiTransport(
  initData: string | (() => string),
  options: ApiTransportOptions = {},
): ApiTransport {
  let cachedInitData = resolveInitDataValue(initData);
  let preferredApiBase: string | null = null;
  const apiBases = options.apiBases?.length ? options.apiBases : resolveRuntimeApiBases();

  const readInitData = (refresh = false): string => {
    if (refresh || typeof initData === 'function') {
      const nextInitData = resolveInitDataValue(initData);
      if (nextInitData) {
        cachedInitData = nextInitData;
      }
    }

    return cachedInitData;
  };

  const buildHeaders = (authInitData: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (authInitData) {
      headers.set('Authorization', `InitData ${authInitData}`);
    }

    const hasBody = init.body !== undefined && init.body !== null;
    const isFormDataBody = typeof FormData !== 'undefined' && init.body instanceof FormData;
    if (hasBody && !isFormDataBody && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    return headers;
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
    init: RequestInit = {},
  ): Promise<FetchAttemptResult> => {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    const timeoutId = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, API_REQUEST_TIMEOUT_MS);
    if (init.signal) {
      if (init.signal.aborted) {
        abortFromCaller();
      } else {
        init.signal.addEventListener('abort', abortFromCaller, { once: true });
      }
    }

    try {
      const response = await fetch(`${apiBase}${path}`, {
        ...init,
        signal: controller.signal,
        headers: buildHeaders(authInitData, init),
      });
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

      if (init.signal?.aborted) {
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
      init.signal?.removeEventListener('abort', abortFromCaller);
    }
  };
  const fetchWithFallback = async (
    path: string,
    authInitData: string,
    init: RequestInit = {},
  ): Promise<FetchAttemptResult> => {
    const attemptBases = resolveAttemptBases();
    const method = (init.method ?? 'GET').toUpperCase();

    if (!API_FALLBACKS_ENABLED || attemptBases.length <= 1) {
      if (!['GET', 'HEAD'].includes(method) && shouldPreferMutationTunnel(attemptBases[0])) {
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
        if (init.signal?.aborted || ['GET', 'HEAD'].includes(method)) {
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

  return {
    async request(path: string, init: RequestInit = {}) {
      const authInitData = readInitData();
      let { response } = await fetchWithFallback(path, authInitData, init);
      if (response.status === 401 && typeof initData === 'function') {
        const refreshedInitData = await waitForUpdatedInitData(readInitData, authInitData);
        if (refreshedInitData && refreshedInitData !== authInitData) {
          ({ response } = await fetchWithFallback(path, refreshedInitData, init));
        }
      }

      if (!response.ok) {
        const payload = await response.text();
        traceFirstMiniappApiResult({
          ok: false,
          path,
          status: response.status,
        });
        throw new Error(
          buildApiErrorMessage(response.status, payload, response.headers.get('content-type')),
        );
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
      const headers = buildHeaders(readInitData(), init);
      const method = (init.method ?? 'GET').toUpperCase();
      const sendTunnel = async () => {
        if (['GET', 'HEAD'].includes(method)) {
          return;
        }

        const { buildMutationTunnelPath } = await import('./transport-mutation-tunnel');
        const tunnelPath = await buildMutationTunnelPath(path, { ...init, headers });
        if (!tunnelPath) {
          return;
        }

        await fetch(`${apiBase}${tunnelPath}`, {
          method: 'GET',
          headers,
          keepalive: true,
          signal: init.signal,
        });
      };

      void fetch(`${apiBase}${path}`, {
        ...init,
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
