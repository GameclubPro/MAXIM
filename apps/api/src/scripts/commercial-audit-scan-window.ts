import { Prisma, readPrismaPoolConfig, type PrismaPoolConfig } from '../prisma/prisma-client';

const AUDIT_STATEMENT_TIMEOUT_MS = 10_000;
export type AuditCandidateCursor = Readonly<{ createdAt: Date; webhookEventId: string }>;

export function resolveCommercialAuditPrismaPoolConfig(
  baseConfig: PrismaPoolConfig = readPrismaPoolConfig(),
  processId = process.pid,
): PrismaPoolConfig {
  return {
    ...baseConfig,
    application_name: `maxim_commercial_audit_query_${processId}`,
    max: 1,
    options: '-c max_parallel_workers_per_gather=0',
    statement_timeout: AUDIT_STATEMENT_TIMEOUT_MS,
  };
}

type AuditScanWindowOptions = {
  pageSize: number;
  cursor?: AuditCandidateCursor;
  loadSince: Date;
  until: Date;
};

export function buildAuditCandidateCursorSql(cursor?: AuditCandidateCursor): Prisma.Sql {
  return cursor
    ? Prisma.sql`and (w.created_at, w.id) > (${cursor.createdAt}, ${cursor.webhookEventId})`
    : Prisma.sql``;
}

export function buildAuditScanWindowSql(options: AuditScanWindowOptions): Prisma.Sql {
  const cursorSql = buildAuditCandidateCursorSql(options.cursor);

  // FLAG: Keep JSON predicates and joins outside this bounded materialized scan. Putting them
  // here lets PostgreSQL choose a repeated full-window scan for every cursor page.
  return Prisma.sql`
    select
      w.id,
      w.created_at,
      w.bot_id,
      w.normalized_payload
    from webhook_events w
    where w.created_at >= ${options.loadSince}
      and w.created_at <= ${options.until}
      and w.status = 'PROCESSED'
      ${cursorSql}
    order by w.created_at asc, w.id asc
    limit ${options.pageSize}
  `;
}
