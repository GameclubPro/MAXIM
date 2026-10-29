import assert from 'node:assert/strict';
import test from 'node:test';
import { eraserBackupReady } from './check-eraser-backup-readiness.mjs';
test('Lastik backup requires its own live stores and both healthy consumers when enabled', () => {
  const healthy = {
    service: 'eraser',
    status: 'ok',
    schedulerHealthy: true,
    commitSha: 'a'.repeat(40),
    enabled: true,
    workers: { cleanup: { healthy: true }, connection: { healthy: true } },
  };
  assert.equal(eraserBackupReady(200, healthy), true);
  for (const [status, value] of [
    [503, healthy],
    [200, { ...healthy, service: 'api' }],
    [200, { ...healthy, workers: {} }],
    [200, { ...healthy, schedulerHealthy: false }],
    [200, { ...healthy, commitSha: 'unknown' }],
  ])
    assert.equal(eraserBackupReady(status, value), false);
  assert.equal(eraserBackupReady(200, { ...healthy, enabled: false, workers: undefined }), true);
});
