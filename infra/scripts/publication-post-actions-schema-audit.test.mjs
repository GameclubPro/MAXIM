import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import test from 'node:test';
import { publicationPostActionsSchemaAuditSql as sql } from './publication-post-actions-schema-audit.mjs';

test('fixed schema probe reads only catalogs and distinguishes absent and partial DDL', async () => {
  const db = new PGlite();
  try {
    await db.exec(
      'CREATE TABLE publication_content_revisions (id text); CREATE TABLE managed_broadcast_deliveries (id text);',
    );
    let result = (await db.query(sql)).rows[0].json_build_object;
    assert.equal(result.parents_present, true);
    assert.deepEqual(result.enum_labels, []);
    assert.equal(result.columns.length, 11);
    assert(result.columns.every((c) => c.present === false));
    assert.equal(result.index, null);
    await db.exec(
      "ALTER TABLE publication_content_revisions ADD COLUMN post_publish jsonb NOT NULL DEFAULT '{}';",
    );
    result = (await db.query(sql)).rows[0].json_build_object;
    assert.equal(result.columns.filter((c) => c.present).length, 1);
    assert.equal(result.columns[0].type, 'jsonb');
    assert.equal(result.columns[0].not_null, true);
    assert(
      !/FROM\s+(?:public\.)?(?:managed_broadcast_deliveries|publication_content_revisions)\b/i.test(
        sql,
      ),
    );
  } finally {
    await db.close();
  }
});

test('schema probe CLI rejects arbitrary arguments', () => {
  const result = spawnSync(
    process.execPath,
    ['infra/scripts/publication-post-actions-schema-audit.mjs', 'other_table'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
});
