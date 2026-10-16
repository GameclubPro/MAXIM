import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
test('both rollback paths require guarded participant report execution', (t) => {
  const diagnosticsDir = mkdtempSync(resolve(tmpdir(), 'maxim-report-guard-'));
  t.after(() => rmSync(diagnosticsDir, { recursive: true, force: true }));
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
    const diagnosticsPath = resolve(diagnosticsDir, `${variant}.stderr`);
    const statusPath = resolve(diagnosticsDir, `${variant}.status`);
    writeFileSync(diagnosticsPath, '', { mode: 0o600 });
    writeFileSync(statusPath, '', { mode: 0o600 });
    const result = spawnSync(
      'bash',
      [
        '-c',
        `
      source "$MAXIM_TEST_ROOT/infra/scripts/lib/deploy-topology.sh"
      node() {
        local status
        # FLAG: Reproduce short pipe reads before a larger write. UTF-8 fast-path
        # stdin reads can corrupt memory on Node 24; a crash must never pass a guard.
        if "$MAXIM_TEST_NODE" --input-type=module -e '
          import { readFileSync } from "node:fs";
          import { setTimeout } from "node:timers/promises";
          const input = readFileSync(0);
          let offset = 0;
          for (; offset < Math.min(96000, input.length); offset += 4000) {
            const chunk = input.subarray(offset, Math.min(offset + 4000, input.length));
            await new Promise((resolve) => process.stdout.write(chunk, resolve));
            await setTimeout(5);
          }
          process.stdout.end(input.subarray(offset));
        ' | "$MAXIM_TEST_NODE" "$@" 2>>"$MAXIM_TEST_NODE_STDERR"; then
          status=0
        else
          status=$?
        fi
        printf '%s\\n' "$status" >>"$MAXIM_TEST_NODE_STATUS"
        return "$status"
      }
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
          // FLAG: These short source parsers run inside a concurrent native test
          // fleet. Bound their unused background pools; all guard verdicts remain real.
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --v8-pool-size=1`.trim(),
          UV_THREADPOOL_SIZE: '1',
          MAXIM_TEST_NODE: process.execPath,
          MAXIM_TEST_NODE_STDERR: diagnosticsPath,
          MAXIM_TEST_NODE_STATUS: statusPath,
          MAXIM_TEST_ROOT: root,
          MAXIM_TEST_VARIANT: variant,
          MAXIM_TEST_MISSING: variant === 'missing' ? '1' : '0',
          MAXIM_TEST_LEGACY: variant === 'legacy' ? '1' : '0',
          PARTICIPANT_REPORTS_DETAIL_RETENTION_ENABLED: 'false',
        },
        encoding: 'utf8',
      },
    );
    // FLAG: A crashed parser is never evidence that an incompatible target was rejected.
    const parserStatuses = readFileSync(statusPath, 'utf8').trim().split('\n').filter(Boolean);
    const diagnostics = `${variant}\nparser statuses: ${parserStatuses.join(', ')}\n${result.stderr}\n${readFileSync(diagnosticsPath, 'utf8')}`;
    assert.ok(
      parserStatuses.every((status) => status === '0' || status === '1'),
      diagnostics,
    );
    assert.equal(result.error, undefined, diagnostics);
    assert.equal(result.signal, null, diagnostics);
    if (variant !== 'current') {
      assert.notEqual(result.status, 0, diagnostics);
      if (variant.startsWith('archive-')) assert.match(result.stderr, /archive/u, diagnostics);
    } else assert.equal(result.status, 0, diagnostics);
  }
});
