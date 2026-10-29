import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
function probe(mode, ai = false, pool = false) {
  return spawnSync(
    'bash',
    [
      '-c',
      `
    source "$MAXIM_TEST_ROOT/infra/scripts/lib/deploy-topology.sh"
    git() {
      if [[ "$MAXIM_TEST_MODE" == missing || "$1" != show ]]; then return 1; fi
      local source_path="\${2#*:}"
      if [[ "$MAXIM_TEST_MODE" == unwired && "$source_path" == *moderation-delete-intent.service.ts ]]; then
        sed s/commercialDeleteGuard/removedGuard/g "$MAXIM_TEST_ROOT/$source_path"
      elif [[ "$MAXIM_TEST_MODE" == old-authority && "$source_path" == *commercial-delete-guard.service.ts ]]; then
        sed s/assertAuthority/removedAuthority/g "$MAXIM_TEST_ROOT/$source_path"
      elif [[ "$MAXIM_TEST_MODE" == old-binding && "$source_path" == *commercial-delete-binding.ts ]]; then
        sed 's/BINDING_VERSION = 2/BINDING_VERSION = 1/g' "$MAXIM_TEST_ROOT/$source_path"
      elif [[ "$MAXIM_TEST_MODE" == ai-unwired && "$source_path" == *moderation-delete-intent.service.ts ]]; then
        sed s/commercialLlmGuard/removedGuard/g "$MAXIM_TEST_ROOT/$source_path"
      elif [[ "$MAXIM_TEST_MODE" == ai-no-proof && "$source_path" == *commercial-llm-delete-guard.service.ts ]]; then
        sed s/hasProof/removedProof/g "$MAXIM_TEST_ROOT/$source_path"
      elif [[ "$MAXIM_TEST_MODE" == ai-no-origin && "$source_path" == *commercial-llm-effect-origin.ts ]]; then
        return 1
      elif [[ "$MAXIM_TEST_MODE" == pool-no-v2 && "$source_path" == *commercial-llm-enforcement.protocol.ts ]]; then
        sed s/commercial-pool-v2/removed-pool-reader/g "$MAXIM_TEST_ROOT/$source_path"
      elif [[ "$MAXIM_TEST_MODE" == pool-no-v1 && "$source_path" == *commercial-llm-enforcement.protocol.ts ]]; then
        sed s/legacyCommercialLlmSourceSchema/removedLegacyReader/g "$MAXIM_TEST_ROOT/$source_path"
      else
        cat "$MAXIM_TEST_ROOT/$source_path"
      fi
    }
    ${pool ? 'maxim_topology_require_commercial_ai_pool_delete_reader' : ai ? 'maxim_topology_require_commercial_ai_delete_guard' : 'maxim_topology_require_commercial_text_delete_guard'} target
  `,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        MAXIM_TEST_ROOT: root,
        MAXIM_TEST_MODE: mode,
        COMMERCIAL_LLM_POOL_ENABLED: 'false',
      },
      encoding: 'utf8',
    },
  );
}
test('both API rollback paths require commercial binding and final dispatch guard', () => {
  for (const file of ['vps-release-rollback.sh', 'vps-runtime-rollback.sh'])
    assert.match(
      readFileSync(resolve(root, 'infra/scripts', file), 'utf8'),
      /maxim_topology_require_commercial_text_delete_guard/u,
    );
  const current = probe('current');
  assert.equal(current.status, 0, current.stderr);
  for (const mode of ['missing', 'unwired', 'old-authority', 'old-binding'])
    assert.notEqual(probe(mode).status, 0);
});

test('AI rollback floor retains fresh proof, original source and final dispatch wiring', () => {
  for (const file of ['vps-release-rollback.sh', 'vps-runtime-rollback.sh'])
    assert.match(
      readFileSync(resolve(root, 'infra/scripts', file), 'utf8'),
      /maxim_topology_require_commercial_ai_delete_guard/u,
    );
  const current = probe('current', true);
  assert.equal(current.status, 0, current.stderr);
  for (const mode of ['missing', 'ai-unwired', 'ai-no-proof', 'ai-no-origin'])
    assert.notEqual(probe(mode, true).status, 0);
});

test('both rollback paths and tooling bootstrap retain v1/v2 pool readers with routing disabled', () => {
  for (const file of ['vps-release-rollback.sh', 'vps-runtime-rollback.sh'])
    assert.match(
      readFileSync(resolve(root, 'infra/scripts', file), 'utf8'),
      /maxim_topology_require_commercial_ai_pool_delete_reader/u,
    );
  assert.match(
    readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8'),
    /maxim_topology_require_statistics_and_night_mode_recovery/u,
  );
  const current = probe('current', true, true);
  assert.equal(current.status, 0, current.stderr);
  for (const mode of ['pool-no-v2', 'pool-no-v1', 'ai-no-proof', 'ai-unwired'])
    assert.notEqual(probe(mode, true, true).status, 0);
});
