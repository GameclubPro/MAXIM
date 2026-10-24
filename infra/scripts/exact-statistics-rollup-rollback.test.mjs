import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const reader = 'apps/api/src/admin/stats-read-model-selectors.ts';
test('both API rollback paths require the exact fallback reader even when a stale target retains its version marker', (t) => {
  const repository = mkdtempSync(join(tmpdir(), 'exact-rollup-floor-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q');
  mkdirSync(join(repository, 'apps/api/src/admin'), { recursive: true });
  const write = (source) => {
    writeFileSync(join(repository, reader), source);
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'reader',
    );
    return git('rev-parse', 'HEAD');
  };
  const current = readFileSync(join(root, reader), 'utf8');
  const exact = write(current);
  const stale = write(
    current.replace('SUM(COALESCE(views_total_exact, views_total::bigint))', 'SUM(views_total)'),
  );
  const run = (sha) =>
    spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; maxim_topology_require_exact_statistics_rollup_reader "$2"',
        'fixture',
        join(root, 'infra/scripts/lib/deploy-topology.sh'),
        sha,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
  assert.equal(run(exact).status, 0);
  assert.notEqual(run(stale).status, 0);
  for (const path of ['vps-runtime-rollback.sh', 'vps-release-rollback.sh'])
    assert.match(
      readFileSync(join(root, 'infra/scripts', path), 'utf8'),
      /maxim_topology_require_exact_statistics_rollup_reader "\$(TARGET_FULL_SHA|API_SOURCE_SHA)"/u,
    );
});
