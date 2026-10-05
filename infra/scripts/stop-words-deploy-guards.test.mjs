import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
function probe(missing, executorOverride = '') {
  return spawnSync(
    'bash',
    [
      '-c',
      `
    source "$MAXIM_TEST_ROOT/infra/scripts/lib/deploy-topology.sh"
    git() {
      if [[ "$MAXIM_TEST_MISSING" == 1 || "$1" != show ]]; then return 1; fi
      local source_path="\${2#*:}"
      if [[ "$source_path" == apps/api/src/moderation/moderation-delete-intent.service.ts && -n "$MAXIM_TEST_EXECUTOR_FILE" ]]; then
        cat "$MAXIM_TEST_EXECUTOR_FILE"
        return
      fi
      cat "$MAXIM_TEST_ROOT/$source_path"
    }
    maxim_topology_require_stop_words_policy_guard target
  `,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        MAXIM_TEST_ROOT: root,
        MAXIM_TEST_MISSING: missing ? '1' : '0',
        MAXIM_TEST_EXECUTOR_FILE: executorOverride,
      },
      encoding: 'utf8',
    },
  );
}

test('both rollback paths require the policy reader and current-message guard', () => {
  for (const file of ['vps-release-rollback.sh', 'vps-runtime-rollback.sh']) {
    assert.match(
      readFileSync(resolve(root, 'infra/scripts', file), 'utf8'),
      /maxim_topology_require_stop_words_policy_guard/u,
    );
  }
  const current = probe(false);
  assert.equal(current.status, 0, current.stderr);
  const legacy = probe(true);
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /predates the stop-word policy guard/u);
});

test('rollback rejects disconnected per-reason stop-word authorization', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'maxim-stopword-rollback-'));
  try {
    const source = readFileSync(
      resolve(root, 'apps/api/src/moderation/moderation-delete-intent.service.ts'),
      'utf8',
    );
    const call = 'this.stopWordsDeleteGuard!.authorizeIntent(params)';
    assert.ok(source.includes(call));
    const override = resolve(fixture, 'executor.ts');
    writeFileSync(override, source.replace(call, 'Promise.resolve({ reasonKeys: [] })'));
    assert.notEqual(probe(false, override).status, 0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
