import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import type { MaxSendMessageOptions } from '../max/max-client.service';
import { WebhookParser } from '../webhook/webhook.parser';
import {
  PublisherVkBotReviewQueueService,
  type VkBotReviewJob,
} from '../publisher/publisher-vk-bot-review.queue';
import { VkBotReviewService } from './vk-bot-review.service';
import { buildVkBotReviewFingerprint } from './vk-bot-review-protocol';

function fixture() {
  const scope = { ownerProfile: 'PUBLISHER', ownerBotId: 'publik_bot' };
  const settings = {
    id: 'settings-1',
    ...scope,
    chatId: '-1',
    botReviewRecipientUserId: '17',
    botReviewPaused: false,
    stripLinksEnabled: false,
    skipAdsEnabled: false,
    appendChannelLinkEnabled: false,
    channelLinkText: 'Channel',
    schedulerTimezone: 'UTC',
    workHoursStart: '00:00',
    workHoursEnd: '23:59',
    quietHoursStart: null,
    quietHoursEnd: null,
  };
  const post = {
    id: 'post-1',
    ...scope,
    chatId: '-1',
    sourceId: 'source-1',
    status: 'NEW',
    text: 'Post',
    textFormat: 'plain',
    photoUrls: [],
    videoUrls: [],
    linkUrls: [],
    contentHash: 'hash',
    isAdvertising: false,
    manualContentEditedAt: null,
    publishIdempotencyKey: null,
    publishLockedAt: null,
    publishAttemptCount: 0,
    publishedMessageId: null,
    publishedUrl: null,
    lastError: null,
    hasUnsupportedAttachments: false,
    url: 'https://vk.com/wall-1_1',
    vkPublishedAt: new Date(),
    source: {
      id: 'source-1',
      publishMode: 'BOT_REVIEW',
      status: 'ACTIVE',
      importEnabled: true,
      quietHoursStart: null,
      quietHoursEnd: null,
      title: 'Source',
    },
    chat: { title: 'Channel' },
  };
  const fingerprint = buildVkBotReviewFingerprint(post, settings);
  const snapshot = {
    version: 1,
    fingerprint,
    payload: { text: 'Post', textFormat: 'plain', photoUrls: [], videoUrls: [], linkUrls: [] },
    maxMessage: { text: 'Post', engagementText: 'Post' },
  };
  const row = {
    id: 'review-1',
    postId: post.id,
    recipientUserId: '17',
    status: 'PENDING',
    deliveryState: 'DELIVERED',
    revision: 1,
    privateChatId: '42',
    contentMessageId: 'content-1',
    controlMessageId: 'control-1',
    fingerprint,
    snapshot,
    presentationKey: null,
    lastError: null,
    nextAttemptAt: new Date(),
    post,
  };
  const prisma = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ id: '-1' }]),
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    vkBotReview: {
      findFirst: jest.fn().mockResolvedValue(row),
      findUnique: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockImplementation(async ({ select }) => (select ? [] : [row])),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn().mockResolvedValue(row),
    },
    vkParsingPost: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(post),
      findFirst: jest.fn().mockResolvedValue({ ...post, botReview: null }),
    },
    vkParsingSettings: {
      findMany: jest.fn().mockResolvedValue([{ ...settings, chat: { title: 'Channel' } }]),
      findUnique: jest.fn().mockResolvedValue(settings),
      upsert: jest.fn().mockResolvedValue(settings),
    },
    vkBotReviewInbox: { findUnique: jest.fn().mockResolvedValue({ privateChatId: '42' }) },
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const access = { assertAccess: jest.fn().mockResolvedValue('CHANNEL') };
  const publish = {
    publishBotReviewedPost: jest.fn().mockResolvedValue(undefined),
    prepareBotReviewSnapshot: jest.fn().mockResolvedValue(snapshot),
    prepareBotReviewMedia: jest.fn().mockResolvedValue({}),
  };
  const max = {
    getChatMembersAccess: jest.fn().mockResolvedValue(new Map([['17', { isAdmin: true }]])),
    sendMessageImmediateWithId: jest
      .fn()
      .mockImplementation(
        async (_chat: string, _text: string, options: { beforeSend?: () => Promise<void> }) => {
          await options.beforeSend?.();
          return { messageId: 'sent-1' };
        },
      ),
    editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    answerCallback: jest.fn().mockResolvedValue(undefined),
  };
  const config = { get: jest.fn().mockReturnValue(true) };
  const queue = { enqueueTick: jest.fn().mockResolvedValue(undefined) };
  const governor = { decide: jest.fn().mockResolvedValue({ action: 'run' }) };
  const registry = new MaxBotRegistryService(
    new ConfigService({
      APP_ROLE: 'admin',
      APP_BASE_URL: 'https://major-maksimov.ru',
      MAX_BOT_ID: 'major_bot',
      MAX_ENTRY_BOT_ID: 'major_bot',
      MAX_BOT_TOKEN: 'test-major-token',
      MAX_WEBHOOK_SECRET_PATH: 'test-path',
      MAX_WEBHOOK_HEADER_SECRET: 'test-header',
      MAX_PUBLISHER_BOT_ID: scope.ownerBotId,
    }),
  );
  const links = new MaxBotLinkService(
    {} as never,
    registry,
    { getActiveBotId: () => 'major_bot' } as never,
    {} as never,
  );
  const service = new VkBotReviewService(
    prisma as never,
    access as never,
    { getPublisherScope: () => scope } as never,
    publish as never,
    max as never,
    links,
    queue as never,
    config as never,
    governor as never,
  );
  const internals = service as unknown as {
    drain(): Promise<void>;
    releaseLegacyCalendarDeferrals(now: Date): Promise<void>;
    advance(row: unknown): Promise<void>;
    decide(data: unknown): Promise<void>;
  };
  const callback = {
    kind: 'vk-bot-review',
    requiredBotId: 'publik_bot',
    action: 'publish',
    userId: '17',
    privateChatId: '42',
    messageId: 'control-1',
    callbackId: 'cb',
    id: 'review-1',
    revision: 1,
  };
  return {
    registry,
    service,
    internals,
    prisma,
    access,
    publish,
    max,
    queue,
    config,
    governor,
    row,
    settings,
    callback,
  };
}

describe('VkBotReviewService', () => {
  it('returns the Publisher private start from token-isolated api-admin, never the Major fallback', async () => {
    const { service, registry } = fixture();
    expect(registry.getBotById('publik_bot')).toBeNull();
    expect(registry.getValidationTokensForBot('publik_bot')).toEqual([]);
    const state = await service.getState('-1', { userId: '17', username: null, displayName: null });
    expect(state.botUrl).toBe('https://max.ru/publik_bot?start=vk_review');
  });
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-15T12:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('connects the API-issued link through MAX start and delivers the post and decision buttons to the Publisher DM', async () => {
    const { service, registry, internals, prisma, max, row, publish } = fixture();
    const user = { userId: '17', username: null, displayName: null, launchBotId: 'publik_bot' };
    const url = new URL((await service.getState('-1', user)).botUrl);
    const parser = new WebhookParser();
    const outbound = { add: jest.fn().mockResolvedValue(undefined) };
    const producer = new PublisherVkBotReviewQueueService(outbound as never, registry);
    const started = parser.parse(
      {
        update_id: 'vk-start',
        update_type: 'bot_started',
        timestamp: Date.now(),
        chat_id: 42,
        user: { user_id: 17 },
        payload: url.searchParams.get('start'),
      },
      { botId: url.pathname.slice(1) },
    );
    expect(await producer.observeWebhook(started)).toBe(true);
    const startJob = outbound.add.mock.calls[0]![1] as VkBotReviewJob;
    expect(startJob).toMatchObject({
      action: 'connect',
      requiredBotId: 'publik_bot',
      userId: '17',
      privateChatId: '42',
    });

    const environment = jest.replaceProperty(process, 'env', {
      ...process.env,
      APP_ROLE: 'publisher',
      APP_SERVICE_NAME: 'api-publisher',
    });
    try {
      await service.process({
        data: startJob,
        updateData: jest.fn().mockResolvedValue(undefined),
      } as never);
      expect(prisma.$executeRaw).toHaveBeenCalled();
      await service.configure('-1', user, { action: 'CONNECT' });

      const review = {
        ...row,
        deliveryState: 'QUEUED',
        contentMessageId: null,
        controlMessageId: null,
      };
      prisma.vkBotReview.findFirst.mockResolvedValue(review);
      prisma.vkBotReview.findUnique.mockResolvedValue(review);
      prisma.vkBotReview.updateMany.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(review, data);
          return { count: 1 };
        },
      );
      let sequence = 0;
      max.sendMessageImmediateWithId.mockImplementation(async (_chat, _text, options) => {
        await options.beforeSend?.();
        return { messageId: `vk-dm-${++sequence}` };
      });
      await internals.advance(review);
      expect(review.deliveryState).toBe('CONTENT_SENT');
      await internals.advance(review);
      expect(review.deliveryState).toBe('DELIVERED');
      expect(max.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
        2,
        '42',
        'Post',
        expect.any(Object),
        expect.objectContaining({ botId: 'publik_bot' }),
      );
      const controls = max.sendMessageImmediateWithId.mock.calls[2]![2] as MaxSendMessageOptions;
      expect(controls.messageLink).toEqual({ type: 'reply', mid: 'vk-dm-1' });
      expect(controls.buttons?.flat()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'callback', text: 'Опубликовать' }),
          expect.objectContaining({ type: 'callback', text: 'Отклонить' }),
        ]),
      );
      for (const button of controls.buttons?.flat() ?? []) {
        if (button.type === 'link' && button.text !== 'Оригинал VK')
          expect(new URL(button.url).pathname).toBe('/publik_bot');
      }
      const publishButton = controls.buttons
        ?.flat()
        .find((button) => button.type === 'callback' && button.text === 'Опубликовать');
      if (publishButton?.type !== 'callback') throw new Error('Missing approval button');
      const callback = parser.parse(
        {
          update_id: 'vk-approve',
          update_type: 'message_callback',
          timestamp: Date.now(),
          callback: {
            timestamp: Date.now(),
            callback_id: 'vk-callback',
            payload: publishButton.payload,
            user: { user_id: 17 },
          },
          message: {
            recipient: { chat_id: 42, chat_type: 'dialog' },
            sender: { user_id: 777 },
            body: { mid: 'vk-dm-2', text: 'Review' },
          },
        },
        { botId: 'publik_bot' },
      );
      expect(await producer.observeWebhook(callback)).toBe(true);
      const decision = outbound.add.mock.calls[1]![1] as VkBotReviewJob;
      await service.process({ data: decision } as never);
      await service.process({ data: decision } as never);
      expect(publish.publishBotReviewedPost).toHaveBeenCalledTimes(1);
      expect(publish.publishBotReviewedPost).toHaveBeenCalledWith('review-1');
      expect(review.status).toBe('APPROVED');
    } finally {
      environment.restore();
    }
  });

  it('finishes an existing preview/control pair ahead of new previews', async () => {
    const { internals, row, prisma } = fixture();
    const control = { ...row, deliveryState: 'CONTENT_SENT' };
    const fresh = { ...row, id: 'review-2', deliveryState: 'QUEUED', nextAttemptAt: new Date(0) };
    prisma.vkBotReview.findMany.mockImplementation(
      async ({ where, select }: { where: { deliveryState: string }; select?: unknown }) =>
        select
          ? []
          : where.deliveryState === 'CONTENT_SENT'
            ? [control]
            : where.deliveryState === 'QUEUED'
              ? [fresh]
              : [],
    );
    const advance = jest.spyOn(internals, 'advance').mockResolvedValue(undefined);
    await internals.drain();
    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledWith(control);
    expect(prisma.vkBotReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deliveryState: 'CONTENT_SENT' }),
        take: 10,
      }),
    );
  });

  it('does not let a saturated channel block another channel for the same recipient', async () => {
    const { internals, row, prisma } = fixture();
    const blocked = { ...row, deliveryState: 'QUEUED' };
    const next = {
      ...row,
      id: 'review-2',
      deliveryState: 'QUEUED',
      post: { ...row.post, chatId: '-2' },
    };
    prisma.vkBotReview.findMany.mockImplementation(
      async ({ where, select }: { where: { deliveryState: string }; select?: unknown }) =>
        !select && where.deliveryState === 'QUEUED' ? [blocked, next] : [],
    );
    prisma.vkBotReview.count.mockResolvedValueOnce(5).mockResolvedValueOnce(5).mockResolvedValue(0);
    const advance = jest.spyOn(internals, 'advance').mockResolvedValue(undefined);
    await internals.drain();
    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledWith(next);
  });

  it('delivers the next review without a decision on the first after an idle tick', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-18T10:00:00Z'));
    try {
      const { internals, row, prisma, queue, max } = fixture();
      const delivered = { ...row, nextAttemptAt: new Date(Date.now() - 1_000) };
      const queued = {
        ...row,
        id: 'review-2',
        postId: 'post-2',
        post: { ...row.post, id: 'post-2' },
        deliveryState: 'QUEUED',
        contentMessageId: null as string | null,
        controlMessageId: null as string | null,
        nextAttemptAt: new Date(),
      };
      const stored = [delivered, queued];
      prisma.vkBotReview.findMany.mockImplementation(async ({ where, select }) =>
        select
          ? []
          : stored.filter(
              (item) =>
                item.deliveryState === where.deliveryState &&
                item.nextAttemptAt <= where.nextAttemptAt.lte,
            ),
      );
      prisma.vkBotReview.findFirst.mockImplementation(
        async ({ where }) =>
          stored
            .filter(
              (item) =>
                item.deliveryState === where.deliveryState &&
                item.nextAttemptAt < where.nextAttemptAt.lt,
            )
            .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())[0] ?? null,
      );
      prisma.vkBotReview.updateMany.mockImplementation(async ({ where, data }) => {
        const item = stored.find((item) => item.id === where.id);
        if (
          !item ||
          (where.deliveryState &&
            typeof where.deliveryState === 'string' &&
            item.deliveryState !== where.deliveryState)
        )
          return { count: 0 };
        Object.assign(item, data);
        return { count: 1 };
      });
      prisma.vkBotReview.count.mockResolvedValue(1);

      await internals.drain();
      expect(queued.nextAttemptAt.toISOString()).toBe('2026-09-18T10:00:30.000Z');
      expect(max.sendMessageImmediateWithId).not.toHaveBeenCalled();

      jest.setSystemTime(new Date('2026-09-18T10:00:05Z'));
      queue.enqueueTick.mockClear();
      await internals.drain();
      expect(queue.enqueueTick).toHaveBeenCalledWith(25_000);

      jest.setSystemTime(new Date('2026-09-18T10:00:30Z'));
      await internals.drain();
      expect(queued.deliveryState).toBe('CONTENT_SENT');
      jest.setSystemTime(new Date('2026-09-18T10:00:35Z'));
      await internals.drain();
      expect(queued.deliveryState).toBe('DELIVERED');
      expect(delivered.status).toBe('PENDING');
      expect(max.sendMessageImmediateWithId).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    'QUEUED',
    'ERROR',
    'CONTENT_SENT',
    'CONTENT_SENDING',
    'CONTROL_SENDING',
    'PREPARING',
    'DELIVERED',
  ])(
    'keeps a timed wake-up for deferred %s work without reading message payloads',
    async (state) => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-09-18T00:00:00Z'));
      try {
        const { internals, prisma, queue } = fixture();
        prisma.vkBotReview.findMany.mockResolvedValue([]);
        prisma.vkBotReview.findFirst.mockImplementation(async ({ where }) =>
          where.deliveryState === state
            ? { nextAttemptAt: new Date('2026-09-18T09:00:00Z') }
            : null,
        );
        await internals.drain();
        expect(queue.enqueueTick).toHaveBeenCalledWith(9 * 60 * 60_000);
        expect(prisma.vkBotReview.findFirst).toHaveBeenCalledTimes(7);
        for (const [query] of prisma.vkBotReview.findFirst.mock.calls) {
          expect(query).toMatchObject({
            where: {
              post: { ownerProfile: 'PUBLISHER', ownerBotId: 'publik_bot' },
              nextAttemptAt: { lt: new Date('9999-01-01T00:00:00Z') },
            },
            select: { nextAttemptAt: true },
            orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
          });
          expect(query.where.deliveryState).not.toBe('AMBIGUOUS');
        }
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('admits an equally due review before recurring updates of multiple open cards', async () => {
    const { internals, row, prisma } = fixture();
    const fresh = { ...row, id: 'review-new', deliveryState: 'QUEUED' };
    const openCards = Array.from({ length: 4 }, (_, index) => ({ ...row, id: `open-${index}` }));
    prisma.vkBotReview.findMany.mockImplementation(async ({ where, select }) =>
      select
        ? []
        : where.deliveryState === 'DELIVERED'
          ? openCards
          : where.deliveryState === 'QUEUED'
            ? [fresh]
            : [],
    );
    prisma.vkBotReview.count.mockResolvedValue(4);
    const advance = jest.spyOn(internals, 'advance').mockResolvedValue(undefined);
    await internals.drain();
    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledWith(fresh);
  });

  it('does not starve overdue approval recovery behind newer incoming reviews', async () => {
    const { internals, row, prisma } = fixture();
    const approval = { ...row, status: 'APPROVED', nextAttemptAt: new Date(0) };
    const fresh = { ...row, id: 'review-new', deliveryState: 'QUEUED' };
    prisma.vkBotReview.findMany.mockImplementation(async ({ where, select }) =>
      select
        ? []
        : where.deliveryState === 'DELIVERED'
          ? [approval]
          : where.deliveryState === 'QUEUED'
            ? [fresh]
            : [],
    );
    const advance = jest.spyOn(internals, 'advance').mockResolvedValue(undefined);
    await internals.drain();
    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledWith(approval);
  });

  it('stops ticking when no schedulable review remains', async () => {
    const { internals, prisma, queue } = fixture();
    prisma.vkBotReview.findMany.mockResolvedValue([]);
    prisma.vkBotReview.findFirst.mockResolvedValue(null);
    await internals.drain();
    expect(queue.enqueueTick).not.toHaveBeenCalled();
  });

  it('returns an unattempted stale approval to review without dispatching', async () => {
    const { internals, row, settings, publish, prisma } = fixture();
    settings.stripLinksEnabled = true;
    await internals.advance({ ...row, status: 'APPROVED' });
    expect(publish.publishBotReviewedPost).not.toHaveBeenCalled();
    expect(prisma.vkBotReview.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING', decidedAt: null }),
      }),
    );
  });

  it('does not reset an approval after any remote publication attempt', async () => {
    const { internals, row, settings, prisma } = fixture();
    settings.stripLinksEnabled = true;
    await internals.advance({
      ...row,
      status: 'APPROVED',
      post: {
        ...row.post,
        status: 'FAILED',
        publishAttemptCount: 1,
        lastError: 'needs inspection',
      },
    });
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkBotReview.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }),
    );
  });

  it.each(['CONTENT_SENDING', 'CONTROL_SENDING'])(
    'quarantines stalled %s without replaying the send',
    async (deliveryState) => {
      const { internals, prisma, max, row } = fixture();
      await internals.advance({ ...row, deliveryState });
      expect(max.sendMessageImmediateWithId).not.toHaveBeenCalled();
      expect(prisma.vkBotReview.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ deliveryState: 'AMBIGUOUS' }) }),
      );
    },
  );
  it('resumes crashed preparation without treating it as an attempted send', async () => {
    const { internals, prisma, max, row } = fixture();
    await internals.advance({ ...row, deliveryState: 'PREPARING' });
    expect(prisma.vkBotReview.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deliveryState: 'QUEUED' }) }),
    );
    expect(max.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });
  it.each(['pause', 'governor', 'user-limit', 'channel-limit'])(
    'defers delivery on %s without losing the pending item',
    async (reason) => {
      const { internals, row, settings, governor, prisma, publish } = fixture();
      if (reason === 'pause') settings.botReviewPaused = true;
      if (reason === 'governor')
        governor.decide.mockResolvedValue({ action: 'pause', retryAfterMs: 60_000 });
      if (reason === 'user-limit') prisma.vkBotReview.count.mockResolvedValue(10);
      if (reason === 'channel-limit')
        prisma.vkBotReview.count.mockResolvedValueOnce(0).mockResolvedValueOnce(5);
      await internals.advance({
        ...row,
        deliveryState: 'QUEUED',
        contentMessageId: null,
        controlMessageId: null,
      });
      expect(publish.prepareBotReviewSnapshot).not.toHaveBeenCalled();
    },
  );
  it.each(['QUEUED', 'CONTENT_SENT'])(
    'delivers %s at night regardless of publication hours',
    async (deliveryState) => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-09-18T00:15:00Z'));
      try {
        const { internals, row, settings, prisma, max } = fixture();
        prisma.vkParsingSettings.findUnique.mockResolvedValue({
          ...settings,
          schedulerTimezone: 'Europe/Moscow',
          workHoursStart: '09:00',
          workHoursEnd: '22:00',
          quietHoursStart: '22:00',
          quietHoursEnd: '09:00',
        });
        await internals.advance({
          ...row,
          deliveryState,
          contentMessageId: deliveryState === 'CONTENT_SENT' ? row.contentMessageId : null,
          controlMessageId: null,
          post: {
            ...row.post,
            source: { ...row.post.source, quietHoursStart: '23:00', quietHoursEnd: '08:00' },
          },
        });
        expect(max.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
        expect(prisma.vkBotReview.updateMany).toHaveBeenLastCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              deliveryState: deliveryState === 'QUEUED' ? 'CONTENT_SENT' : 'DELIVERED',
            }),
          }),
        );
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('releases old calendar delays without resetting retry, lease, receipt or quarantine state', async () => {
    jest.useFakeTimers();
    const now = new Date('2026-09-18T00:15:00Z');
    jest.setSystemTime(now);
    try {
      const { internals, prisma } = fixture();
      const base = {
        revision: 1,
        status: 'PENDING',
        deliveryState: 'QUEUED',
        nextAttemptAt: new Date('2026-09-18T06:00:00Z'),
        updatedAt: new Date(now.getTime() - 60_000),
      };
      const rows = [
        { ...base, id: 'calendar' },
        { ...base, id: 'content-receipt', deliveryState: 'CONTENT_SENT' },
        { ...base, id: 'error-calendar', deliveryState: 'ERROR' },
        {
          ...base,
          id: 'retry',
          deliveryState: 'ERROR',
          nextAttemptAt: new Date(now.getTime() + 5 * 60_000),
        },
        { ...base, id: 'new-delay', updatedAt: now },
        { ...base, id: 'preparing', deliveryState: 'PREPARING' },
        { ...base, id: 'sending', deliveryState: 'CONTENT_SENDING' },
        { ...base, id: 'sending-controls', deliveryState: 'CONTROL_SENDING' },
        { ...base, id: 'ambiguous', deliveryState: 'AMBIGUOUS' },
        { ...base, id: 'terminal', nextAttemptAt: new Date('9999-01-01T00:00:00Z') },
        { ...base, id: 'approved', status: 'APPROVED' },
      ];
      prisma.vkBotReview.findMany.mockImplementation(async ({ where, take }) =>
        rows
          .filter(
            (row) =>
              row.deliveryState === where.deliveryState &&
              row.status === where.status &&
              row.nextAttemptAt > where.nextAttemptAt.gt &&
              row.nextAttemptAt < where.nextAttemptAt.lt &&
              row.updatedAt < where.updatedAt.lt,
          )
          .slice(0, take),
      );
      await internals.releaseLegacyCalendarDeferrals(now);
      expect(prisma.vkBotReview.updateMany.mock.calls.map(([query]) => query.where.id)).toEqual([
        'calendar',
        'error-calendar',
        'content-receipt',
      ]);
      for (const [query] of prisma.vkBotReview.updateMany.mock.calls) {
        expect(query).toMatchObject({
          where: {
            revision: 1,
            status: 'PENDING',
            nextAttemptAt: base.nextAttemptAt,
            updatedAt: { lt: now },
            post: { ownerProfile: 'PUBLISHER', ownerBotId: 'publik_bot' },
          },
          data: { nextAttemptAt: now },
        });
        expect(Object.keys(query.data)).toEqual(['nextAttemptAt']);
      }
      for (const [query] of prisma.vkBotReview.findMany.mock.calls) {
        expect(query.take).toBe(10);
        expect(query.select).toEqual({ id: true, revision: true, nextAttemptAt: true });
      }
      await internals.releaseLegacyCalendarDeferrals(now);
      expect(prisma.vkBotReview.findMany).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves the configured governor retry horizon during legacy delay recovery', async () => {
    const { internals, prisma, config } = fixture();
    config.get.mockImplementation((key) =>
      key === 'BACKGROUND_GOVERNOR_PAUSE_RETRY_AFTER_MS' ? 20 * 60_000 : true,
    );
    prisma.vkBotReview.findMany.mockResolvedValue([]);
    const now = new Date();
    await internals.releaseLegacyCalendarDeferrals(now);
    expect(prisma.vkBotReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          nextAttemptAt: {
            gt: new Date(now.getTime() + 20 * 60_000),
            lt: new Date('9999-01-01T00:00:00Z'),
          },
        }),
      }),
    );
  });

  it('continues bounded legacy recovery when a page is full', async () => {
    const { internals, prisma } = fixture();
    const now = new Date();
    prisma.vkBotReview.findMany.mockImplementation(async ({ where }) =>
      where.deliveryState === 'QUEUED'
        ? Array.from({ length: 10 }, (_, i) => ({
            id: `old-${i}`,
            revision: 1,
            nextAttemptAt: new Date(now.getTime() + 60 * 60_000),
          }))
        : [],
    );
    await internals.releaseLegacyCalendarDeferrals(now);
    expect(prisma.vkBotReview.updateMany).toHaveBeenCalledTimes(10);
    await internals.releaseLegacyCalendarDeferrals(now);
    expect(prisma.vkBotReview.findMany).toHaveBeenCalledTimes(6);
  });

  it('persists the send fence before sending and saves a receipt afterwards', async () => {
    const { internals, row, prisma, max } = fixture();
    await internals.advance({
      ...row,
      deliveryState: 'QUEUED',
      contentMessageId: null,
      controlMessageId: null,
    });
    expect(max.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(prisma.vkBotReview.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deliveryState: 'CONTENT_SENDING' }),
      }),
    );
    expect(prisma.vkBotReview.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deliveryState: 'CONTENT_SENDING' }),
        data: expect.objectContaining({
          contentMessageId: 'sent-1',
          deliveryState: 'CONTENT_SENT',
        }),
      }),
    );
  });
  it('does not re-send when writing a confirmed receipt fails transiently', async () => {
    const { internals, row, prisma, max } = fixture();
    prisma.vkBotReview.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({ count: 1 });
    await internals.advance({
      ...row,
      deliveryState: 'QUEUED',
      contentMessageId: null,
      controlMessageId: null,
    });
    expect(max.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(prisma.vkBotReview.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deliveryState: 'CONTENT_SENT' }) }),
    );
  });
  it('quarantines an ambiguous content send', async () => {
    const { internals, row, prisma, max } = fixture();
    max.sendMessageImmediateWithId.mockImplementationOnce(async (_chat, _text, options) => {
      await options.beforeSend?.();
      throw new Error('timeout');
    });
    await internals.advance({
      ...row,
      deliveryState: 'QUEUED',
      contentMessageId: null,
      controlMessageId: null,
    });
    expect(prisma.vkBotReview.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deliveryState: 'AMBIGUOUS' }) }),
    );
  });

  it('keeps a structured MAX denial recoverable without quarantining it as an unknown send', async () => {
    const { internals, row, prisma, max } = fixture();
    max.sendMessageImmediateWithId.mockImplementationOnce(async (_chat, _text, options) => {
      await options.beforeSend?.();
      throw { response: { status: 403, data: { code: 'chat.denied' } } };
    });
    await internals.advance({
      ...row,
      deliveryState: 'QUEUED',
      contentMessageId: null,
      controlMessageId: null,
    });
    expect(prisma.vkBotReview.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveryState: 'ERROR',
          nextAttemptAt: new Date(Date.now() + 5 * 60_000),
        }),
      }),
    );
  });
  it.each([{ revision: 2 }, { messageId: 'foreign' }, { privateChatId: '99' }])(
    'rejects a stale or foreign callback %j',
    async (patch) => {
      const { internals, callback, publish } = fixture();
      await expect(internals.decide({ ...callback, ...patch })).rejects.toThrow(ConflictException);
      expect(publish.publishBotReviewedPost).not.toHaveBeenCalled();
    },
  );
  it('rejects approval after content settings change', async () => {
    const { internals, callback, settings, publish } = fixture();
    settings.stripLinksEnabled = true;
    await expect(internals.decide(callback)).rejects.toThrow('Пост изменился');
    expect(publish.publishBotReviewedPost).not.toHaveBeenCalled();
  });
  it('does not admit publication after a concurrent decision wins', async () => {
    const { internals, callback, prisma, publish } = fixture();
    prisma.vkBotReview.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(internals.decide(callback)).rejects.toThrow('уже обработан');
    expect(publish.publishBotReviewedPost).not.toHaveBeenCalled();
  });
  it('accepts duplicate approval without enqueuing another publication', async () => {
    const { internals, callback, row, publish } = fixture();
    row.status = 'APPROVED';
    await internals.decide(callback);
    expect(publish.publishBotReviewedPost).not.toHaveBeenCalled();
  });
  it('never publishes on rejection', async () => {
    const { internals, callback, publish, prisma } = fixture();
    await internals.decide({ ...callback, action: 'reject' });
    expect(publish.publishBotReviewedPost).not.toHaveBeenCalled();
    expect(prisma.vkBotReview.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REJECTED', decidedByUserId: '17' }),
      }),
    );
  });
  it('requires current MAX admin access before accepting a card', async () => {
    const { internals, callback, max, publish } = fixture();
    max.getChatMembersAccess.mockResolvedValue(new Map());
    await expect(internals.decide(callback)).rejects.toThrow('Права администратора');
    expect(publish.publishBotReviewedPost).not.toHaveBeenCalled();
  });
  it('requires an explicit connected inbox and never accepts an arbitrary recipient', async () => {
    const { service, prisma } = fixture();
    prisma.vkBotReviewInbox.findUnique.mockResolvedValue(null);
    await expect(
      service.configure(
        '-1',
        { userId: '17', username: null, displayName: null },
        { action: 'CONNECT' },
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.vkParsingSettings.upsert).not.toHaveBeenCalled();
  });
});
