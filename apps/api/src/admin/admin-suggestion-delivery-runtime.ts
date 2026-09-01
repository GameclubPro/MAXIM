import { raceWithTimeout } from '../common/promise-timeout.util';
import type { AdminSuggestionDeliveryJob } from './admin-suggestion-delivery.queue';
import { CHANNEL_SUGGESTION_DELIVERY_JOB_TIMEOUT_MS } from './admin.service.support';
import type { AdminSuggestionDeliveryRuntimeContext } from './admin-suggestion-delivery-runtime-context';

export class AdminSuggestionDeliveryRuntime {
  constructor(private readonly context: AdminSuggestionDeliveryRuntimeContext) {}

  private get adminSuggestionDeliveryQueue() {
    return this.context.adminSuggestionDeliveryQueue;
  }

  private get logger() {
    return this.context.logger;
  }

  private processChannelSuggestionDeliveryJobWithinTimeout(auditLogId: string): Promise<void> {
    return this.context.processChannelSuggestionDeliveryJobWithinTimeout(auditLogId);
  }

  async processChannelSuggestionDeliveryJob(auditLogId: string): Promise<void> {
    await raceWithTimeout({
      operation: this.processChannelSuggestionDeliveryJobWithinTimeout(auditLogId),
      timeoutMs: CHANNEL_SUGGESTION_DELIVERY_JOB_TIMEOUT_MS,
      onTimeout: () => {
        throw new Error(
          `Channel suggestion delivery timed out after ${CHANNEL_SUGGESTION_DELIVERY_JOB_TIMEOUT_MS}ms`,
        );
      },
    });
  }

  async enqueueChannelSuggestionDelivery(
    auditLogId: string,
    options: { recoverFailed?: boolean } = {},
  ): Promise<boolean> {
    if (!this.adminSuggestionDeliveryQueue) {
      return false;
    }

    if (options.recoverFailed) {
      const recovered = await this.recoverExistingChannelSuggestionDeliveryJob(auditLogId);
      if (recovered !== null) {
        return recovered;
      }
    }

    const job = this.buildChannelSuggestionDeliveryJob(auditLogId);

    try {
      await this.adminSuggestionDeliveryQueue.add('deliver-channel-suggestion', job, {
        jobId: this.buildChannelSuggestionDeliveryJobId(auditLogId),
        attempts: 8,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 5_000,
        },
      });
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          auditLogId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to enqueue channel suggestion delivery',
      );
      return false;
    }
  }

  private async recoverExistingChannelSuggestionDeliveryJob(
    auditLogId: string,
  ): Promise<boolean | null> {
    const queue = this.adminSuggestionDeliveryQueue;
    if (!queue) {
      return false;
    }

    const jobId = this.buildChannelSuggestionDeliveryJobId(auditLogId);
    try {
      const existingJob = await queue.getJob(jobId);
      if (!existingJob) {
        return null;
      }

      const state = await existingJob.getState();
      if (state === 'failed') {
        await existingJob.retry('failed', {
          resetAttemptsMade: true,
          resetAttemptsStarted: true,
        });
        return true;
      }

      if (state === 'completed') {
        await existingJob.retry('completed', {
          resetAttemptsMade: true,
          resetAttemptsStarted: true,
        });
        return true;
      }

      return false;
    } catch (error: unknown) {
      this.logger.warn(
        {
          auditLogId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to recover channel suggestion delivery job',
      );
      return false;
    }
  }

  buildChannelSuggestionDeliveryJob(auditLogId: string): AdminSuggestionDeliveryJob {
    return {
      auditLogId,
    };
  }

  buildChannelSuggestionDeliveryJobId(auditLogId: string): string {
    return `channel-suggestion-delivery__${auditLogId}`;
  }
}
