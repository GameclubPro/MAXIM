import { buildApiErrorMessage } from '../api-error';

const API_BASE = '/api/v1';

export type ApiTransport = {
  request: (path: string, init?: RequestInit) => Promise<unknown>;
  requestKeepalive: (path: string, init?: RequestInit) => void;
};

function resolveInitDataValue(initData: string | (() => string)): string {
  return (typeof initData === 'function' ? initData() : initData).trim();
}

export function createApiTransport(initData: string | (() => string)): ApiTransport {
  let cachedInitData = resolveInitDataValue(initData);

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

  return {
    async request(path: string, init: RequestInit = {}) {
      const requestUrl = `${API_BASE}${path}`;
      const authInitData = readInitData();
      let response = await fetch(requestUrl, {
        ...init,
        headers: buildHeaders(authInitData, init),
      });
      if (response.status === 401 && typeof initData === 'function') {
        const refreshedInitData = readInitData(true);
        if (refreshedInitData && refreshedInitData !== authInitData) {
          response = await fetch(requestUrl, {
            ...init,
            headers: buildHeaders(refreshedInitData, init),
          });
        }
      }

      if (!response.ok) {
        const payload = await response.text();
        throw new Error(
          buildApiErrorMessage(response.status, payload, response.headers.get('content-type')),
        );
      }

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
      void fetch(`${API_BASE}${path}`, {
        ...init,
        headers,
        keepalive: true,
      }).catch(() => undefined);
    },
  };
}
