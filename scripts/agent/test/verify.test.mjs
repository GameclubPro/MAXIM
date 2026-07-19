import assert from 'node:assert/strict';
import test from 'node:test';

import { parseVerifyArgs, selectVerificationScripts } from '../verify.mjs';

const config = {
  checkById: {
    'repo-static': { id: 'repo-static', script: 'check:static' },
    api: { id: 'api', script: 'check:api' },
    full: { id: 'full', script: 'check' },
  },
};

test('selects mapped checks in plan order', () => {
  assert.deepEqual(
    selectVerificationScripts({
      config,
      plan: { checks: ['repo-static', 'api'] },
    }),
    [
      { id: 'repo-static', script: 'check:static' },
      { id: 'api', script: 'check:api' },
    ],
  );
});

test('full check supersedes narrower checks', () => {
  assert.deepEqual(
    selectVerificationScripts({
      config,
      plan: { checks: ['repo-static', 'api', 'full'] },
    }),
    [{ id: 'full', script: 'check' }],
  );
  assert.deepEqual(selectVerificationScripts({ config, plan: null, full: true }), [
    { id: 'full', script: 'check' },
  ]);
});

test('parses full and dry-run modes without weakening range validation', () => {
  assert.equal(parseVerifyArgs(['--full', '--dry-run']).full, true);
  assert.throws(() => parseVerifyArgs(['--full', '--staged']), /cannot be combined/u);
  assert.equal(parseVerifyArgs(['--base', 'main', '--head', 'HEAD']).mode, 'range');
});

test('rejects a check without an executable script mapping', () => {
  assert.throws(
    () => selectVerificationScripts({ config, plan: { checks: ['docs'] } }),
    /has no npm script mapping/u,
  );
});
