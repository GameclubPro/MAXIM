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
        return name.toLowerCase() === 'content-type' ? (options.contentType ?? 'application/json') : null;
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
  assert.equal(new Headers(calls[0].init?.headers).get('Authorization'), 'InitData auth_date=1&hash=first');
  assert.equal(new Headers(calls[1].init?.headers).get('Authorization'), 'InitData auth_date=2&hash=second');
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
  assert.equal(new Headers(calls[0].init?.headers).get('Authorization'), 'InitData auth_date=1&hash=stale');
  assert.equal(new Headers(calls[1].init?.headers).get('Authorization'), 'InitData auth_date=2&hash=fresh');
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
  assert.equal(new Headers(calls[0].init?.headers).get('Authorization'), 'InitData auth_date=1&hash=stale');
  assert.equal(new Headers(calls[1].init?.headers).get('Authorization'), 'InitData auth_date=2&hash=fresh');
});

test.afterEach(() => {
  delete (globalThis as { fetch?: typeof fetch }).fetch;
});
