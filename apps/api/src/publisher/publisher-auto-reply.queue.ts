import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import { PublisherRuntimeHeartbeatReaderService } from './publisher-runtime-heartbeat.service';

export const PUBLISHER_AUTO_REPLY_QUEUE = 'publisher-auto-replies';
const HEARTBEAT_RECHECK_DELAY_MS = 150;

export class PublisherAutoReplyAdmissionError extends Error {
  readonly reason = 'dispatch_disabled';

  constructor() {
    super('Publisher auto-reply admission failed: dispatch_disabled');
    this.name = 'PublisherAutoReplyAdmissionError';
  }
}

export type PublisherAutoReplyJob = {
  version: 1;
  kind: 'deliver';
  retryPolicyName: 'publisher-auto-reply';
  deliveryId: string;
};

export function buildPublisherAutoReplyJobId(deliveryId: string): string {
  const digest = createHash('sha256').update(deliveryId.trim()).digest('hex').slice(0, 32);
  return `publisher-auto-reply-${digest}`;
}

@Injectable()
export class PublisherAutoReplyQueueService {
  private readonly publisherBotId: string;

  constructor(
    @InjectQueue(PUBLISHER_AUTO_REPLY_QUEUE)
    private readonly queue: Queue<PublisherAutoReplyJob>,
    configService: ConfigService,
    private readonly runtimeHeartbeat: PublisherRuntimeHeartbeatReaderService,
  ) {
    this.publisherBotId = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
  }

  async assertAdmissionEnabled(): Promise<void> {
    let heartbeat = await this.runtimeHeartbeat.read(this.publisherBotId);
    if (!heartbeat) {
      await new Promise<void>((resolve) => setTimeout(resolve, HEARTBEAT_RECHECK_DELAY_MS));
      heartbeat = await this.runtimeHeartbeat.read(this.publisherBotId);
    }
    if (heartbeat && !heartbeat.dispatchEnabled && heartbeat.blocker === 'runtime_disabled') {
      throw new PublisherAutoReplyAdmissionError();
    }
  }

  async ensureDeliveryJob(deliveryId: string, availableAt?: Date | null): Promise<void> {
    const normalizedDeliveryId = deliveryId.trim();
    if (!normalizedDeliveryId) {
      throw new Error('Publisher auto-reply deliveryId is required');
    }
    await this.assertAdmissionEnabled();
    const jobId = buildPublisherAutoReplyJobId(normalizedDeliveryId);
    const existing = await this.queue.getJob(jobId);
    if (existing && (await this.isLiveJob(existing))) {
      return;
    }
    if (existing) {
      await this.removeReplaceableJob(existing);
    }

    const delay = availableAt
      ? Math.max(0, Math.min(availableAt.getTime() - Date.now(), 15 * 60_000))
      : 0;
    await this.queue.add(
      'deliver',
      {
        version: 1,
        kind: 'deliver',
        retryPolicyName: 'publisher-auto-reply',
        deliveryId: normalizedDeliveryId,
      },
      {
        jobId,
        priority: 3,
        ...(delay > 0 ? { delay } : {}),
        attempts: 7,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 60 * 60, count: 10_000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 10_000 },
      },
    );
  }

  private async isLiveJob(job: Job<PublisherAutoReplyJob>): Promise<boolean> {
    const state = await job.getState();
    return (
      state === 'active' || state === 'waiting' || state === 'delayed' || state === 'prioritized'
    );
  }

  private async removeReplaceableJob(job: Job<PublisherAutoReplyJob>): Promise<void> {
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') {
      await job.remove();
    }
  }
}
