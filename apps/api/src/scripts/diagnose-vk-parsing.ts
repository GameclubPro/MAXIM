import { Queue, type ConnectionOptions } from 'bullmq';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';

type CliOptions = {
  json: boolean;
  limit: number;
  windowHours: number;
  redisUrl: string | null;
};

type QueueCounts = Awaited<ReturnType<Queue['getJobCounts']>>;

type QueueJobSample = {
  id: string | null;
  name: string;
  timestamp: string | null;
  processedOn: string | null;
  finishedOn: string | null;
  failedReason: string | null;
};

type QueueJobReference = {
  id: string;
  state: string;
};

type QueueDiagnostic = {
  name: string;
  counts: QueueCounts;
  jobs: QueueJobSample[];
  referencedJobs?: QueueJobReference[];
};

type VkParsingDiagnostics = {
  generatedAt: string;
  windowHours: number;
  sourceStatus: unknown[];
  sourceHealth: unknown;
  noisySources: unknown[];
  syncPerformance: unknown;
  publishBacklog: unknown;
  stuckPublishPosts: unknown[];
  recentPublishFailures: unknown[];
  mediaStatus: unknown[];
  mediaIdentityConflicts: unknown[];
  recentMediaFailures: unknown[];
  queues: {
    available: boolean;
    error: string | null;
    sync: QueueDiagnostic | null;
    publish: QueueDiagnostic | null;
  };
};

const DEFAULT_LIMIT = 20;
const DEFAULT_WINDOW_HOURS = 6;
const VK_SYNC_QUEUE = 'vk-parsing-sync';
const VK_PUBLISH_QUEUE = 'vk-parsing-publish';

export function readCliOptions(argv: readonly string[], env = process.env): CliOptions {
  return {
    json: argv.includes('--json'),
    limit: readPositiveIntOption(argv, '--limit') ?? DEFAULT_LIMIT,
    windowHours: readPositiveIntOption(argv, '--window-hours') ?? DEFAULT_WINDOW_HOURS,
    redisUrl: readStringOption(argv, '--redis-url') ?? env.REDIS_URL?.trim() ?? null,
  };
}

function readStringOption(args: readonly string[], name: string): string | undefined {
  const index = args.findIndex((arg) => arg === name);
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

function readPositiveIntOption(args: readonly string[], name: string): number | undefined {
  const value = readStringOption(args, name);
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

export async function loadVkParsingDiagnostics(
  prisma: PrismaClient,
  options: CliOptions,
): Promise<VkParsingDiagnostics> {
  const generatedAt = new Date();
  const since = new Date(generatedAt.getTime() - options.windowHours * 60 * 60_000);
  const [
    sourceStatus,
    sourceHealth,
    noisySources,
    syncPerformance,
    publishBacklog,
    stuckPublishPosts,
    recentPublishFailures,
    mediaStatus,
    mediaIdentityConflicts,
    recentMediaFailures,
  ] = await Promise.all([
    loadSourceStatus(prisma),
    loadSourceHealth(prisma),
    loadNoisySources(prisma, options.limit),
    loadSyncPerformance(prisma, since),
    loadPublishBacklog(prisma),
    loadStuckPublishPosts(prisma, options.limit),
    loadRecentPublishFailures(prisma, since, options.limit),
    loadMediaStatus(prisma),
    loadMediaIdentityConflicts(prisma, options.limit),
    loadRecentMediaFailures(prisma, since, options.limit),
  ]);
  const queues = await loadQueueDiagnostics(
    options.redisUrl,
    options.limit,
    buildPublishReferenceJobIds(stuckPublishPosts),
  );

  return {
    generatedAt: generatedAt.toISOString(),
    windowHours: options.windowHours,
    sourceStatus,
    sourceHealth,
    noisySources,
    syncPerformance,
    publishBacklog,
    stuckPublishPosts,
    recentPublishFailures,
    mediaStatus,
    mediaIdentityConflicts,
    recentMediaFailures,
    queues,
  };
}

async function loadSourceStatus(prisma: PrismaClient): Promise<unknown[]> {
  return prisma.$queryRaw`
    select
      sync_status as "syncStatus",
      coalesce(last_error_code, '') as "lastErrorCode",
      count(*)::int as "count"
    from vk_parsing_sources
    group by sync_status, coalesce(last_error_code, '')
    order by count(*) desc, sync_status asc, coalesce(last_error_code, '') asc
  `;
}

async function loadSourceHealth(prisma: PrismaClient): Promise<unknown> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    select
      count(*)::int as "sourceCount",
      count(*) filter (
        where status = 'ACTIVE'
          and sync_status = 'IDLE'
          and last_error_code is null
      )::int as "healthySources",
      count(*) filter (
        where status = 'ACTIVE'
          and (sync_status in ('BACKOFF', 'ERROR') or last_error_code is not null)
      )::int as "errorSources",
      count(*) filter (
        where status = 'ACTIVE'
          and circuit_opened_at is not null
      )::int as "circuitOpenSources",
      count(*) filter (
        where status = 'ACTIVE'
          and sync_status in ('QUEUED', 'SYNCING')
      )::int as "inFlightSources",
      count(*) filter (
        where status = 'ACTIVE'
          and sync_status = 'SYNCING'
          and (
            sync_lock_deadline_at < now()
            or (
              sync_lock_deadline_at is null
              and sync_locked_at < now() - interval '5 minutes'
            )
          )
      )::int as "staleSyncLocks",
      avg(last_sync_duration_ms) filter (
        where last_sync_duration_ms is not null
      ) as "avgSyncDurationMs",
      percentile_cont(0.95) within group (order by last_sync_duration_ms) filter (
        where last_sync_duration_ms is not null
      ) as "p95SyncDurationMs"
    from vk_parsing_sources
    where status = 'ACTIVE'
  `;
  const row = rows[0] ?? {};
  const sourceCount = readNumber(row.sourceCount);
  const healthySources = readNumber(row.healthySources);
  return {
    ...row,
    sourceCount,
    healthySources,
    currentSourceSuccessRate: sourceCount > 0 ? healthySources / sourceCount : 1,
  };
}

async function loadNoisySources(prisma: PrismaClient, limit: number): Promise<unknown[]> {
  return prisma.$queryRaw`
    select
      id,
      chat_id as "chatId",
      screen_name as "screenName",
      sync_status as "syncStatus",
      last_error_code as "lastErrorCode",
      left(coalesce(last_error, ''), 300) as "lastError",
      consecutive_failures as "consecutiveFailures",
      last_sync_at as "lastSyncAt",
      last_success_at as "lastSuccessAt",
      next_sync_at as "nextSyncAt",
      case when sync_status = 'BACKOFF' then next_sync_at else null end as "nextRetryAt",
      terminal_failure_count as "terminalFailureCount",
      circuit_opened_at as "circuitOpenedAt",
      circuit_reason_code as "circuitReasonCode",
      left(coalesce(circuit_reason, ''), 300) as "circuitReason",
      circuit_retry_at as "circuitRetryAt",
      sync_locked_by as "syncLockedBy",
      sync_lock_deadline_at as "syncLockDeadlineAt",
      sync_heartbeat_at as "syncHeartbeatAt",
      (
        sync_status = 'SYNCING'
        and (
          sync_lock_deadline_at < now()
          or (
            sync_lock_deadline_at is null
            and sync_locked_at < now() - interval '5 minutes'
          )
        )
      ) as "staleSyncLock",
      last_fetched_pages as "lastFetchedPages",
      last_imported_count as "lastImportedCount",
      last_fetched_count as "lastFetchedCount",
      last_sync_duration_ms as "lastSyncDurationMs",
      updated_at as "updatedAt"
    from vk_parsing_sources
    where status = 'ACTIVE'
      and (
        last_error_code is not null
        or sync_status in ('BACKOFF', 'ERROR', 'QUEUED', 'SYNCING')
        or consecutive_failures > 0
      )
    order by
      (last_error_code is not null) desc,
      consecutive_failures desc,
      updated_at desc
    limit ${limit}
  `;
}

async function loadSyncPerformance(prisma: PrismaClient, since: Date): Promise<unknown> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    select
      count(*) filter (where last_sync_at >= ${since})::int as "syncedSources",
      sum(last_imported_count) filter (where last_sync_at >= ${since})::int as "importedPosts",
      sum(last_fetched_count) filter (where last_sync_at >= ${since})::int as "fetchedPosts",
      avg(last_sync_duration_ms) filter (
        where last_sync_at >= ${since} and last_sync_duration_ms is not null
      ) as "avgSyncDurationMs",
      percentile_cont(0.95) within group (order by last_sync_duration_ms) filter (
        where last_sync_at >= ${since} and last_sync_duration_ms is not null
      ) as "p95SyncDurationMs",
      max(last_sync_at) as "latestSyncAt"
    from vk_parsing_sources
    where status = 'ACTIVE'
  `;
  return rows[0] ?? {};
}

async function loadPublishBacklog(prisma: PrismaClient): Promise<unknown> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    select
      count(*) filter (where publish_queued_at is not null)::int as "queuedPosts",
      count(*) filter (
        where publish_queued_at is not null
          and coalesce(publish_scheduled_at, publish_queued_at) <= now()
      )::int as "dueQueuedPosts",
      count(*) filter (
        where publish_queued_at is not null
          and publish_scheduled_at > now()
      )::int as "futureScheduledPosts",
      count(*) filter (
        where publish_locked_at is not null
          and publish_locked_at < now() - interval '5 minutes'
      )::int as "staleLockedPosts",
      extract(epoch from (
        now() - min(publish_queued_at) filter (
          where publish_queued_at is not null
            and coalesce(publish_scheduled_at, publish_queued_at) <= now()
        )
      ))::int as "oldestDueQueuedAgeSec",
      min(publish_queued_at) filter (
        where publish_queued_at is not null
          and coalesce(publish_scheduled_at, publish_queued_at) <= now()
      ) as "oldestDueQueuedAt"
    from vk_parsing_posts
    where publish_queued_at is not null or publish_locked_at is not null
  `;
  return rows[0] ?? {};
}

async function loadStuckPublishPosts(prisma: PrismaClient, limit: number): Promise<unknown[]> {
  return prisma.$queryRaw`
    select
      id,
      chat_id as "chatId",
      source_id as "sourceId",
      status,
      publish_reason as "publishReason",
      publish_queued_at as "publishQueuedAt",
      publish_scheduled_at as "publishScheduledAt",
      publish_locked_at as "publishLockedAt",
      publish_attempt_count as "publishAttemptCount",
      publish_idempotency_key as "publishIdempotencyKey",
      extract(epoch from (now() - coalesce(publish_queued_at, publish_locked_at)))::int
        as "ageSec",
      left(coalesce(last_error, ''), 300) as "lastError"
    from vk_parsing_posts
    where (
        publish_queued_at is not null
        and coalesce(publish_scheduled_at, publish_queued_at) <= now()
      )
      or (
        publish_locked_at is not null
        and publish_locked_at < now() - interval '5 minutes'
      )
    order by coalesce(publish_queued_at, publish_locked_at) asc
    limit ${limit}
  `;
}

async function loadRecentPublishFailures(
  prisma: PrismaClient,
  since: Date,
  limit: number,
): Promise<unknown[]> {
  return prisma.$queryRaw`
    select
      case
        when last_error ~ '^\\[[^]]+\\]' then substring(last_error from '^\\[([^]]+)\\]')
        when last_error ilike '%unique constraint%' then 'legacy.db_conflict'
        when last_error ilike '%rate limit%' then 'legacy.max_rate_limit'
        when last_error ilike '%timeout%' then 'legacy.timeout'
        when last_error ilike '%фото%' then 'legacy.media'
        else 'legacy.unknown'
      end as "code",
      count(*)::int as "count",
      max(updated_at) as "latestAt"
    from vk_parsing_posts
    where status = 'FAILED'
      and updated_at >= ${since}
    group by 1
    order by count(*) desc, max(updated_at) desc
    limit ${limit}
  `;
}

async function loadMediaStatus(prisma: PrismaClient): Promise<unknown[]> {
  return prisma.$queryRaw`
    select
      status,
      count(*)::int as "count",
      max(last_checked_at) as "latestCheckedAt",
      count(*) filter (where media_identity is not null)::int as "withIdentity"
    from vk_parsing_media_cache
    group by status
    order by count(*) desc, status asc
  `;
}

async function loadMediaIdentityConflicts(prisma: PrismaClient, limit: number): Promise<unknown[]> {
  return prisma.$queryRaw`
    select
      media_identity as "mediaIdentity",
      count(*)::int as "rowCount",
      array_agg(url order by updated_at desc) as "urls",
      max(updated_at) as "latestAt"
    from vk_parsing_media_cache
    where media_identity is not null
    group by media_identity
    having count(*) > 1
    order by count(*) desc, max(updated_at) desc
    limit ${limit}
  `;
}

async function loadRecentMediaFailures(
  prisma: PrismaClient,
  since: Date,
  limit: number,
): Promise<unknown[]> {
  return prisma.$queryRaw`
    select
      id,
      url,
      media_identity as "mediaIdentity",
      status,
      last_checked_at as "lastCheckedAt",
      left(coalesce(last_error, ''), 300) as "lastError"
    from vk_parsing_media_cache
    where (
        status = 'FAILED'
        or last_error ilike '%unique constraint%'
        or last_error ilike '%P2002%'
      )
      and coalesce(last_checked_at, updated_at) >= ${since}
    order by coalesce(last_checked_at, updated_at) desc
    limit ${limit}
  `;
}

async function loadQueueDiagnostics(
  redisUrl: string | null,
  limit: number,
  publishReferenceJobIds: string[],
): Promise<VkParsingDiagnostics['queues']> {
  if (!redisUrl) {
    return { available: false, error: 'REDIS_URL is not set', sync: null, publish: null };
  }

  const connection: ConnectionOptions = { url: redisUrl, maxRetriesPerRequest: null };
  try {
    const [sync, publish] = await Promise.all([
      loadQueueDiagnostic(connection, VK_SYNC_QUEUE, limit),
      loadQueueDiagnostic(connection, VK_PUBLISH_QUEUE, limit, publishReferenceJobIds),
    ]);
    return { available: true, error: null, sync, publish };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      sync: null,
      publish: null,
    };
  }
}

async function loadQueueDiagnostic(
  connection: ConnectionOptions,
  name: string,
  limit: number,
  referenceJobIds: string[] = [],
): Promise<QueueDiagnostic> {
  const queue = new Queue(name, { connection });
  try {
    const [counts, jobs, referencedJobs] = await Promise.all([
      queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
        'completed',
        'paused',
        'prioritized',
        'waiting-children',
      ),
      queue.getJobs(['waiting', 'active', 'delayed', 'failed'], 0, Math.max(0, limit - 1)),
      Promise.all(
        referenceJobIds.map(async (id): Promise<QueueJobReference> => {
          const job = await queue.getJob(id);
          return { id, state: job ? await job.getState() : 'missing' };
        }),
      ),
    ]);

    return {
      name,
      counts,
      referencedJobs,
      jobs: jobs.map((job) => ({
        id: job.id ?? null,
        name: job.name,
        timestamp: timestampToIso(job.timestamp),
        processedOn: timestampToIso(job.processedOn),
        finishedOn: timestampToIso(job.finishedOn),
        failedReason: job.failedReason ?? null,
      })),
    };
  } finally {
    await queue.close().catch(() => undefined);
  }
}

function buildPublishReferenceJobIds(rows: unknown[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    const record = row as Record<string, unknown>;
    const postId = typeof record.id === 'string' ? record.id.trim() : '';
    const idempotencyKey =
      typeof record.publishIdempotencyKey === 'string' ? record.publishIdempotencyKey.trim() : '';
    if (postId && idempotencyKey) {
      ids.add(`vk-parsing-publish__${postId}__${idempotencyKey}`);
    }
  }
  return [...ids];
}

function timestampToIso(value: number | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : null;
}

function readNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function renderTextDiagnostics(diagnostics: VkParsingDiagnostics): string {
  const sourceHealth = diagnostics.sourceHealth as Record<string, unknown>;
  const publishBacklog = diagnostics.publishBacklog as Record<string, unknown>;
  const syncPerformance = diagnostics.syncPerformance as Record<string, unknown>;
  const referencedPublishStateCounts = (diagnostics.queues.publish?.referencedJobs ?? []).reduce<
    Record<string, number>
  >((counts, job) => {
    counts[job.state] = (counts[job.state] ?? 0) + 1;
    return counts;
  }, {});
  const lines = [
    `VK parsing diagnostics @ ${diagnostics.generatedAt}`,
    `Window: ${diagnostics.windowHours}h`,
    '',
    `Sources: ${readNumber(sourceHealth.healthySources)}/${readNumber(
      sourceHealth.sourceCount,
    )} healthy, ${readNumber(sourceHealth.errorSources)} error/backoff, ${readNumber(
      sourceHealth.inFlightSources,
    )} queued/syncing, ${readNumber(sourceHealth.staleSyncLocks)} stale locks, ${readNumber(
      sourceHealth.circuitOpenSources,
    )} circuits open`,
    `Sync: fetched ${readNumber(syncPerformance.fetchedPosts)}, imported ${readNumber(
      syncPerformance.importedPosts,
    )}, p95 ${Math.round(readNumber(syncPerformance.p95SyncDurationMs))}ms`,
    `Publish backlog: ${readNumber(publishBacklog.dueQueuedPosts)} due / ${readNumber(
      publishBacklog.queuedPosts,
    )} queued, ${readNumber(publishBacklog.futureScheduledPosts)} scheduled later, ${readNumber(
      publishBacklog.staleLockedPosts,
    )} stale locked, oldest due ${readNumber(publishBacklog.oldestDueQueuedAgeSec)}s`,
    '',
    `Source status: ${JSON.stringify(diagnostics.sourceStatus)}`,
    `Media status: ${JSON.stringify(diagnostics.mediaStatus)}`,
    `Queue counts: sync=${JSON.stringify(
      diagnostics.queues.sync?.counts ?? null,
    )}, publish=${JSON.stringify(diagnostics.queues.publish?.counts ?? null)}`,
  ];

  if (Object.keys(referencedPublishStateCounts).length > 0) {
    lines.push(`Stuck publish job states: ${JSON.stringify(referencedPublishStateCounts)}`);
  }

  if (diagnostics.noisySources.length > 0) {
    lines.push('', 'Noisy sources:', JSON.stringify(diagnostics.noisySources, jsonReplacer, 2));
  }
  if (diagnostics.stuckPublishPosts.length > 0) {
    lines.push(
      '',
      'Stuck publish posts:',
      JSON.stringify(diagnostics.stuckPublishPosts, jsonReplacer, 2),
    );
  }
  if (diagnostics.recentPublishFailures.length > 0) {
    lines.push(
      '',
      'Recent publish failures:',
      JSON.stringify(diagnostics.recentPublishFailures, jsonReplacer, 2),
    );
  }
  if (diagnostics.recentMediaFailures.length > 0) {
    lines.push(
      '',
      'Recent media failures:',
      JSON.stringify(diagnostics.recentMediaFailures, jsonReplacer, 2),
    );
  }
  if (diagnostics.mediaIdentityConflicts.length > 0) {
    lines.push(
      '',
      'Media identity conflicts:',
      JSON.stringify(diagnostics.mediaIdentityConflicts, jsonReplacer, 2),
    );
  }
  if (diagnostics.queues.error) {
    lines.push('', `Queue diagnostics unavailable: ${diagnostics.queues.error}`);
  }

  return lines.join('\n');
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return value;
}

async function main(): Promise<void> {
  const options = readCliOptions(process.argv.slice(2));
  const prisma = createPrismaClient();
  try {
    const diagnostics = await loadVkParsingDiagnostics(prisma, options);
    if (options.json) {
      console.log(JSON.stringify(diagnostics, jsonReplacer, 2));
    } else {
      console.log(renderTextDiagnostics(diagnostics));
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
