import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
function probe(missing) {
  return spawnSync(
    'bash',
    [
      '-c',
      `
    source "$MAXIM_TEST_ROOT/infra/scripts/lib/deploy-topology.sh"
    git() {
      if [[ "$MAXIM_TEST_MISSING" == 1 ]]; then return 1; fi
      if [[ "$1" != show ]]; then return 1; fi
      if [[ "$2" == *message-duplicate-delete-guard.service.ts ]]; then
        cat "$MAXIM_TEST_ROOT/apps/api/src/moderation/message-duplicate/message-duplicate-delete-guard.service.ts"
      else
        cat "$MAXIM_TEST_ROOT/apps/api/src/moderation/moderation-delete-intent.service.ts"
      fi
    }
    maxim_topology_require_message_duplicate_delete_guard target
  `,
    ],
    {
      cwd: root,
      env: { ...process.env, MAXIM_TEST_ROOT: root, MAXIM_TEST_MISSING: missing ? '1' : '0' },
      encoding: 'utf8',
    },
  );
}
test('requires the message-v1 current-content guard on both API rollback paths', () => {
  for (const file of ['vps-release-rollback.sh', 'vps-runtime-rollback.sh']) {
    assert.match(
      readFileSync(resolve(root, 'infra/scripts', file), 'utf8'),
      /maxim_topology_require_message_duplicate_delete_guard/u,
    );
  }
  const current = probe(false);
  assert.equal(current.status, 0, current.stderr);
  const legacy = probe(true);
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /predates the message duplicate delete guard/u);
});
