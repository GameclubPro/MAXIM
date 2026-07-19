#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRODUCTION_REQUIRED_CHECK = 'Required';

export function parseGitHubRepository(remoteUrl) {
  const match = String(remoteUrl)
    .trim()
    .match(/github\.com(?::|\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u);
  if (!match) {
    throw new Error(`Cannot derive a GitHub repository from origin URL: ${remoteUrl}`);
  }
  return `${match[1]}/${match[2]}`;
}

export function findSuccessfulRequiredCheck(checkRuns, requiredName = 'Required') {
  return checkRuns
    .filter((run) => run.name === requiredName && run.status === 'completed')
    .sort((left, right) => String(right.completed_at).localeCompare(String(left.completed_at)))
    .find((run) => run.conclusion === 'success');
}

export function assertGreenCheckRuns(payload, sha, requiredName = 'Required') {
  const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
  const successful = findSuccessfulRequiredCheck(runs, requiredName);
  if (successful) {
    return successful;
  }

  const matching = runs.filter((run) => run.name === requiredName);
  const detail = matching.length
    ? matching.map((run) => `${run.status}/${run.conclusion ?? 'pending'}`).join(', ')
    : 'not found';
  throw new Error(`Commit ${sha} does not have a successful ${requiredName} check (${detail}).`);
}

export function assertCommitHasGreenCi({ cwd = process.cwd(), sha, requiredName = 'Required' }) {
  const exactSha = execFileSync(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`],
    { cwd, encoding: 'utf8' },
  ).trim();
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd,
    encoding: 'utf8',
  });
  const repository = process.env.GITHUB_REPOSITORY || parseGitHubRepository(remote);
  const payload = JSON.parse(
    execFileSync(
      'gh',
      [
        'api',
        '--method',
        'GET',
        `repos/${repository}/commits/${exactSha}/check-runs`,
        '-f',
        'per_page=100',
      ],
      { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  const check = assertGreenCheckRuns(payload, exactSha, requiredName);
  return { repository, sha: exactSha, check };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cwd = resolve(process.cwd());
  const sha = process.argv[2] || 'HEAD';
  const requiredName = PRODUCTION_REQUIRED_CHECK;
  try {
    const result = assertCommitHasGreenCi({ cwd, sha, requiredName });
    process.stdout.write(
      `Verified ${requiredName} for ${result.repository}@${result.sha}: ${result.check.html_url ?? 'success'}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
