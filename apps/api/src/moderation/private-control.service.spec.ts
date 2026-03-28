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

function createPrivateForwardedModerationUpdate(text = 'бан'): MaxUpdate {
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

function createPrivateVideoUpdate(text = ''): MaxUpdate {
  return {
    updateId: `upd-video-${Date.now()}`,
    type: 'message_created',
    message: {
      messageId: `msg-video-${Date.now()}`,
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
          ...(text ? { text } : {}),
          attachments: [
            {
              type: 'video',
              payload: {
                url: 'https://example.test/channel-suggestion-video.mp4',
                video_id: 'video-1',
                file_name: 'channel-suggestion-video.mp4',
                mime_type: 'video/mp4',
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

function createPrivateCallbackUpdate(
  payload: string,
  options: {
    userId?: string;
    displayName?: string;
    messageId?: string;
  } = {},
): MaxUpdate {
  const userId = options.userId ?? 'user-1';
  const displayName = options.displayName ?? 'Тестовый пользователь';
  return {
    updateId: `upd-cb-${Date.now()}`,
    type: 'message_callback',
    message: {
      messageId: options.messageId ?? `msg-cb-${Date.now()}`,
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
          user_id: userId,
          name: displayName,
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
    buttonEnabled: false,
    buttonUrl: '',
    buttonText: 'Открыть',
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
    sendMessageCopyWithInlineKeyboard: jest
      .fn()
      .mockResolvedValue({ messageId: 'msg-preview-1', url: null }),
    sendCustomMessageImmediate: jest.fn().mockResolvedValue({ message_id: 'msg-custom-1' }),
    uploadImage: jest.fn().mockResolvedValue({ token: 'upload-token-1' }),
    uploadVideo: jest.fn().mockResolvedValue({ token: 'upload-video-token-1' }),
    editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
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
    listChatsForMassBroadcast: jest.fn().mockResolvedValue(chats),
    getChatHeader: jest.fn().mockResolvedValue({ id: chats[0].id, title: chats[0].title }),
    getChannelHeader: jest.fn().mockResolvedValue({ id: channels[0].id, title: channels[0].title }),
    getSettings: jest.fn().mockResolvedValue(overrides.settings ?? defaultSettings),
    getChatSettingsScreen: jest.fn().mockImplementation(async () => ({
      settings: overrides.settings ?? defaultSettings,
      rules: currentRules,
      header: { id: chats[0].id, title: chats[0].title },
      requiredSubscriptionChannels: [],
      domains: [],
      managedBroadcasts: [],
    })),
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
        buttonEnabled: payload.buttonEnabled ?? currentRules.buttonEnabled,
        buttonUrl: payload.buttonUrl ?? currentRules.buttonUrl,
        buttonText: payload.buttonText ?? currentRules.buttonText,
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
      muteDurationHours: null,
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
    getPublicChannelSuggestionIntroText: jest
      .fn()
      .mockResolvedValue((overrides.channelSettings ?? defaultChannelSettings).postSuggestionsText),
    getPublicChannelSuggestionTarget: jest.fn().mockResolvedValue({
      title: channels[0].title,
      link: 'https://max.ru/channels/testovyj-kanal',
    }),
    updateChannelSettings: jest
      .fn()
      .mockResolvedValue(overrides.channelSettings ?? defaultChannelSettings),
    createChannelSuggestionFromBot: jest.fn().mockResolvedValue({
      ok: true,
      delivered: true,
      deliveredToUserId: 'admin-1',
    }),
    reviewChannelSuggestionByAdmin: jest.fn().mockResolvedValue({
      status: 'reviewed',
      reviewStatus: 'published',
      publishedUrl: 'https://max.ru/chats/channel-1/message/777',
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

function getLastCopiedButtons(maxClient: { sendMessageCopyWithInlineKeyboard: jest.Mock }) {
  return (maxClient.sendMessageCopyWithInlineKeyboard.mock.calls.at(-1)?.[3]?.buttons ??
    []) as Array<Array<unknown>>;
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
  it('renders the launcher home for plain text in private dialog', async () => {
    const { service, maxClient, adminService } = createHarness();

    await service.handleUpdate(createPrivateTextUpdate('привет'));

    expect(getLastUiText(maxClient)).toContain('**MAXIM**');
    expect(getLastUiText(maxClient)).toContain('Открывайте приложение');
    expect(
      getLastButtons(maxClient)
        .flat()
        .map((button) => String((button as { text?: string }).text ?? '')),
    ).toEqual(['📱 Приложение', '🆘 Поддержка']);
    expect(adminService.listManagedEntities).not.toHaveBeenCalled();
  });

  it('keeps entity refresh in mini app instead of opening inline picker', async () => {
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

    expect(getLastUiText(maxClient)).toContain('Открывайте приложение');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|chat_refresh'));

    expect(listManagedEntities).not.toHaveBeenCalled();
    expect(getLastEditedText(maxClient)).toContain('Список управляемых сущностей обновляется в mini app.');
    const buttonTexts = getLastEditedButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toEqual(['📱 Приложение', '🆘 Поддержка']);
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

  it('does not hijack a plain photo when no content input is active', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivatePhotoUpdate());

    expect(maxClient.sendCustomMessageImmediate).not.toHaveBeenCalled();
    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    expect(getLastUiText(maxClient)).toContain('**MAXIM**');
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
    ).toContain('📱 Открыть в приложении');
    expect(adminService.updateSettings).not.toHaveBeenCalled();
  });

  it('treats /legacy and /modern as aliases for the current interface', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateTextUpdate('/legacy'));
    await service.handleUpdate(createPrivateTextUpdate('/modern'));

    const sentMessages = maxClient.sendMessage.mock.calls.map((call) => String(call[1]));
    expect(sentMessages.some((text) => text.includes('**MAXIM**'))).toBe(true);
    expect(sentMessages.some((text) => text.includes('классический вид'))).toBe(false);
  });

  it('bans a forwarded sender from private chat with the permanent ban command', async () => {
    const { service, adminService, maxClient, chats } = createHarness({
      settings: {
        ...defaultSettings,
        muteDurationHours: 12,
      },
    });

    await service.handleUpdate(createPrivateForwardedModerationUpdate());

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

  it('mutes a forwarded sender from private chat for 6 hours by default', async () => {
    const { service, adminService, maxClient, chats } = createHarness();
    adminService.applyManualModerationAction.mockResolvedValueOnce({
      ok: true,
      action: 'MUTE',
      userId: 'user-77',
      muteDurationHours: 6,
      muteExpiresAt: '2026-03-26T12:00:00.000Z',
      message: 'Участник замьючен на 6ч. Новые сообщения будут удаляться до конца срока.',
    });

    await service.handleUpdate(createPrivateForwardedModerationUpdate('мут'));

    expect(adminService.applyManualModerationAction).toHaveBeenCalledWith(
      chats[0].id,
      'user-77',
      expect.objectContaining({
        userId: 'user-1',
        chatId: '152517912',
      }),
      {
        action: 'MUTE',
        muteDurationHours: 6,
      },
      'private_command',
    );
    expect(adminService.applyManualSystemBan).not.toHaveBeenCalled();
    expect(getLastSentText(maxClient)).toContain('Участник замьючен на 6ч.');
    expect(getLastSentText(maxClient)).toContain(`Чат: ${chats[0].title}`);
    expect(getLastSentText(maxClient)).toContain('Пользователь: Нарушитель (user-77)');
  });

  it('mutes a forwarded sender from private chat for the requested number of hours', async () => {
    const { service, adminService, maxClient, chats } = createHarness();
    adminService.applyManualModerationAction.mockResolvedValueOnce({
      ok: true,
      action: 'MUTE',
      userId: 'user-77',
      muteDurationHours: 12,
      muteExpiresAt: '2026-03-26T18:00:00.000Z',
      message: 'Участник замьючен на 12ч. Новые сообщения будут удаляться до конца срока.',
    });

    await service.handleUpdate(createPrivateForwardedModerationUpdate('мут 12'));

    expect(adminService.applyManualModerationAction).toHaveBeenCalledWith(
      chats[0].id,
      'user-77',
      expect.objectContaining({
        userId: 'user-1',
        chatId: '152517912',
      }),
      {
        action: 'MUTE',
        muteDurationHours: 12,
      },
      'private_command',
    );
    expect(adminService.applyManualSystemBan).not.toHaveBeenCalled();
    expect(getLastSentText(maxClient)).toContain('Участник замьючен на 12ч.');
    expect(getLastSentText(maxClient)).toContain(`Чат: ${chats[0].title}`);
    expect(getLastSentText(maxClient)).toContain('Пользователь: Нарушитель (user-77)');
  });

  it('rejects explicit duration in the forwarded ban command', async () => {
    const { service, adminService, maxClient } = createHarness({
      settings: {
        ...defaultSettings,
        muteDurationHours: 6,
      },
    });

    await service.handleUpdate(createPrivateForwardedModerationUpdate('бан 24'));

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
        muteDurationHours: 6,
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_section|duplicates'));
    await service.handleUpdate(
      createPrivateCallbackUpdate('pc2|set_number_preset|duplicates|duplicateWarnMaxCount|5'),
    );
    await service.handleUpdate(
      createPrivateCallbackUpdate('pc2|step_number|duplicates|muteDurationHours|1'),
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
        autoTextEnabled: true,
      }),
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));

    expect(getLastUiText(maxClient)).toContain('Правила');
    expect(getLastUiText(maxClient)).toContain('Соблюдайте **правила** чата.');
    expect(getLastUiText(maxClient)).not.toContain(
      'Здесь меняется только текст и фото. Кнопки поста и кнопка «Правила» остаются в mini app.',
    );

    const buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toContain('✏️ Изменить текст');
    expect(buttonTexts).toContain('✍️ Добавить фото');
    expect(buttonTexts).toContain('🚀 Опубликовать');
    expect(buttonTexts.some((text) => text.startsWith('📱 В прилож'))).toBe(true);
    expect(buttonTexts).not.toContain('Сбросить публикацию');
    expect(buttonTexts).not.toContain('✅ Кнопка "Правила" в нарушениях');
    expect(maxClient.answerCallback.mock.calls.at(-1)?.[2]?.options?.textFormat).toBe('markdown');

    const miniappButton = getLastButtons(maxClient)
      .flat()
      .find((button) =>
        String((button as { text?: string }).text ?? '').startsWith('📱 В прилож'),
      ) as
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

  it('does not autofill stored rules text in bot when autofill is disabled', async () => {
    const { service, maxClient, chats } = createHarness({
      rules: createRules({
        text: 'Старый текст правил.',
        autoTextEnabled: false,
      }),
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));

    expect(getLastUiText(maxClient)).toContain('Правила');
    expect(getLastUiText(maxClient)).toContain('Текст из настроек сейчас не подставляется.');
    expect(getLastUiText(maxClient)).not.toContain('Старый текст правил.');

    const buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toContain('Собрать из настроек 🤖');
    expect(buttonTexts).toContain('✏️ Изменить текст');
  });

  it('shows the assemble-from-settings button when rules text is empty', async () => {
    const { service, maxClient, chats } = createHarness({
      rules: createRules({
        text: '',
        autoTextEnabled: false,
      }),
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));

    const buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toContain('Собрать из настроек 🤖');
  });

  it('builds rules text from current settings in the private bot', async () => {
    const generatedSettings = chatSettingsSchema.parse({
      linkPolicy: 'BLOCKLIST_ONLY',
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-1', 'channel-2'],
      maxMessageLengthEnabled: true,
      maxMessageLength: 500,
      messageLimitsBlockedWords: ['спам', 'капс'],
      videoMessagesEnabled: false,
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 8 * 60,
      nightModeTimezone: 'Europe/Moscow',
    });
    const { service, adminService, maxClient, chats } = createHarness({
      settings: generatedSettings,
      rules: createRules({
        text: 'Текущий текст правил.',
        autoTextEnabled: false,
        imageBase64: TINY_PNG.toString('base64'),
        imageMimeType: 'image/png',
        imageFileName: 'rules.png',
        buttonEnabled: true,
        buttonUrl: 'https://max.ru/help',
        buttonText: 'Подробнее',
      }),
      adminService: {
        getChatSettingsScreen: jest.fn().mockResolvedValue({
          settings: generatedSettings,
          rules: createRules({
            text: 'Текущий текст правил.',
            autoTextEnabled: false,
            imageBase64: TINY_PNG.toString('base64'),
            imageMimeType: 'image/png',
            imageFileName: 'rules.png',
            buttonEnabled: true,
            buttonUrl: 'https://max.ru/help',
            buttonText: 'Подробнее',
          }),
          header: { id: '-70000000000001', title: 'Тестовый чат 1' },
          requiredSubscriptionChannels: [
            {
              id: 'channel-1',
              title: 'Новости MAX',
              createdAt: new Date().toISOString(),
              entityType: 'channel',
            },
            {
              id: 'channel-2',
              title: 'Клуб MAX',
              createdAt: new Date().toISOString(),
              entityType: 'channel',
            },
          ],
          domains: [],
          managedBroadcasts: [],
        }),
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_autofill'));

    const updatePayload = adminService.updateRules.mock.calls.at(-1)?.[2];
    expect(updatePayload).toMatchObject({
      imageMimeType: 'image/png',
      imageFileName: 'rules.png',
      autoTextEnabled: true,
      buttonEnabled: true,
      buttonUrl: 'https://max.ru/help',
      buttonText: 'Подробнее',
    });
    expect(String(updatePayload?.text ?? '')).toContain('Правила чата:');
    expect(String(updatePayload?.text ?? '')).toContain('Любые ссылки в этом чате удаляются.');
    expect(String(updatePayload?.text ?? '')).toContain(
      'Для сообщений нужна подписка на: Новости MAX, Клуб MAX.',
    );
    expect(String(updatePayload?.text ?? '')).toContain('Мат и грубая лексика запрещены.');
    expect(String(updatePayload?.text ?? '')).toContain(
      'Длина одного сообщения — до 500 символов.',
    );
    expect(String(updatePayload?.text ?? '')).toContain(
      'Запрещены стоп-слова: спам, капс.',
    );
    expect(String(updatePayload?.text ?? '')).toContain('Видео в этом чате запрещены.');
    expect(String(updatePayload?.text ?? '')).toContain(
      'Ночной режим действует с 23:00 до 08:00 (Europe/Moscow).',
    );
    expect(getLastEditedText(maxClient)).toContain('Любые ссылки в этом чате удаляются.');
    expect(getLastEditedText(maxClient)).toContain('Текст собран из текущих настроек.');
  });

  it('hands off chat rules from miniapp into private bot rules flow', async () => {
    const { service, adminService, maxClient, chats } = createHarness({
      rules: createRules({
        text: 'Правила из handoff.',
        autoTextEnabled: true,
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
    expect(getLastSentText(maxClient)).toContain('Отправьте новый текст одним сообщением.');

    await service.handleUpdate(createPrivateTextUpdate('Новая версия из handoff'));

    expect(adminService.updateRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: 'Новая версия из handoff',
        autoTextEnabled: false,
      }),
      'private_bot',
    );
  });

  it('updates rules text only after choosing the text button', async () => {
    const { service, adminService, maxClient, chats } = createHarness({
      rules: createRules({
        buttonEnabled: true,
        buttonUrl: 'https://max.ru/help',
        buttonText: 'Подробнее',
      }),
    });

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
        buttonEnabled: true,
        buttonUrl: 'https://max.ru/help',
        buttonText: 'Подробнее',
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
    expect(getLastEditedText(maxClient)).toContain('Отправьте новый текст одним сообщением.');

    const buttonTexts = getLastEditedButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toContain('✏️ Изменить текст');
    expect(buttonTexts).toContain('✍️ Добавить фото');
  });

  it('updates rules photo from image and image-file messages in private bot', async () => {
    const { service, adminService, maxClient, chats } = createHarness({
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

  it('supports rules photo cleanup and redirects advanced rules toggles to mini app', async () => {
    const { service, adminService, maxClient, chats } = createHarness({
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
    expect(adminService.updateSettings).not.toHaveBeenCalled();
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
    expect(getLastEditedText(maxClient)).toContain('Публикация правил сброшена.');
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

  it('formats scheduled broadcast time in the broadcast timezone for private bot messages', async () => {
    const { service, maxClient, channels } = createHarness({
      adminService: {
        sendChannelBroadcast: jest.fn().mockResolvedValue({
          targetChats: 1,
          sentChats: 0,
          failedChats: 0,
          nextSendAt: '2026-03-24T12:00:00.000Z',
          scheduleTimezone: 'Asia/Yekaterinburg',
          scheduledOccurrences: 1,
        }),
      },
    });

    await service.handleUpdate(
      createPrivateCallbackUpdate(`pc2|chat_select|channel|${channels[0].id}`),
    );
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_broadcast'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_input_prompt|text'));
    await service.handleUpdate(createPrivateTextUpdate('Пост по расписанию'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));

    expect(getLastEditedText(maxClient)).toContain('Будет опубликовано: 24.03.2026, 17:00.');
    expect(getLastSentText(maxClient)).toContain(
      '✅ Всё успешно. Рассылка запланирована на 24.03.2026, 17:00.',
    );
  });

  it('parses scheduled broadcast input in the selected broadcast timezone', () => {
    const { service } = createHarness();

    const parsed = (service as any).parseBroadcastSendAt('24.03.2026 17:00', 'Asia/Yekaterinburg');

    expect(parsed).toBe('2026-03-24T12:00:00.000Z');
  });

  it('preserves incoming MAX text markup in markdown broadcast preview from private bot', async () => {
    const { service, adminService, maxClient, channels } = createHarness();
    const sourceText = 'Важный анонс\n\n  Второй абзац с  пробелом';

    await service.handleUpdate(
      createPrivateCallbackUpdate(`pc2|chat_select|channel|${channels[0].id}`),
    );
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_broadcast'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_input_prompt|text'));
    await service.handleUpdate(
      createPrivateFormattedTextUpdate(sourceText, [
        {
          type: 'strong',
          from: 0,
          length: 6,
        },
      ]),
    );

    expect(getLastSendOptions(maxClient)).toEqual(
      expect.objectContaining({
        textFormat: 'markdown',
      }),
    );
    expect(getLastSentText(maxClient)).toContain('**Рассылка**');
    expect(getLastSentText(maxClient)).toContain('**Контент**');
    expect(getLastSentText(maxClient)).toContain('**Важный** анонс\n\n  Второй абзац с  пробелом');
    expect(getLastSentText(maxClient)).toContain('Дальше: Пришлите новый текст или фото.');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));

    expect(adminService.sendChannelBroadcast).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: '**Важный** анонс\n\n  Второй абзац с  пробелом',
        textFormat: 'markdown',
        applyToAllChats: false,
      }),
      'private_bot',
    );
  });

  it('renders broadcast preview with separate plain-text blocks', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_broadcast'));
    await service.handleUpdate(createPrivateTextUpdate('Промо блок'));

    expect(getLastUiText(maxClient)).toContain('Рассылка');
    expect(getLastUiText(maxClient)).toContain(`Чат: ${chats[0].title}`);
    expect(getLastUiText(maxClient)).toContain('Контент:');
    expect(getLastUiText(maxClient)).toContain('Промо блок');
    expect(getLastUiText(maxClient)).toContain('Статус: Контент сохранён.');
    expect(getLastUiText(maxClient)).toContain('Дальше: Пришлите новый текст или фото.');
  });

  it('renders bold hyperlink preview as markdown in private bot', async () => {
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
        textFormat: 'markdown',
      }),
    );
    expect(getLastSentText(maxClient)).toContain(
      '[**Вррвврврврврвв**](https://business.max.ru/self/?#/chat-bots)',
    );
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
        textFormat: 'markdown',
      }),
    );
    expect(getLastSentText(maxClient)).toContain(
      '[**_++MAX Docs++_**](https://dev.max.ru/docs-api)',
    );

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

  it('blocks concurrent duplicate broadcast publish callbacks for the same chat', async () => {
    let resolveSend!: (value: {
      targetChats: number;
      sentChats: number;
      failedChats: number;
    }) => void;
    const pendingSend = new Promise<{
      targetChats: number;
      sentChats: number;
      failedChats: number;
    }>((resolve) => {
      resolveSend = resolve;
    });
    const sendChannelBroadcast = jest.fn().mockReturnValue(pendingSend);
    const { service, maxClient, channels } = createHarness({
      adminService: {
        sendChannelBroadcast,
      },
    });

    await service.handleUpdate(
      createPrivateCallbackUpdate(`pc2|chat_select|channel|${channels[0].id}`),
    );
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_broadcast'));
    await service.handleUpdate(createPrivateTextUpdate('Дубль публикации'));

    const firstSend = service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));
    const secondSend = service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));

    await secondSend;

    expect(sendChannelBroadcast).toHaveBeenCalledTimes(1);
    expect(getLastEditedText(maxClient)).toContain('Эта рассылка уже отправляется.');

    resolveSend({ targetChats: 1, sentChats: 1, failedChats: 0 });
    await firstSend;
  });

  it('drops stale duplicate broadcast publish callback for the same draft', async () => {
    const sendChannelBroadcast = jest
      .fn()
      .mockResolvedValue({ targetChats: 1, sentChats: 1, failedChats: 0 });
    const { service, maxClient, channels } = createHarness({
      adminService: {
        sendChannelBroadcast,
      },
    });

    await service.handleUpdate(
      createPrivateCallbackUpdate(`pc2|chat_select|channel|${channels[0].id}`),
    );
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_broadcast'));
    await service.handleUpdate(createPrivateTextUpdate('Старый callback'));

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));

    expect(sendChannelBroadcast).toHaveBeenCalledTimes(1);
    expect(getLastEditedText(maxClient)).toContain('Эта рассылка уже была запущена.');
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

  it('builds a preview copy with edit, send and return buttons for channel suggestions', async () => {
    const { service, adminService, maxClient, channels } = createHarness({
      channelSettings: {
        ...defaultChannelSettings,
        postSuggestionsText: 'Пришлите готовый текст, город и ссылку на источник.',
      },
    });
    const startPayload = encodeChannelSuggestionStartPayload(channels[0].id, 'cdt-suggest-token-1');

    await service.handleBotStarted(createBotStartedPrivateUpdate(startPayload));

    expect(getLastSentText(maxClient)).toContain('📰 Предложка');
    expect(getLastSentText(maxClient)).toContain(
      'Пришлите готовый текст, город и ссылку на источник.',
    );
    expect(getLastSentText(maxClient)).toContain('⬇️ Пришлите следующим сообщением');
    const introButtons = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(introButtons).toContain('✍️ Добавить контент');
    expect(introButtons).toContain('↩️ Вернуться в канал');
    expect(introButtons).toHaveLength(2);

    await service.handleUpdate(
      createPrivateCallbackUpdate(`pc2|suggestion_compose|${channels[0].id}|cdt-suggest-token-1`),
    );

    expect(getLastEditedText(maxClient)).toContain('✍️ Добавьте контент');
    expect(getLastEditedText(maxClient)).toContain(
      '⬇️ Пришлите следующим сообщением текст, фото, видео или подпись к медиа.',
    );

    await service.handleUpdate(createPrivateTextUpdate('Текст для публикации'));

    expect(adminService.createChannelSuggestionFromBot).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledWith(
      '152517912',
      expect.stringContaining('msg-'),
      null,
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
    );
    const previewButtons = getLastCopiedButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(previewButtons).toContain('✏️ Исправить');
    expect(previewButtons).toContain('📨 Отправить');
    expect(previewButtons).toContain('↩️ Вернуться в канал');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|suggestion_send'));

    expect(adminService.createChannelSuggestionFromBot).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      {
        token: 'cdt-suggest-token-1',
        text: 'Текст для публикации',
      },
    );
    expect(getLastEditedText(maxClient)).toContain('✅ Материал отправлен');
    expect(getLastEditedText(maxClient)).toContain(
      'Бот передал материал редакторам канала на проверку.',
    );
    const completionButtons = getLastEditedButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(completionButtons).toContain('📰 Предложить ещё');
    expect(completionButtons).toContain('↩️ Вернуться в канал');

    await service.handleUpdate(
      createPrivateCallbackUpdate(`pc2|suggestion_again|${channels[0].id}|cdt-suggest-token-1`),
    );

    expect(getLastEditedText(maxClient)).toContain('📰 Предложка');
  });

  it('accepts a photo-only suggestion in the bot flow after explicit send', async () => {
    const { service, adminService, maxClient, channels } = createHarness();
    const startPayload = encodeChannelSuggestionStartPayload(channels[0].id, 'cdt-suggest-token-2');
    const imageMock = mockImageFetch();

    try {
      await service.handleBotStarted(createBotStartedPrivateUpdate(startPayload));
      await service.handleUpdate(createPrivatePhotoUpdate());
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|suggestion_send'));
    } finally {
      imageMock.restore();
    }

    expect(adminService.createChannelSuggestionFromBot).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        token: 'cdt-suggest-token-2',
        text: '',
        mediaType: 'image',
        mediaPayload: { token: 'upload-token-1' },
        mediaMimeType: expect.stringMatching(/^image\//),
        mediaFileName: expect.stringContaining('channel-suggestion'),
      }),
    );
    expect(getLastEditedText(maxClient)).toContain('✅ Материал отправлен');
  });

  it('accepts a video-only suggestion in the bot flow after explicit send', async () => {
    const { service, adminService, maxClient, channels } = createHarness();
    const startPayload = encodeChannelSuggestionStartPayload(channels[0].id, 'cdt-suggest-token-3');
    const videoBuffer = Buffer.from('video-binary');
    const originalFetch = global.fetch;

    Object.defineProperty(global, 'fetch', {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === 'content-type' ? 'video/mp4' : null),
        },
        arrayBuffer: async () =>
          videoBuffer.buffer.slice(
            videoBuffer.byteOffset,
            videoBuffer.byteOffset + videoBuffer.byteLength,
          ),
      }),
    });

    try {
      await service.handleBotStarted(createBotStartedPrivateUpdate(startPayload));
      await service.handleUpdate(createPrivateVideoUpdate());
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|suggestion_send'));
    } finally {
      Object.defineProperty(global, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    }

    expect(maxClient.uploadVideo).toHaveBeenCalledWith(
      expect.any(Buffer),
      'channel-suggestion-video.mp4',
      'video/mp4',
    );
    expect(adminService.createChannelSuggestionFromBot).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        token: 'cdt-suggest-token-3',
        text: '',
        mediaType: 'video',
        mediaPayload: { token: 'upload-video-token-1' },
        mediaMimeType: 'video/mp4',
        mediaFileName: 'channel-suggestion-video.mp4',
      }),
    );
    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledWith(
      '152517912',
      expect.stringContaining('msg-video-'),
      null,
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
    );
    expect(getLastEditedText(maxClient)).toContain('✅ Материал отправлен');
  });

  it('routes admin review callbacks to publish or cancel the suggestion', async () => {
    const { service, adminService, maxClient } = createHarness({
      adminService: {
        reviewChannelSuggestionByAdmin: jest.fn().mockResolvedValue({
          status: 'reviewed',
          reviewStatus: 'published',
          publishedUrl: 'https://max.ru/chats/channel-1/message/999',
        }),
      },
    });

    await service.handleUpdate(
      createPrivateCallbackUpdate('pc2|suggestion_review_publish|suggestion-42', {
        userId: 'admin-1',
        displayName: 'Главный редактор',
      }),
    );

    expect(adminService.reviewChannelSuggestionByAdmin).toHaveBeenCalledWith(
      'suggestion-42',
      expect.objectContaining({
        userId: 'admin-1',
        displayName: 'Главный редактор',
      }),
      'publish',
    );
    expect(getLastEditedText(maxClient)).toContain('Предложка опубликована');
    expect(getLastEditedText(maxClient)).toContain('https://max.ru/chats/channel-1/message/999');
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

  it('preserves bot broadcast content across repeated miniapp handoff for the same chat', async () => {
    const { service, adminService, maxClient, chats } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    await service.handoffBroadcastFromMiniapp(
      chats[0].id,
      actor,
      {
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-03-20T12:00:00.000Z', '2026-03-21T12:00:00.000Z'],
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 24,
        cycleCount: 2,
      },
      'chat',
    );

    await service.handleBotStarted(createBotStartedPrivateUpdate());
    await service.handleUpdate(createPrivateTextUpdate('Контент из лички бота'));

    await service.handoffBroadcastFromMiniapp(
      chats[0].id,
      actor,
      {
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-03-22T12:00:00.000Z', '2026-03-23T12:00:00.000Z'],
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 24,
        cycleCount: 2,
      },
      'chat',
    );

    await service.handleBotStarted(createBotStartedPrivateUpdate());

    expect(getLastSentText(maxClient)).toContain('Контент из лички бота');
    const buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toContain('🚀 Опубликовать');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));

    expect(adminService.sendBroadcast).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: 'Контент из лички бота',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-03-22T12:00:00.000Z', '2026-03-23T12:00:00.000Z'],
        cycleEnabled: false,
        cycleCount: 2,
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

  it('hands off giveaway from miniapp into a mini app return screen in private bot', async () => {
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
    expect(getLastSentText(maxClient)).toContain('Розыгрыши перенесены в mini app');
    expect(getLastSentText(maxClient)).toContain(`Чат: ${chats[0].title}`);
    expect(getLastSentText(maxClient)).toContain(
      'Черновики, публикация, итоги и reroll розыгрышей теперь доступны только в приложении.',
    );
    const buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toContain('📱 Открыть в приложении');
    expect(buttonTexts).toContain('↩️ Назад');
    expect(buttonTexts).toContain('🆘 Поддержка');

    const launchButton = getLastButtons(maxClient)
      .flat()
      .find((button) => String((button as { text?: string }).text ?? '') === '📱 Открыть в приложении') as
      | { url?: string }
      | undefined;
    expect(decodeStartAppRoute(String(launchButton?.url ?? ''))).toBe(
      `/chat/${encodeURIComponent(chats[0].id)}/settings?focus=giveaway&handoff=1`,
    );
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

  it('proactively delivers giveaway handoff screen into a known private chat and skips duplicate bot_started reply', async () => {
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
      expect.stringContaining('Розыгрыши перенесены в mini app'),
      expect.anything(),
      expect.objectContaining({ immediate: true }),
    );

    await service.handleBotStarted(
      createBotStartedPrivateUpdate(extractStartPayload(result.botUrl)),
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('proactively delivers rules handoff into a known private chat and skips duplicate bot_started reply', async () => {
    const { service, maxClient, chats } = createHarness({
      rules: createRules({
        text: 'Правила для быстрой правки.',
        autoTextEnabled: true,
      }),
    });
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    await service.handleBotStarted(createBotStartedPrivateUpdate('broadcast_handoff'));
    maxClient.sendMessage.mockClear();

    const result = await service.handoffRulesFromMiniapp(chats[0].id, actor);

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(getLastSentText(maxClient)).toContain('Правила');
    expect(getLastSentText(maxClient)).toContain('Правила для быстрой правки.');
    expect(getLastSentText(maxClient)).toContain('Отправьте новый текст одним сообщением.');

    await service.handleBotStarted(
      createBotStartedPrivateUpdate(extractStartPayload(result.botUrl)),
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('redirects giveaway callbacks to mini app instead of mutating private drafts', async () => {
    const { service, maxClient, chats, managedGiveawayService } = createHarness({
      managedGiveaway: null,
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_giveaway'));
    expect(getLastEditedText(maxClient)).toContain('Розыгрыши перенесены в mini app');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_create'));
    expect(getLastEditedText(maxClient)).toContain('Розыгрыши перенесены в mini app');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_input_prompt|title'));
    expect(getLastEditedText(maxClient)).toContain('Розыгрыши перенесены в mini app');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_reroll|winner-1'));
    expect(getLastEditedText(maxClient)).toContain('Розыгрыши перенесены в mini app');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_deliver|winner-1'));
    expect(getLastEditedText(maxClient)).toContain('Розыгрыши перенесены в mini app');

    expect(managedGiveawayService.getCurrentManagedGiveawayForEntity).not.toHaveBeenCalled();
    expect(managedGiveawayService.createManagedGiveaway).not.toHaveBeenCalled();
    expect(managedGiveawayService.updateManagedGiveaway).not.toHaveBeenCalled();
    expect(managedGiveawayService.rerollManagedGiveawayWinner).not.toHaveBeenCalled();
    expect(managedGiveawayService.markManagedGiveawayWinnerDelivered).not.toHaveBeenCalled();

    const launchButton = getLastEditedButtons(maxClient)
      .flat()
      .find((button) => String((button as { text?: string }).text ?? '') === '📱 Открыть в приложении') as
      | { url?: string }
      | undefined;
    expect(decodeStartAppRoute(String(launchButton?.url ?? ''))).toBe(
      `/chat/${encodeURIComponent(chats[0].id)}/settings?focus=giveaway&handoff=1`,
    );
  });

  it('redirects poll callbacks to mini app instead of opening the private poll flow', async () => {
    const { service, maxClient, adminService, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_poll'));
    expect(getLastEditedText(maxClient)).toContain('Опросы перенесены в mini app');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|poll_input_prompt|question'));
    expect(getLastEditedText(maxClient)).toContain('Опросы перенесены в mini app');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|poll_publish'));
    expect(getLastEditedText(maxClient)).toContain('Опросы перенесены в mini app');

    expect(adminService.getChatPoll).not.toHaveBeenCalled();
    expect(adminService.updateChatPoll).not.toHaveBeenCalled();
    expect(adminService.publishChatPoll).not.toHaveBeenCalled();

    const launchButton = getLastEditedButtons(maxClient)
      .flat()
      .find((button) => String((button as { text?: string }).text ?? '') === '📱 Открыть в приложении') as
      | { url?: string }
      | undefined;
    expect(decodeStartAppRoute(String(launchButton?.url ?? ''))).toBe(
      `/chat/${encodeURIComponent(chats[0].id)}/settings?focus=poll&handoff=1`,
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
