import { raceWithTimeout } from '../common/promise-timeout.util';
import type { AdminSuggestionDeliveryJob } from './admin-suggestion-delivery.queue';
import { CHANNEL_SUGGESTION_DELIVERY_JOB_TIMEOUT_MS } from './admin.service.support';

export class AdminSuggestionDeliveryRuntime {
  [key: string]: any;

  constructor(private readonly context: any) {
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return this.context[prop as keyof typeof this.context];
      },
      set: (target, prop, value, receiver) => {
        if (prop in target) {
          return Reflect.set(target, prop, value, receiver);
        }
        this.context[prop as keyof typeof this.context] = value;
        return true;
      },
    });
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

  async enqueueChannelSuggestionDelivery(auditLogId: string): Promise<boolean> {
    if (!this.adminSuggestionDeliveryQueue) {
      return false;
    }

    const job = this.buildChannelSuggestionDeliveryJob(auditLogId);

    try {
      await this.adminSuggestionDeliveryQueue.add('deliver-channel-suggestion', job, {
        jobId: this.buildChannelSuggestionDeliveryJobId(auditLogId),
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 1_000,
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

  buildChannelSuggestionDeliveryJob(auditLogId: string): AdminSuggestionDeliveryJob {
    return {
      auditLogId,
    };
  }

  buildChannelSuggestionDeliveryJobId(auditLogId: string): string {
    return `channel-suggestion-delivery__${auditLogId}`;
  }
}
