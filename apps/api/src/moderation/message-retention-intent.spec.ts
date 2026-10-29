import { ConfigService } from '@nestjs/config';
import { Prisma } from '../prisma/prisma-client';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';

function fixture(ordinaryMode: 'on' | 'off' = 'on', retentionMode: 'on' | 'off' = 'on') {
  const state = {
    id: 'retention-intent',
    chatId: '-1',
    messageId: 'old-message',
    subjectUserId: 'human',
    sourceMessageAt: new Date(Date.now() - 25 * 3_600_000),
    entityType: 'CHAT',
    messageAuthorKind: 'user',
    originBotId: 'bot',
    routingPolicy: 'origin_first',
    retentionOwned: true,
    commercialOcrGuardRequired: false,
    commercialOcrDeadlineAt: null,
    status: 'PENDING',
    executeAt: new Date(Date.now() - 1000),
    nextAttemptAt: new Date(Date.now() - 1000),
    retryUntilAt: new Date('9999-01-01T00:00:00Z'),
    attemptCount: 1,
    lastBotId: null as string | null,
    succeededBotId: null as string | null,
    deleteDispatchStartedAt: null as Date | null,
    deleteDispatchStartedBotId: null as string | null,
    remoteDeleteSucceededAt: null as Date | null,
    remoteDeleteSucceededBotId: null as string | null,
    candidateFailures: {},
    lastStatusCode: null,
    lastErrorCode: null as string | null,
    lastError: null,
    leaseToken: 'lease',
    leaseExpiresAt: new Date(Date.now() + 60_000),
    leasedFromStatus: 'PENDING',
    // This is the real broad classifier that previously made the sole retention sentinel
    // look like independently executable ordinary moderation.
    nonCommercialOcrDeleteReason: true,
  };
  const executeRaw = jest.fn(async (query: Prisma.Sql) => {
    if (/UPDATE "moderation_delete_intents"/u.test(query.text)) {
      const literal = query.text.match(/"status"\s*=\s*CAST\('([A-Z_]+)'/u)?.[1];
      const parameter = query.text.includes('"status" = CAST($1') ? query.values[0] : undefined;
      if (typeof parameter === 'string') state.status = parameter;
      else if (literal) state.status = literal;
      const code = query.values.find(
        (value) => typeof value === 'string' && value.startsWith('message_retention_guard'),
      );
      if (typeof code === 'string') state.lastErrorCode = code;
      if (query.text.includes("'retention_reconciliation_present'"))
        state.lastErrorCode = 'retention_reconciliation_present';
    }
    return 1;
  });
  const queryRaw = jest.fn(async (query: Prisma.Sql) => {
    if (/^\s*UPDATE "moderation_delete_intents"/u.test(query.text)) state.status = 'IN_PROGRESS';
    return [{ ...state }];
  });
  const transaction = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    moderationDeleteIntent: { findUniqueOrThrow: jest.fn(async () => ({ ...state })) },
    moderationDeleteIntentReason: { findFirst: jest.fn(async () => ({ id: 'retention-reason' })) },
  };
  const prisma = {
    ...transaction,
    $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(transaction)),
  };
  const route = {
    candidateBotIds: ['bot'],
    botId: 'bot',
    primaryBotId: 'bot',
    capabilityReason: 'confirmed',
    candidateCapabilities: [
      {
        botId: 'bot',
        state: 'confirmed_capable',
        reason: 'confirmed',
        routeEligible: true,
        checkedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
  };
  const max = {
    deleteMessage: jest.fn(),
    getCurrentChatMemberAccess: jest.fn(async () => ({
      userId: 'bot',
      isAdmin: true,
      isOwner: false,
      isBot: true,
    })),
    getExactMessagePresence: jest.fn(async () => 'present'),
    getMessageSnapshot: jest.fn(),
  };
  const bots = {
    resolveDeleteMessageBotRoute: jest.fn(async () => route),
    recordBotAccessProbe: jest.fn(async () => true),
    getExecutableBotById: jest.fn(() => ({ id: 'bot' })),
  };
  const queue = { add: jest.fn() };
  const guard = { assertAllowed: jest.fn(async () => undefined) };
  const config = new ConfigService({
    MODERATION_DELETE_INTENT_MODE: ordinaryMode,
    MESSAGE_RETENTION_MODE: retentionMode,
  });
  const service = new ModerationDeleteIntentService(
    prisma as never,
    max as never,
    bots as never,
    queue as never,
    config,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    guard as never,
  );
  const heartbeat = { renew: jest.fn(async () => true), stop: jest.fn() };
  Object.assign(service, {
    loadIntent: jest.fn(async () => ({ ...state })),
    loadRequiredIntent: jest.fn(async () => ({ ...state })),
    startLeaseHeartbeat: () => heartbeat,
    assertLeaseForExternalCall: jest.fn(),
    finishProtectedManagedBotMessageAutoDelete: jest.fn(async () => null),
    recordAttemptBot: jest.fn(async () => true),
  });
  return { service, state, prisma, max, bots, guard, queue, heartbeat, config };
}

describe('retired retention intent boundary and database receipts', () => {
  const previousRole = process.env.APP_ROLE;
  afterEach(() => {
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
  });
  it.each(['message-retention', 'action', 'all'])(
    'refuses legacy deletion in role %s even with old execution flags enabled',
    async (role) => {
      process.env.APP_ROLE = role;
      const { service, state, prisma, max, bots } = fixture();
      await service.attemptIntent(state.id);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(max.deleteMessage).not.toHaveBeenCalled();
      expect(max.getExactMessagePresence).not.toHaveBeenCalled();
      expect(bots.resolveDeleteMessageBotRoute).not.toHaveBeenCalled();
      expect(state.status).toBe('PENDING');
    },
  );
  it('never reopens a terminal legacy age deletion', async () => {
    process.env.APP_ROLE = 'message-retention';
    const { service, state, prisma } = fixture();
    state.status = 'FAILED_TERMINAL';
    const result = await service.retryTerminalIntent(state.id, 'FAILED_TERMINAL', {
      updatedAt: new Date(),
      attemptCount: 1,
    });
    expect(result.reopened).toBe(false);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  it.each(['AMBIGUOUS', 'FAILED_TERMINAL', 'EXPIRED', 'OBSERVED'])(
    'settles %s with paired success markers using only database work',
    async (status) => {
      process.env.APP_ROLE = 'message-retention';
      const { service, state, max, bots, prisma } = fixture('off', 'off');
      state.status = status;
      state.remoteDeleteSucceededAt = new Date();
      state.remoteDeleteSucceededBotId = 'bot';
      const result = await service.reconcileRetentionIntent(state.id);
      expect(result).toMatchObject({ status: 'SUCCEEDED' });
      expect(
        prisma.$executeRaw.mock.calls.some(([query]) => query.text.includes("CAST('SUCCEEDED'")),
      ).toBe(true);
      expect(max.deleteMessage).not.toHaveBeenCalled();
      expect(max.getExactMessagePresence).not.toHaveBeenCalled();
      expect(max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
      expect(bots.resolveDeleteMessageBotRoute).not.toHaveBeenCalled();
    },
  );
  it.each(['AMBIGUOUS', 'FAILED_TERMINAL', 'EXPIRED', 'OBSERVED'])(
    'preserves unresolved %s dispatch evidence without reads or mutations',
    async (status) => {
      process.env.APP_ROLE = 'message-retention';
      const { service, state, max, bots, prisma } = fixture();
      state.status = status;
      state.deleteDispatchStartedAt = new Date();
      state.deleteDispatchStartedBotId = 'bot';
      const before = { ...state };
      const result = await service.reconcileRetentionIntent(state.id);
      expect(result?.status).toBe(status);
      expect(state).toEqual(before);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(max.deleteMessage).not.toHaveBeenCalled();
      expect(max.getExactMessagePresence).not.toHaveBeenCalled();
      expect(bots.resolveDeleteMessageBotRoute).not.toHaveBeenCalled();
    },
  );
  it('does not claim an independent moderation receipt in the retired lane', async () => {
    process.env.APP_ROLE = 'message-retention';
    const { service, state, prisma } = fixture();
    state.retentionOwned = false;
    expect(await service.reconcileRetentionIntent(state.id)).toBeNull();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
