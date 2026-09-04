import { Queue, type ConnectionOptions, type Job } from 'bullmq';
import { publisherReadinessBlockerCodeSchema } from '@maxim/contracts/publisher';
import {
  createPrismaClient,
  PublicationDispatchProfile,
  type PrismaClient,
  VkParsingOwnerProfile,
} from '../prisma/prisma-client';
import { buildPublisherBotDescriptor } from '../publisher/publisher-bot-descriptor';
import { getVkAutoPublishLocalDayRange } from '../admin/vk-autopublish-timing';

type CliOptions = {
  json: boolean;
  limit: number;
  reconcileCap: number;
  windowHours: number;
  redisUrl: string | null;
  publisherBotId: string;
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

export type OwnedPublishRow = {
  id: string;
  chatId: string;
  sourceId: string;
  status: string;
  publishReason: string | null;
  publishQueuedAt: Date | null;
  publishScheduledAt: Date | null;
  publishLockedAt: Date | null;
  publishIdempotencyKey: string | null;
  requiredBotId: string | null;
  dispatchBlockerCode?: string | null;
  dispatchBlockedAt?: Date | null;
};

type VkPublishSuccessSummary = {
  scope: 'autopublish';
  count: number;
  latestAt: string | null;
  complete: boolean;
  sourceCap: number;
  scannedSourceCount: number;
  sourcesTruncated: boolean;
};

type VkDispatchBlockerSummary = {
  totalBlockedPosts: number;
  complete: boolean;
  codes: Array<{
    code: string;
    count: number;
    latestAt: string | null;
  }>;
};

type VkSchedulePolicySource = {
  id: string;
  chatId: string;
  publishIntervalMinutes: number;
  minPublishIntervalMinutes: number;
  dailyLimit: number;
  publishMode: string;
  runtimeState?:
    | 'runnable'
    | 'global_auto_disabled'
    | 'global_auto_incomplete'
    | 'kill_switch_paused'
    | 'settings_missing';
};

type VkSchedulePolicySettings = {
  chatId: string;
  schedulerTimezone: string;
  autoPublishEnabled: boolean;
  autoPublishEnabledAt: Date | null;
  autoPublishKillSwitchEnabled: boolean;
};

type VkSchedulePolicySummary = {
  sourceCap: number;
  totalSourceCount: number;
  scannedSourceCount: number;
  truncated: boolean;
  sourceSnapshotConsistent: boolean;
  queuedCountsComplete: boolean;
  runtimeStates: {
    runnableSourceCount: number;
    globalAutoDisabledSourceCount: number;
    globalAutoIncompleteSourceCount: number;
    killSwitchPausedSourceCount: number;
    settingsMissingSourceCount: number;
  };
  groupCap: number;
  groupsTruncated: boolean;
  groups: Array<{
    publishIntervalMinutes: number;
    minPublishIntervalMinutes: number;
    dailyLimit: number;
    publishMode: string;
    sourceCount: number;
    queuedCount: number;
    dailyCapReachedSourceCount: number;
    earliestNextScheduledAt: string | null;
    secondsToEarliestNext: number | null;
  }>;
};

export type OwnedPublishDatabaseSnapshot = {
  totalRows: number;
  rows: OwnedPublishRow[];
  cap: number;
  truncated: boolean;
  consistent: boolean;
};

export type PublishQueueStateSnapshot = {
  paused: boolean;
  counts: Record<string, number>;
};

export type PublishQueueJobSnapshot = {
  id: string;
  name: string;
  state: string;
  timestamp: number | null;
  delay: number | null;
  attemptsMade: number;
  attemptsStarted: number;
  processedOn: number | null;
  finishedOn: number | null;
  data: unknown;
};

export type OwnedPublishJobObservation = {
  expectedJobId: string | null;
  job: PublishQueueJobSnapshot | null;
};

type ReconciliationIssue<T> = {
  count: number;
  complete: boolean;
  samples: T[];
};

export type PublishQueueReconciliation = {
  available: boolean;
  error: string | null;
  database: {
    totalOwnedRows: number;
    scannedOwnedRows: number;
    cap: number;
    truncated: boolean;
    consistent: boolean;
    futureScheduledRows: number;
    maxScheduledAt: string | null;
    maxFutureHorizonSec: number;
  };
  queue: {
    paused: boolean;
    activeJobs: number;
    snapshotConsistent: boolean;
    repairGrade: boolean;
    liveSnapshot: boolean;
    totalJobs: number;
    scannedJobs: number;
    cap: number;
    truncated: boolean;
    stateDistribution: Record<string, number>;
    ownedStateDistribution: Record<string, number>;
    maxOwnedJobScheduledAt: string | null;
    maxOwnedJobFutureHorizonSec: number;
  };
  missingJobs: ReconciliationIssue<{
    postId: string;
    chatId: string;
    publishReason: string | null;
    publishScheduledAt: string | null;
    expectedJobId: string | null;
  }>;
  orphanJobs: ReconciliationIssue<{
    jobId: string;
    state: string;
    postId: string | null;
    chatId: string | null;
    reason: string | null;
    idempotencyKey: string | null;
    queueScheduledAt: string | null;
    classification: 'actionable' | 'active' | 'attempted' | 'retained_terminal' | 'other';
  }> & {
    actionableCount: number;
    retainedCount: number;
  };
  payloadMismatches: ReconciliationIssue<{
    postId: string;
    expectedJobId: string;
    state: string;
    mismatchedFields: string[];
    expected: Record<string, string | null>;
    actual: Record<string, string | null>;
  }>;
  scheduleDrift: ReconciliationIssue<{
    postId: string;
    expectedJobId: string;
    state: string;
    databaseScheduledAt: string;
    queueScheduledAt: string;
    driftMs: number;
  }> & {
    toleranceMs: number;
    comparableJobs: number;
    nonComparableFutureJobs: number;
    nonComparableFutureSamples: Array<{
      postId: string;
      expectedJobId: string | null;
      state: string | null;
      reason: 'missing_job' | 'missing_idempotency_key' | 'non_canonical_timing';
    }>;
    maxAbsDriftMs: number;
  };
};

type VkParsingDiagnostics = {
  generatedAt: string;
  windowHours: number;
  sourceStatus: unknown[];
  sourceHealth: unknown;
  noisySources: unknown[];
  syncPerformance: unknown;
  publishBacklog: unknown;
  recentPublishSuccess: VkPublishSuccessSummary;
  dispatchBlockers: VkDispatchBlockerSummary;
  schedulePolicies: VkSchedulePolicySummary;
  stuckPublishPosts: unknown[];
  recentPublishFailures: unknown[];
  mediaStatus: unknown[];
  mediaIdentityConflicts: unknown[];
  recentMediaFailures: unknown[];
  publishQueueReconciliation: PublishQueueReconciliation;
  queues: {
    available: boolean;
    error: string | null;
    sync: QueueDiagnostic | null;
    publish: QueueDiagnostic | null;
  };
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const DEFAULT_RECONCILIATION_CAP = 5_000;
const MAX_RECONCILIATION_CAP = 20_000;
const RECONCILIATION_PAGE_SIZE = 250;
const RECONCILIATION_JOB_CONCURRENCY = 25;
const QUEUE_DIAGNOSTIC_TIMEOUT_MS = 15_000;
const QUEUE_COMMAND_TIMEOUT_MS = 5_000;
const SCHEDULE_DRIFT_TOLERANCE_MS = 5_000;
const DEFAULT_WINDOW_HOURS = 6;
const MAX_WINDOW_HOURS = 24 * 7;
const SCHEDULE_POLICY_SOURCE_CAP = 1_000;
const SCHEDULE_POLICY_GROUP_CAP = 200;
const RECENT_PUBLISH_SUCCESS_SOURCE_CAP = 1_000;
const VK_SYNC_QUEUE = 'vk-parsing-sync';
const VK_PUBLISHER_QUEUE = 'vk-parsing-publisher';
const VK_PUBLISH_JOB_NAME = 'publish-vk-post';
const QUEUE_RECONCILIATION_STATES = [
  'waiting',
  'active',
  'delayed',
  'failed',
  'completed',
  'paused',
  'prioritized',
  'waiting-children',
] as const;
const OWNED_JOB_STATE_KEYS = [...QUEUE_RECONCILIATION_STATES, 'unknown', 'missing'] as const;
const ALLOWED_DISPATCH_BLOCKER_CODES = new Set<string>([
  ...publisherReadinessBlockerCodeSchema.options,
  'publisher_auth_paused',
  'publisher_route_invalid',
  'publisher_bot_changed',
  'publisher_setup_required',
  'dialog_context_unavailable',
]);
const ALLOWED_PUBLISH_MODES = new Set(['QUEUE', 'IMMEDIATE', 'REVIEW']);

export function readCliOptions(argv: readonly string[], env = process.env): CliOptions {
  const limit = readPositiveIntOption(argv, '--limit') ?? DEFAULT_LIMIT;
  const windowHours = readPositiveIntOption(argv, '--window-hours') ?? DEFAULT_WINDOW_HOURS;
  const reconcileCap = readPositiveIntOption(argv, '--reconcile-cap') ?? DEFAULT_RECONCILIATION_CAP;
  if (limit > MAX_LIMIT) {
    throw new Error(`--limit must be at most ${MAX_LIMIT}`);
  }
  if (windowHours > MAX_WINDOW_HOURS) {
    throw new Error(`--window-hours must be at most ${MAX_WINDOW_HOURS}`);
  }
  if (reconcileCap > MAX_RECONCILIATION_CAP) {
    throw new Error(`--reconcile-cap must be at most ${MAX_RECONCILIATION_CAP}`);
  }
  return {
    json: argv.includes('--json'),
    limit,
    reconcileCap,
    windowHours,
    redisUrl: readStringOption(argv, '--redis-url') ?? env.REDIS_URL?.trim() ?? null,
    publisherBotId: buildPublisherBotDescriptor({ id: env.MAX_PUBLISHER_BOT_ID }).id,
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

  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
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
    recentPublishSuccess,
    stuckPublishPosts,
    recentPublishFailures,
    mediaStatus,
    mediaIdentityConflicts,
    recentMediaFailures,
    ownedPublishDatabase,
  ] = await Promise.all([
    loadSourceStatus(prisma),
    loadSourceHealth(prisma),
    loadNoisySources(prisma, options.limit),
    loadSyncPerformance(prisma, since),
    loadPublishBacklog(prisma, options.publisherBotId),
    loadRecentPublishSuccess(prisma, since, options.publisherBotId),
    loadStuckPublishPosts(prisma, options.limit),
    loadRecentPublishFailures(prisma, since, options.limit),
    loadMediaStatus(prisma),
    loadMediaIdentityConflicts(prisma, options.limit),
    loadRecentMediaFailures(prisma, since, options.limit),
    loadOwnedPublishDatabaseSnapshot(prisma, options.reconcileCap, options.publisherBotId),
  ]);
  const [schedulePolicies, { queues, publishQueueReconciliation }] = await Promise.all([
    loadSchedulePolicyDiagnostics(
      prisma,
      options.publisherBotId,
      generatedAt,
      ownedPublishDatabase,
    ),
    loadQueueDiagnostics(
      options.redisUrl,
      options.limit,
      buildPublishReferenceJobIds(stuckPublishPosts),
      ownedPublishDatabase,
      generatedAt,
    ),
  ]);

  return {
    generatedAt: generatedAt.toISOString(),
    windowHours: options.windowHours,
    sourceStatus,
    sourceHealth,
    noisySources,
    syncPerformance,
    publishBacklog,
    recentPublishSuccess,
    dispatchBlockers: summarizeDispatchBlockers(ownedPublishDatabase),
    schedulePolicies,
    stuckPublishPosts,
    recentPublishFailures,
    mediaStatus,
    mediaIdentityConflicts,
    recentMediaFailures,
    publishQueueReconciliation,
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

export async function loadPublishBacklog(
  prisma: PrismaClient,
  publisherBotId: string,
): Promise<unknown> {
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
        where publish_queued_at is not null
          and publish_reason = 'autopublish'
          and publish_schedule_fingerprint is null
      )::int as "unstampedSchedulePosts",
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
      ) as "oldestDueQueuedAt",
      min(publish_scheduled_at) filter (
        where publish_queued_at is not null
          and publish_scheduled_at > now()
      ) as "nextScheduledAt",
      case
        when min(publish_scheduled_at) filter (
          where publish_queued_at is not null
            and publish_scheduled_at > now()
        ) is null then null
        else greatest(
          0,
          floor(extract(epoch from (
            min(publish_scheduled_at) filter (
              where publish_queued_at is not null
                and publish_scheduled_at > now()
            ) - now()
          ))
        ))::int
      end as "secondsToNext"
    from vk_parsing_posts
    where (publish_queued_at is not null or publish_locked_at is not null)
      and owner_profile = ${VkParsingOwnerProfile.PUBLISHER}::"VkParsingOwnerProfile"
      and owner_bot_id = ${publisherBotId}
      and dispatch_profile = ${PublicationDispatchProfile.PUBLIK_V1}::"PublicationDispatchProfile"
      and required_bot_id = ${publisherBotId}
  `;
  return rows[0] ?? {};
}

export async function loadRecentPublishSuccess(
  prisma: PrismaClient,
  since: Date,
  publisherBotId: string,
): Promise<VkPublishSuccessSummary> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    with bounded_sources as materialized (
      select id, chat_id
      from vk_parsing_sources
      where owner_profile = ${VkParsingOwnerProfile.PUBLISHER}::"VkParsingOwnerProfile"
        and owner_bot_id = ${publisherBotId}
      limit ${RECENT_PUBLISH_SUCCESS_SOURCE_CAP + 1}
    ),
    scanned_sources as materialized (
      select id, chat_id
      from bounded_sources
      limit ${RECENT_PUBLISH_SUCCESS_SOURCE_CAP}
    ),
    recent_success_by_source as materialized (
      select recent.source_count, recent.latest_at
      from scanned_sources source
      cross join lateral (
        select
          count(*)::int as source_count,
          max(post.auto_published_at) as latest_at
        from vk_parsing_posts post
        where post.chat_id = source.chat_id
          and post.source_id = source.id
          and post.auto_published_at >= ${since}
          and post.owner_profile = ${VkParsingOwnerProfile.PUBLISHER}::"VkParsingOwnerProfile"
          and post.owner_bot_id = ${publisherBotId}
        offset 0
      ) recent
    )
    select
      coalesce(sum(source_count), 0)::int as "count",
      max(latest_at) as "latestAt",
      least(
        (select count(*) from bounded_sources),
        ${RECENT_PUBLISH_SUCCESS_SOURCE_CAP}
      )::int as "scannedSourceCount",
      ((select count(*) from bounded_sources) > ${RECENT_PUBLISH_SUCCESS_SOURCE_CAP})
        as "sourcesTruncated"
    from recent_success_by_source
  `;
  const row = rows[0] ?? {};
  const sourcesTruncated = row.sourcesTruncated === true;
  return {
    scope: 'autopublish',
    count: readNumber(row.count),
    latestAt: dateValueToIso(row.latestAt),
    complete: !sourcesTruncated,
    sourceCap: RECENT_PUBLISH_SUCCESS_SOURCE_CAP,
    scannedSourceCount: readNumber(row.scannedSourceCount),
    sourcesTruncated,
  };
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

export async function loadOwnedPublishDatabaseSnapshot(
  prisma: PrismaClient,
  cap: number,
  publisherBotId: string,
): Promise<OwnedPublishDatabaseSnapshot> {
  const ownershipWhere = {
    ownerProfile: VkParsingOwnerProfile.PUBLISHER,
    ownerBotId: publisherBotId,
    dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
    requiredBotId: publisherBotId,
    publishQueuedAt: { not: null },
    source: {
      ownerProfile: VkParsingOwnerProfile.PUBLISHER,
      ownerBotId: publisherBotId,
    },
  } as const;
  const totalRowsBefore = await prisma.vkParsingPost.count({ where: ownershipWhere });
  const rows: OwnedPublishRow[] = [];
  let cursorId: string | null = null;

  while (rows.length < cap) {
    const take = Math.min(RECONCILIATION_PAGE_SIZE, cap - rows.length);
    const batch: OwnedPublishRow[] = await prisma.vkParsingPost.findMany({
      where: ownershipWhere,
      select: {
        id: true,
        chatId: true,
        sourceId: true,
        status: true,
        publishReason: true,
        publishQueuedAt: true,
        publishScheduledAt: true,
        publishLockedAt: true,
        publishIdempotencyKey: true,
        requiredBotId: true,
        dispatchBlockerCode: true,
        dispatchBlockedAt: true,
      },
      orderBy: { id: 'asc' },
      take,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    rows.push(...batch);
    if (batch.length < take) {
      break;
    }
    cursorId = batch[batch.length - 1]?.id ?? null;
    if (!cursorId) {
      break;
    }
  }

  const totalRowsAfter = await prisma.vkParsingPost.count({ where: ownershipWhere });
  const totalRows = Math.max(totalRowsBefore, totalRowsAfter, rows.length);
  return {
    totalRows,
    rows,
    cap,
    truncated: rows.length >= cap && totalRows > rows.length,
    consistent:
      totalRowsBefore === totalRowsAfter &&
      (rows.length === totalRowsAfter || (rows.length === cap && totalRowsAfter >= cap)),
  };
}

export function summarizeDispatchBlockers(
  database: OwnedPublishDatabaseSnapshot,
): VkDispatchBlockerSummary {
  const grouped = new Map<string, { count: number; latestAt: Date | null }>();
  for (const row of database.rows) {
    const rawCode = row.dispatchBlockerCode?.trim() ?? '';
    if (!rawCode) {
      continue;
    }
    const code = ALLOWED_DISPATCH_BLOCKER_CODES.has(rawCode) ? rawCode : 'other';
    const current = grouped.get(code) ?? { count: 0, latestAt: null };
    current.count += 1;
    if (
      row.dispatchBlockedAt &&
      (!current.latestAt || row.dispatchBlockedAt.getTime() > current.latestAt.getTime())
    ) {
      current.latestAt = row.dispatchBlockedAt;
    }
    grouped.set(code, current);
  }

  const codes = [...grouped.entries()]
    .map(([code, summary]) => ({
      code,
      count: summary.count,
      latestAt: summary.latestAt?.toISOString() ?? null,
    }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
  return {
    totalBlockedPosts: codes.reduce((total, entry) => total + entry.count, 0),
    complete: database.consistent && !database.truncated,
    codes,
  };
}

export async function loadSchedulePolicyDiagnostics(
  prisma: PrismaClient,
  publisherBotId: string,
  generatedAt: Date,
  ownedPublishDatabase: OwnedPublishDatabaseSnapshot,
  sourceCap = SCHEDULE_POLICY_SOURCE_CAP,
): Promise<VkSchedulePolicySummary> {
  const requestedSourceCap =
    Number.isSafeInteger(sourceCap) && sourceCap > 0 ? sourceCap : SCHEDULE_POLICY_SOURCE_CAP;
  const boundedSourceCap = Math.min(requestedSourceCap, SCHEDULE_POLICY_SOURCE_CAP);
  const sourceWhere = {
    ownerProfile: VkParsingOwnerProfile.PUBLISHER,
    ownerBotId: publisherBotId,
    status: 'ACTIVE',
    importEnabled: true,
    autoPublishEnabled: true,
    autoPublishPausedAt: null,
    publishMode: { not: 'REVIEW' },
  } as const;
  const totalSourcesBefore = await prisma.vkParsingSource.count({ where: sourceWhere });
  const sources: VkSchedulePolicySource[] = await prisma.vkParsingSource.findMany({
    where: sourceWhere,
    select: {
      id: true,
      chatId: true,
      publishIntervalMinutes: true,
      minPublishIntervalMinutes: true,
      dailyLimit: true,
      publishMode: true,
    },
    orderBy: { id: 'asc' },
    take: boundedSourceCap,
  });
  const totalSourcesAfter = await prisma.vkParsingSource.count({ where: sourceWhere });
  const chatIds = [...new Set(sources.map((source) => source.chatId))];
  const settings: VkSchedulePolicySettings[] =
    chatIds.length === 0
      ? []
      : await prisma.vkParsingSettings.findMany({
          where: {
            chatId: { in: chatIds },
            ownerProfile: VkParsingOwnerProfile.PUBLISHER,
            ownerBotId: publisherBotId,
          },
          select: {
            chatId: true,
            schedulerTimezone: true,
            autoPublishEnabled: true,
            autoPublishEnabledAt: true,
            autoPublishKillSwitchEnabled: true,
          },
        });
  const settingsByChat = new Map(settings.map((row) => [row.chatId, row]));
  const dailyRangeGroups = new Map<
    string,
    { start: Date; end: Date; sourceIds: string[]; chatIds: Set<string> }
  >();
  for (const source of sources) {
    const range = getVkAutoPublishLocalDayRange(
      generatedAt,
      settingsByChat.get(source.chatId)?.schedulerTimezone,
    );
    const key = `${range.start.toISOString()}|${range.end.toISOString()}`;
    const current = dailyRangeGroups.get(key) ?? {
      start: range.start,
      end: range.end,
      sourceIds: [],
      chatIds: new Set<string>(),
    };
    current.sourceIds.push(source.id);
    current.chatIds.add(source.chatId);
    dailyRangeGroups.set(key, current);
  }

  const dailyPublishedCounts = new Map<string, number>();
  for (const range of dailyRangeGroups.values()) {
    const counts = await prisma.vkParsingPost.groupBy({
      by: ['sourceId'],
      where: {
        chatId: { in: [...range.chatIds] },
        sourceId: { in: range.sourceIds },
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: publisherBotId,
        autoPublishedAt: { gte: range.start, lt: range.end },
      },
      _count: { _all: true },
    });
    for (const row of counts) {
      dailyPublishedCounts.set(row.sourceId, row._count._all);
    }
  }

  const totalSourceCount = Math.max(totalSourcesBefore, totalSourcesAfter, sources.length);
  const sourcesWithRuntimeState = sources.map((source): VkSchedulePolicySource => {
    const sourceSettings = settingsByChat.get(source.chatId);
    const runtimeState: NonNullable<VkSchedulePolicySource['runtimeState']> = !sourceSettings
      ? 'settings_missing'
      : !sourceSettings.autoPublishEnabled
        ? 'global_auto_disabled'
        : !sourceSettings.autoPublishEnabledAt
          ? 'global_auto_incomplete'
          : sourceSettings.autoPublishKillSwitchEnabled
            ? 'kill_switch_paused'
            : 'runnable';
    return { ...source, runtimeState };
  });
  return summarizeSchedulePolicies({
    generatedAt,
    sources: sourcesWithRuntimeState,
    queuedPosts: ownedPublishDatabase.rows,
    dailyPublishedCounts,
    sourceCap: boundedSourceCap,
    totalSourceCount,
    sourceSnapshotConsistent: totalSourcesBefore === totalSourcesAfter,
    queuedCountsComplete: ownedPublishDatabase.consistent && !ownedPublishDatabase.truncated,
  });
}

export function summarizeSchedulePolicies(params: {
  generatedAt: Date;
  sources: readonly VkSchedulePolicySource[];
  queuedPosts: readonly OwnedPublishRow[];
  dailyPublishedCounts: ReadonlyMap<string, number>;
  sourceCap: number;
  totalSourceCount: number;
  sourceSnapshotConsistent: boolean;
  queuedCountsComplete: boolean;
}): VkSchedulePolicySummary {
  const queuedBySource = new Map<string, { count: number; earliestNext: Date | null }>();
  for (const post of params.queuedPosts) {
    if (post.publishReason !== 'autopublish') {
      continue;
    }
    const current = queuedBySource.get(post.sourceId) ?? { count: 0, earliestNext: null };
    current.count += 1;
    if (
      post.publishScheduledAt &&
      post.publishScheduledAt.getTime() > params.generatedAt.getTime() &&
      (!current.earliestNext || post.publishScheduledAt < current.earliestNext)
    ) {
      current.earliestNext = post.publishScheduledAt;
    }
    queuedBySource.set(post.sourceId, current);
  }

  type MutableGroup = VkSchedulePolicySummary['groups'][number] & {
    earliestNextMs: number | null;
  };
  const grouped = new Map<string, MutableGroup>();
  const runtimeStates: VkSchedulePolicySummary['runtimeStates'] = {
    runnableSourceCount: 0,
    globalAutoDisabledSourceCount: 0,
    globalAutoIncompleteSourceCount: 0,
    killSwitchPausedSourceCount: 0,
    settingsMissingSourceCount: 0,
  };
  for (const source of params.sources) {
    const publishIntervalMinutes = normalizeDiagnosticInteger(source.publishIntervalMinutes, 60, 1);
    const minPublishIntervalMinutes = normalizeDiagnosticInteger(
      source.minPublishIntervalMinutes,
      30,
      0,
    );
    const dailyLimit = normalizeDiagnosticInteger(source.dailyLimit, 3, 1);
    const normalizedMode = source.publishMode.trim().toUpperCase();
    const publishMode = ALLOWED_PUBLISH_MODES.has(normalizedMode) ? normalizedMode : 'OTHER';
    const key = [publishIntervalMinutes, minPublishIntervalMinutes, dailyLimit, publishMode].join(
      '|',
    );
    const current = grouped.get(key) ?? {
      publishIntervalMinutes,
      minPublishIntervalMinutes,
      dailyLimit,
      publishMode,
      sourceCount: 0,
      queuedCount: 0,
      dailyCapReachedSourceCount: 0,
      earliestNextScheduledAt: null,
      secondsToEarliestNext: null,
      earliestNextMs: null,
    };
    const queued = queuedBySource.get(source.id);
    const runtimeState = source.runtimeState ?? 'runnable';
    if (runtimeState === 'global_auto_disabled') {
      runtimeStates.globalAutoDisabledSourceCount += 1;
    } else if (runtimeState === 'global_auto_incomplete') {
      runtimeStates.globalAutoIncompleteSourceCount += 1;
    } else if (runtimeState === 'kill_switch_paused') {
      runtimeStates.killSwitchPausedSourceCount += 1;
    } else if (runtimeState === 'settings_missing') {
      runtimeStates.settingsMissingSourceCount += 1;
    } else {
      runtimeStates.runnableSourceCount += 1;
    }
    current.sourceCount += 1;
    current.queuedCount += queued?.count ?? 0;
    if (
      runtimeState === 'runnable' &&
      (queued?.count ?? 0) > 0 &&
      (params.dailyPublishedCounts.get(source.id) ?? 0) >= dailyLimit
    ) {
      current.dailyCapReachedSourceCount += 1;
    }
    const earliestNextMs = queued?.earliestNext?.getTime() ?? null;
    if (
      earliestNextMs !== null &&
      (current.earliestNextMs === null || earliestNextMs < current.earliestNextMs)
    ) {
      current.earliestNextMs = earliestNextMs;
    }
    grouped.set(key, current);
  }

  const allGroups = [...grouped.values()]
    .sort(
      (left, right) =>
        left.publishIntervalMinutes - right.publishIntervalMinutes ||
        left.minPublishIntervalMinutes - right.minPublishIntervalMinutes ||
        left.dailyLimit - right.dailyLimit ||
        left.publishMode.localeCompare(right.publishMode),
    )
    .map(({ earliestNextMs, ...group }) => ({
      ...group,
      earliestNextScheduledAt:
        earliestNextMs === null ? null : new Date(earliestNextMs).toISOString(),
      secondsToEarliestNext:
        earliestNextMs === null
          ? null
          : Math.max(0, Math.floor((earliestNextMs - params.generatedAt.getTime()) / 1_000)),
    }));
  return {
    sourceCap: params.sourceCap,
    totalSourceCount: params.totalSourceCount,
    scannedSourceCount: params.sources.length,
    truncated: params.sources.length < params.totalSourceCount,
    sourceSnapshotConsistent: params.sourceSnapshotConsistent,
    queuedCountsComplete: params.queuedCountsComplete,
    runtimeStates,
    groupCap: SCHEDULE_POLICY_GROUP_CAP,
    groupsTruncated: allGroups.length > SCHEDULE_POLICY_GROUP_CAP,
    groups: allGroups.slice(0, SCHEDULE_POLICY_GROUP_CAP),
  };
}

function normalizeDiagnosticInteger(value: number, fallback: number, minimum: number): number {
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

type QueueDiagnosticsResult = {
  queues: VkParsingDiagnostics['queues'];
  publishQueueReconciliation: PublishQueueReconciliation;
};

async function loadQueueDiagnostics(
  redisUrl: string | null,
  limit: number,
  publishReferenceJobIds: string[],
  ownedPublishDatabase: OwnedPublishDatabaseSnapshot,
  generatedAt: Date,
): Promise<QueueDiagnosticsResult> {
  if (!redisUrl) {
    const error = 'REDIS_URL is not set';
    return {
      queues: { available: false, error, sync: null, publish: null },
      publishQueueReconciliation: reconcilePublishQueueSnapshots({
        available: false,
        error,
        generatedAt,
        database: ownedPublishDatabase,
        queueCap: ownedPublishDatabase.cap,
        queueBefore: { paused: false, counts: {} },
        queueAfter: { paused: false, counts: {} },
        scannedQueueJobs: [],
        queueJobsTruncated: false,
        ownedJobs: [],
        sampleLimit: limit,
      }),
    };
  }

  const connection: ConnectionOptions = {
    url: redisUrl,
    commandTimeout: QUEUE_COMMAND_TIMEOUT_MS,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => (attempt <= 1 ? 250 : null),
  };
  const diagnosticQueueOptions = { connection, skipMetasUpdate: true } as const;
  const syncQueue = new Queue(VK_SYNC_QUEUE, diagnosticQueueOptions);
  const publishSampleQueue = new Queue(VK_PUBLISHER_QUEUE, diagnosticQueueOptions);
  const publishReconciliationQueue = new Queue(VK_PUBLISHER_QUEUE, diagnosticQueueOptions);
  const diagnosticQueues = [syncQueue, publishSampleQueue, publishReconciliationQueue];
  try {
    const [sync, publish, publishQueueReconciliation] = await withTimeout(
      Promise.all([
        loadQueueDiagnostic(syncQueue, VK_SYNC_QUEUE, limit),
        loadQueueDiagnostic(publishSampleQueue, VK_PUBLISHER_QUEUE, limit, publishReferenceJobIds),
        loadPublishQueueReconciliation(
          publishReconciliationQueue,
          ownedPublishDatabase,
          generatedAt,
          limit,
        ),
      ]),
      QUEUE_DIAGNOSTIC_TIMEOUT_MS,
      'VK parsing queue diagnostics timed out',
    );
    return {
      queues: { available: true, error: null, sync, publish },
      publishQueueReconciliation,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      queues: { available: false, error: message, sync: null, publish: null },
      publishQueueReconciliation: reconcilePublishQueueSnapshots({
        available: false,
        error: message,
        generatedAt,
        database: ownedPublishDatabase,
        queueCap: ownedPublishDatabase.cap,
        queueBefore: { paused: false, counts: {} },
        queueAfter: { paused: false, counts: {} },
        scannedQueueJobs: [],
        queueJobsTruncated: false,
        ownedJobs: [],
        sampleLimit: limit,
      }),
    };
  } finally {
    await Promise.allSettled(diagnosticQueues.map((queue) => queue.disconnect()));
  }
}

async function loadPublishQueueReconciliation(
  queue: Queue,
  database: OwnedPublishDatabaseSnapshot,
  generatedAt: Date,
  sampleLimit: number,
): Promise<PublishQueueReconciliation> {
  const queueBefore = await loadPublishQueueStateSnapshot(queue);
  const [ownedJobs, scannedQueue] = await Promise.all([
    mapWithConcurrency(database.rows, RECONCILIATION_JOB_CONCURRENCY, async (row) => {
      const expectedJobId = buildPublishJobId(row.id, row.publishIdempotencyKey);
      const job = expectedJobId ? await queue.getJob(expectedJobId) : null;
      return {
        expectedJobId,
        job: job ? await snapshotQueueJob(job) : null,
      };
    }),
    scanQueueJobs(queue, queueBefore.counts, database.cap),
  ]);
  const queueAfter = await loadPublishQueueStateSnapshot(queue);

  return reconcilePublishQueueSnapshots({
    available: true,
    error: null,
    generatedAt,
    database,
    queueCap: database.cap,
    queueBefore,
    queueAfter,
    scannedQueueJobs: scannedQueue.jobs,
    queueJobsTruncated: scannedQueue.truncated,
    ownedJobs,
    sampleLimit,
  });
}

async function loadPublishQueueStateSnapshot(queue: Queue): Promise<PublishQueueStateSnapshot> {
  const [counts, paused] = await Promise.all([
    queue.getJobCounts(...QUEUE_RECONCILIATION_STATES),
    queue.isPaused(),
  ]);
  return { paused, counts };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function scanQueueJobs(
  queue: Queue,
  counts: QueueCounts,
  cap: number,
): Promise<{ jobs: PublishQueueJobSnapshot[]; truncated: boolean }> {
  const jobsById = new Map<string, PublishQueueJobSnapshot>();
  let remaining = cap;

  for (const state of QUEUE_RECONCILIATION_STATES) {
    const stateCount = readNumber(counts[state]);
    for (let offset = 0; offset < stateCount && remaining > 0; ) {
      const take = Math.min(RECONCILIATION_PAGE_SIZE, stateCount - offset, remaining);
      const fetchState = state === 'waiting' ? 'wait' : state;
      const batch = await queue.getJobs([fetchState], offset, offset + take - 1, true);
      for (const job of batch) {
        if (!job) {
          continue;
        }
        const snapshot = await snapshotQueueJob(job, state);
        jobsById.set(snapshot.id, snapshot);
      }
      offset += take;
      remaining -= batch.length;
      if (batch.length === 0) {
        break;
      }
    }
    if (remaining <= 0) {
      break;
    }
  }

  const totalJobs = sumQueueStateCounts(counts);
  return {
    jobs: [...jobsById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    truncated: totalJobs > jobsById.size,
  };
}

async function snapshotQueueJob(job: Job, knownState?: string): Promise<PublishQueueJobSnapshot> {
  return {
    id: job.id ?? '',
    name: job.name,
    state: knownState ?? (await job.getState()),
    timestamp: Number.isFinite(job.timestamp) ? job.timestamp : null,
    delay: Number.isFinite(job.delay) ? job.delay : null,
    attemptsMade: Number.isFinite(job.attemptsMade) ? Math.max(0, job.attemptsMade) : 0,
    attemptsStarted: Number.isFinite(job.attemptsStarted) ? Math.max(0, job.attemptsStarted) : 0,
    processedOn: Number.isFinite(job.processedOn) ? (job.processedOn ?? null) : null,
    finishedOn: Number.isFinite(job.finishedOn) ? (job.finishedOn ?? null) : null,
    data: job.data,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function reconcilePublishQueueSnapshots(params: {
  available: boolean;
  error: string | null;
  generatedAt: Date;
  database: OwnedPublishDatabaseSnapshot;
  queueCap: number;
  queueBefore: PublishQueueStateSnapshot;
  queueAfter: PublishQueueStateSnapshot;
  scannedQueueJobs: PublishQueueJobSnapshot[];
  queueJobsTruncated: boolean;
  ownedJobs: OwnedPublishJobObservation[];
  sampleLimit: number;
}): PublishQueueReconciliation {
  const generatedAtMs = params.generatedAt.getTime();
  const rows = [...params.database.rows].sort((left, right) => left.id.localeCompare(right.id));
  const expectedJobIds = new Set(
    rows
      .map((row) => buildPublishJobId(row.id, row.publishIdempotencyKey))
      .filter((jobId): jobId is string => jobId !== null),
  );
  const ownedJobsById = new Map(params.ownedJobs.map((entry) => [entry.expectedJobId, entry]));
  const queueStateDistribution = createQueueStateDistribution(params.queueBefore.counts);
  const ownedStateDistribution = createOwnedJobStateDistribution();
  const missingSamples: PublishQueueReconciliation['missingJobs']['samples'] = [];
  const orphanSamples: PublishQueueReconciliation['orphanJobs']['samples'] = [];
  const payloadMismatchSamples: PublishQueueReconciliation['payloadMismatches']['samples'] = [];
  const scheduleDriftSamples: PublishQueueReconciliation['scheduleDrift']['samples'] = [];
  const nonComparableFutureSamples: PublishQueueReconciliation['scheduleDrift']['nonComparableFutureSamples'] =
    [];
  let missingCount = 0;
  let orphanCount = 0;
  let actionableOrphanCount = 0;
  let retainedOrphanCount = 0;
  let payloadMismatchCount = 0;
  let scheduleDriftCount = 0;
  let comparableJobs = 0;
  let nonComparableFutureJobs = 0;
  let maxAbsScheduleDriftMs = 0;
  const databaseScheduleTimes: number[] = [];
  const ownedQueueScheduleTimes: number[] = [];
  let futureScheduledRows = 0;

  for (const row of rows) {
    const databaseScheduledAtMs = dateToTimestamp(row.publishScheduledAt);
    const isFutureSchedule =
      databaseScheduledAtMs !== null && databaseScheduledAtMs > generatedAtMs;
    if (databaseScheduledAtMs !== null) {
      databaseScheduleTimes.push(databaseScheduledAtMs);
      if (isFutureSchedule) {
        futureScheduledRows += 1;
      }
    }

    if (!params.available) {
      continue;
    }

    const expectedJobId = buildPublishJobId(row.id, row.publishIdempotencyKey);
    const observation = expectedJobId ? ownedJobsById.get(expectedJobId) : undefined;
    const job = observation?.job ?? null;
    if (!job || !expectedJobId) {
      if (isFutureSchedule) {
        nonComparableFutureJobs += 1;
        if (nonComparableFutureSamples.length < params.sampleLimit) {
          nonComparableFutureSamples.push({
            postId: row.id,
            expectedJobId,
            state: null,
            reason: expectedJobId ? 'missing_job' : 'missing_idempotency_key',
          });
        }
      }
      incrementOwnedState(ownedStateDistribution, 'missing');
      missingCount += 1;
      if (missingSamples.length < params.sampleLimit) {
        missingSamples.push({
          postId: row.id,
          chatId: row.chatId,
          publishReason: row.publishReason,
          publishScheduledAt: timestampToIso(databaseScheduledAtMs),
          expectedJobId,
        });
      }
      continue;
    }

    incrementOwnedState(ownedStateDistribution, normalizeOwnedJobState(job.state));
    const queueScheduledAtMs = resolveQueueScheduledAt(job);
    if (queueScheduledAtMs !== null) {
      ownedQueueScheduleTimes.push(queueScheduledAtMs);
    } else if (isFutureSchedule) {
      nonComparableFutureJobs += 1;
      if (nonComparableFutureSamples.length < params.sampleLimit) {
        nonComparableFutureSamples.push({
          postId: row.id,
          expectedJobId,
          state: job.state,
          reason: 'non_canonical_timing',
        });
      }
    }

    const expectedPayload = {
      name: VK_PUBLISH_JOB_NAME,
      kind: 'publish',
      postId: row.id,
      chatId: row.chatId,
      reason: row.publishReason,
      idempotencyKey: row.publishIdempotencyKey,
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: row.requiredBotId,
    };
    const data = asRecord(job.data);
    const actualPayload = {
      name: job.name || null,
      kind: readStringOrNull(data?.kind),
      postId: readStringOrNull(data?.postId),
      chatId: readStringOrNull(data?.chatId),
      reason: readStringOrNull(data?.reason),
      idempotencyKey: readStringOrNull(data?.idempotencyKey),
      dispatchProfile: readStringOrNull(data?.dispatchProfile),
      requiredBotId: readStringOrNull(data?.requiredBotId),
    };
    const mismatchedFields = (
      [
        'name',
        'kind',
        'postId',
        'chatId',
        'reason',
        'idempotencyKey',
        'dispatchProfile',
        'requiredBotId',
      ] as const
    ).filter((field) => expectedPayload[field] !== actualPayload[field]);
    if (mismatchedFields.length > 0) {
      payloadMismatchCount += 1;
      if (payloadMismatchSamples.length < params.sampleLimit) {
        payloadMismatchSamples.push({
          postId: row.id,
          expectedJobId,
          state: job.state,
          mismatchedFields: [...mismatchedFields],
          expected: expectedPayload,
          actual: actualPayload,
        });
      }
    }

    if (databaseScheduledAtMs !== null && queueScheduledAtMs !== null) {
      comparableJobs += 1;
      const driftMs = Math.round(queueScheduledAtMs - databaseScheduledAtMs);
      const absoluteDriftMs = Math.abs(driftMs);
      maxAbsScheduleDriftMs = Math.max(maxAbsScheduleDriftMs, absoluteDriftMs);
      if (absoluteDriftMs > SCHEDULE_DRIFT_TOLERANCE_MS) {
        scheduleDriftCount += 1;
        if (scheduleDriftSamples.length < params.sampleLimit) {
          scheduleDriftSamples.push({
            postId: row.id,
            expectedJobId,
            state: job.state,
            databaseScheduledAt: new Date(databaseScheduledAtMs).toISOString(),
            queueScheduledAt: new Date(queueScheduledAtMs).toISOString(),
            driftMs,
          });
        }
      }
    }
  }

  if (params.available && !params.database.truncated) {
    for (const job of params.scannedQueueJobs) {
      if (expectedJobIds.has(job.id)) {
        continue;
      }
      orphanCount += 1;
      const classification = classifyUnownedQueueJob(job);
      if (classification === 'actionable') {
        actionableOrphanCount += 1;
      } else {
        retainedOrphanCount += 1;
      }
      if (orphanSamples.length < params.sampleLimit) {
        const data = asRecord(job.data);
        orphanSamples.push({
          jobId: job.id,
          state: job.state,
          postId: readStringOrNull(data?.postId),
          chatId: readStringOrNull(data?.chatId),
          reason: readStringOrNull(data?.reason),
          idempotencyKey: readStringOrNull(data?.idempotencyKey),
          queueScheduledAt: timestampToIso(resolveQueueScheduledAt(job)),
          classification,
        });
      }
    }
  }

  const databaseMaxScheduledAtMs = maxTimestamp(databaseScheduleTimes);
  const queueMaxScheduledAtMs = maxTimestamp(ownedQueueScheduleTimes);
  const queueSnapshotConsistent = areQueueStateSnapshotsEqual(
    params.queueBefore,
    params.queueAfter,
  );
  const queuePaused = params.queueBefore.paused && params.queueAfter.paused;
  const activeJobs = Math.max(
    readNumber(params.queueBefore.counts.active),
    readNumber(params.queueAfter.counts.active),
  );
  const queueQuiescent = queuePaused && activeJobs === 0 && queueSnapshotConsistent;
  const ownedAnalysisComplete =
    params.available && params.database.consistent && queueQuiescent && !params.database.truncated;
  const orphanAnalysisComplete = ownedAnalysisComplete && !params.queueJobsTruncated;
  const scheduleAnalysisComplete = ownedAnalysisComplete && nonComparableFutureJobs === 0;
  const repairGrade = orphanAnalysisComplete && scheduleAnalysisComplete;

  return {
    available: params.available,
    error: params.error,
    database: {
      totalOwnedRows: params.database.totalRows,
      scannedOwnedRows: rows.length,
      cap: params.database.cap,
      truncated: params.database.truncated,
      consistent: params.database.consistent,
      futureScheduledRows,
      maxScheduledAt: timestampToIso(databaseMaxScheduledAtMs),
      maxFutureHorizonSec: futureHorizonSec(databaseMaxScheduledAtMs, generatedAtMs),
    },
    queue: {
      paused: queuePaused,
      activeJobs,
      snapshotConsistent: queueSnapshotConsistent,
      repairGrade,
      liveSnapshot: !queueQuiescent,
      totalJobs: sumQueueStateCounts(params.queueBefore.counts),
      scannedJobs: params.scannedQueueJobs.length,
      cap: params.queueCap,
      truncated: params.queueJobsTruncated,
      stateDistribution: queueStateDistribution,
      ownedStateDistribution,
      maxOwnedJobScheduledAt: timestampToIso(queueMaxScheduledAtMs),
      maxOwnedJobFutureHorizonSec: futureHorizonSec(queueMaxScheduledAtMs, generatedAtMs),
    },
    missingJobs: {
      count: missingCount,
      complete: ownedAnalysisComplete,
      samples: missingSamples,
    },
    orphanJobs: {
      count: orphanCount,
      complete: orphanAnalysisComplete,
      samples: orphanSamples,
      actionableCount: actionableOrphanCount,
      retainedCount: retainedOrphanCount,
    },
    payloadMismatches: {
      count: payloadMismatchCount,
      complete: ownedAnalysisComplete,
      samples: payloadMismatchSamples,
    },
    scheduleDrift: {
      count: scheduleDriftCount,
      complete: scheduleAnalysisComplete,
      samples: scheduleDriftSamples,
      toleranceMs: SCHEDULE_DRIFT_TOLERANCE_MS,
      comparableJobs,
      nonComparableFutureJobs,
      nonComparableFutureSamples,
      maxAbsDriftMs: maxAbsScheduleDriftMs,
    },
  };
}

function buildPublishJobId(postId: string, idempotencyKey: string | null): string | null {
  return idempotencyKey ? `vk-parsing-publish__${postId}__${idempotencyKey}` : null;
}

function createQueueStateDistribution(counts: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    QUEUE_RECONCILIATION_STATES.map((state) => [state, readNumber(counts[state])]),
  );
}

function createOwnedJobStateDistribution(): Record<string, number> {
  return Object.fromEntries(OWNED_JOB_STATE_KEYS.map((state) => [state, 0]));
}

function normalizeOwnedJobState(state: string): (typeof OWNED_JOB_STATE_KEYS)[number] {
  return OWNED_JOB_STATE_KEYS.includes(state as (typeof OWNED_JOB_STATE_KEYS)[number])
    ? (state as (typeof OWNED_JOB_STATE_KEYS)[number])
    : 'unknown';
}

function incrementOwnedState(distribution: Record<string, number>, state: string): void {
  distribution[state] = (distribution[state] ?? 0) + 1;
}

function sumQueueStateCounts(counts: Record<string, unknown>): number {
  return QUEUE_RECONCILIATION_STATES.reduce((total, state) => total + readNumber(counts[state]), 0);
}

function areQueueStateSnapshotsEqual(
  before: PublishQueueStateSnapshot,
  after: PublishQueueStateSnapshot,
): boolean {
  return (
    before.paused === after.paused &&
    QUEUE_RECONCILIATION_STATES.every(
      (state) => readNumber(before.counts[state]) === readNumber(after.counts[state]),
    )
  );
}

function resolveQueueScheduledAt(job: PublishQueueJobSnapshot): number | null {
  if (
    job.state !== 'delayed' ||
    job.attemptsMade > 0 ||
    job.attemptsStarted > 0 ||
    job.processedOn !== null ||
    job.timestamp === null ||
    !Number.isFinite(job.timestamp)
  ) {
    return null;
  }
  const delay = job.delay !== null && Number.isFinite(job.delay) ? Math.max(0, job.delay) : 0;
  return job.timestamp + delay;
}

function classifyUnownedQueueJob(
  job: PublishQueueJobSnapshot,
): PublishQueueReconciliation['orphanJobs']['samples'][number]['classification'] {
  if (job.state === 'active') {
    return 'active';
  }
  if (job.state === 'failed' || job.state === 'completed') {
    return 'retained_terminal';
  }
  if (
    job.attemptsMade > 0 ||
    job.attemptsStarted > 0 ||
    job.processedOn !== null ||
    job.finishedOn !== null
  ) {
    return 'attempted';
  }
  if (['delayed', 'waiting', 'paused', 'prioritized'].includes(job.state)) {
    return 'actionable';
  }
  return 'other';
}

function dateToTimestamp(value: Date | null): number | null {
  const timestamp = value?.getTime() ?? Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function maxTimestamp(values: readonly number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}

function futureHorizonSec(timestamp: number | null, generatedAtMs: number): number {
  return timestamp === null ? 0 : Math.max(0, Math.floor((timestamp - generatedAtMs) / 1_000));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

async function loadQueueDiagnostic(
  queue: Queue,
  name: string,
  limit: number,
  referenceJobIds: string[] = [],
): Promise<QueueDiagnostic> {
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
    mapWithConcurrency(
      referenceJobIds,
      RECONCILIATION_JOB_CONCURRENCY,
      async (id): Promise<QueueJobReference> => {
        const job = await queue.getJob(id);
        return { id, state: job ? await job.getState() : 'missing' };
      },
    ),
  ]);

  return {
    name,
    counts,
    referencedJobs,
    jobs: jobs
      .filter((job): job is Job => Boolean(job))
      .map((job) => ({
        id: job.id ?? null,
        name: job.name,
        timestamp: timestampToIso(job.timestamp),
        processedOn: timestampToIso(job.processedOn),
        finishedOn: timestampToIso(job.finishedOn),
        failedReason: job.failedReason ?? null,
      })),
  };
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

function timestampToIso(value: number | null | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : null;
}

function dateValueToIso(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
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
  const reconciliation = diagnostics.publishQueueReconciliation;
  const nextScheduledAt = dateValueToIso(publishBacklog.nextScheduledAt);
  const referencedPublishStateCounts = (diagnostics.queues.publish?.referencedJobs ?? []).reduce<
    Record<string, number>
  >((counts, job) => {
    counts[job.state] = (counts[job.state] ?? 0) + 1;
    return counts;
  }, {});
  const reconciliationSummary = reconciliation.available
    ? `Publish reconciliation: ${reconciliation.database.scannedOwnedRows}/${
        reconciliation.database.totalOwnedRows
      } DB-owned scanned, ${reconciliation.missingJobs.count} missing, ${
        reconciliation.orphanJobs.count
      } unowned (${reconciliation.orphanJobs.actionableCount} actionable), ${
        reconciliation.payloadMismatches.count
      } payload mismatch, ${reconciliation.scheduleDrift.count} schedule drift, ${
        reconciliation.scheduleDrift.nonComparableFutureJobs
      } future schedule non-comparable, max DB future horizon ${
        reconciliation.database.maxFutureHorizonSec
      }s`
    : `Publish reconciliation unavailable: ${reconciliation.error ?? 'queue state unavailable'}`;
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
      publishBacklog.unstampedSchedulePosts,
    )} pending schedule reconciliation, ${readNumber(
      publishBacklog.staleLockedPosts,
    )} stale locked, oldest due ${readNumber(publishBacklog.oldestDueQueuedAgeSec)}s`,
    `Next canonical publish: ${nextScheduledAt ?? 'none'}, countdown ${
      nextScheduledAt ? `${readNumber(publishBacklog.secondsToNext)}s` : 'n/a'
    }`,
    `Recent successful VK autopublishes: ${diagnostics.recentPublishSuccess.count}, latest ${
      diagnostics.recentPublishSuccess.latestAt ?? 'none'
    }, complete=${diagnostics.recentPublishSuccess.complete}, sources=${
      diagnostics.recentPublishSuccess.scannedSourceCount
    }/${diagnostics.recentPublishSuccess.sourceCap}, truncated=${
      diagnostics.recentPublishSuccess.sourcesTruncated
    }`,
    `Active dispatch blockers: ${diagnostics.dispatchBlockers.totalBlockedPosts}, complete=${
      diagnostics.dispatchBlockers.complete
    }, codes=${JSON.stringify(diagnostics.dispatchBlockers.codes)}`,
    `Schedule policies: ${diagnostics.schedulePolicies.scannedSourceCount}/${
      diagnostics.schedulePolicies.totalSourceCount
    } sources scanned (cap ${diagnostics.schedulePolicies.sourceCap}), truncated=${
      diagnostics.schedulePolicies.truncated
    }, sourceSnapshotConsistent=${diagnostics.schedulePolicies.sourceSnapshotConsistent}, queuedCountsComplete=${
      diagnostics.schedulePolicies.queuedCountsComplete
    }, runtimeStates=${JSON.stringify(
      diagnostics.schedulePolicies.runtimeStates,
    )}, groups=${JSON.stringify(diagnostics.schedulePolicies.groups)}`,
    '',
    `Source status: ${JSON.stringify(diagnostics.sourceStatus)}`,
    `Media status: ${JSON.stringify(diagnostics.mediaStatus)}`,
    `Queue counts: sync=${JSON.stringify(
      diagnostics.queues.sync?.counts ?? null,
    )}, publish=${JSON.stringify(diagnostics.queues.publish?.counts ?? null)}`,
    reconciliationSummary,
    `Owned publish job states: ${JSON.stringify(reconciliation.queue.ownedStateDistribution)}`,
  ];

  if (!reconciliation.queue.repairGrade) {
    lines.push(
      `Publish reconciliation is not repair-grade: databaseConsistent=${reconciliation.database.consistent}, databaseTruncated=${reconciliation.database.truncated}, queuePaused=${reconciliation.queue.paused}, activeJobs=${reconciliation.queue.activeJobs}, queueSnapshotConsistent=${reconciliation.queue.snapshotConsistent}, queueTruncated=${reconciliation.queue.truncated}, nonComparableFutureSchedules=${reconciliation.scheduleDrift.nonComparableFutureJobs}`,
    );
  }

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
