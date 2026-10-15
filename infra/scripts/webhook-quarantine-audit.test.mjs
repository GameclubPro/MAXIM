import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  buildQuarantineAuditSql,
  buildQuarantinePrivilegesSql,
  buildQuarantineIndexSql,
  QUARANTINE_AUDIT_COLUMNS,
  validateQuarantineMinute,
} from './webhook-quarantine-audit.mjs';

const minute = '2026-10-15T01:37:00Z';
const fixture = `SET TIME ZONE 'UTC';
CREATE TABLE webhook_events (id text PRIMARY KEY, status text, created_at timestamp,
  processed_at timestamp, error_message text, next_enqueue_at timestamp,
  timeout_quarantine_expires_at timestamp);
CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id);
CREATE TABLE webhook_dependency_quarantines (receipt_id text, blocker_id text, anchor_id text,
  state text, deadline_at timestamp, created_at timestamp, next_check_at timestamp, resolved_at timestamp,
  chat_id text, original_status text, PRIMARY KEY(receipt_id,blocker_id));`;
const seed = `INSERT INTO webhook_events (id,status,created_at,error_message) VALUES
  ('private-receipt','QUARANTINED','2026-10-15 01:37:45',NULL),
  ('private-blocker','FAILED','2026-10-13 01:00:00',
   'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required');
INSERT INTO webhook_dependency_quarantines VALUES
  ('private-receipt','private-blocker','private-blocker','WAITING','2026-10-15 01:42:45',
   '2026-10-15 01:37:46','2026-10-15 01:38:46',NULL,'private-chat','RECEIVED');`;

test('quarantine diagnostics reject SQL, partial dates and nonminute windows', () => {
  for (const value of [
    '',
    null,
    "2026-10-15'; SELECT 1",
    '2026-02-30T01:00:00Z',
    '2026-10-15T01:37:01Z',
    '2026-10-15T01:37:00+00:00',
    '/tmp/query.sql',
  ])
    assert.throws(() => validateQuarantineMinute(value));
  assert.match(buildQuarantineAuditSql(minute, true), /^EXPLAIN \(FORMAT JSON\)/u);
});

test('quarantine preserves exact old blockers, reports missing journals, and never outputs raw errors or identities', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture + seed);
  let result = (await db.query(buildQuarantineAuditSql(minute))).rows[0].json_build_object;
  assert.equal(result.window_closed, true);
  assert.equal(result.sample_complete, true);
  assert.equal(result.sampled_receipts, 1);
  assert.equal(result.replay_authorized, false);
  assert.equal(result.remote_effects_proven, false);
  assert.equal(result.rows[0].blockers[0].blocker_error_family, 'legacy_execution_unverified');
  assert.equal(result.rows[0].blockers[0].anchor_is_blocker, true);
  assert.doesNotMatch(JSON.stringify(result), /private|LEGACY_EXECUTION/u);
  await db.exec(
    "UPDATE webhook_events SET error_message='private text LEGACY_EXECUTION_UNVERIFIED' WHERE id='private-blocker'",
  );
  result = (await db.query(buildQuarantineAuditSql(minute))).rows[0].json_build_object;
  assert.equal(result.rows[0].blockers[0].blocker_error_family, 'other');
  await db.exec('DELETE FROM webhook_dependency_quarantines');
  result = (await db.query(buildQuarantineAuditSql(minute))).rows[0].json_build_object;
  assert.equal(result.rows[0].journal_found, false);
  assert.deepEqual(result.rows[0].blockers, []);
  result = (await db.query(buildQuarantineAuditSql('2099-01-01T00:00:00Z'))).rows[0]
    .json_build_object;
  assert.equal(result.window_closed, false);
  assert.equal(result.sampled_receipts, 0);
});

test('both quarantine receipt and per-receipt journal caps report truncation', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture + seed);
  await db.exec(`INSERT INTO webhook_events (id,status,created_at)
    SELECT 'private-more-' || n,'QUARANTINED','2026-10-15 01:37:50' FROM generate_series(1,65) n;
    INSERT INTO webhook_dependency_quarantines (receipt_id,blocker_id,state)
    SELECT 'private-receipt','other-blocker-' || n,'UNKNOWN' FROM generate_series(1,5) n;`);
  const result = (await db.query(buildQuarantineAuditSql(minute))).rows[0].json_build_object;
  assert.equal(result.sampled_receipts, 64);
  assert.equal(result.sample_complete, false);
  assert.equal(result.receipts_truncated, true);
  const journal = result.rows.find((row) => row.journal_truncated);
  assert.equal(journal.blockers.length, 4);
  assert.ok(journal.blockers.every((row) => row.blocker_error_family === 'missing_blocker'));
  assert.doesNotMatch(JSON.stringify(result), /private|other-blocker|UNKNOWN/u);
});

test('quarantine grant admission accepts only absent or complete metadata and requires both indexes', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture + 'CREATE ROLE maxim_audit;');
  const ready = async (required) =>
    (await db.query(buildQuarantinePrivilegesSql(required).split('\\gset')[0])).rows[0]
      .quarantine_audit_privileges_ready;
  assert.equal(await ready(false), true);
  assert.equal(await ready(true), false);
  await db.exec('GRANT SELECT(receipt_id) ON webhook_dependency_quarantines TO maxim_audit');
  assert.equal(await ready(false), false);
  await db.exec(
    `GRANT SELECT(${QUARANTINE_AUDIT_COLUMNS.join(',')}) ON webhook_dependency_quarantines TO maxim_audit`,
  );
  assert.equal(await ready(true), true);
  await db.exec('GRANT SELECT(chat_id) ON webhook_dependency_quarantines TO maxim_audit');
  assert.equal(await ready(true), false);
  await db.exec('REVOKE SELECT(chat_id) ON webhook_dependency_quarantines FROM maxim_audit');
  await db.exec('GRANT SELECT ON webhook_dependency_quarantines TO maxim_audit');
  assert.equal(await ready(true), false);
  const indexSql = buildQuarantineIndexSql().split('SELECT EXISTS (')[2].split('\\gset')[0];
  assert.equal(
    (await db.query(`SELECT EXISTS (${indexSql}`)).rows[0].quarantine_audit_index_ready,
    true,
  );
  await db.exec(
    'ALTER TABLE webhook_dependency_quarantines DROP CONSTRAINT webhook_dependency_quarantines_pkey',
  );
  assert.equal(
    (await db.query(`SELECT EXISTS (${indexSql}`)).rows[0].quarantine_audit_index_ready,
    false,
  );
});

test(
  'native quarantine plan bounds retained receipts, journal probes and exact blocker metadata',
  { skip: !process.env.MAXIM_TEST_POSTGRES_URL },
  async (t) => {
    const url = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
    assert.ok(
      ['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname.includes('race_test'),
    );
    const db = new pg.Client({ connectionString: url.href, statement_timeout: 5000 });
    await db.connect();
    t.after(async () => {
      await db.query('ROLLBACK');
      await db.end();
    });
    await db.query(
      'BEGIN; CREATE SCHEMA quarantine_audit_fixture; SET LOCAL search_path TO quarantine_audit_fixture, public;',
    );
    await db.query(fixture + seed);
    await db.query(`INSERT INTO webhook_events(id,status,created_at)
      SELECT 'old-' || n,'QUARANTINED','2026-10-01' FROM generate_series(1,20000) n;
      INSERT INTO webhook_dependency_quarantines(receipt_id,blocker_id)
      SELECT 'old-' || n,'private-blocker' FROM generate_series(1,20000) n;
      INSERT INTO webhook_events(id,status,created_at)
      SELECT 'fresh-' || n,'QUARANTINED','2026-10-15 01:37:50' FROM generate_series(1,100) n;
      INSERT INTO webhook_dependency_quarantines(receipt_id,blocker_id)
      SELECT 'fresh-' || n,'private-blocker' FROM generate_series(1,100) n;
      ANALYZE webhook_events; ANALYZE webhook_dependency_quarantines;
      SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off; SET LOCAL max_parallel_workers_per_gather=0;`);
    // FLAG: Execution plans with actual work counts run only on disposable local stores.
    const plan = (
      await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + buildQuarantineAuditSql(minute))
    ).rows[0]['QUERY PLAN'][0].Plan;
    const flatten = (node) => [node, ...(node.Plans ?? []).flatMap(flatten)];
    const scans = flatten(plan).filter((node) => node['Relation Name']);
    assert.deepEqual(
      scans.map((node) => node['Index Name']).sort(),
      [
        'webhook_dependency_quarantines_pkey',
        'webhook_events_pkey',
        'webhook_events_status_created_at_id_idx',
      ].sort(),
    );
    for (const scan of scans) {
      assert.equal(scan['Rows Removed by Filter'] ?? 0, 0);
      assert.ok(scan['Actual Rows'] <= 65, JSON.stringify(scan));
      assert.ok(scan['Actual Loops'] <= 256);
    }
  },
);
