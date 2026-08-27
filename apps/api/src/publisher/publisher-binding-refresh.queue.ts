import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';

export const PUBLISHER_BINDING_REFRESH_QUEUE = 'publisher-binding-refresh';

export type PublisherBindingRefreshReason =
  | 'bot_added'
  | 'webhook_observed'
  | 'forwarded_private'
  | 'historical_actor_recovery'
  | 'bootstrap'
  | 'stale_access'
  | 'stale_user_access'
  | 'manual_recheck'
  | 'send_access_lost';

export type PublisherBindingRefreshJob = {
  version: 1;
  chatId: string;
  publisherBotId: string;
  candidateUserId?: string;
  candidateVersion?: string;
  replyChatId?: string;
  requiresReadAccess?: boolean;
  reason: PublisherBindingRefreshReason;
  requestedAt: string;
};

const PUBLISHER_REFRESH_JOB_BUCKET_MS = 60_000;
const PUBLISHER_MANUAL_RECHECK_DEDUPLICATION_MS = 5_000;

function resolveRefreshPriority(reason: PublisherBindingRefreshReason): number {
  switch (reason) {
    case 'manual_recheck':
      return 1;
    case 'bot_added':
    case 'webhook_observed':
    case 'forwarded_private':
    case 'historical_actor_recovery':
    case 'send_access_lost':
    case 'stale_user_access':
      return 5;
    case 'bootstrap':
    case 'stale_access':
      return 20;
  }
}

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
    candidateUserId?: string | null;
    candidateVersion?: string | null;
    replyChatId?: string | null;
    requiresReadAccess?: boolean;
    requestedAt?: Date;
    eventAt?: Date | null;
  }): Promise<void> {
    const chatId = params.chatId.trim();
    const publisherBotId = params.publisherBotId.trim();
    if (!chatId || !publisherBotId) {
      return;
    }

    const requestedAt = params.requestedAt ?? new Date();
    const candidateUserId = params.candidateUserId?.trim() || null;
    const candidateVersion = params.candidateVersion?.trim() || null;
    const replyChatId = params.replyChatId?.trim() || null;
    const manualRecheck = params.reason === 'manual_recheck';
    const discriminator = manualRecheck
      ? requestedAt.getTime()
      : params.eventAt
        ? params.eventAt.getTime()
        : Math.floor(requestedAt.getTime() / PUBLISHER_REFRESH_JOB_BUCKET_MS);
    const entityHash = createHash('sha256')
      .update(`${publisherBotId}\0${chatId}`)
      .digest('hex')
      .slice(0, 24);
    const candidateHash = candidateUserId
      ? createHash('sha256').update(candidateUserId).digest('hex').slice(0, 16)
      : null;
    const candidateVersionHash = candidateVersion
      ? createHash('sha256').update(candidateVersion).digest('hex').slice(0, 16)
      : null;
    const candidateScope = `${candidateHash ? `-${candidateHash}` : ''}${
      candidateVersionHash ? `-${candidateVersionHash}` : ''
    }`;
    const jobId = `publisher-binding-refresh-${entityHash}${candidateScope}-${params.reason}-${discriminator}`;

    await this.queue.add(
      'refresh',
      {
        version: 1,
        chatId,
        publisherBotId,
        ...(candidateUserId ? { candidateUserId } : {}),
        ...(candidateVersion ? { candidateVersion } : {}),
        ...(replyChatId ? { replyChatId } : {}),
        ...(params.requiresReadAccess ? { requiresReadAccess: true } : {}),
        reason: params.reason,
        requestedAt: requestedAt.toISOString(),
      },
      {
        jobId,
        priority: resolveRefreshPriority(params.reason),
        ...(manualRecheck
          ? {
              deduplication: {
                id: `publisher-binding-refresh-manual-${entityHash}${candidateScope}`,
                ttl: PUBLISHER_MANUAL_RECHECK_DEDUPLICATION_MS,
              },
            }
          : {}),
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
