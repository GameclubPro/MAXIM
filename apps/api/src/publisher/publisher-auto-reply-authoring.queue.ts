import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';

export const PUBLISHER_AUTO_REPLY_AUTHORING_QUEUE = 'publisher-auto-reply-authoring';
export const PUBLISHER_AUTO_REPLY_AUTHORING_JOB_BUCKET_MS = 30_000;

export type PublisherAutoReplyAuthoringNotification =
  | 'prompt_phrase'
  | 'prompt_content'
  | 'processing'
  | 'ready'
  | 'conflict'
  | 'activated'
  | 'failed'
  | 'canceled';

export type PublisherAutoReplyAuthoringJob =
  | {
      version: 1;
      kind: 'process_content';
      sessionId: string;
      requestedAt: string;
    }
  | {
      version: 1;
      kind: 'activate';
      sessionId: string;
      callbackId?: string;
      requestedAt: string;
    }
  | {
      version: 1;
      kind: 'notify';
      sessionId: string;
      notification: PublisherAutoReplyAuthoringNotification;
      callbackId?: string;
      requestedAt: string;
    };

function buildJobId(parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
  return `publisher-auto-reply-authoring-${digest}`;
}

@Injectable()
export class PublisherAutoReplyAuthoringQueueService {
  constructor(
    @InjectQueue(PUBLISHER_AUTO_REPLY_AUTHORING_QUEUE)
    private readonly queue: Queue<PublisherAutoReplyAuthoringJob>,
  ) {}

  async enqueueProcessContent(sessionId: string, requestedAt = new Date()): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return;
    await this.queue.add(
      'process-content',
      {
        version: 1,
        kind: 'process_content',
        sessionId: normalizedSessionId,
        requestedAt: requestedAt.toISOString(),
      },
      {
        jobId: buildJobId([
          'process',
          normalizedSessionId,
          String(Math.floor(requestedAt.getTime() / PUBLISHER_AUTO_REPLY_AUTHORING_JOB_BUCKET_MS)),
        ]),
        priority: 2,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: true,
        removeOnFail: { age: 24 * 60 * 60, count: 5_000 },
      },
    );
  }

  async enqueueActivation(params: {
    sessionId: string;
    callbackId?: string | null;
    requestedAt?: Date;
  }): Promise<void> {
    const sessionId = params.sessionId.trim();
    if (!sessionId) return;
    const requestedAt = params.requestedAt ?? new Date();
    await this.queue.add(
      'activate',
      {
        version: 1,
        kind: 'activate',
        sessionId,
        ...(params.callbackId?.trim() ? { callbackId: params.callbackId.trim() } : {}),
        requestedAt: requestedAt.toISOString(),
      },
      {
        jobId: buildJobId([
          'activate',
          sessionId,
          String(Math.floor(requestedAt.getTime() / PUBLISHER_AUTO_REPLY_AUTHORING_JOB_BUCKET_MS)),
        ]),
        priority: 1,
        attempts: 4,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: true,
        removeOnFail: { age: 24 * 60 * 60, count: 5_000 },
      },
    );
  }

  async enqueueNotification(params: {
    sessionId: string;
    notification: PublisherAutoReplyAuthoringNotification;
    callbackId?: string | null;
    dedupeKey: string;
    requestedAt?: Date;
  }): Promise<void> {
    const sessionId = params.sessionId.trim();
    const dedupeKey = params.dedupeKey.trim();
    if (!sessionId || !dedupeKey) return;
    const requestedAt = params.requestedAt ?? new Date();
    await this.queue.add(
      'notify',
      {
        version: 1,
        kind: 'notify',
        sessionId,
        notification: params.notification,
        ...(params.callbackId?.trim() ? { callbackId: params.callbackId.trim() } : {}),
        requestedAt: requestedAt.toISOString(),
      },
      {
        jobId: buildJobId(['notify', sessionId, params.notification, dedupeKey]),
        priority: 1,
        attempts: 4,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 60 * 60, count: 5_000 },
        removeOnFail: { age: 24 * 60 * 60, count: 5_000 },
      },
    );
  }
}
