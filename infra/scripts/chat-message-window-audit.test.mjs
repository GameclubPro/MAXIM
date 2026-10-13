import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  buildChatMessageWindowAuditSql,
  validateChatMessageWindow,
} from './chat-message-window-audit.mjs';

const minute = '2026-10-13T19:33:00Z';
const fixture = `CREATE TYPE "WebhookStatus" AS ENUM
  ('RECEIVED','QUEUED','PROCESSED','DUPLICATE','FAILED','NO_REPLAY_HELD','CANCELLED','QUARANTINED');
CREATE TABLE webhook_events (
 id text PRIMARY KEY, status "WebhookStatus" NOT NULL, created_at timestamp(3) NOT NULL,
 processed_at timestamp(3), queued_at timestamp(3), normalized_payload jsonb, raw_payload jsonb, error_message text
);
CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status, created_at, id);
CREATE TABLE moderation_delete_intents (
 id text PRIMARY KEY DEFAULT 'intent',
 chat_id text NOT NULL, message_id text NOT NULL, status text NOT NULL, attempt_count integer DEFAULT 0,
 last_status_code integer, delete_dispatch_started_at timestamp, remote_delete_succeeded_at timestamp,
 completed_at timestamp, retry_until_at timestamp, last_attempt_at timestamp, next_attempt_at timestamp
);
CREATE UNIQUE INDEX moderation_delete_intents_chat_message_key ON moderation_delete_intents(chat_id, message_id);
CREATE TABLE moderation_delete_intent_reasons (intent_id text, reason_key text, rule_code text);
CREATE UNIQUE INDEX moderation_delete_intent_reasons_intent_reason_key ON moderation_delete_intent_reasons(intent_id, reason_key);`;
const hash = (s) => createHash('md5').update(s).digest('hex');

test('requires an exact valid UTC minute and rejects SQL, paths and overflowing dates', () => {
  validateChatMessageWindow('-123', minute);
  for (const chat of ['1', '-0', "-1'; SELECT 1", '/tmp/query.sql', '-123\n']) {
    assert.throws(() => validateChatMessageWindow(chat, minute));
  }
  for (const time of [
    '2026-02-30T00:00:00Z',
    '2026-10-13T19:33:01Z',
    '2026-10-13T22:33:00+03:00',
    'SELECT 1',
  ]) {
    assert.throws(() => validateChatMessageWindow('-123', time));
  }
});

test('isolates the chat and minute, preserves receipt outcomes and omits private content', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  async function add(id, chat, time, status, error, types) {
    await db.query(
      `INSERT INTO webhook_events
      (id, status, created_at, normalized_payload, raw_payload, error_message)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
      [
        id,
        status,
        time,
        JSON.stringify({
          type: 'message_created',
          message: { chatId: chat, messageId: id, senderId: 'private-user' },
        }),
        JSON.stringify({
          message: {
            body: {
              text: 'private-content',
              attachments: types.map((type) => ({ type, payload: { url: 'private-url' } })),
            },
          },
        }),
        error,
      ],
    );
  }
  await add('private-voice', '-123', '2026-10-13T19:33:10Z', 'PROCESSED', null, ['audio']);
  await add(
    'private-dormant',
    '-123',
    '2026-10-13T19:33:11Z',
    'PROCESSED',
    'DORMANT_BOT_OBSERVATION_V1',
    ['voice'],
  );
  await add('private-held', '-123', '2026-10-13T19:33:12Z', 'QUARANTINED', 'private-error', [
    'private-type',
  ]);
  await add('private-neighbor', '-456', '2026-10-13T19:33:13Z', 'FAILED', null, ['audio']);
  await add('private-end', '-123', '2026-10-13T19:34:00Z', 'FAILED', null, []);
  const report = (await db.query(buildChatMessageWindowAuditSql('-123', minute))).rows[0]
    .json_build_object;
  assert.equal(report.matched_receipts, 3);
  assert.equal(report.sampled_receipts, 4);
  assert.equal(report.sample_truncated, false);
  assert.equal(report.remote_effect_proven, false);
  assert.equal(report.policy_checked, false);
  assert.deepEqual(
    report.rows.map((x) => x.status),
    ['PROCESSED', 'PROCESSED', 'QUARANTINED'],
  );
  assert.equal(report.rows[0].message_hash, hash('private-voice'));
  assert.deepEqual(report.rows[0].raw_attachment_types, ['audio']);
  assert.equal(report.rows[1].diagnostic_family, 'dormant_observation');
  assert.equal(report.rows[2].diagnostic_family, 'other');
  assert.deepEqual(report.rows[2].raw_attachment_types, ['other']);
  assert.doesNotMatch(
    JSON.stringify(report),
    /private-|raw_payload|normalized_payload|senderId|chatId/u,
  );
});

test('reads the source moderation consumed when independent raw sampling omitted the body', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.query(
    `INSERT INTO webhook_events
    (id,status,created_at,normalized_payload,raw_payload) VALUES
    ('voice','PROCESSED','2026-10-13 19:33:20',$1::jsonb,'{}')`,
    [
      JSON.stringify({
        type: 'message_created',
        message: { chatId: '-123', messageId: 'private-voice' },
        raw: {
          message: { body: { attachments: [{ type: 'audio', payload: { url: 'private-url' } }] } },
        },
      }),
    ],
  );
  const report = (await db.query(buildChatMessageWindowAuditSql('-123', minute))).rows[0]
    .json_build_object;
  assert.equal(report.rows[0].source_basis, 'normalized_raw');
  assert.deepEqual(report.rows[0].raw_attachment_types, ['audio']);
  assert.doesNotMatch(JSON.stringify(report), /private-/u);
});

test('keeps an admitted delete distinct from dispatch and remote success', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events (id,status,created_at,normalized_payload)
    VALUES ('source','PROCESSED','2026-10-13 19:33:20','{"message":{"chatId":"-123","messageId":"private-voice"}}');
    INSERT INTO moderation_delete_intents (chat_id,message_id,status,attempt_count,last_status_code)
    VALUES ('-123','private-voice','WAITING_CAPABILITY',2,200);
    INSERT INTO moderation_delete_intent_reasons VALUES ('intent','private-reason','VOICE_BLOCKED_DELETE');`);
  const report = (await db.query(buildChatMessageWindowAuditSql('-123', minute))).rows[0]
    .json_build_object;
  assert.equal(report.rows[0].delete_intent.status, 'WAITING_CAPABILITY');
  assert.equal(report.rows[0].delete_intent.dispatch_started_at, null);
  assert.equal(report.rows[0].delete_intent.remote_succeeded_at, null);
  assert.deepEqual(report.rows[0].delete_intent.reason_sample, {
    voice_blocked: true,
    truncated: false,
  });
  assert.equal(report.remote_effect_proven, false);
  assert.doesNotMatch(JSON.stringify(report), /private-voice/u);
});

test('reports omitted receipts and bounds attachment projection even with malformed payloads', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events (id,status,created_at,normalized_payload,raw_payload)
    SELECT 'row-'||lpad(n::text,4,'0'),'PROCESSED','2026-10-13 19:33:10',
      '{"type":"message_created","message":{"chatId":"-123"}}'::jsonb,
      CASE WHEN n=1 THEN '{"message":{"body":{"attachments":{}}}}'::jsonb
      ELSE jsonb_build_object('message',jsonb_build_object('body',jsonb_build_object('attachments',
        (SELECT jsonb_agg(jsonb_build_object('type','audio')) FROM generate_series(1,40))))) END
    FROM generate_series(1,513) n;`);
  const report = (await db.query(buildChatMessageWindowAuditSql('-123', minute))).rows[0]
    .json_build_object;
  assert.equal(report.sampled_receipts, 512);
  assert.equal(report.sample_truncated, true);
  assert.deepEqual(report.rows[0].raw_attachment_types, []);
  assert.equal(report.rows[1].raw_attachment_types.length, 32);
  assert.equal(report.rows[1].attachments_truncated, true);
});

const native = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
test(
  'native retained-history plan bounds index heads before JSON reads',
  { skip: !native },
  async (t) => {
    const url = new URL(native);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    const client = new pg.Client({ connectionString: native });
    await client.connect();
    t.after(async () => {
      try {
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    });
    await client.query('BEGIN');
    // FLAG: Disposable transaction-local schema isolates this fixture from other native suites.
    const schema = `message_window_${process.pid}`;
    await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}; ${fixture}`);
    await client.query(`INSERT INTO webhook_events (id,status,created_at,normalized_payload)
    SELECT 'history-'||n, 'PROCESSED', '2026-10-12 00:00:00'::timestamp + n*interval '1 ms',
      '{"message":{"chatId":"-123"}}'::jsonb FROM generate_series(1,20000) n;
    INSERT INTO webhook_events (id,status,created_at,normalized_payload)
    VALUES ('current','PROCESSED','2026-10-13 19:33:10','{"message":{"chatId":"-123"}}');
    ANALYZE webhook_events;`);
    const sql = buildChatMessageWindowAuditSql('-123', minute);
    const plan = (await client.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + sql)).rows[0][
      'QUERY PLAN'
    ][0].Plan;
    const nodes = [];
    const walk = (n) => {
      nodes.push(n);
      for (const child of n.Plans ?? []) walk(child);
    };
    walk(plan);
    assert.ok(nodes.some((n) => n['Index Name'] === 'webhook_events_status_created_at_id_idx'));
    assert.ok(
      nodes
        .filter((n) => n['Relation Name'] === 'webhook_events')
        .every(
          (n) =>
            n['Node Type'] !== 'Seq Scan' &&
            (n['Actual Rows'] + (n['Rows Removed by Filter'] ?? 0)) * n['Actual Loops'] <= 4096,
        ),
    );
    assert.equal((await client.query(sql)).rows[0].json_build_object.matched_receipts, 1);
  },
);
