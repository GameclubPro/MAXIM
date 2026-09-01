import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
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
const {
  ADMIN_READY_URL,
  INGRESS_READY_URL,
  MAX_BODY_BYTES: READY_MAX_BODY_BYTES,
  probeReadyEndpoint,
  readBoundedResponseBody: readReadyResponseBody,
  runReadyMonitor,
  summarizeReadyHealth,
} = require(resolve(root, 'infra/scripts/monitor-ready-status.cjs'));

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

test('readiness parser preserves sanitized wrapped 503 diagnostics without declaring health', () => {
  const summary = summarizeReadyHealth(
    {
      httpStatus: 503,
      body: {
        message: {
          ok: false,
          systemMode: { mode: 'degrade', degraded: true, queueLagSec: 612.5 },
          checks: {
            database: true,
            redis: true,
            queueLag: { ok: false, rawOk: false, softWarning: false, softWarningCode: null },
          },
          bots: {
            'private-bot-identifier': { failedEvents: 3 },
            'another-private-bot': { failedEvents: 0 },
          },
          privateDiagnostic: 'must-not-be-printed',
        },
      },
    },
    {
      httpStatus: 200,
      body: { ok: true, checks: { database: true, redis: true } },
    },
  );

  assert.equal(summary.healthy, false);
  assert.match(summary.lines[0], /ready ok=false status=503/u);
  assert.match(summary.lines[0], /schema=true/u);
  assert.match(summary.lines[0], /mode=degrade degraded=true queueLagSec=612\.5/u);
  assert.match(summary.lines[0], /db=true redis=true/u);
  assert.match(summary.lines[0], /apiAdminReady=true apiAdminStatus=200/u);
  assert.match(summary.lines[0], /bots=2 botsWithRecentFailedEvents=1/u);
  assert.ok(summary.lines.includes('WARN: ingress ready status=503'));
  assert.ok(summary.lines.includes('WARN: system mode degraded (degrade)'));
  assert.ok(summary.lines.includes('WARN: queue metrics rawOk=false'));
  assert.doesNotMatch(summary.lines.join('\n'), /private-bot|must-not-be-printed/u);
});

test('readiness HTTP probe retains a JSON body from a 503 response', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: { ok: false, checks: { redis: false } } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');

  const probe = await probeReadyEndpoint(`http://127.0.0.1:${address.port}/ready`);
  assert.equal(probe.httpStatus, 503);
  assert.deepEqual(probe.body, {
    message: { ok: false, checks: { redis: false } },
  });
});

test('readiness HTTP probe rejects redirects without following them', async (t) => {
  let redirectedRequestCount = 0;
  const server = createServer((request, response) => {
    if (request.url === '/redirected') {
      redirectedRequestCount += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(302, { location: '/redirected' });
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');

  const probe = await probeReadyEndpoint(`http://127.0.0.1:${address.port}/ready`);
  assert.deepEqual(probe, { httpStatus: null, body: null });
  assert.equal(redirectedRequestCount, 0);
});

test('readiness body reader rejects declared and streamed overflow before buffering it', async () => {
  await assert.rejects(
    readReadyResponseBody(
      new Response('{}', {
        headers: { 'content-length': String(READY_MAX_BODY_BYTES + 1) },
      }),
    ),
    /oversized/u,
  );
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(READY_MAX_BODY_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  await assert.rejects(readReadyResponseBody(new Response(stream)), /oversized/u);
});

test('readiness monitor reports a 503 summary before returning nonzero', async () => {
  const lines = [];
  const exitCode = await runReadyMonitor({
    probe: async (url) => {
      if (url === INGRESS_READY_URL) {
        return {
          httpStatus: 503,
          body: {
            message: {
              ok: false,
              systemMode: { mode: 'degrade', degraded: true, queueLagSec: 45 },
              checks: {
                database: true,
                redis: false,
                queueLag: {
                  ok: true,
                  rawOk: false,
                  softWarning: true,
                  softWarningCode: 'queue-lag',
                },
              },
              bots: {},
            },
          },
        };
      }
      assert.equal(url, ADMIN_READY_URL);
      return {
        httpStatus: 200,
        body: { ok: true, checks: { database: true, redis: true } },
      };
    },
    writeLine: (line) => lines.push(line),
  });

  assert.equal(exitCode, 1);
  assert.match(lines[0], /ready ok=false status=503/u);
  assert.match(lines[0], /queueLagSec=45 queueOk=true db=true redis=false/u);
  assert.ok(lines.indexOf('WARN: ingress ready status=503') > 0);
});

test('readiness monitor returns zero for two healthy 200 responses', async () => {
  const lines = [];
  const exitCode = await runReadyMonitor({
    probe: async (url) => ({
      httpStatus: 200,
      body:
        url === INGRESS_READY_URL
          ? {
              ok: true,
              systemMode: { mode: 'normal', degraded: false, queueLagSec: 0 },
              checks: {
                database: true,
                redis: true,
                queueLag: { ok: true, rawOk: true, softWarning: false, softWarningCode: null },
              },
              bots: {},
            }
          : { ok: true, checks: { database: true, redis: true } },
    }),
    writeLine: (line) => lines.push(line),
  });

  assert.equal(exitCode, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ready ok=true status=200 schema=true mode=normal/u);
  assert.match(lines[0], /apiAdminReady=true apiAdminStatus=200/u);
});

test('readiness parser fails closed on incomplete and contradictory 200 payloads', () => {
  const healthyAdmin = {
    httpStatus: 200,
    body: { ok: true, checks: { database: true, redis: true } },
  };
  const incomplete = summarizeReadyHealth(
    {
      httpStatus: 200,
      body: { ok: true, checks: { database: true, redis: true } },
    },
    healthyAdmin,
  );
  const contradictory = summarizeReadyHealth(
    {
      httpStatus: 200,
      body: {
        ok: true,
        systemMode: { mode: 'normal', degraded: true, queueLagSec: 0 },
        checks: {
          database: true,
          redis: true,
          queueLag: { ok: true, rawOk: true, softWarning: false, softWarningCode: null },
        },
        bots: {},
      },
    },
    healthyAdmin,
  );

  for (const summary of [incomplete, contradictory]) {
    assert.equal(summary.healthy, false);
    assert.match(summary.lines[0], /status=200 schema=false/u);
    assert.ok(summary.lines.includes('WARN: ingress ready payload is invalid'));
  }
});

test('readiness parser bounds untrusted diagnostic labels', () => {
  const summary = summarizeReadyHealth(
    {
      httpStatus: 503,
      body: {
        ok: false,
        systemMode: { mode: 'degrade\nsecret', degraded: true, queueLagSec: 'secret' },
        checks: {
          database: true,
          redis: true,
          queueLag: {
            ok: false,
            rawOk: true,
            softWarning: true,
            softWarningCode: 'secret value\nsecond-line',
          },
        },
      },
    },
    {
      httpStatus: 200,
      body: { ok: true, checks: { database: true, redis: true } },
    },
  );

  assert.match(summary.lines[0], /mode=unknown degraded=true queueLagSec=unknown/u);
  assert.match(summary.lines[0], /softWarning=true softWarningCode=unknown/u);
  assert.doesNotMatch(summary.lines.join('\n'), /secret/u);
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
