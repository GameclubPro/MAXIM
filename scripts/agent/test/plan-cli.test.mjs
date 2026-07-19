import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseImpactPlanArgs, runImpactPlanCli } from '../plan.mjs';

test('parses worktree, staged, and base-head modes', () => {
  assert.equal(parseImpactPlanArgs([]).mode, 'worktree');
  assert.equal(parseImpactPlanArgs(['--staged', '--json']).mode, 'staged');
  assert.deepEqual(
    pick(parseImpactPlanArgs(['--base', 'origin/main', '--head', 'HEAD', '--format', 'json']), [
      'mode',
      'base',
      'head',
      'format',
    ]),
    { mode: 'range', base: 'origin/main', head: 'HEAD', format: 'json' },
  );
  assert.equal(parseImpactPlanArgs(['--base', 'HEAD~1']).head, 'HEAD');
});

test('rejects ambiguous or incomplete mode arguments', () => {
  assert.throws(
    () => parseImpactPlanArgs(['--staged', '--worktree']),
    /mutually exclusive/u,
  );
  assert.throws(() => parseImpactPlanArgs(['--head', 'HEAD']), /requires --base/u);
  assert.throws(
    () => parseImpactPlanArgs(['--staged', '--base', 'HEAD~1']),
    /cannot be combined/u,
  );
});

test('CLI emits machine-readable deterministic JSON for a separate worktree', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'maxim-agent-plan-cli-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, ['init', '--quiet']);
  git(repo, ['config', 'user.name', 'Agent Planner Tests']);
  git(repo, ['config', 'user.email', 'agent-planner@example.invalid']);
  await writeFile(join(repo, 'README.md'), 'initial\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '--quiet', '-m', 'initial']);
  await writeFile(join(repo, 'README.md'), 'changed\n');

  const outputs = [];
  const exitCode = await runImpactPlanCli(['--repo', repo, '--json'], {
    stdout: (value) => outputs.push(value),
    stderr: () => {},
  });
  const result = JSON.parse(outputs.join(''));

  assert.equal(exitCode, 0);
  assert.deepEqual(result.changedFiles, ['README.md']);
  assert.deepEqual(result.deploy.components, []);
  assert.ok(result.checks.includes('docs'));
  assert.equal(outputs.length, 1);
});

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
