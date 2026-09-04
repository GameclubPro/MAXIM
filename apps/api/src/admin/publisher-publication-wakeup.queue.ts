import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';
import type { QueueJobEnvelope } from '../common/queue-job-envelope';

export const PUBLISHER_PUBLICATION_WAKEUP_QUEUE = 'publisher-publication-wakeup';
export const PUBLISHER_PUBLICATION_WAKEUP_JOB = 'materialize-publication';
export const PUBLISHER_PUBLICATION_WAKEUP_JOB_TTL_MS = 15 * 60_000;

export type PublisherPublicationWakeupReason =
  | 'create'
  | 'update'
  | 'resume'
  | 'retry'
  | 'resolution';

export type PublisherPublicationWakeupRequest = {
  publicationId: string;
  mutationRequestId: string;
  reason: PublisherPublicationWakeupReason;
  occurrenceId?: string;
  requestedAt?: Date;
};

export type PublisherPublicationWakeupJob = QueueJobEnvelope<
  {
    version: 1;
    kind: 'materialize_publication';
    publicationId: string;
    occurrenceId: string | null;
    reason: PublisherPublicationWakeupReason;
  },
  {
    idempotencyKey: string;
    retryPolicyName: 'publisher-publication-wakeup';
    createdAt: string;
  }
>;

export function buildPublisherPublicationWakeupJobId(
  publicationId: string,
  mutationRequestId: string,
): string {
  const digest = createHash('sha256')
    .update(`${publicationId.trim()}\0${mutationRequestId.trim()}`)
    .digest('hex');
  return `publisher-publication-wakeup__${digest}`;
}

@Injectable()
export class PublisherPublicationWakeupQueueService {
  private readonly logger = new Logger(PublisherPublicationWakeupQueueService.name);

  constructor(
    @InjectQueue(PUBLISHER_PUBLICATION_WAKEUP_QUEUE)
    private readonly queue: Queue<PublisherPublicationWakeupJob>,
  ) {}

  async enqueueResolution(
    publicationId: string,
    occurrenceId: string,
    mutationRequestId: string,
  ): Promise<void> {
    await this.enqueueAfterCommittedMutation({
      publicationId,
      occurrenceId,
      mutationRequestId,
      reason: 'resolution',
    });
  }

  async enqueueAfterCommittedMutation(params: PublisherPublicationWakeupRequest): Promise<void> {
    try {
      await this.enqueue(params);
    } catch (error: unknown) {
      // FLAG: PostgreSQL is the publication source of truth. A Redis/BullMQ outage must not turn a
      // committed user mutation into a 500; the 15-second database poll remains the recovery path.
      this.logger.warn(
        {
          publicationId: params.publicationId,
          occurrenceId: params.occurrenceId,
          mutationRequestId: params.mutationRequestId,
          reason: params.reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to enqueue Publisher publication wakeup after committed mutation',
      );
    }
  }

  async enqueue(params: PublisherPublicationWakeupRequest): Promise<void> {
    const publicationId = params.publicationId.trim();
    const mutationRequestId = params.mutationRequestId.trim();
    const occurrenceId = params.occurrenceId?.trim() || null;
    if (!publicationId || !mutationRequestId) {
      throw new Error('Publisher publication wakeup requires publication and mutation ids');
    }
    const requiresOccurrence = params.reason === 'retry' || params.reason === 'resolution';
    if (requiresOccurrence !== Boolean(occurrenceId)) {
      throw new Error('Publisher publication occurrence wakeup requires an exact occurrence id');
    }

    const jobId = buildPublisherPublicationWakeupJobId(publicationId, mutationRequestId);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== 'failed') {
        return;
      }
      await existing.remove();
    }

    await this.queue.add(
      PUBLISHER_PUBLICATION_WAKEUP_JOB,
      {
        version: 1,
        kind: 'materialize_publication',
        publicationId,
        occurrenceId,
        reason: params.reason,
        idempotencyKey: jobId,
        retryPolicyName: 'publisher-publication-wakeup',
        createdAt: (params.requestedAt ?? new Date()).toISOString(),
      },
      {
        jobId,
        priority: 1,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 60 * 60, count: 10_000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 10_000 },
      },
    );
  }
}
