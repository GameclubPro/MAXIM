import type { Job } from 'bullmq';
import {
  ChannelSuggestionAdminDeliveryStatus,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import type { PublisherSuggestionAdminJob } from '../publisher/publisher-suggestion-admin.queue';
import { PublisherSuggestionAdminProcessor } from './publisher-suggestion-admin.processor';

function createFixture() {
  const prisma = {
    auditLog: {
      findFirst: jest.fn(),
    },
    channelSuggestionAdminDelivery: {
      findFirst: jest.fn(),
    },
    managedEntityAccessEdge: {
      findFirst: jest.fn().mockResolvedValue({ chatId: '-9001' }),
    },
  };
  const maxClient = {
    getChatMembersAccess: jest.fn(),
    answerCallback: jest.fn().mockResolvedValue(undefined),
  };
  const channelDialogs = {
    processPublisherSuggestionAdminDeliveryJob: jest.fn().mockResolvedValue(undefined),
    syncPublisherSuggestionAdminReviewMessages: jest.fn().mockResolvedValue(undefined),
  };
  const suggestions = {
    review: jest.fn(),
  };
  const queue = {
    enqueueSync: jest.fn().mockResolvedValue(undefined),
  };
  const identityAttestation = {
    assertAttested: jest.fn().mockResolvedValue(undefined),
  };
  const dispatchHealth = {
    assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
  };
  const runtimeBoundary = {
    dispatchEnabled: true,
    assertDispatchEnabled: jest.fn(),
  };
  const credentials = {
    getBotId: jest.fn(() => 'publisher-bot'),
  };
  const Processor = PublisherSuggestionAdminProcessor as unknown as new (
    ...args: unknown[]
  ) => PublisherSuggestionAdminProcessor;
  const processor = new Processor(
    prisma,
    maxClient,
    channelDialogs,
    suggestions,
    queue,
    identityAttestation,
    dispatchHealth,
    runtimeBoundary,
    credentials,
  );

  return {
    processor,
    prisma,
    maxClient,
    channelDialogs,
    suggestions,
    queue,
    identityAttestation,
    dispatchHealth,
    runtimeBoundary,
    credentials,
  };
}

function deliverJob(requiredBotId = 'publisher-bot'): Job<PublisherSuggestionAdminJob> {
  return {
    data: {
      version: 1,
      kind: 'deliver',
      suggestionId: 'publisher-suggestion-1',
      requiredBotId,
      requestedAt: '2026-09-01T18:00:00.000Z',
    },
  } as Job<PublisherSuggestionAdminJob>;
}

function syncJob(): Job<PublisherSuggestionAdminJob> {
  return {
    data: {
      version: 1,
      kind: 'sync',
      suggestionId: 'publisher-suggestion-1',
      requiredBotId: 'publisher-bot',
      reviewStatus: 'published',
      requestedAt: '2026-09-01T18:01:00.000Z',
    },
  } as Job<PublisherSuggestionAdminJob>;
}

function reviewJob(
  overrides: Partial<Extract<PublisherSuggestionAdminJob, { kind: 'review' }>> = {},
): Job<PublisherSuggestionAdminJob> {
  return {
    data: {
      version: 1,
      kind: 'review',
      suggestionId: 'publisher-suggestion-1',
      requiredBotId: 'publisher-bot',
      action: 'publish',
      actor: {
        userId: '101',
        username: 'editor',
        displayName: 'Channel Editor',
        avatarUrl: 'https://example.test/avatar.jpg',
        profileUrl: 'https://max.ru/u/editor',
      },
      callbackId: 'callback-1',
      privateChatId: '7001',
      messageId: 'mid-card-1',
      webhookEventId: 'webhook-1',
      updateId: 'update-1',
      requestedAt: '2026-09-01T18:02:00.000Z',
      ...overrides,
    },
  } as Job<PublisherSuggestionAdminJob>;
}

describe('PublisherSuggestionAdminProcessor', () => {
  const originalRole = process.env.APP_ROLE;
  const originalServiceName = process.env.APP_SERVICE_NAME;
  const originalPublisherBotId = process.env.MAX_PUBLISHER_BOT_ID;

  beforeEach(() => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    process.env.MAX_PUBLISHER_BOT_ID = 'publisher-bot';
  });

  afterEach(() => {
    restoreEnv('APP_ROLE', originalRole);
    restoreEnv('APP_SERVICE_NAME', originalServiceName);
    restoreEnv('MAX_PUBLISHER_BOT_ID', originalPublisherBotId);
  });

  it('refuses the dedicated queue outside api-publisher before running guards or domain work', async () => {
    process.env.APP_ROLE = 'action';
    process.env.APP_SERVICE_NAME = 'api-action';
    const fixture = createFixture();

    await expect(fixture.processor.process(deliverJob())).rejects.toThrow('non-publisher API role');

    expect(fixture.runtimeBoundary.assertDispatchEnabled).not.toHaveBeenCalled();
    expect(fixture.identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(fixture.dispatchHealth.assertDispatchAllowed).not.toHaveBeenCalled();
    expect(
      fixture.channelDialogs.processPublisherSuggestionAdminDeliveryJob,
    ).not.toHaveBeenCalled();
  });

  it('rejects a job addressed to any bot other than the configured Publisher bot', async () => {
    const fixture = createFixture();

    await expect(fixture.processor.process(deliverJob('major-bot'))).rejects.toThrow();

    expect(fixture.runtimeBoundary.assertDispatchEnabled).not.toHaveBeenCalled();
    expect(fixture.identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(fixture.dispatchHealth.assertDispatchAllowed).not.toHaveBeenCalled();
    expect(
      fixture.channelDialogs.processPublisherSuggestionAdminDeliveryJob,
    ).not.toHaveBeenCalled();
    expect(
      fixture.channelDialogs.syncPublisherSuggestionAdminReviewMessages,
    ).not.toHaveBeenCalled();
    expect(fixture.suggestions.review).not.toHaveBeenCalled();
  });

  it('routes deliver and sync envelopes through the exact Publisher bot after all guards', async () => {
    const fixture = createFixture();

    await fixture.processor.process(deliverJob());
    await fixture.processor.process(syncJob());

    expect(fixture.runtimeBoundary.assertDispatchEnabled).toHaveBeenCalledTimes(2);
    expect(fixture.identityAttestation.assertAttested).toHaveBeenCalledTimes(2);
    expect(fixture.dispatchHealth.assertDispatchAllowed).toHaveBeenCalledTimes(2);
    expect(fixture.channelDialogs.processPublisherSuggestionAdminDeliveryJob).toHaveBeenCalledWith(
      'publisher-suggestion-1',
      'publisher-bot',
    );
    expect(fixture.channelDialogs.syncPublisherSuggestionAdminReviewMessages).toHaveBeenCalledWith(
      'publisher-suggestion-1',
      'publisher-bot',
    );
  });

  it('reviews only an exactly bound SENT card after a live admin recheck, acknowledges it, and enqueues terminal sync', async () => {
    const fixture = createFixture();
    fixture.prisma.auditLog.findFirst.mockResolvedValue({
      id: 'publisher-suggestion-1',
      chatId: '-9001',
    });
    fixture.prisma.channelSuggestionAdminDelivery.findFirst.mockResolvedValue({ id: 'delivery-1' });
    fixture.maxClient.getChatMembersAccess.mockResolvedValue(
      new Map([['101', { isAdmin: true, isOwner: false }]]),
    );
    fixture.suggestions.review.mockResolvedValue({
      suggestion: { reviewStatus: 'published' },
    });

    await fixture.processor.process(reviewJob());

    expect(fixture.prisma.auditLog.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'publisher-suggestion-1',
        action: 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION',
      },
      select: { id: true, chatId: true },
    });
    expect(fixture.prisma.channelSuggestionAdminDelivery.findFirst).toHaveBeenCalledWith({
      where: {
        auditLogId: 'publisher-suggestion-1',
        adminUserId: '101',
        botKey: 'publisher:publisher-bot',
        botId: 'publisher-bot',
        privateChatId: '7001',
        remoteMessageId: 'mid-card-1',
        status: ChannelSuggestionAdminDeliveryStatus.SENT,
      },
      select: { id: true },
    });
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledWith('-9001', ['101'], {
      botId: 'publisher-bot',
      trafficClass: 'interactive',
      actionHealthLane: 'interactive',
      sourceTag: 'suggestion_delivery',
      bypassCache: true,
    });
    expect(fixture.prisma.managedEntityAccessEdge.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: '-9001',
        userId: '101',
        botId: 'publisher-bot',
        state: ManagedEntityAccessState.GRANTED,
        userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
        OR: [
          { expiresAt: { gt: expect.any(Date) } },
          {
            expiresAt: null,
            checkedAt: { gt: expect.any(Date) },
          },
        ],
      },
      select: { chatId: true },
    });
    expect(fixture.suggestions.review).toHaveBeenCalledWith(
      '-9001',
      'publisher-suggestion-1',
      {
        userId: '101',
        launchBotId: 'publisher-bot',
        username: 'editor',
        displayName: 'Channel Editor',
        avatarUrl: 'https://example.test/avatar.jpg',
        profileUrl: 'https://max.ru/u/editor',
        chatId: '7001',
        chatType: 'dialog',
      },
      { action: 'publish', responseVersion: 2 },
    );
    expect(fixture.queue.enqueueSync).toHaveBeenCalledWith({
      suggestionId: 'publisher-suggestion-1',
      requiredBotId: 'publisher-bot',
      reviewStatus: 'published',
      recoverExisting: true,
    });
    expect(fixture.maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      'Предложка передана в публикацию.',
      undefined,
      {
        botId: 'publisher-bot',
        rateLimitEntityId: '7001',
        actionHealthLane: 'interactive',
        sourceTag: 'callback_answer',
      },
    );
  });

  it('rejects a callback whose admin, bot, dialog, or message does not bind to a SENT card', async () => {
    const fixture = createFixture();
    fixture.prisma.auditLog.findFirst.mockResolvedValue({
      id: 'publisher-suggestion-1',
      chatId: '-9001',
    });
    fixture.prisma.channelSuggestionAdminDelivery.findFirst.mockResolvedValue(null);

    await fixture.processor.process(
      reviewJob({
        actor: {
          userId: '202',
          username: null,
          displayName: 'Another Admin',
          avatarUrl: null,
          profileUrl: null,
        },
        privateChatId: '8002',
        messageId: 'mid-other-card',
      }),
    );

    expect(fixture.prisma.channelSuggestionAdminDelivery.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          auditLogId: 'publisher-suggestion-1',
          adminUserId: '202',
          botKey: 'publisher:publisher-bot',
          botId: 'publisher-bot',
          privateChatId: '8002',
          remoteMessageId: 'mid-other-card',
          status: ChannelSuggestionAdminDeliveryStatus.SENT,
        }),
      }),
    );
    expect(fixture.maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(fixture.suggestions.review).not.toHaveBeenCalled();
    expect(fixture.queue.enqueueSync).not.toHaveBeenCalled();
    expect(fixture.maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      'Эта кнопка больше недоступна.',
      undefined,
      expect.objectContaining({ botId: 'publisher-bot', rateLimitEntityId: '8002' }),
    );
  });

  it('rejects a formerly delivered editor when the live Publisher access recheck no longer confirms admin rights', async () => {
    const fixture = createFixture();
    fixture.prisma.auditLog.findFirst.mockResolvedValue({
      id: 'publisher-suggestion-1',
      chatId: '-9001',
    });
    fixture.prisma.channelSuggestionAdminDelivery.findFirst.mockResolvedValue({ id: 'delivery-1' });
    fixture.maxClient.getChatMembersAccess.mockResolvedValue(
      new Map([['101', { isAdmin: false, isOwner: false }]]),
    );

    await expect(fixture.processor.process(reviewJob())).resolves.toBeUndefined();

    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      '-9001',
      ['101'],
      expect.objectContaining({ botId: 'publisher-bot', bypassCache: true }),
    );
    expect(fixture.suggestions.review).not.toHaveBeenCalled();
    expect(fixture.queue.enqueueSync).not.toHaveBeenCalled();
    expect(fixture.maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      'Права администратора не подтверждены.',
      undefined,
      expect.objectContaining({ botId: 'publisher-bot', rateLimitEntityId: '7001' }),
    );
  });

  it('rejects a delivered card with a missing or stale Publisher access edge before probing MAX', async () => {
    const fixture = createFixture();
    fixture.prisma.auditLog.findFirst.mockResolvedValue({
      id: 'publisher-suggestion-1',
      chatId: '-9001',
    });
    fixture.prisma.channelSuggestionAdminDelivery.findFirst.mockResolvedValue({ id: 'delivery-1' });
    fixture.prisma.managedEntityAccessEdge.findFirst.mockResolvedValue(null);

    await expect(fixture.processor.process(reviewJob())).resolves.toBeUndefined();

    expect(fixture.prisma.managedEntityAccessEdge.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: '-9001',
        userId: '101',
        botId: 'publisher-bot',
        state: ManagedEntityAccessState.GRANTED,
        userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
        OR: [
          { expiresAt: { gt: expect.any(Date) } },
          {
            expiresAt: null,
            checkedAt: { gt: expect.any(Date) },
          },
        ],
      },
      select: { chatId: true },
    });
    expect(fixture.maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(fixture.suggestions.review).not.toHaveBeenCalled();
    expect(fixture.queue.enqueueSync).not.toHaveBeenCalled();
    expect(fixture.maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      'Права администратора не подтверждены.',
      undefined,
      expect.objectContaining({ botId: 'publisher-bot', rateLimitEntityId: '7001' }),
    );
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
