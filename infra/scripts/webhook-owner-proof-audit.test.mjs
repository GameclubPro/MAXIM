import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  OWNER_PROOF_COLUMNS,
  ownerProofPrivilegesSql,
  ownerProofIndexesSql,
  ownerProofAuditSql,
  emitOwnerProofAuditSql,
} from './webhook-owner-proof-audit.mjs';

const root = resolve(import.meta.dirname, '../..');
const migration = (name) =>
  readFileSync(
    resolve(root, 'apps/api/prisma/migrations', name, 'migration.sql'),
    'utf8',
  ).replaceAll(' CONCURRENTLY', '');
const fixtureSql = `
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED','QUEUED','FAILED','PROCESSED','DUPLICATE');
CREATE TABLE webhook_events (
  id text PRIMARY KEY, semantic_key text, status "WebhookStatus", created_at timestamp(3),
  normalized_payload jsonb, processed_at timestamp(3), next_enqueue_at timestamp(3),
  timeout_quarantine_expires_at timestamp(3), error_message text
);
CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id);
${migration('20260815123000_add_webhook_ordered_chat_head_index')}
CREATE TABLE webhook_execution_claims (
  id text PRIMARY KEY, kind text, semantic_key text, webhook_event_id text, execution_bot_id text,
  enforced boolean, status text, prepared_at timestamp(3), business_started_at timestamp(3),
  completed_at timestamp(3), lease_token text, lease_expires_at timestamp(3), command_result jsonb,
  private_content text
);
CREATE UNIQUE INDEX webhook_execution_claims_kind_semantic_key ON webhook_execution_claims(kind,semantic_key);
CREATE INDEX webhook_execution_claims_event_kind_idx ON webhook_execution_claims(webhook_event_id,kind);
CREATE TABLE max_action_ledger (
  chat_id text, action_type text, message_id text, status text, ambiguous boolean, terminal boolean,
  attempt_count integer, dispatch_token text, dispatch_started_at timestamp(3), dispatch_bot_id text,
  remote_message_id text, completed_at timestamp(3), private_content text
);
${migration('20260716190500_add_max_action_delete_owner_lookup_index')}
`;
const grantSql = (role) =>
  Object.entries(OWNER_PROOF_COLUMNS)
    .map(([table, columns]) => `GRANT SELECT (${columns.join(',')}) ON ${table} TO ${role};`)
    .join('\n');
const now = '2026-10-01T00:00:00.000Z';
const secret = 'PRIVATE_VALUE_MUST_NOT_APPEAR';
const key = `message:message_created:${secret}:${secret}`;
const payload = JSON.stringify({
  type: 'message_created',
  message: { chatId: secret, messageId: secret, text: secret },
});

async function fixture(db) {
  await db.exec(fixtureSql);
}
async function receipts(db) {
  await db.query(
    `INSERT INTO webhook_events(id,semantic_key,status,created_at,normalized_payload,error_message)
    VALUES ('private-blocker',$1,'FAILED',$2,$3,'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required'),
    ('private-received',$1,'RECEIVED',$2::timestamp + interval '1 second',$3,NULL)`,
    [key, now, payload],
  );
}
async function finishedClaim(db) {
  await db.query(
    `INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id,
    execution_bot_id,enforced,status,prepared_at,business_started_at,lease_token,lease_expires_at,command_result)
    VALUES ('private-claim','EXECUTION',$1,'private-blocker',$2,true,'READY',$3,$3,$2,$3,$4)`,
    [
      key,
      secret,
      now,
      JSON.stringify({
        kind: 'EXECUTION_FINISHED',
        authorityVersion: 'semantic-owner-lease-v1',
        webhookEventId: 'private-blocker',
        semanticKey: key,
        executionBotId: secret,
        businessStartedAt: now,
        finishedAt: now,
      }),
    ],
  );
}
async function audit(db) {
  await db.exec('BEGIN READ ONLY');
  try {
    const report = (await db.query(ownerProofAuditSql)).rows[0].json_build_object;
    assert.doesNotMatch(
      JSON.stringify(report),
      /PRIVATE_VALUE|private-blocker|private-received|private-claim/u,
    );
    assert.equal(report.authority, 'DIAGNOSTICS_ONLY');
    assert.equal(report.settlement_authorized, false);
    assert.equal(report.effect_completeness, 'unknown');
    assert.equal(report.delete_effect_observations.absence_proves_no_effects, false);
    return report;
  } finally {
    await db.exec('ROLLBACK');
  }
}

test('oldest first predecessor is retained even when a later head has finished proof', async () => {
  const db = new PGlite();
  try {
    await fixture(db);
    assert.equal((await audit(db)).classification, 'no_received');
    await receipts(db);
    await finishedClaim(db);
    await db.query(
      `INSERT INTO webhook_events(id,status,created_at,normalized_payload,error_message)
      VALUES ('earliest-unknown','FAILED',$1::timestamp - interval '1 second',$2,
        'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:PRIVATE_VALUE_MUST_NOT_APPEAR')`,
      [now, payload],
    );
    const report = await audit(db);
    assert.equal(report.classification, 'claim_missing');
    assert.equal(report.claim.present, false);
    assert.equal(report.predecessor.legacy_unverified_marker, false);
    await db.exec("UPDATE webhook_events SET status='PROCESSED' WHERE id='earliest-unknown'");
    assert.equal(
      (await audit(db)).classification,
      'finished_checkpoint_candidate_requires_runtime_validation',
    );
    await db.exec("UPDATE webhook_events SET normalized_payload='{}' WHERE id='private-received'");
    assert.equal((await audit(db)).classification, 'source_unknown');
  } finally {
    await db.close();
  }
});

test('checkpoint fields distinguish uncertainty and never certify source or finished time', async () => {
  const db = new PGlite();
  try {
    await fixture(db);
    await receipts(db);
    await finishedClaim(db);
    let report = await audit(db);
    assert.equal(
      report.classification,
      'finished_checkpoint_candidate_requires_runtime_validation',
    );
    assert.equal(report.semantic_source_rebuild, 'not_evaluated');
    assert.equal(report.finished_timestamp_validation, 'not_evaluated');
    assert.equal(report.claim.lease, 'expired');
    for (const field of [
      'kind',
      'authorityVersion',
      'webhookEventId',
      'semanticKey',
      'executionBotId',
      'businessStartedAt',
    ]) {
      await db.exec('BEGIN');
      await db.query(
        `UPDATE webhook_execution_claims SET command_result=jsonb_set(command_result,ARRAY[$1],to_jsonb($2::text))`,
        [field, secret + '_mismatch'],
      );
      assert.equal(
        (await db.query(ownerProofAuditSql)).rows[0].json_build_object.classification,
        'finished_checkpoint_missing_or_mismatched',
      );
      await db.exec('ROLLBACK');
    }
    await db.exec('UPDATE webhook_execution_claims SET lease_expires_at=NULL');
    report = await audit(db);
    assert.equal(report.classification, 'preparation_or_lease_invalid');
    assert.equal(report.claim.lease, 'malformed');
    await db.exec('UPDATE webhook_execution_claims SET business_started_at=NULL');
    assert.equal((await audit(db)).classification, 'business_start_unrecorded');
    await db.exec("UPDATE webhook_execution_claims SET status='COMPLETED'");
    assert.equal(
      (await audit(db)).classification,
      'claim_completed_requires_receipt_reconciliation',
    );
  } finally {
    await db.close();
  }
});

test('mirrors, absent canonical owner, null stored keys and multiple links stay explicit', async () => {
  const db = new PGlite();
  try {
    await fixture(db);
    await receipts(db);
    await finishedClaim(db);
    await db.exec("UPDATE webhook_execution_claims SET webhook_event_id='private-received'");
    assert.equal((await audit(db)).classification, 'different_canonical_owner');
    await db.exec("UPDATE webhook_execution_claims SET webhook_event_id='absent'");
    assert.equal((await audit(db)).classification, 'owner_missing');
    await db.exec(
      "UPDATE webhook_execution_claims SET webhook_event_id='private-blocker'; UPDATE webhook_events SET semantic_key=NULL WHERE id='private-blocker'",
    );
    assert.equal((await audit(db)).classification, 'stored_semantic_mismatch');
    await db.exec(
      "INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id) VALUES ('conflict','EXECUTION','another-key','private-blocker')",
    );
    assert.equal((await audit(db)).classification, 'multiple_linked_claims');
  } finally {
    await db.close();
  }
});

test('only exact message delete ledger is sampled, with sentinel and no absence authority', async () => {
  const db = new PGlite();
  try {
    await fixture(db);
    await receipts(db);
    await db.query(
      `INSERT INTO max_action_ledger(chat_id,message_id,action_type,status,ambiguous,dispatch_token)
      SELECT $1,$1,'DELETE_MESSAGE','AMBIGUOUS',true,$1 FROM generate_series(1,40)`,
      [secret],
    );
    await db.query(
      `INSERT INTO max_action_ledger(chat_id,message_id,action_type,status,ambiguous)
      VALUES ($1,$1,'SEND_MESSAGE','SUCCEEDED',false),($1,'unrelated','DELETE_MESSAGE','SUCCEEDED',false)`,
      [secret],
    );
    const report = await audit(db);
    assert.equal(report.delete_effect_observations.row_count_lower_bound, 17);
    assert.equal(report.delete_effect_observations.truncated, true);
    assert.equal(report.delete_effect_observations.any_succeeded, false);
    assert.equal(report.delete_effect_observations.any_ambiguous, true);
    assert.equal(report.delete_effect_observations.any_dispatch_fence, true);
    await db.exec('DELETE FROM max_action_ledger');
    assert.equal((await audit(db)).delete_effect_observations.row_count_lower_bound, 0);
  } finally {
    await db.close();
  }
});

test('effective grants reject partial, broad, inherited/PUBLIC and column mutation access', async () => {
  const db = new PGlite();
  try {
    await fixture(db);
    await db.exec(
      'CREATE ROLE proof_auditor; GRANT USAGE ON SCHEMA public TO proof_auditor; GRANT SELECT ON webhook_events TO proof_auditor; SET ROLE proof_auditor',
    );
    const ready = async (all) =>
      (await db.query(ownerProofPrivilegesSql(all))).rows[0].owner_proof_privileges_ready;
    assert.equal(await ready(false), true);
    assert.equal(await ready(true), false);
    await db.exec(
      'RESET ROLE; GRANT SELECT(id) ON webhook_execution_claims TO proof_auditor; SET ROLE proof_auditor',
    );
    assert.equal(await ready(false), false);
    await db.exec(`RESET ROLE; ${grantSql('proof_auditor')} SET ROLE proof_auditor`);
    assert.equal(await ready(true), true);
    await audit(db);
    await assert.rejects(
      db.query('SELECT private_content FROM webhook_execution_claims'),
      /permission denied/u,
    );
    for (const grant of [
      'GRANT SELECT(private_content) ON webhook_execution_claims TO PUBLIC',
      'GRANT UPDATE(status) ON max_action_ledger TO proof_auditor',
      'GRANT SELECT ON max_action_ledger TO proof_auditor',
      'CREATE ROLE proof_extra; GRANT SELECT(private_content) ON max_action_ledger TO proof_extra; GRANT proof_extra TO proof_auditor',
    ]) {
      await db.exec(`RESET ROLE; BEGIN; ${grant}; SET ROLE proof_auditor`);
      assert.equal(await ready(true), false);
      await db.exec('ROLLBACK; SET ROLE proof_auditor');
    }
  } finally {
    await db.close();
  }
});

test('checked-in provision grants exactly both groups and rejects effective excess', async () => {
  const db = new PGlite();
  try {
    await fixture(db);
    await db.exec('CREATE ROLE proof_auditor; GRANT USAGE ON SCHEMA public TO proof_auditor');
    const source = readFileSync(
      resolve(root, 'infra/scripts/vps-provision-postgres-audit-role.sh'),
      'utf8',
    );
    const start = source.indexOf('DO $webhook_owner_proof_grants$');
    const grant = source
      .slice(
        start,
        source.indexOf('$webhook_owner_proof_grants$;', start) +
          '$webhook_owner_proof_grants$;'.length,
      )
      .replaceAll('maxim_audit', 'proof_auditor');
    const verificationStart = source.indexOf('  -- FLAG: Provisioning must roll back');
    const verification =
      'DO $check$ BEGIN\n' +
      source
        .slice(verificationStart, source.indexOf('  -- FLAG: Zero or all eight', verificationStart))
        .replaceAll('maxim_audit', 'proof_auditor') +
      'END $check$;';
    await db.exec(grant);
    await db.exec(verification);
    await db.exec('SET ROLE proof_auditor');
    assert.equal(
      (await db.query(ownerProofPrivilegesSql(true))).rows[0].owner_proof_privileges_ready,
      true,
    );
    await db.exec('RESET ROLE; GRANT SELECT(private_content) ON max_action_ledger TO PUBLIC');
    await assert.rejects(db.exec(verification), /owner proof column privileges are not exact/u);
    await db.exec('REVOKE SELECT(private_content) ON max_action_ledger FROM PUBLIC');
    await db.exec(
      'REVOKE SELECT ON webhook_execution_claims, max_action_ledger FROM proof_auditor',
    );
    for (const [table, columns] of Object.entries(OWNER_PROOF_COLUMNS)) {
      await db.exec(`REVOKE SELECT (${columns.join(',')}) ON ${table} FROM proof_auditor`);
    }
    await db.exec('ALTER TABLE webhook_execution_claims DROP COLUMN command_result');
    await db.exec(grant);
    await db.exec('SET ROLE proof_auditor');
    assert.equal(
      (await db.query(ownerProofPrivilegesSql(false))).rows[0].owner_proof_privileges_ready,
      true,
    );
    assert.equal(
      (await db.query(ownerProofPrivilegesSql(true))).rows[0].owner_proof_privileges_ready,
      false,
    );
  } finally {
    await db.close();
  }
});

test('all seven index definitions are required before report or plain EXPLAIN', async () => {
  const db = new PGlite();
  try {
    await fixture(db);
    const ready = async () =>
      (await db.query(ownerProofIndexesSql)).rows[0].owner_proof_indexes_ready;
    assert.equal(await ready(), true);
    for (const drift of [
      'ALTER TABLE webhook_execution_claims ENABLE ROW LEVEL SECURITY',
      'CREATE TABLE inherited_events () INHERITS (webhook_events)',
      'DROP INDEX webhook_events_status_created_at_id_idx',
      'DROP INDEX webhook_events_ordered_chat_head_idx; CREATE INDEX webhook_events_ordered_chat_head_idx ON webhook_events(created_at,id)',
      'DROP INDEX webhook_execution_claims_kind_semantic_key; CREATE INDEX webhook_execution_claims_kind_semantic_key ON webhook_execution_claims(kind,semantic_key)',
      'DROP INDEX max_action_ledger_delete_owner_lookup_idx; CREATE INDEX max_action_ledger_delete_owner_lookup_idx ON max_action_ledger(chat_id COLLATE "C",action_type,message_id,status)',
    ]) {
      await db.exec(`BEGIN; ${drift}`);
      assert.equal(await ready(), false);
      await db.exec('ROLLBACK');
    }
    const script = emitOwnerProofAuditSql(true);
    assert(script.indexOf('owner_proof_indexes_ready') < script.indexOf('EXPLAIN (FORMAT JSON)'));
    assert.doesNotMatch(script, /EXPLAIN ANALYZE|\\quit|FOR UPDATE/u);
  } finally {
    await db.close();
  }
});

test(
  'native PostgreSQL uses constrained indexes even with a large unrelated prefix',
  {
    skip: !process.env.MAXIM_TEST_POSTGRES_URL,
    timeout: 30_000,
  },
  async () => {
    const url = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
    assert(
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        url.pathname.includes('race_test'),
    );
    const { default: pg } = await import('pg');
    const name = `race_test_owner_proof_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Client({ connectionString: url.href });
    const childUrl = new URL(url);
    childUrl.pathname = `/${name}`;
    const db = new pg.Client({
      connectionString: childUrl.href,
      options: '-c timezone=UTC -c statement_timeout=2500 -c lock_timeout=250',
    });
    // FLAG: This fixture owns a new disposable database; production URLs fail before connect.
    db.exec = (sql) => db.query(sql);
    let created = false;
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created = true;
      await db.connect();
      await fixture(db);
      await receipts(db);
      await finishedClaim(db);
      await db.query(
        `INSERT INTO webhook_events(id,status,created_at,normalized_payload)
      SELECT 'unrelated-'||n,'QUEUED',$1::timestamp-interval '1 day',
        jsonb_build_object('type','message_created','chatId','other-'||n) FROM generate_series(1,12000) n`,
        [now],
      );
      await db.query(`INSERT INTO webhook_execution_claims(id,kind,semantic_key,webhook_event_id)
      SELECT 'other-'||n,'EXECUTION','other-'||n,'other-'||n FROM generate_series(1,12000) n`);
      await db.query(`INSERT INTO max_action_ledger(chat_id,message_id,action_type,status)
      SELECT 'other-'||n,'other-'||n,'DELETE_MESSAGE','SUCCEEDED' FROM generate_series(1,12000) n`);
      await db.query(
        "ANALYZE; SET enable_seqscan=off; SET enable_bitmapscan=off; SET max_parallel_workers_per_gather=0; SET work_mem='1MB'",
      );
      assert.equal((await db.query(ownerProofIndexesSql)).rows[0].owner_proof_indexes_ready, true);
      const result = await audit(db);
      assert.equal(
        result.classification,
        'finished_checkpoint_candidate_requires_runtime_validation',
      );
      const plan = (await db.query(`EXPLAIN (FORMAT JSON) ${ownerProofAuditSql}`)).rows[0][
        'QUERY PLAN'
      ];
      const scans = [];
      const visit = (node) => {
        if (node['Relation Name']) scans.push(node);
        for (const child of node.Plans ?? []) visit(child);
      };
      visit(plan[0].Plan);
      assert(scans.length >= 7);
      for (const scan of scans) {
        assert.match(scan['Node Type'], /^Index (Only )?Scan$/u, JSON.stringify(scan));
        assert(scan['Index Cond'], JSON.stringify(scan));
      }
      assert(scans.some((s) => s['Index Name'] === 'webhook_events_ordered_chat_head_idx'));
      assert(scans.some((s) => s['Index Name'] === 'max_action_ledger_delete_owner_lookup_idx'));
    } finally {
      await db.end();
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
