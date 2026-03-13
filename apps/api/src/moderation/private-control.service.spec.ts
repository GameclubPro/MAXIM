import {
  channelSettingsSchema,
  chatSettingsSchema,
  type ManagedGiveawayDetails,
  type ManagedGiveawayWinner,
  type ManagedPoll,
  type MaxUpdate,
} from '@maxim/contracts';
import { PrivateControlService } from './private-control.service';

function createPrivateTextUpdate(text: string): MaxUpdate {
  return {
    updateId: `upd-text-${Date.now()}`,
    type: 'message_created',
    message: {
      messageId: `msg-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          text,
        },
        sender: {
          user_id: 'user-1',
          name: 'Тестовый пользователь',
        },
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createPrivatePhotoUpdate(): MaxUpdate {
  return {
    updateId: `upd-photo-${Date.now()}`,
    type: 'message_created',
    message: {
      messageId: `msg-photo-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          attachments: [
            {
              type: 'image',
              payload: {
                url: 'https://example.test/broadcast-photo.jpg',
                photo_id: 'photo-1',
              },
            },
          ],
        },
        sender: {
          user_id: 'user-1',
          name: 'Тестовый пользователь',
        },
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createPrivateStickerUpdate(code = '1e1321f26'): MaxUpdate {
  return {
    updateId: `upd-sticker-${Date.now()}`,
    type: 'message_created',
    message: {
      messageId: `msg-sticker-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          attachments: [
            {
              type: 'sticker',
              payload: {
                code,
                url: `https://i.oneme.ru/getSmile?smileId=${code}&smileType=4`,
              },
            },
          ],
        },
        sender: {
          user_id: 'user-1',
          name: 'Тестовый пользователь',
        },
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createPrivateCallbackUpdate(payload: string): MaxUpdate {
  return {
    updateId: `upd-cb-${Date.now()}`,
    type: 'message_callback',
    message: {
      messageId: `msg-cb-${Date.now()}`,
      chatId: '152517912',
      senderId: '613002203036',
      senderName: 'Майор Максимов',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-1',
        payload,
        user: {
          user_id: 'user-1',
          name: 'Тестовый пользователь',
        },
      },
      message: {
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createBotStartedPrivateUpdate(startPayload = 'broadcast_handoff'): MaxUpdate {
  return {
    updateId: `upd-bot-started-${Date.now()}`,
    type: 'bot_started',
    message: {
      messageId: `bot-started-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_started',
      chat_id: 152517912,
      start_payload: startPayload,
      user: {
        user_id: 'user-1',
        name: 'Тестовый пользователь',
      },
      chat: {
        chat_id: 152517912,
        type: 'dialog',
      },
    },
  };
}

function createBotStartedGiveawayClaimUpdate(): MaxUpdate {
  return {
    updateId: `upd-bot-started-giveaway-${Date.now()}`,
    type: 'bot_started',
    message: {
      messageId: `bot-started-giveaway-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_started',
      chat_id: 152517912,
      start_payload: 'ggc-test-payload',
      user: {
        user_id: 'user-1',
        name: 'Тестовый пользователь',
      },
      chat: {
        chat_id: 152517912,
        type: 'dialog',
      },
    },
  };
}

const defaultSettings = chatSettingsSchema.parse({});
const defaultChannelSettings = channelSettingsSchema.parse({});
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);

function createPoll(overrides: Partial<ManagedPoll> = {}): ManagedPoll {
  return {
    question: '',
    options: ['', ''],
    status: 'DRAFT',
    activeVersion: 0,
    publishedMessageId: null,
    publishedUrl: null,
    publishedAt: null,
    closedAt: null,
    totalVotes: 0,
    optionResults: [
      { option: '', votes: 0, percent: 0 },
      { option: '', votes: 0, percent: 0 },
    ],
    ...overrides,
  };
}

function createGiveawayWinner(
  overrides: Partial<ManagedGiveawayWinner> = {},
): ManagedGiveawayWinner {
  return {
    id: 'winner-1',
    prizeId: 'prize-1',
    prizePosition: 1,
    prizeTitle: 'Подписка MAX',
    entryId: 'entry-1',
    userId: 'user-1',
    displayName: 'Тестовый пользователь',
    status: 'SELECTED',
    selectedAt: new Date().toISOString(),
    claimDeadlineAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    claimedAt: null,
    deliveredAt: null,
    expiredAt: null,
    rerolledAt: null,
    ...overrides,
  };
}

function createGiveaway(overrides: Partial<ManagedGiveawayDetails> = {}): ManagedGiveawayDetails {
  return {
    id: 'giveaway-1',
    sourceChatId: '-70000000000001',
    entityType: 'chat',
    title: 'Весенний розыгрыш',
    description: 'Разыгрываем подписку.',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    claimHours: 24,
    publicationMessageId: 'msg-1',
    publicationUrl: 'https://max.ru/chats/chat-1/message/1',
    resultsMessageId: null,
    resultsUrl: null,
    status: 'ACTIVE',
    hasImage: false,
    entriesCount: 12,
    verifiedEntriesCount: 10,
    pendingEntriesCount: 2,
    winnersCount: 0,
    startsAt: null,
    endsAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    publishedAt: new Date().toISOString(),
    completedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prizes: [
      {
        id: 'prize-1',
        position: 1,
        title: 'Подписка MAX',
      },
    ],
    winners: [],
    ...overrides,
  };
}

function createHarness(
  overrides: {
    settings?: typeof defaultSettings;
    channelSettings?: typeof defaultChannelSettings;
    adminService?: Record<string, unknown>;
    managedGiveaway?: ManagedGiveawayDetails | null;
  } = {},
) {
  const chats = [
    {
      id: '-70000000000001',
      title: 'Тестовый чат 1',
      createdAt: new Date().toISOString(),
      entityType: 'chat' as const,
    },
  ];
  const channels = [
    {
      id: '-80000000000001',
      title: 'Тестовый канал 1',
      createdAt: new Date().toISOString(),
      entityType: 'channel' as const,
    },
  ];

  const maxClient = {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    sendCustomMessageImmediate: jest.fn().mockResolvedValue({ message_id: 'msg-custom-1' }),
    uploadImage: jest.fn().mockResolvedValue({ token: 'upload-token-1' }),
    answerCallback: jest.fn().mockResolvedValue(undefined),
  };

  const adminService = {
    listManagedEntities: jest.fn().mockImplementation(async (_actor, entityType = 'all') => {
      if (entityType === 'channel') {
        return channels;
      }
      if (entityType === 'chat') {
        return chats;
      }
      return [...chats, ...channels];
    }),
    listChats: jest.fn().mockResolvedValue(chats),
    getSettings: jest.fn().mockResolvedValue(overrides.settings ?? defaultSettings),
    updateSettings: jest.fn().mockResolvedValue(overrides.settings ?? defaultSettings),
    applySettingsToAllChats: jest.fn().mockResolvedValue({
      sourceChatId: chats[0].id,
      updatedChats: 1,
      appliedChatIds: [chats[0].id],
    }),
    getDomainAllowlistDetails: jest.fn().mockResolvedValue([]),
    addDomain: jest.fn().mockResolvedValue(undefined),
    removeDomain: jest.fn().mockResolvedValue(undefined),
    scheduleDomainRemoval: jest.fn().mockResolvedValue(undefined),
    getGlobalUserBlacklist: jest.fn().mockResolvedValue([]),
    addGlobalUserBlacklistUser: jest.fn().mockResolvedValue(undefined),
    removeGlobalUserBlacklistUser: jest.fn().mockResolvedValue(undefined),
    sendBroadcast: jest.fn().mockResolvedValue({ targetChats: 1, sentChats: 1, failedChats: 0 }),
    sendChannelBroadcast: jest
      .fn()
      .mockResolvedValue({ targetChats: 1, sentChats: 1, failedChats: 0 }),
    getEvents: jest.fn().mockResolvedValue([]),
    getLogsDashboard: jest.fn().mockResolvedValue({
      membership: { joinedUsers: 0, leftUsers: 0 },
      violationsSummary: { warn: 0, deleteMessage: 0, kick: 0, ban: 0, total: 0 },
      violations: [],
    }),
    applyManualModerationAction: jest.fn().mockResolvedValue({ success: true, message: 'Готово' }),
    getChatPoll: jest.fn().mockResolvedValue(createPoll()),
    updateChatPoll: jest.fn().mockImplementation(async (_chatId, _actor, draft) =>
      createPoll({
        question: draft.question,
        options: draft.options,
      }),
    ),
    publishChatPoll: jest.fn().mockResolvedValue(
      createPoll({
        question: 'Выбираем режим?',
        status: 'ACTIVE',
        activeVersion: 1,
        publishedMessageId: 'mid-poll-1',
        publishedUrl: 'https://max.ru/chats/chat-1/message/1',
      }),
    ),
    closeChatPoll: jest.fn().mockResolvedValue(
      createPoll({
        status: 'CLOSED',
      }),
    ),
    getChannelPoll: jest.fn().mockResolvedValue(createPoll()),
    updateChannelPoll: jest.fn().mockResolvedValue(createPoll()),
    publishChannelPoll: jest.fn().mockResolvedValue(
      createPoll({
        status: 'ACTIVE',
        activeVersion: 1,
        publishedMessageId: 'mid-channel-poll-1',
        publishedUrl: 'https://max.ru/chats/channel-1/message/1',
      }),
    ),
    closeChannelPoll: jest.fn().mockResolvedValue(createPoll({ status: 'CLOSED' })),
    getChannelSettings: jest
      .fn()
      .mockResolvedValue(overrides.channelSettings ?? defaultChannelSettings),
    updateChannelSettings: jest
      .fn()
      .mockResolvedValue(overrides.channelSettings ?? defaultChannelSettings),
    publishChannelEngagementMessage: jest.fn().mockResolvedValue(undefined),
    ...overrides.adminService,
  };

  let currentGiveaway = overrides.managedGiveaway === undefined ? createGiveaway() : overrides.managedGiveaway;
  const giveawayStore = new Map<string, ManagedGiveawayDetails>();
  if (currentGiveaway) {
    giveawayStore.set(currentGiveaway.id, currentGiveaway);
  }

  const saveGiveaway = (giveaway: ManagedGiveawayDetails) => {
    giveawayStore.set(giveaway.id, giveaway);
    if (
      giveaway.status === 'DRAFT' ||
      giveaway.status === 'SCHEDULED' ||
      giveaway.status === 'ACTIVE' ||
      giveaway.status === 'DRAWING'
    ) {
      currentGiveaway = giveaway;
    } else if (currentGiveaway?.id === giveaway.id) {
      currentGiveaway = null;
    }
    return giveaway;
  };

  const managedGiveawayService = {
    parseClaimStartPayload: jest.fn((payload: string | null) =>
      payload === 'ggc-test-payload'
        ? {
            giveawayId: 'giveaway-1',
            winnerId: 'winner-1',
          }
        : null,
    ),
    getGiveawayClaimContext: jest.fn().mockResolvedValue({
      giveaway: createGiveaway({
        status: 'COMPLETED',
        winnersCount: 1,
      }),
      winner: createGiveawayWinner(),
    }),
    claimGiveaway: jest.fn().mockResolvedValue({
      ok: true,
      winner: createGiveawayWinner({
        status: 'CLAIMED',
        claimedAt: new Date().toISOString(),
      }),
    }),
    getManagedGiveaway: jest.fn().mockImplementation(async (_chatId, giveawayId) => {
      return giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId });
    }),
    getCurrentManagedGiveawayForEntity: jest.fn().mockImplementation(async () => currentGiveaway),
    createManagedGiveaway: jest.fn().mockImplementation(async (_chatId, _actor, payload) => {
      const created = createGiveaway({
        id: 'giveaway-draft-1',
        title: payload.title,
        description: payload.description,
        imageEnabled: payload.imageEnabled,
        imageBase64: payload.imageBase64,
        imageMimeType: payload.imageMimeType,
        imageFileName: payload.imageFileName,
        claimHours: payload.claimHours,
        startsAt: payload.startsAt,
        endsAt: payload.endsAt,
        prizes: payload.prizes.map((prize: { position: number; title: string }) => ({
          id: `prize-${prize.position}`,
          position: prize.position,
          title: prize.title,
        })),
        status: 'DRAFT',
        publicationMessageId: null,
        publicationUrl: null,
        publishedAt: null,
        winners: [],
        winnersCount: 0,
        entriesCount: 0,
        verifiedEntriesCount: 0,
        pendingEntriesCount: 0,
      });
      return saveGiveaway(created);
    }),
    updateManagedGiveaway: jest.fn().mockImplementation(async (_chatId, giveawayId, _actor, payload) => {
      const existing = giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId, status: 'DRAFT' });
      const updated = createGiveaway({
        ...existing,
        title: payload.title,
        description: payload.description,
        imageEnabled: payload.imageEnabled,
        imageBase64: payload.imageBase64,
        imageMimeType: payload.imageMimeType,
        imageFileName: payload.imageFileName,
        claimHours: payload.claimHours,
        startsAt: payload.startsAt,
        endsAt: payload.endsAt,
        hasImage: payload.imageEnabled,
        prizes: payload.prizes.map((prize: { position: number; title: string }) => ({
          id: `prize-${prize.position}`,
          position: prize.position,
          title: prize.title,
        })),
        status: 'DRAFT',
        updatedAt: new Date().toISOString(),
      });
      return saveGiveaway(updated);
    }),
    getGiveawaySettingsMiniappUrl: jest
      .fn()
      .mockReturnValue('https://maxim.play-team.ru/app/chat/-70000000000001/settings?focus=giveaway'),
    getGiveawayPublicMiniappUrl: jest
      .fn()
      .mockReturnValue('https://maxim.play-team.ru/app/giveaways/giveaway-1'),
    publishManagedGiveaway: jest.fn().mockImplementation(async (_chatId, giveawayId) => {
      const existing = giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId, status: 'DRAFT' });
      return saveGiveaway(
        createGiveaway({
          ...existing,
          status: 'ACTIVE',
          publicationMessageId: 'msg-1',
          publicationUrl: 'https://max.ru/chats/chat-1/message/1',
          publishedAt: new Date().toISOString(),
        }),
      );
    }),
    closeManagedGiveaway: jest.fn().mockImplementation(async (_chatId, giveawayId) => {
      const existing = giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId });
      return saveGiveaway(
        createGiveaway({
          ...existing,
          status: 'COMPLETED',
          winnersCount: 1,
        }),
      );
    }),
    rerollManagedGiveawayWinner: jest.fn().mockImplementation(async (_chatId, giveawayId) => {
      const existing = giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId, status: 'COMPLETED' });
      return saveGiveaway(
        createGiveaway({
          ...existing,
          status: 'COMPLETED',
          winnersCount: 1,
          winners: [
            createGiveawayWinner({
              id: 'winner-2',
              userId: 'user-2',
              displayName: 'Новый победитель',
            }),
          ],
        }),
      );
    }),
    markManagedGiveawayWinnerDelivered: jest.fn().mockImplementation(async (_chatId, giveawayId) => {
      const existing = giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId, status: 'COMPLETED' });
      return saveGiveaway(
        createGiveaway({
          ...existing,
          status: 'COMPLETED',
          winnersCount: 1,
          winners: [createGiveawayWinner({ status: 'DELIVERED', deliveredAt: new Date().toISOString() })],
        }),
      );
    }),
    cancelManagedGiveaway: jest.fn().mockImplementation(async (_chatId, giveawayId) => {
      const existing = giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId });
      return saveGiveaway(createGiveaway({ ...existing, status: 'CANCELED' }));
    }),
  };

  const service = new PrivateControlService(
    maxClient as never,
    adminService as never,
    managedGiveawayService as never,
    undefined,
    {
      get: jest.fn((key: string) => {
        if (key === 'MAX_BOT_ID') {
          return '777000_bot';
        }
        if (key === 'APP_BASE_URL') {
          return 'https://maxim.play-team.ru';
        }
        return undefined;
      }),
    } as never,
  );

  return { service, maxClient, adminService, managedGiveawayService, chats, channels };
}

function getLastSentText(maxClient: { sendMessage: jest.Mock }): string {
  const call = maxClient.sendMessage.mock.calls.at(-1);
  return call ? String(call[1]) : '';
}

function getLastEditedText(maxClient: { answerCallback: jest.Mock }): string {
  const call = maxClient.answerCallback.mock.calls.at(-1);
  return call?.[2]?.text ? String(call[2].text) : '';
}

function getLastButtons(maxClient: { sendMessage: jest.Mock; answerCallback: jest.Mock }) {
  const sendButtons = maxClient.sendMessage.mock.calls.at(-1)?.[2]?.buttons;
  if (sendButtons) {
    return sendButtons as Array<Array<unknown>>;
  }

  const callbackButtons = maxClient.answerCallback.mock.calls.at(-1)?.[2]?.options?.buttons;
  return (callbackButtons ?? []) as Array<Array<unknown>>;
}

function extractStartPayload(url: string): string {
  const parsed = new URL(url);
  return parsed.searchParams.get('start') ?? '';
}

function mockImageFetch(buffer: Buffer = TINY_PNG, mimeType = 'image/png') {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? mimeType : null),
    },
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  });
  const originalFetch = global.fetch;
  Object.defineProperty(global, 'fetch', {
    configurable: true,
    writable: true,
    value: fetchMock,
  });

  return {
    fetchMock,
    restore() {
      Object.defineProperty(global, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    },
  };
}

describe('PrivateControlService', () => {
  it('renders the new entity picker for /menu in private dialog', async () => {
    const { service, maxClient, adminService } = createHarness();

    await service.handleUpdate(createPrivateTextUpdate('/menu'));

    expect(getLastSentText(maxClient)).toContain('Центр управления MAX');
    expect(getLastSentText(maxClient)).toContain('Выберите чат');
    expect(getLastButtons(maxClient).length).toBeGreaterThan(0);
    expect(adminService.listManagedEntities).toHaveBeenCalledTimes(1);
  });

  it('starts sticker flow from command and sends experimental sticker attachment for a photo', async () => {
    const { service, maxClient } = createHarness();
    const fetchControl = mockImageFetch();

    try {
      await service.handleUpdate(createPrivateTextUpdate('/sticker'));

      expect(getLastSentText(maxClient)).toContain('Фото или sticker');

      await service.handleUpdate(createPrivatePhotoUpdate());

      expect(maxClient.uploadImage).toHaveBeenCalledTimes(1);
      expect(maxClient.sendCustomMessageImmediate).toHaveBeenCalledWith(
        '152517912',
        expect.objectContaining({
          text: '',
          attachments: [expect.objectContaining({ type: 'sticker' })],
        }),
      );
      expect(getLastSentText(maxClient)).toContain('sticker отправлен');
    } finally {
      fetchControl.restore();
    }
  });

  it('falls back to image when MAX rejects experimental sticker attachment', async () => {
    const { service, maxClient } = createHarness();
    const fetchControl = mockImageFetch();
    maxClient.sendCustomMessageImmediate
      .mockRejectedValueOnce(new Error('sticker rejected #1'))
      .mockRejectedValueOnce(new Error('sticker rejected #2'))
      .mockRejectedValueOnce(new Error('sticker rejected #3'))
      .mockResolvedValueOnce({ message_id: 'msg-image-fallback-1' });

    try {
      await service.handleUpdate(createPrivatePhotoUpdate());

      expect(maxClient.sendCustomMessageImmediate).toHaveBeenCalledTimes(4);
      expect(maxClient.sendCustomMessageImmediate).toHaveBeenLastCalledWith(
        '152517912',
        expect.objectContaining({
          text: '',
          attachments: [expect.objectContaining({ type: 'image' })],
        }),
      );
      expect(getLastSentText(maxClient)).toContain('MAX не принял вложение как sticker');
    } finally {
      fetchControl.restore();
    }
  });

  it('reports image variant when MAX accepts only image payload with media_type=sticker', async () => {
    const { service, maxClient } = createHarness();
    const fetchControl = mockImageFetch();
    maxClient.sendCustomMessageImmediate
      .mockRejectedValueOnce(new Error('sticker rejected #1'))
      .mockRejectedValueOnce(new Error('sticker rejected #2'))
      .mockResolvedValueOnce({ message_id: 'msg-image-variant-1' });

    try {
      await service.handleUpdate(createPrivatePhotoUpdate());

      expect(maxClient.sendCustomMessageImmediate).toHaveBeenCalledTimes(3);
      expect(maxClient.uploadImage).toHaveBeenCalledWith(
        expect.any(Buffer),
        'private-sticker-source-photo-1.png',
        'image/png',
      );
      expect(maxClient.sendCustomMessageImmediate).toHaveBeenLastCalledWith(
        '152517912',
        {
          text: '',
          attachments: [
            {
              type: 'image',
              payload: {
                media_type: 'sticker',
                mime_type: 'image/png',
                token: 'upload-token-1',
              },
            },
          ],
        },
      );
      expect(maxClient.sendCustomMessageImmediate).toHaveBeenNthCalledWith(
        2,
        '152517912',
        {
          text: '',
          attachments: [
            {
              type: 'sticker',
              payload: {
                mime_type: 'image/png',
                token: 'upload-token-1',
              },
            },
          ],
        },
      );
      expect(getLastSentText(maxClient)).toContain('MAX принял только image-вариант');
      expect(getLastSentText(maxClient)).not.toContain('sticker отправлен');
    } finally {
      fetchControl.restore();
    }
  });

  it('resends incoming sticker by code during sticker flow', async () => {
    const { service, maxClient } = createHarness();

    await service.handleUpdate(createPrivateTextUpdate('/sticker'));
    await service.handleUpdate(createPrivateStickerUpdate());

    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    expect(maxClient.sendCustomMessageImmediate).toHaveBeenCalledWith('152517912', {
      text: '',
      attachments: [
        {
          type: 'sticker',
          payload: {
            code: '1e1321f26',
          },
        },
      ],
    });
    expect(getLastSentText(maxClient)).toContain('sticker отправлен');
  });

  it('resends incoming sticker by code without explicit command', async () => {
    const { service, maxClient } = createHarness();

    await service.handleUpdate(createPrivateStickerUpdate('copy-test-42'));

    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    expect(maxClient.sendCustomMessageImmediate).toHaveBeenCalledWith('152517912', {
      text: '',
      attachments: [
        {
          type: 'sticker',
          payload: {
            code: 'copy-test-42',
          },
        },
      ],
    });
  });

  it('opens chat home, settings hub, and toggles a section setting via callback edit', async () => {
    const { service, maxClient, adminService, chats } = createHarness({
      settings: {
        ...defaultSettings,
        greetingEnabled: false,
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_settings_hub'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_section|greeting'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|toggle|greeting|greetingEnabled'));

    expect(getLastEditedText(maxClient)).toContain('Приветствие');
    expect(adminService.updateSettings).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ greetingEnabled: true }),
      'private_bot',
    );
  });

  it('treats /legacy and /modern as aliases for the current interface', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateTextUpdate('/legacy'));
    await service.handleUpdate(createPrivateTextUpdate('/modern'));

    const sentMessages = maxClient.sendMessage.mock.calls.map((call) => String(call[1]));
    expect(sentMessages.some((text) => text.includes('Центр управления чатом'))).toBe(true);
    expect(sentMessages.some((text) => text.includes('классический вид'))).toBe(false);
  });

  it('handles stale legacy callback payload and refreshes current screen', async () => {
    const { service, maxClient } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate('private_menu:chats'));

    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      expect.stringContaining('Кнопки устарели'),
      expect.objectContaining({
        text: expect.any(String),
      }),
    );
  });

  it('updates bounded number settings through callback presets and stepper buttons', async () => {
    const { service, adminService, chats } = createHarness({
      settings: {
        ...defaultSettings,
        duplicateWarnMaxCount: 2,
        banDurationHours: 6,
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_section|duplicates'));
    await service.handleUpdate(
      createPrivateCallbackUpdate('pc2|set_number_preset|duplicates|duplicateWarnMaxCount|5'),
    );
    await service.handleUpdate(
      createPrivateCallbackUpdate('pc2|step_number|duplicates|banDurationHours|1'),
    );

    expect(adminService.updateSettings).toHaveBeenNthCalledWith(
      1,
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ duplicateWarnMaxCount: 5 }),
      'private_bot',
    );
    expect(adminService.updateSettings).toHaveBeenNthCalledWith(
      2,
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ banDurationHours: 7 }),
      'private_bot',
    );
  });

  it('supports search results with return through history stack', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_settings_hub'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_search'));
    await service.handleUpdate(createPrivateTextUpdate('привет'));

    expect(getLastSentText(maxClient)).toContain('Результаты поиска');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|back'));
    expect(getLastEditedText(maxClient)).toContain('Разделы настроек');
  });

  it('sends a channel broadcast from private control', async () => {
    const { service, adminService, channels } = createHarness();

    await service.handleUpdate(
      createPrivateCallbackUpdate(`pc2|chat_select|channel|${channels[0].id}`),
    );
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_broadcast'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_input_prompt|text'));
    await service.handleUpdate(createPrivateTextUpdate('Новый пост для канала'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));

    expect(adminService.sendChannelBroadcast).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: 'Новый пост для канала',
        applyToAllChats: false,
      }),
      'private_bot',
    );
  });

  it('hands off chat broadcast from miniapp into private bot content flow', async () => {
    const { service, adminService, maxClient, chats } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    const result = await service.handoffBroadcastFromMiniapp(
      chats[0].id,
      actor,
      {
        applyToAllChats: true,
        buttonEnabled: true,
        buttonUrl: 'https://max.ru/channel/test',
        buttonText: 'Открыть',
        sendAt: '2026-03-13T12:00:00.000Z',
        cycleEnabled: true,
        cycleEveryHours: 6,
        cycleCount: 3,
      },
      'chat',
    );

    expect(result.botUrl).toBe('https://max.ru/777000_bot?start=broadcast_handoff');

    await service.handleBotStarted(createBotStartedPrivateUpdate());

    expect(getLastSentText(maxClient)).toContain('Рассылка');
    expect(getLastSentText(maxClient)).toContain('Контент: жду следующее сообщение');

    await service.handleUpdate(createPrivateTextUpdate('Контент из лички бота'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|mass_confirm'));

    expect(adminService.sendBroadcast).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: 'Контент из лички бота',
        applyToAllChats: true,
        buttonEnabled: true,
        buttonUrl: 'https://max.ru/channel/test',
        sendAt: '2026-03-13T12:00:00.000Z',
        cycleEnabled: true,
        cycleEveryHours: 6,
        cycleCount: 3,
      }),
      'private_bot',
    );
  });

  it('shows only channel discussion status on the handoff broadcast screen without footer links', async () => {
    const { service, maxClient, channels } = createHarness({
      channelSettings: {
        ...defaultChannelSettings,
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        postSuggestionsButtonEnabled: false,
      },
    });
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: channels[0].id,
      chatTitle: channels[0].title,
    };

    await service.handoffBroadcastFromMiniapp(
      channels[0].id,
      actor,
      {
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 24,
        cycleCount: 1,
      },
      'channel',
    );

    await service.handleBotStarted(createBotStartedPrivateUpdate());

    expect(getLastSentText(maxClient)).toContain('Рассылка в канал');
    expect(getLastSentText(maxClient)).toContain('Комментарии: вкл');
    expect(getLastSentText(maxClient)).not.toContain('Предложка:');
    expect(getLastSentText(maxClient)).not.toContain('Кнопка предложки:');

    const buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));

    expect(buttonTexts).not.toContain('Открыть приложение');
    expect(buttonTexts).not.toContain('Поддержка');
  });

  it('allows adding photo after text on the broadcast screen without extra button press', async () => {
    const { service, adminService, chats } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };
    const originalFetch = global.fetch;
    const imageBuffer = Buffer.from('test-image');

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/jpeg' : null),
      },
      arrayBuffer: async () =>
        imageBuffer.buffer.slice(
          imageBuffer.byteOffset,
          imageBuffer.byteOffset + imageBuffer.byteLength,
        ),
    }) as typeof fetch;

    try {
      await service.handoffBroadcastFromMiniapp(
        chats[0].id,
        actor,
        {
          applyToAllChats: false,
          buttonEnabled: false,
          buttonUrl: '',
          buttonText: 'Открыть',
          sendAt: null,
          cycleEnabled: false,
          cycleEveryHours: 1,
          cycleCount: 1,
        },
        'chat',
      );

      await service.handleBotStarted(createBotStartedPrivateUpdate());
      await service.handleUpdate(createPrivateTextUpdate('Текст перед фото'));
      await service.handleUpdate(createPrivatePhotoUpdate());
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));

      expect(adminService.sendBroadcast).toHaveBeenCalledWith(
        chats[0].id,
        expect.objectContaining({ userId: 'user-1' }),
        expect.objectContaining({
          text: 'Текст перед фото',
          imageEnabled: true,
          imageMimeType: 'image/jpeg',
          imageFileName: expect.stringContaining('private-broadcast-photo-1'),
        }),
        'private_bot',
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('hands off giveaway from miniapp into private bot management flow', async () => {
    const { service, maxClient, chats, managedGiveawayService } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    const result = await service.handoffGiveawayFromMiniapp(
      chats[0].id,
      actor,
      {
        giveawayId: 'giveaway-1',
      },
      'chat',
    );

    expect(result.botUrl).toContain('https://max.ru/777000_bot?start=');

    await service.handleBotStarted(createBotStartedPrivateUpdate(extractStartPayload(result.botUrl)));

    expect(managedGiveawayService.getManagedGiveaway).toHaveBeenCalledWith(
      chats[0].id,
      'giveaway-1',
      expect.objectContaining({ userId: 'user-1' }),
      'chat',
    );
    expect(getLastSentText(maxClient)).toContain('Название: Весенний розыгрыш');
    expect(getLastSentText(maxClient)).toContain('Фото: нет');
  });

  it('starts a new giveaway draft in private bot when there is no current giveaway', async () => {
    const { service, maxClient, chats, managedGiveawayService } = createHarness({
      managedGiveaway: null,
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_giveaway'));

    expect(getLastEditedText(maxClient)).toContain('Состояние: пусто');
    expect(
      getLastButtons(maxClient)
        .flat()
        .some(
          (button) =>
            typeof button === 'object' &&
            button !== null &&
            'text' in button &&
            button.text === 'Создать черновик',
        ),
    ).toBe(true);

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_create'));

    expect(managedGiveawayService.createManagedGiveaway).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        title: 'Новый розыгрыш',
        prizes: [{ position: 1, title: 'Приз 1' }],
      }),
      'chat',
      'private_bot',
    );
    expect(getLastEditedText(maxClient)).toContain('Статус: Черновик');
  });

  it('updates giveaway title from private bot input prompt', async () => {
    const { service, chats, managedGiveawayService } = createHarness({
      managedGiveaway: createGiveaway({
        id: 'giveaway-draft-1',
        status: 'DRAFT',
        publicationMessageId: null,
        publicationUrl: null,
        publishedAt: null,
      }),
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_giveaway'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_input_prompt|title'));
    await service.handleUpdate(createPrivateTextUpdate('Розыгрыш апреля'));

    expect(managedGiveawayService.updateManagedGiveaway).toHaveBeenCalledWith(
      chats[0].id,
      'giveaway-draft-1',
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        title: 'Розыгрыш апреля',
      }),
      'chat',
      'private_bot',
    );
  });

  it('opens the poll screen and publishes a poll from private control', async () => {
    const { service, maxClient, adminService, chats } = createHarness({
      adminService: {
        getChatPoll: jest.fn().mockResolvedValue(createPoll()),
        updateChatPoll: jest.fn().mockImplementation(async (_chatId, _actor, draft) =>
          createPoll({
            question: draft.question,
            options: draft.options,
          }),
        ),
        publishChatPoll: jest.fn().mockResolvedValue(
          createPoll({
            question: 'Выбираем режим?',
            status: 'ACTIVE',
            activeVersion: 1,
            publishedMessageId: 'mid-poll-1',
            publishedUrl: 'https://max.ru/chats/chat-1/message/1',
          }),
        ),
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_poll'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|poll_input_prompt|question'));
    await service.handleUpdate(createPrivateTextUpdate('Выбираем режим?'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|poll_publish'));

    expect(adminService.getChatPoll).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(adminService.updateChatPoll).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      {
        question: 'Выбираем режим?',
        options: ['', ''],
      },
      'private_bot',
    );
    expect(adminService.publishChatPoll).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      'private_bot',
    );
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      'Опрос опубликован',
      expect.objectContaining({
        text: expect.stringContaining('Статус: Активен'),
      }),
    );
  });

  it('opens giveaway screen from private control and shows current giveaway', async () => {
    const { service, maxClient, chats, managedGiveawayService } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_giveaway'));

    expect(managedGiveawayService.getCurrentManagedGiveawayForEntity).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      'chat',
    );
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      'Открываю розыгрыши',
      expect.objectContaining({
        text: expect.stringContaining('Название: Весенний розыгрыш'),
      }),
    );
  });

  it('rerolls a giveaway winner from private control', async () => {
    const { service, chats, managedGiveawayService } = createHarness();
    managedGiveawayService.getCurrentManagedGiveawayForEntity.mockResolvedValue(
      createGiveaway({
        status: 'COMPLETED',
        winnersCount: 1,
        winners: [createGiveawayWinner({ status: 'EXPIRED' })],
      }),
    );

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_giveaway'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_reroll|winner-1'));

    expect(managedGiveawayService.rerollManagedGiveawayWinner).toHaveBeenCalledWith(
      chats[0].id,
      'giveaway-1',
      expect.objectContaining({ userId: 'user-1' }),
      { winnerId: 'winner-1' },
      'chat',
      'private_bot',
    );
  });

  it('marks giveaway prize as delivered from private control', async () => {
    const { service, chats, managedGiveawayService } = createHarness();
    managedGiveawayService.getCurrentManagedGiveawayForEntity.mockResolvedValue(
      createGiveaway({
        status: 'COMPLETED',
        winnersCount: 1,
        winners: [createGiveawayWinner({ status: 'CLAIMED', claimedAt: new Date().toISOString() })],
      }),
    );

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_giveaway'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_deliver|winner-1'));

    expect(managedGiveawayService.markManagedGiveawayWinnerDelivered).toHaveBeenCalledWith(
      chats[0].id,
      'giveaway-1',
      expect.objectContaining({ userId: 'user-1' }),
      { winnerId: 'winner-1' },
      'chat',
      'private_bot',
    );
  });

  it('renders giveaway claim flow on bot_started deep link and confirms claim', async () => {
    const { service, maxClient, managedGiveawayService } = createHarness();

    await service.handleBotStarted(createBotStartedGiveawayClaimUpdate());
    expect(managedGiveawayService.parseClaimStartPayload).toHaveBeenCalledWith('ggc-test-payload');
    expect(
      getLastButtons(maxClient)
        .flat()
        .some(
          (button) =>
            typeof button === 'object' &&
            button !== null &&
            'text' in button &&
            button.text === 'Подтвердить приз',
        ),
    ).toBe(true);
    expect(
      getLastButtons(maxClient)
        .flat()
        .some(
          (button) =>
            typeof button === 'object' &&
            button !== null &&
            'text' in button &&
            button.text === 'Открыть розыгрыш',
        ),
    ).toBe(true);

    await service.handleUpdate(
      createPrivateCallbackUpdate('pc2|giveaway_claim_confirm|giveaway-1|winner-1'),
    );

    expect(managedGiveawayService.claimGiveaway).toHaveBeenCalledWith(
      'giveaway-1',
      expect.objectContaining({ userId: 'user-1' }),
      'private_claim',
    );
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      'Claim подтверждён',
      expect.objectContaining({
        text: expect.stringContaining('Приз подтверждён'),
      }),
    );
  });

  it('keeps key private screens under a safe inline-button count', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateTextUpdate('/menu'));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(20);

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(20);

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_settings_hub'));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(20);

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_section|duplicates'));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(40);
  });
});
