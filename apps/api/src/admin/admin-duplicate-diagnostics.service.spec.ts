import {
  AdminDuplicateDiagnosticsService,
  presentDuplicateDeletionAttempt,
} from './admin-duplicate-diagnostics.service';
import { MESSAGE_DUPLICATE_MEDIA_VERSION } from '../moderation/message-duplicate/message-duplicate-state';
import {
  readDuplicateHistoryPage,
  encodeDuplicateHistoryCursor,
} from './admin-duplicate-diagnostics-history';

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
    messageId: 'repeat-id',
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
  it('limits the dedicated per-chat duplicate projection before reading reasons or events', async () => {
    const s = setup();
    const result = await s.service.read('chat-private');
    expect(result.capability).toEqual({
      state: 'CONFIRMED',
      checkedAt: new Date(now).toISOString(),
    });
    expect(s.planner.refreshChatBotCapabilitySnapshots).not.toHaveBeenCalled();
    const sql = s.tx.$queryRaw.mock.calls[0][0];
    expect(sql.sql).toContain('FROM duplicate_diagnostics_history history');
    expect(sql.sql).toContain('WHERE history.chat_id = ?');
    expect(sql.values).toContain('chat-private');
    expect(sql.values).toContain(6);
    expect(sql.sql).toContain('ORDER BY history.intent_created_at DESC, history.intent_id DESC');
    expect(sql.sql).toContain("rule_code = 'DUPLICATE_DELETE'");
    expect(sql.sql).toContain("metadata->'messageDuplicate' AS binding");
    expect(sql.sql).not.toMatch(/webhook_events|masked_excerpt|candidate_failures/);
    expect(s.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 3000,
      maxWait: 1000,
    });
    expect(JSON.stringify(result)).not.toMatch(/private-bot-id|chat-private|lastErrorCode/);
    expect(result.history.attempts[0]?.outcome).toBe('RETRYING');
  });

  it('exposes only original identity and fixed dates, without internal hashes or author IDs', async () => {
    const original = {
      member: 'a'.repeat(64),
      author: 'b'.repeat(64),
      messageId: 'original-id',
      senderId: 'private-author',
      publishedAtMs: now - 3600000,
      observedAtMs: now - 3600000,
      expiresAtMs: now + 23 * 3600000,
      sourceDigest: 'c'.repeat(64),
      contentDigest: 'd'.repeat(64),
      mediaHashes: [],
      epoch: 0,
    };
    const result = await setup([row({ original })]).service.read('chat');
    expect(result.history.attempts[0]?.original).toEqual({
      messageId: 'original-id',
      publishedAt: new Date(original.publishedAtMs).toISOString(),
      repeatAllowedAt: new Date(original.expiresAtMs).toISOString(),
    });
    expect(JSON.stringify(result)).not.toMatch(/private-author|sourceDigest|mediaHashes/);
    expect(presentDuplicateDeletionAttempt(row(), now).original).toBeUndefined();
  });

  it('does not turn failed history reads into successful empty results', async () => {
    const s = setup();
    s.tx.$queryRaw.mockRejectedValue(new Error('statement timeout'));
    expect((await s.service.read('chat')).history).toMatchObject({
      available: false,
      attempts: [],
    });
  });

  it('caps a page and binds the next cursor to its chat and snapshot', async () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      row({ id: `i${i}`, createdAt: new Date(now - i * 1000) }),
    );
    const s = setup(rows);
    const result = await s.service.read('chat');
    expect(result.history).toMatchObject({
      sampledIntents: 5,
      limited: true,
      coverage: 'PROJECTED_ONLY',
    });
    expect(result.history.attempts.map((item) => item.id)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4']);
    expect(
      readDuplicateHistoryPage('chat', { cursor: result.history.nextCursor }, now).cursor?.id,
    ).toBe('i4');
    expect(() =>
      readDuplicateHistoryPage('other-chat', { cursor: result.history.nextCursor }, now),
    ).toThrow();
    expect(() =>
      readDuplicateHistoryPage('chat', { cursor: result.history.nextCursor }, now + 16 * 60000),
    ).toThrow();
    expect(() => readDuplicateHistoryPage('chat', { limit: 21 }, now)).toThrow();
  });

  it('keeps missing projection coverage incomplete, and rejects malformed cursor scopes', async () => {
    expect((await setup([]).service.read('chat')).history).toMatchObject({
      available: true,
      limited: true,
      attempts: [],
    });
    const cursor = encodeDuplicateHistoryCursor({
      version: 1,
      chatId: 'chat',
      until: new Date(now).toISOString(),
      at: new Date(now - 86400001).toISOString(),
      id: 'id',
    });
    expect(() => readDuplicateHistoryPage('chat', { cursor }, now)).toThrow();
    expect(() => readDuplicateHistoryPage('chat', { cursor: 'arbitrary' }, now)).toThrow();
  });

  it('presents verified comparison and requested sanction without inventing a sanction receipt', () => {
    const binding = {
      version: 2,
      senderId: 'private-author',
      messageId: 'repeat-id',
      eventTimestampMs: now,
      controlRevision: 1,
      settingsDigest: 'a'.repeat(64),
      sourceDigest: 'b'.repeat(64),
      contentDigest: 'c'.repeat(64),
      fingerprint: 'd'.repeat(64),
      compareMode: 'TEXT',
      mediaHashes: [],
      mediaVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
      hasPhotos: false,
      photoControlRevision: null,
      windowSeconds: 43200,
      requiredCount: 3,
      sanction: { action: 'MUTE', repeatCount: 3, threshold: 3, settingsDigest: 'e'.repeat(64) },
    };
    const presented = presentDuplicateDeletionAttempt(row({ binding, kind: 'near' }), now);
    expect(presented.comparison).toEqual({
      mode: 'TEXT',
      kind: 'near',
      windowSeconds: 43200,
      firstDeletedMessageNumber: 3,
    });
    expect(presented.sanction).toEqual({ action: 'MUTE', state: 'REQUESTED' });
    expect(JSON.stringify(presented)).not.toMatch(/private-author|contentDigest|fingerprint/);
    const confirmed = presentDuplicateDeletionAttempt(
      row({ binding, sanctionEvidence: [{ action: 'MUTE', applied: true, binding }] }),
      now,
    );
    expect(confirmed.sanction?.state).toBe('CONFIRMED');
    const different = presentDuplicateDeletionAttempt(
      row({
        binding,
        sanctionEvidence: [
          { action: 'MUTE', applied: true, binding: { ...binding, eventTimestampMs: now - 1 } },
        ],
      }),
      now,
    );
    expect(different.sanction?.state).toBe('REQUESTED');
    for (const otherBinding of [
      { ...binding, policyRevision: 2 },
      { ...binding, sourceDigest: 'f'.repeat(64) },
      { ...binding, sanction: { ...binding.sanction, settingsDigest: 'f'.repeat(64) } },
      { ...binding, sanction: { ...binding.sanction, repeatCount: 4 } },
      { ...binding, sanction: { ...binding.sanction, threshold: 4 } },
      { ...binding, sanction: undefined },
    ])
      expect(
        presentDuplicateDeletionAttempt(
          row({
            binding,
            sanctionEvidence: [{ action: 'MUTE', applied: true, binding: otherBinding }],
          }),
          now,
        ).sanction?.state,
      ).toBe('REQUESTED');
    const warnBinding = { ...binding, sanction: { ...binding.sanction, action: 'WARN' } };
    expect(
      presentDuplicateDeletionAttempt(
        row({ binding: warnBinding, sanctionEvidence: [{ action: 'WARN', binding: warnBinding }] }),
        now,
      ).sanction?.state,
    ).toBe('CONFIRMED');
    expect(
      presentDuplicateDeletionAttempt(
        row({
          binding: warnBinding,
          sanctionEvidence: [{ action: 'WARN', applied: false, binding: warnBinding }],
        }),
        now,
      ).sanction?.state,
    ).toBe('REQUESTED');
    expect(
      presentDuplicateDeletionAttempt(
        row({ binding: { ...binding, messageId: 'another-message' } }),
        now,
      ).comparison,
    ).toBeUndefined();
  });

  it('resolves links only from an exact-chat MAX lookup and rejects guessed or external links', async () => {
    const s = setup();
    s.tx.$queryRaw.mockResolvedValue([{ messageId: 'repeat-id' }]);
    const maxClient = {
      getExactMessageRow: jest.fn().mockResolvedValue({}),
      parseChannelMessageSnapshot: jest
        .fn()
        .mockReturnValue({ messageId: 'repeat-id', url: 'https://max.ru/c/123/456' }),
    };
    Object.defineProperty(s.service, 'maxClient', { value: maxClient });
    expect(await s.service.readMessageLink('chat', 'intent', 'target')).toEqual({
      state: 'AVAILABLE',
      url: 'https://max.ru/c/123/456',
    });
    expect(maxClient.getExactMessageRow).toHaveBeenCalledWith(
      'chat',
      'repeat-id',
      expect.objectContaining({ trafficClass: 'background', timeoutMs: 2000 }),
    );
    maxClient.parseChannelMessageSnapshot.mockReturnValue({
      messageId: 'repeat-id',
      url: 'https://evil.example/link',
    });
    expect(await s.service.readMessageLink('chat', 'intent', 'target')).toEqual({
      state: 'UNAVAILABLE',
      url: null,
    });
    maxClient.getExactMessageRow.mockRejectedValue(new Error('different chat'));
    expect(await s.service.readMessageLink('chat', 'intent', 'target')).toEqual({
      state: 'UNAVAILABLE',
      url: null,
    });
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
    ['off', 'OFF'],
    ['shadow', 'OBSERVE'],
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
