import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { readWebhookEventTimestamp } from '../webhook/webhook-semantic-event-key';

export const PUBLISHER_START_QUEUE = 'publisher-start';
export const PUBLISHER_START_MAX_AGE_MS = 24 * 60 * 60_000;

export function isFreshPublisherStart(requestedAt: string): boolean {
  const age = Date.now() - Date.parse(requestedAt);
  return Number.isFinite(age) && age >= -60_000 && age <= PUBLISHER_START_MAX_AGE_MS;
}

export type PublisherStartJob = {
  version: 1;
  publisherBotId: string;
  privateChatId: string;
  requestedAt: string;
  dispatchStarted?: boolean;
};

@Injectable()
export class PublisherStartQueueService {
  private readonly publisherBotId: string;

  constructor(
    @InjectQueue(PUBLISHER_START_QUEUE) private readonly queue: Queue<PublisherStartJob>,
    botRegistry: MaxBotRegistryService,
  ) {
    this.publisherBotId = botRegistry.getPublisherBotDescriptor().id;
  }

  async observeWebhook(update: MaxUpdate): Promise<boolean> {
    if (update.botId?.trim() !== this.publisherBotId) return false;
    const type = update.type.trim().toLowerCase();
    const privateChatId = update.message?.chatId?.trim() ?? '';
    if (!isPrivateDirectChatId(privateChatId) || update.message?.entityType === 'channel') {
      return false;
    }
    if (type === 'bot_started') {
      const raw = asRecord(update.raw);
      const data = asRecord(raw?.data);
      const event = asRecord(raw?.event);
      const nodes = [
        raw,
        data,
        event,
        asRecord(raw?.bot_started),
        asRecord(data?.bot_started),
        asRecord(event?.bot_started),
      ];
      if (
        nodes.some((node) =>
          [node?.payload, node?.start_payload, node?.startPayload].some(
            (value) => value !== undefined && value !== null && value !== '',
          ),
        )
      )
        return false;
    } else if (
      type !== 'message_created' ||
      !['/start', 'старт'].includes(update.message?.text?.trim().toLowerCase() ?? '')
    ) {
      return false;
    }

    const requestedAt = readWebhookEventTimestamp(update);
    if (!requestedAt || !isFreshPublisherStart(requestedAt.toISOString())) {
      return true;
    }
    const identity = createHash('sha256')
      .update(`${this.publisherBotId}\0${privateChatId}\0${update.updateId}`)
      .digest('hex');
    await this.queue.add(
      'greet',
      {
        version: 1,
        publisherBotId: this.publisherBotId,
        privateChatId,
        requestedAt: requestedAt.toISOString(),
      },
      {
        jobId: `publisher-start-${identity}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        // FLAG: Retain the dispatch fence longer than the accepted event age, including failures.
        removeOnComplete: { age: 2 * 24 * 60 * 60 },
        removeOnFail: { age: 2 * 24 * 60 * 60 },
      },
    );
    return true;
  }

  async claimDispatch(jobId: string): Promise<boolean> {
    const client = await this.queue.client;
    client.defineCommand('claimPublisherStartDispatch', {
      numberOfKeys: 1,
      lua: "return redis.call('SET', KEYS[1], '1', 'PX', ARGV[1], 'NX')",
    });
    return (
      (await client.runCommand('claimPublisherStartDispatch', [
        this.queue.toKey(`dispatch-${jobId}`),
        2 * PUBLISHER_START_MAX_AGE_MS,
      ])) === 'OK'
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
