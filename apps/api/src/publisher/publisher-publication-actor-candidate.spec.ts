import { ChatEntityType } from '../prisma/prisma-client';
import { stageMissingPublicationActor } from './publisher-publication-actor-candidate';

describe('Publication actor nomination', () => {
  const scope = {
    chatId: 'channel-1',
    userId: 'author',
    botId: 'publik',
    entityType: ChatEntityType.CHANNEL,
  };
  function harness() {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: scope.chatId }]),
      chat: { findFirst: jest.fn().mockResolvedValue({ entityType: ChatEntityType.CHANNEL }) },
      managedEntityAccessEdge: {
        findUnique: jest.fn().mockResolvedValue(null),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = { $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)) };
    return { tx, prisma };
  }

  it('locks the parent and rechecks the exact Publisher evidence before creating a non-grant', async () => {
    const { prisma, tx } = harness();
    const nomination = await stageMissingPublicationActor(prisma as never, scope);
    expect(tx.$queryRaw.mock.calls[0][0]).toMatchObject({ values: [scope.chatId] });
    expect(tx.$queryRaw.mock.calls[0][0].strings.join('?')).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.chat.findFirst.mock.invocationCallOrder[0],
    );
    expect(tx.chat.findFirst).toHaveBeenCalledWith({
      where: {
        id: scope.chatId,
        entityType: ChatEntityType.CHANNEL,
        publisherBinding: {
          is: expect.objectContaining({ publisherBotId: 'publik', status: 'ACTIVE' }),
        },
      },
      select: { entityType: true },
    });
    expect(tx.managedEntityAccessEdge.findUnique).toHaveBeenCalledWith({
      where: { chatId_userId_botId: { chatId: scope.chatId, userId: 'author', botId: 'publik' } },
      select: { sourceVersion: true },
    });
    const created = tx.managedEntityAccessEdge.createMany.mock.calls[0][0].data[0];
    expect(created).toMatchObject({
      entityType: ChatEntityType.CHANNEL,
      state: 'BOT_DENIED',
      userRole: 'UNKNOWN',
      botRole: 'UNKNOWN',
      source: 'publisher_actor_candidate_publication',
      deniedReason: 'publisher_actor_verification_pending',
      sourceVersion: nomination!.candidateVersion,
      checkedAt: nomination!.requestedAt,
    });
    expect(created.expiresAt.getTime() - created.checkedAt.getTime()).toBe(24 * 60 * 60_000);
  });

  it.each(['GRANTED', 'USER_DENIED', 'BOT_DENIED'])(
    'preserves a concurrent %s edge without enqueueing',
    async (state) => {
      const { prisma, tx } = harness();
      tx.managedEntityAccessEdge.findUnique.mockResolvedValue({ sourceVersion: 'newer', state });
      expect(await stageMissingPublicationActor(prisma as never, scope)).toBeNull();
      expect(tx.managedEntityAccessEdge.createMany).not.toHaveBeenCalled();
    },
  );

  it('does not stage a removed parent', async () => {
    const { prisma, tx } = harness();
    tx.$queryRaw.mockResolvedValue([]);
    expect(await stageMissingPublicationActor(prisma as never, scope)).toBeNull();
    expect(tx.chat.findFirst).not.toHaveBeenCalled();
    expect(tx.managedEntityAccessEdge.createMany).not.toHaveBeenCalled();
  });

  it('does not stage after binding removal or an entity-type mismatch', async () => {
    const { prisma, tx } = harness();
    tx.chat.findFirst.mockResolvedValue(null);
    expect(await stageMissingPublicationActor(prisma as never, scope)).toBeNull();
    expect(tx.managedEntityAccessEdge.createMany).not.toHaveBeenCalled();
  });

  it('does not nominate a lost insert race', async () => {
    const { prisma, tx } = harness();
    tx.managedEntityAccessEdge.createMany.mockResolvedValue({ count: 0 });
    expect(await stageMissingPublicationActor(prisma as never, scope)).toBeNull();
    expect(tx.managedEntityAccessEdge.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });
});
