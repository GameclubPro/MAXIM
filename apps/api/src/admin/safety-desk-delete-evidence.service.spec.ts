import {
  deleteNoticeKeys,
  projectDeleteNoticeEvidence,
  projectDeleteOutcome,
  projectDeleteReasonOrigin,
  type DeleteReasonOriginRow,
  type DeleteFollowupEvidenceRow,
  type DeleteNoticeLedgerRow,
} from './safety-desk-delete-evidence.service';

const sourceAt = new Date('2026-10-16T18:00:00.000Z');
const observedAt = new Date(sourceAt.getTime() + 60_000);

describe('exact DELETE origin evidence', () => {
  const target = { chatId: 'chat', messageId: 'message' };
  const origin = (): DeleteReasonOriginRow => ({
    reasonId: 'reason',
    sourceWebhookEventId: 'receipt',
    sourceReceivingBotId: 'receiving',
    sourceExecutionBotId: 'executor',
    sourceEventAt: sourceAt,
    sourceObservedAt: observedAt,
    sourceEvidenceVersion: 1,
    receiptId: 'receipt',
    receiptBotId: 'receiving',
    receiptCreatedAt: sourceAt,
    sourcePayload: {
      type: 'message_edited',
      botId: 'receiving',
      eventTimestampSource: 'payload',
      message: { ...target, createdAt: '2020-01-01T00:00:00.000Z' },
      raw: { timestamp: sourceAt.toISOString() },
    },
    claimId: 'claim',
    claimWebhookEventId: 'receipt',
    claimExecutionBotId: 'executor',
    claimEnforced: true,
    claimBusinessStartedAt: sourceAt,
  });
  it('links exact receipt and canonical claim while keeping receiving/execution bots distinct', () => {
    expect(projectDeleteReasonOrigin(origin(), target, observedAt)).toEqual({
      state: 'linked',
      webhookEventId: 'receipt',
      receivingBotId: 'receiving',
      executionBotId: 'executor',
      eventAt: sourceAt.toISOString(),
      acceptedAt: sourceAt.toISOString(),
      recordedAt: observedAt.toISOString(),
      evidenceVersion: 1,
    });
  });
  it.each(['receipt', 'claim', 'retained-body'] as const)(
    'preserves recorded provenance when %s is unavailable',
    (missing) => {
      const row = origin();
      if (missing === 'receipt') row.receiptId = null;
      if (missing === 'claim') row.claimId = null;
      if (missing === 'retained-body') row.sourcePayload = {};
      expect(projectDeleteReasonOrigin(row, target, observedAt)).toMatchObject({
        state: 'source_unavailable',
        webhookEventId: 'receipt',
      });
    },
  );
  it.each([
    'clock',
    'receiving-bot',
    'execution-bot',
    'claim-receipt',
    'claim-unstarted',
    'claim-unenforced',
    'target',
    'future-recording',
    'version',
  ])('refuses mismatched %s without inventing provenance', (failure) => {
    const row = origin();
    if (failure === 'clock') row.sourceEventAt = new Date(sourceAt.getTime() + 1);
    if (failure === 'receiving-bot') row.receiptBotId = 'executor';
    if (failure === 'execution-bot') row.claimExecutionBotId = 'receiving';
    if (failure === 'claim-receipt') row.claimWebhookEventId = 'another-receipt';
    if (failure === 'claim-unstarted') row.claimBusinessStartedAt = null;
    if (failure === 'claim-unenforced') row.claimEnforced = false;
    if (failure === 'target')
      row.sourcePayload = {
        ...(row.sourcePayload as object),
        message: { ...target, messageId: 'another' },
      };
    if (failure === 'future-recording') row.sourceObservedAt = new Date(observedAt.getTime() + 1);
    if (failure === 'version') row.sourceEvidenceVersion = 2;
    expect(projectDeleteReasonOrigin(row, target, observedAt)).toMatchObject({
      state: 'invalid_evidence',
      webhookEventId: null,
    });
  });
  it('keeps missing historical origin explicitly unrecorded', () => {
    expect(projectDeleteReasonOrigin(undefined, target, observedAt)).toMatchObject({
      state: 'not_recorded',
      webhookEventId: null,
      acceptedAt: null,
    });
  });
});
function fixture() {
  const row: DeleteFollowupEvidenceRow = {
    id: 'followup',
    chatId: 'chat',
    messageId: 'message',
    userId: 'user',
    reasonKey: 'reason',
    ruleCode: 'MESSAGE_TOO_LONG_DELETE',
    status: 'COMPLETED',
    sourceAt,
    deadlineAt: new Date(sourceAt.getTime() + 300_000),
    completedAt: observedAt,
    policySha256: 'a'.repeat(64),
    originBotId: 'bot',
    banBotId: null,
    plan: {
      version: 1,
      action: 'WARN',
      issuedAtMs: sourceAt.getTime() + 1000,
      violationCount: 1,
      eventId: 'followup:decision',
      noticeKey: 'followup:sanction-notice',
      muteDurationHours: 0,
      muteExpiresAtMs: null,
    },
    phase: 'SETTLED',
    effectEventId: 'followup:decision',
    decisionRecorded: true,
  };
  const keys = deleteNoticeKeys('followup:sanction-notice', ['bot']);
  const ledger: DeleteNoticeLedgerRow = {
    jobId: keys[1]!,
    chatId: 'chat',
    botId: 'bot',
    actionType: 'SEND_MESSAGE',
    status: 'SUCCEEDED',
    terminal: true,
    ambiguous: false,
    dispatchStartedAt: null,
    completedAt: observedAt,
    remoteMessageId: 'remote',
    followupProof: { version: 1, id: row.id, issuedAtMs: sourceAt.getTime() + 1000 },
    noticeProof: {
      version: 1,
      chatId: row.chatId,
      messageId: row.messageId,
      userId: row.userId,
      reasonKey: row.reasonKey,
      ruleCode: row.ruleCode,
      policySha256: row.policySha256,
      deadlineAtMs: row.deadlineAt.getTime(),
    },
  };
  return { row, ledger, keys };
}

describe('exact delete operation evidence', () => {
  it('confirms only its exact terminal SEND receipt', () => {
    const { row, ledger, keys } = fixture();
    expect(projectDeleteNoticeEvidence(row, 'sanction-notice', [ledger], keys, observedAt)).toEqual(
      {
        state: 'confirmed',
        completedAt: observedAt.toISOString(),
        remoteMessageId: 'remote',
      },
    );
  });

  it.each(['messageId', 'userId', 'reasonKey', 'ruleCode', 'policySha256', 'deadlineAtMs'])(
    'refuses a receipt with mismatched %s',
    (key) => {
      const { row, ledger, keys } = fixture();
      ledger.noticeProof = { ...(ledger.noticeProof as object), [key]: 'other' };
      expect(
        projectDeleteNoticeEvidence(row, 'sanction-notice', [ledger], keys, observedAt).state,
      ).toBe('invalid_evidence');
    },
  );

  it('does not turn a completed followup or absent ledger into delivery proof', () => {
    const { row, keys } = fixture();
    expect(projectDeleteNoticeEvidence(row, 'sanction-notice', [], keys, observedAt).state).toBe(
      'not_recorded',
    );
  });

  it.each([
    'missing-event',
    'ambiguous',
    'started',
    'missing-message',
    'future-receipt',
    'multiple-receipts',
    'malformed-plan',
  ])('preserves uncertainty for %s', (failure) => {
    const { row, ledger, keys } = fixture();
    const ledgers = [ledger];
    if (failure === 'missing-event') row.decisionRecorded = false;
    if (failure === 'ambiguous') ledger.ambiguous = true;
    if (failure === 'started') {
      ledger.status = 'IN_PROGRESS';
      ledger.terminal = false;
      ledger.dispatchStartedAt = sourceAt;
    }
    if (failure === 'missing-message') ledger.remoteMessageId = null;
    if (failure === 'future-receipt') ledger.completedAt = new Date(observedAt.getTime() + 1);
    if (failure === 'multiple-receipts') ledgers.push({ ...ledger, jobId: keys[0]! });
    if (failure === 'malformed-plan') row.plan = { version: 2 };
    expect(
      projectDeleteNoticeEvidence(row, 'sanction-notice', ledgers, keys, observedAt).state,
    ).not.toBe('confirmed');
  });

  it('distinguishes a MAX acknowledgement, verified absence and an unproven terminal status', () => {
    const intent: Parameters<typeof projectDeleteOutcome>[0] = {
      status: 'SUCCEEDED',
      createdAt: sourceAt,
      deleteDispatchStartedAt: null,
      remoteDeleteSucceededAt: null,
      remoteDeleteSucceededBotId: null,
      completedAt: observedAt,
      absenceVerifiedAt: null,
      absenceVerifiedBotId: null,
      absenceVerificationCode: null,
      succeededBotId: 'bot',
    };
    expect(projectDeleteOutcome(intent, observedAt)).toBe('unknown');
    expect(
      projectDeleteOutcome(
        { ...intent, remoteDeleteSucceededAt: observedAt, remoteDeleteSucceededBotId: 'bot' },
        observedAt,
      ),
    ).toBe('confirmed');
    for (const pending of [
      { status: 'AMBIGUOUS' as const, completedAt: null, succeededBotId: null },
      { status: 'IN_PROGRESS' as const, completedAt: null, succeededBotId: null },
      { status: 'SUCCEEDED' as const, completedAt: null },
      { status: 'SUCCEEDED' as const, succeededBotId: 'other-bot' },
    ]) {
      expect(
        projectDeleteOutcome(
          {
            ...intent,
            ...pending,
            remoteDeleteSucceededAt: observedAt,
            remoteDeleteSucceededBotId: 'bot',
          },
          observedAt,
        ),
      ).toBe('acknowledged');
    }
    expect(
      projectDeleteOutcome(
        {
          ...intent,
          status: 'AMBIGUOUS',
          remoteDeleteSucceededAt: observedAt,
          remoteDeleteSucceededBotId: null,
        },
        observedAt,
      ),
    ).toBe('unknown');
    expect(
      projectDeleteOutcome(
        {
          ...intent,
          remoteDeleteSucceededAt: new Date(observedAt.getTime() + 1),
          remoteDeleteSucceededBotId: 'bot',
        },
        observedAt,
      ),
    ).toBe('unknown');
    expect(
      projectDeleteOutcome(
        {
          ...intent,
          status: 'ALREADY_ABSENT',
          absenceVerifiedAt: observedAt,
          absenceVerifiedBotId: 'bot',
          absenceVerificationCode: 'arbitrary-404',
        },
        observedAt,
      ),
    ).toBe('unknown');
    expect(
      projectDeleteOutcome(
        {
          ...intent,
          status: 'ALREADY_ABSENT',
          absenceVerifiedAt: observedAt,
          absenceVerifiedBotId: 'bot',
          absenceVerificationCode: 'postdelete_exact_presence',
        },
        observedAt,
      ),
    ).toBe('already_absent');
  });
});
