import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { buildWebhookCohortAuditSql, buildWebhookCohortIndexSql } from './webhook-cohort-audit.mjs';

const fixture = `SET TIME ZONE 'UTC';
CREATE TYPE "WebhookStatus" AS ENUM (
  'RECEIVED','QUEUED','PROCESSED','DUPLICATE','FAILED','NO_REPLAY_HELD','CANCELLED','QUARANTINED');
CREATE TABLE webhook_events (id text PRIMARY KEY, status "WebhookStatus" NOT NULL,
  created_at timestamp(3) NOT NULL, queued_at timestamp(3), processed_at timestamp(3),
  error_message text, next_enqueue_at timestamp(3), timeout_quarantine_expires_at timestamp(3),
  execution_deadline_at timestamp(3),
  raw_payload jsonb, normalized_payload jsonb);
CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id);`;
const query = buildWebhookCohortAuditSql();
const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim() ?? '';
const local = (() => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(nativeUrl).hostname);
  } catch {
    return false;
  }
})();

test('closed cohort includes all eight statuses and excludes invalid completion clocks from percentiles', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events
    (id,status,created_at,queued_at,processed_at,raw_payload,normalized_payload)
    SELECT 'private-' || status, status, now() - interval '45 seconds',
      now() - interval '44 seconds', now() - interval '43 seconds', '{"secret":1}', '{}'
    FROM unnest(enum_range(NULL::"WebhookStatus")) status;
    INSERT INTO webhook_events(id,status,created_at,processed_at) VALUES
      ('private-clock','PROCESSED',now()-interval '45 seconds',now()-interval '46 seconds'),
      ('private-old','PROCESSED',now()-interval '70 seconds',now()-interval '40 seconds'),
      ('private-current','RECEIVED',now()-interval '10 seconds',NULL),
      ('private-future','RECEIVED',now()+interval '10 seconds',NULL);`);
  const report = (await db.query(query)).rows[0].json_build_object;
  assert.equal(report.sample_complete, true);
  assert.equal(report.nonempty, true);
  assert.equal(report.remote_effects_proven, false);
  assert.equal(report.rows.length, 8);
  assert.ok(Date.parse(report.from) < Date.parse(report.until));
  assert.ok(Date.parse(report.until) < Date.parse(report.observed_at));
  const byStatus = Object.fromEntries(report.rows.map((r) => [r.status, r]));
  assert.equal(byStatus.PROCESSED.count_lower_bound, 2);
  assert.equal(byStatus.PROCESSED.invalid_processed_clocks, 1);
  assert.equal(byStatus.PROCESSED.processed_only_p95_ms, 2000);
  assert.equal(byStatus.PROCESSED.processed_only_p99_ms, 2000);
  assert.equal(byStatus.PROCESSED.queued_sample_p99_ms, 1000);
  assert.equal(byStatus.RECEIVED.count_lower_bound, 1);
  assert.ok(byStatus.RECEIVED.oldest_pending_age_seconds >= 45);
  for (const status of ['DUPLICATE', 'CANCELLED', 'NO_REPLAY_HELD', 'FAILED', 'QUARANTINED']) {
    assert.equal(byStatus[status].count_lower_bound, 1);
    assert.equal(byStatus[status].processed_only_p95_ms, null);
    assert.equal(byStatus[status].processed_only_p99_ms, null);
  }
  assert.doesNotMatch(JSON.stringify(report), /private-|secret|payload/u);
});

test('tail percentiles use only valid successful receipts and keep queue timing separate', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events(id,status,created_at,queued_at,processed_at) VALUES
    ('fast','PROCESSED',now()-interval '45 seconds',now()-interval '44.9 seconds',now()-interval '44 seconds'),
    ('slow','PROCESSED',now()-interval '45 seconds',now()-interval '44 seconds',now()-interval '36 seconds'),
    ('invalid','PROCESSED',now()-interval '45 seconds',now()+interval '1 second',now()-interval '46 seconds'),
    ('cancelled','CANCELLED',now()-interval '45 seconds',now()-interval '44 seconds',now());`);
  const report = (await db.query(query)).rows[0].json_build_object;
  const processed = report.rows.find((row) => row.status === 'PROCESSED');
  assert.ok(Math.abs(processed.processed_only_p95_ms - 8600) < 0.001);
  assert.ok(Math.abs(processed.processed_only_p99_ms - 8920) < 0.001);
  assert.ok(Math.abs(processed.queued_sample_p99_ms - 991) < 0.001);
  assert.equal(processed.invalid_processed_clocks, 1);
  assert.equal(processed.invalid_queued_clocks, 1);
  assert.equal(report.rows.find((row) => row.status === 'CANCELLED').processed_only_p99_ms, null);
});

test('failed cohorts expose bounded categories and timing separately without trusting embedded errors', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events(id,status,created_at,error_message,
    execution_deadline_at,next_enqueue_at,timeout_quarantine_expires_at) VALUES
    ('private-expired','FAILED',now()-interval '45 seconds',
      'NO_EXECUTABLE_OWNER; deadline=2026-01-01T00:00:00.000Z',now()-interval '50 seconds',NULL,NULL),
    ('private-quarantine','FAILED',now()-interval '45 seconds',
      'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:private-token: private-error',
      now()-interval '40 seconds',now()+interval '1 second',now()-interval '1 second'),
    ('private-embedded','FAILED',now()-interval '45 seconds',
      'private text NO_EXECUTABLE_OWNER; deadline=2026-01-01T00:00:00.000Z',NULL,NULL,NULL),
    ('private-malformed','FAILED',now()-interval '45 seconds',
      'NO_EXECUTABLE_OWNER; deadline=private-error',NULL,NULL,NULL),
    ('private-completion','FAILED',now()-interval '45 seconds',
      'Handler completion claim changed',NULL,NULL,NULL),
    ('private-not-failed','PROCESSED',now()-interval '45 seconds',
      'NO_EXECUTABLE_OWNER; deadline=2026-01-01T00:00:00.000Z',NULL,NULL,NULL);`);
  const report = (await db.query(query)).rows[0].json_build_object;
  assert.equal(report.schema_version, 4);
  assert.equal(report.failure_classification_authority, 'saved_metadata_only');
  const byFamily = Object.fromEntries(report.failure_families.map((r) => [r.family, r]));
  assert.equal(byFamily.no_executable_owner.count_lower_bound, 1);
  assert.equal(byFamily.no_executable_owner.deadline_elapsed_at_receipt, 1);
  assert.equal(byFamily.no_executable_owner.retry_scheduled, 0);
  assert.equal(byFamily.pending_quarantine_marker.count_lower_bound, 1);
  assert.equal(byFamily.pending_quarantine_marker.quarantine_timestamp_present, 1);
  assert.equal(byFamily.pending_quarantine_marker.retry_scheduled, 1);
  assert.equal(byFamily.pending_quarantine_marker.deadline_elapsed_at_receipt, 0);
  assert.equal(byFamily.pending_quarantine_marker.deadline_elapsed_at_observation, 1);
  assert.equal(byFamily.completion_claim_changed.count_lower_bound, 1);
  assert.equal(byFamily.other.count_lower_bound, 2);
  assert.deepEqual(report.pending_quarantine_families, [
    { family: 'other_pending', count_lower_bound: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /private-|secret|payload|2026-01-01/u);
});

test('quarantine subtype matches exact saved envelopes without mistaking copied text for provenance', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  const prefix = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:';
  const nonce = '11111111-2222-3333-4444-555555555555';
  const markers = [
    ['LEGACY_EXECUTION_UNVERIFIED; exact effects proof required', 'legacy_execution_unverified'],
    [
      'CANONICAL_BUSINESS_ALREADY_STARTED; durable-effects recovery required',
      'canonical_business_started',
    ],
    [
      `${nonce}: Webhook user-facing hot path timed out after 10000ms for message_created`,
      'detached_timeout',
    ],
    [
      `${nonce}: Webhook user-facing hot path timed out after 10000ms for message_edited | private-error`,
      'detached_timeout',
    ],
    [
      `${nonce}: detached execution completed without a canonical claim: private-error`,
      'unclaimed_detached_completed',
    ],
    [
      `${nonce}: detached execution failed without a canonical claim: private-error`,
      'unclaimed_detached_failed',
    ],
    ['LEGACY_EXECUTION_UNVERIFIED; exact effects proof required private-error', 'other_pending'],
    [
      `${nonce}: private-error LEGACY_EXECUTION_UNVERIFIED; exact effects proof required`,
      'other_pending',
    ],
    [
      'private-nonce: Webhook user-facing hot path timed out after 10000ms for message_created',
      'other_pending',
    ],
    [
      `${nonce}: Webhook user-facing hot path timed out after 10000ms for message_created_private`,
      'other_pending',
    ],
  ];
  for (const [i, [marker]] of markers.entries()) {
    await db.query(
      `INSERT INTO webhook_events(id,status,created_at,error_message)
      VALUES ($1,'FAILED',now()-interval '45 seconds',$2)`,
      [`private-${i}`, prefix + marker],
    );
  }
  const report = (await db.query(query)).rows[0].json_build_object;
  const expected = new Map();
  for (const [, family] of markers) expected.set(family, (expected.get(family) ?? 0) + 1);
  assert.deepEqual(
    report.pending_quarantine_families,
    [...expected]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([family, count_lower_bound]) => ({ family, count_lower_bound })),
  );
  assert.equal(report.remote_effects_proven, false);
  assert.equal(report.failure_classification_authority, 'saved_metadata_only');
  assert.doesNotMatch(JSON.stringify(report), /private-|11111111|LEGACY_EXECUTION_UNVERIFIED/u);
});

test('empty and capped cohorts never claim complete processing', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  let report = (await db.query(query)).rows[0].json_build_object;
  assert.equal(report.nonempty, false);
  assert.deepEqual(report.failure_families, []);
  assert.deepEqual(report.pending_quarantine_families, []);
  assert.ok(report.rows.every((r) => r.count_lower_bound === 0));
  await db.exec(`INSERT INTO webhook_events(id,status,created_at)
    SELECT 'private-' || n, 'PROCESSED', now()-interval '45 seconds' FROM generate_series(1,513) n;`);
  report = (await db.query(query)).rows[0].json_build_object;
  const processed = report.rows.find((r) => r.status === 'PROCESSED');
  assert.equal(report.sample_complete, false);
  assert.equal(processed.truncated, true);
  assert.equal(processed.count_lower_bound, 512);
  assert.equal(processed.invalid_processed_clocks, 512);
  assert.equal(processed.processed_only_p95_ms, null);
  assert.equal(processed.processed_only_p99_ms, null);
  const readiness = buildWebhookCohortIndexSql().split('\\gset')[0];
  assert.equal((await db.query(readiness)).rows[0].webhook_cohort_index_ready, true);
  await db.exec('DROP INDEX webhook_events_status_created_at_id_idx');
  assert.equal((await db.query(readiness)).rows[0].webhook_cohort_index_ready, false);
});

test(
  'native cohort bounds index scans before metadata even with retained history and tied timestamps',
  { skip: !local },
  async (t) => {
    const db = new pg.Client({ connectionString: nativeUrl, statement_timeout: 5000 });
    await db.connect();
    t.after(async () => {
      await db.query('ROLLBACK').catch(() => {});
      await db.end();
    });
    await db.query(
      'BEGIN; CREATE SCHEMA webhook_cohort_fixture; SET LOCAL search_path TO webhook_cohort_fixture, public;',
    );
    await db.query(fixture);
    await db.query(`INSERT INTO webhook_events(id,status,created_at)
    SELECT 'private-old-' || n, 'PROCESSED', now()-interval '2 days' FROM generate_series(1,60000) n;
    INSERT INTO webhook_events(id,status,created_at)
    SELECT 'private-new-' || n, 'PROCESSED', now()-interval '45 seconds' FROM generate_series(1,1200) n;
    INSERT INTO webhook_events(id,status,created_at,error_message)
    SELECT 'private-failed-' || n, 'FAILED', now()-interval '45 seconds', 'private-error'
      FROM generate_series(1,1200) n;
    ANALYZE webhook_events; SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off;
    SET LOCAL max_parallel_workers_per_gather=0;`);
    // FLAG: EXPLAIN ANALYZE is local disposable-fixture evidence only.
    const plan = (await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query)).rows[0][
      'QUERY PLAN'
    ][0].Plan;
    const scans = [];
    const walk = (n) => {
      if (n['Relation Name'] === 'webhook_events') scans.push(n);
      for (const c of n.Plans ?? []) walk(c);
    };
    walk(plan);
    assert.equal(scans.length, 2);
    assert.ok(
      scans.every((n) =>
        ['webhook_events_status_created_at_id_idx', 'webhook_events_pkey'].includes(
          n['Index Name'],
        ),
      ),
    );
    for (const s of scans) {
      assert.equal(s['Rows Removed by Filter'] ?? 0, 0);
      assert.ok(s['Actual Rows'] <= 513);
      assert.ok(s['Actual Loops'] <= 1024);
    }
    const report = (await db.query(query)).rows[0].json_build_object;
    assert.equal(report.sample_complete, false);
    assert.equal(report.rows.find((r) => r.status === 'PROCESSED').count_lower_bound, 512);
    assert.deepEqual(
      report.failure_families.map((r) => [r.family, r.count_lower_bound]),
      [['other', 512]],
    );
  },
);

test('cohort CLI accepts only fixed report or plain EXPLAIN', () => {
  for (const args of [['SELECT 1'], ['--apply'], ['--explain', 'extra']]) {
    const r = spawnSync(
      process.execPath,
      [new URL('./webhook-cohort-audit.mjs', import.meta.url).pathname, ...args],
      { encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, '');
  }
  assert.match(buildWebhookCohortAuditSql(true), /^EXPLAIN \(FORMAT JSON\)/u);
});
