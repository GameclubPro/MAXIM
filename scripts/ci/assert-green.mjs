#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const GITHUB_ACTIONS_APP_ID = 15368;
export const PRODUCTION_REQUIRED_CHECK = 'Required';
export const PRODUCTION_REQUIRED_CHECKS = Object.freeze([
  Object.freeze({ name: PRODUCTION_REQUIRED_CHECK, appId: GITHUB_ACTIONS_APP_ID }),
  Object.freeze({ name: 'Analyze JavaScript and TypeScript', appId: GITHUB_ACTIONS_APP_ID }),
]);

export function parseGitHubRepository(remoteUrl) {
  const match = String(remoteUrl)
    .trim()
    .match(/github\.com(?::|\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u);
  if (!match) {
    throw new Error(`Cannot derive a GitHub repository from origin URL: ${remoteUrl}`);
  }
  return `${match[1]}/${match[2]}`;
}

export function findLatestRequiredCheck(checkRuns, sha, requiredCheck) {
  return checkRuns
    .filter(
      (run) =>
        run.name === requiredCheck.name &&
        run.head_sha === sha &&
        Number(run.app?.id) === requiredCheck.appId,
    )
    .sort((left, right) => {
      const idOrder = Number(right.id ?? 0) - Number(left.id ?? 0);
      if (idOrder !== 0) {
        return idOrder;
      }
      const startedOrder = String(right.started_at ?? '').localeCompare(
        String(left.started_at ?? ''),
      );
      return startedOrder;
    })[0];
}

export function assertGreenCheckRuns(payload, sha, requiredChecks = PRODUCTION_REQUIRED_CHECKS) {
  const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
  const verified = [];

  for (const requiredCheck of requiredChecks) {
    const latest = findLatestRequiredCheck(runs, sha, requiredCheck);
    if (latest?.status === 'completed' && latest.conclusion === 'success') {
      verified.push(latest);
      continue;
    }

    const named = runs.filter((run) => run.name === requiredCheck.name);
    const detail = latest
      ? `${latest.status}/${latest.conclusion ?? 'pending'}`
      : named.length
        ? named
            .map(
              (run) =>
                `head=${run.head_sha ?? 'unknown'} app=${run.app?.id ?? 'unknown'} ${run.status}/${run.conclusion ?? 'pending'}`,
            )
            .join(', ')
        : 'not found';
    throw new Error(
      `Commit ${sha} does not have a successful ${requiredCheck.name} check from app ${requiredCheck.appId} (${detail}).`,
    );
  }

  return verified;
}

export function assertCommitHasGreenCi({
  cwd = process.cwd(),
  sha,
  requiredChecks = PRODUCTION_REQUIRED_CHECKS,
}) {
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
  const checks = assertGreenCheckRuns(payload, exactSha, requiredChecks);
  return { repository, sha: exactSha, checks };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cwd = resolve(process.cwd());
  const sha = process.argv[2] || 'HEAD';
  try {
    const result = assertCommitHasGreenCi({ cwd, sha });
    const names = result.checks.map((check) => check.name).join(', ');
    const urls = result.checks.map((check) => check.html_url ?? 'success').join(', ');
    process.stdout.write(`Verified ${names} for ${result.repository}@${result.sha}: ${urls}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
