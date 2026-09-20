import { ConfigService } from '@nestjs/config';
import { MessageRetentionStore } from './message-retention-store.service';

function setup() {
  const now = new Date();
  const policy = {
    chatId: '-1',
    enabled: true,
    hours: 48,
    activationId: 'a',
    quotaShard: 0,
    captureAfter: new Date(now.getTime() - 60_000),
    pendingCount: 0,
    pausedAt: null as Date | null,
    healthySince: null as Date | null,
    nextRunAt: null,
  };
  const quota = {
    shard: 0,
    pendingCount: 0,
    pausedAt: null as Date | null,
    healthySince: null as Date | null,
  };
  const prisma = {
    messageRetentionPolicy: {
      findUnique: jest.fn().mockResolvedValue(policy),
      findUniqueOrThrow: jest.fn().mockResolvedValue(policy),
      update: jest.fn(),
    },
    messageRetentionCandidate: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    messageRetentionQuota: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(quota),
      update: jest.fn(),
    },
    managedEntityAdminMember: { findFirst: jest.fn().mockResolvedValue(null) },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  const store = new MessageRetentionStore(
    prisma as never,
    new ConfigService({ MESSAGE_RETENTION_MODE: 'on' }),
  );
  const input = {
    chatId: '-1',
    messageId: 'm1',
    authorId: 'u1',
    originBotId: 'bot',
    sourceAt: now,
  };
  return { store, prisma, policy, quota, input };
}

describe('retention admission and settlement', () => {
  it('purges ended unattempted intents but preserves other owners, live leases and ambiguous receipts', async () => {
    const { store, prisma } = setup();
    await store.purge();
    const query = prisma.$executeRaw.mock.calls[0][0].text as string;
    expect(query).toContain('"completed_at" <');
    expect(query).toContain('intent."retention_owned" = TRUE');
    expect(query).toContain('intent."delete_dispatch_started_at" IS NULL');
    expect(query).toContain('intent."delete_dispatch_started_bot_id" IS NULL');
    expect(query).toContain('intent."remote_delete_succeeded_at" IS NULL');
    expect(query).toContain('intent."remote_delete_succeeded_bot_id" IS NULL');
    expect(query).toContain('intent."lease_expires_at" < CURRENT_TIMESTAMP');
    expect(query).toContain('LIMIT 500 FOR UPDATE SKIP LOCKED');
  });
  it('does not restart the recovery window on new arrivals while paused', async () => {
    const { store, prisma, input, policy } = setup();
    policy.pausedAt = new Date(Date.now() - 700_000);
    policy.healthySince = new Date(Date.now() - 300_000);
    await store.capture(prisma as never, input);
    expect(prisma.messageRetentionPolicy.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ healthySince: policy.healthySince }),
      }),
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
  it('stores only compact metadata and charges both quotas', async () => {
    const { store, prisma, input } = setup();
    await store.capture(prisma as never, input);
    expect(prisma.messageRetentionCandidate.create).toHaveBeenCalledWith({
      data: { ...input, activationId: 'a', shadowOnly: false },
    });
    expect(prisma.messageRetentionQuota.update).toHaveBeenCalledWith({
      where: { shard: 0 },
      data: { pendingCount: { increment: 1 } },
    });
    expect(prisma.messageRetentionPolicy.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pendingCount: { increment: 1 } }),
      }),
    );
  });
  it.each(['disabled', 'history', 'administrator', 'duplicate'])(
    'does not charge %s messages',
    async (reason) => {
      const { store, prisma, input, policy } = setup();
      if (reason === 'disabled') policy.enabled = false;
      if (reason === 'history') input.sourceAt = new Date(0);
      if (reason === 'administrator')
        prisma.managedEntityAdminMember.findFirst.mockResolvedValue({ userId: 'u1' });
      if (reason === 'duplicate')
        prisma.messageRetentionCandidate.findUnique.mockResolvedValue({ messageId: 'm1' });
      await store.capture(prisma as never, input);
      expect(prisma.messageRetentionCandidate.create).not.toHaveBeenCalled();
      expect(prisma.messageRetentionQuota.update).not.toHaveBeenCalled();
    },
  );
  it.each(['chat', 'shard'])(
    'pauses at the %s high watermark without accepting more work',
    async (kind) => {
      const { store, prisma, input, policy, quota } = setup();
      if (kind === 'chat') policy.pendingCount = 40_000;
      else quota.pendingCount = 50_000;
      await store.capture(prisma as never, input);
      expect(prisma.messageRetentionCandidate.create).not.toHaveBeenCalled();
      expect(prisma.messageRetentionPolicy.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastStatus: 'capacity_paused',
            skippedCount: { increment: 1 },
          }),
        }),
      );
    },
  );
  it('settles once even when a completed BullMQ job is replayed', async () => {
    const { store, prisma, input } = setup();
    prisma.messageRetentionCandidate.updateMany.mockResolvedValue({ count: 0 });
    await store.finish(input as never, 'deleted');
    expect(prisma.messageRetentionQuota.update).not.toHaveBeenCalled();
    expect(prisma.messageRetentionPolicy.update).not.toHaveBeenCalled();
  });
  it('does not resume admission until the low watermark is stable for ten minutes', async () => {
    const { store, prisma, policy } = setup();
    policy.pausedAt = new Date(Date.now() - 600_000);
    policy.healthySince = new Date(Date.now() - 599_000);
    await store.resumeAdmission('-1');
    expect(prisma.messageRetentionPolicy.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { healthySince: policy.healthySince } }),
    );
    policy.healthySince = new Date(Date.now() - 601_000);
    await store.resumeAdmission('-1');
    expect(prisma.messageRetentionPolicy.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pausedAt: null, captureAfter: expect.any(Date) }),
      }),
    );
  });
});
