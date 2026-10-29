import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  buildRecoveryKeyCohortAuditSql,
  validateRecoveryKeyCohortArguments,
  emitRecoveryKeyCohortAuditSql,
  recoveryKeyCohortStatusGuardSql,
} from './webhook-recovery-key-cohort-audit.mjs';

const statusGuardQuery = recoveryKeyCohortStatusGuardSql.split('\\gset')[0];
const migrationsRoot = new URL('../../apps/api/prisma/migrations/', import.meta.url);
const migratedStatusDdl = readdirSync(migrationsRoot)
  .sort()
  .filter((name) => /^\d/u.test(name))
  .flatMap(
    (name) =>
      readFileSync(new URL(`${name}/migration.sql`, migrationsRoot), 'utf8').match(
        /(?:CREATE TYPE "WebhookStatus" AS ENUM|ALTER TYPE "WebhookStatus" ADD VALUE)[^;]*;/gu,
      ) ?? [],
  );

test('status guard accepts actual immutable migration ordering and rejects incompatible public types', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const ready = async () =>
    (await db.query(statusGuardQuery)).rows[0].recovery_key_cohort_statuses_ready;
  await db.exec(migratedStatusDdl.join('\n'));
  assert.equal(await ready(), true, 'real migrations append QUEUED after FAILED');
  await db.exec('ALTER TYPE public."WebhookStatus" ADD VALUE \'UNSUPPORTED\'');
  assert.equal(await ready(), false, 'unknown statuses must fail closed');
  await db.exec('DROP TYPE public."WebhookStatus"');
  await db.exec(migratedStatusDdl.filter((sql) => !sql.includes("'QUARANTINED'")).join('\n'));
  assert.equal(await ready(), false, 'missing statuses must fail closed');
  await db.exec(
    'DROP TYPE public."WebhookStatus"; CREATE SCHEMA shadow; SET search_path TO shadow,public',
  );
  await db.exec(migratedStatusDdl.join('\n'));
  assert.equal(await ready(), false, 'a shadow type must not satisfy the public contract');
  await db.exec('CREATE DOMAIN public."WebhookStatus" AS text');
  assert.equal(await ready(), false, 'a non-enum public type must fail closed');
});

const fixture = `SET TIME ZONE 'UTC';
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED','QUEUED','PROCESSED','DUPLICATE','FAILED','NO_REPLAY_HELD','CANCELLED','QUARANTINED');
CREATE TYPE "WebhookExecutionClaimStatus" AS ENUM ('PENDING','READY','COMPLETED');
CREATE TABLE webhook_events (id text PRIMARY KEY,status "WebhookStatus" NOT NULL,created_at timestamp(3) NOT NULL,
  normalized_payload jsonb,bot_id text,semantic_key text,error_message text,processed_at timestamp(3),execution_deadline_at timestamp(3),
  source_disposition_id text,legacy_disposition_id text);
CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id);
CREATE TABLE webhook_dependency_quarantines (receipt_id text NOT NULL,blocker_id text NOT NULL,anchor_id text NOT NULL,
  state text NOT NULL,created_at timestamp(3) NOT NULL,deadline_at timestamp(3) NOT NULL,resolved_at timestamp(3),
  PRIMARY KEY(receipt_id,blocker_id));
CREATE TABLE webhook_execution_claims(id text PRIMARY KEY,kind text NOT NULL,semantic_key text NOT NULL,webhook_event_id text,
  status "WebhookExecutionClaimStatus" NOT NULL,enforced boolean NOT NULL,prepared_at timestamp(3),business_started_at timestamp(3),
  completed_at timestamp(3),command_result jsonb,lease_token text,lease_expires_at timestamp(3));
CREATE UNIQUE INDEX webhook_execution_claims_kind_semantic_key ON webhook_execution_claims(kind,semantic_key);
CREATE INDEX webhook_execution_claims_event_kind_idx ON webhook_execution_claims(webhook_event_id,kind);`;
const from = '2026-01-01T00:00:00Z';
const created = '2026-01-01 00:00:01';
const query = buildRecoveryKeyCohortAuditSql(from, '-101,-202,-303');
const normalized = (chat, mid = 'private-mid') =>
  JSON.stringify({
    type: 'message_created',
    message: { chatId: chat, messageId: mid },
    raw: { text: 'PRIVATE_TEXT_DO_NOT_EMIT' },
  });
async function localDb(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  return db;
}
async function receipt(db, id, status, chat, mid = id, extra = {}) {
  await db.query(
    `INSERT INTO webhook_events(id,status,created_at,normalized_payload,semantic_key,error_message,bot_id,execution_deadline_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'2026-01-01 00:05:00')`,
    [
      id,
      status,
      created,
      normalized(chat, mid),
      Object.hasOwn(extra, 'semantic') ? extra.semantic : `message:message_created:${chat}:${mid}`,
      extra.error ?? null,
      Object.hasOwn(extra, 'bot') ? extra.bot : 'private-bot',
    ],
  );
}
async function journal(db, id, state = 'WAITING', blocker = 'old-source') {
  await db.query(
    `INSERT INTO webhook_dependency_quarantines(receipt_id,blocker_id,anchor_id,state,created_at,deadline_at,resolved_at)
    VALUES($1,$2,$2,$3,'2026-01-01 00:00:02','2026-01-01 00:05:00',$4)`,
    [id, blocker, state, state === 'WAITING' ? null : '2026-01-01 00:06:00'],
  );
}
async function report(db, q = query) {
  return (await db.query(q)).rows[0].json_build_object;
}

test('strict private CSV and exact UTC anchor reject injection, normalization, duplicates and oversize', () => {
  assert.deepEqual(validateRecoveryKeyCohortArguments(from, '-101,-202'), ['-101', '-202']);
  for (const bad of [
    '',
    '-0',
    '1',
    '-101, -202',
    '-101,-101',
    "-1'); SELECT 1; --",
    Array.from({ length: 129 }, (_, i) => `-${i + 1}`).join(','),
  ])
    assert.throws(() => validateRecoveryKeyCohortArguments(from, bad));
  for (const bad of [
    '0000-01-01T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01 00:00:00Z',
    '2026-01-01T00:00:00+00:00',
  ])
    assert.throws(() => validateRecoveryKeyCohortArguments(bad, '-101'));
  assert.throws(() => buildRecoveryKeyCohortAuditSql(from, '-101', '--analyze'));
});

test('all statuses counted; source identities, text, arbitrary keys and hashes do not leave output', async (t) => {
  const db = await localDb(t);
  for (const status of [
    'RECEIVED',
    'QUEUED',
    'PROCESSED',
    'DUPLICATE',
    'FAILED',
    'NO_REPLAY_HELD',
    'CANCELLED',
    'QUARANTINED',
  ])
    await receipt(db, `private-${status}`, status, '-101');
  await journal(db, 'private-QUARANTINED');
  const r = await report(db);
  assert.equal(r.window_closed, true);
  assert.equal(r.status_rows.length, 8);
  assert.deepEqual(
    r.status_rows.map((x) => x.count_lower_bound),
    Array(8).fill(1),
  );
  assert.equal(r.sampled_receipts, 8);
  assert.equal(r.scopes[0].saved_message_key_receipts, 8);
  assert.equal(r.scopes[0].activity, 'BLOCKED_FRESH');
  assert.equal(r.execution_progress, 'UNPROVED');
  assert.equal(r.remote_effects_proven, false);
  assert.equal(r.scopes[1].activity, 'NO_FRESH_MESSAGE_OBSERVED');
  assert.doesNotMatch(
    JSON.stringify(r),
    /private-|PRIVATE_TEXT|-101|-202|-303|chat_id|message_id|sender|hash/u,
  );
  const plan = await db.query(buildRecoveryKeyCohortAuditSql(from, '-101,-202,-303', true));
  assert.doesNotMatch(JSON.stringify(plan.rows), /private-|PRIVATE_TEXT|-101|-202|-303/u);
});

test('fresh WAITING and EXPIRED impact survives status settlement and source completion', async (t) => {
  const db = await localDb(t);
  await receipt(db, 'waiting', 'QUARANTINED', '-101');
  await journal(db, 'waiting');
  await receipt(db, 'expired', 'PROCESSED', '-202');
  await journal(db, 'expired', 'EXPIRED');
  await db.exec(`INSERT INTO webhook_events(id,status,created_at,normalized_payload,semantic_key,processed_at)
    VALUES('old-source','PROCESSED','2025-12-31 00:00:00','{}','old-semantic','2026-01-01 00:07:00');`);
  const r = await report(db);
  assert.equal(r.scopes[0].activity, 'BLOCKED_FRESH');
  assert.equal(r.scopes[1].activity, 'BLOCKED_FRESH');
  assert.equal(r.scopes[1].expired_receipts_lower_bound, 1);
  assert.equal(r.scopes[1].started_unfinished_blocker_metadata_lower_bound, 0);
  assert.equal(r.scopes[2].activity, 'NO_FRESH_MESSAGE_OBSERVED');
});

test('scope uncertainty/cap never erases positive blocks and never proves zero traffic', async (t) => {
  const db = await localDb(t);
  await receipt(db, 'blocked', 'QUARANTINED', '-101');
  await journal(db, 'blocked');
  await db.exec(`INSERT INTO webhook_events(id,status,created_at,normalized_payload) VALUES
    ('unassignable','PROCESSED','${created}','{"type":"message_created","message":{"chatId":-202}}');
    INSERT INTO webhook_events(id,status,created_at,normalized_payload)
      SELECT 'cap-'||n,'RECEIVED','${created}','{"type":"bot_started"}'::jsonb FROM generate_series(1,513)n;`);
  const r = await report(db);
  assert.equal(r.receipt_selection_complete, false);
  assert.equal(r.saved_key_scope_assignment_complete, false);
  assert.equal(r.scopes[0].activity, 'BLOCKED_FRESH');
  assert.equal(r.scopes[1].activity, 'COVERAGE_UNKNOWN');
  assert.equal(r.scopes[2].activity, 'COVERAGE_UNKNOWN');
});

test('dormant, Publisher, duplicates and PROCESSED do not imply execution progress', async (t) => {
  const db = await localDb(t);
  await receipt(db, 'dormant', 'PROCESSED', '-101', 'shared', {
    error: 'DORMANT_BOT_OBSERVATION_V1',
  });
  await receipt(db, 'publisher', 'PROCESSED', '-101', 'shared', {
    semantic: 'publisher-observation:v1:private-bot:message:message_created:-101:shared',
  });
  await receipt(db, 'duplicate', 'DUPLICATE', '-101', 'shared');
  await receipt(db, 'normal', 'PROCESSED', '-101', 'shared');
  const r = await report(db);
  assert.equal(r.scopes[0].dormant_receipts, 1);
  assert.equal(r.scopes[0].publisher_observation_receipts, 1);
  assert.equal(r.scopes[0].saved_created_key_receipts, 4);
  assert.equal(r.all_accepted_message_scope_coverage, 'UNPROVED');
  assert.equal(r.scopes[0].activity, 'PENDING_PROGRESS_UNPROVED');
  assert.equal(r.execution_progress, 'UNPROVED');
});

test('unsupported saved keys keep scoped zeros unknown; blocker cap is explicit', async (t) => {
  const db = await localDb(t);
  await db.query(
    `INSERT INTO webhook_events(id,status,created_at,normalized_payload)
    VALUES('private-uninspected','PROCESSED',$1,$2)`,
    [
      created,
      JSON.stringify({
        type: 'message_created',
        message: { chatId: '-202', messageId: 'private' },
        privateText: 'x'.repeat(20000),
      }),
    ],
  );
  for (let n = 0; n < 17; n++) {
    await receipt(db, `private-many-${n}`, 'PROCESSED', '-101');
    for (let k = 0; k < 4; k++)
      await journal(
        db,
        `private-many-${n}`,
        'RELEASED',
        `private-old-${String(n * 4 + k).padStart(3, '0')}`,
      );
  }
  const r = await report(db);
  assert.equal(r.saved_key_scope_assignment_complete, false);
  assert.equal(r.blocker_probe_truncated, true);
  assert.equal(r.scopes[0].blocker_probes_missing_or_omitted, 68);
  assert.equal(r.scopes[0].activity, 'COVERAGE_UNKNOWN');
  assert.equal(r.scopes[1].activity, 'COVERAGE_UNKNOWN');
  assert.doesNotMatch(JSON.stringify(r), /private-|xxxx/u);
});

test('missing journal, corrupt clocks and fifth link retain UNKNOWN; bounded owner metadata is separate', async (t) => {
  const db = await localDb(t);
  await receipt(db, 'missing', 'QUARANTINED', '-202');
  await receipt(db, 'owner-metadata', 'QUARANTINED', '-101');
  await journal(db, 'owner-metadata');
  await receipt(db, 'five-links', 'PROCESSED', '-303');
  for (let n = 0; n < 5; n++) await journal(db, 'five-links', 'RELEASED', `other-source-${n}`);
  await db.exec(`INSERT INTO webhook_events(id,status,created_at,normalized_payload,semantic_key)
    VALUES('old-source','FAILED','2025-12-31 00:00:00','{}','old-semantic');
    INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id,status,enforced,prepared_at,business_started_at)
    VALUES('claim','EXECUTION','old-semantic','old-source','READY',true,'2025-12-31 00:00:00','2025-12-31 00:00:01');`);
  const r = await report(db);
  assert.equal(r.scopes[0].started_unfinished_blocker_metadata_lower_bound, 1);
  assert.equal(r.scopes[0].activity, 'BLOCKED_FRESH');
  assert.equal(r.scopes[1].activity, 'COVERAGE_UNKNOWN');
  assert.equal(r.scopes[2].activity, 'COVERAGE_UNKNOWN');
  await db.exec(`UPDATE webhook_dependency_quarantines SET resolved_at='2026-01-01 00:00:03';`);
  assert.equal((await report(db)).scopes[0].activity, 'COVERAGE_UNKNOWN');
});

test('blocked receipt clock partitions preserve expired-before-receipt impact without policy inference', async (t) => {
  const db = await localDb(t);
  await receipt(db, 'expired-before', 'QUARANTINED', '-101');
  await receipt(db, 'expired-exactly', 'QUARANTINED', '-101');
  await receipt(db, 'deadline-live', 'QUARANTINED', '-101');
  await journal(db, 'expired-before', 'EXPIRED');
  await journal(db, 'expired-exactly', 'WAITING');
  await journal(db, 'deadline-live', 'WAITING');
  await journal(db, 'deadline-live', 'EXPIRED', 'another-source');
  await db.exec(`UPDATE webhook_events SET execution_deadline_at='2025-12-31 23:59:00' WHERE id='expired-before';
    UPDATE webhook_dependency_quarantines SET deadline_at='2025-12-31 23:59:00' WHERE receipt_id='expired-before';
    UPDATE webhook_events SET execution_deadline_at=created_at WHERE id='expired-exactly';
    UPDATE webhook_dependency_quarantines SET deadline_at='${created}' WHERE receipt_id='expired-exactly';`);
  const r = await report(db);
  const scope = r.scopes[0];
  assert.equal(scope.blocked_fresh_receipts_lower_bound, 3);
  assert.equal(scope.blocked_already_expired_at_receipt_lower_bound, 2);
  assert.equal(scope.blocked_deadline_live_at_receipt_lower_bound, 1);
  assert.equal(
    scope.blocked_already_expired_at_receipt_lower_bound +
      scope.blocked_deadline_live_at_receipt_lower_bound,
    scope.blocked_fresh_receipts_lower_bound,
  );
  assert.equal(scope.activity, 'BLOCKED_FRESH');
  assert.equal(r.execution_progress, 'UNPROVED');
  assert.equal(r.remote_effects_proven, false);
  assert.equal(r.scopes[1].blocked_already_expired_at_receipt_lower_bound, 0);
  assert.equal(r.scopes[1].blocked_deadline_live_at_receipt_lower_bound, 0);
});

test('future/unclosed windows produce no sampled receipts or healthy/no-traffic claim', async (t) => {
  const db = await localDb(t);
  const r = await report(db, buildRecoveryKeyCohortAuditSql('2099-01-01T00:00:00Z', '-101'));
  assert.equal(r.window_closed, false);
  assert.equal(r.sampled_receipts, 0);
  assert.equal(r.scopes[0].activity, 'COVERAGE_UNKNOWN');
  const guarded = emitRecoveryKeyCohortAuditSql(from, '-101', true);
  assert.match(guarded, /SET LOCAL search_path TO pg_catalog, public, pg_temp/u);
  assert.match(guarded, /quarantine_proof_indexes_ready/u);
  assert.match(guarded, /EXPLAIN \(FORMAT JSON\) WITH/u);
  assert.doesNotMatch(guarded, /EXPLAIN[^\n]*ANALYZE/u);
});

const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim() ?? '';
let nativeLocal = false;
try {
  nativeLocal = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(nativeUrl).hostname);
} catch {
  // FLAG: An absent or invalid local test URL keeps native coverage explicitly skipped.
}
test(
  'native PG16: 50k history and exact indexed bounded PK/journal access',
  { skip: !nativeLocal },
  async (t) => {
    const client = new pg.Client({ connectionString: nativeUrl });
    await client.connect();
    const schema = `recovery_key_candidate_${process.pid}`;
    t.after(async () => {
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await client.end();
      }
    });
    assert.equal(
      (await client.query(statusGuardQuery)).rows[0].recovery_key_cohort_statuses_ready,
      true,
      'the public enum installed by actual migrations must pass before using the isolated fixture',
    );
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},public;`);
    await client.query(fixture);
    await client.query(`INSERT INTO webhook_events(id,status,created_at,normalized_payload)
    SELECT 'old-'||n,'PROCESSED','2025-01-01','{}'::jsonb FROM generate_series(1,50000)n;
    ANALYZE webhook_events; SET enable_seqscan=off; SET enable_bitmapscan=off;
    SET max_parallel_workers_per_gather=0; SET work_mem='1MB'; SET statement_timeout='2500ms';`);
    await receipt(client, 'native-current', 'QUARANTINED', '-101');
    await journal(client, 'native-current');
    const r = await report(client);
    assert.equal(r.scopes[0].activity, 'BLOCKED_FRESH');
    const plan = (await client.query(buildRecoveryKeyCohortAuditSql(from, '-101,-202,-303', true)))
      .rows[0]['QUERY PLAN'];
    const encoded = JSON.stringify(plan);
    assert.doesNotMatch(encoded, /"Node Type":"(?:Seq Scan|Bitmap Heap Scan|Bitmap Index Scan)"/u);
    assert.match(encoded, /webhook_events_status_created_at_id_idx/u);
    assert.match(encoded, /webhook_events_pkey/u);
    assert.match(encoded, /webhook_dependency_quarantines_pkey/u);
  },
);

test('saved key framing and exact Publisher bot prefix retain scope without claiming source equivalence', async (t) => {
  const db = await localDb(t);
  for (const [id, key, bot] of [
    ['created', 'message:message_created:-101:colon:any:arbitrary:tail', 'bot'],
    ['edited', 'message:message_edited:-101:any:edit:tail', 'bot'],
    [
      'publisher',
      'publisher-observation:v1:bot:with:colons:message:message_edited:-101:arbitrary:tail',
      '\u00a0 bot:with:colons \ufeff',
    ],
    ['ordinary-publisher-role', 'message:message_created:-101:saved', 'publisher-role'],
    ['bad-chat', 'message:message_created:-01:tail', 'bot'],
    ['empty-tail', 'message:message_edited:-101:', 'bot'],
    ['trimmed', ' message:message_created:-101:x', 'bot'],
    ['controls', 'message:message_created:-101:x\n', 'bot'],
    ['mismatch', 'publisher-observation:v1:other:message:message_created:-101:x', 'bot'],
    ['no-bot', 'publisher-observation:v1:bot:message:message_created:-101:x', null],
    ['null-key', null, 'bot'],
  ])
    await receipt(db, id, 'PROCESSED', '-101', id, { semantic: key, bot });
  const r = await report(db);
  assert.equal(r.sampled_receipts, 11);
  assert.equal(r.scopes[0].saved_message_key_receipts, 4);
  assert.equal(r.scopes[0].saved_created_key_receipts, 2);
  assert.equal(r.scopes[0].saved_edited_key_receipts, 2);
  assert.equal(r.scopes[0].publisher_observation_receipts, 1);
  assert.equal(r.key_attribution_counts.assigned, 4);
  for (const [k, n] of Object.entries({
    absent: 1,
    untrimmed: 1,
    control_bearing: 1,
    unsupported_framing: 2,
    publisher_prefix_mismatch: 1,
    publisher_bot_unavailable: 1,
  }))
    assert.equal(r.key_attribution_counts[k], n, k);
  assert.equal(r.saved_key_scope_assignment_unknown_receipts, 7);
  assert.equal(r.normalized_crosscheck, 'NOT_EVALUATED');
  assert.equal(r.all_accepted_message_scope_coverage, 'UNPROVED');
  assert.doesNotMatch(
    JSON.stringify(r),
    /arbitrary|colon|bot:with|other|publisher-role|message_created|-101/u,
  );
});

test('all 97 private scopes fit one deterministic request and no source body expression exists', async (t) => {
  const csv = Array.from({ length: 97 }, (_, i) => `-${i + 1}`).join(',');
  assert.equal(validateRecoveryKeyCohortArguments(from, csv).length, 97);
  const sql = buildRecoveryKeyCohortAuditSql(from, csv);
  assert.doesNotMatch(sql, /raw_payload|normalized_payload|jsonb_|SELECT\s+\*|[a-z]\.\*/u);
  assert.ok(sql.indexOf('LIMIT 513') < sql.indexOf('JOIN requested'));
  const db = await localDb(t);
  const r = await report(db, sql);
  assert.equal(r.scopes.length, 97);
  assert.equal(r.scopes[96].scope_ordinal, 97);
  assert.equal(
    r.scopes.every((x) => x.activity === 'NO_FRESH_MESSAGE_OBSERVED'),
    true,
  );
  assert.equal(r.execution_progress, 'UNPROVED');
});
