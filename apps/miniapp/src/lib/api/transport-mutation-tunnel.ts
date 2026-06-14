const MUTATION_TUNNEL_PATH = '/_mutation-tunnel';
const COMPRESSED_TUNNEL_BODY_THRESHOLD = 1024;
const MAX_TUNNEL_URL_LENGTH = 7500;

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
  return encodeBase64UrlBytes(bytes);
}

function encodeBase64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

async function encodeGzipBody(value: string): Promise<string | null> {
  if (typeof CompressionStream === 'undefined') {
    return null;
  }

  try {
    const compressed = new Blob([value])
      .stream()
      .pipeThrough(new CompressionStream('gzip'));
    const buffer = await new Response(compressed).arrayBuffer();
    return encodeBase64UrlBytes(new Uint8Array(buffer));
  } catch {
    return null;
  }
}

export async function buildMutationTunnelPath(
  path: string,
  init: RequestInit = {},
): Promise<string | null> {
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
    const body = encodeBase64UrlUtf8(init.body);
    const bodyGzip =
      init.body.length >= COMPRESSED_TUNNEL_BODY_THRESHOLD
        ? await encodeGzipBody(init.body)
        : null;

    if (bodyGzip && bodyGzip.length < body.length) {
      params.set('bodyGzip', bodyGzip);
    } else {
      params.set('body', body);
    }
  }

  const tunnelPath = `${MUTATION_TUNNEL_PATH}?${params.toString()}`;
  return tunnelPath.length <= MAX_TUNNEL_URL_LENGTH ? tunnelPath : null;
}

export async function fetchMutationWithTunnel(
  apiBase: string,
  path: string,
  authInitData: string,
  init: RequestInit,
  fetchWithTimeout: FetchWithTimeout,
): Promise<FetchAttemptResult | null> {
  const tunnelPath = await buildMutationTunnelPath(path, init);
  if (!tunnelPath) {
    return null;
  }

  const tunnelResult = await fetchWithTimeout(apiBase, tunnelPath, authInitData, {
    headers: init.headers,
    signal: init.signal,
  });
  return [405, 413, 414].includes(tunnelResult.response.status) ? null : tunnelResult;
}

export async function fetchMutationWithTunnelFallback(
  attemptBases: readonly string[],
  path: string,
  authInitData: string,
  init: RequestInit,
  fetchWithTimeout: FetchWithTimeout,
): Promise<FetchAttemptResult> {
  const tryMutationTunnel = async (apiBase: string): Promise<FetchAttemptResult | null> => {
    return fetchMutationWithTunnel(apiBase, path, authInitData, init, fetchWithTimeout);
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
