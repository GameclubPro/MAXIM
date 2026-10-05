import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import {
  ADDITIVE_MIGRATION,
  MIGRATION,
  SEMANTIC_ORDER_MIGRATION,
  migrationChecksums,
  recoveryAuditSql,
} from './multibot-index-recovery-schema.mjs';

export const multibotPrismaFailure = (code, family) =>
  `A migration failed to apply.\n\nMigration name: ${MIGRATION}\n\nDatabase error code: ${code}\n\nDatabase error:\nERROR: canceling statement due to ${family}\n\nDbError fixture-private-log`;

// This catalog fixture is confined to an in-memory database or an independently
// created disposable native database; no production or application row reads.
export async function prepareMultibotRecoveryCatalog(db, { concurrent = false } = {}) {
  await db.exec(`CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'DUPLICATE', 'FAILED', 'QUEUED');
    CREATE TABLE webhook_events (
      id text PRIMARY KEY, status "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
      created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      next_enqueue_at timestamp(3), timeout_quarantine_expires_at timestamp(3), error_message text);
    CREATE TABLE _prisma_migrations (id text PRIMARY KEY, checksum text, migration_name text,
      finished_at timestamp, rolled_back_at timestamp, applied_steps_count integer, logs text);`);
  const additive = readFileSync(
    `apps/api/prisma/migrations/${ADDITIVE_MIGRATION}/migration.sql`,
    'utf8',
  );
  const order = readFileSync(
    `apps/api/prisma/migrations/${SEMANTIC_ORDER_MIGRATION}/migration.sql`,
    'utf8',
  );
  await db.exec(additive);
  await db.exec(concurrent ? order : order.replace('CREATE INDEX CONCURRENTLY', 'CREATE INDEX'));
  for (const name of [ADDITIVE_MIGRATION, SEMANTIC_ORDER_MIGRATION]) {
    await db.query(
      'INSERT INTO _prisma_migrations VALUES ($1, $2, $3, CURRENT_TIMESTAMP, NULL, 1, NULL)',
      [`receipt-${name}`, migrationChecksums[name], name],
    );
  }
  await db.query('INSERT INTO _prisma_migrations VALUES ($1, $2, $3, NULL, NULL, 0, $4)', [
    'private-receipt-identity',
    migrationChecksums[MIGRATION],
    MIGRATION,
    multibotPrismaFailure('55P03', 'lock timeout'),
  ]);
}

export async function withMultibotRecoveryCatalog(run) {
  const db = new PGlite();
  try {
    await prepareMultibotRecoveryCatalog(db);
    const read = async () => (await db.query(recoveryAuditSql)).rows[0].json_build_object;
    return await run(db, read);
  } finally {
    await db.close();
  }
}
