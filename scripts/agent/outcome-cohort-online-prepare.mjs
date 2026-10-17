#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMultibotPrepareEnvironment } from './multibot-online-prepare.mjs';
import {
  readOutcomeCohortSource,
  requireOutcomeCohortTarget,
} from './outcome-cohort-online-targets.mjs';
import {
  outcomeCohortStateSql,
  verifyOutcomeCohortPreparationState,
} from '../../infra/scripts/outcome-cohort-online-state.mjs';

export function createOutcomeCohortMigrationPrefix(root, selector) {
  const target = requireOutcomeCohortTarget(selector);
  const source = readOutcomeCohortSource(root);
  const migrationNames = source
    .filter(({ name }) => name <= target.migration)
    .map(({ name }) => name);
  const workspaceTemp = resolve(root, 'apps/api/.migration-prepare');
  mkdirSync(workspaceTemp, { recursive: true, mode: 0o700 });
  const tempRoot = mkdtempSync(resolve(workspaceTemp, 'outcome-'));
  try {
    const migrationsPath = resolve(tempRoot, 'migrations');
    mkdirSync(migrationsPath, { mode: 0o700 });
    const directory = resolve(root, 'apps/api/prisma/migrations');
    cpSync(
      resolve(directory, 'migration_lock.toml'),
      resolve(migrationsPath, 'migration_lock.toml'),
    );
    for (const name of migrationNames)
      cpSync(resolve(directory, name), resolve(migrationsPath, name), { recursive: true });
    const configPath = resolve(tempRoot, 'prisma.config.ts');
    writeFileSync(
      configPath,
      `import { defineConfig, env } from 'prisma/config';
export default defineConfig({
  schema: ${JSON.stringify(resolve(root, 'apps/api/prisma/schema.prisma'))},
  migrations: { path: ${JSON.stringify(migrationsPath)} },
  datasource: { url: env('DATABASE_URL') },
});
`,
      { mode: 0o600 },
    );
    return { tempRoot, configPath, migrationNames };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function readState(databaseUrl, source) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    options: '-c statement_timeout=2500 -c lock_timeout=250 -c timezone=UTC',
  });
  try {
    await client.connect();
    const results = await client.query(outcomeCohortStateSql);
    const rows = (Array.isArray(results) ? results : [results]).flatMap((result) => result.rows);
    return verifyOutcomeCohortPreparationState(rows[0]?.json_build_object, source);
  } finally {
    await client.end();
  }
}

export async function runOutcomeCohortOnlinePrepare({
  selector,
  root = process.cwd(),
  env = process.env,
  inspect = readState,
  runPrisma = spawnSync,
} = {}) {
  const target = requireOutcomeCohortTarget(selector);
  if (!env.DATABASE_URL?.trim() || !env.MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME)
    throw new Error('OUTCOME_COHORT_TAGGED_DATABASE_REQUIRED');
  const prepareEnv = createMultibotPrepareEnvironment(env);
  const source = readOutcomeCohortSource(root);
  const before = await inspect(prepareEnv.DATABASE_URL, source);
  if (!before.pending.includes(selector)) return { state: 'already_applied', selector };
  if (before.pending[0] !== selector) throw new Error('OUTCOME_COHORT_PREDECESSOR_PENDING');
  // FLAG: Every earlier immutable receipt and both target catalog states were proved before
  // Prisma sees this complete prefix. Only the selected fixed migration can be pending.
  const prefix = createOutcomeCohortMigrationPrefix(root, selector);
  try {
    const result = runPrisma(
      process.execPath,
      [
        resolve(root, 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--config',
        prefix.configPath,
      ],
      { cwd: root, env: prepareEnv, stdio: 'ignore', timeout: target.statementMs + 30_000 },
    );
    if (result.error || result.signal || result.status !== 0)
      throw new Error('OUTCOME_COHORT_PRISMA_DEPLOY_FAILED');
    const after = await inspect(prepareEnv.DATABASE_URL, source);
    if (after.pending.includes(selector)) throw new Error('OUTCOME_COHORT_PREPARATION_INCOMPLETE');
    return { state: 'applied', selector };
  } finally {
    rmSync(prefix.tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    if (process.argv.length !== 3) throw new Error('OUTCOME_COHORT_ARGUMENTS_INVALID');
    console.log(JSON.stringify(await runOutcomeCohortOnlinePrepare({ selector: process.argv[2] })));
  } catch {
    // FLAG: Prisma and connection errors may contain private SQL, credentials or logs.
    console.error('OUTCOME_COHORT_PREPARATION_FAILED; receipts and indexes preserved.');
    process.exitCode = 1;
  }
}
