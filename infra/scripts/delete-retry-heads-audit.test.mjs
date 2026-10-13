import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { buildDeleteRetryHeadsAuditSql } from './delete-retry-heads-audit.mjs';
const fixture = `CREATE TYPE "ModerationDeleteIntentStatus" AS ENUM ('PENDING','RETRYABLE','WAITING_CAPABILITY','AMBIGUOUS','IN_PROGRESS','SUCCEEDED');
CREATE TABLE moderation_delete_intents (id text PRIMARY KEY, status "ModerationDeleteIntentStatus", next_attempt_at timestamp,
 execute_at timestamp, updated_at timestamp, attempt_count int, last_attempt_at timestamp, retry_until_at timestamp,
 delete_dispatch_started_at timestamp, remote_delete_succeeded_at timestamp, lease_expires_at timestamp, last_status_code int);
CREATE INDEX moderation_delete_intents_due_idx ON moderation_delete_intents(status,next_attempt_at,execute_at);
CREATE INDEX moderation_delete_intents_retention_idx ON moderation_delete_intents(status,updated_at);
CREATE TABLE moderation_delete_intent_reasons (intent_id text,reason_key text,rule_code text);
CREATE UNIQUE INDEX moderation_delete_intent_reasons_intent_reason_key ON moderation_delete_intent_reasons(intent_id,reason_key);
INSERT INTO moderation_delete_intents (id,status,next_attempt_at,attempt_count)
 SELECT 'private-'||n,'RETRYABLE','2026-10-13'::timestamp+n*interval '1 second',1 FROM generate_series(1,40)n;
INSERT INTO moderation_delete_intent_reasons VALUES ('private-1','private-key','VOICE_BLOCKED_DELETE'),('private-2','private-key','private-code');`;
test('bounds retry heads and reasons without exposing identities or asserting execution', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  const r = (await db.query(buildDeleteRetryHeadsAuditSql())).rows[0].json_build_object;
  assert.equal(r.sample_truncated, true);
  assert.equal(r.rows.length, 32);
  assert.equal(r.policy_checked, false);
  assert.deepEqual(r.rows[0].reasons, { truncated: false, codes: ['VOICE_BLOCKED_DELETE'] });
  assert.deepEqual(r.rows[1].reasons.codes, ['other']);
  assert.doesNotMatch(JSON.stringify(r), /private-/u);
});
test(
  'native heads stay indexed with retained history and tied clocks',
  { skip: !process.env.MAXIM_TEST_POSTGRES_URL },
  async (t) => {
    const url = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    const db = new pg.Client({ connectionString: url.href });
    await db.connect();
    t.after(async () => {
      await db.query('ROLLBACK');
      await db.end();
    });
    await db.query(`BEGIN;CREATE SCHEMA retry_heads_${process.pid};SET LOCAL search_path TO retry_heads_${process.pid};${fixture}
 INSERT INTO moderation_delete_intents (id,status,next_attempt_at,attempt_count)
 SELECT 'history-'||n,'SUCCEEDED','2026-10-01',2 FROM generate_series(1,20000)n;
 INSERT INTO moderation_delete_intent_reasons SELECT 'history-'||n,'r','private' FROM generate_series(1,20000)n;
 ANALYZE moderation_delete_intents;ANALYZE moderation_delete_intent_reasons;`);
    const plan = (
      await db.query('EXPLAIN (ANALYZE,FORMAT JSON) ' + buildDeleteRetryHeadsAuditSql())
    ).rows[0]['QUERY PLAN'][0].Plan;
    const nodes = [];
    function walk(n) {
      nodes.push(n);
      for (const c of n.Plans ?? []) walk(c);
    }
    walk(plan);
    for (const n of nodes.filter((n) => n['Relation Name'])) {
      assert.notEqual(n['Node Type'], 'Seq Scan');
      assert.ok(
        (n['Actual Rows'] + (n['Rows Removed by Filter'] ?? 0)) * n['Actual Loops'] <= 4096,
      );
    }
    assert.ok(nodes.some((n) => n['Index Name'] === 'moderation_delete_intents_due_idx'));
  },
);
