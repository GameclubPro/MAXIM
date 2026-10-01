import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const library = resolve(root, 'infra/scripts/lib/deploy-topology.sh');
const executorPath = 'apps/api/src/moderation/moderation-delete-intent.service.ts';
test('rollback rejects the old retention executor and accepts receipt-safe recovery', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'maxim-retention-rollback-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: fixture,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    git('init', '-q', '-b', 'main');
    mkdirSync(resolve(fixture, 'apps/api/src/moderation'), { recursive: true });
    const compatibleSource = readFileSync(resolve(root, executorPath), 'utf8');
    const incompatibleSource = compatibleSource.replace(
      'async reconcileRetentionIntent(',
      'async reconcileLegacyReceipt(',
    );
    assert.notEqual(incompatibleSource, compatibleSource);
    writeFileSync(resolve(fixture, executorPath), incompatibleSource);
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'old retention',
    );
    const oldSha = git('rev-parse', 'HEAD');
    writeFileSync(resolve(fixture, executorPath), readFileSync(resolve(root, executorPath)));
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'receipt-safe retention',
    );
    const newSha = git('rev-parse', 'HEAD');
    const check = (sha) =>
      spawnSync(
        'bash',
        [
          '-c',
          'source "$1"; maxim_topology_require_message_retention_guard "$2"',
          'retention-test',
          library,
          sha,
        ],
        { cwd: fixture, encoding: 'utf8' },
      );
    assert.equal(check(oldSha).status, 1);
    assert.match(check(oldSha).stderr, /receipt recovery/u);
    assert.equal(check(newSha).status, 0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
