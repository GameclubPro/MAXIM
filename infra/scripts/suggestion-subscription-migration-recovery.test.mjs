import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import test from 'node:test';
import {
  MIGRATION,
  recoveryAuditSql,
  verifyRecoveryState,
  recoverSuggestionMigration,
} from './suggestion-subscription-migration-recovery.mjs';

const migrationSql = readFileSync(`apps/api/prisma/migrations/${MIGRATION}/migration.sql`, 'utf8');
const checksum = createHash('sha256').update(migrationSql).digest('hex');

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE channel_settings(chat_id text);
    CREATE TABLE publisher_entity_settings(chat_id text);
    CREATE TABLE managed_broadcast_deliveries(id text);
    CREATE TABLE moderation_delete_intents(id text);
    CREATE TABLE _prisma_migrations(id text, migration_name text, checksum text, finished_at timestamp, rolled_back_at timestamp, applied_steps_count integer, logs text);
  `);
  await db.query('INSERT INTO _prisma_migrations VALUES ($1,$2,$3,NULL,NULL,0,$4)', [
    'attempt-1',
    MIGRATION,
    checksum,
    'Database error code: 55P03 lock timeout',
  ]);
  const read = async () => (await db.query(recoveryAuditSql)).rows[0].json_build_object;
  return { db, read };
}

test('fixed audit verifies all absent DDL and the exact failed record in PostgreSQL', async () => {
  const { db, read } = await fixture();
  try {
    const report = await read();
    assert.equal(verifyRecoveryState(report, checksum), 'failed');
    assert.equal(report.columns_present, 0);
    assert.equal(report.relations_present, 0);
    assert.equal(report.types_present, 0);
    assert.equal(report.metadata.records[0].failure, 'lock_timeout');
    await db.exec(migrationSql);
    const applied = await read();
    assert.equal(applied.columns_present, 6);
    assert.equal(applied.relations_present, 8);
    assert.equal(applied.types_present, 2);
    assert.throws(() => verifyRecoveryState(applied, checksum), /partial schema/);
  } finally {
    await db.close();
  }
});

test('partial columns, stray indexes, conflicting types, and missing parents all stop recovery', async () => {
  const { db, read } = await fixture();
  try {
    for (const ddl of [
      'ALTER TABLE channel_settings ADD COLUMN post_suggestions_require_subscription boolean DEFAULT false',
      'CREATE TABLE suggestion_subscription_watches(id text)',
      'CREATE INDEX suggestion_subscription_watch_due_idx ON channel_settings(chat_id)',
      "CREATE TYPE suggestion_subscription_publications AS ENUM ('conflict')",
      'DROP TABLE moderation_delete_intents',
    ]) {
      await db.exec('BEGIN');
      await db.exec(ddl);
      const partial = await read();
      assert.throws(() => verifyRecoveryState(partial, checksum));
      await db.exec('ROLLBACK');
    }
  } finally {
    await db.close();
  }
});

test('metadata guard fails closed for duplicates, drift, prior application, and unknown failures', async () => {
  const { db, read } = await fixture();
  try {
    const report = await read();
    const record = report.metadata.records[0];
    for (const metadata of [
      null,
      { ...report.metadata, other_failed: true },
      { ...report.metadata, rolled_back_count: -1 },
      { ...report.metadata, records: [] },
      { ...report.metadata, records: [record, record] },
      ...[
        { checksum: 'wrong' },
        { finished: true },
        { failure: 'other' },
        { applied_steps_count: 1 },
        { id: '' },
      ].map((change) => ({ ...report.metadata, records: [{ ...record, ...change }] })),
    ])
      assert.throws(() => verifyRecoveryState({ ...report, metadata }, checksum));
    await db.query('INSERT INTO _prisma_migrations VALUES ($1,$2,$3,NULL,NULL,0,$4)', [
      'other',
      'other-migration',
      checksum,
      'lock timeout',
    ]);
    const otherFailure = await read();
    assert.throws(() => verifyRecoveryState(otherFailure, checksum));
  } finally {
    await db.close();
  }
});

test('preview never mutates; apply resets only the failed attempt and verifies the receipt', async () => {
  const { db, read } = await fixture();
  const calls = [];
  try {
    const operations = {
      checksum,
      read,
      assertHealthy: async () => {
        calls.push('health');
      },
      resolve: async () => {
        calls.push('resolve');
        await db.query(
          'UPDATE _prisma_migrations SET rolled_back_at = now() WHERE migration_name = $1 AND rolled_back_at IS NULL AND finished_at IS NULL',
          [MIGRATION],
        );
      },
    };
    assert.deepEqual(await recoverSuggestionMigration(operations, false), {
      state: 'failed',
      applied: false,
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(await recoverSuggestionMigration(operations, true), {
      state: 'retry-ready',
      applied: true,
    });
    assert.deepEqual(calls, ['health', 'resolve']);
    assert.deepEqual(await recoverSuggestionMigration(operations, true), {
      state: 'retry-ready',
      applied: false,
    });
    assert.deepEqual(calls, ['health', 'resolve']);
  } finally {
    await db.close();
  }
});

test('changed metadata, failed health, and missing rollback receipts cannot report success', async () => {
  const { db, read } = await fixture();
  try {
    const report = await read();
    let reads = 0;
    let writes = 0;
    const operations = {
      checksum,
      read: async () => ({
        ...report,
        metadata: { ...report.metadata, rolled_back_count: reads++ },
      }),
      assertHealthy: async () => {},
      resolve: async () => {
        writes++;
      },
    };
    await assert.rejects(() => recoverSuggestionMigration(operations, true), /changed/);
    assert.equal(writes, 0);
    operations.read = async () => structuredClone(report);
    operations.assertHealthy = async () => {
      throw new Error('not healthy');
    };
    await assert.rejects(() => recoverSuggestionMigration(operations, true), /not healthy/);
    assert.equal(writes, 0);
    operations.assertHealthy = async () => {};
    await assert.rejects(() => recoverSuggestionMigration(operations, true), /receipt/);
    assert.equal(writes, 1);
  } finally {
    await db.close();
  }
});

test('operator entry point is fixed, locked, bounded, identity checked, and exact-SHA CI gated', () => {
  const helper = readFileSync(
    'infra/scripts/suggestion-subscription-migration-recovery.mjs',
    'utf8',
  );
  const shell = readFileSync(
    'infra/scripts/vps-recover-suggestion-subscription-migration.sh',
    'utf8',
  );
  const wrapper = readFileSync('infra/scripts/vps-connect.sh', 'utf8');
  assert.match(helper, /'--rolled-back',\s*MIGRATION/);
  assert.doesNotMatch(helper, /'--applied'|DROP TABLE|DELETE FROM/);
  for (const invariant of [
    'MAXIM_EXPECTED_DEPLOY_SHA',
    'default_transaction_read_only=on',
    'statement_timeout=2500ms',
    'lock_timeout=250ms',
    'max_parallel_workers_per_gather=0',
    'com.maxim.release-protected',
    'org.opencontainers.image.revision',
    '/api/health/ready',
  ])
    assert.ok(helper.includes(invariant));
  for (const invariant of [
    'acquire_deploy_lock',
    'release_deploy_lock',
    'pg_terminate_backend',
    'trap cleanup EXIT',
    'timeout --kill-after=5s 120s',
    'com.maxim.suggestion-migration-recovery',
  ])
    assert.ok(shell.includes(invariant));
  const entry = wrapper.slice(
    wrapper.indexOf('recover_suggestion_subscription_migration()'),
    wrapper.indexOf('postgres_audit_provision()'),
  );
  assert.match(entry, /scripts\/ci\/assert-green\.mjs/);
  assert.match(entry, /MAXIM_EXPECTED_DEPLOY_SHA/);
});
