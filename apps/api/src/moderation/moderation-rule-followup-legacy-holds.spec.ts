import type { ModerationRuleFollowup } from '../prisma/prisma-client';
import { ModerationRuleFollowupService } from './moderation-rule-followup.service';
import type { ModerationRuleFollowupPlan } from './moderation-rule-followup.contract';
import { fingerprintModerationSettings } from './moderation-settings-fingerprint';
import { createSettings } from './moderation.service.spec-support';

describe('rule follow-up global legacy holds', () => {
  function fixture(userId = 'held') {
    const now = new Date();
    const sourceAt = new Date(now.getTime() - 1000);
    const settings = {
      ...createSettings(),
      chat: { entityType: 'CHAT', admins: [] },
    };
    const row = {
      id: 'followup',
      intentId: 'intent',
      chatId: 'other-chat',
      userId,
      messageId: 'fresh-message',
      ruleCode: 'MESSAGE_TOO_LONG_DELETE',
      reasonKey: 'MESSAGE_TOO_LONG:violation-delete',
      sourceAt,
      deadlineAt: new Date(sourceAt.getTime() + 300_000),
      leaseToken: 'lease',
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      status: 'IN_PROGRESS',
      actionPlan: null,
      policySha256: fingerprintModerationSettings(settings as never, 'MESSAGE_TOO_LONG_DELETE'),
      envelope: {
        version: 1,
        updateType: 'message_created',
        originBotId: 'bot',
        userLabel: 'Fixture',
        effectiveMessageLength: 60,
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      },
    } as ModerationRuleFollowup;
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ now }]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      moderationRuleFollowup: { findUniqueOrThrow: jest.fn().mockResolvedValue(row) },
      chatSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
      moderationDeleteIntentReason: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          ruleCode: row.ruleCode,
          userId,
          score: 1,
          metadata: { moderationDeleteVerified: true },
        }),
      },
      moderationDeleteIntent: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          status: 'SUCCEEDED',
          chatId: row.chatId,
          messageId: row.messageId,
          subjectUserId: userId,
          sourceMessageAt: sourceAt,
        }),
      },
      moderationViolationMessageClaim: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      violation: { create: jest.fn(), count: jest.fn().mockResolvedValue(1) },
      moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma = { $transaction: jest.fn(async (fn) => fn(tx)) };
    const guard = { assertAllowed: jest.fn().mockResolvedValue(undefined) };
    const bots = { resolveBotRoute: jest.fn().mockResolvedValue({ botId: 'bot' }) };
    const holds = {
      isMessageHeld: jest.fn().mockResolvedValue(false),
      isMemberHeld: jest.fn().mockResolvedValue(false),
      isGlobalUserHeld: jest.fn(async (author: string) => author === 'held'),
    };
    const journal = { assertLease: jest.fn().mockResolvedValue(undefined) };
    const service = new ModerationRuleFollowupService(
      prisma as never,
      guard as never,
      bots as never,
      {} as never,
      holds as never,
    );
    return { service: service as any, row, tx, prisma, guard, bots, holds, journal, now };
  }

  function savedPlan(row: ModerationRuleFollowup, issuedAtMs: number): ModerationRuleFollowupPlan {
    return {
      version: 1,
      action: 'BAN',
      violationCount: 4,
      issuedAtMs,
      muteExpiresAtMs: null,
      muteDurationHours: 6,
      eventId: `${row.id}:decision`,
      noticeKey: `${row.id}:sanction-notice`,
    };
  }

  it('denies a fresh plan before spending route quota or immunity when only the global hold matches', async () => {
    const f = fixture();
    expect(await f.service.preparePlan(f.row, f.journal)).toBeNull();
    expect(f.holds.isMessageHeld).toHaveBeenCalledWith('other-chat', 'fresh-message');
    expect(f.holds.isMemberHeld).toHaveBeenCalledWith('other-chat', 'held');
    expect(f.holds.isGlobalUserHeld).toHaveBeenCalledWith('held');
    expect(f.bots.resolveBotRoute).not.toHaveBeenCalled();
    expect(f.guard.assertAllowed).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rechecks the global hold under the SQL transaction before a new claim, violation or plan', async () => {
    const f = fixture();
    f.holds.isGlobalUserHeld.mockImplementation(async (_author: string, tx?: unknown) => !!tx);
    expect(await f.service.preparePlan(f.row, f.journal)).toBeNull();
    expect(f.holds.isGlobalUserHeld).toHaveBeenLastCalledWith('held', f.tx);
    expect(f.guard.assertAllowed).toHaveBeenCalledTimes(1);
    expect(f.tx.moderationViolationMessageClaim.create).not.toHaveBeenCalled();
    expect(f.tx.violation.create).not.toHaveBeenCalled();
    expect(f.tx.chatSettings.findUnique).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1); // The advisory lock only.
  });

  it('admits an independent author to one new frozen plan and strike', async () => {
    const f = fixture('independent');
    expect(await f.service.preparePlan(f.row, f.journal)).toMatchObject({
      version: 1,
      violationCount: 1,
      eventId: 'followup:decision',
    });
    expect(f.holds.isGlobalUserHeld).toHaveBeenLastCalledWith('independent', f.tx);
    expect(f.tx.moderationViolationMessageClaim.create).toHaveBeenCalledTimes(1);
    expect(f.tx.violation.create).toHaveBeenCalledTimes(1);
  });

  it('preserves the original saved plan for exact receipt recovery despite a global hold', async () => {
    const f = fixture();
    const plan = savedPlan(f.row, f.now.getTime());
    f.row.actionPlan = { ...plan };
    expect(await f.service.preparePlan(f.row, f.journal)).toEqual(plan);
    expect(f.holds.isGlobalUserHeld).not.toHaveBeenCalled();
    expect(f.guard.assertAllowed).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('adopts only the already frozen own SQL plan before the transactional hold check', async () => {
    const f = fixture();
    const plan = savedPlan(f.row, f.now.getTime());
    f.holds.isGlobalUserHeld.mockResolvedValue(false);
    f.tx.moderationRuleFollowup.findUniqueOrThrow.mockResolvedValue({ ...f.row, actionPlan: plan });
    expect(await f.service.preparePlan(f.row, f.journal)).toEqual(plan);
    expect(f.holds.isGlobalUserHeld).toHaveBeenCalledTimes(1);
    expect(f.tx.moderationViolationMessageClaim.create).not.toHaveBeenCalled();
    expect(f.tx.violation.create).not.toHaveBeenCalled();
  });

  it('fails closed before admission if the global hold store is unavailable', async () => {
    const f = fixture();
    f.holds.isGlobalUserHeld.mockRejectedValue(new Error('Global hold store unavailable'));
    await expect(f.service.preparePlan(f.row, f.journal)).rejects.toThrow(
      'Global hold store unavailable',
    );
    expect(f.guard.assertAllowed).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
});
