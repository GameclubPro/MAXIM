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
    shadowOnly: false,
    policy,
  };
  const intent = {
    retentionOwned: true,
    chatId: '-1',
    messageId: 'm1',
    subjectUserId: 'u1',
    reasons: [{ ruleCode: MESSAGE_RETENTION_RULE }],
  };
  const chat = { entityType: 'CHAT' };
  const binding = () => ({
    intentId: 'i1',
    retentionOwned: intent.retentionOwned,
    chatId: intent.chatId,
    messageId: intent.messageId,
    subjectUserId: intent.subjectUserId,
    reasonCount: intent.reasons.length,
    retentionReasonCount: intent.reasons.filter(
      (reason) => reason.ruleCode === MESSAGE_RETENTION_RULE,
    ).length,
    candidateMessageId: candidate.messageId,
    candidateIntentId: candidate.intentId,
    authorId: candidate.authorId,
    activationId: candidate.activationId,
    sourceAt: candidate.sourceAt,
    status: candidate.status,
    shadowOnly: candidate.shadowOnly,
    enabled: policy.enabled,
    policyActivationId: policy.activationId,
    hours: policy.hours,
    revision: policy.revision,
    entityType: chat.entityType,
  });
  const prisma = {
    $queryRaw: jest.fn().mockImplementation(async () => [binding()]),
    messageRetentionCandidate: {
      findMany: jest.fn().mockResolvedValue([]),
    },
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
  return { guard, policy, candidate, intent, chat, binding, prisma, max, store, governor };
}

describe('retention destructive boundary', () => {
  afterEach(() => jest.useRealTimers());
  it('never makes remote reads after the delete transport slot has been reserved', async () => {
    jest.useFakeTimers();
    const { guard, max } = setup();
    await expect(guard.assertAllowed('i1', 'bot', 'dispatch')).rejects.toMatchObject({
      disposition: 'retry',
    });
    expect(max.getChatMembersAccess).not.toHaveBeenCalled();
    await guard.assertAllowed('i1', 'bot', 'prepare');
    await guard.assertAllowed('i1', 'bot', 'dispatch');
    jest.advanceTimersByTime(5_001);
    await expect(guard.assertAllowed('i1', 'bot', 'dispatch')).rejects.toMatchObject({
      disposition: 'retry',
    });
    expect(max.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(max.getPinnedMessageId).toHaveBeenCalledTimes(1);
  });
  it('does not reuse an expired allowed author after an empty refresh', async () => {
    jest.useFakeTimers();
    const { guard, max } = setup();
    await guard.assertAllowed('i1', 'bot');
    jest.advanceTimersByTime(30_001);
    max.getChatMembersAccess.mockResolvedValue(new Map());
    await expect(guard.assertAllowed('i1', 'bot')).rejects.toMatchObject({ disposition: 'retry' });
    expect(max.getPinnedMessageId).toHaveBeenCalledTimes(1);
  });
  it('rejects a pin response that consumed its freshness window', async () => {
    jest.useFakeTimers();
    const { guard, max } = setup();
    max.getPinnedMessageId.mockImplementation(async () => {
      jest.advanceTimersByTime(5_001);
      return null;
    });
    await expect(guard.assertAllowed('i1', 'bot')).rejects.toMatchObject({ disposition: 'retry' });
  });
  it('batches upcoming author checks using a bounded local lookup', async () => {
    const { guard, max, prisma } = setup();
    prisma.messageRetentionCandidate.findMany.mockResolvedValue([
      { authorId: 'u2' },
      { authorId: 'u1' },
    ]);
    await guard.assertAllowed('i1', 'bot');
    expect(max.getChatMembersAccess).toHaveBeenCalledWith('-1', ['u1', 'u2'], expect.any(Object));
    expect(prisma.messageRetentionCandidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 4 }),
    );
  });
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
      const { guard, policy, max, chat } = setup();
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
      if (scenario === 'channel') chat.entityType = 'CHANNEL';
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
  it('reads one coherent exact binding on both sides of remote preparation', async () => {
    const { guard, prisma } = setup();
    await guard.assertAllowed('i1', 'bot');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    const query = prisma.$queryRaw.mock.calls[0]![0];
    expect(query.values).toEqual([MESSAGE_RETENTION_RULE, 'i1']);
    expect(query.text).toContain('candidate."chat_id" = intent."chat_id"');
    expect(query.text).toContain('candidate."message_id" = intent."message_id"');
    expect(query.text).toContain('policy."chat_id" = candidate."chat_id"');
    expect(query.text).toContain('chat."id" = intent."chat_id"');
    expect(query.text).toContain('WHERE "intent_id" = intent."id" LIMIT 2');
  });
  it.each([
    { mutation: { retentionOwned: false }, disposition: 'retry', reasonCode: 'ownership_changed' },
    { mutation: { reasonCount: 2 }, disposition: 'retry', reasonCode: 'ownership_changed' },
    {
      mutation: { retentionReasonCount: 0 },
      disposition: 'retry',
      reasonCode: 'ownership_changed',
    },
    {
      mutation: { candidateMessageId: null },
      disposition: 'skip',
      reasonCode: 'candidate_inactive',
    },
    {
      mutation: { candidateMessageId: 'other' },
      disposition: 'skip',
      reasonCode: 'candidate_inactive',
    },
    {
      mutation: { candidateIntentId: 'other' },
      disposition: 'skip',
      reasonCode: 'candidate_inactive',
    },
    { mutation: { shadowOnly: true }, disposition: 'skip', reasonCode: 'candidate_inactive' },
    { mutation: { status: 'cancelled' }, disposition: 'skip', reasonCode: 'candidate_inactive' },
    { mutation: { hours: 0 }, disposition: 'retry', reasonCode: 'policy_changed' },
    { mutation: { revision: null }, disposition: 'retry', reasonCode: 'policy_changed' },
    { mutation: { entityType: null }, disposition: 'skip', reasonCode: 'entity_ineligible' },
  ])('rejects invalid binding $mutation', async ({ mutation, disposition, reasonCode }) => {
    const { guard, prisma, binding, max } = setup();
    prisma.$queryRaw.mockResolvedValue([{ ...binding(), ...mutation }]);
    await expect(guard.assertAllowed('i1', 'bot')).rejects.toMatchObject({
      disposition,
      reasonCode,
    });
    expect(max.getChatMembersAccess).not.toHaveBeenCalled();
    expect(max.getPinnedMessageId).not.toHaveBeenCalled();
  });
  it.each(['ownership', 'identity', 'revision', 'entity'])(
    'fences a concurrent %s change after remote verification',
    async (change) => {
      const { guard, max, intent, candidate, policy, chat } = setup();
      max.getPinnedMessageId.mockImplementation(async () => {
        if (change === 'ownership') intent.retentionOwned = false;
        if (change === 'identity') {
          intent.subjectUserId = 'u2';
          candidate.authorId = 'u2';
        }
        if (change === 'revision') policy.revision++;
        if (change === 'entity') chat.entityType = 'CHANNEL';
        return null;
      });
      await expect(guard.assertAllowed('i1', 'bot')).rejects.toMatchObject({
        reasonCode:
          change === 'ownership'
            ? 'ownership_changed'
            : change === 'identity'
              ? 'identity_changed'
              : change === 'revision'
                ? 'policy_changed'
                : 'entity_ineligible',
      });
    },
  );
  it.each([
    { isAdmin: undefined, isOwner: false, isBot: false },
    { isAdmin: false, isOwner: undefined, isBot: false },
    { isAdmin: false, isOwner: false, isBot: null },
    { isAdmin: 'false', isOwner: false, isBot: false },
  ])('defers malformed or unknown fresh author access %s', async (access) => {
    const { guard, max } = setup();
    max.getChatMembersAccess.mockResolvedValue(
      new Map([['u1', { userId: 'u1', ...access }]]) as never,
    );
    await expect(guard.assertAllowed('i1', 'bot')).rejects.toMatchObject({
      disposition: 'retry',
      reasonCode: 'author_unknown',
    });
    expect(max.getPinnedMessageId).not.toHaveBeenCalled();
  });
  it('does not reinterpret MAX 404 as absence of a pin', async () => {
    const { guard, max } = setup();
    max.getPinnedMessageId.mockRejectedValue({ response: { status: 404 } });
    await expect(guard.assertAllowed('i1', 'bot')).rejects.toMatchObject({
      response: { status: 404 },
    });
  });
});
