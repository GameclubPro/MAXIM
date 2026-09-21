import { ConfigService } from '@nestjs/config';
import { MessageRetentionStore } from './message-retention-store.service';

function setup() {
  const policy = {
    chatId: '-1',
    enabled: true,
    activationId: 'new',
    hours: 48,
    revision: 1,
    quotaShard: 0,
    pausedAt: null as Date | null,
    healthySince: null as Date | null,
    pendingCount: 0,
  };
  const quota = { shard: 0, pendingCount: 0, pausedAt: null, healthySince: null };
  const prisma = {
    messageRetentionPolicy: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(policy),
      update: jest.fn(),
    },
    messageRetentionCandidate: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    messageRetentionQuota: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(quota),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((work: (tx: unknown) => Promise<unknown>) => work(prisma));
  const config = new ConfigService({
    MESSAGE_RETENTION_MODE: 'canary',
    MESSAGE_RETENTION_CANARY_CHAT_IDS: '-1,-2,-1,*',
  });
  return { prisma, policy, quota, store: new MessageRetentionStore(prisma as never, config) };
}

describe('retention state ownership', () => {
  it('cannot cancel the active generation using an old worker snapshot', async () => {
    const { store, prisma } = setup();
    expect(
      await store.finish(
        { chatId: '-1', messageId: 'm', activationId: 'new' } as never,
        'cancelled',
      ),
    ).toBe(false);
    expect(prisma.messageRetentionCandidate.updateMany).not.toHaveBeenCalled();
  });
  it('settles once and locks quota before policy before candidate', async () => {
    const { store, prisma } = setup();
    const message = { chatId: '-1', messageId: 'm', activationId: 'old' };
    expect(await store.finish(message as never, 'deleted')).toBe(true);
    expect(prisma.$queryRaw.mock.calls[0][0].join('')).toContain('message_retention_quotas');
    expect(prisma.$queryRaw.mock.calls[1][0].join('')).toContain('message_retention_policies');
    expect(prisma.messageRetentionCandidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ activationId: 'old' }) }),
    );
    prisma.messageRetentionCandidate.updateMany.mockResolvedValue({ count: 0 });
    expect(await store.finish(message as never, 'deleted')).toBe(false);
    expect(prisma.messageRetentionQuota.update).toHaveBeenCalledTimes(1);
  });
  it('batch cancellation excludes the current generation and releases only changed rows', async () => {
    const { store, prisma } = setup();
    prisma.messageRetentionCandidate.updateMany.mockResolvedValue({ count: 3 });
    await store.cancelInactive([{ chatId: '-1', messageId: 'm', activationId: 'old' }] as never);
    expect(prisma.messageRetentionCandidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ activationId: { not: 'new' } }) }),
    );
    expect(prisma.messageRetentionQuota.update).toHaveBeenCalledWith({
      where: { shard: 0 },
      data: { pendingCount: { decrement: 3 } },
    });
    await expect(
      store.cancelInactive([{ chatId: '-1' }, { chatId: '-2' }] as never),
    ).rejects.toThrow('single-chat');
  });
  it('filters the cohort before scheduling and refuses wildcard expansion', () => {
    expect(setup().store.schedulingFilter()).toEqual({ chatId: { in: ['-1', '-2'] } });
  });
  it('does no resume work for a chat that is not capacity-paused', async () => {
    const { store, prisma } = setup();
    await store.resumeAdmission('-1');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  it('resumes a stable low-watermark policy with a new capture baseline', async () => {
    const { store, prisma, policy } = setup();
    policy.pausedAt = new Date(Date.now() - 700_000);
    policy.healthySince = new Date(Date.now() - 601_000);
    await store.resumeAdmission('-1');
    expect(prisma.messageRetentionPolicy.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pausedAt: null, captureAfter: expect.any(Date) }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
