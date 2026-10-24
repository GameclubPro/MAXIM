import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  buildQuarantineProofAuditSql,
  emitQuarantineProofAuditSql,
  quarantineProofIndexesSql,
  QUARANTINE_PROOF_COMMAND_RESULT_MAX_BYTES,
  QUARANTINE_PROOF_ERROR_MAX_BYTES,
} from './webhook-quarantine-proof-audit.mjs';
import {
  buildQuarantinePrivilegesSql,
  QUARANTINE_AUDIT_COLUMNS,
} from './webhook-quarantine-audit.mjs';
import { OWNER_PROOF_COLUMNS, ownerProofPrivilegesSql } from './webhook-owner-proof-audit.mjs';

const minute = '2026-10-15T01:37:00Z';
const privateValue = 'PRIVATE_MUST_NOT_LEAVE_REPORT';
const marker = {
  kind: 'EXECUTION_FINISHED',
  authorityVersion: 'semantic-owner-lease-v1',
  webhookEventId: 'private-blocker',
  semanticKey: 'private-key',
  executionBotId: null,
  businessStartedAt: '2026-10-14T01:00:02.000Z',
  finishedAt: '2026-10-14T01:00:03.000Z',
};
const fixtureSql = `SET TIME ZONE 'UTC';
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED','QUEUED','PROCESSED','DUPLICATE','FAILED','NO_REPLAY_HELD','CANCELLED','QUARANTINED');
CREATE TYPE "WebhookExecutionClaimStatus" AS ENUM ('PENDING','READY','COMPLETED');
CREATE TABLE webhook_events(id text PRIMARY KEY, semantic_key text, status "WebhookStatus", created_at timestamp(3),
  processed_at timestamp(3), error_message text, next_enqueue_at timestamp(3),
  timeout_quarantine_expires_at timestamp(3), execution_deadline_at timestamp(3), private_content text);
CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id);
CREATE TABLE webhook_dependency_quarantines(receipt_id text, blocker_id text, anchor_id text, state text,
  deadline_at timestamp(3), created_at timestamp(3), next_check_at timestamp(3), resolved_at timestamp(3),
  private_content text, PRIMARY KEY(receipt_id,blocker_id));
CREATE TABLE webhook_execution_claims(id text PRIMARY KEY, kind text, semantic_key text, webhook_event_id text,
  execution_bot_id text, enforced boolean, status "WebhookExecutionClaimStatus", prepared_at timestamp(3), business_started_at timestamp(3),
  completed_at timestamp(3), lease_token text, lease_expires_at timestamp(3), command_result jsonb, private_content text);
CREATE UNIQUE INDEX webhook_execution_claims_kind_semantic_key ON webhook_execution_claims(kind,semantic_key);
CREATE INDEX webhook_execution_claims_event_kind_idx ON webhook_execution_claims(webhook_event_id,kind);
CREATE TABLE max_action_ledger(${OWNER_PROOF_COLUMNS.max_action_ledger.map((column) => `${column} text`).join(',')}, private_content text);`;

async function seed(db) {
  await db.exec(`INSERT INTO webhook_events(id,semantic_key,status,created_at,error_message) VALUES
    ('private-receipt','private-key','QUARANTINED','2026-10-15 01:37:45',NULL),
    ('private-blocker','private-key','FAILED','2026-10-14 01:00:00','${privateValue}');
    INSERT INTO webhook_dependency_quarantines(receipt_id,blocker_id,anchor_id,state)
      VALUES('private-receipt','private-blocker','private-blocker','WAITING');`);
  await db.query(
    `INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id,execution_bot_id,enforced,status,
      prepared_at,business_started_at,lease_token,lease_expires_at,command_result)
    VALUES('private-claim','EXECUTION','private-key','private-blocker',NULL,true,'READY',
      '2026-10-14 01:00:01','2026-10-14 01:00:02',$1,'2099-01-01',$2)`,
    [privateValue, JSON.stringify(marker)],
  );
}
async function fixture(t, seeded = true) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixtureSql);
  if (seeded) await seed(db);
  return db;
}
async function report(db, selectedMinute = minute, preamble = '') {
  await db.exec('BEGIN READ ONLY');
  try {
    if (preamble) await db.exec(preamble);
    const value = (await db.query(buildQuarantineProofAuditSql(selectedMinute))).rows[0]
      .json_build_object;
    assert.equal(value.read_only, true);
    assert.equal(value.authority, 'DIAGNOSTICS_ONLY');
    assert.equal(value.replay_authorized, false);
    assert.equal(value.settlement_authorized, false);
    assert.equal(value.remote_effects_proven, false);
    assert.equal(value.effect_completeness, 'unknown');
    assert.equal(value.semantic_source_rebuild, 'not_evaluated');
    assert.equal(value.finished_timestamp_validation, 'not_evaluated');
    assert.equal(value.send_delete_sanction_coverage, 'not_evaluated');
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|private-/u);
    return value;
  } finally {
    await db.exec('ROLLBACK');
  }
}
const firstClaim = (value) => value.blockers[0].claims[0];
const walk = (node) => [node, ...(node.Plans ?? []).flatMap(walk)];

test('quarantine proof admits only exact minute args and emits all guards before SELECT or plain EXPLAIN', () => {
  for (const invalid of [
    '',
    null,
    '2026-02-30T01:00:00Z',
    '2026-10-15T01:37:01Z',
    '2026-10-15T01:37:00+00:00',
    '/tmp/query.sql',
    "2026-10-15'; SELECT 1",
  ]) {
    assert.throws(() => buildQuarantineProofAuditSql(invalid));
  }
  for (const explain of [false, true]) {
    const sql = emitQuarantineProofAuditSql(minute, explain);
    const queryAt = sql.indexOf(explain ? 'EXPLAIN (FORMAT JSON)' : 'WITH bounds');
    assert.ok(
      sql.indexOf('SET LOCAL search_path TO pg_catalog, public, pg_temp;') <
        sql.indexOf('WITH effective'),
    );
    for (const guard of [
      'quarantine_audit_privileges_ready',
      'owner_proof_privileges_ready',
      'quarantine_proof_indexes_ready',
    ])
      assert.ok(sql.indexOf(guard) < queryAt);
    assert.doesNotMatch(sql, /EXPLAIN ANALYZE|FOR UPDATE|normalized_payload|raw_payload/u);
    // The reused grant helper names the ledger; the report itself never reads it.
    assert.doesNotMatch(buildQuarantineProofAuditSql(minute), /max_action_ledger/u);
  }
  const entry = new URL('./webhook-quarantine-proof-audit.mjs', import.meta.url);
  for (const args of [[], [minute, '--repair'], [minute, '--explain', 'extra'], [privateValue]]) {
    const child = spawnSync(process.execPath, [entry.pathname, ...args], { encoding: 'utf8' });
    assert.equal(child.status, 2);
    assert.equal(child.stdout, '');
    assert.equal(
      child.stderr,
      'Usage: webhook-quarantine-proof-audit.mjs <UTC-minute> [--explain] [--private-blocker-ids]\n',
    );
  }
});

test('private blocker nomination exposes only capped opaque IDs without changing proof or authority', async (t) => {
  const db = await fixture(t);
  const ordinary = await report(db);
  await db.exec('BEGIN READ ONLY');
  try {
    const value = (await db.query(buildQuarantineProofAuditSql(minute, false, true))).rows[0]
      .json_build_object;
    assert.equal(value.blockers[0].private_blocker_receipt_id, 'private-blocker');
    delete value.blockers[0].private_blocker_receipt_id;
    assert.ok(Date.parse(value.observed_at) >= Date.parse(ordinary.observed_at));
    value.observed_at = ordinary.observed_at;
    assert.deepEqual(value, ordinary);
  } finally {
    await db.exec('ROLLBACK');
  }
  for (const invalid of ['x'.repeat(129), 'invalid/identity', 'invalid\nidentity']) {
    await db.exec('BEGIN');
    try {
      await db.query('UPDATE webhook_events SET id=$1 WHERE id=$2', [invalid, 'private-blocker']);
      await db.query('UPDATE webhook_dependency_quarantines SET blocker_id=$1', [invalid]);
      const value = (await db.query(buildQuarantineProofAuditSql(minute, false, true))).rows[0]
        .json_build_object;
      assert.equal(value.sampled_blockers, 1);
      assert.equal(value.blockers[0].private_blocker_receipt_id, null);
      assert.equal(value.settlement_authorized, false);
      assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|invalid[/\n]/u);
    } finally {
      await db.exec('ROLLBACK');
    }
  }
  assert.throws(() => buildQuarantineProofAuditSql(minute, false, 'yes'));
});

test('closed-minute report preserves missing journals, empty/future windows and exact owner metadata', async (t) => {
  const db = await fixture(t);
  let value = await report(db);
  assert.equal(value.window_closed, true);
  assert.equal(value.sample_complete, true);
  assert.equal(value.receipts[0].links[0].saved_semantic_relation, 'same_key');
  assert.equal(value.blockers[0].semantic_claim_also_linked, true);
  assert.equal(firstClaim(value).finished_marker.matching_metadata, true);
  assert.equal(firstClaim(value).lease_state, 'unexpired');
  assert.equal(firstClaim(value).owner_is_blocker, true);
  assert.equal(firstClaim(value).owner_error_family, 'other');
  assert.equal(firstClaim(value).finished_marker.runtime_validation, 'not_evaluated');
  value = await report(db, '2099-01-01T00:00:00Z');
  assert.equal(value.window_closed, false);
  assert.equal(value.sample_complete, false);
  assert.equal(value.sampled_receipts, 0);
  value = await report(db, '2026-10-15T01:36:00Z');
  assert.equal(value.sample_complete, true);
  assert.equal(value.sampled_receipts, 0);
  await db.exec('DELETE FROM webhook_dependency_quarantines');
  value = await report(db);
  assert.equal(value.missing_journals, 1);
  assert.equal(value.receipts[0].journal_found, false);
  assert.deepEqual(value.receipts[0].links, []);
});

test('both claim paths remain visible when canonical owner differs, linked claim disagrees or evidence is missing', async (t) => {
  const db = await fixture(t);
  await db.exec(`INSERT INTO webhook_events(id,semantic_key,status,created_at)
      VALUES('private-owner','private-key','PROCESSED','2026-10-14');
    UPDATE webhook_execution_claims SET webhook_event_id='private-owner';
    INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id)
      VALUES('private-conflict','EXECUTION','private-other-key','private-blocker')`);
  let value = await report(db);
  assert.equal(value.blockers[0].semantic_linked_disagreement, true);
  assert.equal(value.blockers[0].linked_claim_cap_reached, false);
  assert.equal(value.blockers[0].claims.length, 2);
  let canonical = value.blockers[0].claims.find((c) => c.found_by_semantic_key);
  assert.equal(canonical.owner_is_blocker, false);
  assert.equal(canonical.owner_status, 'PROCESSED');
  assert.equal(canonical.finished_marker.owner_matches, false);
  await db.query('UPDATE webhook_execution_claims SET command_result=$1 WHERE id=$2', [
    JSON.stringify({ ...marker, webhookEventId: 'private-owner' }),
    'private-claim',
  ]);
  canonical = (await report(db)).blockers[0].claims.find((c) => c.found_by_semantic_key);
  assert.equal(canonical.finished_marker.matching_metadata, true);
  assert.equal(canonical.owner_is_blocker, false);
  await db.exec("DELETE FROM webhook_events WHERE id='private-owner'");
  value = await report(db);
  assert.equal(value.missing_owners, 1);
  assert.equal(
    value.blockers[0].claims.find((c) => c.found_by_semantic_key).finished_marker.owner_matches,
    false,
  );
  await db.exec(`INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id)
      VALUES('private-third','EXECUTION','private-third-key','private-blocker')`);
  value = await report(db);
  assert.equal(value.blockers[0].linked_claim_cap_reached, true);
  assert.equal(value.blockers[0].claims.length, 3);
  assert.equal(value.sample_complete, false);
  for (const key of [null, '', 'x'.repeat(513)]) {
    await db.query("UPDATE webhook_events SET semantic_key=$1 WHERE id='private-blocker'", [key]);
    value = await report(db);
    assert.equal(value.blockers[0].saved_semantic_key_supported, false);
    assert.equal(value.blockers[0].semantic_claim_found, false);
    assert.equal(value.receipts[0].links[0].saved_semantic_relation, 'unknown');
  }
  await db.exec('DELETE FROM webhook_execution_claims');
  value = await report(db);
  assert.equal(value.blockers_without_observed_claims, 1);
  await db.exec("DELETE FROM webhook_events WHERE id='private-blocker'");
  value = await report(db);
  assert.equal(value.missing_blockers, 1);
  assert.equal(value.receipts[0].links[0].saved_semantic_relation, 'missing_blocker');
});

test('finished marker comparisons require exact fields but do not promote string timestamps into recovery authority', async (t) => {
  const db = await fixture(t);
  for (const [field, bad, output] of [
    ['kind', 'EXECUTION_WAITING', 'kind_matches'],
    ['authorityVersion', 'other', 'version_matches'],
    ['webhookEventId', 'private-wrong-owner', 'owner_matches'],
    ['semanticKey', 'private-wrong-key', 'semantic_matches'],
    ['executionBotId', 'private-bot', 'executor_matches'],
    ['businessStartedAt', '2026-10-14T01:00:02Z', 'business_started_matches'],
    ['finishedAt', null, 'finished_at_string'],
  ]) {
    await db.query('UPDATE webhook_execution_claims SET command_result=$1', [
      JSON.stringify({ ...marker, [field]: bad }),
    ]);
    const checked = firstClaim(await report(db)).finished_marker;
    assert.equal(checked[output], false, field);
    assert.equal(checked.matching_metadata, false, field);
  }
  const missingExecutor = { ...marker };
  delete missingExecutor.executionBotId;
  await db.query('UPDATE webhook_execution_claims SET command_result=$1', [
    JSON.stringify(missingExecutor),
  ]);
  assert.equal(firstClaim(await report(db)).finished_marker.executor_matches, false);
  for (const bad of [null, 42, [], 'private-json-string']) {
    await db.query('UPDATE webhook_execution_claims SET command_result=$1', [JSON.stringify(bad)]);
    assert.equal(firstClaim(await report(db)).finished_marker.object, false);
  }
  await db.query('UPDATE webhook_execution_claims SET command_result=$1', [
    JSON.stringify({ ...marker, finishedAt: 'not-a-date' }),
  ]);
  assert.equal(firstClaim(await report(db)).finished_marker.matching_metadata, true);
  for (const status of ['PENDING', 'READY', 'COMPLETED']) {
    await db.query('UPDATE webhook_execution_claims SET status=$1', [status]);
    assert.equal(firstClaim(await report(db)).claim_status, status);
  }
  await db.exec("UPDATE webhook_execution_claims SET business_started_at='infinity'");
  const checked = firstClaim(await report(db));
  assert.equal(checked.business_started_at_finite, false);
  assert.equal(checked.finished_marker.business_started_matches, false);
});

async function checkLeaseAndWhitespace(db) {
  for (const [token, expiry, state] of [
    [null, null, 'absent'],
    [privateValue, '2000-01-01', 'expired'],
    [privateValue, '2099-01-01', 'unexpired'],
    [null, '2099-01-01', 'malformed'],
    [privateValue, null, 'malformed'],
    [privateValue, 'infinity', 'malformed'],
  ]) {
    await db.query(
      'UPDATE webhook_execution_claims SET lease_token=$1,lease_expires_at=$2 WHERE id=$3',
      [token, expiry, 'private-claim'],
    );
    const value = await report(db);
    const claim = value.blockers.flatMap((b) => b.claims).find((c) => c.found_by_semantic_key);
    assert.equal(claim.lease_state, state);
    assert.equal(claim.lease_pair_valid, state !== 'malformed');
    assert.equal(value.lease_state_basis, 'stored_expiry_at_observed_at_not_process_liveness');
    if (state === 'unexpired') assert.ok(new Date(value.observed_at + 'Z') < new Date(expiry));
  }
  const whitespace = [
    '\t',
    '\n',
    '\v',
    '\f',
    '\r',
    ' ',
    '\u00a0',
    '\u1680',
    ...Array.from({ length: 11 }, (_, i) => String.fromCodePoint(0x2000 + i)),
    '\u2028',
    '\u2029',
    '\u202f',
    '\u205f',
    '\u3000',
    '\ufeff',
  ];
  for (const value of [
    ...whitespace,
    whitespace.join(''),
    '',
    '\u0085',
    '\u180e',
    '\u200b',
    '\tvalid\ufeff',
  ]) {
    await db.query(
      `UPDATE webhook_execution_claims SET execution_bot_id=$1,lease_token=$1,
      lease_expires_at='2099-01-01' WHERE id='private-claim'`,
      [value],
    );
    const claim = firstClaim(await report(db));
    assert.equal(claim.executor_shape_valid, value.trim().length > 0, JSON.stringify(value));
    assert.equal(claim.lease_pair_valid, value.trim().length > 0, JSON.stringify(value));
    assert.equal(claim.lease_state, value.trim().length > 0 ? 'unexpired' : 'malformed');
  }
}
test('lease expiry uses the single observation clock and token/executor blankness matches JavaScript trim', async (t) => {
  const db = await fixture(t);
  await checkLeaseAndWhitespace(db);
});

test('journal admission rejects oversized uncompressed and compressed bodies before JSON interpretation', async (t) => {
  const db = await fixture(t);
  await db.exec(
    'ALTER TABLE webhook_execution_claims ALTER COLUMN command_result SET STORAGE EXTERNAL',
  );
  await db.query('UPDATE webhook_execution_claims SET command_result=$1', [
    JSON.stringify({ ...marker, private: privateValue.repeat(5000) }),
  ]);
  let value = await report(db);
  assert.equal(firstClaim(value).finished_marker.admission, 'oversized_not_inspected');
  assert.equal(firstClaim(value).finished_marker.object, false);
  assert.equal(value.command_results_not_inspected, 1);
  await db.exec(
    'ALTER TABLE webhook_execution_claims ALTER COLUMN command_result SET STORAGE EXTENDED',
  );
  await db.query('UPDATE webhook_execution_claims SET command_result=$1', [
    JSON.stringify({ ...marker, private: privateValue.repeat(30000) }),
  ]);
  const stored = (
    await db.query(
      'SELECT pg_column_compression(command_result) AS compression, pg_column_size(command_result) AS bytes FROM webhook_execution_claims',
    )
  ).rows[0];
  assert.ok(stored.compression);
  assert.ok(stored.bytes < QUARANTINE_PROOF_COMMAND_RESULT_MAX_BYTES);
  value = await report(db);
  assert.equal(firstClaim(value).finished_marker.admission, 'compressed_not_inspected');
  assert.equal(firstClaim(value).finished_marker.matching_metadata, false);
  assert.equal(value.command_results_not_inspected, 1);
});

async function checkErrorAdmission(db) {
  await db.exec('ALTER TABLE webhook_events ALTER COLUMN error_message SET STORAGE EXTERNAL');
  await db.query("UPDATE webhook_events SET error_message=$1 WHERE id='private-blocker'", [
    privateValue.repeat(2000),
  ]);
  let value = await report(db);
  assert.equal(value.blockers[0].error_family, 'oversized_not_inspected');
  assert.equal(firstClaim(value).owner_error_family, 'oversized_not_inspected');
  await db.exec('ALTER TABLE webhook_events ALTER COLUMN error_message SET STORAGE EXTENDED');
  await db.query("UPDATE webhook_events SET error_message=$1 WHERE id='private-blocker'", [
    privateValue.repeat(20000),
  ]);
  const storage = (
    await db.query(
      "SELECT pg_column_compression(error_message) AS compression,pg_column_size(error_message) AS bytes FROM webhook_events WHERE id='private-blocker'",
    )
  ).rows[0];
  assert.ok(storage.compression);
  assert.ok(storage.bytes <= QUARANTINE_PROOF_ERROR_MAX_BYTES);
  value = await report(db);
  assert.equal(value.blockers[0].error_family, 'compressed_not_inspected');
  assert.equal(firstClaim(value).owner_error_family, 'compressed_not_inspected');
}
test('error families refuse compressed or oversized raw errors before materializing blocker or owner metadata', async (t) => {
  const db = await fixture(t);
  await checkErrorAdmission(db);
});

async function checkTextAdmission(db) {
  for (const [storage, admission] of [
    ['EXTENDED', 'compressed_not_inspected'],
    ['EXTERNAL', 'oversized_not_inspected'],
  ]) {
    await db.exec(`ALTER TABLE webhook_execution_claims ALTER COLUMN lease_token SET STORAGE ${storage};
      ALTER TABLE webhook_execution_claims ALTER COLUMN execution_bot_id SET STORAGE ${storage};
      ALTER TABLE webhook_execution_claims ALTER COLUMN semantic_key SET STORAGE EXTENDED;
      ALTER TABLE webhook_events ALTER COLUMN semantic_key SET STORAGE ${storage};
      UPDATE webhook_execution_claims SET lease_token=repeat(' ',10000000),
        execution_bot_id=repeat(' ',10000000),lease_expires_at='2099-01-01' WHERE id='private-claim';`);
    let claim = firstClaim(await report(db));
    assert.equal(claim.lease_token_admission, admission);
    assert.equal(claim.execution_bot_id_admission, admission);
    assert.equal(claim.lease_present, true);
    assert.equal(claim.lease_state, 'not_inspected');
    assert.equal(claim.lease_pair_valid, null);
    assert.equal(claim.executor_shape_valid, null);
    // The small marker has a genuine JSON null executor. A masked rejected value must
    // not become the same null and falsely match it or prove a valid absent lease.
    assert.equal(claim.finished_marker.executor_matches, null);
    assert.equal(claim.finished_marker.matching_metadata, false);
    await db.exec(`UPDATE webhook_execution_claims SET lease_token=NULL,lease_expires_at=NULL,
      execution_bot_id=NULL WHERE id='private-claim';`);
    claim = firstClaim(await report(db));
    assert.equal(claim.execution_bot_id_admission, 'absent');
    assert.equal(claim.executor_shape_valid, true);
    assert.equal(claim.lease_state, 'absent');
    assert.equal(claim.lease_pair_valid, true);
    assert.equal(claim.finished_marker.executor_matches, true);
    await db.exec(`UPDATE webhook_events SET semantic_key=repeat(' ',100000);
      UPDATE webhook_execution_claims SET semantic_key=repeat(' ',100000) WHERE id='private-claim';`);
    const value = await report(db);
    assert.equal(value.receipts[0].saved_semantic_key_admission, admission);
    assert.equal(value.receipts[0].links[0].saved_semantic_relation, 'not_inspected');
    assert.equal(value.blockers[0].saved_semantic_key_admission, admission);
    assert.equal(value.blockers[0].saved_semantic_key_supported, null);
    assert.equal(value.blockers[0].semantic_claim_lookup_state, 'not_inspected');
    assert.equal(value.blockers[0].semantic_claim_found, null);
    claim = firstClaim(value);
    assert.equal(claim.found_by_semantic_key, false);
    assert.equal(claim.found_by_linked_receipt, true);
    // The unique btree rejects uncompressed enormous keys; retain the compressed
    // indexed-key case while receipt/owner metadata covers uncompressed oversized text.
    assert.equal(claim.claim_semantic_key_admission, 'compressed_not_inspected');
    assert.equal(claim.owner_semantic_key_admission, admission);
    assert.equal(claim.claim_saved_semantic_matches_blocker, null);
    assert.equal(claim.owner_saved_semantic_matches_claim, null);
    assert.equal(claim.finished_marker.semantic_matches, null);
    assert.equal(claim.finished_marker.matching_metadata, false);
    await db.exec(`UPDATE webhook_events SET semantic_key='private-key';
      UPDATE webhook_execution_claims SET semantic_key='private-key' WHERE id='private-claim';`);
  }
}
test('oversized or compressed semantic keys and token/executor text remain uninspected rather than genuine nulls', async (t) => {
  const db = await fixture(t);
  await checkTextAdmission(db);
});

async function checkStateAdmission(db) {
  for (const [storage, category] of [
    ['EXTENDED', 'compressed_not_inspected'],
    ['EXTERNAL', 'oversized_not_inspected'],
  ]) {
    await db.exec(
      `ALTER TABLE webhook_dependency_quarantines ALTER COLUMN state SET STORAGE ${storage}`,
    );
    await db.query('UPDATE webhook_dependency_quarantines SET state=$1', [
      privateValue.repeat(20000),
    ]);
    assert.equal((await report(db)).receipts[0].links[0].state, category);
  }
  for (const state of ['WAITING', 'EXPIRED', 'RELEASED', privateValue, null]) {
    await db.query('UPDATE webhook_dependency_quarantines SET state=$1', [state]);
    assert.equal(
      (await report(db)).receipts[0].links[0].state,
      ['WAITING', 'EXPIRED', 'RELEASED'].includes(state) ? state : 'other',
    );
  }
}
test('journal state is classified into finite categories before materialization, including huge compressed and external text', async (t) => {
  const db = await fixture(t);
  await checkStateAdmission(db);
});

const cappedFixture = `INSERT INTO webhook_events(id,semantic_key,status,created_at)
  SELECT 'private-r-' || lpad(n::text,3,'0'),'private-r-key-' || n,'QUARANTINED','2026-10-15 01:37:45'
  FROM generate_series(1,70) n;
INSERT INTO webhook_events(id,semantic_key,status,created_at)
  SELECT 'private-b-' || lpad(n::text,3,'0'),'private-b-key-' || n,'FAILED','2026-10-14'
  FROM generate_series(1,70) n;
INSERT INTO webhook_dependency_quarantines(receipt_id,blocker_id,state)
  SELECT 'private-r-' || lpad(n::text,3,'0'),
    'private-b-' || lpad((((n-1+i)%70)+1)::text,3,'0'),'WAITING'
  FROM generate_series(1,70) n CROSS JOIN generate_series(0,3) i;
INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id,status)
  SELECT 'private-c-' || n,'EXECUTION','private-b-key-' || n,'private-b-' || lpad(n::text,3,'0'),'READY'
  FROM generate_series(1,70) n;`;
function assertCaps(value) {
  assert.equal(value.sampled_receipts, 64);
  assert.equal(value.receipts_truncated, true);
  assert.equal(value.sampled_links, 256);
  assert.equal(value.blocker_cap_reached, true);
  assert.equal(value.unique_blockers_observed_lower_bound, 17);
  assert.equal(value.sampled_blockers, 16);
  assert.equal(value.sample_complete, false);
  assert.ok(value.receipts.some((r) => r.links.some((l) => l.proof_omitted_global_cap)));
  assert.ok(value.receipts.every((r) => r.links.length === 4));
  assert.deepEqual(
    value.receipts.map((r) => r.receipt_ordinal),
    Array.from({ length: 64 }, (_, i) => i + 1),
  );
}
test('receipt, link and independent global blocker caps remain explicit with stable ties and shared blockers', async (t) => {
  const db = await fixture(t, false);
  await db.exec(cappedFixture);
  let value = await report(db);
  assertCaps(value);
  assert.equal(
    value.blockers.reduce((sum, b) => sum + b.claims.length, 0),
    16,
  );
  assert.ok(value.receipts.every((r) => !r.journal_truncated));
  await db.exec(`INSERT INTO webhook_dependency_quarantines(receipt_id,blocker_id,state)
    VALUES('private-r-001','private-zz-sentinel','${privateValue}')`);
  value = await report(db);
  assertCaps(value);
  assert.equal(value.receipts[0].journal_truncated, true);
  assert.equal(value.receipts.filter((r) => r.journal_truncated).length, 1);
});

test('dedicated six-index guard rejects definition drift and reused privilege groups require complete exact grants', async (t) => {
  const db = await fixture(t);
  const indexReady = async () =>
    (await db.query(quarantineProofIndexesSql)).rows[0].quarantine_proof_indexes_ready;
  assert.equal(await indexReady(), true);
  for (const drift of [
    'DROP INDEX webhook_execution_claims_event_kind_idx',
    'DROP INDEX webhook_execution_claims_event_kind_idx; CREATE INDEX webhook_execution_claims_event_kind_idx ON webhook_execution_claims(kind,webhook_event_id)',
    'DROP INDEX webhook_execution_claims_event_kind_idx; CREATE INDEX webhook_execution_claims_event_kind_idx ON webhook_execution_claims(webhook_event_id,kind) INCLUDE(id)',
    "DROP INDEX webhook_execution_claims_event_kind_idx; CREATE INDEX webhook_execution_claims_event_kind_idx ON webhook_execution_claims(webhook_event_id,kind) WHERE kind='EXECUTION'",
    'DROP INDEX webhook_execution_claims_event_kind_idx; CREATE INDEX webhook_execution_claims_event_kind_idx ON webhook_execution_claims(webhook_event_id DESC,kind)',
    'DROP INDEX webhook_execution_claims_event_kind_idx; CREATE INDEX webhook_execution_claims_event_kind_idx ON webhook_execution_claims(webhook_event_id COLLATE "C",kind)',
    'DROP INDEX webhook_execution_claims_event_kind_idx; CREATE INDEX webhook_execution_claims_event_kind_idx ON webhook_execution_claims(webhook_event_id text_pattern_ops,kind)',
    'ALTER INDEX webhook_execution_claims_event_kind_idx SET (fillfactor=80)',
    'ALTER TABLE webhook_execution_claims ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE webhook_dependency_quarantines DROP CONSTRAINT webhook_dependency_quarantines_pkey',
  ]) {
    await db.exec(`BEGIN; ${drift}`);
    assert.equal(await indexReady(), false, drift);
    await db.exec('ROLLBACK');
  }
  await db.exec(
    'CREATE ROLE maxim_audit; GRANT USAGE ON SCHEMA public TO maxim_audit; GRANT SELECT ON webhook_events TO maxim_audit; SET ROLE maxim_audit',
  );
  const ready = async () => ({
    quarantine: (await db.query(buildQuarantinePrivilegesSql(true).split('\\gset')[0])).rows[0]
      .quarantine_audit_privileges_ready,
    owner: (await db.query(ownerProofPrivilegesSql(true))).rows[0].owner_proof_privileges_ready,
  });
  assert.deepEqual(await ready(), { quarantine: false, owner: false });
  await db.exec(
    'RESET ROLE; GRANT SELECT(receipt_id) ON webhook_dependency_quarantines TO maxim_audit; GRANT SELECT(id) ON webhook_execution_claims TO maxim_audit; SET ROLE maxim_audit',
  );
  assert.deepEqual(await ready(), { quarantine: false, owner: false });
  const grants = Object.entries(OWNER_PROOF_COLUMNS)
    .map(([table, columns]) => `GRANT SELECT(${columns.join(',')}) ON ${table} TO maxim_audit;`)
    .join('\n');
  await db.exec(
    `RESET ROLE; GRANT SELECT(${QUARANTINE_AUDIT_COLUMNS.join(',')}) ON webhook_dependency_quarantines TO maxim_audit; ${grants} SET ROLE maxim_audit`,
  );
  assert.deepEqual(await ready(), { quarantine: true, owner: true });
  await report(db);
  for (const excess of [
    'GRANT SELECT(private_content) ON webhook_execution_claims TO PUBLIC',
    'GRANT UPDATE(status) ON webhook_execution_claims TO maxim_audit',
    'GRANT SELECT ON webhook_execution_claims TO maxim_audit',
    'CREATE ROLE private_extra; GRANT SELECT(private_content) ON webhook_execution_claims TO private_extra; GRANT private_extra TO maxim_audit',
  ]) {
    await db.exec(`RESET ROLE; BEGIN; ${excess}; SET ROLE maxim_audit`);
    assert.equal((await ready()).owner, false);
    await db.exec('ROLLBACK; SET ROLE maxim_audit');
  }
  await db.exec(
    'RESET ROLE; GRANT SELECT(private_content) ON webhook_dependency_quarantines TO PUBLIC; SET ROLE maxim_audit',
  );
  assert.equal((await ready()).quarantine, false);
});

async function nativeFixture(run) {
  const url = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.pathname.includes('race_test'),
  );
  const { default: pg } = await import('pg');
  const name = `race_test_quarantine_proof_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: url.href });
  const childUrl = new URL(url);
  childUrl.pathname = `/${name}`;
  const db = new pg.Client({
    connectionString: childUrl.href,
    options: '-c timezone=UTC -c statement_timeout=10000 -c lock_timeout=250',
  });
  db.exec = (sql) => db.query(sql);
  let created = false;
  // FLAG: DDL, fixture writes and timed execution plans own a new disposable local
  // database. Never modify the wrapper's already migrated public schema or a live host.
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    await db.connect();
    assert.match((await db.query('SHOW server_version')).rows[0].server_version, /^16\./u);
    await db.exec(fixtureSql);
    await run(db);
  } finally {
    await db.end();
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

test(
  'native PG16 bounds actual scans before global blocker proof over dense retained history and linked claims',
  { skip: !process.env.MAXIM_TEST_POSTGRES_URL, timeout: 90000 },
  async (t) => {
    await nativeFixture(async (db) => {
      await db.exec(cappedFixture);
      await db.exec(`INSERT INTO webhook_events(id,status,created_at)
        SELECT 'private-old-'||n,'QUARANTINED','2026-10-01' FROM generate_series(1,30000) n;
        INSERT INTO webhook_dependency_quarantines(receipt_id,blocker_id)
        SELECT 'private-old-'||n,'private-b-001' FROM generate_series(1,30000) n;
        INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id)
        SELECT 'private-unrelated-'||n,'EXECUTION','private-unrelated-'||n,'private-old-'||n FROM generate_series(1,30000) n;
        INSERT INTO webhook_events(id,semantic_key,status,created_at)
        SELECT 'private-owner-'||n,'private-b-key-'||n,'FAILED','2026-10-14' FROM generate_series(1,70) n;
        UPDATE webhook_execution_claims SET webhook_event_id=replace(id,'private-c-','private-owner-') WHERE id LIKE 'private-c-%';
        INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id)
        SELECT 'private-linked-'||n||'-'||k,'EXECUTION','private-linked-key-'||n||'-'||k,'private-b-'||lpad(n::text,3,'0')
        FROM generate_series(1,70) n CROSS JOIN generate_series(1,2) k;
        INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id)
        SELECT 'private-dense-'||n,'EXECUTION','private-dense-key-'||n,'private-b-001' FROM generate_series(1,10000) n;
        INSERT INTO webhook_dependency_quarantines(receipt_id,blocker_id)
        SELECT 'private-r-001','private-overflow-'||n FROM generate_series(1,10000) n;
        ANALYZE webhook_events; ANALYZE webhook_dependency_quarantines; ANALYZE webhook_execution_claims;
        SET enable_seqscan=off; SET enable_bitmapscan=off; SET max_parallel_workers_per_gather=0;
        SET jit=off; SET work_mem='1MB'; SET temp_file_limit='8MB'; SET statement_timeout=2500;`);
      assert.equal(
        (await db.query(quarantineProofIndexesSql)).rows[0].quarantine_proof_indexes_ready,
        true,
      );
      const value = await report(db);
      assertCaps(value);
      assert.equal(
        value.blockers.reduce((sum, b) => sum + b.claims.length, 0),
        48,
      );
      assert.ok(value.blockers.every((b) => b.semantic_linked_disagreement));
      assert.equal(value.receipts[0].journal_truncated, true);
      await db.exec('BEGIN READ ONLY');
      let plan, planDocument;
      try {
        // FLAG: Actual work accounting is local-only; production supports plain EXPLAIN.
        planDocument = (
          await db.query(
            'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + buildQuarantineProofAuditSql(minute),
          )
        ).rows[0]['QUERY PLAN'][0];
        plan = planDocument.Plan;
      } finally {
        await db.exec('ROLLBACK');
      }
      const scans = walk(plan).filter((node) => node['Relation Name']);
      t.diagnostic(
        JSON.stringify({
          audit: 'quarantine-proof-native-plan',
          execution_ms: planDocument['Execution Time'],
          planning_ms: planDocument['Planning Time'],
          shared_hit_blocks: plan['Shared Hit Blocks'],
          shared_read_blocks: plan['Shared Read Blocks'],
          scans: scans.map((scan) => ({
            index: scan['Index Name'],
            rows: scan['Actual Rows'],
            loops: scan['Actual Loops'],
          })),
        }),
      );
      assert.equal(scans.length, 8);
      for (const scan of scans) {
        assert.match(scan['Node Type'], /^Index (Only )?Scan$/u, JSON.stringify(scan));
        assert.ok(scan['Index Cond'], JSON.stringify(scan));
        assert.equal(scan['Rows Removed by Filter'] ?? 0, 0);
      }
      for (const [cte, maxRows, maxLoops, index] of [
        ['receipt_heads', 65, 1, 'webhook_events_status_created_at_id_idx'],
        ['receipts', 1, 64, 'webhook_events_pkey'],
        ['journal_heads', 5, 64, 'webhook_dependency_quarantines_pkey'],
        ['blockers', 1, 16, 'webhook_events_pkey'],
        ['semantic_claims', 1, 16, 'webhook_execution_claims_kind_semantic_key'],
        ['linked_claims', 2, 16, 'webhook_execution_claims_event_kind_idx'],
        ['claims', 1, 48, 'webhook_execution_claims_pkey'],
        ['claim_owners', 1, 48, 'webhook_events_pkey'],
      ]) {
        const subtree = walk(plan).find((node) => node['Subplan Name'] === `CTE ${cte}`);
        assert.ok(subtree, cte);
        const reads = walk(subtree).filter((node) => node['Relation Name']);
        assert.equal(reads.length, 1, cte);
        assert.equal(reads[0]['Index Name'], index, cte);
        assert.ok(reads[0]['Actual Rows'] <= maxRows, JSON.stringify(reads[0]));
        assert.ok(reads[0]['Actual Loops'] <= maxLoops, JSON.stringify(reads[0]));
      }
      for (const sort of walk(plan).filter((node) => node['Node Type'] === 'Sort')) {
        assert.notEqual(sort['Sort Space Type'], 'Disk', JSON.stringify(sort));
        assert.ok(sort['Actual Rows'] <= 320, JSON.stringify(sort));
      }
      await db.exec(
        'DROP INDEX webhook_execution_claims_event_kind_idx; CREATE INDEX webhook_execution_claims_event_kind_idx ON webhook_execution_claims(kind,webhook_event_id)',
      );
      assert.equal(
        (await db.query(quarantineProofIndexesSql)).rows[0].quarantine_proof_indexes_ready,
        false,
      );
    });
  },
);

test(
  'native PG16 TOAST admission skips compressed and oversized journals but inspects bounded external values',
  { skip: !process.env.MAXIM_TEST_POSTGRES_URL, timeout: 90000 },
  async () => {
    await nativeFixture(async (db) => {
      await seed(db);
      // FLAG: Public index admission must not be paired with reads from inherited or
      // temporary shadow tables; execute the emitter's exact session preamble in READ ONLY.
      await db.exec(`CREATE SCHEMA hostile;
        CREATE TABLE hostile.webhook_events (LIKE public.webhook_events INCLUDING ALL);
        CREATE TEMP TABLE webhook_events (LIKE public.webhook_events INCLUDING ALL);
        SET search_path TO hostile, pg_catalog, public;`);
      assert.equal((await report(db)).sampled_receipts, 0);
      const script = emitQuarantineProofAuditSql(minute);
      const preamble = script.slice(0, script.indexOf('WITH effective'));
      assert.equal((await report(db, minute, preamble)).sampled_receipts, 1);
      await db.exec('SET search_path TO pg_catalog, public, pg_temp');
      await db.query('UPDATE webhook_execution_claims SET command_result=$1', [
        JSON.stringify({ ...marker, private: privateValue.repeat(40000) }),
      ]);
      let storage = (
        await db.query(
          'SELECT pg_column_compression(command_result) AS compression, pg_column_size(command_result) AS bytes FROM webhook_execution_claims',
        )
      ).rows[0];
      assert.ok(storage.compression);
      assert.ok(storage.bytes <= QUARANTINE_PROOF_COMMAND_RESULT_MAX_BYTES);
      let value = await report(db);
      assert.equal(firstClaim(value).finished_marker.admission, 'compressed_not_inspected');
      assert.equal(firstClaim(value).finished_marker.object, false);
      assert.equal(firstClaim(value).finished_marker.matching_metadata, false);
      await db.exec(
        'ALTER TABLE webhook_execution_claims ALTER COLUMN command_result SET STORAGE EXTERNAL',
      );
      for (const [repeats, admission] of [
        [40000, 'oversized_not_inspected'],
        [400, 'bounded'],
      ]) {
        await db.query('UPDATE webhook_execution_claims SET command_result=$1', [
          JSON.stringify({ ...marker, private: privateValue.repeat(repeats) }),
        ]);
        storage = (
          await db.query(
            'SELECT pg_column_compression(command_result) AS compression, pg_column_size(command_result) AS bytes FROM webhook_execution_claims',
          )
        ).rows[0];
        assert.equal(storage.compression, null);
        // Both values exceed a heap page and must be external; only the <=32KiB one is admitted.
        assert.ok(storage.bytes > 8192);
        assert.equal(
          storage.bytes <= QUARANTINE_PROOF_COMMAND_RESULT_MAX_BYTES,
          admission === 'bounded',
        );
        value = await report(db);
        assert.equal(firstClaim(value).finished_marker.admission, admission);
        assert.equal(firstClaim(value).finished_marker.matching_metadata, admission === 'bounded');
        assert.equal(value.command_results_not_inspected, admission === 'bounded' ? 0 : 1);
      }
      await db.query('UPDATE webhook_execution_claims SET command_result=$1', [
        JSON.stringify({ ...marker, webhookEventId: 'private-wrong-owner' }),
      ]);
      assert.equal(firstClaim(await report(db)).finished_marker.owner_matches, false);
      await db.query('UPDATE webhook_execution_claims SET command_result=$1', [
        JSON.stringify(marker),
      ]);
      await checkTextAdmission(db);
      await checkLeaseAndWhitespace(db);
      await checkErrorAdmission(db);
      await checkStateAdmission(db);
    });
  },
);
