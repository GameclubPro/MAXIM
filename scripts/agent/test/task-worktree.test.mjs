import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { checkTaskWorktree, startTaskWorktree } from '../task-worktree.mjs';

const scriptPath = resolve(import.meta.dirname, '../task-worktree.mjs');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-task-worktree-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'pipe' });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'core.filemode', 'true');
  const write = (path, content) => writeFileSync(join(repo, path), content);
  const commit = (message, ...args) =>
    git(
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      message,
      ...args,
    );
  write('source.ts', 'original source\n');
  write('staged.ts', 'original staged source\n');
  write('guide.md', 'original guide\n');
  git('add', '.');
  commit('initial');
  return { directory, repo, statePath: join(directory, 'state.json'), git, write, commit };
}

test('unchanged inherited staged, unstaged and untracked work remains allowed', async (t) => {
  const { repo, statePath, git, write } = fixture(t);
  write('source.ts', 'inherited unstaged source\n');
  write('staged.ts', 'inherited staged source\n');
  git('add', 'staged.ts');
  write('inherited note.md', 'private inherited untracked note\n');
  await startTaskWorktree(repo, statePath);

  const result = await checkTaskWorktree(repo, statePath);
  assert.deepEqual(result.inheritedPaths, ['inherited note.md', 'source.ts', 'staged.ts']);
  const snapshot = readFileSync(statePath, 'utf8');
  assert.doesNotMatch(
    snapshot,
    /inherited unstaged source|inherited staged source|private inherited/u,
  );
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
});

test('new uncommitted documentation and code cannot pass completion', async (t) => {
  for (const path of ['unfinished.md', 'unfinished.ts']) {
    await t.test(path, async (subtest) => {
      const { repo, statePath, write } = fixture(subtest);
      await startTaskWorktree(repo, statePath);
      write(path, 'unfinished work\n');
      await assert.rejects(async () => checkTaskWorktree(repo, statePath), /unfinished/u);
    });
  }
});

test('completed own commits are allowed while inherited work stays unchanged', async (t) => {
  const { repo, statePath, write, git, commit } = fixture(t);
  write('source.ts', 'inherited work\n');
  await startTaskWorktree(repo, statePath);
  write('guide.md', 'completed own documentation\n');
  git('add', 'guide.md');
  commit('finish own work');

  assert.deepEqual((await checkTaskWorktree(repo, statePath)).inheritedPaths, ['source.ts']);
});

test('same-status edits to inherited bytes cannot pass completion', async (t) => {
  const { repo, statePath, write, git } = fixture(t);
  write('source.ts', 'inherited work\n');
  await startTaskWorktree(repo, statePath);
  const status = git('status', '--porcelain=v1').toString();
  write('source.ts', 'overwritten work\n');
  assert.equal(git('status', '--porcelain=v1').toString(), status);
  await assert.rejects(async () => checkTaskWorktree(repo, statePath), /source\.ts/u);
});

test('literal filename resembling a Git pathspec is preserved and edits are detected', async (t) => {
  const { repo, statePath, write, git, commit } = fixture(t);
  const path = ':(glob)*.md';
  write(path, 'original literal filename\n');
  git('--literal-pathspecs', 'add', '--', path);
  commit('add literal filename');
  write(path, 'inherited literal filename\n');
  await startTaskWorktree(repo, statePath);
  assert.deepEqual((await checkTaskWorktree(repo, statePath)).inheritedPaths, [path]);
  write(path, 'changed literal filename\n');
  await assert.rejects(async () => checkTaskWorktree(repo, statePath), /:\(glob\)\*\.md/u);
});

test('same-status index edits to inherited staged work cannot pass completion', async (t) => {
  const { repo, statePath, write, git } = fixture(t);
  write('staged.ts', 'inherited staged work\n');
  git('add', 'staged.ts');
  await startTaskWorktree(repo, statePath);
  const status = git('status', '--porcelain=v1').toString();
  write('staged.ts', 'replaced staged work\n');
  git('add', 'staged.ts');
  assert.equal(git('status', '--porcelain=v1').toString(), status);
  await assert.rejects(async () => checkTaskWorktree(repo, statePath), /staged\.ts/u);
});

test('staging inherited unstaged work cannot pass completion', async (t) => {
  const { repo, statePath, write, git } = fixture(t);
  write('source.ts', 'inherited work\n');
  await startTaskWorktree(repo, statePath);
  git('add', 'source.ts');
  await assert.rejects(async () => checkTaskWorktree(repo, statePath), /source\.ts/u);
});

test('removing inherited tracked or untracked work cannot pass completion', async (t) => {
  for (const path of ['source.ts', 'inherited.md']) {
    await t.test(path, async (subtest) => {
      const { repo, statePath, write } = fixture(subtest);
      write(path, 'inherited work\n');
      await startTaskWorktree(repo, statePath);
      rmSync(join(repo, path));
      await assert.rejects(
        async () => checkTaskWorktree(repo, statePath),
        /source\.ts|inherited\.md/u,
      );
    });
  }
});

test('committing inherited work cannot turn it into completed own work', async (t) => {
  const { repo, statePath, write, git, commit } = fixture(t);
  write('source.ts', 'inherited work\n');
  await startTaskWorktree(repo, statePath);
  git('add', 'source.ts');
  commit('incorrectly absorb inherited work');
  await assert.rejects(async () => checkTaskWorktree(repo, statePath), /source\.ts/u);
});

test('changed inherited HEAD records fail even when dirty status, index and bytes are restored', async (t) => {
  const { repo, statePath, write, git, commit } = fixture(t);
  write('source.ts', 'inherited staged work\n');
  git('add', 'source.ts');
  const inheritedIndexBlob = git('rev-parse', ':source.ts').toString().trim();
  write('source.ts', 'inherited unstaged work\n');
  await startTaskWorktree(repo, statePath);
  const status = git('status', '--porcelain=v1').toString();

  write('source.ts', 'committed replacement\n');
  git('add', 'source.ts');
  commit('replace inherited source');
  git('update-index', '--cacheinfo', `100644,${inheritedIndexBlob},source.ts`);
  write('source.ts', 'inherited unstaged work\n');
  assert.equal(git('status', '--porcelain=v1').toString(), status);
  await assert.rejects(async () => checkTaskWorktree(repo, statePath), /source\.ts/u);
});

test('inherited staged rename preserves both paths and rejects later edits', async (t) => {
  const { repo, statePath, write, git } = fixture(t);
  git('mv', 'source.ts', 'renamed source.ts');
  await startTaskWorktree(repo, statePath);
  assert.deepEqual((await checkTaskWorktree(repo, statePath)).inheritedPaths, [
    'renamed source.ts',
    'source.ts',
  ]);
  write('renamed source.ts', 'changed renamed work\n');
  await assert.rejects(async () => checkTaskWorktree(repo, statePath), /renamed source\.ts/u);
});

test('inherited executable mode changes cannot pass completion', async (t) => {
  const { repo, statePath, write } = fixture(t);
  write('source.ts', 'inherited work\n');
  chmodSync(join(repo, 'source.ts'), 0o644);
  await startTaskWorktree(repo, statePath);
  chmodSync(join(repo, 'source.ts'), 0o755);
  await assert.rejects(async () => checkTaskWorktree(repo, statePath), /source\.ts/u);
});

test('replacing inherited file with a symlink cannot pass completion', async (t) => {
  const { repo, statePath, write } = fixture(t);
  write('inherited.md', 'guide.md');
  await startTaskWorktree(repo, statePath);
  rmSync(join(repo, 'inherited.md'));
  symlinkSync('guide.md', join(repo, 'inherited.md'));
  await assert.rejects(async () => checkTaskWorktree(repo, statePath), /inherited\.md/u);
});

test('baseline belongs to one checkout and branch', async (t) => {
  const first = fixture(t);
  const second = fixture(t);
  await startTaskWorktree(first.repo, first.statePath);
  await assert.rejects(
    async () => checkTaskWorktree(second.repo, first.statePath),
    /checkout|repository/u,
  );
  first.git('switch', '-c', 'different-branch');
  await assert.rejects(
    async () => checkTaskWorktree(first.repo, first.statePath),
    /branch|checkout/u,
  );
});

test('same-branch clean rewind before the baseline revision cannot pass completion', async (t) => {
  const { repo, statePath, write, git, commit } = fixture(t);
  write('guide.md', 'second committed guide\n');
  git('add', 'guide.md');
  commit('second baseline commit');
  const parent = git('rev-parse', 'HEAD^').toString().trim();
  await startTaskWorktree(repo, statePath);
  assert.deepEqual((await checkTaskWorktree(repo, statePath)).inheritedPaths, []);

  git('update-ref', 'HEAD', parent);
  git('read-tree', '--reset', '-u', parent);
  assert.equal(git('status', '--porcelain=v1').toString(), '');
  await assert.rejects(
    async () => checkTaskWorktree(repo, statePath),
    /ancestor|history|revision|rewind/u,
  );
});

test('starting again cannot overwrite a private baseline', async (t) => {
  const { repo, statePath, write } = fixture(t);
  await startTaskWorktree(repo, statePath);
  const original = readFileSync(statePath, 'utf8');
  write('unfinished.md', 'new work\n');
  await assert.rejects(async () => startTaskWorktree(repo, statePath), /exist|overwrite/u);
  assert.equal(readFileSync(statePath, 'utf8'), original);
});

test('baseline paths inside the checkout are rejected, including a symlink parent', async (t) => {
  const { directory, repo } = fixture(t);
  await assert.rejects(
    async () => startTaskWorktree(repo, join(repo, 'state.json')),
    /outside|checkout/u,
  );
  const linkedParent = join(directory, 'linked-repo');
  symlinkSync(repo, linkedParent, 'dir');
  await assert.rejects(
    async () => startTaskWorktree(repo, join(linkedParent, 'state.json')),
    /outside|checkout/u,
  );
});

test('CLI starts and checks from cwd and returns nonzero for unfinished work', (t) => {
  const { repo, statePath, write } = fixture(t);
  const run = (command) =>
    spawnSync(process.execPath, [scriptPath, command, statePath], {
      cwd: repo,
      encoding: 'utf8',
    });
  const started = run('start');
  assert.equal(started.status, 0, started.stderr);
  const checked = run('check');
  assert.equal(checked.status, 0, checked.stderr);
  write('unfinished.md', 'unfinished work\n');
  const unfinished = run('check');
  assert.notEqual(unfinished.status, 0);
  assert.match(`${unfinished.stdout}${unfinished.stderr}`, /unfinished\.md/u);
});
