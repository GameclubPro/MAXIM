import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { PhotoDuplicateOrderingStore } from '../photo-duplicate/photo-duplicate-ordering.store';
import { digestDuplicateContent } from './message-duplicate-content';

export const MESSAGE_DUPLICATE_QUEUE = 'message-duplicates';
export const MESSAGE_DUPLICATE_JOB_VERSION = 1;
export type MessageDuplicateJob = {
  version: 1;
  webhookEventId: string;
  chatId: string;
  messageId: string;
  eventTimestampMs: number;
  controlRevision: number;
  settingsDigest: string;
  sourceCreatedAt: string;
  createdAt: string;
  actionEligible: boolean;
  idempotencyKey: string;
};

@Injectable()
export class MessageDuplicateOrderingStore extends PhotoDuplicateOrderingStore {
  protected override readonly namespace = 'message-duplicate:ordering:v1';
  constructor(config: ConfigService) {
    super(config);
  }
}

@Injectable()
export class MessageDuplicateEnqueueService {
  constructor(
    @Optional()
    @InjectQueue(MESSAGE_DUPLICATE_QUEUE)
    private readonly queue?: Queue<MessageDuplicateJob>,
    @Optional() private readonly ordering?: MessageDuplicateOrderingStore,
  ) {}

  async enqueue(
    input: Omit<MessageDuplicateJob, 'version' | 'createdAt' | 'idempotencyKey'>,
  ): Promise<void> {
    if (!this.queue || !this.ordering) throw new Error('Message duplicate queue unavailable');
    const id = `message-duplicate__${digestDuplicateContent([input.chatId, input.messageId, input.eventTimestampMs, 1])}`;
    const identity = { jobId: id, chatId: input.chatId, sourceCreatedAt: input.sourceCreatedAt };
    try {
      const registration = await this.ordering.announce(identity, input.actionEligible === true);
      if (registration.kind === 'completed') return;
      await this.queue.add(
        'message-duplicate-analysis',
        {
          ...input,
          version: 1,
          createdAt: new Date().toISOString(),
          idempotencyKey: id,
          actionEligible: registration.kind === 'registered' && registration.actionEligible,
        },
        {
          jobId: id,
          delay: 5000,
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { age: 86400, count: 25_000 },
          removeOnFail: { age: 86400, count: 5000 },
        },
      );
    } catch (error) {
      // FLAG: A timed-out add may have succeeded. A stricter replay can never upgrade that job.
      await this.ordering.announce(identity, false).catch(() => undefined);
      throw error;
    }
  }
}
