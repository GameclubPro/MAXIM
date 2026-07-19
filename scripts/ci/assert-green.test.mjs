import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertGreenCheckRuns,
  findSuccessfulRequiredCheck,
  parseGitHubRepository,
  PRODUCTION_REQUIRED_CHECK,
} from './assert-green.mjs';

test('pins the production aggregate check name', () => {
  assert.equal(PRODUCTION_REQUIRED_CHECK, 'Required');
});

test('parses SSH and HTTPS GitHub remotes', () => {
  assert.equal(parseGitHubRepository('git@github.com:GameclubPro/MAXIM.git'), 'GameclubPro/MAXIM');
  assert.equal(
    parseGitHubRepository('https://github.com/GameclubPro/MAXIM.git'),
    'GameclubPro/MAXIM',
  );
});

test('requires an exact completed successful aggregate check', () => {
  const runs = [
    { name: 'Required', status: 'completed', conclusion: 'failure', completed_at: '2026-01-01' },
    { name: 'API', status: 'completed', conclusion: 'success', completed_at: '2026-01-02' },
    { name: 'Required', status: 'completed', conclusion: 'success', completed_at: '2026-01-03' },
  ];
  assert.equal(findSuccessfulRequiredCheck(runs).completed_at, '2026-01-03');
  assert.equal(assertGreenCheckRuns({ check_runs: runs }, 'abc').conclusion, 'success');
});

test('rejects missing, pending, and failed aggregate checks', () => {
  assert.throws(() => assertGreenCheckRuns({ check_runs: [] }, 'abc'), /not found/u);
  assert.throws(
    () =>
      assertGreenCheckRuns(
        { check_runs: [{ name: 'Required', status: 'in_progress', conclusion: null }] },
        'abc',
      ),
    /pending/u,
  );
});
