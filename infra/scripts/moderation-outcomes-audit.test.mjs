import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  buildModerationOutcomesAuditSql,
  buildModerationOutcomesIndexReadinessSql,
  parseModerationOutcomesAuditArgs,
} from './moderation-outcomes-audit.mjs';

const fixture = `CREATE TABLE moderation_events (
  id text PRIMARY KEY, created_at timestamp(3) NOT NULL DEFAULT now(),
  action text NOT NULL, operator text NOT NULL DEFAULT 'BOT', event_type text NOT NULL DEFAULT 'MESSAGE',
  rule_code text NOT NULL, metadata jsonb, chat_id text, user_id text, message_id text, masked_excerpt text,
  bot_id text
);
CREATE INDEX moderation_events_created_at_idx ON moderation_events (created_at);
CREATE INDEX moderation_events_bot_id_created_at_idx ON moderation_events (bot_id, created_at DESC);`;
const enumFixture = `CREATE TYPE "SanctionAction" AS ENUM ('NONE', 'WARN', 'DELETE_MESSAGE', 'MUTE', 'KICK', 'BAN');
CREATE TYPE "Operator" AS ENUM ('BOT', 'ADMIN');
CREATE TYPE "EventType" AS ENUM ('MESSAGE', 'MEMBER_ACTION', 'SYSTEM');
${fixture
  .replace('action text', 'action "SanctionAction"')
  .replace('operator text', 'operator "Operator"')
  .replace('event_type text', 'event_type "EventType"')}`;
const query = buildModerationOutcomesAuditSql();
const readinessQuery = (botId = null) => {
  const sql = buildModerationOutcomesIndexReadinessSql(botId);
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
  assert.equal(report.schema_version, 3);
  assert.equal(report.selection_basis, 'GLOBAL_LATEST_RECORDED_EVENTS');
  assert.equal(report.bot_scope, 'ALL_RECORDED_BOTS');
  assert.equal(report.null_bot_events_in_scope, true);
  assert.equal(report.denominator_basis, 'SAMPLED_EVENTS_NOT_UNIQUE_ACTIONS_OR_ELIGIBLE_INPUTS');
  assert.equal(report.rule_family_counts_additive, true);
  assert.equal(report.compatibility_rows_overlap_rule_families, true);
  assert.equal(report.rule_eligible_inputs_observed, false);
  assert.equal(report.rule_policy_checked, false);
  assert.equal(report.bot_chat_coverage_proven, false);
  assert.equal(report.action_latency_proven, false);
  assert.equal(report.metadata_inspection_max_bytes, 32768);
  assert.equal(
    report.rule_family_rows.reduce((sum, row) => sum + row.count_lower_bound, 0),
    12,
  );
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
    /private-|chat_id|user_id|message_id|masked_excerpt|"metadata":/u,
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
  assert.deepEqual(report.voice_rows, []);
  assert.deepEqual(report.rule_family_rows, []);
  assert.deepEqual(report.metadata_rows, []);
  assert.equal(report.sample_span_seconds, null);
  assert.equal(report.sample_complete, true);
  assert.equal(report.fleet_health_proven, false);
});

test('voice observations require independent boolean delete proof and never imply input coverage', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  const events = [
    ['DELETE_MESSAGE', 'BOT', 'VOICE_BLOCKED_DELETE', { moderationDeleteVerified: true }],
    ['DELETE_MESSAGE', 'BOT', 'VOICE_BLOCKED', { moderationDeleteVerified: true }],
    ['DELETE_MESSAGE', 'BOT', 'VOICE_BLOCKED_DELETE', { moderationDeleteVerified: 'true' }],
    ['NONE', 'BOT', 'VOICE_BLOCKED', { moderationDeleteVerified: true }],
    ['DELETE_MESSAGE', 'ADMIN', 'VOICE_BLOCKED_DELETE', { moderationDeleteVerified: true }],
    ['MUTE', 'BOT', 'VOICE_BLOCKED', { sanctionApplied: true }],
    ['DELETE_MESSAGE', 'BOT', 'private-unknown-voice', { moderationDeleteVerified: true }],
  ];
  for (const [i, event] of events.entries()) {
    await db.query(
      `INSERT INTO moderation_events
      (id, action, operator, rule_code, metadata, masked_excerpt)
      VALUES ($1, $2, $3, $4, $5::jsonb, 'private-voice-content')`,
      [`private-${i}`, ...event.slice(0, 3), JSON.stringify(event[3])],
    );
  }
  const report = (await db.query(query)).rows[0].json_build_object;
  assert.equal(report.schema_version, 3);
  assert.equal(report.voice_eligible_inputs_observed, false);
  assert.equal(report.voice_policy_checked, false);
  assert.equal(report.fleet_health_proven, false);
  const counts = Object.fromEntries(
    report.voice_rows.map((r) => [r.evidence, r.count_lower_bound]),
  );
  assert.equal(counts.VOICE_DELETE_REMOTE_CONFIRMED, 2);
  assert.equal(counts.VOICE_EVENT_WITHOUT_DELETE_PROOF, 4);
  assert.equal(report.rows.find((r) => r.evidence === 'MUTE_INSTALLED').count_lower_bound, 1);
  assert.doesNotMatch(JSON.stringify(report), /private-|masked_excerpt|"metadata":/u);
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

test('per-bot readiness requires the exact composite index, directions, collation and column types', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  const ready = async () =>
    (await db.query(readinessQuery('private-bot'))).rows[0].moderation_outcomes_index_ready;
  assert.equal(await ready(), true);
  const wrongDefinitions = [
    'ON moderation_events (bot_id, created_at)',
    'ON moderation_events (created_at DESC, bot_id)',
    'ON moderation_events (bot_id, created_at DESC) INCLUDE (id)',
    'ON moderation_events (bot_id, created_at DESC) WHERE bot_id IS NOT NULL',
    'ON moderation_events (bot_id COLLATE "C", created_at DESC)',
  ];
  for (const definition of wrongDefinitions) {
    await db.exec(`DROP INDEX moderation_events_bot_id_created_at_idx;
      CREATE INDEX moderation_events_bot_id_created_at_idx ${definition};`);
    assert.equal(await ready(), false, definition);
  }
  await db.exec(`DROP INDEX moderation_events_bot_id_created_at_idx;
    ALTER TABLE moderation_events ALTER COLUMN bot_id TYPE varchar(128);
    CREATE INDEX moderation_events_bot_id_created_at_idx ON moderation_events (bot_id, created_at DESC);`);
  assert.equal(await ready(), false);
  await db.exec('ALTER TABLE moderation_events ALTER COLUMN bot_id TYPE text;');
  assert.equal(await ready(), true);
  await db.exec('ALTER TABLE moderation_events ALTER COLUMN created_at TYPE timestamp(6);');
  assert.equal(await ready(), false);
});

test(
  'native psql fails closed before report execution for missing or incompatible outcome indexes',
  { skip: !localNativePostgres, timeout: 30_000 },
  () => {
    const address = new URL(nativePostgresUrl);
    for (const [botId, change] of [
      [null, 'DROP INDEX moderation_events_created_at_idx;'],
      ['private-bot', 'DROP INDEX moderation_events_bot_id_created_at_idx;'],
      [
        'private-bot',
        `DROP INDEX moderation_events_bot_id_created_at_idx;
        CREATE INDEX moderation_events_bot_id_created_at_idx ON moderation_events (bot_id, created_at);`,
      ],
    ]) {
      const admission = buildModerationOutcomesIndexReadinessSql(botId).replaceAll(
        'public.moderation_events',
        'moderation_admission_fixture.moderation_events',
      );
      const result = spawnSync(
        'psql',
        [
          '-X',
          '--no-password',
          '-qAt',
          '-v',
          'ON_ERROR_STOP=1',
          '-v',
          'VERBOSITY=terse',
          '-v',
          'SHOW_CONTEXT=never',
        ],
        {
          encoding: 'utf8',
          timeout: 8000,
          env: {
            ...process.env,
            PGHOST: address.hostname,
            PGPORT: address.port,
            PGUSER: decodeURIComponent(address.username),
            PGPASSWORD: decodeURIComponent(address.password),
            PGDATABASE: decodeURIComponent(address.pathname.slice(1)),
            PGOPTIONS: '-c statement_timeout=5000 -c lock_timeout=1000',
          },
          input: `BEGIN;
CREATE SCHEMA moderation_admission_fixture;
SET LOCAL search_path TO moderation_admission_fixture, public;
${fixture}
${change}
${admission}
SELECT 'private-report-must-never-run';
ROLLBACK;`,
        },
      );
      assert.equal(result.status, 3, result.stderr);
      assert.match(result.stdout, /MAXIM_MODERATION_OUTCOMES_INDEX_INVALID/u);
      assert.doesNotMatch(result.stdout, /private-report-must-never-run/u);
    }
  },
);

test(
  'native PostgreSQL reports closed rule families, strict proofs and rejected metadata without leaking source values',
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
    await client.query('BEGIN');
    await client.query(
      'CREATE SCHEMA moderation_families_fixture; SET LOCAL search_path TO moderation_families_fixture, public;',
    );
    await client.query(fixture);
    const families = [
      ['LINK_HISTORY_RECOVERY', 'LINK'],
      ['PROFANITY_DELETE', 'PROFANITY'],
      ['COMMERCIAL_AD_DELETE', 'COMMERCIAL_TEXT'],
      ['COMMERCIAL_LLM_DELETE', 'COMMERCIAL_AI'],
      ['COMMERCIAL_OCR_DELETE', 'COMMERCIAL_OCR'],
      ['MESSAGE_BLOCKED_WORD_DELETE', 'STOP_WORD'],
      ['MESSAGE_BLOCKED_DOMAIN_DELETE', 'STOP_DOMAIN'],
      ['PHONE_NUMBER_BLOCKED_DELETE', 'PHONE'],
      ['MESSAGE_TOO_LONG_DELETE', 'MESSAGE_LENGTH'],
      ['MESSAGE_RATE_LIMIT_DELETE', 'MESSAGE_RATE'],
      ['MESSAGE_COUNT_LIMIT_DELETE', 'MESSAGE_COUNT'],
      ['FORWARDED_MESSAGE_BLOCKED_DELETE', 'MEDIA_POLICY'],
      ['VOICE_BLOCKED_DELETE', 'VOICE'],
      ['PHOTO_RATE_LIMIT_DELETE', 'PHOTO_RATE'],
      ['STICKER_RATE_LIMIT_DELETE', 'STICKER_RATE'],
      ['DUPLICATE_DELETE', 'DUPLICATE'],
      ['REQUIRED_SUBSCRIPTION_DELETE', 'REQUIRED_SUBSCRIPTION'],
      ['INVITATION_ACCESS_DELETE', 'INVITATION_ACCESS'],
      ['MUTE_ACTIVE_DELETE', 'MUTE_STATE'],
      ['GLOBAL_SPAMMER_MESSAGE_DELETE', 'GLOBAL_SPAMMER'],
      ['BOT_ACCOUNT_MESSAGE_DELETE', 'BOT_ACCOUNT'],
      ['LOCAL_ADMIN_BLOCK_MESSAGE_DELETE', 'LOCAL_BLOCK'],
      ['MANUAL_GROUP_CLOSE_DELETE', 'CLOSED_CHAT'],
      ['MANUAL_BAN', 'MANUAL_SANCTION'],
      ['BOT_MESSAGE_AUTO_DELETE', 'SERVICE_CLEANUP'],
    ];
    const events = families.map(([rule]) => [
      'DELETE_MESSAGE',
      'BOT',
      rule,
      { moderationDeleteVerified: true },
    ]);
    const falseLikeProofs = [false, 'false', 'true', 0, 1, null, [], {}];
    for (const value of falseLikeProofs) {
      events.push(
        ['DELETE_MESSAGE', 'BOT', 'LINK_BLOCKED_DELETE', { moderationDeleteVerified: value }],
        ['DELETE_MESSAGE', 'BOT', 'COMMERCIAL_LLM_DELETE', { moderationDeleteVerified: value }],
        ['BAN', 'BOT', 'COMMERCIAL_AD', { sanctionApplied: value }],
        ['MUTE', 'BOT', 'COMMERCIAL_AD', { sanctionApplied: value }],
      );
    }
    for (const metadata of [null, [], true, 123, 'private-metadata']) {
      events.push(['DELETE_MESSAGE', 'BOT', 'PHONE_NUMBER_BLOCKED_DELETE', metadata]);
    }
    events.push(
      ['DELETE_MESSAGE', 'ADMIN', 'LINK_BLOCKED_DELETE', { moderationDeleteVerified: true }],
      ['DELETE_MESSAGE', 'ADMIN', 'COMMERCIAL_LLM_DELETE', { moderationDeleteVerified: true }],
      ['NONE', 'BOT', 'COMMERCIAL_LLM_DELETE', { moderationDeleteVerified: true }],
      [
        'DELETE_MESSAGE',
        'BOT',
        'COMMERCIAL_LLM_DELETE_private-rule',
        { moderationDeleteVerified: true },
      ],
      [
        'DELETE_MESSAGE',
        'private-origin',
        'LINK_BLOCKED_DELETE',
        { moderationDeleteVerified: true },
      ],
      [
        'DELETE_MESSAGE',
        'BOT',
        'LINK_BLOCKED_DELETE_private-rule',
        { moderationDeleteVerified: true },
      ],
      ['private-action', 'private-origin', 'private-rule\nBAN', { raw_error: 'private-error' }],
      ['NONE', 'BOT', 'REQUIRED_SUBSCRIPTION', { sanctionApplied: false }],
      ['WARN', 'BOT', 'REQUIRED_SUBSCRIPTION', { sanctionApplied: true }],
      ['KICK', 'BOT', 'GLOBAL_SPAMMER_KICK', { sanctionApplied: true }],
    );
    for (const [i, [action, origin, rule, metadata]] of events.entries()) {
      await client.query(
        `INSERT INTO moderation_events
        (id, created_at, action, operator, rule_code, metadata,
          chat_id, user_id, message_id, masked_excerpt)
        VALUES ($1, now() - ($2::int * interval '1 second'), $3, $4, $5, $6::jsonb,
          'private-chat', 'private-user', 'private-message', 'private-content')`,
        [`private-${i}`, i, action, origin, rule, JSON.stringify(metadata)],
      );
    }
    await client.query(`ALTER TABLE moderation_events ALTER COLUMN metadata SET STORAGE EXTERNAL;
      INSERT INTO moderation_events (id, action, rule_code, metadata)
      VALUES ('private-oversized', 'DELETE_MESSAGE', 'PHONE_NUMBER_BLOCKED_DELETE',
        jsonb_build_object('moderationDeleteVerified', true, 'private', repeat('x', 40000)));
      ALTER TABLE moderation_events ALTER COLUMN metadata SET STORAGE EXTENDED;
      INSERT INTO moderation_events (id, action, rule_code, metadata)
      VALUES ('private-compressed', 'DELETE_MESSAGE', 'PHONE_NUMBER_BLOCKED_DELETE',
        jsonb_build_object('moderationDeleteVerified', true, 'private', repeat('x', 40000)));`);
    assert.notEqual(
      (
        await client.query(
          "SELECT pg_column_compression(metadata) AS compression FROM moderation_events WHERE id = 'private-compressed'",
        )
      ).rows[0].compression,
      null,
    );
    const report = (await client.query(query)).rows[0].json_build_object;
    const counts = Object.fromEntries(
      report.rule_family_rows.map((row) => [
        `${row.rule_family}:${row.action}:${row.origin}:${row.evidence}`,
        row.count_lower_bound,
      ]),
    );
    for (const [, family] of families) {
      const evidence =
        family === 'MUTE_STATE' ? 'MUTE_ENFORCEMENT_REMOTE_CONFIRMED' : 'DELETE_REMOTE_CONFIRMED';
      assert.equal(counts[`${family}:DELETE_MESSAGE:BOT:${evidence}`], 1);
    }
    assert.equal(counts['LINK:DELETE_MESSAGE:BOT:DELETE_EVENT_UNVERIFIED'], 8);
    assert.equal(counts['COMMERCIAL_AI:DELETE_MESSAGE:BOT:DELETE_EVENT_UNVERIFIED'], 8);
    assert.equal(counts['COMMERCIAL_AI:DELETE_MESSAGE:ADMIN:DELETE_EVENT_UNVERIFIED'], 1);
    assert.equal(counts['COMMERCIAL_AI:NONE:BOT:DECISION_EVENT_ONLY'], 1);
    assert.equal(counts['COMMERCIAL_TEXT:BAN:BOT:BAN_EVENT_UNVERIFIED'], 8);
    assert.equal(counts['COMMERCIAL_TEXT:MUTE:BOT:MUTE_EVENT_UNVERIFIED'], 8);
    assert.equal(counts['PHONE:DELETE_MESSAGE:BOT:DELETE_EVENT_UNVERIFIED'], 7);
    assert.equal(counts['LINK:DELETE_MESSAGE:ADMIN:DELETE_EVENT_UNVERIFIED'], 1);
    assert.equal(counts['LINK:DELETE_MESSAGE:UNKNOWN:DELETE_EVENT_UNVERIFIED'], 1);
    assert.equal(counts['OTHER_RULE:DELETE_MESSAGE:BOT:DELETE_REMOTE_CONFIRMED'], 2);
    assert.equal(counts['OTHER_RULE:UNKNOWN:UNKNOWN:UNKNOWN_ACTION_EVENT'], 1);
    assert.equal(counts['REQUIRED_SUBSCRIPTION:NONE:BOT:DECISION_EVENT_ONLY'], 1);
    assert.equal(counts['REQUIRED_SUBSCRIPTION:WARN:BOT:WARN_EVENT_WITHOUT_DELIVERY_PROOF'], 1);
    assert.equal(counts['GLOBAL_SPAMMER:KICK:BOT:KICK_EVENT_UNVERIFIED'], 1);
    const metadataCounts = Object.fromEntries(
      report.metadata_rows.map((row) => [row.metadata_admission, row.count_lower_bound]),
    );
    assert.equal(metadataCounts.COMPRESSED_NOT_INSPECTED, 1);
    assert.equal(metadataCounts.OVERSIZED_NOT_INSPECTED, 1);
    assert.equal(metadataCounts.NON_OBJECT, 5);
    assert.equal(report.sampled_events, events.length + 2);
    assert.equal(report.sample_complete, true);
    assert.equal(
      report.rule_family_rows.reduce((sum, row) => sum + row.count_lower_bound, 0),
      report.sampled_events,
    );
    assert.equal(
      report.metadata_rows.reduce((sum, row) => sum + row.count_lower_bound, 0),
      report.sampled_events,
    );
    assert.equal(Number(report.sample_span_seconds), events.length - 1);
    assert.equal(report.rule_eligible_inputs_observed, false);
    assert.equal(report.rule_policy_checked, false);
    assert.equal(report.bot_chat_coverage_proven, false);
    assert.equal(report.fleet_health_proven, false);
    assert.doesNotMatch(
      JSON.stringify(report),
      /private-|chat_id|user_id|message_id|masked_excerpt|sanctionApplied|moderationDeleteVerified|raw_error/u,
    );
  },
);

test(
  'native PostgreSQL bounds global and per-bot walks with retained history, tied timestamps and competing bots',
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
    await client.query(enumFixture);
    await client.query(`INSERT INTO moderation_events (id, created_at, bot_id, action, rule_code)
      SELECT 'private-old-' || i, now() - interval '2 days' - i * interval '1 second', 'private-target-bot', 'BAN', 'private-rule'
      FROM generate_series(1, 100000) i;
      INSERT INTO moderation_events (id, created_at, bot_id, action, rule_code, metadata)
      SELECT 'private-recent-' || i, now() - interval '1 minute', 'private-target-bot', 'MUTE', 'private-rule', '{"sanctionApplied":true}'
      FROM generate_series(1, 1200) i;
      INSERT INTO moderation_events (id, created_at, bot_id, action, rule_code, metadata)
      SELECT 'private-competing-' || i, now() - interval '1 second', 'private-busy-bot', 'MUTE', 'private-rule', '{"sanctionApplied":true}'
      FROM generate_series(1, 100000) i;
      INSERT INTO moderation_events (id, created_at, bot_id, action, rule_code, metadata)
      SELECT 'private-rare-' || i, now() - interval '55 minutes', 'private-rare-bot', 'DELETE_MESSAGE', 'LINK_BLOCKED_DELETE', '{"moderationDeleteVerified":true}'
      FROM generate_series(1, 7) i;
      INSERT INTO moderation_events (id, created_at, action, rule_code)
      VALUES ('private-null-bot', now() - interval '2 seconds', 'NONE', 'private-rule');
      ANALYZE moderation_events;
      SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off;
      SET LOCAL max_parallel_workers_per_gather = 0;`);
    const report = (await client.query(query)).rows[0].json_build_object;
    assert.equal(report.sampled_events, 512);
    assert.equal(report.sample_truncated, true);
    assert.equal(report.sample_complete, false);
    assert.equal(report.rows[0].count_lower_bound, 512);
    assert.equal(report.rule_family_rows[0].count_lower_bound, 512);
    assert.equal(report.rule_family_rows[0].rule_family, 'OTHER_RULE');
    assert.equal(Number(report.sample_span_seconds), 0);
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
    for (const [botId, expectedCount, expectedWalk, complete] of [
      ['private-target-bot', 512, 513, false],
      ['private-rare-bot', 7, 7, true],
      ['private-absent-bot', 0, 0, true],
    ]) {
      const scopedQuery = buildModerationOutcomesAuditSql(false, botId);
      const scopedReport = (await client.query(scopedQuery)).rows[0].json_build_object;
      assert.equal(scopedReport.sampled_events, expectedCount);
      assert.equal(scopedReport.sample_complete, complete);
      assert.equal(scopedReport.bot_scope, 'ONE_REQUESTED_BOT');
      assert.equal(scopedReport.selection_basis, 'ONE_BOT_LATEST_RECORDED_EVENTS');
      assert.equal(scopedReport.null_bot_events_in_scope, false);
      assert.equal(scopedReport.bot_chat_coverage_proven, false);
      assert.equal(scopedReport.rule_policy_checked, false);
      assert.equal(scopedReport.fleet_health_proven, false);
      assert.equal(
        scopedReport.rule_family_rows.reduce((sum, row) => sum + row.count_lower_bound, 0),
        expectedCount,
      );
      if (botId === 'private-rare-bot') {
        assert.equal(scopedReport.rule_family_rows[0].rule_family, 'LINK');
        assert.equal(scopedReport.rule_family_rows[0].evidence, 'DELETE_REMOTE_CONFIRMED');
      }
      const scopedPlan = (
        await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${scopedQuery}`)
      ).rows[0]['QUERY PLAN'][0].Plan;
      nodes.length = 0;
      walk(scopedPlan);
      const scopedWalks = nodes.filter((node) => node['Relation Name'] === 'moderation_events');
      assert.equal(scopedWalks.length, 1);
      assert.equal(scopedWalks[0]['Index Name'], 'moderation_events_bot_id_created_at_idx');
      assert.equal(scopedWalks[0]['Actual Rows'], expectedWalk);
      assert.equal(scopedWalks[0]['Actual Loops'], 1);
      assert.equal(scopedWalks[0]['Rows Removed by Filter'] ?? 0, 0);
      assert.match(scopedWalks[0]['Index Cond'], /bot_id =/u);
      const planned = await client.query(buildModerationOutcomesAuditSql(true, botId));
      const genericPlan = planned.find((result) => result.command === 'EXPLAIN').rows[0][
        'QUERY PLAN'
      ][0].Plan;
      nodes.length = 0;
      walk(genericPlan);
      const genericWalks = nodes.filter((node) => node['Relation Name'] === 'moderation_events');
      assert.equal(genericWalks.length, 1);
      assert.equal(genericWalks[0]['Index Name'], 'moderation_events_bot_id_created_at_idx');
      assert.match(genericWalks[0]['Index Cond'], /bot_id = ANY.*\$1/u);
      assert.doesNotMatch(JSON.stringify(genericPlan), /private-|Actual Rows/u);
      assert.equal(
        (
          await client.query(
            readinessQuery(botId).replaceAll(
              'public.moderation_events',
              'moderation_outcomes_fixture.moderation_events',
            ),
          )
        ).rows[0].moderation_outcomes_index_ready,
        true,
      );
      assert.doesNotMatch(JSON.stringify(scopedReport), /private-|bot_id/u);
    }
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
    ['--bot'],
    ['--bot', ''],
    ['--bot', '--explain'],
    ['--bot', "private-bot' OR true --"],
    ['--bot', 'private-bot\n'],
    ['--bot', 'x'.repeat(129)],
    ['--bot', 'private-bot', '--bot', 'other'],
    ['--explain', '--bot', 'private-bot'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
  assert.match(buildModerationOutcomesAuditSql(true), /^EXPLAIN \(FORMAT JSON\)/u);
  assert.doesNotMatch(buildModerationOutcomesAuditSql(true), /EXPLAIN\s+ANALYZE/iu);
  assert.throws(() => buildModerationOutcomesAuditSql('private-sql'), /fixed EXPLAIN flag/u);
  assert.throws(
    () => buildModerationOutcomesAuditSql(false, "private'"),
    /bounded bot identifier/u,
  );
  assert.throws(
    () => buildModerationOutcomesIndexReadinessSql('x'.repeat(129)),
    /bounded bot identifier/u,
  );
  assert.deepEqual(parseModerationOutcomesAuditArgs(['--bot', 'private-bot', '--explain']), {
    explain: true,
    botId: 'private-bot',
  });
  const scoped = spawnSync(process.execPath, [script, '--bot', 'private-bot', '--explain'], {
    encoding: 'utf8',
  });
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.match(scoped.stdout, /moderation_events_bot_id_created_at_idx/u);
  assert.match(scoped.stdout, /AND bot_id = ANY\(ARRAY\[\$1\]::text\[\]\)/u);
  assert.match(scoped.stdout, /EXECUTE moderation_outcomes_scoped_plan\('private-bot'\)/u);
  assert.match(scoped.stdout, /EXPLAIN \(FORMAT JSON\)/u);
});
