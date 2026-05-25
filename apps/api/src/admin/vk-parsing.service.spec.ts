import { ForbiddenException } from '@nestjs/common';
import { ChatEntityType } from '../prisma/prisma-client';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { VkParsingService } from './vk-parsing.service';

type MockFetchResponse = {
  ok: boolean;
  status?: number;
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
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
      },
      vkParsingPost: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
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

    const service = new VkParsingService(
      prisma as never,
      adminService as never,
      maxClient as never,
      maxBotLinkService as never,
      createConfig({
        VK_SERVICE_TOKEN: 'vk-service-token',
        VK_API_BASE_URL: 'https://api.vk.ru',
        VK_API_VERSION: '5.131',
        VK_PARSING_ALLOWED_USER_IDS: '183470701,98315271',
        VK_PARSING_SYNC_INTERVAL_MS: 600_000,
        VK_PARSING_FETCH_COUNT: 20,
        ...config,
      }) as never,
    );

    return {
      service,
      prisma,
      adminService,
      maxClient,
      maxBotLinkService,
    };
  }

  it('denies users outside the VK parsing allowlist', async () => {
    const { service, adminService } = createFixture();

    await expect(
      service.listVkParsing('channel-1', { userId: 'not-allowed' } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(adminService.assertChatAdmin).not.toHaveBeenCalled();
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
    prisma.vkParsingPost.findUnique.mockResolvedValue(null);
    prisma.vkParsingSource.findMany.mockResolvedValue([source]);

    await service.addSource('channel-1', { userId: '183470701' } as never, {
      url: 'https://vk.ru/avto_prodaja_rb',
    });

    expect(prisma.vkParsingPost.upsert).toHaveBeenCalledTimes(1);
    const upsertPayload = prisma.vkParsingPost.upsert.mock.calls[0]?.[0];
    expect(upsertPayload.create.text).toBe('Продам авто');
    expect(upsertPayload.create.photoUrls).toEqual(['https://sun1.example/large.jpg']);
    expect(upsertPayload.create.linkUrls).toEqual(['https://example.com/car']);
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

    await service.publishPost(
      'channel-1',
      'post-1',
      { userId: '183470701' } as never,
      {
        text: 'Мой текст',
        photoUrls: [],
        linkUrls: [],
      },
    );

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
