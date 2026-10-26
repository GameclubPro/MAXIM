import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { Queue, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { Prisma, createPrismaClient } from '../prisma/prisma-client';
import type { MaxActionJob } from '../max/max-client.service';
import { isMaxSendAutoDeleteMarker } from '../max/max-send-auto-delete-marker';
import { readMaxModerationRuleNoticeProof } from '../max/max-moderation-rule-notice-proof';
import { readRequiredSubscriptionNoticeAuthority } from '../moderation/required-subscription-notice-authority';
import { readMessageDuplicateNoticeProof } from '../moderation/message-duplicate/message-duplicate-notice-proof';
import { backlogSource } from '../webhook/webhook-backlog-cancellation';
import { confirmEraserSourceHolds } from '../message-retention/eraser-source-hold-barrier';
import { readLegacyActionSourceScopes } from '../webhook/webhook-legacy-hold.service';
import { LEGACY_RECOVERY_LIVE_QUEUE_NAMES } from './legacy-recovery-live-registry';
import { backlogJobSnapshot, projectBacklogReceipts } from './cancel-webhook-backlog';
import {
  BACKLOG_CANCELLATION_V2_LIMITS as limits,
  BacklogCancellationRefusedV2,
  backlogCancellationBytesV2,
  backlogCancellationDigestV2,
  hasBacklogCancellationControlsV2,
  parseBacklogCancellationApplyV2,
  parseBacklogCancellationNominationV2,
  validateBacklogCancellationBindingsV2,
  validateBacklogCancellationPreviewV2,
  type BacklogCancellationApplyResultV2,
  type BacklogCancellationApplyV2,
  type BacklogCancellationBindingsV2,
  type BacklogCancellationChildProofV2,
  type BacklogCancellationCostV2,
  type BacklogCancellationIssueCodeV2,
  type BacklogCancellationIssueV2,
  type BacklogCancellationNominationV2,
  type BacklogCancellationNoWriteProofV2,
  type BacklogCancellationPreflightV2,
  type BacklogCancellationPreviewV2,
  type BacklogCancellationRetainedV2,
  type BacklogCancellationRootProofV2,
} from './cancel-webhook-backlog-v2.contract';

type Database = ReturnType<typeof createPrismaClient>;
type Snapshot = Record<string, Prisma.JsonValue>;
type Progress = (value: { phase: string; count?: number }) => void;
type ReceiptRow = { id: string; at: Date };
type Root = { proof: BacklogCancellationRootProofV2; snapshot: Snapshot };
type Scope = { roots: Root[]; receipts: Map<string, Snapshot> };
type RawJob = { queue: string; id: string; hash: Record<string, string>; locked: boolean };
type SelectedJob = { proof: BacklogCancellationChildProofV2; job: RawJob };
type SourceIdentity = { chatId: string; messageId: string; userId: string };
type SendParent = SourceIdentity & { createdAt: string };
const portableDecodedBytes = 6 * limits.jobBytes + 4096;
const portableEnvelopeBytes = 4 * Math.ceil(portableDecodedBytes / 3) + 128;
const operationIndex = 'webhook_backlog_children_operation_idx';
const webhookQueues = LEGACY_RECOVERY_LIVE_QUEUE_NAMES.filter(
  (name) =>
    ['moderation', 'moderation-critical', 'moderation-background', 'moderation-default'].includes(
      name,
    ) || /^moderation-(join|default)-\d+$/u.test(name),
);
const actionQueues = [
  'moderation-actions',
  'max-actions-critical',
  'max-actions-interactive',
  'max-actions-background',
];
const queues = [...webhookQueues, ...actionQueues];
const states = ['wait', 'paused', 'active', 'delayed', 'prioritized', 'failed'] as const;
const bookkeeping = new Set(['queued_at', 'enqueue_attempts', 'next_enqueue_at', 'queue_name']);
const dataDirectory = '/app/backlog-cancellation-v2';

function fail(
  code: BacklogCancellationIssueCodeV2,
  detail: Omit<BacklogCancellationIssueV2, 'code'> = {},
): never {
  throw new BacklogCancellationRefusedV2({ code, ...detail });
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function issue(error: unknown): BacklogCancellationIssueV2 {
  return error instanceof BacklogCancellationRefusedV2 ? error.issue : { code: 'INCOMPLETE' };
}
function counter(): BacklogCancellationCostV2 {
  return { sqlRows: 0, sqlBytes: 0, sqlCalls: 0, queueJobs: 0, queueBytes: 0, queuePages: 0 };
}
const rawSqlIdentities = new WeakMap<BacklogCancellationCostV2, Set<string>>();
function observeSql(cost: BacklogCancellationCostV2, identity: string, deadline: number): void {
  let identities = rawSqlIdentities.get(cost);
  if (!identities) {
    identities = new Set();
    rawSqlIdentities.set(cost, identities);
  }
  identities.add(identity);
  cost.sqlRows = identities.size;
  budget(cost, deadline);
}
function retained(): BacklogCancellationRetainedV2 {
  return { terminalReceipts: 0, protectedJobs: 0, unattributedJobs: 0, lockedJobs: 0 };
}
function budget(cost: BacklogCancellationCostV2, deadline: number): void {
  if (
    Date.now() >= deadline ||
    cost.sqlRows > limits.sqlRows ||
    cost.sqlBytes > limits.sqlBytes ||
    cost.sqlCalls > 20_000 ||
    cost.queueJobs > limits.queueJobs ||
    cost.queueBytes > limits.queueBytes ||
    cost.queuePages > 50_000
  )
    fail('BUDGET');
}
function identityDigest(snapshot: Snapshot, root: boolean): string {
  return backlogCancellationDigestV2(
    Object.fromEntries(
      Object.entries(snapshot)
        .filter(([key]) => !bookkeeping.has(key))
        .map(([key, value]) => [
          key,
          !root && key === 'status' && ['RECEIVED', 'QUEUED'].includes(String(value))
            ? 'PENDING'
            : value,
        ]),
    ),
  );
}
function sqlInstant(value: string): number {
  // FLAG: PostgreSQL timestamp-without-time-zone snapshots use the verified UTC session.
  return Date.parse(/[Zz]|[+-]\d\d:\d\d$/u.test(value) ? value : `${value}Z`);
}
function pending(snapshot: Snapshot): boolean {
  return (
    snapshot.processed_at === null &&
    !snapshot.legacy_disposition_id &&
    !snapshot.source_disposition_id &&
    ['RECEIVED', 'QUEUED', 'FAILED', 'QUARANTINED'].includes(String(snapshot.status))
  );
}
async function readOnly<T>(
  db: Database,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  cost: BacklogCancellationCostV2 = counter(),
  deadline = Date.now() + limits.clientMs,
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await measureDb(cost, deadline, () => tx.$executeRaw`SET TRANSACTION READ ONLY`);
      await measureDb(cost, deadline, () => tx.$executeRaw`SET LOCAL statement_timeout = '5s'`);
      await measureDb(cost, deadline, () => tx.$executeRaw`SET LOCAL lock_timeout = '1s'`);
      await measureDb(cost, deadline, () => tx.$executeRaw`SET LOCAL enable_seqscan = off`);
      await measureDb(cost, deadline, () => tx.$executeRaw`SET LOCAL enable_bitmapscan = off`);
      await measureDb(cost, deadline, () => tx.$executeRaw`SET LOCAL enable_sort = off`);
      await measureDb(
        cost,
        deadline,
        () => tx.$executeRaw`SET LOCAL enable_incremental_sort = off`,
      );
      await measureDb(cost, deadline, () => tx.$executeRaw`SET LOCAL jit = off`);
      const [session] = await query<{ readonly: string; timezone: string }>(
        tx,
        Prisma.sql`SELECT current_setting('transaction_read_only') AS readonly, current_setting('TimeZone') AS timezone`,
        cost,
        deadline,
      );
      if (session?.readonly !== 'on' || session.timezone !== 'UTC') fail('SQL_READ_ONLY');
      return work(tx);
    },
    { isolationLevel: 'RepeatableRead', timeout: 120_000 },
  );
}
async function measureDb<T>(
  cost: BacklogCancellationCostV2,
  deadline: number,
  run: () => Promise<T>,
): Promise<T> {
  cost.sqlCalls++;
  budget(cost, deadline);
  const value = await run();
  cost.sqlBytes += Buffer.byteLength(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)) ??
      'null',
  );
  budget(cost, deadline);
  return value;
}
async function query<T>(
  tx: Prisma.TransactionClient,
  sql: Prisma.Sql,
  cost: BacklogCancellationCostV2,
  deadline: number,
): Promise<T[]> {
  return measureDb(cost, deadline, () => tx.$queryRaw<T[]>(sql));
}
async function assertIndexPlan(
  tx: Prisma.TransactionClient,
  sql: Prisma.Sql,
  relation: string,
  index: string,
  cost: BacklogCancellationCostV2,
  deadline: number,
): Promise<void> {
  const plan = await query<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>(
    tx,
    Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`,
    cost,
    deadline,
  );
  const scans: Record<string, unknown>[] = [];
  const walk = (node: Record<string, unknown>, depth = 0) => {
    if (depth > 16) fail('SQL_PLAN');
    if (node['Relation Name']) scans.push(node);
    for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child, depth + 1);
  };
  if (!plan[0]?.['QUERY PLAN'][0]?.Plan) fail('SQL_PLAN');
  walk(plan[0]['QUERY PLAN'][0].Plan);
  if (
    scans.length !== 1 ||
    scans[0]?.['Relation Name'] !== relation ||
    scans[0]['Index Name'] !== index ||
    !['Index Scan', 'Index Only Scan'].includes(String(scans[0]['Node Type']))
  )
    fail('SQL_PLAN');
}
async function indexed(
  tx: Prisma.TransactionClient,
  sql: Prisma.Sql,
  index: string,
  cost: BacklogCancellationCostV2,
  deadline: number,
): Promise<ReceiptRow[]> {
  await assertIndexPlan(tx, sql, 'webhook_events', index, cost, deadline);
  const rows = await query<ReceiptRow>(tx, sql, cost, deadline);
  for (const row of rows) observeSql(cost, `receipt:${row.id}`, deadline);
  return rows;
}
function operationChildrenSql(
  operation: string,
  projection: 'size' | 'snapshot' = 'size',
): Prisma.Sql {
  const selected =
    projection === 'size'
      ? Prisma.sql`octet_length(original_snapshot::text) AS size`
      : Prisma.sql`original_snapshot AS "originalSnapshot"`;
  // FLAG: Equal closed-range bounds retain the leading sort key; equality lets PostgreSQL
  // drop it and prefer a filtered primary-key scan after a dominant operation is analyzed.
  return Prisma.sql`SELECT kind,child_key AS "childKey",${selected}
    FROM webhook_backlog_children
    WHERE cancellation_id>=${operation} AND cancellation_id<=${operation}
    ORDER BY cancellation_id,kind,child_key LIMIT ${limits.selectedChildren + 1}`;
}
async function requireOperationIndex(
  tx: Prisma.TransactionClient,
  operation: string,
  cost: BacklogCancellationCostV2,
  deadline: number,
): Promise<void> {
  const [row] = await query<{
    valid: boolean;
    ready: boolean;
    unique: boolean;
    relation: string;
    method: string;
    keys: number;
    attributes: number;
    predicate: string | null;
    expressions: string | null;
    first: string;
    second: string;
    third: string;
  }>(
    tx,
    Prisma.sql`
    SELECT i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS "unique",
      i.indrelid::regclass::text AS relation,am.amname AS method,i.indnkeyatts AS keys,i.indnatts AS attributes,
      pg_get_expr(i.indpred,i.indrelid) AS predicate,pg_get_expr(i.indexprs,i.indrelid) AS expressions,
      pg_get_indexdef(i.indexrelid,1,true) AS first,pg_get_indexdef(i.indexrelid,2,true) AS second,pg_get_indexdef(i.indexrelid,3,true) AS third
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
    WHERE i.indexrelid=to_regclass('public.webhook_backlog_children_operation_idx')`,
    cost,
    deadline,
  );
  if (
    !row ||
    !row.valid ||
    !row.ready ||
    row.unique ||
    row.relation !== 'webhook_backlog_children' ||
    row.method !== 'btree' ||
    row.keys !== 3 ||
    row.attributes !== 3 ||
    row.predicate !== null ||
    row.expressions !== null ||
    [row.first, row.second, row.third].join(',') !== 'cancellation_id,kind,child_key'
  )
    fail('SQL_PLAN');
  await assertIndexPlan(
    tx,
    operationChildrenSql(operation),
    'webhook_backlog_children',
    operationIndex,
    cost,
    deadline,
  );
}
async function receipt(
  tx: Prisma.TransactionClient,
  id: string,
  operation: string,
  cost: BacklogCancellationCostV2,
  deadline: number,
): Promise<Snapshot> {
  observeSql(cost, `receipt:${id}`, deadline);
  const [row] = await query<{ snapshot: Snapshot | null; size: number }>(
    tx,
    Prisma.sql`
    SELECT CASE WHEN octet_length(to_jsonb(e)::text) <= ${limits.rowBytes} THEN to_jsonb(e) END AS snapshot,
      octet_length(to_jsonb(e)::text) AS size FROM webhook_events e WHERE id=${id}`,
    cost,
    deadline,
  );
  if (!row) fail('ROOT_MISSING', { receiptId: id });
  if (!row.snapshot || row.size > limits.rowBytes) fail('BUDGET', { receiptId: id });
  const [captured] = await query<{
    cancellationId: string;
    original: Snapshot;
    semanticKey: string | null;
    chatId: string | null;
    messageId: string | null;
  }>(
    tx,
    Prisma.sql`
    SELECT cancellation_id AS "cancellationId", original_snapshot AS original, semantic_key AS "semanticKey", chat_id AS "chatId", message_id AS "messageId"
    FROM webhook_backlog_receipts WHERE receipt_id=${id}`,
    cost,
    deadline,
  );
  if (captured && captured.cancellationId !== operation) fail('FOREIGN_HOLD', { receiptId: id });
  if (captured) {
    const source = backlogSource(captured.original.normalized_payload);
    if (
      captured.original.id !== id ||
      captured.semanticKey !== source.semanticKey ||
      captured.chatId !== source.chatId ||
      captured.messageId !== source.messageId
    )
      fail('EVIDENCE_MISMATCH', { receiptId: id });
    const expected =
      row.snapshot.status === 'CANCELLED'
        ? { ...captured.original, status: 'CANCELLED' }
        : captured.original;
    if (backlogCancellationDigestV2(expected) !== backlogCancellationDigestV2(row.snapshot))
      fail('EVIDENCE_MISMATCH', { receiptId: id });
    return captured.original;
  }
  return row.snapshot;
}
async function root(
  tx: Prisma.TransactionClient,
  id: string,
  nomination: BacklogCancellationNominationV2,
  cost: BacklogCancellationCostV2,
  deadline: number,
): Promise<Root> {
  const snapshot = await receipt(tx, id, nomination.id, cost, deadline);
  if (
    !pending(snapshot) ||
    typeof snapshot.created_at !== 'string' ||
    !Number.isFinite(sqlInstant(snapshot.created_at)) ||
    sqlInstant(snapshot.created_at) >= Date.parse(nomination.cutoff)
  )
    fail('ROOT_INELIGIBLE', { rootId: id });
  const source = backlogSource(snapshot.normalized_payload);
  if (
    !source.semanticKey ||
    (snapshot.semantic_key !== null && snapshot.semantic_key !== source.semanticKey)
  )
    fail('SOURCE_MISMATCH', { rootId: id });
  observeSql(cost, `claim:EXECUTION:${source.semanticKey}`, deadline);
  const [claim] = await query<{ snapshot: Snapshot | null }>(
    tx,
    Prisma.sql`
    SELECT CASE WHEN octet_length(to_jsonb(c)::text)<=${limits.rowBytes} THEN to_jsonb(c) END AS snapshot
    FROM webhook_execution_claims c WHERE kind='EXECUTION' AND semantic_key=${source.semanticKey}`,
    cost,
    deadline,
  );
  const authority = claim?.snapshot;
  if (
    !authority ||
    authority.webhook_event_id !== id ||
    authority.status !== 'READY' ||
    authority.enforced !== true ||
    !authority.business_started_at ||
    authority.completed_at !== null ||
    authority.lease_token !== null ||
    authority.lease_expires_at !== null ||
    object(authority.command_result)?.kind === 'EXECUTION_FINISHED'
  )
    fail('CLAIM_MISMATCH', { rootId: id });
  const [foreign] = await query<{ held: boolean }>(
    tx,
    Prisma.sql`SELECT
    EXISTS (SELECT 1 FROM webhook_backlog_receipts WHERE receipt_id=${id} AND cancellation_id<>${nomination.id})
    OR EXISTS (SELECT 1 FROM webhook_backlog_receipts WHERE semantic_key=${source.semanticKey} AND cancellation_id<>${nomination.id})
    OR EXISTS (SELECT 1 FROM webhook_backlog_receipts WHERE chat_id=${source.chatId} AND message_id=${source.messageId} AND cancellation_id<>${nomination.id})
    OR EXISTS (SELECT 1 FROM webhook_legacy_recoveries WHERE chat_id=${source.chatId} AND message_id=${source.messageId})
    OR EXISTS (SELECT 1 FROM webhook_source_abandonments WHERE chat_id=${source.chatId} AND message_id=${source.messageId}) AS held`,
    cost,
    deadline,
  );
  if (foreign?.held !== false) fail('FOREIGN_HOLD', { rootId: id });
  return {
    snapshot,
    proof: {
      receiptId: id,
      claimId: String(authority.id),
      semanticKey: source.semanticKey,
      chatId: source.chatId,
      messageId: source.messageId,
      identitySha256: identityDigest(snapshot, true),
      claimSha256: backlogCancellationDigestV2(authority),
      rawPayloadSha256: backlogCancellationDigestV2(snapshot.raw_payload),
      normalizedPayloadSha256: backlogCancellationDigestV2(snapshot.normalized_payload),
    },
  };
}
async function scope(
  db: Database,
  nomination: BacklogCancellationNominationV2,
  cost: BacklogCancellationCostV2,
  kept: BacklogCancellationRetainedV2,
  deadline: number,
  rootsOnly = false,
): Promise<Scope> {
  return readOnly(
    db,
    async (tx) => {
      await requireOperationIndex(tx, nomination.id, cost, deadline);
      const roots: Root[] = [];
      const receipts = new Map<string, Snapshot>();
      for (const id of nomination.rootIds) {
        const value = await root(tx, id, nomination, cost, deadline);
        roots.push(value);
        receipts.set(id, value.snapshot);
      }
      if (rootsOnly) return { roots, receipts };
      const families = new Set<string>();
      const ids = new Set(nomination.rootIds);
      for (const { proof } of roots) {
        for (const family of ['semantic', 'message'] as const) {
          if (family === 'message' && !proof.chatId) continue;
          const key = backlogCancellationDigestV2(
            family === 'semantic'
              ? [family, proof.semanticKey]
              : [family, proof.chatId, proof.messageId],
          );
          if (families.has(key)) continue;
          families.add(key);
          let cursor: ReceiptRow | null = null;
          let count = 0;
          while (true) {
            const after = cursor
              ? Prisma.sql`AND (created_at,id)>(${cursor.at},${cursor.id})`
              : Prisma.empty;
            const sql =
              family === 'semantic'
                ? Prisma.sql`SELECT id,created_at AS at FROM webhook_events WHERE semantic_key=${proof.semanticKey}
                AND semantic_key IS NOT NULL ${after} ORDER BY created_at,id LIMIT ${limits.sqlPage}`
                : Prisma.sql`SELECT id,created_at AS at FROM webhook_events
                WHERE normalized_payload->'message'->>'chatId'=${proof.chatId}
                  AND normalized_payload->'message'->>'messageId'=${proof.messageId}
                  AND status IN ('RECEIVED','QUEUED','FAILED') AND processed_at IS NULL AND source_disposition_id IS NULL
                  AND normalized_payload->'message'->>'chatId' IS NOT NULL
                  AND normalized_payload->'message'->>'messageId' IS NOT NULL
                  ${after} ORDER BY created_at,id LIMIT ${limits.sqlPage}`;
            const rows = await indexed(
              tx,
              sql,
              family === 'semantic'
                ? 'webhook_events_semantic_order_idx'
                : 'webhook_events_source_family_pending_idx',
              cost,
              deadline,
            );
            count += rows.length;
            if (count > limits.familyRows) fail('BUDGET', { rootId: proof.receiptId });
            for (const row of rows) ids.add(row.id);
            if (!rows.length) break;
            cursor = rows.at(-1)!;
          }
        }
      }
      const own = await query<{ id: string }>(
        tx,
        Prisma.sql`SELECT receipt_id AS id FROM webhook_backlog_receipts
      WHERE cancellation_id=${nomination.id} ORDER BY receipt_id LIMIT ${limits.sqlRows + 1}`,
        cost,
        deadline,
      );
      if (own.length > limits.sqlRows) fail('BUDGET');
      for (const row of own) {
        observeSql(cost, `receipt:${row.id}`, deadline);
        ids.add(row.id);
      }
      if (ids.size > limits.sqlRows) fail('BUDGET');
      for (const id of [...ids].sort()) {
        if (receipts.has(id)) continue;
        const value = await receipt(tx, id, nomination.id, cost, deadline);
        if (!pending(value)) {
          kept.terminalReceipts++;
          continue;
        }
        const source = backlogSource(value.normalized_payload);
        if (
          !roots.some(
            ({ proof }) =>
              proof.semanticKey === (value.semantic_key ?? source.semanticKey) ||
              (source.chatId !== null &&
                source.chatId === proof.chatId &&
                source.messageId === proof.messageId),
          )
        )
          fail('SOURCE_MISMATCH', { receiptId: id });
        receipts.set(id, value);
      }
      return { roots, receipts };
    },
    cost,
    deadline,
  );
}

// FLAG: Every field length is checked before returning any job payload. This script
// uses only Redis read commands and never constructs a Queue that can update meta.
const readIdsLua = `
local kind=redis.call('TYPE',KEYS[1]).ok
local expected=ARGV[1]
if kind=='none' then return {1,{}} end
if kind~=expected then return {0,'REDIS_SHAPE'} end
local ids
if expected=='list' then ids=redis.call('LRANGE',KEYS[1],ARGV[2],ARGV[3]) else ids=redis.call('ZRANGE',KEYS[1],ARGV[2],ARGV[3]) end
local bytes=0
for _,id in ipairs(ids) do
  bytes=bytes+string.len(id)+16
  if string.len(id)==0 or string.len(id)>512 then return {0,'REDIS_OVERSIZE',#ids} end
  for at=1,string.len(id) do local byte=string.byte(id,at); if byte<32 or byte==127 then return {0,'REDIS_SHAPE',#ids} end end
end
if #ids>100 or bytes>65536 then return {0,'REDIS_OVERSIZE',#ids} end
return {1,ids}
`;
const readJobsLua = `
local reply = {}
local bytes = 0
for _, key in ipairs(KEYS) do
  local kind = redis.call('TYPE',key).ok
  if kind ~= 'none' and kind ~= 'hash' then return {0,'REDIS_SHAPE'} end
  if kind == 'hash' then
    if redis.call('HLEN',key)>64 then return {0,'REDIS_OVERSIZE'} end
    local fields = redis.call('HKEYS',key)
    local size = 0
    for _, field in ipairs(fields) do
      if string.len(field)>512 then return {0,'REDIS_OVERSIZE'} end
      size=size+string.len(field)+redis.call('HSTRLEN',key,field)+16
    end
    if size>262144 then return {0,'REDIS_OVERSIZE'} end
    bytes=bytes+size+string.len(key)+128
  end
end
-- FLAG: An oversized aggregate is splittable, but every individual hash above must
-- pass its original limits before any payload is returned for this ID page.
if bytes>1048576 then return {2} end
for _, key in ipairs(KEYS) do
  table.insert(reply,{key,redis.call('HGETALL',key),redis.call('EXISTS',key..':lock')})
end
return {1,reply}
`;
type RedisWireReply = number | Buffer | RedisWireReply[];
type RedisTextReply = number | string | RedisTextReply[];
function decodeRedisReply(
  value: unknown,
  cost: BacklogCancellationCostV2,
  deadline: number,
): RedisTextReply {
  let bytes = 0;
  let nodes = 0;
  const inspect = (part: unknown, depth: number): RedisWireReply => {
    if (++nodes > limits.queuePage * (2 * limits.jobFields + 6) + 16 || depth > 4)
      fail('REDIS_SHAPE');
    if (Buffer.isBuffer(part)) {
      bytes += part.length;
      if (bytes > limits.queueReplyBytes) fail('REDIS_OVERSIZE');
      return part;
    }
    if (typeof part === 'number' && Number.isSafeInteger(part)) return part;
    if (Array.isArray(part) && part.length <= 2 * limits.jobFields)
      return part.map((item: unknown) => inspect(item, depth + 1));
    return fail('REDIS_SHAPE');
  };
  const wire = inspect(value, 0);
  cost.queueBytes += bytes;
  budget(cost, deadline);
  // FLAG: Redis keys and fields are byte identities. Never replace invalid UTF-8
  // or strip a BOM before constructing a key, capturing a hash or retiring a job.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const decode = (part: RedisWireReply): RedisTextReply => {
    if (Array.isArray(part)) return part.map(decode);
    if (typeof part === 'number') return part;
    try {
      return decoder.decode(part);
    } catch {
      return fail('REDIS_SHAPE');
    }
  };
  const decoded = decode(wire);
  cost.queueBytes += Math.max(0, Buffer.byteLength(JSON.stringify(decoded)) - bytes);
  budget(cost, deadline);
  return decoded;
}
async function* readJobChunks(
  redis: Redis,
  queue: string,
  ids: readonly string[],
  cost: BacklogCancellationCostV2,
  deadline: number,
): AsyncGenerator<{ ids: readonly string[]; rows: RedisTextReply[] }> {
  budget(cost, deadline);
  const reply = decodeRedisReply(
    await redis.callBuffer(
      'EVAL',
      readJobsLua,
      ids.length,
      ...ids.map((id) => `bull:${queue}:${id}`),
    ),
    cost,
    deadline,
  );
  if (Array.isArray(reply) && reply.length === 1 && reply[0] === 2 && ids.length > 1) {
    const middle = Math.ceil(ids.length / 2);
    yield* readJobChunks(redis, queue, ids.slice(0, middle), cost, deadline);
    yield* readJobChunks(redis, queue, ids.slice(middle), cost, deadline);
    return;
  }
  if (!Array.isArray(reply) || reply[0] !== 1 || !Array.isArray(reply[1]))
    fail(Array.isArray(reply) && reply[1] === 'REDIS_OVERSIZE' ? 'REDIS_OVERSIZE' : 'REDIS_SHAPE');
  if (reply[1].length !== ids.length) fail('REDIS_SHAPE');
  yield { ids, rows: reply[1] };
}
function parseObject(raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined) return null;
  try {
    return object(JSON.parse(raw));
  } catch {
    return null;
  }
}
function originalSource(data: MaxActionJob): SourceIdentity | null {
  readLegacyActionSourceScopes(data);
  const context = object(data.ledgerContext);
  const found: SourceIdentity[] = [];
  const identity = (value: unknown): value is string =>
    typeof value === 'string' &&
    !!value &&
    value.trim() === value &&
    Buffer.byteLength(value) <= 1024;
  for (const key of [
    'moderationSource',
    'moderationRuleNotice',
    'requiredSubscriptionNotice',
    'duplicateNotice',
  ]) {
    if (!context || !Object.hasOwn(context, key)) continue;
    let proof: SourceIdentity | null = null;
    if (key === 'moderationSource') {
      const value = object(context[key]);
      if (
        value &&
        Object.keys(value).sort().join(',') === 'chatId,messageId,userId,version' &&
        value.version === 1 &&
        [value.chatId, value.messageId, value.userId].every(identity)
      )
        proof = value as SourceIdentity;
    } else if (key === 'moderationRuleNotice')
      proof = readMaxModerationRuleNoticeProof(context[key]);
    else if (key === 'requiredSubscriptionNotice')
      proof = readRequiredSubscriptionNoticeAuthority(context[key]);
    else {
      const value = readMessageDuplicateNoticeProof(context[key]);
      if (value)
        proof = {
          chatId: value.chatId,
          messageId: value.binding.messageId,
          userId: value.binding.senderId,
        };
    }
    if (
      !proof ||
      ![proof.chatId, proof.messageId, proof.userId].every(identity) ||
      proof.chatId !== data.chatId
    )
      fail('UNSUPPORTED_CHILD');
    found.push({ chatId: proof.chatId, messageId: proof.messageId, userId: proof.userId });
  }
  if (
    found.length > 1 &&
    found.some(
      (value) => backlogCancellationDigestV2(value) !== backlogCancellationDigestV2(found[0]),
    )
  )
    fail('UNSUPPORTED_CHILD');
  return found[0] ?? null;
}
function protectedJob(
  data: Record<string, unknown> | null,
  opts: Record<string, unknown> | null,
): boolean {
  return Boolean(
    data?.sourceTag === 'managed_broadcast' ||
    /publication|publisher/u.test(String(data?.sourceTag ?? '')) ||
    String(data?.idempotencyKey ?? '').startsWith('publisher-') ||
    object(data?.routing)?.purpose === 'publisher_exact_send' ||
    object(data?.ledgerContext)?.managedBroadcast ||
    object(data?.ledgerContext)?.publication ||
    data?.scheduledFor ||
    (!data?.sendAutoDelete && Number(opts?.delay ?? 0) > 0),
  );
}
function child(
  job: RawJob,
  receiptIds: Set<string>,
  sources: Set<string>,
  sendParents: ReadonlyMap<string, SendParent>,
): BacklogCancellationChildProofV2 | null {
  const data = parseObject(job.hash.data);
  const opts = parseObject(job.hash.opts);
  if (!data || !opts) fail('REDIS_SHAPE', { queue: job.queue, jobId: job.id });
  let kind: BacklogCancellationChildProofV2['kind'];
  let childKey: string;
  let sourceReason: BacklogCancellationChildProofV2['sourceReason'];
  if (webhookQueues.includes(job.queue as (typeof webhookQueues)[number])) {
    if (typeof data.webhookEventId !== 'string' || !receiptIds.has(data.webhookEventId))
      return null;
    kind = 'WEBHOOK';
    childKey = data.webhookEventId;
    sourceReason = 'EXACT_RECEIPT';
  } else {
    if (protectedJob(data, opts)) return null;
    if (
      typeof data.idempotencyKey !== 'string' ||
      typeof data.chatId !== 'string' ||
      typeof data.actionType !== 'string' ||
      typeof data.createdAt !== 'string'
    )
      return null;
    const recognized = [
      'DELETE_MESSAGE',
      'SEND_MESSAGE',
      'KICK_MEMBER',
      'BAN_MEMBER',
      'UNBAN_MEMBER',
      'TRY_UNBAN_MEMBER',
      'NOTIFY_MODERATORS',
    ].includes(data.actionType);
    const action = data as MaxActionJob;
    const causalSource = originalSource(action);
    if (data.sendAutoDelete) {
      const marker = object(data.sendAutoDelete);
      if (
        !marker ||
        typeof marker.sourceSendJobId !== 'string' ||
        !sendParents.has(marker.sourceSendJobId)
      )
        return null;
      const parent = sendParents.get(marker.sourceSendJobId)!;
      if (
        !isMaxSendAutoDeleteMarker(marker) ||
        action.actionType !== 'DELETE_MESSAGE' ||
        marker.sourceChatId !== parent.chatId ||
        marker.sourceMessageId !== parent.messageId ||
        marker.sourceUserId !== parent.userId ||
        marker.sourceCreatedAt !== parent.createdAt
      )
        fail('UNSUPPORTED_CHILD');
      readLegacyActionSourceScopes(action);
      if (
        typeof marker.sourceChatId !== 'string' ||
        typeof marker.sourceMessageId !== 'string' ||
        !sources.has(backlogCancellationDigestV2([marker.sourceChatId, marker.sourceMessageId]))
      )
        fail('UNSUPPORTED_CHILD');
      sourceReason = 'EXACT_SEND_PARENT';
    } else if (
      causalSource &&
      sources.has(backlogCancellationDigestV2([causalSource.chatId, causalSource.messageId]))
    )
      sourceReason = 'ORIGINAL_SOURCE';
    else if (
      data.actionType === 'DELETE_MESSAGE' &&
      typeof data.messageId === 'string' &&
      sources.has(backlogCancellationDigestV2([data.chatId, data.messageId]))
    ) {
      if (
        causalSource &&
        (causalSource.chatId !== data.chatId || causalSource.messageId !== data.messageId)
      )
        fail('UNSUPPORTED_CHILD');
      sourceReason = 'DIRECT_DELETE';
    } else return null;
    if (!recognized || !Number.isFinite(Date.parse(data.createdAt)))
      fail('UNSUPPORTED_CHILD', { queue: job.queue, jobId: job.id });
    kind = 'MAX_ACTION';
    childKey = data.idempotencyKey;
  }
  if (job.hash.parentKey || opts.parent || opts.repeat || job.hash.rjk || job.hash.repeatJobKey)
    fail('UNSUPPORTED_CHILD', { queue: job.queue, jobId: job.id });
  return {
    queue: job.queue,
    jobId: job.id,
    kind,
    childKey,
    sourceReason,
    authoritySha256: backlogCancellationDigestV2({
      data,
      opts,
      name: job.hash.name,
      timestamp: job.hash.timestamp,
    }),
  };
}
async function walkQueues(
  redis: Redis,
  selectedScope: Scope,
  cost: BacklogCancellationCostV2,
  kept: BacklogCancellationRetainedV2,
  deadline: number,
  visitor?: (selected: SelectedJob) => Promise<boolean>,
  knownSendParents: ReadonlyMap<string, SendParent> = new Map(),
): Promise<Map<string, SelectedJob>> {
  const receiptIds = new Set(selectedScope.receipts.keys());
  const sources = new Set(
    selectedScope.roots
      .filter(({ proof }) => proof.chatId !== null)
      .map(({ proof }) => backlogCancellationDigestV2([proof.chatId, proof.messageId])),
  );
  const selected = new Map<string, SelectedJob>();
  const deferred: RawJob[] = [];
  const sendParents = new Map(knownSendParents);
  const actionKeys = new Set<string>();
  let selectedBytes = 0;
  let deferredBytes = 0;
  const visit = async (job: RawJob): Promise<boolean> => {
    const proof = child(job, receiptIds, sources, sendParents);
    if (!proof) {
      kept.unattributedJobs++;
      return false;
    }
    const key = `${job.queue}\u0000${job.id}`;
    if (selected.has(key)) return false;
    if (proof.kind === 'MAX_ACTION' && actionKeys.has(proof.childKey))
      fail('CHILD_DRIFT', { queue: job.queue, jobId: job.id });
    if (proof.kind === 'MAX_ACTION') actionKeys.add(proof.childKey);
    selectedBytes += Buffer.byteLength(JSON.stringify(job));
    if (
      selected.size >= limits.selectedChildren ||
      selectedBytes + deferredBytes > 64 * 1024 * 1024
    )
      fail('BUDGET');
    if (proof.kind === 'MAX_ACTION') capturedJobSnapshot(proof, job);
    selected.set(key, { proof, job });
    if (job.locked) kept.lockedJobs++;
    const data = parseObject(job.hash.data);
    if (proof.kind === 'MAX_ACTION' && data?.actionType === 'SEND_MESSAGE') {
      const parent = originalSource(data as MaxActionJob);
      if (!parent || typeof data.createdAt !== 'string') fail('UNSUPPORTED_CHILD');
      sendParents.set(proof.childKey, { ...parent, createdAt: data.createdAt });
    }
    return visitor ? visitor({ proof, job }) : false;
  };
  for (const queue of queues) {
    for (const state of states) {
      let offset = 0;
      while (true) {
        cost.queuePages++;
        budget(cost, deadline);
        const key = `bull:${queue}:${state}`;
        const idReply: unknown = decodeRedisReply(
          await redis.callBuffer(
            'EVAL',
            readIdsLua,
            1,
            key,
            ['wait', 'paused', 'active'].includes(state) ? 'list' : 'zset',
            offset,
            offset + limits.queuePage - 1,
          ),
          cost,
          deadline,
        );
        if (
          Array.isArray(idReply) &&
          idReply[0] !== 1 &&
          Number.isSafeInteger(idReply[2]) &&
          Number(idReply[2]) >= 0 &&
          Number(idReply[2]) <= limits.queuePage
        ) {
          cost.queueJobs += Number(idReply[2]);
          budget(cost, deadline);
        }
        if (!Array.isArray(idReply) || idReply[0] !== 1 || !Array.isArray(idReply[1]))
          fail(
            Array.isArray(idReply) && idReply[1] === 'REDIS_OVERSIZE'
              ? 'REDIS_OVERSIZE'
              : 'REDIS_SHAPE',
          );
        const ids = idReply[1] as string[];
        if (!ids.length) break;
        if (
          ids.some(
            (id) =>
              typeof id !== 'string' ||
              !id ||
              Buffer.byteLength(id) > 512 ||
              hasBacklogCancellationControlsV2(id),
          )
        )
          fail('REDIS_SHAPE');
        cost.queueJobs += ids.length;
        budget(cost, deadline);
        let removed = 0;
        for await (const chunk of readJobChunks(redis, queue, ids, cost, deadline)) {
          for (let index = 0; index < chunk.rows.length; index++) {
            const item: unknown = chunk.rows[index];
            if (!Array.isArray(item) || !Array.isArray(item[1]) || item[1].length % 2)
              fail('REDIS_SHAPE');
            if (!item[1].length) continue;
            const hash = Object.create(null) as Record<string, string>;
            for (let at = 0; at < item[1].length; at += 2) {
              if (typeof item[1][at] !== 'string' || typeof item[1][at + 1] !== 'string')
                fail('REDIS_SHAPE');
              hash[item[1][at]] = item[1][at + 1];
            }
            const job: RawJob = { queue, id: chunk.ids[index]!, hash, locked: item[2] === 1 };
            const data = parseObject(hash.data);
            const opts = parseObject(hash.opts);
            if (
              opts?.repeat ||
              opts?.parent ||
              job.hash.parentKey ||
              job.hash.rjk ||
              job.hash.repeatJobKey ||
              (actionQueues.includes(queue) && protectedJob(data, opts))
            ) {
              kept.protectedJobs++;
              continue;
            }
            if (data?.sendAutoDelete) {
              const marker = object(data.sendAutoDelete);
              if (
                !marker ||
                typeof marker.sourceChatId !== 'string' ||
                typeof marker.sourceMessageId !== 'string' ||
                !sources.has(
                  backlogCancellationDigestV2([marker.sourceChatId, marker.sourceMessageId]),
                )
              ) {
                kept.unattributedJobs++;
                continue;
              }
              deferredBytes += Buffer.byteLength(JSON.stringify(job));
              if (
                deferred.length >= limits.selectedChildren ||
                selectedBytes + deferredBytes > 64 * 1024 * 1024
              )
                fail('BUDGET');
              deferred.push(job);
            } else if (await visit(job)) removed++;
          }
        }
        offset += ids.length - removed;
      }
    }
  }
  for (const job of deferred) {
    deferredBytes -= Buffer.byteLength(JSON.stringify(job));
    await visit(job);
  }
  return selected;
}

function receiptProofs(value: Scope) {
  const roots = new Set(value.roots.map(({ proof }) => proof.receiptId));
  return [...value.receipts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([receiptId, snapshot]) => ({
      receiptId,
      identitySha256: identityDigest(snapshot, roots.has(receiptId)),
    }));
}
function childProofs(value: Map<string, SelectedJob>) {
  return [...value].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row.proof);
}
function approvedJobKey(proof: BacklogCancellationChildProofV2): string {
  return `${proof.queue}\u0000${proof.jobId}`;
}
function decodeCapturedJob(value: unknown): RawJob {
  const envelope = object(value);
  if (
    !envelope ||
    Object.keys(envelope).sort().join(',') !== 'format,jsonUtf8Base64' ||
    envelope.format !== 'BULLMQ_JOB_JSON_UTF8_BASE64_V1' ||
    typeof envelope.jsonUtf8Base64 !== 'string' ||
    envelope.jsonUtf8Base64.length > portableEnvelopeBytes ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(envelope.jsonUtf8Base64)
  )
    fail('EVIDENCE_MISMATCH');
  const bytes = Buffer.from(envelope.jsonUtf8Base64, 'base64');
  if (bytes.toString('base64') !== envelope.jsonUtf8Base64 || bytes.length > portableDecodedBytes)
    fail('EVIDENCE_MISMATCH');
  let decoded: Record<string, unknown> | null = null;
  try {
    decoded = object(JSON.parse(bytes.toString('utf8')));
  } catch {
    fail('EVIDENCE_MISMATCH');
  }
  if (
    !decoded ||
    Object.keys(decoded).sort().join(',') !== 'authoritySha256,hash,jobId,queue,version' ||
    decoded.version !== 2 ||
    typeof decoded.queue !== 'string' ||
    !actionQueues.includes(decoded.queue) ||
    typeof decoded.jobId !== 'string' ||
    typeof decoded.authoritySha256 !== 'string'
  )
    fail('EVIDENCE_MISMATCH');
  const hash = object(decoded.hash);
  if (
    !hash ||
    Object.keys(hash).length > limits.jobFields ||
    Object.entries(hash).some(
      ([key, value]) => Buffer.byteLength(key) > 512 || typeof value !== 'string',
    ) ||
    Object.entries(hash).reduce(
      (total, [key, value]) =>
        total + Buffer.byteLength(key) + Buffer.byteLength(String(value)) + 16,
      0,
    ) > limits.jobBytes
  )
    fail('EVIDENCE_MISMATCH');
  const job: RawJob = {
    queue: decoded.queue,
    id: decoded.jobId,
    hash: hash as Record<string, string>,
    locked: false,
  };
  if (
    decoded.authoritySha256 !==
    backlogCancellationDigestV2({
      data: parseObject(job.hash.data),
      opts: parseObject(job.hash.opts),
      name: job.hash.name,
      timestamp: job.hash.timestamp,
    })
  )
    fail('EVIDENCE_MISMATCH');
  return job;
}
function capturedJobSnapshot(proof: BacklogCancellationChildProofV2, job: RawJob): string {
  const value = backlogJobSnapshot({
    version: 2,
    queue: job.queue,
    jobId: job.id,
    authoritySha256: proof.authoritySha256,
    hash: job.hash,
  });
  if (
    Buffer.byteLength(value) > portableEnvelopeBytes ||
    backlogCancellationDigestV2(decodeCapturedJob(JSON.parse(value))) !==
      backlogCancellationDigestV2({ ...job, locked: false })
  )
    fail('EVIDENCE_MISMATCH');
  return value;
}
async function capturedChildren(
  db: Database,
  operation: string,
  preview: BacklogCancellationPreviewV2,
  selectedScope: Scope,
  cost: BacklogCancellationCostV2,
  deadline: number,
): Promise<{ jobs: Map<string, SelectedJob>; sendParents: Map<string, SendParent> }> {
  const rows = await readOnly(
    db,
    async (tx) => {
      await requireOperationIndex(tx, operation, cost, deadline);
      const headers = await query<{ kind: string; childKey: string; size: number }>(
        tx,
        operationChildrenSql(operation),
        cost,
        deadline,
      );
      if (
        headers.length > limits.selectedChildren ||
        headers.reduce((sum, row) => sum + row.size, 0) > limits.sqlBytes ||
        headers.some((row) => row.size > portableEnvelopeBytes)
      )
        fail('BUDGET');
      return query<{ kind: string; childKey: string; originalSnapshot: Prisma.JsonValue }>(
        tx,
        operationChildrenSql(operation, 'snapshot'),
        cost,
        deadline,
      );
    },
    cost,
    deadline,
  );
  const expected = new Map(
    preview.children
      .filter((row) => row.kind === 'MAX_ACTION')
      .map((row) => [approvedJobKey(row), row]),
  );
  const jobs = new Map<string, SelectedJob>();
  const receiptIds = new Set(selectedScope.receipts.keys());
  const sources = new Set(
    selectedScope.roots
      .filter(({ proof }) => proof.chatId !== null)
      .map(({ proof }) => backlogCancellationDigestV2([proof.chatId, proof.messageId])),
  );
  const sendParents = new Map<string, SendParent>();
  const decoded = rows.map((row) => ({ row, job: decodeCapturedJob(row.originalSnapshot) }));
  // FLAG: Only independently attributed, approved SEND snapshots may supply a lost parent.
  for (const { row, job } of decoded) {
    if (parseObject(job.hash.data)?.actionType !== 'SEND_MESSAGE') continue;
    const proof = child(job, receiptIds, sources, new Map());
    if (
      row.kind !== 'MAX_ACTION' ||
      !proof ||
      row.childKey !== proof.childKey ||
      backlogCancellationDigestV2(expected.get(approvedJobKey(proof))) !==
        backlogCancellationDigestV2(proof)
    )
      fail('EVIDENCE_MISMATCH');
    const data = parseObject(job.hash.data)!;
    const parent = originalSource(data as MaxActionJob);
    if (!parent || typeof data.createdAt !== 'string') fail('EVIDENCE_MISMATCH');
    sendParents.set(proof.childKey, { ...parent, createdAt: data.createdAt });
  }
  for (const { row, job } of decoded) {
    const proof = child(job, receiptIds, sources, sendParents);
    if (
      row.kind !== 'MAX_ACTION' ||
      !proof ||
      row.childKey !== proof.childKey ||
      jobs.has(approvedJobKey(proof)) ||
      backlogCancellationDigestV2(expected.get(approvedJobKey(proof))) !==
        backlogCancellationDigestV2(proof)
    )
      fail('EVIDENCE_MISMATCH');
    jobs.set(approvedJobKey(proof), { proof, job });
  }
  return { jobs, sendParents };
}
async function assertChildOwnership(
  db: Database,
  jobs: Map<string, SelectedJob>,
  operation: string,
  cost: BacklogCancellationCostV2,
  deadline: number,
): Promise<void> {
  await readOnly(
    db,
    async (tx) => {
      for (const { proof } of jobs.values()) {
        if (proof.kind !== 'MAX_ACTION') continue;
        observeSql(cost, `child:MAX_ACTION:${proof.childKey}`, deadline);
        const [row] = await query<{ operation: string }>(
          tx,
          Prisma.sql`SELECT cancellation_id AS operation FROM webhook_backlog_children WHERE kind='MAX_ACTION' AND child_key=${proof.childKey}`,
          cost,
          deadline,
        );
        if (row && row.operation !== operation)
          fail('FOREIGN_HOLD', { queue: proof.queue, jobId: proof.jobId });
      }
    },
    cost,
    deadline,
  );
}
function assertInputs(
  nomination: BacklogCancellationNominationV2,
  request: BacklogCancellationApplyV2,
  preview: BacklogCancellationPreviewV2,
  bindings: BacklogCancellationBindingsV2,
): void {
  parseBacklogCancellationNominationV2(backlogCancellationBytesV2(nomination));
  parseBacklogCancellationApplyV2(backlogCancellationBytesV2(request));
  validateBacklogCancellationPreviewV2(preview);
  validateBacklogCancellationBindingsV2(bindings);
  if (
    preview.decision !== 'READY' ||
    !preview.complete ||
    preview.issues.length ||
    backlogCancellationDigestV2(preview) !== request.previewSha256 ||
    preview.nominationSha256 !== backlogCancellationDigestV2(nomination) ||
    backlogCancellationDigestV2(bindings) !== backlogCancellationDigestV2(preview.bindings) ||
    ['id', 'cutoff', 'sourceSha', 'imageId'].some(
      (key) =>
        Reflect.get(nomination, key) !== Reflect.get(request, key) ||
        Reflect.get(nomination, key) !== Reflect.get(preview, key),
    ) ||
    nomination.rootIds.join('\u0000') !== preview.roots.map((row) => row.receiptId).join('\u0000')
  )
    fail('IDENTITY_MISMATCH');
}
export async function previewTargetedBacklogCancellation(
  db: Database,
  redis: Redis,
  nomination: BacklogCancellationNominationV2,
  bindings: BacklogCancellationBindingsV2,
  progress: Progress = () => {},
  deadline = Date.now() + limits.clientMs,
): Promise<BacklogCancellationPreviewV2> {
  parseBacklogCancellationNominationV2(backlogCancellationBytesV2(nomination));
  validateBacklogCancellationBindingsV2(bindings);
  const result: BacklogCancellationPreviewV2 = {
    version: 2,
    kind: 'BACKLOG_CANCELLATION_PREVIEW',
    id: nomination.id,
    cutoff: nomination.cutoff,
    sourceSha: nomination.sourceSha,
    imageId: nomination.imageId,
    nominationSha256: backlogCancellationDigestV2(nomination),
    bindings,
    familyPolicy: 'EXACT_OBSERVED_PENDING_FAMILY_V1',
    childPolicy: 'EXACT_SOURCE_CHILD_V1',
    snapshotAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    decision: 'DENY',
    complete: false,
    nonAtomicOnline: true,
    stoppedRevalidationRequired: true,
    roots: [],
    receipts: [],
    children: [],
    retained: retained(),
    cost: counter(),
    issues: [],
  };
  try {
    const existing = await measureDb(result.cost, deadline, () =>
      db.webhookBacklogCancellation.findUnique({
        where: { id: nomination.id },
        select: { id: true },
      }),
    );
    if (existing) fail('OPERATION_EXISTS');
    const selectedScope = await scope(db, nomination, result.cost, result.retained, deadline);
    result.roots = selectedScope.roots.map(({ proof }) => proof);
    result.receipts = receiptProofs(selectedScope);
    progress({ phase: 'PREVIEW_SQL_COMPLETE', count: result.receipts.length });
    const selectedJobs = await walkQueues(
      redis,
      selectedScope,
      result.cost,
      result.retained,
      deadline,
    );
    await assertChildOwnership(db, selectedJobs, nomination.id, result.cost, deadline);
    result.children = childProofs(selectedJobs);
    result.complete = true;
    result.decision = 'READY';
  } catch (error) {
    result.issues.push(issue(error));
  }
  result.completedAt = new Date().toISOString();
  return validateBacklogCancellationPreviewV2(result);
}
export async function preflightTargetedBacklogCancellation(
  db: Database,
  nomination: BacklogCancellationNominationV2,
  request: BacklogCancellationApplyV2,
  preview: BacklogCancellationPreviewV2,
  bindings: BacklogCancellationBindingsV2,
  deadline = Date.now() + 120_000,
): Promise<BacklogCancellationPreflightV2> {
  const result: BacklogCancellationPreflightV2 = {
    version: 2,
    kind: 'BACKLOG_CANCELLATION_PREFLIGHT',
    id: request.id,
    previewSha256: request.previewSha256,
    valid: false,
  };
  assertInputs(nomination, request, preview, bindings);
  const current = await scope(db, nomination, counter(), retained(), deadline, true);
  result.valid =
    backlogCancellationDigestV2(current.roots.map(({ proof }) => proof)) ===
    backlogCancellationDigestV2(preview.roots);
  return result;
}
export async function proveTargetedBacklogCancellationAbsent(
  db: Database,
  request: BacklogCancellationApplyV2,
): Promise<BacklogCancellationNoWriteProofV2> {
  parseBacklogCancellationApplyV2(backlogCancellationBytesV2(request));
  const operationAbsent = await readOnly(
    db,
    async (tx) =>
      !(await tx.webhookBacklogCancellation.findUnique({
        where: { id: request.id },
        select: { id: true },
      })),
  );
  return {
    version: 2,
    kind: 'BACKLOG_CANCELLATION_NO_WRITE_PROOF',
    id: request.id,
    previewSha256: request.previewSha256,
    operationAbsent,
  };
}
export async function applyTargetedBacklogCancellation(
  db: Database,
  redis: Redis,
  nomination: BacklogCancellationNominationV2,
  request: BacklogCancellationApplyV2,
  preview: BacklogCancellationPreviewV2,
  bindings: BacklogCancellationBindingsV2,
  progress: Progress = () => {},
  deadline = Date.now() + limits.clientMs,
): Promise<BacklogCancellationApplyResultV2> {
  const result: BacklogCancellationApplyResultV2 = {
    version: 2,
    kind: 'BACKLOG_CANCELLATION_APPLY_RESULT',
    id: request.id,
    previewSha256: request.previewSha256,
    outcome: 'REFUSED_UNWRITTEN',
    operationExists: false,
    sealed: false,
    counts: {
      receipts: 0,
      projected: 0,
      children: 0,
      removed: 0,
      retainedLocked: 0,
      missingJobs: 0,
    },
    issues: [],
  };
  const cost = counter();
  try {
    assertInputs(nomination, request, preview, bindings);
    const existing = await measureDb(cost, deadline, () =>
      db.webhookBacklogCancellation.findUnique({ where: { id: request.id } }),
    );
    if (
      existing &&
      (existing.cutoff.toISOString() !== request.cutoff ||
        existing.sourceSha !== request.sourceSha ||
        existing.imageId !== request.imageId)
    )
      fail('IDENTITY_MISMATCH');
    result.operationExists = Boolean(existing);
    result.sealed = Boolean(existing?.sealedAt);
    const selectedScope = await scope(db, nomination, cost, retained(), deadline);
    if (
      backlogCancellationDigestV2(selectedScope.roots.map(({ proof }) => proof)) !==
        backlogCancellationDigestV2(preview.roots) ||
      backlogCancellationDigestV2(receiptProofs(selectedScope)) !==
        backlogCancellationDigestV2(preview.receipts)
    )
      fail('SCOPE_DRIFT');
    const captured = await capturedChildren(db, request.id, preview, selectedScope, cost, deadline);
    const selectedJobs = await walkQueues(
      redis,
      selectedScope,
      cost,
      retained(),
      deadline,
      undefined,
      captured.sendParents,
    );
    await assertChildOwnership(db, selectedJobs, request.id, cost, deadline);
    const currentProofs = childProofs(selectedJobs);
    const expectedByKey = new Map(
      preview.children.map((row) => [`${row.queue}\u0000${row.jobId}`, row]),
    );
    for (const proof of currentProofs) {
      if (
        backlogCancellationDigestV2(expectedByKey.get(`${proof.queue}\u0000${proof.jobId}`)) !==
        backlogCancellationDigestV2(proof)
      )
        fail('CHILD_DRIFT');
    }
    for (const proof of preview.children) {
      if (selectedJobs.has(`${proof.queue}\u0000${proof.jobId}`)) continue;
      if (
        !existing?.sealedAt ||
        (proof.kind === 'MAX_ACTION' && !captured.jobs.has(approvedJobKey(proof)))
      )
        fail('CHILD_DRIFT');
      result.counts.missingJobs++;
    }
    const captureBytes = [...selectedJobs.values()].reduce(
      (sum, { proof, job }) =>
        sum +
        (proof.kind === 'MAX_ACTION' ? Buffer.byteLength(capturedJobSnapshot(proof, job)) : 0),
      0,
    );
    const receiptBytes = Buffer.byteLength(JSON.stringify([...selectedScope.receipts.values()]));
    if (cost.sqlBytes + captureBytes * 5 + receiptBytes * 3 > limits.sqlBytes) fail('BUDGET');
    // FLAG: Stock projection is unchanged; reserve its exact calls and bounded ID/status replies.
    const projectionPages = Math.ceil(preview.receipts.length / 200);
    cost.sqlCalls += projectionPages * 3 + 1;
    cost.sqlBytes +=
      2 *
        Buffer.byteLength(
          JSON.stringify(preview.receipts.map(({ receiptId }) => ({ receiptId }))),
        ) +
      64 * preview.receipts.length +
      256 * projectionPages +
      1;
    budget(cost, deadline);
    progress({ phase: 'STOPPED_REVALIDATED', count: selectedScope.receipts.size });
    await confirmEraserSourceHolds(
      db,
      [...selectedScope.receipts.values()]
        .map((row) => backlogSource(row.normalized_payload))
        .flatMap((source) =>
          source.chatId && source.messageId
            ? [{ chatId: source.chatId, messageId: source.messageId }]
            : [],
        ),
    );
    await measureDb(cost, deadline, () =>
      db.$executeRaw(Prisma.sql`INSERT INTO webhook_backlog_cancellations (id,cutoff,source_sha,image_id)
      VALUES (${request.id},${new Date(request.cutoff)},${request.sourceSha},${request.imageId}) ON CONFLICT(id) DO NOTHING`),
    );
    result.operationExists = true;
    progress({ phase: 'OPERATION_CREATED' });
    for (const [id] of selectedScope.receipts) {
      budget(cost, deadline);
      await measureDb(cost, deadline, () =>
        db.$executeRaw(Prisma.sql`INSERT INTO webhook_backlog_receipts
        (receipt_id,cancellation_id,semantic_key,chat_id,message_id,original_snapshot)
        SELECT id,${request.id},${backlogSource(selectedScope.receipts.get(id)!.normalized_payload).semanticKey},
          ${backlogSource(selectedScope.receipts.get(id)!.normalized_payload).chatId},
          ${backlogSource(selectedScope.receipts.get(id)!.normalized_payload).messageId},to_jsonb(e)
        FROM webhook_events e WHERE id=${id} ON CONFLICT(receipt_id) DO NOTHING`),
      );
    }
    const capturedScope = await scope(db, nomination, cost, retained(), deadline);
    if (
      backlogCancellationDigestV2(receiptProofs(capturedScope)) !==
      backlogCancellationDigestV2(preview.receipts)
    )
      fail('EVIDENCE_MISMATCH');
    const exactOwnReceipts = await measureDb(cost, deadline, () =>
      db.webhookBacklogReceipt.findMany({
        where: { cancellationId: request.id },
        select: { receiptId: true },
        take: limits.sqlRows + 1,
        orderBy: { receiptId: 'asc' },
      }),
    );
    exactOwnReceipts.sort((a, b) =>
      a.receiptId < b.receiptId ? -1 : a.receiptId > b.receiptId ? 1 : 0,
    );
    if (
      exactOwnReceipts.length !== preview.receipts.length ||
      exactOwnReceipts.some((row, index) => row.receiptId !== preview.receipts[index]?.receiptId)
    )
      fail('EVIDENCE_MISMATCH');
    result.counts.receipts = selectedScope.receipts.size;
    progress({ phase: 'RECEIPTS_CAPTURED', count: result.counts.receipts });
    for (const { proof, job } of selectedJobs.values()) {
      if (proof.kind !== 'MAX_ACTION') continue;
      const snapshot = capturedJobSnapshot(proof, job);
      await measureDb(cost, deadline, () =>
        db.$executeRaw(Prisma.sql`INSERT INTO webhook_backlog_children(kind,child_key,cancellation_id,original_snapshot)
        VALUES ('MAX_ACTION',${proof.childKey},${request.id},${snapshot}::jsonb) ON CONFLICT(kind,child_key) DO NOTHING`),
      );
      const saved = await measureDb(cost, deadline, () =>
        db.webhookBacklogChild.findUniqueOrThrow({
          where: { kind_childKey: { kind: 'MAX_ACTION', childKey: proof.childKey } },
        }),
      );
      if (
        saved.cancellationId !== request.id ||
        (captured.jobs.has(approvedJobKey(proof))
          ? backlogCancellationDigestV2(decodeCapturedJob(saved.originalSnapshot)) !==
            backlogCancellationDigestV2(captured.jobs.get(approvedJobKey(proof))!.job)
          : backlogCancellationDigestV2(saved.originalSnapshot) !==
            backlogCancellationDigestV2(JSON.parse(snapshot)))
      )
        fail('EVIDENCE_MISMATCH');
    }
    const finalCaptured = await capturedChildren(
      db,
      request.id,
      preview,
      selectedScope,
      cost,
      deadline,
    );
    result.counts.children = preview.children.filter((row) => row.kind === 'MAX_ACTION').length;
    if (finalCaptured.jobs.size !== result.counts.children) fail('EVIDENCE_MISMATCH');
    progress({ phase: 'CHILDREN_CAPTURED', count: result.counts.children });
    await measureDb(cost, deadline, () =>
      db.$executeRaw(Prisma.sql`UPDATE webhook_backlog_cancellations SET sealed_at=clock_timestamp() AT TIME ZONE 'UTC'
      WHERE id=${request.id} AND sealed_at IS NULL`),
    );
    result.sealed = true;
    progress({ phase: 'SEALED' });
    result.counts.projected = await projectBacklogReceipts(
      db,
      request.id,
      (value) => progress({ phase: String(Reflect.get(value, 'phase') ?? 'PROJECTING') }),
      deadline,
    );
    const byQueue = new Map<string, Queue>();
    try {
      await walkQueues(
        redis,
        selectedScope,
        counter(),
        retained(),
        deadline,
        async ({ proof, job }) => {
          if (
            !expectedByKey.has(`${proof.queue}\u0000${proof.jobId}`) ||
            backlogCancellationDigestV2(expectedByKey.get(`${proof.queue}\u0000${proof.jobId}`)) !==
              backlogCancellationDigestV2(proof)
          )
            fail('CHILD_DRIFT');
          const owned = await measureDb(cost, deadline, async () =>
            proof.kind === 'WEBHOOK'
              ? await db.webhookBacklogReceipt.findFirst({
                  where: { receiptId: proof.childKey, cancellationId: request.id },
                })
              : await db.webhookBacklogChild.findFirst({
                  where: {
                    kind: 'MAX_ACTION',
                    childKey: proof.childKey,
                    cancellationId: request.id,
                  },
                }),
          );
          if (!owned) fail('EVIDENCE_MISMATCH');
          if (job.locked) {
            result.counts.retainedLocked++;
            return false;
          }
          let queue = byQueue.get(job.queue);
          if (!queue) {
            queue = new Queue(job.queue, {
              connection: redis as unknown as ConnectionOptions,
              skipMetasUpdate: true,
            });
            byQueue.set(job.queue, queue);
          }
          const actual = await queue.getJob(job.id);
          if (!actual) {
            result.counts.missingJobs++;
            return false;
          }
          try {
            await actual.remove();
            result.counts.removed++;
            if (result.counts.removed === 1 || result.counts.removed % 100 === 0)
              progress({ phase: 'JOB_RETIRED', count: result.counts.removed });
            return true;
          } catch (error) {
            if (error instanceof Error && error.message.includes('locked')) {
              result.counts.retainedLocked++;
              return false;
            }
            throw error;
          }
        },
        finalCaptured.sendParents,
      );
    } finally {
      await Promise.all([...byQueue.values()].map((queue) => queue.close()));
    }
    const finalReceipts = await measureDb(cost, deadline, () =>
      db.webhookEvent.count({
        where: { id: { in: preview.receipts.map((row) => row.receiptId) }, status: 'CANCELLED' },
      }),
    );
    if (finalReceipts !== preview.receipts.length) fail('EVIDENCE_MISMATCH');
    result.outcome = 'APPLIED';
  } catch (error) {
    result.issues.push(issue(error));
    try {
      const saved = await db.webhookBacklogCancellation.findUnique({
        where: { id: request.id },
        select: { sealedAt: true },
      });
      result.operationExists = Boolean(saved);
      result.sealed = Boolean(saved?.sealedAt);
    } catch {
      result.operationExists = true;
    }
    result.outcome = result.operationExists ? 'INCOMPLETE_WRITTEN' : 'REFUSED_UNWRITTEN';
  }
  return result;
}

async function main(): Promise<void> {
  if (
    process.argv.length !== 4 ||
    !['--preview', '--preflight', '--apply', '--prove-absent'].includes(process.argv[2]!)
  )
    fail('INVALID_INPUT');
  const mode = process.argv[2]!;
  const raw = process.argv[3]!;
  const request =
    mode === '--preview'
      ? parseBacklogCancellationNominationV2(raw)
      : parseBacklogCancellationApplyV2(raw);
  const marker =
    mode === '--preview' || mode === '--preflight'
      ? process.env.MAXIM_BACKLOG_PREVIEW_OPERATION
      : process.env.MAXIM_BACKLOG_COLD_OPERATION;
  if (marker !== request.id) fail('IDENTITY_MISMATCH');
  const db = createPrismaClient(process.env.DATABASE_URL, {
    max: 1,
    application_name: `maxim_backlog_v2_${request.id}`,
    statement_timeout: 5000,
    options: `-c timezone=UTC -c max_parallel_workers_per_gather=0 -c lock_timeout=1000${mode === '--apply' ? '' : ' -c default_transaction_read_only=on'}`,
  });
  let redis: Redis | undefined;
  try {
    if (mode === '--prove-absent') {
      const result = await proveTargetedBacklogCancellationAbsent(
        db,
        request as BacklogCancellationApplyV2,
      );
      process.stdout.write(backlogCancellationBytesV2(result));
      process.exitCode = result.operationAbsent ? 0 : 3;
      return;
    }
    const bindings = validateBacklogCancellationBindingsV2(
      JSON.parse(readFileSync(`${dataDirectory}/bindings.json`, 'utf8')),
    );
    if (mode === '--preflight') {
      const result = await preflightTargetedBacklogCancellation(
        db,
        parseBacklogCancellationNominationV2(
          readFileSync(`${dataDirectory}/nomination.json`, 'utf8'),
        ),
        request as BacklogCancellationApplyV2,
        validateBacklogCancellationPreviewV2(
          JSON.parse(readFileSync(`${dataDirectory}/preview.json`, 'utf8')),
        ),
        bindings,
      );
      process.stdout.write(backlogCancellationBytesV2(result));
      process.exitCode = result.valid ? 0 : 2;
      return;
    }
    redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 1,
      commandTimeout: 5000,
      connectTimeout: 5000,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    await redis.connect();
    const progress: Progress = (value) => process.stderr.write(`${JSON.stringify(value)}\n`);
    if (mode === '--preview') {
      const result = await previewTargetedBacklogCancellation(
        db,
        redis,
        request as BacklogCancellationNominationV2,
        bindings,
        progress,
      );
      process.stdout.write(backlogCancellationBytesV2(result));
      process.exitCode = result.decision === 'READY' ? 0 : 2;
    } else {
      const result = await applyTargetedBacklogCancellation(
        db,
        redis,
        parseBacklogCancellationNominationV2(
          readFileSync(`${dataDirectory}/nomination.json`, 'utf8'),
        ),
        request as BacklogCancellationApplyV2,
        validateBacklogCancellationPreviewV2(
          JSON.parse(readFileSync(`${dataDirectory}/preview.json`, 'utf8')),
        ),
        bindings,
        progress,
      );
      process.stdout.write(backlogCancellationBytesV2(result));
      process.exitCode = result.outcome === 'APPLIED' ? 0 : result.operationExists ? 3 : 2;
    }
  } finally {
    if (redis) await redis.quit();
    await db.$disconnect();
  }
}
if (require.main === module)
  main().catch((error: unknown) => {
    process.stdout.write(
      backlogCancellationBytesV2({
        version: 2,
        kind: 'BACKLOG_CANCELLATION_ERROR',
        code: issue(error).code,
      }),
    );
    process.exitCode = 3;
  });
