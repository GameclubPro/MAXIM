import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { MaxError } from '../src/max.js';
import { startAfterSubscription, startService } from '../src/startup.js';

test('ingress stays available during startup cooldown and workers start only after verification', async () => {
  const server = createServer((_request, response) => response.end('receipt accepted'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const controller = new AbortController();
  let attempts = 0;
  let started = false;
  const beginning = Date.now();
  const startup = startAfterSubscription(
    async () => {
      if (++attempts === 1) throw new MaxError(429, 'rate_limit_cooldown', false, 1000);
      assert.ok(Date.now() - beginning >= 1000);
    },
    async () => {
      started = true;
    },
    controller.signal,
  );
  try {
    await nextTurn();
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook`, { method: 'POST' });
    assert.equal(await response.text(), 'receipt accepted');
    assert.equal(attempts, 1);
    assert.equal(started, false);
    assert.equal(await startup, true);
    assert.equal(attempts, 2);
    assert.equal(started, true);
  } finally {
    controller.abort();
    await startup;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('shutdown cancels a multi-day cooldown without starting workers or retrying MAX', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const startup = startAfterSubscription(
    async () => {
      attempts++;
      throw new MaxError(429, 'rate_limit_cooldown', false, 3 * 86_400_000);
    },
    async () => assert.fail('workers must not start'),
    controller.signal,
  );
  await nextTurn();
  controller.abort();
  assert.equal(await startup, false);
  assert.equal(attempts, 1);
});

test('shutdown during subscription verification prevents workers from starting', async () => {
  const controller = new AbortController();
  assert.equal(
    await startAfterSubscription(
      async () => controller.abort(),
      async () => assert.fail('workers must not start'),
      controller.signal,
    ),
    false,
  );
});

test('shutdown during store preparation cannot reopen ingress after cleanup', async () => {
  const controller = new AbortController();
  assert.equal(
    await startService(
      {
        prepare: async () => controller.abort(),
        listen: async () => assert.fail('ingress must not reopen'),
        subscribe: async () => assert.fail('MAX must not be called'),
        start: async () => assert.fail('workers must not start'),
      },
      controller.signal,
    ),
    false,
  );
});

test('shutdown while ingress is opening does not start subscription or workers', async () => {
  const controller = new AbortController();
  assert.equal(
    await startService(
      {
        prepare: async () => {},
        listen: async () => controller.abort(),
        subscribe: async () => assert.fail('MAX must not be called'),
        start: async () => assert.fail('workers must not start'),
      },
      controller.signal,
    ),
    false,
  );
});

test('identity, transport and unknown-effect failures remain fatal startup errors', async () => {
  for (const error of [
    new Error('identity conflict'),
    new MaxError(403, 'access.denied', false),
    new MaxError(0, 'transport_unknown', false),
    new MaxError(429, 'untrusted', true),
  ]) {
    await assert.rejects(
      startAfterSubscription(
        async () => {
          throw error;
        },
        async () => assert.fail('workers must not start'),
        new AbortController().signal,
      ),
      (caught) => caught === error,
    );
  }
});

test('a worker startup failure is not retried as a subscription failure', async () => {
  let attempts = 0;
  const error = new MaxError(429, 'unrelated', false);
  await assert.rejects(
    startAfterSubscription(
      async () => {},
      async () => {
        attempts++;
        throw error;
      },
      new AbortController().signal,
    ),
    (caught) => caught === error,
  );
  assert.equal(attempts, 1);
});
