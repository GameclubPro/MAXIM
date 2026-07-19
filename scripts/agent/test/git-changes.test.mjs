import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectGitChanges,
  parseNameStatusZ,
  parsePorcelainV1Z,
} from '../git-changes.mjs';

test('parses name-status rename records with both paths', () => {
  assert.deepEqual(parseNameStatusZ(Buffer.from('M\0plain.ts\0R100\0old.ts\0new.ts\0')), [
    { status: 'R100', oldPath: 'old.ts', newPath: 'new.ts', paths: ['old.ts', 'new.ts'] },
    { status: 'M', path: 'plain.ts', paths: ['plain.ts'] },
  ]);
});

test('parses porcelain rename records in destination-then-source order', () => {
  assert.deepEqual(parsePorcelainV1Z(Buffer.from('R  destination.ts\0source.ts\0?? untracked.ts\0')), [
    {
      status: 'R ',
      oldPath: 'source.ts',
      newPath: 'destination.ts',
      paths: ['source.ts', 'destination.ts'],
    },
    { status: '??', path: 'untracked.ts', paths: ['untracked.ts'] },
  ]);
});

test('worktree mode includes staged, unstaged, deleted, renamed, and untracked paths', async (t) => {
  const repo = await createRepo(t);
  git(repo.path, ['mv', 'apps/api/src/old.ts', 'apps/api/src/new.ts']);
  await unlink(join(repo.path, 'docs/remove.md'));
  await writeFile(join(repo.path, 'README.md'), 'changed\n');
  await mkdir(join(repo.path, 'untracked dir'));
  await writeFile(join(repo.path, 'untracked dir/new file.ts'), 'new\n');

  const result = collectGitChanges({ cwd: repo.path, mode: 'worktree' });

  assert.deepEqual(result.changedPaths, [
    'README.md',
    'apps/api/src/new.ts',
    'apps/api/src/old.ts',
    'docs/remove.md',
    'untracked dir/new file.ts',
  ]);
  const rename = result.changes.find((change) => change.oldPath);
  assert.deepEqual(rename.paths, ['apps/api/src/old.ts', 'apps/api/src/new.ts']);
  assert.ok(result.changes.some((change) => change.status === '??'));
  assert.ok(result.changes.some((change) => change.status.includes('D')));
});

test('staged mode ignores unstaged and untracked files while retaining both rename paths', async (t) => {
  const repo = await createRepo(t);
  git(repo.path, ['mv', 'apps/api/src/old.ts', 'apps/api/src/new.ts']);
  await unlink(join(repo.path, 'docs/remove.md'));
  await writeFile(join(repo.path, 'untracked.ts'), 'new\n');

  const result = collectGitChanges({ cwd: repo.path, mode: 'staged' });

  assert.deepEqual(result.changedPaths, ['apps/api/src/new.ts', 'apps/api/src/old.ts']);
  assert.equal(result.changes.length, 1);
  assert.match(result.changes[0].status, /^R/u);
  assert.equal(result.source.base, 'HEAD');
  assert.equal(result.source.head, 'INDEX');
});

test('range mode resolves refs and includes deleted, added, and both rename paths', async (t) => {
  const repo = await createRepo(t);
  const base = git(repo.path, ['rev-parse', 'HEAD']).trim();
  git(repo.path, ['mv', 'apps/api/src/old.ts', 'apps/api/src/new.ts']);
  await unlink(join(repo.path, 'docs/remove.md'));
  await writeFile(join(repo.path, 'added.ts'), 'new\n');
  git(repo.path, ['add', '-A']);
  git(repo.path, ['commit', '-m', 'range head']);

  const result = collectGitChanges({ cwd: repo.path, mode: 'range', base, head: 'HEAD' });

  assert.deepEqual(result.changedPaths, [
    'added.ts',
    'apps/api/src/new.ts',
    'apps/api/src/old.ts',
    'docs/remove.md',
  ]);
  assert.equal(result.source.base, base);
  assert.match(result.source.head, /^[0-9a-f]{40}$/u);
});

async function createRepo(t) {
  const path = await mkdtemp(join(tmpdir(), 'maxim-agent-plan-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  git(path, ['init', '--quiet']);
  git(path, ['config', 'user.name', 'Agent Planner Tests']);
  git(path, ['config', 'user.email', 'agent-planner@example.invalid']);
  await mkdir(join(path, 'apps/api/src'), { recursive: true });
  await mkdir(join(path, 'docs'), { recursive: true });
  await writeFile(join(path, 'apps/api/src/old.ts'), 'old\n');
  await writeFile(join(path, 'docs/remove.md'), 'remove\n');
  await writeFile(join(path, 'README.md'), 'initial\n');
  git(path, ['add', '-A']);
  git(path, ['commit', '--quiet', '-m', 'initial']);
  return { path };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
