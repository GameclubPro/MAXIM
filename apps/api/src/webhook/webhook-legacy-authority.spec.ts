import { holdUnverifiedLegacyExecution } from './webhook-legacy-authority';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { WebhookStatus } from '../prisma/prisma-client';

const cutoff = new Date('2026-10-05T01:00:00.000Z');

function fixture() {
  const payload: Record<string, unknown> = {
    type: 'message_created',
    eventTimestampSource: 'payload',
    message: {
      chatId: 'chat-1',
      messageId: 'message-1',
      createdAt: new Date(cutoff.getTime() + 1).toISOString(),
    },
  };
  const claim = {
    id: 'claim-1',
    webhookEventId: 'event-1',
    semanticKey: buildWebhookSemanticEventKey(payload)!,
    enforced: true,
    status: 'READY',
    createdAt: new Date(cutoff.getTime() + 3),
    businessStartedAt: null,
  };
  const owner = {
    id: 'event-1',
    createdAt: new Date(cutoff.getTime() + 2),
    status: WebhookStatus.QUEUED as WebhookStatus,
    errorMessage: null,
    normalizedPayload: payload,
  };
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ finishedAt: cutoff }]),
    webhookEvent: {
      findUnique: jest.fn().mockResolvedValue(owner),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return { claim, prisma, owner, payload };
}

describe('historical semantic execution authority', () => {
  it.each([WebhookStatus.FAILED, WebhookStatus.QUEUED])(
    'holds a historical off-mode %s owner even after preparation creates a fresh claim',
    async (status) => {
      const { claim, prisma, owner } = fixture();
      owner.status = status;
      owner.createdAt = new Date(cutoff.getTime() - 1);
      await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).resolves.toBe(true);
      expect(prisma.webhookEvent.updateMany).toHaveBeenCalled();
      expect(prisma.webhookEvent.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each([new Date(cutoff.getTime() - 1), cutoff])(
    'holds a fresh mirror of an old original source at %s without scanning NULL-key history',
    async (sourceAt) => {
      const { claim, prisma, payload } = fixture();
      payload.raw = { timestamp: sourceAt.getTime() };
      await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).resolves.toBe(true);
      expect(prisma.webhookEvent.findFirst).not.toHaveBeenCalled();
    },
  );

  it('holds a fresh owner with a known older semantic mirror using one indexed ordered probe', async () => {
    const { claim, prisma } = fixture();
    prisma.webhookEvent.findFirst.mockResolvedValue({ id: 'old-off-mirror' });
    await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).resolves.toBe(true);
    expect(prisma.webhookEvent.findFirst).toHaveBeenCalledWith({
      where: { semanticKey: claim.semanticKey, createdAt: { lte: cutoff } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
  });

  it.each(['ingress', 'unknown', 'invalid', 'future', 'missing-original'])(
    'does not certify a new shared source from %s time',
    async (variant) => {
      const { claim, prisma, payload } = fixture();
      if (variant === 'ingress') payload.eventTimestampSource = 'ingress';
      if (variant === 'unknown') delete payload.eventTimestampSource;
      if (variant === 'invalid') payload.raw = { timestamp: 'invalid' };
      if (variant === 'future') payload.raw = { timestamp: Date.now() + 60_000 };
      if (variant === 'missing-original') payload.raw = {};
      await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).resolves.toBe(true);
      expect(prisma.webhookEvent.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each(['timestamp', 'createdAt', 'created_at'])(
    'holds an old original message %s even when the Update timestamp is fresh',
    async (field) => {
      const { claim, prisma, payload } = fixture();
      payload.raw = {
        timestamp: cutoff.getTime() + 1,
        message: { [field]: cutoff.toISOString() },
      };
      await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).resolves.toBe(true);
    },
  );

  it('permits a new edit of an older message using original Update time', async () => {
    const { claim, prisma, payload } = fixture();
    payload.type = 'message_edited';
    payload.raw = {
      timestamp: cutoff.getTime() + 1,
      message: { timestamp: cutoff.getTime() - 1, text: 'edited text' },
    };
    claim.semanticKey = buildWebhookSemanticEventKey(payload)!;
    await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).resolves.toBe(false);
    (payload.raw as Record<string, unknown>).timestamp = undefined;
    await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).resolves.toBe(true);
  });

  it('preserves explicitly sourced normalized edit time when original raw data is absent', async () => {
    const { claim, prisma, payload } = fixture();
    payload.type = 'message_edited';
    claim.semanticKey = buildWebhookSemanticEventKey(payload)!;
    await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).resolves.toBe(false);
  });

  it('reuses only an exact authoritative owner snapshot and ignores a supplied mirror', async () => {
    const { claim, prisma, owner } = fixture();
    await expect(holdUnverifiedLegacyExecution(prisma as never, claim, owner)).resolves.toBe(false);
    expect(prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
    owner.createdAt = cutoff;
    await expect(
      holdUnverifiedLegacyExecution(prisma as never, claim, {
        ...owner,
        id: 'mirror',
        createdAt: new Date(cutoff.getTime() + 2),
      }),
    ).resolves.toBe(true);
    expect(prisma.webhookEvent.findUnique).toHaveBeenCalledTimes(1);
  });

  it('preserves the diagnostic receipt-scoped fallback without requiring shared source proof', async () => {
    const { claim, prisma } = fixture();
    claim.semanticKey = 'receipt:bot:keyless';
    await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).resolves.toBe(false);
    expect(prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.findFirst).not.toHaveBeenCalled();
  });

  it.each(['PENDING', 'READY'])(
    'holds old enforced %s authority and preserves its enforcement identity',
    async (status) => {
      const { claim, prisma } = fixture();
      claim.status = status;
      claim.createdAt = new Date(cutoff.getTime() - 1);
      await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).resolves.toBe(true);
      expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          executionClaims: {
            some: {
              id: claim.id,
              kind: 'EXECUTION',
              semanticKey: claim.semanticKey,
              enforced: true,
              status: { not: 'COMPLETED' },
              businessStartedAt: null,
            },
          },
        }),
        data: expect.objectContaining({
          status: 'FAILED',
          nextEnqueueAt: null,
          errorMessage: expect.stringContaining('LEGACY_EXECUTION_UNVERIFIED'),
        }),
      });
    },
  );

  it('holds authority born exactly at cutover but permits a newer enforced producer', async () => {
    const { claim, prisma } = fixture();
    await expect(
      holdUnverifiedLegacyExecution(prisma as never, { ...claim, createdAt: cutoff }),
    ).resolves.toBe(true);
    prisma.webhookEvent.updateMany.mockClear();
    await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).resolves.toBe(false);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    const sql = prisma.$queryRaw.mock.calls[0]![0].join(' ');
    expect(sql).toContain("migration_name = '20261005020000_add_multibot_order_fences'");
    expect(sql).toContain('rolled_back_at IS NULL AND finished_at IS NOT NULL');
  });

  it.each([undefined, new Date(Number.NaN)])(
    'holds missing or invalid birth %s',
    async (createdAt) => {
      const { claim, prisma } = fixture();
      await expect(
        holdUnverifiedLegacyExecution(prisma as never, { ...claim, createdAt }),
      ).resolves.toBe(true);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    },
  );

  it.each([
    { rows: [] },
    { rows: [{ finishedAt: null }] },
    { rows: [{ finishedAt: new Date(Number.NaN) }] },
  ])('holds a newer enforced claim without successful cutover proof %p', async ({ rows }) => {
    const { claim, prisma } = fixture();
    prisma.$queryRaw.mockResolvedValueOnce(rows);
    await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).resolves.toBe(true);
    await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).resolves.toBe(false);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight cutoff only within the same Prisma client', async () => {
    const first = fixture();
    const second = fixture();
    second.prisma.$queryRaw.mockResolvedValue([{ finishedAt: new Date(cutoff.getTime() + 2) }]);
    await expect(
      Promise.all([
        holdUnverifiedLegacyExecution(first.prisma as never, first.claim),
        holdUnverifiedLegacyExecution(first.prisma as never, first.claim),
      ]),
    ).resolves.toEqual([false, false]);
    expect(first.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    await expect(holdUnverifiedLegacyExecution(second.prisma as never, second.claim)).resolves.toBe(
      true,
    );
    expect(second.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('evicts failed cutoff reads and preserves retryable database failure', async () => {
    const { claim, prisma } = fixture();
    const failure = new Error('metadata database connection lost');
    prisma.$queryRaw.mockRejectedValueOnce(failure);
    await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).rejects.toBe(failure);
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).resolves.toBe(false);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it.each(['PENDING', 'READY'])(
    'holds newer unenforced %s authority without using the cutover as no-effects proof',
    async (status) => {
      const { claim, prisma } = fixture();
      await expect(
        holdUnverifiedLegacyExecution(prisma as never, { ...claim, enforced: false, status }),
      ).resolves.toBe(true);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    },
  );

  it.each([{ status: 'COMPLETED' }, { businessStartedAt: new Date(cutoff.getTime() - 1) }])(
    'preserves existing completed/started evidence %p',
    async (evidence) => {
      const { claim, prisma } = fixture();
      await expect(
        holdUnverifiedLegacyExecution(prisma as never, { ...claim, ...evidence }),
      ).resolves.toBe(false);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
    },
  );

  it.each(['PROCESSED', 'DUPLICATE'])(
    'retains the claim hold without overwriting a settled %s receipt',
    async (status) => {
      const { claim, prisma } = fixture();
      prisma.webhookEvent.findUnique.mockResolvedValue({
        id: 'event-1',
        status,
        normalizedPayload: {
          type: 'message_created',
          message: { chatId: 'chat-1', messageId: 'message-1' },
        },
      });
      await expect(
        holdUnverifiedLegacyExecution(prisma as never, { ...claim, createdAt: cutoff }),
      ).resolves.toBe(true);
      expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    },
  );
});
