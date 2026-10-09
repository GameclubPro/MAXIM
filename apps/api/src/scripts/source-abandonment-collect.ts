import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import Redis from 'ioredis';
import { Prisma, createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { LEGACY_RECOVERY_LIVE_BUDGET } from './legacy-recovery-live-budget';
import type { LegacyRecoveryAdmissionOutput } from './legacy-recovery-admission-preview';
import {
  assertSourceAbandonmentCatalogProofs,
  type SourceAbandonmentCatalogProof,
} from './source-abandonment-redis-catalog';
import type { LegacyRecoveryLiveIssue } from './legacy-recovery-live-protocol';
import {
  SOURCE_ABANDONMENT_OUTPUT_MAX_BYTES,
  SOURCE_ABANDONMENT_REQUEST_MAX_BYTES,
  SOURCE_ABANDONMENT_OBSERVATION_QUEUE,
  SOURCE_ABANDONMENT_CHANNEL_MARKER_QUEUE,
  sourceAbandonmentDigest,
  parseSourceAbandonmentLiveRequest,
  parseSourceAbandonmentAdmissionRequest,
  buildSourceAbandonmentPreviewDigest,
  buildSourceAbandonmentInventoryDigest,
  type SourceAbandonmentLiveRequest,
  type SourceAbandonmentAdmissionRequest,
  type SourceAbandonmentLiveSelection,
  type SourceAbandonmentLiveOutput,
  type SourceAbandonmentChildEvidence,
} from './source-abandonment-live-protocol';
import { sourceAbandonmentSourceClosureDigest } from './source-abandonment-source-closure';
import {
  inventorySourceAbandonmentSql,
  inventorySourceAbandonmentChildSql,
  sourceAbandonmentSqlResolver,
  type SourceInventoryAllowance,
} from './source-abandonment-live-sql';
import {
  inventorySourceAbandonmentRedis,
  type SourceAbandonmentRedisReader,
} from './source-abandonment-live-redis';

// FLAG: Two independent catalogs each retain their 20-second cap. This collector
// also budgets SQL and exact-job proof; legacy collection and store writes stay unchanged.
const sourceCollectionDurationMs = 45_000;
const sourceCollectionTransactionTimeoutMs = 50_000;

type Cost = { pages: number; rows: number; probes: number; bytes: number };
type SourceAbandonmentAdmissionOutput = Omit<LegacyRecoveryAdmissionOutput, 'selectedOwners'> & {
  selectedOwners: SourceAbandonmentLiveOutput['selectedOwners'];
  redisCatalogs: readonly SourceAbandonmentCatalogProof[];
};
const costFields = ['pages', 'rows', 'probes', 'bytes'] as const;
function remaining(cost: Cost, deadlineAtMs: number): SourceInventoryAllowance {
  if (Date.now() >= deadlineAtMs) throw new Error('Source inventory deadline');
  return {
    pages: LEGACY_RECOVERY_LIVE_BUDGET.pages - cost.pages,
    rows: LEGACY_RECOVERY_LIVE_BUDGET.rows - cost.rows,
    probes: LEGACY_RECOVERY_LIVE_BUDGET.probes - cost.probes,
    bytes: LEGACY_RECOVERY_LIVE_BUDGET.bytes - cost.bytes,
    deadlineAtMs,
  };
}
function charge(cost: Cost, next: Cost): void {
  for (const field of costFields) {
    if (!Number.isSafeInteger(next[field]) || next[field] < 0)
      throw new Error('Source accounting refused');
    cost[field] += next[field];
    if (cost[field] > LEGACY_RECOVERY_LIVE_BUDGET[field]) throw new Error('Source shared budget');
  }
}
function uniqueIssues(issues: readonly LegacyRecoveryLiveIssue[]) {
  return [...new Map(issues.map((row) => [`${row.descriptor}:${row.code}`, row])).values()].sort(
    (a, b) => a.descriptor.localeCompare(b.descriptor) || a.code.localeCompare(b.code),
  );
}
export function mergeSourceAbandonmentChildren(
  groups: readonly (readonly SourceAbandonmentChildEvidence[])[],
): SourceAbandonmentChildEvidence[] {
  const result = new Map<string, SourceAbandonmentChildEvidence>();
  for (const group of groups)
    for (const child of group) {
      const kind =
        child.queueName === SOURCE_ABANDONMENT_OBSERVATION_QUEUE
          ? 'observation'
          : child.queueName === SOURCE_ABANDONMENT_CHANNEL_MARKER_QUEUE
            ? 'channel-auto-post'
            : 'action';
      const key = `${kind}:${child.jobKey}`;
      const prior = result.get(key);
      if (prior && sourceAbandonmentDigest(prior) !== sourceAbandonmentDigest(child))
        throw new Error('Exact child conflict');
      result.set(key, child);
    }
  return [...result.values()].sort(
    (a, b) => a.queueName.localeCompare(b.queueName) || a.jobKey.localeCompare(b.jobKey),
  );
}

// FLAG: Online and offline admission use the same bounded SQL/family/descendant
// and actionable Redis provenance checks. Online evidence never grants stop or install.
async function gather(
  tx: Prisma.TransactionClient,
  redis: SourceAbandonmentRedisReader,
  selection: SourceAbandonmentLiveSelection,
  queueFenceNonce?: string,
  publisherBotId?: string,
) {
  const cost: Cost = { pages: 0, rows: 0, probes: 0, bytes: 0 };
  const deadlineAtMs = Date.now() + sourceCollectionDurationMs;
  const issues: LegacyRecoveryLiveIssue[] = [];
  let sql: Awaited<ReturnType<typeof inventorySourceAbandonmentSql>> | undefined;
  let first: Awaited<ReturnType<typeof inventorySourceAbandonmentRedis>> | undefined;
  let second: Awaited<ReturnType<typeof inventorySourceAbandonmentRedis>> | undefined;
  let childSql: Awaited<ReturnType<typeof inventorySourceAbandonmentChildSql>> | undefined;
  let children: SourceAbandonmentChildEvidence[] = [];
  try {
    sql = await inventorySourceAbandonmentSql(
      tx,
      selection,
      remaining(cost, deadlineAtMs),
      false,
      publisherBotId,
    );
    charge(cost, sql.cost);
    issues.push(...sql.issues);
    if (
      sourceAbandonmentDigest(sql.candidates.map((row) => row.owner.id).sort()) !==
      sourceAbandonmentDigest(selection.ownerWebhookEventIds)
    )
      issues.push({ code: 'selected_owner_proof_incomplete', descriptor: 'sql:selected-source' });
    const sources = sql.candidates.map((candidate) => candidate.source);
    const resolve = sourceAbandonmentSqlResolver(tx);
    first = await inventorySourceAbandonmentRedis(
      redis,
      selection,
      sources,
      remaining(cost, deadlineAtMs),
      resolve,
      queueFenceNonce,
      publisherBotId,
    );
    charge(cost, first.cost);
    issues.push(...first.issues);
    second = await inventorySourceAbandonmentRedis(
      redis,
      selection,
      sources,
      remaining(cost, deadlineAtMs),
      resolve,
      queueFenceNonce,
      publisherBotId,
    );
    charge(cost, second.cost);
    issues.push(...second.issues);
    // FLAG: Stable effect identity excludes only two independent Publisher counts
    // across inventories. Within one cold inventory, both complete raw catalogs
    // must still match exactly and independently satisfy every original budget.
    // Active online queues retain their existing independent-admission behavior.
    if (queueFenceNonce) {
      let catalogsStable = true;
      try {
        assertSourceAbandonmentCatalogProofs([first.catalog, second.catalog]);
      } catch {
        catalogsStable = false;
      }
      if (!catalogsStable || first.stableDigest !== second.stableDigest)
        issues.push({ code: 'redis_inventory_changed', descriptor: 'redis:all' });
    }
    children = mergeSourceAbandonmentChildren([sql.children, first.children, second.children]);
    childSql = await inventorySourceAbandonmentChildSql(
      tx,
      children,
      remaining(cost, deadlineAtMs),
    );
    charge(cost, childSql.cost);
    issues.push(...childSql.issues);
    remaining(cost, deadlineAtMs);
  } catch {
    issues.push({ code: 'inventory_store_or_budget_refused', descriptor: 'inventory' });
  }
  return {
    cost,
    issues: uniqueIssues(issues),
    sql,
    first,
    second,
    children,
    childSql,
    redisCatalogs: [first?.catalog, second?.catalog].filter(
      (catalog): catalog is SourceAbandonmentCatalogProof => catalog != null,
    ),
    sqlPlans: [
      ...(sql?.plans ?? []),
      ...(first?.sqlPlans ?? []),
      ...(second?.sqlPlans ?? []),
      ...(childSql?.plans ?? []),
    ],
  };
}

export async function collectSourceAbandonmentLiveEvidence(
  tx: Prisma.TransactionClient,
  redis: SourceAbandonmentRedisReader,
  request: SourceAbandonmentLiveRequest,
): Promise<SourceAbandonmentLiveOutput> {
  request = parseSourceAbandonmentLiveRequest(JSON.stringify(request));
  const evidence = await gather(
    tx,
    redis,
    request.selection,
    request.binding.queueFenceNonce,
    request.binding.publisherBotId,
  );
  const registrySha256 = sourceAbandonmentSourceClosureDigest(
    request.binding.sourceSha,
    request.binding.imageId,
  );
  const output: SourceAbandonmentLiveOutput = {
    version: 1,
    operation: 'inventory_preview',
    applied: false,
    activationAuthorized: false,
    decision: evidence.issues.length ? 'DENY' : 'READY_TO_INSTALL',
    binding: request.binding,
    selectionSha256: sourceAbandonmentDigest(request.selection),
    registrySha256,
    inventorySha256: null,
    previewSha256:
      !evidence.issues.length && evidence.sql
        ? buildSourceAbandonmentPreviewDigest(
            evidence.sql.candidates,
            evidence.children,
            request.selection,
            registrySha256,
          )
        : null,
    sqlEvidenceSha256:
      evidence.sql && evidence.childSql
        ? sourceAbandonmentDigest({
            sources: evidence.sql.stableDigest,
            children: evidence.childSql.stableDigest,
          })
        : null,
    redisEvidenceSha256: evidence.first?.stableDigest ?? null,
    redisCatalogs: evidence.redisCatalogs,
    selectedOwners: evidence.sql?.selectedOwners ?? [],
    children: evidence.children,
    sqlPlans: evidence.sqlPlans,
    issues: evidence.issues,
    cost: evidence.cost,
  };
  const inventorySha256 = !evidence.issues.length
    ? buildSourceAbandonmentInventoryDigest(output)
    : null;
  if (request.expectedInventorySha256 && request.expectedInventorySha256 !== inventorySha256)
    evidence.issues.push({ code: 'reviewed_inventory_changed', descriptor: 'inventory' });
  if (Buffer.byteLength(JSON.stringify(output)) > SOURCE_ABANDONMENT_OUTPUT_MAX_BYTES)
    return {
      ...output,
      decision: 'DENY',
      inventorySha256: null,
      previewSha256: null,
      sqlEvidenceSha256: null,
      redisEvidenceSha256: null,
      selectedOwners: [],
      children: [],
      sqlPlans: [],
      issues: [{ code: 'inventory_output_budget_exceeded', descriptor: 'inventory' }],
    };
  return {
    ...output,
    decision: evidence.issues.length ? 'DENY' : 'READY_TO_INSTALL',
    inventorySha256: evidence.issues.length ? null : inventorySha256,
    previewSha256: evidence.issues.length ? null : output.previewSha256,
    issues: uniqueIssues(evidence.issues),
  };
}

export async function collectSourceAbandonmentAdmission(
  tx: Prisma.TransactionClient,
  redis: SourceAbandonmentRedisReader,
  request: SourceAbandonmentAdmissionRequest,
): Promise<SourceAbandonmentAdmissionOutput> {
  request = parseSourceAbandonmentAdmissionRequest(JSON.stringify(request));
  const evidence = await gather(tx, redis, request.selection, undefined, request.publisherBotId);
  const result: SourceAbandonmentAdmissionOutput = {
    version: 1,
    operation: 'admission_preview',
    applied: false,
    activationAuthorized: false,
    stoppingAuthorized: false,
    sourceSha: request.sourceSha,
    imageId: request.imageId,
    selectionSha256: sourceAbandonmentDigest(request.selection),
    ...(request.publisherBotId
      ? {
          publisherCatalogSha256: sourceAbandonmentDigest({
            publisherBotId: request.publisherBotId,
          }),
        }
      : {}),
    registrySha256: sourceAbandonmentSourceClosureDigest(request.sourceSha, request.imageId),
    decision: evidence.issues.length ? 'DENY' : 'READY_FOR_COLD_REVIEW',
    sourceCoverageComplete: evidence.issues.length === 0,
    selectedOwners: evidence.sql?.selectedOwners ?? [],
    sqlPlans: evidence.sqlPlans,
    queueCounts: evidence.first?.queueCounts ?? [],
    minimumEffectRowsForTwoReads:
      (evidence.first?.cost.rows ?? 0) + (evidence.second?.cost.rows ?? 0),
    issues: evidence.issues,
    cost: evidence.cost,
    redisCatalogs: evidence.redisCatalogs,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > SOURCE_ABANDONMENT_OUTPUT_MAX_BYTES)
    return {
      ...result,
      decision: 'DENY',
      sourceCoverageComplete: false,
      selectedOwners: [],
      sqlPlans: [],
      queueCounts: [],
      issues: [{ code: 'admission_output_budget_exceeded', descriptor: 'inventory' }],
    };
  return result;
}

export async function readSourceAbandonmentStdin(input: Readable): Promise<string> {
  const parts: Buffer[] = [];
  let bytes = 0;
  const timer = setTimeout(() => input.destroy(new Error('Source stdin deadline')), 5000);
  try {
    for await (const chunk of input) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += part.length;
      if (bytes > SOURCE_ABANDONMENT_REQUEST_MAX_BYTES) throw new Error('Source stdin budget');
      parts.push(part);
    }
    return Buffer.concat(parts).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}
export function assertSourceAbandonmentCollectorEnvironment(
  request: SourceAbandonmentLiveRequest | SourceAbandonmentAdmissionRequest,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const identity = request.operation === 'admission_preview' ? request : request.binding;
  if (
    env.MAXIM_SOURCE_ABANDONMENT_OFFLINE !== '1' ||
    env.APP_SERVICE_NAME !== 'source-abandonment-collect' ||
    env.MAXIM_SOURCE_ABANDONMENT_PROTOCOL !== 'source-abandonment-v1' ||
    env.APP_SOURCE_SHA !== identity.sourceSha ||
    env.MAXIM_SOURCE_ABANDONMENT_IMAGE_ID !== identity.imageId ||
    env.TZ !== 'UTC'
  )
    throw new Error('Source collector environment mismatch');
}
// FLAG: Only store readers are constructed; no Nest, queue writer or MAX client exists here.
export async function runSourceAbandonmentLiveCli(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<number> {
  let prisma: PrismaClient | undefined;
  let redis: Redis | undefined;
  try {
    const text = await readSourceAbandonmentStdin(input);
    const request =
      JSON.parse(text)?.operation === 'admission_preview'
        ? parseSourceAbandonmentAdmissionRequest(text)
        : parseSourceAbandonmentLiveRequest(text);
    assertSourceAbandonmentCollectorEnvironment(request);
    if (!process.env.DATABASE_URL || !process.env.REDIS_URL)
      throw new Error('Source stores unavailable');
    prisma = createPrismaClient(process.env.DATABASE_URL, {
      max: 1,
      application_name: `maxim-source-preview:${randomUUID()}`,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
      options: '-c default_transaction_read_only=on -c max_parallel_workers_per_gather=0',
    });
    redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 3000,
      commandTimeout: 5000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });
    redis.on('error', () => undefined);
    await redis.connect();
    const reader = redis;
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
        await tx.$executeRaw`SET LOCAL max_parallel_workers_per_gather = 0`;
        await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        await tx.$executeRaw`SET LOCAL idle_in_transaction_session_timeout = '50s'`;
        return request.operation === 'admission_preview'
          ? collectSourceAbandonmentAdmission(tx, reader, request)
          : collectSourceAbandonmentLiveEvidence(tx, reader, request);
      },
      {
        // FLAG: Online admission must see parents committed before newly observed Redis
        // cleanup jobs; frozen inventory keeps one repeatable SQL snapshot.
        isolationLevel:
          request.operation === 'admission_preview'
            ? Prisma.TransactionIsolationLevel.ReadCommitted
            : Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 3000,
        timeout: sourceCollectionTransactionTimeoutMs,
      },
    );
    output.write(`${JSON.stringify(result)}\n`);
    return result.decision === 'DENY' ? 1 : 0;
  } catch {
    output.write(
      `${JSON.stringify({
        version: 1,
        operation: 'inventory_preview',
        applied: false,
        activationAuthorized: false,
        decision: 'DENY',
        refused: true,
        code: 'source_request_or_store_refused',
      })}\n`,
    );
    return 1;
  } finally {
    redis?.disconnect();
    await prisma?.$disconnect();
  }
}
if (require.main === module)
  void runSourceAbandonmentLiveCli().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
