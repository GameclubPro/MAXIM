import { buildApiErrorMessage } from '../api-error';
import { traceFirstMiniappApiResult } from '../boot-trace';
import { API_BASES } from '../public-config';
const INIT_DATA_REFRESH_WAIT_MS = 1_000;
const INIT_DATA_REFRESH_POLL_INTERVAL_MS = 50;
const API_REQUEST_TIMEOUT_MS = 25_000;
const MUTATION_TUNNEL_PATH = '/_mutation-tunnel';

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

function encodeBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  const encoded = globalThis.btoa(binary);
  return encoded.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function buildMutationTunnelPath(path: string, init: RequestInit = {}): string | null {
  const method = (init.method ?? 'GET').toUpperCase();
  if (
    ['GET', 'HEAD'].includes(method) ||
    (init.body !== undefined && init.body !== null && typeof init.body !== 'string')
  ) {
    return null;
  }

  const params = new URLSearchParams({
    method,
    path,
    nonce: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  });
  const contentType = new Headers(init.headers).get('Content-Type');
  if (contentType) {
    params.set('contentType', contentType);
  } else if (typeof init.body === 'string' && init.body) {
    params.set('contentType', 'application/json');
  }

  if (typeof init.body === 'string' && init.body) {
    params.set('body', encodeBase64UrlUtf8(init.body));
  }

  return `${MUTATION_TUNNEL_PATH}?${params.toString()}`;
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
  const apiBases = options.apiBases?.length ? options.apiBases : API_BASES;

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
      preferredApiBase = apiBase;
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
    if (attemptBases.length <= 1) {
      return fetchWithTimeout(attemptBases[0], path, authInitData, init);
    }

    if (!['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase())) {
      const tryMutationTunnel = async (apiBase: string): Promise<FetchAttemptResult | null> => {
        const tunnelPath = buildMutationTunnelPath(path, init);
        if (!tunnelPath) {
          return null;
        }

        const tunnelResult = await fetchWithTimeout(apiBase, tunnelPath, authInitData, {
          headers: init.headers,
          signal: init.signal,
        });
        return tunnelResult.response.status === 405 ? null : tunnelResult;
      };
      let lastError: unknown;
      for (const apiBase of attemptBases) {
        try {
          const result = await fetchWithTimeout(apiBase, path, authInitData, init);
          if (result.response.status === 405 && apiBase !== attemptBases.at(-1)) {
            const tunnelResult = await tryMutationTunnel(apiBase);
            if (tunnelResult) {
              return tunnelResult;
            }

            lastError = new Error('API front door rejected method');
            continue;
          }

          return result;
        } catch (error: unknown) {
          if (init.signal?.aborted) {
            throw error;
          }

          lastError = error;
          if (apiBase !== attemptBases.at(-1)) {
            try {
              const tunnelResult = await tryMutationTunnel(apiBase);
              if (tunnelResult) {
                return tunnelResult;
              }
            } catch (tunnelError: unknown) {
              lastError = tunnelError;
            }
          }
        }
      }

      throw lastError;
    }

    const { fetchWithApiBaseFallback } = await import('./transport-fallback');
    return fetchWithApiBaseFallback(attemptBases, init, (apiBase) =>
      fetchWithTimeout(apiBase, path, authInitData, init),
    );
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
      const headers = buildHeaders(readInitData(), init);
      void fetch(`${preferredApiBase ?? apiBases[0]}${path}`, {
        ...init,
        headers,
        keepalive: true,
      }).catch(() => undefined);
    },
  };
}
