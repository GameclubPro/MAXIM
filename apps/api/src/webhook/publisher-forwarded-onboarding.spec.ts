import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import type { Queue } from 'bullmq';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import type { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PublisherAutoReplyAuthoringService } from '../publisher/publisher-auto-reply-authoring.service';
import type { PublisherBindingRefreshQueueService } from '../publisher/publisher-binding-refresh.queue';
import { PublisherEntityBindingLifecycleService } from '../publisher/publisher-entity-binding-lifecycle.service';
import type { PublisherPostImportService } from '../publisher/publisher-post-import.service';
import { PublisherPrivateDialogFlowRouterService } from '../publisher/publisher-private-dialog-flow-router.service';
import {
  PublisherStartQueueService,
  type PublisherStartJob,
} from '../publisher/publisher-start.queue';
import type { PublisherSuggestionAdminCallbackObserverService } from '../publisher/publisher-suggestion-admin-callback-observer.service';
import {
  PublisherVkBotReviewQueueService,
  type VkBotReviewJob,
} from '../publisher/publisher-vk-bot-review.queue';
import { WebhookParser } from './webhook.parser';
import { WebhookService } from './webhook.service';

const publisherBotId = 'publisher-bot';
const sourceChatId = '-70001';

type ConnectionTransaction = {
  $queryRaw: Prisma.TransactionClient['$queryRaw'];
  chat: Pick<Prisma.TransactionClient['chat'], 'upsert'>;
  managedBotChatCatalog: Pick<
    Prisma.TransactionClient['managedBotChatCatalog'],
    'findUnique' | 'upsert'
  >;
  publisherEntityBinding: Pick<
    Prisma.TransactionClient['publisherEntityBinding'],
    'findUnique' | 'upsert'
  >;
  managedEntityAccessEdge: Pick<
    Prisma.TransactionClient['managedEntityAccessEdge'],
    'findUnique' | 'upsert'
  >;
};

function fixture(consumedBy?: 'authoring' | 'import') {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: sourceChatId }]),
    chat: { upsert: jest.fn().mockResolvedValue({ id: sourceChatId }) },
    managedBotChatCatalog: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
    publisherEntityBinding: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
    managedEntityAccessEdge: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
  } satisfies ConnectionTransaction;
  const prisma = {
    $transaction: jest.fn(async (callback: (client: ConnectionTransaction) => Promise<unknown>) =>
      callback(tx),
    ),
    publisherStartIntent: { upsert: jest.fn() },
  };
  const registry = {
    getPublisherBotDescriptor: jest.fn().mockReturnValue({ id: publisherBotId }),
    isKnownBotUserId: jest.fn().mockReturnValue(false),
  } satisfies Pick<MaxBotRegistryService, 'getPublisherBotDescriptor' | 'isKnownBotUserId'>;
  const config = new ConfigService({ MAX_PUBLISHER_BOT_ID: publisherBotId });
  const refresh = { enqueue: jest.fn().mockResolvedValue(undefined) } satisfies Pick<
    PublisherBindingRefreshQueueService,
    'enqueue'
  >;
  const lifecycle = new PublisherEntityBindingLifecycleService(
    prisma as unknown as PrismaService,
    refresh as unknown as PublisherBindingRefreshQueueService,
    config,
    registry as unknown as MaxBotRegistryService,
  );
  const greetingQueue = { add: jest.fn() };
  const start = new PublisherStartQueueService(
    greetingQueue as unknown as Queue<PublisherStartJob>,
    registry as unknown as MaxBotRegistryService,
    prisma as unknown as PrismaService,
  );
  const callbacks = { observeWebhook: jest.fn().mockResolvedValue(false) } satisfies Pick<
    PublisherSuggestionAdminCallbackObserverService,
    'observeWebhook'
  >;
  const authoring = {
    observeWebhook: jest.fn().mockResolvedValue(consumedBy === 'authoring'),
  } satisfies Pick<PublisherAutoReplyAuthoringService, 'observeWebhook'>;
  const postImport = {
    observeWebhook: jest.fn().mockResolvedValue(consumedBy === 'import'),
  } satisfies Pick<PublisherPostImportService, 'observeWebhook'>;
  const vkReviewQueue = { add: jest.fn() };
  const vkReview = new PublisherVkBotReviewQueueService(
    vkReviewQueue as unknown as Queue<VkBotReviewJob>,
    registry as unknown as MaxBotRegistryService,
  );
  const router = new PublisherPrivateDialogFlowRouterService(
    callbacks as unknown as PublisherSuggestionAdminCallbackObserverService,
    authoring as unknown as PublisherAutoReplyAuthoringService,
    postImport as unknown as PublisherPostImportService,
    start,
    vkReview,
  );
  const webhook = new WebhookService(
    prisma as unknown as PrismaService,
    config,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    lifecycle,
    undefined,
    router,
  );
  const observe = (update: MaxUpdate) =>
    Reflect.get(webhook, 'observePublisherWebhook').call(
      webhook,
      update,
      'stored-forward-receipt',
      false,
    ) as Promise<void>;
  return { observe, tx, prisma, refresh, greetingQueue, vkReviewQueue, authoring, postImport };
}

function forwarded(
  text: string | null,
  attachments: readonly unknown[] | null = null,
  outerContent = false,
): MaxUpdate {
  return new WebhookParser().parse(
    {
      update_type: 'message_created',
      timestamp: Date.now(),
      message: {
        sender: { user_id: 42 },
        recipient: { chat_id: 123, chat_type: 'dialog' },
        body: {
          mid: 'incoming-forward',
          text: outerContent ? text : null,
          attachments: outerContent ? attachments : null,
        },
        link: {
          type: 'forward',
          chat_id: Number(sourceChatId),
          message: {
            mid: 'source-message',
            text: outerContent ? null : text,
            attachments: outerContent ? null : attachments,
          },
        },
      },
    },
    { botId: publisherBotId },
  );
}

describe('Publisher forwarded onboarding through the private webhook route', () => {
  it.each([
    ['source /start', '/start', null, false],
    ['source Старт', 'Старт', null, false],
    ['source /vk', '/vk', null, false],
    ['source /start vk_review', '/start vk_review', null, false],
    ['photo', null, [{ type: 'image', payload: { photo_id: 'photo-1' } }], false],
    ['video', null, [{ type: 'video', payload: { token: 'video-1' } }], false],
    ['file', null, [{ type: 'file', payload: { token: 'file-1' } }], false],
    ['outer text', '/start', null, true],
    [
      'outer photo with command text',
      '/start',
      [{ type: 'image', payload: { photo_id: 'photo-1' } }],
      true,
    ],
    [
      'outer video with command text',
      '/vk',
      [{ type: 'video', payload: { token: 'video-1' } }],
      true,
    ],
    [
      'outer file with command text',
      '/start vk_review',
      [{ type: 'file', payload: { token: 'file-1' } }],
      true,
    ],
  ] as const)(
    'stages %s for exact Publisher verification without greeting or early activation',
    async (_label, text, attachments, outerContent) => {
      const f = fixture();
      const update = forwarded(text, attachments, outerContent);
      if (text) expect(update.message?.text).toBe(text);
      await f.observe(update);
      expect(f.prisma.publisherStartIntent.upsert).not.toHaveBeenCalled();
      expect(f.greetingQueue.add).not.toHaveBeenCalled();
      expect(f.vkReviewQueue.add).not.toHaveBeenCalled();
      expect(f.refresh.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: sourceChatId,
          publisherBotId,
          candidateUserId: '42',
          replyChatId: '123',
          reason: 'forwarded_private',
          candidateVersion: `forwarded:${update.updateId}`,
        }),
      );
      expect(f.tx.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            chatId: sourceChatId,
            userId: '42',
            botId: publisherBotId,
            state: 'BOT_DENIED',
            deniedReason: 'publisher_actor_verification_pending',
          }),
        }),
      );
      expect(f.tx.publisherEntityBinding.upsert).not.toHaveBeenCalled();
      expect(f.tx.managedBotChatCatalog.upsert).not.toHaveBeenCalled();
      expect(f.tx.chat.upsert.mock.calls[0]?.[0].create).not.toHaveProperty('botId');
      expect(f.tx.chat.upsert.mock.calls[0]?.[0].create).not.toHaveProperty('primaryBotId');
    },
  );

  it.each(['authoring', 'import'] as const)(
    'keeps an active %s flow ahead of forwarded connection',
    async (consumedBy) => {
      const f = fixture(consumedBy);
      await f.observe(forwarded('/start', [{ type: 'image' }], true));
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
      expect(f.refresh.enqueue).not.toHaveBeenCalled();
      expect(f.prisma.publisherStartIntent.upsert).not.toHaveBeenCalled();
      expect(f.greetingQueue.add).not.toHaveBeenCalled();
      expect(f.vkReviewQueue.add).not.toHaveBeenCalled();
      expect(f.authoring.observeWebhook).toHaveBeenCalledTimes(1);
      if (consumedBy === 'authoring') expect(f.postImport.observeWebhook).not.toHaveBeenCalled();
      else expect(f.postImport.observeWebhook).toHaveBeenCalledTimes(1);
    },
  );
});
