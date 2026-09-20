import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import {
  MessageRetentionRuntime,
  type MessageRetentionJob,
} from './message-retention-runtime.service';
import { MESSAGE_RETENTION_QUEUE } from './message-retention.policy';

@Processor(MESSAGE_RETENTION_QUEUE, { concurrency: 1, lockDuration: 120_000 })
export class MessageRetentionProcessor extends WorkerHost {
  constructor(private readonly runtime: MessageRetentionRuntime) {
    super();
  }
  async process(job: Job<MessageRetentionJob>): Promise<void> {
    await this.runtime.process(job.data.chatId);
  }
}
