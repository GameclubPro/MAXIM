import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { postgresStorageAuditSql } from './postgres-storage-audit.mjs';

test('storage inventory measures inaccessible application tables without reading their rows', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE storage_fixture (id integer PRIMARY KEY, payload text);
      INSERT INTO storage_fixture SELECT i, repeat(md5(i::text), 64) FROM generate_series(1, 2000) i;
      CREATE ROLE storage_auditor;
      GRANT pg_read_all_stats TO storage_auditor;
      SET ROLE storage_auditor;
    `);
    await assert.rejects(db.query('SELECT * FROM storage_fixture'), /permission denied/u);
    const result = await db.query(postgresStorageAuditSql);
    const report = result.rows[0].json_build_object;
    assert.equal(report.audit, 'postgres_storage');
    assert.equal(report.relations_measured, 1);
    assert.equal(report.indexes_measured, 1);
    assert.equal(report.relation_limit_exceeded, false);
    assert.equal(report.index_limit_exceeded, false);
    const relation = report.largest_relations[0];
    assert.equal(relation.table_name, 'storage_fixture');
    assert.ok(relation.total_bytes > 0);
    assert.equal(relation.total_bytes, relation.table_bytes + relation.indexes_bytes);
    assert.equal(report.public_total_bytes, relation.total_bytes);
    assert.equal(report.largest_indexes[0].index_name, 'storage_fixture_pkey');
    assert.equal(report.largest_indexes[0].unique_index, true);
    assert.equal(report.largest_indexes[0].valid, true);
    assert.doesNotMatch(JSON.stringify(report), /payload|c4ca4238/u);
    const plan = await db.query(`EXPLAIN (FORMAT JSON) ${postgresStorageAuditSql}`);
    assert.doesNotMatch(JSON.stringify(plan), /"Relation Name":"storage_fixture"/u);
  } finally {
    await db.close();
  }
});

test('storage report bounds output and refuses partial totals above its relation cap', async () => {
  const db = new PGlite();
  try {
    await db.exec(
      Array.from({ length: 33 }, (_, i) => `CREATE TABLE storage_${i} (id int);`).join('\n'),
    );
    let report = (await db.query(postgresStorageAuditSql)).rows[0].json_build_object;
    assert.equal(report.relations_measured, 33);
    assert.equal(report.largest_relations.length, 32);
    await db.exec(
      Array.from({ length: 480 }, (_, i) => `CREATE TABLE storage_${i + 33} (id int);`).join('\n'),
    );
    report = (await db.query(postgresStorageAuditSql)).rows[0].json_build_object;
    assert.equal(report.relation_limit_exceeded, true);
    assert.equal(report.relations_measured, 0);
    assert.equal(report.public_total_bytes, null);
    assert.deepEqual(report.largest_relations, []);
    assert.deepEqual(report.largest_indexes, []);
  } finally {
    await db.close();
  }
});

test('storage SQL generator rejects all caller input', () => {
  const result = spawnSync(
    process.execPath,
    [
      new URL('./postgres-storage-audit.mjs', import.meta.url).pathname,
      'SELECT * FROM webhook_events',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
});

test('equivalent index groups separate predicates, ordering and includes and identify constraints', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE storage_indexes (id int PRIMARY KEY, value int);
      CREATE INDEX storage_duplicate ON storage_indexes (id);
      CREATE INDEX storage_descending ON storage_indexes (id DESC);
      CREATE INDEX storage_partial ON storage_indexes (id) WHERE value > 0;
      CREATE INDEX storage_included ON storage_indexes (id) INCLUDE (value);
      CREATE ROLE storage_index_auditor;
      GRANT pg_read_all_stats TO storage_index_auditor;
      SET ROLE storage_index_auditor;
    `);
    const report = (await db.query(postgresStorageAuditSql)).rows[0].json_build_object;
    assert.equal(report.equivalent_index_groups.length, 1);
    assert.equal(report.equivalent_index_groups_limit_exceeded, false);
    const indexes = report.equivalent_index_groups[0].indexes;
    assert.deepEqual(
      indexes.map((index) => index.index_name),
      ['storage_duplicate', 'storage_indexes_pkey'],
    );
    assert.equal(indexes[0].constraint_backed, false);
    assert.equal(indexes[1].constraint_backed, true);
    assert.equal(indexes[1].unique_index, true);
  } finally {
    await db.close();
  }
});
