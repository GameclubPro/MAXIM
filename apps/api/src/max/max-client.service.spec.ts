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
                    text: 'Привет мир',
                    markup: [
                      {
                        from: 0,
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

    await service.editMessageInlineKeyboard('chat-1', 'mid-edit-markup-1', 'Привет мир', {
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
          text: '<strong>Привет</strong> мир',
          format: 'html',
        }),
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

    await service.editMessageInlineKeyboard(
      'chat-1',
      'mid-edit-forward-1',
      'Пересланный текст',
      {
        button: {
          text: 'Открыть',
          url: 'https://maxim.play-team.ru/app/',
        },
      },
    );

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
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessageReplyWithInlineKeyboard(
      'chat-1',
      'mid-source-1',
      'Действия к посту',
      {
        button: {
          text: 'Открыть',
          url: 'https://maxim.play-team.ru/app/',
        },
      },
    );

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
        url: 'https://platform-api.max.ru/chats/chat-1/members',
        params: {
          user_ids: 'user-404',
        },
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

  it('applies global MAX API rate limit to read requests', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
    });

    ((service as unknown as { limiterRedis: { incr: jest.Mock } }).limiterRedis.incr).mockResolvedValueOnce(
      31,
    );

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
    });

    const limiterRedis = (service as unknown as { limiterRedis: { incr: jest.Mock } }).limiterRedis;
    limiterRedis.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    await expect(service.listBotChats()).rejects.toThrow('MAX API interactive rate limit exceeded');
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('applies background MAX API rate limit to background snapshot reads', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_GLOBAL_RPS_BACKGROUND: '2',
    });

    const limiterRedis = (service as unknown as { limiterRedis: { incr: jest.Mock } }).limiterRedis;
    limiterRedis.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(3);

    await expect(
      service.getChatSnapshot('chat-1', { trafficClass: 'background' }),
    ).rejects.toThrow('MAX API background rate limit exceeded');
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('applies per-chat MAX API rate limit to profile lookups', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '100',
      MAX_API_CHAT_RPS: '1',
    });

    const limiterRedis = (service as unknown as { limiterRedis: { incr: jest.Mock } }).limiterRedis;
    limiterRedis.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    await expect(service.getChatMemberProfiles('chat-1', ['user-1'])).rejects.toThrow(
      'MAX API per-chat rate limit exceeded for chat chat-1',
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
    const expectedJobId = 'member-action__UNBAN_MEMBER__chat-1__user-1';

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

    expect(queue.getJob).toHaveBeenCalledWith('member-action__UNBAN_MEMBER__chat-1__user-2');
    expect(remove).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });
});
