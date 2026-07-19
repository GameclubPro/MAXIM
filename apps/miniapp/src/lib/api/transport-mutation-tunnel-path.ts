export const MUTATION_TUNNEL_PATH = '/_mutation-tunnel';
export const MAX_TUNNEL_URL_LENGTH = 7500;

export function encodeBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return encodeBase64UrlBytes(bytes);
}

export function encodeBase64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function buildBaseTunnelParams(path: string, init: RequestInit): URLSearchParams {
  const method = (init.method ?? 'GET').toUpperCase();
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

  return params;
}

export function buildMutationTunnelPathSync(path: string, init: RequestInit = {}): string | null {
  const method = (init.method ?? 'GET').toUpperCase();
  if (
    ['GET', 'HEAD'].includes(method) ||
    (init.body !== undefined && init.body !== null && typeof init.body !== 'string')
  ) {
    return null;
  }

  const params = buildBaseTunnelParams(path, init);
  if (typeof init.body === 'string' && init.body) {
    params.set('body', encodeBase64UrlUtf8(init.body));
  }

  const tunnelPath = `${MUTATION_TUNNEL_PATH}?${params.toString()}`;
  return tunnelPath.length <= MAX_TUNNEL_URL_LENGTH ? tunnelPath : null;
}
