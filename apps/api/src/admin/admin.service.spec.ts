import {
  channelSettingsSchema,
  chatRulesSchema,
  chatSettingsSchema,
  type ChatSummary,
  type ChannelDialogType,
  type ManagedEntityHeader,
} from '@maxim/contracts';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { buildDuplicateUserPattern } from '../moderation/duplicate-state';
import { buildActiveMuteStateKey } from '../moderation/moderation-state.util';
import { AdminService } from './admin.service';

type ManagedEntityType = 'chat' | 'channel';

type AdminServicePrivateAccess = {
  resolveBroadcastButtons: (
    chatId: string,
    entityType: ManagedEntityType,
    options: Record<string, unknown>,
  ) => Promise<Array<Array<{ text: string; type: string; url: string }>>>;
  buildEntityDialogToken: (
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId?: string | null,
  ) => string;
  resolveChatDialogThreadId: (
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ) => string | null;
};

function createChatSummaryFixture(
  overrides: Partial<ChatSummary> & Pick<ChatSummary, 'id' | 'title' | 'createdAt' | 'entityType'>,
): ChatSummary {
  return {
    id: overrides.id,
    title: overrides.title,
    createdAt: overrides.createdAt,
    entityType: overrides.entityType,
    link: overrides.link ?? null,
    ...(overrides.avatarUrl ? { avatarUrl: overrides.avatarUrl } : {}),
    channelOverview: overrides.channelOverview ?? null,
    primaryBotId: overrides.primaryBotId ?? null,
    assignedBots: overrides.assignedBots ?? [],
    sharedMode: overrides.sharedMode ?? 'owned',
  };
}

function createManagedEntityHeaderFixture(
  overrides: Partial<ManagedEntityHeader> &
    Pick<ManagedEntityHeader, 'id' | 'title' | 'entityType'>,
): ManagedEntityHeader {
  return {
    id: overrides.id,
    title: overrides.title,
    entityType: overrides.entityType,
    link: overrides.link ?? null,
    participantsCount: overrides.participantsCount ?? null,
    ...(overrides.avatarUrl ? { avatarUrl: overrides.avatarUrl } : {}),
    primaryBotId: overrides.primaryBotId ?? null,
    assignedBots: overrides.assignedBots ?? [],
    sharedMode: overrides.sharedMode ?? 'owned',
  };
}

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
    buttons: [],
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
  const matchesManagedBroadcastWhere = (
    where: Record<string, unknown> | undefined,
    state: Record<string, unknown> | null = managedBroadcastState,
  ): boolean => {
    if (!state) {
      return false;
    }
    if (!where) {
      return true;
    }

    if (typeof where.id === 'string' && state.id !== where.id) {
      return false;
    }
    if (typeof where.sourceChatId === 'string' && state.sourceChatId !== where.sourceChatId) {
      return false;
    }
    if (typeof where.entityType === 'string' && state.entityType !== where.entityType) {
      return false;
    }
    if (typeof where.status === 'string' && state.status !== where.status) {
      return false;
    }
    if (where.status && typeof where.status === 'object') {
      const statusFilter = where.status as { in?: string[]; not?: string };
      if (Array.isArray(statusFilter.in) && !statusFilter.in.includes(String(state.status))) {
        return false;
      }
      if (typeof statusFilter.not === 'string' && state.status === statusFilter.not) {
        return false;
      }
    }
    if (where.nextSendAt && typeof where.nextSendAt === 'object' && 'lte' in where.nextSendAt) {
      const nextSendAt = state.nextSendAt instanceof Date ? state.nextSendAt : null;
      if (!nextSendAt || nextSendAt > (where.nextSendAt as { lte: Date }).lte) {
        return false;
      }
    }
    if (where.updatedAt && typeof where.updatedAt === 'object' && 'lte' in where.updatedAt) {
      const updatedAt = state.updatedAt instanceof Date ? state.updatedAt : null;
      if (!updatedAt || updatedAt > (where.updatedAt as { lte: Date }).lte) {
        return false;
      }
    }
    if ('lockedAt' in where) {
      if (where.lockedAt === null && state.lockedAt !== null) {
        return false;
      }
      if (where.lockedAt && typeof where.lockedAt === 'object' && 'lt' in where.lockedAt) {
        const lockedAt = state.lockedAt instanceof Date ? state.lockedAt : null;
        if (!lockedAt || lockedAt >= (where.lockedAt as { lt: Date }).lt) {
          return false;
        }
      }
    }
    if (Array.isArray(where.OR) && !where.OR.some((item) => matchesManagedBroadcastWhere(item))) {
      return false;
    }

    return true;
  };
  const prisma = {
    chat: {
      upsert: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'CHAT',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      update: jest.fn().mockResolvedValue(undefined),
      findMany: jest.fn().mockResolvedValue([]),
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
        commentsEnabled: false,
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
    chatParticipantModerationImmunity: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({
        id: 'immunity-1',
        chatId: 'chat-1',
        userId: 'user-1',
        expiresAt: new Date('2026-04-17T12:00:00.000Z'),
        dailyViolationLimit: 3,
        dailyViolationUsage: 0,
        usageDateKey: '2026-04-15',
        createdByUserId: 'admin-1',
        updatedByUserId: 'admin-1',
        createdAt: new Date('2026-04-15T12:00:00.000Z'),
        updatedAt: new Date('2026-04-15T12:00:00.000Z'),
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
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
      delete: jest.fn().mockResolvedValue(undefined),
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
      updateMany: jest.fn().mockImplementation(
        async ({ where, data }: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
          if (!matchesManagedBroadcastWhere(where)) {
            return { count: 0 };
          }

          managedBroadcastState = {
            ...managedBroadcastState,
            ...data,
          };
          return { count: 1 };
        },
      ),
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
      groupBy: jest.fn().mockResolvedValue([]),
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
      groupBy: jest.fn(),
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(),
  };

  prisma.$transaction = jest.fn(
    (input: unknown[] | ((tx: typeof prisma) => Promise<unknown> | unknown)) => {
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
    if (
      where.occurrenceIndex &&
      typeof where.occurrenceIndex === 'object' &&
      'gt' in where.occurrenceIndex &&
      delivery.occurrenceIndex <= Number((where.occurrenceIndex as { gt: number }).gt)
    ) {
      return false;
    }
    if (
      where.occurrenceIndex &&
      typeof where.occurrenceIndex === 'object' &&
      'lte' in where.occurrenceIndex &&
      delivery.occurrenceIndex > Number((where.occurrenceIndex as { lte: number }).lte)
    ) {
      return false;
    }
    if (typeof where.id === 'string' && delivery.id !== where.id) {
      return false;
    }
    if (typeof where.targetChatId === 'string' && delivery.targetChatId !== where.targetChatId) {
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

    if (typeof where.sourceChatId === 'string' && occurrence.sourceChatId !== where.sourceChatId) {
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
      if (
        Array.isArray(broadcastFilter.in) &&
        !broadcastFilter.in.includes(occurrence.broadcastId)
      ) {
        return false;
      }
      if (
        typeof broadcastFilter.not === 'string' &&
        occurrence.broadcastId === broadcastFilter.not
      ) {
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
    return arg.map((part) => extractSqlText(part)).join(' ');
  }

  if (arg && typeof arg === 'object' && 'strings' in arg) {
    const sqlArg = arg as { strings?: unknown; values?: unknown };
    const strings = sqlArg.strings;
    const values = sqlArg.values;
    const parts: string[] = [];
    if (Array.isArray(strings)) {
      parts.push(strings.map((part) => String(part)).join(' '));
    }
    if (Array.isArray(values)) {
      parts.push(values.map((part) => extractSqlText(part)).join(' '));
    }
    if (parts.length > 0) {
      return parts.filter(Boolean).join(' ');
    }
  }

  return String(arg);
}

function createConfigMock(
  options: { previousToken?: string; botId?: string | null; token?: string } = {},
) {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'MAX_BOT_TOKEN') {
        return options.token ?? 'test-max-bot-token';
      }
      throw new Error(`Missing key: ${key}`);
    }),
    get: jest.fn((key: string) => {
      if (key === 'APP_BASE_URL') {
        return 'https://maxim.play-team.ru';
      }
      if (key === 'MAX_BOT_ID') {
        return options.botId ?? '777000_bot';
      }
      if (key === 'MAX_BOT_CONTACT_ID') {
        return '777000';
      }
      if (key === 'MAX_BOT_TOKEN_PREVIOUS') {
        return options.previousToken ?? null;
      }
      return null;
    }),
  };
}

function createChatContextCacheMock(overrides: Record<string, unknown> = {}) {
  const refreshCursorByScope = new Map<string, number | null>();
  const discoverySnapshotByScope = new Map<string, unknown[] | null>();
  const lastSyncedAtByScope = new Map<string, string | null>();
  const publishedSnapshotByScope = new Map<string, unknown | null>();
  const publishedDiffByScope = new Map<string, unknown | null>();
  const recentBootstrapByEntityType = new Map<string, unknown[] | null>();
  const buildScopeKey = (userId: string, entityType: string) => `${userId}:${entityType}`;
  const buildDiffScopeKey = (userId: string, entityType: string, baseVersion: string) =>
    `${userId}:${entityType}:${baseVersion}`;

  return {
    invalidate: jest.fn().mockResolvedValue(undefined),
    getAdminAccess: jest.fn().mockResolvedValue(null),
    setAdminAccess: jest.fn().mockResolvedValue(undefined),
    getManagedEntityHeader: jest.fn().mockResolvedValue(null),
    setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
    invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
    getManagedEntityBotProfile: jest.fn().mockResolvedValue(null),
    setManagedEntityBotProfile: jest.fn().mockResolvedValue(undefined),
    isManagedEntitiesRefreshCooldownActive: jest.fn().mockResolvedValue(false),
    activateManagedEntitiesRefreshCooldown: jest.fn().mockResolvedValue(undefined),
    isManagedEntitiesRefreshBackoffActive: jest.fn().mockResolvedValue(false),
    getManagedEntitiesRefreshBackoffRemainingMs: jest.fn().mockResolvedValue(0),
    activateManagedEntitiesRefreshBackoff: jest.fn().mockResolvedValue(undefined),
    getManagedEntitiesRefreshCursor: jest
      .fn()
      .mockImplementation(
        async (userId: string, entityType: string) =>
          refreshCursorByScope.get(buildScopeKey(userId, entityType)) ?? null,
      ),
    setManagedEntitiesRefreshCursor: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string, cursor: number) => {
        refreshCursorByScope.set(buildScopeKey(userId, entityType), cursor);
      }),
    clearManagedEntitiesRefreshCursor: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string) => {
        refreshCursorByScope.delete(buildScopeKey(userId, entityType));
      }),
    getManagedEntitiesDiscoverySnapshot: jest
      .fn()
      .mockImplementation(
        async (userId: string, entityType: string) =>
          discoverySnapshotByScope.get(buildScopeKey(userId, entityType)) ?? null,
      ),
    setManagedEntitiesDiscoverySnapshot: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string, snapshot: unknown[]) => {
        discoverySnapshotByScope.set(buildScopeKey(userId, entityType), snapshot);
      }),
    clearManagedEntitiesDiscoverySnapshot: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string) => {
        discoverySnapshotByScope.delete(buildScopeKey(userId, entityType));
      }),
    getManagedEntitiesLastSyncedAt: jest
      .fn()
      .mockImplementation(
        async (userId: string, entityType: string) =>
          lastSyncedAtByScope.get(buildScopeKey(userId, entityType)) ?? null,
      ),
    setManagedEntitiesLastSyncedAt: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string, isoValue: string) => {
        lastSyncedAtByScope.set(buildScopeKey(userId, entityType), isoValue);
      }),
    getManagedEntitiesPublishedSnapshot: jest
      .fn()
      .mockImplementation(
        async (userId: string, entityType: string) =>
          publishedSnapshotByScope.get(buildScopeKey(userId, entityType)) ?? null,
      ),
    setManagedEntitiesPublishedSnapshot: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string, snapshot: unknown) => {
        publishedSnapshotByScope.set(buildScopeKey(userId, entityType), snapshot);
      }),
    clearManagedEntitiesPublishedSnapshot: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string) => {
        publishedSnapshotByScope.delete(buildScopeKey(userId, entityType));
      }),
    getManagedEntitiesPublishedDiff: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string, baseVersion: string) => {
        return publishedDiffByScope.get(buildDiffScopeKey(userId, entityType, baseVersion)) ?? null;
      }),
    setManagedEntitiesPublishedDiff: jest
      .fn()
      .mockImplementation(
        async (userId: string, entityType: string, baseVersion: string, diff: unknown) => {
          publishedDiffByScope.set(buildDiffScopeKey(userId, entityType, baseVersion), diff);
        },
      ),
    getManagedEntitiesRecentBootstrap: jest
      .fn()
      .mockImplementation(
        async (entityType: string) => recentBootstrapByEntityType.get(entityType) ?? [],
      ),
    upsertManagedEntitiesRecentBootstrap: jest
      .fn()
      .mockImplementation(async (item: ChatSummary) => {
        const entityType = item.entityType;
        const current = (recentBootstrapByEntityType.get(entityType) ?? []) as ChatSummary[];
        recentBootstrapByEntityType.set(
          entityType,
          [item, ...current.filter((entry) => entry.id !== item.id)].slice(0, 20),
        );
      }),
    clearManagedEntitiesRecentBootstrapForChat: jest
      .fn()
      .mockImplementation(async (chatId: string, entityType: string | null) => {
        const entityTypes = entityType ? [entityType] : ['chat', 'channel'];
        for (const currentEntityType of entityTypes) {
          const current = (recentBootstrapByEntityType.get(currentEntityType) ?? []) as ChatSummary[];
          recentBootstrapByEntityType.set(
            currentEntityType,
            current.filter((entry) => entry.id !== chatId),
          );
        }
      }),
    ...overrides,
  };
}

async function flushAsyncTasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

function createLocalManagedEntityRow(options: {
  chatId: string;
  title: string;
  entityType: ManagedEntityType;
  createdAt?: string;
}) {
  return {
    chat_id: options.chatId,
    chat_title: options.title,
    chat_type: options.entityType,
    created_at: new Date(options.createdAt ?? '2026-03-02T10:00:00.000Z'),
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
  const parsedSuggestion = service.parseChannelSuggestionStartPayload(suggestStartParam);
  if (!parsedSuggestion) {
    throw new Error('Expected bot suggestion start payload');
  }

  return parsedSuggestion.token;
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
        chatTitle: 'Рабочий чат',
        chatType: 'chat',
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

  it('enriches current admin profile from MAX member data only when explicitly requested', async () => {
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
        { chatId: 'chat-1', enrichFromMax: true },
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
      actionHealthLane: 'background',
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
        { chatId: 'chat-1', entityType: 'chat', enrichFromMax: true },
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
      actionHealthLane: 'background',
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
        { chatId: 'chat-1', entityType: 'chat', enrichFromMax: true },
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
      actionHealthLane: 'background',
    });
  });

  it('returns init data fallback by default when profile enrichment is not explicitly requested', async () => {
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
      username: null,
      displayName: null,
      avatarUrl: null,
      profileUrl: null,
    });
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
  });
});

describe('AdminService dialog admin fallback reads', () => {
  it('routes dialog admin id lookups through background action health lane', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockRejectedValue(
        Object.assign(new Error('Request failed with status code 403'), {
          response: {
            status: 403,
            data: {
              code: 'chat.denied',
              message: 'Request failed with status code 403',
            },
          },
        }),
      ),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect((service as any).readDialogAdminUserIds('chat-1')).resolves.toEqual(new Set());

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1', {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      ignoreFailureMetricStatuses: [403, 404],
    });
  });

  it('uses the chat-bound bot for dialog admin fallback reads when one is assigned', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue([]),
    };
    const maxBotLinkService = {
      resolveBotIdForCapability: jest.fn().mockResolvedValue('id613002203036_4_bot'),
      resolveBotId: jest.fn().mockResolvedValue('id613002203036_bot'),
      getBotTokenSync: jest.fn().mockReturnValue(null),
      getValidationTokens: jest.fn().mockReturnValue([]),
      buildBotStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?start=payload'),
      buildEntryBotStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?start=payload'),
      buildMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?startapp=payload'),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?startapp=payload'),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await expect((service as any).readDialogAdminUserIds('chat-1')).resolves.toEqual(new Set());

    expect(maxBotLinkService.resolveBotIdForCapability).toHaveBeenCalledWith({
      chatId: 'chat-1',
      capability: 'access_prewarm',
    });
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1', {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      ignoreFailureMetricStatuses: [403, 404],
      botId: 'id613002203036_4_bot',
    });
  });
});

describe('AdminService night mode settings normalization', () => {
  it('persists primaryBotId when chat settings upsert resolves a bot assignment', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const maxBotLinkService = {
      resolveBotId: jest.fn().mockResolvedValue('id613002203036_bot'),
      resolveContactIdSync: jest.fn().mockReturnValue(null),
      bindDiscoveredChatBots: jest.fn().mockResolvedValue('id613002203036_bot'),
      getBotTokenSync: jest.fn().mockReturnValue(null),
      getValidationTokens: jest.fn().mockReturnValue([]),
      buildBotStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?start=payload'),
      buildEntryBotStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?start=payload'),
      buildMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?startapp=payload'),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?startapp=payload'),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await service.updateSettings(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      chatSettingsSchema.parse({}),
    );

    expect(prisma.chat.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          botId: 'id613002203036_bot',
          primaryBotId: 'id613002203036_bot',
        }),
        update: expect.objectContaining({
          botId: 'id613002203036_bot',
          primaryBotId: 'id613002203036_bot',
        }),
      }),
    );
  });

  it('persists primaryBotId when channel settings upsert resolves a bot assignment', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Канал MAX',
      entityType: 'CHANNEL',
    });
    const maxBotLinkService = {
      resolveBotId: jest.fn().mockResolvedValue('id613002203036_4_bot'),
      resolveContactIdSync: jest.fn().mockReturnValue(null),
      bindDiscoveredChatBots: jest.fn().mockResolvedValue('id613002203036_4_bot'),
      getBotTokenSync: jest.fn().mockReturnValue(null),
      getValidationTokens: jest.fn().mockReturnValue([]),
      buildBotStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?start=payload'),
      buildEntryBotStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?start=payload'),
      buildMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?startapp=payload'),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?startapp=payload'),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await service.updateChannelSettings(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      channelSettingsSchema.parse({}),
    );

    expect(prisma.chat.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          botId: 'id613002203036_4_bot',
          primaryBotId: 'id613002203036_4_bot',
        }),
        update: expect.objectContaining({
          botId: 'id613002203036_4_bot',
          primaryBotId: 'id613002203036_4_bot',
        }),
      }),
    );
  });

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
    jest
      .spyOn(service as any, 'resolveManualActionBotAssignment')
      .mockResolvedValue('channel-bot-2');

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
    expect(prisma.chat.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
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
        }),
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
        greetingBotButtons: expect.objectContaining({
          0: expect.objectContaining({
            url: expect.objectContaining({
              _errors: expect.arrayContaining([
                'Укажите корректную ссылку для кнопки (http/https).',
              ]),
            }),
          }),
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
        greetingBotButtons: expect.objectContaining({
          0: expect.objectContaining({
            url: expect.objectContaining({
              _errors: expect.arrayContaining([
                'Укажите корректную ссылку для кнопки (http/https).',
              ]),
            }),
          }),
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
        data: expect.objectContaining({
          nightModeBotMessageEnabled: false,
          nightModeCommentsEnabled: false,
          nightModeBotButtonEnabled: false,
          nightModeRulesButtonEnabled: false,
        }),
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

  it('does not probe manual-action bot access while reading chat settings', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      entityType: 'CHAT',
      primaryBotId: 'id613002203036_bot',
      botId: null,
      botMemberships: [],
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      settings: chatSettingsSchema.parse({}),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
      createConfigMock() as never,
    );

    await service.getSettings('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });
});

describe('AdminService required subscription settings', () => {
  const actor = {
    userId: 'admin-1',
    username: null,
    displayName: null,
    chatTitle: null,
  };

  it('normalizes and persists required subscription entity ids on update', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
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

  it('starts a required subscription timer when the block is enabled', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-16T12:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      const maxClient = {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'id613002203036_bot',
          isAdmin: true,
          isOwner: false,
          permissions: [],
        }),
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
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionDurationDays: 10,
      });

      expect(result.requiredSubscriptionDurationDays).toBe(10);
      expect(result.requiredSubscriptionExpiresAt).toBe('2026-04-26T12:00:00.000Z');
      expect(prisma.chat.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            settings: {
              upsert: {
                update: expect.objectContaining({
                  requiredSubscriptionDurationDays: 10,
                  requiredSubscriptionExpiresAt: '2026-04-26T12:00:00.000Z',
                }),
                create: expect.objectContaining({
                  requiredSubscriptionDurationDays: 10,
                  requiredSubscriptionExpiresAt: '2026-04-26T12:00:00.000Z',
                }),
              },
            },
          },
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the existing required subscription timer until channels or days change', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue({
      nightModeForceCloseEnabled: false,
      nightModeForceCloseForever: false,
      nightModeForceCloseHours: 0,
      nightModeForceCloseDays: 0,
      nightModeForceCloseUntil: '',
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-1'],
      requiredSubscriptionDurationDays: 7,
      requiredSubscriptionExpiresAt: '2026-04-24T09:30:00.000Z',
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
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
      requiredSubscriptionChannelIds: ['channel-1'],
      requiredSubscriptionDurationDays: 7,
      requiredSubscriptionBotMessageEnabled: true,
      requiredSubscriptionBotMessageText: 'Новая подсказка.',
    });

    expect(result.requiredSubscriptionExpiresAt).toBe('2026-04-24T09:30:00.000Z');
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          settings: expect.objectContaining({
            upsert: expect.objectContaining({
              update: expect.objectContaining({
                requiredSubscriptionDurationDays: 7,
                requiredSubscriptionExpiresAt: '2026-04-24T09:30:00.000Z',
              }),
            }),
          }),
        }),
      }),
    );
  });

  it('refreshes bot access snapshots for the chat and required subscription chats/channels after settings update', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-remote-1') {
          return {
            chatId,
            title: 'Общий чат',
            participantsCount: 240,
            status: 'active',
            isPublic: true,
            link: 'https://max.ru/chats/chat-remote-1',
            lastEventAt: null,
            entityType: 'chat',
          };
        }

        return {
          chatId,
          title: 'Новости MAX',
          participantsCount: 125,
          status: 'active',
          isPublic: true,
          link: 'https://max.ru/channels/news-max',
          lastEventAt: null,
          entityType: 'channel',
        };
      }),
    };
    const maxBotExecutionPlanner = {
      refreshChatBotCapabilitySnapshots: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotExecutionPlanner as never,
    );

    await service.updateSettings('chat-1', actor, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['chat-remote-1', 'channel-1'],
    });

    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenNthCalledWith(1, {
      chatId: 'chat-1',
      entityType: 'chat',
    });
    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenNthCalledWith(2, {
      chatId: 'chat-remote-1',
      entityType: 'chat',
    });
    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenNthCalledWith(3, {
      chatId: 'channel-1',
      entityType: 'channel',
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
  });

  it('resolves an external required subscription channel by public link when the bot is admin there', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return ['admin-1'];
        }
        return [];
      }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
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
      channel: createManagedEntityHeaderFixture({
        id: 'channel-ext-1',
        title: 'Партнерские новости',
        entityType: 'channel',
        link: 'https://max.ru/channels/partner-news',
        participantsCount: 318,
      }),
    });
    expect(maxClient.listBotChats).toHaveBeenCalledTimes(1);
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      createManagedEntityHeaderFixture({
        id: 'channel-ext-1',
        title: 'Партнерские новости',
        entityType: 'channel',
        link: 'https://max.ru/channels/partner-news',
        participantsCount: 318,
      }),
    );
  });

  it('resolves an external required subscription chat by MAX chat link when the bot is admin there', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return ['admin-1'];
        }
        return [];
      }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'chat-ext-1',
          title: 'Партнерский чат',
          lastEventTime: 1,
          entityType: 'chat',
          link: 'https://max.ru/chats/chat-ext-1',
        },
      ]),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-ext-1',
        title: 'Партнерский чат',
        participantsCount: 318,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/chats/chat-ext-1',
        lastEventAt: null,
        entityType: 'chat',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.resolveRequiredSubscriptionChannel('chat-1', actor, {
      value: 'max.ru/chats/chat-ext-1',
    });

    expect(result).toEqual({
      channel: createManagedEntityHeaderFixture({
        id: 'chat-ext-1',
        title: 'Партнерский чат',
        entityType: 'chat',
        link: 'https://max.ru/chats/chat-ext-1',
        participantsCount: 318,
      }),
    });
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      createManagedEntityHeaderFixture({
        id: 'chat-ext-1',
        title: 'Партнерский чат',
        entityType: 'chat',
        link: 'https://max.ru/chats/chat-ext-1',
        participantsCount: 318,
      }),
    );
  });

  it('resolves an external required subscription channel when the input uses /channel/ but discovery returns /channels/', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return ['admin-1'];
        }
        return [];
      }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'channel-ext-2',
          title: 'Канал партнера',
          lastEventTime: 1,
          entityType: 'channel',
          link: 'https://max.ru/channels/partner-feed',
        },
      ]),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-2',
        title: 'Канал партнера',
        participantsCount: 207,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/partner-feed',
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
      value: 'https://max.ru/channel/partner-feed?from=share',
    });

    expect(result).toEqual({
      channel: createManagedEntityHeaderFixture({
        id: 'channel-ext-2',
        title: 'Канал партнера',
        entityType: 'channel',
        link: 'https://max.ru/channels/partner-feed',
        participantsCount: 207,
      }),
    });
    expect(maxClient.listBotChats).toHaveBeenCalledTimes(1);
  });

  it('retries external required subscription channel discovery without cache when the first lookup misses the channel', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return ['admin-1'];
        }
        return [];
      }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      listBotChats: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            chatId: 'channel-ext-3',
            title: 'Свежий канал',
            lastEventTime: 1,
            entityType: 'channel',
            link: 'https://max.ru/channels/fresh-channel',
          },
        ]),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-3',
        title: 'Свежий канал',
        participantsCount: 88,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/fresh-channel',
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
      value: 'max.ru/channels/fresh-channel',
    });

    expect(result).toEqual({
      channel: createManagedEntityHeaderFixture({
        id: 'channel-ext-3',
        title: 'Свежий канал',
        entityType: 'channel',
        link: 'https://max.ru/channels/fresh-channel',
        participantsCount: 88,
      }),
    });
    expect(maxClient.listBotChats).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        trafficClass: 'interactive',
        sourceTag: 'managed_refresh',
      }),
    );
    expect(maxClient.listBotChats).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        trafficClass: 'interactive',
        sourceTag: 'managed_refresh',
        bypassCache: true,
      }),
    );
  });

  it('resolves an external required subscription channel from a MAX chat post link', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-3',
        title: 'Канал по ссылке на пост',
        participantsCount: 72,
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
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.resolveRequiredSubscriptionChannel('chat-1', actor, {
      value: 'https://max.ru/chats/channel-ext-3/message/100',
    });

    expect(result).toEqual({
      channel: createManagedEntityHeaderFixture({
        id: 'channel-ext-3',
        title: 'Канал по ссылке на пост',
        entityType: 'channel',
        link: null,
        participantsCount: 72,
      }),
    });
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'channel-ext-3',
      expect.objectContaining({
        sourceTag: 'required_subscription_metadata',
      }),
    );
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      createManagedEntityHeaderFixture({
        id: 'channel-ext-3',
        title: 'Канал по ссылке на пост',
        entityType: 'channel',
        link: null,
        participantsCount: 72,
      }),
    );
  });

  it('resolves an external required subscription chat from a MAX chat post link', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-ext-1',
        title: 'Чат по ссылке на пост',
        participantsCount: 72,
        status: 'active',
        isPublic: false,
        link: null,
        lastEventAt: null,
        entityType: 'chat',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.resolveRequiredSubscriptionChannel('chat-1', actor, {
      value: 'https://max.ru/chats/chat-ext-1/message/100',
    });

    expect(result).toEqual({
      channel: createManagedEntityHeaderFixture({
        id: 'chat-ext-1',
        title: 'Чат по ссылке на пост',
        entityType: 'chat',
        link: null,
        participantsCount: 72,
      }),
    });
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'chat-ext-1',
      expect.objectContaining({
        sourceTag: 'required_subscription_metadata',
      }),
    );
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      createManagedEntityHeaderFixture({
        id: 'chat-ext-1',
        title: 'Чат по ссылке на пост',
        entityType: 'chat',
        link: null,
        participantsCount: 72,
      }),
    );
  });

  it('accepts an external required subscription channel on update when the bot is admin there', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
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

    const result = await service.updateSettings('chat-1', actor, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-ext-1'],
    });

    expect(result.requiredSubscriptionChannelIds).toEqual(['channel-ext-1']);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'channel-ext-1',
      expect.objectContaining({
        actionHealthLane: 'background',
        sourceTag: 'required_subscription_metadata',
      }),
    );
  });

  it('accepts an external required subscription chat on update when the bot is admin there', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-ext-1',
        title: 'Партнерский чат',
        participantsCount: 318,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/chats/chat-ext-1',
        lastEventAt: null,
        entityType: 'chat',
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
      requiredSubscriptionChannelIds: ['chat-ext-1'],
    });

    expect(result.requiredSubscriptionChannelIds).toEqual(['chat-ext-1']);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'chat-ext-1',
      expect.objectContaining({
        actionHealthLane: 'background',
        sourceTag: 'required_subscription_metadata',
      }),
    );
  });

  it('binds an external required subscription channel to the bot that actually has access', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue(null);
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockImplementation(
        async (
          _chatId: string,
          options?: {
            botId?: string;
          },
        ) => ({
          userId: options?.botId ?? 'unknown',
          isAdmin: options?.botId === 'id613002203036_4_bot',
          isOwner: false,
          permissions: [],
        }),
      ),
      getChatSnapshot: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return {
            chatId: 'chat-1',
            title: 'Команда MAX',
            participantsCount: 128,
            status: 'active',
            isPublic: false,
            link: null,
            lastEventAt: null,
            entityType: 'chat',
          };
        }

        return {
          chatId: 'channel-ext-2',
          title: 'Канал второго бота',
          participantsCount: 41,
          status: 'active',
          isPublic: true,
          link: 'https://max.ru/channels/second-bot',
          lastEventAt: null,
          entityType: 'channel',
        };
      }),
    };
    const maxBotLinkService = {
      resolveBotId: jest.fn().mockResolvedValue(undefined),
      bindDiscoveredChatBots: jest.fn().mockResolvedValue('id613002203036_4_bot'),
      resolveContactIdSync: jest.fn((botId?: string | null) => {
        if (botId === 'id613002203036_4_bot') {
          return '214634783';
        }
        if (botId === 'id613002203036_bot') {
          return '613002203036';
        }
        return null;
      }),
      getBotTokenSync: jest.fn().mockReturnValue(null),
      getValidationTokens: jest.fn().mockReturnValue([]),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => {
        if (botId === 'id613002203036_bot') {
          return {
            id: 'id613002203036_bot',
            label: 'MAXIM',
            state: 'active',
            speechPersona: 'male',
            characterName: 'Майор Максимов',
          };
        }
        if (botId === 'id613002203036_4_bot') {
          return {
            id: 'id613002203036_4_bot',
            label: 'MAXIM 2',
            state: 'active',
            speechPersona: 'female',
            characterName: 'Майор Максимова',
          };
        }
        return null;
      }),
      getDiscoveryBots: jest
        .fn()
        .mockReturnValue([{ id: 'id613002203036_bot' }, { id: 'id613002203036_4_bot' }]),
      getActionableBots: jest
        .fn()
        .mockReturnValue([{ id: 'id613002203036_bot' }, { id: 'id613002203036_4_bot' }]),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock({ botId: 'id613002203036_bot' }) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      maxBotRegistry as never,
    );

    const result = await service.updateSettings('chat-1', actor, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-ext-2'],
    });

    expect(result.requiredSubscriptionChannelIds).toEqual(['channel-ext-2']);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      1,
      'channel-ext-2',
      expect.objectContaining({
        botId: 'id613002203036_bot',
        sourceTag: 'required_subscription_metadata',
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      2,
      'channel-ext-2',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        sourceTag: 'required_subscription_metadata',
      }),
    );
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'channel-ext-2',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        sourceTag: 'required_subscription_metadata',
      }),
    );
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'channel-ext-2' },
        create: expect.objectContaining({
          botId: 'id613002203036_4_bot',
          primaryBotId: 'id613002203036_4_bot',
        }),
        update: expect.objectContaining({
          botId: 'id613002203036_4_bot',
          primaryBotId: 'id613002203036_4_bot',
        }),
      }),
    );
    expect(maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-ext-2',
        primaryBotId: 'id613002203036_4_bot',
        botIds: ['id613002203036_4_bot'],
      }),
    );
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      createManagedEntityHeaderFixture({
        id: 'channel-ext-2',
        title: 'Канал второго бота',
        entityType: 'channel',
        link: 'https://max.ru/channels/second-bot',
        participantsCount: 41,
        primaryBotId: 'id613002203036_4_bot',
      }),
    );
  });

  it('rejects an external required subscription channel when the bot is not its admin', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return ['admin-1'];
        }
        return [];
      }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: false,
        isOwner: false,
        permissions: [],
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
            'Для обязательной подписки нужны чаты или каналы MAX, где бот состоит администратором и может проверить подписку.',
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
        _errors: ['Выберите хотя бы один чат или канал для обязательной подписки.'],
      },
    });
  });

  it('accepts required subscription channels without a public link when the bot is admin there', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
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
      chatContextCache as never,
      createConfigMock() as never,
    );
    const result = await service.updateSettings('chat-1', actor, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-1'],
    });

    expect(result.requiredSubscriptionChannelIds).toEqual(['channel-1']);
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      createManagedEntityHeaderFixture({
        id: 'channel-1',
        title: 'Новости MAX',
        entityType: 'channel',
        link: null,
        participantsCount: 125,
      }),
    );
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
    const chatContextCache = createChatContextCacheMock();
    const maxBotExecutionPlanner = {
      refreshChatBotCapabilitySnapshots: jest.fn().mockResolvedValue(undefined),
    };

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
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
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotExecutionPlanner as never,
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
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-2');
    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenCalledTimes(3);
    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: 'chat',
    });
    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenCalledWith({
      chatId: 'chat-2',
      entityType: 'chat',
    });
    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenCalledWith({
      chatId: 'channel-1',
      entityType: 'channel',
    });
  });

  it('applies the full night section to every cached chat', async () => {
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

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'getSettings').mockResolvedValue(
      chatSettingsSchema.parse({
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 6 * 60,
        nightModeTimezone: 'Europe/Moscow',
        nightModeBotMessageEnabled: true,
        nightModeBotMessageText: 'Чат закрыт до утра.',
        nightModeCommentsEnabled: true,
        nightModeOpenMessageEnabled: true,
        nightModeOpenMessageText: 'Чат снова открыт.',
        nightModeBotButtonEnabled: true,
        nightModeBotButtonUrl: 'https://max.ru/maxim',
        nightModeBotButtonText: 'Профиль',
        nightModeRulesButtonEnabled: true,
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseHours: 8,
        nightModeForceCloseDays: 0,
        nightModeForceCloseUntil: '2099-03-05T03:00:00.000Z',
      }),
    );

    const result = await service.applySettingsSectionToAllChats('chat-1', actor, {
      section: 'night',
    });

    expect(result.section).toBe('night');
    expect(result.updatedChats).toBe(2);
    expect(result.appliedChatIds).toEqual(['chat-1', 'chat-2']);

    const chat2Call = prisma.chat.upsert.mock.calls.find(
      ([args]) => args?.where?.id === 'chat-2',
    )?.[0];
    expect(chat2Call).toBeDefined();
    expect(chat2Call?.create?.settings?.create).toEqual(
      expect.objectContaining({
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 6 * 60,
        nightModeTimezone: 'Europe/Moscow',
        nightModeBotMessageEnabled: true,
        nightModeBotMessageText: 'Чат закрыт до утра.',
        nightModeCommentsEnabled: true,
        nightModeOpenMessageEnabled: true,
        nightModeOpenMessageText: 'Чат снова открыт.',
        nightModeBotButtonEnabled: true,
        nightModeBotButtonUrl: 'https://max.ru/maxim',
        nightModeBotButtonText: 'Профиль',
        nightModeRulesButtonEnabled: true,
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseHours: 8,
        nightModeForceCloseDays: 0,
        nightModeForceCloseUntil: '2099-03-05T03:00:00.000Z',
      }),
    );
    expect(chat2Call?.update?.settings?.upsert?.update).toEqual(
      expect.objectContaining({
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 6 * 60,
        nightModeTimezone: 'Europe/Moscow',
        nightModeBotMessageEnabled: true,
        nightModeBotMessageText: 'Чат закрыт до утра.',
        nightModeCommentsEnabled: true,
        nightModeOpenMessageEnabled: true,
        nightModeOpenMessageText: 'Чат снова открыт.',
        nightModeBotButtonEnabled: true,
        nightModeBotButtonUrl: 'https://max.ru/maxim',
        nightModeBotButtonText: 'Профиль',
        nightModeRulesButtonEnabled: true,
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseHours: 8,
        nightModeForceCloseDays: 0,
        nightModeForceCloseUntil: '2099-03-05T03:00:00.000Z',
      }),
    );
    expect(chat2Call?.update?.settings?.upsert?.create).toEqual(
      expect.objectContaining({
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 6 * 60,
        nightModeTimezone: 'Europe/Moscow',
        nightModeBotMessageEnabled: true,
        nightModeBotMessageText: 'Чат закрыт до утра.',
        nightModeCommentsEnabled: true,
        nightModeOpenMessageEnabled: true,
        nightModeOpenMessageText: 'Чат снова открыт.',
        nightModeBotButtonEnabled: true,
        nightModeBotButtonUrl: 'https://max.ru/maxim',
        nightModeBotButtonText: 'Профиль',
        nightModeRulesButtonEnabled: true,
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseHours: 8,
        nightModeForceCloseDays: 0,
        nightModeForceCloseUntil: '2099-03-05T03:00:00.000Z',
      }),
    );
  });

  it('uses the full mass-action scan when applying settings to all chats', async () => {
    const prisma = createPrismaMock();
    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const settings = chatSettingsSchema.parse({
      greetingEnabled: true,
      greetingBotMessageEnabled: true,
      greetingBotMessageText: 'Привет!',
    });

    jest.spyOn(service, 'assertChatAdmin').mockResolvedValue(undefined);
    jest
      .spyOn(
        service as unknown as {
          ensureEntityType: (...args: unknown[]) => Promise<void>;
        },
        'ensureEntityType',
      )
      .mockResolvedValue(undefined);
    const massScanSpy = jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Регион 2',
        createdAt: '2026-03-02T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    const result = await service.applySettingsToAllChats('chat-1', actor, settings);

    expect(massScanSpy).toHaveBeenCalledWith(actor);
    expect(result).toEqual({
      sourceChatId: 'chat-1',
      updatedChats: 2,
      appliedChatIds: ['chat-1', 'chat-2'],
    });
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
    prisma.managedPollVote.groupBy
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { optionIndex: 0, _count: { _all: 2 } },
        { optionIndex: 1, _count: { _all: 1 } },
      ])
      .mockResolvedValueOnce([
        { optionIndex: 0, _count: { _all: 2 } },
        { optionIndex: 1, _count: { _all: 1 } },
      ]);

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
      'Опрос\n\nВаш любимый режим?',
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

  it('recreates the poll post when MAX refuses to edit an old published message on close', async () => {
    const prisma = createPrismaMock();
    const activePoll = {
      id: 'poll-chat-1',
      chatId: 'chat-1',
      question: 'Какой режим оставляем?',
      options: ['Соло', 'Сквад'],
      status: 'ACTIVE',
      activeVersion: 4,
      publishedMessageId: 'mid-poll-old',
      publishedUrl: 'https://max.ru/chats/chat-1/message/555',
      publishedAt: new Date('2026-03-10T09:05:00.000Z'),
      closedAt: null,
      createdAt: new Date('2026-03-10T09:00:00.000Z'),
      updatedAt: new Date('2026-03-10T09:05:00.000Z'),
    };
    const closedPoll = {
      ...activePoll,
      status: 'CLOSED',
      publishedMessageId: 'mid-poll-closed',
      publishedUrl: 'https://max.ru/chats/chat-1/message/777',
      closedAt: new Date('2026-03-10T09:15:00.000Z'),
    };

    prisma.managedPoll.upsert.mockResolvedValue(activePoll);
    prisma.managedPoll.update.mockResolvedValue(closedPoll);
    prisma.managedPollVote.groupBy.mockResolvedValue([
      { optionIndex: 0, _count: { _all: 2 } },
      { optionIndex: 1, _count: { _all: 1 } },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-poll-closed',
        url: 'https://max.ru/chats/chat-1/message/777',
      }),
      editMessageInlineKeyboard: jest.fn().mockRejectedValue(
        Object.assign(new Error("can't be edited, too old"), {
          response: {
            status: 400,
            data: {
              message: "can't be edited, too old",
            },
          },
        }),
      ),
      resolveMessageLink: jest.fn().mockResolvedValue(null),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
      createConfigMock() as never,
    );

    const closed = await service.closeChatPoll('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('Соло - 2 (67%)'),
    );
    expect(prisma.managedPoll.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: expect.objectContaining({
        status: 'CLOSED',
        publishedMessageId: 'mid-poll-closed',
        publishedUrl: 'https://max.ru/chats/chat-1/message/777',
      }),
    });
    expect(closed.status).toBe('CLOSED');
    expect(closed.publishedMessageId).toBe('mid-poll-closed');
    expect(closed.publishedUrl).toBe('https://max.ru/chats/chat-1/message/777');
  });

  it('recovers missing published poll url with the assigned bot context', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
      primaryBotId: 'id613002203036_4_bot',
      botId: 'id613002203036_4_bot',
    });
    prisma.managedPoll.upsert.mockResolvedValue({
      id: 'poll-chat-1',
      chatId: 'chat-1',
      question: 'Какой режим оставляем?',
      options: ['Соло', 'Сквад'],
      status: 'ACTIVE',
      activeVersion: 4,
      publishedMessageId: 'mid-poll-old',
      publishedUrl: null,
      publishedAt: new Date('2026-03-10T09:05:00.000Z'),
      closedAt: null,
      createdAt: new Date('2026-03-10T09:00:00.000Z'),
      updatedAt: new Date('2026-03-10T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/chats/chat-1/message/888'),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
      createConfigMock() as never,
    );

    const poll = await service.getChatPoll('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(maxClient.resolveMessageLink).toHaveBeenCalledWith('mid-poll-old', {
      botId: 'id613002203036_4_bot',
    });
    expect(prisma.managedPoll.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: {
        publishedUrl: 'https://max.ru/chats/chat-1/message/888',
      },
    });
    expect(poll.publishedUrl).toBe('https://max.ru/chats/chat-1/message/888');
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
    prisma.moderationEvent.groupBy.mockResolvedValueOnce([
      { action: 'WARN', ruleCode: null, _count: { _all: 3 } },
      { action: 'DELETE_MESSAGE', ruleCode: null, _count: { _all: 4 } },
      { action: 'MUTE', ruleCode: null, _count: { _all: 1 } },
      { action: 'BAN', ruleCode: null, _count: { _all: 1 } },
      { action: 'KICK', ruleCode: null, _count: { _all: 1 } },
      { action: 'NONE', ruleCode: 'MANUAL_UNMUTE', _count: { _all: 1 } },
      { action: 'NONE', ruleCode: 'MANUAL_UNBAN', _count: { _all: 1 } },
    ]);
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

    expect(result.chat).toEqual({ id: 'chat-1', title: 'Команда MAX', avatarUrl: null });
    expect(result.membership).toEqual({ joinedUsers: 5, leftUsers: 2, netUsers: 3 });
    expect(result.violationsSummary).toEqual({
      warn: 3,
      deleteMessage: 4,
      mute: 1,
      ban: 2,
      unmute: 1,
      unban: 1,
      affectedUsers: 2,
      total: 12,
    });
    expect(result.violations).toHaveLength(3);
    expect(result.violations[0]?.userDisplayName).toBe('Алексей');
    expect(result.violations[0]?.avatarUrl).toBe('https://cdn.max.ru/u/1/avatar-full.jpg');
    expect(result.violations[0]?.profileUrl).toBe('https://max.ru/aleksey');
    expect(result.violations[0]?.profileHandoffUrl).toEqual(
      expect.stringContaining('https://max.ru/777000_bot?start=pm'),
    );
    expect(result.violations[1]?.userDisplayName).toBe('Мария');
    expect(result.violations[1]?.avatarUrl).toBe('https://cdn.max.ru/u/2/avatar-full.jpg');
    expect(result.violations[1]?.profileUrl).toBe('https://max.ru/maria');
    expect(result.violations[1]?.profileHandoffUrl).toEqual(
      expect.stringContaining('https://max.ru/777000_bot?start=pm'),
    );
    expect(result.violations[2]?.ruleCode).toBe('MANUAL_UNBAN');
    expect(result.moderationFeed).toEqual({
      items: result.violations,
      hasMore: false,
      nextCursor: null,
    });
    expect(result.activityFeed).toEqual({
      items: [
        {
          id: 'wh-3',
          type: 'joined',
          userId: 'user-3',
          userDisplayName: 'Ирина',
          avatarUrl: 'https://cdn.max.ru/u/3/avatar-full.jpg',
          profileUrl: 'https://max.ru/irina',
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm'),
          createdAt: '2026-03-02T10:00:00.000Z',
        },
        {
          id: 'wh-2',
          type: 'left',
          userId: 'user-2',
          userDisplayName: 'Мария',
          avatarUrl: 'https://cdn.max.ru/u/2/avatar-full.jpg',
          profileUrl: 'https://max.ru/maria',
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm'),
          createdAt: '2026-03-02T09:30:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    const dedupeSqlText = extractSqlText(
      (
        service as unknown as {
          buildMembershipEventDedupeSourceSql: (
            chatId: string,
            from: Date,
            to: Date,
            eventTypes: readonly string[],
          ) => unknown;
        }
      ).buildMembershipEventDedupeSourceSql(
        'chat-1',
        new Date('2026-02-23T12:00:00.000Z'),
        new Date('2026-03-02T12:00:00.000Z'),
        ['user_added', 'user_removed'],
      ),
    );
    expect(dedupeSqlText).toContain('FROM chat_membership_activity_events');
    expect(dedupeSqlText).toContain('event_at AS created_at');
    expect(dedupeSqlText).toContain('ROW_NUMBER() OVER');
    expect(dedupeSqlText).toContain(
      "PARTITION BY chat_id, event_type, COALESCE(user_id, ''), event_at",
    );
    expect(dedupeSqlText).toContain('membership_event_rank = 1');
    expect(dedupeSqlText).toContain('event_type IN');
    expect(dedupeSqlText).toContain('ORDER BY event_at DESC, id DESC');

    const membershipSqlText = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(membershipSqlText).toContain('WITH membership_events AS (');
    expect(membershipSqlText).toContain('user_added');
    expect(membershipSqlText).toContain('user_removed');
    expect(membershipSqlText).not.toContain('bot_added');
    const activitySqlText = extractSqlText(prisma.$queryRaw.mock.calls[2]?.[0]);
    expect(activitySqlText).toContain('WITH membership_events AS (');
    expect(activitySqlText).toContain('ORDER BY created_at');

    expect(prisma.moderationEvent.groupBy).toHaveBeenCalledWith(
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
    prisma.moderationEvent.groupBy.mockResolvedValueOnce([]);
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

    const countArgs = prisma.moderationEvent.groupBy.mock.calls[0]?.[0];
    const createdAt = countArgs.where.createdAt;
    expect(createdAt.gte.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(createdAt.lte.toISOString()).toBe('2026-03-02T12:00:00.000Z');
  });

  it('skips non-requested preview feeds to keep dashboard responses lighter', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([{ joined_users: '1', left_users: '0' }]);
    prisma.moderationEvent.groupBy.mockResolvedValueOnce([]);
    prisma.moderationEvent.findMany.mockResolvedValueOnce([]);

    const service = new AdminService(
      prisma as never,
      { getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']) } as never,
      { invalidate: jest.fn() } as never,
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
      {
        range: '24h',
        includeActivityPreview: false,
        includeModerationPreview: false,
      },
    );

    expect(result.violations).toEqual([]);
    expect(result.moderationFeed).toEqual({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(result.activityFeed).toEqual({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.findMany).toHaveBeenCalledTimes(1);
  });

  it('reuses a short-lived cached dashboard response for identical requests', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ joined_users: '1', left_users: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.moderationEvent.groupBy.mockResolvedValueOnce([]);
    prisma.moderationEvent.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const service = new AdminService(
      prisma as never,
      { getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']) } as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );

    const actor = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    const first = await service.getLogsDashboard('chat-1', actor, { range: '24h' });
    const second = await service.getLogsDashboard('chat-1', actor, { range: '24h' });

    expect(second).toEqual(first);
    expect(prisma.moderationEvent.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('reuses resolved user profiles between dashboard and moderation feed requests', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ joined_users: '0', left_users: '0' }])
      .mockResolvedValueOnce([
        { user_id: 'user-1', sender_name: 'Алексей' },
        { user_id: 'user-2', sender_name: 'Мария' },
      ]);
    prisma.moderationEvent.groupBy.mockResolvedValueOnce([
      {
        action: 'BAN',
        ruleCode: 'MANUAL_BAN',
        _count: { _all: 2 },
      },
    ]);
    prisma.moderationEvent.findMany
      .mockResolvedValueOnce([{ userId: 'user-1' }, { userId: 'user-2' }])
      .mockResolvedValueOnce([
        {
          id: 'evt-ban-2',
          action: 'BAN',
          ruleCode: 'MANUAL_BAN',
          userId: 'user-2',
          createdAt: new Date('2026-03-02T11:00:00.000Z'),
          maskedExcerpt: null,
          metadata: null,
        },
        {
          id: 'evt-ban-1',
          action: 'BAN',
          ruleCode: 'MANUAL_BAN',
          userId: 'user-1',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          maskedExcerpt: null,
          metadata: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'evt-ban-2',
          action: 'BAN',
          ruleCode: 'MANUAL_BAN',
          userId: 'user-2',
          createdAt: new Date('2026-03-02T11:00:00.000Z'),
          maskedExcerpt: null,
          metadata: null,
        },
        {
          id: 'evt-ban-1',
          action: 'BAN',
          ruleCode: 'MANUAL_BAN',
          userId: 'user-1',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          maskedExcerpt: null,
          metadata: null,
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
        ]),
      ),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );
    const actor = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    await service.getLogsDashboard('chat-1', actor, {
      range: '24h',
      includeActivityPreview: false,
      includeModerationPreview: true,
    });
    const moderationFeed = await service.getChatModerationFeed('chat-1', actor, {
      range: '24h',
      filter: 'ALL',
      limit: 50,
    });

    expect(moderationFeed.items).toHaveLength(2);
    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe('AdminService.getChatActivityFeed', () => {
  it('respects filter, limit, cursor and falls back to resolved names without remote profile lookup', async () => {
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
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
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
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
          createdAt: '2026-03-02T10:00:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();

    const activitySqlText = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(activitySqlText).toContain('WITH membership_events AS (');
    expect(activitySqlText).toContain('ORDER BY created_at');
  });

  it('deduplicates membership events produced by different bots for the same user and timestamp', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'wh-join-canonical',
          created_at: new Date('2026-03-02T11:00:00.000Z'),
          event_type: 'user_added',
          user_id: 'user-7',
          sender_name: 'Наталья',
        },
      ])
      .mockResolvedValueOnce([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberProfiles: jest.fn().mockResolvedValue(new Map()),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );

    const result = await service.getChatActivityFeed(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d', filter: 'joined', limit: 20 },
    );

    expect(result).toEqual({
      items: [
        {
          id: 'wh-join-canonical',
          type: 'joined',
          userId: 'user-7',
          userDisplayName: 'Наталья',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
          createdAt: '2026-03-02T11:00:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
  });
});

describe('AdminService.getChatModerationFeed', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('paginates filtered moderation events and keeps local display names on the fast path', async () => {
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
          metadata: { permanent: true },
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
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
        createdAt: '2026-03-02T11:00:00.000Z',
        maskedExcerpt: null,
        metadata: { permanent: true },
      },
      {
        id: 'evt-ban-2',
        action: 'BAN',
        ruleCode: 'LINK_BLOCKED',
        userId: 'user-2',
        userDisplayName: 'Мария',
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
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
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
          createdAt: '2026-03-02T09:00:00.000Z',
          maskedExcerpt: null,
          metadata: { duplicateCount: 4 },
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();

    const firstCall = prisma.moderationEvent.findMany.mock.calls[0]?.[0];
    expect(firstCall.where).toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        action: { in: ['BAN', 'KICK'] },
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

  it('records manual mute without removing the participant from chat', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      kickMember: jest.fn().mockResolvedValue(undefined),
    };
    const redisCounter = {
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      redisCounter as never,
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
      { action: 'MUTE', muteDurationHours: 6 },
    );

    expect(maxClient.cancelScheduledUnban).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(prisma.adminGlobalSpammerExemption.deleteMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-2',
          ruleCode: 'MANUAL_MUTE',
          action: 'MUTE',
          operator: 'ADMIN',
          metadata: expect.objectContaining({
            muteDurationHours: 6,
            muteExpiresAt: expect.any(String),
          }),
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          actorUserId: 'admin-1',
          action: 'MANUAL_MUTE_MEMBER',
        }),
      }),
    );
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      buildActiveMuteStateKey('chat-1', 'user-2'),
      expect.any(String),
      expect.any(Number),
    );
    const cachedMuteState = JSON.parse(redisCounter.setStringWithTtl.mock.calls[0]?.[1]);
    expect(cachedMuteState).toEqual(
      expect.objectContaining({
        durationHours: 6,
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'MUTE',
      userId: 'user-2',
      muteDurationHours: 6,
      muteExpiresAt: expect.any(String),
      message: 'Мут на 6ч.',
    });
  });

  it('fans out manual mute from command to other chats of the admin and clears recent messages in source chat', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw.mockResolvedValueOnce([{ message_id: 'mid-source-1' }]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-2',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
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
      { action: 'MUTE', muteDurationHours: 6 },
      'group_command',
    );

    expect(maxClient.cancelScheduledUnban).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith('chat-2', 'user-2', {
      trafficClass: 'background',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-1', {
      immediate: true,
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-2',
          ruleCode: 'MANUAL_MUTE',
          action: 'MUTE',
          metadata: expect.objectContaining({
            muteDurationHours: 6,
            sourceMessageCleanup: expect.objectContaining({
              candidateCount: 1,
              deletedCount: 1,
              failedCount: 0,
            }),
            crossChatMuteFanout: expect.objectContaining({
              mutedChatsCount: 1,
              mutedChatIds: ['chat-2'],
            }),
          }),
        }),
      }),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-2',
          userId: 'user-2',
          ruleCode: 'MANUAL_MUTE',
          action: 'MUTE',
          metadata: expect.objectContaining({
            fanout: true,
            sourceChatId: 'chat-1',
            muteDurationHours: 6,
          }),
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'MUTE',
      userId: 'user-2',
      muteDurationHours: 6,
      muteExpiresAt: expect.any(String),
      message: 'Мут на 6ч.',
    });
  });

  it('applies permanent manual ban without scheduling auto-unban', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
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
      { action: 'BAN' },
    );

    expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-3', { immediate: true });
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-3');
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
            mode: 'MAX_BLOCK',
            permanent: true,
          }),
        }),
      }),
    );
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Пользователь [user-3](max://user/user-3) забанен.',
      { textFormat: 'markdown' },
      { immediate: true },
    );
    expect(result).toEqual({
      ok: true,
      action: 'BAN',
      userId: 'user-3',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Пользователь забанен.',
    });
  });

  it('fans out miniapp manual ban after source chat cleanup and removes recent messages from the last 24 hours', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([{ message_id: 'mid-source-1' }, { message_id: 'mid-source-2' }])
      .mockResolvedValueOnce([{ message_id: 'mid-fanout-1' }]);

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
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
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
      { action: 'BAN' },
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-3');
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-2', 'user-3');
    expect(maxClient.banMember).toHaveBeenNthCalledWith(1, 'chat-1', 'user-3', {
      immediate: true,
    });
    expect(maxClient.banMember).toHaveBeenNthCalledWith(2, 'chat-2', 'user-3', {
      immediate: true,
    });
    expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(1, 'chat-1', 'mid-source-1', {
      immediate: true,
    });
    expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(2, 'chat-1', 'mid-source-2', {
      immediate: true,
    });
    expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(3, 'chat-2', 'mid-fanout-1', {
      immediate: true,
    });
    expect(maxClient.banMember.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.deleteMessage.mock.invocationCallOrder[0],
    );
    expect(maxClient.deleteMessage.mock.invocationCallOrder[1]).toBeLessThan(
      maxClient.banMember.mock.invocationCallOrder[1],
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-3',
          ruleCode: 'MANUAL_BAN',
          action: 'BAN',
          metadata: expect.objectContaining({
            source: 'miniapp',
            sourceMessageCleanup: {
              candidateCount: 2,
              deletedCount: 2,
              failedCount: 0,
            },
            crossChatFanout: expect.objectContaining({
              removedChatsCount: 1,
              removedChatIds: ['chat-2'],
              deletedMessageCount: 1,
              failedMessageDeleteCount: 0,
            }),
          }),
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'BAN',
      userId: 'user-3',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Пользователь забанен.',
    });
  });

  it('falls back to removal-only permanent manual ban for closed chats without link', async () => {
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
      { action: 'BAN' },
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
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Пользователь удалён.',
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
        { action: 'BAN' },
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
        { action: 'BAN' },
      ),
    ).rejects.toThrow('Пользователь уже не состоит в этом чате.');

    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('still applies manual ban when cancelling a stale auto-unban fails', async () => {
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

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-rollback',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'BAN' },
    );

    expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-rollback', {
      immediate: true,
    });
    expect(maxClient.unbanMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ruleCode: 'MANUAL_BAN',
          action: 'BAN',
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      action: 'BAN',
      userId: 'user-rollback',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Пользователь забанен.',
    });
  });

  it('cancels pending auto-unban before manual unban and records the action', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockResolvedValue(undefined),
    };
    const redisCounter = {
      deleteKeysByPattern: jest.fn().mockResolvedValue(4),
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      redisCounter as never,
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
    expect(redisCounter.deleteKeysByPattern).toHaveBeenCalledWith(
      buildDuplicateUserPattern('chat-1', 'user-4'),
    );
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      buildActiveMuteStateKey('chat-1', 'user-4'),
      '0',
      expect.any(Number),
    );
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
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Участник возвращён в чат и разблокирован.',
    });
  });

  it('uses the resolved chat bot for manual unban in multi-bot chats', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-2',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    (service as any).resolveBotAssignment = jest.fn().mockResolvedValue('bot-2');

    await service.applyManualModerationAction(
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

    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-4',
      expect.objectContaining({
        botId: 'bot-2',
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        botId: 'bot-2',
      }),
    );
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-4', {
      botId: 'bot-2',
    });
    expect(maxClient.unbanMember).toHaveBeenCalledWith('chat-1', 'user-4', {
      immediate: true,
      botId: 'bot-2',
    });
  });

  it('repairs missing chat bot assignment before manual unban', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({ primaryBotId: null, botId: null });
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockRejectedValueOnce({
          response: { status: 403, data: { code: 'chat.denied', message: 'not in chat' } },
        })
        .mockResolvedValueOnce({
          userId: 'bot-2-user',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        })
        .mockResolvedValueOnce({
          userId: 'bot-2-user',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      bindChatToBot: jest.fn().mockResolvedValue('bot-2'),
      resolveBotId: jest.fn().mockResolvedValue('bot-1'),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => {
        if (!botId) {
          return null;
        }
        return { id: botId };
      }),
      getActionableBots: jest.fn().mockReturnValue([{ id: 'bot-1' }, { id: 'bot-2' }]),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      maxBotRegistry as never,
    );
    (service as any).prepareManualModerationTarget = jest.fn().mockResolvedValue('user-4');

    await service.applyManualModerationAction(
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

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        trafficClass: 'interactive',
        botId: 'bot-1',
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        trafficClass: 'interactive',
        botId: 'bot-2',
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: 'CHAT',
      botId: 'bot-2',
    });
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-4', {
      botId: 'bot-2',
    });
    expect(maxClient.unbanMember).toHaveBeenCalledWith('chat-1', 'user-4', {
      immediate: true,
      botId: 'bot-2',
    });
  });

  it('rebinds manual unban to another actionable bot when persisted bot lost admin access', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({ primaryBotId: 'bot-1', botId: 'bot-1' });
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockRejectedValueOnce({
          response: { status: 403, data: { code: 'chat.denied', message: 'not in chat' } },
        })
        .mockResolvedValueOnce({
          userId: 'bot-2-user',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        })
        .mockResolvedValueOnce({
          userId: 'bot-2-user',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      bindChatToBot: jest.fn().mockResolvedValue('bot-2'),
      resolveBotId: jest.fn().mockResolvedValue('bot-1'),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => {
        if (!botId) {
          return null;
        }
        return { id: botId };
      }),
      getActionableBots: jest.fn().mockReturnValue([{ id: 'bot-1' }, { id: 'bot-2' }]),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      maxBotRegistry as never,
    );
    (service as any).prepareManualModerationTarget = jest.fn().mockResolvedValue('user-4');

    await service.applyManualModerationAction(
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

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        trafficClass: 'interactive',
        botId: 'bot-1',
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        trafficClass: 'interactive',
        botId: 'bot-2',
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: 'CHAT',
      botId: 'bot-2',
    });
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-4', {
      botId: 'bot-2',
    });
    expect(maxClient.unbanMember).toHaveBeenCalledWith('chat-1', 'user-4', {
      immediate: true,
      botId: 'bot-2',
    });
  });

  it('releases active block without re-adding a member who is already in chat', async () => {
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
    const redisCounter = {
      deleteKeysByPattern: jest.fn().mockResolvedValue(2),
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      redisCounter as never,
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
    expect(redisCounter.deleteKeysByPattern).toHaveBeenCalledWith(
      buildDuplicateUserPattern('chat-1', 'user-4'),
    );
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      buildActiveMuteStateKey('chat-1', 'user-4'),
      '0',
      expect.any(Number),
    );
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
            mode: 'ALREADY_PRESENT',
          }),
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'UNBAN',
      userId: 'user-4',
      muteDurationHours: null,
      muteExpiresAt: null,
      message:
        'Блокировка снята. Участник уже состоит в чате, повторное добавление не потребовалось.',
    });
  });

  it('returns clear error when bot lacks add_remove_members for manual unban', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['change_chat_info'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn(),
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
        'user-4',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { action: 'UNBAN' },
      ),
    ).rejects.toThrow(
      'У бота нет права MAX add_remove_members, поэтому он не может возвращать участников.',
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-4');
    expect(maxClient.unbanMember).not.toHaveBeenCalled();
  });

  it('returns a clearer fallback when MAX rejects manual unban without details', async () => {
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
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockRejectedValue(new Error('Request failed with status code 400')),
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
        'user-4',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { action: 'UNBAN' },
      ),
    ).rejects.toThrow(
      'MAX отклонил возврат участника в чат. Проверьте тип чата, статус цели и права бота.',
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-4');
    expect(maxClient.unbanMember).toHaveBeenCalledWith('chat-1', 'user-4', { immediate: true });
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
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Пользователь забанен.',
    });
  });

  it('deletes recent tracked messages and removes the member from other managed chats of the admin', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([{ message_id: 'mid-source-1' }, { message_id: 'mid-source-2' }])
      .mockResolvedValueOnce([{ message_id: 'mid-fanout-1' }]);

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
      deleteMessage: jest.fn().mockResolvedValue(undefined),
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
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-2', 'user-3');
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith('chat-2', 'user-3', {
      trafficClass: 'background',
    });
    expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-3', { immediate: true });
    expect(maxClient.banMember).toHaveBeenCalledWith('chat-2', 'user-3', { immediate: true });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-1', {
      immediate: true,
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-2', {
      immediate: true,
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-2', 'mid-fanout-1', {
      immediate: true,
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            recentMessageCleanup: {
              candidateCount: 2,
              deletedCount: 2,
              failedCount: 0,
            },
            crossChatFanout: expect.objectContaining({
              removedChatsCount: 1,
              removedChatIds: ['chat-2'],
              deletedMessageCount: 1,
              failedMessageDeleteCount: 0,
            }),
          }),
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'BAN',
        userId: 'user-3',
      }),
    );
    expect(result.message).toBe('Пользователь забанен.');
  });

  it('uses the resolved chat bot for manual ban fanout in multi-bot chats', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([{ message_id: 'mid-source-1' }])
      .mockResolvedValueOnce([{ message_id: 'mid-fanout-1' }]);

    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1-user',
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
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service as any, 'resolveManualActionBotAssignment')
      .mockImplementation(async (...args: unknown[]) => (args[0] === 'chat-2' ? 'bot-2' : 'bot-1'));

    await service.applyManualSystemBan(
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

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-3', {
      botId: 'bot-1',
    });
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-2', 'user-3', {
      botId: 'bot-2',
    });
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith('chat-2', 'user-3', {
      trafficClass: 'background',
      botId: 'bot-2',
    });
    expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-3', {
      immediate: true,
      botId: 'bot-1',
    });
    expect(maxClient.banMember).toHaveBeenCalledWith('chat-2', 'user-3', {
      immediate: true,
      botId: 'bot-2',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-1', {
      immediate: true,
      botId: 'bot-1',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-2', 'mid-fanout-1', {
      immediate: true,
      botId: 'bot-2',
    });
  });

  it('queues manual mute fanout for group commands when background queue is available', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([{ message_id: 'mid-source-1' }]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-2',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      kickMember: jest.fn().mockResolvedValue(undefined),
    };
    const adminManualFanoutQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      adminManualFanoutQueue as never,
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
      { action: 'MUTE', muteDurationHours: 6 },
      'group_command',
    );

    expect(adminManualFanoutQueue.add).toHaveBeenCalledWith(
      'execute-admin-manual-fanout',
      expect.objectContaining({
        kind: 'manual_mute_fanout',
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        cleanupSourceChatMessages: true,
        muteDurationHours: 6,
        source: 'group_command',
      }),
      expect.objectContaining({
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      }),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          metadata: expect.objectContaining({
            sourceMessageCleanup: expect.objectContaining({
              mode: 'queued',
              candidateCount: 0,
              deletedCount: 0,
            }),
            crossChatMuteFanout: expect.objectContaining({
              mode: 'queued',
              mutedChatsCount: 0,
              mutedChatIds: [],
            }),
          }),
        }),
      }),
    );
    expect(
      prisma.moderationEvent.create.mock.calls.some(
        (call: readonly [Record<string, unknown>]) =>
          (call[0] as { data?: { chatId?: string } }).data?.chatId === 'chat-2',
      ),
    ).toBe(false);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      action: 'MUTE',
      userId: 'user-2',
      muteDurationHours: 6,
      muteExpiresAt: expect.any(String),
      message: 'Мут на 6ч.',
    });
  });

  it('deletes source chat messages during queued manual mute fanout processing', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw.mockResolvedValueOnce([{ message_id: 'mid-source-1' }]);

    const maxClient = {
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-2',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service as any, 'resolveManualActionBotAssignment')
      .mockResolvedValue('bot-1');

    await service.processManualModerationFanoutJob({
      kind: 'manual_mute_fanout',
      jobId: 'job-mute-1',
      sourceChatId: 'chat-1',
      targetUserId: 'user-2',
      cleanupSourceChatMessages: true,
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: null,
        chatTitle: null,
      },
      muteDurationHours: 6,
      muteExpiresAt: '2026-04-08T22:18:25.418Z',
      source: 'group_command',
    });

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-1', {
      immediate: true,
      botId: 'bot-1',
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-2',
          ruleCode: 'MANUAL_MUTE',
        }),
      }),
    );
  });

  it('queues manual ban fanout for group commands when background queue is available', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([
      { message_id: 'mid-source-1' },
      { message_id: 'mid-source-2' },
    ]);
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
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };
    const adminManualFanoutQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      adminManualFanoutQueue as never,
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

    expect(adminManualFanoutQueue.add).toHaveBeenCalledWith(
      'execute-admin-manual-fanout',
      expect.objectContaining({
        kind: 'manual_ban_fanout',
        sourceChatId: 'chat-1',
        targetUserId: 'user-3',
        source: 'group_command',
      }),
      expect.objectContaining({
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      }),
    );
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledTimes(1);
    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            recentMessageCleanup: expect.objectContaining({
              mode: 'queued',
              candidateCount: 0,
              deletedCount: 0,
            }),
            crossChatFanout: expect.objectContaining({
              mode: 'queued',
              removedChatsCount: 0,
              removedChatIds: [],
              deletedMessageCount: 0,
            }),
          }),
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'BAN',
        userId: 'user-3',
      }),
    );
    expect(result.message).toBe('Пользователь забанен.');
  });

  it('deletes source chat messages during queued manual ban fanout processing', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([{ message_id: 'mid-source-1' }, { message_id: 'mid-source-2' }])
      .mockResolvedValueOnce([{ message_id: 'mid-fanout-1' }]);

    const maxClient = {
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
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service as any, 'resolveManualActionBotAssignment')
      .mockImplementation(async (...args: unknown[]) => (args[0] === 'chat-2' ? 'bot-2' : 'bot-1'));

    await service.processManualModerationFanoutJob({
      kind: 'manual_ban_fanout',
      jobId: 'job-1',
      sourceChatId: 'chat-1',
      targetUserId: 'user-3',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: null,
        chatTitle: null,
      },
      source: 'group_command',
    });

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-1', {
      immediate: true,
      botId: 'bot-1',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-2', {
      immediate: true,
      botId: 'bot-1',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-2', 'mid-fanout-1', {
      immediate: true,
      botId: 'bot-2',
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
      sendMessage: jest.fn().mockResolvedValue(undefined),
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
        message: 'Пользователь забанен.',
      }),
    );

    expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-3', { immediate: true });
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Пользователь [user-3](max://user/user-3) забанен.',
      { textFormat: 'markdown' },
      { immediate: true },
    );
  });
});

describe('AdminService.listChannels', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns channel overview summary for each managed channel', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'channel-1',
        title: 'Новости MAX',
        entityType: 'channel',
        createdAt: '2026-03-02T10:00:00.000Z',
      }),
      createLocalManagedEntityRow({
        chatId: 'channel-2',
        title: 'Обновления MAX',
        entityType: 'channel',
        createdAt: '2026-03-01T10:00:00.000Z',
      }),
    ]);
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
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const discovered = await (service as any).runManagedEntitiesLocalDiscovery(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'channel',
      (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'channel'),
      {
        respectCooldown: false,
        fullScan: true,
      },
    );
    const result = await (service as any).hydrateManagedEntities(discovered.items);

    expect(result).toEqual([
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 2,
          commentsEnabled: true,
          postSuggestionsEnabled: true,
          commentsModerationEnabled: true,
        },
      }),
      createChatSummaryFixture({
        id: 'channel-2',
        title: 'Обновления MAX',
        createdAt: '2026-03-01T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
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
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'chat-1',
        title: 'Команда MAX',
        entityType: 'chat',
        createdAt: '2026-03-02T11:00:00.000Z',
      }),
      createLocalManagedEntityRow({
        chatId: 'channel-1',
        title: 'Новости MAX',
        entityType: 'channel',
        createdAt: '2026-03-02T10:00:00.000Z',
      }),
    ]);
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const discovered = await (service as any).runManagedEntitiesLocalDiscovery(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'channel',
      (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'channel'),
      {
        respectCooldown: false,
        fullScan: true,
      },
    );

    await expect((service as any).hydrateManagedEntities(discovered.items)).resolves.toEqual([
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
    ]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
      }),
    );
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
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Кэш канала',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 1,
          commentsEnabled: false,
          postSuggestionsEnabled: true,
          commentsModerationEnabled: false,
        },
      }),
    ]);
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
  });

  it('does not block default channel load on live snapshot hydration', async () => {
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

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'channel-1',
          title: 'Кэш канала',
          lastEventTime: 100,
          entityType: 'channel',
          link: null,
          avatarUrl: null,
        },
      ]),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Кэш канала',
        participantsCount: 321,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channel-1',
        lastEventAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        avatarUrl: 'https://i.oneme.ru/channel-1.webp',
      }),
      getChatAdminIds: jest.fn(),
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
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Кэш канала',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
    ]);

    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
    expect(chatContextCache.setManagedEntityHeader).not.toHaveBeenCalled();
  });

  it('persists a presentable remote managed-entity title while priming headers', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await (service as any).primeManagedEntityHeaders(
      [
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Chat chat-1',
          createdAt: '2026-04-05T00:20:07.272Z',
          entityType: 'chat',
          primaryBotId: 'id613002203036_bot',
        }),
      ],
      [
        {
          chatId: 'chat-1',
          title: 'Продукция для общепита | РФ',
          entityType: 'chat',
          link: 'https://max.ru/chat-1',
          avatarUrl: 'https://i.oneme.ru/chat-1.webp',
          lastEventTime: 1,
        },
      ],
    );

    expect(prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      data: { title: 'Продукция для общепита | РФ' },
    });
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'chat-1',
        title: 'Продукция для общепита | РФ',
        entityType: 'chat',
        link: 'https://max.ru/chat-1',
        participantsCount: null,
        avatarUrl: 'https://i.oneme.ru/chat-1.webp',
        primaryBotId: 'id613002203036_bot',
      }),
    );
  });

  it('revalidates cached channels during refresh and checks admin for current scan window candidates', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'channel-2',
        title: 'Новый канал',
        entityType: 'channel',
        createdAt: '2026-03-03T10:00:00.000Z',
      }),
    ]);
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
    prisma.chat.upsert.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      title: where.id === 'channel-1' ? 'Кэш канала' : 'Новый канал',
      createdAt:
        where.id === 'channel-1'
          ? new Date('2026-03-02T10:00:00.000Z')
          : new Date('2026-03-03T10:00:00.000Z'),
      entityType: 'CHANNEL',
    }));
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
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

    const discovered = await (service as any).runManagedEntitiesLocalDiscovery(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'channel',
      (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'channel'),
      {
        respectCooldown: false,
        fullScan: true,
      },
    );

    await expect((service as any).hydrateManagedEntities(discovered.items)).resolves.toEqual([
      createChatSummaryFixture({
        id: 'channel-2',
        title: 'Новый канал',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Кэш канала',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
    ]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'channel-2',
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
      }),
    );
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
        primaryBotId: null,
        assignedBots: [],
        sharedMode: 'owned',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
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
      45,
    );
  });

  it('falls back to cached channels and backs off refresh after MAX API throttling', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'remote-channel-1',
        title: 'Удалённый канал',
        entityType: 'channel',
      }),
    ]);
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
      getChatAdminIds: jest.fn().mockRejectedValue({
        response: {
          status: 429,
          data: {
            code: 'rate.limit',
            message: 'MAX API global rate limit exceeded',
          },
        },
      }),
    };

    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockResolvedValue({
        id: 'cached-channel-1',
        title: 'Кэш канала',
        entityType: 'channel',
        link: null,
        participantsCount: null,
        avatarUrl: 'https://i.oneme.ru/cached-channel-1.webp',
      }),
    });
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

    const discovered = await (service as any).runManagedEntitiesLocalDiscovery(
      user,
      'channel',
      (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'channel'),
      {
        respectCooldown: false,
        fullScan: true,
        includeRefreshState: true,
      },
    );

    expect(discovered.items).toEqual([]);
    await expect((service as any).hydrateManagedEntities(discovered.items)).resolves.toEqual([]);

    await expect((service as any).hydrateManagedEntities(discovered.items)).resolves.toEqual([]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(chatContextCache.activateManagedEntitiesRefreshBackoff).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      60,
    );
  });

  it('reuses cached header avatar on default channel load', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'channel-1',
          title: 'Новости MAX',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
        },
      },
    ]);
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {};
    const storedHeader = {
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'channel',
      link: 'https://max.ru/news',
      participantsCount: null,
      avatarUrl: 'https://i.oneme.ru/news.webp',
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockImplementation(async () => storedHeader),
    });

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

    await expect(service.listChannels(user)).resolves.toEqual([
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        link: 'https://max.ru/news',
        avatarUrl: 'https://i.oneme.ru/news.webp',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
    ]);

    expect(chatContextCache.getManagedEntityHeader).toHaveBeenCalledWith('channel-1', 'channel');
  });

  it('returns cached channels immediately while managed refresh continues in the background', async () => {
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
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    let resolveRefresh!: (value: {
      items: [];
      refresh: {
        complete: boolean;
        cursor: number | null;
        backoffActive: boolean;
        nextPollAfterMs: number;
      };
    }) => void;
    const discoverSpy = jest.spyOn(service as any, 'discoverManagedEntities').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve as typeof resolveRefresh;
        }) as any,
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
          title: 'Кэш канала',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'channel',
          link: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
          channelOverview: {
            enabledScenariosCount: 0,
            commentsEnabled: false,
            postSuggestionsEnabled: false,
            commentsModerationEnabled: false,
          },
        },
      ],
      refresh: {
        complete: false,
        cursor: 0,
        backoffActive: false,
        userVisibleComplete: true,
        nextPollAfterMs: 1500,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'in_progress',
        manualRefreshRetryAfterMs: 1500,
      },
    });

    expect(discoverSpy).toHaveBeenCalledTimes(1);
    expect(chatContextCache.setManagedEntitiesRefreshCursor).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      0,
      60 * 60,
    );

    resolveRefresh({
      items: [],
      refresh: {
        complete: true,
        cursor: -1,
        backoffActive: false,
        nextPollAfterMs: 0,
      },
    });
    await flushAsyncTasks();
  });

  it('clears stale cached channels when a local refresh revalidates and loses admin access', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'channel-1',
          title: 'Устаревший канал',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
        },
      },
    ]);
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue([]),
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
      (service as any).discoverManagedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'channel',
        {
          respectCooldown: false,
          fullScan: true,
        },
      ),
    ).resolves.toEqual({
      items: [],
      refresh: null,
    });
  });

  it('marks local managed channels refresh complete after checking local candidates', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'channel-121',
        title: 'Финальный канал',
        entityType: 'channel',
        createdAt: '2026-03-03T10:00:00.000Z',
      }),
    ]);
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-121',
      title: 'Финальный канал',
      createdAt: new Date('2026-03-03T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const chatContextCache = createChatContextCacheMock({});
    const maxClient = {
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
      (service as any).runManagedEntitiesLocalDiscovery(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'channel',
        (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'channel'),
        {
          respectCooldown: false,
          fullScan: true,
          includeRefreshState: true,
        },
      ),
    ).resolves.toEqual({
      items: [
        {
          id: 'channel-121',
          title: 'Финальный канал',
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: 'channel',
          link: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
          channelOverview: {
            enabledScenariosCount: 0,
            commentsEnabled: false,
            postSuggestionsEnabled: false,
            commentsModerationEnabled: false,
          },
        },
      ],
      refresh: {
        complete: true,
        cursor: -1,
        backoffActive: false,
        nextPollAfterMs: 0,
        processedCandidates: 1,
        totalCandidates: 1,
        progressPercent: 100,
        lastSyncedAt: expect.any(String),
        manualRefreshBlockedReason: 'recent_sync',
        manualRefreshRetryAfterMs: expect.any(Number),
      },
    });

    expect(chatContextCache.setManagedEntitiesRefreshCursor).not.toHaveBeenCalled();
    expect(chatContextCache.setManagedEntitiesLastSyncedAt).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      expect.any(String),
      30 * 24 * 60 * 60,
    );
  });

  it('splits local managed channels refresh into bounded cursor windows', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue(
      Array.from({ length: 41 }, (_, index) =>
        createLocalManagedEntityRow({
          chatId: `channel-${index + 1}`,
          title: `Канал ${index + 1}`,
          entityType: 'channel',
          createdAt: `2026-03-${String((index % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
        }),
      ),
    );
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.chat.upsert.mockImplementation(
      async ({ where, create }: { where: { id: string }; create: { title: string } }) => ({
        id: where.id,
        title: create.title,
        createdAt: new Date('2026-03-03T10:00:00.000Z'),
        entityType: 'CHANNEL',
      }),
    );
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const refreshCooldownKey = (service as any).buildManagedEntitiesRefreshCooldownKey(
      'admin-1',
      'channel',
    );

    const result = await (service as any).runManagedEntitiesLocalDiscovery(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'channel',
      refreshCooldownKey,
      {
        respectCooldown: false,
        fullScan: true,
        includeRefreshState: true,
      },
    );

    expect(result.items).toHaveLength(8);
    expect(result.refresh).toEqual({
      complete: false,
      cursor: 8,
      backoffActive: false,
      nextPollAfterMs: 1500,
      processedCandidates: 8,
      totalCandidates: 41,
      progressPercent: 20,
      lastSyncedAt: null,
      manualRefreshBlockedReason: 'in_progress',
      manualRefreshRetryAfterMs: 1500,
    });
    expect(chatContextCache.setManagedEntitiesRefreshCursor).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      8,
      60 * 60,
    );
  });

  it('returns refresh backoff metadata when managed channels sync is throttled', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'remote-channel-1',
        title: 'Новый канал',
        entityType: 'channel',
      }),
    ]);
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
      getChatAdminIds: jest.fn().mockRejectedValue(new Error('MAX API global rate limit exceeded')),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const refreshCooldownKey = (service as any).buildManagedEntitiesRefreshCooldownKey(
      'admin-1',
      'channel',
    );

    const result = await (service as any).runManagedEntitiesLocalDiscovery(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'channel',
      refreshCooldownKey,
      {
        respectCooldown: false,
        fullScan: true,
        includeRefreshState: true,
      },
    );

    expect(result).toEqual({
      items: [],
      refresh: {
        complete: false,
        cursor: null,
        backoffActive: true,
        nextPollAfterMs: expect.any(Number),
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'backoff',
        manualRefreshRetryAfterMs: expect.any(Number),
      },
    });
    expect(result.refresh.nextPollAfterMs).toBeGreaterThan(0);
    expect(result.refresh.nextPollAfterMs).toBeLessThanOrEqual(60_000);

    expect(chatContextCache.activateManagedEntitiesRefreshBackoff).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      60,
    );
  });

  it('rechecks stale denied admin cache during explicit chat refresh', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Команда MAX',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHAT',
    });

    const maxClient = {
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
      (service as any).runManagedEntitiesLocalDiscovery(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
        (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'chat'),
        {
          respectCooldown: false,
          fullScan: true,
        },
      ),
    ).resolves.toEqual({
      items: [
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Команда MAX',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
        }),
      ],
      refresh: null,
    });

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
      }),
    );
  });

  it('limits a single explicit refresh pass to the configured full refresh window', async () => {
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
      createChatSummaryFixture({
        id: 'chat-cached',
        title: 'Кэшированный чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    expect(maxClient.getChatAdminIds).not.toHaveBeenCalledWith('chat-101', {
      trafficClass: 'interactive',
    });
  });

  it('prioritizes locally observed chats when starting a new remote full scan snapshot', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'chat-priority',
        title: 'Приоритетный чат',
        entityType: 'chat',
        createdAt: '2026-03-03T10:00:00.000Z',
      }),
    ]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue(
        Array.from({ length: 25 }, (_, index) => ({
          chatId: `chat-${index + 1}`,
          title: `Чат ${index + 1}`,
          lastEventTime: 500 - index,
          entityType: 'chat' as const,
          link: null,
        })),
      ),
    };

    const chatContextCache = createChatContextCacheMock();
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    jest
      .spyOn(service as any, 'resolveUserAndBotAdminAccess')
      .mockImplementation(async (...args: unknown[]) => {
        const chatId = args[0] as string;
        return chatId === 'chat-priority' ? { status: 'granted' } : { status: 'user_denied' };
      });
    jest
      .spyOn(service as any, 'persistManagedEntityAccessBestEffort')
      .mockImplementation(async (...args: unknown[]) => {
        const params = args[0] as {
          chatId: string;
          title: string;
          entityType: 'chat';
        };

        return createChatSummaryFixture({
          id: params.chatId,
          title: params.title,
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: params.entityType,
        });
      });

    const result = await (service as any).runManagedEntitiesDiscovery(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'chat',
      (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'chat'),
      {
        fullScan: true,
        includeRefreshState: true,
        bypassRemoteCache: false,
        revalidateCachedChats: false,
        resetRefreshCursor: false,
        throwOnFailure: true,
      },
    );

    expect(result.items).toEqual([
      createChatSummaryFixture({
        id: 'chat-priority',
        title: 'Приоритетный чат',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
    expect(result.refresh).toEqual({
      complete: false,
      cursor: 10,
      backoffActive: false,
      nextPollAfterMs: 1500,
      processedCandidates: 10,
      totalCandidates: 26,
      progressPercent: 38,
      lastSyncedAt: null,
      manualRefreshBlockedReason: 'in_progress',
      manualRefreshRetryAfterMs: 1500,
    });
    await expect(
      chatContextCache.getManagedEntitiesDiscoverySnapshot('admin-1', 'chat'),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatId: 'chat-priority',
          title: 'Приоритетный чат',
        }),
      ]),
    );
    await expect(
      chatContextCache.getManagedEntitiesDiscoverySnapshot('admin-1', 'chat'),
    ).resolves.toEqual([
      expect.objectContaining({
        chatId: 'chat-priority',
        title: 'Приоритетный чат',
      }),
      ...Array.from({ length: 25 }, (_, index) =>
        expect.objectContaining({
          chatId: `chat-${index + 1}`,
          title: `Чат ${index + 1}`,
        }),
      ),
    ]);
  });

  it('re-runs local discovery on repeated explicit refreshes even during success cooldown', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-24T00:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'channel-1',
        title: 'Новости MAX',
        entityType: 'channel',
      }),
    ]);
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
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

    await expect(
      (service as any).runManagedEntitiesLocalDiscovery(
        user,
        'channel',
        (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'channel'),
        {
          respectCooldown: false,
          fullScan: true,
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([expect.objectContaining({ id: 'channel-1' })]),
      }),
    );
    await expect(
      (service as any).runManagedEntitiesLocalDiscovery(
        user,
        'channel',
        (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'channel'),
        {
          respectCooldown: false,
          fullScan: true,
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([expect.objectContaining({ id: 'channel-1' })]),
      }),
    );

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(2);
    expect(chatContextCache.activateManagedEntitiesRefreshCooldown).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      45,
    );
  });

  it('shares one in-flight channel discovery across parallel refresh requests', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'channel-1',
        title: 'Новости MAX',
        entityType: 'channel',
      }),
    ]);
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    let releaseDiscovery: (() => void) | undefined;
    const discoveryPromise = new Promise((resolve) => {
      releaseDiscovery = () =>
        resolve({
          items: [
            createChatSummaryFixture({
              id: 'channel-1',
              title: 'Новости MAX',
              createdAt: '2026-03-02T10:00:00.000Z',
              entityType: 'channel',
            }),
          ],
          refresh: null,
        });
    });

    const maxClient = {
      getChatAdminIds: jest.fn(),
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

    const runDiscoverySpy = jest
      .spyOn(service as any, 'runManagedEntitiesDiscovery')
      .mockImplementation(() => discoveryPromise);

    const first = (service as any).discoverManagedEntities(user, 'channel', {
      respectCooldown: false,
      fullScan: true,
    });
    const second = (service as any).discoverManagedEntities(user, 'channel', {
      respectCooldown: false,
      fullScan: true,
    });

    if (!releaseDiscovery) {
      throw new Error('releaseDiscovery was not initialized');
    }
    releaseDiscovery();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        items: [expect.objectContaining({ id: 'channel-1', entityType: 'channel' })],
      }),
      expect.objectContaining({
        items: [expect.objectContaining({ id: 'channel-1', entityType: 'channel' })],
      }),
    ]);

    expect(runDiscoverySpy).toHaveBeenCalledTimes(1);
  });

  it('does not let one user backoff block another user refresh', async () => {
    const prisma = createPrismaMock();
    const scopedBackoff = new Set<string>();
    scopedBackoff.add('admin-1:channel');
    const chatContextCache = createChatContextCacheMock({
      isManagedEntitiesRefreshBackoffActive: jest
        .fn()
        .mockImplementation(async (userId: string, entityType: string) =>
          scopedBackoff.has(`${userId}:${entityType}`),
        ),
    });

    const maxClient = {};

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const runDiscoverySpy = jest
      .spyOn(service as any, 'runManagedEntitiesDiscovery')
      .mockResolvedValue({
        items: [
          createChatSummaryFixture({
            id: 'channel-1',
            title: 'Новости MAX',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'channel',
          }),
        ],
        refresh: null,
      });

    await expect(
      (service as any).discoverManagedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'channel',
        {
          respectCooldown: false,
          fullScan: true,
          includeRefreshState: true,
        },
      ),
    ).resolves.toEqual({
      items: [],
      refresh: expect.objectContaining({
        backoffActive: true,
      }),
    });

    await expect(
      (service as any).discoverManagedEntities(
        {
          userId: 'admin-2',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'channel',
        {
          respectCooldown: false,
          fullScan: true,
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ id: 'channel-1', entityType: 'channel' })],
      }),
    );

    expect(runDiscoverySpy).toHaveBeenCalledTimes(1);
  });
});

describe('AdminService.listChats', () => {
  it('filters published snapshot chats to the current runtime bot scope', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        itemCount: 3,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-owned',
            title: 'Чат Решение',
            createdAt: '2026-04-03T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
          createChatSummaryFixture({
            id: 'chat-foreign',
            title: 'Чужой чат',
            createdAt: '2026-04-02T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: 'foreign_bot',
          }),
          createChatSummaryFixture({
            id: 'chat-legacy',
            title: 'Старый чат без bot scope',
            createdAt: '2026-04-01T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
      }),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );

    const rebuildSpy = jest
      .spyOn(service as any, 'scheduleManagedEntitiesPublishedSnapshotRebuild')
      .mockImplementation(() => undefined);

    const result = await service.listChats({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual([
      createChatSummaryFixture({
        id: 'chat-owned',
        title: 'Чат Решение',
        createdAt: '2026-04-03T10:00:00.000Z',
        entityType: 'chat',
        primaryBotId: '777000_bot',
      }),
    ]);
    expect(rebuildSpy).toHaveBeenCalledWith('admin-1', 'chat');
    expect(prisma.chatAdminAllowlist.findMany).not.toHaveBeenCalled();
  });

  it('returns the published snapshot during refresh requests instead of a partial in-progress list', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        itemCount: 1,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Из snapshot',
            createdAt: '2026-04-03T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
        ],
      }),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const refreshState = {
      complete: false,
      cursor: 20,
      backoffActive: false,
      userVisibleComplete: true,
      nextPollAfterMs: 1500,
      processedCandidates: 20,
      totalCandidates: 100,
      progressPercent: 20,
      lastSyncedAt: null,
      manualRefreshBlockedReason: 'in_progress' as const,
      manualRefreshRetryAfterMs: 1500,
    };
    jest
      .spyOn(service as any, 'scheduleManagedEntitiesRemoteFullRefresh')
      .mockResolvedValue(refreshState);

    const result = await service.listChatsWithRefreshState(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        refresh: true,
      },
    );

    expect(result).toEqual({
      items: [
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Из snapshot',
          createdAt: '2026-04-03T10:00:00.000Z',
          entityType: 'chat',
          primaryBotId: '777000_bot',
        }),
      ],
      refresh: refreshState,
      snapshot: {
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        source: 'published_snapshot',
        stale: true,
      },
    });
    expect(prisma.chatAdminAllowlist.findMany).not.toHaveBeenCalled();
  });

  it('returns a noop diff when refresh already targets the current published snapshot version', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        itemCount: 1,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Из snapshot',
            createdAt: '2026-04-03T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
      }),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const refreshState = {
      complete: false,
      cursor: 20,
      backoffActive: false,
      userVisibleComplete: true,
      nextPollAfterMs: 1500,
      processedCandidates: 20,
      totalCandidates: 100,
      progressPercent: 20,
      lastSyncedAt: null,
      manualRefreshBlockedReason: 'in_progress' as const,
      manualRefreshRetryAfterMs: 1500,
    };
    jest
      .spyOn(service as any, 'scheduleManagedEntitiesRemoteFullRefresh')
      .mockResolvedValue(refreshState);

    const result = await service.listChatsWithRefreshState(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        refresh: true,
        sinceVersion: 'snapshot-v1',
      },
    );

    expect(result).toEqual({
      items: [],
      refresh: refreshState,
      snapshot: {
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        source: 'published_snapshot',
        stale: true,
      },
      diff: {
        mode: 'noop',
        baseVersion: 'snapshot-v1',
        nextVersion: 'snapshot-v1',
      },
    });
    expect(chatContextCache.getManagedEntitiesPublishedDiff).not.toHaveBeenCalled();
  });

  it('returns a patch diff when the client asks for the previous published snapshot version', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v2',
        builtAt: '2026-04-04T10:05:00.000Z',
        lastSyncedAt: '2026-04-04T10:04:30.000Z',
        itemCount: 1,
        itemsHash: 'hash-v2',
        items: [
          createChatSummaryFixture({
            id: 'chat-2',
            title: 'Новый чат',
            createdAt: '2026-04-04T10:04:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
        ],
      }),
      getManagedEntitiesPublishedDiff: jest.fn().mockResolvedValue({
        baseVersion: 'snapshot-v1',
        nextVersion: 'snapshot-v2',
        added: [
          createChatSummaryFixture({
            id: 'chat-2',
            title: 'Новый чат',
            createdAt: '2026-04-04T10:04:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
        ],
        updated: [],
        removedIds: [],
        orderedIds: ['chat-2'],
        changeCount: 1,
      }),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const refreshState = {
      complete: false,
      cursor: 8,
      backoffActive: false,
      userVisibleComplete: true,
      nextPollAfterMs: 1500,
      processedCandidates: 8,
      totalCandidates: 20,
      progressPercent: 40,
      lastSyncedAt: null,
      manualRefreshBlockedReason: null,
      manualRefreshRetryAfterMs: null,
    };
    jest
      .spyOn(service as any, 'scheduleManagedEntitiesRemoteFullRefresh')
      .mockResolvedValue(refreshState);

    const result = await service.listChatsWithRefreshState(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        refresh: true,
        sinceVersion: 'snapshot-v1',
      },
    );

    expect(result).toEqual({
      items: [],
      refresh: refreshState,
      snapshot: {
        version: 'snapshot-v2',
        builtAt: '2026-04-04T10:05:00.000Z',
        lastSyncedAt: '2026-04-04T10:04:30.000Z',
        source: 'published_snapshot',
        stale: true,
      },
      diff: {
        mode: 'patch',
        baseVersion: 'snapshot-v1',
        nextVersion: 'snapshot-v2',
        added: [
          createChatSummaryFixture({
            id: 'chat-2',
            title: 'Новый чат',
            createdAt: '2026-04-04T10:04:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
        ],
        updated: [],
        removedIds: [],
        orderedIds: ['chat-2'],
      },
    });
  });

  it('returns a full merged refresh response when lightweight bootstrap finds a chat outside the published snapshot', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v2',
        builtAt: '2026-04-04T10:05:00.000Z',
        lastSyncedAt: '2026-04-04T10:04:30.000Z',
        itemCount: 1,
        itemsHash: 'hash-v2',
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Старый чат',
            createdAt: '2026-04-04T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
      }),
      getManagedEntitiesRecentBootstrap: jest.fn().mockResolvedValue([
        createChatSummaryFixture({
          id: 'chat-2',
          title: 'Новый чат',
          createdAt: '2026-04-04T10:04:00.000Z',
          entityType: 'chat',
          primaryBotId: '777000_bot',
        }),
      ]),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      chatContextCache as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );
    const refreshState = {
      complete: false,
      cursor: 8,
      backoffActive: false,
      userVisibleComplete: true,
      nextPollAfterMs: 1500,
      processedCandidates: 8,
      totalCandidates: 20,
      progressPercent: 40,
      lastSyncedAt: null,
      manualRefreshBlockedReason: null,
      manualRefreshRetryAfterMs: null,
    };
    jest
      .spyOn(service as any, 'scheduleManagedEntitiesRemoteFullRefresh')
      .mockResolvedValue(refreshState);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      title: where.id === 'chat-2' ? 'Новый чат' : 'Старый чат',
      entityType: 'CHAT',
    }));
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
            ? new Date('2026-04-04T10:04:00.000Z')
            : new Date('2026-04-04T10:00:00.000Z'),
      }),
    );

    const result = await service.listChatsWithRefreshState(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        refresh: true,
        sinceVersion: 'snapshot-v1',
      },
    );

    expect(result).toEqual({
      items: [
        createChatSummaryFixture({
          id: 'chat-2',
          title: 'Новый чат',
          createdAt: '2026-04-04T10:04:00.000Z',
          entityType: 'chat',
        }),
      ],
      refresh: refreshState,
      snapshot: {
        version: 'snapshot-v2',
        builtAt: '2026-04-04T10:05:00.000Z',
        lastSyncedAt: '2026-04-04T10:04:30.000Z',
        source: 'published_snapshot',
        stale: true,
      },
    });
    expect(chatContextCache.getManagedEntitiesPublishedDiff).not.toHaveBeenCalled();
  });

  it('rebuilds the published snapshot from allowlist data when no full refresh is in progress', async () => {
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
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(null),
      getManagedEntitiesRefreshCursor: jest.fn().mockResolvedValue(null),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await (service as any).rebuildManagedEntitiesPublishedSnapshot('admin-1', 'chat');

    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      expect.objectContaining({
        itemCount: 1,
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
      }),
      expect.any(Number),
    );
  });

  it('publishes the first snapshot even while a full refresh cursor is still in progress', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Тнк',
          createdAt: new Date('2026-04-05T00:20:07.272Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(null),
      getManagedEntitiesRefreshCursor: jest.fn().mockResolvedValue(20),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await (service as any).rebuildManagedEntitiesPublishedSnapshot('admin-1', 'chat');

    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      expect.objectContaining({
        itemCount: 1,
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Тнк',
            createdAt: '2026-04-05T00:20:07.272Z',
            entityType: 'chat',
          }),
        ],
      }),
      expect.any(Number),
    );
  });

  it('keeps the persisted chat title when the managed-entity header cache only has a fallback title', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Мер',
          createdAt: new Date('2026-04-05T00:36:52.557Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(null),
      getManagedEntitiesRefreshCursor: jest.fn().mockResolvedValue(null),
      getManagedEntityHeader: jest.fn().mockResolvedValue(
        createManagedEntityHeaderFixture({
          id: 'chat-1',
          title: 'Chat chat-1',
          entityType: 'chat',
        }),
      ),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await (service as any).rebuildManagedEntitiesPublishedSnapshot('admin-1', 'chat');

    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      expect.objectContaining({
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Мер',
            createdAt: '2026-04-05T00:36:52.557Z',
            entityType: 'chat',
          }),
        ],
      }),
      expect.any(Number),
    );
  });

  it('stores a small published snapshot patch when rebuild publishes a new version', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Обновленный чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-04T09:00:00.000Z',
        lastSyncedAt: '2026-04-04T08:59:30.000Z',
        itemCount: 1,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Старый чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
      }),
      getManagedEntitiesRefreshCursor: jest.fn().mockResolvedValue(null),
      getManagedEntitiesLastSyncedAt: jest.fn().mockResolvedValue('2026-04-04T10:00:00.000Z'),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await (service as any).rebuildManagedEntitiesPublishedSnapshot('admin-1', 'chat');

    expect(chatContextCache.setManagedEntitiesPublishedDiff).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      'snapshot-v1',
      expect.objectContaining({
        baseVersion: 'snapshot-v1',
        nextVersion: expect.any(String),
        updated: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Обновленный чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
        added: [],
        removedIds: [],
        orderedIds: ['chat-1'],
        changeCount: 1,
      }),
      expect.any(Number),
    );
  });

  it('isolates cached allowlist chats to bots configured in the current runtime', async () => {
    const prisma = createPrismaMock();
    const allowlistRows = [
      {
        chat: {
          id: 'chat-owned',
          title: 'Чат Решение',
          createdAt: new Date('2026-03-04T10:00:00.000Z'),
          entityType: 'CHAT' as const,
          primaryBotId: '777000_bot',
          botId: '777000_bot',
        },
      },
      {
        chat: {
          id: 'chat-foreign',
          title: 'Чужой чат',
          createdAt: new Date('2026-03-03T10:00:00.000Z'),
          entityType: 'CHAT' as const,
          primaryBotId: 'foreign_bot',
          botId: 'foreign_bot',
        },
      },
    ];
    prisma.chatAdminAllowlist.findMany.mockImplementation(
      async (args?: {
        where?: {
          chat?: {
            entityType?: 'CHAT' | 'CHANNEL';
            OR?: Array<
              | { primaryBotId?: { in?: string[] } }
              | { botId?: { in?: string[] } }
              | { botMemberships?: { some?: { botId?: { in?: string[] } } } }
            >;
          };
        };
      }) => {
        const where = args?.where;
        const runtimeBotIds = new Set(
          (where?.chat?.OR ?? []).flatMap((item) => {
            if ('primaryBotId' in item && Array.isArray(item.primaryBotId?.in)) {
              return item.primaryBotId.in;
            }
            if ('botId' in item && Array.isArray(item.botId?.in)) {
              return item.botId.in;
            }
            if ('botMemberships' in item && Array.isArray(item.botMemberships?.some?.botId?.in)) {
              return item.botMemberships.some.botId.in;
            }
            return [];
          }),
        );

        return allowlistRows.filter((row) => {
          if (where?.chat?.entityType && row.chat.entityType !== where.chat.entityType) {
            return false;
          }
          if (runtimeBotIds.size === 0) {
            return true;
          }

          return [row.chat.primaryBotId, row.chat.botId].some(
            (botId) => typeof botId === 'string' && runtimeBotIds.has(botId),
          );
        });
      },
    );

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );

    jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([]);

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-owned',
        title: 'Чат Решение',
        createdAt: '2026-03-04T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    expect(prisma.chatAdminAllowlist.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chat: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                primaryBotId: { in: ['777000_bot'] },
              }),
            ]),
          }),
        }),
      }),
    );
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
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-2',
          chat_title: 'Новый чат',
          is_channel: 'false',
        },
      ])
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-2',
          chat_title: 'Новый чат',
          is_channel: 'false',
        },
      ]);
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      return {
        id: where.id,
        title: where.id === 'chat-2' ? 'Новый чат' : 'Кэшированный чат',
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


    const result = await service.listChats({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Новый чат',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
      }),
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Кэшированный чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-2',
      expect.objectContaining({
        actionHealthLane: 'background',
      }),
    );
    expect(maxClient.getChatTitle).not.toHaveBeenCalled();
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

  it('bootstraps recent bot_added chats from the inline recent bootstrap cache before webhook read models persist', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      title: 'Новый чат',
      entityType: 'CHAT',
    }));
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
        createdAt: new Date('2026-04-03T10:00:00.000Z'),
      }),
    );

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock({
        getManagedEntitiesRecentBootstrap: jest.fn().mockResolvedValue([
          createChatSummaryFixture({
            id: 'chat-2',
            title: 'Новый чат',
            createdAt: '2026-04-03T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
        ]),
      }) as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );


    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Новый чат',
        createdAt: '2026-04-03T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
  });

  it('scans recent bot_added chats globally in addition to user-scoped candidates', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn().mockResolvedValue([]),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    jest.spyOn(service as any, 'startManagedEntitiesResponseWarmup').mockResolvedValue({
      items: [],
      refresh: null,
    });

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);

    const userScopedQueryCall = prisma.$queryRaw.mock.calls[0] ?? [];
    const globalQueryCall = prisma.$queryRaw.mock.calls[1] ?? [];
    expect(userScopedQueryCall).toContain('admin-1');
    expect(globalQueryCall).not.toContain('admin-1');
  });

  it('bootstraps a user-scoped bot_added chat even when the global recent scan is empty', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-2',
          chat_title: 'Моя новая группа',
          is_channel: 'false',
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      return {
        id: where.id,
        title: where.id === 'chat-2' ? 'Моя новая группа' : where.id,
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
        createdAt: new Date('2026-03-03T10:00:00.000Z'),
      }),
    );

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );


    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Моя новая группа',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
  });

  it('shows a fresh user-scoped bot_added chat provisionally while bot admin rights are still propagating', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-2',
          chat_title: '',
          is_channel: 'false',
          last_event_at: new Date().toISOString(),
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      title: 'Перепел',
      entityType: 'CHAT',
      createdAt: new Date('2026-04-19T21:07:43.203Z'),
      primaryBotId: '777000_4_bot',
      botId: '777000_4_bot',
    }));

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );

    jest.spyOn(service as any, 'resolveUserAndBotAdminAccess').mockResolvedValue({
      status: 'denied',
      source: 'remote',
      reason: 'bot_not_admin',
    });

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Перепел',
        createdAt: '2026-04-19T21:07:43.203Z',
        entityType: 'chat',
      }),
    ]);

    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
  });

  it('shows a fresh user-scoped bot_added chat provisionally from the inline recent cache before read-model writes finish', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      title: 'Перепел inline',
      entityType: 'CHAT',
      createdAt: new Date('2026-04-20T09:00:00.000Z'),
      primaryBotId: '777000_4_bot',
      botId: '777000_4_bot',
    }));

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock({
        getManagedEntitiesRecentBootstrap: jest.fn().mockResolvedValue([
          {
            ...createChatSummaryFixture({
              id: 'chat-inline-1',
              title: 'Chat chat-inline-1',
              createdAt: new Date('2026-04-20T09:00:00.000Z').toISOString(),
              entityType: 'chat',
              primaryBotId: '777000_4_bot',
            }),
            bootstrapUserIds: ['admin-1'],
          },
        ]),
      }) as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );

    jest.spyOn(service as any, 'resolveUserAndBotAdminAccess').mockResolvedValue({
      status: 'denied',
      source: 'remote',
      reason: 'bot_not_admin',
    });

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-inline-1',
        title: 'Перепел inline',
        createdAt: '2026-04-20T09:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
  });

  it('prefers a user-scoped recent bot_added row over a global inline cache hit for the same chat', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-priority-1',
          chat_title: '',
          is_channel: 'false',
          last_event_at: new Date('2026-04-20T10:00:00.000Z').toISOString(),
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      title: 'Приоритетный чат',
      entityType: 'CHAT',
      createdAt: new Date('2026-04-20T10:00:00.000Z'),
      primaryBotId: '777000_4_bot',
      botId: '777000_4_bot',
    }));

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock({
        getManagedEntitiesRecentBootstrap: jest.fn().mockResolvedValue([
          createChatSummaryFixture({
            id: 'chat-priority-1',
            title: 'Глобальный кэш',
            createdAt: new Date('2026-04-20T09:59:00.000Z').toISOString(),
            entityType: 'chat',
            primaryBotId: '777000_4_bot',
          }),
        ]),
      }) as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );

    jest.spyOn(service as any, 'resolveUserAndBotAdminAccess').mockResolvedValue({
      status: 'denied',
      source: 'remote',
      reason: 'bot_not_admin',
    });

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-priority-1',
        title: 'Приоритетный чат',
        createdAt: '2026-04-20T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
  });

  it('schedules a published snapshot rebuild when recent bot_added bootstrap finds a chat missing from the snapshot', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-2',
          chat_title: 'Моя новая группа',
          is_channel: 'false',
        },
      ])
      .mockResolvedValueOnce([]);

    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-05T10:00:00.000Z',
        lastSyncedAt: '2026-04-05T09:59:30.000Z',
        itemCount: 1,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Старый чат',
            createdAt: '2026-04-04T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
      }),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const chat = createChatSummaryFixture({
      id: 'chat-2',
      title: 'Моя новая группа',
      createdAt: '2026-04-05T10:00:00.000Z',
      entityType: 'chat',
    });
    jest.spyOn(service as any, 'resolveUserAndBotAdminAccess').mockResolvedValue({
      status: 'granted',
      source: 'remote',
    });
    jest.spyOn(service as any, 'persistManagedEntityAccessBestEffort').mockResolvedValue(chat);
    const rebuildSpy = jest
      .spyOn(service as any, 'scheduleManagedEntitiesPublishedSnapshotRebuild')
      .mockImplementation(() => undefined);

    await expect(
      (service as any).bootstrapRecentBotAddedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
      ),
    ).resolves.toEqual([chat]);

    await flushAsyncTasks();

    expect(rebuildSpy).toHaveBeenCalledWith('admin-1', 'chat');
  });

  it('caps lightweight recent bot_added admin checks on empty default chat lists', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce(
      Array.from({ length: 20 }, (_, index) => ({
        chat_id: `chat-${index + 1}`,
        chat_title: `Чат ${index + 1}`,
        is_channel: 'false',
      })),
    );

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([]),
      getChatAdminIds: jest.fn().mockResolvedValue([]),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    jest.spyOn(service as any, 'startManagedEntitiesResponseWarmup').mockResolvedValue({
      items: [],
      refresh: null,
    });

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(4);
    expect(maxClient.getChatAdminIds).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
        timeoutMs: 250,
      }),
    );
  });

  it('caps lightweight recent bot_added bootstrap by total elapsed time on empty default chat lists', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        chat_id: 'chat-1',
        chat_title: 'Чат 1',
        is_channel: 'false',
      },
      {
        chat_id: 'chat-2',
        chat_title: 'Чат 2',
        is_channel: 'false',
      },
      {
        chat_id: 'chat-3',
        chat_title: 'Чат 3',
        is_channel: 'false',
      },
    ]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([]),
      getChatAdminIds: jest.fn().mockResolvedValue([]),
      getChatTitle: jest.fn(),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const nowValues = [0, 0, 0, 0, 1_700];
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowValues.shift() ?? 1_700);

    try {
      jest.spyOn(service as any, 'startManagedEntitiesResponseWarmup').mockResolvedValue({
        items: [],
        refresh: null,
      });

      await expect(
        service.listChats({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([]);

      expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
      expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: 'managed_refresh',
          timeoutMs: 250,
        }),
      );
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('caps remote delta admin checks on empty default chat lists', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue(
        Array.from({ length: 20 }, (_, index) => ({
          chatId: `chat-${index + 1}`,
          title: `Чат ${index + 1}`,
          link: null,
          entityType: 'chat',
          lastEventTime: 200 - index,
          avatarUrl: null,
        })),
      ),
      getChatAdminIds: jest.fn().mockResolvedValue([]),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );


    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);

    expect(maxClient.listBotChats).toHaveBeenCalledWith({
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      sourceTag: 'managed_refresh',
      timeoutMs: 2500,
    });
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(6);
    expect(maxClient.getChatAdminIds).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
        timeoutMs: 750,
      }),
    );
  });

  it('does not bootstrap stale recent bot_added chats when MAX denies current admin access', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([
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


    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);

    expect(maxClient.listBotChats).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-2',
      expect.objectContaining({
        actionHealthLane: 'background',
      }),
    );
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
  });

  it('keeps listChats alive when deny-path allowlist pruning hits a saturated Prisma pool', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.chatAdminAllowlist.deleteMany.mockRejectedValueOnce({ code: 'P2024' });
    prisma.$queryRaw.mockResolvedValue([
      {
        chat_id: 'chat-2',
        chat_title: 'Новый чат',
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


    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);

    await flushAsyncTasks();

    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-2',
        userId: 'admin-1',
      },
    });
  });

  it('keeps listChats alive when the allowlist read hits a saturated Prisma pool', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany
      .mockRejectedValueOnce({ code: 'P2024' })
      .mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([]),
      getChatAdminIds: jest.fn(),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );


    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);
  });

  it('reuses the last successful managed chat snapshot when a later allowlist read exceeds the response budget', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-03T10:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      const slowAllowlistRead = createDeferred<
        Array<{
          chat: { id: string; title: string; createdAt: Date; entityType: 'CHAT' };
        }>
      >();
      prisma.chatAdminAllowlist.findMany
        .mockResolvedValueOnce([
          {
            chat: {
              id: 'chat-1',
              title: 'Команда MAX',
              createdAt: new Date('2026-03-01T00:00:00.000Z'),
              entityType: 'CHAT',
            },
          },
        ])
        .mockImplementationOnce(async () => slowAllowlistRead.promise);

      const maxClient = {
        listBotChats: jest.fn().mockResolvedValue([]),
        getChatAdminIds: jest.fn(),
        getChatTitle: jest.fn(),
      };

      const service = new AdminService(
        prisma as never,
        maxClient as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );

      jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([]);

      await expect(
        service.listChats({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Команда MAX',
          createdAt: '2026-03-01T00:00:00.000Z',
          entityType: 'chat',
        }),
      ]);

      await jest.advanceTimersByTimeAsync(2_100);

      const responsePromise = service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      });

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(300);

      await expect(responsePromise).resolves.toEqual([
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Команда MAX',
          createdAt: '2026-03-01T00:00:00.000Z',
          entityType: 'chat',
        }),
      ]);
    } finally {
      jest.useRealTimers();
    }
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


    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Актуальный чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-2',
      expect.objectContaining({
        actionHealthLane: 'background',
      }),
    );
  });

  it('proactively hides cached fallback-title chats when MAX says the bot lost access', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: '-72545334298631',
          title: 'Chat -72545334298631',
          createdAt: new Date('2026-03-24T19:35:33.379Z'),
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
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === '-72545334298631') {
          throw {
            response: {
              status: 403,
              data: {
                code: 'chat.denied',
                message: 'Bot is not a chat member',
              },
            },
          };
        }

        return ['admin-1'];
      }),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );


    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Рабочий чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      '-72545334298631',
      expect.objectContaining({
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
        timeoutMs: 300,
      }),
    );

    await flushAsyncTasks();

    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '-72545334298631',
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


    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Рабочий чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
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

  it('ignores private direct dialogs returned by the local discovery catalog', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: '152517912',
        title: 'Личка с ботом',
        entityType: 'chat',
        createdAt: '2026-03-03T10:00:00.000Z',
      }),
      createLocalManagedEntityRow({
        chatId: 'chat-1',
        title: 'Рабочий чат',
        entityType: 'chat',
        createdAt: '2026-03-03T09:00:00.000Z',
      }),
    ]);
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
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).runManagedEntitiesLocalDiscovery(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
        (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'chat'),
        {
          respectCooldown: false,
          fullScan: true,
        },
      ),
    ).resolves.toEqual({
      items: [
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Рабочий чат',
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: 'chat',
        }),
      ],
      refresh: null,
    });

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
      }),
    );
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

  it('warms the allowlist from priority local candidates on a cold default load without blocking the response', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'chat-priority',
        title: 'Приоритетный чат',
        entityType: 'chat',
        createdAt: '2026-03-03T10:00:00.000Z',
      }),
    ]);

    const maxChatAdminRosterSyncService = {
      scheduleDiscoverySnapshotSync: jest.fn().mockReturnValue(createDeferred<void>().promise),
    };

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([]);
    jest.spyOn(service as any, 'startManagedEntitiesResponseWarmup').mockResolvedValue({
      items: [],
      refresh: null,
    });

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-launch',
        chatTitle: 'Лонч-чат',
        chatType: 'chat',
      }),
    ).resolves.toEqual([]);

    expect(maxChatAdminRosterSyncService.scheduleDiscoverySnapshotSync).toHaveBeenCalledWith([
      expect.objectContaining({
        chatId: 'chat-priority',
        title: 'Приоритетный чат',
        entityType: 'chat',
      }),
    ]);
  });

  it('queues a durable managed entities refresh on a cold default load without blocking the response', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);

    const managedEntitiesRefreshEnqueue = createDeferred<void>();
    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockReturnValue(managedEntitiesRefreshEnqueue.promise),
    };

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
    );

    jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([]);
    jest.spyOn(service as any, 'startManagedEntitiesResponseWarmup').mockResolvedValue({
      items: [],
      refresh: null,
    });

    try {
      await expect(
        service.listChats({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([]);

      await flushAsyncTasks();

      expect(managedEntitiesRefreshQueue.getJob).toHaveBeenCalledWith(
        'managed-entities-refresh__chat__admin-1',
      );
      expect(managedEntitiesRefreshQueue.add).toHaveBeenCalledWith(
        'refresh-managed-entities',
        {
          userId: 'admin-1',
          entityType: 'chat',
          bypassRemoteCache: false,
          resetRefreshCursor: false,
        },
        expect.objectContaining({
          jobId: 'managed-entities-refresh__chat__admin-1',
          priority: 10,
        }),
      );
    } finally {
      managedEntitiesRefreshEnqueue.resolve(undefined);
      await flushAsyncTasks();
    }
  });

  it('clears a newly initialized managed entities refresh cursor when cold-start queue scheduling fails', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);

    const chatContextCache = createChatContextCacheMock();
    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockRejectedValue(new Error('queue unavailable')),
    };

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
    );

    jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([]);
    jest.spyOn(service as any, 'startManagedEntitiesResponseWarmup').mockResolvedValue({
      items: [],
      refresh: null,
    });

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);

    await flushAsyncTasks();
    await flushAsyncTasks();

    expect(chatContextCache.clearManagedEntitiesRefreshCursor).toHaveBeenCalledWith(
      'admin-1',
      'chat',
    );
  });

  it('reuses a cached chat avatar from stored header during refresh', async () => {
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
      getChatSnapshot: jest.fn(),
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Кэшированный чат',
        entityType: 'chat',
        link: null,
        participantsCount: 87,
        avatarUrl: 'https://i.oneme.ru/chat-1.webp',
      }),
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
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Кэшированный чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
        avatarUrl: 'https://i.oneme.ru/chat-1.webp',
      }),
    ]);

    expect(chatContextCache.getManagedEntityHeader).toHaveBeenCalledWith('chat-1', 'chat');
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('keeps recent bot_added chats visible when starting a forced refresh', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
    );

    jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Недавно добавленный чат 1',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
      }),
      createChatSummaryFixture({
        id: 'chat-3',
        title: 'Недавно добавленный чат 2',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    await expect(
      service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatId: 'chat-2',
          chatTitle: 'Текущий чат',
        },
        {
          refresh: true,
          bypassRemoteCache: true,
          resetRefreshCursor: true,
        },
      ),
    ).resolves.toEqual({
      items: [
        createChatSummaryFixture({
          id: 'chat-2',
          title: 'Недавно добавленный чат 1',
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: 'chat',
        }),
        createChatSummaryFixture({
          id: 'chat-3',
          title: 'Недавно добавленный чат 2',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
        }),
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: '2026-03-01T10:00:00.000Z',
          entityType: 'chat',
        }),
      ],
      refresh: {
        complete: false,
        cursor: 0,
        backoffActive: false,
        userVisibleComplete: true,
        nextPollAfterMs: 1500,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'in_progress',
        manualRefreshRetryAfterMs: 1500,
      },
    });

    expect(managedEntitiesRefreshQueue.add).toHaveBeenCalledWith(
      'refresh-managed-entities',
      {
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: true,
        resetRefreshCursor: true,
      },
      expect.objectContaining({
        jobId: 'managed-entities-refresh__chat__admin-1',
      }),
    );
  });

  it('keeps lightweight bootstrap chats visible during a regular refresh before the first published snapshot exists', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
    );

    jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Недавно добавленный чат 1',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
      }),
      createChatSummaryFixture({
        id: 'chat-3',
        title: 'Недавно добавленный чат 2',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    await expect(
      service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatId: 'chat-2',
          chatTitle: 'Текущий чат',
        },
        {
          refresh: true,
        },
      ),
    ).resolves.toEqual({
      items: [
        createChatSummaryFixture({
          id: 'chat-2',
          title: 'Недавно добавленный чат 1',
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: 'chat',
        }),
        createChatSummaryFixture({
          id: 'chat-3',
          title: 'Недавно добавленный чат 2',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
        }),
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: '2026-03-01T10:00:00.000Z',
          entityType: 'chat',
        }),
      ],
      refresh: {
        complete: false,
        cursor: 0,
        backoffActive: false,
        userVisibleComplete: true,
        nextPollAfterMs: 1500,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'in_progress',
        manualRefreshRetryAfterMs: 1500,
      },
    });

    expect(managedEntitiesRefreshQueue.add).toHaveBeenCalledWith(
      'refresh-managed-entities',
      {
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: false,
      },
      expect.objectContaining({
        jobId: 'managed-entities-refresh__chat__admin-1',
      }),
    );
  });

  it('does not wait for a slow recent bot_added bootstrap before returning a refresh response', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-03T10:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValue([
        {
          chat: {
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: new Date('2026-03-01T10:00:00.000Z'),
            entityType: 'CHAT',
          },
        },
      ]);

      const managedEntitiesRefreshQueue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
          getChatAdminIds: jest.fn(),
        } as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntitiesRefreshQueue as never,
      );

      const recentBootstrap = createDeferred<ChatSummary[]>();
      jest
        .spyOn(service as any, 'bootstrapRecentBotAddedEntities')
        .mockReturnValue(recentBootstrap.promise);

      const responsePromise = service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatId: 'chat-2',
          chatTitle: 'Текущий чат',
        },
        {
          refresh: true,
          bypassRemoteCache: true,
          resetRefreshCursor: true,
        },
      );

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1_000);

      await expect(responsePromise).resolves.toEqual({
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: '2026-03-01T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
        refresh: {
          complete: false,
          cursor: 0,
          backoffActive: false,
          userVisibleComplete: true,
          nextPollAfterMs: 1500,
          processedCandidates: null,
          totalCandidates: null,
          progressPercent: null,
          lastSyncedAt: null,
          manualRefreshBlockedReason: 'in_progress',
          manualRefreshRetryAfterMs: 1500,
        },
      });

      recentBootstrap.resolve([
        createChatSummaryFixture({
          id: 'chat-3',
          title: 'Недавно добавленный чат',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
        }),
      ]);
      await Promise.resolve();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps refresh responses alive when the allowlist read hits a saturated Prisma pool', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany
      .mockRejectedValueOnce({ code: 'P2024' })
      .mockResolvedValue([]);

    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn().mockResolvedValue([]),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
    );

    jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([]);

    await expect(
      service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          refresh: true,
          bypassRemoteCache: true,
          resetRefreshCursor: true,
        },
      ),
    ).resolves.toEqual({
      items: [],
      refresh: {
        complete: false,
        cursor: 0,
        backoffActive: false,
        userVisibleComplete: false,
        nextPollAfterMs: 1500,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'in_progress',
        manualRefreshRetryAfterMs: 1500,
      },
    });
  });

  it('revalidates suspicious cached chats in refresh responses before returning them', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: '-72545334298631',
          title: 'Chat -72545334298631',
          createdAt: new Date('2026-03-24T19:35:33.379Z'),
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

    const maxClient = {
      listBotChats: jest.fn(),
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === '-72545334298631') {
          throw {
            response: {
              status: 404,
              data: {
                code: 'chat.not.found',
                message: 'Chat -72545334298631 not found',
              },
            },
          };
        }

        return ['admin-1'];
      }),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    jest.spyOn(service as any, 'scheduleManagedEntitiesRemoteFullRefresh').mockResolvedValue({
      complete: false,
      cursor: 0,
      backoffActive: false,
      nextPollAfterMs: 1_500,
    });

    await expect(
      service.listChats(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          refresh: true,
        },
      ),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Рабочий чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      '-72545334298631',
      expect.objectContaining({
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
        timeoutMs: 300,
      }),
    );
  });

  it('does not wait for an uncached runtime governor decision before returning a refresh response', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-03T10:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValue([
        {
          chat: {
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: new Date('2026-03-01T10:00:00.000Z'),
            entityType: 'CHAT',
          },
        },
      ]);

      const managedEntitiesRefreshQueue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const backgroundRuntimeGovernorService = {
        peekDecision: jest.fn().mockReturnValue(null),
        decide: jest.fn().mockReturnValue(createDeferred<never>().promise),
      };
      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
          getChatAdminIds: jest.fn(),
        } as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntitiesRefreshQueue as never,
        undefined,
        backgroundRuntimeGovernorService as never,
      );

      const responsePromise = service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          refresh: true,
        },
      );

      const outcomePromise = Promise.race([
        responsePromise.then((value) => ({
          kind: 'resolved' as const,
          value,
        })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          setTimeout(() => {
            resolve({ kind: 'timeout' });
          }, 100);
        }),
      ]);

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(100);

      await expect(outcomePromise).resolves.toEqual({
        kind: 'resolved',
        value: {
          items: [
            createChatSummaryFixture({
              id: 'chat-1',
              title: 'Кэшированный чат',
              createdAt: '2026-03-01T10:00:00.000Z',
              entityType: 'chat',
            }),
          ],
          refresh: {
            complete: false,
            cursor: 0,
            backoffActive: false,
            userVisibleComplete: true,
            nextPollAfterMs: 1500,
            processedCandidates: null,
            totalCandidates: null,
            progressPercent: null,
            lastSyncedAt: null,
            manualRefreshBlockedReason: 'in_progress',
            manualRefreshRetryAfterMs: 1500,
          },
        },
      });

      expect(backgroundRuntimeGovernorService.peekDecision).toHaveBeenCalledWith({
        component: 'admin-managed-refresh',
        sourceTag: 'managed_refresh',
        allowRecoveryWindowRun: false,
        allowQueueLagSlowPathBelowSec: undefined,
      });
      expect(backgroundRuntimeGovernorService.decide).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('still defers a reset-cursor managed refresh on schedule when the governor reports slow pressure', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const backgroundRuntimeGovernorService = {
      peekDecision: jest.fn().mockImplementation((params: { allowRecoveryWindowRun?: boolean }) =>
        params.allowRecoveryWindowRun
          ? {
              action: 'slow',
              reason: 'background share 60.0%',
              retryAfterMs: 20_000,
            }
          : {
              action: 'pause',
              reason: 'recovery window in progress',
              retryAfterMs: 60_000,
            },
      ),
      decide: jest.fn(),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
      undefined,
      backgroundRuntimeGovernorService as never,
    );

    await expect(
      service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          refresh: true,
          resetRefreshCursor: true,
        },
      ),
    ).resolves.toEqual({
      items: [
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: '2026-03-01T10:00:00.000Z',
          entityType: 'chat',
        }),
      ],
      refresh: {
        complete: false,
        cursor: null,
        backoffActive: true,
        userVisibleComplete: true,
        nextPollAfterMs: 20_000,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'backoff',
        manualRefreshRetryAfterMs: 20_000,
      },
    });

    expect(backgroundRuntimeGovernorService.peekDecision).toHaveBeenCalledWith({
      component: 'admin-managed-refresh',
      sourceTag: 'managed_refresh',
      allowRecoveryWindowRun: true,
      allowQueueLagSlowPathBelowSec: 30,
    });
    expect(managedEntitiesRefreshQueue.add).not.toHaveBeenCalled();
  });

  it('reprioritizes a waiting managed refresh job when the user polls an already-started chat refresh', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);

    const existingJob = {
      data: {
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: true,
      },
      opts: {},
      getState: jest.fn().mockResolvedValue('waiting'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(existingJob),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
    );

    await expect(
      service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          refresh: true,
          includeRefreshState: true,
        } as never,
      ),
    ).resolves.toMatchObject({
      refresh: expect.objectContaining({
        cursor: 0,
        manualRefreshBlockedReason: 'in_progress',
      }),
    });

    expect(existingJob.remove).toHaveBeenCalledTimes(1);
    expect(managedEntitiesRefreshQueue.add).toHaveBeenCalledWith(
      'refresh-managed-entities',
      {
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: true,
      },
      expect.objectContaining({
        jobId: 'managed-entities-refresh__chat__admin-1',
        priority: 2,
      }),
    );
  });

  it('does not wait for a slow managed discovery warmup before returning a forced refresh response', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-03T10:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);

      const managedEntitiesRefreshQueue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
          getChatAdminIds: jest.fn(),
        } as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntitiesRefreshQueue as never,
      );

      const warmupDiscovery = createDeferred<{
        items: ChatSummary[];
        refresh: null;
      }>();
      jest
        .spyOn(service as any, 'discoverManagedEntities')
        .mockReturnValue(warmupDiscovery.promise);
      jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([
        createChatSummaryFixture({
          id: 'chat-2',
          title: 'Недавно добавленный чат',
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: 'chat',
        }),
      ]);

      const responsePromise = service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatId: 'chat-2',
          chatTitle: 'Текущий чат',
        },
        {
          refresh: true,
          bypassRemoteCache: true,
          resetRefreshCursor: true,
        },
      );

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1_500);

      await expect(responsePromise).resolves.toEqual({
        items: [
          createChatSummaryFixture({
            id: 'chat-2',
            title: 'Недавно добавленный чат',
            createdAt: '2026-03-03T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
        refresh: {
          complete: false,
          cursor: 0,
          backoffActive: false,
          userVisibleComplete: true,
          nextPollAfterMs: 1500,
          processedCandidates: null,
          totalCandidates: null,
          progressPercent: null,
          lastSyncedAt: null,
          manualRefreshBlockedReason: 'in_progress',
          manualRefreshRetryAfterMs: 1500,
        },
      });

      warmupDiscovery.resolve({
        items: [
          createChatSummaryFixture({
            id: 'chat-3',
            title: 'Найденный чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
        refresh: null,
      });
      await Promise.resolve();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not overwrite a presentable title during recent bot_added bootstrap', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValueOnce({
      title: 'Устойчивое имя чата',
    });
    prisma.chat.upsert.mockResolvedValueOnce({
      id: 'chat-launch',
      title: 'Устойчивое имя чата',
      entityType: 'CHAT',
      createdAt: new Date('2026-03-03T10:00:00.000Z'),
      primaryBotId: null,
      botId: null,
    });

    const maxBotLinkService = {
      bindDiscoveredChatBots: jest.fn().mockResolvedValue(null),
      getBotTokenSync: jest.fn().mockReturnValue('test-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue([]),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );
    jest.spyOn(service as any, 'resolveBotAssignment').mockResolvedValue(undefined);

    await expect(
      (service as any).persistManagedEntityAccessBestEffort({
        chatId: 'chat-launch',
        userId: 'admin-1',
        title: 'Лонч-тайтл',
        entityType: 'chat',
        source: 'recent_bot_added_bootstrap',
      }),
    ).resolves.toMatchObject({
      id: 'chat-launch',
      title: 'Устойчивое имя чата',
      entityType: 'chat',
    });

    const upsertArgs = prisma.chat.upsert.mock.calls[0][0];
    expect(upsertArgs.update).not.toHaveProperty('title');
    expect(maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-launch',
        title: 'Устойчивое имя чата',
      }),
    );
  });

  it('does not overwrite a presentable title during local discovery when the candidate title is fallback', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValueOnce({
      id: 'chat-launch',
      title: 'Устойчивое имя чата',
      entityType: 'CHAT',
      createdAt: new Date('2026-03-03T10:00:00.000Z'),
      primaryBotId: null,
      botId: null,
    });

    const maxBotLinkService = {
      bindDiscoveredChatBots: jest.fn().mockResolvedValue(null),
      getBotTokenSync: jest.fn().mockReturnValue('test-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue([]),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );
    jest.spyOn(service as any, 'resolveBotAssignment').mockResolvedValue(undefined);

    await expect(
      (service as any).persistManagedEntityAccessBestEffort({
        chatId: 'chat-launch',
        userId: 'admin-1',
        title: 'Chat chat-launch',
        entityType: 'chat',
        source: 'local_discovery',
      }),
    ).resolves.toMatchObject({
      id: 'chat-launch',
      title: 'Устойчивое имя чата',
      entityType: 'chat',
    });

    const upsertArgs = prisma.chat.upsert.mock.calls[0][0];
    expect(upsertArgs.update).not.toHaveProperty('title');
    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
    expect(maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-launch',
        title: 'Устойчивое имя чата',
      }),
    );
  });

  it('replaces a fallback title during recent bot_added bootstrap when MAX provides a presentable title', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValueOnce({
      title: 'Chat chat-launch',
    });
    prisma.chat.upsert.mockResolvedValueOnce({
      id: 'chat-launch',
      title: 'Новый title из MAX',
      entityType: 'CHAT',
      createdAt: new Date('2026-03-03T10:00:00.000Z'),
      primaryBotId: null,
      botId: null,
    });

    const maxBotLinkService = {
      bindDiscoveredChatBots: jest.fn().mockResolvedValue(null),
      getBotTokenSync: jest.fn().mockReturnValue('test-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue([]),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );
    jest.spyOn(service as any, 'resolveBotAssignment').mockResolvedValue(undefined);

    await expect(
      (service as any).persistManagedEntityAccessBestEffort({
        chatId: 'chat-launch',
        userId: 'admin-1',
        title: 'Новый title из MAX',
        entityType: 'chat',
        source: 'recent_bot_added_bootstrap',
      }),
    ).resolves.toMatchObject({
      id: 'chat-launch',
      title: 'Новый title из MAX',
      entityType: 'chat',
    });

    const upsertArgs = prisma.chat.upsert.mock.calls[0][0];
    expect(upsertArgs.update).toMatchObject({
      title: 'Новый title из MAX',
      entityType: 'CHAT',
    });
    expect(maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-launch',
        title: 'Новый title из MAX',
      }),
    );
  });

  it('returns cached chats immediately while managed refresh continues in the background', async () => {
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
    const chatContextCache = createChatContextCacheMock();
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    let resolveRefresh!: (value: {
      items: [];
      refresh: {
        complete: boolean;
        cursor: number | null;
        backoffActive: boolean;
        nextPollAfterMs: number;
      };
    }) => void;
    const discoverSpy = jest.spyOn(service as any, 'discoverManagedEntities').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve as typeof resolveRefresh;
        }) as any,
    );

    const result = await service.listChatsWithRefreshState(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { refresh: true },
    );

    expect(result).toEqual({
      items: [
        {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
          link: null,
          channelOverview: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        },
      ],
      refresh: {
        complete: false,
        cursor: 0,
        backoffActive: false,
        userVisibleComplete: true,
        nextPollAfterMs: 1500,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'in_progress',
        manualRefreshRetryAfterMs: 1500,
      },
    });
    expect(discoverSpy).toHaveBeenCalledTimes(1);
    expect(chatContextCache.setManagedEntitiesRefreshCursor).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      0,
      60 * 60,
    );

    resolveRefresh({
      items: [],
      refresh: {
        complete: true,
        cursor: -1,
        backoffActive: false,
        nextPollAfterMs: 0,
      },
    });
    await flushAsyncTasks();
  });

  it('skips auto managed refresh scheduling while the cached list is still fresh', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:05:00.000Z'));

    try {
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

      const managedEntitiesRefreshQueue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntitiesLastSyncedAt: jest.fn().mockResolvedValue('2026-04-01T18:00:00.000Z'),
      });
      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
          getChatAdminIds: jest.fn(),
        } as never,
        chatContextCache as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntitiesRefreshQueue as never,
      );

      await expect(
        service.listChatsWithRefreshState(
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
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
            link: null,
            channelOverview: null,
            primaryBotId: null,
            assignedBots: [],
            sharedMode: 'owned',
          },
        ],
        refresh: {
          complete: true,
          cursor: -1,
          backoffActive: false,
          userVisibleComplete: true,
          nextPollAfterMs: 0,
          processedCandidates: null,
          totalCandidates: null,
          progressPercent: 100,
          lastSyncedAt: '2026-04-01T18:00:00.000Z',
          manualRefreshBlockedReason: null,
          manualRefreshRetryAfterMs: null,
        },
      });

      expect(managedEntitiesRefreshQueue.add).not.toHaveBeenCalled();
      expect(chatContextCache.setManagedEntitiesRefreshCursor).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('still queues managed refresh when bypassing remote cache even if the cached list is fresh', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:05:00.000Z'));

    try {
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

      const managedEntitiesRefreshQueue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntitiesLastSyncedAt: jest.fn().mockResolvedValue('2026-04-01T18:00:00.000Z'),
      });
      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
          getChatAdminIds: jest.fn(),
        } as never,
        chatContextCache as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntitiesRefreshQueue as never,
      );

      await expect(
        service.listChatsWithRefreshState(
          {
            userId: 'admin-1',
            username: null,
            displayName: null,
            chatTitle: null,
          },
          { refresh: true, bypassRemoteCache: true },
        ),
      ).resolves.toEqual({
        items: [
          {
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
            link: null,
            channelOverview: null,
            primaryBotId: null,
            assignedBots: [],
            sharedMode: 'owned',
          },
        ],
        refresh: {
          complete: false,
          cursor: 0,
          backoffActive: false,
          userVisibleComplete: true,
          nextPollAfterMs: 1500,
          processedCandidates: null,
          totalCandidates: null,
          progressPercent: null,
          lastSyncedAt: null,
          manualRefreshBlockedReason: 'in_progress',
          manualRefreshRetryAfterMs: 1500,
        },
      });

      expect(managedEntitiesRefreshQueue.add).toHaveBeenCalledWith(
        'refresh-managed-entities',
        {
          userId: 'admin-1',
          entityType: 'chat',
          bypassRemoteCache: true,
          resetRefreshCursor: false,
        },
        expect.objectContaining({
          jobId: 'managed-entities-refresh__chat__admin-1',
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips repeated forced managed refresh clicks while the last successful sync is still recent', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:05:00.000Z'));

    try {
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

      const managedEntitiesRefreshQueue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntitiesLastSyncedAt: jest.fn().mockResolvedValue('2026-04-01T18:04:45.000Z'),
      });
      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
          getChatAdminIds: jest.fn(),
        } as never,
        chatContextCache as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntitiesRefreshQueue as never,
      );

      await expect(
        service.listChatsWithRefreshState(
          {
            userId: 'admin-1',
            username: null,
            displayName: null,
            chatTitle: null,
          },
          { refresh: true, bypassRemoteCache: true },
        ),
      ).resolves.toEqual({
        items: [
          {
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
            link: null,
            channelOverview: null,
            primaryBotId: null,
            assignedBots: [],
            sharedMode: 'owned',
          },
        ],
        refresh: {
          complete: true,
          cursor: -1,
          backoffActive: false,
          userVisibleComplete: true,
          nextPollAfterMs: 0,
          processedCandidates: null,
          totalCandidates: null,
          progressPercent: 100,
          lastSyncedAt: '2026-04-01T18:04:45.000Z',
          manualRefreshBlockedReason: 'recent_sync',
          manualRefreshRetryAfterMs: 15_000,
        },
      });

      expect(managedEntitiesRefreshQueue.add).not.toHaveBeenCalled();
      expect(chatContextCache.setManagedEntitiesRefreshCursor).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('forces a managed refresh restart when reset cursor is requested even if the last sync is still fresh', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:05:00.000Z'));

    try {
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

      const managedEntitiesRefreshQueue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntitiesLastSyncedAt: jest.fn().mockResolvedValue('2026-04-01T18:04:45.000Z'),
      });
      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
          getChatAdminIds: jest.fn(),
        } as never,
        chatContextCache as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntitiesRefreshQueue as never,
      );

      await expect(
        service.listChatsWithRefreshState(
          {
            userId: 'admin-1',
            username: null,
            displayName: null,
            chatTitle: null,
          },
          { refresh: true, resetRefreshCursor: true },
        ),
      ).resolves.toEqual({
        items: [
          {
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
            link: null,
            channelOverview: null,
            primaryBotId: null,
            assignedBots: [],
            sharedMode: 'owned',
          },
        ],
        refresh: {
          complete: false,
          cursor: 0,
          backoffActive: false,
          userVisibleComplete: true,
          nextPollAfterMs: 1500,
          processedCandidates: null,
          totalCandidates: null,
          progressPercent: null,
          lastSyncedAt: null,
          manualRefreshBlockedReason: 'in_progress',
          manualRefreshRetryAfterMs: 1500,
        },
      });

      expect(managedEntitiesRefreshQueue.add).toHaveBeenCalledWith(
        'refresh-managed-entities',
        {
          userId: 'admin-1',
          entityType: 'chat',
          bypassRemoteCache: false,
          resetRefreshCursor: true,
        },
        expect.objectContaining({
          jobId: 'managed-entities-refresh__chat__admin-1',
        }),
      );
      expect(chatContextCache.setManagedEntitiesRefreshCursor).toHaveBeenCalledWith(
        'admin-1',
        'chat',
        0,
        60 * 60,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns a fresh chat list on demand instead of stale allowlist entries', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-stale',
          title: 'Старый чат',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
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
          chatId: 'chat-fresh',
          title: 'Живой чат',
          link: null,
          entityType: 'chat',
          lastEventTime: 1,
          avatarUrl: null,
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
      service.listChats(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { fresh: true },
      ),
    ).resolves.toEqual([
      {
        id: 'chat-fresh',
        title: 'Живой чат',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
        primaryBotId: null,
        assignedBots: [],
        sharedMode: 'owned',
      },
    ]);

    expect(maxClient.listBotChats).toHaveBeenCalledWith({
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      bypassCache: true,
      sourceTag: 'managed_refresh',
      timeoutMs: 2500,
    });
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-fresh', {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      sourceTag: 'managed_refresh',
      timeoutMs: 750,
    });
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalledWith('chat-stale', expect.anything());
  });

  it('prioritizes local user-specific candidates during fresh managed chat discovery', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'chat-target',
        title: 'Локальный приоритет',
        entityType: 'chat',
        createdAt: '2026-03-03T10:00:00.000Z',
      }),
    ]);
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

    const remoteChats = Array.from({ length: 12 }, (_, index) => ({
      chatId: `chat-${index + 1}`,
      title: `Удалённый чат ${index + 1}`,
      link: null,
      entityType: 'chat' as const,
      lastEventTime: 100 - index,
      avatarUrl: null,
    }));
    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue(remoteChats),
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-target') {
          return ['admin-1'];
        }
        return [];
      }),
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
        { fresh: true },
      ),
    ).resolves.toEqual([
      {
        id: 'chat-target',
        title: 'Локальный приоритет',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
        primaryBotId: null,
        assignedBots: [],
        sharedMode: 'owned',
      },
    ]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-target', {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      sourceTag: 'managed_refresh',
      timeoutMs: 750,
    });
  });

  it('returns transient fresh chats without backoff when persistence hits a saturated Prisma pool', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValue([]);
      const chatContextCache = createChatContextCacheMock();
      const maxClient = {
        listBotChats: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-fresh',
            title: 'Живой чат',
            link: null,
            entityType: 'chat',
            lastEventTime: 1,
            avatarUrl: null,
          },
        ]),
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      };

      const service = new AdminService(
        prisma as never,
        maxClient as never,
        chatContextCache as never,
        createConfigMock() as never,
      );

      jest
        .spyOn(service as any, 'upsertUserChatAccess')
        .mockRejectedValueOnce({ code: 'P2024', message: 'pool timeout' });

      await expect(
        service.listChats(
          {
            userId: 'admin-1',
            username: null,
            displayName: null,
            chatTitle: null,
          },
          { fresh: true },
        ),
      ).resolves.toEqual([
        {
          id: 'chat-fresh',
          title: 'Живой чат',
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: 'chat',
          link: null,
          channelOverview: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        },
      ]);

      expect(chatContextCache.activateManagedEntitiesRefreshBackoff).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not reuse an untimed admin access lookup for a timed managed refresh check', async () => {
    const prisma = createPrismaMock();
    const firstLookup = createDeferred<string[]>();
    const secondLookup = createDeferred<string[]>();
    const maxClient = {
      getChatAdminIds: jest
        .fn()
        .mockImplementationOnce(() => firstLookup.promise)
        .mockImplementationOnce(() => secondLookup.promise),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const first = (service as any).resolveUserAndBotAdminAccess('chat-1', 'admin-1');
    await flushAsyncTasks();

    const second = (service as any).resolveUserAndBotAdminAccess('chat-1', 'admin-1', {
      trafficClass: 'interactive',
      timeoutMs: 1000,
    });
    await flushAsyncTasks();

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatAdminIds).toHaveBeenNthCalledWith(1, 'chat-1', {
      actionHealthLane: 'background',
    });
    expect(maxClient.getChatAdminIds).toHaveBeenNthCalledWith(2, 'chat-1', {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      timeoutMs: 1000,
    });

    secondLookup.resolve(['admin-1']);
    firstLookup.resolve(['admin-1']);

    await expect(second).resolves.toEqual({
      status: 'granted',
      source: 'remote',
    });
    await expect(first).resolves.toEqual({
      status: 'granted',
      source: 'remote',
    });
  });

  it('queues a durable managed entities refresh when refresh is requested and a queue is available', async () => {
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

    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
    );

    const discoverSpy = jest.spyOn(service as never, 'discoverManagedEntities');

    await expect(
      service.listChatsWithRefreshState(
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
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
          link: null,
          channelOverview: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        },
      ],
      refresh: {
        complete: false,
        cursor: 0,
        backoffActive: false,
        userVisibleComplete: true,
        nextPollAfterMs: 1500,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'in_progress',
        manualRefreshRetryAfterMs: 1500,
      },
    });

    expect(discoverSpy).not.toHaveBeenCalled();
    expect(managedEntitiesRefreshQueue.add).toHaveBeenCalledWith(
      'refresh-managed-entities',
      {
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: false,
      },
      expect.objectContaining({
        jobId: 'managed-entities-refresh__chat__admin-1',
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      }),
    );
  });

  it('pauses managed entities refresh scheduling while the shared system mode is degraded', async () => {
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

    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const degradedSnapshot = {
      mode: 'degrade',
      source: 'auto',
      reason: 'queue lag 18.0s',
      updatedAt: new Date().toISOString(),
      manualMode: null,
      queueLagSec: 18,
      action: {
        windowSec: 60,
        total: 180,
        success: 168,
        failure: 12,
        critical: 0,
        errorRate: 0.066,
        criticalRate: 0,
      },
    };
    const systemModeService = {
      peekCachedSnapshot: jest.fn().mockReturnValue(degradedSnapshot),
      getEffectiveSnapshot: jest.fn().mockResolvedValue(degradedSnapshot),
    };

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
      systemModeService as never,
    );

    await expect(
      service.listChatsWithRefreshState(
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
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
          link: null,
          channelOverview: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        },
      ],
      refresh: {
        complete: false,
        cursor: null,
        backoffActive: true,
        userVisibleComplete: true,
        nextPollAfterMs: 15_000,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'backoff',
        manualRefreshRetryAfterMs: 15_000,
      },
    });

    expect(systemModeService.peekCachedSnapshot).toHaveBeenCalled();
    expect(systemModeService.getEffectiveSnapshot).not.toHaveBeenCalled();
    expect(managedEntitiesRefreshQueue.add).not.toHaveBeenCalled();
    expect(managedEntitiesRefreshQueue.getJob).not.toHaveBeenCalled();
  });

  it('returns a continuation delay when a managed refresh background job needs more chunks', async () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const discoverSpy = jest.spyOn(service as any, 'discoverManagedEntities').mockResolvedValue({
      items: [],
      refresh: {
        complete: false,
        cursor: 20,
        backoffActive: false,
        nextPollAfterMs: 1500,
      },
    });
    const repairSpy = jest
      .spyOn(service as any, 'repairManagedEntitiesAllowlistAfterFullRefresh')
      .mockResolvedValue(undefined);

    await expect(
      service.processManagedEntitiesRefreshJob({
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: false,
      }),
    ).resolves.toEqual({
      continueAfterMs: 1500,
    });

    expect(discoverSpy).toHaveBeenCalledTimes(1);
    expect(discoverSpy).toHaveBeenCalledWith(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'chat',
      expect.objectContaining({
        respectCooldown: false,
        fullScan: true,
        includeRefreshState: true,
        bypassRemoteCache: false,
        resetRefreshCursor: false,
      }),
    );
    expect(repairSpy).not.toHaveBeenCalled();
  });

  it('repairs the allowlist when a managed refresh background job reaches completion', async () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    jest.spyOn(service as any, 'discoverManagedEntities').mockResolvedValue({
      items: [],
      refresh: {
        complete: true,
        cursor: -1,
        backoffActive: false,
        nextPollAfterMs: 0,
      },
    });
    const repairSpy = jest
      .spyOn(service as any, 'repairManagedEntitiesAllowlistAfterFullRefresh')
      .mockResolvedValue(undefined);

    await expect(
      service.processManagedEntitiesRefreshJob({
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: false,
      }),
    ).resolves.toBeNull();

    expect(repairSpy).toHaveBeenCalledWith('admin-1', 'chat');
  });

  it('defers a reset-cursor managed refresh background job when the governor reports slow pressure', async () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        decide: jest
          .fn()
          .mockImplementation(async (params: { allowRecoveryWindowRun?: boolean }) =>
            params.allowRecoveryWindowRun
              ? {
                  action: 'slow',
                  reason: 'background share 60.0%',
                  retryAfterMs: 20_000,
                }
              : {
                  action: 'pause',
                  reason: 'recovery window in progress',
                  retryAfterMs: 60_000,
                },
          ),
      } as never,
    );

    const discoverSpy = jest.spyOn(service as any, 'discoverManagedEntities');

    await expect(
      service.processManagedEntitiesRefreshJob({
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: true,
      }),
    ).resolves.toEqual({
      continueAfterMs: 20_000,
    });

    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('allows a user-triggered managed refresh job to ignore a soft queue-lag pause below the slow-path ceiling', async () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        decide: jest.fn().mockResolvedValue({
          action: 'pause',
          reason: 'user-facing queue lag 19.5s',
          retryAfterMs: 60_000,
        }),
      } as never,
    );

    const discoverSpy = jest.spyOn(service as any, 'discoverManagedEntities').mockResolvedValue({
      items: [],
      refresh: {
        complete: false,
        cursor: 20,
        backoffActive: false,
        nextPollAfterMs: 1500,
      },
    });

    await expect(
      service.processManagedEntitiesRefreshJob({
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: true,
        resetRefreshCursor: true,
      }),
    ).resolves.toEqual({
      continueAfterMs: 1500,
    });

    expect(discoverSpy).toHaveBeenCalledTimes(1);
  });

  it('uses background traffic for local full-scan admin checks', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'chat-local-1',
        title: 'Локальный чат',
        entityType: 'chat',
      }),
    ]);
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const accessSpy = jest.spyOn(service as any, 'resolveUserAndBotAdminAccess').mockResolvedValue({
      status: 'granted',
      source: 'remote',
    });
    jest.spyOn(service as any, 'upsertUserChatAccess').mockResolvedValue({
      id: 'chat-local-1',
      title: 'Локальный чат',
      createdAt: new Date('2026-03-03T10:00:00.000Z'),
      entityType: 'CHAT',
    });

    await expect(
      (service as any).runManagedEntitiesLocalDiscovery(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
        'managed-refresh-cooldown:test',
        {
          fullScan: true,
          includeRefreshState: true,
        },
      ),
    ).resolves.toEqual({
      items: [
        {
          id: 'chat-local-1',
          title: 'Локальный чат',
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: 'chat',
          link: null,
          channelOverview: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        },
      ],
      refresh: {
        complete: true,
        cursor: -1,
        backoffActive: false,
        nextPollAfterMs: 0,
        processedCandidates: 1,
        totalCandidates: 1,
        progressPercent: 100,
        lastSyncedAt: expect.any(String),
        manualRefreshBlockedReason: 'recent_sync',
        manualRefreshRetryAfterMs: expect.any(Number),
      },
    });

    expect(accessSpy).toHaveBeenCalledWith(
      'chat-local-1',
      'admin-1',
      expect.objectContaining({
        bypassNegativeCache: true,
        trafficClass: 'background',
      }),
    );
    expect((service as any).chatContextCache.setManagedEntitiesLastSyncedAt).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      expect.any(String),
      30 * 24 * 60 * 60,
    );
  });

  it('reports refresh progress from the cached discovery snapshot and last sync timestamp', async () => {
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesRefreshCursor: jest.fn().mockResolvedValue(20),
      getManagedEntitiesDiscoverySnapshot: jest.fn().mockResolvedValue(
        Array.from({ length: 50 }, (_, index) => ({
          chatId: `chat-${index + 1}`,
          title: `Чат ${index + 1}`,
          lastEventTime: 100 - index,
          entityType: 'chat',
          link: null,
        })),
      ),
      getManagedEntitiesLastSyncedAt: jest.fn().mockResolvedValue('2026-04-01T16:00:00.000Z'),
    });
    const service = new AdminService(
      createPrismaMock() as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).readManagedEntitiesRefreshState('admin-1', 'chat'),
    ).resolves.toEqual({
      complete: false,
      cursor: 20,
      backoffActive: false,
      nextPollAfterMs: 1500,
      processedCandidates: 20,
      totalCandidates: 50,
      progressPercent: 40,
      lastSyncedAt: '2026-04-01T16:00:00.000Z',
      manualRefreshBlockedReason: 'in_progress',
      manualRefreshRetryAfterMs: 1500,
    });
  });

  it('revalidates cached chats during a fresh load before showing them', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Уже не мой чат',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'chat-1',
          title: 'Уже не мой чат',
          link: null,
          entityType: 'chat',
          lastEventTime: 1,
          avatarUrl: null,
        },
      ]),
      getChatAdminIds: jest.fn().mockResolvedValue([]),
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
        { fresh: true },
      ),
    ).resolves.toEqual([]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1', {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      sourceTag: 'managed_refresh',
      timeoutMs: 750,
    });
  });

  it('skips recent bot-added chats when only fallback titles are available', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        chat_id: 'chat-fallback',
        chat_title: null,
        is_channel: 'false',
      },
    ]);
    prisma.chat.findUnique.mockResolvedValue({
      title: 'Chat chat-fallback',
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockResolvedValue({
        id: 'chat-fallback',
        title: 'Chat chat-fallback',
        entityType: 'chat',
        link: null,
        participantsCount: null,
        avatarUrl: null,
      }),
    });

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).bootstrapRecentBotAddedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
      ),
    ).resolves.toEqual([]);

    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
  });

  it('bootstraps a user-scoped recent bot_added chat even when MAX omits chatTitle', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-fallback',
          chat_title: null,
          is_channel: 'false',
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.chat.findUnique.mockResolvedValue({
      title: 'Chat chat-fallback',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-fallback',
      title: 'Chat chat-fallback',
      entityType: 'CHAT',
      createdAt: new Date('2026-04-05T00:10:00.000Z'),
      primaryBotId: null,
      botId: null,
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).bootstrapRecentBotAddedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
      ),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-fallback',
        title: 'Chat chat-fallback',
        createdAt: '2026-04-05T00:10:00.000Z',
        entityType: 'chat',
      }),
    ]);

    expect(prisma.chatAdminAllowlist.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId: {
            chatId: 'chat-fallback',
            userId: 'admin-1',
          },
        },
      }),
    );
  });

  it('re-arms a user-scoped recent bot_added fast lane when bot admin rights are still propagating', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-fresh',
          chat_title: 'Пре',
          is_channel: 'false',
        },
      ])
      .mockResolvedValueOnce([]);

    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const accessSpy = jest.spyOn(service as any, 'resolveUserAndBotAdminAccess').mockResolvedValue({
      status: 'denied',
      source: 'remote',
      reason: 'bot_not_admin',
    });
    const fastLaneSpy = jest
      .spyOn(service as any, 'scheduleUserScopedRecentBotAddedFastLane')
      .mockImplementation(() => undefined);

    await expect(
      (service as any).bootstrapRecentBotAddedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
      ),
    ).resolves.toEqual([]);

    expect(accessSpy).toHaveBeenCalledWith(
      'chat-fresh',
      'admin-1',
      expect.objectContaining({
        bypassNegativeCache: true,
        trafficClass: 'interactive',
      }),
    );
    expect(fastLaneSpy).toHaveBeenCalledWith({
      chatId: 'chat-fresh',
      entityType: 'chat',
      title: 'Пре',
      userId: 'admin-1',
      reason: 'bot_not_admin',
    });
  });

  it('hydrates a user-scoped recent bot_added chat title immediately from MAX snapshot when available', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-fallback',
          chat_title: null,
          is_channel: 'false',
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.chat.findUnique.mockResolvedValue({
      title: 'Chat chat-fallback',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-fallback',
      title: 'Chat chat-fallback',
      entityType: 'CHAT',
      createdAt: new Date('2026-04-05T00:10:00.000Z'),
      primaryBotId: null,
      botId: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-fallback',
        title: 'Рак',
        participantsCount: 17,
        status: 'active',
        isPublic: false,
        link: 'https://max.ru/chat-fallback',
        lastEventAt: null,
        entityType: 'chat',
        avatarUrl: 'https://i.oneme.ru/chat-fallback.webp',
      }),
    };
    const chatContextCache = createChatContextCacheMock();
    await chatContextCache.setManagedEntitiesPublishedSnapshot(
      'admin-1',
      'chat',
      {
        version: 'snapshot-old',
        builtAt: '2026-04-05T00:09:00.000Z',
        lastSyncedAt: null,
        itemCount: 1,
        itemsHash: 'hash-old',
        items: [
          createChatSummaryFixture({
            id: 'chat-fallback',
            title: 'Chat chat-fallback',
            createdAt: '2026-04-05T00:10:00.000Z',
            entityType: 'chat',
          }),
        ],
      },
      3600,
    );
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service as any, 'scheduleManagedEntitiesPublishedSnapshotRebuildForBootstrapChats')
      .mockImplementation(() => undefined);
    const schedulePublishedSnapshotRebuildSpy = jest
      .spyOn(service as any, 'scheduleManagedEntitiesPublishedSnapshotRebuild')
      .mockImplementation(() => undefined);

    await expect(
      (service as any).bootstrapRecentBotAddedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
      ),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-fallback',
        title: 'Рак',
        createdAt: '2026-04-05T00:10:00.000Z',
        entityType: 'chat',
        link: 'https://max.ru/chat-fallback',
        avatarUrl: 'https://i.oneme.ru/chat-fallback.webp',
      }),
    ]);

    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'chat-fallback',
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
        timeoutMs: 350,
        bypassCache: true,
      }),
    );
    expect(prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-fallback' },
      data: { title: 'Рак' },
    });
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'chat-fallback',
        title: 'Рак',
        entityType: 'chat',
        link: 'https://max.ru/chat-fallback',
        participantsCount: 17,
        avatarUrl: 'https://i.oneme.ru/chat-fallback.webp',
      }),
    );
    await expect(
      chatContextCache.getManagedEntitiesPublishedSnapshot('admin-1', 'chat'),
    ).resolves.toEqual(
      expect.objectContaining({
        itemCount: 1,
        items: [
          expect.objectContaining({
            id: 'chat-fallback',
            title: 'Рак',
            link: 'https://max.ru/chat-fallback',
            avatarUrl: 'https://i.oneme.ru/chat-fallback.webp',
          }),
        ],
      }),
    );
    expect(schedulePublishedSnapshotRebuildSpy).toHaveBeenCalledWith('admin-1', 'chat');
  });

  it('keeps recent bot-added bootstrap alive when unsupported-chat pruning hits a saturated Prisma pool', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      {
        chat_id: '152517912',
        chat_title: 'Личка с ботом',
        is_channel: 'false',
      },
    ]);
    prisma.chatAdminAllowlist.deleteMany.mockRejectedValueOnce({ code: 'P2024' });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).bootstrapRecentBotAddedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
      ),
    ).resolves.toEqual([]);

    await flushAsyncTasks();

    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '152517912',
        userId: 'admin-1',
      },
    });
  });

  it('does not call live MAX hydration for cached default managed lists', async () => {
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

    const maxClient = {
      listBotChats: jest.fn(),
      getChatSnapshot: jest.fn(),
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockResolvedValue({
        id: 'channel-1',
        title: 'Кэш канала',
        entityType: 'channel',
        link: null,
        participantsCount: null,
        avatarUrl: 'https://i.oneme.ru/channel-1.webp',
      }),
    });

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
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Кэш канала',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        avatarUrl: 'https://i.oneme.ru/channel-1.webp',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
    ]);

    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('returns a cached stale channel header when interactive MAX snapshot refresh times out', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Кэш канала',
      entityType: 'CHANNEL',
    });

    const cachedHeader = {
      id: 'channel-1',
      title: 'Кэш канала',
      entityType: 'channel' as const,
      link: null,
      participantsCount: null,
      avatarUrl: 'https://i.oneme.ru/channel-1.webp',
    };
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockRejectedValue(
        Object.assign(new Error('timeout of 5000ms exceeded'), {
          code: 'ECONNABORTED',
        }),
      ),
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockResolvedValue(cachedHeader),
    });

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.getChannelHeader('channel-1', {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual({
      ...cachedHeader,
      primaryBotId: null,
      assignedBots: [],
      sharedMode: 'owned',
    });

    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      ignoreFailureMetricStatuses: [403, 404],
    });
  });

  it('routes admin profile hydration through background action health lane', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatMemberProfiles: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    (service as any).resolveUserDisplayNames = jest.fn().mockResolvedValue(new Map());

    await (service as any).resolveUserProfiles('chat-1', 'chat', ['user-1']);

    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith('chat-1', ['user-1'], {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      ignoreFailureMetricStatuses: [403, 404],
    });
  });

  it('prefers the access assist bot for background profile hydration', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatMemberProfiles: jest.fn().mockResolvedValue(new Map()),
    };
    const maxBotLinkService = {
      resolveBotIdForCapability: jest.fn().mockResolvedValue('id613002203036_4_bot'),
      resolveBotId: jest.fn().mockResolvedValue('id613002203036_bot'),
      getBotTokenSync: jest.fn().mockReturnValue(null),
      getValidationTokens: jest.fn().mockReturnValue([]),
      buildEntryBotStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?start=payload'),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?startapp=payload'),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    (service as any).resolveUserDisplayNames = jest.fn().mockResolvedValue(new Map());

    await (service as any).resolveUserProfiles('chat-1', 'chat', ['user-1']);

    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith('chat-1', ['user-1'], {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      ignoreFailureMetricStatuses: [403, 404],
      botId: 'id613002203036_4_bot',
    });
  });

  it('backs off background header hydration after MAX API throttling', async () => {
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

    const maxClient = {
      getChatSnapshot: jest
        .fn()
        .mockRejectedValue(new Error('MAX API background rate limit exceeded')),
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockResolvedValue(null),
    });

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
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Кэш канала',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
    ]);

    await flushAsyncTasks();

    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
      trafficClass: 'background',
      sourceTag: 'managed_refresh',
    });
    expect(chatContextCache.activateManagedEntitiesRefreshBackoff).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      60,
    );
  });

  it('hydrates assigned bot avatars for managed entity headers and caches fresh misses', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([
      {
        id: 'chat-1',
        botId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_bot',
        botMemberships: [
          {
            botId: 'id613002203036_bot',
            role: 'PRIMARY',
            status: 'ACTIVE',
            capabilities: [],
            permissionsSnapshot: null,
          },
          {
            botId: 'id613002203036_4_bot',
            role: 'STANDBY',
            status: 'ACTIVE',
            capabilities: [],
            permissionsSnapshot: null,
          },
        ],
      },
    ]);

    const maxClient = {
      getOwnProfile: jest.fn().mockResolvedValue({
        userId: '214634783',
        avatarUrl: 'https://cdn.max.ru/u/214634783/avatar.jpg',
      }),
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityBotProfile: jest
        .fn()
        .mockImplementation(async (botId: string) =>
          botId === 'id613002203036_bot'
            ? { avatarUrl: 'https://cdn.max.ru/u/613002203036/avatar.jpg' }
            : null,
        ),
    });
    const maxBotRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        {
          id: 'id613002203036_bot',
          label: 'MAXIM',
          state: 'active',
          speechPersona: 'male',
          characterName: 'Майор Максимов',
        },
        {
          id: 'id613002203036_4_bot',
          label: 'MAXIM 2',
          state: 'active',
          speechPersona: 'female',
          characterName: 'Майор Максимова',
        },
      ]),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock({ botId: 'id613002203036_bot' }) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotRegistry as never,
    );

    const result = await (service as any).attachManagedEntityHeaderBotAssignments(
      createManagedEntityHeaderFixture({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'chat',
        primaryBotId: 'id613002203036_bot',
      }),
    );

    expect(result.assignedBots).toEqual([
      {
        botId: 'id613002203036_bot',
        label: 'MAXIM',
        role: 'primary',
        membershipStatus: 'active',
        lifecycleState: 'active',
        speechPersona: 'male',
        characterName: 'Майор Максимов',
        avatarUrl: 'https://cdn.max.ru/u/613002203036/avatar.jpg',
        capabilities: [],
        permissionsSummary: null,
      },
      {
        botId: 'id613002203036_4_bot',
        label: 'MAXIM 2',
        role: 'standby',
        membershipStatus: 'active',
        lifecycleState: 'active',
        speechPersona: 'female',
        characterName: 'Майор Максимова',
        avatarUrl: 'https://cdn.max.ru/u/214634783/avatar.jpg',
        capabilities: [],
        permissionsSummary: null,
      },
    ]);
    expect(maxClient.getOwnProfile).toHaveBeenCalledWith({
      botId: 'id613002203036_4_bot',
      trafficClass: 'interactive',
      timeoutMs: 2500,
      sourceTag: 'settings_bot_profile',
    });
    expect(chatContextCache.setManagedEntityBotProfile).toHaveBeenCalledWith(
      'id613002203036_4_bot',
      {
        avatarUrl: 'https://cdn.max.ru/u/214634783/avatar.jpg',
      },
    );
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

    const getSettingsSpy = jest.spyOn(service, 'getSettings').mockResolvedValue(settings);
    const getRulesSpy = jest.spyOn(service, 'getRules').mockResolvedValue(rules);
    const getChatHeaderSpy = jest.spyOn(service, 'getChatHeader').mockResolvedValue(
      createManagedEntityHeaderFixture({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'chat',
        participantsCount: 128,
      }),
    );
    const getDomainAllowlistDetailsSpy = jest
      .spyOn(service, 'getDomainAllowlistDetails')
      .mockResolvedValue([
        {
          domain: 'https://example.com',
          normalizedValue: 'https://example.com',
          matchType: 'EXACT',
          removeAfterAt: null,
        },
      ]);
    const listManagedBroadcastsSpy = jest
      .spyOn(service, 'listManagedBroadcasts')
      .mockResolvedValue([]);
    jest.spyOn(service, 'assertChatAdmin').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'ensureEntityType').mockResolvedValue(undefined);

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
        primaryBotId: null,
        assignedBots: [],
        sharedMode: 'owned',
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
    expect(getSettingsSpy).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'admin-1' }),
      { skipAdminCheck: true, skipEntityCheck: true },
    );
    expect(getRulesSpy).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'admin-1' }),
      { skipAdminCheck: true, skipEntityCheck: true },
    );
    expect(getChatHeaderSpy).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'admin-1' }),
      { skipAdminCheck: true, skipEntityCheck: true },
    );
    expect(getDomainAllowlistDetailsSpy).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'admin-1' }),
      { skipAdminCheck: true },
    );
    expect(listManagedBroadcastsSpy).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'admin-1' }),
      { skipAdminCheck: true, skipEntityCheck: true },
    );
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
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Регион 2',
        entityType: 'chat',
        createdAt: '2026-03-02T00:00:00.000Z',
      }),
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

    await flushAsyncTasks();
    await flushAsyncTasks();
    if (!resolveAdminIds) {
      throw new Error('resolveAdminIds was not initialized');
    }
    resolveAdminIds(['admin-1']);
    await expect(Promise.all(pending)).resolves.toEqual([undefined, undefined, undefined]);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
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
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        actionHealthLane: 'background',
      }),
    );
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
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        actionHealthLane: 'background',
      }),
    );
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
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        actionHealthLane: 'background',
      }),
    );
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
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(2);
  });

  it('skips persisted access writes for read-only events queries with cached granted access', async () => {
    const prisma = createPrismaMock();
    prisma.moderationEvent.findMany.mockResolvedValue([]);
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('granted'),
    });
    const maxClient = {
      getChatAdminIds: jest.fn(),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.getEvents('chat-1', user, {})).resolves.toEqual([]);

    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
      },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 20,
    });
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
      avatarUrl: null,
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
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
          createdAt: '2026-03-07T11:40:00.000Z',
        },
        {
          id: 'wh-ch-2',
          type: 'left',
          userId: 'user-11',
          userDisplayName: 'Елена',
          avatarUrl: 'https://cdn.max.ru/u/11/avatar-full.jpg',
          profileUrl: null,
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
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
    const membershipSqlText = extractSqlText(prisma.$queryRaw.mock.calls[1]?.[0]);
    expect(membershipSqlText).toContain('WITH membership_events AS (');
    expect(membershipSqlText).toContain('ORDER BY created_at');
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
      avatarUrl: null,
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
      profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
      createdAt: '2026-03-07T09:30:00.000Z',
    });
  });
});

describe('AdminService.getChatParticipantsPage', () => {
  it('returns a paginated chat roster with avatars, roles and profile handoff links', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-15T12:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chat.findUnique.mockResolvedValue({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'CHAT',
      });
      prisma.chatSettings.findUnique.mockResolvedValue({
        nightModeTimezone: 'Europe/Moscow',
      });
      prisma.moderationEvent.groupBy.mockResolvedValue([
        {
          userId: 'owner-1',
          _count: { _all: 3 },
        },
      ]);
      prisma.chatParticipantModerationImmunity.findMany.mockResolvedValue([
        {
          id: 'immunity-1',
          chatId: 'chat-1',
          userId: 'owner-1',
          expiresAt: new Date('2026-04-16T12:00:00.000Z'),
          dailyViolationLimit: 5,
          dailyViolationUsage: 2,
          usageDateKey: '2026-04-15',
          createdByUserId: 'admin-1',
          updatedByUserId: 'admin-1',
          createdAt: new Date('2026-04-15T10:00:00.000Z'),
          updatedAt: new Date('2026-04-15T10:00:00.000Z'),
        },
      ]);

      const chatContextCache = createChatContextCacheMock();
      const maxClient = {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getChatMembersPage: jest.fn().mockResolvedValue({
          items: [
            {
              userId: 'owner-1',
              displayName: 'Александра',
              username: 'alexandra',
              avatarUrl: 'https://cdn.max.ru/u/owner-1/avatar-full.jpg',
              profileUrl: null,
              role: 'owner',
              isBot: false,
            },
            {
              userId: 'id613002203036_bot',
              displayName: 'MAXIM',
              username: 'id613002203036_bot',
              avatarUrl: 'https://cdn.max.ru/u/maxim/avatar-full.jpg',
              profileUrl: 'https://max.ru/maxim-helper',
              role: 'admin',
              isBot: true,
            },
          ],
          nextMarker: 'page-2',
        }),
        getChatSnapshot: jest.fn().mockResolvedValue({
          chatId: 'chat-1',
          title: 'Команда MAX',
          participantsCount: 1584,
          status: 'active',
          isPublic: false,
          link: null,
          lastEventAt: '2026-04-14T10:00:00.000Z',
          entityType: 'chat',
          avatarUrl: 'https://cdn.max.ru/chats/chat-1/avatar.jpg',
        }),
      };

      const service = new AdminService(
        prisma as never,
        maxClient as never,
        chatContextCache as never,
        createConfigMock() as never,
      );

      const result = await service.getChatParticipantsPage(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { limit: 2, range: '24h' },
      );

      expect(maxClient.getChatMembersPage).toHaveBeenCalledWith(
        'chat-1',
        {
          limit: 2,
          marker: null,
        },
        expect.objectContaining({
          trafficClass: 'interactive',
          actionHealthLane: 'background',
        }),
      );
      expect(prisma.moderationEvent.groupBy).toHaveBeenCalledWith({
        by: ['userId'],
        where: {
          chatId: 'chat-1',
          userId: { in: ['owner-1', 'id613002203036_bot'] },
          createdAt: {
            gte: expect.any(Date),
            lte: expect.any(Date),
          },
          action: {
            in: ['WARN', 'DELETE_MESSAGE', 'MUTE', 'KICK', 'BAN'],
          },
        },
        _count: { _all: true },
      });
      expect(result).toEqual({
        items: [
          {
            userId: 'owner-1',
            userDisplayName: 'Александра',
            username: 'alexandra',
            avatarUrl: 'https://cdn.max.ru/u/owner-1/avatar-full.jpg',
            profileUrl: 'https://max.ru/alexandra',
            profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start='),
            violationCount: 3,
            immunity: {
              expiresAt: '2026-04-16T12:00:00.000Z',
              dailyViolationLimit: 5,
              usedViolatingMessagesToday: 2,
              remainingViolatingMessagesToday: 3,
            },
            role: 'owner',
            isBot: false,
          },
          {
            userId: 'id613002203036_bot',
            userDisplayName: 'MAXIM',
            username: 'id613002203036_bot',
            avatarUrl: 'https://cdn.max.ru/u/maxim/avatar-full.jpg',
            profileUrl: 'https://max.ru/maxim-helper',
            profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start='),
            violationCount: 0,
            immunity: null,
            role: 'admin',
            isBot: true,
          },
        ],
        totalCount: 1584,
        hasMore: true,
        nextCursor: 'page-2',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('upserts participant immunity and returns a compact summary', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-15T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chat.findUnique.mockResolvedValue({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'CHAT',
      });
      prisma.chatSettings.findUnique.mockResolvedValue({
        nightModeTimezone: 'Europe/Moscow',
      });
      prisma.chatParticipantModerationImmunity.upsert.mockResolvedValue({
        id: 'immunity-1',
        chatId: 'chat-1',
        userId: 'user-1',
        expiresAt: new Date('2026-05-15T09:00:00.000Z'),
        dailyViolationLimit: 4,
        dailyViolationUsage: 0,
        usageDateKey: '2026-04-15',
        createdByUserId: 'admin-1',
        updatedByUserId: 'admin-1',
        createdAt: new Date('2026-04-15T09:00:00.000Z'),
        updatedAt: new Date('2026-04-15T09:00:00.000Z'),
      });

      const service = new AdminService(
        prisma as never,
        {
          getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        } as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );

      const result = await service.updateChatParticipantImmunity(
        'chat-1',
        'user-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          enabled: true,
          durationHours: 720,
          dailyViolationLimit: 4,
        },
      );

      expect(prisma.chatParticipantModerationImmunity.upsert).toHaveBeenCalledWith({
        where: {
          chatId_userId: {
            chatId: 'chat-1',
            userId: 'user-1',
          },
        },
        create: {
          chatId: 'chat-1',
          userId: 'user-1',
          expiresAt: new Date('2026-05-15T09:00:00.000Z'),
          dailyViolationLimit: 4,
          dailyViolationUsage: 0,
          usageDateKey: '2026-04-15',
          createdByUserId: 'admin-1',
          updatedByUserId: 'admin-1',
        },
        update: {
          expiresAt: new Date('2026-05-15T09:00:00.000Z'),
          dailyViolationLimit: 4,
          dailyViolationUsage: 0,
          usageDateKey: '2026-04-15',
          updatedByUserId: 'admin-1',
        },
      });
      expect(result).toEqual({
        immunity: {
          expiresAt: '2026-05-15T09:00:00.000Z',
          dailyViolationLimit: 4,
          usedViolatingMessagesToday: 0,
          remainingViolatingMessagesToday: 4,
        },
        message: 'Иммунитет обновлён.',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects participant immunity shorter than one day', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    let thrown: unknown;
    try {
      await service.updateChatParticipantImmunity(
        'chat-1',
        'user-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          enabled: true,
          durationHours: 12,
          dailyViolationLimit: 4,
        },
      );
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({
      durationHours: {
        _errors: ['Срок должен быть от 1 до 30 дней.'],
      },
    });
  });

  it('rejects participant immunity for chat admins', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'user-2',
          isAdmin: true,
          isOwner: false,
          permissions: [],
        }),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    let thrown: unknown;
    try {
      await service.updateChatParticipantImmunity(
        'chat-1',
        'user-2',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          enabled: true,
          durationHours: 24,
          dailyViolationLimit: 3,
        },
      );
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toBe(
      'Иммунитет можно выдать только обычному участнику.',
    );
    expect(prisma.chatParticipantModerationImmunity.upsert).not.toHaveBeenCalled();
  });

  it('removes participant immunity', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.updateChatParticipantImmunity(
      'chat-1',
      'user-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        enabled: false,
      },
    );

    expect(prisma.chatParticipantModerationImmunity.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        userId: 'user-1',
      },
    });
    expect(result).toEqual({
      immunity: null,
      message: 'Иммунитет снят.',
    });
  });
});

describe('AdminService.updateChannelSettings', () => {
  it('creates fresh channel settings with comments disabled by default', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Канал MAX',
      entityType: 'CHANNEL',
      channelSettings: {
        chatId: 'channel-1',
        ...channelSettingsSchema.parse({ commentsEnabled: false }),
      },
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

    const result = await service.getChannelSettings('channel-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.commentsEnabled).toBe(false);
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          channelSettings: {
            create: expect.objectContaining({
              commentsEnabled: false,
            }),
          },
        }),
        update: expect.objectContaining({
          channelSettings: {
            upsert: expect.objectContaining({
              create: expect.objectContaining({
                commentsEnabled: false,
              }),
            }),
          },
        }),
      }),
    );
  });

  it('does not probe manual-action bot access while reading channel settings', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      entityType: 'CHANNEL',
      primaryBotId: 'id613002203036_bot',
      botId: null,
      botMemberships: [],
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Канал MAX',
      entityType: 'CHANNEL',
      channelSettings: {
        chatId: 'channel-1',
        ...channelSettingsSchema.parse({ commentsEnabled: false }),
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );

    await service.getChannelSettings('channel-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

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

  it('invalidates channel context cache and refreshes bot access snapshots after channel settings update', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = createChatContextCacheMock();
    const maxBotExecutionPlanner = {
      refreshChatBotCapabilitySnapshots: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotExecutionPlanner as never,
    );

    await service.updateChannelSettings(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        commentsEnabled: true,
      },
    );

    expect(chatContextCache.invalidate).toHaveBeenCalledWith('channel-1');
    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenCalledWith({
      chatId: 'channel-1',
      entityType: 'channel',
    });
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
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
  });

  it('stops the mass chat scan when refresh cursor makes no progress', async () => {
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
    const discoverySpy = jest
      .spyOn(
        service as unknown as {
          discoverManagedEntities: (...args: unknown[]) => Promise<unknown>;
        },
        'discoverManagedEntities',
      )
      .mockResolvedValue({
        items: [],
        refresh: {
          complete: false,
          cursor: null,
          backoffActive: false,
          nextPollAfterMs: 1500,
        },
      });

    const result = await service.listChatsForMassBroadcast({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(discoverySpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
  });

  it('keeps draining due managed broadcasts until the current backlog is exhausted', async () => {
    const prisma = createPrismaMock();
    let activeCalls = 0;
    prisma.managedBroadcast.findMany.mockImplementation(
      async ({
        where,
      }: {
        where?: { status?: string | { in?: string[] } };
      }) => {
        if (where?.status === 'ACTIVE') {
          activeCalls += 1;
          return activeCalls < 3 ? [{ id: 'broadcast-1' }] : [];
        }
        return [];
      },
    );

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

    expect(prisma.managedBroadcast.findMany).toHaveBeenCalledTimes(6);
    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(processSpy).toHaveBeenNthCalledWith(1, 'broadcast-1', 'scheduled', expect.any(Date), [
      'ACTIVE',
      'PARTIAL',
      'FAILED',
    ]);
    expect(processSpy).toHaveBeenNthCalledWith(2, 'broadcast-1', 'scheduled', expect.any(Date), [
      'ACTIVE',
      'PARTIAL',
      'FAILED',
    ]);
  });

  it('keeps retryable managed broadcasts moving even when active backlog is present', async () => {
    const prisma = createPrismaMock();
    let activeCalls = 0;
    let retryableCalls = 0;
    prisma.managedBroadcast.findMany.mockImplementation(
      async ({
        where,
      }: {
        where?: { status?: string | { in?: string[] } };
      }) => {
        if (where?.status === 'ACTIVE') {
          activeCalls += 1;
          return activeCalls === 1
            ? Array.from({ length: 10 }, (_, index) => ({
                id: `active-${index + 1}`,
              }))
            : [];
        }

        const statusFilter = where?.status as { in?: string[] } | undefined;
        if (Array.isArray(statusFilter?.in) && statusFilter.in.includes('FAILED')) {
          retryableCalls += 1;
          return retryableCalls === 1 ? [{ id: 'recovery-1' }] : [];
        }

        return [];
      },
    );

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

    expect(processSpy).toHaveBeenCalledTimes(10);
    expect(processSpy).toHaveBeenNthCalledWith(1, 'active-1', 'scheduled', expect.any(Date), [
      'ACTIVE',
      'PARTIAL',
      'FAILED',
    ]);
    expect(processSpy).toHaveBeenNthCalledWith(9, 'active-9', 'scheduled', expect.any(Date), [
      'ACTIVE',
      'PARTIAL',
      'FAILED',
    ]);
    expect(processSpy).toHaveBeenNthCalledWith(10, 'recovery-1', 'scheduled', expect.any(Date), [
      'ACTIVE',
      'PARTIAL',
      'FAILED',
    ]);
  });

  it('picks failed and partial managed broadcasts after the automatic retry backoff', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

    const prisma = createPrismaMock();
    let retryableCalls = 0;
    prisma.managedBroadcast.findMany.mockImplementation(
      async ({
        where,
      }: {
        where?: { status?: string | { in?: string[] } };
      }) => {
        if (where?.status === 'ACTIVE') {
          return [];
        }

        const statusFilter = where?.status as { in?: string[] } | undefined;
        if (Array.isArray(statusFilter?.in) && statusFilter.in.includes('FAILED')) {
          retryableCalls += 1;
          return retryableCalls === 1 ? [{ id: 'broadcast-1' }] : [];
        }

        return [];
      },
    );

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

    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith('broadcast-1', 'scheduled', expect.any(Date), [
      'ACTIVE',
      'PARTIAL',
      'FAILED',
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
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
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
    await expect(prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } })).resolves
      .toEqual(
        expect.objectContaining({
          nextSendAt: new Date('2026-03-03T12:00:00.000Z'),
          sentCount: 1,
          status: 'ACTIVE',
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
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Чат 1',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
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
    await expect(prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } })).resolves
      .toEqual(
        expect.objectContaining({
          status: 'PARTIAL',
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
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
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

  it('automatically retries timed out managed broadcast deliveries on scheduled runs', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

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
        buttons: [],
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
        lastError: 'timeout of 5000ms exceeded',
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'FAILED',
        },
      ],
    });
    deliveries[0].status = 'FAILED';
    deliveries[0].attemptCount = 1;
    deliveries[0].lastError = 'timeout of 5000ms exceeded';
    deliveries[0].updatedAt = new Date('2026-03-03T10:00:00.000Z');

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-chat-1-retry',
        url: null,
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

    const result = await (service as any).processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE', 'PARTIAL', 'FAILED'],
    );

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        status: 'SENT',
        remoteMessageId: 'mid-chat-1-retry',
      }),
    );
    expect(result.status).toBe('COMPLETED');
    await expect(prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } })).resolves
      .toEqual(
        expect.objectContaining({
          status: 'COMPLETED',
          sentCount: 1,
          nextSendAt: null,
        }),
      );
  });

  it('drops permanently unavailable targets from future managed broadcast deliveries', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

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
        applyToAllChats: true,
        targetChatIds: ['chat-1', 'chat-2'],
        buttons: [],
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
        cycleEnabled: true,
        cycleEveryHours: 1,
        cycleCount: 3,
        sentCount: 0,
        status: 'FAILED',
        lastError: 'Chat closed',
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'SENT',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-2',
          status: 'FAILED',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 2,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 2,
          targetChatId: 'chat-2',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 3,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 3,
          targetChatId: 'chat-2',
          status: 'PENDING',
        },
      ],
    });
    deliveries[0].status = 'SENT';
    deliveries[0].remoteMessageId = 'mid-chat-1';
    deliveries[0].sentAt = new Date('2026-03-03T10:00:00.000Z');
    deliveries[1].status = 'FAILED';
    deliveries[1].attemptCount = 1;
    deliveries[1].lastError = 'Chat -72491481331058 not found';
    deliveries[1].updatedAt = new Date('2026-03-03T10:00:00.000Z');

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

    const result = await (service as any).processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE', 'PARTIAL', 'FAILED'],
    );

    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(result.status).toBe('ACTIVE');
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          occurrenceIndex: 1,
          targetChatId: 'chat-2',
          status: 'CANCELED',
          lastError: 'Chat -72491481331058 not found',
        }),
        expect.objectContaining({
          occurrenceIndex: 2,
          targetChatId: 'chat-2',
          status: 'CANCELED',
          lastError: 'Chat -72491481331058 not found',
        }),
        expect.objectContaining({
          occurrenceIndex: 3,
          targetChatId: 'chat-2',
          status: 'CANCELED',
          lastError: 'Chat -72491481331058 not found',
        }),
      ]),
    );
    await expect(prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } })).resolves
      .toEqual(
        expect.objectContaining({
          status: 'ACTIVE',
          sentCount: 1,
          nextSendAt: new Date('2026-03-03T11:00:00.000Z'),
          lastError: null,
        }),
      );
  });

  it('quarantines chronically timing out targets from current and future managed broadcast deliveries', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

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
        applyToAllChats: true,
        targetChatIds: ['chat-1', 'chat-2'],
        buttons: [],
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
        cycleEnabled: true,
        cycleEveryHours: 1,
        cycleCount: 3,
        sentCount: 0,
        status: 'FAILED',
        lastError: 'timeout of 5000ms exceeded',
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'SENT',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-2',
          status: 'FAILED',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 2,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 2,
          targetChatId: 'chat-2',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 3,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 3,
          targetChatId: 'chat-2',
          status: 'PENDING',
        },
      ],
    });
    deliveries[0].status = 'SENT';
    deliveries[0].remoteMessageId = 'mid-chat-1';
    deliveries[0].sentAt = new Date('2026-03-03T10:00:00.000Z');
    deliveries[1].status = 'FAILED';
    deliveries[1].attemptCount = 6;
    deliveries[1].lastError = 'timeout of 5000ms exceeded';
    deliveries[1].updatedAt = new Date('2026-03-03T10:00:00.000Z');

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

    const result = await (service as any).processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE', 'PARTIAL', 'FAILED'],
    );

    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(result.status).toBe('ACTIVE');
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          occurrenceIndex: 1,
          targetChatId: 'chat-2',
          status: 'CANCELED',
          lastError: expect.stringContaining(
            'Чат временно исключен из оставшихся доставок после повторяющихся ошибок отправки',
          ),
        }),
        expect.objectContaining({
          occurrenceIndex: 2,
          targetChatId: 'chat-2',
          status: 'CANCELED',
          lastError: expect.stringContaining(
            'Чат временно исключен из оставшихся доставок после повторяющихся ошибок отправки',
          ),
        }),
        expect.objectContaining({
          occurrenceIndex: 3,
          targetChatId: 'chat-2',
          status: 'CANCELED',
          lastError: expect.stringContaining(
            'Чат временно исключен из оставшихся доставок после повторяющихся ошибок отправки',
          ),
        }),
      ]),
    );
    await expect(prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } })).resolves
      .toEqual(
        expect.objectContaining({
          status: 'ACTIVE',
          sentCount: 1,
          nextSendAt: new Date('2026-03-03T11:00:00.000Z'),
          lastError: null,
        }),
      );
  });

  it('reports blocked and quarantined deliveries in managed broadcast snapshots', () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );

    const snapshot = (service as any).createManagedBroadcastDeliverySnapshot(
      {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: true,
        targetChatIds: ['chat-1', 'chat-2'],
        buttons: [],
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
        cycleEnabled: true,
        cycleEveryHours: 1,
        cycleCount: 3,
        sentCount: 0,
        status: 'PARTIAL',
        lastError: 'timeout of 5000ms exceeded',
        lockedAt: null,
        createdAt: new Date('2026-03-03T10:00:00.000Z'),
        updatedAt: new Date('2026-03-03T10:00:00.000Z'),
      },
      [
        {
          status: 'SENT',
          lastError: null,
        },
        {
          status: 'FAILED',
          lastError: 'timeout of 5000ms exceeded',
        },
        {
          status: 'FAILED',
          lastError: 'unexpected failure',
        },
        {
          status: 'CANCELED',
          lastError: 'Chat closed',
        },
        {
          status: 'CANCELED',
          lastError:
            'Чат временно исключен из оставшихся доставок после повторяющихся ошибок отправки: 6 неудачных попыток. Последняя ошибка: timeout of 5000ms exceeded',
        },
        {
          status: 'PENDING',
          lastError: null,
        },
      ],
    );

    expect(snapshot).toEqual(
      expect.objectContaining({
        currentOccurrence: 1,
        deliveredChats: 1,
        failedChats: 2,
        pendingChats: 1,
        blockedChats: 2,
        canRetry: true,
        failureBreakdown: {
          transient: 1,
          permanentTarget: 1,
          quarantined: 1,
          unknown: 1,
        },
      }),
    );
  });

  it('stops future managed broadcast deliveries after a fatal image processing error', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

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
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: true,
        imageBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5lmN4AAAAASUVORK5CYII=',
        imageMimeType: 'image/png',
        imageFileName: 'bad.png',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: true,
        cycleEveryHours: 1,
        cycleCount: 3,
        sentCount: 0,
        status: 'ACTIVE',
        lastError: null,
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 2,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 3,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
      ],
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest
        .fn()
        .mockRejectedValue(
          new BadRequestException('Не удалось загрузить фото. Попробуйте другое изображение.'),
        ),
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

    const result = await (service as any).processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE', 'PARTIAL', 'FAILED'],
    );

    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        canRetry: true,
        nextSendAt: null,
      }),
    );
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          occurrenceIndex: 1,
          status: 'FAILED',
          lastError: 'Не удалось загрузить фото. Попробуйте другое изображение.',
        }),
        expect.objectContaining({
          occurrenceIndex: 2,
          status: 'CANCELED',
          lastError: 'Не удалось загрузить фото. Попробуйте другое изображение.',
        }),
        expect.objectContaining({
          occurrenceIndex: 3,
          status: 'CANCELED',
          lastError: 'Не удалось загрузить фото. Попробуйте другое изображение.',
        }),
      ]),
    );
    await expect(prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } })).resolves
      .toEqual(
        expect.objectContaining({
          status: 'FAILED',
          nextSendAt: null,
          lastError: 'Не удалось загрузить фото. Попробуйте другое изображение.',
        }),
      );
  });

  it('stops future managed broadcast deliveries when automatic recovery sees a fatal image failure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

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
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: true,
        imageBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5lmN4AAAAASUVORK5CYII=',
        imageMimeType: 'image/png',
        imageFileName: 'bad.png',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: true,
        cycleEveryHours: 1,
        cycleCount: 3,
        sentCount: 0,
        status: 'FAILED',
        lastError: 'Не удалось отправить в 1 чат(ов).',
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'FAILED',
          attemptCount: 1,
          lastError: 'Не удалось загрузить фото. Попробуйте другое изображение.',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 2,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 3,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
      ],
    });

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

    const result = await (service as any).processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE', 'PARTIAL', 'FAILED'],
    );

    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        canRetry: true,
        nextSendAt: null,
        failedChatIds: ['chat-1'],
      }),
    );
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          occurrenceIndex: 1,
          status: 'FAILED',
          lastError: 'Не удалось загрузить фото. Попробуйте другое изображение.',
        }),
        expect.objectContaining({
          occurrenceIndex: 2,
          status: 'CANCELED',
          lastError: 'Не удалось загрузить фото. Попробуйте другое изображение.',
        }),
        expect.objectContaining({
          occurrenceIndex: 3,
          status: 'CANCELED',
          lastError: 'Не удалось загрузить фото. Попробуйте другое изображение.',
        }),
      ]),
    );
    await expect(prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } })).resolves
      .toEqual(
        expect.objectContaining({
          status: 'FAILED',
          nextSendAt: null,
          lastError: 'Не удалось загрузить фото. Попробуйте другое изображение.',
        }),
      );
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
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Чат 1',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
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

  it('keeps a broadcast canceled when deletion races with an in-flight send', async () => {
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
        buttons: [],
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
        status: 'ACTIVE',
        lastError: null,
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
      ],
    });

    let service!: AdminService;
    let canceledStatus: string | null = null;
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockImplementation(async () => {
        const canceled = await service.cancelManagedBroadcast('chat-1', 'broadcast-1', {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        });
        canceledStatus = canceled.status;
        return { messageId: 'mid-chat-1', url: null };
      }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await (service as any).processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE'],
    );
    const current = await prisma.managedBroadcast.findUnique({
      where: { id: 'broadcast-1' },
    });

    expect(canceledStatus).toBe('CANCELED');
    expect(result.status).toBe('CANCELED');
    expect(current).toEqual(
      expect.objectContaining({
        id: 'broadcast-1',
        status: 'CANCELED',
        nextSendAt: null,
        lockedAt: null,
      }),
    );
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          status: 'CANCELED',
        }),
      ]),
    );
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

    const allowlistRows: AllowlistRow[] = [];
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
    expect(maxClient.listBotChats).toHaveBeenCalledTimes(1);
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
        buttons: [],
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
      service as unknown as Pick<AdminServicePrivateAccess, 'resolveBroadcastButtons'>
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

  it('splits custom broadcast link buttons into MAX-safe rows before the comments button', async () => {
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
      service as unknown as Pick<AdminServicePrivateAccess, 'resolveBroadcastButtons'>
    ).resolveBroadcastButtons('chat-1', 'chat', {
      includeCustomButton: false,
      customButtonText: '',
      customButtonUrl: '',
      customButtons: [
        { text: 'Кнопка 1', url: 'https://max.ru/one' },
        { text: 'Кнопка 2', url: 'https://max.ru/two' },
        { text: 'Кнопка 3', url: 'https://max.ru/three' },
        { text: 'Кнопка 4', url: 'https://max.ru/four' },
      ],
    });

    expect(buttons.slice(0, 2)).toEqual([
      [
        { type: 'link', text: 'Кнопка 1', url: 'https://max.ru/one' },
        { type: 'link', text: 'Кнопка 2', url: 'https://max.ru/two' },
        { type: 'link', text: 'Кнопка 3', url: 'https://max.ru/three' },
      ],
      [{ type: 'link', text: 'Кнопка 4', url: 'https://max.ru/four' }],
    ]);
    expect(buttons[2]?.[0]?.text).toBe('💬 Комментарии · 0');
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
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
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
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
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

  it('accepts chat dialog tokens signed with the previous bot token', () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const previousToken = 'test-max-bot-token-previous';

    const legacyService = new AdminService(
      prisma as never,
      {} as never,
      chatContextCache as never,
      createConfigMock({ token: previousToken }) as never,
    );
    const service = new AdminService(
      prisma as never,
      {} as never,
      chatContextCache as never,
      createConfigMock({ previousToken }) as never,
    );

    const commentsToken = (
      legacyService as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', 'chat-thread-legacy') as string;
    const threadId = (
      service as unknown as Pick<AdminServicePrivateAccess, 'resolveChatDialogThreadId'>
    ).resolveChatDialogThreadId('chat-1', 'comments', commentsToken) as string | null;

    expect(threadId).toBe('chat-thread-legacy');
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
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
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
    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith('chat-1', ['user-2'], {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      ignoreFailureMetricStatuses: [403, 404],
    });
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
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
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

  it('allows the author to delete their own chat comment', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'chat-comment-delete-1',
      actorUserId: 'user-1',
      payload: {
        type: 'comments',
        threadId: 'chat-thread-delete',
        text: 'Комментарий для удаления',
      },
      createdAt: new Date('2026-03-21T11:00:00.000Z'),
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
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', 'chat-thread-delete') as string;

    const result = await service.deleteChatDialogMessage(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      'chat-comment-delete-1',
      {
        token: commentsToken,
      },
    );

    expect(prisma.auditLog.delete).toHaveBeenCalledWith({
      where: {
        id: 'chat-comment-delete-1',
      },
    });
    expect(result).toEqual({
      ok: true,
      deletedMessageId: 'chat-comment-delete-1',
    });
  });
});

describe('AdminService.sendChannelBroadcast', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

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
        text: '**Новый выпуск** уже в [канале](https://max.ru/channel/maxim).\n\n  Второй абзац с  отступом',
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
      '<p><strong>Новый выпуск</strong> уже в <a href="https://max.ru/channel/maxim">канале</a>.</p><p>&nbsp;&nbsp;Второй абзац с&nbsp;&nbsp;отступом</p>',
      {
        textFormat: 'html',
      },
      { immediate: true },
    );
  });

  it('renders escaped markdown punctuation as literal text in channel broadcasts', async () => {
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
        text: '**Анонс** C\\+\\+ \\[beta\\] \\(v2\\) \\_raw\\_',
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
      '<p><strong>Анонс</strong> C++ [beta] (v2) _raw_</p>',
      {
        textFormat: 'html',
      },
      { immediate: true },
    );
  });

  it('stores scheduled broadcast text without trimming surrounding whitespace', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    wireManagedBroadcastOccurrenceStore(prisma, []);
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

    await service.sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '\n  **Новая рассылка**\n\n  Второй абзац с  пробелом\n',
        textFormat: 'markdown',
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

    expect(prisma.managedBroadcast.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        text: '\n  **Новая рассылка**\n\n  Второй абзац с  пробелом\n',
      }),
    });
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
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
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
      buttons: [],
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
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
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
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

  it('adopts an existing chat message as the published rules post and enables rules button in violations', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: '',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: true,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:00:00.000Z'),
    });
    prisma.chatRules.update.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: '1. Без спама.\n2. Без ссылок.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: 'mid-rules-source-1',
      publishedUrl: 'https://max.ru/chats/chat-1/message/321',
      publishedAt: new Date('2026-03-09T10:00:00.000Z'),
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T10:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/chats/chat-1/message/321'),
      getMessageTextAsMarkdown: jest.fn().mockResolvedValue('1. Без спама.\n2. Без ссылок.'),
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

    const result = await service.adoptChatRulesFromMessage(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        sourceMessageId: 'mid-rules-source-1',
        sourceMessageUrl: null,
        text: '1. Без спама.\n2. Без ссылок.',
      },
      'group_command',
    );

    expect(maxClient.resolveMessageLink).toHaveBeenCalledWith('mid-rules-source-1');
    expect(maxClient.getMessageTextAsMarkdown).toHaveBeenCalledWith('mid-rules-source-1');
    expect(prisma.chatRules.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: expect.objectContaining({
        text: '1. Без спама.\n2. Без ссылок.',
        autoTextEnabled: false,
        publishedMessageId: 'mid-rules-source-1',
        publishedUrl: 'https://max.ru/chats/chat-1/message/321',
      }),
    });
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'chat-1' },
        update: expect.objectContaining({
          settings: {
            upsert: {
              update: {
                rulesAttachViolationsEnabled: true,
              },
              create: {
                rulesAttachViolationsEnabled: true,
              },
            },
          },
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        actorUserId: 'admin-1',
        action: 'ADOPT_CHAT_RULES_MESSAGE',
        payload: expect.objectContaining({
          messageId: 'mid-rules-source-1',
          url: 'https://max.ru/chats/chat-1/message/321',
          copiedText: true,
          rulesAttachViolationsEnabled: true,
          source: 'group_command',
        }),
      }),
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(result).toEqual({
      text: '1. Без спама.\n2. Без ссылок.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttons: [],
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: 'mid-rules-source-1',
      publishedUrl: 'https://max.ru/chats/chat-1/message/321',
      publishedAt: '2026-03-09T10:00:00.000Z',
    });
  });

  it('recovers MAX rich-text formatting when adopting rules from an existing message', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: '',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: true,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:00:00.000Z'),
    });
    prisma.chatRules.update.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: '🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: 'mid-rules-source-2',
      publishedUrl: 'https://max.ru/chats/chat-1/message/654',
      publishedAt: new Date('2026-03-09T10:00:00.000Z'),
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T10:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/chats/chat-1/message/654'),
      getMessageTextAsMarkdown: jest
        .fn()
        .mockResolvedValue('🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)'),
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

    await service.adoptChatRulesFromMessage(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        sourceMessageId: 'mid-rules-source-2',
        sourceMessageUrl: null,
        text: 'MAX Docs',
      },
      'group_command',
    );

    expect(prisma.chatRules.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: expect.objectContaining({
        text: '🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)',
        autoTextEnabled: false,
        publishedMessageId: 'mid-rules-source-2',
        publishedUrl: 'https://max.ru/chats/chat-1/message/654',
      }),
    });
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
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
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
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
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
          buttonEnabled: false,
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
      expect.objectContaining({
        immediate: true,
        botId: '777000_bot',
      }),
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

  it('publishes rules with autofilled text when the stored draft is empty', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: '',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: true,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-auto-1',
        url: 'https://max.ru/chats/chat-1/message/601',
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
    jest
      .spyOn(service, 'getSettings')
      .mockResolvedValue(chatSettingsSchema.parse({ russianProfanityFilterEnabled: true }));

    await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('Пожалуйста, без мата и грубой лексики.'),
      {
        textFormat: 'markdown',
      },
    );
    expect(prisma.chatRules.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: expect.objectContaining({
        text: expect.stringContaining('Пожалуйста, без мата и грубой лексики.'),
        publishedMessageId: 'mid-rules-auto-1',
        publishedUrl: 'https://max.ru/chats/chat-1/message/601',
        publishedAt: expect.any(Date),
      }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        action: 'PUBLISH_CHAT_RULES',
        payload: expect.objectContaining({
          autofilledTextApplied: true,
          source: 'miniapp',
        }),
      }),
    });
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
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
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
      expect.objectContaining({
        immediate: true,
        botId: '777000_bot',
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      'Правила без прямой ссылки.',
      {
        textFormat: 'markdown',
      },
    );
  });

  it('publishes rules with nested formatting, spaces and paragraphs intact', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text:
        '🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)\n\n~~Зачеркнутый~~\n\n  Второй абзац с  пробелами',
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
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-rich-1',
        url: 'https://max.ru/chats/chat-1/message/654',
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

    await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      '🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)\n\n~~Зачеркнутый~~\n\n  Второй абзац с  пробелами',
      {
        textFormat: 'markdown',
      },
    );
  });

  it('publishes rules with a custom post button from mini app settings', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Правила с кнопкой.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttonEnabled: true,
      buttonUrl: 'https://max.ru/help/rules',
      buttonText: 'Подробнее',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-5',
        url: 'https://max.ru/chats/chat-1/message/505',
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
    jest
      .spyOn(service as any, 'resolveManualActionBotAssignment')
      .mockResolvedValue('chat-bot-2');

    await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      'Правила с кнопкой.',
      {
        textFormat: 'markdown',
        buttons: [[{ text: 'Подробнее', type: 'link', url: 'https://max.ru/help/rules' }]],
      },
      { botId: 'chat-bot-2' },
    );
  });

  it('publishes rules with multiple custom post buttons grouped into rows', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Правила с набором кнопок.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttons: [
        { text: 'Канал', url: 'https://max.ru/channel/maxim' },
        { text: 'Чат', url: 'https://max.ru/chat/team' },
        { text: 'Профиль', url: 'https://max.ru/profile/maxim' },
        { text: 'Сайт', url: 'https://example.com/rules' },
      ],
      buttonEnabled: true,
      buttonUrl: 'https://max.ru/channel/maxim',
      buttonText: 'Канал',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-grid-1',
        url: 'https://max.ru/chats/chat-1/message/706',
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
    jest
      .spyOn(service as any, 'resolveManualActionBotAssignment')
      .mockResolvedValue('chat-bot-2');

    await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      'Правила с набором кнопок.',
      {
        textFormat: 'markdown',
        buttons: [
          [
            { text: 'Канал', type: 'link', url: 'https://max.ru/channel/maxim' },
            { text: 'Чат', type: 'link', url: 'https://max.ru/chat/team' },
            { text: 'Профиль', type: 'link', url: 'https://max.ru/profile/maxim' },
          ],
          [{ text: 'Сайт', type: 'link', url: 'https://example.com/rules' }],
        ],
      },
      { botId: 'chat-bot-2' },
    );
  });

  it('deletes the previous published rules post after a successful republish', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Обновлённые правила.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: 'mid-rules-old-1',
      publishedUrl: 'https://max.ru/chats/chat-1/message/101',
      publishedAt: new Date('2026-03-09T08:00:00.000Z'),
      createdAt: new Date('2026-03-09T07:00:00.000Z'),
      updatedAt: new Date('2026-03-09T08:00:00.000Z'),
    });

    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-new-2',
        url: 'https://max.ru/chats/chat-1/message/202',
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
    jest
      .spyOn(service as any, 'resolveManualActionBotAssignment')
      .mockResolvedValue('chat-bot-2');

    await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-rules-old-1', {
      immediate: true,
      botId: 'chat-bot-2',
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        action: 'PUBLISH_CHAT_RULES',
        payload: expect.objectContaining({
          replacedPreviousPost: true,
          source: 'miniapp',
        }),
      }),
    });
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
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
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
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
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
          payload: expect.objectContaining({
            buttonEnabled: false,
            source: 'private_bot',
          }),
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'PUBLISH_CHAT_RULES',
          payload: expect.objectContaining({
            buttonEnabled: false,
            source: 'private_bot',
          }),
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
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
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
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
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
    jest
      .spyOn(service as any, 'resolveManualActionBotAssignment')
      .mockResolvedValue('chat-bot-2');

    const result = await service.resetPublishedRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-rules-4', {
      immediate: true,
      botId: 'chat-bot-2',
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
      buttons: [],
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
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

    const commentsLaunch = decodeBase64UrlJson<{ c: string; m: string; t: string }>(
      commentsStartParam!.slice(3),
    );
    const parsedSuggestion = service.parseChannelSuggestionStartPayload(suggestStartParam);
    expect(parsedSuggestion).toMatchObject({
      chatId: 'channel-1',
      token: expect.stringMatching(/^cdt-/u),
    });
    const commentsToken = decodeBase64UrlJson<{ d: string; s: string }>(commentsLaunch.t.slice(4));
    const suggestToken = decodeBase64UrlJson<{ d: string; s: string }>(
      parsedSuggestion!.token.slice(4),
    );

    expect(commentsLaunch).toMatchObject({
      c: 'channel-1',
      m: 'comments',
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

  it('accepts compact suggestion launch payloads signed with the previous bot token', () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const previousToken = 'test-max-bot-token-previous';

    const legacyService = new AdminService(
      prisma as never,
      {} as never,
      chatContextCache as never,
      createConfigMock({ token: previousToken }) as never,
    );
    const service = new AdminService(
      prisma as never,
      {} as never,
      chatContextCache as never,
      createConfigMock({ previousToken }) as never,
    );

    const startPayload = (
      legacyService as unknown as {
        buildChannelSuggestionStartPayload: (chatId: string, threadId: string) => string;
      }
    ).buildChannelSuggestionStartPayload('channel-1', '12345678-1234-1234-9234-1234567890ab');

    expect(service.parseChannelSuggestionStartPayload(startPayload)).toMatchObject({
      chatId: 'channel-1',
      token: expect.stringMatching(/^cdt-/u),
    });
  });

  it('returns a bot redirect url for channel suggestion dialog tokens', async () => {
    const prisma = createPrismaMock();
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        postSuggestionsEnabled: true,
      }),
    );

    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const token = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'suggest',
      '12345678-1234-1234-9234-1234567890ab',
    );

    const result = await service.getChannelSuggestionRedirect('channel-1', token);

    expect(result.title).toBeNull();
    expect(result.url).toMatch(/^https:\/\/max\.ru\/777000_bot\?start=/u);

    const startPayload = new URL(result.url).searchParams.get('start');
    expect(service.parseChannelSuggestionStartPayload(startPayload)).toEqual({
      chatId: 'channel-1',
      token,
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
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
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
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
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
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
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
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
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

  it('allows the author to edit a channel comment and returns edit capabilities', async () => {
    const prisma = createPrismaMock();
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'comment-edit-1',
      actorUserId: 'user-1',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-edit',
        text: 'Старый текст',
        authorDisplayName: 'Пользователь',
        reactions: [{ emoji: '👍', userIds: ['user-2'] }],
      },
      createdAt: new Date('2026-03-21T10:00:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'comment-edit-1',
      actorUserId: 'user-1',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-edit',
        text: 'Обновлённый текст',
        editedAt: '2026-03-21T10:05:00.000Z',
        authorDisplayName: 'Пользователь',
        reactions: [{ emoji: '👍', userIds: ['user-2'] }],
      },
      createdAt: new Date('2026-03-21T10:00:00.000Z'),
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
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken('channel', 'channel-1', 'comments', 'channel-thread-edit') as string;

    const result = await service.updateChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      'comment-edit-1',
      {
        token: commentsToken,
        text: 'Обновлённый текст',
      },
    );

    expect(prisma.auditLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'comment-edit-1',
        },
        data: expect.objectContaining({
          payload: expect.objectContaining({
            text: 'Обновлённый текст',
            editedAt: expect.any(String),
          }),
        }),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      message: {
        id: 'comment-edit-1',
        text: 'Обновлённый текст',
        editedAt: '2026-03-21T10:05:00.000Z',
        canEdit: true,
        canDelete: true,
        canDeleteAsAdmin: false,
      },
    });
  });

  it('rejects editing another user channel comment', async () => {
    const prisma = createPrismaMock();
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'comment-edit-foreign-1',
      actorUserId: 'user-2',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-edit-foreign',
        text: 'Чужой комментарий',
      },
      createdAt: new Date('2026-03-21T10:00:00.000Z'),
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
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-edit-foreign',
    ) as string;

    await expect(
      service.updateChannelDialogMessage(
        'channel-1',
        {
          userId: 'user-1',
          username: 'user1',
          displayName: 'Пользователь',
          chatTitle: null,
        },
        'comments',
        'comment-edit-foreign-1',
        {
          token: commentsToken,
          text: 'Пытаюсь изменить чужой комментарий',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it('allows an admin to delete another user channel comment', async () => {
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
      id: 'comment-delete-admin-1',
      actorUserId: 'user-2',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-delete-admin',
        text: 'Чужой комментарий',
      },
      createdAt: new Date('2026-03-21T10:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-delete-admin',
    ) as string;

    const result = await service.deleteChannelDialogMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: 'admin1',
        displayName: 'Админ',
        chatTitle: null,
      },
      'comments',
      'comment-delete-admin-1',
      {
        token: commentsToken,
      },
    );

    expect(prisma.auditLog.delete).toHaveBeenCalledWith({
      where: {
        id: 'comment-delete-admin-1',
      },
    });
    expect(result).toEqual({
      ok: true,
      deletedMessageId: 'comment-delete-admin-1',
    });
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
          botId: 'channel-bot-2',
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
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
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
      { botId: 'channel-bot-2' },
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
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
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

  it('refreshes auto-attached channel buttons on the bot copy instead of the original forwarded post', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.count.mockResolvedValue(5);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'channel-auto-forward-ref-1',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: {
          messageId: 'mid-channel-forward-original-1',
          replacementMessageId: 'mid-channel-forward-copy-1',
          deliveryMode: 'replace_with_bot_message',
          threadId: 'channel-thread-forward-counter',
          includeCommentsButton: true,
          includeSuggestButton: true,
          suggestButtonText: 'Предложить пост',
        },
      },
    ]);
    prisma.auditLog.create.mockResolvedValue({
      id: 'channel-comment-count-forward-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-20T09:06:00.000Z'),
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
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-forward-counter',
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
        text: 'Комментарий под пересланным постом',
      },
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-forward-copy-1',
      null,
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: '💬 Комментарии · 5', type: 'link' })],
          [expect.objectContaining({ text: 'Предложить пост', type: 'link' })],
        ],
      }),
    );
  });

  it('refreshes auto-attached channel buttons on the reply fallback message', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.count.mockResolvedValue(6);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'channel-auto-forward-reply-ref-1',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: {
          messageId: 'mid-channel-forward-original-2',
          replyMessageId: 'mid-channel-forward-reply-2',
          deliveryMode: 'reply_message',
          threadId: 'channel-thread-forward-reply-counter',
          includeCommentsButton: true,
          includeSuggestButton: false,
        },
      },
    ]);
    prisma.auditLog.create.mockResolvedValue({
      id: 'channel-comment-count-forward-2',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-20T09:07:00.000Z'),
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
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-forward-reply-counter',
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
        text: 'Комментарий под fallback reply',
      },
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-forward-reply-2',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: '💬 Комментарии · 6', type: 'link' })]],
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
      { botId: '777000_bot' },
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

  it('queues mini app suggestions for async admin delivery when the queue is available', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-queued-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        threadId: null,
        text: 'Отложенная предложка',
        authorDisplayName: 'Пользователь',
        delivered: false,
        deliveredToUserId: null,
        deliveredToUserIds: [],
        deliveries: [],
        source: 'miniapp_dialog',
        reviewStatus: 'pending',
        hasImage: false,
        hasVideo: false,
      },
      createdAt: new Date('2026-03-25T09:15:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-queue-1', url: null }),
      sendMessageImmediateWithId: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const adminSuggestionDeliveryQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      adminSuggestionDeliveryQueue as never,
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
        text: 'Отложенная предложка',
      },
    );

    expect(adminSuggestionDeliveryQueue.add).toHaveBeenCalledWith(
      'deliver-channel-suggestion',
      {
        auditLogId: 'suggestion-queued-1',
      },
      expect.objectContaining({
        jobId: 'channel-suggestion-delivery__suggestion-queued-1',
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      message: {
        id: 'suggestion-queued-1',
        type: 'suggest',
        text: 'Отложенная предложка',
        delivered: false,
        reviewStatus: 'pending',
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
      { botId: '777000_bot' },
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
      expect.objectContaining({
        trafficClass: 'background',
        botId: '777000_bot',
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            source: 'private_bot',
            hasImage: true,
            imageCount: 1,
            imageFileName: 'suggestion.png',
            imageFileNames: ['suggestion.png'],
            images: [
              expect.objectContaining({
                fileName: 'suggestion.png',
                mimeType: 'image/png',
              }),
            ],
          }),
        }),
      }),
    );
  });

  it('delivers bot-submitted multi-photo suggestions to admins as image attachments', async () => {
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
      id: 'suggestion-multi-photo-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-10T12:12:15.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-7b', url: null }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-admin-3b', url: null }),
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
        text: 'Подборка фото',
        images: [
          {
            payload: { token: 'uploaded-image-1' },
            mimeType: 'image/png',
            fileName: 'suggestion-1.png',
          },
          {
            payload: { token: 'uploaded-image-2' },
            mimeType: 'image/jpeg',
            fileName: 'suggestion-2.jpg',
          },
        ],
      },
    );

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '555001',
      expect.stringContaining('[Пользователь](max://user/user-1)'),
      expect.objectContaining({
        attachments: [
          { type: 'image', payload: { token: 'uploaded-image-1' } },
          { type: 'image', payload: { token: 'uploaded-image-2' } },
        ],
        textFormat: 'markdown',
        buttons: [
          [
            expect.objectContaining({ text: '📰 В публикацию', type: 'callback' }),
            expect.objectContaining({ text: '✖️ Отклонить', type: 'callback' }),
          ],
        ],
      }),
      expect.objectContaining({
        trafficClass: 'background',
        botId: '777000_bot',
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            source: 'private_bot',
            hasImage: true,
            imageCount: 2,
            imageFileName: 'suggestion-1.png',
            imageFileNames: ['suggestion-1.png', 'suggestion-2.jpg'],
            images: [
              expect.objectContaining({
                payload: { token: 'uploaded-image-1' },
                mimeType: 'image/png',
                fileName: 'suggestion-1.png',
              }),
              expect.objectContaining({
                payload: { token: 'uploaded-image-2' },
                mimeType: 'image/jpeg',
                fileName: 'suggestion-2.jpg',
              }),
            ],
          }),
        }),
      }),
    );
  });

  it('delivers bot-submitted video suggestions to admins with attachment retry', async () => {
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
      id: 'suggestion-video-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-10T12:12:30.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-7', url: null }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockRejectedValueOnce({
          response: {
            status: 400,
            data: {
              code: 'attachment.not.ready',
            },
          },
        })
        .mockResolvedValueOnce({ messageId: 'mid-suggestion-admin-video-1', url: null }),
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
    const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

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
        mediaType: 'video',
        mediaPayload: { token: 'uploaded-video-1' },
        mediaMimeType: 'video/mp4',
        mediaFileName: 'suggestion.mp4',
      },
    );

    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenLastCalledWith(
      '555001',
      expect.stringContaining('[Пользователь](max://user/user-1)'),
      expect.objectContaining({
        attachments: [{ type: 'video', payload: { token: 'uploaded-video-1' } }],
        textFormat: 'markdown',
        buttons: [
          [
            expect.objectContaining({ text: '📰 В публикацию', type: 'callback' }),
            expect.objectContaining({ text: '✖️ Отклонить', type: 'callback' }),
          ],
        ],
      }),
      expect.objectContaining({
        trafficClass: 'background',
        botId: '777000_bot',
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            source: 'private_bot',
            hasVideo: true,
            mediaType: 'video',
            mediaMimeType: 'video/mp4',
            mediaFileName: 'suggestion.mp4',
            mediaPayload: { token: 'uploaded-video-1' },
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
          return 'id613002203036_bot';
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

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'background',
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledWith(
      '98315271',
      expect.stringContaining('[Пользователь](max://user/user-1)'),
      expect.objectContaining({
        textFormat: 'markdown',
      }),
      expect.objectContaining({
        trafficClass: 'background',
        botId: 'id613002203036_bot',
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

  it('filters every bot user id from multi-bot channel suggestion delivery even without explicit contact ids', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      primaryBotId: 'id613002203036_4_bot',
      botId: 'id613002203036_4_bot',
      botMemberships: [
        {
          botId: 'id613002203036_4_bot',
        },
        {
          botId: 'id613002203036_bot',
        },
      ],
    });
    prisma.$queryRaw.mockResolvedValue([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['209468578', '214634783', '98315271']),
      getCurrentChatMemberAccess: jest
        .fn()
        .mockImplementation(async (_chatId: string, options?: { botId?: string }) => {
          if (options?.botId === 'id613002203036_4_bot') {
            return {
              userId: '214634783',
              isAdmin: true,
              isOwner: false,
              permissions: [],
            };
          }

          if (options?.botId === 'id613002203036_bot') {
            return {
              userId: '209468578',
              isAdmin: true,
              isOwner: false,
              permissions: [],
            };
          }

          return {
            userId: '214634783',
            isAdmin: true,
            isOwner: false,
            permissions: [],
          };
        }),
      sendMessageImmediateWithId: jest.fn(),
      sendMessageImmediateToUser: jest.fn().mockResolvedValue({
        messageId: 'mid-suggestion-human-admin-1',
        url: null,
        chatId: '165176099',
      }),
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
          return 'id613002203036_bot';
        }
        if (key === 'MAX_BOT_CONTACT_ID') {
          return null;
        }
        return null;
      }),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) =>
        typeof botId === 'string' && botId.trim().length > 0 ? { id: botId.trim() } : null,
      ),
      getDefaultBot: jest.fn().mockReturnValue({ id: 'id613002203036_bot' }),
      getEntryBot: jest.fn().mockReturnValue({ id: 'id613002203036_bot' }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      config as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotRegistry as never,
    );

    const delivery = await (service as any).deliverSuggestionToAdminPrivates(
      'suggestion-multi-bot-filter-1',
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        avatarUrl: null,
      },
      {
        text: 'Предложка',
      },
    );

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({
        botId: 'id613002203036_bot',
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledWith(
      '98315271',
      expect.stringContaining('[Пользователь](max://user/user-1)'),
      expect.objectContaining({
        textFormat: 'markdown',
      }),
      expect.objectContaining({
        trafficClass: 'background',
        botId: 'id613002203036_bot',
      }),
    );
    expect(delivery).toMatchObject({
      delivered: true,
      deliveredToUserId: '98315271',
      deliveredToUserIds: ['98315271'],
      deliveries: [
        expect.objectContaining({
          adminUserId: '98315271',
          privateChatId: '165176099',
          messageId: 'mid-suggestion-human-admin-1',
        }),
      ],
    });
  });

  it('falls back to send-to-user when the cached admin private chat id is stale', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([{ recipient_chat_id: '555001' }]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-stale-private-chat-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-25T06:30:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'suggestion-stale-private-chat-1',
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
        .mockResolvedValue({ messageId: 'mid-channel-engagement-stale-private-chat', url: null }),
    };
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['98315271']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: '777000',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      sendMessageImmediateWithId: jest.fn().mockRejectedValue({
        response: {
          status: 404,
          data: {
            message: 'chat not found',
          },
        },
      }),
      sendMessageImmediateToUser: jest.fn().mockResolvedValue({
        messageId: 'mid-suggestion-human-admin-fallback-1',
        url: null,
        chatId: '777001',
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

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '555001',
      expect.stringContaining('[Пользователь](max://user/user-1)'),
      expect.objectContaining({
        textFormat: 'markdown',
      }),
      expect.objectContaining({
        trafficClass: 'background',
      }),
    );
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledWith(
      '98315271',
      expect.stringContaining('[Пользователь](max://user/user-1)'),
      expect.objectContaining({
        textFormat: 'markdown',
      }),
      expect.objectContaining({
        trafficClass: 'background',
      }),
    );
    expect(prisma.auditLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            deliveries: [
              expect.objectContaining({
                adminUserId: '98315271',
                privateChatId: '777001',
                messageId: 'mid-suggestion-human-admin-fallback-1',
              }),
            ],
          }),
        }),
      }),
    );
  });

  it('routes admin private suggestion delivery through the resolved delivery bot when assist bot differs', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([{ recipient_chat_id: '777001' }]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-entry-bot-delivery-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-25T06:35:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'suggestion-entry-bot-delivery-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        text: 'Предложка',
        delivered: true,
        deliveredToUserId: '98315271',
        source: 'private_bot',
      },
      createdAt: new Date('2026-03-25T06:35:00.000Z'),
    });

    const tokenPublisherClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-entry-bot', url: null }),
    };
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['98315271']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: '888000',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      uploadImage: jest.fn().mockResolvedValue({ token: 'entry-bot-upload-1' }),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-suggestion-entry-bot-1',
        url: null,
        chatId: '777001',
      }),
      sendMessageImmediateToUser: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      getEntryBotId: jest.fn().mockReturnValue('777000_bot'),
      getContextOrDefaultBotId: jest.fn().mockReturnValue('888000_bot'),
      isKnownBotUserId: jest.fn().mockReturnValue(false),
      resolveContactIdSync: jest.fn().mockReturnValue(null),
      resolveBotIdForCapability: jest.fn().mockResolvedValue('888000_bot'),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
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
        imageBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
        imageMimeType: 'image/png',
        imageFileName: 'entry-bot-suggestion.png',
      },
    );

    expect(maxBotLinkService.resolveBotIdForCapability).toHaveBeenCalledWith({
      chatId: 'channel-1',
      capability: 'suggestion_delivery',
    });
    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'entry-bot-suggestion.png',
      'image/png',
      { botId: '888000_bot' },
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '777001',
      expect.stringContaining('[Пользователь](max://user/user-1)'),
      expect.objectContaining({
        imagePayload: { token: 'entry-bot-upload-1' },
        textFormat: 'markdown',
      }),
      expect.objectContaining({
        botId: '888000_bot',
        trafficClass: 'background',
      }),
    );
    expect(maxClient.sendMessageImmediateToUser).not.toHaveBeenCalled();
  });

  it('publishes a reviewed suggestion and removes admin review buttons', async () => {
    const sourceThreadId = '11111111-1111-4111-8111-111111111111';
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
        threadId: sourceThreadId,
        reviewStatus: 'pending',
        deliveries: [
          {
            adminUserId: 'admin-1',
            privateChatId: '555001',
            messageId: 'mid-admin-review-1',
            botId: 'private-bot-2',
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
    jest
      .spyOn(service as any, 'resolveManualActionBotAssignment')
      .mockResolvedValue('channel-bot-2');

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
      'От подписчика [Пользователь](max://user/user-1)\n\nГотовый пост для канала',
      expect.objectContaining({
        textFormat: 'markdown',
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
              url: expect.stringContaining('start='),
            }),
          ],
        ],
      }),
      { botId: 'channel-bot-2' },
    );
    const [, , publishedOptions] =
      maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0] ?? [];
    const commentsButton = publishedOptions?.buttons?.[0]?.[0] as { url?: string } | undefined;
    const suggestButton = publishedOptions?.buttons?.[1]?.[0] as { url?: string } | undefined;
    const commentsStartParam = commentsButton?.url
      ? new URL(commentsButton.url).searchParams.get('startapp')
      : null;
    const suggestStartParam = suggestButton?.url
      ? new URL(suggestButton.url).searchParams.get('start')
      : null;
    const commentsLaunch = decodeBase64UrlJson<{ t: string }>(commentsStartParam!.slice(3));
    const commentsToken = decodeBase64UrlJson<{ d: string }>(commentsLaunch.t.slice(4));
    const parsedSuggestion = service.parseChannelSuggestionStartPayload(suggestStartParam);
    const suggestToken = decodeBase64UrlJson<{ d: string }>(parsedSuggestion!.token.slice(4));
    const autoAttachPayload = prisma.auditLog.create.mock.calls[0]?.[0]?.data?.payload as {
      messageId?: unknown;
      threadId?: unknown;
      includeCommentsButton?: unknown;
      includeSuggestButton?: unknown;
      source?: unknown;
      suggestButtonText?: unknown;
    };
    const publishedThreadId =
      typeof autoAttachPayload.threadId === 'string' ? autoAttachPayload.threadId : '';

    expect(publishedThreadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(publishedThreadId).not.toBe(sourceThreadId);
    expect(commentsToken.d).toBe(publishedThreadId);
    expect(suggestToken.d).toBe(publishedThreadId);
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
            threadId: publishedThreadId,
            includeCommentsButton: true,
            includeSuggestButton: true,
            source: 'suggestion_review',
            botId: 'channel-bot-2',
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
      { botId: 'private-bot-2' },
    );
  });

  it('publishes a reviewed photo suggestion with engagement buttons', async () => {
    const sourceThreadId = '22222222-2222-4222-8222-222222222222';
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
        threadId: sourceThreadId,
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
    jest
      .spyOn(service as any, 'resolveManualActionBotAssignment')
      .mockResolvedValue('channel-bot-2');

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
      { botId: 'channel-bot-2' },
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'От подписчика [Фотограф](max://user/user-9)\n\nФото с подписью',
      expect.objectContaining({
        textFormat: 'markdown',
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
      { botId: 'channel-bot-2' },
    );
    const autoAttachPayload = prisma.auditLog.create.mock.calls[0]?.[0]?.data?.payload as {
      threadId?: unknown;
    };
    const publishedThreadId =
      typeof autoAttachPayload.threadId === 'string' ? autoAttachPayload.threadId : '';

    expect(publishedThreadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(publishedThreadId).not.toBe(sourceThreadId);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
          payload: expect.objectContaining({
            messageId: 'mid-channel-photo-post-1',
            threadId: publishedThreadId,
            includeCommentsButton: true,
            includeSuggestButton: true,
            botId: 'channel-bot-2',
          }),
        }),
      }),
    );
  });

  it('publishes a reviewed multi-photo suggestion with engagement buttons', async () => {
    const sourceThreadId = '23232323-2323-4232-8232-232323232323';
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
      id: 'suggestion-review-multi-photo-1',
      chatId: 'channel-1',
      actorUserId: 'user-9',
      payload: {
        type: 'suggest',
        actorUserId: 'user-9',
        authorDisplayName: 'Фотограф',
        text: 'Фото с места события',
        threadId: sourceThreadId,
        reviewStatus: 'pending',
        imageCount: 2,
        imageFileNames: ['suggestion-1.png', 'suggestion-2.jpg'],
        images: [
          {
            payload: { token: 'uploaded-photo-1' },
            mimeType: 'image/png',
            fileName: 'suggestion-1.png',
          },
          {
            payload: { token: 'uploaded-photo-2' },
            mimeType: 'image/jpeg',
            fileName: 'suggestion-2.jpg',
          },
        ],
        deliveries: [
          {
            adminUserId: 'admin-1',
            privateChatId: '555001',
            messageId: 'mid-admin-review-multi-photo-1',
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
        messageId: 'mid-channel-multi-photo-post-1',
        url: 'https://max.ru/chats/channel-1/message/1011',
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
      'suggestion-review-multi-photo-1',
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
      publishedUrl: 'https://max.ru/chats/channel-1/message/1011',
    });
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'От подписчика [Фотограф](max://user/user-9)\n\nФото с места события',
      expect.objectContaining({
        textFormat: 'markdown',
        attachments: [
          { type: 'image', payload: { token: 'uploaded-photo-1' } },
          { type: 'image', payload: { token: 'uploaded-photo-2' } },
        ],
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
    const autoAttachPayload = prisma.auditLog.create.mock.calls[0]?.[0]?.data?.payload as {
      threadId?: unknown;
    };
    const publishedThreadId =
      typeof autoAttachPayload.threadId === 'string' ? autoAttachPayload.threadId : '';

    expect(publishedThreadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(publishedThreadId).not.toBe(sourceThreadId);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
          payload: expect.objectContaining({
            messageId: 'mid-channel-multi-photo-post-1',
            threadId: publishedThreadId,
            includeCommentsButton: true,
            includeSuggestButton: true,
          }),
        }),
      }),
    );
  });

  it('publishes a reviewed video suggestion with retry when attachment is not ready', async () => {
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
      id: 'suggestion-review-video-1',
      chatId: 'channel-1',
      actorUserId: 'user-9',
      payload: {
        type: 'suggest',
        actorUserId: 'user-9',
        authorDisplayName: 'Видеограф',
        text: 'Видео с подписью',
        threadId: '33333333-3333-4333-8333-333333333333',
        reviewStatus: 'pending',
        mediaType: 'video',
        mediaPayload: {
          token: 'video-upload-1',
        },
        mediaMimeType: 'video/mp4',
        mediaFileName: 'suggestion.mp4',
        deliveries: [
          {
            adminUserId: 'admin-1',
            privateChatId: '555001',
            messageId: 'mid-admin-review-video-1',
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
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockRejectedValueOnce({
          response: {
            status: 400,
            data: {
              code: 'attachment.not.ready',
            },
          },
        })
        .mockResolvedValueOnce({
          messageId: 'mid-channel-video-post-1',
          url: 'https://max.ru/chats/channel-1/message/102',
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
    const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    const result = await service.reviewChannelSuggestionByAdmin(
      'suggestion-review-video-1',
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
      publishedUrl: 'https://max.ru/chats/channel-1/message/102',
    });
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenLastCalledWith(
      'channel-1',
      'От подписчика [Видеограф](max://user/user-9)\n\nВидео с подписью',
      expect.objectContaining({
        textFormat: 'markdown',
        attachments: [{ type: 'video', payload: { token: 'video-upload-1' } }],
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
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      '555001',
      'mid-admin-review-video-1',
      expect.stringContaining('**Контент публикации**'),
      { buttons: [], textFormat: 'markdown' },
      { botId: '777000_bot' },
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
