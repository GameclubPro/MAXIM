import {
  executeRuleFollowupSanction,
  RuleFollowupBanOutcomeUnknownError,
  RuleFollowupSanctionDeferredError,
  type FrozenRuleFollowupSanctionPlan,
  type RuleFollowupSanctionJournal,
  type RuleFollowupSanctionState,
} from './moderation-rule-followup-sanction';

function fixture(action: FrozenRuleFollowupSanctionPlan['action'] = 'BAN') {
  const plan: FrozenRuleFollowupSanctionPlan = {
    action,
    issuedAtMs: Date.now() - 1_000,
    muteExpiresAtMs: action === 'MUTE' ? Date.now() - 1_000 + 3_600_000 : null,
    muteDurationHours: 1,
    eventId: 'immutable-event',
    noticeKey: 'outbox:source:reason:sanction-notice',
  };
  let state: RuleFollowupSanctionState = { phase: 'UNSTARTED' };
  let reputation: 'UNSTARTED' | 'UNKNOWN' | 'DONE' = 'UNSTARTED';
  const events = new Map<string, unknown>();
  const order: string[] = [];
  const journal = {
    id: 'outbox:source:reason',
    assertLease: jest.fn(async () => undefined),
    readState: jest.fn(async () => state),
    beginBan: jest.fn(async () => {
      state = { phase: 'BAN_STARTED' };
      order.push('ban-start');
      return true;
    }),
    confirmBan: jest.fn(async (botId: string | null) => {
      state = { phase: 'BAN_CONFIRMED', banBotId: botId };
    }),
    resetAfterProvenNoEffect: jest.fn(async () => {
      state = { phase: 'UNSTARTED' };
    }),
    markUnknown: jest.fn(async () => {
      state = { phase: 'UNKNOWN' };
    }),
    commitSqlEvent: jest.fn(async (eventId: string) => {
      state = { ...state, phase: 'SQL_COMMITTED', eventId };
    }),
    claimReputation: jest.fn(async (): Promise<'run' | 'done' | 'unknown'> => {
      if (reputation === 'DONE') return 'done';
      if (reputation === 'UNKNOWN') return 'unknown';
      reputation = 'UNKNOWN';
      return 'run';
    }),
    completeReputation: jest.fn(async () => {
      reputation = 'DONE';
    }),
    settle: jest.fn(async () => {
      state = { ...state, phase: 'SETTLED' };
    }),
  } satisfies RuleFollowupSanctionJournal;
  const dependencies = {
    authorize: jest.fn(async () => true),
    ban: jest.fn(async ({ beforeMutation }: { beforeMutation: () => Promise<void> }) => {
      await beforeMutation();
      order.push('ban-http');
      return { kind: 'confirmed' as const, botId: 'surviving-peer' };
    }),
    recoverBanReceipt: jest.fn(async () => ({
      kind: 'confirmed' as const,
      botId: 'surviving-peer',
    })),
    persistDeterministicEvent: jest.fn(async (input: { eventId: string }) => {
      events.set(input.eventId, input);
      return input.eventId;
    }),
    rememberActiveMute: jest.fn(async () => undefined),
    rememberInactiveMute: jest.fn(async () => undefined),
    recordReputation: jest.fn(async () => undefined),
    sendNotice: jest.fn(async () => undefined),
  };
  return {
    plan,
    journal,
    dependencies,
    events,
    order,
    setState: (value: RuleFollowupSanctionState) => {
      state = value;
    },
    getState: () => state,
  };
}

describe('immutable moderation rule follow-up sanction effects', () => {
  it.each([
    { phase: 'UNRECOGNIZED' },
    { phase: 'SQL_COMMITTED', eventId: 'foreign-event' },
    { phase: 'SETTLED' },
  ])('rejects malformed durable phase/receipt without any effect: %o', async (state) => {
    const s = fixture();
    s.setState(state as RuleFollowupSanctionState);
    await expect(executeRuleFollowupSanction(s.plan, s.journal, s.dependencies)).rejects.toThrow(
      'sanction state',
    );
    expect(s.dependencies.authorize).not.toHaveBeenCalled();
    expect(s.dependencies.recoverBanReceipt).not.toHaveBeenCalled();
    expect(s.dependencies.persistDeterministicEvent).not.toHaveBeenCalled();
    expect(s.dependencies.sendNotice).not.toHaveBeenCalled();
  });

  it('cannot adopt a started BAN phase for a different frozen action', async () => {
    const s = fixture('MUTE');
    s.setState({ phase: 'BAN_STARTED' });
    await expect(executeRuleFollowupSanction(s.plan, s.journal, s.dependencies)).rejects.toThrow(
      'sanction state',
    );
    expect(s.dependencies.recoverBanReceipt).not.toHaveBeenCalled();
    expect(s.dependencies.persistDeterministicEvent).not.toHaveBeenCalled();
  });

  it('uses one exact BAN and separate fixed notice/reputation identities, then settles replay without another effect', async () => {
    const s = fixture();
    await expect(executeRuleFollowupSanction(s.plan, s.journal, s.dependencies)).resolves.toBe(
      true,
    );
    await expect(executeRuleFollowupSanction(s.plan, s.journal, s.dependencies)).resolves.toBe(
      true,
    );
    expect(s.order).toEqual(['ban-start', 'ban-http']);
    expect(s.dependencies.ban).toHaveBeenCalledWith({
      actionKey: 'outbox:source:reason:sanction-ban',
      beforeMutation: expect.any(Function),
    });
    expect(s.dependencies.persistDeterministicEvent).toHaveBeenCalledTimes(1);
    expect(s.dependencies.recordReputation).toHaveBeenCalledWith({
      effectKey: 'outbox:source:reason:sanction-reputation',
      observedAtMs: s.plan.issuedAtMs,
    });
    expect(s.dependencies.sendNotice).toHaveBeenCalledTimes(1);
    expect(s.dependencies.sendNotice).toHaveBeenCalledWith({
      idempotencyKey: s.plan.noticeKey,
      sanctionEventId: s.plan.eventId,
      botId: 'surviving-peer',
    });
  });

  it('recovers an exact remote BAN receipt after a crash before outbox confirmation without invoking BAN again', async () => {
    const s = fixture();
    s.journal.confirmBan.mockRejectedValueOnce(new Error('Synthetic post-HTTP SQL outage'));
    await expect(executeRuleFollowupSanction(s.plan, s.journal, s.dependencies)).rejects.toThrow(
      'SQL outage',
    );
    expect(s.getState().phase).toBe('BAN_STARTED');
    s.dependencies.authorize.mockResolvedValue(false);
    await expect(executeRuleFollowupSanction(s.plan, s.journal, s.dependencies)).resolves.toBe(
      true,
    );
    expect(s.dependencies.ban).toHaveBeenCalledTimes(1);
    expect(s.dependencies.recoverBanReceipt).toHaveBeenCalledWith(
      'outbox:source:reason:sanction-ban',
    );
    expect(s.dependencies.persistDeterministicEvent).toHaveBeenCalledTimes(1);
  });

  it('quarantines a started BAN whose original ledger disappeared after unban', async () => {
    const s = fixture();
    s.setState({ phase: 'BAN_STARTED' });
    s.dependencies.recoverBanReceipt.mockResolvedValue({ kind: 'unknown' } as never);
    await expect(
      executeRuleFollowupSanction(s.plan, s.journal, s.dependencies),
    ).rejects.toBeInstanceOf(RuleFollowupBanOutcomeUnknownError);
    await expect(
      executeRuleFollowupSanction(s.plan, s.journal, s.dependencies),
    ).rejects.toBeInstanceOf(RuleFollowupBanOutcomeUnknownError);
    expect(s.dependencies.authorize).not.toHaveBeenCalled();
    expect(s.dependencies.ban).not.toHaveBeenCalled();
    expect(s.dependencies.persistDeterministicEvent).not.toHaveBeenCalled();
    expect(s.dependencies.sendNotice).not.toHaveBeenCalled();
  });

  it('settles a later exact positive BAN receipt after quarantine without checking current sanction policy or dispatching again', async () => {
    const s = fixture();
    s.setState({ phase: 'UNKNOWN' });
    s.dependencies.authorize.mockResolvedValue(false);
    await executeRuleFollowupSanction(s.plan, s.journal, s.dependencies);
    expect(s.dependencies.recoverBanReceipt).toHaveBeenCalledWith(
      'outbox:source:reason:sanction-ban',
    );
    expect(s.dependencies.authorize).not.toHaveBeenCalled();
    expect(s.dependencies.ban).not.toHaveBeenCalled();
    expect(s.dependencies.persistDeterministicEvent).toHaveBeenCalledTimes(1);
    expect(s.getState().phase).toBe('SETTLED');
  });

  it('does not reset an unknown BAN from a later negative ledger result', async () => {
    const s = fixture();
    s.setState({ phase: 'UNKNOWN' });
    s.dependencies.recoverBanReceipt.mockResolvedValue({ kind: 'no_effect' } as never);
    await expect(
      executeRuleFollowupSanction(s.plan, s.journal, s.dependencies),
    ).rejects.toBeInstanceOf(RuleFollowupBanOutcomeUnknownError);
    expect(s.journal.resetAfterProvenNoEffect).not.toHaveBeenCalled();
    expect(s.dependencies.ban).not.toHaveBeenCalled();
  });

  it('retries only a proven BAN rejection without an effect, retaining the same logical action key', async () => {
    const s = fixture();
    s.dependencies.ban.mockResolvedValueOnce({ kind: 'no_effect' } as never);
    await expect(
      executeRuleFollowupSanction(s.plan, s.journal, s.dependencies),
    ).rejects.toBeInstanceOf(RuleFollowupSanctionDeferredError);
    expect(s.getState().phase).toBe('UNSTARTED');
    await executeRuleFollowupSanction(s.plan, s.journal, s.dependencies);
    expect(
      s.dependencies.ban.mock.calls.every(
        ([input]) =>
          (input as { actionKey?: string }).actionKey === 'outbox:source:reason:sanction-ban',
      ),
    ).toBe(true);
    expect(s.dependencies.persistDeterministicEvent).toHaveBeenCalledTimes(1);
  });

  it('reuses the original MUTE event and end after a crash between its SQL event and checkpoint', async () => {
    const s = fixture('MUTE');
    s.journal.commitSqlEvent.mockRejectedValueOnce(new Error('Synthetic checkpoint SQL outage'));
    await expect(executeRuleFollowupSanction(s.plan, s.journal, s.dependencies)).rejects.toThrow(
      'SQL outage',
    );
    await executeRuleFollowupSanction(s.plan, s.journal, s.dependencies);
    expect(s.events.size).toBe(1);
    expect(s.dependencies.rememberActiveMute).toHaveBeenCalledWith({
      eventId: s.plan.eventId,
      issuedAtMs: s.plan.issuedAtMs,
      expiresAtMs: s.plan.muteExpiresAtMs,
      durationHours: 1,
    });
    expect(s.dependencies.ban).not.toHaveBeenCalled();
    expect(s.dependencies.recordReputation).not.toHaveBeenCalled();
  });

  it('keeps a started reputation write fenced if its completion is unknown', async () => {
    const s = fixture();
    s.dependencies.recordReputation.mockRejectedValueOnce(
      new Error('Synthetic observation write outage'),
    );
    await expect(executeRuleFollowupSanction(s.plan, s.journal, s.dependencies)).rejects.toThrow(
      'observation',
    );
    expect(s.getState().phase).toBe('SQL_COMMITTED');
    await executeRuleFollowupSanction(s.plan, s.journal, s.dependencies);
    expect(s.dependencies.ban).toHaveBeenCalledTimes(1);
    expect(s.dependencies.recordReputation).toHaveBeenCalledTimes(1);
    expect(s.dependencies.sendNotice).toHaveBeenCalledTimes(1);
  });

  it('cancels an unstarted revoked rule before creating an event or a remote action', async () => {
    const s = fixture();
    s.dependencies.authorize.mockResolvedValue(false);
    await expect(executeRuleFollowupSanction(s.plan, s.journal, s.dependencies)).resolves.toBe(
      false,
    );
    expect(s.journal.beginBan).not.toHaveBeenCalled();
    expect(s.dependencies.persistDeterministicEvent).not.toHaveBeenCalled();
    expect(s.dependencies.sendNotice).not.toHaveBeenCalled();
  });
});
