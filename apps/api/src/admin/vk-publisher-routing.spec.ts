import { ConfigService } from '@nestjs/config';
import { PublisherSetupRequiredException } from '../publisher/publisher-errors';
import {
  ChatEntityType,
  PublicationDispatchProfile,
  VkParsingOwnerProfile,
} from '../prisma/prisma-client';
import { VkParsingOwnershipService } from './vk-parsing-ownership.service';
import { VkPublishService } from './vk-publish.service';

function createPublisherDialogContext() {
  return {
    version: 1 as const,
    dialogBotId: 'publisher-bot',
    buttons: [
      [
        {
          type: 'link' as const,
          text: 'Предложить пост',
          url: 'https://max.ru/publisher-bot?startapp=publisher-signed-context',
        },
      ],
    ],
    reference: {
      entityType: 'channel' as const,
      threadId: 'thread-publisher-signed',
      includeCommentsButton: false,
      includeSuggestButton: true,
      suggestButtonText: 'Предложить пост',
      customButtons: [],
      suggestionEntryMode: 'MINIAPP' as const,
      botId: null,
      dialogBotId: 'publisher-bot',
    },
  };
}

function createPost(overrides: Record<string, unknown> = {}) {
  const publisherDialogContext = createPublisherDialogContext();
  const source = {
    id: 'source-1',
    chatId: 'channel-1',
    ownerProfile: VkParsingOwnerProfile.PUBLISHER,
    ownerBotId: 'publisher-bot',
    publishMode: 'QUEUE',
    quietHoursStart: null,
    quietHoursEnd: null,
    autoPublishEnabled: true,
    autoPublishEnabledAt: new Date('2026-08-26T08:00:00.000Z'),
    status: 'ACTIVE',
    importEnabled: true,
    autoPublishPausedAt: null,
    autoPublishPausedReason: null,
    dailyLimit: 3,
    minPublishIntervalMinutes: 30,
    lastAutoPublishedAt: null,
  };
  return {
    id: 'post-1',
    sourceId: source.id,
    chatId: source.chatId,
    ownerProfile: source.ownerProfile,
    ownerBotId: source.ownerBotId,
    vkOwnerId: -1,
    vkPostId: 10,
    text: 'Пост из VK',
    textFormat: 'plain',
    manualContentEditedAt: null,
    photoUrls: [],
    videoUrls: [],
    linkUrls: [],
    attachments: [],
    attachmentTypes: [],
    unsupportedAttachments: [],
    hasUnsupportedAttachments: false,
    url: 'https://vk.ru/wall-1_10',
    raw: {},
    isAdvertising: false,
    advertisingMarkers: [],
    contentHash: 'content-1',
    publishedContentHash: null,
    status: 'NEW',
    publishedMessageId: null,
    publishedUrl: null,
    publishedAtMax: null,
    autoPublishedAt: null,
    autoPublishError: null,
    skippedAt: null,
    skipReason: null,
    createdAt: new Date('2026-08-26T09:00:00.000Z'),
    updatedAt: new Date('2026-08-26T09:00:00.000Z'),
    vkPublishedAt: new Date('2026-08-26T09:00:00.000Z'),
    lastSeenAt: new Date('2026-08-26T09:00:00.000Z'),
    missingSinceAt: null,
    missingSeenCount: 0,
    lastAvailabilityCheckedAt: new Date('2026-08-26T09:00:00.000Z'),
    unavailableAt: null,
    publishQueuedAt: null,
    publishScheduledAt: null,
    publishCancelledAt: null,
    publishCancelledByUserId: null,
    publishLockedAt: null,
    publishAttemptCount: 0,
    publishIdempotencyKey: null,
    publishReason: null,
    publishActorUserId: null,
    dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
    requiredBotId: null,
    dialogBotId: null,
    publishDialogContext:
      overrides.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
        ? publisherDialogContext
        : null,
    publicationPolicyRevision: null,
    publishedBotId: null,
    dispatchBlockerCode: null,
    dispatchBlockedAt: null,
    rollbackQueuedAt: null,
    rollbackLockedAt: null,
    rollbackDeletedAt: null,
    rollbackAttemptCount: 0,
    rollbackIdempotencyKey: null,
    rollbackLastError: null,
    lastError: null,
    source,
    ...overrides,
  };
}

function createFixture() {
  const prisma = {
    vkParsingPost: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _max: { vkPublishedAt: null } }),
    },
    vkParsingSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    vkParsingSource: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    channelAudienceSnapshot: { findFirst: jest.fn().mockResolvedValue(null) },
    managedBotChatCatalog: { findFirst: jest.fn().mockResolvedValue(null) },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
  };
  const accessService = {
    resolvePublicationEntityType: jest.fn().mockResolvedValue(ChatEntityType.CHANNEL),
  };
  const adminService = {
    buildChannelPublicationEngagementContext: jest.fn().mockResolvedValue({
      buttons: [],
      threadId: null,
      includeCommentsButton: false,
      includeSuggestButton: false,
      suggestButtonText: null,
      suggestionEntryMode: 'BOT',
    }),
    recordChannelPublicationEngagement: jest.fn(),
  };
  const maxClient = {
    deleteMessage: jest.fn().mockResolvedValue(undefined),
    sendMessageImmediateWithResolvedLink: jest.fn(),
    getChatSnapshot: jest.fn().mockResolvedValue({
      entityType: 'channel',
      link: 'https://max.ru/channel/publisher-owned',
    }),
  };
  const maxBotLinkService = {
    resolveBotIdForSend: jest.fn().mockResolvedValue('main-dialog-bot'),
    resolveBotIdForModerationAction: jest.fn().mockResolvedValue('main-fallback-bot'),
  };
  const feedService = {
    mapPost: jest.fn((value: any) => ({
      ...value,
      sourceTitle: value.source?.title ?? 'VK source',
      sourceUrl: value.source?.url ?? 'https://vk.ru/source',
      sourcePublishMode: value.source?.publishMode ?? 'QUEUE',
      vkPublishedAt: value.vkPublishedAt?.toISOString?.() ?? null,
      publishedAtMax: value.publishedAtMax?.toISOString?.() ?? null,
      autoPublishedAt: value.autoPublishedAt?.toISOString?.() ?? null,
      skippedAt: value.skippedAt?.toISOString?.() ?? null,
      lastSeenAt: value.lastSeenAt?.toISOString?.() ?? null,
      missingSinceAt: value.missingSinceAt?.toISOString?.() ?? null,
      lastAvailabilityCheckedAt: value.lastAvailabilityCheckedAt?.toISOString?.() ?? null,
      unavailableAt: value.unavailableAt?.toISOString?.() ?? null,
      publishQueuedAt: value.publishQueuedAt?.toISOString?.() ?? null,
      publishScheduledAt: value.publishScheduledAt?.toISOString?.() ?? null,
      publishCancelledAt: value.publishCancelledAt?.toISOString?.() ?? null,
      publishLockedAt: value.publishLockedAt?.toISOString?.() ?? null,
      createdAt: value.createdAt.toISOString(),
      updatedAt: value.updatedAt.toISOString(),
    })),
  };
  const legacyQueue = { add: jest.fn(), getJob: jest.fn().mockResolvedValue(null) };
  const publisherQueue = {
    add: jest.fn().mockResolvedValue(undefined),
    getJob: jest.fn().mockResolvedValue(null),
  };
  const readiness = {
    assertEntityReady: jest.fn().mockResolvedValue({
      chatId: 'channel-1',
      entityType: 'channel',
      requiredBotId: 'publisher-bot',
      policyRevision: 4,
    }),
  };
  const runtimeBoundary = { assertDispatchEnabled: jest.fn() };
  const health = {
    assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
    isGloballyPaused: jest.fn().mockResolvedValue(false),
    recordSendSuccess: jest.fn().mockResolvedValue(undefined),
    recordSendFailure: jest.fn().mockResolvedValue('transient'),
  };
  const publisherDialogContextService = {
    prepare: jest.fn().mockResolvedValue(createPublisherDialogContext()),
    read: jest.fn((value: unknown, expectedBotId: string) => {
      const context = value as ReturnType<typeof createPublisherDialogContext> | null;
      return context?.version === 1 && context.dialogBotId === expectedBotId ? context : null;
    }),
  };
  const maxRoutedPublicationService = { publish: jest.fn() };
  const channelPostSignatureService = {
    preparePostText: jest.fn().mockResolvedValue({
      text: 'Major signature',
      textFormat: 'html',
      engagementText: 'Major signature',
      signatureApplied: true,
    }),
  };
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'MAX_PUBLISHER_BOT_ID') return 'publisher-bot';
      if (key === 'MAX_PUBLISHER_DISPATCH_ENABLED') return true;
      if (key === 'VK_PARSING_QUEUE_BATCH_SIZE') return 100;
      if (key === 'VK_PARSING_PUBLISH_LEASE_TTL_MS') return 120_000;
      return undefined;
    }),
  } as unknown as ConfigService;
  const ownership = new VkParsingOwnershipService(configService);
  const service = new VkPublishService(
    prisma as never,
    accessService as never,
    adminService as never,
    maxClient as never,
    maxBotLinkService as never,
    {} as never,
    feedService as never,
    configService,
    ownership,
    undefined,
    undefined,
    maxRoutedPublicationService as never,
    channelPostSignatureService as never,
    publisherQueue as never,
    readiness as never,
    runtimeBoundary as never,
    health as never,
    publisherDialogContextService as never,
  );
  return {
    service,
    prisma,
    accessService,
    adminService,
    maxClient,
    maxBotLinkService,
    legacyQueue,
    publisherQueue,
    readiness,
    runtimeBoundary,
    health,
    publisherDialogContextService,
    maxRoutedPublicationService,
    channelPostSignatureService,
  };
}

describe('VK Publik routing', () => {
  it('does not scan any VK recovery work while Publisher dispatch is paused', async () => {
    const fixture = createFixture();
    fixture.health.isGloballyPaused.mockResolvedValue(true);

    await expect(fixture.service.recoverStalePublishJobs()).resolves.toBe(0);

    expect(fixture.prisma.vkParsingPost.findMany).not.toHaveBeenCalled();
    expect(fixture.legacyQueue.add).not.toHaveBeenCalled();
    expect(fixture.publisherQueue.add).not.toHaveBeenCalled();
  });

  it('scans stale recovery only in the exact Publisher-owned PUBLIK_V1 scope', async () => {
    const fixture = createFixture();

    await expect(fixture.service.recoverStalePublishJobs()).resolves.toBe(0);

    expect(fixture.prisma.vkParsingPost.findMany).toHaveBeenCalled();
    for (const [query] of fixture.prisma.vkParsingPost.findMany.mock.calls) {
      expect(query.where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            ownerProfile: VkParsingOwnerProfile.PUBLISHER,
            ownerBotId: 'publisher-bot',
            requiredBotId: 'publisher-bot',
            source: {
              ownerProfile: VkParsingOwnerProfile.PUBLISHER,
              ownerBotId: 'publisher-bot',
            },
          }),
        ]),
      );
    }
    expect(fixture.legacyQueue.add).not.toHaveBeenCalled();
  });

  it('queues a new manual intent with one immutable Publisher-owned bot route', async () => {
    const fixture = createFixture();
    const post = createPost();
    fixture.prisma.vkParsingPost.findFirst.mockResolvedValueOnce(post).mockResolvedValueOnce({
      ...post,
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      dialogBotId: 'publisher-bot',
      publicationPolicyRevision: 4,
    });

    const result = await fixture.service.publishPost('channel-1', 'post-1', 'admin-1', {
      text: 'Обновлённый пост',
      textFormat: 'plain',
      photoUrls: [],
      videoUrls: [],
      linkUrls: [],
    });

    expect(result).toMatchObject({ queued: 1 });
    expect(fixture.prisma.vkParsingPost.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          id: 'post-1',
          chatId: 'channel-1',
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
          source: {
            ownerProfile: VkParsingOwnerProfile.PUBLISHER,
            ownerBotId: 'publisher-bot',
          },
        },
      }),
    );
    expect(fixture.prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId: 'publisher-bot',
          dialogBotId: 'publisher-bot',
          publishDialogContext: expect.objectContaining({
            version: 1,
            dialogBotId: 'publisher-bot',
          }),
          publicationPolicyRevision: 4,
          publishActorUserId: 'admin-1',
        }),
      }),
    );
    expect(fixture.publisherQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({
        kind: 'publish',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-bot',
      }),
      expect.any(Object),
    );
    expect(fixture.legacyQueue.add).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(fixture.publisherDialogContextService.prepare).toHaveBeenCalledWith({
      chatId: 'channel-1',
      entityType: 'channel',
      dialogBotId: 'publisher-bot',
      customButtons: [],
    });
    expect(fixture.maxBotLinkService.resolveBotIdForSend).not.toHaveBeenCalled();
  });

  it('resolves Publisher channel links only from the exact Publisher catalog or token', async () => {
    const fixture = createFixture();
    fixture.prisma.managedBotChatCatalog.findFirst.mockResolvedValue({
      link: 'https://max.ru/channel/publisher-catalog',
    });

    await expect(
      (fixture.service as any).resolveChannelLink('channel-1', 'interactive', 'publisher-bot'),
    ).resolves.toBe('https://max.ru/channel/publisher-catalog');

    expect(fixture.prisma.channelAudienceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(fixture.prisma.managedBotChatCatalog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'channel-1',
          botId: 'publisher-bot',
        }),
      }),
    );
    expect(fixture.maxBotLinkService.resolveBotIdForSend).not.toHaveBeenCalled();
    expect(fixture.maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('keeps an already-persisted Publisher intent with its old distinct dialog route executable', async () => {
    const fixture = createFixture();
    const oldDialogContext = {
      ...createPublisherDialogContext(),
      dialogBotId: 'main-dialog-bot',
      buttons: [
        [
          {
            type: 'link' as const,
            text: 'Комментарии',
            url: 'https://max.ru/main-dialog-bot?startapp=legacy-main-context',
          },
        ],
      ],
      reference: null,
    };

    await expect(
      (fixture.service as any).assertPublisherIntentReady(
        createPost({
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId: 'publisher-bot',
          dialogBotId: 'main-dialog-bot',
          publishDialogContext: oldDialogContext,
          publicationPolicyRevision: 4,
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        requiredBotId: 'publisher-bot',
      }),
    );

    expect(fixture.publisherDialogContextService.read).toHaveBeenCalledWith(
      oldDialogContext,
      'main-dialog-bot',
    );
  });

  it('rejects an already queued legacy intent before any database claim or MAX call', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.processPublishPostJob({
        postId: 'legacy-post',
        chatId: 'channel-1',
        reason: 'manual-schedule',
        idempotencyKey: 'legacy-intent',
        dispatchProfile: 'LEGACY_ROUTED',
      }),
    ).rejects.toThrow('Legacy VK publish execution is disabled');

    expect(fixture.prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(fixture.prisma.vkParsingPost.findFirst).not.toHaveBeenCalled();
    expect(fixture.maxRoutedPublicationService.publish).not.toHaveBeenCalled();
    expect(fixture.readiness.assertEntityReady).not.toHaveBeenCalled();
    expect(fixture.runtimeBoundary.assertDispatchEnabled).not.toHaveBeenCalled();
    expect(fixture.channelPostSignatureService.preparePostText).not.toHaveBeenCalled();
  });

  it('sends a publisher job and its dialog only through the exact Publisher bot', async () => {
    const fixture = createFixture();
    const queuedAt = new Date('2026-08-26T10:00:00.000Z');
    const post = createPost({
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      dialogBotId: 'publisher-bot',
      publicationPolicyRevision: 4,
      publishActorUserId: 'admin-1',
      publishQueuedAt: queuedAt,
      publishScheduledAt: queuedAt,
      publishIdempotencyKey: 'intent-1',
      publishReason: 'manual-retry',
    });
    fixture.prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    let preparedOptions: Record<string, unknown> | undefined;
    fixture.maxRoutedPublicationService.publish.mockImplementation(async (request: any) => {
      const context = { botId: 'publisher-bot', job: {} };
      preparedOptions = (await request.prepareAttempt(context)).options;
      await request.onDispatchAttempt(context);
      await request.beforeSendMutation(context);
      return {
        messageId: 'message-1',
        url: 'https://max.ru/channel/message-1',
        botId: 'publisher-bot',
        candidateBotIds: ['publisher-bot'],
        routingVersion: null,
      };
    });

    await fixture.service.processPublishPostJob({
      postId: post.id,
      chatId: post.chatId,
      reason: 'manual-retry',
      idempotencyKey: 'intent-1',
      dispatchProfile: 'PUBLIK_V1',
      requiredBotId: 'publisher-bot',
    });

    expect(fixture.maxRoutedPublicationService.publish).toHaveBeenCalledWith(
      expect.objectContaining({ publisherExactBotId: 'publisher-bot' }),
    );
    expect(fixture.adminService.buildChannelPublicationEngagementContext).not.toHaveBeenCalled();
    expect(fixture.channelPostSignatureService.preparePostText).not.toHaveBeenCalled();
    expect(preparedOptions).toEqual(
      expect.objectContaining({
        buttons: expect.arrayContaining([
          expect.arrayContaining([expect.objectContaining({ text: 'Предложить пост' })]),
        ]),
      }),
    );
    expect(fixture.readiness.assertEntityReady).toHaveBeenCalledTimes(2);
    expect(fixture.runtimeBoundary.assertDispatchEnabled).toHaveBeenCalledTimes(3);
    expect(fixture.health.recordSendSuccess).toHaveBeenCalledWith('channel-1', expect.any(Date));
    expect(fixture.prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publishedBotId: 'publisher-bot',
          publishedMessageId: 'message-1',
        }),
      }),
    );
  });

  it('ignores a publisher queue job addressed to a different bot ownership scope', async () => {
    const fixture = createFixture();

    await fixture.service.processPublishPostJob({
      postId: 'foreign-post',
      chatId: 'channel-1',
      reason: 'manual-retry',
      idempotencyKey: 'foreign-intent',
      dispatchProfile: 'PUBLIK_V1',
      requiredBotId: 'other-publisher-bot',
    });

    expect(fixture.prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(fixture.readiness.assertEntityReady).not.toHaveBeenCalled();
    expect(fixture.runtimeBoundary.assertDispatchEnabled).not.toHaveBeenCalled();
    expect(fixture.maxRoutedPublicationService.publish).not.toHaveBeenCalled();
  });

  it('does not widen a blocked-intent update when requiredBotId is missing', async () => {
    const fixture = createFixture();

    await (fixture.service as any).markPublisherIntentBlocked(
      {
        id: 'malformed-post',
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: null,
      },
      'malformed-intent',
      'manual-retry',
      'publisher_setup_required',
    );

    expect(fixture.prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
  });

  it('does not clear a publisher auth pause from a VK ledger replay', async () => {
    const fixture = createFixture();
    const queuedAt = new Date('2026-08-26T10:00:00.000Z');
    const post = createPost({
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      dialogBotId: 'publisher-bot',
      publicationPolicyRevision: 4,
      publishQueuedAt: queuedAt,
      publishScheduledAt: queuedAt,
      publishIdempotencyKey: 'intent-replayed',
      publishReason: 'manual-retry',
    });
    fixture.prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    fixture.maxRoutedPublicationService.publish.mockResolvedValue({
      messageId: 'message-replayed',
      url: null,
      botId: 'publisher-bot',
      candidateBotIds: ['publisher-bot'],
      routingVersion: null,
    });

    await fixture.service.processPublishPostJob({
      postId: post.id,
      chatId: post.chatId,
      reason: 'manual-retry',
      idempotencyKey: 'intent-replayed',
      dispatchProfile: 'PUBLIK_V1',
      requiredBotId: 'publisher-bot',
    });

    expect(fixture.health.recordSendSuccess).not.toHaveBeenCalled();
    expect(fixture.prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PUBLISHED',
          publishedMessageId: 'message-replayed',
          publishedBotId: 'publisher-bot',
        }),
      }),
    );
  });

  it('keeps an unstarted publisher intent pending when policy readiness turns off', async () => {
    const fixture = createFixture();
    const post = createPost({
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      dialogBotId: 'publisher-bot',
      publicationPolicyRevision: 4,
      publishQueuedAt: new Date(),
      publishScheduledAt: new Date(),
      publishIdempotencyKey: 'intent-blocked',
      publishReason: 'manual-retry',
    });
    fixture.prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    fixture.readiness.assertEntityReady.mockRejectedValue(
      new PublisherSetupRequiredException(['channel-1'], 'policy_disabled'),
    );

    await fixture.service.processPublishPostJob({
      postId: post.id,
      chatId: post.chatId,
      reason: 'manual-retry',
      idempotencyKey: 'intent-blocked',
      dispatchProfile: 'PUBLIK_V1',
      requiredBotId: 'publisher-bot',
    });

    expect(fixture.maxRoutedPublicationService.publish).not.toHaveBeenCalled();
    expect(fixture.prisma.vkParsingPost.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publishLockedAt: null,
          dispatchBlockerCode: 'policy_disabled',
          dispatchBlockedAt: expect.any(Date),
        }),
      }),
    );
    const blockerData = fixture.prisma.vkParsingPost.updateMany.mock.calls.at(-1)?.[0]?.data;
    expect(blockerData).not.toHaveProperty('publishIdempotencyKey');
    expect(blockerData).not.toHaveProperty('requiredBotId');
  });

  it.each([
    { status: 401, health: 'global_paused', blocker: 'publisher_auth_paused' },
    { status: 403, health: 'setup_required', blocker: 'publisher_setup_required' },
  ])(
    'keeps a Publik intent pending after MAX $status without trying a main-bot fallback',
    async ({ status, health, blocker }) => {
      const fixture = createFixture();
      const post = createPost({
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: 'publisher-bot',
        dialogBotId: 'publisher-bot',
        publicationPolicyRevision: 4,
        publishQueuedAt: new Date(),
        publishScheduledAt: new Date(),
        publishIdempotencyKey: `intent-${status}`,
        publishReason: 'manual-retry',
      });
      fixture.prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      fixture.health.recordSendFailure.mockResolvedValue(health);
      const maxError = Object.assign(new Error(`MAX ${status}`), {
        response: { status },
      });
      fixture.maxRoutedPublicationService.publish.mockImplementation(async (request: any) => {
        await request.onDispatchAttempt({ botId: 'publisher-bot', job: {} });
        throw maxError;
      });

      await fixture.service.processPublishPostJob({
        postId: post.id,
        chatId: post.chatId,
        reason: 'manual-retry',
        idempotencyKey: `intent-${status}`,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-bot',
      });

      expect(fixture.health.recordSendFailure).toHaveBeenCalledWith(
        'channel-1',
        maxError,
        expect.any(Date),
      );
      expect(fixture.prisma.vkParsingPost.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ dispatchBlockerCode: blocker }),
        }),
      );
      const blockerData = fixture.prisma.vkParsingPost.updateMany.mock.calls.at(-1)?.[0]?.data;
      expect(blockerData).not.toHaveProperty('publishIdempotencyKey');
      expect(fixture.maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    },
  );

  it('retries a Publik 429 on the exact queue without fallback or route clearing', async () => {
    const fixture = createFixture();
    const post = createPost({
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      dialogBotId: 'publisher-bot',
      publicationPolicyRevision: 4,
      publishQueuedAt: new Date(),
      publishScheduledAt: new Date(),
      publishIdempotencyKey: 'intent-429',
      publishReason: 'manual-retry',
    });
    fixture.prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    fixture.health.recordSendFailure.mockResolvedValue('retryable');
    const rateLimitError = Object.assign(new Error('MAX rate limit'), {
      response: { status: 429 },
    });
    fixture.maxRoutedPublicationService.publish.mockImplementation(async (request: any) => {
      await request.onDispatchAttempt({ botId: 'publisher-bot', job: {} });
      throw rateLimitError;
    });

    await expect(
      fixture.service.processPublishPostJob({
        postId: post.id,
        chatId: post.chatId,
        reason: 'manual-retry',
        idempotencyKey: 'intent-429',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-bot',
      }),
    ).rejects.toBe(rateLimitError);

    expect(fixture.maxRoutedPublicationService.publish).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    const failureData = fixture.prisma.vkParsingPost.updateMany.mock.calls.at(-1)?.[0]?.data;
    expect(failureData).toMatchObject({ status: 'FAILED', publishLockedAt: null });
    expect(failureData).not.toHaveProperty('publishIdempotencyKey');
    expect(failureData).not.toHaveProperty('requiredBotId');
  });

  it('queues rollback only for Publisher-owned posts from the Publisher feed', async () => {
    const fixture = createFixture();
    const publisherPost = createPost({
      id: 'publisher-post',
      status: 'PUBLISHED',
      autoPublishedAt: new Date('2026-08-26T10:00:00.000Z'),
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      dialogBotId: 'publisher-bot',
      publicationPolicyRevision: 4,
      publishedBotId: 'publisher-bot',
      publishedMessageId: 'publisher-message',
    });
    fixture.prisma.vkParsingPost.findMany.mockResolvedValue([publisherPost]);

    const result = await fixture.service.rollbackAutoPublished('channel-1', 'admin-1', {
      since: '2026-08-26T09:00:00.000Z',
      until: '2026-08-26T11:00:00.000Z',
      deleteMessages: true,
    });

    expect(result).toMatchObject({ matched: 1, queued: 1, deleted: 0, failed: 0 });
    expect(fixture.prisma.vkParsingPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
          source: {
            ownerProfile: VkParsingOwnerProfile.PUBLISHER,
            ownerBotId: 'publisher-bot',
          },
        }),
      }),
    );
    expect(fixture.publisherQueue.add).toHaveBeenCalledWith(
      'rollback-vk-post',
      expect.objectContaining({
        kind: 'rollback-delete',
        postId: 'publisher-post',
        requiredBotId: 'publisher-bot',
      }),
      expect.any(Object),
    );
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(fixture.maxBotLinkService.resolveBotIdForModerationAction).not.toHaveBeenCalled();
  });

  it('reports a conflicting active publisher rollback owner without replacing it', async () => {
    const fixture = createFixture();
    const post = createPost({
      id: 'publisher-post',
      status: 'PUBLISHED',
      autoPublishedAt: new Date('2026-08-26T10:00:00.000Z'),
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      dialogBotId: 'publisher-bot',
      publicationPolicyRevision: 4,
      publishedBotId: 'publisher-bot',
      publishedMessageId: 'publisher-message',
    });
    fixture.prisma.vkParsingPost.findMany.mockResolvedValue([post]);
    fixture.publisherQueue.getJob.mockResolvedValue({
      data: {
        kind: 'rollback-delete',
        postId: 'publisher-post',
        chatId: 'channel-1',
        messageId: 'another-message',
        requiredBotId: 'publisher-bot',
        idempotencyKey: 'another-key',
      },
      getState: jest.fn().mockResolvedValue('active'),
    });

    const result = await fixture.service.rollbackAutoPublished('channel-1', 'admin-1', {
      since: '2026-08-26T09:00:00.000Z',
      until: '2026-08-26T11:00:00.000Z',
      deleteMessages: true,
    });

    expect(result).toMatchObject({ queued: 0, deleted: 0, failed: 1 });
    expect(fixture.publisherQueue.add).not.toHaveBeenCalled();
    expect(fixture.prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { rollbackLastError: 'publisher_queue_ownership_conflict' },
      }),
    );
  });

  it('keeps an armed publisher rollback durable when BullMQ add is temporarily unavailable', async () => {
    const fixture = createFixture();
    const post = createPost({
      id: 'publisher-post',
      status: 'PUBLISHED',
      autoPublishedAt: new Date('2026-08-26T10:00:00.000Z'),
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      dialogBotId: 'publisher-bot',
      publicationPolicyRevision: 4,
      publishedBotId: 'publisher-bot',
      publishedMessageId: 'publisher-message',
    });
    fixture.prisma.vkParsingPost.findMany.mockResolvedValue([post]);
    fixture.publisherQueue.add.mockRejectedValue(new Error('Redis unavailable'));

    const result = await fixture.service.rollbackAutoPublished('channel-1', 'admin-1', {
      since: '2026-08-26T09:00:00.000Z',
      until: '2026-08-26T11:00:00.000Z',
      deleteMessages: true,
    });

    expect(result).toMatchObject({ queued: 1, deleted: 0, failed: 0 });
    expect(fixture.prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { rollbackLastError: 'publisher_queue_temporarily_unavailable' },
      }),
    );
  });

  it('executes a queued rollback only with its persisted Publik origin', async () => {
    const fixture = createFixture();
    fixture.maxClient.deleteMessage.mockImplementation(
      async (
        _chatId: unknown,
        _messageId: unknown,
        options: { beforeImmediateDeleteMutation: () => Promise<void> },
      ) => {
        await options.beforeImmediateDeleteMutation();
      },
    );

    await fixture.service.processPublisherRollbackJob({
      postId: 'publisher-post',
      chatId: 'channel-1',
      messageId: 'publisher-message',
      requiredBotId: 'publisher-bot',
      idempotencyKey: 'rollback-key',
    });

    expect(fixture.maxClient.deleteMessage).toHaveBeenCalledWith(
      'channel-1',
      'publisher-message',
      expect.objectContaining({
        immediate: true,
        botId: 'publisher-bot',
        idempotencyKey: 'vk-parsing:publisher-rollback:rollback-key',
      }),
    );
    expect(fixture.prisma.vkParsingPost.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rollbackQueuedAt: null,
          rollbackLockedAt: null,
          rollbackDeletedAt: expect.any(Date),
          rollbackIdempotencyKey: null,
        }),
      }),
    );
    expect(fixture.health.recordSendSuccess).toHaveBeenCalledWith('channel-1', expect.any(Date));
  });

  it('ignores a rollback job addressed to a different Publisher bot', async () => {
    const fixture = createFixture();

    await fixture.service.processPublisherRollbackJob({
      postId: 'foreign-post',
      chatId: 'channel-1',
      messageId: 'foreign-message',
      requiredBotId: 'other-publisher-bot',
      idempotencyKey: 'foreign-rollback',
    });

    expect(fixture.prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(fixture.runtimeBoundary.assertDispatchEnabled).not.toHaveBeenCalled();
  });
});
