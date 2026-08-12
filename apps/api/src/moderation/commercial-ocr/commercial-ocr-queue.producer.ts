import type { OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';

import { raceWithTimeout } from '../../common/promise-timeout.util';
import { COMMERCIAL_OCR_REDIS_OPTIONS } from './commercial-ocr-redis.options';
import {
  COMMERCIAL_OCR_JOB_NAME,
  COMMERCIAL_OCR_QUEUE,
  type CommercialOcrJob,
} from './commercial-ocr.queue';

export const COMMERCIAL_OCR_QUEUE_ADD_TIMEOUT_MS = 1_000;

export const COMMERCIAL_OCR_PRODUCER_REDIS_OPTIONS = Object.freeze({
  ...COMMERCIAL_OCR_REDIS_OPTIONS,
  retryStrategy: () => null,
});

type CommercialOcrProducerQueue = Pick<
  Queue<CommercialOcrJob>,
  'add' | 'close' | 'disconnect' | 'on'
>;

export type CommercialOcrProducerQueueFactory = (
  redisUrl: string,
) => CommercialOcrProducerQueue;

export function createCommercialOcrProducerQueue(
  redisUrl: string,
): CommercialOcrProducerQueue {
  return new Queue<CommercialOcrJob>(COMMERCIAL_OCR_QUEUE, {
    connection: {
      url: redisUrl,
      ...COMMERCIAL_OCR_PRODUCER_REDIS_OPTIONS,
    },
  });
}

export class CommercialOcrQueueProducer implements OnModuleDestroy {
  private queue: CommercialOcrProducerQueue | null = null;
  private destroyed = false;

  constructor(
    private readonly redisUrl: string,
    private readonly queueFactory: CommercialOcrProducerQueueFactory =
      createCommercialOcrProducerQueue,
  ) {}

  async add(
    name: typeof COMMERCIAL_OCR_JOB_NAME,
    data: CommercialOcrJob,
    options: JobsOptions,
  ): Promise<unknown> {
    if (this.destroyed) {
      throw new Error('Commercial OCR queue producer is shutting down');
    }

    const queue = this.queue ?? this.createQueue();
    try {
      return await raceWithTimeout({
        operation: queue.add(name, data, options),
        timeoutMs: COMMERCIAL_OCR_QUEUE_ADD_TIMEOUT_MS,
        onTimeout: () => {
          throw new Error(
            `Commercial OCR Queue.add timed out after ${COMMERCIAL_OCR_QUEUE_ADD_TIMEOUT_MS}ms`,
          );
        },
      });
    } catch (error: unknown) {
      this.discardQueue(queue);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    const queue = this.queue;
    this.queue = null;
    if (queue) {
      try {
        await raceWithTimeout({
          operation: queue.close(),
          timeoutMs: COMMERCIAL_OCR_QUEUE_ADD_TIMEOUT_MS,
          onTimeout: () => {
            throw new Error('Commercial OCR queue producer close timed out');
          },
        });
      } catch {
        await this.forceDisconnect(queue);
      }
    }
  }

  private createQueue(): CommercialOcrProducerQueue {
    const queue = this.queueFactory(this.redisUrl);
    // BullMQ forwards Redis connection failures through EventEmitter. Keep a listener attached so
    // the same failure can reject add() without becoming an uncaught process-level error event.
    queue.on('error', () => undefined);
    this.queue = queue;
    return queue;
  }

  private discardQueue(queue: CommercialOcrProducerQueue): void {
    if (this.queue === queue) {
      this.queue = null;
    }
    // Do not extend the webhook path after its add deadline. BullMQ disconnect force-closes the
    // underlying ioredis socket; the detached rejection handler prevents shutdown noise.
    void this.forceDisconnect(queue);
  }

  private async forceDisconnect(queue: CommercialOcrProducerQueue): Promise<void> {
    try {
      await queue.disconnect();
    } catch {
      // The producer is already detached from future work; shutdown is best-effort and fail-open.
    }
  }
}
