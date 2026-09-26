import { ChatEntityType } from '../prisma/prisma-client';
import { PublisherReadinessService } from './publisher-readiness.service';

function createHarness(enabled = true) {
  const staleCandidate = {
    id: 'chat-stale',
    entityType: ChatEntityType.CHAT,
    accessEdges: [{ sourceVersion: 'verified:earlier' }],
  };
  const findMany = jest.fn().mockResolvedValue([staleCandidate]);
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'chat-stale' }]),
    chat: { findFirst: jest.fn().mockResolvedValue({ entityType: ChatEntityType.CHAT }) },
    managedEntityAccessEdge: {
      findUnique: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  let transactionActive = false;
  const transaction = jest.fn(async (run: (client: typeof tx) => Promise<unknown>) => {
    transactionActive = true;
    try {
      return await run(tx);
    } finally {
      transactionActive = false;
    }
  });
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const service = new PublisherReadinessService(
    { chat: { findMany }, $transaction: transaction } as never,
    {} as never,
    { get: (key: string) => (key === 'MAX_PUBLISHER_BOT_ID' ? 'publik' : enabled) } as never,
    { enqueue } as never,
  );
  return {
    service,
    findMany,
    enqueue,
    transaction,
    tx,
    staleCandidate,
    isTransactionActive: () => transactionActive,
  };
}

describe('Scheduled publication access refresh', () => {
  afterEach(() => jest.useRealTimers());

  it('nominates only exact persisted targets without a fresh grant or denial', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-13T12:00:00Z'));
    const { service, findMany, enqueue } = createHarness();
    await service.requestActorAccessRefresh(
      [
        { chatId: 'chat-stale', entityType: 'chat' },
        { chatId: 'chat-stale', entityType: 'chat' },
        { chatId: 'channel-fresh', entityType: 'channel' },
      ],
      'author',
      'publik',
    );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { id: 'chat-stale', entityType: ChatEntityType.CHAT },
          { id: 'channel-fresh', entityType: ChatEntityType.CHANNEL },
        ],
        publisherBinding: { is: expect.objectContaining({ publisherBotId: 'publik' }) },
        accessEdges: {
          none: {
            userId: 'author',
            botId: 'publik',
            OR: [
              { expiresAt: { gt: new Date('2026-09-13T12:00:00Z') } },
              { expiresAt: null, checkedAt: { gt: new Date('2026-09-13T11:45:00Z') } },
            ],
          },
        },
      },
      select: {
        id: true,
        entityType: true,
        accessEdges: {
          where: { userId: 'author', botId: 'publik' },
          select: { sourceVersion: true },
          take: 1,
        },
      },
      take: expect.any(Number),
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      chatId: 'chat-stale',
      publisherBotId: 'publik',
      candidateUserId: 'author',
      reason: 'stale_user_access',
      requestedAt: new Date('2026-09-13T12:00:00Z'),
      candidateVersion: 'verified:earlier',
    });
  });

  it.each([
    { enabled: false, botId: 'publik', userId: 'author', targets: ['chat'] },
    { enabled: true, botId: 'major', userId: 'author', targets: ['chat'] },
    { enabled: true, botId: 'publik', userId: '', targets: ['chat'] },
    { enabled: true, botId: 'publik', userId: 'author', targets: [] },
  ])('does no work for an inactive or invalid scope: %j', async (params) => {
    const { service, findMany, enqueue, transaction } = createHarness(params.enabled);
    await service.requestActorAccessRefresh(
      params.targets.map((chatId) => ({ chatId, entityType: 'chat' })),
      params.userId,
      params.botId,
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('keeps queue failure recoverable without granting access or flooding remaining candidates', async () => {
    const { service, findMany, enqueue, staleCandidate, transaction } = createHarness();
    findMany.mockResolvedValue([staleCandidate, { ...staleCandidate, id: 'chat-other' }]);
    enqueue.mockRejectedValue(new Error('Redis unavailable'));
    await expect(
      service.requestActorAccessRefresh(
        [
          { chatId: 'chat-stale', entityType: 'chat' },
          { chatId: 'chat-other', entityType: 'chat' },
        ],
        'author',
        'publik',
      ),
    ).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('does not create a candidate when all exact actor edges are fresh, including denials', async () => {
    const f = createHarness();
    f.findMany.mockResolvedValue([]);
    await f.service.requestActorAccessRefresh(
      [{ chatId: 'chat-stale', entityType: 'chat' }],
      'author',
      'publik',
    );
    expect(f.transaction).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('commits the pending candidate before Redis and leaves it recoverable on enqueue failure', async () => {
    const f = createHarness();
    f.findMany.mockResolvedValue([{ ...f.staleCandidate, accessEdges: [] }]);
    f.enqueue.mockImplementation(async () => {
      expect(f.isTransactionActive()).toBe(false);
      throw new Error('Redis unavailable');
    });
    await f.service.requestActorAccessRefresh(
      [{ chatId: 'chat-stale', entityType: 'chat' }],
      'author',
      'publik',
    );
    expect(f.tx.managedEntityAccessEdge.createMany).toHaveBeenCalledTimes(1);
    expect(f.tx.managedEntityAccessEdge.createMany.mock.calls[0][0]).toMatchObject({
      data: [
        {
          state: 'BOT_DENIED',
          userRole: 'UNKNOWN',
          botRole: 'UNKNOWN',
          deniedReason: 'publisher_actor_verification_pending',
          source: 'publisher_actor_candidate_publication',
        },
      ],
      skipDuplicates: true,
    });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
});
