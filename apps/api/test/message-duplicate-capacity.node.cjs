'use strict';

// Local acceptance fixture only: never use a production Redis or MAX destination.
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { ConfigService } = require('@nestjs/config');
const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const sharp = require('sharp');
const runtime = path.resolve(__dirname, '../dist/apps/api/src');
const load = (name) => require(path.join(runtime, name));
const { MessageDuplicateProcessor } = load(
  'moderation/message-duplicate/message-duplicate.processor',
);
const { MessageDuplicateEnqueueService, MessageDuplicateOrderingStore } = load(
  'moderation/message-duplicate/message-duplicate.queue',
);
const { MessageDuplicateHistoryService } = load(
  'moderation/message-duplicate/message-duplicate-history.service',
);
const { extractDuplicateMessageContent } = load(
  'moderation/message-duplicate/message-duplicate-content',
);
const { RedisCounterService } = load('moderation/redis-counter.service');
const { PhotoDuplicateAnalysisService } = load(
  'moderation/photo-duplicate/photo-duplicate-analysis.service',
);
const { PhotoDuplicateHistoryStore } = load(
  'moderation/photo-duplicate/photo-duplicate-history.store',
);
const { SecurePhotoDownloader } = load('moderation/photo-duplicate/secure-photo-downloader');
const { PhotoFingerprintService } = load('moderation/photo-duplicate/photo-fingerprint');
const { NativePhotoSandboxClient } = load('moderation/photo-duplicate/native-photo-sandbox.client');
const { chatSettingsSchema } = require('@maxim/contracts');

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
assert.match(url, /^redis:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/0$/u);
assert.equal(process.env.REDIS_URL, url, 'Run through the disposable test-stores wrapper');
const settings = {
  ...chatSettingsSchema.parse({}),
  antiDuplicateEnabled: true,
  duplicateDetectionPreset: 'STANDARD',
  duplicatePolicyRevision: 0,
  duplicateHistoryRevision: 0,
  duplicateCompareMode: 'MESSAGE',
};
const report = {
  schemaVersion: 1,
  node: process.version,
  clockTicksPerSecond: Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()),
  source: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(__dirname, '../../..'),
    encoding: 'utf8',
  }).trim(),
  scope: 'LOCAL_BOUNDED_ACCEPTANCE',
  networkSource: 'controlled transport; no MAX',
  nativeBoundary: 'actual network namespace, UDS and child worker; no cgroup limit',
  missing: [
    'production throughput',
    'production fairness',
    'OCR overlap',
    'SQL cleanup rate',
    'cgroup CPU/RSS',
  ],
  scenarios: [],
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function within(promise, ms = 45000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Capacity fixture deadline exceeded')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] * 100) /
    100
  );
}
function fields(info) {
  return Object.fromEntries(
    info
      .split(/\r?\n/u)
      .filter((line) => /^[a-z_]+:/u.test(line))
      .map((line) => line.split(':')),
  );
}
function processStats(pid) {
  try {
    const stat = fs
      .readFileSync(`/proc/${pid}/stat`, 'utf8')
      .replace(/^.*\) /u, '')
      .split(' ');
    return {
      ticks: [11, 12, 13, 14].reduce((sum, i) => sum + Number(stat[i]), 0),
      rss:
        Number(/VmRSS:\s+(\d+)/u.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) *
        1024,
    };
  } catch {
    return { ticks: 0, rss: 0 };
  }
}
function treeRss(pid) {
  let bytes = processStats(pid).rss;
  try {
    for (const child of fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .trim()
      .split(/\s+/u)
      .filter(Boolean))
      bytes += treeRss(Number(child));
  } catch {
    /* Child can exit between samples. */
  }
  return bytes;
}
async function keys(redis) {
  const result = new Set();
  let cursor = '0';
  let pages = 0;
  do {
    const page = await redis.scan(cursor, 'COUNT', 256);
    cursor = page[0];
    page[1].forEach((key) => result.add(key));
    assert.ok(result.size <= 4096 && ++pages <= 100, 'Bounded fixture exceeded its key budget');
  } while (cursor !== '0');
  return [...result];
}
class FixtureDownloader extends SecurePhotoDownloader {
  constructor(config, bytes) {
    super(config);
    this.bytes = bytes;
    this.calls = 0;
    this.deliveredBytes = 0;
    this.failOnce = new Set();
  }
  async resolveHost() {
    return [{ address: '93.184.216.34', family: 4 }];
  }
  async request(source, _address, _timeout, signal) {
    this.calls += 1;
    if (this.failOnce.delete(source.pathname))
      return { statusCode: 503, headers: {}, body: (async function* () {})(), close() {} };
    const deliver = (count) => {
      this.deliveredBytes += count;
    };
    const { block, bytes } = this;
    return {
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      close() {},
      body: (async function* () {
        if (block && source.pathname.includes('/slow/')) {
          block.entered.resolve();
          await Promise.race([
            block.release.promise,
            new Promise((_, reject) => {
              if (signal?.aborted) reject(new Error('Fixture source aborted'));
              else
                signal?.addEventListener(
                  'abort',
                  () => reject(new Error('Fixture source aborted')),
                  { once: true },
                );
            }),
          ]);
        }
        deliver(bytes.length);
        yield bytes;
      })(),
    };
  }
}
async function main() {
  const redis = new Redis(url);
  // No FLUSHDB: refusal plus exact-key cleanup keeps mistakes visible.
  try {
    assert.equal(await redis.dbsize(), 0, 'Fixture requires a new empty disposable Redis');
  } catch (error) {
    await redis.quit();
    throw error;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'maxim-duplicate-capacity-'));
  const socket = path.join(directory, 'native.sock');
  const launcher = path.join(directory, 'sandbox.cjs');
  await writeFile(
    launcher,
    `const {startNativePhotoSandbox}=require(${JSON.stringify(path.join(runtime, 'moderation/photo-duplicate/native-photo-sandbox.server.js'))});\nstartNativePhotoSandbox({PHOTO_NATIVE_SANDBOX_SOCKET_PATH:${JSON.stringify(socket)}},{allowTestSocketPath:true}).then(server=>{console.log('READY');process.once('SIGTERM',()=>server.close().then(()=>process.exit(0)));}).catch(()=>process.exit(1));\n`,
  );
  const child = spawn('unshare', ['-Urn', process.execPath, launcher], {
    env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const config = new ConfigService({ REDIS_URL: url });
  const ordering = new MessageDuplicateOrderingStore(config);
  const counters = new RedisCounterService(config);
  const history = new MessageDuplicateHistoryService(counters);
  const photoStore = new PhotoDuplicateHistoryStore(config);
  let sampleTimer;
  try {
    await within(
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error('No-network sandbox failed')));
        child.stdout.on('data', (chunk) => {
          if (chunk.toString().includes('READY')) resolve();
        });
      }),
      5000,
    );
    const client = new NativePhotoSandboxClient(socket);
    await client.smoke();
    const raster = Buffer.alloc(512 * 384 * 4);
    for (let i = 0; i < raster.length; i += 1)
      raster[i] = (i * 13 + Math.floor(i / 4096) * 7) % 256;
    const bytes = await sharp(raster, { raw: { width: 512, height: 384, channels: 4 } })
      .png()
      .toBuffer();
    report.fixture = {
      width: 512,
      height: 384,
      encodedBytes: bytes.length,
      messagesPerScenario: 16,
      workerConcurrency: 2,
      nativeConcurrency: 1,
      arrival: 'pre-admitted finite burst; equal total jobs/photos per distribution',
    };
    const downloader = new FixtureDownloader(config, bytes);
    const fingerprint = new PhotoFingerprintService({ canonicalOnly: true, nativeDecoder: client });
    const analysis = new PhotoDuplicateAnalysisService(downloader, fingerprint, photoStore);
    const makeAlbum = (messageId, chatId, count, at, slow = false) => ({
      receiptId: `receipt-${messageId}`,
      chatId,
      messageId,
      senderId: '123',
      createdAtMs: at,
      caption: '',
      images: Array.from({ length: count }, (_, i) => ({
        source: 'direct',
        photoId: `image-${i}`,
        downloadUrl: `https://i.oneme.ru/${slow ? 'slow/' : ''}${messageId}/${i}`,
      })),
    });
    async function measure(name, operation) {
      const beforeKeys = new Set(await keys(redis));
      const beforeRedis = fields(await redis.info('stats'));
      const beforeCpu = process.cpuUsage();
      const beforeNative = processStats(child.pid).ticks;
      let peak = treeRss(child.pid);
      let apiPeak = process.memoryUsage().rss;
      sampleTimer = setInterval(() => {
        peak = Math.max(peak, treeRss(child.pid));
        apiPeak = Math.max(apiPeak, process.memoryUsage().rss);
      }, 20);
      const started = performance.now();
      try {
        const result = await operation();
        const wallMs = performance.now() - started;
        const apiCpu = process.cpuUsage(beforeCpu);
        const afterRedis = fields(await redis.info('stats'));
        const owned = (await keys(redis)).filter((key) => !beforeKeys.has(key));
        const ttl = owned.length ? await Promise.all(owned.map((key) => redis.pttl(key))) : [];
        const memory = owned.length
          ? await Promise.all(owned.map((key) => redis.memory('USAGE', key)))
          : [];
        const row = {
          name,
          ...result,
          wallMs: Math.round(wallMs),
          apiCpuMs: Math.round((apiCpu.user + apiCpu.system) / 1000),
          nativeCpuTicks: processStats(child.pid).ticks - beforeNative,
          sampledNativeTreePeakRss: peak,
          sampledApiPeakRss: apiPeak,
          redisCommandsIncludingQueueAndInspector:
            Number(afterRedis.total_commands_processed) -
            Number(beforeRedis.total_commands_processed),
          ownedKeys: owned.length,
          ownedRedisBytes: memory.reduce((a, b) => a + Number(b), 0),
          keysWithoutExpiry: ttl.filter((value) => value === -1).length,
        };
        assert.equal(row.keysWithoutExpiry, 0, 'Application fixture keys must expire');
        report.scenarios.push(row);
        if (owned.length) await redis.del(...owned);
        return row;
      } finally {
        clearInterval(sampleTimer);
      }
    }
    async function runQueue(distribution, imageScope, count, block = false) {
      const queueName = `duplicate-capacity-${randomUUID()}`;
      const queue = new Queue(queueName, { connection: { url } });
      const complete = deferred();
      const quiet = deferred();
      const observed = [];
      const latencies = [];
      const quietLatencies = [];
      const admitted = new Map();
      const enqueue = new MessageDuplicateEnqueueService(queue, ordering, {
        register: async ({ jobId }) => {
          if (admitted.has(jobId))
            return { registration: 'retry', admittedAtMs: admitted.get(jobId) };
          const admittedAtMs = Date.now();
          admitted.set(jobId, admittedAtMs);
          return { registration: 'initial', admittedAtMs };
        },
      });
      const started = performance.now();
      const callsBefore = downloader.calls;
      const bytesBefore = downloader.deliveredBytes;
      const execution = {
        processMessageDuplicateJob: async (job) => {
          const index = Number(job.messageId.split('-').at(-1));
          const album = makeAlbum(
            job.messageId,
            job.chatId,
            count,
            job.eventTimestampMs,
            block && index === 0,
          );
          const result = await analysis.fingerprintAlbum(album, 3600, job.deadlineAtMs);
          assert.equal(result.kind, 'complete');
          const content = extractDuplicateMessageContent({
            message: {
              body: {
                text: '',
                attachments: album.images.map((img) => ({
                  type: 'image',
                  payload: { photo_id: img.photoId, url: img.downloadUrl },
                })),
              },
            },
          });
          assert.equal(content.complete, true);
          const outcome = await history.observeWithOutcome({
            chatId: job.chatId,
            userId: index % 2 ? '456' : '123',
            messageId: job.messageId,
            eventTimestampMs: job.eventTimestampMs,
            controlRevision: 1,
            settings,
            content,
            imageScope,
            mediaHashes: result.fingerprint.images.map((img) => img.canonicalHash),
          });
          assert.ok(['MATCHED', 'COMPARED_NO_MATCH'].includes(outcome.outcome));
          observed.push(index);
          latencies.push(performance.now() - started);
          if (distribution === 'skew' && index >= 12) {
            quietLatencies.push(performance.now() - started);
            if (quietLatencies.length === 4) quiet.resolve();
          }
        },
      };
      const processor = new MessageDuplicateProcessor(execution, ordering, undefined, queue);
      const worker = new Worker(queueName, (job, token) => processor.process(job, token), {
        connection: { url },
        concurrency: 2,
        autorun: false,
      });
      let completed = 0;
      const failures = [];
      worker.on('completed', () => {
        if (++completed === 16) complete.resolve();
      });
      worker.on('failed', (_job, error) => failures.push(error.message));
      worker.on('error', (error) => failures.push(error.message));
      if (block) downloader.block = { entered: deferred(), release: deferred() };
      try {
        const at = Date.now() - 1000;
        for (let i = 0; i < 16; i += 1)
          await enqueue.enqueue({
            webhookEventId: `receipt-${queueName}-${i}`,
            chatId:
              distribution === 'skew' ? (i < 12 ? '-910001' : '-910002') : `-${920001 + (i % 4)}`,
            messageId: `${queueName}-${i}`,
            eventTimestampMs: at + i,
            sourceCreatedAt: new Date(at + i).toISOString(),
            controlRevision: 1,
            policyRevision: 0,
            settingsDigest: 'a'.repeat(64),
            actionEligible: false,
            comparison: 'IMAGE',
          });
        // Five-second initial settlement delay is excluded equally from both distributions.
        for (const job of await queue.getJobs(['delayed'])) await job.changeDelay(0);
        const running = worker.run();
        if (block) {
          await within(downloader.block.entered.promise, 5000);
          await within(quiet.promise, 4000);
          assert.deepEqual(
            [...observed].sort((a, b) => a - b),
            [12, 13, 14, 15],
          );
          downloader.block.release.resolve();
        }
        await within(complete.promise);
        await worker.close();
        await running;
        assert.deepEqual(failures, []);
        assert.equal(new Set(observed).size, 16);
        assert.equal(downloader.calls - callsBefore, 16 * count);
        if (distribution === 'skew')
          assert.ok(
            observed.indexOf(15) < observed.indexOf(11),
            'Calm chat must finish before the hot chat drains',
          );
        assert.deepEqual(await queue.getJobCounts('active', 'waiting', 'delayed', 'failed'), {
          active: 0,
          waiting: 0,
          delayed: 0,
          failed: 0,
          paused: 0,
        });
        return {
          distribution,
          imageScope,
          photoCount: count,
          completed,
          sourceCalls: downloader.calls - callsBefore,
          sourceBytes: downloader.deliveredBytes - bytesBefore,
          completionP50Ms: percentile(latencies, 0.5),
          completionP95Ms: percentile(latencies, 0.95),
          quietP95Ms: quietLatencies.length ? percentile(quietLatencies, 0.95) : null,
          quietBeforeSlowHeadReleased: block,
        };
      } finally {
        downloader.block?.release.resolve();
        downloader.block = undefined;
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    }
    for (const count of [1, 10])
      for (const scope of ['SAME_AUTHOR', 'CHAT'])
        for (const distribution of ['uniform', 'skew'])
          await measure(`${distribution}-${scope}-${count}`, () =>
            runQueue(distribution, scope, count),
          );
    await measure('slow-hot-source-quiet-progress', () => runQueue('skew', 'CHAT', 1, true));
    await measure('partial-album-retry-and-100-replays', async () => {
      const album = makeAlbum(`replay-${randomUUID()}`, '-930001', 10, Date.now());
      const callsBefore = downloader.calls;
      downloader.failOnce.add(new URL(album.images[9].downloadUrl).pathname);
      await assert.rejects(analysis.fingerprintAlbum(album, 3600), /503/u);
      const partialCount = (await keys(redis)).length;
      const expected = await analysis.fingerprintAlbum(album, 3600);
      assert.equal(expected.kind, 'complete');
      const baseline = (await keys(redis)).length;
      for (let i = 0; i < 100; i += 1)
        assert.deepEqual(await analysis.fingerprintAlbum(album, 3600), expected);
      assert.equal((await keys(redis)).length, baseline);
      assert.equal(downloader.calls - callsBefore, 11);
      assert.equal(partialCount, 9);
      assert.equal(baseline, 10);
      return {
        attempts: 102,
        partialProofs: partialCount,
        retainedProofsAfter100Replays: baseline,
        sourceCalls: downloader.calls - callsBefore,
        sourceBytes: 10 * bytes.length,
      };
    });
    for (const imageScope of ['SAME_AUTHOR', 'CHAT'])
      await measure(`history-growth-${imageScope}`, async () => {
        const content = extractDuplicateMessageContent({
          message: {
            body: {
              text: '',
              attachments: [
                {
                  type: 'image',
                  payload: { photo_id: 'fixed', url: 'https://i.oneme.ru/fixed.png' },
                },
              ],
            },
          },
        });
        const base = Date.now() - 1000;
        const observations = Array.from({ length: 256 }, (_, i) => ({
          chatId: '-940001',
          userId: String(123 + (i % 8)),
          messageId: `growth-${i}`,
          eventTimestampMs: base + i,
          controlRevision: 1,
          settings,
          content,
          imageScope,
          mediaHashes: ['a'.repeat(64)],
        }));
        const growth = [];
        let matches = 0;
        for (let i = 0; i < observations.length; i += 1) {
          if ((await history.observeWithOutcome(observations[i])).outcome === 'MATCHED')
            matches += 1;
          if ([63, 127, 255].includes(i))
            growth.push({ observations: i + 1, keys: (await keys(redis)).length });
        }
        const before = (await keys(redis)).length;
        for (const observation of observations) await history.observeWithOutcome(observation);
        assert.equal((await keys(redis)).length, before);
        assert.ok(before <= 3 * observations.length + 8);
        return {
          imageScope,
          observations: observations.length,
          replayed: observations.length,
          matches,
          growth,
          keysAfterReplay: before,
        };
      });
    await measure('proof-cache-ttl-expiry', async () => {
      const result = await fingerprint.fingerprint(bytes);
      const identities = Array.from({ length: 10 }, (_, i) => `expiry-${randomUUID()}-${i}`);
      assert.equal(
        await photoStore.cachePhotoFingerprints(
          identities.map((photoId) => ({ photoId, fingerprint: result })),
          1,
        ),
        true,
      );
      const present = await photoStore.getCachedPhotoFingerprints(identities);
      assert.equal(present.fingerprints.filter(Boolean).length, 10);
      const expiryStarted = performance.now();
      let remaining = 10;
      while (remaining && performance.now() - expiryStarted < 2000) {
        await delay(100);
        remaining = (await photoStore.getCachedPhotoFingerprints(identities)).fingerprints.filter(
          Boolean,
        ).length;
      }
      assert.equal(remaining, 0);
      assert.equal((await keys(redis)).length, 0);
      return {
        seededProofs: 10,
        ttlSeconds: 1,
        remainingProofs: remaining,
        observedExpiryMs: Math.round(performance.now() - expiryStarted),
      };
    });
    process.stdout.write(`CAPACITY_RESULT ${JSON.stringify(report)}\n`);
  } finally {
    clearInterval(sampleTimer);
    child.kill('SIGTERM');
    try {
      await within(closed, 5000);
    } catch {
      child.kill('SIGKILL');
      await within(closed, 5000);
    }
    await Promise.all([
      ordering.onModuleDestroy(),
      counters.onModuleDestroy(),
      photoStore.onModuleDestroy(),
    ]);
    await redis.quit();
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
