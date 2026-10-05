import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  MULTIBOT_PREPARATION_MIGRATIONS,
  MULTIBOT_PREPARATION_RECEIPT_COLUMNS,
  multibotPreparationChecksums,
  multibotPreparationReceiptPrivilegesSql as privilegesSql,
  emitMultibotPreparationAuditSql,
  multibotPreparationDiagnosticsSql as sql,
} from './multibot-prepare-diagnostics.mjs';

const nativePostgresUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
const fixtureSql = `
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'QUEUED', 'FAILED', 'PROCESSED');
CREATE TABLE webhook_events (
  id text, semantic_key text, execution_deadline_at timestamp(3), created_at timestamp,
  status "WebhookStatus", next_enqueue_at timestamp, timeout_quarantine_expires_at timestamp,
  error_message text, private_content text
);
CREATE TABLE _prisma_migrations (
  id text PRIMARY KEY, migration_name text, checksum text, started_at timestamptz,
  finished_at timestamptz, rolled_back_at timestamptz, applied_steps_count integer,
  logs text, private_extra text
);
INSERT INTO webhook_events (id, private_content) VALUES ('not-visible', 'MESSAGE_CONTENT_NEVER_READ');
CREATE ROLE multibot_diagnostic_auditor;
GRANT USAGE ON SCHEMA public TO multibot_diagnostic_auditor;
GRANT SELECT (${MULTIBOT_PREPARATION_RECEIPT_COLUMNS.join(', ')})
  ON _prisma_migrations TO multibot_diagnostic_auditor;
GRANT pg_read_all_stats TO multibot_diagnostic_auditor;
`;
const createIndexesSql = `
CREATE INDEX webhook_events_semantic_order_idx ON webhook_events (semantic_key, created_at, id)
  WHERE semantic_key IS NOT NULL;
CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events (status, created_at, id);
CREATE INDEX webhook_events_semantic_replay_fence_idx ON webhook_events (semantic_key, id)
  WHERE semantic_key IS NOT NULL AND (
    status IN ('RECEIVED'::"WebhookStatus", 'QUEUED'::"WebhookStatus")
    OR (status = 'FAILED'::"WebhookStatus" AND next_enqueue_at IS NOT NULL)
    OR timeout_quarantine_expires_at IS NOT NULL
    OR COALESCE(error_message, '') ILIKE '%ambiguous%'
    OR COALESCE(error_message, '') LIKE 'WEBHOOK_HOT_PATH_TIMEOUT%QUARANTINED%'
  );
`;

async function audit(db) {
  await db.exec('BEGIN READ ONLY');
  try {
    return (await db.query(sql)).rows[0].json_build_object;
  } finally {
    await db.exec('ROLLBACK');
  }
}

test('fixed audit needs only receipt metadata grants and never reads application content', async () => {
  const db = new PGlite();
  try {
    await db.exec(fixtureSql);
    await db.exec('SET ROLE multibot_diagnostic_auditor');
    await assert.rejects(
      db.query('SELECT private_content FROM webhook_events'),
      /permission denied/u,
    );
    await assert.rejects(
      db.query('SELECT private_extra FROM _prisma_migrations'),
      /permission denied/u,
    );
    const report = await audit(db);
    assert.equal(report.audit, 'multibot_preparation');
    assert.equal(report.read_only, true);
    assert.equal(report.authority, 'DIAGNOSTICS_ONLY');
    assert.equal(report.metadata_limit_exceeded, false);
    assert.deepEqual(
      report.metadata.migrations.map((entry) => entry.name),
      MULTIBOT_PREPARATION_MIGRATIONS,
    );
    assert(report.metadata.migrations.every((entry) => entry.records.length === 0));
    assert(report.indexes.every((index) => index.state === 'ABSENT'));
    assert.equal(report.builders.statistics_visible, true);
    assert.equal(report.builders.absent, true);
    assert.doesNotMatch(
      JSON.stringify(report),
      /MESSAGE_CONTENT_NEVER_READ|private_extra|not-visible/u,
    );
    const plan = await db.query(`EXPLAIN (FORMAT JSON) ${sql}`);
    assert.doesNotMatch(JSON.stringify(plan), /"Relation Name":"webhook_events"/u);
  } finally {
    await db.close();
  }
});

test('all exact definitions are ready, while ordering, includes, predicates and table collisions drift', async () => {
  const db = new PGlite();
  try {
    await db.exec(fixtureSql + createIndexesSql);
    let report = await audit(db);
    assert(report.indexes.every((index) => index.definition_matches && index.state === 'READY'));
    assert(report.indexes.every((index) => index.valid && index.ready && index.live));
    assert(
      report.indexes.every((index) => typeof index.definition === 'string' && index.bytes > 0),
    );
    await db.exec(`
      DROP INDEX webhook_events_semantic_order_idx;
      CREATE INDEX webhook_events_semantic_order_idx ON webhook_events (semantic_key DESC, created_at, id)
        WHERE semantic_key IS NOT NULL;
      DROP INDEX webhook_events_status_created_at_id_idx;
      CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events (status, created_at, id)
        INCLUDE (semantic_key);
      DROP INDEX webhook_events_semantic_replay_fence_idx;
      CREATE INDEX webhook_events_semantic_replay_fence_idx ON webhook_events (semantic_key, id)
        WHERE semantic_key IS NOT NULL;
    `);
    report = await audit(db);
    assert(report.indexes.every((index) => index.state === 'DEFINITION_DRIFT'));
    assert(report.indexes.every((index) => index.definition === null));
    await db.exec(`
      DROP INDEX webhook_events_semantic_order_idx;
      CREATE TABLE unexpected_parent (semantic_key text, created_at timestamp, id text);
      CREATE INDEX webhook_events_semantic_order_idx ON unexpected_parent (semantic_key, created_at, id)
        WHERE semantic_key IS NOT NULL;
    `);
    report = await audit(db);
    assert.equal(report.indexes[0].parent_matches, false);
    assert.equal(report.indexes[0].state, 'DEFINITION_DRIFT');
  } finally {
    await db.close();
  }
});

test('effective privilege precondition rejects missing metadata, inherited extra reads and column mutations', async () => {
  const db = new PGlite();
  try {
    await db.exec(fixtureSql);
    const ready = async () =>
      (await db.query(privilegesSql)).rows[0].multibot_preparation_receipt_privileges_ready;
    await db.exec('SET ROLE multibot_diagnostic_auditor');
    assert.equal(await ready(), true);
    await db.exec(
      'RESET ROLE; REVOKE SELECT (logs) ON _prisma_migrations FROM multibot_diagnostic_auditor; SET ROLE multibot_diagnostic_auditor',
    );
    assert.equal(await ready(), false);
    await db.exec(
      'RESET ROLE; GRANT SELECT (logs) ON _prisma_migrations TO multibot_diagnostic_auditor; GRANT UPDATE (id) ON _prisma_migrations TO multibot_diagnostic_auditor; SET ROLE multibot_diagnostic_auditor',
    );
    assert.equal(await ready(), false);
    await db.exec(
      'RESET ROLE; REVOKE UPDATE (id) ON _prisma_migrations FROM multibot_diagnostic_auditor; GRANT SELECT (private_extra) ON _prisma_migrations TO PUBLIC; SET ROLE multibot_diagnostic_auditor',
    );
    assert.equal(await ready(), false);
    await db.exec(
      'RESET ROLE; REVOKE SELECT (private_extra) ON _prisma_migrations FROM PUBLIC; GRANT SELECT ON _prisma_migrations TO pg_read_all_stats; SET ROLE multibot_diagnostic_auditor',
    );
    assert.equal(await ready(), false);
    await db.exec(
      'RESET ROLE; REVOKE SELECT ON _prisma_migrations FROM pg_read_all_stats; SET ROLE multibot_diagnostic_auditor',
    );
    assert.equal(await ready(), true);
  } finally {
    await db.close();
  }
});

test('receipt failures are typed, checksum mismatches remain visible and raw logs are never emitted', async () => {
  const db = new PGlite();
  try {
    await db.exec(fixtureSql);
    const failures = [
      'NO_ERROR_RECORDED',
      'LOCK_TIMEOUT',
      'QUERY_CANCELLED',
      'CONNECTION_TERMINATED',
      'OTHER_ERROR',
    ];
    const logs = [
      '',
      '55P03 lock timeout SECRET_LOG',
      '57014 statement timeout SECRET_LOG',
      '57P01 terminating connection SECRET_LOG',
      'unknown SECRET_LOG',
    ];
    for (let i = 0; i < MULTIBOT_PREPARATION_MIGRATIONS.length; i += 1) {
      const name = MULTIBOT_PREPARATION_MIGRATIONS[i];
      await db.query(
        `INSERT INTO _prisma_migrations VALUES ($1, $2, $3, now(), $4, NULL, $5, $6, $7)`,
        [
          `receipt-${i}`,
          name,
          i === 1 ? '0'.repeat(64) : multibotPreparationChecksums[name],
          i === 0 ? new Date() : null,
          i === 0 ? 1 : 0,
          logs[i],
          'PRIVATE_RECEIPT_FIELD',
        ],
      );
    }
    await db.query(
      `INSERT INTO _prisma_migrations VALUES ('foreign', 'unrelated_migration', $1, now(), NULL, NULL, 0, 'SECRET_LOG', 'PRIVATE_RECEIPT_FIELD')`,
      ['0'.repeat(64)],
    );
    await db.exec('SET ROLE multibot_diagnostic_auditor');
    let report = await audit(db);
    assert.equal(report.metadata.other_failed, true);
    assert.deepEqual(
      report.metadata.migrations.map((entry) => entry.records[0].failure_code),
      failures,
    );
    assert.equal(report.metadata.migrations[0].records[0].state, 'APPLIED');
    assert.equal(report.metadata.migrations[1].records[0].state, 'UNFINISHED');
    assert.equal(report.metadata.migrations[1].records[0].checksum_matches, false);
    assert.doesNotMatch(
      JSON.stringify(report),
      /SECRET_LOG|PRIVATE_RECEIPT_FIELD|foreign|unrelated_migration/u,
    );
    await db.exec('RESET ROLE');
    await db.query('UPDATE _prisma_migrations SET logs = $1 WHERE id = $2', [
      'SECRET_LOG'.repeat(8000),
      'receipt-2',
    ]);
    report = await audit(db);
    assert.equal(report.metadata.migrations[2].records[0].failure_code, 'LOG_OVERSIZED');
  } finally {
    await db.close();
  }
});

test('receipt and concurrent-repair artifact limits stay explicit', async () => {
  const db = new PGlite();
  try {
    await db.exec(fixtureSql);
    for (let i = 0; i < 9; i += 1)
      await db.query(
        'INSERT INTO _prisma_migrations VALUES ($1, $2, $3, now(), NULL, now(), 0, NULL, NULL)',
        [
          `receipt-${i}`,
          MULTIBOT_PREPARATION_MIGRATIONS[1],
          multibotPreparationChecksums[MULTIBOT_PREPARATION_MIGRATIONS[1]],
        ],
      );
    await db.exec(
      Array.from(
        { length: 33 },
        (_, i) =>
          `CREATE INDEX webhook_events_semantic_order_idx_ccnew${i} ON webhook_events (id);`,
      ).join('\n'),
    );
    const report = await audit(db);
    assert.equal(report.metadata.migrations[1].limited, true);
    assert.equal(report.metadata.migrations[1].records.length, 8);
    assert(report.metadata.migrations[1].records.every((record) => record.state === 'ROLLED_BACK'));
    assert.equal(report.repair_artifacts.present, true);
    assert.equal(report.repair_artifacts.sampled_count, 33);
    assert.equal(report.repair_artifacts.limited, true);
    assert.deepEqual(report.repair_artifacts.kinds, ['CCNEW']);
  } finally {
    await db.close();
  }
});

test('oversized receipt table is unavailable metadata rather than a partial successful review', async () => {
  const db = new PGlite();
  try {
    await db.exec(fixtureSql);
    // FLAG: Incompressible disposable receipt metadata exercises the physical table/TOAST cap.
    await db.exec(`INSERT INTO _prisma_migrations (id, logs)
      SELECT i::text, (SELECT string_agg(md5((i * 2000 + j)::text), '') FROM generate_series(1, 2000) j)
      FROM generate_series(1, 160) i;`);
    const report = await audit(db);
    assert.equal(report.metadata_limit_exceeded, true);
    assert.equal(report.metadata, null);
  } finally {
    await db.close();
  }
});

test('fixed SQL CLI allows plain EXPLAIN and rejects caller names, SQL and extra arguments', () => {
  const script = new URL('./multibot-prepare-diagnostics.mjs', import.meta.url).pathname;
  for (const args of [['SELECT * FROM webhook_events'], ['--apply'], ['--explain', 'extra']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  }
  const result = spawnSync(process.execPath, [script, '--explain'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, emitMultibotPreparationAuditSql(true));
  assert.match(result.stdout, /\\if :multibot_preparation_receipt_privileges_ready/u);
  assert.ok(result.stdout.indexOf('\\gset') < result.stdout.indexOf('EXPLAIN (FORMAT JSON)'));
  assert.doesNotMatch(
    sql,
    /\b(?:UPDATE|DELETE|INSERT|ALTER|DROP|REINDEX\s+INDEX|CREATE\s+INDEX|pg_terminate_backend|pg_cancel_backend|EXPLAIN\s+ANALYZE)\b/iu,
  );
});

test(
  'native metadata distinguishes owned sessions and safe absence without exposing tags or PIDs',
  { skip: !nativePostgresUrl, timeout: 30_000 },
  async () => {
    const address = new URL(nativePostgresUrl);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) &&
        address.pathname.includes('race_test'),
      'Native diagnostic requires disposable local PostgreSQL race_test',
    );
    const { default: pg } = await import('pg');
    const databaseName = `race_test_mb_diagnostic_${randomUUID().replaceAll('-', '')}`;
    const diagnosticAddress = new URL(nativePostgresUrl);
    diagnosticAddress.pathname = `/${databaseName}`;
    const options = {
      connectionString: diagnosticAddress.href,
      connectionTimeoutMillis: 5000,
      query_timeout: 10_000,
      options: '-c statement_timeout=10000 -c lock_timeout=3000 -c timezone=UTC',
    };
    const admin = new pg.Client({ ...options, connectionString: nativePostgresUrl });
    const client = new pg.Client(options);
    const tag = `maxim-online-${randomUUID()}`;
    const builder = new pg.Client({ ...options, application_name: tag });
    const schemaName = `multibot_diagnostic_${randomUUID().replaceAll('-', '')}`;
    const schema = `"${schemaName}"`;
    const roleName = `multibot_audit_${randomUUID().replaceAll('-', '')}`;
    // FLAG: Replace only the fixed catalog namespace in a disposable native schema.
    const nativeSql = sql
      .replaceAll("'public.", `'${schemaName}.`)
      .replaceAll('public._prisma_migrations', `${schemaName}._prisma_migrations`)
      .replaceAll("'public'::regnamespace", `'${schemaName}'::regnamespace`);
    let builderConnected = false;
    const writer = new pg.Client(options);
    const indexTag = `maxim-online-${randomUUID()}`;
    const indexBuilder = new pg.Client({ ...options, application_name: indexTag });
    let writerConnected = false;
    let indexBuilderConnected = false;
    let roleCreated = false;
    let adminConnected = false;
    let databaseCreated = false;
    let clientConnected = false;
    let building;
    try {
      await admin.connect();
      adminConnected = true;
      // FLAG: The fixed audit deliberately counts every tagged session in its DB.
      // Isolate this native fixture from parallel tests without weakening that scope.
      await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
      databaseCreated = true;
      await client.connect();
      clientConnected = true;
      const identity = await client.query('SELECT version() AS version');
      assert.match(identity.rows[0].version, /^PostgreSQL /u);
      assert.doesNotMatch(identity.rows[0].version, /pglite|wasm/iu);
      assert.equal(
        (await client.query('SELECT current_database() AS name')).rows[0].name,
        databaseName,
      );
      await client.query(`CREATE TYPE public."WebhookStatus" AS ENUM ('RECEIVED', 'QUEUED', 'FAILED', 'PROCESSED');
        CREATE SCHEMA ${schema};
        CREATE TABLE ${schema}.webhook_events (id text, semantic_key text, execution_deadline_at timestamp(3),
          created_at timestamp, status public."WebhookStatus", next_enqueue_at timestamp,
          timeout_quarantine_expires_at timestamp, error_message text);
        CREATE TABLE ${schema}._prisma_migrations (id text, migration_name text, checksum text,
          started_at timestamptz, finished_at timestamptz, rolled_back_at timestamptz,
          applied_steps_count int, logs text, private_extra text);`);
      const read = async () => {
        await client.query('BEGIN READ ONLY');
        try {
          return (await client.query(nativeSql)).rows[0].json_build_object;
        } finally {
          await client.query('ROLLBACK');
        }
      };
      const waitForBackendAbsence = async (pid) => {
        // FLAG: Client end acknowledges socket closure, not completed PG backend teardown.
        // Observe the exact ended backend before asserting the fixed report's absence.
        const stopAt = Date.now() + 5000;
        while (Date.now() < stopAt) {
          const activity = await client.query(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND pid = $1) AS present`,
            [pid],
          );
          if (activity.rows[0].present === false) return;
          await delay(10);
        }
        assert.fail('The ended local backend must disappear before absence diagnostics');
      };
      let report = await read();
      assert.equal(report.builders.statistics_visible, true);
      assert.equal(report.builders.absent, true);
      await builder.connect();
      builderConnected = true;
      const builderPid = (await builder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      report = await read();
      assert.equal(report.builders.tagged_sessions, 1);
      assert.equal(report.builders.absent, false);
      assert.doesNotMatch(JSON.stringify(report), new RegExp(tag, 'u'));
      await builder.end();
      builderConnected = false;
      await waitForBackendAbsence(builderPid);
      assert.equal((await read()).builders.absent, true);
      await client.query(
        `INSERT INTO ${schema}.webhook_events (id, semantic_key) VALUES ('1', 'same')`,
      );
      await writer.connect();
      writerConnected = true;
      await writer.query(`BEGIN; UPDATE ${schema}.webhook_events SET id = id`);
      await indexBuilder.connect();
      indexBuilderConnected = true;
      const indexBuilderPid = (await indexBuilder.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      building = indexBuilder
        .query(
          `CREATE INDEX CONCURRENTLY webhook_events_semantic_order_idx
        ON ${schema}.webhook_events (semantic_key, created_at, id) WHERE semantic_key IS NOT NULL`,
        )
        .then(
          () => null,
          (error) => error,
        );
      const stopAt = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < stopAt) {
        const progress = await client.query(
          `SELECT phase FROM pg_stat_progress_create_index
          WHERE relid = $1::regclass`,
          [`${schemaName}.webhook_events`],
        );
        if (progress.rows.some((row) => row.phase === 'waiting for writers before build')) {
          waiting = true;
          break;
        }
        await delay(50);
      }
      assert.equal(waiting, true, 'Local concurrent builder must reach the controlled writer wait');
      report = await read();
      assert.equal(report.builders.absent, false);
      assert.equal(report.builders.progress_sessions, 1);
      assert.equal(report.indexes[0].definition_matches, true);
      assert.equal(report.indexes[0].state, 'INCOMPLETE');
      await client.query(
        `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
        WHERE application_name = $1 AND datname = current_database() AND pid <> pg_backend_pid()`,
        [indexTag],
      );
      const failure = await building;
      assert.equal(failure?.code, '57014');
      building = null;
      await indexBuilder.end();
      indexBuilderConnected = false;
      await waitForBackendAbsence(indexBuilderPid);
      await writer.query('ROLLBACK');
      report = await read();
      assert.equal(report.builders.absent, true);
      assert.equal(report.indexes[0].valid, false);
      assert.equal(report.indexes[0].live, true);
      assert.equal(report.indexes[0].state, 'INCOMPLETE');
      assert.doesNotMatch(JSON.stringify(report), new RegExp(indexTag, 'u'));
      await client.query(`CREATE ROLE "${roleName}";
        GRANT USAGE ON SCHEMA ${schema} TO "${roleName}";
        GRANT SELECT (${MULTIBOT_PREPARATION_RECEIPT_COLUMNS.join(', ')})
          ON ${schema}._prisma_migrations TO "${roleName}";
        GRANT pg_read_all_stats TO "${roleName}";`);
      roleCreated = true;
      const nativePrivilegesSql = privilegesSql.replaceAll("'public.", `'${schemaName}.`);
      const privilegesReady = async () => {
        await client.query(`SET ROLE "${roleName}"`);
        try {
          return (await client.query(nativePrivilegesSql)).rows[0]
            .multibot_preparation_receipt_privileges_ready;
        } finally {
          await client.query('RESET ROLE');
        }
      };
      assert.equal(await privilegesReady(), true);
      await client.query(`GRANT UPDATE (id) ON ${schema}._prisma_migrations TO "${roleName}"`);
      assert.equal(await privilegesReady(), false);
      await client.query(`REVOKE UPDATE (id) ON ${schema}._prisma_migrations FROM "${roleName}";
        GRANT SELECT (private_extra) ON ${schema}._prisma_migrations TO PUBLIC;`);
      assert.equal(await privilegesReady(), false);
      await client.query(
        `REVOKE SELECT (private_extra) ON ${schema}._prisma_migrations FROM PUBLIC`,
      );
      assert.equal(await privilegesReady(), true);
      // FLAG: Run the CLI's actual psql guard against isolated role grants, including EXPLAIN.
      const psqlEnv = {
        ...process.env,
        PGHOST: address.hostname,
        PGPORT: address.port || '5432',
        PGUSER: decodeURIComponent(address.username),
        PGPASSWORD: decodeURIComponent(address.password),
        PGDATABASE: decodeURIComponent(diagnosticAddress.pathname.slice(1)),
        PGOPTIONS: '-c statement_timeout=10000 -c lock_timeout=3000 -c timezone=UTC',
      };
      const runCli = (explain = false) =>
        spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-Atq'], {
          env: psqlEnv,
          encoding: 'utf8',
          timeout: 10_000,
          input: `BEGIN READ ONLY;\nSET ROLE "${roleName}";\n${emitMultibotPreparationAuditSql(
            explain,
          )
            .replaceAll("'public.", `'${schemaName}.`)
            .replaceAll('public._prisma_migrations', `${schemaName}._prisma_migrations`)
            .replaceAll("'public'::regnamespace", `'${schemaName}'::regnamespace`)}\nROLLBACK;`,
        });
      let result = runCli();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).audit, 'multibot_preparation');
      result = runCli(true);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(Array.isArray(JSON.parse(result.stdout)));
      await client.query(`GRANT UPDATE (id) ON ${schema}._prisma_migrations TO "${roleName}"`);
      for (const explain of [false, true]) {
        result = runCli(explain);
        assert.equal(result.status, 3);
        assert.equal(result.stdout.trim(), 'MULTIBOT_PREPARATION_RECEIPT_PRIVILEGES_INVALID');
      }
    } finally {
      try {
        if (builderConnected) await builder.end();
        if (writerConnected) {
          await writer.query('ROLLBACK').catch(() => {});
          await writer.end();
        }
        if (building) await building;
        if (indexBuilderConnected) await indexBuilder.end();
        if (clientConnected) {
          await client.query('RESET ROLE').catch(() => {});
          await client.end();
        }
        if (databaseCreated) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        if (roleCreated) await admin.query(`DROP ROLE "${roleName}"`);
      } finally {
        if (adminConnected) await admin.end();
      }
    }
  },
);
