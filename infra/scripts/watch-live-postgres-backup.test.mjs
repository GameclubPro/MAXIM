import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { evaluateBackupProbe, runWatchedBackup } from './watch-live-postgres-backup.mjs';

const now = Date.now();
function health(changes = {}) {
  return {
    ok: true,
    systemMode: { degraded: false },
    checks: {
      database: true,
      redis: true,
      queueLag: {
        ok: true,
        rawOk: true,
        effectiveLagSec: 0,
        sampleGeneratedAt: new Date(now).toISOString(),
        ...changes,
      },
    },
  };
}
function response(first = health(), second = health(), free = 5 * 1024 ** 3) {
  return `${free}\n${JSON.stringify(first)}\n${JSON.stringify(second)}\n`;
}
test('backup probe checks both endpoints, freshness, queue lag and reserve', () => {
  assert.equal(evaluateBackupProbe(response(), now), null);
  assert.equal(
    evaluateBackupProbe(response(health(), health({ effectiveLagSec: 10 })), now),
    'queue_lag',
  );
  assert.equal(evaluateBackupProbe(response(health({ rawOk: false })), now), 'unhealthy');
  assert.equal(evaluateBackupProbe(response(), now + 31_000), 'stale_probe');
  assert.equal(
    evaluateBackupProbe(response(health(), health(), 3 * 1024 ** 3), now),
    'root_reserve',
  );
  assert.equal(evaluateBackupProbe(response(health({ effectiveLagSec: null })), now), 'queue_lag');
  assert.equal(evaluateBackupProbe('secret or invalid output', now), 'invalid_probe');
});
test('unhealthy preflight never starts a dump', async () => {
  await assert.rejects(
    runWatchedBackup([], {
      probe: async () => 'queue_lag',
      start: () => assert.fail('must not start'),
    }),
    /preflight stopped: queue_lag/u,
  );
});
test('mid-stream degradation terminates and reaps the process group', async () => {
  let probes = 0;
  let child;
  await assert.rejects(
    runWatchedBackup([], {
      probe: async () => (++probes === 1 ? null : 'queue_lag'),
      intervalMs: 40,
      start: () => {
        child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true,
          stdio: 'ignore',
        });
        return child;
      },
    }),
    /watchdog stopped: queue_lag/u,
  );
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});
test('normal completion stops polling and helper errors propagate', async () => {
  for (const code of [0, 7]) {
    const run = runWatchedBackup([], {
      probe: async () => null,
      intervalMs: 10,
      start: () =>
        spawn(process.execPath, ['-e', `process.exit(${code})`], {
          detached: true,
          stdio: 'ignore',
        }),
    });
    if (code) await assert.rejects(run, /status 7/u);
    else await run;
  }
});
