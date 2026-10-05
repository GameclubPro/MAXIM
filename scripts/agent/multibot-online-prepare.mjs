#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MULTIBOT_ONLINE_PREFIX_NAME = '20261005016100_index_multibot_retention_cursor';
const requiredPrepareMigrations = [
  '20261005015900_prepare_multibot_webhook_columns',
  '20261005016000_add_multibot_semantic_order_index',
  MULTIBOT_ONLINE_PREFIX_NAME,
];

export function createMultibotMigrationPrefix(root) {
  const source = resolve(root, 'apps/api/prisma/migrations');
  const migrationNames = readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => name <= MULTIBOT_ONLINE_PREFIX_NAME)
    .sort();
  if (requiredPrepareMigrations.some((name) => !migrationNames.includes(name)))
    throw new Error('MULTIBOT_PREPARE_PREFIX_INCOMPLETE');
  const workspaceTemp = resolve(root, 'apps/api/.migration-prepare');
  mkdirSync(workspaceTemp, { recursive: true, mode: 0o700 });
  const tempRoot = mkdtempSync(resolve(workspaceTemp, 'online-'));
  try {
    const migrationsPath = resolve(tempRoot, 'migrations');
    mkdirSync(migrationsPath, { mode: 0o700 });
    cpSync(resolve(source, 'migration_lock.toml'), resolve(migrationsPath, 'migration_lock.toml'));
    // FLAG: Copy the complete immutable earlier source prefix. Never alter SQL/checksums,
    // resolve a receipt, or expose the later effects-cutoff migration during online work.
    for (const name of migrationNames)
      cpSync(resolve(source, name), resolve(migrationsPath, name), { recursive: true });
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

export function runMultibotOnlinePrepare({
  root = process.cwd(),
  env = process.env,
  runPrisma = spawnSync,
} = {}) {
  if (!env.DATABASE_URL?.trim()) throw new Error('MULTIBOT_PREPARE_DATABASE_URL_REQUIRED');
  const prefix = createMultibotMigrationPrefix(root);
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
      { cwd: root, env, stdio: 'inherit', timeout: 5_700_000 },
    );
    if (result.error || result.signal || result.status !== 0)
      throw new Error('MULTIBOT_PREPARE_PRISMA_DEPLOY_FAILED');
    return { migrationNames: prefix.migrationNames };
  } finally {
    rmSync(prefix.tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    if (process.argv.length !== 2) throw new Error('MULTIBOT_PREPARE_ARGUMENTS_UNSUPPORTED');
    runMultibotOnlinePrepare();
    console.log('Online multibot preparation completed; authority cutoff was not applied.');
  } catch (error) {
    console.error(
      `${error.message}; failed migration receipts and partial indexes were preserved.`,
    );
    process.exitCode = 1;
  }
}
