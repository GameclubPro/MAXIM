import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  CENTRAL_STATISTICS_AUDIT_COLUMNS,
  buildCentralStatisticsAuditSql,
  buildCentralStatisticsIndexReadinessSql,
  buildCentralStatisticsPrivilegesSql,
  buildCentralStatisticsProvisionSql,
  parseCentralStatisticsAuditArgs,
} from './central-statistics-audit.mjs';
import {
  NETWORK_STATISTICS_AUDIT_COLUMNS,
  NETWORK_STATISTICS_OBSERVATION_AUDIT_COLUMNS,
} from './network-statistics-audit.mjs';

const ids = '-123456789,-987654321';
const readiness = (sql) => sql.split('\\gset')[0];

test('central audit accepts exact bounded IDs only and hides them from generic plans', () => {
  assert.deepEqual(parseCentralStatisticsAuditArgs([ids]), {
    ids: ids.split(','),
    explain: false,
  });
  assert.equal(parseCentralStatisticsAuditArgs(['-9', '--explain']).explain, true);
  for (const args of [
    [],
    ['0'],
    ['-01'],
    ['1'],
    ['-1,-1'],
    ['-1,'],
    ['-1\n'],
    ['-1;SELECT 1'],
    ['-' + '9'.repeat(21)],
    [Array.from({ length: 13 }, (_, n) => `-${n + 1}`).join(',')],
    ['/tmp/private'],
    ['--privileges'],
    ['--provision'],
    ['-1', '--file'],
    ['-1', '--explain', 'extra'],
  ]) {
    assert.throws(() => buildCentralStatisticsAuditSql(args));
    const result = spawnSync(
      process.execPath,
      [
        new URL('./central-statistics-audit.mjs', import.meta.url).pathname,
        '--validate-scope',
        ...args,
      ],
      { encoding: 'utf8', input: 'SELECT private_data FROM private_table;' },
    );
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /private_data|private_table/u);
  }
  const sql = buildCentralStatisticsAuditSql([ids]);
  assert.match(sql, /LIMIT 65/u);
  assert.match(sql, /LIMIT 1441/u);
  assert.match(sql, /LIMIT 257/u);
  assert.doesNotMatch(
    sql,
    /SELECT \*|EXPLAIN ANALYZE|body_hash|value_hash|\bscopes\b|coverage FROM/u,
  );
  assert.match(buildCentralStatisticsAuditSql([ids, '--explain']), /unnest\(\$1\)/u);
});

test('central audit has exact metadata grants, bounded routing and no default report', () => {
  const audit = readFileSync(new URL('./vps-postgres-audit.sh', import.meta.url), 'utf8');
  const connect = readFileSync(new URL('./vps-connect.sh', import.meta.url), 'utf8');
  const provision = readFileSync(
    new URL('./vps-provision-postgres-audit-role.sh', import.meta.url),
    'utf8',
  );
  assert.equal(Object.values(CENTRAL_STATISTICS_AUDIT_COLUMNS).flat().length, 35);
  assert.ok(provision.includes(buildCentralStatisticsProvisionSql()));
  assert.match(buildCentralStatisticsPrivilegesSql(), /IN \(0,35\)/u);
  assert.match(buildCentralStatisticsPrivilegesSql(true), /IN \(35\)/u);
  assert.match(audit, /CENTRAL_STATISTICS_ARGS=\("\$\{@:2\}"\)/u);
  assert.match(audit, /central_privilege_args\+=\(--require-all\)/u);
  assert.match(audit, /statement_timeout=2500ms/u);
  assert.match(audit, /AUDIT_WALL_TIMEOUT_SEC:-8/u);
  assert.match(connect, /"\$mode" == 'central-statistics'/u);
  for (const table of Object.keys(CENTRAL_STATISTICS_AUDIT_COLUMNS)) {
    assert.ok(audit.includes(`'${table}'`));
    assert.ok(provision.includes(`'${table}'`));
  }
});

test(
  'actual PG16 central audit uses exact indexes and independent observation clocks',
  {
    skip: !process.env.MAXIM_TEST_POSTGRES_URL,
    timeout: 60_000,
  },
  async (t) => {
    const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL;
    const url = new URL(nativeUrl);
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        url.pathname.includes('race_test'),
    );
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: nativeUrl });
    await admin.connect();
    const database = `central_audit_${randomUUID().replaceAll('-', '')}`;
    const role = `central_reader_${randomUUID().replaceAll('-', '')}`;
    const replaceRole = (sql) => sql.replaceAll('maxim_audit', role);
    await admin.query(`CREATE DATABASE ${database}`);
    url.pathname = `/${database}`;
    const db = new pg.Client({ connectionString: url.href });
    await db.connect();
    let roleCreated = false;
    t.after(async () => {
      try {
        await db.end();
        await admin.query(`DROP DATABASE ${database}`);
        if (roleCreated) await admin.query(`DROP ROLE ${role}`);
      } finally {
        await admin.end();
      }
    });
    await db.query(`CREATE ROLE ${role}`);
    roleCreated = true;
    const privileges = async (required = false) =>
      (await db.query(replaceRole(readiness(buildCentralStatisticsPrivilegesSql(required)))))
        .rows[0].central_statistics_privileges_ready;
    assert.equal(await privileges(), true);
    assert.equal(await privileges(true), false);
    await db.query(replaceRole(buildCentralStatisticsProvisionSql()));
    await db.query(
      readFileSync(
        new URL(
          '../../apps/api/prisma/migrations/20261024010000_add_central_statistics_store/migration.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await db.query(
      readFileSync(new URL('./test-fixtures/network-statistics.sql', import.meta.url), 'utf8'),
    );
    // FLAG: The production indexed discriminator is an enum, not the text fixture.
    await db.query(`CREATE TYPE "ChatEntityType" AS ENUM ('CHAT','CHANNEL');
      ALTER TABLE managed_entity_audience_observations
        ALTER COLUMN entity_type TYPE "ChatEntityType" USING entity_type::"ChatEntityType";`);
    await db.query(
      'CREATE INDEX channel_posts_chat_id_latest_snapshot_at_idx ON channel_posts(chat_id,latest_snapshot_at DESC)',
    );
    await db.query(replaceRole(buildCentralStatisticsProvisionSql()));
    assert.equal(await privileges(true), true);
    await db.query(`GRANT SELECT(value) ON stats_measurements TO ${role}`);
    assert.equal(await privileges(), false);
    await db.query(`REVOKE SELECT(value) ON stats_measurements FROM ${role}`);
    assert.equal(await privileges(true), true);
    for (const [grant, revoke] of [
      [`GRANT SELECT ON stats_changes TO ${role}`, `REVOKE SELECT ON stats_changes FROM ${role}`],
      [
        `GRANT UPDATE(checked_at) ON stats_authorities TO ${role}`,
        `REVOKE UPDATE(checked_at) ON stats_authorities FROM ${role}`,
      ],
      [`REVOKE SELECT(observed_to) ON stats_measurements FROM ${role}`, null],
    ]) {
      await db.query(grant);
      assert.equal(await privileges(), false);
      if (revoke) await db.query(revoke);
      await db.query(replaceRole(buildCentralStatisticsProvisionSql()));
      assert.equal(await privileges(true), true);
    }
    for (const [table, columns] of Object.entries({
      ...NETWORK_STATISTICS_AUDIT_COLUMNS,
      ...NETWORK_STATISTICS_OBSERVATION_AUDIT_COLUMNS,
    }))
      await db.query(`GRANT SELECT(${columns.join(',')}) ON ${table} TO ${role}`);
    const ready = async () =>
      (await db.query(readiness(buildCentralStatisticsIndexReadinessSql()))).rows[0]
        .central_statistics_indexes_ready;
    assert.equal(await ready(), true);
    const channel = randomUUID();
    const chat = randomUUID();
    const epoch = randomUUID();
    await db.query(
      `INSERT INTO stats_entities(id,kind,max_id,data_revision) VALUES ($1,'CHANNEL','-123456789',4),($2,'CHAT','-987654321',2)`,
      [channel, chat],
    );
    await db.query(
      `INSERT INTO stats_entities(kind,max_id) SELECT 'CHANNEL',(-1000000000-n)::text FROM generate_series(1,5000) n`,
    );
    await db.query(
      `INSERT INTO stats_authorities(id,entity_id,issuer,role,producer,consumer,actor_max_id,bot_ref,purpose,scopes,revision,epoch,producer_epoch,local_access_fence,state,peer_valid_until,checked_at)
    SELECT gen_random_uuid(),$1,'EXCHANGE',r,'EXCHANGE','EXCHANGE','private-actor','private-bot','OWNER_ANALYTICS','[{}]',1,1,$2,'private-fence','ACTIVE',now()+interval '5 minutes',now()
    FROM (VALUES ('SOURCE'),('CONSUMER')) x(r)`,
      [channel, epoch],
    );
    await db.query(
      `INSERT INTO stats_authorities(id,entity_id,issuer,role,producer,consumer,actor_max_id,bot_ref,purpose,scopes,revision,epoch,producer_epoch,local_access_fence,state,peer_valid_until,checked_at)
    SELECT gen_random_uuid(),$1,'MAXIM','SOURCE','MAXIM','MAXIM','private-actor',n::text,'OWNER_ANALYTICS','[{}]',1,1,$2,'private-fence','ACTIVE',now()-interval '1 second',now() FROM generate_series(1,70) n`,
      [chat, epoch],
    );
    await db.query(
      `INSERT INTO stats_measurements(entity_id,producer,metric,horizon,method_id,method_version,day,producer_epoch,seen_revision,seen_hash,value_revision,value_hash,value,coverage,observed_from,observed_to)
    SELECT $1,p,'AUDIENCE',0,'AUDIENCE_SNAPSHOT',1,current_date,$2,1,'private-hash',1,'private-hash','0','{}',now()-interval '2 hours',now()-interval '2 hours' FROM (VALUES ('MAXIM'),('EXCHANGE')) x(p)`,
      [channel, epoch],
    );
    await db.query(`INSERT INTO managed_entity_audience_observations VALUES ('-123456789','CHANNEL',0,now()-interval '1 hour','private-source');
    INSERT INTO channel_audience_snapshots VALUES ('-123456789',0,now()-interval '3 hours');
    INSERT INTO channel_posts VALUES ('private-post','-123456789',now()-interval '5 hours',now()-interval '30 minutes','private-body');
    INSERT INTO stats_ingest_requests(producer,producer_epoch,record_kind,operation_key,body_hash,result)
      SELECT 'EXCHANGE','${epoch}','EVENT',n::text,'private-hash','{"private":"payload"}' FROM generate_series(1,300) n;
    INSERT INTO stats_changes(entity_id,entity_revision,cause) SELECT '${channel}',n,'DATA' FROM generate_series(1,300) n;
    INSERT INTO stats_changes(entity_id,entity_revision,cause,published_seq,published_at)
      SELECT '${channel}',n,'DATA',n,now() FROM generate_series(1,5000) n;
    ANALYZE;`);
    await db.query(
      `BEGIN READ ONLY; SET LOCAL search_path=pg_catalog,public,pg_temp; SET LOCAL timezone=UTC; SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off; SET LOCAL jit=off; SET LOCAL statement_timeout='2500ms'; SET LOCAL work_mem='1MB'; SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL ROLE ${role};`,
    );
    const reportParts = await db.query(buildCentralStatisticsAuditSql([ids]));
    const report = reportParts.find((part) => part.rows?.[0]?.json_build_object)?.rows[0]
      .json_build_object;
    assert.equal(report.entity_count, 2);
    assert.equal(report.authority_groups_capped, 1);
    assert.equal(report.candidate_pairs[0].entities_with_candidate_pairs, 1);
    assert.equal(report.global_recent_receipts_capped, true);
    assert.equal(report.global_unpublished_sample_count, 256);
    assert.equal(report.global_unpublished_sample_capped, true);
    assert.equal(report.metrics.length, 2);
    assert.ok(
      report.metrics.every(
        (metric) =>
          Date.parse(metric.last_actual_observation_at) <
          Date.parse(metric.last_stored_at) - 3_000_000,
      ),
    );
    const native = report.native_observations.find((row) => row.kind === 'CHANNEL');
    assert.equal(native.entities_with_audience_observations, 1);
    assert.ok(
      Date.parse(native.last_raw_views_observation_at) >
        Date.parse(native.last_raw_audience_observation_at),
    );
    assert.doesNotMatch(JSON.stringify(report), /123456789|987654321|private|payload|00000000-/u);
    const planned = await db.query(buildCentralStatisticsAuditSql([ids, '--explain']));
    const plan = planned.find((part) => part.rows?.[0]?.['QUERY PLAN'])?.rows[0]['QUERY PLAN'];
    const printed = JSON.stringify(plan);
    writeFileSync('/tmp/maxim-central-statistics-audit-plan.json', JSON.stringify(plan, null, 2), {
      mode: 0o600,
    });
    assert.doesNotMatch(printed, /123456789|987654321|Seq Scan|Bitmap Heap Scan/u);
    for (const index of [
      'stats_entities_kind_max_id_key',
      'stats_authorities_scope_key',
      'stats_measurements_entity_day_idx',
      'stats_ingest_requests_retention_idx',
      'stats_changes_retention_idx',
      'stats_changes_unpublished_idx',
      'managed_entity_audience_observations_pkey',
      'channel_audience_snapshots_chat_id_captured_at_idx',
      'channel_posts_chat_id_latest_snapshot_at_idx',
    ])
      assert.ok(printed.includes(index), index);
    // FLAG: ANALYZE is confined to the disposable fixture, never production.
    const analyzed = await db.query(
      buildCentralStatisticsAuditSql([ids, '--explain']).replace(
        'EXPLAIN (FORMAT JSON)',
        'EXPLAIN (ANALYZE, FORMAT JSON)',
      ),
    );
    const actualPlan = analyzed.find((part) => part.rows?.[0]?.['QUERY PLAN'])?.rows[0][
      'QUERY PLAN'
    ];
    const sourceCaps = {
      stats_entities: 1,
      stats_authorities: 65,
      stats_measurements: 1441,
      stats_ingest_requests: 257,
      stats_changes: 257,
      managed_entity_audience_observations: 1,
      channel_audience_snapshots: 1,
      channel_posts: 1,
    };
    const inspect = (node) => {
      if (Array.isArray(node)) {
        for (const child of node) inspect(child);
      } else if (node && typeof node === 'object') {
        if (sourceCaps[node['Relation Name']] !== undefined)
          assert.ok(node['Actual Rows'] <= sourceCaps[node['Relation Name']], JSON.stringify(node));
        for (const child of Object.values(node)) inspect(child);
      }
    };
    inspect(actualPlan);
    await db.query('ROLLBACK; RESET ROLE;');
    await db.query('ALTER INDEX stats_changes_unpublished_idx RENAME TO audit_missing_index');
    assert.equal(await ready(), false);
  },
);
