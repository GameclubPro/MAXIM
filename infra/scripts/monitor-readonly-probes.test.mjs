import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const publisherPath = resolve(root, 'infra/scripts/monitor-publisher-status.cjs');
const { summarizePublisherStatus } = require(publisherPath);
const { MAX_BODY_BYTES, OCR_READY_URL, readBoundedResponseBody, summarizeMediaHealth } = require(
  resolve(root, 'infra/scripts/monitor-media-ready.cjs'),
);
const { REQUIRED_FIELDS, summarizeRedisInfo } = require(
  resolve(root, 'infra/scripts/monitor-redis-info.cjs'),
);

const healthyPublisher = {
  result: 'observed',
  pauseKind: 'missing',
  heartbeatKind: 'fresh',
  heartbeatEnabled: true,
};

test('Publisher summary fails closed on pause, stale heartbeat, and mixed runtime state', () => {
  assert.equal(summarizePublisherStatus(healthyPublisher, 'true', 'true', 'true').healthy, true);
  assert.equal(
    summarizePublisherStatus(
      { ...healthyPublisher, heartbeatEnabled: false },
      'false',
      'false',
      'true',
    ).healthy,
    true,
  );
  for (const [control, adminExpected, publisherExpected, botIdParity] of [
    [{ ...healthyPublisher, pauseKind: 'authorization' }, 'true', 'true', 'true'],
    [{ ...healthyPublisher, heartbeatKind: 'missing' }, 'true', 'true', 'true'],
    [{ ...healthyPublisher, heartbeatEnabled: false }, 'true', 'true', 'true'],
    [healthyPublisher, 'false', 'true', 'true'],
    [healthyPublisher, 'true', 'true', 'false'],
  ]) {
    assert.equal(
      summarizePublisherStatus(control, adminExpected, publisherExpected, botIdParity).healthy,
      false,
    );
  }
  assert.throws(
    () =>
      summarizePublisherStatus(
        { ...healthyPublisher, result: 'unexpected' },
        'true',
        'true',
        'true',
      ),
    /invalid/u,
  );
  assert.throws(
    () =>
      summarizePublisherStatus(
        { ...healthyPublisher, pauseKind: 'private-payload' },
        'true',
        'true',
        'true',
      ),
    /invalid/u,
  );
});

test('Publisher status CLI exposes only classified fields and returns unhealthy status', () => {
  const result = spawnSync(process.execPath, [publisherPath, 'true', 'true', 'true'], {
    input: JSON.stringify({ ...healthyPublisher, heartbeatKind: 'missing' }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    result.stdout,
    'publisher expected=true parity=true botParity=true pause=missing heartbeat=missing/true\n',
  );
});

test('media readiness parser preserves useful 503 diagnostics without declaring health', () => {
  const summary = summarizeMediaHealth(503, {
    message: {
      ok: false,
      checks: {
        database: true,
        redis: true,
        ocr: {
          state: 'degraded',
          ready: false,
          workers: { configured: 1, live: 1, ready: 0, busy: 1 },
          queueDepth: 3,
          counters: { failed: 2, restarts: 1, recycles: 4 },
          behaviorIdentity: { verified: false, state: 'failed' },
        },
      },
    },
  });
  assert.equal(summary.healthy, false);
  assert.match(summary.line, /status=503/u);
  assert.match(summary.line, /workers=1\/1\/0\/1/u);
  assert.match(summary.line, /identity=false\/failed/u);
});

test('media readiness monitor uses the isolated OCR scope and labels omitted dependencies', () => {
  const summary = summarizeMediaHealth(200, {
    ok: true,
    scope: 'ocr',
    checks: {
      ocr: {
        state: 'ready',
        ready: true,
        workers: { configured: 1, live: 1, ready: 1, busy: 0 },
        queueDepth: 0,
        behaviorIdentity: { verified: true, state: 'verified' },
      },
    },
  });

  assert.equal(OCR_READY_URL, 'http://127.0.0.1:3001/api/health/ready?scope=ocr');
  assert.equal(summary.healthy, true);
  assert.match(summary.line, /scope=ocr/u);
  assert.match(summary.line, /db=not-probed redis=not-probed/u);
  assert.match(summary.line, /failed=not-probed restarts=not-probed recycles=not-probed/u);
});

test('media readiness body reader rejects declared and streamed overflow before buffering it', async () => {
  await assert.rejects(
    readBoundedResponseBody(
      new Response('{}', { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }),
    ),
    /oversized/u,
  );
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_BODY_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  await assert.rejects(readBoundedResponseBody(new Response(stream)), /oversized/u);
});

function redisFixture(overrides = {}) {
  const values = Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, '0']));
  values.rdb_last_bgsave_status = 'ok';
  return Object.entries({ ...values, ...overrides })
    .map(([key, value]) => `${key}:${value}`)
    .join('\r\n');
}

test('Redis INFO parser emits only allowlisted fields and rejects missing or duplicate anchors', () => {
  const lines = summarizeRedisInfo(`${redisFixture()}\r\nmaster_replid:private-material\r\n`);
  assert.ok(lines.includes('redis rdb_last_bgsave_status=ok'));
  assert.equal(
    lines.some((line) => line.includes('master_replid')),
    false,
  );
  assert.throws(() => summarizeRedisInfo('used_memory:1\nused_memory_rss:2\n'), /missing/u);
  assert.throws(() => summarizeRedisInfo(`${redisFixture()}\nused_memory:2\n`), /invalid/u);
});
