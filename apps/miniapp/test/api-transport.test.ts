import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiTransport } from '../src/lib/api/transport';

type FetchCall = {
  input: string | URL | Request;
  init?: RequestInit;
};

function createResponse(options: {
  ok: boolean;
  status: number;
  text?: string;
  contentType?: string | null;
}): Response {
  return {
    ok: options.ok,
    status: options.status,
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'content-type'
          ? (options.contentType ?? 'application/json')
          : null;
      },
    } as Headers,
    text: async () => options.text ?? '',
  } as Response;
}

test('refreshes Authorization header from the init data provider between requests', async () => {
  const calls: FetchCall[] = [];
  let currentInitData = 'auth_date=1&hash=first';

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    return createResponse({
      ok: true,
      status: 204,
      text: '',
      contentType: null,
    });
  }) as typeof fetch;

  const api = createApiTransport(() => currentInitData);

  await api.request('/me');
  currentInitData = 'auth_date=2&hash=second';
  await api.request('/chats');

  assert.equal(calls.length, 2);
  assert.equal(
    new Headers(calls[0].init?.headers).get('Authorization'),
    'InitData auth_date=1&hash=first',
  );
  assert.equal(
    new Headers(calls[1].init?.headers).get('Authorization'),
    'InitData auth_date=2&hash=second',
  );
});

test('retries a 401 request once when fresh init data becomes available', async () => {
  const calls: FetchCall[] = [];
  let currentInitData = 'auth_date=1&hash=stale';

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    if (calls.length === 1) {
      currentInitData = 'auth_date=2&hash=fresh';
      return createResponse({
        ok: false,
        status: 401,
        text: 'Init data has expired',
        contentType: 'text/plain',
      });
    }

    return createResponse({
      ok: true,
      status: 204,
      text: '',
      contentType: null,
    });
  }) as typeof fetch;

  const api = createApiTransport(() => currentInitData);
  const result = await api.request('/me');

  assert.equal(result, null);
  assert.equal(calls.length, 2);
  assert.equal(
    new Headers(calls[0].init?.headers).get('Authorization'),
    'InitData auth_date=1&hash=stale',
  );
  assert.equal(
    new Headers(calls[1].init?.headers).get('Authorization'),
    'InitData auth_date=2&hash=fresh',
  );
});

test('waits briefly for bridge-refreshed init data before surfacing a 401', async () => {
  const calls: FetchCall[] = [];
  let currentInitData = 'auth_date=1&hash=stale';

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    if (calls.length === 1) {
      globalThis.setTimeout(() => {
        currentInitData = 'auth_date=2&hash=fresh';
      }, 25);

      return createResponse({
        ok: false,
        status: 401,
        text: 'Init data has expired',
        contentType: 'text/plain',
      });
    }

    return createResponse({
      ok: true,
      status: 204,
      text: '',
      contentType: null,
    });
  }) as typeof fetch;

  const api = createApiTransport(() => currentInitData);
  const result = await api.request('/me');

  assert.equal(result, null);
  assert.equal(calls.length, 2);
  assert.equal(
    new Headers(calls[0].init?.headers).get('Authorization'),
    'InitData auth_date=1&hash=stale',
  );
  assert.equal(
    new Headers(calls[1].init?.headers).get('Authorization'),
    'InitData auth_date=2&hash=fresh',
  );
});

test('aborts hanging requests after the configured timeout', async () => {
  const calls: FetchCall[] = [];
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    await new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  }) as typeof fetch;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
    originalSetTimeout(handler, Math.min(Number(timeout) || 0, 5), ...args)) as typeof setTimeout;

  try {
    const api = createApiTransport('auth_date=1&hash=first');

    await assert.rejects(() => api.request('/me'), /Сервис не отвечает\. Повторите\./u);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init?.signal instanceof AbortSignal, true);
    assert.equal(calls[0].init?.signal?.aborted, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('uses the first reachable API base for idempotent requests', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const url = String(input);
    if (url.startsWith('https://api-cdn.flex-craft.ru')) {
      throw new TypeError('Network request failed');
    }

    return createResponse({
      ok: true,
      status: 200,
      text: JSON.stringify([{ id: 'chat-1' }]),
    });
  }) as typeof fetch;

  const api = createApiTransport('auth_date=1&hash=first', {
    apiBases: ['https://api-cdn.flex-craft.ru/api/v1', 'https://major-maksimov.ru/api/v1'],
  });

  const result = await api.request('/chats');

  assert.deepEqual(result, [{ id: 'chat-1' }]);
  assert.deepEqual(
    calls.map((call) => String(call.input)),
    ['https://api-cdn.flex-craft.ru/api/v1/chats', 'https://major-maksimov.ru/api/v1/chats'],
  );
});

test('tries the next API base when the primary returns a retryable error response', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const url = String(input);
    if (url.startsWith('https://api-cdn.flex-craft.ru')) {
      return createResponse({
        ok: false,
        status: 403,
        text: JSON.stringify({ message: 'Forbidden' }),
      });
    }

    return createResponse({
      ok: true,
      status: 200,
      text: JSON.stringify([{ id: 'chat-1' }]),
    });
  }) as typeof fetch;

  const api = createApiTransport('auth_date=1&hash=first', {
    apiBases: ['https://api-cdn.flex-craft.ru/api/v1', 'https://major-maksimov.ru/api/v1'],
  });

  const result = await api.request('/chats');

  assert.deepEqual(result, [{ id: 'chat-1' }]);
  assert.deepEqual(
    calls.map((call) => String(call.input)),
    ['https://api-cdn.flex-craft.ru/api/v1/chats', 'https://major-maksimov.ru/api/v1/chats'],
  );
});

test('gives the primary API base a head start for idempotent requests', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    return createResponse({
      ok: true,
      status: 200,
      text: JSON.stringify([{ id: 'chat-1' }]),
    });
  }) as typeof fetch;

  const api = createApiTransport('auth_date=1&hash=first', {
    apiBases: ['https://major-maksimov.ru/api/v1', 'https://api-cdn.flex-craft.ru/api/v1'],
  });

  const result = await api.request('/chats');

  assert.deepEqual(result, [{ id: 'chat-1' }]);
  assert.deepEqual(calls.map((call) => String(call.input)), [
    'https://major-maksimov.ru/api/v1/chats',
  ]);
});

test('does not let a hedged fallback 401 beat a successful primary idempotent request', async () => {
  const calls: FetchCall[] = [];
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const url = String(input);
    if (url.startsWith('https://api-cdn.flex-craft.ru')) {
      return createResponse({
        ok: false,
        status: 401,
        text: JSON.stringify({ message: 'Invalid init data signature' }),
      });
    }

    await new Promise((resolve) => originalSetTimeout(resolve, 25));
    return createResponse({
      ok: true,
      status: 200,
      text: JSON.stringify([{ id: 'chat-1' }]),
    });
  }) as typeof fetch;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
    originalSetTimeout(
      handler,
      Number(timeout) === 750 ? 5 : timeout,
      ...args,
    )) as typeof setTimeout;

  try {
    const api = createApiTransport('auth_date=1&hash=first', {
      apiBases: ['https://major-maksimov.ru/api/v1', 'https://api-cdn.flex-craft.ru/api/v1'],
    });

    const result = await api.request('/chats');

    assert.deepEqual(result, [{ id: 'chat-1' }]);
    assert.deepEqual(calls.map((call) => String(call.input)), [
      'https://major-maksimov.ru/api/v1/chats',
      'https://api-cdn.flex-craft.ru/api/v1/chats',
    ]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('keeps the primary HTTP failure when all idempotent API bases fail', async () => {
  const calls: FetchCall[] = [];
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const url = String(input);
    if (url.startsWith('https://api-cdn.flex-craft.ru')) {
      return createResponse({
        ok: false,
        status: 401,
        text: JSON.stringify({ message: 'Invalid init data signature' }),
      });
    }

    await new Promise((resolve) => originalSetTimeout(resolve, 25));
    return createResponse({
      ok: false,
      status: 502,
      text: '<html>Bad Gateway</html>',
      contentType: 'text/html',
    });
  }) as typeof fetch;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
    originalSetTimeout(
      handler,
      Number(timeout) === 750 ? 5 : timeout,
      ...args,
    )) as typeof setTimeout;

  try {
    const api = createApiTransport('auth_date=1&hash=first', {
      apiBases: ['https://major-maksimov.ru/api/v1', 'https://api-cdn.flex-craft.ru/api/v1'],
    });

    await assert.rejects(() => api.request('/chats'), /Сервис временно недоступен/u);
    assert.deepEqual(calls.map((call) => String(call.input)), [
      'https://major-maksimov.ru/api/v1/chats',
      'https://api-cdn.flex-craft.ru/api/v1/chats',
    ]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('uses the selected API base for follow-up mutation requests', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const url = String(input);
    if (url.startsWith('https://api-cdn.flex-craft.ru')) {
      throw new TypeError('Network request failed');
    }

    return createResponse({
      ok: true,
      status: init?.method === 'POST' ? 204 : 200,
      text: init?.method === 'POST' ? '' : JSON.stringify([{ id: 'chat-1' }]),
      contentType: init?.method === 'POST' ? null : 'application/json',
    });
  }) as typeof fetch;

  const api = createApiTransport('auth_date=1&hash=first', {
    apiBases: ['https://api-cdn.flex-craft.ru/api/v1', 'https://major-maksimov.ru/api/v1'],
  });

  await api.request('/chats');
  await api.request('/chats/chat-1/settings', {
    method: 'POST',
    body: JSON.stringify({ antiSpamEnabled: true }),
  });

  assert.deepEqual(
    calls.map(
      (call) => `${new Headers(call.init?.headers).get('Content-Type') ?? ''} ${call.input}`,
    ),
    [
      ' https://api-cdn.flex-craft.ru/api/v1/chats',
      ' https://major-maksimov.ru/api/v1/chats',
      'application/json https://major-maksimov.ru/api/v1/chats/chat-1/settings',
    ],
  );
});

test('tunnels mutation requests when the front door rejects the original method', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const url = String(input);
    if (url.startsWith('https://api-cdn.flex-craft.ru/api/v1/_mutation-tunnel')) {
      return createResponse({
        ok: true,
        status: 204,
        text: '',
        contentType: null,
      });
    }

    if (url.startsWith('https://api-cdn.flex-craft.ru')) {
      return createResponse({
        ok: false,
        status: 405,
        text: 'Method Not Allowed',
        contentType: 'text/html',
      });
    }

    return createResponse({
      ok: true,
      status: 204,
      text: '',
      contentType: null,
    });
  }) as typeof fetch;

  const api = createApiTransport('auth_date=1&hash=first', {
    apiBases: ['https://api-cdn.flex-craft.ru/api/v1', 'https://major-maksimov.ru/api/v1'],
  });

  const result = await api.request('/chats/chat-1/settings', {
    method: 'PUT',
    body: JSON.stringify({ antiSpamEnabled: true, note: 'тест' }),
  });

  assert.equal(result, null);
  assert.equal(
    String(calls[0].input),
    'https://api-cdn.flex-craft.ru/api/v1/chats/chat-1/settings',
  );
  const tunnelUrl = new URL(String(calls[1].input));
  assert.equal(tunnelUrl.origin, 'https://api-cdn.flex-craft.ru');
  assert.equal(tunnelUrl.pathname, '/api/v1/_mutation-tunnel');
  assert.equal(tunnelUrl.searchParams.get('method'), 'PUT');
  assert.equal(tunnelUrl.searchParams.get('path'), '/chats/chat-1/settings');
  assert.equal(tunnelUrl.searchParams.get('contentType'), 'application/json');
  assert.deepEqual(
    JSON.parse(
      Buffer.from(
        tunnelUrl.searchParams.get('body')?.replace(/-/g, '+').replace(/_/g, '/') ?? '',
        'base64',
      ).toString('utf8'),
    ),
    { antiSpamEnabled: true, note: 'тест' },
  );
});

test('prefers the mutation tunnel for a single CDN API base', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const url = String(input);
    if (url.includes('/_mutation-tunnel?')) {
      return createResponse({
        ok: true,
        status: 204,
        text: '',
        contentType: null,
      });
    }

    return createResponse({
      ok: true,
      status: 405,
      text: 'Method Not Allowed',
      contentType: 'text/plain',
    });
  }) as typeof fetch;

  const api = createApiTransport('auth_date=1&hash=first', {
    apiBases: ['https://api-cdn.flex-craft.ru/api/v1'],
  });

  const result = await api.request('/chats/chat-1/settings', {
    method: 'PUT',
    body: JSON.stringify({ antiSpamEnabled: true }),
  });

  assert.equal(result, null);
  assert.equal(calls.length, 1);
  assert.match(
    String(calls[0].input),
    /^https:\/\/api-cdn\.flex-craft\.ru\/api\/v1\/_mutation-tunnel\?/u,
  );
  assert.equal(new URL(String(calls[0].input)).searchParams.get('method'), 'PUT');
  assert.equal(new URL(String(calls[0].input)).searchParams.get('path'), '/chats/chat-1/settings');
  assert.equal(calls[0].init?.method ?? 'GET', 'GET');
});

test('prefers the mutation tunnel for the production CDN API hostname', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    return createResponse({
      ok: true,
      status: 204,
      text: '',
      contentType: null,
    });
  }) as typeof fetch;

  const api = createApiTransport('auth_date=1&hash=first', {
    apiBases: ['https://api2.major-maksimov.ru/api/v1'],
  });

  const result = await api.request('/chats/chat-1/settings', {
    method: 'PUT',
    body: JSON.stringify({ antiSpamEnabled: true }),
  });

  assert.equal(result, null);
  assert.equal(calls.length, 1);
  assert.match(
    String(calls[0].input),
    /^https:\/\/api2\.major-maksimov\.ru\/api\/v1\/_mutation-tunnel\?/u,
  );
  assert.equal(new URL(String(calls[0].input)).searchParams.get('method'), 'PUT');
  assert.equal(new URL(String(calls[0].input)).searchParams.get('path'), '/chats/chat-1/settings');
});

test('falls back to the next API base when mutation tunneling is rejected too', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const url = String(input);
    if (url.startsWith('https://api-cdn.flex-craft.ru')) {
      return createResponse({
        ok: false,
        status: 405,
        text: 'Method Not Allowed',
        contentType: 'text/html',
      });
    }

    return createResponse({
      ok: true,
      status: 204,
      text: '',
      contentType: null,
    });
  }) as typeof fetch;

  const api = createApiTransport('auth_date=1&hash=first', {
    apiBases: ['https://api-cdn.flex-craft.ru/api/v1', 'https://major-maksimov.ru/api/v1'],
  });

  const result = await api.request('/chats/chat-1/settings', {
    method: 'PUT',
    body: JSON.stringify({ antiSpamEnabled: true }),
  });

  assert.equal(result, null);
  assert.deepEqual(
    calls.map((call) => new URL(String(call.input)).origin + new URL(String(call.input)).pathname),
    [
      'https://api-cdn.flex-craft.ru/api/v1/chats/chat-1/settings',
      'https://api-cdn.flex-craft.ru/api/v1/_mutation-tunnel',
      'https://major-maksimov.ru/api/v1/chats/chat-1/settings',
    ],
  );
});

test('tunnels mutation requests when the original CDN mutation fails as a network error', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const url = String(input);
    if (url.startsWith('https://api-cdn.flex-craft.ru/api/v1/_mutation-tunnel')) {
      return createResponse({
        ok: true,
        status: 204,
        text: '',
        contentType: null,
      });
    }

    if (url.startsWith('https://api-cdn.flex-craft.ru')) {
      throw new TypeError('Failed to fetch');
    }

    return createResponse({
      ok: true,
      status: 204,
      text: '',
      contentType: null,
    });
  }) as typeof fetch;

  const api = createApiTransport('auth_date=1&hash=first', {
    apiBases: ['https://api-cdn.flex-craft.ru/api/v1', 'https://major-maksimov.ru/api/v1'],
  });

  const result = await api.request('/chats/chat-1/settings', {
    method: 'PUT',
    body: JSON.stringify({ antiSpamEnabled: true }),
  });

  assert.equal(result, null);
  assert.deepEqual(
    calls.map((call) => new URL(String(call.input)).origin + new URL(String(call.input)).pathname),
    [
      'https://api-cdn.flex-craft.ru/api/v1/chats/chat-1/settings',
      'https://api-cdn.flex-craft.ru/api/v1/_mutation-tunnel',
    ],
  );
  assert.equal(
    new Headers(calls[1].init?.headers).get('Authorization'),
    'InitData auth_date=1&hash=first',
  );
});

test('tunnels keepalive mutation requests when the front door rejects the original method', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const url = String(input);
    if (url.includes('/_mutation-tunnel?')) {
      return createResponse({
        ok: true,
        status: 204,
        text: '',
        contentType: null,
      });
    }

    return createResponse({
      ok: false,
      status: 405,
      text: 'Method Not Allowed',
      contentType: 'text/plain',
    });
  }) as typeof fetch;

  const api = createApiTransport('auth_date=1&hash=first', {
    apiBases: ['https://api-cdn.flex-craft.ru/api/v1'],
  });

  api.requestKeepalive('/chats/chat-1/members/user-1/profile/handoff', {
    method: 'POST',
    body: JSON.stringify({ label: 'Admin' }),
  });
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

  assert.equal(calls.length, 2);
  assert.equal(
    String(calls[0].input),
    'https://api-cdn.flex-craft.ru/api/v1/chats/chat-1/members/user-1/profile/handoff',
  );
  const tunnelUrl = new URL(String(calls[1].input));
  assert.equal(tunnelUrl.origin, 'https://api-cdn.flex-craft.ru');
  assert.equal(tunnelUrl.pathname, '/api/v1/_mutation-tunnel');
  assert.equal(tunnelUrl.searchParams.get('method'), 'POST');
  assert.equal(tunnelUrl.searchParams.get('path'), '/chats/chat-1/members/user-1/profile/handoff');
  assert.equal(calls[1].init?.method, 'GET');
  assert.equal(calls[1].init?.keepalive, true);
});

test.afterEach(() => {
  delete (globalThis as { fetch?: typeof fetch }).fetch;
});
