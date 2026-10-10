import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  buildOrderBlockerPageSql,
  buildOrderBlockerDiagnosticSql,
  validateOrderBlockerDiagnosticPlan,
  validateOrderBlockerPagePlan,
} from './webhook-order-blocker-inventory-sql.mjs';
import { validateInventoryPage } from './webhook-order-blocker-inventory.mjs';
import { OWNER_PROOF_COLUMNS } from './webhook-owner-proof-audit.mjs';

const cutoff = '2026-10-09T16:10:00.000Z';
const root = resolve(import.meta.dirname, '../..');
const migration = (name) =>
  readFileSync(resolve(root, 'apps/api/prisma/migrations', name, 'migration.sql'), 'utf8');
const query = (status = 'FAILED', after = null) => ({ status, cutoff, pageSize: 200, after });
const inventoryRequest = {
  version: 1,
  inventoryId: '11111111-1111-4111-8111-111111111111',
  sourceSha: 'a'.repeat(40),
  imageId: 'sha256:' + 'b'.repeat(64),
  cutoff,
};
const secret = 'BODY_AND_ERROR_CONTENT_MUST_STAY_PRIVATE';

test('SQL generator rejects expanded status, cutoff, cursor and page limits', () => {
  for (const changed of [
    { status: 'PROCESSED' },
    { status: "FAILED'; DROP TABLE webhook_events;--" },
    { cutoff: '2026-02-30T16:10:00.000Z' },
    { cutoff: '9999-10-09T16:10:00.000Z' },
    { pageSize: 201 },
    { after: { id: "owner'", createdAt: '2026-10-09T00:00:00.000000Z' } },
    { after: { id: 'owner', createdAt: cutoff } },
    { extra: true },
  ])
    for (const generate of [
      buildOrderBlockerPageSql,
      (input) => buildOrderBlockerDiagnosticSql(input, 'raw_index'),
      (input) => buildOrderBlockerDiagnosticSql(input, 'metadata'),
    ])
      assert.throws(() => generate({ ...query(), ...changed }), /request_refused/u);
  assert.throws(() => buildOrderBlockerDiagnosticSql(query(), 'claims'), /request_refused/u);
});

test(
  'native PG16 pages retain all anchors, exact cursors and bounded claim probes',
  {
    skip: !process.env.MAXIM_TEST_POSTGRES_URL,
    timeout: 90_000,
  },
  async (t) => {
    const url = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
    assert(
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        url.pathname.includes('race_test'),
    );
    const { default: pg } = await import('pg');
    const database = `race_test_order_inventory_${randomUUID().replaceAll('-', '')}`;
    const role = `inventory_reader_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Client({ connectionString: url.href });
    const childUrl = new URL(url);
    childUrl.pathname = `/${database}`;
    const db = new pg.Client({
      connectionString: childUrl.href,
      options: '-c timezone=UTC -c statement_timeout=10000 -c lock_timeout=250',
    });
    let created = false;
    let roleCreated = false;
    // FLAG: Only this newly created local fixture database is mutated. The generated
    // inventory query executes under a SELECT-column-only role in READ ONLY mode.
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
      created = true;
      await db.connect();
      assert.match((await db.query('SHOW server_version')).rows[0].server_version, /^16\./u);
      const enumLine = (name, prefix) => {
        const lines = migration(name)
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith(prefix));
        assert.equal(lines.length, 1);
        return lines[0];
      };
      await db.query(
        [
          enumLine('20260228000000_init', 'CREATE TYPE "WebhookStatus"'),
          enumLine('20260302003000_scale_outbox_and_queue_state', 'ALTER TYPE "WebhookStatus"'),
          enumLine(
            '20261006009000_add_webhook_no_replay_held_status',
            'ALTER TYPE "WebhookStatus"',
          ),
          enumLine(
            '20260710170000_webhook_execution_lifecycle_fencing',
            'CREATE TYPE "WebhookExecutionClaimStatus"',
          ),
        ].join('\n'),
      );
      await db.query(`CREATE TABLE webhook_events (
      id text PRIMARY KEY, status "WebhookStatus" NOT NULL, created_at timestamp NOT NULL,
      semantic_key text, bot_id text, normalized_payload jsonb NOT NULL DEFAULT '{}',
      next_enqueue_at timestamp, timeout_quarantine_expires_at timestamp,
      legacy_disposition_id text, source_disposition_id text, error_message text,
      raw_payload jsonb NOT NULL DEFAULT '{}', private_secret text
    );
    CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id);
    CREATE TABLE webhook_execution_claims (
      id text PRIMARY KEY, kind text NOT NULL, semantic_key text NOT NULL, webhook_event_id text,
      execution_bot_id text, enforced boolean NOT NULL DEFAULT false,
      status "WebhookExecutionClaimStatus" NOT NULL DEFAULT 'PENDING', prepared_at timestamp,
      business_started_at timestamp, completed_at timestamp, lease_token text,
      lease_expires_at timestamp, command_result jsonb, private_secret text
    );
    CREATE UNIQUE INDEX webhook_execution_claims_kind_semantic_key ON webhook_execution_claims(kind,semantic_key);
    CREATE INDEX webhook_execution_claims_event_kind_idx ON webhook_execution_claims(webhook_event_id,kind);
    INSERT INTO webhook_events(id,status,created_at) SELECT 'retained_'||n,'PROCESSED','2026-01-01' FROM generate_series(1,1000000)n;
    INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id)
      SELECT 'retained_claim_'||n,'EXECUTION','retained_key_'||n,'retained_'||n FROM generate_series(1,100000)n;
    ANALYZE;
    SET enable_seqscan=off; SET enable_bitmapscan=off; SET max_parallel_workers_per_gather=0; SET work_mem='1MB';`);
      await db.query(`CREATE ROLE "${role}" NOLOGIN`);
      roleCreated = true;
      await db.query(`GRANT SELECT (id,status,created_at,semantic_key,bot_id,normalized_payload,next_enqueue_at,
      timeout_quarantine_expires_at,legacy_disposition_id,source_disposition_id,error_message)
      ON webhook_events TO "${role}";
      GRANT SELECT (${OWNER_PROOF_COLUMNS.webhook_execution_claims.join(',')}) ON webhook_execution_claims TO "${role}";`);
      const page = async (input = query()) => {
        await db.query(`BEGIN READ ONLY; SET LOCAL ROLE "${role}"`);
        try {
          const sql = buildOrderBlockerPageSql(input);
          const plan = (await db.query(`EXPLAIN (FORMAT JSON) ${sql}`)).rows[0]['QUERY PLAN'];
          const projectedPlan = validateOrderBlockerPagePlan(plan, input);
          assert.equal(projectedPlan.relationProbes, 5);
          const result = JSON.parse((await db.query(sql)).rows[0].inventory_page);
          validateInventoryPage(result, { ...inventoryRequest, cutoff: input.cutoff });
          assert.equal(result.status, input.status);
          assert.deepEqual(result.after, input.after);
          assert.doesNotMatch(
            JSON.stringify(result),
            /BODY_AND_ERROR_CONTENT|private_secret|raw_payload|lease_token/u,
          );
          return { result, plan };
        } finally {
          await db.query('ROLLBACK');
        }
      };
      const diagnose = async (input, phase) => {
        await db.query(`BEGIN READ ONLY; SET LOCAL ROLE "${role}"`);
        try {
          const sql = buildOrderBlockerDiagnosticSql(input, phase);
          const plan = (await db.query(`EXPLAIN (FORMAT JSON) ${sql}`)).rows[0]['QUERY PLAN'];
          const proof = validateOrderBlockerDiagnosticPlan(plan, input, phase);
          assert.equal(proof.relationProbes, phase === 'raw_index' ? 1 : 2);
          assert.throws(() => validateOrderBlockerPagePlan(plan, input), /plan_refused/u);
          const result = JSON.parse((await db.query(sql)).rows[0].inventory_diagnostic);
          assert.equal(result.kind, 'order_blocker_phase_diagnostic');
          assert.equal(result.phase, phase);
          assert.equal(result.coverage, 'DIAGNOSTIC_ONLY');
          assert.equal(result.mutationAuthorized, false);
          assert.equal(result.inventoryAdvanceAuthorized, false);
          assert.equal(result.rowCount, result.rows.length);
          assert.doesNotMatch(
            JSON.stringify(result),
            /BODY_AND_ERROR_CONTENT|private_secret|raw_payload|lease_token|claim/u,
          );
          return { result, plan };
        } finally {
          await db.query('ROLLBACK');
        }
      };
      const put = async (
        id,
        status = 'FAILED',
        date = '2026-10-08T00:00:00.000001Z',
        patch = {},
      ) => {
        const normalized = patch.normalized ?? {
          type: 'message_created',
          message: { chatId: '-123', messageId: id, text: secret },
        };
        await db.query(
          `INSERT INTO webhook_events(id,status,created_at,semantic_key,normalized_payload,error_message,
        next_enqueue_at,legacy_disposition_id,source_disposition_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            status,
            date,
            patch.semantic ?? null,
            normalized,
            patch.error === undefined
              ? `WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:${secret}`
              : patch.error,
            patch.retry ?? null,
            patch.legacy ?? null,
            patch.source ?? null,
          ],
        );
      };
      await t.test('empty lanes still have all five bounded indexed probes', async () => {
        for (const status of ['FAILED', 'QUEUED', 'RECEIVED']) {
          const { result } = await page(query(status));
          assert.equal(result.rawCount, 0);
          assert.deepEqual(result.rows, []);
          assert.equal(result.hasMore, false);
          assert.equal(result.nextCursor, null);
        }
      });
      await t.test(
        '401 later anchors in one chat traverse 201 sentinels without omission',
        async () => {
          await db.query(
            `INSERT INTO webhook_events(id,status,created_at,normalized_payload,error_message)
        SELECT 'anchor_'||lpad(n::text,4,'0'),'FAILED','2026-10-08T00:00:00.123456',
        jsonb_build_object('type','message_created','message',jsonb_build_object('chatId','-123','messageId','m_'||n,'text',$1::text)),
        'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'||$1::text FROM generate_series(1,401)n`,
            [secret],
          );
          const seen = [];
          let after = null;
          const counts = [];
          do {
            const { result } = await page(query('FAILED', after));
            counts.push(result.rawCount);
            assert(result.rows.every((row) => row.ordered && row.chatId === '-123'));
            assert.equal(result.rows[0].createdAt, '2026-10-08T00:00:00.123456Z');
            seen.push(...result.rows.map((row) => row.id));
            after = result.nextCursor;
            if (!result.hasMore) break;
          } while (counts.length < 4);
          assert.deepEqual(counts, [201, 201, 1]);
          assert.equal(new Set(seen).size, 401);
          assert.equal(seen[0], 'anchor_0001');
          assert.equal(seen.at(-1), 'anchor_0401');
          await db.query("DELETE FROM webhook_events WHERE id LIKE 'anchor_%'");
        },
      );
      await t.test(
        'phase diagnostics isolate raw index and metadata at the exact unchanged cursor',
        async () => {
          await db.query(
            `INSERT INTO webhook_events(id,status,created_at,normalized_payload,error_message)
          SELECT 'diagnostic_'||lpad(n::text,4,'0'),'FAILED','2026-10-08T00:00:00.123456',
          jsonb_build_object('type','message_created','message',jsonb_build_object('chatId','-123','messageId','d_'||n,'text',$1::text)),
          'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'||$1::text FROM generate_series(1,402)n`,
            [secret],
          );
          const input = query('FAILED', {
            id: 'diagnostic_0200',
            createdAt: '2026-10-08T00:00:00.123456Z',
          });
          const raw = (await diagnose(input, 'raw_index')).result;
          const metadata = (await diagnose(input, 'metadata')).result;
          const full = (await page(input)).result;
          assert.equal(raw.rawCount, 201);
          assert.equal(raw.rowCount, 201);
          assert.equal(metadata.rawCount, 201);
          assert.equal(metadata.rowCount, 200);
          assert(raw.hasMore && metadata.hasMore);
          assert.equal(raw.rows[0].id, 'diagnostic_0201');
          assert.equal(raw.rows.at(-1).id, 'diagnostic_0401');
          assert(raw.rows.every((row) => Object.keys(row).sort().join(',') === 'createdAt,id'));
          assert.deepEqual(
            metadata.rows.map((row) => row.id),
            full.rows.map((row) => row.id),
          );
          assert(metadata.rows.every((row) => row.ordered === true));
          for (const phase of ['raw_index', 'metadata']) {
            const { result, plan } = await diagnose(query('RECEIVED'), phase);
            assert.equal(result.rowCount, 0);
            assert.equal(result.rawCount, 0);
            const walk = (node) => [node, ...(node.Plans ?? []).flatMap(walk)];
            const changed = structuredClone(plan);
            walk(changed[0].Plan).find((node) => node['Relation Name']).Filter = 'unsafe';
            assert.throws(
              () => validateOrderBlockerDiagnosticPlan(changed, query('RECEIVED'), phase),
              /plan_refused/u,
            );
          }
          await db.query("DELETE FROM webhook_events WHERE id LIKE 'diagnostic_%'");
        },
      );
      await t.test(
        'cutoff and microsecond cursor boundaries preserve all three lanes',
        async () => {
          for (const status of ['FAILED', 'QUEUED', 'RECEIVED']) {
            await put(`before_${status}`, status, '2026-10-09T16:09:59.999999Z');
            await put(`at_${status}`, status, cutoff);
            await put(`after_${status}`, status, '2026-10-09T16:10:00.000001Z');
            const { result } = await page(query(status));
            assert.deepEqual(
              result.rows.map((row) => row.id),
              [`before_${status}`],
            );
            assert.equal((await page(query(status, result.nextCursor))).result.rawCount, 0);
          }
          await db.query(
            "DELETE FROM webhook_events WHERE id LIKE 'before_%' OR id LIKE 'at_%' OR id LIKE 'after_%'",
          );
        },
      );
      await t.test(
        'released and irrelevant rows remain counted; unknown routing stays unknown',
        async () => {
          await put('released_source', 'FAILED', undefined, { source: 'positive_source_proof' });
          await put('released_legacy', 'FAILED', undefined, { legacy: 'positive_legacy_proof' });
          await put('irrelevant', 'FAILED', undefined, { error: 'PRIVATE irrelevant error' });
          await put('lifecycle', 'FAILED', undefined, { normalized: { type: 'bot_added' } });
          await put('large_payload', 'FAILED', undefined, {
            normalized: {
              type: 'message_created',
              message: { chatId: '-123', text: 'X'.repeat(300000) },
            },
          });
          const { result } = await page();
          const byId = new Map(result.rows.map((row) => [row.id, row]));
          assert.equal(result.rawCount, 5);
          assert.equal(byId.get('released_source').sourceReleased, true);
          assert.equal(byId.get('released_legacy').legacyReleased, true);
          assert.equal(byId.get('irrelevant').ordered, false);
          assert.equal(byId.get('lifecycle').ordered, false);
          assert.equal(byId.get('large_payload').ordered, null);
          assert.equal(byId.get('large_payload').normalizedBounded, false);
          await db.query("DELETE FROM webhook_events WHERE status='FAILED'");
        },
      );
      await t.test(
        'large non-ordering failures keep coverage without executing claim indexes',
        async () => {
          await db.query(`INSERT INTO webhook_events(id,status,created_at,semantic_key,normalized_payload,error_message)
          SELECT 'ignored_'||lpad(n::text,4,'0'),'FAILED','2026-10-08T00:00:00.123456','ignored_key_'||n,
            jsonb_build_object('type','message_created','message',jsonb_build_object('chatId','-123','messageId','ignored_'||n,'text',repeat('X',300000))),
            'ordinary terminal error' FROM generate_series(1,200)n;
          INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id)
            SELECT 'ignored_claim_'||n,'EXECUTION','ignored_key_'||n,'ignored_'||lpad(n::text,4,'0') FROM generate_series(1,200)n;`);
          const { result } = await page();
          assert.equal(result.rawCount, 200);
          assert.equal(result.rows.length, 200);
          assert(
            result.rows.every(
              (row) =>
                row.ordered === false && row.normalizedBounded === false && row.claim.id === null,
            ),
          );
          // FLAG: Execution plans with timing are confined to this disposable native fixture.
          // The production reader always uses plain EXPLAIN.
          const execution = (
            await db.query(
              'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ' +
                buildOrderBlockerPageSql(query()),
            )
          ).rows[0]['QUERY PLAN'];
          const walk = (node) => [node, ...(node.Plans ?? []).flatMap(walk)];
          const claims = walk(execution[0].Plan).filter(
            (node) => node['Relation Name'] === 'webhook_execution_claims',
          );
          assert.equal(claims.length, 3);
          assert(claims.every((node) => node['Actual Loops'] === 0));
          assert.equal(execution[0].Plan['Temp Written Blocks'], 0);
          const diagnostic = (await diagnose(query(), 'metadata')).result;
          assert(
            diagnostic.rows.every(
              (row) => row.normalizedBounded === false && row.ordered === false,
            ),
          );
          await db.query(
            "DELETE FROM webhook_events WHERE id LIKE 'ignored_%'; DELETE FROM webhook_execution_claims WHERE id LIKE 'ignored_%'",
          );
        },
      );
      await t.test(
        'semantic actual owner and direct conflicts are retained without fabricated authority',
        async () => {
          await put('owner', 'FAILED', undefined, { semantic: 'source_key' });
          await put('mirror', 'RECEIVED', undefined, { semantic: 'source_key' });
          await put('conflict', 'FAILED', undefined, { semantic: 'source_key' });
          await db.query(`INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id,status,enforced,prepared_at,business_started_at)
        VALUES('source_claim','EXECUTION','source_key','owner','READY',true,'2026-10-08','2026-10-08'),
        ('conflicting_claim','EXECUTION','other_key','conflict','READY',true,'2026-10-08','2026-10-08'),
        ('second_conflicting_claim','EXECUTION','third_key','conflict','READY',true,'2026-10-08','2026-10-08');`);
          const mirror = (await page(query('RECEIVED'))).result.rows[0];
          assert.equal(mirror.claim.ownerId, 'owner');
          assert.equal(mirror.claim.directCount, 0);
          assert.equal(mirror.claim.started, true);
          assert.equal(mirror.claim.conflict, false);
          const conflict = (await page()).result.rows.find((row) => row.id === 'conflict');
          assert.equal(conflict.claim.directCount, 2);
          assert.equal(conflict.claim.conflict, true);
          assert.equal(conflict.claim.ownerId, 'owner');
        },
      );
      await t.test(
        'plan refusal rejects unsafe base scans, hidden filters, limits and missing probes',
        async () => {
          const { plan } = await page();
          const walk = (node) => [node, ...(node.Plans ?? []).flatMap(walk)];
          for (const edit of [
            (nodes) => {
              nodes.find((n) => n['Relation Name']).Filter = 'private';
            },
            (nodes) => {
              nodes.find((n) => n['Relation Name'])['Node Type'] = 'Seq Scan';
            },
            (nodes) => {
              nodes.find((n) => n['Relation Name'])['Index Name'] = 'wrong';
            },
            (nodes) => {
              const n = nodes.find(
                (x) => x['Index Name'] === 'webhook_events_status_created_at_id_idx',
              );
              n['Index Cond'] = n['Index Cond'].replace('16:10:00', '16:11:00');
            },
            (nodes) => {
              for (const n of nodes.filter((x) => x['Node Type'] === 'Limit')) n['Plan Rows'] = 999;
            },
          ]) {
            const changed = structuredClone(plan);
            edit(walk(changed[0].Plan));
            assert.throws(() => validateOrderBlockerPagePlan(changed, query()), /plan_refused/u);
          }
        },
      );
      await t.test(
        'active status moves remain explicitly online preview and never grant writes',
        async () => {
          const before = (await page(query('RECEIVED'))).result;
          await db.query("UPDATE webhook_events SET status='PROCESSED' WHERE id='mirror'");
          const after = (await page(query('RECEIVED'))).result;
          assert.equal(before.rows.length, 1);
          assert.equal(after.rows.length, 0);
          for (const result of [before, after]) {
            assert.equal(result.coverage, 'ONLINE_PREVIEW');
            assert.equal(result.mutationAuthorized, false);
          }
        },
      );
    } finally {
      await db.end();
      if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
      await admin.end();
    }
  },
);
