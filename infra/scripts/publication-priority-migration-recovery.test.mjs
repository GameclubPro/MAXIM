import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { recoverPublicationPriority } from './publication-priority-migration-recovery.mjs';
import {
  MIGRATION,
  indexes,
  recoveryAuditSql,
  recoveryIndexSql,
  verifyRecoveryState,
} from './publication-priority-recovery-schema.mjs';

const migration = readFileSync(`apps/api/prisma/migrations/${MIGRATION}/migration.sql`, 'utf8');
const checksum = createHash('sha256').update(migration).digest('hex');
const names = Object.keys(indexes);

async function fixture(run) {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE publication_occurrences (
      id text PRIMARY KEY, dispatch_profile text, status text, dispatch_blocker_code text,
      dispatch_blocked_at timestamp(3), scheduled_at timestamp(3));
      CREATE TABLE _prisma_migrations (id text PRIMARY KEY, checksum text, migration_name text,
        finished_at timestamp, rolled_back_at timestamp, applied_steps_count integer, logs text);`);
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

test('actual catalog distinguishes absent, partial and fully applied immutable DDL', async () => {
  await fixture(async (db, read) => {
    assert.deepEqual(
      verifyRecoveryState(await read(), checksum).actions.map((x) => x.action),
      ['create', 'create'],
    );
    await db.exec(recoveryIndexSql(names[0], 'create').replace(' CONCURRENTLY', ''));
    assert.deepEqual(
      verifyRecoveryState(await read(), checksum).actions.map((x) => x.action),
      ['ready', 'create'],
    );
    await db.exec(recoveryIndexSql(names[1], 'create').replace(' CONCURRENTLY', ''));
    assert.deepEqual(
      verifyRecoveryState(await read(), checksum).actions.map((x) => x.action),
      ['ready', 'ready'],
    );
    await db.exec(`DROP INDEX ${names[0]}; DROP INDEX ${names[1]};`);
    await db.exec(migration.replaceAll('CREATE INDEX CONCURRENTLY', 'CREATE INDEX'));
    assert.deepEqual(
      verifyRecoveryState(await read(), checksum).actions.map((x) => x.action),
      ['ready', 'ready'],
    );
  });
});

test('catalog refuses wrong table, sort order, expression, predicate, opclass and repair artifacts', async () => {
  await fixture(async (db, read) => {
    await db.exec(
      'CREATE TABLE unrelated (dispatch_profile text, status text, dispatch_blocker_code text, scheduled_at timestamp, id text)',
    );
    const base = indexes[names[0]].join(', ');
    for (const definition of [
      `ON unrelated (${base})`,
      `ON publication_occurrences (dispatch_profile DESC, status, dispatch_blocker_code, scheduled_at, id)`,
      `ON publication_occurrences (dispatch_profile text_pattern_ops, status, dispatch_blocker_code, scheduled_at, id)`,
      `ON publication_occurrences (dispatch_profile COLLATE "C", status, dispatch_blocker_code, scheduled_at, id)`,
      `ON publication_occurrences (lower(dispatch_profile), status, dispatch_blocker_code, scheduled_at, id)`,
      `ON publication_occurrences (${base}) WHERE status IS NOT NULL`,
      `ON publication_occurrences (${base}) INCLUDE (dispatch_blocked_at)`,
    ]) {
      await db.exec(`CREATE INDEX ${names[0]} ${definition}`);
      await assert.rejects(async () => verifyRecoveryState(await read(), checksum));
      await db.exec(`DROP INDEX ${names[0]}`);
    }
    await db.exec(`CREATE TABLE ${names[0]} (id text)`);
    await assert.rejects(async () => verifyRecoveryState(await read(), checksum));
    await db.exec(
      `DROP TABLE ${names[0]}; CREATE INDEX ${names[0]}_ccnew ON publication_occurrences (id)`,
    );
    await assert.rejects(async () => verifyRecoveryState(await read(), checksum));
  });
});

test('metadata rejects missing, duplicate, foreign failure and oversized logs without exposing logs', async () => {
  await fixture(async (db, read) => {
    await assert.rejects(async () => verifyRecoveryState(await read(), '0'.repeat(64)));
    await db.query('UPDATE _prisma_migrations SET logs = $1', ['x'.repeat(65537) + '55P03']);
    const report = await read();
    assert.equal(report.metadata.records[0].failure, 'oversized');
    assert.equal(JSON.stringify(report).includes('xxxx'), false);
    assert.throws(() => verifyRecoveryState(report, checksum));
    await db.exec("UPDATE _prisma_migrations SET logs = '55P03', applied_steps_count = 1");
    await assert.rejects(async () => verifyRecoveryState(await read(), checksum));
    await db.exec('UPDATE _prisma_migrations SET applied_steps_count = 0');
    await db.query('INSERT INTO _prisma_migrations VALUES ($1, $2, $3, NULL, NULL, 0, $4)', [
      'another',
      checksum,
      'another_migration',
      '55P03',
    ]);
    await assert.rejects(async () => verifyRecoveryState(await read(), checksum));
    await db.query('UPDATE _prisma_migrations SET migration_name = $1 WHERE id = $2', [
      MIGRATION,
      'another',
    ]);
    await assert.rejects(async () => verifyRecoveryState(await read(), checksum));
    await db.exec('DELETE FROM _prisma_migrations');
    await assert.rejects(async () => verifyRecoveryState(await read(), checksum));
  });
});

test('bounded scope and invalid index states fail closed', async () => {
  await fixture(async (db, read) => {
    await db.exec(migration.replaceAll('CREATE INDEX CONCURRENTLY', 'CREATE INDEX'));
    const report = await read();
    for (const change of [
      { table_bytes: 513 * 1024 * 1024 },
      { table_bytes: null },
      { parent_kind: 'p' },
      { metadata: null },
      { repair_artifacts: true },
      { indexes: [] },
    ])
      assert.throws(() => verifyRecoveryState({ ...report, ...change }, checksum));
    for (const change of [
      { ready: false },
      { live: false },
      { unique: true },
      { primary: true },
      { exclusion: true },
      { method: 'hash' },
      { parent_matches: false },
    ])
      assert.throws(() =>
        verifyRecoveryState(
          { ...report, indexes: [{ ...report.indexes[0], ...change }, report.indexes[1]] },
          checksum,
        ),
      );
    for (const ready of [true, false]) {
      report.indexes[0].valid = false;
      report.indexes[0].ready = ready;
      assert.equal(verifyRecoveryState(report, checksum).actions[0].action, 'reindex');
    }
    report.metadata.records[0].finished = true;
    assert.throws(() => verifyRecoveryState(report, checksum));
  });
});

function operationsFor(report) {
  const calls = [];
  const operations = {
    checksum,
    read: async () => structuredClone(report),
    assertHealthy: async () => {
      calls.push('health');
    },
    repair: async (name, action) => {
      calls.push(`${action}:${name}`);
      const index = report.indexes.find((item) => item.name === name);
      Object.assign(index, {
        present: true,
        kind: 'i',
        parent_matches: true,
        valid: true,
        ready: true,
        live: true,
        unique: false,
        primary: false,
        exclusion: false,
        method: 'btree',
        attributes: 5,
        keys: 5,
        predicate: null,
        expressions: null,
        columns: [...indexes[name]],
        default_key_options: true,
      });
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

test('preview never mutates; apply completes partial DDL then checks receipt; applied rerun is inert', async () => {
  await fixture(async (db, read) => {
    await db.exec(recoveryIndexSql(names[0], 'create').replace(' CONCURRENTLY', ''));
    const report = await read();
    report.indexes[0].valid = false;
    const { operations, calls } = operationsFor(report);
    assert.equal((await recoverPublicationPriority(operations, false)).applied, false);
    assert.deepEqual(calls, []);
    assert.equal((await recoverPublicationPriority(operations, true)).applied, true);
    assert.deepEqual(calls, [
      'health',
      `reindex:${names[0]}`,
      'health',
      `create:${names[1]}`,
      'health',
      'resolve',
    ]);
    calls.length = 0;
    assert.equal((await recoverPublicationPriority(operations, true)).applied, false);
    assert.deepEqual(calls, []);
  });
});

test('failed health, repair or postcondition never resolves; missing receipt never reports success', async () => {
  await fixture(async (_db, read) => {
    for (const failAt of ['health', 'repair', 'postcondition', 'record-change', 'receipt']) {
      const report = await read();
      const { operations, calls } = operationsFor(report);
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
      if (failAt === 'receipt')
        operations.resolve = async () => {
          calls.push('resolve');
        };
      await assert.rejects(() => recoverPublicationPriority(operations, true));
      assert.equal(calls.includes('resolve'), failAt === 'receipt');
    }
  });
});

test('only fixed concurrent DDL and locked exact-SHA CLI are exposed', () => {
  for (const name of names) {
    assert.match(recoveryIndexSql(name, 'create'), /^CREATE INDEX CONCURRENTLY /u);
    assert.equal(recoveryIndexSql(name, 'reindex'), `REINDEX INDEX CONCURRENTLY public.${name};`);
  }
  assert.throws(() => recoveryIndexSql('arbitrary', 'create'));
  assert.throws(() => recoveryIndexSql(names[0], 'drop'));
  const wrapper = readFileSync(
    'infra/scripts/vps-recover-publication-priority-migration.sh',
    'utf8',
  );
  assert.match(wrapper, /acquire_deploy_lock/u);
  assert.match(wrapper, /timeout --kill-after=5s 420s node/u);
  assert.match(
    wrapper,
    /WHERE application_name = '\$MAXIM_PUBLICATION_PRIORITY_RECOVERY_APP_NAME'/u,
  );
  const connector = readFileSync('infra/scripts/vps-connect.sh', 'utf8');
  const entry = connector.slice(
    connector.indexOf('recover_publication_priority_migration()'),
    connector.indexOf('recover_suggestion_subscription_migration()'),
  );
  assert.match(entry, /assert-green\.mjs/u);
  assert.match(entry, /MAXIM_EXPECTED_DEPLOY_SHA=\$target_sha/u);
});
