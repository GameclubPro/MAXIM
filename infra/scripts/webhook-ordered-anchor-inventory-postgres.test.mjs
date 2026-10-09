import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  buildOrderedAnchorPageSql,
  validateOrderedAnchorPagePlan,
} from './webhook-ordered-anchor-inventory-sql.mjs';
import {
  validateOrderedAnchorPage,
  createOrderedAnchorAccumulator,
} from './webhook-ordered-anchor-inventory.mjs';
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
const query = (after) => ({ cutoff, pageSize: 200, after: after ?? null });
const secret = 'BODY_AND_ERROR_CONTENT_MUST_STAY_PRIVATE';
const walk = (node) => [node, ...(node.Plans ?? []).flatMap(walk)];
test('ordered anchor generator rejects scope widening and unsafe cursors', () => {
  for (const changed of [
    { status: 'FAILED' },
    { cutoff: '9999-10-09T16:10:00.000Z' },
    { cutoff: '2026-02-30T16:10:00.000Z' },
    { pageSize: 201 },
    { after: { chatId: '', id: 'x', createdAt: '2026-10-08T00:00:00.000001Z' } },
    { after: { chatId: '-1\n', id: 'x', createdAt: '2026-10-08T00:00:00.000001Z' } },
    { after: { chatId: '-1', id: "'unsafe", createdAt: '2026-10-08T00:00:00.000001Z' } },
    { after: { chatId: '-1', id: 'x', createdAt: cutoff } },
    { extra: true },
  ])
    assert.throws(() => buildOrderedAnchorPageSql({ ...query(), ...changed }), /request_refused/u);
});
test(
  'native PG16 exact ordered partial-index traversal and bounded metadata probes',
  { skip: !process.env.MAXIM_TEST_POSTGRES_URL, timeout: 90000 },
  async (t) => {
    const url = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
    assert(
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        url.pathname.includes('race_test'),
    );
    const { default: pg } = await import('pg');
    const database = 'race_test_ordered_anchor_' + randomUUID().replaceAll('-', ''),
      role = 'ordered_reader_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Client({ connectionString: url.href });
    const childUrl = new URL(url);
    childUrl.pathname = '/' + database;
    const db = new pg.Client({
      connectionString: childUrl.href,
      options: '-c timezone=UTC -c statement_timeout=10000 -c lock_timeout=250',
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
      await db.query(`CREATE TABLE webhook_events(id text PRIMARY KEY,status "WebhookStatus" NOT NULL,created_at timestamp NOT NULL,
   semantic_key text,bot_id text,normalized_payload jsonb NOT NULL DEFAULT '{}',next_enqueue_at timestamp,timeout_quarantine_expires_at timestamp,
   legacy_disposition_id text,source_disposition_id text,error_message text,raw_payload jsonb NOT NULL DEFAULT '{}',private_secret text);
   CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id);
   CREATE TABLE webhook_execution_claims(id text PRIMARY KEY,kind text NOT NULL,semantic_key text NOT NULL,webhook_event_id text,
   execution_bot_id text,enforced boolean NOT NULL DEFAULT false,status "WebhookExecutionClaimStatus" NOT NULL DEFAULT 'PENDING',prepared_at timestamp,
   business_started_at timestamp,completed_at timestamp,lease_token text,lease_expires_at timestamp,command_result jsonb,private_secret text);
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
      const page = async (input = query()) => {
        await db.query(`BEGIN READ ONLY; SET LOCAL ROLE "${role}"`);
        try {
          const sql = buildOrderedAnchorPageSql(input),
            plan = (await db.query('EXPLAIN (FORMAT JSON) ' + sql)).rows[0]['QUERY PLAN'];
          const proof = validateOrderedAnchorPagePlan(plan, input);
          assert.equal(proof.relationProbes, 5);
          const result = JSON.parse((await db.query(sql)).rows[0].inventory_page);
          validateOrderedAnchorPage(result, request);
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
      const put = async (
        id,
        {
          status = 'FAILED',
          chat = '-123',
          at = '2026-10-08T00:00:00.000001Z',
          normalized,
          error = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:' + secret,
          semantic = null,
          retry = null,
          source = null,
          legacy = null,
        } = {},
      ) => {
        await db.query(
          `INSERT INTO webhook_events(id,status,created_at,normalized_payload,error_message,semantic_key,next_enqueue_at,source_disposition_id,legacy_disposition_id,bot_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'major-test')`,
          [
            id,
            status,
            at,
            normalized ?? {
              type: 'message_created',
              message: { chatId: chat, messageId: id, text: secret },
            },
            error,
            semantic,
            retry,
            source,
            legacy,
          ],
        );
      };
      const clear = async () =>
        db.query(
          "DELETE FROM webhook_events WHERE id NOT LIKE 'terminal_%'; DELETE FROM webhook_execution_claims WHERE id NOT LIKE 'retained_claim_%'",
        );
      await t.test(
        'one million terminal failures are absent from the exact ordered index scope',
        async () => {
          const { result } = await page();
          assert.equal(result.rawCount, 0);
          assert.equal(result.hasMore, false);
          assert.equal(result.nextCursor, null);
        },
      );
      await t.test(
        '401 anchors of mixed statuses in one chat retain all later anchors and exact sentinel cursors',
        async () => {
          await db.query(
            `INSERT INTO webhook_events(id,status,created_at,normalized_payload,error_message,bot_id)
   SELECT 'anchor_'||lpad(n::text,4,'0'),(ARRAY['FAILED','QUEUED','RECEIVED']::"WebhookStatus"[])[1+(n%3)],'2026-10-08T00:00:00.123456',
   jsonb_build_object('type','message_created','message',jsonb_build_object('chatId','-123','messageId','m_'||n,'text',$1::text)),
   'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'||$1::text,'major-test' FROM generate_series(1,401)n`,
            [secret],
          );
          const accumulator = createOrderedAnchorAccumulator(request),
            seen = [],
            counts = [];
          while (accumulator.nextRequest()) {
            const { result } = await page(accumulator.nextRequest());
            counts.push(result.rawCount);
            accumulator.addPage(result);
            seen.push(...result.rows.map((row) => row.id));
            assert(result.rows.every((row) => row.orderChatId === '-123' && row.ordered === true));
          }
          assert.deepEqual(counts, [201, 201, 1]);
          assert.equal(new Set(seen).size, 401);
          assert.equal(seen.at(-1), 'anchor_0401');
          assert.equal(accumulator.report().complete, true);
          assert.equal(accumulator.report().closedWorldComplete, false);
          await clear();
        },
      );
      await t.test(
        'chat boundaries, quote escaping and microsecond cutoff are handled by index conditions',
        async () => {
          for (const [index, chat] of ['-10', '-2', "quoted'chat", 'чат'].entries()) {
            await put('before_' + index, { chat, at: '2026-10-09T16:09:59.999999Z' });
            await put('at_' + index, { chat, at: cutoff });
            await put('after_' + index, { chat, at: '2026-10-09T16:10:00.000001Z' });
          }
          const first = (await page()).result;
          assert.equal(first.rows.length, 4);
          assert(first.rows.every((row) => row.id.startsWith('before_')));
          for (let i = 0; i < first.rows.length; i++) {
            const row = first.rows[i],
              after = { chatId: row.orderChatId, createdAt: row.createdAt, id: row.id };
            const next = (await page(query(after))).result;
            assert.deepEqual(
              next.rows.map((r) => r.id),
              first.rows.slice(i + 1).map((r) => r.id),
            );
          }
          await clear();
        },
      );
      await t.test(
        'NULL chat and nonmessage rows cannot enter scope; retries and released anchors remain',
        async () => {
          await put('null_chat', { normalized: { type: 'message_created' } });
          await put('lifecycle', { normalized: { type: 'bot_added', chatId: '-123' } });
          await put('ordinary', { error: 'ordinary terminal failure' });
          await put('processed', { status: 'PROCESSED' });
          await put('retry', {
            error: 'ordinary temporary failure',
            retry: '2026-10-09T16:00:00.000Z',
          });
          await put('released', { source: 'positive-proof' });
          await put('large', {
            normalized: {
              type: 'message_created',
              message: { chatId: '-123', messageId: 'large', text: 'X'.repeat(300000) },
            },
          });
          const { result } = await page();
          assert.deepEqual(
            new Set(result.rows.map((row) => row.id)),
            new Set(['retry', 'released', 'large']),
          );
          assert.equal(result.rows.find((row) => row.id === 'retry').ordered, true);
          assert.equal(result.rows.find((row) => row.id === 'released').sourceReleased, true);
          assert.equal(result.rows.find((row) => row.id === 'large').ordered, null);
          assert.equal(result.rows.find((row) => row.id === 'large').orderChatId, '-123');
          await clear();
        },
      );
      await t.test(
        'oversized indexed chat keys refuse without returning their contents',
        async () => {
          await put('oversize-chat', { chat: 'oversize-' + 'X'.repeat(5000) });
          const sql = buildOrderedAnchorPageSql(query()),
            plan = (await db.query('EXPLAIN (FORMAT JSON) ' + sql)).rows[0]['QUERY PLAN'];
          validateOrderedAnchorPagePlan(plan, query());
          const raw = JSON.parse((await db.query(sql)).rows[0].inventory_page);
          assert.equal(raw.rows.length, 1);
          assert.equal(raw.rows[0].orderChatId, null);
          assert.equal(raw.nextCursor.chatId, null);
          assert(!JSON.stringify(raw).includes('X'.repeat(100)));
          assert.throws(
            () => validateOrderedAnchorPage(raw, request),
            /ordered_inventory_refused/u,
          );
          await clear();
        },
      );
      await t.test(
        'actual semantic owners and conflicts are preserved without effect authority',
        async () => {
          await put('owner', { semantic: 'source_key' });
          await put('mirror', { status: 'RECEIVED', semantic: 'source_key' });
          await put('conflict', { semantic: 'source_key' });
          await db.query(`INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id,status,enforced,prepared_at,business_started_at)
   VALUES('source_claim','EXECUTION','source_key','owner','READY',true,'2026-10-08','2026-10-08'),('conflict_claim','EXECUTION','other_key','conflict','READY',true,'2026-10-08','2026-10-08');`);
          const { result } = await page();
          assert.equal(result.rows.find((row) => row.id === 'mirror').claim.ownerId, 'owner');
          assert.equal(result.rows.find((row) => row.id === 'conflict').claim.conflict, true);
          assert.equal(result.mutationAuthorized, false);
          await clear();
        },
      );
      await t.test(
        'plan guard refuses residual cutoff, changed cursor, base sorts/scans and missing probes',
        async () => {
          await put('guard');
          const input = query({
              chatId: '-123',
              createdAt: '2026-10-07T00:00:00.000001Z',
              id: 'before',
            }),
            { plan } = await page(input);
          for (const edit of [
            (nodes) => {
              nodes.find((n) => n['Relation Name']).Filter = 'unsafe';
            },
            (nodes) => {
              nodes.find((n) => n['Relation Name'])['Node Type'] = 'Seq Scan';
            },
            (nodes) => {
              nodes.find((n) => n['Index Name'] === 'webhook_events_ordered_chat_head_idx')[
                'Index Cond'
              ] = '(created_at < cutoff)';
            },
            (nodes) => {
              const n = nodes.find(
                (n) => n['Index Name'] === 'webhook_events_ordered_chat_head_idx',
              );
              n['Index Cond'] = n['Index Cond'].replace('16:10:00', '16:11:00');
            },
            (nodes) => {
              for (const n of nodes.filter((n) => n['Node Type'] === 'Limit')) n['Plan Rows'] = 999;
            },
          ]) {
            const changed = structuredClone(plan);
            edit(walk(changed[0].Plan));
            assert.throws(() => validateOrderedAnchorPagePlan(changed, input), /plan_refused/u);
          }
          await clear();
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
