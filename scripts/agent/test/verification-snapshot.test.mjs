import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertStagedSnapshotUnchanged,
  assertStagedWorktreeMatches,
} from '../verification-snapshot.mjs';

function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), 'maxim-verification-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  const write = (path, content) => writeFileSync(join(repo, path), content);
  write('source.ts', 'original');
  write('other.ts', 'unchanged');
  write('AGENTS.md', 'notes');
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'initial');
  write('source.ts', 'staged');
  git('add', 'source.ts');
  return { repo, write, git };
}

test('staged verification allows unrelated notes, not partially staged code or other runtime drift', (t) => {
  const { repo, write } = fixture(t);
  write('AGENTS.md', 'user notes');
  write('incident.md', 'user incident');
  const tree = assertStagedWorktreeMatches(repo);
  assertStagedSnapshotUnchanged(repo, tree);
  write('source.ts', 'not staged');
  assert.throws(() => assertStagedWorktreeMatches(repo), /source\.ts/u);
  write('source.ts', 'staged');
  write('other.ts', 'not staged');
  assert.throws(() => assertStagedWorktreeMatches(repo), /other\.ts/u);
});

test('untracked code and changed staged documentation cannot contaminate checks', (t) => {
  const { repo, write, git } = fixture(t);
  write('new.ts', 'not staged');
  assert.throws(() => assertStagedWorktreeMatches(repo), /new\.ts/u);
  git('add', 'new.ts');
  write('guide.md', 'staged');
  git('add', 'guide.md');
  write('guide.md', 'changed');
  assert.throws(() => assertStagedWorktreeMatches(repo), /guide\.md/u);
});

test('index mutations during validation invalidate its result', (t) => {
  const { repo, write, git } = fixture(t);
  const tree = assertStagedWorktreeMatches(repo);
  write('source.ts', 'new staged version');
  git('add', 'source.ts');
  assert.throws(() => assertStagedSnapshotUnchanged(repo, tree), /index changed/u);
});
