import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test(
  'isolated archive restores journals, guards and durable work into a fresh fake-MAX queue',
  { timeout: 90_000 },
  () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./support/restore-rehearsal.mjs', import.meta.url)),
      ],
      { env: process.env, encoding: 'utf8', timeout: 80_000 },
    );
    assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
    const report = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    assert.equal(report.journalsPreserved, 3);
    assert.equal(report.externalRequests, 0);
    assert.equal(report.freshRedisQueueReconstructed, true);
    assert.equal(report.fakeDeleteCount, 1);
  },
);
