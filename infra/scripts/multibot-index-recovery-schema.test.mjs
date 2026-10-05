import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ADDITIVE_MIGRATION,
  MIGRATION,
  SEMANTIC_ORDER_MIGRATION,
  MAXIMUM_TABLE_BYTES,
  migrationChecksums,
  indexes,
  indexPredicates,
  recoveryAuditSql,
  recoveryIndexSql,
  verifyRecoveryState,
} from './multibot-index-recovery-schema.mjs';
import {
  multibotPrismaFailure as prismaFailure,
  prepareMultibotRecoveryCatalog,
  withMultibotRecoveryCatalog as fixture,
} from './multibot-index-recovery.test-support.mjs';

const sqlFor = (name) => readFileSync(`apps/api/prisma/migrations/${name}/migration.sql`, 'utf8');
const migrationSql = sqlFor(MIGRATION);
const names = Object.keys(indexes);
const prerequisiteIndex = 'webhook_events_semantic_order_idx';
const verify = (report) =>
  verifyRecoveryState(
    report,
    migrationChecksums[MIGRATION],
    migrationChecksums[ADDITIVE_MIGRATION],
    migrationChecksums[SEMANTIC_ORDER_MIGRATION],
  );

const createRecoveryIndexes = async (db) => {
  for (const name of names)
    await db.exec(recoveryIndexSql(name, 'create').replace(' CONCURRENTLY', ''));
};

test('all three immutable migration digests are pinned independently of caller-provided checksums', async () => {
  for (const [name, checksum] of Object.entries(migrationChecksums))
    assert.equal(createHash('sha256').update(sqlFor(name)).digest('hex'), checksum);
  await fixture(async (_db, read) => {
    const report = await read();
    for (let position = 0; position < 3; position++) {
      const arguments_ = [
        migrationChecksums[MIGRATION],
        migrationChecksums[ADDITIVE_MIGRATION],
        migrationChecksums[SEMANTIC_ORDER_MIGRATION],
      ];
      arguments_[position] = '0'.repeat(64);
      assert.throws(() => verifyRecoveryState(report, ...arguments_), /SOURCE_CHECKSUM_MISMATCH/u);
    }
    const altered = structuredClone(report);
    altered.metadata.records[0].checksum = '0'.repeat(64);
    assert.throws(
      () =>
        verifyRecoveryState(
          altered,
          '0'.repeat(64),
          migrationChecksums[ADDITIVE_MIGRATION],
          migrationChecksums[SEMANTIC_ORDER_MIGRATION],
        ),
      /SOURCE_CHECKSUM_MISMATCH/u,
    );
  });
});

test('actual immutable PostgreSQL predicate includes every replay branch and only fixed indexes are repairable', async () => {
  await fixture(async (db, read) => {
    assert.deepEqual(
      verify(await read()).actions,
      names.map((name) => ({ name, action: 'create' })),
    );
    await db.exec(migrationSql.replaceAll('CREATE INDEX CONCURRENTLY', 'CREATE INDEX'));
    const report = await read();
    assert.deepEqual(
      verify(report).actions,
      names.map((name) => ({ name, action: 'ready' })),
    );
    assert.equal(
      report.indexes.find(({ name }) => name === names[1]).predicate,
      indexPredicates[names[1]],
    );
    for (const name of names) await db.exec(`DROP INDEX ${name}`);
    await createRecoveryIndexes(db);
    assert.deepEqual(
      (await read()).indexes,
      report.indexes,
      'Fixed repair differs from immutable migration',
    );
    for (const [name, action] of [
      [prerequisiteIndex, 'reindex'],
      ['unknown', 'create'],
      [names[0], 'drop'],
      [names[0], 'ready'],
    ])
      assert.throws(() => recoveryIndexSql(name, action), /OPERATION_INVALID/u);
    for (const name of names) {
      assert.equal(recoveryIndexSql(name, 'reindex'), `REINDEX INDEX CONCURRENTLY public.${name};`);
      assert.match(recoveryIndexSql(name, 'create'), /^CREATE INDEX CONCURRENTLY /u);
      assert.doesNotMatch(recoveryIndexSql(name, 'create'), /IF NOT EXISTS|DROP /u);
    }
  });
});

test('catalog accepts the reviewed 89 GiB table and rejects beyond the explicit 128 GiB scope', async () => {
  await fixture(async (_db, read) => {
    const report = await read();
    for (const bytes of [89 * 1024 ** 3, MAXIMUM_TABLE_BYTES])
      verify({ ...report, table_bytes: bytes });
    for (const bytes of [
      -1,
      1.5,
      MAXIMUM_TABLE_BYTES + 1,
      Number.MAX_SAFE_INTEGER + 1,
      null,
      '89GB',
    ])
      assert.throws(() => verify({ ...report, table_bytes: bytes }), /CATALOG_OUTSIDE_SCOPE/u);
    for (const change of [
      { parent_kind: 'p' },
      { parent_persistence: 'u' },
      { repair_artifacts: true },
      { active_owned_sessions: true },
      { active_owned_sessions: null },
      { status_enum: ['RECEIVED', 'QUEUED'] },
    ])
      assert.throws(() => verify({ ...report, ...change }), /CATALOG_OUTSIDE_SCOPE/u);
    for (const change of [{ kind: 'i' }, { valid: false }, { columns: [] }]) {
      const altered = structuredClone(report);
      Object.assign(altered.indexes[1], change);
      assert.throws(() => verify(altered), /INDEX_DRIFT/u);
    }
  });
});

test('actual catalog rejects wrong target parent, keys, order, collation, method, includes, expressions and storage options', async () => {
  await fixture(async (db, read) => {
    await db.exec('CREATE TABLE unrelated (LIKE webhook_events INCLUDING ALL)');
    for (const name of names) {
      const keys = indexes[name];
      const base = keys.join(', ');
      const predicate = name === names[1] ? ` WHERE ${indexPredicates[name]}` : '';
      for (const definition of [
        `ON unrelated (${base})${predicate}`,
        `ON webhook_events (${[...keys].reverse().join(', ')})${predicate}`,
        `ON webhook_events (${keys.map((key) => (key === 'id' ? 'id DESC' : key)).join(', ')})${predicate}`,
        `ON webhook_events (${keys.map((key) => (key === 'id' ? 'id text_pattern_ops' : key)).join(', ')})${predicate}`,
        `ON webhook_events (${keys.map((key) => (key === 'id' ? 'id COLLATE "C"' : key)).join(', ')})${predicate}`,
        `ON webhook_events (${keys.map((key) => (key === 'id' ? 'lower(id)' : key)).join(', ')})${predicate}`,
        `ON webhook_events (${base}) INCLUDE (error_message)${predicate}`,
        `ON webhook_events (${base}) WITH (fillfactor=70)${predicate}`,
        `ON webhook_events (${base}) WHERE id IS NOT NULL`,
        `ON webhook_events USING brin (id)${predicate}`,
      ]) {
        await db.exec(`CREATE INDEX ${name} ${definition}`);
        await assert.rejects(async () => verify(await read()), /INDEX_DRIFT/u);
        await db.exec(`DROP INDEX ${name}`);
      }
    }
  });
});

test('all original replay-fence branches are required even on an otherwise valid index', async () => {
  await fixture(async (db, read) => {
    const correct = recoveryIndexSql(names[1], 'create').replace(' CONCURRENTLY', '');
    const branches = [
      / OR \("status" = 'FAILED'::public\."WebhookStatus" AND "next_enqueue_at" IS NOT NULL\)/u,
      / OR "timeout_quarantine_expires_at" IS NOT NULL/u,
      / OR COALESCE\("error_message", ''\) ILIKE '%ambiguous%'/u,
      / OR COALESCE\("error_message", ''\) LIKE 'WEBHOOK_HOT_PATH_TIMEOUT%QUARANTINED%'/u,
    ];
    for (const branch of branches) {
      const altered = correct.replace(branch, '');
      assert.notEqual(altered, correct);
      await db.exec(altered);
      await assert.rejects(async () => verify(await read()), /INDEX_DRIFT/u);
      await db.exec(`DROP INDEX ${names[1]}`);
    }
    await db.exec(correct.replace('"semantic_key" IS NOT NULL AND (', '('));
    await assert.rejects(async () => verify(await read()), /INDEX_DRIFT/u);
  });
});

test('reindex artifacts and absent or invalid semantic-order prerequisite never authorize target repair', async () => {
  await fixture(async (db, read) => {
    const report = await read();
    const invalid = structuredClone(report);
    invalid.indexes[0].valid = false;
    assert.throws(() => verify(invalid), /PREREQUISITE_INDEX_INVALID/u);
    for (const name of [prerequisiteIndex, ...names]) {
      for (const suffix of ['_ccnew', '_ccold', '_ccnew1']) {
        await db.exec(`CREATE INDEX ${name}${suffix} ON webhook_events(id)`);
        await assert.rejects(async () => verify(await read()), /CATALOG_OUTSIDE_SCOPE/u);
        await db.exec(`DROP INDEX ${name}${suffix}`);
      }
    }
    await db.exec(`DROP INDEX ${prerequisiteIndex}`);
    await assert.rejects(async () => verify(await read()), /INDEX_DRIFT/u);
    await db.exec(
      `CREATE INDEX ${prerequisiteIndex} ON webhook_events(semantic_key, created_at, id)`,
    );
    await assert.rejects(async () => verify(await read()), /INDEX_DRIFT/u);
  });
});

test('exact invalid target index may reindex only with coherent ready/live catalog metadata', async () => {
  await fixture(async (db, read) => {
    await createRecoveryIndexes(db);
    const report = await read();
    for (const ready of [false, true]) {
      const invalid = structuredClone(report);
      invalid.indexes[1].valid = false;
      invalid.indexes[1].ready = ready;
      assert.equal(verify(invalid).actions[0].action, 'reindex');
    }
    for (const change of [
      { ready: false },
      { live: false },
      { valid: null },
      { ready: null },
      { default_tablespace: false },
      { options: ['fillfactor=70'] },
      { default_key_options: false },
      { unique: true },
      { primary: true },
      { exclusion: true },
      { kind: 'r' },
    ]) {
      const altered = structuredClone(report);
      Object.assign(altered.indexes[1], change);
      assert.throws(() => verify(altered), /INDEX_DRIFT/u);
    }
    const duplicate = structuredClone(report);
    duplicate.indexes[2] = structuredClone(duplicate.indexes[1]);
    assert.throws(() => verify(duplicate), /INDEX_DRIFT/u);
  });
});

test('every key and filter column is checked against exact type, defaults, nullability and collation', async () => {
  await fixture(async (db, read) => {
    const report = await read();
    for (let position = 0; position < report.columns.length; position++) {
      for (const change of [
        { type: 'varchar' },
        { type_namespace: 'unrelated' },
        { type_kind: 'd' },
        { not_null: !report.columns[position].not_null },
        { default: 'unsafe-default' },
        { identity: 'a' },
        { generated: 's' },
        { default_collation: false },
      ]) {
        const altered = structuredClone(report);
        Object.assign(altered.columns[position], change);
        assert.throws(() => verify(altered), /COLUMN_DRIFT/u);
      }
    }
    await db.exec(
      'ALTER TABLE webhook_events ALTER COLUMN execution_deadline_at TYPE timestamp(6)',
    );
    await assert.rejects(async () => verify(await read()), /COLUMN_DRIFT/u);
    await db.exec(
      'ALTER TABLE webhook_events ALTER COLUMN execution_deadline_at TYPE timestamp(3)',
    );
    await db.exec(`ALTER TABLE webhook_events ALTER COLUMN semantic_key SET DEFAULT ''`);
    await assert.rejects(async () => verify(await read()), /COLUMN_DRIFT/u);
  });
});

test('failure classification accepts only complete actual Prisma/server lock and statement-timeout blocks', async () => {
  await fixture(async (db, read) => {
    for (const [code, family, expected] of [
      ['55P03', 'lock timeout', 'lock_timeout'],
      ['57014', 'statement timeout', 'statement_timeout'],
    ]) {
      for (const logs of [
        prismaFailure(code, family),
        prismaFailure(code, family).replaceAll('\n', '\r\n'),
      ]) {
        await db.query('UPDATE _prisma_migrations SET logs=$1 WHERE migration_name=$2', [
          logs,
          MIGRATION,
        ]);
        const report = await read();
        assert.equal(report.metadata.records[0].failure, expected);
        assert.equal(verify(report).recordState, 'failed');
        assert.equal(JSON.stringify(report).includes('fixture-private-log'), false);
      }
    }
    for (const logs of [
      '55P03 lock timeout',
      '57014 statement timeout',
      '57014',
      '',
      null,
      prismaFailure('57014', 'user request'),
      prismaFailure('57014', 'lock timeout'),
      prismaFailure('55P03', 'statement timeout'),
      prismaFailure('40P01', 'lock timeout'),
      prismaFailure('57014', 'statement timeout unconfirmed'),
      'Database error code: 42P01\n\nDatabase error:\nERROR: unrelated\nHINT: 55P03 lock timeout',
      `private-prefix${prismaFailure('55P03', 'lock timeout').slice(prismaFailure('55P03', 'lock timeout').indexOf('Database error code:'))}`,
      `${prismaFailure('55P03', 'lock timeout')}\nDatabase error code: 42P01\n\nDatabase error:\nERROR: unrelated`,
      `${prismaFailure('55P03', 'lock timeout')}\nERROR: unrelated`,
    ]) {
      await db.query('UPDATE _prisma_migrations SET logs=$1 WHERE migration_name=$2', [
        logs,
        MIGRATION,
      ]);
      const report = await read();
      assert.equal(report.metadata.records[0].failure, 'other');
      assert.throws(() => verify(report), /FAILURE_UNPROVEN/u);
    }
    await db.query('UPDATE _prisma_migrations SET logs=$1 WHERE migration_name=$2', [
      'x'.repeat(65537) + prismaFailure('55P03', 'lock timeout'),
      MIGRATION,
    ]);
    const oversized = await read();
    assert.equal(oversized.metadata.records[0].failure, 'oversized');
    assert.throws(() => verify(oversized), /FAILURE_UNPROVEN/u);
    assert.equal(JSON.stringify(oversized).includes('xxxx'), false);
  });
});

test('receipts require exactly one immutable successful prerequisite each, one target and no foreign failure', async () => {
  await fixture(async (db, read) => {
    const report = await read();
    for (const group of ['prerequisite', 'semantic_order']) {
      for (const change of [
        { checksum: '0'.repeat(64) },
        { finished: false },
        { applied_steps_count: 0 },
        { id: '' },
      ]) {
        const altered = structuredClone(report);
        Object.assign(altered.metadata[group][0], change);
        assert.throws(() => verify(altered), /PREREQUISITE_INVALID/u);
      }
      for (const records of [[], [...report.metadata[group], report.metadata[group][0]], null]) {
        const altered = structuredClone(report);
        altered.metadata[group] = records;
        assert.throws(() => verify(altered), /PREREQUISITE_INVALID/u);
      }
    }
    for (const change of [
      { checksum: '0'.repeat(64) },
      { id: '' },
      { finished: null },
      { applied_steps_count: -1 },
    ]) {
      const altered = structuredClone(report);
      Object.assign(altered.metadata.records[0], change);
      assert.throws(() => verify(altered), /RECEIPT_INVALID/u);
    }
    const nonzero = structuredClone(report);
    nonzero.metadata.records[0].applied_steps_count = 1;
    assert.throws(() => verify(nonzero), /FAILURE_UNPROVEN/u);
    await db.query('INSERT INTO _prisma_migrations VALUES ($1,$2,$3,NULL,NULL,0,$4)', [
      'foreign',
      '0'.repeat(64),
      'foreign_migration',
      prismaFailure('55P03', 'lock timeout'),
    ]);
    await assert.rejects(async () => verify(await read()), /RECEIPTS_OUTSIDE_SCOPE/u);
    await db.query('UPDATE _prisma_migrations SET migration_name=$1 WHERE id=$2', [
      MIGRATION,
      'foreign',
    ]);
    await assert.rejects(async () => verify(await read()), /RECEIPTS_OUTSIDE_SCOPE/u);
    await db.query('DELETE FROM _prisma_migrations WHERE migration_name=$1', [MIGRATION]);
    await assert.rejects(async () => verify(await read()), /RECEIPTS_OUTSIDE_SCOPE/u);
  });
});

test('Prisma resolve applied receipt with zero steps is accepted only after both exact indexes are ready', async () => {
  await fixture(async (db, read) => {
    await db.query(
      'UPDATE _prisma_migrations SET finished_at=CURRENT_TIMESTAMP WHERE migration_name=$1',
      [MIGRATION],
    );
    await assert.rejects(async () => verify(await read()), /APPLIED_INDEX_DRIFT/u);
    await createRecoveryIndexes(db);
    assert.equal(verify(await read()).recordState, 'applied');
    const report = await read();
    assert.equal(report.metadata.records[0].applied_steps_count, 0);
  });
});

test('catalog reads no webhook rows and caps metadata and source logs without exposing contents', async () => {
  await fixture(async (db, read) => {
    await db.query('INSERT INTO webhook_events(id, error_message) VALUES($1,$2)', [
      'private-webhook-identity',
      'private-message-content',
    ]);
    const report = await read();
    const output = JSON.stringify(report);
    assert.equal(output.includes('private-webhook-identity'), false);
    assert.equal(output.includes('private-message-content'), false);
    assert.equal(output.includes('fixture-private-log'), false);
    assert.doesNotMatch(recoveryAuditSql, /FROM\s+(?:public\.)?webhook_events\b/iu);
    assert.match(
      recoveryAuditSql,
      /pg_total_relation_size\('public\._prisma_migrations'\) <= 8388608/u,
    );
    assert.match(recoveryAuditSql, /octet_length\(logs\) > 65536/u);
    assert.equal((recoveryAuditSql.match(/ORDER BY id LIMIT 2/gu) ?? []).length, 3);
    assert.match(recoveryAuditSql, /application_name, 'maxim-online-'/u);
  });
});

const nativePostgresUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
test(
  'native PostgreSQL 16 uses the immutable predicate and repairs an actual interrupted concurrent index without receipt mutation',
  { skip: !nativePostgresUrl, timeout: 45_000 },
  async () => {
    const address = new URL(nativePostgresUrl);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) &&
        address.pathname.includes('race_test'),
      'Requires disposable local PostgreSQL',
    );
    const { default: pg } = await import('pg');
    const database = `race_test_recovery_${randomUUID().replaceAll('-', '')}`;
    const common = {
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      options: '-c statement_timeout=10000 -c lock_timeout=3000 -c search_path=public',
    };
    const admin = new pg.Client({
      ...common,
      connectionString: nativePostgresUrl,
      application_name: 'multibot-recovery-fixture-admin',
    });
    const fixtureAddress = new URL(nativePostgresUrl);
    fixtureAddress.pathname = `/${database}`;
    const db = new pg.Client({
      ...common,
      connectionString: fixtureAddress.href,
      application_name: 'multibot-recovery-fixture',
    });
    const blocker = new pg.Client({
      ...common,
      connectionString: fixtureAddress.href,
      application_name: 'multibot-recovery-fixture-blocker',
    });
    let created = false;
    let connected = false;
    let blockerConnected = false;
    try {
      await admin.connect();
      assert.match((await admin.query('SHOW server_version')).rows[0].server_version, /^16\./u);
      await admin.query(`CREATE DATABASE ${database}`);
      created = true;
      await db.connect();
      connected = true;
      // Each original statement gets its own connection-level execution so PostgreSQL
      // does not group the concurrent build into an implicit multi-statement transaction.
      const execute = async (sql) => {
        // These fixed migrations contain full-line comments, including semicolons.
        // Strip those comments in the fixture without changing immutable source bytes.
        const statements = sql.replace(/^[ \t]*--[^\r\n]*/gmu, '').split(';');
        for (const statement of statements.filter((part) => part.trim())) await db.query(statement);
      };
      const adapter = { exec: execute, query: (sql, args) => db.query(sql, args) };
      await prepareMultibotRecoveryCatalog(adapter, { concurrent: true });
      const read = async () => (await db.query(recoveryAuditSql)).rows[0].json_build_object;
      await execute(migrationSql);
      const immutable = (await read()).indexes;
      assert.equal(immutable[2].predicate, indexPredicates[names[1]]);
      for (const name of names) await db.query(`DROP INDEX ${name}`);
      const receipt = (await read()).metadata;
      await blocker.connect();
      blockerConnected = true;
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE webhook_events IN ROW EXCLUSIVE MODE');
      await db.query("SET lock_timeout='250ms'");
      await assert.rejects(
        db.query(recoveryIndexSql(names[0], 'create')),
        (error) =>
          error.code === '55P03' && error.message === 'canceling statement due to lock timeout',
      );
      await db.query("SET lock_timeout='3000ms'");
      assert.equal(verify(await read()).actions[0].action, 'reindex');
      await blocker.query('COMMIT');
      await db.query(recoveryIndexSql(names[0], 'reindex'));
      await db.query(recoveryIndexSql(names[1], 'create'));
      const repaired = await read();
      assert.deepEqual(repaired.indexes, immutable);
      assert.deepEqual(
        repaired.metadata,
        receipt,
        'Index repair must preserve the failed Prisma receipt',
      );
      assert.deepEqual(
        verify(repaired).actions.map(({ action }) => action),
        ['ready', 'ready'],
      );
    } finally {
      if (blockerConnected) await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end().catch(() => {});
      if (connected) await db.end();
      if (created) await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    }
  },
);
