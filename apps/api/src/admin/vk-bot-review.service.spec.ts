import { BadRequestException, ConflictException } from '@nestjs/common';
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
    post,
  };
  const prisma = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ id: '-1' }]),
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    vkBotReview: {
      findFirst: jest.fn().mockResolvedValue(row),
      findUnique: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([row]),
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
  const service = new VkBotReviewService(
    prisma as never,
    access as never,
    { getPublisherScope: () => scope } as never,
    publish as never,
    max as never,
    {
      buildBotStartUrlSync: () => 'https://max.ru/publik_bot?start=vk_review',
      buildMiniappStartUrlSync: () => 'https://max.ru/publik_bot?startapp=route',
    } as never,
    queue as never,
    config as never,
    governor as never,
  );
  const internals = service as unknown as {
    drain(): Promise<void>;
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
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-15T12:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('finishes an existing preview/control pair ahead of new previews', async () => {
    const { internals, row, prisma } = fixture();
    const control = { ...row, deliveryState: 'CONTENT_SENT' };
    const fresh = { ...row, id: 'review-2', deliveryState: 'QUEUED' };
    prisma.vkBotReview.findMany.mockImplementation(
      async ({ where }: { where: { deliveryState: string } }) =>
        where.deliveryState === 'CONTENT_SENT'
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
      async ({ where }: { where: { deliveryState: string } }) =>
        where.deliveryState === 'QUEUED' ? [blocked, next] : [],
    );
    prisma.vkBotReview.count.mockResolvedValueOnce(5).mockResolvedValueOnce(5).mockResolvedValue(0);
    const advance = jest.spyOn(internals, 'advance').mockResolvedValue(undefined);
    await internals.drain();
    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledWith(next);
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
