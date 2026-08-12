import {
  buildParticipantModerationImmunityClaimKey,
  PARTICIPANT_MODERATION_IMMUNITY_RULE_CODE,
  PARTICIPANT_MODERATION_IMMUNITY_UPDATE_TYPE,
  ParticipantModerationImmunityService,
} from './participant-moderation-immunity.service';

const input = {
  chatId: 'chat-1',
  userId: 'user-1',
  messageId: 'message-1',
  scope: 'commercial_ocr_delete',
  nightModeTimezone: 'Europe/Moscow',
};

describe('ParticipantModerationImmunityService', () => {
  it('builds a deterministic scope-sensitive claim key', () => {
    expect(buildParticipantModerationImmunityClaimKey(input)).toBe(
      buildParticipantModerationImmunityClaimKey({ ...input }),
    );
    expect(buildParticipantModerationImmunityClaimKey(input)).not.toBe(
      buildParticipantModerationImmunityClaimKey({ ...input, scope: 'another_scope' }),
    );
  });

  it('atomically consumes limited immunity and records the positive claim', async () => {
    const harness = buildHarness({ consumedRows: [{ granted: 1 }] });

    await expect(harness.service.consumeForMessage(input)).resolves.toBe('granted');

    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(harness.tx.moderationViolationMessageClaim.create).toHaveBeenCalledWith({
      data: {
        dedupeKey: buildParticipantModerationImmunityClaimKey(input),
        messageActionKey: null,
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        ruleCode: PARTICIPANT_MODERATION_IMMUNITY_RULE_CODE,
        updateType: PARTICIPANT_MODERATION_IMMUNITY_UPDATE_TYPE,
      },
    });
    const query = harness.tx.$queryRaw.mock.calls[0]![0] as {
      strings?: readonly string[];
      values?: readonly unknown[];
    };
    expect(query.strings?.join('?')).toContain(
      'UPDATE "chat_participant_moderation_immunities" immunity',
    );
    expect(query.values).toEqual(expect.arrayContaining(['chat-1', 'user-1']));
  });

  it('returns a matching positive claim on replay without consuming immunity again', async () => {
    const existing = expectedClaim();
    const harness = buildHarness({ transactionClaim: existing });

    await expect(harness.service.consumeForMessage(input)).resolves.toBe('granted');

    expect(harness.tx.$queryRaw).not.toHaveBeenCalled();
    expect(harness.tx.moderationViolationMessageClaim.create).not.toHaveBeenCalled();
  });

  it('does not persist a negative claim when no immunity can be consumed', async () => {
    const harness = buildHarness({ consumedRows: [] });

    await expect(harness.service.consumeForMessage(input)).resolves.toBe('not_granted');

    expect(harness.tx.moderationViolationMessageClaim.create).not.toHaveBeenCalled();
    expect(harness.prisma.moderationViolationMessageClaim.findUnique).not.toHaveBeenCalled();
  });

  it('recognizes a concurrent claim when the serialized limited update finds no capacity', async () => {
    const harness = buildHarness({
      consumedRows: [],
      transactionClaims: [null, expectedClaim()],
    });

    await expect(harness.service.consumeForMessage(input)).resolves.toBe('granted');

    expect(harness.tx.moderationViolationMessageClaim.findUnique).toHaveBeenCalledTimes(2);
    expect(harness.tx.moderationViolationMessageClaim.create).not.toHaveBeenCalled();
  });

  it('reconciles an exact concurrent claim after the losing transaction rolls back', async () => {
    const conflict = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    const harness = buildHarness({
      consumedRows: [{ granted: 1 }],
      createError: conflict,
      reconciledClaim: expectedClaim(),
    });

    await expect(harness.service.consumeForMessage(input)).resolves.toBe('granted');

    expect(harness.prisma.moderationViolationMessageClaim.findUnique).toHaveBeenCalledWith({
      where: { dedupeKey: buildParticipantModerationImmunityClaimKey(input) },
      select: expect.any(Object),
    });
  });

  it('rejects a conflicting claim that does not own the exact immunity scope', async () => {
    const conflict = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    const harness = buildHarness({
      consumedRows: [{ granted: 1 }],
      createError: conflict,
      reconciledClaim: { ...expectedClaim(), userId: 'other-user' },
    });

    await expect(harness.service.consumeForMessage(input)).rejects.toThrow(
      'Participant moderation immunity claim ownership mismatch',
    );
  });
});

function expectedClaim() {
  return {
    dedupeKey: buildParticipantModerationImmunityClaimKey(input),
    messageActionKey: null,
    chatId: input.chatId,
    userId: input.userId,
    messageId: input.messageId,
    ruleCode: PARTICIPANT_MODERATION_IMMUNITY_RULE_CODE,
    updateType: PARTICIPANT_MODERATION_IMMUNITY_UPDATE_TYPE,
  };
}

function buildHarness(
  options: {
    consumedRows?: Array<{ granted: number }>;
    transactionClaim?: ReturnType<typeof expectedClaim> | null;
    transactionClaims?: Array<ReturnType<typeof expectedClaim> | null>;
    reconciledClaim?: ReturnType<typeof expectedClaim> | null;
    createError?: Error;
  } = {},
) {
  const tx = {
    moderationViolationMessageClaim: {
      findUnique: options.transactionClaims
        ? jest
            .fn()
            .mockResolvedValueOnce(options.transactionClaims[0] ?? null)
            .mockResolvedValueOnce(options.transactionClaims[1] ?? null)
        : jest.fn().mockResolvedValue(options.transactionClaim ?? null),
      create: options.createError
        ? jest.fn().mockRejectedValue(options.createError)
        : jest.fn().mockResolvedValue({}),
    },
    $queryRaw: jest.fn().mockResolvedValue(options.consumedRows ?? []),
  };
  const prisma = {
    moderationViolationMessageClaim: {
      findUnique: jest.fn().mockResolvedValue(options.reconciledClaim ?? null),
    },
    $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
      operation(tx),
    ),
  };
  return {
    service: new ParticipantModerationImmunityService(prisma as never),
    prisma,
    tx,
  };
}
