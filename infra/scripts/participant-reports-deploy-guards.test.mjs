import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
test('both rollback paths require guarded participant report execution', () => {
  for (const file of ['vps-release-rollback.sh', 'vps-runtime-rollback.sh']) {
    assert.match(
      readFileSync(resolve(root, 'infra/scripts', file), 'utf8'),
      /maxim_topology_require_participant_report_guard/u,
    );
  }
  for (const missing of [false, true]) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `
      source "$MAXIM_TEST_ROOT/infra/scripts/lib/deploy-topology.sh"
      git() {
        if [[ "$MAXIM_TEST_MISSING" == 1 || "$1" != show ]]; then return 1; fi
        local source_path="\${2#*:}"
        cat "$MAXIM_TEST_ROOT/$source_path"
      }
      maxim_topology_require_participant_report_guard target
    `,
      ],
      {
        cwd: root,
        env: { ...process.env, MAXIM_TEST_ROOT: root, MAXIM_TEST_MISSING: missing ? '1' : '0' },
        encoding: 'utf8',
      },
    );
    if (missing) assert.notEqual(result.status, 0);
    else assert.equal(result.status, 0, result.stderr);
  }
});
