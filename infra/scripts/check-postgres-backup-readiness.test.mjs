import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { inspectBackupReadiness } from './check-postgres-backup-readiness.mjs';

const ready = {
  ok: true,
  checks: {
    database: true,
    redis: true,
    queueLag: { rawOk: true, softWarning: false, effectiveLagSec: 1.5, thresholdSec: 15 },
  },
};

test('readiness failures retain the original strict admission checks and useful lag evidence', () => {
  assert.equal(inspectBackupReadiness(ready).ok, true);
  for (const field of ['database', 'redis']) {
    const report = inspectBackupReadiness({
      ...ready,
      checks: { ...ready.checks, [field]: false },
    });
    assert.equal(report.ok, false);
    assert.deepEqual(report.failures, [field]);
  }
  const report = inspectBackupReadiness({
    ...ready,
    checks: {
      ...ready.checks,
      queueLag: {
        rawOk: false,
        softWarning: true,
        effectiveLagSec: 31,
        oldestReceivedLagSec: 31,
        oldestQueuedLagSec: 0.8,
        thresholdSec: 15,
        breachDurationSec: 29,
      },
    },
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.failures, ['raw_queue_lag', 'queue_soft_warning']);
  assert.equal(report.effectiveLagSec, 31);
  assert.equal(report.breachDurationSec, 29);
  assert.equal(inspectBackupReadiness({ ...ready, ok: 'true' }).ok, false);
  assert.equal(
    inspectBackupReadiness({ ...ready, checks: { ...ready.checks, queueLag: {} } }).ok,
    false,
  );
});

test('diagnostics never expose identities, free-form detail or nonnumeric metric values', () => {
  const report = inspectBackupReadiness({
    ...ready,
    checks: {
      ...ready.checks,
      queueLag: {
        ...ready.checks.queueLag,
        rawOk: false,
        oldestReceivedEventId: 'private-secret',
        softWarningDetail: 'private-secret',
        oldestQueuedLagSec: 'private-secret',
        oldestReceivedLagSec: -1,
        breachDurationSec: Infinity,
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(report), /private-secret|EventId|softWarningDetail/);
  assert.equal(report.oldestQueuedLagSec, null);
  assert.equal(report.oldestReceivedLagSec, null);
  assert.equal(report.breachDurationSec, null);
});

test('CLI fails closed for HTTP failure, invalid JSON and oversized responses without raw output', () => {
  const cli = new URL('./check-postgres-backup-readiness.mjs', import.meta.url).pathname;
  for (const [code, input, status, reason] of [
    ['0', JSON.stringify(ready), 0, null],
    ['22', JSON.stringify(ready), 1, 'http_or_transport'],
    ['28', '', 1, 'http_or_transport'],
    ['0', 'private-secret', 1, 'invalid_json'],
    ['0', 'private-secret'.repeat(6000), 1, 'response_too_large'],
  ]) {
    const result = spawnSync(process.execPath, [cli, code], { input, encoding: 'utf8' });
    assert.equal(result.status, status);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /private-secret/);
    if (reason) {
      const report = JSON.parse(result.stderr);
      assert.equal(report.ok, false);
      assert.ok(report.failures.includes(reason));
    } else assert.equal(result.stderr, '');
  }
});
