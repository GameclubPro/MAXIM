import { PublisherPublicationPostActionsService } from './publisher-publication-post-actions.service';
import { hasPublicationDeliveryAutomatedVerificationState } from '../admin/publication-delivery-verification-state';

const NOW = new Date('2026-09-09T12:00:00.000Z');

function setup(overrides: Record<string, unknown> = {}) {
  const row: any = {
    id: 'delivery-1',
    updatedAt: NOW,
    targetChatId: 'chat-1',
    botId: 'publik',
    requiredBotId: 'publik',
    dispatchProfile: 'PUBLIK_V1',
    status: 'SENT',
    remoteMessageId: 'message-1',
    remoteMessageVerifiedAt: null,
    remoteMessageVerificationNextAt: NOW,
    sentAt: NOW,
    postActionsNextAt: NOW,
    postActionsToken: null,
    pinStatus: 'PENDING',
    pinAttemptCount: 0,
    deleteStatus: 'PENDING',
    deleteAt: null,
    deletedAt: null,
    deleteAttemptCount: 0,
    pinError: null,
    deleteError: null,
    contentRevision: { postPublish: { pin: 'notify', deleteAfterMinutes: 60 } },
    ...overrides,
  };
  const prisma = {
    managedBroadcastDelivery: {
      findMany: jest.fn(async () =>
        row.status === 'SENT' &&
        row.dispatchProfile === 'PUBLIK_V1' &&
        row.postActionsNextAt &&
        row.postActionsNextAt <= new Date()
          ? [{ ...row }]
          : [],
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.pinStatus !== undefined && where.pinStatus !== row.pinStatus) return { count: 0 };
        if (where.deleteStatus !== undefined && where.deleteStatus !== row.deleteStatus)
          return { count: 0 };
        if (where.deleteAt !== undefined && Number(where.deleteAt) !== Number(row.deleteAt))
          return { count: 0 };
        if (where.status !== undefined && where.status !== row.status) return { count: 0 };
        if (where.remoteMessageVerifiedAt === null && row.remoteMessageVerifiedAt !== null)
          return { count: 0 };
        if (where.postActionsToken !== undefined && where.postActionsToken !== row.postActionsToken)
          return { count: 0 };
        if (
          where.postActionsNextAt !== undefined &&
          Number(where.postActionsNextAt) !== Number(row.postActionsNextAt)
        )
          return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    publisherEntityBinding: { findFirst: jest.fn().mockResolvedValue({ chatId: 'chat-1' }) },
  };
  const max = {
    pinMessage: jest.fn(
      async (_chatId: string, _messageId: string, _notify: boolean, options: any) => {
        await options.beforeMutation();
      },
    ),
    deleteMessage: jest.fn(async (_chatId: string, _messageId: string, options: any) => {
      await options.beforeImmediateDeleteMutation();
    }),
    getExactMessagePresence: jest.fn().mockResolvedValue('present'),
  };
  const boundary = { dispatchEnabled: true, assertDispatchEnabled: jest.fn() };
  const health = {
    isGloballyPaused: jest.fn().mockResolvedValue(false),
    assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
  };
  const identity = { assertAttested: jest.fn().mockResolvedValue(undefined) };
  const governor = { decide: jest.fn().mockResolvedValue({ action: 'run' }) };
  const service = new PublisherPublicationPostActionsService(
    prisma as any,
    max as any,
    boundary as any,
    identity as any,
    health as any,
    { getBotId: () => 'publik' } as any,
    { runExclusive: async (_lane: string, operation: () => Promise<void>) => operation() } as any,
    governor as any,
  );
  return { service, row, prisma, max, boundary, health, identity, governor };
}

describe('Publisher publication post actions', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
  afterEach(() => jest.useRealTimers());

  it('pins with notification on the exact Publisher token and schedules deletion from actual send', async () => {
    const { service, row, max, prisma } = setup();
    await service.processDue();
    expect(max.pinMessage).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      true,
      expect.objectContaining({ botId: 'publik', trafficClass: 'background' }),
    );
    expect(row).toMatchObject({
      pinStatus: 'DONE',
      deleteStatus: 'PENDING',
      deleteAt: new Date('2026-09-09T13:00:00Z'),
      postActionsNextAt: new Date('2026-09-09T13:00:00Z'),
      postActionsToken: null,
    });
    expect(prisma.managedBroadcastDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dispatchProfile: 'PUBLIK_V1', status: 'SENT', postActionsNextAt: { lte: NOW } },
        orderBy: [{ postActionsNextAt: 'asc' }, { id: 'asc' }],
        take: 20,
      }),
    );
    expect(max.deleteMessage).not.toHaveBeenCalled();
  });

  it('supports silent pin without scheduling deletion', async () => {
    const { service, row, max } = setup({
      deleteStatus: 'NONE',
      contentRevision: { postPublish: { pin: 'silent', deleteAfterMinutes: null } },
    });
    await service.processDue();
    expect(max.pinMessage).toHaveBeenCalledWith('chat-1', 'message-1', false, expect.anything());
    expect(row.postActionsNextAt).toBeNull();
  });

  it('deletes at the deadline without replaying a successful pin', async () => {
    const { service, row, max } = setup();
    await service.processDue();
    jest.setSystemTime(new Date('2026-09-09T13:00:00Z'));
    await service.processDue();
    expect(max.pinMessage).toHaveBeenCalledTimes(1);
    expect(max.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({
        immediate: true,
        botId: 'publik',
        idempotencyKey: 'publication-auto-delete:delivery-1',
      }),
    );
    expect(row).toMatchObject({
      deleteStatus: 'DONE',
      postActionsNextAt: null,
      deletedAt: new Date(),
    });
    expect(row.status).toBe('SENT');
    expect(row.remoteMessageVerifiedAt).toBeNull();
    expect(hasPublicationDeliveryAutomatedVerificationState(row)).toBe(false);
  });

  it('preserves already completed verification when deleting a post', async () => {
    const { service, row } = setup({
      pinStatus: 'DONE',
      sentAt: new Date(NOW.getTime() - 3_600_000),
      remoteMessageVerifiedAt: NOW,
      remoteMessageVerificationSource: 'AUTOMATED_STABLE',
    });
    await service.processDue();
    expect(row).toMatchObject({
      deleteStatus: 'DONE',
      remoteMessageVerifiedAt: NOW,
      remoteMessageVerificationSource: 'AUTOMATED_STABLE',
    });
  });

  it('does not delete if pending verification cannot be disarmed durably', async () => {
    const { service, max, prisma, row } = setup({
      pinStatus: 'DONE',
      sentAt: new Date(NOW.getTime() - 3_600_000),
    });
    const update = prisma.managedBroadcastDelivery.updateMany.getMockImplementation()!;
    prisma.managedBroadcastDelivery.updateMany.mockImplementation(async (args) => {
      if (args.data.remoteMessageVerificationNextAt === null)
        throw new Error('database unavailable');
      return update(args);
    });
    await service.processDue();
    expect(max.deleteMessage).not.toHaveBeenCalled();
    expect(row.deleteStatus).toBe('PENDING');
  });

  it('skips late pin and deletes an expired post after restart', async () => {
    const { service, row, max } = setup({ sentAt: new Date(NOW.getTime() - 3_600_000) });
    await service.processDue();
    expect(max.pinMessage).not.toHaveBeenCalled();
    expect(row).toMatchObject({ pinStatus: 'SKIPPED', deleteStatus: 'DONE' });
  });

  it('crash-fences an interrupted pin without blocking its future deletion', async () => {
    const { service, row, max } = setup({ pinStatus: 'RUNNING' });
    await service.processDue();
    expect(max.pinMessage).not.toHaveBeenCalled();
    expect(row).toMatchObject({ pinStatus: 'AMBIGUOUS', deleteStatus: 'PENDING' });
    expect(row.postActionsNextAt).toEqual(new Date('2026-09-09T13:00:00Z'));
  });

  it('does not retry an ambiguous notification', async () => {
    const { service, row, max } = setup();
    max.pinMessage.mockImplementationOnce(async (_chat, _message, _notify, options) => {
      await options.beforeMutation();
      throw new Error('timeout');
    });
    await service.processDue();
    expect(row.pinStatus).toBe('AMBIGUOUS');
    jest.setSystemTime(new Date('2026-09-09T13:00:00Z'));
    await service.processDue();
    expect(max.pinMessage).toHaveBeenCalledTimes(1);
    expect(row.deleteStatus).toBe('DONE');
  });

  it('claims once across concurrent sweeps', async () => {
    const { service, max } = setup();
    await Promise.all([service.processDue(), service.processDue()]);
    expect(max.pinMessage).toHaveBeenCalledTimes(1);
  });

  it('does not reclaim a stale snapshot after a timer is canceled', async () => {
    const { service, prisma, max, row } = setup();
    const snapshot = { ...row };
    row.deleteStatus = 'SKIPPED';
    row.deleteAt = null;
    prisma.managedBroadcastDelivery.findMany.mockResolvedValueOnce([snapshot]);
    await service.processDue();
    expect(max.pinMessage).not.toHaveBeenCalled();
    expect(max.deleteMessage).not.toHaveBeenCalled();
  });

  it('can retry a pin without reenrolling canceled auto-deletion from the content revision', async () => {
    const { service, row, max } = setup({ deleteStatus: 'SKIPPED', deleteAt: null });
    await service.processDue();
    expect(row.deleteStatus).toBe('SKIPPED');
    expect(row.deleteAt).toBeNull();
    expect(row.postActionsNextAt).toBeNull();
    expect(max.deleteMessage).not.toHaveBeenCalled();
  });

  it('yields the shared Publisher lane after a slow action', async () => {
    const { service, max, prisma, row } = setup();
    prisma.managedBroadcastDelivery.findMany.mockResolvedValueOnce([
      { ...row },
      { ...row, id: 'delivery-2' },
    ]);
    max.pinMessage.mockImplementationOnce(async (_chat, _message, _notify, options) => {
      await options.beforeMutation();
      jest.setSystemTime(new Date(NOW.getTime() + 10_000));
    });
    await service.processDue();
    expect(max.pinMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps a successful pin crash-fenced when receipt persistence fails', async () => {
    const { service, max, row, prisma } = setup();
    const update = prisma.managedBroadcastDelivery.updateMany.getMockImplementation()!;
    prisma.managedBroadcastDelivery.updateMany.mockImplementation(async (args) => {
      if (args.data.pinStatus === 'DONE') throw new Error('database unavailable');
      return update(args);
    });
    await service.processDue();
    expect(row.pinStatus).toBe('RUNNING');
    jest.setSystemTime(new Date(NOW.getTime() + 120_000));
    await service.processDue();
    expect(row.pinStatus).toBe('AMBIGUOUS');
    expect(max.pinMessage).toHaveBeenCalledTimes(1);
  });

  it('fences a receipt that becomes ambiguous before pin dispatch', async () => {
    const { service, max, row, prisma } = setup();
    max.pinMessage.mockImplementationOnce(async (_chat, _message, _notify, options) => {
      row.status = 'AMBIGUOUS';
      await options.beforeMutation();
    });
    await service.processDue();
    expect(row.pinStatus).toBe('PENDING');
    expect(prisma.managedBroadcastDelivery.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { pinStatus: 'RUNNING' } }),
    );
    expect(max.deleteMessage).not.toHaveBeenCalled();
  });

  it('retries an explicit rate-limit rejection but does not delay an earlier deletion deadline', async () => {
    const { service, max, row } = setup({
      pinAttemptCount: 5,
      contentRevision: { postPublish: { pin: 'notify', deleteAfterMinutes: 1 } },
    });
    max.pinMessage.mockImplementationOnce(async (_chat, _message, _notify, options) => {
      await options.beforeMutation();
      throw { response: { status: 429 } };
    });
    await service.processDue();
    expect(row).toMatchObject({
      pinStatus: 'PENDING',
      pinAttemptCount: 6,
      postActionsNextAt: new Date(NOW.getTime() + 60_000),
    });
    jest.setSystemTime(new Date(NOW.getTime() + 60_000));
    await service.processDue();
    expect(max.pinMessage).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ pinStatus: 'SKIPPED', pinError: null, deleteStatus: 'DONE' });
  });

  it('retries a proven pre-dispatch failure with bounded attempts', async () => {
    const { service, max, row } = setup({
      pinAttemptCount: 9,
      deleteStatus: 'NONE',
      contentRevision: { postPublish: { pin: 'notify', deleteAfterMinutes: null } },
    });
    max.pinMessage.mockRejectedValueOnce(new Error('internal rate limit'));
    await service.processDue();
    expect(row).toMatchObject({
      pinStatus: 'FAILED',
      pinAttemptCount: 10,
      postActionsNextAt: null,
    });
  });

  it('reports a definitive pin rejection separately from ambiguous transport outcomes', async () => {
    const { service, max, row } = setup();
    max.pinMessage.mockImplementationOnce(async (_chat, _message, _notify, options) => {
      await options.beforeMutation();
      throw { response: { status: 403 } };
    });
    await service.processDue();
    expect(row.pinStatus).toBe('FAILED');
    expect(row.deleteStatus).toBe('PENDING');
  });

  it.each(['PENDING', 'SENDING', 'AMBIGUOUS', 'FAILED'])(
    'never mutates a %s delivery',
    async (status) => {
      const { service, max } = setup({ status });
      await service.processDue();
      expect(max.pinMessage).not.toHaveBeenCalled();
      expect(max.deleteMessage).not.toHaveBeenCalled();
    },
  );

  it.each([
    { botId: 'major' },
    { requiredBotId: 'major' },
    { remoteMessageId: null },
    { sentAt: null },
  ])('fails closed for invalid receipt %j', async (override) => {
    const { service, max, row } = setup(override);
    await service.processDue();
    expect(max.pinMessage).not.toHaveBeenCalled();
    expect(max.deleteMessage).not.toHaveBeenCalled();
    expect(row.postActionsNextAt).toBeNull();
  });

  it('does not perform recovery reads when dispatch is disabled', async () => {
    const { service, boundary, prisma, identity } = setup();
    boundary.dispatchEnabled = false;
    await service.processDue();
    expect(prisma.managedBroadcastDelivery.findMany).not.toHaveBeenCalled();
    expect(identity.assertAttested).not.toHaveBeenCalled();
  });

  it('honors governor pauses and reduces slow sweeps to one item', async () => {
    const { service, governor, prisma } = setup();
    governor.decide.mockResolvedValueOnce({ action: 'pause' });
    await service.processDue();
    expect(prisma.managedBroadcastDelivery.findMany).not.toHaveBeenCalled();
    governor.decide.mockResolvedValueOnce({ action: 'slow' });
    await service.processDue();
    expect(prisma.managedBroadcastDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1 }),
    );
  });

  it('rechecks the binding before pin HTTP', async () => {
    const { service, prisma, row } = setup();
    prisma.publisherEntityBinding.findFirst.mockResolvedValue(null);
    await service.processDue();
    expect(row.pinStatus).toBe('PENDING');
    expect(row.deleteStatus).toBe('PENDING');
    expect(prisma.managedBroadcastDelivery.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { pinStatus: 'RUNNING' } }),
    );
  });

  it('recovers a delete after a lost success acknowledgement using exact absence', async () => {
    const { service, row, max } = setup({
      pinStatus: 'DONE',
      sentAt: new Date(NOW.getTime() - 3_600_000),
    });
    max.deleteMessage.mockRejectedValueOnce(new Error('timeout'));
    max.getExactMessagePresence.mockResolvedValueOnce('absent');
    await service.processDue();
    expect(row.deleteStatus).toBe('DONE');
    expect(row.postActionsNextAt).toBeNull();
  });

  it('never treats a bare 404 as successful deletion and retries with backoff', async () => {
    const { service, row, max } = setup({
      pinStatus: 'DONE',
      sentAt: new Date(NOW.getTime() - 3_600_000),
    });
    max.deleteMessage.mockRejectedValueOnce({ response: { status: 404 } });
    max.getExactMessagePresence.mockRejectedValueOnce({ response: { status: 404 } });
    await service.processDue();
    expect(row).toMatchObject({
      deleteStatus: 'PENDING',
      deletedAt: null,
      deleteAttemptCount: 1,
      postActionsNextAt: new Date(NOW.getTime() + 30_000),
    });
  });

  it('bounds deletion retries and exposes a terminal failure', async () => {
    const { service, row, max } = setup({
      pinStatus: 'DONE',
      deleteAttemptCount: 9,
      sentAt: new Date(NOW.getTime() - 3_600_000),
    });
    max.deleteMessage.mockRejectedValueOnce(new Error('forbidden'));
    await service.processDue();
    expect(row).toMatchObject({ deleteStatus: 'FAILED', deletedAt: null, postActionsNextAt: null });
    expect(row.deleteError).toContain('права');
  });
});
