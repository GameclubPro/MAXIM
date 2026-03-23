import {
  ChatEntityType,
  GiveawayEligibilityState,
  ManagedGiveawayStatus,
  ManagedGiveawayWinnerStatus,
} from '@prisma/client';
import { ManagedGiveawayService } from './managed-giveaway.service';

function createConfigMock() {
  return {
    get: jest.fn((key: string) => {
      if (key === 'APP_BASE_URL') {
        return 'https://maxim.play-team.ru';
      }
      if (key === 'MAX_BOT_CONTACT_ID') {
        return 'maxim-bot';
      }
      if (key === 'MAX_BOT_ID') {
        return 'maxim-bot';
      }
      return undefined;
    }),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'MAX_BOT_TOKEN') {
        return 'test-token';
      }
      throw new Error(`Missing config key ${key}`);
    }),
  };
}

function createPrismaMock() {
  return {
    managedGiveaway: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    managedGiveawayEntry: {
      upsert: jest.fn(),
      update: jest.fn(),
    },
    chat: {
      upsert: jest.fn().mockResolvedValue(undefined),
      findUnique: jest.fn().mockResolvedValue({ title: 'Основной канал' }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function createMaxClientMock() {
  return {
    hasChatMember: jest.fn(),
    getChatTitle: jest.fn(),
    getChatSnapshot: jest.fn(),
    sendMessageImmediateWithResolvedLink: jest.fn(),
    sendMessageImmediateToUser: jest.fn(),
    editMessageInlineKeyboard: jest.fn(),
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
    publicationUrl: null,
    publishedAt: null,
    resultsMessageId: null,
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
    eligibilityReason: 'Подписка на обязательный канал не подтверждена.',
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
    claimDeadlineAt: new Date('2026-03-23T12:00:00.000Z'),
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

describe('ManagedGiveawayService', () => {
  const user = {
    userId: 'user-1',
    username: 'tester',
    displayName: 'Тестер',
  };

  afterEach(() => {
    jest.useRealTimers();
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
      'Текст публикации',
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Участвовать · 1' })]],
      }),
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
          eligibilityReason: 'Подписка на обязательные каналы не подтверждена.',
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
      expect.stringContaining('<a href="max://user/winner-1">CEO</a>'),
      expect.objectContaining({
        textFormat: 'html',
        messageLink: {
          type: 'reply',
          mid: 'publication-1',
        },
        buttons: [[expect.objectContaining({ text: 'Проверить результаты' })]],
      }),
    );
    expect(prisma.managedGiveaway.update).toHaveBeenCalledWith({
      where: { id: 'giveaway-1' },
      data: {
        resultsMessageId: 'results-1',
        resultsUrl: 'https://max.ru/channels/source-1/messages/results-1',
      },
    });
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

    expect(selectedText).toContain('1. [CEO](max://user/winner-1)');
    expect(confirmedText).toContain('1. [CEO](max://user/winner-1)');
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
        winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
      }),
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'source-1',
      'results-1',
      expect.stringContaining('<a href="max://user/winner-1">CEO</a>'),
      expect.objectContaining({
        textFormat: 'html',
        messageLink: {
          type: 'reply',
          mid: 'publication-1',
        },
      }),
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
            status: ManagedGiveawayWinnerStatus.CLAIMED,
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
          [
            expect.objectContaining({ text: 'Открыть пост' }),
            expect.objectContaining({ text: 'Итоги' }),
          ],
        ],
      }),
    );
  });
});
