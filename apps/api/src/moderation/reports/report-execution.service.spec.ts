import { ReportExecutionService } from './report-execution.service';

const report = {
  id: 'case',
  chatId: 'chat',
  originBotId: 'bot',
  authorId: 'author',
  messageId: 'target',
  status: 'RUNNING',
  contentVersion: 1,
  contentHash: 'hash',
  policyRevision: 1,
  decidedAt: new Date(),
  dueAt: new Date(1),
  expiresAt: new Date(Date.now() + 60_000),
  muteProcessed: false,
  scanComplete: false,
  leaseToken: 'lease',
  leaseExpiresAt: new Date(Date.now() + 60_000),
};
function fixture() {
  const prisma = {
    chatReportCase: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(report),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
    chatReportAction: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'action' }),
      update: jest.fn(),
      createMany: jest.fn(),
    },
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ total: 0n, chat: 0n, bot: 0n }]),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  const state = {
    assertCurrent: jest.fn().mockResolvedValue(report),
    assertPolicy: jest.fn(),
    executionBotId: jest.fn().mockResolvedValue('bot'),
    assertCase: jest.fn().mockResolvedValue(report),
  };
  const deletes = {
    prepareReportTargetIntent: jest
      .fn()
      .mockResolvedValue({ rollout: 'execute', intentId: 'intent' }),
    ensureReportHistoryIntent: jest
      .fn()
      .mockResolvedValue({ rollout: 'execute', intentId: 'history' }),
    enqueueCurrentIntentWakeupStrict: jest.fn(),
  };
  const max = {
    replaceOwnMessage: jest.fn(),
    getExactMessageRow: jest.fn().mockResolvedValue(null),
    sendMessageImmediateWithId: jest.fn(),
  };
  const views = {
    summary: jest.fn().mockResolvedValue({
      status: 'RUNNING',
      votes: 2,
      threshold: 2,
      deleted: 0,
      pending: 0,
      absent: 0,
      failed: 0,
      muteApplied: false,
    }),
  };
  const telemetry = { record: jest.fn() };
  const service = new ReportExecutionService(
    prisma as never,
    state as never,
    deletes as never,
    max as never,
    views as never,
    {} as never,
    {} as never,
    {} as never,
    telemetry as never,
  );
  return { service, prisma, state, deletes, max, views, telemetry };
}
type ExecutionInternals = {
  applyMute: jest.Mock;
  materialize(report: unknown, messageId: string, token: string, wake?: boolean): Promise<void>;
  scanHistory(report: unknown, token: string): Promise<void>;
  processDue(report: unknown, deadline: number): Promise<void>;
  render: jest.Mock;
};
describe('report execution admission and scheduling', () => {
  it('fails durable target admission before recording a mute', async () => {
    const { service, deletes } = fixture();
    const applyMute = jest.fn();
    (service as unknown as ExecutionInternals).applyMute = applyMute;
    deletes.prepareReportTargetIntent.mockRejectedValue(new Error('storage unavailable'));
    await expect(service.process(report.id, 'lease', false)).rejects.toThrow('storage unavailable');
    expect(applyMute).not.toHaveBeenCalled();
    expect(deletes.enqueueCurrentIntentWakeupStrict).not.toHaveBeenCalled();
  });
  it('links the target first, records the mute decision, then wakes target deletion', async () => {
    const { service, deletes, prisma } = fixture();
    const phases: string[] = [];
    prisma.chatReportAction.update.mockImplementation(async () => {
      phases.push('linked');
    });
    (service as unknown as ExecutionInternals).applyMute = jest.fn(async () => {
      phases.push('mute');
      prisma.chatReportAction.upsert.mockResolvedValue({
        id: 'action',
        intentId: 'intent',
      } as never);
    });
    deletes.enqueueCurrentIntentWakeupStrict.mockImplementation(async () => {
      phases.push('wake');
    });
    await service.process(report.id, 'lease', false);
    expect(phases).toEqual(['linked', 'mute', 'wake']);
  });
  it('uses the trusted background API for a historical action', async () => {
    const { service, deletes } = fixture();
    await (service as unknown as ExecutionInternals).materialize(
      report,
      'history-message',
      'lease',
    );
    expect(deletes.ensureReportHistoryIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'history-message',
        event: expect.objectContaining({
          metadata: expect.objectContaining({ reportTargetMessageId: 'target', contentVersion: 1 }),
        }),
      }),
    );
    expect(deletes.prepareReportTargetIntent).not.toHaveBeenCalled();
    expect(deletes.enqueueCurrentIntentWakeupStrict).not.toHaveBeenCalled();
  });
  it.each([
    { total: 1000n, chat: 0n, bot: 0n },
    { total: 0n, chat: 200n, bot: 0n },
    { total: 0n, chat: 0n, bot: 400n },
  ])('does not admit history while a shared budget is full %p', async (pressure) => {
    const { service, prisma, deletes } = fixture();
    prisma.$queryRaw.mockResolvedValue([pressure]);
    await (service as unknown as ExecutionInternals).scanHistory(report, 'lease');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(deletes.ensureReportHistoryIntent).not.toHaveBeenCalled();
    expect(prisma.chatReportCase.updateMany).not.toHaveBeenCalled();
  });
  it('caps the next history page to the remaining chat capacity', async () => {
    const { service, prisma } = fixture();
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 20n, chat: 198n, bot: 20n }])
      .mockResolvedValueOnce([]);
    await (service as unknown as ExecutionInternals).scanHistory(report, 'lease');
    const query = prisma.$queryRaw.mock.calls[2]![0] as { values: unknown[] };
    expect(query.values.at(-1)).toBe(2);
  });
  it('reserves history actions and cursor before queue dispatch outside the admission transaction', async () => {
    const { service, prisma, deletes } = fixture();
    const phases: string[] = [];
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n, chat: 0n, bot: 0n }])
      .mockResolvedValueOnce([
        {
          id: 'webhook',
          created_at: report.decidedAt,
          normalized_payload: {
            message: { messageId: 'history-message', createdAt: report.decidedAt.toISOString() },
          },
        },
      ] as never);
    prisma.chatReportAction.createMany.mockImplementation(async () => {
      phases.push('reserved');
    });
    prisma.chatReportCase.updateMany.mockImplementation(async () => {
      phases.push('cursor');
      return { count: 1 };
    });
    prisma.$transaction.mockImplementation(async (callback) => {
      const result = await callback(prisma);
      phases.push('committed');
      return result;
    });
    deletes.ensureReportHistoryIntent.mockImplementation(async () => {
      phases.push('queued');
      return { rollout: 'execute', intentId: 'history' };
    });
    await (service as unknown as ExecutionInternals).scanHistory(report, 'lease');
    expect(phases.slice(0, 3)).toEqual(['reserved', 'cursor', 'committed']);
    expect(phases.indexOf('queued')).toBeGreaterThan(phases.indexOf('committed'));
  });
  it('refuses history reservation after the lease changes', async () => {
    const { service, prisma, deletes } = fixture();
    prisma.chatReportCase.findUniqueOrThrow.mockResolvedValue({
      ...report,
      leaseToken: 'replacement',
    });
    await expect(
      (service as unknown as ExecutionInternals).scanHistory(report, 'lease'),
    ).rejects.toThrow('сканирования');
    expect(prisma.chatReportAction.createMany).not.toHaveBeenCalled();
    expect(deletes.ensureReportHistoryIntent).not.toHaveBeenCalled();
  });
  it('records an ambiguous counter send only after durable dispatch start', async () => {
    const { service, max, telemetry } = fixture();
    max.sendMessageImmediateWithId.mockImplementation(async (_chat, _text, options) => {
      await options.beforeSend();
      throw new Error('receipt lost');
    });
    await expect(
      (service as unknown as ExecutionInternals).render(report, 'lease'),
    ).rejects.toThrow('receipt lost');
    expect(telemetry.record).toHaveBeenCalledWith('counterAmbiguous');
    telemetry.record.mockClear();
    max.sendMessageImmediateWithId.mockRejectedValue(new Error('route unavailable'));
    await expect(
      (service as unknown as ExecutionInternals).render(report, 'lease'),
    ).rejects.toThrow('route unavailable');
    expect(telemetry.record).not.toHaveBeenCalled();
  });
  it('fences a missing counter update to the original receipt and lease', async () => {
    const { service, prisma, max } = fixture();
    max.replaceOwnMessage.mockRejectedValue(new Error('message absent'));
    await (service as unknown as ExecutionInternals).render(
      { ...report, counterMessageId: 'counter-original' },
      'lease',
    );
    expect(prisma.chatReportCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          counterMessageId: 'counter-original',
          leaseToken: 'lease',
          status: 'RUNNING',
          contentVersion: 1,
        }),
      }),
    );
    expect(prisma.chatReportCase.update).not.toHaveBeenCalled();
  });
  it('reserves decision slots and limits active case processing to two workers', async () => {
    const { service, prisma } = fixture();
    const pending = Array.from({ length: 4 }, (_, n) => ({
      ...report,
      id: `pending-${n}`,
      status: 'PENDING',
    }));
    const running = Array.from({ length: 4 }, (_, n) => ({ ...report, id: `running-${n}` }));
    prisma.chatReportCase.findMany
      .mockResolvedValueOnce(pending as never)
      .mockResolvedValueOnce(running as never)
      .mockResolvedValueOnce([]);
    let active = 0,
      max = 0;
    const order: string[] = [];
    jest
      .spyOn(service as unknown as ExecutionInternals, 'processDue')
      .mockImplementation(async (item) => {
        active++;
        max = Math.max(active, max);
        order.push((item as typeof report).id);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        active--;
      });
    await service.tick();
    expect(max).toBe(2);
    expect(order.slice(0, 4)).toEqual(pending.map((item) => item.id));
    expect(prisma.chatReportCase.findMany.mock.calls[0]![0]).toMatchObject({
      where: { status: 'PENDING' },
      take: 4,
    });
  });
  it('chooses the two oldest maintenance cases across bounded status branches', async () => {
    const { service, prisma } = fixture();
    prisma.chatReportCase.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { ...report, id: 'collection', status: 'COLLECTING', dueAt: new Date(30) },
      ] as never)
      .mockResolvedValueOnce([
        { ...report, id: 'complete', status: 'COMPLETED', dueAt: new Date(20) },
      ] as never)
      .mockResolvedValueOnce([
        { ...report, id: 'partial', status: 'PARTIAL', dueAt: new Date(10) },
      ] as never);
    const ids: string[] = [];
    jest
      .spyOn(service as unknown as ExecutionInternals, 'processDue')
      .mockImplementation(async (item) => {
        ids.push((item as typeof report).id);
      });
    await service.tick();
    expect(ids).toEqual(['partial', 'complete']);
    expect(
      prisma.chatReportCase.findMany.mock.calls
        .slice(2)
        .every(([args]) => typeof args.where.status === 'string' && args.take === 2),
    ).toBe(true);
  });
  it('schedules an unchanged collection at expiry and preserves external wakeup ownership', async () => {
    const { service, prisma } = fixture();
    const collecting = { ...report, status: 'COLLECTING', leaseToken: 'unused' };
    prisma.chatReportCase.updateMany.mockImplementation(async (args) => {
      if (args.data.leaseToken) collecting.leaseToken = args.data.leaseToken;
      return { count: 1 };
    });
    prisma.chatReportCase.findUniqueOrThrow.mockResolvedValue(collecting as never);
    jest.spyOn(service, 'process').mockResolvedValue();
    (service as unknown as ExecutionInternals).render = jest.fn().mockResolvedValue(true);
    await (service as unknown as ExecutionInternals).processDue(collecting, Infinity);
    const query = prisma.$executeRaw.mock.calls[0]!;
    expect(query[1]).toEqual(report.dueAt);
    expect(query[2]).toEqual(report.expiresAt);
  });
});
