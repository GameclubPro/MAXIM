const MUTATION_TUNNEL_PATH = '/_mutation-tunnel';

type FetchAttemptResult = {
  apiBase: string;
  response: Response;
};

type FetchWithTimeout = (
  apiBase: string,
  path: string,
  authInitData: string,
  init?: RequestInit,
) => Promise<FetchAttemptResult>;

function encodeBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
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

export async function fetchMutationWithTunnelFallback(
  attemptBases: readonly string[],
  path: string,
  authInitData: string,
  init: RequestInit,
  fetchWithTimeout: FetchWithTimeout,
): Promise<FetchAttemptResult> {
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
