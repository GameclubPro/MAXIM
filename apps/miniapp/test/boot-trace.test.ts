import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeMiniappBootTraceText, traceMiniappBoot } from '../src/lib/boot-trace';
import { dispatchMiniappBootTrace } from '../src/lib/boot-trace-runtime';
import { createMiniappBootTraceSessionId } from '../src/lib/boot-trace-session-id';
import {
  claimPublicationApiTraceSample,
  shouldEnablePublicationApiTrace,
} from '../src/lib/publication-api-trace';

function encodeBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

test('boot trace session IDs prefer randomUUID over other sources', () => {
  let getRandomValuesCalled = false;
  const sessionId = createMiniappBootTraceSessionId({
    randomUUID: () => '123e4567-e89b-12d3-a456-426614174000',
    getRandomValues: (bytes) => {
      getRandomValuesCalled = true;
      return bytes;
    },
  });

  assert.equal(sessionId, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(getRandomValuesCalled, false);
});

test('boot trace session IDs use cryptographic bytes when randomUUID is unavailable', () => {
  const sessionId = createMiniappBootTraceSessionId({
    getRandomValues: (bytes) => {
      bytes.set(Array.from({ length: 16 }, (_value, index) => index));
      return bytes;
    },
  });

  assert.equal(sessionId, '000102030405060708090a0b0c0d0e0f');
});

test('boot trace session IDs remain unique with the monotonic fallback', () => {
  const now = () => 1_700_000_000_000;
  const first = createMiniappBootTraceSessionId(null, now);
  const second = createMiniappBootTraceSessionId(null, now);

  assert.notEqual(first, second);
  assert.equal(first.startsWith(`${now().toString(36)}-`), true);
  assert.equal(second.startsWith(`${now().toString(36)}-`), true);
});

test('boot trace text sanitizer redacts startapp and channel dialog payload previews', () => {
  const dialogToken = 'dialog-token-secret-123456';
  const encodedPayload = encodeBase64Url({
    v: 1,
    k: 'chat-dialog',
    c: '-100',
    m: 'comments',
    t: dialogToken,
  });
  const startParam = `cd-${encodedPayload}`;

  const sanitized = sanitizeMiniappBootTraceText(
    [
      `/app/?startapp=${startParam}&screen=dialog`,
      `start_param=${startParam}`,
      `preview ${startParam}`,
      JSON.stringify({
        v: 1,
        k: 'chat-dialog',
        c: '-100',
        m: 'comments',
        t: dialogToken,
      }),
    ].join(' | '),
    1_000,
  );

  assert.equal(sanitized.includes(dialogToken), false);
  assert.equal(sanitized.includes(encodedPayload), false);
  assert.match(sanitized, /startapp=\[redacted\]/u);
  assert.match(sanitized, /start_param=\[redacted\]/u);
  assert.match(sanitized, /preview cd-\[redacted\]/u);
  assert.match(sanitized, /"t":"\[redacted\]"/u);
});

test('boot trace text sanitizer redacts exact search parameter keys', () => {
  const sanitized = sanitizeMiniappBootTraceText(
    '/app/publications?q=first&query=second&search=third&searchMode=all',
    1_000,
  );

  assert.match(sanitized, /q=\[redacted\]/u);
  assert.match(sanitized, /query=\[redacted\]/u);
  assert.match(sanitized, /search=\[redacted\]/u);
  assert.match(sanitized, /searchMode=all/u);
  assert.equal(sanitized.includes('first'), false);
  assert.equal(sanitized.includes('second'), false);
  assert.equal(sanitized.includes('third'), false);
});

test('lazy boot trace runtime preserves early event order and sanitization', async () => {
  const originalFetch = globalThis.fetch;
  const payloads: Array<Record<string, unknown>> = [];
  let resolveDispatch: () => void = () => undefined;
  const dispatched = new Promise<void>((resolve) => {
    resolveDispatch = resolve;
  });

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (payloads.length === 2) {
      resolveDispatch();
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    assert.equal(
      traceMiniappBoot('bridge_ready', { token: 'first-secret' }, { runtimeEnabled: true }),
      true,
    );
    assert.equal(
      traceMiniappBoot('init_data_found', { stage: 'second' }, { runtimeEnabled: true }),
      true,
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      dispatched,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('boot trace dispatch timed out')), 1_000);
      }),
    ]).finally(() => clearTimeout(timeout));

    assert.deepEqual(
      payloads.map((payload) => payload.phase),
      ['bridge_ready', 'init_data_found'],
    );
    assert.equal(Number(payloads[1]?.sequence), Number(payloads[0]?.sequence) + 1);
    assert.deepEqual(payloads[0]?.details, { token: '[redacted]' });
    assert.deepEqual(payloads[1]?.details, { stage: 'second' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('boot trace runtime sends the captured route and native environment snapshot', () => {
  const originalFetch = globalThis.fetch;
  let payload: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    dispatchMiniappBootTrace({
      phase: 'first_render',
      sessionId: 'snapshot-session',
      sequence: 7,
      elapsedMs: 12,
      details: { screen: 'home' },
      route: '/app/?startapp=secret-value&screen=home',
      baseUrl: 'https://major-maksimov.ru/app/',
      platform: 'ios',
      userAgent: 'MAX/snapshot',
      mutationTunnelInitData: null,
    });

    assert.equal(payload?.route, '/app/?startapp=%5Bredacted%5D&screen=home');
    assert.equal(payload?.platform, 'ios');
    assert.equal(payload?.ua, 'MAX/snapshot');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('publication API trace samples are bounded by operation, outcome, and boot window', () => {
  const samples = new Set<string>();

  assert.equal(claimPublicationApiTraceSample('list', 'ok', 1_000, samples), true);
  assert.equal(claimPublicationApiTraceSample('list', 'ok', 2_000, samples), false);
  assert.equal(claimPublicationApiTraceSample('list', 'error', 2_000, samples), true);
  assert.equal(claimPublicationApiTraceSample('details', 'ok', 600_000, samples), true);
  assert.equal(claimPublicationApiTraceSample('action', 'ok', 600_001, samples), false);
});

test('publication API traces cover native Android and iOS without enabling ordinary browsers', () => {
  assert.equal(shouldEnablePublicationApiTrace('Mozilla/5.0', 'android', false), true);
  assert.equal(shouldEnablePublicationApiTrace('Mozilla/5.0 MAX/1.2.3', null, false), true);
  assert.equal(shouldEnablePublicationApiTrace('Mozilla/5.0', 'ios', false), true);
  assert.equal(shouldEnablePublicationApiTrace('Mozilla/5.0', 'web', false), false);
  assert.equal(shouldEnablePublicationApiTrace('Mozilla/5.0', null, true), true);
});
