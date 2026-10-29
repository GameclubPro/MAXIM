import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProgressLog } from '../src/progress-log.js';
import { HttpTelemetry } from '../src/telemetry.js';

test('busy progress and scheduler failures stay bounded while unchanged idle samples stay quiet', () => {
  let now = Date.parse('2026-10-29T00:00:00Z');
  const lines: string[] = [];
  const log = new ProgressLog(
    (line) => {
      lines.push(line);
    },
    () => now,
  );
  const telemetry = new HttpTelemetry(() => now);
  const health = { schedulerHealthy: true };
  for (let index = 0; index < 1000; index++) {
    telemetry.attempt('delete');
    log.progress(health, telemetry.snapshot());
    log.failure(index % 2 ? 'cleanup_scheduler_failed' : 'connection_scheduler_failed');
  }
  assert.equal(lines.length, 2);
  now += 30_000;
  log.progress(health, telemetry.snapshot());
  log.failure('cleanup_scheduler_failed');
  assert.equal(lines.length, 4);
  now += 60_000;
  log.progress(health, telemetry.snapshot());
  assert.equal(lines.length, 4, 'Changing only the sample time is not progress');
  assert.equal(
    JSON.parse(lines[2]!).transport.requests.find(
      (row: { purpose: string }) => row.purpose === 'delete',
    ).attempts,
    1000,
  );
});

test('structured progress strips extra transport and worker data and a failed log sink cannot change work', () => {
  const telemetry = new HttpTelemetry();
  const metrics = Object.assign(telemetry.snapshot(), { token: 'private-token' });
  Object.assign(metrics.requests[0]!, { path: '/private-message-id' });
  const worker = { healthy: true, occupiedSlots: 0, lastCompletedAt: null, error: 'private-error' };
  const health = {
    schedulerHealthy: true,
    workers: { cleanup: worker, connection: worker },
    payload: 'private-payload',
  };
  const lines: string[] = [];
  new ProgressLog((line) => {
    lines.push(line);
  }).progress(health, metrics);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0]!, /private/);
  assert.ok(lines[0]!.length < 4000);
  const unavailable = new ProgressLog(() => {
    throw new Error('log sink unavailable');
  });
  assert.doesNotThrow(() => unavailable.progress(health, metrics));
  assert.doesNotThrow(() => unavailable.failure('cleanup_scheduler_failed'));
});
