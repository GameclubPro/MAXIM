import { MaxClientService } from './max-client.service';
import { of } from 'rxjs';

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('MaxClientService inline keyboard guardrails', () => {
  function createService(
    httpService: { request?: jest.Mock } = {},
    configOverrides: Partial<Record<string, string>> = {},
    actionQueue?: { add: jest.Mock; getJob: jest.Mock },
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
      actionQueue as never,
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

  it('publishes message and resolves post link via follow-up message fetch', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-1',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-rules-1' },
                  message_url: 'https://max.ru/chats/chat-1/message/123',
                },
              ],
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата', {
      textFormat: 'markdown',
    });

    expect(result).toEqual({
      messageId: 'mid-rules-1',
      url: 'https://max.ru/chats/chat-1/message/123',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: { text: 'Правила чата', format: 'markdown' },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/messages',
        params: { message_ids: 'mid-rules-1' },
      }),
    );

    await service.onModuleDestroy();
  });

  it('uses link returned directly by MAX send response when available', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            message_id: 'mid-rules-2',
            url: 'https://max.ru/chats/chat-1/message/456',
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила');

    expect(result).toEqual({
      messageId: 'mid-rules-2',
      url: 'https://max.ru/chats/chat-1/message/456',
    });
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('publishes custom attachment-only message and resolves post link', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-custom-1',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-custom-1' },
                  message_url: 'https://max.ru/chats/chat-1/message/custom-1',
                },
              ],
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendCustomMessageImmediateWithResolvedLink('chat-1', {
      attachments: [
        {
          type: 'image',
          payload: { token: 'upload-token-1' },
        },
      ],
    });

    expect(result).toEqual({
      messageId: 'mid-custom-1',
      url: 'https://max.ru/chats/chat-1/message/custom-1',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          attachments: [
            {
              type: 'image',
              payload: { token: 'upload-token-1' },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('does not fail when MAX omits a direct message url for chat posts', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-3',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-rules-3' },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-3',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата');

    expect(result).toEqual({
      messageId: 'mid-rules-3',
      url: null,
    });

    await service.onModuleDestroy();
  });

  it('recovers direct post link via GET /messages/{id} when batch lookup has no url', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-4',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-rules-4' },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-4',
              url: 'https://max.ru/chats/chat-1/message/789',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата');

    expect(result).toEqual({
      messageId: 'mid-rules-4',
      url: 'https://max.ru/chats/chat-1/message/789',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/messages/mid-rules-4',
      }),
    );

    await service.onModuleDestroy();
  });

  it('builds chat post link from message id tail when MAX omits direct url fields', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-5',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  recipient: {
                    chat_id: -71768670111751,
                    chat_type: 'chat',
                  },
                  body: {
                    mid: 'mid.ffffbeba0de977f9019cd37c90d90068',
                    seq: 116200222364336232,
                  },
                },
              ],
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата');

    expect(result).toEqual({
      messageId: 'mid-rules-5',
      url: 'https://max.ru/c/-71768670111751/AZzTfJDZAGg',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/messages',
        params: { message_ids: 'mid-rules-5' },
      }),
    );

    await service.onModuleDestroy();
  });

  it('sends reply link payload when message link is provided', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            mid: 'mid-rules-link-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessage(
      'chat-1',
      'Нарушение',
      {
        textFormat: 'markdown',
        messageLink: {
          type: 'reply',
          mid: 'mid-rules-1',
        },
      },
      { immediate: true },
    );

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: 'Нарушение',
          format: 'markdown',
          link: {
            type: 'reply',
            mid: 'mid-rules-1',
          },
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('pins a message in chat without system notify when requested', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            success: true,
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.pinMessage('chat-1', 'mid-rules-3', false);

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api.max.ru/chats/chat-1/pin',
        data: {
          message_id: 'mid-rules-3',
          notify: false,
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('parses official message snapshots with views and deduplicates pages', async () => {
    const latestTs = Date.parse('2026-03-07T09:00:00.000Z');
    const previousTs = Date.parse('2026-03-06T09:00:00.000Z');
    const rangeToTs = Date.parse('2026-03-07T12:00:00.000Z');
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
                  stat: {
                    views: 260,
                    reactions: [
                      { emoji: '🔥', count: 5 },
                      { emoji: '❤️', count: 3 },
                    ],
                  },
                  url: 'https://max.ru/news/post-2',
                },
                {
                  timestamp: previousTs,
                  body: { mid: 'mid-1' },
                  stat: { views: 120, reactions: { '👍': 2 } },
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
        reactions: [
          { emoji: '🔥', count: 5 },
          { emoji: '❤️', count: 3 },
        ],
      },
      {
        chatId: 'channel-1',
        messageId: 'mid-1',
        publishedAt: '2026-03-06T09:00:00.000Z',
        publishedAtMs: previousTs,
        url: 'https://max.ru/news/post-1',
        views: 120,
        reactions: [{ emoji: '👍', count: 2 }],
      },
    ]);
    expect(httpService.request).toHaveBeenCalledTimes(2);
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/messages',
        params: {
          chat_id: 'channel-1',
          count: 2,
          to: Math.floor(rangeToTs / 1_000),
        },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/messages',
        params: {
          chat_id: 'channel-1',
          count: 2,
          to: Math.floor((previousTs - 1_000) / 1_000),
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('returns only admins with chat edit permission from members/admins payload', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            members: [
              {
                user_id: 'admin-readonly',
                role: 'admin',
                permissions: ['delete_messages'],
              },
              {
                user_id: 'admin-editor',
                role: 'admin',
                permissions: ['change_chat_info'],
              },
              {
                user_id: 'owner-1',
                role: 'owner',
                permissions: ['delete_messages'],
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatEditableAdminIds('chat-1');

    expect(result).toEqual(['admin-editor', 'owner-1']);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/chats/chat-1/members/admins',
      }),
    );

    await service.onModuleDestroy();
  });

  it('treats explicit can_manage_chat=false as no edit access', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            members: [
              {
                user_id: 'admin-readonly',
                role: 'admin',
                can_manage_chat: false,
              },
              {
                user_id: 'admin-editor',
                role: 'admin',
                can_manage_chat: true,
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatEditableAdminIds('chat-1');

    expect(result).toEqual(['admin-editor']);
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

describe('MaxClientService delayed member actions', () => {
  function createServiceWithQueue(queue: { add: jest.Mock; getJob: jest.Mock }) {
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
      get: jest.fn((key: string, fallback?: unknown) => fallback),
    };
    const actionHealthService = {
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
    };

    return new MaxClientService(
      {} as never,
      configService as never,
      actionHealthService as never,
      queue as never,
    );
  }

  it('uses deterministic queue job id for delayed unban', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createServiceWithQueue(queue);

    await service.unbanMember('chat-1', 'user-1', { delayMs: 60_000 });

    expect(queue.getJob).toHaveBeenCalledWith('member-action:UNBAN_MEMBER:chat-1:user-1');
    expect(queue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'UNBAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        idempotencyKey: 'member-action:UNBAN_MEMBER:chat-1:user-1',
      }),
      expect.objectContaining({
        jobId: 'member-action:UNBAN_MEMBER:chat-1:user-1',
        delay: 60_000,
      }),
    );

    await service.onModuleDestroy();
  });

  it('removes queued delayed unban when cancelling manual override', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue({ remove }),
    };
    const service = createServiceWithQueue(queue);

    await service.cancelScheduledUnban('chat-1', 'user-2');

    expect(queue.getJob).toHaveBeenCalledWith('member-action:UNBAN_MEMBER:chat-1:user-2');
    expect(remove).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });
});
