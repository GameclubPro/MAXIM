import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';
import { buildNightModeNoticeIdempotencyKey } from '../max/max-action-idempotency.util';
import {
  classifyNightModeNoticeLedger,
  classifyNightModeNoticeSendRoute,
  type NightModeNoticeDiagnosticLedgerRow,
  type NightModeNoticeRouteSnapshot,
} from './night-mode-notice-diagnostics';

const sessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-10-13';
const completedAt = new Date('2026-10-14T05:00:01.000Z');

function ledger(
  patch: Partial<NightModeNoticeDiagnosticLedgerRow> = {},
): NightModeNoticeDiagnosticLedgerRow {
  return {
    jobId: buildNightModeNoticeIdempotencyKey('open', 'chat', sessionKey),
    chatId: 'chat',
    actionType: 'SEND_MESSAGE',
    sourceTag: 'night_mode_transition',
    status: 'ENQUEUED',
    ambiguous: false,
    terminal: false,
    attemptCount: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    dispatchToken: null,
    dispatchStartedAt: null,
    dispatchBotId: null,
    remoteMessageId: null,
    completedAt: null,
    lastStatusCode: null,
    lastErrorCode: null,
    ...patch,
  };
}

function classify(row: NightModeNoticeDiagnosticLedgerRow | null) {
  return classifyNightModeNoticeLedger({
    chatId: 'chat',
    transition: 'open',
    sessionKey,
    ledger: { state: 'read', row },
  });
}

describe('night notice SEND evidence', () => {
  const receipt = ledger({
    status: 'SUCCEEDED',
    terminal: true,
    attemptCount: 1,
    dispatchBotId: 'original-bot',
    remoteMessageId: 'receipt',
    completedAt,
  });
  it('requires the complete exact receipt and reports its persisted completion time', () => {
    expect(classify(receipt)).toEqual({
      outcome: 'sent',
      reason: 'successful_receipt',
      sentAt: completedAt.toISOString(),
    });
  });
  it.each<Partial<NightModeNoticeDiagnosticLedgerRow>>([
    { jobId: buildNightModeNoticeIdempotencyKey('close', 'chat', sessionKey) },
    { chatId: 'other-chat' },
    { sourceTag: 'other-feature' },
    { actionType: 'DELETE_MESSAGE' },
  ])('rejects a receipt with another identity: %o', (patch) => {
    expect(classify({ ...receipt, ...patch })).toMatchObject({
      outcome: 'unknown',
      reason: 'identity_mismatch',
      sentAt: null,
    });
  });
  it.each<Partial<NightModeNoticeDiagnosticLedgerRow>>([
    { remoteMessageId: null },
    { remoteMessageId: '  ' },
    { dispatchBotId: '' },
    { completedAt: null },
    { completedAt: new Date('invalid') },
    { terminal: false },
  ])('never calls malformed success a failed SEND: %o', (patch) => {
    expect(classify({ ...receipt, ...patch })).toMatchObject({
      outcome: 'unknown',
      reason: 'incomplete_success',
    });
  });
  it('retains ambiguity even when receipt-looking fields exist', () => {
    expect(classify({ ...receipt, ambiguous: true })).toMatchObject({
      outcome: 'unknown',
      reason: 'ambiguous',
    });
  });
  it('distinguishes missing evidence, failed reads and a pristine queued SEND', () => {
    expect(classify(null)).toMatchObject({ outcome: 'not_recorded', reason: 'ledger_missing' });
    expect(classify(ledger())).toMatchObject({
      outcome: 'pending',
      reason: 'awaiting_first_attempt',
    });
    expect(
      classifyNightModeNoticeLedger({
        chatId: 'chat',
        transition: 'open',
        sessionKey,
        ledger: { state: 'unavailable' },
      }),
    ).toMatchObject({ outcome: 'unknown', reason: 'ledger_unavailable' });
  });
  it.each<Partial<NightModeNoticeDiagnosticLedgerRow>>([
    { attemptCount: 1 },
    { firstAttemptAt: completedAt },
    { lastAttemptAt: completedAt },
    { dispatchToken: 'fence' },
    { dispatchStartedAt: completedAt },
    { dispatchBotId: 'original-bot' },
    { remoteMessageId: 'receipt-without-terminal-proof' },
    { status: 'IN_PROGRESS' },
    { status: 'FAILED_RETRYABLE', attemptCount: 1 },
  ])('does not label unresolved attempts as awaiting first dispatch: %o', (patch) => {
    expect(classify(ledger(patch))).toMatchObject({
      outcome: 'unknown',
      reason: 'attempted_without_receipt',
    });
  });
  it.each(['max_send_pre_dispatch_guard_rejected', 'max_action_no_executable_route'])(
    'accepts only certified no-dispatch terminal failure: %s',
    (lastErrorCode) => {
      const failure = ledger({
        status: 'FAILED_TERMINAL',
        terminal: true,
        completedAt,
        lastErrorCode,
        attemptCount: 1,
      });
      expect(classify(failure)).toMatchObject({
        outcome: 'not_sent',
        reason: 'proven_pre_dispatch_failure',
      });
      expect(classify({ ...failure, dispatchStartedAt: completedAt }).outcome).toBe('unknown');
      expect(classify({ ...failure, ambiguous: true }).outcome).toBe('unknown');
    },
  );
  it('does not infer non-delivery from a generic terminal or skipped state', () => {
    for (const status of ['FAILED_TERMINAL', 'SKIPPED'] as const)
      expect(classify(ledger({ status, terminal: true, completedAt }))).toMatchObject({
        outcome: 'unknown',
        reason: 'terminal_without_receipt',
      });
  });
});

describe('night notice saved route evidence', () => {
  function snapshot(): NightModeNoticeRouteSnapshot {
    return {
      chatId: 'chat',
      entityType: ChatEntityType.CHAT,
      routingState: 'READY',
      routingVersion: 1,
      primaryBotId: 'bot',
      fixedModeratorBotId: null,
      botMemberships: [
        {
          botId: 'bot',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
          botAccessCheckedAt: new Date('2020-01-01'),
          botAccessExpiresAt: null,
          botAccessSource: 'handshake_start',
          permissionsSnapshot: {
            isAdmin: true,
            isOwner: false,
            permissionsKnown: true,
            permissions: ['read_all_messages', 'write'],
          },
          sendRouteFailureCount: 0,
          sendRouteQuarantinedUntil: null,
          sendRouteLastFailureCode: null,
        },
      ],
    };
  }
  it('requires the fixed moderator even when another bot has current rights', () => {
    expect(classifyNightModeNoticeSendRoute(snapshot())).toBe('available');
    expect(classifyNightModeNoticeSendRoute({ ...snapshot(), fixedModeratorBotId: 'other' })).toBe(
      'unavailable',
    );
  });
  it('keeps unconfirmed refreshable access unknown', () => {
    const row = snapshot();
    row.botMemberships[0]!.botAccessState = ChatBotAccessState.UNKNOWN;
    row.botMemberships[0]!.permissionsSnapshot = null;
    expect(classifyNightModeNoticeSendRoute(row)).toBe('unknown');
  });
  it('retains disappearance quarantine after its minimum expiry', () => {
    const row = snapshot();
    Object.assign(row.botMemberships[0]!, {
      sendRouteFailureCount: 2,
      sendRouteLastFailureCode: 'PUBLICATION_MESSAGE_DISAPPEARED',
      sendRouteQuarantinedUntil: new Date('2020-01-01'),
    });
    expect(classifyNightModeNoticeSendRoute(row)).toBe('unavailable');
  });
});
