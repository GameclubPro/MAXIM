import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const scriptPath = resolve(import.meta.dirname, 'with-file-lock.mjs');

function runLocked(lockRoot, lockName, code, outputPath) {
  const child = spawn(
    process.execPath,
    [scriptPath, lockName, '--', process.execPath, '-e', code, outputPath],
    {
      env: { ...process.env, MAXIM_LOCK_ROOT: lockRoot, MAXIM_LOCK_WAIT_TIMEOUT_MS: '5000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  return new Promise((resolveRun, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Locked command failed with ${code}: ${stderr}`));
        return;
      }
      resolveRun();
    });
  });
}

test('serializes commands that use the same lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'maxim-lock-test-'));
  const output = join(root, 'events.txt');
  const code = `
    const { appendFileSync } = require('node:fs');
    const output = process.argv[1];
    appendFileSync(output, 'start:' + process.pid + '\\n');
    const until = Date.now() + 150;
    while (Date.now() < until) {}
    appendFileSync(output, 'end:' + process.pid + '\\n');
  `;

  await Promise.all([
    runLocked(root, 'shared', code, output),
    runLocked(root, 'shared', code, output),
  ]);

  const events = readFileSync(output, 'utf8').trim().split('\n');
  assert.equal(events.length, 4);
  assert.match(events[0], /^start:/u);
  assert.match(events[1], /^end:/u);
  assert.match(events[2], /^start:/u);
  assert.match(events[3], /^end:/u);
  assert.equal(events[0].slice(6), events[1].slice(4));
  assert.equal(events[2].slice(6), events[3].slice(4));
});

test('recovers a lock owned by a dead local process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'maxim-stale-lock-test-'));
  const lockPath = join(root, 'stale.lock');
  const output = join(root, 'result.txt');
  mkdirSync(lockPath);
  writeFileSync(
    join(lockPath, 'owner.json'),
    JSON.stringify({ pid: 2_000_000_000, hostname: hostname() }),
  );

  await runLocked(
    root,
    'stale',
    "require('node:fs').writeFileSync(process.argv[1], 'ok')",
    output,
  );

  assert.equal(readFileSync(output, 'utf8'), 'ok');
});
