import {
  ChatBotMembershipStatus,
  ChatEntityType,
  GiveawayEligibilityState,
  ManagedEntityAccessState,
  ManagedGiveawayStatus,
  ManagedGiveawayWinnerStatus,
} from '../prisma/prisma-client';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ManagedGiveawayMembershipLookupUnavailableError,
  ManagedGiveawayService,
} from './managed-giveaway.service';

function createConfigMock(options: { token?: string; previousToken?: string } = {}) {
  return {
    get: jest.fn((key: string) => {
      if (key === 'APP_BASE_URL') {
        return 'https://major-maksimov.ru';
      }
      if (key === 'MAX_BOT_CONTACT_ID') {
        return 'maxim-bot';
      }
      if (key === 'MAX_BOT_ID') {
        return 'maxim-bot';
      }
      if (key === 'MAX_BOT_TOKEN_PREVIOUS') {
        return options.previousToken;
      }
      return undefined;
    }),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'MAX_BOT_TOKEN') {
        return options.token ?? 'test-token';
      }
      throw new Error(`Missing config key ${key}`);
    }),
  };
}

function createPrismaMock() {
  return {
    managedGiveaway: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn(),
    },
    managedGiveawayEntry: {
      upsert: jest.fn(),
      update: jest.fn(),
    },
    managedGiveawayWinner: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
    },
    chat: {
      upsert: jest.fn().mockResolvedValue(undefined),
      findUnique: jest.fn().mockResolvedValue({ title: 'Основной канал' }),
    },
    managedEntityAccessEdge: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    chatBotMembership: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue(undefined),
    },
    $transaction: jest.fn(),
  };
}

function createMaxApiError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), {
    response: {
      status,
      data: {
        ...(code ? { code } : {}),
        message,
      },
    },
  });
}

function createMaxClientMock() {
  return {
    hasChatMember: jest.fn(),
    getChatTitle: jest.fn(),
    getChatSnapshot: jest.fn(),
    sendMessageImmediateWithResolvedLink: jest.fn(),
    sendMessageImmediateToUser: jest.fn(),
    editMessageInlineKeyboard: jest.fn(),
    deleteMessage: jest.fn(),
  };
}

function expectManagedGiveawaySendOptions(overrides: Record<string, unknown> = {}) {
  return expect.objectContaining({
    trafficClass: 'interactive',
    actionHealthLane: 'interactive',
    sourceTag: MAX_API_SOURCE_TAGS.MANAGED_GIVEAWAY,
    timeoutMs: 12000,
    ...overrides,
  });
}

function createManagedEntityAccessLossMock() {
  return {
    recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
  };
}

function createMaxBotLinkMock(
  options: {
    resolvedBotId?: string;
    entryBotId?: string;
    contactId?: string | null;
    token?: string;
  } = {},
) {
  const resolvedBotId = options.resolvedBotId ?? 'id613002203036_4_bot';
  const entryBotId = options.entryBotId ?? resolvedBotId;
  const contactId = options.contactId ?? '613002203040';
  const token = options.token ?? 'test-token';

  return {
    getBotTokenSync: jest.fn().mockReturnValue(token),
    getValidationTokens: jest.fn().mockReturnValue([token]),
    resolveBotIdForRead: jest.fn().mockResolvedValue(resolvedBotId),
    resolveBotIdForSend: jest.fn().mockResolvedValue(resolvedBotId),
    resolveBotId: jest.fn().mockResolvedValue(resolvedBotId),
    resolveContactIdSync: jest.fn((botId?: string | null) =>
      botId === resolvedBotId || botId == null ? contactId : null,
    ),
    buildEntryMiniappStartUrlSync: jest.fn((startParam: string) => {
      return `https://max.ru/${encodeURIComponent(entryBotId)}?startapp=${encodeURIComponent(startParam)}`;
    }),
    buildMiniappStartUrlSync: jest.fn((startParam: string, botId?: string | null) => {
      const targetBotId = botId?.trim() || resolvedBotId;
      return `https://max.ru/${encodeURIComponent(targetBotId)}?startapp=${encodeURIComponent(startParam)}`;
    }),
    buildBotStartUrlSync: jest.fn((startParam: string, botId?: string | null) => {
      const targetBotId = botId?.trim() || resolvedBotId;
      return `https://max.ru/${encodeURIComponent(targetBotId)}?start=${encodeURIComponent(startParam)}`;
    }),
  };
}

function createChatContextCacheMock(
  options: {
    giveawayBackoffRemainingById?: Map<string, number>;
    giveawayDeferRemainingById?: Map<string, number>;
    giveawayFailureCountById?: Map<string, number>;
  } = {},
) {
  const giveawayBackoffRemainingById = options.giveawayBackoffRemainingById ?? new Map();
  const giveawayDeferRemainingById = options.giveawayDeferRemainingById ?? new Map();
  const giveawayFailureCountById = options.giveawayFailureCountById ?? new Map();

  return {
    invalidate: jest.fn(),
    getManagedGiveawayRunnerBackoffRemainingMs: jest
      .fn()
      .mockImplementation(
        async (giveawayId: string) => giveawayBackoffRemainingById.get(giveawayId) ?? 0,
      ),
    getManagedGiveawayRunnerDeferRemainingMs: jest
      .fn()
      .mockImplementation(
        async (giveawayId: string) => giveawayDeferRemainingById.get(giveawayId) ?? 0,
      ),
    activateManagedGiveawayRunnerBackoff: jest
      .fn()
      .mockImplementation(async (giveawayId: string, ttlSec: number) => {
        giveawayBackoffRemainingById.set(giveawayId, ttlSec * 1000);
      }),
    activateManagedGiveawayRunnerDefer: jest
      .fn()
      .mockImplementation(async (giveawayId: string, ttlSec: number) => {
        giveawayDeferRemainingById.set(giveawayId, ttlSec * 1000);
      }),
    incrementManagedGiveawayRunnerFailureCount: jest
      .fn()
      .mockImplementation(async (giveawayId: string) => {
        const next = (giveawayFailureCountById.get(giveawayId) ?? 0) + 1;
        giveawayFailureCountById.set(giveawayId, next);
        return next;
      }),
    clearManagedGiveawayRunnerRetryCounters: jest
      .fn()
      .mockImplementation(async (giveawayId: string) => {
        giveawayBackoffRemainingById.delete(giveawayId);
        giveawayFailureCountById.delete(giveawayId);
      }),
    clearManagedGiveawayRunnerFailureState: jest
      .fn()
      .mockImplementation(async (giveawayId: string) => {
        giveawayBackoffRemainingById.delete(giveawayId);
        giveawayDeferRemainingById.delete(giveawayId);
        giveawayFailureCountById.delete(giveawayId);
      }),
  };
}

function createGiveaway(overrides: Record<string, unknown> = {}) {
  return {
    id: 'giveaway-1',
    sourceChatId: 'source-1',
    entityType: ChatEntityType.CHANNEL,
    actorUserId: 'admin-1',
    title: 'Весенний розыгрыш',
    description: '',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    startsAt: null,
    endsAt: new Date('2026-03-22T12:00:00.000Z'),
    claimHours: 48,
    status: ManagedGiveawayStatus.ACTIVE,
    requiredChannelIds: ['extra-1'],
    publicationMessageId: null,
    publicationBotId: null,
    publicationUrl: null,
    publishedAt: null,
    resultsMessageId: null,
    resultsBotId: null,
    resultsUrl: null,
    drawSeed: null,
    drawnAt: null,
    completedAt: null,
    canceledAt: null,
    lockedAt: null,
    createdAt: new Date('2026-03-21T09:00:00.000Z'),
    updatedAt: new Date('2026-03-21T09:00:00.000Z'),
    prizes: [],
    entries: [],
    winners: [],
    ...overrides,
  };
}

function createEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    giveawayId: 'giveaway-1',
    userId: 'user-1',
    displayName: 'Тестер',
    joinedAt: new Date('2026-03-21T10:00:00.000Z'),
    eligibilityState: GiveawayEligibilityState.REJECTED,
    eligibilityReason: 'Подписка на обязательный чат/канал не подтверждена.',
    missingChannelIds: ['extra-1'],
    checkedAt: new Date('2026-03-21T10:00:00.000Z'),
    drawRank: null,
    createdAt: new Date('2026-03-21T10:00:00.000Z'),
    updatedAt: new Date('2026-03-21T10:00:00.000Z'),
    ...overrides,
  };
}

function createPrize(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prize-1',
    giveawayId: 'giveaway-1',
    position: 1,
    title: 'Главный приз',
    createdAt: new Date('2026-03-21T09:00:00.000Z'),
    updatedAt: new Date('2026-03-21T09:00:00.000Z'),
    ...overrides,
  };
}

function createWinner(overrides: Record<string, unknown> = {}) {
  const entry = createEntry({
    id: 'entry-winner-1',
    userId: 'winner-1',
    displayName: 'CEO',
  });
  const prize = createPrize();

  return {
    id: 'winner-1',
    giveawayId: 'giveaway-1',
    prizeId: prize.id,
    entryId: entry.id,
    rank: 1,
    status: ManagedGiveawayWinnerStatus.SELECTED,
    claimDeadlineAt: new Date('2026-12-23T12:00:00.000Z'),
    claimedAt: null,
    deliveredAt: null,
    expiredAt: null,
    rerolledAt: null,
    selectedAt: new Date('2026-03-21T12:00:00.000Z'),
    createdAt: new Date('2026-03-21T12:00:00.000Z'),
    updatedAt: new Date('2026-03-21T12:00:00.000Z'),
    prize,
    entry,
    ...overrides,
  };
}

function createSecondWinner(overrides: Record<string, unknown> = {}) {
  const entry = createEntry({
    id: 'entry-winner-2',
    userId: 'winner-2',
    displayName: 'CTO',
  });
  const prize = createPrize({
    id: 'prize-2',
    position: 2,
    title: 'Второй приз',
  });

  return {
    id: 'winner-2',
    giveawayId: 'giveaway-1',
    prizeId: prize.id,
    entryId: entry.id,
    rank: 2,
    status: ManagedGiveawayWinnerStatus.SELECTED,
    claimDeadlineAt: new Date('2026-12-23T12:00:00.000Z'),
    claimedAt: null,
    deliveredAt: null,
    expiredAt: null,
    rerolledAt: null,
    selectedAt: new Date('2026-03-21T12:05:00.000Z'),
    createdAt: new Date('2026-03-21T12:05:00.000Z'),
    updatedAt: new Date('2026-03-21T12:05:00.000Z'),
    prize,
    entry,
    ...overrides,
  };
}

describe('ManagedGiveawayService', () => {
  const user = {
    userId: 'user-1',
    username: 'tester',
    displayName: 'Тестер',
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it('deletes published giveaway messages with their persisted author bots before removing the giveaway', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      { getChannelSettings: jest.fn().mockResolvedValue({}) } as never,
      createConfigMock() as never,
    );

    prisma.managedGiveaway.findFirst.mockResolvedValue(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'publication-1',
        publicationBotId: 'publication-author-bot',
        resultsMessageId: 'results-1',
        resultsBotId: 'results-author-bot',
      }),
    );
    prisma.managedGiveaway.delete.mockResolvedValue(createGiveaway());
    maxClient.deleteMessage.mockResolvedValue(undefined);

    await service.deleteManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel');

    expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(
      1,
      'source-1',
      'publication-1',
      expectManagedGiveawaySendOptions({
        immediate: true,
        botId: 'publication-author-bot',
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(
      2,
      'source-1',
      'results-1',
      expectManagedGiveawaySendOptions({
        immediate: true,
        botId: 'results-author-bot',
      }),
    );
    expect(prisma.managedGiveaway.delete).toHaveBeenCalledWith({
      where: { id: 'giveaway-1' },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'DELETE_GIVEAWAY',
        }),
      }),
    );
  });

  it('treats already missing giveaway publication messages as deleted', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const managedEntityAccessLossService = createManagedEntityAccessLossMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      { getChannelSettings: jest.fn().mockResolvedValue({}) } as never,
      createConfigMock() as never,
      undefined,
      undefined,
      managedEntityAccessLossService as never,
    );

    prisma.managedGiveaway.findFirst.mockResolvedValue(
      createGiveaway({
        status: ManagedGiveawayStatus.CANCELED,
        publicationMessageId: 'publication-missing-1',
        publicationBotId: 'publication-author-bot',
      }),
    );
    prisma.managedGiveaway.delete.mockResolvedValue(createGiveaway());
    maxClient.deleteMessage.mockRejectedValueOnce(
      createMaxApiError(404, 'message not found', 'message.not.found'),
    );

    await service.deleteManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel');

    expect(prisma.managedGiveaway.delete).toHaveBeenCalledWith({
      where: { id: 'giveaway-1' },
    });
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('stores repeated prize titles as unique winner slots', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T09:00:00.000Z'));

    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      { getChannelSettings: jest.fn().mockResolvedValue({}) } as never,
      createConfigMock() as never,
    );
    const prizes = Array.from({ length: 10 }, (_, index) => ({
      id: `prize-${index + 1}`,
      giveawayId: 'giveaway-duplicate-prizes',
      position: index + 1,
      title: `Прикормка ${index + 1}`,
      displayTitle: 'Прикормка',
      createdAt: new Date('2026-03-21T09:00:00.000Z'),
    }));
    const created = createGiveaway({
      id: 'giveaway-duplicate-prizes',
      status: ManagedGiveawayStatus.DRAFT,
      prizes,
    });

    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(null);
    prisma.managedGiveaway.create.mockResolvedValueOnce(created);

    await expect(
      service.createManagedGiveaway(
        'source-1',
        user as never,
        {
          title: 'Розыгрыш прикормки',
          description: '',
          imageEnabled: false,
          startsAt: null,
          endsAt: '2026-03-22T12:00:00.000Z',
          claimHours: 24,
          requiredChannelIds: [],
          prizes: Array.from({ length: 10 }, (_, index) => ({
            position: index + 1,
            title: 'Прикормка',
          })),
        },
        'channel',
      ),
    ).resolves.toMatchObject({
      id: 'giveaway-duplicate-prizes',
      prizes: prizes.map((prize) => ({
        position: prize.position,
        title: prize.title,
        displayTitle: 'Прикормка',
      })),
    });

    expect(prisma.managedGiveaway.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          prizes: {
            create: Array.from({ length: 10 }, (_, index) => ({
              position: index + 1,
              title: `Прикормка ${index + 1}`,
              displayTitle: 'Прикормка',
            })),
          },
        }),
      }),
    );
  });

  it('stores exact missing channel ids when enter fails required subscription checks', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:05:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const initial = createGiveaway();
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.REJECTED,
      missingChannelIds: ['extra-1'],
    });
    const latest = createGiveaway({
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await service.enterGiveaway('giveaway-1', user);

    expect(prisma.managedGiveawayEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          eligibilityState: GiveawayEligibilityState.REJECTED,
          missingChannelIds: ['extra-1'],
        }),
        update: expect.objectContaining({
          eligibilityState: GiveawayEligibilityState.REJECTED,
          missingChannelIds: ['extra-1'],
        }),
      }),
    );
    expect(result.eligibilityState).toBe('REJECTED');
    expect(result.missingChannelIds).toEqual(['extra-1']);
  });

  it('clears missing channel ids after successful retry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:10:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const rejectedEntry = createEntry();
    const refreshed = createGiveaway({
      entries: [rejectedEntry],
    });
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const latest = createGiveaway({
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    const result = await service.enterGiveaway('giveaway-1', user);

    expect(prisma.managedGiveawayEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          eligibilityState: GiveawayEligibilityState.VERIFIED,
          missingChannelIds: [],
        }),
      }),
    );
    expect(result.eligibilityState).toBe('VERIFIED');
    expect(result.missingChannelIds).toEqual([]);
  });

  it('uses the persisted bot assignment when checking giveaway required chat membership', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:11:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const membershipLookup = {
      getMembership: jest.fn().mockResolvedValue(true),
      getLookupIssue: jest.fn(),
    };
    prisma.chat.findUnique.mockImplementation(async (args: { where?: { id?: string } }) => {
      if (args.where?.id === 'source-1') {
        return { primaryBotId: 'bot-source', botId: null };
      }
      if (args.where?.id === 'extra-chat-1') {
        return { primaryBotId: 'bot-extra-chat', botId: null };
      }

      return { title: 'Основной канал' };
    });

    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      membershipLookup as never,
    );

    const refreshed = createGiveaway({
      requiredChannelIds: ['extra-chat-1'],
    });
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const latest = createGiveaway({
      requiredChannelIds: ['extra-chat-1'],
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);

    const result = await service.enterGiveaway('giveaway-1', user);

    expect(result.eligibilityState).toBe('VERIFIED');
    expect(membershipLookup.getMembership).toHaveBeenNthCalledWith(
      1,
      'source-1',
      'user-1',
      'giveaway_interactive',
      expect.objectContaining({ botId: 'bot-source' }),
    );
    expect(membershipLookup.getMembership).toHaveBeenNthCalledWith(
      2,
      'extra-chat-1',
      'user-1',
      'giveaway_interactive',
      expect.objectContaining({ botId: 'bot-extra-chat' }),
    );
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('writes a recheck audit entry when eligibility changes after retry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:11:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const rejectedEntry = createEntry();
    const refreshed = createGiveaway({
      entries: [rejectedEntry],
    });
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const latest = createGiveaway({
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await service.enterGiveaway('giveaway-1', user);

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'RECHECK_GIVEAWAY_ENTRY',
        actorUserId: 'user-1',
        chatId: 'source-1',
      }),
    });
  });

  it('does not create duplicate audit entries for unchanged participation rechecks', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:12:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const existingEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const refreshed = createGiveaway({
      requiredChannelIds: [],
      entries: [existingEntry],
    });
    const latest = createGiveaway({
      requiredChannelIds: [],
      entries: [existingEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(existingEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true);

    await service.enterGiveaway('giveaway-1', user);

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('refreshes publication button with the current participants count after enter', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:12:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const initial = createGiveaway({
      description: 'Текст публикации',
      publicationMessageId: 'publication-1',
      entries: [],
    });
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const latest = createGiveaway({
      description: 'Текст публикации',
      publicationMessageId: 'publication-1',
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await service.enterGiveaway('giveaway-1', user);

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'source-1',
      'publication-1',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Участвовать · 1' })]],
      }),
      expectManagedGiveawaySendOptions(),
    );
  });

  it('uses the persisted publication bot when refreshing an existing giveaway post', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:12:15.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxBotLinkService = createMaxBotLinkMock({ resolvedBotId: 'current-route-bot' });
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    const initial = createGiveaway({
      description: 'Текст публикации',
      publicationMessageId: 'publication-1',
      publicationBotId: 'publication-author-bot',
      entries: [],
    });
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const latest = createGiveaway({
      description: 'Текст публикации',
      publicationMessageId: 'publication-1',
      publicationBotId: 'publication-author-bot',
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await service.enterGiveaway('giveaway-1', user);

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'source-1',
      'publication-1',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Участвовать · 1' })]],
      }),
      expectManagedGiveawaySendOptions({ botId: 'publication-author-bot' }),
    );
  });

  it('does not count rejected entries in the published giveaway button', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:12:30.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const initial = createGiveaway({
      description: 'Текст публикации',
      publicationMessageId: 'publication-1',
      entries: [],
    });
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.REJECTED,
      missingChannelIds: ['extra-1'],
    });
    const latest = createGiveaway({
      description: 'Текст публикации',
      publicationMessageId: 'publication-1',
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await service.enterGiveaway('giveaway-1', user);

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'source-1',
      'publication-1',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Участвовать · 0' })]],
      }),
      expectManagedGiveawaySendOptions(),
    );
  });

  it('does not resend publication text when refreshing the published giveaway post', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:13:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const initial = createGiveaway({
      description: '# Жирный заголовок\n\nТекст с **акцентом**.',
      publicationMessageId: 'publication-1',
      entries: [],
    });
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const latest = createGiveaway({
      description: '# Жирный заголовок\n\nТекст с **акцентом**.',
      publicationMessageId: 'publication-1',
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await service.enterGiveaway('giveaway-1', user);

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'source-1',
      'publication-1',
      null,
      expect.not.objectContaining({
        textFormat: expect.any(String),
      }),
      expectManagedGiveawaySendOptions(),
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'source-1',
      'publication-1',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Участвовать · 1' })]],
      }),
      expectManagedGiveawaySendOptions(),
    );
  });

  it('does not auto-recheck rejected entries when reading participant state', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:15:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const giveaway = createGiveaway({
      entries: [createEntry()],
    });
    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(giveaway)
      .mockResolvedValueOnce(giveaway);

    const result = await service.getGiveawayParticipantState('giveaway-1', user);

    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
    expect(result.eligibilityState).toBe('REJECTED');
    expect(result.missingChannelIds).toEqual(['extra-1']);
  });

  it('scopes participant claim bot url to the giveaway source bot', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxBotLinkService = createMaxBotLinkMock({ resolvedBotId: '888000_bot' });
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );
    const entry = createEntry({
      id: 'entry-claim-1',
      userId: 'user-1',
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const winner = createWinner({
      id: 'winner-claim-1',
      entryId: entry.id,
      entry,
      status: ManagedGiveawayWinnerStatus.SELECTED,
    });
    const giveaway = createGiveaway({
      publicationMessageId: 'publication-1',
      publishedAt: new Date('2026-03-21T10:30:00.000Z'),
      entries: [entry],
      prizes: [winner.prize],
      winners: [winner],
    });
    prisma.managedGiveaway.findUnique.mockResolvedValue(giveaway);

    const result = await service.getGiveawayParticipantState('giveaway-1', user);

    expect(result.canClaim).toBe(true);
    expect(result.claimBotUrl).toContain('https://max.ru/888000_bot?start=');
    expect(maxBotLinkService.buildBotStartUrlSync).toHaveBeenCalledWith(
      expect.any(String),
      '888000_bot',
    );
  });

  it('does not expose an unpublished draft through the public giveaway endpoint', async () => {
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    prisma.managedGiveaway.findUnique.mockResolvedValueOnce(
      createGiveaway({
        status: ManagedGiveawayStatus.DRAFT,
        publishedAt: null,
        publicationMessageId: null,
        publicationUrl: null,
      }),
    );

    await expect(service.getPublicGiveaway('giveaway-1', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('exposes only non-rejected entries in the public giveaway count', async () => {
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const giveaway = createGiveaway({
      publicationMessageId: 'publication-1',
      requiredChannelIds: [],
      prizes: [createPrize()],
      entries: [
        createEntry({
          id: 'entry-verified-1',
          userId: 'verified-1',
          eligibilityState: GiveawayEligibilityState.VERIFIED,
          eligibilityReason: null,
          missingChannelIds: [],
        }),
        createEntry({
          id: 'entry-rejected-1',
          userId: 'rejected-1',
          eligibilityState: GiveawayEligibilityState.REJECTED,
        }),
      ],
    });
    prisma.managedGiveaway.findUnique.mockResolvedValue(giveaway);

    await expect(service.getPublicGiveaway('giveaway-1', user)).resolves.toMatchObject({
      entriesCount: 1,
    });
  });

  it('rejects participation for an unpublished giveaway id', async () => {
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    prisma.managedGiveaway.findUnique.mockResolvedValueOnce(
      createGiveaway({
        status: ManagedGiveawayStatus.CANCELED,
        publishedAt: null,
        publicationMessageId: null,
        publicationUrl: null,
        resultsMessageId: null,
        resultsUrl: null,
      }),
    );

    await expect(service.enterGiveaway('giveaway-1', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('falls back to the full mandatory list for legacy rejected entries without missingChannelIds', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:20:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const giveaway = createGiveaway({
      requiredChannelIds: ['extra-1', 'extra-2'],
      entries: [
        createEntry({
          missingChannelIds: [],
          eligibilityReason: 'Подписка на обязательные чаты/каналы не подтверждена.',
        }),
      ],
    });
    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(giveaway)
      .mockResolvedValueOnce(giveaway);

    const result = await service.getGiveawayParticipantState('giveaway-1', user);

    expect(result.missingChannelIds).toEqual(['source-1', 'extra-1', 'extra-2']);
  });

  it('publishes giveaway results as a linked reply to the original post', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-1',
      winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
    });

    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'results-1',
      url: 'https://max.ru/channels/source-1/messages/results-1',
    });

    await (service as any).republishGiveawayResults(giveaway);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'source-1',
      expect.stringContaining('🏆 Победитель:\n\n1. [CEO](max://user/winner-1)'),
      expect.objectContaining({
        textFormat: 'markdown',
        messageLink: {
          type: 'reply',
          mid: 'publication-1',
        },
        buttons: [[expect.objectContaining({ text: 'Проверить результаты' })]],
      }),
      expectManagedGiveawaySendOptions(),
    );
    expect(prisma.managedGiveaway.update).toHaveBeenCalledWith({
      where: { id: 'giveaway-1' },
      data: {
        resultsMessageId: 'results-1',
        resultsBotId: null,
        resultsUrl: 'https://max.ru/channels/source-1/messages/results-1',
        lockedAt: null,
      },
    });
  });

  it('stores and uses the persisted publication bot when publishing giveaway results', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxBotLinkService = createMaxBotLinkMock({ resolvedBotId: 'current-route-bot' });
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      publicationBotId: 'publication-author-bot',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-1',
      winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
    });

    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'results-1',
      url: 'https://max.ru/channels/source-1/messages/results-1',
    });

    await (service as any).republishGiveawayResults(giveaway);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'source-1',
      expect.stringContaining('🏆 Победитель:'),
      expect.objectContaining({
        messageLink: {
          type: 'reply',
          mid: 'publication-1',
        },
      }),
      expectManagedGiveawaySendOptions({ botId: 'publication-author-bot' }),
    );
    expect(prisma.managedGiveaway.update).toHaveBeenCalledWith({
      where: { id: 'giveaway-1' },
      data: {
        resultsMessageId: 'results-1',
        resultsBotId: 'publication-author-bot',
        resultsUrl: 'https://max.ru/channels/source-1/messages/results-1',
        lockedAt: null,
      },
    });
  });

  it('quarantines giveaway results after an ambiguous MAX send timeout', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const managedEntityAccessLossService = createManagedEntityAccessLossMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      createMaxBotLinkMock() as never,
      managedEntityAccessLossService as never,
    );
    const timeoutError = new Error('request timed out before response body arrived');
    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-1',
      winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
    });
    prisma.managedGiveaway.updateMany.mockResolvedValue({ count: 1 });
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(timeoutError);

    await (service as any).republishGiveawayResults(giveaway);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(prisma.managedGiveaway.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'giveaway-1',
          resultsMessageId: null,
          lockedAt: null,
        },
        data: { lockedAt: expect.any(Date) },
      }),
    );
    expect(prisma.managedGiveaway.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { lockedAt: null },
      }),
    );
    expect(prisma.managedGiveaway.update).not.toHaveBeenCalled();
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();

    maxClient.sendMessageImmediateWithResolvedLink.mockClear();
    await (service as any).republishGiveawayResults({
      ...giveaway,
      lockedAt: new Date('2026-03-21T12:40:00.000Z'),
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('records MAX access loss when publishing giveaway results is denied', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxBotLinkService = createMaxBotLinkMock();
    const managedEntityAccessLossService = createManagedEntityAccessLossMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
      managedEntityAccessLossService as never,
    );
    const error = createMaxApiError(403, 'Request failed with status code 403', 'chat.denied');
    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-1',
      winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(error);
    managedEntityAccessLossService.recordIfManagedEntityAccessLost.mockResolvedValue({
      classification: {
        kind: 'managed_entity_access_lost',
        reason: 'bot_denied',
        statusCode: 403,
        code: 'chat.denied',
        message: 'request failed with status code 403',
      },
      reason: 'bot_denied',
      recorded: {
        chatId: 'source-1',
        botId: 'id613002203036_4_bot',
        nextOwnerBotId: null,
        updatedAccessEdges: 1,
        cleanup: {
          nightModeJobsCleared: false,
          canceledBroadcasts: 0,
          canceledBroadcastDeliveries: 0,
          canceledBroadcastOccurrences: 0,
          clearedVkPublishPosts: 0,
          pausedVkSources: 0,
          removedRosterSyncJobs: 0,
        },
      },
    });

    await (service as any).republishGiveawayResults(giveaway);

    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'source-1',
      botId: 'id613002203036_4_bot',
      entityType: ChatEntityType.CHANNEL,
      source: 'managed_giveaway:results',
      operation: 'send',
      error,
    });
    expect(prisma.managedGiveaway.update).not.toHaveBeenCalled();
  });

  it('publishes giveaway text with markdown format when the bot draft contains markup', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T12:30:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const chatContextCache = { invalidate: jest.fn() };
    const adminService = {
      getChannelSettings: jest.fn().mockResolvedValue({}),
      getSettings: jest.fn().mockResolvedValue({}),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      adminService as never,
      createConfigMock() as never,
    );

    const draft = createGiveaway({
      status: ManagedGiveawayStatus.DRAFT,
      description:
        '# Жирный заголовок\n\nТекст с **акцентом**, _курсивом_ и [ссылкой](https://max.ru/).',
      entries: [],
      winners: [],
    });
    const published = createGiveaway({
      ...draft,
      status: ManagedGiveawayStatus.ACTIVE,
      publicationMessageId: 'publication-1',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-1',
      publishedAt: new Date('2026-03-21T12:30:00.000Z'),
    });

    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(null);
    prisma.managedGiveaway.update.mockResolvedValue(published);
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'publication-1',
      url: 'https://max.ru/channels/source-1/messages/publication-1',
    });

    await service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel');

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'source-1',
      '<p><strong>Жирный заголовок</strong></p><p>Текст с <strong>акцентом</strong>, <em>курсивом</em> и <a href="https://max.ru/">ссылкой</a>.</p>',
      expect.objectContaining({
        textFormat: 'html',
        buttons: [[expect.objectContaining({ text: 'Участвовать · 0' })]],
      }),
      expectManagedGiveawaySendOptions(),
    );
    expect(prisma.managedGiveaway.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'giveaway-1' },
        data: expect.objectContaining({
          status: ManagedGiveawayStatus.ACTIVE,
          publicationMessageId: 'publication-1',
        }),
      }),
    );
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('source-1');
  });

  it('quarantines giveaway publication after an ambiguous MAX send timeout', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const chatContextCache = { invalidate: jest.fn() };
    const adminService = {
      getChannelSettings: jest.fn().mockResolvedValue({}),
      getSettings: jest.fn().mockResolvedValue({}),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      adminService as never,
      createConfigMock() as never,
    );
    const draft = createGiveaway({
      status: ManagedGiveawayStatus.DRAFT,
      description: 'Текст публикации',
      entries: [],
      winners: [],
    });
    const timeoutError = new Error('request timed out before response body arrived');
    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(null);
    prisma.managedGiveaway.updateMany.mockResolvedValue({ count: 1 });
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(timeoutError);

    await expect(
      service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel'),
    ).rejects.toBe(timeoutError);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(prisma.managedGiveaway.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.managedGiveaway.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'giveaway-1',
        status: ManagedGiveawayStatus.DRAFT,
        lockedAt: null,
      },
      data: { lockedAt: expect.any(Date) },
    });
    expect(prisma.managedGiveaway.update).not.toHaveBeenCalled();
    expect(chatContextCache.invalidate).not.toHaveBeenCalled();

    prisma.managedGiveaway.findFirst.mockResolvedValueOnce({
      ...draft,
      lockedAt: new Date('2026-03-21T12:35:00.000Z'),
    });
    await expect(
      service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel'),
    ).rejects.toThrow('требует ручной проверки');
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
  });

  it('publishes nested bold italic underline links in giveaway text', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T12:30:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const chatContextCache = { invalidate: jest.fn() };
    const adminService = {
      getChannelSettings: jest.fn().mockResolvedValue({}),
      getSettings: jest.fn().mockResolvedValue({}),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      adminService as never,
      createConfigMock() as never,
    );

    const draft = createGiveaway({
      status: ManagedGiveawayStatus.DRAFT,
      description: '[**_++MAX Docs++_**](https://dev.max.ru/docs-api)',
      entries: [],
      winners: [],
    });
    const published = createGiveaway({
      ...draft,
      status: ManagedGiveawayStatus.ACTIVE,
      publicationMessageId: 'publication-1',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-1',
      publishedAt: new Date('2026-03-21T12:30:00.000Z'),
    });

    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(null);
    prisma.managedGiveaway.update.mockResolvedValue(published);
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'publication-1',
      url: 'https://max.ru/channels/source-1/messages/publication-1',
    });

    await service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel');

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'source-1',
      '<p><a href="https://dev.max.ru/docs-api"><strong><em><u>MAX Docs</u></em></strong></a></p>',
      expect.objectContaining({
        textFormat: 'html',
        buttons: [[expect.objectContaining({ text: 'Участвовать · 0' })]],
      }),
      expectManagedGiveawaySendOptions(),
    );
  });

  it('uses the entry bot for giveaway mini app deep links and the source bot for publication', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T12:35:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const chatContextCache = { invalidate: jest.fn() };
    const adminService = {
      getChannelSettings: jest.fn().mockResolvedValue({}),
      getSettings: jest.fn().mockResolvedValue({}),
    };
    const maxBotLinkService = createMaxBotLinkMock({
      resolvedBotId: 'id613002203036_4_bot',
      entryBotId: 'entry_bot',
    });
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      adminService as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    const draft = createGiveaway({
      status: ManagedGiveawayStatus.DRAFT,
      description: 'Текст публикации',
      entries: [],
      winners: [],
    });
    const published = createGiveaway({
      ...draft,
      status: ManagedGiveawayStatus.ACTIVE,
      publicationMessageId: 'publication-1',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-1',
      publishedAt: new Date('2026-03-21T12:35:00.000Z'),
    });

    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(null);
    prisma.managedGiveaway.update.mockResolvedValue(published);
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'publication-1',
      url: 'https://max.ru/channels/source-1/messages/publication-1',
    });

    await service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel');

    expect(maxBotLinkService.resolveBotIdForSend).toHaveBeenCalledWith({
      chatId: 'source-1',
      fallbackToPrimary: true,
    });
    expect(maxBotLinkService.resolveBotIdForRead).not.toHaveBeenCalled();
    expect(maxBotLinkService.buildEntryMiniappStartUrlSync).toHaveBeenCalledWith(
      expect.stringMatching(/^gg-/u),
    );
    expect(maxBotLinkService.buildMiniappStartUrlSync).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveContactIdSync).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'source-1',
      'Текст публикации',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              text: 'Участвовать · 0',
              url: expect.stringContaining('https://max.ru/entry_bot?startapp=gg-'),
            }),
          ],
        ],
      }),
      expectManagedGiveawaySendOptions({ botId: 'id613002203036_4_bot' }),
    );
    expect(prisma.managedGiveaway.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'giveaway-1' },
        data: expect.objectContaining({
          publicationMessageId: 'publication-1',
          publicationBotId: 'id613002203036_4_bot',
        }),
      }),
    );
  });

  it('uses the unified send route for giveaway publication sends when available', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T12:36:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const chatContextCache = { invalidate: jest.fn() };
    const adminService = {
      getChannelSettings: jest.fn().mockResolvedValue({}),
      getSettings: jest.fn().mockResolvedValue({}),
    };
    const maxBotLinkService = {
      ...createMaxBotLinkMock(),
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'source-route-1',
        primaryBotId: 'id613002203036_4_bot',
        botId: 'id613002203036_4_bot',
        candidateBotIds: ['id613002203036_4_bot'],
        reason: 'primary_confirmed',
      }),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      adminService as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    const draft = createGiveaway({
      sourceChatId: 'source-route-1',
      status: ManagedGiveawayStatus.DRAFT,
      description: 'Текст публикации',
      entries: [],
      winners: [],
    });
    const published = createGiveaway({
      ...draft,
      status: ManagedGiveawayStatus.ACTIVE,
      publicationMessageId: 'publication-route-1',
      publicationUrl: 'https://max.ru/channels/source-route-1/messages/publication-route-1',
      publishedAt: new Date('2026-03-21T12:36:00.000Z'),
    });

    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(null);
    prisma.managedGiveaway.update.mockResolvedValue(published);
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'publication-route-1',
      url: 'https://max.ru/channels/source-route-1/messages/publication-route-1',
    });

    await service.publishManagedGiveaway('source-route-1', 'giveaway-1', user as never, 'channel');

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'source-route-1',
      fallbackToPrimary: true,
    });
    expect(maxBotLinkService.resolveBotIdForRead).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveBotIdForSend).not.toHaveBeenCalled();
    expect(maxBotLinkService.buildEntryMiniappStartUrlSync).toHaveBeenCalledWith(
      expect.stringMatching(/^gg-/u),
    );
    expect(maxBotLinkService.buildMiniappStartUrlSync).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'source-route-1',
      'Текст публикации',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              text: 'Участвовать · 0',
              url: expect.stringContaining('https://max.ru/id613002203036_4_bot?startapp=gg-'),
            }),
          ],
        ],
      }),
      expectManagedGiveawaySendOptions({ botId: 'id613002203036_4_bot' }),
    );
  });

  it('exposes winner name in public results immediately after draw', () => {
    const service = new ManagedGiveawayService(
      createPrismaMock() as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const selectedText = (service as any).buildGiveawayResultsText(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'publication-1',
        winners: [createWinner({ status: ManagedGiveawayWinnerStatus.SELECTED })],
      }),
    );
    const confirmedText = (service as any).buildGiveawayResultsText(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'publication-1',
        winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
      }),
    );

    expect(selectedText).toContain('🏆 Победитель:\n\n1. [CEO](max://user/winner-1)');
    expect(confirmedText).toContain('🏆 Победитель:\n\n1. [CEO](max://user/winner-1)');
  });

  it('uses plural winner heading when multiple prizes are awarded', () => {
    const service = new ManagedGiveawayService(
      createPrismaMock() as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const text = (service as any).buildGiveawayResultsText(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'publication-1',
        winners: [
          createWinner({ status: ManagedGiveawayWinnerStatus.SELECTED }),
          createSecondWinner({ status: ManagedGiveawayWinnerStatus.SELECTED }),
        ],
      }),
    );

    expect(text).toContain('🏆 Победители:\n\n1. [CEO](max://user/winner-1)');
    expect(text).toContain('2. [CTO](max://user/winner-2)');
  });

  it('publishes giveaway results as markdown with real line breaks', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'results-1',
      url: 'https://max.ru/channels/source-1/messages/results-1',
    });

    await (service as any).republishGiveawayResults(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'publication-1',
        winners: [
          createWinner({ status: ManagedGiveawayWinnerStatus.SELECTED }),
          createSecondWinner({ status: ManagedGiveawayWinnerStatus.SELECTED }),
        ],
      }),
    );

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'source-1',
      expect.stringContaining(
        '🏆 Победители:\n\n1. [CEO](max://user/winner-1) — Главный приз\n2. [CTO](max://user/winner-2) — Второй приз',
      ),
      expect.objectContaining({
        textFormat: 'markdown',
      }),
      expectManagedGiveawaySendOptions(),
    );
  });

  it('keeps winner mention as a hyperlink when refreshing an existing results post', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    await (service as any).republishGiveawayResults(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'publication-1',
        resultsMessageId: 'results-1',
        resultsBotId: 'results-author-bot',
        winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
      }),
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'source-1',
      'results-1',
      expect.stringContaining('[CEO](max://user/winner-1)'),
      expect.objectContaining({
        textFormat: 'markdown',
        messageLink: {
          type: 'reply',
          mid: 'publication-1',
        },
      }),
      expectManagedGiveawaySendOptions({ botId: 'results-author-bot' }),
    );
  });

  it('sends a direct message to each freshly selected winner', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    await (service as any).sendWinnerDirectMessages(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationUrl: 'https://max.ru/chats/chat-1/message/1',
        resultsUrl: 'https://max.ru/chats/chat-1/message/2',
        winners: [
          createWinner({
            status: ManagedGiveawayWinnerStatus.SELECTED,
          }),
        ],
      }),
      ['entry-winner-1:prize-1'],
    );

    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledWith(
      'winner-1',
      expect.stringContaining('Вы выиграли в розыгрыше'),
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: 'Забрать приз' })],
          [
            expect.objectContaining({ text: 'Открыть пост' }),
            expect.objectContaining({ text: 'Итоги' }),
          ],
        ],
      }),
      expectManagedGiveawaySendOptions(),
    );
  });

  it('sends winner direct messages and claim links through the giveaway publication bot', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      title: 'Основной канал',
      primaryBotId: '888000_bot',
      botId: '777000_bot',
    });
    const maxClient = createMaxClientMock();
    const maxBotLinkService = createMaxBotLinkMock({
      resolvedBotId: '888000_bot',
      token: 'selected-token',
    });
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    await (service as any).sendWinnerDirectMessages(
      createGiveaway({
        sourceChatId: '-70000000000001',
        status: ManagedGiveawayStatus.COMPLETED,
        winners: [
          createWinner({
            status: ManagedGiveawayWinnerStatus.SELECTED,
          }),
        ],
      }),
      ['entry-winner-1:prize-1'],
    );

    expect(maxBotLinkService.getBotTokenSync).toHaveBeenCalledWith('888000_bot');
    expect(maxBotLinkService.buildBotStartUrlSync).toHaveBeenCalledWith(
      expect.any(String),
      '888000_bot',
    );
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledWith(
      'winner-1',
      expect.stringContaining('Вы выиграли в розыгрыше'),
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              text: 'Забрать приз',
              url: expect.stringContaining('https://max.ru/888000_bot?start='),
            }),
          ],
        ],
      }),
      expectManagedGiveawaySendOptions({ botId: '888000_bot' }),
    );
  });

  it('accepts giveaway claim payloads signed with the previous bot token', () => {
    const previousToken = 'test-token-previous';
    const legacyService = new ManagedGiveawayService(
      createPrismaMock() as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock({ token: previousToken }) as never,
    );
    const service = new ManagedGiveawayService(
      createPrismaMock() as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock({ previousToken }) as never,
    );

    const claimUrl = legacyService.buildGiveawayClaimBotStartUrl('giveaway-1', 'winner-1');
    const claimPayload = claimUrl ? new URL(claimUrl).searchParams.get('start') : null;

    expect(claimPayload).not.toBeNull();
    expect(claimPayload!.length).toBeLessThanOrEqual(128);
    expect(service.parseClaimStartPayload(claimPayload)).toEqual({
      giveawayId: 'giveaway-1',
      winnerId: 'winner-1',
    });
  });

  it('revalidates every entry before draw and excludes users who left the source chat', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const removedEntry = createEntry({
      id: 'entry-removed',
      userId: 'winner-1',
      displayName: 'Ушёл',
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const activeEntry = createEntry({
      id: 'entry-active',
      userId: 'winner-2',
      displayName: 'Остался',
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
      drawRank: '000-active',
    });
    const lateRejectedEntry = createEntry({
      id: 'entry-late',
      userId: 'winner-3',
      displayName: 'Вернулся',
      eligibilityState: GiveawayEligibilityState.REJECTED,
      eligibilityReason: 'Подписка на источник не подтверждена.',
      missingChannelIds: ['source-1'],
      drawRank: 'fff-late',
    });
    const prize = createPrize();
    const initial = createGiveaway({
      requiredChannelIds: [],
      prizes: [prize],
      entries: [removedEntry, activeEntry, lateRejectedEntry],
      drawSeed: 'seed-1',
      resultsMessageId: 'results-1',
    });
    const drawStarted = createGiveaway({
      ...initial,
      status: ManagedGiveawayStatus.DRAWING,
      drawSeed: 'seed-1',
      drawnAt: new Date('2026-03-21T13:00:00.000Z'),
      lockedAt: new Date('2026-03-21T13:00:00.000Z'),
    });
    const refreshedActiveEntry = {
      ...activeEntry,
      checkedAt: new Date('2026-03-21T13:00:00.000Z'),
      drawRank: 'draw-rank-active',
    };
    const refreshedLateEntry = {
      ...lateRejectedEntry,
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
      checkedAt: new Date('2026-03-21T13:00:00.000Z'),
    };
    const completed = createGiveaway({
      ...initial,
      status: ManagedGiveawayStatus.COMPLETED,
      drawSeed: 'seed-1',
      drawnAt: new Date('2026-03-21T13:00:00.000Z'),
      completedAt: new Date('2026-03-21T13:00:00.000Z'),
      entries: [
        {
          ...removedEntry,
          eligibilityState: GiveawayEligibilityState.REJECTED,
          eligibilityReason: 'Подписка на источник не подтверждена.',
          missingChannelIds: ['source-1'],
          checkedAt: new Date('2026-03-21T13:00:00.000Z'),
        },
        refreshedActiveEntry,
        refreshedLateEntry,
      ],
      winners: [
        createWinner({
          prize,
          prizeId: prize.id,
          entry: refreshedActiveEntry,
          entryId: refreshedActiveEntry.id,
          status: ManagedGiveawayWinnerStatus.SELECTED,
          selectedAt: new Date('2026-03-21T13:00:00.000Z'),
          claimedAt: null,
          claimDeadlineAt: new Date('2026-03-23T13:00:00.000Z'),
        }),
      ],
    });

    const prismaEntryUpdate = jest.fn().mockImplementation(async ({ where, data }) => ({
      ...(where.id === removedEntry.id
        ? removedEntry
        : where.id === lateRejectedEntry.id
          ? lateRejectedEntry
          : activeEntry),
      ...data,
    }));
    const txManagedEntryUpdate = jest.fn().mockImplementation(async ({ where, data }) => ({
      ...(where.id === removedEntry.id
        ? removedEntry
        : where.id === lateRejectedEntry.id
          ? lateRejectedEntry
          : activeEntry),
      ...data,
    }));
    const txWinnerCreateMany = jest.fn().mockResolvedValue({ count: 1 });

    prisma.managedGiveaway.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(drawStarted)
      .mockResolvedValueOnce(completed);
    prisma.managedGiveawayEntry.update = prismaEntryUpdate;
    prisma.$transaction.mockImplementation(async (callback) =>
      callback({
        managedGiveaway: {
          update: jest.fn().mockResolvedValue(undefined),
          findUniqueOrThrow: jest.fn().mockResolvedValue(completed),
        },
        managedGiveawayEntry: {
          update: txManagedEntryUpdate,
        },
        managedGiveawayWinner: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany: txWinnerCreateMany,
        },
      }),
    );
    maxClient.hasChatMember
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    maxClient.editMessageInlineKeyboard.mockResolvedValue(undefined);
    maxClient.sendMessageImmediateToUser.mockResolvedValue(undefined);

    await (service as any).drawGiveaway('giveaway-1', 'runner');

    expect(prismaEntryUpdate).toHaveBeenCalledWith({
      where: { id: 'entry-removed' },
      data: expect.objectContaining({
        eligibilityState: GiveawayEligibilityState.REJECTED,
        missingChannelIds: ['source-1'],
      }),
    });
    expect(prismaEntryUpdate).toHaveBeenCalledWith({
      where: { id: 'entry-late' },
      data: expect.objectContaining({
        eligibilityState: GiveawayEligibilityState.VERIFIED,
        missingChannelIds: [],
      }),
    });
    expect(txWinnerCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          entryId: 'entry-active',
          prizeId: 'prize-1',
        }),
      ],
    });
  });

  it('preserves verified entries on transient draw recheck failures', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:05:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const verifiedEntry = createEntry({
      id: 'entry-verified',
      userId: 'winner-1',
      displayName: 'Проверенный',
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const prize = createPrize();
    const initial = createGiveaway({
      requiredChannelIds: [],
      prizes: [prize],
      entries: [verifiedEntry],
      drawSeed: 'seed-2',
      resultsMessageId: 'results-1',
    });
    const drawStarted = createGiveaway({
      ...initial,
      status: ManagedGiveawayStatus.DRAWING,
      drawSeed: 'seed-2',
      drawnAt: new Date('2026-03-21T13:05:00.000Z'),
      lockedAt: new Date('2026-03-21T13:05:00.000Z'),
    });
    const refreshedEntry = {
      ...verifiedEntry,
      checkedAt: new Date('2026-03-21T13:05:00.000Z'),
      drawRank: 'draw-rank-verified',
    };
    const completed = createGiveaway({
      ...initial,
      status: ManagedGiveawayStatus.COMPLETED,
      drawSeed: 'seed-2',
      drawnAt: new Date('2026-03-21T13:05:00.000Z'),
      completedAt: new Date('2026-03-21T13:05:00.000Z'),
      entries: [refreshedEntry],
      winners: [
        createWinner({
          prize,
          prizeId: prize.id,
          entry: refreshedEntry,
          entryId: refreshedEntry.id,
          status: ManagedGiveawayWinnerStatus.SELECTED,
          selectedAt: new Date('2026-03-21T13:05:00.000Z'),
          claimedAt: null,
          claimDeadlineAt: new Date('2026-03-23T13:05:00.000Z'),
        }),
      ],
    });

    const prismaEntryUpdate = jest.fn().mockImplementation(async ({ data }) => ({
      ...verifiedEntry,
      ...data,
    }));
    const txManagedEntryUpdate = jest.fn().mockImplementation(async ({ data }) => ({
      ...verifiedEntry,
      ...data,
    }));
    const txWinnerCreateMany = jest.fn().mockResolvedValue({ count: 1 });

    prisma.managedGiveaway.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(drawStarted)
      .mockResolvedValueOnce(completed);
    prisma.managedGiveawayEntry.update = prismaEntryUpdate;
    prisma.$transaction.mockImplementation(async (callback) =>
      callback({
        managedGiveaway: {
          update: jest.fn().mockResolvedValue(undefined),
          findUniqueOrThrow: jest.fn().mockResolvedValue(completed),
        },
        managedGiveawayEntry: {
          update: txManagedEntryUpdate,
        },
        managedGiveawayWinner: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany: txWinnerCreateMany,
        },
      }),
    );
    maxClient.hasChatMember.mockRejectedValueOnce(new Error('temporary MAX failure'));
    maxClient.editMessageInlineKeyboard.mockResolvedValue(undefined);
    maxClient.sendMessageImmediateToUser.mockResolvedValue(undefined);

    await (service as any).drawGiveaway('giveaway-1', 'runner');

    expect(prismaEntryUpdate).toHaveBeenCalledWith({
      where: { id: 'entry-verified' },
      data: expect.objectContaining({
        eligibilityState: GiveawayEligibilityState.VERIFIED,
        eligibilityReason: null,
        missingChannelIds: [],
      }),
    });
    expect(txWinnerCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          entryId: 'entry-verified',
          prizeId: 'prize-1',
        }),
      ],
    });
  });

  it('uses shared batch membership lookups during draw when the lookup service is available', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:10:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const membershipLookup = {
      getMemberships: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'source-1' || chatId === 'extra-1') {
          return new Map([['user-1', true]]);
        }

        return new Map();
      }),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      membershipLookup as never,
    );

    const entry = createEntry({
      id: 'entry-batch-1',
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const prize = createPrize();
    const initial = createGiveaway({
      requiredChannelIds: ['extra-1'],
      prizes: [prize],
      entries: [entry],
      drawSeed: 'seed-batch',
      resultsMessageId: 'results-batch-1',
    });
    const drawStarted = createGiveaway({
      ...initial,
      status: ManagedGiveawayStatus.DRAWING,
      drawSeed: 'seed-batch',
      drawnAt: new Date('2026-03-21T13:10:00.000Z'),
      lockedAt: new Date('2026-03-21T13:10:00.000Z'),
    });
    const refreshedEntry = {
      ...entry,
      checkedAt: new Date('2026-03-21T13:10:00.000Z'),
      drawRank: 'draw-rank-batch',
    };
    const completed = createGiveaway({
      ...initial,
      status: ManagedGiveawayStatus.COMPLETED,
      drawSeed: 'seed-batch',
      drawnAt: new Date('2026-03-21T13:10:00.000Z'),
      completedAt: new Date('2026-03-21T13:10:00.000Z'),
      entries: [refreshedEntry],
      winners: [
        createWinner({
          prize,
          prizeId: prize.id,
          entry: refreshedEntry,
          entryId: refreshedEntry.id,
          status: ManagedGiveawayWinnerStatus.SELECTED,
          selectedAt: new Date('2026-03-21T13:10:00.000Z'),
          claimedAt: null,
          claimDeadlineAt: new Date('2026-03-23T13:10:00.000Z'),
        }),
      ],
    });

    prisma.managedGiveaway.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(drawStarted)
      .mockResolvedValueOnce(completed);
    prisma.managedGiveawayEntry.update = jest.fn().mockImplementation(async ({ data }) => ({
      ...entry,
      ...data,
    }));
    prisma.$transaction.mockImplementation(async (callback) =>
      callback({
        managedGiveaway: {
          update: jest.fn().mockResolvedValue(undefined),
          findUniqueOrThrow: jest.fn().mockResolvedValue(completed),
        },
        managedGiveawayEntry: {
          update: jest.fn().mockImplementation(async ({ data }) => ({
            ...entry,
            ...data,
          })),
        },
        managedGiveawayWinner: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      }),
    );
    maxClient.editMessageInlineKeyboard.mockResolvedValue(undefined);
    maxClient.sendMessageImmediateToUser.mockResolvedValue(undefined);

    await (service as any).drawGiveaway('giveaway-1', 'runner');

    expect(membershipLookup.getMemberships).toHaveBeenCalledTimes(2);
    expect(membershipLookup.getMemberships).toHaveBeenNthCalledWith(
      1,
      'source-1',
      ['user-1'],
      'giveaway_draw_background',
      {
        forceRefresh: true,
        allowStaleOnError: true,
      },
    );
    expect(membershipLookup.getMemberships).toHaveBeenNthCalledWith(
      2,
      'extra-1',
      ['user-1'],
      'giveaway_draw_background',
      {
        forceRefresh: true,
        allowStaleOnError: true,
      },
    );
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('skips due giveaways that are already under retry backoff', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:20:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.managedGiveaway.findMany.mockResolvedValue([
        { id: 'giveaway-1' },
        { id: 'giveaway-2' },
      ]);

      const chatContextCache = createChatContextCacheMock({
        giveawayBackoffRemainingById: new Map([['giveaway-1', 45_000]]),
      });
      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        chatContextCache as never,
        {} as never,
        createConfigMock() as never,
      );
      const processSpy = jest
        .spyOn(service as any, 'processDueManagedGiveaway')
        .mockResolvedValue(undefined);

      await service.processDueManagedGiveaways('scheduled');

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledWith('giveaway-2', 'scheduled', expect.any(Date));
    } finally {
      jest.useRealTimers();
    }
  });

  it('pauses due giveaways when the background governor is unavailable', async () => {
    const prisma = createPrismaMock();
    const backgroundRuntimeGovernor = {
      decide: jest.fn().mockRejectedValue(new Error('timeout exceeded when trying to connect')),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      createChatContextCacheMock() as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      backgroundRuntimeGovernor as never,
    );
    const processSpy = jest
      .spyOn(service as any, 'processDueManagedGiveaway')
      .mockResolvedValue(undefined);

    await service.processDueManagedGiveaways('scheduled');

    expect(backgroundRuntimeGovernor.decide).toHaveBeenCalledWith({
      component: 'managed-giveaway',
      sourceTag: 'giveaway_draw_background',
    });
    expect(prisma.managedGiveawayWinner.findMany).not.toHaveBeenCalled();
    expect(prisma.managedGiveaway.findMany).not.toHaveBeenCalled();
    expect(processSpy).not.toHaveBeenCalled();
  });

  it('skips due giveaways for chats with bot-denied access edges', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:22:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.managedGiveaway.findMany.mockResolvedValue([
        { id: 'giveaway-denied', sourceChatId: 'source-denied' },
        { id: 'giveaway-open', sourceChatId: 'source-open' },
      ]);
      prisma.managedEntityAccessEdge.findMany
        .mockResolvedValueOnce([{ chatId: 'source-denied', botId: 'lost-bot' }])
        .mockResolvedValueOnce([]);

      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        createChatContextCacheMock() as never,
        {} as never,
        createConfigMock() as never,
      );
      const processSpy = jest
        .spyOn(service as any, 'processDueManagedGiveaway')
        .mockResolvedValue(undefined);

      await service.processDueManagedGiveaways('scheduled');

      expect(prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledWith({
        where: {
          chatId: { in: ['source-denied', 'source-open'] },
          state: ManagedEntityAccessState.BOT_DENIED,
        },
        select: { chatId: true, botId: true },
      });
      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledWith('giveaway-open', 'scheduled', expect.any(Date));
    } finally {
      jest.useRealTimers();
    }
  });

  it('still skips due giveaways when a fresh granted edge lacks active bot membership', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:22:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.managedGiveaway.findMany.mockResolvedValue([
        { id: 'giveaway-denied', sourceChatId: 'source-denied' },
      ]);
      prisma.managedEntityAccessEdge.findMany
        .mockResolvedValueOnce([{ chatId: 'source-denied', botId: 'lost-bot' }])
        .mockResolvedValueOnce([{ chatId: 'source-denied', botId: 'active-bot' }]);

      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        createChatContextCacheMock() as never,
        {} as never,
        createConfigMock() as never,
      );
      const processSpy = jest
        .spyOn(service as any, 'processDueManagedGiveaway')
        .mockResolvedValue(undefined);

      await service.processDueManagedGiveaways('scheduled');

      expect(processSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps due giveaways running when a fresh granted edge matches active bot membership', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:22:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.managedGiveaway.findMany.mockResolvedValue([
        { id: 'giveaway-shared', sourceChatId: 'source-shared' },
      ]);
      prisma.managedEntityAccessEdge.findMany
        .mockResolvedValueOnce([{ chatId: 'source-shared', botId: 'lost-bot' }])
        .mockResolvedValueOnce([{ chatId: 'source-shared', botId: 'active-bot' }]);
      prisma.chatBotMembership.findMany.mockResolvedValue([
        {
          chatId: 'source-shared',
          botId: 'active-bot',
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: null,
        },
        {
          chatId: 'source-shared',
          botId: 'lost-bot',
          status: ChatBotMembershipStatus.REMOVED,
          permissionsSnapshot: null,
        },
      ]);

      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        createChatContextCacheMock() as never,
        {} as never,
        createConfigMock() as never,
      );
      const processSpy = jest
        .spyOn(service as any, 'processDueManagedGiveaway')
        .mockResolvedValue(undefined);

      await service.processDueManagedGiveaways('scheduled');

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledWith('giveaway-shared', 'scheduled', expect.any(Date));
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps due giveaways running when another bot still has confirmed admin access', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:22:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.managedGiveaway.findMany.mockResolvedValue([
        { id: 'giveaway-shared', sourceChatId: 'source-shared' },
      ]);
      prisma.managedEntityAccessEdge.findMany
        .mockResolvedValueOnce([{ chatId: 'source-shared', botId: 'lost-bot' }])
        .mockResolvedValueOnce([]);
      prisma.chatBotMembership.findMany.mockResolvedValue([
        {
          chatId: 'source-shared',
          botId: 'active-bot',
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            isAdmin: true,
            isOwner: false,
            permissions: [],
          },
        },
        {
          chatId: 'source-shared',
          botId: 'lost-bot',
          status: ChatBotMembershipStatus.REMOVED,
          permissionsSnapshot: null,
        },
      ]);

      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        createChatContextCacheMock() as never,
        {} as never,
        createConfigMock() as never,
      );
      const processSpy = jest
        .spyOn(service as any, 'processDueManagedGiveaway')
        .mockResolvedValue(undefined);

      await service.processDueManagedGiveaways('scheduled');

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledWith('giveaway-shared', 'scheduled', expect.any(Date));
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips due giveaways that are already under extended retry defer', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:25:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.managedGiveaway.findMany.mockResolvedValue([
        { id: 'giveaway-1' },
        { id: 'giveaway-2' },
      ]);

      const chatContextCache = createChatContextCacheMock({
        giveawayDeferRemainingById: new Map([['giveaway-1', 15 * 60_000]]),
      });
      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        chatContextCache as never,
        {} as never,
        createConfigMock() as never,
      );
      const processSpy = jest
        .spyOn(service as any, 'processDueManagedGiveaway')
        .mockResolvedValue(undefined);

      await service.processDueManagedGiveaways('scheduled');

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledWith('giveaway-2', 'scheduled', expect.any(Date));
    } finally {
      jest.useRealTimers();
    }
  });

  it('expires selected winners whose claim deadline has passed before processing due giveaways', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-23T13:30:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.managedGiveawayWinner.findMany.mockResolvedValueOnce([
        { id: 'winner-1', giveawayId: 'giveaway-1' },
      ]);
      prisma.managedGiveaway.findUnique.mockResolvedValue(
        createGiveaway({
          status: ManagedGiveawayStatus.COMPLETED,
          winners: [createWinner()],
          resultsMessageId: 'results-1',
        }),
      );
      prisma.managedGiveaway.findMany.mockResolvedValue([]);

      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        createChatContextCacheMock() as never,
        {} as never,
        createConfigMock() as never,
      );
      jest.spyOn(service as any, 'editGiveawayPublicationIfNeeded').mockResolvedValue(undefined);
      jest.spyOn(service as any, 'republishGiveawayResults').mockResolvedValue(undefined);

      await service.processDueManagedGiveaways('scheduled');

      expect(prisma.managedGiveawayWinner.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['winner-1'] },
          status: ManagedGiveawayWinnerStatus.SELECTED,
        },
        data: {
          status: ManagedGiveawayWinnerStatus.EXPIRED,
          expiredAt: new Date('2026-03-23T13:30:00.000Z'),
        },
      });
      expect((service as any).republishGiveawayResults).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('applies a longer terminal defer and clears short retry state after terminal lookup failures', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:25:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.managedGiveaway.updateMany.mockResolvedValue({ count: 1 });
      prisma.managedGiveaway.findUnique.mockResolvedValue(
        createGiveaway({
          endsAt: new Date('2026-03-21T13:00:00.000Z'),
        }),
      );

      const chatContextCache = createChatContextCacheMock();
      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        chatContextCache as never,
        {} as never,
        createConfigMock() as never,
      );
      jest
        .spyOn(service as any, 'drawGiveaway')
        .mockRejectedValue(
          new ManagedGiveawayMembershipLookupUnavailableError('terminal', 'source-1', 30 * 60_000),
        );

      await expect(
        (service as any).processDueManagedGiveaway(
          'giveaway-1',
          'scheduled',
          new Date('2026-03-21T13:24:00.000Z'),
        ),
      ).resolves.toBeUndefined();

      expect(chatContextCache.activateManagedGiveawayRunnerDefer).toHaveBeenCalledWith(
        'giveaway-1',
        2 * 60 * 60,
      );
      expect(chatContextCache.clearManagedGiveawayRunnerRetryCounters).toHaveBeenCalledWith(
        'giveaway-1',
      );
      expect(chatContextCache.incrementManagedGiveawayRunnerFailureCount).not.toHaveBeenCalled();
      expect(prisma.managedGiveaway.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'giveaway-1',
          status: ManagedGiveawayStatus.DRAWING,
        },
        data: {
          status: ManagedGiveawayStatus.ACTIVE,
          lockedAt: null,
        },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('escalates runner membership lookup retries from backoff to defer after repeated failures', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:25:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.managedGiveaway.updateMany.mockResolvedValue({ count: 1 });
      prisma.managedGiveaway.findUnique.mockResolvedValue(
        createGiveaway({
          endsAt: new Date('2026-03-21T13:00:00.000Z'),
        }),
      );

      const chatContextCache = createChatContextCacheMock();
      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        chatContextCache as never,
        {} as never,
        createConfigMock() as never,
      );
      jest
        .spyOn(service as any, 'drawGiveaway')
        .mockRejectedValue(
          new BadRequestException('Не удалось проверить участие в исходном чате. Повторите позже.'),
        );

      await expect(
        (service as any).processDueManagedGiveaway(
          'giveaway-1',
          'scheduled',
          new Date('2026-03-21T13:24:00.000Z'),
        ),
      ).resolves.toBeUndefined();
      await expect(
        (service as any).processDueManagedGiveaway(
          'giveaway-1',
          'scheduled',
          new Date('2026-03-21T13:24:00.000Z'),
        ),
      ).resolves.toBeUndefined();
      await expect(
        (service as any).processDueManagedGiveaway(
          'giveaway-1',
          'scheduled',
          new Date('2026-03-21T13:24:00.000Z'),
        ),
      ).resolves.toBeUndefined();
      await expect(
        (service as any).processDueManagedGiveaway(
          'giveaway-1',
          'scheduled',
          new Date('2026-03-21T13:24:00.000Z'),
        ),
      ).resolves.toBeUndefined();

      expect(chatContextCache.incrementManagedGiveawayRunnerFailureCount).toHaveBeenNthCalledWith(
        1,
        'giveaway-1',
        6 * 60 * 60,
      );
      expect(chatContextCache.activateManagedGiveawayRunnerBackoff).toHaveBeenNthCalledWith(
        1,
        'giveaway-1',
        60,
      );
      expect(chatContextCache.activateManagedGiveawayRunnerBackoff).toHaveBeenNthCalledWith(
        2,
        'giveaway-1',
        120,
      );
      expect(chatContextCache.activateManagedGiveawayRunnerBackoff).toHaveBeenNthCalledWith(
        3,
        'giveaway-1',
        240,
      );
      expect(chatContextCache.activateManagedGiveawayRunnerDefer).toHaveBeenCalledWith(
        'giveaway-1',
        30 * 60,
      );
      expect(chatContextCache.clearManagedGiveawayRunnerRetryCounters).toHaveBeenCalledWith(
        'giveaway-1',
      );
      expect(prisma.managedGiveaway.updateMany).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });
});
