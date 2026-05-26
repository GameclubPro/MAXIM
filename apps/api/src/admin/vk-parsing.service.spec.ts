import { ChatEntityType } from '../prisma/prisma-client';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { VkParsingService } from './vk-parsing.service';

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
      $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
    };
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
      sendMessageImmediateWithResolvedLink: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotId: jest.fn().mockResolvedValue('bot-1'),
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
    };
    const publishQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new VkParsingService(
      prisma as never,
      adminService as never,
      maxClient as never,
      maxBotLinkService as never,
      vkRateLimitService as never,
      syncQueue as never,
      publishQueue as never,
      createConfig({
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
      }) as never,
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
      syncStatus: 'IDLE',
      nextSyncAt: new Date('2026-05-25T10:00:00.000Z'),
      lastSyncAt: null,
      lastSuccessAt: null,
      syncStartedAt: null,
      syncLockedAt: null,
      syncLockedBy: null,
      syncAttemptCount: 0,
      consecutiveFailures: 0,
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
      publishLockedAt: null,
      publishAttemptCount: 0,
      publishIdempotencyKey: null,
      lastError: null,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      source,
      ...overrides,
    };
  }

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
      create: {
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T10:01:00.000Z'),
        stripLinksEnabled: true,
        skipAdsEnabled: true,
      },
      update: {
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T10:01:00.000Z'),
        stripLinksEnabled: true,
        skipAdsEnabled: true,
      },
    });
    expect(feed.settings).toEqual({
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: '2026-05-25T10:01:00.000Z',
      stripLinksEnabled: true,
      skipAdsEnabled: true,
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
        },
      }),
    );
  });

  it('imports text, photos and links from a public VK community without videos', async () => {
    const { service, prisma } = createFixture();
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
                video: { title: 'ignored' },
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
    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingPost.upsert).toHaveBeenCalledTimes(1);
    const upsertPayload = prisma.vkParsingPost.upsert.mock.calls[0]?.[0];
    expect(upsertPayload.create.text).toBe('Продам авто');
    expect(upsertPayload.create.photoUrls).toEqual(['https://sun1.example/large.jpg']);
    expect(upsertPayload.create.linkUrls).toEqual(['https://example.com/car']);
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

    const upsertPayload = prisma.vkParsingPost.upsert.mock.calls[0]?.[0];
    expect(upsertPayload.create.photoUrls).toEqual(['https://sun2.example/src.jpg']);
    expect(upsertPayload.create.linkUrls).toEqual(['https://example.com/from-copy']);
    expect(upsertPayload.create.attachmentTypes).toEqual(
      expect.arrayContaining(['photo', 'photos_list', 'video', 'doc', 'poll', 'article', 'link']),
    );
    expect(upsertPayload.create.unsupportedAttachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'photos_list' }),
        expect.objectContaining({ type: 'video', title: 'Видеообзор' }),
        expect.objectContaining({ type: 'doc', title: 'Прайс.pdf' }),
        expect.objectContaining({ type: 'poll', title: 'Брать?' }),
        expect.objectContaining({ type: 'article', title: 'Разбор' }),
        expect.objectContaining({ type: 'copy_history' }),
      ]),
    );
    expect(upsertPayload.create.hasUnsupportedAttachments).toBe(true);
    expect(upsertPayload.create.isAdvertising).toBe(true);
    expect(upsertPayload.create.advertisingMarkers).toEqual(
      expect.arrayContaining(['VK marked_as_ads']),
    );
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
    expect(prisma.vkParsingSource.update).toHaveBeenCalledWith(
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
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
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
    expect(prisma.vkParsingPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'post-1' },
        data: expect.objectContaining({
          status: 'PUBLISHED',
          autoPublishedAt: expect.any(Date),
          autoPublishError: null,
          publishQueuedAt: null,
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
    expect(prisma.vkParsingPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'post-1' },
        data: {
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
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

    expect(prisma.vkParsingPost.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: 'FAILED',
        }),
      }),
    );
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
    expect(prisma.vkParsingPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'post-1' },
        data: expect.objectContaining({
          status: 'FAILED',
          autoPublishError: expect.stringContaining('MAX API background rate limit exceeded'),
        }),
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
    expect(prisma.vkParsingPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'post-1' },
        data: expect.objectContaining({
          status: 'SKIPPED',
          skipReason: 'AD',
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
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
    expect(prisma.vkParsingSource.update).toHaveBeenCalledWith(
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
    expect(prisma.vkParsingSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'source-1' },
        data: expect.objectContaining({
          syncStatus: 'ERROR',
          nextSyncAt: null,
          lastErrorCode: `vk_${code}`,
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

    expect(prisma.vkParsingSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          syncStatus: 'ERROR',
          nextSyncAt: null,
          lastErrorCode: 'vk_14',
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

    expect(prisma.vkParsingPost.upsert).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'source-1' },
        data: expect.objectContaining({
          syncStatus: 'IDLE',
          lastFetchedCount: 0,
          lastImportedCount: 0,
        }),
      }),
    );
  });

  it('backs off terminal private or content-blocked VK sources as source errors', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        error: { error_code: 19, error_msg: 'Content blocked' },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'source-1' },
        data: expect.objectContaining({
          syncStatus: 'ERROR',
          nextSyncAt: null,
          consecutiveFailures: 1,
          lastErrorCode: 'vk_19',
        }),
      }),
    );
  });

  it('imports up to 100 posts in one batch', async () => {
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
    expect(prisma.vkParsingPost.upsert).toHaveBeenCalledTimes(100);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
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

    const upsertPayload = prisma.vkParsingPost.upsert.mock.calls[0]?.[0];
    expect(upsertPayload.update.status).toBe('CHANGED_AFTER_PUBLISH');
  });

  it('only marks fetched-window missing VK posts unavailable after threshold and spot-check', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
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

    expect(String((global.fetch as jest.Mock).mock.calls[1]?.[0] ?? '')).toContain(
      'wall.getById',
    );
    expect(prisma.vkParsingPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'missing-post-1' },
        data: expect.objectContaining({
          status: 'UNAVAILABLE',
          missingSinceAt: expect.any(Date),
          unavailableAt: expect.any(Date),
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
        }),
      }),
    );
  });

  it('does not mark fetched-window missing VK posts unavailable before confirmation threshold', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
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
        where: { id: { in: ['missing-post-1'] } },
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

    expect(maxBotLinkService.resolveBotId).toHaveBeenCalledWith({ chatId: 'channel-1' });
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
    expect(prisma.vkParsingPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'post-1' },
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
      context: engagementContext,
      source: 'vk_parsing',
      botId: 'bot-1',
    });
  });
});
