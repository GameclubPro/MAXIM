import { BadRequestException } from '@nestjs/common';
import {
  channelSettingsSchema,
  chatSettingsSchema,
  type ChatRules,
  type ManagedGiveawayDetails,
  type ManagedGiveawayWinner,
  type ManagedPoll,
  type MaxUpdate,
} from '@maxim/contracts';
import { PrivateControlService } from './private-control.service';

function decodeStartAppRoute(url: string): string | null {
  const startParam = new URL(url).searchParams.get('startapp');
  if (!startParam?.startsWith('mr-')) {
    return null;
  }

  const encodedPayload = startParam.slice(3);
  const normalized = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const payload = JSON.parse(Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8')) as {
    v?: number;
    k?: string;
    r?: string;
  };

  return payload.v === 1 && payload.k === 'route' && typeof payload.r === 'string'
    ? payload.r
    : null;
}

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

function createPrivateForwardedBanUpdate(text = 'бан'): MaxUpdate {
  return {
    updateId: `upd-forwarded-ban-${Date.now()}`,
    type: 'message_created',
    message: {
      messageId: `msg-forwarded-ban-${Date.now()}`,
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
          forwarded_message: {
            sender: {
              user_id: 'user-77',
              name: 'Нарушитель',
            },
            recipient: {
              chat_id: -70000000000001,
              title: 'Тестовый чат 1',
            },
            body: {
              text: 'Сомнительное сообщение',
            },
          },
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

function createPrivateFormattedTextUpdate(
  text: string,
  markup: Array<{
    type:
      | 'emphasized'
      | 'heading'
      | 'link'
      | 'monospaced'
      | 'strikethrough'
      | 'strong'
      | 'underline'
      | 'user_mention';
    from: number;
    length: number;
    url?: string;
    user_link?: string;
  }>,
): MaxUpdate {
  return {
    updateId: `upd-formatted-text-${Date.now()}`,
    type: 'message_created',
    message: {
      messageId: `msg-formatted-${Date.now()}`,
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
          markup,
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

function createPrivateTextAndPhotoUpdate(text: string): MaxUpdate {
  return {
    updateId: `upd-text-photo-${Date.now()}`,
    type: 'message_created',
    message: {
      messageId: `msg-text-photo-${Date.now()}`,
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
          attachments: [
            {
              type: 'image',
              payload: {
                url: 'https://example.test/rules-photo.jpg',
                photo_id: 'rules-photo-1',
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

function createPrivateFileUpdate(
  fileName = 'photo-as-file.png',
  url = 'https://example.test/photo-as-file.png',
): MaxUpdate {
  return {
    updateId: `upd-file-${Date.now()}`,
    type: 'message_created',
    message: {
      messageId: `msg-file-${Date.now()}`,
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
              type: 'file',
              size: 12345,
              filename: fileName,
              payload: {
                url,
                token: 'file-token-1',
                fileId: 'file-1',
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

function createPrivateImageFileUpdate(): MaxUpdate {
  return createPrivateFileUpdate();
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

function createRules(overrides: Partial<ChatRules> = {}): ChatRules {
  return {
    text: '',
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    autoTextEnabled: false,
    publishedMessageId: null,
    publishedUrl: null,
    publishedAt: null,
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
    requiredChannelIds: [],
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
    rules?: ChatRules;
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
    getChatMemberProfiles: jest.fn().mockResolvedValue(new Map()),
  };

  let currentRules = overrides.rules ?? createRules();

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
    getChatHeader: jest.fn().mockResolvedValue({ id: chats[0].id, title: chats[0].title }),
    getChannelHeader: jest.fn().mockResolvedValue({ id: channels[0].id, title: channels[0].title }),
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
    getRules: jest.fn().mockImplementation(async () => currentRules),
    updateRules: jest.fn().mockImplementation(async (_chatId, _actor, payload) => {
      currentRules = createRules({
        ...currentRules,
        text: payload.text,
        imageBase64: payload.imageBase64,
        imageMimeType: payload.imageMimeType,
        imageFileName: payload.imageFileName,
        autoTextEnabled: payload.autoTextEnabled,
      });
      return currentRules;
    }),
    publishRules: jest.fn().mockImplementation(async () => {
      currentRules = createRules({
        ...currentRules,
        publishedMessageId: 'mid-rules-1',
        publishedUrl: 'https://max.ru/chats/chat-1/message/1',
        publishedAt: new Date().toISOString(),
      });
      return {
        chatId: chats[0].id,
        messageId: currentRules.publishedMessageId!,
        url: currentRules.publishedUrl,
        publishedAt: currentRules.publishedAt!,
      };
    }),
    resetPublishedRules: jest.fn().mockImplementation(async () => {
      currentRules = createRules({
        ...currentRules,
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
      });
      return currentRules;
    }),
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
    applyManualSystemBan: jest.fn().mockResolvedValue({
      ok: true,
      action: 'BAN',
      userId: 'user-77',
      banDurationHours: null,
      unbanScheduledAt: null,
      message: 'Участник забанен в чате.',
    }),
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
    createChannelSuggestionFromBot: jest.fn().mockResolvedValue({
      ok: true,
      delivered: true,
      deliveredToUserId: 'admin-1',
    }),
    parseChannelSuggestionStartPayload: jest.fn((payload: string | null) => {
      if (!payload?.startsWith('cds-')) {
        return null;
      }

      const separatorIndex = payload.indexOf(':');
      if (separatorIndex <= 4) {
        return null;
      }

      const chatId = payload.slice(4, separatorIndex).trim();
      const token = payload.slice(separatorIndex + 1).trim();
      if (!chatId || !token) {
        return null;
      }

      return { chatId, token };
    }),
    publishChannelEngagementMessage: jest.fn().mockResolvedValue(undefined),
    ...overrides.adminService,
  };

  let currentGiveaway =
    overrides.managedGiveaway === undefined ? createGiveaway() : overrides.managedGiveaway;
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
      winner: createGiveawayWinner({
        status: 'CLAIMED',
        claimDeadlineAt: null,
        claimedAt: new Date().toISOString(),
      }),
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
    updateManagedGiveaway: jest
      .fn()
      .mockImplementation(async (_chatId, giveawayId, _actor, payload) => {
        const existing =
          giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId, status: 'DRAFT' });
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
      .mockReturnValue(
        'https://maxim.play-team.ru/app/chat/-70000000000001/settings?focus=giveaway',
      ),
    getGiveawayPublicMiniappUrl: jest
      .fn()
      .mockReturnValue('https://maxim.play-team.ru/app/giveaways/giveaway-1'),
    publishManagedGiveaway: jest.fn().mockImplementation(async (_chatId, giveawayId) => {
      const existing =
        giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId, status: 'DRAFT' });
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
      const existing =
        giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId, status: 'COMPLETED' });
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
    markManagedGiveawayWinnerDelivered: jest
      .fn()
      .mockImplementation(async (_chatId, giveawayId) => {
        const existing =
          giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId, status: 'COMPLETED' });
        return saveGiveaway(
          createGiveaway({
            ...existing,
            status: 'COMPLETED',
            winnersCount: 1,
            winners: [
              createGiveawayWinner({ status: 'DELIVERED', deliveredAt: new Date().toISOString() }),
            ],
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

function getLastEditedButtons(maxClient: { answerCallback: jest.Mock }) {
  const call = maxClient.answerCallback.mock.calls.at(-1);
  return (call?.[2]?.options?.buttons ?? []) as Array<Array<unknown>>;
}

function getLastUiText(maxClient: { sendMessage: jest.Mock; answerCallback: jest.Mock }): string {
  return getLastSentText(maxClient) || getLastEditedText(maxClient);
}

function getLastButtons(maxClient: { sendMessage: jest.Mock; answerCallback: jest.Mock }) {
  const sendButtons = maxClient.sendMessage.mock.calls.at(-1)?.[2]?.buttons;
  if (sendButtons) {
    return sendButtons as Array<Array<unknown>>;
  }

  const callbackButtons = maxClient.answerCallback.mock.calls.at(-1)?.[2]?.options?.buttons;
  return (callbackButtons ?? []) as Array<Array<unknown>>;
}

function getLastSendOptions(maxClient: { sendMessage: jest.Mock }) {
  const call = maxClient.sendMessage.mock.calls.at(-1);
  return (call?.[2] ?? null) as Record<string, unknown> | null;
}

function extractStartPayload(url: string): string {
  const parsed = new URL(url);
  return parsed.searchParams.get('start') ?? '';
}

function encodeChannelSuggestionStartPayload(chatId: string, token: string): string {
  return `cds-${chatId}:${token}`;
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
  it('renders the entity picker for plain text in private dialog', async () => {
    const { service, maxClient, adminService } = createHarness();

    await service.handleUpdate(createPrivateTextUpdate('привет'));

    expect(getLastUiText(maxClient)).toContain('Выбор: чат');
    expect(getLastUiText(maxClient)).toContain('Нажмите на нужный чат');
    expect(getLastButtons(maxClient).length).toBeGreaterThan(0);
    expect(adminService.listManagedEntities).toHaveBeenCalledTimes(1);
  });

  it('refreshes inline chat picker and shows newly discovered chats', async () => {
    const staleChats = [
      {
        id: '-70000000000001',
        title: 'Тестовый чат 1',
        createdAt: new Date('2026-03-15T17:00:00.000Z').toISOString(),
        entityType: 'chat' as const,
      },
    ];
    const freshChats = [
      ...staleChats,
      {
        id: '-70000000000002',
        title: 'Новый чат',
        createdAt: new Date('2026-03-15T17:05:00.000Z').toISOString(),
        entityType: 'chat' as const,
      },
    ];
    const listManagedEntities = jest
      .fn()
      .mockImplementation(async (_actor, entityType = 'all', options?: { refresh?: boolean }) => {
        if (entityType === 'channel') {
          return [];
        }
        if (entityType === 'chat') {
          return options?.refresh === true ? freshChats : staleChats;
        }
        return options?.refresh === true ? freshChats : staleChats;
      });
    const { service, maxClient } = createHarness({
      adminService: {
        listManagedEntities,
        listChats: jest.fn().mockResolvedValue(freshChats),
      },
    });

    await service.handleUpdate(createPrivateTextUpdate('меню'));

    let buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts.some((text) => text.includes('Обновить'))).toBe(true);
    expect(buttonTexts.some((text) => text.includes('Новый чат'))).toBe(false);

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|chat_refresh'));

    expect(listManagedEntities).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'chat',
      { refresh: true },
    );
    expect(getLastEditedText(maxClient)).toContain('1-2 из 2 (чаты)');
    buttonTexts = getLastEditedButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts.some((text) => text.includes('Обновить'))).toBe(true);
  });

  it('does not expose sticker-from-photo action in the private bot navigation', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateTextUpdate('меню'));
    expect(
      getLastButtons(maxClient)
        .flat()
        .map((button) => String((button as { text?: string }).text ?? '')),
    ).not.toContain('Стикер из фото');

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    expect(
      getLastButtons(maxClient)
        .flat()
        .map((button) => String((button as { text?: string }).text ?? '')),
    ).not.toContain('Стикер из фото');
  });

  it('does not hijack a plain photo into sticker flow when no content input is active', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivatePhotoUpdate());

    expect(maxClient.sendCustomMessageImmediate).not.toHaveBeenCalled();
    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    expect(getLastUiText(maxClient)).toContain('Панель чата');
  });

  it('redirects settings callbacks to mini app instead of editing inline', async () => {
    const { service, maxClient, adminService, chats } = createHarness({
      settings: {
        ...defaultSettings,
        greetingEnabled: false,
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_settings_hub'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|toggle|greeting|greetingEnabled'));

    expect(getLastEditedText(maxClient)).toContain('Настройки перенесены в mini app');
    expect(getLastEditedText(maxClient)).toContain('inline-кнопками');
    expect(
      getLastEditedButtons(maxClient)
        .flat()
        .map((button) => String((button as { text?: string }).text ?? '')),
    ).toContain('Открыть управление');
    expect(adminService.updateSettings).not.toHaveBeenCalled();
  });

  it('treats /legacy and /modern as aliases for the current interface', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateTextUpdate('/legacy'));
    await service.handleUpdate(createPrivateTextUpdate('/modern'));

    const sentMessages = maxClient.sendMessage.mock.calls.map((call) => String(call[1]));
    expect(sentMessages.some((text) => text.includes('Чат:'))).toBe(true);
    expect(sentMessages.some((text) => text.includes('классический вид'))).toBe(false);
  });

  it('bans a forwarded sender from private chat with the permanent ban command', async () => {
    const { service, adminService, maxClient, chats } = createHarness({
      settings: {
        ...defaultSettings,
        banDurationHours: 12,
      },
    });

    await service.handleUpdate(createPrivateForwardedBanUpdate());

    expect(adminService.applyManualSystemBan).toHaveBeenCalledWith(
      chats[0].id,
      'user-77',
      expect.objectContaining({
        userId: 'user-1',
        chatId: '152517912',
      }),
      'private_command',
    );
    expect(adminService.applyManualModerationAction).not.toHaveBeenCalled();
    expect(getLastSentText(maxClient)).toContain('Участник забанен в чате.');
    expect(getLastSentText(maxClient)).toContain(`Чат: ${chats[0].title}`);
    expect(getLastSentText(maxClient)).toContain('Пользователь: Нарушитель (user-77)');
  });

  it('rejects explicit duration in the forwarded ban command', async () => {
    const { service, adminService, maxClient } = createHarness({
      settings: {
        ...defaultSettings,
        banDurationHours: 6,
      },
    });

    await service.handleUpdate(createPrivateForwardedBanUpdate('бан 24'));

    expect(adminService.applyManualSystemBan).not.toHaveBeenCalled();
    expect(getLastSentText(maxClient)).toContain(
      'Команда «бан» теперь делает только постоянный системный бан. Используйте просто «бан».',
    );
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

  it('redirects stale numeric settings callbacks to mini app', async () => {
    const { service, maxClient, adminService, chats } = createHarness({
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

    expect(getLastEditedText(maxClient)).toContain('Настройки перенесены в mini app');
    expect(adminService.updateSettings).not.toHaveBeenCalled();
  });

  it('redirects search callbacks to mini app', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_settings_hub'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_search'));

    expect(getLastEditedText(maxClient)).toContain('Настройки перенесены в mini app');
    expect(getLastEditedText(maxClient)).toContain('rich-сценарии');
  });

  it('opens the rules screen from chat home', async () => {
    const { service, maxClient, chats } = createHarness({
      rules: createRules({
        text: 'Соблюдайте **правила** чата.',
      }),
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));

    expect(getLastUiText(maxClient)).toContain('Правила');
    expect(getLastUiText(maxClient)).toContain('Текст правил:');
    expect(getLastUiText(maxClient)).toContain('Соблюдайте **правила** чата.');
    expect(getLastUiText(maxClient)).not.toContain('Превью:');

    const buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toContain('Изменить текст');
    expect(buttonTexts).toContain('Добавить фото');
    expect(buttonTexts).toContain('Опубликовать');
    expect(buttonTexts).toContain('Мини-апп');
    expect(buttonTexts).not.toContain('Сбросить публикацию');
    expect(buttonTexts).not.toContain('✅ Кнопка "Правила" в нарушениях');
    expect(maxClient.answerCallback.mock.calls.at(-1)?.[2]?.options?.textFormat).toBe('markdown');

    const miniappButton = getLastButtons(maxClient)
      .flat()
      .find((button) => String((button as { text?: string }).text ?? '') === 'Мини-апп') as
      | {
          type?: string;
          url?: string;
        }
      | undefined;

    expect(miniappButton).toMatchObject({
      type: 'link',
    });
    expect(String(miniappButton?.url ?? '')).toContain('https://max.ru/777000_bot?startapp=');
    expect(decodeStartAppRoute(String(miniappButton?.url ?? ''))).toBe(
      `/chat/${encodeURIComponent(chats[0].id)}/settings?focus=rules&handoff=1`,
    );
  });

  it('hands off chat rules from miniapp into private bot rules flow', async () => {
    const { service, maxClient, chats } = createHarness({
      rules: createRules({
        text: 'Правила из handoff.',
      }),
    });
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    const result = await service.handoffRulesFromMiniapp(chats[0].id, actor);
    expect(result.botUrl).toBe('https://max.ru/777000_bot?start=rules_handoff');

    await service.handleBotStarted(createBotStartedPrivateUpdate('rules_handoff'));

    expect(getLastSentText(maxClient)).toContain('Правила');
    expect(getLastSentText(maxClient)).toContain('Правила из handoff.');
  });

  it('updates rules text only after choosing the text button', async () => {
    const { service, adminService, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|text'));
    await service.handleUpdate(createPrivateTextUpdate('Новый текст правил'));

    expect(adminService.updateRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: 'Новый текст правил',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: false,
      }),
      'private_bot',
    );
  });

  it('preserves incoming MAX text markup when saving rules from private bot', async () => {
    const { service, adminService, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|text'));
    await service.handleUpdate(
      createPrivateFormattedTextUpdate('Жирный текст правил', [
        {
          type: 'strong',
          from: 0,
          length: 6,
        },
      ]),
    );

    expect(adminService.updateRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: '**Жирный** текст правил',
        autoTextEnabled: false,
      }),
      'private_bot',
    );
  });

  it('does not autosave rules content without an explicit input button', async () => {
    const { service, adminService, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateTextUpdate('Новый текст правил'));

    expect(adminService.updateRules).not.toHaveBeenCalled();
    expect(getLastSentText(maxClient)).toContain(
      'Сначала нажмите «Изменить текст» или «Добавить фото»',
    );
  });

  it('keeps the user on the rules screen after pressing the text button', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|text'));

    expect(getLastEditedText(maxClient)).toContain('Правила');
    expect(getLastEditedText(maxClient)).toContain('Жду: Жду новый текст одним сообщением.');

    const buttonTexts = getLastEditedButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toContain('Изменить текст');
    expect(buttonTexts).toContain('Добавить фото');
  });

  it('updates rules photo from image and image-file messages in private bot', async () => {
    const { service, adminService, chats } = createHarness({
      rules: createRules({
        text: 'Правила с фото.',
      }),
    });
    const { restore } = mockImageFetch(TINY_PNG, 'image/png');

    try {
      await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|photo'));
      await service.handleUpdate(createPrivatePhotoUpdate());
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|photo'));
      await service.handleUpdate(createPrivateImageFileUpdate());

      expect(adminService.updateRules).toHaveBeenNthCalledWith(
        1,
        chats[0].id,
        expect.objectContaining({ userId: 'user-1' }),
        expect.objectContaining({
          text: 'Правила с фото.',
          imageMimeType: 'image/png',
          imageFileName: expect.stringContaining('private-rules-photo-1'),
        }),
        'private_bot',
      );
      expect(adminService.updateRules).toHaveBeenNthCalledWith(
        2,
        chats[0].id,
        expect.objectContaining({ userId: 'user-1' }),
        expect.objectContaining({
          text: 'Правила с фото.',
          imageMimeType: 'image/png',
          imageFileName: 'photo-as-file.png',
        }),
        'private_bot',
      );
    } finally {
      restore();
    }
  });

  it('rejects mixed text and photo when text mode is selected', async () => {
    const { service, adminService, maxClient, chats } = createHarness();
    const { restore } = mockImageFetch(TINY_PNG, 'image/jpeg');

    try {
      await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|text'));
      await service.handleUpdate(createPrivateTextAndPhotoUpdate('Правила + фото'));

      expect(adminService.updateRules).not.toHaveBeenCalled();
      expect(getLastSentText(maxClient)).toContain(
        'Для текста правил отправьте только текст без вложений.',
      );
    } finally {
      restore();
    }
  });

  it('supports rules photo cleanup, toggle, publish, and publication reset in private bot', async () => {
    const { service, adminService, chats } = createHarness({
      rules: createRules({
        text: 'Правила чата',
        imageBase64: TINY_PNG.toString('base64'),
        imageMimeType: 'image/png',
        imageFileName: 'rules.png',
      }),
      settings: {
        ...defaultSettings,
        rulesAttachViolationsEnabled: false,
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_clear_photo'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_toggle_attach'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_publish'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_reset_publication'));

    expect(adminService.updateRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: 'Правила чата',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: false,
      }),
      'private_bot',
    );
    expect(adminService.updateSettings).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ rulesAttachViolationsEnabled: true }),
      'private_bot',
    );
    expect(adminService.publishRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      'private_bot',
    );
    expect(adminService.resetPublishedRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      'private_bot',
    );
  });

  it('surfaces publish error when rules text is empty', async () => {
    const { service, maxClient, chats } = createHarness({
      adminService: {
        publishRules: jest
          .fn()
          .mockRejectedValue(new BadRequestException('Сначала заполните текст правил.')),
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_publish'));

    expect(getLastSentText(maxClient)).toContain('Сначала заполните текст правил.');
  });

  it('sends a channel broadcast from private control and posts a success follow-up', async () => {
    const { service, adminService, maxClient, channels } = createHarness();

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
    expect(getLastEditedText(maxClient)).toContain('Опубликовано без ошибок.');
    expect(getLastSentText(maxClient)).toContain('✅ Всё успешно.');
    expect(getLastSentText(maxClient)).toContain('Рассылка отправлена без ошибок.');
  });

  it('preserves incoming MAX text markup when sending broadcast from private bot', async () => {
    const { service, adminService, maxClient, channels } = createHarness();

    await service.handleUpdate(
      createPrivateCallbackUpdate(`pc2|chat_select|channel|${channels[0].id}`),
    );
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_broadcast'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_input_prompt|text'));
    await service.handleUpdate(
      createPrivateFormattedTextUpdate('Важный анонс', [
        {
          type: 'strong',
          from: 0,
          length: 6,
        },
      ]),
    );

    expect(getLastSendOptions(maxClient)).toEqual(
      expect.objectContaining({
        textFormat: 'html',
      }),
    );
    expect(getLastSentText(maxClient)).toContain('<strong>Важный</strong>');
    expect(getLastSentText(maxClient)).not.toContain('**Важный**');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));

    expect(adminService.sendChannelBroadcast).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: '**Важный** анонс',
        textFormat: 'markdown',
        applyToAllChats: false,
      }),
      'private_bot',
    );
  });

  it('renders giveaway content preview without raw markdown markers in private bot', async () => {
    const { service, maxClient, chats } = createHarness({
      managedGiveaway: createGiveaway({
        id: 'giveaway-draft-1',
        status: 'DRAFT',
        description: '',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        publicationMessageId: null,
        publicationUrl: null,
        publishedAt: null,
      }),
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_giveaway'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_input_prompt|content'));
    await service.handleUpdate(
      createPrivateFormattedTextUpdate('Розыгрыш апреля', [
        {
          type: 'strong',
          from: 0,
          length: 9,
        },
      ]),
    );

    expect(getLastSendOptions(maxClient)).toEqual(
      expect.objectContaining({
        textFormat: 'html',
      }),
    );
    expect(getLastSentText(maxClient)).toContain('<strong>Розыгрыш </strong>апреля');
    expect(getLastSentText(maxClient)).not.toContain('**Розыгрыш**');
  });

  it('renders bold hyperlink preview without raw markdown syntax in private bot', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_broadcast'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_input_prompt|text'));
    await service.handleUpdate(
      createPrivateFormattedTextUpdate('Вррвврврврврвв', [
        {
          type: 'strong',
          from: 0,
          length: 14,
        },
        {
          type: 'link',
          from: 0,
          length: 14,
          url: 'https://business.max.ru/self/?#/chat-bots',
        },
      ]),
    );

    expect(getLastSendOptions(maxClient)).toEqual(
      expect.objectContaining({
        textFormat: 'html',
      }),
    );
    expect(getLastSentText(maxClient)).toContain('<u><strong>Вррвврврврврвв</strong></u>');
    expect(getLastSentText(maxClient)).not.toContain('[Вррвврврврврвв](');
  });

  it('keeps bold italic underline hyperlink formatting for broadcast drafts from private bot', async () => {
    const { service, maxClient, chats, adminService } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_broadcast'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_input_prompt|text'));
    await service.handleUpdate(
      createPrivateFormattedTextUpdate('MAX Docs', [
        {
          type: 'strong',
          from: 0,
          length: 8,
        },
        {
          type: 'emphasized',
          from: 0,
          length: 8,
        },
        {
          type: 'underline',
          from: 0,
          length: 8,
        },
        {
          type: 'link',
          from: 0,
          length: 8,
          url: 'https://dev.max.ru/docs-api',
        },
      ]),
    );

    expect(getLastSendOptions(maxClient)).toEqual(
      expect.objectContaining({
        textFormat: 'html',
      }),
    );
    expect(getLastSentText(maxClient)).toContain(
      '<u><strong><em><u>MAX Docs</u></em></strong></u>',
    );
    expect(getLastSentText(maxClient)).not.toContain('[**_++MAX Docs++_**](');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));

    expect(adminService.sendBroadcast).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: '[**_++MAX Docs++_**](https://dev.max.ru/docs-api)',
        textFormat: 'markdown',
        applyToAllChats: false,
      }),
      'private_bot',
    );
  });

  it('keeps bold italic underline hyperlink formatting for giveaway drafts from private bot', async () => {
    const { service, maxClient, chats, managedGiveawayService } = createHarness({
      managedGiveaway: createGiveaway({
        id: 'giveaway-draft-1',
        status: 'DRAFT',
        description: '',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        publicationMessageId: null,
        publicationUrl: null,
        publishedAt: null,
      }),
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_giveaway'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_input_prompt|content'));
    await service.handleUpdate(
      createPrivateFormattedTextUpdate('MAX Docs', [
        {
          type: 'strong',
          from: 0,
          length: 8,
        },
        {
          type: 'emphasized',
          from: 0,
          length: 8,
        },
        {
          type: 'underline',
          from: 0,
          length: 8,
        },
        {
          type: 'link',
          from: 0,
          length: 8,
          url: 'https://dev.max.ru/docs-api',
        },
      ]),
    );

    expect(managedGiveawayService.updateManagedGiveaway).toHaveBeenCalledWith(
      chats[0].id,
      'giveaway-draft-1',
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        description: '[**_++MAX Docs++_**](https://dev.max.ru/docs-api)',
      }),
      'chat',
      'private_bot',
    );
    expect(getLastSendOptions(maxClient)).toEqual(
      expect.objectContaining({
        textFormat: 'html',
      }),
    );
    expect(getLastSentText(maxClient)).toContain(
      '<u><strong><em><u>MAX Docs</u></em></strong></u>',
    );
    expect(getLastSentText(maxClient)).not.toContain('[**_++MAX Docs++_**](');
  });

  it('renders heading and bold giveaway content from incoming MAX markup without raw stars', async () => {
    const { service, maxClient, chats, managedGiveawayService } = createHarness({
      managedGiveaway: createGiveaway({
        id: 'giveaway-draft-1',
        status: 'DRAFT',
        description: '',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        publicationMessageId: null,
        publicationUrl: null,
        publishedAt: null,
      }),
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_giveaway'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_input_prompt|content'));
    await service.handleUpdate(
      createPrivateFormattedTextUpdate('Заголовок\nЖирный текст', [
        {
          type: 'heading',
          from: 0,
          length: 9,
        },
        {
          type: 'strong',
          from: 10,
          length: 6,
        },
      ]),
    );

    expect(managedGiveawayService.updateManagedGiveaway).toHaveBeenCalledWith(
      chats[0].id,
      'giveaway-draft-1',
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        description: '# Заголовок\n**Жирный** текст',
      }),
      'chat',
      'private_bot',
    );
    expect(getLastSendOptions(maxClient)).toEqual(
      expect.objectContaining({
        textFormat: 'html',
      }),
    );
    expect(getLastSentText(maxClient)).toContain('<p><strong>Заголовок</strong></p>');
    expect(getLastSentText(maxClient)).toContain('<p><strong>Жирный</strong> текст</p>');
    expect(getLastSentText(maxClient)).not.toContain('**Жирный**');
  });

  it('hands off chat broadcast from miniapp into private bot content flow and sends success follow-up', async () => {
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

    expect(getLastSentText(maxClient)).toContain(`Чат: ${chats[0].title}`);
    expect(getLastSentText(maxClient)).toContain('Пришлите текст или фото.');

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
    expect(getLastEditedText(maxClient)).toContain('Опубликовано без ошибок.');
    expect(getLastSentText(maxClient)).toContain('✅ Всё успешно.');
    expect(getLastSentText(maxClient)).toContain('Рассылка отправлена без ошибок.');
  });

  it('prompts for post content and accepts channel suggestions from a bot deep link', async () => {
    const { service, adminService, maxClient, channels } = createHarness();
    const startPayload = encodeChannelSuggestionStartPayload(channels[0].id, 'cdt-suggest-token-1');

    await service.handleBotStarted(createBotStartedPrivateUpdate(startPayload));

    expect(getLastSentText(maxClient)).toContain('Контент для поста');
    expect(getLastSentText(maxClient)).toContain(
      'Пришлите следующим сообщением текст, фото или фото с подписью.',
    );
    expect(getLastSentText(maxClient)).toContain(
      'После этого бот сразу отправит материал админу канала на проверку.',
    );
    const introButtons = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(introButtons).toContain('Что отправить');
    expect(introButtons).toContain('Отмена');

    await service.handleUpdate(createPrivateTextUpdate('Текст для публикации'));

    expect(adminService.createChannelSuggestionFromBot).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      {
        token: 'cdt-suggest-token-1',
        text: 'Текст для публикации',
      },
    );
    expect(getLastSentText(maxClient)).toContain('Материал отправлен');
    expect(getLastSentText(maxClient)).toContain('Бот переслал его админу канала на проверку.');
  });

  it('accepts a photo-only suggestion in the bot flow', async () => {
    const { service, adminService, maxClient, channels } = createHarness();
    const startPayload = encodeChannelSuggestionStartPayload(channels[0].id, 'cdt-suggest-token-2');
    const imageMock = mockImageFetch();

    try {
      await service.handleBotStarted(createBotStartedPrivateUpdate(startPayload));
      await service.handleUpdate(createPrivatePhotoUpdate());
    } finally {
      imageMock.restore();
    }

    expect(adminService.createChannelSuggestionFromBot).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        token: 'cdt-suggest-token-2',
        text: '',
        imageBase64: expect.any(String),
        imageMimeType: expect.stringMatching(/^image\//),
        imageFileName: expect.stringContaining('channel-suggestion'),
      }),
    );
    expect(getLastSentText(maxClient)).toContain('Материал отправлен');
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

    expect(getLastSentText(maxClient)).toContain(`Канал: ${channels[0].title}`);
    expect(getLastSentText(maxClient)).toContain('Пришлите текст или фото.');
    expect(getLastSentText(maxClient)).not.toContain('Комменты:');
    expect(getLastSentText(maxClient)).not.toContain('Предложка:');
    expect(getLastSentText(maxClient)).not.toContain('Кнопка предложки:');

    const buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));

    expect(buttonTexts).not.toContain('Открыть приложение');
    expect(buttonTexts).not.toContain('Поддержка');
  });

  it('preserves channel timer and cycle from miniapp handoff', async () => {
    const { service, adminService, channels } = createHarness();
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
        sendAt: '2026-03-20T12:00:00.000Z',
        cycleEnabled: true,
        cycleEveryHours: 24,
        cycleCount: 3,
      },
      'channel',
    );

    await service.handleBotStarted(createBotStartedPrivateUpdate());
    await service.handleUpdate(createPrivateTextUpdate('Контент для канала по таймеру'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));

    expect(adminService.sendChannelBroadcast).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: 'Контент для канала по таймеру',
        sendAt: '2026-03-20T12:00:00.000Z',
        cycleEnabled: true,
        cycleEveryHours: 24,
        cycleCount: 3,
      }),
      'private_bot',
    );
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

  it('logs callback and session details for bad request errors in broadcast flow', async () => {
    const sendChannelBroadcast = jest.fn().mockRejectedValue(
      new BadRequestException({
        message: 'Рассылка недоступна',
        reason: 'quota',
      }),
    );
    const { service, channels, maxClient } = createHarness({
      adminService: {
        sendChannelBroadcast,
      },
    });
    const warnSpy = jest.spyOn(
      (service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
      'warn',
    );

    await service.handleUpdate(
      createPrivateCallbackUpdate(`pc2|chat_select|channel|${channels[0].id}`),
    );
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_broadcast'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_input_prompt|text'));
    await service.handleUpdate(createPrivateTextUpdate('Новый пост для канала'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));

    expect(sendChannelBroadcast).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        badRequestDetails: 'Рассылка недоступна',
        badRequestResponse: expect.objectContaining({
          message: 'Рассылка недоступна',
          reason: 'quota',
        }),
        callbackAction: 'broadcast_send',
        callbackArgs: [],
        callbackPayload: 'pc2|broadcast_send',
        selectedChatId: channels[0].id,
        selectedEntityType: 'channel',
        screen: 'broadcast',
        pendingInput: null,
        pendingMassAction: null,
      }),
      'Private control flow failed',
    );
    expect(getLastSentText(maxClient)).toContain('Рассылка недоступна');
  });

  it('shows nested validation details instead of generic bad request exception in broadcast flow', async () => {
    const sendBroadcast = jest.fn().mockRejectedValue(
      new BadRequestException({
        _errors: [],
        text: {
          _errors: ['Текст рассылки слишком длинный. Максимум 2000 символов.'],
        },
      }),
    );
    const { service, chats, maxClient } = createHarness({
      adminService: {
        sendBroadcast,
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_broadcast'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_input_prompt|text'));
    await service.handleUpdate(createPrivateTextUpdate('Слишком длинная рассылка'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));

    expect(sendBroadcast).toHaveBeenCalledTimes(1);
    expect(getLastSentText(maxClient)).toContain(
      'Текст рассылки слишком длинный. Максимум 2000 символов.',
    );
    expect(getLastSentText(maxClient)).not.toContain('Bad Request Exception');
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

    await service.handleBotStarted(
      createBotStartedPrivateUpdate(extractStartPayload(result.botUrl)),
    );

    expect(managedGiveawayService.getManagedGiveaway).toHaveBeenCalledWith(
      chats[0].id,
      'giveaway-1',
      expect.objectContaining({ userId: 'user-1' }),
      'chat',
    );
    expect(getLastSentText(maxClient)).toContain(`Чат: ${chats[0].title}`);
    expect(getLastSentText(maxClient)).toContain('Разыгрываем подписку.');
    expect(getLastSentText(maxClient)).toContain('Пришлите новый текст или фото.');
    const buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toEqual(['Опубликовать', 'В приложение']);
    expect(buttonTexts).not.toContain('Открыть приложение');
    expect(buttonTexts).not.toContain('Поддержка');
  });

  it('hands off chat member profile from miniapp and sends a markdown mention in private chat', async () => {
    const { service, maxClient, adminService, chats } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };
    maxClient.getChatMemberProfiles.mockResolvedValue(
      new Map([['user-42', { displayName: 'Юлия Максимова' }]]),
    );

    const result = await service.handoffProfileMentionFromMiniapp(
      chats[0].id,
      actor,
      'user-42',
      {
        displayName: 'Юлия',
      },
      'chat',
    );

    expect(adminService.getChatHeader).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith(chats[0].id, ['user-42']);
    expect(result.botUrl).toContain('https://max.ru/777000_bot?start=');

    await service.handleBotStarted(
      createBotStartedPrivateUpdate(extractStartPayload(result.botUrl)),
    );

    expect(getLastSentText(maxClient)).toContain('Профиль пользователя');
    expect(getLastSentText(maxClient)).toContain('Юлия Максимова');
    expect(getLastSentText(maxClient)).toContain('max://user/user-42');
    expect(getLastSendOptions(maxClient)).toEqual(
      expect.objectContaining({
        textFormat: 'markdown',
      }),
    );
  });

  it('falls back to the provided profile name when MAX member profile lookup is empty', async () => {
    const { service, maxClient, adminService, channels } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: channels[0].id,
      chatTitle: channels[0].title,
    };

    const result = await service.handoffProfileMentionFromMiniapp(
      channels[0].id,
      actor,
      'user-99',
      {
        displayName: 'Без username',
      },
      'channel',
    );

    expect(adminService.getChannelHeader).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(result.botUrl).toContain('https://max.ru/777000_bot?start=');

    await service.handleBotStarted(
      createBotStartedPrivateUpdate(extractStartPayload(result.botUrl)),
    );

    expect(getLastSentText(maxClient)).toContain('Без username');
    expect(getLastSentText(maxClient)).toContain('max://user/user-99');
  });

  it('proactively delivers profile mention handoff into a known private chat and skips duplicate bot_started reply', async () => {
    const { service, maxClient, chats } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    await service.handleBotStarted(createBotStartedPrivateUpdate('broadcast_handoff'));
    maxClient.sendMessage.mockClear();

    const result = await service.handoffProfileMentionFromMiniapp(
      chats[0].id,
      actor,
      'user-77',
      {
        displayName: 'Мария',
      },
      'chat',
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(getLastSentText(maxClient)).toContain('Мария');
    expect(getLastSentText(maxClient)).toContain('max://user/user-77');

    await service.handleBotStarted(
      createBotStartedPrivateUpdate(extractStartPayload(result.botUrl)),
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores an empty bot_started right after proactive profile mention delivery', async () => {
    const { service, maxClient, chats } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    await service.handleBotStarted(createBotStartedPrivateUpdate('broadcast_handoff'));
    maxClient.sendMessage.mockClear();

    await service.handoffProfileMentionFromMiniapp(
      chats[0].id,
      actor,
      'user-88',
      {
        displayName: 'Анна',
      },
      'chat',
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    maxClient.sendMessage.mockClear();

    await service.handleBotStarted(createBotStartedPrivateUpdate(''));

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.answerCallback).not.toHaveBeenCalled();
  });

  it('proactively delivers giveaway handoff into a known private chat and skips duplicate bot_started reply', async () => {
    const { service, maxClient, chats } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    await service.handleBotStarted(createBotStartedPrivateUpdate('broadcast_handoff'));
    maxClient.sendMessage.mockClear();

    const result = await service.handoffGiveawayFromMiniapp(
      chats[0].id,
      actor,
      {
        giveawayId: 'giveaway-1',
      },
      'chat',
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      expect.stringContaining('Разыгрываем подписку.'),
      expect.anything(),
      expect.objectContaining({ immediate: true }),
    );

    await service.handleBotStarted(
      createBotStartedPrivateUpdate(extractStartPayload(result.botUrl)),
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('starts a new giveaway draft in private bot when there is no current giveaway', async () => {
    const { service, maxClient, chats, managedGiveawayService } = createHarness({
      managedGiveaway: null,
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_giveaway'));

    expect(getLastEditedText(maxClient)).toContain('Черновик не создан.');
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
    expect(getLastEditedText(maxClient)).toContain('Пришлите текст или фото.');
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

  it('shows only essential draft actions on the giveaway screen', async () => {
    const { service, maxClient, chats } = createHarness({
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

    const buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toEqual(['Опубликовать', 'В приложение']);
    expect(getLastUiText(maxClient)).toContain(`Чат: ${chats[0].title}`);
    expect(getLastUiText(maxClient)).toContain('Разыгрываем подписку.');
    expect(getLastUiText(maxClient)).not.toContain('Контент публикации:');
    expect(getLastUiText(maxClient)).not.toContain(
      'Остальные настройки редактируются в приложении.',
    );
    expect(getLastUiText(maxClient)).not.toContain('Подтверждение:');

    const returnButton = getLastButtons(maxClient)
      .flat()
      .find((button) => String((button as { text?: string }).text ?? '') === 'В приложение') as
      | { url?: string }
      | undefined;
    expect(decodeStartAppRoute(String(returnButton?.url ?? ''))).toBe(
      `/chat/${encodeURIComponent(chats[0].id)}/settings?focus=giveaway&handoff=1`,
    );
  });

  it('updates giveaway content when user sends text and then photo without another tap', async () => {
    const { service, maxClient, chats, managedGiveawayService } = createHarness({
      managedGiveaway: createGiveaway({
        id: 'giveaway-draft-1',
        status: 'DRAFT',
        description: '',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        publicationMessageId: null,
        publicationUrl: null,
        publishedAt: null,
      }),
    });
    const { restore } = mockImageFetch(TINY_PNG, 'image/png');

    try {
      await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_giveaway'));
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_input_prompt|content'));
      await service.handleUpdate(createPrivateTextUpdate('Текст перед фото'));

      expect(managedGiveawayService.updateManagedGiveaway).toHaveBeenNthCalledWith(
        1,
        chats[0].id,
        'giveaway-draft-1',
        expect.objectContaining({ userId: 'user-1' }),
        expect.objectContaining({
          description: 'Текст перед фото',
          imageEnabled: false,
          imageBase64: '',
          imageMimeType: '',
          imageFileName: '',
        }),
        'chat',
        'private_bot',
      );
      expect(getLastUiText(maxClient)).toContain(`Чат: ${chats[0].title}`);
      expect(getLastUiText(maxClient)).toContain('Текст перед фото');
      expect(getLastUiText(maxClient)).not.toContain('Контент публикации:');
      expect(
        getLastButtons(maxClient)
          .flat()
          .map((button) => String((button as { text?: string }).text ?? '')),
      ).toEqual(['Опубликовать', 'В приложение']);
      expect(maxClient.uploadImage).not.toHaveBeenCalled();

      await service.handleUpdate(createPrivatePhotoUpdate());

      expect(managedGiveawayService.updateManagedGiveaway).toHaveBeenNthCalledWith(
        2,
        chats[0].id,
        'giveaway-draft-1',
        expect.objectContaining({ userId: 'user-1' }),
        expect.objectContaining({
          description: 'Текст перед фото',
          imageEnabled: true,
          imageBase64: TINY_PNG.toString('base64'),
          imageMimeType: 'image/png',
          imageFileName: expect.stringContaining('private-giveaway-photo-1'),
        }),
        'chat',
        'private_bot',
      );
      expect(getLastUiText(maxClient)).toContain(`Чат: ${chats[0].title}`);
      expect(getLastUiText(maxClient)).toContain('Текст перед фото');
      expect(getLastUiText(maxClient)).not.toContain('Контент публикации:');
      expect(maxClient.uploadImage).toHaveBeenCalledTimes(1);
      expect(getLastSendOptions(maxClient)?.imagePayload).toEqual({ token: 'upload-token-1' });
    } finally {
      restore();
    }
  });

  it('updates giveaway content when user sends photo and then text without another tap', async () => {
    const { service, maxClient, chats, managedGiveawayService } = createHarness({
      managedGiveaway: createGiveaway({
        id: 'giveaway-draft-1',
        status: 'DRAFT',
        description: '',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        publicationMessageId: null,
        publicationUrl: null,
        publishedAt: null,
      }),
    });
    const { restore } = mockImageFetch(TINY_PNG, 'image/png');

    try {
      await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_giveaway'));
      await service.handleUpdate(createPrivatePhotoUpdate());

      expect(managedGiveawayService.updateManagedGiveaway).toHaveBeenNthCalledWith(
        1,
        chats[0].id,
        'giveaway-draft-1',
        expect.objectContaining({ userId: 'user-1' }),
        expect.objectContaining({
          description: '',
          imageEnabled: true,
          imageBase64: TINY_PNG.toString('base64'),
          imageMimeType: 'image/png',
          imageFileName: expect.stringContaining('private-giveaway-photo-1'),
        }),
        'chat',
        'private_bot',
      );
      expect(maxClient.sendCustomMessageImmediate).not.toHaveBeenCalled();
      expect(maxClient.uploadImage).toHaveBeenCalledTimes(1);
      expect(getLastUiText(maxClient)).toContain(`Чат: ${chats[0].title}`);
      expect(getLastUiText(maxClient)).toContain('Весенний розыгрыш');
      expect(getLastUiText(maxClient)).toContain('Пришлите новый текст или фото.');
      expect(getLastUiText(maxClient)).not.toContain('Контент публикации:');
      expect(
        getLastButtons(maxClient)
          .flat()
          .map((button) => String((button as { text?: string }).text ?? '')),
      ).toEqual(['Опубликовать', 'В приложение']);

      await service.handleUpdate(createPrivateTextUpdate('Текст после фото'));

      expect(managedGiveawayService.updateManagedGiveaway).toHaveBeenNthCalledWith(
        2,
        chats[0].id,
        'giveaway-draft-1',
        expect.objectContaining({ userId: 'user-1' }),
        expect.objectContaining({
          description: 'Текст после фото',
          imageEnabled: true,
          imageBase64: TINY_PNG.toString('base64'),
          imageMimeType: 'image/png',
          imageFileName: expect.stringContaining('private-giveaway-photo-1'),
        }),
        'chat',
        'private_bot',
      );
      expect(getLastUiText(maxClient)).toContain(`Чат: ${chats[0].title}`);
      expect(getLastUiText(maxClient)).toContain('Текст после фото');
      expect(getLastUiText(maxClient)).not.toContain('Контент публикации:');
      expect(maxClient.uploadImage).toHaveBeenCalledTimes(2);
      expect(getLastSendOptions(maxClient)?.imagePayload).toEqual({ token: 'upload-token-1' });
      expect(
        getLastButtons(maxClient)
          .flat()
          .map((button) => String((button as { text?: string }).text ?? '')),
      ).toEqual(['Опубликовать', 'В приложение']);
    } finally {
      restore();
    }
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

  it('renders giveaway winner notice on bot_started deep link without confirmation CTA', async () => {
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
            button.text === 'Открыть розыгрыш',
        ),
    ).toBe(false);
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
    ).toBe(false);
    expect(getLastUiText(maxClient)).toContain('Победитель зафиксирован');
    expect(managedGiveawayService.claimGiveaway).not.toHaveBeenCalled();
  });

  it('keeps key private screens under a safe inline-button count', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateTextUpdate('меню'));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(20);

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(20);

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_settings_hub'));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(20);

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_section|duplicates'));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(40);
  });
});
