import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
function probe(mode) {
  return spawnSync(
    'bash',
    [
      '-c',
      `
    source "$MAXIM_TEST_ROOT/infra/scripts/lib/deploy-topology.sh"
    git() {
      if [[ "$MAXIM_TEST_MODE" == missing || "$1" != show ]]; then return 1; fi
      local source_path="\${2#*:}"
      if [[ "$MAXIM_TEST_MODE" == major && "$source_path" == *moderation-delete-intent.service.ts ]] ||
        [[ "$MAXIM_TEST_MODE" == publisher && "$source_path" == *publisher-publication-post-actions.service.ts ]]; then
        sed s/assertDeletionAllowed/removedGuard/g "$MAXIM_TEST_ROOT/$source_path"
      else
        cat "$MAXIM_TEST_ROOT/$source_path"
      fi
    }
    maxim_topology_require_suggestion_subscription_guard target
  `,
    ],
    {
      cwd: root,
      env: { ...process.env, MAXIM_TEST_ROOT: root, MAXIM_TEST_MODE: mode },
      encoding: 'utf8',
    },
  );
}

test('both rollback paths preserve Major and Publik subscription deletion guards', () => {
  for (const file of ['vps-release-rollback.sh', 'vps-runtime-rollback.sh']) {
    assert.match(
      readFileSync(resolve(root, 'infra/scripts', file), 'utf8'),
      /maxim_topology_require_suggestion_subscription_guard/u,
    );
  }
  const current = probe('current');
  assert.equal(current.status, 0, current.stderr);
  for (const mode of ['missing', 'major', 'publisher']) assert.notEqual(probe(mode).status, 0);
});
