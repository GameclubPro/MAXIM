import { MessageRetentionDeleteGuard } from './message-retention-delete-guard.service';
import { MESSAGE_RETENTION_RULE } from './message-retention.policy';

function setup() {
  const policy = { enabled: true, activationId: 'a', hours: 24, revision: 1 };
  const candidate = {
    chatId: '-1',
    messageId: 'm1',
    authorId: 'u1',
    activationId: 'a',
    intentId: 'i1',
    sourceAt: new Date(Date.now() - 25 * 3_600_000),
    status: 'pending',
    policy,
  };
  const intent = {
    retentionOwned: true,
    chatId: '-1',
    messageId: 'm1',
    subjectUserId: 'u1',
    reasons: [{ ruleCode: MESSAGE_RETENTION_RULE }],
  };
  const prisma = {
    moderationDeleteIntent: { findUnique: jest.fn().mockResolvedValue(intent) },
    messageRetentionCandidate: { findUnique: jest.fn().mockResolvedValue(candidate) },
    chat: { findUnique: jest.fn().mockResolvedValue({ entityType: 'CHAT' }) },
  };
  const max = {
    getChatMembersAccess: jest
      .fn()
      .mockResolvedValue(
        new Map([['u1', { userId: 'u1', isAdmin: false, isOwner: false, isBot: false }]]),
      ),
    getPinnedMessageId: jest.fn().mockResolvedValue(null),
  };
  const store = { allows: jest.fn().mockReturnValue(true) };
  const governor = { decide: jest.fn().mockResolvedValue({ action: 'run' }) };
  const guard = new MessageRetentionDeleteGuard(
    prisma as never,
    store as never,
    max as never,
    { isKnownBotUserId: () => false } as never,
    governor as never,
  );
  return { guard, policy, candidate, intent, prisma, max, store, governor };
}

describe('retention destructive boundary', () => {
  it('accepts verified old human messages and shares bounded remote snapshots', async () => {
    const { guard, max } = setup();
    await guard.assertAllowed('i1', 'bot');
    await guard.assertAllowed('i1', 'bot');
    expect(max.getPinnedMessageId).toHaveBeenCalledTimes(1);
    expect(max.getChatMembersAccess).toHaveBeenCalledWith(
      '-1',
      ['u1'],
      expect.objectContaining({
        trafficClass: 'background',
        sourceTag: 'message_retention',
        bypassCache: true,
      }),
    );
  });
  it('blocks a longer new retention period', async () => {
    const { guard, policy, max } = setup();
    policy.hours = 48;
    await expect(guard.assertAllowed('i1', 'bot')).rejects.toMatchObject({ disposition: 'retry' });
    expect(max.getPinnedMessageId).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'activation', 'pinned', 'admin', 'owner', 'bot', 'channel'])(
    'protects %s',
    async (scenario) => {
      const { guard, policy, max, prisma } = setup();
      if (scenario === 'disabled') policy.enabled = false;
      if (scenario === 'activation') policy.activationId = 'b';
      if (scenario === 'pinned') max.getPinnedMessageId.mockResolvedValue('m1');
      if (['admin', 'owner', 'bot'].includes(scenario))
        max.getChatMembersAccess.mockResolvedValue(
          new Map([
            [
              'u1',
              {
                userId: 'u1',
                isAdmin: scenario === 'admin',
                isOwner: scenario === 'owner',
                isBot: scenario === 'bot',
              },
            ],
          ]),
        );
      if (scenario === 'channel')
        prisma.chat.findUnique.mockResolvedValue({ entityType: 'CHANNEL' });
      await expect(guard.assertAllowed('i1', 'bot')).rejects.toMatchObject({ disposition: 'skip' });
    },
  );
  it('defers unknown author access, overload and changed intent ownership', async () => {
    const a = setup();
    a.max.getChatMembersAccess.mockResolvedValue(new Map());
    await expect(a.guard.assertAllowed('i1', 'bot')).rejects.toMatchObject({
      disposition: 'retry',
    });
    const b = setup();
    b.governor.decide.mockResolvedValue({ action: 'pause' });
    await expect(b.guard.assertAllowed('i1', 'bot')).rejects.toMatchObject({
      disposition: 'retry',
    });
    expect(b.max.getChatMembersAccess).not.toHaveBeenCalled();
    const c = setup();
    c.intent.retentionOwned = false;
    await expect(c.guard.assertAllowed('i1', 'bot')).rejects.toMatchObject({
      disposition: 'retry',
    });
  });
  it('rechecks policy after MAX returns', async () => {
    const { guard, policy, max } = setup();
    max.getPinnedMessageId.mockImplementation(async () => {
      policy.enabled = false;
      return null;
    });
    await expect(guard.assertAllowed('i1', 'bot')).rejects.toMatchObject({ disposition: 'skip' });
  });
  it('does not reinterpret MAX 404 as absence of a pin', async () => {
    const { guard, max } = setup();
    max.getPinnedMessageId.mockRejectedValue({ response: { status: 404 } });
    await expect(guard.assertAllowed('i1', 'bot')).rejects.toMatchObject({
      response: { status: 404 },
    });
  });
});
