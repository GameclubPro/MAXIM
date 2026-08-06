import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DelayedError, type Job } from 'bullmq';
import { getAppRole, roleRunsModeration } from '../../runtime/app-role';
import { ModerationExecutionService } from '../moderation-execution.service';
import {
  PHOTO_DUPLICATE_ORDERING_DEFER_MS,
  PHOTO_DUPLICATE_QUEUE,
  PHOTO_DUPLICATE_SOURCE_READY_DEFER_MS,
  PHOTO_DUPLICATE_SOURCE_READY_MAX_WAIT_MS,
  PhotoDuplicateSourceNotReadyError,
  normalizePhotoDuplicateActionEligibility,
  type PhotoDuplicateJob,
} from './photo-duplicate.queue';
import {
  PhotoDuplicateOrderingStore,
  type PhotoDuplicateOrderingIdentity,
} from './photo-duplicate-ordering.store';

@Processor(PHOTO_DUPLICATE_QUEUE, {
  concurrency: 2,
})
export class PhotoDuplicateProcessor extends WorkerHost {
  private readonly logger = new Logger(PhotoDuplicateProcessor.name);

  constructor(
    private readonly moderationExecutionService: ModerationExecutionService,
    private readonly orderingStore: PhotoDuplicateOrderingStore,
  ) {
    super();
  }

  async process(job: Job<PhotoDuplicateJob>, token?: string): Promise<void> {
    if (!roleRunsModeration(getAppRole())) {
      return;
    }
    const jobId = job.data.idempotencyKey ?? job.id;
    if (!jobId) {
      throw new Error('Photo duplicate job is missing its idempotency key');
    }
    const jobData = Object.freeze({
      ...job.data,
      actionEligible: normalizePhotoDuplicateActionEligibility(job.data.actionEligible),
    }) satisfies PhotoDuplicateJob;
    const identity = {
      jobId,
      chatId: jobData.chatId,
      sourceCreatedAt: jobData.sourceCreatedAt,
    };
    let result: Awaited<ReturnType<PhotoDuplicateOrderingStore['runInOrder']>>;
    try {
      result = await this.orderingStore.runInOrder(
        identity,
        jobData.actionEligible,
        (lease, orderingActionEligible) => {
          const effectiveJobData = Object.freeze({
            ...jobData,
            actionEligible:
              jobData.actionEligible &&
              normalizePhotoDuplicateActionEligibility(orderingActionEligible),
          }) satisfies PhotoDuplicateJob;
          return this.moderationExecutionService.processPhotoDuplicateJob(effectiveJobData, lease);
        },
      );
    } catch (error: unknown) {
      if (error instanceof PhotoDuplicateSourceNotReadyError) {
        if (this.sourceReadyDeadlineExpired(job)) {
          await this.orderingStore.abandon(identity);
          this.logger.warn(
            { jobId, webhookEventId: job.data.webhookEventId },
            'Photo duplicate source did not become ready before the deadline; job abandoned',
          );
          return;
        }
        await this.deferWithoutConsumingAttempt({
          job,
          token,
          identity,
          delayMs: PHOTO_DUPLICATE_SOURCE_READY_DEFER_MS,
          reason: 'source_not_ready',
        });
      }
      await this.abandonIfFinalAttempt(job, identity);
      throw error;
    }

    if (result.kind !== 'defer') {
      return;
    }
    await this.deferWithoutConsumingAttempt({
      job,
      token,
      identity,
      delayMs: PHOTO_DUPLICATE_ORDERING_DEFER_MS,
      reason: result.reason,
    });
  }

  private async deferWithoutConsumingAttempt(params: {
    job: Job<PhotoDuplicateJob>;
    token?: string;
    identity: PhotoDuplicateOrderingIdentity;
    delayMs: number;
    reason: string;
  }): Promise<never> {
    if (!params.token) {
      await this.abandonIfFinalAttempt(params.job, params.identity);
      throw new Error(`Photo duplicate deferred without a lock token: ${params.reason}`);
    }
    try {
      await params.job.moveToDelayed(Date.now() + params.delayMs, params.token);
    } catch (error: unknown) {
      await this.abandonIfFinalAttempt(params.job, params.identity);
      throw new Error(`Photo duplicate defer failed: ${params.reason}`, { cause: error });
    }
    throw new DelayedError();
  }

  private async abandonIfFinalAttempt(
    job: Job<PhotoDuplicateJob>,
    identity: PhotoDuplicateOrderingIdentity,
  ): Promise<void> {
    const attempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
    if (job.attemptsMade + 1 >= attempts) {
      await this.orderingStore.abandon(identity);
    }
  }

  private sourceReadyDeadlineExpired(job: Job<PhotoDuplicateJob>): boolean {
    const queuedAtMs =
      Number.isFinite(job.timestamp) && job.timestamp > 0
        ? job.timestamp
        : Date.parse(job.data.createdAt ?? '');
    return (
      !Number.isFinite(queuedAtMs) ||
      Date.now() - queuedAtMs >= PHOTO_DUPLICATE_SOURCE_READY_MAX_WAIT_MS
    );
  }
}
