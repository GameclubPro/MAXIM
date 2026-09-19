import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { parseVerifyArgs, selectVerificationScripts } from '../verify.mjs';

const config = {
  checkById: {
    'repo-static': { id: 'repo-static', script: 'check:static' },
    api: { id: 'api', script: 'check:api' },
    full: { id: 'full', script: 'check' },
    'agent-tools': { id: 'agent-tools', script: 'test:agent-tools' },
    miniapp: { id: 'miniapp', script: 'check:miniapp' },
    'miniapp-css': { id: 'miniapp-css', script: 'check:miniapp-css' },
    'miniapp-visual-local': { id: 'miniapp-visual-local', script: 'screenshots:miniapp:smoke' },
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

test('full check supersedes narrower checks but retains the browser smoke', () => {
  assert.deepEqual(
    selectVerificationScripts({
      config,
      plan: { checks: ['repo-static', 'api', 'full'] },
    }),
    [
      { id: 'full', script: 'check' },
      { id: 'miniapp-visual-local', script: 'screenshots:miniapp:smoke' },
    ],
  );
  assert.deepEqual(selectVerificationScripts({ config, plan: null, full: true }), [
    { id: 'full', script: 'check' },
    { id: 'miniapp-visual-local', script: 'screenshots:miniapp:smoke' },
  ]);
});

test('deduplicates only checks guaranteed by the current aggregate npm scripts', () => {
  const scripts = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ).scripts;
  for (const [aggregate, nested] of [
    ['check:static', 'test:agent-tools'],
    ['check:miniapp', 'check:miniapp-css'],
  ]) {
    assert.ok(scripts[aggregate].split(/\s*&&\s*/u).includes(`npm run ${nested}`));
  }
  assert.deepEqual(
    selectVerificationScripts({
      config,
      plan: {
        checks: ['repo-static', 'agent-tools', 'miniapp-css', 'miniapp', 'miniapp-visual-local'],
      },
    }).map((check) => check.id),
    ['repo-static', 'miniapp', 'miniapp-visual-local'],
  );
  assert.deepEqual(
    selectVerificationScripts({ config, plan: { checks: ['agent-tools', 'miniapp-css'] } }).map(
      (check) => check.id,
    ),
    ['agent-tools', 'miniapp-css'],
  );
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
