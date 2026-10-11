import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { buildWebhookCohortAuditSql, buildWebhookCohortIndexSql } from './webhook-cohort-audit.mjs';

const fixture = `SET TIME ZONE 'UTC';
CREATE TYPE "WebhookStatus" AS ENUM (
  'RECEIVED','QUEUED','PROCESSED','DUPLICATE','FAILED','NO_REPLAY_HELD','CANCELLED');
CREATE TABLE webhook_events (id text PRIMARY KEY, status "WebhookStatus" NOT NULL,
  created_at timestamp(3) NOT NULL, queued_at timestamp(3), processed_at timestamp(3),
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

test('closed cohort includes all seven statuses and excludes invalid completion clocks from percentiles', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events
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
  assert.equal(report.rows.length, 7);
  assert.ok(Date.parse(report.from) < Date.parse(report.until));
  assert.ok(Date.parse(report.until) < Date.parse(report.observed_at));
  const byStatus = Object.fromEntries(report.rows.map((r) => [r.status, r]));
  assert.equal(byStatus.PROCESSED.count_lower_bound, 2);
  assert.equal(byStatus.PROCESSED.invalid_processed_clocks, 1);
  assert.equal(byStatus.PROCESSED.processed_only_p95_ms, 2000);
  assert.equal(byStatus.RECEIVED.count_lower_bound, 1);
  assert.ok(byStatus.RECEIVED.oldest_pending_age_seconds >= 45);
  for (const status of ['DUPLICATE', 'CANCELLED', 'NO_REPLAY_HELD', 'FAILED']) {
    assert.equal(byStatus[status].count_lower_bound, 1);
    assert.equal(byStatus[status].processed_only_p95_ms, null);
  }
  assert.doesNotMatch(JSON.stringify(report), /private-|secret|payload/u);
});

test('empty and capped cohorts never claim complete processing', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  let report = (await db.query(query)).rows[0].json_build_object;
  assert.equal(report.nonempty, false);
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
      assert.ok(s['Actual Loops'] <= 512);
    }
    const report = (await db.query(query)).rows[0].json_build_object;
    assert.equal(report.sample_complete, false);
    assert.equal(report.rows.find((r) => r.status === 'PROCESSED').count_lower_bound, 512);
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
