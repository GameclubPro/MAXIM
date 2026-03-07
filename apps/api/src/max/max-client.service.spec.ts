import { MaxClientService } from './max-client.service';
import { of } from 'rxjs';

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    quit: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('MaxClientService inline keyboard guardrails', () => {
  function createService(
    httpService: { request?: jest.Mock } = {},
    configOverrides: Partial<Record<string, string>> = {},
  ) {
    const configService = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'MAX_API_BASE_URL') {
          return 'https://platform-api.max.ru';
        }
        if (key === 'MAX_BOT_TOKEN') {
          return 'test-token';
        }
        if (key === 'REDIS_URL') {
          return 'redis://localhost:6379/0';
        }
        throw new Error(`Unexpected key ${key}`);
      }),
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key in configOverrides) {
          return configOverrides[key];
        }
        return fallback;
      }),
    };
    const actionHealthService = {
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
    };

    return new MaxClientService(
      httpService as never,
      configService as never,
      actionHealthService as never,
      undefined,
    );
  }

  it('trims inline keyboard buttons to 210 and logs warning', async () => {
    const service = createService();
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    const buttons = Array.from({ length: 220 }, (_, index) => ({
      type: 'callback' as const,
      text: `B${index + 1}`,
      payload: `p${index + 1}`,
    }));

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [buttons],
      debugContext: {
        screen: 'home',
        action: 'render',
      },
    }) as Array<Array<Record<string, unknown>>> | null;

    const delivered = (normalized ?? []).reduce((acc, row) => acc + row.length, 0);
    expect(delivered).toBe(210);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedButtons: 220,
        deliveredButtons: 210,
        screen: 'home',
        action: 'render',
      }),
      expect.stringContaining('Inline keyboard exceeds MAX limit'),
    );

    await service.onModuleDestroy();
  });

  it('keeps inline keyboard as-is when button count is within limit', async () => {
    const service = createService();
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    const buttons = Array.from({ length: 3 }, (_, index) => ({
      type: 'callback' as const,
      text: `B${index + 1}`,
      payload: `p${index + 1}`,
    }));

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [buttons],
    }) as Array<Array<Record<string, unknown>>> | null;

    const delivered = (normalized ?? []).reduce((acc, row) => acc + row.length, 0);
    expect(delivered).toBe(3);
    expect(warnSpy).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('supports open_app button type for native miniapp opening', async () => {
    const service = createService();

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [
        [
          {
            type: 'open_app',
            text: 'Открыть miniapp',
            webApp: 'https://maxim.play-team.ru/app/',
            contactId: '613002203036',
          },
        ],
      ],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized).toEqual([
      [
        {
          type: 'open_app',
          text: 'Открыть miniapp',
          web_app: 'https://maxim.play-team.ru/app/',
          contact_id: '613002203036',
        },
      ],
    ]);

    await service.onModuleDestroy();
  });

  it('parses official message snapshots with views and deduplicates pages', async () => {
    const latestTs = Date.parse('2026-03-07T09:00:00.000Z');
    const previousTs = Date.parse('2026-03-06T09:00:00.000Z');
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  timestamp: latestTs,
                  body: { mid: 'mid-2' },
                  stat: { views: 260 },
                  url: 'https://max.ru/news/post-2',
                },
                {
                  timestamp: previousTs,
                  body: { mid: 'mid-1' },
                  stat: { views: 120 },
                  url: 'https://max.ru/news/post-1',
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  timestamp: previousTs,
                  body: { mid: 'mid-1' },
                  stat: { views: 120 },
                  url: 'https://max.ru/news/post-1',
                },
              ],
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.listMessageSnapshots('channel-1', {
      from: '2026-03-06T00:00:00.000Z',
      to: '2026-03-07T12:00:00.000Z',
      count: 2,
      maxPages: 3,
    });

    expect(result).toEqual([
      {
        chatId: 'channel-1',
        messageId: 'mid-2',
        publishedAt: '2026-03-07T09:00:00.000Z',
        publishedAtMs: latestTs,
        url: 'https://max.ru/news/post-2',
        views: 260,
      },
      {
        chatId: 'channel-1',
        messageId: 'mid-1',
        publishedAt: '2026-03-06T09:00:00.000Z',
        publishedAtMs: previousTs,
        url: 'https://max.ru/news/post-1',
        views: 120,
      },
    ]);
    expect(httpService.request).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
  });

  it('extends webhook subscriptions with churn update types', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              subscriptions: [
                {
                  url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
                  update_types: ['message_created', 'user_added', 'bot_started'],
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ data: {} })),
    };
    const service = createService(httpService, {
      APP_BASE_URL: 'https://maxim.play-team.ru',
      MAX_BOT_ID: '777000_bot',
      MAX_WEBHOOK_SECRET_PATH: 'secret-path',
      MAX_WEBHOOK_HEADER_SECRET: 'header-secret',
    });

    const result = await service.ensureWebhookSubscription([
      'message_created',
      'user_added',
      'user_removed',
      'bot_added',
      'bot_removed',
      'bot_started',
    ]);

    expect(result).toEqual({
      url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
      updateTypes: [
        'bot_added',
        'bot_removed',
        'bot_started',
        'message_created',
        'user_added',
        'user_removed',
      ],
    });
    expect(httpService.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api.max.ru/subscriptions',
        data: {
          url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
          update_types: [
            'bot_added',
            'bot_removed',
            'bot_started',
            'message_created',
            'user_added',
            'user_removed',
          ],
          secret: 'header-secret',
        },
      }),
    );

    await service.onModuleDestroy();
  });
});
