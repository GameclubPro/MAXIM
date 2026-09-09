import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import test from 'node:test';
import { publicationPostActionsSchemaAuditSql } from './publication-post-actions-schema-audit.mjs';
import {
  MIGRATION,
  recoverPublicationMigration,
  verifyPublicationRecoveryRecord,
  verifyPublicationRecoverySchema,
  publicationRecoveryReindexSql,
} from './publication-post-actions-migration-recovery.mjs';

async function schemaFixture() {
  const db = new PGlite();
  try {
    await db.exec(
      'CREATE TABLE publication_content_revisions(id text); CREATE TABLE managed_broadcast_deliveries(id text, dispatch_profile text, status text);',
    );
    const sql = readFileSync(
      `apps/api/prisma/migrations/${MIGRATION}/migration.sql`,
      'utf8',
    ).replace('CREATE INDEX CONCURRENTLY', 'CREATE INDEX');
    await db.exec(sql);
    return (await db.query(publicationPostActionsSchemaAuditSql)).rows[0].json_build_object;
  } finally {
    await db.close();
  }
}

test('recovery validates actual migrated catalog fields, not a text match of SQL', async () => {
  const schema = await schemaFixture();
  assert.equal(verifyPublicationRecoverySchema(schema), 'ready');
  schema.index.valid = false;
  assert.equal(verifyPublicationRecoverySchema(schema), 'reindex');
  for (const changed of [
    { ...schema, delivery_table_bytes: 513 * 1024 * 1024 },
    { ...schema, repair_artifacts: true },
    { ...schema, columns: [] },
    { ...schema, enum_labels: [] },
    { ...schema, index: null },
    { ...schema, index: { ...schema.index, unique: true } },
    { ...schema, index: { ...schema.index, columns: ['status', 'id'] } },
  ])
    assert.throws(() => verifyPublicationRecoverySchema(changed));
});

test('recovery refuses mismatched, duplicated or non-lock migration records', () => {
  const record = { checksum: 'a'.repeat(64), finished: false, lock_timeout: true };
  assert.equal(
    verifyPublicationRecoveryRecord({ oversized: false, records: [record] }, record.checksum),
    'failed',
  );
  assert.throws(() =>
    verifyPublicationRecoveryRecord({ oversized: false, records: [record] }, 'wrong'),
  );
  assert.throws(() =>
    verifyPublicationRecoveryRecord(
      { oversized: false, records: [record, record] },
      record.checksum,
    ),
  );
  assert.throws(() =>
    verifyPublicationRecoveryRecord({ oversized: true, records: [record] }, record.checksum),
  );
  assert.throws(() =>
    verifyPublicationRecoveryRecord(
      { oversized: false, records: [{ ...record, lock_timeout: false }] },
      record.checksum,
    ),
  );
});

test('preview never mutates; apply resolves only after verified reindex and checks its receipt', async () => {
  const schema = await schemaFixture();
  schema.index.valid = false;
  const calls = [];
  const record = { checksum: 'a'.repeat(64), finished: false, lock_timeout: true };
  const operations = {
    checksum: record.checksum,
    readSchema: async () => structuredClone(schema),
    readRecord: async () => ({ oversized: false, records: [structuredClone(record)] }),
    assertHealthy: async () => calls.push('health'),
    reindex: async () => {
      calls.push('reindex');
      schema.index.valid = true;
    },
    resolve: async () => {
      calls.push('resolve');
      record.finished = true;
    },
  };
  assert.equal((await recoverPublicationMigration(operations, false)).applied, false);
  assert.deepEqual(calls, []);
  assert.equal((await recoverPublicationMigration(operations, true)).applied, true);
  assert.deepEqual(calls, ['health', 'reindex', 'resolve']);
  assert.equal((await recoverPublicationMigration(operations, true)).applied, false);
  schema.index.valid = false;
  await assert.rejects(() => recoverPublicationMigration(operations, true));
  assert.match(
    publicationRecoveryReindexSql,
    /^REINDEX INDEX CONCURRENTLY public\.managed_broadcast_deliveries_post_actions_due_idx;$/u,
  );
});

test('failed reindex never resolves the migration', async () => {
  const schema = await schemaFixture();
  schema.index.valid = false;
  let resolved = false;
  await assert.rejects(() =>
    recoverPublicationMigration(
      {
        checksum: 'a'.repeat(64),
        readSchema: async () => schema,
        readRecord: async () => ({
          oversized: false,
          records: [{ checksum: 'a'.repeat(64), finished: false, lock_timeout: true }],
        }),
        assertHealthy: async () => {},
        reindex: async () => {
          throw new Error('timeout');
        },
        resolve: async () => {
          resolved = true;
        },
      },
      true,
    ),
  );
  assert.equal(resolved, false);
});
