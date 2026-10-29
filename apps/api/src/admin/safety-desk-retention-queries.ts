import { Prisma, type MessageRetentionPolicy } from '../prisma/prisma-client';

type PageIdentity = { chatId: string; chatTitle: string };
export type RetentionRuntimePageRow =
  | (PageIdentity & { source: 'eraser' })
  | (PageIdentity & { source: 'legacy' } & Pick<
        MessageRetentionPolicy,
        | 'enabled'
        | 'hours'
        | 'revision'
        | 'activationId'
        | 'pendingCount'
        | 'deletedCount'
        | 'skippedCount'
        | 'nextRunAt'
        | 'captureAfter'
        | 'pausedAt'
        | 'updatedAt'
        | 'lastStatus'
      >);

export type LegacyRuntimeDiagnostics = {
  chatId: string;
  oldestSourceMs: number | null;
  incomplete: boolean;
  hasTerminalReview: boolean;
  hasWorkerError: boolean;
  hasWaitingAccess: boolean;
  hasUnresolvedReceipt: boolean;
  hasDeferred: boolean;
  hasLegacyRetry: boolean;
};
export type LegacyRuntimeBatch = {
  diagnostics: LegacyRuntimeDiagnostics[];
  quotas: Array<{ shard: number; pendingCount: number }>;
};

export function retentionRuntimePageQuery(after: string | null): Prisma.Sql {
  // FLAG: Nominate at most 102 indexed identities before deduplication and title enrichment.
  // Persisted ownership selects the authority; the current feature flag never changes it.
  return Prisma.sql`
    WITH page AS MATERIALIZED (
      SELECT chat_id FROM (
        (SELECT chat_id FROM message_retention_policies
          WHERE ${after}::text IS NULL OR chat_id>${after} ORDER BY chat_id LIMIT 51)
        UNION
        (SELECT chat_id FROM eraser_chat_bindings
          WHERE ${after}::text IS NULL OR chat_id>${after} ORDER BY chat_id LIMIT 51)
      ) identities ORDER BY chat_id LIMIT 51
    )
    SELECT page.chat_id AS "chatId",COALESCE(chat.title,'Чат недоступен') AS "chatTitle",
      CASE WHEN binding.chat_id IS NOT NULL THEN 'eraser' ELSE 'legacy' END AS source,
      policy.enabled,policy.hours,policy.revision,policy.activation_id AS "activationId",
      policy.pending_count AS "pendingCount",policy.deleted_count AS "deletedCount",
      policy.skipped_count AS "skippedCount",policy.next_run_at AS "nextRunAt",
      policy.capture_after AS "captureAfter",policy.paused_at AS "pausedAt",
      policy.updated_at AS "updatedAt",policy.last_status AS "lastStatus"
    FROM page
    LEFT JOIN eraser_chat_bindings binding ON binding.chat_id=page.chat_id
    LEFT JOIN message_retention_policies policy ON policy.chat_id=page.chat_id
    LEFT JOIN chats chat ON chat.id=page.chat_id ORDER BY page.chat_id`;
}

export function retentionLegacyDiagnosticsQuery(chatIds: string[]): Prisma.Sql {
  const selected = chatIds.length
    ? Prisma.sql`p.chat_id IN (${Prisma.join(chatIds)})`
    : Prisma.sql`FALSE`;
  // FLAG: Each age probe reads at most 201 rows from the exact activation index. A full
  // sentinel page withholds the oldest age instead of claiming a complete ledger scan.
  // Ordered scalar outcome probes retain the index path when matches follow long history.
  return Prisma.sql`
    SELECT COALESCE((SELECT jsonb_agg(diagnostics) FROM (
      SELECT p.chat_id AS "chatId",
        CASE WHEN pending.count<201 AND retry.count<201
          THEN EXTRACT(EPOCH FROM LEAST(pending.oldest,retry.oldest))*1000 ELSE NULL END AS "oldestSourceMs",
        pending.count=201 OR retry.count=201 AS incomplete,
        COALESCE((SELECT true FROM message_retention_candidates c WHERE c.chat_id=p.chat_id AND c.outcome_code='terminal_review' ORDER BY c.message_id LIMIT 1),false) AS "hasTerminalReview",
        COALESCE((SELECT true FROM message_retention_candidates c WHERE c.chat_id=p.chat_id AND c.outcome_code='worker_error' ORDER BY c.message_id LIMIT 1),false) AS "hasWorkerError",
        COALESCE((SELECT true FROM message_retention_candidates c WHERE c.chat_id=p.chat_id AND c.outcome_code='waiting_access' ORDER BY c.message_id LIMIT 1),false) AS "hasWaitingAccess",
        COALESCE((SELECT true FROM message_retention_candidates c WHERE c.chat_id=p.chat_id AND c.outcome_code='reconciliation' ORDER BY c.message_id LIMIT 1),false) AS "hasUnresolvedReceipt",
        COALESCE((SELECT true FROM message_retention_candidates c WHERE c.chat_id=p.chat_id AND c.outcome_code='deferred' ORDER BY c.message_id LIMIT 1),false) AS "hasDeferred",
        COALESCE(retry.legacy,false) AS "hasLegacyRetry"
      FROM message_retention_policies p
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS count,MIN(source_at) AS oldest FROM (
          SELECT source_at FROM message_retention_candidates c
          WHERE c.chat_id=p.chat_id AND c.status='pending' AND c.activation_id=p.activation_id
          ORDER BY c.message_id LIMIT 201
        ) bounded
      ) pending ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS count,MIN(source_at) AS oldest,BOOL_OR(outcome_code IS NULL) AS legacy FROM (
          SELECT source_at,outcome_code FROM message_retention_candidates c
          WHERE c.chat_id=p.chat_id AND c.status='retry' AND c.activation_id=p.activation_id
          ORDER BY c.message_id LIMIT 201
        ) bounded
      ) retry ON true WHERE ${selected}
    ) diagnostics),'[]'::jsonb) AS diagnostics,
    COALESCE((SELECT jsonb_agg(quota) FROM (
      SELECT shard,pending_count AS "pendingCount" FROM message_retention_quotas ORDER BY shard LIMIT 32
    ) quota),'[]'::jsonb) AS quotas`;
}

export function retentionReviewPageQuery(chatId: string, after: string | null): Prisma.Sql {
  // FLAG: Bound each outcome arm before merging; old activations remain reviewable.
  return Prisma.sql`SELECT message_id AS "messageId" FROM (
    (SELECT message_id FROM message_retention_candidates WHERE chat_id=${chatId}
      AND outcome_code='terminal_review' AND (${after}::text IS NULL OR message_id>${after})
      ORDER BY message_id LIMIT 21)
    UNION ALL
    (SELECT message_id FROM message_retention_candidates WHERE chat_id=${chatId}
      AND outcome_code='reconciliation' AND (${after}::text IS NULL OR message_id>${after})
      ORDER BY message_id LIMIT 21)
  ) review ORDER BY message_id LIMIT 21`;
}
