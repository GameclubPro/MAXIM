const MUTATION_TUNNEL_PATH = '/_mutation-tunnel';

function encodeBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function buildMutationTunnelPath(path: string, init: RequestInit = {}): string | null {
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
