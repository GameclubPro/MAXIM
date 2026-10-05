import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  createMultibotRuntimeGuard,
  readMultibotRuntimePressure,
} from './multibot-runtime-pressure.mjs';
import { runMultibotSupervisorCommand } from './multibot-online-supervisor.mjs';

const epoch = Date.parse('2026-10-05T13:00:00.000Z');
function snapshot(atMs = epoch, lagSec = 0) {
  const body = {
    ok: lagSec <= 30,
    timestamp: new Date(atMs).toISOString(),
    checks: {
      database: true,
      redis: true,
      queueLag: {
        ok: lagSec <= 30,
        rawOk: lagSec <= 10,
        softWarning: lagSec > 10 && lagSec <= 30,
        softWarningCode: lagSec > 10 && lagSec <= 30 ? 'queue-lag-hysteresis' : null,
        effectiveLagSec: lagSec,
        sampleGeneratedAt: new Date(atMs).toISOString(),
      },
    },
  };
  const probe = { status: body.ok ? 200 : 503, body };
  return { checkedAtMs: atMs, ingress: probe, admin: structuredClone(probe) };
}
const output = (probe) => `${JSON.stringify(probe.body)}\n${probe.status}`;

test('reader uses only two fixed bounded local probes concurrently and preserves queue-only503', async () => {
  const source = snapshot(epoch, 45);
  const calls = [];
  const pending = [];
  const result = readMultibotRuntimePressure({
    now: () => epoch,
    run: (command, args, options) =>
      new Promise((resolve) => {
        calls.push({ command, args, options });
        pending.push(resolve);
        if (pending.length === 2)
          for (const fulfill of pending) fulfill({ stdout: output(source.ingress) });
      }),
  });
  const value = await result;
  assert.deepEqual(value, source);
  assert.deepEqual(
    calls.map((call) => call.args.at(-1)),
    ['http://127.0.0.1:3001/api/health/ready', 'http://127.0.0.1:3002/api/health/ready'],
  );
  for (const call of calls) {
    assert.equal(call.command, 'curl');
    assert.ok(!call.args.includes('--fail') && !call.args.includes('--location'));
    assert.equal(call.args[call.args.indexOf('--max-time') + 1], '2');
    assert.equal(call.args[call.args.indexOf('--noproxy') + 1], '*');
    assert.equal(call.options.timeout, 3_000);
    assert.equal(call.options.maxBuffer, 256 * 1024);
  }
});

test('reader discards free-form failed commands, malformed JSON and invalid HTTP envelopes', async () => {
  for (const value of [undefined, 'secret', '{}\n200', '{}\n302', '{}\n200\n', 'secret\n503'])
    await assert.rejects(
      readMultibotRuntimePressure({ now: () => epoch, run: async () => ({ stdout: value }) }),
      { message: 'MULTIBOT_PREPARE_RUNTIME_INVALID' },
    );
  await assert.rejects(
    readMultibotRuntimePressure({
      run: async () => {
        throw new Error('secret-body-or-transport-error');
      },
    }),
    { message: 'MULTIBOT_PREPARE_RUNTIME_UNAVAILABLE' },
  );
});

test('admission/final require both genuinely ready endpoints at or below10s', () => {
  for (const phase of ['admit', 'finish']) {
    for (const lag of [0, 10]) {
      const guard = createMultibotRuntimeGuard({ now: () => epoch });
      assert.equal(guard[phase](snapshot(epoch, lag)).lagSec, lag);
    }
    for (const role of ['ingress', 'admin']) {
      const source = snapshot();
      source[role] = snapshot(epoch, 10.001)[role];
      const guard = createMultibotRuntimeGuard({ now: () => epoch });
      assert.throws(guard[phase].bind(null, source), {
        message: `MULTIBOT_PREPARE_RUNTIME_${phase === 'admit' ? 'ADMISSION' : 'FINAL'}_BLOCKED`,
      });
    }
  }
});

test('queue pressure uses max of both roles, tolerates transient503 and aborts120s+ immediately', () => {
  for (const role of ['ingress', 'admin']) {
    const guard = createMultibotRuntimeGuard({ now: () => epoch });
    guard.admit(snapshot());
    const source = snapshot();
    source[role] = snapshot(epoch + 1, 120)[role];
    assert.equal(guard.observe(source).lagSec, 120);
    // A new genuine sample rather than an inconsistent rewrite of a cached sample.
    source[role] = snapshot(epoch + 2, 120.001)[role];
    assert.throws(() => guard.observe(source), { message: 'MULTIBOT_PREPARE_RUNTIME_QUEUE_LAG' });
  }
});

test('continuous30s+pressure aborts at90s and a fresh clear resets only that breach timer', () => {
  let current = epoch;
  const guard = createMultibotRuntimeGuard({ now: () => current });
  guard.admit(snapshot());
  const observe = (offset, lag) => {
    current = epoch + offset;
    return guard.observe(snapshot(current, lag));
  };
  assert.equal(observe(10_000, 31).breachStartedAtMs, epoch + 10_000);
  assert.equal(observe(99_999, 31).breachStartedAtMs, epoch + 10_000);
  assert.equal(observe(100_000, 30).breachStartedAtMs, null);
  assert.equal(observe(110_000, 31).breachStartedAtMs, epoch + 110_000);
  assert.equal(observe(199_999, 31).breachStartedAtMs, epoch + 110_000);
  assert.throws(() => observe(200_000, 31), { message: 'MULTIBOT_PREPARE_RUNTIME_QUEUE_LAG' });
});

test('stale, future, fallback, regressing and contradictory samples cannot clear pressure', () => {
  let current = epoch;
  const guard = createMultibotRuntimeGuard({ now: () => current });
  guard.admit(snapshot());
  current += 10_000;
  guard.observe(snapshot(current, 31));
  const invalid = [
    {
      mutate: (s) => {
        s.ingress.body.checks.queueLag.softWarning = true;
        s.ingress.body.checks.queueLag.softWarningCode = 'stale-ready-fallback';
      },
      code: 'STALE',
    },
    {
      mutate: (s) => {
        s.ingress.body.checks.queueLag.sampleGeneratedAt = new Date(current - 30_001).toISOString();
      },
      code: 'STALE',
    },
    {
      mutate: (s) => {
        s.admin.body.timestamp = new Date(current + 5_001).toISOString();
      },
      code: 'STALE',
    },
    {
      mutate: (s) => {
        s.checkedAtMs = current - 30_001;
      },
      code: 'STALE',
    },
    {
      mutate: (s) => {
        s.checkedAtMs = current + 5_001;
      },
      code: 'STALE',
    },
    {
      mutate: (s) => {
        s.admin.body.checks.queueLag.sampleGeneratedAt = new Date(current - 1).toISOString();
      },
      code: 'STALE',
    },
    {
      mutate: (s) => {
        s.ingress.body.checks.queueLag.sampleGeneratedAt = new Date(current).toISOString();
      },
      code: 'INVALID',
    },
  ];
  for (const { mutate, code } of invalid) {
    const value = snapshot(current + 1);
    mutate(value);
    assert.throws(() => guard.observe(value), { message: `MULTIBOT_PREPARE_RUNTIME_${code}` });
  }
  current += 90_000;
  assert.throws(() => guard.observe(snapshot(current, 31)), {
    message: 'MULTIBOT_PREPARE_RUNTIME_QUEUE_LAG',
  });
});

test('freshness boundaries are inclusive, both timestamps matter, and clock rollback fails closed', () => {
  const guard = createMultibotRuntimeGuard({ now: () => epoch });
  const source = snapshot(epoch - 30_000);
  guard.admit(source);
  const future = snapshot(epoch + 5_000);
  guard.finish(future);
  let current = epoch;
  const changing = createMultibotRuntimeGuard({ now: () => current });
  changing.admit(snapshot());
  current -= 1;
  assert.throws(() => changing.observe(snapshot(current)), {
    message: 'MULTIBOT_PREPARE_RUNTIME_CLOCK_INVALID',
  });
});

test('dependency and nonqueue failures are immediate; unknown schemas and warning codes fail closed', () => {
  for (const role of ['ingress', 'admin']) {
    for (const mutation of [
      (p) => {
        p.body.checks.database = false;
        p.body.ok = false;
        p.status = 503;
      },
      (p) => {
        p.body.checks.redis = false;
        p.body.ok = false;
        p.status = 503;
      },
      (p) => {
        p.body.checks.ocr = { ready: false };
        p.body.ok = false;
        p.status = 503;
      },
      (p) => {
        p.body.ok = false;
        p.status = 503;
      },
    ]) {
      const source = snapshot();
      mutation(source[role]);
      assert.throws(() => createMultibotRuntimeGuard({ now: () => epoch }).observe(source), {
        message: 'MULTIBOT_PREPARE_RUNTIME_NOT_READY',
      });
    }
    for (const mutation of [
      (p) => {
        delete p.body.checks.queueLag;
      },
      (p) => {
        p.body.checks.futureCheck = true;
      },
      (p) => {
        p.body.checks.queueLag.effectiveLagSec = '0';
      },
      (p) => {
        p.body.checks.queueLag.effectiveLagSec = NaN;
      },
      (p) => {
        p.body.checks.queueLag.effectiveLagSec = -1;
      },
      (p) => {
        p.body.checks.queueLag.softWarningCode = 'unknown';
      },
      (p) => {
        p.status = 503;
      },
      (p) => {
        p.body.checks.queueLag.sampleGeneratedAt = 'secret';
      },
    ]) {
      const source = snapshot();
      mutation(source[role]);
      assert.throws(() => createMultibotRuntimeGuard({ now: () => epoch }).observe(source), {
        message: 'MULTIBOT_PREPARE_RUNTIME_INVALID',
      });
    }
  }
});

test('real curl HTTP fixture preserves503 bodies without leaking their contents', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify(snapshot(Date.now(), 45).ingress.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const result = await readMultibotRuntimePressure({
    run: (command, args, options) =>
      runMultibotSupervisorCommand(
        command,
        [...args.slice(0, -1), `http://127.0.0.1:${address.port}/api/health/ready`],
        options,
      ),
  });
  const guard = createMultibotRuntimeGuard();
  assert.equal(guard.observe(result).lagSec, 45);
});
