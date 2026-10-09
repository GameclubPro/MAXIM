import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import {
  buildOrderedAnchorPageSql,
  validateOrderedAnchorPagePlan,
  buildFrozenOrderedAnchorPageSql,
  validateFrozenOrderedAnchorPagePlan,
  FROZEN_ORDERED_ANCHOR_OUTPUT_BYTES,
} from './webhook-ordered-anchor-inventory-sql.mjs';
import {
  validateOrderedAnchorPage,
  createOrderedAnchorAccumulator,
} from './webhook-ordered-anchor-inventory.mjs';
import {
  validateFrozenOrderedAnchorPage,
  createFrozenOrderedAnchorAccumulator,
} from './webhook-frozen-ordered-anchor-inventory.mjs';
import { OWNER_PROOF_COLUMNS } from './webhook-owner-proof-audit.mjs';
const cutoff = '2026-10-09T16:10:00.000Z';
const root = resolve(import.meta.dirname, '../..');
const migration = (name) =>
  readFileSync(resolve(root, 'apps/api/prisma/migrations', name, 'migration.sql'), 'utf8');
const request = {
  version: 2,
  inventoryId: '11111111-1111-4111-8111-111111111111',
  sourceSha: 'a'.repeat(40),
  imageId: 'sha256:' + 'b'.repeat(64),
  cutoff,
};
test(
  'native PG16 frozen1000 exact traversal, skew, payload ceiling and bounded refusal',
  { skip: !process.env.MAXIM_TEST_POSTGRES_URL, timeout: 180000 },
  async (t) => {
    const url = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
    assert(
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        url.pathname.includes('race_test'),
    );
    const { default: pg } = await import('pg');
    const database = 'race_test_frozen_anchor_' + randomUUID().replaceAll('-', ''),
      role = 'frozen_reader_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Client({ connectionString: url.href });
    const childUrl = new URL(url);
    childUrl.pathname = '/' + database;
    const db = new pg.Client({
      connectionString: childUrl.href,
      options: '-c timezone=UTC -c statement_timeout=30000 -c lock_timeout=250',
    });
    let created = false,
      roleCreated = false;
    // FLAG: All writes and timed plans are confined to this disposable local database.
    // Production receives only fixed SELECT/EXPLAIN SQL under the audit role.
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
      // FLAG: This disposable fixture owns its explicit ANALYZE calls. Disable
      // table/TOAST autovacuum before seeding so background maintenance cannot
      // race fixture setup under the unchanged 250ms audit lock timeout.
      await db.query(`CREATE TABLE webhook_events(id text PRIMARY KEY,status "WebhookStatus" NOT NULL,created_at timestamp NOT NULL,
   semantic_key text,bot_id text,normalized_payload jsonb NOT NULL DEFAULT '{}',next_enqueue_at timestamp,timeout_quarantine_expires_at timestamp,
   legacy_disposition_id text,source_disposition_id text,error_message text,raw_payload jsonb NOT NULL DEFAULT '{}',private_secret text)
   WITH (autovacuum_enabled=false,toast.autovacuum_enabled=false);
   CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id);
   CREATE TABLE webhook_execution_claims(id text PRIMARY KEY,kind text NOT NULL,semantic_key text NOT NULL,webhook_event_id text,
   execution_bot_id text,enforced boolean NOT NULL DEFAULT false,status "WebhookExecutionClaimStatus" NOT NULL DEFAULT 'PENDING',prepared_at timestamp,
   business_started_at timestamp,completed_at timestamp,lease_token text,lease_expires_at timestamp,command_result jsonb,private_secret text)
   WITH (autovacuum_enabled=false,toast.autovacuum_enabled=false);
   CREATE UNIQUE INDEX webhook_execution_claims_kind_semantic_key ON webhook_execution_claims(kind,semantic_key);
   CREATE INDEX webhook_execution_claims_event_kind_idx ON webhook_execution_claims(webhook_event_id,kind);
   INSERT INTO webhook_events(id,status,created_at,error_message) SELECT 'terminal_'||n,'FAILED','2026-01-01','ordinary error' FROM generate_series(1,1000000)n;
   INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id) SELECT 'retained_claim_'||n,'EXECUTION','retained_key_'||n,'terminal_'||n FROM generate_series(1,100000)n;`);
      await db.query(
        migration('20260815123000_add_webhook_ordered_chat_head_index').replace(
          'CREATE INDEX CONCURRENTLY',
          'CREATE INDEX',
        ),
      );
      await db.query(
        "ANALYZE; SET enable_seqscan=off; SET enable_bitmapscan=off; SET max_parallel_workers_per_gather=0; SET work_mem='1MB'",
      );
      await db.query(`CREATE ROLE "${role}" NOLOGIN`);
      roleCreated = true;
      await db.query(`GRANT SELECT(id,status,created_at,semantic_key,bot_id,normalized_payload,next_enqueue_at,timeout_quarantine_expires_at,legacy_disposition_id,source_disposition_id,error_message) ON webhook_events TO "${role}";
  GRANT SELECT(${OWNER_PROOF_COLUMNS.webhook_execution_claims.join(',')}) ON webhook_execution_claims TO "${role}";`);

      const observations = [];
      const page = async (parameters, frozen = false) => {
        await db.query(
          `BEGIN READ ONLY; SET LOCAL ROLE "${role}"; SET LOCAL statement_timeout='2500ms'`,
        );
        try {
          const sql = (frozen ? buildFrozenOrderedAnchorPageSql : buildOrderedAnchorPageSql)(
            parameters,
          );
          const started = performance.now();
          const plan = (await db.query('EXPLAIN (FORMAT JSON) ' + sql)).rows[0]['QUERY PLAN'];
          const proof = (
            frozen ? validateFrozenOrderedAnchorPagePlan : validateOrderedAnchorPagePlan
          )(plan, parameters);
          const explained = performance.now();
          const raw = (await db.query(sql)).rows[0].inventory_page;
          const finished = performance.now();
          const value = JSON.parse(raw);
          assert(Buffer.byteLength(raw) <= 2 * 1024 * 1024);
          if (value.kind !== 'frozen_ordered_anchor_page_refused')
            (frozen ? validateFrozenOrderedAnchorPage : validateOrderedAnchorPage)(value, request);
          assert.equal(proof.rawRowCap, parameters.pageSize + 1);
          observations.push({
            pageSize: parameters.pageSize,
            explainMs: explained - started,
            queryMs: finished - explained,
            outputBytes: Buffer.byteLength(raw),
            rawCount: value.rawCount,
            refused: value.reason ?? null,
          });
          return { value, raw, plan };
        } finally {
          await db.query('ROLLBACK');
        }
      };
      await t.test(
        '43,919 ordered anchors across184chats/161owners match online200 without gaps',
        async () => {
          await db.query(`INSERT INTO webhook_events(id,status,created_at,normalized_payload,error_message,bot_id,semantic_key)
        SELECT 'anchor_'||lpad(n::text,6,'0'),(ARRAY['FAILED','QUEUED','RECEIVED']::"WebhookStatus"[])[1+(n%3)],'2026-10-08T00:00:00.123456',
        jsonb_build_object('type','message_created','message',jsonb_build_object('chatId','chat_'||lpad((n%184)::text,3,'0'),'messageId','m_'||n,'text','PRIVATE_BODY')),
        'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:PRIVATE_ERROR','major-test',CASE WHEN n<=161 THEN 'semantic_'||n END FROM generate_series(1,43919)n;
        INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id,status,enforced,prepared_at,business_started_at)
        SELECT 'selected_claim_'||n,'EXECUTION','semantic_'||n,'anchor_'||lpad(n::text,6,'0'),'READY',true,'2026-10-08','2026-10-08' FROM generate_series(1,161)n;
        ANALYZE webhook_events; ANALYZE webhook_execution_claims;`);
          const traversals = [];
          for (const frozen of [false, true]) {
            const accumulator = (
                frozen ? createFrozenOrderedAnchorAccumulator : createOrderedAnchorAccumulator
              )(request),
              ids = [];
            const begin = performance.now(),
              obs = observations.length;
            while (accumulator.nextRequest()) {
              const { value } = await page(accumulator.nextRequest(), frozen);
              accumulator.addPage(value);
              ids.push(...value.rows.map((row) => row.id));
            }
            const report = accumulator.report();
            assert.equal(report.complete, true);
            assert.equal(ids.length, 43919);
            assert.equal(new Set(ids).size, 43919);
            assert.equal(report.uniqueChats, 184);
            assert.equal(report.nominatedOwners, 161);
            assert.equal(report.pages, frozen ? 44 : 220);
            traversals.push({
              pageSize: frozen ? 1000 : 200,
              elapsedMs: performance.now() - begin,
              report,
              ids,
              observations: observations.slice(obs),
            });
          }
          assert.deepEqual(traversals[1].ids, traversals[0].ids);
          for (const row of traversals)
            t.diagnostic(
              JSON.stringify({
                profile: 'normal_43919',
                pageSize: row.pageSize,
                pages: row.report.pages,
                rows: row.ids.length,
                totalMs: row.elapsedMs,
                maxQueryMs: Math.max(...row.observations.map((v) => v.queryMs)),
                maxOutputBytes: Math.max(...row.observations.map((v) => v.outputBytes)),
                queryMs: row.observations.reduce((a, v) => a + v.queryMs, 0),
              }),
            );
          await db.query(
            "DELETE FROM webhook_events WHERE id LIKE 'anchor_%';DELETE FROM webhook_execution_claims WHERE id LIKE 'selected_claim_%'",
          );
        },
      );
      await t.test('1,001 samechat ties retain exact sentinel and microsecond cutoff', async () => {
        await db.query(`INSERT INTO webhook_events(id,status,created_at,normalized_payload,error_message,bot_id)
        SELECT 'tie_'||lpad(n::text,6,'0'),'QUEUED','2026-10-09T16:09:59.999999',
        jsonb_build_object('type','message_created','message',jsonb_build_object('chatId','quote''чат','messageId','m_'||n)),'PRIVATE_ERROR','major-test' FROM generate_series(1,1001)n;
        INSERT INTO webhook_events(id,status,created_at,normalized_payload) VALUES('at_cutoff','RECEIVED','2026-10-09T16:10:00',jsonb_build_object('type','message_created','chatId','quote''чат'))`);
        const accumulator = createFrozenOrderedAnchorAccumulator(request),
          counts = [],
          ids = [];
        while (accumulator.nextRequest()) {
          const { value } = await page(accumulator.nextRequest(), true);
          counts.push(value.rawCount);
          ids.push(...value.rows.map((r) => r.id));
          accumulator.addPage(value);
        }
        assert.deepEqual(counts, [1001, 1]);
        assert.equal(new Set(ids).size, 1001);
        assert.equal(ids.includes('at_cutoff'), false);
        await db.query("DELETE FROM webhook_events WHERE id LIKE 'tie_%' OR id='at_cutoff'");
      });
      await t.test(
        '1000 near262KiB payloads remain metadata-only under unchanged statement ceiling',
        async () => {
          await db.query(`INSERT INTO webhook_events(id,status,created_at,normalized_payload,bot_id)
        SELECT 'large_'||lpad(n::text,6,'0'),'QUEUED','2026-10-08',jsonb_build_object('type','message_created','message',jsonb_build_object('chatId','large','messageId','m_'||n,'text',repeat(md5(n::text),8100))),'major-test' FROM generate_series(1,1000)n; ANALYZE webhook_events;`);
          for (const size of [200, 1000]) {
            const before = observations.length,
              { value, raw } = await page({ cutoff, pageSize: size, after: null }, size === 1000);
            assert.equal(value.rows.length, size);
            assert(value.rows.every((r) => r.normalizedBounded === true));
            assert.doesNotMatch(raw, /PRIVATE_BODY|"text"/u);
            t.diagnostic(
              JSON.stringify({ profile: 'near262KiB_payload', ...observations[before] }),
            );
          }
          await db.query("DELETE FROM webhook_events WHERE id LIKE 'large_%'");
        },
      );
      await t.test(
        'maximum projected fields emit a small typed refusal then complete samecursor200',
        async () => {
          await db.query(`INSERT INTO webhook_events(id,status,created_at,normalized_payload,bot_id,semantic_key)
        SELECT 'meta_'||lpad(n::text,6,'0')||repeat('e',117),'QUEUED','2026-10-08',jsonb_build_object('type','message_created','message',jsonb_build_object('chatId',repeat('c',4096),'messageId',repeat('m',1024))),repeat('b',128),repeat('s',1024) FROM generate_series(1,1000)n;
        INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id,status,enforced,prepared_at,business_started_at) VALUES(repeat('q',128),'EXECUTION',repeat('s',1024),repeat('o',128),'READY',true,'2026-10-08','2026-10-08'); ANALYZE webhook_events;`);
          const params = { cutoff, pageSize: 1000, after: null };
          const refused = await page(params, true);
          assert.equal(refused.value.kind, 'frozen_ordered_anchor_page_refused');
          assert.equal(refused.value.reason, 'output_budget');
          assert.equal(refused.value.rawCount, 1000);
          assert(Buffer.byteLength(refused.raw) < 1024);
          const accumulator = createFrozenOrderedAnchorAccumulator(request);
          let rows = 0,
            pages = 0;
          while (accumulator.nextRequest()) {
            const input = { ...accumulator.nextRequest(), pageSize: 200 };
            const { value, raw } = await page(input, true);
            assert(Buffer.byteLength(raw) < FROZEN_ORDERED_ANCHOR_OUTPUT_BYTES);
            accumulator.addPage(value);
            rows += value.rows.length;
            pages++;
          }
          assert.equal(rows, 1000);
          assert.equal(pages, 5);
          assert.equal(accumulator.report().complete, true);
        },
      );
    } finally {
      await db.end().catch(() => {});
      if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => {});
      if (roleCreated) await admin.query(`DROP ROLE "${role}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  },
);
