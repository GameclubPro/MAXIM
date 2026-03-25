import { channelSettingsSchema, chatRulesSchema, chatSettingsSchema } from '@maxim/contracts';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AdminService } from './admin.service';

function createPrismaMock() {
  const defaultManagedPoll = {
    id: 'poll-1',
    chatId: 'chat-1',
    question: '',
    options: ['', ''],
    status: 'DRAFT',
    activeVersion: 0,
    publishedMessageId: null,
    publishedUrl: null,
    publishedAt: null,
    closedAt: null,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
  };
  const defaultManagedBroadcast = {
    id: 'broadcast-1',
    sourceChatId: 'chat-1',
    entityType: 'CHAT',
    actorUserId: 'admin-1',
    text: '',
    textFormat: 'plain',
    applyToAllChats: false,
    targetChatIds: ['chat-1'],
    buttonEnabled: false,
    buttonUrl: '',
    buttonText: 'Открыть',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    scheduleMode: 'legacy',
    scheduleTimezone: 'Europe/Moscow',
    nextSendAt: null,
    cycleEnabled: false,
    cycleEveryHours: 1,
    cycleCount: 1,
    sentCount: 0,
    status: 'ACTIVE',
    lastError: null,
    lockedAt: null,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
  };
  let managedBroadcastState: Record<string, unknown> | null = { ...defaultManagedBroadcast };
  const prisma = {
    chat: {
      upsert: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'CHAT',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      update: jest.fn().mockResolvedValue(undefined),
      findUnique: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'CHAT',
      }),
    },
    channelSettings: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        autoPostButtonsMode: 'OFF',
        postSuggestionsEnabled: false,
        postSuggestionsButtonText: 'Предложить пост',
        commentsEnabled: true,
        engagementPublishedMessageId: null,
        engagementPublishedThreadId: null,
        engagementPublishedAt: null,
      }),
      update: jest.fn().mockResolvedValue(undefined),
    },
    chatSettings: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        commentsEnabled: false,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      }),
      update: jest.fn().mockResolvedValue(undefined),
    },
    chatAdminAllowlist: {
      upsert: jest.fn().mockResolvedValue(undefined),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    adminGlobalSpammerExemption: {
      upsert: jest.fn().mockResolvedValue(undefined),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    domainAllowlist: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue(undefined),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    },
    managedBroadcast: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockImplementation(async () => managedBroadcastState),
      findUnique: jest.fn().mockImplementation(async () => managedBroadcastState),
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        managedBroadcastState = {
          ...defaultManagedBroadcast,
          ...data,
        };
        return managedBroadcastState;
      }),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        managedBroadcastState = {
          ...managedBroadcastState,
          ...data,
        };
        return managedBroadcastState;
      }),
      delete: jest.fn().mockImplementation(async () => {
        const deleted = managedBroadcastState;
        managedBroadcastState = null;
        return deleted;
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    managedBroadcastDelivery: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    managedBroadcastOccurrence: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    channelAudienceSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(undefined),
    },
    channelPost: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'post-1' }),
    },
    channelPostViewSnapshot: {
      create: jest.fn().mockResolvedValue(undefined),
    },
    chatRules: {
      upsert: jest.fn().mockResolvedValue({
        id: 'rules-1',
        chatId: 'chat-1',
        text: '',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: false,
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(undefined),
    },
    managedPoll: {
      upsert: jest.fn().mockResolvedValue(defaultManagedPoll),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...defaultManagedPoll,
        ...data,
      })),
      findUnique: jest.fn().mockResolvedValue(defaultManagedPoll),
    },
    managedPollVote: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    channelStatsSyncState: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    moderationEvent: {
      create: jest.fn().mockResolvedValue(undefined),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(),
  };

  prisma.$transaction = jest.fn(
    (
      input:
        | unknown[]
        | ((tx: typeof prisma) => Promise<unknown> | unknown),
    ) => {
      if (typeof input === 'function') {
        return Promise.resolve(input(prisma));
      }

      return Promise.all(input as Promise<unknown>[]);
    },
  );

  return prisma;
}

type ManagedBroadcastDeliveryRow = {
  id: string;
  broadcastId: string;
  occurrenceIndex: number;
  targetChatId: string;
  status: string;
  attemptCount: number;
  remoteMessageId: string | null;
  lastError: string | null;
  sentAt: Date | null;
  lockedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function wireManagedBroadcastDeliveryStore(prisma: ReturnType<typeof createPrismaMock>) {
  const deliveries: ManagedBroadcastDeliveryRow[] = [];

  function matchesWhere(
    delivery: ManagedBroadcastDeliveryRow,
    where: Record<string, unknown> | undefined,
  ): boolean {
    if (!where) {
      return true;
    }
    if (typeof where.broadcastId === 'string' && delivery.broadcastId !== where.broadcastId) {
      return false;
    }
    if (
      typeof where.occurrenceIndex === 'number' &&
      delivery.occurrenceIndex !== where.occurrenceIndex
    ) {
      return false;
    }
    if (
      where.occurrenceIndex &&
      typeof where.occurrenceIndex === 'object' &&
      'gte' in where.occurrenceIndex &&
      delivery.occurrenceIndex < Number((where.occurrenceIndex as { gte: number }).gte)
    ) {
      return false;
    }
    if (typeof where.id === 'string' && delivery.id !== where.id) {
      return false;
    }
    if (where.status && typeof where.status === 'string' && delivery.status !== where.status) {
      return false;
    }
    if (where.status && typeof where.status === 'object') {
      const statusFilter = where.status as { in?: string[]; not?: string };
      if (Array.isArray(statusFilter.in) && !statusFilter.in.includes(delivery.status)) {
        return false;
      }
      if (typeof statusFilter.not === 'string' && delivery.status === statusFilter.not) {
        return false;
      }
    }
    if (
      where.lockedAt &&
      typeof where.lockedAt === 'object' &&
      'lt' in where.lockedAt &&
      !(delivery.lockedAt && delivery.lockedAt < (where.lockedAt as { lt: Date }).lt)
    ) {
      return false;
    }
    if ('remoteMessageId' in where) {
      if (where.remoteMessageId === null && delivery.remoteMessageId !== null) {
        return false;
      }
      if (
        typeof where.remoteMessageId === 'string' &&
        delivery.remoteMessageId !== where.remoteMessageId
      ) {
        return false;
      }
      if (where.remoteMessageId && typeof where.remoteMessageId === 'object') {
        const remoteMessageIdFilter = where.remoteMessageId as { not?: string | null };
        if (
          'not' in remoteMessageIdFilter &&
          delivery.remoteMessageId === remoteMessageIdFilter.not
        ) {
          return false;
        }
      }
    }
    return true;
  }

  prisma.managedBroadcastDelivery.createMany.mockImplementation(
    async ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const row of data) {
        deliveries.push({
          id: `delivery-${deliveries.length + 1}`,
          broadcastId: String(row.broadcastId),
          occurrenceIndex: Number(row.occurrenceIndex),
          targetChatId: String(row.targetChatId),
          status: String(row.status ?? 'PENDING'),
          attemptCount: 0,
          remoteMessageId: null,
          lastError: null,
          sentAt: null,
          lockedAt: null,
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
          updatedAt: new Date('2026-03-01T00:00:00.000Z'),
        });
      }
      return { count: data.length };
    },
  );
  prisma.managedBroadcastDelivery.findMany.mockImplementation(
    async ({ where }: { where?: Record<string, unknown> }) =>
      deliveries.filter((delivery) => matchesWhere(delivery, where)),
  );
  prisma.managedBroadcastDelivery.count.mockImplementation(
    async ({ where }: { where?: Record<string, unknown> }) =>
      deliveries.filter((delivery) => matchesWhere(delivery, where)).length,
  );
  prisma.managedBroadcastDelivery.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const delivery = deliveries.find((item) => item.id === where.id);
      if (!delivery) {
        return undefined;
      }
      if (typeof data.status === 'string') {
        delivery.status = data.status;
      }
      if ('lockedAt' in data) {
        delivery.lockedAt = (data.lockedAt as Date | null) ?? null;
      }
      if ('lastError' in data) {
        delivery.lastError = (data.lastError as string | null) ?? null;
      }
      if ('remoteMessageId' in data) {
        delivery.remoteMessageId = (data.remoteMessageId as string | null) ?? null;
      }
      if ('sentAt' in data) {
        delivery.sentAt = (data.sentAt as Date | null) ?? null;
      }
      delivery.updatedAt = new Date('2026-03-01T00:00:00.000Z');
      return delivery;
    },
  );
  prisma.managedBroadcastDelivery.updateMany.mockImplementation(
    async ({ where, data }: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const delivery of deliveries) {
        if (!matchesWhere(delivery, where)) {
          continue;
        }
        count += 1;
        if (typeof data.status === 'string') {
          delivery.status = data.status;
        }
        if ('lockedAt' in data) {
          delivery.lockedAt = (data.lockedAt as Date | null) ?? null;
        }
        if ('lastError' in data) {
          delivery.lastError = (data.lastError as string | null) ?? null;
        }
        if ('remoteMessageId' in data) {
          delivery.remoteMessageId = (data.remoteMessageId as string | null) ?? null;
        }
        if ('sentAt' in data) {
          delivery.sentAt = (data.sentAt as Date | null) ?? null;
        }
        if (
          data.attemptCount &&
          typeof data.attemptCount === 'object' &&
          'increment' in data.attemptCount
        ) {
          delivery.attemptCount += Number((data.attemptCount as { increment: number }).increment);
        }
        delivery.updatedAt = new Date('2026-03-01T00:00:00.000Z');
      }
      return { count };
    },
  );
  prisma.managedBroadcastDelivery.deleteMany.mockImplementation(
    async ({ where }: { where?: Record<string, unknown> }) => {
      const before = deliveries.length;
      const remaining = deliveries.filter((delivery) => !matchesWhere(delivery, where));
      deliveries.splice(0, deliveries.length, ...remaining);
      return { count: before - deliveries.length };
    },
  );

  return deliveries;
}

type ManagedBroadcastOccurrenceRow = {
  id: string;
  broadcastId: string;
  sourceChatId: string;
  entityType: 'CHAT' | 'CHANNEL';
  occurrenceIndex: number;
  scheduledAt: Date;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

function wireManagedBroadcastOccurrenceStore(
  prisma: ReturnType<typeof createPrismaMock>,
  initialRows: ManagedBroadcastOccurrenceRow[] = [],
) {
  const occurrences = [...initialRows];

  function matchesWhere(
    occurrence: ManagedBroadcastOccurrenceRow,
    where: Record<string, unknown> | undefined,
  ): boolean {
    if (!where) {
      return true;
    }

    if (
      typeof where.sourceChatId === 'string' &&
      occurrence.sourceChatId !== where.sourceChatId
    ) {
      return false;
    }
    if (typeof where.entityType === 'string' && occurrence.entityType !== where.entityType) {
      return false;
    }
    if (typeof where.broadcastId === 'string' && occurrence.broadcastId !== where.broadcastId) {
      return false;
    }
    if (where.broadcastId && typeof where.broadcastId === 'object') {
      const broadcastFilter = where.broadcastId as { in?: string[]; not?: string };
      if (Array.isArray(broadcastFilter.in) && !broadcastFilter.in.includes(occurrence.broadcastId)) {
        return false;
      }
      if (typeof broadcastFilter.not === 'string' && occurrence.broadcastId === broadcastFilter.not) {
        return false;
      }
    }
    if (
      typeof where.occurrenceIndex === 'number' &&
      occurrence.occurrenceIndex !== where.occurrenceIndex
    ) {
      return false;
    }
    if (
      where.occurrenceIndex &&
      typeof where.occurrenceIndex === 'object' &&
      'gte' in where.occurrenceIndex &&
      occurrence.occurrenceIndex < Number((where.occurrenceIndex as { gte: number }).gte)
    ) {
      return false;
    }
    if (where.scheduledAt && typeof where.scheduledAt === 'object') {
      const scheduledAtFilter = where.scheduledAt as { in?: Date[] };
      if (
        Array.isArray(scheduledAtFilter.in) &&
        !scheduledAtFilter.in.some((value) => value.getTime() === occurrence.scheduledAt.getTime())
      ) {
        return false;
      }
    }

    return true;
  }

  prisma.managedBroadcastOccurrence.findMany.mockImplementation(
    async ({
      where,
      orderBy,
    }: {
      where?: Record<string, unknown>;
      orderBy?: Array<Record<string, 'asc' | 'desc'>>;
    } = {}) => {
      const filtered = occurrences.filter((occurrence) => matchesWhere(occurrence, where));
      if (!Array.isArray(orderBy) || orderBy.length === 0) {
        return filtered;
      }

      return [...filtered].sort((left, right) => {
        for (const item of orderBy) {
          const [key, direction] = Object.entries(item)[0] ?? [];
          if (!key || !direction) {
            continue;
          }

          const leftValue = left[key as keyof ManagedBroadcastOccurrenceRow];
          const rightValue = right[key as keyof ManagedBroadcastOccurrenceRow];
          const leftComparable = leftValue instanceof Date ? leftValue.getTime() : leftValue;
          const rightComparable = rightValue instanceof Date ? rightValue.getTime() : rightValue;

          if (leftComparable === rightComparable) {
            continue;
          }

          const comparison = leftComparable < rightComparable ? -1 : 1;
          return direction === 'desc' ? comparison * -1 : comparison;
        }

        return 0;
      });
    },
  );
  prisma.managedBroadcastOccurrence.findUnique.mockImplementation(
    async ({
      where,
    }: {
      where: { broadcastId_occurrenceIndex: { broadcastId: string; occurrenceIndex: number } };
    }) =>
      occurrences.find(
        (occurrence) =>
          occurrence.broadcastId === where.broadcastId_occurrenceIndex.broadcastId &&
          occurrence.occurrenceIndex === where.broadcastId_occurrenceIndex.occurrenceIndex,
      ) ?? null,
  );
  prisma.managedBroadcastOccurrence.createMany.mockImplementation(
    async ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const row of data) {
        occurrences.push({
          id: `occurrence-${occurrences.length + 1}`,
          broadcastId: String(row.broadcastId),
          sourceChatId: String(row.sourceChatId),
          entityType: String(row.entityType) as 'CHAT' | 'CHANNEL',
          occurrenceIndex: Number(row.occurrenceIndex),
          scheduledAt: row.scheduledAt as Date,
          status: String(row.status ?? 'ACTIVE'),
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
          updatedAt: new Date('2026-03-01T00:00:00.000Z'),
        });
      }

      return { count: data.length };
    },
  );
  prisma.managedBroadcastOccurrence.deleteMany.mockImplementation(
    async ({ where }: { where?: Record<string, unknown> }) => {
      const before = occurrences.length;
      const remaining = occurrences.filter((occurrence) => !matchesWhere(occurrence, where));
      occurrences.splice(0, occurrences.length, ...remaining);
      return { count: before - occurrences.length };
    },
  );
  prisma.managedBroadcastOccurrence.updateMany.mockImplementation(
    async ({ where, data }: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const occurrence of occurrences) {
        if (!matchesWhere(occurrence, where)) {
          continue;
        }

        count += 1;
        if (typeof data.status === 'string') {
          occurrence.status = data.status;
        }
        occurrence.updatedAt = new Date('2026-03-01T00:00:00.000Z');
      }

      return { count };
    },
  );

  return occurrences;
}

function extractSqlText(arg: unknown): string {
  if (Array.isArray(arg)) {
    return arg.map((part) => String(part)).join(' ');
  }

  if (arg && typeof arg === 'object' && 'strings' in arg) {
    const strings = (arg as { strings?: unknown }).strings;
    if (Array.isArray(strings)) {
      return strings.map((part) => String(part)).join(' ');
    }
  }

  return String(arg);
}

function createConfigMock() {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'MAX_BOT_TOKEN') {
        return 'test-max-bot-token';
      }
      throw new Error(`Missing key: ${key}`);
    }),
    get: jest.fn((key: string) => {
      if (key === 'APP_BASE_URL') {
        return 'https://maxim.play-team.ru';
      }
      if (key === 'MAX_BOT_ID') {
        return '777000_bot';
      }
      if (key === 'MAX_BOT_CONTACT_ID') {
        return '777000';
      }
      return null;
    }),
  };
}

function createChatContextCacheMock(overrides: Record<string, unknown> = {}) {
  return {
    invalidate: jest.fn().mockResolvedValue(undefined),
    getAdminAccess: jest.fn().mockResolvedValue(null),
    setAdminAccess: jest.fn().mockResolvedValue(undefined),
    getManagedEntityHeader: jest.fn().mockResolvedValue(null),
    setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
    invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
    isManagedEntitiesRefreshCooldownActive: jest.fn().mockResolvedValue(false),
    activateManagedEntitiesRefreshCooldown: jest.fn().mockResolvedValue(undefined),
    isManagedEntitiesRefreshBackoffActive: jest.fn().mockResolvedValue(false),
    activateManagedEntitiesRefreshBackoff: jest.fn().mockResolvedValue(undefined),
    getManagedEntitiesRefreshCursor: jest.fn().mockResolvedValue(null),
    setManagedEntitiesRefreshCursor: jest.fn().mockResolvedValue(undefined),
    clearManagedEntitiesRefreshCursor: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function decodeBase64UrlJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
}

async function publishCommentsDialogToken(
  service: AdminService,
  maxClient: { sendMessageImmediateWithResolvedLink: jest.Mock },
) {
  await service.publishChannelEngagementMessage(
    'channel-1',
    {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    },
    {
      text: 'Нажмите кнопку ниже.',
      commentsButtonText: 'Комментарии',
      suggestButtonText: 'Предложить пост',
    },
  );

  const [, , options] = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0] ?? [];
  const commentsButton = options.buttons?.[0]?.[0];
  const commentsStartParam = new URL(commentsButton.url).searchParams.get('startapp');
  const commentsLaunch = decodeBase64UrlJson<{ t: string }>(commentsStartParam!.slice(3));
  return commentsLaunch.t;
}

async function publishSuggestDialogToken(
  service: AdminService,
  maxClient: { sendMessageImmediateWithResolvedLink: jest.Mock },
) {
  await service.publishChannelEngagementMessage(
    'channel-1',
    {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    },
    {
      text: 'Нажмите кнопку ниже.',
      commentsButtonText: 'Комментарии',
      suggestButtonText: 'Предложить пост',
      includeCommentsButton: false,
      includeSuggestButton: true,
    },
  );

  const [, , options] = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0] ?? [];
  const suggestButton = options.buttons?.[0]?.[0];
  const suggestStartParam = new URL(suggestButton.url).searchParams.get('start');
  const parsed = service.parseChannelSuggestionStartPayload(suggestStartParam);
  return parsed?.token ?? '';
}

describe('AdminService getMe', () => {
  it('returns init data profile when username is already present', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatMemberProfiles: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.getMe({
        userId: 'admin-1',
        username: 'designer',
        displayName: 'Designer',
        avatarUrl: 'https://cdn.max/avatar.png',
        chatId: 'chat-1',
      }),
    ).resolves.toEqual({
      userId: 'admin-1',
      username: 'designer',
      displayName: 'Designer',
      avatarUrl: 'https://cdn.max/avatar.png',
      profileUrl: 'https://max.ru/designer',
    });
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
  });

  it('enriches current admin profile from MAX member data when init data misses username', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'admin-1',
            {
              userId: 'admin-1',
              username: 'designer',
              displayName: 'Designer Max',
              avatarUrl: 'https://cdn.max/designer.png',
            },
          ],
        ]),
      ),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.getMe(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          avatarUrl: null,
        },
        { chatId: 'chat-1' },
      ),
    ).resolves.toEqual({
      userId: 'admin-1',
      username: 'designer',
      displayName: 'Designer Max',
      avatarUrl: 'https://cdn.max/designer.png',
      profileUrl: 'https://max.ru/designer',
    });
    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith('chat-1', ['admin-1'], {
      trafficClass: 'interactive',
    });
  });

  it('keeps direct MAX profile url when init data already has it without username', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatMemberProfiles: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.getMe({
        userId: 'admin-1',
        username: null,
        displayName: 'Designer',
        avatarUrl: 'https://cdn.max/avatar.png',
        profileUrl: 'https://max.ru/designer-direct',
      }),
    ).resolves.toEqual({
      userId: 'admin-1',
      username: null,
      displayName: 'Designer',
      avatarUrl: 'https://cdn.max/avatar.png',
      profileUrl: 'https://max.ru/designer-direct',
    });
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
  });

  it('keeps profile url empty when username is unavailable', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'admin-1',
            {
              userId: 'admin-1',
              username: null,
              displayName: 'Designer Max',
              avatarUrl: 'https://cdn.max/designer.png',
            },
          ],
        ]),
      ),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.getMe(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          avatarUrl: null,
        },
        { chatId: 'chat-1', entityType: 'chat' },
      ),
    ).resolves.toEqual({
      userId: 'admin-1',
      username: null,
      displayName: 'Designer Max',
      avatarUrl: 'https://cdn.max/designer.png',
      profileUrl: null,
    });
    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith('chat-1', ['admin-1'], {
      trafficClass: 'interactive',
    });
  });

  it('returns direct MAX profile url from member data when username is unavailable', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'admin-1',
            {
              userId: 'admin-1',
              username: null,
              displayName: 'Designer Max',
              avatarUrl: 'https://cdn.max/designer.png',
              profileUrl: 'https://max.ru/designer-direct',
            },
          ],
        ]),
      ),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.getMe(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          avatarUrl: null,
        },
        { chatId: 'chat-1', entityType: 'chat' },
      ),
    ).resolves.toEqual({
      userId: 'admin-1',
      username: null,
      displayName: 'Designer Max',
      avatarUrl: 'https://cdn.max/designer.png',
      profileUrl: 'https://max.ru/designer-direct',
    });
    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith('chat-1', ['admin-1'], {
      trafficClass: 'interactive',
    });
  });
});

describe('AdminService night mode settings normalization', () => {
  it('forces night bot message toggles off when night mode is disabled on update', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.updateSettings(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        nightModeEnabled: false,
        nightModeBotMessageEnabled: true,
        nightModeCommentsEnabled: true,
        nightModeBotButtonEnabled: true,
        nightModeBotButtonUrl: 'https://max.ru/channel/rules',
        nightModeBotButtonText: 'Правила',
        nightModeRulesButtonEnabled: true,
      },
    );

    expect(result.nightModeEnabled).toBe(false);
    expect(result.nightModeBotMessageEnabled).toBe(false);
    expect(result.nightModeCommentsEnabled).toBe(false);
    expect(result.nightModeBotButtonEnabled).toBe(false);
    expect(result.nightModeRulesButtonEnabled).toBe(false);
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          settings: {
            upsert: {
              update: expect.objectContaining({
                nightModeEnabled: false,
                nightModeBotMessageEnabled: false,
                nightModeCommentsEnabled: false,
                nightModeBotButtonEnabled: false,
                nightModeRulesButtonEnabled: false,
              }),
              create: expect.objectContaining({
                nightModeEnabled: false,
                nightModeBotMessageEnabled: false,
                nightModeCommentsEnabled: false,
                nightModeBotButtonEnabled: false,
                nightModeRulesButtonEnabled: false,
              }),
            },
          },
        },
      }),
    );
  });

  it('rejects legacy profile handoff button urls on update', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.updateSettings(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          greetingEnabled: true,
          greetingBotMessageEnabled: true,
          greetingBotButtonEnabled: true,
          greetingBotButtonUrl: 'https://max.ru/777000_bot?start=pmh-legacy',
          greetingBotButtonText: 'Профиль',
        },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        greetingBotButtonUrl: expect.objectContaining({
          _errors: expect.arrayContaining(['Укажите корректную ссылку для кнопки (http/https).']),
        }),
      }),
    });
    expect(prisma.chatSettings.findUnique).not.toHaveBeenCalled();
  });

  it('rejects max user deeplinks in new button urls on update', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.updateSettings(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          greetingEnabled: true,
          greetingBotMessageEnabled: true,
          greetingBotButtonEnabled: true,
          greetingBotButtonUrl: 'max://user/user-42',
          greetingBotButtonText: 'Профиль',
        },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        greetingBotButtonUrl: expect.objectContaining({
          _errors: expect.arrayContaining(['Укажите корректную ссылку для кнопки (http/https).']),
        }),
      }),
    });
    expect(prisma.chatSettings.findUnique).not.toHaveBeenCalled();
  });

  it('drops legacy profile handoff button urls from stored settings', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      settings: {
        greetingEnabled: true,
        greetingBotMessageEnabled: true,
        greetingBotButtonEnabled: true,
        greetingBotButtonUrl: 'https://max.ru/777000_bot?start=pmh-legacy',
        greetingBotButtonText: 'Профиль',
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getSettings('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.greetingBotButtonEnabled).toBe(false);
    expect(result.greetingBotButtonUrl).toBe('');
    expect(prisma.chatSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId: 'chat-1' },
        data: expect.objectContaining({
          greetingBotButtonEnabled: false,
          greetingBotButtonUrl: '',
        }),
      }),
    );
  });

  it('drops legacy max user button urls from stored settings', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      settings: {
        greetingEnabled: true,
        greetingBotMessageEnabled: true,
        greetingBotButtonEnabled: true,
        greetingBotButtonUrl: 'max://user/user-42',
        greetingBotButtonText: 'Профиль',
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getSettings('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.greetingBotButtonEnabled).toBe(false);
    expect(result.greetingBotButtonUrl).toBe('');
    expect(prisma.chatSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId: 'chat-1' },
        data: expect.objectContaining({
          greetingBotButtonEnabled: false,
          greetingBotButtonUrl: '',
        }),
      }),
    );
  });

  it('normalizes stale night bot message toggles from stored settings', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      settings: {
        nightModeEnabled: false,
        nightModeBotMessageEnabled: true,
        nightModeCommentsEnabled: true,
        nightModeBotButtonEnabled: true,
        nightModeBotButtonUrl: 'https://max.ru/channel/rules',
        nightModeBotButtonText: 'Правила',
        nightModeRulesButtonEnabled: true,
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getSettings('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.nightModeEnabled).toBe(false);
    expect(result.nightModeBotMessageEnabled).toBe(false);
    expect(result.nightModeCommentsEnabled).toBe(false);
    expect(result.nightModeBotButtonEnabled).toBe(false);
    expect(result.nightModeRulesButtonEnabled).toBe(false);
    expect(prisma.chatSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId: 'chat-1' },
        data: {
          nightModeBotMessageEnabled: false,
          nightModeCommentsEnabled: false,
          nightModeBotButtonEnabled: false,
          nightModeRulesButtonEnabled: false,
        },
      }),
    );
  });

  it('starts manual close timer when timed close is enabled on update', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const before = Date.now();
    const result = await service.updateSettings(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseDays: 1,
        nightModeForceCloseHours: 2,
      },
    );
    const after = Date.now();

    expect(result.nightModeForceCloseEnabled).toBe(true);
    expect(result.nightModeForceCloseForever).toBe(false);
    expect(result.nightModeForceCloseUntil).not.toBe('');

    const closeUntil = Date.parse(result.nightModeForceCloseUntil);
    expect(closeUntil).toBeGreaterThanOrEqual(before + 26 * 60 * 60 * 1_000);
    expect(closeUntil).toBeLessThanOrEqual(after + 26 * 60 * 60 * 1_000);
  });

  it('disables expired timed manual close while reading settings', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      settings: {
        ...chatSettingsSchema.parse({}),
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseHours: 4,
        nightModeForceCloseDays: 0,
        nightModeForceCloseUntil: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getSettings('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.nightModeForceCloseEnabled).toBe(false);
    expect(result.nightModeForceCloseUntil).toBe('');
    expect(prisma.chatSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId: 'chat-1' },
        data: expect.objectContaining({
          nightModeForceCloseEnabled: false,
          nightModeForceCloseUntil: '',
        }),
      }),
    );
  });
});

describe('AdminService required subscription settings', () => {
  const actor = {
    userId: 'admin-1',
    username: null,
    displayName: null,
    chatTitle: null,
  };

  it('normalizes and persists required subscription channel ids on update', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 125,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/news',
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const result = await service.updateSettings('chat-1', actor, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: [' channel-1 ', 'channel-1'],
      requiredSubscriptionBotMessageEnabled: true,
      requiredSubscriptionBotMessageText: 'Проверьте подписку.',
      requiredSubscriptionWarnEnabled: true,
      requiredSubscriptionWarnMessageText: 'Сначала подпишитесь на канал.',
      requiredSubscriptionBanEnabled: true,
    });

    expect(result.requiredSubscriptionChannelIds).toEqual(['channel-1']);
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          settings: {
            upsert: {
              update: expect.objectContaining({
                requiredSubscriptionEnabled: true,
                requiredSubscriptionChannelIds: ['channel-1'],
                requiredSubscriptionBotMessageEnabled: true,
                requiredSubscriptionBotMessageText: 'Проверьте подписку.',
                requiredSubscriptionWarnEnabled: true,
                requiredSubscriptionWarnMessageText: 'Сначала подпишитесь на канал.',
                requiredSubscriptionBanEnabled: true,
              }),
              create: expect.objectContaining({
                requiredSubscriptionEnabled: true,
                requiredSubscriptionChannelIds: ['channel-1'],
                requiredSubscriptionBotMessageEnabled: true,
                requiredSubscriptionBotMessageText: 'Проверьте подписку.',
                requiredSubscriptionWarnEnabled: true,
                requiredSubscriptionWarnMessageText: 'Сначала подпишитесь на канал.',
                requiredSubscriptionBanEnabled: true,
              }),
            },
          },
        },
      }),
    );
  });

  it('resolves an external required subscription channel by public link when the bot is admin there', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return ['admin-1'];
        }
        if (chatId === 'channel-ext-1') {
          return ['partner-owner'];
        }
        return [];
      }),
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'channel-ext-1',
          title: 'Партнерские новости',
          lastEventTime: 1,
          entityType: 'channel',
          link: 'https://max.ru/channels/partner-news',
        },
      ]),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-1',
        title: 'Партнерские новости',
        participantsCount: 318,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/partner-news',
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.resolveRequiredSubscriptionChannel('chat-1', actor, {
      value: 'max.ru/channels/partner-news',
    });

    expect(result).toEqual({
      channel: {
        id: 'channel-ext-1',
        title: 'Партнерские новости',
        entityType: 'channel',
        link: 'https://max.ru/channels/partner-news',
        participantsCount: 318,
      },
    });
    expect(maxClient.listBotChats).toHaveBeenCalledTimes(1);
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith({
      id: 'channel-ext-1',
      title: 'Партнерские новости',
      entityType: 'channel',
      link: 'https://max.ru/channels/partner-news',
      participantsCount: 318,
    });
  });

  it('accepts an external required subscription channel on update when the bot is admin there', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-1',
        title: 'Партнерские новости',
        participantsCount: 318,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/partner-news',
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.updateSettings('chat-1', actor, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-ext-1'],
    });

    expect(result.requiredSubscriptionChannelIds).toEqual(['channel-ext-1']);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-ext-1');
  });

  it('rejects an external required subscription channel when the bot is not its admin', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return ['admin-1'];
        }

        throw {
          response: {
            status: 403,
            data: {
              message: 'Method is available only for chat administrator',
            },
          },
          message: 'Method is available only for chat administrator',
        };
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-1',
        title: 'Партнерские новости',
        participantsCount: 318,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/partner-news',
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.updateSettings('chat-1', actor, {
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-ext-1'],
      }),
    ).rejects.toMatchObject({
      response: {
        requiredSubscriptionChannelIds: {
          _errors: [
            'Для обязательной подписки нужны каналы с публичной ссылкой. Для внешнего канала бот должен быть его администратором.',
          ],
        },
      },
    });
  });

  it('rejects enabled required subscription without channels', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    let thrown: unknown;
    try {
      await service.updateSettings('chat-1', actor, {
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: [],
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({
      requiredSubscriptionChannelIds: {
        _errors: ['Выберите хотя бы один канал для обязательной подписки.'],
      },
    });
  });

  it('rejects required subscription channels without a working link', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 125,
        status: 'active',
        isPublic: false,
        link: null,
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    let thrown: unknown;
    try {
      await service.updateSettings('chat-1', actor, {
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({
      requiredSubscriptionChannelIds: {
        _errors: [
          'Для обязательной подписки нужны каналы с публичной ссылкой. Для внешнего канала бот должен быть его администратором.',
        ],
      },
    });
  });

  it('applies the required subscription section to every cached chat', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-2',
      title: 'Клуб соседей',
      entityType: 'CHAT',
      createdAt: new Date('2026-03-02T00:00:00.000Z'),
    });
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-2',
          title: 'Клуб соседей',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 125,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/news',
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'getSettings').mockResolvedValue(
      chatSettingsSchema.parse({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionBotMessageEnabled: true,
        requiredSubscriptionBotMessageText: 'Следите за подпиской.',
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionWarnMessageText: 'Сначала подпишитесь.',
        requiredSubscriptionBanEnabled: true,
        deleteSpammersEnabled: true,
      }),
    );

    const result = await service.applySettingsSectionToAllChats('chat-1', actor, {
      section: 'requiredSubscription',
    });

    expect(result.section).toBe('requiredSubscription');
    expect(result.updatedChats).toBe(2);
    expect(result.appliedChatIds).toEqual(['chat-1', 'chat-2']);

    const chat2Call = prisma.chat.upsert.mock.calls.find(
      ([args]) => args?.where?.id === 'chat-2',
    )?.[0];
    expect(chat2Call).toBeDefined();
    expect(chat2Call?.create?.settings?.create).toEqual(
      expect.objectContaining({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionBotMessageEnabled: true,
        requiredSubscriptionBotMessageText: 'Следите за подпиской.',
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionWarnMessageText: 'Сначала подпишитесь.',
        requiredSubscriptionBanEnabled: true,
        deleteSpammersEnabled: false,
      }),
    );
    expect(chat2Call?.update?.settings?.upsert?.update).toEqual(
      expect.objectContaining({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionBotMessageEnabled: true,
        requiredSubscriptionBotMessageText: 'Следите за подпиской.',
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionWarnMessageText: 'Сначала подпишитесь.',
        requiredSubscriptionBanEnabled: true,
      }),
    );
    expect(chat2Call?.update?.settings?.upsert?.create).toEqual(
      expect.objectContaining({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionBotMessageEnabled: true,
        requiredSubscriptionBotMessageText: 'Следите за подпиской.',
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionWarnMessageText: 'Сначала подпишитесь.',
        requiredSubscriptionBanEnabled: true,
        deleteSpammersEnabled: false,
      }),
    );
  });
});

describe('AdminService managed polls', () => {
  it('publishes and closes a chat poll', async () => {
    const prisma = createPrismaMock();
    const draftPoll = {
      id: 'poll-chat-1',
      chatId: 'chat-1',
      question: 'Ваш любимый режим?',
      options: ['Соло', 'Сквад'],
      status: 'DRAFT',
      activeVersion: 0,
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      closedAt: null,
      createdAt: new Date('2026-03-10T09:00:00.000Z'),
      updatedAt: new Date('2026-03-10T09:00:00.000Z'),
    };
    const activePoll = {
      ...draftPoll,
      status: 'ACTIVE',
      activeVersion: 1,
      publishedMessageId: 'mid-poll-1',
      publishedUrl: 'https://max.ru/chats/chat-1/message/999',
      publishedAt: new Date('2026-03-10T09:05:00.000Z'),
    };
    const closedPoll = {
      ...activePoll,
      status: 'CLOSED',
      closedAt: new Date('2026-03-10T09:15:00.000Z'),
    };

    prisma.managedPoll.upsert.mockResolvedValueOnce(draftPoll).mockResolvedValueOnce(activePoll);
    prisma.managedPoll.update.mockResolvedValueOnce(activePoll).mockResolvedValueOnce(closedPoll);
    prisma.managedPollVote.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ optionIndex: 0 }, { optionIndex: 0 }, { optionIndex: 1 }])
      .mockResolvedValueOnce([{ optionIndex: 0 }, { optionIndex: 0 }, { optionIndex: 1 }]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-poll-1',
        url: 'https://max.ru/chats/chat-1/message/999',
      }),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      resolveMessageLink: jest.fn().mockResolvedValue(null),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const actor = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    const published = await service.publishChatPoll('chat-1', actor);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('Ваш любимый режим?'),
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: 'Соло (0)' })],
          [expect.objectContaining({ text: 'Сквад (0)' })],
        ],
      }),
    );
    expect(published.status).toBe('ACTIVE');
    expect(published.publishedMessageId).toBe('mid-poll-1');
    expect(published.totalVotes).toBe(0);

    const closed = await service.closeChatPoll('chat-1', actor);

    const closePollCall = (maxClient.editMessageInlineKeyboard as jest.Mock).mock.calls.at(-1);
    expect(closePollCall).toBeDefined();
    expect(closePollCall?.[0]).toBe('chat-1');
    expect(closePollCall?.[1]).toBe('mid-poll-1');
    expect(closePollCall?.[2]).toContain('Соло - 2 (67%)');
    expect(closePollCall?.[2]).not.toContain('Всего голосов:');
    expect(closePollCall?.[2]).not.toContain('Статус:');
    expect(closed.status).toBe('CLOSED');
    expect(closed.totalVotes).toBe(3);
    expect(closed.optionResults).toEqual([
      expect.objectContaining({ option: 'Соло', votes: 2, percent: 67 }),
      expect.objectContaining({ option: 'Сквад', votes: 1, percent: 33 }),
    ]);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        action: 'PUBLISH_MANAGED_POLL',
      }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        action: 'CLOSE_MANAGED_POLL',
      }),
    });
  });

  it('resets a closed channel poll back to draft when content changes', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Канал MAX',
      entityType: 'CHANNEL',
    });
    prisma.managedPoll.upsert.mockResolvedValue({
      id: 'poll-channel-1',
      chatId: 'channel-1',
      question: 'Старый вопрос',
      options: ['Да', 'Нет'],
      status: 'CLOSED',
      activeVersion: 3,
      publishedMessageId: 'mid-old-poll',
      publishedUrl: 'https://max.ru/chats/channel-1/message/1',
      publishedAt: new Date('2026-03-10T08:00:00.000Z'),
      closedAt: new Date('2026-03-10T08:05:00.000Z'),
      createdAt: new Date('2026-03-10T08:00:00.000Z'),
      updatedAt: new Date('2026-03-10T08:05:00.000Z'),
    });
    prisma.managedPoll.update.mockResolvedValue({
      id: 'poll-channel-1',
      chatId: 'channel-1',
      question: 'Новый вопрос',
      options: ['Первый', 'Второй'],
      status: 'DRAFT',
      activeVersion: 3,
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      closedAt: null,
      createdAt: new Date('2026-03-10T08:00:00.000Z'),
      updatedAt: new Date('2026-03-10T08:10:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      listBotChats: jest.fn().mockResolvedValue([]),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.updateChannelPoll(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        question: ' Новый вопрос ',
        options: [' Первый ', ' Второй '],
      },
    );

    expect(result.status).toBe('DRAFT');
    expect(result.question).toBe('Новый вопрос');
    expect(result.options).toEqual(['Первый', 'Второй']);
    expect(result.publishedMessageId).toBeNull();
    expect(result.publishedUrl).toBeNull();
    expect(prisma.managedPoll.update).toHaveBeenCalledWith({
      where: { chatId: 'channel-1' },
      data: expect.objectContaining({
        question: 'Новый вопрос',
        options: ['Первый', 'Второй'],
        status: 'DRAFT',
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
        closedAt: null,
      }),
    });
  });
});

describe('AdminService.getLogsDashboard', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns membership and violations summary for selected chat', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ joined_users: '5', left_users: '2' }])
      .mockResolvedValueOnce([
        { user_id: 'user-1', sender_name: 'Алексей' },
        { user_id: 'user-2', sender_name: 'Мария' },
      ])
      .mockResolvedValueOnce([
        {
          id: 'wh-3',
          created_at: new Date('2026-03-02T10:00:00.000Z'),
          event_type: 'user_added',
          user_id: 'user-3',
          sender_name: 'Ирина',
        },
        {
          id: 'wh-2',
          created_at: new Date('2026-03-02T09:30:00.000Z'),
          event_type: 'user_removed',
          user_id: 'user-2',
          sender_name: 'Мария',
        },
      ]);
    prisma.moderationEvent.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    prisma.moderationEvent.findMany
      .mockResolvedValueOnce([{ userId: 'user-1' }, { userId: 'user-2' }])
      .mockResolvedValueOnce([
        {
          id: 'evt-1',
          action: 'WARN',
          ruleCode: 'PROFANITY',
          userId: 'user-1',
          createdAt: new Date('2026-03-02T09:00:00.000Z'),
          maskedExcerpt: '***',
          metadata: { reason: 'Profanity detected' },
        },
        {
          id: 'evt-2',
          action: 'BAN',
          ruleCode: 'LINK_BLOCKED',
          userId: 'user-2',
          createdAt: new Date('2026-03-02T08:00:00.000Z'),
          maskedExcerpt: null,
          metadata: null,
        },
        {
          id: 'evt-3',
          action: 'NONE',
          ruleCode: 'MANUAL_UNBAN',
          userId: 'user-2',
          createdAt: new Date('2026-03-02T07:00:00.000Z'),
          maskedExcerpt: null,
          metadata: { reason: 'Ручной разбан участника через miniapp' },
        },
      ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-1',
            {
              userId: 'user-1',
              displayName: 'Алексей',
              username: 'aleksey',
              avatarUrl: 'https://cdn.max.ru/u/1/avatar-full.jpg',
            },
          ],
          [
            'user-2',
            {
              userId: 'user-2',
              displayName: 'Мария',
              username: 'maria',
              avatarUrl: 'https://cdn.max.ru/u/2/avatar-full.jpg',
            },
          ],
          [
            'user-3',
            {
              userId: 'user-3',
              displayName: 'Ирина',
              username: 'irina',
              avatarUrl: 'https://cdn.max.ru/u/3/avatar-full.jpg',
            },
          ],
        ]),
      ),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getLogsDashboard(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d' },
    );

    expect(result.chat).toEqual({ id: 'chat-1', title: 'Команда MAX' });
    expect(result.membership).toEqual({ joinedUsers: 5, leftUsers: 2, netUsers: 3 });
    expect(result.violationsSummary).toEqual({
      warn: 3,
      deleteMessage: 4,
      kick: 1,
      ban: 2,
      unban: 1,
      affectedUsers: 2,
      total: 11,
    });
    expect(result.violations).toHaveLength(3);
    expect(result.violations[0]?.userDisplayName).toBe('Алексей');
    expect(result.violations[0]?.avatarUrl).toBe('https://cdn.max.ru/u/1/avatar-full.jpg');
    expect(result.violations[0]?.profileUrl).toBe('https://max.ru/aleksey');
    expect(result.violations[0]?.profileHandoffUrl).toEqual(
      expect.stringContaining('https://max.ru/777000_bot?start=pmh-'),
    );
    expect(result.violations[1]?.userDisplayName).toBe('Мария');
    expect(result.violations[1]?.avatarUrl).toBe('https://cdn.max.ru/u/2/avatar-full.jpg');
    expect(result.violations[1]?.profileUrl).toBe('https://max.ru/maria');
    expect(result.violations[1]?.profileHandoffUrl).toEqual(
      expect.stringContaining('https://max.ru/777000_bot?start=pmh-'),
    );
    expect(result.violations[2]?.ruleCode).toBe('MANUAL_UNBAN');
    expect(result.activityFeed).toEqual({
      items: [
        {
          id: 'wh-3',
          type: 'joined',
          userId: 'user-3',
          userDisplayName: 'Ирина',
          avatarUrl: 'https://cdn.max.ru/u/3/avatar-full.jpg',
          profileUrl: 'https://max.ru/irina',
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pmh-'),
          createdAt: '2026-03-02T10:00:00.000Z',
        },
        {
          id: 'wh-2',
          type: 'left',
          userId: 'user-2',
          userDisplayName: 'Мария',
          avatarUrl: 'https://cdn.max.ru/u/2/avatar-full.jpg',
          profileUrl: 'https://max.ru/maria',
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pmh-'),
          createdAt: '2026-03-02T09:30:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    const membershipSqlText = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(membershipSqlText).toContain('user_added');
    expect(membershipSqlText).toContain('user_removed');
    expect(membershipSqlText).not.toContain('bot_added');
    const activitySqlText = extractSqlText(prisma.$queryRaw.mock.calls[2]?.[0]);
    expect(activitySqlText).toContain('ORDER BY created_at DESC, id DESC');

    expect(prisma.moderationEvent.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ chatId: 'chat-1' }) }),
    );
    expect(prisma.moderationEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ chatId: 'chat-1' }) }),
    );
  });

  it('uses 24h period boundaries when range=24h', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ joined_users: '0', left_users: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.moderationEvent.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    prisma.moderationEvent.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getLogsDashboard(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '24h' },
    );

    expect(result.period.range).toBe('24h');
    expect(result.period.from).toBe('2026-03-01T12:00:00.000Z');
    expect(result.period.to).toBe('2026-03-02T12:00:00.000Z');

    const countArgs = prisma.moderationEvent.count.mock.calls[0]?.[0];
    const createdAt = countArgs.where.createdAt;
    expect(createdAt.gte.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(createdAt.lte.toISOString()).toBe('2026-03-02T12:00:00.000Z');
  });
});

describe('AdminService.getChatActivityFeed', () => {
  it('respects filter, limit, cursor and falls back to resolved names', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'wh-left-2',
          created_at: new Date('2026-03-02T11:00:00.000Z'),
          event_type: 'user_removed',
          user_id: 'user-5',
          sender_name: null,
        },
        {
          id: 'wh-left-1',
          created_at: new Date('2026-03-02T10:00:00.000Z'),
          event_type: 'user_removed',
          user_id: 'user-4',
          sender_name: 'Мария',
        },
      ])
      .mockResolvedValueOnce([{ user_id: 'user-5', sender_name: 'Игорь' }])
      .mockResolvedValueOnce([
        {
          id: 'wh-left-1',
          created_at: new Date('2026-03-02T10:00:00.000Z'),
          event_type: 'user_removed',
          user_id: 'user-4',
          sender_name: 'Мария',
        },
      ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-4',
            {
              userId: 'user-4',
              displayName: 'Мария',
              username: 'maria',
              avatarUrl: 'https://cdn.max.ru/u/4/avatar-full.jpg',
            },
          ],
          [
            'user-5',
            {
              userId: 'user-5',
              displayName: 'Игорь',
              username: null,
              avatarUrl: 'https://cdn.max.ru/u/5/avatar-full.jpg',
            },
          ],
        ]),
      ),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const firstPage = await service.getChatActivityFeed(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d', filter: 'left', limit: 1 },
    );

    expect(firstPage.items).toEqual([
      {
        id: 'wh-left-2',
        type: 'left',
        userId: 'user-5',
        userDisplayName: 'Игорь',
        avatarUrl: 'https://cdn.max.ru/u/5/avatar-full.jpg',
        profileUrl: null,
        profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pmh-'),
        createdAt: '2026-03-02T11:00:00.000Z',
      },
    ]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await service.getChatActivityFeed(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d', filter: 'left', limit: 1, cursor: firstPage.nextCursor ?? undefined },
    );

    expect(secondPage).toEqual({
      items: [
        {
          id: 'wh-left-1',
          type: 'left',
          userId: 'user-4',
          userDisplayName: 'Мария',
          avatarUrl: 'https://cdn.max.ru/u/4/avatar-full.jpg',
          profileUrl: 'https://max.ru/maria',
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pmh-'),
          createdAt: '2026-03-02T10:00:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    const activitySqlText = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(activitySqlText).toContain('ORDER BY created_at DESC, id DESC');
  });
});

describe('AdminService.getChatModerationFeed', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('paginates filtered moderation events and preserves enriched user profiles', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.moderationEvent.findMany
      .mockResolvedValueOnce([
        {
          id: 'evt-ban-3',
          action: 'BAN',
          ruleCode: 'MANUAL_BAN',
          userId: 'user-3',
          createdAt: new Date('2026-03-02T11:00:00.000Z'),
          maskedExcerpt: null,
          metadata: { banDurationHours: 24 },
        },
        {
          id: 'evt-ban-2',
          action: 'BAN',
          ruleCode: 'LINK_BLOCKED',
          userId: 'user-2',
          createdAt: new Date('2026-03-02T10:30:00.000Z'),
          maskedExcerpt: '***',
          metadata: null,
        },
        {
          id: 'evt-ban-1',
          action: 'BAN',
          ruleCode: 'DUPLICATE_BAN',
          userId: 'user-1',
          createdAt: new Date('2026-03-02T09:00:00.000Z'),
          maskedExcerpt: null,
          metadata: { duplicateCount: 4 },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'evt-ban-1',
          action: 'BAN',
          ruleCode: 'DUPLICATE_BAN',
          userId: 'user-1',
          createdAt: new Date('2026-03-02T09:00:00.000Z'),
          maskedExcerpt: null,
          metadata: { duplicateCount: 4 },
        },
      ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { user_id: 'user-3', sender_name: 'Анна' },
        { user_id: 'user-2', sender_name: 'Мария' },
      ])
      .mockResolvedValueOnce([{ user_id: 'user-1', sender_name: 'Игорь' }]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberProfiles: jest
        .fn()
        .mockResolvedValueOnce(
          new Map([
            [
              'user-3',
              {
                userId: 'user-3',
                displayName: 'Анна',
                username: 'anna',
                avatarUrl: 'https://cdn.max.ru/u/3/avatar-full.jpg',
              },
            ],
            [
              'user-2',
              {
                userId: 'user-2',
                displayName: 'Мария',
                username: 'maria',
                avatarUrl: 'https://cdn.max.ru/u/2/avatar-full.jpg',
              },
            ],
          ]),
        )
        .mockResolvedValueOnce(
          new Map([
            [
              'user-1',
              {
                userId: 'user-1',
                displayName: 'Игорь',
                username: null,
                avatarUrl: 'https://cdn.max.ru/u/1/avatar-full.jpg',
              },
            ],
          ]),
        ),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const firstPage = await service.getChatModerationFeed(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d', filter: 'BAN', limit: 2 },
    );

    expect(firstPage.items).toEqual([
      {
        id: 'evt-ban-3',
        action: 'BAN',
        ruleCode: 'MANUAL_BAN',
        userId: 'user-3',
        userDisplayName: 'Анна',
        avatarUrl: 'https://cdn.max.ru/u/3/avatar-full.jpg',
        profileUrl: 'https://max.ru/anna',
        profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pmh-'),
        createdAt: '2026-03-02T11:00:00.000Z',
        maskedExcerpt: null,
        metadata: { banDurationHours: 24 },
      },
      {
        id: 'evt-ban-2',
        action: 'BAN',
        ruleCode: 'LINK_BLOCKED',
        userId: 'user-2',
        userDisplayName: 'Мария',
        avatarUrl: 'https://cdn.max.ru/u/2/avatar-full.jpg',
        profileUrl: 'https://max.ru/maria',
        profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pmh-'),
        createdAt: '2026-03-02T10:30:00.000Z',
        maskedExcerpt: '***',
        metadata: null,
      },
    ]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await service.getChatModerationFeed(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d', filter: 'BAN', limit: 2, cursor: firstPage.nextCursor ?? undefined },
    );

    expect(secondPage).toEqual({
      items: [
        {
          id: 'evt-ban-1',
          action: 'BAN',
          ruleCode: 'DUPLICATE_BAN',
          userId: 'user-1',
          userDisplayName: 'Игорь',
          avatarUrl: 'https://cdn.max.ru/u/1/avatar-full.jpg',
          profileUrl: null,
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pmh-'),
          createdAt: '2026-03-02T09:00:00.000Z',
          maskedExcerpt: null,
          metadata: { duplicateCount: 4 },
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    const firstCall = prisma.moderationEvent.findMany.mock.calls[0]?.[0];
    expect(firstCall.where).toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        action: 'BAN',
      }),
    );
    expect(firstCall.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);

    const secondCall = prisma.moderationEvent.findMany.mock.calls[1]?.[0];
    expect(secondCall.where.AND).toHaveLength(2);
    expect(secondCall.where.AND[1]).toEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({ createdAt: expect.objectContaining({ lt: expect.any(Date) }) }),
          expect.objectContaining({
            createdAt: expect.any(Date),
            id: expect.objectContaining({ lt: 'evt-ban-2' }),
          }),
        ]),
      }),
    );
  });
});

describe('AdminService.applyManualModerationAction', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('cancels pending auto-unban before manual kick and records the action', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      kickMember: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-2',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'KICK' },
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-2');
    expect(maxClient.kickMember).toHaveBeenCalledWith('chat-1', 'user-2', { immediate: true });
    expect(maxClient.cancelScheduledUnban.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.kickMember.mock.invocationCallOrder[0],
    );
    expect(prisma.adminGlobalSpammerExemption.deleteMany).toHaveBeenCalledWith({
      where: {
        adminUserId: 'admin-1',
        userId: 'user-2',
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-2',
          ruleCode: 'MANUAL_KICK',
          action: 'KICK',
          operator: 'ADMIN',
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          actorUserId: 'admin-1',
          action: 'MANUAL_KICK_MEMBER',
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'KICK',
      userId: 'user-2',
      banDurationHours: null,
      unbanScheduledAt: null,
      message: 'Участник удалён из чата.',
    });
  });

  it('replaces previous auto-unban schedule on manual ban and records new schedule', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-15T14:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'BAN', banDurationHours: 6 },
    );

    expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-3', { immediate: true });
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-3');
    expect(maxClient.unbanMember).toHaveBeenCalledWith('chat-1', 'user-3', {
      delayMs: 6 * 60 * 60 * 1000,
    });
    expect(maxClient.banMember.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.cancelScheduledUnban.mock.invocationCallOrder[0],
    );
    expect(maxClient.cancelScheduledUnban.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.unbanMember.mock.invocationCallOrder[0],
    );
    expect(prisma.adminGlobalSpammerExemption.deleteMany).toHaveBeenCalledWith({
      where: {
        adminUserId: 'admin-1',
        userId: 'user-3',
      },
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-3',
          ruleCode: 'MANUAL_BAN',
          action: 'BAN',
          operator: 'ADMIN',
          metadata: expect.objectContaining({
            banDurationHours: 6,
            unbanScheduledAt: '2026-03-15T20:00:00.000Z',
            mode: 'MAX_BLOCK',
          }),
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'BAN',
      userId: 'user-3',
      banDurationHours: 6,
      unbanScheduledAt: '2026-03-15T20:00:00.000Z',
      message: 'Участник забанен на 6ч. Авторазбан запланирован.',
    });
  });

  it('falls back to removal-only manual ban for closed chats without link', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-15T14:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        title: 'Закрытый чат',
        participantsCount: 6,
        status: 'active',
        isPublic: false,
        link: null,
        lastEventAt: null,
        entityType: 'chat',
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      kickMember: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn(),
      unbanMember: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'BAN', banDurationHours: 6 },
    );

    expect(maxClient.kickMember).toHaveBeenCalledWith('chat-1', 'user-3', { immediate: true });
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            mode: 'MAX_REMOVE_ONLY',
          }),
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'BAN',
      userId: 'user-3',
      banDurationHours: 6,
      unbanScheduledAt: '2026-03-15T20:00:00.000Z',
      message:
        'Участник удалён из чата на 6ч. Автовозврат запланирован. Для этого типа чата MAX блокировка недоступна, поэтому применено удаление без block.',
    });
  });

  it('returns clear error when bot lacks add_remove_members for manual ban', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['change_chat_info'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      banMember: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-3',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { action: 'BAN', banDurationHours: 6 },
      ),
    ).rejects.toThrow(
      'У бота нет права MAX add_remove_members, поэтому он не может банить участников.',
    );

    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('returns clear error when manual ban target is no longer in chat', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      banMember: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-3',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { action: 'BAN', banDurationHours: 6 },
      ),
    ).rejects.toThrow('Пользователь уже не состоит в этом чате.');

    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('rolls back manual ban when replacing auto-unban schedule fails', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      cancelScheduledUnban: jest.fn().mockRejectedValue({
        response: { data: { message: 'Не удалось заменить старый авторазбан.' } },
      }),
      banMember: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-rollback',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { action: 'BAN', banDurationHours: 6 },
      ),
    ).rejects.toThrow('Не удалось заменить старый авторазбан.');

    expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-rollback', {
      immediate: true,
    });
    expect(maxClient.unbanMember).toHaveBeenCalledWith('chat-1', 'user-rollback', {
      immediate: true,
    });
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('cancels pending auto-unban before manual unban and records the action', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-4',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'UNBAN' },
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-4');
    expect(maxClient.unbanMember).toHaveBeenCalledWith('chat-1', 'user-4', { immediate: true });
    expect(prisma.adminGlobalSpammerExemption.upsert).toHaveBeenCalledWith({
      where: {
        adminUserId_userId: {
          adminUserId: 'admin-1',
          userId: 'user-4',
        },
      },
      create: {
        adminUserId: 'admin-1',
        userId: 'user-4',
        sourceChatId: 'chat-1',
      },
      update: {
        sourceChatId: 'chat-1',
        reason: 'MANUAL_UNBAN',
      },
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-4',
          ruleCode: 'MANUAL_UNBAN',
          action: 'NONE',
          operator: 'ADMIN',
          metadata: expect.objectContaining({
            mode: 'MAX_UNBLOCK',
          }),
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'MANUAL_UNBAN_MEMBER',
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'UNBAN',
      userId: 'user-4',
      banDurationHours: null,
      unbanScheduledAt: null,
      message: 'Участник возвращён в чат и разблокирован.',
    });
  });

  it('releases active ban without re-adding a member who is already in chat', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-4',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-4',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'UNBAN' },
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-4');
    expect(maxClient.unbanMember).not.toHaveBeenCalled();
    expect(prisma.adminGlobalSpammerExemption.upsert).toHaveBeenCalledWith({
      where: {
        adminUserId_userId: {
          adminUserId: 'admin-1',
          userId: 'user-4',
        },
      },
      create: {
        adminUserId: 'admin-1',
        userId: 'user-4',
        sourceChatId: 'chat-1',
      },
      update: {
        sourceChatId: 'chat-1',
        reason: 'MANUAL_UNBAN',
      },
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            mode: 'ACTIVE_BAN_RELEASE',
          }),
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'UNBAN',
      userId: 'user-4',
      banDurationHours: null,
      unbanScheduledAt: null,
      message: 'Бан снят. Участник уже состоит в чате, повторное добавление не потребовалось.',
    });
  });
});

describe('AdminService.applyManualSystemBan', () => {
  it('applies a permanent MAX ban without auto-unban scheduling for command flows', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.applyManualSystemBan(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'group_command',
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-3');
    expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-3', { immediate: true });
    expect(maxClient.unbanMember).not.toHaveBeenCalled();
    expect(prisma.adminGlobalSpammerExemption.deleteMany).toHaveBeenCalledWith({
      where: {
        adminUserId: 'admin-1',
        userId: 'user-3',
      },
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-3',
          ruleCode: 'MANUAL_BAN',
          action: 'BAN',
          metadata: expect.objectContaining({
            source: 'group_command',
            mode: 'MAX_BLOCK_PERMANENT',
          }),
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'BAN',
      userId: 'user-3',
      banDurationHours: null,
      unbanScheduledAt: null,
      message: 'Участник забанен в чате.',
    });
  });

  it('still bans permanently when cancelling a stale scheduled unban fails', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockRejectedValue(new Error('redis timeout')),
      banMember: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.applyManualSystemBan(
        'chat-1',
        'user-3',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'private_command',
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        message: 'Участник забанен в чате.',
      }),
    );

    expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-3', { immediate: true });
  });
});

describe('AdminService.listChannels', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns channel overview summary for each managed channel', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert
      .mockResolvedValueOnce({
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: new Date('2026-03-02T10:00:00.000Z'),
        entityType: 'CHANNEL',
      })
      .mockResolvedValueOnce({
        id: 'channel-2',
        title: 'Обновления MAX',
        createdAt: new Date('2026-03-01T10:00:00.000Z'),
        entityType: 'CHANNEL',
      });
    prisma.channelSettings.findMany.mockResolvedValue([
      {
        chatId: 'channel-1',
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        commentsModerationEnabled: true,
      },
    ]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'channel-1',
          title: 'Новости MAX',
          lastEventTime: 200,
          entityType: 'channel',
          link: 'https://max.ru/news',
        },
        {
          chatId: 'channel-2',
          title: 'Обновления MAX',
          lastEventTime: 100,
          entityType: 'channel',
          link: null,
        },
      ]),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.listChannels(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { refresh: true },
    );

    expect(result).toEqual([
      {
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        link: 'https://max.ru/news',
        channelOverview: {
          enabledScenariosCount: 2,
          commentsEnabled: true,
          postSuggestionsEnabled: true,
          commentsModerationEnabled: true,
        },
      },
      {
        id: 'channel-2',
        title: 'Обновления MAX',
        createdAt: '2026-03-01T10:00:00.000Z',
        entityType: 'channel',
        link: null,
        channelOverview: {
          enabledScenariosCount: 1,
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      },
    ]);
    expect(prisma.channelSettings.findMany).toHaveBeenCalledWith({
      where: {
        chatId: {
          in: ['channel-1', 'channel-2'],
        },
      },
      select: {
        chatId: true,
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        commentsModerationEnabled: true,
      },
    });
  });

  it('checks admin access only for matching channel candidates during channel discovery', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'chat-1',
          title: 'Команда MAX',
          lastEventTime: 300,
          entityType: 'chat',
          link: null,
        },
        {
          chatId: 'channel-1',
          title: 'Новости MAX',
          lastEventTime: 200,
          entityType: 'channel',
          link: 'https://max.ru/news',
        },
      ]),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChannels(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { refresh: true },
      ),
    ).resolves.toEqual([
      {
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        link: 'https://max.ru/news',
        channelOverview: {
          enabledScenariosCount: 1,
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      },
    ]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('channel-1', {
      trafficClass: 'interactive',
    });
  });

  it('uses allowlist cache by default and skips remote MAX discovery', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'channel-1',
          title: 'Кэш канала',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
        },
      },
    ]);
    prisma.channelSettings.findMany.mockResolvedValue([
      {
        chatId: 'channel-1',
        commentsEnabled: false,
        postSuggestionsEnabled: true,
        commentsModerationEnabled: false,
      },
    ]);

    const maxClient = {
      listBotChats: jest.fn(),
      getChatAdminIds: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.listChannels({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual([
      {
        id: 'channel-1',
        title: 'Кэш канала',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        link: null,
        channelOverview: {
          enabledScenariosCount: 1,
          commentsEnabled: false,
          postSuggestionsEnabled: true,
          commentsModerationEnabled: false,
        },
      },
    ]);
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
  });

  it('reuses cached channels during refresh and checks admin only for uncached candidates', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'channel-1',
          title: 'Кэш канала',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
        },
      },
    ]);
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-2',
      title: 'Новый канал',
      createdAt: new Date('2026-03-03T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'channel-1',
          title: 'Кэш канала',
          lastEventTime: 300,
          entityType: 'channel',
          link: 'https://max.ru/cached',
        },
        {
          chatId: 'channel-2',
          title: 'Новый канал',
          lastEventTime: 200,
          entityType: 'channel',
          link: 'https://max.ru/new',
        },
      ]),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChannels(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { refresh: true },
      ),
    ).resolves.toEqual([
      {
        id: 'channel-1',
        title: 'Кэш канала',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        link: 'https://max.ru/cached',
        channelOverview: {
          enabledScenariosCount: 1,
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      },
      {
        id: 'channel-2',
        title: 'Новый канал',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'channel',
        link: 'https://max.ru/new',
        channelOverview: {
          enabledScenariosCount: 1,
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      },
    ]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('channel-2', {
      trafficClass: 'interactive',
    });
  });

  it('auto-discovers channels on default load when allowlist cache is empty', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-24T00:00:00.000Z'));

    const prisma = createPrismaMock();
    const cachedChannel = {
      chat: {
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: new Date('2026-03-02T10:00:00.000Z'),
        entityType: 'CHANNEL',
      },
    };
    let allowlistRows: (typeof cachedChannel)[] = [];
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.chatAdminAllowlist.findMany.mockImplementation(async () => allowlistRows);
    prisma.chatAdminAllowlist.upsert.mockImplementation(async () => {
      allowlistRows = [cachedChannel];
      return undefined;
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'channel-1',
          title: 'Новости MAX',
          lastEventTime: 200,
          entityType: 'channel',
          link: 'https://max.ru/news',
        },
      ]),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const chatContextCache = createChatContextCacheMock();
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChannels({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      {
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        link: 'https://max.ru/news',
        channelOverview: {
          enabledScenariosCount: 1,
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      },
    ]);

    expect(maxClient.listBotChats).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(chatContextCache.activateManagedEntitiesRefreshCooldown).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      30,
    );
  });

  it('falls back to cached channels and backs off refresh after MAX API throttling', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockImplementation(async (args?: { where?: unknown }) => {
      const where = args?.where as { chatId?: string } | undefined;
      if (where?.chatId === 'remote-channel-1') {
        return [];
      }

      return [
        {
          chat: {
            id: 'cached-channel-1',
            title: 'Кэш канала',
            createdAt: new Date('2026-03-02T10:00:00.000Z'),
            entityType: 'CHANNEL',
          },
        },
      ];
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'remote-channel-1',
          title: 'Удалённый канал',
          lastEventTime: 200,
          entityType: 'channel',
          link: 'https://max.ru/remote-channel-1',
        },
      ]),
      getChatAdminIds: jest.fn().mockRejectedValue(new Error('MAX API global rate limit exceeded')),
    };

    const chatContextCache = createChatContextCacheMock();
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const user = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    await expect(service.listChannels(user, { refresh: true })).resolves.toEqual([
      {
        id: 'cached-channel-1',
        title: 'Кэш канала',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        link: null,
        channelOverview: {
          enabledScenariosCount: 1,
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      },
    ]);

    await expect(service.listChannels(user, { refresh: true })).resolves.toEqual([
      {
        id: 'cached-channel-1',
        title: 'Кэш канала',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        link: null,
        channelOverview: {
          enabledScenariosCount: 1,
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      },
    ]);

    expect(maxClient.listBotChats).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(chatContextCache.activateManagedEntitiesRefreshBackoff).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      60,
    );
  });

  it('returns refresh cursor metadata for a partial managed channels scan', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'channel-1',
          title: 'Кэш канала',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
        },
      },
    ]);
    prisma.channelSettings.findMany.mockResolvedValue([]);

    let storedCursor: number | null = null;
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesRefreshCursor: jest.fn().mockImplementation(async () => storedCursor),
      setManagedEntitiesRefreshCursor: jest
        .fn()
        .mockImplementation(async (_userId: string, _entityType: string, cursor: number) => {
          storedCursor = cursor;
        }),
    });
    const remoteChannels = Array.from({ length: 121 }, (_, index) => ({
      chatId: `channel-${index + 1}`,
      title: `Канал ${index + 1}`,
      lastEventTime: 200 - index,
      entityType: 'channel' as const,
      link: `https://max.ru/channel-${index + 1}`,
    }));
    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue(remoteChannels),
      getChatAdminIds: jest.fn().mockResolvedValue([]),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChannelsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { refresh: true },
      ),
    ).resolves.toEqual({
      items: [
        {
          id: 'channel-1',
          title: 'Канал 1',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'channel',
          link: 'https://max.ru/channel-1',
          channelOverview: {
            enabledScenariosCount: 1,
            commentsEnabled: true,
            postSuggestionsEnabled: false,
            commentsModerationEnabled: false,
          },
        },
      ],
      refresh: {
        complete: false,
        cursor: 120,
        backoffActive: false,
      },
    });

    expect(chatContextCache.setManagedEntitiesRefreshCursor).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      120,
      3600,
    );
  });

  it('marks managed channels refresh complete on the final scan window', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-121',
      title: 'Финальный канал',
      createdAt: new Date('2026-03-03T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    let storedCursor: number | null = 120;
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesRefreshCursor: jest.fn().mockImplementation(async () => storedCursor),
      setManagedEntitiesRefreshCursor: jest
        .fn()
        .mockImplementation(async (_userId: string, _entityType: string, cursor: number) => {
          storedCursor = cursor;
        }),
    });
    const remoteChannels = Array.from({ length: 121 }, (_, index) => ({
      chatId: `channel-${index + 1}`,
      title: index === 120 ? 'Финальный канал' : `Канал ${index + 1}`,
      lastEventTime: 300 - index,
      entityType: 'channel' as const,
      link: `https://max.ru/channel-${index + 1}`,
    }));
    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue(remoteChannels),
      getChatAdminIds: jest
        .fn()
        .mockImplementation(async (chatId: string) =>
          chatId === 'channel-121' ? ['admin-1'] : [],
        ),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChannelsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { refresh: true },
      ),
    ).resolves.toEqual({
      items: [
        {
          id: 'channel-121',
          title: 'Финальный канал',
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: 'channel',
          link: 'https://max.ru/channel-121',
          channelOverview: {
            enabledScenariosCount: 1,
            commentsEnabled: true,
            postSuggestionsEnabled: false,
            commentsModerationEnabled: false,
          },
        },
      ],
      refresh: {
        complete: true,
        cursor: -1,
        backoffActive: false,
      },
    });

    expect(chatContextCache.setManagedEntitiesRefreshCursor).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      -1,
      60,
    );
  });

  it('returns refresh backoff metadata when managed channels sync is throttled', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockImplementation(async (args?: { where?: unknown }) => {
      const where = args?.where as { chatId?: string } | undefined;
      if (where?.chatId === 'remote-channel-1') {
        return [];
      }

      return [
        {
          chat: {
            id: 'cached-channel-1',
            title: 'Кэш канала',
            createdAt: new Date('2026-03-02T10:00:00.000Z'),
            entityType: 'CHANNEL',
          },
        },
      ];
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'remote-channel-1',
          title: 'Новый канал',
          lastEventTime: 100,
          entityType: 'channel',
          link: 'https://max.ru/remote-channel-1',
        },
      ]),
      getChatAdminIds: jest.fn().mockRejectedValue(new Error('MAX API global rate limit exceeded')),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChannelsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { refresh: true },
      ),
    ).resolves.toEqual({
      items: [
        {
          id: 'cached-channel-1',
          title: 'Кэш канала',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'channel',
          link: null,
          channelOverview: {
            enabledScenariosCount: 1,
            commentsEnabled: true,
            postSuggestionsEnabled: false,
            commentsModerationEnabled: false,
          },
        },
      ],
      refresh: {
        complete: false,
        cursor: null,
        backoffActive: true,
      },
    });

    expect(chatContextCache.activateManagedEntitiesRefreshBackoff).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      60,
    );
  });

  it('rechecks stale denied admin cache during explicit chat refresh', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHAT',
    });

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'chat-1',
          title: 'Команда MAX',
          lastEventTime: 300,
          entityType: 'chat',
          link: null,
        },
      ]),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('user_denied'),
    });
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { refresh: true },
      ),
    ).resolves.toEqual([
      {
        id: 'chat-1',
        title: 'Команда MAX',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
    ]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1', {
      trafficClass: 'interactive',
    });
  });

  it('scans beyond the uncached chat delta limit during explicit refresh', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-cached',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.chat.upsert.mockImplementation(
      async ({
        where,
        create,
      }: {
        where: { id: string };
        create: { title?: string; entityType?: string };
      }) => ({
        id: where.id,
        title: create.title ?? where.id,
        createdAt: new Date('2026-03-03T10:00:00.000Z'),
        entityType: create.entityType ?? 'CHAT',
      }),
    );

    const uncachedRemoteChats = Array.from({ length: 101 }, (_, index) => ({
      chatId: `chat-${index + 1}`,
      title: index === 100 ? 'Хвостовой чат' : `Чат ${index + 1}`,
      lastEventTime: 300 - index,
      entityType: 'chat' as const,
      link: null,
    }));

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'chat-cached',
          title: 'Кэшированный чат',
          lastEventTime: 500,
          entityType: 'chat',
          link: null,
        },
        ...uncachedRemoteChats,
      ]),
      getChatAdminIds: jest
        .fn()
        .mockImplementation(async (chatId: string) => (chatId === 'chat-101' ? ['admin-1'] : [])),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { refresh: true },
      ),
    ).resolves.toEqual([
      {
        id: 'chat-cached',
        title: 'Кэшированный чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
      {
        id: 'chat-101',
        title: 'Хвостовой чат',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
    ]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-101', {
      trafficClass: 'interactive',
    });
  });

  it('re-runs remote discovery on repeated explicit refreshes even during success cooldown', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-24T00:00:00.000Z'));

    const prisma = createPrismaMock();
    const cachedChannel = {
      chat: {
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: new Date('2026-03-02T10:00:00.000Z'),
        entityType: 'CHANNEL',
      },
    };
    let allowlistRows: (typeof cachedChannel)[] = [];
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.chatAdminAllowlist.findMany.mockImplementation(async (args?: { where?: unknown }) => {
      const where = args?.where as { chatId?: string } | undefined;
      if (where?.chatId) {
        return allowlistRows
          .filter((row) => row.chat.id === where.chatId)
          .map((row) => ({
            chatId: row.chat.id,
          }));
      }

      return allowlistRows;
    });
    prisma.chatAdminAllowlist.upsert.mockImplementation(async () => {
      allowlistRows = [cachedChannel];
      return undefined;
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'channel-1',
          title: 'Новости MAX',
          lastEventTime: 200,
          entityType: 'channel',
          link: 'https://max.ru/news',
        },
      ]),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const chatContextCache = createChatContextCacheMock();
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const user = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    await expect(service.listChannels(user, { refresh: true })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'channel-1' })]),
    );
    await expect(service.listChannels(user, { refresh: true })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'channel-1' })]),
    );

    expect(maxClient.listBotChats).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(chatContextCache.activateManagedEntitiesRefreshCooldown).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      30,
    );
  });

  it('shares one in-flight channel discovery across parallel refresh requests', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    let releaseAdminCheck: (() => void) | undefined;
    const adminCheckPromise = new Promise<void>((resolve) => {
      releaseAdminCheck = resolve;
    });

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'channel-1',
          title: 'Новости MAX',
          lastEventTime: 200,
          entityType: 'channel',
          link: 'https://max.ru/news',
        },
      ]),
      getChatAdminIds: jest.fn().mockImplementation(async () => {
        await adminCheckPromise;
        return ['admin-1'];
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const user = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    const first = service.listChannels(user, { refresh: true });
    const second = service.listChannels(user, { refresh: true });

    if (!releaseAdminCheck) {
      throw new Error('releaseAdminCheck was not initialized');
    }
    releaseAdminCheck();

    await expect(Promise.all([first, second])).resolves.toEqual([
      [
        expect.objectContaining({
          id: 'channel-1',
          entityType: 'channel',
        }),
      ],
      [
        expect.objectContaining({
          id: 'channel-1',
          entityType: 'channel',
        }),
      ],
    ]);

    expect(maxClient.listBotChats).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
  });

  it('does not let one user backoff block another user refresh', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const scopedBackoff = new Set<string>();
    const chatContextCache = createChatContextCacheMock({
      isManagedEntitiesRefreshBackoffActive: jest
        .fn()
        .mockImplementation(async (userId: string, entityType: string) =>
          scopedBackoff.has(`${userId}:${entityType}`),
        ),
      activateManagedEntitiesRefreshBackoff: jest
        .fn()
        .mockImplementation(async (userId: string, entityType: string) => {
          scopedBackoff.add(`${userId}:${entityType}`);
        }),
    });

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'channel-1',
          title: 'Новости MAX',
          lastEventTime: 200,
          entityType: 'channel',
          link: 'https://max.ru/news',
        },
      ]),
      getChatAdminIds: jest
        .fn()
        .mockRejectedValueOnce(new Error('MAX API global rate limit exceeded'))
        .mockResolvedValue(['admin-2']),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChannels(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { refresh: true },
      ),
    ).resolves.toEqual([]);

    await expect(
      service.listChannels(
        {
          userId: 'admin-2',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { refresh: true },
      ),
    ).resolves.toEqual([
      {
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        link: 'https://max.ru/news',
        channelOverview: {
          enabledScenariosCount: 1,
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      },
    ]);

    expect(maxClient.listBotChats).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(2);
  });
});

describe('AdminService.listChats', () => {
  it('merges the current chat into cached allowlist results on default load', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const maxClient = {
      listBotChats: jest.fn(),
      getChatAdminIds: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    jest.spyOn(service as any, 'bootstrapCurrentChat').mockResolvedValue({
      id: 'chat-2',
      title: 'Текущий чат',
      createdAt: '2026-03-03T10:00:00.000Z',
      entityType: 'chat',
      link: null,
      channelOverview: null,
    });

    const result = await service.listChats({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: 'chat-2',
      chatTitle: 'Текущий чат',
    });

    expect(result).toEqual([
      {
        id: 'chat-2',
        title: 'Текущий чат',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
      {
        id: 'chat-1',
        title: 'Кэшированный чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
    ]);
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
  });

  it('bootstraps recent bot_added chats into the default chats list without remote discovery', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([
      {
        chat_id: 'chat-2',
        chat_title: null,
        is_channel: 'false',
      },
    ]);
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === 'chat-2') {
        return {
          title: 'Chat chat-2',
        };
      }

      return {
        id: 'chat-1',
        title: 'Кэшированный чат',
        entityType: 'CHAT',
      };
    });
    prisma.chat.upsert.mockImplementation(
      async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: { title?: string; entityType?: string };
        update: { title?: string; entityType?: string };
      }) => ({
        id: where.id,
        title: update.title ?? create.title ?? where.id,
        entityType: update.entityType ?? create.entityType ?? 'CHAT',
        createdAt:
          where.id === 'chat-2'
            ? new Date('2026-03-03T10:00:00.000Z')
            : new Date('2026-03-02T10:00:00.000Z'),
      }),
    );

    const maxClient = {
      listBotChats: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatTitle: jest.fn().mockResolvedValue('Новый чат'),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    jest.spyOn(service as any, 'bootstrapCurrentChat').mockResolvedValue(null);

    const result = await service.listChats({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual([
      {
        id: 'chat-2',
        title: 'Новый чат',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
      {
        id: 'chat-1',
        title: 'Кэшированный чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
    ]);
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-2');
    expect(maxClient.getChatTitle).toHaveBeenCalledWith('chat-2');
    expect(prisma.chatAdminAllowlist.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId: {
            chatId: 'chat-2',
            userId: 'admin-1',
          },
        },
      }),
    );
  });

  it('does not bootstrap stale recent bot_added chats when MAX denies current admin access', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([
      {
        chat_id: 'chat-2',
        chat_title: 'Битый чат',
        is_channel: 'false',
      },
    ]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([]),
      getChatAdminIds: jest.fn().mockRejectedValue({
        response: {
          status: 403,
          data: {
            code: 'chat.denied',
            message: 'Method is available only for chat administrator',
          },
        },
      }),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    jest.spyOn(service as any, 'bootstrapCurrentChat').mockResolvedValue(null);

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);

    expect(maxClient.listBotChats).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-2');
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
  });

  it('revalidates cached chats with stale negative admin cache on default load', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Актуальный чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
      {
        chat: {
          id: 'chat-2',
          title: 'Устаревший чат',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([]);

    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-2') {
          return 'bot_denied';
        }

        return null;
      }),
    });
    const maxClient = {
      listBotChats: jest.fn(),
      getChatAdminIds: jest.fn().mockRejectedValue({
        response: {
          status: 403,
          data: {
            code: 'chat.denied',
            message: 'Method is available only for chat administrator',
          },
        },
      }),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    jest.spyOn(service as any, 'bootstrapCurrentChat').mockResolvedValue(null);

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      {
        id: 'chat-1',
        title: 'Актуальный чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
    ]);

    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-2');
    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-2',
        userId: 'admin-1',
      },
    });
  });

  it('removes cached private direct dialogs from allowlist on default load', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: '152517912',
          title: 'Chat 152517912',
          createdAt: new Date('2026-02-28T01:20:52.139Z'),
          entityType: 'CHAT',
        },
      },
      {
        chat: {
          id: 'chat-1',
          title: 'Рабочий чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn(),
      getChatAdminIds: jest.fn(),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    jest.spyOn(service as any, 'bootstrapCurrentChat').mockResolvedValue(null);

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      {
        id: 'chat-1',
        title: 'Рабочий чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
    ]);

    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'admin-1',
        chatId: {
          in: ['152517912'],
        },
      },
    });
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
  });

  it('ignores private direct dialogs returned by remote discovery', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.chat.upsert.mockImplementation(
      async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: { title?: string; entityType?: string };
        update: { title?: string; entityType?: string };
      }) => ({
        id: where.id,
        title: update.title ?? create.title ?? where.id,
        entityType: update.entityType ?? create.entityType ?? 'CHAT',
        createdAt: new Date('2026-03-03T10:00:00.000Z'),
      }),
    );

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: '152517912',
          title: 'Личка с ботом',
          lastEventTime: 2,
          entityType: 'chat',
          link: null,
        },
        {
          chatId: 'chat-1',
          title: 'Рабочий чат',
          lastEventTime: 1,
          entityType: 'chat',
          link: null,
        },
      ]),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    jest.spyOn(service as any, 'bootstrapCurrentChat').mockResolvedValue(null);

    await expect(
      service.listChats(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { refresh: true },
      ),
    ).resolves.toEqual([
      {
        id: 'chat-1',
        title: 'Рабочий чат',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
    ]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1', {
      trafficClass: 'interactive',
    });
    expect(prisma.chatAdminAllowlist.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.chatAdminAllowlist.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId: {
            chatId: 'chat-1',
            userId: 'admin-1',
          },
        },
      }),
    );
  });

  it('does not bootstrap a private direct dialog into managed chats', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn(),
      getChatEditableAdminIds: jest.fn(),
      getChatAdminIds: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.listChats({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: 'Личка с ботом',
    });

    expect(result).toEqual([]);
    expect(maxClient.getChatEditableAdminIds).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
  });
});

describe('AdminService settings screen endpoints', () => {
  it('aggregates chat settings screen data in one response', async () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const settings = chatSettingsSchema.parse({
      linkPolicy: 'BLOCKLIST_ONLY',
      greetingEnabled: true,
    });
    const rules = chatRulesSchema.parse({
      text: 'Правила чата',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
    });

    jest.spyOn(service, 'getSettings').mockResolvedValue(settings);
    jest.spyOn(service, 'getRules').mockResolvedValue(rules);
    jest.spyOn(service, 'getChatHeader').mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'chat',
      link: null,
      participantsCount: 128,
    });
    jest.spyOn(service, 'getDomainAllowlistDetails').mockResolvedValue([
      {
        domain: 'https://example.com',
        normalizedValue: 'https://example.com',
        matchType: 'EXACT',
        removeAfterAt: null,
      },
    ]);
    jest.spyOn(service, 'listManagedBroadcasts').mockResolvedValue([]);

    const result = await service.getChatSettingsScreen('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual({
      settings,
      rules,
      header: {
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'chat',
        link: null,
        participantsCount: 128,
      },
      requiredSubscriptionChannels: [],
      domains: [
        {
          domain: 'https://example.com',
          normalizedValue: 'https://example.com',
          matchType: 'EXACT',
          removeAfterAt: null,
        },
      ],
      managedBroadcasts: [],
    });
  });

  it('routes section apply-to-all through partial settings keys', async () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const settings = chatSettingsSchema.parse({
      linkPolicy: 'BLOCKLIST_ONLY',
      greetingEnabled: true,
    });

    jest.spyOn(service, 'getSettings').mockResolvedValue(settings);
    const applySpy = jest.spyOn(service as any, 'applySettingsToAllChats').mockResolvedValue({
      sourceChatId: 'chat-1',
      updatedChats: 2,
      appliedChatIds: ['chat-1', 'chat-2'],
    });

    const result = await service.applySettingsSectionToAllChats(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { section: 'links' },
    );

    expect(applySpy).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'admin-1' }),
      settings,
      'miniapp',
      expect.arrayContaining(['linkPolicy', 'linkBotMessageEnabled', 'linkBotButtonText']),
    );
    expect(result).toEqual({
      section: 'links',
      sourceChatId: 'chat-1',
      updatedChats: 2,
      appliedChatIds: ['chat-1', 'chat-2'],
    });
  });

  it('syncs allowlist entries when applying links section to all chats', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    prisma.domainAllowlist.findMany.mockResolvedValueOnce([
      {
        domain: 'domain:max.ru',
        removeAfterAt: null,
      },
      {
        domain: 'https://max.ru/join/srAq1j6jwW-enxSWrppR16_AC_NZpAA3oy-gyVPgGCsl',
        removeAfterAt: new Date('2026-03-31T09:00:00.000Z'),
      },
    ]);

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    jest.spyOn(service, 'getSettings').mockResolvedValue(
      chatSettingsSchema.parse({
        linkPolicy: 'ALLOWLIST_ONLY',
      }),
    );
    jest.spyOn(service, 'listChats').mockResolvedValue([
      {
        id: 'chat-2',
        title: 'Регион 2',
        entityType: 'chat',
        createdAt: '2026-03-02T00:00:00.000Z',
        link: null,
        channelOverview: null,
      },
    ]);

    await service.applySettingsSectionToAllChats(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { section: 'links' },
    );

    expect(prisma.domainAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-2',
      },
    });
    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_domain: {
          chatId: 'chat-2',
          domain: 'domain:max.ru',
        },
      },
      create: {
        chatId: 'chat-2',
        domain: 'domain:max.ru',
        removeAfterAt: null,
      },
      update: {
        removeAfterAt: null,
      },
    });
    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_domain: {
          chatId: 'chat-2',
          domain: 'https://max.ru/join/srAq1j6jwW-enxSWrppR16_AC_NZpAA3oy-gyVPgGCsl',
        },
      },
      create: {
        chatId: 'chat-2',
        domain: 'https://max.ru/join/srAq1j6jwW-enxSWrppR16_AC_NZpAA3oy-gyVPgGCsl',
        removeAfterAt: new Date('2026-03-31T09:00:00.000Z'),
      },
      update: {
        removeAfterAt: new Date('2026-03-31T09:00:00.000Z'),
      },
    });
  });
});

describe('AdminService admin access validation', () => {
  const user = {
    userId: 'admin-1',
    username: null,
    displayName: null,
    chatTitle: null,
  };

  it('deduplicates concurrent admin checks for the same chat and user', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    let resolveAdminIds!: (value: string[]) => void;
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(
        () =>
          new Promise<string[]>((resolve) => {
            resolveAdminIds = resolve;
          }),
      ),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const pending = [
      service.assertChatAdmin('chat-1', user.userId, 'chat'),
      service.assertChatAdmin('chat-1', user.userId, 'chat'),
      service.assertChatAdmin('chat-1', user.userId, 'chat'),
    ];

    await Promise.resolve();

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);

    resolveAdminIds(['admin-1']);
    await expect(Promise.all(pending)).resolves.toEqual([undefined, undefined, undefined]);
  });

  it('validates base admin access via the full MAX admin list', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatEditableAdminIds: jest.fn().mockResolvedValue([]),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).resolves.toBeUndefined();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1');
    expect(maxClient.getChatEditableAdminIds).not.toHaveBeenCalled();
  });

  it('rechecks stale bot_denied cache before rejecting admin access', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('bot_denied'),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).resolves.toBeUndefined();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1');
    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith('chat-1', 'admin-1', 'granted');
  });

  it('rechecks stale user_denied cache before rejecting admin access', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('user_denied'),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).resolves.toBeUndefined();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1');
    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith('chat-1', 'admin-1', 'granted');
  });

  it('falls back to persisted allowlist on transient MAX admin check failures', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ chatId: 'chat-1' }]);
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockRejectedValue(
        Object.assign(new Error('timeout of 5000ms exceeded'), {
          code: 'ECONNABORTED',
        }),
      ),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).resolves.toBeUndefined();
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
  });

  it('returns 503 instead of false 403 when MAX admin check transiently fails without fallback', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockRejectedValue(
        Object.assign(new Error('timeout of 5000ms exceeded'), {
          code: 'ECONNABORTED',
        }),
      ),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
  });

  it('cleans stale allowlist rows when MAX says bot no longer has access to the chat', async () => {
    const prisma = createPrismaMock();
    let accessState: 'bot_denied' | null = null;
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockImplementation(async () => accessState),
      setAdminAccess: jest
        .fn()
        .mockImplementation(async (_chatId: string, _userId: string, state: 'bot_denied') => {
          accessState = state;
        }),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockRejectedValue({
        response: {
          status: 403,
          data: {
            code: 'chat.denied',
            message: 'Bot is not a chat member',
          },
        },
      }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).rejects.toThrow(
      'Бот больше не состоит в этом чате MAX или не является его администратором.',
    );
    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith('chat-1', 'admin-1', 'bot_denied');
    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        userId: 'admin-1',
      },
    });
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(2);
  });
});

describe('AdminService.getChannelStats', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns official-first channel stats without reading channel settings', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          posts_with_buttons: '2',
          comments: '4',
          suggestions: '3',
          comment_authors: '2',
          suggestion_authors: '2',
          suggestions_delivered: '2',
          suggestions_failed: '1',
          last_bot_activity_at: new Date('2026-03-07T11:25:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([
        { created_at: new Date('2026-03-03T09:00:00.000Z'), event_type: 'user_added' },
        { created_at: new Date('2026-03-04T09:00:00.000Z'), event_type: 'user_added' },
        { created_at: new Date('2026-03-05T09:00:00.000Z'), event_type: 'user_removed' },
      ])
      .mockResolvedValueOnce([
        {
          id: 'wh-ch-3',
          created_at: new Date('2026-03-07T11:40:00.000Z'),
          event_type: 'user_added',
          user_id: 'user-10',
          sender_name: 'Андрей',
        },
        {
          id: 'wh-ch-2',
          created_at: new Date('2026-03-07T10:15:00.000Z'),
          event_type: 'user_removed',
          user_id: 'user-11',
          sender_name: 'Елена',
        },
      ]);
    prisma.channelAudienceSnapshot.findFirst
      .mockResolvedValueOnce({
        chatId: 'channel-1',
        participantsCount: 1240,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/news',
        lastEventAt: new Date('2026-03-07T11:55:00.000Z'),
        capturedAt: new Date('2026-03-07T11:56:00.000Z'),
      })
      .mockResolvedValueOnce({
        capturedAt: new Date('2026-03-01T08:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        participantsCount: 1210,
      });
    prisma.channelAudienceSnapshot.findMany.mockResolvedValue([
      {
        capturedAt: new Date('2026-03-03T10:00:00.000Z'),
        participantsCount: 1220,
      },
      {
        capturedAt: new Date('2026-03-06T10:00:00.000Z'),
        participantsCount: 1240,
      },
    ]);
    prisma.channelStatsSyncState.findUnique.mockResolvedValue({
      id: 'sync-1',
      chatId: 'channel-1',
      viewsCoverageFrom: new Date('2026-03-01T08:00:00.000Z'),
      membershipCoverageFrom: new Date('2026-02-28T08:00:00.000Z'),
      lastAudienceSyncAt: new Date('2026-03-07T11:56:00.000Z'),
      lastViewsSyncAt: new Date('2026-03-07T11:56:00.000Z'),
      lastOpportunisticSyncAt: null,
      createdAt: new Date('2026-02-28T08:00:00.000Z'),
      updatedAt: new Date('2026-03-07T11:56:00.000Z'),
    });
    prisma.channelPost.findMany.mockResolvedValue([
      {
        publishedAt: new Date('2026-03-03T07:00:00.000Z'),
        latestViews: 150,
        latestReactionsTotal: 5,
        latestReactions: [
          { emoji: '🔥', count: 3 },
          { emoji: '👍', count: 2 },
        ],
      },
      {
        publishedAt: new Date('2026-03-06T14:00:00.000Z'),
        latestViews: 260,
        latestReactionsTotal: 7,
        latestReactions: [
          { emoji: '🔥', count: 4 },
          { emoji: '❤️', count: 3 },
        ],
      },
    ]);
    prisma.channelPost.findFirst.mockResolvedValue({ id: 'post-1' });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn(),
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-10',
            {
              userId: 'user-10',
              displayName: 'Андрей',
              username: 'andrey',
              avatarUrl: 'https://cdn.max.ru/u/10/avatar-full.jpg',
            },
          ],
          [
            'user-11',
            {
              userId: 'user-11',
              displayName: 'Елена',
              username: null,
              avatarUrl: 'https://cdn.max.ru/u/11/avatar-full.jpg',
            },
          ],
        ]),
      ),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const channelStatsCollector = {
      syncChannelIfStale: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      channelStatsCollector as never,
    );

    const result = await service.getChannelStats(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d' },
    );

    expect(result.channel).toEqual({
      id: 'channel-1',
      title: 'Новости MAX',
      participantsCount: 1240,
      status: 'active',
      isPublic: true,
      link: 'https://max.ru/news',
      lastEventAt: '2026-03-07T11:55:00.000Z',
    });
    expect(result.period).toEqual({
      range: '7d',
      from: '2026-02-28T12:00:00.000Z',
      to: '2026-03-07T12:00:00.000Z',
      bucket: 'day',
    });
    expect(result.official.audience).toEqual({
      joined: 2,
      left: 1,
      net: 1,
    });
    expect(result.official.content).toEqual({
      posts: 2,
      views: 410,
      reactions: 12,
      topReactions: [
        { emoji: '🔥', count: 7 },
        { emoji: '❤️', count: 3 },
        { emoji: '👍', count: 2 },
      ],
      lastPublishedAt: '2026-03-06T14:00:00.000Z',
    });
    expect(result.secondary).toEqual({
      postsWithButtons: 2,
      comments: 4,
      suggestions: 3,
      commentAuthors: 2,
      suggestionAuthors: 2,
      suggestionsDelivered: 2,
      suggestionsFailed: 1,
      lastBotActivityAt: '2026-03-07T11:25:00.000Z',
    });
    expect(result.meta).toEqual({
      maxSnapshotAvailable: true,
      viewsAvailable: true,
      churnAvailable: true,
      officialCoverageFrom: '2026-02-28T08:00:00.000Z',
      missingOfficialMetrics: ['reach', 'uniqueViews'],
    });
    expect(result.activityFeed).toEqual({
      items: [
        {
          id: 'wh-ch-3',
          type: 'joined',
          userId: 'user-10',
          userDisplayName: 'Андрей',
          avatarUrl: 'https://cdn.max.ru/u/10/avatar-full.jpg',
          profileUrl: 'https://max.ru/andrey',
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pmh-'),
          createdAt: '2026-03-07T11:40:00.000Z',
        },
        {
          id: 'wh-ch-2',
          type: 'left',
          userId: 'user-11',
          userDisplayName: 'Елена',
          avatarUrl: 'https://cdn.max.ru/u/11/avatar-full.jpg',
          profileUrl: null,
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pmh-'),
          createdAt: '2026-03-07T10:15:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    expect(result.official.series.participants).toHaveLength(8);
    expect(result.official.series.membership).toHaveLength(8);
    expect(result.official.series.views).toHaveLength(8);
    expect(channelStatsCollector.syncChannelIfStale).toHaveBeenCalledWith('channel-1', {
      staleMs: 7200000,
      reason: 'stats_endpoint',
    });

    const statsSqlText = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(statsSqlText).toContain('COUNT(DISTINCT CASE');
    expect(statsSqlText).toContain("payload->>'threadId'");
    expect(statsSqlText).toContain("payload->>'delivered' = 'true'");
    expect(statsSqlText).toContain("payload->>'delivered' = 'false'");
  });

  it.each([
    ['24h', '2026-03-06T12:00:00.000Z', 'hour'],
    ['30d', '2026-02-05T12:00:00.000Z', 'day'],
  ] as const)(
    'uses %s boundaries for official channel stats period',
    async (range, expectedFrom, expectedBucket) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

      const prisma = createPrismaMock();
      prisma.chat.findUnique.mockResolvedValue({
        id: 'channel-1',
        title: 'Новости MAX',
        entityType: 'CHANNEL',
      });
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            posts_with_buttons: '0',
            comments: '0',
            suggestions: '0',
            comment_authors: '0',
            suggestion_authors: '0',
            suggestions_delivered: '0',
            suggestions_failed: '0',
            last_bot_activity_at: null,
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      prisma.channelAudienceSnapshot.findFirst
        .mockResolvedValueOnce({
          chatId: 'channel-1',
          participantsCount: 1240,
          status: 'active',
          isPublic: true,
          link: 'https://max.ru/news',
          lastEventAt: new Date('2026-03-07T11:55:00.000Z'),
          capturedAt: new Date('2026-03-07T11:56:00.000Z'),
        })
        .mockResolvedValueOnce({
          capturedAt: new Date('2026-03-01T08:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          participantsCount: 1240,
        });
      prisma.channelStatsSyncState.findUnique.mockResolvedValue({
        id: 'sync-1',
        chatId: 'channel-1',
        viewsCoverageFrom: new Date('2026-03-01T08:00:00.000Z'),
        membershipCoverageFrom: new Date('2026-03-01T08:00:00.000Z'),
        lastAudienceSyncAt: new Date('2026-03-07T11:56:00.000Z'),
        lastViewsSyncAt: new Date('2026-03-07T11:56:00.000Z'),
        lastOpportunisticSyncAt: null,
        createdAt: new Date('2026-03-01T08:00:00.000Z'),
        updatedAt: new Date('2026-03-07T11:56:00.000Z'),
      });

      const maxClient = {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getChatSnapshot: jest.fn(),
      };
      const chatContextCache = {
        invalidate: jest.fn(),
      };

      const service = new AdminService(
        prisma as never,
        maxClient as never,
        chatContextCache as never,
        createConfigMock() as never,
      );

      const result = await service.getChannelStats(
        'channel-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { range },
      );

      expect(result.period.range).toBe(range);
      expect(result.period.from).toBe(expectedFrom);
      expect(result.period.to).toBe('2026-03-07T12:00:00.000Z');
      expect(result.period.bucket).toBe(expectedBucket);
    },
  );

  it('returns partial official stats when cached MAX snapshot is missing and fallback request fails', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          posts_with_buttons: '1',
          comments: '0',
          suggestions: '1',
          comment_authors: '0',
          suggestion_authors: '1',
          suggestions_delivered: '0',
          suggestions_failed: '1',
          last_bot_activity_at: new Date('2026-03-07T09:30:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([
        { created_at: new Date('2026-03-07T09:30:00.000Z'), event_type: 'user_added' },
      ])
      .mockResolvedValueOnce([
        {
          id: 'wh-missing-1',
          created_at: new Date('2026-03-07T09:30:00.000Z'),
          event_type: 'user_added',
          user_id: 'user-42',
          sender_name: null,
        },
      ])
      .mockResolvedValueOnce([{ user_id: 'user-42', sender_name: 'Павел' }]);
    prisma.channelAudienceSnapshot.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.channelStatsSyncState.findUnique.mockResolvedValue({
      id: 'sync-1',
      chatId: 'channel-1',
      viewsCoverageFrom: new Date('2026-03-06T12:00:00.000Z'),
      membershipCoverageFrom: null,
      lastAudienceSyncAt: null,
      lastViewsSyncAt: new Date('2026-03-07T09:00:00.000Z'),
      lastOpportunisticSyncAt: null,
      createdAt: new Date('2026-03-06T12:00:00.000Z'),
      updatedAt: new Date('2026-03-07T09:00:00.000Z'),
    });
    prisma.channelPost.findMany.mockResolvedValue([
      {
        publishedAt: new Date('2026-03-07T09:00:00.000Z'),
        latestViews: 44,
        latestReactionsTotal: 0,
        latestReactions: null,
      },
    ]);
    prisma.channelPost.findFirst.mockResolvedValue({ id: 'post-1' });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockRejectedValue(new Error('MAX unavailable')),
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-42',
            {
              userId: 'user-42',
              displayName: 'Павел',
              username: 'pavel',
              avatarUrl: 'https://cdn.max.ru/u/42/avatar-full.jpg',
            },
          ],
        ]),
      ),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getChannelStats(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '24h' },
    );

    expect(result.channel).toEqual({
      id: 'channel-1',
      title: 'Новости MAX',
      participantsCount: null,
      status: null,
      isPublic: null,
      link: null,
      lastEventAt: null,
    });
    expect(result.official.audience).toEqual({
      joined: 1,
      left: 0,
      net: 1,
    });
    expect(result.official.content).toEqual({
      posts: 1,
      views: 44,
      reactions: 0,
      topReactions: [],
      lastPublishedAt: '2026-03-07T09:00:00.000Z',
    });
    expect(result.secondary.suggestionsFailed).toBe(1);
    expect(result.secondary.lastBotActivityAt).toBe('2026-03-07T09:30:00.000Z');
    expect(result.meta.maxSnapshotAvailable).toBe(false);
    expect(result.meta.churnAvailable).toBe(false);
    expect(result.activityFeed.items[0]).toEqual({
      id: 'wh-missing-1',
      type: 'joined',
      userId: 'user-42',
      userDisplayName: 'Павел',
      avatarUrl: 'https://cdn.max.ru/u/42/avatar-full.jpg',
      profileUrl: 'https://max.ru/pavel',
      profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pmh-'),
      createdAt: '2026-03-07T09:30:00.000Z',
    });
  });
});

describe('AdminService.updateChannelSettings', () => {
  it('syncs auto post buttons mode with the comments and suggestion toggles', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.updateChannelSettings(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        autoPostButtonsMode: 'OFF',
        commentsEnabled: true,
        postSuggestionsEnabled: true,
      },
    );

    expect(result.autoPostButtonsMode).toBe('BOTH');
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          entityType: 'CHANNEL',
          channelSettings: {
            upsert: expect.objectContaining({
              update: expect.objectContaining({
                autoPostButtonsMode: 'BOTH',
              }),
            }),
          },
        },
      }),
    );
  });
});

describe('AdminService allowlist normalization', () => {
  it('returns deduplicated canonical links', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValue([
      { domain: 'max.ru/news', removeAfterAt: null },
      { domain: 'https://max.ru/news', removeAfterAt: null },
      { domain: 'https://vk.com/studia_svetlana_armavir', removeAfterAt: null },
      { domain: 'https://vk.ru/studia_svetlana_armavir', removeAfterAt: null },
      { domain: 'example.org', removeAfterAt: null },
      { domain: 'https://EXAMPLE.org/', removeAfterAt: null },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getDomainAllowlist('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual([
      'https://example.org',
      'https://max.ru/news',
      'https://vk.com/studia_svetlana_armavir',
    ]);
  });

  it('deduplicates host aliases when adding a link', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValueOnce([
      { domain: 'https://vk.ru/studia_svetlana_armavir' },
      { domain: 'another.org' },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.addDomain(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        domain: 'https://vk.com/studia_svetlana_armavir',
      },
    );

    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_domain: {
          chatId: 'chat-1',
          domain: 'https://vk.com/studia_svetlana_armavir',
        },
      },
      create: {
        chatId: 'chat-1',
        domain: 'https://vk.com/studia_svetlana_armavir',
      },
      update: {
        removeAfterAt: null,
      },
    });
    expect(prisma.domainAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        domain: {
          in: ['https://vk.ru/studia_svetlana_armavir'],
        },
      },
    });
  });

  it('canonicalizes legacy link rows when adding a link', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValueOnce([
      { domain: 'max.ru/news' },
      { domain: 'another.org' },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.addDomain(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        domain: 'https://max.ru/news',
      },
    );

    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_domain: {
          chatId: 'chat-1',
          domain: 'https://max.ru/news',
        },
      },
      create: {
        chatId: 'chat-1',
        domain: 'https://max.ru/news',
      },
      update: {
        removeAfterAt: null,
      },
    });
    expect(prisma.domainAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        domain: {
          in: ['max.ru/news'],
        },
      },
    });
  });

  it('extracts exact link from pasted allowlist text', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValueOnce([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.addDomain(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        domain:
          'https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU MAX позволяет отправлять любые виды сообщений',
      },
    );

    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_domain: {
          chatId: 'chat-1',
          domain: 'https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU',
        },
      },
      create: {
        chatId: 'chat-1',
        domain: 'https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU',
      },
      update: {
        removeAfterAt: null,
      },
    });
  });

  it('stores domain-wide rules separately from exact links', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValueOnce([
      { domain: 'domain:docs.max.ru' },
      { domain: 'https://max.ru/news' },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.addDomain(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        domain: 'https://docs.max.ru/mini-apps/start',
        matchType: 'DOMAIN',
      },
    );

    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_domain: {
          chatId: 'chat-1',
          domain: 'domain:docs.max.ru',
        },
      },
      create: {
        chatId: 'chat-1',
        domain: 'domain:docs.max.ru',
      },
      update: {
        removeAfterAt: null,
      },
    });
  });

  it('treats legacy encoded trailing-text rows as the same allowlist link', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValueOnce([
      {
        domain:
          'https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU%20MAX%20%D0%BF%D0%BE%D0%B7%D0%B2%D0%BE%D0%BB%D1%8F%D0%B5%D1%82%20%D0%BE%D1%82%D0%BF%D1%80%D0%B0%D0%B2%D0%BB%D1%8F%D1%82%D1%8C',
      },
      { domain: 'another.org' },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.addDomain(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        domain: 'https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU',
      },
    );

    expect(prisma.domainAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        domain: {
          in: [
            'https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU%20MAX%20%D0%BF%D0%BE%D0%B7%D0%B2%D0%BE%D0%BB%D1%8F%D0%B5%D1%82%20%D0%BE%D1%82%D0%BF%D1%80%D0%B0%D0%B2%D0%BB%D1%8F%D1%82%D1%8C',
          ],
        },
      },
    });
  });

  it('removes canonical and legacy rows by normalized link', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValue([
      { domain: 'https://max.ru/news?x=1' },
      { domain: 'max.ru/news?x=1' },
      { domain: 'example.org' },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.removeDomain(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'https://max.ru/news?x=1',
    );

    expect(prisma.domainAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        domain: {
          in: ['https://max.ru/news?x=1', 'max.ru/news?x=1'],
        },
      },
    });
  });
});

describe('AdminService.sendBroadcast', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('falls back to cached allowlist when mass broadcast scan is throttled', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-2',
          title: 'Чат 2',
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(
        service as unknown as {
          listManagedEntitiesDetailed: (...args: unknown[]) => Promise<unknown>;
        },
        'listManagedEntitiesDetailed',
      )
      .mockRejectedValueOnce(new Error('MAX API global rate limit exceeded'));

    const result = await service.listChatsForMassBroadcast({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual([
      {
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
    ]);
  });

  it('keeps draining due managed broadcasts until the current backlog is exhausted', async () => {
    const prisma = createPrismaMock();
    prisma.managedBroadcast.findMany
      .mockResolvedValueOnce([{ id: 'broadcast-1' }])
      .mockResolvedValueOnce([{ id: 'broadcast-1' }])
      .mockResolvedValueOnce([]);

    const service = new AdminService(
      prisma as never,
      {} as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );
    const processSpy = jest
      .spyOn(service as any, 'processManagedBroadcastOccurrence')
      .mockResolvedValue(undefined);

    await service.processDueManagedBroadcasts('scheduled');

    expect(prisma.managedBroadcast.findMany).toHaveBeenCalledTimes(3);
    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(processSpy).toHaveBeenNthCalledWith(1, 'broadcast-1', 'scheduled', expect.any(Date), [
      'ACTIVE',
    ]);
    expect(processSpy).toHaveBeenNthCalledWith(2, 'broadcast-1', 'scheduled', expect.any(Date), [
      'ACTIVE',
    ]);
  });

  it('stores future chat broadcast in managed schedules', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: true,
        imageBase64: Buffer.from('test-image').toString('base64'),
        imageMimeType: 'image/jpeg',
        imageFileName: 'photo.jpg',
        sendAt: '2026-03-03T11:00:00.000Z',
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.managedBroadcast.create).toHaveBeenCalledTimes(1);
    expect(prisma.managedBroadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceChatId: 'chat-1',
          imageEnabled: true,
          imageMimeType: 'image/jpeg',
          imageFileName: 'photo.jpg',
          nextSendAt: new Date('2026-03-03T11:00:00.000Z'),
          cycleEnabled: false,
          cycleCount: 1,
          sentCount: 0,
        }),
      }),
    );
    expect(result.sendAt).toBe('2026-03-03T11:00:00.000Z');
    expect(result.nextSendAt).toBe('2026-03-03T11:00:00.000Z');
    expect(result.scheduleId).toBe('broadcast-1');
    expect(result.sentChats).toBe(0);
    expect(result.failedChats).toBe(0);
  });

  it('overwrites conflicting calendar slots from an older broadcast', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const conflictBroadcast = {
      id: 'broadcast-conflict',
      sourceChatId: 'chat-1',
      entityType: 'CHAT',
      actorUserId: 'admin-1',
      text: 'Старая рассылка',
      textFormat: 'plain',
      applyToAllChats: false,
      targetChatIds: ['chat-1'],
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      nextSendAt: new Date('2026-03-03T12:00:00.000Z'),
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 2,
      sentCount: 0,
      status: 'ACTIVE',
      lastError: null,
      lockedAt: null,
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    };
    const originalManagedBroadcastUpdate = prisma.managedBroadcast.update;
    prisma.managedBroadcast.findMany.mockImplementation(
      async ({ where }: { where?: { id?: { in?: string[] } } }) =>
        where?.id?.in?.includes(conflictBroadcast.id) ? [conflictBroadcast] : [],
    );
    prisma.managedBroadcast.update.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        if (where.id === conflictBroadcast.id) {
          Object.assign(conflictBroadcast, data);
          return conflictBroadcast;
        }

        return originalManagedBroadcastUpdate({
          where,
          data,
        } as never);
      },
    );

    const occurrences = wireManagedBroadcastOccurrenceStore(prisma, [
      {
        id: 'occurrence-conflict-1',
        broadcastId: 'broadcast-conflict',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        occurrenceIndex: 1,
        scheduledAt: new Date('2026-03-03T12:00:00.000Z'),
        status: 'ACTIVE',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      },
      {
        id: 'occurrence-conflict-2',
        broadcastId: 'broadcast-conflict',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        occurrenceIndex: 2,
        scheduledAt: new Date('2026-03-03T13:00:00.000Z'),
        status: 'ACTIVE',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      },
    ]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Новая рассылка',
        textFormat: 'plain',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-03-03T12:00:00.000Z'],
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(result.scheduleId).toBe('broadcast-1');
    expect(result.scheduledSlots).toEqual(['2026-03-03T12:00:00.000Z']);
    expect(conflictBroadcast.nextSendAt).toEqual(new Date('2026-03-03T13:00:00.000Z'));
    expect(conflictBroadcast.cycleCount).toBe(1);
    expect(occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          broadcastId: 'broadcast-conflict',
          occurrenceIndex: 1,
          scheduledAt: new Date('2026-03-03T13:00:00.000Z'),
        }),
        expect.objectContaining({
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          scheduledAt: new Date('2026-03-03T12:00:00.000Z'),
        }),
      ]),
    );
    expect(
      occurrences.some(
        (occurrence) =>
          occurrence.broadcastId === 'broadcast-conflict' &&
          occurrence.scheduledAt.getTime() === new Date('2026-03-03T12:00:00.000Z').getTime(),
      ),
    ).toBe(false);
  });

  it('sends first cycle immediately and stores remaining launches', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-broadcast-1', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: true,
        cycleEveryHours: 2,
        cycleCount: 3,
      },
    );

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'chat-1',
      'Напоминание',
      undefined,
    );
    expect(prisma.managedBroadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
          cycleEnabled: true,
          cycleEveryHours: 2,
          cycleCount: 3,
          sentCount: 0,
        }),
      }),
    );
    expect(prisma.managedBroadcast.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'broadcast-1' },
        data: expect.objectContaining({
          nextSendAt: new Date('2026-03-03T12:00:00.000Z'),
          sentCount: 1,
          status: 'ACTIVE',
        }),
      }),
    );
    expect(result.cycleEveryHours).toBe(2);
    expect(result.cycleCount).toBe(3);
    expect(result.nextSendAt).toBe('2026-03-03T12:00:00.000Z');
    expect(result.scheduleId).toBe('broadcast-1');
    expect(result.scheduledOccurrences).toBe(2);
  });

  it('stores partial immediate failures for retry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-2') {
          throw new Error('MAX send failed');
        }
        return { messageId: `mid-${chatId}`, url: null };
      }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      {
        id: 'chat-1',
        title: 'Чат 1',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
      {
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
    ]);

    const result = await service.sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: true,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(result.scheduleId).toBe('broadcast-1');
    expect(result.sentChats).toBe(1);
    expect(result.failedChats).toBe(1);
    expect(prisma.managedBroadcast.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'broadcast-1' },
        data: expect.objectContaining({
          status: 'PARTIAL',
        }),
      }),
    );
  });

  it('retries managed broadcast sends after transient MAX API throttling', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValueOnce({ messageId: 'mid-chat-1', url: null })
        .mockRejectedValueOnce(new Error('MAX API global rate limit exceeded'))
        .mockResolvedValueOnce({ messageId: 'mid-chat-2', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      {
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
    ]);

    const sendPromise = service.sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: true,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    await jest.runAllTimersAsync();
    const result = await sendPromise;

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(3);
    expect(result.sentChats).toBe(2);
    expect(result.failedChats).toBe(0);
  });

  it('retries failed deliveries and completes the broadcast', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    let shouldFailSecondChat = true;
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-2' && shouldFailSecondChat) {
          throw new Error('MAX send failed');
        }
        return {
          messageId: `mid-${chatId}-${shouldFailSecondChat ? 'first' : 'retry'}`,
          url: null,
        };
      }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      {
        id: 'chat-1',
        title: 'Чат 1',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
      {
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
    ]);

    await service.sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: true,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    shouldFailSecondChat = false;
    const result = await service.retryManagedBroadcast('chat-1', 'broadcast-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.failedChats).toBe(0);
    expect(result.deliveredChats).toBe(2);
    expect(result.canRetry).toBe(false);
  });

  it('rescans all managed chats for mass broadcast targets beyond the first refresh window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);

    type AllowlistRow = {
      chat: {
        id: string;
        title: string;
        createdAt: Date;
        entityType: 'CHAT';
      };
    };

    let allowlistRows: AllowlistRow[] = [];
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      title: where.id === 'chat-121' ? 'Хвостовой чат' : 'Чат 1',
      entityType: 'CHAT',
    }));
    prisma.chat.upsert.mockImplementation(
      async ({
        where,
        create,
      }: {
        where: { id: string };
        create: { title?: string; entityType?: string };
      }) => ({
        id: where.id,
        title: create.title ?? where.id,
        createdAt: new Date('2026-03-03T10:00:00.000Z'),
        entityType: create.entityType ?? 'CHAT',
      }),
    );
    prisma.chatAdminAllowlist.findMany.mockImplementation(async (args?: { where?: unknown }) => {
      const where = args?.where as
        | {
            userId?: string;
            chatId?: { in?: string[] };
            chat?: { entityType?: string };
          }
        | undefined;

      let rows = allowlistRows;
      if (Array.isArray(where?.chatId?.in)) {
        rows = rows.filter((row) => where.chatId!.in!.includes(row.chat.id));
      }
      if (typeof where?.chat?.entityType === 'string') {
        rows = rows.filter((row) => row.chat.entityType === where.chat!.entityType);
      }

      return rows;
    });
    prisma.chatAdminAllowlist.upsert.mockImplementation(
      async ({ where }: { where: { chatId_userId: { chatId: string; userId: string } } }) => {
        const chatId = where.chatId_userId.chatId;
        if (!allowlistRows.some((row) => row.chat.id === chatId)) {
          allowlistRows.push({
            chat: {
              id: chatId,
              title: chatId === 'chat-121' ? 'Хвостовой чат' : 'Чат 1',
              createdAt: new Date('2026-03-03T10:00:00.000Z'),
              entityType: 'CHAT',
            },
          });
        }
        return undefined;
      },
    );

    const remoteChats = Array.from({ length: 121 }, (_, index) => ({
      chatId: `chat-${index + 1}`,
      title: index === 120 ? 'Хвостовой чат' : `Чат ${index + 1}`,
      lastEventTime: 500 - index,
      entityType: 'chat' as const,
      link: null,
    }));

    let storedCursor: number | null = null;
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesRefreshCursor: jest.fn().mockImplementation(async () => storedCursor),
      setManagedEntitiesRefreshCursor: jest
        .fn()
        .mockImplementation(async (_userId: string, _entityType: string, cursor: number) => {
          storedCursor = cursor;
        }),
      clearManagedEntitiesRefreshCursor: jest.fn().mockImplementation(async () => {
        storedCursor = null;
      }),
    });

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue(remoteChats),
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1' || chatId === 'chat-121') {
          return ['admin-1'];
        }
        return [];
      }),
      sendMessageImmediateWithId: jest.fn().mockImplementation(async (chatId: string) => ({
        messageId: `mid-${chatId}`,
        url: null,
      })),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: true,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(chatContextCache.clearManagedEntitiesRefreshCursor).toHaveBeenCalledWith(
      'admin-1',
      'chat',
    );
    expect(maxClient.listBotChats).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      'Напоминание',
      undefined,
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      2,
      'chat-121',
      'Напоминание',
      undefined,
    );
    expect(result.targetChats).toBe(2);
    expect(result.sentChats).toBe(2);
    expect(result.failedChats).toBe(0);
  });

  it('finalizes interrupted deliveries with stored message ids without duplicate resend', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['chat-1'],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'FAILED',
        lastError: 'Процесс оборвался после отправки.',
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'SENDING',
        },
      ],
    });
    deliveries[0].status = 'SENDING';
    deliveries[0].remoteMessageId = 'mid-broadcast-1';
    deliveries[0].sentAt = new Date('2026-03-03T10:00:00.000Z');
    deliveries[0].lockedAt = new Date('2026-03-03T09:59:30.000Z');

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.retryManagedBroadcast('chat-1', 'broadcast-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(result.status).toBe('COMPLETED');
    expect(result.deliveredChats).toBe(1);
    expect(result.failedChats).toBe(0);
    expect(result.pendingChats).toBe(0);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'RETRY_BROADCAST_SCHEDULE',
        payload: expect.objectContaining({
          broadcastId: 'broadcast-1',
          reconciledWithoutResend: true,
        }),
      }),
    });
  });

  it('retries calendar slot reservation when another broadcast takes the slot concurrently', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    prisma.managedBroadcastOccurrence.createMany
      .mockRejectedValueOnce({
        code: 'P2002',
        meta: {
          target: 'managed_broadcast_occurrences_slot_key',
        },
      })
      .mockResolvedValue({ count: 1 });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Календарная рассылка',
        textFormat: 'plain',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-03-03T12:00:00.000Z'],
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(prisma.managedBroadcastOccurrence.createMany).toHaveBeenCalledTimes(2);
    expect(result.scheduledSlots).toEqual(['2026-03-03T12:00:00.000Z']);
  });

  it('adds the system comments button for chat broadcasts when the broadcast toggle is enabled', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.upsert.mockResolvedValue({
      chatId: 'chat-1',
      commentsEnabled: true,
      commentsAdminsEnabled: false,
      commentsAllEnabled: false,
      commentsChatBroadcastsEnabled: true,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const buttons = await (
      service as unknown as { resolveBroadcastButtons: Function }
    ).resolveBroadcastButtons('chat-1', 'chat', {
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      includeCustomButton: false,
      customButtonText: '',
      customButtonUrl: '',
    });

    expect(buttons).toMatchObject([[{ text: '💬 Комментарии · 0', type: 'link' }]]);
    const commentsButton = buttons[0]?.[0];
    const commentsStartParam = new URL(commentsButton.url).searchParams.get('startapp');
    const commentsLaunch = decodeBase64UrlJson<{ k: string; c: string; m: string; t: string }>(
      commentsStartParam!.slice(3),
    );

    expect(commentsLaunch).toMatchObject({
      k: 'chat-dialog',
      c: 'chat-1',
      m: 'comments',
    });
  });

  it('stores and queries chat dialog messages inside the thread encoded in the button token', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.upsert.mockResolvedValue({
      chatId: 'chat-1',
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsAllEnabled: false,
      commentsChatBroadcastsEnabled: false,
    });
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      }),
    );
    prisma.auditLog.create.mockResolvedValue({
      id: 'chat-comment-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-06T08:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const threadId = 'chat-thread-1';
    const commentsToken = (
      service as unknown as { buildEntityDialogToken: Function }
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', threadId) as string;
    const commentsTokenPayload = decodeBase64UrlJson<{ d: string }>(commentsToken.slice(4));

    await service.createChatDialogMessage(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Первый комментарий',
      },
    );

    await service.getChatDialog(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      commentsToken,
    );

    const commentAuditCall = prisma.auditLog.create.mock.calls.find(
      (call) => call?.[0]?.data?.action === 'CHANNEL_DIALOG_COMMENT',
    );
    const commentAuditPayload = commentAuditCall?.[0]?.data?.payload as { threadId?: unknown };
    expect(commentAuditPayload.threadId).toBe(commentsTokenPayload.d);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          action: 'CHANNEL_DIALOG_COMMENT',
          payload: {
            path: ['threadId'],
            equals: commentsTokenPayload.d,
          },
        }),
      }),
    );
  });

  it('updates the chat comments button counter after a new comment', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: false,
      }),
    );
    prisma.auditLog.count.mockResolvedValue(7);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'chat-comments-ref-1',
        action: 'AUTO_ATTACH_CHAT_COMMENTS',
        payload: {
          threadId: 'chat-thread-counter',
          deliveryMode: 'replace_with_bot_message',
          replacementMessageId: 'mid-bot-copy-7',
        },
      },
    ]);
    prisma.auditLog.create.mockResolvedValue({
      id: 'chat-comment-counter-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-20T08:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as { buildEntityDialogToken: Function }
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', 'chat-thread-counter') as string;

    await service.createChatDialogMessage(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Комментарий в чате',
      },
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'chat-1',
      'mid-bot-copy-7',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: '💬 Комментарии · 7', type: 'link' })]],
      }),
    );
  });

  it('keeps avatar url on new chat comments and enriches missing avatars from MAX members', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: true,
      }),
    );
    prisma.auditLog.create.mockResolvedValue({
      id: 'chat-comment-2',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-06T08:05:00.000Z'),
    });
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'chat-comment-old-1',
        actorUserId: 'user-2',
        payload: {
          type: 'comments',
          text: 'Старый комментарий',
          authorDisplayName: 'Марина',
        },
        createdAt: new Date('2026-03-06T07:50:00.000Z'),
      },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-2',
            {
              userId: 'user-2',
              displayName: 'Марина',
              avatarUrl: 'https://cdn.max.ru/u/2/avatar-full.jpg',
            },
          ],
        ]),
      ),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const threadId = 'chat-thread-avatars';
    const commentsToken = (
      service as unknown as { buildEntityDialogToken: Function }
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', threadId) as string;

    const created = await service.createChatDialogMessage(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        avatarUrl: 'https://cdn.max.ru/u/1/photo.jpg',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Новый комментарий',
      },
    );

    const loaded = await service.getChatDialog(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      commentsToken,
    );

    const commentAuditCall = prisma.auditLog.create.mock.calls.find(
      (call) => call?.[0]?.data?.action === 'CHANNEL_DIALOG_COMMENT',
    );
    expect(commentAuditCall?.[0]?.data?.payload).toEqual(
      expect.objectContaining({
        authorAvatarUrl: 'https://cdn.max.ru/u/1/photo.jpg',
      }),
    );
    expect(created.message.avatarUrl).toBe('https://cdn.max.ru/u/1/photo.jpg');
    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith('chat-1', ['user-2']);
    expect(loaded.messages[0]).toMatchObject({
      authorUserId: 'user-2',
      avatarUrl: 'https://cdn.max.ru/u/2/avatar-full.jpg',
    });
  });

  it('marks admin authors in chat dialog responses and immediate create results', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: true,
      }),
    );
    prisma.auditLog.create.mockResolvedValue({
      id: 'chat-comment-admin-created',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-06T08:05:00.000Z'),
    });
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'chat-comment-user-2',
        actorUserId: 'user-2',
        payload: {
          type: 'comments',
          text: 'Обычный комментарий',
          authorDisplayName: 'Марина',
        },
        createdAt: new Date('2026-03-06T07:59:00.000Z'),
      },
      {
        id: 'chat-comment-admin-1',
        actorUserId: 'admin-1',
        payload: {
          type: 'comments',
          text: 'Комментарий администратора',
          authorDisplayName: 'Александр',
        },
        createdAt: new Date('2026-03-06T07:54:00.000Z'),
      },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1', 'user-1']),
      getChatMemberProfiles: jest.fn().mockResolvedValue(new Map()),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const threadId = 'chat-thread-admin-accent';
    const commentsToken = (
      service as unknown as { buildEntityDialogToken: Function }
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', threadId) as string;

    const created = await service.createChatDialogMessage(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Админ Алексей',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Комментарий от администратора',
      },
    );

    const loaded = await service.getChatDialog(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Админ Алексей',
        chatTitle: null,
      },
      'comments',
      commentsToken,
    );

    expect(created.message.isAdmin).toBe(true);
    expect(loaded.messages[0]).toMatchObject({
      authorUserId: 'admin-1',
      isAdmin: true,
    });
    expect(loaded.messages[1]).toMatchObject({
      authorUserId: 'user-2',
      isAdmin: false,
    });
  });
});

describe('AdminService.sendChannelBroadcast', () => {
  it('sends immediate broadcast to channel with button and image', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      autoPostButtonsMode: 'OFF',
      postSuggestionsEnabled: false,
      postSuggestionsButtonText: 'Предложить пост',
      commentsEnabled: false,
      engagementPublishedMessageId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-token-channel-1' }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '**Новый выпуск** уже в канале.',
        textFormat: 'markdown',
        applyToAllChats: false,
        buttonEnabled: true,
        buttonUrl: 'https://max.ru/channel/maxim',
        buttonText: 'Открыть выпуск',
        imageEnabled: true,
        imageBase64: Buffer.from('channel-image').toString('base64'),
        imageMimeType: 'image/jpeg',
        imageFileName: 'cover.jpg',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.uploadImage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'channel-1',
      '<p><strong>Новый выпуск</strong> уже в канале.</p>',
      {
        textFormat: 'html',
        buttons: [[{ text: 'Открыть выпуск', type: 'link', url: 'https://max.ru/channel/maxim' }]],
        imagePayload: { token: 'upload-token-channel-1' },
      },
      { immediate: true },
    );
    expect(result.sentChats).toBe(1);
    expect(result.failedChats).toBe(0);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'channel-1',
        actorUserId: 'admin-1',
        action: 'SEND_BROADCAST',
        payload: expect.objectContaining({
          entityType: 'channel',
          applyToAllChats: false,
          sentChats: 1,
        }),
      }),
    });
  });

  it('preserves markdown formatting when channel broadcast has no button', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      autoPostButtonsMode: 'OFF',
      postSuggestionsEnabled: false,
      postSuggestionsButtonText: '📰 Предложить пост',
      commentsEnabled: false,
      engagementPublishedMessageId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-token-channel-1' }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '**Новый выпуск** уже в [канале](https://max.ru/channel/maxim).',
        textFormat: 'markdown',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: '',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'channel-1',
      '<p><strong>Новый выпуск</strong> уже в <a href="https://max.ru/channel/maxim">канале</a>.</p>',
      {
        textFormat: 'html',
      },
      { immediate: true },
    );
  });

  it('publishes nested bold italic underline links in channel broadcasts', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      autoPostButtonsMode: 'OFF',
      postSuggestionsEnabled: false,
      postSuggestionsButtonText: '📰 Предложить пост',
      commentsEnabled: false,
      engagementPublishedMessageId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-token-channel-1' }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '[**_++MAX Docs++_**](https://dev.max.ru/docs-api)',
        textFormat: 'markdown',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: '',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'channel-1',
      '<p><a href="https://dev.max.ru/docs-api"><strong><em><u>MAX Docs</u></em></strong></a></p>',
      {
        textFormat: 'html',
      },
      { immediate: true },
    );
  });

  it('publishes channel broadcast with system comments button in the first message', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      autoPostButtonsMode: 'OFF',
      postSuggestionsEnabled: false,
      postSuggestionsButtonText: '📰 Предложить пост',
      commentsEnabled: true,
      engagementPublishedMessageId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-token-channel-1' }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '**Новый выпуск** уже в канале.',
        textFormat: 'markdown',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: '',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    const [, messageText, options, dispatch] = maxClient.sendMessage.mock.calls[0];
    expect(messageText).toBe('<p><strong>Новый выпуск</strong> уже в канале.</p>');
    expect(dispatch).toEqual({ immediate: true });
    expect(options).toMatchObject({
      textFormat: 'html',
      buttons: [[expect.objectContaining({ text: '💬 Комментарии · 0', type: 'link' })]],
    });
    expect(options.buttons[0][0].url).toContain('https://max.ru/777000_bot?startapp=');
  });

  it('publishes channel broadcast with system suggestion button in the first message', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      autoPostButtonsMode: 'OFF',
      postSuggestionsEnabled: true,
      postSuggestionsButtonText: '📰 Предложить пост',
      commentsEnabled: false,
      engagementPublishedMessageId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-token-channel-1' }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '**Новый выпуск** уже в канале.',
        textFormat: 'markdown',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: '',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    const [, messageText, options, dispatch] = maxClient.sendMessage.mock.calls[0];
    expect(messageText).toBe('<p><strong>Новый выпуск</strong> уже в канале.</p>');
    expect(dispatch).toEqual({ immediate: true });
    expect(options).toMatchObject({
      textFormat: 'html',
      buttons: [[expect.objectContaining({ text: '📰 Предложить пост', type: 'link' })]],
    });
    const suggestStartParam = new URL(String(options.buttons[0][0].url ?? '')).searchParams.get(
      'start',
    );
    expect(suggestStartParam).toMatch(/^cds-/u);
  });

  it('treats past slots from today as already sent for calendar broadcast scheduling', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-18T18:30:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Ночной выпуск',
        textFormat: 'plain',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-03-18T07:00:00.000Z', '2026-03-18T20:00:00.000Z'],
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 2,
      },
    );

    expect(prisma.managedBroadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sentCount: 1,
          cycleCount: 2,
          nextSendAt: new Date('2026-03-18T20:00:00.000Z'),
          status: 'ACTIVE',
        }),
      }),
    );
    expect(prisma.managedBroadcastDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ occurrenceIndex: 2, targetChatId: 'chat-1' })],
      }),
    );
    expect(prisma.managedBroadcastOccurrence.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            occurrenceIndex: 2,
            scheduledAt: new Date('2026-03-18T20:00:00.000Z'),
          }),
        ],
      }),
    );
    expect(result.scheduledSlots).toEqual(['2026-03-18T20:00:00.000Z']);
    expect(result.scheduledOccurrences).toBe(1);
  });

  it('rejects calendar slots that are less than 30 seconds away', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-18T18:29:40.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.sendBroadcast(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          text: 'Слишком близкий слот',
          textFormat: 'plain',
          applyToAllChats: false,
          buttonEnabled: false,
          buttonUrl: '',
          buttonText: 'Открыть',
          imageEnabled: false,
          imageBase64: '',
          imageMimeType: '',
          imageFileName: '',
          scheduleMode: 'calendar',
          scheduleTimezone: 'Europe/Moscow',
          scheduledSlots: ['2026-03-18T18:30:00.000Z'],
          sendAt: null,
          cycleEnabled: false,
          cycleEveryHours: 1,
          cycleCount: 1,
        },
      ),
    ).rejects.toThrow('Ближайший слот должен быть минимум через 30 секунд.');

    expect(prisma.managedBroadcast.create).not.toHaveBeenCalled();
  });

  it('completes a calendar broadcast immediately when all selected slots for today are already past', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-18T18:30:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Поздняя рассылка',
        textFormat: 'plain',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-03-18T07:00:00.000Z', '2026-03-18T15:00:00.000Z'],
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 2,
      },
    );

    expect(prisma.managedBroadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sentCount: 2,
          cycleCount: 2,
          nextSendAt: null,
          status: 'COMPLETED',
        }),
      }),
    );
    expect(prisma.managedBroadcastOccurrence.createMany).not.toHaveBeenCalled();
    expect(result.scheduledSlots).toEqual([]);
    expect(result.nextSendAt).toBeNull();
    expect(result.scheduledOccurrences).toBe(0);
  });
});

describe('AdminService chat rules', () => {
  it('returns persisted chat rules draft with published metadata', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Пишите по теме.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      publishedMessageId: 'mid-rules-1',
      publishedUrl: 'https://max.ru/chats/chat-1/message/123',
      publishedAt: new Date('2026-03-09T10:00:00.000Z'),
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T10:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      resolveMessageLink: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual({
      text: 'Пишите по теме.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      publishedMessageId: 'mid-rules-1',
      publishedUrl: 'https://max.ru/chats/chat-1/message/123',
      publishedAt: '2026-03-09T10:00:00.000Z',
    });
  });

  it('recovers and persists published rules url by message id when it is missing', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Пишите по теме.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      publishedMessageId: 'mid-rules-9',
      publishedUrl: null,
      publishedAt: new Date('2026-03-09T10:00:00.000Z'),
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T10:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/chats/chat-1/message/999'),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(maxClient.resolveMessageLink).toHaveBeenCalledWith('mid-rules-9');
    expect(prisma.chatRules.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: {
        publishedUrl: 'https://max.ru/chats/chat-1/message/999',
      },
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(result.publishedUrl).toBe('https://max.ru/chats/chat-1/message/999');
  });

  it('saves draft and publishes new rules post with persisted link', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert
      .mockResolvedValueOnce({
        id: 'rules-1',
        chatId: 'chat-1',
        text: 'Опубликуйте только по теме.',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: true,
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
        createdAt: new Date('2026-03-09T09:00:00.000Z'),
        updatedAt: new Date('2026-03-09T09:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'rules-1',
        chatId: 'chat-1',
        text: 'Опубликуйте только по теме.',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: true,
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
        createdAt: new Date('2026-03-09T09:00:00.000Z'),
        updatedAt: new Date('2026-03-09T09:05:00.000Z'),
      });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-2',
        url: 'https://max.ru/chats/chat-1/message/456',
      }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      resolveMessageLink: jest.fn(),
      uploadImage: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const savedDraft = await service.updateRules(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Опубликуйте только по теме.',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: true,
      },
    );

    expect(savedDraft.text).toBe('Опубликуйте только по теме.');
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        action: 'UPDATE_CHAT_RULES',
        payload: expect.objectContaining({
          source: 'miniapp',
        }),
      }),
    });

    const published = await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      'Опубликуйте только по теме.',
      {
        textFormat: 'markdown',
      },
    );
    expect(prisma.chatRules.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: expect.objectContaining({
        publishedMessageId: 'mid-rules-2',
        publishedUrl: 'https://max.ru/chats/chat-1/message/456',
        publishedAt: expect.any(Date),
      }),
    });
    expect(published).toEqual({
      chatId: 'chat-1',
      messageId: 'mid-rules-2',
      url: 'https://max.ru/chats/chat-1/message/456',
      publishedAt: expect.any(String),
    });
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      '✅ Правила опубликованы.\nhttps://max.ru/chats/chat-1/message/456',
      undefined,
      { immediate: true },
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          action: 'PUBLISH_CHAT_RULES',
          payload: expect.objectContaining({
            source: 'miniapp',
          }),
        }),
      }),
    );
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
  });

  it('publishes rules even when MAX does not return a direct post link', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Правила без прямой ссылки.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-3',
        url: null,
      }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      resolveMessageLink: jest.fn().mockResolvedValue(null),
      uploadImage: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const published = await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(prisma.chatRules.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: expect.objectContaining({
        publishedMessageId: 'mid-rules-3',
        publishedUrl: null,
        publishedAt: expect.any(Date),
      }),
    });
    expect(published).toEqual({
      chatId: 'chat-1',
      messageId: 'mid-rules-3',
      url: null,
      publishedAt: expect.any(String),
    });
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      '✅ Правила опубликованы.',
      undefined,
      { immediate: true },
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      'Правила без прямой ссылки.',
      {
        textFormat: 'markdown',
      },
    );
  });

  it('records private bot as the rules source in audit log payloads', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Правила от бота',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      publishedMessageId: 'mid-rules-7',
      publishedUrl: 'https://max.ru/chats/chat-1/message/777',
      publishedAt: new Date('2026-03-09T11:00:00.000Z'),
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T11:00:00.000Z'),
    });
    prisma.chatRules.update.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Правила от бота',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T11:05:00.000Z'),
    });

    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      resolveMessageLink: jest.fn(),
      uploadImage: jest.fn(),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-7',
        url: 'https://max.ru/chats/chat-1/message/777',
      }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const actor = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.updateRules(
      'chat-1',
      actor,
      {
        text: 'Правила от бота',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: false,
      },
      'private_bot',
    );
    await service.publishRules('chat-1', actor, 'private_bot');
    await service.resetPublishedRules('chat-1', actor, 'private_bot');

    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'UPDATE_CHAT_RULES',
          payload: expect.objectContaining({ source: 'private_bot' }),
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'PUBLISH_CHAT_RULES',
          payload: expect.objectContaining({ source: 'private_bot' }),
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'RESET_CHAT_RULES_PUBLICATION',
          payload: expect.objectContaining({ source: 'private_bot' }),
        }),
      }),
    );
  });

  it('resets published rules and deletes the existing MAX post', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Правила чата',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      publishedMessageId: 'mid-rules-4',
      publishedUrl: 'https://max.ru/chats/chat-1/message/654',
      publishedAt: new Date('2026-03-09T11:00:00.000Z'),
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T11:00:00.000Z'),
    });
    prisma.chatRules.update.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Правила чата',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T11:05:00.000Z'),
    });

    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      resolveMessageLink: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.resetPublishedRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-rules-4', {
      immediate: true,
    });
    expect(prisma.chatRules.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: {
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
      },
    });
    expect(result).toEqual({
      text: 'Правила чата',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        action: 'RESET_CHAT_RULES_PUBLICATION',
        payload: expect.objectContaining({
          source: 'miniapp',
        }),
      }),
    });
  });
});

describe('AdminService.publishChannelEngagementMessage', () => {
  it('publishes channel buttons as MAX deep links with a dedicated post thread', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-1', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.publishChannelEngagementMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Нажмите кнопку ниже.',
        commentsButtonText: 'Комментарии',
        suggestButtonText: 'Предложить пост',
      },
    );

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    const [, , options] = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0] ?? [];
    const commentsButton = options.buttons?.[0]?.[0];
    const suggestButton = options.buttons?.[1]?.[0];

    expect(options.buttons).toHaveLength(2);
    expect(options.buttons?.[0]).toHaveLength(1);
    expect(options.buttons?.[1]).toHaveLength(1);
    expect(commentsButton).toMatchObject({
      type: 'link',
      text: 'Комментарии · 0',
    });
    expect(suggestButton).toMatchObject({
      type: 'link',
      text: 'Предложить пост',
    });
    expect(commentsButton.url).toContain('https://max.ru/777000_bot?startapp=');
    expect(suggestButton.url).toContain('https://max.ru/777000_bot?start=');

    const commentsUrl = new URL(commentsButton.url);
    const commentsStartParam = commentsUrl.searchParams.get('startapp');
    const suggestStartParam = new URL(suggestButton.url).searchParams.get('start');

    expect(commentsStartParam).toMatch(/^cd-/u);
    expect(suggestStartParam).toMatch(/^cds-/u);
    expect(suggestStartParam!.length).toBeLessThanOrEqual(128);

    const commentsLaunch = decodeBase64UrlJson<{ c: string; m: string; t: string }>(
      commentsStartParam!.slice(3),
    );
    const commentsToken = decodeBase64UrlJson<{ d: string; s: string }>(commentsLaunch.t.slice(4));
    const parsedSuggestLaunch = service.parseChannelSuggestionStartPayload(suggestStartParam);
    const suggestToken = decodeBase64UrlJson<{ d: string; s: string }>(
      parsedSuggestLaunch!.token.slice(4),
    );

    expect(commentsLaunch).toMatchObject({
      c: 'channel-1',
      m: 'comments',
    });
    expect(parsedSuggestLaunch).toMatchObject({
      chatId: 'channel-1',
      token: expect.stringMatching(/^cdt-/u),
    });
    expect(commentsLaunch.t).toMatch(/^cdt-/u);
    expect(commentsToken.d).toBe(suggestToken.d);
    expect(commentsToken.s).not.toBe(suggestToken.s);

    const publishAuditPayload = prisma.auditLog.create.mock.calls[0]?.[0]?.data?.payload as {
      messageId?: unknown;
      threadId?: unknown;
    };
    expect(publishAuditPayload.messageId).toBe('mid-channel-engagement-1');
    expect(publishAuditPayload.threadId).toBe(commentsToken.d);
    expect(prisma.channelSettings.update).toHaveBeenCalledWith({
      where: { chatId: 'channel-1' },
      data: {
        engagementPublishedMessageId: 'mid-channel-engagement-1',
        engagementPublishedThreadId: commentsToken.d,
        engagementPublishedAt: expect.any(Date),
      },
    });
  });

  it('publishes only the selected engagement button rows', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-2', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.publishChannelEngagementMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Нажмите кнопку ниже.',
        commentsButtonText: 'Комментарии',
        suggestButtonText: 'Предложить пост',
        includeCommentsButton: false,
        includeSuggestButton: true,
      },
    );

    const [, , options] = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0] ?? [];
    expect(options.buttons).toHaveLength(1);
    expect(options.buttons?.[0]).toHaveLength(1);
    expect(options.buttons?.[0]?.[0]).toMatchObject({
      type: 'link',
      text: 'Предложить пост',
    });
  });

  it('rejects publishing when all engagement buttons are disabled', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-3', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.publishChannelEngagementMessage(
        'channel-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          text: 'Нажмите кнопку ниже.',
          commentsButtonText: 'Комментарии',
          suggestButtonText: 'Предложить пост',
          includeCommentsButton: false,
          includeSuggestButton: false,
        },
      ),
    ).rejects.toThrow();

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('stores and queries dialog messages inside the thread encoded in the button token', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'message-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-06T08:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-4', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.publishChannelEngagementMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Нажмите кнопку ниже.',
        commentsButtonText: 'Комментарии',
        suggestButtonText: 'Предложить пост',
      },
    );

    const [, , options] = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0] ?? [];
    const commentsButton = options.buttons?.[0]?.[0];
    const commentsStartParam = new URL(commentsButton.url).searchParams.get('startapp');
    const commentsLaunch = decodeBase64UrlJson<{ t: string }>(commentsStartParam!.slice(3));
    const commentsToken = commentsLaunch.t;
    const commentsTokenPayload = decodeBase64UrlJson<{ d: string }>(commentsToken.slice(4));

    await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Первый комментарий',
      },
    );

    await service.getChannelDialog(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      commentsToken,
    );

    const commentAuditPayload = prisma.auditLog.create.mock.calls[1]?.[0]?.data?.payload as {
      threadId?: unknown;
    };
    expect(commentAuditPayload.threadId).toBe(commentsTokenPayload.d);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'channel-1',
          action: 'CHANNEL_DIALOG_COMMENT',
          payload: {
            path: ['threadId'],
            equals: commentsTokenPayload.d,
          },
        }),
      }),
    );
  });

  it('stores a reply preview snapshot when posting a channel comment reply', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'comment-root-1',
      payload: {
        text: 'Исходный комментарий для ответа',
        authorDisplayName: 'Марина',
      },
    });
    prisma.auditLog.create.mockResolvedValue({
      id: 'comment-reply-1',
      actorUserId: 'user-2',
      payload: {},
      createdAt: new Date('2026-03-20T10:15:00.000Z'),
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as { buildEntityDialogToken: Function }
    ).buildEntityDialogToken('channel', 'channel-1', 'comments', 'channel-thread-reply') as string;

    const result = await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-2',
        username: 'user2',
        displayName: 'Ольга',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Отвечаю на исходный комментарий',
        replyToMessageId: 'comment-root-1',
      },
    );

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            replyTo: {
              messageId: 'comment-root-1',
              authorDisplayName: 'Марина',
              text: 'Исходный комментарий для ответа',
            },
          }),
        }),
      }),
    );
    expect(result.message.replyTo).toEqual({
      messageId: 'comment-root-1',
      authorDisplayName: 'Марина',
      text: 'Исходный комментарий для ответа',
    });
    expect(result.message.replyToMessageId).toBe('comment-root-1');
  });

  it('toggles channel comment reactions and returns reactedByMe for the current user', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'comment-1',
      actorUserId: 'user-9',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-reactions',
        text: 'Комментарий с реакциями',
        authorDisplayName: 'Марина',
        reactions: [{ emoji: '👍', userIds: ['user-2'] }],
      },
      createdAt: new Date('2026-03-20T09:00:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'comment-1',
      actorUserId: 'user-9',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-reactions',
        text: 'Комментарий с реакциями',
        authorDisplayName: 'Марина',
        reactions: [{ emoji: '👍', userIds: ['user-2', 'user-1'] }],
      },
      createdAt: new Date('2026-03-20T09:00:00.000Z'),
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as { buildEntityDialogToken: Function }
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-reactions',
    ) as string;

    const result = await service.toggleChannelDialogReaction(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      'comment-1',
      {
        token: commentsToken,
        emoji: '👍',
      },
    );

    expect(prisma.auditLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'comment-1',
        },
        data: expect.objectContaining({
          payload: expect.objectContaining({
            reactions: [{ emoji: '👍', userIds: ['user-2', 'user-1'] }],
          }),
        }),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      message: {
        id: 'comment-1',
        reactionGroups: [{ emoji: '👍', count: 2, reactedByMe: true }],
      },
    });
  });

  it('keeps admin marker on a channel comment after reaction toggle', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'comment-admin-1',
      actorUserId: 'admin-1',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-admin-reactions',
        text: 'Админский комментарий',
        authorDisplayName: 'Александр',
        reactions: [{ emoji: '👍', userIds: ['user-2'] }],
      },
      createdAt: new Date('2026-03-20T09:00:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'comment-admin-1',
      actorUserId: 'admin-1',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-admin-reactions',
        text: 'Админский комментарий',
        authorDisplayName: 'Александр',
        reactions: [{ emoji: '👍', userIds: ['user-2', 'user-3'] }],
      },
      createdAt: new Date('2026-03-20T09:00:00.000Z'),
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as { buildEntityDialogToken: Function }
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-admin-reactions',
    ) as string;

    const result = await service.toggleChannelDialogReaction(
      'channel-1',
      {
        userId: 'user-3',
        username: 'user3',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      'comment-admin-1',
      {
        token: commentsToken,
        emoji: '👍',
      },
    );

    expect(result.message).toMatchObject({
      id: 'comment-admin-1',
      isAdmin: true,
      reactionGroups: [{ emoji: '👍', count: 2, reactedByMe: true }],
    });
  });

  it('keeps only one active reaction per user when switching channel comment reactions', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'comment-2',
      actorUserId: 'user-9',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-reactions',
        text: 'Комментарий со сменой реакции',
        authorDisplayName: 'Марина',
        reactions: [
          { emoji: '👍', userIds: ['user-2', 'user-1'] },
          { emoji: '🔥', userIds: ['user-3'] },
        ],
      },
      createdAt: new Date('2026-03-20T09:00:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'comment-2',
      actorUserId: 'user-9',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-reactions',
        text: 'Комментарий со сменой реакции',
        authorDisplayName: 'Марина',
        reactions: [
          { emoji: '👍', userIds: ['user-2'] },
          { emoji: '🔥', userIds: ['user-3'] },
          { emoji: '❤️', userIds: ['user-1'] },
        ],
      },
      createdAt: new Date('2026-03-20T09:00:00.000Z'),
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as { buildEntityDialogToken: Function }
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-reactions',
    ) as string;

    const result = await service.toggleChannelDialogReaction(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      'comment-2',
      {
        token: commentsToken,
        emoji: '❤️',
      },
    );

    expect(prisma.auditLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'comment-2',
        },
        data: expect.objectContaining({
          payload: expect.objectContaining({
            reactions: expect.arrayContaining([
              { emoji: '👍', userIds: ['user-2'] },
              { emoji: '🔥', userIds: ['user-3'] },
              { emoji: '❤️', userIds: ['user-1'] },
            ]),
          }),
        }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.message.reactionGroups).toEqual(
      expect.arrayContaining([
        { emoji: '👍', count: 1, reactedByMe: false },
        { emoji: '🔥', count: 1, reactedByMe: false },
        { emoji: '❤️', count: 1, reactedByMe: true },
      ]),
    );
  });

  it('updates the published channel comments button counter after a new comment', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.count.mockResolvedValue(4);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'channel-engagement-ref-1',
        action: 'PUBLISH_CHANNEL_ENGAGEMENT',
        payload: {
          messageId: 'mid-channel-engagement-99',
          threadId: 'channel-thread-counter',
          commentsButtonText: 'Комментарии',
          includeCommentsButton: true,
          includeSuggestButton: true,
          suggestButtonText: 'Предложить пост',
        },
      },
    ]);
    prisma.auditLog.create.mockResolvedValue({
      id: 'channel-comment-count-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-20T09:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as { buildEntityDialogToken: Function }
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-counter',
    ) as string;

    await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Новый комментарий в канале',
      },
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-engagement-99',
      null,
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: 'Комментарии · 4', type: 'link' })],
          [expect.objectContaining({ text: 'Предложить пост', type: 'link' })],
        ],
      }),
    );
  });

  it('refreshes suggestion-only auto-attached channel buttons after a new comment', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.count.mockResolvedValue(4);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'channel-auto-suggest-ref-1',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: {
          messageId: 'mid-channel-auto-suggest-99',
          threadId: 'channel-thread-counter',
          includeCommentsButton: false,
          includeSuggestButton: true,
          suggestButtonText: 'Предложить пост',
        },
      },
    ]);
    prisma.auditLog.create.mockResolvedValue({
      id: 'channel-comment-count-2',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-20T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as { buildEntityDialogToken: Function }
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-counter',
    ) as string;

    await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Новый комментарий в канале',
      },
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-auto-suggest-99',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Предложить пост', type: 'link' })]],
      }),
    );
  });

  it('accepts a suggestion from a thread-scoped button even when auto suggestions are disabled', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([
      {
        recipient_chat_id: '555001',
      },
    ]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-10T12:10:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'suggestion-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        text: 'Есть идея для следующего поста',
        delivered: true,
        deliveredToUserId: 'admin-1',
        source: 'miniapp_dialog',
      },
      createdAt: new Date('2026-03-10T12:10:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-5', url: null }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-admin-1', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(service, maxClient);
    const suggestTokenPayload = decodeBase64UrlJson<{ d: string }>(suggestToken.slice(4));

    const result = await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'suggest',
      {
        token: suggestToken,
        text: 'Есть идея для следующего поста',
      },
    );

    expect(result).toMatchObject({
      ok: true,
      message: {
        type: 'suggest',
        text: 'Есть идея для следующего поста',
      },
    });
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'CHANNEL_DIALOG_SUGGESTION',
          payload: expect.objectContaining({
            threadId: suggestTokenPayload.d,
          }),
        }),
      }),
    );
  });

  it('accepts a photo-only suggestion from the mini app and returns pending review metadata', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([
      {
        recipient_chat_id: '555001',
      },
    ]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-image-only-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-25T09:10:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'suggestion-image-only-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        text: '',
        delivered: true,
        deliveredToUserId: 'admin-1',
        reviewStatus: 'pending',
        hasImage: true,
        imageFileName: 'suggestion.webp',
        source: 'miniapp_dialog',
      },
      createdAt: new Date('2026-03-25T09:10:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-6', url: null }),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-suggest-miniapp-1' }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-admin-2', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(service, maxClient);

    const result = await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'suggest',
      {
        token: suggestToken,
        text: '',
        imageBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
        imageMimeType: 'image/png',
        imageFileName: 'suggestion.webp',
      },
    );

    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'suggestion.webp',
      'image/png',
    );
    expect(result).toMatchObject({
      ok: true,
      message: {
        id: 'suggestion-image-only-1',
        type: 'suggest',
        text: '',
        delivered: true,
        reviewStatus: 'pending',
        hasImage: true,
        imageFileName: 'suggestion.webp',
      },
    });
  });

  it('marks bot-submitted suggestions with private_bot source', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([
      {
        recipient_chat_id: '555001',
      },
    ]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-2',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-10T12:11:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-6', url: null }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-admin-2', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(service, maxClient);

    await service.createChannelSuggestionFromBot(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      {
        token: suggestToken,
        text: 'Предложка через бота',
      },
    );

    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'CHANNEL_DIALOG_SUGGESTION',
          payload: expect.objectContaining({
            source: 'private_bot',
          }),
        }),
      }),
    );
  });

  it('rejects a suggestion when the per-user daily limit is reached', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: true,
      postSuggestionsDailyLimit: 2,
    });
    prisma.auditLog.count.mockResolvedValue(2);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-8', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(service, maxClient);

    await expect(
      service.createChannelDialogMessage(
        'channel-1',
        {
          userId: 'user-1',
          username: 'user1',
          displayName: 'Пользователь',
          chatTitle: null,
        },
        'suggest',
        {
          token: suggestToken,
          text: 'Ещё одна идея',
        },
      ),
    ).rejects.toThrow('Лимит предложек для этого канала исчерпан: 2 за последние 24 часа.');

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('delivers bot-submitted suggestions with photo to admins as an image message', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([
      {
        recipient_chat_id: '555001',
      },
    ]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-3',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-10T12:12:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-7', url: null }),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-suggest-1' }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-admin-3', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(service, maxClient);

    await service.createChannelSuggestionFromBot(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      {
        token: suggestToken,
        text: '',
        imageBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
        imageMimeType: 'image/png',
        imageFileName: 'suggestion.png',
      },
    );

    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'suggestion.png',
      'image/png',
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '555001',
      expect.stringContaining('[Пользователь](max://user/user-1)'),
      expect.objectContaining({
        imagePayload: { token: 'upload-suggest-1' },
        textFormat: 'markdown',
        buttons: [
          [
            expect.objectContaining({ text: '📰 В публикацию', type: 'callback' }),
            expect.objectContaining({ text: '✖️ Отклонить', type: 'callback' }),
          ],
        ],
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            source: 'private_bot',
            hasImage: true,
            imageMimeType: 'image/png',
            imageFileName: 'suggestion.png',
          }),
        }),
      }),
    );
  });

  it('skips bot numeric admin id from chat members/me when MAX_BOT_CONTACT_ID is not configured', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-bot-filter-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-25T06:30:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'suggestion-bot-filter-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        text: 'Предложка',
        delivered: true,
        deliveredToUserId: '98315271',
        source: 'private_bot',
      },
      createdAt: new Date('2026-03-25T06:30:00.000Z'),
    });

    const tokenPublisherClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-bot-filter', url: null }),
    };
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['214634783', '98315271']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: '214634783',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      sendMessageImmediateWithId: jest.fn(),
      sendMessageImmediateToUser: jest.fn().mockResolvedValue({
        messageId: 'mid-suggestion-human-admin-1',
        url: null,
        chatId: '165176099',
      }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const config = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'MAX_BOT_TOKEN') {
          return 'test-max-bot-token';
        }
        throw new Error(`Missing key: ${key}`);
      }),
      get: jest.fn((key: string) => {
        if (key === 'APP_BASE_URL') {
          return 'https://maxim.play-team.ru';
        }
        if (key === 'MAX_BOT_ID') {
          return 'id613002203036_4_bot';
        }
        if (key === 'MAX_BOT_CONTACT_ID') {
          return null;
        }
        return null;
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      config as never,
    );

    const tokenPublisher = new AdminService(
      prisma as never,
      tokenPublisherClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(tokenPublisher, tokenPublisherClient);

    await service.createChannelSuggestionFromBot(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      {
        token: suggestToken,
        text: 'Предложка',
      },
    );

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('channel-1', {
      trafficClass: 'interactive',
    });
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledWith(
      '98315271',
      expect.stringContaining('[Пользователь](max://user/user-1)'),
      expect.objectContaining({
        textFormat: 'markdown',
      }),
    );
    expect(prisma.auditLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            deliveredToUserId: '98315271',
            deliveredToUserIds: ['98315271'],
            deliveries: [
              expect.objectContaining({
                adminUserId: '98315271',
                privateChatId: '165176099',
                messageId: 'mid-suggestion-human-admin-1',
              }),
            ],
          }),
        }),
      }),
    );
  });

  it('publishes a reviewed suggestion and removes admin review buttons', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        postSuggestionsButtonText: '📰 Предложить пост',
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'suggestion-review-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        actorUserId: 'user-1',
        authorDisplayName: 'Пользователь',
        text: 'Готовый пост для канала',
        threadId: '11111111-1111-4111-8111-111111111111',
        reviewStatus: 'pending',
        deliveries: [
          {
            adminUserId: 'admin-1',
            privateChatId: '555001',
            messageId: 'mid-admin-review-1',
          },
        ],
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 1200,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/news-max',
        lastEventAt: '2026-03-10T12:00:00.000Z',
        entityType: 'channel',
      }),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-post-1',
        url: 'https://max.ru/chats/channel-1/message/100',
      }),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.reviewChannelSuggestionByAdmin(
      'suggestion-review-1',
      {
        userId: 'admin-1',
        username: 'chief',
        displayName: 'Главный редактор',
        chatTitle: null,
      },
      'publish',
    );

    expect(result).toEqual({
      status: 'reviewed',
      reviewStatus: 'published',
      publishedUrl: 'https://max.ru/chats/channel-1/message/100',
    });
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Готовый пост для канала',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              text: '💬 Комментарии · 0',
              type: 'link',
              url: expect.stringContaining('startapp='),
            }),
          ],
          [
            expect.objectContaining({
              text: '📰 Предложить пост',
              type: 'link',
              url: expect.stringContaining('start=cds-channel-1.'),
            }),
          ],
        ],
      }),
    );
    expect(prisma.auditLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'suggestion-review-1' },
        data: expect.objectContaining({
          payload: expect.objectContaining({
            reviewStatus: 'published',
            reviewedByUserId: 'admin-1',
            reviewedByDisplayName: 'Главный редактор',
            publishedMessageId: 'mid-channel-post-1',
            publishedUrl: 'https://max.ru/chats/channel-1/message/100',
          }),
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'channel-1',
          actorUserId: 'admin-1',
          action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
          payload: expect.objectContaining({
            messageId: 'mid-channel-post-1',
            threadId: '11111111-1111-4111-8111-111111111111',
            includeCommentsButton: true,
            includeSuggestButton: true,
            source: 'suggestion_review',
            suggestButtonText: '📰 Предложить пост',
          }),
        }),
      }),
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      '555001',
      'mid-admin-review-1',
      expect.stringContaining('**Контент публикации**'),
      { buttons: [], textFormat: 'markdown' },
    );
  });

  it('publishes a reviewed photo suggestion with engagement buttons', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        postSuggestionsButtonText: 'Предложить пост',
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'suggestion-review-photo-1',
      chatId: 'channel-1',
      actorUserId: 'user-9',
      payload: {
        type: 'suggest',
        actorUserId: 'user-9',
        authorDisplayName: 'Фотограф',
        text: 'Фото с подписью',
        threadId: '22222222-2222-4222-8222-222222222222',
        reviewStatus: 'pending',
        imageBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
        imageMimeType: 'image/png',
        imageFileName: 'suggestion.png',
        deliveries: [
          {
            adminUserId: 'admin-1',
            privateChatId: '555001',
            messageId: 'mid-admin-review-photo-1',
          },
        ],
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 1200,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/news-max',
        lastEventAt: '2026-03-10T12:00:00.000Z',
        entityType: 'channel',
      }),
      uploadImage: jest.fn().mockResolvedValue({ token: 'uploaded-photo-1' }),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-photo-post-1',
        url: 'https://max.ru/chats/channel-1/message/101',
      }),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.reviewChannelSuggestionByAdmin(
      'suggestion-review-photo-1',
      {
        userId: 'admin-1',
        username: 'chief',
        displayName: 'Главный редактор',
        chatTitle: null,
      },
      'publish',
    );

    expect(result).toEqual({
      status: 'reviewed',
      reviewStatus: 'published',
      publishedUrl: 'https://max.ru/chats/channel-1/message/101',
    });
    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'suggestion.png',
      'image/png',
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Фото с подписью',
      expect.objectContaining({
        imagePayload: { token: 'uploaded-photo-1' },
        buttons: [
          [
            expect.objectContaining({
              text: '💬 Комментарии · 0',
            }),
          ],
          [
            expect.objectContaining({
              text: 'Предложить пост',
            }),
          ],
        ],
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
          payload: expect.objectContaining({
            messageId: 'mid-channel-photo-post-1',
            threadId: '22222222-2222-4222-8222-222222222222',
            includeCommentsButton: true,
            includeSuggestButton: true,
          }),
        }),
      }),
    );
  });

  it('updates the existing published engagement post instead of creating a new one', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      engagementPublishedMessageId: 'mid-existing-engagement-1',
      engagementPublishedThreadId: 'thread-existing-1',
      engagementPublishedAt: new Date('2026-03-10T12:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-new-engagement-1', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.publishChannelEngagementMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Обновленный текст публикации.',
        commentsButtonText: 'Комментарии',
        suggestButtonText: 'Предложить пост',
      },
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-existing-engagement-1',
      'Обновленный текст публикации.',
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      chatId: 'channel-1',
      sent: true,
      messageId: 'mid-existing-engagement-1',
      updatedExisting: true,
      publishedAt: '2026-03-10T12:00:00.000Z',
    });
  });

  it('rejects empty text and photo uploads in channel comments', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-9', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const commentsToken = await publishCommentsDialogToken(service, maxClient);

    await expect(
      service.createChannelDialogMessage(
        'channel-1',
        {
          userId: 'user-1',
          username: 'user1',
          displayName: 'Пользователь',
          chatTitle: null,
        },
        'comments',
        {
          token: commentsToken,
          text: '   ',
        },
      ),
    ).rejects.toThrow('Введите текст комментария.');

    await expect(
      service.createChannelDialogMessage(
        'channel-1',
        {
          userId: 'user-1',
          username: 'user1',
          displayName: 'Пользователь',
          chatTitle: null,
        },
        'comments',
        {
          token: commentsToken,
          text: 'Комментарий',
          imageBase64: 'abc',
          imageMimeType: 'image/png',
          imageFileName: 'comment.png',
        },
      ),
    ).rejects.toThrow('Фото доступно только в предложке.');
  });

  it('rejects channel comments with links when moderation blocks links', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
        commentsModerationEnabled: true,
        commentsBlockLinksEnabled: true,
        commentsAntiSpamEnabled: false,
        commentsLimitTwoInRowEnabled: false,
      }),
    );
    prisma.auditLog.create.mockResolvedValueOnce(undefined);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-5', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const commentsToken = await publishCommentsDialogToken(service, maxClient);

    await expect(
      service.createChannelDialogMessage(
        'channel-1',
        {
          userId: 'user-1',
          username: 'user1',
          displayName: 'Пользователь',
          chatTitle: null,
        },
        'comments',
        {
          token: commentsToken,
          text: 'Вот ссылка https://example.com',
        },
      ),
    ).rejects.toThrow('Ссылки в комментариях отключены.');

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a third consecutive comment when the limit is enabled', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
        commentsModerationEnabled: true,
        commentsBlockLinksEnabled: false,
        commentsAntiSpamEnabled: false,
        commentsLimitTwoInRowEnabled: true,
      }),
    );
    prisma.auditLog.create.mockResolvedValueOnce(undefined);
    prisma.auditLog.findMany
      .mockResolvedValueOnce([
        {
          id: 'comment-2',
          actorUserId: 'user-1',
          payload: {
            text: 'Второй комментарий',
          },
          createdAt: new Date('2026-03-10T10:01:00.000Z'),
        },
        {
          id: 'comment-1',
          actorUserId: 'user-1',
          payload: {
            text: 'Первый комментарий',
          },
          createdAt: new Date('2026-03-10T10:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-7', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const commentsToken = await publishCommentsDialogToken(service, maxClient);

    await expect(
      service.createChannelDialogMessage(
        'channel-1',
        {
          userId: 'user-1',
          username: 'user1',
          displayName: 'Пользователь',
          chatTitle: null,
        },
        'comments',
        {
          token: commentsToken,
          text: 'Третий комментарий',
        },
      ),
    ).rejects.toThrow('Нельзя оставлять больше двух комментариев подряд.');

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
