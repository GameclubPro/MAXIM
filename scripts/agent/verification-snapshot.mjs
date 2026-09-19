import { execFileSync } from 'node:child_process';
import { collectGitChanges } from './git-changes.mjs';

function git(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

export function assertStagedWorktreeMatches(repo) {
  const staged = collectGitChanges({ cwd: repo, mode: 'staged' });
  const selected = new Set(staged.changedPaths);
  const worktree = collectGitChanges({ cwd: repo });
  const conflicts = worktree.changes.filter((change) => {
    const hasUnstagedChanges = change.status === '??' || change.status[1] !== ' ';
    return (
      hasUnstagedChanges && change.paths.some((path) => selected.has(path) || !path.endsWith('.md'))
    );
  });
  if (conflicts.length) {
    throw new Error(
      `Staged verification would test different worktree inputs. Stage the intended versions or use a separate clean worktree:\n${conflicts.flatMap((change) => change.paths).join('\n')}`,
    );
  }
  return git(repo, ['write-tree']);
}

export function assertStagedSnapshotUnchanged(repo, tree) {
  const currentTree = assertStagedWorktreeMatches(repo);
  if (currentTree !== tree)
    throw new Error('The Git index changed during verification. Run verification again.');
}
