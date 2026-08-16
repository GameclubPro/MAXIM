import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiRequestError } from '../src/lib/api-request-error';
import { createMiniappServerSessionManager } from '../src/lib/api/miniapp-server-session';
import { createApiTransport } from '../src/lib/api/transport';
import { createAuthSessionCoordinator } from '../src/lib/auth-session-coordinator';

type FetchCall = {
  input: string | URL | Request;
  init?: RequestInit;
};

const CDN_API_ORIGIN = 'https://api-cdn.flex-craft.ru';
const MAJOR_API_ORIGIN = 'https://major-maksimov.ru';
const MUTATION_TUNNEL_PATH = '/api/v1/_mutation-tunnel';

function matchesRequestUrl(
  input: string | URL | Request,
  expectedOrigin: string,
  expectedPath?: string,
): boolean {
  try {
    const value = input instanceof Request ? input.url : String(input);
    const parsed = new URL(value);
    return (
      parsed.origin === expectedOrigin &&
      (expectedPath === undefined || parsed.pathname === expectedPath)
    );
  } catch {
    return false;
  }
}

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

function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test('request URL matching rejects lookalike origins and paths', () => {
  assert.equal(
    matchesRequestUrl(
      'https://api-cdn.flex-craft.ru/api/v1/_mutation-tunnel?method=POST',
      CDN_API_ORIGIN,
      MUTATION_TUNNEL_PATH,
    ),
    true,
  );
  assert.equal(
    matchesRequestUrl(
      'https://api-cdn.flex-craft.ru.attacker.example/api/v1/_mutation-tunnel?method=POST',
      CDN_API_ORIGIN,
      MUTATION_TUNNEL_PATH,
    ),
    false,
  );
  assert.equal(
    matchesRequestUrl(
      'https://api-cdn.flex-craft.ru/api/v1/_mutation-tunnel-lookalike?method=POST',
      CDN_API_ORIGIN,
      MUTATION_TUNNEL_PATH,
    ),
    false,
  );
});

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

test('bootstraps the durable session before the first browser API request', async () => {
  const calls: FetchCall[] = [];
  const initData = new URLSearchParams({
    auth_date: '1',
    hash: 'first',
    user: JSON.stringify({ id: 'user-1' }),
  }).toString();
  const csrfToken = 'c'.repeat(43);

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    if (String(input).endsWith('/auth/miniapp-session')) {
      return new Response(
        JSON.stringify({
          authenticated: true,
          csrfToken,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const api = createApiTransport(initData, {
    apiBases: ['https://major-maksimov.ru/api/v1'],
    authSession: createAuthSessionCoordinator(initData),
    durableSession: true,
  });

  assert.equal(await api.request('/me'), null);
  assert.equal(calls.length, 2);
  assert.equal(String(calls[0].input), 'https://major-maksimov.ru/api/v1/auth/miniapp-session');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.credentials, 'include');
  assert.equal(String(calls[1].input), 'https://major-maksimov.ru/api/v1/me');
  assert.equal(calls[1].init?.credentials, 'include');
  assert.equal(new Headers(calls[1].init?.headers).get('X-Miniapp-Csrf-Token'), csrfToken);
});

test('uses an existing cookie session when bridge init data is already expired', async () => {
  const calls: FetchCall[] = [];
  const initData = new URLSearchParams({
    auth_date: '1',
    hash: 'expired',
    user: JSON.stringify({ id: 'user-1' }),
  }).toString();
  const authSession = createAuthSessionCoordinator(initData);
  const csrfToken = 'r'.repeat(43);

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const url = String(input);
    if (url.endsWith('/auth/miniapp-session') && init?.method === 'POST') {
      return new Response(JSON.stringify({ code: 'MINIAPP_AUTH_EXPIRED' }), { status: 401 });
    }
    if (url.endsWith('/auth/miniapp-session')) {
      return new Response(
        JSON.stringify({
          authenticated: true,
          csrfToken,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const api = createApiTransport(initData, {
    apiBases: ['https://major-maksimov.ru/api/v1'],
    authSession,
    durableSession: true,
  });

  assert.equal(await api.request('/me'), null);
  assert.deepEqual(
    calls.map((call) => `${call.init?.method ?? 'GET'} ${String(call.input)}`),
    [
      'POST https://major-maksimov.ru/api/v1/auth/miniapp-session',
      'GET https://major-maksimov.ru/api/v1/auth/miniapp-session',
      'GET https://major-maksimov.ru/api/v1/me',
    ],
  );
  assert.equal(new Headers(calls[2].init?.headers).get('X-Miniapp-Csrf-Token'), csrfToken);
  assert.equal(authSession.getSnapshot().blocked, false);
});

test('serializes durable-session rotation across transports sharing one manager', async () => {
  const apiBase = 'https://major-maksimov.ru/api/v1';
  const firstCredential = 'auth_date=1&hash=first';
  const secondCredential = 'auth_date=2&hash=second';
  const firstSession = createDeferred<Response>();
  const calls: FetchCall[] = [];
  const sharedSession = createMiniappServerSessionManager(true);

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const url = String(input);
    const authorization = new Headers(init?.headers).get('Authorization') ?? '';
    if (url.endsWith('/auth/miniapp-session')) {
      if (authorization.includes('hash=first')) {
        return firstSession.promise;
      }
      return new Response(
        JSON.stringify({
          authenticated: true,
          csrfToken: 's'.repeat(43),
          expiresInSec: 60,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const firstApi = createApiTransport(firstCredential, {
    apiBases: [apiBase],
    serverSession: sharedSession,
  });
  const secondApi = createApiTransport(secondCredential, {
    apiBases: [apiBase],
    serverSession: sharedSession,
  });
  const firstRequest = firstApi.request('/first');
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  const secondRequest = secondApi.request('/second');
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

  assert.deepEqual(
    calls.map((call) => new Headers(call.init?.headers).get('Authorization')),
    [`InitData ${firstCredential}`],
  );

  firstSession.resolve(
    new Response(
      JSON.stringify({
        authenticated: true,
        csrfToken: 'f'.repeat(43),
        expiresInSec: 60,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
  await Promise.all([firstRequest, secondRequest]);

  const sessionCalls = calls.filter((call) => String(call.input).endsWith('/auth/miniapp-session'));
  assert.deepEqual(
    sessionCalls.map((call) => new Headers(call.init?.headers).get('Authorization')),
    [`InitData ${firstCredential}`, `InitData ${secondCredential}`],
  );
  const firstBusiness = calls.find((call) => String(call.input).endsWith('/first'));
  const secondBusiness = calls.find((call) => String(call.input).endsWith('/second'));
  assert.equal(
    new Headers(firstBusiness?.init?.headers).get('X-Miniapp-Csrf-Token'),
    'f'.repeat(43),
  );
  assert.equal(
    new Headers(secondBusiness?.init?.headers).get('X-Miniapp-Csrf-Token'),
    's'.repeat(43),
  );
});

test('an aborted queued session bootstrap never starts its business fetch', async () => {
  const apiBase = 'https://major-maksimov.ru/api/v1';
  const firstSession = createDeferred<Response>();
  const calls: FetchCall[] = [];
  const sharedSession = createMiniappServerSessionManager(true);

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    if (String(input).endsWith('/auth/miniapp-session')) {
      return firstSession.promise;
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const firstApi = createApiTransport('auth_date=1&hash=first', {
    apiBases: [apiBase],
    serverSession: sharedSession,
  });
  const abortedApi = createApiTransport('auth_date=2&hash=aborted', {
    apiBases: [apiBase],
    serverSession: sharedSession,
  });
  const firstRequest = firstApi.request('/first');
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  const controller = new AbortController();
  const abortedRequest = abortedApi.request('/must-not-run', { signal: controller.signal });
  controller.abort();
  firstSession.resolve(
    new Response(
      JSON.stringify({
        authenticated: true,
        csrfToken: 'f'.repeat(43),
        expiresInSec: 60,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );

  await firstRequest;
  await assert.rejects(
    abortedRequest,
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
  assert.equal(
    calls.some((call) => String(call.input).endsWith('/must-not-run')),
    false,
  );
  assert.equal(
    calls.some((call) =>
      (new Headers(call.init?.headers).get('Authorization') ?? '').includes('hash=aborted'),
    ),
    false,
  );
});

test('deduplicates CSRF recovery and replays each rejected request once', async () => {
  const apiBase = 'https://major-maksimov.ru/api/v1';
  const credential = 'auth_date=1&hash=csrf';
  const staleCsrf = 'o'.repeat(43);
  const freshCsrf = 'n'.repeat(43);
  const calls: FetchCall[] = [];
  const recoveryResponse = createDeferred<Response>();
  const recoveryStarted = createDeferred<void>();
  let recoveryCalls = 0;
  const sharedSession = createMiniappServerSessionManager(true);

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const url = String(input);
    if (url.endsWith('/auth/miniapp-session') && init?.method === 'POST') {
      return new Response(
        JSON.stringify({ authenticated: true, csrfToken: staleCsrf, expiresInSec: 60 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/auth/miniapp-session')) {
      recoveryCalls += 1;
      recoveryStarted.resolve();
      return recoveryResponse.promise;
    }

    const csrfToken = new Headers(init?.headers).get('X-Miniapp-Csrf-Token');
    return csrfToken === staleCsrf
      ? new Response(JSON.stringify({ code: 'MINIAPP_CSRF_REJECTED' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(null, { status: 204 });
  }) as typeof fetch;

  const api = createApiTransport(credential, {
    apiBases: [apiBase],
    serverSession: sharedSession,
  });
  const first = api.request('/first-mutation', { method: 'POST', body: '{"first":true}' });
  const second = api.request('/second-mutation', { method: 'POST', body: '{"second":true}' });
  await recoveryStarted.promise;
  recoveryResponse.resolve(
    new Response(JSON.stringify({ authenticated: true, csrfToken: freshCsrf, expiresInSec: 60 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(recoveryCalls, 1);
  for (const path of ['/first-mutation', '/second-mutation']) {
    const pathCalls = calls.filter((call) => String(call.input).endsWith(path));
    assert.equal(pathCalls.length, 2);
    assert.deepEqual(
      pathCalls.map((call) => new Headers(call.init?.headers).get('X-Miniapp-Csrf-Token')),
      [staleCsrf, freshCsrf],
    );
  }
});

test('does not recover or replay a generic 403 response', async () => {
  const apiBase = 'https://major-maksimov.ru/api/v1';
  const calls: FetchCall[] = [];
  const sharedSession = createMiniappServerSessionManager(true);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    if (String(input).endsWith('/auth/miniapp-session')) {
      return new Response(
        JSON.stringify({ authenticated: true, csrfToken: 'c'.repeat(43), expiresInSec: 60 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ code: 'SETTINGS_SCREEN_ACCESS_DENIED' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const api = createApiTransport('auth_date=1&hash=denied', {
    apiBases: [apiBase],
    serverSession: sharedSession,
  });
  await assert.rejects(
    () => api.request('/denied'),
    (error: unknown) => error instanceof ApiRequestError && error.status === 403,
  );

  assert.equal(calls.length, 2);
  assert.equal(calls.filter((call) => String(call.input).endsWith('/denied')).length, 1);
});

test('recovers CSRF state without replaying a stream body', async () => {
  const calls: FetchCall[] = [];
  let recoverCalls = 0;
  const api = createApiTransport('auth_date=1&hash=stream', {
    apiBases: ['https://major-maksimov.ru/api/v1'],
    serverSession: {
      async ensure() {},
      async recover() {
        recoverCalls += 1;
        return true;
      },
      applyHeaders(_apiBase, _initData, headers) {
        const csrfToken = 'c'.repeat(43);
        headers.set('X-Miniapp-Csrf-Token', csrfToken);
        return csrfToken;
      },
    },
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ code: 'MINIAPP_CSRF_REJECTED' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  await assert.rejects(
    () =>
      api.request('/stream-upload', {
        method: 'POST',
        body: new ReadableStream(),
      }),
    (error: unknown) => error instanceof ApiRequestError && error.status === 403,
  );
  assert.equal(recoverCalls, 1);
  assert.equal(calls.length, 1);
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

test('observes fresh init data without replaying a stream body after 401', async () => {
  const calls: FetchCall[] = [];
  let currentInitData = 'auth_date=1&hash=stale';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    currentInitData = 'auth_date=2&hash=fresh';
    return createResponse({
      ok: false,
      status: 401,
      text: JSON.stringify({ code: 'MINIAPP_AUTH_EXPIRED' }),
    });
  }) as typeof fetch;

  const api = createApiTransport(() => currentInitData);
  await assert.rejects(
    () =>
      api.request('/stream-upload', {
        method: 'POST',
        body: new ReadableStream(),
      }),
    (error: unknown) => error instanceof ApiRequestError && error.status === 401,
  );
  assert.equal(calls.length, 1);
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

test('auth latch blocks request storms until a fresh credential for the same user arrives', async () => {
  const calls: FetchCall[] = [];
  const initial = new URLSearchParams({
    auth_date: '1',
    hash: 'stale',
    user: JSON.stringify({ id: 'user-1' }),
  }).toString();
  const refreshed = new URLSearchParams({
    auth_date: '2',
    hash: 'fresh',
    user: JSON.stringify({ id: 'user-1' }),
  }).toString();
  const authSession = createAuthSessionCoordinator(initial);

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    const authorization = new Headers(init?.headers).get('Authorization') ?? '';
    if (authorization.includes('hash=stale')) {
      return createResponse({
        ok: false,
        status: 401,
        text: JSON.stringify({ code: 'MINIAPP_AUTH_EXPIRED' }),
      });
    }
    return createResponse({ ok: true, status: 204, text: '', contentType: null });
  }) as typeof fetch;

  const staleApi = createApiTransport(initial, {
    apiBases: ['https://major-maksimov.ru/api/v1'],
    authSession,
  });
  await assert.rejects(
    () => staleApi.request('/me'),
    (error: unknown) => error instanceof ApiRequestError && error.status === 401,
  );
  await assert.rejects(
    () => staleApi.request('/chats'),
    (error: unknown) => error instanceof ApiRequestError && error.status === 401,
  );
  staleApi.requestKeepalive('/presence', { method: 'POST' });
  assert.equal(calls.length, 1);

  assert.equal(authSession.observeInitData(refreshed), true);
  const refreshedApi = createApiTransport(refreshed, {
    apiBases: ['https://major-maksimov.ru/api/v1'],
    authSession,
  });
  assert.equal(await refreshedApi.request('/me'), null);
  assert.equal(calls.length, 2);
});

test('loads a structured publication conflict error on the async HTTP error path', async () => {
  globalThis.fetch = (async () =>
    createResponse({
      ok: false,
      status: 409,
      text: JSON.stringify({
        statusCode: 409,
        code: 'PUBLICATION_REVISION_CONFLICT',
        message: 'Публикация уже изменена.',
        currentRevision: 4,
      }),
      contentType: 'application/json; charset=utf-8',
    })) as typeof fetch;

  const api = createApiTransport('auth_date=1&hash=first', {
    apiBases: ['https://major-maksimov.ru/api/v1'],
  });

  await assert.rejects(
    () => api.request('/publications/publication-1', { method: 'PUT', body: '{}' }),
    (error: unknown) => {
      assert.equal(error instanceof ApiRequestError, true);
      const apiError = error as ApiRequestError;
      assert.equal(apiError.status, 409);
      assert.equal(apiError.code, 'PUBLICATION_REVISION_CONFLICT');
      assert.equal(apiError.message, 'Публикация уже изменена.');
      assert.deepEqual(apiError.payload, {
        statusCode: 409,
        code: 'PUBLICATION_REVISION_CONFLICT',
        message: 'Публикация уже изменена.',
        currentRevision: 4,
      });
      return true;
    },
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

test('honors a request-specific timeout without forwarding it to fetch', async () => {
  const calls: FetchCall[] = [];
  const timeoutValues: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    return createResponse({ ok: true, status: 204, text: '', contentType: null });
  }) as typeof fetch;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    timeoutValues.push(Number(timeout));
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;

  try {
    const api = createApiTransport('auth_date=1&hash=first');

    await api.request('/channels/channel-1/polls/poll-1/publish', {
      method: 'POST',
      timeoutMs: 123_456,
    });

    assert.equal(timeoutValues.includes(123_456), true);
    assert.equal('timeoutMs' in (calls[0].init ?? {}), false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('uses the first reachable API base for idempotent requests', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    if (matchesRequestUrl(input, CDN_API_ORIGIN)) {
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

test('tries the next API base when the primary returns a transient error response', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    if (matchesRequestUrl(input, CDN_API_ORIGIN)) {
      return createResponse({
        ok: false,
        status: 503,
        text: JSON.stringify({ message: 'Unavailable' }),
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

test('does not try another API base after a terminal 403 response', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    return createResponse({
      ok: false,
      status: 403,
      text: JSON.stringify({ message: 'Forbidden' }),
    });
  }) as typeof fetch;

  const api = createApiTransport('auth_date=1&hash=first', {
    apiBases: ['https://api-cdn.flex-craft.ru/api/v1', 'https://major-maksimov.ru/api/v1'],
  });

  await assert.rejects(() => api.request('/chats'), /Недостаточно прав/u);
  assert.deepEqual(
    calls.map((call) => String(call.input)),
    ['https://api-cdn.flex-craft.ru/api/v1/chats'],
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
  assert.deepEqual(
    calls.map((call) => String(call.input)),
    ['https://major-maksimov.ru/api/v1/chats'],
  );
});

test('does not let a hedged fallback 401 beat a successful primary idempotent request', async () => {
  const calls: FetchCall[] = [];
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    if (matchesRequestUrl(input, CDN_API_ORIGIN)) {
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
    assert.deepEqual(
      calls.map((call) => String(call.input)),
      ['https://major-maksimov.ru/api/v1/chats', 'https://api-cdn.flex-craft.ru/api/v1/chats'],
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('keeps the primary HTTP failure when all idempotent API bases fail', async () => {
  const calls: FetchCall[] = [];
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    if (matchesRequestUrl(input, CDN_API_ORIGIN)) {
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
    assert.deepEqual(
      calls.map((call) => String(call.input)),
      ['https://major-maksimov.ru/api/v1/chats', 'https://api-cdn.flex-craft.ru/api/v1/chats'],
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('uses the selected API base for follow-up mutation requests', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    if (matchesRequestUrl(input, CDN_API_ORIGIN)) {
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
    if (matchesRequestUrl(input, CDN_API_ORIGIN, MUTATION_TUNNEL_PATH)) {
      return createResponse({
        ok: true,
        status: 204,
        text: '',
        contentType: null,
      });
    }

    if (matchesRequestUrl(input, CDN_API_ORIGIN)) {
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
    if (matchesRequestUrl(input, CDN_API_ORIGIN, MUTATION_TUNNEL_PATH)) {
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
    if (matchesRequestUrl(input, CDN_API_ORIGIN)) {
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

test('does not retry a stream mutation body on another API base', async () => {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    throw new TypeError('Network request failed');
  }) as typeof fetch;

  const api = createApiTransport('auth_date=1&hash=first', {
    apiBases: ['https://api-cdn.flex-craft.ru/api/v1', 'https://major-maksimov.ru/api/v1'],
  });

  await assert.rejects(
    () =>
      api.request('/stream-upload', {
        method: 'POST',
        body: new ReadableStream(),
      }),
    /Нет связи с сервисом/u,
  );
  assert.deepEqual(calls.map((call) => String(call.input)), [
    'https://api-cdn.flex-craft.ru/api/v1/stream-upload',
  ]);
});

test('tries the mutation tunnel when the preferred tunnel host is the last fallback', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    if (matchesRequestUrl(input, CDN_API_ORIGIN, MUTATION_TUNNEL_PATH)) {
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
      contentType: 'text/html',
    });
  }) as typeof fetch;

  const api = createApiTransport('auth_date=1&hash=first', {
    apiBases: ['https://major-maksimov.ru/api/v1', 'https://api-cdn.flex-craft.ru/api/v1'],
  });

  const result = await api.request('/chats/chat-1/settings', {
    method: 'PUT',
    body: JSON.stringify({ antiSpamEnabled: true }),
  });

  assert.equal(result, null);
  assert.deepEqual(
    calls.map((call) => new URL(String(call.input)).origin + new URL(String(call.input)).pathname),
    [
      'https://major-maksimov.ru/api/v1/chats/chat-1/settings',
      'https://major-maksimov.ru/api/v1/_mutation-tunnel',
      'https://api-cdn.flex-craft.ru/api/v1/chats/chat-1/settings',
      'https://api-cdn.flex-craft.ru/api/v1/_mutation-tunnel',
    ],
  );
});

test('tunnels mutation requests when the original CDN mutation fails as a network error', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    if (matchesRequestUrl(input, CDN_API_ORIGIN, MUTATION_TUNNEL_PATH)) {
      return createResponse({
        ok: true,
        status: 204,
        text: '',
        contentType: null,
      });
    }

    if (matchesRequestUrl(input, CDN_API_ORIGIN)) {
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

test('starts keepalive mutation requests with the tunnel on preferred API hosts', async () => {
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
    apiBases: ['https://api-cdn.flex-craft.ru/api/v1'],
  });

  api.requestKeepalive('/chats/chat-1/members/user-1/profile/handoff', {
    method: 'POST',
    body: JSON.stringify({ label: 'Admin' }),
  });
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

  assert.equal(calls.length, 1);
  const tunnelUrl = new URL(String(calls[0].input));
  assert.equal(tunnelUrl.origin, 'https://api-cdn.flex-craft.ru');
  assert.equal(tunnelUrl.pathname, '/api/v1/_mutation-tunnel');
  assert.equal(tunnelUrl.searchParams.get('method'), 'POST');
  assert.equal(tunnelUrl.searchParams.get('path'), '/chats/chat-1/members/user-1/profile/handoff');
  assert.equal(calls[0].init?.method, 'GET');
  assert.equal(calls[0].init?.keepalive, true);
  assert.equal(
    new Headers(calls[0].init?.headers).get('Authorization'),
    'InitData auth_date=1&hash=first',
  );
});

test('falls back to the keepalive mutation tunnel after a non-preferred host rejects POST', async () => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    if (matchesRequestUrl(input, MAJOR_API_ORIGIN, MUTATION_TUNNEL_PATH)) {
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
    apiBases: ['https://major-maksimov.ru/api/v1'],
  });

  api.requestKeepalive('/chats/chat-1/members/user-1/profile/handoff', {
    method: 'POST',
    body: JSON.stringify({ label: 'Admin' }),
  });
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

  assert.equal(calls.length, 2);
  assert.equal(
    String(calls[0].input),
    'https://major-maksimov.ru/api/v1/chats/chat-1/members/user-1/profile/handoff',
  );
  const tunnelUrl = new URL(String(calls[1].input));
  assert.equal(tunnelUrl.origin, 'https://major-maksimov.ru');
  assert.equal(tunnelUrl.pathname, '/api/v1/_mutation-tunnel');
  assert.equal(tunnelUrl.searchParams.get('method'), 'POST');
  assert.equal(tunnelUrl.searchParams.get('path'), '/chats/chat-1/members/user-1/profile/handoff');
  assert.equal(calls[1].init?.method, 'GET');
  assert.equal(calls[1].init?.keepalive, true);
});

test.afterEach(() => {
  delete (globalThis as { fetch?: typeof fetch }).fetch;
});
