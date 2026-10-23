#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectGitChanges } from './git-changes.mjs';

function git(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function identity(repo) {
  const root = realpathSync(git(repo, ['rev-parse', '--show-toplevel']).trim());
  return {
    root,
    gitDir: realpathSync(git(root, ['rev-parse', '--absolute-git-dir']).trim()),
    branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
  };
}

function worktreeFile(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return {
      type: 'symlink',
      sha256: createHash('sha256').update(readlinkSync(path)).digest('hex'),
    };
  }
  if (!stat.isFile()) throw new Error(`Cannot fingerprint non-file worktree entry: ${path}`);
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (let count; (count = readSync(fd, buffer)) > 0; ) hash.update(buffer.subarray(0, count));
  } finally {
    closeSync(fd);
  }
  return { type: 'file', executable: Boolean(stat.mode & 0o111), sha256: hash.digest('hex') };
}

function fingerprint(root, path) {
  return {
    worktree: worktreeFile(resolve(root, path)),
    index: git(root, ['ls-files', '--stage', '-z', '--', `:(literal)${path}`]),
    head: git(root, ['ls-tree', '-z', 'HEAD', '--', `:(literal)${path}`]),
  };
}

export function captureTaskWorktree(repo) {
  const checkout = identity(repo);
  const changes = collectGitChanges({ cwd: checkout.root });
  return {
    schemaVersion: 1,
    checkout,
    revision: git(checkout.root, ['rev-parse', 'HEAD']).trim(),
    changes: changes.changes,
    files: Object.fromEntries(
      changes.changedPaths.map((path) => [path, fingerprint(checkout.root, path)]),
    ),
  };
}

function isWithin(root, path) {
  const suffix = relative(root, path);
  return (
    suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

function assertExternalState(checkout, statePath) {
  if (!isAbsolute(statePath))
    throw new Error('Task state needs an absolute path outside the checkout.');
  const canonical = resolve(realpathSync(dirname(statePath)), basename(statePath));
  const common = realpathSync(
    resolve(checkout.root, git(checkout.root, ['rev-parse', '--git-common-dir']).trim()),
  );
  if ([checkout.root, checkout.gitDir, common].some((root) => isWithin(root, canonical))) {
    throw new Error('Task state must stay outside the checkout and Git metadata.');
  }
}

export function startTaskWorktree(repo, statePath) {
  const snapshot = captureTaskWorktree(repo);
  assertExternalState(snapshot.checkout, statePath);
  writeFileSync(statePath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { inheritedPaths: Object.keys(snapshot.files) };
}

export function checkTaskWorktree(repo, statePath) {
  const checkout = identity(repo);
  assertExternalState(checkout, statePath);
  const snapshot = JSON.parse(readFileSync(statePath, 'utf8'));
  if (
    snapshot.schemaVersion !== 1 ||
    !snapshot.checkout ||
    typeof snapshot.revision !== 'string' ||
    !/^[a-f0-9]{40,64}$/u.test(snapshot.revision) ||
    !Array.isArray(snapshot.changes) ||
    !snapshot.files ||
    typeof snapshot.files !== 'object'
  )
    throw new Error('Invalid task worktree baseline. Keep the original start snapshot.');
  if (JSON.stringify(checkout) !== JSON.stringify(snapshot.checkout)) {
    throw new Error('Task baseline belongs to a different checkout or branch.');
  }
  try {
    git(checkout.root, ['merge-base', '--is-ancestor', snapshot.revision, 'HEAD']);
  } catch {
    throw new Error(
      'Task starting revision is no longer an ancestor of HEAD. Reconcile source history.',
    );
  }
  const current = collectGitChanges({ cwd: checkout.root });
  const inheritedPaths = Object.keys(snapshot.files);
  const inherited = new Set(inheritedPaths);
  const unfinished = current.changedPaths.filter((path) => !inherited.has(path));
  const altered = inheritedPaths.filter((path) => {
    const before = snapshot.changes.filter((change) => change.paths.includes(path));
    const after = current.changes.filter((change) => change.paths.includes(path));
    return (
      JSON.stringify(before) !== JSON.stringify(after) ||
      JSON.stringify(snapshot.files[path]) !== JSON.stringify(fingerprint(checkout.root, path))
    );
  });
  if (unfinished.length || altered.length) {
    throw new Error(
      [
        'Task worktree check failed; completion is not established.',
        ...unfinished.map((path) => `New unfinished change: ${path}`),
        ...altered.map((path) => `Inherited change altered or absorbed: ${path}`),
        'Preserve other work. Finish owned changes or report the exact unresolved paths; do not reset, stash or rebaseline to hide them.',
      ].join('\n'),
    );
  }
  return { inheritedPaths };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, statePath, ...extra] = process.argv.slice(2);
    if (!['start', 'check'].includes(command) || !statePath || extra.length) {
      throw new Error(
        'Usage: node scripts/agent/task-worktree.mjs <start|check> /absolute/task-state.json',
      );
    }
    const result =
      command === 'start'
        ? startTaskWorktree(process.cwd(), statePath)
        : checkTaskWorktree(process.cwd(), statePath);
    console.log(
      `${command === 'start' ? 'Baseline recorded' : 'Worktree reconciled'}: ${result.inheritedPaths.length} inherited paths.`,
    );
    if (command === 'check')
      console.log('This checks worktree preservation, not validation, CI or deployment.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
