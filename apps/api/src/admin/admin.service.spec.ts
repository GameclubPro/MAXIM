import { AdminService } from './admin.service';

function createPrismaMock() {
  return {
    chat: {
      upsert: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Команда MAX',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      findUnique: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Команда MAX',
      }),
    },
    chatAdminAllowlist: {
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    moderationEvent: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
  };
}

function extractSqlText(arg: unknown): string {
  if (Array.isArray(arg)) {
    return arg.map((part) => String(part)).join(' ');
  }

  if (arg && typeof arg === 'object' && 'strings' in arg) {
    const strings = (arg as { strings?: unknown }).strings;
    if (Array.isArray(strings)) {
      return strings.map((part) => String(part)).join(' ');
    }
  }

  return String(arg);
}

describe('AdminService.getLogsDashboard', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns membership and violations summary for selected chat', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([{ joined_users: '5', left_users: '2' }]);
    prisma.moderationEvent.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    prisma.moderationEvent.findMany.mockResolvedValue([
      {
        id: 'evt-1',
        action: 'WARN',
        ruleCode: 'PROFANITY',
        userId: 'user-1',
        createdAt: new Date('2026-03-02T09:00:00.000Z'),
        maskedExcerpt: '***',
        metadata: { reason: 'Profanity detected' },
      },
      {
        id: 'evt-2',
        action: 'BAN',
        ruleCode: 'LINK_BLOCKED',
        userId: 'user-2',
        createdAt: new Date('2026-03-02T08:00:00.000Z'),
        maskedExcerpt: null,
        metadata: null,
      },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(prisma as never, maxClient as never, chatContextCache as never);

    const result = await service.getLogsDashboard(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d' },
    );

    expect(result.chat).toEqual({ id: 'chat-1', title: 'Команда MAX' });
    expect(result.membership).toEqual({ joinedUsers: 5, leftUsers: 2 });
    expect(result.violationsSummary).toEqual({
      warn: 3,
      deleteMessage: 4,
      kick: 1,
      ban: 2,
      total: 10,
    });
    expect(result.violations).toHaveLength(2);

    const sqlText = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(sqlText).toContain("user_added");
    expect(sqlText).toContain("user_removed");
    expect(sqlText).not.toContain("bot_added");

    expect(prisma.moderationEvent.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ chatId: 'chat-1' }) }),
    );
    expect(prisma.moderationEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ chatId: 'chat-1' }) }),
    );
  });

  it('uses 24h period boundaries when range=24h', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([{ joined_users: '0', left_users: '0' }]);
    prisma.moderationEvent.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    prisma.moderationEvent.findMany.mockResolvedValue([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(prisma as never, maxClient as never, chatContextCache as never);

    const result = await service.getLogsDashboard(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '24h' },
    );

    expect(result.period.range).toBe('24h');
    expect(result.period.from).toBe('2026-03-01T12:00:00.000Z');
    expect(result.period.to).toBe('2026-03-02T12:00:00.000Z');

    const countArgs = prisma.moderationEvent.count.mock.calls[0]?.[0];
    const createdAt = countArgs.where.createdAt;
    expect(createdAt.gte.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(createdAt.lte.toISOString()).toBe('2026-03-02T12:00:00.000Z');

  });
});
