import { KaravanStorefrontRelayService } from './karavan-storefront-relay.service';

function createConfigMock(overrides: Record<string, unknown> = {}) {
  const values = {
    KARAVAN_STOREFRONT_RELAY_ENABLED: true,
    KARAVAN_API_BASE_URL: 'https://api2.major-maksimov.ru/karavan/api',
    KARAVAN_INTEGRATION_TOKEN: 'test-karavan-integration-token',
    KARAVAN_STOREFRONT_LOOKUP_TIMEOUT_MS: 500,
    KARAVAN_STOREFRONT_CACHE_TTL_SEC: 120,
    KARAVAN_STOREFRONT_RELAY_LOCK_TTL_SEC: 3600,
    ...overrides,
  };

  return {
    get: jest.fn((key: string) => values[key as keyof typeof values]),
  };
}

function createService(
  options: {
    config?: Record<string, unknown>;
    fetchResponse?: unknown;
    lockToken?: string | null;
    sendRejects?: boolean;
    sendError?: unknown;
  } = {},
) {
  const maxClient = {
    sendCustomMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
      messageId: 'mid-storefront-button',
      url: 'https://max.ru/chats/chat-1/message/mid-storefront-button',
    }),
    deleteMessage: jest.fn().mockResolvedValue(undefined),
  };
  if (options.sendRejects) {
    maxClient.sendCustomMessageImmediateWithResolvedLink.mockRejectedValue(
      options.sendError ?? new Error('send timeout'),
    );
  }

  const prisma = {
    auditLog: {
      create: jest.fn().mockResolvedValue(undefined),
    },
  };
  const redisCounter = {
    acquireLock: jest
      .fn()
      .mockResolvedValue(options.lockToken === undefined ? 'lock-1' : options.lockToken),
    releaseLock: jest.fn().mockResolvedValue(undefined),
  };
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue(
      options.fetchResponse ?? {
        exists: true,
        store: {
          id: 'store-1',
          slug: 'severnaya-lavka',
          name: 'Северная лавка',
          sellerAccountId: 'seller-1',
          url: 'https://max.ru/se13381675_1_bot?startapp=s_severnaya-lavka__r_seller-1',
          inviteUrl:
            'https://api2.major-maksimov.ru/karavan/api/v1/public/stores/severnaya-lavka/invite',
        },
      },
    ),
  });
  const originalFetch = global.fetch;
  global.fetch = fetchMock as never;

  const service = new KaravanStorefrontRelayService(
    maxClient as never,
    prisma as never,
    redisCounter as never,
    createConfigMock(options.config) as never,
  );

  return {
    service,
    maxClient,
    prisma,
    redisCounter,
    fetchMock,
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}

const baseContext = {
  updateType: 'message_created',
  chatId: 'chat-1',
  messageId: 'mid-source-1',
  senderId: '1001',
  senderName: 'Мария & Ко',
  text: '$ свежая клубника',
  raw: {
    message: {
      body: {
        text: '$ свежая клубника',
      },
    },
  },
  botId: '777000_bot',
};

describe('KaravanStorefrontRelayService', () => {
  it('adds a storefront reply button for dollar-prefixed seller messages without touching the original post', async () => {
    const fixture = createService();

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledWith(
        'https://api2.major-maksimov.ru/karavan/api/v1/integrations/maxim/storefronts/by-max-user/1001',
        expect.objectContaining({
          headers: {
            authorization: 'Bearer test-karavan-integration-token',
          },
        }),
      );
      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'chat-1',
        {
          text: 'Витрина продавца',
          messageLink: {
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
                      text: 'Открыть витрину',
                      url: 'https://max.ru/se13381675_1_bot?startapp=s_severnaya-lavka__r_seller-1',
                    },
                  ],
                ],
              },
            },
          ],
        },
        expect.objectContaining({
          immediate: true,
          botId: '777000_bot',
          trafficClass: 'interactive',
        }),
      );
      expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(fixture.prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'KARAVAN_STOREFRONT_RELAY',
            payload: expect.objectContaining({
              sourceMessageId: 'mid-source-1',
              companionMessageId: 'mid-storefront-button',
            }),
          }),
        }),
      );
    } finally {
      fixture.restore();
    }
  });

  it('resolves the active storefront again for every dollar-prefixed message', async () => {
    const fixture = createService();
    fixture.fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          exists: true,
          store: {
            id: 'store-1',
            slug: 'severnaya-lavka',
            name: 'Северная лавка',
            sellerAccountId: 'seller-1',
            url: 'https://max.ru/se13381675_1_bot?startapp=s_severnaya-lavka__r_seller-1',
            inviteUrl:
              'https://api2.major-maksimov.ru/karavan/api/v1/public/stores/severnaya-lavka/invite',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          exists: true,
          store: {
            id: 'store-2',
            slug: 'tsvety-max',
            name: 'Цветы MAX',
            sellerAccountId: 'seller-1',
            url: 'https://max.ru/se13381675_1_bot?startapp=s_tsvety-max__r_seller-1',
            inviteUrl:
              'https://api2.major-maksimov.ru/karavan/api/v1/public/stores/tsvety-max/invite',
          },
        }),
      });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('handled');
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          messageId: 'mid-source-2',
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(2);
      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).toHaveBeenLastCalledWith(
        'chat-1',
        expect.objectContaining({
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Открыть витрину',
                      url: 'https://max.ru/se13381675_1_bot?startapp=s_tsvety-max__r_seller-1',
                    },
                  ],
                ],
              },
            },
          ],
        }),
        expect.objectContaining({
          immediate: true,
          trafficClass: 'interactive',
        }),
      );
    } finally {
      fixture.restore();
    }
  });

  it('ignores messages without a dollar marker', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          text: 'обычное сообщение без маркера',
          raw: {
            message: {
              body: {
                text: 'обычное сообщение без маркера',
              },
            },
          },
        }),
      ).resolves.toBe('noop');

      expect(fixture.fetchMock).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('accepts a dollar marker after leading whitespace in raw body text', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          text: null,
          raw: {
            message: {
              body: {
                text: '  $ клубника с доставкой',
              },
            },
          },
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    } finally {
      fixture.restore();
    }
  });

  it('adds a storefront button for a forwarded seller post with a blank outer body', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: {
            message: {
              body: {
                text: '',
              },
              link: {
                type: 'forward',
                sender: {
                  user_id: '1001',
                },
                message: {
                  text: '$ свежая клубника',
                },
              },
            },
          },
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    } finally {
      fixture.restore();
    }
  });

  it('supports a forwarded seller post when MAX omits the outer body and forward sender', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: {
            message: {
              body: null,
              link: {
                type: 'forward',
                message: {
                  text: '$ свежая клубника',
                },
              },
            },
          },
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    } finally {
      fixture.restore();
    }
  });

  it('reads a forwarded seller post from a webhook event envelope', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: {
            update_type: 'message_created',
            message_created: {
              message: {
                body: {
                  text: '',
                },
                link: {
                  type: 'forward',
                  sender: {
                    user_id: '1001',
                  },
                  message: {
                    text: '$ свежая клубника',
                  },
                },
              },
            },
          },
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    } finally {
      fixture.restore();
    }
  });

  it('reads a forwarded seller marker from the nested message body after whitespace-only outer text', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: {
            message: {
              body: {
                text: '   ',
              },
              link: {
                type: 'forward',
                sender: {
                  user_id: '1001',
                },
                message: {
                  body: {
                    text: '$ клубника с доставкой',
                  },
                },
              },
            },
          },
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    } finally {
      fixture.restore();
    }
  });

  it.each(['reply', 'quoted'])('ignores a dollar marker inside a %s preview', async (linkType) => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: {
            message: {
              body: {
                text: '',
              },
              link: {
                type: linkType,
                message: {
                  text: '$ чужая витрина',
                },
              },
            },
          },
        }),
      ).resolves.toBe('noop');

      expect(fixture.fetchMock).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('ignores a forwarded marker whose author differs from the current sender', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: {
            message: {
              body: {
                text: '',
              },
              link: {
                type: 'forward',
                sender: {
                  user_id: 'another-seller',
                },
                message: {
                  text: '$ чужая витрина',
                },
              },
            },
          },
        }),
      ).resolves.toBe('noop');

      expect(fixture.fetchMock).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('prioritizes direct current-message text over a forwarded marker', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: {
            message: {
              body: {
                text: 'обычный ответ на пересылку',
              },
              link: {
                type: 'forward',
                sender: {
                  user_id: '1001',
                },
                message: {
                  text: '$ свежая клубника',
                },
              },
            },
          },
        }),
      ).resolves.toBe('noop');

      expect(fixture.fetchMock).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('keeps the normalized text fallback for raw-less compatibility contexts', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          raw: undefined,
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    } finally {
      fixture.restore();
    }
  });

  it('retries a failed lookup on a later dollar-prefixed message edit', async () => {
    const fixture = createService();
    fixture.fetchMock.mockRejectedValueOnce(new Error('lookup timeout')).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue({
        exists: true,
        store: {
          id: 'store-2',
          slug: 'del-yarn',
          name: 'ДЭЛЬ',
          sellerAccountId: 'seller-2',
          url: 'https://max.ru/se13381675_1_bot?startapp=s_del-yarn__r_seller-2',
          inviteUrl: 'https://api2.major-maksimov.ru/karavan/api/v1/public/stores/del-yarn/invite',
        },
      }),
    });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('failed');
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          updateType: 'message_edited',
        }),
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(2);
      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Открыть витрину',
                      url: 'https://max.ru/se13381675_1_bot?startapp=s_del-yarn__r_seller-2',
                    },
                  ],
                ],
              },
            },
          ],
        }),
        expect.objectContaining({
          immediate: true,
          trafficClass: 'interactive',
        }),
      );
    } finally {
      fixture.restore();
    }
  });

  it('does not add a button when the sender has no public storefront', async () => {
    const fixture = createService({
      fetchResponse: {
        exists: false,
        store: null,
      },
    });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('noop');

      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
      expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('does not add duplicate buttons when the message is already claimed', async () => {
    const fixture = createService({ lockToken: null });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('duplicate');

      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
      expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('keeps the idempotency claim when sending fails ambiguously', async () => {
    const fixture = createService({ sendRejects: true });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('failed');

      expect(fixture.redisCounter.releaseLock).not.toHaveBeenCalled();
      expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('releases the idempotency claim when MAX rejects the payload with a final 4xx', async () => {
    const error = Object.assign(new Error('bad request'), {
      response: {
        status: 400,
      },
    });
    const fixture = createService({ sendRejects: true, sendError: error });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('failed');

      expect(fixture.redisCounter.releaseLock).toHaveBeenCalledWith(
        'karavan-storefront-relay:v1:chat-1:mid-source-1',
        'lock-1',
      );
      expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('stays disabled unless explicitly configured', async () => {
    const fixture = createService({
      config: {
        KARAVAN_STOREFRONT_RELAY_ENABLED: false,
      },
    });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('disabled');

      expect(fixture.fetchMock).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });
});
