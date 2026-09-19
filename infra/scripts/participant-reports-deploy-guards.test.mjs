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
  for (const variant of ['current', 'missing', 'legacy']) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `
      source "$MAXIM_TEST_ROOT/infra/scripts/lib/deploy-topology.sh"
      git() {
        if [[ "$MAXIM_TEST_MISSING" == 1 || "$1" != show ]]; then return 1; fi
        local source_path="\${2#*:}"
        if [[ "$MAXIM_TEST_LEGACY" == 1 ]]; then
          sed 's/BINDING_VERSION = 2/BINDING_VERSION = 1/' "$MAXIM_TEST_ROOT/$source_path"
        else
          cat "$MAXIM_TEST_ROOT/$source_path"
        fi
      }
      maxim_topology_require_participant_report_guard target
    `,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          MAXIM_TEST_ROOT: root,
          MAXIM_TEST_MISSING: variant === 'missing' ? '1' : '0',
          MAXIM_TEST_LEGACY: variant === 'legacy' ? '1' : '0',
        },
        encoding: 'utf8',
      },
    );
    if (variant !== 'current') assert.notEqual(result.status, 0);
    else assert.equal(result.status, 0, result.stderr);
  }
});
