import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  attestInventoryRuntime,
  createInventoryPageReader,
  inventoryAuditResult,
  renderInventoryAuditWrapper,
  runInventoryBatch,
} from './webhook-order-blocker-inventory-cli.mjs';

const request = {
  version: 1,
  inventoryId: '023bd9c1-069c-4adc-840c-d46e9069c413',
  sourceSha: 'a'.repeat(40),
  imageId: `sha256:${'b'.repeat(64)}`,
  cutoff: '2026-10-09T16:10:00.000Z',
};
const runtime = {
  id: 'c'.repeat(64),
  imageId: request.imageId,
  running: true,
  startedAt: '2026-10-09T15:30:00.000Z',
  restarts: 0,
  sourceSha: request.sourceSha,
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-order-inventory-test-'));
  chmodSync(directory, 0o700);
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function row(index, status = 'FAILED') {
  return {
    id: `event-${String(index).padStart(6, '0')}`,
    createdAt: '2026-10-08T12:00:00.123456Z',
    status,
    normalizedBounded: true,
    ordered: true,
    chatId: '-123',
    messageId: `message-${index}`,
    semanticKey: `message:message_created:-123:message-${index}`,
    botId: 'major-test',
    legacyReleased: false,
    sourceReleased: false,
    retry: 'none',
    quarantine: 'none',
    errorFamily: 'timeout_quarantine',
    claim: {
      semanticFound: false,
      directCount: 0,
      conflict: false,
      id: null,
      ownerId: null,
      status: 'missing',
      enforced: false,
      prepared: false,
      started: false,
      completed: false,
      lease: 'missing',
      checkpoint: 'missing',
    },
  };
}
function page(parameters, rows = [], more = false) {
  const last = rows.at(-1);
  return {
    version: 1,
    kind: 'order_blocker_inventory_page',
    readOnly: true,
    observedAt: '2026-10-09T16:20:00.000000Z',
    ...parameters,
    rawCount: more ? 201 : rows.length,
    hasMore: more,
    nextCursor: last ? { createdAt: last.createdAt, id: last.id } : null,
    rows,
    coverage: 'ONLINE_PREVIEW',
    mutationAuthorized: false,
  };
}
const defaults = (directory) => ({
  request,
  directory,
  attest: () => runtime,
  readPage: (parameters) => ({ page: page(parameters), plan: { operation: 'plain_explain' } }),
});

test('three empty status EOFs finish only the online preview; output contains no private rows', () =>
  withDirectory((directory) => {
    const result = runInventoryBatch(defaults(directory));
    assert.equal(result.pagesCommitted, 3);
    assert.equal(result.nextStatus, null);
    assert.equal(result.report.complete, true);
    assert.equal(result.report.closedWorldComplete, false);
    assert.equal(result.report.mutationAuthorized, false);
    assert.equal(result.report.fleetRecoveryProven, false);
    assert.equal(result.stopReason, 'complete');
    assert.equal(JSON.stringify(result).includes(runtime.id), false);
  }));

test('sentinel and microsecond cursor survive restart without losing any of 401 observations', () =>
  withDirectory((directory) => {
    const starts = [];
    const options = {
      ...defaults(directory),
      pageLimit: 1,
      readPage(parameters) {
        if (parameters.status !== 'FAILED') return { page: page(parameters), plan: {} };
        const start = parameters.after ? Number(parameters.after.id.slice(6)) + 1 : 0;
        starts.push(start);
        const rows = Array.from({ length: Math.min(200, 401 - start) }, (_, index) =>
          row(start + index),
        );
        return { page: page(parameters, rows, start + rows.length < 401), plan: {} };
      },
    };
    let result = runInventoryBatch(options);
    assert.equal(result.report.complete, false);
    assert.equal(result.report.rowObservations, 200);
    result = runInventoryBatch({ ...options, expectedCheckpoint: result.checkpointSha256 });
    assert.equal(result.report.rowObservations, 400);
    result = runInventoryBatch({
      ...options,
      pageLimit: 3,
      expectedCheckpoint: result.checkpointSha256,
    });
    assert.deepEqual(starts, [0, 200, 400]);
    assert.equal(result.report.rowObservations, 401);
    assert.equal(result.report.complete, true);
    assert.equal(result.report.lanes.FAILED.pages, 3);
  }));

test('failed next page preserves committed progress and status is entirely local', () =>
  withDirectory((directory) => {
    const first = runInventoryBatch({ ...defaults(directory), pageLimit: 1 });
    assert.throws(
      () =>
        runInventoryBatch({
          ...defaults(directory),
          expectedCheckpoint: first.checkpointSha256,
          readPage() {
            throw new Error('inventory_audit_timeout');
          },
        }),
      /inventory_audit_timeout/u,
    );
    const status = runInventoryBatch({
      ...defaults(directory),
      statusOnly: true,
      attest() {
        throw new Error('must not probe');
      },
      readPage() {
        throw new Error('must not query');
      },
    });
    assert.equal(status.checkpointSha256, first.checkpointSha256);
    assert.equal(status.pagesCommitted, 1);
    assert.equal(status.nextStatus, 'QUEUED');
    assert.equal(status.report.complete, false);
    const final = runInventoryBatch({
      ...defaults(directory),
      expectedCheckpoint: first.checkpointSha256,
    });
    assert.equal(final.report.complete, true);
  }));

test('a changed request, stale checkpoint or altered page cannot advance a resumed traversal', () =>
  withDirectory((directory) => {
    const first = runInventoryBatch({ ...defaults(directory), pageLimit: 1 });
    assert.throws(
      () =>
        runInventoryBatch({
          ...defaults(directory),
          request: { ...request, sourceSha: 'd'.repeat(40) },
          expectedCheckpoint: first.checkpointSha256,
        }),
      /request_changed/u,
    );
    assert.throws(
      () => runInventoryBatch({ ...defaults(directory), expectedCheckpoint: 'e'.repeat(64) }),
      /checkpoint_changed/u,
    );
    const file = readdirSync(directory).find((name) => name.startsWith('page-'));
    writeFileSync(join(directory, file), `${readFileSync(join(directory, file), 'utf8')} `);
    assert.throws(
      () => runInventoryBatch({ ...defaults(directory), statusOnly: true }),
      /page_changed/u,
    );
  }));

test('runtime changes after SQL prevent page commitment and fresh fleet cannot continue the same inventory', () =>
  withDirectory((directory) => {
    let probes = 0;
    assert.throws(
      () =>
        runInventoryBatch({
          ...defaults(directory),
          attest() {
            return ++probes === 1 ? runtime : { ...runtime, restarts: 1 };
          },
        }),
      /runtime_changed/u,
    );
    assert.equal(
      readdirSync(directory).some((name) => name.startsWith('page-')),
      false,
    );
    const first = runInventoryBatch({ ...defaults(directory), pageLimit: 1 });
    assert.throws(
      () =>
        runInventoryBatch({
          ...defaults(directory),
          expectedCheckpoint: first.checkpointSha256,
          attest: () => ({ ...runtime, id: 'd'.repeat(64) }),
        }),
      /runtime_changed/u,
    );
  }));

test('wrong status or cursor is rejected even when the page independently validates', () =>
  withDirectory((directory) => {
    assert.throws(
      () =>
        runInventoryBatch({
          ...defaults(directory),
          readPage(parameters) {
            return { page: page({ ...parameters, status: 'RECEIVED' }), plan: {} };
          },
        }),
      /page_changed/u,
    );
    assert.equal(
      readdirSync(directory).some((name) => name.startsWith('page-')),
      false,
    );
  }));

test('disk refusal preserves completed checkpoints without attempting another query', () =>
  withDirectory((directory) => {
    const first = runInventoryBatch({ ...defaults(directory), pageLimit: 1 });
    assert.throws(
      () =>
        runInventoryBatch({
          ...defaults(directory),
          expectedCheckpoint: first.checkpointSha256,
          checkCapacity() {
            throw new Error('inventory_disk_reserve');
          },
          readPage() {
            throw new Error('query must not start');
          },
        }),
      /disk_reserve/u,
    );
    assert.equal(hash(readFileSync(join(directory, 'checkpoint.json'))), first.checkpointSha256);
  }));

test('uncommitted immutable pages do not advance or alter the authoritative cursor', () =>
  withDirectory((directory) => {
    const first = runInventoryBatch({ ...defaults(directory), pageLimit: 1 });
    const saved = readdirSync(directory).find((name) => name.startsWith('page-'));
    writeFileSync(
      join(directory, `page-000099-${'f'.repeat(64)}.json`),
      readFileSync(join(directory, saved)),
      { mode: 0o600 },
    );
    const status = runInventoryBatch({ ...defaults(directory), statusOnly: true });
    assert.equal(status.pagesCommitted, 1);
    assert.equal(status.checkpointSha256, first.checkpointSha256);
  }));

test('stock audit wrapper changes only its fixed report body and remains valid Bash', () => {
  const stock = readFileSync(new URL('./vps-postgres-audit.sh', import.meta.url), 'utf8');
  const rendered = renderInventoryAuditWrapper(
    stock,
    "SELECT json_build_object('readOnly', true);",
  );
  const first = stock.indexOf('emit_queue_audit() {\n');
  const last = stock.indexOf('emit_legacy_order_index_guard() {\n');
  assert.equal(rendered.slice(0, first), stock.slice(0, first));
  assert.equal(
    rendered.slice(rendered.indexOf('emit_legacy_order_index_guard() {\n')),
    stock.slice(last),
  );
  assert.equal(spawnSync('bash', ['-n'], { input: rendered, encoding: 'utf8' }).status, 0);
  const guardedBody = rendered.slice(
    first,
    rendered.indexOf('emit_legacy_order_index_guard() {\n'),
  );
  assert.match(guardedBody, /\\if :owner_proof_privileges_ready/u);
  assert.match(guardedBody, /\\if :owner_proof_indexes_ready/u);
  assert.ok(
    guardedBody.indexOf('owner_proof_indexes_ready') <
      guardedBody.indexOf('SELECT json_build_object'),
  );
  const explain = renderInventoryAuditWrapper(stock, 'EXPLAIN (FORMAT JSON) SELECT 1;');
  assert.ok(
    explain.indexOf('\\if :owner_proof_indexes_ready') <
      explain.indexOf('EXPLAIN (FORMAT JSON) SELECT 1'),
  );
  assert.throws(
    () => renderInventoryAuditWrapper(stock, 'MAXIM_ORDER_INVENTORY_SQL'),
    /template_refused/u,
  );
});

test('runtime attestation binds source, clean controller, exact Docker image and one running admin generation', () => {
  const run = (_command, args) => {
    if (args[0] === 'rev-parse') return request.sourceSha;
    if (args[0] === 'status') return '';
    if (args.includes('ps')) return runtime.id;
    return JSON.stringify(runtime);
  };
  assert.deepEqual(attestInventoryRuntime(request, '/unused', run), runtime);
  assert.throws(
    () =>
      attestInventoryRuntime(request, '/unused', (command, args, cwd) =>
        args.includes('inspect')
          ? JSON.stringify({ ...runtime, imageId: `sha256:${'e'.repeat(64)}` })
          : run(command, args, cwd),
      ),
    /runtime_probe_refused/u,
  );
});

test('audit diagnostics identify the failed bounded stage without raw SQL or identities', () => {
  const markers = 'inventory_privileges_complete\ninventory_indexes_complete\n';
  assert.deepEqual(
    inventoryAuditResult({ status: 0, stdout: markers + '{"readOnly":true}\n' }, 'page'),
    { readOnly: true },
  );
  for (const [stdout, stage] of [
    ['', 'privileges'],
    ['inventory_privileges_complete\n', 'indexes'],
    [markers, 'page'],
  ]) {
    assert.throws(
      () =>
        inventoryAuditResult(
          {
            status: 1,
            stdout,
            stderr: 'ERROR:  canceling statement due to statement timeout\nprivate-secret',
          },
          'page',
        ),
      new RegExp('^Error: inventory_statement_timeout_' + stage + '$', 'u'),
    );
  }
  assert.throws(
    () => inventoryAuditResult({ status: 0, stdout: '{"readOnly":true}' }, 'page'),
    /markers_refused/u,
  );
});

test('phase diagnostic emits counts only and does not create inventory pages', () =>
  withDirectory((directory) => {
    const params = { status: 'FAILED', cutoff: request.cutoff, pageSize: 200, after: null };
    const plan = [
      {
        Plan: {
          'Node Type': 'Limit',
          'Plan Rows': 201,
          Plans: [
            {
              'Node Type': 'Index Only Scan',
              'Relation Name': 'webhook_events',
              'Index Name': 'webhook_events_status_created_at_id_idx',
              'Index Cond': `(status = 'FAILED'::"WebhookStatus" AND created_at < '2026-10-09 16:10:00'::timestamp without time zone)`,
            },
          ],
        },
      },
    ];
    let calls = 0;
    const reader = createInventoryPageReader({
      request,
      repositoryRoot: new URL('../..', import.meta.url).pathname,
      temporaryDirectory: directory,
      diagnosticPhase: 'raw_index',
      run() {
        const value =
          calls++ === 0
            ? plan
            : {
                version: 1,
                kind: 'order_blocker_phase_diagnostic',
                readOnly: true,
                phase: 'raw_index',
                status: 'FAILED',
                cutoff: request.cutoff,
                rawCount: 1,
                hasMore: false,
                rowCount: 1,
                rows: [{ id: 'private-id', createdAt: '2026-10-08T00:00:00.000000Z' }],
                coverage: 'DIAGNOSTIC_ONLY',
                mutationAuthorized: false,
                inventoryAdvanceAuthorized: false,
              };
        return {
          status: 0,
          stdout:
            'inventory_privileges_complete\ninventory_indexes_complete\n' + JSON.stringify(value),
        };
      },
    });
    const result = reader(params);
    assert.equal(result.rowCount, 1);
    assert.equal(result.inventoryAdvanceAuthorized, false);
    assert.equal(JSON.stringify(result).includes('private-id'), false);
    assert.deepEqual(readdirSync(directory), []);
  }));
