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
  deleteRejects?: boolean;
  sendRejects?: boolean;
} = {}) {
  const maxClient = {
    sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
      messageId: 'mid-relay-copy',
      url: 'https://max.ru/chats/chat-1/message/mid-relay-copy',
    }),
    deleteMessage: jest.fn().mockResolvedValue(undefined),
  };
  if (options.deleteRejects) {
    maxClient.deleteMessage.mockRejectedValue(new Error('delete failed'));
  }
  if (options.sendRejects) {
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(new Error('send timeout'));
  }

  const prisma = {
    auditLog: {
      create: jest.fn().mockResolvedValue(undefined),
    },
  };
  const redisCounter = {
    acquireLock: jest.fn().mockResolvedValue(options.lockToken === undefined ? 'lock-1' : options.lockToken),
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
  it('reposts dollar-prefixed seller messages with a MAX mention and storefront button', async () => {
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
      expect(fixture.maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'chat-1',
        '<a href="max://user/1001">Мария &amp; Ко</a>\n\n$ свежая клубника',
        expect.objectContaining({
          textFormat: 'html',
          buttons: [[expect.objectContaining({
            text: 'Открыть витрину',
            url: 'https://max.ru/se13381675_1_bot?startapp=s_severnaya-lavka__r_seller-1',
          })]],
        }),
        expect.objectContaining({
          immediate: true,
          botId: '777000_bot',
          trafficClass: 'interactive',
        }),
      );
      expect(fixture.maxClient.deleteMessage).toHaveBeenCalledWith(
        'chat-1',
        'mid-source-1',
        expect.objectContaining({
          immediate: true,
          botId: '777000_bot',
        }),
      );
      expect(fixture.prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: 'KARAVAN_STOREFRONT_RELAY',
          payload: expect.objectContaining({
            sourceMessageId: 'mid-source-1',
            replacementMessageId: 'mid-relay-copy',
            originalDeleted: true,
          }),
        }),
      }));
    } finally {
      fixture.restore();
    }
  });

  it('does not repost when the message is already claimed', async () => {
    const fixture = createService({ lockToken: null });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('duplicate');

      expect(fixture.maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
      expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('fails open when deleting the original message fails', async () => {
    const fixture = createService({ deleteRejects: true });

    try {
      await expect(fixture.service.handleMessageCreated(baseContext)).resolves.toBe('handled');

      expect(fixture.prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            originalDeleted: false,
            deleteError: 'delete failed',
          }),
        }),
      }));
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

  it('ignores non-trigger messages', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          text: 'обычное сообщение',
          raw: {
            message: {
              body: {
                text: 'обычное сообщение',
              },
            },
          },
        }),
      ).resolves.toBe('noop');

      expect(fixture.fetchMock).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('keeps incoming MAX text markup in the bot repost', async () => {
    const fixture = createService();

    try {
      await expect(
        fixture.service.handleMessageCreated({
          ...baseContext,
          text: '$ акция только сегодня',
          raw: {
            message: {
              body: {
                text: '$ акция только сегодня',
                markup: [
                  {
                    from: 2,
                    length: 5,
                    type: 'strong',
                  },
                  {
                    from: 15,
                    length: 7,
                    type: 'link',
                    url: 'https://example.test/deal',
                  },
                ],
              },
            },
          },
        }),
      ).resolves.toBe('handled');

      expect(fixture.maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'chat-1',
        '<a href="max://user/1001">Мария &amp; Ко</a>\n\n$ <strong>акция</strong> только <a href="https://example.test/deal">сегодня</a>',
        expect.objectContaining({ textFormat: 'html' }),
        expect.any(Object),
      );
    } finally {
      fixture.restore();
    }
  });
});
