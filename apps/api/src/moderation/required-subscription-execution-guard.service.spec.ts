import { ConfigService } from '@nestjs/config';
import { fingerprintModerationSettings } from './message-limits-delete-guard.service';
import { RequiredSubscriptionExecutionGuardService } from './required-subscription-execution-guard.service';

function fixture() {
  const settings = {
    requiredSubscriptionEnabled: true,
    requiredSubscriptionChannelIds: ['target-1', 'target-2'],
    requiredSubscriptionWarnEnabled: true,
    requiredSubscriptionMuteEnabled: true,
    requiredSubscriptionBanEnabled: true,
    requiredSubscriptionMuteDurationHours: 1,
    nightModeTimezone: 'UTC',
    chat: { entityType: 'CHAT', admins: [] as unknown[] },
  };
  const at = Date.now();
  const input = {
    chatId: '-123',
    messageId: 'm1',
    subjectUserId: 'user-1',
    botId: 'selected-peer',
    reasons: [
      {
        ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
        reasonKey: 'subscription',
        metadata: {
          requiredSubscriptionGuardVersion: 1,
          requiredSubscriptionSourceAtMs: at,
          requiredSubscriptionDeadlineAtMs: at + 300_000,
          requiredSubscriptionPolicySha256: fingerprintModerationSettings(
            settings,
            'REQUIRED_SUBSCRIPTION',
          ),
        },
      },
    ],
  };
  const prisma = { chatSettings: { findUnique: jest.fn(async () => settings) } };
  const max = {
    getChatMemberAccess: jest.fn(async () => ({
      userId: 'user-1',
      isAdmin: false,
      isOwner: false,
    })),
    getExactMessageRow: jest.fn(async () => ({
      sender: { user_id: 'user-1' },
      recipient: { chat_id: '-123', chat_type: 'chat' },
      timestamp: at,
      body: { mid: 'm1', text: 'hello' },
    })),
  };
  const membership = {
    getMembershipResolution: jest.fn(async () => ({ membership: false, fresh: true })),
    getLookupIssue: jest.fn(() => null as unknown),
  };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const bots = { isKnownBotUserId: jest.fn(() => false) };
  const service = new RequiredSubscriptionExecutionGuardService(
    prisma as never,
    max as never,
    bots as never,
    membership as never,
    immunity as never,
    new ConfigService(),
  );
  return { service, input, settings, max, membership, immunity, prisma, bots };
}

describe('required subscription execution authorization', () => {
  it('checks the route after fresh membership before final settings and deadline', async () => {
    const s = fixture();
    const route = jest.fn(async () => {
      expect(s.membership.getMembershipResolution).toHaveBeenCalledTimes(2);
      s.settings.requiredSubscriptionEnabled = false;
    });
    await expect(
      s.service.authorize({ ...s.input, beforeFinalAuthority: route }),
    ).rejects.toMatchObject({
      code: 'required_subscription_no_longer_authorized',
    });
    expect(route).toHaveBeenCalledTimes(1);
    expect(s.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
  });

  it('does not extend the original deadline while the final route is checked', async () => {
    const s = fixture();
    let clock: jest.SpyInstance | undefined;
    try {
      await expect(
        s.service.authorize({
          ...s.input,
          beforeFinalAuthority: async () => {
            clock = jest
              .spyOn(Date, 'now')
              .mockReturnValue(s.input.reasons[0]!.metadata.requiredSubscriptionDeadlineAtMs);
          },
        }),
      ).rejects.toMatchObject({ code: 'required_subscription_no_longer_authorized' });
    } finally {
      clock?.mockRestore();
    }
  });
  it('checks all targets fresh through their own routes with at most two concurrent probes', async () => {
    const s = fixture();
    await expect(s.service.authorize(s.input)).resolves.toMatchObject({
      reasonKeys: ['subscription'],
      deadlineAtMs: s.input.reasons[0]!.metadata.requiredSubscriptionDeadlineAtMs,
      reasonDeadlines: [
        {
          reasonKey: 'subscription',
          deadlineAtMs: s.input.reasons[0]!.metadata.requiredSubscriptionDeadlineAtMs,
        },
      ],
    });
    expect(s.membership.getMembershipResolution).toHaveBeenCalledTimes(2);
    expect(s.membership.getMembershipResolution).toHaveBeenCalledWith(
      'target-1',
      'user-1',
      'moderation_required_subscription',
      { forceRefresh: true, allowStaleOnError: false },
    );
  });

  it('preserves each subscription source deadline instead of extending the older reason', async () => {
    const s = fixture();
    const recent = s.input.reasons[0]!;
    const earlier = {
      ...recent,
      reasonKey: 'earlier-subscription',
      metadata: {
        ...recent.metadata,
        requiredSubscriptionSourceAtMs: recent.metadata.requiredSubscriptionSourceAtMs - 60_000,
        requiredSubscriptionDeadlineAtMs: recent.metadata.requiredSubscriptionDeadlineAtMs - 60_000,
      },
    };
    await expect(s.service.authorize({ ...s.input, reasons: [earlier, recent] })).resolves.toEqual({
      reasonKeys: ['earlier-subscription', 'subscription'],
      deadlineAtMs: recent.metadata.requiredSubscriptionDeadlineAtMs,
      reasonDeadlines: [
        {
          reasonKey: 'earlier-subscription',
          deadlineAtMs: earlier.metadata.requiredSubscriptionDeadlineAtMs,
        },
        {
          reasonKey: 'subscription',
          deadlineAtMs: recent.metadata.requiredSubscriptionDeadlineAtMs,
        },
      ],
    });
    expect(s.membership.getMembershipResolution).toHaveBeenCalledTimes(2);
  });
  it.each([
    'joined',
    'disabled',
    'targets',
    'admin',
    'immunity',
    'deadline',
    'changed-during-probe',
  ])('revokes the delete and member sanction after %s', async (change) => {
    const s = fixture();
    if (change === 'joined')
      s.membership.getMembershipResolution.mockResolvedValue({ membership: true, fresh: true });
    if (change === 'disabled') s.settings.requiredSubscriptionEnabled = false;
    if (change === 'targets') s.settings.requiredSubscriptionChannelIds = ['another'];
    if (change === 'admin')
      s.max.getChatMemberAccess.mockResolvedValue({
        userId: 'user-1',
        isAdmin: true,
        isOwner: false,
      });
    if (change === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
    if (change === 'deadline')
      s.input.reasons[0]!.metadata.requiredSubscriptionDeadlineAtMs = Date.now() - 1;
    if (change === 'changed-during-probe')
      s.membership.getMembershipResolution.mockImplementation(async () => {
        s.settings.requiredSubscriptionEnabled = false;
        return { membership: false, fresh: true };
      });
    await expect(s.service.authorize(s.input)).rejects.toMatchObject({
      code: 'required_subscription_no_longer_authorized',
    });
  });
  it('stops on unavailable evidence and terminal targets, without treating them as missing', async () => {
    const s = fixture();
    s.membership.getMembershipResolution.mockResolvedValue({
      membership: null,
      fresh: false,
    } as never);
    await expect(s.service.authorize(s.input)).rejects.toThrow('fresh membership unavailable');
    s.membership.getLookupIssue.mockReturnValue({ kind: 'terminal' });
    await expect(s.service.authorize(s.input)).rejects.toMatchObject({
      code: 'required_subscription_no_longer_authorized',
    });
  });
});
