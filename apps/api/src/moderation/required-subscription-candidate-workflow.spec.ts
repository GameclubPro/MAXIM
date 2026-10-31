import type {
  RuleFollowupSanctionDependencies,
  RuleFollowupSanctionJournal,
  RuleFollowupSanctionState,
} from './moderation-rule-followup-sanction';
import {
  executeRequiredSubscriptionCandidateWorkflow,
  readFrozenRequiredSubscriptionCandidatePlan,
  readRequiredSubscriptionCandidateSource,
  RequiredSubscriptionCandidateInvalidError,
  type FrozenRequiredSubscriptionCandidatePlan,
  type RequiredSubscriptionCandidateDeleteReceipt,
  type RequiredSubscriptionCandidateNoticeReceipt,
  type RequiredSubscriptionCandidateSource,
  type RequiredSubscriptionCandidateWorkflowDependencies,
  type RequiredSubscriptionCandidateWorkflowOutcome,
} from './required-subscription-candidate-workflow';

function fixture(action: 'NONE' | 'WARN' | 'MUTE' | 'BAN' = 'WARN') {
  const source: RequiredSubscriptionCandidateSource = {
    version: 1,
    chatId: 'chat',
    userId: 'user',
    messageId: 'message',
    sourceAtMs: 1_800_000_000_000,
    deadlineAtMs: 1_800_000_300_000,
    policySha256: 'a'.repeat(64),
    originBotId: 'origin',
    updateType: 'message_created',
    mediaScope: null,
    userLabel: 'User',
    maskedExcerpt: 'masked',
    rulesPublishedUrl: null,
    rulesPublishedMessageId: null,
  };
  const candidateId = 'candidate';
  let now = source.sourceAtMs + 1_000;
  let owned = true;
  let state: RuleFollowupSanctionState = { phase: 'UNSTARTED' };
  let frozenPlan: FrozenRequiredSubscriptionCandidatePlan | null = null;
  const order: string[] = [];
  const outcomes: RequiredSubscriptionCandidateWorkflowOutcome[] = [];
  const qualification = { requiredChannelIds: ['target'], missingChannelIds: ['target'] };
  const plan: FrozenRequiredSubscriptionCandidatePlan = {
    version: 1,
    candidateId,
    source,
    qualification,
    violationCount24h: 2,
    sanction: {
      action,
      issuedAtMs: now,
      muteExpiresAtMs: action === 'MUTE' ? now + 3_600_000 : null,
      muteDurationHours: action === 'MUTE' ? 1 : 0,
      eventId: 'candidate:decision',
      noticeKey: 'required-subscription:notice:v1:chat:message',
    },
    notice: {
      version: 1,
      action,
      renderedText: 'Subscribe',
      messageOptions: {},
      mediaFieldKey: null,
      deleteBotMessagesEnabled: false,
      deleteBotMessagesDelayMinutes: 5,
      executionProof: {
        version: 1,
        chatId: source.chatId,
        userId: source.userId,
        messageId: source.messageId,
        reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
        policySha256: source.policySha256,
        sourceAtMs: source.sourceAtMs,
        deadlineAtMs: source.deadlineAtMs,
      },
    },
  };
  const binding = {
    candidateId,
    chatId: source.chatId,
    userId: source.userId,
    messageId: source.messageId,
    sourceAtMs: source.sourceAtMs,
    deadlineAtMs: source.deadlineAtMs,
    policySha256: source.policySha256,
  };
  const noticeReceipt: RequiredSubscriptionCandidateNoticeReceipt = {
    ...binding,
    kind: 'notice_handoff',
    noticeKey: plan.sanction.noticeKey,
    receiptId: 'send-ledger',
  };
  const deleteReceipt: RequiredSubscriptionCandidateDeleteReceipt = {
    ...binding,
    intentId: 'delete-intent',
    reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
    rollout: 'execute',
    status: 'PENDING',
  };
  const assertOwned = jest.fn(async () => {
    if (!owned) throw new Error('candidate lease lost');
  });
  const journal = {
    id: candidateId,
    assertLease: assertOwned,
    readState: jest.fn(async () => state),
    beginBan: jest.fn(async () => {
      state = { phase: 'BAN_STARTED' };
      return true;
    }),
    confirmBan: jest.fn(async (banBotId: string | null) => {
      state = { phase: 'BAN_CONFIRMED', banBotId };
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
    claimReputation: jest.fn(async () => 'run' as const),
    completeReputation: jest.fn(async () => undefined),
    settle: jest.fn(async () => {
      state = { ...state, phase: 'SETTLED' };
    }),
  } satisfies RuleFollowupSanctionJournal;
  const sanction = {
    authorize: jest.fn(async () => true),
    ban: jest.fn<
      ReturnType<RuleFollowupSanctionDependencies['ban']>,
      Parameters<RuleFollowupSanctionDependencies['ban']>
    >(async ({ beforeMutation }) => {
      await beforeMutation();
      return { kind: 'confirmed', botId: 'executor' };
    }),
    recoverBanReceipt: jest.fn<
      ReturnType<RuleFollowupSanctionDependencies['recoverBanReceipt']>,
      Parameters<RuleFollowupSanctionDependencies['recoverBanReceipt']>
    >(async () => ({ kind: 'unknown' })),
    persistDeterministicEvent: jest.fn<
      ReturnType<RuleFollowupSanctionDependencies['persistDeterministicEvent']>,
      Parameters<RuleFollowupSanctionDependencies['persistDeterministicEvent']>
    >(async ({ eventId }) => {
      order.push('sql-event');
      state = { ...state, phase: 'SQL_COMMITTED', eventId };
      return eventId;
    }),
    rememberActiveMute: jest.fn(async () => undefined),
    rememberInactiveMute: jest.fn(async () => undefined),
  };
  const deps = {
    now: () => now,
    assertOwned,
    qualify: jest.fn<
      ReturnType<RequiredSubscriptionCandidateWorkflowDependencies['qualify']>,
      Parameters<RequiredSubscriptionCandidateWorkflowDependencies['qualify']>
    >(async () => ({
      kind: 'qualified',
      qualification,
    })),
    freezeOwnClaimAndDecision: jest.fn<
      ReturnType<RequiredSubscriptionCandidateWorkflowDependencies['freezeOwnClaimAndDecision']>,
      Parameters<RequiredSubscriptionCandidateWorkflowDependencies['freezeOwnClaimAndDecision']>
    >(async () => {
      order.push('freeze');
      frozenPlan = plan;
      return { kind: 'owned', plan };
    }),
    sanctionJournal: journal,
    sanctionDependencies: jest.fn(() => sanction),
    handoffNotice: jest.fn<
      ReturnType<RequiredSubscriptionCandidateWorkflowDependencies['handoffNotice']>,
      Parameters<RequiredSubscriptionCandidateWorkflowDependencies['handoffNotice']>
    >(async () => {
      order.push('notice');
      return { kind: 'committed', receipt: noticeReceipt };
    }),
    handoffDelete: jest.fn<
      ReturnType<RequiredSubscriptionCandidateWorkflowDependencies['handoffDelete']>,
      Parameters<RequiredSubscriptionCandidateWorkflowDependencies['handoffDelete']>
    >(async () => {
      order.push('delete');
      return { kind: 'committed', receipt: deleteReceipt };
    }),
    settle: jest.fn(async (outcome: RequiredSubscriptionCandidateWorkflowOutcome) => {
      order.push('settle');
      outcomes.push(outcome);
    }),
  } satisfies RequiredSubscriptionCandidateWorkflowDependencies;
  return {
    source,
    candidateId,
    plan,
    deps,
    sanction,
    journal,
    order,
    outcomes,
    noticeReceipt,
    deleteReceipt,
    run: () =>
      executeRequiredSubscriptionCandidateWorkflow({ candidateId, source, frozenPlan }, deps),
    persistPlan: () => {
      frozenPlan = plan;
    },
    setNow: (value: number) => {
      now = value;
    },
    loseLease: () => {
      owned = false;
    },
    setState: (value: RuleFollowupSanctionState) => {
      state = value;
    },
  };
}

describe('required subscription candidate continuation', () => {
  it('freezes its decision, settles its sanction, hands off notice, then transfers exact DELETE', async () => {
    const s = fixture();
    await expect(s.run()).resolves.toEqual({
      kind: 'delete_transferred',
      receipt: s.deleteReceipt,
    });
    expect(s.order).toEqual(['freeze', 'sql-event', 'notice', 'delete', 'settle']);
    expect(s.deps.freezeOwnClaimAndDecision.mock.calls[0]?.[0].startedAtMs).toBe(
      s.source.sourceAtMs + 1000,
    );
  });

  it.each(['policy_changed', 'source_changed'])(
    'finishes %s qualification without a claim or effect',
    async (reason) => {
      const s = fixture();
      s.deps.qualify.mockResolvedValue({ kind: 'not_actionable', reason });
      await expect(s.run()).resolves.toEqual({ kind: 'not_actionable', reason });
      expect(s.deps.freezeOwnClaimAndDecision).not.toHaveBeenCalled();
      expect(s.deps.handoffNotice).not.toHaveBeenCalled();
      expect(s.deps.handoffDelete).not.toHaveBeenCalled();
    },
  );

  it('retains an unavailable read retry without inventing a decision', async () => {
    const s = fixture();
    s.deps.qualify.mockResolvedValue({ kind: 'retry_read', retryAfterMs: 700 });
    await expect(s.run()).resolves.toEqual({ kind: 'retry_read', retryAfterMs: 700 });
    expect(s.deps.freezeOwnClaimAndDecision).not.toHaveBeenCalled();
    expect(s.deps.handoffNotice).not.toHaveBeenCalled();
  });

  it('never adopts a foreign message action claim', async () => {
    const s = fixture();
    s.deps.freezeOwnClaimAndDecision.mockResolvedValue({ kind: 'foreign_claim_blocked' });
    await expect(s.run()).resolves.toEqual({ kind: 'foreign_claim_blocked' });
    expect(s.sanction.persistDeterministicEvent).not.toHaveBeenCalled();
    expect(s.deps.handoffNotice).not.toHaveBeenCalled();
  });

  it('recovers its committed frozen decision after the freeze response is lost', async () => {
    const s = fixture();
    s.deps.freezeOwnClaimAndDecision.mockImplementationOnce(async () => {
      s.persistPlan();
      throw new Error('connection lost after claim/decision commit');
    });
    await expect(s.run()).rejects.toThrow('after claim/decision commit');
    await expect(s.run()).resolves.toMatchObject({ kind: 'delete_transferred' });
    expect(s.deps.qualify).toHaveBeenCalledTimes(1);
    expect(s.deps.freezeOwnClaimAndDecision).toHaveBeenCalledTimes(1);
    expect(s.sanction.persistDeterministicEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'candidate:decision',
        issuedAtMs: s.plan.sanction.issuedAtMs,
      }),
    );
  });

  it('resumes after notice handoff response loss without persisting a second sanction', async () => {
    const s = fixture('MUTE');
    s.deps.handoffNotice.mockRejectedValueOnce(
      new Error('notice receipt persistence response lost'),
    );
    await expect(s.run()).rejects.toThrow('response lost');
    await expect(s.run()).resolves.toMatchObject({ kind: 'delete_transferred' });
    expect(s.sanction.persistDeterministicEvent).toHaveBeenCalledTimes(1);
    expect(s.deps.handoffNotice.mock.calls.map(([plan]) => plan.sanction.noticeKey)).toEqual([
      'required-subscription:notice:v1:chat:message',
      'required-subscription:notice:v1:chat:message',
    ]);
    expect(s.deps.handoffDelete).toHaveBeenCalledTimes(1);
  });

  it('expires before qualification and again before a delayed freeze can start', async () => {
    const expired = fixture();
    expired.setNow(expired.source.deadlineAtMs);
    await expect(expired.run()).resolves.toEqual({ kind: 'expired' });
    expect(expired.deps.qualify).not.toHaveBeenCalled();
    const delayed = fixture();
    delayed.deps.qualify.mockImplementation(async () => {
      delayed.setNow(delayed.source.deadlineAtMs);
      return { kind: 'qualified', qualification: delayed.plan.qualification };
    });
    await expect(delayed.run()).resolves.toEqual({ kind: 'expired' });
    expect(delayed.deps.freezeOwnClaimAndDecision).not.toHaveBeenCalled();
  });

  it('settles an exact started BAN receipt after expiry without a new BAN, notice or DELETE', async () => {
    const s = fixture('BAN');
    s.persistPlan();
    s.setState({ phase: 'BAN_STARTED' });
    s.setNow(s.source.deadlineAtMs + 1);
    s.sanction.recoverBanReceipt.mockResolvedValue({ kind: 'confirmed', botId: 'executor' });
    await expect(s.run()).resolves.toEqual({ kind: 'expired' });
    expect(s.sanction.ban).not.toHaveBeenCalled();
    expect(s.sanction.authorize).not.toHaveBeenCalled();
    expect(s.sanction.persistDeterministicEvent).toHaveBeenCalledTimes(1);
    expect(s.deps.sanctionDependencies).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ receiptOnly: true }),
    );
    expect(s.deps.handoffNotice).not.toHaveBeenCalled();
    expect(s.deps.handoffDelete).not.toHaveBeenCalled();
  });

  it('keeps an unknown started BAN fenced after expiry', async () => {
    const s = fixture('BAN');
    s.persistPlan();
    s.setState({ phase: 'UNKNOWN' });
    s.setNow(s.source.deadlineAtMs + 1);
    await expect(s.run()).resolves.toEqual({ kind: 'effect_unknown', effect: 'sanction' });
    expect(s.sanction.ban).not.toHaveBeenCalled();
    expect(s.sanction.persistDeterministicEvent).not.toHaveBeenCalled();
    expect(s.deps.handoffNotice).not.toHaveBeenCalled();
  });

  it('does not start a BAN if the original deadline passes during final authorization', async () => {
    const s = fixture('BAN');
    s.sanction.authorize.mockImplementation(async () => {
      s.setNow(s.source.deadlineAtMs);
      return true;
    });
    await expect(s.run()).resolves.toEqual({ kind: 'expired' });
    expect(s.sanction.ban).not.toHaveBeenCalled();
    expect(s.deps.handoffNotice).not.toHaveBeenCalled();
  });

  it.each(['retry_read', 'revoked', 'effect_unknown'] as const)(
    'does not delete after a %s notice handoff',
    async (kind) => {
      const s = fixture();
      s.deps.handoffNotice.mockResolvedValue(
        kind === 'revoked' ? { kind, reason: 'policy_changed' } : { kind },
      );
      await s.run();
      expect(s.deps.handoffDelete).not.toHaveBeenCalled();
      expect(s.outcomes.at(-1)?.kind).toBe(kind === 'revoked' ? 'not_actionable' : kind);
    },
  );

  it('does not reinterpret an unknown DELETE handoff as successful transfer', async () => {
    const s = fixture();
    s.deps.handoffDelete.mockResolvedValue({ kind: 'effect_unknown' });
    await expect(s.run()).resolves.toEqual({ kind: 'effect_unknown', effect: 'delete' });
  });

  it.each(['foreign-notice', 'foreign-delete', 'shadow-delete', 'ambiguous-delete'])(
    'rejects a %s receipt before terminal settlement',
    async (kind) => {
      const s = fixture();
      if (kind === 'foreign-notice')
        s.deps.handoffNotice.mockResolvedValue({
          kind: 'committed',
          receipt: { ...s.noticeReceipt, messageId: 'other' },
        });
      else
        s.deps.handoffDelete.mockResolvedValue({
          kind: 'committed',
          receipt: {
            ...s.deleteReceipt,
            ...(kind === 'foreign-delete'
              ? { sourceAtMs: s.source.sourceAtMs - 1 }
              : kind === 'shadow-delete'
                ? { rollout: 'shadow' }
                : { status: 'AMBIGUOUS' }),
          } as RequiredSubscriptionCandidateDeleteReceipt,
        });
      await expect(s.run()).rejects.toBeInstanceOf(RequiredSubscriptionCandidateInvalidError);
      expect(s.deps.settle).not.toHaveBeenCalled();
      if (kind === 'foreign-notice') expect(s.deps.handoffDelete).not.toHaveBeenCalled();
    },
  );

  it('fences lease takeover after an awaited notice receipt', async () => {
    const s = fixture();
    s.deps.handoffNotice.mockImplementation(async () => {
      s.loseLease();
      return { kind: 'committed', receipt: s.noticeReceipt };
    });
    await expect(s.run()).rejects.toThrow('lease lost');
    expect(s.deps.handoffDelete).not.toHaveBeenCalled();
    expect(s.deps.settle).not.toHaveBeenCalled();
  });

  it('transfers a covered album follower without claiming a violation or executing leader effects', async () => {
    const s = fixture();
    const receipt = {
      ...s.noticeReceipt,
      kind: 'media_coverage' as const,
      noticeKey: 'anchor-key',
    };
    await expect(
      executeRequiredSubscriptionCandidateWorkflow(
        { candidateId: s.candidateId, source: s.source, noticeReceipt: receipt },
        s.deps,
      ),
    ).resolves.toMatchObject({ kind: 'delete_transferred' });
    expect(s.deps.qualify).not.toHaveBeenCalled();
    expect(s.deps.freezeOwnClaimAndDecision).not.toHaveBeenCalled();
    expect(s.deps.sanctionDependencies).not.toHaveBeenCalled();
    expect(s.deps.handoffNotice).not.toHaveBeenCalled();
    expect(s.deps.handoffDelete).toHaveBeenCalledWith(s.source, receipt);
  });
});

describe('candidate immutable JSON boundary', () => {
  it('round-trips a source and frozen decision and rejects another source/policy/proof', () => {
    const s = fixture();
    expect(readRequiredSubscriptionCandidateSource(JSON.parse(JSON.stringify(s.source)))).toEqual(
      s.source,
    );
    expect(
      readFrozenRequiredSubscriptionCandidatePlan(
        JSON.parse(JSON.stringify(s.plan)),
        s.source,
        s.candidateId,
      ),
    ).toEqual(s.plan);
    expect(
      readRequiredSubscriptionCandidateSource({
        ...s.source,
        deadlineAtMs: s.source.deadlineAtMs + 1,
      }),
    ).toBeNull();
    expect(
      readFrozenRequiredSubscriptionCandidatePlan(
        s.plan,
        { ...s.source, policySha256: 'b'.repeat(64) },
        s.candidateId,
      ),
    ).toBeNull();
    expect(
      readFrozenRequiredSubscriptionCandidatePlan(
        {
          ...s.plan,
          notice: {
            ...s.plan.notice,
            executionProof: { ...s.plan.notice.executionProof, messageId: 'foreign' },
          },
        },
        s.source,
        s.candidateId,
      ),
    ).toBeNull();
  });
});
