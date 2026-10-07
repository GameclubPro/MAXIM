import assert from 'node:assert/strict';
import { before, after, beforeEach, describe, test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  cleanupLegacyVkPublishQueue,
  ORPHAN_READ_LUA,
  ORPHAN_DELETE_LUA,
  readMeasuredOrphanScript,
  collectLegacyVkPublishOrphans,
} = require('./legacy-vk-publish-queue-cleanup.cjs');
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim();
const binding = {
  sourceSha: 'a'.repeat(40),
  imageId: `sha256:${'b'.repeat(64)}`,
  fleetDigest: 'c'.repeat(64),
};
const prefix = 'bull:vk-parsing-publish:';

describe('native Redis exact retired VK orphan proof and byte CAS', { skip: !redisUrl }, () => {
  let queue;
  let redis;
  let ownsDatabase = false;
  before(async () => {
    const target = new URL(redisUrl);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
    target.pathname = '/13';
    const { Queue } = require('bullmq');
    queue = new Queue('vk-parsing-publish', {
      skipMetasUpdate: true,
      connection: {
        url: target.toString(),
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        retryStrategy: null,
        maxRetriesPerRequest: 1,
      },
    });
    await queue.waitUntilReady();
    redis = await queue.client;
    assert.match(await redis.info('server'), /^redis_version:7\./mu);
    assert.equal(await redis.dbsize(), 0, 'Requires an empty disposable Redis DB 13');
    ownsDatabase = true;
  });
  beforeEach(async () => {
    assert.equal(ownsDatabase, true);
    await redis.flushdb();
  });
  after(async () => {
    if (ownsDatabase) await redis.flushdb();
    await queue?.close();
  });

  async function seed(index = 1, widest = false) {
    const postId = widest
      ? `${'p'.repeat(510)}${String(index).padStart(2, '0')}`
      : `fixture-post-${index}`;
    const idempotencyKey = widest
      ? 'i'.repeat(1024 - prefix.length - 'vk-parsing-publish__'.length - 2 - postId.length)
      : `fixture-key-${index}`;
    const jobId = `vk-parsing-publish__${postId}__${idempotencyKey}`;
    const fields = {
      data: JSON.stringify({
        postId,
        chatId: widest ? `-${'c'.repeat(127)}` : '-fixture-chat',
        reason: widest ? 'manual-schedule' : 'autopublish',
        idempotencyKey,
        retryPolicyName: 'vk-parsing-publish',
        createdAt: '2026-08-01T12:00:00.000Z',
      }),
      delay: '0',
      name: 'publish-vk-post',
      opts: JSON.stringify({
        attempts: 5,
        delay: 0,
        jobId,
        removeOnComplete: true,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnFail: 1000,
      }),
      priority: '0',
      timestamp: '1785585600000',
    };
    const key = `${prefix}${jobId}`;
    await redis.hset(key, fields);
    return { key, fields };
  }
  const preview = (handle = queue) => cleanupLegacyVkPublishQueue(handle, { binding });
  const apply = (reviewedDigest, handle = queue, extra = {}) =>
    cleanupLegacyVkPublishQueue(handle, { apply: true, binding, reviewedDigest, ...extra });
  function intercept({ read, write } = {}) {
    const client = {
      multi() {
        const transaction = redis.multi();
        let readArgs;
        const originalRead = transaction.eval_ro.bind(transaction);
        transaction.eval_ro = (...args) => {
          readArgs = args;
          return originalRead(...args);
        };
        const execute = transaction.exec.bind(transaction);
        transaction.exec = async () => {
          let result;
          const run = async () => {
            result = await execute();
            return result[1][1];
          };
          const reply = read ? await read(readArgs, run) : await run();
          result[1][1] = reply;
          return result;
        };
        return transaction;
      },
      eval: async (...args) =>
        write ? write(args, () => redis.eval(...args)) : redis.eval(...args),
    };
    return new Proxy(queue, {
      get(target, property) {
        if (property === 'client') return Promise.resolve(client);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  test('atomic read cost uses commandstats even when Lua TIME is frozen and preserves data', async () => {
    const row = await seed();
    const script =
      "local a=redis.call('TIME'); local n=0; for i=1,1000000 do n=n+i end; local b=redis.call('TIME'); return {(b[1]-a[1])*1000000+b[2]-a[2],n}";
    const measured = await readMeasuredOrphanScript(redis, script, 0);
    assert.ok(measured.serverDurationUs > 0);
    assert.ok(measured.serverDurationUs <= 50_000);
    const version = (await redis.info('server')).match(/^redis_version:7\.(\d+)/mu);
    if (Number(version[1]) >= 2) assert.equal(measured.reply[0], 0);
    assert.deepEqual(await redis.hgetall(row.key), row.fields);
    assert.equal(await redis.dbsize(), 1);
  });

  test('paired SCAN stops on the first zero cursor without restarting the empty database', async () => {
    const result = await collectLegacyVkPublishOrphans({ client: redis });
    assert.deepEqual(
      { ...result.cost, measurementBytes: 0 },
      {
        pages: 1,
        workHints: 4096,
        keys: 0,
        keyBytes: 0,
        hashBytes: 0,
        measurementBytes: 0,
        calls: 1,
      },
    );
    assert.equal(await redis.dbsize(), 0);
  });

  test('maximum-width keys in a full 32-job batch retain exact CAS and outside data', async () => {
    const rows = [];
    for (let i = 0; i < 32; i++) rows.push(await seed(i, true));
    assert.ok(rows.every((row) => Buffer.byteLength(row.key) === 1024));
    await redis.set('unrelated:preserved', 'outside-bytes');
    const result = await preview();
    assert.equal(result.orphanCount, 32);
    for (const row of rows) assert.deepEqual(await redis.hgetall(row.key), row.fields);
    assert.equal((await apply(result.previewDigest)).removed, 32);
    assert.equal(await redis.get('unrelated:preserved'), 'outside-bytes');
    assert.equal(await redis.dbsize(), 1);
  });

  test('preview finds orphan hashes beyond absent BullMQ state and removes only reviewed fixed keys', async () => {
    const rows = await Promise.all([seed(1), seed(2)]);
    await redis.set('bull:vk-parsing-publisher:unrelated', 'current-publisher');
    await redis.set('bull:vk-parsing-sync:unrelated', 'current-sync');
    const result = await preview();
    assert.equal(result.before.present, false);
    assert.equal(result.result, 'would_remove_never_started_orphans');
    assert.equal(result.orphanCount, 2);
    assert.equal(result.namespaceComplete, true);
    assert.doesNotMatch(
      JSON.stringify(result),
      /fixture-post|fixture-key|fixture-chat|publish-vk-post|"data"|"opts"/u,
    );
    for (const row of rows) assert.deepEqual(await redis.hgetall(row.key), row.fields);
    const complete = await apply(result.previewDigest);
    assert.equal(complete.result, 'never_started_orphans_removed');
    assert.equal(complete.removed, 2);
    assert.equal(complete.after.orphanCount, 0);
    assert.equal(await redis.get('bull:vk-parsing-publisher:unrelated'), 'current-publisher');
    assert.equal(await redis.get('bull:vk-parsing-sync:unrelated'), 'current-sync');
    assert.equal((await preview()).result, 'already_absent');
  });

  for (const field of [
    'processedOn',
    'finishedOn',
    'atm',
    'ats',
    'attemptsMade',
    'failedReason',
    'returnvalue',
    'parent',
    'repeatJobKey',
    'unknown',
  ]) {
    test(`preserves and refuses hash carrying ${field}`, async () => {
      const row = await seed();
      await redis.hset(row.key, field, 'historical-evidence');
      await assert.rejects(preview(), /namespace_shape_unproved/u);
      assert.equal(await redis.hget(row.key, field), 'historical-evidence');
    });
  }
  for (const suffix of [
    ':lock',
    ':logs',
    ':dependencies',
    ':processed',
    ':failed',
    ':unsuccessful',
    ':waiting-children',
    ':repeat',
    ':parent',
  ]) {
    test(`preserves and refuses related ${suffix} evidence`, async () => {
      const row = await seed();
      await redis.set(`${row.key}${suffix}`, 'historical-evidence');
      await assert.rejects(preview(), /namespace_shape_unproved/u);
      assert.equal(await redis.exists(row.key), 1);
      assert.equal(await redis.get(`${row.key}${suffix}`), 'historical-evidence');
    });
  }
  test('rejects a foreign producer, expiration and extra payload fields', async () => {
    const row = await seed();
    for (const fields of [
      { name: 'other-producer' },
      { data: JSON.stringify({ ...JSON.parse(row.fields.data), kind: 'rollback-delete' }) },
      { opts: JSON.stringify({ ...JSON.parse(row.fields.opts), repeat: { every: 1000 } }) },
      {
        opts: JSON.stringify({
          ...JSON.parse(row.fields.opts),
          backoff: { type: 'custom', delay: 5000 },
        }),
      },
    ]) {
      await redis.hset(row.key, { ...row.fields, ...fields });
      await assert.rejects(preview(), /namespace_shape_unproved/u);
      assert.equal(await redis.exists(row.key), 1);
    }
    await redis.hset(row.key, row.fields);
    await redis.pexpire(row.key, 60_000);
    await assert.rejects(preview(), /namespace_shape_unproved/u);
  });
  test('requires the exact reviewed digest and runtime generation before any write', async () => {
    const row = await seed();
    const result = await preview();
    await assert.rejects(apply(undefined), /reviewed_orphan_digest_required/u);
    await assert.rejects(apply('d'.repeat(64)), /reviewed_orphan_digest_required/u);
    await assert.rejects(
      apply(result.previewDigest, queue, { binding: { ...binding, fleetDigest: 'd'.repeat(64) } }),
      /reviewed_orphan_digest_required/u,
    );
    assert.deepEqual(await redis.hgetall(row.key), row.fields);
  });
  test('rejects duplicate JSON keys and invalid calendar text despite a parseable Lua shape', async () => {
    const row = await seed();
    assert.equal(row.fields.data[0], '{');
    for (const data of [
      `{"postId":"hidden-first-value",${row.fields.data.slice(1)}`,
      JSON.stringify({ ...JSON.parse(row.fields.data), createdAt: '2026-99-01T12:00:00.000Z' }),
    ]) {
      await redis.hset(row.key, 'data', data);
      await assert.rejects(preview(), /producer_encoding_unproved/u);
      assert.equal(await redis.hget(row.key, 'data'), data);
    }
  });
  for (const state of ['wait', 'active', 'completed', 'failed']) {
    test(`reviewed orphan apply refuses new ${state} state without ordinary obliteration fallback`, async () => {
      const row = await seed();
      const result = await preview();
      if (state === 'wait' || state === 'active')
        await redis.rpush(`${prefix}${state}`, 'unrelated-job');
      else await redis.zadd(`${prefix}${state}`, 1, 'unrelated-job');
      await assert.rejects(apply(result.previewDigest), /orphan_queue_became_active/u);
      assert.equal(await redis.exists(`${prefix}meta`), 0);
      assert.deepEqual(await redis.hgetall(row.key), row.fields);
      assert.equal(await redis.exists(`${prefix}${state}`), 1);
    });
  }
  test('refuses changed content between complete proof passes before mutation', async () => {
    const row = await seed();
    const result = await preview();
    let reads = 0;
    let writes = 0;
    const handle = intercept({
      read: async (args, run) => {
        const value = await run();
        if (args[0] === ORPHAN_READ_LUA && ++reads === 1)
          await redis.hset(
            row.key,
            'data',
            JSON.stringify({ ...JSON.parse(row.fields.data), reason: 'manual-retry' }),
          );
        return value;
      },
      write: async () => {
        writes += 1;
        throw new Error('unexpected_write');
      },
    });
    await assert.rejects(apply(result.previewDigest, handle), /orphan_inventory_changed/u);
    assert.equal(writes, 0);
    assert.equal(await redis.exists(row.key), 1);
  });
  test('byte CAS preserves a hash changed after both full proof passes', async () => {
    const row = await seed();
    const result = await preview();
    const handle = intercept({
      write: async (args, run) => {
        assert.equal(args[0], ORPHAN_DELETE_LUA);
        await redis.hset(
          row.key,
          'data',
          JSON.stringify({ ...JSON.parse(row.fields.data), reason: 'manual-retry' }),
        );
        return run();
      },
    });
    await assert.rejects(
      apply(result.previewDigest, handle),
      /orphan_apply_requires_fresh_preview/u,
    );
    assert.equal(await redis.exists(row.key), 1);
  });
  test('a newly connected legacy worker refuses the reviewed apply without mutation', async () => {
    const row = await seed();
    const result = await preview();
    const workerClient = redis.duplicate();
    try {
      await new Promise((resolve, reject) => {
        workerClient.once('ready', resolve);
        workerClient.once('error', reject);
      });
      await workerClient.client('SETNAME', queue.clientName());
      await assert.rejects(apply(result.previewDigest), /orphan_queue_became_active/u);
      assert.deepEqual(await redis.hgetall(row.key), row.fields);
    } finally {
      workerClient.disconnect();
    }
  });
  test('a late lock refuses atomic deletion and an elapsed host deadline denies all writes', async () => {
    const row = await seed();
    const result = await preview();
    await assert.rejects(
      apply(result.previewDigest, queue, { deadlineMs: Date.now() - 1 }),
      /orphan_apply_deadline_required/u,
    );
    const handle = intercept({
      write: async (_args, run) => {
        await redis.set(`${row.key}:lock`, 'new-worker-lock');
        return run();
      },
    });
    await assert.rejects(
      apply(result.previewDigest, handle),
      /orphan_apply_requires_fresh_preview/u,
    );
    assert.deepEqual(await redis.hgetall(row.key), row.fields);
    assert.equal(await redis.get(`${row.key}:lock`), 'new-worker-lock');
  });
  test('late independent orphan is left intact and invalidates the final absence result', async () => {
    await seed(1);
    const result = await preview();
    let late;
    const handle = intercept({
      write: async (_args, run) => {
        const value = await run();
        late = await seed(2);
        return value;
      },
    });
    await assert.rejects(
      apply(result.previewDigest, handle),
      /orphan_apply_requires_fresh_preview/u,
    );
    assert.deepEqual(await redis.hgetall(late.key), late.fields);
  });
  test('unknown write acknowledgement never resends or starts a second deletion batch', async () => {
    for (let i = 0; i < 33; i += 1) await seed(i);
    const result = await preview();
    let writes = 0;
    const handle = intercept({
      write: async (_args, run) => {
        writes += 1;
        await run();
        throw new Error('simulated_socket_closed_after_redis_applied');
      },
    });
    await assert.rejects(
      apply(result.previewDigest, handle),
      (error) =>
        error.code === 'orphan_apply_requires_fresh_preview' &&
        error.snapshot.confirmedRemoved === 0 &&
        error.snapshot.outcomeMayBePartial === true,
    );
    assert.equal(writes, 1);
    assert.equal((await preview()).orphanCount, 1);
  });
});
