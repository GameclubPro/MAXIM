import { ConfigService } from '@nestjs/config';
import { fingerprintModerationSettings } from './message-limits-delete-guard.service';
import { ModerationRuleSanctionGuardService } from './moderation-rule-sanction-guard.service';

function fixture() {
  const sourceAt = new Date(Date.now() - 1_000);
  const settings = {
    maxMessageLengthEnabled: true,
    maxMessageLength: 10,
    messageLimitsBanEnabled: true,
    nightModeTimezone: 'UTC',
    chat: { entityType: 'CHAT', admins: [] as unknown[] },
  };
  const input = {
    chatId: '-123',
    messageId: 'm1',
    userId: 'user-1',
    botId: 'peer-2',
    reasonKey: 'length',
    ruleCode: 'MESSAGE_TOO_LONG_DELETE',
    policySha256: fingerprintModerationSettings(settings, 'MESSAGE_TOO_LONG'),
    deadlineAtMs: sourceAt.getTime() + 300_000,
  };
  const prisma = {
    chatSettings: { findUnique: jest.fn(async () => settings) },
    moderationDeleteIntent: {
      findUnique: jest.fn(
        async () =>
          ({
            id: 'intent-1',
            status: 'SUCCEEDED',
            subjectUserId: 'user-1',
            sourceMessageAt: sourceAt,
          }) as unknown,
      ),
    },
    moderationDeleteIntentReason: {
      findUnique: jest.fn(
        async () =>
          ({
            ruleCode: 'MESSAGE_TOO_LONG_DELETE',
            userId: 'user-1',
            metadata: { moderationDeleteVerified: true },
          }) as unknown,
      ),
    },
  };
  const max = {
    getChatMemberAccess: jest.fn(async () => ({
      userId: 'user-1',
      isAdmin: false,
      isOwner: false,
    })),
  };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const service = new ModerationRuleSanctionGuardService(
    prisma as never,
    max as never,
    { isKnownBotUserId: () => false } as never,
    immunity as never,
    new ConfigService(),
  );
  return { service, settings, input, prisma, max, immunity };
}
describe('own-rule sanction authorization', () => {
  it('requires exact verified reason receipt and current selected-peer author access', async () => {
    const s = fixture();
    await expect(s.service.assertAllowed(s.input)).resolves.toBeUndefined();
    expect(s.prisma.moderationDeleteIntent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId_messageId: { chatId: '-123', messageId: 'm1' } },
        select: { id: true, status: true, subjectUserId: true, sourceMessageAt: true },
      }),
    );
    expect(s.prisma.moderationDeleteIntentReason.findUnique).toHaveBeenCalledWith({
      where: { intentId_reasonKey: { intentId: 'intent-1', reasonKey: 'length' } },
      select: { ruleCode: true, userId: true, metadata: true },
    });
    expect(s.max.getChatMemberAccess).toHaveBeenCalledWith(
      '-123',
      'user-1',
      expect.objectContaining({ botId: 'peer-2', bypassCache: true }),
    );
  });
  it.each([
    'independent-delete',
    'foreign-reason',
    'unverified-reason',
    'extended-deadline',
    'policy-off',
    'raised',
    'sanction-off',
    'admin',
    'immunity',
    'expired',
  ])('prevents stale strike or member mutation after %s', async (change) => {
    const s = fixture();
    if (change === 'independent-delete')
      s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(null);
    if (change === 'foreign-reason')
      s.prisma.moderationDeleteIntentReason.findUnique.mockResolvedValue({
        ruleCode: 'PHONE_NUMBER_BLOCKED_DELETE',
        userId: 'user-1',
        metadata: { moderationDeleteVerified: true },
      });
    if (change === 'unverified-reason')
      s.prisma.moderationDeleteIntentReason.findUnique.mockResolvedValue({
        ruleCode: 'MESSAGE_TOO_LONG_DELETE',
        userId: 'user-1',
        metadata: {},
      });
    if (change === 'extended-deadline') s.input.deadlineAtMs += 1;
    if (change === 'policy-off') s.settings.maxMessageLengthEnabled = false;
    if (change === 'raised') s.settings.maxMessageLength = 100;
    if (change === 'sanction-off') s.settings.messageLimitsBanEnabled = false;
    if (change === 'admin')
      s.max.getChatMemberAccess.mockResolvedValue({
        userId: 'user-1',
        isAdmin: true,
        isOwner: false,
      });
    if (change === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
    if (change === 'expired') s.input.deadlineAtMs = Date.now() - 1;
    await expect(s.service.assertAllowed(s.input)).rejects.toMatchObject({
      code: 'moderation_rule_sanction_no_longer_authorized',
    });
  });
});
