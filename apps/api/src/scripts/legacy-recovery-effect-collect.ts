import { type Readable, type Writable } from 'node:stream';
import Redis from 'ioredis';
import { Prisma, createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { buildLegacyRecoveryPreviewDigest } from '../webhook/webhook-legacy-cold-install';
import { inventoryLegacyRecoverySelectedSql } from './legacy-recovery-live-sql';
import { inventoryLegacyRecoverySelectedRedis } from './legacy-recovery-live-redis';
import { legacyRecoverySourceClosureDigest } from './legacy-recovery-source-closure';
import { LEGACY_RECOVERY_LIVE_BUDGET } from './legacy-recovery-live-budget';
import {
  collectLegacyRecoveryAdmission,
  parseLegacyRecoveryAdmissionRequest,
} from './legacy-recovery-admission-preview';
import {
  LEGACY_RECOVERY_LIVE_OUTPUT_MAX_BYTES,
  LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES,
  legacyRecoveryLiveDigest,
  parseLegacyRecoveryLiveRequest,
  type LegacyRecoveryLiveIssue,
  type LegacyRecoveryLiveOutput,
  type LegacyRecoveryLiveRequest,
} from './legacy-recovery-live-protocol';

export { LEGACY_RECOVERY_LIVE_BUDGET } from './legacy-recovery-live-budget';
type Cost = { pages: number; rows: number; probes: number; bytes: number };
type Allowance = Cost & { deadlineAtMs: number };
type RedisReader = Parameters<typeof inventoryLegacyRecoverySelectedRedis>[0];
type Adapters = {
  sql: typeof inventoryLegacyRecoverySelectedSql;
  redis: typeof inventoryLegacyRecoverySelectedRedis;
};

function charge(cost: Cost, next: Cost): void {
  for (const name of ['pages', 'rows', 'probes', 'bytes'] as const) {
    if (!Number.isSafeInteger(next[name]) || next[name] < 0)
      throw new Error('Invalid inventory accounting');
    cost[name] += next[name];
    if (cost[name] > LEGACY_RECOVERY_LIVE_BUDGET[name])
      throw new Error('Shared inventory budget exceeded');
  }
}
function allowance(cost: Cost, deadlineAtMs: number): Allowance {
  if (Date.now() >= deadlineAtMs) throw new Error('Shared inventory deadline exceeded');
  return {
    pages: LEGACY_RECOVERY_LIVE_BUDGET.pages - cost.pages,
    rows: LEGACY_RECOVERY_LIVE_BUDGET.rows - cost.rows,
    probes: LEGACY_RECOVERY_LIVE_BUDGET.probes - cost.probes,
    bytes: LEGACY_RECOVERY_LIVE_BUDGET.bytes - cost.bytes,
    deadlineAtMs,
  };
}
function issuesSorted(issues: readonly LegacyRecoveryLiveIssue[]): LegacyRecoveryLiveIssue[] {
  return [
    ...new Map(issues.map((issue) => [`${issue.descriptor}:${issue.code}`, issue])).values(),
  ].sort((a, b) => a.descriptor.localeCompare(b.descriptor) || a.code.localeCompare(b.code));
}

// FLAG: This collector only reads evidence. Caller-supplied host identities never
// authorize installation, role startup, queue changes, or a MAX action.
export async function collectLegacyRecoveryLiveEvidence(
  tx: Prisma.TransactionClient,
  redis: RedisReader,
  request: LegacyRecoveryLiveRequest,
  adapters: Adapters = {
    sql: inventoryLegacyRecoverySelectedSql,
    redis: inventoryLegacyRecoverySelectedRedis,
  },
): Promise<LegacyRecoveryLiveOutput> {
  // Revalidate direct callers as strictly as the stdin boundary.
  request = parseLegacyRecoveryLiveRequest(JSON.stringify(request));
  const cost: Cost = { pages: 0, rows: 0, probes: 0, bytes: 0 };
  const deadlineAtMs = Date.now() + LEGACY_RECOVERY_LIVE_BUDGET.durationMs;
  const issues: LegacyRecoveryLiveIssue[] = [];
  const selectionSha256 = legacyRecoveryLiveDigest(request.selection);
  const registrySha256 = legacyRecoverySourceClosureDigest(
    request.binding.sourceSha,
    request.binding.imageId,
  );
  const base = {
    version: 1 as const,
    operation: 'inventory_preview' as const,
    applied: false as const,
    activationAuthorized: false as const,
    binding: request.binding,
    selectionSha256,
    registrySha256,
  };
  let sql: Awaited<ReturnType<Adapters['sql']>> | undefined;
  let first: Awaited<ReturnType<Adapters['redis']>> | undefined;
  let inventorySha256: string | null = null;
  let previewSha256: string | null = null;
  try {
    sql = await adapters.sql(tx, request, allowance(cost, deadlineAtMs));
    charge(cost, sql.cost);
    issues.push(...sql.issues);
    const expectedIds = request.selection.ownerWebhookEventIds;
    const candidateIds = sql.candidates.map((row) => row.owner.id).sort();
    const proofIds = sql.selectedOwners.map((row) => row.ownerWebhookEventId).sort();
    if (
      candidateIds.length !== expectedIds.length ||
      proofIds.length !== expectedIds.length ||
      candidateIds.some((id, index) => id !== expectedIds[index]) ||
      proofIds.some((id, index) => id !== expectedIds[index])
    )
      issues.push({ code: 'selected_owner_proof_incomplete', descriptor: 'sql:webhook_events' });
    // Keep catalog diagnostics available even if a selected source is refused.
    const sources = sql.candidates.map((candidate) => candidate.source);
    first = await adapters.redis(redis, request, sources, allowance(cost, deadlineAtMs));
    charge(cost, first.cost);
    issues.push(...first.issues);
    const second = await adapters.redis(redis, request, sources, allowance(cost, deadlineAtMs));
    charge(cost, second.cost);
    issues.push(...second.issues);
    if (first.stableDigest !== second.stableDigest)
      issues.push({ code: 'redis_inventory_changed', descriptor: 'redis:all' });
    allowance(cost, deadlineAtMs);
    if (!issues.length) {
      previewSha256 = buildLegacyRecoveryPreviewDigest(sql.candidates, first.children);
      inventorySha256 = legacyRecoveryLiveDigest({
        version: 1,
        binding: request.binding,
        selectionSha256,
        registrySha256,
        sql: sql.stableDigest,
        redis: first.stableDigest,
        previewSha256,
      });
      if (request.expectedInventorySha256 && request.expectedInventorySha256 !== inventorySha256)
        issues.push({ code: 'reviewed_inventory_changed', descriptor: 'inventory' });
    }
  } catch {
    // Store errors may contain raw query values or credentials; publish a fixed code.
    issues.push({ code: 'inventory_store_or_budget_refused', descriptor: 'inventory' });
  }
  const output: LegacyRecoveryLiveOutput = {
    ...base,
    decision: issues.length ? 'DENY' : 'READY_TO_INSTALL',
    inventorySha256: issues.length ? null : inventorySha256,
    previewSha256: issues.length ? null : previewSha256,
    selectedOwners: sql?.selectedOwners ?? [],
    children: first?.children ?? [],
    sqlPlans: [...(sql?.proofs ?? []), ...(first?.sqlPlans ?? [])],
    issues: issuesSorted(issues),
    cost,
  };
  if (Buffer.byteLength(JSON.stringify(output)) > LEGACY_RECOVERY_LIVE_OUTPUT_MAX_BYTES)
    return {
      ...base,
      decision: 'DENY',
      inventorySha256: null,
      previewSha256: null,
      selectedOwners: [],
      children: [],
      sqlPlans: [],
      issues: [{ code: 'inventory_output_budget_exceeded', descriptor: 'inventory' }],
      cost,
    };
  return output;
}

export async function readLegacyRecoveryLiveStdin(input: Readable): Promise<string> {
  const parts: Buffer[] = [];
  let bytes = 0;
  const timer = setTimeout(
    () => input.destroy(new Error('Offline stdin deadline exceeded')),
    5_000,
  );
  try {
    for await (const chunk of input) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += part.byteLength;
      if (bytes > LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES)
        throw new Error('Offline stdin request budget exceeded');
      parts.push(part);
    }
    return Buffer.concat(parts).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

// FLAG: SQL is read-only and uses one snapshot. This command never constructs Nest,
// workers, queue writers or MAX clients. Production activation stays hard-disabled.
export async function runLegacyRecoveryLiveCli(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<number> {
  let prisma: PrismaClient | undefined;
  let redis: Redis | undefined;
  try {
    const text = await readLegacyRecoveryLiveStdin(input);
    const online = JSON.parse(text)?.operation === 'admission_preview';
    const request = online
      ? parseLegacyRecoveryAdmissionRequest(text)
      : parseLegacyRecoveryLiveRequest(text);
    const databaseUrl = process.env.DATABASE_URL;
    const redisUrl = process.env.REDIS_URL;
    if (!databaseUrl || !redisUrl) throw new Error('Offline stores unavailable');
    prisma = createPrismaClient(databaseUrl, {
      max: 1,
      application_name: 'maxim-legacy-readonly-preview',
      connectionTimeoutMillis: 3_000,
      statement_timeout: 5_000,
      options: '-c default_transaction_read_only=on',
    });
    redis = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 3_000,
      commandTimeout: 5_000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });
    // Client errors are reflected in the fixed refusal; never log their raw payload.
    redis.on('error', () => undefined);
    await redis.connect();
    const reader = redis;
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        await tx.$executeRaw`SET LOCAL idle_in_transaction_session_timeout = '35s'`;
        return request.operation === 'admission_preview'
          ? collectLegacyRecoveryAdmission(tx, reader, request)
          : collectLegacyRecoveryLiveEvidence(tx, reader, request);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 3_000,
        timeout: LEGACY_RECOVERY_LIVE_BUDGET.durationMs + 5_000,
      },
    );
    output.write(`${JSON.stringify(result)}\n`);
    return result.decision === 'READY_TO_INSTALL' || result.decision === 'READY_FOR_COLD_REVIEW'
      ? 0
      : 1;
  } catch {
    output.write(
      `${JSON.stringify({
        version: 1,
        operation: 'inventory_preview',
        applied: false,
        activationAuthorized: false,
        decision: 'DENY',
        refused: true,
        code: 'inventory_request_or_store_refused',
      })}\n`,
    );
    return 1;
  } finally {
    redis?.disconnect();
    await prisma?.$disconnect();
  }
}

if (require.main === module) {
  void runLegacyRecoveryLiveCli().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
