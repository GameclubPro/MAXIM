import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { findPrismaMigrationViolations } from './check-prisma-migrations.mjs';

function write(root, path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function digest(names) {
  return createHash('sha256').update(`${names.join('\n')}\n`).digest('hex');
}

function digestContents(root, names) {
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name);
    hash.update('\0');
    hash.update(
      readFileSync(join(root, `apps/api/prisma/migrations/${name}/migration.sql`)),
    );
    hash.update('\0');
  }
  return hash.digest('hex');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'maxim-prisma-guard-'));
  const baseline = '20260101000000_init';
  write(
    root,
    `apps/api/prisma/migrations/${baseline}/migration.sql`,
    'CREATE TABLE "Example" ("id" TEXT PRIMARY KEY);\n',
  );
  writePolicy(root, [baseline], baseline);
  return root;
}

function writePolicy(root, names, policyRulesAfter) {
  write(
    root,
    'config/prisma-migration-policy.json',
    JSON.stringify({
      schemaVersion: 1,
      policyRulesAfter,
      baselineThrough: names.at(-1),
      baselineNamesSha256: digest(names),
      baselineContentsSha256: digestContents(root, names),
      approvedDestructive: {},
      nonConcurrentIndexExceptions: {},
    }),
  );
}

test('accepts an immutable baseline and concurrent future indexes', () => {
  const root = fixture();
  write(
    root,
    'apps/api/prisma/migrations/20260102000000_add_lookup/migration.sql',
    'CREATE INDEX CONCURRENTLY "Example_lookup_idx" ON "Example"("id");\n',
  );
  writePolicy(root, ['20260101000000_init', '20260102000000_add_lookup'], '20260101000000_init');
  assert.deepEqual(findPrismaMigrationViolations(root), []);
});

test('rejects edits to immutable migration SQL', () => {
  const root = fixture();
  write(
    root,
    'apps/api/prisma/migrations/20260101000000_init/migration.sql',
    'CREATE TABLE "Example" ("id" TEXT PRIMARY KEY, "changed" TEXT);\n',
  );

  assert.match(
    findPrismaMigrationViolations(root).join('\n'),
    /Historical Prisma migration SQL changed/u,
  );
});

test('rejects empty, backdated, and non-concurrent future migrations', () => {
  const root = fixture();
  write(root, 'apps/api/prisma/migrations/20250101000000_backdated/migration.sql', '');
  write(
    root,
    'apps/api/prisma/migrations/20260102000000_add_lookup/migration.sql',
    'CREATE INDEX "Example_lookup_idx" ON "Example"("id");\n',
  );
  const messages = findPrismaMigrationViolations(root).join('\n');
  assert.match(messages, /missing a non-empty migration/u);
  assert.match(messages, /Historical Prisma migration names changed/u);
  assert.match(messages, /without CONCURRENTLY/u);
});

test('requires two-phase evidence for a new column drop', () => {
  const root = fixture();
  write(
    root,
    'apps/api/prisma/migrations/20260102000000_drop_old/migration.sql',
    'ALTER TABLE "Example" DROP COLUMN "old";\n',
  );
  const messages = findPrismaMigrationViolations(root).join('\n');
  assert.match(messages, /without an approved policy record/u);
  assert.match(messages, /without two-phase release compatibility evidence/u);
});
