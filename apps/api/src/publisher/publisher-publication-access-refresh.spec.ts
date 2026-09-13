import { ChatEntityType } from '../prisma/prisma-client';
import { PublisherReadinessService } from './publisher-readiness.service';

function createHarness(enabled = true) {
  const findMany = jest.fn().mockResolvedValue([{ id: 'chat-stale' }]);
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const service = new PublisherReadinessService(
    { chat: { findMany } } as never,
    {} as never,
    { get: (key: string) => (key === 'MAX_PUBLISHER_BOT_ID' ? 'publik' : enabled) } as never,
    { enqueue } as never,
  );
  return { service, findMany, enqueue };
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
      select: { id: true },
      take: expect.any(Number),
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      chatId: 'chat-stale',
      publisherBotId: 'publik',
      candidateUserId: 'author',
      reason: 'stale_user_access',
      requestedAt: new Date('2026-09-13T12:00:00Z'),
    });
  });

  it.each([
    { enabled: false, botId: 'publik', userId: 'author', targets: ['chat'] },
    { enabled: true, botId: 'major', userId: 'author', targets: ['chat'] },
    { enabled: true, botId: 'publik', userId: '', targets: ['chat'] },
    { enabled: true, botId: 'publik', userId: 'author', targets: [] },
  ])('does no work for an inactive or invalid scope: %j', async (params) => {
    const { service, findMany, enqueue } = createHarness(params.enabled);
    await service.requestActorAccessRefresh(
      params.targets.map((chatId) => ({ chatId, entityType: 'chat' })),
      params.userId,
      params.botId,
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('keeps queue failure recoverable without granting access or flooding remaining candidates', async () => {
    const { service, findMany, enqueue } = createHarness();
    findMany.mockResolvedValue([{ id: 'chat-stale' }, { id: 'chat-other' }]);
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
  });
});
