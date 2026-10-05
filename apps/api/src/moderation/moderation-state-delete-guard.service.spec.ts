import { ConfigService } from '@nestjs/config';
import { ModerationStateDeleteGuardService } from './moderation-state-delete-guard.service';

function fixture(rule = 'MUTE_ACTIVE_DELETE') {
  const at = new Date();
  const settings = {
    nightModeTimezone: 'UTC',
    muteDurationHours: 1,
    deleteSpammersEnabled: true,
    removeBotsFromGroupEnabled: true,
    chat: { entityType: 'CHAT', admins: [] as { userId: string }[] },
  };
  const event = {
    id: 'mute-1',
    action: 'MUTE',
    createdAt: at,
    metadata: { muteExpiresAt: new Date(at.getTime() + 60_000).toISOString() },
  };
  const input = {
    chatId: '-123',
    messageId: 'm1',
    subjectUserId: 'user-1',
    botId: 'peer-2',
    reasons: [{ ruleCode: rule, reasonKey: 'state', metadata: { muteEventId: 'mute-1' } }],
  };
  const prisma = {
    chatSettings: { findUnique: jest.fn(async () => settings) },
    moderationEvent: { findFirst: jest.fn(async () => event) },
    adminGlobalSpammerExemption: { findMany: jest.fn(async () => [] as { decision: string }[]) },
    moderationDeleteIntent: { findUnique: jest.fn(async () => null as unknown) },
    moderationDeleteIntentReason: { findUnique: jest.fn(async () => null as unknown) },
  };
  const max = {
    getChatMemberAccess: jest.fn(async () => ({
      userId: 'user-1',
      isAdmin: false,
      isOwner: false,
    })),
    getExactMessageRow: jest.fn(
      async () =>
        ({
          sender: { user_id: 'user-1', is_bot: true },
          recipient: { chat_id: '-123', chat_type: 'chat' },
          timestamp: at.getTime(),
          body: { mid: 'm1', text: 'hello' },
        }) as unknown,
    ),
  };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const bots = { isKnownBotUserId: jest.fn(() => false) };
  const fence = { isSanctionEventInvalidated: jest.fn(async () => false) };
  const policy = {
    evaluatePolicy: jest.fn(async () => ({
      action: 'DELETE_AND_KICK',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
  };
  const service = new ModerationStateDeleteGuardService(
    prisma as never,
    max as never,
    bots as never,
    immunity as never,
    fence as never,
    policy as never,
    new ConfigService(),
  );
  return { service, input, settings, prisma, max, immunity, bots, fence, event, policy, at };
}

describe('current moderation state delete authorization', () => {
  it('verifies the exact durable mute identity and current fence', async () => {
    const s = fixture();
    await expect(s.service.authorize(s.input)).resolves.toMatchObject({ reasonKeys: ['state'] });
    expect(s.fence.isSanctionEventInvalidated).toHaveBeenCalledWith(
      expect.objectContaining({ sanctionEventId: 'mute-1' }),
    );
  });
  it.each(['expired', 'unmuted', 'replaced', 'prepared-release', 'immunity', 'admin'])(
    'cancels a queued mute delete after %s',
    async (change) => {
      const s = fixture();
      if (change === 'expired')
        s.event.metadata.muteExpiresAt = new Date(Date.now() - 1).toISOString();
      if (change === 'unmuted') s.event.action = 'NONE';
      if (change === 'replaced') s.event.id = 'mute-new';
      if (change === 'prepared-release') s.fence.isSanctionEventInvalidated.mockResolvedValue(true);
      if (change === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
      if (change === 'admin')
        s.max.getChatMemberAccess.mockResolvedValue({
          userId: 'user-1',
          isAdmin: true,
          isOwner: false,
        });
      await expect(s.service.authorize(s.input)).rejects.toMatchObject({
        code: 'moderation_state_delete_no_longer_authorized',
      });
    },
  );
  it('revokes a mute that expires during the final awaited fence read', async () => {
    const s = fixture();
    s.fence.isSanctionEventInvalidated.mockImplementation(async () => {
      s.event.metadata.muteExpiresAt = new Date(Date.now() - 1).toISOString();
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse(s.event.metadata.muteExpiresAt) + 60_001);
      return false;
    });
    try {
      await expect(s.service.authorize(s.input)).rejects.toMatchObject({
        code: 'moderation_state_delete_no_longer_authorized',
      });
    } finally {
      jest.restoreAllMocks();
    }
  });
  it('returns the original absolute mute expiry and yields expired mute to a valid bot policy', async () => {
    const s = fixture();
    const deadlineAtMs = Date.parse(s.event.metadata.muteExpiresAt);
    await expect(s.service.authorize(s.input)).resolves.toMatchObject({ deadlineAtMs });
    s.event.metadata.muteExpiresAt = new Date(Date.now() - 1).toISOString();
    await expect(
      s.service.authorize({
        ...s.input,
        reasons: [
          ...s.input.reasons,
          { ruleCode: 'BOT_ACCOUNT_MESSAGE_DELETE', reasonKey: 'bot', metadata: {} as never },
        ],
      }),
    ).resolves.toMatchObject({ reasonKeys: ['bot'] });
  });
  it('checks active global policy with cache bypass and honors current local ALLOW', async () => {
    const s = fixture('GLOBAL_SPAMMER_MESSAGE_DELETE');
    await expect(s.service.authorize(s.input)).resolves.toMatchObject({ reasonKeys: ['state'] });
    expect(s.policy.evaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        recordDecision: false,
        skipRuntimeProfileWrite: true,
        lookupContext: expect.any(Object),
      }),
    );
    s.prisma.adminGlobalSpammerExemption.findMany.mockResolvedValue([{ decision: 'ALLOW' }]);
    await expect(s.service.authorize(s.input)).rejects.toMatchObject({
      code: 'moderation_state_delete_no_longer_authorized',
    });
  });
  it('expires a spammer member permit during selected executor revalidation', async () => {
    const s = fixture('GLOBAL_SPAMMER_MESSAGE_DELETE');
    const expiresAtMs = Date.now() + 1_000;
    s.policy.evaluatePolicy.mockResolvedValue({
      action: 'DELETE_AND_KICK',
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    const beforeFinalAuthority = jest.fn(async () => {
      jest.spyOn(Date, 'now').mockReturnValue(expiresAtMs);
    });
    try {
      await expect(
        s.service.assertSpammerMemberAllowed({
          chatId: s.input.chatId,
          userId: s.input.subjectUserId,
          messageId: s.input.messageId,
          botId: s.input.botId,
          localBlock: false,
          beforeFinalAuthority,
        }),
      ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
      expect(beforeFinalAuthority).toHaveBeenCalledTimes(1);
    } finally {
      jest.restoreAllMocks();
    }
  });
  it('propagates selected executor demotion before the final bot-account permit', async () => {
    const s = fixture('BOT_ACCOUNT_MESSAGE_DELETE');
    const demoted = new Error('Selected executor is no longer capable');
    const beforeFinalAuthority = jest.fn(async () => {
      throw demoted;
    });
    await expect(s.service.authorize({ ...s.input, beforeFinalAuthority })).rejects.toBe(demoted);
    expect(beforeFinalAuthority).toHaveBeenCalledTimes(1);
  });
  it('rejects a bot-account setting changed while revalidating the selected executor', async () => {
    const s = fixture('BOT_ACCOUNT_MESSAGE_DELETE');
    s.prisma.chatSettings.findUnique.mockImplementation(async () => structuredClone(s.settings));
    await expect(
      s.service.authorize({
        ...s.input,
        beforeFinalAuthority: async () => {
          s.settings.removeBotsFromGroupEnabled = false;
        },
      }),
    ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
  });
  it('revokes a local BLOCK when it changes to ALLOW', async () => {
    const s = fixture('LOCAL_ADMIN_BLOCK_MESSAGE_DELETE');
    s.prisma.adminGlobalSpammerExemption.findMany.mockResolvedValue([{ decision: 'BLOCK' }]);
    await expect(s.service.authorize(s.input)).resolves.toMatchObject({ reasonKeys: ['state'] });
    s.prisma.adminGlobalSpammerExemption.findMany.mockResolvedValue([{ decision: 'ALLOW' }]);
    await expect(s.service.authorize(s.input)).rejects.toMatchObject({
      code: 'moderation_state_delete_no_longer_authorized',
    });
  });
  it('protects newly configured runtime bot accounts and rejects retired invitation work', async () => {
    const s = fixture('BOT_ACCOUNT_MESSAGE_DELETE');
    await expect(s.service.authorize(s.input)).resolves.toMatchObject({ reasonKeys: ['state'] });
    s.bots.isKnownBotUserId.mockReturnValue(true);
    await expect(s.service.authorize(s.input)).rejects.toMatchObject({
      code: 'moderation_state_delete_no_longer_authorized',
    });
    s.bots.isKnownBotUserId.mockReturnValue(false);
    await expect(
      s.service.authorize({
        ...s.input,
        reasons: [{ ...s.input.reasons[0]!, ruleCode: 'INVITATION_ACCESS_DELETE' }],
      }),
    ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
  });
  it('permits absent-source bot KICK only after its own verified durable bot-author receipt', async () => {
    const s = fixture('BOT_ACCOUNT_MESSAGE_DELETE');
    s.max.getExactMessageRow.mockResolvedValue(null);
    await expect(
      s.service.authorize({
        ...s.input,
        allowAbsentWithOwnedReceipt: true,
        sourceMessageAt: s.at,
      }),
    ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
    s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue({
      id: 'intent-1',
      status: 'SUCCEEDED',
      subjectUserId: s.input.subjectUserId,
      sourceMessageAt: s.at,
    });
    s.prisma.moderationDeleteIntentReason.findUnique.mockResolvedValue({
      ruleCode: 'BOT_ACCOUNT_MESSAGE_DELETE',
      userId: s.input.subjectUserId,
      metadata: { moderationDeleteVerified: true, botAccountAuthorVerified: true },
    });
    await expect(
      s.service.authorize({
        ...s.input,
        allowAbsentWithOwnedReceipt: true,
        sourceMessageAt: s.at,
      }),
    ).resolves.toMatchObject({ reasonKeys: ['state'] });
    expect(s.prisma.moderationDeleteIntentReason.findUnique).toHaveBeenCalledWith({
      where: { intentId_reasonKey: { intentId: 'intent-1', reasonKey: 'state' } },
      select: { ruleCode: true, userId: true, metadata: true },
    });
    s.settings.removeBotsFromGroupEnabled = false;
    await expect(
      s.service.authorize({
        ...s.input,
        allowAbsentWithOwnedReceipt: true,
        sourceMessageAt: s.at,
      }),
    ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
  });
  it.each(['pending', 'foreign-author', 'different-source', 'unverified-reason', 'foreign-reason'])(
    'rejects an absent-source follow-up with %s evidence',
    async (change) => {
      const s = fixture('BOT_ACCOUNT_MESSAGE_DELETE');
      s.max.getExactMessageRow.mockResolvedValue(null);
      s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        status: change === 'pending' ? 'PENDING' : 'SUCCEEDED',
        subjectUserId: change === 'foreign-author' ? 'other-user' : s.input.subjectUserId,
        sourceMessageAt: change === 'different-source' ? new Date(s.at.getTime() - 1) : s.at,
      });
      s.prisma.moderationDeleteIntentReason.findUnique.mockResolvedValue({
        ruleCode: 'BOT_ACCOUNT_MESSAGE_DELETE',
        userId: change === 'foreign-reason' ? 'other-user' : s.input.subjectUserId,
        metadata: {
          moderationDeleteVerified: change !== 'unverified-reason',
          botAccountAuthorVerified: true,
        },
      });
      await expect(
        s.service.authorize({
          ...s.input,
          allowAbsentWithOwnedReceipt: true,
          sourceMessageAt: s.at,
        }),
      ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
    },
  );
});
