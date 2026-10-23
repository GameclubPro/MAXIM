import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  STATISTICS_EXCHANGE_AUDIT_COLUMNS,
  buildStatisticsExchangeAuditSql,
  buildStatisticsExchangeIndexReadinessSql,
  buildStatisticsExchangePrivilegesSql,
  buildStatisticsExchangeProvisionSql,
  parseStatisticsExchangeAuditArgs,
} from './statistics-exchange-audit.mjs';

const actor = '111222333';
const grant = '00000000-0000-4000-8000-000000000001';
const peerGrant = '00000000-0000-4000-8000-000000000002';
const fixture = `
CREATE TABLE statistics_exchange_grants (
  id UUID PRIMARY KEY,actor_user_id TEXT NOT NULL UNIQUE,revision BIGINT NOT NULL,
  state TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_pull_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_pull_at TIMESTAMPTZ,
  last_error TEXT,producer_revision BIGINT NOT NULL DEFAULT 0,
  last_remote_access_at TIMESTAMPTZ,remote_access_error TEXT,input_hash TEXT,
  lease_id UUID
);
CREATE TABLE statistics_exchange_entities (
  grant_id UUID NOT NULL,entity_id TEXT NOT NULL,kind TEXT NOT NULL,
  binding_id UUID,error TEXT,profile TEXT,remote_valid_until TIMESTAMPTZ,remote_binding_id UUID,
  PRIMARY KEY(grant_id,entity_id,kind)
);
CREATE TABLE statistics_exchange_imports (
  grant_id UUID NOT NULL,grant_revision BIGINT NOT NULL,entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,producer_revision BIGINT NOT NULL,manifest JSONB NOT NULL,
  rows JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  remote_valid_until TIMESTAMPTZ,
  PRIMARY KEY(grant_id,grant_revision,entity_id,kind)
);
CREATE TABLE statistics_exchange_generations (
  id UUID PRIMARY KEY,grant_id UUID NOT NULL,grant_revision BIGINT NOT NULL,
  entity_id TEXT NOT NULL,kind TEXT NOT NULL,origin TEXT NOT NULL,
  producer_revision BIGINT NOT NULL,manifest JSONB NOT NULL,rows JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX statistics_exchange_generations_latest_idx ON statistics_exchange_generations
  (grant_id,grant_revision,entity_id,kind,origin,producer_revision DESC,created_at DESC,id DESC);
`;
const readiness = (sql) => sql.split('\\gset')[0];
const row = (origin, value = 37, observedAt = '2026-10-22T12:00:00.000Z') => ({
  origin,
  method: 'utc-buckets-v1',
  revision: 2,
  data: { metric: 'AUDIENCE', bucket: '2026-10-22T00:00:00.000Z', observedAt, value },
});

test('exact scope accepts only one positive bounded actor and plain EXPLAIN', () => {
  assert.deepEqual(parseStatisticsExchangeAuditArgs([actor]), { actor, explain: false });
  assert.deepEqual(parseStatisticsExchangeAuditArgs(['9'.repeat(20), '--explain']), {
    actor: '9'.repeat(20),
    explain: true,
  });
  for (const args of [
    [],
    ['0'],
    ['01'],
    ['-1'],
    ['1,2'],
    ['9'.repeat(21)],
    ['1\n'],
    ['1;SELECT 1'],
    ['/tmp/query.sql'],
    ['-'],
    ['1', '--file'],
    ['1', 'SELECT 1'],
    ['1', '--explain', 'extra'],
    ['--privileges', '--require-all', '--explain'],
  ]) {
    assert.throws(() => buildStatisticsExchangeAuditSql(args));
    const command = spawnSync(
      process.execPath,
      [new URL('./statistics-exchange-audit.mjs', import.meta.url).pathname, ...args],
      {
        encoding: 'utf8',
        input: 'SELECT private_data FROM private_table;',
      },
    );
    assert.equal(command.status, 2);
    assert.equal(command.stdout, '');
    assert.doesNotMatch(command.stderr, /private_data|private_table/u);
  }
  const sql = buildStatisticsExchangeAuditSql([actor]);
  assert.match(sql, /actor_user_id='111222333' LIMIT 1/u);
  assert.match(sql, /LIMIT 7/u);
  assert.match(sql, /LIMIT 6/u);
  assert.match(sql, /jsonb_array_length\(rows\)<=3000/u);
  assert.match(sql, /row.n<=3000/u);
  assert.match(sql, /origin='MAXIM'/u);
  assert.doesNotMatch(sql, /SELECT \* FROM public\.|EXPLAIN ANALYZE|token|message|content/u);
  const plan = buildStatisticsExchangeAuditSql([actor, '--explain']);
  assert.match(plan, /force_generic_plan/u);
  assert.match(plan, /actor_user_id=\$1 LIMIT 1/u);
  assert.match(plan, /EXPLAIN \(FORMAT JSON\) EXECUTE/u);
});

test('routing retains fixed budgets and provisioned exact optional metadata group', () => {
  const audit = readFileSync(new URL('./vps-postgres-audit.sh', import.meta.url), 'utf8');
  const connector = readFileSync(new URL('./vps-connect.sh', import.meta.url), 'utf8');
  const provision = readFileSync(
    new URL('./vps-provision-postgres-audit-role.sh', import.meta.url),
    'utf8',
  );
  assert.match(audit, /STATISTICS_EXCHANGE_ARGS=\("\$\{@:2\}"\)/u);
  assert.match(audit, /exchange_privilege_args\+=\(--require-all\)/u);
  assert.match(connector, /"\$mode" == 'statistics-exchange'/u);
  assert.match(audit, /statement_timeout=2500ms/u);
  assert.match(audit, /AUDIT_WALL_TIMEOUT_SEC:-8/u);
  assert.equal(Object.values(STATISTICS_EXCHANGE_AUDIT_COLUMNS).flat().length, 37);
  assert.ok(provision.includes(buildStatisticsExchangeProvisionSql()));
  assert.match(buildStatisticsExchangePrivilegesSql(), /IN \(0,37\)/u);
  assert.match(buildStatisticsExchangePrivilegesSql(true), /IN \(37\)/u);
  for (const table of Object.keys(STATISTICS_EXCHANGE_AUDIT_COLUMNS)) {
    assert.ok(audit.includes(`'${table}'`));
    assert.ok(provision.includes(`'${table}'`));
  }
});

test(
  'native PG16 exact role, bounded rows, actual clocks, provenance and private generic plan',
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
    const database = `exchange_audit_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${database}`);
    url.pathname = `/${database}`;
    const db = new pg.Client({ connectionString: url.href });
    await db.connect();
    t.after(async () => {
      await db.end();
      await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    });
    await db.query(
      'CREATE ROLE maxim_audit; CREATE ROLE exchange_reader; GRANT exchange_reader TO maxim_audit;',
    );
    assert.equal(
      (await db.query(readiness(buildStatisticsExchangePrivilegesSql()))).rows[0]
        .statistics_exchange_privileges_ready,
      true,
    );
    assert.equal(
      (await db.query(readiness(buildStatisticsExchangePrivilegesSql(true)))).rows[0]
        .statistics_exchange_privileges_ready,
      false,
    );
    await db.query(buildStatisticsExchangeProvisionSql());
    await db.query(fixture);
    await db.query(buildStatisticsExchangeProvisionSql());
    const privileges = async (required = false) =>
      (await db.query(readiness(buildStatisticsExchangePrivilegesSql(required)))).rows[0]
        .statistics_exchange_privileges_ready;
    assert.equal(await privileges(true), true);
    for (const [grantSql, revoke] of [
      [
        'GRANT SELECT (input_hash) ON statistics_exchange_grants TO PUBLIC',
        'REVOKE SELECT (input_hash) ON statistics_exchange_grants FROM PUBLIC',
      ],
      [
        'GRANT SELECT (lease_id) ON statistics_exchange_grants TO exchange_reader',
        'REVOKE SELECT (lease_id) ON statistics_exchange_grants FROM exchange_reader',
      ],
      [
        'GRANT UPDATE (last_pull_at) ON statistics_exchange_grants TO maxim_audit',
        'REVOKE UPDATE (last_pull_at) ON statistics_exchange_grants FROM maxim_audit',
      ],
      [
        'GRANT SELECT ON statistics_exchange_imports TO maxim_audit',
        'REVOKE SELECT ON statistics_exchange_imports FROM maxim_audit',
      ],
    ]) {
      await db.query(grantSql);
      assert.equal(await privileges(), false);
      await db.query(revoke);
      // PostgreSQL table-level REVOKE also removes that table's column grants.
      await db.query(buildStatisticsExchangeProvisionSql());
      assert.equal(await privileges(true), true, revoke);
    }
    await db.query('REVOKE SELECT (last_pull_at) ON statistics_exchange_grants FROM maxim_audit');
    assert.equal(await privileges(), false);
    await db.query(buildStatisticsExchangeProvisionSql());
    assert.equal(await privileges(true), true);
    const ready = async () =>
      (await db.query(readiness(buildStatisticsExchangeIndexReadinessSql()))).rows[0]
        .statistics_exchange_indexes_ready;
    assert.equal(await ready(), true);
    await db.query(
      `INSERT INTO statistics_exchange_grants(id,actor_user_id,revision,state,last_pull_at,last_error,producer_revision,last_remote_access_at,remote_access_error,input_hash)
    VALUES($1,$2,3,'ACTIVE','2026-10-23T12:00Z','private-error',4,'2026-10-23T11:59Z','private-remote-error','private-secret'),
    ($3,'999888777',9,'ACTIVE',now(),NULL,99,now(),NULL,'other-secret')`,
      [grant, actor, peerGrant],
    );
    await db.query(
      `INSERT INTO statistics_exchange_entities(grant_id,entity_id,kind,binding_id,error)
    SELECT $1,'-'||n,'CHANNEL',$1,CASE WHEN n=2 THEN 'private-error' END FROM generate_series(1,8) n`,
      [grant],
    );
    await db.query(
      `INSERT INTO statistics_exchange_entities(grant_id,entity_id,kind,binding_id) VALUES($1,'-900','CHAT',$1)`,
      [peerGrant],
    );
    await db.query(
      `UPDATE statistics_exchange_entities SET remote_valid_until=now()+CASE WHEN entity_id='-1' THEN interval '1 minute' ELSE interval '-1 minute' END,
      remote_binding_id=$1 WHERE grant_id=$1 AND entity_id IN ('-1','-2')`,
      [grant],
    );
    const manifest = (origin) => ({
      origin,
      method: 'utc-buckets-v1',
      producerRevision: 2,
      asOf: '2026-10-23T12:00:00.000Z',
      private: 'private-manifest',
    });
    const insertImport = async (rows, entity = '-1', revision = 3) =>
      db.query(
        `INSERT INTO statistics_exchange_imports
    VALUES($1,$2,$3,'CHANNEL',2,$4::jsonb,$5::jsonb,now(),now()-interval '1 minute')
    ON CONFLICT(grant_id,grant_revision,entity_id,kind) DO UPDATE SET rows=excluded.rows`,
        [grant, revision, entity, JSON.stringify(manifest('EXCHANGE')), JSON.stringify(rows)],
      );
    await insertImport([
      { ...row('EXCHANGE'), revision: 1 },
      row('EXCHANGE', 0, '2026-10-22T13:00:00.000Z'),
      row('EXCHANGE', null, null),
    ]);
    await insertImport([row('EXCHANGE', 999, '2026-10-23T23:00:00.000Z')], '-1', 2);
    await db.query(
      `INSERT INTO statistics_exchange_generations VALUES($1,$2,3,'-1','CHANNEL','MAXIM',2,$3::jsonb,$4::jsonb,now())`,
      [randomUUID(), grant, JSON.stringify(manifest('MAXIM')), JSON.stringify([row('MAXIM')])],
    );
    const report = async () => {
      await db.query('SET ROLE maxim_audit');
      try {
        return (await db.query(buildStatisticsExchangeAuditSql([actor]))).rows[0].json_build_object;
      } finally {
        await db.query('RESET ROLE');
      }
    };
    let result = await report();
    assert.equal(result.sampled_entities, 6);
    assert.equal(result.entities_capped, true);
    assert.equal(result.import_snapshots, 1);
    assert.equal(result.native_export_snapshots, 1);
    assert.equal(result.expired_import_authorities, 1);
    assert.equal(result.unproven_import_authorities, 0);
    assert.equal(result.remote_bound_entities, 2);
    assert.equal(result.valid_entity_authorities, 1);
    assert.equal(result.expired_entity_authorities, 1);
    assert.equal(result.unproven_entity_authorities, 4);
    assert.ok(result.oldest_entity_authority_until);
    assert.ok(result.newest_entity_authority_until);
    assert.equal(result.last_error, true);
    assert.equal(result.remote_access_error, true);
    assert.equal(result.native_only, true);
    assert.equal(
      result.provenance_mismatch_rows,
      0,
      'partial correction keeps older imported row revisions',
    );
    assert.equal(result.grant_revision, 3);
    assert.equal(result.latest_actual_observation_at, '2026-10-22T13:00:00+00:00');
    assert.equal(result.metrics.find((m) => m.origin === 'EXCHANGE').rows, 3);
    assert.equal(result.metrics.find((m) => m.origin === 'EXCHANGE').complete_rows, 2);
    assert.doesNotMatch(JSON.stringify(result), /111222333|999888777|private|secret|00000000-/u);
    await db.query(
      `UPDATE statistics_exchange_imports SET remote_valid_until=NULL WHERE grant_id=$1`,
      [grant],
    );
    assert.equal((await report()).unproven_import_authorities, 1);
    await db.query(
      `UPDATE statistics_exchange_imports SET remote_valid_until=now()-interval '1 minute' WHERE grant_id=$1`,
      [grant],
    );
    for (const revision of [-1, 3, 9007199254740992, '1', null]) {
      await insertImport([{ ...row('EXCHANGE'), revision }]);
      assert.equal(
        (await report()).provenance_mismatch_rows,
        1,
        `invalid imported row revision ${revision}`,
      );
    }
    await insertImport([row('EXCHANGE')]);
    await db.query(`UPDATE statistics_exchange_generations SET rows=$1::jsonb`, [
      JSON.stringify([{ ...row('MAXIM'), revision: 1 }]),
    ]);
    assert.equal(
      (await report()).native_only,
      false,
      'immutable native export requires one exact revision',
    );
    await db.query(`UPDATE statistics_exchange_generations SET rows=$1::jsonb`, [
      JSON.stringify([row('MAXIM')]),
    ]);
    await insertImport([row('MAXIM')]);
    result = await report();
    assert.equal(result.native_only, false);
    assert.equal(result.provenance_mismatch_rows, 1);
    await insertImport(Array.from({ length: 3001 }, () => row('EXCHANGE')));
    result = await report();
    assert.equal(result.rejected_json_snapshots, 1);
    assert.equal(result.native_only, false);
    assert.equal(result.metrics.filter((m) => m.origin === 'EXCHANGE').length, 0);
    await insertImport([
      { ...row('EXCHANGE'), data: { ...row('EXCHANGE').data, observedAt: '9999-invalid' } },
    ]);
    result = await report();
    assert.equal(result.metrics.find((m) => m.origin === 'EXCHANGE').last_observed_at, null);
    await insertImport([row('EXCHANGE')]);
    await db.query(
      `UPDATE statistics_exchange_imports SET rows=jsonb_build_array(jsonb_build_object('data',repeat('x',5000000))) WHERE grant_id=$1`,
      [grant],
    );
    result = await report();
    assert.equal(
      result.rejected_json_snapshots,
      1,
      'compressed oversized JSON is rejected before parsing rows',
    );
    await insertImport([row('EXCHANGE')]);
    await db.query(
      'ANALYZE; SET enable_seqscan=off; SET enable_bitmapscan=off; BEGIN READ ONLY; SET LOCAL search_path=pg_catalog,public,pg_temp; SET LOCAL ROLE maxim_audit;',
    );
    const planned = await db.query(buildStatisticsExchangeAuditSql([actor, '--explain']));
    const plan = planned.find((part) => part.rows?.[0]?.['QUERY PLAN'])?.rows[0]['QUERY PLAN'];
    assert.ok(plan);
    const printed = JSON.stringify(plan);
    assert.doesNotMatch(printed, /111222333|999888777|Seq Scan|Bitmap Heap Scan/u);
    for (const name of [
      'statistics_exchange_grants_actor_user_id_key',
      'statistics_exchange_entities_pkey',
      'statistics_exchange_imports_pkey',
      'statistics_exchange_generations_latest_idx',
    ])
      assert.ok(printed.includes(name), name);
    writeFileSync('/tmp/maxim-statistics-exchange-audit-plan.json', JSON.stringify(plan, null, 2), {
      mode: 0o600,
    });
    await db.query('ROLLBACK; RESET ROLE;');
    await db.query(
      'ALTER INDEX statistics_exchange_generations_latest_idx RENAME TO audit_missing_idx',
    );
    assert.equal(await ready(), false);
  },
);
