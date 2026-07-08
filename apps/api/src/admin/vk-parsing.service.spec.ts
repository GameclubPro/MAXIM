import { ChatEntityType } from '../prisma/prisma-client';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { VkParsingMediaCacheService } from './vk-parsing-media-cache.service';
import { VkParsingPostImportRepository } from './vk-parsing-post-import.repository';
import { VkParsingAccessService } from './vk-parsing-access.service';
import { VkApiClientService } from './vk-api-client.service';
import { computeVkParsingPostContentHash } from './vk-parsing-content';
import { VkParsingFeedService } from './vk-parsing-feed.service';
import { VkParsingService } from './vk-parsing.service';
import { VkPublishService } from './vk-publish.service';
import { VkSourceService } from './vk-source.service';
import { VkSyncService } from './vk-sync.service';

type MockFetchResponse = {
  ok: boolean;
  status?: number;
  body?: {
    cancel: () => Promise<void>;
  };
  headers?: Headers;
  json?: () => Promise<unknown>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

function createConfig(values: Record<string, unknown> = {}) {
  return {
    get: jest.fn((key: string) => values[key]),
  };
}

function createJsonFetchResponse(payload: unknown): MockFetchResponse {
  return {
    ok: true,
    json: async () => payload,
  };
}

function createMaxApiError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), {
    response: {
      status,
      data: {
        ...(code ? { code } : {}),
        message,
      },
    },
  });
}

function readExecuteRawValues(prisma: { $executeRaw: jest.Mock }): unknown[] {
  return prisma.$executeRaw.mock.calls.flatMap(([query]) => {
    const values = (query as { values?: unknown[] })?.values;
    return Array.isArray(values) ? values : [];
  });
}

describe('VkParsingService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function createFixture(config: Record<string, unknown> = {}) {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({ entityType: ChatEntityType.CHANNEL }),
      },
      vkParsingSource: {
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      vkParsingPost: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({
          _max: { lastSeenAt: null },
          _min: { publishQueuedAt: null },
        }),
      },
      vkParsingSettings: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
      vkParsingMediaCache: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation((payload) =>
          Promise.resolve({
            id: 'media-1',
            url: payload.data.url,
            mediaIdentity: payload.data.mediaIdentity ?? null,
            status: payload.data.status,
            mimeType: payload.data.mimeType ?? null,
            contentLength: payload.data.contentLength ?? null,
            maxUploadPayload: payload.data.maxUploadPayload ?? null,
            maxUploadToken: payload.data.maxUploadToken ?? null,
            maxUploadedAt: payload.data.maxUploadedAt ?? null,
            uploadAttemptCount: payload.data.uploadAttemptCount ?? 0,
            lastCheckedAt: payload.data.lastCheckedAt,
            lastError: payload.data.lastError ?? null,
            createdAt: new Date('2026-05-25T10:00:00.000Z'),
            updatedAt: new Date('2026-05-25T10:00:00.000Z'),
          }),
        ),
        update: jest.fn().mockImplementation((payload) =>
          Promise.resolve({
            id: payload.where.id,
            url: payload.data.url ?? 'https://sun1.example/large.jpg',
            status: payload.data.status,
            mimeType: payload.data.mimeType ?? null,
            contentLength: payload.data.contentLength ?? null,
            mediaIdentity: payload.data.mediaIdentity ?? null,
            maxUploadPayload: payload.data.maxUploadPayload ?? null,
            maxUploadToken: payload.data.maxUploadToken ?? null,
            maxUploadedAt: payload.data.maxUploadedAt ?? null,
            uploadAttemptCount: 1,
            lastCheckedAt: payload.data.lastCheckedAt,
            lastError: payload.data.lastError ?? null,
            createdAt: new Date('2026-05-25T10:00:00.000Z'),
            updatedAt: new Date('2026-05-25T10:00:00.000Z'),
          }),
        ),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
        upsert: jest.fn().mockImplementation((payload) =>
          Promise.resolve({
            id: 'media-1',
            url: payload.create.url,
            mediaIdentity: payload.create.mediaIdentity ?? null,
            status: payload.create.status,
            mimeType: payload.create.mimeType ?? null,
            contentLength: payload.create.contentLength ?? null,
            maxUploadPayload: payload.create.maxUploadPayload ?? null,
            maxUploadToken: payload.create.maxUploadToken ?? null,
            maxUploadedAt: payload.create.maxUploadedAt ?? null,
            uploadAttemptCount: payload.create.uploadAttemptCount ?? 0,
            lastCheckedAt: payload.create.lastCheckedAt,
            lastError: payload.create.lastError ?? null,
            createdAt: new Date('2026-05-25T10:00:00.000Z'),
            updatedAt: new Date('2026-05-25T10:00:00.000Z'),
          }),
        ),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([
        {
          attemptedSources: 0,
          successfulSources: 0,
          circuitOpenSourceCount: 0,
          p95SyncDurationMs: null,
        },
      ]),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((operation: unknown) =>
      typeof operation === 'function'
        ? (operation as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.all(operation as Promise<unknown>[]),
    );
    const adminService = {
      assertChatAdmin: jest.fn().mockResolvedValue(undefined),
      buildChannelPublicationEngagementContext: jest.fn().mockResolvedValue({
        buttons: [],
        threadId: null,
        includeCommentsButton: false,
        includeSuggestButton: false,
        suggestButtonText: null,
        autoPostButtonsMode: 'OFF',
        suggestionEntryMode: 'BOT',
      }),
      recordChannelPublicationEngagement: jest.fn().mockResolvedValue(undefined),
    };
    const maxClient = {
      uploadImage: jest.fn(),
      uploadVideo: jest.fn(),
      sendMessageImmediateWithResolvedLink: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotId: jest.fn().mockResolvedValue('bot-1'),
      resolveBotIdForSend: jest.fn().mockResolvedValue('bot-1'),
      resolveBotIdForModerationAction: jest.fn().mockResolvedValue('bot-1'),
    };
    const vkRateLimitService = {
      reserveVkApiSlot: jest.fn().mockResolvedValue(undefined),
      recordVkApiOutcome: jest.fn().mockResolvedValue(undefined),
      getRecentVkApiMetrics: jest.fn().mockResolvedValue({
        rps: 0,
        errorRate: 0,
        recentErrors: [],
      }),
    };
    const syncQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const publishQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
    };
    const configService = createConfig({
      VK_SERVICE_TOKEN: 'vk-service-token',
      VK_API_BASE_URL: 'https://api.vk.ru',
      VK_API_VERSION: '5.199',
      VK_PARSING_SYNC_INTERVAL_MS: 600_000,
      VK_PARSING_FETCH_COUNT: 100,
      VK_PARSING_MIN_PAGES: 1,
      VK_PARSING_MAX_PAGES: 1,
      VK_PARSING_MISSING_CONFIRMATION_THRESHOLD: 3,
      VK_API_TIMEOUT_MS: 10_000,
      VK_API_MAX_ATTEMPTS: 3,
      VK_PARSING_QUEUE_BATCH_SIZE: 100,
      VK_PARSING_LEASE_TTL_MS: 120_000,
      VK_PARSING_MEDIA_PREFLIGHT_TTL_MS: 86_400_000,
      VK_PARSING_MEDIA_FAILED_PREFLIGHT_TTL_MS: 120_000,
      VK_PARSING_MEDIA_CONCURRENCY: 3,
      ...config,
    });
    const mediaCache = new VkParsingMediaCacheService(prisma as never, configService as never);
    const postImportRepository = new VkParsingPostImportRepository(prisma as never);
    const accessService = new VkParsingAccessService(
      prisma as never,
      adminService as never,
      configService as never,
    );
    const feedService = new VkParsingFeedService(
      prisma as never,
      vkRateLimitService as never,
      configService as never,
    );
    const vkApiClient = new VkApiClientService(configService as never, vkRateLimitService as never);
    const sourceService = new VkSourceService(
      prisma as never,
      feedService,
      vkApiClient,
      syncQueue as never,
      configService as never,
    );
    const publishService = new VkPublishService(
      prisma as never,
      accessService,
      adminService as never,
      maxClient as never,
      maxBotLinkService as never,
      mediaCache,
      feedService,
      publishQueue as never,
      configService as never,
      undefined,
      managedEntityAccessLossService as never,
    );
    const syncService = new VkSyncService(
      prisma as never,
      vkApiClient,
      publishService,
      mediaCache,
      postImportRepository,
      configService as never,
    );

    const service = new VkParsingService(
      prisma as never,
      accessService,
      feedService,
      sourceService,
      syncService,
      publishService,
    );

    return {
      service,
      prisma,
      adminService,
      maxClient,
      maxBotLinkService,
      vkRateLimitService,
      syncQueue,
      publishQueue,
      managedEntityAccessLossService,
      mediaCache,
      postImportRepository,
      accessService,
      feedService,
      vkApiClient,
      sourceService,
      syncService,
      publishService,
    };
  }

  function createSource(overrides: Record<string, unknown> = {}) {
    return {
      id: 'source-1',
      chatId: 'channel-1',
      ownerId: 36819802,
      wallOwnerId: -36819802,
      screenName: 'avto_prodaja_rb',
      title: 'Авторынок Уфа',
      url: 'https://vk.ru/avto_prodaja_rb',
      status: 'ACTIVE',
      importEnabled: true,
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      autoPublishPausedAt: null,
      autoPublishPausedReason: null,
      publishIntervalMinutes: 60,
      dailyLimit: 3,
      minPublishIntervalMinutes: 30,
      publishMode: 'QUEUE',
      priority: 'NORMAL',
      quietHoursStart: null,
      quietHoursEnd: null,
      lastAutoPublishedAt: null,
      syncStatus: 'IDLE',
      nextSyncAt: new Date('2026-05-25T10:00:00.000Z'),
      lastSyncAt: null,
      lastSuccessAt: null,
      syncStartedAt: null,
      syncLockedAt: null,
      syncLockedBy: null,
      syncLockDeadlineAt: null,
      syncHeartbeatAt: null,
      syncAttemptCount: 0,
      consecutiveFailures: 0,
      terminalFailureCount: 0,
      circuitOpenedAt: null,
      circuitReasonCode: null,
      circuitReason: null,
      circuitRetryAt: null,
      lastErrorCode: null,
      lastImportedCount: 0,
      lastFetchedCount: 0,
      lastFetchedPages: 0,
      lastFetchedOffsets: [],
      lastVkNewestPostId: null,
      lastVkNewestPublishedAt: null,
      adaptiveIntervalMs: null,
      lastSyncDurationMs: null,
      lastError: null,
      createdByUserId: '183470701',
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      ...overrides,
    };
  }

  function createQueueJob(state: string) {
    return {
      getState: jest.fn().mockResolvedValue(state),
      updateData: jest.fn().mockResolvedValue(undefined),
      retry: jest.fn().mockResolvedValue(undefined),
    };
  }

  function createPostRow(overrides: Record<string, unknown> = {}) {
    const source =
      (overrides.source as ReturnType<typeof createSource> | undefined) ?? createSource();
    return {
      id: 'post-1',
      sourceId: source.id,
      chatId: source.chatId,
      vkOwnerId: -36819802,
      vkPostId: 101,
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
      text: 'Продам авто',
      url: 'https://vk.ru/wall-36819802_101',
      photoUrls: [],
      videoUrls: [],
      linkUrls: [],
      attachments: [],
      attachmentTypes: [],
      unsupportedAttachments: [],
      hasUnsupportedAttachments: false,
      isAdvertising: false,
      advertisingMarkers: [],
      raw: {},
      contentHash: 'content-hash',
      publishedContentHash: null,
      status: 'NEW',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAtMax: null,
      autoPublishedAt: null,
      autoPublishError: null,
      skippedAt: null,
      skipReason: null,
      lastSeenAt: new Date('2026-05-25T10:00:00.000Z'),
      missingSinceAt: null,
      missingSeenCount: 0,
      lastAvailabilityCheckedAt: new Date('2026-05-25T10:00:00.000Z'),
      unavailableAt: null,
      publishQueuedAt: null,
      publishScheduledAt: null,
      publishCancelledAt: null,
      publishCancelledByUserId: null,
      publishLockedAt: null,
      publishAttemptCount: 0,
      publishIdempotencyKey: null,
      publishReason: null,
      lastError: null,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      source,
      ...overrides,
    };
  }

  it('pauses VK autopublish when the background governor is unavailable', async () => {
    const { publishService } = createFixture();
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockRejectedValue(new Error('timeout exceeded when trying to connect')),
    };
    const testPublishService = publishService as unknown as {
      backgroundRuntimeGovernorService?: unknown;
      decideBackgroundAutoPublish: () => Promise<unknown>;
    };
    testPublishService.backgroundRuntimeGovernorService = backgroundRuntimeGovernorService;

    await expect(testPublishService.decideBackgroundAutoPublish()).resolves.toEqual({
      action: 'pause',
      retryAfterMs: 180_000,
      reason: 'background governor unavailable',
    });
    expect(backgroundRuntimeGovernorService.decide).toHaveBeenCalledWith({
      component: 'vk_parsing_autopublish',
      sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
    });
  });

  it('allows any channel admin to use VK parsing', async () => {
    const { service, adminService } = createFixture();

    await expect(
      service.listVkParsing('channel-1', { userId: 'not-allowlisted' } as never),
    ).resolves.toMatchObject({
      capabilities: { enabled: true, canUse: true },
    });
    expect(adminService.assertChatAdmin).toHaveBeenCalledWith(
      'channel-1',
      'not-allowlisted',
      'channel',
    );
  });

  it('reports VK parsing as not configured to channel admins when the VK token is missing', async () => {
    const { service, adminService } = createFixture({ VK_SERVICE_TOKEN: '' });

    await expect(
      service.getCapability('channel-1', { userId: 'channel-admin' } as never),
    ).resolves.toEqual({
      enabled: false,
      canUse: false,
      reasonCode: 'NOT_CONFIGURED',
      reason: 'VK_SERVICE_TOKEN не настроен на сервере.',
    });
    expect(adminService.assertChatAdmin).toHaveBeenCalledWith(
      'channel-1',
      'channel-admin',
      'channel',
    );
  });

  it('does not expose VK token configuration to users without admin access', async () => {
    const { service, adminService } = createFixture({ VK_SERVICE_TOKEN: '' });
    adminService.assertChatAdmin.mockRejectedValue(new Error('not admin'));

    await expect(
      service.getCapability('channel-1', { userId: 'guest' } as never),
    ).resolves.toEqual({
      enabled: true,
      canUse: false,
      reasonCode: 'ACCESS_DENIED',
      reason: 'Недостаточно прав администратора.',
    });
  });

  it('fails VK parsing operations early when the VK token is missing', async () => {
    const { service } = createFixture({ VK_SERVICE_TOKEN: '' });

    await expect(
      service.listVkParsing('channel-1', { userId: 'channel-admin' } as never),
    ).rejects.toThrow('VK_SERVICE_TOKEN не настроен на сервере.');
  });

  it('allows chat admins to use VK parsing in chats', async () => {
    const { service, prisma, adminService } = createFixture();
    prisma.chat.findUnique.mockResolvedValue({ entityType: ChatEntityType.CHAT });

    await expect(
      service.listVkParsing('chat-1', { userId: 'chat-admin' } as never),
    ).resolves.toMatchObject({
      capabilities: { enabled: true, canUse: true },
    });
    expect(adminService.assertChatAdmin).toHaveBeenCalledWith('chat-1', 'chat-admin', 'chat');
  });

  it('exposes source retry and stale sync lock metrics in the feed', async () => {
    const { service, prisma } = createFixture();
    const retryAt = new Date('2026-05-25T10:30:00.000Z');
    prisma.vkParsingSource.findMany.mockResolvedValue([
      createSource({
        syncStatus: 'BACKOFF',
        nextSyncAt: retryAt,
        terminalFailureCount: 1,
        circuitRetryAt: retryAt,
      }),
    ]);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    prisma.vkParsingSource.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        attemptedSources: 2,
        successfulSources: 1,
        circuitOpenSourceCount: 1,
        p95SyncDurationMs: 1500,
      },
    ]);

    const feed = await service.listVkParsing('channel-1', { userId: '183470701' } as never);

    expect(feed.sources[0]).toMatchObject({
      syncStatus: 'BACKOFF',
      nextRetryAt: retryAt.toISOString(),
      terminalFailureCount: 1,
      circuitRetryAt: retryAt.toISOString(),
    });
    expect(feed.summary?.staleSyncLockCount).toBe(2);
    expect(feed.summary).toMatchObject({
      circuitOpenSourceCount: 1,
      importSuccessRate: 0.5,
      p95SyncDurationMs: 1500,
    });
  });

  it('updates VK parsing automation settings for a channel', async () => {
    const { service, prisma } = createFixture();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T10:01:00.000Z'),
      stripLinksEnabled: true,
      skipAdsEnabled: true,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:05:00.000Z'),
    });

    const feed = await service.updateSettings('channel-1', { userId: '183470701' } as never, {
      autoPublishEnabled: true,
      stripLinksEnabled: true,
      skipAdsEnabled: true,
    });

    expect(prisma.vkParsingSettings.upsert).toHaveBeenCalledWith({
      where: { chatId: 'channel-1' },
      create: expect.objectContaining({
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T10:01:00.000Z'),
        stripLinksEnabled: true,
        skipAdsEnabled: true,
        autoPublishKillSwitchEnabled: false,
        workHoursStart: '09:00',
        workHoursEnd: '22:00',
      }),
      update: {
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T10:01:00.000Z'),
        stripLinksEnabled: true,
        skipAdsEnabled: true,
      },
    });
    expect(feed.settings).toMatchObject({
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: '2026-05-25T10:01:00.000Z',
      stripLinksEnabled: true,
      skipAdsEnabled: true,
      autoPublishKillSwitchEnabled: false,
      updatedAt: '2026-05-25T10:05:00.000Z',
    });
  });

  it('clears queued VK autopublish state when autoposting is disabled', async () => {
    const { service, prisma } = createFixture();
    prisma.vkParsingSettings.findUnique
      .mockResolvedValueOnce({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T10:01:00.000Z'),
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:05:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:06:00.000Z'),
      });

    await service.updateSettings('channel-1', { userId: '183470701' } as never, {
      autoPublishEnabled: false,
    });

    expect(prisma.vkParsingSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          autoPublishEnabled: false,
          autoPublishEnabledAt: null,
        },
      }),
    );
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'channel-1',
          status: { in: ['NEW', 'FAILED'] },
        }),
        data: {
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishScheduledAt: null,
        },
      }),
    );
  });

  it('clears queued VK autopublish state when a source is switched to review mode', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findFirst.mockResolvedValue(source);

    await service.updateSource('channel-1', 'source-1', { userId: '183470701' } as never, {
      publishMode: 'REVIEW',
    });

    expect(prisma.vkParsingSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'source-1' },
        data: expect.objectContaining({
          publishMode: 'REVIEW',
        }),
      }),
    );
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'channel-1',
          sourceId: { in: ['source-1'] },
          status: { in: ['NEW', 'FAILED'] },
        }),
        data: expect.objectContaining({
          publishQueuedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
        }),
      }),
    );
  });

  it('adds a VK source from the wall owner, not the first extended group', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          groups: [
            { id: 1, screen_name: 'unrelated_group', name: 'Чужая группа' },
            { id: 36819802, screen_name: 'avto_prodaja_rb', name: 'Авторынок Уфа' },
          ],
          items: [{ owner_id: -36819802, id: 101, date: 1_779_708_000, text: 'Пост' }],
        },
      }),
    ) as unknown as typeof fetch;
    prisma.vkParsingSource.upsert.mockResolvedValue(source);

    await service.addSource('channel-1', { userId: '183470701' } as never, {
      url: 'https://vk.com/avto_prodaja_rb',
    });

    expect(prisma.vkParsingSource.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_wallOwnerId: {
            chatId: 'channel-1',
            wallOwnerId: -36819802,
          },
        },
        create: expect.objectContaining({
          ownerId: 36819802,
          wallOwnerId: -36819802,
          screenName: 'avto_prodaja_rb',
          title: 'Авторынок Уфа',
          url: 'https://vk.ru/avto_prodaja_rb',
        }),
        update: expect.objectContaining({
          ownerId: 36819802,
          screenName: 'avto_prodaja_rb',
          title: 'Авторынок Уфа',
          url: 'https://vk.ru/avto_prodaja_rb',
        }),
      }),
    );
  });

  it('keeps the requested VK source when extended groups omit the wall owner', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          groups: [{ id: 1, screen_name: 'unrelated_group', name: 'Чужая группа' }],
          items: [{ owner_id: -36819802, id: 101, date: 1_779_708_000, text: 'Пост' }],
        },
      }),
    ) as unknown as typeof fetch;
    prisma.vkParsingSource.upsert.mockResolvedValue(source);

    await service.addSource('channel-1', { userId: '183470701' } as never, {
      url: 'https://vk.com/avto_prodaja_rb',
    });

    expect(prisma.vkParsingSource.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_wallOwnerId: {
            chatId: 'channel-1',
            wallOwnerId: -36819802,
          },
        },
        create: expect.objectContaining({
          ownerId: 36819802,
          wallOwnerId: -36819802,
          screenName: 'avto_prodaja_rb',
          title: 'avto_prodaja_rb',
          url: 'https://vk.ru/avto_prodaja_rb',
        }),
        update: expect.objectContaining({
          ownerId: 36819802,
          screenName: 'avto_prodaja_rb',
          title: 'avto_prodaja_rb',
          url: 'https://vk.ru/avto_prodaja_rb',
        }),
      }),
    );
  });

  it('rejects malformed VK source links as bad requests', async () => {
    const { service } = createFixture();

    await expect(
      service.addSource('channel-1', { userId: '183470701' } as never, {
        url: 'https://',
      }),
    ).rejects.toThrow('Некорректная ссылка на VK-сообщество.');
  });

  it('does not reset an active VK source sync lease on manual refresh', async () => {
    const { service, prisma, syncQueue } = createFixture();
    const source = createSource({
      syncStatus: 'SYNCING',
      syncLockedAt: new Date('2026-05-25T10:00:00.000Z'),
      syncLockedBy: 'worker-1',
      syncLockDeadlineAt: new Date(Date.now() + 60_000),
      syncHeartbeatAt: new Date('2026-05-25T10:00:15.000Z'),
    });
    prisma.vkParsingSource.findFirst.mockResolvedValue(source);
    prisma.vkParsingSource.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await service.refreshSource('channel-1', 'source-1', {
      userId: '183470701',
    } as never);

    expect(result.queued).toBe(0);
    expect(syncQueue.add).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'source-1',
          OR: expect.arrayContaining([
            expect.objectContaining({
              syncStatus: 'SYNCING',
            }),
          ]),
        }),
      }),
    );
  });

  it('recovers an existing failed VK source sync job instead of leaving it failed', async () => {
    const { service, prisma, syncQueue } = createFixture();
    const source = createSource({
      syncStatus: 'QUEUED',
      updatedAt: new Date('2026-05-25T09:55:00.000Z'),
    });
    const failedJob = createQueueJob('failed');
    prisma.vkParsingSource.findFirst.mockResolvedValue(source);
    prisma.vkParsingSource.updateMany.mockResolvedValueOnce({ count: 1 });
    syncQueue.getJob.mockResolvedValueOnce(failedJob);

    const result = await service.refreshSource('channel-1', 'source-1', {
      userId: '183470701',
    } as never);

    expect(result.queued).toBe(1);
    expect(syncQueue.getJob).toHaveBeenCalledWith('vk-parsing-sync__source-1');
    expect(failedJob.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-1',
        reason: 'manual',
        retryPolicyName: 'vk-parsing-sync',
      }),
    );
    expect(failedJob.retry).toHaveBeenCalledWith('failed', {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    expect(syncQueue.add).not.toHaveBeenCalled();
  });

  it('imports text, direct VK videos and links from a public VK community', async () => {
    const { service, prisma, syncQueue } = createFixture();
    const source = createSource();
    const videoUrl = 'https://vkvd.example/video-720.mp4';
    const wallPayload = {
      response: {
        groups: [{ id: 36819802, screen_name: 'avto_prodaja_rb', name: 'Авторынок Уфа' }],
        items: [
          {
            owner_id: -36819802,
            id: 101,
            date: 1_779_708_000,
            text: 'Продам авто',
            attachments: [
              {
                type: 'photo',
                photo: {
                  sizes: [
                    { width: 320, height: 240, url: 'https://sun1.example/small.jpg' },
                    { width: 1280, height: 960, url: 'https://sun1.example/large.jpg' },
                  ],
                },
              },
              {
                type: 'link',
                link: { url: 'https://example.com/car' },
              },
              {
                type: 'video',
                video: {
                  id: 42,
                  owner_id: -36819802,
                  title: 'Видеообзор',
                  files: {
                    external: 'https://vk.com/video_ext.php?oid=-36819802&id=42',
                    hls: 'https://vkvd.example/video.m3u8',
                    mp4_360: 'https://vkvd.example/video-360.mp4',
                    mp4_720: videoUrl,
                  },
                },
              },
            ],
          },
        ],
      },
    };
    global.fetch = jest
      .fn()
      .mockResolvedValue(createJsonFetchResponse(wallPayload)) as unknown as typeof fetch;
    prisma.vkParsingSource.upsert.mockResolvedValue(source);
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    prisma.vkParsingSource.findMany.mockResolvedValue([source]);

    await service.addSource('channel-1', { userId: '183470701' } as never, {
      url: 'https://vk.ru/avto_prodaja_rb',
    });
    expect(syncQueue.add).toHaveBeenCalledWith(
      'sync-vk-source',
      expect.objectContaining({
        sourceId: 'source-1',
        reason: 'source-added',
        retryPolicyName: 'vk-parsing-sync',
      }),
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnFail: 500,
      }),
    );
    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const rawValues = readExecuteRawValues(prisma);
    expect(rawValues).toContain('Продам авто');
    expect(rawValues).toContain(JSON.stringify([]));
    expect(rawValues).toContain(JSON.stringify([videoUrl]));
    expect(rawValues).toContain(JSON.stringify(['https://example.com/car']));
    expect(rawValues).not.toContain(JSON.stringify(['https://vk.com/video_ext.php?oid=-36819802&id=42']));
  });

  it('hydrates VK video attachments through video.get when wall.get omits direct files', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    const videoUrl = 'https://vkvd.example/video-720.mp4';
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [
              {
                owner_id: -36819802,
                id: 103,
                date: 1_779_708_000,
                text: '',
                attachments: [
                  {
                    type: 'video',
                    video: {
                      id: 42,
                      owner_id: -36819802,
                      access_key: 'video-key',
                      title: 'Видеообзор',
                      duration: 12,
                    },
                  },
                ],
              },
            ],
            groups: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            count: 1,
            items: [
              {
                id: 42,
                owner_id: -36819802,
                access_key: 'video-key',
                title: 'Видеообзор',
                duration: 12,
                files: {
                  external: 'https://vk.com/video_ext.php?oid=-36819802&id=42',
                  hls: 'https://vkvd.example/video.m3u8',
                  mp4_360: 'https://vkvd.example/video-360.mp4',
                  mp4_720: videoUrl,
                },
              },
            ],
          },
        }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/method/video.get?'),
      expect.any(Object),
    );
    expect(decodeURIComponent(String((global.fetch as jest.Mock).mock.calls[1][0]))).toContain(
      'videos=-36819802_42_video-key',
    );
    const rawValues = readExecuteRawValues(prisma);
    expect(rawValues).toContain(JSON.stringify([videoUrl]));
    expect(rawValues).toContain(JSON.stringify([]));
    expect(rawValues).not.toContain('Нет прямого HTTPS-файла видео');
  });

  it('keeps a VK post link for short videos when VK does not provide direct files', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [
              {
                owner_id: -36819802,
                id: 104,
                date: 1_779_708_000,
                text: '',
                attachments: [
                  {
                    type: 'video',
                    video: {
                      id: 42,
                      owner_id: -36819802,
                      access_key: 'video-key',
                      title: 'Clip from СПОРТ ИНСАЙДЕР',
                      type: 'short_video',
                      duration: 16,
                    },
                  },
                ],
              },
            ],
            groups: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            count: 1,
            items: [
              {
                id: 42,
                owner_id: -36819802,
                access_key: 'video-key',
                title: 'Clip from СПОРТ ИНСАЙДЕР',
                type: 'short_video',
                duration: 16,
                image: [{ url: 'https://iv.okcdn.ru/getVideoPreview?id=1', width: 720 }],
                first_frame: [{ url: 'https://iv.okcdn.ru/getVideoPreview?id=1', width: 720 }],
              },
            ],
          },
        }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    const rawValues = readExecuteRawValues(prisma);
    expect(rawValues).toContain(JSON.stringify([]));
    expect(rawValues).toContain(JSON.stringify(['https://vk.ru/wall-36819802_104']));
    const parsedJsonValues = rawValues
      .filter((value): value is string => typeof value === 'string')
      .map((value) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return null;
        }
      });
    expect(parsedJsonValues).toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'video',
          reason: 'Нет прямого HTTPS-файла видео',
        }),
      ]),
    );
  });

  it('ignores wall posts whose owner does not match the source owner', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            { owner_id: -1, id: 1, date: 1_779_707_999, text: 'Чужой пост' },
            { owner_id: -36819802, id: 101, date: 1_779_708_000, text: 'Наш пост' },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const rawValues = readExecuteRawValues(prisma);
    expect(rawValues).toContain('Наш пост');
    expect(rawValues).not.toContain('Чужой пост');
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1', syncLockedBy: expect.any(String) }),
        data: expect.objectContaining({
          lastFetchedCount: 1,
        }),
      }),
    );
  });

  it('imports modern VK attachment facts from src photos, copy history, ads and unsupported types', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 102,
              date: 1_779_708_000,
              text: 'Рекламный материал ERID abc123',
              marked_as_ads: 1,
              attachments: [
                {
                  type: 'photo',
                  photo: {
                    id: 11,
                    owner_id: -36819802,
                    sizes: [{ width: 640, height: 480, src: 'https://sun2.example/src.jpg' }],
                  },
                },
                { type: 'photos_list', photos_list: ['-36819802_12', '-36819802_13'] },
                { type: 'video', video: { title: 'Видеообзор' } },
                { type: 'doc', doc: { title: 'Прайс.pdf', url: 'https://vk.ru/doc.pdf' } },
                { type: 'poll', poll: { question: 'Брать?' } },
                { type: 'article', article: { title: 'Разбор', url: 'https://vk.ru/@club-post' } },
              ],
              copy_history: [
                {
                  owner_id: -1,
                  id: 1,
                  text: 'Текст репоста',
                  attachments: [{ type: 'link', link: { url: 'https://example.com/from-copy' } }],
                },
              ],
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    const rawValues = readExecuteRawValues(prisma);
    expect(rawValues).toContain(JSON.stringify(['https://sun2.example/src.jpg']));
    expect(rawValues).toContain(JSON.stringify(['https://example.com/from-copy']));
    const parsedJsonValues = rawValues
      .filter((value): value is string => typeof value === 'string')
      .map((value) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return null;
        }
      });
    const attachmentTypes = parsedJsonValues.find(
      (value): value is string[] =>
        Array.isArray(value) && value.includes('photos_list') && value.includes('link'),
    );
    expect(attachmentTypes).toEqual(
      expect.arrayContaining(['photo', 'photos_list', 'video', 'doc', 'poll', 'article', 'link']),
    );
    const unsupportedAttachments = parsedJsonValues.find(
      (value): value is Array<{ type: string }> =>
        Array.isArray(value) &&
        value.some((item) => item?.type === 'photos_list') &&
        value.some((item) => item?.type === 'copy_history'),
    );
    expect(unsupportedAttachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'photos_list' }),
        expect.objectContaining({ type: 'video', title: 'Видеообзор' }),
        expect.objectContaining({ type: 'doc', title: 'Прайс.pdf' }),
        expect.objectContaining({ type: 'poll', title: 'Брать?' }),
        expect.objectContaining({ type: 'article', title: 'Разбор' }),
        expect.objectContaining({ type: 'copy_history' }),
      ]),
    );
    expect(rawValues).toContain(true);
    const advertisingMarkers = parsedJsonValues.find(
      (value): value is string[] => Array.isArray(value) && value.includes('VK marked_as_ads'),
    );
    expect(advertisingMarkers).toEqual(expect.arrayContaining(['VK marked_as_ads']));
  });

  it('does not preflight media for the initial source-added backfill', async () => {
    const { service, prisma, mediaCache } = createFixture();
    const source = createSource();
    const preflightSpy = jest.spyOn(mediaCache, 'preflightMediaUrl');
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Фото из начального бэкфилла',
              attachments: [
                {
                  type: 'photo',
                  photo: {
                    id: 1,
                    owner_id: -36819802,
                    access_key: 'photo-key',
                    sizes: [
                      {
                        url: 'https://sun1.example/backfill.jpg',
                        width: 1280,
                        height: 720,
                      },
                    ],
                  },
                },
              ],
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'source-added');

    expect(preflightSpy).not.toHaveBeenCalled();
  });

  it('skips media preflight for unchanged scheduled posts', async () => {
    const { service, prisma, mediaCache } = createFixture();
    const source = createSource({ lastSuccessAt: new Date('2026-05-25T09:00:00.000Z') });
    const photoUrl = 'https://sun1.example/unchanged.jpg';
    const contentHash = computeVkParsingPostContentHash({
      text: 'Без изменений',
      photoUrls: [photoUrl],
      linkUrls: [],
      attachmentTypes: ['photo'],
    });
    const preflightSpy = jest.spyOn(mediaCache, 'preflightMediaUrl');
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([
        {
          id: 'post-1',
          vkOwnerId: -36819802,
          vkPostId: 101,
          status: 'NEW',
          contentHash,
          publishedContentHash: null,
        },
      ])
      .mockResolvedValueOnce([]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Без изменений',
              attachments: [
                {
                  type: 'photo',
                  photo: {
                    id: 1,
                    owner_id: -36819802,
                    access_key: 'photo-key',
                    sizes: [{ url: photoUrl, width: 1280, height: 720 }],
                  },
                },
              ],
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(preflightSpy).not.toHaveBeenCalled();
  });

  it('uses VK API 5.199 and overlap pagination offsets for scheduled sync', async () => {
    const { service, prisma } = createFixture({
      VK_PARSING_FETCH_COUNT: 2,
      VK_PARSING_MIN_PAGES: 3,
      VK_PARSING_MAX_PAGES: 3,
    });
    const source = createSource({ lastSuccessAt: new Date('2026-05-25T09:00:00.000Z') });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [
              { owner_id: -36819802, id: 103, date: 1_779_708_003, text: 'Пост 103' },
              { owner_id: -36819802, id: 102, date: 1_779_708_002, text: 'Пост 102' },
            ],
            groups: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [
              { owner_id: -36819802, id: 101, date: 1_779_708_001, text: 'Пост 101' },
              { owner_id: -36819802, id: 100, date: 1_779_708_000, text: 'Пост 100' },
            ],
            groups: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [{ owner_id: -36819802, id: 99, date: 1_779_707_999, text: 'Пост 99' }],
            groups: [],
          },
        }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    const requestedUrls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(requestedUrls[0]).toContain('v=5.199');
    expect(requestedUrls[0]).not.toContain('offset=');
    expect(requestedUrls[1]).toContain('offset=2');
    expect(requestedUrls[2]).toContain('offset=4');
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastFetchedPages: 3,
          lastFetchedOffsets: [0, 2, 4],
          adaptiveIntervalMs: expect.any(Number),
        }),
      }),
    );
  });

  it('queues newly imported scheduled VK posts for background publish', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const source = createSource({ lastSuccessAt: new Date('2026-05-25T09:30:00.000Z') });
    const post = createPostRow({
      source,
      text: 'Продам авто https://example.com\nvk.com/club',
      linkUrls: ['https://example.com/car'],
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([post]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: true,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Продам авто https://example.com\nvk.com/club',
              attachments: [{ type: 'link', link: { url: 'https://example.com/car' } }],
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          publishQueuedAt: expect.any(Date),
          publishIdempotencyKey: expect.any(String),
          publishReason: 'autopublish',
        }),
      }),
    );
    expect(publishQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        retryPolicyName: 'vk-parsing-publish',
      }),
      expect.objectContaining({
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnFail: 1000,
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('does not queue newly imported VK posts while source autopublish is paused', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource({
      lastSuccessAt: new Date('2026-05-25T09:30:00.000Z'),
      autoPublishPausedAt: new Date('2026-05-25T09:45:00.000Z'),
      autoPublishPausedReason: 'max.access_lost',
    });
    const post = createPostRow({
      source,
      text: 'Пост из остановленного источника',
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([post]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Пост из остановленного источника',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          publishQueuedAt: expect.any(Date),
        }),
      }),
    );
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('does not queue newly imported VK posts published before autopublish was enabled', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource({ lastSuccessAt: new Date('2026-05-25T09:30:00.000Z') });
    const post = createPostRow({
      source,
      text: 'Старый пост из свежего импорта',
      createdAt: new Date('2026-05-25T12:10:00.000Z'),
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([post]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T12:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T12:00:00.000Z'),
    });
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Старый пост из свежего импорта',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
      }),
    );
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('does not queue newly imported VK posts without a VK publish date', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource({ lastSuccessAt: new Date('2026-05-25T09:30:00.000Z') });
    const post = createPostRow({
      source,
      text: 'Пост без даты VK',
      createdAt: new Date('2026-05-25T12:10:00.000Z'),
      vkPublishedAt: null,
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([post]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T12:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T12:00:00.000Z'),
    });
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              text: 'Пост без даты VK',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
      }),
    );
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('recovers legacy stale autopublish rows by re-adding publish jobs', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      publishQueuedAt: new Date('2026-05-25T10:01:00.000Z'),
      publishLockedAt: new Date('2026-05-25T10:01:05.000Z'),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: null,
    });
    prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });

    await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

    expect(publishQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      }),
      expect.objectContaining({
        jobId: 'vk-parsing-publish__post-1__publish-key-1',
        attempts: 5,
      }),
    );
  });

  it('recovers overdue VK publish jobs before scanning future delayed jobs', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture({
        VK_PARSING_QUEUE_BATCH_SIZE: 1,
      });
      const source = createSource();
      const duePost = createPostRow({
        source,
        id: 'post-due',
        publishQueuedAt: new Date('2026-05-25T10:01:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T11:55:00.000Z'),
        publishLockedAt: new Date('2026-05-25T10:01:05.000Z'),
        publishIdempotencyKey: 'publish-key-due',
        publishReason: 'autopublish',
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([duePost]);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      });

      await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

      expect(prisma.vkParsingPost.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.vkParsingPost.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: [
              {
                OR: [
                  { publishScheduledAt: null },
                  { publishScheduledAt: { lte: new Date('2026-05-25T12:00:00.000Z') } },
                ],
              },
            ],
          }),
          orderBy: [
            { publishScheduledAt: 'asc' },
            { publishQueuedAt: 'asc' },
            { updatedAt: 'asc' },
          ],
          take: 1,
        }),
      );
      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({
          postId: 'post-due',
          idempotencyKey: 'publish-key-due',
        }),
        expect.objectContaining({
          delay: 0,
          jobId: 'vk-parsing-publish__post-due__publish-key-due',
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers an existing failed VK publish job instead of re-adding a duplicate jobId', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      publishQueuedAt: new Date('2026-05-25T10:01:00.000Z'),
      publishLockedAt: new Date('2026-05-25T10:01:05.000Z'),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'autopublish',
    });
    const failedJob = createQueueJob('failed');
    prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    publishQueue.getJob.mockResolvedValueOnce(failedJob);

    await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

    expect(publishQueue.getJob).toHaveBeenCalledWith(
      'vk-parsing-publish__post-1__publish-key-1',
    );
    expect(failedJob.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
        retryPolicyName: 'vk-parsing-publish',
      }),
    );
    expect(failedJob.retry).toHaveBeenCalledWith('failed', {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('recovers stale manual retry rows without the autopublish eligibility gate', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      publishQueuedAt: new Date('2026-05-25T10:01:00.000Z'),
      publishLockedAt: new Date('2026-05-25T10:01:05.000Z'),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'manual-retry',
    });
    prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: false,
      autoPublishEnabledAt: null,
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });

    await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

    expect(publishQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({
        reason: 'manual-retry',
        idempotencyKey: 'publish-key-1',
      }),
      expect.any(Object),
    );
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ publishIdempotencyKey: null }),
      }),
    );
  });

  it('clears stale autopublish rows that no longer pass the enable baseline', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      publishQueuedAt: new Date('2026-05-25T10:01:00.000Z'),
      publishLockedAt: new Date('2026-05-25T10:01:05.000Z'),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'autopublish',
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T10:05:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:05:00.000Z'),
    });

    await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

    expect(publishQueue.add).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'post-1', publishIdempotencyKey: 'publish-key-1' },
        data: {
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishScheduledAt: null,
        },
      }),
    );
  });

  it('publishes queued scheduled VK posts with link filtering enabled', async () => {
    const { service, prisma, maxClient, adminService } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      text: 'Продам авто https://example.com\nvk.com/club',
      linkUrls: ['https://example.com/car'],
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: true,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      autoPublishedAt: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Продам авто',
      expect.any(Object),
      {
        botId: 'bot-1',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'PUBLISHED',
          autoPublishedAt: expect.any(Date),
          autoPublishError: null,
          publishQueuedAt: null,
          publishReason: null,
        }),
      }),
    );
    expect(adminService.recordChannelPublicationEngagement).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'vk-parsing-autopost',
        source: 'vk_parsing',
      }),
    );
  });

  it('records MAX access loss and clears VK publish queue when a target chat is denied', async () => {
    const { service, prisma, maxClient, publishQueue, managedEntityAccessLossService } =
      createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      publishQueuedAt: new Date('2026-05-25T09:59:00.000Z'),
      publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'autopublish',
    });
    const error = createMaxApiError(
      403,
      'Request failed with status code 403',
      'chat.denied',
    );
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    managedEntityAccessLossService.recordIfManagedEntityAccessLost.mockResolvedValue({
      classification: {
        kind: 'managed_entity_access_lost',
        reason: 'bot_denied',
        statusCode: 403,
        code: 'chat.denied',
        message: 'request failed with status code 403',
      },
      reason: 'bot_denied',
      recorded: {
        chatId: 'channel-1',
        botId: 'bot-1',
        nextOwnerBotId: null,
        updatedAccessEdges: 1,
        cleanup: {
          nightModeJobsCleared: false,
          canceledBroadcasts: 0,
          canceledBroadcastDeliveries: 0,
          canceledBroadcastOccurrences: 0,
          clearedVkPublishPosts: 1,
          pausedVkSources: 1,
          removedRosterSyncJobs: 0,
        },
      },
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(error);

    await expect(
      service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      }),
    ).rejects.toBe(error);

    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'channel-1',
      botId: 'bot-1',
      entityType: ChatEntityType.CHANNEL,
      source: 'vk_parsing:publish',
      operation: 'send',
      error,
    });
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'FAILED',
          publishQueuedAt: null,
          publishScheduledAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishLockedAt: null,
        }),
      }),
    );
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('quarantines autopublish after an ambiguous MAX send timeout', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      publishQueuedAt: new Date('2026-05-25T09:59:00.000Z'),
      publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'autopublish',
    });
    const timeoutError = new Error('request timed out before response body arrived');
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValueOnce(post).mockResolvedValueOnce(null);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(timeoutError);

    await expect(
      service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      }),
    ).rejects.toBe(timeoutError);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'FAILED',
          lastError: expect.stringContaining('[max.send_ambiguous]'),
          autoPublishError: expect.stringContaining('manual verification'),
          publishQueuedAt: null,
          publishScheduledAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishLockedAt: null,
        }),
      }),
    );

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('quarantines Safety Desk manual publish after an ambiguous MAX send timeout', async () => {
    const { publishService, prisma, maxClient } = createFixture();
    const source = createSource({ publishMode: 'REVIEW' });
    const post = createPostRow({
      source,
      text: 'Материал Safety Desk',
      photoUrls: [],
      linkUrls: [],
    });
    const timeoutError = new Error('request timed out before response body arrived');
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(timeoutError);

    await expect(
      publishService.publishPost('channel-1', 'post-1', 'safety-desk-owner', {
        text: 'Материал Safety Desk',
        photoUrls: [],
        linkUrls: [],
      }),
    ).rejects.toBe(timeoutError);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(prisma.vkParsingPost.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'FAILED',
          lastError: expect.stringContaining('[max.send_ambiguous]'),
          publishQueuedAt: null,
          publishScheduledAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishLockedAt: null,
        }),
      }),
    );
    const failureData = prisma.vkParsingPost.updateMany.mock.calls.at(-1)?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(failureData.lastError).toEqual(
      expect.stringContaining('Safety Desk retry is blocked'),
    );
  });

  it('defers VK autopublish jobs while the runtime governor reports pressure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    try {
      const { service, prisma, maxClient, publishQueue, publishService } = createFixture();
      const source = createSource();
      const post = createPostRow({
        source,
        publishQueuedAt: new Date('2026-05-25T09:59:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
        publishIdempotencyKey: 'publish-key-1',
        publishReason: 'autopublish',
      });
      const governor = {
        decide: jest.fn().mockResolvedValue({
          action: 'pause',
          retryAfterMs: 60_000,
          reason: 'runtime pressure',
        }),
      };
      (
        publishService as unknown as {
          backgroundRuntimeGovernorService: typeof governor;
        }
      ).backgroundRuntimeGovernorService = governor;
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);

      await service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      });

      expect(governor.decide).toHaveBeenCalledWith({
        component: 'vk_parsing_autopublish',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      });
      expect(prisma.vkParsingSettings.findUnique).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
      expect(prisma.vkParsingPost.updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { id: 'post-1', publishIdempotencyKey: 'publish-key-1' },
          data: expect.objectContaining({
            publishScheduledAt: new Date('2026-05-25T10:01:00.000Z'),
            publishLockedAt: null,
            publishReason: 'autopublish',
          }),
        }),
      );
      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({
          postId: 'post-1',
          chatId: 'channel-1',
          reason: 'autopublish',
          retryPolicyName: 'vk-parsing-publish',
        }),
        expect.objectContaining({
          delay: 60_000,
          attempts: 5,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('continues VK autopublish jobs while the runtime governor only asks to slow down', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    try {
      const { service, prisma, maxClient, publishQueue, publishService } = createFixture();
      const source = createSource();
      const post = createPostRow({
        source,
        publishQueuedAt: new Date('2026-05-25T09:59:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
        publishIdempotencyKey: 'publish-key-1',
        publishReason: 'autopublish',
      });
      const governor = {
        decide: jest.fn().mockResolvedValue({
          action: 'slow',
          retryAfterMs: 60_000,
          reason: 'background share 92%',
        }),
      };
      (
        publishService as unknown as {
          backgroundRuntimeGovernorService: typeof governor;
        }
      ).backgroundRuntimeGovernorService = governor;
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        autoPublishKillSwitchEnabled: false,
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        schedulerTimezone: 'Europe/Moscow',
        quietHoursStart: null,
        quietHoursEnd: null,
        workHoursStart: '09:00',
        workHoursEnd: '22:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: true,
        circuitBreakerEnabled: true,
        circuitBreakerWindowMinutes: 10,
        circuitBreakerPostLimit: 10,
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      });
      prisma.vkParsingPost.update.mockResolvedValue({
        ...post,
        status: 'PUBLISHED',
        publishedMessageId: 'mid-1',
        publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
        publishedAtMax: new Date('2026-05-25T10:00:00.000Z'),
        autoPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
      });
      maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
        messageId: 'mid-1',
        url: 'https://max.ru/channels/channel-1/message/mid-1',
      });

      await service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      });

      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'channel-1',
        'Продам авто',
        expect.any(Object),
        {
          botId: 'bot-1',
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
        },
      );
      expect(publishQueue.add).not.toHaveBeenCalled();
      expect(prisma.vkParsingPost.updateMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.not.objectContaining({
            publishAttemptCount: expect.anything(),
          }),
        }),
      );
      expect(prisma.vkParsingPost.updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { id: 'post-1', publishIdempotencyKey: 'publish-key-1' },
          data: { publishAttemptCount: { increment: 1 } },
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops queued autopublish jobs when a source is switched to review mode', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource({ publishMode: 'REVIEW' });
    const post = createPostRow({
      source,
      publishQueuedAt: new Date('2026-05-25T10:00:00.000Z'),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'autopublish',
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      autoPublishKillSwitchEnabled: false,
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      schedulerTimezone: 'Europe/Moscow',
      quietHoursStart: null,
      quietHoursEnd: null,
      workHoursStart: '09:00',
      workHoursEnd: '22:00',
      distributeEvenlyEnabled: true,
      roundRobinEnabled: true,
      circuitBreakerEnabled: true,
      circuitBreakerWindowMinutes: 10,
      circuitBreakerPostLimit: 10,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'post-1', publishIdempotencyKey: 'publish-key-1' },
        data: expect.objectContaining({
          publishQueuedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
        }),
      }),
    );
  });

  it('does not send a queued VK publish job after its idempotency key was cleared', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      publishQueuedAt: new Date('2026-05-25T10:00:00.000Z'),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'autopublish',
    });
    prisma.vkParsingPost.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      autoPublishKillSwitchEnabled: false,
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      schedulerTimezone: 'Europe/Moscow',
      quietHoursStart: null,
      quietHoursEnd: null,
      workHoursStart: '09:00',
      workHoursEnd: '22:00',
      distributeEvenlyEnabled: true,
      roundRobinEnabled: true,
      circuitBreakerEnabled: true,
      circuitBreakerWindowMinutes: 10,
      circuitBreakerPostLimit: 10,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.update).not.toHaveBeenCalled();
  });

  it('publishes manual retry jobs immediately without scheduler deferral', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    try {
      const { service, prisma, maxClient, publishQueue } = createFixture();
      const source = createSource();
      const post = createPostRow({
        source,
        publishQueuedAt: new Date('2026-05-25T09:59:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
        publishIdempotencyKey: 'publish-key-1',
        publishReason: 'manual-retry',
      });
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        autoPublishKillSwitchEnabled: false,
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        schedulerTimezone: 'Europe/Moscow',
        quietHoursStart: null,
        quietHoursEnd: null,
        workHoursStart: '23:00',
        workHoursEnd: '23:30',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: true,
        circuitBreakerEnabled: true,
        circuitBreakerWindowMinutes: 10,
        circuitBreakerPostLimit: 10,
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      });
      prisma.vkParsingPost.update.mockResolvedValue({
        ...post,
        status: 'PUBLISHED',
        publishedMessageId: 'mid-1',
        publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
        publishedAtMax: new Date('2026-05-25T10:00:00.000Z'),
      });
      maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
        messageId: 'mid-1',
        url: 'https://max.ru/channels/channel-1/message/mid-1',
      });

      await service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'manual-retry',
        idempotencyKey: 'publish-key-1',
      });

      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'channel-1',
        'Продам авто',
        expect.any(Object),
        {
          botId: 'bot-1',
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
        },
      );
      expect(publishQueue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops queued autopublish jobs for posts before the enable baseline', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      publishQueuedAt: new Date('2026-05-25T10:01:00.000Z'),
      publishIdempotencyKey: 'publish-key-1',
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T10:05:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:05:00.000Z'),
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'post-1', publishIdempotencyKey: 'publish-key-1' },
        data: {
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishScheduledAt: null,
        },
      }),
    );
  });

  it('does not autopublish the initial source-added backfill', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createPostRow()]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Первичный импорт',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    const imported = await service.processSyncSourceJob('source-1', 'source-added');

    expect(imported).toBe(1);
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingSettings.findUnique).not.toHaveBeenCalled();
  });

  it('does not autopublish a first successful sync retried as scheduled', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const source = createSource({
      syncStatus: 'BACKOFF',
      lastSuccessAt: null,
      consecutiveFailures: 1,
      lastErrorCode: 'timeout',
    });
    const post = createPostRow({
      source,
      text: 'Первый успешный retry',
      createdAt: new Date('2026-05-25T10:10:00.000Z'),
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([post]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T09:00:00.000Z'),
      updatedAt: new Date('2026-05-25T09:00:00.000Z'),
    });
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Первый успешный retry',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    const imported = await service.processSyncSourceJob('source-1', 'scheduled');

    expect(imported).toBe(1);
    expect(prisma.vkParsingSettings.findUnique).not.toHaveBeenCalled();
    expect(publishQueue.add).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('does not requeue failed VK autopublish posts on the next scheduled sync', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      text: 'Повторная публикация',
      status: 'FAILED',
      lastError: 'Фото 1: VK вернул статус 404 для фото.',
      autoPublishError: 'Фото 1: VK вернул статус 404 для фото.',
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([
        {
          id: post.id,
          vkOwnerId: post.vkOwnerId,
          vkPostId: post.vkPostId,
          status: 'FAILED',
          contentHash: post.contentHash,
          publishedContentHash: null,
          lastError: 'Фото 1: VK вернул статус 404 для фото.',
          autoPublishError: 'Фото 1: VK вернул статус 404 для фото.',
        },
      ])
      .mockResolvedValueOnce([]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Повторная публикация',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(readExecuteRawValues(prisma)).toContain('FAILED');
    expect(prisma.vkParsingSettings.findUnique).not.toHaveBeenCalled();
    expect(publishQueue.add).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('autopublishes text when VK photos are temporarily unavailable', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      text: 'Текст останется',
      photoUrls: ['https://sun1.example/missing.jpg'],
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingMediaCache.findUnique.mockResolvedValue({
      id: 'media-1',
      url: 'https://sun1.example/missing.jpg',
      mediaIdentity: null,
      status: 'FAILED',
      mimeType: null,
      contentLength: null,
      maxUploadPayload: null,
      maxUploadToken: null,
      maxUploadedAt: null,
      uploadAttemptCount: 0,
      lastCheckedAt: new Date(),
      lastError: 'VK вернул статус 404 для фото.',
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      autoPublishedAt: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    const sendOptions = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0]?.[2];
    expect(sendOptions).not.toHaveProperty('imagePayload');
    expect(sendOptions).not.toHaveProperty('attachments');
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Текст останется',
      expect.any(Object),
      {
        botId: 'bot-1',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
  });

  it('falls back to another VK photo size when the selected CDN URL is stale', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const largeUrl = 'https://sun1.example/large.jpg';
    const smallUrl = 'https://sun1.example/small.jpg';
    const post = createPostRow({
      source,
      text: 'Текст с фото',
      photoUrls: [largeUrl],
      attachments: [
        {
          type: 'photo',
          photo: {
            id: 11,
            owner_id: -36819802,
            access_key: 'photo-key',
            sizes: [
              { width: 1280, height: 960, url: largeUrl },
              { width: 320, height: 240, url: smallUrl },
            ],
          },
        },
      ],
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingMediaCache.findMany.mockResolvedValue([
      {
        id: 'media-old',
        url: largeUrl,
        mediaIdentity: 'vk-photo:-36819802:11:photo-key',
        status: 'FAILED',
        mimeType: null,
        contentLength: null,
        maxUploadPayload: null,
        maxUploadToken: null,
        maxUploadedAt: null,
        uploadAttemptCount: 0,
        lastCheckedAt: new Date(),
        lastError: 'VK вернул статус 404 для фото.',
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      },
    ]);
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      autoPublishedAt: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.uploadImage.mockResolvedValue({ token: 'image-token' });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': '3' }),
        body: { cancel: async () => undefined },
      } satisfies MockFetchResponse)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': '3' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } satisfies MockFetchResponse) as unknown as typeof fetch;

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(global.fetch).toHaveBeenCalledWith(new URL(smallUrl), expect.any(Object));
    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3]),
      'small.jpg',
      'image/jpeg',
      {
        botId: 'bot-1',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalled();
  });

  it('reuses cached MAX media payloads even when the VK CDN preflight is failed', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const photoUrl = 'https://sun1.example/large.jpg';
    const post = createPostRow({
      source,
      text: 'Текст с фото',
      photoUrls: [photoUrl],
      attachments: [
        {
          type: 'photo',
          photo: {
            id: 11,
            owner_id: -36819802,
            access_key: 'photo-key',
            sizes: [{ width: 1280, height: 960, url: photoUrl }],
          },
        },
      ],
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingMediaCache.findMany.mockResolvedValue([
      {
        id: 'media-1',
        url: photoUrl,
        mediaIdentity: 'vk-photo:-36819802:11:photo-key',
        status: 'FAILED',
        mimeType: null,
        contentLength: null,
        maxUploadPayload: { token: 'cached-token' },
        maxUploadToken: 'cached-token',
        maxUploadedAt: new Date('2026-05-25T10:00:00.000Z'),
        uploadAttemptCount: 1,
        lastCheckedAt: new Date(),
        lastError: 'VK вернул статус 404 для фото.',
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      },
    ]);
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      autoPublishedAt: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(global.fetch).toBe(originalFetch);
    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Текст с фото',
      expect.objectContaining({ imagePayload: { token: 'cached-token' } }),
      {
        botId: 'bot-1',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
  });

  it('uploads a direct VK video and publishes it as a MAX video attachment', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const videoUrl = 'https://vkvd.example/video-720.mp4';
    const post = createPostRow({
      source,
      text: 'Видео из VK',
      videoUrls: [videoUrl],
      attachmentTypes: ['video'],
      attachments: [
        {
          type: 'video',
          video: {
            id: 42,
            owner_id: -36819802,
            access_key: 'video-key',
            title: 'Видеообзор',
            duration: 12,
            files: {
              mp4_360: 'https://vkvd.example/video-360.mp4',
              mp4_720: videoUrl,
            },
          },
        },
      ],
      raw: {
        attachments: [
          {
            type: 'video',
            video: {
              id: 42,
              owner_id: -36819802,
              access_key: 'video-key',
              files: {
                mp4_360: 'https://vkvd.example/video-360.mp4',
                mp4_720: videoUrl,
              },
            },
          },
        ],
      },
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      autoPublishedAt: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.uploadVideo.mockResolvedValue({ token: 'video-token' });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'video/mp4', 'content-length': '4' }),
        body: { cancel: async () => undefined },
      } satisfies MockFetchResponse)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'video/mp4', 'content-length': '4' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      } satisfies MockFetchResponse) as unknown as typeof fetch;

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.uploadVideo).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3, 4]),
      'video-720.mp4',
      'video/mp4',
      {
        botId: 'bot-1',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
        timeoutMs: 120_000,
      },
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Видео из VK',
      expect.objectContaining({
        attachments: [{ type: 'video', payload: { token: 'video-token' } }],
      }),
      {
        botId: 'bot-1',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
  });

  it('publishes a VK video when HEAD is blocked and GET omits content-length', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const videoUrl = 'https://vkvd.example/video-720.mp4';
    const post = createPostRow({
      source,
      text: 'Видео из VK',
      videoUrls: [videoUrl],
      attachmentTypes: ['video'],
      attachments: [
        {
          type: 'video',
          video: {
            id: 42,
            owner_id: -36819802,
            access_key: 'video-key',
            files: { mp4_720: videoUrl },
          },
        },
      ],
      raw: {
        attachments: [
          {
            type: 'video',
            video: {
              id: 42,
              owner_id: -36819802,
              access_key: 'video-key',
              files: { mp4_720: videoUrl },
            },
          },
        ],
      },
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      autoPublishedAt: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.uploadVideo.mockResolvedValue({ token: 'video-token' });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 405,
        headers: new Headers(),
        body: { cancel: async () => undefined },
      } satisfies MockFetchResponse)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'video/mp4' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      } satisfies MockFetchResponse) as unknown as typeof fetch;

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.uploadVideo).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3, 4]),
      'video-720.mp4',
      'video/mp4',
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Видео из VK',
      expect.objectContaining({
        attachments: [{ type: 'video', payload: { token: 'video-token' } }],
      }),
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      }),
    );
  });

  it('rejects a VK video download with an explicit non-video content type', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const videoUrl = 'https://vkvd.example/video-720.mp4';
    const post = createPostRow({
      source,
      text: 'Видео из VK',
      videoUrls: [videoUrl],
      attachmentTypes: ['video'],
      attachments: [
        {
          type: 'video',
          video: {
            id: 42,
            owner_id: -36819802,
            access_key: 'video-key',
            files: { mp4_720: videoUrl },
          },
        },
      ],
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 405,
        headers: new Headers(),
        body: { cancel: async () => undefined },
      } satisfies MockFetchResponse)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => new TextEncoder().encode('<html></html>').buffer,
      } satisfies MockFetchResponse) as unknown as typeof fetch;

    await expect(
      service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      }),
    ).rejects.toThrow('VK вернул не видео.');

    expect(maxClient.uploadVideo).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'FAILED',
          lastError: expect.stringContaining('VK вернул не видео.'),
          autoPublishError: expect.stringContaining('VK вернул не видео.'),
        }),
      }),
    );
  });

  it('keeps MAX media upload rate limits as autopublish retry failures', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      text: 'Текст с фото',
      photoUrls: ['https://sun1.example/large.jpg'],
      attachments: [
        {
          type: 'photo',
          photo: {
            id: 11,
            owner_id: -36819802,
            sizes: [{ width: 1280, height: 960, url: 'https://sun1.example/large.jpg' }],
          },
        },
      ],
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    maxClient.uploadImage.mockRejectedValue(
      new Error('MAX API background rate limit exceeded across all bots'),
    );
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': '3' }),
        body: { cancel: async () => undefined },
      } satisfies MockFetchResponse)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': '3' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } satisfies MockFetchResponse) as unknown as typeof fetch;

    await expect(
      service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      }),
    ).rejects.toThrow('MAX API background rate limit exceeded');

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'FAILED',
          lastError: expect.stringContaining('[max.rate_limit]'),
          autoPublishError: expect.stringContaining('[max.rate_limit]'),
        }),
      }),
    );
    const lastUpdate = prisma.vkParsingPost.updateMany.mock.calls.at(-1)?.[0] as
      | { data?: Record<string, unknown> }
      | undefined;
    expect(lastUpdate?.data).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        publishLockedAt: null,
      }),
    );
    expect(lastUpdate?.data).not.toHaveProperty('publishQueuedAt');
    expect(lastUpdate?.data).not.toHaveProperty('publishIdempotencyKey');
    expect(lastUpdate?.data).not.toHaveProperty('publishReason');
  });

  it('clears queued publish metadata after the final retryable autopublish attempt', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      text: 'Текст с фото',
      photoUrls: ['https://sun1.example/large.jpg'],
      attachments: [
        {
          type: 'photo',
          photo: {
            id: 11,
            owner_id: -36819802,
            sizes: [{ width: 1280, height: 960, url: 'https://sun1.example/large.jpg' }],
          },
        },
      ],
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    maxClient.uploadImage.mockRejectedValue(
      new Error('MAX API background rate limit exceeded across all bots'),
    );
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': '3' }),
        body: { cancel: async () => undefined },
      } satisfies MockFetchResponse)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': '3' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } satisfies MockFetchResponse) as unknown as typeof fetch;

    await expect(
      service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
        attemptsMade: 4,
        maxAttempts: 5,
      }),
    ).rejects.toThrow('MAX API background rate limit exceeded');

    const lastUpdate = prisma.vkParsingPost.updateMany.mock.calls.at(-1)?.[0] as
      | { data?: Record<string, unknown> }
      | undefined;
    expect(lastUpdate?.data).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        lastError: expect.stringContaining('[max.rate_limit]'),
        autoPublishError: expect.stringContaining('[max.rate_limit]'),
        publishLockedAt: null,
        publishQueuedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
      }),
    );
  });

  it('skips advertising VK posts during autopublish without sending them to MAX', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      isAdvertising: true,
      advertisingMarkers: ['VK marked_as_ads'],
      raw: { marked_as_ads: true },
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: true,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'SKIPPED',
          skipReason: 'AD',
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
        }),
      }),
    );
  });

  it('skips unsupported-only VK posts during autopublish instead of failing them', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      text: '',
      photoUrls: [],
      linkUrls: [],
      attachmentTypes: ['video'],
      unsupportedAttachments: [{ type: 'video', label: 'Видео', title: 'Обзор', count: 1 }],
      hasUnsupportedAttachments: true,
      attachments: [{ type: 'video', video: { title: 'Обзор' } }],
      raw: { attachments: [{ type: 'video', video: { title: 'Обзор' } }] },
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'SKIPPED',
          skipReason: 'NO_SUPPORTED_CONTENT',
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
        }),
      }),
    );
  });

  it('autopublishes unsupported VK short videos as original post links when links are stripped', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const postUrl = 'https://vk.ru/wall-36819802_104';
    const post = createPostRow({
      source,
      text: '',
      photoUrls: [],
      videoUrls: [],
      linkUrls: [postUrl],
      attachmentTypes: ['video'],
      unsupportedAttachments: [
        {
          type: 'video',
          label: 'Видео',
          title: 'Clip from СПОРТ ИНСАЙДЕР',
          count: 1,
          reason: 'Нет прямого HTTPS-файла видео',
        },
      ],
      hasUnsupportedAttachments: true,
      url: postUrl,
      attachments: [
        {
          type: 'video',
          video: { title: 'Clip from СПОРТ ИНСАЙДЕР', type: 'short_video' },
        },
      ],
      raw: {
        attachments: [
          {
            type: 'video',
            video: { title: 'Clip from СПОРТ ИНСАЙДЕР', type: 'short_video' },
          },
        ],
      },
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: true,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      autoPublishedAt: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      postUrl,
      expect.any(Object),
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      }),
    );
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'PUBLISHED',
          autoPublishError: null,
          lastError: null,
        }),
      }),
    );
  });

  it('retries VK rate limit errors and records VK API metrics', async () => {
    const { service, prisma, vkRateLimitService } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          error: { error_code: 6, error_msg: 'Too many requests per second.' },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({ response: { items: [], groups: [] } }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(vkRateLimitService.reserveVkApiSlot).toHaveBeenCalledTimes(2);
    expect(vkRateLimitService.recordVkApiOutcome).toHaveBeenCalledWith({
      method: 'wall.get',
      outcome: 'error',
      code: 'vk_6',
    });
    expect(vkRateLimitService.recordVkApiOutcome).toHaveBeenCalledWith({
      method: 'wall.get',
      outcome: 'success',
    });
  });

  it.each([6, 9, 10, 29])('retries retryable VK error code %i', async (code) => {
    const { service, prisma, vkRateLimitService } = createFixture({ VK_API_MAX_ATTEMPTS: 2 });
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          error: { error_code: code, error_msg: `Retryable ${code}` },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({ response: { items: [], groups: [] } }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(vkRateLimitService.reserveVkApiSlot).toHaveBeenCalledTimes(2);
    expect(vkRateLimitService.recordVkApiOutcome).toHaveBeenCalledWith({
      method: 'wall.get',
      outcome: 'error',
      code: `vk_${code}`,
    });
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          syncStatus: 'IDLE',
          lastErrorCode: null,
        }),
      }),
    );
  });

  it.each([30, 203, 210])('treats VK source error code %i as terminal', async (code) => {
    const { service, prisma, vkRateLimitService } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        error: { error_code: code, error_msg: `Terminal ${code}` },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(vkRateLimitService.reserveVkApiSlot).toHaveBeenCalledTimes(1);
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1', syncLockedBy: expect.any(String) }),
        data: expect.objectContaining({
          syncStatus: 'ERROR',
          nextSyncAt: null,
          lastErrorCode: `vk_api.vk_${code}`,
          lastError: expect.stringContaining(`(${code})`),
        }),
      }),
    );
  });

  it('treats VK captcha code 14 as terminal with an actionable token message', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        error: { error_code: 14, error_msg: 'Captcha needed' },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          syncStatus: 'ERROR',
          nextSyncAt: null,
          lastErrorCode: 'vk_api.vk_14',
          lastError: expect.stringContaining('капчу или токен не подходит'),
        }),
      }),
    );
  });

  it('handles an empty VK wall without importing posts', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        createJsonFetchResponse({ response: { items: [], groups: [] } }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1', syncLockedBy: expect.any(String) }),
        data: expect.objectContaining({
          syncStatus: 'IDLE',
          syncLockDeadlineAt: null,
          syncHeartbeatAt: null,
          lastFetchedCount: 0,
          lastImportedCount: 0,
        }),
      }),
    );
  });

  it('records sync lease deadline and heartbeats while processing a source', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        createJsonFetchResponse({ response: { items: [], groups: [] } }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1' }),
        data: expect.objectContaining({
          syncLockedBy: expect.any(String),
          syncLockDeadlineAt: expect.any(Date),
          syncHeartbeatAt: expect.any(Date),
          syncAttemptCount: { increment: 1 },
        }),
      }),
    );
    expect(prisma.vkParsingSource.updateMany.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            where: expect.objectContaining({
              id: 'source-1',
              syncStatus: 'SYNCING',
              syncLockedBy: expect.any(String),
            }),
            data: expect.objectContaining({
              syncHeartbeatAt: expect.any(Date),
              syncLockDeadlineAt: expect.any(Date),
            }),
          }),
        ],
      ]),
    );
  });

  it('opens a source circuit breaker for terminal private or content-blocked VK sources', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        error: { error_code: 19, error_msg: 'Content blocked' },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1', syncLockedBy: expect.any(String) }),
        data: expect.objectContaining({
          syncStatus: 'ERROR',
          nextSyncAt: null,
          consecutiveFailures: 1,
          terminalFailureCount: 1,
          circuitOpenedAt: expect.any(Date),
          circuitReasonCode: 'vk_api.vk_19',
          circuitReason: expect.stringContaining('Content blocked'),
          circuitRetryAt: null,
          lastErrorCode: 'vk_api.vk_19',
        }),
      }),
    );
  });

  it('can verify a terminal VK source before opening the source circuit breaker', async () => {
    const { service, prisma } = createFixture({
      VK_PARSING_SOURCE_CIRCUIT_TERMINAL_FAILURE_THRESHOLD: 2,
    });
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        error: { error_code: 15, error_msg: 'Access denied' },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1', syncLockedBy: expect.any(String) }),
        data: expect.objectContaining({
          syncStatus: 'BACKOFF',
          nextSyncAt: expect.any(Date),
          terminalFailureCount: 1,
          circuitOpenedAt: null,
          circuitReasonCode: null,
          circuitReason: null,
          circuitRetryAt: expect.any(Date),
          lastErrorCode: 'vk_api.vk_15',
        }),
      }),
    );
  });

  it('preserves terminal failure counters when scheduled sync retries a source', async () => {
    const { service, prisma, syncQueue } = createFixture();
    prisma.vkParsingSource.findMany.mockResolvedValue([
      createSource({
        syncStatus: 'BACKOFF',
        terminalFailureCount: 1,
        circuitRetryAt: new Date('2026-05-25T10:05:00.000Z'),
      }),
    ]);

    await service.syncDueSources('scheduled');

    const update = prisma.vkParsingSource.updateMany.mock.calls.at(-1)?.[0] as
      | { data?: Record<string, unknown> }
      | undefined;
    expect(update?.data).toEqual(
      expect.objectContaining({
        syncStatus: 'QUEUED',
        nextSyncAt: expect.any(Date),
      }),
    );
    expect(update?.data).not.toHaveProperty('terminalFailureCount');
    expect(update?.data).not.toHaveProperty('circuitOpenedAt');
    expect(update?.data).not.toHaveProperty('circuitReasonCode');
    expect(syncQueue.add).toHaveBeenCalled();
  });

  it('opens the source circuit after the configured terminal retry threshold', async () => {
    const { service, prisma } = createFixture({
      VK_PARSING_SOURCE_CIRCUIT_TERMINAL_FAILURE_THRESHOLD: 2,
    });
    const source = createSource({
      syncStatus: 'BACKOFF',
      consecutiveFailures: 1,
      terminalFailureCount: 1,
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        error: { error_code: 15, error_msg: 'Access denied again' },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1', syncLockedBy: expect.any(String) }),
        data: expect.objectContaining({
          syncStatus: 'ERROR',
          terminalFailureCount: 2,
          circuitOpenedAt: expect.any(Date),
          circuitReasonCode: 'vk_api.vk_15',
          circuitRetryAt: null,
        }),
      }),
    );
  });

  it('stops syncing without importing when the source lease is lost after fetch', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingSource.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 0 });
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [{ owner_id: -36819802, id: 101, date: 1_779_708_000, text: 'Пост' }],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    const imported = await service.processSyncSourceJob('source-1', 'scheduled');

    expect(imported).toBe(0);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.update).not.toHaveBeenCalled();
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('imports up to 100 posts through chunked bulk inserts', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    const posts = Array.from({ length: 100 }, (_, index) => ({
      owner_id: -36819802,
      id: index + 1,
      date: 1_779_708_000 - index,
      text: `Пост ${index + 1}`,
    }));
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        createJsonFetchResponse({ response: { items: posts, groups: [] } }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    const firstUrl = String((global.fetch as jest.Mock).mock.calls[0]?.[0] ?? '');
    expect(firstUrl).toContain('count=100');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('classifies bulk import transaction timeouts as retryable DB sync errors', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    prisma.$executeRaw.mockRejectedValueOnce(
      Object.assign(new Error('Transaction API error: timeout'), { code: 'P2028' }),
    );
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [{ owner_id: -36819802, id: 101, date: 1_779_708_000, text: 'Пост' }],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    const imported = await service.processSyncSourceJob('source-1', 'scheduled');

    expect(imported).toBe(0);
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1', syncLockedBy: expect.any(String) }),
        data: expect.objectContaining({
          syncStatus: 'BACKOFF',
          lastErrorCode: 'db.transaction_timeout',
          nextSyncAt: expect.any(Date),
        }),
      }),
    );
  });

  it('marks a published VK post as changed after VK edits its source content', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([
      {
        id: 'post-1',
        vkOwnerId: -36819802,
        vkPostId: 101,
        status: 'PUBLISHED',
        contentHash: 'old-hash',
        publishedContentHash: 'old-hash',
      },
    ]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'VK изменил текст',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(readExecuteRawValues(prisma)).toContain('CHANGED_AFTER_PUBLISH');
  });

  it('only marks fetched-window missing VK posts unavailable after threshold and spot-check', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'missing-post-1',
        vkOwnerId: -36819802,
        vkPostId: 100,
        missingSeenCount: 2,
      },
    ]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [
              {
                owner_id: -36819802,
                id: 101,
                date: 1_779_708_000,
                text: 'Оставшийся пост',
              },
            ],
            groups: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: { items: [] },
        }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(String((global.fetch as jest.Mock).mock.calls[1]?.[0] ?? '')).toContain('wall.getById');
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['missing-post-1'] },
          status: { in: ['NEW', 'FAILED', 'CHANGED_AFTER_PUBLISH'] },
        },
        data: expect.objectContaining({
          status: 'UNAVAILABLE',
          missingSinceAt: expect.any(Date),
          unavailableAt: expect.any(Date),
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
        }),
      }),
    );
    expect(prisma.vkParsingPost.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('bulk-resets found VK missing-post candidates and marks only confirmed missing posts unavailable', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'found-post-1',
        vkOwnerId: -36819802,
        vkPostId: 100,
        missingSeenCount: 2,
      },
      {
        id: 'missing-post-1',
        vkOwnerId: -36819802,
        vkPostId: 99,
        missingSeenCount: 2,
      },
    ]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [
              {
                owner_id: -36819802,
                id: 101,
                date: 1_779_708_000,
                text: 'Оставшийся пост',
              },
            ],
            groups: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [
              {
                owner_id: -36819802,
                id: 100,
                date: 1_779_707_000,
                text: 'VK still has this post',
              },
            ],
          },
        }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['found-post-1'] },
          status: { in: ['NEW', 'FAILED', 'CHANGED_AFTER_PUBLISH'] },
        },
        data: expect.objectContaining({
          missingSeenCount: 0,
          missingSinceAt: null,
          lastAvailabilityCheckedAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['missing-post-1'] },
          status: { in: ['NEW', 'FAILED', 'CHANGED_AFTER_PUBLISH'] },
        },
        data: expect.objectContaining({
          status: 'UNAVAILABLE',
          missingSeenCount: { increment: 1 },
          unavailableAt: expect.any(Date),
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
        }),
      }),
    );
    expect(prisma.vkParsingPost.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not mark fetched-window missing VK posts unavailable before confirmation threshold', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'missing-post-1',
        vkOwnerId: -36819802,
        vkPostId: 100,
        missingSeenCount: 0,
      },
    ]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Оставшийся пост',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['missing-post-1'] },
          status: { in: ['NEW', 'FAILED', 'CHANGED_AFTER_PUBLISH'] },
        },
        data: expect.objectContaining({
          missingSeenCount: { increment: 1 },
          missingSinceAt: expect.any(Date),
          lastAvailabilityCheckedAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.vkParsingPost.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'UNAVAILABLE',
        }),
      }),
    );
  });

  it('publishes an edited VK post to MAX with selected photos and links', async () => {
    const { service, prisma, maxClient, maxBotLinkService } = createFixture();
    const post = {
      id: 'post-1',
      sourceId: 'source-1',
      chatId: 'channel-1',
      vkOwnerId: -36819802,
      vkPostId: 101,
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
      text: 'Продам авто',
      url: 'https://vk.ru/wall-36819802_101',
      photoUrls: ['https://sun1.example/large.jpg'],
      linkUrls: ['https://example.com/car'],
      attachments: [],
      raw: {},
      status: 'NEW',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAtMax: null,
      lastError: null,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      source: {
        id: 'source-1',
        chatId: 'channel-1',
        ownerId: 36819802,
        wallOwnerId: -36819802,
        screenName: 'avto_prodaja_rb',
        title: 'Авторынок Уфа',
        url: 'https://vk.ru/avto_prodaja_rb',
        status: 'ACTIVE',
        lastSyncAt: null,
        lastError: null,
        createdByUserId: '183470701',
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      },
    };
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.uploadImage.mockResolvedValue({ token: 'image-token' });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': '3' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } satisfies MockFetchResponse) as unknown as typeof fetch;

    const result = await service.publishPost(
      'channel-1',
      'post-1',
      { userId: '98315271' } as never,
      {
        text: 'Мой текст',
        photoUrls: ['https://sun1.example/large.jpg'],
        linkUrls: ['https://example.com/car'],
      },
    );

    expect(maxBotLinkService.resolveBotIdForSend).toHaveBeenCalledWith({ chatId: 'channel-1' });
    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3]),
      'large.jpg',
      'image/jpeg',
      {
        botId: 'bot-1',
        trafficClass: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Мой текст\nhttps://example.com/car',
      expect.objectContaining({ imagePayload: { token: 'image-token' } }),
      {
        botId: 'bot-1',
        trafficClass: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
    expect(result.messageId).toBe('mid-1');
  });

  it('publishes VK posts to chats without channel engagement buttons', async () => {
    const { service, prisma, adminService, maxClient } = createFixture();
    const source = createSource({ chatId: 'chat-1' });
    const post = createPostRow({
      chatId: 'chat-1',
      source,
      text: 'Пост для чата',
    });
    prisma.chat.findUnique.mockResolvedValue({ entityType: ChatEntityType.CHAT });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-chat-1',
      publishedUrl: 'https://max.ru/chats/chat-1/message/mid-chat-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-chat-1',
      url: 'https://max.ru/chats/chat-1/message/mid-chat-1',
    });

    const result = await service.publishPost(
      'chat-1',
      'post-1',
      { userId: 'chat-admin' } as never,
      {
        text: 'Публикуем в чат',
        photoUrls: [],
        linkUrls: [],
      },
    );

    expect(adminService.assertChatAdmin).toHaveBeenCalledWith('chat-1', 'chat-admin', 'chat');
    expect(adminService.buildChannelPublicationEngagementContext).not.toHaveBeenCalled();
    expect(adminService.recordChannelPublicationEngagement).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      'Публикуем в чат',
      expect.not.objectContaining({ buttons: expect.anything() }),
      {
        botId: 'bot-1',
        trafficClass: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
    expect(result.messageId).toBe('mid-chat-1');
  });

  it('returns success when a VK post disappears after MAX accepts the publish', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({ source, text: 'Пост после stale-row гонки' });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-stale',
      url: 'https://max.ru/channels/channel-1/message/mid-stale',
    });

    const result = await service.publishPost(
      'channel-1',
      'post-1',
      { userId: '98315271' } as never,
      {
        text: 'Пост после stale-row гонки',
        photoUrls: [],
        linkUrls: [],
      },
    );

    expect(result.messageId).toBe('mid-stale');
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(prisma.vkParsingPost.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'PUBLISHED',
          publishedMessageId: 'mid-stale',
        }),
      }),
    );
  });

  it('does not publish the same VK post twice', async () => {
    const { service, prisma, maxClient } = createFixture();
    const post = {
      id: 'post-1',
      sourceId: 'source-1',
      chatId: 'channel-1',
      vkOwnerId: -36819802,
      vkPostId: 101,
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
      text: 'Продам авто',
      url: 'https://vk.ru/wall-36819802_101',
      photoUrls: [],
      linkUrls: [],
      attachments: [],
      raw: {},
      contentHash: 'published-hash',
      publishedContentHash: 'published-hash',
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      lastSeenAt: new Date('2026-05-25T10:00:00.000Z'),
      missingSinceAt: null,
      unavailableAt: null,
      lastError: null,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      source: createSource(),
    };
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    await expect(
      service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: 'Повтор',
        photoUrls: [],
        linkUrls: [],
      }),
    ).rejects.toThrow('уже опубликован');
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('does not manually publish a VK post while another publish is locked', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({ source, text: 'Уже публикуется' });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: 'Уже публикуется',
        photoUrls: [],
        linkUrls: [],
      }),
    ).rejects.toThrow('уже публикуется');

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.update).not.toHaveBeenCalled();
  });

  it('blocks every manual VK resend path after an ambiguous MAX send timeout', async () => {
    const { publishService, prisma, maxClient, publishQueue } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      status: 'FAILED',
      lastError:
        '[max.send_ambiguous] request timed out. Delivery may have been accepted by MAX.',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    const actions = [
      () =>
        publishService.publishPost('channel-1', 'post-1', '98315271', {
          text: 'Повтор',
          photoUrls: [],
          linkUrls: [],
        }),
      () => publishService.retryPost('channel-1', 'post-1'),
      () =>
        publishService.schedulePost(
          'channel-1',
          'post-1',
          '2026-05-25T11:00:00.000Z',
          '98315271',
        ),
      () => publishService.publishPostNow('channel-1', 'post-1', '98315271'),
    ];

    for (const action of actions) {
      await expect(action()).rejects.toThrow('MAX мог уже принять эту публикацию');
    }

    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(publishQueue.add).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('keeps review-mode VK sources out of ordinary manual publish actions', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource({ publishMode: 'REVIEW' });
    const post = createPostRow({ source, text: 'Только через Safety Desk' });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    await expect(
      service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: 'Только через Safety Desk',
        photoUrls: [],
        linkUrls: [],
      }),
    ).rejects.toThrow('Safety Desk');

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
  });

  it('saves review-mode VK post edits without publishing to MAX', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource({ publishMode: 'REVIEW' });
    const post = createPostRow({
      source,
      text: 'Черновик до правки',
      linkUrls: ['https://example.com/source'],
      status: 'FAILED',
      lastError: 'Предыдущая попытка остановлена.',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });

    await service.updateReviewPostDraft('channel-1', 'post-1', { userId: '98315271' } as never, {
      text: 'Черновик после правки',
      photoUrls: [],
      linkUrls: ['https://example.com/source'],
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'post-1',
        chatId: 'channel-1',
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
        publishCancelledAt: null,
        publishLockedAt: null,
        source: { publishMode: 'REVIEW' },
      }),
      data: expect.objectContaining({
        status: 'NEW',
        text: 'Черновик после правки',
        photoUrls: [],
        linkUrls: ['https://example.com/source'],
        publishQueuedAt: null,
        publishLockedAt: null,
        lastError: null,
      }),
    });
  });

  it('does not clear an ambiguous Safety Desk send marker when saving a review draft', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource({ publishMode: 'REVIEW' });
    const post = createPostRow({
      source,
      text: 'Черновик до правки',
      status: 'FAILED',
      lastError:
        '[max.send_ambiguous] request timed out. Delivery may have been accepted by MAX.',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    await expect(
      service.updateReviewPostDraft('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: 'Черновик после правки',
        photoUrls: [],
        linkUrls: [],
      }),
    ).rejects.toThrow('MAX мог уже принять эту публикацию');

    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('does not clear review-mode VK publish metadata when the draft changed concurrently', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource({ publishMode: 'REVIEW' });
    const post = createPostRow({
      source,
      text: 'Черновик до правки',
      publishLockedAt: null,
      publishIdempotencyKey: 'review-job',
      publishQueuedAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.updateReviewPostDraft('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: 'Черновик после правки',
        photoUrls: [],
        linkUrls: [],
      }),
    ).rejects.toThrow('уже обработан или недоступен');

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'post-1',
        chatId: 'channel-1',
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
        publishLockedAt: null,
        publishCancelledAt: null,
      }),
      data: expect.objectContaining({
        publishIdempotencyKey: null,
      }),
    });
  });

  it('does not cancel a VK schedule after the queued publish state changed', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    const scheduledAt = new Date('2026-05-25T10:30:00.000Z');
    const post = createPostRow({
      source,
      publishScheduledAt: scheduledAt,
      publishIdempotencyKey: 'schedule-key-1',
      publishReason: 'manual-schedule',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.cancelScheduledPost('channel-1', 'post-1', { userId: '98315271' } as never),
    ).rejects.toThrow('уже нельзя отменить');

    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'post-1',
        chatId: 'channel-1',
        publishScheduledAt: scheduledAt,
        publishIdempotencyKey: 'schedule-key-1',
        publishCancelledAt: null,
        publishLockedAt: null,
      }),
      data: expect.any(Object),
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('clears stale queued jobs for review-mode VK sources without publishing', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource({ publishMode: 'REVIEW' });
    const post = createPostRow({
      source,
      publishIdempotencyKey: 'review-job',
      publishQueuedAt: new Date('2026-05-25T10:00:00.000Z'),
      publishReason: 'manual-retry',
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'manual-retry',
      idempotencyKey: 'review-job',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'post-1',
        publishIdempotencyKey: 'review-job',
      },
      data: {
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
      },
    });
  });

  it('uses cached media preflight failures with a photo-specific publish error', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = {
      id: 'post-1',
      sourceId: source.id,
      chatId: 'channel-1',
      vkOwnerId: -36819802,
      vkPostId: 101,
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
      text: 'Продам авто',
      url: 'https://vk.ru/wall-36819802_101',
      photoUrls: ['https://sun1.example/missing.jpg'],
      linkUrls: [],
      attachments: [],
      raw: {},
      contentHash: 'content-hash',
      publishedContentHash: null,
      status: 'NEW',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAtMax: null,
      lastSeenAt: new Date('2026-05-25T10:00:00.000Z'),
      missingSinceAt: null,
      unavailableAt: null,
      lastError: null,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      source,
    };
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingMediaCache.findUnique.mockResolvedValue({
      id: 'media-1',
      url: 'https://sun1.example/missing.jpg',
      status: 'FAILED',
      mimeType: null,
      contentLength: null,
      lastCheckedAt: new Date(),
      lastError: 'Фото недоступно в VK.',
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });

    await expect(
      service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: 'Мой текст',
        photoUrls: ['https://sun1.example/missing.jpg'],
        linkUrls: [],
      }),
    ).rejects.toThrow('Фото 1');
    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'FAILED',
          lastError: expect.stringContaining('Фото 1'),
        }),
      }),
    );
  });

  it('rechecks expired failed media preflight cache before publishing', async () => {
    const { service, prisma, maxClient } = createFixture({
      VK_PARSING_MEDIA_FAILED_PREFLIGHT_TTL_MS: 1_000,
    });
    const source = createSource();
    const post = createPostRow({
      source,
      photoUrls: ['https://sun1.example/large.jpg'],
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
    });
    prisma.vkParsingMediaCache.findUnique.mockResolvedValue({
      id: 'media-1',
      url: 'https://sun1.example/large.jpg',
      status: 'FAILED',
      mimeType: null,
      contentLength: null,
      lastCheckedAt: new Date(Date.now() - 60_000),
      lastError: 'VK вернул статус 404 для фото.',
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    maxClient.uploadImage.mockResolvedValue({ token: 'image-token' });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': '3' }),
        body: { cancel: async () => undefined },
      } satisfies MockFetchResponse)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': '3' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } satisfies MockFetchResponse) as unknown as typeof fetch;

    await service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
      text: 'Мой текст',
      photoUrls: ['https://sun1.example/large.jpg'],
      linkUrls: [],
    });

    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3]),
      'large.jpg',
      'image/jpeg',
      {
        botId: 'bot-1',
        trafficClass: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalled();
  });

  it('merges media cache rows by URL and VK media identity under advisory lock', async () => {
    const { mediaCache, prisma } = createFixture();
    const urlRow = {
      id: 'media-url',
      url: 'https://sun1.example/large.jpg',
      mediaIdentity: null,
      status: 'READY',
      mimeType: 'image/jpeg',
      contentLength: 3,
      maxUploadPayload: { token: 'cached-token' },
      maxUploadToken: 'cached-token',
      maxUploadedAt: new Date('2026-05-25T10:00:00.000Z'),
      uploadAttemptCount: 1,
      lastCheckedAt: new Date('2026-05-25T10:00:00.000Z'),
      lastError: null,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    };
    const identityRow = {
      ...urlRow,
      id: 'media-identity',
      url: 'https://sun1.example/old.jpg',
      mediaIdentity: 'photo:-36819802_11',
      maxUploadPayload: null,
      maxUploadToken: null,
      maxUploadedAt: null,
    };
    prisma.vkParsingMediaCache.findMany.mockResolvedValue([identityRow, urlRow]);

    await mediaCache.writeMediaCache(
      'https://sun1.example/large.jpg',
      { status: 'READY', mimeType: 'image/jpeg', contentLength: 3 },
      'photo:-36819802_11',
    );

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(prisma.vkParsingMediaCache.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['media-identity'] } },
    });
    expect(prisma.vkParsingMediaCache.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'media-url' },
        data: expect.objectContaining({
          url: 'https://sun1.example/large.jpg',
          mediaIdentity: 'photo:-36819802_11',
          status: 'READY',
        }),
      }),
    );
  });

  it('retries media cache writes after unique conflicts', async () => {
    const { mediaCache, prisma } = createFixture();
    prisma.vkParsingMediaCache.upsert
      .mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      )
      .mockResolvedValueOnce({
        id: 'media-1',
        url: 'https://sun1.example/large.jpg',
        mediaIdentity: null,
        status: 'READY',
        mimeType: 'image/jpeg',
        contentLength: 3,
        maxUploadPayload: null,
        maxUploadToken: null,
        maxUploadedAt: null,
        uploadAttemptCount: 0,
        lastCheckedAt: new Date(),
        lastError: null,
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      });

    await mediaCache.writeMediaCache('https://sun1.example/large.jpg', {
      status: 'READY',
      mimeType: 'image/jpeg',
      contentLength: 3,
    });

    expect(prisma.vkParsingMediaCache.upsert).toHaveBeenCalledTimes(2);
  });

  it('retries media identity cache merges after concurrent unique conflicts', async () => {
    const { mediaCache, prisma } = createFixture();
    const urlRow = {
      id: 'media-url',
      url: 'https://sun1.example/large.jpg',
      mediaIdentity: null,
      status: 'READY',
      mimeType: 'image/jpeg',
      contentLength: 3,
      maxUploadPayload: { token: 'cached-token' },
      maxUploadToken: 'cached-token',
      maxUploadedAt: new Date('2026-05-25T10:00:00.000Z'),
      uploadAttemptCount: 1,
      lastCheckedAt: new Date('2026-05-25T10:00:00.000Z'),
      lastError: null,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    };
    const identityRow = {
      ...urlRow,
      id: 'media-identity',
      url: 'https://sun1.example/old.jpg',
      mediaIdentity: 'photo:-36819802_11',
      maxUploadPayload: null,
      maxUploadToken: null,
      maxUploadedAt: null,
    };
    prisma.vkParsingMediaCache.findMany
      .mockResolvedValueOnce([urlRow])
      .mockResolvedValueOnce([identityRow, urlRow]);
    prisma.vkParsingMediaCache.update
      .mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed on media_identity'), {
          code: 'P2002',
        }),
      )
      .mockResolvedValueOnce({
        ...urlRow,
        mediaIdentity: 'photo:-36819802_11',
      });

    await mediaCache.writeMediaCache(
      'https://sun1.example/large.jpg',
      { status: 'READY', mimeType: 'image/jpeg', contentLength: 3 },
      'photo:-36819802_11',
    );

    expect(prisma.vkParsingMediaCache.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.vkParsingMediaCache.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['media-identity'] } },
    });
    expect(prisma.vkParsingMediaCache.update).toHaveBeenCalledTimes(2);
  });

  it('falls back to a ranged GET when media preflight HEAD is blocked', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = {
      id: 'post-1',
      sourceId: source.id,
      chatId: 'channel-1',
      vkOwnerId: -36819802,
      vkPostId: 101,
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
      text: 'Продам авто',
      url: 'https://vk.ru/wall-36819802_101',
      photoUrls: ['https://sun1.example/large.jpg'],
      linkUrls: [],
      attachments: [],
      raw: {},
      contentHash: 'content-hash',
      publishedContentHash: null,
      status: 'NEW',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAtMax: null,
      lastSeenAt: new Date('2026-05-25T10:00:00.000Z'),
      missingSinceAt: null,
      unavailableAt: null,
      lastError: null,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      source,
    };
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    maxClient.uploadImage.mockResolvedValue({ token: 'image-token' });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 405,
        headers: new Headers(),
        body: { cancel: async () => undefined },
      } satisfies MockFetchResponse)
      .mockResolvedValueOnce({
        ok: true,
        status: 206,
        headers: new Headers({
          'content-type': 'image/jpeg',
          'content-range': 'bytes 0-0/3',
        }),
        body: { cancel: async () => undefined },
      } satisfies MockFetchResponse)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': '3' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } satisfies MockFetchResponse) as unknown as typeof fetch;

    await service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
      text: 'Мой текст',
      photoUrls: ['https://sun1.example/large.jpg'],
      linkUrls: [],
    });

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      new URL('https://sun1.example/large.jpg'),
      expect.objectContaining({
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
      }),
    );
    expect(prisma.vkParsingMediaCache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          url: 'https://sun1.example/large.jpg',
          status: 'READY',
          contentLength: 3,
        }),
      }),
    );
    expect(maxClient.uploadImage).toHaveBeenCalled();
  });

  it('adds channel comments and suggestion buttons when publishing a VK post', async () => {
    const { service, prisma, adminService, maxClient } = createFixture();
    const engagementContext = {
      buttons: [
        [{ type: 'link', text: '💬 Комментарии · 0', url: 'https://max.ru/bot?startapp=comments' }],
        [{ type: 'link', text: 'Предложить пост', url: 'https://max.ru/bot?start=suggest' }],
      ],
      threadId: 'thread-1',
      includeCommentsButton: true,
      includeSuggestButton: true,
      suggestButtonText: 'Предложить пост',
      autoPostButtonsMode: 'BOTH',
      suggestionEntryMode: 'BOT',
    };
    const source = {
      id: 'source-1',
      chatId: 'channel-1',
      ownerId: 36819802,
      wallOwnerId: -36819802,
      screenName: 'avto_prodaja_rb',
      title: 'Авторынок Уфа',
      url: 'https://vk.ru/avto_prodaja_rb',
      status: 'ACTIVE',
      lastSyncAt: null,
      lastError: null,
      createdByUserId: '183470701',
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    };
    const post = {
      id: 'post-1',
      sourceId: source.id,
      chatId: 'channel-1',
      vkOwnerId: -36819802,
      vkPostId: 101,
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
      text: 'Продам авто',
      url: 'https://vk.ru/wall-36819802_101',
      photoUrls: [],
      linkUrls: [],
      attachments: [],
      raw: {},
      status: 'NEW',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAtMax: null,
      lastError: null,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      source,
    };
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
    });
    adminService.buildChannelPublicationEngagementContext.mockResolvedValue(engagementContext);
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });

    await service.publishPost('channel-1', 'post-1', { userId: '183470701' } as never, {
      text: 'Мой текст',
      photoUrls: [],
      linkUrls: [],
    });

    expect(adminService.buildChannelPublicationEngagementContext).toHaveBeenCalledWith(
      'channel-1',
      'bot-1',
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Мой текст',
      expect.objectContaining({
        buttons: engagementContext.buttons,
      }),
      {
        botId: 'bot-1',
        trafficClass: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
    expect(adminService.recordChannelPublicationEngagement).toHaveBeenCalledWith({
      chatId: 'channel-1',
      actorUserId: '183470701',
      messageId: 'mid-1',
      text: 'Мой текст',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      context: engagementContext,
      source: 'vk_parsing',
      botId: 'bot-1',
    });
  });
});
