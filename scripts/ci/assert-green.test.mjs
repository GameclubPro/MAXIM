import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertGreenCheckRuns,
  findLatestRequiredCheck,
  GITHUB_ACTIONS_APP_ID,
  parseGitHubRepository,
  PRODUCTION_REQUIRED_CHECK,
  PRODUCTION_REQUIRED_CHECKS,
} from './assert-green.mjs';

const exactSha = 'a'.repeat(40);

function checkRun(name, overrides = {}) {
  return {
    id: 1,
    name,
    head_sha: exactSha,
    app: { id: GITHUB_ACTIONS_APP_ID },
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-01T00:01:00Z',
    ...overrides,
  };
}

test('pins the production aggregate and CodeQL checks to GitHub Actions', () => {
  assert.equal(PRODUCTION_REQUIRED_CHECK, 'Required');
  assert.deepEqual(PRODUCTION_REQUIRED_CHECKS, [
    { name: 'Required', appId: GITHUB_ACTIONS_APP_ID },
    { name: 'Analyze JavaScript and TypeScript', appId: GITHUB_ACTIONS_APP_ID },
  ]);
});

test('parses SSH and HTTPS GitHub remotes', () => {
  assert.equal(parseGitHubRepository('git@github.com:GameclubPro/MAXIM.git'), 'GameclubPro/MAXIM');
  assert.equal(
    parseGitHubRepository('https://github.com/GameclubPro/MAXIM.git'),
    'GameclubPro/MAXIM',
  );
});

test('requires exact completed successful aggregate and CodeQL checks', () => {
  const runs = [checkRun('Required'), checkRun('Analyze JavaScript and TypeScript', { id: 2 })];
  assert.equal(
    findLatestRequiredCheck(runs, exactSha, PRODUCTION_REQUIRED_CHECKS[1]).name,
    'Analyze JavaScript and TypeScript',
  );
  assert.deepEqual(
    assertGreenCheckRuns({ check_runs: runs }, exactSha).map((run) => run.name),
    ['Required', 'Analyze JavaScript and TypeScript'],
  );
});

test('rejects missing CodeQL and checks from the wrong app or commit', () => {
  assert.throws(
    () => assertGreenCheckRuns({ check_runs: [checkRun('Required')] }, exactSha),
    /Analyze JavaScript and TypeScript.*not found/u,
  );
  assert.throws(
    () =>
      assertGreenCheckRuns(
        {
          check_runs: [
            checkRun('Required'),
            checkRun('Analyze JavaScript and TypeScript', { app: { id: 1 } }),
          ],
        },
        exactSha,
      ),
    /app=1/u,
  );
  assert.throws(
    () =>
      assertGreenCheckRuns(
        {
          check_runs: [
            checkRun('Required'),
            checkRun('Analyze JavaScript and TypeScript', { head_sha: 'b'.repeat(40) }),
          ],
        },
        exactSha,
      ),
    /head=b+/u,
  );
});

test('rejects every non-success terminal or pending state', () => {
  for (const [status, conclusion] of [
    ['in_progress', null],
    ['completed', 'failure'],
    ['completed', 'cancelled'],
    ['completed', 'skipped'],
  ]) {
    assert.throws(
      () =>
        assertGreenCheckRuns(
          {
            check_runs: [
              checkRun('Required'),
              checkRun('Analyze JavaScript and TypeScript', { status, conclusion }),
            ],
          },
          exactSha,
        ),
      new RegExp(`${status}/${conclusion ?? 'pending'}`, 'u'),
    );
  }
});

test('a newer failed rerun overrides an older successful check', () => {
  const codeql = 'Analyze JavaScript and TypeScript';
  assert.throws(
    () =>
      assertGreenCheckRuns(
        {
          check_runs: [
            checkRun('Required'),
            checkRun(codeql, { id: 2 }),
            checkRun(codeql, {
              id: 3,
              status: 'completed',
              conclusion: 'failure',
              started_at: '2026-01-02T00:00:00Z',
            }),
          ],
        },
        exactSha,
      ),
    /completed\/failure/u,
  );
});
