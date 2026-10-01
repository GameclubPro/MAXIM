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
  for (const variant of [
    'current',
    'missing',
    'legacy',
    'generic-dependent',
    'no-ownership',
    'first-only',
    'dormant-independent',
    'dormant-independent-helper',
    'archive-unversioned',
    'archive-missing-view',
    'archive-reopens',
    'archive-reveals-reporters',
    'archive-drops-cases',
    ...['Votes', 'Candidates', 'Deleted', 'Absent', 'Failed'].map((field) => `archive-no-${field}`),
  ]) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `
      source "$MAXIM_TEST_ROOT/infra/scripts/lib/deploy-topology.sh"
      git() {
        if [[ "$MAXIM_TEST_MISSING" == 1 || "$1" != show ]]; then return 1; fi
        local source_path="\${2#*:}"
        if [[ "$MAXIM_TEST_VARIANT" == archive-missing-view && "$source_path" == *report-view.service.ts ]]; then
          return 1
        elif [[ "$MAXIM_TEST_VARIANT" == archive-unversioned ]]; then
          sed 's/ARCHIVE_READER_VERSION = 1/ARCHIVE_READER_VERSION = 0/' "$MAXIM_TEST_ROOT/$source_path"
        elif [[ "$MAXIM_TEST_VARIANT" == archive-reopens ]]; then
          sed 's/if (current?.detailsArchivedAt)/if (false)/' "$MAXIM_TEST_ROOT/$source_path"
        elif [[ "$MAXIM_TEST_VARIANT" == archive-reveals-reporters ]]; then
          sed 's/const reporters = report.detailsArchivedAt/const reporters = false/' "$MAXIM_TEST_ROOT/$source_path"
        elif [[ "$MAXIM_TEST_VARIANT" == archive-drops-cases ]]; then
          sed 's/return reports.map((report) => {/return live.map((report) => {/' "$MAXIM_TEST_ROOT/$source_path"
        elif [[ "$MAXIM_TEST_VARIANT" == archive-no-* ]]; then
          sed "s/retained\${MAXIM_TEST_VARIANT#archive-no-}/missingRetainedTotal/g" "$MAXIM_TEST_ROOT/$source_path"
        elif [[ "$MAXIM_TEST_LEGACY" == 1 ]]; then
          sed 's/BINDING_VERSION = 3/BINDING_VERSION = 2/' "$MAXIM_TEST_ROOT/$source_path"
        elif [[ "$MAXIM_TEST_VARIANT" == generic-dependent ]]; then
          sed 's/if (intent.reportDeleteReason === true) return true;/if (false) return true;/' "$MAXIM_TEST_ROOT/$source_path"
        elif [[ "$MAXIM_TEST_VARIANT" == no-ownership ]]; then
          sed 's/counterMessageId: params.messageId/counterMessageId: "lost"/' "$MAXIM_TEST_ROOT/$source_path"
        elif [[ "$MAXIM_TEST_VARIANT" == first-only ]]; then
          sed 's/for (const reason of reportReasons)/for (const reason of reportReasons.slice(0, 1))/' "$MAXIM_TEST_ROOT/$source_path"
        elif [[ "$MAXIM_TEST_VARIANT" == dormant-independent ]]; then
          sed 's/params.isIndependentReasonExecutable?.(independentReasons)/true/' "$MAXIM_TEST_ROOT/$source_path"
        elif [[ "$MAXIM_TEST_VARIANT" == dormant-independent-helper ]]; then
          sed 's/this.getRolloutForInput({/this.dormantAuthority({/' "$MAXIM_TEST_ROOT/$source_path"
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
          MAXIM_TEST_VARIANT: variant,
          MAXIM_TEST_MISSING: variant === 'missing' ? '1' : '0',
          MAXIM_TEST_LEGACY: variant === 'legacy' ? '1' : '0',
          PARTICIPANT_REPORTS_DETAIL_RETENTION_ENABLED: 'false',
        },
        encoding: 'utf8',
      },
    );
    if (variant !== 'current') {
      assert.notEqual(result.status, 0, variant);
      if (variant.startsWith('archive-')) assert.match(result.stderr, /archive/u, variant);
    } else assert.equal(result.status, 0, result.stderr);
  }
});
