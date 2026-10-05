import { ConfigService } from '@nestjs/config';
import { fingerprintModerationSettings } from '../moderation/moderation-settings-fingerprint';
import type { MaxActionJob, MaxActionLedgerContextValue } from './max-client.service';
import { buildMaxActionIdempotencyKey } from './max-action-idempotency';
import {
  MaxModerationRuleNoticeGuardService,
  MaxModerationRuleNoticeRejectedError,
} from './max-moderation-rule-notice.guard';

function fixture() {
  const sourceAt = new Date(Date.now() - 10_000);
  const issuedAtMs = sourceAt.getTime() + 1_000;
  const settings = {
    maxMessageLengthEnabled: true,
    maxMessageLength: 10,
    messageLimitsWarnEnabled: true,
    nightModeTimezone: 'UTC',
    chat: { entityType: 'CHAT', admins: [] as unknown[] },
  };
  const proof = {
    version: 1,
    chatId: '-123',
    messageId: 'source-message',
    userId: 'user-1',
    reasonKey: 'length',
    ruleCode: 'MESSAGE_TOO_LONG_DELETE',
    policySha256: fingerprintModerationSettings(settings, 'MESSAGE_TOO_LONG'),
    deadlineAtMs: sourceAt.getTime() + 300_000,
  };
  const row = {
    id: 'durable-followup',
    chatId: proof.chatId,
    messageId: proof.messageId,
    userId: proof.userId,
    reasonKey: proof.reasonKey,
    ruleCode: proof.ruleCode,
    sourceAt,
    deadlineAt: new Date(proof.deadlineAtMs),
    policySha256: proof.policySha256,
    status: 'COMPLETED',
    actionPlan: {
      version: 1,
      action: 'MUTE',
      issuedAtMs,
      eventId: 'durable-followup:decision',
      noticeKey: 'durable-followup:sanction-notice',
    },
    effects: { phase: 'SETTLED', eventId: 'durable-followup:decision' },
  };
  const releaseRows: { id: string; ruleCode: string; createdAt: Date }[] = [];
  const prisma = {
    chatSettings: { findUnique: jest.fn(async () => settings) },
    moderationDeleteIntent: {
      findUnique: jest.fn(async () => ({
        id: 'intent',
        status: 'SUCCEEDED',
        subjectUserId: proof.userId,
        sourceMessageAt: sourceAt,
      })),
    },
    moderationDeleteIntentReason: {
      findUnique: jest.fn(async () => ({
        ruleCode: proof.ruleCode,
        userId: proof.userId,
        metadata: { moderationDeleteVerified: true },
      })),
    },
    moderationRuleFollowup: { findUnique: jest.fn(async () => row as typeof row | null) },
    moderationEvent: {
      findFirst: jest.fn(
        async (input: { where: { createdAt: { gte: Date }; ruleCode: { in: string[] } } }) =>
          releaseRows.find(
            (event) =>
              input.where.ruleCode.in.includes(event.ruleCode) &&
              event.createdAt >= input.where.createdAt.gte,
          ) ?? null,
      ),
    },
  };
  const guard = new MaxModerationRuleNoticeGuardService(
    prisma as never,
    { isKnownBotUserId: () => false } as never,
    { consumeForMessage: async () => 'not_granted' } as never,
    new ConfigService(),
  );
  const action: MaxActionJob = {
    actionType: 'SEND_MESSAGE',
    chatId: proof.chatId,
    botId: 'peer',
    text: 'Synthetic notice',
    idempotencyKey: row.actionPlan.noticeKey,
    createdAt: new Date().toISOString(),
    attempt: 1,
    ledgerContext: {
      moderationRuleNotice: proof,
      moderationRuleFollowup: { version: 1, id: row.id, issuedAtMs },
    },
  };
  const author = jest.fn(async () => ({ userId: proof.userId, isAdmin: false, isOwner: false }));
  return { action, author, guard, proof, row, settings, prisma, releaseRows, issuedAtMs };
}

describe('durable rule notice final dispatch fence', () => {
  it('keeps legacy bound notices compatible and performs no outbox queries without a marker', async () => {
    const s = fixture();
    delete s.action.ledgerContext!.moderationRuleFollowup;
    await expect(s.guard.assertAllowed(s.action, 'selected', s.author)).resolves.toBeUndefined();
    expect(s.prisma.moderationRuleFollowup.findUnique).not.toHaveBeenCalled();
    expect(s.prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
  });

  it('validates a completed own plan with two bounded probes after route and before final policy', async () => {
    const s = fixture();
    const route = jest.fn(async () => {
      expect(s.author).toHaveBeenCalledTimes(1);
      expect(s.prisma.moderationRuleFollowup.findUnique).not.toHaveBeenCalled();
    });
    await expect(
      s.guard.assertAllowed(s.action, 'selected', s.author, route),
    ).resolves.toBeUndefined();
    expect(s.prisma.moderationRuleFollowup.findUnique).toHaveBeenCalledTimes(1);
    expect(s.prisma.moderationRuleFollowup.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: s.row.id },
      }),
    );
    expect(s.prisma.moderationEvent.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: s.proof.chatId,
        userId: s.proof.userId,
        ruleCode: { in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'] },
        createdAt: { gte: new Date(s.issuedAtMs) },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    expect(s.prisma.moderationEvent.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      s.prisma.chatSettings.findUnique.mock.invocationCallOrder[1]!,
    );
  });

  it.each(['MANUAL_UNMUTE', 'MANUAL_UNBAN'])(
    'revokes a queued notice when %s commits while the actual final route hook awaits',
    async (ruleCode) => {
      const s = fixture();
      const route = async () => {
        await Promise.resolve();
        s.releaseRows.push({ id: 'release', ruleCode, createdAt: new Date(s.issuedAtMs) });
      };
      await expect(
        s.guard.assertAllowed(s.action, 'selected', s.author, route),
      ).rejects.toBeInstanceOf(MaxModerationRuleNoticeRejectedError);
      expect(s.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(1);
    },
  );

  it('honors older releases and unrelated sanctions through the exact issued-time query', async () => {
    const s = fixture();
    s.releaseRows.push(
      { id: 'older', ruleCode: 'MANUAL_UNMUTE', createdAt: new Date(s.issuedAtMs - 1) },
      { id: 'unrelated', ruleCode: 'MANUAL_MUTE', createdAt: new Date(s.issuedAtMs + 1) },
    );
    await expect(s.guard.assertAllowed(s.action, 'selected', s.author)).resolves.toBeUndefined();
  });

  it.each(['routed', 'pinned'])(
    'accepts the exact production-normalized %s SEND identity with a committed own event',
    async (route) => {
      const s = fixture();
      s.action = {
        ...s.action,
        idempotencyKey: buildMaxActionIdempotencyKey('explicit', [
          ...(route === 'pinned' ? [s.action.botId!] : []),
          'SEND_MESSAGE',
          s.row.actionPlan.noticeKey,
        ]),
      };
      await expect(s.guard.assertAllowed(s.action, 'selected', s.author)).resolves.toBeUndefined();
      s.action = { ...s.action, idempotencyKey: `${s.action.idempotencyKey}-wrong-digest` };
      await expect(s.guard.assertAllowed(s.action, 'selected', s.author)).rejects.toBeInstanceOf(
        MaxModerationRuleNoticeRejectedError,
      );
    },
  );

  it('allows the exact explanation before SQL sanction commit without borrowing a sanction notice', async () => {
    const s = fixture();
    s.action = { ...s.action, idempotencyKey: `${s.row.id}:explanation` };
    s.row.status = 'IN_PROGRESS';
    s.row.effects = { phase: 'UNSTARTED', eventId: '' };
    await expect(s.guard.assertAllowed(s.action, 'selected', s.author)).resolves.toBeUndefined();
    s.action = { ...s.action, idempotencyKey: s.row.actionPlan.noticeKey };
    await expect(s.guard.assertAllowed(s.action, 'selected', s.author)).rejects.toBeInstanceOf(
      MaxModerationRuleNoticeRejectedError,
    );
  });

  it.each(['unknown-key', 'wrong-event', 'BAN_STARTED', 'BAN_CONFIRMED', 'UNKNOWN', 'UNSTARTED'])(
    'rejects a sanction notice with %s instead of treating intent acceptance as success',
    async (change) => {
      const s = fixture();
      if (change === 'unknown-key') s.action = { ...s.action, idempotencyKey: 'another:notice' };
      else if (change === 'wrong-event') s.row.effects.eventId = 'another:decision';
      else s.row.effects.phase = change;
      await expect(s.guard.assertAllowed(s.action, 'selected', s.author)).rejects.toBeInstanceOf(
        MaxModerationRuleNoticeRejectedError,
      );
    },
  );

  it.each([
    'missing',
    'foreign-chat',
    'foreign-user',
    'foreign-message',
    'foreign-reason',
    'foreign-rule',
    'source',
    'deadline',
    'policy',
    'plan-version',
    'plan-issued',
    'plan-action',
    'WAITING_DELETE',
    'CANCELLED',
    'EXPIRED',
    'AMBIGUOUS',
    'unknown-status',
  ])('rejects %s durable state instead of borrowing another notice authority', async (change) => {
    const s = fixture();
    if (change === 'missing') s.prisma.moderationRuleFollowup.findUnique.mockResolvedValue(null);
    if (change === 'foreign-chat') s.row.chatId = '-other';
    if (change === 'foreign-user') s.row.userId = 'other';
    if (change === 'foreign-message') s.row.messageId = 'other';
    if (change === 'foreign-reason') s.row.reasonKey = 'other';
    if (change === 'foreign-rule') s.row.ruleCode = 'STOP_WORD_DELETE';
    if (change === 'source') s.row.sourceAt = new Date(s.row.sourceAt.getTime() - 1);
    if (change === 'deadline') s.row.deadlineAt = new Date(s.row.deadlineAt.getTime() + 1);
    if (change === 'policy') s.row.policySha256 = 'b'.repeat(64);
    if (change === 'plan-version') s.row.actionPlan.version = 2;
    if (change === 'plan-issued') s.row.actionPlan.issuedAtMs += 1;
    if (change === 'plan-action') s.row.actionPlan.action = 'UNMUTE';
    if (['WAITING_DELETE', 'CANCELLED', 'EXPIRED', 'AMBIGUOUS', 'unknown-status'].includes(change))
      s.row.status = change;
    await expect(s.guard.assertAllowed(s.action, 'selected', s.author)).rejects.toBeInstanceOf(
      MaxModerationRuleNoticeRejectedError,
    );
    expect(s.prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    [],
    { version: 2, id: 'durable-followup', issuedAtMs: 1 },
    { version: 1, id: '', issuedAtMs: 1 },
    { version: 1, id: 'id', issuedAtMs: -1 },
    { version: 1, id: 'id', issuedAtMs: 1, extra: true },
  ])(
    'rejects malformed durable marker %j before any transport-authorizing reads',
    async (marker) => {
      const s = fixture();
      s.action.ledgerContext!.moderationRuleFollowup = marker as MaxActionLedgerContextValue;
      await expect(s.guard.assertAllowed(s.action, 'selected', s.author)).rejects.toBeInstanceOf(
        MaxModerationRuleNoticeRejectedError,
      );
      expect(s.author).not.toHaveBeenCalled();
    },
  );

  it('requires the independent generic proof whenever a durable marker is present', async () => {
    const s = fixture();
    delete s.action.ledgerContext!.moderationRuleNotice;
    await expect(s.guard.assertAllowed(s.action, 'selected', s.author)).rejects.toBeInstanceOf(
      MaxModerationRuleNoticeRejectedError,
    );
  });

  it('propagates unavailable SQL and expired final deadlines without permitting a SEND', async () => {
    const s = fixture();
    const unavailable = new Error('SQL unavailable');
    s.prisma.moderationEvent.findFirst.mockRejectedValueOnce(unavailable);
    await expect(s.guard.assertAllowed(s.action, 'selected', s.author)).rejects.toBe(unavailable);
    let clock: jest.SpyInstance | undefined;
    try {
      s.prisma.moderationEvent.findFirst.mockImplementationOnce(async () => {
        clock = jest.spyOn(Date, 'now').mockReturnValue(s.proof.deadlineAtMs);
        return null;
      });
      await expect(s.guard.assertAllowed(s.action, 'selected', s.author)).rejects.toBeInstanceOf(
        MaxModerationRuleNoticeRejectedError,
      );
    } finally {
      clock?.mockRestore();
    }
  });
});
