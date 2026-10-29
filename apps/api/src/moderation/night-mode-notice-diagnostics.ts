import type {
  NightModeNoticeDeliveryEvidence,
  NightModeNoticeEvidenceReason,
} from '@maxim/contracts/settings';
import { buildNightModeNoticeIdempotencyKey } from '../max/max-action-idempotency.util';
import { MAX_ACTION_NO_EXECUTABLE_ROUTE_ERROR_CODE } from '../max/max-action-dispatch-error';
import { MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE } from '../max/max-action-pre-dispatch-guard';
import {
  executionRouteProof,
  type MaxExecutionMembershipProof,
} from '../max/max-execution-route-proof';
import { MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE } from '../max/max-send-route-health';
import { ChatEntityType } from '../prisma/prisma-client';
import type { Prisma } from '../prisma/prisma-client';
import { isNightModeTransitionMembershipCandidate } from './night-mode-transition-eligibility.util';
import type { NightModeTransitionKind } from './night-mode-transition-time.util';

export const NIGHT_MODE_NOTICE_DIAGNOSTIC_LEDGER_SELECT = {
  jobId: true,
  chatId: true,
  actionType: true,
  sourceTag: true,
  status: true,
  ambiguous: true,
  terminal: true,
  attemptCount: true,
  firstAttemptAt: true,
  lastAttemptAt: true,
  dispatchToken: true,
  dispatchStartedAt: true,
  dispatchBotId: true,
  remoteMessageId: true,
  completedAt: true,
  lastStatusCode: true,
  lastErrorCode: true,
} satisfies Prisma.MaxActionLedgerEntrySelect;

export type NightModeNoticeDiagnosticLedgerRow = Prisma.MaxActionLedgerEntryGetPayload<{
  select: typeof NIGHT_MODE_NOTICE_DIAGNOSTIC_LEDGER_SELECT;
}>;

export type NightModeNoticeLedgerRead =
  | { state: 'read'; row: NightModeNoticeDiagnosticLedgerRow | null }
  | { state: 'unavailable' };

export type NightModeNoticeRouteSnapshot = {
  chatId: string;
  entityType: ChatEntityType | null;
  routingState: string;
  routingVersion: number;
  primaryBotId: string | null;
  fixedModeratorBotId: string | null;
  botMemberships: Array<
    MaxExecutionMembershipProof & {
      sendRouteFailureCount: number;
      sendRouteQuarantinedUntil: Date | null;
      sendRouteLastFailureCode: string | null;
    }
  >;
};

export function classifyNightModeNoticeSendRoute(
  snapshot: NightModeNoticeRouteSnapshot | null,
  now = new Date(),
): 'available' | 'unavailable' | 'unknown' {
  if (!snapshot || snapshot.entityType !== ChatEntityType.CHAT || snapshot.routingState !== 'READY')
    return 'unavailable';
  const state = { ...snapshot, candidates: snapshot.botMemberships };
  let refreshable = false;
  for (const candidate of snapshot.botMemberships) {
    if (snapshot.fixedModeratorBotId && candidate.botId !== snapshot.fixedModeratorBotId) continue;
    // FLAG: Saved access is current route evidence only. An expired quarantine after a
    // disappearance still requires its controlled probe; it is not ordinary SEND readiness.
    if (
      (candidate.sendRouteQuarantinedUntil?.getTime() ?? 0) > now.getTime() ||
      (candidate.sendRouteLastFailureCode === MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE &&
        candidate.sendRouteFailureCount > 0)
    )
      continue;
    if (
      executionRouteProof(state, candidate.botId, 'moderation') &&
      executionRouteProof(state, candidate.botId, 'send_message')
    )
      return 'available';
    refreshable ||= isNightModeTransitionMembershipCandidate(candidate);
  }
  return refreshable ? 'unknown' : 'unavailable';
}

export function classifyNightModeNoticeLedger(params: {
  chatId: string;
  transition: NightModeTransitionKind;
  sessionKey: string;
  ledger: NightModeNoticeLedgerRead;
}): NightModeNoticeDeliveryEvidence {
  const result = (
    outcome: NightModeNoticeDeliveryEvidence['outcome'],
    reason: NightModeNoticeEvidenceReason,
    sentAt: string | null = null,
  ): NightModeNoticeDeliveryEvidence => ({ outcome, reason, sentAt });
  if (params.ledger.state === 'unavailable') return result('unknown', 'ledger_unavailable');
  const row = params.ledger.row;
  if (!row) return result('not_recorded', 'ledger_missing');
  if (
    row.jobId !==
      buildNightModeNoticeIdempotencyKey(params.transition, params.chatId, params.sessionKey) ||
    row.chatId !== params.chatId ||
    row.actionType !== 'SEND_MESSAGE' ||
    row.sourceTag !== 'night_mode_transition'
  )
    return result('unknown', 'identity_mismatch');
  if (row.ambiguous || row.status === 'AMBIGUOUS') return result('unknown', 'ambiguous');

  const completedAt =
    row.completedAt instanceof Date && Number.isFinite(row.completedAt.getTime())
      ? row.completedAt.toISOString()
      : null;
  // FLAG: A receipt establishes this exact SEND independently of current settings, access,
  // registry presence, event persistence and cleanup. Missing evidence never establishes no SEND.
  if (row.status === 'SUCCEEDED') {
    return row.terminal && row.dispatchBotId?.trim() && row.remoteMessageId?.trim() && completedAt
      ? result('sent', 'successful_receipt', completedAt)
      : result('unknown', 'incomplete_success');
  }
  const hasDispatchEvidence =
    row.dispatchToken != null ||
    row.dispatchStartedAt != null ||
    row.dispatchBotId != null ||
    row.remoteMessageId != null;
  if (hasDispatchEvidence) return result('unknown', 'attempted_without_receipt');
  const certifiedPreDispatch =
    row.lastErrorCode === MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE ||
    row.lastErrorCode === MAX_ACTION_NO_EXECUTABLE_ROUTE_ERROR_CODE.toLowerCase();
  if (
    row.terminal &&
    completedAt &&
    (row.status === 'FAILED_TERMINAL' || row.status === 'FAILED_RETRYABLE') &&
    row.lastStatusCode === null &&
    certifiedPreDispatch
  )
    return result('not_sent', 'proven_pre_dispatch_failure');

  const hasAttemptEvidence =
    row.attemptCount > 0 || row.firstAttemptAt != null || row.lastAttemptAt != null;
  if (
    row.status === 'ENQUEUED' &&
    !row.terminal &&
    row.attemptCount === 0 &&
    !hasAttemptEvidence &&
    row.completedAt === null
  )
    return result('pending', 'awaiting_first_attempt');
  if (hasAttemptEvidence || row.status === 'IN_PROGRESS')
    return result('unknown', 'attempted_without_receipt');
  if (row.terminal) return result('unknown', 'terminal_without_receipt');
  return result('unknown', 'unrecognized_state');
}
