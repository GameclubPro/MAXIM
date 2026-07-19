import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const migrationNamePattern = /^\d{14}_[a-z0-9]+(?:_[a-z0-9]+)*$/u;
const destructivePattern = /\b(?:DROP\s+(?:COLUMN|TABLE|TYPE)|TRUNCATE\s+TABLE)\b/iu;
const dropColumnPattern = /\bDROP\s+COLUMN\b/iu;
const nonConcurrentIndexPattern = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)/giu;

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/--.*$/gmu, '');
}

function digestNames(names) {
  return createHash('sha256')
    .update(`${names.join('\n')}\n`)
    .digest('hex');
}

function digestMigrationContents(migrationsRoot, names) {
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name);
    hash.update('\0');
    hash.update(readFileSync(resolve(migrationsRoot, name, 'migration.sql')));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function findPrismaMigrationViolations(root) {
  const violations = [];
  const migrationsRoot = resolve(root, 'apps/api/prisma/migrations');
  const policy = JSON.parse(
    readFileSync(resolve(root, 'config/prisma-migration-policy.json'), 'utf8'),
  );
  const names = readdirSync(migrationsRoot)
    .filter((name) => statSync(resolve(migrationsRoot, name)).isDirectory())
    .sort();

  if (!migrationNamePattern.test(policy.policyRulesAfter ?? '')) {
    violations.push('Prisma migration policyRulesAfter is missing or invalid.');
  }
  if (!migrationNamePattern.test(policy.baselineThrough ?? '')) {
    violations.push('Prisma migration baselineThrough is missing or invalid.');
  }

  for (const name of names) {
    const migrationPath = resolve(migrationsRoot, name, 'migration.sql');
    if (!migrationNamePattern.test(name)) {
      violations.push(`Invalid Prisma migration directory name: ${name}`);
    }
    if (!existsSync(migrationPath) || statSync(migrationPath).size === 0) {
      violations.push(`Prisma migration is missing a non-empty migration.sql: ${name}`);
      continue;
    }

    const sql = stripSqlComments(readFileSync(migrationPath, 'utf8'));
    const isNewPolicyMigration = name > policy.policyRulesAfter;
    if (!isNewPolicyMigration) {
      continue;
    }

    if (
      nonConcurrentIndexPattern.test(sql) &&
      !policy.nonConcurrentIndexExceptions?.[name]?.reason?.trim()
    ) {
      violations.push(
        `${name} creates an index without CONCURRENTLY and has no documented policy exception.`,
      );
    }
    nonConcurrentIndexPattern.lastIndex = 0;

    if (destructivePattern.test(sql)) {
      const approval = policy.approvedDestructive?.[name];
      if (!approval?.reason?.trim()) {
        violations.push(`${name} contains destructive SQL without an approved policy record.`);
      }
      if (
        dropColumnPattern.test(sql) &&
        (!approval?.twoPhaseRelease || !approval?.runtimeCompatibilityEvidence?.trim())
      ) {
        violations.push(`${name} drops a column without two-phase release compatibility evidence.`);
      }
    }
  }

  const baselineNames = names.filter((name) => name <= policy.baselineThrough);
  if (names.at(-1) !== policy.baselineThrough) {
    violations.push(
      'Prisma migration baselineThrough must match the latest migration so every committed SQL file is immutable.',
    );
  }
  const baselineDigest = digestNames(baselineNames);
  if (baselineDigest !== policy.baselineNamesSha256) {
    violations.push(
      'Historical Prisma migration names changed. Restore the baseline instead of editing or backdating migrations.',
    );
  }
  const baselineContentsComplete = baselineNames.every((name) =>
    existsSync(resolve(migrationsRoot, name, 'migration.sql')),
  );
  const baselineContentsDigest = baselineContentsComplete
    ? digestMigrationContents(migrationsRoot, baselineNames)
    : null;
  if (baselineContentsDigest !== null && baselineContentsDigest !== policy.baselineContentsSha256) {
    violations.push(
      'Historical Prisma migration SQL changed. Restore the immutable migration contents instead of editing applied history.',
    );
  }

  for (const name of Object.keys(policy.approvedDestructive ?? {})) {
    const migrationPath = resolve(migrationsRoot, name, 'migration.sql');
    if (!existsSync(migrationPath)) {
      violations.push(`Destructive migration policy references a missing migration: ${name}`);
      continue;
    }
    if (!destructivePattern.test(stripSqlComments(readFileSync(migrationPath, 'utf8')))) {
      violations.push(`Destructive migration policy entry is stale: ${name}`);
    }
  }

  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '..');
  const violations = findPrismaMigrationViolations(root);
  for (const violation of violations) {
    console.error(violation);
  }
  if (violations.length > 0) {
    process.exitCode = 1;
  }
}
