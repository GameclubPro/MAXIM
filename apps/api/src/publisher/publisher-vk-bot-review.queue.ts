import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { readWebhookEventTimestamp } from '../webhook/webhook-semantic-event-key';
import { PUBLISHER_SUGGESTION_ADMIN_QUEUE } from './publisher-suggestion-admin.queue';
import {
  parseVkBotReviewCallback,
  VK_BOT_REVIEW_CALLBACK_PREFIX,
  VK_BOT_REVIEW_START,
  type VkBotReviewAction,
} from '../admin/vk-bot-review-protocol';

export type VkBotReviewJob = {
  version: 1;
  kind: 'vk-bot-review';
  requiredBotId: string;
  action: VkBotReviewAction | 'connect' | 'tick';
  userId?: string;
  privateChatId?: string;
  messageId?: string;
  callbackId?: string;
  id?: string;
  revision?: number;
  requestedAt: string;
  menuDispatchStarted?: boolean;
};

@Injectable()
export class PublisherVkBotReviewQueueService {
  private readonly botId: string;

  constructor(
    @InjectQueue(PUBLISHER_SUGGESTION_ADMIN_QUEUE) private readonly queue: Queue<VkBotReviewJob>,
    registry: MaxBotRegistryService,
  ) {
    this.botId = registry.getPublisherBotDescriptor().id;
  }

  async enqueueTick(delay = 0): Promise<void> {
    const due = Date.now() + delay;
    await this.queue.add(
      'vk-bot-review',
      {
        version: 1,
        kind: 'vk-bot-review',
        requiredBotId: this.botId,
        action: 'tick',
        requestedAt: new Date().toISOString(),
      },
      {
        jobId: `vkr-tick-${this.botId}-${Math.floor(due / 5000)}`,
        delay,
        priority: 3,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: { count: 100 },
      },
    );
  }

  async observeWebhook(update: MaxUpdate): Promise<boolean> {
    if (update.botId !== this.botId) return false;
    const raw = record(update.raw);
    const callback =
      record(raw?.callback) ??
      record(record(raw?.data)?.callback) ??
      record(record(raw?.event)?.callback);
    const value = typeof callback?.payload === 'string' ? callback.payload : '';
    const text = update.message?.text?.trim().toLowerCase();
    const start = [raw, record(raw?.data), record(raw?.event), record(raw?.bot_started)].some(
      (node) =>
        (node?.payload ?? node?.start_payload ?? node?.startPayload) === VK_BOT_REVIEW_START,
    );
    const isConnect =
      (update.type === 'message_created' && (text === '/vk' || text === '/start vk_review')) ||
      (update.type === 'bot_started' && start);
    const isCallback =
      update.type === 'message_callback' && value.startsWith(VK_BOT_REVIEW_CALLBACK_PREFIX);
    if (!isConnect && !isCallback) return false;
    const parsed = isCallback ? parseVkBotReviewCallback(value) : null;
    const callbackUser = record(callback?.user);
    const userId = String(
      isCallback
        ? (callbackUser?.user_id ?? callbackUser?.userId ?? callbackUser?.id ?? '')
        : (update.message?.senderId ?? ''),
    );
    const privateChatId = update.message?.chatId ?? '';
    const requestedAt = readWebhookEventTimestamp(update);
    // FLAG: Only authenticated, fresh, exact-Publisher private updates can bind an inbox.
    if (
      !/^[1-9][0-9]{0,30}$/u.test(userId) ||
      !/^[1-9][0-9]{0,30}$/u.test(privateChatId) ||
      update.message?.entityType === 'channel' ||
      !requestedAt ||
      Date.now() - requestedAt.getTime() > 24 * 60 * 60_000 ||
      requestedAt.getTime() > Date.now() + 60_000 ||
      (isCallback &&
        (!parsed || !update.message?.messageId || typeof callback?.callback_id !== 'string'))
    )
      return true;
    const identity = createHash('sha256').update(`${this.botId}\0${update.updateId}`).digest('hex');
    await this.queue.add(
      'vk-bot-review',
      {
        version: 1,
        kind: 'vk-bot-review',
        requiredBotId: this.botId,
        action: parsed?.action ?? 'connect',
        id: parsed?.id,
        revision: parsed?.revision,
        userId,
        privateChatId,
        messageId: update.message?.messageId,
        callbackId: isCallback ? String(callback?.callback_id) : undefined,
        requestedAt: requestedAt.toISOString(),
      },
      {
        jobId: `vkr-action-${identity}`,
        priority: 1,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 2 * 24 * 60 * 60 },
        removeOnFail: { age: 2 * 24 * 60 * 60 },
      },
    );
    return true;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
