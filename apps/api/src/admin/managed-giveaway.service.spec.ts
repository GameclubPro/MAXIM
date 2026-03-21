import { ChatEntityType, GiveawayEligibilityState, ManagedGiveawayStatus } from '@prisma/client';
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
});
