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

function createService(options: {
  config?: Record<string, unknown>;
  fetchResponse?: unknown;
  lockToken?: string | null;
  sendRejects?: boolean;
  sendError?: unknown;
} = {}) {
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
    acquireLock: jest.fn().mockResolvedValue(
      options.lockToken === undefined ? 'lock-1' : options.lockToken,
    ),
    releaseLock: jest.fn().mockResolvedValue(undefined),
  };
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue(options.fetchResponse ?? {
      exists: true,
      store: {
        id: 'store-1',
        slug: 'severnaya-lavka',
        name: 'Северная лавка',
        sellerAccountId: 'seller-1',
        url: 'https://max.ru/se13381675_1_bot?startapp=s_severnaya-lavka__r_seller-1',
        inviteUrl: 'https://api2.major-maksimov.ru/karavan/api/v1/public/stores/severnaya-lavka/invite',
      },
    }),
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
  text: 'свежая клубника',
  raw: {
    message: {
      body: {
        text: 'свежая клубника',
      },
    },
  },
  botId: '777000_bot',
};

describe('KaravanStorefrontRelayService', () => {
  it('adds a storefront reply button for seller messages without touching the original post', async () => {
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
      expect(fixture.prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: 'KARAVAN_STOREFRONT_RELAY',
          payload: expect.objectContaining({
            sourceMessageId: 'mid-source-1',
            companionMessageId: 'mid-storefront-button',
          }),
        }),
      }));
    } finally {
      fixture.restore();
    }
  });

  it('does not require a dollar marker anymore', async () => {
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
      ).resolves.toBe('handled');

      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendCustomMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
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
