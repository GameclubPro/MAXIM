import {
  AdminDuplicateDiagnosticsService,
  presentDuplicateDeletionAttempt,
} from './admin-duplicate-diagnostics.service';

const now = Date.now();
function row(overrides: Partial<Parameters<typeof presentDuplicateDeletionAttempt>[0]> = {}) {
  return {
    id: 'intent',
    status: 'RETRYABLE' as const,
    createdAt: new Date(now - 1000),
    updatedAt: new Date(now),
    nextAttemptAt: new Date(now + 1000),
    retryUntilAt: new Date(now + 60000),
    remoteDeleteSucceededAt: null,
    absenceVerifiedAt: null,
    lastErrorCode: null,
    duplicate: true,
    reasonsLimited: false,
    ...overrides,
  };
}
function setup(rows = [row()]) {
  const tx = { $executeRaw: jest.fn(), $queryRaw: jest.fn().mockResolvedValue(rows) };
  const prisma = {
    chatSettings: { findUnique: jest.fn().mockResolvedValue({ antiDuplicateEnabled: true }) },
    $transaction: jest.fn(async (fn) => fn(tx)),
  };
  const bots = {
    resolveStrictWriteModerationBotRoute: jest.fn().mockResolvedValue({
      botId: 'private-bot-id',
      capabilityState: 'confirmed_capable',
      checkedAt: new Date(now).toISOString(),
    }),
  };
  const planner = { refreshChatBotCapabilitySnapshots: jest.fn() };
  const policy = { resolve: jest.fn().mockResolvedValue({ mode: 'full' }) };
  return {
    tx,
    prisma,
    bots,
    planner,
    policy,
    service: new AdminDuplicateDiagnosticsService(
      prisma as never,
      bots as never,
      planner as never,
      policy as never,
    ),
  };
}

describe('duplicate diagnostics', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(now));
  afterEach(() => jest.restoreAllMocks());
  it('uses bounded indexed chat/status and reason walks without message content', async () => {
    const s = setup();
    const result = await s.service.read('chat-private');
    expect(result.capability).toEqual({
      state: 'CONFIRMED',
      checkedAt: new Date(now).toISOString(),
    });
    expect(s.planner.refreshChatBotCapabilitySnapshots).not.toHaveBeenCalled();
    const sql = s.tx.$queryRaw.mock.calls[0][0];
    expect(sql.sql).toContain('WHERE chat_id = ? AND status = statuses.status AND created_at >= ?');
    expect(sql.values).toContain('chat-private');
    expect(sql.values).toContain(21);
    expect(sql.sql).toContain('ORDER BY created_at DESC');
    expect(sql.sql).toContain('ORDER BY reason_key ASC LIMIT 9');
    expect(sql.sql).not.toMatch(/webhook_events|masked_excerpt|metadata|candidate_failures/);
    expect(s.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 3000,
      maxWait: 1000,
    });
    expect(JSON.stringify(result)).not.toMatch(/private-bot-id|chat-private|lastErrorCode/);
    expect(result.history.attempts[0]?.outcome).toBe('RETRYING');
  });

  it('does not turn failed history reads into successful empty results', async () => {
    const s = setup();
    s.tx.$queryRaw.mockRejectedValue(new Error('statement timeout'));
    expect((await s.service.read('chat')).history).toMatchObject({
      available: false,
      attempts: [],
    });
  });

  it('caps every status and marks incomplete source/reason samples', async () => {
    const rows = Array.from({ length: 21 }, (_, i) =>
      row({ id: `i${i}`, createdAt: new Date(now - i * 1000), duplicate: i !== 0 }),
    );
    const s = setup(rows.reverse());
    const result = await s.service.read('chat');
    expect(result.history).toMatchObject({ sampledIntents: 20, limited: true });
    expect(result.history.attempts.map((item) => item.id)).toEqual(['i1', 'i2', 'i3', 'i4', 'i5']);
    s.tx.$queryRaw.mockResolvedValue([row({ reasonsLimited: true })]);
    expect((await s.service.read('chat')).history.limited).toBe(true);
  });

  it.each(['confirmed_capable', 'explicitly_incapable', 'stale_or_unknown'])(
    'keeps the multi-bot aggregate %s and its timestamp',
    async (capabilityState) => {
      const s = setup();
      s.bots.resolveStrictWriteModerationBotRoute.mockResolvedValue({
        botId: capabilityState === 'confirmed_capable' ? 'any-capable-bot' : null,
        capabilityState,
        checkedAt: new Date(now).toISOString(),
      });
      const result = await s.service.read('chat', true);
      expect(s.planner.refreshChatBotCapabilitySnapshots).toHaveBeenCalledWith({
        chatId: 'chat',
        entityType: 'chat',
        force: true,
      });
      expect(result.capability.state).toBe(
        capabilityState === 'confirmed_capable'
          ? 'CONFIRMED'
          : capabilityState === 'explicitly_incapable'
            ? 'MISSING'
            : 'UNKNOWN',
      );
    },
  );

  it('does not show stale permission success after a failed live recheck', async () => {
    const s = setup();
    s.planner.refreshChatBotCapabilitySnapshots.mockRejectedValue(new Error('MAX unavailable'));
    expect((await s.service.read('chat', true)).capability).toEqual({
      state: 'UNKNOWN',
      checkedAt: null,
    });
    expect(s.bots.resolveStrictWriteModerationBotRoute).not.toHaveBeenCalled();
  });

  it('does not present a backoff-retained snapshot as a successful live recheck', async () => {
    const s = setup();
    const checkedAt = new Date(now - 1000).toISOString();
    s.bots.resolveStrictWriteModerationBotRoute.mockResolvedValue({
      botId: 'bot',
      capabilityState: 'confirmed_capable',
      checkedAt,
    });
    expect((await s.service.read('chat', true)).capability).toEqual({
      state: 'UNKNOWN',
      checkedAt,
    });
  });

  it.each([
    ['off', 'LEGACY_TEXT'],
    ['shadow', 'LEGACY_TEXT'],
    ['delete_only', 'DELETE_ONLY'],
    ['full', 'FULL'],
  ])('separates saved enablement and mode %s', async (mode, expected) => {
    const s = setup();
    s.policy.resolve.mockResolvedValue({ mode });
    s.prisma.chatSettings.findUnique.mockResolvedValue({ antiDuplicateEnabled: false });
    expect(await s.service.read('chat')).toMatchObject({ enabled: false, mode: expected });
  });

  it('keeps unavailable runtime policy unknown', async () => {
    const s = setup();
    s.policy.resolve.mockRejectedValue(new Error('Redis unavailable'));
    expect((await s.service.read('chat')).mode).toBe('UNKNOWN');
  });

  it.each([
    ['PENDING', 'PENDING'],
    ['IN_PROGRESS', 'PENDING'],
    ['RETRYABLE', 'RETRYING'],
    ['WAITING_CAPABILITY', 'WAITING_ACCESS'],
    ['AMBIGUOUS', 'UNCONFIRMED'],
    ['SUCCEEDED', 'UNCONFIRMED'],
    ['ALREADY_ABSENT', 'UNCONFIRMED'],
    ['EXPIRED', 'EXPIRED'],
    ['FAILED_TERMINAL', 'CANCELLED'],
    ['OBSERVED', 'OBSERVED'],
  ] as const)('requires receipts before labelling %s as deleted', (status, expected) => {
    expect(presentDuplicateDeletionAttempt(row({ status }), now).outcome).toBe(expected);
    expect(
      presentDuplicateDeletionAttempt(row({ status, remoteDeleteSucceededAt: new Date(now) }), now)
        .outcome,
    ).toBe('DELETED');
    expect(
      presentDuplicateDeletionAttempt(row({ status, absenceVerifiedAt: new Date(now) }), now)
        .outcome,
    ).toBe('ALREADY_ABSENT');
  });

  it('expires pending attempts and exposes only fixed rejection reasons', () => {
    expect(
      presentDuplicateDeletionAttempt(row({ retryUntilAt: new Date(now - 1) }), now),
    ).toMatchObject({ outcome: 'EXPIRED', nextAttemptAt: null });
    expect(
      presentDuplicateDeletionAttempt(
        row({ status: 'FAILED_TERMINAL', lastErrorCode: 'message_duplicate_author_immune' }),
        now,
      ).reason,
    ).toBe('IMMUNITY');
    expect(
      presentDuplicateDeletionAttempt(
        row({ status: 'FAILED_TERMINAL', lastErrorCode: 'sensitive arbitrary error' }),
        now,
      ).reason,
    ).toBe('UNKNOWN');
  });
});
