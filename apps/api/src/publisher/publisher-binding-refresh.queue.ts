import {
  publicationPreparationBudget,
  PUBLISHER_PREFLIGHT_PRIORITY,
} from './publisher-publication-access-admission';
import {
  PublisherAccessRefreshPolicy,
  PUBLISHER_BOT_EXPIRY_URGENCY_MS,
  PUBLISHER_ROSTER_INTERVAL_MS,
} from './publisher-access-refresh-policy';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException, Optional } from '@nestjs/common';
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
  | 'scheduled_bot_access'
  | 'publication_due'
  | 'publication_actor_due'
  | 'binding_maintenance'
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
  activationSourceAt?: string;
  replyChatId?: string;
  replyToStartCommand?: boolean;
  requiresReadAccess?: boolean;
  reason: PublisherBindingRefreshReason;
  requestedAt: string;
  requiredBefore?: string;
  publicationRequested?: boolean;
  publicationRequestedAt?: string;
  publicationUrgentAt?: string;
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
  // FLAG: Aged scheduled maintenance joins urgent work in FIFO order; interactive rechecks
  // retain priority one. This is also applied to retained jobs by bounded periodic compaction.
  if (
    ['stale_access', 'scheduled_bot_access', 'binding_maintenance', 'stale_user_access'].includes(
      reason,
    ) &&
    createdAt !== undefined &&
    Number.isFinite(createdAt) &&
    Date.now() - createdAt >= PUBLISHER_ACTOR_REFRESH_AGING_MS
  )
    return 5;
  switch (reason) {
    case 'manual_recheck':
    case 'policy_enablement_recheck':
      return 1;
    case 'bot_added':
    case 'webhook_observed':
    case 'forwarded_private':
    case 'historical_actor_recovery':
    case 'send_access_lost':
    case 'publication_due':
    case 'publication_actor_due':
      return 5;
    // FLAG: The 15-minute bot snapshot gates every publication. Background actor checks
    // refresh three-day grants and must not starve this prerequisite or interactive work.
    case 'stale_access':
    case 'scheduled_bot_access':
      return 10;
    case 'binding_maintenance':
    case 'stale_user_access':
      // FLAG: New maintenance starts behind bot checks; aged work joins priority five above.
      return 20;
    case 'bootstrap':
      return 20;
  }
}

@Injectable()
export class PublisherBindingRefreshQueueService {
  constructor(
    @InjectQueue(PUBLISHER_BINDING_REFRESH_QUEUE)
    private readonly queue: Queue<PublisherBindingRefreshJob>,
    @Optional()
    private readonly policy: PublisherAccessRefreshPolicy = new PublisherAccessRefreshPolicy(),
  ) {}

  async preparationTargetBudget(): Promise<number> {
    const counts = await this.queue.getCountsPerPriority([1, 5, PUBLISHER_PREFLIGHT_PRIORITY]);
    return publicationPreparationBudget(counts);
  }

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
            const priority = this.priority(job.data, job.timestamp);
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
    replyToStartCommand?: boolean;
    requiresReadAccess?: boolean;
    requestedAt?: Date;
    eventAt?: Date | null;
    requiredBefore?: Date | null;
    publicationUrgentAt?: Date;
  }): Promise<string | null> {
    const chatId = params.chatId.trim();
    const publisherBotId = params.publisherBotId.trim();
    if (!chatId || !publisherBotId) {
      return null;
    }

    const requestedAt = params.requestedAt ?? new Date();
    const publicationRequested =
      this.policy.deadlinePrioritiesEnabled &&
      (params.reason === 'publication_due' || params.reason === 'publication_actor_due');
    const urgentAt = params.publicationUrgentAt?.getTime();
    const publicationUrgentAt = publicationRequested
      ? new Date(
          urgentAt !== undefined && Number.isFinite(urgentAt) ? urgentAt : requestedAt.getTime(),
        ).toISOString()
      : undefined;
    const deadline = params.requiredBefore?.getTime();
    const requiredBefore =
      deadline !== undefined && Number.isFinite(deadline)
        ? new Date(deadline).toISOString()
        : undefined;
    const candidateUserId = params.candidateUserId?.trim() || null;
    const candidateVersion = params.candidateVersion?.trim() || null;
    const replyChatId = params.replyChatId?.trim() || null;
    // FLAG: Preserve the authenticated event time, never the enqueue/retry time.
    const activationSourceAt =
      candidateUserId &&
      candidateVersion &&
      (params.reason === 'forwarded_private' ||
        (params.reason === 'webhook_observed' && params.replyToStartCommand)) &&
      params.eventAt instanceof Date &&
      Number.isFinite(params.eventAt.getTime())
        ? params.eventAt.toISOString()
        : undefined;
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
      ...(replyChatId ? { replyChatId } : {}),
      ...(params.replyToStartCommand ? { replyToStartCommand: true } : {}),
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
        ...(activationSourceAt ? { activationSourceAt } : {}),
        ...(replyChatId ? { replyChatId } : {}),
        ...(params.replyToStartCommand ? { replyToStartCommand: true } : {}),
        ...(params.requiresReadAccess ? { requiresReadAccess: true } : {}),
        reason: params.reason,
        requestedAt: requestedAt.toISOString(),
        ...(requiredBefore ? { requiredBefore } : {}),
        ...(publicationRequested
          ? {
              publicationRequested: true,
              publicationRequestedAt: requestedAt.toISOString(),
              publicationUrgentAt,
            }
          : {}),
      },
      {
        jobId,
        priority: this.priority({
          reason: params.reason,
          requiredBefore,
          publicationRequested,
          publicationUrgentAt,
          candidateUserId: candidateUserId ?? undefined,
        }),
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
    if (
      scheduledDeduplicationKey &&
      queued?.id &&
      (queued.id !== jobId || this.policy.deadlinePrioritiesEnabled)
    ) {
      // FLAG: Queue.add returns the retained ID on deduplication but its local data
      // describes the new request. Inspect only that exact persisted job for its age.
      const retained = await this.queue.getJob(queued.id);
      if (retained && this.scheduledDeduplicationKey(retained.data) === scheduledDeduplicationKey) {
        if (
          publicationRequested ||
          (requiredBefore &&
            (!retained.data.requiredBefore || requiredBefore < retained.data.requiredBefore))
        ) {
          if (this.policy.deadlinePrioritiesEnabled) {
            // FLAG: Concurrent producers may only move the deadline earlier. Preserve the
            // stored envelope, candidate identity and BullMQ retry/backoff fields atomically.
            const client = await this.queue.client;
            client.defineCommand('publisherRefreshPromote', {
              numberOfKeys: 1,
              lua: `
              local raw = redis.call('HGET', KEYS[1], 'data')
              if not raw then return nil end
              local data = cjson.decode(raw)
              if data.publisherBotId ~= ARGV[2] or data.chatId ~= ARGV[3] then return nil end
              if ARGV[1] ~= '' and (not data.requiredBefore or ARGV[1] < data.requiredBefore) then
                data.requiredBefore = ARGV[1]
              end
              if ARGV[4] == '1' then
                local oldUrgentAt = data.publicationUrgentAt or data.publicationRequestedAt
                data.publicationRequested = true
                if not oldUrgentAt or ARGV[6] < oldUrgentAt then data.publicationUrgentAt = ARGV[6] else data.publicationUrgentAt = oldUrgentAt end
                if not data.publicationRequestedAt or ARGV[5] < data.publicationRequestedAt then data.publicationRequestedAt = ARGV[5] end
              end
              raw = cjson.encode(data)
              redis.call('HSET', KEYS[1], 'data', raw)
              return raw`,
            });
            const updated = await client.runCommand('publisherRefreshPromote', [
              this.queue.toKey(retained.id!),
              requiredBefore ?? '',
              publisherBotId,
              chatId,
              publicationRequested ? '1' : '0',
              requestedAt.toISOString(),
              publicationUrgentAt ?? requestedAt.toISOString(),
            ]);
            if (typeof updated === 'string')
              retained.data = JSON.parse(updated) as PublisherBindingRefreshJob;
          } else {
            await retained.updateData({ ...retained.data, requiredBefore });
          }
        }
        const priority = this.priority(retained.data, retained.timestamp);
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

  private priority(
    job: Pick<
      PublisherBindingRefreshJob,
      | 'reason'
      | 'requiredBefore'
      | 'publicationRequested'
      | 'publicationUrgentAt'
      | 'candidateUserId'
    >,
    createdAt?: number,
  ): number {
    if (!this.policy.deadlinePrioritiesEnabled)
      return resolveRefreshPriority(job.reason, createdAt);
    if (job.reason === 'manual_recheck' || job.reason === 'policy_enablement_recheck') return 1;
    if (job.publicationRequested) {
      const botDeadline = !job.candidateUserId ? Date.parse(job.requiredBefore ?? '') : Number.NaN;
      if (
        Number.isFinite(botDeadline) &&
        botDeadline <= Date.now() + PUBLISHER_BOT_EXPIRY_URGENCY_MS
      )
        return 5;
      const urgentAt = Date.parse(job.publicationUrgentAt ?? '');
      return Number.isFinite(urgentAt) && urgentAt > Date.now() ? PUBLISHER_PREFLIGHT_PRIORITY : 5;
    }
    if (job.reason === 'scheduled_bot_access' || job.reason === 'stale_access') {
      const deadline = Date.parse(job.requiredBefore ?? '');
      return Number.isFinite(deadline) && deadline <= Date.now() + PUBLISHER_BOT_EXPIRY_URGENCY_MS
        ? 5
        : 10;
    }
    if (
      job.reason === 'binding_maintenance' ||
      job.reason === 'stale_user_access' ||
      job.reason === 'bootstrap'
    ) {
      return createdAt !== undefined && Date.now() - createdAt >= PUBLISHER_ROSTER_INTERVAL_MS
        ? 10
        : 20;
    }
    return 5;
  }

  private operationScope(actorId: string, botId: string): string {
    return createHash('sha256')
      .update(JSON.stringify(['publisher', actorId, botId]))
      .digest('hex');
  }

  private scheduledLogicalKey(job: PublisherBindingRefreshJob | null | undefined): string | null {
    if (
      !job ||
      job.replyChatId ||
      job.replyToStartCommand ||
      ![
        'stale_access',
        'stale_user_access',
        'scheduled_bot_access',
        'publication_due',
        'publication_actor_due',
        'binding_maintenance',
      ].includes(job.reason)
    ) {
      return null;
    }
    const chatId = job.chatId?.trim() ?? '';
    const publisherBotId = job.publisherBotId?.trim() ?? '';
    const candidateUserId = job.candidateUserId?.trim() ?? '';
    const candidateVersion = job.candidateVersion?.trim() ?? '';
    if (
      !chatId ||
      !publisherBotId ||
      ((job.reason === 'stale_user_access' || job.reason === 'publication_actor_due') &&
        !candidateUserId)
    ) {
      return null;
    }
    return JSON.stringify([
      job.reason,
      publisherBotId,
      chatId,
      candidateUserId || null,
      candidateVersion || null,
      ...(this.policy.deadlinePrioritiesEnabled
        ? [job.requiredBefore ?? null, job.publicationRequested ?? false]
        : []),
    ]);
  }

  private scheduledDeduplicationKey(
    job: PublisherBindingRefreshJob | null | undefined,
  ): string | null {
    const logicalKey = this.scheduledLogicalKey(job);
    if (!logicalKey || !job) {
      return null;
    }
    if (
      this.policy.deadlinePrioritiesEnabled &&
      (job.reason === 'scheduled_bot_access' || job.reason === 'publication_due') &&
      !job.candidateUserId &&
      !job.candidateVersion &&
      !job.replyChatId &&
      !job.replyToStartCommand
    ) {
      return JSON.stringify(['bot_access', job.publisherBotId.trim(), job.chatId.trim()]);
    }
    if (
      this.policy.deadlinePrioritiesEnabled &&
      (job.reason === 'stale_user_access' || job.reason === 'publication_actor_due') &&
      !job.replyChatId &&
      !job.replyToStartCommand
    ) {
      return JSON.stringify([
        'actor_access',
        job.publisherBotId.trim(),
        job.chatId.trim(),
        job.candidateUserId?.trim(),
        job.candidateVersion?.trim() || null,
      ]);
    }
    if (job.reason === 'stale_access' && !this.policy.deadlinePrioritiesEnabled) {
      return logicalKey;
    }
    if (this.policy.deadlinePrioritiesEnabled)
      return JSON.stringify([
        job.reason,
        job.publisherBotId.trim(),
        job.chatId.trim(),
        job.candidateUserId?.trim() || null,
        job.candidateVersion?.trim() || null,
      ]);
    return JSON.stringify([
      job.reason,
      job.publisherBotId.trim(),
      job.chatId.trim(),
      job.candidateUserId?.trim() || null,
    ]);
  }
}
