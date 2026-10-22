import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNetworkStatisticsAuditSql,
  buildNetworkStatisticsIndexReadinessSql,
  buildNetworkStatisticsPrivilegesSql,
  buildNetworkStatisticsObservationPrivilegesSql,
  NETWORK_STATISTICS_AUDIT_COLUMNS,
  NETWORK_STATISTICS_OBSERVATION_AUDIT_COLUMNS,
} from './network-statistics-audit.mjs';
import { readFileSync } from 'node:fs';

test('network audit validates and bounds exact entity input before emitting SQL', () => {
  for (const args of [
    [],
    ['1'],
    ['-1;DROP TABLE chats'],
    ['-1', '--explain-analyze'],
    ['-1', '--observations', '--observations'],
    ['-1', '--explain', '--explain'],
    [Array.from({ length: 13 }, (_, i) => `-${i + 1}`).join(',')],
  ])
    assert.throws(() => buildNetworkStatisticsAuditSql(args));
  const sql = buildNetworkStatisticsAuditSql(['-1,-2,-1', '--explain']);
  assert.match(sql, /^EXPLAIN \(FORMAT JSON\)/);
  assert.match(sql, /LIMIT 25/);
  assert.match(sql, /LIMIT 24/);
  assert.match(sql, /LIMIT 2/);
  assert.match(sql, /'requested_entities',2/);
  assert.doesNotMatch(sql, /EXPLAIN ANALYZE|normalized_payload|message_text|SELECT \*/);
});

test('network statistics uses exact optional metadata grants and attested bounded lookup indexes', () => {
  assert.equal(Object.values(NETWORK_STATISTICS_AUDIT_COLUMNS).flat().length, 15);
  assert.match(buildNetworkStatisticsPrivilegesSql(), /IN \(0,15\)/);
  assert.match(buildNetworkStatisticsPrivilegesSql(true), /IN \(15\)/);
  assert.match(
    buildNetworkStatisticsPrivilegesSql(true),
    /SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER/,
  );
  assert.match(buildNetworkStatisticsPrivilegesSql(true), /INSERT,UPDATE,REFERENCES/);
  const readiness = buildNetworkStatisticsIndexReadinessSql();
  for (const index of [
    'chats_pkey',
    'channel_audience_snapshots_chat_id_captured_at_idx',
    'channel_stats_sync_states_chat_id_key',
    'channel_posts_chat_id_published_at_idx',
    'channel_post_view_snapshots_channel_post_id_captured_at_idx',
  ])
    assert.ok(readiness.includes(index));
  assert.match(readiness, /idx.indisvalid AND idx.indisready AND idx.indislive/);
  const provision = readFileSync(
    new URL('./vps-provision-postgres-audit-role.sh', import.meta.url),
    'utf8',
  );
  assert.match(provision, /DO \$network_statistics_grants\$/);
  assert.match(provision, /network-statistics metadata privileges are not exact/);
  for (const table of Object.keys(NETWORK_STATISTICS_AUDIT_COLUMNS)) {
    assert.ok(provision.includes(`ON TABLE public.${table} TO maxim_audit`));
    assert.ok(
      readFileSync(new URL('./vps-postgres-audit.sh', import.meta.url), 'utf8').includes(
        `'${table}'`,
      ),
    );
  }
});

test('network statistics SQL executes on the old schema and preserves sample saturation', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE chats(id text PRIMARY KEY,entity_type text);
      CREATE TABLE channel_audience_snapshots(chat_id text,participants_count integer,captured_at timestamp);
      CREATE INDEX channel_audience_snapshots_chat_id_captured_at_idx ON channel_audience_snapshots(chat_id,captured_at DESC);
      CREATE TABLE channel_stats_sync_states(chat_id text,membership_coverage_from timestamp,views_coverage_from timestamp,
        last_audience_sync_at timestamp,last_views_sync_at timestamp,last_views_discovery_at timestamp);
      CREATE UNIQUE INDEX channel_stats_sync_states_chat_id_key ON channel_stats_sync_states(chat_id);
      CREATE TABLE channel_posts(id text,chat_id text,published_at timestamp,latest_snapshot_at timestamp);
      CREATE INDEX channel_posts_chat_id_published_at_idx ON channel_posts(chat_id,published_at DESC);
      CREATE TABLE channel_post_view_snapshots(channel_post_id text,captured_at timestamp);
      CREATE INDEX channel_post_view_snapshots_channel_post_id_captured_at_idx ON channel_post_view_snapshots(channel_post_id,captured_at DESC);
      INSERT INTO chats VALUES('-1','CHANNEL');
      INSERT INTO channel_audience_snapshots VALUES('-1',100,now()-interval '1 day'),('-1',110,now());
      INSERT INTO channel_posts SELECT 'post-'||n,'-1',now()-n*interval '1 minute',now() FROM generate_series(1,29) n;
      INSERT INTO channel_post_view_snapshots SELECT 'post-'||n,now()-s*interval '1 second' FROM generate_series(1,29) n CROSS JOIN generate_series(1,3) s;
    `);
    const readiness = buildNetworkStatisticsIndexReadinessSql().split(
      ' AS network_statistics_indexes_ready',
    )[0];
    assert.equal((await db.query(`${readiness} AS ready`)).rows[0].ready, true);
    const result = await db.query(buildNetworkStatisticsAuditSql(['-1']));
    const report = Object.values(result.rows[0])[0];
    assert.equal(report.v2_schema_present, false);
    assert.equal(report.entities[0].participants_count, 110);
    assert.equal(report.entities[0].sample_count, 24);
    assert.equal(report.entities[0].raw_snapshot_sample, 48);
    assert.equal(report.entities[0].capped, true);
    assert.equal(
      (await db.query(buildNetworkStatisticsAuditSql(['-1', '--explain']))).rows.length,
      1,
    );
    await assert.rejects(db.query(buildNetworkStatisticsAuditSql(['-1', '--observations'])));
    await db.exec(
      'DROP INDEX channel_posts_chat_id_published_at_idx; CREATE INDEX channel_posts_chat_id_published_at_idx ON channel_posts(chat_id,published_at)',
    );
    assert.equal((await db.query(`${readiness} AS ready`)).rows[0].ready, false);
    await db.exec('DROP INDEX channel_posts_chat_id_published_at_idx');
    assert.equal((await db.query(`${readiness} AS ready`)).rows[0].ready, false);
  } finally {
    await db.close();
  }
});

test('observation evidence executes with exact metadata grants, bounds intervals/owners and preserves missing data', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE maxim_audit;
      CREATE TABLE chats(id text PRIMARY KEY,entity_type text);
      CREATE TABLE channel_audience_snapshots(chat_id text,participants_count integer,captured_at timestamp);
      CREATE INDEX channel_audience_snapshots_chat_id_captured_at_idx ON channel_audience_snapshots(chat_id,captured_at DESC);
      CREATE TABLE channel_stats_sync_states(chat_id text,membership_coverage_from timestamp,views_coverage_from timestamp,
        last_audience_sync_at timestamp,last_views_sync_at timestamp,last_views_discovery_at timestamp);
      CREATE UNIQUE INDEX channel_stats_sync_states_chat_id_key ON channel_stats_sync_states(chat_id);
      CREATE TABLE channel_posts(id text,chat_id text,published_at timestamp,latest_snapshot_at timestamp,private_body text);
      CREATE INDEX channel_posts_chat_id_published_at_idx ON channel_posts(chat_id,published_at DESC);
      CREATE TABLE channel_post_view_snapshots(channel_post_id text,captured_at timestamp);
      CREATE INDEX channel_post_view_snapshots_channel_post_id_captured_at_idx ON channel_post_view_snapshots(channel_post_id,captured_at DESC);
      CREATE TABLE managed_entity_audience_observations(chat_id text,entity_type text,participants_count integer,observed_at timestamptz,source text,PRIMARY KEY(chat_id,entity_type));
      CREATE TABLE channel_view_observation_states(channel_post_id text PRIMARY KEY,baseline_at timestamptz,observed_at timestamptz,
        observed_views integer,high_water_views integer,anomaly_at timestamptz,source text);
      CREATE TABLE channel_view_observed_intervals(channel_post_id text,chat_id text,from_at timestamptz,to_at timestamptz,delta bigint,quality text,source text,
        PRIMARY KEY(channel_post_id,to_at));
      CREATE TABLE channel_view_archive_states(chat_id text PRIMARY KEY,cursor_at timestamptz,discovered_from timestamptz,discovery_complete_at timestamptz,
        last_attempt_at timestamptz,last_success_at timestamptz,full_refresh_at timestamptz,stalled_at timestamptz,observed_post_count integer,
        first_observed_at timestamptz,last_observed_at timestamptz,cursor_signature text);
      CREATE TABLE marketplace_bindings(entity_id text,kind text,profile text,state text,statistics_consent boolean,collection_owner text,
        collection_metrics jsonb,checked_at timestamptz,valid_until timestamptz,lease_until timestamptz,history_complete boolean,history_anomaly boolean,
        native_history_checked_at timestamptz,native_full_checked_at timestamptz,native_audience_checked_at timestamptz,lease_id uuid,actor_user_id text);
      CREATE INDEX marketplace_bindings_entity_idx ON marketplace_bindings(entity_id,state);
      INSERT INTO chats VALUES('-1','CHANNEL'),('-2','CHAT');
      INSERT INTO channel_posts(id,chat_id,published_at,latest_snapshot_at)
        SELECT 'post-'||n,'-1',now()-n*interval '1 minute',now() FROM generate_series(1,29) n;
      INSERT INTO managed_entity_audience_observations VALUES('-1','CHANNEL',110,now(),'major'),('-2','CHAT',20,now(),'marketplace');
      INSERT INTO channel_view_observation_states SELECT 'post-'||n,now()-interval '1 day',now(),110,120,now(),'private-source' FROM generate_series(1,29) n;
      INSERT INTO channel_view_observed_intervals SELECT 'post-'||n,'-1',now()-(s+1)*interval '1 hour',now()-s*interval '1 hour',10,'ready','major'
        FROM generate_series(1,29) n CROSS JOIN generate_series(1,3) s;
      INSERT INTO channel_view_archive_states(chat_id,cursor_at,observed_post_count,stalled_at) VALUES('-1',now()-interval '1 year',29,now());
      INSERT INTO marketplace_bindings(entity_id,kind,profile,state,statistics_consent,collection_owner,collection_metrics,lease_until)
        SELECT '-1','CHANNEL','moderation','ACTIVE',true,'MAXIM','["AUDIENCE","REACH"]',now()+interval '1 minute' FROM generate_series(1,10);
      GRANT SELECT(id,entity_type) ON chats TO maxim_audit;
    `);
    const provision = readFileSync(
      new URL('./vps-provision-postgres-audit-role.sh', import.meta.url),
      'utf8',
    );
    for (const tag of ['network_statistics_grants', 'network_statistics_observation_grants']) {
      const block = new RegExp(`DO \\$${tag}\\$[\\s\\S]*?\\$${tag}\\$;`, 'u').exec(provision)?.[0];
      assert.ok(block);
      await db.exec(block);
    }
    await db.exec('SET ROLE maxim_audit');
    const readiness = buildNetworkStatisticsIndexReadinessSql(true).split(
      ' AS network_statistics_indexes_ready',
    )[0];
    assert.equal((await db.query(`${readiness} AS ready`)).rows[0].ready, true);
    const sql = buildNetworkStatisticsAuditSql(['-1,-2', '--observations']);
    assert.doesNotMatch(
      sql,
      /SELECT \*|actor_user_id|lease_id|cursor_signature|private_body|private-source/u,
    );
    const report = Object.values((await db.query(sql)).rows[0])[0];
    assert.equal(report.schema_version, 2);
    assert.equal(report.v2_schema_present, true);
    const channel = report.entities.find((entry) => entry.id === '-1');
    assert.equal(channel.capped, true);
    assert.equal(channel.observations.audience.participants_count, 110);
    assert.equal(channel.observations.audience.writer_source, 'major');
    assert.equal(channel.observations.archive.observed_post_count, 29);
    assert.ok(channel.observations.archive.stalled_at);
    assert.equal(channel.observations.posts.length, 24);
    assert.ok(
      channel.observations.posts.every(
        (post) =>
          post.intervals.length === 2 &&
          post.writer_source === 'other' &&
          post.high_water_views === 120,
      ),
    );
    assert.equal(channel.observations.collector_metadata.sample_count, 8);
    assert.equal(channel.observations.collector_metadata.capped, true);
    assert.equal(channel.observations.collector_metadata.authority_verified, false);
    assert.ok(
      channel.observations.collector_metadata.bindings.every(
        (binding) => binding.collection_owner === 'MAXIM' && binding.reach_metric,
      ),
    );
    const chat = report.entities.find((entry) => entry.id === '-2');
    assert.equal(chat.observations.audience.entity_type, 'CHAT');
    assert.equal(chat.observations.archive, null);
    assert.deepEqual(chat.observations.posts, []);
    assert.deepEqual(chat.observations.collector_metadata.bindings, []);
    assert.equal(
      (await db.query(buildNetworkStatisticsAuditSql(['-1', '--observations', '--explain']))).rows
        .length,
      1,
    );
    await db.exec(
      'RESET ROLE; ALTER TABLE channel_view_observed_intervals DROP CONSTRAINT channel_view_observed_intervals_pkey',
    );
    assert.equal((await db.query(`${readiness} AS ready`)).rows[0].ready, false);
  } finally {
    await db.close();
  }
});

test('observation grants are all-or-zero and reject private columns, table grants and mutation access', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec('CREATE ROLE maxim_audit');
    assert.equal(Object.values(NETWORK_STATISTICS_OBSERVATION_AUDIT_COLUMNS).flat().length, 45);
    const ready = async (requireAll = false) => {
      const sql = buildNetworkStatisticsObservationPrivilegesSql(requireAll).split(
        ' AS network_statistics_observations_privileges_ready',
      )[0];
      return (await db.query(`${sql} AS ready`)).rows[0].ready;
    };
    assert.equal(await ready(), true);
    assert.equal(await ready(true), false);
    const provision = readFileSync(
      new URL('./vps-provision-postgres-audit-role.sh', import.meta.url),
      'utf8',
    );
    const grants =
      /DO \$network_statistics_observation_grants\$[\s\S]*?\$network_statistics_observation_grants\$;/u.exec(
        provision,
      )?.[0];
    assert.ok(grants);
    for (const [table, columns] of Object.entries(NETWORK_STATISTICS_OBSERVATION_AUDIT_COLUMNS)) {
      await db.exec(
        `CREATE TABLE ${table}(${columns.map((column) => `${column} text`).join(',')},private_data text)`,
      );
      assert.ok(provision.includes(`ON TABLE public.${table} TO maxim_audit`));
    }
    await db.exec('ALTER TABLE channel_view_observation_states DROP COLUMN source');
    await db.exec(grants);
    assert.equal(await ready(), true);
    assert.equal(await ready(true), false);
    await db.exec('ALTER TABLE channel_view_observation_states ADD COLUMN source text');
    await db.exec(grants);
    assert.equal(await ready(true), true);
    await db.exec('REVOKE SELECT(source) ON channel_view_observation_states FROM maxim_audit');
    assert.equal(await ready(), false);
    await db.exec(grants);
    await db.exec('GRANT SELECT(private_data) ON marketplace_bindings TO PUBLIC');
    assert.equal(await ready(), false);
    await assert.rejects(db.exec(grants), /privileges are not exact/u);
    await db.exec(
      'REVOKE SELECT(private_data) ON marketplace_bindings FROM PUBLIC; GRANT SELECT ON channel_view_archive_states TO maxim_audit',
    );
    assert.equal(await ready(), false);
    await db.exec(
      'REVOKE SELECT ON channel_view_archive_states FROM maxim_audit; GRANT UPDATE(source) ON channel_view_observation_states TO maxim_audit',
    );
    assert.equal(await ready(), false);
  } finally {
    await db.close();
  }
});

test('network statistics grants reject partial, content, full-table and mutation access', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec('CREATE ROLE maxim_audit;');
    const ready = async (requireAll = false) => {
      const sql = buildNetworkStatisticsPrivilegesSql(requireAll).split(
        ' AS network_statistics_privileges_ready',
      )[0];
      return (await db.query(`${sql} AS ready`)).rows[0].ready;
    };
    assert.equal(await ready(), true);
    assert.equal(await ready(true), false);
    for (const [table, columns] of Object.entries(NETWORK_STATISTICS_AUDIT_COLUMNS)) {
      await db.exec(
        `CREATE TABLE ${table}(${columns.map((column) => `${column} text`).join(',')},private_body text)`,
      );
    }
    const provision = readFileSync(
      new URL('./vps-provision-postgres-audit-role.sh', import.meta.url),
      'utf8',
    );
    const grants = /DO \$network_statistics_grants\$[\s\S]*?\$network_statistics_grants\$;/u.exec(
      provision,
    )?.[0];
    assert.ok(grants);
    await db.exec(grants);
    assert.equal(await ready(true), true);
    await db.exec('REVOKE SELECT(captured_at) ON channel_audience_snapshots FROM maxim_audit');
    assert.equal(await ready(), false);
    await db.exec(grants);
    await db.exec('GRANT SELECT(private_body) ON channel_posts TO maxim_audit');
    assert.equal(await ready(), false);
    await db.exec(
      'REVOKE SELECT(private_body) ON channel_posts FROM maxim_audit; GRANT SELECT ON channel_posts TO maxim_audit',
    );
    assert.equal(await ready(), false);
    await db.exec('REVOKE SELECT ON channel_posts FROM maxim_audit');
    await db.exec(grants);
    await db.exec('GRANT UPDATE(id) ON channel_posts TO maxim_audit');
    assert.equal(await ready(), false);
  } finally {
    await db.close();
  }
});
