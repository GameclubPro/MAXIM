import {
  assertManualGroupCommandSuccessNoticeAuthority,
  ManualGroupCommandNoticeAuthorityRejectedError,
} from './admin-manual-group-command-notice-authority';

function setup() {
  const now = Date.now();
  const input = {
    operationKey: 'notice-key',
    lockToken: 'lease',
    jobId: 'job',
    chatId: 'chat',
    actorUserId: 'admin',
    targetUserId: 'user',
    commandMessageId: 'command',
    action: 'MUTE' as const,
    textHash: 'hash',
    issuedAtMs: now - 1_000,
  };
  const notice = {
    ...input,
    rootIntentKey: null,
    sourceKind: 'manual_group_moderation_command',
    operation: 'COMMAND_NOTICE_OUTCOME',
    sourceChatId: 'chat',
    targetChatId: 'chat',
    logicalAction: 'NOTICE',
    status: 'AMBIGUOUS',
    createdAt: new Date(now),
    metadata: {
      outcome: 'SUCCESS',
      action: 'MUTE',
      commandMessageId: 'command',
      textHash: 'hash',
      issuedAtMs: input.issuedAtMs,
    },
  };
  const source = { moderationEventId: 'event', createdAt: new Date(now - 500) };
  const event = {
    id: 'event',
    chatId: 'chat',
    userId: 'user',
    action: 'MUTE',
    ruleCode: 'MANUAL_MUTE',
    operator: 'ADMIN',
    metadata: { source: 'group_command' },
    createdAt: new Date(now - 500),
  };
  const prisma = {
    manualModerationFanoutLedgerEntry: {
      findUnique: jest.fn().mockResolvedValue(notice),
      findFirst: jest.fn().mockResolvedValue(source),
    },
    moderationEvent: {
      findUnique: jest.fn().mockResolvedValue(event),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const access = { userId: 'admin', isAdmin: true, isOwner: false, permissions: [] };
  const max = {
    getCurrentChatMemberAccess: jest.fn().mockResolvedValue({ ...access, userId: 'bot' }),
    getChatMemberAccess: jest.fn().mockResolvedValue(access),
  };
  return {
    input,
    notice,
    source,
    event,
    prisma,
    max,
    run: () => assertManualGroupCommandSuccessNoticeAuthority(prisma as never, max, input),
  };
}

describe('manual administrator command success notice authority', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses fresh selected-context bot and exact author access, then bounded durable reads', async () => {
    const s = setup();
    await expect(s.run()).resolves.toBeUndefined();
    expect(s.max.getCurrentChatMemberAccess).toHaveBeenCalledWith('chat', {
      bypassCache: true,
      trafficClass: 'interactive',
    });
    expect(s.max.getChatMemberAccess).toHaveBeenCalledWith('chat', 'admin', {
      bypassCache: true,
      trafficClass: 'interactive',
    });
    expect(s.prisma.manualModerationFanoutLedgerEntry.findUnique).toHaveBeenCalledWith({
      where: { operationKey: 'notice-key' },
    });
    expect(s.prisma.manualModerationFanoutLedgerEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          rootIntentKey: 'job',
          operation: 'COMMAND_SOURCE_MUTE',
          status: 'SUCCEEDED',
          actorUserId: 'admin',
          targetUserId: 'user',
        }),
      }),
    );
    expect(s.prisma.moderationEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId: 'chat',
          userId: 'user',
          ruleCode: 'MANUAL_UNMUTE',
          createdAt: { gte: s.event.createdAt },
        },
        select: { id: true },
      }),
    );
  });

  it.each(['bot', 'author'])('rejects a demoted %s', async (subject) => {
    const s = setup();
    const read = subject === 'bot' ? s.max.getCurrentChatMemberAccess : s.max.getChatMemberAccess;
    read.mockResolvedValue({
      userId: subject === 'bot' ? 'bot' : 'admin',
      isAdmin: false,
      isOwner: false,
      permissions: [],
    });
    await expect(s.run()).rejects.toBeInstanceOf(ManualGroupCommandNoticeAuthorityRejectedError);
    expect(s.prisma.manualModerationFanoutLedgerEntry.findUnique).not.toHaveBeenCalled();
  });

  it('rejects another user returned by the MAX author lookup', async () => {
    const s = setup();
    s.max.getChatMemberAccess.mockResolvedValue({ userId: 'other', isAdmin: true });
    await expect(s.run()).rejects.toBeInstanceOf(ManualGroupCommandNoticeAuthorityRejectedError);
  });

  it.each([
    ['lockToken', 'lost-lease'],
    ['status', 'SUCCEEDED'],
    ['jobId', 'other-job'],
    ['sourceChatId', 'other-chat'],
    ['targetChatId', 'other-chat'],
    ['actorUserId', 'other-actor'],
    ['targetUserId', 'other-user'],
    ['operation', 'COMMAND_SOURCE_MUTE'],
    ['logicalAction', 'MUTE'],
    ['rootIntentKey', 'other-root'],
    ['sourceKind', 'private_command'],
  ])('rejects a changed durable notice %s', async (field, value) => {
    const s = setup();
    s.prisma.manualModerationFanoutLedgerEntry.findUnique.mockResolvedValue({
      ...s.notice,
      [field]: value,
    });
    await expect(s.run()).rejects.toBeInstanceOf(ManualGroupCommandNoticeAuthorityRejectedError);
    expect(s.prisma.manualModerationFanoutLedgerEntry.findFirst).not.toHaveBeenCalled();
  });

  it.each(['outcome', 'action', 'commandMessageId', 'textHash', 'issuedAtMs'])(
    'rejects a changed notice payload %s',
    async (field) => {
      const s = setup();
      s.prisma.manualModerationFanoutLedgerEntry.findUnique.mockResolvedValue({
        ...s.notice,
        metadata: { ...s.notice.metadata, [field]: 'changed' },
      });
      await expect(s.run()).rejects.toBeInstanceOf(ManualGroupCommandNoticeAuthorityRejectedError);
    },
  );

  it('requires a succeeded explicit source journal with a recorded effect', async () => {
    const s = setup();
    s.prisma.manualModerationFanoutLedgerEntry.findFirst.mockResolvedValue(null);
    await expect(s.run()).rejects.toBeInstanceOf(ManualGroupCommandNoticeAuthorityRejectedError);
    expect(s.prisma.moderationEvent.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['chatId', 'other-chat'],
    ['userId', 'other-user'],
    ['action', 'BAN'],
    ['ruleCode', 'AUTO_MUTE'],
    ['operator', 'BOT'],
    ['metadata', { source: 'miniapp' }],
  ])('rejects a mismatched original effect %s', async (field, value) => {
    const s = setup();
    s.prisma.moderationEvent.findUnique.mockResolvedValue({ ...s.event, [field]: value });
    await expect(s.run()).rejects.toBeInstanceOf(ManualGroupCommandNoticeAuthorityRejectedError);
  });

  it('revokes a success notice when the sanction was manually released', async () => {
    const s = setup();
    s.prisma.moderationEvent.findFirst.mockResolvedValue({ id: 'release' });
    await expect(s.run()).rejects.toBeInstanceOf(ManualGroupCommandNoticeAuthorityRejectedError);
  });

  it('does not refresh the original deadline after final SQL interleaving', async () => {
    const s = setup();
    s.prisma.moderationEvent.findFirst.mockImplementation(async () => {
      jest.spyOn(Date, 'now').mockReturnValue(s.input.issuedAtMs + 5 * 60 * 1_000);
      return null;
    });
    await expect(s.run()).rejects.toBeInstanceOf(ManualGroupCommandNoticeAuthorityRejectedError);
  });

  it('does not mask a transient authority read failure as public success', async () => {
    const s = setup();
    const error = new Error('MAX unavailable');
    s.max.getCurrentChatMemberAccess.mockRejectedValue(error);
    await expect(s.run()).rejects.toBe(error);
  });
});
