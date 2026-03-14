const API_BASE = '/api/v1';

export type ApiTransport = {
  request: (path: string, init?: RequestInit) => Promise<unknown>;
};

export function createApiTransport(initData: string): ApiTransport {
  return {
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `InitData ${initData}`);

      const hasBody = init.body !== undefined && init.body !== null;
      const isFormDataBody = typeof FormData !== 'undefined' && init.body instanceof FormData;
      if (hasBody && !isFormDataBody && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }

      const response = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers,
      });

      if (!response.ok) {
        const payload = await response.text();
        let apiMessage: string | null = null;
        try {
          const parsed = JSON.parse(payload) as { message?: unknown };
          if (typeof parsed.message === 'string' && parsed.message.trim()) {
            apiMessage = parsed.message.trim();
          }
        } catch {
          // Ignore invalid JSON error payloads and fall back to raw text.
        }

        if (apiMessage) {
          throw new Error(apiMessage);
        }
        throw new Error(`API request failed: ${response.status} ${payload}`);
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
  };
}
