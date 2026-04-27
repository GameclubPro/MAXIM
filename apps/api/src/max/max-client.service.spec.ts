import { MAX_API_SOURCE_TAGS, MaxClientService } from './max-client.service';
import { of, throwError } from 'rxjs';
import Redis from 'ioredis';

jest.mock('ioredis', () => {
  const store = new Map<string, { value: string; expiresAtMs: number | null }>();
  const readEntry = (key: string) => {
    const entry = store.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  };
  const RedisMock = Object.assign(
    jest.fn().mockImplementation(() => {
      const instance = {
        incr: jest.fn().mockImplementation(async (key: string) => {
          const current = Number(readEntry(key)?.value ?? '0');
          const next = current + 1;
          store.set(key, {
            value: String(next),
            expiresAtMs: readEntry(key)?.expiresAtMs ?? null,
          });
          return next;
        }),
        expire: jest.fn().mockImplementation(async (key: string, ttlSec: number) => {
          const entry = readEntry(key);
          if (!entry) {
            return 0;
          }
          store.set(key, {
            ...entry,
            expiresAtMs: Date.now() + ttlSec * 1_000,
          });
          return 1;
        }),
        pexpire: jest.fn().mockImplementation(async (key: string, ttlMs: number) => {
          const entry = readEntry(key);
          if (!entry) {
            return 0;
          }
          store.set(key, {
            ...entry,
            expiresAtMs: Date.now() + ttlMs,
          });
          return 1;
        }),
        pttl: jest.fn().mockImplementation(async (key: string) => {
          const entry = readEntry(key);
          if (!entry) {
            return -2;
          }
          if (entry.expiresAtMs === null) {
            return -1;
          }
          return Math.max(0, entry.expiresAtMs - Date.now());
        }),
        get: jest.fn().mockImplementation(async (key: string) => readEntry(key)?.value ?? null),
        set: jest
          .fn()
          .mockImplementation(async (key: string, value: string, ...args: unknown[]) => {
            let expiresAtMs: number | null = null;
            if (args[0] === 'EX' && typeof args[1] === 'number' && Number.isFinite(args[1])) {
              expiresAtMs = Date.now() + args[1] * 1_000;
            }
            if (args[0] === 'PX' && typeof args[1] === 'number' && Number.isFinite(args[1])) {
              expiresAtMs = Date.now() + args[1];
            }
            store.set(key, {
              value,
              expiresAtMs,
            });
            return 'OK';
          }),
        del: jest.fn().mockImplementation(async (...keys: string[]) => {
          let deleted = 0;
          for (const key of keys) {
            if (store.delete(key)) {
              deleted += 1;
            }
          }
          return deleted;
        }),
        eval: jest
          .fn()
          .mockImplementation(
            async (script: string, numKeys: number, ...args: Array<string | number>) => {
              if (!script.includes('PTTL') || !script.includes('INCR')) {
                throw new Error('Unexpected Redis eval script');
              }

              const keys = args.slice(0, numKeys).map((value) => String(value));
              const argValues = args.slice(numKeys);
              const ttlMs = Number(argValues[argValues.length - 1] ?? 0);

              for (let index = 0; index < numKeys; index += 1) {
                const count = Number(readEntry(keys[index])?.value ?? '0');
                const limit = Number(argValues[index] ?? 0);
                if (count >= limit) {
                  const entry = readEntry(keys[index]);
                  const retryAfterMs =
                    entry?.expiresAtMs !== null && entry?.expiresAtMs !== undefined
                      ? Math.max(1, entry.expiresAtMs - Date.now())
                      : ttlMs;
                  return [0, index + 1, retryAfterMs];
                }
              }

              for (const key of keys) {
                const current = Number(readEntry(key)?.value ?? '0') + 1;
                store.set(key, {
                  value: String(current),
                  expiresAtMs: Date.now() + ttlMs,
                });
              }

              return [1, 0, 0];
            },
          ),
        quit: jest.fn().mockResolvedValue(undefined),
        multi: jest.fn().mockImplementation(() => {
          const operations: Array<['incr' | 'expire', ...unknown[]]> = [];
          const pipeline = {
            incr: (key: string) => {
              operations.push(['incr', key]);
              return pipeline;
            },
            expire: (key: string, ttlSec: number) => {
              operations.push(['expire', key, ttlSec]);
              return pipeline;
            },
            exec: jest.fn().mockImplementation(async () => {
              const results: Array<[null, unknown]> = [];
              for (const [method, ...args] of operations) {
                results.push([
                  null,
                  await (instance[method] as (...values: unknown[]) => Promise<unknown>)(...args),
                ]);
              }
              return results;
            }),
          };
          return pipeline;
        }),
      };

      return instance;
    }),
    {
      __store: store,
    },
  );

  return {
    __esModule: true,
    default: RedisMock,
  };
});

describe('MaxClientService inline keyboard guardrails', () => {
  beforeEach(() => {
    (
      Redis as unknown as { __store: Map<string, { value: string; expiresAtMs: number | null }> }
    ).__store.clear();
  });

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
      recordSuccessForLane: jest.fn(),
      recordFailureForLane: jest.fn(),
      getSnapshot: jest.fn(),
    };
    const botRegistry = {
      getDefaultBot: jest.fn().mockReturnValue({
        id: '777000_bot',
        token: 'test-token',
        webhookSecretPath: 'secret-path',
        webhookHeaderSecret: 'header-secret',
        webhookUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
        maskedWebhookUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
      }),
      getBotById: jest.fn((botId?: string | null) =>
        !botId || botId === '777000_bot'
          ? {
              id: '777000_bot',
              token: 'test-token',
              webhookSecretPath: 'secret-path',
              webhookHeaderSecret: 'header-secret',
              webhookUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
              maskedWebhookUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
            }
          : null,
      ),
      getConfiguredWebhookSubscriptionTarget: jest.fn(() => ({
        url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
        maskedUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
      })),
    };
    const botContext = {
      getActiveBotId: jest.fn().mockReturnValue(null),
      runWithBot: jest.fn((_botId: string, callback: () => unknown) => callback()),
    };

    return new MaxClientService(
      httpService as never,
      configService as never,
      actionHealthService as never,
      botRegistry as never,
      botContext as never,
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

  it('throws when MAX mutation responds with success=false under HTTP 200', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-1',
                    text: 'Текст',
                    format: 'html',
                    attachments: [],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              success: false,
              message: 'Error on message edit',
            },
          }),
        ),
    };
    const service = createService(httpService);

    await expect(
      service.editMessageInlineKeyboard('chat-1', 'mid-edit-1', 'Текст', {
        button: {
          text: 'Открыть',
          url: 'https://maxim.play-team.ru/app/',
        },
      }),
    ).rejects.toThrow('Error on message edit');
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api.max.ru/messages',
        params: {
          chat_id: 'chat-1',
          message_id: 'mid-edit-1',
        },
        data: expect.objectContaining({
          text: 'Текст',
          format: 'html',
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('answers callback with notification and inline keyboard update in one request', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            success: true,
            message: {
              message_id: 'mid-reply-1',
            },
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.answerCallback('callback-1', 'Голос учтён', {
      text: 'Опрос\n\n1. Соло - 1 (100%)',
      options: {
        buttons: [[{ type: 'callback', text: 'Соло (1)', payload: 'poll|poll-1|1|0' }]],
      },
    });

    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api.max.ru/answers',
        params: {
          callback_id: 'callback-1',
        },
        data: {
          notification: 'Голос учтён',
          message: {
            text: 'Опрос\n\n1. Соло - 1 (100%)',
            attachments: [
              {
                type: 'inline_keyboard',
                payload: {
                  buttons: [[{ type: 'callback', text: 'Соло (1)', payload: 'poll|poll-1|1|0' }]],
                },
              },
            ],
          },
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('sends direct messages via user_id when notifying a private user', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-private-1',
            recipient: {
              chat_id: '165176099',
            },
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateToUser('user-42', 'Личное уведомление');

    expect(result).toEqual({
      messageId: 'mid-private-1',
      url: null,
      chatId: '165176099',
    });
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api.max.ru/messages',
        params: {
          user_id: 'user-42',
        },
        data: {
          text: 'Личное уведомление',
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('reposts a source chat message as bot copy with preserved attachments and reply link', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-source-1',
                    text: 'Исходный пост админа',
                    markup: [
                      {
                        from: 0,
                        type: 'strong',
                        length: 8,
                      },
                    ],
                    attachments: [
                      {
                        type: 'image',
                        payload: { token: 'upload-token-1' },
                      },
                    ],
                  },
                  link: {
                    type: 'reply',
                    message: {
                      mid: 'mid-parent-1',
                    },
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              mid: 'mid-copy-1',
              url: 'https://max.ru/chats/chat-1/message/789',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageCopyWithInlineKeyboard(
      'chat-1',
      'mid-source-1',
      'Фолбэк текст',
      {
        button: {
          text: '💬 Комментарии',
          url: 'https://maxim.play-team.ru/app/',
        },
      },
    );

    expect(result).toEqual({
      messageId: 'mid-copy-1',
      url: 'https://max.ru/chats/chat-1/message/789',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/messages',
        params: { message_ids: 'mid-source-1' },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: '<strong>Исходный</strong> пост админа',
          format: 'html',
          link: {
            type: 'reply',
            mid: 'mid-parent-1',
          },
          attachments: [
            {
              type: 'image',
              payload: { token: 'upload-token-1' },
            },
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: '💬 Комментарии',
                      url: 'https://maxim.play-team.ru/app/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('uses fallback text and linked attachments when reposting a forwarded message', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-forward-source-1',
                    text: '',
                    attachments: [],
                  },
                  link: {
                    type: 'forward',
                    message: {
                      text: 'Пересланный пост',
                      attachments: [
                        {
                          type: 'image',
                          payload: { token: 'upload-token-forward-1' },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              mid: 'mid-forward-copy-1',
              url: 'https://max.ru/chats/chat-1/message/790',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageCopyWithInlineKeyboard(
      'chat-1',
      'mid-forward-source-1',
      'Пересланный пост',
      {
        button: {
          text: '💬 Комментарии',
          url: 'https://maxim.play-team.ru/app/',
        },
      },
    );

    expect(result).toEqual({
      messageId: 'mid-forward-copy-1',
      url: 'https://max.ru/chats/chat-1/message/790',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: 'Пересланный пост',
          attachments: [
            {
              type: 'image',
              payload: { token: 'upload-token-forward-1' },
            },
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: '💬 Комментарии',
                      url: 'https://maxim.play-team.ru/app/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('preserves MAX body markup when editing inline keyboard on an existing message', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-markup-1',
                    text: '🔥Привет мир',
                    markup: [
                      {
                        from: 2,
                        type: 'strong',
                        length: 6,
                      },
                    ],
                    attachments: [],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              success: true,
            },
          }),
        ),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard('chat-1', 'mid-edit-markup-1', '🔥Привет мир', {
      button: {
        text: 'Открыть',
        url: 'https://maxim.play-team.ru/app/',
      },
    });

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api.max.ru/messages',
        params: {
          chat_id: 'chat-1',
          message_id: 'mid-edit-markup-1',
        },
        data: expect.objectContaining({
          text: '🔥<strong>Привет</strong> мир',
          format: 'html',
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('extracts MAX body markup as markdown text for imported rules', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
                {
                  body: {
                    mid: 'mid-rules-markup-1',
                    text: '🔥MAX Docs',
                    markup: [
                      {
                        from: 2,
                        type: 'strong',
                        length: 8,
                      },
                      {
                        from: 2,
                        type: 'emphasized',
                        length: 8,
                      },
                      {
                        from: 2,
                        type: 'underline',
                        length: 8,
                      },
                      {
                        from: 2,
                        type: 'link',
                        length: 8,
                        url: 'https://dev.max.ru/docs-api',
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getMessageTextAsMarkdown('mid-rules-markup-1');

    expect(result).toBe('🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)');
    await service.onModuleDestroy();
  });

  it('falls back to direct message lookup when batch lookup returns a different message', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-other-1',
                    text: 'Не тот пост',
                    attachments: [
                      {
                        type: 'image',
                        payload: { token: 'wrong-image-token' },
                      },
                    ],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              body: {
                mid: 'mid-edit-fallback-1',
                text: 'Старый опрос',
                attachments: [
                  {
                    type: 'inline_keyboard',
                    payload: {
                      buttons: [[{ type: 'callback', text: 'Да (1)', payload: 'poll|poll-1|1|0' }]],
                    },
                  },
                ],
              },
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              success: true,
            },
          }),
        ),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard('chat-1', 'mid-edit-fallback-1', 'Итоги опроса', {
      buttons: [[{ type: 'callback', text: 'Да (2)', payload: 'poll|poll-1|1|0' }]],
    });

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/messages/mid-edit-fallback-1',
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api.max.ru/messages',
        params: {
          chat_id: 'chat-1',
          message_id: 'mid-edit-fallback-1',
        },
        data: {
          text: 'Итоги опроса',
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [[{ type: 'callback', text: 'Да (2)', payload: 'poll|poll-1|1|0' }]],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('honors explicit html text format when editing an existing message', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-html-1',
                    text: 'Старый текст',
                    attachments: [],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              success: true,
            },
          }),
        ),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard('chat-1', 'mid-edit-html-1', '<p>Новый текст</p>', {
      textFormat: 'html',
    });

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api.max.ru/messages',
        params: {
          chat_id: 'chat-1',
          message_id: 'mid-edit-html-1',
        },
        data: expect.objectContaining({
          text: '<p>Новый текст</p>',
          format: 'html',
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('omits text when editing inline keyboard on forwarded messages with empty body text', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-forward-1',
                    text: '',
                    attachments: [],
                  },
                  link: {
                    type: 'forward',
                    message: {
                      text: 'Пересланный текст',
                    },
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              success: true,
            },
          }),
        ),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard('chat-1', 'mid-edit-forward-1', 'Пересланный текст', {
      button: {
        text: 'Открыть',
        url: 'https://maxim.play-team.ru/app/',
      },
    });

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api.max.ru/messages',
        params: {
          chat_id: 'chat-1',
          message_id: 'mid-edit-forward-1',
        },
        data: {
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Открыть',
                      url: 'https://maxim.play-team.ru/app/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('sends attachment-only reply messages with inline keyboard', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            success: true,
            message: {
              message_id: 'mid-reply-1',
            },
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessageReplyWithInlineKeyboard('chat-1', 'mid-source-1', 'Действия к посту', {
      button: {
        text: 'Открыть',
        url: 'https://maxim.play-team.ru/app/',
      },
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api.max.ru/messages',
        params: {
          chat_id: 'chat-1',
        },
        data: {
          text: 'Действия к посту',
          link: {
            type: 'reply',
            mid: 'mid-source-1',
          },
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Открыть',
                      url: 'https://maxim.play-team.ru/app/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

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

  it('passes request options to follow-up link resolution after send', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            mid: 'mid-rules-bot-1',
          },
        }),
      ),
    };
    const service = createService(httpService);
    const resolveSpy = jest
      .spyOn(service as any, 'resolveMessageLink')
      .mockResolvedValue('https://max.ru/chats/chat-1/message/999');

    const result = await service.sendMessageImmediateWithResolvedLink(
      'chat-1',
      'Правила чата',
      undefined,
      {
        botId: '777000_bot',
        trafficClass: 'critical',
      },
    );

    expect(result).toEqual({
      messageId: 'mid-rules-bot-1',
      url: 'https://max.ru/chats/chat-1/message/999',
    });
    expect(resolveSpy).toHaveBeenCalledWith(
      'mid-rules-bot-1',
      expect.objectContaining({
        botId: '777000_bot',
        trafficClass: 'critical',
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps successful send result when follow-up link resolution fails', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            mid: 'mid-rules-send-ok-1',
          },
        }),
      ),
    };
    const service = createService(httpService);
    const resolveSpy = jest
      .spyOn(service as any, 'resolveMessageLink')
      .mockRejectedValue(new Error('resolve failed'));
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата');

    expect(result).toEqual({
      messageId: 'mid-rules-send-ok-1',
      url: null,
    });
    expect(resolveSpy).toHaveBeenCalledWith('mid-rules-send-ok-1', {});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'mid-rules-send-ok-1',
        err: 'resolve failed',
      }),
      'Failed to resolve MAX message link after successful send',
    );

    await service.onModuleDestroy();
  });

  it('does not count ignored terminal send failures in action health metrics', async () => {
    const error = {
      response: {
        status: 404,
        data: {
          code: 'chat.not.found',
          message: 'Chat not found',
        },
      },
    };
    const httpService = {
      request: jest.fn().mockReturnValueOnce(throwError(() => error)),
    };
    const service = createService(httpService);
    const actionHealthService = (
      service as unknown as {
        actionHealthService: {
          recordSuccess: jest.Mock;
          recordFailure: jest.Mock;
        };
      }
    ).actionHealthService;

    await expect(
      service.sendMessageImmediateWithId('chat-1', 'Правила', undefined, {
        ignoreFailureMetricStatuses: [404],
      }),
    ).rejects.toBe(error);

    expect(actionHealthService.recordFailure).not.toHaveBeenCalled();
    expect(actionHealthService.recordSuccess).not.toHaveBeenCalled();

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

  it('recovers the correct post link when batch lookup returns a different message id', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-4b',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-other-4b' },
                  url: 'https://max.ru/chats/chat-1/message/wrong',
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-4b',
              url: 'https://max.ru/chats/chat-1/message/correct',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата');

    expect(result).toEqual({
      messageId: 'mid-rules-4b',
      url: 'https://max.ru/chats/chat-1/message/correct',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/messages/mid-rules-4b',
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
                    mid: 'mid-rules-5',
                    seq: '116200222364336232',
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

  it('uploads video via /uploads?type=video and falls back to the issued token', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/video-1',
              token: 'video-upload-token-1',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {},
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.uploadVideo(
      Buffer.from('video-binary'),
      'channel-suggestion-video.mp4',
      'video/mp4',
    );

    expect(result).toEqual({ token: 'video-upload-token-1' });
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api.max.ru/uploads',
        params: {
          type: 'video',
        },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://upload.max.ru/video-1',
      }),
    );

    await service.onModuleDestroy();
  });

  it('sends generic media attachments together with inline keyboard', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            mid: 'mid-video-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessage(
      'chat-1',
      'Видео предложки',
      {
        textFormat: 'markdown',
        attachments: [{ type: 'video', payload: { token: 'video-upload-token-1' } }],
        buttons: [[{ type: 'callback', text: '✅ Подтвердить', payload: 'review|publish' }]],
      },
      { immediate: true },
    );

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: 'Видео предложки',
          format: 'markdown',
          attachments: [
            {
              type: 'video',
              payload: { token: 'video-upload-token-1' },
            },
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [{ type: 'callback', text: '✅ Подтвердить', payload: 'review|publish' }],
                ],
              },
            },
          ],
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

  it('returns current bot member access with granular permissions', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            user_id: 'bot-1',
            role: 'admin',
            is_admin: true,
            permissions: ['add_remove_members', 'change_chat_info'],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getCurrentChatMemberAccess('chat-1');

    expect(result).toEqual({
      userId: 'bot-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['add_remove_members', 'change_chat_info'],
    });
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/chats/chat-1/members/me',
      }),
    );

    await service.onModuleDestroy();
  });

  it('passes timeout override to targeted chat member lookups', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                role: 'member',
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.getChatMembersAccess('chat-1', ['user-1'], {
      trafficClass: 'critical',
      timeoutMs: 1_234,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/chats/chat-1/members?user_ids=user-1',
        timeout: 1_234,
      }),
    );

    await service.onModuleDestroy();
  });

  it('passes timeout override to chat admin lookups', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                role: 'admin',
                is_admin: true,
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.getChatAdminIds('chat-1', {
      trafficClass: 'critical',
      timeoutMs: 1_234,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/chats/chat-1/members/admins',
        timeout: 1_234,
      }),
    );

    await service.onModuleDestroy();
  });

  it('paginates chat admin lookups until MAX stops returning a marker', async () => {
    const request = jest.fn();
    for (let index = 0; index < 21; index += 1) {
      request.mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: `user-${index + 1}`,
                role: 'admin',
                is_admin: true,
              },
            ],
            marker: index < 20 ? index + 1 : null,
          },
        }),
      );
    }
    const service = createService({ request });

    await expect(service.getChatAdminIds('chat-1')).resolves.toEqual(
      Array.from({ length: 21 }, (_, index) => `user-${index + 1}`),
    );
    expect(request).toHaveBeenCalledTimes(21);

    await service.onModuleDestroy();
  });

  it('returns null when requested chat member is absent', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMemberAccess('chat-1', 'user-404');

    expect(result).toBeNull();
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/chats/chat-1/members?user_ids=user-404',
      }),
    );

    await service.onModuleDestroy();
  });

  it('returns chat member profiles with avatar urls and usernames', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                first_name: 'Алексей',
                username: 'aleksey',
                avatar_url: 'https://cdn.max.ru/u/1/avatar-small.jpg',
                full_avatar_url: 'https://cdn.max.ru/u/1/avatar-full.jpg',
              },
              {
                user: {
                  user_id: 'user-2',
                  first_name: 'Марина',
                  username: 'marina',
                  avatar_url: 'https://cdn.max.ru/u/2/avatar-small.jpg',
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMemberProfiles('chat-1', ['user-1', 'user-2']);

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/chats/chat-1/members?user_ids=user-1&user_ids=user-2',
      }),
    );
    expect(result.get('user-1')).toEqual({
      userId: 'user-1',
      displayName: 'Алексей',
      username: 'aleksey',
      avatarUrl: 'https://cdn.max.ru/u/1/avatar-full.jpg',
      profileUrl: null,
    });
    expect(result.get('user-2')).toEqual({
      userId: 'user-2',
      displayName: 'Марина',
      username: 'marina',
      avatarUrl: 'https://cdn.max.ru/u/2/avatar-small.jpg',
      profileUrl: null,
    });

    await service.onModuleDestroy();
  });

  it('returns paginated chat member roster items with roles, avatars and bot markers', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                first_name: 'Алексей',
                username: 'aleksey',
                role: 'owner',
                full_avatar_url: 'https://cdn.max.ru/u/1/avatar-full.jpg',
              },
              {
                user: {
                  user_id: 'moderation_bot',
                  first_name: 'MAXIM',
                  username: 'moderation_bot',
                  avatar_url: 'https://cdn.max.ru/u/bot/avatar.jpg',
                  is_bot: true,
                },
                role: 'admin',
              },
            ],
            marker: 'page-2',
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMembersPage('chat-1', {
      limit: 100,
      marker: 'page-1',
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/chats/chat-1/members',
        params: {
          count: 100,
          marker: 'page-1',
        },
      }),
    );
    expect(result).toEqual({
      items: [
        {
          userId: 'user-1',
          displayName: 'Алексей',
          username: 'aleksey',
          avatarUrl: 'https://cdn.max.ru/u/1/avatar-full.jpg',
          profileUrl: null,
          role: 'owner',
          isBot: false,
        },
        {
          userId: 'moderation_bot',
          displayName: 'MAXIM',
          username: 'moderation_bot',
          avatarUrl: 'https://cdn.max.ru/u/bot/avatar.jpg',
          profileUrl: null,
          role: 'admin',
          isBot: true,
        },
      ],
      nextMarker: 'page-2',
    });

    await service.onModuleDestroy();
  });

  it('returns direct profile urls from chat member payloads', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                first_name: 'Алексей',
                url: 'https://max.ru/aleksey-profile',
              },
              {
                user: {
                  user_id: 'user-2',
                  first_name: 'Марина',
                  profile_url: 'https://max.ru/marina-profile',
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMemberProfiles('chat-1', ['user-1', 'user-2']);

    expect(result.get('user-1')).toEqual({
      userId: 'user-1',
      displayName: 'Алексей',
      username: null,
      avatarUrl: null,
      profileUrl: 'https://max.ru/aleksey-profile',
    });
    expect(result.get('user-2')).toEqual({
      userId: 'user-2',
      displayName: 'Марина',
      username: null,
      avatarUrl: null,
      profileUrl: 'https://max.ru/marina-profile',
    });

    await service.onModuleDestroy();
  });

  it('combines first and last names for chat member roster profiles', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                first_name: 'Алексей',
                last_name: 'Иванов',
                username: 'aleksey',
                is_bot: false,
              },
            ],
            marker: null,
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMembersPage('chat-1');

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        displayName: 'Алексей Иванов',
      }),
    );

    await service.onModuleDestroy();
  });

  it('reads the current bot profile from GET /me', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            user_id: '214634783',
            first_name: 'Майор Максимова',
            username: 'id613002203036_4_bot',
            avatar_url: 'https://i.oneme.ru/i?r=small-avatar',
            full_avatar_url: 'https://i.oneme.ru/i?r=full-avatar',
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getOwnProfile({
      botId: '777000_bot',
      sourceTag: MAX_API_SOURCE_TAGS.SETTINGS_BOT_PROFILE,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api.max.ru/me',
      }),
    );
    expect(result).toEqual({
      userId: '214634783',
      displayName: 'Майор Максимова',
      username: 'id613002203036_4_bot',
      avatarUrl: 'https://i.oneme.ru/i?r=full-avatar',
      profileUrl: 'https://max.ru/id613002203036_4_bot',
    });

    await service.onModuleDestroy();
  });

  it('applies global MAX API rate limit to read requests', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
    });

    (
      service as unknown as { limiterRedis: { eval: jest.Mock } }
    ).limiterRedis.eval.mockResolvedValue([0, 1, 1]);

    await expect(service.listMessages('chat-1', 10)).rejects.toThrow(
      'MAX API global rate limit exceeded',
    );
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('applies interactive MAX API rate limit to global chat discovery requests', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_GLOBAL_RPS_INTERACTIVE: '1',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
    });

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValue([0, 2, 1]);

    await expect(service.listBotChats()).rejects.toThrow('MAX API interactive rate limit exceeded');
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('does not count interactive throttle errors in action health metrics', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_GLOBAL_RPS_INTERACTIVE: '1',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
    });
    const actionHealthService = (
      service as unknown as {
        actionHealthService: {
          recordSuccess: jest.Mock;
          recordFailure: jest.Mock;
        };
      }
    ).actionHealthService;

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValue([0, 2, 1]);

    await expect(service.listBotChats()).rejects.toThrow('MAX API interactive rate limit exceeded');

    expect(actionHealthService.recordFailure).not.toHaveBeenCalled();
    expect(actionHealthService.recordSuccess).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('waits briefly for a MAX API slot before executing the request', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            chats: [],
            marker: null,
          },
        }),
      ),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_GLOBAL_RPS_INTERACTIVE: '1',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '10',
      MAX_API_RATE_LIMIT_RETRY_FLOOR_MS: '1',
    });
    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValueOnce([0, 2, 1]).mockResolvedValueOnce([1, 0, 0]);

    await expect(service.listBotChats()).resolves.toEqual([]);

    expect(limiterRedis.eval).toHaveBeenCalledTimes(2);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('lets traffic classes borrow spare global headroom without exceeding the global MAX API cap', async () => {
    const service = createService(
      {},
      {
        MAX_API_GLOBAL_RPS: '30',
        MAX_API_GLOBAL_RPS_CRITICAL: '12',
        MAX_API_GLOBAL_RPS_INTERACTIVE: '10',
        MAX_API_GLOBAL_RPS_BACKGROUND: '4',
      },
    );

    expect((service as any).resolveTrafficClassEffectiveRpsLimit('critical')).toBe(16);
    expect((service as any).resolveTrafficClassEffectiveRpsLimit('interactive')).toBe(14);
    expect((service as any).resolveTrafficClassEffectiveRpsLimit('background')).toBe(8);

    await service.onModuleDestroy();
  });

  it('reuses Redis cache for bot chat discovery across service instances', async () => {
    const firstHttpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            chats: [
              {
                chat_id: 'chat-1',
                title: 'Chat 1',
                last_event_time: 1710000000000,
                type: 'chat',
                link: 'https://max.ru/chat-1',
              },
            ],
            marker: null,
          },
        }),
      ),
    };
    const firstService = createService(firstHttpService, {
      MAX_API_LIST_BOT_CHATS_CACHE_SEC: '15',
    });

    const firstResult = await firstService.listBotChats();

    const secondHttpService = {
      request: jest.fn(),
    };
    const secondService = createService(secondHttpService, {
      MAX_API_LIST_BOT_CHATS_CACHE_SEC: '15',
    });

    const secondResult = await secondService.listBotChats();

    expect(firstResult).toEqual(secondResult);
    expect(firstHttpService.request).toHaveBeenCalledTimes(1);
    expect(secondHttpService.request).not.toHaveBeenCalled();

    await firstService.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it('paginates bot chat discovery beyond twenty pages', async () => {
    const request = jest.fn();
    for (let index = 0; index < 21; index += 1) {
      request.mockReturnValueOnce(
        of({
          status: 200,
          data: {
            chats: [
              {
                chat_id: `chat-${index + 1}`,
                title: `Chat ${index + 1}`,
                type: 'chat',
              },
            ],
            marker: index < 20 ? index + 1 : null,
          },
        }),
      );
    }
    const service = createService({ request });

    await expect(service.listBotChats({ bypassCache: true })).resolves.toEqual(
      Array.from({ length: 21 }, (_, index) => ({
        chatId: `chat-${index + 1}`,
        title: `Chat ${index + 1}`,
        lastEventTime: null,
        entityType: 'chat',
        link: null,
        avatarUrl: null,
        botId: '777000_bot',
        botIds: ['777000_bot'],
      })),
    );
    expect(request).toHaveBeenCalledTimes(21);

    await service.onModuleDestroy();
  });

  it('bypasses cached chat snapshot when explicitly requested', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              title: 'Chat 1',
              participants_count: 10,
              status: 'active',
              is_public: false,
              last_event_time: '2026-03-26T10:00:00.000Z',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              title: 'Chat 1 Updated',
              participants_count: 12,
              status: 'active',
              is_public: true,
              link: 'https://max.ru/chat-1',
              last_event_time: '2026-03-26T10:00:05.000Z',
            },
          }),
        ),
    };
    const service = createService(httpService, {
      MAX_API_CHAT_SNAPSHOT_CACHE_SEC: '10',
    });

    const firstSnapshot = await service.getChatSnapshot('chat-1');
    const cachedSnapshot = await service.getChatSnapshot('chat-1');
    const freshSnapshot = await service.getChatSnapshot('chat-1', { bypassCache: true });

    expect(firstSnapshot.title).toBe('Chat 1');
    expect(cachedSnapshot.title).toBe('Chat 1');
    expect(freshSnapshot.title).toBe('Chat 1 Updated');
    expect(httpService.request).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
  });

  it('detects channel snapshots from public /channels links when MAX omits an explicit type', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            title: 'Новости MAX',
            participants_count: 10,
            status: 'active',
            is_public: true,
            link: 'https://max.ru/channels/news-max',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(service.getChatSnapshot('channel-1')).resolves.toEqual(
      expect.objectContaining({
        chatId: 'channel-1',
        title: 'Новости MAX',
        entityType: 'channel',
        link: 'https://max.ru/channels/news-max',
      }),
    );

    await service.onModuleDestroy();
  });

  it('detects private channel snapshots from is_channel when MAX omits type and link', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            title: 'Приватный канал',
            participants_count: 4,
            status: 'active',
            is_public: false,
            is_channel: true,
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(service.getChatSnapshot('channel-private-1')).resolves.toEqual(
      expect.objectContaining({
        chatId: 'channel-private-1',
        title: 'Приватный канал',
        entityType: 'channel',
        isPublic: false,
        link: null,
      }),
    );

    await service.onModuleDestroy();
  });

  it('applies background MAX API rate limit to background snapshot reads', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_GLOBAL_RPS_BACKGROUND: '2',
      MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND: '0',
    });

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValue([0, 2, 1]);

    await expect(service.getChatSnapshot('chat-1', { trafficClass: 'background' })).rejects.toThrow(
      'MAX API background rate limit exceeded',
    );
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('records source-level MAX API usage for tagged background reads', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:00:05.000Z'));

    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            title: 'Chat 1',
            participants_count: 10,
            status: 'active',
          },
        }),
      ),
    };
    const service = createService(httpService);
    const limiterRedis = (service as unknown as { limiterRedis: { get: jest.Mock } }).limiterRedis;
    const nowSec = Math.floor(Date.now() / 1_000);

    await expect(
      service.getChatSnapshot('chat-1', {
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
      } as never),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        title: 'Chat 1',
      }),
    );

    await expect(
      limiterRedis.get(`maxapi:rps:source:v1:777000_bot:background:managed_refresh:${nowSec}`),
    ).resolves.toBe('1');

    await service.onModuleDestroy();
  });

  it('preserves source-level MAX API usage tags for immediate dispatched mutations', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:00:25.000Z'));

    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {},
        }),
      ),
    };
    const service = createService(httpService);
    const limiterRedis = (service as unknown as { limiterRedis: { get: jest.Mock } }).limiterRedis;
    const nowSec = Math.floor(Date.now() / 1_000);

    await expect(
      service.deleteMessage('channel-1', 'mid-1', {
        immediate: true,
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
      }),
    ).resolves.toBeUndefined();

    await expect(
      limiterRedis.get(`maxapi:rps:source:v1:777000_bot:background:channel_auto_post:${nowSec}`),
    ).resolves.toBe('1');

    await service.onModuleDestroy();
  });

  it('can record admin MAX reads in a background action health lane while keeping interactive traffic class', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            title: 'Chat 1',
            participants_count: 10,
            status: 'active',
          },
        }),
      ),
    };
    const service = createService(httpService);
    const actionHealthService = (
      service as unknown as {
        actionHealthService: {
          recordSuccessForLane: jest.Mock;
          recordFailureForLane: jest.Mock;
        };
      }
    ).actionHealthService;

    await expect(
      service.getChatSnapshot('chat-1', {
        trafficClass: 'interactive',
        actionHealthLane: 'background',
      } as never),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        title: 'Chat 1',
      }),
    );

    expect(actionHealthService.recordSuccessForLane).toHaveBeenCalledWith(
      'background',
      '777000_bot',
    );
    expect(actionHealthService.recordFailureForLane).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('preserves a background action health lane for mutations even when traffic stays critical', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            message_id: 'mid-1',
          },
        }),
      ),
    };
    const service = createService(httpService);
    const actionHealthService = (
      service as unknown as {
        actionHealthService: {
          recordSuccessForLane: jest.Mock;
          recordFailureForLane: jest.Mock;
        };
      }
    ).actionHealthService;

    await expect(
      service.sendMessageImmediateWithId(
        'chat-1',
        'Фоновое сообщение',
        undefined,
        {
          actionHealthLane: 'background',
        } as never,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        messageId: 'mid-1',
      }),
    );

    expect(actionHealthService.recordSuccessForLane).toHaveBeenCalledWith(
      'background',
      '777000_bot',
    );
    expect(actionHealthService.recordFailureForLane).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('applies per-chat MAX API rate limit to profile lookups', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '100',
      MAX_API_CHAT_RPS: '1',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
    });

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValue([0, 3, 1]);

    await expect(service.getChatMemberProfiles('chat-1', ['user-1'])).rejects.toThrow(
      'MAX API per-chat rate limit exceeded for bot 777000_bot chat chat-1',
    );
    expect(httpService.request).not.toHaveBeenCalled();

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
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    };
    const actionHealthService = {
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      getSnapshot: jest.fn(),
    };
    const botRegistry = {
      getDefaultBot: jest.fn().mockReturnValue({
        id: '777000_bot',
        token: 'test-token',
        webhookSecretPath: 'secret-path',
        webhookHeaderSecret: 'header-secret',
        webhookUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
        maskedWebhookUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
      }),
      getBotById: jest.fn((botId?: string | null) =>
        !botId || botId === '777000_bot'
          ? {
              id: '777000_bot',
              token: 'test-token',
              webhookSecretPath: 'secret-path',
              webhookHeaderSecret: 'header-secret',
              webhookUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
              maskedWebhookUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
            }
          : null,
      ),
      getConfiguredWebhookSubscriptionTarget: jest.fn(() => ({
        url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
        maskedUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
      })),
    };
    const botContext = {
      getActiveBotId: jest.fn().mockReturnValue(null),
      runWithBot: jest.fn((_botId: string, callback: () => unknown) => callback()),
    };

    return new MaxClientService(
      {} as never,
      configService as never,
      actionHealthService as never,
      botRegistry as never,
      botContext as never,
      queue as never,
    );
  }

  it('dispatches queued delete actions with the active bot context when botId is omitted', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
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
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    };
    const actionHealthService = {
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      getSnapshot: jest.fn(),
    };
    const botRegistry = {
      getDefaultBot: jest.fn().mockReturnValue({
        id: 'id613002203036_bot',
        token: 'default-token',
        webhookSecretPath: 'default-secret',
        webhookHeaderSecret: 'default-header-secret',
        webhookUrl: 'https://maxim.play-team.ru/api/webhook/max/id613002203036_bot/default-secret',
        maskedWebhookUrl: 'https://maxim.play-team.ru/api/webhook/max/id613002203036_bot/***',
      }),
      getBotById: jest.fn((botId?: string | null) => {
        if (!botId || botId === 'id613002203036_bot') {
          return {
            id: 'id613002203036_bot',
            token: 'default-token',
            webhookSecretPath: 'default-secret',
            webhookHeaderSecret: 'default-header-secret',
            webhookUrl:
              'https://maxim.play-team.ru/api/webhook/max/id613002203036_bot/default-secret',
            maskedWebhookUrl: 'https://maxim.play-team.ru/api/webhook/max/id613002203036_bot/***',
          };
        }

        if (botId === 'id613002203036_4_bot') {
          return {
            id: 'id613002203036_4_bot',
            token: 'secondary-token',
            webhookSecretPath: 'secondary-secret',
            webhookHeaderSecret: 'secondary-header-secret',
            webhookUrl:
              'https://maxim.play-team.ru/api/webhook/max/id613002203036_4_bot/secondary-secret',
            maskedWebhookUrl:
              'https://maxim.play-team.ru/api/webhook/max/id613002203036_4_bot/***',
          };
        }

        return null;
      }),
      getConfiguredWebhookSubscriptionTarget: jest.fn(() => ({
        url: 'https://maxim.play-team.ru/api/webhook/max/id613002203036_bot/default-secret',
        maskedUrl: 'https://maxim.play-team.ru/api/webhook/max/id613002203036_bot/***',
      })),
    };
    const botContext = {
      getActiveBotId: jest.fn().mockReturnValue('id613002203036_4_bot'),
      runWithBot: jest.fn((_botId: string, callback: () => unknown) => callback()),
    };
    const service = new MaxClientService(
      {} as never,
      configService as never,
      actionHealthService as never,
      botRegistry as never,
      botContext as never,
      queue as never,
    );

    await service.deleteMessage('-72881707399277', 'mid-delete-1');

    expect(queue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'DELETE_MESSAGE',
        chatId: '-72881707399277',
        messageId: 'mid-delete-1',
        botId: 'id613002203036_4_bot',
      }),
      expect.any(Object),
    );

    await service.onModuleDestroy();
  });

  it('uses deterministic queue job id for delayed unban', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createServiceWithQueue(queue);
    const expectedJobId = 'member-action__777000_bot__UNBAN_MEMBER__chat-1__user-1';

    await service.unbanMember('chat-1', 'user-1', { delayMs: 60_000 });

    expect(queue.getJob).toHaveBeenCalledWith(expectedJobId);
    expect(queue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'UNBAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        idempotencyKey: expectedJobId,
      }),
      expect.objectContaining({
        jobId: expectedJobId,
        delay: 60_000,
      }),
    );
    expect(expectedJobId.includes(':')).toBe(false);

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

    expect(queue.getJob).toHaveBeenCalledWith(
      'member-action__777000_bot__UNBAN_MEMBER__chat-1__user-2',
    );
    expect(remove).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });
});
