import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job, JobType, Queue } from 'bullmq';
import { createHash } from 'node:crypto';

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
  racedCount: number;
  truncated: boolean;
};

function resolveRefreshPriority(reason: PublisherBindingRefreshReason): number {
  switch (reason) {
    case 'manual_recheck':
    case 'policy_enablement_recheck':
      return 1;
    case 'bot_added':
    case 'webhook_observed':
    case 'forwarded_private':
    case 'historical_actor_recovery':
    case 'send_access_lost':
    case 'stale_user_access':
      return 5;
    case 'bootstrap':
    case 'stale_access':
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
    for (const job of scheduled) {
      const logicalKey = this.scheduledLogicalKey(job.data)!;
      if (seen.has(logicalKey)) {
        if (duplicates.length < PUBLISHER_SCHEDULED_COMPACTION_MAX_REMOVALS) {
          duplicates.push(job);
        }
      } else {
        seen.add(logicalKey);
      }
    }

    let removedCount = 0;
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

    return {
      scannedCount: scanned.length,
      scheduledCount: scheduled.length,
      duplicateCount: duplicates.length,
      removedCount,
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
  }): Promise<void> {
    const chatId = params.chatId.trim();
    const publisherBotId = params.publisherBotId.trim();
    if (!chatId || !publisherBotId) {
      return;
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

    await this.queue.add(
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
                ttl: PUBLISHER_MANUAL_RECHECK_DEDUPLICATION_MS,
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
