import { ConfigService } from '@nestjs/config';
import { Prisma } from '../prisma/prisma-client';
import { MessageRetentionGuardError } from '../message-retention/message-retention-delete-guard.service';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
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

describe('retention intent execution and receipt recovery', () => {
  const previousRole = process.env.APP_ROLE;
  beforeEach(() => {
    process.env.APP_ROLE = 'message-retention';
  });
  afterEach(() => {
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
  });
  it.each(['on', 'off'] as const)(
    'terminalizes a protected retention skip with ordinary rollout %s',
    async (mode) => {
      const { service, guard, max, prisma } = fixture(mode);
      guard.assertAllowed.mockRejectedValue(
        new MessageRetentionGuardError('skip', 'Pinned message', 'pinned'),
      );
      const result = await service.attemptRetentionIntent('retention-intent');
      expect(result).toMatchObject({
        status: 'FAILED_TERMINAL',
        retentionOwned: true,
        guardDisposition: 'skip',
        reasonCode: 'pinned',
      });
      expect(max.deleteMessage).not.toHaveBeenCalled();
      expect(prisma.moderationDeleteIntentReason.findFirst).not.toHaveBeenCalled();
    },
  );
  it('returns a typed retry after preparation evidence expires without deleting', async () => {
    const { service, guard, max } = fixture();
    guard.assertAllowed.mockRejectedValue(
      new MessageRetentionGuardError('retry', 'Evidence expired', 'evidence_expired'),
    );
    const result = await service.attemptRetentionIntent('retention-intent');
    expect(result).toMatchObject({
      status: 'RETRYABLE',
      guardDisposition: 'retry',
      reasonCode: 'evidence_expired',
    });
    expect(max.deleteMessage).not.toHaveBeenCalled();
  });
  it('hands a concurrent ordinary owner back without executing it in the retention lane', async () => {
    const { service, state, guard, max } = fixture();
    guard.assertAllowed.mockImplementation(async () => {
      state.retentionOwned = false;
      throw new MessageRetentionGuardError('skip', 'Ownership changed', 'ownership_changed');
    });
    const result = await service.attemptRetentionIntent('retention-intent');
    expect(result).toMatchObject({ status: 'RETRYABLE', retentionOwned: false });
    expect(max.deleteMessage).not.toHaveBeenCalled();
  });
  it('does not claim an intent already handed to ordinary moderation', async () => {
    const { service, state, prisma, max } = fixture();
    state.retentionOwned = false;
    await service.attemptRetentionIntent(state.id);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(max.deleteMessage).not.toHaveBeenCalled();
  });
  it('finalizes recorded remote success while retention is off using only database work', async () => {
    const { service, state, max, bots, prisma } = fixture('off', 'off');
    state.remoteDeleteSucceededAt = new Date();
    state.remoteDeleteSucceededBotId = 'bot';
    state.status = 'AMBIGUOUS';
    const result = await service.reconcileRetentionIntent(state.id, { allowRead: false });
    expect(result).toMatchObject({ status: 'SUCCEEDED' });
    expect(
      prisma.$executeRaw.mock.calls.some(([query]) => query.text.includes("CAST('SUCCEEDED'")),
    ).toBe(true);
    expect(max.deleteMessage).not.toHaveBeenCalled();
    expect(max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(max.getExactMessagePresence).not.toHaveBeenCalled();
    expect(bots.resolveDeleteMessageBotRoute).not.toHaveBeenCalled();
  });
  it('retains unresolved dispatch evidence without MAX calls when read authority is absent', async () => {
    const { service, state, max, bots, prisma } = fixture();
    state.deleteDispatchStartedAt = new Date();
    state.deleteDispatchStartedBotId = 'bot';
    state.status = 'AMBIGUOUS';
    const result = await service.reconcileRetentionIntent(state.id, { allowRead: false });
    expect(result).toMatchObject({ status: 'AMBIGUOUS' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(max.getExactMessagePresence).not.toHaveBeenCalled();
    expect(max.deleteMessage).not.toHaveBeenCalled();
    expect(bots.resolveDeleteMessageBotRoute).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'settles exact presence=%s with read requests and no DELETE',
    async (present) => {
      const { service, state, max } = fixture();
      state.deleteDispatchStartedAt = new Date();
      state.deleteDispatchStartedBotId = 'bot';
      state.status = 'AMBIGUOUS';
      max.getExactMessagePresence.mockResolvedValue(present ? 'present' : 'absent');
      const result = await service.reconcileRetentionIntent(state.id, {
        allowRead: true,
        canRead: async () => true,
      });
      expect(result).toMatchObject({ status: present ? 'FAILED_TERMINAL' : 'ALREADY_ABSENT' });
      expect(max.getExactMessagePresence).toHaveBeenCalledWith(
        '-1',
        'old-message',
        expect.objectContaining({
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MESSAGE_RETENTION,
        }),
      );
      expect(max.deleteMessage).not.toHaveBeenCalled();
    },
  );
  it('rechecks the governor before each recovery MAX read', async () => {
    const { service, state, max } = fixture();
    state.deleteDispatchStartedAt = new Date();
    state.deleteDispatchStartedBotId = 'bot';
    state.status = 'AMBIGUOUS';
    const canRead = jest
      .fn(async () => true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const result = await service.reconcileRetentionIntent(state.id, { allowRead: true, canRead });
    expect(result).toMatchObject({ status: 'AMBIGUOUS' });
    expect(max.getExactMessagePresence).not.toHaveBeenCalled();
    expect(max.deleteMessage).not.toHaveBeenCalled();
  });
  it('does not read MAX if the runtime has switched off despite an earlier allowed snapshot', async () => {
    const { service, state, max, bots } = fixture('on', 'off');
    state.deleteDispatchStartedAt = new Date();
    state.deleteDispatchStartedBotId = 'bot';
    state.status = 'AMBIGUOUS';
    await service.reconcileRetentionIntent(state.id, {
      allowRead: true,
      canRead: async () => true,
    });
    expect(max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(max.getExactMessagePresence).not.toHaveBeenCalled();
    expect(max.deleteMessage).not.toHaveBeenCalled();
    expect(bots.resolveDeleteMessageBotRoute).not.toHaveBeenCalled();
  });
  it.each(['FAILED_TERMINAL', 'EXPIRED', 'OBSERVED'])(
    'settles legacy %s paired success markers using database work while runtime is off',
    async (status) => {
      const { service, state, max, bots } = fixture('off', 'off');
      state.status = status;
      state.remoteDeleteSucceededAt = new Date();
      state.remoteDeleteSucceededBotId = 'bot';
      const result = await service.reconcileRetentionIntent(state.id, { allowRead: false });
      expect(result).toMatchObject({ status: 'SUCCEEDED' });
      expect(max.deleteMessage).not.toHaveBeenCalled();
      expect(max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
      expect(max.getExactMessagePresence).not.toHaveBeenCalled();
      expect(bots.resolveDeleteMessageBotRoute).not.toHaveBeenCalled();
    },
  );
  it('keeps legacy terminal dispatch evidence ambiguous when exact presence remains unknown', async () => {
    const { service, state, max } = fixture();
    state.status = 'FAILED_TERMINAL';
    state.deleteDispatchStartedAt = new Date();
    state.deleteDispatchStartedBotId = 'bot';
    max.getExactMessagePresence.mockRejectedValue(new Error('Read timed out'));
    const result = await service.reconcileRetentionIntent(state.id, {
      allowRead: true,
      canRead: async () => true,
    });
    expect(result).toMatchObject({ status: 'AMBIGUOUS' });
    expect(state.deleteDispatchStartedAt).not.toBeNull();
    expect(max.deleteMessage).not.toHaveBeenCalled();
  });
  it('retires legacy terminal dispatch evidence only after exact presence is confirmed without DELETE', async () => {
    const { service, state, max } = fixture();
    state.status = 'EXPIRED';
    state.deleteDispatchStartedAt = new Date();
    state.deleteDispatchStartedBotId = 'bot';
    const result = await service.reconcileRetentionIntent(state.id, {
      allowRead: true,
      canRead: async () => true,
    });
    expect(result).toMatchObject({ status: 'FAILED_TERMINAL' });
    expect(max.getExactMessagePresence).toHaveBeenCalled();
    expect(max.deleteMessage).not.toHaveBeenCalled();
  });
});
