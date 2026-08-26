import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';

export const PUBLISHER_BINDING_REFRESH_QUEUE = 'publisher-binding-refresh';

export type PublisherBindingRefreshReason =
  | 'bot_added'
  | 'webhook_observed'
  | 'bootstrap'
  | 'stale_access'
  | 'send_access_lost';

export type PublisherBindingRefreshJob = {
  version: 1;
  chatId: string;
  publisherBotId: string;
  reason: PublisherBindingRefreshReason;
  requestedAt: string;
};

const PUBLISHER_REFRESH_JOB_BUCKET_MS = 60_000;

@Injectable()
export class PublisherBindingRefreshQueueService {
  constructor(
    @InjectQueue(PUBLISHER_BINDING_REFRESH_QUEUE)
    private readonly queue: Queue<PublisherBindingRefreshJob>,
  ) {}

  async enqueue(params: {
    chatId: string;
    publisherBotId: string;
    reason: PublisherBindingRefreshReason;
    requestedAt?: Date;
    eventAt?: Date | null;
  }): Promise<void> {
    const chatId = params.chatId.trim();
    const publisherBotId = params.publisherBotId.trim();
    if (!chatId || !publisherBotId) {
      return;
    }

    const requestedAt = params.requestedAt ?? new Date();
    const discriminator = params.eventAt
      ? params.eventAt.getTime()
      : Math.floor(requestedAt.getTime() / PUBLISHER_REFRESH_JOB_BUCKET_MS);
    const entityHash = createHash('sha256')
      .update(`${publisherBotId}\0${chatId}`)
      .digest('hex')
      .slice(0, 24);
    const jobId = `publisher-binding-refresh-${entityHash}-${params.reason}-${discriminator}`;

    await this.queue.add(
      'refresh',
      {
        version: 1,
        chatId,
        publisherBotId,
        reason: params.reason,
        requestedAt: requestedAt.toISOString(),
      },
      {
        jobId,
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
}
