import { execFileSync } from 'node:child_process';

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export function collectGitChanges({ cwd = process.cwd(), mode = 'worktree', base, head } = {}) {
  const repoRoot = runGitText(cwd, ['rev-parse', '--show-toplevel']).trim();

  if (mode === 'worktree') {
    assertMissingRefOptions(mode, base, head);
    const output = runGitBuffer(repoRoot, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--find-renames',
    ]);
    return buildChangeSet(repoRoot, mode, parsePorcelainV1Z(output), null, null);
  }

  if (mode === 'staged') {
    assertMissingRefOptions(mode, base, head);
    const output = runGitBuffer(repoRoot, [
      'diff',
      '--cached',
      '--name-status',
      '-z',
      '--find-renames',
      '--diff-filter=ACDMRTUXB',
      'HEAD',
    ]);
    return buildChangeSet(repoRoot, mode, parseNameStatusZ(output), 'HEAD', 'INDEX');
  }

  if (mode === 'range') {
    if (!base || !head) {
      throw new Error('Range mode requires both base and head Git refs.');
    }
    const resolvedBase = runGitText(repoRoot, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${base}^{commit}`,
    ]).trim();
    const resolvedHead = runGitText(repoRoot, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${head}^{commit}`,
    ]).trim();
    const output = runGitBuffer(repoRoot, [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      '--diff-filter=ACDMRTUXB',
      resolvedBase,
      resolvedHead,
    ]);
    return buildChangeSet(repoRoot, mode, parseNameStatusZ(output), resolvedBase, resolvedHead);
  }

  throw new Error(`Unsupported Git change mode: ${mode}.`);
}

export function parseNameStatusZ(output) {
  const tokens = splitNullTokens(output);
  const changes = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index];
    index += 1;
    if (!status) {
      continue;
    }
    const kind = status[0];
    if (!kind || !'ACDMRTUXB'.includes(kind)) {
      throw new Error(`Unsupported Git name-status token: ${JSON.stringify(status)}.`);
    }
    if (kind === 'R' || kind === 'C') {
      const oldPath = requireToken(tokens, index, status);
      const newPath = requireToken(tokens, index + 1, status);
      index += 2;
      changes.push({ status, oldPath, newPath, paths: [oldPath, newPath] });
      continue;
    }
    const path = requireToken(tokens, index, status);
    index += 1;
    changes.push({ status, path, paths: [path] });
  }
  return sortChanges(changes);
}

export function parsePorcelainV1Z(output) {
  const tokens = splitNullTokens(output);
  const changes = [];
  for (let index = 0; index < tokens.length; ) {
    const record = tokens[index];
    index += 1;
    if (!record) {
      continue;
    }
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error(`Unsupported Git porcelain record: ${JSON.stringify(record)}.`);
    }
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) {
      throw new Error(`Git porcelain record has no path: ${JSON.stringify(record)}.`);
    }
    const renamedOrCopied = /[RC]/u.test(status);
    if (renamedOrCopied) {
      const oldPath = requireToken(tokens, index, status);
      index += 1;
      changes.push({ status, oldPath, newPath: path, paths: [oldPath, path] });
      continue;
    }
    changes.push({ status, path, paths: [path] });
  }
  return sortChanges(changes);
}

function buildChangeSet(repoRoot, mode, changes, base, head) {
  const changedPaths = [...new Set(changes.flatMap((change) => change.paths))].sort(compareText);
  return Object.freeze({
    repoRoot,
    source: Object.freeze({ mode, base, head }),
    changes: Object.freeze(
      changes.map((change) => Object.freeze({ ...change, paths: [...change.paths] })),
    ),
    changedPaths: Object.freeze(changedPaths),
  });
}

function runGitBuffer(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'buffer',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = Buffer.isBuffer(error.stderr)
      ? error.stderr.toString('utf8').trim()
      : String(error.stderr ?? error.message).trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : '.'}`, {
      cause: error,
    });
  }
}

function runGitText(cwd, args) {
  return runGitBuffer(cwd, args).toString('utf8');
}

function splitNullTokens(output) {
  const value = Buffer.isBuffer(output) ? output.toString('utf8') : String(output);
  const tokens = value.split('\0');
  if (tokens.at(-1) === '') {
    tokens.pop();
  }
  return tokens;
}

function requireToken(tokens, index, status) {
  const value = tokens[index];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Git ${status} record is missing a path.`);
  }
  return value;
}

function sortChanges(changes) {
  return changes.sort((left, right) => {
    const pathOrder = compareText(left.paths[0], right.paths[0]);
    if (pathOrder !== 0) {
      return pathOrder;
    }
    const secondPathOrder = compareText(left.paths[1] ?? '', right.paths[1] ?? '');
    return secondPathOrder || compareText(left.status, right.status);
  });
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertMissingRefOptions(mode, base, head) {
  if (base || head) {
    throw new Error(`${mode} mode does not accept base/head refs.`);
  }
}
