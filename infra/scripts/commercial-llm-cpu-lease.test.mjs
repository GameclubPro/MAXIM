import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { before, after, test } from 'node:test';
import Redis from 'ioredis';
import helper from './commercial-llm-cpu-lease.cjs';

const { fingerprint, observeLease, releaseLease, CPU_LEASE_KEY, CPU_RECOVERY_RECEIPT_PREFIX } =
  helper;
let redis;
let server;
let directory;
let cliRedisUrl;
const ownedKeys = new Set();

before(
  async () => {
    const testUrl = process.env.MAXIM_TEST_REDIS_URL ?? process.env.TEST_REDIS_URL;
    const options = {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      commandTimeout: 1000,
      connectTimeout: 1000,
    };
    if (testUrl) {
      cliRedisUrl = testUrl;
      const target = new URL(testUrl);
      assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
      redis = new Redis(testUrl, options);
      redis.on('error', () => {});
      await redis.connect();
    } else {
      // FLAG: Default infra CI runs native tests against this private, non-persistent
      // Unix socket. It never falls back to a production URL or a shared Redis DB.
      directory = await mkdtemp(join(tmpdir(), 'maxim-cpu-lease-'));
      const socket = join(directory, 'redis.sock');
      cliRedisUrl = socket;
      server = spawn(
        'redis-server',
        [
          '--port',
          '0',
          '--unixsocket',
          socket,
          '--unixsocketperm',
          '700',
          '--save',
          '',
          '--appendonly',
          'no',
          '--dir',
          directory,
        ],
        { stdio: 'ignore' },
      );
      let spawnError;
      server.on('error', (error) => {
        spawnError = error;
      });
      let connected = false;
      const startupDeadline = Date.now() + 5000;
      for (let attempt = 0; attempt < 100 && Date.now() < startupDeadline; attempt++) {
        if (spawnError) throw spawnError;
        redis = new Redis({ ...options, path: socket });
        redis.on('error', () => {});
        try {
          await redis.connect();
          connected = true;
          break;
        } catch {
          redis.disconnect();
          await delay(20);
        }
      }
      assert.equal(connected, true, 'private Redis must actually start');
    }
    assert.match(await redis.info('server'), /^redis_version:7\./mu);
  },
  { timeout: 10000 },
);

after(
  async () => {
    if (redis?.status === 'ready' && ownedKeys.size) await redis.del(...ownedKeys);
    redis?.disconnect();
    if (server && server.exitCode === null && !server.signalCode) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      const fallback = setTimeout(() => server.kill('SIGKILL'), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(fallback);
      }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  },
  { timeout: 10000 },
);

function fixture() {
  const operationId = randomUUID();
  const prefix = `cpu-lease-test:${randomUUID()}:`;
  const keys = { leaseKey: `${prefix}lease`, receiptPrefix: `${prefix}receipt:` };
  const receiptKey = keys.receiptPrefix + operationId;
  const cooldownKey = `${prefix}cooldown`;
  const siblingKey = `${prefix}sibling`;
  for (const key of [keys.leaseKey, receiptKey, cooldownKey, siblingKey]) ownedKeys.add(key);
  return { operationId, keys, receiptKey, cooldownKey, siblingKey, token: randomUUID() };
}

function receipt(operationId, hash) {
  return JSON.stringify({ schemaVersion: 1, operationId, fingerprint: hash });
}

test('persistent exact release leaves cooldown and sibling keys intact and records permanent proof', async () => {
  const f = fixture();
  await redis.set(f.keys.leaseKey, f.token);
  await redis.set(f.cooldownKey, 'unchanged', 'PX', 60000);
  await redis.set(f.siblingKey, 'unrelated');
  const observed = await observeLease(redis, f.operationId, f.keys);
  assert.equal(observed.state, 'held_persistent');
  assert.equal(observed.fingerprint, fingerprint(f.token));
  assert.equal(observed.leaseTtlMs, -1);
  assert.equal(JSON.stringify(observed).includes(f.token), false);
  const result = await releaseLease(redis, f.operationId, observed.fingerprint, f.keys);
  assert.equal(result.state, 'released_receipt');
  assert.equal(result.alreadyReleased, false);
  assert.equal(await redis.exists(f.keys.leaseKey), 0);
  assert.equal(await redis.get(f.cooldownKey), 'unchanged');
  assert.equal(await redis.get(f.siblingKey), 'unrelated');
  assert.equal(await redis.pttl(f.receiptKey), -1);
  assert.equal(await redis.get(f.receiptKey), receipt(f.operationId, observed.fingerprint));
});

test('unknown acknowledgement resumes from receipt and never mutates a later foreign lease', async () => {
  const f = fixture();
  await redis.set(f.keys.leaseKey, f.token);
  const hash = fingerprint(f.token);
  await releaseLease(redis, f.operationId, hash, f.keys);
  const nextToken = randomUUID();
  await redis.set(f.keys.leaseKey, nextToken);
  const result = await releaseLease(redis, f.operationId, hash, f.keys);
  assert.equal(result.state, 'released_receipt');
  assert.equal(result.alreadyReleased, true);
  assert.equal(await redis.get(f.keys.leaseKey), nextToken);
  assert.equal((await observeLease(redis, f.operationId, f.keys)).state, 'released_receipt');
});

test('operation reuse with a different fingerprint fails without touching receipt or lease', async () => {
  const f = fixture();
  const saved = receipt(f.operationId, fingerprint(f.token));
  await redis.set(f.receiptKey, saved);
  const nextToken = randomUUID();
  await redis.set(f.keys.leaseKey, nextToken);
  const result = await releaseLease(redis, f.operationId, fingerprint(nextToken), f.keys);
  assert.equal(result.state, 'foreign');
  assert.equal(await redis.get(f.receiptKey), saved);
  assert.equal(await redis.get(f.keys.leaseKey), nextToken);
});

test('missing authority without this operation receipt never becomes successful release', async () => {
  const f = fixture();
  assert.equal((await observeLease(redis, f.operationId, f.keys)).state, 'missing');
  assert.equal(
    (await releaseLease(redis, f.operationId, fingerprint(f.token), f.keys)).state,
    'missing',
  );
  assert.equal(await redis.exists(f.receiptKey), 0);
});

test('expiring leases and fingerprint mismatches remain held without a receipt', async () => {
  const f = fixture();
  await redis.set(f.keys.leaseKey, f.token, 'PX', 60000);
  assert.equal((await observeLease(redis, f.operationId, f.keys)).state, 'held_expiring');
  assert.equal(
    (await releaseLease(redis, f.operationId, fingerprint(f.token), f.keys)).state,
    'held_expiring',
  );
  await redis.persist(f.keys.leaseKey);
  assert.equal(
    (await releaseLease(redis, f.operationId, fingerprint(randomUUID()), f.keys)).state,
    'foreign',
  );
  assert.equal(await redis.get(f.keys.leaseKey), f.token);
  assert.equal(await redis.exists(f.receiptKey), 0);
});

test('a lease replacement between observation and atomic CAS is preserved', async () => {
  const f = fixture();
  await redis.set(f.keys.leaseKey, f.token);
  const nextToken = randomUUID();
  let calls = 0;
  const interposed = {
    async eval(...args) {
      if (++calls === 2) await redis.set(f.keys.leaseKey, nextToken);
      return redis.eval(...args);
    },
  };
  const result = await releaseLease(interposed, f.operationId, fingerprint(f.token), f.keys);
  assert.equal(result.state, 'foreign');
  assert.equal(await redis.get(f.keys.leaseKey), nextToken);
  assert.equal(await redis.exists(f.receiptKey), 0);
});

test('a lease becoming expiring between observation and CAS is preserved', async () => {
  const f = fixture();
  await redis.set(f.keys.leaseKey, f.token);
  let calls = 0;
  const interposed = {
    async eval(...args) {
      if (++calls === 2) await redis.pexpire(f.keys.leaseKey, 60000);
      return redis.eval(...args);
    },
  };
  assert.equal(
    (await releaseLease(interposed, f.operationId, fingerprint(f.token), f.keys)).state,
    'held_expiring',
  );
  assert.equal(await redis.get(f.keys.leaseKey), f.token);
  assert.equal(await redis.exists(f.receiptKey), 0);
});

test('a conflicting receipt appearing between observation and CAS preserves the lease', async () => {
  const f = fixture();
  await redis.set(f.keys.leaseKey, f.token);
  const conflicting = receipt(f.operationId, fingerprint(randomUUID()));
  let calls = 0;
  const interposed = {
    async eval(...args) {
      if (++calls === 2) await redis.set(f.receiptKey, conflicting);
      return redis.eval(...args);
    },
  };
  const result = await releaseLease(interposed, f.operationId, fingerprint(f.token), f.keys);
  assert.equal(result.state, 'foreign');
  assert.equal(await redis.get(f.keys.leaseKey), f.token);
  assert.equal(await redis.get(f.receiptKey), conflicting);
});

test('concurrent operations release once and only the winning operation obtains proof', async () => {
  const f = fixture();
  const secondOperation = randomUUID();
  const secondReceipt = f.keys.receiptPrefix + secondOperation;
  ownedKeys.add(secondReceipt);
  await redis.set(f.keys.leaseKey, f.token);
  const results = await Promise.all([
    releaseLease(redis, f.operationId, fingerprint(f.token), f.keys),
    releaseLease(redis, secondOperation, fingerprint(f.token), f.keys),
  ]);
  assert.deepEqual(results.map((r) => r.state).sort(), ['missing', 'released_receipt']);
  assert.equal(await redis.exists(f.receiptKey, secondReceipt), 1);
});

for (const omittedCommand of ['set', 'del'])
  test(`missing ${omittedCommand.toUpperCase()} permission cannot create a false release receipt`, async () => {
    const f = fixture();
    const username = `cpu-lease-${randomUUID()}`;
    const password = 'isolated-fixture-password';
    const keyPattern = f.keys.leaseKey.slice(0, -'lease'.length) + '*';
    await redis.set(f.keys.leaseKey, f.token);
    await redis.acl(
      'SETUSER',
      username,
      'on',
      `>${password}`,
      `~${keyPattern}`,
      '+eval',
      '+type',
      '+strlen',
      '+pttl',
      '+get',
      omittedCommand === 'set' ? '+del' : '+set',
    );
    const restricted = redis.duplicate({
      username,
      password,
      lazyConnect: true,
      enableReadyCheck: false,
    });
    restricted.on('error', () => {});
    try {
      await restricted.connect();
      const result = await releaseLease(restricted, f.operationId, fingerprint(f.token), f.keys);
      assert.equal(result.state, 'invalid');
      assert.equal(result.reason, 'write_authority');
      assert.equal(await redis.get(f.keys.leaseKey), f.token);
      assert.equal(await redis.exists(f.receiptKey), 0);
    } finally {
      restricted.disconnect();
      await redis.acl('DELUSER', username);
    }
  });

test('CLI uses only the fixed CPU key, emits no token and refuses a missing release', async () => {
  const operationId = randomUUID();
  const receiptKey = CPU_RECOVERY_RECEIPT_PREFIX + operationId;
  const token = randomUUID();
  const foreignKey = `cpu-lease-test:${randomUUID()}:forbidden-override`;
  const env = {
    ...process.env,
    REDIS_URL: cliRedisUrl,
    CPU_LEASE_KEY: foreignKey,
    CPU_RECOVERY_RECEIPT_PREFIX: foreignKey,
  };
  ownedKeys.add(receiptKey);
  ownedKeys.add(foreignKey);
  assert.equal(await redis.set(CPU_LEASE_KEY, token, 'NX'), 'OK');
  ownedKeys.add(CPU_LEASE_KEY);
  await redis.set(foreignKey, 'untouched');
  const run = async (...args) => {
    const child = spawn(process.execPath, ['infra/scripts/commercial-llm-cpu-lease.cjs', ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    const [code] = await once(child, 'exit');
    clearTimeout(deadline);
    assert.equal(stderr, '');
    assert.equal(stdout.includes(token), false);
    return { code, value: JSON.parse(stdout) };
  };
  assert.equal((await run('observe', operationId)).value.state, 'held_persistent');
  const release = await run('release', operationId, fingerprint(token));
  assert.equal(release.code, 0);
  assert.equal(release.value.state, 'released_receipt');
  assert.equal(await redis.exists(CPU_LEASE_KEY), 0);
  assert.equal(await redis.get(foreignKey), 'untouched');
  assert.equal(await redis.pttl(receiptKey), -1);
  const missing = await run('release', randomUUID(), fingerprint(token));
  assert.equal(missing.code, 1);
  assert.equal(missing.value.state, 'missing');
});

test('piped node stdin CLI observes, releases and resumes without touching a new lease', async () => {
  const operationId = randomUUID();
  const receiptKey = CPU_RECOVERY_RECEIPT_PREFIX + operationId;
  const token = randomUUID();
  const nextToken = randomUUID();
  const source = await readFile(new URL('./commercial-llm-cpu-lease.cjs', import.meta.url), 'utf8');
  assert.equal(await redis.set(CPU_LEASE_KEY, token, 'NX'), 'OK');
  ownedKeys.add(CPU_LEASE_KEY);
  ownedKeys.add(receiptKey);
  const run = async (...args) => {
    const child = spawn(process.execPath, ['-', ...args], {
      env: { ...process.env, REDIS_URL: cliRedisUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdin.end(source);
    let code;
    try {
      [code] = await once(child, 'close');
    } finally {
      clearTimeout(deadline);
    }
    assert.equal(stderr, '');
    assert.equal(stdout.includes(token), false);
    assert.equal(stdout.includes(nextToken), false);
    assert.equal(code, 0);
    return JSON.parse(stdout);
  };
  const observed = await run('observe', operationId);
  assert.equal(observed.state, 'held_persistent');
  assert.equal(observed.fingerprint, fingerprint(token));
  const released = await run('release', operationId, observed.fingerprint);
  assert.equal(released.state, 'released_receipt');
  assert.equal(released.alreadyReleased, false);
  assert.equal(await redis.exists(CPU_LEASE_KEY), 0);
  assert.equal(await redis.pttl(receiptKey), -1);
  await redis.set(CPU_LEASE_KEY, nextToken);
  const resumed = await run('release', operationId, observed.fingerprint);
  assert.equal(resumed.state, 'released_receipt');
  assert.equal(resumed.alreadyReleased, true);
  assert.equal(await redis.get(CPU_LEASE_KEY), nextToken);
  await redis.del(CPU_LEASE_KEY);
});

test('requiring the helper from a different stdin program never activates its CLI', () => {
  const child = spawnSync(process.execPath, ['-', 'observe', randomUUID()], {
    input:
      "require('./infra/scripts/commercial-llm-cpu-lease.cjs'); process.stdout.write('import-only');",
    env: { ...process.env, REDIS_URL: 'redis://secret-value.invalid' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, 'import-only');
  assert.equal(child.stderr, '');
});

for (const kind of ['oversized', 'malformed', 'wrong_type'])
  test(`invalid ${kind} lease fails closed and preserves authority`, async () => {
    const f = fixture();
    if (kind === 'wrong_type') await redis.hset(f.keys.leaseKey, 'retained', 'value');
    else await redis.set(f.keys.leaseKey, kind === 'oversized' ? 'x'.repeat(4096) : 'x'.repeat(36));
    const before = await redis.dump(f.keys.leaseKey);
    assert.equal((await observeLease(redis, f.operationId, f.keys)).state, 'invalid');
    assert.equal(
      (await releaseLease(redis, f.operationId, fingerprint(f.token), f.keys)).state,
      'invalid',
    );
    assert.equal(await redis.dump(f.keys.leaseKey), before);
    assert.equal(await redis.exists(f.receiptKey), 0);
  });

for (const kind of ['oversized', 'malformed', 'wrong_type', 'expiring', 'wrong_operation'])
  test(`invalid or foreign ${kind} receipt prevents release`, async () => {
    const f = fixture();
    await redis.set(f.keys.leaseKey, f.token);
    if (kind === 'wrong_type') await redis.hset(f.receiptKey, 'retained', 'value');
    else if (kind === 'oversized') await redis.set(f.receiptKey, 'x'.repeat(4096));
    else if (kind === 'malformed') await redis.set(f.receiptKey, '{}');
    else if (kind === 'expiring')
      await redis.set(f.receiptKey, receipt(f.operationId, fingerprint(f.token)), 'PX', 60000);
    else await redis.set(f.receiptKey, receipt(randomUUID(), fingerprint(f.token)));
    const expected = kind === 'wrong_operation' ? 'foreign' : 'invalid';
    assert.equal((await observeLease(redis, f.operationId, f.keys)).state, expected);
    assert.equal(
      (await releaseLease(redis, f.operationId, fingerprint(f.token), f.keys)).state,
      expected,
    );
    assert.equal(await redis.get(f.keys.leaseKey), f.token);
  });

test('invalid argument boundaries perform no Redis access and CLI accepts no key override', async () => {
  const noRedis = {
    eval() {
      throw new Error('Redis must not be called');
    },
  };
  await assert.rejects(observeLease(noRedis, '../invalid'), /invalid_operation/u);
  await assert.rejects(releaseLease(noRedis, randomUUID(), 'not-a-sha'), /invalid_fingerprint/u);
  const child = spawnSync(
    process.execPath,
    ['infra/scripts/commercial-llm-cpu-lease.cjs', 'observe', randomUUID(), '--lease-key=foreign'],
    {
      encoding: 'utf8',
      env: { ...process.env, REDIS_URL: 'redis://secret-value.invalid' },
      timeout: 5000,
    },
  );
  assert.equal(child.status, 2);
  assert.deepEqual(JSON.parse(child.stdout), {
    schemaVersion: 1,
    state: 'invalid',
    reason: 'arguments',
  });
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.includes('secret-value'), false);
  assert.equal(CPU_LEASE_KEY, 'commercial-llm-shadow:v1:lease');
  assert.equal(CPU_RECOVERY_RECEIPT_PREFIX, 'commercial-llm-shadow:v1:cpu-recovery:receipt:');
});
