import assert from 'node:assert/strict';
import test from 'node:test';
import { createMiniappServerSessionManager } from '../src/lib/api/miniapp-server-session';

const API_BASE = 'https://major-maksimov.ru/api/v1';
const CSRF_TOKEN = 'c'.repeat(43);

function sessionResponse(csrfToken = CSRF_TOKEN): Response {
  return new Response(
    JSON.stringify({
      authenticated: true,
      csrfToken,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test('bootstraps one cookie session and applies its CSRF token', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return sessionResponse();
  }) as typeof fetch;

  const manager = createMiniappServerSessionManager(true);
  await Promise.all([
    manager.ensure(API_BASE, 'auth_date=1&hash=first'),
    manager.ensure(API_BASE, 'auth_date=1&hash=first'),
  ]);
  await manager.ensure(API_BASE, 'auth_date=1&hash=first');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, `${API_BASE}/auth/miniapp-session`);
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.credentials, 'include');
  assert.equal(
    new Headers(calls[0].init?.headers).get('Authorization'),
    'InitData auth_date=1&hash=first',
  );
  const headers = new Headers();
  manager.applyHeaders(API_BASE, 'auth_date=1&hash=first', headers);
  assert.equal(headers.get('X-Miniapp-Csrf-Token'), CSRF_TOKEN);
});

test('recovers a cookie session when the current init data is already expired', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const methods: string[] = [];
  const authorizations: Array<string | null> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    authorizations.push(new Headers(init?.headers).get('Authorization'));
    return methods.length === 1
      ? new Response(JSON.stringify({ code: 'MINIAPP_AUTH_EXPIRED' }), { status: 401 })
      : sessionResponse();
  }) as typeof fetch;

  const manager = createMiniappServerSessionManager(true);
  await manager.ensure(API_BASE, 'auth_date=1&hash=expired');

  assert.deepEqual(methods, ['POST', 'GET']);
  assert.deepEqual(authorizations, [
    'InitData auth_date=1&hash=expired',
    'InitData auth_date=1&hash=expired',
  ]);
  const headers = new Headers();
  manager.applyHeaders(API_BASE, 'auth_date=1&hash=expired', headers);
  assert.equal(headers.get('X-Miniapp-Csrf-Token'), CSRF_TOKEN);
});

test('keeps raw init data fallback quiet when the server session endpoint is not deployed', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('', { status: 404 });
  }) as typeof fetch;

  const manager = createMiniappServerSessionManager(true);
  await manager.ensure(API_BASE, 'auth_date=1&hash=first');
  await manager.ensure(API_BASE, 'auth_date=1&hash=first');

  assert.equal(calls, 1);
  const headers = new Headers();
  manager.applyHeaders(API_BASE, 'auth_date=1&hash=first', headers);
  assert.equal(headers.has('X-Miniapp-Csrf-Token'), false);
});

test('rotates the server session when MAX supplies a new credential', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const credentials: Array<string | null> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    credentials.push(new Headers(init?.headers).get('Authorization'));
    return sessionResponse();
  }) as typeof fetch;

  const manager = createMiniappServerSessionManager(true);
  await manager.ensure(API_BASE, 'auth_date=1&hash=first');
  await manager.ensure(API_BASE, 'auth_date=2&hash=second');

  assert.deepEqual(credentials, [
    'InitData auth_date=1&hash=first',
    'InitData auth_date=2&hash=second',
  ]);
});

test('does not recover a cookie session for non-expired 401 codes', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const methods: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    return new Response(JSON.stringify({ code: 'MINIAPP_AUTH_INVALID' }), { status: 401 });
  }) as typeof fetch;

  const manager = createMiniappServerSessionManager(true);
  await manager.ensure(API_BASE, 'auth_date=1&hash=invalid');

  assert.deepEqual(methods, ['POST']);
  const headers = new Headers();
  manager.applyHeaders(API_BASE, 'auth_date=1&hash=invalid', headers);
  assert.equal(headers.has('X-Miniapp-Csrf-Token'), false);
});

test('accepts expiresInSec and keeps expiresAt as a compatible fallback', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        authenticated: true,
        csrfToken: CSRF_TOKEN,
        expiresInSec: 60,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const manager = createMiniappServerSessionManager(true);
  await manager.ensure(API_BASE, 'auth_date=1&hash=relative-expiry');
  await manager.ensure(API_BASE, 'auth_date=1&hash=relative-expiry');

  assert.equal(calls, 1);
  const headers = new Headers();
  manager.applyHeaders(API_BASE, 'auth_date=1&hash=relative-expiry', headers);
  assert.equal(headers.get('X-Miniapp-Csrf-Token'), CSRF_TOKEN);
});

test('does not attach a CSRF token after its absolute session TTL expires', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        authenticated: true,
        csrfToken: CSRF_TOKEN,
        expiresInSec: 0.001,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

  const manager = createMiniappServerSessionManager(true);
  await manager.ensure(API_BASE, 'auth_date=1&hash=short-lived');
  await new Promise((resolve) => globalThis.setTimeout(resolve, 5));

  const headers = new Headers();
  assert.equal(manager.applyHeaders(API_BASE, 'auth_date=1&hash=short-lived', headers), null);
  assert.equal(headers.has('X-Miniapp-Csrf-Token'), false);
});

test('serializes different credentials per API base and keeps the newest state', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const firstResponse = createDeferred<Response>();
  const credentials: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('Authorization') ?? '';
    credentials.push(authorization);
    return authorization.includes('hash=first')
      ? firstResponse.promise
      : sessionResponse('n'.repeat(43));
  }) as typeof fetch;

  const manager = createMiniappServerSessionManager(true);
  const first = manager.ensure(API_BASE, 'auth_date=1&hash=first');
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  const second = manager.ensure(API_BASE, 'auth_date=2&hash=second');
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

  assert.deepEqual(credentials, ['InitData auth_date=1&hash=first']);
  firstResponse.resolve(sessionResponse('o'.repeat(43)));
  await Promise.all([first, second]);
  assert.deepEqual(credentials, [
    'InitData auth_date=1&hash=first',
    'InitData auth_date=2&hash=second',
  ]);

  const staleHeaders = new Headers();
  manager.applyHeaders(API_BASE, 'auth_date=1&hash=first', staleHeaders);
  assert.equal(staleHeaders.has('X-Miniapp-Csrf-Token'), false);
  const currentHeaders = new Headers();
  manager.applyHeaders(API_BASE, 'auth_date=2&hash=second', currentHeaders);
  assert.equal(currentHeaders.get('X-Miniapp-Csrf-Token'), 'n'.repeat(43));
});

test('skips an aborted bootstrap while it is queued', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const firstResponse = createDeferred<Response>();
  const credentials: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    credentials.push(new Headers(init?.headers).get('Authorization') ?? '');
    return firstResponse.promise;
  }) as typeof fetch;

  const manager = createMiniappServerSessionManager(true);
  const first = manager.ensure(API_BASE, 'auth_date=1&hash=first');
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  const controller = new AbortController();
  const queued = manager.ensure(API_BASE, 'auth_date=2&hash=aborted', {
    signal: controller.signal,
  });
  controller.abort();
  firstResponse.resolve(sessionResponse());

  await first;
  await assert.rejects(
    queued,
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
  assert.deepEqual(credentials, ['InitData auth_date=1&hash=first']);
});
