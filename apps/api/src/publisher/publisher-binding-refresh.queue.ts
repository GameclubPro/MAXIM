import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Job, JobType, Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import type { PublisherRefreshOperation } from '@maxim/contracts/publisher';

export const PUBLISHER_BINDING_REFRESH_QUEUE = 'publisher-binding-refresh';

export type PublisherBindingRefreshReason =
  | 'bot_added'
  | 'webhook_observed'
  | 'forwarded_private'
  | 'historical_actor_recovery'
  | 'bootstrap'
  | 'stale_access'
  | 'stale_user_access'
  | 'manual_recheck'
  | 'policy_enablement_recheck'
  | 'send_access_lost';

export type PublisherBindingRefreshJob = {
  version: 1;
  chatId: string;
  publisherBotId: string;
  candidateUserId?: string;
  candidateVersion?: string;
  replyChatId?: string;
  requiresReadAccess?: boolean;
  reason: PublisherBindingRefreshReason;
  requestedAt: string;
};

const PUBLISHER_REFRESH_JOB_BUCKET_MS = 60_000;
const PUBLISHER_MANUAL_RECHECK_DEDUPLICATION_MS = 5_000;
const PUBLISHER_ACTOR_REFRESH_AGING_MS = 60_000;
const PUBLISHER_WEBHOOK_OBSERVED_DEDUPLICATION_MS = 60_000;
const PUBLISHER_SCHEDULED_COMPACTION_PAGE_SIZE = 250;
const PUBLISHER_SCHEDULED_COMPACTION_MAX_SCANNED = 5_000;
const PUBLISHER_SCHEDULED_COMPACTION_MAX_REMOVALS = 5_000;
const PUBLISHER_SCHEDULED_COMPACTION_REMOVE_CONCURRENCY = 8;
const PUBLISHER_SCHEDULED_COMPACTION_STATES: JobType[] = [
  'prioritized',
  'waiting',
  'delayed',
  'paused',
];

export type PublisherScheduledBacklogCompactionResult = {
  scannedCount: number;
  scheduledCount: number;
  duplicateCount: number;
  removedCount: number;
  reprioritizedCount: number;
  racedCount: number;
  truncated: boolean;
};

function resolveRefreshPriority(reason: PublisherBindingRefreshReason, createdAt?: number): number {
  switch (reason) {
    case 'manual_recheck':
    case 'policy_enablement_recheck':
      return 1;
    case 'bot_added':
    case 'webhook_observed':
    case 'forwarded_private':
    case 'historical_actor_recovery':
    case 'send_access_lost':
      return 5;
    // FLAG: The 15-minute bot snapshot gates every publication. Background actor checks
    // refresh three-day grants and must not starve this prerequisite or interactive work.
    case 'stale_access':
      return 10;
    case 'stale_user_access':
      // FLAG: Aged actor checks join the bot queue in FIFO order so future bot jobs
      // cannot overtake them forever. Manual and lifecycle priorities remain ahead.
      return createdAt !== undefined &&
        Number.isFinite(createdAt) &&
        Date.now() - createdAt >= PUBLISHER_ACTOR_REFRESH_AGING_MS
        ? 10
        : 20;
    case 'bootstrap':
      return 20;
  }
}

@Injectable()
export class PublisherBindingRefreshQueueService {
  constructor(
    @InjectQueue(PUBLISHER_BINDING_REFRESH_QUEUE)
    private readonly queue: Queue<PublisherBindingRefreshJob>,
  ) {}

  async compactScheduledBacklog(): Promise<PublisherScheduledBacklogCompactionResult> {
    const scanned: Job<PublisherBindingRefreshJob>[] = [];
    for (const state of PUBLISHER_SCHEDULED_COMPACTION_STATES) {
      for (
        let offset = 0;
        scanned.length < PUBLISHER_SCHEDULED_COMPACTION_MAX_SCANNED;
        offset += PUBLISHER_SCHEDULED_COMPACTION_PAGE_SIZE
      ) {
        const remaining = PUBLISHER_SCHEDULED_COMPACTION_MAX_SCANNED - scanned.length;
        const take = Math.min(PUBLISHER_SCHEDULED_COMPACTION_PAGE_SIZE, remaining);
        // BullMQ applies start/end to every requested state independently. Scan one state per call
        // so the shared startup budget bounds the actual Redis response and retained Job objects.
        const page = await this.queue.getJobs([state], offset, offset + take - 1, true);
        scanned.push(
          ...page
            .filter((job): job is Job<PublisherBindingRefreshJob> => Boolean(job))
            .slice(0, remaining),
        );
        if (page.length < take) {
          break;
        }
      }
      if (scanned.length >= PUBLISHER_SCHEDULED_COMPACTION_MAX_SCANNED) {
        break;
      }
    }

    const scheduled = scanned
      .filter((job) => this.scheduledLogicalKey(job.data) !== null)
      .sort(
        (left, right) =>
          left.timestamp - right.timestamp ||
          String(left.id ?? '').localeCompare(String(right.id ?? '')),
      );
    const seen = new Set<string>();
    const duplicates: Job<PublisherBindingRefreshJob>[] = [];
    const retained: Job<PublisherBindingRefreshJob>[] = [];
    for (const job of scheduled) {
      const logicalKey = this.scheduledLogicalKey(job.data)!;
      if (seen.has(logicalKey)) {
        if (duplicates.length < PUBLISHER_SCHEDULED_COMPACTION_MAX_REMOVALS) {
          duplicates.push(job);
        }
      } else {
        seen.add(logicalKey);
        retained.push(job);
      }
    }

    let removedCount = 0;
    let reprioritizedCount = 0;
    let racedCount = 0;
    for (
      let offset = 0;
      offset < duplicates.length;
      offset += PUBLISHER_SCHEDULED_COMPACTION_REMOVE_CONCURRENCY
    ) {
      await Promise.all(
        duplicates
          .slice(offset, offset + PUBLISHER_SCHEDULED_COMPACTION_REMOVE_CONCURRENCY)
          .map(async (job) => {
            try {
              await job.remove();
              removedCount += 1;
            } catch {
              // A worker may activate or finish the job after the non-active snapshot was read.
              racedCount += 1;
            }
          }),
      );
    }

    // FLAG: Repair persisted priorities as well as new producers. BullMQ changes priority
    // atomically without activating delayed/active jobs or replacing their deduplication key.
    for (
      let offset = 0;
      offset < retained.length;
      offset += PUBLISHER_SCHEDULED_COMPACTION_REMOVE_CONCURRENCY
    ) {
      await Promise.all(
        retained
          .slice(offset, offset + PUBLISHER_SCHEDULED_COMPACTION_REMOVE_CONCURRENCY)
          .map(async (job) => {
            const priority = resolveRefreshPriority(job.data.reason, job.timestamp);
            if (job.priority === priority) return;
            try {
              await job.changePriority({ priority });
              reprioritizedCount += 1;
            } catch {
              // The job may have completed and expired after the bounded snapshot.
              racedCount += 1;
            }
          }),
      );
    }

    return {
      scannedCount: scanned.length,
      scheduledCount: scheduled.length,
      duplicateCount: duplicates.length,
      removedCount,
      reprioritizedCount,
      racedCount,
      truncated:
        scanned.length >= PUBLISHER_SCHEDULED_COMPACTION_MAX_SCANNED ||
        scheduled.length - seen.size > duplicates.length,
    };
  }

  async enqueue(params: {
    chatId: string;
    publisherBotId: string;
    reason: PublisherBindingRefreshReason;
    candidateUserId?: string | null;
    candidateVersion?: string | null;
    replyChatId?: string | null;
    requiresReadAccess?: boolean;
    requestedAt?: Date;
    eventAt?: Date | null;
  }): Promise<string | null> {
    const chatId = params.chatId.trim();
    const publisherBotId = params.publisherBotId.trim();
    if (!chatId || !publisherBotId) {
      return null;
    }

    const requestedAt = params.requestedAt ?? new Date();
    const candidateUserId = params.candidateUserId?.trim() || null;
    const candidateVersion = params.candidateVersion?.trim() || null;
    const replyChatId = params.replyChatId?.trim() || null;
    const interactiveRecheck =
      params.reason === 'manual_recheck' || params.reason === 'policy_enablement_recheck';
    const coalescedWebhookObservation =
      params.reason === 'webhook_observed' && candidateUserId === null;
    const discriminator = interactiveRecheck
      ? requestedAt.getTime()
      : coalescedWebhookObservation
        ? Math.floor(requestedAt.getTime() / PUBLISHER_REFRESH_JOB_BUCKET_MS)
        : params.eventAt
          ? params.eventAt.getTime()
          : Math.floor(requestedAt.getTime() / PUBLISHER_REFRESH_JOB_BUCKET_MS);
    const entityHash = createHash('sha256')
      .update(`${publisherBotId}\0${chatId}`)
      .digest('hex')
      .slice(0, 24);
    const candidateHash = candidateUserId
      ? createHash('sha256').update(candidateUserId).digest('hex').slice(0, 16)
      : null;
    const candidateVersionHash = candidateVersion
      ? createHash('sha256').update(candidateVersion).digest('hex').slice(0, 16)
      : null;
    const candidateScope = `${candidateHash ? `-${candidateHash}` : ''}${
      candidateVersionHash ? `-${candidateVersionHash}` : ''
    }`;
    const jobId = `publisher-binding-refresh-${entityHash}${candidateScope}-${params.reason}-${discriminator}`;
    const scheduledDeduplicationKey = this.scheduledDeduplicationKey({
      version: 1,
      chatId,
      publisherBotId,
      ...(candidateUserId ? { candidateUserId } : {}),
      ...(candidateVersion ? { candidateVersion } : {}),
      reason: params.reason,
      requestedAt: requestedAt.toISOString(),
    });

    const queued = await this.queue.add(
      'refresh',
      {
        version: 1,
        chatId,
        publisherBotId,
        ...(candidateUserId ? { candidateUserId } : {}),
        ...(candidateVersion ? { candidateVersion } : {}),
        ...(replyChatId ? { replyChatId } : {}),
        ...(params.requiresReadAccess ? { requiresReadAccess: true } : {}),
        reason: params.reason,
        requestedAt: requestedAt.toISOString(),
      },
      {
        jobId,
        priority: resolveRefreshPriority(params.reason),
        ...(interactiveRecheck
          ? {
              deduplication: {
                id:
                  params.reason === 'manual_recheck'
                    ? `publisher-binding-refresh-manual-${entityHash}${candidateScope}`
                    : `publisher-binding-refresh-policy-enablement-${entityHash}`,
                ...(params.reason === 'policy_enablement_recheck'
                  ? { ttl: PUBLISHER_MANUAL_RECHECK_DEDUPLICATION_MS }
                  : {}),
              },
            }
          : coalescedWebhookObservation
            ? {
                deduplication: {
                  id: `publisher-binding-refresh-observed-${entityHash}`,
                  ttl: PUBLISHER_WEBHOOK_OBSERVED_DEDUPLICATION_MS,
                },
              }
            : scheduledDeduplicationKey
              ? {
                  deduplication: {
                    id: `publisher-binding-refresh-scheduled-${createHash('sha256')
                      .update(scheduledDeduplicationKey)
                      .digest('hex')
                      .slice(0, 40)}`,
                  },
                }
              : {}),
        attempts: 6,
        backoff: {
          type: 'exponential',
          delay: 15_000,
        },
        removeOnComplete: {
          age: 60 * 60,
          count: 10_000,
        },
        removeOnFail: {
          age: 7 * 24 * 60 * 60,
          count: 10_000,
        },
      },
    );
    if (params.reason === 'stale_user_access' && queued?.id && queued.id !== jobId) {
      // FLAG: Queue.add returns the retained ID on deduplication but its local data
      // describes the new request. Inspect only that exact persisted job for its age.
      const retained = await this.queue.getJob(queued.id);
      if (
        retained &&
        retained.data.reason === 'stale_user_access' &&
        this.scheduledDeduplicationKey(retained.data) === scheduledDeduplicationKey
      ) {
        const priority = resolveRefreshPriority(retained.data.reason, retained.timestamp);
        if (retained.priority > priority) await retained.changePriority({ priority });
      }
    }
    return queued?.id ?? jobId;
  }

  async saveOperation(actorId: string, botId: string, jobIds: readonly string[]): Promise<string> {
    const operationId = randomUUID();
    const client = await this.queue.client;
    await client.set(
      this.queue.toKey(`operation-${operationId}`),
      JSON.stringify({
        scope: this.operationScope(actorId, botId),
        jobIds: [...new Set(jobIds)],
      }),
      { EX: 3600 },
    );
    return operationId;
  }

  async readOperation(
    operationId: string,
    actorId: string,
    botId: string,
  ): Promise<PublisherRefreshOperation> {
    if (!/^[a-f0-9-]{36}$/i.test(operationId)) throw new NotFoundException();
    const client = await this.queue.client;
    const raw = await client.get(this.queue.toKey(`operation-${operationId}`));
    if (!raw) throw new NotFoundException('Проверка недоступна или срок её хранения истёк.');
    const operation = JSON.parse(raw) as { scope: string; jobIds: string[] };
    if (operation.scope !== this.operationScope(actorId, botId)) throw new NotFoundException();
    let completed = 0;
    let failed = 0;
    let running = 0;
    let missing = 0;
    client.defineCommand('publisherRefreshJobState', {
      numberOfKeys: 3,
      readOnly: true,
      lua: `if redis.call('HEXISTS', KEYS[1], 'timestamp') == 0 then return 0 end
        if redis.call('ZSCORE', KEYS[3], ARGV[1]) then return 4 end
        if redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 3 end
        if redis.call('HEXISTS', KEYS[1], 'processedOn') == 1 then return 2 end
        return 1`,
    });
    // Read only exact jobs in bounded Redis pipelines. A lost/evicted job is unknown,
    // never evidence that permission checks completed successfully.
    for (let offset = 0; offset < operation.jobIds.length; offset += 200) {
      const pipeline = client.pipeline();
      for (const id of operation.jobIds.slice(offset, offset + 200)) {
        pipeline.runCommand('publisherRefreshJobState', [
          this.queue.toKey(id),
          this.queue.toKey('completed'),
          this.queue.toKey('failed'),
          id,
        ]);
      }
      const rows = await pipeline.exec();
      if (!rows) throw new Error('Publisher refresh status unavailable');
      for (const [error, state] of rows) {
        if (error) throw error;
        if (state === 0) missing += 1;
        else if (state === 4) failed += 1;
        else if (state === 3) completed += 1;
        else if (state === 2) running += 1;
      }
    }
    const total = operation.jobIds.length;
    return {
      operationId,
      total,
      completed,
      failed,
      state:
        missing > 0
          ? 'unavailable'
          : completed + failed === total
            ? failed > 0
              ? 'partial'
              : 'complete'
            : running + completed + failed > 0
              ? 'running'
              : 'queued',
    };
  }

  private operationScope(actorId: string, botId: string): string {
    return createHash('sha256')
      .update(JSON.stringify(['publisher', actorId, botId]))
      .digest('hex');
  }

  private scheduledLogicalKey(job: PublisherBindingRefreshJob | null | undefined): string | null {
    if (!job || (job.reason !== 'stale_access' && job.reason !== 'stale_user_access')) {
      return null;
    }
    const chatId = job.chatId?.trim() ?? '';
    const publisherBotId = job.publisherBotId?.trim() ?? '';
    const candidateUserId = job.candidateUserId?.trim() ?? '';
    const candidateVersion = job.candidateVersion?.trim() ?? '';
    if (!chatId || !publisherBotId || (job.reason === 'stale_user_access' && !candidateUserId)) {
      return null;
    }
    return JSON.stringify([
      job.reason,
      publisherBotId,
      chatId,
      candidateUserId || null,
      candidateVersion || null,
    ]);
  }

  private scheduledDeduplicationKey(
    job: PublisherBindingRefreshJob | null | undefined,
  ): string | null {
    const logicalKey = this.scheduledLogicalKey(job);
    if (!logicalKey || !job) {
      return null;
    }
    if (job.reason === 'stale_access') {
      return logicalKey;
    }
    return JSON.stringify([
      job.reason,
      job.publisherBotId.trim(),
      job.chatId.trim(),
      job.candidateUserId?.trim() || null,
    ]);
  }
}
