import {
  buildParticipantModerationImmunityClaimKey,
  buildParticipantModerationImmunityMessageKey,
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
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-01T09:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());
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
        dedupeKey: buildParticipantModerationImmunityMessageKey({
          ...input,
          dateKey: '2026-10-01',
        }),
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
    const harness = buildHarness({ transactionClaim: existing, consumedRows: [{ granted: 1 }] });

    await expect(harness.service.consumeForMessage(input)).resolves.toBe('granted');

    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(harness.tx.$queryRaw.mock.calls[0]![0].strings.join('?')).not.toContain('UPDATE');
    expect(harness.tx.moderationViolationMessageClaim.create).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'expired', 're-created'])(
    'revokes a prior receipt when current grant is %s',
    async () => {
      const h = buildHarness({ transactionClaim: expectedClaim(), consumedRows: [] });
      await expect(h.service.consumeForMessage(input)).resolves.toBe('not_granted');
      expect(h.tx.moderationViolationMessageClaim.create).not.toHaveBeenCalled();
    },
  );

  it('uses one receipt across rule, OCR and edit while preserving the day boundary', async () => {
    const h = buildHarness({
      transactionClaim: expectedClaim(),
      consumedRows: [{ granted: 1 }],
      currentRows: [{ granted: 1 }],
    });
    await expect(h.service.consumeForMessage({ ...input, scope: 'text' })).resolves.toBe('granted');
    await expect(h.service.consumeForMessage({ ...input, scope: 'image' })).resolves.toBe(
      'granted',
    );
    expect(h.tx.moderationViolationMessageClaim.findUnique.mock.calls[0]![0]).toEqual(
      h.tx.moderationViolationMessageClaim.findUnique.mock.calls[1]![0],
    );
    expect(
      buildParticipantModerationImmunityMessageKey({ ...input, dateKey: '2026-10-02' }),
    ).not.toBe(expectedClaim().dedupeKey);
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
      currentRows: [{ granted: 1 }],
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
      currentRows: [{ granted: 1 }],
    });

    await expect(harness.service.consumeForMessage(input)).resolves.toBe('granted');

    expect(harness.prisma.moderationViolationMessageClaim.findUnique).toHaveBeenCalledWith({
      where: {
        dedupeKey: buildParticipantModerationImmunityMessageKey({
          ...input,
          dateKey: '2026-10-01',
        }),
      },
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
    dedupeKey: buildParticipantModerationImmunityMessageKey({ ...input, dateKey: '2026-10-01' }),
    messageActionKey: null,
    chatId: input.chatId,
    userId: input.userId,
    messageId: input.messageId,
    ruleCode: PARTICIPANT_MODERATION_IMMUNITY_RULE_CODE,
    updateType: PARTICIPANT_MODERATION_IMMUNITY_UPDATE_TYPE,
    createdAt: new Date('2026-10-01T08:59:00Z'),
  };
}

function buildHarness(
  options: {
    consumedRows?: Array<{ granted: number }>;
    transactionClaim?: ReturnType<typeof expectedClaim> | null;
    transactionClaims?: Array<ReturnType<typeof expectedClaim> | null>;
    reconciledClaim?: ReturnType<typeof expectedClaim> | null;
    createError?: Error;
    currentRows?: Array<{ granted: number }>;
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
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce(options.consumedRows ?? [])
      .mockResolvedValue(options.currentRows ?? []),
  };
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(options.currentRows ?? []),
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
