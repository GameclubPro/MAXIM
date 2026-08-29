import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  findPrismaMigrationViolations,
  IMMUTABLE_PRISMA_POLICY_PREFIX,
} from './check-prisma-migrations.mjs';

const futureMigrationPrefix = '20260719000000';

function write(root, path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function digest(names) {
  return createHash('sha256')
    .update(`${names.join('\n')}\n`)
    .digest('hex');
}

function digestContents(root, names) {
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name);
    hash.update('\0');
    hash.update(readFileSync(join(root, `apps/api/prisma/migrations/${name}/migration.sql`)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'maxim-prisma-guard-'));
  const baseline = IMMUTABLE_PRISMA_POLICY_PREFIX.rulesAfter;
  write(
    root,
    `apps/api/prisma/migrations/${baseline}/migration.sql`,
    'CREATE TABLE "Example" ("id" TEXT PRIMARY KEY);\n',
  );
  writePolicy(root, [baseline], baseline);
  return {
    root,
    immutablePolicyPrefix: {
      rulesAfter: baseline,
      namesSha256: digest([baseline]),
      contentsSha256: digestContents(root, [baseline]),
    },
  };
}

function writePolicy(root, names, policyRulesAfter, approvedDestructive = {}) {
  write(
    root,
    'config/prisma-migration-policy.json',
    JSON.stringify({
      schemaVersion: 1,
      policyRulesAfter,
      baselineThrough: names.at(-1),
      baselineNamesSha256: digest(names),
      baselineContentsSha256: digestContents(root, names),
      approvedDestructive,
      nonConcurrentIndexExceptions: {},
    }),
  );
}

test('accepts an immutable baseline and concurrent future indexes', () => {
  const { root, immutablePolicyPrefix } = fixture();
  write(
    root,
    `apps/api/prisma/migrations/${futureMigrationPrefix}_add_lookup/migration.sql`,
    'CREATE INDEX CONCURRENTLY "Example_lookup_idx" ON "Example"("id");\n',
  );
  writePolicy(
    root,
    [immutablePolicyPrefix.rulesAfter, `${futureMigrationPrefix}_add_lookup`],
    immutablePolicyPrefix.rulesAfter,
  );
  assert.deepEqual(findPrismaMigrationViolations(root, immutablePolicyPrefix), []);
});

test('accepts an isolated concurrent index drop', () => {
  const { root, immutablePolicyPrefix } = fixture();
  const migration = `${futureMigrationPrefix}_drop_lookup`;
  write(
    root,
    `apps/api/prisma/migrations/${migration}/migration.sql`,
    'DROP INDEX CONCURRENTLY IF EXISTS "Example_lookup_idx";\n',
  );
  writePolicy(root, [immutablePolicyPrefix.rulesAfter, migration], immutablePolicyPrefix.rulesAfter);

  assert.deepEqual(findPrismaMigrationViolations(root, immutablePolicyPrefix), []);
});

test('rejects a concurrent index drop combined with another statement', () => {
  const { root, immutablePolicyPrefix } = fixture();
  const migration = `${futureMigrationPrefix}_drop_lookup_and_tune`;
  write(
    root,
    `apps/api/prisma/migrations/${migration}/migration.sql`,
    [
      'DROP INDEX CONCURRENTLY IF EXISTS "Example_lookup_idx";',
      'ALTER TABLE "Example" SET (autovacuum_vacuum_scale_factor = 0.05);',
      '',
    ].join('\n'),
  );
  writePolicy(root, [immutablePolicyPrefix.rulesAfter, migration], immutablePolicyPrefix.rulesAfter);

  assert.match(
    findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n'),
    /combines DROP INDEX CONCURRENTLY with another statement/u,
  );
});

test('rejects edits to immutable migration SQL', () => {
  const { root, immutablePolicyPrefix } = fixture();
  write(
    root,
    `apps/api/prisma/migrations/${immutablePolicyPrefix.rulesAfter}/migration.sql`,
    'CREATE TABLE "Example" ("id" TEXT PRIMARY KEY, "changed" TEXT);\n',
  );

  assert.match(
    findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n'),
    /Historical Prisma migration SQL changed/u,
  );
});

test('rejects empty, backdated, and non-concurrent future migrations', () => {
  const { root, immutablePolicyPrefix } = fixture();
  write(root, 'apps/api/prisma/migrations/20250101000000_backdated/migration.sql', '');
  write(
    root,
    `apps/api/prisma/migrations/${futureMigrationPrefix}_add_lookup/migration.sql`,
    'CREATE INDEX "Example_lookup_idx" ON "Example"("id");\n',
  );
  const messages = findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n');
  assert.match(messages, /missing a non-empty migration/u);
  assert.match(messages, /Historical Prisma migration names changed/u);
  assert.match(messages, /without CONCURRENTLY/u);
});

test('requires two-phase evidence for a new column drop', () => {
  const { root, immutablePolicyPrefix } = fixture();
  write(
    root,
    `apps/api/prisma/migrations/${futureMigrationPrefix}_drop_old/migration.sql`,
    'ALTER TABLE "Example" DROP COLUMN "old";\n',
  );
  const messages = findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n');
  assert.match(messages, /without an approved policy record/u);
  assert.match(messages, /without two-phase release compatibility evidence/u);
});

test('requires two-phase evidence for a row deletion', () => {
  const { root, immutablePolicyPrefix } = fixture();
  const migration = `${futureMigrationPrefix}_delete_retired_rows`;
  write(
    root,
    `apps/api/prisma/migrations/${migration}/migration.sql`,
    `DELETE FROM "Example" WHERE "owner" = 'RETIRED';\n`,
  );

  const unapprovedMessages = findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n');
  assert.match(unapprovedMessages, /contains destructive SQL without an approved policy record/u);

  writePolicy(
    root,
    [immutablePolicyPrefix.rulesAfter, migration],
    immutablePolicyPrefix.rulesAfter,
    {
      [migration]: { reason: 'Remove retired rows after the compatible runtime release.' },
    },
  );
  const reasonOnlyMessages = findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n');
  assert.doesNotMatch(reasonOnlyMessages, /without an approved policy record/u);
  assert.match(
    reasonOnlyMessages,
    /deletes rows without two-phase release compatibility evidence/u,
  );

  writePolicy(
    root,
    [immutablePolicyPrefix.rulesAfter, migration],
    immutablePolicyPrefix.rulesAfter,
    {
      [migration]: {
        reason: 'Remove retired rows after the compatible runtime release.',
        twoPhaseRelease: true,
        runtimeCompatibilityEvidence: 'Compatible runtime release was deployed first.',
      },
    },
  );
  assert.deepEqual(findPrismaMigrationViolations(root, immutablePolicyPrefix), []);
});

test('recognizes optional COLUMN and TABLE keywords in PostgreSQL destructive grammar', () => {
  const { root, immutablePolicyPrefix } = fixture();
  write(
    root,
    `apps/api/prisma/migrations/${futureMigrationPrefix}_optional_keywords/migration.sql`,
    ['ALTER TABLE "Example" DROP IF EXISTS "old";', 'TRUNCATE ONLY "Example";', ''].join('\n'),
  );

  const messages = findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n');
  assert.match(messages, /contains destructive SQL without an approved policy record/u);
  assert.match(messages, /without two-phase release compatibility evidence/u);
});

test('recognizes column drops on PostgreSQL foreign tables', () => {
  const { root, immutablePolicyPrefix } = fixture();
  write(
    root,
    `apps/api/prisma/migrations/${futureMigrationPrefix}_foreign_table_drop/migration.sql`,
    'ALTER FOREIGN TABLE "ExternalExample" DROP "old";\n',
  );

  const messages = findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n');
  assert.match(messages, /contains destructive SQL without an approved policy record/u);
  assert.match(messages, /without two-phase release compatibility evidence/u);
});

test('treats PostgreSQL comments as token separators in guarded statements', () => {
  const { root, immutablePolicyPrefix } = fixture();
  const migration = `${futureMigrationPrefix}_comment_separators`;
  write(
    root,
    `apps/api/prisma/migrations/${migration}/migration.sql`,
    [
      'ALTER TABLE "Example" DROP/**/COLUMN "old";',
      'CREATE/* outer /* nested */ comment */INDEX "Example_old_idx" ON "Example"("old");',
      '',
    ].join('\n'),
  );

  const messages = findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n');
  assert.match(messages, /contains destructive SQL without an approved policy record/u);
  assert.match(messages, /without two-phase release compatibility evidence/u);
  assert.match(messages, /without CONCURRENTLY/u);
});

test('does not let comment markers inside SQL literals hide guarded statements', () => {
  const { root, immutablePolicyPrefix } = fixture();
  const migration = `${futureMigrationPrefix}_literal_comment_markers`;
  write(
    root,
    `apps/api/prisma/migrations/${migration}/migration.sql`,
    [
      "SELECT '/*', E'--\\\\n', \"*/\", $tag$/* nested */$tag$;",
      'ALTER TABLE "Example" DROP-- keep the newline as a token boundary',
      'COLUMN "old";',
      '',
    ].join('\n'),
  );

  const messages = findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n');
  assert.match(messages, /contains destructive SQL without an approved policy record/u);
  assert.match(messages, /without two-phase release compatibility evidence/u);
});

test('ignores guarded keywords that exist only in SQL comments', () => {
  const { root, immutablePolicyPrefix } = fixture();
  const migration = `${futureMigrationPrefix}_comment_only_keywords`;
  write(
    root,
    `apps/api/prisma/migrations/${migration}/migration.sql`,
    [
      '/* DROP COLUMN and CREATE INDEX are review notes, not statements. */',
      '-- TRUNCATE TABLE "Example";',
      'CREATE INDEX CONCURRENTLY "Example_lookup_idx" ON "Example"("id");',
      '',
    ].join('\n'),
  );
  writePolicy(
    root,
    [immutablePolicyPrefix.rulesAfter, migration],
    immutablePolicyPrefix.rulesAfter,
  );

  assert.deepEqual(findPrismaMigrationViolations(root, immutablePolicyPrefix), []);
});

test('matches complete SQL tokens instead of keyword fragments in identifiers and strings', () => {
  const { root, immutablePolicyPrefix } = fixture();
  const migration = `${futureMigrationPrefix}_token_boundaries`;
  write(
    root,
    `apps/api/prisma/migrations/${migration}/migration.sql`,
    [
      'SELECT create$index, drop$column, truncate$table, "DROP COLUMN";',
      "SELECT 'DROP TABLE', 'CREATE INDEX';",
      'SELECT $$DROP TABLE "Example"; CREATE INDEX "bad" ON "Example"("id");$$;',
      'CREATE INDEX CONCURRENTLY "Example_lookup_idx" ON "Example"("id");',
      '',
    ].join('\n'),
  );
  writePolicy(
    root,
    [immutablePolicyPrefix.rulesAfter, migration],
    immutablePolicyPrefix.rulesAfter,
  );

  assert.deepEqual(findPrismaMigrationViolations(root, immutablePolicyPrefix), []);
});

test('scans ordinary and escape-string procedural bodies in statement context', () => {
  const { root, immutablePolicyPrefix } = fixture();
  write(
    root,
    `apps/api/prisma/migrations/${futureMigrationPrefix}_quoted_bodies/migration.sql`,
    [
      `DO 'BEGIN TRUNCATE "Example"; END';`,
      `CREATE FUNCTION drop_old() RETURNS void AS E'BEGIN ALTER TABLE "Example" DROP "old"; END' LANGUAGE plpgsql;`,
      '',
    ].join('\n'),
  );

  const messages = findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n');
  assert.match(messages, /contains destructive SQL without an approved policy record/u);
  assert.match(messages, /without two-phase release compatibility evidence/u);
});

test('joins adjacent executable string constants before applying PostgreSQL grammar guards', () => {
  const { root, immutablePolicyPrefix } = fixture();
  write(
    root,
    `apps/api/prisma/migrations/${futureMigrationPrefix}_split_quoted_bodies/migration.sql`,
    [
      `DO 'BEGIN DR'`,
      `'OP TABLE "Example"; END';`,
      `CREATE FUNCTION drop_old() RETURNS void AS 'BEGIN ALTER TABLE "Example" DR'`,
      `'OP "old"; END' LANGUAGE plpgsql;`,
      `DO LANGUAGE plpgsql 'BEGIN TRUN'`,
      `'CATE "Example"; END';`,
      '',
    ].join('\n'),
  );

  const messages = findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n');
  assert.match(messages, /contains destructive SQL without an approved policy record/u);
  assert.match(messages, /without two-phase release compatibility evidence/u);
});

test('decodes PostgreSQL escape and Unicode executable bodies before policy analysis', () => {
  const { root, immutablePolicyPrefix } = fixture();
  write(
    root,
    `apps/api/prisma/migrations/${futureMigrationPrefix}_encoded_bodies/migration.sql`,
    [
      `DO E'BEGIN DR\\x4fP TABLE "Example"; END';`,
      `DO U&'BEGIN DR\\004fP TABLE "Example"; END';`,
      `CREATE FUNCTION drop_old() RETURNS void AS E'BEGIN ALTER TABLE "Example" DR\\x4fP "old"; END' LANGUAGE plpgsql;`,
      '',
    ].join('\n'),
  );

  const messages = findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n');
  assert.match(messages, /contains destructive SQL without an approved policy record/u);
  assert.match(messages, /without two-phase release compatibility evidence/u);
});

test('requires manual review for custom Unicode escapes in executable bodies', () => {
  const { root, immutablePolicyPrefix } = fixture();
  write(
    root,
    `apps/api/prisma/migrations/${futureMigrationPrefix}_custom_unicode_escape/migration.sql`,
    `DO U&'BEGIN DR!004fP TABLE "Example"; END' UESCAPE '!';\n`,
  );

  const messages = findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n');
  assert.match(
    messages,
    /contains executable SQL that requires a documented manual policy review/u,
  );
  assert.match(messages, /contains destructive SQL without an approved policy record/u);
  assert.match(messages, /without two-phase release compatibility evidence/u);
});

test('analyzes executable bodies beyond the former recursion cutoff', () => {
  const { root, immutablePolicyPrefix } = fixture();
  let sql = 'DROP TABLE "Example";';
  for (let depth = 8; depth >= 1; depth -= 1) {
    sql = [
      `CREATE FUNCTION nested_${depth}() RETURNS void AS $q${depth}$`,
      `BEGIN ${sql} END`,
      `$q${depth}$ LANGUAGE plpgsql;`,
    ].join('\n');
  }
  write(
    root,
    `apps/api/prisma/migrations/${futureMigrationPrefix}_deep_bodies/migration.sql`,
    `${sql}\n`,
  );

  assert.match(
    findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n'),
    /contains destructive SQL without an approved policy record/u,
  );
});

test('scans executable dollar-quoted bodies and fails closed on dynamic SQL', () => {
  const { root, immutablePolicyPrefix } = fixture();
  write(
    root,
    `apps/api/prisma/migrations/${futureMigrationPrefix}_procedural_sql/migration.sql`,
    [
      'DO $body$',
      'BEGIN',
      '  DROP TABLE "Example";',
      "  EXECUTE format('ALTER TABLE %I DROP %I', 'Example', 'old');",
      'END',
      '$body$;',
      '',
    ].join('\n'),
  );

  const messages = findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n');
  assert.match(messages, /contains destructive SQL without an approved policy record/u);
  assert.match(messages, /without two-phase release compatibility evidence/u);
  assert.match(
    messages,
    /contains executable SQL that requires a documented manual policy review/u,
  );
});

test('rejects moving the policy cutoff to hide a destructive migration', () => {
  const { root, immutablePolicyPrefix } = fixture();
  const destructiveMigration = `${futureMigrationPrefix}_drop_old`;
  write(
    root,
    `apps/api/prisma/migrations/${destructiveMigration}/migration.sql`,
    'ALTER TABLE "Example" DROP COLUMN "old";\n',
  );
  writePolicy(root, [immutablePolicyPrefix.rulesAfter, destructiveMigration], destructiveMigration);

  const messages = findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n');
  assert.match(messages, /policyRulesAfter must remain/u);
  assert.match(messages, /contains destructive SQL without an approved policy record/u);
  assert.match(messages, /without two-phase release compatibility evidence/u);
});

test('rejects a backdated migration even when the advancing baseline digests are recomputed', () => {
  const { root, immutablePolicyPrefix } = fixture();
  const backdatedMigration = '20260718180000_drop_old';
  write(
    root,
    `apps/api/prisma/migrations/${backdatedMigration}/migration.sql`,
    'ALTER TABLE "Example" DROP COLUMN "old";\n',
  );
  writePolicy(
    root,
    [backdatedMigration, immutablePolicyPrefix.rulesAfter],
    immutablePolicyPrefix.rulesAfter,
  );

  const messages = findPrismaMigrationViolations(root, immutablePolicyPrefix).join('\n');
  assert.match(messages, /bootstrap prefix names changed/u);
});
