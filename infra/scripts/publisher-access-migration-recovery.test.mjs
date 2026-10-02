import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  recoverPublisherAccess,
  publisherAccessResolveCommandArgs,
} from './publisher-access-migration-recovery.mjs';
import {
  ADDITIVE_MIGRATION,
  MIGRATION,
  indexes,
  recoveryAuditSql,
  recoveryIndexSql,
  verifyRecoveryState,
} from './publisher-access-recovery-schema.mjs';

const migration = readFileSync(`apps/api/prisma/migrations/${MIGRATION}/migration.sql`, 'utf8');
const additiveMigration = readFileSync(
  `apps/api/prisma/migrations/${ADDITIVE_MIGRATION}/migration.sql`,
  'utf8',
);
const checksum = createHash('sha256').update(migration).digest('hex');
const additiveChecksum = createHash('sha256').update(additiveMigration).digest('hex');
const names = Object.keys(indexes);
const verify = (report) => verifyRecoveryState(report, checksum, additiveChecksum);

async function fixture(run) {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE publisher_entity_bindings (
      publisher_bot_id text, chat_id text PRIMARY KEY, status text, bot_access_expires_at timestamp(3));
      CREATE TABLE _prisma_migrations (id text PRIMARY KEY, checksum text, migration_name text,
        finished_at timestamp, rolled_back_at timestamp, applied_steps_count integer, logs text);`);
    await db.exec(additiveMigration);
    await db.query(
      'INSERT INTO _prisma_migrations VALUES ($1, $2, $3, CURRENT_TIMESTAMP, NULL, 1, NULL)',
      ['additive-receipt', additiveChecksum, ADDITIVE_MIGRATION],
    );
    await db.query('INSERT INTO _prisma_migrations VALUES ($1, $2, $3, NULL, NULL, 0, $4)', [
      'failed-attempt',
      checksum,
      MIGRATION,
      '55P03 lock timeout',
    ]);
    const read = async () => (await db.query(recoveryAuditSql)).rows[0].json_build_object;
    await run(db, read);
  } finally {
    await db.close();
  }
}

async function createIndexes(db) {
  for (const name of names)
    await db.exec(recoveryIndexSql(name, 'create').replace(' CONCURRENTLY', ''));
}

async function readyIndexCatalog(db, read) {
  await createIndexes(db);
  const complete = (await read()).indexes;
  for (const name of names) await db.exec(`DROP INDEX ${name}`);
  return complete;
}

test('actual catalog distinguishes absent, partial and complete immutable Publisher access indexes', async () => {
  await fixture(async (db, read) => {
    assert.deepEqual(
      verify(await read()).actions.map((item) => item.action),
      ['create', 'create'],
    );
    for (let position = 0; position < names.length; position++) {
      await db.exec(recoveryIndexSql(names[position], 'create').replace(' CONCURRENTLY', ''));
      assert.deepEqual(
        verify(await read()).actions.map((item) => item.action),
        names.map((_name, index) => (index <= position ? 'ready' : 'create')),
      );
    }
    for (const name of names) await db.exec(`DROP INDEX ${name}`);
    await db.exec(migration.replaceAll('CREATE INDEX CONCURRENTLY', 'CREATE INDEX'));
    assert.deepEqual(
      verify(await read()).actions.map((item) => item.action),
      ['ready', 'ready'],
    );
    await db.exec(`INSERT INTO publisher_entity_bindings
      (publisher_bot_id, chat_id, status, bot_access_expires_at, roster_checked_at, roster_refresh_after)
      VALUES ('private-bot-sentinel', 'private-chat-sentinel', 'private-status-sentinel',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    assert.equal(JSON.stringify(await read()).includes('private-'), false);
  });
});

test('actual catalog rejects foreign tables, key order, expression, predicate and operator drift', async () => {
  await fixture(async (db, read) => {
    await db.exec(`CREATE TABLE unrelated (
      publisher_bot_id text, chat_id text, status text, bot_access_expires_at timestamp(3),
      roster_refresh_after timestamp(3))`);
    for (const name of names) {
      const columns = indexes[name];
      const base = columns.join(', ');
      for (const definition of [
        `ON unrelated (${base})`,
        `ON publisher_entity_bindings (publisher_bot_id DESC, ${columns.slice(1).join(', ')})`,
        `ON publisher_entity_bindings (publisher_bot_id text_pattern_ops, ${columns.slice(1).join(', ')})`,
        `ON publisher_entity_bindings (publisher_bot_id COLLATE "C", ${columns.slice(1).join(', ')})`,
        `ON publisher_entity_bindings (lower(publisher_bot_id), ${columns.slice(1).join(', ')})`,
        `ON publisher_entity_bindings (${[...columns].reverse().join(', ')})`,
        `ON publisher_entity_bindings (${base}) WHERE status IS NOT NULL`,
        `ON publisher_entity_bindings (${base}) INCLUDE (roster_checked_at)`,
      ]) {
        await db.exec(`CREATE INDEX ${name} ${definition}`);
        await assert.rejects(async () => verify(await read()), definition);
        await db.exec(`DROP INDEX ${name}`);
      }
      await db.exec(`CREATE TABLE ${name} (id text)`);
      await assert.rejects(async () => verify(await read()));
      await db.exec(`DROP TABLE ${name}`);
      for (const suffix of ['_ccnew', '_ccold']) {
        await db.exec(`CREATE INDEX ${name}${suffix} ON publisher_entity_bindings (chat_id)`);
        await assert.rejects(async () => verify(await read()));
        await db.exec(`DROP INDEX ${name}${suffix}`);
      }
    }
  });
});

test('actual additive column catalog rejects wrong type, precision, default and nullability', async () => {
  await fixture(async (db, read) => {
    for (const [column, correctType, wrongTypes] of [
      [
        'roster_checked_at',
        'timestamp(3)',
        ['timestamp(6)', 'timestamp(3) with time zone', 'text'],
      ],
      [
        'roster_refresh_after',
        'timestamp(3)',
        ['timestamp(6)', 'timestamp(3) with time zone', 'text'],
      ],
    ]) {
      for (const wrongType of wrongTypes) {
        await db.exec(`ALTER TABLE publisher_entity_bindings DROP COLUMN ${column}`);
        await db.exec(`ALTER TABLE publisher_entity_bindings ADD COLUMN ${column} ${wrongType}`);
        await assert.rejects(async () => verify(await read()));
      }
      await db.exec(`ALTER TABLE publisher_entity_bindings DROP COLUMN ${column}`);
      await assert.rejects(async () => verify(await read()));
      await db.exec(`ALTER TABLE publisher_entity_bindings ADD COLUMN ${column} ${correctType}`);
      const defaultValue = 'CURRENT_TIMESTAMP';
      await db.exec(
        `ALTER TABLE publisher_entity_bindings ALTER COLUMN ${column} SET DEFAULT ${defaultValue}`,
      );
      await assert.rejects(async () => verify(await read()));
      await db.exec(`ALTER TABLE publisher_entity_bindings ALTER COLUMN ${column} DROP DEFAULT`);
      await db.exec(`ALTER TABLE publisher_entity_bindings ALTER COLUMN ${column} SET NOT NULL`);
      await assert.rejects(async () => verify(await read()));
      await db.exec(`ALTER TABLE publisher_entity_bindings ALTER COLUMN ${column} DROP NOT NULL`);
      verify(await read());
    }
    await db.exec(`ALTER TABLE publisher_entity_bindings DROP COLUMN roster_checked_at;
      ALTER TABLE publisher_entity_bindings ADD COLUMN roster_checked_at timestamp(3)
        GENERATED ALWAYS AS (bot_access_expires_at) STORED`);
    await assert.rejects(async () => verify(await read()));
  });
});

test('failed migration receipt rejects missing, duplicate, foreign failure and oversized logs', async () => {
  await fixture(async (db, read) => {
    await assert.rejects(async () =>
      verifyRecoveryState(await read(), '0'.repeat(64), additiveChecksum),
    );
    await db.query('UPDATE _prisma_migrations SET logs = $1 WHERE migration_name = $2', [
      'x'.repeat(65537) + '55P03',
      MIGRATION,
    ]);
    const oversized = await read();
    assert.equal(oversized.metadata.records[0].failure, 'oversized');
    assert.equal(JSON.stringify(oversized).includes('xxxx'), false);
    assert.throws(() => verify(oversized));
    for (const failure of ['42P01 missing relation', '57014 statement timeout', '']) {
      await db.query('UPDATE _prisma_migrations SET logs = $1 WHERE migration_name = $2', [
        failure,
        MIGRATION,
      ]);
      await assert.rejects(async () => verify(await read()));
    }
    await db.query(
      'UPDATE _prisma_migrations SET logs = $1, applied_steps_count = 1 WHERE migration_name = $2',
      ['55P03', MIGRATION],
    );
    await assert.rejects(async () => verify(await read()));
    await db.query(
      'UPDATE _prisma_migrations SET applied_steps_count = 0 WHERE migration_name = $1',
      [MIGRATION],
    );
    await db.query('INSERT INTO _prisma_migrations VALUES ($1, $2, $3, NULL, NULL, 0, $4)', [
      'another-failure',
      checksum,
      'another_migration',
      '55P03',
    ]);
    await assert.rejects(async () => verify(await read()));
    await db.query('UPDATE _prisma_migrations SET migration_name = $1 WHERE id = $2', [
      MIGRATION,
      'another-failure',
    ]);
    await assert.rejects(async () => verify(await read()));
    await db.query('DELETE FROM _prisma_migrations WHERE migration_name = $1', [MIGRATION]);
    await assert.rejects(async () => verify(await read()));
  });
});

test('recovery requires one complete checksum-matching additive prerequisite receipt', async () => {
  await fixture(async (db, read) => {
    await assert.rejects(async () => verifyRecoveryState(await read(), checksum, '0'.repeat(64)));
    await db.query('UPDATE _prisma_migrations SET checksum = $1 WHERE migration_name = $2', [
      '0'.repeat(64),
      ADDITIVE_MIGRATION,
    ]);
    await assert.rejects(async () => verify(await read()));
    await db.query(
      'UPDATE _prisma_migrations SET checksum = $1, finished_at = NULL WHERE migration_name = $2',
      [additiveChecksum, ADDITIVE_MIGRATION],
    );
    await assert.rejects(async () => verify(await read()));
    await db.query(
      'UPDATE _prisma_migrations SET finished_at = CURRENT_TIMESTAMP WHERE migration_name = $1',
      [ADDITIVE_MIGRATION],
    );
    await db.query(
      'UPDATE _prisma_migrations SET applied_steps_count = 0 WHERE migration_name = $1',
      [ADDITIVE_MIGRATION],
    );
    await assert.rejects(async () => verify(await read()));
    await db.query(
      'UPDATE _prisma_migrations SET applied_steps_count = 1 WHERE migration_name = $1',
      [ADDITIVE_MIGRATION],
    );
    await db.query(
      'INSERT INTO _prisma_migrations VALUES ($1, $2, $3, CURRENT_TIMESTAMP, NULL, 1, NULL)',
      ['duplicate-additive-receipt', additiveChecksum, ADDITIVE_MIGRATION],
    );
    await assert.rejects(async () => verify(await read()));
    await db.query('DELETE FROM _prisma_migrations WHERE id = $1', ['duplicate-additive-receipt']);
    await db.query(
      'UPDATE _prisma_migrations SET rolled_back_at = CURRENT_TIMESTAMP WHERE migration_name = $1',
      [ADDITIVE_MIGRATION],
    );
    await assert.rejects(async () => verify(await read()));
    await db.query('DELETE FROM _prisma_migrations WHERE migration_name = $1', [
      ADDITIVE_MIGRATION,
    ]);
    await assert.rejects(async () => verify(await read()));
  });
});

test('bounded catalog and malformed index states fail closed; exact invalid indexes can reindex', async () => {
  await fixture(async (db, read) => {
    await createIndexes(db);
    const report = await read();
    for (const change of [
      { migration: ADDITIVE_MIGRATION },
      { table_bytes: 512 * 1024 * 1024 + 1 },
      { table_bytes: Number.MAX_SAFE_INTEGER },
      { table_bytes: null },
      { parent_kind: 'p' },
      { metadata: null },
      { repair_artifacts: true },
      { columns: [] },
      { indexes: [] },
      { indexes: [report.indexes[0], report.indexes[0]] },
    ])
      assert.throws(() => verify({ ...report, ...change }));
    verify({ ...report, table_bytes: 512 * 1024 * 1024 });
    for (const change of [
      { type: 'timestamp without time zone' },
      { not_null: true },
      { default: "'unexpected'::text" },
      { identity: 'a' },
      { generated: 's' },
      { default_collation: false },
    ])
      assert.throws(() =>
        verify({
          ...report,
          columns: [{ ...report.columns[0], ...change }, report.columns[1]],
        }),
      );
    for (const change of [
      { ready: false },
      { live: false },
      { unique: true },
      { primary: true },
      { exclusion: true },
      { method: 'hash' },
      { parent_matches: false },
      { default_key_options: false },
      { attributes: 5 },
      { keys: 2 },
      { valid: null },
    ])
      assert.throws(() =>
        verify({
          ...report,
          indexes: [{ ...report.indexes[0], ...change }, ...report.indexes.slice(1)],
        }),
      );
    for (const ready of [true, false]) {
      const invalid = structuredClone(report);
      Object.assign(invalid.indexes[0], { valid: false, ready });
      assert.equal(verify(invalid).actions[0].action, 'reindex');
    }
    const drift = structuredClone(report);
    drift.metadata.records[0].finished = true;
    drift.indexes[0].valid = false;
    assert.throws(() => verify(drift));
    for (const change of [
      { other_failed: true },
      { rolled_back_count: -1 },
      { rolled_back_count: 0.5 },
      { records: [] },
      { prerequisite: [] },
    ])
      assert.throws(() => verify({ ...report, metadata: { ...report.metadata, ...change } }));
  });
});

function operationsFor(report, completeIndexes) {
  const calls = [];
  const operations = {
    checksum,
    additiveChecksum,
    read: async () => structuredClone(report),
    assertHealthy: async () => {
      calls.push('health');
    },
    repair: async (name, action) => {
      calls.push(`${action}:${name}`);
      Object.assign(
        report.indexes.find((item) => item.name === name),
        structuredClone(completeIndexes.find((item) => item.name === name)),
      );
    },
    resolve: async () => {
      calls.push('resolve');
      report.metadata.rolled_back_count++;
      Object.assign(report.metadata.records[0], {
        id: 'applied-receipt',
        finished: true,
        failure: 'other',
      });
    },
  };
  return { operations, calls };
}

test('preview is inert; apply repairs partial DDL and verifies receipt; applied rerun is inert', async () => {
  await fixture(async (db, read) => {
    const completeIndexes = await readyIndexCatalog(db, read);
    await db.exec(recoveryIndexSql(names[0], 'create').replace(' CONCURRENTLY', ''));
    const report = await read();
    report.indexes[0].valid = false;
    const { operations, calls } = operationsFor(report, completeIndexes);
    assert.equal((await recoverPublisherAccess(operations, false)).applied, false);
    assert.deepEqual(calls, []);
    assert.equal((await recoverPublisherAccess(operations, true)).applied, true);
    assert.deepEqual(calls, [
      'health',
      `reindex:${names[0]}`,
      'health',
      `create:${names[1]}`,
      'health',
      'resolve',
    ]);
    calls.length = 0;
    assert.equal((await recoverPublisherAccess(operations, true)).applied, false);
    assert.deepEqual(calls, []);
  });
});

test('failed health, repair, postcondition and concurrent receipt/catalog drift block resolution', async () => {
  await fixture(async (db, read) => {
    const completeIndexes = await readyIndexCatalog(db, read);
    for (const failAt of [
      'health',
      'repair',
      'postcondition',
      'record-change',
      'prerequisite-change',
      'index-change',
      'receipt',
    ]) {
      const report = await read();
      const { operations, calls } = operationsFor(report, completeIndexes);
      if (failAt === 'health')
        operations.assertHealthy = async () => {
          throw new Error('unhealthy');
        };
      if (failAt === 'repair')
        operations.repair = async () => {
          throw new Error('55P03');
        };
      if (failAt === 'postcondition') operations.repair = async () => {};
      if (failAt === 'record-change')
        operations.assertHealthy = async () => {
          report.metadata.records[0].id = 'changed';
        };
      if (failAt === 'prerequisite-change')
        operations.assertHealthy = async () => {
          report.metadata.prerequisite[0].id = 'changed';
        };
      if (failAt === 'index-change')
        operations.assertHealthy = async () => {
          Object.assign(report.indexes[0], structuredClone(completeIndexes[0]));
        };
      if (failAt === 'receipt')
        operations.resolve = async () => {
          calls.push('resolve');
        };
      await assert.rejects(() => recoverPublisherAccess(operations, true), failAt);
      assert.equal(calls.includes('resolve'), failAt === 'receipt', failAt);
    }
  });
});

test('complete index DDL with the exact failed receipt resolves without unnecessary repairs', async () => {
  await fixture(async (db, read) => {
    await createIndexes(db);
    const report = await read();
    const { operations, calls } = operationsFor(report, report.indexes);
    assert.equal((await recoverPublisherAccess(operations, true)).applied, true);
    assert.deepEqual(calls, ['health', 'health', 'health', 'resolve']);
  });
});

test('only the fixed concurrent Publisher access index repairs are exposed', () => {
  for (const name of names) {
    assert.match(recoveryIndexSql(name, 'create'), /^CREATE INDEX CONCURRENTLY /u);
    assert.equal(recoveryIndexSql(name, 'reindex'), `REINDEX INDEX CONCURRENTLY public.${name};`);
  }
  assert.throws(() => recoveryIndexSql('arbitrary', 'create'));
  assert.throws(() => recoveryIndexSql(names[0], 'drop'));
});

test('the actual resolver command marks only the verified index migration with immutable mounted SQL', () => {
  const compose = [
    'compose',
    '--env-file',
    '.env',
    '-p',
    'infra',
    '-f',
    'infra/docker-compose.yml',
  ];
  const appName = 'maxim-pub-access-recovery-1-2-3';
  const rootDir = '/reviewed/repository';
  const args = publisherAccessResolveCommandArgs(compose, appName, rootDir);
  assert.deepEqual(args.slice(0, compose.length), compose);
  const prisma = args.indexOf('./node_modules/.bin/prisma');
  assert.ok(prisma >= 0);
  assert.deepEqual(args.slice(prisma + 1), [
    'migrate',
    'resolve',
    '--applied',
    MIGRATION,
    '--config',
    'apps/api/prisma.config.ts',
  ]);
  assert.equal(args.includes(ADDITIVE_MIGRATION), false);
  assert.equal(args[args.indexOf('--pull') + 1], 'never');
  assert.ok(args.includes('--no-deps'));
  assert.equal(
    args[args.indexOf('--volume') + 1],
    `${rootDir}/apps/api/prisma/migrations:/app/apps/api/prisma/migrations:ro`,
  );
  assert.equal(args[args.indexOf('--name') + 1], appName);
});

test('the recovery CLI uses the shared lock, absolute deadline and exact-backend cleanup', () => {
  const wrapper = readFileSync('infra/scripts/vps-recover-publisher-access-migration.sh', 'utf8');
  assert.match(wrapper, /acquire_deploy_lock/u);
  assert.match(wrapper, /timeout --kill-after=5s 600s node/u);
  assert.match(wrapper, /WHERE application_name = '\$MAXIM_PUBLISHER_ACCESS_RECOVERY_APP_NAME'/u);
  assert.match(wrapper, /trap cleanup EXIT/u);
  const helper = readFileSync('infra/scripts/publisher-access-migration-recovery.mjs', 'utf8');
  assert.match(helper, /process\.env\.MAXIM_EXPECTED_DEPLOY_SHA !== sha/u);
  assert.match(helper, /command\('git', \['diff', '--quiet', 'HEAD'/u);
  assert.match(helper, /default_transaction_read_only=\$\{mutate \? 'off' : 'on'\}/u);
  assert.match(
    helper,
    /command\(\s*'docker',\s*publisherAccessResolveCommandArgs\(compose,\s*appName,\s*process\.cwd\(\)\)/u,
  );
  const connector = readFileSync('infra/scripts/vps-connect.sh', 'utf8');
  const start = connector.indexOf('recover_publisher_access_migration()');
  assert.ok(start >= 0);
  const entry = connector.slice(start, connector.indexOf('\n}', start) + 2);
  assert.match(entry, /assert-green\.mjs/u);
  assert.match(entry, /MAXIM_EXPECTED_DEPLOY_SHA=\$target_sha/u);
});
