import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  buildModerationOutcomesAuditSql,
  buildModerationOutcomesIndexReadinessSql,
} from './moderation-outcomes-audit.mjs';

const fixture = `CREATE TABLE moderation_events (
  id text PRIMARY KEY, created_at timestamp(3) NOT NULL DEFAULT now(),
  action text NOT NULL, operator text NOT NULL DEFAULT 'BOT', event_type text NOT NULL DEFAULT 'MESSAGE',
  rule_code text NOT NULL, metadata jsonb, chat_id text, user_id text, message_id text, masked_excerpt text
);
CREATE INDEX moderation_events_created_at_idx ON moderation_events (created_at);`;
const query = buildModerationOutcomesAuditSql();
const readinessQuery = () => {
  const sql = buildModerationOutcomesIndexReadinessSql();
  return sql.slice(0, sql.indexOf('\\gset'));
};
const nativePostgresUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim() ?? '';
const localNativePostgres = (() => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(nativePostgresUrl).hostname);
  } catch {
    return false;
  }
})();

test('classifies only confirmed BAN and verified mute enforcement and keeps mute installation distinct', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  const events = [
    ['BAN', 'BOT', 'MESSAGE', 'private-rule', { sanctionApplied: true }],
    ['BAN', 'ADMIN', 'MEMBER_ACTION', 'MANUAL_BAN', { mode: 'MAX_BLOCK' }],
    ['BAN', 'ADMIN', 'MEMBER_ACTION', 'MANUAL_BAN', { mode: 'MAX_REMOVE_ONLY' }],
    ['BAN', 'ADMIN', 'MEMBER_ACTION', 'MANUAL_BAN', { mode: 'private-unknown' }],
    ['BAN', 'BOT', 'MESSAGE', 'private-rule', { sanctionApplied: 'true' }],
    ['MUTE', 'BOT', 'MESSAGE', 'private-rule', { sanctionApplied: true }],
    ['MUTE', 'ADMIN', 'MEMBER_ACTION', 'MANUAL_MUTE', { muteExpiresAt: 'private-invalid' }],
    ['MUTE', 'BOT', 'MESSAGE', 'private-rule', { sanctionApplied: false }],
    ['DELETE_MESSAGE', 'BOT', 'MESSAGE', 'MUTE_ACTIVE_DELETE', { moderationDeleteVerified: true }],
    [
      'DELETE_MESSAGE',
      'BOT',
      'MESSAGE',
      'MUTE_ACTIVE_DELETE',
      { moderationDeleteVerified: 'true' },
    ],
    ['DELETE_MESSAGE', 'BOT', 'MESSAGE', 'private-rule', { moderationDeleteVerified: true }],
    ['BAN', 'private-operator', 'MESSAGE', 'private-rule', { sanctionApplied: true }],
  ];
  for (const [i, event] of events.entries()) {
    await db.query(
      `INSERT INTO moderation_events (id, action, operator, event_type, rule_code, metadata,
        chat_id, user_id, message_id, masked_excerpt) VALUES ($1,$2,$3,$4,$5,$6::jsonb,
        'private-chat','private-user','private-message','private-content')`,
      [
        `private-${i}`,
        ...event.slice(0, 4),
        JSON.stringify({ ...event[4], private: 'private-data' }),
      ],
    );
  }
  const report = (await db.query(query)).rows[0].json_build_object;
  const counts = Object.fromEntries(
    report.rows.map((row) => [`${row.evidence}:${row.origin}`, row.count_lower_bound]),
  );
  assert.equal(report.sampled_events, 12);
  assert.equal(report.sample_truncated, false);
  assert.equal(report.sample_complete, true);
  assert.equal(report.all_attempts_observed, false);
  assert.equal(report.current_mute_state_proven, false);
  assert.equal(report.fleet_health_proven, false);
  assert.equal(counts['BAN_REMOTE_CONFIRMED:BOT'], 1);
  assert.equal(counts['BAN_REMOTE_CONFIRMED:ADMIN'], 1);
  assert.equal(counts['MEMBER_REMOVAL_REMOTE_CONFIRMED:ADMIN'], 1);
  assert.equal(counts['BAN_EVENT_UNVERIFIED:ADMIN'], 1);
  assert.equal(counts['BAN_EVENT_UNVERIFIED:BOT'], 1);
  assert.equal(counts['BAN_EVENT_UNVERIFIED:UNKNOWN'], 1);
  assert.equal(counts['MUTE_INSTALLED:BOT'], 1);
  assert.equal(counts['MUTE_INSTALLED:ADMIN'], 1);
  assert.equal(counts['MUTE_EVENT_UNVERIFIED:BOT'], 1);
  assert.equal(counts['MUTE_ENFORCEMENT_REMOTE_CONFIRMED:BOT'], 1);
  assert.equal(counts['MUTE_ENFORCEMENT_EVENT_UNVERIFIED:BOT'], 1);
  assert.equal(report.other_events, 1);
  assert.doesNotMatch(
    JSON.stringify(report),
    /private-|chat_id|user_id|message_id|masked_excerpt|metadata/u,
  );
});

test('reports an empty complete event sample without treating absence as fleet success', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO moderation_events (id, created_at, action, rule_code)
    VALUES ('private-old', now() - interval '61 minutes', 'BAN', 'private-rule'),
      ('private-future', now() + interval '2 minutes', 'MUTE', 'private-rule');`);
  const report = (await db.query(query)).rows[0].json_build_object;
  assert.equal(report.sampled_events, 0);
  assert.deepEqual(report.rows, []);
  assert.equal(report.sample_complete, true);
  assert.equal(report.fleet_health_proven, false);
});

test('requires the expected live nonpartial created_at index and timestamp type', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  assert.equal((await db.query(readinessQuery())).rows[0].moderation_outcomes_index_ready, true);
  await db.exec('DROP INDEX moderation_events_created_at_idx;');
  assert.equal((await db.query(readinessQuery())).rows[0].moderation_outcomes_index_ready, false);
  await db.exec(
    'CREATE INDEX moderation_events_created_at_idx ON moderation_events (created_at DESC);',
  );
  assert.equal((await db.query(readinessQuery())).rows[0].moderation_outcomes_index_ready, false);
  await db.exec(
    "DROP INDEX moderation_events_created_at_idx; CREATE INDEX moderation_events_created_at_idx ON moderation_events (created_at) WHERE action = 'BAN';",
  );
  assert.equal((await db.query(readinessQuery())).rows[0].moderation_outcomes_index_ready, false);
});

test(
  'native PostgreSQL visits at most 513 base rows with retained history and tied recent timestamps',
  { skip: !localNativePostgres, timeout: 30_000 },
  async (t) => {
    const client = new pg.Client({
      connectionString: nativePostgresUrl,
      statement_timeout: 5000,
      query_timeout: 8000,
    });
    await client.connect();
    t.after(async () => {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    });
    // FLAG: Native plan execution belongs only to this disposable local fixture. Production
    // accepts plain EXPLAIN, never EXPLAIN ANALYZE or caller SQL.
    await client.query('BEGIN');
    await client.query(
      'CREATE SCHEMA moderation_outcomes_fixture; SET LOCAL search_path TO moderation_outcomes_fixture, public;',
    );
    await client.query(fixture);
    await client.query(`INSERT INTO moderation_events (id, created_at, action, rule_code)
      SELECT 'private-old-' || i, now() - interval '2 days' - i * interval '1 second', 'BAN', 'private-rule'
      FROM generate_series(1, 100000) i;
      INSERT INTO moderation_events (id, created_at, action, rule_code, metadata)
      SELECT 'private-recent-' || i, now() - interval '1 minute', 'MUTE', 'private-rule', '{"sanctionApplied":true}'
      FROM generate_series(1, 1200) i;
      ANALYZE moderation_events;
      SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off;
      SET LOCAL max_parallel_workers_per_gather = 0;`);
    const report = (await client.query(query)).rows[0].json_build_object;
    assert.equal(report.sampled_events, 512);
    assert.equal(report.sample_truncated, true);
    assert.equal(report.sample_complete, false);
    assert.equal(report.rows[0].count_lower_bound, 512);
    const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`)).rows[0][
      'QUERY PLAN'
    ][0].Plan;
    const nodes = [];
    const walk = (node) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) walk(child);
    };
    walk(plan);
    const tableWalks = nodes.filter((node) => node['Relation Name'] === 'moderation_events');
    assert.equal(tableWalks.length, 1);
    assert.equal(tableWalks[0]['Index Name'], 'moderation_events_created_at_idx');
    assert.equal(tableWalks[0]['Actual Rows'], 513);
    assert.equal(tableWalks[0]['Actual Loops'], 1);
    assert.equal(tableWalks[0]['Rows Removed by Filter'] ?? 0, 0);
    assert.equal(
      (
        await client.query(
          readinessQuery().replaceAll(
            'public.moderation_events',
            'moderation_outcomes_fixture.moderation_events',
          ),
        )
      ).rows[0].moderation_outcomes_index_ready,
      true,
    );
    assert.doesNotMatch(JSON.stringify(report), /private-/u);
  },
);

test('CLI accepts only the fixed audit and nonexecuting EXPLAIN', () => {
  const script = resolve(import.meta.dirname, 'moderation-outcomes-audit.mjs');
  for (const args of [
    ['SELECT 1'],
    ['--file', '/tmp/private'],
    ['private-chat'],
    ['--explain', 'extra'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
  assert.match(buildModerationOutcomesAuditSql(true), /^EXPLAIN \(FORMAT JSON\)/u);
  assert.doesNotMatch(buildModerationOutcomesAuditSql(true), /EXPLAIN\s+ANALYZE/iu);
});
