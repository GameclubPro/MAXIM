import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
  waitForMiniappUrl,
} from './miniapp-local-server.mjs';

const html = '<script src="/app/@vite/client"></script><script src="/app/src/main.tsx"></script>';
async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}/app/`;
}

test('readiness rejects errors, redirects, foreign apps, and the wrong owned-server identity', async (t) => {
  for (const variant of ['404', 'redirect', 'other', 'identity']) {
    const url = await serve(t, (_req, res) => {
      res.writeHead(variant === '404' ? 404 : variant === 'redirect' ? 302 : 200, {
        'Content-Type': 'text/html',
        'X-Maxim-Visual-Server': 'wrong',
      });
      res.end(variant === 'other' ? 'unrelated app' : html);
    });
    await assert.rejects(waitForMiniappUrl(url, 100, { identity: 'expected' }), /Timed out/u);
  }
});

test('explicit reuse validates the app and never takes ownership of its process', async (t) => {
  const url = await serve(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  assert.equal(
    await ensureMiniappDevServer(url, { reuseServer: true, waitTimeoutMs: 1_000 }),
    null,
  );
  await stopChildProcess(null);
  assert.equal((await fetch(url)).status, 200);
});

test('a stalled readiness response respects its deadline', async (t) => {
  const url = await serve(t, () => {});
  const start = Date.now();
  await assert.rejects(waitForMiniappUrl(url, 150), /Timed out/u);
  assert.ok(Date.now() - start < 2_000);
});

test('fresh port allocation leaves an existing listener untouched', async (t) => {
  const existing = await serve(t, (_req, res) => res.end('existing'));
  const fresh = await allocateMiniappBaseUrl(existing);
  assert.notEqual(new URL(existing).port, new URL(fresh).port);
  assert.equal(new URL(fresh).pathname, '/app/');
  assert.equal(await (await fetch(existing)).text(), 'existing');
  await assert.rejects(allocateMiniappBaseUrl('https://major-maksimov.ru/app/'), /local HTTP/u);
});

test('owned startup refuses an occupied port rather than reusing it or silently changing ports', async (t) => {
  const url = await serve(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await assert.rejects(
    ensureMiniappDevServer(url, { waitTimeoutMs: 10_000 }),
    /stopped with exit code 1/u,
  );
  assert.equal((await fetch(url)).status, 200);
});
