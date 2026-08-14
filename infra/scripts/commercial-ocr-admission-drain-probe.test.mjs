import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  ADMISSION_SCAN_LIMITS,
  READ_ADMISSION_METADATA_BOUNDS_SCRIPT,
  SCAN_ADMISSION_METADATA_PAGE_SCRIPT,
  collectDrainSummary,
  parseProbeTimeoutMs,
  scanAdmissionMetadata,
} = require('./commercial-ocr-admission-drain-probe.cjs');

const metadataKey = 'commercial-ocr:admission:v2:global:metadata';

test('accepts only a bounded remaining-time probe budget', () => {
  assert.equal(parseProbeTimeoutMs(undefined), ADMISSION_SCAN_LIMITS.timeoutMs);
  assert.equal(parseProbeTimeoutMs('250'), 250);
  assert.equal(parseProbeTimeoutMs('4500'), 4_500);
  for (const value of ['0', '249', '5001', '1.5', '-1', 'invalid']) {
    assert.throws(() => parseProbeTimeoutMs(value), /timeout is invalid/u);
  }
});

class FakeRedis {
  constructor({
    entries = 2,
    boundedEntries = entries,
    redisBytes = 512,
    pages = [
      ['19', 1, 120, 1, 0],
      ['0', 1, 121, 0, 1],
    ],
    finalRead,
    units = '0',
    events = [],
  } = {}) {
    this.entries = entries;
    this.boundedEntries = boundedEntries;
    this.redisBytes = redisBytes;
    this.pages = [...pages];
    this.finalRead = finalRead === undefined ? [[null, entries]] : finalRead;
    this.units = units;
    this.events = events;
    this.evalCalls = [];
    this.boundsEvalCalls = [];
    this.pageEvalCalls = [];
    this.multiCommands = [];
    this.unwatchCalls = 0;
  }

  async connect() {
    this.events.push('redis.connect');
  }

  async get() {
    this.events.push('redis.get');
    return this.units;
  }

  async watch(key) {
    assert.equal(key, metadataKey);
    this.events.push('redis.watch');
  }

  async hlen(key) {
    assert.equal(key, metadataKey);
    this.events.push('redis.hlen');
    return this.entries;
  }

  async eval(...args) {
    this.evalCalls.push(args);
    if (args[0] === READ_ADMISSION_METADATA_BOUNDS_SCRIPT) {
      this.boundsEvalCalls.push(args);
      return this.boundedEntries > ADMISSION_SCAN_LIMITS.maxEntries
        ? [1, this.boundedEntries, 0]
        : [0, this.boundedEntries, this.redisBytes];
    }
    this.pageEvalCalls.push(args);
    const page = this.pages.shift();
    assert.ok(page, 'unexpected extra scan page');
    return page;
  }

  multi(commands) {
    this.multiCommands.push(commands);
    return { exec: async () => this.finalRead };
  }

  async unwatch() {
    this.unwatchCalls += 1;
  }
}

test('bounded scan aggregates scalar pages without returning fields or metadata', async () => {
  const redis = new FakeRedis();

  await assert.doesNotReject(async () => {
    assert.deepEqual(await scanAdmissionMetadata(redis), { held: 1, malformed: 1 });
  });
  assert.equal(redis.boundsEvalCalls.length, 1);
  assert.equal(redis.pageEvalCalls.length, 2);
  assert.deepEqual(
    redis.pageEvalCalls.map((call) => call.slice(1)),
    [
      [1, metadataKey, '0', '128'],
      [1, metadataKey, '19', '128'],
    ],
  );
  assert.deepEqual(redis.multiCommands, [[['hlen', metadataKey]]]);
  assert.match(SCAN_ADMISSION_METADATA_PAGE_SCRIPT, /return \{page\[1\], entries/u);
  assert.doesNotMatch(SCAN_ADMISSION_METADATA_PAGE_SCRIPT, /return \{page\[1\], values/u);
});

test('drain summary waits for both clients and preserves scalar drain fields', async () => {
  const events = [];
  const redis = new FakeRedis({ entries: 0, pages: [['0', 0, 0, 0, 0]], events });
  const queue = {
    waitUntilReady: async () => events.push('queue.waitUntilReady'),
    getJobCounts: async (...states) => {
      events.push('queue.getJobCounts');
      assert.deepEqual(states, ['waiting', 'active']);
      return { waiting: 0, active: 0 };
    },
  };

  assert.deepEqual(await collectDrainSummary(queue, redis, ['waiting', 'active']), {
    counts: { waiting: 0, active: 0 },
    units: 0,
    held: 0,
    malformed: 0,
  });
  assert.ok(events.indexOf('queue.waitUntilReady') < events.indexOf('queue.getJobCounts'));
  assert.ok(events.indexOf('redis.connect') < events.indexOf('redis.get'));
});

test('bounded scan rejects entry and Redis byte caps before HSCAN', async () => {
  const oversizedEntries = new FakeRedis({
    entries: ADMISSION_SCAN_LIMITS.maxEntries + 1,
    pages: [],
  });
  await assert.rejects(
    scanAdmissionMetadata(oversizedEntries),
    /Admission metadata exceeds bounded scan limits/u,
  );
  assert.equal(oversizedEntries.evalCalls.length, 0);
  assert.equal(oversizedEntries.unwatchCalls, 1);

  for (const redis of [
    new FakeRedis({
      entries: 1,
      boundedEntries: ADMISSION_SCAN_LIMITS.maxEntries + 1,
      pages: [],
    }),
    new FakeRedis({ redisBytes: ADMISSION_SCAN_LIMITS.maxRedisBytes + 1, pages: [] }),
  ]) {
    await assert.rejects(
      scanAdmissionMetadata(redis),
      /Admission metadata exceeds bounded scan limits/u,
    );
    assert.equal(redis.boundsEvalCalls.length, 1);
    assert.equal(redis.pageEvalCalls.length, 0);
    assert.equal(redis.unwatchCalls, 1);
  }
});

test('bounded scan rejects logical byte overflow, incomplete scans, and concurrent mutation', async () => {
  const cases = [
    new FakeRedis({
      entries: 1,
      pages: [['0', 1, ADMISSION_SCAN_LIMITS.maxLogicalBytes + 1, 0, 0]],
    }),
    new FakeRedis({ entries: 2, pages: [['0', 1, 100, 0, 0]] }),
    new FakeRedis({ entries: 1, pages: [['0', 1, 100, 0, 0]], finalRead: null }),
  ];

  await assert.rejects(scanAdmissionMetadata(cases[0]), /exceeds bounded scan limits/u);
  await assert.rejects(scanAdmissionMetadata(cases[1]), /bounded scan was incomplete/u);
  await assert.rejects(scanAdmissionMetadata(cases[2]), /changed during bounded scan/u);
});

test('bounded scan enforces page and wall-clock limits', async () => {
  const pageLimited = new FakeRedis({ entries: 1, pages: [['4', 0, 0, 0, 0]] });
  await assert.rejects(
    scanAdmissionMetadata(pageLimited, {
      limits: { ...ADMISSION_SCAN_LIMITS, maxPages: 1 },
    }),
    /bounded scan did not complete/u,
  );

  const timed = new FakeRedis({ entries: 0, pages: [] });
  const ticks = [0, ADMISSION_SCAN_LIMITS.timeoutMs + 1];
  await assert.rejects(
    scanAdmissionMetadata(timed, { now: () => ticks.shift() ?? ticks.at(-1) }),
    /bounded scan did not complete/u,
  );
  assert.equal(timed.pageEvalCalls.length, 0);

  const postPageTimed = new FakeRedis({ entries: 1, pages: [['0', 1, 100, 0, 0]] });
  const postPageTicks = [0, 0, ADMISSION_SCAN_LIMITS.timeoutMs + 1];
  await assert.rejects(
    scanAdmissionMetadata(postPageTimed, {
      now: () => postPageTicks.shift() ?? ADMISSION_SCAN_LIMITS.timeoutMs + 1,
    }),
    /bounded scan did not complete/u,
  );
  assert.equal(postPageTimed.pageEvalCalls.length, 1);
  assert.equal(postPageTimed.multiCommands.length, 0);
});
