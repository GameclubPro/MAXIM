import { SuggestionSubscriptionMonitorService } from './suggestion-subscription-monitor.service';

function fixture() {
  const rows = ['one', 'two'].map((id) => ({
    id,
    chatId: '-1',
    authorUserId: id,
    profile: 'moderation',
    botId: 'major',
    revision: 0,
    nextCheckAt: new Date(0),
    missingSince: null as Date | null,
    checkedAt: null,
    leaseToken: null,
    leaseUntil: null,
    publicationCursor: null,
  }));
  const prisma = {
    suggestionSubscriptionWatch: {
      findMany: jest.fn(async () => rows),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    suggestionSubscriptionPublication: {
      findFirst: jest.fn(async () => ({ id: 'post' })),
      findMany: jest.fn(async () => [
        { id: 'post', messageId: 'mid', publishedAt: new Date(0), deleteIntentId: null },
      ]),
      updateMany: jest.fn(),
    },
    moderationDeleteIntent: { updateMany: jest.fn() },
  };
  const subscriptions = {
    policy: jest.fn(async () => ({ deleteOnLeave: true })),
    probe: jest.fn(async () => new Map(rows.map((row) => [row.authorUserId, {}]))),
  };
  const deletes = {
    ensureAndAttempt: jest.fn(async () => ({ intentId: 'intent', confirmed: true })),
  };
  const governor = { decide: jest.fn(async () => ({ action: 'run' })) };
  const monitor = new SuggestionSubscriptionMonitorService(
    prisma as never,
    subscriptions as never,
    deletes as never,
    governor as never,
    {} as never,
  );
  return { rows, prisma, subscriptions, deletes, governor, monitor };
}

describe('bounded suggestion subscription monitor', () => {
  const previousRole = process.env.APP_ROLE;
  const previousService = process.env.APP_SERVICE_NAME;
  beforeEach(() => {
    process.env.APP_ROLE = 'action';
    process.env.APP_SERVICE_NAME = 'api-action';
  });
  afterEach(() => {
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
    if (previousService === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = previousService;
  });

  it('batches authors for the same channel and bot without inspecting channel history', async () => {
    const f = fixture();
    await f.monitor.processDue();
    expect(f.prisma.suggestionSubscriptionWatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 25,
        orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
        where: { profile: 'moderation', nextCheckAt: expect.anything() },
      }),
    );
    expect(f.subscriptions.probe).toHaveBeenCalledTimes(1);
    expect(f.subscriptions.probe).toHaveBeenCalledWith('-1', ['one', 'two'], 'major', 'background');
    expect(f.deletes.ensureAndAttempt).not.toHaveBeenCalled();
  });

  it('does not probe when the option is off', async () => {
    const f = fixture();
    f.subscriptions.policy.mockResolvedValue({ deleteOnLeave: false });
    await f.monitor.processDue();
    expect(f.subscriptions.probe).not.toHaveBeenCalled();
  });

  it('does not probe authors with no remaining tracked posts', async () => {
    const f = fixture();
    f.prisma.suggestionSubscriptionPublication.findFirst.mockResolvedValue(null as never);
    await f.monitor.processDue();
    expect(f.subscriptions.probe).not.toHaveBeenCalled();
  });

  it('defers first absence instead of deleting', async () => {
    const f = fixture();
    f.subscriptions.probe.mockResolvedValue(new Map());
    await f.monitor.processDue();
    expect(f.deletes.ensureAndAttempt).not.toHaveBeenCalled();
    expect(f.prisma.suggestionSubscriptionWatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          missingSince: expect.any(Date),
          checkedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('creates exact-origin durable intents only after repeated absence', async () => {
    const f = fixture();
    f.rows.splice(1);
    f.rows[0]!.missingSince = new Date(Date.now() - 60_000);
    f.subscriptions.probe.mockResolvedValue(new Map());
    await f.monitor.processDue();
    expect(f.deletes.ensureAndAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-1',
        messageId: 'mid',
        suggestionSubscriptionId: 'post',
        originBotId: 'major',
        entityType: 'CHANNEL',
        messageAuthorKind: 'bot',
        routingPolicy: 'origin_only',
      }),
    );
    expect(f.prisma.suggestionSubscriptionPublication.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { deleteIntentId: 'intent', deletedAt: expect.any(Date) } }),
    );
  });

  it('resets uncertain observations and backs off on MAX failure', async () => {
    const f = fixture();
    f.rows[0]!.missingSince = new Date(Date.now() - 60_000);
    f.subscriptions.probe.mockRejectedValue(new Error('timeout'));
    await f.monitor.processDue();
    expect(f.deletes.ensureAndAttempt).not.toHaveBeenCalled();
    expect(f.prisma.suggestionSubscriptionWatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ missingSince: null, checkedAt: null }),
      }),
    );
  });

  it('respects the background governor before querying or calling MAX', async () => {
    const f = fixture();
    f.governor.decide.mockResolvedValue({ action: 'pause' });
    await f.monitor.processDue();
    expect(f.prisma.suggestionSubscriptionWatch.findMany).not.toHaveBeenCalled();
  });

  it('does not run from a second action instance with a different service identity', async () => {
    const f = fixture();
    process.env.APP_SERVICE_NAME = 'api-action-extra';
    await f.monitor.processDue();
    expect(f.prisma.suggestionSubscriptionWatch.findMany).not.toHaveBeenCalled();
  });

  it('does not overwrite a webhook wake when releasing a stale lease', async () => {
    const f = fixture();
    f.prisma.suggestionSubscriptionWatch.updateMany.mockResolvedValue({ count: 0 });
    await (
      f.monitor as unknown as { release: (row: unknown, delay: number) => Promise<void> }
    ).release(f.rows[0], 60_000);
    expect(f.prisma.suggestionSubscriptionWatch.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'one', leaseToken: null },
      data: { leaseToken: null, leaseUntil: null },
    });
  });
});
