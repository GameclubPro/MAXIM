import {
  MAX_TUNNEL_URL_LENGTH,
  MUTATION_TUNNEL_PATH,
  buildBaseTunnelParams,
  buildMutationTunnelPathSync,
  encodeBase64UrlBytes,
  encodeBase64UrlUtf8,
} from './transport-mutation-tunnel-path';
import { isMutationTunnelPreferredHost } from './transport-mutation-tunnel-hosts';

const COMPRESSED_TUNNEL_BODY_THRESHOLD = 1024;
const CHUNKED_TUNNEL_CHUNK_BYTES = 4_200;
const MAX_CHUNKED_TUNNEL_BODY_LENGTH = 34 * 1024 * 1024;
const CHUNKED_TUNNEL_CONCURRENCY = 6;

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

function createChunkedTunnelUploadId(): string {
  const randomBytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(randomBytes);
    return `${Date.now().toString(36)}-${encodeBase64UrlBytes(randomBytes)}`;
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

async function encodeGzipBody(value: string): Promise<string | null> {
  if (typeof CompressionStream === 'undefined') {
    return null;
  }

  try {
    const compressed = new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'));
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

  const params = buildBaseTunnelParams(path, init);

  if (typeof init.body === 'string' && init.body) {
    const body = encodeBase64UrlUtf8(init.body);
    const bodyGzip =
      init.body.length >= COMPRESSED_TUNNEL_BODY_THRESHOLD ? await encodeGzipBody(init.body) : null;

    if (bodyGzip && bodyGzip.length < body.length) {
      params.set('bodyGzip', bodyGzip);
    } else {
      params.set('body', body);
    }
  }

  const tunnelPath = `${MUTATION_TUNNEL_PATH}?${params.toString()}`;
  return tunnelPath.length <= MAX_TUNNEL_URL_LENGTH ? tunnelPath : null;
}

export { buildMutationTunnelPathSync };

async function fetchChunkedMutationWithTunnel(
  apiBase: string,
  path: string,
  authInitData: string,
  init: RequestInit,
  fetchWithTimeout: FetchWithTimeout,
): Promise<FetchAttemptResult | null> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (
    ['GET', 'HEAD'].includes(method) ||
    typeof init.body !== 'string' ||
    !init.body ||
    init.body.length > MAX_CHUNKED_TUNNEL_BODY_LENGTH
  ) {
    return null;
  }

  const bodyBytes = new TextEncoder().encode(init.body);
  if (bodyBytes.length > MAX_CHUNKED_TUNNEL_BODY_LENGTH) {
    return null;
  }

  const uploadId = createChunkedTunnelUploadId();
  const chunkCount = Math.ceil(bodyBytes.length / CHUNKED_TUNNEL_CHUNK_BYTES);
  if (chunkCount < 2) {
    return null;
  }

  const sendChunk = async (chunkIndex: number): Promise<FetchAttemptResult | null> => {
    const start = chunkIndex * CHUNKED_TUNNEL_CHUNK_BYTES;
    const chunk = bodyBytes.subarray(
      start,
      Math.min(bodyBytes.length, start + CHUNKED_TUNNEL_CHUNK_BYTES),
    );
    const params = buildBaseTunnelParams(path, init);
    params.set('uploadId', uploadId);
    params.set('chunkIndex', String(chunkIndex));
    params.set('chunkCount', String(chunkCount));
    params.set('chunk', encodeBase64UrlBytes(chunk));

    const tunnelPath = `${MUTATION_TUNNEL_PATH}?${params.toString()}`;
    if (tunnelPath.length > MAX_TUNNEL_URL_LENGTH) {
      return null;
    }

    const chunkResult = await fetchWithTimeout(apiBase, tunnelPath, authInitData, {
      headers: init.headers,
      signal: init.signal,
    });

    return chunkResult.response.ok ? null : chunkResult;
  };

  let nextChunkIndex = 0;
  let failedChunkResult: FetchAttemptResult | null = null;
  const workerCount = Math.min(CHUNKED_TUNNEL_CONCURRENCY, chunkCount);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (!failedChunkResult && nextChunkIndex < chunkCount) {
        const chunkIndex = nextChunkIndex;
        nextChunkIndex += 1;
        const chunkResult = await sendChunk(chunkIndex);
        if (chunkResult) {
          failedChunkResult = chunkResult;
          return;
        }
      }
    }),
  );

  if (failedChunkResult) {
    return failedChunkResult;
  }

  if (nextChunkIndex < chunkCount) {
    return null;
  }

  const params = buildBaseTunnelParams(path, init);
  params.set('uploadId', uploadId);
  params.set('chunkCount', String(chunkCount));
  params.set('commit', '1');
  const tunnelPath = `${MUTATION_TUNNEL_PATH}?${params.toString()}`;
  if (tunnelPath.length > MAX_TUNNEL_URL_LENGTH) {
    return null;
  }

  return fetchWithTimeout(apiBase, tunnelPath, authInitData, {
    headers: init.headers,
    signal: init.signal,
  });
}

export async function fetchMutationWithTunnel(
  apiBase: string,
  path: string,
  authInitData: string,
  init: RequestInit,
  fetchWithTimeout: FetchWithTimeout,
): Promise<FetchAttemptResult | null> {
  const tunnelPath = await buildMutationTunnelPath(path, init);
  if (tunnelPath) {
    const tunnelResult = await fetchWithTimeout(apiBase, tunnelPath, authInitData, {
      headers: init.headers,
      signal: init.signal,
    });
    if (![405, 413, 414].includes(tunnelResult.response.status)) {
      return tunnelResult;
    }
  }

  return fetchChunkedMutationWithTunnel(apiBase, path, authInitData, init, fetchWithTimeout);
}

export async function fetchMutationWithTunnelFallback(
  attemptBases: readonly string[],
  path: string,
  authInitData: string,
  init: RequestInit,
  fetchWithTimeout: FetchWithTimeout,
): Promise<FetchAttemptResult> {
  const replayableBody =
    !init.body ||
    typeof init.body !== 'object' ||
    typeof (init.body as { getReader?: unknown }).getReader !== 'function';
  const tryMutationTunnel = async (apiBase: string): Promise<FetchAttemptResult | null> => {
    return fetchMutationWithTunnel(apiBase, path, authInitData, init, fetchWithTimeout);
  };

  let lastError: unknown;
  for (const apiBase of attemptBases) {
    const isLastAttempt = apiBase === attemptBases.at(-1);
    const shouldTryTunnelOnAttempt = !isLastAttempt || isMutationTunnelPreferredHost(apiBase);
    try {
      const result = await fetchWithTimeout(apiBase, path, authInitData, init);
      if (result.response.status === 405 && shouldTryTunnelOnAttempt) {
        const tunnelResult = await tryMutationTunnel(apiBase);
        if (tunnelResult) {
          return tunnelResult;
        }

        if (!replayableBody) {
          return result;
        }

        lastError = new Error('API front door rejected method');
        continue;
      }

      return result;
    } catch (error: unknown) {
      if (init.signal?.aborted) {
        throw error;
      }

      if (!replayableBody) {
        throw error;
      }

      lastError = error;
      if (shouldTryTunnelOnAttempt) {
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
