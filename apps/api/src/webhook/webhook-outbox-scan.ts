import { Prisma } from '../prisma/prisma-client';

type Cursor = { createdAt: Date; id: string };
export type OutboxScanState = { horizon: Date; after: Cursor | null };
export type OutboxScanProgress = {
  lane: string;
  afterMs: number | null;
  afterId: string | null;
  complete: boolean;
};

type ScanQuery = {
  eligibility: Prisma.Sql;
  columns: Prisma.Sql;
  workUnitKey: Prisma.Sql;
  scanDirection: 'ASC' | 'DESC';
  resultDirection: 'ASC' | 'DESC';
  overscanTake: number;
  candidateTake: number;
  rotation?: { lane: string; state: OutboxScanState };
};

export function buildBoundedEnqueueWorkUnitsSql(params: ScanQuery): Prisma.Sql {
  if (params.rotation && params.candidateTake >= 2) return buildRotatingScan(params);
  const scanDirection = Prisma.raw(params.scanDirection);
  const resultDirection = Prisma.raw(params.resultDirection);
  return Prisma.sql`
    SELECT ${params.columns}, FALSE AS "isBacklogScan", NULL::jsonb AS "scanProgress"
    FROM (
      SELECT DISTINCT ON ("work_unit_key") bounded_pool.*
      FROM (
        SELECT ${params.columns}, ${params.workUnitKey} AS "work_unit_key"
        FROM "webhook_events"
        WHERE ${params.eligibility}
        ORDER BY "created_at" ${scanDirection}, "id" ${scanDirection}
        LIMIT ${params.overscanTake}
      ) bounded_pool
      ORDER BY "work_unit_key" ASC, "created_at" ASC, "id" ASC
    ) collapsed_work_units
    ORDER BY "created_at" ${resultDirection}, "id" ${resultDirection}
    LIMIT ${params.candidateTake}
  `;
}

function buildRotatingScan(params: ScanQuery): Prisma.Sql {
  const { lane, state } = params.rotation!;
  const pageSize = Math.floor(params.overscanTake / 2);
  const pageTake = Math.floor(params.candidateTake / 2);
  const head = buildBoundedEnqueueWorkUnitsSql({
    ...params,
    rotation: undefined,
    overscanTake: params.overscanTake - pageSize,
    candidateTake: params.candidateTake - pageTake,
  });
  const after = state.after
    ? Prisma.sql`AND ("created_at", "id") > (${state.after.createdAt}, ${state.after.id})`
    : Prisma.empty;
  // FLAG: Both pools share the old raw scan budget. The horizon cannot move with new arrivals.
  // Advance across the scanned raw tail, except when the distinct candidate cap leaves unseen
  // work units: consume only the raw prefix before the first unreturned representative.
  // Repeated rows of one work unit must not advance the cursor just one row per poll.
  return Prisma.sql`
    WITH page_pool AS MATERIALIZED (
      SELECT ${params.columns}, ${params.workUnitKey} AS "work_unit_key"
      FROM "webhook_events"
      WHERE ${params.eligibility} AND "created_at" <= ${state.horizon} ${after}
      ORDER BY "created_at" ASC, "id" ASC LIMIT ${pageSize}
    ),
    page_units AS MATERIALIZED (
      SELECT DISTINCT ON ("work_unit_key") page_pool.*
      FROM page_pool ORDER BY "work_unit_key", "created_at", "id"
    ),
    page_candidates AS MATERIALIZED (
      SELECT ${params.columns} FROM page_units ORDER BY "created_at", "id" LIMIT ${pageTake}
    ),
    page_counts AS (
      SELECT (SELECT COUNT(*) FROM page_pool) AS raw_count,
             (SELECT COUNT(*) FROM page_units) > ${pageTake} AS capped
    ),
    first_unreturned AS (
      SELECT "created_at", "id" FROM page_units
      WHERE NOT EXISTS (SELECT 1 FROM page_candidates WHERE page_candidates."id" = page_units."id")
      ORDER BY "created_at", "id" LIMIT 1
    ),
    scan_tail AS (
      SELECT "created_at", "id" FROM page_pool
      WHERE NOT (SELECT capped FROM page_counts)
        OR ("created_at", "id") < (SELECT "created_at", "id" FROM first_unreturned)
      ORDER BY "created_at" DESC, "id" DESC LIMIT 1
    ),
    progress AS (
      SELECT jsonb_build_object(
        'lane', ${lane}::text,
        'afterMs', (SELECT EXTRACT(EPOCH FROM "created_at") * 1000 FROM scan_tail),
        'afterId', (SELECT "id" FROM scan_tail),
        'complete', raw_count < ${pageSize} AND NOT capped
      ) AS "scanProgress" FROM page_counts
    )
    SELECT * FROM (${head}) head_candidates
    UNION ALL
    SELECT page_candidates.*, TRUE AS "isBacklogScan", progress."scanProgress"
    FROM progress LEFT JOIN page_candidates ON TRUE
  `;
}
